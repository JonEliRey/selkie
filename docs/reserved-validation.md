# Frozen reserved validation

Frozen reserved validation uses saved materialized
history and deterministic replay; no model, generator,
or day-stepper is required. A passed reserved assessment is **not complete
experimental acceptance**. Protected-corpus identity remains null and its assessment
remains `not_assessed` until the separate protected-case obligations are implemented.
No command promotes a suite or changes an incumbent.

## Operator workflow

Use Node 24. Create one operator-owned store per continuing experiment lineage and
preserve it across search attempts and process restarts:

```text
node scripts/validate.ts create STORE 2000000
node scripts/compare.ts SEARCH_INPUTS PROPOSAL.yaml fraud_cases SEARCH_COMPARISON
node scripts/validate.ts freeze STORE SEARCH_COMPARISON
node scripts/validate.ts reserve STORE RESERVED_INPUTS
node scripts/validate.ts evaluate STORE FROZEN_ID RESERVED_VERSION
node scripts/validate.ts evidence STORE FROZEN_ID RESERVED_VERSION
node scripts/validate.ts replay STORE FROZEN_ID RESERVED_VERSION REPLAY_OUTPUT
node scripts/validate.ts expose STORE FROZEN_ID RESERVED_VERSION
node scripts/validate.ts usage STORE RESERVED_VERSION
```

`freeze` replays and verifies every saved comparison artifact before accepting an
eligible search winner. The frozen content includes the full proposal, complete
incumbent and candidate run artifacts, original suite and catalog, admission evidence
when present, manifest, scenarios, and the target chosen during search. Full byte
digests bind the snapshot; changing one component produces a named mismatch before
reserved evaluation. Reserved suite bytes and policy definitions must match the
frozen authority. Dataset-specific coverage, observation windows, history versions,
outcomes and seed remain in reserved provenance. Workload bounds stay pinned.

`reserve` captures exact historical inputs. It does not evaluate or disclose them to
the proposer. A reserved manifest must name partition `reserved-validation` at
evaluation; search and known-regression purposes cannot silently become reserved
evidence. Both arms execute the same captured inputs using the pinned target. The
existing comparison reports case identities, unique legitimate flags, unknowns,
immaturity, unavailable evidence and unperformed monetary assessments without
substituting zero or acceptance. Missing/incompatible search evidence cannot freeze.

`evaluate` consumes use before executing either arm. A failed, interrupted or
successful attempt never makes those observations untouched again. Repeating exact
data under a new directory, version/dataset name, event alias, row ordering or JSON
format does not refresh it. Observation identity uses the run's daily event schema:
merchant, tenant, risk type, event kind, timestamp, amount, currency, score and its
provenance, complete feature fields, and transaction identity. Event aliases,
authored case bindings, reporting segments and optional labels are annotations,
so removing, adding or changing them cannot reset use. Canonical JSON removes
number spelling and object-key ordering differences; observation sets ignore row
ordering. Daily timestamps retain the run's required canonical UTC representation.
Every original byte, including all annotations, still binds the reserved snapshot,
assessment provenance and deterministic replay. Reusing even
part of previously assessed observations is rejected. Search observations cannot
overlap the reserved set. This is conservative protection of the supplied observations,
not detection of an operator deliberately inventing new merchant identities to
disguise the same real data.

The use log records claimed/completed/exposed/rejected transitions and named reasons.
Every row contains frozen and reserved content identities, original input digests,
both full manifests (including source/outcome/dataset versions, feature definitions,
seed, workload), proposal and target. Frozen candidate rows carry complete rule,
parameter and bound provenance. These are materialized histories; no generator is
invoked. For originally generated evidence, retain the original generation artifacts
alongside that history; this command does not reconstruct missing generator provenance.

Before feedback of any kind is given to later search, including a single pass/fail
bit, the operator must call `expose`. This permanently invalidates `evidence` for
that assessment. `replay` still verifies and reproduces the historical bytes; it
does not create a new assessment or renew untouched status. `evidence` checks current
exposure state and replays the saved artifacts to verify them, but returns the
explicit reserved result including failure, never a full acceptance decision.
Any subsequent proposal needs fresh, non-overlapping reserved observations.

## Verification

`node --test test/reserved-validation.test.ts`
tests the frozen-validation boundary. The matrix uses an invented worked history:
fixed threshold 10,000; small-history reference 144.47739; large-history reference
14,447.739. Invented reserved merchant identities are separate. Authored amount
variants demonstrate legitimate growth, fraud escalation, substitution, wrong-target
gain, ties, unavailable references and saved replay. Expected case/merchant sets
are literal. A deliberate mutation disables the exposure gate and proves that the
ordinary feedback test fails on behavior, not an import or fixture error.
The ordinary label-removal regressions reject exposed reuse and search overlap in
fresh Node processes; a source mutation restoring raw label-sensitive identity
makes both fail. Further public checks cover label addition/change, alias and
reporting annotations, representation changes, partial overlap, every meaningful
observation field, and later events that can supply fresh final evidence.

Existing fixed invented comparison fixtures suffice; no generator fixture is
newly selected. Builder checks do not replace independent review or human
acceptance.
