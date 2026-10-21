#!/usr/bin/env node
// Machine-labeled benchmark assembly (owner decision 2026-08-24, plan §4/§11):
// build the labeler's own decision-log shape from the hybrid pipeline, run the
// SHIPPING assembleAll over it, and split out what still needs the owner.
//
//   node bench-machine-labels.mjs
//
// Inputs (all under harvested/finetune/):
//   benchmark-candidates-*.jsonl        1,600 candidates (387 injected)
//   benchmark-teacher.jsonl             27B outputs over the 1,213 natural
//   benchmark-terra-v1.jsonl / -v4      the two judge passes (last-row-wins)
//   opus-benchmark-adjudications.jsonl  the contested band's verdicts
//
// Outputs:
//   benchmark-machine-decisions.jsonl   decision log (labeler shape)
//   benchmark-machine-records.jsonl     schema records via assembleAll
//   benchmark-owner-queue.jsonl         candidates a hard flag routed to owner
//   benchmark-validation-draw.jsonl     ~100-item stratified owner blind draw
//
// Tier logic mirrors hybrid-band.mjs: v1×v4 agree → that verdict (v4's named
// verdict); band (disagree or risk overlay) → Opus verdict; hard → owner.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleAll } from "./label-benchmark.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const KEEP = new Set(["required-correction", "benign-optional"]);
const readJsonl = (p) =>
  fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const writeJsonl = (p, rows) =>
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });

// --- load ------------------------------------------------------------------
const candidates = [];
for (const f of ["chat-irc", "chat-owner", "email-workplace", "forum-comments"])
  candidates.push(...readJsonl(path.join(ART, `benchmark-candidates-${f}.jsonl`)));

const teacher = new Map(readJsonl(path.join(ART, "benchmark-teacher.jsonl")).map((r) => [r.uid, r]));

function verdictMap(p) {
  const m = new Map(), groups = new Map();
  for (const r of readJsonl(p)) {
    for (const v of r.verdicts || []) m.set(r.uid + "#" + v.group, v.verdict);
    for (const g of r.groups || []) groups.set(r.uid + "#" + g.id, g);
  }
  return { m, groups };
}
const V1 = verdictMap(path.join(ART, "benchmark-terra-v1.jsonl"));
const V4 = verdictMap(path.join(ART, "benchmark-terra-v4.jsonl"));
const ADJ = new Map(readJsonl(path.join(ART, "opus-benchmark-adjudications.jsonl"))
  .map((r) => [r.uid + "#" + r.group, r]));

// --- per-group final verdict ----------------------------------------------
// A group is either: agree (v1/v4 same keep side) → v4's verdict;
// in the adjudicated band → Opus verdict (hard → null, owner).
function finalVerdict(key) {
  const a = ADJ.get(key);
  if (a) return a.hard ? null : { verdict: a.verdict, keep: a.keep, via: "opus" };
  const v1 = V1.m.get(key), v4 = V4.m.get(key);
  if (v1 === undefined || v4 === undefined) throw new Error("no verdict for " + key);
  if (KEEP.has(v1) !== KEEP.has(v4)) throw new Error("contested group missing from band: " + key);
  return { verdict: v4, keep: KEEP.has(v4), via: "agree" };
}

// --- build decisions -------------------------------------------------------
const decisions = new Map();
const ownerQueue = [];
let stats = { injected: 0, clean: 0, error: 0, optional: 0, owner: 0, refusedAll: 0 };

for (const c of candidates) {
  if (c.inject) {
    decisions.set(c.candidate_id, {
      candidate_id: c.candidate_id, action: "ERROR",
      corrected: c.inject.original, provenance: "machine-injected",
    });
    stats.injected++;
    continue;
  }
  const t = teacher.get(c.candidate_id);
  if (!t) throw new Error("no teacher row for " + c.candidate_id);
  if (!t.rewritten || t.rewritten === t.sentence) {
    decisions.set(c.candidate_id, { candidate_id: c.candidate_id, action: "CLEAN", provenance: "machine-teacher-noop" });
    stats.clean++;
    continue;
  }
  // judged: collect groups (same decomposition both judges saw)
  const groups = [];
  for (const [k, g] of V4.groups) if (k.startsWith(c.candidate_id + "#")) groups.push(g);
  groups.sort((a, b) => a.srcSpan[0] - b.srcSpan[0]);
  let hard = false;
  const kept = [];
  for (const g of groups) {
    const fv = finalVerdict(c.candidate_id + "#" + g.id);
    if (fv === null) { hard = true; break; }
    if (fv.keep) kept.push({ g, verdict: fv.verdict });
  }
  if (hard) {
    ownerQueue.push({ uid: c.candidate_id, context: c.context_2500 ?? "", input: t.sentence, output: t.rewritten });
    stats.owner++;
    continue;
  }
  if (!kept.length) {
    decisions.set(c.candidate_id, { candidate_id: c.candidate_id, action: "CLEAN", provenance: "machine-all-reverted" });
    stats.refusedAll++; stats.clean++;
    continue;
  }
  // splice kept groups (descending) into the source sentence
  let corrected = t.sentence;
  for (let i = kept.length - 1; i >= 0; i--) {
    const { g } = kept[i];
    corrected = corrected.slice(0, g.srcSpan[0]) + g.after + corrected.slice(g.srcSpan[1]);
  }
  if (corrected === t.sentence) { // kept groups were case/whitespace no-ops? shouldn't happen
    decisions.set(c.candidate_id, { candidate_id: c.candidate_id, action: "CLEAN", provenance: "machine-splice-noop" });
    stats.clean++;
    continue;
  }
  const allBenign = kept.every((k) => k.verdict === "benign-optional");
  decisions.set(c.candidate_id, {
    candidate_id: c.candidate_id,
    action: allBenign ? "OPTIONAL" : "ERROR",
    corrected, provenance: "machine-hybrid",
  });
  if (allBenign) stats.optional++; else stats.error++;
}

console.log("decisions:", decisions.size, " ownerQueue:", ownerQueue.length);
console.log("stats:", JSON.stringify(stats));

writeJsonl(path.join(ART, "benchmark-machine-decisions.jsonl"), [...decisions.values()]);
writeJsonl(path.join(ART, "benchmark-owner-queue.jsonl"), ownerQueue);

// --- assemble through the shipping path ------------------------------------
const inScope = candidates.filter((c) => decisions.has(c.candidate_id));
const { records, skipped, errors } = assembleAll(inScope, decisions, { benchmark_version: "machine-v1-2026-08-24" });
if (errors?.length) {
  for (const e of errors.slice(0, 10)) console.error("ASSEMBLE ERROR:", JSON.stringify(e).slice(0, 200));
  console.error("assembly errors:", errors.length);
  process.exit(1);
}
console.log("assembled records:", records.length, " skipped:", skipped?.length ?? 0);
writeJsonl(path.join(ART, "benchmark-machine-records.jsonl"), records);

// --- owner validation draw: ~100, stratified -------------------------------
// Emitted in CANDIDATE shape as a pseudo-register, so the owner labels it with
// label-benchmark.mjs itself (--register validation) — same keys, same
// prefills, blind by construction (the tool never shows machine decisions;
// natural items prefill the raw sentence, injected items their mechanical
// original). The comparison is owner decisions vs benchmark-machine-decisions.
// Strata: source × injected/natural × machine action. Deterministic seed.
let s = 20260825;
const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
const byStratum = new Map();
for (const c of inScope) {
  const d = decisions.get(c.candidate_id);
  const stratum = `${c.source?.register ?? "?"}|${c.inject ? "inj" : "nat"}|${d.action}`;
  if (!byStratum.has(stratum)) byStratum.set(stratum, []);
  byStratum.get(stratum).push(c);
}
const TARGET = 100;
const total = inScope.length;
const draw = [];
for (const [, rows] of [...byStratum.entries()].sort()) {
  const n = Math.max(1, Math.round((rows.length / total) * TARGET));
  const idx = new Set();
  while (idx.size < Math.min(n, rows.length)) idx.add(Math.floor(rnd() * rows.length));
  for (const i of idx) draw.push(rows[i]); // full candidate row, untouched
}
writeJsonl(path.join(ART, "benchmark-candidates-validation.jsonl"), draw);
console.log("validation draw:", draw.length, "candidates over", byStratum.size, "strata",
  "-> benchmark-candidates-validation.jsonl (label with --register validation)");
