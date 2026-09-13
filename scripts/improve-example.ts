#!/usr/bin/env node
// Complete invented historical workflow, using the previously saved assisted translation.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runImprovement } from "../src/bounded-improvement.ts";
import { createValidation } from "../src/seams/comparison.ts";
import { parseYaml } from "../src/yaml.ts";
import { readRule } from "../src/rules.ts";

const [output, mode = "success", ...extra] = process.argv.slice(2);
if (!output || extra.length || !["success", "no-improvement"].includes(mode)) {
  console.error("usage: node scripts/improve-example.ts <new-output> [success|no-improvement]"); process.exitCode = 2;
} else {
  mkdirSync(output);
  const translated = join(output, "translated");
  const command = spawnSync(process.execPath, ["scripts/translate.ts", "fixtures/parser/assisted-readable", translated], { encoding: "utf8" });
  if (command.status !== 0) throw new Error(command.stdout + command.stderr);
  const admission = JSON.parse(readFileSync(join(translated, "admission.json"), "utf8"));
  const fixture = "fixtures/improvement/readable-history";
  const authority = JSON.parse(readFileSync(join(fixture, "authority.json"), "utf8"));
  if (admission.status !== "admitted" || admission.provenance.source_sha256 !== authority.source_sha256) throw new Error("example_translation_mismatch");
  // Source representation stays locked. Extra reference parameters are unused
  // by this incumbent; permission for conversion is separate operator input.
  const rule = structuredClone(admission.rule);
  rule.thresholds.push(...authority.thresholds);
  for (const example of rule.tests) example.row.fields.lumen_reference = authority.reference_example_value;
  readRule(rule, "source-preserving experiment authority");
  const catalog = structuredClone(admission.catalog);
  const daily = catalog.features.find((f: { name: string }) => f.name === "sum_lumen_completed");
  // Exact unit alias: the source's integer USD cents are the daily engine's USD minor units.
  daily.source_unit = daily.unit; daily.unit = "minor_currency_units"; daily.window_days = 1;
  catalog.features.push(authority.baseline); catalog.permitted_conversions = [authority.conversion];
  const histories = ["search", "reserved"].map(partition => {
    const dir = join(output, partition); cpSync(join(fixture, partition), dir, { recursive: true });
    cpSync(join(translated, "suite"), join(dir, "suite"), { recursive: true });
    cpSync(join(translated, "admission.json"), join(dir, "admission.json"));
    cpSync("fixtures/parser/assisted-readable/tenant.yaml", join(dir, "suite/tenant.yaml"));
    writeFileSync(join(dir, "suite/rules/translation.yaml"), yaml(rule));
    writeFileSync(join(dir, "suite/catalog.yaml"), yaml(catalog));
    return dir;
  });
  if (mode === "no-improvement") {
    // Withheld fraud variation ties detection: 100 remains below the relative
    // threshold 144.477... as well as the source's fixed 1250 cents.
    const path = join(histories[1]!, "scenarios.jsonl");
    const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const row of rows) if (row.merchant_id === "r-m-new" && row.ts === "2026-02-06T00:00:00.000Z") row.amount = 100;
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
  const validation = join(output, "validation");
  createValidation(validation, { max_input_bytes: 8_000_000 });
  cpSync(join(fixture, "authority.json"), join(output, "operator-authority.json"));
  const result = runImprovement({ search: histories[0]!, reserved: [histories[1]!], corpus: "fixtures/comparison/protected-corpus/v1.json",
    validation_store: validation, output: join(output, "experiment"),
    limits: { target: "fraud_cases", max_attempts: 3, max_elapsed_ms: 60_000, max_input_bytes: 8_000_000 } });
  console.log(JSON.stringify({ reason: result.reason, accepted_count: result.accepted_count, experiment_id: result.experiment_id }));
}

function yaml(value: unknown, indent = 0): string {
  const text = (Array.isArray(value) ? value.map(item => ["-", item]) : Object.entries(value as object).map(([key, item]) => [key + ":", item]))
    .map(([key, item]) => " ".repeat(indent) + key + (item !== null && typeof item === "object" && Object.keys(item).length
      ? "\n" + yaml(item, indent + 2) : " " + JSON.stringify(item) + "\n")).join("");
  if (indent === 0) parseYaml(text);
  return text;
}
