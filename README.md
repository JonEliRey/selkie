# Rule laboratory

This repository contains a deterministic, local rule-improvement laboratory and invented merchant histories. It is an operator package: an agent can run and inspect the complete example, replay its evidence, and try an owner-supplied materialized history. It does not connect to a tenant or promote a rule to production.

For an orientation before following the workflow, see the [visual architecture and component map](docs/architecture.md), or open its [offline HTML/SVG counterpart](docs/architecture.html) locally. These maps are navigation aids; [the operator guide](docs/operate-rule-lab.md) remains the execution authority.

Start with [the operator guide](docs/operate-rule-lab.md). A fresh agent needs only this repository and the task in [run-rule-lab.md](docs/operator-tasks/run-rule-lab.md). The guide lists commands, expected result files, recovery steps, and the boundary between an experimental result and a human production decision.

The runtime requires Node 24 and its built-in modules. It requires no package installation or model call. From a fresh clone, run the guide's ordered workflow, beginning with `node --version`. To check the focused verification tests directly:

```sh
node --test test/assisted-parser.test.ts test/permitted-proposal.test.ts test/scenario-outcomes.test.ts test/comparison.test.ts test/reserved-validation.test.ts test/bounded-improvement.test.ts test/historical-stepper.test.ts
```

All bundled histories, cases, and names are invented. Their outcomes demonstrate local behavior, not accuracy on a corporate population. Place any authorized, tenant-sourced inputs and generated results in ignored local paths such as `internal/` and `runs/`; never commit them. Only a human may approve a production change, and the vendor team encodes it in the production engine.

This is a curated operating snapshot. It carries no claim about tenant validation or production readiness.
