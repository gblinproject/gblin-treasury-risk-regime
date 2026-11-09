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

// Strict base64 decoder: standard alphabet, "=" padding, canonical encoding only
// (RFC 4648, Section 3.5). Throws on anything else.
export function unb64Strict(s) {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("non-canonical base64");
  let u8;
  try { u8 = unb64(s); } catch { throw new Error("non-canonical base64"); }
  if (b64(u8) !== s) throw new Error("non-canonical base64");
  return u8;
}

// ASCII decimal with no leading zeros. Sizes are limited to the exactly representable
// integer range (2^53 - 1); larger values are rejected as malformed.
export function parseDecimal(s) {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(s)) throw new Error("bad decimal");
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error("decimal out of range");
  return n;
}

export const EMPTY_TREE_ROOT = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="; // SHA-256 of the empty string
export const MAX_PROOF_LINES = 63;

// ---------- signed notes (c2sp.org/signed-note, c2sp.org/tlog-checkpoint) ----------
const SIG_LINE = /^— ([^\s+]+) ([A-Za-z0-9+/=]+)$/u;

// Parses a signed checkpoint note. Throws on any malformed input: missing final newline,
// control characters, a malformed signature line, fewer than three non-empty text lines,
// a size that is not a canonical decimal, or a root hash that is not 32 bytes of
// canonical base64. The text is separated from the signatures by the last blank line.
export function parseNote(text) {
  if (typeof text !== "string" || !text.endsWith("\n")) throw new Error("note: missing final newline");
  if (/[\u0000-\u0009\u000b-\u001f]/.test(text)) throw new Error("note: control character");
  const i = text.lastIndexOf("\n\n");
  if (i < 0) throw new Error("note: no blank line");
  const body = text.slice(0, i + 1); // includes the final "\n" of the text
  const sigLines = text.slice(i + 2, -1).split("\n");
  for (const l of sigLines) {
    const m = SIG_LINE.exec(l);
    if (!m) throw new Error("note: malformed signature line");
    if (unb64Strict(m[2]).length < 5) throw new Error("note: signature too short");
  }
  const lines = body.slice(0, -1).split("\n");
  if (lines.length < 3 || lines.some((l) => l.length === 0)) throw new Error("checkpoint: needs at least three non-empty lines");
  const size = parseDecimal(lines[1]);
  const root = unb64Strict(lines[2]);
  if (root.length !== 32) throw new Error("checkpoint: root hash is not 32 bytes");
  return { body, origin: lines[0], size, root, sigLines };
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

// Verify the LOG's own signature (alg 0x01) on a note body. Returns true only when at least
// one signature line from the pinned key verifies and no line carrying the pinned key's name
// and key ID fails to verify (such a note is malformed per c2sp.org/signed-note). Lines from
// other keys are ignored.
export async function verifyLogSignature(note, vkey) {
  const k = parseVkey(vkey);
  if (k.alg !== 0x01) throw new Error("pinned key is not an Ed25519 note key");
  const expectHash = await keyHash(k.name, 0x01, k.pub);
  if (!eq(expectHash, k.hash)) throw new Error("pinned key hash mismatch");
  const key = await crypto.subtle.importKey("raw", k.pub, { name: "Ed25519" }, false, ["verify"]);
  let verified = false;
  for (const line of note.sigLines) {
    const m = SIG_LINE.exec(line);
    if (!m || m[1] !== k.name) continue;
    const payload = unb64Strict(m[2]);
    if (!eq(payload.slice(0, 4), k.hash)) continue; // another key under the same name
    if (payload.length !== 4 + 64) return false;
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, payload.slice(4), te.encode(note.body)))) return false;
    verified = true;
  }
  return verified;
}

// ---------- RFC 6962 consistency proof (RFC 9162, Section 2.1.4.2) ----------
// Plain arithmetic instead of 32-bit bitwise operators, so that every size up to 2^53 - 1
// is handled exactly.
const nodeHash = async (l, r) => sha256(cat(Uint8Array.of(0x01), l, r));
const isOdd = (x) => x % 2 === 1;
const half = (x) => Math.floor(x / 2);
const isPowerOfTwo = (x) => { if (x < 1) return false; while (x % 2 === 0) x /= 2; return x === 1; };
export async function verifyConsistency(n, m, oldRoot, newRoot, proof) {
  if (n === m) return proof.length === 0 && eq(oldRoot, newRoot);
  if (n === 0) return proof.length === 0; // any newRoot is consistent with the empty tree
  if (n > m || proof.length === 0) return false;
  let fn = n - 1, sn = m - 1;
  while (isOdd(fn)) { fn = half(fn); sn = half(sn); }
  let i = 0, fr, sr;
  if (isPowerOfTwo(n)) { fr = oldRoot; sr = oldRoot; }
  else { fr = proof[0]; sr = proof[0]; i = 1; }
  for (; i < proof.length; i++) {
    if (sn === 0) return false;
    const c = proof[i];
    if (isOdd(fn) || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      while (!isOdd(fn) && fn !== 0) { fn = half(fn); sn = half(sn); }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn = half(fn); sn = half(sn);
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

// ---------- latest cosigned checkpoint per origin ----------
// c2sp.org/tlog-witness requires the check of the old size and the update of the stored
// checkpoint to be one atomic step. The authoritative record is a D1 row (binding USAGE)
// replaced with a conditional statement on its size and root, so a concurrent request that
// read the same record cannot roll it back. The KV record witness:<id>:last remains the
// source of the public index and is seeded into D1 the first time an origin is read.
// Without a D1 binding the KV record is used directly and updates are not atomic.
const HEAD_TABLE_SQL = "CREATE TABLE IF NOT EXISTS witness_head (origin TEXT PRIMARY KEY, size INTEGER NOT NULL, root TEXT NOT NULL, ts INTEGER NOT NULL, note TEXT)";
const headTableReady = new WeakSet(); // D1 bindings on which the table is known to exist
async function headDb(env) {
  if (!env.USAGE) return null;
  if (!headTableReady.has(env.USAGE)) { await env.USAGE.prepare(HEAD_TABLE_SQL).run(); headTableReady.add(env.USAGE); }
  return env.USAGE;
}
async function readKvLast(env, id) {
  try { return JSON.parse((await env.COHERENCE.get(`witness:${id}:last`)) || "null"); } catch { return null; }
}
async function selectHead(db, origin) {
  return db.prepare("SELECT size, root, ts, note FROM witness_head WHERE origin = ?").bind(origin).first();
}

// Returns { size, root (base64), note } of the latest cosigned checkpoint, or null.
async function loadHead(env, log) {
  const db = await headDb(env);
  if (!db) {
    const kv = await readKvLast(env, log.id);
    return kv ? { size: kv.size, root: kv.root, note: kv.cosignedNote || null } : null;
  }
  let row = await selectHead(db, log.origin);
  if (!row) {
    const kv = await readKvLast(env, log.id);
    if (!kv) return null;
    await db.prepare("INSERT INTO witness_head (origin, size, root, ts, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT (origin) DO NOTHING")
      .bind(log.origin, kv.size, kv.root, kv.ts || 0, kv.cosignedNote || null).run();
    row = await selectHead(db, log.origin);
    if (!row) return null;
  }
  return { size: Number(row.size), root: row.root, note: row.note || null };
}

// Replaces `prev` (as returned by loadHead, or null) with `next` in one conditional
// statement. Returns false when another request changed the record in between.
async function commitHead(env, log, prev, next) {
  const db = await headDb(env);
  if (!db) return true; // KV only: the caller's KV write is the update
  const r = prev
    ? await db.prepare("UPDATE witness_head SET size = ?, root = ?, ts = ?, note = ? WHERE origin = ? AND size = ? AND root = ?")
      .bind(next.size, next.root, next.ts, next.note, log.origin, prev.size, prev.root).run()
    : await db.prepare("INSERT INTO witness_head (origin, size, root, ts, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT (origin) DO NOTHING")
      .bind(log.origin, next.size, next.root, next.ts, next.note).run();
  return Number(r?.meta?.changes ?? 0) === 1;
}

// Appends this witness's cosignature line to a signed note, replacing any earlier line
// under the same key name (a note must not carry two lines with the same name and key ID).
export function withCosignature(text, line) {
  const i = text.lastIndexOf("\n\n");
  const sigs = text.slice(i + 2, -1).split("\n").filter((l) => !l.startsWith(`— ${WITNESS_NAME} `));
  return text.slice(0, i + 2) + [...sigs, line].join("\n") + "\n";
}

// Persists a cosignature: the conditional D1 update first, then the KV record and history
// used by the public index. Returns false when the D1 update lost a race.
async function recordCosignature(env, log, prev, note, text, line, ts, via) {
  const cosignedNote = withCosignature(text, line);
  const root = b64(note.root);
  if (!(await commitHead(env, log, prev, { size: note.size, root, ts, note: cosignedNote }))) return false;
  if (prev && note.size === prev.size) return true; // same tree head: no new KV entry
  const kvPrev = await readKvLast(env, log.id);
  const count = (Number.isInteger(kvPrev?.count) ? kvPrev.count : Number((await env.COHERENCE.get(`witness:${log.id}:count`)) || 0)) + 1;
  // The counter lives inside the :last record to stay within the KV daily write allowance.
  await env.COHERENCE.put(`witness:${log.id}:last`, JSON.stringify({ size: note.size, root, ts, cosignedNote, count, firstSeen: kvPrev?.firstSeen || ts, via }));
  await appendHistory(env, log.id, { size: note.size, root, ts, via, note: cosignedNote });
  await env.COHERENCE.delete(`witness:${log.id}:err`);
  return true;
}

// Resolves an origin to a configured log: pinned logs first, then logs discovered from the
// witness network list. Returns null for an unknown origin.
export async function witnessResolveLog(env, origin) {
  const pinned = WITNESSED_LOGS.find((l) => l.origin === origin);
  if (pinned) return pinned;
  const net = (await witnessConfiguredLogs(env))[origin];
  return net ? { id: "net:" + origin, origin, vkey: net.vkey, note: `Discovered via ${net.list} on ${net.addedAt}` } : null;
}

// ---------- the tick ----------
// State: the D1 table witness_head (authoritative latest cosigned checkpoint per origin) and,
// in KV (binding COHERENCE, same namespace as the coherence automaton):
//   witness:<id>:last     {size, root(b64), ts, cosignedNote, count, firstSeen, via}
//   witness:<id>:history  cosigned notes, newest last (max 400)
//   witness:<id>:err      {at, error}   (cleared on success)
//   witness:<id>:count    legacy counter (no longer written: it now lives inside :last as .count)
export async function witnessTick(env, fetchImpl = fetch) {
  if (!env.COHERENCE || !env.WITNESS_KEY) return { skipped: "not armed" };
  let keyPair;
  try { keyPair = parseWitnessSecret(env.WITNESS_KEY); } catch (e) { return { skipped: e.message }; }
  const out = {};
  for (const log of WITNESSED_LOGS) {
    const kErr = `witness:${log.id}:err`;
    try {
      const res = await fetchImpl(`${log.base}/checkpoint`, { headers: { "user-agent": "gblin-witness/1 (+https://gblin.digital)" } });
      if (!res.ok) throw new Error(`checkpoint HTTP ${res.status}`);
      const text = await res.text();
      const note = parseNote(text);
      if (note.origin !== log.origin) throw new Error(`origin mismatch: ${note.origin}`);
      if (!(await verifyLogSignature(note, log.vkey))) throw new Error("log signature invalid");
      if (note.size === 0 && b64(note.root) !== EMPTY_TREE_ROOT) throw new Error("size 0 with a non-empty root");

      const prev = await loadHead(env, log);
      if (prev) {
        if (note.size < prev.size) throw new Error(`tree shrank ${prev.size} -> ${note.size}`);
        if (note.size === prev.size) {
          if (b64(note.root) !== prev.root) throw new Error("same size, different root");
          out[log.id] = { unchanged: true, size: note.size };
          continue; // nothing new to cosign
        }
        if (prev.size > 0) {
          const pr = await fetchImpl(`${log.base}/consistency?old=${prev.size}&new=${note.size}`);
          if (!pr.ok) throw new Error(`consistency HTTP ${pr.status}`);
          const lines = (await pr.text()).split("\n").filter((l) => l.length > 0);
          if (lines.length > MAX_PROOF_LINES) throw new Error("consistency proof too long");
          const proof = lines.map(unb64Strict);
          if (proof.some((h) => h.length !== 32)) throw new Error("consistency proof hash is not 32 bytes");
          if (!(await verifyConsistency(prev.size, note.size, unb64(prev.root), note.root, proof))) {
            throw new Error(`consistency proof failed ${prev.size} -> ${note.size}`);
          }
        }
      }

      const { line, ts } = await cosign(note, keyPair);
      if (!(await recordCosignature(env, log, prev, note, text, line, ts, "fetch"))) {
        throw new Error("state changed concurrently; retried on the next tick");
      }
      out[log.id] = { cosigned: true, size: note.size, ts };
    } catch (e) {
      const error = String(e && e.message || e);
      await env.COHERENCE.put(kErr, JSON.stringify({ at: Math.floor(Date.now() / 1000), error }), { expirationTtl: 30 * 86400 });
      out[log.id] = { error };
      console.error(`witness ${log.id}:`, error);
    }
  }
  return out;
}


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

// ---------- push side: c2sp.org/tlog-witness add-checkpoint (the log calls this witness) ----------
// POST /witness/add-checkpoint, body = "old <size>\n" + consistency proof lines (base64, one per
// line, at most 63) + "\n" + signed checkpoint. Checks, in the order of the specification:
//   400 malformed request, or old size larger than the checkpoint size
//   404 unknown origin
//   403 no valid signature from the log key, or a line from that key that does not verify
//   409 old size differs from the latest size cosigned here (body "<size>\n", text/x.tlog.size)
//   422 size 0 with a non-empty root, a proof sent with old size 0, an equal size with a
//       different root or a non-empty proof, or a consistency proof that does not verify
//   200 the cosignature line, after the new checkpoint is persisted
// Returns { status, body, type? }; `type` is set only when it is not text/plain.
const reply = (status, body, type) => (type ? { status, body, type } : { status, body });

export async function witnessAddCheckpoint(env, bodyText) {
  if (!env.COHERENCE || !env.WITNESS_KEY) return reply(503, "witness not armed\n");
  let keyPair;
  try { keyPair = parseWitnessSecret(env.WITNESS_KEY); } catch { return reply(503, "witness not armed\n"); }

  const sep = bodyText.indexOf("\n\n");
  if (sep < 0) return reply(400, "malformed request: no blank line before the checkpoint\n");
  const head = bodyText.slice(0, sep).split("\n");
  const m = /^old (\S+)$/.exec(head[0]);
  let old;
  try { old = parseDecimal(m ? m[1] : ""); } catch { return reply(400, "malformed request: first line must be 'old <size>'\n"); }
  const proofLines = head.slice(1);
  if (proofLines.length > MAX_PROOF_LINES) return reply(400, "malformed request: more than 63 proof lines\n");
  let proof;
  try {
    proof = proofLines.map(unb64Strict);
    if (proof.some((h) => h.length !== 32)) throw new Error("hash length");
  } catch { return reply(400, "malformed request: each proof line must be a 32-byte hash in canonical base64\n"); }
  const text = bodyText.slice(sep + 2);
  let note;
  try { note = parseNote(text); } catch (e) { return reply(400, `malformed checkpoint: ${e.message}\n`); }

  const log = await witnessResolveLog(env, note.origin);
  if (!log) return reply(404, "unknown origin\n");
  let sigOk = false;
  try { sigOk = await verifyLogSignature(note, log.vkey); } catch { sigOk = false; }
  if (!sigOk) return reply(403, "checkpoint not signed by the log key\n");

  if (old > note.size) return reply(400, "old size larger than checkpoint size\n");
  let prev;
  try { prev = await loadHead(env, log); } catch { return reply(503, "storage unavailable\n"); }
  const held = prev ? prev.size : 0;
  if (old !== held) return reply(409, `${held}\n`, "text/x.tlog.size");

  const root = b64(note.root);
  if (note.size === 0 && root !== EMPTY_TREE_ROOT) return reply(422, "size 0 requires the empty tree root\n");
  if (old === 0 && proof.length !== 0) return reply(422, "proof must be empty when old size is 0\n");
  if (old === note.size) {
    if (prev && root !== prev.root) return reply(422, "same size, different root\n");
    if (proof.length !== 0) return reply(422, "proof must be empty when old size equals checkpoint size\n");
  } else if (old > 0 && !(await verifyConsistency(old, note.size, unb64(prev.root), note.root, proof))) {
    return reply(422, "consistency proof invalid\n");
  }

  const { line, ts } = await cosign(note, keyPair);
  let committed;
  try { committed = await recordCosignature(env, log, prev, note, text, line, ts, "push"); } catch { return reply(503, "storage unavailable\n"); }
  if (!committed) {
    // Another request moved the record between the check and the update.
    let cur = null;
    try { cur = await loadHead(env, log); } catch { /* fall through */ }
    return reply(409, `${cur ? cur.size : held}\n`, "text/x.tlog.size");
  }
  return reply(200, line + "\n");
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
      state: "one persistent record per log (latest cosigned size, root, timestamp), checked and updated in one atomic step, plus a history of cosigned notes",
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
    push_endpoint: "POST /witness/add-checkpoint — c2sp.org/tlog-witness (body: 'old <size>', consistency proof lines, blank line, signed checkpoint; 200 = cosignature line, 400 = malformed, 403 = log signature missing or invalid, 404 = unknown origin, 409 = size we hold (text/x.tlog.size), 422 = proof or root check failed)",
    monitoring: "GET /witness/<lowercase hex SHA-256 of the origin>/checkpoint — c2sp.org/tlog-witness monitoring endpoint (latest cosigned checkpoint; 404 if never cosigned)",
    honest_note: "A cosignature says only: 'at this time we saw this tree head and it was consistent with the previous one we saw'. It is not an endorsement of the log's contents.",
  };
}

// Latest cosigned note for a log id ("markovian", or "net:<origin>" for a discovered log).
export async function witnessLatestNote(env, id) {
  if (!env.COHERENCE) return null;
  const origin = id.startsWith("net:") ? id.slice(4) : WITNESSED_LOGS.find((l) => l.id === id)?.origin;
  if (!origin) return null;
  const log = await witnessResolveLog(env, origin);
  if (!log || log.id !== id) return null;
  try {
    const h = await loadHead(env, log);
    return h && h.note ? h.note : null;
  } catch {
    const kv = await readKvLast(env, id);
    return kv ? kv.cosignedNote || null : null;
  }
}

// c2sp.org/tlog-witness monitoring endpoint: GET <prefix>/<origin hash>/checkpoint, where the
// origin hash is the lowercase hex SHA-256 of the origin. Returns the latest cosigned note,
// or null when the origin is unknown or was never cosigned here.
export async function witnessCheckpointByOriginHash(env, originHash) {
  if (!/^[0-9a-f]{64}$/.test(originHash)) return null;
  const origins = [...WITNESSED_LOGS.map((l) => l.origin), ...Object.keys(await witnessConfiguredLogs(env))];
  for (const origin of origins) {
    if (hex(await sha256(te.encode(origin))) !== originHash) continue;
    const log = await witnessResolveLog(env, origin);
    return log ? witnessLatestNote(env, log.id) : null;
  }
  return null;
}
