// catalog.mjs — x402 CATALOG OBSERVATORY (v1: probing + feed).
//
// Why it exists: the discovery catalogue lists on the order of 15,000 resources, and the most
// concrete paying demand in the ecosystem is "which of them is ALIVE?" — today answered by
// payers who burn money probing everything by brute force. Here the answer is produced once
// and served to everyone: the top-N resources are probed in rotation and their status, latency
// and age are published. The full feed is monetised over x402 by the web app; probing and a
// limited free view live here.
//
// PRE-REGISTERED RULES (do not change them without declaring it):
//  - Selection: the TRACK_N most recently updated resources by lastUpdated in the CDP
//    discovery catalogue, plus this operator's own endpoints, which are always included.
//    The list is refreshed once a day.
//  - "alive" (RULE v2) = answers within 8s with either HTTP 402 and a challenge exposing
//    accepts[] — read from the PAYMENT-REQUIRED header (base64 JSON, the x402 v2 form) OR
//    from the body — or any 2xx (free resource). If the GET returns 400/404/405 (a POST-only
//    route) it is retried ONCE with POST and an empty body. Any other outcome is not-ok, and
//    the status code is recorded. Probes never pay.
//    Rule v1 read the body only and only over GET, so it measured the dialect rather than
//    liveness; the correction is declared publicly in METHODOLOGY.changelog and the v1
//    consecutive-fail counters were reset at migration.
//  - No judgements, only measured facts: code, ms, lastOkAt, consecutive fails.
//
// FREE-PLAN LIMITS (verified): at most 50 subrequests per invocation -> PER_TICK probes per
// round, skipping the tick of the daily seal; at most 1000 KV writes per day -> ONE aggregated
// write per tick. CPU: time spent waiting on fetch does not count.

const DISCOVERY_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";
const TRACK_N = 200;
const PER_TICK = 17;
const PROBE_TIMEOUT_MS = 8000;
const LIST_KEY = "cat:list";       // { fetchedAt, urls: [ ... ] }
const STATE_KEY = "cat:state";     // { updatedAt, cursor, entries: { url: {...} } }
const OUR_PREFIX = "https://gblin.digital/";

async function fetchDiscoveryTop(env) {
  // 3 pages of 100 -> sort by lastUpdated and keep the TRACK_N freshest.
  const all = [];
  for (let offset = 0; offset < 300; offset += 100) {
    try {
      const r = await fetch(`${DISCOVERY_URL}?limit=100&offset=${offset}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) break;
      const j = await r.json();
      const items = j.items || [];
      for (const it of items) {
        if (it?.resource && typeof it.resource === "string") {
          all.push({ url: it.resource, lastUpdated: it.lastUpdated || "" });
        }
      }
      if (items.length < 100) break;
    } catch { break; }
  }
  all.sort((a, b) => (b.lastUpdated > a.lastUpdated ? 1 : -1));
  const urls = [];
  const seen = new Set();
  for (const { url } of all) {
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= TRACK_N) break;
  }
  // this operator's own resources are ALWAYS probed: the tool is applied to its author first
  for (const u of urls.filter((u) => u.startsWith(OUR_PREFIX))) seen.add(u);
  if (![...seen].some((u) => u.startsWith(OUR_PREFIX))) {
    urls.unshift("https://gblin.digital/api/x402/attestation");
  }
  return urls;
}

const RULE_VERSION = 2;

function challengeOk(r, bodyText) {
  // x402 v2: base64-JSON challenge in the PAYMENT-REQUIRED header; some servers also put it in the body.
  const h = r.headers.get("payment-required") || r.headers.get("x-payment-required");
  if (h) {
    try { const j = JSON.parse(atob(h)); if (Array.isArray(j?.accepts) && j.accepts.length > 0) return "header"; } catch { /* not base64 */ }
    try { const j = JSON.parse(h); if (Array.isArray(j?.accepts) && j.accepts.length > 0) return "header"; } catch { /* not JSON */ }
  }
  try { const j = JSON.parse(bodyText); if (Array.isArray(j?.accepts) && j.accepts.length > 0) return "body"; } catch { /* body is not JSON */ }
  return null;
}

async function probeVerb(url, method) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers: { accept: "application/json", "user-agent": "gblin-catalog-observer/2", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: "follow",
    });
    const ms = Date.now() - t0;
    if (r.status === 402) {
      const via = challengeOk(r, await r.text().catch(() => ""));
      return { code: 402, ms, ok: !!via, via: via ? `${method.toLowerCase()}-${via}` : null };
    }
    if (r.status >= 200 && r.status < 300) return { code: r.status, ms, ok: true, via: `${method.toLowerCase()}-2xx` };
    return { code: r.status, ms, ok: false, via: null };
  } catch {
    return { code: 0, ms: Date.now() - t0, ok: false, via: null };
  }
}

/**
 * A listing whose path keeps a route placeholder (`/:symbol`, `{id}`) names no concrete resource. It is probed
 * like any other; if it answers with a challenge it counts as alive, otherwise it is left out, because a
 * refused literal placeholder says nothing about whether the service is up.
 */
export function isTemplate(url) {
  try { return /\/:[A-Za-z_]|\{[^}/]+\}|%7B[^/]+%7D/i.test(new URL(url).pathname); } catch { return false; }
}

async function probeOne(url) {
  const g = await probeVerb(url, "GET");
  if (g.ok) return g;
  // POST-only route (or one that requires a body): exactly ONE retry with POST
  // Rule 2.3 adds 403 (API gateways answer an unrouted method with it) and a 402 whose challenge cannot be parsed.
  if (g.code === 404 || g.code === 405 || g.code === 400 || g.code === 501 || g.code === 403 || g.code === 402) {
    const p = await probeVerb(url, "POST");
    if (p.ok) return p;
    return { code: p.code || g.code, ms: g.ms + p.ms, ok: false, via: null, get_code: g.code };
  }
  return g;
}

/** One round of probes (called from cron, NEVER in the seal tick). */
export async function catalogTick(env, nowMs) {
  if (!env.COHERENCE) return;
  const now = nowMs ?? Date.now();

  // list: refreshed once a day (3 subrequests, only in that case)
  let list = null;
  try { list = JSON.parse(await env.COHERENCE.get(LIST_KEY)); } catch { /* first run */ }
  if (!list || now - (list.fetchedAt || 0) > 24 * 3600e3) {
    const urls = await fetchDiscoveryTop(env);
    if (urls.length) {
      list = { fetchedAt: now, urls };
      await env.COHERENCE.put(LIST_KEY, JSON.stringify(list));
    }
  }
  if (!list?.urls?.length) return;

  let state = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* first run */ }
  if (!state) state = { updatedAt: 0, cursor: 0, entries: {} };
  if ((state.rule || 1) < RULE_VERSION) {
    // v1 -> v2 migration: the v1 "fails" were dialect artefacts (body vs header), not absences -> reset.
    for (const e of Object.values(state.entries)) { e.fails = 0; delete e.ok; }
    state.rule = RULE_VERSION; state.ruleSince = now;
  }

  const batch = [];
  for (let i = 0; i < PER_TICK && i < list.urls.length; i++) {
    batch.push(list.urls[(state.cursor + i) % list.urls.length]);
  }
  state.cursor = (state.cursor + batch.length) % list.urls.length;

  const results = await Promise.all(batch.map((u) => probeOne(u)));
  for (let i = 0; i < batch.length; i++) {
    const u = batch[i], r = results[i];
    const e = state.entries[u] || { firstSeenAt: now, fails: 0 };
    e.code = r.code; e.ms = r.ms; e.ok = r.ok; e.via = r.via || null; e.rule = RULE_VERSION; e.lastProbeAt = now;
    if (r.ok) { e.lastOkAt = now; e.fails = 0; } else { e.fails = (e.fails || 0) + 1; }
    state.entries[u] = e;
  }
  // prune entries that left the list (kept 7 days for short-term history)
  for (const [u, e] of Object.entries(state.entries)) {
    if (!list.urls.includes(u) && now - (e.lastProbeAt || 0) > 7 * 864e5) delete state.entries[u];
  }
  state.updatedAt = now;
  await env.COHERENCE.put(STATE_KEY, JSON.stringify(state)); // ONE write per tick
}

function summarize(state) {
  const entries = Object.entries(state?.entries || {});
  const probed = entries.filter(([, e]) => e.lastProbeAt);
  const alive = probed.filter(([, e]) => e.ok);
  return {
    tracked: entries.length,
    probed_at_least_once: probed.length,
    alive_now: alive.length,
    alive_pct: probed.length ? Math.round((alive.length / probed.length) * 1000) / 10 : null,
    updated_at: state?.updatedAt ? new Date(state.updatedAt).toISOString() : null,
  };
}

/** FREE view: aggregates plus this operator's own resources in the clear. */
export async function catalogReport(env) {
  let state = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* empty */ }
  const ours = {};
  for (const [u, e] of Object.entries(state?.entries || {})) {
    if (u.startsWith(OUR_PREFIX)) ours[u] = { ok: e.ok, code: e.code, ms: e.ms, last_ok: e.lastOkAt ? new Date(e.lastOkAt).toISOString() : null };
  }
  return {
    what: "x402 catalog observatory (v1 beta) — factual liveness of the most recently updated Bazaar listings, probed in rotation. No payments are made by probes; no judgements, only measurements.",
    alive_definition: "rule v2.3 (since 2026-09-24): answers within 8s with HTTP 402 + parseable accepts[] challenge read from the PAYMENT-REQUIRED header or the body (GET, one POST retry on 400/402-without-challenge/403/404/405/501), or any 2xx; a placeholder path that does not answer with a challenge is left out; a single probe with no HTTP answer is unconfirmed until repeated",
    summary: summarize(state),
    our_own_listings: ours,
    full_feed: "per-endpoint detail (code, latency, last_ok, consecutive fails) is available as a paid x402 resource — see gblin.digital/api/x402/llms.txt",
    selection_rule: `top ${TRACK_N} listings by lastUpdated on the public CDP discovery catalog, refreshed daily`,
  };
}

/** FULL feed for the web app, which signs it and sells it over x402. Shared token. */
export async function catalogFull(env, token) {
  if (!env.CATALOG_TOKEN || token !== env.CATALOG_TOKEN) return null;
  let state = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* empty */ }
  return { summary: summarize(state), entries: state?.entries || {}, updated_at: state?.updatedAt || 0 };
}

/* ────────────────────────────────────────────────────────────────────────────
 * PUBLIC OBSERVATORY — the full report as a citable artefact: dated HTML page,
 * raw JSON at a stable URL, and an SVG badge. Free forever, same rules for
 * everyone — this operator's own endpoints appear in the same table and are
 * judged by the same probes, which is the point of the whole tool.
 * ──────────────────────────────────────────────────────────────────────────*/

const METHODOLOGY = {
  rule_version: "2.3",
  rule_since: "2026-09-24",
  selection: "top ~200 resources by lastUpdated on the public CDP x402 discovery catalog, refreshed daily; GBLIN's own endpoints are always included and judged by the same rules",
  probe: "GET, accept: application/json, 8s timeout, follow redirects; if the GET returns 400/402 without a parseable challenge/403/404/405/501 (a POST-only route) one POST retry with an empty JSON body; 17 endpoints are probed every 3 hours, so each endpoint is probed about every 36 hours",
  alive: "HTTP 402 whose challenge exposes a non-empty accepts[] array — read from the PAYMENT-REQUIRED header (base64 JSON, the x402 v2 form) or from the response body — or any 2xx, within the timeout",
  never: "probes never pay anyone, never judge quality — liveness only",
  changelog: [
    {
      version: "2.3", from: "2026-09-24", to: null,
      rule: "as v2.2, plus a GET answered with 403, or with 402 but no parseable challenge, also triggers the single POST retry",
      correction: "found by a hand check the same day of the 14 not-alive results in a random sample of 400 of the 17,071 catalog listings: 3 of them (two answering 403 to GET, one answering 402 without a parseable challenge to GET) carried a valid challenge on POST.",
    },
    {
      version: "2.2", from: "2026-09-24", to: "2026-09-24",
      rule: "as v2.1, plus: (a) a listing whose path keeps a route placeholder (/:name or {name}) counts as alive if it answers with a challenge and is otherwise left out, since a refused literal placeholder is not evidence that the service is down; (b) a probe that gets no HTTP answer at all (network error or timeout) is shown as unconfirmed and left out of the percentage until a second consecutive probe also gets none",
      correction: "hand check on 2026-09-24 of the 4 endpoints reported not alive out of 187: 3 had failed a single probe with no HTTP answer and, re-checked by hand from a separate network, answered with a valid 402 challenge; the 4th was a placeholder path (':symbol'). Also corrected: the probe cadence was published as 'roughly every 2 hours', while the cadence in force is 17 probes every 3 hours, about 36 hours per endpoint.",
    },
    {
      version: "2.1", from: "2026-08-18", to: "2026-09-24",
      rule: "as v2, plus HTTP 501 added to the statuses that trigger the single POST retry (aligns with the independent cross-check method published by M. Oliva, x402 Slack, 2026-08-18)",
      correction: "no effect on the 201 endpoints tracked on 2026-08-18 (none returned 501); recorded so that the two methods are reproducibly identical on the verb-fallback rule.",
    },
    {
      version: 1, from: "2026-08-16", to: "2026-08-18",
      rule: "plain GET only; alive = HTTP 402 with a parseable accepts[] in the BODY, or any 2xx",
      correction: "v1 measured dialect, not liveness: it never read the PAYMENT-REQUIRED header and never retried POST-only routes. Flagged by a third-party re-run in the x402 Slack (#wg-domain-discovery, 2026-08-17). Our own cross-check on the same 276 targets, 2026-08-18: rule v1 33.7% alive, rule v2 98.9%; 139 targets carried the challenge in the header only, 41 were POST-only, 0 were unreachable. The published 36.7% (2026-08-16) was therefore wrong as a liveness figure. Cross-check data: https://github.com/gblinproject/x402-catalog-probe. v1 consecutive-fail counters were reset at migration; last_ok timestamps observed under v1 remain valid (v1 was strictly stricter).",
    },
  ],
};

function fullRows(state) {
  // after a rule change only probes already re-run under the current rule count (no v1/v2 mixing)
  return Object.entries(state?.entries || {})
    .filter(([u, e]) => e.lastProbeAt && (e.rule || 1) === RULE_VERSION && (e.ok || !isTemplate(u)))
    .map(([u, e]) => ({
      url: u,
      ours: u.startsWith(OUR_PREFIX),
      alive: !!e.ok,
      // No HTTP answer at all on a single probe: not yet counted either way (rule 2.2).
      unconfirmed: !e.ok && e.code === 0 && (e.fails || 0) < 2,
      http: e.code,
      latency_ms: e.ms,
      last_ok: e.lastOkAt ? new Date(e.lastOkAt).toISOString() : null,
      consecutive_fails: e.fails || 0,
      alive_via: e.via || null,
      first_seen: e.firstSeenAt ? new Date(e.firstSeenAt).toISOString() : null,
    }))
    .sort((a, b) => (a.alive === b.alive ? a.url.localeCompare(b.url) : a.alive ? -1 : 1));
}

export async function observatoryJson(env) {
  let state = null, list = null;
  try { state = JSON.parse(await env.COHERENCE.get(STATE_KEY)); } catch { /* empty */ }
  try { list = JSON.parse(await env.COHERENCE.get(LIST_KEY)); } catch { /* empty */ }
  const inRotation = list?.urls?.length || Object.keys(state?.entries || {}).length;
  const listed = fullRows(state).filter((r) => !list?.urls || list.urls.includes(r.url));
  const rows = listed.filter((r) => !r.unconfirmed);
  const unconfirmed = listed.filter((r) => r.unconfirmed);
  const alive = rows.filter((r) => r.alive).length;
  const templates = Object.entries(state?.entries || {})
    .filter(([u, e]) => isTemplate(u) && e.lastProbeAt && !e.ok && (!list?.urls || list.urls.includes(u))).length;
  return {
    name: "GBLIN x402 Uptime Observatory",
    generated_at: new Date(state?.updatedAt || Date.now()).toISOString(),
    stable_url: "https://gblin-mcp.gblin-mcp-worker.workers.dev/observatory.json",
    methodology: METHODOLOGY,
    summary: { tracked: rows.length, alive_now: alive, alive_pct: rows.length ? Math.round((1000 * alive) / rows.length) / 10 : 0, in_rotation: inRotation, unconfirmed: unconfirmed.length, untestable_templates: templates, note: listed.length + templates < inRotation ? "endpoints that entered the list recently are counted after their first probe (a full rotation takes about 36 hours)" : undefined },
    endpoints: rows,
    unconfirmed_endpoints: unconfirmed,
    free_market_risk_regime: "https://gblin-mcp.gblin-mcp-worker.workers.dev/regime",
    operator: "gblin.digital (ERC-8004 agent #59286 on Base) — our own endpoints appear in the table under the same rules",
    rerun_it_yourself: "https://github.com/gblinproject/x402-catalog-probe",
    how_to_cite: "GBLIN x402 Uptime Observatory, <date>, https://gblin-mcp.gblin-mcp-worker.workers.dev/observatory",
  };
}

export async function observatoryPage(env) {
  const d = await observatoryJson(env);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const tr = d.endpoints.map((r) => {
    const host = r.url.replace(/^https?:\/\//, "").split("/")[0];
    const path = r.url.replace(/^https?:\/\/[^/]+/, "");
    return `<tr${r.ours ? ' class="ours"' : ""}><td>${r.alive ? "🟢" : "🔴"}</td><td>${esc(host)}${r.ours ? " <b>(ours)</b>" : ""}</td><td class="p">${esc(path)}</td><td>${r.http || "—"}</td><td>${r.latency_ms ?? "—"}</td><td>${r.last_ok ? esc(r.last_ok.slice(0, 16)) + "Z" : "never"}</td><td>${r.consecutive_fails}</td><td>${r.alive_via ? esc(r.alive_via) : "—"}</td></tr>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>x402 Uptime Observatory — ${d.summary.alive_pct}% of the catalog answers | GBLIN</title>
<meta name="description" content="The x402 uptime observatory: continuous liveness probes of the ${d.summary.tracked} most recently updated x402 catalog resources. ${d.summary.alive_now} answer today (${d.summary.alive_pct}%). Free data, stable JSON, pre-registered method. By GBLIN, whose own endpoints sit in the same table.">
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:1080px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
h1{font-size:1.5rem}code,td.p{font-family:ui-monospace,monospace;font-size:.85em}
table{border-collapse:collapse;width:100%;margin-top:1rem}td,th{padding:.3rem .55rem;border-bottom:1px solid #e5e5e5;text-align:left;font-size:.86rem}
tr.ours{background:#fffbe8}.k{color:#555}.box{background:#f6f6f6;border-radius:8px;padding:.9rem 1.1rem;margin:1rem 0}
@media(prefers-color-scheme:dark){body{background:#111;color:#e6e6e6}td,th{border-color:#2c2c2c}tr.ours{background:#2a2410}.box{background:#1c1c1c}}</style></head><body>
<h1>x402 Uptime Observatory</h1>
<p class="k">Generated ${esc(d.generated_at)} · refreshed continuously · <a href="/observatory.json">raw JSON (stable URL)</a> · <a href="/observatory/badge.svg">badge</a></p>
<p><b>${d.summary.alive_now} of ${d.summary.tracked}</b> tracked x402 resources answer right now — <b>${d.summary.alive_pct}%</b>.${d.summary.alive_now < d.summary.tracked ? " The rest did not answer" : " Measured"} under the pre-registered definition below (rule v${d.methodology.rule_version}, since ${d.methodology.rule_since}).${d.summary.unconfirmed ? ` Not counted: ${d.summary.unconfirmed} endpoint(s) with a single probe that got no HTTP answer, pending a second probe.` : ""}${d.summary.untestable_templates ? ` Not counted: ${d.summary.untestable_templates} listing(s) whose path is a placeholder and that refused it.` : ""}</p>
<div class="box"><b>Method (pre-registered):</b> ${esc(d.methodology.selection)}. Probe: ${esc(d.methodology.probe)}. <b>Alive</b> = ${esc(d.methodology.alive)}. ${esc(d.methodology.never)}.</div>
<div class="box"><b>Correction log.</b> ${d.methodology.changelog.map((c) => `<b>Rule v${c.version}</b> (${esc(c.from)} → ${esc(c.to)}): ${esc(c.rule)}. ${esc(c.correction)}`).join("<br>")}</div>
<p class="k">Run by <a href="https://gblin.digital">GBLIN</a> (ERC-8004 agent #59286). Our own endpoints appear below under the same rules — highlighted, not exempted. The free on-chain market risk regime lives at <a href="/regime"><code>/regime</code></a>.</p>
<table><thead><tr><th></th><th>host</th><th>path</th><th>HTTP</th><th>ms</th><th>last OK (UTC)</th><th>fails</th><th>alive via</th></tr></thead><tbody>
${tr}
</tbody></table>
<p class="k">Re-run it yourself: <a href="https://github.com/gblinproject/x402-catalog-probe">gblinproject/x402-catalog-probe</a> (one file, zero dependencies, same rules) — you may get a different number, and that is the point. Reading is free forever. Data license: reuse with a link to this page. How to cite: "GBLIN x402 Uptime Observatory, &lt;date&gt;, gblin-mcp.gblin-mcp-worker.workers.dev/observatory". Contact: info@gblin.digital</p>
</body></html>`;
  return html;
}

export async function observatoryBadge(env, host) {
  const d = await observatoryJson(env);
  let label = "x402 catalog alive";
  let value = `${d.summary.alive_pct}%`;
  let color = d.summary.alive_pct >= 50 ? "#2da44e" : "#d4a72c";
  if (host) {
    const rows = d.endpoints.filter((r) => r.url.includes(host));
    const up = rows.filter((r) => r.alive).length;
    label = `x402 uptime · ${host}`;
    value = rows.length ? `${up}/${rows.length} up` : "not tracked";
    color = rows.length && up === rows.length ? "#2da44e" : up > 0 ? "#d4a72c" : "#cf222e";
  }
  const lw = 7 * label.length + 12, vw = 7 * value.length + 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label}: ${value}">
<rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,sans-serif" font-size="11"><text x="6" y="14">${label}</text><text x="${lw + 6}" y="14">${value}</text></g></svg>`;
}
