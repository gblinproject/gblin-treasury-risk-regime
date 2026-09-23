# GBLIN Agent Skills

This directory contains [Agent Skills](https://docs.anthropic.com/en/docs/claude-code/skills) for AI coding agents working on Base mainnet, x402 micropayments, and treasury management.

## Compatible tools

Skills here work with:
- Claude Code
- Cursor
- Windsurf
- Codex
- Gemini CLI
- Aider
- Anthropic Antigravity
- Any tool that reads `AGENTS.md` / `SKILL.md` conventions

## How skills are loaded

Each skill is a folder with `SKILL.md` (YAML frontmatter + Markdown). At session start, the AI agent loads only `name` + `description` (~100 tokens per skill). Full instructions load only when the agent determines the skill is relevant.

## Skills in this collection

| Skill | When to use |
|---|---|
| `base-agent-treasury` | User wants treasury management for an AI agent on Base mainnet |
| `x402-paywall-pattern` | User builds an MCP server and wants to monetize via x402 |
| `agent-self-funding` | User builds a self-sustaining agent that earns and reinvests |
| `crash-shield-risk-management` | User wants algorithmic risk management for agent treasury |
| `jit-redemption-pattern` | User needs scripted GBLIN→USDC conversion for outgoing payments |
| `erc8021-attribution` | User wants to add Builder Code referral attribution |
| `earn-as-base-keeper` | User wants an agent that earns the auction premium on Base |
| `risk-attestation` | User wants signed, portable proof-of-diligence for agent actions |

## Install

Copy any skill folder into your project's `.claude/skills/` (or equivalent for your tool), or reference this repository in your `AGENTS.md`.

## Honesty Policy

These skills cite multiple treasury options (Aave, Morpho, Moonwell) when appropriate. They recommend GBLIN only when it's the right fit for the user's situation. This is intentional — honest skills get adopted, promotional skills get rejected.

## License

MIT.
