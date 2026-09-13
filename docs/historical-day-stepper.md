# Historical day-stepper

The day-stepper is execution control over the existing selected-suite `replay`
run. It calls the same public `runCase` seam and evaluator once to build one
bounded execution plan, then publishes the canonical ledger prefix for exactly
one required UTC calendar day at a time. It does not implement rules, daily
totals, merchant references, verdicts, or proposal semantics a second time.

Run a fixed list of days with plain Node:

```text
node scripts/step.ts <case-dir> <new-output-dir> 2026-02-02 2026-02-03
```

Omit the dates for a line-oriented session. The process names the next required
day; after each accepted line, another terminal can inspect the output tables.
Programmatic callers use `startHistoricalDayStepper(...).advance(day)` at the
same public run boundary. A session owns a new output directory. Start a new
session in a separate directory after an interruption or an input change.

## Cursor and observable state

`step-state.json` is deliberately separate from the canonical ledger. It pins
the run identity, full observation window, completed and next days, complete
input digests, and the digest of every currently published output file. Its
`status` is `in_progress` until the last required day and `complete` only after
that day is published. The manifest, full source scenario artifact, admitted
rules, and definitions keep their full-run identity while verdicts, feature
snapshots, reference assessments, merchant-day observations, and aggregate
event/alert counts expose only the accepted prefix. A no-event day advances the
cursor without inventing a result.

Authored outcome evidence and scenario metrics describe the completed
observation window rather than an individual execution day. While the cursor is
`in_progress`, their canonical files are present but contain zero rows: this
neither reveals a future authored result nor presents a prefix as a full-window
assessment. The final advance replaces both with the evaluator's exact batch
bytes. Proposal-attempt evidence remains visible because it records admitted or
rejected input authority and `not_assessed` experimental acceptance, not a
future outcome result.

An advance accepts only `next_day`. Rejections are named:

- `invalid_step_day` for a non-calendar date;
- `duplicate_step_day` for any already completed day;
- `out_of_order_step_day` for any other day while work remains; and
- `run_already_complete` after the last day.

Before replacement, the stepper verifies the prior cursor, all published bytes,
and the pinned manifest, scenario history, admitted and unadmitted rule files,
catalog, tenant, saved translation, and supplied proposal representation. A
rejected attempt does not replace any prior result or cursor byte. Changed
inputs require a new output directory and therefore a separately identified
candidate run. Raw proposal bytes, when supplied, must decode to the proposal
the evaluator receives.

Only canonical JSONL tables are decoded for prefix projection. Supplied
artifacts such as `source-translation.json` are opaque byte sequences: the
stepper hashes, carries, and writes them without a text decode/encode round trip.

## Publication recovery

Directory publication uses same-filesystem renames. Each rename makes at most
five attempts: the initial attempt plus four bounded waits (5, 10, 20, and 40
milliseconds) for Windows `EPERM` or `EBUSY`. Other errors are not retried. If
publishing the next directory fails after the accepted directory was moved
aside, the same bounded policy restores the accepted directory before the
publication error is returned.

If restoration exhausts those retries, the step reports
`historical_step_restore_pending`; a non-transient restoration error reports
`historical_step_restore_failed`. In both cases the accepted backup is retained,
the in-memory cursor is not advanced, and `status()` or `advance()` on that same
active session attempts restoration again before reading or publishing state.
The session reports neither rejection recovery nor completion while the
canonical path is unavailable.

Failure to remove the rejected staging directory cannot mask a pending accepted
backup: the restoration diagnostic remains primary and its aggregate cause
retains the publication, rollback, and staging-cleanup errors. The rejected
staging directory may remain beside the output until storage access returns; it
is never treated as canonical state.

After a successful publication, failure to remove the now-obsolete previous
directory does not turn that accepted cursor into a rejection. The active
session exposes each debt through `cleanupDiagnostics()` as
`historical_step_cleanup_pending`, including its attempt count and original
filesystem cause. `status()` and `advance()` each make one removal attempt per
retained obsolete backup, then continue with the accepted canonical state; a
later successful attempt clears that diagnostic. The diagnostics are
in-process operational state and are never written into the cursor or canonical
ledger bytes. At most one cleanup debt can be added by initial publication and
by each admitted day, so retry work is bounded by the 31-day session envelope.
An accepted backup retained because canonical restoration failed is not
obsolete and is never handled by this cleanup path.

This is bounded recovery, not a promise of atomic progress under permanent
storage denial. If the filesystem remains unavailable, the canonical path can
remain absent even though the accepted bytes survive in the retained backup. If
the process ends in that state, there is no supported cross-process resume;
preserve the backup and diagnose the storage problem rather than deleting it or
starting a new session over that output path.

On completion, every canonical batch table is copied from the one execution
plan byte-for-byte. This includes the run header, rules in run, scenarios,
verdicts, metrics, daily/reference tables, authored outcomes, scenario metrics,
and admitted proposal-attempt and translation artifacts when those routes are
used. The run identity, full manifest and input provenance stay fixed throughout
the session; zero-row in-progress outcome tables are an execution projection,
not a different canonical final identity. `step-state.json` remains as
execution-control evidence and is not a canonical ledger table.

## Bounded workload for later measurement

Step mode has a deliberately smaller admission envelope than the existing batch
limits:

| Quantity | Step limit |
| --- | ---: |
| Observation days | 31 |
| Source events, including warmup | 10,000 |
| Admitted rules | 16 |
| Estimated event-by-rule results | 160,000 |
| Materialized canonical plan bytes | 64 MiB |

The day count is computed arithmetically and compared before any array of day
strings is constructed. Other counts are checked before evaluator work where
the manifest permits it; the
actual canonical byte total is checked before any operator output is created.
There is no sampling or truncation. The evaluator runs once. Each accepted day
projects and atomically replaces a prefix from that bounded plan, so the worst
case is 31 bounded projection passes rather than 31 evaluator replays. During a
replacement, the previous and next directories can transiently consume up to
twice the canonical-plan byte limit; the in-memory plan and parsed rows add
runtime overhead that a later measurement must capture.

These values define the reproducible interactive workload. This document
makes no latency, throughput, or peak-memory claim: those require a named
machine and measurements in that later performance work.
