# Changelog

## 0.1.1 — 2026-09-27

- The balances reported after a move are read at the block of the last receipt, from an endpoint that has that block. Load-balanced endpoints answer from replicas that can lag a block or two; an unpinned read right after a confirmed exit returned the old USDC balance and `ensureUsdc` reported a failure for an exit that had succeeded. Found on the first mainnet run; the fork test now includes a lagging-replica proxy.
- `MoveResult.block`: the block the "after" balances were read at (`null` when nothing was sent).
- Every step carries an explicit gas limit (approve, Zap, swap): no step depends on a gas estimate computed against a replica that may not have seen the previous step.
- `readRegime` retries once before answering `unknown`; the read-only `status` prints where the regime came from.
- `GBLIN_RPC_URLS` (comma-separated) replaces the public endpoint list, for operators with their own endpoints and for tests against a fork.

## 0.1.0 — 2026-09-27

First release. `createTreasury` (status, park, ensureUsdc), `createX402Client` / `createTreasuryFetch` (Coinbase's `x402Client` with the refill on `onBeforePaymentCreation` and a per-payment cap), `fromAccount` / `fromPrivateKey` signers, and the `gblin-treasury` CLI (`status`, `park`, `ensure-usdc`, `pay`, `run`). Verified end to end on a fork of Base.
