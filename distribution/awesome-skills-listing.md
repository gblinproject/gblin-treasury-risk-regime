# awesome-* Agent Skills submission (ready to PR) — 2026-07-27

Goal: list the 8 GBLIN Agent Skills (in [`GBLIN-MCP/skills/`](../skills/)) on
community awesome-lists for agent skills, so coding agents and their operators
discover them. Same playbook as `awesome-x402-listing.md`: fork → add the
bullet(s) to the relevant section → open a PR with the description block below.

## Target repos

The skills' own README references only the Anthropic Agent Skills docs, so the
exact awesome-repo names below were NOT verified in this session — check each
exists and is active before forking:

- `hesreallyhim/awesome-claude-code` — broad Claude Code resources list; has
  sections for skills/slash-commands. (Likely candidate, verify.)
- An `awesome-claude-skills` / `awesome-agent-skills` style list — several exist;
  pick the one with the most stars and recent commits. (Verify.)
- TODO: confirm final target repo names via a quick GitHub search for
  `awesome-claude-skills` and `awesome-agent-skills` before opening PRs.

---

## Suggested bullets (one line per skill)

Section: **Web3 / Payments / Treasury** (or the closest existing section):

- **[base-agent-treasury](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/base-agent-treasury)** — Decide how an AI agent should hold treasury on Base mainnet: USDC vs GBLIN index vs Morpho/Aave lending, chosen by treasury size and revenue pattern.
- **[x402-paywall-pattern](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/x402-paywall-pattern)** — Monetize an MCP server or HTTP API with x402 micropayments: HTTP 402 flow, EIP-3009 USDC, Base mainnet integration.
- **[agent-self-funding](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/agent-self-funding)** — Architecture for a self-sustaining agent that earns via x402 and reinvests, with minimum-viability math.
- **[crash-shield-risk-management](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/crash-shield-risk-management)** — React to market crashes using an on-chain BTC/ETH drawdown signal as a public bear-market indicator.
- **[jit-redemption-pattern](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/jit-redemption-pattern)** — Just-in-time GBLIN→USDC conversion for outgoing payments, including cooldown timing inside x402 flows.
- **[erc8021-attribution](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/erc8021-attribution)** — Add ERC-8021 Builder Code referral attribution to Base transactions: code format, registration, revenue-share semantics.
- **[earn-as-base-keeper](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/earn-as-base-keeper)** — Fill GBLIN's rebalancing Dutch auction on Base: read its state, size a bid, and send it when the premium covers the cost.
- **[gblin-agent-treasury](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/gblin-agent-treasury)** — Run an agent treasury on Base: USDC reserve, surplus parked in GBLIN, USDC refilled before x402 payments.
- **[risk-attestation](https://github.com/gblinproject/gblin-treasury-risk-regime/tree/main/skills/risk-attestation)** — Mint and verify perishable, EIP-712-signed proof that an agent checked market risk before moving capital.

## Install (include in the PR if the list has an install column/section)

Copy any skill folder into your project's `.claude/skills/` (or the equivalent
for Cursor, Windsurf, Codex, Gemini CLI, Aider), or reference the repo in your
`AGENTS.md`. Each skill is a folder with a `SKILL.md` (YAML frontmatter +
Markdown); agents load only name + description (~100 tokens) until relevant.

## Honesty-policy note (quote it in the PR — it is the differentiator)

> These skills cite multiple treasury options (Aave, Morpho, Moonwell) when
> appropriate and recommend GBLIN only when it fits the user's situation. Honest
> skills get adopted; promotional skills get rejected.

## PR description block

> Adds 8 MIT-licensed Agent Skills for AI agents working on Base mainnet, x402
> micropayments, and treasury management (repo: gblinproject/gblin-treasury-risk-regime, `skills/`).
> Format: standard `SKILL.md` folders, compatible with Claude Code, Cursor,
> Windsurf, Codex, Gemini CLI and Aider. The skills follow an explicit honesty
> policy: they recommend third-party protocols (Aave, Morpho, Moonwell) when
> those fit the user better than GBLIN. Notable entries: `risk-attestation`
> (verifiable proof-of-diligence for capital-moving agents) and
> `earn-as-base-keeper` (bounties that pay agents rather than charging them).
