# Changelog

All notable changes to `@gblin-protocol/mcp-server` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- The JIT redemption returns a `gas_hint` of 1,100,000 for the Zap exit step (it was 600,000, below what the
  exit needs), with a note explaining why.
- Skills and the Base MCP plugin page state the vault's redemption cooldown (20 seconds after a mint for
  oneself, read live) instead of two minutes; the JIT skill reads the real `health` response fields.

## [0.4.0] — 2026-09-21

The package now targets the vault in service, `0xc2181d975c05c8c724b334bcED0764c0b86B1D53`, with its Lens
and Zap. The vault mints at NAV, redeems pro rata in kind, never swaps, rebalances by Dutch auction and
supports payments by signature (EIP-3009).

### Added
- `get_auction_state`: the rebalancing auction row by row — side, gap, premium curve, the input token and
  amount that close the gap, and unsigned calldata for the approval and the bid.
- `get_governance_state` reports the pending owner and, when it is the timelock, the deterministic id and
  state of the scheduled `acceptOwnership` operation.
- `get_treasury_state` reports NAV reliability, the yearly management fee and whether an auction is open.
- MCP tool annotations on every tool (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`).
- Vault, Lens and Zap ABIs, including the EIP-3009 functions.

### Changed
- Quotes come from the Lens (`quoteBuy`, `quoteSell`); NAV and basket state are read through it.
- `swap_gblin_to_usdc_jit` returns three transactions: approve the shares to the Zap, the Zap's
  `sellGBLINForEth` (redeem in kind and sell every leg, all or nothing), then the WETH→USDC swap.
- `invest_usdc_to_gblin` returns two transactions through the Zap: approve USDC, then one call that
  swaps and mints at NAV. The minimum deposit check is gone: the vault has none.
- The redemption cooldown is read live from the vault instead of a constant.
- `verify_risk_attestation` accepts EIP-712 domain version 2 (verifying contract = the vault in service)
  and version 1 (the previous deployment); the version an attestation declares selects the domain.
- Governance output: `fee_recipient` replaces `founder_wallet`; `pending_handover` replaces
  `pending_asset_proposal`, which had no on-chain getter on the vault in service.

### Removed
- `find_keeper_bounty`: the vault in service has no bounty fund; `get_auction_state` replaces it.
- The `earn-as-base-keeper` skill now describes the auction.

### Fixed
- The descriptions of `swap_gblin_to_usdc_jit` and `invest_usdc_to_gblin` stated a 0.05% fee on every call.
  On the vault in service a redemption carries no protocol fee, and an in-kind deposit pays 0.50% to 2.00%.

## [0.3.2] and earlier

Releases for the previous deployment. See the npm history.
