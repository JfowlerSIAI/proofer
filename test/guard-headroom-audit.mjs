#!/usr/bin/env node
// Where do the sentence-mode output guards still cost a CORRECT correction?
//
//   node guard-headroom-audit.mjs                       # collect + analyse
//   node guard-headroom-audit.mjs --from results/guard-headroom-raw.jsonl
//   node guard-headroom-audit.mjs --contexts none,benign,messy
//
// An audit tool, not a regression suite. It writes nothing to the repo except
// a raw JSONL of every trial, and it never modifies a shipping file.
//
// It runs four corpora through the SHIPPING request path (prepareSentenceRequest
// straight out of background.js) and, for every trial, records the model output
// and the guard verdict. Then it splits the refusals two ways:
//
//   correct-fix-refused   the output WAS the right answer and a guard said no
//   damage-refused        the output was wrong (or the sentence was already
//                         clean and the model changed it) and a guard said no
//
// The second column is the guard earning its keep; the first is its price.
// Refusals are then decomposed with guardSentenceReport -- the shipping
// chain's evidence mode, which asks EVERY guard and returns the full reason
// list -- so "what would removing guard X newly admit" is read straight off
// the reasons rather than simulated. (An earlier version neutralised `return
// "<reason>";` textually in a vm; when the chain moved to fail("<reason>")
// the patch matched nothing, and the tool printed "cannot patch" per guard
// and exited 0 -- a harness path that completes green and produces nothing.)

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { MODEL, OLLAMA_URL } from "./lib/harness.mjs";
import { CLEAN, ERRORS, CONTEXTS } from "./lib/sentence-corpus.mjs";
import { MULTI_TYPO } from "./lib/multi-typo-corpus.mjs";
import { prepareSentenceRequest, guardSentenceResult, guardSentenceReport, sanitizeSentenceOutput, loadSentenceGuards, SENTENCE_SOURCE } from "./lib/sentence-guards.mjs";
import { RECALL_SHOULD, RECALL_MUST_REFUSE } from "./lib/recall-cases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, "results", "guard-headroom-raw.jsonl");
const PAGE = { hostname: "example.com" };
const SETTINGS = { ollamaModel: MODEL };

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const fromFile = argOf("--from");
const ctxFilter = argOf("--contexts");

// ---------------------------------------------------------------------------
// A second guard chain, for the targeted-relaxation variants ONLY.
//
// The shared seam owns VM construction, exports and shipping data loaders for
// baseline and variants alike, including integrity checks and the historical
// dataset controls. Only the source patch differs; no dataset is restated here.
// Removal simulations use guardSentenceReport's full reason list instead.
// ---------------------------------------------------------------------------
const BG_SRC = SENTENCE_SOURCE;

// Targeted relaxations, expressed as a one-line source patch each. A removal
// simulation is an upper bound; these are the changes someone would actually
// make, so they get measured directly. A patch that does not apply is FATAL:
// it means background.js moved out from under the variant, and printing a
// note over an unmeasured variant is the silent-green defect again.
//
// Five variants that used to live here have SHIPPED, so their patches can
// never apply again and measuring them would diff the shipping behaviour
// against itself: stutter-by-dictionary and the calendar names (both now in
// isShiftStutter / STUTTER_WORDS), apostrophe-blind respelling and the added-
// negation rescue (now the noApos equality and NEGATION_CONTRACTION branches
// of isRespelling), and the combination of those. Prefix insertion is the one
// still on the table -- deliberately unshipped; PREFIX_HAZARDS below makes
// its known failure cases executable.
const VARIANTS = [
  {
    label: "respelling: prefix insertion",
    note: "a gained word that is the lost word with ONE letter in front counts as a " +
          "respelling even when the lost word is itself a word ('ince'->'since').",
    patch: (s) => s.replace(
      "    if (isWord(w) || !isWord(c)) return false;",
      "    if (c.length === w.length + 1 && c.slice(1) === w) return true;\n" +
      "    if (isWord(w) || !isWord(c)) return false;"),
  },
];

// Prefix insertion is the relaxation with a KNOWN price found in earlier audits. The must-refuse corpus does not contain these, so
// they are written down here rather than assumed absent.
const PREFIX_HAZARDS = [
  ["The old car was still cheap to run.", "The gold car was still cheap to run."],
  ["The oil was spread across the whole field.", "The soil was spread across the whole field."],
  ["It gave me a light that nothing else did.", "It gave me a flight that nothing else did."],
  ["The rain held off until the evening.", "The brain held off until the evening."],
  ["She left the range where we agreed.", "She left the orange where we agreed."],
  // A control: two letters, so prefix-insertion-of-one must NOT admit it.
  ["We reviewed the port again this morning.", "We reviewed the support again this morning."],
];

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------
async function ask(sentence, priorContext) {
  const req = prepareSentenceRequest(sentence, priorContext, PAGE, SETTINGS);
  let data;
  try {
    const res = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    data = await res.json();
  } catch (e) { return null; }
  if (data.error || data.done_reason === "length") return null;
  try {
    const v = JSON.parse(String(data.message?.content ?? "").trim())?.rewritten;
    return typeof v === "string" ? v : null;
  } catch { return null; }
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function collect() {
  const contexts = ctxFilter
    ? CONTEXTS.filter((c) => ctxFilter.split(",").includes(c.key))
    : CONTEXTS;
  mkdirSync(dirname(RAW), { recursive: true });
  writeFileSync(RAW, "");

  const trials = [];
  for (const ctx of contexts) {
    for (const e of ERRORS) trials.push({ corpus: "errors", ctx: ctx.key, ctxText: ctx.text, in: e.in, expected: [e.expected, ...(e.alsoOk || [])] });
    for (const s of CLEAN) trials.push({ corpus: "clean", ctx: ctx.key, ctxText: ctx.text, in: s, expected: [s] });
  }
  for (const c of MULTI_TYPO) trials.push({ corpus: `multi${c.typos}`, ctx: "none", ctxText: "", in: c.in, expected: [c.expected] });
  for (const [i, o] of RECALL_SHOULD) trials.push({ corpus: "recall", ctx: "none", ctxText: "", in: i, expected: [o] });

  console.log(`Collecting ${trials.length} trials (${contexts.length} context(s)) — model ${MODEL}`);
  let n = 0;
  const t0 = Date.now();
  for (const t of trials) {
    const out = await ask(t.in, t.ctxText);
    const rec = {
      corpus: t.corpus, ctx: t.ctx, in: t.in, expected: t.expected, out,
      correct: out !== null && t.expected.includes(out),
      nearCorrect: out !== null && norm(out) === norm(t.expected[0]),
      guard: out === null ? "no-output" : guardSentenceResult(t.in, out, sanitizeSentenceOutput(t.in, out)),
    };
    appendFileSync(RAW, JSON.stringify(rec) + "\n");
    if (++n % 100 === 0) {
      const rate = n / ((Date.now() - t0) / 1000);
      console.log(`  ${n}/${trials.length}  ${rate.toFixed(1)}/s  eta ${(((trials.length - n) / rate) / 60).toFixed(1)}m`);
    }
  }
  return trials.length;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
function load(path) {
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // The documented damage cases need no model: the bad output is written down.
  // They belong in the same table, because a relaxation that recovers a correct
  // fix has to be checked against them as well as against the clean corpus.
  for (const [i, o] of RECALL_MUST_REFUSE) {
    rows.push({
      corpus: "mustrefuse", ctx: "none", in: i, expected: [i], out: o,
      correct: false, nearCorrect: false, guard: guardSentenceResult(i, o, sanitizeSentenceOutput(i, o)),
    });
  }
  for (const [i, o] of PREFIX_HAZARDS) {
    rows.push({
      corpus: "hazard", ctx: "none", in: i, expected: [i], out: o,
      correct: false, nearCorrect: false, guard: guardSentenceResult(i, o, sanitizeSentenceOutput(i, o)),
    });
  }
  return rows;
}

// The guard reason, with the substituted word stripped so the family groups.
const family = (g) => (g && g.startsWith("word-substituted:") ? "word-substituted" : g);

const CORPORA = ["errors", "multi2", "multi3", "multi4", "recall", "clean", "mustrefuse", "hazard"];
const DAMAGE_CORPORA = new Set(["mustrefuse", "hazard"]);

function classify(r) {
  // Even an echo must survive the sanitizer question before it is a no-op.
  // The clean corpus uses damage-refused for every guard refusal.
  if (r.corpus === "clean") return r.guard ? "damage-refused" : (r.out === r.in ? "noop" : "bad-apply");
  if (r.correct) return r.guard ? "correct-fix-refused" : "applied";
  return r.guard ? "damage-refused" : "wrong-applied";
}

function pad(s, n) { return String(s).padEnd(n); }
function padl(s, n) { return String(s).padStart(n); }

async function analyse(rows) {
  const byCorpus = new Map();
  for (const c of CORPORA) byCorpus.set(c, rows.filter((r) => r.corpus === c));

  console.log("\n" + "=".repeat(96));
  console.log("CORPUS SUMMARY");
  console.log("=".repeat(96));
  console.log(pad("corpus", 10) + padl("n", 6) + padl("model-correct", 15) + padl("APPLIED", 9) +
              padl("refused-correct", 17) + padl("damage-refused", 16) + padl("leaked", 8));
  console.log("-".repeat(96));
  for (const c of CORPORA) {
    const rs = byCorpus.get(c);
    if (!rs.length) continue;
    const k = (x) => rs.filter((r) => classify(r) === x).length;
    const correct = c === "clean" ? k("noop") : rs.filter((r) => r.correct).length;
    const leaked = c === "clean" ? k("bad-apply") : k("wrong-applied");
    console.log(pad(c, 10) + padl(rs.length, 6) + padl(correct, 15) + padl(k("applied"), 9) +
                padl(k("correct-fix-refused"), 17) + padl(k("damage-refused"), 16) + padl(leaked, 8));
  }

  // --- the table: guard reason x corpus x {correct-fix-refused, damage-refused}
  console.log("\n" + "=".repeat(96));
  console.log("GUARD x CORPUS   (cost = correct fix refused | value = damage refused)");
  console.log("=".repeat(96));
  const guards = new Set();
  for (const r of rows) if (r.guard) guards.add(family(r.guard));
  const cols = CORPORA.filter((c) => byCorpus.get(c).length);
  const cell = (g, c, kind) => byCorpus.get(c).filter((r) => family(r.guard) === g && classify(r) === kind).length;

  console.log(pad("guard", 26) + cols.map((c) => padl(c, 12)).join("") + padl("COST", 8) + padl("VALUE", 8));
  console.log("-".repeat(96));
  const ranked = [...guards].sort((a, b) =>
    cols.reduce((n, c) => n + cell(b, c, "correct-fix-refused"), 0) -
    cols.reduce((n, c) => n + cell(a, c, "correct-fix-refused"), 0));
  for (const g of ranked) {
    let cost = 0, value = 0;
    const cells = cols.map((c) => {
      const a = cell(g, c, "correct-fix-refused"), b = cell(g, c, "damage-refused");
      cost += a; value += b;
      return padl(a || b ? `${a}|${b}` : "·", 12);
    });
    console.log(pad(g, 26) + cells.join("") + padl(cost, 8) + padl(value, 8));
  }

  // --- the FULL reason chain, not just the first reason.
  //
  // guardSentenceResult returns the first refusal, and the order is arbitrary
  // with respect to how bad each one is: `DOes` hid a resegmentation behind
  // protected-token, and any amount of work on the substitution rule would
  // have shown nothing. A refusal is only recoverable if NOTHING remains, and
  // guardSentenceReport answers that directly: evidence mode runs the SHIPPING
  // chain with every guard asked, so `reasons` is the first reason plus
  // everything a removal would have uncovered. It cannot drift out from under
  // this tool the way the old source-patching did, because it is not a copy.
  for (const r of rows) {
    r.reasons = r.out === null
      ? (r.guard ? [r.guard] : [])
      : guardSentenceReport(r.in, r.out, sanitizeSentenceOutput(r.in, r.out)).reasons;
  }
  // The stored `guard` is the verdict AT COLLECTION TIME; the reasons above
  // are the current chain's, including its sanitizer question. Disagreement
  // means either the chain moved or collection used an older measurement path;
  // counterfactuals based on those stored verdicts are then confounded.
  const drifted = rows.filter((r) => r.out !== null &&
    (r.guard || null) !== (r.reasons[0] ?? null));
  if (drifted.length) {
    console.log(`\nWARNING: ${drifted.length} rows' recorded verdict disagrees with the ` +
                `current guards/question — code or measurement path changed since collection. ` +
                `Re-run without --from for clean numbers.`);
  }

  console.log("\n" + "=".repeat(96));
  console.log("HOW MANY GUARDS FIRE PER REFUSAL  (a refusal behind two guards is not one relaxation away)");
  console.log("=".repeat(96));
  const depth = new Map();
  for (const r of rows) {
    if (!r.guard || r.guard === "no-output") continue;
    const k = `${classify(r)} x${r.reasons.length}`;
    depth.set(k, (depth.get(k) || 0) + 1);
  }
  for (const [k, v] of [...depth].sort()) console.log(`  ${padl(v, 5)}  ${k}`);
  console.log("\nSecond-and-later reasons behind a refused CORRECT fix:");
  for (const r of rows.filter((x) => classify(x) === "correct-fix-refused" && x.reasons.length > 1)) {
    console.log(`  ${r.reasons.join("  THEN  ")}\n      ${JSON.stringify(r.in)}\n   -> ${JSON.stringify(r.out)}`);
  }

  // --- examples of every correct fix that a guard refused
  console.log("\n" + "=".repeat(96));
  console.log("EVERY CORRECT FIX A GUARD REFUSED");
  console.log("=".repeat(96));
  const refusedCorrect = rows.filter((r) => classify(r) === "correct-fix-refused");
  const byGuard = new Map();
  for (const r of refusedCorrect) {
    const g = family(r.guard);
    if (!byGuard.has(g)) byGuard.set(g, []);
    byGuard.get(g).push(r);
  }
  for (const [g, rs] of [...byGuard].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n--- ${g}  (${rs.length})`);
    const seen = new Set();
    for (const r of rs) {
      const key = r.in + "→" + r.out;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = rs.filter((x) => x.in + "→" + x.out === key).length;
      console.log(`  [${r.corpus}${n > 1 ? ` x${n}` : ""}] ${r.guard}\n      ${JSON.stringify(r.in)}\n   -> ${JSON.stringify(r.out)}`);
    }
  }

  // --- what got through on an ERROR sentence without matching the expected fix
  console.log("\n" + "=".repeat(96));
  console.log("APPLIED ON AN ERROR SENTENCE BUT NOT THE EXPECTED STRING");
  console.log("(each is either an acceptable variant or a real bad apply — read them)");
  console.log("=".repeat(96));
  const seenW = new Set();
  for (const r of rows.filter((x) => classify(x) === "wrong-applied")) {
    const key = r.in + "→" + r.out;
    if (seenW.has(key)) continue;
    seenW.add(key);
    console.log(`  [${r.corpus}] ${JSON.stringify(r.in)}\n   -> ${JSON.stringify(r.out)}\n   want ${JSON.stringify(r.expected[0])}`);
  }

  // --- what a full removal of each guard would cost and buy
  console.log("\n" + "=".repeat(96));
  console.log("REMOVAL SIMULATION — every refusal re-judged with ONE guard family removed");
  console.log("(recovered = correct fixes that now apply; newly-admitted = wrong/clean-sentence");
  console.log(" edits that now apply. Upper bound: a targeted relaxation costs less of both.");
  console.log(" Read off guardSentenceReport: a refusal survives the removal iff any reason");
  console.log(" from ANOTHER family fired anywhere in the chain.)");
  console.log("=".repeat(96));
  console.log(pad("guard removed", 26) + padl("recovered", 11) + padl("newBad(clean)", 15) +
              padl("newWrong(err)", 15) + padl("newLeak(mustRefuse)", 21));
  console.log("-".repeat(96));
  const sims = [];
  for (const g of ranked) {
    if (g === "no-output") continue;
    let recovered = 0, newBadClean = 0, newWrongErr = 0, newLeak = 0;
    const rec = [], adm = [];
    for (const r of rows) {
      if (!r.guard || r.guard === "no-output" || r.out === null) continue;
      const fams = new Set(r.reasons.map(family));
      if (!fams.has(g)) continue;                            // not this guard's refusal
      if (fams.size > 1) continue;                           // still refused by another
      const c = classify(r);
      if (c === "correct-fix-refused") { recovered++; rec.push(r); }
      else if (r.corpus === "clean") { newBadClean++; adm.push(r); }
      else if (DAMAGE_CORPORA.has(r.corpus)) { newLeak++; adm.push(r); }
      else { newWrongErr++; adm.push(r); }
    }
    sims.push({ guard: g, recovered, newBadClean, newWrongErr, newLeak, rec, adm });
    console.log(pad(g, 26) + padl(recovered, 11) + padl(newBadClean, 15) + padl(newWrongErr, 15) + padl(newLeak, 21));
  }

  for (const s of sims.filter((x) => x.recovered)) {
    console.log(`\n### remove ${s.guard}: newly admitted (${s.adm.length})`);
    const seen = new Set();
    for (const r of s.adm) {
      const key = r.in + "→" + r.out;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  [${r.corpus}] was ${r.guard}\n      ${JSON.stringify(r.in)}\n   -> ${JSON.stringify(r.out)}`);
    }
  }

  // --- threshold sweeps, which are the relaxations that can actually be dialled
  console.log("\n" + "=".repeat(96));
  console.log("THRESHOLD SWEEPS (guardSentenceResult opts — the dials that exist)");
  console.log("=".repeat(96));
  const sweep = (label, opts) => {
    let recovered = 0, newBadClean = 0, newWrongErr = 0, newLeak = 0;
    for (const r of rows) {
      if (!r.guard || r.guard === "no-output" || r.out === null) continue;
      if (guardSentenceResult(r.in, r.out, sanitizeSentenceOutput(r.in, r.out), opts) !== null) continue;
      const c = classify(r);
      if (c === "correct-fix-refused") recovered++;
      else if (r.corpus === "clean") newBadClean++;
      else if (DAMAGE_CORPORA.has(r.corpus)) newLeak++;
      else newWrongErr++;
    }
    console.log(pad(label, 26) + padl(recovered, 11) + padl(newBadClean, 15) + padl(newWrongErr, 15) + padl(newLeak, 21));
  };
  console.log(pad("relaxation", 26) + padl("recovered", 11) + padl("newBad(clean)", 15) +
              padl("newWrong(err)", 15) + padl("newLeak(mustRefuse)", 21));
  console.log("-".repeat(96));
  for (const v of [0.55, 0.5, 0.45, 0.4]) sweep(`minOverlap ${v}`, { minOverlap: v });
  for (const v of [12, 14, 16]) sweep(`maxChangedWords ${v}`, { maxChangedWords: v });
  for (const v of [8, 10, 12]) sweep(`lenFloorChars ${v}`, { lenFloorChars: v });
  sweep("length band 0.5–2.0", { minLenRatio: 0.5, maxLenRatio: 2.0 });

  // --- targeted relaxations, measured rather than argued
  console.log("\n" + "=".repeat(96));
  console.log("TARGETED RELAXATIONS (one-line source patches to background.js, evaluated in a vm)");
  console.log("=".repeat(96));
  for (const v of VARIANTS) {
    const src = v.patch(BG_SRC);
    if (src === BG_SRC) {
      throw new Error(`variant patch did not apply — background.js moved out from under it: ${v.label}`);
    }
    const api = await loadSentenceGuards({ source: src });
    const g2 = api.guardSentenceResult;
    v.api = api;
    let recovered = 0, newBadClean = 0, newWrongErr = 0, newLeak = 0;
    const rec = [], adm = [];
    for (const r of rows) {
      if (r.out === null) continue;
      const before = r.guard, after = g2(r.in, r.out, api.sanitizeSentenceOutput(r.in, r.out));
      if (before === after) continue;
      if (after !== null) continue;       // still refused, by a different guard
      const c = classify(r);
      if (c === "correct-fix-refused") { recovered++; rec.push(r); }
      else if (r.corpus === "clean") { newBadClean++; adm.push(r); }
      else if (DAMAGE_CORPORA.has(r.corpus)) { newLeak++; adm.push(r); }
      else { newWrongErr++; adm.push(r); }
    }
    console.log(`\n--- ${v.label}`);
    console.log(`    ${v.note}`);
    console.log(`    recovered ${recovered}   newBad(clean) ${newBadClean}   newWrong(err) ${newWrongErr}   newLeak(damage) ${newLeak}`);
    const show = (title, list) => {
      if (!list.length) return;
      console.log(`    ${title}:`);
      const seen = new Set();
      for (const r of list) {
        const k = r.in + "→" + r.out;
        if (seen.has(k)) continue;
        seen.add(k);
        const n = list.filter((x) => x.in + "→" + x.out === k).length;
        console.log(`      [${r.corpus}${n > 1 ? ` x${n}` : ""}] was ${r.guard}\n         ${JSON.stringify(r.in)}\n      -> ${JSON.stringify(r.out)}`);
      }
    };
    show("recovered", rec);
    show("newly admitted", adm);
  }

  // --- guard cost with the model taken out of the argument.
  //
  // At 3 and 4 typos the model is right less than half the time, so a live
  // measurement understates what the guards would refuse if the model improved.
  // Feed every corpus its OWN expected answer and ask the guards directly.
  console.log("\n" + "=".repeat(96));
  console.log("PERFECT-MODEL UPPER BOUND — the expected fix, handed straight to the guards");
  console.log("=".repeat(96));
  const perfect = [
    ["errors", ERRORS.map((e) => [e.in, e.expected])],
    ["recall", RECALL_SHOULD],
    ...[2, 3, 4].map((t) => [`multi${t}`, MULTI_TYPO.filter((c) => c.typos === t).map((c) => [c.in, c.expected])]),
  ];
  // "Still refused under every variant" used to be a COMBINED patch of the
  // proposed relaxations; the shipped ones are gone from VARIANTS, so this is
  // now the one remaining proposal (prefix insertion), whose chain the loop
  // above already built and verified.
  const relaxed = VARIANTS[0].api;
  for (const [name, pairs] of perfect) {
    const refused = pairs.filter(([a, b]) => guardSentenceResult(a, b, sanitizeSentenceOutput(a, b)));
    const stillRefused = refused.filter(([a, b]) => relaxed.guardSentenceResult(a, b, relaxed.sanitizeSentenceOutput(a, b)));
    const tally = new Map();
    for (const [a, b] of refused) {
      const g = family(guardSentenceResult(a, b, sanitizeSentenceOutput(a, b)));
      tally.set(g, (tally.get(g) || 0) + 1);
    }
    console.log(`  ${pad(name, 8)} ${refused.length}/${pairs.length} refused  ` +
                `[${[...tally].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}]  ` +
                `-> ${stillRefused.length} still refused under prefix-insertion`);
  }

  // --- which word pairs recur? A CONFUSABLE entry is only earned by a pair
  // that shows up in more than one real refusal; a one-off is a corpus
  // accident and buying it costs a documented real-word substitution.
  console.log("\n" + "=".repeat(96));
  console.log("word-substituted: WHICH PAIR, AND HOW OFTEN  (a CONFUSABLE entry needs recurrence)");
  console.log("=".repeat(96));
  const pairs = new Map();
  for (const r of rows) {
    if (!r.guard || !r.guard.startsWith("word-substituted:")) continue;
    const w = r.guard.slice("word-substituted:".length);
    const k = `${w} | ${classify(r)} | ${r.corpus}`;
    if (!pairs.has(k)) pairs.set(k, { n: 0, ex: r });
    pairs.get(k).n++;
  }
  for (const [k, v] of [...pairs].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${padl(v.n, 4)}  ${k}`);
  }

  // --- headroom, per 100 error sentences
  console.log("\n" + "=".repeat(96));
  // `target-too-short` is a harness artifact on the clean corpus: production
  // never sends a sentence below MIN_SENTENCE_CHARS, so those refusals are not
  // headroom in either direction. Called out rather than quietly dropped.
  const tooShort = rows.filter((r) => r.guard === "target-too-short").length;
  console.log(`Harness artifact: ${tooShort} target-too-short refusals — production filters ` +
              `those before Ollama is called, so they are neither cost nor value.`);
  const errRows = rows.filter((r) => !["clean", "mustrefuse", "hazard"].includes(r.corpus));
  const nErr = errRows.length;
  const refusedN = errRows.filter((r) => classify(r) === "correct-fix-refused").length;
  const wrongRefusedN = errRows.filter((r) => classify(r) === "damage-refused").length;
  console.log(`Error-sentence refusals split: ${refusedN} correct-fix-refused, ` +
              `${wrongRefusedN} wrong-change-refused (the retry population).`);
  const byWrong = new Map();
  for (const r of errRows) {
    if (classify(r) !== "damage-refused") continue;
    byWrong.set(family(r.guard), (byWrong.get(family(r.guard)) || 0) + 1);
  }
  console.log("wrong-change-refused, per guard:");
  for (const [k, v] of [...byWrong].sort((a, b) => b[1] - a[1])) console.log(`  ${padl(v, 4)}  ${k}`);
  const cleanN = rows.filter((r) => r.corpus === "clean").length;
  const badN = rows.filter((r) => classify(r) === "bad-apply").length;
  console.log(`Total error-corpus trials: ${nErr}; correct fixes refused: ${refusedN} ` +
              `(${((refusedN / nErr) * 100).toFixed(1)} per 100 error sentences)`);
  console.log(`Clean trials: ${cleanN}; current bad applies: ${badN} (${((badN / cleanN) * 100).toFixed(2)}%)`);
  console.log(`\nRaw data: ${fromFile || RAW}`);
}

if (!fromFile) await collect();
await analyse(load(fromFile || RAW));
