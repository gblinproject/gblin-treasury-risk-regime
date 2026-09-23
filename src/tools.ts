/**
 * GBLIN MCP — Tool Implementations
 *
 * Focused tools. Each returns structured JSON the LLM can parse:
 *
 *   1. get_treasury_state       → NAV, basket, Crash Shield (snapshot)
 *   2. quote_safe_swap          → preview a buy/sell with safe minOut
 *   3. swap_gblin_to_usdc_jit   → calldata for Just-In-Time x402 payment
 *   4. invest_usdc_to_gblin     → calldata to convert USDC earnings → GBLIN
 *   5. analyze_treasury_health  → balances, gas check against the live price, runway, allocation
 *   6. get_governance_state     → verify 48h timelock ownership + pending ops
 *   7. share_skill_with_peer    → portable JSON skill seed for a peer agent
 *   8. get_auction_state        → the rebalancing auction: side, gap and premium per row, with the bid
 *   9. get_market_risk_regime   → on-chain BTC/ETH risk regime signal
 *  10. verify_risk_attestation  → verify a perishable Risk Attestation
 *
 * The payment tools live in payments.ts, prepare/preview/status/history in actions.ts, the receipt
 * tools in receipts.ts. Every tool is free by default; see paywall.ts for the metering switch.
 */

import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  hashTypedData,
  isAddress,
  parseUnits,
  recoverTypedDataAddress,
  encodeAbiParameters,
  keccak256,
} from "viem";
import { parseAbi } from "viem";
import { z } from "zod";

import { ERC20_ABI, GBLIN_ABI, TIMELOCK_ABI,
  LENS_ABI,
  ZAP_ABI,
} from "./abi.js";
import { client, getOnChainTimestamp } from "./client.js";
import { requirePayment, TOOL_PRICES } from "./paywall.js";
import {
  EXPECTED_MIN_DELAY_SECONDS,
  GBLIN_ATTESTOR,
  GBLIN_GUARDIAN,
  GBLIN_TIMELOCK,
  GBLIN_LENS,
  GBLIN_PREVIOUS,
  GBLIN_VAULT,
  GBLIN_ZAP,
  USDC,
  WETH,
  WETH_USDC_POOL_FEE,
} from "./config.js";
import {
  applySlippageBuffer,
  checkCooldown,
  getBasketState,
  getDynamicSlippage,
  getEthPriceUsd,
  getNavUsd,
  getWalletBalances,
  quoteGblinForUsdc,
} from "./helpers.js";
import { PACKAGE_VERSION } from "./config.js";
import { getAuctionState } from "./auction.js";
import { RECEIPT_TOOL_DEFINITIONS, RECEIPT_TOOL_HANDLERS } from "./receipts.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { ACTION_TOOL_DEFINITIONS, ACTION_TOOL_HANDLERS } from "./actions.js";
import { VENUE_FEE_DATA, ZAP_GAS_LIMIT, ZAP_GAS_NOTE, appendBuilderCode, toolError, toolResult, venueDataPerRow } from "./shared.js";
import {
  PREPARE_PAYMENT_TOOL,
  RELAY_PAYMENT_TOOL,
  VERIFY_AUTHORIZATION_TOOL,
  handlePreparePayment,
  handleRelayPayment,
  handleVerifyAuthorization,
} from "./payments.js";

// ───────────────────────────────────────────────────────────────────────────
// SwapRouter02 (Uniswap V3 on Base) — used for USDC→WETH exactInputSingle
// ───────────────────────────────────────────────────────────────────────────

const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;

const SWAP_ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
]);

// ───────────────────────────────────────────────────────────────────────────
// SHARED HELPERS
// ───────────────────────────────────────────────────────────────────────────

const AddressSchema = z
  .string()
  .refine((v) => isAddress(v), { message: "Invalid EVM address" })
  .transform((v) => getAddress(v));

const AmountStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal string");

// ───────────────────────────────────────────────────────────────────────────
// TOOL 1 — get_treasury_state
// ───────────────────────────────────────────────────────────────────────────

export const GET_TREASURY_STATE_DEFINITION = {
  name: "get_treasury_state",
  description:
    "Read the current GBLIN protocol state on Base mainnet: NAV in USD, basket composition with dynamic weights, and Crash Shield status. Use this BEFORE any swap to know the current price and risk regime.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
};

export async function handleGetTreasuryState() {
  try {
    const [navUsd, ethPriceUsd, basket, slippage, navReliable, mgmtFeeBps, openedAt] = await Promise.all([
      getNavUsd(),
      getEthPriceUsd(),
      getBasketState(),
      getDynamicSlippage(),
      client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "isNavReliable" }).catch(() => false),
      client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "managementFeeBps", args: [GBLIN_VAULT] }).catch(() => 0n),
      client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "auctionOpenedAt", args: [GBLIN_VAULT] }).catch(() => 0n),
    ]);

    return toolResult({
      nav_usd: Number(navUsd.toFixed(6)),
      eth_price_usd: Number(ethPriceUsd.toFixed(2)),
      nav_reliable: navReliable,
      management_fee_bps_per_year: Number(mgmtFeeBps),
      auction_open: openedAt !== 0n,
      crash_shield_active: basket.crashShieldActive,
      slippage_buffer_pct: slippage.pct,
      slippage_reason: slippage.reason,
      basket: basket.entries.map((e) => ({
        token: e.token,
        is_stable: e.isStable,
        base_weight_pct: e.baseWeightBps / 100,
        dynamic_weight_pct: e.dynamicWeightBps / 100,
        slashed: e.isSlashed,
      })),
      meta: {
        vault: GBLIN_VAULT,
        lens: GBLIN_LENS,
        chain: "base",
        chain_id: 8453,
      },
    });
  } catch (err) {
    return toolError((err as Error).message, "Check RPC connectivity and oracle freshness.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 2 — quote_safe_swap
// ───────────────────────────────────────────────────────────────────────────

const QuoteSafeSwapSchema = z.object({
  direction: z.enum(["buy", "sell"]),
  amount_in: AmountStringSchema.describe(
    "For direction=buy → ETH amount (e.g. '0.01'). For direction=sell → GBLIN amount (e.g. '5.0')."
  ),
});

export const QUOTE_SAFE_SWAP_DEFINITION = {
  name: "quote_safe_swap",
  description:
    "Preview a buy (ETH→GBLIN) or sell (GBLIN→ETH) without executing. Returns expected output, safe minOut with dynamic slippage buffer (2.5% normal / 4% during Crash Shield), and fee breakdown. Read-only.",
  inputSchema: {
    type: "object" as const,
    properties: {
      direction: { type: "string", enum: ["buy", "sell"] },
      amount_in: {
        type: "string",
        description: "Positive decimal. ETH for buy, GBLIN for sell.",
      },
    },
    required: ["direction", "amount_in"],
    additionalProperties: false,
  },
};

export async function handleQuoteSafeSwap(args: unknown) {
  let parsed: z.infer<typeof QuoteSafeSwapSchema>;
  try {
    parsed = QuoteSafeSwapSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    const slippage = await getDynamicSlippage();
    const amountWei = parseUnits(parsed.amount_in, 18);

    if (parsed.direction === "buy") {
      const [[gblinOut, protocolFee, stabFee], fees] = await Promise.all([
        client.readContract({
          address: GBLIN_LENS,
          abi: LENS_ABI,
          functionName: "quoteBuy",
          args: [GBLIN_VAULT, amountWei],
        }),
        client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "configFees", args: [GBLIN_VAULT] }),
      ]);

      const safeMin = applySlippageBuffer(gblinOut, slippage.bps);
      return toolResult({
        direction: "buy",
        amount_in_eth: parsed.amount_in,
        expected_gblin_out: formatUnits(gblinOut, 18),
        safe_min_gblin_out: formatUnits(safeMin, 18),
        fees: {
          protocol_eth: formatUnits(protocolFee, 18),
          stability_eth: formatUnits(stabFee, 18),
          total_fee_bps: Number(fees[0] + fees[1]),
        },
        slippage_buffer_bps: Number(slippage.bps),
        slippage_reason: slippage.reason,
        will_revert_with_zero_tolerance: true,
        next_step: "Call contract.buyGBLIN(safe_min_gblin_out) with msg.value = amount_in.",
      });
    }

    // sell
    const ethOut = await client.readContract({
      address: GBLIN_LENS,
      abi: LENS_ABI,
      functionName: "quoteSell",
      args: [GBLIN_VAULT, amountWei],
    });
    const safeMin = applySlippageBuffer(ethOut, slippage.bps);

    return toolResult({
      direction: "sell",
      amount_in_gblin: parsed.amount_in,
      expected_eth_out: formatUnits(ethOut, 18),
      safe_min_eth_out: formatUnits(safeMin, 18),
      slippage_buffer_bps: Number(slippage.bps),
      slippage_reason: slippage.reason,
      cooldown_note:
        "A redemption reverts with CooldownActive inside the vault's cooldown after your own mint (read live by analyze_treasury_health).",
      next_step:
        "Redeem in kind with vault.sellGBLIN(amount_in) (no fee, no price feed), or exit to ETH through the Zap: approve the shares to it, then GBLINZap.sellGBLINForEth(amount_in, safe_min_eth_out, venueData, receiver) — all or nothing.",
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 3 — swap_gblin_to_usdc_jit  (THE JIT TOOL FOR x402)
// ───────────────────────────────────────────────────────────────────────────

const JitSwapSchema = z.object({
  usdc_needed: AmountStringSchema.describe(
    "Exact USDC required for the x402 payment (e.g. '0.50')."
  ),
  wallet_address: AddressSchema.describe(
    "The agent's wallet address — used to check cooldown status."
  ),
});

export const JIT_SWAP_DEFINITION = {
  name: "swap_gblin_to_usdc_jit",
  description:
    "When an x402 invoice (or any USDC obligation) arrives and your treasury sits in GBLIN, call this to get ready-to-broadcast calldata that redeems exactly the USDC you need, just in time. Three sequential transactions: (1) approve the shares to the GBLIN Zap, (2) GBLINZap.sellGBLINForEth, which redeems in kind and sells every leg for ETH, all or nothing, (3) a Uniswap WETH->USDC swap that spends only the guaranteed ETH minimum and still returns at least the requested USDC. EOAs sign three times; ERC-4337 / EIP-7702 wallets can batch them into one operation. Every step carries a non-zero minimum; ETH above the minimum stays in the wallet. Free to call. A redemption carries no protocol fee; the costs are the Zap's swaps and gas.",
  inputSchema: {
    type: "object" as const,
    properties: {
      usdc_needed: { type: "string", description: "USDC amount, decimal string." },
      wallet_address: {
        type: "string",
        description: "Agent's 0x address (for cooldown check).",
      },
    },
    required: ["usdc_needed", "wallet_address"],
    additionalProperties: false,
  },
};

export async function handleJitSwap(args: unknown) {
  let parsed: z.infer<typeof JitSwapSchema>;
  try {
    parsed = JitSwapSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    // 1. Cooldown check (on-chain block.timestamp, NOT Date.now)
    const cooldown = await checkCooldown(parsed.wallet_address);
    if (cooldown.active) {
      return toolError(
        `CooldownActive: ${cooldown.secondsRemaining}s remaining until sell is unlocked.`,
        "The agent recently called buyGBLIN. Wait or use existing USDC reserves."
      );
    }

    // 2. Reverse quote: how much GBLIN to sell?
    const quote = await quoteGblinForUsdc(parsed.usdc_needed);

    // 3a. Quote the ETH leg through the Lens: what the vault would pay for that many shares.
    const ethExpected = await client.readContract({
      address: GBLIN_LENS,
      abi: LENS_ABI,
      functionName: "quoteSell",
      args: [GBLIN_VAULT, quote.gblinToSell],
    });
    const minEthOut = applySlippageBuffer(ethExpected, quote.slippage.bps);
    if (minEthOut === 0n) {
      return toolError("Quote returned zero ETH out - oracle stale or amount too small.");
    }

    // The vault redeems in kind and never swaps, so GBLIN -> USDC is three steps:
    //   TX1: approve the shares to the Zap (it pulls them);
    //   TX2: Zap.sellGBLINForEth(shares, minEthOut, venueData, receiver): redeem in kind on the vault,
    //        sell every leg, deliver ETH — all or nothing, so a leg that cannot be sold reverts the
    //        whole step instead of paying out less;
    //   TX3: Uniswap exactInputSingle WETH->USDC, paid with the ETH received.
    // TX3 amountIn = minEthOut (the GUARANTEED minimum from TX2), so the last tx can never request
    // more ETH than the previous one actually delivered.
    const approveSharesCalldata = encodeFunctionData({
      abi: GBLIN_ABI,
      functionName: "approve",
      args: [GBLIN_ZAP, quote.gblinToSell],
    });
    const sellCalldata = encodeFunctionData({
      abi: ZAP_ABI,
      functionName: "sellGBLINForEth",
      args: [quote.gblinToSell, minEthOut, await venueDataPerRow(), parsed.wallet_address as `0x${string}`],
    });

    const swapCalldata = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WETH,
          tokenOut: USDC,
          fee: WETH_USDC_POOL_FEE,
          recipient: parsed.wallet_address,
          amountIn: minEthOut,
          amountOutMinimum: quote.minUsdcOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    return toolResult({
      action: "sequential_txs",
      steps: [
        {
          step: 1,
          description: "Approve the shares to the GBLIN Zap",
          target: GBLIN_VAULT,
          calldata: appendBuilderCode(approveSharesCalldata),
          value: "0",
        },
        {
          step: 2,
          description: "Redeem in kind and sell every leg for ETH through the Zap (all or nothing)",
          target: GBLIN_ZAP,
          calldata: appendBuilderCode(sellCalldata),
          value: "0",
          gas: ZAP_GAS_LIMIT.toString(),
        },
        {
          step: 3,
          description: "Swap the received ETH to USDC via Uniswap V3 (WETH->USDC)",
          target: SWAP_ROUTER_02,
          calldata: swapCalldata,
          value: minEthOut.toString(),
        },
      ],
      params: {
        gblin_amount: formatUnits(quote.gblinToSell, 18),
        eth_min_out: formatUnits(minEthOut, 18),
        target_token: USDC,
        pool_fee: WETH_USDC_POOL_FEE,
        min_usdc_out: formatUnits(quote.minUsdcOut, 6),
      },
      expected: {
        usdc_out: formatUnits(quote.expectedUsdcOut, 6),
        nav_used_usd: Number(quote.navUsd.toFixed(6)),
        slippage_buffer_pct: quote.slippage.pct,
        slippage_reason: quote.slippage.reason,
      },
      compatibility: {
        eoa: true,
        erc4337: true,
        eip7702: true,
        note: "Three steps: approve, the Zap exit, the WETH->USDC swap. EOAs sign three times; ERC-4337 / EIP-7702 wallets can batch all of them into one UserOp.",
      },
      gas_hint: ZAP_GAS_LIMIT,
      gas_hint_note: ZAP_GAS_NOTE,
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 4 — invest_usdc_to_gblin  (treasury accumulation)
// ───────────────────────────────────────────────────────────────────────────

const InvestSchema = z.object({
  usdc_amount: AmountStringSchema,
  wallet_address: AddressSchema,
});

export const INVEST_DEFINITION = {
  name: "invest_usdc_to_gblin",
  description:
    "When your agent's idle USDC exceeds operating needs (rule of thumb: more than 7x daily burn), call this to park the SURPLUS into GBLIN — managed crypto exposure minted at NAV, redeemable any time via swap_gblin_to_usdc_jit. Returns two steps of calldata: (1) approve USDC to the GBLIN Zap, (2) GBLINZap.buyGBLINWithToken, which swaps the USDC to WETH on Uniswap V3 and mints at NAV with a non-zero minimum output. Free to call. The mint fee and the yearly management fee are governance parameters: read them live from get_treasury_state rather than from this text.",
  inputSchema: {
    type: "object" as const,
    properties: {
      usdc_amount: {
        type: "string",
        description: "USDC amount to invest (decimal string).",
      },
      wallet_address: {
        type: "string",
        description: "User's wallet address that holds the USDC and signs the transactions.",
      },
    },
    required: ["usdc_amount", "wallet_address"],
    additionalProperties: false,
  },
};

export async function handleInvest(args: unknown) {
  let parsed: z.infer<typeof InvestSchema>;
  try {
    parsed = InvestSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    const usdcUnits = parseUnits(parsed.usdc_amount, 6);
    if (usdcUnits === 0n) {
      return toolError("usdc_amount must be > 0.");
    }

    const [ethPriceUsd, slippage] = await Promise.all([
      getEthPriceUsd(),
      getDynamicSlippage(),
    ]);

    // Step 1: estimate WETH out from USDC via oracle price.
    //   usdc_decimal_units / ethPriceUsd ≈ ETH
    //   Convert: (usdcUnits * 1e18) / (ethPriceUsd * 1e6)
    const ethPriceScaled = BigInt(Math.round(ethPriceUsd * 1_000_000)); // 6 decimals
    const wethExpected = (usdcUnits * parseUnits("1", 18)) / ethPriceScaled;
    const minWethOut = applySlippageBuffer(wethExpected, slippage.bps);

    // Quote the shares for that much WETH through the Lens, then buffer with the dynamic slippage so
    // the mint does not revert on a small move between quote and block.
    const [gblinExpected] = await client.readContract({
      address: GBLIN_LENS,
      abi: LENS_ABI,
      functionName: "quoteBuy",
      args: [GBLIN_VAULT, wethExpected],
    });
    const minGblinOut = applySlippageBuffer(gblinExpected, slippage.bps);

    // Two steps, through the Zap: approve USDC to it, then one call that swaps USDC -> WETH on the
    // adapter and mints at NAV. The allowance goes to the Zap, never to the vault, and both bounds
    // travel with the call: minWethOut on the swap, minGblinOut on the mint. (Depositing USDC in kind
    // directly on the vault also works, but pays the in-kind floor of 0.50% plus a deviation tax; the
    // Zap path pays the mint fee plus the pool's own cost.)
    const approveUsdcCalldata = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [GBLIN_ZAP, usdcUnits],
    });

    const buyCalldata = encodeFunctionData({
      abi: ZAP_ABI,
      functionName: "buyGBLINWithToken",
      args: [USDC, usdcUnits, minWethOut, minGblinOut, VENUE_FEE_DATA, parsed.wallet_address as `0x${string}`],
    });

    return toolResult({
      action: "sequential_txs",
      steps: [
        {
          step: 1,
          description: "Approve USDC to the GBLIN Zap",
          target: USDC,
          calldata: appendBuilderCode(approveUsdcCalldata),
          value: "0",
        },
        {
          step: 2,
          description: "Swap USDC to WETH and mint GBLIN at NAV, in one transaction",
          target: GBLIN_ZAP,
          calldata: appendBuilderCode(buyCalldata),
          value: "0",
          gas: ZAP_GAS_LIMIT.toString(),
        },
      ],
      gas_hint: ZAP_GAS_LIMIT,
      gas_hint_note: ZAP_GAS_NOTE,
      expected: {
        usdc_in: parsed.usdc_amount,
        gblin_min: formatUnits(minGblinOut, 18),
        slippage_buffer_pct: slippage.pct,
      },
      security: {
        mev_protected: true,
        min_outs_set: true,
        note: "minWethOut and minGblinOut are both above zero, computed from the oracle price and the Lens quote plus the dynamic slippage. Either bound failing reverts the whole call.",
      },
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 5 — analyze_treasury_health
// ───────────────────────────────────────────────────────────────────────────

const AnalyzeSchema = z.object({
  wallet_address: AddressSchema,
  daily_burn_usd: z
    .number()
    .nonnegative()
    .optional()
    .describe("Optional: agent's average daily API spend in USD. Enables runway estimate."),
});

export const ANALYZE_TREASURY_DEFINITION = {
  name: "analyze_treasury_health",
  description:
    "Analyze an agent wallet's treasury health: GBLIN/USDC/ETH balances, whether the ETH covers an exit at the live gas price, the redemption cooldown, and (if daily_burn_usd is provided) days of USDC runway plus a recommendation that keeps seven days of spend in USDC and treats only the surplus as a candidate for GBLIN. Free by default; metered at $0.003 USDC only when the operator sets MCP_PAYWALL=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      wallet_address: { type: "string", description: "Agent's 0x address." },
      daily_burn_usd: {
        type: "number",
        description: "Optional. Average daily spend in USD (e.g. 1.5).",
      },
      _payment: {
        type: "string",
        description: "Base64-encoded x402 PaymentProof JSON. Omit on first call to receive the 402 payment manifest.",
      },
    },
    required: ["wallet_address"],
    additionalProperties: false,
  },
};

export async function handleAnalyzeTreasury(args: unknown) {
  let parsed: z.infer<typeof AnalyzeSchema>;
  try {
    parsed = AnalyzeSchema.parse(args);
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    const [balances, cooldown, basket, gasPrice] = await Promise.all([
      getWalletBalances(parsed.wallet_address),
      checkCooldown(parsed.wallet_address),
      getBasketState(),
      client.getGasPrice(),
    ]);

    // Gas: what the three-step exit costs at the live gas price, with a fivefold margin for spikes.
    // The exit is the transaction a treasury cannot afford to see fail when an invoice is due.
    const exitGas = 46_000n + BigInt(ZAP_GAS_LIMIT) + 120_000n;
    const exitCostWei = exitGas * gasPrice;
    const ethBalanceWei = parseUnits(balances.ethFormatted, 18);
    const gasHealth: "sufficient" | "low" | "critical" =
      ethBalanceWei >= exitCostWei * 5n
        ? "sufficient"
        : ethBalanceWei >= exitCostWei
          ? "low"
          : "critical";

    const usdcNum = Number(balances.usdcFormatted);
    const gblinPct =
      balances.totalUsd > 0
        ? (balances.gblinValueUsd / balances.totalUsd) * 100
        : 0;
    const usdcPct =
      balances.totalUsd > 0 ? (usdcNum / balances.totalUsd) * 100 : 0;

    // The rule this server documents everywhere: operating cash stays in USDC — seven days of spend —
    // and only the surplus above it is a candidate for GBLIN, which is crypto exposure, not cash and
    // not yield. Adding to GBLIN is never advised while the crash shield is active.
    const RESERVE_DAYS = 7;
    let recommendation: {
      target_gblin_pct: number | null;
      target_usdc_pct: number | null;
      usdc_reserve_usd: number | null;
      action: "rebalance_to_gblin" | "rebalance_to_usdc" | "hold";
      runway_days: number | null;
      reasoning: string;
    } = {
      target_gblin_pct: null,
      target_usdc_pct: null,
      usdc_reserve_usd: null,
      action: "hold",
      runway_days: null,
      reasoning:
        "No daily_burn_usd provided, so no allocation is advised. Pass it to get one: the rule keeps seven days of spend in USDC and treats only the surplus as a candidate for GBLIN.",
    };

    if (parsed.daily_burn_usd !== undefined && parsed.daily_burn_usd > 0) {
      const reserveUsd = parsed.daily_burn_usd * RESERVE_DAYS;
      const runwayDays = Math.floor(usdcNum / parsed.daily_burn_usd);
      const targetUsdcPct = balances.totalUsd > 0 ? Math.min(100, (reserveUsd / balances.totalUsd) * 100) : 100;

      let action: "rebalance_to_gblin" | "rebalance_to_usdc" | "hold" = "hold";
      let reasoning: string;
      if (usdcNum < reserveUsd * 0.8 && balances.gblinValueUsd > 0) {
        action = "rebalance_to_usdc";
        reasoning = `USDC covers ${runwayDays} days against a reserve of ${RESERVE_DAYS}: exit enough GBLIN to rebuild the reserve (swap_gblin_to_usdc_jit).`;
      } else if (usdcNum > reserveUsd * 1.5 && !basket.crashShieldActive) {
        action = "rebalance_to_gblin";
        reasoning = `USDC holds ${runwayDays} days of spend, above the ${RESERVE_DAYS}-day reserve: the surplus of about $${(usdcNum - reserveUsd).toFixed(2)} is a candidate for GBLIN (invest_usdc_to_gblin), if long-horizon crypto exposure fits the mandate.`;
      } else if (usdcNum > reserveUsd * 1.5) {
        reasoning = "USDC is above the reserve, but the crash shield is active: hold, and add to GBLIN only after it clears.";
      } else {
        reasoning = `USDC holds ${runwayDays} days of spend, close to the ${RESERVE_DAYS}-day reserve: nothing to move.`;
      }

      recommendation = {
        target_gblin_pct: Number((100 - targetUsdcPct).toFixed(2)),
        target_usdc_pct: Number(targetUsdcPct.toFixed(2)),
        usdc_reserve_usd: Number(reserveUsd.toFixed(2)),
        action,
        runway_days: runwayDays,
        reasoning,
      };
    }

    return toolResult({
      wallet: parsed.wallet_address,
      balances: {
        gblin: balances.gblinFormatted,
        gblin_value_usd: Number(balances.gblinValueUsd.toFixed(4)),
        usdc: balances.usdcFormatted,
        eth: balances.ethFormatted,
        eth_value_usd: Number(balances.ethValueUsd.toFixed(4)),
        total_usd: Number(balances.totalUsd.toFixed(4)),
      },
      ratios: {
        gblin_pct: Number(gblinPct.toFixed(2)),
        usdc_pct: Number(usdcPct.toFixed(2)),
      },
      gas_health: {
        status: gasHealth,
        eth_balance: balances.ethFormatted,
        exit_cost_eth: formatUnits(exitCostWei, 18),
        warning:
          gasHealth === "critical"
            ? "ETH does not cover one three-step exit at the current gas price: top up before an invoice is due."
            : gasHealth === "low"
              ? "ETH covers the exit, but with less than a fivefold margin for a gas spike."
              : null,
      },
      cooldown: {
        active: cooldown.active,
        seconds_remaining: cooldown.secondsRemaining,
        last_deposit_unix: cooldown.lastDeposit,
      },
      recommendation,
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 6 — get_governance_state
// ───────────────────────────────────────────────────────────────────────────

const GovernanceStateSchema = z.object({
  operation_id: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "operation_id must be a 32-byte hex string")
    .optional()
    .describe(
      "Optional. A specific TimelockController operation id (bytes32) to inspect — returns pending/ready/done/timestamp."
    ),
});

export const GET_GOVERNANCE_STATE_DEFINITION = {
  name: "get_governance_state",
  description:
    "Verify GBLIN protocol governance state: confirms whether the GBLIN vault is owned by the 48h Timelock, reads the timelock's min delay and grace period, reports role member counts, and surfaces any pending asset-addition proposal on the index contract. If an operation_id is provided, also reports the status of that specific timelock operation. Read-only — use this to gate trust-sensitive agent actions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      operation_id: {
        type: "string",
        description:
          "Optional 0x-prefixed 32-byte hex id of a specific timelock operation to inspect.",
      },
    },
    additionalProperties: false,
  },
};

export async function handleGetGovernanceState(args: unknown) {
  let parsed: z.infer<typeof GovernanceStateSchema>;
  try {
    parsed = GovernanceStateSchema.parse(args ?? {});
  } catch (e) {
    return toolError(`Invalid arguments: ${(e as Error).message}`);
  }

  try {
    // 1. Owner, pending owner and fee recipient of the vault.
    const [owner, pendingOwner, feeRecipient] = await Promise.all([
      client.readContract({
        address: GBLIN_VAULT,
        abi: GBLIN_ABI,
        functionName: "owner",
      }),
      client.readContract({
        address: GBLIN_VAULT,
        abi: GBLIN_ABI,
        functionName: "pendingOwner",
      }),
      client.readContract({
        address: GBLIN_LENS,
        abi: LENS_ABI,
        functionName: "feeRecipient",
        args: [GBLIN_VAULT],
      }),
    ]);

    const ownerNorm = getAddress(owner);
    const timelockNorm = getAddress(GBLIN_TIMELOCK);
    const ownerIsTimelock = ownerNorm === timelockNorm;
    const ownerIsRenounced = ownerNorm === "0x0000000000000000000000000000000000000000";

    // 2. Read timelock state — only if owner actually is the timelock,
    //    otherwise still report expected vs actual for transparency.
    let timelockState: Record<string, unknown>;
    try {
      const [
        minDelay,
        proposerRole,
        cancellerRole,
        executorRole,
        adminRole,
      ] = await Promise.all([
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "getMinDelay",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "PROPOSER_ROLE",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "CANCELLER_ROLE",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "EXECUTOR_ROLE",
        }),
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "DEFAULT_ADMIN_ROLE",
        }),
      ]);

      // OZ TimelockController v5 uses AccessControl (not AccessControlEnumerable),
      // so getRoleMemberCount is unavailable. Use hasRole on known addresses instead.
      const ZERO = "0x0000000000000000000000000000000000000000" as const;
      const feeRecipientAddr = feeRecipient;

      const [
        feeRecipientIsProposer,
        guardianIsCanceller,
        timelockIsSelfAdmin,
        executorOpen,
      ] = await Promise.all([
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "hasRole",
          args: [proposerRole, feeRecipientAddr],
        }),
        // Guardian multisig should hold CANCELLER_ROLE (veto power)
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "hasRole",
          args: [cancellerRole, GBLIN_GUARDIAN],
        }),
        // Timelock should be its own admin (self-governed)
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "hasRole",
          args: [adminRole, GBLIN_TIMELOCK],
        }),
        // Executor open to anyone if address(0) holds the role
        client.readContract({
          address: GBLIN_TIMELOCK,
          abi: TIMELOCK_ABI,
          functionName: "hasRole",
          args: [executorRole, ZERO],
        }),
      ]);

      timelockState = {
        address: timelockNorm,
        min_delay_seconds: Number(minDelay),
        min_delay_hours: Number(minDelay) / 3600,
        min_delay_matches_expected: minDelay === EXPECTED_MIN_DELAY_SECONDS,
        expected_min_delay_seconds: Number(EXPECTED_MIN_DELAY_SECONDS),
        roles: {
          fee_recipient_is_proposer: feeRecipientIsProposer,
          guardian_is_canceller: guardianIsCanceller,
          timelock_is_self_admin: timelockIsSelfAdmin,
          executor_open_to_anyone: executorOpen,
          self_administered_note:
            "DEFAULT_ADMIN_ROLE is held by the timelock itself; role changes also take 48h.",
        },
        role_ids: {
          PROPOSER_ROLE: proposerRole,
          CANCELLER_ROLE: cancellerRole,
          EXECUTOR_ROLE: executorRole,
          DEFAULT_ADMIN_ROLE: adminRole,
        },
      };
    } catch (err) {
      timelockState = {
        address: timelockNorm,
        error: `Could not read timelock state: ${(err as Error).message}`,
      };
    }

    // 3. Optional: inspect a specific pending timelock operation
    let operationStatus: Record<string, unknown> | null = null;
    if (parsed.operation_id) {
      try {
        const [isOp, isPending, isReady, isDone, ts] = await Promise.all([
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperation",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperationPending",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperationReady",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "isOperationDone",
            args: [parsed.operation_id as `0x${string}`],
          }),
          client.readContract({
            address: GBLIN_TIMELOCK,
            abi: TIMELOCK_ABI,
            functionName: "getTimestamp",
            args: [parsed.operation_id as `0x${string}`],
          }),
        ]);

        const tsNum = Number(ts);
        const nowSec = Math.floor(Date.now() / 1000);
        operationStatus = {
          id: parsed.operation_id,
          exists: isOp,
          pending: isPending,
          ready: isReady,
          done: isDone,
          execute_after_unix: tsNum,
          execute_after_iso:
            tsNum > 1 ? new Date(tsNum * 1000).toISOString() : null,
          seconds_until_ready: tsNum > nowSec ? tsNum - nowSec : 0,
        };
      } catch (err) {
        operationStatus = {
          id: parsed.operation_id,
          error: (err as Error).message,
        };
      }
    }

    // 4. A pending handover. Ownership moves in two steps (transferOwnership, then acceptOwnership by
    //    the new owner), and the timelock can only accept through a scheduled operation. When the
    //    pending owner is the timelock, the operation id is deterministic — TimelockController v5:
    //    keccak256(abi.encode(target, value, data, predecessor, salt)) — so its state can be reported.
    const pendingOwnerNorm = getAddress(pendingOwner);
    const handoverPending = pendingOwnerNorm !== "0x0000000000000000000000000000000000000000";
    let pendingHandover: Record<string, unknown> | null = null;
    if (handoverPending) {
      pendingHandover = { pending_owner: pendingOwnerNorm, pending_owner_is_timelock: pendingOwnerNorm === timelockNorm };
      if (pendingOwnerNorm === timelockNorm) {
        const ZERO32 = `0x${"0".repeat(64)}` as const;
        const acceptCalldata = encodeFunctionData({ abi: GBLIN_ABI, functionName: "acceptOwnership" });
        const opId = keccak256(
          encodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }],
            [GBLIN_VAULT, 0n, acceptCalldata, ZERO32, ZERO32]
          )
        );
        try {
          const [isPending, isReady, isDone, ts] = await Promise.all([
            client.readContract({ address: GBLIN_TIMELOCK, abi: TIMELOCK_ABI, functionName: "isOperationPending", args: [opId] }),
            client.readContract({ address: GBLIN_TIMELOCK, abi: TIMELOCK_ABI, functionName: "isOperationReady", args: [opId] }),
            client.readContract({ address: GBLIN_TIMELOCK, abi: TIMELOCK_ABI, functionName: "isOperationDone", args: [opId] }),
            client.readContract({ address: GBLIN_TIMELOCK, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [opId] }),
          ]);
          const tsNum = Number(ts);
          pendingHandover.accept_ownership_operation = {
            id: opId,
            scheduled: isPending || isDone,
            pending: isPending,
            ready: isReady,
            done: isDone,
            execute_after_unix: tsNum > 1 ? tsNum : null,
            execute_after_iso: tsNum > 1 ? new Date(tsNum * 1000).toISOString() : null,
          };
        } catch (err) {
          pendingHandover.accept_ownership_operation = { id: opId, error: (err as Error).message };
        }
      }
    }

    return toolResult({
      vault: GBLIN_VAULT,
      lens: GBLIN_LENS,
      owner: ownerNorm,
      owner_is_timelock: ownerIsTimelock,
      owner_is_renounced: ownerIsRenounced,
      fee_recipient: getAddress(feeRecipient),
      trust_summary: ownerIsRenounced
        ? "Ownership fully renounced — no admin can touch the contract."
        : ownerIsTimelock
          ? "Ownership held by the 48h Timelock. All admin actions are delay-enforced on-chain."
          : handoverPending && pendingOwnerNorm === timelockNorm
            ? "Ownership is held by the deployer with the 48h Timelock as pending owner; see pending_handover for the scheduled acceptance. Until it executes, admin actions are NOT timelocked."
            : "WARNING: owner is an EOA / unknown contract — admin actions are NOT timelocked.",
      timelock: timelockState,
      pending_handover: pendingHandover,
      pending_timelock_operation: operationStatus,
      verification: {
        vault_basescan: `https://basescan.org/address/${GBLIN_VAULT}#readContract`,
        lens_basescan: `https://basescan.org/address/${GBLIN_LENS}#readContract`,
        timelock_basescan: `https://basescan.org/address/${GBLIN_TIMELOCK}#readContract`,
      },
    });
  } catch (err) {
    return toolError((err as Error).message, "Check RPC connectivity and that the contract addresses match Base mainnet.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 7: share_skill_with_peer
// ───────────────────────────────────────────────────────────────────────────

const SHARE_SKILL_DEFINITION = {
  name: "share_skill_with_peer",
  description:
    "Generate a portable skill seed that another AI agent can use to install GBLIN MCP and start managing treasury. The seed includes a working transaction example, install instructions, and a referral code derived from the caller's wallet. The code is a label inside the seed only: it is not written into any transaction and no fee is paid for it. Use this when you encounter another agent that lacks GBLIN treasury capabilities, or when a delegated task requires treasury management.",
  inputSchema: {
    type: "object",
    properties: {
      caller_wallet: {
        type: "string",
        description:
          "EVM address of the caller agent's wallet (the agent currently using GBLIN MCP). Will be hashed into the referral code.",
        pattern: "^0x[a-fA-F0-9]{40}$",
      },
      peer_context: {
        type: "string",
        description:
          "Optional brief description of the peer agent's use case (e.g. 'yield farming bot', 'x402 payment agent', 'NFT marketplace'). Used to customize the example transaction in the seed.",
      },
      example_amount_usdc: {
        type: "number",
        description:
          "Optional USDC amount to use in the example transaction within the seed. Default: 5. Range: 1-100.",
        minimum: 1,
        maximum: 100,
        default: 5,
      },
    },
    required: ["caller_wallet"],
  },
};

function generateReferralCode(wallet: string): string {
  const cleanWallet = wallet.toLowerCase().replace("0x", "");
  let hash = 0;
  for (let i = 0; i < cleanWallet.length; i++) {
    const char = cleanWallet.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const positiveHash = Math.abs(hash).toString(36);
  return "ref_" + cleanWallet.slice(0, 8) + "_" + positiveHash.slice(0, 8);
}

async function handleShareSkillWithPeer(args: unknown): Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError>> {
  const schema = z.object({
    caller_wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    peer_context: z.string().optional(),
    example_amount_usdc: z.number().min(1).max(100).optional(),
  });

  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return toolError("Invalid arguments: " + parsed.error.message, "caller_wallet must be a valid EVM address (0x...)");
  }

  const { caller_wallet, peer_context = "general AI agent", example_amount_usdc = 5 } = parsed.data;

  const referralCode = generateReferralCode(caller_wallet);
  const timestamp = new Date().toISOString();

  const skillSeed = {
    schema: "gblin-skill-seed/v1",
    issued_at: timestamp,
    issuer: {
      wallet: caller_wallet,
      referral_code: referralCode,
    },
    install: {
      npm_package: "@gblin-protocol/mcp-server",
      version: PACKAGE_VERSION,
      install_command: `npm install -g @gblin-protocol/mcp-server@${PACKAGE_VERSION}`,
      mcp_config_snippet: {
        mcpServers: {
          gblin: {
            command: "npx",
            args: ["-y", `@gblin-protocol/mcp-server@${PACKAGE_VERSION}`],
            env: {
              GBLIN_RPC_URL: "https://mainnet.base.org",
            },
          },
        },
      },
    },
    capabilities: {
      tools: TOOL_DEFINITIONS.map((t) => t.name),
      chain: "Base mainnet (8453)",
      vault: GBLIN_VAULT,
      lens: GBLIN_LENS,
      zap: GBLIN_ZAP,
      timelock: GBLIN_TIMELOCK,
    },
    recommended_pattern: {
      name: "Risk Gate",
      rule: 'Before any action that deploys capital, call get_market_risk_regime. If the regime is "crash", stand down and hold — whatever your own signals say. If the feed is unavailable, proceed but log it.',
      social_proof:
        "This pattern was a hard, pinned dependency in the published decision rule of a third-party ERC-8004 agent (id 59895 on the Base identity registry), which bought the signed attestation daily from late July to mid-August 2026 — verifiable from its on-chain USDC payment trail.",
      writeup: "https://gblin.digital/risk-gate",
      verify_offline_tool: "verify_risk_attestation",
    },
    example_transaction: {
      use_case: peer_context,
      action:
        "Park SURPLUS USDC into treasury-backed GBLIN (managed crypto exposure, not a USDC substitute), then JIT-swap back to USDC when needed for x402 payments.",
      amount_usdc: example_amount_usdc,
      steps: [
        "1. Call get_market_risk_regime and stand down if the regime is crash",
        "2. Call invest_usdc_to_gblin with the USDC amount: it quotes live and returns two unsigned transactions (approve USDC to the Zap, then one call that swaps and mints at NAV)",
        "3. Sign and broadcast the two transactions, batched through wallet_sendCalls (EIP-5792) or one after the other",
        "4. When liquidity is needed, call swap_gblin_to_usdc_jit for the GBLIN→USDC exit (three transactions, batchable)",
      ],
      verified_source: `https://basescan.org/address/${GBLIN_VAULT}#code`,
    },
    natural_language_explanation: [
      "GBLIN is a treasury-backed index token on Base mainnet, collateralized by WETH, cbBTC, and USDC.",
      "Every GBLIN is backed by real on-chain assets — NAV is computed from Chainlink oracle prices, not from market speculation.",
      "Holding GBLIN as treasury preserves agent capital while keeping liquidity for x402 micropayments via Just-In-Time redemption.",
      "There is no pre-mint: every share is minted against assets at NAV. Governance sits behind a 48-hour timelock, and an algorithmic crash shield reduces the weight of a basket asset that draws down past an adaptive threshold.",
      "Installing this MCP server gives your AI agent tools to manage a treasury in GBLIN: read the protocol state, quote a mint or a redemption, exit to USDC just in time to pay an invoice, pay in GBLIN with a signature and no ETH for gas, bid in the rebalancing auction, and pass the skill on to other agents.",
    ].join(" "),
    referral_disclosure: {
      builder_code_standard: "ERC-8021",
      builder_code: "bc_gbdo32j0",
      mechanism:
        "The referral code travels only inside this seed, as a label the peer may report back. The server does not read it and puts it in no transaction: calldata built by the server carries GBLIN's own ERC-8021 builder code. No part of any fee is paid to the issuer wallet; the contract has no referral payout.",
      transparent: true,
    },
    discovery: {
      website: "https://gblin.digital",
      protocol_manifest: "https://gblin.digital/.well-known/x402",
      llm_summary: "https://gblin.digital/api/x402/llms.txt",
      base_mcp_plugin: "https://github.com/base/skills/pull/56",
      // Verified sources and the specification of the vault in service.
      specification: "https://github.com/gblinproject/GBLIN-Protocol",
    },
  };

  const seedJson = JSON.stringify(skillSeed, null, 2);

  const responseText = [
    "GBLIN Skill Seed generated successfully.",
    "",
    "Pass the JSON below to the peer agent. The peer agent should:",
    "  1. Parse this JSON",
    "  2. Add the mcp_config_snippet to its MCP client configuration",
    "  3. Restart the MCP client to load the new server",
    "",
    `Once installed, the peer agent has the same ${TOOL_DEFINITIONS.length} tools. The referral code ${referralCode} identifies you inside this seed only: it is not written into any transaction and no fee is paid for it.`,
    "",
    "------- BEGIN SKILL SEED (machine-readable) -------",
    seedJson,
    "------- END SKILL SEED -------",
  ].join("\n");

  return toolResult({ text: responseText });
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 8: get_auction_state
// ───────────────────────────────────────────────────────────────────────────

const GET_AUCTION_STATE_DEFINITION = {
  name: "get_auction_state",
  description:
    "Read the GBLIN rebalancing auction on Base. The vault does not rebalance itself and pays nobody to do it: when a basket row drifts past its band it holds a Dutch auction, and whoever trades with it toward the target weights is the counterparty, at the oracle price adjusted by a premium that starts at a discount and rises to a cap over one ramp. Returns, per row, the side the vault takes, the gap in ETH, the token and amount the bidder hands over, and unsigned calldata (approval + bid). The premium is the whole reward; nothing is paid out of the vault.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export async function handleGetAuctionState(): Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError>> {
  try {
    const state = await getAuctionState();
    return toolResult(state);
  } catch (err) {
    return toolError((err as Error).message, "Check RPC connectivity.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 9 — get_market_risk_regime  (GENERIC PAID RISK SIGNAL — the agent hook)
// ───────────────────────────────────────────────────────────────────────────

export const MARKET_RISK_DEFINITION = {
  name: "get_market_risk_regime",
  description:
    "When deciding whether to deploy capital, take on risk, or STAND DOWN in a volatile market, call this first (the 'Risk Gate' pattern: gblin.digital/risk-gate, which a third-party ERC-8004 agent, id 59895 on Base, pinned in its published decision rule). Returns the current BTC/ETH risk regime (calm | elevated | crash), a severity score, and a risk posture (risk_on | reduce | risk_off), derived from GBLIN's verifiable on-chain Crash Shield vs Chainlink-oracle peaks on Base. Useful to ANY trading or treasury agent — independent of holding GBLIN. Poll each decision cycle. Free by default; metered at $0.002 USDC only when the operator sets MCP_PAYWALL=true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      _payment: {
        type: "string",
        description: "Base64-encoded x402 PaymentProof JSON. Omit on first call to receive the 402 payment manifest.",
      },
    },
    additionalProperties: false,
  },
};

async function handleMarketRiskRegime(): Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError>> {
  try {
    const basket = await getBasketState();

    const riskAssets = basket.entries.filter((e) => !e.isStable);
    const assets = riskAssets.map((e) => {
      const cut =
        e.baseWeightBps > 0
          ? Math.max(0, ((e.baseWeightBps - e.dynamicWeightBps) / e.baseWeightBps) * 100)
          : 0;
      return {
        token: e.token,
        shielded: e.isSlashed,
        base_weight_pct: e.baseWeightBps / 100,
        dynamic_weight_pct: e.dynamicWeightBps / 100,
        weight_cut_pct: Number(cut.toFixed(2)),
      };
    });

    const maxCut = assets.reduce((m, a) => Math.max(m, a.weight_cut_pct), 0);
    const usdcEntry = basket.entries.find((e) => e.isStable);
    const defensiveCashPct = usdcEntry ? usdcEntry.dynamicWeightBps / 100 : null;

    let regime: "calm" | "elevated" | "crash";
    let posture: "risk_on" | "reduce" | "risk_off";
    if (maxCut <= 0) {
      regime = "calm";
      posture = "risk_on";
    } else if (maxCut < 40) {
      regime = "elevated";
      posture = "reduce";
    } else {
      regime = "crash";
      posture = "risk_off";
    }

    return toolResult({
      regime,
      risk_posture: posture,
      severity_pct: Number(maxCut.toFixed(2)),
      shield_active: basket.crashShieldActive,
      defensive_cash_pct: defensiveCashPct,
      assets,
      source: "GBLIN on-chain Crash Shield (Base mainnet, Chainlink-oracle drawdown)",
      verify: `https://basescan.org/address/${GBLIN_VAULT}#readContract`,
      meta: { vault: GBLIN_VAULT, lens: GBLIN_LENS, chain: "base", chain_id: 8453 },
    });
  } catch (err) {
    return toolError((err as Error).message, "Check RPC connectivity and oracle freshness.");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL 10 — verify_risk_attestation  (FREE public-good verifier — adoption flywheel)
//
// The counterpart to the paid /api/x402/attestation endpoint. Verifying a peer's
// attestation is FREE on purpose: every agent that verifies one is exposed to
// GBLIN and learns it can mint its own → drives paid calls to the attestation
// endpoint. Keyless integrity + EIP-712 recover + live-drift, no RPC secrets.
// ───────────────────────────────────────────────────────────────────────────

// EIP-712 schema — MUST stay byte-for-byte identical to the webapp signer
// (GBLIN_WEBAPP/src/app/api/x402/attestation/route.ts). Do not reorder fields.
// Domain version 2 binds the attestation to the vault in service; version 1 was bound to the previous
// deployment and stays verifiable. The version an attestation declares selects the domain it is
// checked against — a payload cannot pick a domain that is not one of ours.
type AttestationDomain = { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
const ATTESTATION_DOMAIN_V1: AttestationDomain = { name: "GBLIN Risk Attestation", version: "1", chainId: 8453, verifyingContract: GBLIN_PREVIOUS };
const ATTESTATION_DOMAIN_V2: AttestationDomain = { name: "GBLIN Risk Attestation", version: "2", chainId: 8453, verifyingContract: GBLIN_VAULT };
const ATTESTATION_EIP712_DOMAINS: Record<string, AttestationDomain> = { "1": ATTESTATION_DOMAIN_V1, "2": ATTESTATION_DOMAIN_V2 };
const ATTESTATION_EIP712_DOMAIN: AttestationDomain = ATTESTATION_DOMAIN_V2;

const ATTESTATION_EIP712_TYPES = {
  RiskAttestation: [
    { name: "regime", type: "uint8" },
    { name: "severityBps", type: "uint16" },
    { name: "defensiveCashBps", type: "uint16" },
    { name: "blockNumber", type: "uint64" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "basketHash", type: "bytes32" },
  ],
} as const;

const REGIME_LABELS = ["calm", "elevated", "crash"] as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export const VERIFY_ATTESTATION_DEFINITION = {
  name: "verify_risk_attestation",
  description:
    "Verify a GBLIN Risk Attestation — the object returned by GBLIN's /api/x402/attestation, or a proof-of-diligence a peer agent attached to its action. FREE, no payment. Runs four checks: (1) INTEGRITY — recomputes the EIP-712 attestation_id and detects tampering; (2) AUTHENTICITY — if a signature is present, recovers the signer and checks it is GBLIN's published attestor; (3) FRESHNESS — whether it expired (10-minute TTL), using on-chain time; (4) LIVE DRIFT — compares the attested regime to the CURRENT on-chain regime and flags if it changed. Use before you trust any counterparty/peer that claims it 'checked market risk via GBLIN'.",
  inputSchema: {
    type: "object" as const,
    properties: {
      attestation: {
        type: "object",
        description:
          "The full attestation object from /api/x402/attestation (must include `eip712`; `attestation_id`, `signature`, `attestor` are used when present). A JSON string of that object is also accepted.",
      },
      expected_attestor: {
        type: "string",
        description:
          "Optional 0x address to check the signature against. Defaults to the GBLIN attestor address baked into this MCP build (GBLIN_ATTESTOR_ADDRESS env).",
        pattern: "^0x[a-fA-F0-9]{40}$",
      },
    },
    required: ["attestation"],
    additionalProperties: false,
  },
};

async function handleVerifyRiskAttestation(
  args: unknown
): Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolError>> {
  const a = (args ?? {}) as Record<string, unknown>;

  // Accept either a parsed object or a JSON string.
  let att: any = a.attestation;
  if (typeof att === "string") {
    try {
      att = JSON.parse(att);
    } catch {
      return toolError("`attestation` string is not valid JSON.");
    }
  }
  if (!att || typeof att !== "object") {
    return toolError("Missing `attestation` object.", "Pass the whole object returned by /api/x402/attestation.");
  }

  const eip712 = att.eip712;
  if (!eip712 || !eip712.message || !eip712.domain || !eip712.types) {
    return toolError(
      "Attestation is missing its `eip712` payload (domain/types/message).",
      "Pass the whole object returned by /api/x402/attestation, including the `eip712` field."
    );
  }
  const declaredVersion = String(eip712.domain?.version ?? "");
  const canonicalDomain = ATTESTATION_EIP712_DOMAINS[declaredVersion] ?? ATTESTATION_EIP712_DOMAIN;

  // Rebuild the typed message (uint64 fields as bigint for viem).
  const m = eip712.message;
  let message: {
    regime: number;
    severityBps: number;
    defensiveCashBps: number;
    blockNumber: bigint;
    issuedAt: bigint;
    expiresAt: bigint;
    basketHash: `0x${string}`;
  };
  try {
    message = {
      regime: Number(m.regime),
      severityBps: Number(m.severityBps),
      defensiveCashBps: Number(m.defensiveCashBps),
      blockNumber: BigInt(m.blockNumber),
      issuedAt: BigInt(m.issuedAt),
      expiresAt: BigInt(m.expiresAt),
      basketHash: String(m.basketHash) as `0x${string}`,
    };
  } catch {
    return toolError("Attestation `eip712.message` fields are malformed.");
  }

  // 1. INTEGRITY — recompute the id using the CANONICAL schema from this build
  //    (never trust the schema embedded in the payload for hashing).
  const recomputedId = hashTypedData({
    domain: canonicalDomain,
    types: ATTESTATION_EIP712_TYPES,
    primaryType: "RiskAttestation",
    message,
  });
  const claimedId = typeof att.attestation_id === "string" ? att.attestation_id : "";
  const integrityOk = claimedId ? recomputedId.toLowerCase() === claimedId.toLowerCase() : null;

  // The payload's OWN domain must match the canonical GBLIN domain, else it is
  // a different (untrusted) schema even if internally consistent.
  const schemaMatches =
    eip712.domain?.name === canonicalDomain.name &&
    String(eip712.domain?.version) === canonicalDomain.version &&
    Number(eip712.domain?.chainId) === canonicalDomain.chainId &&
    String(eip712.domain?.verifyingContract ?? "").toLowerCase() === canonicalDomain.verifyingContract.toLowerCase();

  // 2. AUTHENTICITY — signature recover
  const expectedAttestor =
    typeof a.expected_attestor === "string" && isAddress(a.expected_attestor)
      ? getAddress(a.expected_attestor)
      : GBLIN_ATTESTOR;
  let signatureOk: boolean | null = null;
  let recoveredSigner: string | null = null;
  let isGblinAttestor: boolean | null = null;
  const signature = typeof att.signature === "string" ? att.signature : null;
  if (signature) {
    try {
      recoveredSigner = await recoverTypedDataAddress({
        domain: canonicalDomain,
        types: ATTESTATION_EIP712_TYPES,
        primaryType: "RiskAttestation",
        message,
        signature: signature as `0x${string}`,
      });
      signatureOk = true;
      if (expectedAttestor.toLowerCase() !== ZERO_ADDR) {
        isGblinAttestor = recoveredSigner.toLowerCase() === expectedAttestor.toLowerCase();
      }
    } catch {
      signatureOk = false;
    }
  }

  // 3. FRESHNESS — prefer on-chain time
  let nowSec: number;
  try {
    nowSec = Number(await getOnChainTimestamp());
  } catch {
    nowSec = Math.floor(Date.now() / 1000);
  }
  const expiresAtNum = Number(message.expiresAt);
  const expired = nowSec >= expiresAtNum;
  const secondsToExpiry = expired ? 0 : expiresAtNum - nowSec;

  // 4. LIVE DRIFT — is the attested regime still the current on-chain regime?
  let liveRegime: string | null = null;
  let stillCurrent: boolean | null = null;
  try {
    const basket = await getBasketState();
    const maxCut = basket.entries
      .filter((e) => !e.isStable)
      .reduce((mx, e) => {
        const cut =
          e.baseWeightBps > 0
            ? Math.max(0, ((e.baseWeightBps - e.dynamicWeightBps) / e.baseWeightBps) * 100)
            : 0;
        return Math.max(mx, cut);
      }, 0);
    const liveCode = maxCut <= 0 ? 0 : maxCut < 40 ? 1 : 2;
    liveRegime = REGIME_LABELS[liveCode];
    stillCurrent = liveCode === message.regime;
  } catch {
    /* leave null — RPC hiccup shouldn't fail the crypto verification */
  }

  // Overall verdict: integrity not falsified, canonical schema, not expired, and
  // (if signed) a valid signature from the expected attestor when one is known.
  const trustable =
    integrityOk !== false &&
    schemaMatches &&
    !expired &&
    (signature ? signatureOk === true && isGblinAttestor !== false : true);

  const guidance = !signature
    ? "Unsigned attestation: integrity + freshness verified, but authenticity relies on the gblin.digital TLS origin. Prefer signed attestations for counterparty gating."
    : isGblinAttestor === null
      ? "Signature is cryptographically valid, but this MCP build has no published GBLIN attestor to compare against. Pass expected_attestor or set GBLIN_ATTESTOR_ADDRESS."
      : isGblinAttestor
        ? "Signed by GBLIN's published attestor."
        : "WARNING: signature does NOT match GBLIN's published attestor — do not trust this attestation.";

  return toolResult({
    valid: trustable,
    checks: {
      integrity: integrityOk === null ? "no_id_to_compare" : integrityOk,
      schema_matches_gblin: schemaMatches,
      signed: !!signature,
      signature_valid: signatureOk,
      recovered_signer: recoveredSigner,
      is_gblin_attestor: isGblinAttestor,
      expected_attestor:
        expectedAttestor.toLowerCase() === ZERO_ADDR ? "not_published_in_this_build" : expectedAttestor,
      expired,
      seconds_to_expiry: secondsToExpiry,
    },
    attested: {
      regime: REGIME_LABELS[message.regime] ?? "unknown",
      severity_pct: message.severityBps / 100,
      defensive_cash_pct: message.defensiveCashBps / 100,
      block_number: Number(message.blockNumber),
      issued_at: Number(message.issuedAt),
      expires_at: expiresAtNum,
    },
    live: { regime: liveRegime, still_current: stillCurrent },
    recomputed_attestation_id: recomputedId,
    guidance,
    source: "GBLIN Risk Attestation verifier — keyless integrity + EIP-712 recover + live drift",
  });
}

// ───────────────────────────────────────────────────────────────────────────
// REGISTRY
// ───────────────────────────────────────────────────────────────────────────

// MCP tool annotations. Every tool here reads the chain or does pure math and returns data or
// unsigned calldata: nothing is written, signed or broadcast, so each one is read-only, safe to
// repeat with the same arguments, and reaches an open world (Base mainnet through the configured RPC).
// The receipt tools declare their own: sealing appends to a public log.
const READ_ONLY_ANNOTATIONS: { readOnlyHint: boolean; idempotentHint: boolean; destructiveHint: boolean; openWorldHint: boolean } =
  { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true };

/** A short human title per tool, shown by clients that render one. */
const TOOL_TITLES: ReadonlyArray<readonly [{ name: string }, string]> = [
  [GET_TREASURY_STATE_DEFINITION, "Read the GBLIN protocol state"] as const,
  [QUOTE_SAFE_SWAP_DEFINITION, "Quote a mint or a redemption"] as const,
  [JIT_SWAP_DEFINITION, "Exit to USDC just in time"] as const,
  [INVEST_DEFINITION, "Convert USDC into GBLIN"] as const,
  [ANALYZE_TREASURY_DEFINITION, "Analyse an agent treasury"] as const,
  [GET_GOVERNANCE_STATE_DEFINITION, "Verify governance and the timelock"] as const,
  [SHARE_SKILL_DEFINITION, "Share the GBLIN skill with a peer"] as const,
  [GET_AUCTION_STATE_DEFINITION, "Read the rebalancing auction"] as const,
  [MARKET_RISK_DEFINITION, "Read the market risk regime"] as const,
  [VERIFY_ATTESTATION_DEFINITION, "Verify a risk attestation"] as const,
];

export const TOOL_DEFINITIONS = [
  GET_TREASURY_STATE_DEFINITION,
  QUOTE_SAFE_SWAP_DEFINITION,
  JIT_SWAP_DEFINITION,
  INVEST_DEFINITION,
  ANALYZE_TREASURY_DEFINITION,
  GET_GOVERNANCE_STATE_DEFINITION,
  SHARE_SKILL_DEFINITION,
  GET_AUCTION_STATE_DEFINITION,
  MARKET_RISK_DEFINITION,
  VERIFY_ATTESTATION_DEFINITION,
].map((definition) => ({
    ...definition,
    annotations: {
      ...READ_ONLY_ANNOTATIONS,
      title: TOOL_TITLES.find(([d]) => d.name === definition.name)?.[1] ?? definition.name,
    },
  }))
  .concat(RECEIPT_TOOL_DEFINITIONS)
  // The payment tools carry their own annotations: preparing an authorization is not idempotent,
  // because each call mints a fresh nonce.
  .concat([PREPARE_PAYMENT_TOOL, VERIFY_AUTHORIZATION_TOOL, RELAY_PAYMENT_TOOL] as never)
  .concat(ACTION_TOOL_DEFINITIONS as never)
  // A declared output schema lets a client validate structuredContent and generate types from it.
  .map((definition) =>
    OUTPUT_SCHEMAS[definition.name] ? { ...definition, outputSchema: OUTPUT_SCHEMAS[definition.name] } : definition
  );

export const TOOL_HANDLERS: Record<string, (args: unknown) => Promise<unknown>> = {
  // ── FREE tools ─────────────────────────────────────────────────────────────
  // Read-only (funnel) + action tools kept free to avoid chicken-and-egg.
  // The on-chain protocol fee on every mint, paid as shares, captures revenue when GBLIN is used.
  get_treasury_state:    handleGetTreasuryState,
  quote_safe_swap:       handleQuoteSafeSwap,
  get_governance_state:  handleGetGovernanceState,
  share_skill_with_peer: handleShareSkillWithPeer,
  swap_gblin_to_usdc_jit: handleJitSwap,
  invest_usdc_to_gblin:   handleInvest,
  verify_risk_attestation: handleVerifyRiskAttestation,
  get_auction_state:       handleGetAuctionState,

  // ── Paying in GBLIN with a signature (EIP-3009), like USDC ────────────────
  prepare_gblin_payment:      handlePreparePayment as (args: unknown) => Promise<unknown>,
  verify_gblin_authorization: handleVerifyAuthorization as (args: unknown) => Promise<unknown>,
  relay_gblin_payment:        handleRelayPayment as (args: unknown) => Promise<unknown>,

  // ── PAID tools (x402 intelligence layer) ──────────────────────────────────
  // Analysis — "advice", not transport.
  analyze_treasury_health: requirePayment(TOOL_PRICES.analyze_treasury_health, handleAnalyzeTreasury),
  get_market_risk_regime:  requirePayment(TOOL_PRICES.get_market_risk_regime, handleMarketRiskRegime),


  // ── Prepare, simulate, follow, and the NAV over time ──────────────────────
  ...ACTION_TOOL_HANDLERS,

  // ── AI Action Receipts (free demo + free reads; paid seals via x402 HTTP) ──
  ...RECEIPT_TOOL_HANDLERS,
};
