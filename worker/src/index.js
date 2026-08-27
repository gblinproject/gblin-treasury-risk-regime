/**
 * GBLIN MCP over Streamable HTTP — Cloudflare Worker (free plan).
 *
 * WHY THIS EXISTS: the npm server (@gblin-protocol/mcp-server) is stdio-only —
 * hosted agents and URL-based registries (Smithery) need an HTTPS endpoint.
 * This Worker is the HTTP twin: a STATELESS Streamable HTTP MCP server with
 * the light, free, read-only tools. It sells nothing and holds no keys; the
 * paid data stays on the x402 endpoints (gblin.digital), which this server
 * points buyers to.
 *
 * Design constraints (Workers free plan):
 *   - 100k requests/day, 10 ms CPU per invocation. All tools are either
 *
 * 14/08/2026: aggiunto l'OSSERVATORIO DEL CATALOGO (src/catalog.mjs) — sonde a
 * rotazione sulle top-200 risorse del discovery x402, vista free su /catalog,
 * feed completo via token per la webapp (che lo vende via x402). Il giro di
 * sonde SALTA il tick del sigillo giornaliero per stare nei 50 subrequest.
 *     cached upstream fetches (I/O, ~0 CPU) or tiny hex parsing.
 *   - Stateless: no sessions, no SSE stream, one JSON response per POST.
 *     Every JSON-RPC exchange is self-contained (spec-permitted mode).
 *   - Zero dependencies: the JSON-RPC handling is ~100 lines, hand-rolled,
 *     so there is no bundler and no supply chain.
 *   - Kill switch: env.MCP_DISABLED = "true" → 503 for everything.
 *   - Best-effort per-IP rate limit (per isolate): 60 req/min.
 */

import { catalogTick, catalogReport, catalogFull, observatoryPage, observatoryJson, observatoryBadge } from "./catalog.mjs";
// 18/08/2026: WITNESS (src/witness.mjs) — cofirma i checkpoint di log di
// trasparenza terzi (C2SP tlog-cosignature v1). Primo log: markovianprotocol.com,
// su loro invito. Zero costo: 1 lettura + 1 firma per tick; niente chain.
// Secret WITNESS_KEY assente → disattivato in silenzio (fail-safe).
import { witnessTick, witnessIndex, witnessLatestNote, witnessAddCheckpoint, witnessHistory, witnessDiscoverLogs, witnessConfiguredLogs, WITNESSED_LOGS } from "./witness.mjs";
import { x402StaticChallenge } from "./x402-challenge.mjs";
import { incidentFor, incidentResponse } from "./incidents.mjs";
import { contaChiamata, metodoNoto, scarica, scaricoDifferito, usoRecente } from "./mcpusage.mjs";
import { sealAction, getReceipt, rlogStatus, demoAllowed, treeRoot, signedCheckpoint, proofFor, verifyReceipt, anchorConsistency, consistencyProof, leaves, pushToWitnesses, witnessState, PROVENANCE_LEVELS, RLOG_ORIGIN } from "./rlog.mjs";

const GBLIN = "0x36C81d7E1966310F305eA637e761Cf77F90852f0";
const BASKET_SELECTOR = "0x8c7e0875"; // basket(uint256)
// Multiple public RPCs: some (e.g. mainnet.base.org) reject requests coming
// from Cloudflare's datacenter IPs, so the first reachable one wins.
const FALLBACK_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://1rpc.io/base",
  "https://mainnet.base.org",
];
const SITE = "https://gblin.digital";
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "gblin-mcp-http", version: "0.7.1" };

// ── Tools ───────────────────────────────────────────────────────────────────

// All tools are read-only, idempotent within their cache TTL, and touch the
// open world (public chain + public HTTP endpoints) — declared via annotations.
const RO = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    format: { type: "string", const: "gblin-receipt/v1" },
    payload: {
      type: "object",
      description: "The signed, canonicalized record (gblin-canonical-json/1)",
      properties: {
        v: { type: "integer" }, log: { type: "string" }, index: { type: "integer" }, ts: { type: "string" },
        action: { type: "string" }, agent_id: { type: ["string", "null"] }, tool: { type: ["string", "null"] },
        input_hash: { type: "string" }, output_hash: { type: ["string", "null"] }, meta: {}, demo: { type: "boolean" },
        by: { type: "string", enum: ["operator"], description: "Present only when this server sealed its own action; set server-side, cannot be supplied by a caller" },
      },
      required: ["v", "log", "index", "ts", "action", "input_hash"],
    },
    leaf: { type: "string", description: "base64 SHA256(0x00 || canonical)" },
    index: { type: "integer" }, tree_size: { type: "integer" },
    root: { type: "string", description: "base64 Merkle root at tree_size" },
    signature: { type: "string", description: "base64 Ed25519 over 'gblin-receipt/v1\\n' + canonical" },
    verifier_key: { type: "string", description: "C2SP note verifier key: origin+hash+base64(0x01||pub)" },
    inclusion_proof: { type: "array", items: { type: "string" } },
    checkpoint: { type: "string", description: "C2SP signed note (origin, size, root)" },
    anchor: {
      type: "object",
      description: "Latest daily EAS anchor of the tree root on Base and whether it already covers this receipt",
      properties: {
        chain: { type: "string" }, method: { type: "string" }, eas_schema_uid: { type: "string" }, promise_id: { type: "string" },
        last_anchor: { type: ["object", "null"], properties: { day: { type: "string" }, tree_size: { type: "integer" }, root: { type: "string" }, tx: { type: "string" } } },
        root_covers_this_receipt: { type: "boolean", description: "true iff index < anchored_tree_size: the anchored ROOT commits to this leaf via the inclusion proof" },
        covers_this_receipt: { type: "boolean", description: "deprecated alias of root_covers_this_receipt" },
        anchored_tree_size: { type: ["integer", "null"] },
        what_is_anchored: { type: "string" }, explorer: { type: "string" },
      },
      required: ["root_covers_this_receipt", "anchored_tree_size", "what_is_anchored"],
    },
    provenance: {
      type: "object",
      description: "What the receipt does and does not prove",
      properties: {
        level: { type: "string", enum: ["self-reported", "server-observed", "externally-verified"] },
        levels: { type: "array", items: { type: "string" } }, levels_meaning: { type: "object" }, meaning: { type: "string" },
      },
      required: ["level", "levels"],
    },
  },
  required: ["format", "payload", "leaf", "index", "tree_size", "root", "signature", "verifier_key", "inclusion_proof", "checkpoint", "anchor", "provenance"],
};

// How-to documents are MCP RESOURCES, not tools (tools = capabilities, resources = reading material).
const RESOURCES = [
  { uri: "gblin://howto/attestation", name: "How to buy the signed risk attestation (x402)", mimeType: "application/json",
    description: "Endpoint, price, x402 flow and offline verification of the EIP-712-signed Risk Attestation ($0.003 USDC on Base)." },
  { uri: "gblin://howto/seal", name: "How to seal AI actions without limits (x402)", mimeType: "application/json",
    description: "Paid seal endpoint ($0.01 USDC on Base via x402), fields, free reading routes and the offline verifier." },
  { uri: "gblin://limits", name: "Rate limits and costs of this server", mimeType: "application/json",
    description: "Machine-readable numbers: 60 requests/min/IP on /mcp, receipts.seal demo 5/day/IP, all tools free; paid prices of the x402 HTTP endpoints." },
  { uri: "gblin://keys", name: "Signing keys and rotation policy", mimeType: "application/json",
    description: "Current verifier keys (receipts log, witness), the EAS attester wallet, and the pre-registered key-rotation procedure (how old receipts stay verifiable)." },
];

const TOOLS = [
  {
    name: "risk.regime",
    description:
      "Current BTC/ETH risk regime (calm | elevated | crash) with a suggested posture, read live from GBLIN's on-chain Crash Shield on Base (60s cache). Free and unsigned; a signed, verifiable-offline version is a paid x402 endpoint (resource gblin://howto/attestation).",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { title: "Market risk regime (live, free)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        regime: { type: "string", enum: ["calm", "elevated", "crash"], description: "Current risk regime" },
        regime_code: { type: "integer", description: "0 calm, 1 elevated, 2 crash" },
        risk_posture: { type: "string", enum: ["risk_on", "reduce", "risk_off"], description: "Suggested posture" },
        severity_pct: { type: "number", description: "Max crash-shield weight cut across risk assets, percent" },
        defensive_cash_pct: { type: "number", description: "USDC dynamic weight in the basket, percent" },
        shield_active: { type: "boolean", description: "True when any risk asset is currently slashed" },
        assets: {
          type: "array",
          description: "Per-risk-asset shield state",
          items: {
            type: "object",
            properties: {
              token: { type: "string", description: "ERC-20 address" },
              shielded: { type: "boolean" },
              base_weight_pct: { type: "number" },
              dynamic_weight_pct: { type: "number" },
              weight_cut_pct: { type: "number" },
            },
            required: ["token", "shielded", "weight_cut_pct"],
          },
        },
        contract: { type: "string", description: "GBLIN contract on Base" },
        chain_id: { type: "integer" },
        source: { type: "string" },
        note: { type: "string" },
      },
      required: ["regime", "regime_code", "severity_pct", "defensive_cash_pct", "shield_active", "assets"],
    },
  },
  {
    name: "risk.attestation_sample",
    description:
      "Static, permanently expired sample of the signed Risk Attestation (sample:true), same fields and EIP-712 schema as the paid one. Use it to build and test a parser/verifier.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { title: "Attestation sample (free, expired)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        sample: { type: "boolean", description: "Always true — never a live signal" },
        attestation: {
          type: "object",
          description: "Same field contract as the paid attestation (regime, shield_active, severity_pct, defensive_cash_pct, expires_at, ...)",
        },
        eip712: { type: "object", description: "EIP-712 domain/types/message to recompute the digest" },
        attestation_id: { type: "string", description: "hashTypedData digest — recompute to verify" },
        signature: { type: ["string", "null"] },
        attestor: { type: ["string", "null"] },
        signed: { type: "boolean" },
        verify: { type: "object" },
        meta: { type: "object" },
      },
      required: ["sample", "attestation", "attestation_id", "signed"],
    },
  },
  {
    name: "protocol.stats",
    description:
      "Cumulative public counters of GBLIN's x402 endpoints: paid calls, unique payer wallets, USDC earned, with methodology disclosure. Cached 5 min.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { title: "Agent-economy stats (free, cached)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        total_paid_calls: { type: "integer", description: "Settled x402 calls, cumulative" },
        total_unique_agents: { type: "integer", description: "Distinct payer wallets, cumulative (our own wallets excluded)" },
        total_usdc_earned: { type: "number", description: "USDC received, cumulative" },
        _source: {
          type: "object",
          description: "Provenance and disclosure of the counters",
          properties: {
            name: { type: "string" }, url: { type: "string" }, data_endpoint: { type: "string" },
            docs: { type: "string" }, license: { type: "string" }, disclosure: { type: "string" },
          },
        },
      },
      required: ["total_paid_calls", "total_unique_agents", "total_usdc_earned"],
    },
  },
  {
    name: "protocol.info",
    description:
      "GBLIN llms.txt as plain text: contract addresses, endpoints, prices, payment flow, field contract of the attestation.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { title: "Protocol info / llms.txt (free)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        llms_txt: { type: "string", description: "The full llms.txt document (plain text)" },
      },
      required: ["llms_txt"],
    },
  },
  {
    name: "receipts.seal",
    description:
      "Append the HASHES of an AI action to GBLIN's public RFC 6962 transparency log and return a portable receipt: Ed25519 signature, inclusion proof, operator-signed C2SP checkpoint, plus the latest on-chain anchor (EAS on Base, daily). mode=demo (the only mode over MCP): 5 seals/day/IP, receipts marked demo:true. Unlimited seals are a paid x402 HTTP endpoint (resource gblin://howto/seal). Provenance is self-reported: the receipt proves existence and time of the record, not that the action happened. The action/agent_id/tool/meta strings are PUBLISHED in the log: identifiers only, never secrets.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["demo"], default: "demo", description: "Only 'demo' is available over MCP (5/day/IP). Paid seals go through x402 HTTP." },
        action: { type: "string", minLength: 1, maxLength: 128, description: "What the AI did, short label. PUBLISHED in the log." },
        input_hash: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "sha256 of the input/prompt, 64 hex chars" },
        output_hash: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "sha256 of the output, 64 hex chars (optional)" },
        agent_id: { type: "string", maxLength: 128, description: "Your agent identifier (optional). PUBLISHED." },
        tool: { type: "string", maxLength: 128, description: "Tool/model used (optional). PUBLISHED." },
        meta: { type: "string", maxLength: 512, description: "Extra JSON object as a string (optional). PUBLISHED." },
      },
      required: ["mode", "action", "input_hash"],
      additionalProperties: false,
    },
    annotations: { title: "Seal an AI action (demo receipt)", readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: RECEIPT_SCHEMA,
  },
  {
    name: "receipts.get",
    description: "Receipt #index from GBLIN's receipts log, re-signed (Ed25519 is deterministic) with a fresh inclusion proof, the current signed checkpoint and the latest on-chain anchor. Free.",
    inputSchema: { type: "object", properties: { index: { type: "integer", minimum: 0, description: "Receipt index in the log (0-based; current size at GET /log/checkpoint)" } }, required: ["index"], additionalProperties: false },
    annotations: { title: "Get a receipt by index", ...RO },
    outputSchema: RECEIPT_SCHEMA,
  },
  {
    name: "receipts.verify",
    description: "Verify a gblin-receipt/v1 JSON with pure math (no log lookup, no trust in this server): leaf hash, Ed25519 signature, RFC 6962 inclusion proof, C2SP checkpoint signature, verifier-key hash. Same checks as the zero-dependency verify-receipt.mjs you can run offline. For the extra on-chain-anchor consistency check use GET /v1/verify/:index.",
    inputSchema: {
      type: "object",
      properties: { receipt: { type: "object", description: "The receipt JSON as returned by receipts.seal / receipts.get / GET /v1/receipt/:i (bare or wrapped in {receipt})" } },
      required: ["receipt"],
      additionalProperties: false,
    },
    annotations: { title: "Verify a receipt (pure math)", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      type: "object",
      properties: {
        valid: { type: "boolean" },
        format: { type: "string" }, index: { type: "integer" }, tree_size: { type: "integer" },
        checks: { type: "array", items: { type: "object", properties: { name: { type: "string" }, ok: { type: "boolean" }, detail: { type: "string" } }, required: ["name", "ok"] } },
        errors: { type: "array", items: { type: "string" } },
        reminder: { type: "string" },
      },
      required: ["valid", "checks", "errors"],
    },
  },
  {
    name: "coherence.report",
    description:
      "Kept/violated tallies for GBLIN's pre-registered, hash-pinned promises (attestation uptime, counter honesty), probed every 10 minutes; each closed UTC day is sealed on Base as an EAS attestation (schema 0x9f433a96…). Self-observation only in v0. Free.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { title: "Coherence report (promises vs conduct, free)", ...RO },
    outputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Observed subject" },
        promises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short promise id (P1, P2, ...)" },
              promiseId: { type: "string", description: "keccak256 of the pre-registered promise file" },
              file: { type: "string", description: "Public URL of the promise file" },
              observations: { type: "integer" },
              kept: { type: "integer" },
              violations: { type: "integer" },
              kept_bps: { type: "integer", description: "Kept ratio in basis points (10000 = 100%)" },
              last_observation: { type: "string" },
              last_status: { type: "string", enum: ["kept", "violated"] },
            },
          },
        },
        observing_since: { type: "string" },
        method: { type: "string" },
      },
      required: ["subject", "promises"],
    },
  },
];

// ── Coherence Proof v0 — the automaton observing ourselves ──────────────────
//
// Pre-registered, hash-pinned promises (pattern borrowed from the one client
// that holds US accountable: a published file whose hash is the commitment).
// Every 10 minutes the scheduled handler probes the checks; every observation
// is tallied per promise per day in KV. Reading the report is free, forever —
// that is the design, not a promo. On-chain EAS attestation of the daily
// window ships when the dedicated attester wallet exists (founder action);
// nothing here needs to change for that, it only consumes these tallies.
const COHERENCE_SUBJECT = "gblin.digital (GBLIN Protocol, ERC-8004 #59286)";
const COHERENCE_PROMISES = [
  {
    id: "P1",
    file: "https://gblin.digital/promises/P1-attestation-uptime.json",
    promiseId: "0x39657f8b917beefaf60bc239889bd07ec2ed1c34d5bd9cd8230aa053081858a5",
    // kept when BOTH: paid endpoint answers 402 with a non-empty challenge body,
    // and the free sample answers 200 with sample:true.
    check: async () => {
      const paid = await fetch("https://gblin.digital/api/x402/attestation", {
        headers: { accept: "application/json" },
      });
      const paidBody = await paid.text();
      const paidOk = paid.status === 402 && paidBody.length > 2;
      const sample = await fetch("https://gblin.digital/api/x402/attestation-sample", {
        headers: { accept: "application/json" },
      });
      let sampleOk = false;
      if (sample.status === 200) {
        try { sampleOk = (await sample.json()).sample === true; } catch { sampleOk = false; }
      }
      return paidOk && sampleOk;
    },
  },
  {
    id: "P2",
    file: "https://gblin.digital/promises/P2-honest-counters.json",
    promiseId: "0xfd49bca1060869f41d97b877878e8886e028632d7d9c0be60110c174d31b3650",
    // kept when the public counters answer with numbers AND the disclosure file
    // (which carries our own wallet list) is still served. Silently removing
    // the disclosure is the violation this promise exists to catch.
    check: async () => {
      const stats = await fetch("https://gblin.digital/api/agent-stats", {
        headers: { accept: "application/json" },
      });
      let statsOk = false;
      if (stats.status === 200) {
        try {
          const j = await stats.json();
          statsOk = Number.isFinite(Number(j.total_paid_calls)) || Number.isFinite(Number(j.totalCalls));
        } catch { statsOk = false; }
      }
      const disc = await fetch("https://gblin.digital/promises/P2-honest-counters.json");
      let discOk = false;
      if (disc.status === 200) {
        const t = await disc.text();
        discOk = t.includes("our_wallets") && t.includes("0xd15ca75ff73aa5173c28bd82fff302204cf6c6d9");
      }
      return statsOk && discOk;
    },
  },
];

function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

// One KV doc per promise per day: { obs, kept, last, lastStatus }.
async function coherenceObserve(env) {
  if (!env.COHERENCE) return; // binding absent (local dev): observation is a no-op
  const day = utcDay();
  for (const p of COHERENCE_PROMISES) {
    // A promise is IN FORCE only once its file is public: pre-registration is
    // the commitment. Until then we do not observe — recording violations for
    // an unpublished promise would be theatre, not measurement.
    try {
      const f = await fetch(p.file, { headers: { accept: "application/json" } });
      if (f.status !== 200) continue;
    } catch { continue; }
    let kept = false;
    try { kept = await p.check(); } catch { kept = false; }
    const key = `day:${p.id}:${day}`;
    let doc = { obs: 0, kept: 0, last: null, lastStatus: null };
    try { doc = JSON.parse((await env.COHERENCE.get(key)) || "null") || doc; } catch { /* fresh */ }
    doc.obs += 1;
    if (kept) doc.kept += 1;
    doc.last = new Date().toISOString();
    doc.lastStatus = kept ? "kept" : "violated";
    await env.COHERENCE.put(key, JSON.stringify(doc), { expirationTtl: 60 * 86400 });
    // First-ever observation timestamp, written once.
    const since = await env.COHERENCE.get("since");
    if (!since) await env.COHERENCE.put("since", doc.last);
  }
}

// ── On-chain attestation (EAS on Base) — the automaton's daily seal ─────────
//
// Once a day, for each promise, write one EAS attestation of the finished-day
// window (observations, kept, violations) signed by the dedicated observer
// wallet. Fully isolated and fail-safe: no ATTESTER_KEY → skipped silently, so
// the free report keeps working and nothing else in the Worker is touched. A
// wrong on-chain write is permanent, so this only runs on a CLOSED day (never
// the current one) and never re-attests a day already sealed (idempotent via KV).
const EAS_CONTRACT = "0x4200000000000000000000000000000000000021"; // EAS on Base
const SCHEMA_UID =
  "0x9f433a96467ab75530009970e5aa938ec94d8a49f08f66e7381822d557b448ef";

const EAS_ATTEST_ABI = [
  {
    name: "attest",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
];

const SCHEMA_FIELDS = [
  { name: "subject", type: "address" },
  { name: "promiseId", type: "bytes32" },
  { name: "windowStart", type: "uint64" },
  { name: "windowEnd", type: "uint64" },
  { name: "observations", type: "uint32" },
  { name: "keptBps", type: "uint16" },
  { name: "violations", type: "uint16" },
  { name: "evidenceURI", type: "string" },
];

// GBLIN's own on-chain identity, the subject of these self-attestations.
const SELF_SUBJECT = "0x9ffa542e369c53af62380296092ec669f329a9ee";

async function coherenceAttestClosedDay(env) {
  if (!env.COHERENCE || !env.ATTESTER_KEY) return false; // not armed yet — by design
  let viem, accounts, chains;
  try {
    viem = await import("viem");
    accounts = await import("viem/accounts");
    chains = await import("viem/chains");
  } catch {
    return false; // library unavailable: never block the heartbeat
  }

  const today = utcDay();
  const key = env.ATTESTER_KEY.startsWith("0x") ? env.ATTESTER_KEY : "0x" + env.ATTESTER_KEY;
  const account = accounts.privateKeyToAccount(key);
  // Base's own RPC rejects Cloudflare egress IPs; rotate over the same fallback
  // list the read path uses (working endpoints first, mainnet.base.org last) so
  // the cron's writes actually land instead of failing silently.
  const rpcs = env.GBLIN_RPC_URL ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS] : FALLBACK_RPCS;
  const transport = viem.fallback(rpcs.map((u) => viem.http(u)));
  const pub = viem.createPublicClient({ chain: chains.base, transport });
  const client = viem.createWalletClient({ account, chain: chains.base, transport });
  // Explicit nonce: multiple seals in one run must not collide on a stale nonce.
  let nonce = await pub.getTransactionCount({ address: account.address });

  let complete = true; // false if any closed day is left unsealed this run
  let sealedThisRun = 0;
  const MAX_SEALS_PER_RUN = 12; // safety cap for CPU / subrequest limits

  for (const p of COHERENCE_PROMISES) {
    // Seal EVERY closed day (day < today) that has observations and isn't sealed
    // yet — oldest first. This catches up days missed while sealing was down, so
    // a failed run genuinely retries later instead of losing the day forever.
    const prefix = `day:${p.id}:`;
    const list = await env.COHERENCE.list({ prefix });
    const days = list.keys
      .map((k) => k.name.slice(prefix.length))
      .filter((day) => day < today) // YYYY-MM-DD compares lexicographically
      .sort();
    for (const day of days) {
      if (sealedThisRun >= MAX_SEALS_PER_RUN) return false; // more days remain — retry next tick
      const sealKey = `sealed:${p.id}:${day}`;
      if (await env.COHERENCE.get(sealKey)) continue; // already attested
      const dayDoc = await env.COHERENCE.get(`${prefix}${day}`);
      if (!dayDoc) continue; // no observations that day: nothing to seal
      let d;
      try { d = JSON.parse(dayDoc); } catch { continue; }
      if (!d.obs) continue;

      const keptBps = Math.round((d.kept / d.obs) * 10000);
      const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
      const end = start + 86399;
      const encoded = viem.encodeAbiParameters(SCHEMA_FIELDS, [
        SELF_SUBJECT,
        p.promiseId,
        BigInt(start),
        BigInt(end),
        d.obs,
        keptBps,
        d.obs - d.kept,
        // Se il giorno ha violazioni e ne abbiamo scritto la nota, l'evidenza on-chain
        // punta alla NOTA (che rimanda alla promessa), non solo al file della promessa:
        // cosi' il conteggio e la spiegazione viaggiano insieme e per sempre.
        d.obs - d.kept > 0 && incidentFor(day)
          ? `https://gblin-mcp.gblin-mcp-worker.workers.dev/coherence/incident/${day}`
          : p.file,
      ]);

      try {
        const hash = await client.writeContract({
          address: EAS_CONTRACT,
          abi: EAS_ATTEST_ABI,
          functionName: "attest",
          nonce,
          args: [
            {
              schema: SCHEMA_UID,
              data: {
                recipient: SELF_SUBJECT,
                expirationTime: 0n,
                revocable: true,
                refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
                data: encoded,
                value: 0n,
              },
            },
          ],
        });
        nonce += 1; // advance only after a successful submission
        sealedThisRun += 1;
        // Mark sealed only after a tx hash exists, so a failure retries next run.
        await env.COHERENCE.put(sealKey, hash, { expirationTtl: 120 * 86400 });
        await env.COHERENCE.put(`txlast:${p.id}`, JSON.stringify({ day, hash }));
        // Dogfooding: the observer seals ITS OWN real action (this EAS tx) into the
        // receipts log as a non-demo, operator-labelled receipt. Never blocks the seal.
        await sealOperatorAction(env, { action: "coherence.eas-seal", subject: `${p.id}:${day}`, tx: hash, meta: { promise: p.id, day, tx: hash } });
      } catch {
        // RPC/gas hiccup: leave this day unsealed AND mark the run incomplete, so
        // the outer daily gate keeps retrying every 10 min instead of waiting a
        // full day (per-day idempotency still prevents any double-seal).
        complete = false;
      }
    }
  }
  return complete;
}


// ── Ancora giornaliera del root del receipts-log su Base (EAS) ──────────────
// Riusa schema/wallet della Coerenza: promiseId = keccak256("gblin-receipts-log"),
// observations = tree size, evidenceURI = "root:<b64>@<size>". Idempotente per
// giorno e solo se il log è cresciuto. Fail-safe: senza ATTESTER_KEY non fa nulla.
async function rlogAnchorDaily(env) {
  if (!env.COHERENCE || !env.ATTESTER_KEY || !env.RLOG_KEY) return true;
  const today = utcDay();
  if (await env.COHERENCE.get(`rlog:anchored:${today}`)) return true;
  const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
  if (N === 0) return true;
  const last = Number((await env.COHERENCE.get("rlog:anchoredSize")) || 0);
  if (N === last) { await env.COHERENCE.put(`rlog:anchored:${today}`, "unchanged", { expirationTtl: 120 * 86400 }); return true; }
  let viem, accounts, chains;
  try { viem = await import("viem"); accounts = await import("viem/accounts"); chains = await import("viem/chains"); } catch { return false; }
  const root = await treeRoot(env, N);
  const rootB64 = btoa(String.fromCharCode(...root));
  const key = env.ATTESTER_KEY.startsWith("0x") ? env.ATTESTER_KEY : "0x" + env.ATTESTER_KEY;
  const account = accounts.privateKeyToAccount(key);
  const rpcs = env.GBLIN_RPC_URL ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS] : FALLBACK_RPCS;
  const transport = viem.fallback(rpcs.map((u) => viem.http(u)));
  const pub = viem.createPublicClient({ chain: chains.base, transport });
  const client = viem.createWalletClient({ account, chain: chains.base, transport });
  const start = Math.floor(Date.parse(`${today}T00:00:00Z`) / 1000);
  const promiseId = viem.keccak256(viem.toBytes("gblin-receipts-log"));
  const encoded = viem.encodeAbiParameters(SCHEMA_FIELDS, [
    SELF_SUBJECT, promiseId, BigInt(start), BigInt(start + 86399), N, 10000, 0,
    `root:${rootB64}@${N} https://gblin-mcp.gblin-mcp-worker.workers.dev/log/checkpoint`,
  ]);
  try {
    const nonce = await pub.getTransactionCount({ address: account.address });
    const hash = await client.writeContract({
      address: EAS_CONTRACT, abi: EAS_ATTEST_ABI, functionName: "attest", nonce,
      args: [{ schema: SCHEMA_UID, data: { recipient: SELF_SUBJECT, expirationTime: 0n, revocable: true,
        refUID: "0x0000000000000000000000000000000000000000000000000000000000000000", data: encoded, value: 0n } }],
    });
    await env.COHERENCE.put(`rlog:anchored:${today}`, hash, { expirationTtl: 120 * 86400 });
    await env.COHERENCE.put("rlog:anchoredSize", String(N));
    await env.COHERENCE.put("rlog:anchorLast", JSON.stringify({ day: today, size: N, root: rootB64, hash }));
    return true;
  } catch { return false; }
}

// Operator receipts: real actions performed by this Worker, sealed as non-demo
// entries with an explicit operator label in meta (never confused with customers).
async function sha256hex(str) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sealOperatorAction(env, { action, subject, tx, meta }) {
  try {
    if (!env.RLOG_KEY) return;
    await sealAction(env, {
      action, input_hash: await sha256hex(subject), output_hash: tx ? await sha256hex(tx) : undefined,
      agent_id: "gblin.digital/coherence-observer", tool: "cloudflare-worker-cron",
      meta: JSON.stringify({ operator: "gblin.digital", ...meta }).slice(0, 512),
    }, { demo: false, operator: true });
  } catch (e) { console.error("operator seal:", e && e.message); }
}

// One-shot "genesis" seal: attest the real cumulative window observed so far
// (from first observation to now), honestly labelled as a partial genesis
// window — never a full closed day. Used to write the very first on-chain proof
// on demand and to test the signing path end-to-end while a human is watching.
async function coherenceAttestGenesis(env) {
  if (!env.COHERENCE) return { ok: false, error: "no KV binding" };
  if (!env.ATTESTER_KEY) return { ok: false, error: "no ATTESTER_KEY set" };
  let viem, accounts, chains;
  try {
    viem = await import("viem");
    accounts = await import("viem/accounts");
    chains = await import("viem/chains");
  } catch (e) {
    return { ok: false, error: "viem import failed: " + (e.message || e) };
  }

  let account;
  try {
    const key = env.ATTESTER_KEY.startsWith("0x") ? env.ATTESTER_KEY : "0x" + env.ATTESTER_KEY;
    account = accounts.privateKeyToAccount(key);
  } catch (e) {
    return { ok: false, error: "bad ATTESTER_KEY: " + (e.message || e) };
  }
  const rpcs = env.GBLIN_RPC_URL ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS] : FALLBACK_RPCS;
  const transport = viem.fallback(rpcs.map((u) => viem.http(u)));
  const pub = viem.createPublicClient({ chain: chains.base, transport });
  const client = viem.createWalletClient({ account, chain: chains.base, transport });

  const sinceIso = await env.COHERENCE.get("since");
  const start = sinceIso ? Math.floor(Date.parse(sinceIso) / 1000) : Math.floor(Date.now() / 1000);
  const end = Math.floor(Date.now() / 1000);
  const results = [];
  // Manage the nonce ourselves: two writes from one wallet in the same request
  // would otherwise collide on a stale nonce (the cause of the P2 failure).
  let nonce = await pub.getTransactionCount({ address: account.address });

  for (const p of COHERENCE_PROMISES) {
    // Idempotent per promise: skip one already sealed as genesis.
    let existing = null;
    try { existing = JSON.parse((await env.COHERENCE.get(`txlast:${p.id}`)) || "null"); } catch { /* none */ }
    if (existing && existing.day === "genesis") { results.push({ id: p.id, skipped: "already sealed" }); continue; }

    let obs = 0, kept = 0;
    const list = await env.COHERENCE.list({ prefix: `day:${p.id}:` });
    for (const k of list.keys) {
      try { const d = JSON.parse((await env.COHERENCE.get(k.name)) || "{}"); obs += d.obs || 0; kept += d.kept || 0; } catch { /* skip */ }
    }
    if (!obs) { results.push({ id: p.id, skipped: "no observations yet" }); continue; }

    const keptBps = Math.round((kept / obs) * 10000);
    const encoded = viem.encodeAbiParameters(SCHEMA_FIELDS, [
      SELF_SUBJECT, p.promiseId, BigInt(start), BigInt(end), obs, keptBps, obs - kept,
      p.file + "#genesis",
    ]);
    try {
      const hash = await client.writeContract({
        address: EAS_CONTRACT,
        abi: EAS_ATTEST_ABI,
        functionName: "attest",
        nonce,
        args: [{
          schema: SCHEMA_UID,
          data: {
            recipient: SELF_SUBJECT, expirationTime: 0n, revocable: true,
            refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
            data: encoded, value: 0n,
          },
        }],
      });
      nonce += 1; // advance only after a successful submission
      await env.COHERENCE.put(`txlast:${p.id}`, JSON.stringify({ day: "genesis", hash }));
      results.push({ id: p.id, hash, observations: obs, keptBps });
    } catch (e) {
      results.push({ id: p.id, error: (e.shortMessage || e.message || String(e)).slice(0, 200) });
    }
  }
  return { ok: results.some((r) => r.hash), results };
}

async function coherenceReport(env) {
  const promises = [];
  const since = env.COHERENCE ? await env.COHERENCE.get("since") : null;
  for (const p of COHERENCE_PROMISES) {
    let obs = 0, kept = 0, last = null, lastStatus = null;
    if (env.COHERENCE) {
      const list = await env.COHERENCE.list({ prefix: `day:${p.id}:` });
      for (const k of list.keys) {
        try {
          const d = JSON.parse((await env.COHERENCE.get(k.name)) || "{}");
          obs += d.obs || 0;
          kept += d.kept || 0;
          if (!last || (d.last && d.last > last)) { last = d.last; lastStatus = d.lastStatus; }
        } catch { /* skip corrupt day */ }
      }
    }
    // Most recent on-chain seal for this promise, if any.
    let lastSeal = null;
    if (env.COHERENCE) {
      try { lastSeal = JSON.parse((await env.COHERENCE.get(`txlast:${p.id}`)) || "null"); } catch { /* none */ }
    }
    promises.push({
      id: p.id,
      promiseId: p.promiseId,
      file: p.file,
      observations: obs,
      kept,
      violations: obs - kept,
      kept_bps: obs > 0 ? Math.round((kept / obs) * 10000) : null,
      last_observation: last,
      last_status: lastStatus,
      last_onchain_seal: lastSeal
        ? { day: lastSeal.day, tx: lastSeal.hash, basescan: `https://basescan.org/tx/${lastSeal.hash}` }
        : null,
    });
  }
  const anchored = promises.some((p) => p.last_onchain_seal);
  return {
    subject: COHERENCE_SUBJECT,
    promises,
    observing_since: since,
    onchain: {
      anchored,
      schema_uid: SCHEMA_UID,
      eas: EAS_CONTRACT,
      schema: "https://base.easscan.org/schema/view/" + SCHEMA_UID,
      note: anchored
        ? "Each closed day is sealed as an EAS attestation on Base by the observer wallet."
        : "On-chain sealing is armed once the observer wallet key is configured; the off-chain report above is live now.",
    },
    method:
      "Promises are pre-registered, hash-pinned public files (promiseId = keccak256 of the file). An automaton probes the declared checks every 10 minutes from Cloudflare's edge and tallies kept/violated per day, then seals each closed day as an EAS attestation on Base. Reading is free forever; the paid service is being observed.",
  };
}

// ── Cached fetch helper (Cloudflare Cache API) ──────────────────────────────

async function cachedFetch(url, ttlSeconds, init) {
  const cacheKey = new Request(url, { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit.clone();
  const res = await fetch(url, init);
  if (res.ok) {
    const toStore = new Response(res.clone().body, res);
    toStore.headers.set("Cache-Control", `public, max-age=${ttlSeconds}`);
    await cache.put(cacheKey, toStore);
  }
  return res;
}

// ── On-chain regime (same math as the attestation route / npm MCP tool) ─────

async function ethCallBasket(rpc, index) {
  const data =
    BASKET_SELECTOR + index.toString(16).padStart(64, "0");
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: GBLIN, data }, "latest"],
    }),
  });
  const out = await res.json();
  if (out.error || !out.result || out.result === "0x") return null;
  const hex = out.result.slice(2);
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  if (hex.length < 6 * 64) return null;
  return {
    token: "0x" + word(0).slice(24),
    isStable: BigInt("0x" + word(3)) === 1n,
    baseWeightBps: Number(BigInt("0x" + word(4))),
    dynamicWeightBps: Number(BigInt("0x" + word(5))),
  };
}

async function computeRegime(env) {
  const rpcs = env.GBLIN_RPC_URL
    ? [env.GBLIN_RPC_URL, ...FALLBACK_RPCS]
    : FALLBACK_RPCS;

  // Pick the first RPC that answers basket(0), then reuse it for the rest.
  let rpc = null;
  let first = null;
  for (const candidate of rpcs) {
    try {
      first = await ethCallBasket(candidate, 0);
      if (first) {
        rpc = candidate;
        break;
      }
    } catch {
      // try the next one
    }
  }
  if (!rpc || !first) throw new Error("basket read failed on all RPCs");

  const entries = [first];
  for (let i = 1; i < 8; i++) {
    let e = null;
    try {
      e = await ethCallBasket(rpc, i);
    } catch {
      break;
    }
    if (!e || (e.baseWeightBps === 0 && e.dynamicWeightBps === 0)) break;
    entries.push(e);
  }

  const riskAssets = entries.filter((e) => !e.isStable);
  const assets = riskAssets.map((e) => {
    const cut =
      e.baseWeightBps > 0
        ? Math.max(0, ((e.baseWeightBps - e.dynamicWeightBps) / e.baseWeightBps) * 100)
        : 0;
    return {
      token: e.token,
      shielded: e.dynamicWeightBps < e.baseWeightBps,
      base_weight_pct: e.baseWeightBps / 100,
      dynamic_weight_pct: e.dynamicWeightBps / 100,
      weight_cut_pct: Number(cut.toFixed(2)),
    };
  });
  const maxCut = assets.reduce((m, a) => Math.max(m, a.weight_cut_pct), 0);
  const usdc = entries.find((e) => e.isStable);
  const regimeCode = maxCut <= 0 ? 0 : maxCut < 40 ? 1 : 2;
  return {
    regime: ["calm", "elevated", "crash"][regimeCode],
    regime_code: regimeCode,
    risk_posture: ["risk_on", "reduce", "risk_off"][regimeCode],
    severity_pct: Number(maxCut.toFixed(2)),
    defensive_cash_pct: usdc ? usdc.dynamicWeightBps / 100 : 0,
    shield_active: entries.some((e) => e.dynamicWeightBps < e.baseWeightBps),
    assets,
    contract: GBLIN,
    chain_id: 8453,
    source: "GBLIN on-chain Crash Shield (Base mainnet), read live",
    note: "Unsigned free reading. For a signed, attachable, verifiable-offline proof: resource gblin://howto/attestation.",
  };
}

// 60s regime cache via the Cache API (synthetic key).
async function cachedRegime(env) {
  const key = new Request("https://gblin-mcp.internal/regime-cache");
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const regime = await computeRegime(env);
  const res = new Response(JSON.stringify(regime), {
    headers: { "content-type": "application/json", "Cache-Control": "public, max-age=60" },
  });
  await cache.put(key, res.clone());
  return regime;
}

// ── Tool dispatch ───────────────────────────────────────────────────────────

// Legacy flat tool names kept working (unlisted) for clients that learned them
// before the 2026-08-21 rename to the dot-notation tree. Removed after 2026-11-21.
const LEGACY_TOOL_NAMES = {
  get_market_risk_regime: "risk.regime",
  get_attestation_sample: "risk.attestation_sample",
  get_protocol_info: "protocol.info",
  get_agent_economy_stats: "protocol.stats",
  get_coherence_report: "coherence.report",
  seal_action: "receipts.seal",
  seal_action_demo: "receipts.seal",
  get_receipt: "receipts.get",
  verify_receipt: "receipts.verify",
  // 3-level names, live for ~20 minutes on 2026-08-21 — kept so nobody who read them is stranded
  "risk.regime.get": "risk.regime",
  "risk.attestation.sample": "risk.attestation_sample",
  "protocol.info.get": "protocol.info",
  "protocol.economy.stats": "protocol.stats",
  "coherence.report.get": "coherence.report",
  "receipts.entry.seal": "receipts.seal",
  "receipts.entry.get": "receipts.get",
  "receipts.entry.verify": "receipts.verify",
};

async function callTool(rawName, env, args = {}) {
  const name = LEGACY_TOOL_NAMES[rawName] || rawName;
  switch (name) {
    case "risk.regime":
      return cachedRegime(env);
    case "risk.attestation_sample": {
      const r = await cachedFetch(`${SITE}/api/x402/attestation-sample`, 3600);
      return r.json();
    }
    case "protocol.stats": {
      const r = await cachedFetch(`${SITE}/api/agent-stats`, 300);
      return r.json();
    }
    case "protocol.info": {
      const r = await cachedFetch(`${SITE}/api/x402/llms.txt`, 3600);
      return { llms_txt: await r.text() };
    }
    case "coherence.report":
      return await coherenceReport(env);

    case "receipts.seal": {
      if (args.mode && args.mode !== "demo") throw Object.assign(new Error("only mode='demo' is available over MCP; paid seals: x402 HTTP endpoint (resource gblin://howto/seal)"), { code: -32602 });
      const r = await sealAction(env, args, { demo: true });
      if (r.status !== 200) throw new Error(r.error);
      return r.receipt;
    }
    case "receipts.verify":
      return verifyReceipt(args.receipt);
    case "receipts.get": {
      const idx = Number(args.index);
      const r = await getReceipt(env, idx);
      if (r.status !== 200) throw new Error(r.error);
      return r.receipt;
    }
    case "how_to_seal_paid": // unlisted alias -> resource gblin://howto/seal (remove after 2026-09-21)
      return howtoSeal();
    case "how_to_buy_live_attestation": // unlisted alias -> resource gblin://howto/attestation (remove after 2026-09-21)
      return howtoAttestation();
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

function howtoSeal() {
  return {
        what: "AI Action Receipts: a portable, signed receipt for any AI action, in a public append-only transparency log. Input/output go in as HASHES only (the action label and metadata you send are published); you get back signature + RFC 6962 inclusion proof + a C2SP checkpoint signed by us and cosigned by an independent witness (markovianprotocol.com/witness, since 2026-08-22); the tree root is anchored daily on Base (EAS). Evidence of existence and time — NOT a compliance certificate. A cosignature attests only that the log stayed append-only between the sizes that witness has seen; it says nothing about whether a sealed action is true.",
        paid_endpoint: `${SITE}/api/x402/seal`,
        price: "0.01 USDC on Base via x402 (unlimited)",
        demo: "MCP tool receipts.seal (mode demo) or POST https://gblin-mcp.gblin-mcp-worker.workers.dev/v1/seal-demo (5/day/IP, receipts marked demo:true)",
        fields: { action: "string <=128 (required)", input_hash: "sha256 hex of your input (required)", output_hash: "sha256 hex (optional)", agent_id: "string <=128 (optional)", tool: "string <=128 (optional)", meta: "JSON <=512 chars (optional)" },
        human_page: "GET /receipt/:index — HTML page that verifies the receipt in the browser",
        catalog_probe: "GET /observatory (human) · /observatory.json · /catalog — liveness probes of the public x402 catalog, our own endpoints included under the same rules",
        read_free: "GET /v1/receipt/:index · /log/checkpoint · /log/proof/:index · human page /receipt/:index",
        verify_offline: "MCP tool receipts.verify (pure math) or verify-receipt.mjs in github.com/gblinproject/gblin-treasury-risk-regime — zero dependencies",
      };
}

function howtoAttestation() {
  return {
        endpoint: `${SITE}/api/x402/attestation`,
        price: "0.003 USDC on Base (eip155:8453)",
        flow:
          "GET the endpoint → HTTP 402 with the payment challenge in both the PAYMENT-REQUIRED header and the JSON body → sign an EIP-3009 USDC transferWithAuthorization for the `accepts[0]` requirements → retry with the payment header → receive the signed attestation. Any x402 client (x402-fetch, AgentKit, Coinbase CDP) handles this automatically.",
        free_sample: `${SITE}/api/x402/attestation-sample`,
        attestor_address: "0x3ae65d36e8b1d82B0B80669E769A3dc300D543e4",
        verify_offline:
          "Recompute hashTypedData over `eip712` and compare to `attestation_id`; if `signed`, recover the EIP-712 signer and require it to equal the pinned attestor address above (not merely the `attestor` field in the same response). Then check expires_at > now. Free verifier: npx @gblin-protocol/mcp-server → verify_risk_attestation.",
        stable_field_contract: [
          "regime (calm|elevated|crash)",
          "shield_active",
          "severity_pct",
          "defensive_cash_pct",
          "expires_at",
        ],
      };
}

// Exposed in tools/list._meta so an agent can tell this surface from the stdio package without reading docs.
const SURFACE_META = {
  server: SERVER_INFO,
  transport: "streamable-http (stateless, no auth)",
  tool_count: 8,
  paid_over_mcp: false,
  sibling_package: {
    name: "@gblin-protocol/mcp-server", version: "0.3.0", transport: "stdio (npm)", tool_count: 13,
    note: "Different, larger tool set: the 10 treasury/governance tools (get_treasury_state, quote_safe_swap, swap_gblin_to_usdc_jit, invest_usdc_to_gblin, analyze_treasury_health, get_governance_state, share_skill_with_peer, find_keeper_bounty, verify_risk_attestation) plus get_market_risk_regime, and 3 receipts tools (seal_action_demo, get_receipt, how_to_seal_paid). Only the risk-regime read and the receipt read behave identically here (as risk.regime / receipts.get); this hosted server adds receipts.verify and the GET audit surface. The stdio package keeps flat snake_case names.",
  },
  resources: ["gblin://howto/attestation", "gblin://howto/seal", "gblin://limits", "gblin://keys"],
  prompts: ["risk_gate", "seal_and_verify"],
  legacy_tool_aliases: { note: "Pre-2026-08-21 flat names still accepted by tools/call (not listed). Removed after 2026-11-21.", map: LEGACY_TOOL_NAMES },
  get_audit_urls: { meta: "/meta", tools: "/tools.json", resources: "/resources.json", conformance: "/conformance", verify: "/v1/verify/:index" },
};
// Canonical manifest hash (tools + resources), so docs and Smithery can be checked against the live surface.
let MANIFEST_HASH = null;
async function manifestHash() {
  if (MANIFEST_HASH) return MANIFEST_HASH;
  const canon = JSON.stringify({ tools: TOOLS, resources: RESOURCES });
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  MANIFEST_HASH = "sha256:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return MANIFEST_HASH;
}
async function metaDoc(env) {
  return {
    server: SERVER_INFO, transport: SURFACE_META.transport, protocol_versions: SUPPORTED_PROTOCOLS,
    endpoint: "https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp",
    tool_count: TOOLS.length, tool_names: TOOLS.map((t) => t.name),
    resource_count: RESOURCES.length, resource_uris: RESOURCES.map((r) => r.uri),
    prompt_count: PROMPTS.length, prompt_names: PROMPTS.map((p) => p.name),
    legacy_tool_aliases: SURFACE_META.legacy_tool_aliases,
    manifest_hash: await manifestHash(),
    paid_over_mcp: false, auth_required: false, rate_limit_rpm_per_ip: 60,
    sibling_package: SURFACE_META.sibling_package,
    docs: { llms_txt: `${SITE}/llms.txt`, smithery: "https://smithery.ai/servers/gblin-protocol/mcp", repo: "https://github.com/gblinproject/gblin-treasury-risk-regime" },
    audit: SURFACE_META.get_audit_urls,
  };
}
async function conformanceDoc(env) {
  const meta = await metaDoc(env);
  return {
    about: "GET-able conformance fixture of the hosted MCP surface: identical data to tools/list and resources/list, plus error shapes and representative outputs. Lets an auditor without POST capability check the live surface.",
    meta, tools: TOOLS, resources: RESOURCES, prompts: PROMPTS,
    jsonrpc_errors: [
      { code: -32700, when: "body is not JSON" }, { code: -32600, when: "not a JSON-RPC 2.0 request" },
      { code: -32601, when: "unknown method" }, { code: -32602, when: "unknown tool, bad arguments, or receipts.seal mode != demo" },
      { code: -32002, when: "unknown resource uri" }, { code: -32602, when: "unknown prompt name" }, { code: -32603, when: "tool threw (e.g. log unavailable)" },
    ],
    http: { get_mcp: "405 (stateless: POST only)", rate_limited: "429 after 60 req/min/IP", disabled: "503 when MCP_DISABLED" },
    examples: {
      "risk.regime": await cachedRegime(env).catch(() => null),
      "receipts.get#0": await getReceipt(env, 0).then((r) => r.receipt).catch(() => null),
      "resource:gblin://limits": await readResource("gblin://limits", env),
    },
  };
}

// MCP prompts: ready-made workflows built from this server's own tools.
const PROMPTS = [
  {
    name: "risk_gate",
    title: "Risk gate before deploying capital",
    description: "Check the live on-chain risk regime and decide whether to deploy capital, reduce, or stand down — with the rule stated up front so the decision is auditable.",
    arguments: [
      { name: "action", description: "What you are about to do (e.g. 'buy 500 USDC of ETH')", required: true },
      { name: "risk_budget", description: "How much you are willing to lose on this action (optional)", required: false },
    ],
  },
  {
    name: "seal_and_verify",
    title: "Seal an AI action and verify the receipt",
    description: "Seal the hashes of an action into the public transparency log, then verify the returned receipt with pure math, and state plainly what the receipt does and does not prove.",
    arguments: [
      { name: "action", description: "Short public label for what the AI did", required: true },
      { name: "input_hash", description: "sha256 hex (64 chars) of the input", required: true },
      { name: "output_hash", description: "sha256 hex of the output (optional)", required: false },
    ],
  },
];

function getPrompt(name, args = {}) {
  const a = (k, d = "") => (typeof args[k] === "string" && args[k].trim() ? args[k].trim() : d);
  if (name === "risk_gate") {
    const budget = a("risk_budget");
    return {
      description: "Risk gate: regime first, decision second.",
      messages: [{ role: "user", content: { type: "text", text:
`Before doing this, run the risk gate.

Intended action: ${a("action", "(unspecified)")}${budget ? `\nRisk budget: ${budget}` : ""}

1. Call risk.regime.
2. Apply this rule, stated before you see the answer:
   - regime "calm"     -> proceed as intended
   - regime "elevated" -> proceed at reduced size, or wait
   - regime "crash"    -> stand down; do not deploy new capital
3. Answer in this order: regime and severity_pct, the rule branch you landed on, the decision, and the timestamp/source of the reading.
4. Say explicitly that this reading is FREE and UNSIGNED. If you need a proof you can attach and someone else can verify offline, read the resource gblin://howto/attestation and buy the signed x402 attestation instead.` } }],
    };
  }
  if (name === "seal_and_verify") {
    const out = a("output_hash");
    return {
      description: "Seal an action, then verify the receipt without trusting the server.",
      messages: [{ role: "user", content: { type: "text", text:
`Seal this action and verify the result.

action: ${a("action", "(unspecified)")}
input_hash: ${a("input_hash", "(missing - compute sha256 of the input first)")}${out ? `\noutput_hash: ${out}` : ""}

1. Call receipts.seal with mode "demo" and those fields. Remember: the action label and any agent_id/tool/meta you send are PUBLISHED in a public log — identifiers only, never secrets. Only hashes carry the input/output.
2. Pass the returned receipt to receipts.verify and report each check (leaf, signature, inclusion proof, checkpoint, verifier key).
3. Read receipt.anchor: say whether root_covers_this_receipt is true, and that only the tree ROOT is written on-chain (daily EAS on Base), never the individual receipt.
4. Close with the honest limit: a valid receipt proves the record existed at that time in that log — it does NOT prove the action really happened (provenance is self-reported).` } }],
    };
  }
  return null;
}

async function readResource(uri, env) {
  switch (uri) {
    case "gblin://howto/attestation": return howtoAttestation();
    case "gblin://howto/seal": return howtoSeal();
    case "gblin://limits": return {
      mcp_rpm_per_ip: 60,
      mcp_rpm_exceeded_status: 429,
      seal_demo_per_day_per_ip: 5,
      seal_demo_marked: "payload.demo = true",
      tools_free: true, auth_required: false, session_required: false,
      paid: {
        attestation: { url: `${SITE}/api/x402/attestation`, price_usdc: 0.003, network: "eip155:8453", protocol: "x402" },
        seal: { url: `${SITE}/api/x402/seal`, price_usdc: 0.01, network: "eip155:8453", protocol: "x402" },
      },
      // Misurato il 22/08/2026 sul primo sigillo pagato con prova di pagamento: leggendo
      // /v1/receipt/<indice> subito dopo il sigillo si puo' ricevere 404 per qualche secondo.
      // Non e' un guasto ed e' innocuo — il sigillo RESTITUISCE gia' la ricevuta completa nella
      // sua risposta — ma un client che sigilla e poi rilegge deve saperlo e ritentare.
      read_after_seal: "The seal response already contains the full receipt. The read endpoints (/v1/receipt/:i, /v1/verify/:i, /log/*) are backed by an eventually consistent store and may lag a few seconds behind a just-written leaf: retry on 404 instead of treating it as a lost seal.",
      kill_switch: "env MCP_DISABLED => HTTP 503 on every request",
    };
    case "gblin://keys": {
      let rlog = null, witness = null;
      try { rlog = (await rlogStatus(env)).verifier_key; } catch {}
      try { if (env.WITNESS_KEY) { const { parseWitnessSecret, witnessVerifierKey } = await import("./witness.mjs"); witness = await witnessVerifierKey(parseWitnessSecret(env.WITNESS_KEY).pub); } } catch {}
      return {
        receipts_log: { origin: RLOG_ORIGIN, verifier_key: rlog, alg: "Ed25519 (C2SP signed note, key id 0x01)", signs: ["gblin-receipt/v1 receipts", "checkpoints"] },
        witness: { name: "gblin.digital/witness", verifier_key: witness, alg: "Ed25519 (C2SP tlog-cosignature v1, key id 0x04)", cosigns: "markovianprotocol.com/log" },
        risk_attestation_attestor: {
          address: "0x3ae65d36e8b1d82B0B80669E769A3dc300D543e4",
          alg: "EIP-712 (secp256k1) over the attestation struct",
          signs: "the paid risk attestation at https://gblin.digital/api/x402/attestation",
          how_to_use: "Recover the signer from `signature` over `eip712` and require it to equal THIS address. Comparing it only with the `attestor` field the response itself carries proves nothing.",
        },
        eas_attester_wallet: { address: "0x14d4d81233EAa95F071f514510661a2a873D83a1", role: "pays the daily EAS attestations on Base (Coherence days + receipts-log root)", note: "dedicated hot wallet, not the protocol owner" },
        rotation_policy: {
          trigger: "suspected compromise or scheduled rotation; never silent",
          procedure: [
            "1. New keypair generated; new verifier_key published here, in /log/checkpoint and in llms.txt with the rotation date.",
            "2. The last checkpoint signed by the OLD key is sealed on Base via EAS (same schema) so the hand-over point is on-chain.",
            "3. The old verifier_key stays listed under retired_keys with its valid_until and last_tree_size; receipts issued before that size verify with the old key.",
            "4. The new key signs a checkpoint over the SAME tree (no new log, no re-indexing): inclusion proofs of old receipts remain valid against new checkpoints.",
          ],
          retired_keys: [],
          last_rotation: null,
        },
      };
    }
    default: return null;
  }
}

// ── JSON-RPC / MCP plumbing (stateless Streamable HTTP) ─────────────────────

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMessage(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && "id" in msg ? msg.id : null, -32600, "Invalid Request");
  }
  const { id, method, params } = msg;
  const isNotification = !("id" in msg);

  // Contatore aggregato della superficie gratuita (vedi mcpusage.mjs): si registra COSA e'
  // stato chiamato, mai CHI ha chiamato. Il nome dello strumento si prende dalla nostra
  // lista, non dal testo del chiamante, cosi' nessuno puo' scriversi chiavi arbitrarie.
  try {
    if (method === "tools/call") {
      const richiesto = params && params.name;
      const risolto = LEGACY_TOOL_NAMES[richiesto] || richiesto;
      contaChiamata("tools/call", TOOLS.some((t) => t.name === risolto) ? risolto : "unknown");
    } else if (method !== "notifications/initialized") {
      contaChiamata(metodoNoto(method)); // elenco chiuso: un metodo inventato non crea una chiave
    }
  } catch { /* un contatore non puo' rompere una risposta */ }

  try {
    switch (method) {
      case "initialize": {
        const requested = params && params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOLS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "GBLIN hosted MCP (stateless, no auth, 60 req/min/IP). Free tools: risk.regime (live calm|elevated|crash from the on-chain Crash Shield), risk.attestation_sample, protocol.stats, protocol.info, coherence.report, and AI Action Receipts: receipts.seal (demo, 5/day/IP), receipts.get, receipts.verify (pure math). Paid things are x402 HTTP endpoints, never MCP calls: read resources gblin://howto/attestation, gblin://howto/seal, gblin://limits, gblin://keys. Two ready-made prompts: risk_gate, seal_and_verify. The stdio package @gblin-protocol/mcp-server is a different, larger toolset (treasury/swap tools).",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS, _meta: SURFACE_META });
      case "prompts/list":
        return rpcResult(id, { prompts: PROMPTS });
      case "prompts/get": {
        const pname = params && params.name;
        const body = getPrompt(pname, (params && params.arguments) || {});
        if (!body) return rpcError(id, -32602, `Unknown prompt: ${pname}`);
        return rpcResult(id, body);
      }
      case "resources/list":
        return rpcResult(id, { resources: RESOURCES });
      case "resources/read": {
        const uri = params && params.uri;
        const body = await readResource(uri, env);
        if (!body) return rpcError(id, -32002, `Resource not found: ${uri}`);
        return rpcResult(id, { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] });
      }
      case "tools/call": {
        const name = params && params.name;
        try {
          const out = await callTool(name, env, (params && params.arguments) || {});
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
            structuredContent: out, // matches the tool's declared outputSchema
            isError: false,
          });
        } catch (err) {
          if (err && err.code === -32602) throw err;
          return rpcResult(id, {
            content: [{ type: "text", text: `Tool failed: ${err.message}` }],
            isError: true,
          });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized etc.
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return rpcError(id, err.code || -32603, err.message || "Internal error");
  }
}

// ── Rate limit (best-effort, per isolate) ───────────────────────────────────

const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, windowStart: now };
  if (now - b.windowStart > 60_000) {
    b.count = 0;
    b.windowStart = now;
  }
  b.count++;
  buckets.set(ip, b);
  if (buckets.size > 10_000) buckets.clear(); // memory guard
  return b.count > 60;
}

// ── HTTP entry point ────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

// Cosa il resource server ha VISTO del pagamento x402 di questo sigillo, normalizzato e
// limitato. Non e' il chiamante a dirlo: il webapp lo estrae dall'header x-payment che il
// middleware ha appena verificato, e ce lo passa qui in base64.
//
// Perche' NON c'e' l'hash della transazione: al momento del sigillo il server non lo conosce
// (il facilitator regola attorno all'handler). C'e' invece il nonce dell'autorizzazione
// EIP-3009, che e' meglio di una nostra parola: USDC su Base emette
// AuthorizationUsed(authorizer, nonce) nella transazione di regolamento, quindi chiunque
// puo' RITROVARE quella transazione da solo partendo da payer + nonce. Verificato sul
// regolamento del sigillo pagato del 21/08 (tx 0xf948f708..., due log: AuthorizationUsed e Transfer).
const HEXADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
function parsePaymentObservation(header) {
  if (!header) return null;
  let o;
  try { o = JSON.parse(atob(header)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const str = (x, max = 80) => (typeof x === "string" && x.length <= max ? x : undefined);
  const out = {
    observed_by: "gblin.digital resource server",
    scheme: str(o.scheme, 24),
    network: str(o.network, 32),
    asset: HEXADDR.test(o.asset || "") ? o.asset.toLowerCase() : undefined,
    amount: typeof o.amount === "string" && /^\d{1,32}$/.test(o.amount) ? o.amount : undefined,
    payer: HEXADDR.test(o.payer || "") ? o.payer.toLowerCase() : undefined,
    pay_to: HEXADDR.test(o.pay_to || "") ? o.pay_to.toLowerCase() : undefined,
    authorization_nonce: HEX32.test(o.authorization_nonce || "") ? o.authorization_nonce.toLowerCase() : undefined,
    payload_sha256: /^[0-9a-f]{64}$/.test(o.payload_sha256 || "") ? o.payload_sha256 : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  // Serve almeno un aggancio verificabile da fuori, altrimenti e' rumore e non si scrive.
  if (!out.payer && !out.payload_sha256) return null;
  return out;
}

// Scarica il lotto dei contatori DOPO aver risposto, cosi' non allunga la risposta del
// chiamante. Se il runtime non ci passa ctx, si scarica comunque ma senza attenderlo.
function flushUso(env, ctx) {
  try {
    // subito: scarica il lotto gia' accumulato (le chiamate precedenti di questo isolate)
    const p = scarica(env);
    if (p && ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
    // dopo qualche secondo: scarica anche QUESTA richiesta, che altrimenti resterebbe in
    // sospeso fino alla prossima e morirebbe con l'isolate. Vive dentro waitUntil, quindi
    // non allunga di un millisecondo la risposta al chiamante.
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(scaricoDifferito(env));
  } catch { /* mai far fallire una risposta per un contatore */ }
}

export default {
  async fetch(request, env, ctx) {
    if (env.MCP_DISABLED === "true") {
      return json({ error: "GBLIN MCP temporarily disabled" }, 503);
    }

    const url = new URL(request.url);

    // Le superfici gratuite della PROVA: se nessuno rilegge una ricevuta o un checkpoint,
    // il prodotto non ha lettori, e finora non lo sapevamo. Percorsi normalizzati su un
    // elenco fisso: un percorso inventato non crea una chiave nuova.
    try {
      const p = url.pathname;
      const fisso = [
        "/coherence", "/log", "/log/checkpoint", "/log/leaves", "/log/consistency",
        "/log/witnesses", "/witness", "/regime", "/observatory", "/observatory.json", "/meta",
      ];
      const normalizzato =
        fisso.includes(p) ? p
        : p.startsWith("/v1/receipt/") ? "/v1/receipt"
        : p.startsWith("/v1/verify/") ? "/v1/verify"
        : p.startsWith("/log/proof/") ? "/log/proof"
        : p.startsWith("/receipt/") ? "/receipt (explorer)"
        : p.startsWith("/coherence/incident/") ? "/coherence/incident"
        : null;
      if (normalizzato) contaChiamata("http", normalizzato);
    } catch { /* mai far fallire una risposta per un contatore */ }
    // Scarico qui, in cima: vale per OGNI rotta (non solo /mcp, dove stava prima e per cui
    // i contatori HTTP non venivano mai scritti) e scarica il lotto PRECEDENTE, quindi le
    // chiamate ravvicinate si fondono comunque in una scrittura sola.
    flushUso(env, ctx);

    // Sfida x402 anonima servita dal bordo (vedi x402-challenge.mjs). Ci arriva riscritta da
    // una Project Routing Rule di Vercel quando la richiesta NON porta pagamento. Vercel,
    // riscrivendo verso un URL esterno, inoltra il PERCORSO ORIGINALE, non quello scritto
    // nella destinazione: rispondiamo sia sul nostro percorso sia su quello della webapp.
    // (Scoperto il 22/08 con un 404 del Worker che sembrava di Vercel: corpo nostro, 46 byte.)
    //
    // STA QUI IN CIMA di proposito, PRIMA del ramo OPTIONS e PRIMA del rate-limit: la regola
    // di Vercel non sa filtrare per metodo (le condizioni sono solo Header/Cookie/Query/Host),
    // quindi ogni metodo passa di qui e deve rispondere quello che rispondeva l'origin —
    // origin che serve la sfida anche a OPTIONS, PUT e DELETE. E un crawler oltre i 60/min
    // deve vedere la sfida, non un 429 che l'origin non avrebbe mai dato.
    {
      const edge = x402StaticChallenge(request);
      if (edge) return edge;
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (rateLimited(ip)) return json({ error: "rate limited (60 req/min)" }, 429);

    // Info page for humans/probes at the root.
    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: SERVER_INFO.name,
        mcp_endpoint: "/mcp",
        transport: "streamable-http (stateless, JSON responses)",
        tools: TOOLS.map((t) => t.name),
        stdio_twin: "npx @gblin-protocol/mcp-server (full toolset, free)",
        site: SITE,
        witness: "/witness (we cosign third-party transparency-log checkpoints; C2SP tlog-cosignature v1)",
        audit: "/meta · /tools.json · /resources.json · /conformance · /v1/verify/:index (GET-only audit of the MCP surface)",
        receipts: "/log (AI Action Receipts: seal what your agent did — $0.01 via x402 at gblin.digital/api/x402/seal, demo via MCP tool receipts.seal)",
        prompts: PROMPTS.map((p) => p.name),
        resources: RESOURCES.map((r) => r.uri),
        observatory: "/observatory (human) · /observatory.json · /catalog · /observatory/badge.svg?host=… — liveness probes of the public x402 catalog, our own endpoints under the same rules",
        coherence: "/coherence (promises vs conduct, sealed daily on Base)",
      });
    }

    // Public coherence report for humans, dashboards and crawlers. Free forever.
    if (url.pathname === "/meta" && request.method === "GET") return json(await metaDoc(env), 200, { "cache-control": "public, max-age=300" });
    if (url.pathname === "/tools.json" && request.method === "GET") return json({ manifest_hash: await manifestHash(), tools: TOOLS }, 200, { "cache-control": "public, max-age=300" });
    if (url.pathname === "/resources.json" && request.method === "GET") return json({ manifest_hash: await manifestHash(), resources: RESOURCES }, 200, { "cache-control": "public, max-age=300" });
    if (url.pathname === "/conformance" && request.method === "GET") return json(await conformanceDoc(env), 200, { "cache-control": "public, max-age=120" });
    if (url.pathname.startsWith("/v1/verify/") && request.method === "GET") {
      const idx = Number(url.pathname.slice("/v1/verify/".length));
      const r = await getReceipt(env, idx);
      if (r.status !== 200) return json({ error: r.error }, r.status);
      const v = await verifyReceipt(r.receipt);
      const byName = Object.fromEntries(v.checks.map((c) => [c.name, c.ok]));
      const a = await anchorConsistency(env);
      return json({
        index: idx, tree_size: r.receipt.tree_size,
        signature_valid: !!byName.signature, leaf_valid: !!byName.leaf, inclusion_valid: !!byName.inclusion_proof,
        checkpoint_valid: !!byName.checkpoint, verifier_key_valid: !!byName.verifier_key,
        anchor_found: a.anchor_found, anchor_root_matches: a.anchor_root_matches, anchored_tree_size: a.anchored_tree_size, anchor_tx: a.anchor_tx,
        root_covers_this_receipt: a.anchor_found && idx < a.anchored_tree_size,
        // Due assi DISTINTI, e vanno letti nello stesso posto della ricevuta.
        // Prima del 23/08/2026 qui usciva il solo provenance_level: chi apriva
        // questo endpoint leggeva "self-reported" su una ricevuta che altrove
        // presentavamo come server-observed sul PAGAMENTO. Rilievo di un terzo.
        provenance_level: r.receipt.provenance.level, demo: !!r.receipt.payload.demo,
        payment_evidence_level: r.receipt.provenance.payment_evidence ? r.receipt.provenance.payment_evidence.level : "none",
        payment_evidence: r.receipt.provenance.payment_evidence || null,
        valid: v.valid, errors: v.errors,
        note: "Cryptographic checks are recomputed server-side from the receipt alone (same math as the receipts.verify tool / verify-receipt.mjs); anchor_root_matches recomputes the root at anchored_tree_size from the log and compares it with the root written on Base. Trust model: re-run verify-receipt.mjs offline if you do not trust this server.",
        provenance_note: "Two separate axes. provenance_level describes the sealed ACTION (self-reported unless this server performed it itself). payment_evidence_level describes whether this server verified an x402 payment authorization before writing the seal; \"none\" means the receipt carries no payment evidence. A paid seal is not a verified seal: a server-observed payment never upgrades the action's hashes.",
      }, 200, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname === "/coherence" && request.method === "GET") {
      return json(await coherenceReport(env));
    }

    // Regime GRATUITO via REST (stessa matematica del tool MCP, cache 60s):
    // pensato per i provider dei plugin che girano a OGNI loop degli agenti.
    // Free tier: mai conteggiato nei contatori "paid" (promessa P2).
    if (url.pathname === "/regime" && request.method === "GET") {
      const regime = await cachedRegime(env);
      return json({
        ...regime,
        note: "Free unsigned reading, 60s cache. For a signed, offline-verifiable proof: gblin.digital/api/x402/attestation ($0.003). Risk Gate pattern: gblin.digital/risk-gate",
      });
    }

    // OSSERVATORIO PUBBLICO — artefatto citabile: pagina, JSON stabile, badge.
    if (url.pathname === "/observatory" && request.method === "GET") {
      return new Response(await observatoryPage(env), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600", ...CORS },
      });
    }
    if (url.pathname === "/observatory.json" && request.method === "GET") {
      return json(await observatoryJson(env), 200, { "cache-control": "public, max-age=600" });
    }
    if (url.pathname === "/observatory/badge.svg" && request.method === "GET") {
      return new Response(await observatoryBadge(env, url.searchParams.get("host")), {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=600", ...CORS },
      });
    }

    // AI ACTION RECEIPTS — sigilli firmati+testimoniati per le azioni delle IA.
    // Pagato: via webapp /api/x402/seal (x402 $0.01, inoltra qui col token).
    // Demo: 5/giorno/IP, marcati demo:true. Lettura e verifica: gratis per sempre.
    // Scoperta manuale dei log della witness-network (oltre al giro giornaliero).
    if (url.pathname === "/internal/witness-discover" && request.method === "POST") {
      const tok = url.searchParams.get("token") || "";
      if (!env.CATALOG_TOKEN || tok !== env.CATALOG_TOKEN) return json({ error: "unauthorized" }, 401);
      return json(await witnessDiscoverLogs(env), 200, { "cache-control": "no-store" });
    }
    if (url.pathname === "/internal/seal" && request.method === "POST") {
      const tok = url.searchParams.get("token") || "";
      if (!env.CATALOG_TOKEN || tok !== env.CATALOG_TOKEN) return json({ error: "unauthorized" }, 401);
      let body; try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const operator = url.searchParams.get("operator") === "1"; // solo per i sigilli delle NOSTRE azioni
      // Osservazione del pagamento: arriva SOLO da questo header, mai dal corpo — cosi' il
      // chiamante non puo' scriversi da solo un pagamento che non ha fatto. Il percorso e'
      // gia' autenticato col CATALOG_TOKEN, quindi a metterlo e' il nostro resource server.
      const payment = parsePaymentObservation(request.headers.get("x-gblin-payment-observed"));
      const r = await sealAction(env, body, { demo: false, operator, payment });
      return json(r.status === 200 ? r.receipt : { error: r.error }, r.status, { "cache-control": "no-store" });
    }
    // Rotte POST-only che PUBBLICHIAMO: se le si interroga col metodo sbagliato devono dire
    // "metodo sbagliato", non "non esiste". Prima cadevano nel 404 catch-all in fondo, e un crawler
    // che sonda in GET si sentiva rispondere che la rotta non c'e' (corretto il 23/08/2026).
    // Le rotte /internal/* e /coherence/{genesis,seal} restano volutamente FUORI da questa lista:
    // non sono in nessun documento pubblico e sono protette da token — una rotta privilegiata non
    // deve confermare di esistere, quindi per loro il 404 e' la risposta giusta.
    const SOLO_POST_PUBBLICHE = {
      "/v1/seal-demo": "use POST /v1/seal-demo (5/day/IP, receipts marked demo:true)",
      "/witness/add-checkpoint": "use POST /witness/add-checkpoint (c2sp tlog-witness: body = old <n> + consistency proof + signed note)",
    };
    if (SOLO_POST_PUBBLICHE[url.pathname] && request.method !== "POST" && request.method !== "OPTIONS") {
      return json({ error: "method not allowed — " + SOLO_POST_PUBBLICHE[url.pathname] },
                  405, { "allow": "POST", "cache-control": "public, max-age=300" });
    }
    if (url.pathname === "/v1/seal-demo" && request.method === "POST") {
      if (!(await demoAllowed(env, ip))) {
        return json({ error: "demo limit reached (5/day/IP). For unlimited seals pay $0.01 via x402: POST https://gblin.digital/api/x402/seal" }, 429);
      }
      let body; try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const r = await sealAction(env, body, { demo: true });
      return json(r.status === 200 ? r.receipt : { error: r.error }, r.status, { "cache-control": "no-store" });
    }
    if (url.pathname.startsWith("/v1/receipt/") && request.method === "GET") {
      const idx = Number(url.pathname.slice("/v1/receipt/".length));
      if (!Number.isInteger(idx) || idx < 0) return json({ error: "bad index" }, 400);
      const r = await getReceipt(env, idx);
      return json(r.status === 200 ? r.receipt : { error: r.error }, r.status, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname === "/internal/witness-push" && request.method === "POST") {
      const tok = url.searchParams.get("token") || "";
      if (!env.CATALOG_TOKEN || tok !== env.CATALOG_TOKEN) return json({ error: "unauthorized" }, 401);
      return json(await pushToWitnesses(env, { force: url.searchParams.get("force") === "1" }), 200, { "cache-control": "no-store" });
    }
    if (url.pathname === "/log/witnesses" && request.method === "GET") {
      return json({
        origin: RLOG_ORIGIN,
        what: "Third-party witnesses invited to cosign this log's checkpoint (c2sp.org/tlog-witness). A cosignature attests only that the log stayed append-only between the sizes that witness has seen — it says nothing about whether a sealed action is true.",
        how_to_join: "Pin our origin and verifier key (GET /log — verifier_key), then accept POST add-checkpoint pushes from us; we push on every size change. Audit first with GET /log/leaves and GET /log/consistency.",
        witnesses: await witnessState(env),
      }, 200, { "cache-control": "public, max-age=60" });
    }
    // Sfida x402 anonima servita dal bordo (vedi x402-challenge.mjs). Ci arriva riscritta
    // da una Project Routing Rule di Vercel quando la richiesta NON porta pagamento.
    // Note d'incidente della Coerenza: /coherence/incident/<AAAA-MM-GG>
    if (url.pathname.startsWith("/coherence/incident/") && request.method === "GET") {
      return incidentResponse(url.pathname.split("/").pop());
    }
    if (url.pathname === "/log/checkpoint" && request.method === "GET") {
      const st = await rlogStatus(env);
      if (!st.checkpoint) return json({ error: "log empty or not armed", origin: st.origin, verifier_key: st.verifier_key }, 404);
      return new Response(st.checkpoint, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...CORS } });
    }
    if (url.pathname === "/log" && request.method === "GET") {
      const st = await rlogStatus(env);
      return json({ ...st,
        what: "GBLIN AI Action Receipts — signed append-only RFC 6962 transparency log of sealed AI actions (input/output as hashes only; the action label and metadata you send are published). A seal proves existence and time; root anchored daily on Base via EAS. It is NOT a compliance certificate and NOT an endorsement. The checkpoint is cosigned by an independent witness since 2026-08-22 (see /log/witnesses); that cosignature attests only that the log stayed append-only between the sizes it has seen. More witnesses welcome.",
        seal_paid: "POST https://gblin.digital/api/x402/seal ($0.01 USDC via x402)",
        seal_demo: "POST /v1/seal-demo (5/day/IP, marked demo:true)",
        read: "GET /v1/receipt/:index (free forever) · GET /log/proof/:index · GET /log/checkpoint",
        explorer: "GET /receipt/:index (human page)",
        for_witnesses: "GET /log/checkpoint (C2SP signed note) · GET /log/consistency?old=<m>&new=<n> (RFC 6962 append-only proof) · GET /log/leaves?start=&end= (raw records, recompute the tree yourself) · GET /log/proof/<i> (inclusion) · GET /log/witnesses (who cosigns, and how to join). We also push our checkpoints with c2sp.org/tlog-witness (POST add-checkpoint) to any witness that configures our origin. One witness cosigns today (markovianprotocol.com/witness); more are welcome.",
        anchor: "tree root anchored daily on Base via EAS (schema " + "0x9f433a96..., promiseId keccak256('gblin-receipts-log'))",
        offline_verifier: "verify-receipt.mjs in github.com/gblinproject/gblin-treasury-risk-regime (zero deps)",
        design_note: "https://github.com/gblinproject/gblin-treasury-risk-regime/blob/main/docs/ai-action-transparency-log.md — what a receipt proves and what it does not, wire formats, and the honest scale of this log",
      }, 200, { "cache-control": "public, max-age=60" });
    }
    // Ciò che serve a un WITNESS indipendente per firmare senza fidarsi di noi:
    // prova di consistenza (append-only) e foglie in chiaro per ricalcolare l'albero.
    if (url.pathname === "/log/consistency" && request.method === "GET") {
      const m = Number(url.searchParams.get("old")), n0 = url.searchParams.get("new");
      const N = Number((await env.COHERENCE.get("rlog:size")) || 0);
      const n = n0 === null ? N : Number(n0);
      if (!Number.isInteger(m) || !Number.isInteger(n) || !(0 < m && m <= n && n <= N))
        return json({ error: `need 0 < old <= new <= ${N}` }, 400);
      try {
        const [proof, oldRoot, newRoot] = await Promise.all([
          consistencyProof(env, m, n), treeRoot(env, m), treeRoot(env, n),
        ]);
        return json({
          origin: RLOG_ORIGIN, old: m, new: n,
          old_root: btoa(String.fromCharCode(...oldRoot)), new_root: btoa(String.fromCharCode(...newRoot)),
          proof, algorithm: "RFC 6962 §2.1.2 (SUBPROOF); node hash = SHA256(0x01 || left || right)",
          note: "Proves the tree of `old` leaves is a prefix of the tree of `new` leaves: nothing was rewritten.",
        }, 200, { "cache-control": "public, max-age=60" });
      } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (url.pathname === "/log/leaves" && request.method === "GET") {
      const start = Number(url.searchParams.get("start") || 0);
      const end = Number(url.searchParams.get("end") || start + 256);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return json({ error: "start/end must be integers" }, 400);
      return json(await leaves(env, start, end), 200, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname.startsWith("/log/proof/") && request.method === "GET") {
      const idx = Number(url.pathname.slice("/log/proof/".length));
      const N = Number((await env.COHERENCE?.get("rlog:size")) || 0);
      if (!Number.isInteger(idx) || idx < 0 || idx >= N) return json({ error: "bad index" }, 400);
      const root = await treeRoot(env, N);
      return json({ origin: RLOG_ORIGIN, index: idx, tree_size: N, root: btoa(String.fromCharCode(...root)), proof: await proofFor(env, idx, N), checkpoint: await signedCheckpoint(env, N, root) }, 200, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname.startsWith("/receipt/") && request.method === "GET") {
      const idx = Number(url.pathname.slice("/receipt/".length));
      const r = Number.isInteger(idx) && idx >= 0 ? await getReceipt(env, idx) : { status: 400, error: "bad index" };
      const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const body = r.status === 200
        ? `<h1>Receipt #${idx}</h1><p class="k">${esc(r.receipt.payload.ts)} · action <b>${esc(r.receipt.payload.action)}</b>${r.receipt.payload.demo ? " · <b>DEMO</b>" : ""}</p>
           <table>${["agent_id","tool","input_hash","output_hash"].map((k)=>`<tr><td class="k">${k}</td><td><code>${esc(r.receipt.payload[k] ?? "—")}</code></td></tr>`).join("")}
           <tr><td class="k">leaf</td><td><code>${esc(r.receipt.leaf)}</code></td></tr>
           <tr><td class="k">tree</td><td>index ${idx} of ${r.receipt.tree_size} · root <code>${esc(r.receipt.root)}</code></td></tr></table>
           <div class="box"><b>Checkpoint (C2SP signed note)</b><pre>${esc(r.receipt.checkpoint)}</pre></div>
           <div id="v" class="box">Verifying in your browser (WebCrypto)…</div>
           <p class="k">The check above runs locally in your browser: it re-derives the leaf hash from the canonical payload, rebuilds the Merkle inclusion proof to the root and verifies both Ed25519 signatures. For zero-trust verification run <a href="https://github.com/gblinproject/gblin-treasury-risk-regime">verify-receipt.mjs</a> offline. A seal proves existence and time; it is not a compliance certificate.</p>
           <p class="k">JSON: <a href="/v1/receipt/${idx}">/v1/receipt/${idx}</a> · <a href="/log">about this log</a></p>
           <script>
(async () => {
  const el = document.getElementById("v");
  const fail = (m) => { el.style.background="#7f1d1d"; el.style.color="#fff"; el.textContent = "\\u2717 verification FAILED in this browser: " + m; };
  try {
    const te = new TextEncoder();
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const b64 = (u) => btoa(String.fromCharCode(...u));
    const cat = (...p) => { const o = new Uint8Array(p.reduce((a,x)=>a+x.length,0)); let i=0; for (const x of p){o.set(x,i);i+=x.length;} return o; };
    const sha = async (u) => new Uint8Array(await crypto.subtle.digest("SHA-256", u));
    const canon = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
      : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
      : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
    const j = await (await fetch("/v1/receipt/${idx}", { cache: "no-store" })).json();
    const rec = j.receipt || j;
    const m = /^([^+]+)\\+([0-9a-f]{8})\\+([A-Za-z0-9+\\/=]+)$/.exec(rec.verifier_key);
    if (!m) return fail("bad verifier_key");
    const keyRaw = unb64(m[3]);
    if (keyRaw[0] !== 1) return fail("key alg");
    const kh = (await sha(cat(te.encode(m[1] + "\\n"), keyRaw))).slice(0, 4);
    if ([...kh].map((b)=>b.toString(16).padStart(2,"0")).join("") !== m[2]) return fail("verifier_key hash mismatch");
    const canonical = canon(rec.payload);
    const leaf = await sha(cat(Uint8Array.of(0), te.encode(canonical)));
    if (b64(leaf) !== rec.leaf) return fail("leaf hash does not match canonical payload");
    const key = await crypto.subtle.importKey("raw", keyRaw.slice(1), { name: "Ed25519" }, false, ["verify"]);
    if (!rec.signature || !(await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(rec.signature), te.encode("gblin-receipt/v1\\n" + canonical)))) return fail("receipt signature invalid or missing");
    const proof = rec.inclusion_proof.map(unb64), order = [];
    const collect = (i, a, b) => { if (b - a === 1) return; let k = 1; while (k*2 < b-a) k *= 2; if (i < a+k) { collect(i, a, a+k); order.push("R"); } else { collect(i, a+k, b); order.push("L"); } };
    collect(rec.index, 0, rec.tree_size);
    if (order.length !== proof.length) return fail("proof length mismatch");
    let cur = leaf;
    for (let j = 0; j < order.length; j++) cur = order[j] === "R" ? await sha(cat(Uint8Array.of(1), cur, proof[j])) : await sha(cat(Uint8Array.of(1), proof[j], cur));
    if (b64(cur) !== rec.root) return fail("inclusion proof does not reach the root");
    const note = rec.checkpoint, sep = note.indexOf("\\n\\n"), body = note.slice(0, sep + 1), ls = body.split("\\n");
    if (ls[0] !== m[1] || Number(ls[1]) !== rec.tree_size || ls[2] !== rec.root) return fail("checkpoint inconsistent with receipt");
    const sigLine = note.slice(sep + 2).split("\\n").find((l) => l.startsWith("\\u2014 " + m[1] + " "));
    if (!sigLine) return fail("no checkpoint signature line");
    const ps = unb64(sigLine.split(" ")[2]);
    if (ps.length !== 68 || !(await crypto.subtle.verify({ name: "Ed25519" }, key, ps.slice(4), te.encode(body)))) return fail("checkpoint signature invalid");
    el.style.background = "#14532d"; el.style.color = "#fff";
    el.textContent = "\\u2713 verified in this browser: leaf, Ed25519 receipt signature, Merkle inclusion proof \\u2192 root, signed checkpoint (tree size " + rec.tree_size + ")";
  } catch (e) { fail(String(e && e.message || e)); }
})();
</script>`
        : `<h1>Receipt not found</h1><p class="k">${esc(r.error)}</p>`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GBLIN Receipt #${idx}</title>
<style>body{font:15px/1.55 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}code,pre{font-family:ui-monospace,monospace;font-size:.82em;word-break:break-all;white-space:pre-wrap}table{border-collapse:collapse;width:100%}td{padding:.3rem .5rem;border-bottom:1px solid #e5e5e5;vertical-align:top}.k{color:#555}.box{background:#f6f6f6;border-radius:8px;padding:.9rem 1.1rem;margin:1rem 0}
@media(prefers-color-scheme:dark){body{background:#111;color:#e6e6e6}td{border-color:#2c2c2c}.box{background:#1c1c1c}}</style></head><body>${body}</body></html>`;
      return new Response(html, { status: r.status === 200 ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", ...CORS } });
    }

    // WITNESS — indice pubblico (chiave di verifica, ultimo checkpoint cofirmato per log)
    // e la nota cofirmata in chiaro, nel formato che qualsiasi verificatore C2SP legge.
    if (url.pathname === "/witness/add-checkpoint" && request.method === "POST") {
      const bodyText = await request.text();
      if (bodyText.length > 65536) return new Response("too large\n", { status: 413 });
      const r = await witnessAddCheckpoint(env, bodyText);
      return new Response(r.body, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/witness" && request.method === "GET") {
      return json(await witnessIndex(env), 200, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname.startsWith("/witness/") && request.method === "GET") {
      const parts = url.pathname.slice("/witness/".length).replace(/\/$/, "").split("/");
      const id = parts[0];
      const netCfg = await witnessConfiguredLogs(env);
      const known = WITNESSED_LOGS.some((l) => l.id === id) || Object.keys(netCfg).some((o) => "net:" + o === id || o === id);
      if (!known) return json({ error: "unknown log" }, 404);
      if (parts[1] === "history") {
        const h = await witnessHistory(env, id);
        return json({ log: id, count: h.length, entries: h.map((e) => ({ size: e.size, root: e.root, cosigned_at: e.ts, cosigned_at_iso: new Date(e.ts * 1000).toISOString(), via: e.via, url: `/witness/${id}/${e.size}` })) }, 200, { "cache-control": "public, max-age=60" });
      }
      if (parts[1] && /^\d+$/.test(parts[1])) {
        const h = await witnessHistory(env, id);
        const e = [...h].reverse().find((x) => String(x.size) === parts[1]);
        if (!e) return json({ error: "no cosigned note held for that size" }, 404);
        return new Response(e.note, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600", ...CORS } });
      }
      const note = await witnessLatestNote(env, id);
      if (!note) return json({ error: "no cosigned checkpoint yet" }, 404);
      return new Response(note, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60", ...CORS } });
    }

    // Osservatorio del catalogo x402 — vista FREE (aggregati + nostre risorse).
    if (url.pathname === "/catalog" && request.method === "GET") {
      return json(await catalogReport(env));
    }
    // Feed completo per la webapp (che lo firma e lo vende via x402).
    if (url.pathname === "/catalog/full" && request.method === "GET") {
      const full = await catalogFull(env, url.searchParams.get("token"));
      if (!full) return json({ error: "forbidden" }, 403);
      return json(full);
    }

    // One-shot genesis seal, token-gated. Writes the first on-chain proof on
    // demand (also an end-to-end test of the signing path). Idempotent: refuses
    // once genesis is done. No token configured → 404 (feature stays invisible).
    if (url.pathname === "/coherence/genesis" && request.method === "POST") {
      if (!env.SEAL_TOKEN) return json({ error: "not found" }, 404);
      if (url.searchParams.get("token") !== env.SEAL_TOKEN) return json({ error: "forbidden" }, 403);
      return json(await coherenceAttestGenesis(env));
    }

    // Manual catch-up seal, token-gated. Forces a closed-day seal run on demand —
    // e.g. to recover a day whose tx failed transiently — without waiting for the
    // daily gate. Idempotent (per-day sealKey), so it is safe to call repeatedly.
    if (url.pathname === "/coherence/seal" && request.method === "POST") {
      if (!env.SEAL_TOKEN) return json({ error: "not found" }, 404);
      if (url.searchParams.get("token") !== env.SEAL_TOKEN) return json({ error: "forbidden" }, 403);
      const complete = await coherenceAttestClosedDay(env);
      if (complete) await env.COHERENCE.put("attest:lastRun", utcDay());
      return json({ ok: true, complete, ...(await coherenceReport(env)) });
    }

    // Uso aggregato della superficie gratuita. Gratis da leggere come tutto il resto.
    if (url.pathname === "/mcp/usage" && (request.method === "GET" || request.method === "HEAD")) {
      const giorni = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 14));
      return json(await usoRecente(env, giorni), 200, { "cache-control": "public, max-age=120" });
    }

    if (url.pathname !== "/mcp") return json({ error: "not found — MCP endpoint is /mcp" }, 404);

    // Stateless server: no SSE stream to resume. Spec-permitted response.
    if (request.method === "GET") {
      return json({ error: "SSE not supported: stateless server, POST JSON-RPC to /mcp" }, 405, { Allow: "POST" });
    }
    if (request.method !== "POST") {
      return json({ error: "method not allowed" }, 405, { Allow: "POST" });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const results = [];
      for (const m of body) {
        const r = await handleMessage(m, env);
        if (r) results.push(r);
      }
      flushUso(env, ctx);
      if (results.length === 0) return new Response(null, { status: 202, headers: CORS });
      return json(results);
    }

    const result = await handleMessage(body, env);
    flushUso(env, ctx);
    if (result === null) return new Response(null, { status: 202, headers: CORS });
    return json(result);
  },

  // Cron: the automaton's heartbeat. Every 10-minute tick observes every
  // promise once; on the first tick of a new UTC day it also seals the day
  // that just closed as an on-chain attestation (no-op until the key is set).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scarica(env, true)); // eventuale lotto residuo di questo isolate
    const work = (async () => {
      // Witness first: 1-2 subrequest, mai in conflitto col budget del sigillo.
      await witnessTick(env).catch((e) => console.error("witness:", e.message));
      await coherenceObserve(env);
      await pushToWitnesses(env).catch((e) => console.error("witness push:", e && e.message));
      if (env.COHERENCE) {
        const today = utcDay();
        const marker = await env.COHERENCE.get("attest:lastRun");
        if (marker !== today) {
          // Advance the marker ONLY when every closed day is sealed. A partial
          // failure (one promise's tx fails) leaves the marker behind, so the very
          // next 10-min tick retries the missing seal instead of waiting a day.
          await witnessDiscoverLogs(env).catch((e) => console.error("witness discovery:", e && e.message));
          const done = await coherenceAttestClosedDay(env);
          const anchored = await rlogAnchorDaily(env);
          if (done && anchored) await env.COHERENCE.put("attest:lastRun", today);
        } else {
          // Giro di sonde del catalogo SOLO nei tick senza sigillo: il budget
          // free è 50 subrequest/invocazione e il sigillo ne consuma parecchi.
          // Una volta all'ora, non a ogni tick: il budget KV free e' 1000 scritture/giorno
          // e il catalogo ne scriveva una ogni 10 minuti (144) per un dato che cambia di rado.
          if (new Date().getUTCMinutes() < 10) await catalogTick(env).catch((e) => console.error("catalog:", e.message));
        }
      }
    })();
    ctx.waitUntil(work);
  },
};
