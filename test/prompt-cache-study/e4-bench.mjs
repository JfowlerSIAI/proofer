#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. E4 of the 2026-09-24 prompt-cache study: the frozen
// benchmark run once per candidate layout on the current pilot
// (proofer-pilot-q4:v1), through a PRIVATE Ollama on the GPU.
//
// It is teacher-pass.mjs (test/finetune/teacher-pass.mjs) with only the
// request's `messages` swapped for the layout's -- same input file
// (benchmark-run-input.jsonl), same hostname (discord.com), same 2,500-char
// context trim for L0-L2, same options, same malformed/guard/outcome logic
// (guardSentenceResult(sentence, rewritten, rewritten)), same output row
// schema, so test/finetune/benchrun-to-runfile.mjs and benchmark-score.mjs
// consume its rows unchanged. The inherited limits of that screen are the
// plan's: raw output is passed as both raw and sanitized (so
// `sanitizer-would-change` never fires), no trigger, no retry, and the
// transport timeout instead of the 4.75 s delivery deadline. It RANKS layouts;
// it cannot clear one to ship.
//
// Context per layout:
//   L0, L1*, L2*   the item's context, last 2,500 characters (as teacher-pass)
//   L3-*           l3ContextFor(context): the 500-character jump window the
//                  item would have had if its context had been typed in order
//   L4-conv, L2-conv  the same L3 window, split into sentences, one user turn each
//
//   node e4-bench.mjs --layout L1p-post --port 11558 --out <benchrun.jsonl> [--concurrency 2] [--limit N]
//        [--model <tag>]   another model (default: the pilot, layouts.mjs MODEL) -- the
//                          2026-10-02 L2-conv training trial runs its retrained arms here

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { layoutBody, LAYOUTS, MODEL as PILOT, usesL3Window, isConv } from "./layouts.mjs";
import { guardSentenceResult, SENTENCE_CONTEXT_CHARS } from "../lib/sentence-guards.mjs";
import { l3ContextFor, sentencesOf } from "./context-policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const LAYOUT = arg("--layout");
const PORT = Number(arg("--port"));
const OUT = arg("--out");
const { FT } = await import("./paths.mjs");
const IN = arg("--in", `${FT}/benchmark-run-input.jsonl`);
const CONC = Number(arg("--concurrency", "2"));
const MODEL = arg("--model", PILOT);
const LIMIT = arg("--limit") ? Number(arg("--limit")) : Infinity;
const HOSTNAME = "discord.com";
if (!LAYOUTS.includes(LAYOUT) || !PORT || !OUT) { console.error("usage: --layout <L> --port <p> --out <f>"); process.exit(2); }
if (PORT === 11434) { console.error("refusing the owner's live Ollama"); process.exit(2); }
const URL_ = `http://127.0.0.1:${PORT}`;

const rows = fs.readFileSync(IN, "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(0, LIMIT);
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const l of fs.readFileSync(OUT, "utf8").split("\n")) if (l.trim()) done.add(JSON.parse(l).uid);
} else {
  fs.writeFileSync(OUT, "", { mode: 0o600 });
}
const work = rows.filter((r) => !done.has(r.uid));
console.log(`E4 ${LAYOUT}: ${work.length} to run (${done.size} resumed) -> ${OUT}`);

function build(item) {
  const ctx2500 = String(item.context || "").slice(-SENTENCE_CONTEXT_CHARS);
  const priorContext = usesL3Window(LAYOUT) ? l3ContextFor(item.context || "") : ctx2500;
  const body = layoutBody(LAYOUT, {
    sentence: item.sentence, priorContext,
    contextSentences: isConv(LAYOUT) ? sentencesOf(priorContext) : null,
    pageContext: { hostname: HOSTNAME }, model: MODEL,
  });
  // Residency only (not a load-time option): keep the runner up between
  // layouts instead of the sentence path's 20 s lease.
  body.keep_alive = "30m";
  return { body, context_window: priorContext };
}

// Load the runner once, alone, before any timed request: two requests racing a
// cold CUDA load both waited ~16 s and hit the 20 s timeout in the smoke test.
{
  const warm = build(rows[0]).body;
  const res = await fetch(`${URL_}/api/chat`, { method: "POST", body: JSON.stringify({ ...warm, messages: [] }), signal: AbortSignal.timeout(120000) });
  await res.json();
}

async function runOne(item) {
  const { body, context_window } = build(item);
  const started = Date.now();
  let data = null, error = null, rawContent = null, rewritten = null, malformed = false;
  try {
    const res = await fetch(`${URL_}/api/chat`, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    data = await res.json();
  } catch (e) { error = String(e.message || e); }
  const wall_ms = Date.now() - started;
  if (!error) {
    rawContent = String(data?.message?.content ?? "");
    if (data.error) error = String(data.error);
    else if (data.done_reason === "length") { error = "truncated"; malformed = true; }
    else {
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
  return {
    uid: item.uid, sentence: item.sentence, context_window, layout: LAYOUT, model: MODEL,
    options: body.options, raw: rawContent, malformed, rewritten, guard, outcome,
    prompt_eval_count: data?.prompt_eval_count ?? null, eval_count: data?.eval_count ?? null,
    timings: { wall_ms, prompt_eval_duration: data?.prompt_eval_duration ?? null, eval_duration: data?.eval_duration ?? null },
    error, ts: new Date().toISOString(),
  };
}

const counts = { applied: 0, refused: 0, "no-op": 0, error: 0 };
let next = 0, completed = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(CONC, work.length) }, async () => {
  while (next < work.length) {
    const row = await runOne(work[next++]);
    fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
    counts[row.outcome]++;
    if (++completed % 100 === 0 || completed === work.length)
      process.stderr.write(`  ${LAYOUT} ${completed}/${work.length} ${(completed / ((Date.now() - t0) / 1000)).toFixed(1)}/s ${JSON.stringify(counts)}\n`);
  }
}));
fs.chmodSync(OUT, 0o600);
console.log(`E4 ${LAYOUT} done: ${JSON.stringify(counts)}`);
if (work.length && counts.error === work.length) process.exit(1);
