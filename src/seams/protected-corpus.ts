import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readJsonl, type Json } from "../ledger.ts";
import type { YamlValue } from "../yaml.ts";
import { canonicalJson, readManifest, runCase, type Manifest } from "./run.ts";
import { compareRuns, type ComparisonTarget } from "./comparison.ts";

const SCHEMA_VERSION = "protected-fraud-case-corpus-v1";

export type ProtectedCaseRecord = {
  case_id: string;
  outcome: "fraud";
  detected: true;
  detected_by_rule_ids: string[];
  source_event_ids: string[];
};

export type ProtectedCorpusRecord = {
  schema_version: typeof SCHEMA_VERSION;
  corpus_id: string;
  version: number;
  previous: { corpus_id: string; version: number; sha256: string } | null;
  use: "known_regression";
  source: { directory: string; input_digests: Record<string, string> };
  accepted_suite: {
    proposal: YamlValue | null;
    run_id: string;
    suite_id: string;
    parameter_snapshot_id: string;
    parameters: Record<string, number>;
  };
  accepted_evidence: {
    dataset_id: string;
    partition: string;
    history: NonNullable<Manifest["history"]>;
    outcome_version: string;
    observation_window: { from: string; to: string };
    outcome_as_of: string;
    scenario_metrics_sha256: string;
    verdicts_sha256: string;
  };
  protected_cases: ProtectedCaseRecord[];
};

export type VerifiedProtectedCorpus = {
  record: ProtectedCorpusRecord;
  sha256: string;
  source_directory: string;
};

export type ProtectedCorpusSummary = {
  corpus_id: string;
  version: number;
  sha256: string;
  use: "known_regression";
  source_dataset_id: string;
  accepted_run_id: string;
  accepted_suite_id: string;
};

export type ProtectedCaseDisposition = {
  case_id: string;
  status: "retained" | "missing" | "lost" | "unavailable" | "incumbent_missed" | "not_evaluated";
  reason: string;
  corpus_evidence: {
    corpus_id: string;
    corpus_version: number;
    corpus_sha256: string;
    dataset_id: string;
    outcome_version: string;
    observation_window: { from: string; to: string };
    accepted_run_id: string;
    accepted_suite_id: string;
    parameter_snapshot_id: string;
    parameters: Record<string, number>;
    source_input_digests: Record<string, string>;
    source_event_ids: string[];
    detected_by_rule_ids: string[];
  };
  evaluation_evidence: {
    dataset_id: string;
    outcome_version: string;
    observation_window: { from: string; to: string };
    input_digests: Record<string, string>;
    incumbent_run_id: string | null;
    incumbent_suite_id: string | null;
    candidate_run_id: string | null;
    candidate_suite_id: string | null;
    source_event_ids: string[];
    outcome: string | null;
    available_at: string | null;
  };
};

export type ProtectedCaseCheck = {
  expected_count: number;
  disposition_count: number;
  retained_count: number;
  missing_count: number;
  lost_count: number;
  unavailable_count: number;
  incumbent_missed_count: number;
  not_evaluated_count: number;
  retained_case_ids: string[];
  missing_case_ids: string[];
  lost_case_ids: string[];
  unavailable_case_ids: string[];
  incumbent_missed_case_ids: string[];
  not_evaluated_case_ids: string[];
  dispositions: ProtectedCaseDisposition[];
};

type EvaluationEvidence = {
  manifest: Manifest;
  inputs_directory: string;
  input_digests: Record<string, string>;
  incumbent_directory: string;
  candidate_directory: string;
  incumbent_run_id: string;
  incumbent_suite_id: string;
  candidate_run_id: string;
  candidate_suite_id: string;
};

export class ProtectedCorpusError extends Error {}

export function listRunInputFiles(caseDir: string): string[] {
  return [
    "manifest.json", "scenarios.jsonl", "suite/catalog.yaml", "suite/tenant.yaml",
    ...readdirSync(join(caseDir, "suite/rules")).filter(name => name.endsWith(".yaml")).map(name => `suite/rules/${name}`),
    ...(existsSync(join(caseDir, "admission.json")) ? ["admission.json"] : []),
  ].sort();
}

export function portableInputDigests(caseDir: string): Record<string, string> {
  // Admission is opaque provenance, even though its conventional name is JSON.
  // Only the run contract's UTF8 text inputs have portable CRLF/LF semantics.
  return Object.fromEntries(listRunInputFiles(caseDir).map(path => [path,
    path === "admission.json" ? fileDigest(join(caseDir, path)) : portableDigest(join(caseDir, path))]));
}

export function verifyProtectedCorpus(corpusFile: string): VerifiedProtectedCorpus {
  let bytes: Buffer;
  let raw: unknown;
  try {
    bytes = readFileSync(corpusFile);
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ProtectedCorpusError(`protected corpus cannot be read: ${message(error)}`);
  }
  const record = parseRecord(raw);
  const sha256 = digest(bytes);
  const sourceDirectory = resolve(dirname(corpusFile), record.source.directory);
  if (!existsSync(sourceDirectory) || !lstatSync(sourceDirectory).isDirectory()) {
    throw new ProtectedCorpusError("protected corpus source directory is missing");
  }
  const actualInputDigests = portableInputDigests(sourceDirectory);
  if (canonicalJson(actualInputDigests) !== canonicalJson(record.source.input_digests)) {
    throw new ProtectedCorpusError("protected corpus source digest evidence does not match the historical input provenance");
  }
  const replay = mkdtempSync(join(tmpdir(), "fwh-protected-corpus-"));
  try {
    runCase(sourceDirectory, replay, {
      requireAdmittedSuite: true,
      ...(record.accepted_suite.proposal === null ? {} : { proposal: record.accepted_suite.proposal }),
    });
    verifyReplay(record, sourceDirectory, replay);
  } catch (error) {
    if (error instanceof ProtectedCorpusError) throw error;
    throw new ProtectedCorpusError(`protected corpus historical replay rejected: ${message(error)}`);
  } finally {
    rmSync(replay, { recursive: true, force: true });
  }
  return { record, sha256, source_directory: sourceDirectory };
}

export function summarizeProtectedCorpus(corpus: VerifiedProtectedCorpus): ProtectedCorpusSummary {
  return {
    corpus_id: corpus.record.corpus_id,
    version: corpus.record.version,
    sha256: corpus.sha256,
    use: corpus.record.use,
    source_dataset_id: corpus.record.accepted_evidence.dataset_id,
    accepted_run_id: corpus.record.accepted_suite.run_id,
    accepted_suite_id: corpus.record.accepted_suite.suite_id,
  };
}

export function assessProtectedCases(corpus: VerifiedProtectedCorpus, evidence: EvaluationEvidence): ProtectedCaseCheck {
  const outcomes = evidence.manifest.authored_outcomes;
  if (outcomes === undefined) throw new ProtectedCorpusError("protected cases require authored outcomes");
  const authored = new Map(outcomes.cases.map(row => [row.case_id, row]));
  const scenarios = readJsonl(join(evidence.inputs_directory, "scenarios.jsonl")) as Record<string, Json>[];
  const incumbentMetrics = aggregateMetrics(evidence.incumbent_directory);
  const candidateMetrics = aggregateMetrics(evidence.candidate_directory);
  const incumbentDetected = new Set(incumbentMetrics.detected_fraud_case_ids as string[]);
  const candidateDetected = new Set(candidateMetrics.detected_fraud_case_ids as string[]);
  const candidateVerdicts = readJsonl(join(evidence.candidate_directory, "verdicts.jsonl")) as Record<string, Json>[];
  const dispositions = corpus.record.protected_cases.map(protectedCase => {
    const current = authored.get(protectedCase.case_id);
    const sourceEventIds = scenarios.filter(row => row.case_id === protectedCase.case_id)
      .map(row => String(row.event_id)).sort();
    let status: ProtectedCaseDisposition["status"] = "retained";
    let reason = "candidate retained the protected detection on the paired evaluation inputs";
    if (current === undefined) {
      status = "missing"; reason = "protected case is absent from the authored outcome population";
    } else if (!withinWindow(current, outcomes.observation_window)) {
      status = "missing"; reason = "protected case is outside the changed observation window";
    } else if (sourceEventIds.length === 0) {
      status = "missing"; reason = "protected case is absent from the evaluation source";
    } else if (current.outcome !== "fraud") {
      status = "unavailable"; reason = `protected case outcome is ${current.outcome}, not mature fraud`;
    } else if (current.available_at > outcomes.as_of) {
      status = "unavailable"; reason = "protected case outcome is not available at the evaluation cutoff";
    } else if (candidateVerdicts.some(row => sourceEventIds.includes(String(row.event_id)) && row.verdict === "unavailable")) {
      status = "unavailable"; reason = "candidate evaluation is unavailable for the protected case";
    } else if (!incumbentDetected.has(protectedCase.case_id)) {
      status = "incumbent_missed"; reason = "incumbent did not reproduce the protected detection on the changed inputs";
    } else if (!candidateDetected.has(protectedCase.case_id)) {
      status = "lost"; reason = "candidate lost the protected detection reproduced by the incumbent";
    }
    return {
      case_id: protectedCase.case_id,
      status,
      reason,
      corpus_evidence: corpusEvidence(corpus, protectedCase),
      evaluation_evidence: {
        dataset_id: outcomes.dataset_id,
        outcome_version: outcomes.version,
        observation_window: outcomes.observation_window,
        input_digests: evidence.input_digests,
        incumbent_run_id: evidence.incumbent_run_id,
        incumbent_suite_id: evidence.incumbent_suite_id,
        candidate_run_id: evidence.candidate_run_id,
        candidate_suite_id: evidence.candidate_suite_id,
        source_event_ids: sourceEventIds,
        outcome: current?.outcome ?? null,
        available_at: current?.available_at ?? null,
      },
    } satisfies ProtectedCaseDisposition;
  });
  return buildCheck(corpus.record.protected_cases.length, dispositions);
}

export function assessProtectedInputs(corpus: VerifiedProtectedCorpus, evidence: {
  manifest: Manifest; inputs_directory: string; input_digests: Record<string, string>;
}): ProtectedCaseCheck {
  const outcomes = evidence.manifest.authored_outcomes;
  if (outcomes === undefined) throw new ProtectedCorpusError("protected cases require authored outcomes");
  const authored = new Map(outcomes.cases.map(row => [row.case_id, row]));
  const scenarios = readJsonl(join(evidence.inputs_directory, "scenarios.jsonl")) as Record<string, Json>[];
  const dispositions = corpus.record.protected_cases.map(protectedCase => {
    const current = authored.get(protectedCase.case_id);
    const sourceEventIds = scenarios.filter(row => row.case_id === protectedCase.case_id)
      .map(row => String(row.event_id)).sort();
    let status: ProtectedCaseDisposition["status"] = "not_evaluated";
    let reason = "protected case awaits paired incumbent and candidate replay";
    if (current === undefined) {
      status = "missing";
      reason = canonicalJson(outcomes.observation_window) === canonicalJson(corpus.record.accepted_evidence.observation_window)
        ? "protected case is absent from the authored outcome population"
        : "protected case is missing after the observation window changed";
    } else if (!withinWindow(current, outcomes.observation_window)) {
      status = "missing"; reason = "protected case is outside the changed observation window";
    } else if (sourceEventIds.length === 0) {
      status = "missing"; reason = "protected case is absent from the evaluation source";
    } else if (current.outcome !== "fraud") {
      status = "unavailable"; reason = `protected case outcome is ${current.outcome}, not mature fraud`;
    } else if (current.available_at > outcomes.as_of) {
      status = "unavailable"; reason = "protected case outcome is not available at the evaluation cutoff";
    }
    return {
      case_id: protectedCase.case_id,
      status,
      reason,
      corpus_evidence: corpusEvidence(corpus, protectedCase),
      evaluation_evidence: {
        dataset_id: outcomes.dataset_id,
        outcome_version: outcomes.version,
        observation_window: outcomes.observation_window,
        input_digests: evidence.input_digests,
        incumbent_run_id: null,
        incumbent_suite_id: null,
        candidate_run_id: null,
        candidate_suite_id: null,
        source_event_ids: sourceEventIds,
        outcome: current?.outcome ?? null,
        available_at: current?.available_at ?? null,
      },
    } satisfies ProtectedCaseDisposition;
  });
  return buildCheck(corpus.record.protected_cases.length, dispositions);
}

export function advanceProtectedCorpusVersion(previousCorpusFile: string, comparisonDir: string, nextDir: string): ProtectedCorpusRecord {
  const previous = verifyProtectedCorpus(previousCorpusFile);
  const result = readSingleJson(join(comparisonDir, "comparison.jsonl"));
  const plan = readSingleJson(join(comparisonDir, "comparison-plan.json"));
  if (result.eligibility !== "eligible") throw new ProtectedCorpusError("comparison is not eligible; corpus version was not created");
  verifyComparisonReplay(previousCorpusFile, comparisonDir, plan, result);
  if ((result.protected_corpus as Record<string, Json> | null)?.sha256 !== previous.sha256) {
    throw new ProtectedCorpusError("comparison was not checked against the supplied prior corpus bytes");
  }
  const check = result.protected_cases as Record<string, Json> | null;
  if (check === null || Number(check.expected_count) !== Number(check.retained_count)) {
    throw new ProtectedCorpusError("comparison did not retain every protected case");
  }
  if (existsSync(nextDir)) throw new ProtectedCorpusError("next corpus directory already exists");
  const inputs = join(comparisonDir, "inputs"), candidate = join(comparisonDir, "candidate");
  const manifest = readManifest(JSON.parse(readFileSync(join(inputs, "manifest.json"), "utf8")));
  const outcomes = manifest.authored_outcomes;
  if (outcomes === undefined) throw new ProtectedCorpusError("eligible comparison is missing authored outcomes");
  const runManifest = readSingleJson(join(candidate, "manifest.jsonl"));
  const metrics = aggregateMetrics(candidate);
  const verdicts = readJsonl(join(candidate, "verdicts.jsonl")) as Record<string, Json>[];
  const scenarios = readJsonl(join(inputs, "scenarios.jsonl")) as Record<string, Json>[];
  const cases = previous.record.protected_cases.map(row => row.case_id).sort().map(caseId => {
    if (!(metrics.detected_fraud_case_ids as string[]).includes(caseId)) {
      throw new ProtectedCorpusError(`eligible comparison did not detect protected case ${caseId}`);
    }
    const sourceEventIds = scenarios.filter(row => row.case_id === caseId).map(row => String(row.event_id)).sort();
    const eventSet = new Set(sourceEventIds);
    const ruleIds = [...new Set(verdicts.filter(row => eventSet.has(String(row.event_id)) && row.verdict === "alert")
      .map(row => String(row.rule_id)))].sort();
    if (sourceEventIds.length === 0 || ruleIds.length === 0) throw new ProtectedCorpusError(`candidate evidence is incomplete for detected case ${caseId}`);
    return { case_id: caseId, outcome: "fraud", detected: true, detected_by_rule_ids: ruleIds, source_event_ids: sourceEventIds } satisfies ProtectedCaseRecord;
  });
  const parent = dirname(nextDir); mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".protected-corpus-"));
  try {
    cpSync(inputs, join(staging, "source"), { recursive: true });
    const record: ProtectedCorpusRecord = {
      schema_version: SCHEMA_VERSION,
      corpus_id: previous.record.corpus_id,
      version: previous.record.version + 1,
      previous: { corpus_id: previous.record.corpus_id, version: previous.record.version, sha256: previous.sha256 },
      use: "known_regression",
      source: { directory: "source", input_digests: portableInputDigests(inputs) },
      accepted_suite: {
        proposal: (plan.proposal ?? null) as YamlValue | null,
        run_id: String(runManifest.run_id),
        suite_id: String(runManifest.suite_id),
        parameter_snapshot_id: String(runManifest.parameter_snapshot_id),
        parameters: runManifest.parameter_snapshot as Record<string, number>,
      },
      accepted_evidence: {
        dataset_id: outcomes.dataset_id,
        partition: outcomes.partition,
        history: manifest.history!,
        outcome_version: outcomes.version,
        observation_window: outcomes.observation_window,
        outcome_as_of: outcomes.as_of,
        scenario_metrics_sha256: fileDigest(join(candidate, "scenario-metrics.jsonl")),
        verdicts_sha256: fileDigest(join(candidate, "verdicts.jsonl")),
      },
      protected_cases: cases,
    };
    writeFileSync(join(staging, "corpus.json"), JSON.stringify(record, null, 2) + "\n");
    verifyProtectedCorpus(join(staging, "corpus.json"));
    renameSync(staging, nextDir);
    return record;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function verifyComparisonReplay(previousCorpusFile: string, comparisonDir: string,
  plan: Record<string, Json>, result: Record<string, Json>): void {
  const replay = mkdtempSync(join(tmpdir(), "fwh-corpus-comparison-"));
  try {
    const actual = compareRuns(join(comparisonDir, "inputs"), replay, {
      target: plan.target as ComparisonTarget,
      proposal: plan.proposal as YamlValue,
      protected_corpus_file: previousCorpusFile,
      ...(plan.supplied_evidence_digests === null ? {} : { supplied_runs: {
        incumbent: join(comparisonDir, "incumbent"), candidate: join(comparisonDir, "candidate"),
      } }),
    });
    if (actual.eligibility !== "eligible") throw new ProtectedCorpusError(`comparison replay is not eligible: ${actual.reason}`);
    equal(readSingleJson(join(replay, "comparison-plan.json")), plan, "comparison plan");
    equal(actual, result, "comparison result");
    for (const arm of ["incumbent", "candidate"]) {
      const expected = join(replay, arm), saved = join(comparisonDir, arm);
      equal(readdirSync(saved).sort(), readdirSync(expected).sort(), `comparison ${arm} file set`);
      for (const file of readdirSync(expected)) {
        if (!readFileSync(join(saved, file)).equals(readFileSync(join(expected, file)))) {
          throw new ProtectedCorpusError(`comparison ${arm}/${file} does not match replayed evidence`);
        }
      }
    }
  } catch (error) {
    if (error instanceof ProtectedCorpusError) throw error;
    throw new ProtectedCorpusError(`comparison replay rejected: ${message(error)}`);
  } finally {
    rmSync(replay, { recursive: true, force: true });
  }
}

function corpusEvidence(corpus: VerifiedProtectedCorpus, protectedCase: ProtectedCaseRecord): ProtectedCaseDisposition["corpus_evidence"] {
  return {
    corpus_id: corpus.record.corpus_id,
    corpus_version: corpus.record.version,
    corpus_sha256: corpus.sha256,
    dataset_id: corpus.record.accepted_evidence.dataset_id,
    outcome_version: corpus.record.accepted_evidence.outcome_version,
    observation_window: corpus.record.accepted_evidence.observation_window,
    accepted_run_id: corpus.record.accepted_suite.run_id,
    accepted_suite_id: corpus.record.accepted_suite.suite_id,
    parameter_snapshot_id: corpus.record.accepted_suite.parameter_snapshot_id,
    parameters: corpus.record.accepted_suite.parameters,
    source_input_digests: corpus.record.source.input_digests,
    source_event_ids: protectedCase.source_event_ids,
    detected_by_rule_ids: protectedCase.detected_by_rule_ids,
  };
}

function buildCheck(expectedCount: number, dispositions: ProtectedCaseDisposition[]): ProtectedCaseCheck {
  const ids = (status: ProtectedCaseDisposition["status"]) => dispositions.filter(row => row.status === status).map(row => row.case_id);
  const retained = ids("retained"), missing = ids("missing"), lost = ids("lost"), unavailable = ids("unavailable");
  const incumbentMissed = ids("incumbent_missed"), notEvaluated = ids("not_evaluated");
  return {
    expected_count: expectedCount,
    disposition_count: dispositions.length,
    retained_count: retained.length,
    missing_count: missing.length,
    lost_count: lost.length,
    unavailable_count: unavailable.length,
    incumbent_missed_count: incumbentMissed.length,
    not_evaluated_count: notEvaluated.length,
    retained_case_ids: retained,
    missing_case_ids: missing,
    lost_case_ids: lost,
    unavailable_case_ids: unavailable,
    incumbent_missed_case_ids: incumbentMissed,
    not_evaluated_case_ids: notEvaluated,
    dispositions,
  };
}

function verifyReplay(record: ProtectedCorpusRecord, sourceDirectory: string, replay: string): void {
  const manifest = readSingleJson(join(replay, "manifest.jsonl"));
  const metrics = aggregateMetrics(replay);
  const verdicts = readJsonl(join(replay, "verdicts.jsonl")) as Record<string, Json>[];
  const scenarios = readJsonl(join(sourceDirectory, "scenarios.jsonl")) as Record<string, Json>[];
  const sourceManifest = readManifest(JSON.parse(readFileSync(join(sourceDirectory, "manifest.json"), "utf8")));
  const outcomes = sourceManifest.authored_outcomes;
  if (outcomes === undefined) throw new ProtectedCorpusError("protected corpus source has no authored outcomes");
  equal(manifest.run_id, record.accepted_suite.run_id, "accepted run id");
  equal(manifest.suite_id, record.accepted_suite.suite_id, "accepted suite id");
  equal(manifest.parameter_snapshot_id, record.accepted_suite.parameter_snapshot_id, "accepted parameter snapshot id");
  equal(manifest.parameter_snapshot, record.accepted_suite.parameters, "accepted suite parameters");
  equal(metrics.dataset_id, record.accepted_evidence.dataset_id, "accepted dataset id");
  equal(metrics.partition, record.accepted_evidence.partition, "accepted dataset use");
  equal(sourceManifest.history, record.accepted_evidence.history, "accepted source history");
  equal(metrics.outcome_version, record.accepted_evidence.outcome_version, "accepted outcome version");
  equal(metrics.observation_window, record.accepted_evidence.observation_window, "accepted observation window");
  equal(metrics.outcome_as_of, record.accepted_evidence.outcome_as_of, "accepted outcome cutoff");
  equal(fileDigest(join(replay, "scenario-metrics.jsonl")), record.accepted_evidence.scenario_metrics_sha256, "accepted scenario metrics bytes");
  equal(fileDigest(join(replay, "verdicts.jsonl")), record.accepted_evidence.verdicts_sha256, "accepted verdict bytes");
  const detected = new Set(metrics.detected_fraud_case_ids as string[]);
  for (const protectedCase of record.protected_cases) {
    if (!detected.has(protectedCase.case_id)) throw new ProtectedCorpusError(`historical replay did not detect protected case ${protectedCase.case_id}`);
    const outcome = outcomes.cases.find(row => row.case_id === protectedCase.case_id);
    if (outcome?.outcome !== "fraud" || outcome.available_at > outcomes.as_of) {
      throw new ProtectedCorpusError(`historical outcome evidence is not mature fraud for ${protectedCase.case_id}`);
    }
    const actualEvents = scenarios.filter(row => row.case_id === protectedCase.case_id).map(row => String(row.event_id)).sort();
    equal(actualEvents, protectedCase.source_event_ids, `source event evidence for ${protectedCase.case_id}`);
    const eventSet = new Set(actualEvents);
    const actualRules = [...new Set(verdicts.filter(row => eventSet.has(String(row.event_id)) && row.verdict === "alert")
      .map(row => String(row.rule_id)))].sort();
    equal(actualRules, protectedCase.detected_by_rule_ids, `detected rule evidence for ${protectedCase.case_id}`);
  }
}

function parseRecord(value: unknown): ProtectedCorpusRecord {
  if (!isRecord(value)) throw new ProtectedCorpusError("protected corpus must be a JSON object");
  if (value.schema_version !== SCHEMA_VERSION) throw new ProtectedCorpusError("unsupported protected corpus schema version");
  if (typeof value.corpus_id !== "string" || value.corpus_id === "") throw new ProtectedCorpusError("protected corpus id must be non-empty");
  if (!Number.isSafeInteger(value.version) || Number(value.version) < 1) throw new ProtectedCorpusError("protected corpus version must be a positive integer");
  if (value.use !== "known_regression") throw new ProtectedCorpusError("protected corpus use must be known_regression");
  if (!isRecord(value.source) || typeof value.source.directory !== "string" || !isStringRecord(value.source.input_digests)) {
    throw new ProtectedCorpusError("protected corpus source evidence is invalid");
  }
  if (!isRecord(value.accepted_suite) || !isString(value.accepted_suite.run_id) || !isString(value.accepted_suite.suite_id)
    || !isString(value.accepted_suite.parameter_snapshot_id) || !isNumberRecord(value.accepted_suite.parameters)) {
    throw new ProtectedCorpusError("protected corpus accepted suite evidence is invalid");
  }
  if (!isRecord(value.accepted_evidence) || !isString(value.accepted_evidence.dataset_id) || !isString(value.accepted_evidence.partition)
    || !isRecord(value.accepted_evidence.history) || !isString(value.accepted_evidence.outcome_version)
    || !isWindow(value.accepted_evidence.observation_window) || !isString(value.accepted_evidence.outcome_as_of)
    || !isString(value.accepted_evidence.scenario_metrics_sha256) || !isString(value.accepted_evidence.verdicts_sha256)) {
    throw new ProtectedCorpusError("protected corpus accepted detection evidence is invalid");
  }
  if (!Array.isArray(value.protected_cases) || value.protected_cases.length === 0) throw new ProtectedCorpusError("protected corpus cases must be non-empty");
  const cases = value.protected_cases.map(row => {
    if (!isRecord(row) || !isString(row.case_id) || row.outcome !== "fraud" || row.detected !== true
      || !isStringArray(row.detected_by_rule_ids) || row.detected_by_rule_ids.length === 0
      || !isStringArray(row.source_event_ids) || row.source_event_ids.length === 0) {
      throw new ProtectedCorpusError("protected corpus case evidence is invalid");
    }
    return row as ProtectedCaseRecord;
  });
  const ids = cases.map(row => row.case_id);
  if (new Set(ids).size !== ids.length || canonicalJson(ids) !== canonicalJson([...ids].sort())) {
    throw new ProtectedCorpusError("protected corpus case ids must be unique and sorted");
  }
  const version = Number(value.version);
  if (version === 1 && value.previous !== null) throw new ProtectedCorpusError("first corpus version cannot name a predecessor");
  if (version > 1 && (!isRecord(value.previous) || value.previous.corpus_id !== value.corpus_id
    || value.previous.version !== version - 1 || !isString(value.previous.sha256))) {
    throw new ProtectedCorpusError("protected corpus predecessor evidence is invalid");
  }
  return value as unknown as ProtectedCorpusRecord;
}

function aggregateMetrics(dir: string): Record<string, Json> {
  const row = (readJsonl(join(dir, "scenario-metrics.jsonl")) as Record<string, Json>[]).find(value => value.rule_id === null);
  if (row === undefined) throw new ProtectedCorpusError("aggregate scenario metrics are missing");
  return row;
}

function readSingleJson(path: string): Record<string, Json> {
  const rows = readJsonl(path) as Record<string, Json>[];
  if (rows.length !== 1) throw new ProtectedCorpusError(`${path} must contain exactly one JSON row`);
  return rows[0]!;
}

function withinWindow(row: { from: string; to: string }, window: { from: string; to: string }): boolean {
  return row.from.slice(0, 10) >= window.from && row.to.slice(0, 10) <= window.to;
}

function portableDigest(path: string): string {
  return digest(Buffer.from(readFileSync(path, "utf8").replace(/\r\n/g, "\n")));
}

function fileDigest(path: string): string { return digest(readFileSync(path)); }
function digest(bytes: string | Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function equal(actual: unknown, expected: unknown, what: string): void {
  if (canonicalJson(actual as Json) !== canonicalJson(expected as Json)) throw new ProtectedCorpusError(`${what} does not match replayed evidence`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isString(value: unknown): value is string { return typeof value === "string" && value !== ""; }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
function isStringRecord(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every(isString); }
function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(item => typeof item === "number" && Number.isFinite(item));
}
function isWindow(value: unknown): value is { from: string; to: string } {
  return isRecord(value) && isString(value.from) && isString(value.to);
}
