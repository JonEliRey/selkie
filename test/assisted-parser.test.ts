import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "../src/seams/run.ts";
import { readJsonl } from "../src/ledger.ts";
import { validateProposal } from "../src/seams/proposal.ts";
import { parseAssistedTranslation } from "../src/seams/parser.ts";

const fixture = new URL("../fixtures/parser/assisted-readable/", import.meta.url);
const sourceText = readFileSync(new URL("source.json", fixture), "utf8");

test("translation seam: missing source field units remain unresolved before model admission", () => {
  const source = JSON.parse(sourceText);
  delete source.fields[0].unit;
  const result = parseAssistedTranslation(JSON.stringify(source), "{}", "{}");
  assert.equal(result.status, "unresolved");
  assert.ok(result.reasons.some((reason) => reason.includes("fields[0].unit")));
  assert.equal(result.rule, null);
});

test("translation seam: all required source meanings are explicit and unknown source keys stay visible", () => {
  for (const property of ["meaning", "window", "status"]) {
    const source = JSON.parse(sourceText);
    delete source.fields[0][property];
    const result = parseAssistedTranslation(JSON.stringify(source), "{}", "{}");
    assert.equal(result.status, "unresolved");
    assert.ok(result.reasons.some((reason) => reason.includes(`fields[0].${property}`)), property);
  }
  for (const scope of [{tenant:"paper-kite"}, {risk_type:"lantern-watch"}, {}]) {
    const source = {...JSON.parse(sourceText), scope};
    assert.ok(parseAssistedTranslation(JSON.stringify(source), "{}", "{}").reasons.some((reason) => reason.includes("scope")));
  }
  const ambiguous = JSON.parse(sourceText);
  ambiguous.fields[0].status = "ambiguous";
  ambiguous.unresolved = ["window timezone is not known"];
  ambiguous.vendor_magic = "rolling_magic";
  const result = parseAssistedTranslation(JSON.stringify(ambiguous), "{}", "{}");
  assert.ok(result.reasons.some((reason) => reason.includes("ambiguous")));
  assert.ok(result.reasons.some((reason) => reason.includes("window timezone is not known")));
  assert.ok(result.reasons.some((reason) => reason.includes("vendor_magic")));
});

const modelText = readFileSync(new URL("model-output.json", fixture), "utf8");
const expectationsText = readFileSync(new URL("expectations.json", fixture), "utf8");

test("translation seam: original pre-fixed evidence remains replayable with a distinct identity", () => {
  const originalBytes = readFileSync(new URL("expectations.original-prefixed.json", fixture));
  assert.equal(createHash("sha256").update(originalBytes).digest("hex"), "4c08caee138ef182fc48e416a52e3461ba695246e78bc111d403db90bd678e46");
  const original = parseAssistedTranslation(sourceText, modelText, originalBytes.toString("utf8"));
  const extended = parseAssistedTranslation(sourceText, modelText, expectationsText);
  assert.equal(original.status, "admitted", original.reasons.join("; "));
  assert.equal(extended.status, "admitted", extended.reasons.join("; "));
  assert.equal(original.provenance?.translation_id, "translation-1cc25cd7c8fa5dcd538df2e204b5c45cf3d04050b81576811125d15ca783e2a4");
  assert.notEqual(extended.provenance?.translation_id, original.provenance?.translation_id);
  assert.deepEqual(JSON.parse(expectationsText).examples.slice(0, 11), JSON.parse(originalBytes.toString("utf8")).examples);
  assert.deepEqual(extended.candidate, original.candidate);
  assert.deepEqual(extended.interpretation, original.interpretation);
});

test("translation seam M1: rejects an extra sum_lumen_current lte 0 condition", () => {
  const model = JSON.parse(modelText);
  model.candidate.thresholds.push({id:"m1-current-ceiling",value:0,min:0,max:0,step:1});
  model.candidate.conditions.push({kind:"field_constant",field:"sum_lumen_current",operator:"lte",threshold:"m1-current-ceiling"});
  const result = parseAssistedTranslation(sourceText, JSON.stringify(model), expectationsText);
  assert.equal(result.status, "unresolved");
  assert.equal(result.rule, null);
  assert.ok(result.reasons.some((reason) => reason.includes('test "M1 completed signal with active current day" expected matched, got did_not_match')), result.reasons.join("; "));
});

test("translation seam M1: rejects an extra amount eq 1 condition", () => {
  const model = JSON.parse(modelText);
  model.candidate.thresholds.push({id:"m1-event-amount",value:1,min:1,max:1,step:1});
  model.candidate.conditions.push({kind:"field_constant",field:"amount",operator:"eq",threshold:"m1-event-amount"});
  const result = parseAssistedTranslation(sourceText, JSON.stringify(model), expectationsText);
  assert.equal(result.status, "unresolved");
  assert.equal(result.rule, null);
  assert.ok(result.reasons.some((reason) => reason.includes('test "M1 completed signal with event amount two" expected matched, got did_not_match')), result.reasons.join("; "));
});

test("translation seam M1: rejects currency membership widened to USD and GBP", () => {
  const model = JSON.parse(modelText);
  model.candidate.conditions[1].values = ["USD", "GBP"];
  const result = parseAssistedTranslation(sourceText, JSON.stringify(model), expectationsText);
  assert.equal(result.status, "unresolved");
  assert.equal(result.rule, null);
  assert.ok(result.reasons.some((reason) => reason.includes('test "M1 above-threshold GBP excluded" expected did_not_match, got matched')), result.reasons.join("; "));
});

test("translation seam: actual saved assistance admits with independently expected examples", () => {
  const result = parseAssistedTranslation(sourceText, modelText, expectationsText);
  assert.equal(result.status, "admitted", result.reasons.join("; "));
  assert.equal(result.rule?.id, "lumen-completed-value");
  assert.deepEqual(result.rule?.tests.map((example) => example.expected), [
    "did_not_match", "did_not_match", "matched", "did_not_match", "did_not_match", "matched",
    "not_applicable", "not_applicable", "did_not_match", "did_not_match", "did_not_match",
    "matched", "matched", "did_not_match",
  ]);
});

test("translation seam: stale provenance, changed meanings, model-only expectations and unsupported constructs cannot admit", () => {
  const cases = [
    {mutate:(m: any) => {m.source_sha256 = "0".repeat(64);}, reason:"source_sha256"},
    {mutate:(m: any) => {m.interpretation.fields[0].unit = "USD";}, reason:"interpretation.fields"},
    {mutate:(m: any) => {m.interpretation.fields[0].window = "rolling 24 hours";}, reason:"interpretation.fields"},
    {mutate:(m: any) => {m.unresolved = ["window timezone unknown"];}, reason:"window timezone unknown"},
    {mutate:(m: any) => {m.unsupported_constructs = ["vendor rolling magic"];}, reason:"vendor rolling magic"},
    {mutate:(m: any) => {m.extra_expression = "execute()";}, reason:"extra_expression"},
    {mutate:(m: any) => {m.producer.agent = JSON.parse(expectationsText).author.agent;}, reason:"independent"},
    {mutate:(m: any) => {m.candidate.thresholds[0].min = 1200;}, reason:"locked"},
    {mutate:(m: any) => {m.candidate.conditions.push({kind:"magic_window"});}, reason:"unsupported"},
  ];
  for (const {mutate,reason} of cases) {
    const model = JSON.parse(modelText);
    mutate(model);
    const result = parseAssistedTranslation(sourceText, JSON.stringify(model), expectationsText);
    assert.equal(result.status, "unresolved", reason);
    assert.equal(result.rule, null);
    assert.ok(result.reasons.some((item) => item.includes(reason)), result.reasons.join("; "));
  }
  const expectations = JSON.parse(expectationsText);
  expectations.source_sha256 = "0".repeat(64);
  assert.equal(parseAssistedTranslation(sourceText, modelText, JSON.stringify(expectations)).status,"unresolved");
  expectations.source_sha256 = JSON.parse(modelText).source_sha256;
  expectations.examples = expectations.examples.filter((e: any) => !e.covers.includes("window"));
  assert.ok(parseAssistedTranslation(sourceText, modelText, JSON.stringify(expectations)).reasons.some((item) => item.includes("window")));
});

test("translation and run seams: CLI emits a consumable catalog and rule with byte-identical replay", () => {
  const root = mkdtempSync(join(tmpdir(), "fwh-assisted-"));
  try {
    const admitted = join(root, "admitted");
    const command = spawnSync(process.execPath, ["scripts/translate.ts", fileURLToPath(fixture), admitted], {encoding:"utf8"});
    assert.equal(command.status, 0, command.stderr);
    for (const name of ["manifest.json","scenarios.jsonl"]) copyFileSync(new URL(name,fixture),join(admitted,name));
    copyFileSync(new URL("tenant.yaml",fixture),join(admitted,"suite","tenant.yaml"));
    const first = join(root,"first");
    const second = join(root,"second");
    mkdirSync(first); mkdirSync(second);
    runCase(admitted,first,{requireAdmittedSuite:true});
    runCase(admitted,second,{requireAdmittedSuite:true});
    const verdicts = readJsonl(join(first,"verdicts.jsonl")) as {event_id:string;verdict:string}[];
    assert.deepEqual(verdicts.map((v) => v.event_id), [
      "lumen-0","lumen-1","lumen-2","lumen-3","lumen-4","lumen-5","lumen-6",
      "lumen-7","lumen-8","lumen-9","lumen-10","lumen-11","lumen-12","lumen-13",
    ]);
    assert.deepEqual(verdicts.map((v) => v.verdict), [
      "did_not_fire","did_not_fire","alert","did_not_fire","did_not_fire","alert",
      "not_applicable","not_applicable","did_not_fire","did_not_fire","did_not_fire",
      "alert","alert","did_not_fire",
    ]);
    for (const table of readdirSync(first)) assert.equal(readFileSync(join(first,table),"utf8"),readFileSync(join(second,table),"utf8"),table);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("translation seam: tested threshold, unit, window and scope mutations fail independent checks", () => {
  const mutations = [
    (m: any) => {m.candidate.conditions[2].operator = "gte";},
    (m: any) => {Object.assign(m.candidate.thresholds[0],{value:12.5,min:12.5,max:12.5});},
    (m: any) => {m.candidate.conditions[2].field = "sum_lumen_current";},
    (m: any) => {m.candidate.applies_to.tenant = "paper-boat";},
    (m: any) => {m.candidate.applies_to.risk_type = "cloud-watch";},
  ];
  for (const mutate of mutations) {
    const model = JSON.parse(modelText);
    mutate(model);
    const result = parseAssistedTranslation(sourceText, JSON.stringify(model), expectationsText);
    assert.equal(result.status,"unresolved");
    assert.ok(result.reasons.some((reason) => reason.includes("expected") && reason.includes("got")),result.reasons.join("; "));
    assert.equal(result.rule,null);
  }
});

test("translation and proposal seams: later hypothesis has a separate version and cannot rewrite admitted translation", () => {
  const first = parseAssistedTranslation(sourceText,modelText,expectationsText);
  const proposal = JSON.parse(readFileSync(new URL("improvement-proposal.json",fixture),"utf8"));
  assert.deepEqual(validateProposal(proposal),{verdict:"accept",reasons:[]});
  assert.equal(proposal.gate_status,"ungated until replay");
  assert.equal(proposal.change.translation_id,first.provenance?.translation_id);
  assert.notEqual(proposal.change.proposal_version,first.provenance?.source_version);
  assert.notEqual(proposal.change.proposed_threshold_cents,first.rule?.thresholds[0]?.value);
  assert.deepEqual(parseAssistedTranslation(sourceText,modelText,expectationsText),first);
});

test("translation CLI: unresolved meaning yields evidence only, never a runnable suite; existing outputs are preserved", () => {
  const root = mkdtempSync(join(tmpdir(),"fwh-unresolved-"));
  try {
    const input = join(root,"input");
    const output = join(root,"output");
    mkdirSync(input);
    const model = JSON.parse(modelText);
    model.unsupported_constructs = ["unknown rolling operator"];
    writeFileSync(join(input,"source.json"),sourceText);
    writeFileSync(join(input,"model-output.json"),JSON.stringify(model));
    writeFileSync(join(input,"expectations.json"),expectationsText);
    const result = spawnSync(process.execPath,["scripts/translate.ts",input,output],{encoding:"utf8"});
    assert.equal(result.status,2,result.stderr);
    const admissionText = readFileSync(join(output,"admission.json"),"utf8");
    const admission = JSON.parse(admissionText);
    assert.equal(admission.rule,null);
    assert.deepEqual(admission.unknown_constructs,["unknown rolling operator"]);
    assert.equal(existsSync(join(output,"suite")),false);
    assert.throws(() => runCase(output,root),/ENOENT/);
    const retry = spawnSync(process.execPath,["scripts/translate.ts",fileURLToPath(fixture),output],{encoding:"utf8"});
    assert.equal(retry.status,1);
    assert.match(retry.stderr,/output directory must be empty/);
    assert.equal(readFileSync(join(output,"admission.json"),"utf8"),admissionText);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("translation seam: malformed JSON and incomplete evidence stay unresolved", () => {
  for (const broken of ["null","[]","{","42"]) {
    for (const index of [0,1,2]) {
      const inputs:[string,string,string] = [sourceText,modelText,expectationsText];
      inputs[index] = broken;
      const result = parseAssistedTranslation(...inputs);
      assert.equal(result.status,"unresolved");
      assert.ok(result.reasons.length > 0);
      assert.equal(result.rule,null);
    }
  }
  const model = JSON.parse(modelText);
  model.candidate.tests = JSON.parse(expectationsText).examples.map(({name,row,expected}: any) => ({name,row,expected}));
  assert.ok(parseAssistedTranslation(sourceText,JSON.stringify(model),expectationsText).reasons.some((r) => r.includes("independent examples")));
});
