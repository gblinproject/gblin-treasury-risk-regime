// Tests for the facilitator compatibility canary: the unpaid challenge must carry the control
// route's payment requirements and no discovery extension, and a paid request must reach the
// facilitator's /verify endpoint only, never /settle.
//
//   node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { x402Canary, CANARY_REQUIREMENTS, CANARY_URL, CANARY_FACILITATOR } from "../src/x402canary.mjs";

const source = readFileSync(new URL("../src/x402-challenge.mjs", import.meta.url), "utf8");
const control = JSON.parse(JSON.parse(source.match(/"x402\/attestation": \{\s*challenge: (".*?"),\n/)[1]));

const req = (headers = {}, method = "GET") => new Request(CANARY_URL, { method, headers });
const b64 = (o) => btoa(JSON.stringify(o));

function recorder(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  return { calls, impl };
}

test("unpaid request: 402 with the control route's requirements and no extensions", async () => {
  const res = await x402Canary(req());
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.deepEqual(body.accepts, control.accepts);
  assert.deepEqual(body.accepts[0], CANARY_REQUIREMENTS);
  assert.equal(body.extensions, undefined);
  assert.equal(body.resource.url, CANARY_URL);
  assert.deepEqual(JSON.parse(atob(res.headers.get("payment-required"))), body);
});

test("valid authorization: 200, verify only, settled false", async () => {
  const r = recorder({ status: 200, body: { isValid: true, payer: "0x1" } });
  const payload = { x402Version: 2, payload: { signature: "0xabc" } };
  const res = await x402Canary(req({ "payment-signature": b64(payload) }), r.impl);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.settled, false);
  assert.equal(body.verify.isValid, true);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, CANARY_FACILITATOR + "/verify");
  assert.deepEqual(r.calls[0].body, { x402Version: 2, paymentPayload: payload, paymentRequirements: CANARY_REQUIREMENTS });
});

test("invalid authorization: 402 with the facilitator's reason", async () => {
  const r = recorder({ status: 400, body: { isValid: false, invalidReason: "invalid_signature" } });
  const res = await x402Canary(req({ "x-payment": b64({ x402Version: 2 }) }), r.impl);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.verify.invalidReason, "invalid_signature");
  assert.equal(body.http_status, 400);
  assert.ok(res.headers.get("payment-required"));
});

test("malformed header: 400 without contacting the facilitator", async () => {
  const r = recorder({ status: 200, body: {} });
  const res = await x402Canary(req({ "payment-signature": "%%%not-base64" }), r.impl);
  assert.equal(res.status, 400);
  assert.equal(r.calls.length, 0);
});

test("facilitator unreachable: 502, settled false", async () => {
  const r = recorder(new TypeError("network"));
  const res = await x402Canary(req({ "payment-signature": b64({ x402Version: 2 }) }), r.impl);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).settled, false);
});

test("the module never references the settle endpoint", () => {
  const code = readFileSync(new URL("../src/x402canary.mjs", import.meta.url), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/\/settle/.test(code));
});
