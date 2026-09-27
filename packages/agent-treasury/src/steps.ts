/**
 * The unsigned steps for the two moves a treasury makes, built exactly as the GBLIN MCP server builds
 * them (prepare_action: exit_to_usdc, mint_with_usdc), so an agent that already uses the MCP sees the
 * same transactions here.
 */

import { encodeAbiParameters, encodeFunctionData, parseUnits, type Address, type Hex, type PublicClient } from "viem";

import { ERC20_ABI, LENS_ABI, SWAP_ROUTER_ABI, VAULT_ABI, ZAP_ABI } from "./abi.js";
import { BPS, BUILDER_CODE_SUFFIX, GBLIN_LENS, GBLIN_VAULT, GBLIN_ZAP, SWAP_ROUTER_02, USDC, WETH, WETH_USDC_POOL_FEE, ZAP_GAS_LIMIT, APPROVE_GAS_LIMIT, SWAP_GAS_LIMIT } from "./config.js";
import { readPrices, slippageBps, withBuffer } from "./quotes.js";

export interface Step {
  description: string;
  to: Address;
  data: Hex;
  value: bigint;
  /** Explicit gas limit; the Zap steps need one (see ZAP_GAS_LIMIT). */
  gas?: bigint;
}

export function withBuilderCode(data: Hex): Hex {
  return `${data}${BUILDER_CODE_SUFFIX}` as Hex;
}

const VENUE_FEE_DATA = encodeAbiParameters([{ type: "uint24" }], [WETH_USDC_POOL_FEE]);

async function venueDataPerRow(client: PublicClient): Promise<Hex[]> {
  const n = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "basketLength", args: [GBLIN_VAULT] }).catch(() => 3n);
  return Array.from({ length: Number(n) }, () => VENUE_FEE_DATA);
}

export interface ExitPlan {
  steps: Step[];
  sharesToSell: bigint;
  minEthOut: bigint;
  minUsdcOut: bigint;
  expectedUsdcOut: bigint;
  navUsd: number;
  slippageBps: bigint;
}

/**
 * GBLIN -> USDC for a USDC target. Three steps: approve the shares to the Zap; the Zap redeems in kind
 * and sells every leg for ETH (all or nothing); Uniswap V3 turns that ETH into USDC. The target is
 * grossed up by the slippage buffer twice (once per leg) so the last step still delivers the full amount.
 */
export async function planExitToUsdc(client: PublicClient, wallet: Address, usdcTarget: bigint, maxShares: bigint): Promise<ExitPlan> {
  const [prices, bps] = await Promise.all([readPrices(client), slippageBps(client)]);
  const keep = BPS - bps;
  const gross = (usdcTarget * BPS * BPS) / (keep * keep);
  const navUsdScaled = BigInt(Math.round(prices.navUsd * 1_000_000));
  if (navUsdScaled === 0n) throw new Error("The NAV reads as zero: the vault cannot be priced right now.");
  let shares = (gross * parseUnits("1", 18)) / navUsdScaled;
  if (shares === 0n) throw new Error("The amount is too small to exit.");
  if (shares > maxShares) throw new Error(`Exiting ${usdcTarget} USDC units needs about ${shares} share units, more than the ${maxShares} held.`);
  const ethExpected = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteSell", args: [GBLIN_VAULT, shares] });
  const minEthOut = withBuffer(ethExpected, bps);
  if (minEthOut === 0n) throw new Error("The exit quote is zero: the NAV cannot be priced right now.");
  const venue = await venueDataPerRow(client);
  const steps: Step[] = [
    {
      description: "Approve the shares to the GBLIN Zap",
      to: GBLIN_VAULT,
      data: withBuilderCode(encodeFunctionData({ abi: VAULT_ABI, functionName: "approve", args: [GBLIN_ZAP, shares] })),
      value: 0n,
      gas: APPROVE_GAS_LIMIT,
    },
    {
      description: "Redeem in kind and sell every leg for ETH through the Zap (all or nothing)",
      to: GBLIN_ZAP,
      data: withBuilderCode(encodeFunctionData({ abi: ZAP_ABI, functionName: "sellGBLINForEth", args: [shares, minEthOut, venue, wallet] })),
      value: 0n,
      gas: ZAP_GAS_LIMIT,
    },
    {
      description: "Swap the received ETH to USDC on Uniswap V3",
      to: SWAP_ROUTER_02,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{ tokenIn: WETH, tokenOut: USDC, fee: WETH_USDC_POOL_FEE, recipient: wallet, amountIn: minEthOut, amountOutMinimum: usdcTarget, sqrtPriceLimitX96: 0n }],
      }),
      value: minEthOut,
      gas: SWAP_GAS_LIMIT,
    },
  ];
  return { steps, sharesToSell: shares, minEthOut, minUsdcOut: usdcTarget, expectedUsdcOut: gross, navUsd: prices.navUsd, slippageBps: bps };
}

export interface MintPlan {
  steps: Step[];
  usdcIn: bigint;
  minWethOut: bigint;
  minSharesOut: bigint;
  slippageBps: bigint;
}

/** USDC -> GBLIN through the Zap: approve USDC to it, then one call that swaps to WETH and mints at NAV. */
export async function planMintFromUsdc(client: PublicClient, wallet: Address, usdcIn: bigint): Promise<MintPlan> {
  if (usdcIn === 0n) throw new Error("The amount to park is zero.");
  const [prices, bps] = await Promise.all([readPrices(client), slippageBps(client)]);
  const ethPriceScaled = BigInt(Math.round(prices.ethUsd * 1_000_000));
  const wethExpected = (usdcIn * parseUnits("1", 18)) / ethPriceScaled;
  const minWethOut = withBuffer(wethExpected, bps);
  const [sharesExpected] = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteBuy", args: [GBLIN_VAULT, wethExpected] });
  const minSharesOut = withBuffer(sharesExpected, bps);
  if (minSharesOut === 0n) throw new Error("The mint quote is zero: the amount is too small or the NAV cannot be priced right now.");
  const steps: Step[] = [
    {
      description: "Approve USDC to the GBLIN Zap",
      to: USDC,
      data: withBuilderCode(encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [GBLIN_ZAP, usdcIn] })),
      value: 0n,
      gas: APPROVE_GAS_LIMIT,
    },
    {
      description: "Swap USDC to WETH and mint GBLIN at NAV, in one transaction",
      to: GBLIN_ZAP,
      data: withBuilderCode(encodeFunctionData({ abi: ZAP_ABI, functionName: "buyGBLINWithToken", args: [USDC, usdcIn, minWethOut, minSharesOut, VENUE_FEE_DATA, wallet] })),
      value: 0n,
      gas: ZAP_GAS_LIMIT,
    },
  ];
  return { steps, usdcIn, minWethOut, minSharesOut, slippageBps: bps };
}
