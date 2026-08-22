#!/usr/bin/env node
// verify-receipt.mjs — offline verifier for GBLIN AI Action Receipts.
// Zero dependencies (Node 18+). You do NOT need to trust gblin.digital:
// this script re-derives everything from the receipt JSON itself.
//
//   node verify-receipt.mjs receipt.json
//   curl -s https://gblin-mcp.gblin-mcp-worker.workers.dev/v1/receipt/0 | node verify-receipt.mjs /dev/stdin
//
// Checks: (1) canonical payload → leaf hash (RFC 6962, 0x00 prefix);
// (2) Ed25519 receipt signature over "gblin-receipt/v1\n"+canonical;
// (3) inclusion proof leaf→root (0x01 prefix);
// (4) checkpoint note signature (C2SP) over origin/size/root by the SAME key;
// (5) key hash inside the verifier_key matches name+alg+pubkey.
// The daily EAS anchor on Base can be checked independently on base.easscan.org
// (schema 0x9f433a96..., promiseId keccak256("gblin-receipts-log")).

import { readFileSync } from "fs";
import { webcrypto as crypto } from "crypto";

const die = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (m) => console.log("  ✓", m);
const b64 = (u8) => Buffer.from(u8).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const te = new TextEncoder();
const cat = (...p) => { const n=p.reduce((a,x)=>a+x.length,0); const o=new Uint8Array(n); let i=0; for(const x of p){o.set(x,i);i+=x.length;} return o; };
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));

function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

const file = process.argv[2] || die("usage: node verify-receipt.mjs receipt.json");
const r = JSON.parse(readFileSync(file, "utf8"));
const receipt = r.receipt || r; // accept either the bare receipt or an API wrapper
if (receipt.format !== "gblin-receipt/v1") die("unknown format: " + receipt.format);

// (5) verifier key structure
const m = /^([^+]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/=]+)$/.exec(receipt.verifier_key) || die("bad verifier_key");
const keyRaw = unb64(m[3]);
if (keyRaw[0] !== 0x01) die("verifier_key alg is not Ed25519 note key (0x01)");
const pub = keyRaw.slice(1);
const kh = (await sha256(cat(te.encode(m[1] + "\n"), keyRaw))).slice(0, 4);
if (Buffer.from(kh).toString("hex") !== m[2]) die("verifier_key hash mismatch");
ok(`verifier key: ${m[1]} (${m[2]})`);

// (1) canonical → leaf
const canonical = canonicalize(receipt.payload);
const leaf = await sha256(cat(Uint8Array.of(0x00), te.encode(canonical)));
if (b64(leaf) !== receipt.leaf) die("leaf hash does not match canonical payload");
ok("leaf = SHA256(0x00 || canonical(payload))");

// (2) receipt signature — REQUIRED (both /v1/seal* and /v1/receipt return it)
const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
if (!receipt.signature) die("receipt has no signature (re-fetch it from /v1/receipt/:index)");
{
  const good = await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(receipt.signature), te.encode("gblin-receipt/v1\n" + canonical));
  if (!good) die("receipt signature invalid");
  ok("receipt Ed25519 signature valid");
}

// (3) inclusion proof — rebuild leaf→root walking the RFC 6962 recursion order
const size = receipt.tree_size;
{
  const proof = receipt.inclusion_proof.map(unb64);
  const order = [];
  const collect = (i, a, b) => { if (b - a === 1) return; let k=1; while (k*2 < b-a) k*=2; if (i < a+k) { collect(i,a,a+k); order.push(["R",a+k,b]); } else { collect(i,a+k,b); order.push(["L",a,a+k]); } };
  collect(receipt.index, 0, size);
  if (order.length !== proof.length) die(`proof length ${proof.length} != expected ${order.length}`);
  let cur = leaf;
  for (let j = 0; j < order.length; j++) {
    cur = order[j][0] === "R" ? await sha256(cat(Uint8Array.of(0x01), cur, proof[j])) : await sha256(cat(Uint8Array.of(0x01), proof[j], cur));
  }
  if (b64(cur) !== receipt.root) die("inclusion proof does not reach the stated root");
}
ok(`inclusion proof: leaf #${receipt.index} → root of tree size ${size}`);

// (4) checkpoint note
const note = receipt.checkpoint || die("no checkpoint in receipt");
const sep = note.indexOf("\n\n");
const body = note.slice(0, sep + 1);
const lines = body.split("\n");
if (lines[0] !== m[1]) die("checkpoint origin mismatch");
if (Number(lines[1]) !== size) die("checkpoint size != receipt tree_size");
if (lines[2] !== receipt.root) die("checkpoint root != receipt root");
const sigLine = note.slice(sep + 2).split("\n").find((l) => l.startsWith("— " + m[1] + " ")) || die("no signature line for origin");
const payloadSig = unb64(sigLine.split(" ")[2]);
if (payloadSig.length !== 68) die("bad checkpoint sig payload");
if (Buffer.from(payloadSig.slice(0, 4)).toString("hex") !== m[2]) die("checkpoint keyhash mismatch");
const goodCp = await crypto.subtle.verify({ name: "Ed25519" }, key, payloadSig.slice(4), te.encode(body));
if (!goodCp) die("checkpoint signature invalid");
ok("checkpoint (C2SP signed note) valid and consistent with receipt");

console.log(`\nPASS — receipt #${receipt.index} verified offline.`);
console.log(`Action: ${receipt.payload.action}${receipt.payload.demo ? " (DEMO)" : ""} · ${receipt.payload.ts}`);
// Il pagamento, se il record lo porta. E' l'unica parte OSSERVATA dal server: gli hash
// dell'azione restano dichiarati da chi ha sigillato. Il nonce serve a ritrovare da soli il
// regolamento on-chain (USDC su Base emette AuthorizationUsed(authorizer, nonce)).
const pay = receipt.payload.payment;
if (pay) {
  const amt = pay.amount ? `${pay.amount} units of ${pay.asset ?? "the asset"}` : "amount not recorded";
  console.log(`Payment observed by the server: ${amt}${pay.payer ? ` from ${pay.payer}` : ""}${pay.network ? ` on ${pay.network}` : ""}.`);
  if (pay.authorization_nonce && pay.payer) {
    console.log(`  Find the settlement yourself: USDC AuthorizationUsed(authorizer=${pay.payer}, nonce=${pay.authorization_nonce}).`);
  }
  console.log("  This is evidence about the PAYMENT only. The sealed action and its hashes remain self-reported.");
}
console.log("Reminder: a seal proves existence and time. It does not certify the content.");
