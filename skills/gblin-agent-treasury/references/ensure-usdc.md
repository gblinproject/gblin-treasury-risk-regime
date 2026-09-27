# Ensure USDC

```bash
npx @gblin-protocol/agent-treasury@0.1.0 ensure-usdc <amount> [--json]
```

Makes sure the wallet holds at least `<amount>` USDC (decimal, for example `2.50`). If it already does, nothing is sent (`action: "none"`). Otherwise the shortfall is redeemed from GBLIN in three transactions: `approve(GBLIN -> Zap)`, `Zap.sellGBLINForEth` (redeem in kind and sell every leg, all or nothing), then a Uniswap V3 swap of the ETH into USDC with the shortfall as the minimum output.

## Refusals

- `cooldown … N more seconds`: the wallet minted directly on the vault less than the cooldown ago; wait N seconds and retry.
- `shortfall … exceeds the policy cap`: raise `GBLIN_MAX_EXIT_USDC` only on the user's instruction.
- `No GBLIN to exit`: the treasury is empty; ask the user to fund USDC.
- `The exit confirmed but USDC is … below …`: rare; the swap returned less than expected. Report the transactions, do not loop.

## Input validation

`<amount>` must match `^\d+(\.\d+)?$`.
