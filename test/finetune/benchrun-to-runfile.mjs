#!/usr/bin/env node
// Convert a teacher-pass output over benchmark-run-input.jsonl into the
// benchmark scorer's run-file schema (proofer-benchmark-run/v1).
//
//   node benchrun-to-runfile.mjs --in <benchrun.jsonl> --out <runfile.jsonl>
//
// The join: teacher-pass rows carry uid = candidate_id; the frozen benchmark
// keys records by benchmarkUid(source_document_id, sentence). Both live in the
// candidate files, so the mapping is derived, never guessed — a candidate_id
// with no benchmark record (the dropped `ubuttu` item) is skipped with a count,
// and any OTHER unmapped uid is an error.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkUid } from "./benchmark-schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const args = process.argv.slice(2);
const argOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const IN = argOf("--in"), OUT = argOf("--out");
if (!IN || !OUT) { console.error("usage: --in <benchrun.jsonl> --out <runfile.jsonl>"); process.exit(2); }

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
  model = model ?? r.model;
  out.push(JSON.stringify({
    uid: bu, model: r.model, run_idx: 0,
    raw: r.raw ?? "", malformed: r.malformed === true || !!r.error,
    rewritten: (r.malformed || r.error) ? null : r.rewritten,
    guard: r.guard,
  }));
}
fs.writeFileSync(OUT, out.join("\n") + "\n", { mode: 0o600 });
console.log(`converted ${out.length} rows (model ${model}), skipped ${skippedDropped} not-in-frozen -> ${OUT}`);
