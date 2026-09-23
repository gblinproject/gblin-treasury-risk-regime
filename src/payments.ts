/**
 * GBLIN MCP — paying in GBLIN with a signature (EIP-3009).
 *
 * The vault's share token implements EIP-3009, the same mechanism USDC uses: the holder signs an
 * authorization and anybody can carry it on chain, so the holder never needs ETH for gas. These two
 * tools cover the two halves of that exchange.
 *
 *   prepare_gblin_payment      → builds the EIP-712 message to sign, the calldata that carries it,
 *                                and the x402 payment payload for a paid HTTP endpoint.
 *   verify_gblin_authorization → checks a signed authorization against the chain before anyone
 *                                spends gas submitting it.
 *
 * Neither tool holds, asks for or transmits a private key. The signature is produced by the caller's
 * own wallet from the typed data returned here.
 *
 * Shapes follow the x402 "exact" scheme so an authorization built here is accepted by any x402
 * facilitator, not only by GBLIN's own endpoints.
 */

import { randomBytes } from "node:crypto";

import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  hashTypedData,
  isAddress,
  parseUnits,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

import { ERC20_ABI, GBLIN_ABI } from "./abi.js";
import { client, getOnChainTimestamp } from "./client.js";
import { BASE_CHAIN_ID, GBLIN_VAULT } from "./config.js";
import { getNavUsd } from "./helpers.js";

/** Seconds an authorization stays valid when the caller does not say otherwise. */
const DEFAULT_VALIDITY_SECONDS = 600;
/** Upper bound accepted for the validity window: a long window is a standing claim on the balance. */
const MAX_VALIDITY_SECONDS = 86_400;

/** EIP-712 type of an EIP-3009 authorization, identical for both methods. */
const AUTHORIZATION_TYPE = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

/** ERC-1271 magic value returned by a contract wallet that accepts a signature. */
const ERC1271_MAGIC = "0x1626ba7e";

const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

let domainCache: Eip712Domain | null = null;

/**
 * Reads the EIP-712 domain from the token itself (EIP-5267) instead of assuming it.
 * The domain is part of what a signature commits to: a wrong name or version produces a signature
 * that every verifier rejects, and the failure only shows up at settlement.
 */
export async function getTokenDomain(): Promise<Eip712Domain> {
  if (domainCache) return domainCache;
  const [, name, version, chainId, verifyingContract] = (await client.readContract({
    address: GBLIN_VAULT,
    abi: GBLIN_ABI,
    functionName: "eip712Domain",
  })) as [Hex, string, string, bigint, Address, Hex, bigint[]];
  domainCache = {
    name,
    version,
    chainId: Number(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
  return domainCache;
}


/**
 * MCP result envelope. The JSON also travels as `structuredContent`, which clients that support it
 * read without parsing text; clients that do not simply ignore the field.
 */
function paymentResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function paymentError(message: string, hint?: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, hint }, null, 2) }],
  };
}

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

function requireAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${field} must be a checksummed or lowercase 0x address`);
  }
  return getAddress(value);
}

/** Atomic units of GBLIN from either a share amount or a USD amount at the live NAV. */
async function resolveValue(args: Record<string, unknown>): Promise<{ value: bigint; basis: string }> {
  const shares = args.amount_gblin;
  const usd = args.amount_usd;
  if (shares !== undefined && usd !== undefined) {
    throw new Error("Give amount_gblin or amount_usd, not both");
  }
  if (shares !== undefined) {
    const value = parseUnits(String(shares), 18);
    if (value <= 0n) throw new Error("amount_gblin must be greater than zero");
    return { value, basis: "amount_gblin" };
  }
  if (usd === undefined) throw new Error("Give amount_gblin or amount_usd");
  // A USD amount needs a priceable NAV. When a feed is stale or a basket row cannot be read the vault
  // refuses to price, and the agent should be told what to do rather than handed a revert.
  let navUsd: number;
  try {
    navUsd = await getNavUsd();
  } catch {
    throw new Error(
      "The vault cannot price a share right now (a price feed is stale or a basket row cannot be read), so a USD amount cannot be converted. Pass amount_gblin instead, which needs no price."
    );
  }
  if (!Number.isFinite(navUsd) || navUsd <= 0) {
    throw new Error(
      "The vault reports no usable NAV right now, so a USD amount cannot be converted. Pass amount_gblin instead, which needs no price."
    );
  }
  // Convert through the same NAV the rest of the server publishes, then round to whole atomic units.
  const sharesFromUsd = Number(usd) / navUsd;
  if (!Number.isFinite(sharesFromUsd) || sharesFromUsd <= 0) throw new Error("amount_usd must be a positive number");
  const value = parseUnits(sharesFromUsd.toFixed(18), 18);
  if (value <= 0n) throw new Error("amount_usd is below the smallest share unit");
  return { value, basis: `amount_usd at NAV ${navUsd.toFixed(6)} USD per share` };
}

export const PREPARE_PAYMENT_TOOL = {
  name: "prepare_gblin_payment",
  description:
    "Build a gasless GBLIN payment. The vault's share token implements EIP-3009, so the holder signs an authorization and anybody can carry it on chain: the payer needs no ETH. Returns the EIP-712 message to sign (its domain is read from the token, not assumed), the calldata that carries the signed authorization, and the x402 'exact' payload for paying an HTTP endpoint in GBLIN. Use method 'receive' when paying a known recipient: only that recipient can submit it, so nobody can front-run the transfer. Use 'transfer' for an x402 facilitator, which submits on the seller's behalf. No private key is requested, held or transmitted: the signature is produced by the caller's own wallet.",
  inputSchema: {
    type: "object" as const,
    properties: {
      from: { type: "string", description: "The payer's address: the wallet that will sign." },
      to: { type: "string", description: "The recipient's address." },
      amount_gblin: { type: "string", description: "Amount in GBLIN shares, e.g. '0.25'. Give this or amount_usd." },
      amount_usd: { type: "string", description: "Amount in USD, converted at the live NAV. Give this or amount_gblin." },
      method: {
        type: "string",
        enum: ["receive", "transfer"],
        description: "'receive' (default) can be submitted only by the recipient; 'transfer' by anyone.",
      },
      valid_for_seconds: {
        type: "number",
        description: `How long the authorization stays valid. Default ${DEFAULT_VALIDITY_SECONDS}, maximum ${MAX_VALIDITY_SECONDS}.`,
      },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  annotations: {
    title: "Prepare a gasless GBLIN payment",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export async function handlePreparePayment(args: Record<string, unknown>): Promise<unknown> {
  try {
  const from = requireAddress(args.from, "from");
  const to = requireAddress(args.to, "to");
  if (from.toLowerCase() === to.toLowerCase()) throw new Error("from and to are the same address");

  const method = args.method === "transfer" ? "transfer" : "receive";
  const validity = Math.floor(Number(args.valid_for_seconds ?? DEFAULT_VALIDITY_SECONDS));
  if (!Number.isFinite(validity) || validity <= 0 || validity > MAX_VALIDITY_SECONDS) {
    throw new Error(`valid_for_seconds must be between 1 and ${MAX_VALIDITY_SECONDS}`);
  }

  const [{ value, basis }, domain, now, balance] = await Promise.all([
    resolveValue(args),
    getTokenDomain(),
    getOnChainTimestamp(),
    client.readContract({ address: GBLIN_VAULT, abi: ERC20_ABI, functionName: "balanceOf", args: [from] }) as Promise<bigint>,
  ]);

  // A random nonce, as USDC does: it is an identifier, not a counter, so authorizations never queue
  // behind each other and one that is never submitted blocks nothing.
  const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
  const validAfter = 0n;
  const validBefore = now + BigInt(validity);

  const authorization: Authorization = {
    from,
    to,
    value: value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  const primaryType = method === "receive" ? "ReceiveWithAuthorization" : "TransferWithAuthorization";
  const typedData = {
    domain,
    types: { [primaryType]: AUTHORIZATION_TYPE },
    primaryType,
    message: {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };

  return paymentResult({
    authorization,
    method,
    typed_data: typedData,
    digest: hashTypedData({
      domain,
      types: { [primaryType]: AUTHORIZATION_TYPE },
      primaryType,
      message: typedData.message as never,
    }),
    amount: {
      gblin: formatUnits(value, 18),
      atomic_units: value.toString(),
      basis,
    },
    payer_balance: {
      gblin: formatUnits(balance, 18),
      sufficient: balance >= value,
    },
    next_steps: [
      `Sign typed_data with the wallet of ${from} (eth_signTypedData_v4). The signature never leaves that wallet.`,
      "Pass the signature back to verify_gblin_authorization to check it against the chain before anyone spends gas.",
      method === "receive"
        ? `Only ${to} can submit this one: send submit.calldata to the token from that address.`
        : "Anyone can submit this one: send submit.calldata to the token, or hand the x402 payload to a facilitator.",
    ],
    submit: {
      to: GBLIN_VAULT,
      function: method === "receive" ? "receiveWithAuthorization" : "transferWithAuthorization",
      note: "Append the signature: either the 65-byte form split into v, r, s, or the single bytes form. Both are accepted.",
      calldata_template: "Call build_submit_calldata in verify_gblin_authorization once the signature exists.",
    },
    x402_payload: {
      note: "Paste the signature into payload.signature. This is the body that goes base64 in the X-PAYMENT header of an endpoint priced in GBLIN.",
      x402Version: 2,
      scheme: "exact",
      network: `eip155:${BASE_CHAIN_ID}`,
      payload: { signature: "0x…", authorization },
    },
    x402_accepts_for_sellers: {
      note: "A seller that wants to be paid in GBLIN publishes this inside the accepts array of its 402 challenge. The extra block is the token's own EIP-712 domain, read from the contract.",
      scheme: "exact",
      network: `eip155:${BASE_CHAIN_ID}`,
      asset: GBLIN_VAULT,
      extra: { name: domain.name, version: domain.version },
    },
    warnings: [
      "An authorization is a bearer claim on the balance until it expires or is used: keep validity short.",
      "The payer needs no ETH; whoever submits the authorization pays the gas.",
    ],
  });
  } catch (err) {
    return paymentError((err as Error).message, "Check the addresses and the amount, and that the RPC is reachable.");
  }
}

export const VERIFY_AUTHORIZATION_TOOL = {
  name: "verify_gblin_authorization",
  description:
    "Check a signed GBLIN authorization against the chain before spending gas on it. Recovers the signer from the EIP-712 digest (and asks the wallet itself through ERC-1271 when the payer is a contract), then checks the validity window against on-chain time, whether the nonce has already been used or cancelled, and whether the payer still holds the amount. Returns a verdict and the ready calldata when it would settle, the failing reason when it would not. This is the same set of checks an x402 facilitator runs, so a 'would_settle' verdict here means the payment is good to carry.",
  inputSchema: {
    type: "object" as const,
    properties: {
      authorization: {
        type: "object",
        description: "The authorization object: from, to, value, validAfter, validBefore, nonce.",
        additionalProperties: true,
      },
      signature: { type: "string", description: "The signature produced by the payer's wallet, 0x-prefixed." },
      method: {
        type: "string",
        enum: ["receive", "transfer"],
        description: "Which method the signature was produced for. Default 'receive'.",
      },
    },
    required: ["authorization", "signature"],
    additionalProperties: false,
  },
  annotations: {
    title: "Verify a signed GBLIN authorization",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export async function handleVerifyAuthorization(args: Record<string, unknown>): Promise<unknown> {
  try {
  const raw = (args.authorization ?? {}) as Record<string, unknown>;
  const signature = String(args.signature ?? "");
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error("signature must be 0x-prefixed hex");
  const method = args.method === "transfer" ? "transfer" : "receive";

  const from = requireAddress(raw.from, "authorization.from");
  const to = requireAddress(raw.to, "authorization.to");
  const value = BigInt(String(raw.value));
  const validAfter = BigInt(String(raw.validAfter ?? "0"));
  const validBefore = BigInt(String(raw.validBefore));
  const nonce = String(raw.nonce ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("authorization.nonce must be 32 bytes of hex");

  const primaryType = method === "receive" ? "ReceiveWithAuthorization" : "TransferWithAuthorization";
  const domain = await getTokenDomain();
  const message = {
    from,
    to,
    value: value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: nonce as Hex,
  };
  const typed = { domain, types: { [primaryType]: AUTHORIZATION_TYPE }, primaryType, message } as never;
  const digest = hashTypedData(typed);

  // The payer may be an ordinary wallet or a contract wallet. Ask the chain which one it is rather
  // than guessing from the signature length: a 65-byte signature can come from either.
  const payerCode = await client.getBytecode({ address: from });
  const payerIsContract = Boolean(payerCode && payerCode !== "0x");

  let signatureValid = false;
  let recoveredSigner: string | null = null;
  let signatureCheck: string;
  if (payerIsContract) {
    signatureCheck = "erc1271";
    try {
      const magic = (await client.readContract({
        address: from,
        abi: ERC1271_ABI,
        functionName: "isValidSignature",
        args: [digest, signature as Hex],
      })) as Hex;
      signatureValid = magic.toLowerCase() === ERC1271_MAGIC;
    } catch {
      signatureValid = false;
    }
  } else {
    signatureCheck = "ecrecover";
    try {
      recoveredSigner = await recoverTypedDataAddress({ ...(typed as object), signature: signature as Hex } as never);
      signatureValid = recoveredSigner.toLowerCase() === from.toLowerCase();
    } catch {
      signatureValid = false;
    }
  }

  const [now, used, balance] = await Promise.all([
    getOnChainTimestamp(),
    client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "authorizationState", args: [from, nonce as Hex] }) as Promise<boolean>,
    client.readContract({ address: GBLIN_VAULT, abi: ERC20_ABI, functionName: "balanceOf", args: [from] }) as Promise<bigint>,
  ]);

  const checks = {
    signature_valid: signatureValid,
    signature_checked_by: signatureCheck,
    recovered_signer: recoveredSigner,
    not_yet_valid: validAfter > now,
    expired: validBefore <= now,
    nonce_already_used_or_cancelled: used,
    balance_sufficient: balance >= value,
  };

  const failures: string[] = [];
  if (!checks.signature_valid) {
    failures.push(
      payerIsContract
        ? "The payer is a contract wallet and it did not accept this signature (ERC-1271)."
        : "The signature does not recover to the payer. A wrong EIP-712 domain, method or field order gives exactly this."
    );
  }
  if (checks.not_yet_valid) failures.push(`Not valid yet: validAfter is ${validAfter}, chain time is ${now}.`);
  if (checks.expired) failures.push(`Expired: validBefore is ${validBefore}, chain time is ${now}.`);
  if (checks.nonce_already_used_or_cancelled) failures.push("The nonce has already been used or cancelled; it cannot be replayed.");
  if (!checks.balance_sufficient) {
    failures.push(`The payer holds ${formatUnits(balance, 18)} GBLIN and the authorization is for ${formatUnits(value, 18)}.`);
  }

  const wouldSettle = failures.length === 0;
  const fn = method === "receive" ? "receiveWithAuthorization" : "transferWithAuthorization";
  const compact = signature.length === 132;
  let calldata: Hex | null = null;
  if (wouldSettle && compact) {
    const r = `0x${signature.slice(2, 66)}` as Hex;
    const s = `0x${signature.slice(66, 130)}` as Hex;
    const v = Number.parseInt(signature.slice(130, 132), 16);
    calldata = encodeFunctionData({
      abi: GBLIN_ABI,
      functionName: fn,
      args: [from, to, value, validAfter, validBefore, nonce as Hex, v, r, s],
    });
  }

  return paymentResult({
    would_settle: wouldSettle,
    method,
    digest,
    checks,
    failures,
    amount: { gblin: formatUnits(value, 18), atomic_units: value.toString() },
    submit: wouldSettle
      ? {
          to: GBLIN_VAULT,
          function: fn,
          calldata,
          who_may_submit: method === "receive" ? to : "anyone",
          gas_hint: 120_000,
          note: calldata
            ? "Send this calldata to the token. The payer spends no ETH."
            : "The signature is not the 65-byte form, so the v/r/s calldata was not built; submit it through the bytes overload.",
        }
      : null,
    source: "GBLIN EIP-3009 authorization verifier — EIP-712 domain read from the token, state read from Base",
  });
  } catch (err) {
    return paymentError((err as Error).message, "Check the authorization fields and the signature encoding.");
  }
}
