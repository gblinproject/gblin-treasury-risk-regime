// GBLIN witness — cosigns third-party transparency-log checkpoints.
//
// Why: a certifier that asks others to be checkable should submit to the same
// discipline. Witnessing a log this operator already appears in (as a paid input
// of a third-party agent) makes the dependency inspectable from both sides.
//
// What it does, every scheduled tick, per configured log:
//   1. GET <log>/checkpoint  (C2SP tlog-checkpoint: signed note)
//   2. verify the LOG's own Ed25519 note signature against a PINNED key
//   3. if a previous checkpoint is held: GET <log>/consistency?old=&new= and
//      verify the RFC 6962 consistency proof (the tree only ever grows)
//   4. cosign (c2sp.org/tlog-cosignature v1, Ed25519) and store the cosigned note
// Anything that fails → nothing is signed, the failure is recorded, next tick retries.
// No chain, no gas, no tokens: one HTTP read + one signature per tick.
//
// Formats (all C2SP, https://c2sp.org):
//   signed note        = text ("\n"-terminated lines) + "\n" + ("— <name> <b64>\n")*
//   verifier key       = <name>+<hex keyhash[:4]>+<b64(alg || pubkey)>
//   alg 0x01           = Ed25519 note signature       (message = text)
//   alg 0x04           = Ed25519 cosignature/v1        (message = "cosignature/v1\ntime <t>\n" + text)
//   keyhash            = SHA-256(name + "\n" + alg || pubkey)
//   cosig line payload = keyhash[:4] || uint64be(t) || sig(64)
//
// Secret: WITNESS_KEY = "<hex ed25519 seed 32B>:<hex ed25519 pubkey 32B>" (Workers' WebCrypto
// needs both for JWK import). Missing → witness is silently disabled (fail-safe, like ATTESTER_KEY).

export const WITNESS_NAME = "gblin.digital/witness";

export const WITNESSED_LOGS = [
  {
    id: "markovian",
    origin: "markovianprotocol.com/log",
    base: "https://log.markovianprotocol.com",
    // Pinned from two independent places: the log's root page and its /policy
    // file. If the log ever rotates its key this witness stops signing — which
    // is the correct behaviour — until a human re-pins on purpose.
    vkey: "markovianprotocol.com/log+0302c6c8+ATkpOWo95UuEiW2EhNZAol4f0CS8hMluJfPcTSzrr03v",
    note: "Log operated by Markovian Protocol (ERC-8004 agent #59895), whose Agent 2 buys GBLIN's risk attestation and records each purchase as a leaf.",
  },
];

// ---------- small codecs ----------
const te = new TextEncoder();
const td = new TextDecoder();
export const b64 = (u8) => btoa(String.fromCharCode(...u8));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/.{2}/g).map((x) => parseInt(x, 16)));
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------- signed notes ----------
export function parseNote(text) {
  // text may end with "\n" after signature lines; the split point is the first blank line
  const i = text.indexOf("\n\n");
  if (i < 0) throw new Error("note: no blank line");
  const body = text.slice(0, i + 1); // includes trailing "\n"
  const sigLines = text.slice(i + 2).split("\n").filter((l) => l.length > 0);
  const lines = body.split("\n");
  if (lines.length < 3) throw new Error("note: short body");
  const size = Number(lines[1]);
  if (!Number.isInteger(size) || size < 0) throw new Error("note: bad size");
  return { body, origin: lines[0], size, root: unb64(lines[2]), sigLines };
}

export function parseVkey(vkey) {
  const m = /^([^+]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/=]+)$/.exec(vkey);
  if (!m) throw new Error("bad verifier key");
  const raw = unb64(m[3]);
  return { name: m[1], hash: unhex(m[2]), alg: raw[0], pub: raw.slice(1) };
}

async function keyHash(name, alg, pub) {
  return (await sha256(cat(te.encode(name + "\n"), Uint8Array.of(alg), pub))).slice(0, 4);
}

// Verify the LOG's own signature (alg 0x01) on a note body. Returns true/false.
export async function verifyLogSignature(note, vkey) {
  const k = parseVkey(vkey);
  if (k.alg !== 0x01) throw new Error("pinned key is not an Ed25519 note key");
  const expectHash = await keyHash(k.name, 0x01, k.pub);
  if (!eq(expectHash, k.hash)) throw new Error("pinned key hash mismatch (typo in vkey?)");
  const key = await crypto.subtle.importKey("raw", k.pub, { name: "Ed25519" }, false, ["verify"]);
  for (const line of note.sigLines) {
    const m = /^— (\S+) (\S+)$/.exec(line);
    if (!m || m[1] !== k.name) continue;
    const payload = unb64(m[2]);
    if (payload.length !== 4 + 64) continue; // e.g. ML-DSA line under the same name: skip
    if (!eq(payload.slice(0, 4), k.hash)) continue;
    if (await crypto.subtle.verify({ name: "Ed25519" }, key, payload.slice(4), te.encode(note.body))) return true;
  }
  return false;
}

// ---------- RFC 6962 consistency proof (tlog / CT algorithm) ----------
const nodeHash = async (l, r) => sha256(cat(Uint8Array.of(0x01), l, r));
export async function verifyConsistency(n, m, oldRoot, newRoot, proof) {
  if (n === m) return proof.length === 0 && eq(oldRoot, newRoot);
  if (n === 0) return proof.length === 0; // any newRoot is consistent with the empty tree
  if (n > m || proof.length === 0) return false;
  let fn = n - 1, sn = m - 1;
  while (fn & 1) { fn >>= 1; sn >>= 1; }
  let i = 0, fr, sr;
  if ((n & (n - 1)) === 0) { fr = oldRoot; sr = oldRoot; } // n is a power of two
  else { fr = proof[0]; sr = proof[0]; i = 1; }
  for (; i < proof.length; i++) {
    if (sn === 0) return false;
    const c = proof[i];
    if ((fn & 1) || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      while (!(fn & 1) && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && eq(fr, oldRoot) && eq(sr, newRoot);
}

// ---------- this witness's key ----------
export function parseWitnessSecret(secret) {
  const m = /^([0-9a-fA-F]{64}):([0-9a-fA-F]{64})$/.exec((secret || "").trim());
  if (!m) throw new Error("WITNESS_KEY must be <hex seed>:<hex pub>");
  return { seed: unhex(m[1]), pub: unhex(m[2]) };
}
async function importSigner({ seed, pub }) {
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) };
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}
export async function witnessVerifierKey(pub) {
  const h = await keyHash(WITNESS_NAME, 0x04, pub);
  return `${WITNESS_NAME}+${hex(h)}+${b64(cat(Uint8Array.of(0x04), pub))}`;
}

// Cosign a verified note. Returns { line, ts }.
export async function cosign(note, keyPair, ts = Math.floor(Date.now() / 1000)) {
  const signer = await importSigner(keyPair);
  const msg = te.encode(`cosignature/v1\ntime ${ts}\n` + note.body);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signer, msg));
  const h = await keyHash(WITNESS_NAME, 0x04, keyPair.pub);
  const tsb = new Uint8Array(8);
  new DataView(tsb.buffer).setBigUint64(0, BigInt(ts));
  return { line: `— ${WITNESS_NAME} ${b64(cat(h, tsb, sig))}`, ts };
}

// Verify one of this witness's own cosignature lines (used by tests and by /witness/verify).
export async function verifyCosignature(noteBody, line, pub) {
  const m = /^— (\S+) (\S+)$/.exec(line);
  if (!m || m[1] !== WITNESS_NAME) return false;
  const p = unb64(m[2]);
  if (p.length !== 4 + 8 + 64) return false;
  if (!eq(p.slice(0, 4), await keyHash(WITNESS_NAME, 0x04, pub))) return false;
  const ts = Number(new DataView(p.buffer, p.byteOffset + 4, 8).getBigUint64(0));
  const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  const msg = te.encode(`cosignature/v1\ntime ${ts}\n` + noteBody);
  return crypto.subtle.verify({ name: "Ed25519" }, key, p.slice(12), msg);
}


// History of cosignatures, so that a log operator can fetch and re-check earlier ones and not
// only the latest. One list per log in KV: [{size, root, ts, via, note}], capped at 400 entries
// (oldest dropped), one write per cosignature.
async function appendHistory(env, id, entry) {
  const k = `witness:${id}:history`;
  let h = [];
  try { h = JSON.parse((await env.COHERENCE.get(k)) || "[]"); } catch { h = []; }
  h.push(entry); if (h.length > 400) h = h.slice(h.length - 400);
  await env.COHERENCE.put(k, JSON.stringify(h));
}
export async function witnessHistory(env, id) {
  if (!env.COHERENCE) return [];
  try { return JSON.parse((await env.COHERENCE.get(`witness:${id}:history`)) || "[]"); } catch { return []; }
}

// ---------- the tick ----------
// State in KV (binding COHERENCE, same namespace as the coherence automaton):
//   witness:<id>:last   {size, root(b64), ts, cosignedNote, logSigOk:true}
//   witness:<id>:err    {at, error}   (cleared on success)
//   witness:<id>:count  legacy counter (no longer written: it now lives inside :last as .count)
export async function witnessTick(env, fetchImpl = fetch) {
  if (!env.COHERENCE || !env.WITNESS_KEY) return { skipped: "not armed" };
  let keyPair;
  try { keyPair = parseWitnessSecret(env.WITNESS_KEY); } catch (e) { return { skipped: e.message }; }
  const out = {};
  for (const log of WITNESSED_LOGS) {
    const kLast = `witness:${log.id}:last`, kErr = `witness:${log.id}:err`, kCount = `witness:${log.id}:count`;
    try {
      const res = await fetchImpl(`${log.base}/checkpoint`, { headers: { "user-agent": "gblin-witness/1 (+https://gblin.digital)" } });
      if (!res.ok) throw new Error(`checkpoint HTTP ${res.status}`);
      const text = await res.text();
      const note = parseNote(text);
      if (note.origin !== log.origin) throw new Error(`origin mismatch: ${note.origin}`);
      if (!(await verifyLogSignature(note, log.vkey))) throw new Error("log signature invalid");

      let prev = null;
      try { prev = JSON.parse((await env.COHERENCE.get(kLast)) || "null"); } catch { prev = null; }
      if (prev) {
        if (note.size < prev.size) throw new Error(`tree shrank ${prev.size} -> ${note.size}`);
        if (note.size === prev.size) {
          if (b64(note.root) !== prev.root) throw new Error("same size, different root (fork!)");
          out[log.id] = { unchanged: true, size: note.size };
          continue; // nothing new to cosign
        }
        const pr = await fetchImpl(`${log.base}/consistency?old=${prev.size}&new=${note.size}`);
        if (!pr.ok) throw new Error(`consistency HTTP ${pr.status}`);
        const proof = (await pr.text()).split("\n").filter((l) => l.length > 0).map(unb64);
        if (!(await verifyConsistency(prev.size, note.size, unb64(prev.root), note.root, proof))) {
          throw new Error(`consistency proof FAILED ${prev.size} -> ${note.size}`);
        }
      }

      const { line, ts } = await cosign(note, keyPair);
      const cosignedNote = text.endsWith("\n") ? text + line + "\n" : text + "\n" + line + "\n";
      // The counter lives INSIDE kLast: on the Cloudflare free plan the budget is 1000 writes
      // per day, and a separate key just for the count burned 144 of them a day for nothing.
      const count = (Number.isInteger(prev?.count) ? prev.count : Number((await env.COHERENCE.get(kCount)) || 0)) + 1;
      await env.COHERENCE.put(kLast, JSON.stringify({ size: note.size, root: b64(note.root), ts, cosignedNote, count, firstSeen: prev?.firstSeen || ts }));
      await appendHistory(env, log.id, { size: note.size, root: b64(note.root), ts, via: "fetch", note: cosignedNote });
      await env.COHERENCE.delete(kErr);
      out[log.id] = { cosigned: true, size: note.size, ts, count };
    } catch (e) {
      const error = String(e && e.message || e);
      await env.COHERENCE.put(kErr, JSON.stringify({ at: Math.floor(Date.now() / 1000), error }), { expirationTtl: 30 * 86400 });
      out[log.id] = { error };
      console.error(`witness ${log.id}:`, error);
    }
  }
  return out;
}


// ---------- push side: c2sp.org/tlog-witness (the LOG calls this witness) ----------
// POST /witness/add-checkpoint   body = "old <size>\n" + proof lines (b64, one per line) + "\n" + <signed checkpoint note>
// 200 → the cosignature line(s); 400 malformed; 403 unknown log / not signed by the pinned key;
// 409 `old` ≠ the size held here (body = that size, decimal + "\n"); 422 consistency proof invalid / tree shrank / fork.
// Same KV state as the passive tick, so pushed and fetched checkpoints can never disagree.
// ── Witness Network (witness-network.org) ────────────────────────────────────
// Logs are discovered from the public "testing" list and configured automatically.
// NETWORK RULE: a discovered log is ADDED to this configuration and is NEVER removed or
// modified because the list changed — so the maintainers of the list cannot disable past
// configurations (and are a less interesting target). The list is a discovery channel, not
// the configuration file.
export const WITNESS_LIST_URL = "https://testing.witness-network.org/log-list.1";
const CFG_KEY = "witness:netcfg";           // { origin: {vkey, qpd, contact, addedAt} }

export function parseLogList(text) {
  const out = []; let cur = null; let sawHeader = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!sawHeader) { if (line !== "logs/v0") throw new Error(`unexpected list header: ${line}`); sawHeader = true; continue; }
    const [k, ...rest] = line.split(/\s+/); const v = rest.join(" ");
    if (k === "vkey") { if (cur) out.push(cur); cur = { vkey: v }; }
    else if (cur && (k === "origin" || k === "qpd" || k === "contact")) cur[k] = v;
  }
  if (cur) out.push(cur);
  // when it is not declared, the origin is the key name inside the vkey
  return out.map((l) => ({ ...l, origin: l.origin || l.vkey.split("+")[0] }));
}

export async function witnessDiscoverLogs(env, fetchImpl = fetch) {
  if (!env.COHERENCE) return { skipped: "no storage" };
  let cfg = {};
  try { cfg = JSON.parse((await env.COHERENCE.get(CFG_KEY)) || "{}"); } catch { cfg = {}; }
  let logs;
  try {
    const res = await fetchImpl(WITNESS_LIST_URL, { headers: { "user-agent": "gblin-witness/1 (+https://gblin.digital/witness)" } });
    if (!res.ok) return { error: `list HTTP ${res.status}` };
    logs = parseLogList(await res.text());
  } catch (e) { return { error: String(e.message || e) }; }
  const added = [];
  for (const l of logs) {
    if (cfg[l.origin]) continue;            // already configured: NEVER touched
    cfg[l.origin] = { vkey: l.vkey, qpd: l.qpd || null, contact: l.contact || null, addedAt: new Date().toISOString(), list: "testing/log-list.1" };
    added.push(l.origin);
  }
  if (added.length) await env.COHERENCE.put(CFG_KEY, JSON.stringify(cfg));
  return { configured: Object.keys(cfg).length, added, seenInList: logs.length };
}

export async function witnessConfiguredLogs(env) {
  try { return JSON.parse((await env.COHERENCE.get(CFG_KEY)) || "{}"); } catch { return {}; }
}

export async function witnessAddCheckpoint(env, bodyText) {
  if (!env.COHERENCE || !env.WITNESS_KEY) return { status: 503, body: "witness not armed\n" };
  let keyPair;
  try { keyPair = parseWitnessSecret(env.WITNESS_KEY); } catch { return { status: 503, body: "witness not armed\n" }; }
  const sep = bodyText.indexOf("\n\n");
  if (sep < 0) return { status: 400, body: "malformed: no blank line between proof and checkpoint\n" };
  const head = bodyText.slice(0, sep).split("\n");
  const m = /^old (\d+)$/.exec(head[0] || "");
  if (!m) return { status: 400, body: "malformed: first line must be 'old <size>'\n" };
  const old = Number(m[1]);
  let proof;
  try { proof = head.slice(1).filter((l) => l.length > 0).map(unb64); } catch { return { status: 400, body: "malformed: proof lines must be base64\n" }; }
  let note;
  try { note = parseNote(bodyText.slice(sep + 2)); } catch (e) { return { status: 400, body: `malformed checkpoint: ${e.message}\n` }; }
  let log = WITNESSED_LOGS.find((l) => l.origin === note.origin);
  if (!log) {
    // log discovered from the witness-network list: its key comes from there
    const cfg = await witnessConfiguredLogs(env);
    const net = cfg[note.origin];
    if (net) log = { id: "net:" + note.origin, origin: note.origin, vkey: net.vkey, note: `Discovered via ${net.list} on ${net.addedAt}` };
  }
  if (!log) return { status: 403, body: "unknown log\n" };
  let sigOk = false;
  try { sigOk = await verifyLogSignature(note, log.vkey); } catch { sigOk = false; }
  if (!sigOk) return { status: 403, body: "checkpoint not signed by the pinned log key\n" };

  const kLast = `witness:${log.id}:last`, kCount = `witness:${log.id}:count`, kErr = `witness:${log.id}:err`;
  let prev = null;
  try { prev = JSON.parse((await env.COHERENCE.get(kLast)) || "null"); } catch { prev = null; }
  const held = prev ? prev.size : 0;
  if (old !== held) return { status: 409, body: `${held}\n` };
  if (prev) {
    if (note.size < prev.size) return { status: 422, body: "tree shrank\n" };
    if (note.size === prev.size) {
      if (b64(note.root) !== prev.root) return { status: 422, body: "same size, different root\n" };
      // nothing new: re-cosign the head already held (fresh timestamp)
    } else if (!(await verifyConsistency(prev.size, note.size, unb64(prev.root), note.root, proof))) {
      return { status: 422, body: "consistency proof invalid\n" };
    }
  } else if (proof.length !== 0) {
    return { status: 400, body: "no proof expected for old 0\n" };
  }
  const { line, ts } = await cosign(note, keyPair);
  if (!prev || note.size > prev.size) {
    const text = bodyText.slice(sep + 2);
    const cosignedNote = text.endsWith("\n") ? text + line + "\n" : text + "\n" + line + "\n";
    const pushCount = (Number.isInteger(prev?.count) ? prev.count : Number((await env.COHERENCE.get(kCount)) || 0)) + 1;
    await env.COHERENCE.put(kLast, JSON.stringify({ size: note.size, root: b64(note.root), ts, cosignedNote, count: pushCount, firstSeen: prev?.firstSeen || ts, via: "push" }));
    await appendHistory(env, log.id, { size: note.size, root: b64(note.root), ts, via: "push", note: cosignedNote });
    const count = pushCount;
    await env.COHERENCE.delete(kErr);
  }
  return { status: 200, body: line + "\n" };
}

// ---------- public read side ----------
export async function witnessIndex(env) {
  let verifierKey = null;
  if (env.WITNESS_KEY) { try { verifierKey = await witnessVerifierKey(parseWitnessSecret(env.WITNESS_KEY).pub); } catch { /* unset */ } }
  const logs = [];
  for (const log of WITNESSED_LOGS) {
    let last = null, err = null, count = 0;
    if (env.COHERENCE) {
      try { last = JSON.parse((await env.COHERENCE.get(`witness:${log.id}:last`)) || "null"); } catch { /* none */ }
      try { err = JSON.parse((await env.COHERENCE.get(`witness:${log.id}:err`)) || "null"); } catch { /* none */ }
      count = Number.isInteger(last?.count) ? last.count : Number((await env.COHERENCE.get(`witness:${log.id}:count`)) || 0);
    }
    logs.push({
      id: log.id, origin: log.origin, log: log.base, pinnedLogKey: log.vkey, note: log.note,
      latest: last ? { size: last.size, root: last.root, cosignedAt: last.ts, cosignedAtIso: new Date(last.ts * 1000).toISOString(), url: `/witness/${log.id}` } : null,
      cosignatures: count,
      lastError: err,
      firstCosignedAt: last?.firstSeen ? new Date(last.firstSeen * 1000).toISOString() : null,
    });
  }
  const netCfg = await witnessConfiguredLogs(env);
  return {
    witness: WITNESS_NAME,
    // "About" card in the form the witness network asks operators for.
    operator: "GBLIN Protocol",
    contact: "info@gblin.digital · https://gblin.digital",
    verifierKey,
    format: "c2sp.org/tlog-cosignature (v1, Ed25519); checkpoints re-verified against the log key and a consistency proof before every cosignature",
    cadence: "every 10 minutes (same heartbeat as the coherence automaton); unchanged tree size → no new signature",
    armed: !!verifierKey,
    witnessNetwork: {
      lists: ["testing/log-list.1"],
      listUrl: WITNESS_LIST_URL,
      discovery: "the list is downloaded once a day and only used to DISCOVER new logs; a log we already configured is never removed or modified because the list changed",
      configuredFromList: Object.keys(netCfg).length,
      configured: Object.entries(netCfg).map(([origin, v]) => ({ origin, vkey: v.vkey, addedAt: v.addedAt, qpd: v.qpd })),
      policy: "add-checkpoint is accepted for any log in our configuration; the checkpoint must verify against that log's key and, when we already hold a smaller tree, against a consistency proof. Requests beyond 60/min/IP are rate limited. No auth, no fee.",
      state: "one persistent record per log (latest cosigned size, root, timestamp) plus a history of cosigned notes",
      limits: "best effort, work-in-progress service run by one operator; not a production guarantee",
      ourOwnLog: {
        origin: "gblin.digital/receipts-log",
        note: "We also operate an application transparency log for AI actions (gblin.digital/receipts-log). Since 2026-08-22 it is cosigned by markovianprotocol.com/witness — see /log/witnesses for who cosigns and at which size. More witnesses welcome: we speak the log side of c2sp.org/tlog-witness and push on every size change.",
        designNote: "https://github.com/gblinproject/gblin-treasury-risk-regime/blob/main/docs/ai-action-transparency-log.md",
        forWitnesses: "GET /log/checkpoint · /log/consistency?old=&new= · /log/leaves?start=&end= · /log/proof/<i>",
      },
    },
    logs,
    roster_status: "markovian: cosigning, no policy weight — the log operator verified our key and push endpoint (2026-08-19); our line appears on their checkpoint once their push runs from the log host; counting toward their 4-of-7 quorum requires their next trust-root manifest rotation. Stated here so the roster does not imply more than it is.",
    history: "GET /witness/<log>/history (JSON list of every cosigned note we still hold, newest last, max 400) and /witness/<log>/<size> (one cosigned note as plain text)",
    push_endpoint: "POST /witness/add-checkpoint — c2sp.org/tlog-witness (body: 'old <size>', consistency proof lines, blank line, signed checkpoint; 200 = cosignature line, 409 = size we hold, 422 = proof invalid)",
    honest_note: "A cosignature says only: 'at this time we saw this tree head and it was consistent with the previous one we saw'. It is not an endorsement of the log's contents.",
  };
}

export async function witnessLatestNote(env, id) {
  const log = WITNESSED_LOGS.find((l) => l.id === id);
  if (!log || !env.COHERENCE) return null;
  try {
    const last = JSON.parse((await env.COHERENCE.get(`witness:${id}:last`)) || "null");
    return last ? last.cosignedNote : null;
  } catch { return null; }
}
