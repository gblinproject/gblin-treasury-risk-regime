/**
 * GBLIN MCP — prepare, simulate, follow.
 *
 * Four tools that close the loop around a transaction, in the order an agent uses them:
 *
 *   prepare_action          → the unsigned steps for any operation on the vault
 *   preview_steps           → the same steps simulated in sequence against the latest block
 *   get_transaction_status  → what a sent transaction did
 *   get_nav_history         → NAV per share over time, beside ETH and BTC
 *
 * Nothing here signs or sends. Simulation uses eth_simulateV1; history uses historical eth_call,
 * which the default public RPC refuses, so both fall back to public endpoints that serve them.
 */

import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  parseAbi,
  parseUnits,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { z } from "zod";

import { CHAINLINK_AGGREGATOR_ABI, ERC20_ABI, GBLIN_ABI, LENS_ABI, ZAP_ABI } from "./abi.js";
import { getAuctionState } from "./auction.js";
import { client } from "./client.js";
import { GBLIN_LENS, GBLIN_VAULT, GBLIN_ZAP, WETH } from "./config.js";
import { applySlippageBuffer, checkCooldown, getDynamicSlippage } from "./helpers.js";
import { ZAP_GAS_LIMIT, appendBuilderCode, toolError, toolResult, venueDataPerRow } from "./shared.js";

// ─── Shared ─────────────────────────────────────────────────────────────────

/** The first block at which the Lens of the vault in service exists: NAV history starts here. */
const LENS_DEPLOY_BLOCK = 51_563_262n;
/** Base produces a block every two seconds. */
const BLOCKS_PER_HOUR = 1_800n;

/** Public endpoints that serve historical state and eth_simulateV1 (checked on Base mainnet). */
// Checked on Base mainnet for historical eth_call. Several, because a hosted server reaches some and not
// others (mainnet.base.org refuses or rate-limits datacenter ranges, Cloudflare among them), and every failed
// attempt costs a request, so each endpoint is tried once.
const HISTORY_RPCS = [
  "https://gateway.tenderly.co/public/base",
  "https://base-mainnet.public.blastapi.io",
  "https://base.drpc.org",
  "https://base-public.nodies.app",
  "https://mainnet.base.org",
];

const historyClient = createPublicClient({
  chain: base,
  transport: fallback(
    [
      ...(process.env.GBLIN_ARCHIVE_RPC_URL ? [http(process.env.GBLIN_ARCHIVE_RPC_URL, { timeout: 15_000 })] : []),
      ...HISTORY_RPCS.map((url) => http(url, { timeout: 15_000, retryCount: 0 })),
    ],
    { rank: false }
  ),
});

/**
 * One client per endpoint, asked in turn. A fallback transport moves on only when an endpoint errors,
 * but an endpoint a block behind answers "no receipt yet" without erroring, and a transaction already
 * mined would be reported as pending. Asking each until one has the receipt avoids that.
 */
const ENDPOINT_CLIENTS = [
  client,
  ...HISTORY_RPCS.map((url) => createPublicClient({ chain: base, transport: http(url, { timeout: 8_000, retryCount: 0 }) })),
];
async function firstNonNull<T>(read: (c: typeof client) => Promise<T | null>): Promise<T | null> {
  for (const c of ENDPOINT_CLIENTS) {
    const value = await read(c as typeof client).catch(() => null);
    if (value) return value;
  }
  return null;
}

/** Custom errors of the vault, the Zap and the adapter, from the verified sources. */
const PROTOCOL_ERRORS = parseAbi([
  "error AssetAlreadyExists()",
  "error AuthorizationInvalid()",
  "error BadRoute()",
  "error CooldownActive()",
  "error DepositTooSmall()",
  "error EthRefused()",
  "error FillOpen()",
  "error InsufficientGas()",
  "error InvalidAddress()",
  "error InvalidAmount()",
  "error InvalidIndex()",
  "error InvalidParameters()",
  "error InvalidRouter()",
  "error LegNotDelivered(address token)",
  "error ListingDelayActive()",
  "error NoAssetProposed()",
  "error NoAuction()",
  "error NoPool()",
  "error NothingDelivered()",
  "error NothingToClaim()",
  "error ParamOutOfBounds()",
  "error PriceOffTwap(int24 spot, int24 twapTick)",
  "error PriceUnavailable()",
  "error ScaleMismatch()",
  "error SequencerDown()",
  "error SlippageExceeded()",
  "error SwapActive()",
  "error TokenNotConformant()",
  "error Unauthorized()",
  "error WeightOutOfBounds()",
  "error ZeroOutput()",
]);

/** A short explanation for the errors an agent actually meets. */
const ERROR_HINTS: Record<string, string> = {
  CooldownActive: "The redemption cooldown after your own mint has not elapsed; analyze_treasury_health reports the seconds left.",
  PriceUnavailable: "An oracle price is older than the vault accepts, or a basket token did not answer; wait and retry.",
  SlippageExceeded: "The output would be below the minimum you set; re-quote and retry.",
  InsufficientGas: "The gas limit is too low for the vault's capped transfers; use the gas the step carries.",
  NoAuction: "No rebalancing auction is open.",
  SequencerDown: "The Base sequencer uptime feed reports an outage or a recent restart.",
  SwapActive: "An auction fill is in progress in this block; retry in the next block.",
  DepositTooSmall: "The amount is below the vault's minimum deposit.",
  ZeroOutput: "The operation would produce nothing.",
  PriceOffTwap: "The pool price is too far from its time-weighted average: the adapter refuses to trade; retry later.",
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** eth_simulateV1 reports native ETH movements as Transfer logs from this pseudo-address. */
const ETH_PSEUDO = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const AddressSchema = z
  .string()
  .refine((v) => isAddress(v), { message: "Invalid EVM address" })
  .transform((v) => getAddress(v));
const AmountSchema = z.string().regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal string");

function decodeRevert(data: unknown): { error: string; hint?: string } | null {
  if (typeof data !== "string" || !isHex(data) || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: PROTOCOL_ERRORS, data: data as Hex });
    const name = decoded.errorName;
    const args = decoded.args?.length ? `(${decoded.args.map(String).join(", ")})` : "";
    return { error: `${name}${args}`, ...(ERROR_HINTS[name] ? { hint: ERROR_HINTS[name] } : {}) };
  } catch {
    return { error: `unrecognized revert data ${data.slice(0, 10)}` };
  }
}

const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
async function describeToken(address: string): Promise<{ symbol: string; decimals: number }> {
  const key = address.toLowerCase();
  if (key === ETH_PSEUDO) return { symbol: "ETH", decimals: 18 };
  if (key === GBLIN_VAULT.toLowerCase()) return { symbol: "GBLIN", decimals: 18 };
  const cached = tokenMeta.get(key);
  if (cached) return cached;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: key as Address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: key as Address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  const meta = { symbol: String(symbol), decimals: Number(decimals) };
  tokenMeta.set(key, meta);
  return meta;
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

/** Net token movements for `account` in a list of logs, ETH included when the node reports it. */
async function netTransfers(logs: RawLog[], account: string): Promise<{ token: string; symbol: string; delta: string }[]> {
  const me = account.toLowerCase();
  const deltas = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3) continue;
    const from = `0x${(log.topics[1] ?? "").slice(26)}`.toLowerCase();
    const to = `0x${(log.topics[2] ?? "").slice(26)}`.toLowerCase();
    if (from !== me && to !== me) continue;
    const amount = BigInt(log.data === "0x" ? 0 : log.data);
    const token = log.address.toLowerCase();
    const signed = (to === me ? amount : 0n) - (from === me ? amount : 0n);
    deltas.set(token, (deltas.get(token) ?? 0n) + signed);
  }
  const out: { token: string; symbol: string; delta: string }[] = [];
  for (const [token, delta] of deltas) {
    if (delta === 0n) continue;
    const meta = await describeToken(token);
    out.push({
      token: token === ETH_PSEUDO ? "ETH" : getAddress(token),
      symbol: meta.symbol,
      delta: formatUnits(delta, meta.decimals),
    });
  }
  return out;
}

// ─── prepare_action ─────────────────────────────────────────────────────────

const ACTIONS = [
  "mint_with_eth",
  "mint_with_weth",
  "mint_with_usdc",
  "redeem_in_kind",
  "exit_to_eth",
  "exit_to_usdc",
  "bid",
] as const;

const PrepareSchema = z.object({
  action: z.enum(ACTIONS),
  wallet_address: AddressSchema,
  amount: AmountSchema.optional(),
  row: z.number().int().nonnegative().optional(),
});

export const PREPARE_ACTION_DEFINITION = {
  name: "prepare_action",
  description:
    "Build the unsigned transactions for any operation on the GBLIN vault, in the order to send them. Actions: mint_with_eth (amount in ETH), mint_with_weth (amount in WETH), mint_with_usdc (amount in USDC, through the Zap), redeem_in_kind (amount in shares; pro rata basket tokens, no fee, no price feed), exit_to_eth (amount in shares, through the Zap, all or nothing), exit_to_usdc (amount = the USDC you need), bid (trade with the rebalancing auction; row optional, the largest gap by default). Every output bound is non-zero and every step through the vault or the Zap carries its gas limit. Nothing is signed or sent: simulate the steps with preview_steps, then send them from the wallet.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: [...ACTIONS], description: "The operation to prepare." },
      wallet_address: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "The wallet that will sign and receive." },
      amount: {
        type: "string",
        pattern: "^\\d+(\\.\\d+)?$",
        description: "Decimal amount. Unit depends on the action (see the description). Not used by bid.",
      },
      row: { type: "integer", minimum: 0, description: "bid only: the basket row to bid on. Default: the row with the largest gap." },
    },
    required: ["action", "wallet_address"],
    additionalProperties: false,
  },
};

interface Step {
  step: number;
  description: string;
  target: Address;
  calldata: Hex;
  value: string;
  gas?: string;
}

function withAction(action: string, inner: unknown) {
  const res = inner as { isError?: boolean; structuredContent?: Record<string, unknown> };
  if (res.isError || !res.structuredContent) return inner;
  return toolResult({
    action,
    ...res.structuredContent,
    next: "Simulate the steps with preview_steps, then send them in order from the wallet.",
  });
}

export async function handlePrepareAction(args: unknown) {
  const parsed = PrepareSchema.safeParse(args);
  if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { action, wallet_address: wallet, amount, row } = parsed.data;
  if (action !== "bid" && !amount) return toolError(`amount is required for ${action}.`);

  try {
    // Loaded at call time: tools.ts registers this module, so a static import would be circular.
    if (action === "mint_with_usdc") {
      const { handleInvest } = await import("./tools.js");
      return withAction(action, await handleInvest({ usdc_amount: amount, wallet_address: wallet }));
    }
    if (action === "exit_to_usdc") {
      const { handleJitSwap } = await import("./tools.js");
      return withAction(action, await handleJitSwap({ usdc_needed: amount, wallet_address: wallet }));
    }

    const slippage = await getDynamicSlippage();
    const warnings: string[] = [];
    let steps: Step[] = [];
    let expected: Record<string, unknown> = {};

    if (action === "mint_with_eth" || action === "mint_with_weth") {
      const value = parseUnits(amount!, 18);
      if (value === 0n) return toolError("amount must be greater than zero.");
      const [out] = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteBuy", args: [GBLIN_VAULT, value] });
      const minOut = applySlippageBuffer(out, slippage.bps);
      if (minOut === 0n) return toolError("The quote is zero: the amount is too small or the NAV cannot be priced now.");
      if (action === "mint_with_eth") {
        steps = [
          {
            step: 1,
            description: "Mint GBLIN with ETH at NAV",
            target: GBLIN_VAULT,
            calldata: appendBuilderCode(encodeFunctionData({ abi: GBLIN_ABI, functionName: "buyGBLIN", args: [minOut] })) as Hex,
            value: value.toString(),
            gas: ZAP_GAS_LIMIT.toString(),
          },
        ];
      } else {
        steps = [
          {
            step: 1,
            description: "Approve WETH to the vault",
            target: WETH,
            calldata: appendBuilderCode(encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [GBLIN_VAULT, value] })) as Hex,
            value: "0",
          },
          {
            step: 2,
            description: "Mint GBLIN with WETH at NAV",
            target: GBLIN_VAULT,
            calldata: appendBuilderCode(
              encodeFunctionData({ abi: GBLIN_ABI, functionName: "buyGBLINWithWeth", args: [value, minOut, wallet] })
            ) as Hex,
            value: "0",
            gas: ZAP_GAS_LIMIT.toString(),
          },
        ];
      }
      expected = { shares_out: formatUnits(out, 18), min_shares_out: formatUnits(minOut, 18), slippage_buffer_pct: slippage.pct };
    }

    if (action === "redeem_in_kind" || action === "exit_to_eth") {
      const shares = parseUnits(amount!, 18);
      if (shares === 0n) return toolError("amount must be greater than zero.");
      const [balance, cooldown] = await Promise.all([
        client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "balanceOf", args: [wallet] }),
        checkCooldown(wallet),
      ]);
      if (balance < shares) warnings.push(`The wallet holds ${formatUnits(balance, 18)} shares, less than ${amount}.`);
      if (cooldown.active) warnings.push(`The redemption cooldown after your own mint is active for ${cooldown.secondsRemaining} more seconds.`);

      if (action === "redeem_in_kind") {
        const [supply, rowCount] = await Promise.all([
          client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "totalSupply" }),
          client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "basketLength", args: [GBLIN_VAULT] }),
        ]);
        const legs: Record<string, string>[] = [];
        for (let i = 0n; i < rowCount; i++) {
          const r = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "asset", args: [GBLIN_VAULT, i] });
          if (r[7]) continue;
          const held = await client.readContract({ address: r[0], abi: ERC20_ABI, functionName: "balanceOf", args: [GBLIN_VAULT] });
          const meta = await describeToken(r[0]);
          const isWeth = r[0].toLowerCase() === WETH.toLowerCase();
          legs.push({
            token: isWeth ? "ETH" : r[0],
            symbol: isWeth ? "ETH" : meta.symbol,
            approx_amount: formatUnits(supply > 0n ? (held * shares) / supply : 0n, meta.decimals),
          });
        }
        steps = [
          {
            step: 1,
            description: "Redeem in kind: receive your pro rata share of every basket token",
            target: GBLIN_VAULT,
            calldata: appendBuilderCode(encodeFunctionData({ abi: GBLIN_ABI, functionName: "sellGBLIN", args: [shares] })) as Hex,
            value: "0",
            gas: ZAP_GAS_LIMIT.toString(),
          },
        ];
        expected = {
          legs,
          note: "Pro rata of the vault's balances; the WETH leg is paid in ETH. No fee and no price feed are involved. A leg a token refuses to deliver becomes a credit claimable with claimPending(token).",
        };
      } else {
        const ethOut = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteSell", args: [GBLIN_VAULT, shares] });
        const minEthOut = applySlippageBuffer(ethOut, slippage.bps);
        const venue = await venueDataPerRow();
        steps = [
          {
            step: 1,
            description: "Approve the shares to the GBLIN Zap",
            target: GBLIN_VAULT,
            calldata: appendBuilderCode(encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [GBLIN_ZAP, shares] })) as Hex,
            value: "0",
          },
          {
            step: 2,
            description: "Redeem in kind and sell every leg for ETH through the Zap (all or nothing)",
            target: GBLIN_ZAP,
            calldata: appendBuilderCode(
              encodeFunctionData({ abi: ZAP_ABI, functionName: "sellGBLINForEth", args: [shares, minEthOut, venue, wallet] })
            ) as Hex,
            value: "0",
            gas: ZAP_GAS_LIMIT.toString(),
          },
        ];
        expected = { eth_out: formatUnits(ethOut, 18), min_eth_out: formatUnits(minEthOut, 18), slippage_buffer_pct: slippage.pct };
      }
    }

    if (action === "bid") {
      const state = await getAuctionState();
      const target = row === undefined ? state.best : state.rows.find((r) => r.index === row) ?? null;
      if (!state.auctionOpen) return toolError("No rebalancing auction is open.", "get_auction_state reports when one opens.");
      if (!target || !target.calldata) {
        return toolError(
          row === undefined ? "No row can be bid on right now." : `Row ${row} cannot be bid on right now.`,
          "get_auction_state lists every row with its side and gap."
        );
      }
      steps = [
        {
          step: 1,
          description: `Approve ${target.inputSymbol} to the vault`,
          target: target.calldata.approve.target,
          calldata: target.calldata.approve.data,
          value: "0",
        },
        {
          step: 2,
          description: `Bid on row ${target.index} (${target.symbol}): hand over ${target.inputAmount} ${target.inputSymbol}`,
          target: target.calldata.bid.target,
          calldata: target.calldata.bid.data,
          value: "0",
          gas: ZAP_GAS_LIMIT.toString(),
        },
      ];
      expected = {
        row: target.index,
        vault_buys_asset: target.vaultBuysAsset,
        gap_eth: target.gapEth,
        input: `${target.inputAmount} ${target.inputSymbol}`,
        premium_bps: state.premiumBps,
        note: "You receive the other side at the oracle price adjusted by the premium; the input is reduced to what closes the gap.",
      };
    }

    return toolResult({
      action,
      wallet,
      steps,
      expected,
      warnings,
      next: "Simulate the steps with preview_steps, then send them in order from the wallet, each with the gas it carries.",
    });
  } catch (err) {
    return toolError((err as Error).message, "Check RPC connectivity and oracle freshness.");
  }
}

// ─── preview_steps ──────────────────────────────────────────────────────────

const StepInputSchema = z.object({
  target: AddressSchema,
  calldata: z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "calldata must be 0x-prefixed hex"),
  value: z.string().regex(/^\d+$/).optional(),
  gas: z.string().regex(/^\d+$/).optional(),
  description: z.string().optional(),
  step: z.number().optional(),
});

const PreviewSchema = z.object({
  from: AddressSchema,
  steps: z.array(StepInputSchema).min(1).max(8),
});

export const PREVIEW_STEPS_DEFINITION = {
  name: "preview_steps",
  description:
    "Simulate a list of transactions in sequence against the latest Base block, as if the wallet sent them one after the other, before anything is signed. Each step sees the state the previous ones left (an approval before a mint works). Returns, per step, whether it would succeed, the gas it uses, whether the gas limit it carries is enough, and the decoded revert reason with a hint when it fails; and the net token and ETH movements for the wallet. Pass the steps exactly as prepare_action, invest_usdc_to_gblin or swap_gblin_to_usdc_jit return them. State can change before your transactions land: a successful preview is evidence, not a guarantee.",
  inputSchema: {
    type: "object" as const,
    properties: {
      from: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$", description: "The wallet that will send the steps." },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        description: "The steps, in order: target, calldata, value in wei (optional), gas (optional).",
        items: {
          type: "object",
          properties: {
            target: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
            calldata: { type: "string", pattern: "^0x([0-9a-fA-F]{2})*$" },
            value: { type: "string", pattern: "^\\d+$" },
            gas: { type: "string", pattern: "^\\d+$" },
          },
          required: ["target", "calldata"],
          additionalProperties: true,
        },
      },
    },
    required: ["from", "steps"],
    additionalProperties: false,
  },
};

interface SimCall {
  status: string;
  gasUsed: string;
  maxUsedGas?: string;
  logs?: RawLog[];
  returnData?: string;
  error?: { code?: number; message?: string; data?: string };
}

async function simulate(from: Address, steps: z.infer<typeof StepInputSchema>[]): Promise<{ calls: SimCall[]; number: string }> {
  const params = [
    {
      blockStateCalls: [
        {
          calls: steps.map((s) => ({
            from,
            to: s.target,
            data: s.calldata,
            ...(s.value && s.value !== "0" ? { value: toHex(BigInt(s.value)) } : {}),
            ...(s.gas ? { gas: toHex(BigInt(s.gas)) } : {}),
          })),
        },
      ],
      traceTransfers: true,
      validation: false,
    },
    "latest",
  ];
  let lastError: unknown;
  for (const c of [client, historyClient]) {
    try {
      const res = (await (c as { request: (a: unknown) => Promise<unknown> }).request({ method: "eth_simulateV1", params })) as
        | { calls: SimCall[]; number: string }[]
        | undefined;
      if (res?.[0]?.calls) return res[0];
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`eth_simulateV1 is not available on the configured RPC or the public fallbacks: ${(lastError as Error)?.message ?? "no result"}`);
}

/**
 * The smallest gas limit with which step `i` still succeeds, found by bisection on simulations.
 * For calls into the vault or the Zap the gas a step USES is not the limit it NEEDS: the vault checks
 * that enough gas is left for its capped transfers before making them, so the required limit sits
 * well above the gas consumed. Only a search against the real contract finds it.
 */
async function minimalGasLimit(
  from: Address,
  steps: z.infer<typeof StepInputSchema>[],
  i: number,
  used: bigint
): Promise<bigint | null> {
  const upTo = steps.slice(0, i + 1).map(({ gas: _gas, ...rest }, k) => (k === i ? rest : { ...rest }));
  const passes = async (limit: bigint) => {
    const trial = upTo.map((st, k) => (k === i ? { ...st, gas: limit.toString() } : st));
    const r = await simulate(from, trial).catch(() => null);
    return r?.calls[i]?.status === "0x1";
  };
  let lo = used;
  let hi = used * 3n > 3_000_000n ? used * 3n : 3_000_000n;
  if (!(await passes(hi))) return null;
  while (hi - lo > 2_000n) {
    const mid = (lo + hi) / 2n;
    if (await passes(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

const RESERVE_TARGETS = new Set([GBLIN_VAULT.toLowerCase(), GBLIN_ZAP.toLowerCase()]);

export async function handlePreviewSteps(args: unknown) {
  const parsed = PreviewSchema.safeParse(args);
  if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { from, steps } = parsed.data;
  try {
    const sim = await simulate(from, steps);
    // When a step fails under the limit it carries, simulate again without limits: if it then succeeds,
    // the limit was the cause, and the unbounded run measures what the step really needs.
    const failedUnderLimit = sim.calls.some((c, i) => c.status !== "0x1" && steps[i]?.gas);
    const unbounded = failedUnderLimit
      ? await simulate(from, steps.map(({ gas: _gas, ...rest }) => rest)).catch(() => null)
      : null;
    const allLogs: RawLog[] = [];
    let wouldSucceed = true;
    const results = [];
    for (let i = 0; i < sim.calls.length; i++) {
      const call = sim.calls[i]!;
      const s = steps[i]!;
      const ok = call.status === "0x1";
      const gasUsed = BigInt(call.gasUsed ?? "0x0");
      const free = unbounded?.calls[i];
      const outOfGas = !ok && Boolean(s.gas) && free?.status === "0x1";
      const measured = outOfGas && free ? free : call;
      const peak = measured.maxUsedGas ? BigInt(measured.maxUsedGas) : BigInt(measured.gasUsed ?? "0x0");
      // Steps into the vault or the Zap: the minimal passing limit found by bisection, plus a tenth.
      // Other steps: a fifth above the peak gas the call touched.
      let recommended = (peak * 12n) / 10n;
      if (RESERVE_TARGETS.has(s.target.toLowerCase()) && (ok || outOfGas)) {
        const earlierOk = sim.calls.slice(0, i).every((c) => c.status === "0x1");
        const minimal = earlierOk ? await minimalGasLimit(from, steps, i, peak) : null;
        if (minimal) recommended = (minimal * 11n) / 10n;
      }
      const given = s.gas ? BigInt(s.gas) : null;
      if (!ok) wouldSucceed = false;
      if (ok) allLogs.push(...(call.logs ?? []));
      const revert = ok
        ? null
        : outOfGas
          ? { error: "Out of gas at the limit this step carries: it succeeds with a higher limit.", hint: ERROR_HINTS.InsufficientGas }
          : decodeRevert(call.error?.data ?? call.returnData);
      results.push({
        step: s.step ?? i + 1,
        target: s.target,
        ...(s.description ? { description: s.description } : {}),
        success: ok,
        gas_used: Number(gasUsed),
        gas_limit_given: given === null ? null : Number(given),
        // true when the step passes with its limit; false only when the limit is what makes it fail;
        // null when it fails for another reason, since the simulation cannot tell whether the limit would do.
        gas_limit_enough: given === null ? null : ok ? true : outOfGas ? false : null,
        recommended_gas_limit: Number(recommended),
        ...(given === null && RESERVE_TARGETS.has(s.target.toLowerCase())
          ? { gas_warning: "No gas limit given: send this step with recommended_gas_limit. A wallet's automatic estimate can fall under what the vault's capped transfers need." }
          : {}),
        ...(ok
          ? {}
          : {
              error: revert?.error ?? call.error?.message ?? "reverted",
              ...(revert?.hint ? { hint: revert.hint } : {}),
            }),
      });
    }
    // Steps after a failure cannot be trusted: the wallet would stop at the first revert.
    const firstFailure = results.findIndex((r) => !r.success);
    return toolResult({
      would_succeed: wouldSucceed,
      from,
      block: Number(BigInt(sim.number)),
      steps: results,
      first_failing_step: firstFailure === -1 ? null : results[firstFailure]!.step,
      balance_changes: wouldSucceed ? await netTransfers(allLogs, from) : [],
      note: "Simulated in sequence against the latest block, without signature or nonce checks. State can change before your transactions land: a successful preview is evidence, not a guarantee.",
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ─── get_transaction_status ─────────────────────────────────────────────────

const TxStatusSchema = z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "hash must be a 32-byte 0x hex string") });

export const TX_STATUS_DEFINITION = {
  name: "get_transaction_status",
  description:
    "Report what a sent Base transaction did: pending, succeeded, reverted or not found; its block and confirmations; the fee paid; the net token movements for the sender (GBLIN shares minted or redeemed, USDC, basket tokens); and, when it reverted, the decoded reason. Use it after sending the steps from prepare_action to confirm each one before the next.",
  inputSchema: {
    type: "object" as const,
    properties: { hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "The transaction hash." } },
    required: ["hash"],
    additionalProperties: false,
  },
};

export async function handleTransactionStatus(args: unknown) {
  const parsed = TxStatusSchema.safeParse(args);
  if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const hash = parsed.data.hash as Hex;
  try {
    const receipt = await firstNonNull((c) => c.getTransactionReceipt({ hash }));
    if (!receipt) {
      const tx = await firstNonNull((c) => c.getTransaction({ hash }));
      return toolResult({
        hash,
        status: tx ? "pending" : "not_found",
        note: tx ? "Known to the node but not yet in a block." : "No node consulted knows this hash. It may not have been broadcast.",
      });
    }
    const [latest, tx] = await Promise.all([
      firstNonNull((c) => c.getBlockNumber()),
      firstNonNull((c) => c.getTransaction({ hash })),
    ]);
    const succeeded = receipt.status === "success";
    let revert: { error: string; hint?: string } | null = null;
    if (!succeeded && tx) {
      try {
        await historyClient.call({ account: tx.from, to: tx.to ?? undefined, data: tx.input, value: tx.value, blockNumber: receipt.blockNumber - 1n });
        revert = { error: "The call succeeds when replayed on the parent block: it most likely ran out of gas.", hint: ERROR_HINTS.InsufficientGas };
      } catch (err) {
        const data = (err as { cause?: { data?: string }; data?: string }).cause?.data ?? (err as { data?: string }).data;
        revert = decodeRevert(data) ?? { error: (err as Error).message.split("\n")[0] ?? "reverted" };
      }
    }
    const l1Fee = (receipt as { l1Fee?: bigint | null }).l1Fee ?? 0n;
    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice + (l1Fee ?? 0n);
    return toolResult({
      hash,
      status: succeeded ? "success" : "reverted",
      block: Number(receipt.blockNumber),
      confirmations: latest ? Number(latest - receipt.blockNumber + 1n) : null,
      from: receipt.from,
      to: receipt.to,
      gas_used: Number(receipt.gasUsed),
      gas_limit: tx ? Number(tx.gas) : null,
      fee_eth: formatUnits(feeWei, 18),
      balance_changes: succeeded
        ? await netTransfers(receipt.logs.map((l) => ({ address: l.address, topics: l.topics as string[], data: l.data })), receipt.from)
        : [],
      ...(revert ? { revert } : {}),
      explorer: `https://basescan.org/tx/${hash}`,
    });
  } catch (err) {
    return toolError((err as Error).message);
  }
}

// ─── get_nav_history ────────────────────────────────────────────────────────

const HistorySchema = z.object({
  interval: z.enum(["hour", "day"]).default("day"),
  points: z.number().int().min(2).max(90).default(30),
});

export const NAV_HISTORY_DEFINITION = {
  name: "get_nav_history",
  description:
    "NAV per GBLIN share over time, read from the chain at past blocks, beside the ETH/USD and BTC/USD oracle prices the vault itself uses, with the change of each over the window and the NAV's largest drawdown. History starts at the deployment of the vault in service. Use it to judge how the index behaved against holding ETH or BTC over the same span.",
  inputSchema: {
    type: "object" as const,
    properties: {
      interval: { type: "string", enum: ["hour", "day"], description: "Spacing of the points. Default day." },
      points: { type: "integer", minimum: 2, maximum: 90, description: "How many points, newest last. Default 30." },
    },
    additionalProperties: false,
  },
};

const pct = (a: number, b: number) => (a > 0 ? Number((((b - a) / a) * 100).toFixed(2)) : null);

export async function handleNavHistory(args: unknown) {
  const parsed = HistorySchema.safeParse(args ?? {});
  if (!parsed.success) return toolError(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { interval, points } = parsed.data;
  try {
    const step = interval === "hour" ? BLOCKS_PER_HOUR : BLOCKS_PER_HOUR * 24n;
    const latest = await historyClient.getBlockNumber();

    // The feeds are the vault's own: the WETH oracle, and the oracle of the non-stable, non-WETH row.
    const [wethOracle, rowCount] = await Promise.all([
      client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "wethOracle", args: [GBLIN_VAULT] }),
      client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "basketLength", args: [GBLIN_VAULT] }),
    ]);
    let btcOracle: Address | null = null;
    for (let i = 0n; i < rowCount && !btcOracle; i++) {
      const r = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "asset", args: [GBLIN_VAULT, i] });
      if (!r[2] && r[0].toLowerCase() !== WETH.toLowerCase() && !r[7]) btcOracle = r[1];
    }

    const blocks: bigint[] = [];
    for (let k = 0n; k < BigInt(points); k++) {
      const b = latest - k * step;
      if (b < LENS_DEPLOY_BLOCK) break;
      blocks.unshift(b);
    }
    const truncated = blocks.length < points;

    // One multicall per point (NAV and both feeds read at the same block), and times derived from the
    // block number: Base produces exactly one block every two seconds. That keeps a request inside the
    // subrequest budget of a hosted Worker as well as fast on a local server.
    const latestBlock = await historyClient.getBlock({ blockNumber: latest });
    const series = [];
    for (const blockNumber of blocks) {
      const contracts = [
        { address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteSell", args: [GBLIN_VAULT, 10n ** 18n] },
        { address: wethOracle, abi: CHAINLINK_AGGREGATOR_ABI, functionName: "latestRoundData" },
        ...(btcOracle ? [{ address: btcOracle, abi: CHAINLINK_AGGREGATOR_ABI, functionName: "latestRoundData" }] : []),
      ] as const;
      const out = await historyClient.multicall({ contracts: contracts as never, blockNumber, allowFailure: false });
      const navEthWei = out[0] as bigint;
      const eth = out[1] as readonly [bigint, bigint, bigint, bigint, bigint];
      const btc = (btcOracle ? out[2] : null) as readonly [bigint, bigint, bigint, bigint, bigint] | null;
      const timestamp = Number(latestBlock.timestamp) - Number(latest - blockNumber) * 2;
      const ethUsd = Number(eth[1]) / 1e8;
      const navEth = Number(formatUnits(navEthWei, 18));
      series.push({
        time: new Date(timestamp * 1000).toISOString(),
        block: Number(blockNumber),
        nav_eth: Number(navEth.toFixed(8)),
        nav_usd: Number((navEth * ethUsd).toFixed(4)),
        eth_usd: Number(ethUsd.toFixed(2)),
        btc_usd: btc ? Number((Number(btc[1]) / 1e8).toFixed(2)) : null,
      });
    }

    const first = series[0];
    const last = series[series.length - 1];
    let peak = 0;
    let maxDrawdown = 0;
    for (const p of series) {
      peak = Math.max(peak, p.nav_usd);
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - p.nav_usd) / peak);
    }
    return toolResult({
      interval,
      points: series.length,
      series,
      summary: first && last
        ? {
            from: first.time,
            to: last.time,
            nav_usd_change_pct: pct(first.nav_usd, last.nav_usd),
            eth_usd_change_pct: pct(first.eth_usd, last.eth_usd),
            btc_usd_change_pct: first.btc_usd && last.btc_usd ? pct(first.btc_usd, last.btc_usd) : null,
            nav_max_drawdown_pct: Number((maxDrawdown * 100).toFixed(2)),
          }
        : null,
      ...(truncated ? { note: "The window reaches back before the vault in service existed: history starts at its deployment." } : {}),
      method: "NAV per share = the Lens quote for redeeming one share, in ETH, times the vault's ETH/USD oracle, read at each block.",
    });
  } catch (err) {
    return toolError(
      (err as Error).message,
      "Historical reads need an archive-capable RPC. Set GBLIN_ARCHIVE_RPC_URL, or retry: the public fallbacks rate-limit."
    );
  }
}

export const ACTION_TOOL_HANDLERS: Record<string, (args: unknown) => Promise<unknown>> = {
  prepare_action: handlePrepareAction,
  preview_steps: handlePreviewSteps,
  get_transaction_status: handleTransactionStatus,
  get_nav_history: handleNavHistory,
};

export const ACTION_TOOL_DEFINITIONS = [
  { def: PREPARE_ACTION_DEFINITION, title: "Prepare an operation on the vault" },
  { def: PREVIEW_STEPS_DEFINITION, title: "Simulate steps before signing" },
  { def: TX_STATUS_DEFINITION, title: "Read a transaction's outcome" },
  { def: NAV_HISTORY_DEFINITION, title: "Read the NAV history" },
].map(({ def, title }) => ({
  ...def,
  annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}));
