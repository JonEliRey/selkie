#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { advanceProtectedCorpusVersion, compareRuns } from "../src/seams/comparison.ts";
import { parseYaml } from "../src/yaml.ts";

const [caseDir, proposalFile, target, outDir, protectedCorpusFile, nextCorpusDir, ...extra] = process.argv.slice(2);
if (!caseDir || !proposalFile || !outDir || extra.length || nextCorpusDir && !protectedCorpusFile
  || (target !== "fraud_cases" && target !== "legitimate_merchants")) {
  console.error("usage: node scripts/compare.ts <case-dir> <proposal-file> <fraud_cases|legitimate_merchants> <out-dir> [protected-corpus-file] [next-corpus-dir]");
  process.exitCode = 2;
} else {
  try {
    const proposal = parseYaml(readFileSync(proposalFile, "utf8"));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const result = compareRuns(caseDir, outDir, { target, proposal, ...(protectedCorpusFile ? { protected_corpus_file: protectedCorpusFile } : {}) });
    console.log(`${result.eligibility}: ${result.reason} (${result.comparison_id})`);
    if (nextCorpusDir) {
      const next = advanceProtectedCorpusVersion(protectedCorpusFile!, outDir, nextCorpusDir);
      console.log(`protected corpus ${next.corpus_id} version ${next.version} written to ${nextCorpusDir}`);
    }
    process.exitCode = result.eligibility === "eligible" ? 0 : 1;
  } catch (error) {
    console.error(`comparison: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
