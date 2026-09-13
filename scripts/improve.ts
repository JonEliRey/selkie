#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runImprovement, replayImprovement } from "../src/bounded-improvement.ts";

const args = process.argv.slice(2);
try {
  if (args[0] === "--replay" && args.length === 3) {
    console.log(JSON.stringify(replayImprovement(args[1]!, args[2]!)));
  } else if (args.length === 2 && args[0] !== "--replay") {
    const config = JSON.parse(readFileSync(args[0]!, "utf8"));
    if (Object.keys(config).sort().join(",") !== "corpus,limits,reserved,search,validation_store") throw new Error("invalid_improvement_configuration");
    console.log(JSON.stringify(runImprovement({ ...config, output: args[1]! })));
  } else {
    console.error("usage: node scripts/improve.ts <operator-config.json> <new-output> | --replay <saved-experiment> <new-output>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`improve: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
}
