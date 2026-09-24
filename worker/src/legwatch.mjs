/**
 * Liveness check of the vault's basket legs.
 *
 * `isNavReliable()` on the vault is false while a price feed is older than its window, a fill of the fill
 * agent is open, or a basket token does not answer `balanceOf`. The last case is the one that costs
 * holders: an in-kind redemption does not deliver a leg whose token does not answer, and creates no
 * credit for it. The guardian's pause stops minting while leaving the in-kind exit open, so the
 * response is to pause and tell holders not to redeem until the token answers again.
 *
 * Every run makes one call when the vault reports a reliable NAV. Only when it does not are the basket
 * rows read, and a leg counts as silent only if `balanceOf(vault)` reverts on three different endpoints:
 * a public endpoint can refuse a call in a way that looks like a revert.
 *
 * KV usage is event-driven: one read per run, a write only when the state changes. It is a no-op until
 * the notification secrets are configured.
 */
import { decodeFunctionResult, encodeFunctionData } from "viem";

const VAULT = "0xc2181d975c05c8c724b334bcED0764c0b86B1D53";
const LENS = "0xfCFea8027019E8551A1f09AD91532471F5D26f61";
const SENTINEL = "0x9F13C5c46a864183e1c57Ec02837fe5B980D3F67";
const WETH = "0x4200000000000000000000000000000000000006";
const STATE_KEY = "legwatch:state";
/** A NAV that stays unreliable this long without a silent leg is reported too (stale feed, stuck fill). */
const UNRELIABLE_ALERT_MS = 60 * 60 * 1000;
const RE_ALERT_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

const ABI = [
  { type: "function", name: "isNavReliable", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "basketLength", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "asset", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [
      { type: "address" }, { type: "address" }, { type: "bool" }, { type: "bool" },
      { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" },
    ],
  },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
];

const KNOWN = {
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "cbBTC",
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
};

/** One eth_call on one endpoint: { result } | { revert } | { error }. */
async function callOn(url, to, data) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const body = await r.json();
    if (body.result !== undefined && body.result !== "0x") return { result: body.result };
    if (body.result === "0x") return { revert: "0x" };
    if (body.error && (typeof body.error.data === "string" || /revert/i.test(body.error.message || ""))) {
      return { revert: body.error.data || "0x" };
    }
    return { error: body.error?.message || "no result" };
  } catch (e) {
    return { error: e?.name || "error" };
  }
}

/** First endpoint that answers wins; a revert is an answer. */
async function call(rpcs, to, fn, args = []) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args });
  for (const url of rpcs) {
    const r = await callOn(url, to, data);
    if (r.result) return decodeFunctionResult({ abi: ABI, functionName: fn, data: r.result });
    if (r.revert) throw new Error(`${fn} reverted`);
  }
  throw new Error(`${fn}: no endpoint answered`);
}

/** True only if balanceOf(vault) reverts on three different endpoints. */
async function isSilent(rpcs, token) {
  const data = encodeFunctionData({ abi: ABI, functionName: "balanceOf", args: [VAULT] });
  let reverts = 0;
  for (const url of rpcs) {
    const r = await callOn(url, token, data);
    if (r.result) return false;
    if (r.revert) reverts++;
    if (reverts >= 3) return true;
  }
  return false;
}

/**
 * Reads the vault's state. Returns { reliable, silent: [symbols], paused } or throws when the chain
 * cannot be read (which reports nothing: an unreadable chain is not a finding).
 */
export async function probeLegs(rpcs) {
  const reliable = await call(rpcs, VAULT, "isNavReliable");
  if (reliable) return { reliable: true, silent: [], paused: false };
  const n = Number(await call(rpcs, LENS, "basketLength", [VAULT]));
  const silent = [];
  for (let i = 0; i < n; i++) {
    const row = await call(rpcs, LENS, "asset", [VAULT, BigInt(i)]);
    const token = String(row[0]);
    const abandoned = Boolean(row[7]);
    if (abandoned || token.toLowerCase() === WETH.toLowerCase()) continue;
    if (await isSilent(rpcs, token)) silent.push(KNOWN[token.toLowerCase()] || token);
  }
  let paused = false;
  try { paused = Boolean(await call(rpcs, SENTINEL, "isPaused")); } catch { /* reported as not paused */ }
  return { reliable: false, silent, paused };
}

async function notify(env, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.VM_WATCH_TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.VM_WATCH_TELEGRAM_CHAT, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`notification failed: HTTP ${res.status}`);
}

function silentMessage(p) {
  return (
    `GBLIN vault: basket token not answering balanceOf: ${p.silent.join(", ")}.\n` +
    `An in-kind redemption now would NOT deliver that leg and would create no credit. ` +
    `The site already refuses to send redemptions while this lasts.\n` +
    `Runbook: from the guardian wallet call pause(duration) on the sentinel ${SENTINEL} ` +
    `(stops minting; the in-kind exit stays open). Sentinel paused now: ${p.paused ? "yes" : "no"}.\n` +
    `Tell holders not to redeem until the token answers. When it answers again: resume() on the sentinel.`
  );
}

export async function legWatchTick(env, rpcs) {
  if (!env.VM_WATCH_TELEGRAM_TOKEN || !env.VM_WATCH_TELEGRAM_CHAT || !env.COHERENCE) return;
  const now = Date.now();
  const p = await probeLegs(rpcs);
  const raw = await env.COHERENCE.get(STATE_KEY);
  const state = raw ? JSON.parse(raw) : null;

  if (p.reliable) {
    if (state) {
      if (state.alertedAt) {
        const min = Math.round((now - state.since) / 60_000);
        await notify(env, `GBLIN vault: NAV reliable again (unreliable for about ${min} min).`);
      }
      await env.COHERENCE.delete(STATE_KEY);
    }
    return;
  }

  const kind = p.silent.length ? "silent" : "unreliable";
  const next = state && state.kind === kind ? { ...state } : { kind, since: now, alertedAt: 0 };
  const due = !next.alertedAt || now - next.alertedAt >= RE_ALERT_MS;
  if (kind === "silent" && due) {
    await notify(env, silentMessage(p));
    next.alertedAt = now;
  } else if (kind === "unreliable" && due && now - next.since >= UNRELIABLE_ALERT_MS) {
    await notify(env,
      `GBLIN vault: NAV unreliable for ${Math.round((now - next.since) / 60_000)} min, every basket token answers. ` +
      `Cause: a price feed older than its window, or a fill of the fill agent left open. Quotes through the Lens ` +
      `and the site's ETH exit are refused meanwhile; the in-kind exit is unaffected. Check the feeds, and call ` +
      `emergencyClose() on the fill agent if a fill is stuck.`);
    next.alertedAt = now;
  }
  if (!state || JSON.stringify(state) !== JSON.stringify(next)) {
    await env.COHERENCE.put(STATE_KEY, JSON.stringify(next));
  }
}
