// Incident notes for the coherence observer.
//
// When a promise records a violation the count is never edited: the observer measures the
// operator too, and one of the promises is precisely that the counters are honest. A count on
// its own does not say what happened, so these notes live BESIDE it -- the day's attestation
// carries them in `evidenceURI`, and the explanation is anchored on chain together with the
// number.
//
// Rules, so they stay notes and not excuses: they state the facts and the cause, they
// reclassify nothing, and they do not claim to cancel the violation. They are written
// afterwards, never in advance; an announced maintenance window would require a new,
// pre-registered promise.

export const INCIDENTS = {
  "2026-08-22": {
    day: "2026-08-22",
    promise: "P1",
    violations: 1,
    observations_that_day: "~144 (one probe every 10 minutes, as the promise declares)",
    what_happened:
      "The operator published a Vercel CDN routing rule intended to serve the unpaid 402 " +
      "challenge from the edge, in order to cut serverless CPU cost. The rewrite to an " +
      "external destination did not work: /api/x402/attestation answered HTTP 404 instead " +
      "of the 402 challenge. The rule was rolled back about three minutes later.",
    detected_by:
      "Our own coherence automaton, at 2026-08-22T15:40:15Z. Not by a customer, not by a " +
      "third party. The failed observation was recorded and kept.",
    impact:
      "Any unpaid request in that window received a 404 rather than a payment challenge. " +
      "A client of the paid endpoint could not have distinguished this from a real outage, " +
      "which is exactly why it counts as a violation.",
    what_we_did_not_do:
      "We did not edit the counter, and we did not reclassify the observation as an " +
      "operator test. Promise P1 is a hash-pinned file with no maintenance exemption; " +
      "inventing one after seeing the data would break promise P2 (honest counters) and " +
      "would make the whole meter worthless.",
    root_cause:
      "A single dropped character in the provider dashboard's destination-URL field. The " +
      "rewrite target was saved as /x402/atestation instead of /x402/attestation, so the " +
      "request reached our edge worker on a path it does not serve and the worker returned " +
      "its own 404. The mechanism was never broken; the address had a typo. The field was " +
      "later observed to drop a character a second time, which is how it was identified.",
    resolution:
      "Same day. Root cause found by having the worker echo the path it was receiving, the " +
      "address corrected, and the change proven on a throwaway path that is not under any " +
      "promise before being applied to the real one. As of 2026-08-22T16:28Z the intended " +
      "behaviour is live and verified: an unpaid request to /api/x402/attestation receives " +
      "the byte-identical 402 challenge from the edge, and a request carrying a payment " +
      "header reaches the normal paid pipeline.",
    prevention:
      "No routing rule is published on a path under promise before being proven on a path " +
      "that is not. Vercel's 'Test Rules' only confirms that a path matches a rule — it " +
      "does not prove the action produces the intended response. That distinction caused this. " +
      "The destination field is now read back and compared against the intended string before " +
      "any rule is saved.",
    promise_file: "https://gblin.digital/promises/P1-attestation-uptime.json",
  },
};

export function incidentFor(day) {
  return INCIDENTS[day] || null;
}

export function incidentResponse(day) {
  const inc = incidentFor(day);
  if (!inc) return new Response(JSON.stringify({ error: "no incident recorded for that day", day }), {
    status: 404, headers: { "content-type": "application/json" },
  });
  return new Response(JSON.stringify({
    about: "Incident note attached to the on-chain coherence attestation for this day. " +
           "It explains a violation; it does not cancel it.",
    ...inc,
  }, null, 2), { status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}
