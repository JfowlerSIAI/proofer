#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. E3 of the 2026-09-24 prompt-cache study: candidate
// layouts on realistic typing, timed on one backend per run
// See TESTING.md §29; local corpus artifacts are required.
//
// Input: <RAW>/e3-messages.json from e3-messages.mjs (twenty real 8-sentence
// emails and one long document; private corpus text).
//
// SCENARIOS
//   main      20 emails x 8 sentences, typed in order, every layout. Layouts
//             are INTERLEAVED per email (order rotated per email). Before each
//             layout's email the runner is RESET (model unloaded, so slot,
//             context checkpoints and RAM prompt cache are gone) and then
//             PRIMED with one unrecorded request (the previous email's last
//             sentence in the same layout), so every layout starts every email
//             from the same documented state: a runner that has served exactly
//             one earlier request of that layout. Without the reset, an earlier
//             layout's long prompt left a checkpoint a few tokens in that the
//             runtime keeps as the oldest entry, which changed which
//             checkpoints the next layout's requests created (a first run
//             without it is kept as e3-cpu4-noreset-partial.jsonl).
//   cold      per layout, 3 first sentences each on a freshly loaded runner
//             (model unloaded, then the request): load + full prompt.
// main runs every layout in --layouts; the other scenarios run the smaller
// --extra-layouts set. switch, retry and rollover reset and prime the same way
// as main before each layout's sequence.
//   switch    two emails typed alternately on two different hosts (2 pairs):
//             primed with A1 (unrecorded), then measured B1 A2 B2 ... A8 B8 --
//             the single cache slot plus the RAM prompt cache.
//   switch-replay  the FIRST protocol, kept to reproduce its archived rows:
//             primed with A1 and then A1 again (measured, flagged
//             replayOfPrime) before B1 A2 B2 ... That identical re-send evicts
//             the -post layouts' last-user-message checkpoint (see the report,
//             §3), so it is a scenario of its own, not the ordinary switch.
//             The archived cpu4 rows were written as "switch" and relabelled
//             by relabel-switch-replay.mjs.
//   retry     3 emails; after sentences 4 and 7 (k = 3, 6) a retry of the same sentence
//             (keep-list = its longest word) is sent, then typing continues:
//             the retry's cost and the next sentence's cost after it.
//   rollover  one long document, sentences 32..63 (text before them grows
//             past the 2,500-character shipping window), primed with 31.
//
// CONTEXT PER LAYOUT
//   L0, L1*, L2*   sentenceContextFor(text, start) -- content.js's own builder
//   L3-*, L4-conv  the L3 jump window (500 chars, jump to <= 250), advanced
//                  over every earlier sentence start in typing order
//   L4-conv        its context sentences are the document's own segments
//
// RECORDED PER REQUEST (one JSON row): layout, scenario, email, sentence
// index, tokens in the prompt / reused / evaluated (from the runner's log --
// see runtime.mjs), prompt ms and decode ms (log), wall ms (client), decoded
// tokens, whether wall beat 5,000 ms and 4,750 ms, a PROJECTED total for a
// normal-length answer (prompt ms + expected answer tokens x this backend's
// ms/token -- the untrained pilot recites demonstrations on some layouts and
// its decode time says nothing about a retrained one), load averages.
//
//   node e3-typing.mjs --backend cpu4 --port 11562 --log <log> --out <rows.jsonl>
//        [--threads 4] [--gpu] [--scenarios main,cold,switch,retry,rollover]
//        (default: those five on every backend; switch-replay only when named)
//        [--layouts L0,...] [--extra-layouts L0,...] [--messages 20] [--model <tag>]

import { readFileSync, appendFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { layoutBody, makeL3Window, MODEL as PILOT, usesL3Window } from "./layouts.mjs";
import { Ollama, LogTail, loadavg } from "./runtime.mjs";
import { shippingContext } from "./context-policy.mjs";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const { RAW: RAW_DEFAULT } = await import("./paths.mjs");
const RAW = arg("--raw", RAW_DEFAULT);
const BACKEND = arg("--backend");
const PORT = Number(arg("--port"));
const LOG = arg("--log");
const OUT = arg("--out");
const THREADS = Number(arg("--threads", "4"));
const GPU = process.argv.includes("--gpu");
// (The first pass ran switch and retry on cpu4 only; checkpoint 2 asked for
// them on every backend, and the second pass added them with
// --scenarios switch,retry.)
const SCEN = arg("--scenarios", "main,cold,switch,retry,rollover").split(",");
// L1a-post is left out of the timed set: E1 shows it resumes from the same
// last-user-message checkpoint as L1p-post and evaluates the same tokens
// (the demonstration it lacks sits in the cached part).
// L2-conv was added after the cpu4 run had started (see layouts.mjs); cpu4 got
// it in a separate run with --layouts L2-conv --extra-layouts L2-conv.
const LAYOUTS = arg("--layouts", "L0,L1p-sys,L1a-sys,L2-sys,L3-sys,L1p-post,L2-post,L3-post,L4-conv,L2-conv").split(",");
const EXTRA = arg("--extra-layouts", "L0,L1p-sys,L1p-post,L3-post,L4-conv,L2-conv").split(",");
const NMSG = Number(arg("--messages", "20"));
// another model (the 2026-10-02 L2-conv training trial times its retrained arm here)
const MODEL = arg("--model", PILOT);
if (!BACKEND || !PORT || !LOG || !OUT) { console.error("usage: see header"); process.exit(2); }

const input = JSON.parse(readFileSync(`${RAW}/e3-messages.json`, "utf8"));
const MSGS = input.messages.slice(0, NMSG);
const PAGE_A = { hostname: "mail.google.com" };
const PAGE_B = { hostname: "outlook.office.com" };
const ollama = new Ollama({ port: PORT, log: LOG });
if (!existsSync(OUT)) writeFileSync(OUT, "", { mode: 0o600 });
chmodSync(OUT, 0o600);

// ---------------------------------------------------------------- documents

/** A document being typed: its text, sentence segments, and per-layout L3 state. */
function docState(doc) {
  const starts = doc.sentences.map((s) => s.start);
  return { doc, starts, l3: new Map() };
}
function contextFor(st, layout, k) {
  const { doc, starts } = st;
  const start = starts[k];
  if (usesL3Window(layout)) {
    if (!st.l3.has(layout)) st.l3.set(layout, { w: makeL3Window(), upTo: -1, last: null });
    const s = st.l3.get(layout);
    // advance the window over every sentence start up to k, in typing order
    for (let j = s.upTo + 1; j <= k; j++) s.last = s.w(doc.text, starts[j], starts);
    s.upTo = Math.max(s.upTo, k);
    const winStart = s.last.start;
    const ctx = doc.text.slice(winStart, start).trim();
    const sentences = doc.sentences.slice(0, k).filter((x) => x.start >= winStart).map((x) => x.text);
    return { priorContext: ctx, contextSentences: sentences };
  }
  return { priorContext: shippingContext(doc.text, start), contextSentences: null };
}

// ---------------------------------------------------------------- requests

let decodeMsPerTok = [];
const expectedAnswerTokens = new Map();   // sentence text -> tokens of {"rewritten": "<sentence>"}

async function answerTokens(sentence) {
  if (expectedAnswerTokens.has(sentence)) return expectedAnswerTokens.get(sentence);
  const port = ollama.runnerPort();
  const r = await fetch(`http://127.0.0.1:${port}/tokenize`, { method: "POST",
    body: JSON.stringify({ content: JSON.stringify({ rewritten: sentence }).replace('{"rewritten":"', '{"rewritten": "'), add_special: false }) });
  const n = (await r.json()).tokens.length + 1;   // + the end-of-turn token
  expectedAnswerTokens.set(sentence, n);
  return n;
}

async function send({ layout, scenario, email, k, sentence, ctx, page, keeps = null, record = true, extra = {} }) {
  const body = layoutBody(layout, { sentence, priorContext: ctx.priorContext, contextSentences: ctx.contextSentences, pageContext: page, keeps, model: MODEL });
  if (!GPU) body.options.num_gpu = 0;
  body.options.num_thread = THREADS;
  body.keep_alive = "30m";
  const la = loadavg();
  const { json, wallMs, log } = await ollama.chat(body);
  const row = {
    backend: BACKEND, scenario, layout, model: MODEL, email, k, retry: !!keeps,
    sentenceChars: sentence.length, contextChars: ctx.priorContext.length,
    nTokens: log.nTokens, reused: log.reused, evaluated: log.evaluated, promptMs: log.promptMs,
    decoded: log.decoded, decodeMs: log.decodeMs, wallMs: Math.round(wallMs),
    loadMs: Math.round((json.load_duration || 0) / 1e6),
    restored: log.restored ? log.restored.nTokens : null, forcedFull: log.forcedFull, ramCacheHit: !!log.ramCacheHit,
    api: { prompt_eval_count: json.prompt_eval_count, eval_count: json.eval_count },
    beat5s: wallMs < 5000, beat4750: wallMs < 4750,
    loadavg: la, ts: new Date().toISOString(), output: json.message?.content ?? null,
    ...extra,
  };
  if (log.decoded > 1 && log.decodeMs) decodeMsPerTok.push(log.decodeMs / log.decoded);
  row.expectedAnswerTokens = await answerTokens(sentence);
  if (record) appendFileSync(OUT, JSON.stringify(row) + "\n");
  return row;
}

const rotate = (arr, n) => arr.map((_, i) => arr[(i + n) % arr.length]);
const fmt = (r) => `${r.scenario.padEnd(8)} ${r.layout.padEnd(9)} e${String(r.email).padStart(2)} k${String(r.k).padStart(2)} ` +
  `n=${String(r.nTokens).padStart(4)} eval=${String(r.evaluated).padStart(4)} pms=${String(Math.round(r.promptMs)).padStart(5)} ` +
  `dec=${String(r.decoded).padStart(3)} wall=${String(r.wallMs).padStart(5)} la=${r.loadavg[0]}`;

// ------------------------------------------------------------------ run

console.log(`E3 backend=${BACKEND} port=${PORT} threads=${THREADS} gpu=${GPU} model=${MODEL} layouts=${LAYOUTS.join(",")} loadavg=${loadavg().join(" ")}`);
{ // make sure the runner is up with this backend's options before anything is timed
  const b = layoutBody("L0", { sentence: "Warm up.", pageContext: PAGE_A, model: MODEL });
  if (!GPU) b.options.num_gpu = 0;
  b.options.num_thread = THREADS; b.keep_alive = "30m";
  await ollama.chat(b);
  // Which device did the runner load onto? Recorded, and for the iGPU
  // backend REQUIRED to be the Intel device: Vulkan here also sees the RTX
  // 4090 and prefers it (see serve.sh).
  const devs = [...new LogTail(LOG).readFrom(0).matchAll(/using device (\S+ \([^)]*\))/g)].map((m) => m[1]);
  const last = devs[devs.length - 1] || "none (CPU only)";
  console.log(`runner device: ${last}`);
  if (GPU && BACKEND === "igpu" && !/Intel/.test(last)) { console.error(`igpu run is not on the Intel device (${last}); refusing`); process.exit(1); }
  if (!GPU && devs.length) { console.error(`cpu run loaded onto a device (${last}); refusing`); process.exit(1); }
}

if (SCEN.includes("main")) {
  for (let m = 0; m < MSGS.length; m++) {
    for (const layout of rotate(LAYOUTS, m)) {
      // reset, then prime: the previous email's last sentence, same layout (unrecorded)
      await ollama.unload(MODEL);
      const prev = docState(MSGS[(m + MSGS.length - 1) % MSGS.length]);
      await send({ layout, scenario: "prime", email: -1, k: 7, sentence: prev.doc.sentences[7].text, ctx: contextFor(prev, layout, 7), page: PAGE_A, record: false });
      const st = docState(MSGS[m]);
      for (let k = 0; k < 8; k++) {
        const r = await send({ layout, scenario: "main", email: m, k, sentence: st.doc.sentences[k].text, ctx: contextFor(st, layout, k), page: PAGE_A });
        console.log(fmt(r));
      }
    }
  }
}

if (SCEN.includes("cold")) {
  for (const layout of EXTRA) {
    for (let m = 0; m < 3; m++) {
      await ollama.unload(MODEL);
      const st = docState(MSGS[m]);
      const r = await send({ layout, scenario: "cold", email: m, k: 0, sentence: st.doc.sentences[0].text, ctx: contextFor(st, layout, 0), page: PAGE_A });
      console.log(fmt(r), `load=${r.loadMs}`);
    }
  }
}

for (const scen of ["switch", "switch-replay"]) {
  if (!SCEN.includes(scen)) continue;
  const replay = scen === "switch-replay";
  for (const [a, b] of [[0, 10], [1, 11]].filter(([x, y]) => x < MSGS.length && y < MSGS.length)) {
    for (const layout of EXTRA) {
      const A = docState(MSGS[a]), B = docState(MSGS[b]);
      await ollama.unload(MODEL);
      // prime with A's first sentence (unrecorded)
      await send({ layout, scenario: "prime", email: -1, k: 0, sentence: A.doc.sentences[0].text, ctx: contextFor(A, layout, 0), page: PAGE_A, record: false });
      for (let k = 0; k < 8; k++) {
        for (const [st, page, id] of [[A, PAGE_A, a], [B, PAGE_B, b]]) {
          // the ordinary switch does not send A1 again (it was the prime);
          // switch-replay does, and flags that request
          if (st === A && k === 0 && !replay) continue;
          const r = await send({ layout, scenario: scen, email: id, k, sentence: st.doc.sentences[k].text, ctx: contextFor(st, layout, k), page,
            extra: replay && st === A && k === 0 ? { replayOfPrime: true } : {} });
          console.log(fmt(r));
        }
      }
    }
  }
}

if (SCEN.includes("retry")) {
  for (let m = 0; m < Math.min(3, MSGS.length); m++) {
    for (const layout of rotate(EXTRA, m)) {
      await ollama.unload(MODEL);
      const prev = docState(MSGS[(m + MSGS.length - 1) % MSGS.length]);
      await send({ layout, scenario: "prime", email: -1, k: 7, sentence: prev.doc.sentences[7].text, ctx: contextFor(prev, layout, 7), page: PAGE_A, record: false });
      const st = docState(MSGS[m]);
      for (let k = 0; k < 8; k++) {
        const sentence = st.doc.sentences[k].text;
        const ctx = contextFor(st, layout, k);
        const r = await send({ layout, scenario: "retry-seq", email: m, k, sentence, ctx, page: PAGE_A });
        console.log(fmt(r));
        if (k === 3 || k === 6) {
          const word = (sentence.match(/[A-Za-z']{4,}/g) || ["word"]).sort((x, y) => y.length - x.length)[0];
          const rr = await send({ layout, scenario: "retry", email: m, k, sentence, ctx, page: PAGE_A, keeps: [word] });
          console.log(fmt(rr), "RETRY");
        }
      }
    }
  }
}

if (SCEN.includes("rollover")) {
  const R = input.rollover;
  const doc = { text: R.text, sentences: R.sentences };
  for (const layout of EXTRA) {
    const st = docState(doc);
    await ollama.unload(MODEL);
    // advance any L3 window over the unmeasured beginning, prime with the sentence before
    await send({ layout, scenario: "prime", email: -1, k: R.measureFrom - 1, sentence: doc.sentences[R.measureFrom - 1].text, ctx: contextFor(st, layout, R.measureFrom - 1), page: PAGE_A, record: false });
    for (let k = R.measureFrom; k < R.measureFrom + R.measureN; k++) {
      const r = await send({ layout, scenario: "rollover", email: 99, k, sentence: doc.sentences[k].text, ctx: contextFor(st, layout, k), page: PAGE_A });
      console.log(fmt(r));
    }
  }
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
console.log(`decode ms/token median ${med(decodeMsPerTok)?.toFixed(1)}; loadavg at end ${loadavg().join(" ")}`);
