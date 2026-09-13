import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createValidation, openValidation } from "../src/seams/comparison.ts";
import { startImprovement, runImprovement, replayImprovement } from "../src/bounded-improvement.ts";
import { isMapping, parseYaml } from "../src/yaml.ts";

const fixture = "fixtures/comparison/paired-history";
const limits = { target: "fraud_cases" as const, max_attempts: 3, max_elapsed_ms: 60_000, max_input_bytes: 8_000_000 };
function workspace(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "fwh-improvement-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const search = join(root, "search"), reserved = join(root, "reserved");
  cpSync(fixture, search, { recursive: true }); cpSync(fixture, reserved, { recursive: true });
  for (const file of ["manifest.json", "scenarios.jsonl"]) {
    let text = readFileSync(join(reserved, file), "utf8").replaceAll('"m-', '"r-m-');
    if (file === "manifest.json") {
      const manifest = JSON.parse(text);
      manifest.authored_outcomes.partition = "reserved-validation";
      manifest.authored_outcomes.dataset_id = "bounded-reserved-v1";
      text = JSON.stringify(manifest);
    }
    writeFileSync(join(reserved, file), text);
  }
  const validation = join(root, "validation");
  createValidation(validation, { max_input_bytes: limits.max_input_bytes });
  const out = join(root, "experiment");
  return { root, search, reserved, validation, out, corpus: "fixtures/comparison/protected-corpus/v1.json" };
}
const proposal = () => parseYaml(readFileSync(join(fixture, "proposal.yaml"), "utf8"));

test("only fully validated strict improvement advances the experimental incumbent and protected corpus", t => {
  const w = workspace(t);
  const original = readFileSync(join(w.search, "suite/rules/lantern-daily.yaml"));
  const experiment = startImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
    validation_store: w.validation, output: w.out, limits });
  const search = JSON.parse(experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: proposal() })));
  assert.equal(search.reason, "strict_target_improvement");
  const result = experiment.finish();
  assert.equal(result.accepted_count, 1);
  assert.notEqual(result.incumbent.suite_id, result.initial_incumbent.suite_id);
  assert.deepEqual(result.attempts[0]?.reserved?.comparison.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.attempts[0]?.reserved?.comparison.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(result.attempts[0]?.reserved?.comparison.legitimate_merchants?.incumbent, ["r-m-high"]);
  assert.deepEqual(result.attempts[0]?.reserved?.comparison.legitimate_merchants?.candidate, []);
  assert.deepEqual(result.attempts[0]?.protected?.protected_cases?.retained_case_ids, ["protected"]);
  assert.deepEqual(result.attempts[0]?.states.map(row => row.state), ["attempted", "admitted", "evaluated", "frozen", "validated", "protected", "accepted"]);
  assert.deepEqual(readFileSync(join(w.search, "suite/rules/lantern-daily.yaml")), original);
});

test("saved readable translation drives successful and honest no-improvement public examples", t => {
  const w = workspace(t);
  for (const mode of ["success", "no-improvement"]) {
    const output = join(w.root, mode);
    const command = spawnSync(process.execPath, ["scripts/improve-example.ts", output, mode], { encoding: "utf8" });
    assert.equal(command.status, 0, command.stdout + command.stderr);
    const result = JSON.parse(readFileSync(join(output, "experiment/result.json"), "utf8"));
    const translation = JSON.parse(readFileSync(join(output, "translated/admission.json"), "utf8"));
    assert.equal(translation.status, "admitted");
    assert.equal(translation.provenance.source_sha256, "6cc4d98fcf8bd3241a3739ef9d867e7216ff098e35e80b057ee71976dd285c8a");
    assert.equal(result.accepted_count, mode === "success" ? 1 : 0);
    assert.equal(result.reason, mode === "success" ? "completed_with_improvement" : "no_valid_improvement");
    assert.deepEqual(result.attempts[0].search.retained_fraud_case_ids, ["protected"]);
    assert.deepEqual(result.attempts[0].search.new_fraud_case_ids, ["new-jump"]);
    if (mode === "success") {
      assert.deepEqual(result.attempts[0].reserved.comparison.retained_fraud_case_ids, ["protected"]);
      assert.deepEqual(result.attempts[0].reserved.comparison.new_fraud_case_ids, ["new-jump"]);
      assert.deepEqual(result.attempts[0].reserved.comparison.legitimate_merchants.incumbent, ["r-m-high"]);
      assert.deepEqual(result.attempts[0].reserved.comparison.legitimate_merchants.candidate, []);
    } else {
      assert.equal(result.attempts[0].reserved.reason, "no_strict_target_improvement");
      assert.deepEqual(result.attempts[0].reserved.comparison.new_fraud_case_ids, []);
      assert.deepEqual(result.incumbent, result.initial_incumbent);
    }
    assert.deepEqual(readFileSync(join(output, "experiment/initial/admission.json")), readFileSync(join(output, "translated/admission.json")));
    assert.deepEqual(replayImprovement(join(output, "experiment"), join(output, "replay")), result);
  }
});

test("the common deterministic proposer chooses a bounded change from search evidence", t => {
  const w = workspace(t);
  const result = runImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
    validation_store: w.validation, output: w.out, limits });
  assert.equal(result.accepted_count, 1);
  assert.equal(result.reason, "completed_with_improvement");
  assert.ok(isMapping(result.attempts[0]!.proposal));
  assert.equal(result.attempts[0]!.proposal.kind, "statistical_conversion");
});

test("saved requests replay the full experiment without model calls or a new untouched-data claim", t => {
  const w = workspace(t);
  const result = runImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
    validation_store: w.validation, output: w.out, limits });
  const replay = join(w.root, "replay");
  assert.deepEqual(replayImprovement(w.out, replay), result);
  assert.deepEqual(readFileSync(join(replay, "result.json")), readFileSync(join(w.out, "result.json")));
});

test("elapsed budget includes the final corpus verification before committing an acceptance", t => {
  const w = workspace(t);
  let calls = 0;
  const experiment = startImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
    validation_store: w.validation, output: w.out, limits: { ...limits, max_elapsed_ms: 100 }, clock: () => calls++ >= 6 ? 100 : 0 });
  experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: proposal() }));
  const result = experiment.finish();
  assert.equal(result.reason, "time_budget_exhausted");
  assert.equal(result.accepted_count, 0);
  assert.deepEqual(result.incumbent, result.initial_incumbent);
  assert.equal(result.attempts[0]?.states.at(-1)?.state, "discarded");
  assert.deepEqual(replayImprovement(w.out, join(w.root, "replay")), result);
});

test("feedback exposure invalidates a final claim and later claims require a fresh reserved assessment", t => {
  const w = workspace(t);
  const options = { search: w.search, reserved: [w.reserved], corpus: w.corpus, validation_store: w.validation, output: w.out, limits };
  const experiment = startImprovement(options);
  experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: proposal() }));
  const first = experiment.finish();
  experiment.releaseFeedback();
  const attempt = first.attempts[0]!;
  assert.throws(() => openValidation(w.validation).finalEvidence(attempt.frozen_id!, attempt.reserved_version!), /validation_feedback_exposed/);
  const reused = runImprovement({ ...options, output: join(w.root, "reused") });
  assert.equal(reused.accepted_count, 0);
  assert.equal(reused.reason, "evaluation_error");
  assert.match(reused.attempts[0]?.states.at(-1)?.reason ?? "", /validation_already_used/);
  for (const file of ["manifest.json", "scenarios.jsonl"]) {
    writeFileSync(join(w.reserved, file), readFileSync(join(w.reserved, file), "utf8").replaceAll('"r-m-', '"fresh-m-'));
  }
  const fresh = runImprovement({ ...options, output: join(w.root, "fresh") });
  assert.equal(fresh.accepted_count, 1);
  assert.deepEqual(fresh.attempts[0]?.protected?.protected_cases?.retained_case_ids, ["protected"]);
  assert.notEqual(fresh.attempts[0]?.reserved?.provenance.validation_identity, attempt.reserved?.provenance.validation_identity);
});

test("denied capabilities and protected proposal targets retain pinned input bytes", t => {
  const w = workspace(t);
  const original = readFileSync(join(w.reserved, "manifest.json"));
  const experiment = startImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
    validation_store: w.validation, output: w.out, limits });
  assert.deepEqual(JSON.parse(experiment.proposer.context).tools, ["read_search", "evaluate_search"]);
  for (const tool of ["shell", "write_generator", "write_labels", "write_evaluator", "write_validation", "write_tests", "write_authority"]) {
    assert.throws(() => experiment.proposer.request(JSON.stringify({ tool, content: "changed" })), /proposer_access_denied/);
  }
  for (const name of ["../reserved/manifest.json", "reserved/manifest.json", "../plan.json"]) {
    assert.throws(() => experiment.proposer.request(JSON.stringify({ tool: "read_search", name })), /proposer_access_denied/);
  }
  const invalid = proposal(); assert.ok(isMapping(invalid));
  invalid.generator = { seed: 999 };
  experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: invalid }));
  const result = experiment.finish();
  assert.equal(result.reason, "invalid_candidate");
  assert.equal(result.accepted_count, 0);
  assert.match(result.attempts[0]?.states[1]?.reason ?? "", /unsupported or protected target/);
  assert.deepEqual(readFileSync(join(w.reserved, "manifest.json")), original);
  assert.deepEqual(replayImprovement(w.out, join(w.root, "replay")), result);
});

test("no move, invalid authority, evaluation error and unchosen-target gain stop honestly", t => {
  for (const mode of ["none", "bounds", "evaluation", "unchosen", "protected-missing", "reserved-lost"]) {
    const w = workspace(t);
    if (mode === "evaluation") writeFileSync(join(w.reserved, "scenarios.jsonl"), "invalid json\n");
    if (mode === "protected-missing") {
      for (const file of ["manifest.json", "scenarios.jsonl"]) writeFileSync(join(w.reserved, file), readFileSync(join(w.reserved, file), "utf8").replaceAll('"protected"', '"renamed-case"'));
    }
    if (mode === "reserved-lost") changeAmounts(w.reserved, "r-m-protected", [9000, 10000, 11000, 12000]);
    const experiment = startImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
      validation_store: w.validation, output: w.out, limits });
    if (mode !== "none") {
      const p = proposal(); assert.ok(isMapping(p)); assert.ok(isMapping(p.change));
      if (mode === "bounds") p.change.thresholds = [{ id: "lantern-k", value: 111, min: 1, max: 111 }];
      if (mode === "unchosen") p.change.thresholds = [{ id: "lantern-k", value: 10, min: 1, max: 10 }, { id: "lantern-window", value: 3, min: 3, max: 60 }];
      experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: p }));
    }
    const result = experiment.finish();
    assert.equal(result.reason, mode === "none" ? "no_permitted_move" : mode === "bounds" ? "invalid_candidate" : mode === "evaluation" ? "evaluation_error" : "no_valid_improvement", mode);
    assert.equal(result.accepted_count, 0, mode);
    assert.deepEqual(result.incumbent, result.initial_incumbent, mode);
    if (mode === "unchosen") assert.equal(result.attempts[0]?.search?.reason, "no_strict_target_improvement");
    if (mode === "protected-missing") assert.equal(result.attempts[0]?.protected?.reason, "missing_protected_cases");
    if (mode === "reserved-lost") {
      assert.equal(result.attempts[0]?.reserved?.reason, "lost_incumbent_fraud_case");
      assert.deepEqual(result.attempts[0]?.reserved?.comparison.lost_fraud_case_ids, ["protected"]);
      assert.deepEqual(result.attempts[0]?.reserved?.comparison.new_fraud_case_ids, ["new-jump"]);
    }
  }
});

function changeAmounts(input: string, merchant: string, amounts: number[]) {
  const path = join(input, "scenarios.jsonl"), rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  let index = 0;
  for (const row of rows) if (row.merchant_id === merchant && row.kind === "settlement") row.amount = amounts[index++];
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

test("failure and finite budgets before or after acceptance preserve the last fully accepted state", t => {
  for (const mode of ["time-before", "time-after", "attempts-after", "invalid-after", "evaluation-after"]) {
    const w = workspace(t);
    let now = 0;
    const experiment = startImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
      validation_store: w.validation, output: w.out, limits: { ...limits, max_attempts: mode === "attempts-after" ? 1 : 3 }, clock: () => now });
    if (mode !== "time-before") experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: proposal() }));
    const before = experiment.status().incumbent;
    if (mode.startsWith("time")) now = limits.max_elapsed_ms;
    if (mode.startsWith("time") || mode === "attempts-after") {
      assert.throws(() => experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: proposal() })), /budget_exhausted/);
    } else {
      const next = mode === "invalid-after" ? proposal() : { kind: "parameter_change", tenant: "t-alpha",
        change: { rule_id: "lantern-daily", thresholds: [{ id: "lantern-k", value: 2, min: 1, max: 10 }] },
        proving_scenario: {}, expected_effect: {}, gate_status: "ungated until replay" };
      if (mode === "evaluation-after") {
        // A corrupt trusted saved input causes a named evaluation failure;
        // this is an operator fault, never a capability supplied to a proposer.
        writeFileSync(join(w.out, before.directory, "scenarios.jsonl"), "broken\n");
      }
      experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: next }));
    }
    const result = experiment.finish();
    assert.deepEqual(result.incumbent, before, mode);
    assert.equal(result.accepted_count, mode === "time-before" ? 0 : 1, mode);
    assert.equal(result.reason, mode.startsWith("time") ? "time_budget_exhausted" : mode === "attempts-after" ? "attempt_budget_exhausted" : mode === "invalid-after" ? "invalid_candidate" : "evaluation_error", mode);
    if (mode !== "evaluation-after") assert.deepEqual(replayImprovement(w.out, join(w.root, "replay")), result);
  }
});

test("a no-move finish still enforces the elapsed budget pinned before search", t => {
  const w = workspace(t);
  let now = 0;
  const experiment = startImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
    validation_store: w.validation, output: w.out, limits, clock: () => now });
  now = limits.max_elapsed_ms;
  const result = experiment.finish();
  assert.equal(result.reason, "time_budget_exhausted");
  assert.equal(result.accepted_count, 0);
  assert.deepEqual(replayImprovement(w.out, join(w.root, "replay")), result);
});

test("later search against an advanced incumbent exposes the preceding acceptance feedback", t => {
  const w = workspace(t);
  const experiment = startImprovement({ search: w.search, reserved: [w.reserved], corpus: w.corpus,
    validation_store: w.validation, output: w.out, limits });
  experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: proposal() }));
  const first = experiment.status().attempts[0]!;
  experiment.proposer.request(JSON.stringify({ tool: "evaluate_search", proposal: {
    kind: "parameter_change", tenant: "t-alpha", change: { rule_id: "lantern-daily", thresholds: [{ id: "lantern-k", value: 2, min: 1, max: 10 }] },
    proving_scenario: {}, expected_effect: {}, gate_status: "ungated until replay",
  } }));
  assert.throws(() => openValidation(w.validation).finalEvidence(first.frozen_id!, first.reserved_version!), /validation_feedback_exposed/);
  const result = experiment.finish();
  assert.equal(result.accepted_count, 1);
  assert.equal(result.reason, "no_valid_improvement");
  assert.deepEqual(replayImprovement(w.out, join(w.root, "replay")), result);
});
