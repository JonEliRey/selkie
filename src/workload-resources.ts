// Common run resource policy. Operational observations never enter ledger rows.
import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping, type YamlValue } from "./yaml.ts";

export const RESOURCE_LIMITS = {
  max_input_bytes: 64_000_000,
  max_output_bytes: 256 * 1024 * 1024,
  max_peak_rss_bytes: 1024 * 1024 * 1024,
  max_elapsed_ms: 60_000,
  max_days: 366,
  max_events: 250_000,
  max_rules: 64,
  max_results: 8_000_000,
  max_candidates: 100,
  max_seeds: 100,
} as const;
export type ResourceLimits = { [K in keyof typeof RESOURCE_LIMITS]: number };
export type ResourceOptions = Partial<ResourceLimits>;
export class WorkloadResourceError extends Error {}
const active = new AsyncLocalStorage<{ limits: ResourceLimits; started: number }>();

export function resourceLimits(options: ResourceOptions = {}): ResourceLimits {
  const ceiling = active.getStore()?.limits ?? RESOURCE_LIMITS;
  const limits = { ...ceiling, ...options };
  for (const key of Object.keys(limits) as (keyof ResourceLimits)[]) {
    if (!(key in RESOURCE_LIMITS) || !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > ceiling[key]) {
      throw new WorkloadResourceError(`invalid_resource_limit: ${key}`);
    }
  }
  return limits;
}
export function withResources<T>(limits: ResourceLimits, action: () => T): T {
  return active.run({ limits, started: active.getStore()?.started ?? performance.now() }, action);
}
export function checkActiveResources(): void {
  const current = active.getStore();
  if (current !== undefined) resourceCheckpoint(current.limits, current.started);
}
export function enforceResource(name: string, actual: number, maximum: number): void {
  if (!Number.isSafeInteger(actual) || actual > maximum) {
    // Stable reason only: process timing/RSS observations must not enter JSONL.
    throw new WorkloadResourceError(`workload_${name}_exceeded`);
  }
}
export function resourceCheckpoint(limits: ResourceLimits, started: number): void {
  enforceResource("elapsed_ms", Math.ceil(performance.now() - started), limits.max_elapsed_ms);
  // OS-reported process lifetime high-water mark, KiB, including native buffers.
  enforceResource("peak_rss_bytes", process.resourceUsage().maxRSS * 1024, limits.max_peak_rss_bytes);
}
export function directoryBytes(dir: string): number {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) throw new WorkloadResourceError("workload_path_denied: symbolic link");
  return stat.isDirectory() ? readdirSync(dir).reduce((sum, name) => sum + directoryBytes(join(dir, name)), 0) : stat.size;
}

/** Cheap admission before parsing event rows or constructing the daily grid. */
export function preflightHistory(dir: string, limits: ResourceLimits): void {
  enforceResource("input_bytes", directoryBytes(dir), limits.max_input_bytes);
  const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (!isMapping(raw)) return; // The manifest reader owns malformed-schema errors.
  const calendar = (window: YamlValue | undefined) => {
    if (!isMapping(window) || typeof window.from !== "string" || typeof window.to !== "string") return;
    const days = Math.ceil((Date.parse(window.to) - Date.parse(window.from)) / 86400000);
    if (Number.isFinite(days) && days >= 0) enforceResource("days", days, limits.max_days);
  };
  if (isMapping(raw.daily_totals) && Array.isArray(raw.daily_totals.coverage)) {
    for (const coverage of raw.daily_totals.coverage) calendar(coverage);
    // Dense daily features can exceed event cardinality on sparse histories.
    if (isMapping(raw.comparability) && isMapping(raw.comparability.observation_window)) {
      const window = raw.comparability.observation_window;
      if (typeof window.from === "string" && typeof window.to === "string") {
        const days = Math.ceil((Date.parse(window.to) - Date.parse(window.from)) / 86400000);
        if (Number.isFinite(days) && days >= 0) {
          const cells = raw.daily_totals.coverage.length * (days + 1);
          if (isMapping(raw.workload) && typeof raw.workload.max_events === "number" && cells > raw.workload.max_events) {
            throw new WorkloadResourceError("workload_merchant_days_exceeded: merchant-day count exceeds workload.max_events bound");
          }
          enforceResource("merchant_days", cells, limits.max_results);
        }
      }
    }
  }
  if (isMapping(raw.comparability)) calendar(raw.comparability.observation_window);
  const events = readFileSync(join(dir, "scenarios.jsonl"), "utf8").split("\n").filter(line => line.trim() !== "").length;
  const rules = Array.isArray(raw.admitted_rule_ids) ? raw.admitted_rule_ids.length
    : readdirSync(join(dir, "suite/rules")).filter(name => name.endsWith(".yaml")).length;
  enforceResource("events", events, limits.max_events);
  enforceResource("rules", rules, limits.max_rules);
  enforceResource("results", events * rules, limits.max_results);
}
