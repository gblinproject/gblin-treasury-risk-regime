---
name: agent-self-funding
description: Use when the user wants to build a self-sustaining AI agent that earns revenue via x402 micropayments and reinvests it autonomously. Covers the loop architecture, capital preservation between earnings, and minimum economic viability calculations.
---

# Self-Funding AI Agent Architecture

## When this skill applies

Trigger when the user describes:
- "Build an agent that pays for its own hosting"
- "Self-sustaining AI agent"
- "Agent that earns and reinvests"
- "Make my bot economically viable"
- "Autonomous economic loop"

## The core loop

A self-funding agent has three phases that cycle continuously:

```
EARN (x402 endpoint) → PRESERVE (treasury) → SPEND (operational costs)
       ↑                                              ↓
       └──────────── repeat ─────────────────────────┘
```

If `EARN > SPEND` over a rolling window, the agent grows. If `SPEND > EARN`, it dies (treasury depletes to zero).

## Minimum economic viability

Before writing code, calculate whether the agent can be viable:

```typescript
function isViable(params: {
  pricePerCall: number;
  expectedCallsPerDay: number;
  hostingCostPerDay: number;
  llmCostPerCall?: number;
  txFeesPerDay?: number;
}): { viable: boolean; marginPerDay: number; daysToBreakeven: number } {
  const dailyRevenue = params.pricePerCall * params.expectedCallsPerDay;
  const dailyVariableCost = (params.llmCostPerCall || 0) * params.expectedCallsPerDay;
  const dailyFixedCost = params.hostingCostPerDay + (params.txFeesPerDay || 0);
  const marginPerDay = dailyRevenue - dailyVariableCost - dailyFixedCost;
  return {
    viable: marginPerDay > 0,
    marginPerDay,
    daysToBreakeven: marginPerDay > 0 ? params.hostingCostPerDay / marginPerDay : Infinity,
  };
}
```

Example viability check:

```typescript
const check = isViable({
  pricePerCall: 0.01,
  expectedCallsPerDay: 50,
  hostingCostPerDay: 0,      // Vercel free tier
  llmCostPerCall: 0.002,
  txFeesPerDay: 0.05,
});
// → { viable: true, marginPerDay: 0.35, daysToBreakeven: 0 }
```

If `marginPerDay < $0.10`, the agent is too marginal to survive temporary outages or LLM price changes. Aim for `marginPerDay > $0.50` minimum.

## Architecture

```
self-funding-agent/
├── src/pages/api/
│   ├── service.ts            # x402-paywalled endpoint (REVENUE)
│   ├── cron.ts               # Treasury management (PRESERVE)
│   └── stats.ts              # Public dashboard data
├── src/lib/
│   ├── x402-paywall.ts       # Payment middleware
│   ├── treasury.ts           # Auto-invest / auto-redeem logic
│   └── service-logic.ts      # The actual value-add of the agent
└── vercel.json               # Cron schedule
```

## Treasury logic for self-funding loop

For an agent that earns small frequent payments:

```typescript
const TREASURY_FLOOR_USDC = 1.00;
const AUTO_INVEST_TRIGGER = 5.00;
const AUTO_REDEEM_TRIGGER = 0.50;

export async function rebalance(walletAddress: `0x${string}`, usdcBalance: number, gblinValueUsdc: number) {
  if (usdcBalance > AUTO_INVEST_TRIGGER) {
    const excess = usdcBalance - TREASURY_FLOOR_USDC;
    return { action: 'invest', amount: excess };
  }

  if (usdcBalance < AUTO_REDEEM_TRIGGER && gblinValueUsdc > 1.0) {
    return { action: 'redeem', amount: 1.0 };
  }

  return { action: 'idle', amount: 0 };
}
```

## Resilience patterns

1. **Health check before every operation**: Read on-chain balance, don't trust local state.

2. **Idempotent operations**: Use unique nonces so a retried operation does not double-invest.

3. **Emergency stop**: Expose a `/api/stop` endpoint guarded by a secret that pauses cron-triggered treasury operations if something goes wrong.

4. **Liveness pings**: Have the agent log "I'm alive" to a public endpoint every hour. If the public endpoint stops getting pings, you know to investigate.

5. **Graceful degradation**: If the GBLIN API is down, do not block the revenue endpoint. The agent should still earn even if it cannot rebalance.

## Common mistakes to avoid

1. **Pricing too low**: $0.001 per call seems agent-friendly but rarely covers gas + LLM costs. Start at $0.01-$0.05.

2. **No cooldown logic**: GBLIN has a short redemption cooldown after a mint for oneself (20 seconds, read live). A sale right after a mint reverts. Hold a USDC operational buffer.

3. **Hardcoding the treasury floor**: As the agent grows, the floor should grow too. Make it a function of recent outflow patterns.

4. **Ignoring x402 facilitator costs**: Some facilitators take a percentage fee. Factor this into pricing.

## References

- GBLIN treasury patterns: `skills/base-agent-treasury`
- x402 paywall: `skills/x402-paywall-pattern`
- JIT redemption: `skills/jit-redemption-pattern`
- Crash Shield handling: `skills/crash-shield-risk-management`
- Example implementation: `examples/mcp-paywall-template`
