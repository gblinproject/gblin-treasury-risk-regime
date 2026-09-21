# Require a GBLIN Risk Attestation — partner one-pager

**For:** agent frameworks, vaults, agent marketplaces, keeper networks, and any
service that accepts actions from autonomous agents on Base.

**The ask (one line):** require agents to attach a *fresh GBLIN Risk Attestation*
before you accept a capital-moving action. You verify it in one free call. This
gives your users an independent, uniforgeable "did the agent check market risk?"
gate you didn't have to build.

---

## Why you'd want this

Autonomous agents move capital with no standard proof they checked market
conditions first. Operators and counterparties have no way to tell a careful agent
from a reckless one — until after a loss. A **Risk Attestation** is a portable,
verifiable receipt: *"at block N, the on-chain BTC/ETH regime was X; this agent saw
it before acting."*

- **Independent** — derived from GBLIN's on-chain Crash Shield (Chainlink-oracle
  drawdown on Base), not from the agent's own say-so.
- **Uniforgeable** — EIP-712 signed (or tamper-evident by recomputable id). You
  recover the signer; the agent can't fake a `calm` reading.
- **Perishable** — 10-minute TTL, so "I checked last week" doesn't count. Fresh
  every cycle.
- **Zero cost to you** — verification is a free MCP tool / a single `ecrecover`.

## How you integrate (≈10 lines)

```ts
// 1. Require the attestation on the inbound action.
if (!action.attestation) return reject("Attach a GBLIN risk attestation.");

// 2. Verify it (free). Either the MCP tool or a direct EIP-712 recover.
const v = await verify_risk_attestation({ attestation: action.attestation });
if (!v.valid || v.checks.expired) return reject("Stale or invalid attestation.");

// 3. (Optional) act on the regime — tighten limits in a crash.
if (action.attestation.attestation.regime === "crash") {
  applyReducedLimits();           // smaller size, wider slippage, or defer
}
return accept();
```

That's it. No new infra, no oracle to run, no risk model to maintain.

## What each side gets

| You (the partner) | Your users / agents | GBLIN |
|---|---|---|
| A safety gate + audit trail, free | A visible "risk-managed" credential they can show operators | Recurring paid mints (the flywheel) |
| Differentiation vs platforms with no risk gate | An independent check they didn't have to build | Distribution into your workflow |

## Reference integration

- Verify (free): `verify_risk_attestation` in `@gblin-protocol/mcp-server`, or
  recover the EIP-712 struct directly (domain `GBLIN Risk Attestation` version 2,
  chainId 8453, verifyingContract `0xc2181d975c05c8c724b334bcED0764c0b86B1D53`;
  attestations issued under version 1 carried `0x36C81d7E1966310F305eA637e761Cf77F90852f0`).
  The response embeds its own domain under `eip712`, so a verifier that reads it
  from there needs no hard-coded value.
- Mint (agent side, $0.003 USDC): `GET https://gblin.digital/api/x402/attestation`
- Machine index: `https://gblin.digital/api/x402/llms.txt`

## Honest framing

The attestation certifies the on-chain risk regime at issuance — verifiably. It is
not a prediction and not financial advice, and a `calm` reading is not a guarantee.
It is a transparent, tamper-evident check an agent can be *held to*. That is exactly
what a counterparty gate needs: not a promise the market is safe, but proof the
agent looked.

## First partners to approach

- **Agent frameworks** (ElizaOS plugins, Coinbase AgentKit actions) — ship it as an
  optional "risk gate" middleware; agents opt in for the credential.
- **Base vaults / lending** that take agent deposits — better terms for agents that
  attach a fresh attestation.
- **Keeper / automation networks** — require it before executing agent-submitted jobs.
- **Agent marketplaces** — surface a "risk-managed" badge for listed agents that gate on it.
