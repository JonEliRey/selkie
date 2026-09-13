#!/usr/bin/env node
// Run zero over one synthetic alert export. Plain Node 24, no packages.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAlertRows } from "../src/alert-rows.ts";
import {
  ALERTS_FILE,
  RESOLUTION_MAPPING_FILE,
  RunError,
  SUITE_DIR,
  runAlertCase,
} from "../src/seams/run.ts";

const [caseDir, outDir, ...extra] = process.argv.slice(2);
if (caseDir === undefined || outDir === undefined || extra.length > 0) {
  console.error("usage: node scripts/zero.ts <case-dir> <out-dir>");
  process.exitCode = 2;
} else {
  try {
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      throw new RunError(`${outDir}: output directory must be empty`);
    }
    mkdirSync(outDir, { recursive: true });
    const loaded = loadAlertRows(
      join(caseDir, ALERTS_FILE),
      join(caseDir, RESOLUTION_MAPPING_FILE),
      join(caseDir, SUITE_DIR),
    );
    const result = runAlertCase(caseDir, outDir, loaded);
    console.log(result.headline);
  } catch (error) {
    console.error(`zero: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
