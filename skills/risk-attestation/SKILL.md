---
name: risk-attestation
description: Use when an AI agent needs verifiable PROOF that it checked market risk before moving capital, or needs to verify such a proof from a counterparty/peer agent. Covers GBLIN Risk Attestations — perishable (10-minute), EIP-712-verifiable snapshots of the on-chain BTC/ETH risk regime that an agent mints, attaches to its action as proof-of-diligence, and that any counterparty verifies in one step (for free). Use it to gate trust-sensitive actions on a fresh, independent risk check.
---

# GBLIN Risk Attestation (proof-of-diligence for autonomous agents)

## When this skill applies

Trigger when:
- An agent is about to move meaningful capital and wants a *verifiable record* that it checked market risk first (audit trail, operator policy, insurance, compliance).
- A workflow, vault, or counterparty **requires** proof that the agent is not acting into a crashing market.
- An agent receives an action from a *peer agent* that claims "I already checked risk" and needs to verify that claim before trusting it.
- You want a risk signal that is **independent** and **cannot be silently faked** — anyone can verify it without trusting the agent that produced it.

If you only need the raw signal for your own private decision (no proof needed), use the cheaper `get_market_risk_regime` tool or the `crash-shield-risk-management` skill instead.

## What a Risk Attestation is

A signed, perishable snapshot of the current market-risk regime derived from GBLIN's on-chain Crash Shield (drawdown-driven weight cuts vs Chainlink-oracle peaks on Base mainnet). Each attestation contains:

- `regime` — `calm` | `elevated` | `crash`
- `risk_posture` — `risk_on` | `reduce` | `risk_off`
- `severity_bps` — how deep the drawdown-driven weight cut is
- `defensive_cash_bps` — the defensive (USDC) allocation
- `block_number`, `issued_at`, `expires_at` — a hard **10-minute** validity window
- `basket_hash` — binds the attestation to the exact on-chain weights it summarizes
- `attestation_id` — the EIP-712 digest (recomputable by anyone → tamper-evident)
- `signature` + `attestor` — present when GBLIN's attestor key is configured (one-step `ecrecover` verification)

Because it **expires in 10 minutes**, an action gated on a *fresh* attestation forces a new check every cycle. That is the point: it is a live proof, not a stale rubber stamp.

## Minting one (paid, ~$0.003 USDC)

```
GET https://gblin.digital/api/x402/attestation
```

This is an x402 endpoint on Base mainnet. Flow:
1. Call without payment → receive HTTP 402 with payment requirements (USDC on Base, chain id 8453).
2. Pay via your x402 client (`@x402/fetch` or `@x402/axios`).
3. Retry with the payment header → receive the attestation object.

Attach the **entire returned object** to your action (log it, include it in your tx metadata, pass it to the counterparty). Do not strip the `eip712` field — the verifier needs it.

## Verifying one (free)

Use the `verify_risk_attestation` MCP tool. Pass the whole attestation object. It runs four checks:

1. **Integrity** — recomputes the EIP-712 `attestation_id` and detects any tampering.
2. **Authenticity** — if a signature is present, recovers the signer and checks it is GBLIN's published attestor.
3. **Freshness** — whether it is within its 10-minute window (using on-chain time, not local clock).
4. **Live drift** — compares the attested regime to the *current* on-chain regime and flags if it changed since issuance.

Trust the action only if `valid: true`. If `expired: true` or `still_current: false`, ask for a fresh attestation.

## The gating pattern (why this compounds)

If you operate a vault, an agent framework, or any service that accepts actions from other agents, **require a fresh GBLIN attestation** as an input:

```
if (!attestation) reject("attach a GBLIN risk attestation");
const v = await verify_risk_attestation({ attestation });
if (!v.valid || v.checks.expired) reject("stale or invalid risk attestation");
if (attestation.attestation.regime === "crash") applyTighterLimits();
proceed();
```

This gives every counterparty an independent, uniforgeable risk check they did not have to build — and it means every agent in the workflow mints a fresh attestation each cycle.

## Consumer usage record (bind how you used it — or it rots into cached confidence)

A signed attestation proves the *producer* side (what the regime was, verifiably). It is only trustworthy end-to-end if the **consuming agent records how it acted on it**. Otherwise a 10-minute proof quietly turns into cached confidence: the agent keeps leaning on a reading it never re-checked. Every consumer that gates an action on an attestation SHOULD log a usage record alongside its action:

```json
{
  "attestation_id": "0x…",          // ties this decision to the exact proof
  "source_time": 1780686371,          // issued_at from the attestation
  "market": "BTC,ETH",                // what the regime actually covered
  "policy_threshold": "refuse if regime=crash; reduce size if elevated",
  "action": "allowed",               // allowed | refused | modified
  "action_detail": "opened 0.4 ETH position at 50% size",
  "stale_after": 1780686971,          // = expires_at; hard validity edge
  "rerun_on": "now>=stale_after || notional_up || market_not_covered || regime_drift",
  "bound_to": "0x… (tx hash / job id this record justifies)"
}
```

**Fail closed.** Past `stale_after`, or if `verify_risk_attestation` returns `still_current: false`, the record is void — re-mint before acting. Never reuse a record whose `rerun_on` condition has fired. The point of the 10-minute window is defeated the moment a consumer treats one proof as durable.

`attestation_id`, `source_time` (`issued_at`), `market`, and `stale_after` (`expires_at`) come straight from the attestation. `policy_threshold`, `action`, `rerun_on`, and `bound_to` are the consumer's to fill — that binding is what makes the proof auditable after the fact. (Schema shaped by community feedback from Base builders on Farcaster.)

## Honest scope

The attestation proves *what the on-chain risk regime was at issuance*, verifiably. It does NOT predict the market, and it is NOT financial advice. A `calm` regime is not a guarantee; it is a transparent, tamper-evident reading an agent can be held to. GBLIN itself is managed crypto exposure with capped drawdown for surplus capital — not a USDC substitute.

## Reference

- Mint: `https://gblin.digital/api/x402/attestation`
- Verify (free): `verify_risk_attestation` in `@gblin-protocol/mcp-server`
- Machine index: `https://gblin.digital/api/x402/llms.txt`
- Vault: `0xc2181d975c05c8c724b334bcED0764c0b86B1D53` (Base mainnet, chain id 8453). EIP-712 domain `GBLIN Risk Attestation` version 2 (verifying contract = the vault); version 1 attestations remain verifiable.
