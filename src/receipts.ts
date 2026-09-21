/**
 * GBLIN MCP — AI Action Receipts tools (11–13).
 *
 * Thin stdio mirrors of the hosted receipts-log surface on the Cloudflare
 * Worker (origin: gblin.digital/receipts-log). No keys, no signing here:
 * the log lives on the Worker; these tools call its public HTTP routes.
 *
 *  11. seal_action_demo → POST <worker>/v1/seal-demo   (free, 5/day/IP, demo:true)
 *  12. get_receipt      → GET  <worker>/v1/receipt/:i  (free forever)
 *  13. how_to_seal_paid → static instructions for the paid $0.01 x402 route
 */

const WORKER_BASE = "https://gblin-mcp.gblin-mcp-worker.workers.dev";
const SEAL_PAID_URL = "https://gblin.digital/api/x402/seal";
const VERIFIER_URL =
  "https://raw.githubusercontent.com/gblinproject/gblin-treasury-risk-regime/main/verify-receipt.mjs";

const RECEIPT_NOTE =
  "A seal proves existence and time in a signed append-only log (root anchored daily on Base via EAS) — NOT a compliance certificate and NOT an endorsement. PRIVACY: input/output go in as hashes only; the action/agent_id/tool/meta strings you send are published in the public log — identifiers, never secrets.";

function receiptResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function receiptError(message: string, hint?: string) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message, hint }, null, 2) },
    ],
  };
}

async function parseJsonBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await res.json();
    // il body deve essere un oggetto JSON: 42, "x", [] o null non sono risposte valide
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(`${WORKER_BASE}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 11 — seal_action_demo
// ───────────────────────────────────────────────────────────────────────────

export const SEAL_ACTION_DEMO_DEFINITION = {
  name: "seal_action_demo",
  description:
    "Seal the HASHES of an AI action into GBLIN's public append-only RFC 6962 transparency log (FREE demo, 5/day/IP, receipt marked demo:true). Returns a portable receipt: Ed25519 signature + Merkle inclusion proof + operator-signed C2SP checkpoint, offline-verifiable forever with the zero-dependency verify-receipt.mjs. Input/output go in as sha256 HASHES only; the action label and metadata you send are published in the public log. Unlimited seals cost $0.01 via x402 — see how_to_seal_paid.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        maxLength: 128,
        description: "Short public label of the action, e.g. 'trade.executed' or 'report.generated'. Published in the log — never put secrets here.",
      },
      input_hash: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
        description: "sha256 of the action input, as 64 lowercase hex chars. Hash locally; never send content.",
      },
      output_hash: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
        description: "Optional sha256 of the action output (64 lowercase hex chars).",
      },
      agent_id: {
        type: "string",
        description: "Optional public identifier of the agent (published in the log).",
      },
      tool: {
        type: "string",
        description: "Optional name of the tool/model that produced the action (published).",
      },
      meta: {
        type: "string",
        maxLength: 512,
        description: "Optional public metadata (published).",
      },
    },
    required: ["action", "input_hash"],
    additionalProperties: false,
  },
};

async function handleSealActionDemo(args: unknown) {
  try {
    const res = await workerFetch("/v1/seal-demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
    const body = await parseJsonBody(res);
    if (body === null) {
      return receiptError(`worker returned HTTP ${res.status} with a non-JSON body`, "Transient upstream error — retry the request.");
    }
    if (!res.ok) {
      return receiptError(
        String(body.error ?? `seal-demo failed (HTTP ${res.status})`),
        res.status === 429
          ? "Demo limit is 5 seals/day/IP. Unlimited seals: $0.01 via x402 — call how_to_seal_paid."
          : "Check that input_hash is 64 lowercase hex chars and action is <=128 chars."
      );
    }
    return receiptResult({ ...body, note: RECEIPT_NOTE, verify_offline: VERIFIER_URL });
  } catch (err) {
    return receiptError((err as Error).message, `Is ${WORKER_BASE} reachable from this machine?`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 12 — get_receipt
// ───────────────────────────────────────────────────────────────────────────

export const GET_RECEIPT_DEFINITION = {
  name: "get_receipt",
  description:
    "Fetch a sealed AI Action Receipt by index from GBLIN's public transparency log (free forever). Returns the full portable receipt — canonical payload, Ed25519 signature, RFC 6962 Merkle inclusion proof against the current tree, operator-signed C2SP checkpoint — which any third party can verify offline with verify-receipt.mjs (zero dependencies).",
  inputSchema: {
    type: "object" as const,
    properties: {
      index: {
        type: "integer",
        minimum: 0,
        description: "Zero-based index of the receipt in the log (see the log overview at " + WORKER_BASE + "/log for the current size).",
      },
    },
    required: ["index"],
    additionalProperties: false,
  },
};

async function handleGetReceipt(args: unknown) {
  const raw = (args as { index?: unknown })?.index;
  // alcuni client MCP mandano i numeri come stringhe JSON: coerciamo "5" -> 5
  const index = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    return receiptError("index must be a non-negative safe integer");
  }
  try {
    const res = await workerFetch(`/v1/receipt/${index}`);
    const body = await parseJsonBody(res);
    if (body === null) {
      return receiptError(`worker returned HTTP ${res.status} with a non-JSON body`, "Transient upstream error — retry the request.");
    }
    if (!res.ok) {
      return receiptError(
        String(body.error ?? `receipt fetch failed (HTTP ${res.status})`),
        `The log overview at ${WORKER_BASE}/log shows the current tree size.`
      );
    }
    return receiptResult({
      ...body,
      human_page: `${WORKER_BASE}/receipt/${index}`,
      verify_offline: VERIFIER_URL,
    });
  } catch (err) {
    return receiptError((err as Error).message, `Is ${WORKER_BASE} reachable from this machine?`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 13 — how_to_seal_paid
// ───────────────────────────────────────────────────────────────────────────

export const HOW_TO_SEAL_PAID_DEFINITION = {
  name: "how_to_seal_paid",
  description:
    "Instructions for UNLIMITED paid seals ($0.01 USDC per seal via x402 on Base) in GBLIN's AI Action Receipts transparency log — endpoint, body schema, payment flow, and how to verify receipts offline. Free demo alternative: seal_action_demo (5/day/IP).",
  inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
};

async function handleHowToSealPaid() {
  return receiptResult({
    endpoint: `POST ${SEAL_PAID_URL}`,
    price: "$0.01 USDC per seal via x402 (Base, eip155:8453)",
    flow:
      "POST without payment first → HTTP 402 with the x402 v2 challenge (PAYMENT-REQUIRED header, mirrored in the body). Settle with any x402 client (e.g. @x402/fetch): gasless EIP-3009 USDC transfer, then the same POST returns the sealed receipt.",
    body_schema: {
      action: "string, <=128 chars, required — published in the log",
      input_hash: "sha256 hex (64 lowercase chars), required — hash locally, never send content",
      output_hash: "sha256 hex, optional",
      agent_id: "string, optional — published",
      tool: "string, optional — published",
      meta: "string <=512 chars, optional — published",
    },
    receipt:
      "canonical payload + Ed25519 signature + RFC 6962 inclusion proof + operator-signed C2SP checkpoint; tree root anchored daily on Base via EAS (schema 0x9f433a96…, promiseId keccak256('gblin-receipts-log'))",
    read_free: `${WORKER_BASE}/v1/receipt/:index · ${WORKER_BASE}/log · ${WORKER_BASE}/log/checkpoint · ${WORKER_BASE}/log/proof/:index`,
    verify_offline: VERIFIER_URL,
    note: RECEIPT_NOTE,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// EXPORTS
// ───────────────────────────────────────────────────────────────────────────

// MCP tool annotations: sealing appends to a public log (not read-only, not idempotent, never
// destructive: nothing is overwritten); the other two only read.
type ToolAnnotations = { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true };
const APPEND_ONLY: ToolAnnotations = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true };

export const RECEIPT_TOOL_DEFINITIONS = [
  { ...SEAL_ACTION_DEMO_DEFINITION, annotations: APPEND_ONLY },
  { ...GET_RECEIPT_DEFINITION, annotations: READ_ONLY },
  { ...HOW_TO_SEAL_PAID_DEFINITION, annotations: READ_ONLY },
];

export const RECEIPT_TOOL_HANDLERS: Record<string, (args: unknown) => Promise<unknown>> = {
  seal_action_demo: handleSealActionDemo,
  get_receipt: handleGetReceipt,
  how_to_seal_paid: handleHowToSealPaid,
};
