#!/usr/bin/env node
/**
 * GBLIN MCP Server — entry point.
 *
 * Speaks the Model Context Protocol over stdio and exposes three primitives: tools (TOOL_DEFINITIONS),
 * prompts (PROMPT_DEFINITIONS) and resources (RESOURCE_DEFINITIONS). The server holds no keys and never
 * sends a transaction: tools that act return unsigned calldata or typed data for the caller's wallet.
 *
 * IMPORTANT: never write to stdout via console.log — that channel is reserved
 * for MCP JSON-RPC frames. Use console.error (stderr) for diagnostics.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { PROMPT_DEFINITIONS, getPrompt } from "./prompts.js";
import { RESOURCE_DEFINITIONS, readResource } from "./resources.js";
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "./tools.js";

// Sent in the initialize result: a short, factual map of what this server does.
const INSTRUCTIONS =
  "GBLIN stdio MCP (" + SERVER_NAME + " v" + SERVER_VERSION + "). GBLIN is an on-chain index of cbBTC, WETH and USDC on Base, " +
  "minted and redeemed at NAV. This server holds no keys and never sends a transaction: tools that act return unsigned " +
  "calldata or typed data for your own wallet to sign. " +
  "Read: get_treasury_state, get_governance_state, get_auction_state (the vault rebalances by Dutch auction), " +
  "get_market_risk_regime (calm|elevated|crash), analyze_treasury_health, quote_safe_swap, get_nav_history (NAV beside ETH and BTC). " +
  "Act, in this order: prepare_action (any operation: mint with ETH, WETH or USDC, redeem in kind, exit to ETH or USDC, bid), " +
  "preview_steps (simulate the steps before signing; it finds the gas each vault step really needs), send from your wallet, " +
  "then get_transaction_status. Shortcuts: swap_gblin_to_usdc_jit (exit to USDC to pay an invoice), invest_usdc_to_gblin. " +
  "Pay in GBLIN with a signature and no ETH (EIP-3009, x402 'exact'): prepare_gblin_payment, then verify_gblin_authorization; " +
  "when nobody else will carry it, prepare with relay: true and hand both signatures to relay_gblin_payment (fee in GBLIN, one atomic transaction). " +
  "Verify: verify_risk_attestation (pure EIP-712 math). Receipts: seal_action_demo, get_receipt, how_to_seal_paid. " +
  "Prompts: risk_gate, pay_in_gblin, pay_invoice_just_in_time, seal_and_verify. " +
  "Resources: gblin://contracts, gblin://payments, gblin://keys, gblin://limits. " +
  "Every tool is free; paid data lives on x402 HTTP endpoints at https://gblin.digital (docs: https://gblin.digital/llms.txt).";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPT_DEFINITIONS }));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const prompt = getPrompt(name, (args ?? {}) as Record<string, unknown>);
  if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  return prompt;
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCE_DEFINITIONS }));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const body = await readResource(uri);
  if (!body) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

/**
 * Tools that existed in earlier releases and no longer do. A caller that integrated against
 * an older version is told what to call instead, rather than only that the name is unknown.
 */
const RETIRED_TOOLS: Record<string, { use: string; why: string }> = {
  find_keeper_bounty: {
    use: "get_auction_state",
    why: "The vault in service rebalances through a Dutch auction and pays no keeper bounty; get_auction_state reports whether the auction is open, the premium and the gap per basket row.",
  },
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    // A caller that integrated before a rename gets the replacement, not a dead end.
    const replacement = RETIRED_TOOLS[name];
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            replacement
              ? { error: `Unknown tool: ${name}`, retired: true, use_instead: replacement.use, reason: replacement.why }
              : { error: `Unknown tool: ${name}`, available: Object.keys(TOOL_HANDLERS) }
          ),
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
