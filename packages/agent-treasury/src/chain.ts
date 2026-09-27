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

/**
 * Endpoints in the order they are tried: the preferred one (argument or GBLIN_RPC_URL), then the
 * public list. GBLIN_RPC_URLS (comma-separated) replaces the public list entirely, for operators who
 * run their own endpoints or test against a fork.
 */
export function rpcUrls(preferred?: string): string[] {
  const first = preferred ?? process.env.GBLIN_RPC_URL;
  const configured = (process.env.GBLIN_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const rest = configured.length ? configured : PUBLIC_RPCS;
  return first ? [first, ...rest.filter((u) => u !== first)] : [...rest];
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

/**
 * Runs a read pinned to `blockNumber`, asking each endpoint in turn until one has that block.
 *
 * Load-balanced endpoints answer from replicas that can be a block or two behind: a balance read
 * right after a confirmed transaction may come from a replica that has not seen it, and "latest"
 * would silently return the old value. Pinning the read to the block of the receipt makes a lagging
 * replica error instead of lying; the next endpoint is asked, and the rotation is retried until
 * `timeoutMs` passes.
 */
export async function readAtBlock<T>(
  preferred: string | undefined,
  blockNumber: bigint,
  read: (client: PublicClient, blockNumber: bigint) => Promise<T>,
  timeoutMs = 45_000
): Promise<T> {
  const clients = rpcUrls(preferred).map(
    (u) => createPublicClient({ chain: base, transport: http(u, { timeout: 8_000, retryCount: 0 }) }) as PublicClient
  );
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    for (const c of clients) {
      try {
        return await read(c, blockNumber);
      } catch (err) {
        lastError = String((err as Error).message ?? err).split("\n")[0] ?? "";
      }
    }
    await new Promise((res) => setTimeout(res, 1_500));
  }
  throw new Error(`No endpoint served block ${blockNumber} within ${timeoutMs / 1000}s (last error: ${lastError}).`);
}
