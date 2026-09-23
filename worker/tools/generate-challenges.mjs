/**
 * Generates src/x402-challenge.mjs from the golden fixtures of the two projects that sell
 * over x402.
 *
 * Why a generator and not a hand-written file: those bytes are the public contract indexed
 * by the x402 catalogues, and they must be IDENTICAL to the ones served by the origin. A
 * hand-written module can silently drift away from the fixtures.
 *
 * Sources (sibling checkouts of the two projects):
 *   ../../GBLIN_WEBAPP/test/x402-golden/    -> 9 paths /api/x402/<name>
 *   ../../GBLIN-Sentinel/test/x402-golden/  -> 4 paths /api/data/<name>
 *
 * Usage: cd worker && node tools/generate-challenges.mjs && npx wrangler deploy
 * Then:  run verify.mjs in BOTH golden directories, to confirm that edge and origin still
 *        answer the same bytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const WEBAPP = resolve(here, "../../../GBLIN_WEBAPP/test/x402-golden");
const SENTINEL = resolve(here, "../../../GBLIN-Sentinel/test/x402-golden");
const OUTPUT = resolve(here, "../src/x402-challenge.mjs");

// THE FOUR PARAMETER-GUARDED PATHS ARE NOT A SPECIAL CASE ANY MORE: the code that handled
// them apart was removed together with the *.paid-params.json fixtures it used to read.
// The parameter guard is now tied to the presence of a payment header: an anonymous caller
// always receives the 402 challenge (it used to be a 400, which is why the Coinbase validator
// rejected those paths and they stayed out of the Bazaar catalogue), while a paying caller
// with wrong parameters gets the 400 from the ORIGIN, before verify/settle. Only requests
// without a payment header reach the edge: the 400 is not needed here and all nine paths
// behave alike.

const readFixture = (dir, file) => JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));

function webappEntries() {
  const names = ["attestation", "catalog", "governance", "seal", "treasury-state", "quote", "jit", "invest", "health"];
  return names.map((name) => {
    const base = readFixture(WEBAPP, `${name}.json.json`);
    const entry = { key: `x402/${name}` };
    // seal answers 402 on POST only: its fixture must be captured with that verb (capture.mjs).
    if (base.status !== 402) throw new Error(`${name}: expected the 402 challenge, found ${base.status}` +
      (name === "seal" ? " — seal is POST-only: its fixture must be captured with POST" : ""));
    entry.challenge = base.body;
    entry.paymentRequired = base.headers["payment-required"];
    if (!entry.paymentRequired) throw new Error(`${name}: the fixture has no payment-required header`);
    return entry;
  });
}

function sentinelEntries() {
  const names = ["risk-pulse-pro", "base-risk-pulse", "gblin-analytics", "keeper-opps"];
  return names.map((name) => {
    const base = readFixture(SENTINEL, `${name}.json.json`);
    if (base.status !== 402) throw new Error(`sentinel/${name}: expected 402, found ${base.status}`);
    if (!base.headers["payment-required"]) throw new Error(`sentinel/${name}: no payment-required header`);
    return { key: `data/${name}`, challenge: base.body, paymentRequired: base.headers["payment-required"] };
  });
}

const entries = [...webappEntries(), ...sentinelEntries()];

const pathsBody = entries
  .map((v) => {
    const lines = [`  ${JSON.stringify(v.key)}: {`];
    lines.push(`    challenge: ${JSON.stringify(v.challenge)},`);
    lines.push(`    paymentRequired: ${JSON.stringify(v.paymentRequired)},`);
    lines.push("  },");
    return lines.join("\n");
  })
  .join("\n");

const moduleSource = `// ANONYMOUS x402 challenges served from the edge, so that no Vercel function is invoked.
//
// Why: the x402 middleware answering 402 to crawlers and probes (~6,000 requests a day)
// accounted for 91 per cent of the billed Vercel CPU. The middleware runs BEFORE the cache,
// so no cache can reduce it, and on Vercel 402 is not a cacheable status. A Project Routing
// Rule rewrites to this module every request that does NOT carry a payment header; a paying
// request does not match the rule and continues on the real pipeline, where payment
// verification remains the only authority that moves money.
//
// Two projects, two families of paths:
//  - gblin.digital             /api/x402/<name>  (9 paths)
//  - gblin-sentinel.vercel.app /api/data/<name>  (4 paths)
// All nine paths of the first family behave the same way: without payment they answer the
// 402 challenge. Previously quote/jit/invest/health answered 400 when the parameters were
// missing, and that 400 kept them out of the Bazaar catalogue (the CDP validator rejects
// them: "returned HTTP 400 instead of 402"). The guard now lives only on the PAYING path,
// which does not go through the edge.
// The challenge does NOT depend on the value of the parameters (two quote requests with a
// different amount produce identical bytes), so it can be served statically.
//
// CONSTRAINT: these bytes are the public contract indexed by the x402 catalogues, and they
// mirror the golden fixtures of the two source projects.
// GENERATED FILE — do not edit it by hand: regenerate it with
//   cd worker && node tools/generate-challenges.mjs
// otherwise edge and origin publish different terms. Running verify.mjs detects that.

const PATHS = {
${pathsBody}
};

// When Vercel rewrites to an external URL it forwards the ORIGINAL request path, not the one
// written in the destination: both /api/x402/... and /x402/... are accepted (and likewise for
// /api/data/...), so this module also answers when it is queried directly. Getting this wrong
// produces a 404 from here that looks like a Vercel 404.
function nameFromPath(pathname) {
  const m = pathname.match(/^\\/(?:api\\/)?((?:x402|data)\\/[a-z0-9-]+)\\/?$/);
  return m && PATHS[m[1]] ? m[1] : null;
}

const json = (body, status, extra = {}) => new Response(body, {
  status,
  headers: {
    "content-type": "application/json",
    "cache-control": "public, max-age=60, s-maxage=300",
    "x-gblin-edge-challenge": "1",
    "access-control-allow-origin": "*",
    ...extra,
  },
});

// Paths that accept a single verb. The body must stay IDENTICAL to the one returned by the
// origin route for that path: if it changes there, it must change here. Reason it exists: with
// a path-only key the payment was settled on ANY method, so a paid GET ended on a 405 — the
// caller paid and got nothing.
const SOLO_POST = new Set(["x402/seal"]);
const SOLO_POST_BODY = JSON.stringify({
  error: "POST only",
  how: "POST JSON {action, input_hash, output_hash?, agent_id?, tool?, meta?} with x402 payment ($0.0045). Free demo (5/day/IP): POST https://gblin-mcp.gblin-mcp-worker.workers.dev/v1/seal-demo. Docs: /api/x402/llms.txt",
});

export function x402StaticChallenge(request) {
  const url = new URL(request.url);
  const name = nameFromPath(url.pathname);
  if (!name) return null; // not a path served here: the caller decides what to do
  const p = PATHS[name];

  // Safety net: a request arriving here WITH a payment must NOT be answered with the
  // challenge — that would turn away a paying caller. Better to say so plainly than to pretend.
  if (request.headers.get("x-payment") || request.headers.get("payment-signature")) {
    return json(JSON.stringify({
      error: "this edge path serves the unpaid challenge only; a request carrying payment must reach the origin",
    }), 421, { "cache-control": "no-store" });
  }

  // seal accepts POST ONLY. Outside POST the origin no longer asks for payment and answers
  // 405: the edge must say the same. OPTIONS is excluded, the CORS branch serves it.
  if (SOLO_POST.has(name) && request.method !== "POST") {
    if (request.method === "OPTIONS") return null;
    return json(SOLO_POST_BODY, 405, { "allow": "POST", "cache-control": "public, max-age=300" });
  }

  return json(withMethod(p.challenge, request.method), 402, {
    "payment-required": headerWithMethod(p.paymentRequired, request.method),
  });
}

export const EDGE_CHALLENGE_PATHS = Object.keys(PATHS);

// The origin ECHOES the request method inside the challenge, in two places of the Bazaar
// metadata. Measured: between GET and POST only those two fields change (attestation 2369 vs
// 2371 bytes, governance 2187 vs 2189, treasury-state 1830 vs 1832) and the other challenges
// do not name the method at all. The golden fixtures are captured on GET: the real method is
// put back here, so the edge stays byte-identical to the origin outside GET too.
function withMethod(body, method) {
  if (method === "GET" || method === "HEAD") return body;
  if (!/^[A-Z]{3,10}$/.test(method)) return body; // unusual method: serve the GET challenge
  return body
    .split('"method":"GET"').join('"method":"' + method + '"')
    .split('"enum":["GET"]').join('"enum":["' + method + '"]');
}

// The same method echo applies to the payment-required header, which is the challenge body in
// base64: it has to be decoded, substituted and re-encoded. The substitution runs on the binary
// string returned by atob, not on the UTF-8 decoded text: the two fragments being replaced are
// pure ASCII, so the multibyte bytes (the em dashes in the descriptions) that btoa could not
// re-encode stay intact.
function headerWithMethod(b64, method) {
  if (method === "GET" || method === "HEAD") return b64;
  if (!/^[A-Z]{3,10}$/.test(method)) return b64;
  let bin;
  try { bin = atob(b64); } catch { return b64; }
  const out = bin
    .split('"method":"GET"').join('"method":"' + method + '"')
    .split('"enum":["GET"]').join('"enum":["' + method + '"]');
  try { return btoa(out); } catch { return b64; }
}
`;

writeFileSync(OUTPUT, moduleSource);
console.log(`Generated ${OUTPUT}`);
console.log(`  ${entries.length} paths: ${entries.map((v) => v.key).join(", ")}`);
