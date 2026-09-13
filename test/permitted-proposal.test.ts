import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMapping, parseYaml, type YamlValue } from "../src/yaml.ts";
import { readRule } from "../src/rules.ts";
import { applyProposal } from "../src/seams/proposal.ts";
import { readManifest, runCase } from "../src/seams/run.ts";
import { readJsonl } from "../src/ledger.ts";
import { parseAssistedTranslation } from "../src/seams/parser.ts";

// Confirmed seams: proposal admission and run artifacts.
const fixture = "fixtures/run/merchant-reference";
function authority() {
  return {
    rules: ["lantern-daily", "relative"].map(name => readRule(parseYaml(readFileSync(`${fixture}/suite/rules/${name}.yaml`, "utf8")), name)),
    catalog: parseYaml(readFileSync(`${fixture}/suite/catalog.yaml`, "utf8")),
    manifest: readManifest(JSON.parse(readFileSync(`${fixture}/manifest.json`, "utf8"))),
  };
}
function proposal(change: YamlValue = { rule_id: "lantern-relative", thresholds: [{ id: "lantern-k", value: 11, min: 1, max: 100 }] }) {
  return { kind: "parameter_change", tenant: "t-alpha", change,
    proving_scenario: { history: "invented-lantern-history" },
    expected_effect: { claim: "hypothesis only" }, gate_status: "ungated until replay" };
}

test("proposal cannot authorize sensitivity 11 with its own range when the suite maximum is 10", () => {
  const result = applyProposal(proposal(), authority());
  assert.equal(result.state, "rejected");
  assert.ok(result.reasons.some(reason => /lantern-k.*authoritative range 1\.\.10/.test(reason)));
  assert.equal(result.rules, null);
});

const experiment = "fixtures/proposal/permitted-rule-changes";
function rows(dir: string, name: string) {
  return readJsonl(join(dir, `${name}.jsonl`)) as Record<string, unknown>[];
}
function outputs(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "fwh-proposal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (name: string) => { const path = join(root, name); mkdirSync(path); return path; };
}

test("rejected attempts distinguish original input contexts reproducibly without executing a candidate", t => {
  const out = outputs(t), source = out("input"); cpSync(experiment, source, { recursive: true });
  const originalManifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  const originals = new Map(readdirSync(source, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => { const path = join(entry.parentPath, entry.name); return [path, readFileSync(path)]; }));
  const incumbent = runCase(source, out("incumbent"));
  const doc = parseYaml(readFileSync(`${source}/proposal.yaml`, "utf8"));
  assert.ok(isMapping(doc) && isMapping(doc.change));
  doc.change.generator = { enable: true };
  const reject = (name: string) => {
    const dir = out(name);
    assert.throws(() => runCase(source, dir, { proposal: doc }), /change.generator/);
    assert.deepEqual(readdirSync(dir).sort(), name === "translation" ? ["proposal-attempts.jsonl", "source-translation.json"] : ["proposal-attempts.jsonl"]);
    const attempt = rows(dir, "proposal-attempts")[0]!;
    assert.equal(attempt.state, "rejected");
    assert.equal(attempt.experimental_acceptance, "not_assessed");
    assert.equal(attempt.incumbent_run_id, null);
    assert.equal(attempt.candidate_run_id, null);
    assert.equal(attempt.candidate_suite_id, null);
    assert.deepEqual(attempt.proposal, doc);
    return { attempt, bytes: readFileSync(join(dir, "proposal-attempts.jsonl")) };
  };
  const first = reject("first"), repeated = reject("repeated");
  assert.deepEqual(first.bytes, repeated.bytes);
  const context = first.attempt.input_context as Record<string, unknown>;
  assert.ok(context, "rejected row must retain original input context");
  assert.equal(context.identity_kind, "input_context");
  assert.match(String(context.id), /^[a-f0-9]{64}$/);
  assert.deepEqual(context.manifest, originalManifest);
  const digests = context.input_digests as Record<string, string>;
  assert.deepEqual(Object.keys(digests).sort(), ["scenarios.jsonl", "suite/catalog.yaml", "suite/rules/lantern-daily.yaml", "suite/tenant.yaml"]);
  for (const digest of Object.values(digests)) assert.match(digest, /^[a-f0-9]{64}$/);
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(path), bytes, path);
  assert.deepEqual(runCase(source, out("incumbent-again")), incumbent);

  const changed = (name: string) => {
    const attempt = reject(name).attempt;
    assert.equal(attempt.proposal_id, first.attempt.proposal_id);
    assert.deepEqual(attempt.reasons, first.attempt.reasons);
    const trace = attempt.input_context as Record<string, unknown>;
    assert.notEqual(trace.id, context.id, name);
    return trace;
  };
  for (const [name, manifest] of [
    ["seed", { ...originalManifest, seed: 99 }],
    ["history-version", { ...originalManifest, history: { ...originalManifest.history, snapshot_version: "v2" } }],
    ["manifest", { ...originalManifest, goal: "another invented goal" }],
  ] as const) {
    writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
    const trace = changed(name);
    assert.deepEqual(trace.manifest, manifest);
    assert.deepEqual(trace.input_digests, digests);
  }
  for (const [path, bytes] of originals) writeFileSync(path, bytes);
  const history = rows(source, "scenarios"); history[0]!.amount = 11;
  writeFileSync(join(source, "scenarios.jsonl"), history.map(row => JSON.stringify(row)).join("\n") + "\n");
  const changedHistory = changed("history-values");
  assert.notEqual((changedHistory.input_digests as Record<string, string>)["scenarios.jsonl"], digests["scenarios.jsonl"]);
  for (const [path, bytes] of originals) writeFileSync(path, bytes);
  for (const path of Object.keys(digests)) {
    // A source comment (or blank JSONL line) changes original artifact identity
    // without changing proposal rejection or manufacturing an evaluated run.
    const file = join(source, path), before = readFileSync(file);
    writeFileSync(file, Buffer.concat([before, Buffer.from(path.endsWith("yaml") ? "\n# invented revision\n" : "\n")]));
    const trace = changed(path.replaceAll("/", "-"));
    assert.notEqual((trace.input_digests as Record<string, string>)[path], digests[path], path);
    assert.deepEqual(trace.manifest, originalManifest);
    writeFileSync(file, before);
  }
  writeFileSync(join(source, "admission.json"), '{"source":"invented-translation"}\n');
  const translated = changed("translation");
  assert.match((translated.input_digests as Record<string, string>)["admission.json"]!, /^[a-f0-9]{64}$/);
});

test("permitted conversion and shorter window turn the completed 150-unit jump into an alert", t => {
  const out = outputs(t);
  const incumbent = out("incumbent"), candidate = out("candidate");
  const doc = parseYaml(readFileSync(`${experiment}/proposal.yaml`, "utf8"));
  runCase(experiment, incumbent);
  runCase(experiment, candidate, { proposal: doc });
  assert.deepEqual(rows(incumbent, "verdicts").map(row => row.verdict), ["did_not_fire"]);
  assert.deepEqual(rows(candidate, "verdicts").map(row => row.verdict), ["alert"]);
  // Prior 3 days: 90,100,110. Median100, MAD10, k3 =>144.47739065974796.
  const reference = rows(candidate, "feature-snapshots")[0]!.reference as Record<string, unknown>;
  assert.equal(reference.median, 100);
  assert.equal(reference.mad, 10);
  assert.ok(Math.abs(Number(reference.value) - 144.47739065974796) < 1e-10);
});

test("bounded proposal admission names protected targets, unsupported changes and invalid parameters", () => {
  const valid = () => proposal({ rule_id: "lantern-relative", thresholds: [{ id: "lantern-k", value: 2, min: 1, max: 10 }] });
  const attempts: [YamlValue, RegExp][] = [];
  for (const target of ["generator", "labels", "evaluator", "tests", "bounds", "validation_tests"]) {
    attempts.push([{ ...valid(), [target]: {} }, new RegExp(target)]);
    attempts.push([{ ...valid(), change: { ...valid().change as object, [target]: {} } }, new RegExp(target)]);
  }
  for (const kind of ["new_rule", "merge_rules", "retire_rule", "relationship_condition", "nonsense"]) {
    attempts.push([{ ...valid(), kind }, /kind/]);
  }
  for (const [id, value, reason] of [
    ["unknown-knob", 2, /unknown-knob/], ["lantern-k", 1.5, /lantern-k.*step/],
    ["lantern-k", "2", /lantern-k/], ["lantern-k", null, /lantern-k/],
    ["lantern-window", 0, /lantern-window/], ["lantern-minimum", 2, /lantern-minimum.*not permitted/],
    ["lantern-unit", 1, /lantern-unit.*not permitted/], ["lantern-floor", 6000, /lantern-floor/],
  ] as const) attempts.push([proposal({ rule_id: "lantern-relative", thresholds: [{ id, value, min: 1, max: 10 }] }), reason]);
  attempts.push([proposal({ rule_id: "missing-rule", thresholds: [{ id: "lantern-k", value: 2, min: 1, max: 10 }] }), /missing-rule/]);
  attempts.push([proposal({ rule_id: "lantern-relative", thresholds: [] }), /empty|at least one/]);
  attempts.push([proposal({ rule_id: "lantern-relative", thresholds: [
    { id: "lantern-k", value: 2, min: 1, max: 10 }, { id: "lantern-k", value: 3, min: 1, max: 10 },
  ] }), /duplicate.*lantern-k/]);
  attempts.push([proposal({ rule_id: "lantern-relative", thresholds: [{ id: "lantern-k", value: 2, min: 1, max: 100 }] }), /lantern-k.*bounds/]);
  const original = authority();
  const before = JSON.stringify(original);
  for (const [doc, reason] of attempts) {
    const result = applyProposal(doc, original);
    assert.equal(result.state, "rejected", JSON.stringify(doc));
    assert.ok(result.reasons.some(r => reason.test(r)), `${reason}: ${result.reasons.join("; ")}`);
    assert.equal(result.rules, null);
  }
  assert.equal(JSON.stringify(original), before);
});

test("conversion alone changes evaluation and window tuning separately recomputes the reference", t => {
  const out = outputs(t);
  const source = out("input"); cpSync(experiment, source, { recursive: true });
  const doc = parseYaml(readFileSync(`${source}/proposal.yaml`, "utf8"));
  assert.ok(isMapping(doc) && isMapping(doc.change));
  delete doc.change.thresholds;
  const long = out("long"), short = out("short");
  runCase(source, long, { proposal: doc });
  doc.change.thresholds = [{ id: "lantern-window", value: 3, min: 3, max: 60 }];
  runCase(source, short, { proposal: doc });
  assert.deepEqual([long, short].map(dir => rows(dir, "verdicts")[0]!.verdict), ["did_not_fire", "alert"]);
  const reference = rows(long, "feature-snapshots")[0]!.reference as Record<string, unknown>;
  // Five prior days 10,20,90,100,110: median90, MAD20, k3 =>178.95478131949592.
  assert.equal(reference.median, 90);
  assert.equal(reference.mad, 20);
  assert.ok(Math.abs(Number(reference.value) - 178.95478131949592) < 1e-10);
  const events = rows(source, "scenarios"); events[5]!.amount = 200;
  writeFileSync(join(source, "scenarios.jsonl"), events.map(row => JSON.stringify(row)).join("\n") + "\n");
  delete doc.change.thresholds;
  const fixed = out("fixed200"), converted = out("converted200");
  runCase(source, fixed); runCase(source, converted, { proposal: doc });
  assert.deepEqual([fixed, converted].map(dir => rows(dir, "verdicts")[0]!.verdict), ["did_not_fire", "alert"]);
});

test("experimental suite and run are distinct, content stable and preserve the unchanged incumbent", t => {
  const out = outputs(t);
  const source = out("input"); cpSync(experiment, source, { recursive: true });
  const originals = new Map(readdirSync(source, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => { const path = join(entry.parentPath, entry.name); return [path, readFileSync(path)]; }));
  const doc = parseYaml(readFileSync(`${source}/proposal.yaml`, "utf8"));
  const incumbent = runCase(source, out("incumbent"));
  const firstDir = out("first"), secondDir = out("second");
  const first = runCase(source, firstDir, { proposal: doc });
  const second = runCase(source, secondDir, { proposal: doc });
  assert.notEqual(first.run_id, incumbent.run_id);
  assert.notEqual(first.suite_id, incumbent.suite_id);
  assert.equal(first.run_id, second.run_id);
  for (const name of readdirSync(firstDir)) assert.deepEqual(readFileSync(join(firstDir, name)), readFileSync(join(secondDir, name)), name);
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(path), bytes, path);
  assert.deepEqual(runCase(source, out("incumbent-again")), incumbent);
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8")); manifest.seed = 99;
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest));
  const another = runCase(source, out("another-seed"), { proposal: doc });
  assert.equal(another.suite_id, first.suite_id);
  assert.notEqual(another.run_id, first.run_id);
  const artifact = JSON.parse(readFileSync(join(firstDir, "candidate-suite.json"), "utf8"));
  assert.equal(artifact.suite_id, first.suite_id);
  assert.deepEqual(artifact.rules[0].conditions, [{ kind: "field_factor", field: "lantern_daily_value", operator: "gt", other_field: "lantern_value_baseline", factor: "lantern-unit" }]);
  const attempt = rows(firstDir, "proposal-attempts")[0]!;
  assert.equal(attempt.state, "admitted");
  assert.deepEqual(attempt.reasons, []);
  assert.equal(attempt.experimental_acceptance, "not_assessed");
  assert.equal(attempt.incumbent_suite_id, incumbent.suite_id);
  assert.equal(attempt.candidate_suite_id, first.suite_id);
  assert.equal(attempt.candidate_run_id, first.run_id);
  assert.deepEqual(attempt.proposal, doc);
});

test("admitted and rejected attempts retain supplied translation and proposal provenance without acceptance claims", t => {
  const out = outputs(t), source = out("input"); cpSync(experiment, source, { recursive: true });
  const read = (name: string) => readFileSync(`fixtures/parser/assisted-readable/${name}`, "utf8");
  const translation = parseAssistedTranslation(read("source.json"), read("model-output.json"), read("expectations.json"));
  assert.equal(translation.status, "admitted");
  // A supplied historical artifact is preserved, not re-certified as the current
  // suite's meaning. Source admission and improvement admission stay distinct.
  const translationText = JSON.stringify(translation, null, 2) + "\n";
  writeFileSync(join(source, "admission.json"), translationText);
  const doc = parseYaml(readFileSync(`${source}/proposal.yaml`, "utf8"));
  assert.ok(isMapping(doc) && isMapping(doc.change));
  doc.provenance = { proposer: "invented-author", source_version: "trial-one" };
  const acceptedDir = out("admitted");
  const admitted = runCase(source, acceptedDir, { proposal: doc });
  const good = rows(acceptedDir, "proposal-attempts")[0]!;
  assert.equal(readFileSync(join(acceptedDir, "source-translation.json"), "utf8"), translationText);
  assert.equal(good.state, "admitted");
  assert.equal(good.experimental_acceptance, "not_assessed");
  assert.deepEqual(good.proposal, doc);
  assert.equal((good.source_translation as Record<string, unknown>).verification, "supplied_artifact");
  const rejectedDir = out("rejected"); doc.change.generator = { enable: true };
  assert.throws(() => runCase(source, rejectedDir, { proposal: doc }), /change.generator/);
  assert.deepEqual(readdirSync(rejectedDir).sort(), ["proposal-attempts.jsonl", "source-translation.json"]);
  const rejected = rows(rejectedDir, "proposal-attempts")[0]!;
  // Admission and rejection against the same inputs share context identity,
  // although their proposals and execution artifacts are different.
  assert.deepEqual(rejected.input_context, good.input_context);
  assert.notEqual(rejected.proposal_id, good.proposal_id);
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.experimental_acceptance, "not_assessed");
  assert.equal(rejected.candidate_suite_id, null);
  assert.equal(rejected.candidate_run_id, null);
  assert.deepEqual(rejected.proposal, doc);
  assert.ok((rejected.reasons as string[]).some(reason => reason.includes("generator")));
  delete doc.change.generator;
  writeFileSync(join(source, "admission.json"), JSON.stringify(translation) + "\n");
  const changedDir = out("source-changed");
  const changedSource = runCase(source, changedDir, { proposal: doc });
  assert.equal(changedSource.suite_id, admitted.suite_id);
  assert.notEqual(changedSource.run_id, admitted.run_id);
  const beforeContext = good.input_context as Record<string, unknown>;
  const afterContext = rows(changedDir, "proposal-attempts")[0]!.input_context as Record<string, unknown>;
  assert.ok(beforeContext && afterContext, "admitted attempts retain original inputs too");
  assert.notEqual(afterContext.id, beforeContext.id);
  assert.deepEqual(afterContext.manifest, beforeContext.manifest);
  assert.equal((beforeContext.input_digests as Record<string, string>)["admission.json"], (good.source_translation as Record<string, unknown>).sha256);
});

test("conversion authority cannot name the wrong comparison and parameter-only moves must affect a relative rule", () => {
  const doc = parseYaml(readFileSync(`${experiment}/proposal.yaml`, "utf8"));
  assert.ok(isMapping(doc) && isMapping(doc.change));
  const base = { rules: [readRule(parseYaml(readFileSync(`${experiment}/suite/rules/lantern-daily.yaml`, "utf8")), "incumbent")],
    catalog: parseYaml(readFileSync(`${experiment}/suite/catalog.yaml`, "utf8")),
    manifest: readManifest(JSON.parse(readFileSync(`${experiment}/manifest.json`, "utf8"))) };
  assert.equal(applyProposal({ ...doc, kind: "parameter_change", change: { rule_id: "lantern-daily", thresholds: [{ id: "lantern-k", value: 2, min: 1, max: 10 }] } }, base).state, "rejected");
  for (const mutate of [
    (a: typeof base) => { a.rules[0]!.conditions = [{ kind: "field_constant", field: "amount", operator: "gt", threshold: "lantern-floor" }]; },
    (a: typeof base) => { a.rules[0]!.thresholds.find(t => t.id === "lantern-unit")!.value = 2; },
    (a: typeof base) => { a.rules[0]!.conditions = [{ kind: "field_constant", field: "lantern_daily_value", operator: "lt", threshold: "lantern-floor" }]; },
    (a: typeof base) => { a.rules[0]!.conditions = []; },
  ]) {
    const a = structuredClone(base); mutate(a);
    const result = applyProposal(doc, a);
    assert.equal(result.state, "rejected");
    assert.ok(result.reasons.some(r => /conversion|lantern-unit/.test(r)), result.reasons.join("; "));
  }
  const unchanged = proposal({ rule_id: "lantern-relative", thresholds: [{ id: "lantern-k", value: 3, min: 1, max: 10 }] });
  assert.match(applyProposal(unchanged, authority()).reasons.join("; "), /no change/);
});

test("sensitivity-only proposal changes actual reference evaluation and rejects incompatible history windows", t => {
  const out = outputs(t), input = out("input"); cpSync(fixture, input, { recursive: true });
  const events = rows(input, "scenarios"); events[5]!.amount = 130;
  writeFileSync(join(input, "scenarios.jsonl"), events.map(row => JSON.stringify(row)).join("\n") + "\n");
  const before = out("before"), after = out("after");
  runCase(input, before);
  runCase(input, after, { proposal: proposal({ rule_id: "lantern-relative", thresholds: [{ id: "lantern-k", value: 2, min: 1, max: 10 }] }) });
  assert.deepEqual([before, after].map(dir => rows(dir, "verdicts").find(r => r.rule_id === "lantern-relative")!.verdict), ["did_not_fire", "alert"]);
  assert.ok(Math.abs(Number((rows(after, "feature-snapshots")[0]!.reference as Record<string, unknown>).value) - 129.6515937731653) < 1e-10);
  const invalid = applyProposal(proposal({ rule_id: "lantern-relative", thresholds: [{ id: "lantern-window", value: 3, min: 3, max: 60 }] }), authority());
  assert.equal(invalid.state, "rejected");
  assert.match(invalid.reasons.join("; "), /minimum history exceeds window/);
});
