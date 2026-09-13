// Trusted operator side of the comparison seam. No proposer or model executes here.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, readManifest, type Manifest } from "./seams/run.ts";
import { compareRuns, type ComparisonRequest, type ComparisonResult } from "./seams/comparison.ts";
import { DAILY_EVENT_SCENARIO_COLUMNS, type Json } from "./ledger.ts";

type Budget = { max_input_bytes: number };
type Snapshot = { kind: "frozen" | "reserved"; files: Record<string, string> };
type Provenance = { frozen_id: string; reserved_version: string; validation_identity: string;
  observation_identities: string[];
  frozen_inputs: Record<string, string>; reserved_inputs: Record<string, string>;
  search_manifest: Manifest; reserved_manifest: Manifest; target: ComparisonRequest["target"];
  proposal: ComparisonRequest["proposal"]; generator: "materialized_history_no_generator" };
export type ValidationResult = { assessment_id: string; status: "passed" | "failed"; reason: string;
  comparison: ComparisonResult; provenance: Provenance;
  protected_corpus: { identity: null; status: "not_assessed" }; experimental_acceptance: "not_assessed" };
type Use = { transition: "claimed" | "completed" | "exposed" | "rejected"; reason: string; provenance: Provenance };

const json = (value: unknown) => canonicalJson(value as Json);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function id(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_artifact_identity");
  return value;
}
function files(dir: string, prefix = ""): string[] {
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("artifact_path_denied");
  return readdirSync(dir).sort().flatMap(name => {
    if (/[\\:\x00-\x1f]/.test(name)) throw new Error("artifact_path_denied");
    const path = join(dir, name), stat = lstatSync(path), relative = prefix + name;
    if (stat.isSymbolicLink()) throw new Error("artifact_path_denied");
    if (stat.isDirectory()) return files(path, relative + "/");
    if (!stat.isFile()) throw new Error("artifact_path_denied");
    return [relative];
  });
}
function capture(dir: string, names: string[], budget: Budget): Record<string, Buffer> {
  let size = 0;
  const result: Record<string, Buffer> = {};
  for (const name of names) {
    if (!name.split("/").every(part => part && part !== "." && part !== ".." && !/[\\:\x00-\x1f]/.test(part))) throw new Error("artifact_path_denied");
    for (const [i] of name.split("/").entries()) if (lstatSync(join(dir, ...name.split("/").slice(0, i + 1))).isSymbolicLink()) throw new Error("artifact_path_denied");
    const path = join(dir, name), stat = lstatSync(path);
    if (!stat.isFile()) throw new Error("artifact_path_denied");
    size += stat.size;
    if (size > budget.max_input_bytes) throw new Error("validation_input_budget_exceeded");
    result[name] = readFileSync(path);
  }
  return result;
}
function materialize(dir: string, contents: Record<string, Buffer>): void {
  for (const [name, bytes] of Object.entries(contents)) {
    mkdirSync(join(dir, name, ".."), { recursive: true }); writeFileSync(join(dir, name), bytes);
  }
}
function inputNames(dir: string): string[] {
  return ["manifest.json", "scenarios.jsonl", "suite/catalog.yaml", "suite/tenant.yaml",
    ...files(join(dir, "suite/rules")).filter(name => name.endsWith(".yaml")).map(name => `suite/rules/${name}`),
    ...(existsSync(join(dir, "admission.json")) ? ["admission.json"] : [])].sort();
}
// Use the run's event schema, excluding event aliases, authored case bindings
// and reporting partitions. Optional labels are not observation columns.
// Full original bytes (including annotations) remain bound by the snapshots.
const observationColumns = DAILY_EVENT_SCENARIO_COLUMNS.filter(column =>
  column !== "event_id" && column !== "case_id" && column !== "segment");
function dataIdentity(dir: string): string {
  return digest(json(observations(dir)));
}
function observations(dir: string): string[] {
  return [...new Set(readFileSync(join(dir, "scenarios.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line);
    const observation = Object.fromEntries(observationColumns.filter(column => Object.hasOwn(row, column))
      .map(column => [column, row[column]]));
    return digest(json(observation));
  }))].sort();
}
function policy(manifest: Manifest): unknown {
  const { coverage: _coverage, ...daily } = manifest.daily_totals ?? {};
  const { observation_window: _window, ...comparability } = manifest.comparability;
  const { history: _history, seed: _seed, authored_outcomes: _outcomes, daily_totals: _daily, comparability: _comparability, ...fixed } = manifest;
  return { ...fixed, daily, comparability };
}

/** Create once in operator-owned storage; reopening never initializes missing state. */
export function createValidation(store: string, budget: Budget) {
  if (!Number.isSafeInteger(budget.max_input_bytes) || budget.max_input_bytes < 1) throw new Error("invalid_validation_budget");
  mkdirSync(store); // Existing stores must be opened, never reset.
  for (const name of ["frozen", "reserved", "uses", "assessments", "work"]) mkdirSync(join(store, name));
  writeFileSync(join(store, "config.json"), json(budget) + "\n", { flag: "wx", flush: true });
  return openValidation(store);
}

export function openValidation(store: string) {
  if (!existsSync(join(store, "config.json"))) throw new Error("validation_store_missing");
  const budget: Budget = read(join(store, "config.json"));
  if (!Number.isSafeInteger(budget.max_input_bytes) || budget.max_input_bytes < 1) throw new Error("invalid_validation_budget");
  for (const name of ["frozen", "reserved", "uses", "assessments", "work"]) if (!existsSync(join(store, name))) throw new Error("validation_store_incomplete");
  const temporary = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(store, "work", "replay-"));
    try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  function snapshot(kind: Snapshot["kind"], contents: Record<string, Buffer>): string {
    const descriptor: Snapshot = { kind, files: Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, digest(bytes)])) };
    const identity = digest(json(descriptor)), dir = join(store, kind, identity);
    if (!existsSync(dir)) {
      mkdirSync(dir); materialize(join(dir, "artifacts"), contents);
      writeFileSync(join(dir, "snapshot.json"), json(descriptor) + "\n", { flag: "wx", flush: true });
    }
    verified(kind, identity);
    return identity;
  }
  function verified(kind: Snapshot["kind"], identity: string): { dir: string; snapshot: Snapshot } {
    const root = join(store, kind, id(identity)), dir = join(root, "artifacts");
    if (!existsSync(join(root, "snapshot.json"))) throw new Error(`artifact_missing:${kind}`);
    const snapshot: Snapshot = read(join(root, "snapshot.json"));
    if (digest(json(snapshot)) !== identity || snapshot.kind !== kind) throw new Error(`frozen_artifact_mismatch:${kind}:snapshot`);
    const names = Object.keys(snapshot.files).sort();
    if (json(files(dir)) !== json(names)) throw new Error(`frozen_artifact_mismatch:${kind}:file_set`);
    const captured = capture(dir, names, budget);
    for (const name of names) if (digest(captured[name]!) !== snapshot.files[name]) throw new Error(`frozen_artifact_mismatch:${kind}:${name}`);
    return { dir, snapshot };
  }
  function prepare(frozen: string, reserved: string) {
    const a = verified("frozen", frozen), b = verified("reserved", reserved);
    const plan: ComparisonRequest = read(join(a.dir, "comparison-plan.json"));
    const searchManifest = readManifest(read(join(a.dir, "inputs/manifest.json")));
    const reservedManifest = readManifest(read(join(b.dir, "manifest.json")));
    const provenance: Provenance = { frozen_id: frozen, reserved_version: reserved, validation_identity: dataIdentity(b.dir),
      observation_identities: observations(b.dir),
      frozen_inputs: a.snapshot.files, reserved_inputs: b.snapshot.files, search_manifest: searchManifest,
      reserved_manifest: reservedManifest, target: plan.target, proposal: plan.proposal, generator: "materialized_history_no_generator" };
    const searched = new Set(observations(join(a.dir, "inputs")));
    if (provenance.observation_identities.some(value => searched.has(value))) throw new Error("validation_overlaps_search");
    if (reservedManifest.authored_outcomes?.partition !== "reserved-validation") throw new Error("not_reserved_validation");
    if (json(policy(searchManifest)) !== json(policy(reservedManifest))) throw new Error("frozen_artifact_mismatch:reserved:policy");
    const authority = Object.keys(a.snapshot.files).filter(name => name.startsWith("inputs/suite/") || name === "inputs/admission.json");
    const reservedAuthority = Object.keys(b.snapshot.files).filter(name => name.startsWith("suite/") || name === "admission.json");
    if (json(authority.map(name => name.slice(7)).sort()) !== json(reservedAuthority.sort())) throw new Error("frozen_artifact_mismatch:reserved:authority_set");
    for (const name of authority) if (a.snapshot.files[name] !== b.snapshot.files[name.slice(7)]) throw new Error(`frozen_artifact_mismatch:reserved:${name.slice(7)}`);
    return { a, b, plan, provenance };
  }
  function record(use: Use): void {
    appendFileSync(join(store, "uses", id(use.provenance.validation_identity) + ".jsonl"), json(use) + "\n", { flush: true });
  }
  function perform(prepared: ReturnType<typeof prepare>, out: string): ValidationResult {
    const comparisonDir = join(out, "comparison"); mkdirSync(comparisonDir);
    const comparison = compareRuns(prepared.b.dir, comparisonDir, { target: prepared.plan.target, proposal: prepared.plan.proposal });
    const result: ValidationResult = { assessment_id: digest(json(prepared.provenance)), status: comparison.eligibility === "eligible" ? "passed" : "failed",
      reason: comparison.reason, comparison, provenance: prepared.provenance,
      protected_corpus: { identity: null, status: "not_assessed" }, experimental_acceptance: "not_assessed" };
    writeFileSync(join(out, "validation.json"), json(result) + "\n");
    return result;
  }
  function replay(frozen: string, reserved: string, out: string): ValidationResult {
    if (readdirSync(out).length) throw new Error("replay_output_must_be_empty");
    const prepared = prepare(frozen, reserved), saved = join(store, "assessments", digest(json(prepared.provenance)));
    if (!existsSync(join(saved, "validation.json"))) throw new Error("assessment_not_completed");
    const result = perform(prepared, out);
    const actual = capture(out, files(out), budget), expected = capture(saved, files(saved), budget);
    if (json(Object.keys(actual)) !== json(Object.keys(expected))) throw new Error("saved_replay_mismatch:file_set");
    for (const name of Object.keys(actual)) if (!actual[name]!.equals(expected[name]!)) throw new Error(`saved_replay_mismatch:${name}`);
    return result;
  }
  return Object.freeze({
    freeze(comparisonDir: string): string {
      const captured = capture(comparisonDir, files(comparisonDir), budget);
      return temporary(dir => {
        const saved = join(dir, "saved"), replay = join(dir, "replay");
        materialize(saved, captured); mkdirSync(replay);
        const plan: ComparisonRequest = read(join(saved, "comparison-plan.json"));
        const manifest = readManifest(read(join(saved, "inputs/manifest.json")));
        if (manifest.authored_outcomes?.partition !== "search") throw new Error("freeze_requires_search_evidence");
        const result = compareRuns(join(saved, "inputs"), replay, { target: plan.target, proposal: plan.proposal });
        if (result.eligibility !== "eligible") throw new Error("freeze_requires_search_winner");
        const regenerated = capture(replay, files(replay), budget);
        if (json(Object.keys(captured)) !== json(Object.keys(regenerated))) throw new Error("search_evidence_mismatch:file_set");
        for (const name of Object.keys(captured)) if (!captured[name]!.equals(regenerated[name]!)) throw new Error(`search_evidence_mismatch:${name}`);
        return snapshot("frozen", captured);
      });
    },
    reserve(caseDir: string): string { return snapshot("reserved", capture(caseDir, inputNames(caseDir), budget)); },
    evaluate(frozen: string, reserved: string): ValidationResult {
      const prepared = prepare(frozen, reserved), usePath = join(store, "uses", prepared.provenance.validation_identity + ".jsonl");
      // A single trusted-store lock serializes checking shared observations and
      // claiming use. A crash leaves it locked, requiring operator recovery.
      const lock = join(store, "evaluation.lock");
      try { mkdirSync(lock); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("validation_store_busy_or_interrupted");
        throw error;
      }
      try {
        if (existsSync(usePath)) {
          record({ transition: "rejected", reason: "validation_already_used", provenance: prepared.provenance });
          throw new Error("validation_already_used");
        }
        const current = new Set(prepared.provenance.observation_identities);
        for (const name of readdirSync(join(store, "uses"))) {
          const first: Use = JSON.parse(readFileSync(join(store, "uses", name), "utf8").split("\n")[0]!);
          if (first.provenance.observation_identities.some(value => current.has(value))) {
            record({ transition: "rejected", reason: "validation_observations_already_used", provenance: prepared.provenance });
            throw new Error("validation_observations_already_used");
          }
        }
        writeFileSync(usePath, json({ transition: "claimed", reason: "reserved_evaluation_started", provenance: prepared.provenance }) + "\n", { flag: "wx", flush: true });
        const out = join(store, "assessments", digest(json(prepared.provenance))); mkdirSync(out);
        try {
          const result = perform(prepared, out);
          record({ transition: "completed", reason: result.reason, provenance: prepared.provenance });
          return result;
        } catch (error) {
          record({ transition: "rejected", reason: "reserved_evaluation_failed", provenance: prepared.provenance });
          throw error;
        }
      } finally { rmSync(lock, { recursive: true }); }
    },
    replay,
    finalEvidence(frozen: string, reserved: string): ValidationResult {
      const prepared = prepare(frozen, reserved), usePath = join(store, "uses", prepared.provenance.validation_identity + ".jsonl");
      if (!existsSync(usePath)) throw new Error("assessment_not_used");
      const uses: Use[] = readFileSync(usePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (uses.some(use => use.transition === "exposed")) throw new Error("validation_feedback_exposed");
      return temporary(dir => replay(frozen, reserved, dir));
    },
    expose(frozen: string, reserved: string): void {
      const prepared = prepare(frozen, reserved);
      if (!existsSync(join(store, "uses", prepared.provenance.validation_identity + ".jsonl"))) throw new Error("assessment_not_used");
      record({ transition: "exposed", reason: "feedback_released_for_search", provenance: prepared.provenance });
    },
    usage(reserved: string): Use[] {
      const snapshot = verified("reserved", reserved), path = join(store, "uses", dataIdentity(snapshot.dir) + ".jsonl");
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    },
  });
}
