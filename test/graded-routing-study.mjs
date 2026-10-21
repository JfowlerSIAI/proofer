#!/usr/bin/env node
// OFFLINE STUDY: is there a refusal band worth OFFERING instead of discarding?
//
// Sentence mode is binary. guardSentenceResult passes (silent apply) or refuses,
// and a refusal is thrown away with nothing shown. The hypothesis under test is
// that some refusal bands are mostly CORRECT fixes that the user should get a
// chip for -- keeping the standing asymmetry intact, because an OFFER writes
// nothing until the user says so.
//
// Everything here is replay. No Ollama, no browser.
//
//   node graded-routing-study.mjs                        # the whole study
//   node graded-routing-study.mjs --band sole-closer-word --list
//
// Env: PROOFER_CORPUS_DIR (default ../test/harvested via replay-log-guards)
//
// A BAND IS A PREDICATE OVER THE WHOLE CHAIN, NEVER OVER THE REASON STRING.
// guardSentenceResult reports the FIRST failure; a borderline first reason can
// sit in front of a hard one, so every band below requires reasons.length === 1
// -- the sole-failure requirement is the band, and the reason name is only how
// it is addressed.

import { readFileSync, existsSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import {
  guardSentenceReport, sanitizeSentenceOutput, REASON_FAMILIES,
} from "./lib/sentence-guards.mjs";
import { normalizeRecord } from "./replay-log-guards.mjs";
import { RECALL_SHOULD, RECALL_MUST_REFUSE } from "./lib/recall-cases.mjs";
import { CLEAN, ERRORS } from "./lib/sentence-corpus.mjs";
import { MULTI_TYPO } from "./lib/multi-typo-corpus.mjs";

const DIR = process.env.PROOFER_CORPUS_DIR
  || new URL("./harvested/", import.meta.url).pathname;

// ------------------------------------------------------------------- the bands
//
// Each band is {name, why, test(report)}. `test` sees the FULL report and may
// look at nothing but it.

const only = (rep, name) =>
  rep.reasons.length === 1 && rep.reasons[0].split(":")[0] === name;

/**
 * The ONE unexplained substitution, when the edit is exactly one word for one
 * word. Returns the pairing, or null.
 *
 * `subs` is the wrong instrument for this and the first cut of the study used
 * it: an ordinary 1:1 substitution puts TWO entries in `subs` -- the lost word
 * and `+gained` -- so requiring `subs.length === 1` selects pure deletions and
 * pure insertions and misses every substitution there is. It scored 2 hits on
 * 1282 sentences and looked like a dead band; the same band read off the
 * pairings is 9. Read the evidence, not the reason string's payload.
 */
function solePair(rep) {
  const e = rep.evidence;
  if (!e) return null;
  // TOTAL lost and gained, not just the UNEXPLAINED ones. Reading only the
  // unexplained pair lets a band described as "exactly one word swapped for one
  // word" carry passengers: `salt/on -> slat/in` is TWO substitutions and only
  // one of them is unexplained, and four multi-typo sentences with three or
  // four corrections each qualified the same way. The band was scored at 9 real
  // hits / 5 hazards / 4 multi-typo recoveries; it is 8 / 4 / 0. A band that
  // silently includes edits its own description excludes is not the band that
  // was measured.
  if (e.lost.length !== 1 || e.gained.length !== 1) return null;
  if (e.unexplainedLost.length !== 1 || e.unexplainedGained.length !== 1) return null;
  return e.pairings.find((p) =>
    p.lost === e.unexplainedLost[0] && p.gained === e.unexplainedGained[0]) || null;
}

// --------------------------------------------------------------- adjudications
//
// My judgement of whether each band hit on real traffic is a correction the user
// should want. Persisted so the owner can re-judge, disagree, or extend --
// numbers derived from these are only worth what the judgements are, and a
// precision figure quoted in a report with the labels living in the author's
// head is not reproducible.
//
// KEYED BY HASH, because the sentences are the owner's private Discord corpus
// and this file is checked in. The hash is over `input NUL output`, so it is
// stable, and it reveals nothing when the corpus is absent.
//
// `v` is one of: fix (a correction worth having), wrong (damage or unwanted
// meddling), unjudgeable (I could not tell without asking the author). These are
// MINE, not the owner's; the ERROR/CLEAN labels in the holdouts classify the
// INPUT sentence and do not say whether a proposed OUTPUT is good.
const ADJUDICATIONS = {
  // --- sole-sub-d1 (8 hits) ---
  "7fc209185229": { v: "fix", note: "adverb -> adjective, complement of `seems`" },
  "c05fdcc2f68e": { v: "fix", note: "adverb -> adjective, complement of `seems`" },
  "41b472585a2b": { v: "fix", note: "adverb -> adjective, complement of `seems`" },
  "881bd7f9d04d": { v: "fix", note: "`might got` -> `might go`, modal complement" },
  "0b036d4fcac1": { v: "fix", note: "plural agreement after `lots of`" },
  "e8b05e103d2a": { v: "fix", note: "non-word in context -> the intended verb" },
  "313db13c950f": { v: "wrong", note: "-ement/-ment is a dialect variant the user spelled correctly" },
  "17b6e89fd644": { v: "unjudgeable", note: "busses/buses are both standard; preference unknown" },
  // --- sole-closer-word (1 hit) ---
  "a8a24ceb30d8": { v: "wrong", note: "verbed product name flattened to a noun" },
  // --- sole-idle-final-inflection (3 hits) ---
  "08bc9a219ce7": { v: "wrong", note: "mass -> count noun, changes the reading" },
  "16277eb81284": { v: "wrong", note: "the documented anyways/anyway damage" },
  "0c39a962ff30": { v: "wrong", note: "the documented thing/things damage" },
  // --- sole-contraction-expanded (5 hits) ---
  "69f49608a329": { v: "fix", note: "possessive apostrophe placement" },
  "be805584af36": { v: "fix", note: "it's -> its, possessive" },
  "4ab83720b3a5": { v: "fix", note: "who's -> whose, possessive" },
  "ed6f85c8509e": { v: "fix", note: "Lot's -> Lots, spurious apostrophe" },
  "9ca3105cc879": { v: "fix", note: "it's -> its, possessive" },
  // --- sole-capital-added-to-non-word (4 hits; two runs share one sentence) ---
  "e203cdcda7e9": { v: "fix", note: "demonym capitalised" },
  "4aba723776d9": { v: "fix", note: "holiday name capitalised" },
  "6b4c641b0968": { v: "fix", note: "sentence-initial capital after a short opener" },
  // --- sole-terminator-changed (4 hits) ---
  "7e23437c23ec": { v: "fix", note: "stray period after a parenthesised question" },
  "ce0eba923b68": { v: "fix", note: "an under-punctuated question, not opener-shaped" },
  "4c3fb902094b": { v: "fix", note: "stray period after a quoted question" },
  "c5dc2633ec55": { v: "wrong", note: "dropped a `?` that was part of a URL" },
};

// NUL as the separator, written as an ESCAPE rather than as a literal byte: a
// literal one makes git call this source file binary, and a diff nobody can
// read is a review nobody does. The escape hashes identically, so the keys in
// ADJUDICATIONS above are unaffected.
export const adjKey = (input, output) =>
  createHash("sha256").update(`${input}\u0000${output}`).digest("hex").slice(0, 12);

const BANDS = [
  {
    name: "sole-sub-d1",
    why: "the brief's narrowest candidate: exactly one word swapped for one "
       + "word, at Damerau distance 1, the replacement in the dictionary, and "
       + "no other guard firing anywhere in the chain",
    test(rep) {
      if (!only(rep, "word-substituted")) return false;
      const p = solePair(rep);
      return !!p && p.distance === 1 && p.gainedIsWord;
    },
  },
  {
    name: "sole-sub-d1-nonword-src",
    why: "same, but the user's token was NOT a word -- so it is a typo the model "
       + "read, not a word it replaced. Split out because it is the half with an "
       + "argument for it.",
    test(rep) {
      if (!only(rep, "word-substituted")) return false;
      const p = solePair(rep);
      return !!p && p.distance === 1 && p.gainedIsWord && !p.lostIsWord;
    },
  },
  {
    name: "sole-closer-word",
    why: "the model read a NON-word as a real word WITHIN budget, and the only "
       + "thing that refused it was closerWordExists -- the `emtal` case. The "
       + "guard is not saying the reading is wrong, it is saying it cannot prove "
       + "it is the best one. That is a question with a human answer.",
    test(rep) {
      if (!only(rep, "word-substituted")) return false;
      const p = solePair(rep);
      return !!p && !p.lostIsWord && p.gainedIsWord &&
        p.distance >= 2 && p.distance <= p.budget && p.closerWordExists;
    },
  },
  {
    name: "sole-too-many-changes",
    why: "the backstop fired and nothing else did. substitutedContentWords "
       + "explained every word, so this is a heavily-but-legibly corrected "
       + "sentence rather than a rewrite.",
    test: (rep) => only(rep, "too-many-changes"),
  },
  {
    name: "sole-too-many-changes-near",
    why: "same, within 4 of the ceiling",
    test: (rep) => only(rep, "too-many-changes") &&
      rep.evidence && rep.evidence.changedWordCount <= rep.evidence.maxChangedWords + 4,
  },
  {
    name: "sole-idle-final-inflection",
    why: "known to refuse 3/2/1 real owner-rubric damages with zero fixes lost. "
       + "Measured here rather than assumed offerable.",
    test: (rep) => only(rep, "idle-final-inflection"),
  },
];

// ...and every OTHER guard, swept automatically. The brief named three bands to
// look at; three is not the number of ways this could have been sliced, and the
// bands that turned out to have the best precision are not among them. A sweep
// costs nothing here and is the difference between "I checked the candidates"
// and "I checked".
// Families come from the selected guard source; specialized predicates above
// remain study-owned. Unsupported fail-site shapes fail in the shared seam.
for (const r of REASON_FAMILIES) {
  if (BANDS.some((b) => b.name === `sole-${r}`)) continue;
  BANDS.push({ name: `sole-${r}`, why: `sole failure is ${r}`, test: (rep) => only(rep, r), swept: true });
}

/** Which bands need the idle trigger to be reachable at all. */
const IDLE_BANDS = new Set(["sole-idle-final-inflection"]);

// ------------------------------------------------------------------- the sets

function loadJsonl(file) {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** Model runs over real Discord sentences: {label, rows:[{id,input,output,trigger}]} */
function realRuns() {
  const out = [];
  for (const [file, labelFile] of [
    ["qwen.jsonl", null], ["lfm.jsonl", null],
    ["bench-error-holdout-run.jsonl", "labels-error-holdout.json"],
    ["bench-random-holdout-run.jsonl", "labels-random-holdout.json"],
  ]) {
    const p = join(DIR, file);
    if (!existsSync(p)) { console.error(`  (missing ${file})`); continue; }
    let labels = null;
    if (labelFile && existsSync(join(DIR, labelFile))) {
      labels = JSON.parse(readFileSync(join(DIR, labelFile), "utf8")).labels;
    }
    out.push({
      name: file,
      labels,
      rows: loadJsonl(p).map(normalizeRecord).filter((r) => r.input && r.output),
    });
  }
  return out;
}

// ------------------------------------------------------------------- the run

/**
 * Score every band over one set of {input, output} pairs.
 *
 * `trigger` matters: idle-final-inflection is the one guard that reads it, and
 * the corpora are SENTENCES, not keystrokes -- so an idle sweep here is the
 * unconditional rule's effect, exactly as the guard's own comment warns.
 */
function scoreSet(rows, trigger) {
  const res = {
    n: rows.length, applied: 0, refused: 0, noop: 0,
    soleReason: new Map(), firstReason: new Map(),
    bands: new Map(BANDS.map((b) => [b.name, []])),
  };
  for (const r of rows) {
    // The SHIPPING call, sanitizer included. Passing the recorded output as both
    // raw and sanitized is a different chain from the one production runs:
    // `sanitizer-would-change` becomes unreachable, and it is a real refusal --
    // four of these 1282 outputs earn it, and the totals move 290/141/851 to
    // 288/145/849. A study of the guards has to run the guards as they are
    // called, not as they are easiest to call.
    const cleaned = sanitizeSentenceOutput(r.input, r.output);
    const rep = guardSentenceReport(r.input, r.output, cleaned, { trigger });
    if (rep.reason === null) {
      if (cleaned.trim() === String(r.input).trim()) res.noop++;
      else res.applied++;
      // THE HARD GATE, asserted inline: a band must never fire on something the
      // guards passed. If it could, the silent-apply set would not be identical.
      for (const b of BANDS) {
        if (b.test(rep)) throw new Error(`BAND ${b.name} fired on a PASSING result: ${r.input}`);
      }
      continue;
    }
    res.refused++;
    const head = rep.reasons[0].split(":")[0];
    res.firstReason.set(head, (res.firstReason.get(head) || 0) + 1);
    if (rep.reasons.length === 1) {
      res.soleReason.set(head, (res.soleReason.get(head) || 0) + 1);
    }
    for (const b of BANDS) {
      if (b.test(rep)) res.bands.get(b.name).push({ ...r, rep });
    }
  }
  return res;
}

function pct(a, b) { return b ? `${((100 * a) / b).toFixed(1)}%` : "-"; }

function table(rows, headers) {
  const w = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) =>
    (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join("  ");
  console.log(line(headers));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));
}

function main() {
  const argv = process.argv.slice(2);
  const wantBand = argv.includes("--band") ? argv[argv.indexOf("--band") + 1] : null;
  const list = argv.includes("--list");

  console.log("GRADED ROUTING -- offline study");
  console.log("=".repeat(78));

  // A named band that does not exist is a typo, and answering it with a clean
  // run and an empty detail section is the "harness path that completes green
  // and produces nothing" pattern.
  if (wantBand && !BANDS.some((b) => b.name === wantBand)) {
    console.error(`\nunknown band: ${wantBand}\nknown bands:\n  `
      + BANDS.map((b) => b.name).join("\n  "));
    process.exit(2);
  }

  // ---- 1. where do refusals actually come from, and how many are SOLE
  const runs = realRuns();
  // The private corpus is most of this study. Without it the run reaches four
  // small checked-in corpora, prints a HARD GATE banner and exits 0 -- which is
  // indistinguishable from a run that measured 1282 real sentences and agreed.
  // In this repo a skip must not exit like a pass.
  const realRows = runs.reduce((a, r) => a + r.rows.length, 0);
  if (!realRows) {
    console.error("\nNO REAL MODEL RUNS FOUND.\n"
      + `Looked in: ${DIR}\n`
      + "This study is mostly a measurement over the owner's private corpora, which are\n"
      + "gitignored and live only in the main checkout. Set PROOFER_CORPUS_DIR:\n\n"
      + "  PROOFER_CORPUS_DIR=/path/to/proofer-extension/test/harvested \\\n"
      + "    node graded-routing-study.mjs\n");
    process.exit(1);
  }
  console.log("\n[1] Real model runs: refusals by first reason, and how many are the ONLY failure");
  const soleTotals = new Map(), firstTotals = new Map();
  let totalRows = 0, totalRefused = 0, totalApplied = 0, totalNoop = 0;
  const scored = [];
  for (const run of runs) {
    for (const trigger of [null, "idle"]) {
      const s = scoreSet(run.rows, trigger);
      scored.push({ run, trigger, s });
      if (trigger !== null) continue;             // count each row once
      totalRows += s.n; totalRefused += s.refused;
      totalApplied += s.applied; totalNoop += s.noop;
      for (const [k, v] of s.firstReason) firstTotals.set(k, (firstTotals.get(k) || 0) + v);
      for (const [k, v] of s.soleReason) soleTotals.set(k, (soleTotals.get(k) || 0) + v);
    }
  }
  console.log(`  ${totalRows} sentences | applied ${totalApplied}  refused ${totalRefused}  no-op ${totalNoop}`);
  table([...firstTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => [k, n, soleTotals.get(k) || 0, pct(soleTotals.get(k) || 0, n)]),
    ["reason", "refusals", "sole", "sole%"]);

  // ---- 2. band volume over the real runs
  console.log("\n[2] Band hits on real model runs (trigger=null unless the band needs idle)");
  const bandRows = [];
  const bandHits = new Map(BANDS.map((b) => [b.name, []]));
  for (const { run, trigger, s } of scored) {
    for (const b of BANDS) {
      const needsIdle = IDLE_BANDS.has(b.name);
      if (needsIdle !== (trigger === "idle")) continue;
      for (const h of s.bands.get(b.name)) {
        bandHits.get(b.name).push({ ...h, set: run.name, labels: run.labels, trigger });
      }
    }
  }
  // ---- 3. the checked-in corpora, scored per band and joined into ONE table.
  //
  // Four columns because a band has four different costs and reporting only the
  // first is how a band gets adopted:
  //   MUST_REFUSE  measured hazards. An offer here is a real cost -- a chip is
  //                cheaper than a silent write, but it is not free, and the
  //                whole point of the set is that these are known-bad.
  //   SHOULD       corrections that ALREADY apply silently. An offer here is a
  //                downgrade, not a gain, so it must be zero by construction.
  //   ERRORS/MULTI ideal corrections currently refused -- the band's actual win.
  //   CLEAN        no-ops. An offer here is a pure interruption.
  const corpora = [
    ["MUST_REFUSE", RECALL_MUST_REFUSE.map(([i, o]) => ({ input: i, output: o }))],
    ["SHOULD", RECALL_SHOULD.map(([i, o]) => ({ input: i, output: o }))],
    ["ERRORS", ERRORS.map((e) => ({ input: e.in, output: e.expected }))],
    ["MULTI_TYPO", MULTI_TYPO.map((c) => ({ input: c.in, output: c.expected }))],
    ["CLEAN", CLEAN.map((c) => ({ input: c, output: c }))],
  ];
  const corpHits = new Map();
  const corpCount = new Map();
  for (const [name, rows] of corpora) {
    for (const trigger of [null, "idle"]) {
      const s = scoreSet(rows, trigger);
      for (const b of BANDS) {
        if (IDLE_BANDS.has(b.name) !== (trigger === "idle")) continue;
        const hits = s.bands.get(b.name);
        corpCount.set(`${name}|${b.name}`, hits.length);
        if (hits.length) corpHits.set(`${name}|${b.name}`, hits);
      }
    }
  }
  const cc = (name, band) => corpCount.get(`${name}|${band}`) || 0;
  for (const b of BANDS) {
    const hits = bandHits.get(b.name);
    // Swept bands with no volume anywhere are noise in the table.
    if (b.swept && !hits.length && !corpora.some(([n]) => cc(n, b.name))) continue;
    const adj = { fix: 0, wrong: 0, unjudgeable: 0, none: 0 };
    for (const h of hits) {
      const a = ADJUDICATIONS[adjKey(h.input, h.output)];
      adj[a ? a.v : "none"]++;
    }
    bandRows.push([b.name, hits.length,
      // offers per 100 TRIGGERS: a trigger is one sentence reaching the guards,
      // which is what the log will count. Not per refusal.
      (100 * hits.length / Math.max(1, totalRows)).toFixed(2),
      `${adj.fix}/${adj.wrong}/${adj.unjudgeable}` + (adj.none ? `+${adj.none}?` : ""),
      cc("MUST_REFUSE", b.name) + `/${RECALL_MUST_REFUSE.length}`,
      cc("SHOULD", b.name) + `/${RECALL_SHOULD.length}`,
      cc("ERRORS", b.name) + `/${ERRORS.length}`,
      cc("MULTI_TYPO", b.name) + `/${MULTI_TYPO.length}`,
      cc("CLEAN", b.name) + `/${CLEAN.length}`,
    ]);
  }
  table(bandRows, ["band", "hits", "per100", "fix/wrong/unjdg",
    "MUST_REF", "SHOULD", "ERRORS", "MULTI", "CLEAN"]);
  console.log("\n  fix/wrong/unjdg are MY adjudications of the real-run hits, persisted by "
    + "hash in\n  ADJUDICATIONS so the owner can re-judge them. A trailing `+n?` is n hits "
    + "nobody has\n  judged. MUST_REF is an ENRICHED hazard corpus, not a prevalence "
    + "denominator: it says\n  a band admits a known-bad shape, never how often that shape "
    + "occurs in real typing.");

  // ---- 4. the detail, for judgement
  if (wantBand || list) {
    for (const b of BANDS) {
      if (wantBand && b.name !== wantBand) continue;
      const hits = bandHits.get(b.name);
      console.log(`\n[4] ${b.name} -- ${hits.length} hits on real runs`);
      console.log(`    ${b.why}`);
      for (const h of hits) {
        // The INPUT's owner label, which classifies the sentence and says
        // nothing about whether the proposed OUTPUT is any good -- that is what
        // the adjudication is for, and why both are printed.
        const lab = h.labels && h.labels[h.id] ? h.labels[h.id].class : "?";
        const key = adjKey(h.input, h.output);
        const a = ADJUDICATIONS[key];
        console.log(`\n  ${key} (${h.set} in=${lab}) `
          + `${a ? `${a.v.toUpperCase()}: ${a.note}` : "UNJUDGED"}`);
        console.log(`  ${h.rep.reasons.join(", ")}`);
        console.log(`     ${JSON.stringify(h.input)}`);
        console.log(`  -> ${JSON.stringify(h.output)}`);
      }
      for (const [k, hits2] of corpHits) {
        if (!k.endsWith("|" + b.name)) continue;
        console.log(`\n  --- ${k.split("|")[0]} ---`);
        for (const h of hits2) {
          console.log(`     ${JSON.stringify(h.input)}`);
          console.log(`  -> ${JSON.stringify(h.output)}`);
        }
      }
    }
  }
  console.log("\nHARD GATE: no band fired on any result the guards PASSED "
    + "(asserted inline; this run would have thrown).");

  // What the numbers above do and do not license. Written here rather than only
  // in a report, because the report is where a conclusion gets rounded up.
  console.log(`
WHAT THIS SUPPORTS
  - A distance-1 substitution between two real words is unsafe for SILENT apply.
    sole-sub-d1 admits 4 of the 48 measured hazards -- salt->slat, scalable->
    salable, deployable->deplorable, went->sent -- and its correct cases have
    the same evidence as its damaging ones, so no predicate available to the
    guards separates them. This re-derives, from the routing side, what
    the architecture already records from the guard side.
  - The nominated bands are low-volume: 0.62, 0.08 and 0.23 offers per 100
    triggers. sole-too-many-changes never fires at all.
  - Hazard leakage into an offer band is nonzero even after the band is
    tightened to its own stated definition.

WHAT THIS DOES NOT SUPPORT
  - A categorical "never offer a refusal for review". That would need three
    things this study does not have: a precision threshold agreed with the
    owner, a cost for one interruption, and a prevalence estimate. MUST_REFUSE
    is an ENRICHED hazard corpus -- 48 hand-built damage cases -- so "4/48"
    says a shape gets through, not how often it would.
  - Any claim about the coarse sole-word-substituted band, which is 59 of its
    68 real hits unjudged.

THE DECISION THIS RUN ARGUES FOR
  No-ship NOW, on the two measured grounds above -- for the CHIP. The
  better-value follow-up was in the same table and has since been TAKEN
  (2026-08-15): sole-contraction-expanded, sole-capital-added-to-non-word and
  sole-terminator-changed were 12 fixes and 1 wrong between them, exactly the
  class the owner's 2026-08-10 rubric already calls welcome UNATTENDED, so the
  three guards were NARROWED to silent applies rather than given a chip --
  along with protected-token, which was re-pointed from equality to presence.
  Refusals over these recordings went 145 -> 133 and capital-added-to-non-word
  is gone from table [1] entirely; the bands above are what is LEFT.

  A second round on 2026-08-15 finished the contraction band. The owner BLESSED
  "who's" -> "whose" and "it's" -> "its" as silent applies and REJECTED the
  chip/offer route permanently, so those two are now two named directed pairs
  in BLESSED_CONTRACTION_REPLACEMENTS rather than a band waiting for a decision;
  a hand CONFUSABLE for "reasonably" -> "reasonable" (3/3 correct here) landed
  with them. Refusals went 133 -> 127 and sole-contraction-expanded now reads
  0 rather than 5, then 3. The three bands named above therefore read 0, absent
  and 2 against the 5, 4 and 4 they started at.
`);
}

main();
