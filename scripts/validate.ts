// Operator command for the public comparison seam; never supplied to a proposer.
import { mkdirSync } from "node:fs";
import { createValidation, openValidation } from "../src/seams/comparison.ts";

const [action, store, ...args] = process.argv.slice(2);
try {
  if (!store) throw new Error("usage: validate.ts create|freeze|reserve|evaluate|replay|expose|evidence|usage STORE ARGS...");
  if (action === "create" && args.length === 1) {
    createValidation(store, { max_input_bytes: Number(args[0]) });
    console.log(JSON.stringify({ status: "created" }));
  } else {
    const validation = openValidation(store);
    if (action === "freeze" && args.length === 1) console.log(validation.freeze(args[0]!));
    else if (action === "reserve" && args.length === 1) console.log(validation.reserve(args[0]!));
    else if (action === "evaluate" && args.length === 2) console.log(JSON.stringify(validation.evaluate(args[0]!, args[1]!)));
    else if (action === "replay" && args.length === 3) {
      mkdirSync(args[2]!); console.log(JSON.stringify(validation.replay(args[0]!, args[1]!, args[2]!)));
    } else if (action === "expose" && args.length === 2) {
      validation.expose(args[0]!, args[1]!); console.log(JSON.stringify({ status: "exposed" }));
    } else if (action === "evidence" && args.length === 2) console.log(JSON.stringify(validation.finalEvidence(args[0]!, args[1]!)));
    else if (action === "usage" && args.length === 1) console.log(JSON.stringify(validation.usage(args[0]!)));
    else throw new Error("invalid_validation_command");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
