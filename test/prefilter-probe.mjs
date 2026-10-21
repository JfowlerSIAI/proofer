#!/usr/bin/env node
/**
 * EXPERIMENT, NOT A GATE.
 *
 * Does a cheap lexical pre-check earn the right to SKIP the model call?
 *
 * The proposal: the worker already holds a fast lexical toolkit -- words-en.txt
 * (64k), 463 directed confusable licences, the inflection relation, the
 * Damerau distance. Real traffic is overwhelmingly clean, so most sentence
 * requests exist to produce a no-op. If "does this sentence contain a non-word,
 * a doubled word, or a licensed confusable?" answers NO, skip the request:
 * fewer GPU wake-ups, and CLEAN sentences are where every meddling risk lives.
 *
 * The claim is falsifiable offline. The corpora are recorded with the model's
 * actual output per sentence, so a replay says exactly which corrections the
 * filter would have suppressed and which damage it would have prevented.
 *
 * Method
 *   For each (corpus, recorded run) pair, decide the filter's verdict from the
 *   INPUT sentence alone, force every skipped row to `no-op`, and re-score with
 *   sentence-owner-bench's own scorer. Everything reported is a delta against
 *   the same run scored unfiltered, so the model is held fixed by construction.
 *
 * The lexical internals are read out of background.js in a vm, the same trick
 * lib/sentence-guards.mjs uses -- a probe that re-implements isWord() is
 * measuring a filter the extension could not actually build.
 *
 * Usage:
 *   node prefilter-probe.mjs                       # everything
 *   node prefilter-probe.mjs --json out.json       # dump the full result
 *   node prefilter-probe.mjs --run item5live       # score a different recording
 *   node prefilter-probe.mjs --examples 12         # show N suppressed fixes
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import { compileLabels, score, classifyEdit } from "./sentence-owner-bench.mjs";
import { RECALL_SHOULD } from "./lib/recall-cases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARVEST = join(__dirname, "harvested");
const arg = (n, d = null) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : (process.argv[i + 1] ?? true);
};

// ------------------------------------------------- the shipping lexical toolkit
const noop = () => {};
const ctx = vm.createContext({
  chrome: {
    runtime: {
      onMessage: { addListener: noop }, onInstalled: { addListener: noop },
      getURL: (p) => join(__dirname, "..", p),
    },
    storage: { local: { get: (k, cb) => cb({}), set: noop, remove: noop } },
    tabs: { create: noop },
  },
  console, fetch, setTimeout, clearTimeout, AbortController, URL,
  crypto: globalThis.crypto, TextEncoder,
});
vm.runInContext(readFileSync(join(__dirname, "..", "background.js"), "utf8") + `
;globalThis.__lex = {
  bare, sWords, isWord, haveDictionary, PROTECTED, isShiftStutter, unstutter,
  nearWord, editDistance, isConfusable, isRespelling, CONFUSABLE,
  setDictionary, setConfusables, parseConfusables, CONFUSABLES_COUNT,
  STUTTER_WORDS, CALENDAR_WORDS, FUNCTION_WORDS, guardSentenceResult,
};`, ctx);
const L = ctx.__lex;

// Load through the real loader's parse+verify, off disk.
const WORDS = readFileSync(join(__dirname, "..", "data", "words-en.txt"), "utf8")
  .split("\n").map((w) => w.replace(/\r$/, "")).filter(Boolean);
L.setDictionary(WORDS);
const genPairs = await L.parseConfusables(
  readFileSync(join(__dirname, "..", "data", "confusables-en.txt"), "utf8"));
if (!genPairs) throw new Error("data/confusables-en.txt failed the shipping integrity check");
L.setConfusables(genPairs);

// Every word the guards will license a substitution AWAY from, in either list.
const CONFUSABLE_TYPED = new Set(
  [...L.CONFUSABLE, ...genPairs].map((p) => p.split("|")[0]));
const GEN_TYPED = new Set([...genPairs].map((p) => p.split("|")[0]));

// ------------------------------------------------------------------ the filter
//
// A token is "known" if the dictionary can account for it. The normalisations
// are the ones a filter would have to do anyway -- without them a contraction
// or a hyphenated compound reads as a typo and the filter never fires at all.
const stripApos = (s) => s.replace(/['’;:]/g, "");
// Detect bare coordination with no comma before the conjunction, together
// with a lowercase sentence opener.
const COMMA_OPP = /[^,;:]\s(?:but|so|yet|because|although|though|while|which|however)\s/i;
function known(k) {
  if (!k) return true;
  if (L.isWord(k)) return true;
  if (L.isWord(stripApos(k))) return true;                 // don't, clients'
  const poss = k.replace(/['’]s$/, "");                    // Alice's -> alice
  if (poss !== k && L.isWord(poss)) return true;
  if (k.includes("-")) {                                   // well-known
    const parts = k.split("-").filter(Boolean);
    if (parts.length > 1 && parts.every((p) => L.isWord(p) || L.isWord(stripApos(p)))) return true;
  }
  return false;
}

/**
 * Which clauses fire on this sentence. `caps` selects how a capitalised token
 * the dictionary cannot hold is treated -- the word list is lowercase common
 * nouns by design, so every proper noun is an unknown token.
 *   "all"     nothing is exempt (a capitalised typo is caught; every name sends)
 *   "midcaps" capitalised NOT at the start of the sentence is a name
 *   "allcaps" any capitalised token is a name
 */
function clauses(sentence, { caps = "midcaps" } = {}) {
  const out = {
    nonword: false, doubled: false, confusable: false,
    confusableGen: false, confusableContent: false, unknownTokens: [],
  };
  // A clause the model would put a comma in front of, with no comma there.
  out.commaOpp = COMMA_OPP.test(sentence);
  const toks = L.sWords(L.unstutter(sentence));
  let prevBare = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const k = L.bare(t);
    if (!k) { prevBare = null; continue; }
    if (prevBare && k === prevBare) out.doubled = true;
    prevBare = k;
    if (CONFUSABLE_TYPED.has(k)) {
      out.confusable = true;
      if (GEN_TYPED.has(k)) out.confusableGen = true;
      if (!L.FUNCTION_WORDS.has(k)) out.confusableContent = true;
    }
    // A protected token is code, a handle, a URL or an acronym. The guards
    // refuse any sentence that loses one, so it cannot be the thing a request
    // would fix -- exempting it costs no recall.
    if (L.PROTECTED.test(t) && !L.isShiftStutter(t)) continue;
    const capitalised = /^[A-Z]/.test(t.replace(/^[^A-Za-z]+/, ""));
    if (capitalised && (caps === "allcaps" || (caps === "midcaps" && i > 0))) continue;
    if (!known(k)) { out.nonword = true; out.unknownTokens.push(k); }
  }
  return out;
}

// Filter variants. `send` is true when the model WOULD be called.
const VARIANTS = {
  "F1 nonword":                 (c) => c.nonword,
  "F2 +doubled":                (c) => c.nonword || c.doubled,
  "F3 +confusable (proposal)":  (c) => c.nonword || c.doubled || c.confusable,
  // The confusable clause is what the proposal adds on top of a spell-check,
  // and English's commonest confusions are between its commonest words -- "to",
  // "of", "its", "there", "then". Two narrowings, to find out whether the
  // clause can be bought cheaply or is all-or-nothing.
  "F4 +gen-confusable only":    (c) => c.nonword || c.doubled || c.confusableGen,
  "F5 +confusable, no fn-word": (c) => c.nonword || c.doubled || c.confusableContent,
  // 3 of every 4 edits F1 cancels are a comma the owner's rubric WELCOMES, and
  // a comma is invisible to a word list by construction. Can they be bought
  // back with a clause about where a comma could go?
  "F6 F2 + comma-opportunity":  (c) => c.nonword || c.doubled || c.commaOpp,
};
const CAPS_MODES = ["all", "midcaps", "allcaps"];

// ------------------------------------------------------------------- utilities
const pct = (x, d) => (d ? `${(100 * x / d).toFixed(1)}%` : "-");
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

function loadCorpus(name) {
  const corpus = JSON.parse(readFileSync(join(HARVEST, `${name}.json`), "utf8"));
  const labelPath = join(HARVEST, `labels-${name}.json`);
  const raw = existsSync(labelPath) ? JSON.parse(readFileSync(labelPath, "utf8")) : { labels: {} };
  return { corpus, labels: compileLabels(raw) };
}
const loadRows = (f) =>
  readFileSync(join(HARVEST, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Force every skipped row to a no-op: that is exactly what not calling the model does. */
const applyFilter = (rows, sendSet) =>
  rows.map((r) => (sendSet.has(r.uid) ? r : { ...r, output: r.sentence, verdict: null, outcome: "no-op", ms: 0 }));

const RESULT = { generatedAt: null, corpora: {}, recall: {}, latency: {}, residency: {} };

// =============================================================== 1. skip rates
console.log("=".repeat(78));
console.log("TEST 1  How often does the filter clear a sentence? (skip = no model call)");
console.log("=".repeat(78));

const CORPORA = [
  { name: "random-holdout", run: `bench-random-holdout-${arg("--run", "run")}.jsonl`, what: "real Discord traffic" },
  { name: "error-holdout",  run: `bench-error-holdout-${arg("--run", "run")}.jsonl`,  what: "error-enriched" },
];

const loaded = CORPORA.map((c) => ({ ...c, ...loadCorpus(c.name) }));

for (const mode of CAPS_MODES) {
  console.log(`\n  caps=${mode}`);
  console.log(`    ${pad("corpus", 18)}${pad("variant", 28)}${padl("send", 6)}${padl("skip", 7)}${padl("skip%", 8)}`);
  for (const c of loaded) {
    const cl = c.corpus.items.map((i) => clauses(i.sentence, { caps: mode }));
    for (const [vname, fn] of Object.entries(VARIANTS)) {
      const send = cl.filter(fn).length;
      console.log(`    ${pad(c.name, 18)}${pad(vname, 28)}${padl(send, 6)}${padl(cl.length - send, 7)}${padl(pct(cl.length - send, cl.length), 8)}`);
    }
  }
}

// clause attribution, at the default caps mode
console.log(`\n  clause attribution (caps=midcaps), % of sentences firing each clause alone:`);
for (const c of loaded) {
  const cl = c.corpus.items.map((i) => clauses(i.sentence));
  const n = cl.length;
  const only = (f) => cl.filter(f).length;
  console.log(`    ${pad(c.name, 18)} nonword ${padl(pct(only((x) => x.nonword), n), 7)}`
    + `  doubled ${padl(pct(only((x) => x.doubled), n), 7)}`
    + `  confusable ${padl(pct(only((x) => x.confusable), n), 7)}`
    + `  confusable-ONLY ${padl(pct(only((x) => x.confusable && !x.nonword && !x.doubled), n), 7)}`);
}

// what the unknown tokens actually are -- is this a typo signal or a name signal?
console.log(`\n  most common UNKNOWN tokens on random-holdout (caps=midcaps):`);
{
  const c = loaded[0];
  const freq = new Map();
  for (const i of c.corpus.items)
    for (const t of clauses(i.sentence).unknownTokens) freq.set(t, (freq.get(t) || 0) + 1);
  const top = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log("    " + top.map(([w, n]) => `${w}(${n})`).join(" "));
  console.log(`    distinct unknown tokens: ${freq.size}`);
}

// ============================================ 2/3/4. what the filter costs & buys
console.log("\n" + "=".repeat(78));
console.log("TEST 2-4  Replay: which fixes are suppressed, which damage is prevented");
console.log("=".repeat(78));

const examplesWanted = Number(arg("--examples", 8));

for (const c of loaded) {
  if (!existsSync(join(HARVEST, c.run))) { console.log(`\n  !! no recording ${c.run}`); continue; }
  const rows = loadRows(c.run);
  const base = score(rows, c.labels, c.corpus);
  console.log(`\n  ${c.name} (${c.what})  n=${rows.length}  recording=${c.run}`);
  console.log(`    UNFILTERED: RAISE ${base.fixedSafeApplied}/${base.errors}   damage ${base.damage.length}`
    + `   welcome-style ${base.welcomeStyleApplied}   grammar ${base.grammarApplied}   clean-no-op ${base.cleanNoOp}`);
  console.log(`    ${pad("variant", 28)}${pad("caps", 9)}${padl("skip%", 7)}${padl("RAISE", 7)}${padl("lost", 6)}`
    + `${padl("damage", 8)}${padl("prevented", 11)}${padl("style", 7)}${padl("grammar", 9)}`);

  const store = (RESULT.corpora[c.name] = { run: c.run, n: rows.length, base: {
    errors: base.errors, clean: base.clean, raise: base.fixedSafeApplied,
    damage: base.damage.length, style: base.welcomeStyleApplied, grammar: base.grammarApplied,
  }, variants: [] });

  for (const mode of CAPS_MODES) {
    for (const [vname, fn] of Object.entries(VARIANTS)) {
      const sendSet = new Set(c.corpus.items.filter((i) => fn(clauses(i.sentence, { caps: mode }))).map((i) => i.uid));
      const R = score(applyFilter(rows, sendSet), c.labels, c.corpus);
      const lostFix = base.fixedSafeApplied - R.fixedSafeApplied;
      const prevented = base.damage.length - R.damage.length;
      console.log(`    ${pad(vname, 28)}${pad(mode, 9)}${padl(pct(rows.length - sendSet.size, rows.length), 7)}`
        + `${padl(R.fixedSafeApplied, 7)}${padl(lostFix, 6)}${padl(R.damage.length, 8)}${padl(prevented, 11)}`
        + `${padl(R.welcomeStyleApplied, 7)}${padl(R.grammarApplied, 9)}`);
      store.variants.push({
        variant: vname, caps: mode, skipPct: +pct(rows.length - sendSet.size, rows.length).replace("%", ""),
        raise: R.fixedSafeApplied, lostFix, damage: R.damage.length, prevented,
        style: R.welcomeStyleApplied, grammar: R.grammarApplied,
      });
    }
  }

  // Name the losses. A number without the sentences behind it cannot be judged.
  const sendSet = new Set(c.corpus.items.filter((i) =>
    VARIANTS["F3 +confusable (proposal)"](clauses(i.sentence))).map((i) => i.uid));
  const filtered = applyFilter(rows, sendSet);
  const R = score(filtered, c.labels, c.corpus);
  const baseRaise = new Set(base.errorCases.filter((e) => e.bucket === "fixedSafeApplied").map((e) => e.uid));
  const nowRaise = new Set(R.errorCases.filter((e) => e.bucket === "fixedSafeApplied").map((e) => e.uid));
  const lost = [...baseRaise].filter((u) => !nowRaise.has(u));
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  if (lost.length) {
    console.log(`\n    SUPPRESSED FIXES under F3/midcaps (${lost.length}):`);
    for (const u of lost.slice(0, examplesWanted)) {
      const r = byUid.get(u);
      console.log(`      - ${JSON.stringify(r.sentence)}\n     -> ${JSON.stringify(r.output)}`);
    }
    if (lost.length > examplesWanted) console.log(`      ... ${lost.length - examplesWanted} more`);
  }
  const baseDmg = new Set(base.damage.map((d) => d.uid));
  const nowDmg = new Set(R.damage.map((d) => d.uid));
  const stopped = [...baseDmg].filter((u) => !nowDmg.has(u));
  if (stopped.length) {
    console.log(`\n    DAMAGE PREVENTED under F3/midcaps (${stopped.length}):`);
    for (const u of stopped) {
      const d = base.damage.find((x) => x.uid === u);
      console.log(`      - (${d.why}) ${JSON.stringify(d.sentence)}\n     -> ${JSON.stringify(d.output)}`);
    }
  }
  if (baseDmg.size && !stopped.length) {
    console.log(`\n    DAMAGE PREVENTED under F3/midcaps: 0 of ${baseDmg.size} -- every damaged sentence was SENT:`);
    for (const d of base.damage.slice(0, examplesWanted))
      console.log(`      = (${d.why}) ${JSON.stringify(d.sentence)}\n     -> ${JSON.stringify(d.output)}`);
  }
  store.lostFixExamples = lost.slice(0, 20).map((u) => ({ sentence: byUid.get(u).sentence, output: byUid.get(u).output }));
  store.damagePrevented = stopped.length;
}

// ================================================ 5. recall on the label sets
console.log("\n" + "=".repeat(78));
console.log("TEST 5  Model-free recall: does the filter SEND the sentences known to hold errors?");
console.log("=".repeat(78));
for (const c of loaded) {
  const errUids = new Set([...c.labels].filter(([, v]) => v.cls === "ERROR").map(([u]) => u));
  const errItems = c.corpus.items.filter((i) => errUids.has(i.uid));
  console.log(`\n  ${c.name}  ${errItems.length} labelled ERROR sentences`);
  for (const mode of CAPS_MODES) {
    const line = [];
    for (const [vname, fn] of Object.entries(VARIANTS)) {
      const sent = errItems.filter((i) => fn(clauses(i.sentence, { caps: mode }))).length;
      line.push(`${vname.split(" ")[0]} ${sent}/${errItems.length} (${pct(sent, errItems.length)})`);
    }
    console.log(`    caps=${pad(mode, 9)} ${line.join("   ")}`);
  }
  // Which errors are invisible to the strongest variant?
  const missed = errItems.filter((i) => !VARIANTS["F3 +confusable (proposal)"](clauses(i.sentence)));
  RESULT.recall[c.name] = { errors: errItems.length, missedByF3: missed.length };
  if (missed.length) {
    console.log(`    invisible to F3/midcaps (${missed.length}):`);
    for (const i of missed.slice(0, examplesWanted)) console.log(`      - ${JSON.stringify(i.sentence)}`);
    if (missed.length > examplesWanted) console.log(`      ... ${missed.length - examplesWanted} more`);
  }
}

// The hand-built recall set: ordinary typing mistakes the feature exists to fix.
console.log(`\n  RECALL_SHOULD (${RECALL_SHOULD.length} hand-built typo cases from sentence-typo-recall-test.mjs)`);
for (const mode of CAPS_MODES) {
  const line = [];
  for (const [vname, fn] of Object.entries(VARIANTS)) {
    const sent = RECALL_SHOULD.filter(([inp]) => fn(clauses(inp, { caps: mode }))).length;
    line.push(`${vname.split(" ")[0]} ${sent}/${RECALL_SHOULD.length} (${pct(sent, RECALL_SHOULD.length)})`);
  }
  console.log(`    caps=${pad(mode, 9)} ${line.join("   ")}`);
}
{
  const missed = RECALL_SHOULD.filter(([inp]) => !VARIANTS["F3 +confusable (proposal)"](clauses(inp)));
  RESULT.recall.handBuilt = { n: RECALL_SHOULD.length, missedByF3: missed.length };
  if (missed.length) {
    console.log(`    invisible to F3/midcaps (${missed.length}):`);
    for (const [inp, fix] of missed) console.log(`      - ${JSON.stringify(inp)}  ->  ${JSON.stringify(fix)}`);
  }
}

// ==================================================================== 6. cost
console.log("\n" + "=".repeat(78));
console.log("TEST 6  What does the check itself cost?");
console.log("=".repeat(78));
{
  const all = loaded.flatMap((c) => c.corpus.items.map((i) => i.sentence));
  for (let i = 0; i < 3; i++) all.forEach((s) => clauses(s));      // warm
  const t0 = process.hrtime.bigint();
  const REPS = 20;
  for (let i = 0; i < REPS; i++) all.forEach((s) => clauses(s));
  const t1 = process.hrtime.bigint();
  const perSentenceUs = Number(t1 - t0) / 1000 / (REPS * all.length);
  console.log(`  ${all.length} sentences x ${REPS} reps: ${perSentenceUs.toFixed(1)} us per sentence`);
  const t2 = process.hrtime.bigint();
  L.setDictionary(WORDS);
  const t3 = process.hrtime.bigint();
  console.log(`  dictionary build: ${(Number(t3 - t2) / 1e6).toFixed(1)} ms (already paid -- the guards need it either way)`);
  RESULT.latency = { perSentenceUs: +perSentenceUs.toFixed(2), dictBuildMs: +(Number(t3 - t2) / 1e6).toFixed(1) };
}

// ============================================== 7. does skipping cut residency?
console.log("\n" + "=".repeat(78));
console.log("TEST 7  Residency: the warmup fires per typing BURST, not per sentence");
console.log("=".repeat(78));
console.log("  A message is a burst. The warmup loads the model when typing starts, so a");
console.log("  message whose sentences are ALL skipped still paid the load and still re-armed");
console.log("  keep_alive. Only a fully-skipped message saves a wake-up.");
console.log("  And even a fully-skipped message does not save the wake-up: maybeWarmSentenceModel");
console.log("  fires on the FIRST KEYSTROKE of a burst, before a sentence exists to filter.");
for (const c of loaded) {
  const byMsg = new Map();
  for (const i of c.corpus.items) {
    if (!byMsg.has(i.message_id)) byMsg.set(i.message_id, []);
    byMsg.get(i.message_id).push(i);
  }
  for (const vname of ["F1 nonword", "F3 +confusable (proposal)"]) {
    const send = (i) => VARIANTS[vname](clauses(i.sentence));
    let allSkipped = 0, reqBefore = 0, reqAfter = 0, tailSkipped = 0;
    for (const items of byMsg.values()) {
      const s = items.filter(send).length;
      reqBefore += items.length; reqAfter += s;
      if (s === 0) allSkipped++;
      // The residency tail only shortens if the LAST request of the burst goes.
      if (items.length && !send(items[items.length - 1])) tailSkipped++;
    }
    console.log(`  ${pad(c.name, 17)} ${pad(vname, 27)} messages ${padl(byMsg.size, 4)}`
      + `  fully skipped ${padl(allSkipped, 4)} (${padl(pct(allSkipped, byMsg.size), 6)})`
      + `  requests ${reqBefore}->${reqAfter}`);
    RESULT.residency[`${c.name}/${vname}`] = { messages: byMsg.size, fullySkipped: allSkipped, tailSkipped, reqBefore, reqAfter };
  }
}

// ============================================================ 10. energy terms
console.log("\n" + "=".repeat(78));
console.log("TEST 10  Energy accounting: which term does the filter actually attack?");
console.log("=".repeat(78));
// Constants measured in this repo and documented in ARCHITECTURE.md.
const J_PER_REQUEST = 57;        // one real sentence request
const RESIDENT_W = 18.5;         // held continuously while the model is loaded
const KEEP_ALIVE_S = 90;         // OLLAMA_KEEP_ALIVE = 1.5m
for (const c of loaded) {
  const byMsg = new Map();
  for (const i of c.corpus.items) {
    if (!byMsg.has(i.message_id)) byMsg.set(i.message_id, []);
    byMsg.get(i.message_id).push(i);
  }
  const bursts = byMsg.size;
  const residencyJ = bursts * KEEP_ALIVE_S * RESIDENT_W;   // floor: one keep_alive per burst
  console.log(`\n  ${c.name}: ${bursts} bursts, ${c.corpus.items.length} sentences`);
  console.log(`    residency floor (warmup re-arms keep_alive once per burst, NOT filterable)`);
  console.log(`      ${bursts} x ${KEEP_ALIVE_S}s x ${RESIDENT_W}W = ${(residencyJ / 1000).toFixed(0)} kJ`);
  for (const vname of ["F1 nonword", "F3 +confusable (proposal)"]) {
    const sent = c.corpus.items.filter((i) => VARIANTS[vname](clauses(i.sentence))).length;
    const before = c.corpus.items.length * J_PER_REQUEST;
    const after = sent * J_PER_REQUEST;
    console.log(`    ${pad(vname, 27)} inference ${(before / 1000).toFixed(1)} -> ${(after / 1000).toFixed(1)} kJ`
      + `   saved ${((before - after) / 1000).toFixed(1)} kJ`
      + ` = ${pct(before - after, residencyJ + before)} of total energy`);
  }
}

// ================================== 8. what was actually IN the skipped bucket
console.log("\n" + "=".repeat(78));
console.log("TEST 8  Skip precision: of the requests the filter cancels, how many were no-ops?");
console.log("=".repeat(78));
console.log("  The benefit is only real for a request the model would have answered with the");
console.log("  input unchanged. A skip over a sentence the model DID change is a cancelled edit.");
for (const c of loaded) {
  if (!existsSync(join(HARVEST, c.run))) continue;
  const rows = loadRows(c.run);
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  console.log(`\n  ${c.name}`);
  console.log(`    ${pad("variant", 28)}${padl("skipped", 9)}${padl("no-op", 8)}${padl("refused", 9)}${padl("applied", 9)}${padl("precision", 11)}`);
  for (const [vname, fn] of Object.entries(VARIANTS)) {
    const skipped = c.corpus.items.filter((i) => !fn(clauses(i.sentence))).map((i) => byUid.get(i.uid)).filter(Boolean);
    const noop = skipped.filter((r) => r.outcome === "no-op").length;
    const ref = skipped.filter((r) => r.outcome === "refused").length;
    const app = skipped.filter((r) => r.outcome === "applied").length;
    console.log(`    ${pad(vname, 28)}${padl(skipped.length, 9)}${padl(noop, 8)}${padl(ref, 9)}${padl(app, 9)}`
      + `${padl(pct(noop + ref, skipped.length), 11)}`);
  }
  // What kind of edit does a skip cancel? Style is WELCOME under the rubric.
  const skipped = c.corpus.items.filter((i) => !VARIANTS["F1 nonword"](clauses(i.sentence)))
    .map((i) => byUid.get(i.uid)).filter((r) => r && r.outcome === "applied");
  const kinds = {};
  for (const r of skipped) {
    const k = classifyEdit(r.sentence, r.output);
    kinds[`${k.kind}:${k.why}`] = (kinds[`${k.kind}:${k.why}`] || 0) + 1;
  }
  console.log(`    F1 cancels ${skipped.length} APPLIED edits: `
    + Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
}

// ======================================= 9. replication + the pooled trade curve
console.log("\n" + "=".repeat(78));
console.log("TEST 9  Replication across recordings, pooled over both corpora");
console.log("=".repeat(78));
console.log("  random-holdout carries 14 labelled errors and error-holdout 50, so a single");
console.log("  run's fix-loss is a handful of sentences. Four independent recordings of the");
console.log("  same shipping path, pooled, say whether the trade is stable.");
const TAGS = ["run", "item5live", "cf419", "base9b"];
const pooled = {};
for (const tag of TAGS) {
  const files = loaded.map((c) => ({ c, f: `bench-${c.name}-${tag}.jsonl` }));
  if (!files.every(({ f }) => existsSync(join(HARVEST, f)))) { console.log(`  (no ${tag} recording pair)`); continue; }
  for (const [vname, fn] of Object.entries(VARIANTS)) {
    let skip = 0, n = 0, raiseB = 0, raiseA = 0, dmgB = 0, dmgA = 0, styB = 0, styA = 0, grmB = 0, grmA = 0;
    for (const { c, f } of files) {
      const rows = loadRows(f);
      const sendSet = new Set(c.corpus.items.filter((i) => fn(clauses(i.sentence))).map((i) => i.uid));
      const B = score(rows, c.labels, c.corpus);
      const A = score(applyFilter(rows, sendSet), c.labels, c.corpus);
      n += rows.length; skip += rows.length - sendSet.size;
      raiseB += B.fixedSafeApplied; raiseA += A.fixedSafeApplied;
      dmgB += B.damage.length; dmgA += A.damage.length;
      styB += B.welcomeStyleApplied; styA += A.welcomeStyleApplied;
      grmB += B.grammarApplied; grmA += A.grammarApplied;
    }
    (pooled[vname] ||= []).push({ tag, n, skip, raiseB, raiseA, dmgB, dmgA, styB, styA, grmB, grmA });
  }
}
console.log(`\n  ${pad("variant", 28)}${padl("skip%", 8)}${padl("fixes", 15)}${padl("damage", 13)}${padl("style", 17)}${padl("grammar", 14)}`);
for (const [vname, runs] of Object.entries(pooled)) {
  const rng = (f) => { const v = runs.map(f); return [Math.min(...v), Math.max(...v)]; };
  const [rbLo, rbHi] = rng((r) => r.raiseB), [raLo, raHi] = rng((r) => r.raiseA);
  const [dbLo, dbHi] = rng((r) => r.dmgB), [daLo, daHi] = rng((r) => r.dmgA);
  const [sbLo, sbHi] = rng((r) => r.styB), [saLo, saHi] = rng((r) => r.styA);
  const [gbLo, gbHi] = rng((r) => r.grmB), [gaLo, gaHi] = rng((r) => r.grmA);
  const sp = pct(runs[0].skip, runs[0].n);
  const R = (lo, hi) => (lo === hi ? `${lo}` : `${lo}-${hi}`);
  console.log(`  ${pad(vname, 28)}${padl(sp, 8)}`
    + `${padl(`${R(rbLo, rbHi)}->${R(raLo, raHi)}`, 15)}`
    + `${padl(`${R(dbLo, dbHi)}->${R(daLo, daHi)}`, 13)}`
    + `${padl(`${R(sbLo, sbHi)}->${R(saLo, saHi)}`, 17)}`
    + `${padl(`${R(gbLo, gbHi)}->${R(gaLo, gaHi)}`, 14)}`);
  RESULT.pooled ||= {};
  RESULT.pooled[vname] = { skipPct: sp, runs };
}
console.log(`  (pooled over ${loaded.map((c) => c.name).join(" + ")}, ${TAGS.length} recordings; ranges are across recordings)`);

console.log(`\n  TRADE: requests saved per unit of harm, pooled, mean over recordings`);
console.log(`  ${pad("variant", 28)}${padl("saved", 8)}${padl("fixes lost", 12)}${padl("welcome lost", 14)}${padl("damage prevented", 18)}`);
for (const [vname, runs] of Object.entries(pooled)) {
  const mean = (f) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  console.log(`  ${pad(vname, 28)}${padl(mean((r) => r.skip).toFixed(0), 8)}`
    + `${padl(mean((r) => r.raiseB - r.raiseA).toFixed(2), 12)}`
    + `${padl(mean((r) => (r.styB - r.styA) + (r.grmB - r.grmA)).toFixed(2), 14)}`
    + `${padl(mean((r) => r.dmgB - r.dmgA).toFixed(2), 18)}`);
}

// ================================================== 11. the matched-rate control
console.log("\n" + "=".repeat(78));
console.log("TEST 11  Control: is the filter better than skipping the same NUMBER at random?");
console.log("=".repeat(78));
console.log("  A filter that cancels 68% of requests prevents ~68% of damage for free, and");
console.log("  loses ~68% of fixes for free. The claim under test is that a lexical filter");
console.log("  CONCENTRATES errors in the sent bucket -- it must keep more fixes than chance");
console.log("  at the same skip count. Damage prevention alone proves nothing.");
// Deterministic RNG: a control that moves between runs cannot be compared to one.
let seed = 0x2545f491;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const TRIALS = 200;
for (const c of loaded) {
  if (!existsSync(join(HARVEST, c.run))) continue;
  const rows = loadRows(c.run);
  const base = score(rows, c.labels, c.corpus);
  const uids = c.corpus.items.map((i) => i.uid);
  console.log(`\n  ${c.name}  (baseline RAISE ${base.fixedSafeApplied}, damage ${base.damage.length}, welcome ${base.welcomeStyleApplied + base.grammarApplied})`);
  console.log(`    ${pad("variant", 28)}${padl("skip", 6)}${pad("", 3)}`
    + `${padl("fixes kept", 12)}${padl("chance", 14)}${padl("damage kept", 13)}${padl("chance", 14)}`);
  for (const [vname, fn] of Object.entries(VARIANTS)) {
    const sendSet = new Set(c.corpus.items.filter((i) => fn(clauses(i.sentence))).map((i) => i.uid));
    const k = uids.length - sendSet.size;
    const R = score(applyFilter(rows, sendSet), c.labels, c.corpus);
    // Matched-count random control.
    let raiseSum = 0, dmgSum = 0, raiseSq = 0;
    for (let t = 0; t < TRIALS; t++) {
      const shuffled = uids.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const rs = new Set(shuffled.slice(k));            // keep n-k senders
      const Rr = score(applyFilter(rows, rs), c.labels, c.corpus);
      raiseSum += Rr.fixedSafeApplied; raiseSq += Rr.fixedSafeApplied ** 2;
      dmgSum += Rr.damage.length;
    }
    const rMean = raiseSum / TRIALS;
    const rSd = Math.sqrt(Math.max(0, raiseSq / TRIALS - rMean ** 2));
    const z = rSd > 0 ? (R.fixedSafeApplied - rMean) / rSd : 0;
    console.log(`    ${pad(vname, 28)}${padl(k, 6)}${pad("", 3)}`
      + `${padl(`${R.fixedSafeApplied}/${base.fixedSafeApplied}`, 12)}`
      + `${padl(`${rMean.toFixed(1)} (z=${z >= 0 ? "+" : ""}${z.toFixed(1)})`, 14)}`
      + `${padl(`${R.damage.length}/${base.damage.length}`, 13)}`
      + `${padl(`${(dmgSum / TRIALS).toFixed(1)}`, 14)}`);
    RESULT.control ||= {};
    RESULT.control[`${c.name}/${vname}`] = {
      skip: k, fixesKept: R.fixedSafeApplied, chanceFixes: +rMean.toFixed(2), z: +z.toFixed(2),
      damageKept: R.damage.length, chanceDamage: +(dmgSum / TRIALS).toFixed(2),
    };
  }
}

// ============================================ 12. name the losses under F1
console.log("\n" + "=".repeat(78));
console.log("TEST 12  What F1 actually cancels (the aggressive variant, caps=midcaps)");
console.log("=".repeat(78));
for (const c of loaded) {
  if (!existsSync(join(HARVEST, c.run))) continue;
  const rows = loadRows(c.run);
  const byUid = new Map(rows.map((r) => [r.uid, r]));
  const base = score(rows, c.labels, c.corpus);
  const sendSet = new Set(c.corpus.items.filter((i) => VARIANTS["F1 nonword"](clauses(i.sentence))).map((i) => i.uid));
  const R = score(applyFilter(rows, sendSet), c.labels, c.corpus);
  const baseRaise = new Set(base.errorCases.filter((e) => e.bucket === "fixedSafeApplied").map((e) => e.uid));
  const nowRaise = new Set(R.errorCases.filter((e) => e.bucket === "fixedSafeApplied").map((e) => e.uid));
  console.log(`\n  ${c.name}: fixes lost (${[...baseRaise].filter((u) => !nowRaise.has(u)).length})`);
  for (const u of [...baseRaise].filter((x) => !nowRaise.has(x))) {
    const r = byUid.get(u);
    console.log(`    - ${JSON.stringify(r.sentence)}\n   -> ${JSON.stringify(r.output)}`);
  }
  const stopped = base.damage.filter((d) => !R.damage.some((x) => x.uid === d.uid));
  console.log(`  ${c.name}: damage prevented (${stopped.length})`);
  for (const d of stopped) console.log(`    - (${d.why}) ${JSON.stringify(d.sentence)}\n   -> ${JSON.stringify(d.output)}`);
  const styleLost = c.corpus.items.filter((i) => !sendSet.has(i.uid)).map((i) => byUid.get(i.uid))
    .filter((r) => r && r.outcome === "applied" && classifyEdit(r.sentence, r.output).kind === "style");
  console.log(`  ${c.name}: welcome STYLE edits cancelled (${styleLost.length}) -- first ${Math.min(6, styleLost.length)}:`);
  for (const r of styleLost.slice(0, 6)) console.log(`    - ${JSON.stringify(r.sentence)}\n   -> ${JSON.stringify(r.output)}`);
}

// ================================ 13. the residency duty cycle on real timing
console.log("\n" + "=".repeat(78));
console.log("TEST 13  Residency on the owner's REAL message timing (the dominant energy term)");
console.log("=".repeat(78));
{
  const srcPath = join(HARVEST, "discord-source.mjs");
  let msgs = null, segmentSentences = null, MIN_CHARS = 0;
  if (existsSync(srcPath)) {
    const src = await import(srcPath);
    const sandbox = await import("./lib/content-sandbox.mjs");
    segmentSentences = sandbox.segmentSentences; MIN_CHARS = sandbox.MIN_SENTENCE_CHARS;
    if (existsSync(src.CSV)) msgs = src.loadMessages();
    else console.log(`  SKIPPED: no export at ${src.CSV}`);
  } else console.log("  SKIPPED: harvested/discord-source.mjs is absent (owner data, gitignored)");

  if (msgs) {
    console.log(`  ${msgs.length} real messages. TEST 10's "one keep_alive per burst" is an`);
    console.log(`  OVERCOUNT -- in a conversation the 90s windows overlap, so the marginal cost`);
    console.log(`  of a burst is far less than 90s. Unioned intervals, three policies:`);
    console.log(`    P0  ships today: warm at burst start, keep_alive 90s after the last request`);
    console.log(`    P1  filter-gated unload: a burst that sends NOTHING unloads 10s after it ends`);
    console.log(`    P2  control: unload 10s after EVERY burst -- no filter involved at all`);
    const KEEP = 90, UNLOAD = 10, W = 18.5;
    const CPS_MODES = [2.5, 3.33, 5];
    console.log(`\n  ${pad("typing", 9)}${padl("bursts", 8)}${padl("no-send", 9)}`
      + `${padl("P0 kJ", 10)}${padl("P1 kJ", 10)}${padl("P2 kJ", 10)}${padl("P1 saves", 10)}${padl("P2 saves", 10)}`);
    for (const CPS of CPS_MODES) {
      const iv = { P0: [], P1: [], P2: [] };
      let noSend = 0;
      for (const m of msgs) {
        const sents = segmentSentences(m.content)
          .map((s) => s.text.trim())
          .filter((t) => t.length >= MIN_CHARS && t.length <= 500);
        const sent = sents.filter((t) => VARIANTS["F1 nonword"](clauses(t))).length;
        if (!sent) noSend++;
        const dur = Math.min(300, Math.max(1, m.content.length / CPS));
        const start = m.ts / 1000 - dur, end = m.ts / 1000;
        iv.P0.push([start, end + KEEP]);
        iv.P1.push([start, end + (sent ? KEEP : UNLOAD)]);
        iv.P2.push([start, end + UNLOAD]);
      }
      const union = (list) => {
        list.sort((a, b) => a[0] - b[0]);
        let total = 0, cs = null, ce = null;
        for (const [s, e] of list) {
          if (cs === null) { cs = s; ce = e; continue; }
          if (s <= ce) ce = Math.max(ce, e);
          else { total += ce - cs; cs = s; ce = e; }
        }
        if (cs !== null) total += ce - cs;
        return total;
      };
      const J = (secs) => (secs * W) / 1000;
      const p0 = J(union(iv.P0)), p1 = J(union(iv.P1)), p2 = J(union(iv.P2));
      console.log(`  ${pad(`${CPS} c/s`, 9)}${padl(msgs.length, 8)}${padl(pct(noSend, msgs.length), 9)}`
        + `${padl(p0.toFixed(0), 10)}${padl(p1.toFixed(0), 10)}${padl(p2.toFixed(0), 10)}`
        + `${padl(pct(p0 - p1, p0), 10)}${padl(pct(p0 - p2, p0), 10)}`);
      if (CPS === 3.33) RESULT.dutyCycle = { messages: msgs.length, noSendPct: +pct(noSend, msgs.length).replace("%", ""), p0kJ: +p0.toFixed(0), p1kJ: +p1.toFixed(0), p2kJ: +p2.toFixed(0) };
    }
    console.log(`\n  P1 vs P2 is the question that matters: if the unconditional unload gets`);
    console.log(`  most of what the filter-gated one gets, the FILTER is not what bought it.`);

    // --- Event-level: the lease policy that SHIPS (2026-08-25) ---------------
    //
    // The interval model above holds residency from typing start to end as one
    // solid block, so it structurally cannot see a MID-BURST expiry -- which is
    // the failure mode that refuted "just lower keep_alive": sentence requests
    // are 8-15s apart and a long sentence has no request in it for 20s+. This
    // places the actual CONTACTS instead: the ping content.js sends on the
    // first keystroke and then at most every RENEW seconds while typing (each
    // dedup'd against STALE, background.js's `hot` answer), plus one request
    // per eligible sentence at its terminator's offset. Then it simulates the
    // runner under each candidate lease. Columns:
    //
    //   kJ        unioned [contact, contact+lease] residency at qwen's +18.5W
    //             (the pilot's resident watts are lower; the ORDERING is what
    //             transfers, same caveat as the table above)
    //   hidden    cold loads paid by a PING -- the warmup eats the reload
    //             where nobody is waiting
    //   visible   cold loads paid by a sentence REQUEST -- a correction
    //             delayed by the load; the number that would sink the lease
    //   provoked  cold contacts whose gap is in (lease, 90s] -- reloads the
    //             cut tail provokes that the old shared 90s would have
    //             avoided: the doctrine's "how often a burst starts inside
    //             the window that was cut"
    //
    // STALE and RENEW mirror SENTENCE_WARM_STALE_MS and SENTENCE_WARM_RENEW_MS;
    // the 90s row is the old policy run through the same event model, so the
    // savings column is like-for-like rather than against the interval model.
    const RENEW = 10, STALE = 8;
    const LEASES = [15, 20, 30, 45, 60, 90];
    const union2 = (list) => {
      list.sort((a, b) => a[0] - b[0]);
      let total = 0, cs = null, ce = null;
      for (const [s, e] of list) {
        if (cs === null) { cs = s; ce = e; continue; }
        if (s <= ce) ce = Math.max(ce, e);
        else { total += ce - cs; cs = s; ce = e; }
      }
      if (cs !== null) total += ce - cs;
      return total;
    };
    const J2 = (secs) => (secs * W) / 1000;
    console.log(`\n  Event-level lease simulation (ping every ${RENEW}s while typing, stale ${STALE}s):`);
    for (const CPS of CPS_MODES) {
      const events = [];
      for (const m of msgs) {
        const len = m.content.length;
        const dur = Math.min(300, Math.max(1, len / CPS));
        const start = m.ts / 1000 - dur, end = m.ts / 1000;
        events.push([start, "ping"]);
        for (let t = start + RENEW; t < end; t += RENEW) events.push([t, "ping"]);
        for (const s of segmentSentences(m.content)) {
          const t = s.text.trim();
          if (t.length < MIN_CHARS || t.length > 500) continue;
          const off = Math.min(len, s.start + s.text.length);
          events.push([start + (off / len) * dur, "req"]);
        }
      }
      events.sort((a, b) => a[0] - b[0]);
      const reqs = events.filter((e) => e[1] === "req").length;
      const rows = LEASES.map((L) => {
        const intervals = [];
        let last = -Infinity, hidden = 0, visible = 0, provoked = 0;
        for (const [t, kind] of events) {
          const gap = t - last;
          if (kind === "ping" && gap <= STALE) continue;  // background answers `hot`
          if (gap > L) {
            if (kind === "ping") hidden++; else visible++;
            if (gap <= KEEP) provoked++;
          }
          intervals.push([t, t + L]);
          last = t;
        }
        return { L, kJ: J2(union2(intervals)), hidden, visible, provoked };
      });
      const base = rows.find((r) => r.L === 90).kJ;
      console.log(`\n  ${pad(`${CPS} c/s`, 9)}${padl("lease", 7)}${padl("kJ", 10)}${padl("saves", 8)}`
        + `${padl("hidden", 9)}${padl("visible", 12)}${padl("provoked", 10)}`);
      for (const r of rows) {
        console.log(`  ${pad("", 9)}${padl(`${r.L}s`, 7)}${padl(r.kJ.toFixed(0), 10)}`
          + `${padl(r.L === 90 ? "base" : pct(base - r.kJ, base), 8)}`
          + `${padl(r.hidden, 9)}${padl(`${r.visible}/${reqs}`, 12)}${padl(r.provoked, 10)}`);
        if (CPS === 3.33 && r.L === 20) {
          RESULT.leaseSim = { leaseS: r.L, kJ: +r.kJ.toFixed(0), hidden: r.hidden,
            visible: r.visible, requests: reqs, provoked: r.provoked };
        }
      }
    }
    console.log(`\n  The shipping lease is 20s; `
      + `visible is the count that would sink it, provoked is what the warmup must hide.`);
  }
}

if (arg("--json")) {
  RESULT.generatedAt = new Date().toISOString();
  writeFileSync(String(arg("--json")), JSON.stringify(RESULT, null, 2));
  console.log(`\nwrote ${arg("--json")}`);
}
