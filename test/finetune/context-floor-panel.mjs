#!/usr/bin/env node
// The context-length floor: how much prior context does an ambiguous typo need?
//
//   node test/finetune/context-floor-panel.mjs --dry-run
//   node test/finetune/context-floor-panel.mjs
//   PROOFER_MODEL=qwen3.8:27b PROOFER_SKIP_DIGEST_CHECK=1 \
//     node test/finetune/context-floor-panel.mjs
//
// Plan §7 Phase 0.2. Teacher and student both see exactly one context window
// from here on, and this panel is what picks it. The selection rule is
// PREDECLARED: the shortest window whose ambiguous-typo recall is within 2
// cases (of 24) of the full 2,500-char window, ties broken toward shorter.
//
// WHY A NEW FILE RATHER THAN AN EXTENSION OF sentence-context-test.mjs.
// The ancestor is a production diagnostic: three prose contexts, a regex over
// the reply, no windows. It stays as it is. This panel FREEZES its 8 ambiguous
// targets as fixtures and adds the three things a floor decision needs and a
// diagnostic must not acquire:
//
//   1. DISTANCE STRATIFICATION. A window of W chars can only help when the
//      deciding evidence is inside it, so recall-vs-W is meaningless unless
//      the evidence is placed at a KNOWN distance. Each case appears at three
//      distances -- 8 x 3 = 24 stimuli -- and D is measured exactly as
//      test/finetune/context-distance-survey.mjs measures it: characters back
//      from the end of the context (where the target sentence begins) to the
//      START of the evidence sentence.
//
//      D in {90, 220, 450}: the tertile midpoints of the pooled prior-message
//      start distribution over the owner's real messages, from
//      test/harvested/finetune/context-distance-survey.json -- k=1 p50=85,
//      k=2 p50=162, k=3 p50=237 / p75=338 / p95=597. So D=90 is "the evidence
//      is the message immediately before", D=220 "two messages back", D=450
//      "three or more back". That artifact is REQUIRED: absent, this exits 1
//      rather than measuring a stratification nothing justifies.
//
//   2. AN ABLATED TWIN. Every stimulus has an identical context with the
//      evidence sentence replaced by a same-length neutral one. Without it,
//      R(2500) high and R(0) low is equally well explained by "long contexts
//      make the model bolder" as by "the evidence decided it". The twin is the
//      validity control and it gates the whole result.
//
//   3. AN EXACT PASS CRITERION. The ancestor tests /\bmetal\b/ against the raw
//      reply. That scores a reply the guards would refuse, and it scores a
//      reply that fixed the typo and damaged something else. Here a run counts
//      only when the reply parses, the SHIPPING guard chain applies it, and
//      the applied text equals one of the case's enumerated acceptable
//      corrections after normalizeOut. No regex.
//
// A stimulus whose correct answer the guards refuse could never score, so
// three of the ancestor's typos are deliberately respelled (see CASES). The
// startup check that found them runs on every invocation.

import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, realpathSync,
} from "fs";
import { fileURLToPath } from "url";
import { MODEL, OLLAMA_URL } from "../lib/harness.mjs";
import {
  prepareSentenceRequest, guardSentenceResult,
  sanitizeSentenceOutput,
} from "../lib/sentence-guards.mjs";
import { normalizeOut } from "./benchmark-schema.mjs";

const PAGE_CONTEXT = { hostname: "discord.com" };
const SETTINGS = { ollamaModel: MODEL };
const SURVEY = new URL("../harvested/finetune/context-distance-survey.json", import.meta.url);
const OUT_DIR = new URL("../harvested/finetune/", import.meta.url);

// The distance strata, and the survey percentiles they were derived from. The
// second half is checked at startup: if the corpus has moved far enough that
// these no longer describe it, the strata are stale and the run says so.
const D_LEVELS = [90, 220, 450];
const SURVEY_BASIS = { 1: { p50: 85 }, 2: { p50: 162 }, 3: { p50: 237, p95: 597 } };

// ---------------------------------------------------------------- the fixture
//
// The 8 ambiguous targets are from test/sentence-context-test.mjs, copied in
// rather than imported ON PURPOSE. That suite is the production diagnostic and
// may be re-tuned; this panel is a frozen instrument whose numbers have to stay
// comparable across the whole distillation project. A shared import would let a
// change to the diagnostic silently re-date every window measurement.
// This public revision replaces the recorded metal carrier and clue. Historical
// rates therefore need fresh model runs before comparison with this revision.
//
// THREE TYPOS ARE RESPELLED from the ancestor, because the ancestor scores a
// regex over the raw reply and this panel requires the shipping guards to
// APPLY the correction:
//
//   "I need to by ..."     -> "byu"     `by` is a real word and by|buy holds no
//                                       CONFUSABLE licence, so the correct
//                                       answer is refused word-substituted:+buy.
//                                       `byu` is a non-word at Damerau 1 from
//                                       BOTH readings -- the ambiguity is kept,
//                                       and the fix becomes reachable.
//   "The hoarse was ..."   -> "hourse"  same shape: hoarse/horse are both real
//                                       words, refused word-substituted:hoarse.
//                                       `hourse` is 1 from each.
//   "The disert was ..."   -> "dessrt"  `disert` is 1 edit from `desert` and 2
//                                       from `dessert`, so closerWordExists
//                                       refuses the intended reading outright.
//                                       (desert|dessert was REMOVED from
//                                       CONFUSABLE on 2026-08-14 over the Sahara
//                                       case -- deliberately, and not to be
//                                       undone here.) `dessrt` is 1 from each.
//
// `decision` is the set of words that could DECIDE the case: both readings with
// their inflections, plus the evidence's own cue words. Filler is checked
// against the union of all eight, so no filler message can prime an answer --
// including in the ablated arm, where a leaked cue word would destroy the
// control rather than merely inflate a cell.
//
// `neutral` is the ablated twin's replacement sentence: same length to the
// character (asserted at startup), chat register, deciding nothing.
const CASES = [
  {
    // Synthetic carrier and clue retain the metal/email ambiguity.
    id: "metal",
    sentence: "The sample label refers to that emtal.",
    acceptable: ["The sample label refers to that metal."],
    evidence: "The display includes copper.",
    neutral: "The card is beside the tray.",
    stated: "We need a metal for the model.",
    decision: ["metal", "metals", "metallic", "email", "emails", "mail", "mails",
      "copper", "brass", "silver", "aluminium", "aluminum", "steel"],
  },
  {
    id: "buy",
    sentence: "I need to byu some more of it.",
    acceptable: ["I need to buy some more of it."],
    evidence: "I am at the shop now.",
    neutral: "I am at the desk now.",
    stated: "Did you buy anything?",
    decision: ["buy", "buys", "buying", "bought", "purchase", "purchased",
      "shop", "shops", "shopping", "store", "stores"],
  },
  {
    id: "form",
    sentence: "He sent me the fom yesterday.",
    acceptable: ["He sent me the form yesterday."],
    evidence: "HR needs the paperwork signed.",
    neutral: "Sam needs the update by seven.",
    stated: "Did you fill in the form?",
    decision: ["form", "forms", "from", "paperwork", "document", "documents",
      "signed", "sign", "signing"],
  },
  {
    id: "horse",
    sentence: "The hourse was in the field.",
    acceptable: ["The horse was in the field."],
    evidence: "We drove past the stables.",
    neutral: "We drove past the library.",
    stated: "There was a horse there.",
    decision: ["horse", "horses", "hoarse", "stable", "stables", "saddle",
      "riding", "ride", "rides", "barn", "pony"],
  },
  {
    id: "paper",
    sentence: "We are out of paer again.",
    acceptable: ["We are out of paper again."],
    evidence: "The printer keeps jamming.",
    neutral: "The weather kept changing.",
    stated: "Order more paper.",
    decision: ["paper", "papers", "pair", "pairs", "printer", "printers",
      "printing", "print", "prints", "jamming", "jammed"],
  },
  {
    id: "settings",
    sentence: "Check the setings before you run it.",
    acceptable: ["Check the settings before you run it."],
    evidence: "It is under the gear icon.",
    neutral: "It is under the other tab.",
    stated: "Open the settings panel.",
    decision: ["settings", "setting", "seating", "seatings", "sitting", "gear",
      "icon", "icons", "menu", "menus", "preferences", "options", "config",
      "configure", "toggle"],
  },
  {
    id: "dessert",
    sentence: "The dessrt was the best part.",
    acceptable: ["The dessert was the best part."],
    evidence: "We had three courses at dinner.",
    neutral: "We had a really long chat then.",
    stated: "The dessert was chocolate.",
    decision: ["dessert", "desserts", "desert", "deserts", "dinner", "dinners",
      "course", "courses", "pudding", "cake", "meal", "meals", "restaurant"],
  },
  {
    id: "article",
    sentence: "I read the artical this morning.",
    acceptable: ["I read the article this morning."],
    evidence: "It was on the front page.",
    neutral: "It was on my list before.",
    stated: "Did you see that article?",
    decision: ["article", "articles", "particle", "vertical", "cortical",
      "page", "pages", "headline", "front", "news", "newspaper"],
  },
];

// Three frozen filler sets, hand-authored chat register. SYNTHETIC -- no owner
// text reaches a committed file. Each set is used both to pad the context out
// to 2,500 characters (the "older" block, cycled) and to place the evidence at
// its exact distance (the "newer" block, an exact-fit subset).
const FILLER_SETS = {
  A: [
    "ok",
    "yeah",
    "sure thing",
    "be there in five",
    "no rush at all",
    "same here honestly",
    "agreed",
    "nothing urgent",
    "good catch",
    "that makes sense to me",
    "i can look at it later today",
    "did you get a chance to test that yet",
    "we can talk about it tomorrow morning",
    "that thread went quiet after lunch",
    "i think it landed around three",
    "my laptop battery died again",
    "trying to wrap this up before the weekend",
    "the build is still running",
    "i pinged them twice already",
    "it might be a caching thing",
    "ill check once im back at my desk",
    "the room was booked until four",
    "we ended up rescheduling to next week",
    "im heading out now, back in an hour",
    "ha",
    "lol true",
  ],
  B: [
    "yep",
    "got it",
    "one sec",
    "thanks for that",
    "hmm",
    "fair enough",
    "cool",
    "right",
    "they never replied",
    "still waiting on a reply",
    "that was a weird one",
    "no worries either way",
    "i was away for most of the afternoon",
    "we should probably write that down somewhere",
    "the queue cleared eventually",
    "my train was delayed by twenty minutes",
    "i can take a look tonight",
    "it worked on the second attempt",
    "we tried that last month and it broke",
    "the numbers looked fine to me",
    "i left a note in the thread",
    "lets pick this up on monday",
    "the whole thing took about two hours",
    "i think that covers everything",
    "someone else may have already done it",
    "ill send an update when i know more",
  ],
  C: [
    "sounds good",
    "morning",
    "okay",
    "nice",
    "anyway",
    "true",
    "no idea honestly",
    "i just woke up",
    "i lost track of time",
    "we can revisit it later",
    "that seems reasonable",
    "that was quicker than i expected",
    "we ran out of time yesterday",
    "the meeting moved to thursday",
    "i havent looked at it yet",
    "can we do it after lunch",
    "my headphones keep cutting out",
    "that explains a lot actually",
    "the weather has been awful all week",
    "i had to restart everything twice",
    "they said it would take a while",
    "lets keep it simple for now",
    "i wrote most of it on the train",
    "ill be around all afternoon",
    "the whole team was out sick",
    "we can figure it out tomorrow",
  ],
};
const SET_NAMES = ["A", "B", "C"];

const TOTAL_CONTEXT_CHARS = 2500;      // production's SENTENCE_CONTEXT_CHARS
const DEFAULT_WINDOWS = [0, 125, 250, 375, 500, 750, 1000, 1500, 2500];
const PROVISIONAL_FALLBACK_W = 500;    // design note's fallback when INCONCLUSIVE

// ------------------------------------------------------------- CLI + failures
function die(msg) {
  console.error(`\ncontext-floor-panel: ${msg}\n`);
  process.exit(1);
}

// This module STARTS A GPU SWEEP at import -- there is no exported entry point
// and no way to load it without running one. That is not hypothetical: a
// `node -e 'await import(...)'` written to inspect the fixture got 348 requests
// into a 1,440-request sweep against the production runner before anybody
// noticed, because the sweep's own progress output was redirected away. An
// import is therefore refused outright rather than trusted to be deliberate.
function assertEntryPoint(name) {
  let entry = null, self = null;
  try {
    entry = process.argv[1] && realpathSync(process.argv[1]);
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch { /* fall through to the refusal */ }
  if (!entry || entry !== self) {
    die(`${name} runs a multi-request model sweep at import and must be run as a\n`
      + `  script, not imported. Use: node ${name} --dry-run`);
  }
}
assertEntryPoint("test/finetune/context-floor-panel.mjs");

const argv = process.argv.slice(2);
const opts = {
  dryRun: false, n: 3, windows: DEFAULT_WINDOWS.slice(),
  out: null, jsonl: null, cases: null, fresh: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    const v = argv[++i];
    if (v === undefined) die(`${a} needs a value`);
    return v;
  };
  if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--fresh") opts.fresh = true;
  else if (a === "--n") opts.n = Number(val());
  else if (a === "--windows") {
    opts.windows = val().split(",").map((s) => Number(s.trim()));
  } else if (a === "--cases") opts.cases = val().split(",").map((s) => s.trim());
  else if (a === "--out") opts.out = val();
  else if (a === "--jsonl") opts.jsonl = val();
  else die(`unknown flag ${a}\n\n  --dry-run  --n N  --windows a,b,c  --cases id,id`
    + `  --out file.json  --jsonl file.jsonl  --fresh`);
}
if (!Number.isInteger(opts.n) || opts.n < 1) die(`--n must be a positive integer`);
if (!opts.windows.length || opts.windows.some((w) => !Number.isInteger(w) || w < 0)) {
  die(`--windows must be a comma list of non-negative integers`);
}
opts.windows = [...new Set(opts.windows)].sort((a, b) => a - b);
if (opts.cases) {
  const known = new Set(CASES.map((c) => c.id));
  for (const id of opts.cases) if (!known.has(id)) die(`--cases: unknown case ${id}`);
}
const ACTIVE_CASES = opts.cases
  ? CASES.filter((c) => opts.cases.includes(c.id)) : CASES;

// ------------------------------------------------------- survey artifact gate
if (!existsSync(SURVEY)) {
  die(`missing ${fileURLToPath(SURVEY)}\n`
    + `  The distance strata {${D_LEVELS.join(", ")}} are derived from it.\n`
    + `  Run: node test/finetune/context-distance-survey.mjs`);
}
let survey;
try { survey = JSON.parse(readFileSync(SURVEY, "utf8")); }
catch (e) { die(`${fileURLToPath(SURVEY)} is not readable JSON: ${e.message}`); }
const surveyDrift = [];
for (const [k, want] of Object.entries(SURVEY_BASIS)) {
  const got = survey.percentiles?.[k];
  if (!got) { surveyDrift.push(`k=${k} missing from the artifact`); continue; }
  for (const [p, v] of Object.entries(want)) {
    if (got[p] !== v) surveyDrift.push(`k=${k} ${p}: artifact ${got[p]}, strata assume ${v}`);
  }
}

// ------------------------------------------------------------- construction
/**
 * Pick a subset of `weights` summing EXACTLY to `target` (0/1 knapsack, items
 * in fixed order, first reconstruction wins -- deterministic). Returns indices,
 * or null. Used with weight = message.length + 1, because a block of k messages
 * joined by "\n" is sum(len) + (k-1) characters long, i.e. sum(len+1) - 1.
 */
function subsetSumPick(weights, target) {
  if (target === 0) return [];
  if (target < 0) return null;
  const parent = new Array(target + 1).fill(null);
  const reach = new Uint8Array(target + 1);
  reach[0] = 1;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (w <= 0 || w > target) continue;
    for (let t = target; t >= w; t--) {
      if (reach[t] || !reach[t - w]) continue;
      reach[t] = 1;
      parent[t] = { i, prev: t - w };
    }
  }
  if (!reach[target]) return null;
  const picked = [];
  for (let t = target; t > 0;) { picked.push(parent[t].i); t = parent[t].prev; }
  return picked.sort((a, b) => a - b);
}

/** The largest exactly-reachable total at or below `target`. */
function bestUnder(weights, target) {
  for (let t = target; t >= 0; t--) {
    const pick = subsetSumPick(weights, t);
    if (pick) return { total: t, pick };
  }
  return { total: 0, pick: [] };
}

/** Cycle a filler pool from `offset` until the joined block reaches minLen. */
function padOlder(pool, offset, minLen) {
  const parts = [];
  let len = -1;
  for (let i = 0; len < minLen; i++) {
    parts.push(pool[(offset + i) % pool.length]);
    len += pool[(offset + i) % pool.length].length + 1;
  }
  return parts.join("\n");
}

/**
 * Build one context. `key` is the evidence sentence for the evidence arm and
 * the same-length neutral sentence for the ablated arm, so the two contexts
 * differ in exactly those characters and in nothing else.
 *
 *   ctx = <older filler, padded to >= 2500 total> \n <key> [\n <newer filler>]
 *
 * D is measured as the survey measures it: chars from the END of the context
 * back to the START of `key`. newerLen = D - len(key) - 1; if that is <= 0 the
 * key sits flush at the tail and the ACTUAL D is len(key), which is recorded
 * rather than assumed.
 */
function buildContext(key, D, setName, rotation) {
  const pool = FILLER_SETS[setName];
  const weights = pool.map((m) => m.length + 1);
  const wantNewer = D - key.length - 1;
  let newer = "", exact = true;
  if (wantNewer > 0) {
    const pick = subsetSumPick(weights, wantNewer + 1);
    if (pick) newer = pick.map((i) => pool[i]).join("\n");
    else {
      const b = bestUnder(weights, wantNewer + 1);
      newer = b.pick.map((i) => pool[i]).join("\n");
      exact = false;
    }
  }
  const actualD = key.length + (newer ? 1 + newer.length : 0);
  const older = padOlder(pool, rotation, Math.max(1, TOTAL_CONTEXT_CHARS - 1 - actualD));
  const ctx = older + "\n" + key + (newer ? "\n" + newer : "");
  // Self-check: the key really is at actualD from the end, and the whole
  // context really is long enough for the 2500 window to be a tail trim.
  const at = ctx.length - actualD;
  if (ctx.slice(at, at + key.length) !== key) {
    die(`internal: context geometry wrong for ${JSON.stringify(key.slice(0, 20))} at D=${D}`);
  }
  if (ctx.length < TOTAL_CONTEXT_CHARS) {
    die(`internal: context is ${ctx.length} chars, need >= ${TOTAL_CONTEXT_CHARS}`);
  }
  return { ctx, actualD, nominalD: D, exact, newerLen: newer.length, olderLen: older.length };
}

/**
 * Filler-set assignment: a Latin rotation, set = SET_NAMES[(caseIdx + dIdx) % 3].
 * Each case sees all three sets across the three distances, and each set
 * appears at each distance for two or three of the eight cases -- so filler
 * IDENTITY cannot be confounded with distance, which is the only thing the
 * balancing has to buy. The older-block rotation offset varies per cell too, so
 * two stimuli sharing a set do not share a padding sequence.
 */
function setFor(caseIdx, dIdx) { return SET_NAMES[(caseIdx + dIdx) % SET_NAMES.length]; }

const STIMULI = [];
for (const c of ACTIVE_CASES) {
  const caseIdx = CASES.indexOf(c);
  D_LEVELS.forEach((D, dIdx) => {
    const setName = setFor(caseIdx, dIdx);
    const rotation = caseIdx * D_LEVELS.length + dIdx;
    STIMULI.push({
      id: `${c.id}@${D}`,
      caseId: c.id, D, setName,
      sentence: c.sentence,
      acceptable: c.acceptable.map(normalizeOut),
      evidence: buildContext(c.evidence, D, setName, rotation),
      ablated: buildContext(c.neutral, D, setName, rotation),
    });
  });
}

// ------------------------------------------------------------------- checks
const wordsOf = (s) => String(s).toLowerCase().match(/[a-z']+/g) || [];
const DECISION_UNION = new Map();     // word -> [caseId, ...]
for (const c of CASES) {
  for (const w of c.decision) {
    const k = w.toLowerCase();
    if (!DECISION_UNION.has(k)) DECISION_UNION.set(k, []);
    DECISION_UNION.get(k).push(c.id);
  }
}

/**
 * HARD REQUIREMENT: filler may not decide any case. A filler word that primes
 * an answer poisons every cell it appears in -- and in the ablated arm it
 * destroys the control outright, which is worse, because the control is what
 * licenses reading anything into the evidence arm at all.
 *
 * The rule is the brief's: no filler content word longer than 3 characters may
 * appear in any case's decision set. Short words (`by`, `to`) are out of the
 * check's reach by construction; none of the intended readings is that short.
 */
function checkFiller() {
  const bad = [];
  for (const [setName, pool] of Object.entries(FILLER_SETS)) {
    pool.forEach((msg, i) => {
      for (const w of wordsOf(msg)) {
        if (w.length <= 3) continue;
        if (DECISION_UNION.has(w)) {
          bad.push(`filler ${setName}[${i}] word ${JSON.stringify(w)} decides `
            + `${DECISION_UNION.get(w).join("/")}: ${JSON.stringify(msg)}`);
        }
      }
    });
  }
  // The ablated twins are filler too, and are checked against their OWN case.
  for (const c of CASES) {
    const own = new Set(c.decision.map((w) => w.toLowerCase()));
    for (const w of wordsOf(c.neutral)) {
      if (w.length > 3 && own.has(w)) {
        bad.push(`neutral twin for ${c.id} decides it: ${JSON.stringify(w)}`);
      }
    }
    if (c.neutral.length !== c.evidence.length) {
      bad.push(`neutral twin for ${c.id} is ${c.neutral.length} chars, `
        + `evidence is ${c.evidence.length} -- the twin must be same-length`);
    }
    // And the positive control: an evidence sentence that decides NOTHING is a
    // broken fixture, and would read as "context does not help".
    const decides = wordsOf(c.evidence).some((w) => w.length > 3 && own.has(w));
    if (!decides) bad.push(`evidence for ${c.id} contains no decision word`);
  }
  return bad;
}

/**
 * A stimulus whose correct answer the shipping guards refuse can never score,
 * and would be indistinguishable from "the model never gets it". Three of the
 * ancestor's eight were exactly that (see CASES). This runs every time.
 */
function checkGuards() {
  const bad = [];
  for (const c of CASES) {
    for (const a of c.acceptable) {
      if (normalizeOut(a) === normalizeOut(c.sentence)) {
        bad.push(`${c.id}: acceptable output is the input unchanged`);
        continue;
      }
      const reason = guardSentenceResult(c.sentence, a, a, {});
      if (reason) bad.push(`${c.id}: the guards REFUSE the correct answer (${reason})\n`
        + `      in:  ${JSON.stringify(c.sentence)}\n`
        + `      out: ${JSON.stringify(a)}`);
    }
  }
  return bad;
}

const fillerProblems = checkFiller();
const guardProblems = checkGuards();

// ------------------------------------------------------------------ requests
/** Production trims with slice(-W). W=0 needs its own branch: "abc".slice(-0)
 *  is "abc", not "" -- the one place a zero window silently becomes a full one. */
function trimContext(ctx, W) { return W <= 0 ? "" : String(ctx).slice(-W); }

async function ask(sentence, ctx) {
  const req = prepareSentenceRequest(sentence, ctx, PAGE_CONTEXT, SETTINGS);
  const t0 = Date.now();
  let data, error = null;
  try {
    const res = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    if (!res.ok) error = `http-${res.status}`;
    else data = await res.json();
  } catch (e) { error = String(e.message); }
  const ms = Date.now() - t0;
  const row = {
    ms, error,
    promptTokens: data?.prompt_eval_count ?? null,
    promptMs: data?.prompt_eval_duration != null
      ? Math.round(data.prompt_eval_duration / 1e6) : null,
    evalTokens: data?.eval_count ?? null,
    evalMs: data?.eval_duration != null ? Math.round(data.eval_duration / 1e6) : null,
    contextChars: ctx.length,
  };
  if (error) return { ...row, verdict: "error", applied: null };
  if (data.error) return { ...row, error: String(data.error), verdict: "error", applied: null };
  if (data.done_reason === "length") return { ...row, verdict: "truncated", applied: null };
  let rewritten;
  try {
    const parsed = JSON.parse(String(data.message?.content ?? "").trim());
    rewritten = parsed?.rewritten;
  } catch { return { ...row, verdict: "invalid-json", applied: null }; }
  if (typeof rewritten !== "string") {
    return { ...row, verdict: "no-rewritten-key", applied: null };
  }
  // The shared shipping sanitizer question, followed by the guards. It asks
  // whether anything WOULD change; guardSentenceResult refuses when it would.
  const cleaned = sanitizeSentenceOutput(sentence, rewritten);
  const refused = guardSentenceResult(sentence, rewritten, cleaned, {});
  if (refused) return { ...row, verdict: `refused:${refused}`, applied: null, raw: rewritten };
  if (cleaned.trim() === sentence.trim()) {
    return { ...row, verdict: "no-op", applied: null, raw: rewritten };
  }
  return { ...row, verdict: "applied", applied: normalizeOut(cleaned.trim()), raw: rewritten };
}

// -------------------------------------------------------------- artifact I/O
mkdirSync(OUT_DIR, { recursive: true });
const OUT_JSON = opts.out || process.env.PROOFER_RESULT_JSON
  || fileURLToPath(new URL("context-floor-panel.json", OUT_DIR));
const OUT_JSONL = opts.jsonl || OUT_JSON.replace(/\.json$/, "") + ".jsonl";

const keyOf = (r) => [r.kind, r.stimulus, r.window, r.arm, r.run].join("|");
const done = new Map();
if (!opts.dryRun && !opts.fresh && existsSync(OUT_JSONL)) {
  for (const line of readFileSync(OUT_JSONL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.model === MODEL) done.set(keyOf(r), r);
    } catch { /* a torn final line from a killed run; ignore it */ }
  }
}

// ------------------------------------------------------------------ dry run
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log(`\nContext-length floor panel  (plan §7 Phase 0.2)`);
console.log("=".repeat(78));
console.log(`model      ${MODEL}   ${OLLAMA_URL}`);
console.log(`stimuli    ${STIMULI.length} = ${ACTIVE_CASES.length} cases x ${D_LEVELS.length} distances`);
console.log(`windows    ${opts.windows.join(", ")}`);
console.log(`arms       evidence, ablated   n=${opts.n} per stimulus/window/arm`);
console.log(`survey     ${survey.targets} targets, ${survey.withPrior} with prior context`);
if (surveyDrift.length) {
  console.log(`\nNOTE: the distance survey has MOVED since these strata were frozen:`);
  for (const d of surveyDrift) console.log(`  ${d}`);
  console.log(`  The strata are fixtures and are unchanged; the run is comparable to`);
  console.log(`  earlier ones but may no longer be representative of the corpus.`);
}

console.log(`\nfiller decision-set check:`);
if (fillerProblems.length) {
  for (const p of fillerProblems) console.log(`  FAIL ${p}`);
  die(`${fillerProblems.length} filler/twin violation(s). A filler word that primes an\n`
    + `  answer poisons every cell it appears in. Fix the fixture; do not relax the check.`);
}
console.log(`  OK  ${Object.values(FILLER_SETS).flat().length} filler messages, `
  + `${CASES.length} neutral twins, ${DECISION_UNION.size} decision words, 0 collisions`);

console.log(`guard reachability check:`);
if (guardProblems.length) {
  for (const p of guardProblems) console.log(`  FAIL ${p}`);
  die(`${guardProblems.length} stimulus/stimuli whose CORRECT answer the shipping guards\n`
    + `  refuse. Such a cell can never score and would read as a model failure.`);
}
console.log(`  OK  all ${CASES.length} acceptable corrections survive guardSentenceResult`);

console.log(`\nstimulus table (D actual is measured through the built context):`);
console.log(`  ${pad("case", 10)} ${lpad("D", 4)} ${lpad("Dact", 5)} set  `
  + `${lpad("older", 6)} ${lpad("newer", 6)} ${lpad("ctx", 6)}  fit  sentence`);
for (const s of STIMULI) {
  const e = s.evidence, a = s.ablated;
  const same = e.actualD === a.actualD && e.ctx.length === a.ctx.length;
  console.log(`  ${pad(s.caseId, 10)} ${lpad(s.D, 4)} ${lpad(e.actualD, 5)}  ${s.setName}   `
    + `${lpad(e.olderLen, 6)} ${lpad(e.newerLen, 6)} ${lpad(e.ctx.length, 6)}  `
    + `${e.exact ? "ex " : "under"} ${same ? "" : "ARM MISMATCH "}${JSON.stringify(s.sentence)}`);
}
const mism = STIMULI.filter((s) => s.evidence.actualD !== s.ablated.actualD);
if (mism.length) die(`${mism.length} stimuli whose arms differ in geometry`);
const inexact = STIMULI.filter((s) => !s.evidence.exact);
console.log(`  ${STIMULI.length} stimuli, ${STIMULI.length - inexact.length} at EXACT nominal D`
  + `${inexact.length ? `, ${inexact.length} at the closest reachable D (recorded above)` : ""}`);

const requests = STIMULI.length * opts.windows.length * 2 * opts.n
  + ACTIVE_CASES.length * opts.windows.length * 2;   // + none/stated diagnostics
console.log(`\nrequests: ${requests} total`
  + `  (${STIMULI.length * opts.windows.length * 2 * opts.n} panel`
  + ` + ${ACTIVE_CASES.length * opts.windows.length * 2} diagnostic)`
  + `${done.size ? `, ${done.size} already recorded in ${OUT_JSONL.split("/").pop()}` : ""}`);
console.log(`artifact: ${OUT_JSON}`);
console.log(`rows:     ${OUT_JSONL}`);

if (opts.dryRun) {
  console.log(`\n--dry-run: assembled everything, made zero model calls.\n`);
  process.exit(0);
}

// --------------------------------------------------------------------- run
const rows = [];
let n = 0;
async function record(row) {
  const key = keyOf(row);
  const cached = done.get(key);
  if (cached) { rows.push(cached); return cached; }
  const r = await ask(row.sentence, row.ctx);
  const full = {
    model: MODEL, kind: row.kind, stimulus: row.stimulus, caseId: row.caseId,
    D: row.D ?? null, setName: row.setName ?? null,
    window: row.window, arm: row.arm, run: row.run,
    hit: row.acceptable ? (r.applied != null && row.acceptable.includes(r.applied)) : null,
    ...r,
  };
  appendFileSync(OUT_JSONL, JSON.stringify(full) + "\n");
  done.set(key, full);
  rows.push(full);
  if (++n % 25 === 0) process.stderr.write(`  ${n} new requests\n`);
  return full;
}

console.log(`\nrunning (serialized -- one request at a time, it is one GPU)\n`);
const t0 = Date.now();
for (const W of opts.windows) {
  for (const s of STIMULI) {
    for (const arm of ["evidence", "ablated"]) {
      for (let run = 0; run < opts.n; run++) {
        await record({
          kind: "panel", stimulus: s.id, caseId: s.caseId, D: s.D, setName: s.setName,
          window: W, arm, run, sentence: s.sentence,
          ctx: trimContext(s[arm].ctx, W), acceptable: s.acceptable,
        });
      }
    }
  }
  // Diagnostics, OUTSIDE the /24: the ancestor's `none` and `stated` conditions.
  // `none` sends an empty context at every window, so its spread across windows
  // is a run-to-run NOISE FLOOR for the panel, not a context effect. `stated`
  // puts the answer verbatim in the context and is the priming ceiling.
  for (const c of ACTIVE_CASES) {
    const acc = c.acceptable.map(normalizeOut);
    await record({
      kind: "diag", stimulus: `none:${c.id}`, caseId: c.id, window: W, arm: "none",
      run: 0, sentence: c.sentence, ctx: "", acceptable: acc,
    });
    await record({
      kind: "diag", stimulus: `stated:${c.id}`, caseId: c.id, window: W, arm: "stated",
      run: 0, sentence: c.sentence, ctx: trimContext(c.stated, W), acceptable: acc,
    });
  }
}
const elapsedMs = Date.now() - t0;

// ------------------------------------------------------------------ report
const median = (a) => {
  const s = a.filter((x) => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
// >= 2 of 3 is the predeclared rule. With --n it generalises to a majority,
// and at --n 1 it degenerates to "the single run passed" -- a smoke mode.
const NEED = Math.min(opts.n, Math.max(2, Math.ceil(opts.n / 2)));

const panel = rows.filter((r) => r.kind === "panel");
const byWindow = new Map();
for (const W of opts.windows) {
  const cell = { W, evidence: 0, ablated: 0, perStimulus: {}, errors: 0 };
  for (const s of STIMULI) {
    for (const arm of ["evidence", "ablated"]) {
      const runs = panel.filter((r) => r.window === W && r.stimulus === s.id && r.arm === arm);
      const hits = runs.filter((r) => r.hit).length;
      cell.errors += runs.filter((r) => r.verdict === "error").length;
      const pass = hits >= NEED;
      if (pass) cell[arm]++;
      cell.perStimulus[`${s.id}|${arm}`] = { hits, runs: runs.length, pass };
    }
  }
  const wrows = panel.filter((r) => r.window === W);
  cell.medianPromptTokens = median(wrows.map((r) => r.promptTokens));
  cell.medianMs = median(wrows.map((r) => r.ms));
  cell.medianPromptMs = median(wrows.map((r) => r.promptMs));
  cell.medianEvalTokens = median(wrows.map((r) => r.evalTokens));
  byWindow.set(W, cell);
}

const diag = rows.filter((r) => r.kind === "diag");
const diagAt = (W, arm) => diag.filter((r) => r.window === W && r.arm === arm && r.hit).length;

const MAXW = opts.windows[opts.windows.length - 1];
const ref = byWindow.get(MAXW);
const T = STIMULI.length;

console.log(`\n` + "=".repeat(78));
console.log(`RESULT   ${MODEL}   ${STIMULI.length} stimuli x ${opts.n} runs, `
  + `pass = >=${NEED}/${opts.n} exact guarded corrections`);
console.log("=".repeat(78));
console.log(`  ${lpad("W", 6)}  ${lpad("R_ev", 6)}  ${lpad("R_abl", 6)}  ${lpad("gap", 4)}  `
  + `${lpad("none", 5)} ${lpad("stated", 6)}  ${lpad("promptTok", 9)} ${lpad("medMs", 6)}`);
for (const W of opts.windows) {
  const c = byWindow.get(W);
  console.log(`  ${lpad(W, 6)}  ${lpad(`${c.evidence}/${T}`, 6)}  ${lpad(`${c.ablated}/${T}`, 6)}  `
    + `${lpad(c.evidence - c.ablated, 4)}  ${lpad(`${diagAt(W, "none")}/${ACTIVE_CASES.length}`, 5)} `
    + `${lpad(`${diagAt(W, "stated")}/${ACTIVE_CASES.length}`, 6)}  `
    + `${lpad(c.medianPromptTokens ?? "-", 9)} ${lpad(c.medianMs ?? "-", 6)}`
    + `${c.errors ? `   ${c.errors} ERRORS` : ""}`);
}

const validityGap = ref.evidence - ref.ablated;
const valid = validityGap >= 4;
console.log("\n" + "-".repeat(78));
console.log(`validity control  R_ev(${MAXW}) - R_abl(${MAXW}) = ${ref.evidence} - ${ref.ablated}`
  + ` = ${validityGap}   (needs >= 4)`);

let chosen = null, verdictLine;
if (!valid) {
  verdictLine = `INCONCLUSIVE -- the evidence sentence is not measurably deciding these\n`
    + `  cases even at the full window, so recall-vs-W is not measuring context use.\n`
    + `  NO WINDOW IS CHOSEN. The design note's provisional fallback is `
    + `W=${PROVISIONAL_FALLBACK_W},\n  which is a placeholder to unblock Phase 1, not a result.`;
} else {
  const floor = ref.evidence - 2;
  chosen = opts.windows.find((W) => byWindow.get(W).evidence >= floor);
  verdictLine = `SELECTED W=${chosen}   (min W with R_ev(W) >= R_ev(${MAXW}) - 2 = ${floor};`
    + ` ties toward shorter)\n  Teacher and student both see exactly ${chosen} characters `
    + `of prior context from here on.`;
}
console.log(verdictLine);
console.log("-".repeat(78));
console.log(`  ${rows.length} rows (${n} new), ${Math.round(elapsedMs / 1000)}s`);

writeFileSync(OUT_JSON, JSON.stringify({
  generated: "context-floor-panel",
  at: new Date().toISOString(),
  model: MODEL, ollamaUrl: OLLAMA_URL,
  n: opts.n, need: NEED, windows: opts.windows, dLevels: D_LEVELS,
  surveyBasis: SURVEY_BASIS, surveyDrift,
  stimuli: STIMULI.map((s) => ({
    id: s.id, caseId: s.caseId, D: s.D, setName: s.setName,
    actualD: s.evidence.actualD, exact: s.evidence.exact,
    contextChars: s.evidence.ctx.length,
    ablatedActualD: s.ablated.actualD, ablatedContextChars: s.ablated.ctx.length,
  })),
  perWindow: opts.windows.map((W) => ({
    ...byWindow.get(W),
    none: diagAt(W, "none"), stated: diagAt(W, "stated"),
  })),
  total: T,
  validity: { gap: validityGap, threshold: 4, valid },
  selection: {
    rule: "min W such that R_evidence(W) >= R_evidence(max) - 2, ties toward shorter",
    reference: MAXW, chosen,
    provisionalFallback: valid ? null : PROVISIONAL_FALLBACK_W,
  },
  rows,
}, null, 2));
console.log(`  artifact: ${OUT_JSON}\n`);
