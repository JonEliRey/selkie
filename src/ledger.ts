// Ledger folder: one folder per run. Tables are written as JSONL.

import { readFileSync } from "node:fs";
import type { YamlValue } from "./yaml.ts";
import type { DailyTotals } from "./daily-totals.ts";

/** JSON and the YAML subset share one value shape. */
export type Json = YamlValue;

/** Run types. The type is derived from the array so the closed set is written once. */
export const RUN_TYPES = ["zero", "replay", "attack", "attack:solver", "tune", "gap", "consolidate", "statistical"] as const;
export type RunType = (typeof RUN_TYPES)[number];

/** Adversary tiers. */
export const TIERS = ["opportunist", "organized", "insider"] as const;
export type Tier = (typeof TIERS)[number];

/** What a rule's score call means for a tenant. */
export const FIRE_ON_VALUES = ["alert", "suppress"] as const;
export type FireOn = (typeof FIRE_ON_VALUES)[number];

export type ScoreProvenance = "real" | "assumed" | "absent";

/** Source identity carried by every selected-suite result from materialized history. */
export type HistoryProvenance = {
  history_source_id: string;
  history_schema_version: string;
  history_snapshot_version: string;
};

/** Suite and parameter identities shared by selected-suite ledger tables. */
export type SuiteProvenance = {
  suite_id: string;
  parameter_snapshot_id: string;
};

export type WorkloadBounds = {
  max_events: number;
  max_rules: number;
  max_results: number;
};

// Runtime column definitions are shared by the run and fail-closed consolidate
// validation seams. Legacy names stay intact while selected-suite tables extend them.
export const LEGACY_MANIFEST_COLUMNS = [
  "run_id", "run_type", "goal", "tenant", "tier", "pinned_baseline", "seed", "fp_ceiling", "split_ratio",
  "similarity_threshold", "near_zero_threshold", "fire_on", "rule_set_hash", "scenario_set_hash",
  "parameter_snapshot", "comparability",
] as const;

export const EVENT_SCENARIO_COLUMNS = [
  "event_id", "merchant_id", "tenant", "risk_type", "kind", "ts", "amount", "currency", "score",
  "score_provenance", "fields", "case_id",
] as const;
export const ALERT_SCENARIO_COLUMNS = [
  ...EVENT_SCENARIO_COLUMNS, "source_row", "rule_id", "label", "mapping_version",
] as const;
export const SELECTED_EVENT_SCENARIO_COLUMNS = [...EVENT_SCENARIO_COLUMNS, "segment"] as const;
/** Daily history requires lifecycle identity; authored label remains optional. */
export const DAILY_EVENT_SCENARIO_COLUMNS = [...SELECTED_EVENT_SCENARIO_COLUMNS, "transaction_id"] as const;

export const VERDICT_COLUMNS = [
  "run_id", "event_id", "merchant_id", "rule_id", "verdict", "fired", "score", "score_provenance", "as_of_day",
] as const;
export const ALERT_VERDICT_COLUMNS = [
  ...VERDICT_COLUMNS, "source_row", "label", "parity", "unavailable_reason",
] as const;
export const SELECTED_EVENT_VERDICT_COLUMNS = [
  ...VERDICT_COLUMNS, "grain", "segment", "scope", "history_source_id", "history_schema_version",
  "history_snapshot_version", "suite_id", "parameter_snapshot_id",
] as const;

export const CASE_COLUMNS = [
  "run_id", "case_id", "taxonomy_version", "category", "merchant_role", "loss_clock", "split", "start_at",
  "alert_at", "detected_at", "first_realized_loss_at", "days_to_alert", "censored",
] as const;
export const ALERT_CASE_COLUMNS = [...CASE_COLUMNS, "source_row", "rule_id", "label"] as const;
export const CHANGE_LOG_COLUMNS = [
  "run_id", "attempt", "parameter_id", "before", "after", "reason", "metric", "status",
] as const;

export const METRICS_COLUMNS = [
  "run_id", "headline_label", "net_value_saved", "gross_caught", "gross_leaked", "gross_attempted_fraud",
  "prevented_fraud", "executed_fraud_value", "gross_actual_loss", "recovered_amount", "intervention_cost",
  "legitimate_value_declined", "events", "alerts", "miss_rate", "false_positive_rate", "coverage",
  "days_to_alert_median",
] as const;
export const ALERT_METRICS_COLUMNS = [
  ...METRICS_COLUMNS, "run_label", "gross_caught_count", "gross_caught_amount_count", "score_provenance_counts",
  "unknown_label_count", "parity_hit_count", "parity_miss_count", "parity_unavailable_count", "rule_metrics",
] as const;
export const SELECTED_METRICS_COLUMNS = [...METRICS_COLUMNS, "scope", "segment"] as const;
export const RULE_METRIC_COLUMNS = [
  "rule_id", "precision", "fraud_count", "legit_count", "unknown_excluded_count", "climb_legit_count",
  "minimum_legit_count", "tuning_status",
] as const;
export const RULES_IN_RUN_COLUMNS = [
  "run_id", "grain", "suite_id", "parameter_snapshot_id", "rule_id", "rule_version_id", "tenant", "risk_type",
  "parameters",
] as const;

/**
 * The comparability gates that the manifest pins directly (the other three are
 * `pinned_baseline`, `fire_on` from tenant.yaml, and the rule and parameter snapshot).
 * Every field is required; `readManifest` refuses a manifest that leaves one unpinned.
 */
export const COMPARABILITY_GATES = ["currency", "fx_snapshot", "observation_window", "resolution_mapping_version", "score_provenance_policy", "cost_assumptions"] as const;
export type Comparability = {
  currency: string;
  fx_snapshot: string;
  observation_window: { from: string; to: string };
  resolution_mapping_version: string;
  score_provenance_policy: string;
  cost_assumptions: { lambda: number; intervention_cost: number };
};

/** One row in `manifest.jsonl`: the input manifest plus what the run derived. */
export type ManifestRow = {
  run_id: string;
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
  fire_on: FireOn;
  rule_set_hash: string;
  suite_id?: string;
  parameter_snapshot_id?: string;
  grain?: "run";
  scenario_set_hash: string;
  parameter_snapshot: { [parameter_id: string]: Json };
  admitted_rule_ids?: string[];
  history?: {
    source_id: string;
    schema_version: string;
    snapshot_version: string;
  };
  workload?: WorkloadBounds;
  daily_totals?: DailyTotals;
  comparability: Comparability;
};

/** One row in `scenarios.jsonl`: one event, with its case's labels when it came from a case bundle. */
export type EventScenarioRow = {
  event_id: string;
  merchant_id: string;
  tenant: string;
  risk_type: string;
  kind: "authorization" | "settlement" | "refund" | "chargeback" | "dispute";
  ts: string;
  amount: number;
  currency: string;
  score: number | null;
  score_provenance: ScoreProvenance;
  fields: { [feature: string]: Json };
  case_id: string | null;
  segment?: string;
  transaction_id?: string;
  label?: "fraud" | "legit" | "unknown";
};

/** Alert exports deliberately leave event-only evidence null. */
export type AlertScenarioRow = {
  event_id: string;
  merchant_id: null;
  tenant: string;
  risk_type: string;
  kind: null;
  ts: string;
  amount: number | null;
  currency: string;
  score: number | null;
  score_provenance: "real" | "absent";
  fields: { [feature: string]: Json };
  case_id: null;
  source_row: number;
  rule_id: string;
  label: "fraud" | "legit" | "unknown";
  mapping_version: string;
};

export type ScenarioRow = EventScenarioRow | AlertScenarioRow;

export type MerchantRole = "perpetrator" | "complicit" | "victim" | "unknown";
export type LossClock = "settlement" | "refund" | "dispute" | "compliance" | "downstream-card-fraud";

/**
 * One row in `cases.jsonl`: the per-case labels, time semantics, and split
 * `days_to_alert` is unrounded and null when
 * the case is undetected, which `censored` records; never zero.
 */
type CaseRowBase = {
  run_id: string;
  split: "climb" | "promote";
  start_at: string | null;
  alert_at: string | null;
  detected_at: string | null;
  first_realized_loss_at: string | null;
  days_to_alert: number | null;
  censored: boolean;
};

export type EventCaseRow = CaseRowBase & {
  case_id: string;
  taxonomy_version: string;
  category: string;
  merchant_role: MerchantRole;
  loss_clock: LossClock;
  source_row?: never;
  rule_id?: never;
  label?: never;
};

export type AlertCaseRow = CaseRowBase & {
  case_id: null;
  taxonomy_version: null;
  category: null;
  merchant_role: null;
  loss_clock: null;
  start_at: null;
  detected_at: null;
  first_realized_loss_at: null;
  days_to_alert: null;
  censored: true;
  source_row: number;
  rule_id: string;
  label: "fraud" | "legit" | "unknown";
};

export type CaseRow = EventCaseRow | AlertCaseRow;

/**
 * One row in `verdicts.jsonl`: one rule evaluated on one event. `fired` records
 * condition truth independently of tenant policy; `verdict` applies `fire_on`.
 * `as_of_day` names the feature snapshot the event saw.
 */
type VerdictRowBase = {
  run_id: string;
  event_id: string;
  rule_id: string;
  score: number | null;
  as_of_day: string;
};

export type EventVerdictRow = VerdictRowBase & {
  merchant_id: string;
  verdict: "alert" | "suppressed" | "did_not_fire" | "not_applicable" | "unavailable";
  fired: boolean | null;
  score_provenance: ScoreProvenance;
  source_row?: never;
  label?: never;
  parity?: never;
  unavailable_reason?: string | null;
  snapshot_id?: string;
  feature_definition_id?: string;
  grain?: "event_rule";
  segment?: string;
  scope?: "segment";
} & Partial<HistoryProvenance & SuiteProvenance>;

type AlertVerdictRowBase = VerdictRowBase & {
  merchant_id: null;
  score_provenance: "real" | "absent";
  source_row: number;
  label: "fraud" | "legit" | "unknown";
};

export type AlertAvailableVerdictRow = AlertVerdictRowBase & {
  verdict: "alert" | "suppressed" | "did_not_fire";
  fired: boolean;
  parity: "hit" | "miss";
  unavailable_reason: null;
};

export type AlertUnavailableVerdictRow = AlertVerdictRowBase & {
  verdict: "unavailable";
  fired: null;
  parity: "unavailable";
  unavailable_reason: string;
};

export type AlertVerdictRow = AlertAvailableVerdictRow | AlertUnavailableVerdictRow;
export type VerdictRow = EventVerdictRow | AlertVerdictRow;

export type RuleMetricRow = {
  rule_id: string;
  precision: number | null;
  fraud_count: number;
  legit_count: number;
  unknown_excluded_count: number;
  climb_legit_count: number;
  minimum_legit_count: number;
  tuning_status: "tunable" | "untunable";
};

/** One row in `metrics.jsonl`: the headline, the seven money facts, and the supporting rates. Suppress-mode `alerts` is unknown. */
type MetricsRowBase = {
  run_id: string;
  headline_label: "proxy" | "realised" | "event and alert counts" | "scenario performance";
  net_value_saved: number | null;
  /** Dollars when every fraud-labelled alert carries an amount; otherwise null. */
  gross_caught: number | null;
  gross_leaked: number | null;
  gross_attempted_fraud: number | null;
  prevented_fraud: number | null;
  executed_fraud_value: number | null;
  gross_actual_loss: number | null;
  recovered_amount: number | null;
  intervention_cost: number | null;
  legitimate_value_declined: number | null;
  events: number;
  alerts: number | null;
  miss_rate: number | null;
  false_positive_rate: number | null;
  coverage: number | null;
  days_to_alert_median: number | null;
  scope?: "aggregate";
  segment?: null;
};

/** One admitted rule version and its parameterization in one selected-suite run. */
export type RulesInRunRow = SuiteProvenance & {
  run_id: string;
  grain: "applied_rule";
  rule_id: string;
  rule_version_id: string;
  tenant: string;
  risk_type: string;
  parameters: { [parameter_id: string]: Json };
};

export type EventMetricsRow = MetricsRowBase & {
  run_label?: never;
  gross_caught_count?: never;
  gross_caught_amount_count?: never;
  score_provenance_counts?: never;
  unknown_label_count?: never;
  parity_hit_count?: never;
  parity_miss_count?: never;
  parity_unavailable_count?: never;
  rule_metrics?: never;
};

export type AlertMetricsRow = MetricsRowBase & {
  run_label: "run zero";
  gross_caught_count: number;
  gross_caught_amount_count: number;
  score_provenance_counts: { real: number; assumed: 0; absent: number };
  unknown_label_count: number;
  parity_hit_count: number;
  parity_miss_count: number;
  parity_unavailable_count: number;
  rule_metrics: RuleMetricRow[];
};

export type MetricsRow = EventMetricsRow | AlertMetricsRow;

/** One row in `change-log.jsonl`: one attempt the loop made. */
export type ChangeLogRow = {
  run_id: string;
  attempt: number;
  parameter_id: string;
  before: Json;
  after: Json;
  reason: string;
  metric: number | null;
  status: "kept" | "discarded" | "crashed";
};

/** One bounded proposal admission attempt; measured acceptance belongs to a later gate. */
export type ProposalAttemptRow = {
  /** Input identity only: recording this context does not assert execution or acceptance. */
  input_context: {
    identity_kind: "input_context";
    id: string;
    manifest: Json;
    /** SHA-256 of LF-normalized source text; admission.json uses its supplied raw bytes. */
    input_digests: Record<string, string>;
  };
  proposal_id: string;
  proposal: Json;
  state: "admitted" | "rejected";
  reasons: string[];
  experimental_acceptance: "not_assessed";
  incumbent_suite_id: string;
  candidate_suite_id: string | null;
  incumbent_run_id: string | null;
  candidate_run_id: string | null;
  source_translation: {
    artifact: "source-translation.json";
    verification: "supplied_artifact";
    sha256: string;
  } | null;
};

export const LEDGER_TABLES = ["manifest.jsonl", "scenarios.jsonl", "cases.jsonl", "verdicts.jsonl", "metrics.jsonl", "change-log.jsonl"] as const;
export type LedgerTable = (typeof LEDGER_TABLES)[number];
export const RULES_IN_RUN_TABLE = "rules-in-run.jsonl" as const;
export const SELECTED_SUITE_LEDGER_TABLES = [...LEDGER_TABLES, RULES_IN_RUN_TABLE] as const;
export const DAILY_LEDGER_TABLES = [...SELECTED_SUITE_LEDGER_TABLES, "feature-snapshots.jsonl", "merchant-days.jsonl", "feature-definitions.jsonl"] as const;
export type SelectedSuiteLedgerTable = (typeof SELECTED_SUITE_LEDGER_TABLES)[number];
export type DailyLedgerTable = (typeof DAILY_LEDGER_TABLES)[number];
export const REFERENCE_LEDGER_TABLES = [...DAILY_LEDGER_TABLES, "reference-assessments.jsonl"] as const;
export type ReferenceLedgerTable = (typeof REFERENCE_LEDGER_TABLES)[number];
export type ScenarioLedgerTable = "scenario-metrics.jsonl" | "authored-outcomes.jsonl";
export const PROPOSAL_ATTEMPTS_TABLE = "proposal-attempts.jsonl" as const;
export type ProposalLedgerTable = ReferenceLedgerTable | typeof PROPOSAL_ATTEMPTS_TABLE;

export function readJsonl(path: string): Json[] {
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Json);
}
