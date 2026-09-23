# Changelog

All notable changes to `@gblin-protocol/mcp-server` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [0.5.1] - 2026-09-23

### Fixed
- `get_nav_history` reads the past through five public endpoints that serve historical state (Tenderly,
  Blast, dRPC, Nodies, mainnet.base.org), each tried once, instead of two. Run from a hosted server, the two
  were both refused or rate-limited from datacenter ranges, and every failed attempt spends part of the
  request budget.
- `preview_steps` reported `gas_limit_enough: false` whenever a step failed, even when it failed for another
  reason (a slippage bound, a cooldown). It is now `false` only when the limit is what makes the step fail,
  and `null` when the step fails for another reason.

## [0.5.0] - 2026-09-23

### Added
- `prepare_action`: the unsigned steps for any operation on the vault — mint with ETH, WETH or USDC, redeem in
  kind, exit to ETH or USDC, bid in the auction — each step through the vault or the Zap with its gas limit.
- `preview_steps`: the steps simulated in sequence against the latest block (`eth_simulateV1`), with decoded
  revert reasons and net balance changes. For steps into the vault or the Zap the recommended gas limit is the
  smallest that passes, found by bisection, because the gas a call uses is below the limit it needs.
- `get_transaction_status`: what a sent transaction did, and why it reverted.
- `get_nav_history`: NAV per share at past blocks beside the vault's ETH/USD and BTC/USD feeds; one multicall
  per point. `GBLIN_ARCHIVE_RPC_URL` selects an archive endpoint.
- `relay_gblin_payment`, and `relay: true` on `prepare_gblin_payment`: GBLIN's relay settles a signed payment
  and a signed fee in GBLIN in one transaction through Multicall3, for a payer with no ETH.
- The hosted server serves the vault, action and payment tools from this source (`../src`), so the two cannot
  drift.
- `npm run test:actions` on a fork: every action prepared, simulated, sent and read back.
- `prepare_gblin_payment` and `verify_gblin_authorization`: paying in GBLIN with a signature and no ETH
  for gas, through the token's EIP-3009 surface. The first builds the EIP-712 message, the calldata and
  the x402 "exact" payload, and the accepts block a seller publishes to be paid in GBLIN; the second runs
  the checks a facilitator runs — signature (ECDSA or ERC-1271), validity window against on-chain time,
  nonce state, balance — and returns the calldata only when the payment would settle.
- The EIP-712 domain is read from the token through EIP-5267 rather than assumed, so a redeployment
  cannot silently invalidate every signature this server prepares.
- `npm run test:payments`: twenty-six end-to-end checks against a fork of Base, including the failure
  modes — replay, foreign signature, expired window, insufficient balance, and an outsider trying to
  carry a `receive` authorization.
- `outputSchema` on every tool except `seal_action_demo`. The required fields are the contract of a
  successful result; the schemas stay open to additional fields.
- Prompts: `risk_gate`, `pay_in_gblin`, `pay_invoice_just_in_time`, `seal_and_verify`.
- Resources: `gblin://contracts`, `gblin://payments` (the EIP-712 domain read live), `gblin://keys`,
  `gblin://limits`.
- Tests: `test:protocol` speaks MCP over stdio; `test:schemas` calls every tool on every result path
  through the official MCP client, which validates each result against its `outputSchema`, with a
  negative control; `test:calldata` sends the exit and investment steps on a fork exactly as returned.

### Changed
- Every tool now returns `structuredContent` beside the text, and carries a human title in its
  annotations, matching what the hosted server already did.
- `invest_usdc_to_gblin` no longer states the mint fee and the management fee in its description: both are
  governance parameters, and a static description cannot follow a change. They are read live from
  `get_treasury_state`.
- The skill seed no longer offers "passive ETH income as a keeper": the vault in service pays no keeper
  bounty, the auction premium is the whole reward.
- The oldest oracle answer the server accepts now follows the vault: its `oracleAge`, read through the
  Lens, for volatile feeds, and 26 hours for the feed of a stable asset, instead of a fixed 24 hours for
  all. The server no longer quotes on a price the contract would refuse.
- The initialize instructions no longer say a signer is configured by the operator: the server holds no key.

### Fixed
- The AI Action Receipts paid seal is priced at $0.0045 (was $0.01), in the tool descriptions and the docs.
- The package version is a constant generated at build time instead of a file read at run time.
- `share_skill_with_peer` told the caller that referrals redirect part of the protocol fee to its wallet
  and that every transaction carries the referral code. Neither is true: the code is a label inside the
  seed, the server reads it nowhere, and the contract has no referral payout. The seed also listed ten
  tools, named an earlier deployment, and told the peer to quote a USDC amount with a tool that takes ETH.
- `quote_safe_swap` reported a fixed `total_fee_bps` of 10; it is now the sum of the fees read from the
  vault.
- `analyze_treasury_health` advised 90% GBLIN / 10% USDC by default "for treasury yield". GBLIN is crypto
  exposure, not yield, and the advice contradicted the rule this server documents. It now advises only
  when `daily_burn_usd` is given: seven days of spend stay in USDC, only the surplus is a candidate for
  GBLIN, and never while the crash shield is active. The gas check uses the live gas price and the cost of
  the three-step exit instead of fixed ETH thresholds, and reports `exit_cost_eth`.
- Steps that go through the Zap now carry an explicit `gas` limit: an automatic estimate could fall just
  under what the call needs, because the vault reserves gas for its capped transfers, and revert.
- `prepare_gblin_payment` pointed to a calldata field it does not return; the calldata comes from
  `verify_gblin_authorization`.

## [0.4.3] - 2026-09-23

### Changed
- A call to a tool that was retired in an earlier release now answers with the tool to call instead and
  the reason, rather than only that the name is unknown. `find_keeper_bounty`, removed when the vault in
  service moved to a Dutch auction, points to `get_auction_state`.
- A call to a name that never existed lists the tools the server does expose.

## [0.4.2] — 2026-09-22

### Fixed
- `swap_gblin_to_usdc_jit` sold too little GBLIN: the slippage buffer was applied twice downstream (to the
  Zap exit's minimum ETH and to the swap) but the sell amount was grossed up once, so the final swap spent the
  minimum ETH and could not return the requested USDC and reverted. The sell amount is now grossed up for both.
- The descriptions of `swap_gblin_to_usdc_jit` and `invest_usdc_to_gblin` state the steps they actually return.

## [0.4.1] — 2026-09-22

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
