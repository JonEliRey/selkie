// Alert rows are a historical scenario source.
// The source-column mapping is data, not engine code (registers:
// alert_row_columns, alert_export_all_rules); timestamps normalize to UTC
// (day_boundary), and unmapped resolutions remain unknown by construction
// (unknown_resolution_bucket, resolution_values).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, checkNumberLiterals, readCanonicalNumberLiteral, RunError } from "./seams/run.ts";
import { isMapping, parseYaml, YamlError, type YamlValue } from "./yaml.ts";
import { RuleError, readRule, validateRuleSuite, type Rule } from "./rules.ts";

export const RESOLUTION_LABELS = ["fraud", "legit", "unknown"] as const;
export type ResolutionLabel = (typeof RESOLUTION_LABELS)[number];

const COLUMN_ROLES = ["rule_id", "fields", "resolution", "timestamp", "tenant", "amount", "score", "event_key"] as const;
type ColumnRole = (typeof COLUMN_ROLES)[number];

export type AlertScenario = {
  source_row: number;
  rule_id: string;
  fields: { [field: string]: YamlValue };
  tenant: string;
  risk_type: string;
  label: ResolutionLabel;
  mapping_version: string;
  alert_at: string;
  amount: number | null;
  score: number | null;
  event_key: string | null;
};

export type AlertScenarioSet = {
  mapping_version: string;
  availability: {
    amount: boolean;
    score: boolean;
    event_key: boolean;
  };
  scenarios: AlertScenario[];
};

export type AlertLoadReport = {
  rows_loaded: number;
  unknown_resolutions: { value: string; count: number }[];
};

export type AlertRowLoadResult = {
  scenario_set: AlertScenarioSet;
  report: AlertLoadReport;
};

export class AlertRowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AlertRowError";
  }
}

function toAlertRowError(error: RunError | RuleError | YamlError): AlertRowError {
  return new AlertRowError(error.message, { cause: error });
}

type ResolutionMapping = {
  version: string;
  columns: Record<ColumnRole, string>;
  resolutions: Record<string, ResolutionLabel>;
};

type CsvRecord = { row: number; values: string[] };

/**
 * Alert-row-loader seam for historical alerts: synthetic CSV, versioned mapping,
 * and the suite that owns the referenced rules in; canonical scenario set
 * plus an auditable unknown-resolution report out.
 */
export function loadAlertRows(alertRowsPath: string, resolutionMappingPath: string, suiteDir: string): AlertRowLoadResult {
  const mapping = readResolutionMapping(resolutionMappingPath);
  const rulesById = readRulesById(suiteDir);
  const records = parseCsv(readFileSync(alertRowsPath, "utf8"), alertRowsPath);
  if (records.length === 0) throw new AlertRowError(`${alertRowsPath}: missing header row`);

  const header = records[0]!.values.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value);
  const headerIndexes = indexHeader(header, alertRowsPath);
  const admittedHeaders = new Set(Object.values(mapping.columns));
  for (const name of header) {
    if (!admittedHeaders.has(name)) throw new AlertRowError(`${alertRowsPath}: row 1: unknown column ${name}`);
  }
  for (const role of ["rule_id", "fields", "resolution", "timestamp"] as const) {
    const column = mapping.columns[role];
    if (!headerIndexes.has(column)) throw new AlertRowError(`${alertRowsPath}: row 1: missing required column ${column} (${role})`);
  }

  const availability = {
    amount: headerIndexes.has(mapping.columns.amount),
    score: headerIndexes.has(mapping.columns.score),
    event_key: headerIndexes.has(mapping.columns.event_key),
  };
  const unknownCounts = new Map<string, number>();
  const scenarios: AlertScenario[] = [];

  for (const record of records.slice(1)) {
    if (record.values.length !== header.length) {
      throw new AlertRowError(`${alertRowsPath}: row ${record.row} has ${record.values.length} fields; header has ${header.length}`);
    }
    const value = (role: ColumnRole): string | undefined => {
      const index = headerIndexes.get(mapping.columns[role]);
      return index === undefined ? undefined : record.values[index];
    };
    const ruleId = requiredCell(value("rule_id"), `${alertRowsPath}: row ${record.row}: missing rule identifier`);
    const rule = rulesById.get(ruleId);
    if (rule === undefined) throw new AlertRowError(`${alertRowsPath}: row ${record.row}: rule ${ruleId} is not in the suite`);

    const suppliedTenant = optionalText(value("tenant"));
    if (suppliedTenant !== null && suppliedTenant !== rule.applies_to.tenant) {
      throw new AlertRowError(
        `${alertRowsPath}: row ${record.row}: tenant ${suppliedTenant} disagrees with rule ${ruleId} tenant ${rule.applies_to.tenant}`,
      );
    }

    const resolution = requiredExactCell(value("resolution"), `${alertRowsPath}: row ${record.row}: missing resolution value`);
    const mappedResolution = Object.hasOwn(mapping.resolutions, resolution);
    const label = mappedResolution ? mapping.resolutions[resolution]! : "unknown";
    if (!mappedResolution) {
      unknownCounts.set(resolution, (unknownCounts.get(resolution) ?? 0) + 1);
    }

    scenarios.push({
      source_row: record.row,
      rule_id: ruleId,
      fields: parseFields(value("fields"), alertRowsPath, record.row),
      tenant: rule.applies_to.tenant,
      risk_type: rule.applies_to.risk_type,
      label,
      mapping_version: mapping.version,
      alert_at: normalizedTimestamp(value("timestamp"), alertRowsPath, record.row, mapping.columns.timestamp),
      amount: optionalNumber(value("amount"), alertRowsPath, record.row, mapping.columns.amount),
      score: optionalNumber(value("score"), alertRowsPath, record.row, mapping.columns.score),
      event_key: optionalEventKey(value("event_key"), alertRowsPath, record.row, mapping.columns.event_key),
    });
  }

  return {
    scenario_set: {
      mapping_version: mapping.version,
      availability,
      scenarios,
    },
    report: {
      rows_loaded: scenarios.length,
      unknown_resolutions: [...unknownCounts].map(([value, count]) => ({ value, count })),
    },
  };
}

/** Exact bytes use canonicalJson recursive key order and one trailing LF. */
export function serializeAlertRowLoadResult(result: AlertRowLoadResult): string {
  return canonicalJson(result as unknown as YamlValue) + "\n";
}

function readResolutionMapping(path: string): ResolutionMapping {
  let document: YamlValue;
  try {
    document = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof YamlError) throw toAlertRowError(error);
    throw error;
  }
  const root = mapping(document, `${path}`);
  exactKeys(root, ["version", "columns", "resolutions"], path);
  const columnsDoc = mapping(root.columns, `${path}.columns`);
  exactKeys(columnsDoc, COLUMN_ROLES, `${path}.columns`);
  const columns = Object.fromEntries(
    COLUMN_ROLES.map((role) => [role, nonEmptyString(columnsDoc[role], `${path}.columns.${role}`)]),
  ) as Record<ColumnRole, string>;
  const sourceColumns = new Set(Object.values(columns));
  if (sourceColumns.size !== COLUMN_ROLES.length) throw new AlertRowError(`${path}.columns: source column names must be unique`);

  const resolutionsDoc = mapping(root.resolutions, `${path}.resolutions`);
  const resolutions: Record<string, ResolutionLabel> = {};
  for (const [value, label] of Object.entries(resolutionsDoc)) {
    if (value.trim() === "") throw new AlertRowError(`${path}.resolutions: resolution values must be non-empty`);
    Object.defineProperty(resolutions, value, {
      value: oneOf(label, RESOLUTION_LABELS, `${path}.resolutions.${value}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (Object.keys(resolutions).length === 0) throw new AlertRowError(`${path}.resolutions: must contain at least one value`);
  return { version: nonEmptyString(root.version, `${path}.version`), columns, resolutions };
}

function readRulesById(suiteDir: string): Map<string, Rule> {
  const rulesDir = join(suiteDir, "rules");
  try {
    const rules = readdirSync(rulesDir)
      .filter((file) => file.endsWith(".yaml"))
      .sort()
      .map((file) => readRule(parseYaml(readFileSync(join(rulesDir, file), "utf8")), file));
    validateRuleSuite(rules);
    return new Map(rules.map((rule) => [rule.id, rule]));
  } catch (error) {
    if (error instanceof RuleError) throw toAlertRowError(error);
    throw error;
  }
}

function parseFields(raw: string | undefined, path: string, row: number): { [field: string]: YamlValue } {
  const text = requiredCell(raw, `${path}: row ${row}: missing fields object`);
  try {
    checkNumberLiterals(text, `${path}: row ${row}: fields`);
  } catch (error) {
    if (error instanceof RunError) throw toAlertRowError(error);
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AlertRowError(`${path}: row ${row}: fields must be a JSON object`, { cause: error });
  }
  if (!isMapping(parsed as YamlValue)) throw new AlertRowError(`${path}: row ${row}: fields must be a JSON object`);
  return parsed as { [field: string]: YamlValue };
}

function indexHeader(header: readonly string[], path: string): Map<string, number> {
  const indexes = new Map<string, number>();
  for (const [index, name] of header.entries()) {
    if (name.trim() === "") throw new AlertRowError(`${path}: row 1: header column ${index + 1} is empty`);
    if (indexes.has(name)) throw new AlertRowError(`${path}: row 1: duplicate header column ${name}`);
    indexes.set(name, index);
  }
  return indexes;
}

function normalizedTimestamp(raw: string | undefined, path: string, row: number, column: string): string {
  const text = requiredCell(raw, `${path}: row ${row}: missing alert timestamp`);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(text);
  if (parts === null) {
    throw new AlertRowError(`${path}: row ${row}: ${column} must be an ISO 8601 timestamp with a UTC offset`);
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.slice(1).map((part) => Number(part ?? 0));
  const leapYear = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1];
  if (
    daysInMonth === undefined || day! < 1 || day! > daysInMonth ||
    hour! > 23 || minute! > 59 || second! > 59 || offsetHour! > 23 || offsetMinute! > 59
  ) {
    throw new AlertRowError(`${path}: row ${row}: ${column} must be a valid ISO 8601 calendar timestamp with a UTC offset`);
  }
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new AlertRowError(`${path}: row ${row}: ${column} must be an ISO 8601 timestamp with a UTC offset`);
  }
  return new Date(milliseconds).toISOString();
}

function optionalNumber(raw: string | undefined, path: string, row: number, column: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    return readCanonicalNumberLiteral(raw, `${path}: row ${row}: ${column}`);
  } catch (error) {
    if (error instanceof RunError) throw toAlertRowError(error);
    throw error;
  }
}

function optionalText(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  return raw.trim();
}

function optionalEventKey(raw: string | undefined, path: string, row: number, column: string): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (raw !== raw.trim()) {
    throw new AlertRowError(`${path}: row ${row}: ${column} must not contain leading or trailing whitespace`);
  }
  return raw;
}

function requiredCell(raw: string | undefined, message: string): string {
  if (raw === undefined || raw.trim() === "") throw new AlertRowError(message);
  return raw.trim();
}

function requiredExactCell(raw: string | undefined, message: string): string {
  if (raw === undefined || raw.trim() === "") throw new AlertRowError(message);
  return raw;
}

function mapping(value: YamlValue | undefined, where: string): { [key: string]: YamlValue } {
  if (!isMapping(value)) throw new AlertRowError(`${where}: expected a mapping`);
  return value;
}

function exactKeys(doc: { [key: string]: YamlValue }, keys: readonly string[], where: string): void {
  const actual = Object.keys(doc);
  for (const key of keys) {
    if (!Object.hasOwn(doc, key)) throw new AlertRowError(`${where}: missing ${key}`);
  }
  for (const key of actual) {
    if (!keys.includes(key)) throw new AlertRowError(`${where}: unknown field ${key}`);
  }
}

function nonEmptyString(value: YamlValue | undefined, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new AlertRowError(`${where} must be a non-empty string`);
  return value;
}

function oneOf<T extends string>(value: YamlValue | undefined, allowed: readonly T[], where: string): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new AlertRowError(`${where} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
}

/** RFC 4180-style records with escaped quotes, commas, CRLF, and quoted newlines. */
function parseCsv(text: string, path: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let values: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;
  let line = 1;
  let recordRow = 1;

  const pushRecord = (): void => {
    values.push(field);
    records.push({ row: recordRow, values });
    values = [];
    field = "";
    quoteClosed = false;
    recordRow = line + 1;
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          quoteClosed = true;
        }
      } else {
        field += char;
        if (char === "\n") line++;
      }
      continue;
    }
    if (char === '"') {
      if (field !== "" || quoteClosed) throw new AlertRowError(`${path}: row ${recordRow}: unexpected quote`);
      inQuotes = true;
    } else if (char === ",") {
      values.push(field);
      field = "";
      quoteClosed = false;
    } else if (char === "\n" || (char === "\r" && text[index + 1] === "\n")) {
      if (char === "\r") index++;
      pushRecord();
      line++;
    } else if (char === "\r") {
      throw new AlertRowError(`${path}: row ${recordRow}: bare carriage return is not supported; use LF or CRLF`);
    } else {
      if (quoteClosed) throw new AlertRowError(`${path}: row ${recordRow}: text after closing quote`);
      field += char;
    }
  }
  if (inQuotes) throw new AlertRowError(`${path}: row ${recordRow}: unterminated quoted field`);
  if (field !== "" || values.length > 0 || !text.endsWith("\n") && !text.endsWith("\r")) pushRecord();
  return records;
}
