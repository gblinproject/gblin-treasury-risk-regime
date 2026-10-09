// Reads the vault's Minted and AuctionFill logs from its creation block up to a fixed block, with the
// same windows and row format as src/vaultevents.mjs, and writes the SQL that seeds the index.
//
//   node tools/backfill-vault-events.mjs <out.sql>
//   npx wrangler d1 execute gblin-usage --remote --file <out.sql>
//
// The scheduled run then continues from the stored cursor. Rows use INSERT OR IGNORE and the cursor only
// moves forward, so seeding over an index the scheduled run has already started is harmless.
import { writeFileSync } from "node:fs";
import { DEPLOY_BLOCK, LOG_SOURCES, readWindow, toRow } from "../src/vaultevents.mjs";

const out = process.argv[2];
if (!out) {
  console.error("usage: node tools/backfill-vault-events.mjs <out.sql>");
  process.exit(1);
}

async function head() {
  const r = await fetch(LOG_SOURCES[0].url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  return Number(BigInt((await r.json()).result));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (await head()) - 10;
const source = LOG_SOURCES[0];
const rows = [];
let cursor = DEPLOY_BLOCK - 1;
let windows = 0;

while (cursor < target) {
  const from = cursor + 1;
  const to = Math.min(target, from + source.window - 1);
  let logs = null;
  for (let attempt = 0; attempt < 6 && logs === null; attempt++) {
    try {
      logs = await readWindow(source, from, to);
    } catch (e) {
      await sleep(1000 * (attempt + 1));
    }
  }
  if (logs === null) throw new Error(`window ${from}-${to} could not be read`);
  for (const l of logs) {
    const r = toRow(l);
    if (r) rows.push(r);
  }
  cursor = to;
  windows += 1;
  if (windows % 50 === 0) console.error(`${windows} windows, block ${cursor}, ${rows.length} rows`);
  await sleep(150);
}

const missingTs = rows.filter((r) => r.ts === null).length;
if (missingTs) throw new Error(`${missingTs} rows without a block timestamp`);

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const lines = rows.map(
  (r) =>
    `INSERT OR IGNORE INTO vault_events (block, log_index, tx, kind, topics, data, ts) VALUES ` +
    `(${r.block}, ${r.logIndex}, ${q(r.tx)}, ${q(r.kind)}, ${q(r.topics)}, ${q(r.data)}, ${r.ts});`,
);
lines.push(
  `INSERT INTO vault_index_state (name, indexed_to, head_seen, updated_at) VALUES ('vault', ${cursor}, ${target + 10}, ${q(new Date().toISOString())}) ` +
    `ON CONFLICT(name) DO UPDATE SET indexed_to = MAX(indexed_to, excluded.indexed_to), head_seen = excluded.head_seen, updated_at = excluded.updated_at;`,
);
writeFileSync(out, lines.join("\n") + "\n");
const kinds = rows.reduce((m, r) => ((m[r.kind] = (m[r.kind] ?? 0) + 1), m), {});
console.log(JSON.stringify({ from: DEPLOY_BLOCK, to: cursor, windows, rows: rows.length, kinds }));
