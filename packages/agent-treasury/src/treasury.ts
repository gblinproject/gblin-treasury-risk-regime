/**
 * The treasury policy, in one sentence: operating cash stays in USDC, surplus above the reserve is
 * parked in GBLIN, and USDC is pulled back from GBLIN just in time when a payment needs it.
 *
 * Every write here is one of the two moves in ./steps.ts, sent from the agent's own wallet and
 * confirmed with a receipt before the next step. Nothing is custodied and no key leaves the process.
 */

import { formatUnits, parseUnits, type Address, type Hex, type PublicClient } from "viem";

import { makeClient, readAtBlock, waitForReceipt } from "./chain.js";
import { VAULT_ABI } from "./abi.js";
import { GBLIN_VAULT } from "./config.js";
import { readBalances, readCooldown, readPrices, readRegime, type Balances, type Regime } from "./quotes.js";
import { planExitToUsdc, planMintFromUsdc, type Step } from "./steps.js";
import type { TreasurySigner } from "./signer.js";

export interface TreasuryPolicy {
  /** USDC kept liquid for payments. Surplus above it may be parked. Default 10. */
  reserveUsdc: number;
  /** Below this surplus nothing is parked (dust is not worth a mint). Default 5. */
  minParkUsdc: number;
  /** Largest single exit, a guard against a runaway loop. Default 50. */
  maxExitUsdc: number;
  /** Largest single x402 payment the treasury will sign. Default 1. */
  maxPayUsdc: number;
  /** ETH kept for gas; parking is skipped below it. Default 0.0005. */
  minGasEth: number;
  /** Skip parking while the market regime is a crash. Default true. */
  riskGate: boolean;
}

export const DEFAULT_POLICY: TreasuryPolicy = {
  reserveUsdc: 10,
  minParkUsdc: 5,
  maxExitUsdc: 50,
  maxPayUsdc: 1,
  minGasEth: 0.0005,
  riskGate: true,
};

export interface TreasuryOptions {
  signer: TreasurySigner;
  rpcUrl?: string;
  policy?: Partial<TreasuryPolicy>;
  /** Receives one line per event; defaults to silence. */
  log?: (line: string) => void;
}

export interface TreasuryStatus {
  address: Address;
  usdc: string;
  gblin: string;
  gblinValueUsd: string;
  eth: string;
  totalUsd: string;
  navUsd: string;
  reserveUsdc: number;
  surplusUsdc: string;
  regime: Regime;
  regimeSource: string;
  cooldownSecondsRemaining: number;
  navReliable: boolean;
  canPark: boolean;
  canParkReason: string;
}

export interface MoveResult {
  action: "none" | "exited" | "parked";
  reason: string;
  usdcBefore: string;
  usdcAfter: string;
  gblinBefore: string;
  gblinAfter: string;
  txHashes: Hex[];
  /** Block of the last confirmed transaction; the "after" balances were read at that block. */
  block: number | null;
}

export class Treasury {
  readonly address: Address;
  readonly policy: TreasuryPolicy;
  readonly client: PublicClient;
  private readonly signer: TreasurySigner;
  private readonly rpcUrl: string | undefined;
  private readonly log: (line: string) => void;
  /** Serialises moves: two concurrent payments must not both exit for the same shortfall. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: TreasuryOptions) {
    this.signer = options.signer;
    this.address = options.signer.address;
    this.rpcUrl = options.rpcUrl;
    this.client = makeClient(options.rpcUrl);
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.log = options.log ?? (() => undefined);
  }

  get treasurySigner(): TreasurySigner {
    return this.signer;
  }

  async status(): Promise<TreasuryStatus> {
    const [b, prices, cooldown, regime, navReliable] = await Promise.all([
      readBalances(this.client, this.address),
      readPrices(this.client),
      readCooldown(this.client, this.address),
      readRegime(),
      this.client.readContract({ address: GBLIN_VAULT, abi: VAULT_ABI, functionName: "isNavReliable" }).catch(() => false),
    ]);
    const usdc = Number(formatUnits(b.usdc, 6));
    const gblin = Number(formatUnits(b.gblin, 18));
    const eth = Number(formatUnits(b.eth, 18));
    const surplus = Math.max(0, usdc - this.policy.reserveUsdc);
    const gate = this.parkGate({ surplus, eth, regime: regime.regime, navReliable });
    return {
      address: this.address,
      usdc: usdc.toFixed(6),
      gblin: gblin.toFixed(6),
      gblinValueUsd: (gblin * prices.navUsd).toFixed(2),
      eth: eth.toFixed(6),
      totalUsd: (usdc + gblin * prices.navUsd + eth * prices.ethUsd).toFixed(2),
      navUsd: prices.navUsd.toFixed(4),
      reserveUsdc: this.policy.reserveUsdc,
      surplusUsdc: surplus.toFixed(6),
      regime: regime.regime,
      regimeSource: regime.source,
      cooldownSecondsRemaining: cooldown.secondsRemaining,
      navReliable,
      canPark: gate.ok,
      canParkReason: gate.reason,
    };
  }

  private parkGate(s: { surplus: number; eth: number; regime: Regime; navReliable: boolean }): { ok: boolean; reason: string } {
    if (s.surplus < this.policy.minParkUsdc) return { ok: false, reason: `surplus ${s.surplus.toFixed(2)} USDC is below the ${this.policy.minParkUsdc} USDC minimum` };
    if (s.eth < this.policy.minGasEth) return { ok: false, reason: `ETH for gas ${s.eth.toFixed(6)} is below the ${this.policy.minGasEth} floor` };
    if (!s.navReliable) return { ok: false, reason: "the vault reports its NAV as not reliable right now" };
    if (this.policy.riskGate && s.regime === "crash") return { ok: false, reason: "the market regime is a crash; parking waits" };
    if (this.policy.riskGate && s.regime === "unknown") return { ok: false, reason: "the market regime could not be read; parking waits" };
    return { ok: true, reason: "surplus above the reserve, gas available, NAV reliable, regime allows it" };
  }

  /** Makes sure the wallet holds at least `usdcAmount` USDC, exiting GBLIN if it does not. */
  ensureUsdc(usdcAmount: number | string): Promise<MoveResult> {
    return this.serial(() => this.ensureUsdcNow(parseUnits(String(usdcAmount), 6)));
  }

  /** Parks the surplus above the reserve in GBLIN, when the policy allows it. */
  park(): Promise<MoveResult> {
    return this.serial(() => this.parkNow());
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ensureUsdcNow(target: bigint): Promise<MoveResult> {
    const before = await readBalances(this.client, this.address);
    const base = { usdcBefore: formatUnits(before.usdc, 6), gblinBefore: formatUnits(before.gblin, 18) };
    if (before.usdc >= target) {
      return { action: "none", reason: "USDC already covers the amount", ...base, usdcAfter: base.usdcBefore, gblinAfter: base.gblinBefore, txHashes: [], block: null };
    }
    const shortfall = target - before.usdc;
    const cap = parseUnits(String(this.policy.maxExitUsdc), 6);
    if (shortfall > cap) throw new Error(`The shortfall of ${formatUnits(shortfall, 6)} USDC exceeds the policy cap of ${this.policy.maxExitUsdc} USDC per exit.`);
    if (before.gblin === 0n) throw new Error(`No GBLIN to exit: the wallet holds ${base.usdcBefore} USDC and needs ${formatUnits(target, 6)}.`);
    const cooldown = await readCooldown(this.client, this.address);
    if (cooldown.active) throw new Error(`The redemption cooldown after this wallet's own mint is active for ${cooldown.secondsRemaining} more seconds; retry then.`);
    const plan = await planExitToUsdc(this.client, this.address, shortfall, before.gblin);
    this.log(`exit: selling ${formatUnits(plan.sharesToSell, 18)} GBLIN for at least ${formatUnits(shortfall, 6)} USDC (NAV ${plan.navUsd.toFixed(4)} USD, buffer ${plan.slippageBps} bps)`);
    const { hashes, block } = await this.send(plan.steps);
    const after = await this.balancesAt(block);
    if (after.usdc < target) {
      throw new Error(`All ${hashes.length} transactions confirmed (block ${block}) but USDC read at that block is ${formatUnits(after.usdc, 6)}, below the ${formatUnits(target, 6)} needed. Do not repeat the exit blindly; check the wallet on basescan.org. Transactions: ${hashes.join(", ")}`);
    }
    return { action: "exited", reason: `USDC was short by ${formatUnits(shortfall, 6)}`, ...base, usdcAfter: formatUnits(after.usdc, 6), gblinAfter: formatUnits(after.gblin, 18), txHashes: hashes, block: Number(block) };
  }

  private async parkNow(): Promise<MoveResult> {
    const [before, regime, navReliable] = await Promise.all([
      readBalances(this.client, this.address),
      readRegime(),
      this.client.readContract({ address: GBLIN_VAULT, abi: VAULT_ABI, functionName: "isNavReliable" }).catch(() => false),
    ]);
    const base = { usdcBefore: formatUnits(before.usdc, 6), gblinBefore: formatUnits(before.gblin, 18) };
    const usdc = Number(base.usdcBefore);
    const surplus = Math.max(0, usdc - this.policy.reserveUsdc);
    const gate = this.parkGate({ surplus, eth: Number(formatUnits(before.eth, 18)), regime: regime.regime, navReliable });
    if (!gate.ok) return { action: "none", reason: gate.reason, ...base, usdcAfter: base.usdcBefore, gblinAfter: base.gblinBefore, txHashes: [], block: null };
    const amount = parseUnits(surplus.toFixed(6), 6);
    const plan = await planMintFromUsdc(this.client, this.address, amount);
    this.log(`park: minting GBLIN with ${surplus.toFixed(6)} USDC (at least ${formatUnits(plan.minSharesOut, 18)} shares, buffer ${plan.slippageBps} bps)`);
    const { hashes, block } = await this.send(plan.steps);
    const after = await this.balancesAt(block);
    return { action: "parked", reason: gate.reason, ...base, usdcAfter: formatUnits(after.usdc, 6), gblinAfter: formatUnits(after.gblin, 18), txHashes: hashes, block: Number(block) };
  }

  /** Balances read at `block`, from an endpoint that has it (a lagging replica would return old values). */
  private balancesAt(block: bigint): Promise<Balances> {
    return readAtBlock(this.rpcUrl, block, (c, b) => readBalances(c, this.address, b));
  }

  private async send(steps: Step[]): Promise<{ hashes: Hex[]; block: bigint }> {
    const hashes: Hex[] = [];
    let block = 0n;
    for (const step of steps) {
      const hash = await this.signer.sendTransaction({ to: step.to, data: step.data, value: step.value, ...(step.gas ? { gas: step.gas } : {}) });
      this.log(`sent: ${step.description} -> ${hash}`);
      const receipt = await waitForReceipt(this.rpcUrl, hash);
      if (receipt.status !== "success") throw new Error(`Step "${step.description}" reverted: ${hash}`);
      hashes.push(hash);
      if (receipt.blockNumber > block) block = receipt.blockNumber;
    }
    return { hashes, block };
  }
}

export function createTreasury(options: TreasuryOptions): Treasury {
  return new Treasury(options);
}
