// Post-replay diagnostics only. Outcome truth never enters feature construction.
import type { DailyReplay } from "./daily-totals.ts";
import type { EventScenarioRow, Json } from "./ledger.ts";

export function assessReferenceHistory(daily: DailyReplay, events: readonly EventScenarioRow[]): { [key: string]: Json }[] {
  const labelsByDay = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== "settlement") continue;
    const key = JSON.stringify([event.merchant_id, event.ts.slice(0, 10)]);
    const labels = labelsByDay.get(key) ?? new Set<string>();
    labels.add(event.label ?? "unknown");
    labelsByDay.set(key, labels);
  }
  const completed = new Set(daily.observations.filter(o => o.status === "complete").map(o => String(o.observation_id)));
  return daily.snapshots.map(s => {
    const r = s.reference!;
    let fraud = 0;
    let legit = 0;
    let unknown = 0;
    for (let when = Date.parse(String(r.window_from)); when < Date.parse(String(r.window_to_exclusive)); when += 86400000) {
      const key = JSON.stringify([s.merchant_id, new Date(when).toISOString().slice(0, 10)]);
      if (!completed.has(key)) continue;
      const labels = labelsByDay.get(key);
      if (labels?.has("fraud")) fraud++;
      else if (labels?.size === 1 && labels.has("legit")) legit++;
      else unknown++;
    }
    const count = fraud + legit + unknown;
    return { snapshot_id: s.snapshot_id, merchant_id: s.merchant_id, segment: s.segment,
      as_of_day: s.as_of_day, measured_day: r.measured_day!, grain: "reference_assessment",
      complete_history_days: count, authored_fraud_days: fraud, authored_legit_days: legit,
      unknown_days: unknown, authored_fraud_fraction: count === 0 ? null : fraud / count,
      assessment: fraud > count / 2 ? "majority_authored_fraud" : unknown > 0 || count === 0 ? "incomplete_outcome_truth" : "authored_outcomes_available",
      use: "diagnostic_only_never_filters_reference",
    };
  });
}
