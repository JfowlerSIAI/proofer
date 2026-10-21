#!/usr/bin/env node
// The teacher batch runner — first stage of the Phase 1/2 generator (§7), and
// the instrument behind judge calibration (§4) and the context-length
// experiment (Phase 0.2).
//
//   node teacher-pass.mjs --in <candidates.jsonl> --out <results.jsonl> [flags]
//   node teacher-pass.mjs --in <candidates.jsonl> --dry-run     # no model call
//
// Input jsonl, one object per line:
//   {uid, sentence, context}   plus any other fields, which pass through
//                              untouched onto the output row under `passthrough`
//
// Output jsonl, one row per input:
//   {uid, sentence, context_window, model, options, raw, malformed,
//    rewritten|null, guard, outcome, prompt_eval_count, eval_count, timings,
//    error, passthrough}
//
// WHAT MAKES THIS THE SHIPPING PATH RATHER THAN A LOOKALIKE
//
// The request is built by `prepareSentenceRequest` read out of background.js
// through test/lib/sentence-guards.mjs — the same import the owner-bench uses,
// so a run here is comparable to the recorded bench-*-qwen38-27b artifacts
// rather than merely similar to them. Model, URL and sampling overrides come
// from test/lib/harness.mjs (PROOFER_MODEL / PROOFER_OLLAMA_URL /
// PROOFER_OPTIONS), and PROOFER_OPTIONS is applied over the request's OWN
// options exactly as sentence-owner-bench.mjs applies it — not merged from the
// harness's BASE_OPTIONS, which would silently substitute the manual path's
// defaults for the sentence path's.
//
// The 2500-char context trim is done HERE, explicitly, because in production it
// happens in the worker's message handler (background.js slices to
// SENTENCE_CONTEXT_CHARS) and NOT inside `prepareSentenceRequest`. A runner that
// forgot it would send unbounded context and quietly measure a prompt the
// extension cannot produce. `--window` varies it, which is the whole point of
// the Phase 0.2 experiment; the default is the shipping value, asserted below
// against the constant rather than typed twice.
//
// GUARDS ARE RUN HERE, ONCE. Every consumer downstream (the judge sampler, the
// mixture assembler, the calibration stratifier) needs to know whether the
// shipping guard chain would have applied each output. Deriving that in three
// places is three chances to derive it differently; the row carries it.
//
// GPU DISCIPLINE. Model runs are the owner's to schedule (R10: never concurrent
// with a bench run, and the 27B must not be loaded while the system daemon
// holds the 9B). `--dry-run` assembles and prints two requests and exits
// without opening a socket, which is the only mode an agent should run.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  prepareSentenceRequest, guardSentenceResult, SENTENCE_CONTEXT_CHARS,
} from "../lib/sentence-guards.mjs";
import { MODEL, OLLAMA_URL } from "../lib/harness.mjs";
import { readJsonl, readJsonlIfPresent, appendSink, argOf, hasFlag, fail } from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");

const IN = argOf("--in");
const OUT = argOf("--out", path.join(ART, "teacher-results.jsonl"));
const CONC = Number(argOf("--concurrency", "3"));
const WINDOW = Number(argOf("--window", String(SENTENCE_CONTEXT_CHARS)));
const LIMIT = argOf("--limit") ? Number(argOf("--limit")) : Infinity;
const DRY = hasFlag("--dry-run");
const FORCE = hasFlag("--force");
const HOSTNAME = argOf("--hostname", "discord.com");
// --timeout-ms: override the shipping SENTENCE_TIMEOUT_MS for models that
// cannot meet it (2026-08-24: base LFM2.5 under Ollama 0.32.6 reasons
// invisibly before its JSON — format:"json" no longer suppresses it — so a
// reference run needs headroom the extension deliberately does not grant).
const TIMEOUT_OVERRIDE = argOf("--timeout-ms") ? Number(argOf("--timeout-ms")) : null;
// --prompt sentinel: replace the shipping messages with the §5 TRAINING shape
// (pilot_format.py's build_messages, byte-identical by construction below) —
// the fixed task sentinel in the system turn plus the context as a
// prior_context line, no few-shot, no context demonstration, no page-context
// line. Everything else (options, format, keep_alive, num_ctx, timeout) stays
// the shipping request, because the question this mode exists to answer is
// "should the EXTENSION serve the fine-tuned model its training prompt"
// (plan §Phase 6), and a candidate serving config keeps the transport as-is.
const PROMPT = argOf("--prompt", "shipping");
if (PROMPT !== "shipping" && PROMPT !== "sentinel")
  fail(`--prompt must be "shipping" or "sentinel", got ${JSON.stringify(PROMPT)}`);
// --strip-context-shot: the shipping prompt with SENTENCE_CONTEXT_SHOT's three
// turns removed — the ablation that asks whether the LFM-tuned demonstration
// still earns its place for a non-/qwen/i model. In buildSentenceMessages the
// shot is the one message group besides messages[0] whose first turn is a
// SYSTEM turn (its contextTurn), inserted at index 1 when prior context
// exists; the assertion below fails loudly if that shape ever changes.
const STRIP_SHOT = hasFlag("--strip-context-shot");
if (STRIP_SHOT && PROMPT !== "shipping") fail("--strip-context-shot only applies to --prompt shipping");
// Must match pilot_format.py SYSTEM_SENTINEL verbatim — the training-time
// system turn. JSON.stringify and python's json.dumps(ensure_ascii=False)
// agree on everything the corpus contains (both escape quotes, backslashes
// and control chars identically; JS additionally escapes U+2028/U+2029,
// which the corpus does not contain).
const SENTINEL_SYSTEM =
  'Proofread. Reply {"rewritten": "..."} with the corrected sentence, or the input verbatim if clean.';

// PROOFER_OPTIONS applied the way the bench applies it: over the sentence
// path's own options, not over the manual path's defaults.
const OPT_OVERRIDE = (() => {
  if (!process.env.PROOFER_OPTIONS) return {};
  try {
    const o = JSON.parse(process.env.PROOFER_OPTIONS);
    if (!o || typeof o !== "object" || Array.isArray(o)) fail("PROOFER_OPTIONS must be a JSON object");
    return o;
  } catch (e) { fail(`PROOFER_OPTIONS is not valid JSON: ${e.message}`); }
})();

if (!IN) {
  fail("--in <candidates.jsonl> is required.\n" +
       "  node teacher-pass.mjs --in <file> [--out <file>] [--concurrency 3] [--window 2500]\n" +
       "    [--prompt shipping|sentinel] [--strip-context-shot] [--timeout-ms N] [--dry-run]\n" +
       "  Input rows are {uid, sentence, context}; every other field passes through.");
}
if (!Number.isInteger(CONC) || CONC < 1) fail(`--concurrency must be a positive integer, got ${argOf("--concurrency")}`);
if (!Number.isFinite(WINDOW) || WINDOW < 0) fail(`--window must be a non-negative number, got ${argOf("--window")}`);

// ------------------------------------------------------------------ load

const raw = readJsonl(IN, "candidates");
const done = new Set();
if (!FORCE) for (const r of readJsonlIfPresent(OUT)) if (r && r.uid) done.add(r.uid);

const work = [];
let malformedIn = 0, resumed = 0, dupUids = 0;
const seen = new Set();
for (const r of raw) {
  if (work.length >= LIMIT) break;
  if (!r || typeof r.uid !== "string" || typeof r.sentence !== "string" || !r.sentence.trim()) {
    malformedIn++;
    continue;
  }
  if (seen.has(r.uid)) { dupUids++; continue; }
  seen.add(r.uid);
  if (done.has(r.uid)) { resumed++; continue; }
  const { uid, sentence, context, ...rest } = r;
  work.push({
    uid, sentence,
    // The trim production performs in the worker, made explicit and tunable.
    context_window: String(context || "").slice(-WINDOW),
    passthrough: Object.keys(rest).length ? rest : undefined,
  });
}

console.log("\nTeacher pass");
console.log("=".repeat(72));
console.log(`  model            ${MODEL}`);
console.log(`  ollama           ${OLLAMA_URL}`);
console.log(`  context window   ${WINDOW}${WINDOW === SENTENCE_CONTEXT_CHARS ? "  (shipping SENTENCE_CONTEXT_CHARS)" : "  *** NOT the shipping value ***"}`);
console.log(`  concurrency      ${CONC}`);
console.log(`  prompt           ${PROMPT}${PROMPT === "shipping" ? "  (prepareSentenceRequest, the extension's request)" : "  *** the §5 TRAINING shape, not what the extension sends today ***"}`);
console.log(`  options override ${Object.keys(OPT_OVERRIDE).length ? JSON.stringify(OPT_OVERRIDE) : "(none)"}`);
console.log(`  input            ${IN}   (${raw.length} rows)`);
console.log(`  output           ${OUT}`);
console.log(`  to run           ${work.length}   resumed ${resumed}${FORCE ? "  (--force: re-running)" : ""}`);
if (malformedIn) console.log(`  MALFORMED INPUT  ${malformedIn} row(s) lacked uid/sentence and were not run`);
if (dupUids) console.log(`  DUPLICATE UIDS   ${dupUids} row(s) repeated a uid already seen and were dropped`);

if (!work.length) {
  console.log(`\nNothing to run. (An empty pass is not a completed pass — check --in, --limit and --force.)`);
  process.exit(raw.length ? 0 : 1);
}

const buildRequest = (item) => {
  const req = prepareSentenceRequest(
    item.sentence, item.context_window, { hostname: HOSTNAME }, { ollamaModel: MODEL });
  Object.assign(req.body.options, OPT_OVERRIDE);
  if (PROMPT === "sentinel") {
    let system = SENTINEL_SYSTEM;
    if (item.context_window)
      system += "\n\nprior_context: " + JSON.stringify(String(item.context_window));
    req.body.messages = [
      { role: "system", content: system },
      { role: "user", content: item.sentence },
    ];
  }
  if (STRIP_SHOT && item.context_window) {
    const m = req.body.messages;
    if (m[1]?.role !== "system" || m[2]?.role !== "user" || m[3]?.role !== "assistant")
      fail("--strip-context-shot: messages[1..3] are not the [system,user,assistant] shot group " +
           "this flag expects — buildSentenceMessages changed shape; update the flag before trusting it");
    m.splice(1, 3);
  }
  return req;
};

// --------------------------------------------------------------- dry run

if (DRY) {
  console.log(`\n--dry-run: assembling 2 requests. NO model is contacted; GPU runs are the owner's to schedule (R10).`);
  for (const item of work.slice(0, 2)) {
    const req = buildRequest(item);
    console.log("\n" + "-".repeat(72));
    console.log(`uid              ${item.uid}`);
    console.log(`sentence         ${JSON.stringify(item.sentence)}`);
    console.log(`context_window   ${item.context_window.length} chars` +
                (item.context_window ? `, tail: ${JSON.stringify(item.context_window.slice(-70))}` : " (empty)"));
    console.log(`POST             ${OLLAMA_URL}/api/chat`);
    console.log(`body.model       ${req.body.model}`);
    console.log(`body.format      ${req.body.format}   think=${req.body.think}   stream=${req.body.stream}`);
    console.log(`body.keep_alive  ${req.body.keep_alive}   timeoutMs=${req.timeoutMs}`);
    console.log(`body.options     ${JSON.stringify(req.body.options)}`);
    console.log(`messages         ${req.body.messages.length} turns  ` +
                `[${req.body.messages.map((m) => m.role).join(", ")}]`);
    console.log(`  system turn    ${req.body.messages[0].content.length} chars`);
    console.log(`  final user     ${JSON.stringify(req.body.messages[req.body.messages.length - 1].content)}`);
  }
  console.log("\n" + "-".repeat(72));
  console.log(`Would run ${work.length} request(s) at concurrency ${CONC}. Re-run without --dry-run to execute.`);
  process.exit(0);
}

// ----------------------------------------------------------------- execute

// A pass that silently produces nothing because the daemon is down is the
// documented harness sin. One probe up front, named.
try {
  const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) fail(`${OLLAMA_URL}/api/tags returned ${res.status}. Is the right Ollama serving?`);
  const tags = (await res.json()).models || [];
  if (!tags.some((m) => m && (m.name === MODEL || m.model === MODEL))) {
    fail(`${MODEL} is not installed at ${OLLAMA_URL}.\n` +
         `  installed: ${tags.map((m) => m.name || m.model).join(", ") || "(none)"}\n` +
         `  The teacher (qwen3.8:27b) serves from the system Ollama on 127.0.0.1:11434 (§12).`);
  }
} catch (e) {
  if (e && e.__proofer_failed) throw e;
  fail(`cannot reach Ollama at ${OLLAMA_URL}: ${e.message}\n` +
       `  §12: the teacher runs on the system Ollama at 127.0.0.1:11434 (the harness default).`);
}

const sink = appendSink(OUT);
const t0 = Date.now();
let next = 0, completed = 0;
const counts = { applied: 0, refused: 0, "no-op": 0, error: 0 };

async function runOne(item) {
  const req = buildRequest(item);
  const started = Date.now();
  let data = null, error = null, rawContent = null, rewritten = null, malformed = false;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(TIMEOUT_OVERRIDE ?? req.timeoutMs),
    });
    data = await res.json();
  } catch (e) {
    error = String(e.message || e);
  }
  const wall_ms = Date.now() - started;

  if (!error) {
    rawContent = String(data?.message?.content ?? "");
    if (data.error) error = String(data.error);
    else if (data.done_reason === "length") { error = "truncated"; malformed = true; }
    else {
      // Malformed means the OUTPUT CONTRACT was broken (§4's malformed-output
      // metric), which is a different failure from a guard refusal and is
      // counted separately on purpose.
      try {
        const p = JSON.parse(rawContent.trim());
        if (typeof p?.rewritten === "string") rewritten = p.rewritten;
        else { error = "no-rewritten-key"; malformed = true; }
      } catch { error = "bad-json"; malformed = true; }
    }
  }

  let guard = null, outcome;
  if (error) outcome = "error";
  else if (rewritten.trim() === item.sentence.trim()) { outcome = "no-op"; guard = "applied"; }
  else {
    const verdict = guardSentenceResult(item.sentence, rewritten, rewritten);
    guard = verdict === null ? "applied" : verdict;
    outcome = verdict === null ? "applied" : "refused";
  }
  counts[outcome]++;

  return {
    uid: item.uid,
    sentence: item.sentence,
    context_window: item.context_window,
    model: MODEL,
    options: req.body.options,
    raw: rawContent,
    malformed,
    rewritten,
    guard,
    outcome,
    prompt_eval_count: data?.prompt_eval_count ?? null,
    eval_count: data?.eval_count ?? null,
    timings: {
      wall_ms,
      total_duration: data?.total_duration ?? null,
      load_duration: data?.load_duration ?? null,
      prompt_eval_duration: data?.prompt_eval_duration ?? null,
      eval_duration: data?.eval_duration ?? null,
    },
    error,
    ...(item.passthrough ? { passthrough: item.passthrough } : {}),
    ts: new Date().toISOString(),
  };
}

await Promise.all(Array.from({ length: Math.min(CONC, work.length) }, async () => {
  while (next < work.length) {
    const row = await runOne(work[next++]);
    sink.write(row);                       // append as they land: a crash keeps the work
    if (++completed % 25 === 0 || completed === work.length) {
      const rate = completed / ((Date.now() - t0) / 1000);
      process.stderr.write(`  ${completed}/${work.length}  ${rate.toFixed(2)}/s  ` +
        `applied ${counts.applied} refused ${counts.refused} no-op ${counts["no-op"]} error ${counts.error}\n`);
    }
  }
}));
sink.close();

const secs = (Date.now() - t0) / 1000;
console.log("\n" + "=".repeat(72));
console.log(`  ran              ${work.length} in ${secs.toFixed(1)}s   (${(work.length / secs).toFixed(2)}/s at conc ${CONC})`);
console.log(`  applied          ${counts.applied}`);
console.log(`  refused          ${counts.refused}`);
console.log(`  no-op            ${counts["no-op"]}`);
console.log(`  error            ${counts.error}`);
console.log(`  written to       ${OUT}`);
// An all-error pass returns rows and means nothing; it must not exit 0.
if (counts.error === work.length) {
  console.log(`\n  EVERY request errored. This is a failed pass, not a completed one.`);
  process.exit(1);
}
