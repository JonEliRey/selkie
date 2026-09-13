// Internal reference construction. The public boundary remains runCase.
import { isMapping } from "./yaml.ts";
import type { Json } from "./ledger.ts";
import type { Rule } from "./rules.ts";
import type { DailyReplay } from "./daily-totals.ts";

export class MerchantReferenceError extends Error {}
export type MerchantReference = {
  feature: string;
  estimator: "trailing_median_mad";
  sensitivity_parameter: string;
  window_parameter: string;
  minimum_history_parameter: string;
  fallback: "peer_segment_median";
  zero_or_missing_peer: "unavailable";
};
export type ResolvedReference = MerchantReference & {
  sensitivity: number; window_days: number; minimum_history_days: number;
};

export function readMerchantReference(value: Json): MerchantReference {
  const keys = ["feature", "estimator", "sensitivity_parameter", "window_parameter", "minimum_history_parameter", "fallback", "zero_or_missing_peer"];
  if (!isMapping(value) || Object.keys(value).some(k => !keys.includes(k))
    || keys.some(k => typeof value[k] !== "string" || String(value[k]).trim() === "")) {
    throw new MerchantReferenceError("reference requires exactly the declared feature, estimator, parameter bindings and fallback policy");
  }
  if (value.estimator !== "trailing_median_mad" || value.fallback !== "peer_segment_median" || value.zero_or_missing_peer !== "unavailable") {
    throw new MerchantReferenceError("unsupported reference estimator or fallback policy");
  }
  return value as MerchantReference;
}

export function resolveReference(config: MerchantReference, rules: readonly Rule[], catalog: { [key: string]: Json }): ResolvedReference {
  const thresholds = rules.flatMap(r => r.thresholds);
  const parameter = (id: string, maximum: number, integer: boolean): number => {
    const p = thresholds.find(t => t.id === id);
    if (p === undefined || p.min < (integer ? 1 : 0.1) || p.max > maximum
      || (integer && [p.min, p.max, p.step, p.value].some(v => !Number.isSafeInteger(v)))) {
      throw new MerchantReferenceError(`reference parameter ${id} requires ${integer ? "integer bounds 1" : "bounds 0.1"}..${maximum}`);
    }
    return p.value;
  };
  const resolved = { ...config,
    sensitivity: parameter(config.sensitivity_parameter, 20, false),
    window_days: parameter(config.window_parameter, 366, true),
    minimum_history_days: parameter(config.minimum_history_parameter, 366, true),
  };
  if (resolved.minimum_history_days > resolved.window_days) throw new MerchantReferenceError("reference minimum history exceeds window");
  const entry = Array.isArray(catalog.features) ? catalog.features.find(f => isMapping(f) && f.name === config.feature) : undefined;
  if (!isMapping(entry) || entry.kind !== "baseline" || entry.unit !== "minor_currency_units"
    || Object.entries(config).some(([key, value]) => key !== "feature" && entry[key] !== value)) {
    throw new MerchantReferenceError("reference requires a matching baseline catalog definition and parameter bindings");
  }
  return resolved;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : sorted[middle - 1]! / 2 + sorted[middle]! / 2;
}

export function attachMerchantReference(daily: DailyReplay, config: ResolvedReference): void {
  const daysByMerchant = new Map<string, Map<string, number>>();
  for (const row of daily.observations) {
    let days = daysByMerchant.get(String(row.merchant_id));
    if (days === undefined) { days = new Map(); daysByMerchant.set(String(row.merchant_id), days); }
    if (row.status === "complete") days.set(String(row.day), Number(row.total));
  }
  const bySnapshot = new Map<string, number | null>();
  const referencesByDay = new Map<string, typeof daily.snapshots>();
  for (const snapshot of daily.snapshots) {
    const measured = Date.parse(snapshot.as_of_day) - 86400000;
    const values: number[] = [];
    for (let offset = config.window_days; offset > 0; offset--) {
      const day = new Date(measured - offset * 86400000).toISOString().slice(0, 10);
      const value = daysByMerchant.get(snapshot.merchant_id)?.get(day);
      if (value !== undefined) values.push(value);
    }
    const center = values.length === 0 ? null : median(values);
    const mad = center === null ? null : median(values.map(v => Math.abs(v - center)));
    const value = values.length >= config.minimum_history_days && mad !== null && mad > 0
      ? center! + config.sensitivity * mad / 0.6745 : null;
    snapshot.reference = {
      feature: config.feature, measured_day: new Date(measured).toISOString().slice(0, 10),
      window_from: new Date(measured - config.window_days * 86400000).toISOString().slice(0, 10),
      window_to_exclusive: new Date(measured).toISOString().slice(0, 10),
      history_days: values.length, median: center, mad, value,
      status: value === null ? "unavailable_peer_reference" : "merchant_median_mad",
      fallback_reason: values.length < config.minimum_history_days ? "sparse_history" : mad === 0 ? "zero_dispersion" : null,
      peer_median: null, peer_count: 0,
    };
    const day = referencesByDay.get(snapshot.as_of_day) ?? [];
    day.push(snapshot);
    referencesByDay.set(snapshot.as_of_day, day);
  }
  for (const snapshots of referencesByDay.values()) {
    const segments = new Map<string, { snapshot_id: string; median: number }[]>();
    for (const s of snapshots) {
      if (Number(s.reference!.history_days) < config.minimum_history_days) continue;
      const peers = segments.get(s.segment) ?? [];
      peers.push({ snapshot_id: s.snapshot_id, median: Number(s.reference!.median) });
      segments.set(s.segment, peers);
    }
    for (const peers of segments.values()) peers.sort((a, b) => a.median - b.median);
    const positions = new Map([...segments.values()].flatMap(peers => peers.map((p, i) => [p.snapshot_id, i] as const)));
    for (const s of snapshots) {
      const r = s.reference!;
      if (r.fallback_reason !== null) {
        const peers = segments.get(s.segment) ?? [];
        const own = positions.get(s.snapshot_id);
        const count = peers.length - (own === undefined ? 0 : 1);
        const at = (i: number) => peers[own !== undefined && i >= own ? i + 1 : i]!.median;
        const middle = Math.floor(count / 2);
        const peerMedian = count === 0 ? null : count % 2 ? at(middle) : at(middle - 1) / 2 + at(middle) / 2;
        r.peer_count = count;
        r.peer_median = peerMedian;
        r.status = peerMedian === null ? "missing_peer_reference" : "zero_peer_reference";
        if (peerMedian !== null && peerMedian > 0) {
          r.value = config.sensitivity * peerMedian;
          r.status = "peer_segment_median";
        }
      }
      bySnapshot.set(s.snapshot_id, r.value as number | null);
    }
  }
  daily.definition.reference = { ...config, robust_scale: 0.6745,
    formula: "median + sensitivity * MAD / 0.6745", reference_end: "strictly_before_measured_day",
    peer_population: "other_merchants_in_declared_segment_with_minimum_history",
    peer_estimator: "median_of_merchant_medians_in_same_prior_window" };
  daily.scenarios = daily.scenarios.map(event => ({ ...event, fields: { ...event.fields,
    [config.feature]: bySnapshot.get(JSON.stringify([event.merchant_id, event.ts.slice(0, 10)]))!,
  } }));
}
