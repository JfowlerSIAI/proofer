#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. E2 of the 2026-09-24 prompt-cache study: the
// divergence sweep. See TESTING.md §29 for scope and prerequisites.
//
// Take one baseline prompt. For each point p (5%..99% of its token length):
//   1. RESET: a fresh runner process -- Ollama unloads the model (keep_alive 0,
//      wait for /api/ps to be empty) and reloads it; a standalone llama-server
//      is restarted by --restart. Slot, context checkpoints and the RAM prompt
//      cache all start empty. The runner port is recorded per row.
//   2. PRIME: send the baseline prompt. Its row records the checkpoints it
//      created.
//   3. MUTATE: send the baseline with ONE token changed at index i ~ p*n. The
//      mutation is a word token inside some message's content swapped for a
//      different word; it is accepted only if the mutated prompt, rendered and
//      tokenized by the runtime itself, has the same length and differs from
//      the baseline at exactly index i (checked before sending, recorded as
//      `verified`).
// So every point measures reuse after divergence at i from a known state,
// never the prefix two successive mutations happen to share.
//
// Controls per prompt: IDENTICAL (the baseline again: full reuse is the
// ceiling) and FIRST-CONTENT (the first content token of the system turn
// changed: only the 4 template tokens are shared -- "no common prefix").
//
// Decode is cut to 1 token (num_predict / max_tokens = 1) because only prompt
// processing is measured; the primed cache is therefore baseline + 1 token.
//
//   node e2-sweep.mjs --runtime ollama --port 11557 --log <log> --out <rows.jsonl> [--threads 4]
//   node e2-sweep.mjs --runtime llama --port 11561 --log <log> --out <rows.jsonl> --restart "<cmd>"
//   [--prompts P1,P2,P3,P4]   which baselines (default P1-P3, see PROMPTS)
//   [--tag <name>]            label rows (e.g. a non-default llama-server setting)

import { writeFileSync, appendFileSync, chmodSync, existsSync } from "fs";
import { execSync } from "child_process";
import { layoutMessages, layoutBody, MODEL } from "./layouts.mjs";
import { Ollama, LlamaServer, renderTokens, lcp, userStarts, loadavg } from "./runtime.mjs";
import { EMAIL, EMAIL_PAGE, priorOf, LONG_DOC } from "./fixtures.mjs";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const RUNTIME = arg("--runtime", "ollama");
const PORT = Number(arg("--port"));
const LOG = arg("--log");
const OUT = arg("--out");
const RESTART = arg("--restart");
const THREADS = Number(arg("--threads", "4"));
const WANT = (arg("--prompts", "P1,P2,P3")).split(",");
const TAG = arg("--tag", "default");

const PROMPTS = {
  // the shipping request for the 5th sentence of the synthetic email
  P1: { desc: "L0 (shipping), 4 sentences of context", messages: layoutMessages("L0", { sentence: EMAIL[4], priorContext: priorOf(EMAIL, 4), pageContext: EMAIL_PAGE }) },
  // the same sentence in the post placement (context block after the sentence)
  P2: { desc: "L1p-post, same sentence and context", messages: layoutMessages("L1p-post", { sentence: EMAIL[4], priorContext: priorOf(EMAIL, 4), pageContext: EMAIL_PAGE }) },
  // a long context (> 512 tokens of prompt after the fixed part), to expose
  // any checkpoint tied to the 512-token batch
  // (rows written before 2026-09-25 01:10 carry the old label "~2400 characters")
  P3: { desc: "L0 (shipping), 2,156 characters of context", messages: layoutMessages("L0", { sentence: EMAIL[4], priorContext: LONG_DOC, pageContext: EMAIL_PAGE }) },
  // the study's conversation layout: one user turn per earlier sentence
  P4: { desc: "L4-conv, same sentence, 4 earlier sentences as user turns", messages: layoutMessages("L4-conv", { sentence: EMAIL[4], contextSentences: EMAIL.slice(0, 4), pageContext: EMAIL_PAGE }) },
};
const FRACS = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 0.99];
const SWAPS = ["cat", "dog", "sun", "red", "box", "map", "pen", "hat", "jam", "owl", "fig", "cup"];

const ollama = RUNTIME === "ollama" ? new Ollama({ port: PORT, log: LOG }) : null;
const llama = RUNTIME === "llama" ? new LlamaServer({ port: PORT, log: LOG }) : null;

async function reset() {
  if (ollama) { await ollama.unload(MODEL); await ollama.load(MODEL, { num_gpu: 0, num_thread: THREADS, num_ctx: 2048 }); return ollama.runnerPort(); }
  execSync(RESTART, { stdio: "ignore", shell: "/bin/bash" });
  await llama.ready();
  return PORT;
}
async function send(messages) {
  if (ollama) {
    const body = layoutBody("L0", { sentence: "x", pageContext: EMAIL_PAGE });
    body.messages = messages;
    Object.assign(body.options, { num_gpu: 0, num_thread: THREADS, num_predict: 1 });
    body.keep_alive = "30m";
    const { json, log } = await ollama.chat(body);
    return { log, api: { prompt_eval_count: json.prompt_eval_count, prompt_eval_cached_count: json.prompt_eval_cached_count ?? null, prompt_eval_ms: json.prompt_eval_duration / 1e6 } };
  }
  const { log, timings } = await llama.chat(messages, { maxTokens: 1 });
  return { log, api: timings };
}

// Rendered prompt = concat of "<|im_start|>{role}\n{content}<|im_end|>\n" + gen
// prompt; asserted against the runtime's /apply-template before use.
function contentRanges(messages) {
  let off = 0; const r = [];
  for (const m of messages) {
    const head = `<|im_start|>${m.role}\n`;
    r.push({ start: off + head.length, end: off + head.length + m.content.length });
    off += head.length + m.content.length + "<|im_end|>\n".length;
  }
  return r;
}
const expectPrompt = (messages) => messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join("") + "<|im_start|>assistant\n";

async function mutateAt(port, messages, base, target) {
  const ranges = contentRanges(messages);
  // char start of every token (pieces after the BOS concatenate to the prompt)
  const starts = [null]; let acc = 0;
  for (let i = 1; i < base.pieces.length; i++) { starts.push(acc); acc += base.pieces[i].length; }
  const order = [];
  for (let d = 0; d < base.ids.length; d++) { if (target + d < base.ids.length) order.push(target + d); if (d && target - d >= 1) order.push(target - d); }
  for (const i of order) {
    const piece = base.pieces[i];
    const w = /^( ?)([A-Za-z]{2,})$/.exec(piece);
    if (!w) continue;
    const c0 = starts[i], c1 = c0 + piece.length;
    const mi = ranges.findIndex((r) => c0 >= r.start && c1 <= r.end);
    if (mi < 0) continue;
    for (const s of SWAPS) {
      let rep = w[1] + (/^[A-Z]/.test(w[2]) ? s[0].toUpperCase() + s.slice(1) : s);
      if (rep === piece) continue;
      const mm = messages.map((m) => ({ ...m }));
      const o = c0 - ranges[mi].start;
      mm[mi].content = mm[mi].content.slice(0, o) + rep + mm[mi].content.slice(o + piece.length);
      const r = await renderTokens(port, mm);
      if (r.ids.length !== base.ids.length) continue;
      const diffs = [];
      for (let k = 0; k < r.ids.length; k++) if (r.ids[k] !== base.ids[k]) diffs.push(k);
      if (diffs.length === 1 && diffs[0] === i) return { messages: mm, index: i, from: piece, to: rep, verified: true };
    }
  }
  return null;
}

if (!existsSync(OUT)) writeFileSync(OUT, "", { mode: 0o600 });
chmodSync(OUT, 0o600);
const emit = (row) => { appendFileSync(OUT, JSON.stringify(row) + "\n"); };

for (const key of WANT) {
  const P = PROMPTS[key];
  let runner = await reset();
  const base = await renderTokens(runner, P.messages);
  if (base.prompt !== expectPrompt(P.messages)) throw new Error("template reconstruction does not match /apply-template");
  if (base.pieces.slice(1).join("") !== base.prompt) throw new Error("pieces do not concatenate to the prompt");
  const n = base.ids.length;
  const us = userStarts(base.pieces);
  console.log(`\n${key}: ${P.desc}  n=${n}  userStarts=[${us.join(",")}]  runtime=${RUNTIME}`);

  const points = [
    { kind: "control-identical", frac: 1, build: async () => ({ messages: P.messages, index: n, verified: true, from: null, to: null }) },
    { kind: "control-first-content", frac: 0, build: async () => mutateAt(runner, P.messages, base, 4) },
    ...FRACS.map((f) => ({ kind: "point", frac: f, build: async () => mutateAt(runner, P.messages, base, Math.max(4, Math.min(n - 1, Math.round(f * n)))) })),
  ];
  for (const pt of points) {
    runner = await reset();
    const mut = await pt.build();
    if (!mut) { console.log(`  ${pt.kind} ${pt.frac}: no single-token mutation found near target`); continue; }
    const prime = await send(P.messages);
    const res = await send(mut.messages);
    // the runtime's own view of the divergence (slots debug ids start at n_past-4)
    const dbgOk = res.log.debugNew
      ? JSON.stringify(res.log.debugNew) === JSON.stringify((await renderTokens(runner, mut.messages)).ids.slice(Math.max(0, mut.index - 4), Math.max(0, mut.index - 4) + res.log.debugNew.length))
      : null;
    const row = {
      prompt: key, desc: P.desc, runtime: RUNTIME, tag: TAG, runner, loadavg: loadavg(), kind: pt.kind, targetFrac: pt.frac,
      index: mut.index, frac: +(mut.index / n).toFixed(4), n, verified: mut.verified, from: mut.from, to: mut.to,
      primeReused: prime.log.reused, primeEvaluated: prime.log.evaluated, primeCheckpoints: prime.log.checkpoints,
      reused: res.log.reused, evaluated: res.log.evaluated, restored: res.log.restored, forcedFull: res.log.forcedFull,
      ramCacheHit: res.log.ramCacheHit, nTokensLog: res.log.nTokens, debugMatches: dbgOk,
      api: res.api, userStarts: us,
    };
    emit(row);
    console.log(`  ${pt.kind.padEnd(22)} target ${String(pt.frac).padEnd(4)} i=${String(mut.index).padStart(4)} (${(100 * mut.index / n).toFixed(1).padStart(5)}%)  ` +
      `prime.eval=${prime.log.evaluated} ckpts=[${prime.log.checkpoints.join(",")}]  reused=${String(res.log.reused).padStart(4)} eval=${String(res.log.evaluated).padStart(4)} ` +
      `${res.log.restored ? "restored@" + res.log.restored.nTokens : res.log.forcedFull ? "FULL" : "-"} dbg=${dbgOk}`);
  }
}
console.log(`\nrows appended to ${OUT}`);
