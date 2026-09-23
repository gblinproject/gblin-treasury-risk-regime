/**
 * GBLIN MCP — resources.
 *
 * Reference data an agent reads once and keeps: the deployment, the keys to pin, how to pay in
 * GBLIN, and what this server costs. Anything that can change on chain is read live when the
 * resource is requested, never written into the text.
 */

import { getAddress } from "viem";

import {
  BASE_CHAIN_ID,
  GBLIN_ATTESTOR,
  GBLIN_AUCTION_ORDER,
  GBLIN_FILL_AGENT,
  GBLIN_GUARDIAN,
  GBLIN_LENS,
  GBLIN_POOL,
  GBLIN_PREVIOUS,
  GBLIN_PREVIOUS_2,
  GBLIN_SENTINEL,
  GBLIN_TIMELOCK,
  GBLIN_UNISWAP_ADAPTER,
  GBLIN_VAULT,
  GBLIN_ZAP,
  USDC,
  WETH,
} from "./config.js";
import { getTokenDomain } from "./payments.js";
import { TOOL_PRICES } from "./paywall.js";

const EXPLORER = "https://basescan.org/address/";
const HOSTED_MCP = "https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp";

export interface ResourceDefinition {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: "application/json";
}

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    uri: "gblin://contracts",
    name: "contracts",
    title: "GBLIN deployment on Base",
    description:
      "Every contract of the deployment in service, with its role and explorer link, and the earlier deployments that must not be used.",
    mimeType: "application/json",
  },
  {
    uri: "gblin://payments",
    name: "payments",
    title: "Paying and being paid in GBLIN",
    description:
      "How GBLIN is paid with a signature and no ETH (EIP-3009): the EIP-712 domain read live from the token, the x402 payload shape, and the accepts block a seller publishes to be paid in GBLIN.",
    mimeType: "application/json",
  },
  {
    uri: "gblin://keys",
    name: "keys",
    title: "Keys to pin",
    description:
      "The address that signs GBLIN risk attestations, which a verifier must pin, and where the transparency-log and witness keys are published.",
    mimeType: "application/json",
  },
  {
    uri: "gblin://limits",
    name: "limits",
    title: "What this server costs and limits",
    description:
      "This server runs locally and holds no keys. Which tools could be metered, at what price, and what limits come from the RPC rather than from the server.",
    mimeType: "application/json",
  },
];

const link = (address: string) => `${EXPLORER}${getAddress(address)}`;

async function readContracts(): Promise<Record<string, unknown>> {
  const entry = (address: string, role: string) => ({ address: getAddress(address), role, explorer: link(address) });
  return {
    network: `eip155:${BASE_CHAIN_ID}`,
    in_service: {
      vault: entry(GBLIN_VAULT, "The index and its ERC-20 share token. Mints and redeems at NAV."),
      lens: entry(GBLIN_LENS, "Read-only quotes and state for the vault."),
      zap: entry(GBLIN_ZAP, "Mints with any token and exits to ETH in one transaction."),
      sequencer_sentinel: entry(GBLIN_SENTINEL, "Sequencer uptime check and bounded pause guardian."),
      uniswap_v3_adapter: entry(GBLIN_UNISWAP_ADAPTER, "Swap adapter used by the vault and the Zap."),
      cow_fill_agent: entry(GBLIN_FILL_AGENT, "Fills the rebalancing auction through CoW Protocol solvers."),
      auction_order_handler: entry(GBLIN_AUCTION_ORDER, "ComposableCoW order handler for the auction."),
      timelock: entry(GBLIN_TIMELOCK, "Owner of the vault and the sentinel; every change waits 48 hours."),
      pool: entry(GBLIN_POOL, "Uniswap V3 WETH/GBLIN pool, fee tier 0.3%."),
    },
    roles: {
      guardian: { address: getAddress(GBLIN_GUARDIAN), note: "May pause minting for a bounded period; redemption in kind stays open." },
    },
    deprecated: {
      note: "Earlier deployments. They are not the token in service and must not be linked or bought.",
      contracts: [getAddress(GBLIN_PREVIOUS), getAddress(GBLIN_PREVIOUS_2)],
    },
    assets: { weth: getAddress(WETH), usdc: getAddress(USDC) },
  };
}

async function readPayments(): Promise<Record<string, unknown>> {
  const domain = await getTokenDomain();
  return {
    mechanism:
      "EIP-3009. The holder signs an authorization; anybody can carry it on chain, so the payer needs no ETH. A used or cancelled nonce can never be replayed.",
    eip712_domain: { ...domain, source: "read live from the token through eip712Domain() (EIP-5267)" },
    methods: {
      receiveWithAuthorization: "Only the recipient can submit it, so nobody can front-run the transfer. Use it to pay a known counterparty.",
      transferWithAuthorization: "Anybody can submit it. This is what an x402 facilitator carries on the seller's behalf.",
    },
    tools: {
      prepare: "prepare_gblin_payment builds the message to sign, the calldata and the x402 payload.",
      verify: "verify_gblin_authorization checks a signed authorization against the chain before anyone spends gas.",
      relay: "relay_gblin_payment hands a signed payment and a signed fee to GBLIN's relay, for a payer that holds no ETH and has nobody to carry it.",
    },
    relay: {
      url: process.env.GBLIN_RELAY_URL ?? "https://gblin.digital/api/relay/gblin",
      fee: "Quoted live by a GET on the relay URL, in GBLIN at the NAV. Paid with a second authorization from the payer.",
      atomicity: "The payment and the fee are submitted in one transaction through Multicall3: both settle or neither does.",
    },
    x402_payment_payload: {
      x402Version: 2,
      scheme: "exact",
      network: `eip155:${BASE_CHAIN_ID}`,
      payload: { signature: "0x…", authorization: { from: "0x…", to: "0x…", value: "atomic units", validAfter: "0", validBefore: "unix seconds", nonce: "0x… (32 bytes)" } },
    },
    x402_accepts_for_sellers: {
      scheme: "exact",
      network: `eip155:${BASE_CHAIN_ID}`,
      asset: getAddress(GBLIN_VAULT),
      extra: { name: domain.name, version: domain.version },
      note: "The extra block is the token's EIP-712 domain. A facilitator uses it to verify the signature.",
    },
    decimals: 18,
  };
}

function readKeys(): Record<string, unknown> {
  return {
    risk_attestation_attestor: {
      address: getAddress(GBLIN_ATTESTOR),
      rule: "Pin this address. Checking a signature against the attestor field of the same response proves nothing.",
      used_by: "verify_risk_attestation",
    },
    transparency_log_and_witness: {
      published_by: HOSTED_MCP,
      how: "Read the gblin://keys resource of the hosted server; it carries the log verifier key, the witness key and the rotation policy.",
    },
  };
}

function readLimits(): Record<string, unknown> {
  const metered = Object.fromEntries(Object.entries(TOOL_PRICES).map(([name, def]) => [name, def.priceLabel]));
  return {
    runs: "locally, over stdio. The server holds no keys and never sends a transaction.",
    rate_limit: "none of its own. The practical limit is the RPC in GBLIN_RPC_URL.",
    price: "Every tool is free by default.",
    metered_when_enabled: {
      switch: 'MCP_PAYWALL="true"',
      tools: metered,
      note: "Off by default: a stdio server cannot verify and settle a payment on its own, so metering it would be bypassable.",
    },
    paid_endpoints: "Paid data lives on x402 HTTP endpoints at https://gblin.digital, not in this server.",
  };
}

export async function readResource(uri: string): Promise<Record<string, unknown> | null> {
  switch (uri) {
    case "gblin://contracts":
      return readContracts();
    case "gblin://payments":
      return readPayments();
    case "gblin://keys":
      return readKeys();
    case "gblin://limits":
      return readLimits();
    default:
      return null;
  }
}
