#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. E1 of the 2026-09-24 prompt-cache study
// See TESTING.md §29 for scope and prerequisites.
//
// For each scenario: put the runtime in a documented EMPTY cache state, send
// two consecutive requests (A, then B), and record for B
//   - the first differing token between A's and B's rendered token streams
//     (rendered through the runtime's own template + tokenizer), and the
//     character offset of the first difference, with the tokens either side
//     (H2: what varies early; H3: re-tokenisation at the join);
//   - what the runtime did: LCP it found (slots debug), the checkpoint it
//     restored or "forcing full prompt re-processing", tokens reused (first
//     batch start) and tokens evaluated, checkpoints request A left behind;
//   - Ollama's prompt_eval_count against the tokens actually evaluated (H4).
//
//   node e1-reuse.mjs --runtime ollama --port 11556 --log <ollama.log> --out <rows.jsonl>
//   node e1-reuse.mjs --runtime llama  --port 11560 --log <llama.log> --out <rows.jsonl> \
//        --restart "<cmd to restart the server>"    (llama-server has no unload)
//   [--set original|addendum|replay|all]   (default original; see SCENARIOS)
//
// "Empty" means a FRESH RUNNER PROCESS: Ollama is told keep_alive 0 and the
// script waits for /api/ps to be empty, so the llama-server subprocess --
// slot, context checkpoints and RAM prompt cache -- is gone; the next request
// starts a new one. The standalone llama-server is restarted by the given
// command. Every row records the runner port so a reader can see the process
// changed.
//
// Text is synthetic (fixtures.mjs), so the raw rows may carry pieces.

import { writeFileSync, chmodSync } from "fs";
import { execSync } from "child_process";
import { layoutMessages, layoutBody, MODEL } from "./layouts.mjs";
import { Ollama, LlamaServer, renderTokens, lcp, userStarts, loadavg } from "./runtime.mjs";
import { EMAIL, EMAIL_PAGE, NOTES, NOTES_PAGE, priorOf, naiveRelayout } from "./fixtures.mjs";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const RUNTIME = arg("--runtime", "ollama");
const PORT = Number(arg("--port"));
const LOG = arg("--log");
const OUT = arg("--out");
const RESTART = arg("--restart");
const THREADS = Number(arg("--threads", "8"));
if (!PORT || !LOG || !OUT) { console.error("usage: see header"); process.exit(2); }

const req = (layout, k, extra = {}) => ({
  layout, k,
  messages: layout === "naive"
    ? naiveRelayout(layoutMessages("L0", { sentence: EMAIL[k], priorContext: priorOf(EMAIL, k), pageContext: EMAIL_PAGE }))
    : layoutMessages(layout, { sentence: EMAIL[k], priorContext: extra.ctx ?? priorOf(EMAIL, k),
        contextSentences: extra.sentences ?? EMAIL.slice(0, k), pageContext: EMAIL_PAGE, keeps: extra.keeps }),
});
// Sentence k of the second synthetic document, on another site.
const other = (layout, k) => ({
  layout, k,
  messages: layoutMessages(layout, { sentence: NOTES[k], priorContext: priorOf(NOTES, k),
    contextSentences: NOTES.slice(0, k), pageContext: NOTES_PAGE }),
});
// The context for sentence k when sentence k-1 (the one request A checked) had
// its correction applied in the document before sentence k was finished.
const corrected = (k) => EMAIL.slice(0, k).map((s, i) => (i === k - 1 ? s.replace("havent", "haven't") : s));

// A then B. k counts from 0; k=3 is the 4th sentence (3 sentences of context).
// Three sets, run separately and archived separately (see run-e1.sh):
//   original  the first 18 scenarios          -> e1-<runtime>-cpu.jsonl
//   addendum  6 added with L2-conv             -> e1b-<runtime>-cpu.jsonl
//   replay    6 added after checkpoint 2: A is sent TWICE (an identical
//             re-send) before B, the sequence E3's first switch protocol
//             produced by accident            -> e1c-<runtime>-cpu.jsonl
const SCENARIOS = [
  { name: "identical-L0", a: req("L0", 3), b: req("L0", 3) },
  { name: "consecutive-L0", a: req("L0", 3), b: req("L0", 4) },
  { name: "consecutive-naive-relayout", a: req("naive", 3), b: req("naive", 4) },
  { name: "consecutive-L1p-sys", a: req("L1p-sys", 3), b: req("L1p-sys", 4) },
  { name: "consecutive-L1a-sys", a: req("L1a-sys", 3), b: req("L1a-sys", 4) },
  { name: "consecutive-L2-sys", a: req("L2-sys", 3), b: req("L2-sys", 4) },
  { name: "consecutive-L1p-post", a: req("L1p-post", 3), b: req("L1p-post", 4) },
  { name: "consecutive-L1a-post", a: req("L1a-post", 3), b: req("L1a-post", 4) },
  { name: "consecutive-L2-post", a: req("L2-post", 3), b: req("L2-post", 4) },
  { name: "consecutive-L1p-usr", a: req("L1p-usr", 3), b: req("L1p-usr", 4) },
  // first sentence of a message (no context) then the second: L0 changes its
  // demonstration set between the two; L1p keeps it.
  { name: "first-then-second-L0", a: req("L0", 0), b: req("L0", 1) },
  { name: "first-then-second-L1p-post", a: req("L1p-post", 0), b: req("L1p-post", 1) },
  // a retry of the same sentence (keep-list), then the next sentence
  { name: "retry-L0", a: req("L0", 3), b: req("L0", 3, { keeps: ["recieved"] }) },
  { name: "retry-L1p-post", a: req("L1p-post", 3), b: req("L1p-post", 3, { keeps: ["recieved"] }) },
  // L4 (study addition): prior sentences as user turns
  { name: "consecutive-L4-conv", a: req("L4-conv", 3), b: req("L4-conv", 4) },
  { name: "retry-L4-conv", a: req("L4-conv", 3), b: req("L4-conv", 3, { keeps: ["recieved"] }) },
  // sentence 3 ("...havent seen it.") was corrected in the document before sentence 4
  { name: "corrected-prev-L4-conv", a: req("L4-conv", 3), b: req("L4-conv", 4, { sentences: corrected(4) }) },
  { name: "corrected-prev-L1p-post", a: req("L1p-post", 3), b: req("L1p-post", 4, { ctx: corrected(4).join(" ") }) },
  // L2-conv (study addition after E3): no demonstrations, context as turns
  { name: "consecutive-L2-conv", a: req("L2-conv", 3), b: req("L2-conv", 4) },
  { name: "retry-L2-conv", a: req("L2-conv", 3), b: req("L2-conv", 3, { keeps: ["recieved"] }) },
  { name: "corrected-prev-L2-conv", a: req("L2-conv", 3), b: req("L2-conv", 4, { sentences: corrected(4) }) },
  // a different document on a different site right after A: what a new
  // document or a tab switch costs from the checkpoints A left
  { name: "new-document-L1p-post", a: req("L1p-post", 3), b: other("L1p-post", 2) },
  { name: "new-document-L4-conv", a: req("L4-conv", 3), b: other("L4-conv", 2) },
  { name: "new-document-L2-conv", a: req("L2-conv", 3), b: other("L2-conv", 2) },
  // replay set: `pre` requests are sent before A (unmeasured). An identical
  // re-send resumes from the 4-before-the-end checkpoint and processes no
  // user-message start, so the only checkpoint it creates is the end one --
  // and creating it evicts the previous request's last-user-start checkpoint
  // (create_checkpoint, server-context.cpp ~L2350-2366 at 0b1bad14f).
  { name: "new-document-L3-post", a: req("L3-post", 3), b: other("L3-post", 2) },
  { name: "replay-then-new-document-L3-post", pre: [req("L3-post", 3)], a: req("L3-post", 3), b: other("L3-post", 2) },
  { name: "replay-then-next-L3-post", pre: [req("L3-post", 3)], a: req("L3-post", 3), b: req("L3-post", 4) },
  { name: "replay-then-next-L1p-post", pre: [req("L1p-post", 3)], a: req("L1p-post", 3), b: req("L1p-post", 4) },
  { name: "replay-then-next-L4-conv", pre: [req("L4-conv", 3)], a: req("L4-conv", 3), b: req("L4-conv", 4) },
  { name: "replay-then-next-L2-conv", pre: [req("L2-conv", 3)], a: req("L2-conv", 3), b: req("L2-conv", 4) },
];
SCENARIOS.forEach((s, i) => { s.set = i < 18 ? "original" : i < 24 ? "addendum" : "replay"; });

const ollama = RUNTIME === "ollama" ? new Ollama({ port: PORT, log: LOG }) : null;
const llama = RUNTIME === "llama" ? new LlamaServer({ port: PORT, log: LOG }) : null;

async function reset() {
  if (ollama) { await ollama.unload(MODEL); await ollama.load(MODEL, { num_gpu: 0, num_thread: THREADS, num_ctx: 2048 }); return ollama.runnerPort(); }
  execSync(RESTART, { stdio: "inherit", shell: "/bin/bash" });
  await llama.ready();
  return PORT;
}

async function send(r) {
  if (ollama) {
    const body = layoutBody("L0", { sentence: "x", pageContext: EMAIL_PAGE }); // shipping options/format
    body.messages = r.messages;
    body.options.num_gpu = 0; body.options.num_thread = THREADS; body.keep_alive = "30m";
    const { json, wallMs, log } = await ollama.chat(body);
    return { wallMs, log, api: { prompt_eval_count: json.prompt_eval_count, prompt_eval_cached_count: json.prompt_eval_cached_count ?? null, prompt_eval_ms: json.prompt_eval_duration / 1e6, eval_count: json.eval_count, eval_ms: json.eval_duration / 1e6, total_ms: json.total_duration / 1e6, load_ms: json.load_duration / 1e6 }, output: json.message?.content };
  }
  const { json, wallMs, log, timings } = await llama.chat(r.messages);
  return { wallMs, log, api: timings, output: json.choices?.[0]?.message?.content };
}

// --set original|addendum|replay|all picks a set (default original); --only
// a,b,c further narrows by name prefix
const SET = arg("--set", "original");
const ONLY = arg("--only");
const PICK = SCENARIOS.filter((s) => (SET === "all" || s.set === SET)
  && (!ONLY || ONLY.split(",").some((p) => s.name.startsWith(p))));
if (!PICK.length) { console.error(`no scenarios for --set ${SET}${ONLY ? " --only " + ONLY : ""}`); process.exit(2); }

const ckSummary = (log) => ({ created: log.checkpoints, erasedTooClose: log.erasedTooClose, erasedInvalidated: log.erasedInvalidated,
  reused: log.reused, evaluated: log.evaluated, restored: log.restored ? log.restored.nTokens : null });

const rows = [];
for (const sc of PICK) {
  const runner = await reset();
  const ra = await renderTokens(runner, sc.a.messages);
  const rb = await renderTokens(runner, sc.b.messages);
  const pre = [];
  for (const p of sc.pre || []) pre.push(ckSummary((await send(p)).log));
  const A = await send(sc.a);
  const B = await send(sc.b);
  const tokDiv = lcp(ra.ids, rb.ids);
  const charDiv = lcp([...ra.prompt], [...rb.prompt]);
  // which token holds the first differing CHARACTER (pieces concatenate to the
  // prompt after the BOS piece)
  let acc = 0, tokOfChar = null;
  for (let i = 1; i < rb.pieces.length; i++) { const n = [...rb.pieces[i]].length; if (acc + n > charDiv) { tokOfChar = i; break; } acc += n; }
  const us = userStarts(rb.pieces);
  const row = {
    scenario: sc.name, set: sc.set, runtime: RUNTIME, runner, loadavg: loadavg(),
    pre,
    a: { layout: sc.a.layout, k: sc.a.k, nTokens: ra.ids.length, logNTokens: A.log.nTokens, reused: A.log.reused, evaluated: A.log.evaluated,
      checkpoints: A.log.checkpoints, erasedTooClose: A.log.erasedTooClose, erasedInvalidated: A.log.erasedInvalidated,
      restored: A.log.restored ? A.log.restored.nTokens : null, api: A.api, wallMs: A.wallMs },
    b: { layout: sc.b.layout, k: sc.b.k, nTokens: rb.ids.length, logNTokens: B.log.nTokens, ...B.log, api: B.api, wallMs: B.wallMs },
    renderedDivergenceToken: tokDiv,
    renderedDivergenceChar: charDiv,
    tokenHoldingFirstDifferentChar: tokOfChar,
    piecesAround: { a: ra.pieces.slice(Math.max(0, tokDiv - 3), tokDiv + 3), b: rb.pieces.slice(Math.max(0, tokDiv - 3), tokDiv + 3) },
    userStartsB: us,
    renderCountsMatchLog: ra.ids.length === A.log.nTokens && rb.ids.length === B.log.nTokens,
    // slots-debug ids begin at max(n_past-4,0): check them against our render
    debugMatchesRender: B.log.debugNew ? (() => {
      const from = Math.max(0, tokDiv - 4);
      const want = rb.ids.slice(from, from + B.log.debugNew.length);
      return JSON.stringify(want) === JSON.stringify(B.log.debugNew);
    })() : null,
  };
  rows.push(row);
  const b = row.b;
  console.log(`${sc.name.padEnd(28)} n=${String(b.nTokens).padStart(4)} div@${String(tokDiv).padStart(4)} ` +
    `reused=${String(b.reused).padStart(4)} eval=${String(b.evaluated).padStart(4)} ` +
    `${b.restored ? "restored@" + b.restored.nTokens : b.forcedFull ? "FULL" : "direct"}  ` +
    `${pre.length ? `pre.ckpts=[${pre.map((p) => p.created.join(",")).join(" | ")}] A.evictedTooClose=[${row.a.erasedTooClose.join(",")}] ` : ""}` +
    `A.ckpts=[${row.a.checkpoints.join(",")}] userStarts=[${us.join(",")}] ` +
    `api.prompt_eval_count=${B.api?.prompt_eval_count ?? B.api?.prompt_n} render=log:${row.renderCountsMatchLog} dbg:${row.debugMatchesRender}`);
}
writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
chmodSync(OUT, 0o600);
console.log(`wrote ${rows.length} rows -> ${OUT}`);
