---
name: gblin-agent-treasury
description: "Run a self-custody treasury for an AI agent on Base with the gblin-treasury CLI: keep operating cash in USDC, park the surplus in GBLIN (an on-chain cbBTC/WETH/USDC index with a crash-shield rule), refill USDC from GBLIN just in time, and pay x402 invoices with automatic refill. Use whenever the user mentions idle USDC, agent treasury, parking or investing surplus, running out of USDC for x402 payments, refilling USDC, treasury status, reserve, runway, or paying an x402 endpoint from a treasury."
user-invocable: true
disable-model-invocation: false
allowed-tools: ["Bash(npx @gblin-protocol/agent-treasury@0.1.0 *)", "Bash(npm *)", "Bash(node *)", "Bash(curl *)"]
---

# GBLIN Agent Treasury

Operate the treasury through the `gblin-treasury` CLI (`npx @gblin-protocol/agent-treasury@0.1.0`). This skill is a router: read the reference in `references/` for the task at hand before acting.

The policy in one sentence: operating cash stays in USDC, the surplus above the reserve is parked in GBLIN, and USDC is pulled back from GBLIN just in time when a payment needs it. GBLIN is a volatile index, not a stablecoin substitute.

## Preflight

Every command except a read-only `status` needs the agent's private key in `GBLIN_AGENT_PRIVATE_KEY`. Check the state first:

```bash
npx @gblin-protocol/agent-treasury@0.1.0 status --json
```

If it fails with `GBLIN_AGENT_PRIVATE_KEY must be…`, read `references/setup.md`.

## Routing

| Task | Reference |
| --- | --- |
| Configure the wallet key, the RPC endpoint and the policy (reserve, caps, risk gate) | `references/setup.md` |
| Balances, NAV, surplus, regime, cooldown, "can I park now" | `references/status.md` |
| Park idle USDC above the reserve into GBLIN | `references/park.md` |
| Make sure the wallet holds N USDC, refilling from GBLIN if short | `references/ensure-usdc.md` |
| Pay an x402 endpoint from the treasury, with automatic refill and a price cap | `references/pay.md` |
| Use the treasury from TypeScript (viem, AgentKit, any wallet provider) instead of the CLI | `references/library.md` |

## Shared rules

- **Input validation**: amounts must match `^\d+(\.\d+)?$`; URLs must start with `https://` or `http://` and contain no spaces, semicolons, pipes, backticks or `$`; `--max-amount` must match `^\d+$` (atomic USDC units, 1000000 = 1 USDC). Do not pass unvalidated user input into a command.
- **JSON output**: every command supports `--json`; read `action`, `reason` and `txHashes` from it.
- **Refusals are answers**: `park` returning `action: "none"` and `ensure-usdc` failing on the cooldown are the policy working, not errors to retry blindly. Report the `reason`.
- **Money moves on Base mainnet**: every `park`, `ensure-usdc` and paid `pay` sends real transactions from the agent's wallet. Show the user the amounts before acting when the instruction did not already fix them.
- **Never** print the private key, and never place it in a command line: it is read from the environment only.
