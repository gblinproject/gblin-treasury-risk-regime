/**
 * External liveness check for the trading automaton's host.
 *
 * The automaton publishes its state every five minutes; the public stats
 * endpoint exposes the time of the last update. This check runs from the
 * Worker, outside the host it watches, so a host that stops entirely is still
 * reported. It is a no-op until both notification secrets are configured.
 *
 * KV usage is event-driven: one read per run, and a write only when the state
 * changes (first alert, re-alert after RE_ALERT_MS, recovery).
 */

const STATS_URL = "https://gblin.digital/api/aureus";
const STALE_AFTER_MS = 60 * 60 * 1000;
const RE_ALERT_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 20_000;
const STATE_KEY = "vmwatch:alertedAt";

/** Runs twice an hour: the first tick of each half hour. */
export function vmWatchDue(now = new Date()) {
  return now.getUTCMinutes() % 30 < 10;
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

/** Returns a short description of the problem, or "" when the automaton is live. */
export async function probe(now = Date.now()) {
  let res;
  try {
    res = await fetch(STATS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return `stats endpoint unreachable (${e && e.name ? e.name : "error"})`;
  }
  if (!res.ok) return `stats endpoint returned HTTP ${res.status}`;
  let body;
  try {
    body = await res.json();
  } catch {
    return "stats endpoint returned invalid JSON";
  }
  const updated = body && body.stats && body.stats.updated;
  if (!body || !body.enabled || typeof updated !== "number") return "stats endpoint exposes no update time";
  const ageMin = Math.round((now - updated * 1000) / 60_000);
  if (now - updated * 1000 > STALE_AFTER_MS) return `no cycle for ${ageMin} min (expected every 5 min)`;
  return "";
}

/** Sends one message through the alert path, to prove the channel end to end. */
export async function vmWatchTest(env) {
  if (!env.VM_WATCH_TELEGRAM_TOKEN || !env.VM_WATCH_TELEGRAM_CHAT) return { sent: false, reason: "not configured" };
  const problem = await probe();
  await notify(env, `Test of the Aureus liveness alert (sent from the Worker). Current check: ${problem || "Aureus is reporting normally"}.`);
  return { sent: true, current: problem || "live" };
}

export async function vmWatchTick(env) {
  if (!env.VM_WATCH_TELEGRAM_TOKEN || !env.VM_WATCH_TELEGRAM_CHAT || !env.COHERENCE) return;
  const now = Date.now();
  const problem = await probe(now);
  const alertedAt = Number((await env.COHERENCE.get(STATE_KEY)) || 0);

  if (problem) {
    if (!alertedAt || now - alertedAt >= RE_ALERT_MS) {
      await notify(env,
        `Aureus is not reporting: ${problem}.\n` +
        `On the VM: sudo systemctl restart aureus\n` +
        `If the VM does not answer, reboot it from the Oracle console. ` +
        `An idle VM can be reclaimed by Oracle after 7 days.`);
      await env.COHERENCE.put(STATE_KEY, String(now));
    }
    return;
  }
  if (alertedAt) {
    const downMin = Math.round((now - alertedAt) / 60_000);
    await notify(env, `Aureus is reporting again (first alert ${downMin} min ago).`);
    await env.COHERENCE.delete(STATE_KEY);
  }
}
