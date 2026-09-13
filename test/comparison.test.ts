import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceProtectedCorpusVersion, compareRuns } from "../src/seams/comparison.ts";
import { portableInputDigests, verifyProtectedCorpus } from "../src/seams/protected-corpus.ts";
import { parseYaml } from "../src/yaml.ts";
import { runCase } from "../src/seams/run.ts";

// Authorized public run/proposal/comparison boundary. Expected sets are worked
// from the fixed histories in the fixture README, never from replay output.
const fixture = "fixtures/comparison/paired-history";
const protectedCorpus = "fixtures/comparison/protected-corpus/v1.json";
const proposal = () => parseYaml(readFileSync(`${fixture}/proposal.yaml`, "utf8"));
function workspace(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "fwh-comparison-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input"), out = join(root, "output");
  cpSync(fixture, input, { recursive: true }); mkdirSync(out);
  const manifest = JSON.parse(readFileSync(join(input, "manifest.json"), "utf8"));
  return { root, input, out, manifest, save: () => writeFileSync(join(input, "manifest.json"), JSON.stringify(manifest)) };
}
test("paired historical replay strictly reduces legitimate flags and retains the protected case", t => {
  const out = mkdtempSync(join(tmpdir(), "fwh-comparison-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const result = compareRuns(fixture, out, { target: "legitimate_merchants", proposal: proposal() });
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.reason, "strict_target_improvement");
  assert.deepEqual(result.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.lost_fraud_case_ids, []);
  assert.deepEqual(result.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(result.legitimate_merchants, { denominator: 2, incumbent: ["m-high"], candidate: [], incumbent_count: 1, candidate_count: 0 });
  assert.equal(result.reserved_validation, "not_assessed");
  assert.equal(result.experimental_acceptance, "not_assessed");
  const oracle = JSON.parse(readFileSync(`${fixture}/expected.json`, "utf8"));
  for (const [key, expected] of Object.entries(oracle)) assert.deepEqual(result[key as keyof typeof result], expected, key);
});

test("missing outcome evidence records an ineligible comparison without treating absence as zero", t => {
  const w = workspace(t); delete w.manifest.authored_outcomes; w.save();
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.reason, "missing_required_assessment");
  assert.equal(result.legitimate_merchants, null);
  assert.equal(result.retained_fraud_case_ids, null);
});

test("unperformed suppress-policy assessment cannot establish improvement", t => {
  const w = workspace(t);
  const tenant = join(w.input, "suite/tenant.yaml");
  writeFileSync(tenant, readFileSync(tenant, "utf8").replace("fire_on: alert", "fire_on: suppress"));
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.reason, "unperformed_required_assessment");
  assert.equal(result.legitimate_merchants, null);
});

test("comparison reports unknowns and maturity without changing the established legitimate denominator", t => {
  const w = workspace(t);
  // A nominally legitimate merchant with an unresolved case is not in the denominator.
  w.manifest.authored_outcomes.merchants.find((m: {merchant_id: string}) => m.merchant_id === "m-unknown").classification = "legit";
  w.save();
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.eligibility, "eligible");
  assert.deepEqual(result.unknown_case_ids, ["unresolved"]);
  assert.deepEqual(result.immature_case_ids, ["pending"]);
  assert.equal(result.fraud_case_denominator, 2);
  assert.equal(result.legitimate_merchants?.denominator, 2);
  assert.deepEqual(result.excluded_merchant_ids, ["m-immature", "m-new", "m-protected", "m-unknown"]);
  assert.deepEqual(result.monetary_assessment, { status: "unperformed", assessed_count: 0, failure_count: null });
});

test("target and exact source artifacts are pinned in the plan and deterministic comparison identity", t => {
  const w = workspace(t);
  const first = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  const plan = JSON.parse(readFileSync(join(w.out, "comparison-plan.json"), "utf8"));
  assert.equal(plan.target, "fraud_cases");
  assert.deepEqual(Object.keys(plan.input_digests).sort(), ["manifest.json", "scenarios.jsonl", "suite/catalog.yaml", "suite/rules/lantern-daily.yaml", "suite/tenant.yaml"]);
  for (const [path, digest] of Object.entries(plan.input_digests)) assert.equal(digest, createHash("sha256").update(readFileSync(join(w.input, path))).digest("hex"));
  assert.equal(first.data_scope?.dataset_id, "invented-paired-history-v1");
  assert.equal(first.data_scope?.partition, "search");
  assert.equal(first.data_scope?.metric_version, "case-merchant-counts-v1");
  const secondDir = join(w.root, "again"); mkdirSync(secondDir);
  const second = compareRuns(w.input, secondDir, { target: "fraud_cases", proposal: proposal() });
  assert.deepEqual(first, second);
  for (const name of ["comparison-plan.json", "comparison.jsonl"]) assert.deepEqual(readFileSync(join(w.out, name)), readFileSync(join(secondDir, name)));
  const otherDir = join(w.root, "other"); mkdirSync(otherDir);
  const other = compareRuns(w.input, otherDir, { target: "legitimate_merchants", proposal: proposal() });
  assert.notEqual(first.comparison_id, other.comparison_id);
  assert.equal(first.incumbent_run_id, other.incumbent_run_id);
  assert.equal(first.candidate_suite_id, other.candidate_suite_id);
  for (const arm of ["incumbent", "candidate"]) {
    for (const name of readdirSync(join(w.out, arm))) assert.deepEqual(readFileSync(join(w.out, arm, name)), readFileSync(join(secondDir, arm, name)));
  }
});

test("supplied run metrics must be bound to actual replay rather than copied identity metadata", t => {
  const w = workspace(t), a = join(w.root, "a"), b = join(w.root, "b"); mkdirSync(a); mkdirSync(b);
  runCase(w.input, a); runCase(w.input, b, { proposal: proposal() });
  const path = join(b, "scenario-metrics.jsonl");
  const metrics = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  metrics[0].detected_fraud_case_ids = ["fabricated-case"];
  writeFileSync(path, metrics.map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal(), supplied_runs: { incumbent: a, candidate: b } });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.reason, "incompatible_paired_artifact:candidate:scenario-metrics.jsonl");
  assert.equal(result.retained_fraud_case_ids, null);
});

test("supplied evidence bytes participate in comparison identity and cannot be relabelled after pinning", t => {
  const w = workspace(t), a = join(w.root, "a"), b = join(w.root, "b"); mkdirSync(a); mkdirSync(b);
  runCase(w.input, a); runCase(w.input, b, { proposal: proposal() });
  const request = { target: "fraud_cases" as const, proposal: proposal(), supplied_runs: { incumbent: a, candidate: b } };
  const valid = compareRuns(w.input, w.out, request);
  const path = join(b, "verdicts.jsonl"); writeFileSync(path, readFileSync(path, "utf8") + "\n");
  const out = join(w.root, "tampered"); mkdirSync(out);
  const tampered = compareRuns(w.input, out, request);
  assert.notEqual(tampered.comparison_id, valid.comparison_id);
  assert.equal(tampered.eligibility, "ineligible");
});

function changeAmounts(input: string, merchant: string, amounts: number[]) {
  const path = join(input, "scenarios.jsonl");
  const events = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  let i = 0;
  for (const e of events) if (e.merchant_id === merchant && e.kind === "settlement") e.amount = amounts[i++];
  writeFileSync(path, events.map(e => JSON.stringify(e)).join("\n") + "\n");
}

test("fraud-only strict improvement does not increase legitimate flags and cannot satisfy the other target", t => {
  const w = workspace(t);
  changeAmounts(w.input, "m-high", [9000, 10000, 11000, 10000]);
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.eligibility, "eligible");
  assert.deepEqual(result.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(result.legitimate_merchants, { denominator: 2, incumbent: [], candidate: [], incumbent_count: 0, candidate_count: 0 });
  const other = join(w.root, "other"); mkdirSync(other);
  assert.equal(compareRuns(w.input, other, { target: "legitimate_merchants", proposal: proposal() }).reason, "no_strict_target_improvement");
});

test("legitimate-only strict improvement retains all fraud and cannot satisfy the other target", t => {
  const w = workspace(t); changeAmounts(w.input, "m-new", [90, 100, 110, 100]);
  const result = compareRuns(w.input, w.out, { target: "legitimate_merchants", proposal: proposal() });
  assert.equal(result.eligibility, "eligible");
  assert.deepEqual(result.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.new_fraud_case_ids, []);
  assert.deepEqual(result.legitimate_merchants?.incumbent, ["m-high"]);
  assert.deepEqual(result.legitimate_merchants?.candidate, []);
  const other = join(w.root, "other"); mkdirSync(other);
  assert.equal(compareRuns(w.input, other, { target: "fraud_cases", proposal: proposal() }).reason, "no_strict_target_improvement");
});

test("a new caught identity cannot compensate for a lost protected case despite equal fraud count and better weighted claims", t => {
  const w = workspace(t);
  changeAmounts(w.input, "m-protected", [9000, 10000, 11000, 12000]);
  const doc = proposal(); assert.ok(doc && typeof doc === "object" && !Array.isArray(doc));
  doc.expected_effect = { weighted_score: 999999999, net_value_saved: 999999999, claim: "would prefer fewer flags" };
  const result = compareRuns(w.input, w.out, { target: "legitimate_merchants", proposal: doc });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.reason, "lost_incumbent_fraud_case");
  assert.deepEqual(result.retained_fraud_case_ids, []);
  assert.deepEqual(result.lost_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.new_fraud_case_ids, ["new-jump"]);
  assert.equal(result.legitimate_merchants?.candidate_count, 0);
});

test("additional fraud cannot override increased unique legitimate merchants flagged", t => {
  const w = workspace(t);
  changeAmounts(w.input, "m-high", [9000, 10000, 11000, 10000]);
  changeAmounts(w.input, "m-low", [90, 100, 110, 150]);
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.reason, "increased_legitimate_merchant_flags");
  assert.equal(result.eligibility, "ineligible");
  assert.deepEqual(result.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(result.legitimate_merchants?.candidate, ["m-low"]);
});

test("ties reject even with large unsupported monetary and weighted claims", t => {
  const w = workspace(t);
  changeAmounts(w.input, "m-high", [9000, 10000, 11000, 10000]);
  changeAmounts(w.input, "m-new", [90, 100, 110, 100]);
  w.manifest.comparability.cost_assumptions = { lambda: 999999, intervention_cost: 0 }; w.save();
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.reason, "no_strict_target_improvement");
  assert.equal(result.eligibility, "ineligible");
  assert.deepEqual(result.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.new_fraud_case_ids, []);
});

test("invalid proposals and over-budget paired replay retain a named ineligible result", t => {
  const w = workspace(t);
  const doc = proposal(); assert.ok(doc && typeof doc === "object" && !Array.isArray(doc));
  doc.kind = "retire_rule";
  const rejected = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: doc });
  assert.equal(rejected.eligibility, "ineligible");
  assert.equal(rejected.reason, "candidate_evaluation_rejected");
  assert.equal(rejected.candidate_run_id, null);
  const other = join(w.root, "other"); mkdirSync(other);
  w.manifest.workload.max_events = 10; w.save();
  const bounded = compareRuns(w.input, other, { target: "fraud_cases", proposal: proposal() });
  assert.equal(bounded.reason, "incumbent_evaluation_rejected");
  assert.match(bounded.detail ?? "", /workload.*max_events/);
});

test("unavailable candidate evaluation is not counted as a reduction in legitimate flags", t => {
  const w = workspace(t);
  // All peer and own histories are zero: no defined positive reference exists.
  for (const id of ["protected", "new", "high", "low", "unknown", "immature"]) changeAmounts(w.input, `m-${id}`, [0, 0, 0, 12000]);
  const result = compareRuns(w.input, w.out, { target: "legitimate_merchants", proposal: proposal() });
  assert.equal(result.reason, "unavailable_evaluation:candidate");
  assert.equal(result.eligibility, "ineligible");
});

test("every supplied artifact is verified, missing assessments reject, and intact paired runs qualify", t => {
  const w = workspace(t), a = join(w.root, "a"), b = join(w.root, "b"); mkdirSync(a); mkdirSync(b);
  runCase(w.input, a); runCase(w.input, b, { proposal: proposal() });
  let counter = 0;
  const compare = () => {
    const out = join(w.root, `compare-${counter++}`); mkdirSync(out);
    return compareRuns(w.input, out, { target: "fraud_cases", proposal: proposal(), supplied_runs: { incumbent: a, candidate: b } });
  };
  assert.equal(compare().eligibility, "eligible");
  for (const [arm, dir] of [["incumbent", a], ["candidate", b]] as const) {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file), bytes = readFileSync(path);
      writeFileSync(path, Buffer.concat([bytes, Buffer.from("\n")]));
      assert.equal(compare().reason, `incompatible_paired_artifact:${arm}:${file}`, file);
      writeFileSync(path, bytes);
    }
    const file = join(dir, "scenario-metrics.jsonl"), bytes = readFileSync(file);
    rmSync(file);
    assert.equal(compare().reason, `missing_required_evidence:${arm}:scenario-metrics.jsonl`);
    writeFileSync(file, bytes);
    const metrics = bytes.toString().trim().split("\n").map(line => JSON.parse(line));
    metrics[0].assessment = { status: "unperformed", assessed_count: 0, failure_count: null };
    writeFileSync(file, metrics.map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.equal(compare().reason, `incompatible_paired_artifact:${arm}:scenario-metrics.jsonl`);
    writeFileSync(file, bytes);
  }
});

test("different histories, outcome versions, windows and feature assumptions cannot be mixed", t => {
  const w = workspace(t), a = join(w.root, "a"); mkdirSync(a); runCase(w.input, a);
  const variants = ["history-values", "history-version", "outcome-version", "outcome-values", "window", "metric-definitions", "catalog", "suite", "seed"];
  for (const variant of variants) {
    const input = join(w.root, `input-${variant}`); cpSync(w.input, input, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(input, "manifest.json"), "utf8"));
    if (variant === "history-values") changeAmounts(input, "m-new", [90, 100, 110, 160]);
    if (variant === "history-version") manifest.history.snapshot_version = "different-v2";
    if (variant === "outcome-version") manifest.authored_outcomes.version = "different-outcomes-v2";
    if (variant === "outcome-values") manifest.authored_outcomes.as_of = "2026-04-01T00:00:00.000Z";
    if (variant === "window") { manifest.comparability.observation_window.to = "2026-02-09"; manifest.authored_outcomes.observation_window.to = "2026-02-09"; }
    if (variant === "metric-definitions") manifest.comparability.resolution_mapping_version = "another-definition";
    if (variant === "seed") manifest.seed = 99;
    if (variant === "catalog") {
      const path = join(input, "suite/catalog.yaml"); writeFileSync(path, readFileSync(path, "utf8") + "\n# another admitted definition context\n");
    }
    if (variant === "suite") {
      const path = join(input, "suite/rules/lantern-daily.yaml"); writeFileSync(path, readFileSync(path, "utf8").replace("value: 3", "value: 4"));
    }
    writeFileSync(join(input, "manifest.json"), JSON.stringify(manifest));
    const b = join(w.root, `b-${variant}`), out = join(w.root, `out-${variant}`); mkdirSync(b); mkdirSync(out);
    runCase(input, b, { proposal: proposal() });
    const result = compareRuns(w.input, out, { target: "fraud_cases", proposal: proposal(), supplied_runs: { incumbent: a, candidate: b } });
    assert.equal(result.eligibility, "ineligible", variant);
    assert.match(result.reason, /^incompatible_paired_artifact:candidate:/, variant);
    assert.equal(result.legitimate_merchants, null);
  }
});

test("reserved partition and feedback provenance never imply reserved assessment or final acceptance", t => {
  const w = workspace(t); w.manifest.authored_outcomes.partition = "reserved-validation"; w.save();
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.eligibility, "eligible");
  assert.equal(result.data_scope?.partition, "reserved-validation");
  assert.equal(result.reserved_validation, "not_assessed");
  assert.equal(result.experimental_acceptance, "not_assessed");
});

test("duplicate rule and event hits still count each fraud case and legitimate merchant once", t => {
  const w = workspace(t);
  const fixed = readFileSync(join(w.input, "suite/rules/lantern-daily.yaml"), "utf8");
  writeFileSync(join(w.input, "suite/rules/second.yaml"), fixed.replaceAll("lantern-", "second-"));
  w.manifest.admitted_rule_ids.push("second-daily"); w.save();
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.eligibility, "eligible");
  assert.deepEqual(result.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(result.legitimate_merchants, { denominator: 2, incumbent: ["m-high"], candidate: ["m-high"], incumbent_count: 1, candidate_count: 1 });
});

test("inapplicable assessments, stories disabled and invalid targets cannot manufacture success", t => {
  const w = workspace(t);
  w.manifest.authored_outcomes.stories_enabled = false;
  for (const merchant of w.manifest.authored_outcomes.merchants) merchant.classification = "unknown";
  w.save();
  const result = compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal() });
  assert.equal(result.eligibility, "ineligible");
  assert.equal(result.reason, "unperformed_required_assessment");
  assert.equal(result.legitimate_merchants, null);
  const out = join(w.root, "invalid"); mkdirSync(out);
  assert.throws(() => compareRuns(w.input, out, JSON.parse('{"target":"weighted_score","proposal":null}')), /invalid_comparison_target/);
  assert.deepEqual(readdirSync(out), []);
});

test("public comparison command emits the count verdict and preserves its paired ledgers", t => {
  const w = workspace(t);
  const command = spawnSync(process.execPath, ["scripts/compare.ts", w.input, join(w.input, "proposal.yaml"), "fraud_cases", w.out], { encoding: "utf8" });
  assert.equal(command.status, 0, command.stdout + command.stderr);
  assert.match(command.stdout, /eligible.*strict_target_improvement/);
  const result = JSON.parse(readFileSync(join(w.out, "comparison.jsonl"), "utf8"));
  assert.deepEqual(result.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.new_fraud_case_ids, ["new-jump"]);
  for (const arm of ["incumbent", "candidate"]) {
    const rows = (file: string) => readFileSync(join(w.out, arm, file), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(rows("manifest.jsonl").length, 1);
    assert.equal(rows("metrics.jsonl").length, 1);
    assert.equal(rows("scenario-metrics.jsonl").filter(r => r.rule_id === null).length, 1);
    assert.equal(rows("metrics.jsonl")[0].net_value_saved, null);
  }
});

test("two consecutive datasets retain versioned obligations and a later improvement cannot replace a lost protected identity", t => {
  const first = workspace(t);
  first.manifest.history.snapshot_version = "v2";
  first.manifest.authored_outcomes.version = "paired-outcomes-v2";
  first.manifest.authored_outcomes.dataset_id = "invented-paired-history-v2";
  first.save();
  const v1Bytes = readFileSync(protectedCorpus);
  const admitted = compareRuns(first.input, first.out, {
    target: "legitimate_merchants", proposal: proposal(), protected_corpus_file: protectedCorpus,
  });
  assert.equal(admitted.eligibility, "eligible");
  assert.equal(admitted.protected_corpus?.use, "known_regression");
  assert.notEqual(admitted.protected_corpus?.corpus_id, admitted.data_scope?.dataset_id);
  assert.deepEqual(admitted.protected_cases && {
    expected: admitted.protected_cases.expected_count,
    dispositions: admitted.protected_cases.disposition_count,
    retained: admitted.protected_cases.retained_case_ids,
    missing: admitted.protected_cases.missing_case_ids,
    lost: admitted.protected_cases.lost_case_ids,
    unavailable: admitted.protected_cases.unavailable_case_ids,
    incumbent_missed: admitted.protected_cases.incumbent_missed_case_ids,
  }, { expected: 1, dispositions: 1, retained: ["protected"], missing: [], lost: [], unavailable: [], incumbent_missed: [] });
  assert.deepEqual(admitted.protected_cases?.dispositions[0]?.corpus_evidence.source_input_digests,
    JSON.parse(readFileSync(protectedCorpus, "utf8")).source.input_digests);
  assert.deepEqual(admitted.protected_cases?.dispositions[0]?.evaluation_evidence.input_digests,
    admitted.input_provenance!.evaluation_input_digests);
  const repeatedOut = join(first.root, "repeated-v2"); mkdirSync(repeatedOut);
  const repeated = compareRuns(first.input, repeatedOut, {
    target: "legitimate_merchants", proposal: proposal(), protected_corpus_file: protectedCorpus,
  });
  assert.deepEqual(repeated, admitted);
  for (const name of ["comparison-plan.json", "comparison.jsonl"]) {
    assert.deepEqual(readFileSync(join(repeatedOut, name)), readFileSync(join(first.out, name)), name);
  }

  const next = join(first.root, "corpus-v2");
  const updated = advanceProtectedCorpusVersion(protectedCorpus, first.out, next);
  assert.equal(updated.version, 2);
  assert.equal(updated.previous?.version, 1);
  assert.equal(updated.previous?.sha256, createHash("sha256").update(v1Bytes).digest("hex"));
  assert.deepEqual(updated.protected_cases.map(row => row.case_id), ["protected"]);
  assert.deepEqual(readFileSync(protectedCorpus), v1Bytes);

  const secondInput = join(first.root, "input-v3"); cpSync(first.input, secondInput, { recursive: true });
  const secondManifest = JSON.parse(readFileSync(join(secondInput, "manifest.json"), "utf8"));
  secondManifest.history.snapshot_version = "v3";
  secondManifest.authored_outcomes.version = "paired-outcomes-v3";
  secondManifest.authored_outcomes.dataset_id = "invented-paired-history-v3";
  writeFileSync(join(secondInput, "manifest.json"), JSON.stringify(secondManifest));
  changeAmounts(secondInput, "m-protected", [9000, 10000, 11000, 12000]);
  const priorBytes = readFileSync(join(next, "corpus.json"));
  const incumbentInputBytes = ["manifest.json", "scenarios.jsonl", "suite/catalog.yaml", "suite/tenant.yaml", "suite/rules/lantern-daily.yaml"]
    .map(path => [path, readFileSync(join(secondInput, path))] as const);
  const rejectedOut = join(first.root, "rejected-v3"); mkdirSync(rejectedOut);
  const rejected = compareRuns(secondInput, rejectedOut, {
    target: "legitimate_merchants", proposal: proposal(), protected_corpus_file: join(next, "corpus.json"),
  });
  assert.equal(rejected.eligibility, "ineligible");
  assert.equal(rejected.reason, "lost_protected_cases");
  assert.deepEqual(rejected.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(rejected.protected_cases && {
    expected: rejected.protected_cases.expected_count,
    dispositions: rejected.protected_cases.disposition_count,
    retained: rejected.protected_cases.retained_case_ids,
    missing: rejected.protected_cases.missing_case_ids,
    lost: rejected.protected_cases.lost_case_ids,
  }, { expected: 1, dispositions: 1, retained: [], missing: [], lost: ["protected"] });
  assert.equal(rejected.protected_cases!.expected_count,
    rejected.protected_cases!.retained_count + rejected.protected_cases!.missing_count
    + rejected.protected_cases!.lost_count + rejected.protected_cases!.unavailable_count
    + rejected.protected_cases!.incumbent_missed_count + rejected.protected_cases!.not_evaluated_count);
  assert.deepEqual(readFileSync(join(next, "corpus.json")), priorBytes);
  for (const [path, bytes] of incumbentInputBytes) assert.deepEqual(readFileSync(join(secondInput, path)), bytes, path);
  const rejectedVersion = join(first.root, "corpus-v3");
  assert.throws(() => advanceProtectedCorpusVersion(join(next, "corpus.json"), rejectedOut, rejectedVersion),
    /comparison is not eligible/);
  assert.equal(existsSync(rejectedVersion), false);
  assert.equal(rejected.reserved_validation, "not_assessed");
  assert.equal(rejected.experimental_acceptance, "not_assessed");
});

test("changed populations, windows and sources reject missing or unavailable protected cases by name", t => {
  const w = workspace(t);
  const compare = (name: string, mutate: (input: string, manifest: any) => void) => {
    const input = join(w.root, `input-${name}`); cpSync(w.input, input, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(input, "manifest.json"), "utf8"));
    manifest.authored_outcomes.dataset_id = `invented-${name}`;
    mutate(input, manifest);
    writeFileSync(join(input, "manifest.json"), JSON.stringify(manifest));
    const out = join(w.root, `out-${name}`); mkdirSync(out);
    return compareRuns(input, out, { target: "fraud_cases", proposal: proposal(), protected_corpus_file: protectedCorpus });
  };
  const population = compare("population-omission", (_input, manifest) => {
    manifest.authored_outcomes.cases = manifest.authored_outcomes.cases.filter((row: { case_id: string }) => row.case_id !== "protected");
  });
  assert.equal(population.reason, "missing_protected_cases");
  assert.deepEqual(population.protected_cases?.missing_case_ids, ["protected"]);
  assert.match(population.protected_cases?.dispositions[0]?.reason ?? "", /authored outcome population/);

  const source = compare("source-omission", (input) => {
    const path = join(input, "scenarios.jsonl");
    const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(row => row.case_id !== "protected");
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  });
  assert.equal(source.reason, "missing_protected_cases");
  assert.deepEqual(source.protected_cases?.missing_case_ids, ["protected"]);
  assert.match(source.protected_cases?.dispositions[0]?.reason ?? "", /evaluation source/);

  const window = compare("window-omission", (_input, manifest) => {
    manifest.comparability.observation_window = { from: "2026-02-08", to: "2026-02-09" };
    manifest.authored_outcomes.observation_window = { from: "2026-02-08", to: "2026-02-09" };
    manifest.authored_outcomes.cases = manifest.authored_outcomes.cases.filter((row: { case_id: string }) => row.case_id !== "protected");
    for (const row of manifest.authored_outcomes.cases) {
      row.from = "2026-02-08T00:00:00.000Z";
      row.to = "2026-02-09T00:00:00.000Z";
    }
    manifest.authored_outcomes.merchants.find((row: { merchant_id: string }) => row.merchant_id === "m-protected").classification = "unknown";
  });
  assert.equal(window.reason, "missing_protected_cases");
  assert.deepEqual(window.protected_cases?.missing_case_ids, ["protected"]);
  assert.match(window.protected_cases?.dispositions[0]?.reason ?? "", /observation window/);

  const unknown = compare("unknown-protected", (_input, manifest) => {
    manifest.authored_outcomes.cases.find((row: { case_id: string }) => row.case_id === "protected").outcome = "unknown";
  });
  assert.equal(unknown.reason, "unavailable_protected_cases");
  assert.deepEqual(unknown.protected_cases?.unavailable_case_ids, ["protected"]);

  const immature = compare("immature-protected", (_input, manifest) => {
    manifest.authored_outcomes.cases.find((row: { case_id: string }) => row.case_id === "protected").available_at = "2026-03-01T00:00:00.000Z";
  });
  assert.equal(immature.reason, "unavailable_protected_cases");
  assert.deepEqual(immature.protected_cases?.unavailable_case_ids, ["protected"]);

  const unavailable = compare("unavailable-protected", (input) => {
    for (const id of ["protected", "new", "high", "low", "unknown", "immature"]) {
      changeAmounts(input, `m-${id}`, [0, 0, 0, 12000]);
    }
  });
  assert.equal(unavailable.reason, "unavailable_protected_cases");
  assert.deepEqual(unavailable.protected_cases?.unavailable_case_ids, ["protected"]);
});

test("stale corpus bytes and an ordinary-test wrong-result mutation are rejected by replayed historical evidence", t => {
  const w = workspace(t);
  const original = JSON.parse(readFileSync(protectedCorpus, "utf8"));
  original.source.directory = join(process.cwd(), fixture);
  for (const [name, mutate, expected] of [
    ["stale", (doc: any) => { doc.source.input_digests["scenarios.jsonl"] = "0".repeat(64); }, /source digest/],
    ["wrong-result", (doc: any) => { doc.protected_cases[0].detected_by_rule_ids = ["invented-wrong-rule"]; }, /detected rule evidence/],
  ] as const) {
    const corpus = join(w.root, `${name}.json`), out = join(w.root, `out-${name}`); mkdirSync(out);
    const doc = structuredClone(original); mutate(doc); writeFileSync(corpus, JSON.stringify(doc));
    const result = compareRuns(w.input, out, { target: "fraud_cases", proposal: proposal(), protected_corpus_file: corpus });
    assert.equal(result.eligibility, "ineligible", name);
    assert.equal(result.reason, "protected_corpus_rejected", name);
    assert.match(result.detail ?? "", expected, name);
    assert.equal(result.protected_cases, null, name);
    assert.ok(result.input_provenance!.protected_corpus_sha256, name);
  }
});

test("protected corpus preserves opaque admission bytes and rejects a UTF8 digest collision", t => {
  const w = workspace(t);
  const admission = join(w.input, "admission.json");
  const originalBytes = Buffer.from("fffe7b007d00", "hex");
  writeFileSync(admission, originalBytes);
  const record = JSON.parse(readFileSync(protectedCorpus, "utf8"));
  record.source = { directory: "input", input_digests: portableInputDigests(w.input) };
  const corpus = join(w.root, "corpus.json");
  writeFileSync(corpus, JSON.stringify(record));
  assert.equal(verifyProtectedCorpus(corpus).record.corpus_id, "invented-lantern-known-regressions");
  const result = compareRuns(w.input, w.out, {
    target: "fraud_cases", proposal: proposal(), protected_corpus_file: corpus,
  });
  assert.equal(result.eligibility, "eligible");
  const next = join(w.root, "successor");
  advanceProtectedCorpusVersion(corpus, w.out, next);
  assert.deepEqual(readFileSync(join(next, "source/admission.json")), originalBytes);
  assert.equal(verifyProtectedCorpus(join(next, "corpus.json")).record.version, 2);

  // Both byte sequences decode to the same replacement characters in UTF8.
  writeFileSync(admission, Buffer.from("fefe7b007d00", "hex"));
  assert.throws(() => verifyProtectedCorpus(corpus), /source digest/);
  assert.deepEqual(readFileSync(join(next, "source/admission.json")), originalBytes);
});

test("successor rejects forged saved eligibility after no strict target improvement without changing evidence", t => {
  const w = workspace(t);
  changeAmounts(w.input, "m-new", [100, 100, 100, 100]);
  const result = compareRuns(w.input, w.out, {
    target: "fraud_cases", proposal: proposal(), protected_corpus_file: protectedCorpus,
  });
  assert.equal(result.reason, "no_strict_target_improvement");
  assert.deepEqual(result.new_fraud_case_ids, []);
  assert.deepEqual(result.protected_cases?.retained_case_ids, ["protected"]);
  result.eligibility = "eligible";
  writeFileSync(join(w.out, "comparison.jsonl"), JSON.stringify(result) + "\n");
  const before = evidenceBytes(w.out), inputsBefore = evidenceBytes(w.input);
  const priorBytes = readFileSync(protectedCorpus);
  const next = join(w.root, "forged-successor");
  assert.throws(() => advanceProtectedCorpusVersion(protectedCorpus, w.out, next), /comparison.*(replay|eligible)/);
  assert.equal(existsSync(next), false);
  assert.deepEqual(evidenceBytes(w.out), before);
  assert.deepEqual(evidenceBytes(w.input), inputsBefore);
  assert.deepEqual(readFileSync(protectedCorpus), priorBytes);
});

function evidenceBytes(dir: string): [string, Buffer][] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry =>
    entry.isDirectory() ? evidenceBytes(join(dir, entry.name)).map(([path, bytes]): [string, Buffer] => [`${entry.name}/${path}`, bytes])
      : [[entry.name, readFileSync(join(dir, entry.name))] as [string, Buffer]]);
}

test("successor binds the complete comparison plan, result and both replayed arms", t => {
  const w = workspace(t);
  compareRuns(w.input, w.out, { target: "fraud_cases", proposal: proposal(), protected_corpus_file: protectedCorpus });
  const editJson = (dir: string, file: string, mutate: (row: any) => void) => {
    const path = join(dir, file), row = JSON.parse(readFileSync(path, "utf8"));
    mutate(row); writeFileSync(path, JSON.stringify(row) + "\n");
  };
  const variants: [string, (dir: string) => void][] = [
    ["target", dir => editJson(dir, "comparison-plan.json", row => { row.target = "legitimate_merchants"; })],
    ["proposal", dir => editJson(dir, "comparison-plan.json", row => { row.proposal = null; })],
    ["input-digest", dir => editJson(dir, "comparison-plan.json", row => { row.input_digests["scenarios.jsonl"] = "0".repeat(64); })],
    ["result-count", dir => editJson(dir, "comparison.jsonl", row => { row.legitimate_merchants.incumbent_count = 99; })],
    ["prior-obligations", dir => editJson(dir, "comparison.jsonl", row => { row.protected_cases.dispositions = []; })],
    ...["incumbent", "candidate"].map((arm): [string, (dir: string) => void] => [arm, dir => {
      const path = join(dir, arm, "verdicts.jsonl");
      writeFileSync(path, readFileSync(path, "utf8").replace('"verdict":"alert"', '"verdict":"did_not_fire"'));
    }]),
    ["extra-artifact", dir => writeFileSync(join(dir, "incumbent/unbound.json"), "{}")],
  ];
  for (const [name, mutate] of variants) {
    const comparison = join(w.root, name); cpSync(w.out, comparison, { recursive: true });
    mutate(comparison);
    const before = evidenceBytes(comparison), priorBytes = readFileSync(protectedCorpus);
    const next = join(w.root, `next-${name}`);
    assert.throws(() => advanceProtectedCorpusVersion(protectedCorpus, comparison, next), /comparison.*(replay|eligible)/, name);
    assert.equal(existsSync(next), false, name);
    assert.deepEqual(evidenceBytes(comparison), before, name);
    assert.deepEqual(readFileSync(protectedCorpus), priorBytes, name);
  }
  const supplied = join(w.root, "supplied"); mkdirSync(supplied);
  const result = compareRuns(w.input, supplied, {
    target: "fraud_cases", proposal: proposal(), protected_corpus_file: protectedCorpus,
    supplied_runs: { incumbent: join(w.out, "incumbent"), candidate: join(w.out, "candidate") },
  });
  assert.equal(result.eligibility, "eligible");
  const next = join(w.root, "supplied-successor");
  assert.equal(advanceProtectedCorpusVersion(protectedCorpus, supplied, next).version, 2);
  assert.equal(verifyProtectedCorpus(join(next, "corpus.json")).record.version, 2);
});

test("protected corpus portable text digests tolerate Git CRLF checkouts", t => {
  const w = workspace(t), record = JSON.parse(readFileSync(protectedCorpus, "utf8"));
  record.source.directory = "input";
  for (const path of Object.keys(record.source.input_digests)) {
    const text = readFileSync(join(w.input, path), "utf8").replace(/\r\n/g, "\n");
    writeFileSync(join(w.input, path), text.replace(/\n/g, "\r\n"));
  }
  const corpus = join(w.root, "portable.json"); writeFileSync(corpus, JSON.stringify(record));
  assert.equal(verifyProtectedCorpus(corpus).record.version, 1);
});

test("public comparison command enforces known regression evidence and explicitly writes a successor version", t => {
  const w = workspace(t), next = join(w.root, "next-corpus");
  const command = spawnSync(process.execPath, [
    "scripts/compare.ts", w.input, join(w.input, "proposal.yaml"), "legitimate_merchants", w.out, protectedCorpus, next,
  ], { encoding: "utf8" });
  assert.equal(command.status, 0, command.stdout + command.stderr);
  assert.match(command.stdout, /eligible: strict_target_improvement/);
  assert.match(command.stdout, /protected corpus invented-lantern-known-regressions version 2/);
  assert.equal(JSON.parse(readFileSync(join(next, "corpus.json"), "utf8")).use, "known_regression");
});
