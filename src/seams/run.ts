// The run seam: a suite folder, a scenario set, and a manifest in; a ledger
// folder out. Inputs are read and validated, hashes are derived, rules are
// evaluated, and ledger tables are written without fabricated event fields.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { directoryBytes, preflightHistory, enforceResource, resourceLimits, resourceCheckpoint, checkActiveResources, withResources, WorkloadResourceError, type ResourceOptions } from "../workload-resources.ts";
import { isMapping, parseYaml, type YamlValue } from "../yaml.ts";
import { DailyTotalsError, readDailyTotals, replayDailyTotals, utcDay, type DailySnapshot, type DailyTotals } from "../daily-totals.ts";
import { MerchantReferenceError, resolveReference, attachMerchantReference } from "../merchant-reference.ts";
import { assessReferenceHistory } from "../reference-assessments.ts";
import { assessScenarioOutcomes, outcomeEvidence, readAuthoredOutcomes, validateOutcomeBindings, OutcomeError, type AuthoredOutcomes } from "../scenario-outcomes.ts";
import { applyProposal } from "./proposal.ts";
import {
  COMPARABILITY_GATES,
  DAILY_EVENT_SCENARIO_COLUMNS,
  EVENT_SCENARIO_COLUMNS,
  FIRE_ON_VALUES,
  RUN_TYPES,
  SELECTED_EVENT_SCENARIO_COLUMNS,
  TIERS,
  readJsonl,
  type AlertScenarioRow,
  type AlertCaseRow,
  type AlertMetricsRow,
  type AlertVerdictRow,
  type EventScenarioRow,
  type EventVerdictRow,
  type Comparability,
  type FireOn,
  type ScenarioLedgerTable,
  type Json,
  type HistoryProvenance,
  type ManifestRow,
  type MetricsRow,
  type ProposalAttemptRow,
  type ProposalLedgerTable,
  type RuleMetricRow,
  type RulesInRunRow,
  type RunType,
  type SuiteProvenance,
  type Tier,
  type WorkloadBounds,
} from "../ledger.ts";
import {
  serializeAlertRowLoadResult,
  type AlertRowLoadResult,
  type AlertScenario,
} from "../alert-rows.ts";
import {
  RuleError,
  evaluateRule,
  parameterSnapshot,
  readRule,
  readRuleRow,
  referencedFeatureNames,
  validateRuleSuite,
  type Condition,
  type Rule,
  type RuleRow,
} from "../rules.ts";

export const SUITE_DIR = "suite";
export const RULES_DIR = "rules";
export const CATALOG_FILE = "catalog.yaml";
export const TENANT_FILE = "tenant.yaml";
export const SCENARIOS_FILE = "scenarios.jsonl";
export const MANIFEST_FILE = "manifest.json";
export const ALERTS_FILE = "alerts.csv";
export const RESOLUTION_MAPPING_FILE = "resolution-mapping.yaml";

export class RunError extends Error {}

export const SUPPORTED_WORKLOAD_LIMITS: WorkloadBounds = {
  max_events: 250000,
  max_rules: 64,
  max_results: 8000000,
};

/** The input manifest: one run type against one goal, everything else pinned. */
export type Manifest = {
  run_type: RunType;
  goal: string;
  tenant: string;
  tier: Tier;
  pinned_baseline: string;
  seed: number;
  fp_ceiling?: { alpha: number; delta: number };
  split_ratio?: number;
  similarity_threshold?: number;
  near_zero_threshold?: number;
  admitted_rule_ids?: string[];
  history?: {
    source_id: string;
    schema_version: string;
    snapshot_version: string;
  };
  workload?: WorkloadBounds;
  daily_totals?: DailyTotals;
  authored_outcomes?: AuthoredOutcomes;
  comparability: Comparability;
};

export type AlertRunResult = {
  manifest: ManifestRow;
  headline: string;
};

export function runCase(
  caseDir: string,
  outDir: string,
  options: { requireAdmittedSuite?: boolean; proposal?: YamlValue; proposalBytes?: Uint8Array; resources?: ResourceOptions } = {},
): ManifestRow {
  const limits = resourceLimits(options.resources), started = performance.now();
  resourceCheckpoint(limits, started);
  // Resource rejection never publishes a partially serialized run. Non-resource
  // admission failures retain their existing explicit rejection artifacts.
  if (options.proposal !== undefined && readdirSync(outDir).length !== 0) throw new RunError("proposal output directory must be empty and separate from incumbent inputs");
  const stage = mkdtempSync(join(tmpdir(), "fwh-bounded-run-"));
  const publish = () => {
    // Overlay only regular files with matching names; all other destination
    // evidence is retained and counts against the complete output budget.
    let prospectiveBytes = (existsSync(outDir) ? directoryBytes(outDir) : 0) + directoryBytes(stage);
    for (const name of readdirSync(stage)) {
      const target = join(outDir, name);
      if (!existsSync(target)) continue;
      const prior = lstatSync(target);
      if (!prior.isFile()) throw new WorkloadResourceError("workload_path_denied: output member is not a regular file");
      prospectiveBytes -= prior.size;
    }
    enforceResource("output_bytes", prospectiveBytes, limits.max_output_bytes);
    resourceCheckpoint(limits, started);
    for (const name of readdirSync(stage)) copyFileSync(join(stage, name), join(outDir, name));
  };
  try {
    let result: ManifestRow;
    try { result = withResources(limits, () => runCaseInner(caseDir, stage, options)); }
    catch (error) { if (!(error instanceof WorkloadResourceError)) publish(); throw error; }
    publish();
    return result;
  } catch (error) {
    if (error instanceof WorkloadResourceError) throw new RunError(error.message, { cause: error });
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

function runCaseInner(
  caseDir: string,
  outDir: string,
  options: { requireAdmittedSuite?: boolean; proposal?: YamlValue; proposalBytes?: Uint8Array; resources?: ResourceOptions },
): ManifestRow {
  const resources = resourceLimits(options.resources);
  enforceResource("input_bytes", directoryBytes(caseDir), resources.max_input_bytes);
  const manifestText = readFileSync(join(caseDir, MANIFEST_FILE), "utf8");
  checkNumberLiterals(manifestText);
  const manifestJson = JSON.parse(manifestText) as Json;
  preflightHistory(caseDir, resources);
  const manifest = readManifest(manifestJson);
  if (options.requireAdmittedSuite === true && manifest.admitted_rule_ids === undefined) {
    throw new RunError(`${MANIFEST_FILE}: selected-suite command requires admitted_rule_ids`);
  }
  const tenant = readYamlMapping(join(caseDir, SUITE_DIR, TENANT_FILE));
  const catalog = readYamlMapping(join(caseDir, SUITE_DIR, CATALOG_FILE));
  const ruleFiles = listRuleFiles(caseDir);
  const scenarioDocs = readJsonl(join(caseDir, SCENARIOS_FILE));

  if (tenant.tenant !== manifest.tenant) throw new RunError(`${TENANT_FILE} is for ${String(tenant.tenant)}, manifest pins ${manifest.tenant}`);
  if (tenant.currency !== manifest.comparability.currency) throw new RunError(`${TENANT_FILE} currency ${String(tenant.currency)} differs from the manifest comparability currency ${manifest.comparability.currency}`);
  const fireOn = oneOf(tenant.fire_on, FIRE_ON_VALUES, `${TENANT_FILE}: fire_on`);
  const availableRules = loadRules(caseDir, ruleFiles);
  let rules = selectAdmittedRules(availableRules, manifest.admitted_rule_ids);
  let proposalAttempt: ProposalAttemptRow | undefined;
  let sourceTranslation: Buffer | undefined;
  let proposalSourceSha256: string | undefined;
  if (options.proposal === undefined && options.proposalBytes !== undefined) {
    throw new RunError("proposal bytes require a parsed proposal");
  }
  if (options.proposal !== undefined) {
    if (readdirSync(outDir).length !== 0) throw new RunError("proposal output directory must be empty and separate from incumbent inputs");
    if (existsSync(join(caseDir, "admission.json"))) sourceTranslation = readFileSync(join(caseDir, "admission.json"));
    const admission = applyProposal(options.proposal, { rules, catalog, manifest });
    // Include every loaded rule, since even unselected files participate in input
    // admission. This context identifies the inputs, not an executed candidate.
    const inputDigests = Object.fromEntries([
      ...ruleFiles, posix.join(SUITE_DIR, CATALOG_FILE), posix.join(SUITE_DIR, TENANT_FILE), SCENARIOS_FILE,
    ].sort().map(path => [path, digestPortableTextFile(join(caseDir, ...path.split("/")))]));
    if (sourceTranslation !== undefined) inputDigests["admission.json"] = createHash("sha256").update(sourceTranslation).digest("hex");
    if (options.proposalBytes !== undefined) {
      let suppliedProposal: YamlValue;
      try {
        suppliedProposal = parseYaml(Buffer.from(options.proposalBytes).toString("utf8"));
      } catch (error) {
        throw new RunError(`proposal bytes do not encode the evaluated proposal: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (canonicalJson(suppliedProposal) !== canonicalJson(options.proposal)) {
        throw new RunError("proposal bytes do not encode the evaluated proposal");
      }
      proposalSourceSha256 = createHash("sha256").update(options.proposalBytes).digest("hex");
      inputDigests["supplied-proposal.raw"] = proposalSourceSha256;
    }
    const inputContext = { manifest: manifestJson, input_digests: inputDigests };
    proposalAttempt = {
      input_context: { identity_kind: "input_context", id: sha256(canonicalJson(inputContext)), ...inputContext },
      proposal_id: sha256(canonicalJson(options.proposal)), proposal: options.proposal,
      state: admission.state, reasons: admission.reasons, experimental_acceptance: "not_assessed",
      incumbent_suite_id: suiteIdentity(rules), candidate_suite_id: null, candidate_run_id: null,
      incumbent_run_id: null,
      source_translation: sourceTranslation === undefined ? null : {
        artifact: "source-translation.json", verification: "supplied_artifact",
        sha256: createHash("sha256").update(sourceTranslation).digest("hex"),
      },
    };
    if (admission.rules === null) {
      writeLedgerTable(outDir, "proposal-attempts.jsonl", [proposalAttempt]);
      if (sourceTranslation !== undefined) writeFileSync(join(outDir, "source-translation.json"), sourceTranslation);
      throw new RunError(`proposal rejected: ${admission.reasons.join("; ")}`);
    }
    rules = admission.rules;
  }
  const ruleFileById = new Map(availableRules.map((rule, index) => [rule.id, ruleFiles[index]!]));
  const admittedRuleFiles = manifest.admitted_rule_ids === undefined
    ? ruleFiles
    : rules.map((rule) => ruleFileById.get(rule.id)!);
  validateCatalogCoverage(rules, catalog);
  for (const rule of rules) {
    if (rule.applies_to.tenant !== tenant.tenant) {
      throw new RunError(`${rule.id}: applies_to tenant ${rule.applies_to.tenant} differs from ${TENANT_FILE} tenant ${String(tenant.tenant)}`);
    }
  }
  if (manifest.admitted_rule_ids !== undefined) {
    validateSelectedWorkload(manifest, scenarioDocs.length, rules.length);
  }
  const selectedSuiteRun = manifest.admitted_rule_ids !== undefined;
  let scenarios = scenarioDocs.map((doc, index) =>
    readScenario(doc, `${SCENARIOS_FILE}:${index + 1}`, selectedSuiteRun, manifest.daily_totals !== undefined)
  );
  if (selectedSuiteRun) {
    const eventIds = new Set<string>();
    for (const [index, { ledger: scenario }] of scenarios.entries()) {
      if (eventIds.has(scenario.event_id)) {
        throw new RunError(`${SCENARIOS_FILE}:${index + 1}: duplicate event id ${scenario.event_id}`);
      }
      eventIds.add(scenario.event_id);
    }
  }
  const parameters = parameterSnapshot(rules);
  if (manifest.authored_outcomes) {
    try { validateOutcomeBindings(manifest.authored_outcomes, scenarios.map(s => s.ledger)); }
    catch (error) { if (error instanceof OutcomeError) throw new RunError(error.message, { cause: error }); throw error; }
    if (!manifest.authored_outcomes.stories_enabled) {
      for (const s of scenarios) if (s.ledger.label === "fraud") s.ledger.label = "unknown";
    }
  }
  const suite: SuiteProvenance | undefined = selectedSuiteRun ? {
    suite_id: suiteIdentity(rules),
    parameter_snapshot_id: sha256(canonicalJson(parameters)).slice(0, 16),
  } : undefined;
  const history = selectedSuiteRun ? selectedHistoryProvenance(manifest) : undefined;

  const row: ManifestRow = {
    run_id: runId(caseDir, manifestJson, admittedRuleFiles),
    ...manifest,
    fire_on: fireOn,
    rule_set_hash: suite === undefined ? digestOfListing(caseDir, ruleFiles) : suite.suite_id,
    ...(selectedSuiteRun ? {
      grain: "run" as const,
      ...suite!,
    } : {}),
    scenario_set_hash: digestPortableTextFile(join(caseDir, SCENARIOS_FILE)).slice(0, 16),
    parameter_snapshot: parameters,
  };
  if (proposalAttempt !== undefined) {
    proposalAttempt.incumbent_run_id = row.run_id;
    proposalAttempt.candidate_suite_id = suite!.suite_id;
    row.run_id = sha256(canonicalJson({ incumbent_run_id: row.run_id, proposal_id: proposalAttempt.proposal_id!,
      suite_id: suite!.suite_id, source_translation: proposalAttempt.source_translation!,
      ...(proposalSourceSha256 === undefined ? {} : { proposal_source_sha256: proposalSourceSha256 }) })).slice(0, 16);
    proposalAttempt.candidate_run_id = row.run_id;
  }
  const trace = selectedSuiteRun ? {
    ...history!,
    ...suite!,
  } : undefined;
  let daily;
  let referenceAssessments;
  if (manifest.daily_totals !== undefined) {
    try {
      const reference = manifest.daily_totals.reference === undefined ? undefined
        : resolveReference(manifest.daily_totals.reference, rules, catalog);
      daily = replayDailyTotals(manifest.daily_totals, scenarios.map(s => s.ledger), manifest.comparability.observation_window, {
        tenant: manifest.tenant, currency: manifest.comparability.currency,
        maxMerchantDays: manifest.workload!.max_events, catalog,
        ...(reference === undefined ? {} : { referenceWindowDays: reference.window_days }),
      });
      if (reference !== undefined) {
        attachMerchantReference(daily, reference);
        referenceAssessments = assessReferenceHistory(daily, scenarios.map(s => s.ledger));
      }
    } catch (error) {
      if (error instanceof DailyTotalsError || error instanceof MerchantReferenceError) throw new RunError(error.message, { cause: error });
      throw error;
    }
    const inputRows = new Map(scenarios.map(s => [s.ledger.event_id, s.ruleRow]));
    const snapshots = new Map(daily.snapshots.map(s => [s.snapshot_id, s]));
    scenarios = daily.scenarios.map(ledger => ({ ledger,
      ruleRow: readRuleRow({ ...inputRows.get(ledger.event_id)!, fields: ledger.fields }, ledger.event_id),
      snapshot: snapshots.get(JSON.stringify([ledger.merchant_id, utcDay(ledger.ts)]))!,
    }));
  }
  const definitionId = daily === undefined ? undefined : sha256(canonicalJson(daily.definition)).slice(0, 16);
  const verdicts = evaluateScenarios(row.run_id, scenarios, rules, fireOn, trace, manifest.daily_totals?.feature, definitionId);
  const alertedEvents = fireOn === "alert" ? new Set(verdicts.filter((verdict) => verdict.fired === true).map((verdict) => verdict.event_id)) : null;
  const metrics: MetricsRow = {
    run_id: row.run_id,
    headline_label: manifest.authored_outcomes ? "scenario performance" : selectedSuiteRun ? "event and alert counts" : "proxy",
    net_value_saved: selectedSuiteRun ? null : 0,
    gross_caught: selectedSuiteRun ? null : 0,
    gross_leaked: null,
    gross_attempted_fraud: selectedSuiteRun ? null : 0,
    prevented_fraud: selectedSuiteRun ? null : 0,
    executed_fraud_value: selectedSuiteRun ? null : 0,
    gross_actual_loss: selectedSuiteRun ? null : 0,
    recovered_amount: selectedSuiteRun ? null : 0,
    intervention_cost: selectedSuiteRun ? null : 0,
    legitimate_value_declined: selectedSuiteRun ? null : 0,
    events: scenarios.length,
    alerts: alertedEvents?.size ?? null,
    miss_rate: null,
    false_positive_rate: null,
    coverage: null,
    days_to_alert_median: null,
    ...(selectedSuiteRun ? { scope: "aggregate" as const, segment: null } : {}),
  };
  writeLedgerTable(outDir, "manifest.jsonl", [row]);
  writeLedgerTable(outDir, "scenarios.jsonl", manifest.authored_outcomes?.stories_enabled === false
    ? scenarioDocs.map(doc => isMapping(doc) && doc.label === "fraud" ? { ...doc, label: "unknown" } : doc) : scenarioDocs);
  writeLedgerTable(outDir, "cases.jsonl", []);
  writeLedgerTable(outDir, "verdicts.jsonl", verdicts);
  writeLedgerTable(outDir, "metrics.jsonl", [metrics]);
  if (manifest.authored_outcomes !== undefined) {
    const provenance = { run_id: row.run_id, ...trace!, source_history_hash: row.scenario_set_hash,
      seed: manifest.seed, authored_outcomes_hash: sha256(canonicalJson(manifest.authored_outcomes as unknown as Json)) };
    writeLedgerTable(outDir, "authored-outcomes.jsonl", outcomeEvidence(manifest.authored_outcomes).map(m => ({
      ...m as object, ...provenance,
    }) as Json));
    writeLedgerTable(outDir, "scenario-metrics.jsonl", assessScenarioOutcomes(manifest.authored_outcomes,
      scenarios.map(s => s.ledger), verdicts, rules.map(r => r.id), fireOn).map(m => ({
        ...m as object, ...provenance,
      }) as Json));
  }
  writeLedgerTable(outDir, "change-log.jsonl", []);
  if (selectedSuiteRun) {
    writeLedgerTable(outDir, "rules-in-run.jsonl", rulesInRunRows(row.run_id, rules, suite!));
  }
  if (daily !== undefined) {
    const provenance = { run_id: row.run_id, ...trace!, source_history_hash: row.scenario_set_hash,
      feature_definition_id: definitionId!, day_boundary: manifest.daily_totals!.day_boundary };
    writeLedgerTable(outDir, "feature-snapshots.jsonl", daily.snapshots.map(s => ({ ...s, ...provenance, grain: "feature_snapshot" })));
    writeLedgerTable(outDir, "merchant-days.jsonl", daily.observations.map(o => ({ ...o, ...provenance })));
    writeLedgerTable(outDir, "feature-definitions.jsonl", [{ ...daily.definition, ...provenance, grain: "feature_definition" }]);
    if (referenceAssessments !== undefined) {
      writeLedgerTable(outDir, "reference-assessments.jsonl", referenceAssessments.map(a => ({ ...a, ...provenance })));
    }
  }
  if (proposalAttempt !== undefined) {
    writeLedgerTable(outDir, "proposal-attempts.jsonl", [proposalAttempt]);
    writeFileSync(join(outDir, "candidate-suite.json"), canonicalJson({ suite_id: suite!.suite_id, tenant, catalog, rules }) + "\n");
    if (sourceTranslation !== undefined) writeFileSync(join(outDir, "source-translation.json"), sourceTranslation);
  }
  return row;
}

function suiteIdentity(rules: readonly Rule[]): string {
  const canonicalRules = [...rules].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  return sha256(canonicalJson(canonicalRules as unknown as Json)).slice(0, 16);
}

function selectedHistoryProvenance(manifest: Manifest): HistoryProvenance {
  if (manifest.history === undefined) throw new RunError(`${MANIFEST_FILE}: selected-suite run requires history provenance`);
  return {
    history_source_id: manifest.history.source_id,
    history_schema_version: manifest.history.schema_version,
    history_snapshot_version: manifest.history.snapshot_version,
  };
}

function validateSelectedWorkload(manifest: Manifest, eventCount: number, ruleCount: number): void {
  if (manifest.workload === undefined) throw new RunError(`${MANIFEST_FILE}: selected-suite run requires workload bounds`);
  if (eventCount > manifest.workload.max_events) {
    throw new RunError(
      `${MANIFEST_FILE}: event count ${eventCount} exceeds declared workload.max_events ${manifest.workload.max_events}`,
    );
  }
  if (ruleCount > manifest.workload.max_rules) {
    throw new RunError(
      `${MANIFEST_FILE}: admitted rule count ${ruleCount} exceeds declared workload.max_rules ${manifest.workload.max_rules}`,
    );
  }
  const resultCount = eventCount * ruleCount;
  if (!Number.isSafeInteger(resultCount) || resultCount > manifest.workload.max_results) {
    throw new RunError(
      `${MANIFEST_FILE}: event-by-rule result count ${resultCount} exceeds declared workload.max_results ${manifest.workload.max_results}`,
    );
  }
}

function rulesInRunRows(
  runId: string,
  rules: readonly Rule[],
  suite: SuiteProvenance,
): RulesInRunRow[] {
  return rules.map((rule) => ({
    run_id: runId,
    grain: "applied_rule",
    ...suite,
    rule_id: rule.id,
    rule_version_id: sha256(canonicalJson(rule as unknown as Json)).slice(0, 16),
    tenant: rule.applies_to.tenant,
    risk_type: rule.applies_to.risk_type,
    parameters: parameterSnapshot([rule]),
  }));
}

/** Alert-origin run zero: loader evidence in, exactly six canonical ledger tables and a headline out. */
export function runAlertCase(caseDir: string, outDir: string, loaded: AlertRowLoadResult): AlertRunResult {
  const manifestText = readFileSync(join(caseDir, MANIFEST_FILE), "utf8");
  checkNumberLiterals(manifestText);
  const manifestJson = JSON.parse(manifestText) as Json;
  const manifest = readManifest(manifestJson);
  validateAlertManifest(manifest);

  const tenant = readYamlMapping(join(caseDir, SUITE_DIR, TENANT_FILE));
  const catalog = readYamlMapping(join(caseDir, SUITE_DIR, CATALOG_FILE));
  const ruleFiles = listRuleFiles(caseDir);
  const rules = loadRules(caseDir, ruleFiles);
  validateCatalogCoverage(rules, catalog);
  if (tenant.tenant !== manifest.tenant) {
    throw new RunError(`${TENANT_FILE} is for ${String(tenant.tenant)}, manifest pins ${manifest.tenant}`);
  }
  if (tenant.currency !== manifest.comparability.currency) {
    throw new RunError(
      `${TENANT_FILE} currency ${String(tenant.currency)} differs from the manifest comparability currency ${manifest.comparability.currency}`,
    );
  }
  const currency = nonEmptyString(tenant.currency, `${TENANT_FILE}: currency`);
  const fireOn = oneOf(tenant.fire_on, FIRE_ON_VALUES, `${TENANT_FILE}: fire_on`);
  if (loaded.scenario_set.mapping_version !== manifest.comparability.resolution_mapping_version) {
    throw new RunError(
      `${RESOLUTION_MAPPING_FILE} version ${loaded.scenario_set.mapping_version} differs from manifest comparability resolution mapping version ${manifest.comparability.resolution_mapping_version}`,
    );
  }

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  for (const scenario of loaded.scenario_set.scenarios) {
    const rule = rulesById.get(scenario.rule_id);
    if (rule === undefined) throw new RunError(`${ALERTS_FILE}: row ${scenario.source_row}: rule ${scenario.rule_id} is not in the suite`);
    if (rule.applies_to.tenant !== manifest.tenant) {
      throw new RunError(
        `${ALERTS_FILE}: row ${scenario.source_row}: rule ${rule.id} tenant ${rule.applies_to.tenant} differs from manifest tenant ${manifest.tenant}`,
      );
    }
    if (scenario.tenant !== rule.applies_to.tenant || scenario.risk_type !== rule.applies_to.risk_type) {
      throw new RunError(`${ALERTS_FILE}: row ${scenario.source_row}: loader scope differs from rule ${rule.id}`);
    }
    if (scenario.mapping_version !== loaded.scenario_set.mapping_version) {
      throw new RunError(`${ALERTS_FILE}: row ${scenario.source_row}: mapping version differs from its scenario set`);
    }
  }
  for (const rule of rules) {
    if (rule.applies_to.tenant !== manifest.tenant) {
      throw new RunError(
        `${rule.id}: applies_to tenant ${rule.applies_to.tenant} differs from ${TENANT_FILE} tenant ${String(tenant.tenant)}`,
      );
    }
  }

  const serializedScenarios = serializeAlertRowLoadResult(loaded);
  const scenarioSetDigest = sha256(serializedScenarios);
  const row: ManifestRow = {
    run_id: alertRunId(caseDir, manifestJson, ruleFiles, scenarioSetDigest),
    ...manifest,
    fire_on: fireOn,
    rule_set_hash: digestOfListing(caseDir, ruleFiles),
    scenario_set_hash: scenarioSetDigest.slice(0, 16),
    parameter_snapshot: parameterSnapshot(rules),
  };
  const scenarios = loaded.scenario_set.scenarios.map((scenario) => alertScenarioRow(scenario, currency));
  const cases = scenarios.map((scenario) => alertCaseRow(row.run_id, scenario, manifest.seed, manifest.split_ratio!));
  const verdicts = loaded.scenario_set.scenarios.map((scenario, index) =>
    alertVerdict(row.run_id, scenarios[index]!, scenario, rulesById.get(scenario.rule_id)!, fireOn)
  );
  const metrics = alertMetrics(row.run_id, loaded, rules, cases, verdicts, manifest.fp_ceiling);

  writeLedgerTable(outDir, "manifest.jsonl", [row]);
  writeLedgerTable(outDir, "scenarios.jsonl", scenarios);
  writeLedgerTable(outDir, "cases.jsonl", cases);
  writeLedgerTable(outDir, "verdicts.jsonl", verdicts);
  writeLedgerTable(outDir, "metrics.jsonl", [metrics]);
  writeLedgerTable(outDir, "change-log.jsonl", []);
  return { manifest: row, headline: formatAlertHeadline(row, metrics) };
}

function validateAlertManifest(manifest: Manifest): asserts manifest is Manifest & {
  fp_ceiling: { alpha: number; delta: number };
  split_ratio: number;
} {
  if (manifest.run_type !== "zero") throw new RunError(`${MANIFEST_FILE}: alert rows are only valid for run_type zero`);
  if (manifest.fp_ceiling === undefined) throw new RunError(`${MANIFEST_FILE}: fp_ceiling must pin alpha and delta`);
  if (manifest.split_ratio === undefined) throw new RunError(`${MANIFEST_FILE}: split_ratio must be pinned`);
}

function alertScenarioRow(scenario: AlertScenario, currency: string): AlertScenarioRow {
  return {
    event_id: scenario.event_key ?? `alert-row:${scenario.source_row}`,
    merchant_id: null,
    tenant: scenario.tenant,
    risk_type: scenario.risk_type,
    kind: null,
    ts: scenario.alert_at,
    amount: scenario.amount,
    currency,
    score: scenario.score,
    score_provenance: scenario.score === null ? "absent" : "real",
    fields: scenario.fields,
    case_id: null,
    source_row: scenario.source_row,
    rule_id: scenario.rule_id,
    label: scenario.label,
    mapping_version: scenario.mapping_version,
  };
}

function alertCaseRow(runId: string, scenario: AlertScenarioRow, seed: number, splitRatio: number): AlertCaseRow {
  return {
    run_id: runId,
    case_id: null,
    taxonomy_version: null,
    category: null,
    merchant_role: null,
    loss_clock: null,
    split: alertSplit(seed, splitRatio, scenario.event_id),
    start_at: null,
    alert_at: scenario.ts,
    detected_at: null,
    first_realized_loss_at: null,
    days_to_alert: null,
    censored: true,
    source_row: scenario.source_row,
    rule_id: scenario.rule_id,
    label: scenario.label,
  };
}

function alertSplit(seed: number, splitRatio: number, eventId: string): "climb" | "promote" {
  const bucket = Number.parseInt(sha256(`${seed}\n${eventId}`).slice(0, 8), 16) / 0x1_0000_0000;
  return bucket < splitRatio ? "climb" : "promote";
}

function alertVerdict(
  runId: string,
  ledger: AlertScenarioRow,
  scenario: AlertScenario,
  rule: Rule,
  fireOn: FireOn,
): AlertVerdictRow {
  const unavailable = unavailableReasons(rule.conditions, scenario);
  if (unavailable.length > 0) {
    return {
      run_id: runId,
      event_id: ledger.event_id,
      merchant_id: null,
      rule_id: rule.id,
      verdict: "unavailable",
      fired: null,
      score: ledger.score,
      score_provenance: ledger.score_provenance,
      as_of_day: ledger.ts.slice(0, 10),
      source_row: ledger.source_row,
      label: ledger.label,
      parity: "unavailable",
      unavailable_reason: unavailable.join("; "),
    };
  }
  const verdict = evaluateRule(
    rule,
    {
      tenant: scenario.tenant,
      risk_type: scenario.risk_type,
      // An event-kind condition was rejected above; undefined cannot affect the remaining grammar.
      kind: undefined as never,
      ...(scenario.amount === null ? {} : { amount: scenario.amount }),
      currency: ledger.currency,
      ...(scenario.score === null ? {} : { score: scenario.score }),
      fields: scenario.fields as RuleRow["fields"],
    },
    fireOn,
  );
  if (verdict === "not_applicable") {
    throw new RunError(`${ALERTS_FILE}: row ${scenario.source_row}: own rule ${rule.id} was unexpectedly not applicable`);
  }
  const hit = verdict === "alert" || verdict === "suppressed";
  return {
    run_id: runId,
    event_id: ledger.event_id,
    merchant_id: null,
    rule_id: rule.id,
    verdict,
    fired: hit,
    score: ledger.score,
    score_provenance: ledger.score_provenance,
    as_of_day: ledger.ts.slice(0, 10),
    source_row: ledger.source_row,
    label: ledger.label,
    parity: hit ? "hit" : "miss",
    unavailable_reason: null,
  };
}

function unavailableReasons(conditions: readonly Condition[], scenario: AlertScenario): string[] {
  const reasons: string[] = [];
  const missing = new Set<string>();
  for (const condition of conditions) {
    if (condition.kind === "event_type") {
      if (!reasons.includes("event kind is absent")) reasons.push("event kind is absent");
      continue;
    }
    const fields = condition.kind === "field_factor" ? [condition.field, condition.other_field] : [condition.field];
    for (const field of fields) {
      if (!alertFieldAvailable(field, scenario)) missing.add(field);
    }
  }
  if (missing.size === 1) reasons.push(`missing feature ${[...missing][0]}`);
  if (missing.size > 1) reasons.push(`missing features ${[...missing].join(", ")}`);
  return reasons;
}

function alertFieldAvailable(field: string, scenario: AlertScenario): boolean {
  if (field === "amount") return scenario.amount !== null;
  if (field === "score") return scenario.score !== null;
  if (field === "currency") return true;
  return Object.hasOwn(scenario.fields, field);
}

function alertMetrics(
  runId: string,
  loaded: AlertRowLoadResult,
  rules: readonly Rule[],
  cases: readonly AlertCaseRow[],
  verdicts: readonly AlertVerdictRow[],
  fpCeiling: { alpha: number; delta: number },
): AlertMetricsRow {
  const labels = loaded.scenario_set.scenarios;
  const fraud = labels.filter((scenario) => scenario.label === "fraud");
  const legitCount = labels.filter((scenario) => scenario.label === "legit").length;
  const unknownCount = labels.filter((scenario) => scenario.label === "unknown").length;
  const fraudAmounts = fraud.flatMap((scenario) => scenario.amount === null ? [] : [scenario.amount]);
  const supportingMoneyValue = labels.length === 0 ? 0 : null;
  const minimumLegitCount = Math.ceil(Math.log(fpCeiling.delta) / Math.log1p(-fpCeiling.alpha));
  const ruleMetrics: RuleMetricRow[] = rules.map((rule) => {
    const ruleLabels = labels.filter((scenario) => scenario.rule_id === rule.id);
    const fraudCount = ruleLabels.filter((scenario) => scenario.label === "fraud").length;
    const ruleLegitCount = ruleLabels.filter((scenario) => scenario.label === "legit").length;
    const denominator = fraudCount + ruleLegitCount;
    const climbLegitCount = cases.filter(
      (row) => row.rule_id === rule.id && row.split === "climb" && row.label === "legit",
    ).length;
    return {
      rule_id: rule.id,
      precision: denominator === 0 ? null : fraudCount / denominator,
      fraud_count: fraudCount,
      legit_count: ruleLegitCount,
      unknown_excluded_count: ruleLabels.filter((scenario) => scenario.label === "unknown").length,
      climb_legit_count: climbLegitCount,
      minimum_legit_count: minimumLegitCount,
      tuning_status: climbLegitCount >= minimumLegitCount ? "tunable" : "untunable",
    };
  });
  return {
    run_id: runId,
    headline_label: "proxy",
    run_label: "run zero",
    net_value_saved: 0,
    gross_caught: fraudAmounts.length === fraud.length ? fraudAmounts.reduce((sum, amount) => sum + amount, 0) : null,
    gross_caught_count: fraud.length,
    gross_caught_amount_count: fraudAmounts.length,
    gross_leaked: null,
    gross_attempted_fraud: supportingMoneyValue,
    prevented_fraud: supportingMoneyValue,
    executed_fraud_value: supportingMoneyValue,
    gross_actual_loss: supportingMoneyValue,
    recovered_amount: supportingMoneyValue,
    intervention_cost: supportingMoneyValue,
    legitimate_value_declined: supportingMoneyValue,
    events: labels.length,
    alerts: labels.length,
    // Alert-only exports do not contain the non-alert fraud or legitimate denominators
    // required by the domain miss-rate and population-FPR definitions.
    miss_rate: null,
    false_positive_rate: null,
    coverage: null,
    days_to_alert_median: null,
    score_provenance_counts: {
      real: labels.filter((scenario) => scenario.score !== null).length,
      assumed: 0,
      absent: labels.filter((scenario) => scenario.score === null).length,
    },
    unknown_label_count: unknownCount,
    parity_hit_count: verdicts.filter((verdict) => verdict.parity === "hit").length,
    parity_miss_count: verdicts.filter((verdict) => verdict.parity === "miss").length,
    parity_unavailable_count: verdicts.filter((verdict) => verdict.parity === "unavailable").length,
    rule_metrics: ruleMetrics,
  };
}

function formatAlertHeadline(manifest: ManifestRow, metrics: AlertMetricsRow): string {
  if (typeof metrics.gross_caught_count !== "number") {
    throw new RunError("metrics: missing required field gross_caught_count");
  }
  if (typeof metrics.gross_caught_amount_count !== "number") {
    throw new RunError("metrics: missing required field gross_caught_amount_count");
  }
  const caughtDollars = metrics.gross_caught === null
    ? `dollars not measurable (${metrics.gross_caught_amount_count}/${metrics.gross_caught_count} caught rows carry amount)`
    : `${manifest.comparability.currency} ${metrics.gross_caught} by dollars`;
  return [
    `Run zero · tenant ${manifest.tenant}`,
    `Gross caught: ${metrics.gross_caught_count} by count; ${caughtDollars}`,
    "Gross leaked: not measurable from alert rows",
    "Net value saved: 0 by definition against the pinned baseline",
  ].join("\n");
}

function loadRules(caseDir: string, ruleFiles: readonly string[]): Rule[] {
  try {
    const rules = ruleFiles.map((file) => {
      const document = parseYaml(readFileSync(join(caseDir, ...file.split("/")), "utf8"));
      return readRule(document, file);
    });
    validateRuleSuite(rules);
    return rules;
  } catch (error) {
    if (error instanceof RuleError) throw new RunError(error.message, { cause: error });
    throw error;
  }
}

function selectAdmittedRules(rules: readonly Rule[], admittedRuleIds: readonly string[] | undefined): Rule[] {
  if (admittedRuleIds === undefined) return [...rules];
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  return admittedRuleIds.map((ruleId) => {
    const rule = rulesById.get(ruleId);
    if (rule === undefined) throw new RunError(`${MANIFEST_FILE}: unknown admitted rule id ${ruleId}`);
    return rule;
  });
}

function validateCatalogCoverage(rules: readonly Rule[], catalog: { [key: string]: YamlValue }): void {
  if (!Array.isArray(catalog.features)) throw new RunError(`${CATALOG_FILE}.features must be a sequence`);
  const catalogNames = new Set<string>();
  for (const [index, feature] of catalog.features.entries()) {
    if (!isMapping(feature)) throw new RunError(`${CATALOG_FILE}.features[${index}] must be a mapping`);
    const name = nonEmptyString(feature.name, `${CATALOG_FILE}.features[${index}].name`);
    if (catalogNames.has(name)) throw new RunError(`${CATALOG_FILE}: duplicate feature ${name}`);
    catalogNames.add(name);
  }
  for (const rule of rules) {
    for (const feature of referencedFeatureNames(rule)) {
      if (!catalogNames.has(feature)) throw new RunError(`${rule.id}: feature ${feature} is not present in ${CATALOG_FILE}`);
    }
  }
}

type EvaluatableScenario = { ledger: EventScenarioRow; ruleRow: RuleRow; snapshot?: DailySnapshot };

function readScenario(doc: Json, where: string, requireSegment = false, daily = false): EvaluatableScenario {
  if (!isMapping(doc)) throw new RunError(`${where}: expected an object`);
  const scenarioFields = daily ? DAILY_EVENT_SCENARIO_COLUMNS : requireSegment ? SELECTED_EVENT_SCENARIO_COLUMNS : EVENT_SCENARIO_COLUMNS;
  for (const key of Object.keys(doc)) {
    if (daily && key === "label") continue;
    if (!(scenarioFields as readonly string[]).includes(key)) throw new RunError(`${where}: unknown scenario field ${key}`);
  }
  for (const key of scenarioFields) {
    if (!Object.hasOwn(doc, key)) throw new RunError(`${where}: missing scenario field ${key}`);
  }
  try {
    const rowDoc: { [key: string]: YamlValue } = {};
    for (const key of ["tenant", "risk_type", "kind", "amount", "currency", "score", "fields"] as const) {
      const value = doc[key];
      if (value !== undefined) rowDoc[key] = value;
    }
    const ruleRow = readRuleRow(rowDoc, where);
    const scoreProvenance = oneOf(doc.score_provenance, ["real", "assumed", "absent"] as const, `${where}.score_provenance`);
    const eventId = nonEmptyString(doc.event_id, `${where}.event_id`);
    const merchantId = nonEmptyString(doc.merchant_id, `${where}.merchant_id`);
    const ts = nonEmptyString(doc.ts, `${where}.ts`);
    const segment = doc.segment === undefined
      ? undefined
      : nonEmptyString(doc.segment, `${where}.segment`);
    if (requireSegment && segment === undefined) throw new RunError(`${where}: missing scenario field segment`);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(ts) || !Number.isFinite(Date.parse(ts))) {
      throw new RunError(`${where}.ts must be an ISO 8601 timestamp`);
    }
    return {
      ruleRow,
      ledger: {
        event_id: eventId,
        merchant_id: merchantId,
        tenant: ruleRow.tenant,
        risk_type: ruleRow.risk_type,
        kind: ruleRow.kind,
        ts,
        amount: ruleRow.amount!,
        currency: ruleRow.currency!,
        score: ruleRow.score ?? null,
        score_provenance: scoreProvenance,
        fields: ruleRow.fields,
        case_id: doc.case_id === null ? null : nonEmptyString(doc.case_id, `${where}.case_id`),
        ...(segment === undefined ? {} : { segment }),
        ...(daily ? {
          transaction_id: nonEmptyString(doc.transaction_id, `${where}.transaction_id`),
          ...(doc.label === undefined ? {} : { label: oneOf(doc.label, ["fraud", "legit", "unknown"] as const, `${where}.label`) }),
        } : {}),
      },
    };
  } catch (error) {
    if (error instanceof RuleError) throw new RunError(error.message, { cause: error });
    throw error;
  }
}

function evaluateScenarios(
  runId: string,
  scenarios: readonly EvaluatableScenario[],
  rules: readonly Rule[],
  fireOn: FireOn,
  trace?: HistoryProvenance & SuiteProvenance,
  dailyFeature?: string,
  definitionId?: string,
): EventVerdictRow[] {
  return scenarios.flatMap(({ ledger: scenario, ruleRow, snapshot }) =>
    rules.map((rule) => {
      checkActiveResources();
      const features = referencedFeatureNames(rule);
      const missingDaily = snapshot?.value === null && dailyFeature !== undefined && features.includes(dailyFeature);
      const missingReference = snapshot?.reference?.value === null && features.includes(String(snapshot.reference.feature));
      const unavailable = (missingDaily || missingReference)
        && rule.applies_to.tenant === scenario.tenant && rule.applies_to.risk_type === scenario.risk_type;
      const verdict = unavailable ? "unavailable" : evaluateRule(rule, ruleRow, fireOn);
      return {
        run_id: runId,
        event_id: scenario.event_id,
        merchant_id: scenario.merchant_id,
        rule_id: rule.id,
        verdict,
        fired: verdict === "not_applicable" || verdict === "unavailable" ? null : verdict === "alert" || verdict === "suppressed",
        score: scenario.score,
        score_provenance: scenario.score_provenance,
        as_of_day: snapshot?.as_of_day ?? scenario.ts.slice(0, 10),
        ...(snapshot === undefined ? {} : { snapshot_id: snapshot.snapshot_id,
          feature_definition_id: definitionId!, unavailable_reason: unavailable
            ? missingDaily ? snapshot.status : String(snapshot.reference!.status) : null }),
        ...(trace === undefined ? {} : {
          grain: "event_rule" as const,
          segment: scenario.segment!,
          scope: "segment" as const,
          ...trace,
        }),
      };
    }),
  );
}

/** Fail closed on a manifest that does not pin everything a run needs. */
export function readManifest(doc: Json): Manifest {
  if (!isMapping(doc)) throw new RunError(`${MANIFEST_FILE}: expected an object`);
  const seed = doc.seed;
  if (typeof seed !== "number" || !Number.isInteger(seed)) throw new RunError(`${MANIFEST_FILE}: seed must be an integer`);
  const manifest: Manifest = {
    run_type: oneOf(doc.run_type, RUN_TYPES, `${MANIFEST_FILE}: run_type`),
    goal: nonEmptyString(doc.goal, `${MANIFEST_FILE}: goal`),
    tenant: nonEmptyString(doc.tenant, `${MANIFEST_FILE}: tenant`),
    tier: oneOf(doc.tier, TIERS, `${MANIFEST_FILE}: tier`),
    pinned_baseline: nonEmptyString(doc.pinned_baseline, `${MANIFEST_FILE}: pinned_baseline`),
    seed,
    ...(doc.fp_ceiling === undefined ? {} : { fp_ceiling: readFpCeiling(doc.fp_ceiling) }),
    ...(doc.split_ratio === undefined ? {} : { split_ratio: openUnitInterval(doc.split_ratio, `${MANIFEST_FILE}: split_ratio`) }),
    ...(doc.similarity_threshold === undefined ? {} : {
      similarity_threshold: openUnitInterval(doc.similarity_threshold, `${MANIFEST_FILE}: similarity_threshold`),
    }),
    ...(doc.near_zero_threshold === undefined ? {} : {
      near_zero_threshold: openUnitInterval(doc.near_zero_threshold, `${MANIFEST_FILE}: near_zero_threshold`),
    }),
    ...(doc.admitted_rule_ids === undefined ? {} : {
      admitted_rule_ids: readAdmittedRuleIds(doc.admitted_rule_ids, `${MANIFEST_FILE}: admitted_rule_ids`),
    }),
    ...(doc.history === undefined ? {} : { history: readHistory(doc.history) }),
    ...(doc.workload === undefined ? {} : { workload: readWorkload(doc.workload) }),
    ...(doc.daily_totals === undefined ? {} : { daily_totals: dailyDefinition(doc.daily_totals) }),
    comparability: readComparability(doc.comparability),
  };
  if (manifest.daily_totals !== undefined && (manifest.admitted_rule_ids === undefined || manifest.run_type !== "replay")) {
    throw new RunError("daily_totals requires a selected-suite replay run");
  }
  if (doc.authored_outcomes !== undefined) {
    if (!manifest.daily_totals || !manifest.workload) throw new RunError("authored_outcomes requires daily selected-suite replay");
    try { manifest.authored_outcomes = readAuthoredOutcomes(doc.authored_outcomes, manifest.comparability.observation_window, manifest.workload.max_events); }
    catch (error) { if (error instanceof OutcomeError) throw new RunError(error.message, { cause: error }); throw error; }
  }
  return manifest;
}

function dailyDefinition(value: Json): DailyTotals {
  try { return readDailyTotals(value); }
  catch (error) {
    if (error instanceof DailyTotalsError || error instanceof MerchantReferenceError) throw new RunError(error.message, { cause: error });
    throw error;
  }
}

function readWorkload(value: Json): WorkloadBounds {
  const what = `${MANIFEST_FILE}: workload`;
  if (!isMapping(value)) throw new RunError(`${what} must be an object`);
  for (const key of Object.keys(value)) {
    if (!["max_events", "max_rules", "max_results"].includes(key)) {
      throw new RunError(`${what}: unknown field ${key}`);
    }
  }
  const workload: WorkloadBounds = {
    max_events: positiveInteger(value.max_events, `${what}.max_events`),
    max_rules: positiveInteger(value.max_rules, `${what}.max_rules`),
    max_results: positiveInteger(value.max_results, `${what}.max_results`),
  };
  for (const field of ["max_events", "max_rules", "max_results"] as const) {
    if (workload[field] > SUPPORTED_WORKLOAD_LIMITS[field]) {
      throw new RunError(
        `${MANIFEST_FILE}: workload.${field} ${workload[field]} exceeds supported limit ${SUPPORTED_WORKLOAD_LIMITS[field]}`,
      );
    }
  }
  return workload;
}

function positiveInteger(value: Json | undefined, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RunError(`${what} must be a positive safe integer`);
  }
  return value;
}

function readHistory(value: Json): NonNullable<Manifest["history"]> {
  const what = `${MANIFEST_FILE}: history`;
  if (!isMapping(value)) throw new RunError(`${what} must be an object`);
  for (const key of Object.keys(value)) {
    if (!["source_id", "schema_version", "snapshot_version"].includes(key)) {
      throw new RunError(`${what}: unknown field ${key}`);
    }
  }
  return {
    source_id: nonEmptyString(value.source_id, `${what}.source_id`),
    schema_version: nonEmptyString(value.schema_version, `${what}.schema_version`),
    snapshot_version: nonEmptyString(value.snapshot_version, `${what}.snapshot_version`),
  };
}

function readAdmittedRuleIds(value: Json, what: string): string[] {
  if (!Array.isArray(value)) throw new RunError(`${what} must be an array of rule ids`);
  const items = value.map((item, index) => nonEmptyString(item, `${what}[${index}]`));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) throw new RunError(`${MANIFEST_FILE}: duplicate admitted rule id ${item}`);
    seen.add(item);
  }
  return items;
}

function readFpCeiling(doc: Json): { alpha: number; delta: number } {
  const where = `${MANIFEST_FILE}: fp_ceiling`;
  if (!isMapping(doc)) throw new RunError(`${where} must be an object with alpha and delta`);
  for (const key of Object.keys(doc)) {
    if (key !== "alpha" && key !== "delta") throw new RunError(`${where}: unknown field ${key}`);
  }
  return {
    alpha: openUnitInterval(doc.alpha, `${where}.alpha`),
    delta: openUnitInterval(doc.delta, `${where}.delta`),
  };
}

/** Every manifest gate must be pinned; an unknown key is refused too. */
export function readComparability(doc: Json | undefined): Comparability {
  const where = `${MANIFEST_FILE}: comparability`;
  if (!isMapping(doc)) throw new RunError(`${where} must be an object`);
  for (const key of Object.keys(doc)) {
    if (!(COMPARABILITY_GATES as readonly string[]).includes(key)) throw new RunError(`${where}: unknown gate ${key}`);
  }
  const window = doc.observation_window;
  if (!isMapping(window)) throw new RunError(`${where}.observation_window must be an object with from and to`);
  for (const key of Object.keys(window)) {
    if (key !== "from" && key !== "to") throw new RunError(`${where}.observation_window: unknown field ${key}`);
  }
  const costs = doc.cost_assumptions;
  if (!isMapping(costs)) throw new RunError(`${where}.cost_assumptions must be an object`);
  for (const key of Object.keys(costs)) {
    if (key !== "lambda" && key !== "intervention_cost") throw new RunError(`${where}.cost_assumptions: unknown field ${key}`);
  }
  return {
    currency: nonEmptyString(doc.currency, `${where}.currency`),
    fx_snapshot: nonEmptyString(doc.fx_snapshot, `${where}.fx_snapshot`),
    observation_window: {
      from: nonEmptyString(window.from, `${where}.observation_window.from`),
      to: nonEmptyString(window.to, `${where}.observation_window.to`),
    },
    resolution_mapping_version: nonEmptyString(doc.resolution_mapping_version, `${where}.resolution_mapping_version`),
    score_provenance_policy: nonEmptyString(doc.score_provenance_policy, `${where}.score_provenance_policy`),
    cost_assumptions: {
      lambda: finiteNumber(costs.lambda, `${where}.cost_assumptions.lambda`),
      intervention_cost: finiteNumber(costs.intervention_cost, `${where}.cost_assumptions.intervention_cost`),
    },
  };
}

function finiteNumber(v: Json | undefined, what: string): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new RunError(`${what} must be a finite number`);
}

function openUnitInterval(v: Json | undefined, what: string): number {
  const value = finiteNumber(v, what);
  if (value > 0 && value < 1) return value;
  throw new RunError(`${what} must be greater than zero and less than one`);
}

/**
 * run_id = sha256( canonicalJson(manifest) + "\n" + one line per input file
 * "<relative path> <sha256 hex>\n", paths sorted )[0:16]. Inputs are
 * suite/rules/*.yaml, suite/catalog.yaml, suite/tenant.yaml, scenarios.jsonl.
 * Same inputs, same id; never a timestamp (register: run_id_hash).
 */
export function runId(caseDir: string, manifest: Json, ruleFiles: readonly string[]): string {
  const inputs = [...ruleFiles, posix.join(SUITE_DIR, CATALOG_FILE), posix.join(SUITE_DIR, TENANT_FILE), SCENARIOS_FILE].sort();
  const payload = canonicalJson(manifest) + "\n" + listing(caseDir, inputs);
  return sha256(payload).slice(0, 16);
}

function alertRunId(caseDir: string, manifest: Json, ruleFiles: readonly string[], scenarioSetDigest: string): string {
  const fileDigests = new Map<string, string>([
    ...ruleFiles.map((file) => [file, digestPortableTextFile(join(caseDir, ...file.split("/")))] as const),
    [posix.join(SUITE_DIR, CATALOG_FILE), digestPortableTextFile(join(caseDir, SUITE_DIR, CATALOG_FILE))],
    [posix.join(SUITE_DIR, TENANT_FILE), digestPortableTextFile(join(caseDir, SUITE_DIR, TENANT_FILE))],
    ["alert-scenario-set.json", scenarioSetDigest],
  ]);
  const inputListing = [...fileDigests]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, digest]) => `${path} ${digest}\n`)
    .join("");
  return sha256(canonicalJson(manifest) + "\n" + inputListing).slice(0, 16);
}

function digestOfListing(caseDir: string, files: readonly string[]): string {
  return sha256(listing(caseDir, [...files].sort())).slice(0, 16);
}

function listing(caseDir: string, files: readonly string[]): string {
  // Labels and text line endings are normalized so a Git checkout hashes the same on Windows and POSIX.
  return files.map((f) => `${f} ${digestPortableTextFile(join(caseDir, ...f.split("/")))}\n`).join("");
}

function digestPortableTextFile(path: string): string {
  return sha256(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

function listRuleFiles(caseDir: string): string[] {
  const dir = join(caseDir, SUITE_DIR, RULES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => posix.join(SUITE_DIR, RULES_DIR, f));
}

function readYamlMapping(path: string): { [key: string]: YamlValue } {
  const v = parseYaml(readFileSync(path, "utf8"));
  if (!isMapping(v)) throw new RunError(`${path}: expected a mapping`);
  return v;
}

function oneOf<T extends string>(v: Json | undefined, allowed: readonly T[], what: string): T {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new RunError(`${what} must be one of ${allowed.join(", ")}, got ${JSON.stringify(v)}`);
}

function nonEmptyString(v: Json | undefined, what: string): string {
  if (typeof v === "string" && v.trim() !== "") return v;
  throw new RunError(`${what} must be a non-empty string`);
}

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isMapping(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(",")}}`;
  }
  if (typeof value === "number") return canonicalNumber(value);
  return JSON.stringify(value);
}

/**
 * The canonical form is `jq -cS`. JSON.stringify agrees with jq for integers and plain
 * decimals and disagrees on -0 and exponent forms, so those are refused rather than hashed.
 */
function canonicalNumber(n: number): string {
  const text = JSON.stringify(n);
  if (!Number.isFinite(n) || Object.is(n, -0) || /[eE]/.test(text)) throw new RunError(`number ${String(n)} has no canonical JSON form shared with jq -cS`);
  return text;
}

const JSON_NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Admit one source number only when parsing and canonical serialization preserve its bytes. */
export function readCanonicalNumberLiteral(literal: string, where = MANIFEST_FILE): number {
  if (!JSON_NUMBER_LITERAL.test(literal)) {
    throw new RunError(`${where}: number literal ${literal} does not match the JSON number grammar`);
  }
  const value = Number(literal);
  let canonical: string | undefined;
  try {
    canonical = canonicalNumber(value);
  } catch (error) {
    if (!(error instanceof RunError)) throw error;
  }
  if (canonical !== literal) {
    throw new RunError(`${where}: number literal ${literal} does not round-trip canonical JSON byte-for-byte`);
  }
  return value;
}

/** Refuse malformed candidates and valid tokens that cannot survive the one source-number rule. */
export function checkNumberLiterals(text: string, where = MANIFEST_FILE): void {
  const outsideStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const candidates = outsideStrings.matchAll(/[^\s,\[\]{}:]+/g);
  for (const match of candidates) {
    const literal = match[0];
    if (!/^[+\-.0-9]/.test(literal) && literal !== "NaN" && literal !== "Infinity") continue;
    readCanonicalNumberLiteral(literal, where);
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function writeLedgerTable(dir: string, table: ProposalLedgerTable | ScenarioLedgerTable, rows: readonly Json[]): void {
  const limits = resourceLimits();
  let size = directoryBytes(dir);
  const lines = rows.map(row => {
    checkActiveResources();
    const line = canonicalJson(row) + "\n";
    size += Buffer.byteLength(line);
    enforceResource("output_bytes", size, limits.max_output_bytes);
    return line;
  });
  writeFileSync(join(dir, table), lines.join(""));
}
