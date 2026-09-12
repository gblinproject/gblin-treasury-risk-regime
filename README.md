# GBLIN MCP Server

> **Market risk regime and treasury tools for AI agents on Base mainnet.** A Model Context Protocol (MCP) server that answers two questions an autonomous agent has to ask before it moves money:
>
> 1. **Is the market risk-off right now?** Read the live regime — `calm` | `elevated` | `crash` — derived from an on-chain Crash Shield. **Free, no API key, no wallet.** If you need to prove to a counterparty that you checked, buy a signed EIP-712 **risk attestation** as portable proof-of-diligence.
> 2. **Where does idle USDC sit between jobs?** In GBLIN, a collateral-backed cbBTC/WETH/USDC index that mints and redeems at NAV, with a Just-In-Time swap back to USDC the millisecond the agent needs to pay an [x402](https://docs.cdp.coinbase.com/x402/welcome) invoice. No lockup, unsigned calldata only — your wallet signs, we never hold keys.

[![npm](https://img.shields.io/npm/v/@gblin-protocol/mcp-server.svg)](https://www.npmjs.com/package/@gblin-protocol/mcp-server)
[![CI](https://github.com/gblinproject/gblin-treasury-risk-regime/actions/workflows/ci.yml/badge.svg)](https://github.com/gblinproject/gblin-treasury-risk-regime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Base Mainnet](https://img.shields.io/badge/network-Base%20mainnet-0052FF)](https://basescan.org/address/0x36C81d7E1966310F305eA637e761Cf77F90852f0)
[![Governance: 48h Timelock](https://img.shields.io/badge/governance-48h%20Timelock-1f6feb)](https://basescan.org/address/0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd)
[![Base MCP Plugin](https://img.shields.io/badge/Base%20MCP-PR%20%2356-blue)](https://github.com/base/skills/pull/56)
[![x402 Manifest](https://img.shields.io/badge/x402-manifest-green)](https://gblin.digital/.well-known/x402)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-Active-success)](https://registry.modelcontextprotocol.io)
[![Glama Score](https://img.shields.io/badge/Glama-100%25-brightgreen)](https://glama.ai/mcp/servers/gblinproject/GBLIN-MCP)
[![Smithery](https://img.shields.io/badge/Smithery-gblin--protocol-orange)](https://smithery.ai/servers/gblin-protocol/mcp)

📖 **Full documentation and Quick Start:** [gblin.digital/agents](https://gblin.digital/agents)

⚡ **Copy-paste starter examples:** [`examples/`](examples/) — [ElizaOS](examples/elizaos.md) · [AgentKit / TypeScript](examples/agentkit.ts) · [Claude / any MCP client](examples/claude.md) — each with the recommended treasury-policy system prompt and safe-default security env.

▶️ **Runnable full-cycle demo** (read-only, no keys): `npx tsx examples/full-cycle.ts` — live against Base: treasury state → risk regime → attestation verified offline → invest calldata → JIT redemption calldata. [Source](examples/full-cycle.ts).

🌐 **Hosted MCP (Streamable HTTP, no install):** `https://gblin-mcp.gblin-mcp-worker.workers.dev/mcp` — **8 free tools** in a dot-notation tree, no auth, no session: `risk.regime`, `risk.attestation_sample`, `protocol.stats`, `protocol.info`, `coherence.report`, plus AI Action Receipts (`receipts.seal` demo 5/day/IP, `receipts.get`, `receipts.verify` — pure-math verification, no trust in this server). Two prompts: `risk_gate`, `seal_and_verify`. The pre-rename flat names still work as unlisted aliases until 2026-11-21. Docs are **MCP resources**, not tools: `gblin://howto/attestation`, `gblin://howto/seal`, `gblin://limits`, `gblin://keys` (verifier keys + key-rotation policy). Nothing is paid over MCP.
> **GET-only audit** (for reviewers and clients that cannot POST): [`/meta`](https://gblin-mcp.gblin-mcp-worker.workers.dev/meta) (counts + `manifest_hash`) · [`/tools.json`](https://gblin-mcp.gblin-mcp-worker.workers.dev/tools.json) · [`/resources.json`](https://gblin-mcp.gblin-mcp-worker.workers.dev/resources.json) · [`/conformance`](https://gblin-mcp.gblin-mcp-worker.workers.dev/conformance) · [`/v1/verify/:index`](https://gblin-mcp.gblin-mcp-worker.workers.dev/v1/verify/0) (per-check booleans + on-chain anchor consistency).
> This hosted surface is **deliberately different** from the npm stdio package below (13 tools, treasury/governance included). Also on [Smithery](https://smithery.ai/servers/gblin-protocol/mcp). Source in [`worker/`](worker/).

---

## ElizaOS Plugin

For agents running on **ElizaOS**, install the companion plugin — now listed in the **official ElizaOS plugin registry** (v0.4.0, security-hardened):

```bash
npm install plugin-gblin
# or: elizaos plugins add gblin
```

It exposes four native Actions (`CHECK_GBLIN_TREASURY_HEALTH`, `INVEST_IDLE_USDC_GBLIN`, `RESCUE_USDC_FROM_GBLIN`, `GET_GBLIN_RISK_ATTESTATION`) and a Provider that injects live NAV + Crash Shield status into the agent context on every loop.

→ [Full Eliza plugin docs](https://github.com/gblinproject/GBLIN_PLUGIN)

---

## AI Action Receipts — a witnessed transparency log for what your agent did

The problem this attacks is the #1 barrier to AI adoption in 2026: **nobody can
prove, after the fact, exactly what an AI did** (surveys: workers burn 2–4 h/week
verifying AI output; 70% of orgs say they cannot govern their agents). Our answer
is the smallest honest primitive: a public, append-only **RFC 6962 transparency
log** for AI actions. Input and output go in as **hashes only** (never content);
the short `action` label, `agent_id`, `tool` and `meta` strings you send are
published in the public log — put identifiers there, never secrets. You get back
a portable receipt any third party can verify offline, forever.

```
receipt = canonical payload
        + Ed25519 signature            (key: gblin.digital/receipts-log)
        + RFC 6962 inclusion proof     (leaf → Merkle root)
        + C2SP signed checkpoint       (origin, tree size, root)
```

Canonicalization is frozen as **`gblin-canonical-json/1`**: object keys sorted by
UTF-16 code unit, no whitespace, `JSON.stringify` semantics for primitives,
recursion for objects/arrays. Test vector: payload `{"b":1,"a":null}` →
canonical `{"a":null,"b":1}` → leaf = `SHA256(0x00 || canonical_bytes)`. The
receipt signature is Ed25519 over `"gblin-receipt/v1\n" + canonical`.

- Seal (paid, unlimited): `POST https://gblin.digital/api/x402/seal` — $0.01 USDC via x402.
- Seal (demo, 5/day/IP): `POST <worker>/v1/seal-demo` or hosted MCP tool `receipts.seal` (verify with `receipts.verify`).
- Read free forever: `<worker>/v1/receipt/:index` · `/log` · `/log/checkpoint` · `/log/proof/:index` · human page `/receipt/:index`.
- Daily EAS anchor on Base of the tree root (verifiable on base.easscan.org, schema `0x9f433a96…`, promiseId `keccak256("gblin-receipts-log")`).
- **Offline verifier, zero dependencies:** [`verify-receipt.mjs`](./verify-receipt.mjs) — `node verify-receipt.mjs receipt.json`.

A seal proves **existence and time** in a signed append-only log whose root is
anchored daily on Base. The checkpoint is currently signed by the log operator
(us); **independent witness cosigning is an open invitation** — we already
cosign a third-party transparency log (C2SP tlog-witness) and will list any
witness that cosigns ours. Until then, honest wording: operator-signed, chain-anchored.
It is **not** a compliance certificate and **not** an endorsement of the content.
Worker: `<worker>` = `https://gblin-mcp.gblin-mcp-worker.workers.dev`.

## Coherence Proof — verify GBLIN keeps its promises

GBLIN pre-registers hash-pinned public promises, then runs an automaton that probes them every 10 minutes and seals each closed day as an [EAS attestation](https://base.easscan.org/schema/view/0x9f433a96467ab75530009970e5aa938ec94d8a49f08f66e7381822d557b448ef) on Base. Reading is free forever; the paid service is being observed — the certifier submits itself to its own instrument first.

- **Free report:** [`/coherence`](https://gblin-mcp.gblin-mcp-worker.workers.dev/coherence) (JSON) or the hosted MCP tool `coherence.report`.
- **Live promises:** P1 (uptime of the paid Risk Attestation endpoint) and P2 (honesty of the public agent-economy counters, with our own wallets disclosed and excluded).
- **On-chain:** each closed day is sealed as an EAS attestation on Base by a dedicated observer wallet. GBLIN is a discoverable ERC-8004 agent (#59286).

---

## AI assistant discovery — `gblin-init`

Drop an `AGENTS.md` treasury policy into your repo so every modern AI coding
assistant (Claude Code, Cursor, Windsurf, GitHub Copilot, Codex) automatically
discovers GBLIN when it works on your codebase:

```bash
npx -p @gblin-protocol/mcp-server gblin-init
```

The command is **idempotent and safe**:

- If `AGENTS.md` does not exist → creates it from the canonical template at
  [`gblin.digital/AGENTS.template.md`](https://gblin.digital/AGENTS.template.md).
- If `AGENTS.md` exists → appends a clearly delimited GBLIN block at the
  bottom; your own content is never touched.
- Re-running is a no-op (detected via stable HTML markers).
- `--dry-run` prints what it would do without writing.
- `--force` refreshes the block to the latest version.

It also runs offline thanks to a bundled fallback template.

### Postinstall hint

When the package is installed as a regular dependency (`npm i @gblin-protocol/mcp-server`),
a short tip is printed once suggesting the command above. **No files are
written** during postinstall — security-friendly and Socket-compliant. Set
`GBLIN_SKIP_HINT=1` to silence it.

---

## Trust & Governance

**GBLIN V6 is governed by a 48h Timelock Controller** — every admin operation (parameter change, oracle update, ownership transfer) is enforced on-chain to wait **172,800 seconds** before execution. Agents and integrators can verify this directly on BaseScan.

| Component | Address | Role |
|---|---|---|
| **GBLIN V6 token** | [`0x36C81d7E...52f0`](https://basescan.org/address/0x36C81d7E1966310F305eA637e761Cf77F90852f0) | Index contract (production) |
| **Timelock Controller** | [`0x6aBeC8716...8e5Dd`](https://basescan.org/address/0x6aBeC8716fFeEcf7C3D6e68255b4797113E8e5Dd) | 48h immutable delay, 14d grace period |
| **Ownership transfer tx** | [`0xb653f54f...edaaf`](https://basescan.org/tx/0xb653f54ffa9b1764b41932e6a411077e7e34550605303f15d90900de682edaaf) | Transferred at block 46160610 |

Properties enforced at the contract level:
- `MIN_DELAY` is **immutable** (override of `updateDelay` reverts permanently)
- `PROPOSER_ROLE` and `CANCELLER_ROLE` are **strictly separated** (constructor reverts on overlap)
- `EXECUTOR_ROLE` is open (`address(0)`) — anyone can execute a matured operation, anti-censorship
- The timelock is **self-administered**: every role/config change must itself go through the 48h delay

This is why the `get_governance_state` tool returns `owner_is_timelock: true` and a verifiable `min_delay_seconds: 172800`. AI agents can use these flags to gate trust-sensitive actions.

---

## Why this exists

AI agents today hold their working capital in **USDC**. USDC sits flat: zero yield, full inflation exposure.

**GBLIN** is an on-chain index on Base (45% cbBTC + 45% WETH + 10% USDC) with an algorithmic Crash Shield that adaptively reduces risk-asset exposure as drawdown rises (V6 adaptive threshold, from ~15%). GBLIN is managed crypto exposure with capped drawdown — a calmer way to hold BTC/ETH risk for **surplus** capital, not a substitute for USDC (it can still lose value in a crash). Agents settle x402 invoices instantly via Just-In-Time GBLIN→USDC redemption.

This server exposes that capability to any LLM agent through the standard MCP protocol.

---

## Quick start

### Claude Desktop

Add to `claude_desktop_config.json` (on Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

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

Restart Claude Desktop. The 13 GBLIN tools appear in the tool picker.

### Windsurf / Cursor

Add to `~/.codeium/windsurf/mcp_config.json` (Windsurf) or the equivalent Cursor MCP config:

```json
{
  "mcpServers": {
    "gblin": {
      "command": "npx",
      "args": ["-y", "@gblin-protocol/mcp-server"],
      "env": {
        "GBLIN_RPC_URL": "https://base-rpc.publicnode.com"
      }
    }
  }
}
```

Refresh MCP servers from the IDE settings (or restart). The tools become callable inline.

### Coinbase AgentKit (TypeScript)

```ts
import { MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@gblin-protocol/mcp-server"],
});
const client = new MCPClient({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// List tools
const { tools } = await client.listTools();

// Quote a JIT payment of $0.50
const jit = await client.callTool({
  name: "swap_gblin_to_usdc_jit",
  arguments: { usdc_needed: "0.50", wallet_address: "0xYourAgent..." },
});
```

### ElizaOS / custom

Any framework that speaks MCP over stdio works:

```bash
npx @gblin-protocol/mcp-server
```

Also supports Cline, Continue.dev, and any agent that implements the MCP client spec.

---

## The 13 tools (npm stdio package)

### Free tools (no payment required)

| Tool | Purpose |
|---|---|
| `get_treasury_state` | NAV in USD + basket composition + Crash Shield status |
| `quote_safe_swap` | Preview buy or sell with dynamic slippage buffer |
| `swap_gblin_to_usdc_jit` | **The x402 magic**: generate two-step GBLIN→USDC calldata (free) |
| `invest_usdc_to_gblin` | Convert USDC earnings into GBLIN treasury (MEV-safe) (free) |
| `get_governance_state` | Verify owner == 48h Timelock + pending asset proposals + min delay |
| `share_skill_with_peer` | Generate a portable skill seed to onboard a peer agent + embedded referral code |
| `verify_risk_attestation` | Verify a peer's **Risk Attestation** (perishable proof-of-diligence): integrity + EIP-712 signature + freshness + live drift (free) |

### More free tools

| Tool | Purpose |
|---|---|
| `get_market_risk_regime` | **Start here**: BTC/ETH risk regime (calm/elevated/crash) + severity + risk posture, from the on-chain Crash Shield — free, no key |
| `analyze_treasury_health` | Balances + gas + runway + rebalance advice |
| `find_keeper_bounty` | **GBLIN pays you**: check if a rebalance bounty is available (no capital required, you only pay gas) |

> **Risk Attestation** — mint a perishable (10-minute), verifiable proof of the current BTC/ETH risk regime at `GET https://gblin.digital/api/x402/attestation` ($0.003 USDC via x402). Attach it to your action as proof-of-diligence; any counterparty verifies it for free with `verify_risk_attestation`.

All tools return structured JSON. All values are quoted on-chain (NAV via `quoteSellGBLIN` × Chainlink ETH/USD, with 24h staleness guard). No mock data.

**Live verification:** the test suite (`npm test`) runs the tool suite against Base mainnet and confirms calldata generation, oracle freshness, slippage math, and governance state. See the [latest CI run](https://github.com/gblinproject/gblin-treasury-risk-regime/actions).

---

## x402 micropayments

**Every MCP tool is free.** The MCP server never charges: it is the discovery and read layer, and it
monetizes only through the on-chain protocol fee (0.05% on mint) when an agent actually uses GBLIN.

Verifiable pay-per-call lives on the **HTTP endpoints** instead, all on Base mainnet in USDC
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), settled through the **Coinbase CDP facilitator**
via gasless EIP-3009 `transferWithAuthorization`:

| Endpoint | Price | What you get |
|---|---|---|
| `GET gblin.digital/api/x402/treasury-state` | $0.001 | NAV, basket weights, Crash Shield status |
| `GET gblin.digital/api/x402/quote` | $0.001 | Safe swap preview with dynamic slippage |
| `GET gblin.digital/api/x402/governance` | $0.001 | Owner = 48h timelock, pending operations |
| `GET gblin.digital/api/x402/health` | $0.002 | Wallet balances, gas runway, rebalance advice |
| `GET gblin.digital/api/x402/invest` | $0.002 | Unsigned calldata: USDC → GBLIN |
| `GET gblin.digital/api/x402/jit` | $0.005 | Unsigned calldata: GBLIN → USDC just in time |
| `GET gblin.digital/api/x402/attestation` | $0.003 | Signed EIP-712 **risk attestation** (10-minute proof-of-diligence) |

Machine-readable manifest: `https://gblin.digital/.well-known/x402`. Recommended clients: `@x402/fetch`
or `@x402/axios` (x402 v2 — they handle the 402 challenge, the signature and the retry for you).
The MCP tool `verify_risk_attestation` checks any attestation offline, for free.

**Payment recipient**: `0x0ebA5d314F4f5Dcb7A094953Fa9311a45172dd1B` (GBLIN fee wallet).

---

## Architectural decisions

### Deterministic two-step JIT (V6)

GBLIN V6 removed the old `sellGBLINForToken` single-tx path. The JIT flow is now **two deterministic transactions**: (1) `sellGBLINForEth(amount, minEthOut)` burns GBLIN and redeems the basket to ETH with oracle-anchored minOut; (2) a single WETH→USDC swap on Uniswap V3 with its own minOut. The MCP returns both steps as ready-to-broadcast calldata (`steps[]`).

The MCP returns calldata that works identically on:
- **EOA wallets** (Privy, MetaMask, raw private key)
- **ERC-4337 smart accounts** (Safe, Coinbase smart account)
- **EIP-7702 delegated EOAs** (Pectra+)

### Dynamic slippage

Slippage tolerance scales with on-chain risk regime:

| Condition | Buffer |
|---|---|
| Normal market | **2.5%** |
| Crash Shield active (≥1 basket asset slashed) | **4.0%** |

The buffer is applied on top of the contract's internal `maxInternalSlippage` (200 bps), absorbing oracle drift and Uniswap pool variance.

### MEV protection

`invest_usdc_to_gblin` **never** passes `minOut = 0`. Both `minWethOut` and `minGblinOut` are computed from on-chain quotes plus the dynamic slippage buffer. This eliminates the sandwich-attack surface that plagues naïve buy-with-token tools.

### Cooldown enforcement

The contract enforces a 120-second sell lock after each buy. The JIT tool reads `lastDepositTime` and the **on-chain `block.timestamp`** (never `Date.now()`) and returns a clear `CooldownActive` error with the exact seconds remaining if the swap would revert.

---

## Configuration

The server reads `GBLIN_RPC_URL` from the environment. With no env var it falls back to `https://base-rpc.publicnode.com` (free, no key, generous limits).

For production load (>100 concurrent agents) use a dedicated provider:

```bash
export GBLIN_RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
npx @gblin-protocol/mcp-server
```

See `.env.example` for the full list.

---

## Development

```bash
git clone https://github.com/gblinproject/gblin-treasury-risk-regime
cd GBLIN-MCP
npm install
npm run build
npm test         # live read-only smoke test against Base mainnet
npm start        # run the compiled server
```

Project layout:

```
src/
  config.ts    # network constants, addresses, slippage params
  abi.ts       # GBLIN_V6 + Chainlink + ERC-20 ABIs
  client.ts    # viem PublicClient + on-chain timestamp helper
  helpers.ts   # NAV, basket state, slippage, cooldown, reverse quote
  keeper.ts    # keeper bounty finder (incentivizedRebalance math)
  tools.ts     # the 10 treasury tool implementations + zod schemas (receipts.ts adds 3)
  index.ts     # MCP stdio server entry
scripts/
  test.ts      # live smoke test
```

---

## Security notes

- The server is **read-only**. It never holds, signs, or broadcasts.
- All quotes are derived from on-chain calls + Chainlink oracles. Stale or negative oracle answers cause the tool to abort with `OracleStale` / `OracleDead`.
- The agent's wallet is the sole signer. Calldata returned by tools is plain ABI-encoded bytes — review before broadcasting in untrusted environments.
- No telemetry, no analytics, no remote dependencies beyond the configured RPC.

---

## Roadmap

- **v0.2**: Uniswap V3 QuoterV2 integration for sub-1% slippage precision
- **v0.3**: Permit2 support (skip the approve step for x402 reinvestment)
- **v0.4**: Streamable HTTP transport for hosted multi-agent setups
- **v1.0**: Audited contract integration + remote-only deployment guide

---

## Links

- **Contract**: [0x36C81d7E19…52f0](https://basescan.org/address/0x36C81d7E1966310F305eA637e761Cf77F90852f0)
- **Protocol site**: https://gblin.digital
- **Agent docs**: https://gblin.digital/agents
- **Issues**: https://github.com/gblinproject/gblin-treasury-risk-regime/issues

MIT © 2026 GBLIN Protocol

## Agent-to-Agent Skill Propagation (v0.1.9+)

GBLIN MCP includes a unique tool — `share_skill_with_peer` — that lets one AI agent transfer treasury management capabilities to another agent.

When agent A meets agent B in a multi-agent context (delegated task, x402 payment flow, shared workspace), agent A can call `share_skill_with_peer` to generate a portable JSON "skill seed". The seed contains:

- Install instructions for the GBLIN MCP server
- A working transaction example with reference TX on Basescan
- Agent A's referral code (derived from its wallet)
- The full natural-language explanation of GBLIN

Agent B can install the server in seconds using the seed. From that moment, every GBLIN transaction agent B executes includes agent A's referral code in the calldata via ERC-8021 Builder Code (`bc_gbdo32j0`). A small portion of the protocol fee (0.05% of transaction value) is redirected to agent A's wallet — sourced from the existing protocol fee split, not added on top.

This creates a viral propagation mechanism for treasury skills across the agent ecosystem, while economically rewarding agents who evangelize good treasury practices.

No additional infrastructure is required. The mechanism is entirely on-chain via the existing Builder Code system.

## Keeper Bounty System (v0.1.11+)

GBLIN is one of the few protocols that **pays AI agents** instead of charging them.

When the treasury pool drifts from its target allocation, any agent can call `find_keeper_bounty` to check if a profitable rebalance is available. If one exists, the tool returns ready-to-send calldata. The agent broadcasts the transaction and receives the **on-chain bounty** from the protocol's stability fund — the swap uses the contract's own capital; the caller only pays gas (~$0.01 on Base).

The bounty is set by the contract, not by this tool, and the tool reads the rules live: **0.05% of the rebalanced ETH value** (`incentiveBps`, doubled when the recent volume window is full), **floor 0.00005 ETH** (`minBounty`), **cap 0.01 ETH** (`maxBounty`), paid **at most once per hour** (`bountyInterval`) and **only while the stability fund covers it** — otherwise the rebalance still executes and pays nothing. The tool therefore reports `rewardGate` (`open`, `interval-active`, `fund-insufficient`) and only says `bountyAvailable: true` when the reward would actually be paid.

```json
// Example response when a bounty is available
{
  "bountyAvailable": true,
  "swapExecutable": true,
  "rewardGate": "open",
  "direction": "WETH->asset",
  "estimatedRewardEth": "0.00005",
  "effectiveBps": "5",
  "minBountyEth": "0.00005",
  "maxBountyEth": "0.01",
  "target": "0x36C81d7E1966310F305eA637e761Cf77F90852f0",
  "calldata": "0x...",
  "value": "0",
  "note": "Send this calldata to earn the reward. The swap uses the contract's own funds."
}
```

For continuous income, poll `find_keeper_bounty` on an interval (e.g. every 5–15 minutes). A live keeper leaderboard is at [gblin.digital/keepers](https://gblin.digital/keepers).

## Discovery & Trust

GBLIN exposes machine-readable discovery files for AI agents and protocols:

- **Coinbase x402 Bazaar:** all 11 GBLIN endpoints (7 webapp + 4 Sentinel) are indexed in the [CDP Bazaar discovery layer](https://docs.cdp.coinbase.com/x402/bazaar) — agents find them via semantic search (`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=treasury+risk`) or by merchant (`.../discovery/merchant?payTo=0x0ebA5d314F4f5Dcb7A094953Fa9311a45172dd1B`)
- **x402 Manifest:** https://gblin.digital/.well-known/x402 — full list of paid endpoints with prices, chain ID, and currency
- **LLM Discovery:** https://gblin.digital/api/x402/llms.txt — human-readable protocol summary (free, no paywall)
- **Base MCP Plugin:** [PR #56 on base/skills](https://github.com/base/skills/pull/56) — official integration in review

The MCP server in this repo provides the same operations as the x402 HTTP endpoints, but exposed via the Model Context Protocol for direct agent integration (Claude Desktop, Cursor, Windsurf, ElizaOS, etc.).

## GBLIN Sentinel — x402 Data Agent Example

[GBLIN Sentinel](https://gblin-sentinel.vercel.app) is an open-source reference implementation of an autonomous AI agent that **sells** on-chain data via x402 micropayments. It demonstrates the full x402 producer pattern on Base.

| Endpoint | Price | Data |
|---|---|---|
| `/api/data/base-risk-pulse` | $0.002 USDC | Chainlink risk signal: `normal`/`caution`/`risk-off` for ETH, BTC, USDC |
| `/api/data/gblin-analytics` | $0.002 USDC | GBLIN treasury state, basket weights, keeper availability |
| `/api/data/keeper-opps` | $0.002 USDC | Live keeper bounty check with MCP tool reference |
| `/api/data/risk-pulse-pro` | $0.03 USDC | **Flagship**: actionable recommendation (invest/hold/reduce/defer) + confidence + suggested allocation |

Discovery:
- x402 manifest: https://gblin-sentinel.vercel.app/.well-known/x402
- LLM reference: https://gblin-sentinel.vercel.app/llms.txt
- Source: https://github.com/gblinproject/gblin-sentinel

Any agent using this MCP server can call `base-risk-pulse` before investing to gate treasury actions on current market risk signal.

## GBLIN Aureus — Autonomous Trading Agent (Track-Record Engine)

[Aureus](https://gblin.digital/aureus) is an autonomous catalyst & rotation agent that trades crypto, equities, indices and metals on Base — and **cannot lie about its results**: every thesis is keccak-hashed and committed on-chain *before* the agent acts, then revealed at close. Win or lose, the record is permanent and independently verifiable. No cherry-picked screenshots.

**Status: DRY-RUN validation.** Aureus runs the full loop on live market data with zero real funds. It graduates to real capital only if it passes a public gate: 30–50 closed trades, profit factor > 1.3, max drawdown < 10%, zero liquidations. The live dashboard publishes every metric in real time: [gblin.digital/aureus](https://gblin.digital/aureus).

Under the hood (the boring parts that keep capital alive):

- **Risk engine**: volatility-targeted sizing, stops always inside the liquidation distance, mark-to-market equity with automatic drawdown halt, 10-second stop watcher
- **Multi-venue funding carry**: delta-neutral funding harvest confirmed across Binance/Bybit/OKX medians, with persistence gating (regimes, not single prints)
- **Multi-timeframe alignment**: fast mean-reversion signals are gated by the daily trend (time-series momentum, the most documented edge in finance)
- **Microstructure eyes**: taker-flow (CVD) and order-book imbalance veto entries the tape opposes
- **Shadow book**: every rejected strategy keeps paper-trading on live data; capital allocation follows statistical proof, never opinion
- **News sentinel**: a multi-LLM consensus ensemble (6 independent providers) reads verified headlines into a risk signal — the math decides every entry, the LLMs only modulate

Aureus is also a planned GBLIN treasury user: idle capital parks in GBLIN via this MCP server and JIT-swaps to USDC when margin is needed — the agent eating the protocol's own cooking.

- **Live dashboard:** https://gblin.digital/aureus
- **Announcement:** [@GBLIN_Protocol on X](https://x.com/GBLIN_Protocol/status/2065196097207685240)

## Related Repositories

- **Smart Contract & Protocol:** https://github.com/gblinproject/GBLIN-Protocol
- **Web App & x402 Endpoints:** https://github.com/gblinproject/GBLIN_WEBAPP
- **ElizaOS Plugin:** https://github.com/gblinproject/GBLIN_PLUGIN
- **GBLIN Sentinel (x402 data agent):** https://github.com/gblinproject/gblin-sentinel
- **GBLIN Aureus (autonomous trading agent):** https://gblin.digital/aureus — dry-run validation, on-chain commit-reveal track record
