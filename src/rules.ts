// The project-owned rule language. Documents are data only:
// a closed conjunction grammar, stable threshold identifiers, scope, and
// worked tests. Evaluation is a pure function of a parsed rule and one row.

import { isMapping, type YamlValue } from "./yaml.ts";
import type { FireOn, Json } from "./ledger.ts";

export const EVENT_KINDS = ["authorization", "settlement"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const MATCH_RESULTS = ["matched", "did_not_match", "not_applicable"] as const;
export type MatchResult = (typeof MATCH_RESULTS)[number];

export const RULE_VERDICTS = ["alert", "suppressed", "did_not_fire", "not_applicable"] as const;
export type RuleVerdict = (typeof RULE_VERDICTS)[number];

const COMPARISON_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte"] as const;
type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

export type Threshold = {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
};

type FieldConstantCondition = {
  kind: "field_constant";
  field: string;
  operator: ComparisonOperator;
  threshold: string;
};

type FieldFactorCondition = {
  kind: "field_factor";
  field: string;
  operator: ComparisonOperator;
  other_field: string;
  factor: string;
};

type MembershipCondition = {
  kind: "membership";
  field: string;
  operator: "in" | "not_in";
  values: string[];
};

type EventTypeCondition = {
  kind: "event_type";
  operator: "eq";
  value: EventKind;
};

export type Condition = FieldConstantCondition | FieldFactorCondition | MembershipCondition | EventTypeCondition;

export type RuleRow = {
  tenant: string;
  risk_type: string;
  kind: EventKind;
  amount?: number;
  currency?: string;
  score?: number | null;
  fields: { [field: string]: string | number | boolean | null };
};

export type RuleTest = {
  name: string;
  row: RuleRow;
  expected: MatchResult;
};

export type Rule = {
  id: string;
  applies_to: { tenant: string; risk_type: string };
  thresholds: Threshold[];
  conditions: Condition[];
  tests: RuleTest[];
};

export function readRule(doc: YamlValue, where: string): Rule {
  const root = mapping(doc, where);
  exactKeys(root, ["id", "applies_to", "thresholds", "conditions", "tests"], where, "grammar construct");

  const scopeDoc = mapping(root.applies_to, `${where}.applies_to`);
  exactKeys(scopeDoc, ["tenant", "risk_type"], `${where}.applies_to`, "scope field");

  const thresholdsDoc = sequence(root.thresholds, `${where}.thresholds`);
  const thresholds = thresholdsDoc.map((value, index) => readThreshold(value, `${where}.thresholds[${index}]`));
  const localIds = new Set<string>();
  for (const threshold of thresholds) {
    if (localIds.has(threshold.id)) throw new RuleError(`${where}: duplicate threshold identifier ${threshold.id}`);
    localIds.add(threshold.id);
  }

  const conditionsDoc = conditionsSequence(root.conditions, `${where}.conditions`);
  if (conditionsDoc.length === 0) throw new RuleError(`${where}.conditions: conjunction must contain at least one condition`);
  const conditions = conditionsDoc.map((value, index) => readCondition(value, `${where}.conditions[${index}]`));
  for (const condition of conditions) {
    const reference = condition.kind === "field_constant" ? condition.threshold : condition.kind === "field_factor" ? condition.factor : undefined;
    if (reference !== undefined && !localIds.has(reference)) {
      throw new RuleError(`${where}: condition references unknown threshold identifier ${reference}`);
    }
  }

  const testsDoc = sequence(root.tests, `${where}.tests`);
  if (testsDoc.length === 0) throw new RuleError(`${where}.tests: every rule must carry at least one test`);
  const tests = testsDoc.map((value, index) => readRuleTest(value, `${where}.tests[${index}]`));

  const rule: Rule = {
    id: nonEmptyString(root.id, `${where}.id`),
    applies_to: {
      tenant: nonEmptyString(scopeDoc.tenant, `${where}.applies_to.tenant`),
      risk_type: nonEmptyString(scopeDoc.risk_type, `${where}.applies_to.risk_type`),
    },
    thresholds,
    conditions,
    tests,
  };
  runRuleTests(rule, where);
  return rule;
}

export function validateRuleSuite(rules: readonly Rule[]): void {
  const ruleIds = new Set<string>();
  const thresholdOwners = new Map<string, string>();
  for (const rule of rules) {
    if (ruleIds.has(rule.id)) throw new RuleError(`rule suite: duplicate rule identifier ${rule.id}`);
    ruleIds.add(rule.id);
    for (const threshold of rule.thresholds) {
      const owner = thresholdOwners.get(threshold.id);
      if (owner !== undefined) {
        throw new RuleError(`rule suite: threshold identifier ${threshold.id} is shared by rules ${owner} and ${rule.id}`);
      }
      thresholdOwners.set(threshold.id, rule.id);
    }
  }
}

export function parameterSnapshot(rules: readonly Rule[]): { [parameterId: string]: Json } {
  return Object.fromEntries(rules.flatMap((rule) => rule.thresholds.map((threshold) => [threshold.id, threshold.value])));
}

export function referencedFeatureNames(rule: Rule): string[] {
  const names = new Set<string>();
  for (const condition of rule.conditions) {
    if (condition.kind === "event_type") continue;
    if (!isEventColumn(condition.field)) names.add(condition.field);
    if (condition.kind === "field_factor" && !isEventColumn(condition.other_field)) names.add(condition.other_field);
  }
  return [...names];
}

export function matchRule(rule: Rule, row: RuleRow): MatchResult {
  if (rule.applies_to.tenant !== row.tenant || rule.applies_to.risk_type !== row.risk_type) return "not_applicable";
  return rule.conditions.every((condition) => conditionMatches(condition, rule, row)) ? "matched" : "did_not_match";
}

export function evaluateRule(rule: Rule, row: RuleRow, fireOn: FireOn): RuleVerdict {
  const result = matchRule(rule, row);
  if (result === "not_applicable") return result;
  if (result === "did_not_match") return "did_not_fire";
  return fireOn === "alert" ? "alert" : "suppressed";
}

function runRuleTests(rule: Rule, where: string): void {
  for (const ruleTest of rule.tests) {
    const actual = matchRule(rule, ruleTest.row);
    if (actual !== ruleTest.expected) {
      throw new RuleError(`${where}: test ${JSON.stringify(ruleTest.name)} expected ${ruleTest.expected}, got ${actual}`);
    }
  }
}

function conditionMatches(condition: Condition, rule: Rule, row: RuleRow): boolean {
  if (condition.kind === "event_type") return row.kind === condition.value;
  const left = fieldValue(row, condition.field);
  if (left === undefined || left === null) return false;
  if (condition.kind === "membership") {
    if (typeof left !== "string") return false;
    const contains = condition.values.includes(left);
    return condition.operator === "in" ? contains : !contains;
  }
  if (typeof left !== "number" || !Number.isFinite(left)) return false;
  if (condition.kind === "field_constant") {
    return compare(left, thresholdValue(rule, condition.threshold), condition.operator);
  }
  const other = fieldValue(row, condition.other_field);
  if (typeof other !== "number" || !Number.isFinite(other)) return false;
  return compare(left, other * thresholdValue(rule, condition.factor), condition.operator);
}

function fieldValue(row: RuleRow, field: string): string | number | boolean | null | undefined {
  if (field === "amount") return row.amount;
  if (field === "currency") return row.currency;
  if (field === "score") return row.score;
  return row.fields[field];
}

function isEventColumn(field: string): boolean {
  return field === "amount" || field === "currency" || field === "score";
}

function thresholdValue(rule: Rule, id: string): number {
  return rule.thresholds.find((threshold) => threshold.id === id)!.value;
}

function compare(left: number, right: number, operator: ComparisonOperator): boolean {
  if (operator === "eq") return left === right;
  if (operator === "ne") return left !== right;
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "lt") return left < right;
  return left <= right;
}

function readThreshold(value: YamlValue, where: string): Threshold {
  const doc = mapping(value, where);
  exactKeys(doc, ["id", "value", "min", "max", "step"], where, "threshold field");
  const threshold: Threshold = {
    id: nonEmptyString(doc.id, `${where}.id`),
    value: finiteNumber(doc.value, `${where}.value`),
    min: finiteNumber(doc.min, `${where}.min`),
    max: finiteNumber(doc.max, `${where}.max`),
    step: finiteNumber(doc.step, `${where}.step`),
  };
  if (threshold.min > threshold.max) throw new RuleError(`${where}: min must not exceed max`);
  if (threshold.step <= 0) throw new RuleError(`${where}.step must be greater than zero`);
  if (threshold.value < threshold.min || threshold.value > threshold.max) {
    throw new RuleError(`${where}: value ${threshold.value} is outside range ${threshold.min}..${threshold.max}`);
  }
  const steps = (threshold.value - threshold.min) / threshold.step;
  if (Math.abs(steps - Math.round(steps)) > 1e-9) {
    throw new RuleError(`${where}: value ${threshold.value} is not on step ${threshold.step} from min ${threshold.min}`);
  }
  return threshold;
}

function readCondition(value: YamlValue, where: string): Condition {
  const doc = mapping(value, where);
  const kind = nonEmptyString(doc.kind, `${where}.kind`);
  if (kind === "field_constant") {
    exactKeys(doc, ["kind", "field", "operator", "threshold"], where, "condition field");
    return {
      kind,
      field: nonEmptyString(doc.field, `${where}.field`),
      operator: oneOf(doc.operator, COMPARISON_OPERATORS, `${where}.operator`),
      threshold: nonEmptyString(doc.threshold, `${where}.threshold`),
    };
  }
  if (kind === "field_factor") {
    exactKeys(doc, ["kind", "field", "operator", "other_field", "factor"], where, "condition field");
    return {
      kind,
      field: nonEmptyString(doc.field, `${where}.field`),
      operator: oneOf(doc.operator, COMPARISON_OPERATORS, `${where}.operator`),
      other_field: nonEmptyString(doc.other_field, `${where}.other_field`),
      factor: nonEmptyString(doc.factor, `${where}.factor`),
    };
  }
  if (kind === "membership") {
    exactKeys(doc, ["kind", "field", "operator", "values"], where, "condition field");
    const values = sequence(doc.values, `${where}.values`).map((item, index) => nonEmptyString(item, `${where}.values[${index}]`));
    if (values.length === 0) throw new RuleError(`${where}.values must not be empty`);
    return {
      kind,
      field: nonEmptyString(doc.field, `${where}.field`),
      operator: oneOf(doc.operator, ["in", "not_in"] as const, `${where}.operator`),
      values,
    };
  }
  if (kind === "event_type") {
    exactKeys(doc, ["kind", "operator", "value"], where, "condition field");
    return {
      kind,
      operator: oneOf(doc.operator, ["eq"] as const, `${where}.operator`),
      value: oneOf(doc.value, EVENT_KINDS, `${where}.value`),
    };
  }
  throw new RuleError(`${where}: unsupported grammar construct ${kind}`);
}

function readRuleTest(value: YamlValue, where: string): RuleTest {
  const doc = mapping(value, where);
  exactKeys(doc, ["name", "row", "expected"], where, "test field");
  return {
    name: nonEmptyString(doc.name, `${where}.name`),
    row: readRuleRow(doc.row, `${where}.row`),
    expected: oneOf(doc.expected, MATCH_RESULTS, `${where}.expected`),
  };
}

export function readRuleRow(value: YamlValue | undefined, where: string): RuleRow {
  const doc = mapping(value, where);
  exactKeys(doc, ["tenant", "risk_type", "kind", "amount", "currency", "score", "fields"], where, "row field", true);
  const fieldsDoc = mapping(doc.fields, `${where}.fields`);
  const fields: RuleRow["fields"] = {};
  for (const [name, fieldValue] of Object.entries(fieldsDoc)) {
    if (isMapping(fieldValue) || Array.isArray(fieldValue)) throw new RuleError(`${where}.fields.${name} must be a scalar`);
    fields[name] = fieldValue;
  }
  return {
    tenant: nonEmptyString(doc.tenant, `${where}.tenant`),
    risk_type: nonEmptyString(doc.risk_type, `${where}.risk_type`),
    kind: oneOf(doc.kind, EVENT_KINDS, `${where}.kind`),
    ...(doc.amount === undefined ? {} : { amount: finiteNumber(doc.amount, `${where}.amount`) }),
    ...(doc.currency === undefined ? {} : { currency: nonEmptyString(doc.currency, `${where}.currency`) }),
    ...(doc.score === undefined ? {} : { score: doc.score === null ? null : finiteNumber(doc.score, `${where}.score`) }),
    fields,
  };
}

function conditionsSequence(value: YamlValue | undefined, where: string): YamlValue[] {
  if (Array.isArray(value)) return value;
  if (isMapping(value)) {
    const construct = Object.keys(value)[0] ?? "mapping";
    throw new RuleError(`${where}: unsupported grammar construct ${construct}; expected a conjunction sequence`);
  }
  throw new RuleError(`${where}: expected a conjunction sequence`);
}

function mapping(value: YamlValue | undefined, where: string): { [key: string]: YamlValue } {
  if (isMapping(value)) return value;
  throw new RuleError(`${where}: expected a mapping`);
}

function sequence(value: YamlValue | undefined, where: string): YamlValue[] {
  if (Array.isArray(value)) return value;
  throw new RuleError(`${where}: expected a sequence`);
}

function exactKeys(
  doc: { [key: string]: YamlValue },
  allowed: readonly string[],
  where: string,
  noun: string,
  optional = false,
): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw new RuleError(`${where}: unsupported ${noun} ${key}`);
  }
  if (!optional) {
    for (const key of allowed) {
      if (!Object.hasOwn(doc, key)) throw new RuleError(`${where}: missing ${noun} ${key}`);
    }
  }
}

function oneOf<T extends string>(value: YamlValue | undefined, allowed: readonly T[], where: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new RuleError(`${where} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
}

function nonEmptyString(value: YamlValue | undefined, where: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new RuleError(`${where} must be a non-empty string`);
}

function finiteNumber(value: YamlValue | undefined, where: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new RuleError(`${where} must be a finite number`);
}
