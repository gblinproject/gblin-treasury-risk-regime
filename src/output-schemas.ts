/**
 * GBLIN MCP — output schemas.
 *
 * Every tool that returns a JSON object declares its shape here, so a client can validate the
 * `structuredContent` of a successful result and generate types from it. Error results carry
 * `isError: true` and no structured content, so they are outside these schemas.
 *
 * The `required` list of each schema is the contract: fields a successful call always returns.
 * Other fields are described but optional, and `additionalProperties` stays open, so adding a
 * field later is not a breaking change. Removing or retyping a required field is.
 *
 * seal_action_demo has no schema: its result is the hosted log's receipt, whose shape is published
 * by the log itself (see get_receipt for the fields a reader can rely on).
 */

type JsonSchema = Record<string, unknown>;

const str = (description?: string): JsonSchema => ({ type: "string", ...(description ? { description } : {}) });
const num = (description?: string): JsonSchema => ({ type: "number", ...(description ? { description } : {}) });
const bool = (description?: string): JsonSchema => ({ type: "boolean", ...(description ? { description } : {}) });
const obj = (description?: string): JsonSchema => ({ type: "object", ...(description ? { description } : {}) });
const arr = (description?: string, items?: JsonSchema): JsonSchema => ({
  type: "array",
  ...(items ? { items } : {}),
  ...(description ? { description } : {}),
});
/** A field that is an object when present and `null` when there is nothing to report. */
const objOrNull = (description: string): JsonSchema => ({ type: ["object", "null"], description });

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  for (const key of required) {
    if (!(key in properties)) throw new Error(`output schema: required field "${key}" is not described`);
  }
  return { type: "object", properties, required, additionalProperties: true };
}

const STEP = obj(
  "One transaction to send, in order: target, calldata, value in wei, and gas when the step needs an explicit limit."
);

export const OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  get_treasury_state: schema(
    ["nav_usd", "eth_price_usd", "nav_reliable", "management_fee_bps_per_year", "auction_open", "crash_shield_active", "basket"],
    {
      nav_usd: num("Net asset value of one GBLIN share in USD."),
      eth_price_usd: num("ETH price in USD from the oracle."),
      nav_reliable: bool("False when a price feed is stale or a basket asset cannot be read; do not trade on the NAV then."),
      management_fee_bps_per_year: num("Management fee in basis points per year, read from the contract."),
      auction_open: bool("True while a rebalancing auction is running."),
      crash_shield_active: bool("True when the crash shield has cut the weight of a falling asset."),
      slippage_buffer_pct: num(),
      slippage_reason: str(),
      basket: arr("Assets in the basket with base and dynamic weights.", obj()),
      meta: obj(),
    }
  ),

  quote_safe_swap: schema(["direction", "slippage_buffer_bps", "next_step"], {
    direction: { type: "string", enum: ["buy", "sell"] },
    amount_in_eth: str("Buy only."),
    expected_gblin_out: str("Buy only."),
    safe_min_gblin_out: str("Buy only. Pass as minOut."),
    amount_in_gblin: str("Sell only."),
    expected_eth_out: str("Sell only."),
    safe_min_eth_out: str("Sell only. Pass as minEthOut."),
    fees: obj(),
    slippage_buffer_bps: num(),
    slippage_reason: str(),
    will_revert_with_zero_tolerance: bool(),
    cooldown_note: str(),
    next_step: str(),
  }),

  swap_gblin_to_usdc_jit: schema(["action", "steps", "expected", "gas_hint"], {
    action: str("Always sequential_txs: send the steps one after the other."),
    steps: arr("Transactions to send in order.", STEP),
    params: obj(),
    expected: obj("Shares spent, ETH and USDC expected, and the minimums applied."),
    compatibility: obj(),
    gas_hint: num("Gas limit to set on the Zap step."),
    gas_hint_note: str(),
  }),

  invest_usdc_to_gblin: schema(["action", "steps", "expected", "gas_hint"], {
    action: str("Always sequential_txs: send the steps one after the other."),
    steps: arr("Transactions to send in order.", STEP),
    gas_hint: num("Gas limit to set on the Zap step."),
    gas_hint_note: str(),
    expected: obj("Shares expected and the minimum applied."),
    security: obj(),
  }),

  analyze_treasury_health: schema(["wallet", "balances", "gas_health", "cooldown", "recommendation"], {
    wallet: str(),
    balances: obj(),
    ratios: obj(),
    gas_health: obj("Whether the wallet holds enough ETH for the next transactions."),
    cooldown: obj("Whether the redemption cooldown is active and for how long."),
    recommendation: obj("hold, rebalance_to_gblin or rebalance_to_usdc, with the reason."),
  }),

  get_governance_state: schema(["vault", "owner", "owner_is_timelock", "owner_is_renounced", "timelock"], {
    vault: str(),
    lens: str(),
    owner: str(),
    owner_is_timelock: bool(),
    owner_is_renounced: bool(),
    fee_recipient: str(),
    trust_summary: str(),
    timelock: obj("Address and minimum delay of the timelock, read on chain."),
    pending_handover: objOrNull("A pending ownership transfer, or null."),
    pending_timelock_operation: objOrNull("A scheduled timelock operation affecting ownership, or null."),
    verification: obj(),
  }),

  share_skill_with_peer: schema(["text"], {
    text: str("A ready-to-send description of the GBLIN skill."),
  }),

  get_auction_state: schema(["vault", "navReliable", "auctionOpen", "premiumBps", "rows"], {
    vault: str(),
    lens: str(),
    navReliable: bool(),
    auctionOpen: bool(),
    premiumBps: num("Current premium over the oracle price, in basis points; negative is a discount."),
    curve: obj(),
    openedAt: { type: ["number", "string", "null"], description: "When the auction opened, or null when closed." },
    worstGapEth: str(),
    totalValueEth: str(),
    rows: arr("One entry per basket asset: side, gap from target and amount a bidder can fill.", obj()),
    best: objOrNull("The row with the largest gap, or null."),
    howToBid: str(),
    note: str(),
  }),

  get_market_risk_regime: schema(["regime", "severity_pct", "shield_active", "defensive_cash_pct"], {
    regime: { type: "string", enum: ["calm", "elevated", "crash"] },
    risk_posture: str(),
    severity_pct: num(),
    shield_active: bool(),
    defensive_cash_pct: num(),
    assets: arr(undefined, obj()),
    source: str(),
    verify: str(),
    meta: obj(),
  }),

  verify_risk_attestation: schema(["valid", "checks"], {
    valid: bool("True only if every check passed."),
    checks: obj("Each check by name, with its result."),
    attested: obj(),
    live: obj(),
    recomputed_attestation_id: str(),
    guidance: str(),
    source: str(),
  }),

  get_receipt: schema(["index", "payload", "signature", "inclusion_proof"], {
    format: str(),
    payload: obj("The sealed record as signed."),
    leaf: str(),
    index: num(),
    tree_size: num(),
    root: str(),
    signature: str(),
    verifier_key: str(),
    inclusion_proof: arr("Sibling hashes from the leaf to the root (RFC 6962).", { type: "string" }),
    checkpoint: str(),
    anchor: obj(),
    provenance: obj(),
    canonical_sha256: str(),
    canonicalization: obj("The canonical JSON form the leaf is hashed from."),
    verify: str("How to verify this receipt."),
    note: str(),
    human_page: str(),
    verify_offline: str(),
  }),

  how_to_seal_paid: schema(["endpoint", "price", "flow"], {
    endpoint: str(),
    price: str(),
    flow: str(),
    body_schema: obj(),
    receipt: str(),
    read_free: str(),
    verify_offline: str(),
    note: str(),
  }),

  prepare_gblin_payment: schema(["authorization", "method", "typed_data", "digest", "x402_payload"], {
    authorization: obj("from, to, value, validAfter, validBefore, nonce."),
    method: { type: "string", enum: ["receive", "transfer"] },
    typed_data: obj("The EIP-712 message to sign with eth_signTypedData_v4."),
    digest: str("The EIP-712 digest of typed_data."),
    amount: obj(),
    payer_balance: obj(),
    next_steps: arr(undefined, { type: "string" }),
    submit: obj(),
    x402_payload: obj("The x402 exact-scheme payment payload, with the signature left to fill."),
    x402_accepts_for_sellers: obj(),
    relay: obj("With relay: true, the fee authorization to sign and where to send both."),
    warnings: arr(undefined, { type: "string" }),
  }),

  prepare_action: schema(["action", "steps"], {
    action: str(),
    wallet: str(),
    steps: arr("Transactions to send in order.", STEP),
    expected: obj("What the operation should deliver, with the minimums applied."),
    warnings: arr(undefined, { type: "string" }),
    next: str(),
  }),

  preview_steps: schema(["would_succeed", "steps", "balance_changes"], {
    would_succeed: bool("True only if every step succeeds in the simulation."),
    from: str(),
    block: num("The block the simulation ran on."),
    steps: arr("Per step: success, gas used, whether the given limit is enough, recommended limit, revert reason.", obj()),
    first_failing_step: { type: ["number", "null"] },
    balance_changes: arr("Net token and ETH movements for the wallet.", obj()),
    note: str(),
  }),

  get_transaction_status: schema(["hash", "status"], {
    hash: str(),
    status: { type: "string", enum: ["pending", "not_found", "success", "reverted"] },
    block: num(),
    confirmations: num(),
    from: str(),
    to: { type: ["string", "null"] },
    gas_used: num(),
    gas_limit: { type: ["number", "null"] },
    fee_eth: str(),
    balance_changes: arr(undefined, obj()),
    revert: obj(),
    explorer: str(),
    note: str(),
  }),

  get_nav_history: schema(["interval", "points", "series"], {
    interval: { type: "string", enum: ["hour", "day"] },
    points: num(),
    series: arr("Oldest first: time, block, NAV in ETH and USD, ETH/USD and BTC/USD.", obj()),
    summary: objOrNull("Change of NAV, ETH and BTC over the window, and the NAV's largest drawdown."),
    note: str(),
    method: str(),
  }),

  relay_gblin_payment: schema(["relay", "status", "transaction"], {
    relay: str("The relay that carried the payment."),
    status: { type: "string", enum: ["settled", "reverted", "submitted"] },
    transaction: str("The transaction hash."),
    explorer: str(),
    payment: obj(),
    fee: obj(),
    block: num(),
    note: str(),
  }),

  verify_gblin_authorization: schema(["would_settle", "method", "checks", "failures"], {
    would_settle: bool("True only if the token would accept this authorization now."),
    method: { type: "string", enum: ["receive", "transfer"] },
    digest: str(),
    checks: obj(),
    failures: arr("Reasons it would not settle; empty when it would.", { type: "string" }),
    amount: obj(),
    submit: objOrNull("Calldata and who may submit it, or null when it would not settle."),
    source: str(),
  }),
};
