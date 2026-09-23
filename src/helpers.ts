/**
 * GBLIN MCP — Core Helpers
 *
 * Domain logic shared by all tools: NAV calculation, Crash Shield detection,
 * dynamic slippage, cooldown checks, and reverse JIT quoting.
 *
 * All functions are read-only against Base mainnet. No private keys involved.
 */

import { formatUnits, parseUnits } from "viem";
import type { Address } from "viem";

import { client, getOnChainTimestamp } from "./client.js";
import {
  CHAINLINK_AGGREGATOR_ABI,
  ERC20_ABI,
  GBLIN_ABI,
  LENS_ABI,
} from "./abi.js";
import {
  BASKET_CACHE_TTL_MS,
  BPS_DENOMINATOR,
  COOLDOWN_SECONDS_FALLBACK,
  ETH_USD_FEED,
  GBLIN_LENS,
  GBLIN_VAULT,
  NAV_CACHE_TTL_MS,
  ORACLE_STALENESS_SECONDS,
  STABLE_PRICE_MAX_AGE_SECONDS,
  SLIPPAGE_CRASH_SHIELD_BPS,
  SLIPPAGE_NORMAL_BPS,
  USDC,
} from "./config.js";

// ───────────────────────────────────────────────────────────────────────────
// ETH/USD PRICE (Chainlink) — with staleness guard
// ───────────────────────────────────────────────────────────────────────────

let ethPriceCache: { value: number; fetchedAt: number } | null = null;
let oracleAgeCache: { value: number; fetchedAt: number } | null = null;

/**
 * The oldest oracle answer the vault itself accepts when it prices its NAV: a fixed 26 hours for
 * the feed of a stable asset, and `oracleAge` (read from the contract) for every other feed. The
 * server refuses the same prices the contract refuses.
 */
export async function getMaxOracleAgeSeconds(stableFeed = false): Promise<number> {
  if (stableFeed) return STABLE_PRICE_MAX_AGE_SECONDS;
  const now = Date.now();
  if (oracleAgeCache && now - oracleAgeCache.fetchedAt < 10 * 60_000) return oracleAgeCache.value;
  try {
    const cfg = await client.readContract({
      address: GBLIN_LENS,
      abi: LENS_ABI,
      functionName: "configFees",
      args: [GBLIN_VAULT],
    });
    const value = Number(cfg[3]);
    if (value > 0) {
      oracleAgeCache = { value, fetchedAt: now };
      return value;
    }
  } catch {
    // Fall through to the fallback below.
  }
  return ORACLE_STALENESS_SECONDS;
}

export async function getEthPriceUsd(): Promise<number> {
  const now = Date.now();
  if (ethPriceCache && now - ethPriceCache.fetchedAt < NAV_CACHE_TTL_MS) {
    return ethPriceCache.value;
  }

  const data = await client.readContract({
    address: ETH_USD_FEED,
    abi: CHAINLINK_AGGREGATOR_ABI,
    functionName: "latestRoundData",
  });
  const answer = data[1]; // int256
  const updatedAt = Number(data[3]); // uint256 → seconds

  if (answer <= 0n) {
    throw new Error(
      "OracleDead: Chainlink ETH/USD feed returned non-positive value."
    );
  }

  const nowSec = Math.floor(now / 1_000);
  const maxAge = await getMaxOracleAgeSeconds();
  if (nowSec - updatedAt > maxAge) {
    throw new Error(
      `OracleStale: Chainlink ETH/USD feed is ${nowSec - updatedAt}s old (the vault accepts at most ${maxAge}s). Aborting rather than quoting on a price the contract would refuse.`
    );
  }

  // Chainlink ETH/USD on Base has 8 decimals
  const price = Number(answer) / 1e8;
  ethPriceCache = { value: price, fetchedAt: now };
  return price;
}

// ───────────────────────────────────────────────────────────────────────────
// NAV — net asset value of 1 GBLIN in USD
// ───────────────────────────────────────────────────────────────────────────

let navCache: { value: number; fetchedAt: number } | null = null;

export async function getNavUsd(): Promise<number> {
  const now = Date.now();
  if (navCache && now - navCache.fetchedAt < NAV_CACHE_TTL_MS) {
    return navCache.value;
  }

  const [ethPerGblinWei, ethPriceUsd] = await Promise.all([
    client.readContract({
      address: GBLIN_LENS,
      abi: LENS_ABI,
      functionName: "quoteSell",
      args: [GBLIN_VAULT, parseUnits("1", 18)],
    }),
    getEthPriceUsd(),
  ]);

  const ethPerGblin = Number(formatUnits(ethPerGblinWei, 18));
  const navUsd = ethPerGblin * ethPriceUsd;
  navCache = { value: navUsd, fetchedAt: now };
  return navUsd;
}

// ───────────────────────────────────────────────────────────────────────────
// BASKET STATE & CRASH SHIELD DETECTION
// ───────────────────────────────────────────────────────────────────────────

export interface BasketEntry {
  token: Address;
  oracle: Address;
  isStable: boolean;
  baseWeightBps: number;
  dynamicWeightBps: number;
  isSlashed: boolean;
}

export interface BasketState {
  entries: BasketEntry[];
  crashShieldActive: boolean;
  totalBaseWeight: number;
  totalDynamicWeight: number;
}

let basketCache: { value: BasketState; fetchedAt: number } | null = null;

/**
 * Reads every basket row through the Lens and reports whether the Crash Shield is active on any of
 * them. The shield's own flag is used, not a comparison of weights: a row can keep its weight and
 * still be shielded.
 */
export async function getBasketState(): Promise<BasketState> {
  const now = Date.now();
  if (basketCache && now - basketCache.fetchedAt < BASKET_CACHE_TTL_MS) {
    return basketCache.value;
  }

  const entries: BasketEntry[] = [];
  let crashShieldActive = false;
  let totalBase = 0;
  let totalDynamic = 0;

  const rowCount = await client.readContract({
    address: GBLIN_LENS,
    abi: LENS_ABI,
    functionName: "basketLength",
    args: [GBLIN_VAULT],
  });

  for (let i = 0; i < Number(rowCount); i++) {
    try {
      const raw = await client.readContract({
        address: GBLIN_LENS,
        abi: LENS_ABI,
        functionName: "asset",
        args: [GBLIN_VAULT, BigInt(i)],
      });
      const [token, oracle, isStable, , baseWeight, dynamicWeight, shielded] = raw;
      const baseBps = Number(baseWeight);
      const dynBps = Number(dynamicWeight);

      if (shielded) crashShieldActive = true;

      entries.push({
        token,
        oracle,
        isStable,
        baseWeightBps: baseBps,
        dynamicWeightBps: dynBps,
        isSlashed: shielded,
      });
      totalBase += baseBps;
      totalDynamic += dynBps;
    } catch {
      break;
    }
  }

  const state: BasketState = {
    entries,
    crashShieldActive,
    totalBaseWeight: totalBase,
    totalDynamicWeight: totalDynamic,
  };
  basketCache = { value: state, fetchedAt: now };
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// DYNAMIC SLIPPAGE
// ───────────────────────────────────────────────────────────────────────────

export interface SlippageProfile {
  bps: bigint;
  pct: number;
  reason: "normal" | "crash_shield_active";
}

export async function getDynamicSlippage(): Promise<SlippageProfile> {
  const basket = await getBasketState();
  if (basket.crashShieldActive) {
    return {
      bps: SLIPPAGE_CRASH_SHIELD_BPS,
      pct: Number(SLIPPAGE_CRASH_SHIELD_BPS) / 100,
      reason: "crash_shield_active",
    };
  }
  return {
    bps: SLIPPAGE_NORMAL_BPS,
    pct: Number(SLIPPAGE_NORMAL_BPS) / 100,
    reason: "normal",
  };
}

/**
 * Apply slippage buffer to an expected output amount.
 * minOut = expected * (10000 - bps) / 10000
 */
export function applySlippageBuffer(expected: bigint, bps: bigint): bigint {
  return (expected * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR;
}

// ───────────────────────────────────────────────────────────────────────────
// COOLDOWN CHECK
// ───────────────────────────────────────────────────────────────────────────

export interface CooldownStatus {
  active: boolean;
  secondsRemaining: number;
  lastDeposit: number;
}

export async function checkCooldown(wallet: Address): Promise<CooldownStatus> {
  const [lastDeposit, blockTimestamp, cooldownSeconds] = await Promise.all([
    client.readContract({
      address: GBLIN_LENS,
      abi: LENS_ABI,
      functionName: "lastDepositTime",
      args: [GBLIN_VAULT, wallet],
    }),
    getOnChainTimestamp(),
    // The vault's own setting; the fallback only covers a failed read.
    client
      .readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "configFees", args: [GBLIN_VAULT] })
      .then((c) => Number(c[5]))
      .catch(() => COOLDOWN_SECONDS_FALLBACK),
  ]);

  const lastDepositNum = Number(lastDeposit);
  const nowOnChain = Number(blockTimestamp);
  const unlockAt = lastDepositNum + cooldownSeconds;

  if (nowOnChain < unlockAt) {
    return {
      active: true,
      secondsRemaining: unlockAt - nowOnChain,
      lastDeposit: lastDepositNum,
    };
  }
  return { active: false, secondsRemaining: 0, lastDeposit: lastDepositNum };
}

// ───────────────────────────────────────────────────────────────────────────
// REVERSE QUOTE — USD → GBLIN amount needed
// ───────────────────────────────────────────────────────────────────────────

/**
 * Given a USD target (e.g. "$5 needed for x402 payment"), compute how much
 * GBLIN must be sold via sellGBLINForEth, then swapped WETH->USDC on Uniswap, to receive that USD amount, with
 * the dynamic slippage buffer baked in (so the call won't revert).
 *
 * Approach (no Quoter dependency in v0.1):
 *   1. usdcTarget × buffer² = grossUsdcTarget (one buffer for the Zap exit, one for the swap)
 *   2. grossUsdcTarget / navUsd = gblinToSell
 *
 * The buffer absorbs both protocol internal slippage and Uniswap WETH→USDC.
 */
export async function quoteGblinForUsdc(
  usdcTargetStr: string
): Promise<{
  gblinToSell: bigint;
  minUsdcOut: bigint;
  expectedUsdcOut: bigint;
  navUsd: number;
  slippage: SlippageProfile;
}> {
  const navUsd = await getNavUsd();
  const slippage = await getDynamicSlippage();

  const usdcTargetUnits = parseUnits(usdcTargetStr, 6); // USDC = 6 decimals

  // Gross-up the target by the slippage buffer so we sell enough GBLIN.
  // grossTarget = target * 10000 / (10000 - bps)
  // The buffer is applied twice downstream: once to the Zap exit's minimum ETH, once to the WETH->USDC
  // swap, which spends only that minimum and must still return the full target. Gross up for both.
  const keep = BPS_DENOMINATOR - slippage.bps;
  const grossUsdcTarget =
    (usdcTargetUnits * BPS_DENOMINATOR * BPS_DENOMINATOR) / (keep * keep);

  // Convert USDC to shares at NAV. Both grossUsdcTarget and navUsdScaled are USD scaled by 1e6, so
  // shares (18 decimals) = grossUsdcTarget * 1e18 / navUsdScaled. Scaling the NAV to a millionth of a
  // dollar bounds the relative error near 1e-8, far inside the slippage buffer.
  const navUsdScaled = BigInt(Math.round(navUsd * 1_000_000));
  const gblinToSell =
    (grossUsdcTarget * parseUnits("1", 18)) / navUsdScaled;

  // minUsdcOut = exact target (we asked for this much; agent fails if it gets less)
  const minUsdcOut = usdcTargetUnits;

  // expectedUsdcOut = gross target (what the agent should approximately receive)
  const expectedUsdcOut = grossUsdcTarget;

  return {
    gblinToSell,
    minUsdcOut,
    expectedUsdcOut,
    navUsd,
    slippage,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// BALANCE HELPERS
// ───────────────────────────────────────────────────────────────────────────

export interface WalletBalances {
  gblin: bigint;
  gblinFormatted: string;
  gblinValueUsd: number;
  usdc: bigint;
  usdcFormatted: string;
  eth: bigint;
  ethFormatted: string;
  ethValueUsd: number;
  totalUsd: number;
}

export async function getWalletBalances(wallet: Address): Promise<WalletBalances> {
  const [gblin, usdc, eth, navUsd, ethPriceUsd] = await Promise.all([
    client.readContract({
      address: GBLIN_VAULT,
      abi: GBLIN_ABI,
      functionName: "balanceOf",
      args: [wallet],
    }),
    client.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [wallet],
    }),
    client.getBalance({ address: wallet }),
    getNavUsd(),
    getEthPriceUsd(),
  ]);

  const gblinFormatted = formatUnits(gblin, 18);
  const usdcFormatted = formatUnits(usdc, 6);
  const ethFormatted = formatUnits(eth, 18);

  const gblinValueUsd = Number(gblinFormatted) * navUsd;
  const ethValueUsd = Number(ethFormatted) * ethPriceUsd;
  const totalUsd = gblinValueUsd + Number(usdcFormatted) + ethValueUsd;

  return {
    gblin,
    gblinFormatted,
    gblinValueUsd,
    usdc,
    usdcFormatted,
    eth,
    ethFormatted,
    ethValueUsd,
    totalUsd,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CACHE INVALIDATION (for tests)
// ───────────────────────────────────────────────────────────────────────────

export function clearCaches(): void {
  ethPriceCache = null;
  navCache = null;
  basketCache = null;
}
