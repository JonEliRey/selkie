# Invented protected-case corpus

`v1.json` is a known-regression corpus, not reserved validation. Its single
protected identity, `protected`, is bound to the invented `paired-history`
portable source text, outcome labels and window, incumbent suite and parameter snapshot,
and exact replayed metric and verdict evidence. Loading the corpus reproduces
that historical run; the recorded `detected: true` value is never trusted alone.

The committed source digests hash UTF8 text with CRLF normalized to LF so the
fixture verifies in Git checkouts and raw-blob packages. Optional opaque admission
provenance uses raw-byte SHA-256 instead. Public regressions add invented admission
bytes `fffe7b007d00`, then change them to `fefe7b007d00`: both decode identically
as UTF8, but only the original bytes may verify. A valid successor preserves
those supplied bytes unchanged.

Another worked regression sets the four `m-new` settlement amounts to 100.
There is no newly detected fraud case, so target `fraud_cases` has no strict
improvement even though the protected case remains detected. Editing only saved
eligibility must not create a successor. Replaying and binding the complete
comparison evidence also rejects altered plans, counts and either arm's verdicts.

The public comparison tests make two later datasets by changing the materialized
history snapshot, outcome version and dataset identity. Dataset v2 replays both
arms on its new bytes, retains `protected`, and explicitly creates corpus version
2 without changing version 1. Dataset v3 changes the protected merchant's prior
totals to 9,000, 10,000 and 11,000: the incumbent still detects `protected`, the
candidate detects the new `new-jump` case and removes the legitimate flag, but it
loses `protected`, so the corpus check rejects it.

The other worked mutations remove `protected` from the authored population,
source events or a changed observation window, and make its outcome unknown or
immature. Each mutation is rejected by identity with an explicit disposition.
An isolated wrong-rule mutation proves that corpus detection claims must agree
with replayed verdicts. All identifiers, labels, histories and values are invented.
