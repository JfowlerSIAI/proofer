#!/usr/bin/env node
// Where does the deciding evidence sit in a real sentence-mode context?
//
//   node test/finetune/context-distance-survey.mjs
//
// The context-length floor (plan §7 Phase 0.2) needs a weighting over
// evidence distance: a window of W chars only helps when the evidence is
// within W of the sentence being corrected. The `emtal` case — the bad apply
// that motivated the context suite — was decided by the immediately preceding
// message. This survey measures, over the owner's real messages, how far back
// the most recent prior messages START, i.e. the smallest window that retains
// them in full.
//
// Distances are measured in characters back from the target sentence's start,
// through the exact context string production builds (prior messages in the
// same channel within 30 min, joined by \n, plus the current message's own
// prefix, tail-trimmed to 2500 — see discord-source.mjs targetsFor).
//
// Output: percentile table + CDF at the candidate windows, and a JSON
// artifact. Counts and offsets only — no message text.

import { writeFileSync, mkdirSync } from "fs";
import {
  loadMessages, channelIndex, CONTEXT_CHARS, MIN_SENTENCE_CHARS, MAX_TARGET,
} from "../harvested/discord-source.mjs";
import { segmentSentences } from "../lib/content-sandbox.mjs";

const WINDOWS = [125, 250, 500, 750, 1000, 1500, 2500];
const CONTEXT_WINDOW_MS = 30 * 60 * 1000;

const msgs = loadMessages();
if (!msgs.length) { console.error("no messages loaded"); process.exit(1); }
const byChannel = channelIndex(msgs);

// For each sentence target: distance (chars back from sentence start) to the
// START of the k-th most recent prior message, k = 1..3, computed BEFORE the
// 2500 trim so the survey can see beyond the current cap.
const d1 = [], d2 = [], d3 = [];
let targets = 0, withPrior = 0;

for (const m of msgs) {
  const list = byChannel.get(m.server + " " + m.channel) || [];
  const pos = list.findIndex((x) => x.message_id === m.message_id);
  const priorLens = [];
  for (let i = pos - 1; i >= 0; i--) {
    if (m.ts - list[i].ts > CONTEXT_WINDOW_MS) break;
    priorLens.push(list[i].content.length);
  }
  // priorLens[0] is the most recent prior message.
  for (const s of segmentSentences(m.content)) {
    const text = s.text.trim();
    if (text.length < MIN_SENTENCE_CHARS || text.length > MAX_TARGET) continue;
    targets++;
    if (!priorLens.length) continue;
    withPrior++;
    // Chars between sentence start and the end of the prior block: the
    // current message's own prefix plus the joining newline.
    let back = s.start + 1;
    const dists = [];
    for (let k = 0; k < 3 && k < priorLens.length; k++) {
      back += priorLens[k];
      dists.push(back);
      back += 1; // the \n join before the next-older message
    }
    if (dists[0] != null) d1.push(dists[0]);
    if (dists[1] != null) d2.push(dists[1]);
    if (dists[2] != null) d3.push(dists[2]);
  }
}

const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : null;
};
const cdfAt = (arr, w) => arr.length
  ? (100 * arr.filter((d) => d <= w).length / arr.length) : null;

console.log("\nEvidence distance in real sentence-mode contexts");
console.log("=".repeat(72));
console.log(`sentence targets: ${targets}   with prior context: ${withPrior}`
  + ` (${(100 * withPrior / targets).toFixed(1)}%)`);
console.log(`\ndistance back to START of k-th most recent prior message (chars):`);
console.log(`  k    n        p50    p75    p90    p95`);
for (const [k, arr] of [[1, d1], [2, d2], [3, d3]]) {
  console.log(`  ${k}    ${String(arr.length).padEnd(7)} ${String(pct(arr, 50)).padStart(5)}  ${String(pct(arr, 75)).padStart(5)}  ${String(pct(arr, 90)).padStart(5)}  ${String(pct(arr, 95)).padStart(5)}`);
}
console.log(`\nCDF: share of targets whose k-th prior message is FULLY inside a window`);
console.log(`  window   k=1     k=2     k=3`);
for (const w of WINDOWS) {
  const row = [d1, d2, d3].map((a) => {
    const v = cdfAt(a, w);
    return v == null ? "  n/a" : v.toFixed(1).padStart(5) + "%";
  });
  console.log(`  ${String(w).padStart(6)}   ${row.join("  ")}`);
}

mkdirSync(new URL("../harvested/finetune/", import.meta.url), { recursive: true });
const out = {
  generated: "context-distance-survey",
  targets, withPrior, windows: WINDOWS,
  percentiles: Object.fromEntries([[1, d1], [2, d2], [3, d3]].map(([k, a]) =>
    [k, { n: a.length, p50: pct(a, 50), p75: pct(a, 75), p90: pct(a, 90), p95: pct(a, 95) }])),
  cdf: Object.fromEntries(WINDOWS.map((w) =>
    [w, { k1: cdfAt(d1, w), k2: cdfAt(d2, w), k3: cdfAt(d3, w) }])),
};
writeFileSync(new URL("../harvested/finetune/context-distance-survey.json", import.meta.url),
  JSON.stringify(out, null, 2));
console.log(`\nartifact: test/harvested/finetune/context-distance-survey.json`);
