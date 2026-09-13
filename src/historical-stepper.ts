// Day-step execution control for the existing historical run seam. The
// evaluator runs once per session; each accepted advance publishes only the
// prefix through the requested UTC day while preserving the final batch bytes.

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseYaml, type YamlValue } from "./yaml.ts";
import { canonicalJson, runCase, RunError } from "./seams/run.ts";
import { directoryBytes, enforceResource, resourceLimits, resourceCheckpoint, type ResourceOptions } from "./workload-resources.ts";

export const STEP_STATE_FILE = "step-state.json";
export const STEP_STATE_FORMAT = "historical-day-stepper-v1";
export const INTERACTIVE_STEP_WORKLOAD = {
  max_days: 31,
  max_events: 10000,
  max_rules: 16,
  max_results: 160000,
  max_canonical_bytes: 64 * 1024 * 1024,
} as const;

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY"]);
const TRANSIENT_RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40] as const;

export type HistoricalStepperOptions = {
  resources?: ResourceOptions;
  proposal?: YamlValue;
  /** Raw supplied proposal bytes, when the caller received a file artifact. */
  proposalBytes?: Uint8Array;
};

export type HistoricalStepState = {
  format_version: typeof STEP_STATE_FORMAT;
  status: "in_progress" | "complete";
  run_id: string;
  observation_window: { from: string; to: string };
  completed_through: string | null;
  next_day: string | null;
  completed_days: number;
  total_days: number;
  input_digests: Record<string, string>;
  output_digests: Record<string, string>;
};

export type HistoricalStepCleanupDiagnostic = {
  code: "historical_step_cleanup_pending";
  attempts: number;
  message: string;
  cause: unknown;
};

type Plan = {
  files: Map<string, Buffer>;
  runId: string;
  from: string;
  to: string;
  days: string[];
};

type PendingRestore = { target: string; backup: string };
type PendingCleanup = { backup: string; attempts: number; cause: unknown };

class RestorePendingError extends RunError {
  readonly pending: PendingRestore;

  constructor(message: string, pending: PendingRestore, cause: unknown) {
    super(message, { cause });
    this.pending = pending;
  }
}

/** A bounded in-process execution session over the public historical run seam. */
export class HistoricalDayStepper {
  readonly #caseDir: string;
  readonly #outDir: string;
  readonly #options: HistoricalStepperOptions;
  readonly #plan: Plan;
  readonly #inputDigests: Record<string, string>;
  #stateText: string;
  #pendingRestore: PendingRestore | null = null;
  #pendingCleanup: PendingCleanup[];

  constructor(
    caseDir: string,
    outDir: string,
    options: HistoricalStepperOptions,
    plan: Plan,
    inputDigests: Record<string, string>,
    stateText: string,
    pendingCleanup: PendingCleanup[],
  ) {
    this.#caseDir = caseDir;
    this.#outDir = outDir;
    this.#options = options;
    this.#plan = plan;
    this.#inputDigests = inputDigests;
    this.#stateText = stateText;
    this.#pendingCleanup = pendingCleanup;
  }

  /** Advance exactly the next required UTC calendar day. */
  advance(day: string): HistoricalStepState {
    const started = performance.now(), limits = resourceLimits(this.#options.resources);
    resourceCheckpoint(limits, started);
    this.#validateUnchanged();
    const current = JSON.parse(this.#stateText) as HistoricalStepState;
    if (current.status === "complete") throw new RunError("run_already_complete: historical run has no next day");
    const canonicalDay = readCalendarDay(day);
    if (canonicalDay !== current.next_day) {
      const suppliedIndex = this.#plan.days.indexOf(canonicalDay);
      if (suppliedIndex >= 0 && suppliedIndex < current.completed_days) {
        throw new RunError(`duplicate_step_day: ${canonicalDay} is already complete`);
      }
      throw new RunError(`out_of_order_step_day: expected ${current.next_day}, received ${canonicalDay}`);
    }
    const nextIndex = current.completed_days;
    const files = project(this.#plan, nextIndex);
    const state = makeState(this.#plan, this.#inputDigests, nextIndex + 1, files);
    const stateText = canonicalJson(state as unknown as YamlValue) + "\n";
    files.set(STEP_STATE_FILE, Buffer.from(stateText));
    enforceResource("output_bytes", [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0), limits.max_output_bytes);
    resourceCheckpoint(limits, started);
    try {
      const pendingCleanup = replaceDirectory(this.#outDir, files);
      if (pendingCleanup !== null) this.#pendingCleanup.push(pendingCleanup);
    } catch (error) {
      if (error instanceof RestorePendingError) this.#pendingRestore = error.pending;
      throw error;
    }
    this.#stateText = stateText;
    return state;
  }

  status(): HistoricalStepState {
    this.#validateUnchanged();
    return JSON.parse(this.#stateText) as HistoricalStepState;
  }

  /** Operational cleanup debt; never serialized into canonical ledger or cursor bytes. */
  cleanupDiagnostics(): HistoricalStepCleanupDiagnostic[] {
    return this.#pendingCleanup.map(pending => ({
      code: "historical_step_cleanup_pending",
      attempts: pending.attempts,
      message: cleanupPendingMessage(pending.cause),
      cause: pending.cause,
    }));
  }

  #validateUnchanged(): void {
    this.#restoreAcceptedLedger();
    this.#retryObsoleteBackupCleanup();
    let currentInputs: Record<string, string>;
    try {
      currentInputs = pinnedInputDigests(this.#caseDir, this.#options);
    } catch (error) {
      throw new RunError(`pinned_input_changed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (canonicalJson(currentInputs) !== canonicalJson(this.#inputDigests)) {
      throw new RunError("pinned_input_changed: start a separate candidate run for changed manifest, history, rule, catalog, tenant, proposal, or translation input");
    }
    const actualState = readFileSync(join(this.#outDir, STEP_STATE_FILE), "utf8");
    if (actualState !== this.#stateText) throw new RunError("step_state_changed: cursor bytes do not match this execution session");
    const state = JSON.parse(this.#stateText) as HistoricalStepState;
    const expectedNames = [...Object.keys(state.output_digests), STEP_STATE_FILE].sort();
    const actualNames = readdirSync(this.#outDir).sort();
    if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
      throw new RunError("step_output_changed: ledger members differ from the last accepted step");
    }
    for (const [name, digest] of Object.entries(state.output_digests)) {
      if (sha256(readFileSync(join(this.#outDir, name))) !== digest) {
        throw new RunError(`step_output_changed: ${name} bytes differ from the last accepted step`);
      }
    }
  }

  #restoreAcceptedLedger(): void {
    if (this.#pendingRestore === null) return;
    const pending = this.#pendingRestore;
    if (existsSync(pending.target)) {
      throw new RunError("historical_step_restore_conflict: canonical output reappeared while the accepted backup was pending; the backup was retained");
    }
    if (!existsSync(pending.backup)) {
      throw new RunError("historical_step_restore_missing: the accepted backup is unavailable; this active session cannot restore the canonical output");
    }
    try {
      renameWithTransientRetry(pending.backup, pending.target);
    } catch (error) {
      throw restorePendingError(pending, error);
    }
    this.#pendingRestore = null;
  }

  #retryObsoleteBackupCleanup(): void {
    const stillPending: PendingCleanup[] = [];
    for (const pending of this.#pendingCleanup) {
      try {
        rmSync(pending.backup, { recursive: true, force: true });
      } catch (cause) {
        stillPending.push({ backup: pending.backup, attempts: pending.attempts + 1, cause });
      }
    }
    this.#pendingCleanup = stillPending;
  }
}

/** Start a new stepped run. The output must be absent or empty. */
export function startHistoricalDayStepper(
  caseDir: string,
  outDir: string,
  options: HistoricalStepperOptions = {},
): HistoricalDayStepper {
  const started = performance.now(), limits = resourceLimits(options.resources);
  options = { ...options, ...(options.resources === undefined ? {} : { resources: { ...options.resources } }) };
  resourceCheckpoint(limits, started);
  enforceResource("input_bytes", directoryBytes(caseDir), limits.max_input_bytes);
  if (existsSync(outDir) && readdirSync(outDir).length !== 0) {
    throw new RunError(`${outDir}: step output directory must be empty`);
  }
  validateProposalBinding(options);
  preflightInteractiveWorkload(caseDir);
  const before = pinnedInputDigests(caseDir, options);
  const plan = buildPlan(caseDir, options);
  const after = pinnedInputDigests(caseDir, options);
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new RunError("pinned_input_changed: inputs changed while the historical execution plan was built");
  }
  const files = project(plan, -1);
  const state = makeState(plan, before, 0, files);
  const stateText = canonicalJson(state as unknown as YamlValue) + "\n";
  files.set(STEP_STATE_FILE, Buffer.from(stateText));
  enforceResource("output_bytes", [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0), limits.max_output_bytes);
  resourceCheckpoint(limits, started);
  const pendingCleanup = replaceDirectory(outDir, files);
  return new HistoricalDayStepper(caseDir, outDir, options, plan, before, stateText,
    pendingCleanup === null ? [] : [pendingCleanup]);
}

function validateProposalBinding(options: HistoricalStepperOptions): void {
  if (options.proposalBytes === undefined) return;
  if (options.proposal === undefined) throw new RunError("proposal_bytes_mismatch: raw proposal bytes require a parsed proposal");
  let supplied: YamlValue;
  try {
    supplied = parseYaml(Buffer.from(options.proposalBytes).toString("utf8"));
  } catch (error) {
    throw new RunError(`proposal_bytes_mismatch: supplied bytes are not the evaluated proposal: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (canonicalJson(supplied) !== canonicalJson(options.proposal)) {
    throw new RunError("proposal_bytes_mismatch: supplied bytes are not the evaluated proposal");
  }
}

function buildPlan(caseDir: string, options: HistoricalStepperOptions): Plan {
  const planDir = mkdtempSync(join(tmpdir(), "fwh-historical-plan-"));
  try {
    const manifest = runCase(caseDir, planDir, {
      requireAdmittedSuite: true,
      ...(options.resources === undefined ? {} : { resources: options.resources }),
      ...(options.proposal === undefined ? {} : { proposal: options.proposal }),
      ...(options.proposalBytes === undefined ? {} : { proposalBytes: options.proposalBytes }),
    });
    if (manifest.daily_totals === undefined) {
      throw new RunError("historical_step_requires_daily_totals: manifest.daily_totals is required");
    }
    const from = readCalendarDay(manifest.comparability.observation_window.from);
    const to = readCalendarDay(manifest.comparability.observation_window.to);
    const days = calendarDays(from, to);
    if (days.length === 0) throw new RunError("historical_step_window_empty: observation window must contain at least one day");
    const files = new Map<string, Buffer>();
    for (const name of readdirSync(planDir).sort()) {
      if (!statSync(join(planDir, name)).isFile()) throw new RunError(`historical_step_plan_invalid: unexpected directory ${name}`);
      files.set(name, readFileSync(join(planDir, name)));
    }
    const canonicalBytes = [...files.values()].reduce((total, value) => total + value.byteLength, 0);
    if (canonicalBytes > INTERACTIVE_STEP_WORKLOAD.max_canonical_bytes) {
      throw new RunError(`historical_step_workload_exceeded: canonical bytes ${canonicalBytes} exceeds ${INTERACTIVE_STEP_WORKLOAD.max_canonical_bytes}`);
    }
    return { files, runId: manifest.run_id, from, to, days };
  } finally {
    rmSync(planDir, { recursive: true, force: true });
  }
}

function preflightInteractiveWorkload(caseDir: string): void {
  const doc = JSON.parse(readFileSync(join(caseDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  const comparability = doc.comparability as Record<string, unknown> | undefined;
  const window = comparability?.observation_window as Record<string, unknown> | undefined;
  if (typeof window?.from !== "string" || typeof window.to !== "string") return;
  const days = calendarDayCount(readCalendarDay(window.from), readCalendarDay(window.to));
  const events = readFileSync(join(caseDir, "scenarios.jsonl"), "utf8").split("\n").filter(line => line.trim() !== "").length;
  const selected = Array.isArray(doc.admitted_rule_ids) ? doc.admitted_rule_ids.length : 0;
  const results = events * selected;
  const checks: [string, number, number][] = [
    ["day", days, INTERACTIVE_STEP_WORKLOAD.max_days],
    ["event", events, INTERACTIVE_STEP_WORKLOAD.max_events],
    ["rule", selected, INTERACTIVE_STEP_WORKLOAD.max_rules],
    ["event-by-rule result", results, INTERACTIVE_STEP_WORKLOAD.max_results],
  ];
  for (const [label, actual, maximum] of checks) {
    if (!Number.isSafeInteger(actual) || actual > maximum) {
      throw new RunError(`historical_step_workload_exceeded: ${label} count ${actual} exceeds ${maximum}`);
    }
  }
}

function project(plan: Plan, completedIndex: number): Map<string, Buffer> {
  const cursor = completedIndex < 0 ? null : plan.days[completedIndex]!;
  if (completedIndex === plan.days.length - 1) return new Map(plan.files);
  const files = new Map(plan.files);
  const filter = (name: string, predicate: (row: Record<string, unknown>) => boolean) => {
    const source = plan.files.get(name);
    if (source === undefined) return;
    const projected = source.toString("utf8").split("\n").filter(Boolean)
      .filter(line => predicate(JSON.parse(line))).map(line => line + "\n").join("");
    files.set(name, Buffer.from(projected));
  };
  filter("verdicts.jsonl", row => cursor !== null && String(row.as_of_day) <= cursor);
  filter("feature-snapshots.jsonl", row => cursor !== null && String(row.as_of_day) <= cursor);
  filter("reference-assessments.jsonl", row => cursor !== null && String(row.as_of_day) <= cursor);
  filter("merchant-days.jsonl", row => String(row.day) < plan.from || (cursor !== null && String(row.day) <= cursor));
  for (const name of ["authored-outcomes.jsonl", "scenario-metrics.jsonl"]) {
    if (files.has(name)) files.set(name, Buffer.alloc(0));
  }

  const finalMetrics = parseRows(plan.files.get("metrics.jsonl")!)[0]!;
  const visibleScenarios = parseRows(plan.files.get("scenarios.jsonl")!).filter(row => {
    const day = String(row.ts).slice(0, 10);
    return cursor !== null && day >= plan.from && day <= cursor;
  });
  const visibleVerdicts = parseRows(files.get("verdicts.jsonl")!);
  const alertIds = new Set(visibleVerdicts.filter(row => row.fired === true).map(row => String(row.event_id)));
  const metrics = { ...finalMetrics, events: visibleScenarios.length, alerts: finalMetrics.alerts === null ? null : alertIds.size };
  files.set("metrics.jsonl", Buffer.from(canonicalJson(metrics as YamlValue) + "\n"));
  return files;
}

function makeState(
  plan: Plan,
  inputDigests: Record<string, string>,
  completedDays: number,
  files: ReadonlyMap<string, Uint8Array>,
): HistoricalStepState {
  const outputDigests = Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)]));
  const complete = completedDays === plan.days.length;
  return {
    format_version: STEP_STATE_FORMAT,
    status: complete ? "complete" : "in_progress",
    run_id: plan.runId,
    observation_window: { from: plan.from, to: plan.to },
    completed_through: completedDays === 0 ? null : plan.days[completedDays - 1]!,
    next_day: complete ? null : plan.days[completedDays]!,
    completed_days: completedDays,
    total_days: plan.days.length,
    input_digests: inputDigests,
    output_digests: outputDigests,
  };
}

function pinnedInputDigests(caseDir: string, options: HistoricalStepperOptions): Record<string, string> {
  const paths = ["manifest.json", "scenarios.jsonl", "suite/catalog.yaml", "suite/tenant.yaml"];
  const rulesDir = join(caseDir, "suite", "rules");
  if (existsSync(rulesDir)) {
    for (const name of readdirSync(rulesDir).filter(name => name.endsWith(".yaml")).sort()) {
      paths.push(posix.join("suite", "rules", name));
    }
  }
  if (existsSync(join(caseDir, "admission.json"))) paths.push("admission.json");
  const entries = paths.sort().map(path => {
    const bytes = readFileSync(join(caseDir, ...path.split("/")));
    const portable = path === "admission.json" ? bytes : Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
    return [path, sha256(portable)] as const;
  });
  if (options.proposal !== undefined) entries.push(["supplied-proposal.canonical.json", sha256(canonicalJson(options.proposal))]);
  if (options.proposalBytes !== undefined) entries.push(["supplied-proposal.raw", sha256(options.proposalBytes)]);
  return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function parseRows(bytes: Uint8Array): Record<string, unknown>[] {
  return Buffer.from(bytes).toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

function readCalendarDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RunError(`invalid_step_day: ${value} must use YYYY-MM-DD`);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new RunError(`invalid_step_day: ${value} is not a calendar day`);
  }
  return value;
}

function calendarDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const count = calendarDayCount(from, to);
  const days: string[] = [];
  for (let offset = 0; offset < count; offset++) days.push(new Date(start + offset * 86400000).toISOString().slice(0, 10));
  return days;
}

function calendarDayCount(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (start >= end) throw new RunError("historical_step_window_invalid: observation window.from must precede observation window.to");
  const count = (end - start) / 86400000;
  if (!Number.isSafeInteger(count)) throw new RunError("historical_step_window_invalid: observation window must contain whole UTC days");
  return count;
}

function replaceDirectory(outDir: string, files: ReadonlyMap<string, Uint8Array>): PendingCleanup | null {
  const target = resolve(outDir);
  const parent = dirname(target);
  const name = basename(target);
  if (target === parent || name === "." || name === "..") throw new RunError(`unsafe step output directory ${outDir}`);
  mkdirSync(parent, { recursive: true });
  const stage = mkdtempSync(join(parent, `.${name}.next-`));
  const backup = join(parent, `.${name}.previous-${randomUUID()}`);
  let moved = false;
  try {
    for (const [file, bytes] of files) writeFileSync(join(stage, file), bytes);
    if (existsSync(target)) {
      renameWithTransientRetry(target, backup);
      moved = true;
    }
    renameWithTransientRetry(stage, target);
  } catch (error) {
    let restoreError: RestorePendingError | null = null;
    let cleanupError: unknown;
    if (!existsSync(target) && moved && existsSync(backup)) {
      try {
        renameWithTransientRetry(backup, target);
      } catch (rollbackError) {
        restoreError = restorePendingError({ target, backup }, rollbackError, error);
      }
    }
    if (existsSync(stage)) {
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch (stageError) {
        cleanupError = stageError;
      }
    }
    if (restoreError !== null && cleanupError !== undefined) {
      throw restoreErrorWithCleanupFailure(restoreError, cleanupError);
    }
    if (restoreError !== null) throw restoreError;
    if (cleanupError !== undefined) throw cleanupError;
    throw error;
  }
  // Cleanup is outside the commit path: failure to remove a private previous
  // snapshot must not report the already-published next cursor as rejected.
  if (moved) {
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch (cause) {
      return { backup, attempts: 1, cause };
    }
  }
  return null;
}

function cleanupPendingMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `historical_step_cleanup_pending: obsolete accepted backup removal failed (${detail}); status() or advance() on this active session will retry`;
}

function restorePendingError(pending: PendingRestore, rollbackError: unknown, publicationError?: unknown): RestorePendingError {
  const diagnostic = isTransientRenameError(rollbackError)
    ? "historical_step_restore_pending"
    : "historical_step_restore_failed";
  const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
  const cause = publicationError === undefined
    ? rollbackError
    : new AggregateError([publicationError, rollbackError], "historical step publication and restoration failed");
  return new RestorePendingError(
    `${diagnostic}: accepted ledger backup was retained after canonical restoration failed (${detail}); call status() or advance() on this active session to retry`,
    pending,
    cause,
  );
}

function restoreErrorWithCleanupFailure(restoreError: RestorePendingError, cleanupError: unknown): RestorePendingError {
  const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  const priorCauses = restoreError.cause instanceof AggregateError
    ? restoreError.cause.errors
    : [restoreError.cause ?? restoreError];
  return new RestorePendingError(
    `${restoreError.message}; staging cleanup also failed (${detail})`,
    restoreError.pending,
    new AggregateError([...priorCauses, cleanupError], "historical step publication, restoration, and staging cleanup failed"),
  );
}

function renameWithTransientRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || attempt === TRANSIENT_RENAME_RETRY_DELAYS_MS.length) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TRANSIENT_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isTransientRenameError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
