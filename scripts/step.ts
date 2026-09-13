#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { startHistoricalDayStepper } from "../src/historical-stepper.ts";

const [caseDir, outDir, ...days] = process.argv.slice(2);
if (caseDir === undefined || outDir === undefined) {
  console.error("usage: node scripts/step.ts <case-dir> <out-dir> [YYYY-MM-DD ...]");
  process.exitCode = 2;
} else {
  try {
    const stepper = startHistoricalDayStepper(caseDir, outDir);
    if (days.length > 0) {
      for (const day of days) {
        const state = stepper.advance(day);
        console.log(`Stepped ${day} · ${state.status} · next ${state.next_day ?? "none"}`);
      }
    } else {
      const input = createInterface({ input: stdin, output: stdout, terminal: true });
      console.log(`Run ${stepper.status().run_id} · enter each required YYYY-MM-DD day; canonical tables update after every accepted line.`);
      while (stepper.status().status === "in_progress") {
        const expected = stepper.status().next_day!;
        const day = await input.question(`next ${expected}> `);
        try {
          const state = stepper.advance(day);
          console.log(`Stepped ${day} · ${state.status} · next ${state.next_day ?? "none"}`);
        } catch (error) {
          console.error(`step: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      input.close();
    }
  } catch (error) {
    console.error(`step: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
