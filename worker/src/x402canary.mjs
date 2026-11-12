// Facilitator compatibility canary.
//
// One x402 route that exists only to compare an alternative facilitator against the direct
// payment path, without moving funds and without touching any route that is indexed or under
// a published promise.
//
//  - Without payment it answers 402 with the same payment requirements as the control route
//    (https://gblin.digital/api/x402/attestation): same scheme, network, asset, amount, payTo
//    and timeout. It carries no discovery extension, so no catalogue indexes it.
//  - With a payment header it forwards the payload to the facilitator's /verify endpoint and
//    returns the facilitator's answer together with the measured latency.
//  - It NEVER calls /settle and never returns a paid resource. A valid authorization is
//    verified and then discarded: no transfer is submitted, so nothing is charged.

export const CANARY_PATH = "/canary/attestation";
export const CANARY_URL = "https://mcp.gblin.digital" + CANARY_PATH;
export const CANARY_FACILITATOR = "https://api.xguardgate.com";
export const CONTROL_URL = "https://gblin.digital/api/x402/attestation";

const VERIFY_TIMEOUT_MS = 10000;
const MAX_PAYMENT_HEADER = 8192;

// Identical to accepts[0] of the control route's challenge.
export const CANARY_REQUIREMENTS = Object.freeze({
  scheme: "exact",
  network: "eip155:8453",
  amount: "3000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x0ebA5d314F4f5Dcb7A094953Fa9311a45172dd1B",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
});

const CHALLENGE = JSON.stringify({
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: CANARY_URL,
    description: "Facilitator compatibility canary. Payments are verified with the facilitator named in gblin_info and never settled; no resource is returned.",
    mimeType: "application/json",
  },
  accepts: [CANARY_REQUIREMENTS],
  gblin_info: {
    control: CONTROL_URL,
    facilitator: CANARY_FACILITATOR,
    settles: false,
  },
});

const headers = (extra = {}) => ({
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  ...extra,
});

const reply = (body, status, extra) => new Response(JSON.stringify(body), { status, headers: headers(extra) });

function decodePayment(value) {
  if (value.length > MAX_PAYMENT_HEADER) return { error: "payment header too large" };
  try {
    const bin = atob(value.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { error: "payment payload is not a JSON object" };
    return { payload };
  } catch {
    return { error: "payment header is not base64-encoded JSON" };
  }
}

export function isCanaryPath(pathname) {
  return pathname === CANARY_PATH || pathname === CANARY_PATH + "/";
}

export async function x402Canary(request, fetchImpl = fetch) {
  const paymentHeader = request.headers.get("payment-signature") || request.headers.get("x-payment");

  if (!paymentHeader) {
    return new Response(CHALLENGE, {
      status: 402,
      headers: headers({ "payment-required": btoa(CHALLENGE) }),
    });
  }

  const decoded = decodePayment(paymentHeader);
  if (decoded.error) return reply({ error: decoded.error, settled: false }, 400);

  const body = JSON.stringify({
    x402Version: decoded.payload.x402Version ?? 2,
    paymentPayload: decoded.payload,
    paymentRequirements: CANARY_REQUIREMENTS,
  });

  const started = Date.now();
  let status = 0;
  let result = null;
  let failure = null;
  try {
    const res = await fetchImpl(CANARY_FACILITATOR + "/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try { result = JSON.parse(text); } catch { result = { raw: text.slice(0, 2000) }; }
  } catch (e) {
    failure = e && e.name === "TimeoutError" ? "verify timed out" : "verify request failed";
  }
  const latencyMs = Date.now() - started;

  const out = {
    facilitator: CANARY_FACILITATOR,
    endpoint: "/verify",
    http_status: status,
    latency_ms: latencyMs,
    verify: result,
    settled: false,
  };
  if (failure) {
    out.error = failure;
    return reply(out, 502);
  }
  // A valid authorization is reported with 200; anything else repeats the 402, as a paid route
  // would. In neither case is the authorization settled.
  const valid = !!(result && result.isValid === true);
  return reply(out, valid ? 200 : 402, valid ? {} : { "payment-required": btoa(CHALLENGE) });
}
