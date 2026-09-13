# Operate the packaged rule laboratory

Use this guide to run, inspect, verify, or replay the packaged laboratory. An
agent starts at the README, then this file.

## Start and prerequisites

From the package root, use Node 24 with local file and command tools. The
runtime uses only Node 24 built-ins; do not install packages, browse GitHub,
call a model, or use a personal path. The host must permit Node to launch its
child processes. A package is already built and extracted before this workflow
starts. Building or exporting a package is outside this runtime workflow.

Check the runtime before creating any evidence:

```sh
node --version
```

The version must start with `v24.`. If `node` is missing or reports another
major version, stop and ask the host owner to provide Node 24; do not install,
substitute, or silently continue with another runtime.

If Node reports a child-process launch failure such as `spawn EPERM` (including
an unhelpful wrapper error such as `Error:NaN`), treat it as a host-environment
blocker, not a rule result. Preserve the failed command and its partial output,
then obtain normal owner-approved host execution or report the workflow
blocked. Do not weaken a sandbox or global setting to make it run. An
execution-environment lifecycle failure after the commands finish is not
package troubleshooting.

Choose a new, empty output path for every command. The commands preserve an
existing path: `EEXIST` or `finished_package_output_exists` means stop, inspect
the old evidence, and select another named path. Never delete or overwrite a
ledger, experiment, replay, proof, or validation store to make a command run.

Create the ignored operator work root once if it is absent:

```sh
node -e "require('node:fs').mkdirSync('runs', { recursive: true })"
```

## Run the operator qualification workflow

The two examples and the configured history are invented materialized history.
They prove deterministic local behavior only; neither is a corporate-data
result, a production approval, or a vendor-engine change. Execute this full
workflow from a fresh extraction after the prerequisite and `runs/` creation
steps above.

```sh
node scripts/improve-example.ts runs/readable-success success
node scripts/improve-example.ts runs/readable-tie no-improvement
node scripts/improve.ts --replay runs/readable-success/experiment runs/readable-replay
node scripts/verify-finished-package.ts runs/finished-proof
```

Treat each command as a completion gate: before starting a dependent command,
check its exit status and the expected result or receipt. If one fails,
preserve its evidence and stop that sequence until its prerequisite is
resolved; do not batch dependent commands after a failure.

Read `experiment/result.json` after each example. The successful path reports
`reason: "completed_with_improvement"`, `accepted_count: 1`, retains protected
case `protected`, adds `new-jump`, and records
`production_promotion: "not_performed"`. The honest path reports
`reason: "no_valid_improvement"`, `accepted_count: 0`, and its reserved
comparison says `no_strict_target_improvement`; that is completed evidence, not
a command failure. The replay writes byte-identical canonical evidence to its
new output. The finished-package receipt says `invented_materialized_history_only`,
`deterministic_replay: "byte_identical"`, and `batch_step: "byte_identical"`.

## Run a configured history

`scripts/improve.ts` takes one JSON object with exactly these keys:

```json
{
  "search": "path/to/search-history",
  "reserved": ["path/to/fresh-reserved-history"],
  "corpus": "path/to/protected-corpus.json",
  "validation_store": "path/to/persistent-validation-store",
  "limits": {
    "target": "fraud_cases",
    "max_attempts": 3,
    "max_elapsed_ms": 60000,
    "max_input_bytes": 8000000
  }
}
```

Paths resolve from the package root. A history directory has its
`manifest.json`, `scenarios.jsonl`, and `suite/`; search declares the search
partition, while each reserved history is a separate mature observation.
`target` is `fraud_cases` or `legitimate_merchants`; limits are positive
integers bounded by 100 attempts, 60,000 milliseconds, and 64,000,000 input
bytes. The suite/catalog declare the only permitted changes. Do not add a
default rule, input, or limit when a required input is missing.

The complete invented example is packaged at
`fixtures/improvement/configured-history/operator-config.json`:

```sh
node scripts/validate.ts create runs/configured-history-validation 8000000
node scripts/improve.ts fixtures/improvement/configured-history/operator-config.json runs/configured-history-experiment
node scripts/improve.ts --replay runs/configured-history-experiment runs/configured-history-replay
```

Its expected result is `completed_with_improvement` with one experimental
acceptance; `fixtures/improvement/configured-history/README.md` names the
independent case interpretation. `validate.ts create` creates a store only
once. Reuse that store for later experiments; it records freezes, reservations,
and exposure, so a reused reserved observation is not fresh. Keep the store and
bring a new mature reserved history when the result says
`fresh_reserved_required` or validation refuses a reused/exposed observation.

For an operator-supplied experiment, create a copy of this JSON outside the
package, point every path at owner-supplied materialized histories and one
persistent store, predeclare the target and budgets, then run the same command.
No completed tenant configuration belongs in this published snapshot.

## Report qualification evidence

Report paths and values, not a remembered narrative. For each completed
command that writes a `result.json` or `receipt.json`, name that exact file,
copy `reason`, `accepted_count`, and `production_promotion` from a result, and
state whether the replay or finished-package verification completed. For a
successful `validate.ts create`, record exit 0, its `{"status":"created"}`
stdout status, and the persistent store path (including `config.json`). For
the version and work-root prerequisites, record the command and its exit
status rather than inventing a result file. For a failed attempt, name its
command, preserved output path, and the failure status; label a value that has
no file or result as `unavailable`.

Use these output mappings from this workflow:

- readable success: `runs/readable-success/experiment/result.json`; readable
  no-improvement: `runs/readable-tie/experiment/result.json`; readable replay:
  `runs/readable-replay/result.json`;
- configured experiment: `runs/configured-history-experiment/result.json`;
  configured replay: `runs/configured-history-replay/result.json`; and
  finished-package verification: `runs/finished-proof/receipt.json`.

Keep readable and configured records separate. When reporting the accepted
comparison, copy the exact IDs from the saved result: the search/readable
record names legitimate merchant `m-high`, while its distinct reserved
validation record names `r-m-high`; retained case `protected` and new case
`new-jump` are case IDs, not merchant IDs. Do not replace either identifier
with a readable label or infer it from another record.

## Interpret stops and failures

`scripts/improve.ts` returns exit 0 when it returns an experiment result,
including an honest no-improvement, `invalid_candidate`, `evaluation_error`,
or budget stop; inspect that experiment's `result.json`. It returns exit 2 for
its invalid argument shape and exit 1 for a thrown input, runtime, validation,
or evidence error. Its successful `--replay` route writes a new replayed
`result.json`; it is deterministic evidence, not a second experiment or a
production result.

`scripts/validate.ts` returns exit 0 for a successful command and exit 1 for
both invalid usage and validation/storage errors. `scripts/improve-example.ts`
returns exit 2 for invalid arguments and otherwise writes its experiment;
an uncaught execution error fails the command. `scripts/verify-finished-package.ts`
returns exit 2 for invalid arguments, exit 1 when its proof fails, and exit 0
only after it writes `receipt.json`. Its receipt is a bounded package proof,
not an experiment result.

Experiment terminal reasons include `completed_with_improvement`,
`no_valid_improvement`, `no_permitted_move`, `invalid_candidate`,
`evaluation_error`, `fresh_reserved_required`, `attempt_budget_exhausted`, and
`time_budget_exhausted`. `production_promotion` remains `not_performed` in
every package result. A successful experimental acceptance is automatic only
after the existing search, reserved, protected-corpus, and bounded checks;
production promotion and vendor encoding remain human-controlled acts.

Missing manifests, histories, corpus, Node 24, writable storage, mature
outcomes, or permitted changes are blockers, not values to infer. If an
operator task names `internal/missing-operator.json`, it is deliberately absent
from the package: stop and report the missing owner input rather than creating
or substituting it. An unavailable or immature outcome cannot authorize
experimental acceptance. Preserve partial output as evidence, diagnose the
named error, then start a new experiment only with corrected inputs; do not
weaken limits, relabel observations as fresh, delete evidence, or reset the
live store.

## Corporate owner checklist

Before an owner supplies a corporate configuration, they provide and authorize:

- semantic mapping and source/schema/snapshot versions;
- units, currency, daily/window definitions, deduplication, and time boundary;
- suitable search, distinct reserved, and protected histories with mature
  outcomes and a policy-approved resolution mapping;
- allowed rules, parameter ranges, target, budgets, validation-store custody,
  and authorization to use the material;
- policy, privacy, retention, access, and human approval requirements.

Until those inputs exist, stop. The invented package examples neither qualify a
tenant nor replace an owner decision. The configured fixture's renamed invented
merchant identifiers make a distinct example partition; renaming real data can
never refresh a reserved observation.

## Reusable short operator task

For a fresh agent, provide only the package directory and
[`docs/operator-tasks/run-rule-lab.md`](operator-tasks/run-rule-lab.md). The
task tells it to discover and use this guide without a chat-history recipe.
