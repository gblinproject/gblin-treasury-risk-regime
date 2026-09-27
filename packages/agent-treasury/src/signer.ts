/**
 * What the treasury needs from a wallet: an address, the ability to send a transaction, and the
 * ability to sign EIP-712 typed data (x402 payments are signed authorizations). A viem local account
 * satisfies both; so does any wallet provider that exposes the same two operations.
 */

import { createWalletClient, http, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { rpcUrls } from "./chain.js";

export interface TypedDataRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface TreasurySigner {
  readonly address: Address;
  sendTransaction(tx: { to: Address; data: Hex; value: bigint; gas?: bigint }): Promise<Hex>;
  signTypedData(request: TypedDataRequest): Promise<Hex>;
}

/** A signer from a viem local account (for example `privateKeyToAccount`). */
export function fromAccount(account: LocalAccount, rpcUrl?: string): TreasurySigner {
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrls(rpcUrl)[0]) });
  return {
    address: account.address,
    sendTransaction: (tx) => wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, ...(tx.gas ? { gas: tx.gas } : {}) }),
    // The account's generic signature is stricter than the loose shape the x402 signer passes; the
    // request is forwarded unchanged.
    signTypedData: (req) => (account.signTypedData as unknown as (r: TypedDataRequest) => Promise<Hex>)(req),
  };
}

/** A signer from a raw private key. The key never leaves the process. */
export function fromPrivateKey(privateKey: Hex, rpcUrl?: string): TreasurySigner {
  return fromAccount(privateKeyToAccount(privateKey), rpcUrl);
}
