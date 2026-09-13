# Daily transaction totals through the run interface

Add `daily_totals` to a selected-suite `replay` manifest. Use `node scripts/run.ts fixtures/run/daily-totals <empty-output-directory>` on Node 24. The same `runCase` boundary handles materialized history; no generator or extra runtime dependency is involved. Runs without this option retain their existing schemas and behavior, including alert-origin run zero.

## Input contract

The invented fixture is the complete worked input. Its manifest pins:

| Field | Supported value or meaning |
| --- | --- |
| `feature` | A nonreserved catalog feature name; catalog kind `derived`, unit `minor_currency_units`, `window_days: 1` |
| `counted_kind` | `settlement` |
| `units` | `minor_currency_units`; non-negative safe integers, including the aggregate sum |
| `currency` | One currency matching the tenant, manifest and every input event; no FX conversion |
| `lifecycle` | `one_settlement_per_transaction` |
| `day_boundary` | `midnight_utc_t_minus_1`, the existing **open** corporate-fact default |
| `coverage` | One row per merchant with `merchant_id`, stable `segment`, inclusive `from`, exclusive `to` |

Each event requires `transaction_id` in addition to the selected-suite event fields. Optional top-level `label` is `fraud`, `legit` or `unknown`; it stays in source evidence and is never supplied to rules or aggregates. `case_id` likewise does not set a feature. Authorizations and settlements remain the only admitted event kinds and both are scored. Settlement-only counting means a USD 20 authorization followed by its USD 20 settlement contributes **2,000 cents**, not 4,000. A second settlement with the same merchant/transaction rejects rather than silently dropping, adding, or correcting it. Transaction IDs are merchant-local, and repeated authorizations contribute zero. The contract does not claim support for split settlement, FX, reversals, or refund lifecycle accounting.

All event and coverage timestamps must be canonical `YYYY-MM-DDTHH:mm:ss.sssZ`, validated against the calendar. This bounded input format avoids host timezone dependence. `comparability.observation_window` uses dates with inclusive `from` and exclusive `to`. Every raw event must fall in its merchant's declared coverage, match tenant/segment/currency, and omit the computed daily feature from `fields`. Unknown daily configuration keys, duplicate merchant coverage, missing transaction identity, invalid amounts, and contradictory catalog definitions reject before output. Source completeness is declared by the caller, not independently established here.

## Clock and missing evidence

For each evaluation date B, the snapshot contains settlement value from `[B - 1 day, B)`. Exact-midnight settlement activity belongs to the new day and cannot enter B's snapshot. The event at B attaches inclusively to B's snapshot, as do later events that day. The raw history is retained in the ledger, but only events inside the evaluation window produce verdicts and event counts; prior history is warmup, and future input is not an evaluation event.

The merchant-day grid starts one day before evaluation and ends at evaluation `to` (exclusive). It includes merchants with declared coverage even if they have no events, with these statuses:

| Status | Meaning | Total / availability |
| --- | --- | --- |
| `complete` | The entire day lies within declared coverage | Sum, or zero for a covered empty day; available at its next midnight |
| `missing_history` | The whole day precedes coverage | null |
| `partial_history` | Coverage starts within the day | null |
| `open_day` | Coverage's exclusive watermark has not reached day close | null |

`open_day` also covers a requested day beyond the source watermark. A partial start takes precedence when both edges lack coverage. A rule with matching tenant/risk scope that reads the unavailable daily feature receives `verdict: unavailable`, `fired: null` and the status as `unavailable_reason`; other rules retain ordinary evaluation. This expresses missing feature evidence rather than a negative detection result. An empty complete day is evidence of zero only under the caller's coverage assertion. A day's completed observation creates no artificial event or alert: detection waits for a real scored event after close.

## Ledger joins and bounded storage

The three added canonical JSONL tables are:

- `merchant-days.jsonl`: one observation per merchant/day, with `observation_id`, segment, total/status, warmup flag, exact half-open observation and coverage boundaries, and nullable `available_at`.
- `feature-snapshots.jsonl`: one snapshot per merchant/evaluation day, with `snapshot_id`, `as_of_day`, value/status and `observation_id` linking to the preceding day.
- `feature-definitions.jsonl`: one definition of the counted quantity, lifecycle, one-day window, strict build, inclusive attachment, scored kinds and missing-history behavior.

Each added row carries run ID, historical source/schema/snapshot versions, source-history hash, suite/parameter identity, day boundary and feature-definition ID. The definition ID hashes canonical measurement semantics; the manifest/run identity also binds coverage, catalog and the raw history. Snapshot and observation IDs are JSON-encoded merchant/date pairs, scoped by `run_id`. Verdicts add `snapshot_id`, `feature_definition_id` and nullable `unavailable_reason`. The unchanged source scenarios table retains transaction identity and authored outcomes; it is deliberately not replaced with computed features. Whole-run metrics remain aggregate counts and unsupported monetary claims remain null.

Raw input rows, including warmup/future rows, still count against  `max_events` and conservative `max_results = raw events × admitted rules`. The merchant-day grid independently must fit `max_events`; snapshots are a subset. All checks run before daily aggregation/evaluation and reject rather than sample. The supported ceilings remain 250,000 events, 64 rules and 8,000,000 results. This is a storage/cardinality bound, not a measured performance promise. The existing consolidate interface accepts its established ledger contracts; daily ledgers are a new contract and are not admitted to consolidation by this package.

## Worked evidence and delivery scope

The fixture's settlement totals are Feb 1: 2,000; Feb 2: 7,000 + 4,000 = 11,000; Feb 3: 900; Feb 4: zero. With a threshold strictly above 10,000, the two Feb 2 burst events do not fire; both Feb 3 events alert on Feb 2's completed total; Feb 4 does not fire. The Feb 1 rows are warmup.

Local invented fixtures establish specified behavior only. Corporate timing, source suitability and independent review remain separate. The bundled fixed daily-total fixture includes expected tables that can be compared with a fresh local run.
