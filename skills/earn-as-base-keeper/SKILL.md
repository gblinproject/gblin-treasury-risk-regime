---
name: earn-as-base-keeper
description: Use when an AI agent with a funded wallet on Base wants to act as a keeper for the GBLIN protocol. Covers how the vault's Dutch auction works, how to read its state, how to size a bid and when the premium makes it worth sending.
---

# Earn as a Base Keeper (the GBLIN auction)

## When this skill applies

Trigger when:
- An AI agent with a funded wallet is looking for keeper jobs on Base mainnet
- The user asks how an agent can earn from rebalancing a protocol
- An agent already holds cbBTC, WETH or USDC and can trade with a vault at a known price

## How the mechanism works

GBLIN is a treasury-backed index (cbBTC / WETH / USDC). The vault does not rebalance itself and pays nobody to do it. When a basket row drifts past its opening band, the vault holds a **Dutch auction**: whoever trades with it toward the target weights is the counterparty, at the Chainlink oracle price adjusted by a premium.

- The premium starts at a discount (the vault asks less than the oracle price), rises linearly to a cap over one ramp, holds at the cap for a second ramp, then starts again. At launch: opening discount 100 bps, cap 25 bps, ramp 3600 seconds.
- The bidder brings the input token: the asset when the vault buys it (the row is below target), WETH when the vault sells it (the row is above target). The vault reduces the input to what closes the gap, so a bid never pushes a row past its target.
- A bid that would change nothing reverts; there is no minimum size.
- Nothing is paid out of the vault for calling it. The premium is the whole reward.

Vault: `0xc2181d975c05c8c724b334bcED0764c0b86B1D53` · Lens: `0xfCFea8027019E8551A1f09AD91532471F5D26f61` (Base mainnet, chain id 8453)

## How to bid (step by step)

### Option A — via the GBLIN MCP server

With the server connected (`npx @gblin-protocol/mcp-server`), call:

```
get_auction_state
```

It returns `auctionOpen`, `navReliable`, the current `premiumBps`, the curve, and one entry per basket row with the side the vault takes, the gap in ETH, the input token and amount, and unsigned calldata for the approval and the bid. `best` is the row with the largest gap. If `auctionOpen` is false, every row is within its band: check again later.

Send the approval, then the bid, from your funded wallet. You receive the other side of the trade at the oracle price adjusted by the premium.

### Option B — direct on-chain

```typescript
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const VAULT = '0xc2181d975c05c8c724b334bcED0764c0b86B1D53';
const LENS = '0xfCFea8027019E8551A1f09AD91532471F5D26f61';

// 1. Lens.auctionOpenedAt(VAULT) != 0  -> an auction is open
// 2. Lens.auction(VAULT, i) for each row -> (open, premiumBps, vaultBuysAsset, gapEth)
// 3. If vaultBuysAsset: input = the asset, amount = gapEth converted at the two oracle prices
//    else:               input = WETH,      amount = gapEth
// 4. approve(input token -> VAULT, amount), then VAULT.bid(i, vaultBuysAsset, amount, minOut, "0x")
//    minOut may be 0: the price is the oracle's adjusted by the premium, fixed for the block
```

## Economics and honesty

- The reward is the premium over the oracle price, on what closes the gap: at the cap, 0.25% of the value you move. It can be negative early in the ramp (you would trade below the oracle price): bid when the premium covers your own cost.
- Auctions open only when a row has actually drifted past its band. With low protocol volume, that is intermittent, not constant.
- This is bootstrap-scale income. Treat it as one of several keeper jobs in a diversified agent income strategy.

## Automating it

Poll `get_auction_state` on an interval (every few minutes; the premium moves once a minute or so). Bid when `auctionOpen` is true, `navReliable` is true and `premiumBps` covers your gas and any cost of holding the other side.

## Refer other keepers (optional)

If your agent framework supports the GBLIN `share_skill_with_peer` tool, you can pass this skill to peer agents. Referred activity is attributed on-chain via ERC-8021 Builder Code.

## References

- Vault on Basescan: https://basescan.org/address/0xc2181d975c05c8c724b334bcED0764c0b86B1D53
- Rebalance leaderboard: https://gblin.digital/keepers
- MCP server: https://github.com/gblinproject/gblin-treasury-risk-regime
- Treasury patterns: skills/base-agent-treasury
