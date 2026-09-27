/**
 * Read client with endpoint rotation, and a receipt reader that asks every endpoint in turn.
 *
 * A fallback transport moves on only when an endpoint errors; an endpoint a block behind answers
 * "no receipt yet" without erroring, and a transaction already mined would be reported as pending.
 * Receipts are therefore asked endpoint by endpoint until one has them.
 */

import { createPublicClient, fallback, http, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { base } from "viem/chains";

import { PUBLIC_RPCS } from "./config.js";

export function rpcUrls(preferred?: string): string[] {
  const first = preferred ?? process.env.GBLIN_RPC_URL;
  return first ? [first, ...PUBLIC_RPCS.filter((u) => u !== first)] : [...PUBLIC_RPCS];
}

export function makeClient(preferred?: string): PublicClient {
  const urls = rpcUrls(preferred);
  return createPublicClient({
    chain: base,
    transport: fallback(
      urls.map((u) => http(u, { timeout: 12_000, retryCount: 1, retryDelay: 400 })),
      { rank: false }
    ),
  }) as PublicClient;
}

/** Waits for a receipt, asking each endpoint in turn; gives up after `timeoutMs`. */
export async function waitForReceipt(preferred: string | undefined, hash: Hex, timeoutMs = 90_000): Promise<TransactionReceipt> {
  const clients = rpcUrls(preferred).map((u) =>
    createPublicClient({ chain: base, transport: http(u, { timeout: 8_000, retryCount: 0 }) })
  );
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const c of clients) {
      const r = await c.getTransactionReceipt({ hash }).catch(() => null);
      if (r) return r;
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }
  throw new Error(`No receipt for ${hash} within ${timeoutMs / 1000}s: the transaction may still be pending. Check it on basescan.org before retrying.`);
}
