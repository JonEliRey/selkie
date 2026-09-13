import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compareRuns, createValidation, openValidation, type ComparisonTarget } from "../src/seams/comparison.ts";
import { parseYaml } from "../src/yaml.ts";

const fixture = "fixtures/comparison/paired-history";
const proposal = () => parseYaml(readFileSync(`${fixture}/proposal.yaml`, "utf8"));
function workspace(t: { after: (fn: () => void) => void }, target: ComparisonTarget = "fraud_cases") {
  const root = mkdtempSync(join(tmpdir(), "fwh-reserved-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const search = join(root, "search"), reserved = join(root, "reserved"), comparison = join(root, "comparison");
  cpSync(fixture, search, { recursive: true }); cpSync(fixture, reserved, { recursive: true }); mkdirSync(comparison);
  // Separate invented merchant/event/case identities; fixed authored truth.
  for (const file of ["manifest.json", "scenarios.jsonl"]) {
    let text = readFileSync(join(reserved, file), "utf8").replaceAll('"m-', '"r-m-').replaceAll('"event_id":"', '"event_id":"r-');
    if (file === "manifest.json") {
      const manifest = JSON.parse(text);
      manifest.authored_outcomes.partition = "reserved-validation";
      manifest.authored_outcomes.dataset_id = "invented-reserved-v1";
      text = JSON.stringify(manifest);
    }
    writeFileSync(join(reserved, file), text);
  }
  const result = compareRuns(search, comparison, { target, proposal: proposal() });
  assert.equal(result.eligibility, "eligible");
  const store = join(root, "store");
  const validation = createValidation(store, { max_input_bytes: 2_000_000 });
  return { root, search, reserved, comparison, store, validation };
}

test("freeze binds complete saved candidate and authority before a reserved paired replay", t => {
  const w = workspace(t);
  const frozen = w.validation.freeze(w.comparison);
  const reserved = w.validation.reserve(w.reserved);
  const result = w.validation.evaluate(frozen, reserved);
  assert.equal(result.status, "passed");
  assert.equal(result.experimental_acceptance, "not_assessed");
  assert.equal(result.protected_corpus.status, "not_assessed");
  assert.deepEqual(result.comparison.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.comparison.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(result.comparison.legitimate_merchants?.candidate, []);
  assert.deepEqual(result.comparison.unknown_case_ids, ["unresolved"]);
  assert.deepEqual(result.comparison.immature_case_ids, ["pending"]);
  assert.equal(result.comparison.data_scope?.partition, "reserved-validation");
  assert.equal(result.comparison.target, "fraud_cases");
  const replay = join(w.root, "replay"); mkdirSync(replay);
  assert.deepEqual(openValidation(w.store).replay(frozen, reserved, replay), result);
  assert.deepEqual(readFileSync(join(replay, "validation.json")), readFileSync(join(w.store, "assessments", result.assessment_id, "validation.json")));
  assert.throws(() => w.validation.evaluate(frozen, reserved), /validation_already_used/);
});

function changeAmounts(input: string, merchant: string, amounts: number[]) {
  const path = join(input, "scenarios.jsonl"), rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  let i = 0;
  for (const event of rows) if (event.merchant_id === merchant && event.kind === "settlement") event.amount = amounts[i++];
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

test("optional label removal cannot refresh exposed observations after a process restart", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), reserved = w.validation.reserve(w.reserved);
  const result = w.validation.evaluate(frozen, reserved);
  assert.deepEqual(result.comparison.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.comparison.new_fraud_case_ids, ["new-jump"]);
  w.validation.expose(frozen, reserved);
  const manifest = readFileSync(join(w.reserved, "manifest.json"));
  const path = join(w.reserved, "scenarios.jsonl"), original = readFileSync(path);
  const rows = original.toString().trim().split("\n").map(line => {
    const row = JSON.parse(line); delete row.label; return row;
  });
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const relabeled = w.validation.reserve(w.reserved);
  assert.notEqual(relabeled, reserved); // Raw versions still bind every annotation byte.
  assert.deepEqual(readFileSync(join(w.reserved, "manifest.json")), manifest);
  assert.deepEqual(readFileSync(join(w.store, "reserved", reserved, "artifacts/scenarios.jsonl")), original);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import assert from 'node:assert/strict';
     import { openValidation } from './src/seams/comparison.ts';
     const v = openValidation(process.argv[1]), f = process.argv[2], r = process.argv[3];
     assert.throws(() => v.evaluate(f, r), /validation_already_used/);
     assert.throws(() => v.finalEvidence(f, r), /validation_feedback_exposed/);`,
    w.store, frozen, relabeled], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const replay = join(w.root, "original-label-replay"); mkdirSync(replay);
  assert.deepEqual(w.validation.replay(frozen, reserved, replay), result);
  assert.deepEqual(readFileSync(join(replay, "comparison/inputs/scenarios.jsonl")), original);
});

test("optional label removal cannot bypass search overlap after a process restart", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison);
  cpSync(w.search, w.reserved, { recursive: true });
  const manifestPath = join(w.reserved, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.authored_outcomes.partition = "reserved-validation";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => w.validation.evaluate(frozen, w.validation.reserve(w.reserved)), /validation_overlaps_search/);
  const originalManifest = readFileSync(manifestPath), path = join(w.reserved, "scenarios.jsonl");
  const rows = readFileSync(path, "utf8").trim().split("\n").map(line => {
    const row = JSON.parse(line); delete row.label; return row;
  });
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const reserved = w.validation.reserve(w.reserved);
  assert.deepEqual(readFileSync(manifestPath), originalManifest);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import assert from 'node:assert/strict';
     import { openValidation } from './src/seams/comparison.ts';
     const v = openValidation(process.argv[1]), f = process.argv[2], r = process.argv[3];
     assert.throws(() => v.evaluate(f, r), /validation_overlaps_search/);
     assert.throws(() => v.finalEvidence(f, r), /validation_overlaps_search/);`,
    w.store, frozen, reserved], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test("annotations and equivalent JSON representations cannot refresh used or searched observations", t => {
  for (const searched of [false, true]) {
    const w = workspace(t), frozen = w.validation.freeze(w.comparison);
    if (searched) {
      cpSync(w.search, w.reserved, { recursive: true });
      const path = join(w.reserved, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.authored_outcomes.partition = "reserved-validation";
      writeFileSync(path, JSON.stringify(manifest));
    }
    const path = join(w.reserved, "scenarios.jsonl"), original = readFileSync(path, "utf8");
    const first = w.validation.reserve(w.reserved);
    if (!searched) { w.validation.evaluate(frozen, first); w.validation.expose(frozen, first); }
    const variants: Record<string, (row: Record<string, any>) => Record<string, any>> = {
      removed: row => { delete row.label; return row; },
      changed: row => ({ ...row, label: "unknown" }),
      eventAlias: row => ({ ...row, event_id: "alias-" + row.event_id }),
      caseAnnotation: row => ({ ...row, case_id: row.case_id === null ? null : "alias-" + row.case_id }),
      reportingPartition: row => ({ ...row, segment: "renamed-group" }),
      keyOrder: row => Object.fromEntries(Object.entries(row).reverse()),
    };
    for (const [name, transform] of Object.entries(variants)) {
      const rows = original.trim().split("\n").map(line => transform(JSON.parse(line))).reverse();
      // Number spelling, whitespace, CRLF and row/key order do not change observations.
      const text = rows.map(row => JSON.stringify(row).replace(':100,', ':1e2,')).join("\r\n") + "\r\n";
      writeFileSync(path, text);
      const changed = w.validation.reserve(w.reserved);
      assert.notEqual(changed, first, name);
      const reopened = openValidation(w.store);
      assert.throws(() => reopened.evaluate(frozen, changed), searched ? /validation_overlaps_search/ : /validation_already_used/, name);
      assert.throws(() => reopened.finalEvidence(frozen, changed), searched ? /validation_overlaps_search/ : /validation_feedback_exposed/, name);
      assert.equal(readFileSync(path, "utf8"), text, name);
    }
    // A changed row does not hide overlap with the other unlabelled observations.
    const partial = original.trim().split("\n").map(line => {
      const row = JSON.parse(line); delete row.label; return row;
    });
    partial[0].amount += 1;
    writeFileSync(path, partial.map(row => JSON.stringify(row)).join("\n") + "\n");
    assert.throws(() => openValidation(w.store).evaluate(frozen, w.validation.reserve(w.reserved)),
      searched ? /validation_overlaps_search/ : /validation_observations_already_used/);
  }
});

test("adding optional labels cannot refresh an unlabelled exposed assessment", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), path = join(w.reserved, "scenarios.jsonl");
  const original = readFileSync(path);
  writeFileSync(path, original.toString().trim().split("\n").map(line => {
    const row = JSON.parse(line); delete row.label; return JSON.stringify(row);
  }).join("\n") + "\n");
  const unlabelled = w.validation.reserve(w.reserved);
  assert.equal(w.validation.evaluate(frozen, unlabelled).status, "passed");
  w.validation.expose(frozen, unlabelled);
  writeFileSync(path, original);
  const labelled = w.validation.reserve(w.reserved);
  assert.throws(() => openValidation(w.store).evaluate(frozen, labelled), /validation_already_used/);
  assert.throws(() => openValidation(w.store).finalEvidence(frozen, labelled), /validation_feedback_exposed/);
});

test("observation values stay distinct and genuinely later events supply fresh final evidence", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), path = join(w.reserved, "scenarios.jsonl");
  const original = readFileSync(path, "utf8");
  const first = w.validation.reserve(w.reserved);
  w.validation.evaluate(frozen, first); w.validation.expose(frozen, first);
  // Public usage lookup must retain every meaningful event field, even ones the
  // selected rule does not read. These are valid schema values, not store edits.
  const distinct: Record<string, (row: Record<string, any>) => unknown> = {
    merchant_id: row => "other-" + row.merchant_id,
    tenant: () => "other-tenant",
    risk_type: () => "other-risk",
    kind: row => row.kind === "authorization" ? "settlement" : "authorization",
    ts: row => new Date(Date.parse(row.ts) + 1000).toISOString(),
    amount: row => row.amount + 1,
    currency: () => "EUR",
    score: () => 0.5,
    score_provenance: () => "assumed",
    fields: () => ({ invented_feature: 3 }),
    transaction_id: row => "other-" + row.transaction_id,
  };
  for (const [field, value] of Object.entries(distinct)) {
    writeFileSync(path, original.trim().split("\n").map(line => {
      const row = JSON.parse(line); row[field] = value(row); return JSON.stringify(row);
    }).join("\n") + "\n");
    const changed = w.validation.reserve(w.reserved);
    assert.deepEqual(openValidation(w.store).usage(changed), [], field);
  }
  const later = original.trim().split("\n").map(line => {
    const row = JSON.parse(line); row.ts = distinct.ts!(row); return JSON.stringify(row);
  }).join("\n") + "\n";
  writeFileSync(path, later);
  const fresh = w.validation.reserve(w.reserved), reopened = openValidation(w.store);
  const result = reopened.evaluate(frozen, fresh);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.comparison.retained_fraud_case_ids, ["protected"]);
  assert.deepEqual(result.comparison.new_fraud_case_ids, ["new-jump"]);
  assert.deepEqual(result.comparison.legitimate_merchants?.candidate, []);
  assert.deepEqual(reopened.finalEvidence(frozen, fresh), result);
  assert.equal(readFileSync(path, "utf8"), later);
});

test("feature key order preserves use while fresh malformed observation metadata remains rejected", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), path = join(w.reserved, "scenarios.jsonl");
  const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const save = () => writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  for (const row of rows) row.fields = { invented_a: 1, invented_b: 2 };
  save();
  const first = w.validation.reserve(w.reserved);
  assert.equal(w.validation.evaluate(frozen, first).status, "passed");
  w.validation.expose(frozen, first);
  for (const row of rows) row.fields = { invented_b: 2, invented_a: 1 };
  save();
  assert.throws(() => openValidation(w.store).evaluate(frozen, w.validation.reserve(w.reserved)), /validation_already_used/);
  // Unrecognised root metadata is not an admitted extension of the run schema.
  for (const row of rows) { row.fields.invented_a = 3; row.presentation_note = "invented"; }
  save();
  const rejected = openValidation(w.store).evaluate(frozen, w.validation.reserve(w.reserved));
  assert.equal(rejected.status, "failed");
  assert.equal(rejected.reason, "incumbent_evaluation_rejected");
  assert.match(rejected.comparison.detail!, /unknown scenario field presentation_note/);
});

test("feedback exposure persists and renaming observations cannot supply fresh final evidence", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), reserved = w.validation.reserve(w.reserved);
  const result = w.validation.evaluate(frozen, reserved);
  assert.equal(w.validation.finalEvidence(frozen, reserved).assessment_id, result.assessment_id);
  w.validation.expose(frozen, reserved);
  assert.throws(() => openValidation(w.store).finalEvidence(frozen, reserved), /validation_feedback_exposed/);
  const manifest = JSON.parse(readFileSync(join(w.reserved, "manifest.json"), "utf8"));
  manifest.authored_outcomes.dataset_id = "renamed-not-new";
  manifest.authored_outcomes.version = "renamed-outcomes";
  manifest.history.snapshot_version = "renamed-snapshot";
  writeFileSync(join(w.reserved, "manifest.json"), JSON.stringify(manifest));
  const renamed = w.validation.reserve(w.reserved);
  assert.notEqual(renamed, reserved);
  assert.throws(() => w.validation.evaluate(frozen, renamed), /validation_already_used/);
  const usage = w.validation.usage(renamed);
  assert.deepEqual(usage.map(row => row.transition), ["claimed", "completed", "exposed", "rejected"]);
  assert.equal(new Set(usage.map(row => row.provenance.validation_identity)).size, 1);
  // A separate Node process sees persisted use, not a reset local counter.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { openValidation } from './src/seams/comparison.ts';
     try { openValidation(process.argv[1]).evaluate(process.argv[2], process.argv[3]); process.exit(3); }
     catch (error) { if (error.message !== 'validation_already_used') throw error; }`, w.store, frozen, renamed], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const replay = join(w.root, "after-exposure"); mkdirSync(replay);
  assert.deepEqual(w.validation.replay(frozen, reserved, replay), result); // Historical replay is still reproducible.
  for (const file of ["manifest.json", "scenarios.jsonl"]) writeFileSync(join(w.reserved, file), readFileSync(join(w.reserved, file), "utf8").replaceAll("r-m-", "fresh-m-"));
  const fresh = w.validation.reserve(w.reserved);
  assert.equal(w.validation.evaluate(frozen, fresh).status, "passed");
});

test("every frozen input and candidate evidence file rejects independent tampering before evaluation", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), reserved = w.validation.reserve(w.reserved);
  const dir = join(w.store, "frozen", frozen), descriptor = JSON.parse(readFileSync(join(dir, "snapshot.json"), "utf8"));
  for (const name of Object.keys(descriptor.files)) {
    const path = join(dir, "artifacts", name), original = readFileSync(path);
    writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
    assert.throws(() => w.validation.evaluate(frozen, reserved), { message: `frozen_artifact_mismatch:frozen:${name}` }, name);
    assert.deepEqual(readdirSync(join(w.store, "assessments")), []);
    assert.deepEqual(w.validation.usage(reserved), []);
    writeFileSync(path, original);
  }
  const file = join(dir, "artifacts/comparison-plan.json"), original = readFileSync(file);
  for (const change of [
    (plan: any) => { plan.target = "legitimate_merchants"; },
    (plan: any) => { plan.proposal.change.thresholds[0].value = 4; },
    (plan: any) => { plan.proposal.change.thresholds[0].max = 99; },
    (plan: any) => { plan.proposal.expected_effect.claim = "changed candidate explanation"; },
  ]) {
    const plan = JSON.parse(original.toString()); change(plan); writeFileSync(file, JSON.stringify(plan));
    assert.throws(() => w.validation.evaluate(frozen, reserved), /frozen_artifact_mismatch:frozen:comparison-plan.json/);
  }
  writeFileSync(file, original);
  const manifestPath = join(dir, "artifacts/inputs/manifest.json"), manifestBytes = readFileSync(manifestPath);
  for (const change of [
    (manifest: any) => { manifest.daily_totals.units = "major_currency_units"; },
    (manifest: any) => { manifest.daily_totals.reference.estimator = "changed-estimator"; },
    (manifest: any) => { manifest.workload.max_events = 999999; },
    (manifest: any) => { manifest.seed = 42; },
  ]) {
    const manifest = JSON.parse(manifestBytes.toString()); change(manifest); writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => w.validation.evaluate(frozen, reserved), /frozen_artifact_mismatch:frozen:inputs\/manifest.json/);
  }
  writeFileSync(manifestPath, manifestBytes);
  for (const [name, from, to] of [
    ["suite/rules/lantern-daily.yaml", "value: 10000", "value: 11000"],
    ["suite/rules/lantern-daily.yaml", "min: 5000", "min: 4000"],
    ["suite/rules/lantern-daily.yaml", "max: 20000", "max: 30000"],
    ["suite/rules/lantern-daily.yaml", "step: 1000", "step: 500"],
    ["suite/catalog.yaml", "unit: minor_currency_units", "unit: major_currency_units"],
    ["suite/catalog.yaml", "window_days: 1", "window_days: 2"],
    ["suite/catalog.yaml", "estimator: trailing_median_mad", "estimator: altered"],
  ]) {
    const path = join(dir, "artifacts/inputs", name!), bytes = readFileSync(path);
    assert.ok(bytes.toString().includes(from!)); writeFileSync(path, bytes.toString().replace(from!, to!));
    assert.throws(() => w.validation.evaluate(frozen, reserved), { message: `frozen_artifact_mismatch:frozen:inputs/${name}` });
    writeFileSync(path, bytes);
  }
  assert.equal(w.validation.evaluate(frozen, reserved).status, "passed");
});

test("reserved authority and saved artifact changes cannot replace frozen features or bounds", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison);
  const path = join(w.reserved, "suite/rules/lantern-daily.yaml"), original = readFileSync(path);
  writeFileSync(path, original.toString().replace("max: 60", "max: 61"));
  const changed = w.validation.reserve(w.reserved);
  assert.throws(() => w.validation.evaluate(frozen, changed), /frozen_artifact_mismatch:reserved:suite\/rules/);
  assert.deepEqual(w.validation.usage(changed), []);
  writeFileSync(path, original);
  const reserved = w.validation.reserve(w.reserved);
  const snapshot = join(w.store, "reserved", reserved, "artifacts/scenarios.jsonl");
  writeFileSync(snapshot, readFileSync(snapshot, "utf8") + "\n");
  assert.throws(() => w.validation.evaluate(frozen, reserved), /frozen_artifact_mismatch:reserved:scenarios.jsonl/);
});

// Independently worked variants: small-history reference = 144.47739, large
// history reference = 14447.739; incumbent threshold = 10000. No engine-derived labels.
for (const variant of [
  { name: "withheld legitimate growth", edits: [["r-m-high", [9000, 10000, 11000, 10000]], ["r-m-low", [90, 100, 110, 150]]] as const,
    reason: "increased_legitimate_merchant_flags", lost: [], added: ["new-jump"], flags: ["r-m-low"] },
  { name: "withheld fraud escalation and lost-case substitution", edits: [["r-m-protected", [9000, 10000, 11000, 12000]]] as const,
    reason: "lost_incumbent_fraud_case", lost: ["protected"], added: ["new-jump"], flags: [] },
  { name: "wrong-target-only gain", edits: [["r-m-new", [90, 100, 110, 100]]] as const,
    reason: "no_strict_target_improvement", lost: [], added: [], flags: [] },
  { name: "tie", edits: [["r-m-new", [90, 100, 110, 100]], ["r-m-high", [9000, 10000, 11000, 10000]]] as const,
    reason: "no_strict_target_improvement", lost: [], added: [], flags: [] },
]) test(`search winner fails reserved ${variant.name}`, t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison);
  const before = readFileSync(join(w.comparison, "incumbent/verdicts.jsonl"));
  for (const [merchant, amounts] of variant.edits) changeAmounts(w.reserved, merchant, [...amounts]);
  const reserved = w.validation.reserve(w.reserved), result = w.validation.evaluate(frozen, reserved);
  assert.equal(result.status, "failed"); assert.equal(result.reason, variant.reason);
  assert.deepEqual(result.comparison.lost_fraud_case_ids, variant.lost);
  assert.deepEqual(result.comparison.new_fraud_case_ids, variant.added);
  assert.deepEqual(result.comparison.legitimate_merchants?.candidate, variant.flags);
  assert.equal(result.experimental_acceptance, "not_assessed");
  assert.deepEqual(readFileSync(join(w.comparison, "incumbent/verdicts.jsonl")), before);
});

test("inapplicable and unavailable reserved evidence cannot count as improved legitimate flags", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison);
  for (const merchant of ["protected", "new", "high", "low", "unknown", "immature"]) changeAmounts(w.reserved, `r-m-${merchant}`, [0, 0, 0, 12000]);
  const reserved = w.validation.reserve(w.reserved), result = w.validation.evaluate(frozen, reserved);
  assert.equal(result.status, "failed"); assert.equal(result.reason, "unavailable_evaluation:candidate");
  assert.equal(result.comparison.legitimate_merchants, null);
  assert.deepEqual(result.comparison.monetary_assessment, { status: "unperformed", assessed_count: 0, failure_count: null });
});

test("missing, incompatible and non-search saved evidence cannot be frozen", t => {
  const w = workspace(t), path = join(w.comparison, "candidate/scenario-metrics.jsonl"), original = readFileSync(path);
  writeFileSync(path, original.toString() + "\n");
  assert.throws(() => w.validation.freeze(w.comparison), /search_evidence_mismatch:candidate\/scenario-metrics.jsonl/);
  rmSync(path); assert.throws(() => w.validation.freeze(w.comparison), /search_evidence_mismatch:file_set/);
  writeFileSync(path, original);
  const out = join(w.root, "reserved-comparison"); mkdirSync(out);
  compareRuns(w.reserved, out, { target: "fraud_cases", proposal: proposal() });
  assert.throws(() => w.validation.freeze(out), /freeze_requires_search_evidence/);
});

test("reserved identities cannot be paths, search or known-regression purposes", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison);
  for (const invalid of ["../reserved", "..\\reserved", "C:\\reserved", "constructor", "__proto__", "file:///reserved"]) {
    assert.throws(() => w.validation.evaluate(frozen, invalid), /invalid_artifact_identity/);
    assert.throws(() => w.validation.evaluate(invalid, frozen), /invalid_artifact_identity/);
  }
  const searched = w.validation.reserve(w.search);
  assert.throws(() => w.validation.evaluate(frozen, searched), /validation_overlaps_search/);
  const path = join(w.reserved, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.authored_outcomes.partition = "known-regression-corpus"; writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => w.validation.evaluate(frozen, w.validation.reserve(w.reserved)), /partition|not_reserved_validation/);
});

test("pinned byte budget fails before snapshot creation and absent stores never reset", t => {
  const w = workspace(t), small = createValidation(join(w.root, "small"), { max_input_bytes: 1 });
  assert.throws(() => small.reserve(w.reserved), /validation_input_budget_exceeded/);
  assert.throws(() => small.freeze(w.comparison), /validation_input_budget_exceeded/);
  assert.deepEqual(readdirSync(join(w.root, "small/reserved")), []);
  assert.throws(() => createValidation(w.store, { max_input_bytes: 99 }), /EEXIST/);
  assert.throws(() => openValidation(join(w.root, "absent")), /validation_store_missing/);
});

test("a partly reused history cannot become fresh by adding or changing a single observation", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), reserved = w.validation.reserve(w.reserved);
  w.validation.evaluate(frozen, reserved); w.validation.expose(frozen, reserved);
  changeAmounts(w.reserved, "r-m-low", [90, 100, 110, 101]);
  const changed = w.validation.reserve(w.reserved);
  assert.notEqual(changed, reserved);
  assert.throws(() => openValidation(w.store).evaluate(frozen, changed), /validation_observations_already_used/);
});

test("ordinary public feedback test detects a deliberately disabled exposure gate", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-reserved-mutation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["src", "fixtures/comparison/paired-history", "test/reserved-validation.test.ts", "package.json"]) {
    mkdirSync(join(root, name, ".."), { recursive: true }); cpSync(name, join(root, name), { recursive: true });
  }
  const path = join(root, "src/reserved-validation.ts"), original = readFileSync(path, "utf8");
  const needle = 'if (uses.some(use => use.transition === "exposed"))';
  assert.equal(original.split(needle).length, 2);
  writeFileSync(path, original.replace(needle, "if (false)"));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const broken = spawnSync(process.execPath, ["--test", "--test-name-pattern", "feedback exposure persists", "test/reserved-validation.test.ts"], { cwd: root, encoding: "utf8", env });
  assert.notEqual(broken.status, 0, broken.stdout + broken.stderr);
  assert.match(broken.stdout + broken.stderr, /Missing expected exception/);
  assert.doesNotMatch(broken.stdout + broken.stderr, /ERR_MODULE_NOT_FOUND/);
});

test("ordinary label regressions detect restoration of label-sensitive observation identity", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-label-mutation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["src", "fixtures/comparison/paired-history", "test/reserved-validation.test.ts", "package.json"]) {
    mkdirSync(join(root, name, ".."), { recursive: true }); cpSync(name, join(root, name), { recursive: true });
  }
  const path = join(root, "src/reserved-validation.ts"), original = readFileSync(path, "utf8");
  const needle = 'return digest(json(observation));';
  assert.equal(original.split(needle).length, 2);
  writeFileSync(path, original.replace(needle,
    'const { event_id: _alias, ...rawObservation } = row; return digest(json(rawObservation));'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const broken = spawnSync(process.execPath, ["--test", "--test-name-pattern", "optional label removal", "test/reserved-validation.test.ts"],
    { cwd: root, encoding: "utf8", env });
  assert.notEqual(broken.status, 0, broken.stdout + broken.stderr);
  assert.match(broken.stdout + broken.stderr, /Missing expected exception/);
  assert.match(broken.stdout + broken.stderr, /validation_already_used/);
  assert.match(broken.stdout + broken.stderr, /validation_overlaps_search/);
  assert.match(broken.stdout + broken.stderr, /fail 2/);
  assert.doesNotMatch(broken.stdout + broken.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/);
});

test("legitimate target remains pinned across reserved success and fraud-only gain", t => {
  const w = workspace(t, "legitimate_merchants"), frozen = w.validation.freeze(w.comparison);
  assert.equal(w.validation.evaluate(frozen, w.validation.reserve(w.reserved)).status, "passed");
  for (const file of ["manifest.json", "scenarios.jsonl"]) writeFileSync(join(w.reserved, file), readFileSync(join(w.reserved, file), "utf8").replaceAll("r-m-", "fresh-m-"));
  changeAmounts(w.reserved, "fresh-m-high", [9000, 10000, 11000, 10000]);
  const result = w.validation.evaluate(frozen, w.validation.reserve(w.reserved));
  assert.equal(result.status, "failed"); assert.equal(result.reason, "no_strict_target_improvement");
  assert.deepEqual(result.comparison.new_fraud_case_ids, ["new-jump"]);
  assert.equal(result.comparison.target, "legitimate_merchants");
});

test("unperformed reserved truth remains explicit and is never a pass", t => {
  const w = workspace(t), frozen = w.validation.freeze(w.comparison), path = join(w.reserved, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")); manifest.authored_outcomes.stories_enabled = false;
  for (const merchant of manifest.authored_outcomes.merchants) merchant.classification = "unknown";
  writeFileSync(path, JSON.stringify(manifest));
  const result = w.validation.evaluate(frozen, w.validation.reserve(w.reserved));
  assert.equal(result.status, "failed"); assert.equal(result.reason, "unperformed_required_assessment");
  assert.equal(result.comparison.legitimate_merchants, null);
  assert.equal(result.comparison.monetary_assessment.failure_count, null);
});

test("operator command and frozen replay preserve opaque original evidence end to end", t => {
  const w = workspace(t), original = Buffer.from("fffe7b007d00", "hex");
  for (const input of [w.search, w.reserved]) writeFileSync(join(input, "admission.json"), original);
  const search = join(w.root, "opaque-search"); mkdirSync(search);
  compareRuns(w.search, search, { target: "fraud_cases", proposal: proposal() });
  const command = (...args: string[]) => {
    const result = spawnSync(process.execPath, ["scripts/validate.ts", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout.trim();
  };
  const store = join(w.root, "command-store"); command("create", store, "2000000");
  const frozen = command("freeze", store, search), reserved = command("reserve", store, w.reserved);
  const result = JSON.parse(command("evaluate", store, frozen, reserved));
  assert.equal(result.status, "passed");
  assert.deepEqual(JSON.parse(command("evidence", store, frozen, reserved)), result);
  const replay = join(w.root, "command-replay");
  assert.deepEqual(JSON.parse(command("replay", store, frozen, reserved, replay)), result);
  assert.deepEqual(readFileSync(join(replay, "comparison/inputs/admission.json")), original);
  assert.deepEqual(readFileSync(join(replay, "comparison/candidate/source-translation.json")), original);
  command("expose", store, frozen, reserved);
  assert.equal(JSON.parse(command("usage", store, reserved)).at(-1).transition, "exposed");
  const refused = spawnSync(process.execPath, ["scripts/validate.ts", "evidence", store, frozen, reserved], { encoding: "utf8" });
  assert.equal(refused.status, 1); assert.match(refused.stderr, /validation_feedback_exposed/);
});
