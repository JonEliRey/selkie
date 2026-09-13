#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { RunError, runCase } from "../src/seams/run.ts";

const [caseDir, outDir, ...extra] = process.argv.slice(2);
if (caseDir === undefined || outDir === undefined || extra.length > 0) {
  console.error("usage: node scripts/run.ts <case-dir> <out-dir>");
  process.exitCode = 2;
} else {
  try {
    if (existsSync(outDir) && readdirSync(outDir).length > 0) {
      throw new RunError(`${outDir}: output directory must be empty`);
    }
    mkdirSync(outDir, { recursive: true });
    const result = runCase(caseDir, outDir, { requireAdmittedSuite: true });
    console.log(`Run ${result.run_id} · tenant ${result.tenant} · ${result.run_type}`);
  } catch (error) {
    console.error(`run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
