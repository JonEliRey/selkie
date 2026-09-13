# Paired rule comparison

On Node 24, run an admitted proposal against the same materialized history as
the unchanged incumbent:

```sh
node scripts/compare.ts fixtures/comparison/paired-history fixtures/comparison/paired-history/proposal.yaml fraud_cases runs/paired-example
```

To enforce known regression obligations, supply a versioned corpus. A sixth
argument explicitly writes a successor corpus only after an eligible check:

```sh
node scripts/compare.ts fixtures/comparison/paired-history fixtures/comparison/paired-history/proposal.yaml legitimate_merchants runs/protected-check fixtures/comparison/protected-corpus/v1.json runs/corpus-v2
```

The target is required: `fraud_cases` increases mature detected fraud cases;
`legitimate_merchants` reduces unique incorrectly flagged legitimate merchants.
The output directory must be empty. Exit 0 means eligible on this comparison;
exit 1 means ineligible or an input error; exit 2 is command usage error.

The public module is `compareRuns(caseDir, outDir, request)` in
`src/seams/comparison.ts`. A request carries `target` and the proposal document.
Optional `supplied_runs: { incumbent, candidate }` names existing ledger folders
to verify. Both arms are freshly replayed even when ledgers are supplied: caller
metadata, hashes and assessment counts are never accepted as proof by themselves.
Every supplied artifact must have the exact canonical bytes and file set of its
replay. Missing evidence and mismatched artifacts reject by arm and file name.
Supplied bytes are captured once and their digests are included in the plan;
moving identical ledgers to another folder does not change their identity.
Optional `protected_corpus_file` names a known-regression corpus. The common
protected-corpus module replays the corpus's historical source and verifies its
portable input digests, mature fraud labels, observation window, accepted suite
and complete parameter snapshot, run identity, exact metric/verdict bytes, source
event identities and alerting rules. A caller-provided `detected` claim is not
evidence. `advanceProtectedCorpusVersion(previous, comparison, next)` is the same
explicit update interface used by the optional CLI argument.

Before evaluation, `comparison-plan.json` pins the target, admitted-change
proposal, metric version, and full SHA-256 digests of the exact source bytes.
`inputs/` preserves only the run seam's materialized inputs, including any
supplied translation provenance. Both runs use this same captured input folder.
History, outcomes, observation window, feature assumptions, tenant policy,
workload and all manifest settings therefore match. The only evaluation
difference is the proposal admitted by the existing authoritative catalog/suite
checks and its resulting derived features. A changed input starts a new pair.
Exact source line endings affect the comparison plan digest; existing portable
run and content-derived suite identities retain their established semantics.

The corpus v1 `source.input_digests` map uses SHA-256 of UTF8 text with CRLF
normalized to LF for `manifest.json`, `scenarios.jsonl`, and the suite YAML
files. Those are portable text identities, not claims of identical raw bytes.
The optional `admission.json` is opaque provenance under the run contract:
its digest is SHA-256 of the supplied bytes, with no decoding or normalization.
Corpus verification and successor creation preserve that distinction. The
comparison plan's input digests and the corpus file identity always hash raw
bytes, independently of the portable text identities inside the corpus.

`incumbent/` and `candidate/` hold the usual canonical ledgers, one aggregate
header and metric scope per run. `comparison.jsonl` holds one aggregate result
with separate comparison, run, suite, proposal and data-scope provenance.
It also repeats the evaluation input digests. When a corpus is supplied, the
result binds its raw SHA-256 content identity, lineage/version and
`known_regression` use, then writes one disposition per protected case. Each row
contains both the historical corpus evidence and the current evaluation evidence.
Input syntax errors reject the call; replay/admission failures record a named
ineligible result and diagnostic detail. A failed candidate never changes the
incumbent input or suite. Reusing a nonempty output directory rejects.

The count contract is the `case-merchant-counts-v1`. Maturity, authored
classifications, case identities, excluded merchants and unknowns come from its
assessment rows. No new legitimate denominator is inferred. Duplicate event or
rule hits count each case and merchant once. A suppress policy, inapplicable
assessment, absent outcome assessment, or unavailable rule evaluation cannot
establish eligibility. Missing evidence produces null results rather than zeros.

The verdict checks lost incumbent case identities first, then increased unique
legitimate flags, then strict improvement in the chosen target. Reasons are
`lost_incumbent_fraud_case`, `increased_legitimate_merchant_flags`,
`no_strict_target_improvement`, or `strict_target_improvement`. Weighted claims,
cost settings and unsupported money cannot override those protections. Monetary
assessment is explicitly unperformed with a null failure count.

Protected obligations come from the corpus, never from whichever cases remain in
the new dataset. A changed population, window or source that omits an obligation
returns `missing_protected_cases`; unknown, immature or rule-unavailable evidence
returns `unavailable_protected_cases`; failure to reproduce it under the incumbent
returns `incumbent_missed_protected_cases`; and candidate loss returns
`lost_protected_cases`. The result lists retained, missing, lost, unavailable,
incumbent-missed and not-yet-evaluated identities with counts whose sum equals
the corpus count. These
reasons take precedence over aggregate improvement, so a new detected case or
fewer legitimate flags cannot compensate for a lost protected identity.

Replay remains synchronous and deterministic, with no model calls. This operation
performs exactly two current run-seam evaluations, each subject to the manifest's event,
rule, result and daily-history bounds. Pair totals are twice those per-run bounds;
there is no candidate search or unbounded retry loop. A supplied corpus adds one
bounded, generator-free historical evidence replay per verification. Supplied ledgers add byte
verification, not further evaluations. The fixed fixture is 6 merchants, 5 days,
36 input events, 1 admitted rule and 12 scored event/rule results per arm.

Eligibility describes only this observed data scope. Even a dataset marked
`reserved-validation` receives `reserved_validation: not_assessed` and
`experimental_acceptance: not_assessed`. Corpus use is separately and explicitly
`known_regression`; it is permitted to be searched and is never called untouched
reserved assessment. An explicit successful update writes a new directory and
predecessor digest, preserving the prior corpus bytes. A failed check writes no
new corpus version and changes neither the incumbent inputs nor prior evidence.
Before writing a successor, the update replays the saved plan's proposal and
target on its captured inputs against the supplied prior corpus. It requires
actual strict target improvement, an identical complete plan and result, and
byte-identical file sets and artifacts for both saved arms. A caller-edited
eligibility field or count cannot authorize a version. Supplied-run digest
bindings are also reconstructed and checked. This adds two bounded current-arm
replays plus historical corpus verification; it does not run a search or assess
reserved validation. A self-consistent comparison still proves only its stated
observed data scope, not external approval or authenticity of unsigned inputs.
No candidate is promoted to production by either command.
