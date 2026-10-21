#!/usr/bin/env node
// Does letting the model edit a WINDOW of sentences beat one sentence at a time?
//
// Today sentence mode sends ONE finished sentence in the user turn, with the
// preceding text supplied as read-only `prior_context`. The proposal is a
// SLIDING, OVERLAPPING window: when sentence n is finished, send sentences
// n-K+1 .. n as editable text. Every sentence is then visited K times -- once as
// the newest, K-1 more times as an older member of a later window.
//
// The comparison has to be a SIMULATION, not a per-sentence request, for two
// reasons:
//
//   1. The window's earlier members are the ALREADY-CORRECTED text, not what
//      the user typed. Feeding the raw corpus sentence would measure a system
//      nobody would ship.
//   2. The whole claimed benefit is a second bite -- a sentence the first pass
//      missed getting fixed when a later window revisits it. That is invisible
//      to any harness that scores one request in isolation.
//
// So: reconstruct each multi-sentence message, type it one sentence at a time,
// apply what the guards allow, and score the FINAL text against the owner
// rubric (sentence-owner-bench.mjs's classifyEdit / labels). K=1 is the
// shipping path and is measured in the same loop as its own control.
//
// Only messages with >= 2 sentences are simulated. A single-sentence message is
// byte-identical under every K by construction, so including them would add the
// same rows to every column and dilute every rate.
//
// Usage:
//   node sentence-window-test.mjs --corpus error-holdout.json --k 1 --tag k1
//   node sentence-window-test.mjs --corpus error-holdout.json --k 3 --adapt --tag k3a
//   node sentence-window-test.mjs --corpus error-holdout.json --replay f.jsonl
//
// Flags:
//   --corpus <f>   corpus v2 JSON, resolved against $PROOFER_CORPUS_DIR
//   --labels <f>   defaults to labels-<corpus name>.json
//   --k <n>        window size in sentences (1 = the shipping path)
//   --adapt        rewrite the one system-prompt line that says "sentence"
//   --guard win    guard the whole window as one unit (default: per-sentence)
//   --tag <name>   writes <dir>/window-<corpus>-<tag>.jsonl
//   --numctx <n> / --numpredict <n>   override the pinned sentence-path values
//   --conc <n>     concurrent MESSAGES (default 4). Steps within a message are
//                  serial by construction -- the state is the whole point.
//   --limit <n>    first n messages
//   --review       print every landed edit and every refusal
//   --json <f>     dump the score object

import { readFileSync, writeFileSync, chmodSync, existsSync } from "fs";
import { prepareSentenceRequest, guardSentenceResult } from "./lib/sentence-guards.mjs";
import { segmentSentences } from "./lib/content-sandbox.mjs";
import { classifyEdit, compileLabels, collateralOf } from "./sentence-owner-bench.mjs";
import { injure, lcg } from "./lib/multi-typo-corpus.mjs";

const SENTENCE_CONTEXT_CHARS = 2500;
const PAGE = { hostname: "discord.com" };

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

const DIR = process.env.PROOFER_CORPUS_DIR || new URL("./harvested/", import.meta.url).pathname;
const resolve = (f) => (f.includes("/") ? f : DIR.replace(/\/?$/, "/") + f);

// ------------------------------------------------------------------ messages
//
// The corpus stores one row per sentence with `start`/`end` offsets into its
// message and a `context` that ends exactly at `start`. Every message in all
// three corpora tiles contiguously, so the sentences ARE the message and only
// the separator between each pair -- " " or "\n" -- has to be recovered.
//
// Recovered per PAIR, from the following row's context tail, never by slicing
// the last row's context back to offset 0. `context` is capped at 2500
// characters, so on a long message that slice runs off the front and the
// reconstruction silently fails -- which drops precisely the messages this
// suite exists to measure. The first cut of this function lost the 24-, 18-,
// 17- and 15-sentence messages and kept every two-sentence one.
export function buildMessages(corpus, { minSentences = 2 } = {}) {
  const by = new Map();
  for (const it of corpus.items) {
    if (!by.has(it.message_id)) by.set(it.message_id, []);
    by.get(it.message_id).push(it);
  }
  const out = [];
  const skipped = [];
  for (const [message_id, rows] of by) {
    if (rows.length < minSentences) continue;
    rows.sort((a, b) => a.start - b.start);
    if (rows[0].start !== 0) { skipped.push([message_id, "no-head"]); continue; }
    const seps = [];
    let bad = null;
    for (let i = 1; i < rows.length; i++) {
      // NOT `start - (prevStart + prevLength)`. The stored `sentence` is
      // trimmed while `start` still points at the segment, which includes its
      // leading whitespace -- on a message written with blank lines between
      // paragraphs the arithmetic is off by one per blank line and every
      // separator after the first comes out wrong.
      //
      // The context ends exactly where this sentence begins, so the previous
      // sentence's last occurrence in it fixes the boundary directly.
      const ctx = rows[i].context;
      const prev = rows[i - 1].sentence;
      const at = ctx.lastIndexOf(prev);
      if (at === -1) { bad = "not-contiguous"; break; }
      const sep = ctx.slice(at + prev.length);
      // Anything other than whitespace between two rows means the corpus did
      // not keep every sentence of this message, so the window would contain
      // text with no label and no place in the alignment.
      if (!/^\s*$/.test(sep)) { bad = "text-between"; break; }
      seps.push(sep);
    }
    if (bad) { skipped.push([message_id, bad]); continue; }
    out.push({
      message_id,
      items: rows,
      seps,
      // Everything before this message: prior channel history, identical for
      // every sentence in it. rows[0].start is 0, so this is its whole context.
      external: rows[0].context,
    });
  }
  if (skipped.length && process.env.PROOFER_VERBOSE) console.error("skipped messages:", skipped);
  return { messages: out, skipped };
}

const joinRange = (parts, seps, lo) =>
  parts.reduce((acc, p, k) => (k === 0 ? p : acc + seps[lo + k - 1] + p), "");

// ------------------------------------------------------------------ injection
//
// 58 hand-labelled errors across 718 real sentences cannot resolve a one- or
// two-case difference, and one or two cases is the size of effect a window is
// likely to have. So: damage ONE word of ONE sentence per message with the
// generator sentence-multi-typo-test.mjs already uses, which makes the expected
// output the word that was there before -- no judgement call, 241 error cases
// instead of 58, and the POSITION of the error under our control.
//
// Position is the whole point. "Does a later sentence get corrected better when
// its predecessors are in the window" and "does an early sentence get a second
// bite when the next one arrives" are different questions, and the real corpus
// answers neither on its own because it cannot say where the errors are.
// The same word list the guards use, so "is there anything else in this
// sentence a proofreader would touch" is answered by the shipping data rather
// than by eye.
const DICT = new Set(
  readFileSync(new URL("../data/words-en.txt", import.meta.url), "utf8").split("\n").filter(Boolean));

export function dictionaryClean(sentence) {
  return String(sentence).split(/\s+/).every((t) => {
    const w = t.replace(/[^A-Za-z'’]/g, "").replace(/['’]/g, "");
    return !(w.length >= 4 && /^[a-z]+$/.test(w)) || DICT.has(w);
  });
}

export function injectMessages(msgs, mode, seed = 20260812) {
  const rand = lcg(seed);
  const out = [];
  for (const msg of msgs) {
    const n = msg.items.length;
    const idx = mode === "first" ? 0
      : mode === "last" ? n - 1
      : Math.floor(rand() * n);
    // The target must have nothing else wrong with it, or a model that
    // correctly fixes a typo the corpus already contained is scored as
    // collateral damage -- measured, and it was the top two "damage" rows on
    // the first injected run. 26% of real sentences carry something the word
    // list does not recognise, which is a fair price for a clean control.
    if (!dictionaryClean(msg.items[idx].sentence)) continue;
    const clean = msg.items[idx].sentence;
    const { text, applied } = injure(clean, 1, rand);
    if (applied !== 1 || text === clean) continue;   // nothing damageable in it
    const bw = clean.split(/\s+/), aw = text.split(/\s+/);
    const k = bw.findIndex((w, i) => w !== aw[i]);
    if (k === -1) continue;
    const strip = (w) => w.replace(/^[^A-Za-z'’]+|[^A-Za-z'’]+$/g, "");
    const origWord = strip(bw[k]), badWord = strip(aw[k]);
    if (!origWord || !badWord || origWord === badWord) continue;
    out.push({
      ...msg,
      items: msg.items.map((it, i) => (i === idx ? { ...it, sentence: text } : it)),
      injury: { idx, uid: msg.items[idx].uid, clean, injured: text, origWord, badWord },
    });
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Labels for an injected corpus: the damaged sentence is the one ERROR. */
export function injectionLabels(msgs) {
  const labels = new Map();
  for (const m of msgs) {
    const { uid, origWord, badWord } = m.injury;
    labels.set(uid, {
      cls: "ERROR",
      // Lookarounds, not capture groups: collateralOf rebuilds the expected
      // sentence with `src.replace(L.err, L.fixLiteral)`, and a group would be
      // eaten by that replacement along with the character either side of it.
      err: new RegExp(`(?<![A-Za-z])${esc(badWord)}(?![A-Za-z])`),
      fix: new RegExp(`(?<![A-Za-z])${esc(origWord)}(?![A-Za-z])`),
      fixLiteral: origWord,
      also: [],
    });
  }
  return labels;
}

// --------------------------------------------------------------- alignment
//
// Map the model's window output back onto the K sentences that went in, so the
// per-sentence state -- and therefore every label -- survives the round trip.
//
// SPLITS are allowed (splitting a run-on is a real correction the guards
// already permit, one per window). MERGES are not: two sentences collapsed into
// one has no representation in a per-sentence state, `sentenceBoundaryDelta`
// refuses it on the window path anyway, and silently attributing the merged
// text to both positions would score one edit twice.
const letters = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

function dice(a, b) {
  const A = letters(a), B = letters(b);
  if (!A.length && !B.length) return 1;
  const m = new Map();
  for (const w of A) m.set(w, (m.get(w) || 0) + 1);
  let hit = 0;
  for (const w of B) if (m.get(w)) { m.set(w, m.get(w) - 1); hit++; }
  return (2 * hit) / (A.length + B.length || 1);
}

export function alignWindow(before, outText) {
  const segs = segmentSentences(outText, { minChars: 1, mergeTrailingRunt: false })
    .map((s) => s.text).filter((s) => s.trim());
  const K = before.length;
  if (!segs.length) return { ok: false, why: "empty-output" };
  if (segs.length < K) return { ok: false, why: "merged-output" };
  if (segs.length === K) return { ok: true, parts: segs.map((s) => s.trim()), splits: 0 };
  // Brute force every monotone composition of the output segments into K
  // non-empty runs. K <= 4 and the guards cap added boundaries at 1, so this is
  // a handful of candidates.
  let best = null;
  const walk = (i, j, acc) => {
    if (i === K) { if (j === segs.length) consider(acc); return; }
    const remaining = K - i - 1;
    for (let take = 1; j + take + remaining <= segs.length; take++) {
      walk(i + 1, j + take, [...acc, segs.slice(j, j + take).join("")]);
    }
  };
  const consider = (parts) => {
    const s = parts.reduce((n, p, k) => n + dice(before[k], p), 0);
    if (!best || s > best.score) best = { score: s, parts };
  };
  walk(0, 0, []);
  if (!best) return { ok: false, why: "no-alignment" };
  return { ok: true, parts: best.parts.map((p) => p.trim()), splits: segs.length - K };
}

// ------------------------------------------------------------------- request
const MODEL = process.env.PROOFER_MODEL || "qwen3.5:9b";
const OLLAMA = (process.env.PROOFER_OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const OPTS = process.env.PROOFER_OPTIONS ? JSON.parse(process.env.PROOFER_OPTIONS) : {};

// The one line in the sentence-path system prompt that names the unit. Leaving
// "the sentence" in place while sending four of them would make any K>1 loss
// unreadable -- is it the window, or is it an instruction that no longer
// describes the input? `--adapt` changes exactly this and nothing else.
const ASIS = "Correct ONLY the sentence the user sends.";
const ADAPTED = "Correct ONLY the text the user sends.";

async function ask(windowText, priorContext, cond) {
  const req = prepareSentenceRequest(windowText, priorContext, PAGE, { ollamaModel: MODEL });
  // As of 2026-08-12 the adapted wording SHIPS, so `--adapt` is a no-op kept so
  // the recorded commands still mean what they meant. `--legacy-prompt` patches
  // the other way, which is how the before/after is still reproducible.
  if (cond.legacy) {
    const sys = req.body.messages[0];
    if (!sys.content.includes(ADAPTED)) throw new Error("--legacy-prompt: the shipping prompt no longer contains the line it reverts");
    sys.content = sys.content.replace(ADAPTED, ASIS);
  } else if (cond.adapt) {
    const sys = req.body.messages[0];
    if (sys.content.includes(ASIS)) sys.content = sys.content.replace(ASIS, ADAPTED);
    else if (!sys.content.includes(ADAPTED)) throw new Error("--adapt: the system prompt contains neither wording");
  }
  Object.assign(req.body.options, OPTS);
  if (cond.numCtx) req.body.options.num_ctx = cond.numCtx;
  if (cond.numPredict) req.body.options.num_predict = cond.numPredict;
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
  return { out, error, ms, promptTokens: data?.prompt_eval_count ?? null };
}

// ---------------------------------------------------------------- simulation
async function simulateMessage(msg, cond) {
  const state = msg.items.map((it) => it.sentence);
  const steps = [];
  for (let i = 0; i < state.length; i++) {
    const lo = Math.max(0, i - cond.k + 1);
    const before = state.slice(lo, i + 1);
    const windowText = joinRange(before, msg.seps, lo);
    // Everything before the window, with the corrections that have already
    // landed -- which is what the field actually contains at this moment.
    const settled = lo === 0 ? "" : joinRange(state.slice(0, lo), msg.seps, 0) + msg.seps[lo - 1];
    const priorContext = (msg.external + settled).slice(-SENTENCE_CONTEXT_CHARS);

    const step = { i, lo, windowText, priorContext: priorContext.length };
    const { out, error, ms, promptTokens } = await ask(windowText, priorContext, cond);
    step.ms = ms; step.promptTokens = promptTokens; step.output = out; step.error = error;

    if (error) { step.outcome = "error"; steps.push(step); continue; }
    if (out.trim() === windowText.trim()) { step.outcome = "no-op"; steps.push(step); continue; }

    if (cond.guard === "win") {
      // One verdict for the whole window. maxTargetChars is scaled with K --
      // it is a per-sentence length sanity check, and leaving it at 500 would
      // refuse most 3- and 4-sentence windows on length alone, which measures
      // a constant rather than the idea.
      const verdict = guardSentenceResult(windowText, out, out, { maxTargetChars: 500 * cond.k });
      step.verdict = verdict;
      if (verdict) { step.outcome = "refused"; steps.push(step); continue; }
    }

    const al = alignWindow(before, out);
    if (!al.ok) { step.outcome = "refused"; step.verdict = step.verdict || al.why; steps.push(step); continue; }
    step.splits = al.splits;

    const applied = [];
    for (let k = 0; k < before.length; k++) {
      const b = before[k].trim(), a = al.parts[k];
      if (a === b) continue;
      // `--apply newest` keeps the window as material the model may READ and
      // rewrite, and throws away everything it does to a sentence the user has
      // already finished. That separates the two things a window does at once:
      // giving the model a fuller neighbourhood to correct the newest sentence
      // in, and giving it licence to revise settled text.
      if (cond.apply === "newest" && lo + k !== i) { (step.discarded ||= []).push({ idx: lo + k, before: b, after: a }); continue; }
      if (cond.guard !== "win") {
        const v = guardSentenceResult(b, a, a);
        if (v) { (step.perRefused ||= []).push({ idx: lo + k, verdict: v }); continue; }
      }
      state[lo + k] = a;
      applied.push({ idx: lo + k, newest: lo + k === i, before: b, after: a });
    }
    step.applied = applied;
    step.outcome = applied.length ? "applied" : (step.perRefused ? "refused" : "no-op");
    steps.push(step);
  }
  return { message_id: msg.message_id, final: state, steps };
}

// -------------------------------------------------------------------- score
export function scoreRuns(runs, msgs, labels) {
  const byId = new Map(msgs.map((m) => [m.message_id, m]));
  const R = {
    messages: runs.length, sentences: 0, errors: 0, clean: 0,
    fixedSafe: 0, fixedWithCollateral: 0, fixedCollateralUnknown: 0, errNoOp: 0, wrongOutput: 0,
    meaningDamage: 0, welcomeStyle: 0, grammar: 0,
    damageWhy: {}, styleWhy: {}, grammarWhy: {}, refusals: {},
    damage: [], fixes: [], missed: [],
    // The window's own accounting.
    requests: 0, applyEvents: 0, editsOnNewest: 0, editsOnOlder: 0,
    revisionFix: 0, revisionStyle: 0, revisionMeaning: 0, revisions: [],
    discarded: 0, discardedFix: 0, discardedMeaning: 0,
    reEdited: 0, splits: 0, stepErrors: 0, stepRefused: 0, stepNoOp: 0, stepApplied: 0,
    lat: [], promptTokens: [],
  };
  for (const run of runs) {
    const msg = byId.get(run.message_id);
    if (!msg) continue;
    // Every landed edit, in order, so a sentence rewritten twice is visible.
    const touchCount = new Map();
    for (const s of run.steps) {
      R.requests++;
      if (typeof s.ms === "number") R.lat.push(s.ms);
      if (typeof s.promptTokens === "number") R.promptTokens.push(s.promptTokens);
      if (s.outcome === "error") R.stepErrors++;
      else if (s.outcome === "refused") R.stepRefused++;
      else if (s.outcome === "no-op") R.stepNoOp++;
      else R.stepApplied++;
      if (s.verdict) R.refusals[s.verdict] = (R.refusals[s.verdict] || 0) + 1;
      for (const p of s.perRefused || []) R.refusals[p.verdict] = (R.refusals[p.verdict] || 0) + 1;
      R.splits += s.splits || 0;
      // What `--apply newest` threw away, scored the same way, so the arm can
      // be read as "and this is what it cost to refuse the churn".
      for (const d of s.discarded || []) {
        R.discarded++;
        const L = labels.get(msg.items[d.idx].uid);
        if (L && L.cls === "ERROR" && !L.fix.test(d.before) && L.fix.test(d.after)) R.discardedFix++;
        else if (classifyEdit(d.before, d.after).kind === "meaning") R.discardedMeaning++;
      }
      for (const a of s.applied || []) {
        R.applyEvents++;
        touchCount.set(a.idx, (touchCount.get(a.idx) || 0) + 1);
        if (a.newest) { R.editsOnNewest++; continue; }
        // A revision: an edit to a sentence the user has already finished,
        // already seen flash, and moved past. The whole cost of the window.
        R.editsOnOlder++;
        const L = labels.get(msg.items[a.idx].uid);
        const orig = msg.items[a.idx].sentence.trim();
        const kind = classifyEdit(a.before, a.after).kind;
        if (L && L.cls === "ERROR" && !L.fix.test(a.before) && L.fix.test(a.after)) R.revisionFix++;
        else if (kind === "meaning") R.revisionMeaning++;
        else R.revisionStyle++;
        R.revisions.push({ uid: msg.items[a.idx].uid, kind, orig, before: a.before, after: a.after });
      }
    }
    for (const [, n] of touchCount) if (n > 1) R.reEdited++;

    for (let k = 0; k < msg.items.length; k++) {
      const it = msg.items[k];
      const src = it.sentence.trim();
      const fin = String(run.final[k]).trim();
      const L = labels.get(it.uid);
      R.sentences++;
      if (L && L.cls === "ERROR") {
        R.errors++;
        const fixed = L.fix.test(fin);
        const untouched = L.err.test(fin);
        if (fixed) {
          const col = collateralOf(src, fin, L);
          if (!col.known) R.fixedCollateralUnknown++;
          else if (col.kind === "meaning") {
            R.fixedWithCollateral++;
            R.damage.push({ uid: it.uid, why: `collateral:${col.why}`, sentence: src, output: fin });
          } else R.fixedSafe++;
          R.fixes.push({ uid: it.uid, src, fin });
        } else if (untouched) { R.errNoOp++; R.missed.push({ uid: it.uid, src, fin }); }
        else {
          R.wrongOutput++;
          if (fin !== src) R.damage.push({ uid: it.uid, why: "wrong-fix-applied", sentence: src, output: fin });
          R.missed.push({ uid: it.uid, src, fin });
        }
        continue;
      }
      R.clean++;
      if (fin === src) continue;
      const c = classifyEdit(src, fin);
      if (c.kind === "style") { R.welcomeStyle++; R.styleWhy[c.why] = (R.styleWhy[c.why] || 0) + 1; }
      else if (c.kind === "grammar") { R.grammar++; R.grammarWhy[c.why] = (R.grammarWhy[c.why] || 0) + 1; }
      else {
        R.meaningDamage++; R.damageWhy[c.why] = (R.damageWhy[c.why] || 0) + 1;
        R.damage.push({ uid: it.uid, why: c.why, sentence: src, output: fin });
      }
    }
  }
  R.damageUids = R.damage.map((d) => d.uid).sort();
  R.damagePer100 = R.sentences ? +(100 * R.damage.length / R.sentences).toFixed(2) : null;
  R.lat.sort((a, b) => a - b);
  R.medianMs = R.lat.length ? R.lat[Math.floor(R.lat.length / 2)] : null;
  R.p95Ms = R.lat.length ? R.lat[Math.floor(R.lat.length * 0.95)] : null;
  R.promptTokens.sort((a, b) => a - b);
  R.medianPromptTokens = R.promptTokens.length ? R.promptTokens[Math.floor(R.promptTokens.length / 2)] : null;
  delete R.lat; delete R.promptTokens;
  return R;
}

const kv = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" ");

export function report(label, R, { review = false } = {}) {
  const pct = (x, d) => (d ? `${x} (${(100 * x / d).toFixed(1)}%)` : `${x}`);
  console.log(`\n=== ${label}   ${R.messages} messages / ${R.sentences} sentences / ${R.requests} requests`);
  console.log(`ERRORS (${R.errors})`);
  console.log(`  fixed-safe              ${pct(R.fixedSafe, R.errors)}      <- RAISE`);
  console.log(`  fixed-with-collateral   ${R.fixedWithCollateral}${R.fixedCollateralUnknown ? `   (collateral-unknown ${R.fixedCollateralUnknown})` : ""}`);
  console.log(`  never-fixed             ${R.errNoOp}   wrong-output ${R.wrongOutput}`);
  console.log(`CLEAN  (${R.clean})   meaning-damage ${R.meaningDamage} [${kv(R.damageWhy)}]   style ${R.welcomeStyle}   grammar ${R.grammar}`);
  console.log(`TOTAL DAMAGE ${R.damage.length} / ${R.sentences} = ${R.damagePer100} per 100 sentences`);
  console.log(`WINDOW  apply-events ${R.applyEvents}  on-newest ${R.editsOnNewest}  on-OLDER ${R.editsOnOlder}`
    + `  (revision: fix ${R.revisionFix} / style ${R.revisionStyle} / meaning ${R.revisionMeaning})`
    + `  re-edited-twice ${R.reEdited}  splits ${R.splits}`);
  console.log(`STEPS   applied ${R.stepApplied}  refused ${R.stepRefused}  no-op ${R.stepNoOp}  error ${R.stepErrors}`);
  console.log(`latency median ${R.medianMs}ms  p95 ${R.p95Ms}ms   prompt tokens median ${R.medianPromptTokens}`);
  for (const d of R.damage) {
    console.log(`  ! ${d.uid} (${d.why})\n      ${JSON.stringify(d.sentence)}\n   -> ${JSON.stringify(d.output)}`);
  }
  if (review) {
    console.log("refusal reasons:", kv(R.refusals));
    for (const r of R.revisions) {
      console.log(`  ~rev ${r.uid} [${r.kind}]\n      ${JSON.stringify(r.before)}\n   -> ${JSON.stringify(r.after)}`);
    }
    for (const m of R.missed) console.log(`  ?miss ${m.uid} ${JSON.stringify(m.src)} -> ${JSON.stringify(m.fin)}`);
  }
  console.log(`SUMMARY ${label}\tfixSafe=${R.fixedSafe}/${R.errors}\tDAMAGE=${R.damage.length}\tper100=${R.damagePer100}`
    + `\tstyle=${R.welcomeStyle}\tolderEdits=${R.editsOnOlder}\trevFix=${R.revisionFix}\trevMeaning=${R.revisionMeaning}`
    + `\tmedian=${R.medianMs}ms\tptok=${R.medianPromptTokens}`);
}

// ---------------------------------------------------------------------- main
async function main() {
  const corpusPath = arg("--corpus");
  if (!corpusPath) {
    console.error("usage: node sentence-window-test.mjs --corpus <f.json> --k <n> [--adapt] [--guard win] [--tag t] [--replay f]");
    process.exit(2);
  }
  const corpus = JSON.parse(readFileSync(resolve(String(corpusPath)), "utf8"));
  if (corpus.version !== 2) throw new Error(`corpus ${corpus.name} is version ${corpus.version}; expected 2`);
  const inject = arg("--inject");

  const built = buildMessages(corpus);
  if (built.skipped.length) console.error(`!! ${built.skipped.length} multi-sentence messages could not be reconstructed and are excluded`);
  let msgs = built.messages.slice(0, arg("--limit") ? Number(arg("--limit")) : Infinity);
  let labels;
  if (inject) {
    msgs = injectMessages(msgs, String(inject), Number(arg("--seed", 20260812)));
    labels = injectionLabels(msgs);
    console.error(`injected one typo per message into ${msgs.length} messages (mode=${inject})`);
  } else {
    const labelPath = arg("--labels") || `labels-${corpus.name}.json`;
    const raw = existsSync(resolve(labelPath)) ? JSON.parse(readFileSync(resolve(labelPath), "utf8")) : { labels: {} };
    labels = compileLabels(raw);
  }
  const cond = {
    k: Number(arg("--k", 1)),
    adapt: process.argv.includes("--adapt"),
    guard: arg("--guard", "per"),
    apply: arg("--apply", "all"),
    legacy: process.argv.includes("--legacy-prompt"),
    numCtx: arg("--numctx") ? Number(arg("--numctx")) : null,
    numPredict: arg("--numpredict") ? Number(arg("--numpredict")) : null,
  };
  const tag = String(arg("--tag") || `k${cond.k}${cond.adapt ? "a" : ""}${cond.guard === "win" ? "w" : ""}`);
  const label = `${corpus.name}/${tag}`;

  let runs;
  const replay = arg("--replay");
  if (replay) {
    runs = readFileSync(resolve(String(replay)), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } else {
    const CONC = Number(arg("--conc") || process.env.PROOFER_CONC || 4);
    runs = new Array(msgs.length);
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, msgs.length) }, async () => {
      while (next < msgs.length) {
        const i = next++;
        runs[i] = await simulateMessage(msgs[i], cond);
        if (++done % 25 === 0) process.stderr.write(`  ${label} ${done}/${msgs.length}\n`);
      }
    }));
    const out = resolve(`window-${corpus.name}-${tag}.jsonl`);
    // 0600, and chmod because the mode option only applies at creation: the
    // run file holds every corpus sentence and every model output.
    writeFileSync(out, runs.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    chmodSync(out, 0o600);
    console.error(`wrote ${out}`);
  }

  const R = scoreRuns(runs, msgs, labels);
  R.cond = cond;
  report(label, R, { review: process.argv.includes("--review") });
  if (arg("--json")) {
    const p = resolve(String(arg("--json")));
    writeFileSync(p, JSON.stringify(R, null, 1), { mode: 0o600 });
    chmodSync(p, 0o600);
  }
}

if (String(process.argv[1] || "").endsWith("sentence-window-test.mjs")) await main();
