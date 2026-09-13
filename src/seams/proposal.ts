// The proposal seam: a proposal file in; a validation verdict out. Every
// agent's output is checked here by code before a human sees it. It checks the
// schema, ranges, evidence, and replay-ungated status.

import { isDeepStrictEqual } from "node:util";
import { readRule, RuleError, type Condition, type Rule } from "../rules.ts";
import { resolveReference, MerchantReferenceError } from "../merchant-reference.ts";
import { isMapping, type YamlValue } from "../yaml.ts";
import type { Manifest } from "./run.ts";

export type ProposalAuthority = { rules: readonly Rule[]; catalog: YamlValue; manifest: Manifest };
export type ProposalAdmission = { state: "admitted" | "rejected"; reasons: string[]; rules: Rule[] | null };

/** Bounded experiment admission is separate from the legacy schema verdict. */
export function applyProposal(doc: YamlValue, authority: ProposalAuthority): ProposalAdmission {
  const reasons = validateProposal(doc).reasons;
  const rules = structuredClone([...authority.rules]);
  if (!isMapping(doc) || !isMapping(doc.change)) return { state: "rejected", reasons, rules: null };
  const { change } = doc;
  rejectUnknownKeys(doc, [...PROPOSAL_REQUIRED_FIELDS, "gate_status", "provenance"], "proposal", reasons);
  rejectUnknownKeys(change, doc.kind === "statistical_conversion" ? ["rule_id", "threshold_id", "thresholds"] : ["rule_id", "thresholds"], "change", reasons);
  if (doc.kind !== "parameter_change" && doc.kind !== "statistical_conversion") reasons.push(`kind ${String(doc.kind)} is not permitted in this experiment`);
  if (doc.tenant !== authority.manifest.tenant) reasons.push(`tenant ${String(doc.tenant)} differs from the authoritative suite`);
  const rule = rules.find(r => r.id === change.rule_id);
  if (rule === undefined) reasons.push(`unknown admitted rule identity ${String(change.rule_id)}`);
  const config = authority.manifest.daily_totals?.reference;
  if (authority.manifest.admitted_rule_ids === undefined || config === undefined) reasons.push("proposal requires an admitted daily suite and catalog reference");
  if (doc.kind === "parameter_change" && !rule?.conditions.some(c => c.kind === "field_factor"
    && c.field === authority.manifest.daily_totals?.feature && c.other_field === config?.feature && c.operator === "gt")) {
    reasons.push(`${String(change.rule_id)}: parameter change requires a merchant-relative daily comparison`);
  }
  if (doc.kind === "parameter_change" && (!Array.isArray(change.thresholds) || !change.thresholds.length)) reasons.push("change.thresholds requires at least one parameter");
  if (Array.isArray(change.thresholds)) {
    const seen = new Set<string>();
    for (const entry of change.thresholds) {
      if (!isMapping(entry)) continue; // Legacy schema validation already names this row.
      const id = String(entry.id);
      rejectUnknownKeys(entry, ["id", "value", "min", "max"], `threshold ${id}`, reasons);
      if (seen.has(id)) reasons.push(`duplicate threshold ${id}`);
      seen.add(id);
      const threshold = rule?.thresholds.find(t => t.id === entry.id);
      if (threshold === undefined) reasons.push(`unknown threshold identity ${String(entry.id)}`);
      else {
        if (id !== config?.sensitivity_parameter && id !== config?.window_parameter) reasons.push(`${id}: parameter change is not permitted`);
        if (entry.min !== threshold.min || entry.max !== threshold.max) reasons.push(`${id}: proposal must not change authoritative bounds`);
        if (typeof entry.value !== "number" || !Number.isFinite(entry.value)
          || entry.value < threshold.min || entry.value > threshold.max) {
          reasons.push(`${id}: value must be inside authoritative range ${threshold.min}..${threshold.max}`);
        } else if (Math.abs((entry.value - threshold.min) / threshold.step - Math.round((entry.value - threshold.min) / threshold.step)) > 1e-9) {
          reasons.push(`${id}: value must follow authoritative step ${threshold.step}`);
        } else threshold.value = entry.value;
      }
    }
  }
  if (doc.kind === "statistical_conversion") {
    const catalog = authority.catalog;
    const permission = isMapping(catalog) && Array.isArray(catalog.permitted_conversions)
      ? catalog.permitted_conversions.find(p => isMapping(p) && p.rule_id === change.rule_id && p.threshold_id === change.threshold_id) : undefined;
    if (rule === undefined || config === undefined || !isMapping(permission)) {
      reasons.push(`conversion ${String(change.threshold_id)} is not authorized by the catalog`);
    } else {
      const comparisons = rule.conditions.filter(
        (condition): condition is Extract<Condition, { kind: "field_constant" }> =>
          condition.kind === "field_constant" && condition.threshold === change.threshold_id,
      );
      const factor = rule.thresholds.find(t => t.id === permission.factor_parameter);
      if (comparisons.length !== 1 || comparisons[0]!.field !== authority.manifest.daily_totals?.feature || comparisons[0]!.operator !== "gt") {
        reasons.push(`conversion ${String(change.threshold_id)} requires one fixed upper-tail daily comparison`);
      } else if (factor === undefined || factor.value !== 1 || factor.min !== 1 || factor.max !== 1) {
        reasons.push(`conversion factor ${String(permission.factor_parameter)} must be locked to 1`);
      } else {
        rule.conditions = rule.conditions.map(condition => condition === comparisons[0]
          ? { kind: "field_factor", field: condition.field, operator: condition.operator, other_field: config.feature, factor: factor.id }
          : condition);
      }
    }
  }
  if (isDeepStrictEqual(rules, authority.rules)) reasons.push("proposal makes no change to the incumbent suite");
  if (!reasons.length) {
    try {
      rules.forEach(rule => readRule(rule, rule.id));
      if (config !== undefined && isMapping(authority.catalog)) resolveReference(config, rules, authority.catalog);
    } catch (error) {
      if (!(error instanceof RuleError) && !(error instanceof MerchantReferenceError)) throw error;
      reasons.push(error.message);
    }
  }
  return reasons.length ? { state: "rejected", reasons, rules: null } : { state: "admitted", reasons, rules };
}

function rejectUnknownKeys(doc: { [key: string]: YamlValue }, allowed: readonly string[], where: string, reasons: string[]): void {
  for (const key of Object.keys(doc)) if (!allowed.includes(key)) reasons.push(`${where}.${key}: unsupported or protected target`);
}

export const PROPOSAL_KINDS = ["parameter_change", "new_rule", "statistical_conversion", "retire_rule", "merge_rules"] as const;
export const PROPOSAL_REQUIRED_FIELDS = ["kind", "tenant", "change", "proving_scenario", "expected_effect"] as const;
const CONSOLIDATION_KINDS = ["retire_rule", "merge_rules"] as const;

export type Verdict = { verdict: "accept" | "reject"; reasons: string[] };

export function validateProposal(doc: YamlValue): Verdict {
  const reasons: string[] = [];
  if (!isMapping(doc)) return { verdict: "reject", reasons: ["proposal must be a mapping"] };
  for (const field of PROPOSAL_REQUIRED_FIELDS) {
    if (doc[field] === undefined || doc[field] === null) reasons.push(`missing ${field}`);
  }
  if (doc.tenant !== undefined && doc.tenant !== null && (typeof doc.tenant !== "string" || doc.tenant.trim() === "")) {
    reasons.push("tenant must be a non-empty string");
  }
  if (doc.change !== undefined && doc.change !== null && !isMapping(doc.change)) reasons.push("change must be a mapping");
  if (doc.proving_scenario !== undefined && doc.proving_scenario !== null && !isMapping(doc.proving_scenario)) {
    reasons.push("proving_scenario must be a mapping");
  }
  if (doc.expected_effect !== undefined && doc.expected_effect !== null && !isMapping(doc.expected_effect)) {
    reasons.push("expected_effect must be a mapping");
  }
  const kind = doc.kind;
  if (kind !== undefined && kind !== null && !(PROPOSAL_KINDS as readonly YamlValue[]).includes(kind)) {
    reasons.push(`kind must be one of ${PROPOSAL_KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
  }
  if (doc.gate_status !== "ungated until replay") reasons.push("gate_status must be ungated until replay");
  if (typeof kind === "string" && (CONSOLIDATION_KINDS as readonly string[]).includes(kind)) {
    if (isMapping(doc.change)) {
      if (typeof doc.change.rule_id !== "string" || doc.change.rule_id.trim() === "") {
        reasons.push("change.rule_id must be a non-empty string");
      }
      if (kind === "merge_rules" && (typeof doc.change.merge_with_rule_id !== "string" || doc.change.merge_with_rule_id.trim() === "")) {
        reasons.push("change.merge_with_rule_id must be a non-empty string");
      }
      if (kind === "merge_rules" && doc.change.rule_id === doc.change.merge_with_rule_id) {
        reasons.push("merge_rules must name two different rule ids");
      }
      if (kind === "retire_rule" && doc.change.merge_with_rule_id !== undefined) {
        reasons.push("retire_rule must not carry merge_with_rule_id");
      }
    }
    validateEvidence(doc.evidence, reasons);
  }
  validateThresholdRanges(doc.change, reasons);
  return reasons.length === 0 ? { verdict: "accept", reasons: [] } : { verdict: "reject", reasons };
}

function validateEvidence(value: YamlValue | undefined, reasons: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    reasons.push("evidence must be a non-empty sequence");
    return;
  }
  for (const [index, row] of value.entries()) {
    if (!isMapping(row)) {
      reasons.push(`evidence[${index}] must be a mapping`);
      continue;
    }
    if (typeof row.run_id !== "string" || row.run_id.trim() === "") {
      reasons.push(`evidence[${index}].run_id must be a non-empty string`);
    }
    if (!Array.isArray(row.rule_ids) || row.rule_ids.length === 0 || row.rule_ids.some((id) => typeof id !== "string" || id.trim() === "")) {
      reasons.push(`evidence[${index}].rule_ids must be a non-empty sequence of rule ids`);
    }
  }
}

function validateThresholdRanges(change: YamlValue | undefined, reasons: string[]): void {
  if (!isMapping(change) || change.thresholds === undefined) return;
  if (!Array.isArray(change.thresholds)) {
    reasons.push("change.thresholds must be a sequence");
    return;
  }
  for (const [index, threshold] of change.thresholds.entries()) {
    if (!isMapping(threshold)) {
      reasons.push(`change.thresholds[${index}] must be a mapping`);
      continue;
    }
    const { value, min, max } = threshold;
    if (
      typeof value !== "number" || !Number.isFinite(value) ||
      typeof min !== "number" || !Number.isFinite(min) ||
      typeof max !== "number" || !Number.isFinite(max) ||
      value < min || value > max
    ) {
      reasons.push(`change.thresholds[${index}].value must be between min and max`);
    }
  }
}
