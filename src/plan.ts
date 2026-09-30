/**
 * GBLIN MCP — plan_treasury
 *
 * Turns idle USDC into a plan the agent can show and a human can confirm, in one call: the operating
 * cash to keep liquid, the surplus above it, a simulation of minting that surplus at NAV with every fee
 * read live and the estimated value of exiting the same position today, the same simulation for a
 * trial amount, the blockers, and the tools to call after confirmation. Reads only; nothing is
 * executed and nothing is advised. The same plan is served over HTTP at gblin.digital/api/x402/plan.
 */

import { formatUnits, parseUnits, type Address } from "viem";
import { z } from "zod";

import { LENS_ABI } from "./abi.js";
import { client } from "./client.js";
import { GBLIN_LENS, GBLIN_VAULT, WETH, WETH_USDC_POOL_FEE } from "./config.js";
import {
  applySlippageBuffer,
  checkCooldown,
  getBasketState,
  getDynamicSlippage,
  getEthPriceUsd,
  getNavUsd,
  getWalletBalances,
  type BasketState,
  type SlippageProfile,
} from "./helpers.js";
import { ZAP_GAS_LIMIT, toolError, toolResult } from "./shared.js";

const DEFAULT_RESERVE_DAYS = 7;
const DEFAULT_TRIAL_USDC = 100;
const MAX_DAYS = 365;
const SITE = "https://gblin.digital";
const REGIME_LABEL = ["calm", "elevated", "crash"] as const;

const PlanSchema = z
  .object({
    wallet_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "wallet_address must be a 0x address"),
    daily_burn_usd: z.number().nonnegative().optional(),
    days: z.number().int().min(1).max(MAX_DAYS).optional(),
    reserve_usd: z.number().nonnegative().optional(),
    trial_usdc: z.number().positive().optional(),
  })
  .refine((v) => v.daily_burn_usd !== undefined || v.reserve_usd !== undefined, {
    message: "Provide daily_burn_usd (USD per day) or reserve_usd (USD to keep liquid), or both.",
  });

export const PLAN_TREASURY_DEFINITION = {
  name: "plan_treasury",
  description:
    "Idle USDC to a reviewable plan in one call: operating cash = max(reserve_usd, daily_burn_usd × days), the surplus above it, a simulation of minting that surplus into GBLIN at NAV (fees read live from the vault, estimated exit value today, round-trip cost), the same simulation for a trial amount (100 USDC by default), the blockers (crash shield, redemption cooldown, ETH for the exit) and the tools to call after a human confirms. Reads only: nothing is executed and nothing is advised. GBLIN is crypto exposure (cbBTC, WETH, USDC), not cash and not yield.",
  inputSchema: {
    type: "object" as const,
    properties: {
      wallet_address: { type: "string", description: "Agent's 0x address." },
      daily_burn_usd: { type: "number", description: "Average daily spend in USD. Operating cash = daily_burn_usd × days." },
      days: { type: "number", description: `Days of spend to keep liquid (default ${DEFAULT_RESERVE_DAYS}, max ${MAX_DAYS}).` },
      reserve_usd: { type: "number", description: "USD to keep liquid regardless of the burn rate; the larger of the two rules wins." },
      trial_usdc: { type: "number", description: `Trial amount to simulate beside the surplus (default ${DEFAULT_TRIAL_USDC}).` },
    },
    required: ["wallet_address"],
    additionalProperties: false,
  },
};

interface FeeSchedule {
  protocolFeeBps: number;
  stabilityFeeBps: number;
  managementFeeBps: number;
  minDepositWei: bigint;
}

async function readFeeSchedule(): Promise<FeeSchedule> {
  const [fees, management] = await Promise.all([
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "configFees", args: [GBLIN_VAULT] }),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "managementFeeBps", args: [GBLIN_VAULT] }),
  ]);
  return {
    protocolFeeBps: Number(fees[0]),
    stabilityFeeBps: Number(fees[1]),
    minDepositWei: fees[2],
    managementFeeBps: Number(management),
  };
}

/** Same rule as get_market_risk_regime and the attestation endpoint. */
function riskRegime(basket: BasketState) {
  const maxCut = basket.entries
    .filter((e) => !e.isStable && e.baseWeightBps > 0)
    .reduce((m, e) => Math.max(m, ((e.baseWeightBps - e.dynamicWeightBps) / e.baseWeightBps) * 100), 0);
  const code: 0 | 1 | 2 = maxCut <= 0 ? 0 : maxCut < 40 ? 1 : 2;
  return { code, label: REGIME_LABEL[code], maxWeightCutPct: Number(maxCut.toFixed(2)) };
}

interface SimulationContext {
  ethPriceUsd: number;
  navUsd: number;
  slippage: SlippageProfile;
  fees: FeeSchedule;
  basket: BasketState;
}

/**
 * Simulates minting `usdc` through the Zap (USDC -> WETH on the pool, mint at NAV) and exiting the
 * resulting position today (redeem in kind, sell the legs, WETH -> USDC). Reads only.
 */
async function simulateMint(usdc: number, ctx: SimulationContext) {
  const usdcUnits = parseUnits(usdc.toFixed(6), 6);
  const ethPriceScaled = BigInt(Math.round(ctx.ethPriceUsd * 1_000_000));
  const poolFeeBps = WETH_USDC_POOL_FEE / 100;
  const wethGross = (usdcUnits * parseUnits("1", 18)) / ethPriceScaled;
  const wethExpected = (wethGross * BigInt(10_000 - poolFeeBps)) / 10_000n;
  const wethMin = applySlippageBuffer(wethExpected, ctx.slippage.bps);

  const head = {
    usdc_in: Number(usdc.toFixed(6)),
    eth_price_usd: Number(ctx.ethPriceUsd.toFixed(2)),
    nav_usd: Number(ctx.navUsd.toFixed(6)),
    weth_expected: formatUnits(wethExpected, 18),
    weth_min: formatUnits(wethMin, 18),
    slippage_buffer_pct: ctx.slippage.pct,
    slippage_reason: ctx.slippage.reason,
    fees: {
      entry_swap_fee_bps: poolFeeBps,
      protocol_fee_bps: ctx.fees.protocolFeeBps,
      stability_fee_bps: ctx.fees.stabilityFeeBps,
      management_fee_bps_per_year: ctx.fees.managementFeeBps,
    },
  };

  if (wethMin < ctx.fees.minDepositWei) {
    return {
      status: "below_minimum" as const,
      ...head,
      minimum_note: `Below the vault's minimum deposit of ${formatUnits(ctx.fees.minDepositWei, 18)} ETH after the slippage buffer.`,
    };
  }

  const [[gblinExpected, protocolFeeWei, stabilityFeeWei], [gblinAtMin]] = await Promise.all([
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteBuy", args: [GBLIN_VAULT, wethExpected] }),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteBuy", args: [GBLIN_VAULT, wethMin] }),
  ]);
  const gblinMin = applySlippageBuffer(gblinAtMin, ctx.slippage.bps);

  // Exit today: the Zap redeems in kind and sells every leg but WETH to WETH, then the agent swaps
  // WETH -> USDC. quoteSell prices the shares at NAV; the pool fee is estimated once on every leg sold
  // and once on the final swap. Price impact is not estimated: the minimums bound it at execution.
  const ethBack = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteSell", args: [GBLIN_VAULT, gblinExpected] });
  const grossUsd = Number(formatUnits(ethBack, 18)) * ctx.ethPriceUsd;
  const wethRow = ctx.basket.entries.find((e) => e.token.toLowerCase() === WETH.toLowerCase());
  const wethWeight = wethRow ? wethRow.dynamicWeightBps / 10_000 : 0;
  const dexFeeBps = Number(((1 - wethWeight) * poolFeeBps + poolFeeBps).toFixed(2));
  const netUsd = grossUsd * (1 - dexFeeBps / 10_000);
  const mintFeeUsd = Number(formatUnits(protocolFeeWei + stabilityFeeWei, 18)) * ctx.ethPriceUsd;
  const roundTrip = usdc - netUsd;

  return {
    status: "ok" as const,
    ...head,
    gblin_expected: formatUnits(gblinExpected, 18),
    gblin_min: formatUnits(gblinMin, 18),
    position_value_usd: Number((Number(formatUnits(gblinExpected, 18)) * ctx.navUsd).toFixed(4)),
    fees: {
      ...head.fees,
      mint_fee_usd: Number(mintFeeUsd.toFixed(4)),
      management_fee_usd_per_year: Number(((usdc * ctx.fees.managementFeeBps) / 10_000).toFixed(4)),
    },
    exit_today: {
      gblin_sold: formatUnits(gblinExpected, 18),
      eth_expected: formatUnits(ethBack, 18),
      gross_usd: Number(grossUsd.toFixed(4)),
      dex_fee_estimate_bps: dexFeeBps,
      net_estimate_usd: Number(netUsd.toFixed(4)),
      method:
        "Shares priced by the Lens at NAV (quoteSell), converted at the Chainlink ETH/USD price; pool fee applied to every leg sold and to the final WETH->USDC swap; price impact not estimated.",
    },
    round_trip_cost_usd: Number(roundTrip.toFixed(4)),
    round_trip_cost_bps: Number(((roundTrip / usdc) * 10_000).toFixed(2)),
  };
}

export async function handlePlanTreasury(args: unknown) {
  let parsed: z.infer<typeof PlanSchema>;
  try {
    parsed = PlanSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    const wallet = parsed.wallet_address as Address;
    const days = parsed.days ?? DEFAULT_RESERVE_DAYS;
    const trial = parsed.trial_usdc ?? DEFAULT_TRIAL_USDC;

    // Shared values first, one at a time, so the cached price, NAV and basket serve every read below.
    // Public RPCs rate-limit bursts from a shared egress: a dozen parallel calls fail together.
    const ethPriceUsd = await getEthPriceUsd();
    const navUsd = await getNavUsd();
    const basket = await getBasketState();
    const slippage = await getDynamicSlippage();
    const [balances, cooldown, gasPrice, fees, block] = await Promise.all([
      getWalletBalances(wallet),
      checkCooldown(wallet),
      client.getGasPrice(),
      readFeeSchedule(),
      client.getBlockNumber(),
    ]);

    // Gas: what the three-step exit costs at the live gas price, with a fivefold margin for spikes.
    const exitCostWei = (46_000n + BigInt(ZAP_GAS_LIMIT) + 120_000n) * gasPrice;
    const ethBalanceWei = parseUnits(balances.ethFormatted, 18);
    const gasStatus: "sufficient" | "low" | "critical" =
      ethBalanceWei >= exitCostWei * 5n ? "sufficient" : ethBalanceWei >= exitCostWei ? "low" : "critical";

    const regime = riskRegime(basket);
    const usdc = Number(balances.usdcFormatted);
    const operatingCash = Math.max(parsed.reserve_usd ?? 0, (parsed.daily_burn_usd ?? 0) * days);
    const surplus = Math.max(0, usdc - operatingCash);
    const runwayDays = parsed.daily_burn_usd && parsed.daily_burn_usd > 0 ? Math.floor(usdc / parsed.daily_burn_usd) : null;

    const ctx: SimulationContext = { ethPriceUsd, navUsd, slippage, fees, basket };
    const simulation = surplus > 0 ? await simulateMint(surplus, ctx) : null;
    const trialSimulation = await simulateMint(trial, ctx);

    // Parking is a candidate only when the shield is idle, no redemption cooldown is running and the
    // wallet can pay for its own exit. Each blocker is named; none is a recommendation to proceed.
    const blockers: string[] = [];
    if (basket.crashShieldActive) blockers.push("crash shield active: a basket row is being cut; wait until it clears");
    if (cooldown.active) blockers.push(`redemption cooldown running for ${cooldown.secondsRemaining}s after a mint for this wallet`);
    if (gasStatus === "critical") blockers.push("ETH does not cover one three-step exit at the current gas price");
    if (surplus <= 0) blockers.push("no USDC above the operating cash");
    if (simulation && simulation.status === "below_minimum") blockers.push("surplus is below the vault's minimum deposit");

    return toolResult({
      wallet,
      as_of: { block: block.toString(), unix: Math.floor(Date.now() / 1000) },
      inputs: { daily_burn_usd: parsed.daily_burn_usd ?? null, days, reserve_usd: parsed.reserve_usd ?? null, trial_usdc: trial },
      market: {
        nav_usd: Number(navUsd.toFixed(6)),
        eth_price_usd: Number(ethPriceUsd.toFixed(2)),
        regime: regime.label,
        regime_code: regime.code,
        max_weight_cut_pct: regime.maxWeightCutPct,
        crash_shield_active: basket.crashShieldActive,
      },
      wallet_state: {
        usdc: balances.usdcFormatted,
        gblin: balances.gblinFormatted,
        gblin_value_usd: Number(balances.gblinValueUsd.toFixed(4)),
        eth: balances.ethFormatted,
        gas_health: { status: gasStatus, exit_cost_eth: formatUnits(exitCostWei, 18) },
        cooldown: { active: cooldown.active, seconds_remaining: cooldown.secondsRemaining },
      },
      operating_cash: { usdc: Number(operatingCash.toFixed(2)), rule: "max(reserve_usd, daily_burn_usd × days)", runway_days: runwayDays },
      surplus: { usdc: Number(surplus.toFixed(2)) },
      park_candidate: blockers.length === 0,
      blockers,
      simulation: simulation ?? { status: "nothing_to_park", reason: "USDC does not exceed the operating cash." },
      trial: trialSimulation,
      next: {
        park: surplus > 0 ? `invest_usdc_to_gblin with usdc_amount "${surplus.toFixed(2)}" (or prepare_action, then preview_steps)` : null,
        trial: `invest_usdc_to_gblin with usdc_amount "${trial}"`,
        refill: "swap_gblin_to_usdc_jit when an invoice needs USDC",
        http: `${SITE}/api/x402/plan?wallet=${wallet}${parsed.daily_burn_usd !== undefined ? `&daily_burn=${parsed.daily_burn_usd}` : ""}${parsed.reserve_usd !== undefined ? `&reserve=${parsed.reserve_usd}` : ""}&days=${days}`,
        note: "Each prepare tool returns unsigned calldata with non-zero minimums. Show the simulation and ask for confirmation before signing; nothing here executes.",
      },
      notes: [
        "GBLIN is a basket of cbBTC, WETH and USDC held in the contract and priced by Chainlink: its value moves with cbBTC and WETH. It is not a stablecoin and carries no yield.",
        "Operating cash is arithmetic on the caller's own inputs, not an allocation advice. The surplus is a candidate, never a recommendation.",
        "Every rate above is read from the vault at the block shown; governance can change them through the 48-hour timelock within the bounds written in the contract.",
        "Redemption in kind reads no price feed and cannot be paused: shares can always be burned for the underlying assets.",
        "GBLIN shares implement EIP-3009: a holder can pay in GBLIN with a signature and no ETH (prepare_gblin_payment).",
      ],
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}
