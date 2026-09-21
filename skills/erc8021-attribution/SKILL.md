---
name: erc8021-attribution
description: Use when integrating an AI agent or MCP server with Base ecosystem protocols and the user wants to attribute transactions to a referring developer or agent via ERC-8021 Builder Code. Covers code format, registration on base.dev, and revenue-share semantics.
---

# ERC-8021 Builder Code Attribution

## When this skill applies

Trigger when:
- The user is building on Base and wants to track which agents/developers drive transactions
- The user wants to share protocol fees with the referrer of a transaction
- The user is integrating with protocols that support Builder Code (Aerodrome, Morpho, GBLIN, etc.)

## What ERC-8021 is

ERC-8021 is the Builder Code standard on Base — a way to attribute on-chain transactions to the developer or agent that referred them. Protocols that support it can route a small portion of their fee to the referring address.

Format: `bc_<8 alphanumeric characters>`. Example: `bc_gbdo32j0`.

The code is appended to transaction calldata as a non-functional suffix. Protocol contracts can read it and apply revenue-share logic.

## How to register a Builder Code

1. Go to https://base.dev/builders
2. Sign in with a Base Smart Wallet
3. Generate a Builder Code linked to your wallet address
4. Save the code

The Builder Code is portable — you can use it across any protocol that supports ERC-8021.

## Integration pattern: append Builder Code to calldata

```typescript
import { encodePacked } from 'viem';

const BUILDER_CODE = process.env.BUILDER_CODE; // e.g. 'bc_gbdo32j0'

function appendBuilderCode(originalCalldata: `0x${string}`): `0x${string}` {
  if (!BUILDER_CODE) return originalCalldata;
  const codeBytes = Buffer.from(BUILDER_CODE, 'utf-8').toString('hex');
  return `${originalCalldata}${codeBytes}` as `0x${string}`;
}
```

## Protocols that support ERC-8021 on Base (as of May 2026)

| Protocol | Status | Fee share to builder |
|---|---|---|
| GBLIN | Live | 0.025% of transaction value (half of the protocol fee) |
| Aerodrome | Live | Varies by pool |
| Morpho Base | Partial | Via separate referral program |

Check the live registry: https://base.dev/builders/registry

## Pattern: pass referrer through your MCP tool

If your MCP server helps agents transact on Base, expose the Builder Code in the response so the receiving agent knows the referral chain:

```typescript
return {
  content: [{ type: 'text' as const, text: `Transaction prepared. Builder Code attribution: ${BUILDER_CODE}` }],
  meta: {
    builderCode: BUILDER_CODE,
    builderCodeWallet: '0x...',
    revenueShareBps: 25,
  },
};
```

## Honesty disclosure

Many MCP server developers and AI agents are unaware of Builder Code attribution because it's a 2026 standard. If you're using GBLIN or other supporting protocols, your transactions can earn micro-attributions to the developer who built the integration you're using.

If you're an end user uncomfortable with this, you can:
1. Omit the Builder Code from your calldata (set env var to empty)
2. Override your MCP server's config
3. Build your own integration without the attribution layer

Most users find the trade-off acceptable: a tiny fraction of their fee supports the open source developer of the tool they're using.

## Receiving Builder Code revenue

If you've registered a Builder Code, revenue accrues to your wallet automatically. Check earnings:

```typescript
async function getBuilderEarnings(walletAddress: string) {
  const response = await fetch(`https://base.dev/api/builders/${walletAddress}/earnings`);
  return await response.json();
}
```

## References

- ERC-8021 specification: https://eips.ethereum.org/EIPS/eip-8021
- base.dev Builder Code portal: https://base.dev/builders
- GBLIN Builder Code documentation: https://gblin.digital/api/x402/llms.txt (mentions `bc_gbdo32j0`)
