#!/usr/bin/env node
// Offline caller tests for the guard analysis tools. No browser or model.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { spawn, spawnSync } from "child_process";
import { loadSentenceGuards, SENTENCE_SOURCE } from "./lib/sentence-guards.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
let pass = 0, fail = 0;
function ok(cond, label, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond && detail) console.log(detail);
  cond ? pass++ : fail++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-guard-tools-"));
try {
  const tree = path.join(dir, "tree");
  const test = path.join(tree, "test");
  const harvested = path.join(test, "harvested");
  fs.mkdirSync(path.join(test, "lib"), { recursive: true });
  fs.mkdirSync(harvested);
  // Ordinary files: symlinked modules resolve imports against the real tree.
  for (const file of ["background.js", "test/preguard-score.mjs", "test/lib/sentence-guards.mjs"]) {
    fs.copyFileSync(path.join(ROOT, file), path.join(tree, file));
  }
  fs.cpSync(path.join(ROOT, "data"), path.join(tree, "data"), { recursive: true });
  const original = "It turned out to be a caching problem.";
  const output = "It turned out to be a caching issue.";
  const runFile = path.join(dir, "bench-random-holdout-probe.jsonl");
  fs.writeFileSync(runFile, JSON.stringify({ uid: "g62-source-probe", sentence: original, output, error: null }) + "\n");
  const labels = (where, classification) => fs.writeFileSync(
    path.join(where, "labels-random-holdout.json"),
    JSON.stringify({ labels: { "g62-source-probe": { class: classification } } }));
  labels(harvested, "CLEAN");
  const env = { ...process.env };
  for (const key of ["PROOFER_CORPUS_DIR", "PROOFER_NO_DICT", "PROOFER_NO_CONFUSABLES", "PROOFER_NO_NAMES"]) delete env[key];
  const run = (extra = {}) => spawnSync(process.execPath,
    [path.join(test, "preguard-score.mjs"), runFile], {
      cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000,
    });
  const background = path.join(tree, "background.js");
  const source = fs.readFileSync(background, "utf8");

  // [1a] Scorer follows its tree. Mutant in preguard-score.mjs:
  // } from "/path/to/another-checkout/test/lib/sentence-guards.mjs";
  // The broken-source control and literal CLEAN surviving-guards=1 assertion
  // go red; the unmodified refusal stays 0.
  console.log("[1a] Scorer follows its tree");
  fs.writeFileSync(background, "function deliberatelyBroken( {\n");
  const broken = run();
  ok(broken.status === 1 && broken.stderr.includes("SyntaxError"),
    "[1a] broken copied background fails evaluation", broken.stdout + broken.stderr);
  fs.writeFileSync(background, source);
  const baseline = run();
  ok(baseline.status === 0 && /CLEAN\s+n=1\s+pre-guard edits=1\s+\(100\.0%\)\s+surviving guards=0/.test(baseline.stdout),
    "[1a] unmodified copied guard refuses the substitution", baseline.stdout + baseline.stderr);
  const signature = "function guardSentenceResult(original, raw, sanitized, opts = {}) {";
  if (!source.includes(signature)) throw new Error("guardSentenceResult signature not found");
  fs.writeFileSync(background, source.replace(signature, signature
    + `\n  if (original === ${JSON.stringify(original)} && raw === ${JSON.stringify(output)}) return null;`));
  const admitted = run();
  ok(admitted.status === 0 && /CLEAN\s+n=1\s+pre-guard edits=1\s+\(100\.0%\)\s+surviving guards=1/.test(admitted.stdout),
    "[1a] copied guard admits one CLEAN edit using script-relative labels", admitted.stdout + admitted.stderr);

  // [1b] Labels follow the corpus selection. Mutant in preguard-score.mjs:
  // const HARVESTED = "/path/to/another-checkout/test/harvested/";
  // The literal ERROR n=1 and surviving-guards=1 assertion goes red
  // (the selected label is not read).
  console.log("[1b] Labels follow the corpus selection");
  const selected = path.join(dir, "selected-corpus");
  fs.mkdirSync(selected);
  labels(selected, "ERROR");
  const override = run({ PROOFER_CORPUS_DIR: selected });
  ok(override.status === 0 && /ERROR\s+n=1\s+pre-guard edits=1\s+\(100\.0%\)\s+surviving guards=1/.test(override.stdout),
    "[1b] selected corpus supplies one ERROR edit", override.stdout + override.stderr);
  ok(override.status === 0 && /CLEAN\s+n=0\s+pre-guard edits=0/.test(override.stdout)
    && !override.stdout.includes("unlabelled="),
    "[1b] selected label replaces default CLEAN without unlabelled rows", override.stdout + override.stderr);

  // [2a] Complete family sweep. Mutants in graded-routing-study.mjs:
  // for (const r of REASON_FAMILIES.filter((r) => r !== "closer-added")) {
  // (repeat for negation-ambiguous and leading-word-added). The selected-band
  // assertions below/[2b] turn red; closer-added also loses its one literal hit.
  console.log("[2a] Complete family sweep");
  const api = await loadSentenceGuards({ controls: {} });
  const families = api.REASON_FAMILIES;
  ok(families.length === 26 && new Set(families).size === 26,
    "[2a] exactly 26 distinct reason families");
  ok(["negation-ambiguous", "closer-added", "leading-word-added"].every((r) => families.includes(r)),
    "[2a] all three formerly omitted families exist");
  ok(families.indexOf("closer-added") < families.indexOf("word-substituted")
    && families.indexOf("word-substituted") < families.indexOf("leading-word-added")
    && !families.some((r) => r.includes(":")),
    "[2a] fail-site order and normalized token payload");
  const candidate = await loadSentenceGuards({ controls: {}, source: SENTENCE_SOURCE.replace(
    'fail("closer-added")', 'fail("candidate-closer")') });
  ok(candidate.REASON_FAMILIES.includes("candidate-closer")
    && !candidate.REASON_FAMILIES.includes("closer-added"),
    "[2a] vocabulary follows the supplied source");
  // Parser mutant: replace the unsupported-site throw with continue; only the
  // unsupported-expression rejection below turns red.
  let unsupported = false;
  try {
    await loadSentenceGuards({ controls: {}, source: SENTENCE_SOURCE.replace(
      'fail("closer-added")', 'fail(String("closer-added"))') });
  } catch (e) { unsupported = e.message.includes("Unsupported runSentenceGuards fail site"); }
  ok(unsupported, "[2a] unsupported fail expression is rejected");
  const closerInput = "The plan is fine and we should ship it.";
  const closerOutput = closerInput + "}";
  ok(JSON.stringify(api.guardSentenceReport(closerInput, closerOutput, closerOutput).reasons)
    === '["closer-added"]', "[2a] witness has solely closer-added");
  const corpus = path.join(dir, "bands");
  fs.mkdirSync(corpus);
  fs.writeFileSync(path.join(corpus, "qwen.jsonl"), JSON.stringify({
    input: closerInput, output: closerOutput,
  }) + "\n");
  const study = (band) => spawnSync(process.execPath,
    [path.join(ROOT, "test/graded-routing-study.mjs"), "--band", band, "--list"], {
      cwd: dir, env: { ...env, PROOFER_CORPUS_DIR: corpus }, encoding: "utf8", timeout: 30000,
    });
  const closer = study("sole-closer-added");
  ok(closer.status === 0 && /sole-closer-added\s+1\s+100\.00/.test(closer.stdout)
    && closer.stdout.includes("[4] sole-closer-added -- 1 hits on real runs"),
    "[2a] closer-added band selects exactly one recorded hit", closer.stdout + closer.stderr);

  // [2b] Named bands. Same three one-line filtering mutants as [2a]: each
  // respective CLI selection goes red as unknown-band (exit 2).
  console.log("[2b] Named bands");
  for (const family of ["negation-ambiguous", "closer-added", "leading-word-added"]) {
    const r = family === "closer-added" ? closer : study(`sole-${family}`);
    ok(r.status === 0 && r.stdout.includes(`[4] sole-${family} --`),
      `[2b] CLI selects sole-${family}`, r.stdout + r.stderr);
  }
  const unknown = study("sole-invented-reason");
  ok(unknown.status === 2 && unknown.stderr.includes("unknown band: sole-invented-reason"),
    "[2b] invented band still exits 2");

  // [3a] Variant dataset parity. Mutant in guard-headroom-audit.mjs: append
  // api.setNames(null); to the loadSentenceGuards assignment. The normal-data
  // newly-admitted assertion turns red; the names-disabled refusal stays green.
  console.log("[3a] Variant dataset parity");
  const nameInput = "The github old car was still cheap to run.";
  const nameOutput = "The GitHub gold car was still cheap to run.";
  ok(api.guardSentenceResult(nameInput, nameOutput, nameOutput) === "word-substituted:old",
    "[3a] baseline witness is word-substituted:old");
  const audit = (input, output, guard, extra = {}) => {
    const file = path.join(dir, "audit.jsonl");
    fs.writeFileSync(file, JSON.stringify({ corpus: "clean", ctx: "none", in: input,
      out: output, expected: [input], correct: false, nearCorrect: false, guard }) + "\n");
    const result = spawnSync(process.execPath,
      [path.join(ROOT, "test/guard-headroom-audit.mjs"), "--from", file], {
        cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000,
      });
    // Isolate the actual patched-chain comparison from removal simulations.
    const variant = result.stdout.split("--- respelling: prefix insertion")[1]
      ?.split("PERFECT-MODEL UPPER BOUND")[0] || "";
    return { ...result, variant };
  };
  const normal = audit(nameInput, nameOutput, "word-substituted:old");
  ok(normal.status === 0 && normal.variant.includes("newBad(clean) 1")
    && normal.variant.includes('was word-substituted:old\n         "' + nameInput + '"'),
    "[3a] actual prefix variant newly admits the names-dependent row", normal.stdout + normal.stderr);
  const withoutNames = await loadSentenceGuards({ controls: { noNames: true } });
  ok(withoutNames.guardSentenceResult(nameInput, nameOutput, nameOutput) === "protected-token",
    "[3a] names-disabled baseline refuses protected-token");
  const noNames = audit(nameInput, nameOutput, "protected-token", { PROOFER_NO_NAMES: "1" });
  ok(noNames.status === 0 && noNames.variant.includes("newBad(clean) 0")
    && !noNames.variant.includes(nameInput),
    "[3a] names-disabled variant remains refused", noNames.stdout + noNames.stderr);

  // [3b] Control parity. Mutants in lib/sentence-guards.mjs: replace each of
  // if (!controls.noDict), if (!controls.noConfusables), if (!controls.noNames)
  // with if (true). Each selected-control state assertion and the corresponding
  // audit comparison go red (noNames is also pinned by [3a]).
  console.log("[3b] Control parity");
  for (const [control, dictionary, confusables, names] of [
    [null, true, true, true], ["noDict", false, false, false],
    ["noConfusables", true, false, true], ["noNames", true, true, false],
  ]) {
    const a = await loadSentenceGuards({ controls: control ? { [control]: true } : {} });
    ok(a.haveDictionary() === dictionary && a.isConfusable("peace", "piece") === confusables
      && a.isName("GitHub") === names && a.isName("Anthropic") === true,
      `[3b] ${control || "normal"} has literal dataset state and hand names`);
  }
  const dictInput = "The github car was still cheap to run.";
  const dictOutput = "The GitHub car was still cheap to run.";
  const noDict = audit(dictInput, dictOutput, "protected-token", { PROOFER_NO_DICT: "1" });
  ok(noDict.status === 0 && noDict.variant.includes("newBad(clean) 0")
    && !noDict.variant.includes(dictInput),
    "[3b] combined noDict control retains the variant name refusal", noDict.stdout + noDict.stderr);
  const confInput = "Can I have a peace of cake now?";
  const confOutput = "Can I have a piece of cake now?";
  const noConf = audit(confInput, confOutput, "word-substituted:peace", { PROOFER_NO_CONFUSABLES: "1" });
  ok(noConf.status === 0 && noConf.variant.includes("newBad(clean) 0")
    && !noConf.variant.includes(confInput),
    "[3b] noConfusables control retains the variant word refusal", noConf.stdout + noConf.stderr);

  // [4a] Owner live and reguard. Mutants in sentence-owner-bench.mjs:
  // guardSentenceResult(t.sentence, out, out) and (r.sentence, out, out).
  // Separately restore each early branch: out.trim() === sentence.trim()
  // returns outcome "no-op" before the question. The respective literal
  // sanitizer refusal / echo-refused assertions turn red (raw stays intact).
  console.log("[4a] Owner live and reguard");
  fs.writeFileSync(background, source);
  const typo = "I think teh plan works.";
  const markdown = "**I think the plan works.**";
  const curlyTypo = "I don’t think teh plan works.";
  const curly = "I don’t think the plan works.";
  // Tags still trigger the question on a faithful echo; straightened original
  // typography plus added markdown still supplies the two-refusal audit case.
  const echo = "<context>I think the plan works.</context>";
  const straightMarkdown = "**I don't think the plan works.**";
  const tagTypo = "<context>I think teh plan works.</context>";
  const answers = new Map([[typo, markdown], [curlyTypo, straightMarkdown], [tagTypo, echo], [echo, echo]]);
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: api.PINNED_MODEL.tag, digest: api.PINNED_MODEL.digest }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const input = request.messages.at(-1).content;
    const rewritten = answers.get(input);
    res.end(JSON.stringify({ message: { content: JSON.stringify({ rewritten }) } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const tool = (file, args = [], extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: dir, env: { ...env, PROOFER_OLLAMA_URL: `http://127.0.0.1:${server.address().port}`,
        ...extra }, timeout: 30000,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => { stdout += s; });
    child.stderr.on("data", (s) => { stderr += s; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  try {
    const ownerDir = path.join(dir, "owner");
    fs.mkdirSync(ownerDir);
    fs.writeFileSync(path.join(ownerDir, "probe.json"), JSON.stringify({
      version: 2, name: "probe", digest: "synthetic", items: [typo, echo].map((sentence, i) => ({
        uid: "g64-" + i, sentence, context: "", message_id: i,
      })),
    }));
    fs.writeFileSync(path.join(ownerDir, "labels-probe.json"), JSON.stringify({ labels: {
      "g64-0": { class: "ERROR", err: "teh", fix: "the", fixLiteral: "the" },
      "g64-1": { class: "CLEAN" },
    } }));
    const ownerScript = path.join(ROOT, "test/sentence-owner-bench.mjs");
    const ownerArgs = ["--corpus", "probe.json", "--tag", "sanitizer", "--conc", "1"];
    const live = await tool(ownerScript, [...ownerArgs, "--json", "live.json"], { PROOFER_CORPUS_DIR: ownerDir });
    const rowsPath = path.join(ownerDir, "bench-probe-sanitizer.jsonl");
    const liveRows = fs.existsSync(rowsPath) ? fs.readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    ok(live.status === 0 && liveRows[0]?.output === markdown
      && liveRows[0]?.verdict === "sanitizer-would-change" && liveRows[0]?.outcome === "refused",
      "[4a] live markdown keeps raw and refuses sanitizer-would-change", live.stdout + live.stderr);
    ok(live.status === 0 && liveRows[1]?.output === echo
      && liveRows[1]?.verdict === "sanitizer-would-change" && liveRows[1]?.outcome === "refused",
      "[4a] live sanitizer-altered echo is refused before no-op", live.stdout + live.stderr);
    // Deliberately wrong stored verdicts: replay must compute, not reuse them.
    fs.writeFileSync(rowsPath, liveRows.map((r) => JSON.stringify({ ...r, verdict: null, outcome: "applied" })).join("\n") + "\n");
    const replay = await tool(ownerScript, [...ownerArgs, "--replay", rowsPath, "--reguard", "--json", "replay.json"], { PROOFER_CORPUS_DIR: ownerDir });
    const scorePath = path.join(ownerDir, "replay.json");
    const scored = fs.existsSync(scorePath) ? JSON.parse(fs.readFileSync(scorePath, "utf8")) : {};
    ok(replay.status === 0 && scored.fixedRefused === 1 && scored.fixedSafeApplied === 0
      && scored.errorCases[0]?.output === markdown && scored.errorCases[0]?.verdict === "sanitizer-would-change",
      "[4a] reguard markdown keeps raw and refuses sanitizer-would-change", replay.stdout + replay.stderr);
    ok(replay.status === 0 && scored.cleanRefused === 1 && scored.cleanNoOp === 0
      && scored.refusals?.["sanitizer-would-change"] === 2,
      "[4a] reguard sanitizer-altered echo is refused before no-op", replay.stdout + replay.stderr);

    // [4b] Audit collection and analysis. Ordinary copied entrypoint + tiny
    // corpus modules exercise every analysis path without real model calls.
    // One-line mutants: guardSentenceResult(t.in, out, out) at collection;
    // guardSentenceReport(r.in, r.out, r.out) in analysis;
    // guardSentenceResult(r.in, r.out, r.out, opts) in the sweep;
    // g2(r.in, r.out, r.out) in the variant; guardSentenceResult(a, b, b)
    // in each perfect-model baseline/tally call; relaxed.guardSentenceResult
    // (a, b, b) in its variant; guardSentenceResult(i, o, o) in recall load.
    // Collection reasons, the full reason-list assertion, zero-recovery sweep,
    // zero-recovery variant and perfect-model counts/families respectively turn
    // red. The recall-load caller is pinned by its sanitizer refusal family.
    console.log("[4b] Audit collection and analysis");
    for (const file of ["guard-headroom-audit.mjs", "lib/harness.mjs"]) {
      fs.copyFileSync(path.join(ROOT, "test", file), path.join(test, file));
    }
    // The tag-preserving correction passes raw-only judging, so the sweep,
    // variant and perfect-model mutants cannot hide behind a second guard.
    const errors = [{ in: typo, expected: markdown }, { in: curlyTypo, expected: straightMarkdown },
      { in: tagTypo, expected: echo }];
    fs.writeFileSync(path.join(test, "lib/sentence-corpus.mjs"),
      `export const ERRORS = ${JSON.stringify(errors)};\nexport const CLEAN = [${JSON.stringify(echo)}];\nexport const CONTEXTS = [{ key: "none", text: "" }];\n`);
    fs.writeFileSync(path.join(test, "lib/multi-typo-corpus.mjs"), "export const MULTI_TYPO = [];\n");
    fs.writeFileSync(path.join(test, "lib/recall-cases.mjs"),
      `export const RECALL_SHOULD = [];\nexport const RECALL_MUST_REFUSE = [[${JSON.stringify(curlyTypo)}, ${JSON.stringify(straightMarkdown)}]];\n`);
    const collected = await tool(path.join(test, "guard-headroom-audit.mjs"), ["--contexts", "none"]);
    const auditRaw = path.join(test, "results/guard-headroom-raw.jsonl");
    const auditRows = fs.existsSync(auditRaw) ? fs.readFileSync(auditRaw, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    ok(collected.status === 0 && auditRows.length === 4
      && auditRows[0].out === markdown && auditRows[1].out === straightMarkdown && auditRows[2].out === echo && auditRows[3].out === echo
      && auditRows.every((r) => r.guard === "sanitizer-would-change"),
      "[4b] collection retains all raw replies and sanitizer refusals", collected.stdout + collected.stderr);
    // Mutant: restore classify's out===in check before r.guard. This clean
    // summary assertion turns red even though the collected guard is correct.
    ok(collected.status === 0 && /^clean\s+1\s+0\s+0\s+0\s+1\s+0$/m.test(collected.stdout),
      "[4b] collection counts the refused echo before no-op", collected.stdout + collected.stderr);
    // Independent input to --from: a collect mutant cannot contaminate this.
    fs.writeFileSync(auditRaw, errors.map((e) => JSON.stringify({ corpus: "errors", ctx: "none",
      in: e.in, out: e.expected, expected: [e.expected], correct: true, nearCorrect: true,
      guard: "sanitizer-would-change" })).join("\n") + "\n");
    const analysis = await tool(path.join(test, "guard-headroom-audit.mjs"), ["--from", auditRaw]);
    ok(analysis.status === 0 && analysis.stdout.includes("sanitizer-would-change  THEN  typography-changed")
      && /1\s+correct-fix-refused x1/.test(analysis.stdout) && /1\s+correct-fix-refused x2/.test(analysis.stdout)
      && analysis.stdout.includes("sanitizer-would-change  THEN  length-band  THEN  protected-token  THEN  word-substituted:context>i")
      && /1\s+correct-fix-refused x4/.test(analysis.stdout) && !analysis.stdout.includes("WARNING:"),
      "[4b] analysis has literal full sanitizer-inclusive reason lists", analysis.stdout + analysis.stderr);
    const sweepLines = analysis.stdout.split("\n").filter((s) => /^(minOverlap |maxChangedWords |lenFloorChars |length band )/.test(s));
    ok(analysis.status === 0 && sweepLines.length === 11 && sweepLines.every((s) => /\s0\s+0\s+0\s+0$/.test(s)),
      "[4b] all 11 threshold sweeps retain sanitizer refusals", sweepLines.join("\n"));
    const variantText = analysis.stdout.split("--- respelling: prefix insertion")[1]?.split("PERFECT-MODEL UPPER BOUND")[0] || "";
    ok(analysis.status === 0 && variantText.includes("recovered 0   newBad(clean) 0   newWrong(err) 0   newLeak(damage) 5"),
      "[4b] variant retains sanitizer refusals alongside five known prefix leaks", variantText);
    ok(analysis.status === 0 && /errors\s+3\/3 refused\s+\[sanitizer-would-change 3\]\s+-> 3 still refused/.test(analysis.stdout),
      "[4b] perfect-model baseline and variant retain all sanitizer refusals", analysis.stdout + analysis.stderr);
    ok(analysis.status === 0 && /sanitizer-would-change\s+3\|0\s+0\|1/.test(analysis.stdout),
      "[4b] synthetic must-refuse load uses the sanitizer question", analysis.stdout + analysis.stderr);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // [4c] Mutant in reseg-wall-survey.mjs: judge borrows
  // current.sanitizeSentenceOutput for every api (or passes repair as cleaned).
  // Both comparator flip counts
  // turn red: each must retain its own question after current typography admits.
  console.log("[4c] Survey current and comparator");
  const surveyDir = path.join(dir, "survey");
  fs.mkdirSync(surveyDir);
  for (const file of ["error-holdout.json", "random-holdout.json"]) {
    fs.writeFileSync(path.join(surveyDir, file), JSON.stringify({ items: [{ sentence: curly }] }));
  }
  const legacySource = spawnSync("git", ["show", "b332d8d:background.js"], {
    cwd: ROOT, encoding: "utf8", timeout: 30000,
  });
  if (legacySource.status !== 0) throw new Error(legacySource.stderr);
  for (const [name, comparatorSource] of [
    ["synthetic", source.replace("function sanitizeSentenceOutput(original, raw) {",
      "function sanitizeSentenceOutput(original, raw) { return raw.replace(/’/g, \"'\");")],
    ["baseline", legacySource.stdout],
  ]) {
    const comparator = path.join(dir, `${name}-comparator.js`);
    fs.writeFileSync(comparator, comparatorSource);
    const surveyOut = path.join(dir, `survey-${name}.json`);
    const surveyed = spawnSync(process.execPath, [path.join(ROOT, "test/reseg-wall-survey.mjs"),
      "--compare", comparator, "--json", surveyOut], {
      cwd: dir, env: { ...env, PROOFER_CORPUS_DIR: surveyDir }, encoding: "utf8", timeout: 30000,
    });
    const survey = fs.existsSync(surveyOut) ? JSON.parse(fs.readFileSync(surveyOut, "utf8")) : {};
    ok(surveyed.status === 0 && survey.total === 18 && survey.admitted === 18
      && JSON.stringify(survey.bucketReasons) === '{}',
      `[4c] current survey admits faithful typography against ${name}`, surveyed.stdout + surveyed.stderr);
    ok(surveyed.status === 0 && survey.flips?.admittedBefore === 0 && survey.flips?.newlyWalled === 0
      && survey.flips?.recovered === 18 && survey.flips?.policyAdmitted.length === 0
      && (surveyed.stdout.match(/\[OTHER\] sanitizer-would-change -> null/g) || []).length === 18,
      `[4c] ${name} comparator retains its own sanitizer refusal family`, surveyed.stdout + surveyed.stderr);
  }

  // [4d] Mutant in lib/sentence-guards.mjs: replace the extracted legacy
  // assignment with (await loadSentenceGuards()).sanitizeSentenceOutput.
  // Baseline cleaned-text and both full refusal-list pins turn red while
  // current correction/echo stay admitted. Unsupported legacy parsing still
  // must fail explicitly; it cannot silently accept a different question.
  console.log("[4d] Legacy comparator");
  const legacy = await loadSentenceGuards({ source: legacySource.stdout, controls: {} });
  const legacyCleaned = legacy.sanitizeSentenceOutput(curlyTypo, curly);
  ok(legacyCleaned === "I don't think the plan works.", "[4d] baseline question straightens the curly apostrophe");
  ok(JSON.stringify(legacy.guardSentenceReport(curlyTypo, curly, legacyCleaned).reasons)
    === '["sanitizer-would-change","typography-changed"]', "[4d] baseline correction has both literal refusals");
  ok(JSON.stringify(legacy.guardSentenceReport(curly, curly, legacy.sanitizeSentenceOutput(curly, curly)).reasons)
    === '["sanitizer-would-change","typography-changed"]', "[4d] baseline echo has both literal refusals");
  const current = await loadSentenceGuards({ source, controls: {} });
  ok(current.sanitizeSentenceOutput(curlyTypo, curly) === "I don’t think the plan works.",
    "[4d] current question preserves the curly apostrophe");
  for (const [label, input] of [["correction", curlyTypo], ["echo", curly]]) {
    const cleaned = current.sanitizeSentenceOutput(input, curly);
    ok(JSON.stringify(current.guardSentenceReport(input, curly, cleaned).reasons) === '[]'
      && current.guardSentenceResult(input, curly, cleaned) === null,
      `[4d] current ${label} passes both guard APIs`);
  }
  let unsupportedLegacy = false;
  try {
    await loadSentenceGuards({ source: legacySource.stdout.replaceAll(
      "const cleaned = normalizeWhitespace(asciify(stripMarkdown(stripped, sentence)), sentence);",
      "const cleaned = stripped;"), controls: {} });
  } catch (e) { unsupportedLegacy = e.message.includes("Unsupported legacy engine sanitizer shape"); }
  ok(unsupportedLegacy, "[4d] unsupported legacy question is rejected");

} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
