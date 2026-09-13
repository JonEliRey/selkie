// The parser seam: a synthetic export document in; reviewable DSL candidates,
// an unknown-construct list, and a proposed feature catalog out.
// A rule is translated only when every one of its clauses is understood.

import type { Json } from "../ledger.ts";
import { isMapping } from "../yaml.ts";

export { parseAssistedTranslation } from "../assisted-translation.ts";

const COMPARISON_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte"] as const;
const EVENT_KINDS = ["authorization", "settlement"] as const;

type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];
type EventKind = (typeof EVENT_KINDS)[number];
type FeatureKind = "derived" | "attribute" | "list_flag" | "baseline";

export type UnknownConstruct = { rule_id: string; construct: string; reason: string };
export type FeatureCatalogProposal = {
  features: { name: string; kind: FeatureKind; status: "proposed" }[];
};
export type ParseResult = {
  rules: Json[];
  unknown_constructs: UnknownConstruct[];
  feature_catalog_proposal: FeatureCatalogProposal;
};

type RuleEnvelope = {
  id: string;
  riskType: string;
  fields: string[];
  clauses: Json[];
};

type ParsedThreshold = { id: string; value: number; min: number; max: number; step: number };
type ParsedCondition =
  | { kind: "field_constant"; field: string; operator: ComparisonOperator; threshold: string }
  | { kind: "field_factor"; field: string; operator: ComparisonOperator; other_field: string; factor: string }
  | { kind: "membership"; field: string; operator: "in" | "not_in"; values: string[] }
  | { kind: "event_type"; operator: "eq"; value: EventKind };

export class ExportError extends Error {}

class UnsupportedRuleConstruct extends Error {
  readonly construct: string;

  constructor(construct: string) {
    super(`unsupported condition construct ${construct}`);
    this.construct = construct;
  }
}

export function parseExport(doc: Json): ParseResult {
  const root = mapping(doc, "export");
  exactKeys(root, ["format", "tenant", "rules"], "export");
  if (root.format !== "synthetic-export-v0") {
    throw new ExportError(`export.format must be synthetic-export-v0, got ${JSON.stringify(root.format)}`);
  }
  const tenant = nonEmptyString(root.tenant, "export.tenant");
  const ruleDocs = sequence(root.rules, "export.rules");
  const envelopes = ruleDocs.map((rule, index) => readRuleEnvelope(rule, index));
  ensureUniqueRuleIds(envelopes);

  const rules: Json[] = [];
  const unknown_constructs: UnknownConstruct[] = [];
  for (const rule of envelopes) {
    try {
      rules.push(translateRule(rule, tenant));
    } catch (error) {
      if (!(error instanceof UnsupportedRuleConstruct)) throw error;
      unknown_constructs.push({
        rule_id: rule.id,
        construct: error.construct,
        reason: error.message,
      });
    }
  }

  const names = [...new Set(envelopes.flatMap((rule) => rule.fields))].sort(compareCodePoints);
  const feature_catalog_proposal: FeatureCatalogProposal = {
    features: names.map((name) => ({ name, kind: guessFeatureKind(name), status: "proposed" })),
  };
  return { rules, unknown_constructs, feature_catalog_proposal };
}

function readRuleEnvelope(value: Json, index: number): RuleEnvelope {
  const where = `export.rules[${index}]`;
  const doc = mapping(value, where);
  exactKeys(doc, ["id", "risk_type", "fields", "clauses"], where);
  const id = nonEmptyString(doc.id, `${where}.id`);
  const fields = sequence(doc.fields, `${where}.fields`).map((field, fieldIndex) =>
    nonEmptyString(field, `${where}.fields[${fieldIndex}]`),
  );
  if (new Set(fields).size !== fields.length) throw new ExportError(`${where}.fields contains a duplicate name`);
  return {
    id,
    riskType: nonEmptyString(doc.risk_type, `${where}.risk_type`),
    fields,
    clauses: sequence(doc.clauses, `${where}.clauses`),
  };
}

function ensureUniqueRuleIds(rules: readonly RuleEnvelope[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new ExportError(`export.rules contains duplicate rule id ${rule.id}`);
    ids.add(rule.id);
  }
}

function translateRule(rule: RuleEnvelope, tenant: string): Json {
  if (rule.clauses.length === 0) throw new UnsupportedRuleConstruct("empty_conjunction");
  const thresholds: ParsedThreshold[] = [];
  const conditions = rule.clauses.map((clause, index) => translateClause(clause, rule, index, thresholds));
  return {
    id: rule.id,
    applies_to: { tenant, risk_type: rule.riskType },
    thresholds,
    conditions,
    tests: [],
  };
}

function translateClause(value: Json, rule: RuleEnvelope, index: number, thresholds: ParsedThreshold[]): ParsedCondition {
  const where = `export rule ${rule.id} clause ${index + 1}`;
  const doc = mapping(value, where);
  const construct = nonEmptyString(doc.construct, `${where}.construct`);
  if (construct === "compare_value") {
    exactKeys(doc, ["construct", "field", "operator", "value"], where);
    const field = declaredField(doc.field, rule, `${where}.field`);
    const operator = recognizedOneOf(doc.operator, COMPARISON_OPERATORS, "compare_value.operator");
    const literal = recognizedNumber(doc.value, "compare_value.value");
    const id = thresholdId(rule.id, index, "value");
    thresholds.push(lockedThreshold(id, literal));
    return { kind: "field_constant", field, operator, threshold: id };
  }
  if (construct === "compare_factor") {
    exactKeys(doc, ["construct", "field", "operator", "other_field", "factor"], where);
    const field = declaredField(doc.field, rule, `${where}.field`);
    const other_field = declaredField(doc.other_field, rule, `${where}.other_field`);
    const operator = recognizedOneOf(doc.operator, COMPARISON_OPERATORS, "compare_factor.operator");
    const literal = recognizedNumber(doc.factor, "compare_factor.factor");
    const id = thresholdId(rule.id, index, "factor");
    thresholds.push(lockedThreshold(id, literal));
    return { kind: "field_factor", field, operator, other_field, factor: id };
  }
  if (construct === "in_list") {
    exactKeys(doc, ["construct", "field", "operator", "values"], where);
    const field = declaredField(doc.field, rule, `${where}.field`);
    const operator = recognizedOneOf(doc.operator, ["in", "not_in"] as const, "in_list.operator");
    const values = recognizedStringList(doc.values, "in_list.values");
    if (values.length === 0) throw new ExportError(`${where}.values must not be empty`);
    return { kind: "membership", field, operator, values };
  }
  if (construct === "event_kind") {
    exactKeys(doc, ["construct", "operator", "value"], where);
    return {
      kind: "event_type",
      operator: recognizedOneOf(doc.operator, ["eq"] as const, "event_kind.operator"),
      value: recognizedOneOf(doc.value, EVENT_KINDS, "event_kind.value"),
    };
  }
  throw new UnsupportedRuleConstruct(construct);
}

function thresholdId(ruleId: string, clauseIndex: number, operand: "value" | "factor"): string {
  return `${ruleId}::clause-${clauseIndex + 1}::${operand}`;
}

function lockedThreshold(id: string, value: number): ParsedThreshold {
  return { id, value, min: value, max: value, step: 1 };
}

function guessFeatureKind(name: string): FeatureKind {
  if (name.endsWith("_baseline")) return "baseline";
  if (name.endsWith("_list_flag")) return "list_flag";
  if (/^(?:count|sum|max|avg|average|ratio)_/.test(name)) return "derived";
  return "attribute";
}

function declaredField(value: Json | undefined, rule: RuleEnvelope, where: string): string {
  const field = nonEmptyString(value, where);
  if (!rule.fields.includes(field)) throw new ExportError(`${where}: ${field} is not declared in the rule's fields`);
  return field;
}

function mapping(value: Json | undefined, where: string): { [key: string]: Json } {
  if (isMapping(value)) return value;
  throw new ExportError(`${where} must be an object`);
}

function sequence(value: Json | undefined, where: string): Json[] {
  if (Array.isArray(value)) return value;
  throw new ExportError(`${where} must be an array`);
}

function exactKeys(doc: { [key: string]: Json }, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw new ExportError(`${where}: unknown field ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(doc, key)) throw new ExportError(`${where}: missing field ${key}`);
  }
}

function recognizedOneOf<T extends string>(value: Json | undefined, allowed: readonly T[], position: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new UnsupportedRuleConstruct(`${position}=${grammarForm(value)}`);
}

function nonEmptyString(value: Json | undefined, where: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new ExportError(`${where} must be a non-empty string`);
}

function recognizedNumber(value: Json | undefined, position: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new UnsupportedRuleConstruct(`${position}=${grammarForm(value)}`);
}

function recognizedStringList(value: Json | undefined, position: string): string[] {
  if (!Array.isArray(value)) throw new UnsupportedRuleConstruct(`${position}=${grammarForm(value)}`);
  return value.map((item, index) => {
    if (typeof item === "string" && item.trim() !== "") return item;
    throw new UnsupportedRuleConstruct(`${position}[${index}]=${grammarForm(item)}`);
  });
}

function grammarForm(value: Json | undefined): string {
  if (isMapping(value)) {
    if (typeof value.construct === "string" && value.construct.trim() !== "") return value.construct;
    return "object";
  }
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (typeof value === "string") return value === "" ? "empty_string" : value;
  if (typeof value === "number" && !Number.isFinite(value)) return "non_finite_number";
  return typeof value;
}

function compareCodePoints(left: string, right: string): number {
  const leftCharacters = Array.from(left);
  const rightCharacters = Array.from(right);
  const sharedLength = Math.min(leftCharacters.length, rightCharacters.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPoint = leftCharacters[index]?.codePointAt(0);
    const rightPoint = rightCharacters[index]?.codePointAt(0);
    if (leftPoint !== rightPoint) return (leftPoint ?? 0) - (rightPoint ?? 0);
  }
  return leftCharacters.length - rightCharacters.length;
}
