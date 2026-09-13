#!/usr/bin/env node
// Replay a saved assisted translation. No provider, network, or model dependency.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAssistedTranslation } from "../src/seams/parser.ts";
import { parseYaml, type YamlValue } from "../src/yaml.ts";

const [inputDir, outDir, ...extra] = process.argv.slice(2);
if (inputDir === undefined || outDir === undefined || extra.length !== 0) {
  console.error("usage: node scripts/translate.ts <saved-input-dir> <out-dir>");
  process.exitCode = 2;
} else {
  try {
    if (existsSync(outDir) && readdirSync(outDir).length !== 0) throw new Error("output directory must be empty");
    const read = (name: string) => readFileSync(join(inputDir, name), "utf8");
    const result = parseAssistedTranslation(read("source.json"), read("model-output.json"), read("expectations.json"));
    // Serialize and round-trip before writing anything that could be used as a suite.
    const ruleText = result.rule === null ? null : yaml(result.rule);
    const catalogText = result.catalog === null ? null : yaml(result.catalog);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "admission.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (ruleText !== null && catalogText !== null) {
      mkdirSync(join(outDir, "suite", "rules"), { recursive: true });
      writeFileSync(join(outDir, "suite", "rules", "translation.yaml"), ruleText);
      writeFileSync(join(outDir, "suite", "catalog.yaml"), catalogText);
    }
    console.log(`Translation ${result.status}${result.provenance === null ? "" : ` · ${result.provenance.translation_id}`}`);
    if (result.status === "unresolved") process.exitCode = 2;
  } catch (error) {
    console.error(`translate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function yaml(value: YamlValue): string {
  const text = lines(value, 0).join("\n") + "\n";
  if (!isDeepStrictEqual(parseYaml(text), value)) throw new Error("translation cannot be represented in the supported YAML subset");
  return text;
}

function lines(value: YamlValue, indent: number): string[] {
  const pad = " ".repeat(indent);
  const entries: [string, YamlValue][] = Array.isArray(value)
    ? value.map((item) => ["-", item])
    : Object.entries(value as { [key: string]: YamlValue }).map(([key, item]) => [`${key}:`, item]);
  return entries.flatMap(([key, item]) => {
    const nested = typeof item === "object" && item !== null && Object.keys(item).length !== 0;
    return nested ? [`${pad}${key}`, ...lines(item, indent + 2)] : [`${pad}${key} ${JSON.stringify(item)}`];
  });
}
