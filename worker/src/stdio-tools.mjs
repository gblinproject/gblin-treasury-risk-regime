/**
 * The npm package's tools, served by the hosted server under two-level names.
 *
 * The handlers are imported from ../../src, the same code the stdio package runs, so the two servers
 * cannot drift: a fix there is a fix here at the next deploy. Every handler returns a complete MCP
 * tool result (content, structuredContent, isError), which is passed through untouched.
 *
 * The stdio names are accepted as unlisted aliases, because the tools' own descriptions refer to each
 * other by those names ("simulate with preview_steps").
 */

import { TOOL_DEFINITIONS, TOOL_HANDLERS } from "../../src/tools.ts";

/** Hosted name → stdio name. */
const MAP = {
  "treasury.state": "get_treasury_state",
  "treasury.quote": "quote_safe_swap",
  "treasury.health": "analyze_treasury_health",
  "treasury.nav_history": "get_nav_history",
  "actions.prepare": "prepare_action",
  "actions.preview": "preview_steps",
  "actions.status": "get_transaction_status",
  "governance.state": "get_governance_state",
  "auction.state": "get_auction_state",
  "payments.prepare": "prepare_gblin_payment",
  "payments.verify": "verify_gblin_authorization",
  "payments.relay": "relay_gblin_payment",
  "attestation.verify": "verify_risk_attestation",
};

export const BRIDGED_TOOLS = Object.entries(MAP).map(([hosted, stdio]) => {
  const def = TOOL_DEFINITIONS.find((t) => t.name === stdio);
  if (!def) throw new Error(`stdio tool ${stdio} not found`);
  return { ...def, name: hosted };
});

/** stdio name → hosted name, accepted by tools/call but not listed. */
export const BRIDGED_ALIASES = Object.fromEntries(Object.entries(MAP).map(([hosted, stdio]) => [stdio, hosted]));

export function isBridged(name) {
  return Object.prototype.hasOwnProperty.call(MAP, name);
}

/** Runs the stdio handler and returns its MCP tool result as is. */
export async function callBridged(name, args) {
  return TOOL_HANDLERS[MAP[name]](args ?? {});
}
