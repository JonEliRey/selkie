import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DAILY_LEDGER_TABLES } from "../src/ledger.ts";
import { INTERACTIVE_STEP_WORKLOAD, startHistoricalDayStepper } from "../src/historical-stepper.ts";
import { runCase } from "../src/seams/run.ts";
import { parseYaml } from "../src/yaml.ts";

function dailyFixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "fwh-day-stepper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  cpSync(join("fixtures", "run", "daily-totals"), input, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(input, "manifest.json"), "utf8"));
  manifest.daily_totals.coverage[0].to = "2026-02-06T00:00:00.000Z";
  manifest.comparability.observation_window.to = "2026-02-06";
  writeFileSync(join(input, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { root, input, batch: join(root, "batch"), stepped: join(root, "stepped") };
}

function readState(dir: string) {
  return JSON.parse(readFileSync(join(dir, "step-state.json"), "utf8"));
}

function rows(dir: string, table: string) {
  return readFileSync(join(dir, table), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function outputBytes(dir: string) {
  return Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), "utf8")]));
}

function outputRawBytes(dir: string) {
  return Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name))]));
}

function injectedFsError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

test("the public day-stepper exposes prefixes and completes byte-identically to the batch ledger", t => {
  const { input, batch, stepped } = dailyFixture(t);
  mkdirSync(batch);
  runCase(input, batch, { requireAdmittedSuite: true });

  const session = startHistoricalDayStepper(input, stepped);
  assert.deepEqual(readState(stepped), {
    format_version: "historical-day-stepper-v1",
    status: "in_progress",
    run_id: rows(batch, "manifest.jsonl")[0].run_id,
    observation_window: { from: "2026-02-02", to: "2026-02-06" },
    completed_through: null,
    next_day: "2026-02-02",
    completed_days: 0,
    total_days: 4,
    input_digests: readState(stepped).input_digests,
    output_digests: readState(stepped).output_digests,
  });

  session.advance("2026-02-02");
  assert.equal(readState(stepped).status, "in_progress");
  assert.equal(readState(stepped).next_day, "2026-02-03");
  assert.deepEqual(rows(stepped, "verdicts.jsonl").map(row => row.event_id), ["burst-a", "burst-b"]);
  assert.deepEqual(rows(stepped, "metrics.jsonl").map(row => [row.events, row.alerts]), [[2, 0]]);
  assert.deepEqual(rows(stepped, "feature-snapshots.jsonl").map(row => [row.as_of_day, row.value]), [["2026-02-02", 2000]]);
  assert.equal(rows(stepped, "scenarios.jsonl").length, 7, "the original full history stays visible and unchanged");

  for (const day of ["2026-02-03", "2026-02-04", "2026-02-05"]) session.advance(day);
  assert.equal(readState(stepped).status, "complete");
  assert.equal(readState(stepped).next_day, null);
  for (const table of DAILY_LEDGER_TABLES) {
    assert.equal(readFileSync(join(stepped, table), "utf8"), readFileSync(join(batch, table), "utf8"), table);
  }
});

test("invalid, duplicate, skipped and after-completion days reject atomically by name", t => {
  const { input, stepped } = dailyFixture(t);
  const session = startHistoricalDayStepper(input, stepped);
  const rejected = (day: string, reason: RegExp) => {
    const before = outputBytes(stepped);
    assert.throws(() => session.advance(day), (error: unknown) => error instanceof Error && reason.test(error.message), `${day} ${reason}`);
    assert.deepEqual(outputBytes(stepped), before, `${day} changed the accepted prefix`);
  };

  rejected("2026-02-30", /invalid_step_day/);
  rejected("2026-02-03", /out_of_order_step_day/);
  session.advance("2026-02-02");
  session.advance("2026-02-03");
  rejected("2026-02-02", /duplicate_step_day/);
  rejected("2026-02-05", /out_of_order_step_day/);
  session.advance("2026-02-04");
  const beforeSparseLast = rows(stepped, "verdicts.jsonl");
  session.advance("2026-02-05");
  assert.deepEqual(rows(stepped, "verdicts.jsonl"), beforeSparseLast, "the no-event last day advances without invented results");
  rejected("2026-02-06", /run_already_complete/);
});

test("a public session restores accepted bytes after transient rollback rename failures and can advance once", t => {
  const { input, batch, stepped } = dailyFixture(t);
  mkdirSync(batch);
  runCase(input, batch, { requireAdmittedSuite: true });
  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");
  const accepted = outputRawBytes(stepped);

  const originalRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = ((oldPath, newPath) => {
    renameCalls++;
    if (renameCalls === 2) throw injectedFsError("injected publication failure", "INJECTED");
    if (renameCalls === 3) throw injectedFsError("injected transient rollback EPERM", "EPERM");
    if (renameCalls === 4) throw injectedFsError("injected transient rollback EBUSY", "EBUSY");
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.advance("2026-02-03"), /injected publication failure/);
    assert.equal(renameCalls, 5, "rollback retries only the two injected transient failures");
    assert.deepEqual(outputRawBytes(stepped), accepted, "the accepted ledger and cursor return byte-identically at the canonical path");
    assert.equal(session.status().next_day, "2026-02-03");
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }

  session.advance("2026-02-03");
  const afterAdvance = outputRawBytes(stepped);
  assert.throws(() => session.advance("2026-02-03"), /duplicate_step_day/);
  assert.deepEqual(outputRawBytes(stepped), afterAdvance, "the recovered day is accepted exactly once");
  session.advance("2026-02-04");
  session.advance("2026-02-05");
  assert.equal(readState(stepped).status, "complete");
  for (const name of readdirSync(batch)) {
    assert.deepEqual(readFileSync(join(stepped, name)), readFileSync(join(batch, name)), name);
  }
});

test("rollback retry exhaustion keeps the accepted backup and the active session can restore it later", t => {
  const { root, input, stepped } = dailyFixture(t);
  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");
  const accepted = outputRawBytes(stepped);

  const originalRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = ((oldPath, newPath) => {
    renameCalls++;
    if (renameCalls === 2) throw injectedFsError("injected publication failure", "INJECTED");
    if (renameCalls >= 3) throw injectedFsError("injected persistent rollback denial", "EPERM");
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.advance("2026-02-03"), /historical_step_restore_pending/);
    assert.equal(renameCalls, 7, "rollback stops after five bounded attempts");
    assert.equal(existsSync(stepped), false, "the unavailable canonical path is not falsely reported as accepted");
    assert.equal(readdirSync(root).filter(name => name.startsWith(".stepped.previous-")).length, 1,
      "the only accepted backup remains available for recovery");
    const beforeStatus = renameCalls;
    assert.throws(() => session.status(), /historical_step_restore_pending/);
    assert.equal(renameCalls - beforeStatus, 5, "status makes one bounded in-process restoration attempt");
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }

  assert.equal(session.status().next_day, "2026-02-03");
  assert.deepEqual(outputRawBytes(stepped), accepted, "the later in-process restoration returns the accepted bytes and cursor");
});

test("transient publication renames are retried without reporting a false rejection", t => {
  const { input, stepped } = dailyFixture(t);
  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");

  const originalRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = ((oldPath, newPath) => {
    renameCalls++;
    if (renameCalls === 1) throw injectedFsError("injected move-aside EPERM", "EPERM");
    if (renameCalls === 2) throw injectedFsError("injected move-aside EBUSY", "EBUSY");
    if (renameCalls === 4) throw injectedFsError("injected publication EPERM", "EPERM");
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    const state = session.advance("2026-02-03");
    assert.equal(state.completed_through, "2026-02-03");
    assert.equal(state.next_day, "2026-02-04");
    assert.equal(renameCalls, 5, "both publication renames use bounded transient recovery");
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
});

test("accepted publications report obsolete-backup cleanup debt and clear it on a later bounded session retry", t => {
  const { root, input, batch, stepped } = dailyFixture(t);
  mkdirSync(batch);
  runCase(input, batch, { requireAdmittedSuite: true });
  mkdirSync(stepped);

  const originalRm = fs.rmSync;
  let cleanupDenied = true;
  let cleanupAttempts = 0;
  fs.rmSync = ((path, options) => {
    if (String(path).includes(".stepped.previous-")) {
      cleanupAttempts++;
      if (cleanupDenied) throw injectedFsError("injected obsolete-backup cleanup denial", "EACCES");
    }
    return originalRm(path, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  t.after(() => {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  });

  let session!: ReturnType<typeof startHistoricalDayStepper>;
  try {
    session = startHistoricalDayStepper(input, stepped);
    assert.deepEqual(session.cleanupDiagnostics().map(diagnostic => ({
      code: diagnostic.code,
      attempts: diagnostic.attempts,
      cause_code: diagnostic.cause instanceof Error ? (diagnostic.cause as NodeJS.ErrnoException).code : undefined,
      message: diagnostic.message,
    })), [{
      code: "historical_step_cleanup_pending",
      attempts: 1,
      cause_code: "EACCES",
      message: "historical_step_cleanup_pending: obsolete accepted backup removal failed (injected obsolete-backup cleanup denial); status() or advance() on this active session will retry",
    }], "initial publication surfaces its cleanup debt without changing cursor bytes");
    const initialCursor = readFileSync(join(stepped, "step-state.json"));

    const first = session.advance("2026-02-02");
    assert.equal(first.completed_through, "2026-02-02", "cleanup denial does not relabel an accepted advance as rejected");
    assert.equal(cleanupAttempts, 3, "advance makes one cleanup attempt per retained obsolete backup");
    assert.deepEqual(session.cleanupDiagnostics().map(diagnostic => diagnostic.attempts), [2, 1]);
    assert.notDeepEqual(readFileSync(join(stepped, "step-state.json")), initialCursor, "the accepted cursor advances once");

    const second = session.advance("2026-02-03");
    assert.equal(second.completed_through, "2026-02-03");
    assert.equal(cleanupAttempts, 6, "successive debt remains one bounded attempt per backup and publication");
    assert.deepEqual(session.cleanupDiagnostics().map(diagnostic => diagnostic.attempts), [3, 2, 1]);
    assert.equal(readdirSync(root).filter(name => name.startsWith(".stepped.previous-")).length, 3);
  } finally {
    cleanupDenied = false;
  }

  const attemptsBeforeRecovery = cleanupAttempts;
  assert.equal(session.status().next_day, "2026-02-04");
  assert.equal(cleanupAttempts - attemptsBeforeRecovery, 3, "one status call makes one bounded attempt per cleanup debt");
  assert.deepEqual(session.cleanupDiagnostics(), [], "successful retry clears the operational debt");
  assert.equal(readdirSync(root).filter(name => name.startsWith(".stepped.previous-")).length, 0);

  try {
    session.advance("2026-02-04");
    session.advance("2026-02-05");
  } finally {
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }
  assert.equal(session.status().status, "complete");
  for (const table of DAILY_LEDGER_TABLES) {
    assert.equal(readFileSync(join(stepped, table), "utf8"), readFileSync(join(batch, table), "utf8"), table);
  }
});

test("a non-transient rollback failure is named immediately and retains the accepted backup", t => {
  const { root, input, stepped } = dailyFixture(t);
  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");
  const accepted = outputRawBytes(stepped);

  const originalRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = ((oldPath, newPath) => {
    renameCalls++;
    if (renameCalls === 2) throw injectedFsError("injected publication failure", "INJECTED");
    if (renameCalls === 3) throw injectedFsError("injected non-transient rollback denial", "EACCES");
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.advance("2026-02-03"), /historical_step_restore_failed/);
    assert.equal(renameCalls, 3, "a non-transient error is not retried");
    assert.equal(existsSync(stepped), false);
    assert.equal(readdirSync(root).filter(name => name.startsWith(".stepped.previous-")).length, 1);
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }

  assert.equal(session.status().next_day, "2026-02-03");
  assert.deepEqual(outputRawBytes(stepped), accepted);
});

test("staging cleanup failure cannot mask pending restoration for the active public session", t => {
  const { input, stepped } = dailyFixture(t);
  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");
  const accepted = outputRawBytes(stepped);

  const originalRename = fs.renameSync;
  const originalRm = fs.rmSync;
  fs.renameSync = ((oldPath, newPath) => {
    if (String(oldPath).includes(".next-")) throw injectedFsError("injected publication denial", "EACCES");
    if (String(oldPath).includes(".previous-")) throw injectedFsError("injected rollback denial", "EPERM");
    return originalRename(oldPath, newPath);
  }) as typeof fs.renameSync;
  fs.rmSync = ((path, options) => {
    if (String(path).includes(".next-")) throw injectedFsError("injected staging cleanup denial", "EACCES");
    return originalRm(path, options);
  }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  try {
    let error: unknown;
    try {
      session.advance("2026-02-03");
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /historical_step_restore_pending/);
    assert.match(error.message, /staging cleanup also failed \(injected staging cleanup denial\)/);
    assert.ok(error.cause instanceof AggregateError, "publication, rollback, and cleanup failures remain inspectable causes");
    assert.equal(existsSync(stepped), false, "cleanup failure does not create a false canonical completion");
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
  }

  assert.equal(session.status().next_day, "2026-02-03", "the active session restores after filesystem access returns");
  assert.deepEqual(outputRawBytes(stepped), accepted);
  session.advance("2026-02-03");
  const advanced = outputRawBytes(stepped);
  assert.throws(() => session.advance("2026-02-03"), /duplicate_step_day/);
  assert.deepEqual(outputRawBytes(stepped), advanced, "the legitimate retry succeeds exactly once");
});

test("changed pinned files preserve the original prefix and require a separate candidate run", t => {
  const { root, input, stepped } = dailyFixture(t);
  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");
  const acceptedPrefix = outputBytes(stepped);
  const rule = join(input, "suite", "rules", "lantern-daily.yaml");
  writeFileSync(rule, readFileSync(rule, "utf8").replace("value: 10000", "value: 9000"));
  assert.throws(() => session.advance("2026-02-03"), /pinned_input_changed/);
  assert.deepEqual(outputBytes(stepped), acceptedPrefix);

  const candidate = join(root, "candidate");
  const candidateBatch = join(root, "candidate-batch");
  mkdirSync(candidateBatch);
  const batch = runCase(input, candidateBatch, { requireAdmittedSuite: true });
  const candidateSession = startHistoricalDayStepper(input, candidate);
  for (const day of ["2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"]) candidateSession.advance(day);
  assert.notEqual(readState(candidate).run_id, readState(stepped).run_id);
  assert.equal(readState(candidate).run_id, batch.run_id);
  for (const table of DAILY_LEDGER_TABLES) {
    assert.equal(readFileSync(join(candidate, table), "utf8"), readFileSync(join(candidateBatch, table), "utf8"), table);
  }
  assert.deepEqual(outputBytes(stepped), acceptedPrefix, "the rejected original remains byte-unchanged after the candidate completes");
});

test("manifest, history, catalog, tenant, translation and supplied proposal bytes are pinned", t => {
  const mutations: [string, (input: string) => void][] = [
    ["manifest", input => {
      const path = join(input, "manifest.json");
      const value = JSON.parse(readFileSync(path, "utf8"));
      value.goal = "changed invented goal";
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
    }],
    ["history", input => writeFileSync(join(input, "scenarios.jsonl"), readFileSync(join(input, "scenarios.jsonl"), "utf8").replace('"amount":7000', '"amount":7001'))],
    ["catalog", input => writeFileSync(join(input, "suite", "catalog.yaml"), readFileSync(join(input, "suite", "catalog.yaml"), "utf8") + "\n")],
    ["tenant", input => writeFileSync(join(input, "suite", "tenant.yaml"), readFileSync(join(input, "suite", "tenant.yaml"), "utf8") + "\n")],
  ];
  for (const [name, mutate] of mutations) {
    const { input, stepped } = dailyFixture(t);
    const session = startHistoricalDayStepper(input, stepped);
    const before = outputBytes(stepped);
    mutate(input);
    assert.throws(() => session.advance("2026-02-02"), /pinned_input_changed/, name);
    assert.deepEqual(outputBytes(stepped), before, name);
  }

  const root = mkdtempSync(join(tmpdir(), "fwh-proposal-stepper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  cpSync(join("fixtures", "proposal", "permitted-rule-changes"), input, { recursive: true });
  writeFileSync(join(input, "admission.json"), "{\"artifact\":\"invented-translation-v1\"}\n");
  const proposalText = readFileSync(join(input, "proposal.yaml"), "utf8");
  const proposal = parseYaml(proposalText);
  const proposalBytes = Buffer.from(proposalText);
  const translated = join(root, "translated");
  const translationSession = startHistoricalDayStepper(input, translated, { proposal, proposalBytes });
  const translatedBefore = outputBytes(translated);
  writeFileSync(join(input, "admission.json"), "{\"artifact\":\"invented-translation-v2\"}\n");
  assert.throws(() => translationSession.advance("2026-02-07"), /pinned_input_changed/);
  assert.deepEqual(outputBytes(translated), translatedBefore);

  writeFileSync(join(input, "admission.json"), "{\"artifact\":\"invented-translation-v1\"}\n");
  proposalBytes[0] = proposalBytes[0]! === 32 ? 33 : 32;
  assert.throws(() => translationSession.advance("2026-02-07"), /pinned_input_changed/);
  assert.deepEqual(outputBytes(translated), translatedBefore);
});

test("mutated cursor or ledger evidence cannot publish a skipped or wrong next prefix", t => {
  const { input, stepped } = dailyFixture(t);
  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");
  const acceptedVerdicts = readFileSync(join(stepped, "verdicts.jsonl"), "utf8");
  writeFileSync(join(stepped, "verdicts.jsonl"), acceptedVerdicts.replace("did_not_fire", "alert"));
  const wrongEvidence = outputBytes(stepped);
  assert.throws(() => session.advance("2026-02-03"), /step_output_changed/);
  assert.deepEqual(outputBytes(stepped), wrongEvidence, "a rejected evidence mutation is not partly overwritten");
  writeFileSync(join(stepped, "verdicts.jsonl"), acceptedVerdicts);

  const state = readState(stepped);
  state.next_day = "2026-02-04";
  writeFileSync(join(stepped, "step-state.json"), JSON.stringify(state) + "\n");
  const skippedCursor = outputBytes(stepped);
  assert.throws(() => session.advance("2026-02-04"), /step_state_changed/);
  assert.deepEqual(outputBytes(stepped), skippedCursor, "a forged skip cursor is not accepted or rewritten");
});

test("multi-event, multi-rule and multi-segment history keeps one cursor and one run header", t => {
  const { input, stepped } = dailyFixture(t);
  const manifestPath = join(input, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.admitted_rule_ids.push("opal-daily");
  manifest.daily_totals.coverage.push({
    merchant_id: "m-opal", segment: "growing", from: "2026-02-01T00:00:00.000Z", to: "2026-02-06T00:00:00.000Z",
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(input, "suite", "rules", "opal-daily.yaml"), readFileSync(join(input, "suite", "rules", "lantern-daily.yaml"), "utf8")
    .replace("id: lantern-daily", "id: opal-daily").replaceAll("lantern-floor", "opal-floor"));
  writeFileSync(join(input, "scenarios.jsonl"), readFileSync(join(input, "scenarios.jsonl"), "utf8") + [
    { event_id: "opal-a", transaction_id: "tx-opal-a", merchant_id: "m-opal", tenant: "t-alpha", risk_type: "synthetic-risk", kind: "settlement", ts: "2026-02-02T12:00:00.000Z", amount: 12000, currency: "USD", score: null, score_provenance: "absent", fields: {}, case_id: null, segment: "growing", label: "fraud" },
    { event_id: "opal-b", transaction_id: "tx-opal-b", merchant_id: "m-opal", tenant: "t-alpha", risk_type: "synthetic-risk", kind: "authorization", ts: "2026-02-04T12:00:00.000Z", amount: 100, currency: "USD", score: null, score_provenance: "absent", fields: {}, case_id: null, segment: "growing", label: "legit" },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");

  const session = startHistoricalDayStepper(input, stepped);
  session.advance("2026-02-02");
  assert.equal(rows(stepped, "manifest.jsonl").length, 1);
  assert.equal(rows(stepped, "rules-in-run.jsonl").length, 2);
  assert.deepEqual(new Set(rows(stepped, "feature-snapshots.jsonl").map(row => row.segment)), new Set(["small", "growing"]));
  assert.equal(rows(stepped, "verdicts.jsonl").length, 6, "three events are evaluated by both admitted rules");
  assert.equal(readState(stepped).completed_days, 1, "segments and rules do not duplicate the run cursor");
});

test("stepping exposes the strict prior-day median/MAD clock before the final day", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-reference-stepper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const stepped = join(root, "stepped");
  cpSync(join("fixtures", "run", "merchant-reference"), input, { recursive: true });
  const manifestPath = join(input, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.comparability.observation_window.from = "2026-02-04";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const session = startHistoricalDayStepper(input, stepped);
  for (const day of ["2026-02-04", "2026-02-05", "2026-02-06"]) session.advance(day);
  const sixth = rows(stepped, "feature-snapshots.jsonl").find(row => row.as_of_day === "2026-02-06");
  assert.equal(sixth.value, 120, "February 6 sees only February 5's completed total");
  assert.equal(sixth.reference.median, 95);
  assert.equal(sixth.reference.mad, 10);
  assert.ok(Math.abs(sixth.reference.value - 139.47739065974795) < 1e-12);
  assert.equal(rows(stepped, "verdicts.jsonl").find(row => row.event_id === "lantern-6" && row.rule_id === "lantern-relative").verdict, "did_not_fire");

  session.advance("2026-02-07");
  const seventh = rows(stepped, "feature-snapshots.jsonl").find(row => row.as_of_day === "2026-02-07");
  assert.equal(seventh.value, 160);
  assert.equal(seventh.reference.value, 144.47739065974795);
  assert.equal(rows(stepped, "verdicts.jsonl").find(row => row.event_id === "lantern-7" && row.rule_id === "lantern-relative").verdict, "alert");
});

test("admitted proposal and translation artifacts finish byte-identically to batch", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-proposal-parity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const batch = join(root, "batch");
  const stepped = join(root, "stepped");
  cpSync(join("fixtures", "proposal", "permitted-rule-changes"), input, { recursive: true });
  writeFileSync(join(input, "admission.json"), "{\"artifact\":\"invented-translation-v1\"}\n");
  const proposalText = readFileSync(join(input, "proposal.yaml"), "utf8");
  const proposal = parseYaml(proposalText);
  mkdirSync(batch);
  const proposalBytes = Buffer.from(proposalText);
  runCase(input, batch, { requireAdmittedSuite: true, proposal, proposalBytes });
  const session = startHistoricalDayStepper(input, stepped, { proposal, proposalBytes });
  session.advance("2026-02-07");
  assert.deepEqual(readdirSync(stepped).filter(name => name !== "step-state.json").sort(), readdirSync(batch).sort());
  for (const name of readdirSync(batch)) {
    assert.equal(readFileSync(join(stepped, name), "utf8"), readFileSync(join(batch, name), "utf8"), name);
  }
  assert.equal(rows(stepped, "proposal-attempts.jsonl")[0].state, "admitted");
  assert.equal(readFileSync(join(stepped, "source-translation.json"), "utf8"), "{\"artifact\":\"invented-translation-v1\"}\n");
});

test("authored-history proposal steps hide future outcomes and finish with independent result and provenance oracles", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-authored-proposal-stepper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const incumbent = join(root, "incumbent");
  const candidateBatch = join(root, "candidate-batch");
  const candidateStep = join(root, "candidate-step");
  cpSync(join("fixtures", "run", "authored-outcomes"), input, { recursive: true });
  const manifestPath = join(input, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.comparability.observation_window.from = "2026-02-06";
  manifest.authored_outcomes.observation_window.from = "2026-02-06";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const proposal = {
    kind: "parameter_change",
    tenant: "t-alpha",
    change: { rule_id: "lantern-relative", thresholds: [{ id: "lantern-k", value: 10, min: 1, max: 10 }] },
    proving_scenario: { case_id: "jump" },
    expected_effect: { claim: "may miss the authored jump" },
    gate_status: "ungated until replay",
  };

  mkdirSync(incumbent);
  const incumbentManifest = runCase(input, incumbent, { requireAdmittedSuite: true });
  const incumbentBefore = outputBytes(incumbent);
  mkdirSync(candidateBatch);
  const candidateManifest = runCase(input, candidateBatch, { requireAdmittedSuite: true, proposal });
  const session = startHistoricalDayStepper(input, candidateStep, { proposal });
  session.advance("2026-02-06");

  assert.equal(readState(candidateStep).status, "in_progress");
  assert.equal(readState(candidateStep).next_day, "2026-02-07");
  assert.deepEqual(rows(candidateStep, "merchant-days.jsonl").map(row => [row.day, row.total]), [
    ["2026-01-31", null],
    ["2026-02-01", 80], ["2026-02-02", 90], ["2026-02-03", 100],
    ["2026-02-04", 110], ["2026-02-05", 120], ["2026-02-06", 160],
  ]);
  assert.deepEqual(rows(candidateStep, "verdicts.jsonl").map(row => [row.event_id, row.rule_id, row.verdict]), [
    ["lantern-6", "lantern-daily", "did_not_fire"],
    ["lantern-6", "lantern-relative", "did_not_fire"],
  ]);
  assert.deepEqual(rows(candidateStep, "metrics.jsonl").map(row => [row.events, row.alerts]), [[1, 0]]);
  assert.deepEqual(rows(candidateStep, "authored-outcomes.jsonl"), [], "future authored truth is not published as an executed result");
  assert.deepEqual(rows(candidateStep, "scenario-metrics.jsonl"), [], "a prefix does not claim a full-window assessment");

  session.advance("2026-02-07");
  assert.equal(readState(candidateStep).status, "complete");
  assert.deepEqual(readdirSync(candidateStep).filter(name => name !== "step-state.json").sort(), readdirSync(candidateBatch).sort());
  for (const name of readdirSync(candidateBatch)) {
    assert.deepEqual(readFileSync(join(candidateStep, name)), readFileSync(join(candidateBatch, name)), name);
  }
  const outcomeRows = rows(candidateStep, "authored-outcomes.jsonl");
  assert.deepEqual(outcomeRows.filter(row => row.grain === "authored_case").map(row => row.case_id), ["jump"]);
  assert.deepEqual(outcomeRows.filter(row => row.grain === "authored_merchant").map(row => row.merchant_id), ["m-lantern"]);
  const metrics = rows(candidateStep, "scenario-metrics.jsonl");
  for (const row of metrics) {
    assert.deepEqual(row.detected_fraud_case_ids, []);
    assert.deepEqual(row.missed_fraud_case_ids, ["jump"]);
    assert.deepEqual(row.legitimate_merchant_ids, []);
    assert.equal(row.fraud_case_denominator, 1);
    assert.equal(row.history_source_id, "invented-lantern-history");
    assert.equal(row.history_schema_version, "lifecycle-history-v1");
    assert.equal(row.history_snapshot_version, "v1");
    assert.equal(row.run_id, candidateManifest.run_id);
    assert.equal(row.suite_id, candidateManifest.suite_id);
    assert.equal(row.parameter_snapshot_id, candidateManifest.parameter_snapshot_id);
  }
  const historyDigest = createHash("sha256").update(readFileSync(join(input, "scenarios.jsonl"), "utf8").replaceAll("\r\n", "\n")).digest("hex");
  assert.ok(metrics.every(row => row.source_history_hash === historyDigest.slice(0, 16)));
  const attempt = rows(candidateStep, "proposal-attempts.jsonl")[0];
  assert.equal(attempt.state, "admitted");
  assert.equal(attempt.experimental_acceptance, "not_assessed");
  assert.equal(attempt.incumbent_run_id, incumbentManifest.run_id);
  assert.equal(attempt.candidate_run_id, candidateManifest.run_id);
  assert.equal(attempt.input_context.input_digests["scenarios.jsonl"], historyDigest);
  assert.notEqual(candidateManifest.run_id, incumbentManifest.run_id);
  assert.notEqual(candidateManifest.suite_id, incumbentManifest.suite_id);
  assert.deepEqual(outputBytes(incumbent), incumbentBefore, "the separate incumbent ledger remains byte-unchanged");
});

test("step command advances the public run interface without a second evaluator", t => {
  const { input, stepped } = dailyFixture(t);
  const result = spawnSync(process.execPath, ["scripts/step.ts", input, stepped,
    "2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /2026-02-02.*in_progress/);
  assert.match(result.stdout, /2026-02-05.*complete/);
  assert.equal(readState(stepped).status, "complete");
});

test("step mode rejects an over-budget calendar before creating partial output", t => {
  const { input, stepped } = dailyFixture(t);
  const manifestPath = join(input, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.comparability.observation_window.to = "2026-03-10";
  manifest.daily_totals.coverage[0].to = "2026-03-10T00:00:00.000Z";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  assert.deepEqual(INTERACTIVE_STEP_WORKLOAD, {
    max_days: 31, max_events: 10000, max_rules: 16, max_results: 160000, max_canonical_bytes: 67108864,
  });
  assert.throws(() => startHistoricalDayStepper(input, stepped), /historical_step_workload_exceeded: day count 36 exceeds 31/);
  assert.equal(existsSync(stepped), false);
});

test("supplied proposal bytes must encode the proposal evaluated by the run", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-proposal-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const stepped = join(root, "stepped");
  cpSync(join("fixtures", "proposal", "permitted-rule-changes"), input, { recursive: true });
  const proposal = parseYaml(readFileSync(join(input, "proposal.yaml"), "utf8"));
  assert.throws(() => startHistoricalDayStepper(input, stepped, { proposal, proposalBytes: Buffer.from("kind: different\n") }), /proposal_bytes_mismatch/);
  assert.equal(existsSync(stepped), false);
});

test("different supplied bytes for the same parsed proposal identify separate candidate runs", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-proposal-byte-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  cpSync(join("fixtures", "proposal", "permitted-rule-changes"), input, { recursive: true });
  const proposalText = readFileSync(join(input, "proposal.yaml"), "utf8");
  const proposal = parseYaml(proposalText);
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  mkdirSync(firstDir);
  mkdirSync(secondDir);
  const first = runCase(input, firstDir, { requireAdmittedSuite: true, proposal, proposalBytes: Buffer.from(proposalText) });
  const second = runCase(input, secondDir, { requireAdmittedSuite: true, proposal, proposalBytes: Buffer.from(proposalText + "\n") });
  assert.notEqual(first.run_id, second.run_id);
  assert.notEqual(rows(firstDir, "proposal-attempts.jsonl")[0].input_context.id,
    rows(secondDir, "proposal-attempts.jsonl")[0].input_context.id);
});

test("opaque supplied artifacts retain raw bytes and recover after an isolated output mutation", t => {
  const root = mkdtempSync(join(tmpdir(), "fwh-opaque-stepper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, "input");
  const batch = join(root, "batch");
  const stepped = join(root, "stepped");
  cpSync(join("fixtures", "proposal", "permitted-rule-changes"), input, { recursive: true });
  const opaque = Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]);
  writeFileSync(join(input, "admission.json"), opaque);
  const proposal = parseYaml(readFileSync(join(input, "proposal.yaml"), "utf8"));
  mkdirSync(batch);
  runCase(input, batch, { requireAdmittedSuite: true, proposal });

  const session = startHistoricalDayStepper(input, stepped, { proposal });
  const artifact = join(stepped, "source-translation.json");
  assert.deepEqual(readFileSync(artifact), opaque, "the inspectable prefix preserves the supplied artifact");
  writeFileSync(artifact, Buffer.from([0xef, 0xbf, 0xbd, 0x7b, 0x00, 0x7d, 0x00]));
  assert.throws(() => session.advance("2026-02-07"), /step_output_changed/);
  writeFileSync(artifact, opaque);
  session.advance("2026-02-07");
  assert.deepEqual(readFileSync(artifact), opaque);
  assert.deepEqual(readFileSync(artifact), readFileSync(join(batch, "source-translation.json")));
});

test("extreme calendar range rejects under a constrained heap before materializing day strings", t => {
  const { input, stepped } = dailyFixture(t);
  const manifestPath = join(input, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.comparability.observation_window = { from: "0000-01-01", to: "9999-12-31" };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const source = `
    import assert from "node:assert/strict";
    import { startHistoricalDayStepper } from "./src/historical-stepper.ts";
    assert.throws(() => startHistoricalDayStepper(${JSON.stringify(input)}, ${JSON.stringify(stepped)}),
      /historical_step_workload_exceeded: day count 3652424 exceeds 31/);
    console.log("bounded-extreme-rejection");
  `;
  const result = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), "bounded-extreme-rejection");
  assert.equal(existsSync(stepped), false);
});
