import { createPublicClient, http, formatUnits } from 'viem';
import { base } from 'viem/chains';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const GBLIN = '0xc2181d975c05c8c724b334bcED0764c0b86B1D53' as const;

const ERC20_ABI = [{
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view' as const, type: 'function' as const,
}] as const;

const client = createPublicClient({
  chain: base,
  transport: http(process.env.GBLIN_RPC_URL || 'https://mainnet.base.org'),
});

export interface BotStats {
  usdc: number;
  gblin: number;
  gblinValueUsdc: number;
  totalUsdc: number;
  walletAddress: string;
  basescanUrl: string;
}

export async function getBotStats(wallet: `0x${string}`): Promise<BotStats> {
  const [usdcRaw, gblinRaw] = await Promise.all([
    client.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
    client.readContract({ address: GBLIN, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
  ]);

  const usdc = parseFloat(formatUnits(usdcRaw, 6));
  const gblin = parseFloat(formatUnits(gblinRaw, 18));

  let nav = 2000;
  try {
    const response = await fetch('https://gblin.digital/api/x402/llms.txt');
    const text = await response.text();
    const match = text.match(/NAV[:\s]+\$?([\d.]+)/i);
    if (match) nav = parseFloat(match[1]);
  } catch {}

  const gblinValueUsdc = gblin * nav;
  const totalUsdc = usdc + gblinValueUsdc;

  return {
    usdc, gblin, gblinValueUsdc, totalUsdc,
    walletAddress: wallet,
    basescanUrl: `https://basescan.org/address/${wallet}`,
  };
}
