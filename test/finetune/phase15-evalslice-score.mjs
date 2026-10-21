#!/usr/bin/env node
// Score one or two model runs over the Phase 1.5 eval slice.
//
//   node phase15-evalslice-score.mjs --run <phase15-evalrun-X.jsonl> \
//        [--baseline <phase15-evalrun-v1.jsonl>] [--reps 4000] [--seed 7]
//
// Per class: post-guard recall (guard applied AND output exactly the gold
// parent), plus the no-op / refused / applied-but-different decomposition —
// applied-but-different rows are listed to *-adjq.jsonl for adjudication.
// Per negative shape: fire rate (guard applied AND output != input).
// With --baseline: paired per-class delta with a document-cluster bootstrap CI.
//
// Exact match is the right oracle HERE because every positive's gold is exact
// by construction (mechanical injection); this scorer must never be pointed at
// natural-error data, whose acceptable outputs are sets.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mulberry32, argOf, fail } from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const RUN = argOf("--run") ?? fail("--run required");
const BASE = argOf("--baseline");
const REPS = Number(argOf("--reps") ?? 4000);
const SEED = Number(argOf("--seed") ?? 7);

const readJsonl = (p) => {
  if (!fs.existsSync(p)) fail(`missing ${p}`);
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};
const slice = readJsonl(path.join(ART, "phase15-evalslice.jsonl"));
const byUid = new Map(slice.map((r) => [r.uid, r]));
const norm = (s) => String(s ?? "").trim();

function classify(run) {
  const out = new Map(); // uid -> {hit, fired, cls}
  for (const r of run) {
    const item = byUid.get(r.uid);
    if (!item) continue;
    const applied = !r.error && !r.malformed && r.guard === "applied" && r.rewritten != null;
    const changed = applied && norm(r.rewritten) !== norm(item.sentence);
    const hit = applied && norm(r.rewritten) === norm(item.gold) && norm(item.gold) !== norm(item.sentence);
    out.set(r.uid, {
      item, hit,
      fired: changed,
      bucket: r.error || r.malformed ? "malformed"
        : r.guard !== "applied" ? "refused"
        : !changed ? "no-op"
        : hit ? "exact" : "applied-different",
    });
  }
  return out;
}
const runRows = readJsonl(path.resolve(RUN));
const A = classify(runRows);
const B = BASE ? classify(readJsonl(path.resolve(BASE))) : null;

const classes = [...new Set(slice.filter((r) => r.kind === "positive").map((r) => r.class))].sort();
const shapes = [...new Set(slice.filter((r) => r.kind === "negative").map((r) => r.shape))].sort();

const result = { run: path.basename(RUN), baseline: BASE ? path.basename(BASE) : null, classes: {}, negatives: {} };
const adjq = [];
console.log(`\n== positives (post-guard recall; n per class) ==`);
for (const cls of classes) {
  const items = slice.filter((r) => r.kind === "positive" && r.class === cls);
  const buckets = {};
  let hits = 0;
  for (const it of items) {
    const v = A.get(it.uid);
    if (!v) { buckets.missing = (buckets.missing ?? 0) + 1; continue; }
    buckets[v.bucket] = (buckets[v.bucket] ?? 0) + 1;
    if (v.hit) hits++;
    if (v.bucket === "applied-different") {
      const raw = runRows.find((r) => r.uid === it.uid);
      adjq.push({ uid: it.uid, class: cls, sentence: it.sentence, gold: it.gold, output: raw?.rewritten });
    }
  }
  const recall = hits / items.length;
  result.classes[cls] = { n: items.length, recall: +recall.toFixed(4), buckets };
  let deltaStr = "";
  if (B) {
    const bHits = items.filter((it) => B.get(it.uid)?.hit).length;
    // paired document-cluster bootstrap on the delta
    const docs = new Map();
    for (const it of items) {
      const d = it.parent_uid;
      if (!docs.has(d)) docs.set(d, []);
      docs.get(d).push(it);
    }
    const docList = [...docs.values()];
    const rng = mulberry32(SEED);
    const deltas = [];
    for (let i = 0; i < REPS; i++) {
      let a = 0, b = 0, n = 0;
      for (let k = 0; k < docList.length; k++) {
        const grp = docList[Math.floor(rng() * docList.length)];
        for (const it of grp) { n++; if (A.get(it.uid)?.hit) a++; if (B.get(it.uid)?.hit) b++; }
      }
      deltas.push((a - b) / n);
    }
    deltas.sort((x, y) => x - y);
    const lo = deltas[Math.floor(REPS * 0.025)], hi = deltas[Math.floor(REPS * 0.975)];
    result.classes[cls].baselineRecall = +(bHits / items.length).toFixed(4);
    result.classes[cls].deltaCI95 = [+lo.toFixed(4), +hi.toFixed(4)];
    deltaStr = `  vs base ${(bHits / items.length).toFixed(3)}  ΔCI[${lo.toFixed(3)}, ${hi.toFixed(3)}]`;
  }
  console.log(`${cls.padEnd(24)} ${recall.toFixed(3)} (n=${items.length}) ${JSON.stringify(buckets)}${deltaStr}`);
}
console.log(`\n== negatives (fire rate per shape) ==`);
for (const shape of shapes) {
  const items = slice.filter((r) => r.kind === "negative" && r.shape === shape);
  const fired = items.filter((it) => A.get(it.uid)?.fired).length;
  result.negatives[shape] = { n: items.length, fired, rate: +(fired / items.length).toFixed(4) };
  const bStr = B ? `  vs base ${items.filter((it) => B.get(it.uid)?.fired).length}` : "";
  console.log(`${shape.padEnd(24)} ${fired}/${items.length}${bStr}`);
}
const outBase = path.basename(RUN).replace(/\.jsonl$/, "");
fs.writeFileSync(path.join(ART, `phase15-evalscore-${outBase}.json`), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(ART, `phase15-evaladjq-${outBase}.jsonl`),
  adjq.map((r) => JSON.stringify(r)).join("\n") + (adjq.length ? "\n" : ""), { mode: 0o600 });
console.log(`\nwrote phase15-evalscore-${outBase}.json; adjudication queue ${adjq.length} rows`);
