#!/usr/bin/env node
/**
 * GBLIN MCP Server — entry point.
 *
 * Speaks the Model Context Protocol over stdio. Clients (desktop assistants,
 * AgentKit, Eliza, custom agents) discover and invoke the GBLIN tools listed
 * in TOOL_DEFINITIONS (13 as of 0.3.1: treasury/governance, risk regime,
 * risk attestation verification and the receipts trio).
 *
 * IMPORTANT: never write to stdout via console.log — that channel is reserved
 * for MCP JSON-RPC frames. Use console.error (stderr) for diagnostics.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools.js";

// Sent in the initialize result. The hosted HTTP server has had one since August; this
// package sent none, so a client saw 13 bare tool names and no map. Kept short and factual.
const INSTRUCTIONS =
  "GBLIN stdio MCP (" + SERVER_NAME + " v" + SERVER_VERSION + "). Read-only tools need no key: " +
  "get_market_risk_regime (calm|elevated|crash from the on-chain Crash Shield on Base), " +
  "get_treasury_state, get_governance_state, analyze_treasury_health, quote_safe_swap, " +
  "find_keeper_bounty, verify_risk_attestation (pure EIP-712 math), share_skill_with_peer. " +
  "swap_gblin_to_usdc_jit and invest_usdc_to_gblin build transactions and need a signer " +
  "configured by the operator. Receipts: seal_action_demo (5/day/IP, marked demo:true), " +
  "get_receipt, how_to_seal_paid (unlimited seals are a paid x402 HTTP endpoint, $0.01 USDC). " +
  "Everything here is free; paid signals are x402 HTTP endpoints at https://gblin.digital/api/x402 " +
  "(docs: https://gblin.digital/llms.txt). A hosted, no-install variant with a different, smaller " +
  "tool set lives at https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp.";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return handler(args ?? {}) as any;
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[${SERVER_NAME}] v${SERVER_VERSION} online — listening on stdio (${TOOL_DEFINITIONS.length} tools registered).`
  );
}

main().catch((err) => {
  console.error("[gblin-mcp] fatal:", err);
  process.exit(1);
});
