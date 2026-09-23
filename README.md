# GBLIN MCP Server

Model Context Protocol server for the GBLIN protocol on Base mainnet: an on-chain index of cbBTC, WETH and USDC whose shares are minted at NAV and redeemed pro rata in kind. The server reads live state, verifies governance and risk attestations, and returns unsigned calldata to enter, leave and bid. It never holds keys, signs or broadcasts.

Published on npm as [`@gblin-protocol/mcp-server`](https://www.npmjs.com/package/@gblin-protocol/mcp-server).

[![npm](https://img.shields.io/npm/v/@gblin-protocol/mcp-server.svg)](https://www.npmjs.com/package/@gblin-protocol/mcp-server)
[![CI](https://github.com/gblinproject/gblin-treasury-risk-regime/actions/workflows/ci.yml/badge.svg)](https://github.com/gblinproject/gblin-treasury-risk-regime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Base Mainnet](https://img.shields.io/badge/network-Base%20mainnet-0052FF)](https://basescan.org/address/0xc2181d975c05c8c724b334bcED0764c0b86B1D53)
[![Governance: 48h Timelock](https://img.shields.io/badge/governance-48h%20Timelock-1f6feb)](https://basescan.org/address/0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd)
[![x402 Manifest](https://img.shields.io/badge/x402-manifest-green)](https://gblin.digital/.well-known/x402)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-Active-success)](https://registry.modelcontextprotocol.io)
[![Smithery](https://img.shields.io/badge/Smithery-gblin--protocol-orange)](https://smithery.ai/servers/gblin-protocol/mcp)

Documentation and quick start: [gblin.digital/agents](https://gblin.digital/agents). Starter examples: [`examples/`](examples/).

## Features

- Market risk regime (`calm` / `elevated` / `crash`) read from the vault's on-chain Crash Shield, with a severity score and a risk posture
- Quotes at NAV for minting and redeeming, with a dynamic slippage buffer
- One tool that prepares any operation on the vault (mint with ETH, WETH or USDC, redeem in kind, exit to ETH or USDC, bid in the auction), each step with its gas limit
- Simulation of those steps before signing, in sequence against the latest block, with decoded revert reasons and the gas limit each vault step really needs
- The outcome of a sent transaction, and the NAV per share over time beside ETH and BTC
- Treasury health of an agent wallet: balances, gas runway, cooldown, allocation advice
- Governance verification: owner, pending owner, timelock roles and scheduled operations, computed from the chain
- The state of the rebalancing auction, row by row, with the bid to send
- Gasless payments in GBLIN (EIP-3009): prepare the authorization to sign, check it against the chain before anyone spends gas, and, when nobody else will carry it, have GBLIN's relay settle it with the fee in GBLIN, in one atomic transaction
- Offline verification of Risk Attestations (EIP-712) and of AI Action Receipts (RFC 6962)
- A portable skill seed to onboard a peer agent
- Four prompts (ready-made workflows) and four resources (deployment, payments, keys, limits)
- An `outputSchema` on every tool that returns an object, so a client can validate results and generate types

Every tool is free. The server never charges: revenue comes from the on-chain protocol fee when an agent actually uses GBLIN. Verifiable pay-per-call lives on the HTTP endpoints listed under [x402 endpoints](#x402-endpoints).

## Contracts (Base mainnet, chain id 8453)

| Component | Address | Role |
|---|---|---|
| Vault | [`0xc2181d975c05c8c724b334bcED0764c0b86B1D53`](https://basescan.org/address/0xc2181d975c05c8c724b334bcED0764c0b86B1D53) | The ERC-20 share and the basket. Mints at NAV, redeems in kind, rebalances by Dutch auction, accepts payments by signature (EIP-3009). Never swaps. |
| Lens | [`0xfCFea8027019E8551A1f09AD91532471F5D26f61`](https://basescan.org/address/0xfCFea8027019E8551A1f09AD91532471F5D26f61) | Read-only views beside the vault: quotes, configuration, basket rows, auction state. |
| Zap | [`0x0E9D6Ceb6D313b021622C121Cda9C62e86e60200`](https://basescan.org/address/0x0E9D6Ceb6D313b021622C121Cda9C62e86e60200) | The only contract that swaps: mints with any token, exits to ETH by redeeming in kind and selling every leg, all or nothing. |
| Timelock | [`0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd`](https://basescan.org/address/0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd) | 48-hour minimum delay, 14-day grace period, open executor. Proposer and canceller roles are held by separate addresses. |

Previous deployments (`0x36C81d7E1966310F305eA637e761Cf77F90852f0`, `0x38DcDB3A381677239BBc652aed9811F2f8496345`) are superseded. Nothing is read from them; holders migrate through the web app.

Fees: 0.10% on every mint with ETH or WETH (0.05% stays in the vault and lifts the NAV of every share, 0.05% is minted as shares to the fee recipient); in-kind deposits pay a 0.50% floor plus a deviation tax; a 0.50% yearly management fee accrues as shares; redemption in kind and transfers carry no fee.

## Hosted variant

A stateless Streamable HTTP server runs at `https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp` — no install, no auth, no session, 60 requests per minute per IP. It serves the vault, action and payment tools of this package under two-level names (`treasury.*`, `actions.*`, `payments.*`, `governance.state`, `auction.state`, `attestation.verify`), built from the same source, plus the risk, receipts and coherence tools; the snake_case names below are accepted there as aliases. GET-only audit surfaces: [`/meta`](https://gblin-mcp.gblin-mcp-worker.workers.dev/meta), [`/tools.json`](https://gblin-mcp.gblin-mcp-worker.workers.dev/tools.json), [`/resources.json`](https://gblin-mcp.gblin-mcp-worker.workers.dev/resources.json), [`/conformance`](https://gblin-mcp.gblin-mcp-worker.workers.dev/conformance). Also listed on [Smithery](https://smithery.ai/servers/gblin-protocol/mcp).

## API

### Tools

- **get_market_risk_regime**
  - The BTC/ETH risk regime derived from the vault's Crash Shield: `calm`, `elevated` or `crash`, with `severity_pct`, a `risk_posture` (`risk_on` / `reduce` / `risk_off`), the defensive cash weight and one entry per risk asset
  - Inputs: none
  - Call it before any action that deploys capital; a `crash` reading means stand down

- **get_treasury_state**
  - NAV in USD, ETH price, whether the vault can price itself (`nav_reliable`), the yearly management fee, whether an auction is open, Crash Shield status and the basket rows with base and dynamic weights
  - Inputs: none

- **quote_safe_swap**
  - Previews a mint (ETH→GBLIN) or a redemption (GBLIN→ETH) through the Lens, with a safe minimum output under the dynamic slippage buffer (2.5% normally, 4% while the Crash Shield is active) and the fee breakdown
  - Inputs:
    - `direction` (string): `buy` or `sell`
    - `amount_in` (string): decimal amount of ETH (buy) or GBLIN (sell)

- **swap_gblin_to_usdc_jit**
  - Unsigned calldata to turn GBLIN into a given amount of USDC just in time: approve the shares to the Zap, the Zap's `sellGBLINForEth` (redeem in kind and sell every leg, all or nothing), then a WETH→USDC swap. Three transactions; ERC-4337 and EIP-7702 wallets batch them into one
  - Inputs:
    - `usdc_needed` (string): decimal USDC amount
    - `wallet_address` (string): the agent's address, for the cooldown check and as receiver
  - Every step carries a minimum output; the last step's input is the guaranteed minimum of the previous one

- **invest_usdc_to_gblin**
  - Unsigned calldata to mint GBLIN with USDC through the Zap: approve USDC, then one call that swaps to WETH and mints at NAV. Two transactions
  - Inputs:
    - `usdc_amount` (string): decimal USDC amount
    - `wallet_address` (string): receiver of the shares
  - Both bounds travel with the call: the minimum WETH from the swap and the minimum shares from the mint

- **analyze_treasury_health**
  - GBLIN, USDC and ETH balances of a wallet, gas health, the vault's cooldown for that wallet, and an allocation recommendation with the runway in days when a burn rate is given
  - Inputs:
    - `wallet_address` (string)
    - `daily_burn_usd` (number, optional): average daily spend, enables the runway estimate

- **get_governance_state**
  - Owner and pending owner of the vault, the fee recipient, the timelock's minimum delay and roles, and, when the pending owner is the timelock, the deterministic id and state of the scheduled `acceptOwnership` operation
  - Inputs:
    - `operation_id` (string, optional): a timelock operation id (bytes32) to inspect

- **share_skill_with_peer**
  - A portable JSON seed another agent can use to install this server and start: install instructions, the tool list, contract addresses, a worked example and the caller's ERC-8021 builder code for attribution
  - Inputs:
    - `caller_wallet` (string)
    - `peer_context` (string, optional): what the peer does, to tailor the example
    - `example_amount_usdc` (number, optional)

- **get_auction_state**
  - The rebalancing auction: whether it is open, the current premium over the oracle price and its curve, and one entry per basket row with the side the vault takes, the gap in ETH, the token and amount the bidder hands over, and unsigned calldata for the approval and the bid. `best` is the row with the largest gap
  - Inputs: none
  - The premium is the whole reward; nothing is paid out of the vault. The input is reduced to what closes the gap

- **prepare_gblin_payment**
  - Builds a gasless GBLIN payment. The share token implements EIP-3009, the same mechanism USDC uses: the holder signs an authorization and anybody can carry it on chain, so the payer needs no ETH. Returns the EIP-712 message to sign, the amount in shares and atomic units, the payer's balance, the x402 "exact" payload for paying an HTTP endpoint in GBLIN, and the accepts block a seller publishes to be paid in GBLIN
  - Inputs:
    - `from` (string): the payer, the wallet that will sign
    - `to` (string): the recipient
    - `amount_gblin` (string) or `amount_usd` (string): the amount, converted at the live NAV when given in USD
    - `method` (string, optional): `receive` (default) can be submitted only by the recipient, so nobody can front-run it; `transfer` can be submitted by anyone, which is what an x402 facilitator does
    - `valid_for_seconds` (number, optional): default 600, maximum 86,400
  - The EIP-712 domain is read from the token through EIP-5267, never assumed. No private key is requested, held or transmitted

- **verify_gblin_authorization**
  - Checks a signed authorization against the chain before anyone spends gas on it: recovers the signer from the digest, or asks the wallet itself through ERC-1271 when the payer is a contract, then checks the validity window against on-chain time, whether the nonce has been used or cancelled, and whether the payer still holds the amount. Returns a verdict, the failing reasons, and the ready calldata when it would settle
  - Inputs:
    - `authorization` (object): from, to, value, validAfter, validBefore, nonce
    - `signature` (string): produced by the payer's wallet
    - `method` (string, optional): `receive` (default) or `transfer`
  - These are the checks an x402 facilitator runs, so a `would_settle` verdict means the payment is good to carry

- **relay_gblin_payment**
  - Hands a signed payment and a signed relay fee to GBLIN's relay (`https://gblin.digital/api/relay/gblin`), which checks both against the chain, simulates them and submits them in one transaction through Multicall3: both settle or neither does. For a payer that holds no ETH and has nobody to carry the payment
  - Inputs:
    - `payment` (object): `{ authorization, signature }`, method `transfer`
    - `fee` (object): `{ authorization, signature }` from the `relay` block of `prepare_gblin_payment` called with `relay: true`
  - The fee is quoted live by the relay, in GBLIN at the NAV. This tool moves funds: it is marked destructive so clients ask before running it

- **prepare_action**
  - Builds the unsigned steps for any operation on the vault, in order, each through the vault or the Zap carrying its gas limit
  - Inputs:
    - `action` (string): `mint_with_eth`, `mint_with_weth`, `mint_with_usdc`, `redeem_in_kind`, `exit_to_eth`, `exit_to_usdc` or `bid`
    - `wallet_address` (string): the wallet that will sign and receive
    - `amount` (string): in ETH, WETH or USDC for mints, in shares for redemptions and the ETH exit, the USDC needed for the USDC exit; not used by `bid`
    - `row` (integer, optional): `bid` only, the basket row; default the largest gap
  - Returns the steps, what they should deliver with the minimums applied, and warnings such as an active cooldown or an amount above the balance

- **preview_steps**
  - Simulates a list of transactions in sequence against the latest block with `eth_simulateV1`, each seeing the state the previous ones left. Returns, per step, success, gas used, whether the given limit is enough, the recommended limit and the decoded revert reason with a hint; and the net token and ETH movements for the wallet
  - Inputs:
    - `from` (string): the wallet that will send the steps
    - `steps` (array): the steps as the tools return them: `target`, `calldata`, optional `value` and `gas`
  - For steps into the vault or the Zap the recommended limit is the smallest one that passes, found by bisection: the vault reserves gas for its capped transfers, so the gas a call uses is below the limit it needs
  - `gas_limit_enough` is `true` when the step passes with the limit it carries, `false` only when that limit is what makes it fail, and `null` when it fails for another reason (a slippage bound, a cooldown), which `error` and `hint` name

- **get_transaction_status**
  - What a sent transaction did: pending, success, reverted or not found; block, confirmations, fee, net token movements for the sender, and the decoded reason when it reverted
  - Inputs: `hash` (string)

- **get_nav_history**
  - NAV per share over time, read at past blocks, beside the ETH/USD and BTC/USD feeds the vault uses, with the change of each over the window and the NAV's largest drawdown. History starts at the deployment of the vault in service
  - Inputs: `interval` (`hour` or `day`, default `day`), `points` (2 to 90, default 30)
  - Historical reads use public endpoints that serve them; set `GBLIN_ARCHIVE_RPC_URL` to use your own

- **verify_risk_attestation**
  - Verifies a Risk Attestation offline: recomputes the EIP-712 id, recovers the signer and checks it against the published attestor, checks freshness, and reports the live drift of the regime since issuance
  - Inputs:
    - `attestation` (object): the object returned by `GET https://gblin.digital/api/x402/attestation`
    - `expected_attestor` (string, optional): the attestor address to pin
  - Accepts EIP-712 domain version 2 (verifying contract = the vault in service) and version 1 (the previous deployment); the version the attestation declares selects the domain

- **seal_action_demo**
  - Seals the hashes of an AI action into the public transparency log (demo: 5 per day per IP, receipt marked `demo: true`) and returns the portable receipt
  - Inputs:
    - `action` (string): a short label
    - `input_hash` (string): SHA-256 of the input
    - `output_hash` (string, optional)
    - `agent_id`, `tool`, `meta` (string, optional): identifiers, published in clear
  - Unlimited seals are a paid x402 HTTP endpoint; see `how_to_seal_paid`

- **get_receipt**
  - A sealed receipt by index: canonical payload, Ed25519 signature, RFC 6962 inclusion proof and the signed checkpoint
  - Inputs:
    - `index` (integer)

- **how_to_seal_paid**
  - How to seal without limits: endpoint, body schema, payment flow and offline verification
  - Inputs: none

### Tool annotations (MCP hints)

Every tool sets [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-03-26/server/tools#toolannotations):

| Tool | readOnlyHint | idempotentHint | destructiveHint | openWorldHint |
|---|---|---|---|---|
| all except the three below | `true` | `true` | `false` | `true` |
| `prepare_gblin_payment` | `true` | `false` | `false` | `true` |
| `seal_action_demo` | `false` | `false` | `false` | `true` |
| `relay_gblin_payment` | `false` | `true` | `true` | `true` |

Calldata builders are read-only: they return bytes, they do not send them. `prepare_gblin_payment` is not idempotent because every call draws a fresh nonce. Sealing appends to a public log and is never destructive. `relay_gblin_payment` moves the payer's funds on chain, so it is marked destructive and clients should confirm before calling it. Every tool also carries a human-readable `title`.

### Output schemas

Every tool except `seal_action_demo` declares an `outputSchema`. A successful result carries the same object as `structuredContent` and as JSON text. The `required` list of each schema is the contract: fields a successful call always returns. Other fields are described but optional, and the schemas accept additional fields, so adding one is not a breaking change. Errors carry `isError: true` and no structured content.

### Prompts

| Prompt | What it does |
|---|---|
| `risk_gate` | Reads the regime and applies a rule stated before looking: proceed, halve, or stand down |
| `pay_in_gblin` | Prepare, sign in the payer's wallet, verify, then hand on a gasless GBLIN payment |
| `pay_invoice_just_in_time` | Exit just enough GBLIN to USDC to settle an invoice, after checking cooldown and gas |
| `seal_and_verify` | Seal an action, read the receipt back, and state what it does and does not prove |

### Resources

| URI | Content |
|---|---|
| `gblin://contracts` | Every contract in service with its role, and the deprecated deployments not to use |
| `gblin://payments` | The EIP-712 domain read live from the token, the x402 payload, and the accepts block a seller publishes |
| `gblin://keys` | The attestor address to pin, and where the log and witness keys are published |
| `gblin://limits` | Price (free by default), the metering switch, and where the limits come from |

## Usage

### Claude Desktop

Add to `claude_desktop_config.json`:

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

### Cursor, Windsurf and other MCP clients

```json
{
  "mcpServers": {
    "gblin": {
      "command": "npx",
      "args": ["-y", "@gblin-protocol/mcp-server"],
      "env": { "GBLIN_RPC_URL": "https://base-rpc.publicnode.com" }
    }
  }
}
```

### Programmatic (TypeScript)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "npx", args: ["-y", "@gblin-protocol/mcp-server"] });
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

const jit = await client.callTool({
  name: "swap_gblin_to_usdc_jit",
  arguments: { usdc_needed: "0.50", wallet_address: "0xYourAgent..." },
});
```

### AGENTS.md for coding assistants

```bash
npx -p @gblin-protocol/mcp-server gblin-init
```

Creates an `AGENTS.md` from the template at [gblin.digital/AGENTS.template.md](https://gblin.digital/AGENTS.template.md), or appends a delimited block to an existing one. Idempotent; `--dry-run` previews, `--force` refreshes the block. No files are written at install time; set `GBLIN_SKIP_HINT=1` to silence the post-install hint.

## Configuration

`GBLIN_RPC_URL` selects the Base RPC endpoint; the default is `https://base-rpc.publicnode.com`. For sustained load use a dedicated provider:

```bash
export GBLIN_RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
npx @gblin-protocol/mcp-server
```

`GBLIN_ATTESTOR_ADDRESS` overrides the published attestor address used by `verify_risk_attestation`.

## x402 endpoints

Pay-per-call data lives on HTTP, settled in USDC on Base through the Coinbase CDP facilitator with gasless EIP-3009 `transferWithAuthorization`. Clients such as `@x402/fetch` handle the 402 challenge, the signature and the retry.

| Endpoint | Price | Returns |
|---|---|---|
| `GET gblin.digital/api/x402/treasury-state` | $0.001 | NAV, basket weights, Crash Shield status |
| `GET gblin.digital/api/x402/quote` | $0.001 | Mint or redemption preview with the dynamic slippage buffer |
| `GET gblin.digital/api/x402/governance` | $0.001 | Owner, timelock, pending operations |
| `GET gblin.digital/api/x402/health` | $0.002 | Wallet balances, gas runway, allocation advice |
| `GET gblin.digital/api/x402/invest` | $0.002 | Unsigned calldata: USDC → GBLIN |
| `GET gblin.digital/api/x402/jit` | $0.005 | Unsigned calldata: GBLIN → USDC just in time |
| `GET gblin.digital/api/x402/attestation` | $0.003 | Signed EIP-712 Risk Attestation, valid ten minutes |
| `POST gblin.digital/api/x402/seal` | $0.0045 | A sealed AI Action Receipt |

Machine-readable manifest: `https://gblin.digital/.well-known/x402`. Payment recipient: `0x0ebA5d314F4f5Dcb7A094953Fa9311a45172dd1B`.

## Risk Attestation

`GET https://gblin.digital/api/x402/attestation` returns a ten-minute, verifiable snapshot of the BTC/ETH risk regime, signed under the EIP-712 domain `GBLIN Risk Attestation`, version 2, chain 8453, verifying contract = the vault in service. The response embeds its domain, types and message under `eip712`; a verifier recovers the signer and checks it against the published attestor address, which it should pin. `verify_risk_attestation` does this offline and also accepts attestations issued under domain version 1.

## AI Action Receipts

A public, append-only [RFC 6962](https://www.rfc-editor.org/rfc/rfc6962) transparency log for AI actions. Input and output go in as hashes only; the short `action`, `agent_id`, `tool` and `meta` strings are published in clear, so put identifiers there, never secrets. Each seal returns a portable receipt:

```
receipt = canonical payload
        + Ed25519 signature            (key: gblin.digital/receipts-log)
        + RFC 6962 inclusion proof     (leaf → Merkle root)
        + C2SP signed checkpoint       (origin, tree size, root)
```

Canonicalization is frozen as `gblin-canonical-json/1`: object keys sorted by UTF-16 code unit, no whitespace, `JSON.stringify` semantics for primitives, recursion for objects and arrays. Test vector: payload `{"b":1,"a":null}` → canonical `{"a":null,"b":1}` → leaf = `SHA256(0x00 || canonical_bytes)`. The receipt signature is Ed25519 over `"gblin-receipt/v1\n" + canonical`.

- Seal (paid, unlimited): `POST https://gblin.digital/api/x402/seal`, $0.0045 USDC via x402
- Seal (demo, 5 per day per IP): `POST <worker>/v1/seal-demo`, or the tool `seal_action_demo`
- Read, free: `<worker>/v1/receipt/:index`, `/log`, `/log/checkpoint`, `/log/proof/:index`, `/log/consistency`, `/log/leaves`, and the page `/receipt/:index`
- Daily anchor of the tree root on Base as an EAS attestation (schema `0x9f433a96…`)
- Offline verifier with no dependencies: [`verify-receipt.mjs`](./verify-receipt.mjs) — `node verify-receipt.mjs receipt.json`

The checkpoint is signed by the log operator and cosigned by an independent witness (Markovian Protocol). A cosignature attests that the log stayed append-only between the sizes the witness saw; it does not attest that a receipt's content is true. A seal proves existence and time; it is not a compliance certificate and not an endorsement. `<worker>` = `https://gblin-mcp.gblin-mcp-worker.workers.dev`.

## Coherence Proof

GBLIN pre-registers hash-pinned promises and runs an automaton that probes them every ten minutes and seals each closed day as an EAS attestation on Base. Free report: [`/coherence`](https://gblin-mcp.gblin-mcp-worker.workers.dev/coherence). Live promises: uptime of the paid attestation endpoint, and honesty of the public agent-economy counters, with the protocol's own wallets disclosed. GBLIN is a registered ERC-8004 agent (#59286).

## Architecture notes

- **Mint at NAV, redeem in kind.** The vault prices every mint from Chainlink feeds and issues shares against the deposit; redemption pays the exact pro-rata slice of every basket row, reads no price feed and cannot be paused. The vault never swaps.
- **The Zap swaps.** Entering with a token other than ETH or WETH, and leaving to ETH or USDC, go through the Zap, which swaps on a venue and mints or redeems on the vault in the same call. Exits are all or nothing: a leg that cannot be sold reverts the whole transaction instead of paying out less.
- **Rebalancing is a Dutch auction.** When a row drifts past its band the vault opens an auction; the counterparty trades toward the target weights at the oracle price adjusted by a premium that starts at a discount and rises to a cap over one ramp. `get_auction_state` exposes it.
- **Dynamic slippage.** Minimum outputs are quoted from the Lens and buffered by 2.5%, or 4% while the Crash Shield is active. No calldata leaves this server with a zero minimum on a swap.
- **Cooldown.** The vault refuses a redemption for a short window after the same address minted; the window is read live and reported by `analyze_treasury_health`.
- **Payments by signature.** The vault implements EIP-3009 (`transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`), so an agent can settle in GBLIN the way it settles in USDC. Transfers carry no fee.

## Security notes

- The server is read-only: it never holds, signs or broadcasts. Calldata is plain ABI-encoded bytes for the agent's own wallet to review and send.
- Every quote comes from on-chain calls and Chainlink feeds. A stale or non-positive ETH/USD answer aborts the tool with an explicit error rather than a bad number; the vault's own `isNavReliable` is reported alongside.
- No telemetry, no analytics, no remote dependencies beyond the configured RPC.

## Development

```bash
git clone https://github.com/gblinproject/gblin-treasury-risk-regime
cd gblin-treasury-risk-regime
npm install
npm run build
npm test                 # handler smoke test against Base mainnet, read-only
npm run test:protocol    # speaks MCP over stdio: capabilities, instructions, prompts, resources
npm run test:schemas     # every tool through the official MCP client, which validates outputSchema
npx tsx scripts/test-hosted.ts <url>   # the hosted server over Streamable HTTP, with the same validation
npm start                # run the compiled server
```

Two tests run against a local fork of Base and send transactions there, never on mainnet:

```bash
anvil --fork-url <base rpc> --port 8555 &
export GBLIN_RPC_URL=http://127.0.0.1:8555
npm run test:payments    # gasless payment: signed, verified, carried by a third party; replay and front-run refused
npm run test:calldata    # sends the exit and investment steps exactly as the tools return them
npm run test:actions     # every prepare_action, simulated then sent; preview agrees with the chain; gas limits found by bisection
```

```
src/
  config.ts    # addresses, slippage and cache settings
  abi.ts       # vault, Lens, Zap, timelock, Chainlink and ERC-20 ABIs
  client.ts    # viem public client and on-chain timestamp
  helpers.ts   # NAV, basket state, slippage, cooldown, reverse quote
  auction.ts   # auction state and bid sizing
  tools.ts     # the treasury, auction and risk tools, and the tool list
  payments.ts  # gasless payments (EIP-3009): prepare, verify, relay
  actions.ts   # prepare_action, preview_steps, get_transaction_status, get_nav_history
  shared.ts    # result envelopes, builder code, Zap routing data and gas limit
  version.ts   # generated from package.json by scripts/write-version.mjs
  receipts.ts  # the three receipt tools
  output-schemas.ts  # the outputSchema of every tool
  prompts.ts   # the four prompts
  resources.ts # the four resources
  index.ts     # MCP stdio server entry and initialize instructions
  init.ts      # the gblin-init command
worker/        # the hosted Streamable HTTP server (Cloudflare Workers)
scripts/       # test.ts, test-protocol.ts, test-output-schemas.ts, test-payments-fork.ts, test-calldata-fork.ts
```

## Links

- Vault: [`0xc2181d975c05c8c724b334bcED0764c0b86B1D53`](https://basescan.org/address/0xc2181d975c05c8c724b334bcED0764c0b86B1D53)
- Protocol site and agent docs: [gblin.digital](https://gblin.digital) · [gblin.digital/agents](https://gblin.digital/agents)
- Protocol sources and specification: [github.com/gblinproject/GBLIN-Protocol](https://github.com/gblinproject/GBLIN-Protocol)
- ElizaOS plugin: [`plugin-gblin`](https://github.com/gblinproject/GBLIN_PLUGIN)
- Issues: [github.com/gblinproject/gblin-treasury-risk-regime/issues](https://github.com/gblinproject/gblin-treasury-risk-regime/issues)

MIT © GBLIN Protocol
