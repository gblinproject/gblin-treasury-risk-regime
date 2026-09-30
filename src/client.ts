/**
 * GBLIN MCP — viem Public Client
 *
 * Read-only Base mainnet client. The MCP server never signs or broadcasts;
 * it only reads state and builds calldata for the agent's wallet to execute.
 */

import { createPublicClient, fallback, http, type PublicClient, type Transport } from "viem";
import { base } from "viem/chains";
import { DEFAULT_RPC_URL, PUBLIC_RPC_URLS, RPC_URL } from "./config.js";

const HTTP_OPTIONS = { timeout: 10_000, retryCount: 2, retryDelay: 500 };

// An explicit GBLIN_RPC_URL is used alone. Without one, the public RPCs are tried in order: a
// provider that rate-limits a burst of reads hands the call to the next, instead of failing it.
const transport =
  RPC_URL === DEFAULT_RPC_URL
    ? fallback(PUBLIC_RPC_URLS.map((url) => http(url, HTTP_OPTIONS)), { rank: false })
    : http(RPC_URL, HTTP_OPTIONS);

export const client: PublicClient<Transport, typeof base> = createPublicClient({ chain: base, transport });

/**
 * Fetch the latest block timestamp from the chain.
 * Used for cooldown checks — never trust local clock (Date.now()).
 */
export async function getOnChainTimestamp(): Promise<bigint> {
  const block = await client.getBlock();
  return block.timestamp;
}
