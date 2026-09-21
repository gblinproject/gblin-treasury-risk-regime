---
name: jit-redemption-pattern
description: Use when an AI agent holds GBLIN and needs to convert a specific USDC amount for an outgoing payment. Covers the JIT (Just-In-Time) redemption pattern through the GBLIN Zap, cooldown timing, and how to use it inside x402 payment flows.
---

# JIT Redemption Pattern (GBLIN → USDC)

## When this skill applies

Trigger when:
- The agent's treasury is in GBLIN and needs to pay an outgoing x402 invoice in USDC
- The user wants a deterministic, scripted GBLIN → USDC conversion (three transactions, batchable)
- The agent is building "lazy treasury" patterns (only convert when needed)

## What JIT redemption does

The GBLIN protocol's `swap_gblin_to_usdc_jit` endpoint returns calldata for two transactions that:

1. Burns the right amount of GBLIN
2. Withdraws the user's proportional share of WETH, cbBTC, USDC from the treasury
3. Swaps WETH and cbBTC to USDC via Uniswap V3 (with MEV-safe min outs)
4. Transfers the resulting USDC to the user

Two deterministic steps (redeem, then swap), each with its own oracle-anchored minOut. Compatible with EOA, ERC-4337 Smart Accounts, and EIP-7702 (smart accounts can batch both steps in one UserOp).

## Endpoint

```
GET https://gblin.digital/api/x402/jit?wallet=<address>&usdc=<amount>
```

Response (after x402 payment of $0.005 USDC):

```json
{
  "action": "sequential_txs",
  "steps": [
    { "step": 1, "target": "0xc2181d975c05c8c724b334bcED0764c0b86B1D53", "calldata": "0x...", "value": "0", "description": "Approve the shares to the GBLIN Zap" },
    { "step": 2, "target": "0x0E9D6Ceb6D313b021622C121Cda9C62e86e60200", "calldata": "0x...", "value": "0", "description": "Redeem in kind and sell every leg for ETH through the Zap (all or nothing)" },
    { "step": 3, "target": "0x2626664c2603336E57B271c5C0b26F421741e481", "calldata": "0x...", "value": "...", "description": "Swap the received ETH to USDC via Uniswap V3 (WETH->USDC)" }
  ],
  "compatibility": { "eoa": true, "erc4337": true, "eip7702": true }
}
```

## When to use JIT redemption

**Use when**:
- You need exactly X USDC and have at least X-equivalent in GBLIN
- The payment is happening now (within the next minute)
- You want a deterministic scripted redemption (3 txs, or 1 batched UserOp on smart accounts)

**Do not use when**:
- You're inside the vault's cooldown after your own recent mint (20 seconds at launch; will revert)
- You need amounts smaller than ~$0.10 (gas + slippage eats too much)
- The market is highly volatile (Crash Shield active) — slippage may be wide

## Code pattern: pay x402 invoice with GBLIN

```typescript
import { createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const GBLIN_JIT = 'https://gblin.digital/api/x402/jit';

async function payInvoiceWithGblin(params: {
  privateKey: `0x${string}`;
  walletAddress: `0x${string}`;
  invoiceAmountUsdc: number;
  recipient: `0x${string}`;
}) {
  const url = `${GBLIN_JIT}?wallet=${params.walletAddress}&usdc=${params.invoiceAmountUsdc}`;
  const response = await fetch(url);
  if (response.status === 402) {
    throw new Error('JIT endpoint requires x402 payment of $0.005 USDC');
  }
  const jit = await response.json();

  const account = privateKeyToAccount(params.privateKey);
  const client = createWalletClient({ account, chain: base, transport: http() });

  const hash = await client.sendTransaction({
    to: jit.target_contract as `0x${string}`,
    data: jit.calldata as `0x${string}`,
    value: BigInt(jit.value || 0),
  });

  return { redemptionTx: hash };
}
```

## Handling the cooldown

GBLIN enforces a 2-minute cooldown between deposit and redemption to prevent flash-loan exploits. Plan around this:

```typescript
async function safeRedeem(walletAddress: string, amount: number) {
  const health = await fetch(`https://gblin.digital/api/x402/health?wallet=${walletAddress}`);
  const status = await health.json();

  if (status.cooldownActive) {
    const waitMs = (status.cooldownRemainingSeconds || 120) * 1000;
    return { needsWait: true, waitMs, retryAt: Date.now() + waitMs };
  }
  return { needsWait: false };
}
```

For agents with predictable revenue cycles, time your invests so that cooldown windows align with quiet hours.

## Slippage protection

JIT redemption swaps WETH and cbBTC to USDC at market price. The protocol embeds a `maxInternalSlippage` parameter (default 2% buffer) into the calldata. During extreme volatility, this may not be enough.

If you need tighter slippage:
1. Check Crash Shield status first — if active, postpone non-urgent redemptions
2. Use smaller redemption amounts to reduce price impact
3. Spread redemptions across multiple transactions if amount > $1000

## Alternative: pre-emptive redemption

For agents with known upcoming outflows, redeem ahead of time and hold USDC operational reserve:

```typescript
const expectedWeeklyOutflows = 50; // USDC
const operationalReserve = expectedWeeklyOutflows * 1.5;

if (usdcBalance < operationalReserve && gblinValueUsdc > operationalReserve) {
  await jitRedeem(walletAddress, operationalReserve - usdcBalance);
}
```

This trades NAV growth opportunity for execution certainty. Choose based on your agent's risk tolerance.

## References

- GBLIN smart contract source: https://github.com/gblinproject/GBLIN-Protocol
- Treasury patterns: `skills/base-agent-treasury`
- Self-funding loop: `skills/agent-self-funding`
