# GBLIN Protocol Plugin

> [!IMPORTANT]
> ## STOP — COMPLETE ONBOARDING BEFORE USING THIS PLUGIN
>
> Before calling any GBLIN endpoint or tool, you MUST complete the Base MCP onboarding flow:
> 1. Call `get_wallets` (Detection) — the user's wallet address is required by every prepare call
> 2. Present wallet status and disclaimer (Onboarding)
>
> Do NOT skip this step. The user's wallet address is needed for every transaction.

GBLIN (Global Balanced Liquidity Index) is a **wealth-preservation protocol on Base mainnet**. Every GBLIN token is fully backed by a real treasury of cbBTC, WETH and USDC, priced by Chainlink oracles and governed by a 48-hour timelock. Basket weights are set on-chain and rebalance over time — read them live from `get_treasury_state` rather than assuming fixed percentages. It is not a meme coin: it is an index with an algorithmic Crash Shield that reallocates toward USDC as basket assets draw down (adaptive threshold, from ~15%).

This plugin fetches unsigned calldata from the GBLIN MCP server (`@gblin-protocol/mcp-server`), then executes via Base MCP's `send_calls`.

**Supported chain:** Base mainnet (`8453` / `0x2105`).

**Contract (production):** `0x36C81d7E1966310F305eA637e761Cf77F90852f0`

**Timelock (owner):** `0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd` — every owner-only change is scheduled and executes only after a 48h delay. Parameters can change through it, so never describe the protocol as immutable.

---

## Prerequisites

The GBLIN MCP server must be installed and active in the same agent session. Install it once:

```json
{
  "mcpServers": {
    "gblin": {
      "command": "npx",
      "args": ["-y", "@gblin-protocol/mcp-server"]
    }
  }
}
```

All six GBLIN tools are read-only or produce unsigned calldata — they never move funds directly.

---

## Read tools (state, quotes, health)

Use these tools to gather information before preparing any transaction.

### 1. `get_treasury_state`
Returns live NAV per token, basket composition, Crash Shield status, and total TVL.

```
Tool: get_treasury_state
Args: none
Returns: { nav_usd, nav_eth, basket: [{ asset, weight, balance }], crash_shield_active, tvl_usd }
```

**Use when:** user asks "What is GBLIN worth?", "What's in the treasury?", "Is the Crash Shield active?"

### 2. `quote_safe_swap`
Previews a buy or sell with slippage applied. Always call this before preparing a transaction.

```
Tool: quote_safe_swap
Args: { direction: "buy" | "sell", amount_usdc?: number, amount_gblin?: number }
Returns: { gblin_out?, usdc_out?, nav_usd, slippage_bps, min_out }
```

**Use when:** user asks "How much GBLIN do I get for $100?", "What do I receive if I sell 5 GBLIN?"

### 3. `analyze_treasury_health`
Returns basket balances, gas estimate, cooldown status, and rebalance needs.

```
Tool: analyze_treasury_health
Args: { address: "<user_wallet>" }
Returns: { basket_health, cooldown_remaining_s, gas_estimate_gwei, rebalance_needed }
```

**Use when:** user asks about cooldown, gas costs, or treasury health before transacting.

### 4. `get_governance_state`
Returns timelock status, pending proposals, and protocol lock state.

```
Tool: get_governance_state
Args: none
Returns: { timelock_address, min_delay_hours, pending_operations, owner_renounced }
```

**Use when:** user asks about governance, who controls the protocol, or whether ownership is renounced.

---

## Prepare tools (unsigned calldata → send_calls)

These tools return unsigned transaction calldata. Pass the result directly to Base MCP's `send_calls`.

### 5. `invest_usdc_to_gblin` — Buy GBLIN with USDC

```
Tool: invest_usdc_to_gblin
Args: {
  from: "<user_wallet_address>",
  amount_usdc: <number, e.g. 100>,
  min_gblin_out: <number from quote_safe_swap>
}
Returns: {
  transactions: [
    { step: "approve", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: "0x...", value: "0x0", chainId: 8453 },
    { step: "buy",     to: "0x36C81d7E1966310F305eA637e761Cf77F90852f0", data: "0x...", value: "0x0", chainId: 8453 }
  ]
}
```

**Steps before calling:**
1. `get_wallets` → `address`
2. `quote_safe_swap({ direction: "buy", amount_usdc: X })` → `min_gblin_out`
3. `analyze_treasury_health({ address })` → confirm no active cooldown
4. Call `invest_usdc_to_gblin` → get transactions array
5. Pass to `send_calls` (see mapping below)

### 6. `swap_gblin_to_usdc_jit` — Sell GBLIN for USDC (JIT atomic)

```
Tool: swap_gblin_to_usdc_jit
Args: {
  from: "<user_wallet_address>",
  amount_gblin: <number>,
  min_usdc_out: <number from quote_safe_swap>
}
Returns: {
  transactions: [
    { step: "sell", to: "0x36C81d7E1966310F305eA637e761Cf77F90852f0", data: "0x...", value: "0x0", chainId: 8453 }
  ]
}
```

> **Cooldown notice:** GBLIN enforces a 2-minute cooldown between buy and sell for the same address. Always call `analyze_treasury_health` first. If `cooldown_remaining_s > 0`, tell the user to wait before selling.

**Steps before calling:**
1. `get_wallets` → `address`
2. `analyze_treasury_health({ address })` → check `cooldown_remaining_s === 0`
3. `quote_safe_swap({ direction: "sell", amount_gblin: X })` → `min_usdc_out`
4. Call `swap_gblin_to_usdc_jit` → get transactions array
5. Pass to `send_calls`

---

## send_calls mapping

Map every object in `transactions[]` directly to the `calls` array:

```json
{
  "chain": "base",
  "calls": [
    { "to": "<tx.to>", "value": "<tx.value>", "data": "<tx.data>" }
  ]
}
```

For multi-step flows (approve + buy), include both calls in the same `send_calls` invocation — the user approves once and all calls execute atomically.

---

## Orchestration patterns

### Buy GBLIN with USDC

```
1. get_wallets                                    → address
2. get_treasury_state                             → nav_usd (show to user)
3. quote_safe_swap({ direction:"buy", amount_usdc })  → min_gblin_out
4. analyze_treasury_health({ address })           → confirm no cooldown / gas OK
5. invest_usdc_to_gblin({ from, amount_usdc, min_gblin_out })
   → transactions[approve, buy]
6. send_calls(chain="base", calls=[approve_call, buy_call])
7. User approves in Base Account → get_request_status(requestId)
8. Confirm mint. Show new GBLIN balance.
```

### Sell GBLIN for USDC

```
1. get_wallets                                    → address
2. analyze_treasury_health({ address })           → cooldown_remaining_s === 0 (else wait)
3. quote_safe_swap({ direction:"sell", amount_gblin }) → min_usdc_out
4. swap_gblin_to_usdc_jit({ from, amount_gblin, min_usdc_out })
   → transactions[sell]
5. send_calls(chain="base", calls=[sell_call])
6. User approves → get_request_status(requestId)
7. Confirm. Show USDC received.
```

### Check portfolio / treasury

```
1. get_treasury_state  → nav, basket, crash shield status
2. get_governance_state → timelock, owner, pending ops
3. Present summary to user (no transaction needed)
```

---

## Safety rules for the agent

| Rule | Detail |
|------|--------|
| **Always quote first** | Call `quote_safe_swap` before any prepare tool. Never skip slippage check. |
| **Cooldown enforced onchain** | Selling within 2 min of buying will revert. Surface this to the user proactively. |
| **Min deposit** | Minimum buy is 0.0005 ETH equivalent (~$1). Reject smaller amounts with a clear message. |
| **Fee disclosure** | 0.1% fee on buy: 0.05% to founder wallet, 0.05% increases intrinsic NAV for all holders. Transfers are fee-free. |
| **Crash Shield** | If `crash_shield_active: true`, USDC weight increases automatically; inform the user before they buy. |
| **Timelock** | Any governance change takes ≥48h to execute. The protocol cannot be rug-pulled instantly. |
| **Never send private keys** | GBLIN tools are read-only or unsigned calldata only. No key material ever leaves the user's Base Account. |

---

## Key addresses (Base mainnet)

| Asset | Address |
|-------|---------|
| GBLIN contract | `0x36C81d7E1966310F305eA637e761Cf77F90852f0` |
| GBLIN Timelock | `0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd` |
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH (Base) | `0x4200000000000000000000000000000000000006` |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` |

---

## Useful links

- Website & docs: https://gblin.digital
- Agent docs: https://gblin.digital/agents
- Whitepaper (this is the specification; there is no PDF): https://github.com/gblinproject/GBLIN-Protocol
- MCP server (NPM): `@gblin-protocol/mcp-server`
- MCP source: https://github.com/gblinproject/gblin-treasury-risk-regime
- Aerodrome pool: https://dexscreener.com/base/0x7dcd4f5bcdae0546c84dab54401a93ad6e92ae1b
- Morpho market: https://app.morpho.org/base/market/0x8f086a90c1a92be751ac641f2a1ca6458695889bf50a6caba9566b4c9c585a62/gblin-usdc
- DeFiLlama TVL: https://defillama.com/protocol/tvl/global-balanced-liquidity-index
- BaseScan: https://basescan.org/address/0x36C81d7E1966310F305eA637e761Cf77F90852f0
