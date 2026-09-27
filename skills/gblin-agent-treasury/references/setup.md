# Setup

The CLI signs with the agent's own wallet. Nothing is custodied.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `GBLIN_AGENT_PRIVATE_KEY` | for park, ensure-usdc, pay, run | 0x-prefixed 32-byte hex key of the agent wallet on Base |
| `GBLIN_AGENT_ADDRESS` | for a read-only `status` without a key | wallet address to read |
| `GBLIN_RPC_URL` | no | preferred Base RPC endpoint; public endpoints are tried after it |
| `GBLIN_RESERVE_USDC` | no | USDC kept liquid (default 10) |
| `GBLIN_MIN_PARK_USDC` | no | smallest surplus worth parking (default 5) |
| `GBLIN_MAX_EXIT_USDC` | no | largest single refill (default 50) |
| `GBLIN_MAX_PAY_USDC` | no | largest x402 payment the client signs (default 1) |
| `GBLIN_MIN_GAS_ETH` | no | parking is skipped below this ETH balance (default 0.0005) |
| `GBLIN_RISK_GATE` | no | `false` parks even in a crash regime (default: parking waits) |

The key is read from the environment only. Never echo it and never pass it as an argument.

## Choosing the reserve

The reserve is the USDC the agent may need before the next refill can run: at least the largest invoice it pays plus a margin. A refill takes three transactions on Base (about half a minute) and needs a little ETH for gas.

## Verify

```bash
npx @gblin-protocol/agent-treasury@0.1.0 status --json
```

Expected: a JSON object with `usdc`, `gblin`, `eth`, `navUsd`, `regime`, `canPark` and `canParkReason`.
