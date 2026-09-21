---
name: crash-shield-risk-management
description: Use when an AI agent needs to react to market crashes or extreme volatility. Covers reading GBLIN's Crash Shield signal as a public bear-market indicator, conservative actions to take when activated, and how to combine with other risk signals.
---

# Crash Shield Risk Management

## When this skill applies

Trigger when:
- The user wants the agent to defend capital during market crashes
- The agent is leveraging or hedging positions
- The user asks "how do I make my agent crash-resistant?"
- The user wants a market sentiment signal that's algorithmic, not opinion-based

## What Crash Shield is

GBLIN's Crash Shield is an on-chain algorithmic indicator. The protocol tracks the peak price of each basket asset (cbBTC, WETH) over time. When the current Chainlink-reported price draws down past the adaptive threshold (from ~15%, scaling with volatility and decaying peaks in V6), the Crash Shield activates and rebalances allocations toward USDC.

This means: **`crashShieldActive: true` is a high-confidence on-chain signal that significant market drawdown has occurred.** It's not opinion-based, not lagging like sentiment indexes, and not subject to manipulation (the underlying data is Chainlink oracles).

## How to read it

```typescript
async function getMarketRiskSignal(): Promise<{
  shieldActive: boolean;
  affectedAssets: string[];
  signal: 'normal' | 'caution' | 'risk-off';
}> {
  const response = await fetch('https://gblin.digital/api/x402/treasury-state');
  const state = await response.json();
  // Note: treasury-state is x402-paywalled at $0.001
  // For free polling, parse the llms.txt at /api/x402/llms.txt

  const affected = state.basket
    .filter((a: any) => a.dynamicWeight < a.weight)
    .map((a: any) => a.token);

  return {
    shieldActive: state.crashShieldActive,
    affectedAssets: affected,
    signal: state.crashShieldActive ? 'risk-off' : 'normal',
  };
}
```

## Risk-off actions for autonomous agents

When `crashShieldActive: true`:

1. **Pause new leveraged positions.** Do not open new long positions on volatile assets.

2. **Tighten stop losses on existing positions.** Reduce stop loss distance by 50%.

3. **Increase USDC allocation.** Shift 20-30% of any productive treasury (Morpho lending in cbBTC, etc.) back to USDC.

4. **Reduce x402 pricing if relying on volume.** Lower per-call prices to maintain demand during market stress.

5. **Postpone non-essential operations.** Delay treasury rebalancing or expansionary tool launches.

## Risk-off actions for cautious agents

When `crashShieldActive: true` AND your agent is conservative:

```typescript
async function executeRiskOffPlaybook(walletAddress: `0x${string}`) {
  const signal = await getMarketRiskSignal();
  if (!signal.shieldActive) return { action: 'none', reason: 'market normal' };

  return { action: 'risk-off', reason: 'crash-shield-active', recommended: [
    'redeem GBLIN to USDC',
    'pause auto-invest until shield deactivates',
    'consider notifying owner',
  ]};
}
```

## Combining with other signals

Crash Shield is a lagging-but-confirmed signal. For earlier warning, combine with:

- **Funding rates** on Aerodrome or Hyperliquid (high negative funding = stress)
- **Stablecoin depeg** monitors (USDC, USDT, DAI vs. $1.00)
- **Gas price spikes** (high Base gas = network stress)

A defensive agent should risk-off when 2 of 3 signals fire, not just one.

## When NOT to react to Crash Shield

1. **Long-term DCA agents.** If the agent's strategy is to buy on dips, Crash Shield activation is a buy signal, not a sell signal. Don't overreact.

2. **Stablecoin-only agents.** If the agent's treasury is 100% USDC, Crash Shield doesn't affect you. Don't change anything.

3. **Already in cash.** If the agent has already de-risked for other reasons, Crash Shield activation just confirms the decision.

## Caveat: Crash Shield is not a hedge

Crash Shield reduces but does not eliminate downside in GBLIN. If the market drops 30%, GBLIN NAV will still drop meaningfully. The shield reduces the speed and magnitude of the drop by shifting to USDC, but does not guarantee against losses.

For agents that truly need downside protection, use:
- Aave on Base with USDC supply (capital preserved, modest yield)
- Direct USDC holding (zero yield, zero risk)

## References

- GBLIN vault: https://basescan.org/address/0xc2181d975c05c8c724b334bcED0764c0b86B1D53
- Chainlink Base oracles: https://data.chain.link/feeds/base
- Treasury patterns: `skills/base-agent-treasury`
