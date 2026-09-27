# Changelog

## 0.1.0 — 2026-09-27

First release. `createTreasury` (status, park, ensureUsdc), `createX402Client` / `createTreasuryFetch` (Coinbase's `x402Client` with the refill on `onBeforePaymentCreation` and a per-payment cap), `fromAccount` / `fromPrivateKey` signers, and the `gblin-treasury` CLI (`status`, `park`, `ensure-usdc`, `pay`, `run`). Verified end to end on a fork of Base.
