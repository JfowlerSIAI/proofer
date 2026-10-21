#!/usr/bin/env node
// EXPERIMENT, NOT A GATE.
//
// How much of a MOVED SPACE can the guards repair? A structural survey.
//
// Every other instrument here is a replay: it asks what the guards did to text
// the model actually produced. That is blind to this question by construction.
// A moved space is something a TYPIST produces -- `Divertingt o`, `notsure`,
// `mor elike` -- and a model emits it almost never, so the whole 2026-08-15
// resegmentation round moved 2,686 verdicts in this survey while moving ZERO
// across 2,364 recorded model outputs. A green replay is no evidence at all
// about the collapse.
//
// So the survey manufactures the input instead. Take every alphabetic word
// boundary in a body of real sentences, damage it three ways, and ask the
// SHIPPING guards whether they would admit the CORRECT repair -- the original
// sentence, byte for byte. No model, no browser, no Ollama. This is the CEILING
// on what any amount of prompt work can deliver for this typo class.
//
//   left   "the section"  ->  "th esection"     the space slides LEFT
//   right  "the section"  ->  "thes ection"     the space slides RIGHT
//   join   "the section"  ->  "thesection"      the space is DELETED
//
// The wall is decomposed rather than totalled, because the buckets have
// opposite meanings:
//
//   POLICY   every damaged fragment is a dictionary word, so nothing in the
//            sentence says a typo is being corrected. This is the documented
//            `the rapist` -> `therapist` protection and it MUST NOT shrink.
//   DICT     the correct repair itself contains a token the 64k word list does
//            not have (proper nouns are deliberately absent; so are `capita`,
//            `findable`, `ChatGPT`), so collapseResegmentations declines and
//            every downstream guard sees an unexplained token. Same design
//            decision, one step along.
//   OTHER    everything else -- the bucket a defect shows up in.
//
// `--compare <background.js>` runs a SECOND revision of the guards in the same
// process and reports the flips both ways, plus any POLICY case the change
// newly admits (which is the one result that would sink a change here). It is
// the two-revision harness the round used. Its counterpart for RECORDED
// traffic is `sentence-owner-bench.mjs --replay <run.jsonl> --reguard`, which
// re-judges a recorded run's outputs under the current guards; this file
// covers the manufactured half (damage you synthesise), the bench flag the
// recorded half (damage the owner actually typed).
//
// Usage:
//   node reseg-wall-survey.mjs
//   node reseg-wall-survey.mjs --compare /tmp/background-before.js
//   node reseg-wall-survey.mjs --trigger idle          # the other guard trigger
//   node reseg-wall-survey.mjs --examples 12           # show walled cases
//   node reseg-wall-survey.mjs --json out.json
//
// Env:
//   PROOFER_CORPUS_DIR  where the holdout corpora live (default ./harvested)
//
// Exit codes, on the repo's "whose claim failed" rule:
//   0  the survey ran and produced a matrix
//   1  a corpus this repo names is missing or unreadable -- this repo's claim
//   2  a flag the caller passed is wrong (unknown shape, unreadable --compare)
//
// It never exits 0 having measured nothing: zero corpora, zero sentences and
// zero damages are each a named, nonzero failure. A harness you can point at
// anything must say something when you point it at nothing.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { guardSentenceResult, isWord, sanitizeSentenceOutput, loadSentenceGuards } from "./lib/sentence-guards.mjs";

const DIR = process.env.PROOFER_CORPUS_DIR
  || new URL("./harvested/", import.meta.url).pathname;

const arg = (n, d = null) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : (process.argv[i + 1] ?? true);
};
const SHAPES = ["left", "right", "join"];
const TRIGGER = arg("--trigger", null);
const N_EXAMPLES = Number(arg("--examples", 0)) || 0;
const COMPARE = arg("--compare", null);
const JSON_OUT = arg("--json", null);

if (TRIGGER !== null && !["idle", "next-sentence", "newline"].includes(TRIGGER)) {
  console.error(`unknown --trigger ${JSON.stringify(TRIGGER)}; `
    + "expected idle, next-sentence or newline");
  process.exit(2);
}

// ---------------------------------------------------------------- corpora
// The holdouts are derived from the owner's Discord data, gitignored, and live
// only in the main checkout. Absent, this survey has nothing to measure and
// says so -- it does not fall back to the small checked-in CLEAN corpus and
// print a full banner over 1,800 damages that answer a different question.
const CORPORA = ["error-holdout.json", "random-holdout.json"];

function loadCorpus(file) {
  const path = join(DIR, file);
  if (!existsSync(path)) return { file, path, sentences: null, why: "not found" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { file, path, sentences: null, why: `unreadable: ${e.message}` };
  }
  const sentences = (parsed.items || []).map((i) => i.sentence).filter(Boolean);
  return { file, path, sentences, why: sentences.length ? null : "no items with a sentence" };
}

const loaded = CORPORA.map(loadCorpus);
const missing = loaded.filter((c) => !c.sentences || !c.sentences.length);
if (missing.length) {
  console.error("\nCANNOT RUN: a corpus this survey names is not usable.\n");
  for (const m of missing) console.error(`  ${m.file}  (${m.path})  -- ${m.why}`);
  console.error("\nThe holdouts are derived from the owner's Discord data, are gitignored,"
    + "\nand live only in the main checkout. Point the survey at them:\n\n"
    + "  PROOFER_CORPUS_DIR=/path/to/proofer-extension/test/harvested \\\n"
    + "    node reseg-wall-survey.mjs\n");
  process.exit(1);
}

// -------------------------------------------------- a second guard revision
//
// The shared seam loads each revision's own guards AND sanitizer question.
// Legacy snapshots use their actual engine statements, validated by the seam;
// unsupported shapes fail instead of silently borrowing today's sanitizer.
// Both revisions use the selected shipping datasets and controls.
async function loadRevision(path) {
  return loadSentenceGuards({ source: readFileSync(path, "utf8") });
}

let before = null;
if (COMPARE) {
  if (!existsSync(COMPARE)) {
    console.error(`--compare ${COMPARE}: no such file`);
    process.exit(2);
  }
  try {
    before = await loadRevision(COMPARE);
  } catch (e) {
    console.error(`--compare ${COMPARE}: ${e.message}`);
    process.exit(2);
  }
}

// --------------------------------------------------------------- the damage
//
// Only boundaries between two purely alphabetic tokens, and only where a
// capital cannot confuse the reading: a mid-sentence capital is a name, and the
// second token's capital would make every repair a capitalisation question
// rather than a spacing one. The sentence-initial token keeps its capital,
// which is why `i > 0` guards the first test and not the second.
function* damages(sentence) {
  const toks = sentence.split(/\s+/);
  for (let i = 0; i + 1 < toks.length; i++) {
    const t1 = toks[i], t2 = toks[i + 1].replace(/[.,!?;:]+$/, "");
    if (!/^[A-Za-z]+$/.test(t1) || !/^[A-Za-z]+$/.test(t2)) continue;
    if (i > 0 && /[A-Z]/.test(t1)) continue;
    if (/[A-Z]/.test(t2)) continue;
    for (const shape of SHAPES) {
      let text, frags;
      if (shape === "join") {
        text = [...toks.slice(0, i), t1 + toks[i + 1], ...toks.slice(i + 2)].join(" ");
        frags = [t1 + t2];
      } else if (shape === "left") {
        if (t1.length < 2) continue;
        text = [...toks.slice(0, i), t1.slice(0, -1), t1.slice(-1) + toks[i + 1],
          ...toks.slice(i + 2)].join(" ");
        frags = [t1.slice(0, -1), t1.slice(-1) + t2];
      } else {
        if (t2.length < 2) continue;
        text = [...toks.slice(0, i), t1 + t2[0], toks[i + 1].slice(1),
          ...toks.slice(i + 2)].join(" ");
        frags = [t1 + t2[0], t2.slice(1)];
      }
      if (text === sentence) continue;
      // `frags` is what the DAMAGE produced and `whole` what the REPAIR
      // restores. The two decide the bucket and neither is a guess: POLICY is a
      // fact about the fragments, DICT a fact about the repair.
      yield { shape, text, frags, whole: [t1, t2] };
    }
  }
}

const W = (x) => isWord(x.toLowerCase());
const bucketOf = (d) =>
  d.frags.every(W) ? "POLICY" : !d.whole.every(W) ? "DICT" : "OTHER";

// ------------------------------------------------------------------ the run
const opts = TRIGGER === null ? {} : { trigger: TRIGGER };
const current = { guardSentenceResult, sanitizeSentenceOutput };
const judge = (api, text, repair) => api.guardSentenceResult(text, repair, api.sanitizeSentenceOutput(text, repair), opts);

const perCorpus = [];
const byBucket = new Map();
const byBucketReason = new Map();
const examples = { POLICY: [], DICT: [], OTHER: [] };
const flips = { recovered: [], newlyWalled: [], policyAdmitted: [] };
let total = 0, admitted = 0, admittedBefore = 0;

for (const corpus of loaded) {
  const shapeTally = Object.fromEntries(SHAPES.map((s) => [s, { n: 0, admitted: 0 }]));
  let n = 0, ok = 0;
  for (const sentence of corpus.sentences) {
    // The guards refuse anything over maxTargetChars anyway, so a long sentence
    // would contribute nothing but a wall of target-too-long.
    if (sentence.length > 400) continue;
    for (const d of damages(sentence)) {
      n++; total++;
      const reason = judge(current, d.text, sentence);
      shapeTally[d.shape].n++;
      if (reason === null) { ok++; admitted++; shapeTally[d.shape].admitted++; }
      else {
        const bucket = bucketOf(d);
        const key = reason.split(":")[0];
        byBucket.set(bucket, (byBucket.get(bucket) || 0) + 1);
        const bk = `${bucket}\t${key}`;
        byBucketReason.set(bk, (byBucketReason.get(bk) || 0) + 1);
        if (examples[bucket].length < N_EXAMPLES) {
          examples[bucket].push({ reason, frags: d.frags, in: d.text, out: sentence });
        }
      }
      if (!before) continue;
      const was = judge(before, d.text, sentence);
      if (was === null) admittedBefore++;
      if (was === reason) continue;
      const row = { was, now: reason, bucket: bucketOf(d), in: d.text, out: sentence };
      if (was !== null && reason === null) {
        flips.recovered.push(row);
        if (row.bucket === "POLICY") flips.policyAdmitted.push(row);
      } else if (was === null && reason !== null) flips.newlyWalled.push(row);
    }
  }
  perCorpus.push({ file: corpus.file, sentences: corpus.sentences.length, n, admitted: ok, shapes: shapeTally });
  if (!n) {
    console.error(`\nCANNOT RUN: ${corpus.file} produced ZERO damages.`
      + "\nEvery sentence was over 400 characters or held no two adjacent alphabetic"
      + "\ntokens, which is not a corpus this survey can say anything about.\n");
    process.exit(1);
  }
}

if (!total) {
  console.error("\nCANNOT RUN: no damages were generated at all.\n");
  process.exit(1);
}

// ---------------------------------------------------------------- reporting
const pc = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
console.log("\nResegmentation wall survey" + (TRIGGER ? `  [trigger=${TRIGGER}]` : ""));
console.log("=".repeat(72));
console.log(`corpora from ${DIR}`);

for (const c of perCorpus) {
  console.log(`\n=== ${c.file}  (${c.sentences} sentences)`);
  for (const s of SHAPES) {
    const t = c.shapes[s];
    console.log(`  ${s.padEnd(6)} ${String(t.n).padStart(6)} damages | correct repair ADMITTED `
      + `${String(t.admitted).padStart(6)} (${pc(t.admitted, t.n)})  WALLED `
      + `${String(t.n - t.admitted).padStart(6)} (${pc(t.n - t.admitted, t.n)})`);
  }
  console.log(`  ${"ALL".padEnd(6)} ${String(c.n).padStart(6)} damages | correct repair ADMITTED `
    + `${String(c.admitted).padStart(6)} (${pc(c.admitted, c.n)})  WALLED `
    + `${String(c.n - c.admitted).padStart(6)} (${pc(c.n - c.admitted, c.n)})`);
}

const walled = total - admitted;
console.log(`\n=== BOTH CORPORA`);
console.log(`  ${total} damages | ADMITTED ${admitted} (${pc(admitted, total)})  WALLED ${walled} (${pc(walled, total)})`);

console.log("\nthe wall, decomposed:");
const BUCKET_WHY = {
  POLICY: "every damaged fragment is a dictionary word (the `the rapist` protection)",
  DICT: "the correct REPAIR holds a token the 64k word list does not have",
  OTHER: "neither -- this is where a defect shows up",
};
for (const b of ["POLICY", "DICT", "OTHER"]) {
  const n = byBucket.get(b) || 0;
  console.log(`  ${String(n).padStart(6)}  ${b.padEnd(7)} ${BUCKET_WHY[b]}`);
  for (const [k, v] of [...byBucketReason].filter(([k]) => k.startsWith(`${b}\t`))
    .sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(v).padStart(6)}     ${k.split("\t")[1]}`);
  }
}

if (N_EXAMPLES) {
  for (const b of ["OTHER", "POLICY", "DICT"]) {
    if (!examples[b].length) { console.log(`\n--- ${b}: no walled cases`); continue; }
    console.log(`\n--- ${b}`);
    for (const e of examples[b]) {
      console.log(`  [${e.reason}] frags=${JSON.stringify(e.frags)}`);
      console.log(`     IN : ${e.in.slice(0, 150)}`);
      console.log(`     OUT: ${e.out.slice(0, 150)}`);
    }
  }
}

if (before) {
  const wBefore = total - admittedBefore;
  console.log(`\n=== COMPARE against ${COMPARE}`);
  console.log(`  BEFORE admitted ${admittedBefore} (${pc(admittedBefore, total)})  walled ${wBefore}`);
  console.log(`  AFTER  admitted ${admitted} (${pc(admitted, total)})  walled ${walled}`);
  console.log(`  recovered ${flips.recovered.length}   newly walled ${flips.newlyWalled.length}`);
  // The one result that sinks a change here. A POLICY case is a resegmentation
  // of one set of ordinary words into another, and admitting one is the
  // documented hazard, not a recovery.
  console.log(`\n  POLICY cases the change newly ADMITS (must be 0 or justified one by one): `
    + `${flips.policyAdmitted.length}`);
  for (const r of flips.policyAdmitted.slice(0, N_EXAMPLES || 20)) {
    console.log(`     [${r.was}] ${r.in.slice(0, 150)}\n        -> ${r.out.slice(0, 150)}`);
  }
  const cap = N_EXAMPLES || 20;
  for (const [name, rows] of [["NEWLY WALLED", flips.newlyWalled], ["RECOVERED", flips.recovered]]) {
    console.log(`\n  ${name}: ${rows.length}`);
    for (const r of rows.slice(0, cap)) {
      console.log(`     [${r.bucket}] ${r.was} -> ${r.now}\n        ${r.in.slice(0, 150)}\n        -> ${r.out.slice(0, 150)}`);
    }
    // A truncation that does not announce itself is indistinguishable from
    // "that is all there was".
    if (rows.length > cap) console.log(`     ... and ${rows.length - cap} more (raise --examples)`);
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, `${JSON.stringify({
    corpusDir: DIR, trigger: TRIGGER, compare: COMPARE,
    total, admitted, walled,
    perCorpus,
    buckets: Object.fromEntries([...byBucket]),
    bucketReasons: Object.fromEntries([...byBucketReason].map(([k, v]) => [k.replace("\t", "/"), v])),
    flips: before ? {
      admittedBefore,
      recovered: flips.recovered.length,
      newlyWalled: flips.newlyWalled.length,
      policyAdmitted: flips.policyAdmitted,
      newlyWalledRows: flips.newlyWalled,
    } : null,
  }, null, 2)}\n`);
  console.log(`\nwrote ${JSON_OUT}`);
}

console.log("\nThis is a CEILING, not a rate. It says what the guards would admit if the"
  + "\nmodel produced the right repair; it says nothing about how often the model does,"
  + "\nand nothing about how often real typing moves a space.\n");
