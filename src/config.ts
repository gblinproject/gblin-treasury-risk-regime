/**
 * GBLIN MCP — Network Configuration
 *
 * All addresses, constants, and tunable parameters.
 * Addresses and constants of the vault in service on Base mainnet, taken from the verified sources.
 */

import type { Address } from "viem";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

// ─── Version ────────────────────────────────────────────────────────────────
export const PACKAGE_VERSION = pkg.version;

// ─── Network ────────────────────────────────────────────────────────────────
export const BASE_CHAIN_ID = 8453;
// publicnode.com is a free, no-key, generously-rated Base mainnet RPC
// (verified May 2026). Users can override via GBLIN_RPC_URL for Alchemy/QuickNode.
export const DEFAULT_RPC_URL = "https://base-rpc.publicnode.com";

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const _rawRpc = process.env.GBLIN_RPC_URL;
if (_rawRpc && !isValidHttpUrl(_rawRpc)) {
  console.error(
    `[gblin-mcp] GBLIN_RPC_URL="${_rawRpc}" is not a valid HTTP URL — falling back to ${DEFAULT_RPC_URL}`
  );
}
export const RPC_URL =
  _rawRpc && isValidHttpUrl(_rawRpc) ? _rawRpc : DEFAULT_RPC_URL;

// ─── Core contracts (Base mainnet, source verified) ─────────────────────────
// The vault in service: shares are minted at NAV and redeemed pro rata in kind. It never swaps.
export const GBLIN_VAULT: Address = "0xc2181d975c05c8c724b334bcED0764c0b86B1D53";
// Read-only helper beside the vault: quotes, configuration, basket rows and auction state.
export const GBLIN_LENS: Address = "0xfCFea8027019E8551A1f09AD91532471F5D26f61";
// The only contract that swaps: it mints with any token and exits to ETH by redeeming in kind and
// selling the legs on a venue. The vault's own side is always a mint at NAV or a redemption in kind.
export const GBLIN_ZAP: Address = "0x0E9D6Ceb6D313b021622C121Cda9C62e86e60200";
// Previous deployment, superseded. Kept only so that risk attestations signed under EIP-712 domain
// version 1 remain verifiable; nothing is read from it.
export const GBLIN_PREVIOUS: Address = "0x36C81d7E1966310F305eA637e761Cf77F90852f0";
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH: Address = "0x4200000000000000000000000000000000000006";

// GblinTimelockController: 48-hour minimum delay, 14-day grace period, open executor.
export const GBLIN_TIMELOCK: Address = "0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd";
// Holder of CANCELLER_ROLE on the timelock (veto), kept separate from PROPOSER_ROLE.
export const GBLIN_GUARDIAN: Address = "0x30590c0D05c26562d7296CE3D927d3418d2e6dcA";
export const EXPECTED_MIN_DELAY_SECONDS = 172_800n; // 48 hours

// Chainlink ETH/USD price feed on Base
export const ETH_USD_FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

// ─── Risk Attestation ────────────────────────────────────────────────────────
// GBLIN's published attestor address — the EOA that EIP-712-signs Risk
// Attestations served by https://gblin.digital/api/x402/attestation. This key
// only signs off-chain messages: it never holds funds and never sends txs.
// Agents treat this as the trusted signer when verifying attestations via
// verify_risk_attestation. Override with GBLIN_ATTESTOR_ADDRESS to rotate it.
const _attestorEnv = process.env.GBLIN_ATTESTOR_ADDRESS;
export const GBLIN_ATTESTOR: Address =
  _attestorEnv && /^0x[0-9a-fA-F]{40}$/.test(_attestorEnv)
    ? (_attestorEnv as Address)
    : "0x3ae65d36e8b1d82B0B80669E769A3dc300D543e4";

// Uniswap V3 pool fee tier for the WETH->USDC leg of the JIT redemption
export const WETH_USDC_POOL_FEE = 500; // 0.05%

// ─── Protocol constants (mirror the vault's own settings) ──────────────────────────────
// Redemption cooldown after a mint, in seconds. Read live from the Lens; this value is only the fallback when that read fails.
export const COOLDOWN_SECONDS_FALLBACK = 20;
export const ORACLE_STALENESS_SECONDS = 86_400; // 24h Chainlink heartbeat

// ─── Slippage Buffers (basis points) ────────────────────────────────────────
// Applied on top of contract-internal slippage (maxInternalSlippage = 200 bps)
export const SLIPPAGE_NORMAL_BPS = 250n; // 2.5% — calm market
export const SLIPPAGE_CRASH_SHIELD_BPS = 400n; // 4.0% — Crash Shield active
export const BPS_DENOMINATOR = 10_000n;

// ─── Caching ────────────────────────────────────────────────────────────────
export const NAV_CACHE_TTL_MS = 30_000; // 30 seconds
export const BASKET_CACHE_TTL_MS = 60_000; // 60 seconds

// ─── Metadata ───────────────────────────────────────────────────────────────
export const SERVER_NAME = "gblin-treasury-mcp";
export const SERVER_VERSION = pkg.version;
