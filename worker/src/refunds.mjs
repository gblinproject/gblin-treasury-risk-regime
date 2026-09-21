/**
 * LEDGER OF PAYMENTS TAKEN WITHOUT DELIVERY.
 *
 * WHY IT EXISTS
 * A caller can pay for a seal and receive nothing: no leaf in the log, no receipt. With no
 * record of it, the failure cannot even be described afterwards, let alone repaid. What is owed
 * in that case is a refund and an explanation, and neither is possible unless the event is
 * written down.
 *
 * Published x402 research tells sellers to do one of two things: withhold the service until
 * settlement succeeds, or keep a way to make good when payment succeeds and delivery does not.
 * The first half is handled by the payment library. This is the second.
 *
 * THE PRIVACY TRADE-OFF, DECLARED
 * The rule elsewhere is to count WHAT is called, never WHO calls. Here the payer address is
 * recorded: without it the money cannot be returned. This is therefore NOT a counter and is
 * kept apart from them:
 *   - a row is written ONLY when a payment was taken and the thing paid for was not delivered;
 *   - it holds only what a refund needs: payer, nonce, amount, asset, network, path, reason,
 *     timestamp. No call arguments, no bodies, no content;
 *   - it is NOT public. Only the COUNT and the total owed are published, never the addresses:
 *     someone entitled to a refund has no reason to appear in a list;
 *   - the nonce is the primary key, so retrying the same payment cannot create two rows. The
 *     nonce is also what makes an entry verifiable from outside: USDC on Base emits
 *     AuthorizationUsed(authorizer, nonce) on settlement, so a payer can prove unaided that a
 *     given payment is theirs.
 *
 * Refunds are sent by a person, not by this code: what is recorded here is the debt.
 */

const REFUND_REASONS = new Set([
  "json",      // body could not be parsed
  "schema",    // valid JSON, rejected by the validator
  "metodo",    // paid on a method that route does not serve
  "upstream",  // the upstream service did not answer, or answered badly
  "config",    // a server-side configuration is missing
  "internal",  // anything else: no category is invented
]);

/**
 * Record a payment taken without delivery. Silent on storage failure: an error here must not
 * turn one failure into TWO for whoever paid.
 *
 * @returns true if the row was written (or already existed), false if it could not be
 */
export async function recordRefund(env, d) {
  if (!env?.USAGE || !d?.nonce || !d?.payer) return false;
  const reason = REFUND_REASONS.has(d.reason) ? d.reason : "internal";
  try {
    await env.USAGE.prepare(
      "INSERT INTO rimborsi_dovuti (nonce,payer,importo,asset,rete,percorso,motivo,visto_a) " +
      "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(nonce) DO NOTHING",
    ).bind(
      String(d.nonce), String(d.payer), d.amount ?? null, d.asset ?? null,
      d.network ?? null, d.path ?? null, reason, new Date().toISOString(),
    ).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Public summary of what is owed. Counts and reasons, NEVER addresses.
 */
export async function refundSummary(env) {
  const empty = {
    what: "payments taken without delivery. Counts only: an address owed a refund is not " +
          "published, so that being owed one is never a public fact about the payer.",
    open: null, refunded: null, by_reason: {}, note: "ledger unavailable",
  };
  if (!env?.USAGE) return empty;
  try {
    const r = await env.USAGE.prepare(
      "SELECT motivo, COUNT(*) n, SUM(CASE WHEN rimborsato_tx IS NULL THEN 1 ELSE 0 END) aperti " +
      "FROM rimborsi_dovuti GROUP BY motivo",
    ).all();
    // `x.motivo` and `x.aperti` are the column and the alias of the query above: they are the
    // stored schema, not local names, and must be read exactly as the table spells them.
    const byReason = {}; let open = 0, total = 0;
    for (const x of r.results ?? []) { byReason[x.motivo] = x.n; open += x.aperti; total += x.n; }
    return {
      what: empty.what,
      open,
      refunded: total - open,
      by_reason: byReason,
      how_to_claim: "If you paid and received nothing, quote your EIP-3009 nonce to gblin.digital. " +
                    "The nonce is provable on-chain: USDC on Base emits AuthorizationUsed(authorizer, nonce) " +
                    "in the settlement transaction.",
    };
  } catch {
    return empty;
  }
}
