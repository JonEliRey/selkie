import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runCase } from "../src/seams/run.ts";
import { readJsonl } from "../src/ledger.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "fwh-outcomes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  cpSync("fixtures/run/authored-outcomes", input, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(input, "manifest.json"), "utf8"));
  const original = readJsonl(join(input, "scenarios.jsonl")) as Record<string, any>[];
  // Independent fixture oracle: measured 160 exceeds relative ~145, not fixed 10000.
  const events: Record<string, any>[] = original.map(e => ({ ...e, label: "unknown", case_id: e.ts >= "2026-02-07" ? "jump" : null }));
  const save = () => {
    writeFileSync(join(input, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(input, "scenarios.jsonl"), events.map(e => JSON.stringify(e) + "\n").join(""));
  };
  save();
  const out = join(root, "out"); mkdirSync(out);
  return { root, input, out, manifest, events, save };
}

test("historical run reports independent case identities and differential admitted-rule detection", t => {
  const { input, out } = fixture(t);
  runCase(input, out);
  const metrics = readJsonl(join(out, "scenario-metrics.jsonl")) as Record<string, any>[];
  const suite = metrics.find(m => m.rule_id === null)!;
  assert.deepEqual(suite.detected_fraud_case_ids, ["jump"]);
  assert.deepEqual(suite.missed_fraud_case_ids, []);
  assert.equal(suite.fraud_case_denominator, 1);
  assert.deepEqual(metrics.find(m => m.rule_id === "lantern-daily")!.missed_fraud_case_ids, ["jump"]);
  assert.deepEqual(metrics.find(m => m.rule_id === "lantern-relative")!.detected_fraud_case_ids, ["jump"]);
  assert.equal(suite.headline_label, "scenario performance");
});

test("duplicate case hits and repeated legitimate alerts count identities, excluding immature and unknown outcomes", t => {
  const { input, out, manifest, events, save } = fixture(t);
  // Replicate the worked 160 history: two fraud cases and three other merchants.
  const base = structuredClone(events);
  for (const [merchant, caseId, outcome, available] of [
    ["m-growth", "growth", "legit", "2026-02-08T00:00:00.000Z"],
    ["m-unknown", "unknown-case", "unknown", "2026-02-08T00:00:00.000Z"],
    ["m-immature", "immature-case", "legit", "2026-03-01T00:00:00.000Z"],
  ] as const) {
    events.push(...base.map(e => ({ ...e, merchant_id: merchant, event_id: merchant + e.event_id,
      case_id: e.case_id === null ? null : caseId })));
    manifest.daily_totals.coverage.push({ ...manifest.daily_totals.coverage[0], merchant_id: merchant });
    manifest.authored_outcomes.merchants.push({ merchant_id: merchant, classification: outcome, available_at: available });
    manifest.authored_outcomes.cases.push({ ...manifest.authored_outcomes.cases[0], case_id: caseId, merchant_id: merchant,
      outcome, available_at: available, merchant_role: "unknown" });
  }
  manifest.workload = { max_events: 1000, max_rules: 2, max_results: 2000 };
  save(); runCase(input, out);
  const suite = (readJsonl(join(out, "scenario-metrics.jsonl")) as Record<string, any>[])[0]!;
  assert.deepEqual(suite.detected_fraud_case_ids, ["jump"]);
  assert.deepEqual(suite.incorrectly_flagged_legitimate_merchant_ids, ["m-growth"]);
  assert.equal(suite.legitimate_merchant_denominator, 1);
  assert.equal(suite.incorrectly_flagged_legitimate_merchants, 1);
  assert.deepEqual(suite.unknown_case_ids, ["unknown-case"]);
  assert.deepEqual(suite.immature_case_ids, ["immature-case"]);
  assert.equal(suite.assessment.status, "performed");
  assert.equal(suite.assessment.assessed_count, 2);
  assert.equal(suite.assessment.failure_count, 1);
});

test("incoherent authored outcome contracts reject by name before any ledger is written", t => {
  const f = fixture(t);
  const original = structuredClone(f.manifest.authored_outcomes);
  for (const [change, reason] of [
    [(c: any) => { c.cases.push(c.cases[0]); }, /duplicate case_id/],
    [(c: any) => { c.merchants[0].classification = "legit"; }, /legitimate merchant.*fraud/],
    [(c: any) => { c.observation_window.to = "2026-02-10"; }, /observation_window/],
    [(c: any) => { c.cases[0].merchant_role = "rule-derived"; }, /merchant_role/],
    [(c: any) => { c.cases[0].outcome = "fires"; }, /outcome/],
    [(c: any) => { c.cases[0].available_at = "tomorrow"; }, /available_at/],
    [(c: any) => { c.cases[0].taxonomy_version = null; }, /taxonomy/],
    [(c: any) => { c.cases[0].merchant_id = "missing"; }, /merchant/],
    [(c: any) => { c.cases[0].case_id = "unbound"; }, /case_id/],
    [(c: any) => { c.cases[0].to = c.cases[0].from; }, /case interval/],
    [(c: any) => { c.hidden = "payment-linkage"; }, /unknown.*hidden/],
  ] as const) {
    f.manifest.authored_outcomes = structuredClone(original);
    change(f.manifest.authored_outcomes); f.save();
    assert.throws(() => runCase(f.input, f.out), reason);
    assert.deepEqual(readdirSync(f.out), []);
  }
});

for (const [field, select, valid, reason] of [
  ["case outcome", (c: any) => c.cases[0], "fraud", /case outcome/],
  ["merchant classification", (c: any) => c.merchants[0], "legit", /merchant classification/],
  ["merchant_role", (c: any) => c.cases[0], "perpetrator", /merchant_role/],
  ["partition", (c: any) => c, "search", /partition/],
] as const) {
  test(`authored ${field} rejects non-string JSON before output`, t => {
    const f = fixture(t);
    const original = structuredClone(f.manifest.authored_outcomes);
    const key = field.split(" ").at(-1)!;
    for (const value of [[valid], [], {}, 1, true, ...(field === "merchant_role" ? [] : [null])]) {
      f.manifest.authored_outcomes = structuredClone(original);
      select(f.manifest.authored_outcomes)[key] = value; f.save();
      assert.throws(() => runCase(f.input, f.out), reason, JSON.stringify(value));
      assert.deepEqual(readdirSync(f.out), []);
    }
  });
}

test("authored string enums and intentionally absent merchant role retain their supplied meaning", t => {
  const f = fixture(t);
  for (const partition of ["search", "reserved-validation"]) {
    for (const outcome of ["fraud", "legit", "unknown"]) {
      for (const role of ["perpetrator", "complicit", "victim", "unknown", null]) {
        const c = f.manifest.authored_outcomes;
        c.partition = partition; c.cases[0].outcome = outcome;
        c.merchants[0].classification = outcome; c.cases[0].merchant_role = role;
        f.save(); runCase(f.input, f.out);
        const evidence = readJsonl(join(f.out, "authored-outcomes.jsonl")) as Record<string, any>[];
        assert.equal(evidence[0]!.supplied_outcome, outcome);
        assert.equal(evidence[0]!.effective_outcome, outcome);
        assert.equal(evidence[0]!.merchant_role, role);
        assert.equal(evidence[0]!.partition, partition);
        assert.equal(evidence[1]!.supplied_classification, outcome);
      }
    }
  }
});

test("empty or unresolved alert-policy assessments have null failures, not measured zero", t => {
  const { root, input, out, manifest, events, save } = fixture(t);
  manifest.authored_outcomes.cases = [];
  manifest.authored_outcomes.merchants[0].classification = "unknown";
  events.forEach(e => e.case_id = null); save(); runCase(input, out);
  const empty = (readJsonl(join(out, "scenario-metrics.jsonl")) as Record<string, any>[])[0]!;
  assert.deepEqual(empty.assessment, { status: "inapplicable", scope: "authored mature fraud cases and unique legitimate merchants in the pinned window", assessed_count: 0, failure_count: null });
  const tenantPath = join(input, "suite", "tenant.yaml");
  writeFileSync(tenantPath, readFileSync(tenantPath, "utf8").replace("fire_on: alert", "fire_on: suppress"));
  const suppressed = join(root, "suppressed"); mkdirSync(suppressed); runCase(input, suppressed);
  const m = (readJsonl(join(suppressed, "scenario-metrics.jsonl")) as Record<string, any>[])[0]!;
  assert.equal(m.assessment.status, "unperformed"); assert.equal(m.assessment.failure_count, null);
  assert.equal(m.detected_fraud_case_ids, null); assert.equal(m.incorrectly_flagged_legitimate_merchants, null);
});

test("taxonomy grants no new event semantics, and conflicting labels or orphan identities reject", t => {
  const f = fixture(t);
  const last = f.events.at(-1)!;
  last.kind = "refund"; f.save();
  assert.throws(() => runCase(f.input, f.out), /kind/);
  last.kind = "authorization"; last.label = "legit"; f.save();
  assert.throws(() => runCase(f.input, f.out), /label contradicts/);
  last.label = "unknown"; last.case_id = "orphan"; f.save();
  assert.throws(() => runCase(f.input, f.out), /unknown case_id/);
  assert.deepEqual(readdirSync(f.out), []);
});

test("historical stories-off removes effective event fraud labels while preserving supplied truth", t => {
  const f = fixture(t);
  f.events.at(-1)!.label = "fraud";
  f.manifest.authored_outcomes.stories_enabled = false;
  f.save(); runCase(f.input, f.out);
  assert.ok((readJsonl(join(f.out, "scenarios.jsonl")) as Record<string, any>[]).every(e => e.label !== "fraud"));
  const evidence = readJsonl(join(f.out, "authored-outcomes.jsonl")) as Record<string, any>[];
  assert.equal(evidence[0]!.supplied_outcome, "fraud");
  assert.equal(evidence[0]!.effective_outcome, "unknown");
});

test("every historical outcome and metric row traces original inputs across source, seed and truth changes", t => {
  const f = fixture(t);
  // Canonical input digest independently constructed; no runtime serialization or output oracle.
  const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object" ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  let priorRun: string | undefined;
  for (const change of [() => {},
    () => { f.manifest.history.source_id = "revised-source"; f.manifest.history.snapshot_version = "v2"; },
    () => { f.events[0]!.amount += 1; },
    () => { f.manifest.seed = 31; },
    () => { f.manifest.authored_outcomes.stories_enabled = false; },
  ]) {
    change(); f.save(); runCase(f.input, f.out);
    const expected = {
      history_source_id: f.manifest.history.source_id, history_schema_version: "lifecycle-history-v1",
      history_snapshot_version: f.manifest.history.snapshot_version,
      suite_id: "7a91e7ef83bc97e3", parameter_snapshot_id: "882c79228bc471f8", seed: f.manifest.seed,
      source_history_hash: hash(readFileSync(join(f.input, "scenarios.jsonl"), "utf8").replaceAll("\r\n", "\n")).slice(0, 16),
      authored_outcomes_hash: hash(canonical(f.manifest.authored_outcomes)),
    };
    const evidence = readJsonl(join(f.out, "authored-outcomes.jsonl")) as Record<string, any>[];
    const metrics = readJsonl(join(f.out, "scenario-metrics.jsonl")) as Record<string, any>[];
    assert.deepEqual(metrics.map(m => m.rule_id), [null, "lantern-daily", "lantern-relative"]);
    assert.deepEqual(evidence.map(m => m.grain), ["authored_case", "authored_merchant"]);
    for (const row of [...evidence, ...metrics]) {
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(row[key], value, key);
      assert.equal(row.run_id, evidence[0]!.run_id);
      assert.equal("generator_config" in row, false, "historical sources have no generated configuration");
    }
    assert.notEqual(evidence[0]!.run_id, priorRun); priorRun = evidence[0]!.run_id;
    assert.equal(evidence[0]!.supplied_outcome, "fraud");
    assert.equal(evidence[0]!.effective_outcome, f.manifest.authored_outcomes.stories_enabled ? "fraud" : "unknown");
  }
});

test("proposal replay preserves authored truth and original context while measuring changed case detection", t => {
  const f = fixture(t);
  const originals = new Map(readdirSync(f.input, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile()).map(e => { const path = join(e.parentPath, e.name); return [path, readFileSync(path)]; }));
  const incumbent = runCase(f.input, f.out);
  const proposal = { kind: "parameter_change", tenant: "t-alpha",
    change: { rule_id: "lantern-relative", thresholds: [{ id: "lantern-k", value: 10, min: 1, max: 10 }] },
    proving_scenario: { case_id: "jump" }, expected_effect: { claim: "may miss the authored jump" },
    gate_status: "ungated until replay" };
  const read = (dir: string, file: string) => readJsonl(join(dir, file)) as Record<string, any>[];
  const candidateDir = join(f.root, "candidate"); mkdirSync(candidateDir);
  const candidate = runCase(f.input, candidateDir, { proposal });
  // Prior 90,110,100,90,110: median100, MAD10. k3 threshold ~144.48,
  // k10 threshold ~248.26. The measured 160 jump alerts only at k3.
  assert.deepEqual(read(f.out, "scenario-metrics.jsonl")[0]!.detected_fraud_case_ids, ["jump"]);
  const candidateMetrics = read(candidateDir, "scenario-metrics.jsonl");
  for (const row of candidateMetrics) {
    assert.deepEqual(row.detected_fraud_case_ids, []);
    assert.deepEqual(row.missed_fraud_case_ids, ["jump"]);
    assert.equal(row.fraud_case_denominator, 1);
    assert.equal(row.suite_id, candidate.suite_id);
    assert.equal(row.parameter_snapshot_id, candidate.parameter_snapshot_id);
    assert.equal(row.run_id, candidate.run_id);
    assert.equal(row.source_history_hash, incumbent.scenario_set_hash);
  }
  assert.ok(read(candidateDir, "verdicts.jsonl").every(v => v.verdict === "did_not_fire"));
  assert.notEqual(candidate.run_id, incumbent.run_id);
  assert.notEqual(candidate.suite_id, incumbent.suite_id);
  assert.notEqual(candidate.parameter_snapshot_id, incumbent.parameter_snapshot_id);
  assert.deepEqual(read(candidateDir, "scenarios.jsonl"), read(f.out, "scenarios.jsonl"));
  const omitCandidate = (row: Record<string, any>) => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !["run_id", "suite_id", "parameter_snapshot_id"].includes(key)));
  assert.deepEqual(read(candidateDir, "authored-outcomes.jsonl").map(omitCandidate), read(f.out, "authored-outcomes.jsonl").map(omitCandidate));
  const attempt = read(candidateDir, "proposal-attempts.jsonl")[0]!;
  assert.equal(attempt.experimental_acceptance, "not_assessed");
  assert.equal(attempt.state, "admitted");
  assert.equal(attempt.incumbent_run_id, incumbent.run_id);
  assert.equal(attempt.candidate_run_id, candidate.run_id);
  assert.deepEqual(attempt.input_context.manifest, f.manifest);
  const digests = Object.fromEntries(["scenarios.jsonl", "suite/catalog.yaml", "suite/tenant.yaml",
    "suite/rules/lantern-daily.yaml", "suite/rules/relative.yaml"].map(path => [path,
    createHash("sha256").update(readFileSync(join(f.input, path), "utf8").replaceAll("\r\n", "\n")).digest("hex")]));
  assert.deepEqual(attempt.input_context.input_digests, digests);
  const repeat = join(f.root, "candidate-repeat"); mkdirSync(repeat); runCase(f.input, repeat, { proposal });
  for (const file of readdirSync(candidateDir)) assert.deepEqual(readFileSync(join(candidateDir, file)), readFileSync(join(repeat, file)), file);
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(path), bytes, path);
  const incumbentAgain = join(f.root, "incumbent-repeat"); mkdirSync(incumbentAgain); runCase(f.input, incumbentAgain);
  for (const file of readdirSync(f.out)) assert.deepEqual(readFileSync(join(f.out, file)), readFileSync(join(incumbentAgain, file)), file);
  const rejected = join(f.root, "rejected"); mkdirSync(rejected);
  assert.throws(() => runCase(f.input, rejected, { proposal: { ...proposal, labels: { change: "fraud" } } }), /labels/);
  assert.deepEqual(readdirSync(rejected), ["proposal-attempts.jsonl"]);
  const failure = read(rejected, "proposal-attempts.jsonl")[0]!;
  assert.deepEqual(failure.input_context, attempt.input_context);
  assert.equal(failure.candidate_run_id, null); assert.equal(failure.candidate_suite_id, null);
  assert.equal(failure.experimental_acceptance, "not_assessed");
});
