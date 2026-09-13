// One pinned experiment over materialized history; eligibility is not acceptance.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonl, type Json } from "../ledger.ts";
import type { YamlValue } from "../yaml.ts";
import { canonicalJson, readManifest, runCase, RunError, type Manifest } from "./run.ts";
import {
  assessProtectedCases,
  assessProtectedInputs,
  listRunInputFiles,
  summarizeProtectedCorpus,
  verifyProtectedCorpus,
  type ProtectedCaseCheck,
  type ProtectedCorpusSummary,
  type VerifiedProtectedCorpus,
} from "./protected-corpus.ts";

export { advanceProtectedCorpusVersion } from "./protected-corpus.ts";
export type { ProtectedCorpusRecord } from "./protected-corpus.ts";

export { createValidation, openValidation } from "../reserved-validation.ts";
export type { ValidationResult } from "../reserved-validation.ts";

export type ComparisonTarget = "fraud_cases" | "legitimate_merchants";
export type ComparisonRequest = { target: ComparisonTarget; proposal: YamlValue;
  supplied_runs?: { incumbent: string; candidate: string }; protected_corpus_file?: string };
export type ComparisonResult = {
  comparison_id: string; incumbent_run_id: string | null; candidate_run_id: string | null;
  incumbent_suite_id: string | null; candidate_suite_id: string | null; proposal_id: string;
  data_scope: { dataset_id: string; partition: string; metric_version: string; history: NonNullable<Manifest["history"]> | null;
    outcome_version: string; observation_window: { from: string; to: string }; outcome_as_of: string; stories_enabled: boolean } | null;
  eligibility: "eligible" | "ineligible"; reason: string; detail: string | null;
  target: ComparisonTarget; scope: "aggregate"; segment: null;
  retained_fraud_case_ids: string[] | null; lost_fraud_case_ids: string[] | null; new_fraud_case_ids: string[] | null;
  legitimate_merchants: { denominator: number; incumbent: string[]; candidate: string[]; incumbent_count: number; candidate_count: number } | null;
  unknown_case_ids: string[] | null; immature_case_ids: string[] | null; excluded_merchant_ids: string[] | null;
  fraud_case_denominator: number | null;
  monetary_assessment: { status: "unperformed"; assessed_count: 0; failure_count: null };
  reserved_validation: "not_assessed"; experimental_acceptance: "not_assessed";
  input_provenance?: { evaluation_input_digests: Record<string, string>; protected_corpus_sha256: string | null };
  protected_corpus?: ProtectedCorpusSummary | null;
  protected_cases?: ProtectedCaseCheck | null;
};

/** Replays the unchanged incumbent and an admitted proposal on the same history. */
export function compareRuns(caseDir: string, outDir: string, request: ComparisonRequest): ComparisonResult {
  if (readdirSync(outDir).length) throw new Error("comparison output directory must be empty");
  const pinned = structuredClone(request);
  if (!["fraud_cases", "legitimate_merchants"].includes(pinned.target)) throw new Error("invalid_comparison_target");
  // Materialize only the run seam's inputs once, then replay both arms from these
  // exact bytes. Later source changes cannot silently change one arm of the pair.
  const inputs = join(outDir, "inputs");
  mkdirSync(join(inputs, "suite/rules"), { recursive: true });
  const files = listRunInputFiles(caseDir);
  const input_digests: Record<string, string> = {};
  for (const file of files) {
    const bytes = readFileSync(join(caseDir, file));
    input_digests[file] = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(inputs, file), bytes);
  }
  const manifest = readManifest(JSON.parse(readFileSync(join(inputs, "manifest.json"), "utf8")));
  const supplied = pinned.supplied_runs === undefined ? null : {
    incumbent: captureEvidence(pinned.supplied_runs.incumbent), candidate: captureEvidence(pinned.supplied_runs.candidate),
  };
  const evidenceDigests = (files: Map<string, Buffer | null> | null) => files === null ? null
    : Object.fromEntries([...files].map(([name, bytes]) => [name, bytes === null ? null : createHash("sha256").update(bytes).digest("hex")]));
  let protectedCorpusSha256: string | null = null;
  if (pinned.protected_corpus_file !== undefined) {
    try { protectedCorpusSha256 = createHash("sha256").update(readFileSync(pinned.protected_corpus_file)).digest("hex"); }
    catch { /* The named rejection below retains null when the corpus file itself cannot be read. */ }
  }
  const plan = { target: pinned.target, proposal: pinned.proposal, input_digests, metric_version: "case-merchant-counts-v1",
    ...(pinned.protected_corpus_file === undefined ? {} : { protected_corpus_sha256: protectedCorpusSha256 }),
    supplied_evidence_digests: supplied === null ? null : { incumbent: evidenceDigests(supplied.incumbent), candidate: evidenceDigests(supplied.candidate) } };
  const comparison_id = createHash("sha256").update(canonicalJson(plan as unknown as Json)).digest("hex");
  writeFileSync(join(outDir, "comparison-plan.json"), canonicalJson({ ...plan, comparison_id } as unknown as Json) + "\n");
  const incumbentDir = join(outDir, "incumbent"), candidateDir = join(outDir, "candidate");
  mkdirSync(incumbentDir); mkdirSync(candidateDir);
  const outcomes = manifest.authored_outcomes;
  const result: ComparisonResult = {
    comparison_id, incumbent_run_id: null, candidate_run_id: null,
    incumbent_suite_id: null, candidate_suite_id: null,
    proposal_id: createHash("sha256").update(canonicalJson(pinned.proposal)).digest("hex"),
    data_scope: outcomes === undefined ? null : { dataset_id: outcomes.dataset_id, partition: outcomes.partition,
      metric_version: plan.metric_version, history: manifest.history ?? null, outcome_version: outcomes.version,
      observation_window: outcomes.observation_window, outcome_as_of: outcomes.as_of, stories_enabled: outcomes.stories_enabled },
    unknown_case_ids: null, immature_case_ids: null, excluded_merchant_ids: null, fraud_case_denominator: null,
    monetary_assessment: { status: "unperformed", assessed_count: 0, failure_count: null },
    eligibility: "ineligible", reason: "missing_required_assessment", detail: null,
    target: pinned.target, scope: "aggregate", segment: null,
    retained_fraud_case_ids: null, lost_fraud_case_ids: null, new_fraud_case_ids: null, legitimate_merchants: null,
    reserved_validation: "not_assessed", experimental_acceptance: "not_assessed",
  };
  if (pinned.protected_corpus_file !== undefined) Object.assign(result, {
    input_provenance: { evaluation_input_digests: input_digests, protected_corpus_sha256: protectedCorpusSha256 },
    protected_corpus: null,
    protected_cases: null,
  });
  const writeResult = (reason: string, detail: string | null = null) => {
    result.reason = reason; result.detail = detail;
    result.eligibility = reason === "strict_target_improvement" ? "eligible" : "ineligible";
    writeFileSync(join(outDir, "comparison.jsonl"), canonicalJson(result) + "\n");
    return result;
  };
  let protectedCorpus: VerifiedProtectedCorpus | null = null;
  if (pinned.protected_corpus_file !== undefined) {
    try {
      protectedCorpus = verifyProtectedCorpus(pinned.protected_corpus_file);
      result.protected_corpus = summarizeProtectedCorpus(protectedCorpus);
    } catch (error) {
      return writeResult("protected_corpus_rejected", error instanceof Error ? error.message : String(error));
    }
  }
  if (protectedCorpus !== null && manifest.authored_outcomes !== undefined) {
    const preflight = assessProtectedInputs(protectedCorpus, { manifest, inputs_directory: inputs, input_digests });
    if (preflight.missing_count) {
      result.protected_cases = preflight;
      return writeResult("missing_protected_cases", preflight.missing_case_ids.join(","));
    }
    if (preflight.unavailable_count) {
      result.protected_cases = preflight;
      return writeResult("unavailable_protected_cases", preflight.unavailable_case_ids.join(","));
    }
  }
  for (const [arm, dir] of [["incumbent", incumbentDir], ["candidate", candidateDir]] as const) {
    try {
      const run = runCase(inputs, dir, { requireAdmittedSuite: true, ...(arm === "candidate" ? { proposal: pinned.proposal } : {}) });
      result[`${arm}_run_id`] = run.run_id;
      result[`${arm}_suite_id`] = run.suite_id!;
    } catch (error) {
      if (!(error instanceof RunError)) throw error;
      return writeResult(`${arm}_evaluation_rejected`, error.message);
    }
  }
  if (supplied !== null) {
    for (const [arm, expected] of [["incumbent", incumbentDir], ["candidate", candidateDir]] as const) {
      const files = supplied[arm];
      let reason: string | undefined;
      const expectedFiles = readdirSync(expected).sort();
      if (files === null) reason = `missing_required_evidence:${arm}`;
      else {
        for (const file of expectedFiles) {
          if (!files.has(file)) { reason = `missing_required_evidence:${arm}:${file}`; break; }
          if (!files.get(file)?.equals(readFileSync(join(expected, file)))) {
            reason = `incompatible_paired_artifact:${arm}:${file}`; break;
          }
        }
        if (reason === undefined && [...files.keys()].sort().join("\n") !== expectedFiles.join("\n")) reason = `incompatible_paired_artifact:${arm}:file_set`;
      }
      if (reason !== undefined) return writeResult(reason);
    }
  }
  if (manifest.authored_outcomes === undefined) return writeResult("missing_required_assessment");
  const unavailableArm = (["incumbent", "candidate"] as const).find(arm =>
    readJsonl(join(arm === "incumbent" ? incumbentDir : candidateDir, "verdicts.jsonl"))
      .some(row => (row as { verdict: string }).verdict === "unavailable"));
  // Protected-corpus comparisons inspect the paired runs first so they can name
  // an unavailable protected obligation. Ordinary comparisons must stop before
  // publishing count fields that could be mistaken for measured improvement.
  if (protectedCorpus === null && unavailableArm !== undefined) return writeResult(`unavailable_evaluation:${unavailableArm}`);
  const metrics = (dir: string) => readJsonl(join(dir, "scenario-metrics.jsonl"))[0] as { [key: string]: Json };
  const before = metrics(incumbentDir), after = metrics(candidateDir);
  result.unknown_case_ids = before.unknown_case_ids as string[];
  result.immature_case_ids = before.immature_case_ids as string[];
  result.excluded_merchant_ids = before.excluded_merchant_ids as string[];
  result.fraud_case_denominator = Number(before.fraud_case_denominator);
  if ([before, after].some(m => (m.assessment as { status: string }).status !== "performed")) return writeResult("unperformed_required_assessment");
  const previous = before.detected_fraud_case_ids as string[], next = after.detected_fraud_case_ids as string[];
  const oldFlags = before.incorrectly_flagged_legitimate_merchant_ids as string[], newFlags = after.incorrectly_flagged_legitimate_merchant_ids as string[];
  const previousIds = new Set(previous), nextIds = new Set(next);
  const retained = previous.filter(id => nextIds.has(id));
  const lost = previous.filter(id => !nextIds.has(id));
  const added = next.filter(id => !previousIds.has(id));
  const improved = pinned.target === "fraud_cases" ? added.length > 0 : newFlags.length < oldFlags.length;
  const reason = lost.length ? "lost_incumbent_fraud_case" : newFlags.length > oldFlags.length ? "increased_legitimate_merchant_flags"
    : !improved ? "no_strict_target_improvement" : "strict_target_improvement";
  Object.assign(result, {
    retained_fraud_case_ids: retained, lost_fraud_case_ids: lost, new_fraud_case_ids: added,
    legitimate_merchants: { denominator: Number(before.legitimate_merchant_denominator), incumbent: oldFlags, candidate: newFlags,
      incumbent_count: oldFlags.length, candidate_count: newFlags.length },
  });
  if (protectedCorpus !== null) {
    result.protected_cases = assessProtectedCases(protectedCorpus, {
      manifest,
      inputs_directory: inputs,
      input_digests,
      incumbent_directory: incumbentDir,
      candidate_directory: candidateDir,
      incumbent_run_id: result.incumbent_run_id!,
      incumbent_suite_id: result.incumbent_suite_id!,
      candidate_run_id: result.candidate_run_id!,
      candidate_suite_id: result.candidate_suite_id!,
    });
    if (result.protected_cases.missing_count) return writeResult("missing_protected_cases", result.protected_cases.missing_case_ids.join(","));
    if (result.protected_cases.unavailable_count) return writeResult("unavailable_protected_cases", result.protected_cases.unavailable_case_ids.join(","));
    if (result.protected_cases.incumbent_missed_count) return writeResult("incumbent_missed_protected_cases", result.protected_cases.incumbent_missed_case_ids.join(","));
    if (result.protected_cases.lost_count) return writeResult("lost_protected_cases", result.protected_cases.lost_case_ids.join(","));
  }
  if (unavailableArm !== undefined) return writeResult(`unavailable_evaluation:${unavailableArm}`);
  return writeResult(reason);
}

function captureEvidence(dir: string): Map<string, Buffer | null> | null {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return null;
  return new Map(readdirSync(dir).sort().map(name => {
    const path = join(dir, name);
    return [name, lstatSync(path).isFile() ? readFileSync(path) : null];
  }));
}
