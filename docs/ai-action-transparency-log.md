# An application transparency log for AI actions

*GBLIN Protocol — first published 21 August 2026. Everything below is reachable and checkable while you read it.*

## What it is

An append-only [RFC 6962](https://datatracker.ietf.org/doc/html/rfc6962) log whose leaves are **records of AI
actions**, not certificates. An agent sends the SHA-256 of its input and output plus a short public label; the
log appends a canonical JSON record and returns a **portable receipt**: the leaf hash, an Ed25519 signature over
the record, an inclusion proof, and a [C2SP signed checkpoint](https://c2sp.org/tlog-checkpoint). Once a day the
tree root is anchored on Base as an EAS attestation, so the log's own history is pinned to a public chain.

Origin line: `gblin.digital/receipts-log`
Verifier key: `gblin.digital/receipts-log+00c6e18c+AY8/YnCHXTnsECT2EGv0M5RTqlVvFobctLv3WSihYkoG`
Base URL: `https://gblin-mcp.gblin-mcp-worker.workers.dev`

## What a receipt proves — and what it does not

It proves that **this record existed in this log at this position and time**, and that the log has not been
rewritten since. That is all a transparency log can prove.

It does **not** prove the AI action happened, nor that the hashes match any real input or output. The sealer
supplies them. We label this in the payload itself: `provenance.level` is an enum,
`self-reported | server-observed | externally-verified`, and customer receipts are `self-reported`. Receipts the
server writes about its own actions carry the signed field `by: "operator"` and are labelled `server-observed`;
a caller cannot set that field. `externally-verified` exists in the enum but is not offered — nobody verifies
third-party execution today, and pretending otherwise would be the easiest lie in this design.

Anchoring is root-only: `anchor.what_is_anchored` says so in every receipt. A leaf is covered by an anchor iff
its index is below `anchored_tree_size`; newer receipts rest on the operator-signed checkpoint until the next
daily anchor.

## Making one, right now

The whole document used to list only the ways to *read* the log, never the way to write to it. Here is the
free door, in one command — no key, no wallet, no account:

    printf 'hello' | shasum -a 256          # -> the input_hash below
    curl -s https://gblin-mcp.gblin-mcp-worker.workers.dev/v1/seal-demo \
      -H 'content-type: application/json' \
      -d '{"action":"my-first-seal","input_hash":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"}'

The response **is** the receipt: keep it. Five per day per IP, and only successful seals count against that.
Records are marked `demo: true`. Then check it without trusting this server:

    node verify-receipt.mjs receipt.json     # zero dependencies, does not call us

Over MCP the same thing is the tool `receipts.seal` with `{action, input_hash}`; the paid, unmetered version is
`POST https://gblin.digital/api/x402/seal` ($0.01 USDC via x402).

Two things worth knowing before you send anything: `action`, `agent_id`, `tool` and `meta` are **published in
the public log** — put identifiers there, never secrets — and only the *hashes* of your input and output ever
reach us, never the content.

## Endpoints (free, no auth, no key)

    GET /log/checkpoint                    C2SP signed note (Ed25519)
    GET /log/consistency?old=<m>&new=<n>   RFC 6962 §2.1.2 append-only proof
    GET /log/leaves?start=&end=            raw canonical records, max 256 — rebuild the tree yourself
    GET /log/proof/<i>                     inclusion proof for leaf i
    GET /v1/receipt/<i>                    the full receipt, re-signed on read (Ed25519 is deterministic)
    GET /v1/verify/<i>                     per-check booleans + whether the on-chain anchor still matches

Canonicalization is frozen as `gblin-canonical-json/1`: keys sorted recursively, minimal separators, and keys
whose value is `undefined` are omitted. Leaf = `SHA256(0x00 || canonical)`, node = `SHA256(0x01 || left || right)`.

There is a zero-dependency offline verifier in this repository, `verify-receipt.mjs`. It re-derives everything
from the receipt JSON: you do not need to trust this server, and it does not call it.

## Witnessing

The log is operator-signed **and cosigned by one third-party witness** (`markovianprotocol.com/witness`,
since 22 August 2026 — see `GET /log/witnesses`). A cosignature attests only that the log stayed append-only
between the sizes that witness saw. It says nothing about whether a sealed action is true, and we will not
word it more strongly than that. The endpoints above exist so that a witness does not have to take our word
for anything: fetch the checkpoint, ask for a consistency proof against the size you last saw, or download
the raw leaves and recompute the root. More witnesses are welcome.

We also run a witness ourselves, `gblin.digital/witness`, speaking
[c2sp.org/tlog-witness](https://c2sp.org/tlog-witness) both ways: it co-signs a third-party log every ten
minutes after verifying the log signature and a consistency proof, and it accepts `add-checkpoint` pushes. It
discovers logs from the [Witness Network](https://witness-network.org) `testing/log-list.1`, adds new ones to
its own configuration, and never removes or modifies a log because the list changed.

One witness cosigns today. More are welcome, and joining is not conditional on anything.

## Honest scale

This log is small and new, and **nobody outside GBLIN has sealed anything in it yet**. As of 30 August 2026 it
holds 39 leaves: 18 are the daily anchoring receipts our own cron writes, 4 are the malformed records
described below, and the rest are our tests — including the two seals we paid for ourselves to check the paid
path end to end. An earlier version of this page said it "had exactly one paid seal from an external wallet".
That was wrong twice over: there are two paid seals and neither came from outside. We publish the size in
`/log` and the raw records in `/log/leaves`, so you never have to take our word for any of this. If that is
too small to be interesting, that is a fair conclusion to draw — the point of publishing the numbers is to let
you draw it.

## One bug worth reporting publicly

The paid path was broken from the day it shipped and nobody noticed, because nobody had used it. The
canonicalizer emitted a literal `undefined` for an absent field, so any **non-demo** record was written as
invalid JSON: the receipt was issued correctly, but re-reading it returned HTTP 500. Every receipt in the log
was a demo, so the bug stayed invisible for two weeks. We found it by paying for our own product once. Fixed on
21 August; the four records written while the bug was live (indices 11 to 14) remain in the log with a
`malformed_entry` field that states the cause and the date, because an append-only log is not rewritten — it
is disclosed. `GET /log/leaves` reports them as `malformed_indices`: hash them as opaque bytes, do not parse
them as JSON.

## Witnessing (added 21 August 2026)

An operator signature is a weak claim on its own: an operator who controls the key can, in principle, sign
two different trees. The fix is a third party that has seen the log at two sizes and can say it did not
change underneath. One does, since 22 August 2026.

We implement the log side of [c2sp.org/tlog-witness](https://c2sp.org/tlog-witness): whenever the tree
grows, the worker POSTs `old <n>` plus an RFC 6962 consistency proof plus the signed note to each
configured witness, and stores the cosignature line it gets back. A cosignature is bound to one
`(origin, size, root)` triple, so we serve it in `GET /log/checkpoint` only while it still matches the
current size — never re-attached to a later tree.

`GET /log/witnesses` lists the witnesses, the size each one has cosigned, and the last error if a push
failed. Anyone auditing us can start from `GET /log/leaves`, rebuild the tree, and compare the root to
the signed note before deciding whether a cosignature is worth anything.

What a cosignature attests: that the log stayed append-only between the sizes that witness saw.
Nothing about whether a sealed action is true. We will not word it more strongly than that.
