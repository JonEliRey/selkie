// Authored truth is assessed only after replay; it never supplies a rule feature.
import type { EventScenarioRow, EventVerdictRow, FireOn, Json } from "./ledger.ts";
import { isMapping } from "./yaml.ts";

export class OutcomeError extends Error {}

type Outcome = "fraud" | "legit" | "unknown";
export type AuthoredCase = {
  case_id: string; merchant_id: string; outcome: Outcome; available_at: string;
  from: string; to: string; taxonomy_version: string | null; category: string | null;
  merchant_role: "perpetrator" | "complicit" | "victim" | "unknown" | null;
};
export type AuthoredOutcomes = {
  version: string; dataset_id: string; partition: "search" | "reserved-validation";
  observation_window: { from: string; to: string }; as_of: string; stories_enabled: boolean;
  merchants: { merchant_id: string; classification: Outcome; available_at: string }[];
  cases: AuthoredCase[];
};

export function readAuthoredOutcomes(value: Json, window: { from: string; to: string }, bound: number): AuthoredOutcomes {
  function object(v: Json | undefined, keys: string[], where: string): asserts v is { [key: string]: Json } {
    if (!v || !isMapping(v)) throw new OutcomeError(`${where}: expected object`);
    for (const key of Object.keys(v)) if (!keys.includes(key)) throw new OutcomeError(`${where}: unknown field ${key}`);
    for (const key of keys) if (!(key in v)) throw new OutcomeError(`${where}: missing ${key}`);
  };
  const text = (v: Json | undefined, where: string) => {
    if (typeof v !== "string" || v.trim() !== v || v.length === 0 || v.length > 200) throw new OutcomeError(`${where}: expected bounded nonempty string`);
  };
  const timestamp = (v: Json | undefined, where: string) => {
    if (typeof v !== "string" || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw new OutcomeError(`${where}: expected canonical UTC timestamp`);
  };
  const outcome = (v: Json | undefined, where: string) => {
    if (typeof v !== "string" || !["fraud", "legit", "unknown"].includes(v)) throw new OutcomeError(`${where}: expected fraud, legit or unknown`);
  };
  object(value, ["version", "dataset_id", "partition", "observation_window", "as_of", "stories_enabled", "merchants", "cases"], "authored_outcomes");
  text(value.version, "outcome version"); text(value.dataset_id, "dataset_id");
  if (typeof value.partition !== "string" || !["search", "reserved-validation"].includes(value.partition)) throw new OutcomeError("outcome partition must be search or reserved-validation");
  if (typeof value.stories_enabled !== "boolean") throw new OutcomeError("stories_enabled must be boolean");
  timestamp(value.as_of, "as_of");
  object(value.observation_window, ["from", "to"], "observation_window");
  if (value.observation_window.from !== window.from || value.observation_window.to !== window.to) throw new OutcomeError("authored observation_window differs from run");
  for (const d of [window.from, window.to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) throw new OutcomeError("observation_window must use UTC calendar dates");
  }
  if (window.from >= window.to) throw new OutcomeError("observation_window must increase");
  for (const key of ["merchants", "cases"]) if (!Array.isArray(value[key]) || value[key].length > bound) throw new OutcomeError(`${key} exceeds outcome workload bound`);
  const merchantIds = new Set<string>();
  for (const m of value.merchants as Json[]) {
    object(m, ["merchant_id", "classification", "available_at"], "merchant");
    text(m.merchant_id, "merchant_id"); outcome(m.classification, "merchant classification"); timestamp(m.available_at, "merchant available_at");
    if (merchantIds.has(String(m.merchant_id))) throw new OutcomeError("duplicate merchant_id");
    merchantIds.add(String(m.merchant_id));
  }
  const ids = new Set<string>();
  for (const c of value.cases as Json[]) {
    object(c, ["case_id", "merchant_id", "outcome", "available_at", "from", "to", "taxonomy_version", "category", "merchant_role"], "case");
    text(c.case_id, "case_id"); text(c.merchant_id, "case merchant_id"); outcome(c.outcome, "case outcome");
    if (ids.has(String(c.case_id))) throw new OutcomeError("duplicate case_id");
    ids.add(String(c.case_id));
    if (!merchantIds.has(String(c.merchant_id))) throw new OutcomeError("case names unknown merchant");
    timestamp(c.available_at, "case available_at"); timestamp(c.from, "case from"); timestamp(c.to, "case to");
    if (String(c.from) >= String(c.to) || String(c.from) < window.from + "T00:00:00.000Z" || String(c.to) > window.to + "T00:00:00.000Z") throw new OutcomeError("case interval must be increasing within observation_window");
    if ((c.taxonomy_version === null) !== (c.category === null)) throw new OutcomeError("taxonomy version and category must be supplied together");
    if (c.taxonomy_version !== null) { text(c.taxonomy_version, "taxonomy_version"); text(c.category, "category"); }
    if (c.merchant_role !== null && (typeof c.merchant_role !== "string" || !["perpetrator", "complicit", "victim", "unknown"].includes(c.merchant_role))) throw new OutcomeError("invalid merchant_role");
  }
  const contract = value as unknown as AuthoredOutcomes;
  for (const m of contract.merchants) {
    const cases = contract.cases.filter(c => c.merchant_id === m.merchant_id).sort((a,b) => a.from < b.from ? -1 : 1);
    if (m.classification === "legit" && cases.some(c => c.outcome === "fraud")) throw new OutcomeError("legitimate merchant has authored fraud case");
    for (let i = 1; i < cases.length; i++) if (cases[i]!.from < cases[i-1]!.to) throw new OutcomeError("overlapping case intervals for merchant");
  }
  return contract;
}

export function validateOutcomeBindings(contract: AuthoredOutcomes, events: readonly EventScenarioRow[]): void {
  const cases = new Map(contract.cases.map(c => [c.case_id, c]));
  const merchants = new Set(contract.merchants.map(m => m.merchant_id));
  const observed = new Set<string>();
  const bound = new Set<string>();
  for (const e of events) {
    if (e.ts < contract.observation_window.from || e.ts >= contract.observation_window.to) {
      if (e.case_id !== null) throw new OutcomeError("case_id outside observation_window");
      continue;
    }
    if (!merchants.has(e.merchant_id)) throw new OutcomeError("evaluated merchant missing authored classification");
    observed.add(e.merchant_id);
    if (e.case_id !== null) {
      const c = cases.get(e.case_id);
      if (!c) throw new OutcomeError("event names unknown case_id");
      if (e.merchant_id !== c.merchant_id || e.ts < c.from || e.ts >= c.to) throw new OutcomeError("event contradicts case merchant or interval");
      if (e.label !== undefined && e.label !== "unknown" && e.label !== c.outcome) throw new OutcomeError("event label contradicts authored outcome");
      bound.add(c.case_id);
    } else if (e.label === "fraud") throw new OutcomeError("fraud event label requires authored case_id");
  }
  for (const c of contract.cases) if (!bound.has(c.case_id)) throw new OutcomeError("authored case_id has no evaluated events");
  for (const m of merchants) if (!observed.has(m)) throw new OutcomeError("authored merchant has no evaluated events");
}

export function outcomeEvidence(contract: AuthoredOutcomes): Json[] {
  const effective = (value: Outcome, available: string) => available > contract.as_of
    || (!contract.stories_enabled && value === "fraud") ? "unknown" : value;
  const provenance = { dataset_id: contract.dataset_id, partition: contract.partition, outcome_version: contract.version,
    observation_window: contract.observation_window, outcome_as_of: contract.as_of, stories_enabled: contract.stories_enabled };
  return [
    ...contract.cases.map(c => ({ ...provenance, ...c, grain: "authored_case", supplied_outcome: c.outcome,
      effective_outcome: effective(c.outcome, c.available_at), maturity: c.available_at > contract.as_of ? "immature" : "mature" })),
    ...contract.merchants.map(m => ({ ...provenance, ...m, grain: "authored_merchant", supplied_classification: m.classification,
      effective_classification: effective(m.classification, m.available_at), maturity: m.available_at > contract.as_of ? "immature" : "mature" })),
  ];
}

export function assessScenarioOutcomes(contract: AuthoredOutcomes, events: readonly EventScenarioRow[],
  verdicts: readonly EventVerdictRow[], ruleIds: readonly string[], fireOn: FireOn): Json[] {
  const mature = (available: string) => available <= contract.as_of;
  const fraud = contract.cases.filter(c => c.outcome === "fraud" && mature(c.available_at) && contract.stories_enabled);
  const unknown = contract.cases.filter(c => c.outcome === "unknown" || (!contract.stories_enabled && c.outcome === "fraud"));
  const immature = contract.cases.filter(c => !mature(c.available_at));
  const legitimate = contract.merchants.filter(m => m.classification === "legit" && mature(m.available_at)
    && !contract.cases.some(c => c.merchant_id === m.merchant_id && (c.outcome !== "legit" || !mature(c.available_at))));
  const byEvent = new Map(events.map(e => [e.event_id, e]));
  return [null, ...ruleIds].map(rule => {
    const alerts = verdicts.filter(v => v.verdict === "alert" && (rule === null || v.rule_id === rule));
    const hitCases = new Set(alerts.map(v => byEvent.get(v.event_id)?.case_id));
    const detected = fraud.filter(c => hitCases.has(c.case_id)).map(c => c.case_id).sort();
    const missed = fraud.filter(c => !hitCases.has(c.case_id)).map(c => c.case_id).sort();
    const hitMerchants = new Set(alerts.map(v => v.merchant_id));
    const flagged = legitimate.filter(m => hitMerchants.has(m.merchant_id)).map(m => m.merchant_id).sort();
    const assessed = fraud.length + legitimate.length;
    const status = fireOn !== "alert" ? "unperformed" : assessed === 0 ? "inapplicable" : "performed";
    return { rule_id: rule, scope: "aggregate", segment: null, headline_label: "scenario performance",
      metric_version: "case-merchant-counts-v1", dataset_id: contract.dataset_id, partition: contract.partition,
      outcome_version: contract.version, observation_window: contract.observation_window, outcome_as_of: contract.as_of,
      detected_fraud_case_ids: fireOn === "alert" ? detected : null,
      missed_fraud_case_ids: fireOn === "alert" ? missed : null, fraud_case_denominator: fraud.length,
      detected_fraud_cases: fireOn === "alert" ? detected.length : null,
      missed_fraud_cases: fireOn === "alert" ? missed.length : null,
      legitimate_merchant_denominator: legitimate.length,
      legitimate_merchant_ids: legitimate.map(m => m.merchant_id).sort(),
      incorrectly_flagged_legitimate_merchant_ids: fireOn === "alert" ? flagged : null,
      incorrectly_flagged_legitimate_merchants: fireOn === "alert" ? flagged.length : null,
      unknown_case_ids: unknown.map(c => c.case_id).sort(), immature_case_ids: immature.map(c => c.case_id).sort(),
      excluded_merchant_ids: contract.merchants.filter(m => !legitimate.includes(m)).map(m => m.merchant_id).sort(),
      assessment: { status, scope: "authored mature fraud cases and unique legitimate merchants in the pinned window",
        assessed_count: status === "performed" ? assessed : 0, failure_count: status === "performed" ? missed.length + flagged.length : null },
      corporate_effectiveness: { status: "unperformed", scope: "corporate population", assessed_count: 0, failure_count: null },
    };
  });
}
