#!/usr/bin/env node
// Serial, one-at-a-time latency for a K-sentence window.
//
// The accuracy runs use --conc 4 so they finish in minutes, which makes every
// latency in them a queued number and useless for "what does the user wait".
// This sends one request at a time against a warm runner, over real windows
// drawn from the corpus, and reports the distribution per K.
//
//   node sentence-window-latency.mjs --corpus error-holdout.json --n 40
//
// num_ctx is left at the pinned SENTENCE_NUM_CTX for every K, because that is
// what would ship -- if a window overflows it, that shows up here as a
// truncation, which is the finding.

import { readFileSync } from "fs";
import { prepareSentenceRequest } from "./lib/sentence-guards.mjs";
import { buildMessages } from "./sentence-window-test.mjs";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? d : process.argv[i + 1];
};
const DIR = process.env.PROOFER_CORPUS_DIR || new URL("./harvested/", import.meta.url).pathname;
const MODEL = process.env.PROOFER_MODEL || "qwen3.5:9b";
const OLLAMA = (process.env.PROOFER_OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const N = Number(arg("--n", 40));
const KS = String(arg("--ks", "1,2,3,4")).split(",").map(Number);

const corpus = JSON.parse(readFileSync(DIR + String(arg("--corpus", "error-holdout.json")), "utf8"));
const msgs = buildMessages(corpus).messages;

// The windows are drawn from the SAME positions for every K -- a sentence deep
// enough in its message to have K-1 predecessors at the largest K measured --
// so the comparison is not confounded by K=4 silently sampling longer messages.
const maxK = Math.max(...KS);
const picks = [];
for (const m of msgs) {
  for (let i = maxK - 1; i < m.items.length; i++) picks.push({ m, i });
  if (picks.length >= N) break;
}
const work = picks.slice(0, N);
if (work.length < N) console.error(`only ${work.length} positions have ${maxK - 1} predecessors`);

const joinRange = (parts, seps, lo) =>
  parts.reduce((acc, p, k) => (k === 0 ? p : acc + seps[lo + k - 1] + p), "");

async function one(text, ctx) {
  const req = prepareSentenceRequest(text, ctx, { hostname: "discord.com" }, { ollamaModel: MODEL });
  const t0 = Date.now();
  const res = await fetch(OLLAMA + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body),
  });
  const data = await res.json();
  return {
    ms: Date.now() - t0,
    promptTokens: data.prompt_eval_count ?? null,
    evalTokens: data.eval_count ?? null,
    loadMs: data.load_duration ? Math.round(data.load_duration / 1e6) : 0,
    truncated: data.done_reason === "length",
  };
}

const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

console.log(`model=${MODEL}  n=${work.length} per K  serial, warm`);
console.log("K   median   p95    mean   promptTok  evalTok  truncated");
for (const K of KS) {
  const rows = [];
  // One throwaway to make sure the runner is up and keep_alive re-armed.
  await one("warmup sentence goes here.", "");
  for (const { m, i } of work) {
    const lo = Math.max(0, i - K + 1);
    const text = joinRange(m.items.slice(lo, i + 1).map((x) => x.sentence), m.seps, lo);
    const settled = lo === 0 ? "" : joinRange(m.items.slice(0, lo).map((x) => x.sentence), m.seps, 0) + m.seps[lo - 1];
    rows.push(await one(text, (m.external + settled).slice(-2500)));
  }
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pt = rows.map((r) => r.promptTokens).sort((a, b) => a - b);
  const et = rows.map((r) => r.evalTokens).sort((a, b) => a - b);
  const mean = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
  console.log(`${K}   ${String(q(ms, 0.5)).padStart(6)}  ${String(q(ms, 0.95)).padStart(5)}  ${String(mean).padStart(5)}`
    + `  ${String(q(pt, 0.5)).padStart(9)}  ${String(q(et, 0.5)).padStart(7)}  ${rows.filter((r) => r.truncated).length}`);
}
