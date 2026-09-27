/**
 * Contract addresses and network settings on Base mainnet.
 *
 * The addresses are the ones of the vault in service and its periphery, verified on Basescan and
 * Sourcify. The reference list lives in the MCP server (../../src/config.ts) and in
 * https://github.com/gblinproject/GBLIN-Protocol/blob/main/docs/deployments.md; keep the three aligned.
 */

import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;

/** GBLIN vault in service: the ERC-20 index share, minted and redeemed at net asset value. */
export const GBLIN_VAULT: Address = "0xc2181d975c05c8c724b334bcED0764c0b86B1D53";
/** Read-only helper: quotes, basket rows, fee configuration, cooldowns. */
export const GBLIN_LENS: Address = "0xfCFea8027019E8551A1f09AD91532471F5D26f61";
/** Periphery: mint with any token, exit to ETH (all or nothing). */
export const GBLIN_ZAP: Address = "0x0E9D6Ceb6D313b021622C121Cda9C62e86e60200";

export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH: Address = "0x4200000000000000000000000000000000000006";
/** Uniswap V3 SwapRouter02 on Base. */
export const SWAP_ROUTER_02: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
/** Fee tier of the WETH/USDC pool the Zap and the exit use. */
export const WETH_USDC_POOL_FEE = 500;
/** Chainlink ETH/USD on Base, 8 decimals. */
export const ETH_USD_FEED: Address = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";

/** Free market-risk regime published by the hosted MCP server (same maths as the paid attestation). */
export const REGIME_URL = "https://gblin-mcp.gblin-mcp-worker.workers.dev/regime";

/**
 * Public RPC endpoints, tried in order. Several, because each refuses something: publicnode refuses
 * receipts of transactions older than a few blocks, mainnet.base.org rate-limits datacenter ranges.
 * A private endpoint (GBLIN_RPC_URL or the `rpcUrl` option) is always tried first.
 */
export const PUBLIC_RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://gateway.tenderly.co/public/base",
  "https://base-mainnet.public.blastapi.io",
];

/**
 * Gas limit for every step that goes through the Zap. The vault forwards gas-capped transfers and
 * keeps a reserve for them (the 63/64 rule): a wallet's automatic estimate lands just under what the
 * call needs and reverts out of gas. Measured on a fork of Base: the exit uses about 810,000 gas
 * and needs a limit above 1,013,000. On Base the unused part of the limit costs nothing.
 */
export const ZAP_GAS_LIMIT = 1_100_000n;
/**
 * Explicit limits for the approve and swap steps too, so no step depends on a gas estimate. An
 * estimate is computed against the state of whichever replica answers, and right after the previous
 * step that replica may not have seen it yet. Measured: approve ~29,000, swap ~118,000. On Base the
 * unused part of a limit costs nothing.
 */
export const APPROVE_GAS_LIMIT = 80_000n;
export const SWAP_GAS_LIMIT = 300_000n;

/** ERC-8021 builder code appended to every transaction we send (Base Builder Rewards attribution). */
export const BUILDER_CODE_SUFFIX = "62635f6762646f33326a300b0080218021802180218021802180218021";

export const BPS = 10_000n;
/** Slippage buffer on quotes while no basket row is shielded, and while one is. */
export const SLIPPAGE_NORMAL_BPS = 250n;
export const SLIPPAGE_SHIELD_BPS = 400n;
/** Fallback when the vault's own setting cannot be read. */
export const COOLDOWN_SECONDS_FALLBACK = 20;
/** Fallback for the oldest ETH/USD answer accepted; the live limit is read from the Lens. */
export const ORACLE_STALENESS_SECONDS = 7_200;
