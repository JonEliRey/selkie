# Authored outcomes and scenario performance

Optional `authored_outcomes` extends the existing daily
selected-suite replay manifest. Generated runs use the same replay and outcome
contract. A manifest without this option keeps its existing ledger behavior.

The contract pins an outcome `version`, `dataset_id`, `partition` (`search` or
`reserved-validation`), the run's exact date-valued `observation_window`, a UTC
`as_of` outcome timestamp and `stories_enabled`. `merchants` explicitly supplies
each evaluated merchant's `classification` (`fraud`, `legit`, `unknown`) and
`available_at`. `cases` supplies unique `case_id`, merchant, `outcome`, outcome
availability and a half-open scored-event interval `from`/`to` within the window.
Case intervals are assessment attribution windows, not claims about first loss
or intervention. Optional evidence is explicitly null: `taxonomy_version` and
`category` travel together; `merchant_role` is perpetrator, complicit, victim,
unknown or null. Taxonomy and role do not add event types or relationship rules.

Every case must bind an evaluated event's case ID and every classified merchant
must have evaluated events. Unknown identities, duplicate IDs, overlapping case
intervals, conflicting event labels, window mismatches and a legitimate merchant
with an authored fraud case reject before any output. The contract's two arrays
are individually bounded by `workload.max_events`. Case truth and maturity are
never passed to feature construction. Local generation binds cases to events by
the authored merchant and scored-event interval after drawing the history.

`authored-outcomes.jsonl` records supplied and effective truth, maturity, taxonomy
and role, with the run and dataset provenance. Future availability excludes a
case from mature detection counts. A merchant counts as legitimate only when its
classification is mature legit and every supplied case for it is mature legit.
Unknown or immature cases therefore cannot silently qualify a merchant. Turning
stories off makes effective fraud unknown; it retains supplied truth for audit
and does not relabel fraud as legitimate or promise zero alerts.

`scenario-metrics.jsonl` contains one aggregate suite row (`rule_id: null`) and
one aggregate row per admitted rule. It never repeats aggregate totals by
segment. Each row reports detected and missed fraud case IDs/counts, the mature
fraud case denominator, unique legitimate merchant IDs/denominator and the
incorrectly flagged subset. Unknown and immature case IDs are separate lists
and can overlap: an unknown outcome can also be immature. Excluded merchants are
listed explicitly. A case is detected only by an actual `alert` on one of its
bound events in the window. Multiple events and rule hits cannot multiply counts.

Assessment scope is mature fraud cases plus unique legitimate merchants. Its
assessed count is the sum of those two denominators and its failure count is
missed cases plus incorrectly flagged merchants. No eligible observations gives
`inapplicable`, count 0 and null failures. Unresolved `fire_on: suppress` gives
`unperformed`, count 0, null failures and null detection/flag counts and sets.
Corporate effectiveness is separately unperformed with null failures. These are
descriptive authored-dataset assessments, not a candidate acceptance gate or
population-confidence test. Existing monetary fields remain null.

Manifest contents bind outcome/scenario identity and assessment assumptions to
the run ID; history/configuration and seed provenance retain the established
contracts. Changes to truth, maturity, partition, observation window or stories
mode start separate runs. Outcome changes may change provenance and assessment
artifacts but cannot alter earlier features or verdicts. Repeated canonical
artifacts are byte-identical, including after saved-history replay.

The portable fixed-history fixture is `fixtures/run/authored-outcomes`.
Neither this implementation nor developer inspection proves restricted search
access, untouched validation, corporate effectiveness, payment/refund linkage,
prevented fraud or monetary savings.
## Per-row input identity

Every authored evidence row and aggregate/per-rule scenario metric carries the
common history source/schema/snapshot and suite/parameter identities, the seed,
`source_history_hash` (the original portable history digest), and
`authored_outcomes_hash` (SHA-256 of the canonical supplied outcome contract).
Supplied and effective labels share this trace even when stories are disabled.
For generated materializations, `history_source_id` retains the existing
`generated:<version>:<canonical-config-sha256>:seed:<seed>` identity. Thus saved
historical replay retains the exact configuration identity without importing the
generator; ordinary historical sources receive no fabricated generator identity.
Enum values must be JSON strings; only the optional merchant role admits null.
