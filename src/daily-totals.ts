// Internal daily-clock implementation; callers enter through the run seam.
import { isMapping } from "./yaml.ts";
import { checkActiveResources } from "./workload-resources.ts";
import type { EventScenarioRow, Json } from "./ledger.ts";
import { readMerchantReference, type MerchantReference } from "./merchant-reference.ts";

export class DailyTotalsError extends Error {}
export const DAY_BOUNDARY = "midnight_utc_t_minus_1";
const DAY_MS = 86400000;

export type DailyTotals = {
  feature: string;
  counted_kind: "settlement";
  units: "minor_currency_units";
  currency: string;
  lifecycle: "one_settlement_per_transaction";
  day_boundary: typeof DAY_BOUNDARY;
  coverage: { merchant_id: string; segment: string; from: string; to: string }[];
  reference?: MerchantReference;
};

export function readDailyTotals(value: Json): DailyTotals {
  if (!isMapping(value)) throw new DailyTotalsError("daily_totals must be an object");
  exactKeys(value, ["feature", "counted_kind", "units", "currency", "lifecycle", "day_boundary", "coverage", "reference"], "daily_totals");
  if (value.reference !== undefined) readMerchantReference(value.reference);
  for (const [key, expected] of Object.entries({
    counted_kind: "settlement", units: "minor_currency_units",
    lifecycle: "one_settlement_per_transaction", day_boundary: DAY_BOUNDARY,
  })) {
    if (value[key] !== expected) throw new DailyTotalsError(`daily_totals.${key} must be ${expected}`);
  }
  for (const key of ["feature", "currency"]) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new DailyTotalsError(`daily_totals.${key} must be a non-empty string`);
    }
  }
  const reserved = ["amount", "currency", "score", "kind", "tenant", "risk_type", "label", "case_id", "transaction_id"];
  if (reserved.includes(String(value.feature))) {
    throw new DailyTotalsError(`daily_totals.feature ${value.feature} is reserved`);
  }
  if (isMapping(value.reference) && ([...reserved, "event_id", "merchant_id", "segment", "ts", "score_provenance"].includes(String(value.reference.feature)) || value.reference.feature === value.feature)) {
    throw new DailyTotalsError("reference.feature is reserved or collides with the daily total");
  }
  if (!Array.isArray(value.coverage)) throw new DailyTotalsError("daily_totals.coverage must be an array");
  const merchants = new Set<string>();
  for (const coverage of value.coverage) {
    if (!isMapping(coverage)) throw new DailyTotalsError("coverage must be an object");
    exactKeys(coverage, ["merchant_id", "segment", "from", "to"], "coverage");
    for (const key of ["merchant_id", "segment", "from", "to"]) {
      if (typeof coverage[key] !== "string" || coverage[key].trim() === "") {
        throw new DailyTotalsError(`coverage.${key} must be a non-empty string`);
      }
    }
    const merchant = String(coverage.merchant_id);
    if (merchants.has(merchant)) throw new DailyTotalsError(`duplicate merchant coverage ${merchant}`);
    merchants.add(merchant);
    const start = timestamp(String(coverage.from));
    const end = timestamp(String(coverage.to));
    if (start >= end) throw new DailyTotalsError("coverage.from must precede coverage.to");
  }
  return value as DailyTotals;
}

function exactKeys(value: { [key: string]: Json }, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new DailyTotalsError(`${where}: unknown field ${key}`);
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new DailyTotalsError(`daily history timestamp must be canonical UTC ISO with milliseconds: ${value}`);
  }
  return parsed;
}

function dayBoundary(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new DailyTotalsError("observation window must use YYYY-MM-DD boundaries");
  return timestamp(`${day}T00:00:00.000Z`);
}

/** One shared UTC midnight convention for the grid, windows, and event attachment. */
export function utcDay(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export type DailyReplay = {
  scenarios: EventScenarioRow[];
  snapshots: DailySnapshot[];
  observations: { [key: string]: Json }[];
  definition: { [key: string]: Json };
};

export type DailySnapshot = {
  snapshot_id: string; merchant_id: string; segment: string; as_of_day: string;
  observation_id: string; value: number | null; status: string;
  reference?: { [key: string]: Json };
};

export function replayDailyTotals(
  config: DailyTotals,
  events: readonly EventScenarioRow[],
  window: { from: string; to: string },
  admission: { tenant: string; currency: string; maxMerchantDays: number; catalog: { [key: string]: Json }; referenceWindowDays?: number },
): DailyReplay {
  const from = dayBoundary(window.from);
  const to = dayBoundary(window.to);
  if (from >= to) throw new DailyTotalsError("observation window.from must precede window.to");
  const referenceWindow = admission.referenceWindowDays ?? 0;
  const merchantDays = ((to - from) / DAY_MS + 1 + referenceWindow) * config.coverage.length;
  if (!Number.isSafeInteger(merchantDays) || merchantDays > admission.maxMerchantDays) {
    throw new DailyTotalsError(`merchant-day count ${merchantDays} exceeds workload.max_events bound ${admission.maxMerchantDays}`);
  }
  if (config.currency !== admission.currency) throw new DailyTotalsError("daily_totals currency differs from manifest currency");
  const features = admission.catalog.features;
  const feature = Array.isArray(features) ? features.find(f => isMapping(f) && f.name === config.feature) : undefined;
  if (!isMapping(feature) || feature.kind !== "derived" || feature.unit !== config.units || feature.window_days !== 1) {
    throw new DailyTotalsError("daily_totals feature requires a catalog derived feature with matching unit and window_days: 1");
  }
  const coverageByMerchant = new Map(config.coverage.map(c => [c.merchant_id, c]));
  const totals = new Map<string, Map<string, number>>();
  const settlements = new Map<string, Set<string>>();
  for (const event of events) {
    const when = timestamp(event.ts);
    const coverage = coverageByMerchant.get(event.merchant_id);
    if (coverage === undefined) throw new DailyTotalsError(`missing coverage for merchant ${event.merchant_id}`);
    if (when < Date.parse(coverage.from) || when >= Date.parse(coverage.to)) {
      throw new DailyTotalsError(`event ${event.event_id} outside declared coverage`);
    }
    if (event.tenant !== admission.tenant) throw new DailyTotalsError(`event ${event.event_id} tenant differs from manifest`);
    if (event.segment !== coverage.segment) throw new DailyTotalsError(`event ${event.event_id} segment differs from coverage`);
    if (event.currency !== config.currency) throw new DailyTotalsError(`event ${event.event_id} currency differs from measurement`);
    if (!Number.isSafeInteger(event.amount) || event.amount < 0) throw new DailyTotalsError(`event ${event.event_id} amount must be a non-negative safe integer in minor currency units`);
    if (Object.hasOwn(event.fields, config.feature)) throw new DailyTotalsError(`event ${event.event_id} supplied a computed daily feature`);
    if (config.reference !== undefined && Object.hasOwn(event.fields, config.reference.feature)) {
      throw new DailyTotalsError(`event ${event.event_id} supplied a computed reference feature`);
    }
    if (event.kind !== config.counted_kind) continue;
    let seen = settlements.get(event.merchant_id);
    if (seen === undefined) { seen = new Set(); settlements.set(event.merchant_id, seen); }
    if (seen.has(event.transaction_id!)) throw new DailyTotalsError(`duplicate settlement for transaction ${event.transaction_id}`);
    seen.add(event.transaction_id!);
    let merchant = totals.get(event.merchant_id);
    if (merchant === undefined) { merchant = new Map(); totals.set(event.merchant_id, merchant); }
    const day = utcDay(event.ts);
    const total = (merchant.get(day) ?? 0) + event.amount;
    if (!Number.isSafeInteger(total)) throw new DailyTotalsError(`merchant-day total must be a safe integer: ${event.merchant_id} ${day}`);
    merchant.set(day, total);
  }
  const snapshots: DailyReplay["snapshots"] = [];
  const observations: DailyReplay["observations"] = [];
  const values = new Map<string, Map<string, number | null>>();
  for (const coverage of config.coverage) {
    checkActiveResources();
    const merchantValues = new Map<string, number | null>();
    values.set(coverage.merchant_id, merchantValues);
    for (let boundary = from - referenceWindow * DAY_MS; boundary <= to; boundary += DAY_MS) {
      const asOf = utcDay(new Date(boundary).toISOString());
      const previous = utcDay(new Date(boundary - DAY_MS).toISOString());
      const status = Date.parse(coverage.from) >= boundary ? "missing_history"
        : Date.parse(coverage.from) > boundary - DAY_MS ? "partial_history"
        : Date.parse(coverage.to) < boundary ? "open_day" : "complete";
      const value = status === "complete" ? totals.get(coverage.merchant_id)?.get(previous) ?? 0 : null;
      const observationId = JSON.stringify([coverage.merchant_id, previous]);
      observations.push({
        observation_id: observationId, grain: "merchant_day", merchant_id: coverage.merchant_id,
        segment: coverage.segment, day: previous, status, total: value,
        warmup: boundary <= from, window_from: new Date(boundary - DAY_MS).toISOString(),
        window_to_exclusive: new Date(boundary).toISOString(),
        available_at: status === "complete" ? new Date(boundary).toISOString() : null,
        coverage_from: coverage.from, coverage_to_exclusive: coverage.to,
      });
      if (boundary < from || boundary === to) continue;
      merchantValues.set(asOf, value);
      snapshots.push({ snapshot_id: JSON.stringify([coverage.merchant_id, asOf]), observation_id: observationId,
        merchant_id: coverage.merchant_id, segment: coverage.segment, as_of_day: asOf, value, status });
    }
  }
  return {
    snapshots,
    observations,
    definition: {
      feature: config.feature, counted_kind: config.counted_kind, units: config.units, currency: config.currency,
      lifecycle: config.lifecycle, day_boundary: config.day_boundary,
      window_days: 1, build: "previous_day_start <= event_ts < snapshot_boundary",
      attach: "snapshot_boundary <= event_ts", scored_kinds: ["authorization", "settlement"],
      warmup_days: referenceWindow + 1, missing_history: "null_and_unavailable", empty_complete_day: 0,
    },
    scenarios: [...events].filter(e => Date.parse(e.ts) >= from && Date.parse(e.ts) < to)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || (a.event_id < b.event_id ? -1 : 1))
      .map(event => ({ ...event, fields: { ...event.fields, [config.feature]: values.get(event.merchant_id)!.get(utcDay(event.ts))! } })),
  };
}
