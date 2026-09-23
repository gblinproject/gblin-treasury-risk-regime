/**
 * GBLIN MCP — helpers shared by every tool module: the MCP result envelopes, the builder-code
 * suffix, the routing data the Zap needs, and the gas limit set on Zap steps.
 */

import { encodeAbiParameters } from "viem";

import { LENS_ABI } from "./abi.js";
import { client } from "./client.js";
import { GBLIN_LENS, GBLIN_VAULT, WETH_USDC_POOL_FEE } from "./config.js";

// ───────────────────────────────────────────────────────────────────────────
// ERC-8021 Builder Code attribution (Base Builder Rewards)
// ───────────────────────────────────────────────────────────────────────────

export const BUILDER_CODE_SUFFIX = "62635f6762646f33326a300b0080218021802180218021802180218021";

// Routing data the Zap hands to its swap adapter: the Uniswap V3 fee tier of the pair, ABI-encoded.
export const VENUE_FEE_DATA = encodeAbiParameters([{ type: "uint24" }], [WETH_USDC_POOL_FEE]);

/**
 * Gas limit set on every step that goes through the Zap. The vault forwards gas-capped transfers
 * and keeps a reserve for them (the 63/64 rule), so a wallet's automatic estimate can land just
 * under what the call needs and revert out of gas. Measured on a fork of Base: the exit uses about
 * 810,000 and needs a limit above 1,013,000; the investment uses about 720,000 against an estimate
 * of 855,000. On Base the extra limit costs nothing unless it is used.
 */
export const ZAP_GAS_LIMIT = 1_100_000;
export const ZAP_GAS_NOTE =
  "Every Zap step carries gas: send it with that limit. An automatic estimate can fall just under what the call needs, because the vault reserves gas for its capped transfers, and the step then reverts out of gas.";

/** One routing entry per basket row, index for index; WETH and abandoned rows ignore theirs. */
export async function venueDataPerRow(): Promise<`0x${string}`[]> {
  const n = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "basketLength", args: [GBLIN_VAULT] }).catch(() => 3n);
  return Array.from({ length: Number(n) }, () => VENUE_FEE_DATA);
}

export function appendBuilderCode(calldata: string): string {
  // Strip 0x if present, append suffix, restore 0x prefix
  const hex = calldata.startsWith("0x") ? calldata.slice(2) : calldata;
  return "0x" + hex + BUILDER_CODE_SUFFIX;
}

// ───────────────────────────────────────────────────────────────────────────
// MCP result envelopes
// ───────────────────────────────────────────────────────────────────────────

export function toolResult(payload: unknown) {
  // The JSON also travels as `structuredContent`: clients that support it read the object without
  // parsing text, and clients that do not simply ignore the field. Only a plain object qualifies.
  const structured =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (JSON.parse(JSON.stringify(payload, jsonReplacer)) as Record<string, unknown>)
      : undefined;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, jsonReplacer, 2),
      },
    ],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function toolError(message: string, hint?: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, hint }, null, 2),
      },
    ],
  };
}

/** JSON.stringify replacer that turns BigInt into string. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
