// Tests for the c2sp.org/tlog-witness side of the witness (POST add-checkpoint and the
// monitoring endpoint). The vectors in witness-vectors/vectors.json are generated with the
// reference Go implementation (golang.org/x/mod/sumdb); see witness-vectors/main.go.
// Every 200 response is checked with an independent Ed25519 verification (node:crypto).
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { witnessAddCheckpoint, witnessCheckpointByOriginHash, verifyConsistency } from "../src/witness.mjs";

const vectors = JSON.parse(readFileSync(new URL("./witness-vectors/vectors.json", import.meta.url), "utf8"));
const WITNESS_NAME = "gblin.digital/witness";
const pause = () => new Promise((r) => setTimeout(r, Math.random() * 3));

// In-memory stand-ins for the Workers KV and D1 bindings. Reads and writes yield to the event
// loop, so concurrent requests interleave as they do on the platform.
function kv() {
  const m = new Map();
  return {
    get: async (k, type) => { await pause(); const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    put: async (k, v) => { await pause(); m.set(k, String(v)); },
    delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}
function d1() {
  const db = new DatabaseSync(":memory:");
  return {
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async first() { await pause(); return db.prepare(sql).get(...args) ?? null; },
        async all() { await pause(); return { results: db.prepare(sql).all(...args) }; },
        async run() { await pause(); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      };
      return st;
    },
    async exec(sql) { db.exec(sql); return {}; },
  };
}
async function freshEnv() {
  const env = { COHERENCE: kv(), USAGE: d1(), WITNESS_KEY: vectors.witnessKey };
  await env.COHERENCE.put("witness:netcfg", vectors.netcfg);
  return env;
}

const pub = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(vectors.witnessPub, "hex")]),
  format: "der", type: "spki",
});
const keyId = crypto.createHash("sha256")
  .update(Buffer.concat([Buffer.from(`${WITNESS_NAME}\n\x04`), Buffer.from(vectors.witnessPub, "hex")]))
  .digest().subarray(0, 4);

// Checks one cosignature line (c2sp.org/tlog-cosignature, Ed25519 v1) over `text`.
function assertCosignature(line, text) {
  const prefix = `— ${WITNESS_NAME} `;
  assert.ok(line.startsWith(prefix), `unexpected line: ${line}`);
  const raw = Buffer.from(line.slice(prefix.length), "base64");
  assert.equal(raw.length, 4 + 8 + 64);
  assert.deepEqual(raw.subarray(0, 4), keyId);
  const ts = raw.readBigUInt64BE(4);
  const ok = crypto.verify(null, Buffer.from(`cosignature/v1\ntime ${ts}\n${text}`), pub, raw.subarray(12));
  assert.ok(ok, "cosignature does not verify");
}

async function run(env, step) {
  if (step.method === "GET") {
    const id = step.path.split("/")[2];
    const note = await witnessCheckpointByOriginHash(env, id);
    return note ? { status: 200, body: note } : { status: 404, body: "not found\n" };
  }
  return witnessAddCheckpoint(env, step.body);
}

test("add-checkpoint and monitoring follow the vectors in order", async (t) => {
  const env = await freshEnv();
  for (const step of vectors.steps) {
    await t.test(step.name, async () => {
      const r = await run(env, step);
      assert.equal(r.status, step.status, `body: ${r.body}`);
      if (step.expectBody !== undefined) assert.equal(r.body, step.expectBody);
      if (step.expectType !== undefined) assert.equal(r.type, step.expectType);
      if (step.cosignedText) {
        assert.ok(r.body.endsWith("\n") && !r.body.slice(0, -1).includes("\n"), "expected one newline-terminated line");
        assertCosignature(r.body.slice(0, -1), step.cosignedText);
      }
      if (step.method === "GET" && step.status === 200) {
        const sep = r.body.lastIndexOf("\n\n");
        const text = r.body.slice(0, sep + 1);
        assert.ok(text.startsWith(`${vectors.origin}\n${step.expectSize ?? 0}\n`));
        const own = r.body.slice(sep + 2).split("\n").filter((l) => l.startsWith(`— ${WITNESS_NAME} `));
        assert.equal(own.length, 1, "exactly one cosignature from this witness");
        assertCosignature(own[0], text);
      }
    });
  }
});

test("concurrent requests with the same old size: exactly one is cosigned", async () => {
  for (let round = 0; round < 20; round++) {
    const env = await freshEnv();
    for (const step of vectors.steps) if (step.method !== "GET") await run(env, step);
    const results = await Promise.all(vectors.raceBodies.map((b) => witnessAddCheckpoint(env, b)));
    const winners = results.map((r, i) => [r, i]).filter(([r]) => r.status === 200);
    assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.status)));
    const size = vectors.raceSizes[winners[0][1]];
    for (const r of results) if (r.status !== 200) {
      assert.equal(r.status, 409);
      assert.equal(r.body, `${size}\n`);
    }
    const served = await witnessCheckpointByOriginHash(env, vectors.originHash);
    assert.ok(served.startsWith(`${vectors.origin}\n${size}\n`));
  }
});

test("an unarmed witness answers 503", async () => {
  const r = await witnessAddCheckpoint({ COHERENCE: kv() }, vectors.steps[0].body);
  assert.equal(r.status, 503);
});

test("consistency verification rejects a tampered proof at every position", async () => {
  // RFC 6962 trees of 1..24 leaves built here; proofs computed with the SUBPROOF algorithm.
  const H = (...p) => new Uint8Array(crypto.createHash("sha256").update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest());
  const leaf = (i) => H([0], Buffer.from(`leaf-${i}`));
  const mth = (a, b) => {
    if (b - a === 1) return leaf(a);
    let k = 1; while (k * 2 < b - a) k *= 2;
    return H([1], mth(a, a + k), mth(a + k, b));
  };
  const subproof = (m, a, b, complete) => {
    const n = b - a;
    if (m === n) return complete ? [] : [mth(a, b)];
    let k = 1; while (k * 2 < n) k *= 2;
    return m <= k ? [...subproof(m, a, a + k, complete), mth(a + k, b)] : [...subproof(m - k, a + k, b, false), mth(a, a + k)];
  };
  for (let n = 2; n <= 24; n++) for (let m = 1; m < n; m++) {
    const proof = subproof(m, 0, n, true);
    assert.ok(await verifyConsistency(m, n, mth(0, m), mth(0, n), proof), `${m} -> ${n}`);
    for (let i = 0; i < proof.length; i++) {
      const bad = proof.map((h) => h.slice());
      bad[i][0] ^= 1;
      assert.equal(await verifyConsistency(m, n, mth(0, m), mth(0, n), bad), false, `${m} -> ${n} at ${i}`);
    }
    assert.equal(await verifyConsistency(m, n, mth(0, m), mth(0, n), proof.slice(0, -1)), false);
    assert.equal(await verifyConsistency(m, n, mth(0, m), mth(0, n), [...proof, mth(0, 1)]), false);
  }
});
