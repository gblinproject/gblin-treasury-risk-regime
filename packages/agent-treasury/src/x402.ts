/**
 * x402 payments backed by the treasury.
 *
 * The client is Coinbase's reference `x402Client` with the EVM "exact" scheme; the treasury attaches to
 * its `onBeforePaymentCreation` hook: when a 402 selects a USDC payment on Base, the wallet's USDC is
 * topped up from GBLIN before the authorization is signed, and a payment above the policy cap is
 * refused before anything is signed. Everything else is the standard protocol flow.
 */

import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm";
import { wrapFetchWithPayment } from "@x402/fetch";
import { formatUnits, parseUnits } from "viem";

import { BASE_CHAIN_ID, USDC } from "./config.js";
import type { Treasury } from "./treasury.js";

const BASE_NETWORK = `eip155:${BASE_CHAIN_ID}`;

/** USDC amount (atomic units) a requirement asks for on Base, or null when it is not a Base USDC requirement. */
export function baseUsdcAmount(req: PaymentRequirements): bigint | null {
  const r = req as unknown as { network?: string; asset?: string; amount?: string; maxAmountRequired?: string };
  if (r.network !== BASE_NETWORK) return null;
  if ((r.asset ?? "").toLowerCase() !== USDC.toLowerCase()) return null;
  const raw = r.amount ?? r.maxAmountRequired;
  if (!raw || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

export interface TreasuryX402Options {
  /** Overrides the policy's maxPayUsdc for this client. */
  maxPayUsdc?: number;
}

/** An x402 client whose USDC is refilled from GBLIN just in time. */
export function createX402Client(treasury: Treasury, options: TreasuryX402Options = {}): x402Client {
  const signer = treasury.treasurySigner;
  const cap = parseUnits(String(options.maxPayUsdc ?? treasury.policy.maxPayUsdc), 6);
  const client = new x402Client().register(BASE_NETWORK, new ExactEvmScheme({ address: signer.address, signTypedData: (m) => signer.signTypedData(m) }));
  // Prefer Base USDC when the server offers several ways to pay.
  client.registerPolicy((_version, reqs) => {
    const preferred = reqs.filter((r) => baseUsdcAmount(r) !== null);
    return preferred.length ? preferred : reqs;
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    const amount = baseUsdcAmount(selectedRequirements);
    if (amount === null) return; // not our asset: the scheme decides
    if (amount > cap) return { abort: true, reason: `The resource asks ${formatUnits(amount, 6)} USDC, above the treasury cap of ${formatUnits(cap, 6)} USDC per payment.` };
    try {
      await treasury.ensureUsdc(formatUnits(amount, 6));
    } catch (err) {
      return { abort: true, reason: `Could not make ${formatUnits(amount, 6)} USDC available: ${(err as Error).message}` };
    }
  });
  return client;
}

/** `fetch` that pays x402 invoices from the treasury, refilling USDC from GBLIN when needed. */
export function createTreasuryFetch(treasury: Treasury, options: TreasuryX402Options = {}): typeof globalThis.fetch {
  return wrapFetchWithPayment(globalThis.fetch, createX402Client(treasury, options)) as typeof globalThis.fetch;
}
