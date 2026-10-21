#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. The train/serve byte-identity check for the L2-conv
// training trial. Three assertions, every one over the real files:
//   1. a random sample of rendered training rows re-derives byte-for-byte
//      through renderRow (the rendering is deterministic and the file holds
//      what the function produces);
//   2. every rendered training row's FIXED PART (system[0] = the instructions,
//      system[1] = the page line) is byte-identical to what e4-bench.mjs
//      sends for a frozen-benchmark item -- the whole file, not a sample,
//      since the fixed part is what the serving cache reuses;
//   3. for a sample of benchmark items, the context turns the trial renders
//      from the item's context equal e4-bench.mjs's (same l3ContextFor, same
//      sentencesOf), so the variable part is the same construction too.
// Exits 1 on the first disagreement, naming it. Prints counts only.
//
//   node l2conv-render-check.mjs --dataset <jsonl> --rendered <jsonl> [--sample 300] [--seed 1]

import { readFileSync } from "fs";
import { layoutBody } from "./layouts.mjs";
import { l3ContextFor, sentencesOf } from "./context-policy.mjs";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DATASET = arg("--dataset"), RENDERED = arg("--rendered");
const N = Number(arg("--sample", "300"));
const { FT } = await import("./paths.mjs");
if (!DATASET || !RENDERED) { console.error("usage: --dataset <jsonl> --rendered <jsonl>"); process.exit(2); }
// renderRow and HOST come from the renderer itself (it renders only when it
// is the entry module), so nothing here is a second copy of the rendering.
const { renderRow, HOST } = await import("./l2conv-render.mjs");

const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rows = readJsonl(DATASET);
const rendered = readJsonl(RENDERED);
if (rows.length !== rendered.length) { console.error(`row count differs: dataset ${rows.length}, rendered ${rendered.length}`); process.exit(1); }
const byUid = new Map(rendered.map((r) => [r.uid, r]));

// deterministic sample
let s = Number(arg("--seed", "1"));
const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const pick = [...rows].sort(() => rnd() - 0.5).slice(0, N);

// 1. re-derive
let ok1 = 0;
for (const r of pick) {
  const fresh = renderRow(r, HOST);
  const have = byUid.get(r.uid);
  if (!have) { console.error(`rendered file lacks ${r.uid}`); process.exit(1); }
  if (JSON.stringify(fresh.messages) !== JSON.stringify(have.messages) || fresh.target !== have.target) {
    console.error(`re-derivation differs for ${r.uid}`); process.exit(1);
  }
  ok1++;
}

// 2. fixed part == e4-bench's, for EVERY training row
const bench = readJsonl(`${FT}/benchmark-run-input.jsonl`);
const e4 = (item) => {
  const prior = l3ContextFor(item.context || "");
  return layoutBody("L2-conv", { sentence: item.sentence, priorContext: prior, contextSentences: sentencesOf(prior), pageContext: { hostname: "discord.com" } }).messages;
};
const served = e4(bench[0]);
let ok2 = 0;
for (const r of rendered) {
  if (r.messages[0].role !== "system" || r.messages[0].content !== served[0].content) { console.error(`system[0] differs from the served instructions on ${r.uid}`); process.exit(1); }
  if (r.messages[1].role !== "system" || r.messages[1].content !== served[1].content) { console.error(`system[1] differs from the served page line on ${r.uid}`); process.exit(1); }
  ok2++;
}

// 3. the variable part is built the same way: render a benchmark item as if
//    it were a dataset row and compare with e4-bench's construction
let ok3 = 0;
for (const item of bench.slice(0, N)) {
  const asRow = { uid: item.uid, card: { split: "bench" }, kind: "bench", register: "bench", context: item.context, input: item.sentence, target: item.sentence };
  const mine = renderRow(asRow, "discord.com").messages;
  if (JSON.stringify(mine) !== JSON.stringify(e4(item))) { console.error(`benchmark item ${item.uid} renders differently from e4-bench`); process.exit(1); }
  ok3++;
}
console.log(JSON.stringify({ rederived: ok1, fixed_part_identical: ok2, benchmark_items_identical: ok3, host: HOST,
  system0_chars: served[0].content.length, system1: served[1].content }));
