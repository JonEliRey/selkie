#!/usr/bin/env node
// Reproduce the finished corporate-package proof from only the current tree.

import "./network-denied.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replayImprovement } from "../src/bounded-improvement.ts";
import { STEP_STATE_FILE, startHistoricalDayStepper } from "../src/historical-stepper.ts";
import { runCase } from "../src/seams/run.ts";

const [output, ...extra] = process.argv.slice(2);
if (!output || extra.length) {
  console.error("usage: node scripts/verify-finished-package.ts <new-output>");
  process.exitCode = 2;
} else {
  try {
    if (existsSync(output)) throw new Error("finished_package_output_exists");
    mkdirSync(output);

    const guard = new URL("network-denied.ts", import.meta.url).href;
    const env = {
      ...process.env,
      NODE_PATH: "",
      NODE_OPTIONS: `--import=${guard}`,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    };
    const command = (...args: string[]) => {
      const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
      if (result.status !== 0) throw new Error(`${args.join(" ")}\n${result.stdout}${result.stderr}`);
      return result.stdout.trim();
    };

    // These are the approved public seams and their independently authored
    // fixtures, including their ordinary-test deliberate-failure controls.
    command("--test",
      "test/assisted-parser.test.ts",
      "test/permitted-proposal.test.ts",
      "test/scenario-outcomes.test.ts",
      "test/comparison.test.ts",
      "test/reserved-validation.test.ts",
      "test/bounded-improvement.test.ts",
      "test/historical-stepper.test.ts",
    );

    const successDir = join(output, "success");
    const noImprovementDir = join(output, "no-improvement");
    command("scripts/improve-example.ts", successDir, "success");
    command("scripts/improve-example.ts", noImprovementDir, "no-improvement");

    const success = JSON.parse(readFileSync(join(successDir, "experiment", "result.json"), "utf8"));
    const noImprovement = JSON.parse(readFileSync(join(noImprovementDir, "experiment", "result.json"), "utf8"));
    const admission = JSON.parse(readFileSync(join(successDir, "translated", "admission.json"), "utf8"));
    const attempt = success.attempts[0];
    const noImprovementAttempt = noImprovement.attempts[0];

    assert.equal(admission.status, "admitted");
    assert.equal(admission.provenance.translation_id, "translation-4eae9d2bb38898568cb631c13b38001152d2bfde18a9624a0d962ddb97dd877c");
    assert.equal(success.reason, "completed_with_improvement");
    assert.equal(success.accepted_count, 1);
    assert.deepEqual(attempt.states.map((state: { state: string }) => state.state),
      ["attempted", "admitted", "evaluated", "frozen", "validated", "protected", "accepted"]);
    assert.equal(attempt.reserved.status, "passed");
    assert.deepEqual(attempt.protected.protected_cases.retained_case_ids, ["protected"]);
    assert.deepEqual(attempt.protected.new_fraud_case_ids, ["new-jump"]);
    assert.deepEqual(attempt.protected.legitimate_merchants.incumbent, ["r-m-high"]);
    assert.deepEqual(attempt.protected.legitimate_merchants.candidate, []);
    assert.equal(success.production_promotion, "not_performed");
    assert.equal(noImprovement.reason, "no_valid_improvement");
    assert.equal(noImprovement.accepted_count, 0);
    assert.equal(noImprovementAttempt.reserved.status, "failed");
    assert.equal(noImprovementAttempt.reserved.comparison.reason, "no_strict_target_improvement");
    assert.equal(noImprovement.production_promotion, "not_performed");

    replayImprovement(join(successDir, "experiment"), join(output, "success-replay"));

    const batch = join(output, "batch");
    const stepped = join(output, "stepped");
    mkdirSync(batch);
    runCase("fixtures/run/daily-totals", batch, { requireAdmittedSuite: true });
    const stepper = startHistoricalDayStepper("fixtures/run/daily-totals", stepped);
    while (stepper.status().status === "in_progress") stepper.advance(stepper.status().next_day!);
    const batchFiles = readdirSync(batch).sort();
    assert.deepEqual(readdirSync(stepped).filter(name => name !== STEP_STATE_FILE).sort(), batchFiles);
    for (const name of batchFiles) {
      assert.deepEqual(readFileSync(join(stepped, name)), readFileSync(join(batch, name)), `batch/step ${name}`);
    }

    const receipt = {
      schema: "finished-corporate-package-proof-v1",
      evidence_scope: {
        data: "invented_materialized_history_only",
        corporate_data: "not_used",
        production_promotion: "not_performed",
        claim: "local_behavior_only",
      },
      translation: { status: admission.status, translation_id: admission.provenance.translation_id },
      improvement: {
        success: {
          reason: success.reason,
          accepted_count: success.accepted_count,
          states: attempt.states.map((state: { state: string }) => state.state),
          reserved_status: attempt.reserved.status,
          retained_fraud_case_ids: attempt.protected.protected_cases.retained_case_ids,
          new_fraud_case_ids: attempt.protected.new_fraud_case_ids,
          incumbent_legitimate_merchant_ids: attempt.protected.legitimate_merchants.incumbent,
          candidate_legitimate_merchant_ids: attempt.protected.legitimate_merchants.candidate,
        },
        no_improvement: {
          reason: noImprovement.reason,
          accepted_count: noImprovement.accepted_count,
          reserved_status: noImprovementAttempt.reserved.status,
          reserved_reason: noImprovementAttempt.reserved.comparison.reason,
        },
      },
      deterministic_replay: "byte_identical",
      batch_step: "byte_identical",
      model_network: "denied_during_workflow",
    };
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(`verify-finished-package: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
