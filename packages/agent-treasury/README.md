# @gblin-protocol/agent-treasury

A treasury for AI agents on Base, in one sentence: **operating cash stays in USDC, the surplus is parked in GBLIN, and USDC is pulled back from GBLIN just in time when an x402 invoice arrives.**

Library and CLI. Self-custody: every transaction is sent from the agent's own wallet, nothing is held by anyone else, no key leaves the process.

- **Park** — USDC above a reserve you set is minted into [GBLIN](https://gblin.digital), an on-chain index of cbBTC, WETH and USDC with a crash-shield rule, at net asset value.
- **Refill** — when the wallet needs more USDC than it holds, the exact amount is redeemed from GBLIN (redeem in kind, sell the legs, swap to USDC) in three transactions.
- **Pay** — Coinbase's reference x402 client, with the refill attached to its `onBeforePaymentCreation` hook: a 402 for USDC on Base triggers the refill before the authorization is signed, and a price above your cap is refused before anything is signed.

GBLIN is a volatile index, not a stablecoin substitute: the parked surplus moves with the basket. Keep in USDC what you cannot afford to see move.

## Install

```bash
npm install @gblin-protocol/agent-treasury
```

## Library

```ts
import { createTreasury, createTreasuryFetch, fromPrivateKey } from "@gblin-protocol/agent-treasury";

const treasury = createTreasury({
  signer: fromPrivateKey(process.env.GBLIN_AGENT_PRIVATE_KEY as `0x${string}`),
  policy: { reserveUsdc: 10, minParkUsdc: 5, maxExitUsdc: 50, maxPayUsdc: 1 },
});

await treasury.park();                 // surplus above 10 USDC -> GBLIN (skipped in a crash regime)
await treasury.ensureUsdc("2.50");     // exits GBLIN only if USDC is below 2.50

const fetchWithTreasury = createTreasuryFetch(treasury);
const res = await fetchWithTreasury("https://gblin.digital/api/x402/attestation"); // pays 0.003 USDC, refilling first if needed
```

Any wallet that can send a transaction and sign EIP-712 typed data fits the `TreasurySigner` interface; `fromAccount(viemLocalAccount)` and `fromPrivateKey(hex)` are provided.

`treasury.status()` returns balances, NAV, the surplus, the market regime (from the free endpoint of the hosted MCP server), the redemption cooldown and whether parking is allowed right now, with the reason.

## CLI

```bash
export GBLIN_AGENT_PRIVATE_KEY=0x...           # the agent's wallet
npx @gblin-protocol/agent-treasury status --json
npx @gblin-protocol/agent-treasury park --json
npx @gblin-protocol/agent-treasury ensure-usdc 2.50 --json
npx @gblin-protocol/agent-treasury pay https://gblin.digital/api/x402/attestation --max-amount 3000 --json
```

`run` is `park` under another name, for a scheduler. Policy overrides: `GBLIN_RESERVE_USDC`, `GBLIN_MIN_PARK_USDC`, `GBLIN_MAX_EXIT_USDC`, `GBLIN_MAX_PAY_USDC`, `GBLIN_MIN_GAS_ETH`, `GBLIN_RISK_GATE=false`. `GBLIN_RPC_URL` sets a preferred RPC endpoint; public endpoints are tried after it.

## Policy

| Setting | Default | Meaning |
|---|---|---|
| `reserveUsdc` | 10 | USDC kept liquid; only the surplus above it is parked |
| `minParkUsdc` | 5 | below this surplus nothing is parked |
| `maxExitUsdc` | 50 | largest single refill, a guard against a runaway loop |
| `maxPayUsdc` | 1 | largest x402 payment the client signs |
| `minGasEth` | 0.0005 | parking is skipped below this ETH balance |
| `riskGate` | true | parking waits while the market regime is `crash` or cannot be read |

The regime never triggers an exit: a payment that needs USDC gets it in any regime.

## What happens on-chain

- Park: `approve(USDC -> Zap)`, then `GBLINZap.buyGBLINWithToken(USDC, amount, minWethOut, minSharesOut, venue, wallet)`. Both minimums come from the Chainlink price, the Lens quote and a slippage buffer of 2.5% (4% while a basket row is shielded).
- Refill: `approve(GBLIN -> Zap)`, `GBLINZap.sellGBLINForEth(shares, minEthOut, venue, wallet)` (redeem in kind and sell every leg, all or nothing), then Uniswap V3 `exactInputSingle(WETH -> USDC)` with `amountOutMinimum` equal to the USDC needed.
- A mint through the Zap leaves no redemption cooldown on the wallet; a mint made directly on the vault does (20 s at the time of writing), and the refill reports the seconds left instead of sending a transaction that would revert.
- Every Zap step carries an explicit gas limit of 1,100,000: the vault forwards gas-capped transfers, and a wallet's automatic estimate can land just under what the call needs.

These are the same steps the GBLIN MCP server prepares (`prepare_action`: `mint_with_usdc`, `exit_to_usdc`).

## Tests

`npm run test:fork` runs the whole loop against a fork of Base (`anvil --fork-url <base rpc> --port 8556`): funding, park, refill, cooldown, and an x402 invoice served by a local server that returns the challenge bytes of gblin.digital and verifies the EIP-712 signature the client produces after an automatic refill. Settlement itself is not exercised on the fork; it is the standard x402 flow.

## Addresses (Base)

Vault `0xc2181d975c05c8c724b334bcED0764c0b86B1D53` · Lens `0xfCFea8027019E8551A1f09AD91532471F5D26f61` · Zap `0x0E9D6Ceb6D313b021622C121Cda9C62e86e60200` · USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Sources are verified on Basescan and Sourcify; the vault is owned by a 48-hour timelock. No paid third-party audit: see the [audits](https://github.com/gblinproject/GBLIN-Protocol/tree/main/audits) directory for what has been run and what has not.

Security contact: info@gblin.digital
