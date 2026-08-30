// rlog.mjs — GBLIN AI ACTION RECEIPTS: append-only transparency log + sealing.
//
// Cosa fa: un agente (o un'app IA) manda gli HASH di ciò che ha fatto
// (input/output/azione); il log li accoda a un albero Merkle RFC 6962,
// firma un checkpoint C2SP e restituisce una RICEVUTA portabile e
// verificabile OFFLINE: payload canonico + firma Ed25519 + indice nel log
// + inclusion proof + checkpoint firmato. Il root viene ancorato su Base
// (EAS) una volta al giorno dal wallet osservatore. Nessun contenuto viene
// mai memorizzato: SOLO hash e stringhe corte (GDPR-light by design).
//
// Regole pre-registrate (non cambiarle senza dichiararlo nel changelog):
//  - leaf = SHA256(0x00 || canonical_payload_utf8)   (RFC 6962)
//  - node = SHA256(0x01 || left || right)
//  - canonical JSON: chiavi ordinate, nessuno spazio, UTF-8
//  - receipt signature: Ed25519 su "gblin-receipt/v1\n" + canonical_payload
//  - checkpoint: signed note C2SP, origin "gblin.digital/receipts-log"
//  - il log NON giudica e NON verifica i contenuti: attesta esistenza+tempo.
//    "evidence, not endorsement; a seal is not a compliance certificate."
//
// Secret: RLOG_KEY = "<hex seed 32B>:<hex pub 32B>" (come WITNESS_KEY).
// KV (binding COHERENCE): rlog:size · rlog:entry:<n> · rlog:node:<l>:<i>
//                         rlog:demo:<ip>:<day> · rlog:anchored:<day>

export const RLOG_ORIGIN = "gblin.digital/receipts-log";
const MAX_STR = 128;           // max per action/agent_id/tool
const MAX_META = 512;          // max chars del JSON meta
const DEMO_PER_DAY = 5;        // sigilli demo gratis per IP/giorno

const te = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/.{2}/g).map((x) => parseInt(x, 16)));
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
const leafHash = (data) => sha256(cat(Uint8Array.of(0x00), data));
const nodeHash = (l, r) => sha256(cat(Uint8Array.of(0x01), l, r));

// Canonical JSON: chiavi ordinate ricorsivamente, separatori minimi.
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort()
    .map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

// ---------- chiave del log ----------
function parseKey(secret) {
  const m = /^([0-9a-fA-F]{64}):([0-9a-fA-F]{64})$/.exec((secret || "").trim());
  if (!m) throw new Error("RLOG_KEY must be <hex seed>:<hex pub>");
  return { seed: unhex(m[1]), pub: unhex(m[2]) };
}
async function signer(kp) {
  const jwk = { kty: "OKP", crv: "Ed25519", d: b64url(kp.seed), x: b64url(kp.pub) };
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}
async function keyHash(name, alg, pub) {
  return (await sha256(cat(te.encode(name + "\n"), Uint8Array.of(alg), pub))).slice(0, 4);
}
export async function rlogVerifierKey(pub) {
  const h = await keyHash(RLOG_ORIGIN, 0x01, pub);
  return `${RLOG_ORIGIN}+${hex(h)}+${b64(cat(Uint8Array.of(0x01), pub))}`;
}

// ---------- ancora on-chain + provenienza (additivi, fuori dal payload firmato) ----------
export const RLOG_EAS_SCHEMA_UID = "0x9f433a96467ab75530009970e5aa938ec94d8a49f08f66e7381822d557b448ef";
export const RLOG_PROMISE_LABEL = "gblin-receipts-log"; // promiseId = keccak256 di questa stringa
// Stato dell'ultima ancora EAS del root su Base (scritta da rlogAnchorDaily in index.js).
// `covers_this_receipt` = la foglia era già nell'albero quando il root è stato ancorato.
export async function anchorInfo(env, index) {
  let last = null;
  try { last = JSON.parse((await env.COHERENCE.get("rlog:anchorLast")) || "null"); } catch { last = null; }
  return {
    chain: "base (eip155:8453)",
    method: "EAS attestation of the tree root, once per UTC day, by the observer wallet",
    eas_schema_uid: RLOG_EAS_SCHEMA_UID,
    promise_id: `keccak256("${RLOG_PROMISE_LABEL}")`,
    last_anchor: last ? { day: last.day, tree_size: last.size, root: last.root, tx: last.hash } : null,
    root_covers_this_receipt: !!(last && typeof index === "number" && index < last.size),
    covers_this_receipt: !!(last && typeof index === "number" && index < last.size), // alias of root_covers_this_receipt (kept 30 days)
    anchored_tree_size: last ? last.size : null,
    what_is_anchored: "Only the tree ROOT at last_anchor.tree_size is written on-chain; individual receipts never are. A receipt is covered iff its index < anchored tree_size, and then its inclusion proof binds it to that root. Until the next daily anchor, newer receipts rest on the operator-signed checkpoint alone.",
    explorer: `https://base.easscan.org/schema/view/${RLOG_EAS_SCHEMA_UID}`,
  };
}
export const PROVENANCE_LEVELS = ["self-reported", "server-observed", "externally-verified"];
// Operator receipts = sealed by this Worker about its OWN actions. Marked with the signed
// payload field `by: "operator"`, which only the internal operator path can set: callers cannot
// forge it (validateSealInput never copies it from the request body), so a paying customer
// cannot self-declare "server-observed".
export function provenanceFor(payload) {
  const self = !!(payload && payload.by === "operator");
  const out = { ...PROVENANCE, level: self ? "server-observed" : "self-reported",
    meaning: self ? "This server performed the sealed action itself and sealed it (payload.by = \"operator\", set server-side only); the log proves the record and its time, and meta carries the on-chain tx of that action." : PROVENANCE.meaning };
  // La prova del PAGAMENTO e' un asse diverso da quella dell'AZIONE, e non va confusa con essa:
  // un sigillo pagato resta self-reported nei suoi hash. Nato dal rilievo di un terzo (22/08/2026):
  // avevamo affermato in privato un pagamento che il record non portava. Ora o lo porta o non si dice.
  if (payload && payload.payment) {
    out.payment_evidence = {
      level: "server-observed",
      meaning: "The resource server verified an x402 payment authorization for this seal before writing it; payload.payment records what the server saw, not what the caller claimed. The sealed ACTION and its hashes remain self-reported.",
      find_settlement_onchain: "USDC on Base emits AuthorizationUsed(authorizer, nonce) in the settlement transaction: search that event for payload.payment.payer and payload.payment.authorization_nonce to find the transaction independently. We do not write the transaction hash here because the server does not know it at seal time.",
    };
  }
  return out;
}
export const PROVENANCE = {
  level: "self-reported",
  levels: PROVENANCE_LEVELS,
  levels_meaning: { "self-reported": "sealer supplied the hashes; log proves recording time only", "server-observed": "this server itself performed/observed the action it sealed (operator receipts, meta.self_sealed=true)", "externally-verified": "a third party independently confirmed the action (not offered yet)" },
  meaning: "The sealer supplied action/input_hash/output_hash; the log proves they were recorded at this index and time. It does NOT prove the external action happened or that the hashes match any real input/output.",
};

// ---------- Merkle su KV (nodi congelati) ----------
const nk = (l, i) => `rlog:node:${l}:${i}`;
async function getNode(env, l, i) {
  const v = await env.COHERENCE.get(nk(l, i));
  if (!v) throw new Error(`missing node ${l}:${i}`);
  return unhex(v);
}
// Root di un range [a,b) con b<=N, usando SOLO nodi congelati (ogni foglia
// scritta congela node:0:i, e ogni coppia completa congela il genitore).
async function rangeRoot(env, a, b) {
  const len = b - a;
  if (len === 1) return getNode(env, 0, a);
  // range perfetto allineato → nodo congelato diretto
  const isPow2 = (len & (len - 1)) === 0;
  if (isPow2 && a % len === 0) {
    const level = Math.log2(len);
    return getNode(env, level, a / len);
  }
  let k = 1; while (k * 2 < len) k *= 2;
  const [L, R] = await Promise.all([rangeRoot(env, a, a + k), rangeRoot(env, a + k, b)]);
  return nodeHash(L, R);
}
export async function treeRoot(env, N) {
  if (N === 0) return sha256(new Uint8Array(0)); // RFC 6962: root dell'albero vuoto
  return rangeRoot(env, 0, N);
}
// Inclusion proof RFC 6962 per la foglia i in un albero di N foglie.
async function inclusionPath(env, i, a, b) {
  if (b - a === 1) return [];
  let k = 1; while (k * 2 < b - a) k *= 2;
  if (i < a + k) {
    const sub = await inclusionPath(env, i, a, a + k);
    sub.push(await rangeRoot(env, a + k, b));
    return sub;
  }
  const sub = await inclusionPath(env, i, a + k, b);
  sub.push(await rangeRoot(env, a, a + k));
  return sub;
}
export async function proofFor(env, index, N) {
  if (!(index >= 0 && index < N)) throw new Error("index out of range");
  const path = await inclusionPath(env, index, 0, N);
  return path.map(b64);
}

// Consistency proof RFC 6962 (SUBPROOF): dimostra che l'albero di m foglie e'
// un PREFISSO di quello di n foglie, cioe' che il log e' append-only e nessuna
// voce e' stata riscritta. Senza questo un witness dovrebbe firmare alla cieca.
async function subproof(env, m, a, b, isRoot) {
  const n = b - a;
  if (m === n) return isRoot ? [] : [await rangeRoot(env, a, b)];
  let k = 1; while (k * 2 < n) k *= 2;
  if (m <= k) {
    const sub = await subproof(env, m, a, a + k, isRoot);
    sub.push(await rangeRoot(env, a + k, b));
    return sub;
  }
  const sub = await subproof(env, m - k, a + k, b, false);
  sub.push(await rangeRoot(env, a, a + k));
  return sub;
}
export async function consistencyProof(env, m, n) {
  if (!(0 < m && m <= n)) throw new Error("need 0 < old <= new");
  if (m === n) return [];
  const path = await subproof(env, m, 0, n, true);
  return path.map(b64);
}

// Foglie in chiaro [start,end): permette a chiunque di ricalcolare l'albero da zero.
export async function leaves(env, start, end) {
  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  end = Math.min(end, N);
  if (!(start >= 0 && start < end)) return { start, end, size: N, leaves: [] };
  if (end - start > 256) end = start + 256; // stesso tetto del log di Markovian
  const out = [];
  for (let i = start; i < end; i++) {
    const c = await env.COHERENCE.get(`rlog:entry:${i}`);
    out.push(c === null ? null : c);
  }
  // Onesta': quattro record (indici 11-14) NON sono JSON valido — contengono il token
  // letterale `undefined` scritto dal bug del canonicalizzatore corretto il 21/08/2026.
  // Le foglie restano quei byte esatti (un log append-only non si riscrive) e l'albero e'
  // corretto, ma un consumatore che fa JSON.parse va in errore: va detto QUI, non solo nei doc.
  const malformed = [];
  for (let i = 0; i < out.length; i++) { try { JSON.parse(out[i]); } catch { malformed.push(start + i); } }
  const res = { start, end, size: N, encoding: "raw record bytes; leaf = SHA256(0x00 || record). Normally gblin-canonical-json/1, but see malformed_indices", leaves: out };
  if (malformed.length) {
    res.malformed_indices = malformed;
    res.malformed_note = "These records are NOT parseable JSON: they contain the literal token `undefined`, written by a canonicalizer bug fixed on 2026-08-21. They are hashed and served as the exact bytes they were appended with, because an append-only log is not rewritten. Hash them as opaque bytes; do not JSON.parse them.";
  }
  return res;
}

// ---------- checkpoint (signed note C2SP) ----------
const SEP = "— ";   // em dash + spazio: separatore delle firme nelle signed note

// ---------- push dei nostri checkpoint ai witness (c2sp.org/tlog-witness) ----------
// Il LOG spinge: manda "old <n>" + prova di consistenza + il checkpoint firmato e
// riceve una riga di cofirma. La cofirma vale SOLO per quella (origin, size, root):
// la conserviamo con la size e la serviamo nel checkpoint solo quando combacia.
export const WITNESSES = [
  {
    id: "markovian",
    name: "markovianprotocol.com/witness",
    url: "https://witness.markovianprotocol.com/add-checkpoint",
    vkey: "markovianprotocol.com/witness+41b8827f+BJKLl8rBYM0oUxSaWh9rjTldTprEpYj/SWVIGgacA9XC",
  },
];
const ckey = (id) => `rlog:cosign:${id}`;

export async function cosignaturesFor(env, N) {
  const out = [];
  for (const w of WITNESSES) {
    try {
      const v = JSON.parse((await env.COHERENCE.get(ckey(w.id))) || "null");
      if (v && v.size === N && v.line) out.push(v.line);
    } catch { /* nessuna cofirma valida per questa size */ }
  }
  return out;
}

export async function witnessState(env) {
  const out = [];
  for (const w of WITNESSES) {
    let v = null;
    try { v = JSON.parse((await env.COHERENCE.get(ckey(w.id))) || "null"); } catch {}
    out.push({ witness: w.name, vkey: w.vkey, endpoint: w.url, cosigned_size: v?.size ?? null, at: v?.at ?? null, last_error: v?.error ?? null });
  }
  return out;
}

// Quale size tiene questo witness per il NOSTRO log? Il c2sp espone la nota cofirmata
// sotto sha256(origin) in esadecimale minuscolo: la leggiamo e ne prendiamo la size.
async function witnessHeldSize(w, fetchImpl = fetch) {
  try {
    const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(RLOG_ORIGIN)));
    const hex = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
    const base = new URL(w.url); base.pathname = `/${hex}/checkpoint`;
    const res = await fetchImpl(base.toString());
    if (res.status !== 200) return null;
    const n = Number((await res.text()).split("\n")[1]);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

export async function pushToWitnesses(env, { force = false, fetchImpl = fetch } = {}) {
  if (!env.RLOG_KEY) return { skipped: "no key" };
  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  if (!N) return { skipped: "empty log" };
  const root = await treeRoot(env, N);
  const note = await signedCheckpoint(env, N, root, { withCosignatures: false });
  const results = [];
  for (const w of WITNESSES) {
    let prev = null;
    try { prev = JSON.parse((await env.COHERENCE.get(ckey(w.id))) || "null"); } catch {}
    if (prev && prev.size === N && prev.line) { results.push({ witness: w.name, ok: true, size: N, cached: true }); continue; }
    // Backoff: se l'ultimo tentativo per QUESTA size e' fallito da meno di un'ora, non insistere.
    if (!force && prev && prev.error && prev.triedSize === N && Date.now() - Date.parse(prev.triedAt || 0) < 3600e3) {
      results.push({ witness: w.name, ok: false, skipped: "backoff", last_error: prev.error }); continue;
    }
    const attempt = async (old) => {
      const proof = old === 0 ? [] : await consistencyProof(env, old, N);
      const body = [`old ${old}`, ...proof].join("\n") + "\n\n" + note;
      const res = await fetchImpl(w.url, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8", "user-agent": "gblin-receipts-log/1 (+https://gblin.digital)" },
        body,
      });
      return { status: res.status, text: (await res.text()).trim() };
    };
    try {
      let r = await attempt(prev?.size || 0);
      // 409 = il witness ne tiene una piu' grande e la dichiara nel corpo.
      // 422 = la prova non regge per la size che gli abbiamo dichiarato: succede quando
      // il witness ci ha gia' registrati fuori banda (trust-on-first-use) e noi non lo
      // sappiamo. In quel caso chiediamo a LUI quale size tiene e rifacciamo la prova.
      if (r.status === 409 || r.status === 422) {
        let held = Number(r.text.trim().split(/\s+/).pop());
        if (!Number.isInteger(held) || held < 0 || held > N) held = await witnessHeldSize(w, fetchImpl);
        if (Number.isInteger(held) && held >= 0 && held <= N) r = await attempt(held);
      }
      if (r.status === 200 && r.text.startsWith(SEP)) {
        await env.COHERENCE.put(ckey(w.id), JSON.stringify({ size: N, root: b64(root), line: r.text.split("\n")[0].trim(), at: new Date().toISOString(), error: null }));
        results.push({ witness: w.name, ok: true, size: N });
      } else {
        const err = `HTTP ${r.status}: ${r.text.slice(0, 160)}`;
        await env.COHERENCE.put(ckey(w.id), JSON.stringify({ ...(prev || {}), error: err, triedSize: N, triedAt: new Date().toISOString() }));
        results.push({ witness: w.name, ok: false, status: r.status, body: r.text.slice(0, 160) });
      }
    } catch (e) {
      const err = String(e?.message || e);
      await env.COHERENCE.put(ckey(w.id), JSON.stringify({ ...(prev || {}), error: err, triedSize: N, triedAt: new Date().toISOString() }));
      results.push({ witness: w.name, ok: false, error: err });
    }
  }
  return { size: N, root: b64(root), results };
}

export async function signedCheckpoint(env, N, root, { withCosignatures = true } = {}) {
  const kp = parseKey(env.RLOG_KEY);
  const body = `${RLOG_ORIGIN}\n${N}\n${b64(root)}\n`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await signer(kp), te.encode(body)));
  const kh = await keyHash(RLOG_ORIGIN, 0x01, kp.pub);
  let note = body + "\n" + `${SEP}${RLOG_ORIGIN} ${b64(cat(kh, sig))}` + "\n";
  if (withCosignatures) {
    for (const line of await cosignaturesFor(env, N)) note += line + "\n";
  }
  return note;
}

// ---------- append + ricevuta ----------
const VERIFY_HINT = "offline: see verify-receipt.mjs in github.com/gblinproject/gblin-treasury-risk-regime (zero deps)";
const RECEIPT_NOTE = "Evidence of existence and time in a signed append-only log, root anchored daily on Base (EAS) — NOT a compliance certificate and NOT an endorsement of the content. The action/agent_id/tool/meta strings you send are published in the public log: put identifiers there, never secrets; input/output go in as hashes only. For a PAID seal the record also carries what this server saw of the payment (payer address, amount, authorization nonce): that too is public, and it is on-chain public already.";

export function validateSealInput(body) {
  const errs = [];
  const hexRe = /^(0x)?[0-9a-fA-F]{64}$/;
  const s = (x) => typeof x === "string" ? x.trim() : "";
  const action = s(body.action), agent = s(body.agent_id), tool = s(body.tool);
  if (!action) errs.push("action: required (short public label, <=128 chars)");
  else if (action.length > MAX_STR) errs.push(`action: too long (${action.length} chars, max 128)`);
  if (agent.length > MAX_STR) errs.push("agent_id: <=128 chars");
  if (tool.length > MAX_STR) errs.push("tool: <=128 chars");
  if (!hexRe.test(s(body.input_hash) || "")) errs.push("input_hash: 32-byte hex (sha256 of your input) required");
  // Stringa vuota = campo assente. Gli agenti riempiono gli opzionali con "" e prima si beccavano
  // un 400 su un campo che non volevano mandare (relazione 30/08/2026, difetto 5.4).
  const outRaw = s(body.output_hash);
  if (outRaw && !hexRe.test(outRaw)) errs.push("output_hash: 32-byte hex if present");
  let meta = null;
  if (body.meta != null) {
    const mj = typeof body.meta === "string" ? body.meta : JSON.stringify(body.meta);
    if (mj.length > MAX_META) errs.push("meta: <=512 chars JSON");
    else { try { meta = JSON.parse(mj); } catch { errs.push("meta: invalid JSON"); } }
  }
  return { errs, action, agent, tool, meta,
    input_hash: s(body.input_hash).replace(/^0x/, "").toLowerCase(),
    output_hash: outRaw ? outRaw.replace(/^0x/, "").toLowerCase() : null };
}

export async function sealAction(env, input, { demo = false, operator = false, payment = null } = {}) {
  if (!env.COHERENCE) return { status: 503, error: "log storage unavailable" };
  if (!env.RLOG_KEY) return { status: 503, error: "log key not armed" };
  const v = validateSealInput(input);
  if (v.errs.length) return { status: 400, error: v.errs.join("; ") };

  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  const payload = {
    v: 1, log: RLOG_ORIGIN, index: N, ts: new Date().toISOString(),
    action: v.action, agent_id: v.agent || null, tool: v.tool || null,
    input_hash: v.input_hash, output_hash: v.output_hash, meta: v.meta,
  };
  if (operator) payload.by = "operator"; // solo il percorso interno puo' impostarlo
  if (payment) payload.payment = payment;  // idem: cio' che il resource server HA VISTO del pagamento
  if (demo) payload.demo = true;
  const canonical = canonicalize(payload);
  const leaf = await leafHash(te.encode(canonical));

  // append: entry + leaf(node 0) + congelamento dei genitori completati
  await env.COHERENCE.put(`rlog:entry:${N}`, canonical);
  await env.COHERENCE.put(nk(0, N), hex(leaf));
  let l = 0, i = N, cur = leaf;
  while (i % 2 === 1) {
    const sib = await getNode(env, l, i - 1);
    cur = await nodeHash(sib, cur);
    l += 1; i = (i - 1) / 2;
    await env.COHERENCE.put(nk(l, i), hex(cur));
  }
  const size = N + 1;
  await env.COHERENCE.put("rlog:size", String(size));

  const root = await treeRoot(env, size);
  const [checkpoint, proof] = await Promise.all([
    signedCheckpoint(env, size, root),
    proofFor(env, N, size),
  ]);
  const kp = parseKey(env.RLOG_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" }, await signer(kp), te.encode("gblin-receipt/v1\n" + canonical)));

  return {
    status: 200,
    receipt: {
      format: "gblin-receipt/v1",
      payload, canonical_sha256: hex(await sha256(te.encode(canonical))),
      leaf: b64(leaf), index: N, tree_size: size, root: b64(root),
      signature: b64(sig),
      verifier_key: await rlogVerifierKey(kp.pub),
      inclusion_proof: proof,
      checkpoint,
      anchor: await anchorInfo(env, N),
      provenance: provenanceFor(payload),
      verify: VERIFY_HINT,
      note: RECEIPT_NOTE,
    },
  };
}

export async function getReceipt(env, index) {
  if (!env.COHERENCE || !env.RLOG_KEY) return { status: 503, error: "log unavailable" };
  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  if (!(index >= 0 && index < N)) return { status: 404, error: "no such receipt" };
  const canonical = await env.COHERENCE.get(`rlog:entry:${index}`);
  if (!canonical) return { status: 404, error: "entry missing" };
  let parsed = null, malformed = false;
  try { parsed = JSON.parse(canonical); } catch { malformed = true; }
  const root = await treeRoot(env, N);
  const [checkpoint, proof] = await Promise.all([signedCheckpoint(env, N, root), proofFor(env, index, N)]);
  const kp = parseKey(env.RLOG_KEY);
  // Ed25519 è deterministica: ri-firmare il canonical dà la stessa firma del seal originale
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" }, await signer(kp), te.encode("gblin-receipt/v1\n" + canonical)));
  return {
    status: 200,
    receipt: {
      format: "gblin-receipt/v1", payload: parsed,
      leaf: b64(await leafHash(te.encode(canonical))), index, tree_size: N, root: b64(root),
      signature: b64(sig),
      verifier_key: await rlogVerifierKey(kp.pub),
      inclusion_proof: proof, checkpoint,
      anchor: await anchorInfo(env, index),
      provenance: provenanceFor(parsed || {}),
      // Questi tre campi c'erano solo nella ricevuta emessa al sigillo, non in quella riletta:
      // chi riceveva una ricevuta da un terzo non aveva il puntatore al verificatore offline
      // ne' l'avvertenza su cosa e' pubblico. La "portabilita'" saltava proprio sul percorso di
      // rilettura (relazione 30/08/2026, difetto 5.2). Non toccano leaf ne' firma: non sono
      // nel payload canonico.
      canonical_sha256: hex(await sha256(te.encode(canonical))),
      verify: VERIFY_HINT,
      note: RECEIPT_NOTE,
      ...(malformed ? { malformed_entry: {
        reason: "This entry was written on 2026-08-21 by a canonicalization bug that emitted a literal `undefined` for an absent field, so its stored record is not valid JSON and cannot be re-derived. The leaf and the tree are untouched; the entry stays in the log because an append-only log is never rewritten. Fixed the same day; entries after index 14 are clean.",
        raw_record: canonical,
      } } : {}),
    },
  };
}

export async function rlogStatus(env) {
  const N = Number((await env.COHERENCE?.get("rlog:size")) || 0);
  let root = null, checkpoint = null, vkey = null;
  if (N > 0 && env.RLOG_KEY) {
    const r = await treeRoot(env, N);
    root = b64(r); checkpoint = await signedCheckpoint(env, N, r);
    vkey = await rlogVerifierKey(parseKey(env.RLOG_KEY).pub);
  } else if (env.RLOG_KEY) {
    vkey = await rlogVerifierKey(parseKey(env.RLOG_KEY).pub);
  }
  return { origin: RLOG_ORIGIN, size: N, root, verifier_key: vkey, checkpoint };
}

// rate-limit demo per IP (KV, TTL 24h)
// La quota demo si CONTROLLA prima e si CONSUMA solo dopo un sigillo riuscito.
// Prima erano la stessa funzione: cinque body sbagliati chiudevano l'IP per la giornata
// senza produrre una sola ricevuta (relazione 30/08/2026, difetto 5.3). Effetto collaterale
// gradito: una put in meno per ogni tentativo fallito, e il budget KV e' stretto.
const demoKey = (ip) => `rlog:demo:${ip}:${new Date().toISOString().slice(0, 10)}`;

export async function demoAllowed(env, ip) {
  const n = Number((await env.COHERENCE.get(demoKey(ip))) || 0);
  return n < DEMO_PER_DAY;
}

export async function demoConsume(env, ip) {
  const k = demoKey(ip);
  const n = Number((await env.COHERENCE.get(k)) || 0);
  await env.COHERENCE.put(k, String(n + 1), { expirationTtl: 90000 });
}

// ---------- verifica di una ricevuta (pure math: NON legge il KV, non si fida del server) ----------
// Ritorna {valid, checks:[{name, ok, detail}], errors:[]}. Stessi 5 controlli di verify-receipt.mjs.
export async function verifyReceipt(input) {
  const r = (input && input.receipt) || input;
  const checks = []; const errors = [];
  const fail = (name, detail) => { checks.push({ name, ok: false, detail }); errors.push(`${name}: ${detail}`); };
  const pass = (name, detail) => checks.push({ name, ok: true, detail });
  const done = () => ({ valid: errors.length === 0, format: r && r.format, index: r && r.index, tree_size: r && r.tree_size, checks, errors,
    reminder: "A valid receipt proves existence and time in the log, not the content or that the action happened. On-chain anchor: see receipt.anchor." });
  try {
    if (!r || typeof r !== "object") { fail("format", "receipt is not an object"); return done(); }
    if (r.format !== "gblin-receipt/v1") { fail("format", `unknown format ${r.format}`); return done(); }
    pass("format", "gblin-receipt/v1");
    const m = /^([^+]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/=]+)$/.exec(r.verifier_key || "");
    if (!m) { fail("verifier_key", "malformed"); return done(); }
    const keyRaw = unb64(m[3]);
    if (keyRaw[0] !== 0x01) { fail("verifier_key", "alg is not Ed25519 note key (0x01)"); return done(); }
    const pub = keyRaw.slice(1);
    const kh = (await sha256(cat(te.encode(m[1] + "\n"), keyRaw))).slice(0, 4);
    if (hex(kh) !== m[2]) { fail("verifier_key", "key hash mismatch"); return done(); }
    pass("verifier_key", `${m[1]} (${m[2]})` + (m[1] === RLOG_ORIGIN ? "" : " — NOTE: not the GBLIN log origin"));
    const canonical = canonicalize(r.payload);
    const leaf = await leafHash(te.encode(canonical));
    if (b64(leaf) !== r.leaf) fail("leaf", "leaf hash does not match canonical payload"); else pass("leaf", "SHA256(0x00 || canonical(payload))");
    const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
    if (!r.signature) fail("signature", "missing (re-fetch from /v1/receipt/:index)");
    else if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(r.signature), te.encode("gblin-receipt/v1\n" + canonical)))) fail("signature", "invalid");
    else pass("signature", "Ed25519 over gblin-receipt/v1 + canonical payload");
    const size = Number(r.tree_size); const idx = Number(r.index);
    if (!Array.isArray(r.inclusion_proof) || !(idx >= 0 && idx < size)) fail("inclusion_proof", "missing proof or index out of range");
    else {
      const proof = r.inclusion_proof.map(unb64); const order = [];
      const collect = (i, a, b) => { if (b - a === 1) return; let k = 1; while (k * 2 < b - a) k *= 2; if (i < a + k) { collect(i, a, a + k); order.push(["R", a + k, b]); } else { collect(i, a + k, b); order.push(["L", a, a + k]); } };
      collect(idx, 0, size);
      if (order.length !== proof.length) fail("inclusion_proof", `length ${proof.length} != expected ${order.length}`);
      else {
        let cur = leaf;
        for (let j = 0; j < order.length; j++) cur = order[j][0] === "R" ? await nodeHash(cur, proof[j]) : await nodeHash(proof[j], cur);
        if (b64(cur) !== r.root) fail("inclusion_proof", "does not reach the stated root"); else pass("inclusion_proof", `leaf #${idx} -> root of tree size ${size}`);
      }
    }
    const note = r.checkpoint || "";
    const sep = note.indexOf("\n\n");
    if (sep < 0) fail("checkpoint", "missing or malformed note");
    else {
      const body = note.slice(0, sep + 1); const lines = body.split("\n");
      if (lines[0] !== m[1]) fail("checkpoint", "origin mismatch");
      else if (Number(lines[1]) !== size) fail("checkpoint", "size != receipt tree_size");
      else if (lines[2] !== r.root) fail("checkpoint", "root != receipt root");
      else {
        const sigLine = note.slice(sep + 2).split("\n").find((l) => l.startsWith("\u2014 " + m[1] + " "));
        const ps = sigLine ? unb64(sigLine.split(" ")[2]) : null;
        if (!ps || ps.length !== 68 || hex(ps.slice(0, 4)) !== m[2]) fail("checkpoint", "no valid signature line for origin");
        else if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, ps.slice(4), te.encode(body)))) fail("checkpoint", "signature invalid");
        else pass("checkpoint", "C2SP signed note valid and consistent with receipt");
      }
    }
  } catch (e) { fail("exception", String(e && e.message || e)); }
  return done();
}

// Anchor consistency (needs KV): does the root we anchored on-chain equal the root this log
// recomputes for that tree size today? A mismatch would mean the log was rewritten.
export async function anchorConsistency(env) {
  let last = null;
  try { last = JSON.parse((await env.COHERENCE.get("rlog:anchorLast")) || "null"); } catch { last = null; }
  if (!last) return { anchor_found: false, anchor_root_matches: null, anchored_tree_size: null, anchor_tx: null };
  const root = b64(await treeRoot(env, last.size));
  return { anchor_found: true, anchor_root_matches: root === last.root, anchored_tree_size: last.size, anchor_tx: last.hash, anchor_day: last.day };
}
