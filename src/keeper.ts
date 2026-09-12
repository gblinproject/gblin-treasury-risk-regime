import { createPublicClient, http, encodeFunctionData, formatEther } from 'viem';
import { base } from 'viem/chains';

const GBLIN = '0x36C81d7E1966310F305eA637e761Cf77F90852f0' as const;
const WETH = '0x4200000000000000000000000000000000000006' as const;
const BPS = 10000n;
const MIN_FLOOR = 10000000000000000n;   // 0.01 ether — the contract's absolute minimum swap

const GBLIN_ABI = [
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'basket',
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'isStable', type: 'bool' },
      { name: 'baseWeight', type: 'uint256' },
      { name: 'dynamicWeight', type: 'uint256' },
      { name: 'peakPrice', type: 'uint256' },
      { name: 'lastPeakUpdate', type: 'uint256' },
    ],
    stateMutability: 'view', type: 'function',
  },
  { inputs: [], name: 'stabilityFund', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'WETH_ORACLE', outputs: [{ name: '', type: 'address' }], stateMutability: 'view', type: 'function' },
  // Bounty rules, all public getters on the live contract (read at call time, never hard-coded).
  { inputs: [], name: 'incentiveBps', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'minBounty', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'maxBounty', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'bountyInterval', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'lastBountyTime', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'volumeRefEth', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'lastWindowVolume', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  {
    inputs: [
      { name: 'assetIndex', type: 'uint256' },
      { name: 'isWethToAsset', type: 'bool' },
      { name: 'amountToSwap', type: 'uint256' },
    ],
    name: 'incentivizedRebalance', outputs: [], stateMutability: 'nonpayable', type: 'function',
  },
] as const;

const ERC20_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view', type: 'function' },
] as const;

const ORACLE_ABI = [
  { inputs: [], name: 'latestRoundData', outputs: [
    { name: 'roundId', type: 'uint80' },
    { name: 'answer', type: 'int256' },
    { name: 'startedAt', type: 'uint256' },
    { name: 'updatedAt', type: 'uint256' },
    { name: 'answeredInRound', type: 'uint80' },
  ], stateMutability: 'view', type: 'function' },
] as const;

function convertToEth(amount: bigint, assetPrice: bigint, wethPrice: bigint, decimals: number): bigint {
  if (wethPrice === 0n || assetPrice === 0n) return 0n;
  let val = (amount * assetPrice) / wethPrice;
  if (decimals < 18) val = val * (10n ** BigInt(18 - decimals));
  else if (decimals > 18) val = val / (10n ** BigInt(decimals - 18));
  return val;
}

function convertEthToAsset(ethAmount: bigint, assetPrice: bigint, wethPrice: bigint, decimals: number): bigint {
  if (wethPrice === 0n || assetPrice === 0n) return 0n;
  let val = (ethAmount * wethPrice) / assetPrice;
  if (decimals < 18) val = val / (10n ** BigInt(18 - decimals));
  else if (decimals > 18) val = val * (10n ** BigInt(decimals - 18));
  return val;
}

async function getOraclePrice(client: any, oracle: `0x${string}`): Promise<bigint> {
  try {
    const data: any = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'latestRoundData' });
    const answer: bigint = data[1];
    const updatedAt: bigint = data[3];
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now - updatedAt > 86400n || answer <= 0n) return 0n;
    return answer;
  } catch { return 0n; }
}

/**
 * The live contract's bounty rules (every field is a public getter). Mirrors
 * GBLIN_V6 `_bounty` / `_volumeBoost` and the payment gate in `incentivizedRebalance`:
 *   boost   = volumeRefEth == 0 ? 0 : min(lastWindowVolume, volumeRefEth) * 10000 / volumeRefEth
 *   effBps  = incentiveBps + incentiveBps * boost / 10000
 *   due     = clamp(rebalancedEth * effBps / 10000, minBounty, maxBounty)
 *   paid only if now >= lastBountyTime + bountyInterval AND due <= stabilityFund;
 *   otherwise the rebalance still executes and pays NOTHING (no revert).
 */
export interface BountyRules {
  incentiveBps: bigint;
  minBounty: bigint;
  maxBounty: bigint;
  bountyInterval: bigint;
  lastBountyTime: bigint;
  volumeRefEth: bigint;
  lastWindowVolume: bigint;
  stabilityFund: bigint;
}

export type RewardGate = 'open' | 'interval-active' | 'fund-insufficient';

export function volumeBoostBps(r: BountyRules): bigint {
  if (r.volumeRefEth === 0n) return 0n;
  if (r.lastWindowVolume >= r.volumeRefEth) return BPS;
  return (r.lastWindowVolume * BPS) / r.volumeRefEth;
}

export function effectiveBps(r: BountyRules): bigint {
  return r.incentiveBps + (r.incentiveBps * volumeBoostBps(r)) / BPS;
}

/** What the contract would pay for a rebalance of `rebalancedEth` (ETH value, wei), before the gates. */
export function bountyDue(rebalancedEth: bigint, r: BountyRules): bigint {
  let b = (rebalancedEth * effectiveBps(r)) / BPS;
  if (b < r.minBounty) b = r.minBounty;
  if (b > r.maxBounty) b = r.maxBounty;
  return b;
}

/** Whether `due` would actually be paid at time `now` (unix seconds). */
export function rewardGate(now: bigint, due: bigint, r: BountyRules): RewardGate {
  if (now < r.lastBountyTime + r.bountyInterval) return 'interval-active';
  if (due === 0n || due > r.stabilityFund) return 'fund-insufficient';
  return 'open';
}

export interface KeeperBounty {
  bountyAvailable: boolean;
  reason?: string;
  /** A rebalance passes the contract's checks (drift and minimum swap) — regardless of the reward. */
  swapExecutable?: boolean;
  /** Whether the reward would be paid right now: the contract pays at most once per bountyInterval and only from the stability fund. */
  rewardGate?: RewardGate;
  /** Unix seconds when the interval gate reopens (only when rewardGate = 'interval-active'). */
  nextRewardAt?: number;
  effectiveBps?: string;
  minBountyEth?: string;
  maxBountyEth?: string;
  assetIndex?: number;
  token?: string;
  direction?: 'WETH->asset' | 'asset->WETH';
  amountToSwap?: string;
  estimatedRewardEth?: string;
  target?: string;
  calldata?: string;
  value?: string;
  stabilityFundEth?: string;
  note?: string;
}

export async function findKeeperBounty(rpcUrl?: string): Promise<KeeperBounty> {
  const client = createPublicClient({
    chain: base,
    transport: http(rpcUrl || process.env.GBLIN_RPC_URL || 'https://base-rpc.publicnode.com'),
  });

  const wethOracle = await client.readContract({ address: GBLIN, abi: GBLIN_ABI, functionName: 'WETH_ORACLE' }) as `0x${string}`;
  const wethPrice = await getOraclePrice(client, wethOracle);
  if (wethPrice === 0n) return { bountyAvailable: false, reason: 'WETH oracle stale or dead' };

  const read = (functionName: 'stabilityFund' | 'incentiveBps' | 'minBounty' | 'maxBounty' | 'bountyInterval' | 'lastBountyTime' | 'volumeRefEth' | 'lastWindowVolume') =>
    client.readContract({ address: GBLIN, abi: GBLIN_ABI, functionName }) as Promise<bigint>;
  const [stabilityFund, incentiveBps, minBounty, maxBounty, bountyInterval, lastBountyTime, volumeRefEth, lastWindowVolume] = await Promise.all([
    read('stabilityFund'), read('incentiveBps'), read('minBounty'), read('maxBounty'), read('bountyInterval'), read('lastBountyTime'), read('volumeRefEth'), read('lastWindowVolume'),
  ]);
  const rules: BountyRules = { incentiveBps, minBounty, maxBounty, bountyInterval, lastBountyTime, volumeRefEth, lastWindowVolume, stabilityFund };
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ruleFields = {
    effectiveBps: effectiveBps(rules).toString(),
    minBountyEth: formatEther(minBounty),
    maxBountyEth: formatEther(maxBounty),
    stabilityFundEth: formatEther(stabilityFund),
  };
  if (stabilityFund < minBounty) {
    return {
      bountyAvailable: false,
      rewardGate: 'fund-insufficient',
      reason: `Stability fund (${formatEther(stabilityFund)} ETH) is below the contract's minimum bounty (${formatEther(minBounty)} ETH): a rebalance would execute but pay nothing.`,
      ...ruleFields,
    };
  }

  // Read basket entries until revert
  const assets: any[] = [];
  for (let i = 0; i < 16; i++) {
    try {
      const a: any = await client.readContract({ address: GBLIN, abi: GBLIN_ABI, functionName: 'basket', args: [BigInt(i)] });
      assets.push({ index: i, token: a[0] as `0x${string}`, oracle: a[1] as `0x${string}`, dynamicWeight: a[5] as bigint });
    } catch { break; }
  }
  if (assets.length === 0) return { bountyAvailable: false, reason: 'Empty basket' };

  const wethBalance = await client.readContract({ address: WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [GBLIN] }) as bigint;
  const availableWeth = wethBalance > stabilityFund ? wethBalance - stabilityFund : 0n;
  let totalEthValue = availableWeth;

  const assetData: any[] = [];
  for (const asset of assets) {
    if (asset.token.toLowerCase() === WETH.toLowerCase()) continue;
    if (asset.dynamicWeight === 0n) continue;
    const price = await getOraclePrice(client, asset.oracle);
    if (price === 0n) continue;
    const balance = await client.readContract({ address: asset.token, abi: ERC20_ABI, functionName: 'balanceOf', args: [GBLIN] }) as bigint;
    const decimals = await client.readContract({ address: asset.token, abi: ERC20_ABI, functionName: 'decimals' }) as number;
    const ethValue = convertToEth(balance, price, wethPrice, Number(decimals));
    totalEthValue += ethValue;
    assetData.push({ ...asset, price, decimals: Number(decimals), currentEthValue: ethValue });
  }

  if (totalEthValue === 0n) return { bountyAvailable: false, reason: 'No treasury value to rebalance' };

  let minSwapRequired = wethBalance / 100n;
  if (minSwapRequired < MIN_FLOOR) minSwapRequired = MIN_FLOOR;

  for (const a of assetData) {
    const targetEthValue = (totalEthValue * a.dynamicWeight) / BPS;
    const current = a.currentEthValue as bigint;

    let isWethToAsset: boolean;
    let amountEth: bigint;

    if (current < targetEthValue) {
      isWethToAsset = true;
      amountEth = targetEthValue - current;
      if (amountEth > availableWeth) amountEth = availableWeth;
    } else if (current > targetEthValue) {
      isWethToAsset = false;
      amountEth = current - targetEthValue;
    } else {
      continue;
    }

    if (amountEth < minSwapRequired) continue;

    let amountToSwap: bigint;
    if (isWethToAsset) {
      amountToSwap = amountEth;
    } else {
      amountToSwap = convertEthToAsset(amountEth, a.price, wethPrice, a.decimals);
    }
    if (amountToSwap === 0n) continue;

    // The contract pays on the ETH value it actually rebalances (amountToSwap for WETH->asset,
    // the asset's ETH value for asset->WETH); amountEth is that value before swap rounding.
    const due = bountyDue(amountEth, rules);
    const gate = rewardGate(now, due, rules);
    const common = {
      swapExecutable: true,
      rewardGate: gate,
      assetIndex: a.index,
      token: a.token,
      direction: (isWethToAsset ? 'WETH->asset' : 'asset->WETH') as 'WETH->asset' | 'asset->WETH',
      amountToSwap: amountToSwap.toString(),
      target: GBLIN,
      ...ruleFields,
    };

    if (gate !== 'open') {
      const nextRewardAt = gate === 'interval-active' ? Number(lastBountyTime + bountyInterval) : undefined;
      return {
        bountyAvailable: false,
        ...common,
        estimatedRewardEth: '0',
        ...(nextRewardAt !== undefined ? { nextRewardAt } : {}),
        reason: gate === 'interval-active'
          ? `A rebalance is executable but the contract pays at most once per ${bountyInterval.toString()}s and the last bounty was paid at ${lastBountyTime.toString()}: sending it now would pay 0 ETH. Check again after ${nextRewardAt}.`
          : `A rebalance is executable but its bounty (${formatEther(due)} ETH) exceeds the stability fund (${formatEther(stabilityFund)} ETH): sending it now would pay 0 ETH.`,
      };
    }

    const calldata = encodeFunctionData({
      abi: GBLIN_ABI, functionName: 'incentivizedRebalance',
      args: [BigInt(a.index), isWethToAsset, amountToSwap],
    });

    return {
      bountyAvailable: true,
      ...common,
      estimatedRewardEth: formatEther(due),
      calldata,
      value: '0',
      note: 'Send this calldata to the target contract to execute the rebalance and earn the reward. The swap uses the contract\'s own funds; the caller only pays gas (~$0.01 on Base). The reward is an estimate from the contract\'s live rules; the contract pays on the ETH value it actually rebalances.',
    };
  }

  return { bountyAvailable: false, swapExecutable: false, reason: 'Pool is balanced, or the drift is below the contract\'s minimum swap (1% of its WETH, at least 0.01 ETH). No profitable rebalance available right now. Check again later.', ...ruleFields };
}
