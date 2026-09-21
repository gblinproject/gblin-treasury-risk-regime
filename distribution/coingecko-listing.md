# CoinGecko + CoinMarketCap listing — fill-in sheet (2026-07-27)

Everything needed to complete both listing forms in one sitting. Copy-paste the
values; the description block is pre-written to house honesty rules (no
"audited" without qualification, no "immutable"/"no admin key", no contract
version numbers, no unverifiable "first/only" claims).

## Token basics

| Field | Value |
|---|---|
| Token name | Global Balanced Liquidity Index |
| Ticker / symbol | GBLIN |
| Chain / platform | Base (chain ID 8453) |
| Contract address | `0xc2181d975c05c8c724b334bcED0764c0b86B1D53` |
| Decimals | 18 |
| Token standard | ERC-20 (with EIP-3009 payments by signature) |
| Launch type | Fair launch, no token sale |
| Logo (PNG, direct URL) | `https://raw.githubusercontent.com/gblinproject/GBLIN/main/LOGO_GBLIN.png` |
| Website | `https://gblin.digital` |
| Contact email | info@gblin.digital |

## Supply API endpoints (already live, plain-text number as required)

| Field | Value |
|---|---|
| Total supply API | `https://gblin.digital/api/supply/total` |
| Circulating supply API | `https://gblin.digital/api/supply/circulating` |
| Max supply | None fixed (supply mints/burns against NAV on buy/sell) |

Both endpoints return the bare number in plain text — the format CoinGecko and
CMC require. Test them in a browser before submitting.

## Markets / liquidity pools

| Venue | Pair | Address |
|---|---|---|
| Protocol contract | mint and redeem at NAV | `0xc2181d975c05c8c724b334bcED0764c0b86B1D53` |

There is no DEX pool for the vault in service at the moment: the way in and out is
minting and redeeming at NAV (any token through the Zap `0x0E9D6Ceb6D313b021622C121Cda9C62e86e60200`).
Add the pool row when one exists.

## Project description (paste as-is)

> GBLIN is a NAV-backed basket token on Base: each token is redeemable pro-rata
> against an on-chain treasury of cbBTC, WETH and USDC, with buys and sells
> executed directly against the contract at NAV; rebalancing is a Dutch auction
> open to anyone. An automated on-chain crash-response mechanism ("Crash Shield")
> reduces volatile-asset exposure during severe oracle-measured drawdowns and
> restores it in recovery. Fees: 0.10% on every mint (0.05% stays in the vault,
> 0.05% to the fee recipient as shares), a 0.50% yearly management fee accrued as
> shares, none on redemption in kind. Parameters are governed by a 48-hour public
> timelock. No paid third-party audit has been commissioned.

## Explorer links

- BaseScan token page: `https://basescan.org/token/0xc2181d975c05c8c724b334bcED0764c0b86B1D53`
- BaseScan contract (verified source): `https://basescan.org/address/0xc2181d975c05c8c724b334bcED0764c0b86B1D53#code`
- Blockscout (Base): `https://base.blockscout.com/token/0xc2181d975c05c8c724b334bcED0764c0b86B1D53`

## Socials / links

| Channel | Value |
|---|---|
| Telegram | `https://t.me/GBLINHub` |
| Farcaster | `https://warpcast.com/gblin` (@gblin) |
| X / Twitter | `https://x.com/GBLIN_Protocol` |
| GitHub | `https://github.com/gblinproject` |
| Docs / agents page | `https://gblin.digital/agents` |

## Where to submit — step by step

### CoinGecko
1. Go to `https://www.coingecko.com/en/coins/new` (the "Request Form" — also
   reachable from the site footer → "Request Form" / support.coingecko.com).
2. Log in / create a (free) CoinGecko account with info@gblin.digital.
3. Choose "New cryptoasset (token) listing" and fill the form with the tables
   above: contract + chain first (it auto-detects name/symbol/decimals), then
   supply APIs, pools, logo URL, description, socials.
4. Submit. Typical review is days-to-weeks; they reply to the account email.
   Track status from the same form portal; do not submit duplicates.

### CoinMarketCap
1. Go to `https://coinmarketcap.com/request/` and pick "[New Listing] Add
   cryptoasset".
2. Log in / create a CMC account with info@gblin.digital.
3. Fill the same data. CMC additionally asks for: date launched, a one-line
   "what makes this project unique" (use the first sentence of the description),
   supply APIs, and at least one active market — give both pools plus the
   GeckoTerminal links as price sources.
4. Submit and keep the ticket ID from the confirmation email for follow-ups.

### Notes
- Both forms are free; anyone asking for payment to "expedite" is a scammer.
- If a form field demands a "security audit link", link the Slither report in
  `GBLIN-Protocol/audits/` and state plainly: static analysis only, 0 critical /
  0 high, no external manual audit.
- Listing forms occasionally move; if a URL 404s, reach the form from the site
  footer ("Request Form" on CoinGecko, "Request" on CMC).
