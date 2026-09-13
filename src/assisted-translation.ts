// Saved model output is input data. Admission never calls a model.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isMapping, type YamlValue } from "./yaml.ts";
import { readRule, referencedFeatureNames, RuleError, type Rule } from "./rules.ts";

export type TranslationResult = {
  status: "admitted" | "unresolved";
  reasons: string[];
  rule: Rule | null;
  candidate: YamlValue;
  interpretation: YamlValue;
  unknown_constructs: YamlValue[];
  catalog: { features: YamlValue[] } | null;
  provenance: {
    kind: "translation";
    translation_id: string;
    source_version: string;
    source_sha256: string;
    model_sha256: string;
    expectations_sha256: string;
  } | null;
};

export function parseAssistedTranslation(sourceText: string, modelText: string, expectationsText: string): TranslationResult {
  const reasons: string[] = [];
  const source = document(sourceText, "source", reasons);
  validateSource(source, reasons);
  const model = document(modelText, "model", reasons);
  const expectations = document(expectationsText, "expectations", reasons);
  const sourceHash = hash(sourceText);
  validateModel(model, source, sourceHash, reasons);
  validateExpectations(expectations, model, sourceHash, reasons);
  let rule: Rule | null = null;
  if (reasons.length === 0 && isMapping(model.candidate) && Array.isArray(expectations.examples)) {
    const tests = expectations.examples.map((example) => isMapping(example)
      ? { name: example.name!, row: example.row!, expected: example.expected! } : example);
    try {
      rule = readRule({ ...model.candidate, tests }, "translation candidate");
      if (rule.id !== source.id) reasons.push("candidate.id must preserve source.id");
      if (!isDeepStrictEqual(rule.applies_to, source.scope)) reasons.push("candidate scope must preserve source.scope");
      if (rule.thresholds.some((threshold) => threshold.min !== threshold.value || threshold.max !== threshold.value)) {
        reasons.push("translation thresholds must be locked; tuning belongs to a separate improvement proposal");
      }
      const names = new Set((source.fields as { name: string }[]).map((field) => field.name));
      for (const name of referencedFeatureNames(rule)) {
        if (!names.has(name)) reasons.push(`candidate feature ${name} is not present in source catalog`);
      }
    } catch (error) {
      if (!(error instanceof RuleError)) throw error;
      reasons.push(error.message);
    }
  }
  if (reasons.length !== 0) rule = null;
  const modelHash = hash(modelText);
  const expectationsHash = hash(expectationsText);
  return {
    status: rule === null ? "unresolved" : "admitted", reasons, rule,
    candidate: model.candidate ?? null,
    interpretation: model.interpretation ?? null,
    unknown_constructs: Array.isArray(model.unsupported_constructs) ? model.unsupported_constructs : [],
    catalog: rule === null ? null : { features: source.fields as YamlValue[] },
    provenance: rule === null ? null : {
      kind: "translation",
      translation_id: `translation-${hash(`${sourceHash}\n${modelHash}\n${expectationsHash}`)}`,
      source_version: source.version as string,
      source_sha256: sourceHash, model_sha256: modelHash, expectations_sha256: expectationsHash,
    },
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function validateModel(model: { [key: string]: YamlValue }, source: { [key: string]: YamlValue }, sourceHash: string, reasons: string[]): void {
  exactKeys(model, ["source_sha256", "producer", "interpretation", "candidate", "unresolved", "unsupported_constructs"], "model", reasons);
  if (model.source_sha256 !== sourceHash) reasons.push("model.source_sha256 does not bind the supplied source");
  if (!isMapping(model.producer)) reasons.push("model.producer must identify the assistance session");
  else {
    exactKeys(model.producer, ["agent", "model", "session"], "model.producer", reasons);
    for (const key of ["agent", "model", "session"]) explicit(model.producer[key], `model.producer.${key}`, reasons);
  }
  if (!isMapping(model.interpretation)) reasons.push("model.interpretation must retain source meaning");
  else {
    exactKeys(model.interpretation, ["summary", "scope", "fields"], "model.interpretation", reasons);
    explicit(model.interpretation.summary, "model.interpretation.summary", reasons);
    for (const key of ["scope", "fields"]) {
      if (!isDeepStrictEqual(model.interpretation[key], source[key])) reasons.push(`model.interpretation.${key} differs from supplied source definitions`);
    }
  }
  unresolved(model.unresolved, "model.unresolved", reasons);
  unresolved(model.unsupported_constructs, "model.unsupported_constructs", reasons);
  if (!isMapping(model.candidate)) reasons.push("model.candidate must be a DSL object");
  else if (!Array.isArray(model.candidate.tests) || model.candidate.tests.length !== 0) {
    reasons.push("model.candidate.tests must be empty; independent examples supply admission evidence");
  }
}

function validateExpectations(expectations: { [key: string]: YamlValue }, model: { [key: string]: YamlValue }, sourceHash: string, reasons: string[]): void {
  exactKeys(expectations, ["source_sha256", "author", "examples"], "expectations", reasons);
  if (expectations.source_sha256 !== sourceHash) reasons.push("expectations.source_sha256 does not bind the supplied source");
  if (!isMapping(expectations.author)) reasons.push("expectations.author must identify independent derivation");
  else {
    exactKeys(expectations.author, ["agent", "basis"], "expectations.author", reasons);
    for (const key of ["agent", "basis"]) explicit(expectations.author[key], `expectations.author.${key}`, reasons);
    if (isMapping(model.producer) && expectations.author.agent === model.producer.agent) {
      reasons.push("expectations must be independent of the translating model session");
    }
  }
  const coverage = new Set<string>();
  const required = ["boundary", "units", "window", "tenant_scope", "risk_scope", "event_scope"];
  if (!Array.isArray(expectations.examples) || expectations.examples.length === 0) reasons.push("expectations.examples must be non-empty");
  else {
    const names = new Set<YamlValue>();
    for (const [index, example] of expectations.examples.entries()) {
      const where = `expectations.examples[${index}]`;
      if (!isMapping(example)) { reasons.push(`${where} must be an example`); continue; }
      exactKeys(example, ["name", "covers", "row", "expected"], where, reasons);
      if (names.has(example.name!)) reasons.push(`${where}: duplicate example name`);
      names.add(example.name!);
      if (!Array.isArray(example.covers) || example.covers.length === 0) reasons.push(`${where}.covers must name its semantic checks`);
      else for (const item of example.covers) {
        if (typeof item !== "string" || !required.includes(item)) reasons.push(`${where}.covers: unsupported coverage ${String(item)}`);
        else coverage.add(item);
      }
    }
  }
  for (const category of required) if (!coverage.has(category)) reasons.push(`independent examples lack ${category} coverage`);
}

function document(text: string, where: string, reasons: string[]): { [key: string]: YamlValue } {
  try {
    const value: YamlValue = JSON.parse(text);
    if (isMapping(value)) return value;
  } catch { /* Malformed inputs are reviewable unresolved results. */ }
  reasons.push(`${where} must be a JSON object`);
  return {};
}

function exactKeys(value: { [key: string]: YamlValue }, allowed: string[], where: string, reasons: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) reasons.push(`${where}: unsupported key ${key}`);
}

function explicit(value: YamlValue | undefined, where: string, reasons: string[]): void {
  if (typeof value !== "string" || value.trim() === "") reasons.push(`${where} must be explicit`);
}

function unresolved(value: YamlValue | undefined, where: string, reasons: string[]): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    reasons.push(`${where} must be a sequence of named unresolved meanings`);
  } else for (const item of value) reasons.push(`${where}: ${String(item)}`);
}

function validateSource(source: { [key: string]: YamlValue }, reasons: string[]): void {
  exactKeys(source, ["id", "version", "text", "scope", "fields", "unresolved"], "source", reasons);
  for (const key of ["id", "version", "text"]) explicit(source[key], `source.${key}`, reasons);
  if (!isMapping(source.scope)) reasons.push("source.scope must define tenant and risk_type");
  else {
    exactKeys(source.scope, ["tenant", "risk_type"], "source.scope", reasons);
    for (const key of ["tenant", "risk_type"]) explicit(source.scope[key], `source.scope.${key}`, reasons);
  }
  unresolved(source.unresolved, "source.unresolved", reasons);
  if (!Array.isArray(source.fields) || source.fields.length === 0) reasons.push("source.fields must be a non-empty sequence");
  else {
    const names = new Set<YamlValue>();
    for (const [index, field] of source.fields.entries()) {
      const where = `source.fields[${index}]`;
      if (!isMapping(field)) { reasons.push(`${where} must be a definition`); continue; }
      exactKeys(field, ["name", "kind", "meaning", "unit", "window", "status"], where, reasons);
      for (const key of ["name", "meaning", "unit", "window"]) explicit(field[key], `${where}.${key}`, reasons);
      if (field.status !== "defined") reasons.push(`${where}.status is missing or ambiguous; must be defined`);
      if (!["derived", "attribute", "list_flag", "baseline"].includes(String(field.kind))) reasons.push(`${where}.kind is unsupported`);
      if (names.has(field.name!)) reasons.push(`${where}: duplicate field name`);
      names.add(field.name!);
    }
  }
}
