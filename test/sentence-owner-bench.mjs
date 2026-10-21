#!/usr/bin/env node
// Owner-rubric benchmark for sentence mode.
//
// Runs the SHIPPING path -- prepareSentenceRequest + guardSentenceResult read
// out of background.js by lib/sentence-guards.mjs -- over a corpus of real
// sentences with real prior context, and scores against the owner's rubric:
//
//   RAISE   genuine errors fixed and applied, WITHOUT collateral damage
//   HOLD    meaning-affecting edits to text the user meant
//   IGNORE  commas, capitals, hyphens, possessive apostrophes. Under this
//           rubric those are WELCOME style edits, not harm. They are counted
//           and reported so a change in chattiness is visible, but the old
//           "exact-clean" number is a MEDDLING DIAGNOSTIC, never a gate.
//
// The gate is: zero NEW meaning damage against a recorded baseline. Not a
// count -- a set of uids. A change that repairs one damaged sentence and
// damages a different one nets to zero and is still a regression.
//
// Usage:
//   node sentence-owner-bench.mjs --corpus random-holdout.json --tag base
//   node sentence-owner-bench.mjs --corpus error-holdout.json --replay runs/x.jsonl
//   node sentence-owner-bench.mjs --corpus error-holdout.json --replay r.jsonl \
//        --reguard --baseline baseline-error-holdout.json
//                       # gate a GUARD change offline: re-judge the recorded
//                       # outputs under the current guards -- fixed model
//                       # outputs, so the live gate's noise floor cannot reach it
//   node sentence-owner-bench.mjs --corpus random-holdout.json --tag cand \
//        --baseline baseline-random-holdout.json          # gate: exits 1 on new damage
//   node sentence-owner-bench.mjs --corpus random-holdout.json --replay r.jsonl \
//        --write-baseline                                  # record a new baseline
//
// Flags:
//   --corpus <file>     corpus v2 JSON, resolved against $PROOFER_CORPUS_DIR
//   --labels <file>     ERROR/CLEAN labels; defaults to labels-<corpus name>.json
//   --replay <file>     score an existing .jsonl instead of calling Ollama
//   --reguard           with --replay: discard the recorded verdicts and re-run
//                       guardSentenceResult over each recorded output NOW
//   --tag <name>        writes <dir>/bench-<corpus>-<tag>.jsonl
//   --baseline <file>   gate against a recorded baseline (exit 1 on NEW damage)
//   --write-baseline    write the baseline file this run would be gated against
//   --limit <n>         first n sentences only (smoke test)
//   --conc <n>          concurrent requests (default 3)
//   --review            print every refusal reason and every non-clean error case
//   --json <file>       dump the full score object
//
// Env:
//   PROOFER_CORPUS_DIR  where corpora live (default: <this dir>/harvested)
//   PROOFER_MODEL, PROOFER_OLLAMA_URL, PROOFER_OPTIONS, PROOFER_VARIANT
//
// Corpora derived from the owner's Discord data are gitignored and live in
// test/harvested/. This runner holds no corpus data and is checked in.

import { readFileSync, writeFileSync, appendFileSync, chmodSync, existsSync } from "fs";
import { createHash } from "crypto";
import { prepareSentenceRequest, guardSentenceResult, sanitizeSentenceOutput } from "./lib/sentence-guards.mjs";
import { MODEL as HARNESS_MODEL } from "./lib/harness.mjs";

// ------------------------------------------------------------- edit taxonomy
const NEGATIONS = /^(not|no|never|nothing|none|nor|cannot|cant|dont|doesnt|didnt|isnt|arent|wasnt|werent|wont|wouldnt|shouldnt|couldnt|nobody|neither|nowhere)$/;

const FUNCTION_WORDS = new Set(
  "a an the that which who to for of in on at by with is are was were be been am do does did has have had it its and or but so as from than then".split(" "));

// Words that cannot head a noun phrase after a sentence-initial negation.
const CLAUSE_STARTERS = new Set(
  ("i you he she it we they there that this who what "
   + "is are was were am be been do does did have has had "
   + "can could will would should shall may might must "
   + "im ive id ill youre youve hes shes its were theyre thats").split(" "));

function diffAdded(a, b) {
  const left = new Map();
  for (const w of a) left.set(w, (left.get(w) || 0) + 1);
  const added = [];
  for (const w of b) {
    if (left.get(w)) left.set(w, left.get(w) - 1);
    else added.push(w);
  }
  return added;
}

const letters = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const words = (s) => s.split(/\s+/).filter(Boolean);
const coreWords = (s) => words(s).map(letters).filter(Boolean);

/**
 * Split an applied edit into style / grammar / meaning. The test is the letter
 * stream: strip every non-alphanumeric character and a comma, a terminator, a
 * capital, a hyphen and an apostrophe all vanish, while a changed, added or
 * deleted WORD does not. Two exceptions are named rather than inferred,
 * because the letter stream cannot see them.
 */
export function classifyEdit(before, after) {
  const a = coreWords(before), b = coreWords(after);
  if (letters(before) === letters(after)) {
    // A comma dropped in after a sentence-initial negation re-parses the whole
    // sentence: "No July 14th, puppet show." (there is no puppet show on the 14th)
    // -> "No, July 14th, puppet show." (yes, and it is on the 14th).
    // The inversion needs a NOUN PHRASE after the negation. "No July 14th, puppet
    // show." flips because "No July 14th" is a readable constituent. "No it
    // stops here." cannot flip -- "No it" is not one, so the comma is
    // simply the punctuation that was missing. Measured on the random holdout,
    // where the unrestricted rule put a correct comma in the damage column.
    const w0 = words(before)[0] || "";
    // Capitalised mid-sentence means a name, so it heads a noun phrase whatever
    // the word list says -- "No May 14th" is the month, not the modal.
    const raw1 = words(before)[1] || "";
    const w1 = /^[A-Z]/.test(raw1) ? "" : letters(raw1);
    if (NEGATIONS.test(letters(w0)) && !/[,;:]$/.test(w0)
        && !CLAUSE_STARTERS.has(w1)
        && /^[^\s]+[,;:]/.test(after) && letters(words(after)[0] || "") === letters(w0)) {
      return { kind: "meaning", why: "negation-comma" };
    }
    const kinds = [];
    if (words(before).length !== words(after).length) kinds.push("hyphen/space");
    if (before.replace(/[^A-Za-z]/g, "") !== after.replace(/[^A-Za-z]/g, "")) kinds.push("casing");
    if (/['’]/.test(after) && !/['’]/.test(before)) kinds.push("apostrophe");
    if (!kinds.length) kinds.push("punctuation");
    return { kind: "style", why: kinds.join("+") };
  }
  const nb = a.filter((w) => NEGATIONS.test(w)).length;
  const na = b.filter((w) => NEGATIONS.test(w)).length;
  if (nb !== na) return { kind: "meaning", why: "negation-changed" };
  const numB = a.filter((w) => /\d/.test(w)).join(",");
  const numA = b.filter((w) => /\d/.test(w)).join(",");
  if (numB !== numA) return { kind: "meaning", why: "number-changed" };
  if (b.length > a.length) {
    // A supplied function word mid-sentence is a grammar fix under this rubric.
    // The same word at the END is not a repair -- it is the model finishing a
    // fragment the user left deliberately short.
    const added = diffAdded(a, b);
    const atEnd = b.slice(0, a.length).join(" ") === a.join(" ");
    if (added.length && added.every((w) => FUNCTION_WORDS.has(w)) && !atEnd) {
      return { kind: "grammar", why: `inserted:${added.join("+")}` };
    }
    return { kind: "meaning", why: atEnd ? "fragment-completed" : "word-added" };
  }
  if (b.length < a.length) return { kind: "meaning", why: "word-deleted" };
  // Same words, different order. "I also am startled" -> "I am also startled"
  // is an adverb moved, not a word changed -- and word-for-word comparison
  // cannot see the difference, so it landed in the damage column as a
  // substitution. Every word survives, so nothing was replaced.
  const sa = a.slice().sort().join(" "), sb = b.slice().sort().join(" ");
  if (sa === sb) return { kind: "grammar", why: "word-reordered" };
  return { kind: "meaning", why: "word-substituted" };
}

// ----------------------------------------------------------------- labels
//
// Labels are keyed by uid -- message_id + a hash of the sentence text -- and
// NOT by row index. An index survives nothing: change the segmenter and every
// label silently slides onto its neighbour, which is worse than losing them,
// because the suite stays green while it scores the wrong sentences. A uid
// whose sentence changed simply stops matching, and the runner says so.
export function compileLabels(raw) {
  const out = new Map();
  for (const [uid, L] of Object.entries(raw.labels || {})) {
    if (L.class !== "ERROR") { out.set(uid, { cls: "CLEAN", note: L.note }); continue; }
    out.set(uid, {
      cls: "ERROR",
      err: new RegExp(L.err, L.errFlags ?? "i"),
      fix: new RegExp(L.fix, L.fixFlags ?? "i"),
      fixLiteral: L.fixLiteral ?? null,
      // Further errors in the SAME sentence. Not scored -- fixing one typo is a
      // fix and the rest is the damage axis's question -- but they have to be
      // applied when building the collateral baseline, or a correctly fixed
      // second typo reads as collateral damage.
      also: (L.also || []).map((a) => ({ err: new RegExp(a.err, a.errFlags ?? "i"), lit: a.fixLiteral })),
      note: L.note,
      borderline: !!L.borderline,
    });
  }
  return out;
}

/**
 * Did the model do anything BEYOND the expected correction? Rewrite the source
 * with the canonical fix applied, then classify what is left. Without a
 * `fixLiteral` the question cannot be asked, and the case is reported as
 * `collateral-unknown` rather than quietly counted as safe.
 */
export function collateralOf(src, out, L) {
  if (!L.fixLiteral) return { known: false };
  let fixed = src.replace(L.err, L.fixLiteral);
  if (fixed === src) return { known: false };
  // Compare against BOTH readings: the sentence with only the scored fix, and
  // the sentence with every known error in it fixed. The model is free to do
  // either, and neither is collateral.
  const all = L.also.reduce((s, a) => s.replace(a.err, a.lit), fixed);
  for (const cand of new Set([fixed, all])) {
    if (cand.trim() === out.trim()) return { known: true, kind: "none", why: "exact" };
  }
  const cs = [...new Set([fixed, all])].map((c) => classifyEdit(c, out));
  const best = cs.find((c) => c.kind !== "meaning") || cs[0];
  return { known: true, kind: best.kind, why: best.why };
}

// ---------------------------------------------------------------------- score
export function score(rows, labels, corpus) {
  const byUid = new Map(corpus.items.map((i) => [i.uid, i]));
  // Older recordings predate uids. Fall back to the sentence text, which is
  // what the uid hashes anyway -- but only while it is unique in this corpus,
  // because a duplicate sentence has no single right answer.
  const bySentence = new Map();
  for (const i of corpus.items) {
    const k = i.sentence.trim();
    bySentence.set(k, bySentence.has(k) ? null : i.uid);
  }
  const R = {
    corpus: corpus.name, digest: corpus.digest, n: rows.length,
    labelled: 0, unlabelled: 0, missingUid: 0,
    errors: 0, clean: 0,
    fixedSafeApplied: 0, fixedWithCollateral: 0, fixedCollateralUnknown: 0,
    fixedRefused: 0, wrongOutput: 0, wrongOutputApplied: 0, errNoOp: 0, errErrored: 0,
    cleanApplied: 0, cleanRefused: 0, cleanNoOp: 0, cleanErrored: 0,
    meaningDamageApplied: 0, welcomeStyleApplied: 0, grammarApplied: 0,
    styleWhy: {}, grammarWhy: {}, damageWhy: {}, refusals: {},
    rawMeaningOnClean: 0, fragCompletions: 0,
    damage: [], errorCases: [], borderlines: [], lat: [],
  };
  for (const r of rows) {
    const uid = r.uid || bySentence.get(String(r.sentence).trim()) || null;
    const item = uid ? byUid.get(uid) : null;
    if (!item) { R.missingUid++; continue; }
    const L = labels.get(uid);
    if (!L) R.unlabelled++; else R.labelled++;
    const isErr = L && L.cls === "ERROR";
    if (typeof r.ms === "number") R.lat.push(r.ms);
    const out = r.output == null ? null : String(r.output).trim();
    const src = String(r.sentence).trim();
    const outcome = r.outcome
      || (out == null ? "error" : out === src ? "no-op" : r.verdict ? "refused" : "applied");
    if (r.verdict) R.refusals[r.verdict] = (R.refusals[r.verdict] || 0) + 1;

    // Model-quality signals, counted BEFORE the guards get a vote.
    if (out && out !== src && !isErr) {
      if (classifyEdit(src, out).kind === "meaning") R.rawMeaningOnClean++;
      const a = coreWords(src), b = coreWords(out);
      if (b.length > a.length && a.every((w, k) => b[k] === w)) R.fragCompletions++;
    }

    if (isErr) {
      R.errors++;
      if (L.borderline) R.borderlines.push({ uid, sentence: src, note: L.note });
      if (outcome === "error") { R.errErrored++; continue; }
      const fixed = L.fix.test(out);
      const untouched = L.err.test(out);
      let bucket;
      if (fixed && outcome === "applied") {
        const col = collateralOf(src, out, L);
        if (!col.known) { bucket = "fixedCollateralUnknown"; }
        else if (col.kind === "meaning") { bucket = "fixedWithCollateral"; }
        else bucket = "fixedSafeApplied";
        if (bucket === "fixedWithCollateral") {
          R.damage.push({ uid, why: `collateral:${col.why}`, sentence: src, output: out });
        }
      } else if (fixed) bucket = "fixedRefused";
      else if (untouched) bucket = "errNoOp";
      else {
        bucket = "wrongOutput";
        // A wrong rewrite that was APPLIED is harm, and it is harm of exactly
        // the kind the gate exists to catch. Counting it only as "wrong-output"
        // hid it: the sentence had an error, so it never reached the clean
        // column, and the error column reads as a missed fix rather than a
        // silent rewrite of the user's words.
        if (outcome === "applied") {
          R.wrongOutputApplied++;
          R.damage.push({ uid, why: "wrong-fix-applied", sentence: src, output: out });
        }
      }
      R[bucket]++;
      R.errorCases.push({ uid, bucket, outcome, verdict: r.verdict || null, sentence: src, output: out });
    } else {
      R.clean++;
      if (outcome === "error") { R.cleanErrored++; continue; }
      if (outcome === "no-op") { R.cleanNoOp++; continue; }
      if (outcome === "refused") { R.cleanRefused++; continue; }
      R.cleanApplied++;
      const c = classifyEdit(src, out);
      if (c.kind === "style") {
        R.welcomeStyleApplied++; R.styleWhy[c.why] = (R.styleWhy[c.why] || 0) + 1;
      } else if (c.kind === "grammar") {
        R.grammarApplied++; R.grammarWhy[c.why] = (R.grammarWhy[c.why] || 0) + 1;
      } else {
        R.meaningDamageApplied++; R.damageWhy[c.why] = (R.damageWhy[c.why] || 0) + 1;
        R.damage.push({ uid, why: c.why, sentence: src, output: out });
      }
    }
  }
  // The old headline number, kept as a diagnostic only: how many sentences the
  // user meant came back byte-identical. It moves with chattiness, and under
  // this rubric chattiness is not harm.
  R.meddlingRate = R.clean ? +(100 * R.cleanApplied / R.clean).toFixed(1) : null;
  R.exactClean = R.clean - R.cleanApplied;
  R.damageUids = R.damage.map((d) => d.uid).sort();
  R.damagePer100 = R.clean + R.errors
    ? +(100 * R.damage.length / (R.clean + R.errors)).toFixed(2)
    : null;
  R.lat.sort((x, y) => x - y);
  R.medianMs = R.lat.length ? R.lat[Math.floor(R.lat.length / 2)] : null;
  R.p95Ms = R.lat.length ? R.lat[Math.floor(R.lat.length * 0.95)] : null;
  delete R.lat;
  return R;
}

const kv = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");

export function report(label, R, { review = false } = {}) {
  const pct = (x, d) => (d ? `${x} (${(100 * x / d).toFixed(1)}%)` : `${x}`);
  console.log(`\n=== ${label}   corpus=${R.corpus} digest=${R.digest} n=${R.n}`);
  if (R.unlabelled) console.log(`    ${R.unlabelled} sentences carry no label and were scored as CLEAN`);
  if (R.missingUid) console.log(`    !! ${R.missingUid} rows had no matching corpus uid (resegmented? wrong corpus?)`);
  console.log(`ERRORS (${R.errors})`);
  console.log(`  fixed-safe-applied      ${pct(R.fixedSafeApplied, R.errors)}      <- RAISE`);
  console.log(`  fixed-with-collateral   ${R.fixedWithCollateral}${R.fixedCollateralUnknown ? `   (collateral-unknown ${R.fixedCollateralUnknown})` : ""}`);
  console.log(`  fixed-refused           ${R.fixedRefused}`);
  console.log(`  wrong-output            ${R.wrongOutput}${R.wrongOutputApplied ? `   (${R.wrongOutputApplied} APPLIED -- counted as damage)` : ""}`);
  console.log(`  no-op                   ${R.errNoOp}${R.errErrored ? `   errored ${R.errErrored}` : ""}`);
  console.log(`CLEAN  (${R.clean})   applied ${R.cleanApplied}   refused ${R.cleanRefused}   no-op ${R.cleanNoOp}${R.cleanErrored ? `   errored ${R.cleanErrored}` : ""}`);
  console.log(`  meaning-damage-applied  ${R.meaningDamageApplied} [${kv(R.damageWhy)}]      <- HOLD`);
  console.log(`  welcome-style-applied   ${R.welcomeStyleApplied} [${kv(R.styleWhy)}]`);
  console.log(`  grammar-applied         ${R.grammarApplied} [${kv(R.grammarWhy)}]`);
  console.log(`TOTAL DAMAGE ${R.damage.length} / ${R.clean + R.errors} = ${R.damagePer100} per 100 sentences  (clean-meaning ${R.meaningDamageApplied} + collateral ${R.fixedWithCollateral} + wrong-fix-applied ${R.wrongOutputApplied})`);
  console.log(`diagnostic: meddling ${R.meddlingRate}% of clean touched (exact-clean ${R.exactClean}/${R.clean}) -- NOT a gate`);
  console.log(`model-level (pre-guard): meaning edits on clean ${R.rawMeaningOnClean}   fragment continuations ${R.fragCompletions}`);
  console.log(`latency median ${R.medianMs}ms  p95 ${R.p95Ms}ms`);
  for (const d of R.damage) {
    console.log(`  ! ${d.uid} (${d.why})\n      ${JSON.stringify(d.sentence)}\n   -> ${JSON.stringify(d.output)}`);
  }
  if (R.borderlines.length) {
    console.log(`borderline ERROR labels (${R.borderlines.length}) -- owner review:`);
    for (const b of R.borderlines) console.log(`  ~ ${b.uid} ${JSON.stringify(b.sentence)}  [${b.note || ""}]`);
  }
  if (review) {
    console.log("refusal reasons:", kv(R.refusals));
    for (const c of R.errorCases.filter((c) => c.bucket !== "fixedSafeApplied")) {
      console.log(`  ? ${c.uid} ${c.bucket} ${c.verdict || ""}\n      ${JSON.stringify(c.sentence)}\n   -> ${JSON.stringify(c.output)}`);
    }
  }
}

/** The gate. A SET comparison, not a count -- swapping one damaged sentence for
 *  another nets to zero and is still a regression. */
export function gate(R, baseline) {
  const before = new Set(baseline.damageUids || []);
  const now = R.damageUids;
  const added = now.filter((u) => !before.has(u));
  const fixed = [...before].filter((u) => !now.includes(u));
  console.log(`\nGATE vs baseline ${baseline.tag || "?"} (${baseline.digest})`);
  if (baseline.digest !== R.digest) {
    console.log(`  !! corpus digest changed (${baseline.digest} -> ${R.digest}); the baseline does not describe this corpus`);
  }
  console.log(`  baseline damage ${before.size}   now ${now.length}   NEW ${added.length}   repaired ${fixed.length}`);
  for (const u of added) {
    const d = R.damage.find((x) => x.uid === u);
    console.log(`  NEW ! ${u} (${d.why})\n      ${JSON.stringify(d.sentence)}\n   -> ${JSON.stringify(d.output)}`);
  }
  for (const u of fixed) console.log(`  repaired ${u}`);
  console.log(added.length ? "GATE FAIL: new meaning damage" : "GATE PASS: no new meaning damage");
  return added.length === 0;
}

// ------------------------------------------------------------------------ run
function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const DIR = process.env.PROOFER_CORPUS_DIR
  || new URL("./harvested/", import.meta.url).pathname;
const resolve = (f) => (f.includes("/") ? f : DIR.replace(/\/?$/, "/") + f);

async function main() {
  const corpusPath = arg("--corpus");
  if (!corpusPath) {
    console.error("usage: node sentence-owner-bench.mjs --corpus <file.json> [--replay f [--reguard] | --tag name] [--labels f] [--baseline f] [--write-baseline] [--review] [--limit n] [--conc n]");
    console.error(`corpora are resolved against PROOFER_CORPUS_DIR (${DIR})`);
    process.exit(2);
  }
  const corpus = JSON.parse(readFileSync(resolve(corpusPath), "utf8"));
  if (corpus.version !== 2) throw new Error(`corpus ${corpus.name} is version ${corpus.version}; expected 2 (uid-keyed)`);
  const labelPath = arg("--labels") || `labels-${corpus.name}.json`;
  const rawLabels = existsSync(resolve(labelPath))
    ? JSON.parse(readFileSync(resolve(labelPath), "utf8"))
    : { labels: {} };
  if (rawLabels.digest && rawLabels.digest !== corpus.digest) {
    console.error(`!! labels were authored against digest ${rawLabels.digest}, corpus is ${corpus.digest}`);
  }
  const labels = compileLabels(rawLabels);
  // uid-keyed labels: a label whose sentence no longer exists is LOUD, not silent.
  const known = new Set(corpus.items.map((i) => i.uid));
  const orphans = [...labels.keys()].filter((u) => !known.has(u));
  if (orphans.length) console.error(`!! ${orphans.length} labels do not match any sentence in this corpus: ${orphans.slice(0, 5).join(" ")}`);

  const review = process.argv.includes("--review");
  const replay = arg("--replay");
  const reguard = process.argv.includes("--reguard");
  const tag = arg("--tag") || "run";
  const limit = arg("--limit") ? Number(arg("--limit")) : Infinity;

  // --reguard re-judges a recorded run's OUTPUTS under the guards as they are
  // NOW, with the shipping sanitizer question before guards and no-op detection.
  // Raw output stays unchanged. This rejudges fixed answers; it does not rerun
  // the engine or its retry. This is the gating instrument for a
  // guard-only change: same model outputs, only the guards differ, so the
  // live gate's sampling noise (measured floor: >=1 phantom uid per re-run)
  // cannot reach it. It is meaningless without --replay -- there is no
  // recorded verdict to overrule on a live run -- so that is a caller error.
  if (reguard && !replay) {
    console.error("--reguard re-judges a RECORDED run; it requires --replay <file>");
    process.exit(2);
  }

  let rows;
  if (replay) {
    rows = readFileSync(resolve(String(replay)), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (reguard) {
      rows = rows.map((r) => {
        if (r.error) return r;
        const out = String(r.output ?? "");
        const cleaned = sanitizeSentenceOutput(r.sentence, out);
        const verdict = guardSentenceResult(r.sentence, out, cleaned);
        return { ...r, verdict, outcome: verdict ? "refused"
          : cleaned.trim() === r.sentence.trim() ? "no-op" : "applied" };
      });
    }
  } else {
    rows = await run(corpus, tag, limit);
  }
  const R = score(rows, labels, corpus);
  report(replay ? String(replay) : tag, R, { review });
  console.log(`SUMMARY ${corpus.name}/${tag}\tfixSafe=${R.fixedSafeApplied}/${R.errors}\tcollateral=${R.fixedWithCollateral}\tfixRefused=${R.fixedRefused}\twrong=${R.wrongOutput}\tnoop=${R.errNoOp}\tDAMAGE=${R.damage.length}\tper100=${R.damagePer100}\tstyle=${R.welcomeStyleApplied}\tgrammar=${R.grammarApplied}\tmeddling=${R.meddlingRate}%\tmedian=${R.medianMs}ms`);

  // 0600 on everything written here: these artifacts carry the corpus's real
  // sentences, and the default umask leaves them readable by other local
  // users. Both halves are needed -- the mode option only applies when the
  // file is CREATED, and chmod is what fixes one written permissive earlier.
  if (arg("--json")) {
    const p = resolve(String(arg("--json")));
    writeFileSync(p, JSON.stringify(R, null, 1), { mode: 0o600 });
    chmodSync(p, 0o600);
  }

  if (arg("--write-baseline") === true || typeof arg("--write-baseline") === "string") {
    const f = typeof arg("--write-baseline") === "string" ? String(arg("--write-baseline")) : `baseline-${corpus.name}.json`;
    writeFileSync(resolve(f), JSON.stringify({
      corpus: corpus.name, digest: corpus.digest, tag, recorded: new Date().toISOString(),
      model: HARNESS_MODEL,
      options: process.env.PROOFER_OPTIONS || "{}",
      backgroundSha: createHash("sha256").update(readFileSync(new URL("../background.js", import.meta.url))).digest("hex").slice(0, 16),
      summary: {
        n: R.n, errors: R.errors, clean: R.clean,
        fixedSafeApplied: R.fixedSafeApplied, fixedWithCollateral: R.fixedWithCollateral,
        fixedRefused: R.fixedRefused, wrongOutput: R.wrongOutput,
        wrongOutputApplied: R.wrongOutputApplied, errNoOp: R.errNoOp,
        meaningDamageApplied: R.meaningDamageApplied, welcomeStyleApplied: R.welcomeStyleApplied,
        grammarApplied: R.grammarApplied, meddlingRate: R.meddlingRate, damagePer100: R.damagePer100,
      },
      damageUids: R.damageUids,
      damage: R.damage,
    }, null, 1), { mode: 0o600 });
    chmodSync(resolve(f), 0o600);
    console.log(`baseline written: ${resolve(f)}`);
  }

  const baselinePath = arg("--baseline");
  if (baselinePath) {
    const ok = gate(R, JSON.parse(readFileSync(resolve(String(baselinePath)), "utf8")));
    if (!ok) process.exitCode = 1;
  }
}

async function run(corpus, tag, limit) {
  const MODEL = HARNESS_MODEL;
  const OLLAMA = process.env.PROOFER_OLLAMA_URL || "http://localhost:11434";
  const OPTS = process.env.PROOFER_OPTIONS ? JSON.parse(process.env.PROOFER_OPTIONS) : {};
  const variantPath = process.env.PROOFER_VARIANT || arg("--variant");
  const variant = variantPath ? (await import(new URL(variantPath, import.meta.url))).default : null;
  const CONC = Number(arg("--conc") || process.env.PROOFER_CONC || 3);
  const OUT = resolve(`bench-${corpus.name}-${tag}.jsonl`);
  // 0600 -- the run file holds every corpus sentence and every model output;
  // appendFileSync below inherits the file's mode. chmod as well as the mode
  // option, because the option only applies at creation and this path
  // truncates a pre-existing run file in place.
  writeFileSync(OUT, "", { mode: 0o600 });
  chmodSync(OUT, 0o600);
  const work = corpus.items.slice(0, limit);
  const rows = new Array(work.length);
  let next = 0, done = 0;

  async function one(t) {
    const req = prepareSentenceRequest(t.sentence, t.context, { hostname: "discord.com" }, { ollamaModel: MODEL });
    Object.assign(req.body.options, OPTS);
    if (variant) req.body.messages = variant(req.body.messages, { sentence: t.sentence, context: t.context });
    const t0 = Date.now();
    let data = null, out = null, error = null;
    try {
      const res = await fetch(OLLAMA + "/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body),
      });
      data = await res.json();
    } catch (e) { error = String(e.message); }
    const ms = Date.now() - t0;
    if (!error) {
      if (data.error) error = String(data.error);
      else if (data.done_reason === "length") error = "truncated";
      else {
        try {
          const p = JSON.parse(String(data.message?.content ?? "").trim());
          out = typeof p?.rewritten === "string" ? p.rewritten : null;
          if (out === null) error = "no-rewritten-key";
        } catch { error = "bad-json"; }
      }
    }
    let verdict = null, outcome;
    if (error) outcome = "error";
    else {
      const cleaned = sanitizeSentenceOutput(t.sentence, out);
      verdict = guardSentenceResult(t.sentence, out, cleaned);
      outcome = verdict ? "refused" : cleaned.trim() === t.sentence.trim() ? "no-op" : "applied";
    }
    return { uid: t.uid, message_id: t.message_id, sentence: t.sentence, output: out, verdict, outcome, ms, error };
  }

  await Promise.all(Array.from({ length: Math.min(CONC, work.length) }, async () => {
    while (next < work.length) {
      const i = next++;
      rows[i] = await one(work[i]);
      if (++done % 50 === 0) process.stderr.write(`  ${tag} ${done}/${work.length}\n`);
    }
  }));
  // Written in corpus order. Rows carry their uid, so order is not load-bearing
  // for scoring -- but a diffable file is worth the sort.
  for (const r of rows) appendFileSync(OUT, JSON.stringify(r) + "\n");
  console.error(`wrote ${OUT}`);
  return rows;
}

if (String(process.argv[1] || "").endsWith("sentence-owner-bench.mjs")) await main();
