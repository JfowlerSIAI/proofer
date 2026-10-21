#!/usr/bin/env node
// guardSentenceReport must agree with guardSentenceResult, always.
//
// guardSentenceResult used to be a straight-line chain of `return "reason"`.
// It is now a thin wrapper over runSentenceGuards, which the evidence mode also
// drives -- so the single-string API's first-failure-wins semantics are no
// longer obvious from reading it, they are a property of `fail()` returning
// !collect. A property nobody checks is a property that decays, and this one is
// load-bearing: every silent write the extension makes is downstream of it.
//
// So this suite compares the two APIs over every corpus it can reach, asserts
// the evidence mode really does run past the first failure (a collector that
// silently early-exits would agree with production on every case and be
// useless), and pins the pairing evidence a router would read.
//
// No Ollama, no browser.
//
//   node sentence-evidence-test.mjs
//   PROOFER_CORPUS_DIR=/path/to/harvested node sentence-evidence-test.mjs
//
// The harvested corpora are gitignored, so they are an EXTENSION of the sample,
// never the sample: the floor below is met by the checked-in corpora alone.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { guardSentenceResult, guardSentenceReport, sanitizeSentenceOutput } from "./lib/sentence-guards.mjs";
import { normalizeRecord } from "./replay-log-guards.mjs";
import { RECALL_SHOULD, RECALL_MUST_REFUSE } from "./lib/recall-cases.mjs";
import { CLEAN, ERRORS } from "./lib/sentence-corpus.mjs";
import { MULTI_TYPO } from "./lib/multi-typo-corpus.mjs";

let pass = 0, fail = 0;
const check = (ok, what) => {
  if (ok) pass++;
  else { fail++; console.log(`  FAIL ${what}`); }
};

// ------------------------------------------------------------------ the pairs
const pairs = [];
for (const [i, o] of RECALL_SHOULD) pairs.push([i, o]);
for (const [i, o] of RECALL_MUST_REFUSE) pairs.push([i, o]);
for (const e of ERRORS) pairs.push([e.in, e.expected]);
for (const c of MULTI_TYPO) pairs.push([c.in, c.expected]);
for (const c of CLEAN) pairs.push([c, c]);
// Every clean sentence against every OTHER clean sentence would be n^2; a
// rotation is enough to drive the whole chain with unrelated text, which is
// what reaches low-overlap, length-band and content-reordered.
for (let i = 0; i < CLEAN.length; i++) pairs.push([CLEAN[i], CLEAN[(i + 1) % CLEAN.length]]);
// Degenerate inputs, so the early guards are exercised in BOTH modes -- evidence
// mode falls through target-too-short into arithmetic that production never
// reaches with an empty original.
for (const [a, b] of [["", ""], ["", "x"], ["x", ""], ["Hi.", "Hi there."],
                      ["a".repeat(600), "a".repeat(600) + "!"]]) pairs.push([a, b]);

// A THIRD element is the sanitized text. Every pair above passes the same string
// twice, which makes `sanitizer-would-change` unreachable -- and that guard is
// the whole reason the handler runs the sanitizer as a diagnostic rather than as
// a repair, so leaving it untested is leaving the diagnostic untested. Real
// production shapes: markdown fencing, smart quotes, an XML wrapper.
const SANITIZED_PAIRS = [
  ["The techncian arrived early.", "**The technician arrived early.**", "The technician arrived early."],
  ["The techncian arrived early.", "<rewritten>The technician arrived early.</rewritten>", "The technician arrived early."],
  ["She called it a best-effort estimate.", "She called it a “best-effort” estimate.", "She called it a \"best-effort\" estimate."],
  ["The report is ready.", "The report   is ready.", "The report is ready."],
];
for (const p of SANITIZED_PAIRS) pairs.push(p);

const CHECKED_IN = pairs.length;

const dir = process.env.PROOFER_CORPUS_DIR;
let harvested = 0;
if (dir && existsSync(dir)) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = normalizeRecord(JSON.parse(line)); } catch { continue; }
      if (!r.input || !r.output) continue;
      pairs.push([r.input, r.output]);
      harvested++;
    }
  }
}

console.log("Evidence mode vs the shipping guard");
console.log("=".repeat(72));
console.log(`${CHECKED_IN} checked-in pairs` + (harvested ? ` + ${harvested} harvested` : "")
  + ` x 3 triggers`);

// A run that reaches nothing must not report like a run that agreed. The floor
// is met by the checked-in corpora alone, so it holds in a fresh clone.
check(CHECKED_IN >= 300, `sample floor: ${CHECKED_IN} checked-in pairs (want >= 300)`);

// -------------------------------------------------- 1. the two APIs must agree
let compared = 0, multi = 0, withEvidence = 0;
const multiExamples = [];
let sawSanitizerGuard = false;
for (const [orig, out, san] of pairs) {
  const clean = san === undefined ? out : san;
  for (const trigger of [null, "idle", "next-sentence"]) {
    const a = guardSentenceResult(orig, out, clean, { trigger });
    const rep = guardSentenceReport(orig, out, clean, { trigger });
    compared++;
    if (rep.reasons.includes("sanitizer-would-change")) sawSanitizerGuard = true;
    if (a !== rep.reason) {
      fail++;
      console.log(`  FAIL disagree ${JSON.stringify(a)} vs ${JSON.stringify(rep.reason)}`
        + ` on ${JSON.stringify(orig)}`);
      continue;
    }
    // `reason` is reasons[0] at every exit -- the property that makes the two
    // APIs incapable of disagreeing, rather than merely observed not to.
    if (rep.reason !== (rep.reasons.length ? rep.reasons[0] : null)) {
      fail++;
      console.log(`  FAIL reason is not reasons[0] on ${JSON.stringify(orig)}`);
      continue;
    }
    if (rep.reasons.length > 1) {
      multi++;
      if (multiExamples.length < 3) multiExamples.push([orig, out, rep.reasons]);
    }
    if (rep.evidence) withEvidence++;
  }
}
pass++;   // one check for the whole sweep, counted once it completed clean
console.log(`\n[1] ${compared} comparisons, ${fail ? fail + " DISAGREEMENTS" : "0 disagreements"}`);

// ---------------------------------- 2. the collector must really run past one
//
// This is the assertion that makes the suite worth running. A "collector" that
// early-exits like production agrees with it on every case above and is
// completely useless -- and would look identical in the output. Requiring real
// multi-failure cases is what tells them apart.
console.log(`\n[2] cases where more than one guard fires: ${multi}`);
check(multi >= 10, `evidence mode runs past the first failure (${multi} multi-failure cases)`);
for (const [o, r, reasons] of multiExamples) {
  console.log(`      ${reasons.join(" | ")}`);
  console.log(`      ${JSON.stringify(o).slice(0, 90)}`);
}
check(sawSanitizerGuard, "sanitizer-would-change is reachable (raw != sanitized somewhere)");

// ------------------------- 2b. and it runs past EACH guard, not just past one
//
// `multi >= 10` catches a collector that early-exits globally, and nothing else.
// A premature `return` added to ONE guard leaves every other multi-failure case
// intact and the count barely moves. So pin named fixtures to the FULL set of
// reasons they must produce: the first reason proves the guard fired, and each
// later one proves the chain did not stop at the guard before it.
const CHAIN_FIXTURES = [
  // protected-token fires on the identifier, and the chain continues far enough
  // to reach the capital check.
  ["OBrien reviewed the report today.", "Obrien reviewed the report today.",
    ["protected-token", "capital-removed"]],
  // A sanitizer failure must not stop the chain either -- everything downstream
  // of it is still evaluated.
  ["The techncian arrived early.", "**The tecnician arived erly.**", "The tecnician arived erly.",
    ["sanitizer-would-change", "low-overlap"]],
];
for (const fx of CHAIN_FIXTURES) {
  const [o, raw, third, want] = fx.length === 4 ? fx : [fx[0], fx[1], fx[1], fx[2]];
  const rep = guardSentenceReport(o, raw, third, {});
  for (const w of want) {
    check(rep.reasons.includes(w),
      `${JSON.stringify(o).slice(0, 34)} collects ${w} (got ${rep.reasons.join(",") || "none"})`);
  }
  check(rep.reason === want[0], `...and reports ${want[0]} first (got ${rep.reason})`);
}

// --------------------------------- 3. a borderline first reason hiding a hard one
//
// The whole argument for not mapping reason STRINGS to bands. If this case ever
// stops existing the argument still holds, but it should be re-found rather than
// assumed, so it is pinned by shape and not by sentence.
const hidden = pairs.some(([o, r]) => {
  const rep = guardSentenceReport(o, r, r, {});
  return rep.reasons.length > 1 &&
    !rep.reasons[0].startsWith("word-substituted") &&
    rep.reasons.some((x) => x.startsWith("word-substituted"));
});
check(hidden, "a non-substitution first reason can conceal a word-substituted failure");

// ----------------------------------------------- 4. the evidence a router reads
{
  // One plain substitution the guards refuse: both sides are real words, so
  // isRespelling declines and the pairing is what says why.
  const rep = guardSentenceReport("The salt was on the table.", "The slat was on the table.", "The slat was on the table.", {});
  check(rep.reason === "word-substituted:salt", `salt/slat refuses (got ${rep.reason})`);
  const e = rep.evidence;
  check(!!e, "a refusal still carries evidence");
  check(e && e.unexplainedLost.join() === "salt", `unexplainedLost is [salt] (got ${e && e.unexplainedLost})`);
  check(e && e.unexplainedGained.join() === "slat", `unexplainedGained is [slat] (got ${e && e.unexplainedGained})`);
  const p = e && e.pairings.find((x) => x.lost === "salt" && x.gained === "slat");
  check(!!p, "a pairing exists for salt->slat");
  check(p && p.distance === 1, `Damerau distance is 1 (got ${p && p.distance})`);
  check(p && p.lostIsWord && p.gainedIsWord, "both sides are dictionary words");
  check(p && !p.respelling, "isRespelling declines it -- which is WHY it refused");
}
{
  // The `emtal` case: a NON-word read as a real word inside budget, refused
  // only because a closer dictionary word exists.
  const rep = guardSentenceReport("The sample label refers to that emtal.", "The sample label refers to that email.", "The sample label refers to that email.", {});
  check(rep.reason === "word-substituted:emtal", `emtal/email refuses (got ${rep.reason})`);
  const p = rep.evidence && rep.evidence.pairings.find((x) => x.lost === "emtal" && x.gained === "email");
  check(!!p, "a pairing exists for emtal->email");
  check(p && !p.lostIsWord && p.gainedIsWord, "a non-word read as a word");
  check(p && p.closerWordExists, "closerWordExists is what refused it (metal is nearer)");
}
{
  // A clean pass carries evidence too, and no reasons.
  const rep = guardSentenceReport("The techncian arrived early.", "The technician arrived early.", "The technician arrived early.", {});
  check(rep.reason === null, `an ordinary typo fix passes (got ${rep.reason})`);
  check(rep.reasons.length === 0, "a pass collects no reasons");
  check(rep.evidence !== null, "a pass still carries evidence");
  check(rep.evidence && rep.evidence.matched.some((m) => m.lost === "techncian" && m.gained === "technician"),
    "the matched pair is reported");
}
{
  // An exact no-op takes the one early SUCCESS exit; it has no edit to describe.
  const rep = guardSentenceReport("Nothing changed here.", "Nothing changed here.", "Nothing changed here.", {});
  check(rep.reason === null && rep.reasons.length === 0, "an exact no-op passes");
}
{
  // The trigger reaches the evidence, because a router would branch on it.
  const idle = guardSentenceReport("I do that anyways.", "I do that anyway.", "I do that anyway.", { trigger: "idle" });
  check(idle.reason === "idle-final-inflection", `idle refuses the inflection (got ${idle.reason})`);
  check(idle.evidence && idle.evidence.trigger === "idle", "the trigger is on the evidence");
  check(idle.evidence && idle.evidence.finalTokenInflection === true, "finalTokenInflection is reported");
  const typed = guardSentenceReport("I do that anyways.", "I do that anyway.", "I do that anyway.", { trigger: "next-sentence" });
  check(typed.reason === null, `and applies once the user typed past (got ${typed.reason})`);
}

// ----------------------------------------------- [4a] name-accounted losses
// Mutant: if (subs2.length && subDetail) Object.assign(subDetail, viewDetail);
// The empty lost/contentLost/unexplainedLost assertions turn red.
{
  console.log("[4a] name-accounted losses replace the plain detail");
  const rep = guardSentenceReport("The sample index lists an Antrhopic paper.",
    "The sample index lists an Anthropic paper!", "The sample index lists an Anthropic paper!", {});
  check(JSON.stringify(rep.reasons) === '["terminator-changed"]', "[4a] only terminator-changed remains");
  for (const key of ["subs", "lost", "contentLost", "unexplainedLost"]) {
    check(JSON.stringify(rep.evidence?.[key]) === "[]", `[4a] ${key} is empty after the name licence`);
  }
}

// ---------------------------------------- [4b] dedup explanation projection
// Mutant: dedupExcused: [], in sentenceGuardEvidence; the dedupExcused pin
// turns red while the complete reason list and other loss assertions hold.
{
  console.log("[4b] dedup explanation survives projection");
  const rep = guardSentenceReport("i know know that Alice left.",
    "i know that alice left.", "i know that alice left.", {});
  check(JSON.stringify(rep.reasons) === '["capital-removed"]', "[4b] only capital-removed remains");
  check(JSON.stringify(rep.evidence?.lost) === '["know"]', "[4b] lost retains the duplicate token");
  check(JSON.stringify(rep.evidence?.unexplainedLost) === "[]", "[4b] duplicate loss is explained");
  check(JSON.stringify(rep.evidence?.dedupExcused) === '["know"]', "[4b] dedupExcused publishes know");
}

// [4c] Mutant: omit original from the shared question's asciify call.
// The corrected/echo question, full reasons and first-reason assertions go red.
{
  console.log("[4c] Original typography through the question");
  const original = "I don’t think teh plan works.";
  for (const [label, input, raw, cleaned, reasons] of [
    ["correction", original, "I don’t think the plan works.", "I don’t think the plan works.", []],
    ["echo", "I don’t think the plan works.", "I don’t think the plan works.", "I don’t think the plan works.", []],
    ["ASCII replacement", original, "I don't think the plan works.", "I don't think the plan works.", ["typography-changed"]],
    ["new family", original, "I don’t think the plan works…", "I don’t think the plan works...", ["sanitizer-would-change"]],
    ["added same family", original, "I don’t think the plan’s works.", "I don’t think the plan’s works.", ["typography-changed", "word-substituted:plan"]],
    ["substituted same family", "The “plan” has teh details.", "The “plan« has the details.", "The “plan« has the details.", ["typography-changed"]],
  ]) {
    const actual = sanitizeSentenceOutput(input, raw);
    check(actual === cleaned, `[4c] ${label} question preserves only original families`);
    const rep = guardSentenceReport(input, raw, actual);
    check(JSON.stringify(rep.reasons) === JSON.stringify(reasons), `[4c] ${label} complete reasons: ${JSON.stringify(rep.reasons)}`);
    check(guardSentenceResult(input, raw, actual) === (reasons[0] ?? null), `[4c] ${label} shipping first reason`);
  }
}

console.log(`\n${"=".repeat(72)}`);
console.log(`${pass} passed | ${fail} failed`);
process.exit(fail ? 1 : 0);
