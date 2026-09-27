/**
 * Prices and quotes, read from the chain the way the vault reads them: the ETH/USD Chainlink feed
 * within the vault's own staleness window, the NAV from the Lens, the shield state from the basket
 * rows. Nothing here is cached across calls beyond a few seconds: a treasury decides on live numbers.
 */

import { formatUnits, parseUnits, type Address, type PublicClient } from "viem";

import { CHAINLINK_ABI, ERC20_ABI, LENS_ABI, VAULT_ABI } from "./abi.js";
import {
  BPS,
  COOLDOWN_SECONDS_FALLBACK,
  ETH_USD_FEED,
  GBLIN_LENS,
  GBLIN_VAULT,
  ORACLE_STALENESS_SECONDS,
  REGIME_URL,
  SLIPPAGE_NORMAL_BPS,
  SLIPPAGE_SHIELD_BPS,
  USDC,
} from "./config.js";

export type Regime = "calm" | "elevated" | "crash" | "unknown";

export interface Prices {
  ethUsd: number;
  /** USD value of one GBLIN share, from the Lens exit quote. */
  navUsd: number;
  /** ETH the vault pays for one share. */
  navEth: number;
}

export async function readPrices(client: PublicClient): Promise<Prices> {
  const [round, cfg, navWei] = await Promise.all([
    client.readContract({ address: ETH_USD_FEED, abi: CHAINLINK_ABI, functionName: "latestRoundData" }),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "configFees", args: [GBLIN_VAULT] }).catch(() => null),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "quoteSell", args: [GBLIN_VAULT, parseUnits("1", 18)] }),
  ]);
  const answer = round[1];
  if (answer <= 0n) throw new Error("The Chainlink ETH/USD feed returned a non-positive price.");
  const maxAge = cfg && Number(cfg[3]) > 0 ? Number(cfg[3]) : ORACLE_STALENESS_SECONDS;
  const age = Math.floor(Date.now() / 1000) - Number(round[3]);
  if (age > maxAge) throw new Error(`The ETH/USD feed is ${age}s old; the vault accepts at most ${maxAge}s. Wait for the next update.`);
  const ethUsd = Number(answer) / 1e8;
  const navEth = Number(formatUnits(navWei, 18));
  return { ethUsd, navEth, navUsd: navEth * ethUsd };
}

/** True while any basket row is shielded: quotes then carry the wider slippage buffer. */
export async function shieldActive(client: PublicClient): Promise<boolean> {
  const n = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "basketLength", args: [GBLIN_VAULT] });
  for (let i = 0n; i < n; i++) {
    const row = await client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "asset", args: [GBLIN_VAULT, i] });
    if (row[6]) return true;
  }
  return false;
}

export async function slippageBps(client: PublicClient): Promise<bigint> {
  return (await shieldActive(client).catch(() => false)) ? SLIPPAGE_SHIELD_BPS : SLIPPAGE_NORMAL_BPS;
}

export function withBuffer(expected: bigint, bps: bigint): bigint {
  return (expected * (BPS - bps)) / BPS;
}

export interface Cooldown {
  active: boolean;
  secondsRemaining: number;
}

/** The redemption cooldown after the wallet's own mint, measured on block time, never on the local clock. */
export async function readCooldown(client: PublicClient, wallet: Address): Promise<Cooldown> {
  const [last, block, cfg] = await Promise.all([
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "lastDepositTime", args: [GBLIN_VAULT, wallet] }),
    client.getBlock(),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "configFees", args: [GBLIN_VAULT] }).catch(() => null),
  ]);
  const seconds = cfg ? Number(cfg[5]) : COOLDOWN_SECONDS_FALLBACK;
  const unlockAt = Number(last) + seconds;
  const now = Number(block.timestamp);
  return now < unlockAt ? { active: true, secondsRemaining: unlockAt - now } : { active: false, secondsRemaining: 0 };
}

export interface Balances {
  usdc: bigint;
  gblin: bigint;
  eth: bigint;
}

/** Balances of the wallet; pass `blockNumber` to pin the read to a block (see `readAtBlock`). */
export async function readBalances(client: PublicClient, wallet: Address, blockNumber?: bigint): Promise<Balances> {
  const at = blockNumber === undefined ? {} : { blockNumber };
  const [usdc, gblin, eth] = await Promise.all([
    client.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet], ...at }),
    client.readContract({ address: GBLIN_VAULT, abi: VAULT_ABI, functionName: "balanceOf", args: [wallet], ...at }),
    client.getBalance({ address: wallet, ...at }),
  ]);
  return { usdc, gblin, eth };
}

/**
 * Market-risk regime from the free endpoint of the hosted MCP server. "unknown" when it cannot be
 * read: the caller decides what to do without it (this library skips parking, never exits).
 */
export async function readRegime(timeoutMs = 6_000): Promise<{ regime: Regime; source: string }> {
  const first = await readRegimeOnce(timeoutMs);
  if (first.regime !== "unknown") return first;
  // One more try: a transient network failure must not look like a market condition.
  await new Promise((res) => setTimeout(res, 800));
  return readRegimeOnce(timeoutMs);
}

async function readRegimeOnce(timeoutMs: number): Promise<{ regime: Regime; source: string }> {
  try {
    const res = await fetch(REGIME_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return { regime: "unknown", source: `${REGIME_URL} answered ${res.status}` };
    const body = (await res.json()) as { regime?: string };
    const r = body.regime;
    if (r === "calm" || r === "elevated" || r === "crash") return { regime: r, source: REGIME_URL };
    return { regime: "unknown", source: `${REGIME_URL} answered without a regime` };
  } catch (err) {
    return { regime: "unknown", source: `${REGIME_URL} unreachable: ${(err as Error).message}` };
  }
}
