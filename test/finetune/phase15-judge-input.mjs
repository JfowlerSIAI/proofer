#!/usr/bin/env node
// Phase 1.5: route teacher outputs to the Terra judge (plan stage 3).
//
//   node phase15-judge-input.mjs
//
// Reads phase15-teacherout-{armB,negtop}.jsonl and writes
// phase15-judge-input.jsonl with every CHANGED, guard-applied teacher target —
// the D1 rule: a changed target with no verdict may never become supervision,
// while a no-op needs screens + teacher-clean only (v1 precedent, §6.3).
// evalparents/evalneg outputs are deliberately NOT judged: an applied row
// there just disqualifies the sentence as a certified-clean parent.
//
// Output shape is judge-harness.mjs's input contract: {uid, context, input,
// output} (context_window on the teacher row is the production-trimmed
// context, which is what the judge prompt wants to see).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fail } from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");

const rows = [];
const stats = {};
for (const name of ["armB", "negtop"]) {
  const p = path.join(ART, `phase15-teacherout-${name}.jsonl`);
  if (!fs.existsSync(p)) fail(`missing ${p} — teacher pass incomplete`);
  let judged = 0, noop = 0, refused = 0, error = 0;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.error || r.malformed) { error++; continue; }
    if (r.outcome === "no-op") { noop++; continue; }
    if (r.guard !== "applied") { refused++; continue; }
    if (r.rewritten == null || r.rewritten.trim() === r.sentence.trim()) { noop++; continue; }
    rows.push({ uid: r.uid, context: r.context_window ?? "", input: r.sentence, output: r.rewritten });
    judged++;
  }
  stats[name] = { judged, noop, refused, error };
}
fs.writeFileSync(path.join(ART, "phase15-judge-input.jsonl"),
  rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
console.log(`judge input rows ${rows.length}`);
console.log(JSON.stringify(stats, null, 1));
