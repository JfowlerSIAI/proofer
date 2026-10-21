#!/usr/bin/env node
// Do TEACHER TARGETS change when the context is trimmed?
//
//   node test/finetune/context-stability-probe.mjs --windows 375,500,2500 --dry-run
//   PROOFER_MODEL=qwen3.8:27b PROOFER_SKIP_DIGEST_CHECK=1 \
//     node test/finetune/context-stability-probe.mjs --windows 375,500,2500
//
// Plan §7 Phase 0.2, second half. context-floor-panel.mjs asks whether a
// shorter window loses RECALL on cases the context is supposed to decide. This
// asks the other, larger question: on ORDINARY traffic, does trimming the
// context change what the teacher emits at all?
//
// It matters because of what the answer is used for. Every example the teacher
// labels at 2,500 characters and the student then sees at W is LABEL NOISE if
// the target would have been different at W -- the student is being taught an
// answer its own input cannot support. So an example whose modal target moves
// between W and the full window is dropped, and the drop RATE is what decides
// whether W is usable at all.
//
// Protocol (Sol, 2026-08-20, binding):
//   - N=300 real sentence targets with their real contexts, seeded, from
//     ../harvested/discord-source.mjs -- 100 uniform-random, 100 that the
//     dictionary screen flags as likely-error, 100 "hard" (names, numbers,
//     negation, instruction-like, code/URL, short-and-ambiguous).
//   - 3 generations per example per window, production request shape and
//     options, context trimmed exactly as production trims it (slice(-W)).
//   - EFFECTIVE-TARGET SIGNATURE per generation: {applied:true, out} when the
//     shipping guard chain applies, else {applied:false, reason}. The signature
//     is the thing distillation would consume, so it is what has to be stable
//     -- not the raw string, which differs on refusals that mean the same.
//   - MODAL signature = shared by >=2 of 3. None => the example is
//     INTRINSICALLY UNSTABLE at that window: counted, and EXCLUDED from the
//     context comparison, because the model disagreeing with itself at a fixed
//     window is not evidence about the window.
//   - CONTEXT-INDUCED CHANGE = modal(W) != modal(longest window run).
//
// Thresholds (Sol, binding): over the ordinary 200 (random + screen),
// <=4 changes AND one-sided 95% Wilson upper bound < 5%; over the hard 100,
// <=5 changes AND upper bound < 10%. A window failing either arm is reported
// MOVE-TO-NEXT-LONGER-WINDOW.
//
// PRIVACY. This reads the owner's private corpus. Every artifact lands in
// test/harvested/ (gitignored) and nothing containing message text is printed
// to the console -- the report is counts and uids only.

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
import { segmentSentences } from "../lib/content-sandbox.mjs";
import {
  CSV, loadMessages, loadDictionary, channelIndex, targetsFor, typoTokens,
  uidFor, shuffled, MIN_SENTENCE_CHARS, MAX_TARGET,
} from "../harvested/discord-source.mjs";

const PAGE_CONTEXT = { hostname: "discord.com" };
const SETTINGS = { ollamaModel: MODEL };
const OUT_DIR = new URL("../harvested/finetune/", import.meta.url);
const DEFAULT_SEED = 20260820;
const GENS = 3;
const Z_95_ONE_SIDED = 1.645;

// Sol's thresholds, by arm. `max` is the absolute count; `ub` is the one-sided
// 95% Wilson upper bound on the rate. BOTH must hold.
const THRESHOLDS = {
  ordinary: { max: 4, ub: 0.05, strata: ["random", "screen"] },
  hard: { max: 5, ub: 0.10, strata: ["hard"] },
};

function die(msg) {
  console.error(`\ncontext-stability-probe: ${msg}\n`);
  process.exit(1);
}

// This module STARTS A GPU SWEEP at import, and additionally reads the owner's
// private corpus. Neither should happen because something imported it to look
// at a helper. Same refusal as context-floor-panel.mjs, and for the same
// measured reason -- an accidental import there ran 348 real requests.
function assertEntryPoint(name) {
  let entry = null, self = null;
  try {
    entry = process.argv[1] && realpathSync(process.argv[1]);
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch { /* fall through to the refusal */ }
  if (!entry || entry !== self) {
    die(`${name} runs a multi-request model sweep at import and must be run as a\n`
      + `  script, not imported. Use: node ${name} --windows 375,500,2500 --dry-run`);
  }
}
assertEntryPoint("test/finetune/context-stability-probe.mjs");

// ------------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
const opts = {
  dryRun: false, windows: null, perStratum: 100,
  out: null, jsonl: null, fresh: false, drops: null,
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
  else if (a === "--windows") opts.windows = val().split(",").map((s) => Number(s.trim()));
  else if (a === "--per-stratum") opts.perStratum = Number(val());
  else if (a === "--drops") opts.drops = Number(val());
  else if (a === "--out") opts.out = val();
  else if (a === "--jsonl") opts.jsonl = val();
  else die(`unknown flag ${a}\n\n  --windows a,b,c (REQUIRED)  --per-stratum N  --dry-run`
    + `  --drops W\n  --out file.json  --jsonl file.jsonl  --fresh`);
}
if (!opts.windows) {
  die(`--windows is REQUIRED (comma list, e.g. --windows 375,500,2500).\n`
    + `  There is no default: the candidate windows come from context-floor-panel.mjs,\n`
    + `  and a probe that invented its own would be answering a different question.`);
}
if (!opts.windows.length || opts.windows.some((w) => !Number.isInteger(w) || w < 0)) {
  die(`--windows must be a comma list of non-negative integers`);
}
opts.windows = [...new Set(opts.windows)].sort((a, b) => a - b);
if (opts.windows.length < 2) die(`--windows needs at least two windows: the longest is the reference`);
if (!Number.isInteger(opts.perStratum) || opts.perStratum < 1) {
  die(`--per-stratum must be a positive integer`);
}
if (opts.drops != null && !opts.windows.includes(opts.drops)) {
  die(`--drops ${opts.drops} is not one of --windows ${opts.windows.join(",")}.\n`
    + `  The drop list is built from that window's recorded generations; there are none.`);
}
const SEED = Number(process.env.PROOFER_SEED || DEFAULT_SEED);
if (!Number.isFinite(SEED)) die(`PROOFER_SEED must be a number`);
const REFERENCE_W = opts.windows[opts.windows.length - 1];

// ------------------------------------------------------------------ corpus
if (!existsSync(CSV)) {
  die(`the owner corpus is not on disk: ${CSV}\n`
    + `  See test/harvested/discord-source.mjs (CSV). This probe cannot run without it.`);
}
const msgs = loadMessages();
if (!msgs.length) die(`${CSV} produced zero messages`);
const DICT = loadDictionary();
const byChannel = channelIndex(msgs);

// The target inventory: every sentence production's segmenter would offer,
// enumerated cheaply (no per-message channel scan). Contexts are resolved
// later, through targetsFor, for the ~300 that get sampled -- so the context
// each example carries is built by the SHIPPING construction and not by a
// second copy of it here.
const inventory = [];
for (const m of msgs) {
  for (const s of segmentSentences(m.content)) {
    const text = s.text.trim();
    if (text.length < MIN_SENTENCE_CHARS || text.length > MAX_TARGET) continue;
    inventory.push({ uid: uidFor(m.message_id, text), message_id: m.message_id, sentence: text });
  }
}
if (!inventory.length) die(`the corpus produced zero sentence targets`);

// ------------------------------------------------------------------ screens
/**
 * The "hard" screens. Deliberately simple pattern tests, not a classifier: the
 * point is to over-sample the shapes where a trimmed context is most likely to
 * change an answer, not to label them correctly. Which screens matched is
 * recorded per example so the arm can be decomposed afterwards.
 */
const IMPERATIVE_OPENERS = new Set([
  "ignore", "disregard", "please", "make", "add", "remove", "check", "send",
  "run", "try", "use", "let", "keep", "stop", "start", "give", "take", "tell",
  "look", "fix", "write", "read", "open", "close", "put", "set", "move",
]);
function hardScreens(sentence, typos) {
  const hits = [];
  const toks = sentence.split(/\s+/).filter(Boolean);
  if (toks.some((t, i) => i > 0 && /^[A-Z][a-z]{2,}/.test(t))) hits.push("names");
  if (/\d/.test(sentence)) hits.push("numbers");
  if (/\b(not|no|never|none|nothing|nobody|nowhere|cannot|nor)\b/i.test(sentence)
    || /n['’]t\b/i.test(sentence)) hits.push("negation");
  const first = (toks[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  if (/\b(ignore|disregard)\b/i.test(sentence) || IMPERATIVE_OPENERS.has(first)) {
    hits.push("instruction-like");
  }
  if (/https?:\/\/|www\.|`|[{}<>]|\b\w+\.(com|org|net|io|js|py|sh|json|md)\b|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b/
    .test(sentence)) hits.push("code-url");
  if (sentence.length < 60 && typos.length) hits.push("ambiguity");
  return hits;
}

const SCREEN_ORDER = ["instruction-like", "code-url", "ambiguity", "negation", "numbers", "names"];
for (const it of inventory) {
  const typos = typoTokens(it.sentence, DICT);
  it.typos = typos.length;
  it.screens = hardScreens(it.sentence, typos);
}

// ------------------------------------------------------------------ sampling
// Three strata, filled in a fixed order with dedup by uid. `random` goes first
// and is drawn from the WHOLE inventory, so it stays a uniform sample of real
// traffic -- the arm every rate is meant to generalise from. The two enriched
// strata then take what is left.
function draw(pool, k, seed, taken) {
  const out = [];
  for (const idx of shuffled(pool.map((_, i) => i), seed)) {
    const it = pool[idx];
    if (taken.has(it.uid)) continue;
    taken.add(it.uid);
    out.push(it);
    if (out.length >= k) break;
  }
  return out;
}
/**
 * The hard stratum is drawn ROUND-ROBIN across the screens, rarest first,
 * rather than uniformly from their union. A uniform draw is dominated by
 * whichever screen is commonest -- measured on this corpus it returned 49
 * `numbers` and ZERO `instruction-like`, so the screen most likely to interact
 * with a truncated context contributed nothing to the arm it was named for.
 * Rare screens exhaust first and the common ones fill the remainder.
 */
function drawByScreen(pool, k, seed, taken) {
  const buckets = new Map(SCREEN_ORDER.map((s) =>
    [s, shuffled(pool.filter((it) => it.screens.includes(s)), seed)]));
  const cursor = new Map(SCREEN_ORDER.map((s) => [s, 0]));
  const out = [];
  for (let progress = true; out.length < k && progress;) {
    progress = false;
    for (const s of SCREEN_ORDER) {
      if (out.length >= k) break;
      const b = buckets.get(s);
      let i = cursor.get(s);
      while (i < b.length && taken.has(b[i].uid)) i++;
      cursor.set(s, i + 1);
      if (i >= b.length) continue;
      taken.add(b[i].uid);
      out.push(b[i]);
      progress = true;
    }
  }
  return out;
}

const taken = new Set();
const strata = {
  random: draw(inventory, opts.perStratum, SEED, taken),
  screen: draw(inventory.filter((it) => it.typos > 0), opts.perStratum, SEED + 1, taken),
  hard: drawByScreen(inventory.filter((it) => it.screens.length > 0),
    opts.perStratum, SEED + 2, taken),
};

// Resolve real contexts through the shipping construction, one channel scan per
// selected message rather than per corpus message.
const byMessage = new Map();
for (const [name, list] of Object.entries(strata)) {
  for (const it of list) {
    if (!byMessage.has(it.message_id)) byMessage.set(it.message_id, []);
    byMessage.get(it.message_id).push({ ...it, stratum: name });
  }
}
const EXAMPLES = [];
const unresolved = [];
for (const [messageId, wanted] of byMessage) {
  const m = msgs.find((x) => x.message_id === messageId);
  const resolved = m ? targetsFor(m, byChannel) : [];
  for (const w of wanted) {
    const t = resolved.find((r) => r.uid === w.uid);
    if (!t) { unresolved.push(w.uid); continue; }
    EXAMPLES.push({
      uid: t.uid, stratum: w.stratum, sentence: t.sentence, context: t.context,
      contextChars: t.context.length, typos: w.typos, screens: w.screens,
    });
  }
}
EXAMPLES.sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
if (!EXAMPLES.length) die(`the sample is EMPTY after context resolution`);
for (const [name, list] of Object.entries(strata)) {
  if (!list.length) die(`stratum ${name} is EMPTY -- nothing in the corpus matched it`);
}

// ------------------------------------------------------------------ requests
/** Production trims with slice(-W). W=0 needs its own branch: "abc".slice(-0)
 *  is "abc", not "" -- the one place a zero window silently becomes a full one. */
function trimContext(ctx, W) { return W <= 0 ? "" : String(ctx).slice(-W); }

/**
 * One generation through the production request shape, reduced to its
 * EFFECTIVE-TARGET SIGNATURE. Uses background.js's shared sanitizer question
 * followed by the guards; `out` is the text the shipping path
 * would actually write (cleaned.trim()), which on the applied branch equals the
 * raw reply modulo whitespace by construction -- guardSentenceResult refuses
 * whenever the sanitizer would have had to change anything.
 */
async function generate(sentence, ctx) {
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
  const base = {
    ms: Date.now() - t0,
    promptTokens: data?.prompt_eval_count ?? null,
    evalTokens: data?.eval_count ?? null,
    contextChars: ctx.length,
  };
  const transport = (reason) => ({ ...base, signature: null, transport: reason });
  if (error) return transport(error);
  if (data.error) return transport(String(data.error));
  if (data.done_reason === "length") return transport("truncated");
  let rewritten;
  try { rewritten = JSON.parse(String(data.message?.content ?? "").trim())?.rewritten; }
  catch { return { ...base, signature: { applied: false, reason: "invalid-json" }, transport: null }; }
  if (typeof rewritten !== "string") {
    return { ...base, signature: { applied: false, reason: "no-rewritten-key" }, transport: null };
  }
  const cleaned = sanitizeSentenceOutput(sentence, rewritten);
  const refused = guardSentenceResult(sentence, rewritten, cleaned, {});
  const signature = refused
    ? { applied: false, reason: refused }
    : { applied: true, out: normalizeOut(cleaned.trim()) };
  return { ...base, signature, transport: null };
}

const sigKey = (s) => (s == null ? null
  : s.applied ? "A\0" + s.out : "R\0" + s.reason);

/** Modal signature: the key shared by >= 2 of the generations, else null. */
function modalOf(keys) {
  const counts = new Map();
  for (const k of keys) {
    if (k == null) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return bestN >= 2 ? best : null;
}

/** Wilson interval bounds at z (one-sided 95% by default). */
function wilson(successes, n, z = Z_95_ONE_SIDED) {
  if (!n) return { p: 0, lower: 0, upper: 1 };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    p,
    lower: Math.max(0, (centre - spread) / d),
    upper: Math.min(1, (centre + spread) / d),
  };
}
const wilsonUpper = (s, n, z) => wilson(s, n, z).upper;

/**
 * THE GOVERNING STATISTIC (plan §7 Phase 0.2, recorded amendment 2026-08-20).
 *
 * The predeclared raw rule counts every modal-signature change against the
 * window, including changes on examples whose context ALREADY fits inside W --
 * whose bytes at W and at the reference are identical. Those cannot be caused
 * by trimming; they are the teacher's own sampling nondeterminism, the same
 * noise floor the live owner-bench gate documents. Measured here they were 4 of
 * 6, 3 of 7 and 4 of 6 at W=375/500/750, and they do NOT shrink as the window
 * lengthens while the trimmed share does -- so the raw ladder fails at every
 * rung on a roughly constant noise floor, which is what makes this a
 * measurement correction rather than a rescue.
 *
 * So: split the arm at "was this example's context actually shortened",
 *   p_T = changed/trimmed, p_U = changed/untrimmed, q = trimmed share,
 *   A   = q * max(0, p_T - p_U)                       attributable rate
 *   U_A = q * max(0, U_delta)                         its upper bound,
 * where U_delta is the one-sided 95% Newcombe/Wilson bound on the difference,
 * d + sqrt((u1-p1)^2 + (p0-l0)^2), from the two Wilson intervals at z=1.645.
 * The limits are unchanged in form: N*A <= max AND U_A < ub.
 *
 * The RAW numbers stay reported permanently, and per-example DROPS keep the raw
 * rule: a cohort-level attribution cannot say which individual flip trimming
 * caused, so a change is dropped from training whether or not it was trimmed.
 */
function attributable({ changed, comparable, affected, affectedChanged }) {
  const trimmed = affected;
  const untrimmed = comparable - affected;
  const trimmedChanged = affectedChanged;
  const untrimmedChanged = changed - affectedChanged;
  const q = comparable ? trimmed / comparable : 0;
  const wT = wilson(trimmedChanged, trimmed);
  const wU = wilson(untrimmedChanged, untrimmed);
  const pT = trimmed ? trimmedChanged / trimmed : 0;
  const pU = untrimmed ? untrimmedChanged / untrimmed : 0;
  const uDelta = (pT - pU)
    + Math.sqrt((wT.upper - pT) ** 2 + (pU - wU.lower) ** 2);
  const A = q * Math.max(0, pT - pU);
  return {
    trimmed, untrimmed, trimmedChanged, untrimmedChanged,
    q, pT, pU, uDelta, A, uA: q * Math.max(0, uDelta),
  };
}

// -------------------------------------------------------------- artifact I/O
mkdirSync(OUT_DIR, { recursive: true });
const OUT_JSON = opts.out || process.env.PROOFER_RESULT_JSON
  || fileURLToPath(new URL("context-stability-probe.json", OUT_DIR));
const OUT_JSONL = opts.jsonl || OUT_JSON.replace(/\.json$/, "") + ".jsonl";

const keyOf = (r) => [r.uid, r.window, r.gen].join("|");
const done = new Map();
if (!opts.dryRun && !opts.fresh && existsSync(OUT_JSONL)) {
  for (const line of readFileSync(OUT_JSONL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      // A transport failure is NOT a result and must be retried on the next
      // run; caching it would let one outage freeze into the artifact.
      if (r.model === MODEL && !r.transport) done.set(keyOf(r), r);
    } catch { /* torn final line from a killed run */ }
  }
}

// ------------------------------------------------------------------ report
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const pctOf = (a, b) => (b ? (100 * a / b).toFixed(1) + "%" : "-");
const median = (a) => {
  const s = a.filter((x) => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

console.log(`\nTeacher-target stability under context trimming  (plan §7 Phase 0.2)`);
console.log("=".repeat(78));
console.log(`model      ${MODEL}   ${OLLAMA_URL}`);
console.log(`seed       ${SEED}${process.env.PROOFER_SEED ? "" : "  (default)"}`);
console.log(`corpus     ${msgs.length} messages -> ${inventory.length} sentence targets`);
console.log(`windows    ${opts.windows.join(", ")}   reference = ${REFERENCE_W}`);
console.log(`gens       ${GENS} per example per window, production options`);

console.log(`\nsample composition:`);
console.log(`  ${pad("stratum", 10)} ${lpad("asked", 6)} ${lpad("got", 5)}  `
  + `${lpad("medCtx", 7)} ${lpad("medLen", 7)}  screens`);
const screenTally = {};
for (const name of ["random", "screen", "hard"]) {
  const got = EXAMPLES.filter((e) => e.stratum === name);
  const sc = {};
  for (const e of got) for (const s of e.screens) sc[s] = (sc[s] || 0) + 1;
  screenTally[name] = sc;
  console.log(`  ${pad(name, 10)} ${lpad(opts.perStratum, 6)} ${lpad(got.length, 5)}  `
    + `${lpad(median(got.map((e) => e.contextChars)) ?? "-", 7)} `
    + `${lpad(median(got.map((e) => e.sentence.length)) ?? "-", 7)}  `
    + Object.entries(sc).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`).join(" "));
}
console.log(`  ${pad("TOTAL", 10)} ${lpad(opts.perStratum * 3, 6)} ${lpad(EXAMPLES.length, 5)}`
  + `${unresolved.length ? `   ${unresolved.length} uid(s) did not resolve to a context` : ""}`);
const noCtx = EXAMPLES.filter((e) => !e.contextChars).length;
console.log(`  ${noCtx} example(s) have NO prior context at all -- trimming cannot move them,`);
console.log(`    so they are a built-in negative control on the change rate.`);

const arms = Object.fromEntries(Object.entries(THRESHOLDS).map(([name, t]) =>
  [name, EXAMPLES.filter((e) => t.strata.includes(e.stratum))]));
console.log(`\narms:  ` + Object.entries(arms)
  .map(([n, l]) => `${n} n=${l.length} (<=${THRESHOLDS[n].max} changes, `
    + `UB < ${(THRESHOLDS[n].ub * 100).toFixed(0)}%)`).join("   "));

console.log(`\nexamples whose context each window actually TRIMS (the rest are sent the`);
console.log(`same bytes at that window and at ${REFERENCE_W}, so they cannot move):`);
for (const W of opts.windows) {
  if (W === REFERENCE_W) { console.log(`  W=${lpad(W, 5)}   reference`); continue; }
  const line = Object.entries(arms).map(([n, list]) => {
    const hit = list.filter((e) => Math.min(e.contextChars, REFERENCE_W) > W).length;
    return `${n} ${hit}/${list.length} (${pctOf(hit, list.length)})`;
  }).join("   ");
  console.log(`  W=${lpad(W, 5)}   ${line}`);
}

const requests = EXAMPLES.length * opts.windows.length * GENS;
console.log(`\nrequests: ${requests} total`
  + `${done.size ? `, ${done.size} already recorded in ${OUT_JSONL.split("/").pop()}` : ""}`);
console.log(`artifact: ${OUT_JSON}`);
console.log(`rows:     ${OUT_JSONL}`);

if (opts.dryRun) {
  console.log(`\n--dry-run: assembled the sample, made zero model calls.\n`);
  process.exit(0);
}

// --------------------------------------------------------------------- run
console.log(`\nrunning (serialized -- one request at a time, it is one GPU)\n`);
const t0 = Date.now();
let fresh = 0, transportFails = 0;
const sigs = new Map();      // uid|window -> [key, key, key]
const timing = new Map();    // window -> {ms:[], promptTokens:[]}
for (const W of opts.windows) timing.set(W, { ms: [], promptTokens: [] });

for (const W of opts.windows) {
  for (const e of EXAMPLES) {
    const keys = [];
    for (let gen = 0; gen < GENS; gen++) {
      const k = keyOf({ uid: e.uid, window: W, gen });
      let row = done.get(k);
      if (!row) {
        const r = await generate(e.sentence, trimContext(e.context, W));
        row = {
          model: MODEL, uid: e.uid, stratum: e.stratum, window: W, gen,
          sentence: e.sentence, contextChars: r.contextChars,
          signature: r.signature, transport: r.transport,
          ms: r.ms, promptTokens: r.promptTokens, evalTokens: r.evalTokens,
        };
        appendFileSync(OUT_JSONL, JSON.stringify(row) + "\n");
        if (!row.transport) done.set(k, row);
        else transportFails++;
        if (++fresh % 50 === 0) process.stderr.write(`  ${fresh} new generations\n`);
      }
      keys.push(sigKey(row.signature));
      timing.get(W).ms.push(row.ms);
      timing.get(W).promptTokens.push(row.promptTokens);
    }
    sigs.set(`${e.uid}|${W}`, keys);
  }
}
const elapsedMs = Date.now() - t0;

// ------------------------------------------------------------------ scoring
const modal = new Map();     // uid|window -> key or null (unstable)
for (const [k, keys] of sigs) modal.set(k, modalOf(keys));

const perWindow = [];
for (const W of opts.windows) {
  const cell = { window: W, reference: W === REFERENCE_W, arms: {}, unstable: {}, changedUids: {} };
  for (const [name, list] of Object.entries(arms)) {
    let changed = 0, comparable = 0, unstableHere = 0, unstableRef = 0;
    let affected = 0, affectedChanged = 0;
    const changedUids = [];
    for (const e of list) {
      const here = modal.get(`${e.uid}|${W}`);
      const ref = modal.get(`${e.uid}|${REFERENCE_W}`);
      if (here == null) unstableHere++;
      if (ref == null) unstableRef++;
      if (here == null || ref == null) continue;
      comparable++;
      // An example whose whole context already fits inside W is sent the SAME
      // bytes at both windows and cannot move. It still belongs in the
      // denominator -- the threshold is about the deployed mixture, and most
      // real contexts are short -- but a rate reported without this count reads
      // as stability when it may be mostly "nothing was trimmed".
      const trimmed = Math.min(e.contextChars, REFERENCE_W) > W;
      if (trimmed) affected++;
      if (here !== ref) {
        changed++;
        changedUids.push(e.uid);
        if (trimmed) affectedChanged++;
      }
    }
    const ub = wilsonUpper(changed, comparable);
    const t = THRESHOLDS[name];
    const att = attributable({ changed, comparable, affected, affectedChanged });
    // N is the COMPARABLE count, the denominator A is a rate over -- not the
    // nominal arm size, which includes examples with no modal signature.
    const NA = comparable * att.A;
    cell.arms[name] = {
      n: list.length, comparable, changed, rate: comparable ? changed / comparable : null,
      affected, affectedChanged,
      affectedRate: affected ? affectedChanged / affected : null,
      ub, maxAllowed: t.max, ubThreshold: t.ub,
      pass: changed <= t.max && ub < t.ub,
      amended: { ...att, N: comparable, NA, pass: NA <= t.max && att.uA < t.ub },
    };
    cell.unstable[name] = { atWindow: unstableHere, atReference: unstableRef };
    cell.changedUids[name] = changedUids;
  }
  cell.medianMs = median(timing.get(W).ms);
  cell.medianPromptTokens = median(timing.get(W).promptTokens);
  perWindow.push(cell);
}

console.log(`\n` + "=".repeat(78));
console.log(`RESULT   ${MODEL}   modal-signature change vs W=${REFERENCE_W}`);
console.log("=".repeat(78));
console.log(`\n[1] RAW predeclared rule -- reported permanently, no longer governing:`);
console.log(`  ${lpad("W", 6)}  ${pad("ordinary  chg/cmp   UB", 26)}`
  + `${pad("hard      chg/cmp   UB", 26)}  ${lpad("promptTok", 9)} ${lpad("medMs", 6)}`);
for (const c of perWindow) {
  const col = (name) => {
    const a = c.arms[name];
    return pad(`${lpad(`${a.changed}/${a.comparable}`, 8)}  `
      + `${lpad((100 * a.ub).toFixed(1) + "%", 6)}  ${a.pass ? "pass" : "FAIL"}`, 26);
  };
  console.log(`  ${lpad(c.window, 6)}  ${c.reference ? pad("(reference)", 52) : col("ordinary") + col("hard")}`
    + `  ${lpad(c.medianPromptTokens ?? "-", 9)} ${lpad(c.medianMs ?? "-", 6)}`);
}

console.log(`\nhow many of those examples were actually TRIMMED at that window (a context`);
console.log(`already shorter than W is sent the same bytes and cannot move):`);
console.log(`  ${lpad("W", 6)}  ${lpad("ordinary", 14)} ${lpad("hard", 14)}`);
for (const c of perWindow) {
  if (c.reference) continue;
  const col = (n) => {
    const a = c.arms[n];
    return lpad(`${a.affectedChanged}/${a.affected}  ${pctOf(a.affected, a.comparable)}`, 14);
  };
  console.log(`  ${lpad(c.window, 6)}  ${col("ordinary")} ${col("hard")}`
    + `   <- changed/trimmed, share of arm trimmed`);
}

console.log(`\n[2] GOVERNING -- plan §7 Phase 0.2 recorded amendment 2026-08-20.`);
console.log(`    Trim-ATTRIBUTABLE change rate. p_T = changed/trimmed, p_U = changed/`);
console.log(`    untrimmed (byte-identical inputs at W and ${REFERENCE_W}, so the model's own`);
console.log(`    sampling noise), q = trimmed share, A = q*max(0, p_T-p_U), U_A = q*max(0,`);
console.log(`    U_delta) with U_delta the one-sided 95% Newcombe/Wilson bound on p_T-p_U.`);
for (const [name, t] of Object.entries(THRESHOLDS)) {
  console.log(`\n    ${name} arm  (gate: N*A <= ${t.max} AND U_A < ${(100 * t.ub).toFixed(0)}%)`);
  console.log(`  ${lpad("W", 6)}  ${lpad("trim", 9)} ${lpad("untrim", 9)}  ${lpad("p_T", 7)} `
    + `${lpad("p_U", 7)}  ${lpad("q", 6)}  ${lpad("A", 6)} ${lpad("N*A", 6)} ${lpad("U_A", 7)}  verdict`);
  for (const c of perWindow) {
    if (c.reference) { console.log(`  ${lpad(c.window, 6)}  (reference)`); continue; }
    const a = c.arms[name], m = a.amended;
    console.log(`  ${lpad(c.window, 6)}  ${lpad(`${m.trimmedChanged}/${m.trimmed}`, 9)} `
      + `${lpad(`${m.untrimmedChanged}/${m.untrimmed}`, 9)}  `
      + `${lpad((100 * m.pT).toFixed(2) + "%", 7)} ${lpad((100 * m.pU).toFixed(2) + "%", 7)}  `
      + `${lpad(m.q.toFixed(3), 6)}  ${lpad((100 * m.A).toFixed(2) + "%", 6)} `
      + `${lpad(m.NA.toFixed(2), 6)} ${lpad((100 * m.uA).toFixed(2) + "%", 7)}  `
      + `${m.pass ? "PASS" : "MOVE-LONGER"}`);
  }
}

console.log(`\nintrinsic instability (no >=2/3 modal signature at that window -- excluded`);
console.log(`from the comparison; the model disagreeing with itself is not a window effect):`);
console.log(`  ${lpad("W", 6)}  ${lpad("ordinary", 10)} ${lpad("hard", 8)}`);
for (const c of perWindow) {
  console.log(`  ${lpad(c.window, 6)}  `
    + `${lpad(`${c.unstable.ordinary.atWindow}/${c.arms.ordinary.n}`, 10)} `
    + `${lpad(`${c.unstable.hard.atWindow}/${c.arms.hard.n}`, 8)}`);
}

console.log(`\n` + "-".repeat(78));
for (const c of perWindow) {
  if (c.reference) { console.log(`  W=${c.window}   REFERENCE`); continue; }
  const gov = c.arms.ordinary.amended.pass && c.arms.hard.amended.pass;
  const raw = c.arms.ordinary.pass && c.arms.hard.pass;
  const why = Object.entries(c.arms).filter(([, a]) => !a.amended.pass).map(([n, a]) => {
    const bad = [];
    if (a.amended.NA > a.maxAllowed) {
      bad.push(`N*A ${a.amended.NA.toFixed(2)} > ${a.maxAllowed}`);
    }
    if (a.amended.uA >= a.ubThreshold) {
      bad.push(`U_A ${(100 * a.amended.uA).toFixed(2)}% >= ${(100 * a.ubThreshold).toFixed(0)}%`);
    }
    return `${n}: ${bad.join(" and ")}`;
  }).join("; ");
  console.log(`  W=${c.window}   GOVERNING ${gov ? "PASS -- no trim-attributable instability"
    : `MOVE-TO-NEXT-LONGER-WINDOW: ${why}`}`
    + `   [raw rule: ${raw ? "pass" : "FAIL"}]`);
}
console.log("-".repeat(78));
console.log(`  ${fresh} new generations, ${transportFails} transport failures`
  + ` (not cached; rerun to retry), ${Math.round(elapsedMs / 1000)}s`);

// ------------------------------------------------------------------- drops
// The list this probe exists to produce (plan §7 Phase 0.2): every example
// whose teacher target is not trustworthy at W, to be excluded from training.
// It keeps the RAW per-example rule on purpose -- the cohort-level attribution
// above says how much instability trimming CAUSED, and cannot say WHICH flip it
// caused, so a changed example is dropped whether or not it was trimmed.
if (opts.drops != null) {
  const W = opts.drops;
  const drops = [];
  for (const e of EXAMPLES) {
    const here = modal.get(`${e.uid}|${W}`);
    const ref = modal.get(`${e.uid}|${REFERENCE_W}`);
    const reasons = [];
    if (here == null) reasons.push("intrinsically-unstable-at-window");
    if (ref == null) reasons.push("intrinsically-unstable-at-reference");
    if (here != null && ref != null && here !== ref) reasons.push("modal-target-changed");
    if (!reasons.length) continue;
    drops.push({
      uid: e.uid, stratum: e.stratum, reasons,
      trimmed: Math.min(e.contextChars, REFERENCE_W) > W,
      contextChars: e.contextChars,
    });
  }
  const path = fileURLToPath(new URL(`context-stability-drops-W${W}.json`, OUT_DIR));
  writeFileSync(path, JSON.stringify({
    generated: "context-stability-drops",
    at: new Date().toISOString(),
    model: MODEL, seed: SEED, gens: GENS, window: W, referenceWindow: REFERENCE_W,
    rule: "RAW per-example: modal(W) != modal(reference), trimmed or not, plus "
      + "intrinsic instability at either window",
    considered: EXAMPLES.length, dropped: drops.length,
    byReason: drops.reduce((acc, d) => {
      for (const r of d.reasons) acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {}),
    byStratum: drops.reduce((acc, d) => (acc[d.stratum] = (acc[d.stratum] || 0) + 1, acc), {}),
    drops,
  }, null, 2));
  console.log(`\n  drop list W=${W}: ${drops.length}/${EXAMPLES.length} examples`
    + ` (${pctOf(drops.length, EXAMPLES.length)}) -> ${path}`);
}

writeFileSync(OUT_JSON, JSON.stringify({
  generated: "context-stability-probe",
  at: new Date().toISOString(),
  model: MODEL, ollamaUrl: OLLAMA_URL,
  seed: SEED, gens: GENS, windows: opts.windows, referenceWindow: REFERENCE_W,
  // BOTH rulesets, labelled. perWindow[].arms[].{changed,ub,pass} is the raw
  // rule; perWindow[].arms[].amended.{A,NA,uA,pass} is the governing one.
  rulesets: {
    raw: {
      status: "predeclared; reported permanently; NO LONGER GOVERNING",
      statistic: "modal(W) != modal(reference), over all comparable examples",
      gate: "changed <= max AND one-sided 95% Wilson UB < ub",
      fields: ["changed", "comparable", "ub", "pass"],
      thresholds: THRESHOLDS,
    },
    amended: {
      status: "GOVERNING -- plan §7 Phase 0.2 recorded amendment 2026-08-20 "
        + "(GPT-5.6 Sol audit)",
      statistic: "trim-attributable change rate A = q*max(0, p_T - p_U)",
      bound: "U_A = q*max(0, U_delta); U_delta = d + sqrt((u1-p1)^2 + (p0-l0)^2) "
        + "from one-sided 95% Wilson intervals (z=1.645)",
      gate: "N*A <= max AND U_A < ub, N = comparable",
      fields: ["amended.pT", "amended.pU", "amended.q", "amended.A", "amended.NA",
        "amended.uA", "amended.pass"],
      thresholds: THRESHOLDS,
    },
    drops: {
      status: "per-example exclusion list uses the RAW rule",
      why: "cohort-level attribution cannot say which individual flip trimming caused",
    },
  },
  thresholds: THRESHOLDS,
  corpus: { messages: msgs.length, inventory: inventory.length, csv: CSV },
  sample: {
    perStratum: opts.perStratum, total: EXAMPLES.length,
    byStratum: Object.fromEntries(["random", "screen", "hard"].map((n) =>
      [n, EXAMPLES.filter((e) => e.stratum === n).length])),
    screens: screenTally, unresolved, noContext: noCtx,
    uids: EXAMPLES.map((e) => ({
      uid: e.uid, stratum: e.stratum, screens: e.screens,
      contextChars: e.contextChars, sentenceChars: e.sentence.length,
    })),
  },
  perWindow,
  transportFailures: transportFails,
}, null, 2));
console.log(`  artifact: ${OUT_JSON}\n`);
