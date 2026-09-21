/**
 * GBLIN MCP — Contract ABIs
 *
 * Surfaces of the vault in service, its Lens and its Zap on Base mainnet, taken from the verified sources.
 */

import { parseAbi } from "viem";

/**
 * GBLIN vault — the surface these tools read and encode calls for.
 * The vault exposes little directly; quotes, configuration, basket rows and auction state come from the Lens.
 */
export const GBLIN_ABI = parseAbi([
  // ERC-20 surface
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",

  // Valuation and state
  "function totalEthValue(uint256 excludeWeth) view returns (uint256 total)",
  "function navPerShare(uint256 excludeWeth) view returns (uint256)",
  "function isNavReliable() view returns (bool)",
  "function auctionPremiumBps() view returns (int256)",
  "function currentDriftEth() view returns (uint256)",

  // Ownership
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function acceptOwnership()",

  // Payments by signature (EIP-3009)
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",

  // Mutating — only used to build calldata (never executed by this server)
  "function buyGBLIN(uint256 minOut) payable",
  "function buyGBLINWithWeth(uint256 amount, uint256 minOut, address receiver)",
  "function buyGBLINInKind(address token, uint256 amountIn, uint256 minOut)",
  "function sellGBLIN(uint256 gblinAmount)",
  "function claimPending(address token)",
  "function bid(uint256 index, bool vaultBuysAsset, uint256 amountIn, uint256 minOut, bytes data) returns (uint256 amountInUsed, uint256 amountOut)",
]);

/**
 * GBLIN Lens — read-only views beside the vault. Every call takes the vault as its first argument.
 */
export const LENS_ABI = parseAbi([
  "function basketLength(address vault) view returns (uint256)",
  "function asset(address vault, uint256 i) view returns (address token, address oracle, bool isStable, bool delisted, uint256 baseWeight, uint256 dynamicWeight, bool shielded, bool abandoned)",
  "function auction(address vault, uint256 i) view returns (bool open, int256 premiumBps, bool vaultBuysAsset, uint256 gapEth)",
  "function auctionOpenedAt(address vault) view returns (uint256)",
  "function quoteBuy(address vault, uint256 ethValue) view returns (uint256 out, uint256 protocolFee, uint256 stabilityFee)",
  "function quoteSell(address vault, uint256 gblinAmount) view returns (uint256)",
  "function configFees(address vault) view returns (uint256 protocolFee, uint256 stabilityFee, uint256 minDeposit, uint256 oracleAge, uint256 oracleAgeTrade, uint256 sellCooldown, uint256 basketCap)",
  "function configAuction(address vault) view returns (uint256 driftBand, uint256 driftClose, uint256 auctionStart, uint256 auctionCap, uint256 auctionRamp, uint256 volUpdateInterval, uint256 listingDelay, uint256 inKindFee, uint256 inKindTax)",
  "function managementFeeBps(address vault) view returns (uint256)",
  "function lastManagementFeeAccrual(address vault) view returns (uint256)",
  "function lastDepositTime(address vault, address holder) view returns (uint256)",
  "function pendingWithdrawal(address vault, address holder, address token) view returns (uint256)",
  "function feeRecipient(address vault) view returns (address)",
  "function pendingOwner(address vault) view returns (address)",
  "function wethOracle(address vault) view returns (address)",
  "function sequencerFeed(address vault) view returns (address)",
  "function fill(address vault) view returns (address agent, bool open)",
]);

/**
 * GBLIN Zap — the only contract that swaps. Mints with any token; exits to ETH all or nothing.
 */
export const ZAP_ABI = parseAbi([
  "function buyGBLINWithToken(address tokenIn, uint256 amountIn, uint256 minWethOut, uint256 minOut, bytes venueData, address receiver) returns (uint256 out)",
  "function sellGBLINForEth(uint256 shares, uint256 minEthOut, bytes[] venueData, address receiver) returns (uint256 ethOut)",
]);

/**
 * GblinTimelockController — OpenZeppelin TimelockController v5 surface.
 * Only the views we need to read governance state.
 */
export const TIMELOCK_ABI = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function GRACE_PERIOD() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event Cancelled(bytes32 indexed id)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
]);

/**
 * Chainlink AggregatorV3Interface — only the read we need.
 * Note: `answer` is int256 (can be negative — we guard against that).
 */
export const CHAINLINK_AGGREGATOR_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

/**
 * Standard ERC-20 (USDC, etc).
 */
export const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);
