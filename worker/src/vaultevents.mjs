/**
 * Incremental index of the vault's `Minted` and `AuctionFill` events.
 *
 * Why it exists: two figures on gblin.digital are sums over the vault's whole history (the stability
 * fee retained in the reserves, and the rebalance history). Hosted indexers no longer serve Base logs
 * on their free tiers, and every public Base RPC caps `eth_getLogs` at a small block range, so the
 * history cannot be read in one request at page time. It is read here instead, a small window at a
 * time, and kept in D1.
 *
 * HOW: a cursor records the last block whose logs are stored. Every run reads the next windows up to
 * the chain head minus a few confirmations, and writes the new rows together with the new cursor in a
 * single batch, so a window is either stored completely or not at all. A failed read leaves the cursor
 * where it was and the next run retries the same window: a gap is never skipped.
 *
 * WHAT IS STORED: each log exactly as emitted (block, log index, transaction, topics, data, block
 * timestamp). Nothing is derived at write time, so every figure served from it can be recomputed by
 * anyone from the same logs.
 *
 * BUDGET: one block-number read plus at most MAX_READS_PER_RUN log reads per run, one D1 read and one
 * D1 batch. Runs every minute. Once caught up, a run reads the ~300 blocks produced in a minute: one
 * window from a public source, or thirty from the private endpoint.
 */

export const VAULT = "0xc2181d975c05c8c724b334bcED0764c0b86B1D53";
/** Block that created the vault: there is nothing to read before it. */
export const DEPLOY_BLOCK = 51_563_253;

/** keccak256("Minted(address,uint256,uint256)") */
export const MINTED_TOPIC = "0x25b428dfde728ccfaddad7e29e4ac23c24ed7fd1a6e3e3f91894a9a073f5dfff";
/** keccak256("AuctionFill(address,address,address,uint256,uint256)") */
export const AUCTION_FILL_TOPIC = "0x2976be3a749ae31c32a5c344e8ca41a06e8edbabcc8d3a43ec6a997004daa672";
const KIND_BY_TOPIC = { [MINTED_TOPIC]: "minted", [AUCTION_FILL_TOPIC]: "auction_fill" };

/** Public endpoints and the largest log range each accepts on its free tier. */
export const LOG_SOURCES = Object.freeze([
  { url: "https://gateway.tenderly.co/public/base", window: 1000 },
  { url: "https://base.drpc.org", window: 100 },
]);

/**
 * The public sources first, then the Worker's private endpoint when one is configured. The public
 * gateways rate-limit by address, and Workers share their outbound addresses, so they can refuse
 * every request for hours; the private endpoint keeps the index moving meanwhile.
 */
function logSources(env) {
  const url = typeof env?.GBLIN_RPC_URL === "string" ? env.GBLIN_RPC_URL.trim() : "";
  return url ? [...LOG_SOURCES, { url, window: PRIVATE_WINDOW }] : [...LOG_SOURCES];
}
/** Blocks left behind the head, so a log is stored only once its block is settled (~20 s at 200 ms blocks). */
const CONFIRMATIONS = 100;
/**
 * Endpoints asked only for the chain head when no log source answers it. They serve recent blocks
 * but cap or refuse log ranges, so they never read windows.
 */
const HEAD_SOURCES = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
/**
 * Log reads per run. Workers on the free plan may make 50 subrequests per invocation; this leaves room
 * for the head and timestamp reads. At a public source's window a run reads far more blocks than the
 * chain produces in a minute (300 at 200 ms blocks). The private endpoint's 10-block window covers 360
 * blocks per run, a little more than that: alone it keeps the index current and closes a backlog slowly.
 */
const MAX_READS_PER_RUN = 36;
/** Largest log range the private endpoint (`GBLIN_RPC_URL`) accepts on its plan. */
const PRIVATE_WINDOW = 10;
const TIMEOUT_MS = 12_000;
/** The index counts as current when it is within this many blocks of the head it last saw (~40 min at 200 ms blocks). */
const SYNCED_LAG_BLOCKS = 12_000;
/** ...and when its last successful run is at most this old: a stalled run also leaves `head_seen` behind. */
const SYNCED_MAX_AGE_MS = 40 * 60 * 1000;
const STATE_NAME = "vault";

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  if (body.error) throw new Error(String(body.error.message ?? "rpc error").slice(0, 120));
  return body.result;
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return "source";
  }
}

async function chainHead(sources) {
  const errors = [];
  for (const url of [...sources.map((s) => s.url), ...HEAD_SOURCES]) {
    try {
      const n = Number(BigInt(await rpc(url, "eth_blockNumber", [])));
      if (Number.isSafeInteger(n) && n > DEPLOY_BLOCK) return n;
      errors.push(`${host(url)}: unexpected head`);
    } catch (e) {
      errors.push(`${host(url)}: ${e?.message ?? "failed"}`);
    }
  }
  throw new Error(`no source returned the chain head (${errors.join("; ")})`);
}

/** Logs of both events in [from, to], from the first source that answers for a range it accepts. */
export async function readWindow(source, from, to) {
  const logs = await rpc(source.url, "eth_getLogs", [{
    address: VAULT,
    topics: [[MINTED_TOPIC, AUCTION_FILL_TOPIC]],
    fromBlock: "0x" + from.toString(16),
    toBlock: "0x" + to.toString(16),
  }]);
  if (!Array.isArray(logs)) throw new Error("malformed log answer");
  return logs;
}

export function toRow(log) {
  const topic0 = String(log.topics?.[0] ?? "").toLowerCase();
  const kind = KIND_BY_TOPIC[topic0];
  if (!kind || log.removed) return null;
  if (String(log.address ?? "").toLowerCase() !== VAULT.toLowerCase()) return null;
  return {
    block: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    tx: String(log.transactionHash).toLowerCase(),
    kind,
    topics: JSON.stringify(log.topics.map((t) => String(t).toLowerCase())),
    data: String(log.data).toLowerCase(),
    ts: log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : null,
  };
}

/** Block timestamps for rows whose source did not include one (one header read per distinct block). */
async function fillTimestamps(rows, sources) {
  const missing = [...new Set(rows.filter((r) => r.ts === null).map((r) => r.block))];
  const found = {};
  for (const b of missing) {
    for (const s of sources) {
      try {
        const blk = await rpc(s.url, "eth_getBlockByNumber", ["0x" + b.toString(16), false]);
        if (blk?.timestamp) { found[b] = Number(BigInt(blk.timestamp)); break; }
      } catch {
        // next source
      }
    }
  }
  for (const r of rows) if (r.ts === null && found[r.block] !== undefined) r.ts = found[r.block];
}

async function readState(db) {
  const row = await db.prepare("SELECT indexed_to, head_seen, updated_at FROM vault_index_state WHERE name = ?")
    .bind(STATE_NAME).first();
  return row ?? { indexed_to: DEPLOY_BLOCK - 1, head_seen: null, updated_at: null };
}

/**
 * One indexing run. Returns a short status for the log; never throws.
 */
export async function vaultEventsTick(env) {
  const db = env?.USAGE;
  if (!db) return { skipped: "no database binding" };
  try {
    const state = await readState(db);
    const sources = logSources(env);
    const head = await chainHead(sources);
    const target = head - CONFIRMATIONS;
    let cursor = state.indexed_to;
    const rows = [];
    let reads = 0;
    const errors = new Set();
    // A source that answers 429 is rate-limiting this Worker's address: asking it again in the same
    // run only spends the read budget, so it is skipped until the next run.
    const limited = new Set();

    while (cursor < target && reads < MAX_READS_PER_RUN) {
      let stored = false;
      const usable = sources.filter((s) => !limited.has(s.url));
      if (usable.length === 0) break;
      for (const s of usable) {
        const from = cursor + 1;
        const to = Math.min(target, from + s.window - 1);
        reads += 1;
        try {
          const logs = await readWindow(s, from, to);
          for (const l of logs) {
            const r = toRow(l);
            if (r) rows.push(r);
          }
          cursor = to;
          stored = true;
          break;
        } catch (e) {
          const message = e?.message ?? "read failed";
          errors.add(`${host(s.url)}: ${message}`);
          if (message === "HTTP 429") limited.add(s.url);
          if (reads >= MAX_READS_PER_RUN) break;
        }
      }
      // A refused window is retried within the same run: the public gateways answer from several
      // backends, and one of them refusing a range says nothing about the next attempt. The read
      // budget bounds the loop.
      if (!stored && reads >= MAX_READS_PER_RUN) break;
    }

    if (cursor === state.indexed_to) {
      // Nothing new was read; record the head seen so the lag stays honest.
      await db.prepare(
        "INSERT INTO vault_index_state (name, indexed_to, head_seen, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET head_seen = excluded.head_seen, updated_at = excluded.updated_at",
      ).bind(STATE_NAME, cursor, head, new Date().toISOString()).run();
      return { indexed_to: cursor, head, new_rows: 0, error: errors.size ? [...errors].join("; ") : null };
    }

    await fillTimestamps(rows, sources);
    const insert = db.prepare(
      "INSERT OR IGNORE INTO vault_events (block, log_index, tx, kind, topics, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const statements = rows.map((r) => insert.bind(r.block, r.logIndex, r.tx, r.kind, r.topics, r.data, r.ts));
    statements.push(db.prepare(
      "INSERT INTO vault_index_state (name, indexed_to, head_seen, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(name) DO UPDATE SET indexed_to = MAX(indexed_to, excluded.indexed_to), head_seen = excluded.head_seen, " +
      "updated_at = excluded.updated_at",
    ).bind(STATE_NAME, cursor, head, new Date().toISOString()));
    await db.batch(statements);
    return { indexed_to: cursor, head, new_rows: rows.length, error: errors.size ? [...errors].join("; ") : null };
  } catch (e) {
    return { error: e?.message ?? "run failed" };
  }
}

function word(data, i) {
  return BigInt("0x" + data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
}

function topicAddress(t) {
  return "0x" + String(t).slice(26);
}

function fresh(updatedAt) {
  const t = Date.parse(updatedAt ?? "");
  return Number.isFinite(t) && Date.now() - t <= SYNCED_MAX_AGE_MS;
}

function coverage(state) {
  const lag = state.head_seen ? Math.max(0, state.head_seen - state.indexed_to) : null;
  return {
    from_block: DEPLOY_BLOCK,
    indexed_to_block: state.indexed_to,
    head_seen: state.head_seen,
    lag_blocks: lag,
    synced: lag !== null && lag <= SYNCED_LAG_BLOCKS && fresh(state.updated_at),
    updated_at: state.updated_at,
  };
}

const METHOD =
  "eth_getLogs on public Base endpoints, read in block windows from the vault's creation block and " +
  "stored exactly as emitted; every figure here can be recomputed from the same logs.";

/**
 * GET /vault/mints — every `Minted(receiver, value, shares)` of the vault, with the total deposit value.
 * `value` is the deposit's value in wei of ETH as the vault priced it at mint time.
 */
export async function vaultMints(env, limit) {
  const db = env?.USAGE;
  if (!db) return { error: "index unavailable" };
  const state = await readState(db);
  const r = await db.prepare(
    "SELECT block, log_index, tx, topics, data, ts FROM vault_events WHERE kind = 'minted' ORDER BY block DESC, log_index DESC",
  ).all();
  const all = r.results ?? [];
  let total = 0n;
  const events = all.map((x) => {
    const value = word(x.data, 0);
    total += value;
    return {
      tx: x.tx,
      block: x.block,
      log_index: x.log_index,
      timestamp: x.ts,
      receiver: topicAddress(JSON.parse(x.topics)[1]),
      value_wei: value.toString(),
      shares: word(x.data, 1).toString(),
    };
  });
  return {
    vault: VAULT,
    event: "Minted(address indexed receiver, uint256 value, uint256 shares)",
    ...coverage(state),
    count: events.length,
    total_value_wei: total.toString(),
    events: events.slice(0, limit),
    method: METHOD,
  };
}

/**
 * GET /vault/auction-fills — the vault's `AuctionFill` events, newest first, with the raw topics and
 * data so a reader can decode them independently.
 */
export async function vaultAuctionFills(env, limit) {
  const db = env?.USAGE;
  if (!db) return { error: "index unavailable" };
  const state = await readState(db);
  const count = await db.prepare("SELECT COUNT(*) n FROM vault_events WHERE kind = 'auction_fill'").first();
  const r = await db.prepare(
    "SELECT block, log_index, tx, topics, data, ts FROM vault_events WHERE kind = 'auction_fill' " +
    "ORDER BY block DESC, log_index DESC LIMIT ?",
  ).bind(limit).all();
  const events = (r.results ?? []).map((x) => {
    const topics = JSON.parse(x.topics);
    return {
      tx: x.tx,
      block: x.block,
      log_index: x.log_index,
      timestamp: x.ts,
      bidder: topicAddress(topics[1]),
      token_in: topicAddress(topics[2]),
      token_out: topicAddress(topics[3]),
      amount_in: word(x.data, 0).toString(),
      amount_out: word(x.data, 1).toString(),
      topics,
      data: x.data,
    };
  });
  return {
    vault: VAULT,
    event: "AuctionFill(address indexed bidder, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut)",
    ...coverage(state),
    count: count?.n ?? 0,
    events,
    method: METHOD,
  };
}
