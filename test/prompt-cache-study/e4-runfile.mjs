#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. test/finetune/benchrun-to-runfile.mjs with its
// artifact directory made a parameter (that script resolves
// test/harvested/finetune next to itself, which a git worktree does not have).
// Same join, same output schema (proofer-benchmark-run/v1), same skip rule.
//
//   node e4-runfile.mjs --in <e4 rows.jsonl> --out <runfile.jsonl> [--art <finetune artifact dir>]

import fs from "node:fs";
import path from "node:path";
import { benchmarkUid } from "../finetune/benchmark-schema.mjs";

const args = process.argv.slice(2);
const argOf = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const IN = argOf("--in"), OUT = argOf("--out");
const { FT } = await import("./paths.mjs");
const ART = argOf("--art", FT);
if (!IN || !OUT) { console.error("usage: --in <rows.jsonl> --out <runfile.jsonl>"); process.exit(2); }
const readJsonl = (p) => fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const candToBench = new Map();
for (const f of ["chat-irc", "chat-owner", "email-workplace", "forum-comments"])
  for (const c of readJsonl(path.join(ART, `benchmark-candidates-${f}.jsonl`)))
    candToBench.set(c.candidate_id, benchmarkUid(c.source.source_document_id, c.sentence));
const frozen = new Set(readJsonl(path.join(ART, "benchmark-frozen-v1.jsonl")).map((r) => r.uid));

const out = [];
let skippedDropped = 0, model = null;
for (const r of readJsonl(IN)) {
  const bu = candToBench.get(r.uid);
  if (!bu) { console.error("unmapped candidate:", r.uid); process.exit(1); }
  if (!frozen.has(bu)) { skippedDropped++; continue; }
  // the layout is part of the model identity for the scorer's report
  model = model ?? `${r.model} [${r.layout}]`;
  out.push(JSON.stringify({
    uid: bu, model, run_idx: 0,
    raw: r.raw ?? "", malformed: r.malformed === true || !!r.error,
    rewritten: (r.malformed || r.error) ? null : r.rewritten,
    guard: r.guard,
  }));
}
fs.writeFileSync(OUT, out.join("\n") + "\n", { mode: 0o600 });
console.log(`converted ${out.length} rows (${model}), skipped ${skippedDropped} not-in-frozen -> ${OUT}`);
