# Park the surplus

```bash
npx @gblin-protocol/agent-treasury@0.1.0 park [--json]
```

Mints GBLIN with every USDC above the reserve, when the policy allows it. Two transactions: `approve(USDC -> GBLIN Zap)`, then the Zap swaps USDC to WETH and mints at net asset value in one call, with minimums from the Chainlink price and the vault's own quote.

## Output

`action` is `parked` (with `txHashes`) or `none` with a `reason`:

| Reason | What it means |
| --- | --- |
| surplus below the minimum | nothing worth parking |
| ETH for gas below the floor | ask the user to top up ETH first |
| the vault reports its NAV as not reliable | a price feed is stale; try later |
| the market regime is a crash / could not be read | the risk gate is on; try later or set `GBLIN_RISK_GATE=false` on the user's explicit instruction |

`run` is the same command, for a scheduler (one policy pass).

## Before acting

Parking moves USDC into a volatile index. Confirm the reserve with the user once; then the policy runs on its own.
