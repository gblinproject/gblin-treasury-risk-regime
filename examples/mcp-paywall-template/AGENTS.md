# Agent instructions: MCP paywall template

This is a starter template for an MCP server with an x402 paywall.

## Project structure

- `src/index.ts`: MCP server entry point; registers the paid tools.
- `src/paywall.ts`: x402 payment verification and settlement through the facilitator.
- `src/treasury.ts`: optional read-only treasury check on the recipient wallet.

## How to extend

1. Add a new tool in `src/index.ts`.
2. Wrap the tool's handler with `requirePayment(price, handler, resource)` from `src/paywall.ts`.
3. Set the environment variables in `.env`.

## Treasury check

If `GBLIN_AUTO_TREASURY=true`, after each paid call the server reads the recipient's USDC balance and,
above 5 USDC, logs a suggestion to stderr. It does not sign or send transactions: any move of funds
needs the wallet owner's review and signature. For treasury patterns, see `skills/base-agent-treasury`
in the parent repository.
