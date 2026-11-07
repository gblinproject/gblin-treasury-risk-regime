# MCP Paywall Template

A minimal Model Context Protocol server with an x402 paywall and an optional GBLIN treasury check. MIT-licensed starting point for paid MCP tools.

## What it does

1. Exposes a sample tool (`expensive_query`) that requires a USDC payment on Base via x402.
2. Reads the x402 payment payload from the `_payment` tool argument, verifies it with the facilitator
   (`/verify`), settles it (`/settle`) and runs the tool only after a successful settlement. A payload
   is accepted once; any facilitator error fails closed.
3. Optionally reads the recipient's USDC balance after a paid call and logs a treasury suggestion to
   stderr. It never moves funds.

This is a reference template. Review `src/paywall.ts`, choose the facilitator you trust
(`X402_FACILITATOR_URL`) and test with small amounts before production use. The replay check kept in
memory covers one process; several instances need a shared store.

## Quick start

```bash
git clone <this-repo>
cd mcp-paywall-template
npm install
cp .env.example .env
# Edit .env with your RECIPIENT_WALLET
npm run dev
```

## Add to an MCP client

```json
{
  "mcpServers": {
    "my-paywalled-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-paywall-template/dist/index.js"],
      "env": {
        "RECIPIENT_WALLET": "0xYourWallet"
      }
    }
  }
}
```

## Adding your own tools

1. Open `src/index.ts`
2. Add a new tool registration:

```typescript
server.registerTool(
  'my-tool',
  {
    title: 'My Tool',
    description: 'What this tool does',
    inputSchema: { /* zod schema */ },
  },
  requirePayment('0.05', async (args) => {
    // Your tool logic here
    return { content: [{ type: 'text', text: 'Result' }] };
  }, 'mcp://tool/my-tool')
);
```

## License

MIT. Fork freely.

## Related

- GBLIN MCP server: https://github.com/gblinproject/gblin-treasury-risk-regime
- x402 spec: https://www.x402.org
- Skills for treasury patterns: see `../../skills/`
