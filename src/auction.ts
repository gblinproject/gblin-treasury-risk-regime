/**
 * GBLIN MCP — Auction state
 *
 * The vault does not rebalance itself and pays nobody to do it. When a basket row drifts past the
 * opening band it holds a Dutch auction: whoever trades with the vault toward its target weights is
 * the counterparty, at the oracle price adjusted by a premium that rises over time. The input is
 * reduced to what closes the gap, so a bid never pushes a row past its target. Nothing is paid out of
 * the vault for calling it: the premium is the whole reward.
 *
 * Everything here is read-only. The calldata returned is plain ABI-encoded bytes for the bidder to
 * review and broadcast from its own wallet.
 */

import { encodeFunctionData, formatEther, formatUnits } from "viem";
import type { Address } from "viem";

import { CHAINLINK_AGGREGATOR_ABI, ERC20_ABI, GBLIN_ABI, LENS_ABI } from "./abi.js";
import { client, getOnChainTimestamp } from "./client.js";
import { GBLIN_LENS, GBLIN_VAULT, ORACLE_STALENESS_SECONDS, WETH } from "./config.js";

// ─── Pure math ────────────────────────────────────────────────────────────────

export interface AuctionCurve {
  /** Discount at the opening, in bps of the oracle price (the vault asks this much less). */
  startBps: bigint;
  /** Premium the curve rises to, in bps of the oracle price. */
  capBps: bigint;
  /** Seconds from the opening discount to the cap. The cap then holds for another ramp before the curve starts again. */
  rampSeconds: bigint;
}

/**
 * Premium over the oracle price, in bps, `elapsedSeconds` after the auction opened. Mirrors the
 * vault's `auctionPremiumBps`: `-start` at the opening, rising linearly to `cap` over one ramp,
 * holding at `cap` for a second ramp, then starting again from `-start`.
 */
export function premiumBpsAt(elapsedSeconds: bigint, curve: AuctionCurve): bigint {
  const start = -curve.startBps;
  if (curve.rampSeconds === 0n) return start;
  let t = elapsedSeconds % (2n * curve.rampSeconds);
  if (t > curve.rampSeconds) t = curve.rampSeconds;
  return start + ((curve.capBps - start) * t) / curve.rampSeconds;
}

/** Converts an amount of ETH value into units of an asset at the two oracle prices. */
export function ethToAssetUnits(ethWei: bigint, assetPrice: bigint, wethPrice: bigint, decimals: number): bigint {
  if (assetPrice === 0n || wethPrice === 0n) return 0n;
  let units = (ethWei * wethPrice) / assetPrice;
  if (decimals < 18) units = units / 10n ** BigInt(18 - decimals);
  else if (decimals > 18) units = units * 10n ** BigInt(decimals - 18);
  return units;
}

// ─── Live state ───────────────────────────────────────────────────────────────

export interface AuctionRow {
  index: number;
  token: Address;
  symbol: string;
  baseWeightPct: number;
  dynamicWeightPct: number;
  shielded: boolean;
  /** True when the vault buys this asset and pays WETH: the bidder hands over the asset. */
  vaultBuysAsset: boolean;
  gapEth: string;
  /** Token the bidder hands to the vault, and the amount that closes the gap, in that token's units. */
  inputToken: Address;
  inputSymbol: string;
  inputAmount: string;
  inputAmountRaw: string;
  /** Unsigned calldata: an approval of the input token to the vault, then the bid. `minOut` is zero because
   *  the price is the oracle's adjusted by the premium, fixed for the block: there is no pool to be sandwiched on. */
  calldata: { approve: { target: Address; data: `0x${string}` }; bid: { target: Address; data: `0x${string}` } } | null;
}

export interface AuctionState {
  vault: Address;
  lens: Address;
  navReliable: boolean;
  auctionOpen: boolean;
  premiumBps: number;
  curve: { startBps: number; capBps: number; rampSeconds: number; opensAboveBps: number; closesAtOrBelowBps: number };
  openedAt: number | null;
  worstGapEth: string;
  totalValueEth: string;
  rows: AuctionRow[];
  /** The row with the largest gap, when the auction is open and the vault can price itself. */
  best: AuctionRow | null;
  howToBid: string;
  note: string;
}

async function oraclePrice(oracle: Address, now: number): Promise<bigint> {
  try {
    const d = await client.readContract({ address: oracle, abi: CHAINLINK_AGGREGATOR_ABI, functionName: "latestRoundData" });
    const answer = d[1];
    const updatedAt = Number(d[3]);
    if (answer <= 0n || now - updatedAt > ORACLE_STALENESS_SECONDS) return 0n;
    return answer;
  } catch {
    return 0n;
  }
}

export async function getAuctionState(): Promise<AuctionState> {
  const [navReliable, premiumRaw, driftRaw, totalValue, rowCountRaw, openedAtRaw, cfg, wethOracle, blockTs] = await Promise.all([
    client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "isNavReliable" }),
    client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "auctionPremiumBps" }),
    client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "currentDriftEth" }),
    client.readContract({ address: GBLIN_VAULT, abi: GBLIN_ABI, functionName: "totalEthValue", args: [0n] }),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "basketLength", args: [GBLIN_VAULT] }),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "auctionOpenedAt", args: [GBLIN_VAULT] }),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "configAuction", args: [GBLIN_VAULT] }),
    client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "wethOracle", args: [GBLIN_VAULT] }),
    getOnChainTimestamp(),
  ]);

  const now = Number(blockTs);
  const wethPrice = await oraclePrice(wethOracle, now);
  const auctionOpen = openedAtRaw !== 0n;

  const rows: AuctionRow[] = [];
  for (let i = 0; i < Number(rowCountRaw); i++) {
    const [row, state] = await Promise.all([
      client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "asset", args: [GBLIN_VAULT, BigInt(i)] }),
      client.readContract({ address: GBLIN_LENS, abi: LENS_ABI, functionName: "auction", args: [GBLIN_VAULT, BigInt(i)] }),
    ]);
    const token = row[0];
    if (row[7]) continue; // abandoned rows cannot be bid on
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => `row ${i}`),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    ]);
    const vaultBuysAsset = state[2];
    const gapEth = state[3];
    const isWeth = token.toLowerCase() === WETH.toLowerCase();

    // The bidder is the counterparty: when the vault buys the asset the bidder hands it over and receives
    // WETH; when the vault sells it the bidder hands over WETH. Sizing at the gap is enough — the vault
    // trims any excess to what closes it.
    let inputToken: Address = WETH;
    let inputSymbol = "WETH";
    let inputAmountRaw = gapEth;
    let inputDecimals = 18;
    if (vaultBuysAsset && !isWeth) {
      const assetPrice = await oraclePrice(row[1], now);
      inputToken = token;
      inputSymbol = String(symbol);
      inputDecimals = Number(decimals);
      inputAmountRaw = ethToAssetUnits(gapEth, assetPrice, wethPrice, inputDecimals);
    }

    const biddable = auctionOpen && navReliable && !isWeth && gapEth > 0n && inputAmountRaw > 0n;
    const calldata = biddable
      ? {
          approve: {
            target: inputToken,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [GBLIN_VAULT, inputAmountRaw] }),
          },
          bid: {
            target: GBLIN_VAULT,
            data: encodeFunctionData({
              abi: GBLIN_ABI,
              functionName: "bid",
              args: [BigInt(i), vaultBuysAsset, inputAmountRaw, 0n, "0x"],
            }),
          },
        }
      : null;

    rows.push({
      index: i,
      token,
      symbol: String(symbol),
      baseWeightPct: Number(row[4]) / 100,
      dynamicWeightPct: Number(row[5]) / 100,
      shielded: row[6],
      vaultBuysAsset,
      gapEth: formatEther(gapEth),
      inputToken,
      inputSymbol,
      inputAmount: formatUnits(inputAmountRaw, inputDecimals),
      inputAmountRaw: inputAmountRaw.toString(),
      calldata,
    });
  }

  const best = rows
    .filter((r) => r.calldata !== null)
    .sort((a, b) => Number(b.gapEth) - Number(a.gapEth))[0] ?? null;

  return {
    vault: GBLIN_VAULT,
    lens: GBLIN_LENS,
    navReliable,
    auctionOpen,
    premiumBps: Number(premiumRaw),
    curve: {
      startBps: Number(cfg[2]),
      capBps: Number(cfg[3]),
      rampSeconds: Number(cfg[4]),
      opensAboveBps: Number(cfg[0]),
      closesAtOrBelowBps: Number(cfg[1]),
    },
    openedAt: auctionOpen ? Number(openedAtRaw) : null,
    worstGapEth: formatEther(driftRaw),
    totalValueEth: formatEther(totalValue),
    rows,
    best,
    howToBid:
      "Approve the input token to the vault, then call bid(index, vaultBuysAsset, amountIn, minOut, data) from your own wallet. " +
      "You hand over the input token and receive the other side at the oracle price adjusted by the current premium. " +
      "The input is reduced to what closes the gap; a bid that would change nothing reverts.",
    note:
      "Nothing is paid out of the vault for bidding: the premium is the reward. The premium starts at a discount, rises to the cap " +
      "over one ramp, holds for another and starts again; bid when it covers your own cost.",
  };
}
