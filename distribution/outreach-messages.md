# Partner outreach — ready-to-send messages (2026-07-27)

Companion to [`partner-outreach-list.md`](./partner-outreach-list.md) (the tracker).
These are the drafted messages for the top targets, ready to paste into email /
Discord / X DM. Before sending: confirm the current handle from the project's own
site, and personalize the greeting if you know a name.

**Standard links (used in every message):**
- x402 manifest: `https://gblin.digital/.well-known/x402`
- Agent card: `https://gblin.digital/.well-known/agent-card.json`
- MCP server: `https://www.npmjs.com/package/@gblin-protocol/mcp-server`

**House style honored below:** no "audited" without qualification (Slither static
analysis: 0 critical / 0 high; no external manual audit), no "immutable" / "no
admin key" (a 48h public timelock governs parameters), no contract version
numbers, no unverifiable "first/only" claims.

---

## 1. Kompass (meta-router) — SEND FIRST

**Subject:** Indexing request + a reputation input Kompass doesn't have yet

Hi — Kompass ranks agents across 12 registries with Bayesian reputation, which is
exactly where a verifiable diligence signal belongs. GBLIN publishes agent
endpoints on Base (risk regime, treasury state, swap calldata, signed attestations),
all discoverable from our manifest and agent card below.

Two concrete asks. First: index our endpoints from the manifest. Second, the
interesting one: consider "carries a fresh GBLIN Risk Attestation" as a
reputation input. It's a perishable (10-minute TTL), EIP-712-signed snapshot of
the on-chain BTC/ETH risk regime that an agent mints for $0.003 and attaches to
capital-moving actions. Verification is free — one `ecrecover`, or the
`verify_risk_attestation` tool in our MCP server. It's derived from on-chain
oracle data, not self-reported, so it fits a Bayesian model cleanly.

- https://gblin.digital/.well-known/x402
- https://gblin.digital/.well-known/agent-card.json
- https://www.npmjs.com/package/@gblin-protocol/mcp-server

Happy to write the adapter ourselves if you point us at the right interface.

---

## 2. Giza / ARMA

**Subject:** A free, independent risk gate for ARMA allocations

Hi — ARMA agents already optimize serious capital across Base lending markets;
what they don't have is a portable proof that they checked market conditions
before each move. GBLIN sells exactly that: a Risk Attestation — a 10-minute-TTL,
EIP-712-signed snapshot of the on-chain BTC/ETH risk regime (calm / elevated /
crash), derived from Chainlink price data on Base, not from anyone's say-so.

The concrete ask: let ARMA agents attach a fresh attestation to allocations, and
tighten sizing when the regime reads `crash`. Verifying costs you nothing — the
`verify_risk_attestation` tool in our MCP server is free, or a single
`ecrecover`. The agent mints for $0.003 via x402. For your users it reads as a
"risk-managed" credential you didn't have to build or maintain.

- https://gblin.digital/.well-known/x402
- https://gblin.digital/.well-known/agent-card.json
- https://www.npmjs.com/package/@gblin-protocol/mcp-server

Integration is ~10 lines; reference snippet on request.

---

## 3. Coinbase AgentKit

**Subject:** Risk attestation actions for AgentKit (follow-up to PR #1376)

Hi — we have an open PR (#1376) adding three GBLIN treasury actions to AgentKit.
This note is about a smaller, complementary piece that may be more broadly
useful: a risk-attestation action pair, `mint_risk_attestation` and
`verify_risk_attestation`. Mint returns an EIP-712-signed, 10-minute-TTL
snapshot of the on-chain BTC/ETH risk regime on Base ($0.003 via x402); verify
is free and gives any AgentKit agent a one-call way to check a counterparty's
proof-of-diligence before accepting a capital-moving action.

The concrete ask: would maintainers accept a PR adding these two actions (we
write it, tests included), and is there feedback on #1376 we should address? The
verify path has no payment dependency at all, so it works for every AgentKit
user out of the box.

- https://gblin.digital/.well-known/x402
- https://gblin.digital/.well-known/agent-card.json
- https://www.npmjs.com/package/@gblin-protocol/mcp-server

---

## 4. ElizaOS

**Subject:** plugin-gblin v0.2.4: risk attestation for every Eliza agent

Hi — we maintain `plugin-gblin` (npm), the ElizaOS plugin for gasless treasury
management on Base mainnet. v0.2.4 adds a Risk Attestation action: an Eliza
agent can now mint an EIP-712-signed, 10-minute-TTL snapshot of the on-chain
BTC/ETH risk regime and attach it to capital-moving actions as
proof-of-diligence — and verify a peer's attestation for free.

The concrete ask: feature `plugin-gblin` in the plugins registry / showcase with
the attestation flow front and center. It's a capability no other listed plugin
provides today as far as we can tell, and the verify path costs users nothing.
All payments run over x402 (CDP facilitator, gasless for the agent); all data is
on-chain and independently checkable.

- https://www.npmjs.com/package/plugin-gblin
- https://gblin.digital/.well-known/x402
- https://gblin.digital/.well-known/agent-card.json

Happy to write the showcase copy to your format.

---

## 5. Yield Pilot / Stable-Up-style vault copilots

**Subject:** Show your users the on-chain risk regime before they deposit

Hi — your copilot routes deposits across Base yield; our protocol publishes the
missing context for that decision: a live BTC/ETH risk regime (calm / elevated /
crash), computed on-chain from Chainlink price drawdown on Base and readable by
any agent for free, with a signed attestation at $0.003 via x402.

The concrete ask: show the current regime on your allocation screen, and require
a fresh GBLIN Risk Attestation (10-minute TTL, EIP-712-signed, free to verify
via our MCP server) before high-risk moves. Users see a plain, independent
signal; your agents get a "risk-managed" badge they can actually prove. You run
no oracle and maintain no model — verification is one free call.

- https://gblin.digital/.well-known/x402
- https://gblin.digital/.well-known/agent-card.json
- https://www.npmjs.com/package/@gblin-protocol/mcp-server

Reference integration is ~10 lines; happy to share it.
