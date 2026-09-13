# Configured-history operator example

This is invented, materialized history for the public operator configuration
route. It is not a corporate configuration or a qualification result.

Run it from the package root with a new, absent validation-store path. This
example creates that persistent store once, then uses it for the experiment and
replay. For runtime, version, work-root, and parent-package prerequisites, use
`docs/operate-rule-lab.md`.

```sh
node scripts/validate.ts create runs/configured-history-validation 8000000
node scripts/improve.ts fixtures/improvement/configured-history/operator-config.json runs/configured-history-experiment
node scripts/improve.ts --replay runs/configured-history-experiment runs/configured-history-replay
```

The search history is the independently worked paired-history input. The
reserved history changes every merchant identifier and declares the distinct
`reserved-validation` partition, so it cannot stand in for the search
observation. The expected result is `completed_with_improvement` with one
accepted experimental change: the existing permitted conversion detects
`new-jump`, retains `protected`, and removes the legitimate `r-m-high`
flag. This is experimental evidence only; `production_promotion` remains
`not_performed`.

The store belongs to the operator and must be kept for later experiments.
Reusing this reserved observation after an acceptance or exposure is not a
fresh validation claim; provide a new, mature reserved history instead.
