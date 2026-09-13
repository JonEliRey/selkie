# Bounded experimental rule improvement

The bounded workflow advances only a local experimental
incumbent advances. Production promotion is a human decision; no corporate
execution or effectiveness is claimed.

Run the complete invented example on Node 24:

```sh
node scripts/improve-example.ts runs/readable-success success
node scripts/improve-example.ts runs/readable-tie no-improvement
node scripts/improve.ts --replay runs/readable-success/experiment runs/readable-replay
```

Both examples replay the accepted invented source, saved assistance and independent
expectations through `scripts/translate.ts`. The translated rule is the existing
incumbent. An explicit operator authority artifact adds unused reference
parameters and conversion permission before search. The original fixed threshold
and conditions remain intact. USD cents are explicitly mapped to USD minor units
for daily computation. Each original expected test retains its outcome and input
fields, with an additional 1250-cent reference input; that reference is unused by
the incumbent and permits the same boundary tests to check conversion. Original
admission bytes remain unchanged through proposal and evaluation provenance.

For other admitted historical inputs, `scripts/improve.ts` accepts an operator
JSON configuration with exactly `search`, `reserved` (an ordered list of fresh
history directories), `corpus`, `validation_store`, and `limits`. Paths resolve
from the working directory. Create the persistent validation store through the
existing validation interface before running an experiment; preserve it across
experiments so previously used observations cannot be presented as untouched.
The command's second argument is a new experiment directory.

The package's ordered operator workflow and a complete invented configured
history are in `docs/operate-rule-lab.md` and
`fixtures/improvement/configured-history`. They are the runtime entry point;
this document remains the detailed experimental contract.

The example pins target `fraud_cases`, 3 attempts, 60000 elapsed milliseconds and
8000000 captured input bytes per snapshot before search. Supported maxima are
100 attempts, 60000 milliseconds and 64000000 bytes. Existing run workload
bounds also apply. Time includes initial measurement and final verification;
checks occur at stage boundaries, so an individual synchronous bounded replay
can finish after the deadline. It cannot then authorize acceptance. The trusted
operator can inject a monotonic clock for deterministic deadline tests.

`startImprovement` supplies a proposer with only a JSON context and a JSON request
function. Its tools are `read_search` and `evaluate_search`, using an exact
allowlist of saved search inputs. No shell, filesystem, network, generator,
reserved store or validation handle is supplied. This is the validation capability
boundary, not a sandbox for arbitrary JavaScript granted host privileges.
Unknown tools and paths are refused. Proposals still pass authoritative
admission, including protection of bounds, tests, labels and generator targets.

The common deterministic client chooses a conversion, or one sensitivity step,
from the admitted rules, catalog permissions and observed search count summary.
It selects at most one candidate per automatic invocation. The public bounded
capability also permits successive proposals within the declared attempt/time
limits. Every submitted candidate and each applicable attempted, admitted or
rejected, evaluated, frozen, validated, protected, accepted or discarded stage
is saved, with proposal, suite, translation, data, validation and corpus identities.
Request denials and budget refusals are kept in the request transcript.

A selected candidate must be a strict search winner, pass frozen reserved
validation, retain every incumbent-detected fraud identity without increasing
unique legitimate flags, strictly improve the predeclared target, and retain
every protected corpus obligation. The protected comparison replays the same
reserved inputs and candidate. Its corpus successor repeats the existing
verification before the incumbent pointer changes. Inputs and the prior corpus
are never edited. Corpus source locators are relocated into the experiment;
the exact relocated corpus bytes and historical input digests identify the
authority used by every comparison.

Stops are explicit: `invalid_candidate`, `evaluation_error`,
`no_permitted_move`, `no_valid_improvement`, `fresh_reserved_required`,
`attempt_budget_exhausted`, `time_budget_exhausted`, or
`completed_with_improvement`. An accepted incumbent survives a later failure
or exhaustion. The experiment stores full stage evidence even if time expires
after evaluation. An interrupted directory is evidence, not a resumable success;
reopening it for a new experiment is refused. The trusted operator owns storage
integrity and a single active controller for each experiment.

Reserved feedback is excluded from proposer responses. An operator releasing
it for later search uses `releaseFeedback()`, which records exposure through
the validation store; `finalEvidence` then refuses the exposed assessment. Later claims need
fresh reserved observations. Historical experimental acceptance is not erased
when its evidence is later exposed. Merely renaming or relabeling observations
does not refresh them. The initial validation-use frontier is captured for
audit replay; replay works in a private copy and never resets the live store or
makes a new untouched-data claim.

A subsequent evaluation request also automatically marks prior reserved results
exposed: the advanced incumbent or a terminal refusal can implicitly reveal an
earlier acceptance decision even when no explicit feedback release occurred.

`replayImprovement` regenerates requests, evaluations, corpus transitions and
acceptance from the saved inputs and usage frontier, then compares every
canonical artifact byte-for-byte. Operational elapsed readings live separately
in `timing.jsonl`; replay uses them only to reproduce the recorded stop boundary.
No model call occurs in evaluation, acceptance or replay. Changing source data
or a proposal starts another experiment.

Known limitations remain: authored case identities are trusted, corpus
successors retain current protected membership, and verification does not walk
an independent version chain. Unavailable aggregate evidence cannot authorize
acceptance. No money score, generator, frontend, deployment,
or production claim is included.
