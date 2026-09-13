// Trusted operator orchestration. The proposer receives JSON capabilities only.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { directoryBytes, preflightHistory, enforceResource, resourceLimits, resourceCheckpoint, withResources, WorkloadResourceError, type ResourceOptions } from "./workload-resources.ts";
import { tmpdir } from "node:os";
import { canonicalJson, readManifest, runCase } from "./seams/run.ts";
import { compareRuns, openValidation, advanceProtectedCorpusVersion, type ComparisonResult, type ComparisonTarget, type ValidationResult } from "./seams/comparison.ts";
import { listRunInputFiles, verifyProtectedCorpus } from "./seams/protected-corpus.ts";
import { applyProposal } from "./seams/proposal.ts";
import { readRule } from "./rules.ts";
import { isMapping, parseYaml, type YamlValue } from "./yaml.ts";
import type { Json } from "./ledger.ts";

export type ImprovementLimits = { target: ComparisonTarget; max_attempts: number; max_elapsed_ms: number; max_input_bytes: number };
export type ImprovementOptions = { search: string; reserved: string[]; corpus: string; validation_store: string;
  output: string; limits: ImprovementLimits; clock?: () => number; resources?: ResourceOptions };
type Incumbent = { suite_id: string; version: number; directory: string; corpus: string };
type State = { state: string; reason: string };
export type ImprovementAttempt = { attempt: number; proposal_id: string; proposal: YamlValue; incumbent: Incumbent;
  input_id: string; translation_sha256: string | null; states: State[]; search: ComparisonResult | null;
  frozen_id: string | null; reserved_version: string | null; reserved: ValidationResult | null; protected: ComparisonResult | null };
export type ImprovementResult = { experiment_id: string; target: ComparisonTarget; reason: string;
  accepted_count: number; initial_incumbent: Incumbent; incumbent: Incumbent; attempts: ImprovementAttempt[];
  production_promotion: "not_performed" };
const json = (value: unknown) => canonicalJson(value as Json);
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const save = (path: string, value: unknown) => writeFileSync(path, json(value) + "\n", { flush: true });

function capture(dir: string, limit: number): Record<string, string> {
  let size = 0;
  return Object.fromEntries(listRunInputFiles(dir).map(name => {
    for (let i = 0; i <= name.split("/").length; i++) {
      if (lstatSync(join(dir, ...name.split("/").slice(0, i))).isSymbolicLink()) throw new Error("improvement_input_path_denied");
    }
    const file = join(dir, name);
    size += lstatSync(file).size;
    if (size > limit) throw new Error("improvement_input_budget_exceeded");
    return [name, readFileSync(file).toString("base64")];
  }));
}
function materialize(dir: string, inputs: Record<string, string>) {
  for (const [name, bytes] of Object.entries(inputs)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), Buffer.from(bytes, "base64"));
  }
}
function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir).sort().flatMap(name => {
    const stat = lstatSync(join(dir, name));
    if (stat.isSymbolicLink()) throw new Error("improvement_input_path_denied");
    return stat.isDirectory() ? tree(join(dir, name), prefix + name + "/") : [prefix + name];
  });
}
function captureTree(dir: string, limit: number): Record<string, string> {
  let size = 0;
  return Object.fromEntries(tree(dir).map(name => {
    size += lstatSync(join(dir, name)).size;
    if (size > limit) throw new Error("improvement_input_budget_exceeded");
    return [name, readFileSync(join(dir, name)).toString("base64")];
  }));
}
// Same closed YAML subset as saved translation; serialization cannot execute data.
function yaml(value: unknown, indent = 0): string {
  return (Array.isArray(value) ? value.map(item => ["-", item]) : Object.entries(value as object).map(([key, item]) => [key + ":", item]))
    .map(([key, item]) => " ".repeat(indent) + key + (item !== null && typeof item === "object" && Object.keys(item).length
      ? "\n" + yaml(item, indent + 2) : " " + JSON.stringify(item) + "\n")).join("");
}
function authority(dir: string) {
  const manifest = readManifest(read(join(dir, "manifest.json")));
  const names = readdirSync(join(dir, "suite/rules")).filter(name => name.endsWith(".yaml")).sort();
  const rules = names.map(name => readRule(parseYaml(readFileSync(join(dir, "suite/rules", name), "utf8")), name));
  return { manifest, names, rules, catalog: parseYaml(readFileSync(join(dir, "suite/catalog.yaml"), "utf8")) };
}

export function startImprovement(options: ImprovementOptions) {
  const resources = resourceLimits(options.resources);
  const existed = existsSync(options.output);
  try {
    const session = withResources(resources, () => startImprovementInner(options));
    return Object.freeze({ ...session,
      proposer: Object.freeze({ context: session.proposer.context,
        request: (serialized: string) => withResources(resources, () => session.proposer.request(serialized)) }),
      finish: () => withResources(resources, () => session.finish()),
      releaseFeedback: () => withResources(resources, () => session.releaseFeedback()),
    });
  } catch (error) {
    if (!existed && error instanceof WorkloadResourceError) rmSync(options.output, { recursive: true, force: true });
    throw error;
  }
}

function startImprovementInner(options: ImprovementOptions) {
  const limits = structuredClone(options.limits);
  const resources = resourceLimits(options.resources), resourceStart = performance.now();
  enforceResource("candidates", limits.max_attempts, resources.max_candidates);
  resourceCheckpoint(resources, resourceStart);
  if (!["fraud_cases", "legitimate_merchants"].includes(limits.target)
    || !Number.isSafeInteger(limits.max_attempts) || limits.max_attempts < 1 || limits.max_attempts > 100
    || !Number.isSafeInteger(limits.max_elapsed_ms) || limits.max_elapsed_ms < 1 || limits.max_elapsed_ms > 60_000
    || !Number.isSafeInteger(limits.max_input_bytes) || limits.max_input_bytes < 1 || limits.max_input_bytes > 64_000_000
    || options.reserved.length > limits.max_attempts) throw new Error("invalid_improvement_budget");
  const clock = options.clock ?? (() => performance.now()), start = clock();
  let previousTime = start;
  for (const dir of [options.search, ...options.reserved]) preflightHistory(dir, resources);
  const search = capture(options.search, limits.max_input_bytes);
  if (readManifest(JSON.parse(Buffer.from(search["manifest.json"]!, "base64").toString())).authored_outcomes?.partition !== "search") throw new Error("improvement_requires_search");
  const reserved = options.reserved.map(dir => capture(dir, limits.max_input_bytes));
  enforceResource("input_bytes", directoryBytes(options.corpus), resources.max_input_bytes);
  const corpusPath = resolve(dirname(options.corpus), read(options.corpus).source.directory);
  const inputDirs = [options.search, ...options.reserved, corpusPath];
  preflightHistory(corpusPath, resources);
  enforceResource("seeds", new Set(inputDirs.map(dir => read(join(dir, "manifest.json")).seed)).size, resources.max_seeds);
  enforceResource("input_bytes", inputDirs.reduce((sum, dir) => sum + directoryBytes(dir), directoryBytes(options.validation_store)), resources.max_input_bytes);
  const corpus = verifyProtectedCorpus(options.corpus);
  const corpusSource = capture(corpus.source_directory, limits.max_input_bytes);
  // Relocation changes only the corpus source locator; the exact staged bytes
  // become the comparison authority and keep all source digest evidence.
  const corpusRecord = { ...corpus.record, source: { ...corpus.record.source, directory: "source" } };
  const validationBefore = captureTree(options.validation_store, limits.max_input_bytes);
  const plan = { schema: "bounded-improvement-v1", limits, ...(options.resources === undefined ? {} : { resources }), search, reserved, corpus: corpusRecord, corpus_sha256: hash(json(corpusRecord) + "\n"),
    corpus_source: corpusSource, validation_before: validationBefore, input_encoding: "base64" };
  const experimentId = hash(json(plan)), out = options.output;
  enforceResource("output_bytes", Buffer.byteLength(json(plan) + "\n"), resources.max_output_bytes);
  mkdirSync(out); mkdirSync(join(out, "attempts"));
  save(join(out, "plan.json"), plan);
  materialize(join(out, "initial"), search);
  materialize(join(out, "corpus-initial/source"), corpusSource);
  save(join(out, "corpus-initial/corpus.json"), corpusRecord);
  const validation = openValidation(options.validation_store);
  const initialRun = join(out, "initial-run"); mkdirSync(initialRun);
  const baseline = runCase(join(out, "initial"), initialRun, { requireAdmittedSuite: true });
  const initial: Incumbent = { suite_id: baseline.suite_id!, version: 0, directory: "initial", corpus: "corpus-initial/corpus.json" };
  let incumbent = initial;
  const attempts: ImprovementAttempt[] = [];
  let stopped: string | null = null;
  function timed(): boolean {
    const now = clock(), elapsed = now - start;
    const timing = JSON.stringify({ elapsed_ms: elapsed, monotonic: now >= previousTime }) + "\n";
    try { guardTerminalWrite(Buffer.byteLength(timing)); }
    catch (error) { if (!(error instanceof WorkloadResourceError)) throw error; return true; }
    appendFileSync(join(out, "timing.jsonl"), timing);
    const exhausted = !Number.isFinite(elapsed) || now < previousTime || elapsed < 0 || elapsed >= limits.max_elapsed_ms;
    previousTime = now;
    if (exhausted) stopped = "time_budget_exhausted";
    try {
      resourceCheckpoint(resources, resourceStart);
      enforceResource("output_bytes", directoryBytes(out) + directoryBytes(options.validation_store), resources.max_output_bytes);
    } catch (error) {
      if (!(error instanceof WorkloadResourceError)) throw error;
      stopped = error.message;
      return true;
    }
    return exhausted;
  }
  function status(): ImprovementResult {
    return structuredClone({ experiment_id: experimentId, target: limits.target, reason: stopped ?? "in_progress",
      accepted_count: incumbent.version, initial_incumbent: initial, incumbent, attempts, production_promotion: "not_performed" });
  }
  function persist() {
    const path = join(out, "result.json"), bytes = json(status()) + "\n";
    if (!existsSync(path) || readFileSync(path, "utf8") !== bytes) writeFileSync(path, bytes, { flush: true });
  }
  let terminalResourceFailure: WorkloadResourceError | null = null;
  function guardTerminalWrite(additionalBytes = 0): void {
    if (terminalResourceFailure !== null) throw terminalResourceFailure;
    try {
      resourceCheckpoint(resources, resourceStart);
      // Keep room to replace the result with a named refusal, so exhausting
      // feedback cannot leave a successful persisted status behind.
      const currentResultBytes = existsSync(join(out, "result.json")) ? directoryBytes(join(out, "result.json")) : 0;
      const refusal = { ...status(), reason: "workload_peak_rss_bytes_exceeded" };
      const resultBytes = Math.max(Buffer.byteLength(json(status()) + "\n"), Buffer.byteLength(json(refusal) + "\n"));
      enforceResource("output_bytes", directoryBytes(out) + directoryBytes(options.validation_store)
        + additionalBytes + Math.max(0, resultBytes - currentResultBytes), resources.max_output_bytes);
    } catch (error) {
      if (!(error instanceof WorkloadResourceError)) throw error;
      terminalResourceFailure = error;
      stopped = error.message;
      // At most one bounded failure receipt, including if a prior phase or
      // external writer already exhausted storage. Repeated calls write nothing.
      persist();
      throw error;
    }
  }
  function request(serialized: string): string {
    let command: YamlValue;
    try { command = JSON.parse(serialized); } catch { throw new Error("proposer_access_denied"); }
    if (Buffer.byteLength(serialized) > limits.max_input_bytes || !isMapping(command)) throw new Error("proposer_access_denied");
    if (command.tool === "read_search" && Object.keys(command).sort().join(",") === "name,tool"
      && typeof command.name === "string" && Object.hasOwn(search, command.name)) {
      return json({ encoding: "base64", data: search[command.name] });
    }
    if (command.tool !== "evaluate_search" || Object.keys(command).sort().join(",") !== "proposal,tool") throw new Error("proposer_access_denied");
    // Later search can infer a prior acceptance from the advanced incumbent,
    // and a terminal refusal can reveal a preceding reserved failure. Treat
    // either as feedback, even without an explicit operator release.
    for (const prior of attempts) if (prior.reserved !== null) validation.expose(prior.frozen_id!, prior.reserved_version!);
    if (stopped !== null) throw new Error("improvement_stopped:" + stopped);
    if (timed()) { persist(); throw new Error(stopped!); }
    if (attempts.length >= limits.max_attempts) { stopped = "attempt_budget_exhausted"; persist(); throw new Error(stopped); }
    const proposal = structuredClone(command.proposal!);
    const index = attempts.length, dir = join(out, "attempts", String(index)); mkdirSync(dir);
    const current = join(out, incumbent.directory), inputs = capture(current, limits.max_input_bytes);
    const attempt: ImprovementAttempt = { attempt: index, proposal_id: hash(json(proposal)), proposal, incumbent: { ...incumbent },
      input_id: hash(json(inputs)), translation_sha256: inputs["admission.json"] === undefined ? null : hash(Buffer.from(inputs["admission.json"], "base64")),
      states: [], search: null, frozen_id: null, reserved_version: null, reserved: null, protected: null };
    attempts.push(attempt);
    const state = (state: string, reason: string) => { attempt.states.push({ state, reason }); save(join(dir, "attempt.json"), attempt); persist(); };
    state("attempted", "proposal_received");
    try {
      const auth = authority(current), admitted = applyProposal(proposal, auth);
      state(admitted.state, admitted.reasons.join("; ") || "proposal_admitted");
      if (admitted.rules === null) {
        stopped = "invalid_candidate"; state("discarded", stopped); return json({ reason: stopped, detail: admitted.reasons });
      }
      const comparisonDir = join(dir, "search"); mkdirSync(comparisonDir);
      attempt.search = compareRuns(current, comparisonDir, { target: limits.target, proposal });
      state("evaluated", attempt.search.reason);
      if (timed()) { state("discarded", stopped!); return json(attempt.search); }
      if (attempt.search.eligibility !== "eligible") {
        stopped = /evaluation|assessment/.test(attempt.search.reason) ? "evaluation_error" : "no_valid_improvement";
        state("discarded", attempt.search.reason); return json(attempt.search);
      }
      attempt.frozen_id = validation.freeze(comparisonDir); state("frozen", "search_winner_frozen");
      if (timed()) { state("discarded", stopped!); return json(attempt.search); }
      const reservedInputs = reserved[index];
      if (reservedInputs === undefined) { stopped = "fresh_reserved_required"; state("discarded", stopped); return json(attempt.search); }
      const assessmentInput = join(dir, "reserved-input");
      materialize(assessmentInput, { ...reservedInputs, ...Object.fromEntries(Object.entries(inputs).filter(([name]) => name.startsWith("suite/") || name === "admission.json")) });
      attempt.reserved_version = validation.reserve(assessmentInput);
      attempt.reserved = validation.evaluate(attempt.frozen_id, attempt.reserved_version);
      state("validated", attempt.reserved.reason);
      if (timed()) { state("discarded", stopped!); return json(attempt.search); }
      if (attempt.reserved.status !== "passed") { stopped = "no_valid_improvement"; state("discarded", attempt.reserved.reason); return json(attempt.search); }
      const protectedDir = join(dir, "protected"); mkdirSync(protectedDir);
      attempt.protected = compareRuns(assessmentInput, protectedDir, { target: limits.target, proposal, protected_corpus_file: join(out, incumbent.corpus) });
      state("protected", attempt.protected.reason);
      if (attempt.protected.eligibility !== "eligible" || attempt.protected.protected_cases?.expected_count !== attempt.protected.protected_cases?.retained_count) {
        stopped = "no_valid_improvement"; state("discarded", attempt.protected.reason); return json(attempt.search);
      }
      validation.finalEvidence(attempt.frozen_id, attempt.reserved_version);
      if (timed()) { state("discarded", stopped!); return json(attempt.search); }
      const version = incumbent.version + 1, nextCorpus = `corpus-${version}`, next = `incumbent-${version}`;
      advanceProtectedCorpusVersion(join(out, incumbent.corpus), protectedDir, join(out, nextCorpus));
      materialize(join(out, next), inputs);
      admitted.rules.forEach((rule, i) => writeFileSync(join(out, next, "suite/rules", auth.names[i]!), yaml(rule)));
      if (timed()) {
        rmSync(join(out, nextCorpus), { recursive: true }); rmSync(join(out, next), { recursive: true });
        state("discarded", stopped!); return json(attempt.search);
      }
      // Reserve the pending attempt/result/transcript and final status before
      // changing the incumbent. A resource refusal cannot become acceptance.
      const completionBytes = 2 * (Buffer.byteLength(json(attempt)) + Buffer.byteLength(json(status())))
        + Buffer.byteLength(serialized) + Buffer.byteLength(json(attempt.search)) + 4096;
      enforceResource("output_bytes", directoryBytes(out) + directoryBytes(options.validation_store) + completionBytes, resources.max_output_bytes);
      incumbent = { suite_id: attempt.protected.candidate_suite_id!, version, directory: next, corpus: nextCorpus + "/corpus.json" };
      state("accepted", "experimental_incumbent_advanced");
      return json(attempt.search); // No reserved feedback is supplied to the proposer.
    } catch (error) {
      stopped = error instanceof WorkloadResourceError ? error.message : "evaluation_error";
      state("discarded", error instanceof Error ? error.message : String(error));
      return json(attempt.search ?? { reason: stopped });
    }
  }
  const loggedRequest = (serialized: string) => {
    if (terminalResourceFailure !== null) throw terminalResourceFailure;
    // A durable transcript includes denials and budget refusals, not just wins.
    // Stop before another request can grow an already exhausted transcript.
    try {
      resourceCheckpoint(resources, resourceStart);
      enforceResource("output_bytes", directoryBytes(out) + directoryBytes(options.validation_store), resources.max_output_bytes);
    } catch (error) {
      if (!(error instanceof WorkloadResourceError)) throw error;
      stopped = error.message; persist(); throw error;
    }
    try {
      const response = request(serialized);
      appendFileSync(join(out, "requests.jsonl"), json({ request: serialized, response, error: null }) + "\n", { flush: true });
      return response;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendFileSync(join(out, "requests.jsonl"), json({ request: serialized, response: null, error: reason }) + "\n", { flush: true });
      throw error;
    }
  };
  persist();
  return Object.freeze({
    proposer: Object.freeze({ context: json({ target: limits.target, max_attempts: limits.max_attempts, tools: ["read_search", "evaluate_search"],
      summary: readFileSync(join(initialRun, "scenario-metrics.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))[0],
      input_names: Object.keys(search), input_encoding: "base64", boundary: "JSON tools only; no host filesystem, shell, network or reserved capabilities supplied" }), request: loggedRequest }),
    status,
    releaseFeedback() {
      const record = json({ control: "release_feedback" }) + "\n";
      const exposureBytes = attempts.reduce((sum, attempt) => sum + (attempt.reserved === null ? 0
        : Buffer.byteLength(json({ transition: "exposed", reason: "feedback_released_for_search", provenance: attempt.reserved.provenance }) + "\n")), 0);
      guardTerminalWrite(Buffer.byteLength(record) + exposureBytes);
      for (const attempt of attempts) if (attempt.reserved !== null) validation.expose(attempt.frozen_id!, attempt.reserved_version!);
      appendFileSync(join(out, "requests.jsonl"), record, { flush: true });
      return status();
    },
    finish() {
      try { guardTerminalWrite(); } catch (error) { if (!(error instanceof WorkloadResourceError)) throw error; return status(); }
      if (stopped === null && !timed()) stopped = incumbent.version ? "completed_with_improvement" : "no_permitted_move";
      try { guardTerminalWrite(); } catch (error) { if (!(error instanceof WorkloadResourceError)) throw error; return status(); }
      persist(); return status();
    },
  });
}

/** Audit replay copies the original usage frontier; it never resets the live validation store. */
export function replayImprovement(saved: string, output: string): ImprovementResult {
  const plan = read(join(saved, "plan.json"));
  const temp = mkdtempSync(join(tmpdir(), "fwh-improvement-replay-"));
  try {
    materialize(join(temp, "search"), plan.search);
    materialize(join(temp, "corpus/source"), plan.corpus_source); save(join(temp, "corpus/corpus.json"), plan.corpus);
    const validation = join(temp, "validation");
    mkdirSync(validation);
    for (const dir of ["frozen", "reserved", "uses", "assessments", "work"]) mkdirSync(join(validation, dir));
    materialize(validation, plan.validation_before);
    const reserved = plan.reserved.map((inputs: Record<string, string>, i: number) => {
      const dir = join(temp, `reserved-${i}`); materialize(dir, inputs); return dir;
    });
    const times = existsSync(join(saved, "timing.jsonl")) ? readFileSync(join(saved, "timing.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).elapsed_ms) : [];
    let tick = -1;
    const experiment = startImprovement({ search: join(temp, "search"), corpus: join(temp, "corpus/corpus.json"),
      reserved, validation_store: validation, output, limits: plan.limits,
      ...(plan.resources === undefined ? {} : { resources: plan.resources }), clock: () => tick++ < 0 ? 0 : times[tick - 1] });
    const requests = existsSync(join(saved, "requests.jsonl")) ? readFileSync(join(saved, "requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    for (const row of requests) {
      if (row.control === "release_feedback") { experiment.releaseFeedback(); continue; }
      let response: string | null = null, error: string | null = null;
      try { response = experiment.proposer.request(row.request); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      if (response !== row.response || error !== row.error) throw new Error("improvement_replay_mismatch:request");
    }
    const result = experiment.finish();
    const canonical = (dir: string) => tree(dir).filter(name => name !== "timing.jsonl");
    if (json(canonical(saved)) !== json(canonical(output))) throw new Error("improvement_replay_mismatch:file_set");
    for (const name of canonical(saved)) if (!readFileSync(join(saved, name)).equals(readFileSync(join(output, name)))) throw new Error("improvement_replay_mismatch:" + name);
    return result;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Deterministic client of exactly the same JSON capability supplied to an assisted proposer. */
export function runImprovement(options: ImprovementOptions): ImprovementResult {
  const experiment = startImprovement(options), capability = experiment.proposer;
  const context = JSON.parse(capability.context);
  const readSearch = (name: string) => Buffer.from(JSON.parse(capability.request(json({ tool: "read_search", name }))).data, "base64").toString();
  const manifest = readManifest(JSON.parse(readSearch("manifest.json"))), config = manifest.daily_totals?.reference;
  const catalog = parseYaml(readSearch("suite/catalog.yaml"));
  const metrics = context.summary;
  if (config === undefined || !isMapping(catalog)
    || (context.target === "fraud_cases" ? metrics.detected_fraud_case_ids.length >= metrics.fraud_case_denominator
      : metrics.incorrectly_flagged_legitimate_merchant_ids.length === 0)) return experiment.finish();
  for (const name of (context.input_names as string[]).filter(name => name.startsWith("suite/rules/"))) {
    const rule = readRule(parseYaml(readSearch(name)), name);
    if (!manifest.admitted_rule_ids?.includes(rule.id)) continue;
    const permission = Array.isArray(catalog.permitted_conversions) ? catalog.permitted_conversions.find(p => isMapping(p) && p.rule_id === rule.id) : undefined;
    const window = rule.thresholds.find(t => t.id === config.window_parameter);
    const sensitivity = rule.thresholds.find(t => t.id === config.sensitivity_parameter);
    const minimum = rule.thresholds.find(t => t.id === config.minimum_history_parameter);
    if (!window || !sensitivity || !minimum) continue;
    let change: YamlValue;
    let kind: string;
    if (isMapping(permission) && rule.conditions.some(c => c.kind === "field_constant" && c.threshold === permission.threshold_id)) {
      kind = "statistical_conversion";
      const value = window.min + Math.ceil((Math.max(window.min, minimum.value) - window.min) / window.step) * window.step;
      if (value > window.max) continue;
      change = { rule_id: rule.id, threshold_id: permission.threshold_id!, thresholds: [{ id: window.id, value, min: window.min, max: window.max }] };
    } else {
      kind = "parameter_change";
      const value = sensitivity.value + (context.target === "fraud_cases" ? -sensitivity.step : sensitivity.step);
      if (value < sensitivity.min || value > sensitivity.max) continue;
      change = { rule_id: rule.id, thresholds: [{ id: sensitivity.id, value, min: sensitivity.min, max: sensitivity.max }] };
    }
    capability.request(json({ tool: "evaluate_search", proposal: { kind, tenant: manifest.tenant, change,
      proving_scenario: { dataset_id: metrics.dataset_id }, expected_effect: { target: context.target, hypothesis: "bounded merchant-relative change from search count evidence" },
      gate_status: "ungated until replay" } }));
    // Select one search winner per automatic invocation. Further requests are
    // possible through the same bounded capability, with fresh reserved inputs.
    break;
  }
  return experiment.finish();
}
