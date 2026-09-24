/**
 * Aggregate usage counters for the free MCP surface.
 *
 * Why it exists: paid x402 calls are counted elsewhere, but the FREE surface — the hosted MCP
 * server, which is how an agent normally arrives, because it costs nothing and is listed in the
 * public registries — was not counted at all. Without it, any answer to "how many agents use
 * this" covers only the paid half, which catalogue crawlers keep alive on their own.
 *
 * WHAT IS COUNTED: the JSON-RPC method name and, for tools/call, the tool name — taken from
 * this server's own fixed list, never from the caller's text (otherwise anyone could write
 * arbitrary keys into the counter).
 *
 * WHAT IS DELIBERATELY NOT COUNTED: no IP address, no user agent, no caller identifier, no
 * arguments, no per-call timestamps. Daily totals per key only. This is not tracking who
 * calls: it is a count of what is called, and that difference is the rule.
 *
 * DECLARED ACCURACY: totals are a LOWER BOUND. Counters live in memory in the isolate serving
 * the request and are flushed in batches; an isolate evicted before its flush loses its batch.
 * An honestly under-reported number is better than a precise invented one.
 *
 * WRITE BUDGET: writes are bounded by the number of calls (no calls, no writes) and in any case
 * to one batch per interval per isolate, an interval that lengthens after a threshold, so
 * counting can never exhaust the storage allowance the daily promise seals depend on.
 */

const DAYS_TTL = 120 * 86400;
const BATCH_MAX = 1000;        // batch size never forces a write: the clock decides
let waitMs = 60_000;         // one batch per minute per isolate
const SLOW_DOWN_AFTER = 240;     // past 240 batches the interval becomes 5 minutes: runaway brake
const STOP_AFTER = 600;         // safety cap per isolate, not an expected limit

// Why the counter throttles itself: external scanners enumerate this surface every couple of
// minutes. At that rate, one write per call would consume the daily storage allowance, part of
// which is reserved for the daily seals of the public promises; overrunning it would mean not
// sealing, that is, breaking the very promise being attested. The question here is HOW MANY
// calls happen per day, not at which minute they arrived, so one batch per interval yields the
// same daily number at a fraction of the write cost. The throttling is declared in the public
// report. The priority is fixed: seals come before counting.

// CLOSED list of JSON-RPC methods. Tool names are taken from this server's own list, and
// method names must be too: a method name copied straight from the request would let any
// caller mint new counter keys without limit and inflate the day's record. Anything outside
// this list is counted as "other".
const METHODS = new Set([
  "initialize", "ping", "tools/list", "tools/call",
  "prompts/list", "prompts/get", "resources/list", "resources/read",
]);
export const knownMethod = (m) => (METHODS.has(m) ? m : "other");

// ── WHY FAILED ATTEMPTS ARE COUNTED ────────────────────────────────────────
// A seal attempt that produces no leaf means someone tried and failed. Knowing THAT they tried
// is not enough: the reason decides what has to change. If the reason is "schema", the problem
// may well be on this side (unclear instructions, over-strict fields) and can be fixed; if it
// is "quota", it is genuine interest.
// Only the reason is counted, from a CLOSED list. Nothing about the caller: no IP, no user
// agent, no identity, no arguments.
// The list also covers the three ways a PAID call can fail: wrong method, silent upstream
// service, missing server-side configuration. Without those, a payment taken without delivery
// would stay invisible.
const REASONS = new Set(["ok", "schema", "quota", "mode", "json", "internal",
                        "metodo", "upstream", "config"]);
export function countOutcome(key, reason) {
  countCall("esito:" + key, REASONS.has(reason) ? reason : "internal");
}

// A high batch threshold on a long timer does not work at low traffic: requests spread across
// several isolates, no batch fills up, and no isolate lives long enough for the timer to
// expire, so batches die with their isolate. At a handful of calls a day the batch has to be
// written promptly; the size threshold is only there in case traffic ever explodes.

// Per-isolate state. It does not survive eviction: that is intended and declared above.
const buffer = new Map();
let lastFlush = 0;
let flushesDone = 0;
let inFlight = null;

export const utcDayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const dayDocKey = (day) => `mcpuse:${day}`;

/**
 * Record a call. `tool` is passed ONLY when it is a name from this server's own list.
 */
export function countCall(method, tool) {
  const key = tool ? `${method}:${tool}` : method;
  buffer.set(key, (buffer.get(key) || 0) + 1);
  // A seal attempt is rare and must not die with the isolate while waiting for the clock.
  if (ALWAYS_WRITE_KEYS.has(key)) urgent = true;
}

function shouldFlush() {
  if (buffer.size === 0) return false;
  let total = 0;
  for (const n of buffer.values()) total += n;
  return total >= BATCH_MAX || Date.now() - lastFlush >= waitMs;
}

/**
 * Flush the batch to storage, on the UTC-day key.
 * Never throws: a counter must not be able to break a response.
 */
// Counts are written to D1, deliberately not to KV:
//   - the free allowance of D1 is 100,000 written rows per day against 1,000 for KV;
//   - it is a SEPARATE quota, so counting can no longer put at risk the daily seals of the
//     public promises, which stay on KV;
//   - the D1 upsert (`n = n + excluded.n`) is ATOMIC, so the lost update of a concurrent
//     read-modify-write on KV no longer applies.
// The declared priority is unchanged: promise seals come before the counter; they are simply
// no longer competing for the same quota.
// Days already recorded on KV stay readable: the report merges them with the new ones.
const WRITES_ENABLED = true;

// NARROW EXCEPTION. These keys count RARE attempts (units per day, not the hundreds a scanner
// produces), so they are written even while general counting is throttled, at a cost of a
// handful of writes. The rest of the traffic stays silent. The declared priority does not
// change: promise seals come before the counter.
const ALWAYS_WRITE_KEYS = new Set([
  "http:/v1/seal-demo", "tools/call:receipts.seal",
  // outcomes are as rare as the attempts: they pass even when writes are throttled
  "esito:receipts.seal:ok", "esito:receipts.seal:schema", "esito:receipts.seal:quota",
  "esito:receipts.seal:mode", "esito:receipts.seal:internal",
  "esito:seal-demo:ok", "esito:seal-demo:schema", "esito:seal-demo:quota",
  "esito:seal-demo:json", "esito:seal-demo:internal",
  // THE PAID PATH. A paid seal is an isolated event and never fills a batch, so its count
  // stayed in the per-isolate buffer and DIED with the isolate: the counter built to make paid
  // failures visible disappeared on the first paid call. These keys are the rarest of all and
  // must be written immediately, always.
  "esito:seal-paid:ok", "esito:seal-paid:schema", "esito:seal-paid:json",
  "esito:seal-paid:metodo", "esito:seal-paid:upstream", "esito:seal-paid:config",
  "esito:seal-paid:internal",
]);
let urgent = false;

export async function flushUsageNow(env, force = false) {
  if (buffer.size === 0) return;
  const db = env.USAGE;
  if (!db) return;                       // no D1 binding (local development): nothing is counted
  if (flushesDone >= STOP_AFTER) return;
  if (!WRITES_ENABLED && !urgent) return;
  if (!force && !urgent && !shouldFlush()) return;
  if (inFlight) return inFlight;

  const batch = new Map(buffer);
  buffer.clear();
  urgent = false;
  if (batch.size === 0) return;
  lastFlush = Date.now();
  if (++flushesDone > SLOW_DOWN_AFTER) waitMs = 5 * 60_000;

  inFlight = (async () => {
    try {
      const day = utcDayKey();
      const q = db.prepare(
        "INSERT INTO usage_daily (day,k,n) VALUES (?,?,?) " +
        "ON CONFLICT(day,k) DO UPDATE SET n = n + excluded.n",
      );
      await db.batch([...batch].map(([k, n]) => q.bind(day, k, n)));
    } catch {
      // D1 unavailable: the batch is lost and the total stays a lower bound, as declared.
      // It is not put back into the buffer, to keep the buffer from growing without bound.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * DEFERRED flush: wait a few seconds, then write anyway.
 *
 * Flushing at the start of a request writes the PREVIOUS batch, so the last request an isolate
 * sees always stays pending and dies with it. With the wait, every request also causes its own
 * batch to be written, and closely spaced calls still merge because the buffer is shared inside
 * the isolate.
 *
 * `force` applies only while this isolate has written little: past the threshold the normal
 * rhythm resumes, so a single isolate cannot consume the write allowance on its own.
 */
export async function deferredFlush(env, ms = 2000) {
  await new Promise((r) => setTimeout(r, ms));
  return flushUsageNow(env, flushesDone < SLOW_DOWN_AFTER);
}

/**
 * Public, free report: the last `days` days, per key.
 */
export async function recentUsage(env, days = 14) {
  const perDay = new Map();   // day -> { key: n }
  const totals = {};
  const add = (day, k, n) => {
    if (!perDay.has(day)) perDay.set(day, {});
    const d = perDay.get(day);
    d[k] = (d[k] || 0) + n;
    totals[k] = (totals[k] || 0) + n;
  };
  const fromDay = utcDayKey(new Date(Date.now() - (days - 1) * 86400_000));

  // Current source: D1.
  let d1ok = false;
  if (env.USAGE) {
    try {
      const r = await env.USAGE.prepare(
        "SELECT day, k, n FROM usage_daily WHERE day >= ? ORDER BY day DESC",
      ).bind(fromDay).all();
      for (const row of r.results || []) add(row.day, row.k, row.n);
      d1ok = true;
    } catch { d1ok = false; }
  }

  // Historical source: the days written to KV before the move. Read only, never written.
  // Read in parallel: sequential reads made a 60-day report take ~4 s cold, which timed out the
  // site's fetch of this report. The keys are fixed and finite, so the fan-out is bounded by `days`.
  if (env.COHERENCE) {
    const dayKeys = Array.from({ length: days }, (_, i) => utcDayKey(new Date(Date.now() - i * 86400_000)));
    const docs = await Promise.all(
      dayKeys.map(async (day) => {
        try { return [day, JSON.parse((await env.COHERENCE.get(dayDocKey(day))) || "null")]; } catch { return [day, null]; }
      }),
    );
    for (const [day, doc] of docs) {
      if (!doc) continue;
      for (const [k, n] of Object.entries(doc)) add(day, k, n);
    }
  }

  const rows = [...perDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, calls]) => ({ day, calls }));

  return {
    surface: "free surfaces: hosted MCP + the public proof endpoints (receipts, log, checkpoints, coherence)",
    window_days: days,
    total_calls: Object.values(totals).reduce((a, b) => a + b, 0),
    by_key: totals,
    daily: rows,
    method:
      "Aggregate counts of WHAT was called: for MCP, the JSON-RPC method plus the tool name for tools/call (taken from this server's own fixed list; a name that exists only in our stdio npm package is counted as tools/call:stdio-only:<name> since 2026-09-10, so a client that learned the stdio names from the ERC-8004 registration or the README can be told apart from a fuzzer — the names are ours, not the caller's); for HTTP, the free proof endpoints normalised to a fixed set of paths, so an invented path cannot create a new key. Counted since 2026-08-26.",
    outcomes:
      "Keys beginning with `esito:` record WHY an attempt to create a receipt failed, from a CLOSED list " +
      "(ok, schema, quota, mode, json, internal). Added 2026-09-04 after four seal attempts produced no leaf: " +
      "we knew someone had tried and not why, and the difference decides who has to fix something. " +
      "It counts the reason only — never who: no IP, no user agent, no identity, no arguments.",
    not_collected:
      "No IP, no user agent, no caller identity, no arguments, no per-call timestamps. This counts calls, not callers, and there is no way to attribute any of these numbers to a person or an agent.",
    history:
      "Counting ran 2026-08-26 to 2026-08-28, was then SUSPENDED because it wrote to the same KV quota the daily seals of the public promises depend on — and the seals come first. Between 2026-08-30 and 2026-09-02 only attempts to create a receipt were recorded, so totals for those days are NOT traffic totals and must not be compared with the others. Full counting resumed on 2026-09-02.",
    storage:
      "Counts are written to D1, deliberately not to KV: D1's free allowance is 100,000 written rows per day against KV's 1,000, and it is a SEPARATE quota — so the counter can no longer put the promise seals at risk. Days recorded before the move are still read from KV and merged into this report." +
      (d1ok ? "" : " WARNING: D1 did not answer for this request, so recent days may be missing here."),
    accuracy:
      "Lower bound, and less of one than before. Counters are buffered in memory per isolate and flushed in batches, so an evicted isolate still loses its batch. But the D1 upsert (n = n + excluded.n) is atomic, so concurrent flushes no longer overwrite each other — that source of undercount, which we had to declare while on KV, is gone.",
    includes_our_own_traffic:
      "Yes, and this differs from the paid counter. /api/agent-stats excludes GBLIN's own wallets from the organic totals; here there is no caller identity to exclude by, so our own checks and tests are in these numbers too. Read them as an upper bound on outside interest, not a lower one.",
    paid_surface_is_separate: "https://gblin.digital/api/agent-stats",
  };
}
