# Status

```bash
npx @gblin-protocol/agent-treasury@0.1.0 status [--json]
```

Reads, live from Base: the wallet's USDC, GBLIN and ETH; the NAV of one GBLIN in USD; the surplus above the reserve; the market regime (`calm`, `elevated`, `crash`, or `unknown` when the free regime endpoint cannot be read); the redemption cooldown in seconds; whether the vault currently prices itself; and `canPark` with `canParkReason`.

## Reading it

- `surplusUsdc` > `minParkUsdc` and `canPark: true` → `park` will mint.
- `regime: "crash"` or `"unknown"` with the risk gate on → parking waits; refills still work.
- `cooldownSecondsRemaining` > 0 → a refill will be refused until it reaches 0 (only after a mint the wallet made directly on the vault; parking through this CLI leaves no cooldown).
- `navReliable: false` → the vault cannot price a basket row right now; parking waits, and a refill may fail until it can.

Without a key, `GBLIN_AGENT_ADDRESS` gives a read-only status (`readOnly: true`).
