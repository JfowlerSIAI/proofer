#!/usr/bin/env node
// Phase 1.5 fresh targeted eval slice (plan gate battery §1).
//
//   node phase15-evalslice.mjs [--seed 20260828]
//
// Positives: 100 per target class, injected into TEACHER-CERTIFIED clean
// parents drawn from the eval document reserve (disjoint from all training by
// the docreserve manifests), with THREE certifications on every parent:
// screens-clean at draw, qwen no-op (teacher pass), and pilot-v1 no-op
// (phase15-pilotcheck-evalparents.jsonl — REQUIRED input; the 27B teacher that
// certified v1's parents is no longer installed, so two independent models
// stand in for it; deviation disclosed in the report). The pilot-no-op
// requirement applies ONLY to injection parents — gold-label correctness needs
// certainty — and deliberately NOT to negatives, whose measurement is the
// models' edit rate on tempting-clean text and which would be biased to zero
// for v1 by selecting on v1's own no-ops.
//
// Every positive's repair is required to pass the shipping guards, mirroring
// the training filter: the slice measures the model on GUARD-REACHABLE shapes,
// and that restriction is disclosed (the guard-capped residual is a separate
// finding, not this instrument's subject). Homophone positives use ONLY the
// eval-reserved confusable families (training used only the others).
//
// Negatives: every teacher-certified no-op from the evalneg draw, shape-tagged.
//
// Output rows: {uid, kind: "positive"|"negative", class|shape, sentence,
// context, gold, register, parent_uid} — teacher-pass.mjs input shape, so the
// same runner that did the teacher pass runs the models over the slice.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { inject, restore } from "./error-inject.mjs";
import { mulberry32, argOf, fail } from "./verdicts.mjs";
import { bareTok } from "./phase15-screens.mjs";
import {
  guardSentenceResult, fetchConfusables, setConfusables, diskFetch,
} from "../lib/sentence-guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const SEED = Number(argOf("--seed") ?? 20260828);
const PER_CLASS = 100;
const CLASSES = ["doubled-word", "casing", "terminator", "homophone-confusable", "dropped-apostrophe", "moved-space"];

setConfusables(await fetchConfusables(diskFetch()));
const readJsonl = (name) => {
  const p = path.join(ART, name);
  if (!fs.existsSync(p)) fail(`missing ${p}`);
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};

const evalFamilies = new Set(JSON.parse(
  fs.readFileSync(path.join(ART, "phase15-eval-reserved-families.json"), "utf8")).families);
const familyOf = (a, b) => [bareTok(a), bareTok(b)].sort().join("|");

// Certified parents: qwen no-op AND pilot no-op.
const pilotNoop = new Set();
for (const r of readJsonl("phase15-pilotcheck-evalparents.jsonl")) {
  if (!r.error && !r.malformed && r.outcome === "no-op") pilotNoop.add(r.uid);
}
const parents = readJsonl("phase15-teacherout-evalparents.jsonl")
  .filter((r) => !r.error && !r.malformed && r.outcome === "no-op" && pilotNoop.has(r.uid));
console.log(`certified injection parents (screens + qwen no-op + pilot no-op): ${parents.length}`);

const rng = mulberry32(SEED);
const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const rows = [];
const report = { seed: SEED, positives: {}, negatives: {}, parentPool: parents.length, disclosed: [
  "teacher for certification is qwen3.5:9b (the v1-era 27B is uninstalled); parents additionally require pilot-v1 no-op",
  "positives are guard-reachable shapes only, mirroring the training filter",
  "pilot-no-op certification applies to injection parents only, never to negatives",
] };
const usedParent = new Set();
for (const cls of CLASSES) {
  let made = 0, guardRefused = 0, famRejected = 0;
  for (const p of shuffled(parents)) {
    if (made >= PER_CLASS) break;
    if (usedParent.has(p.uid)) continue;
    const res = inject(cls, p.sentence, rng);
    if (!res) continue;
    if (restore(res.damaged, res.groups) !== p.sentence) fail(`${cls}: restore mismatch`);
    if (cls === "homophone-confusable") {
      const g = res.groups[0];
      if (!evalFamilies.has(familyOf(g.before, g.alternatives[0].replacement))) { famRejected++; continue; }
    }
    if (guardSentenceResult(res.damaged, p.sentence, p.sentence) !== null) { guardRefused++; continue; }
    usedParent.add(p.uid);
    rows.push({
      uid: "p15e_" + createHash("sha256").update(`phase15/eval\0${p.uid}\0${cls}`).digest("hex").slice(0, 16),
      kind: "positive", class: cls,
      sentence: res.damaged,
      context: r_ctx(p),
      gold: p.sentence,
      register: p.passthrough.register,
      parent_uid: p.uid,
    });
    made++;
  }
  report.positives[cls] = { made, guardRefused, famRejected };
}
function r_ctx(p) { return p.context_window ?? ""; }

for (const r of readJsonl("phase15-teacherout-evalneg.jsonl")) {
  if (r.error || r.malformed || r.outcome !== "no-op") continue;
  rows.push({
    uid: "p15e_" + createHash("sha256").update(`phase15/eval\0${r.uid}\0neg`).digest("hex").slice(0, 16),
    kind: "negative", shape: r.passthrough.shape,
    sentence: r.sentence,
    context: r.context_window ?? "",
    gold: r.sentence,
    register: r.passthrough.register,
    parent_uid: r.uid,
  });
  report.negatives[r.passthrough.shape] = (report.negatives[r.passthrough.shape] ?? 0) + 1;
}

const uids = new Set(rows.map((r) => r.uid));
if (uids.size !== rows.length) fail("duplicate uid in eval slice");
fs.writeFileSync(path.join(ART, "phase15-evalslice.jsonl"),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(ART, "phase15-evalslice-report.json"),
  JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const pos = rows.filter((r) => r.kind === "positive").length;
console.log(`eval slice ${rows.length} rows (${pos} positives, ${rows.length - pos} negatives)`);
console.log(JSON.stringify(report.positives, null, 1));
const short = CLASSES.filter((c) => report.positives[c].made < PER_CLASS);
console.log(short.length ? `SHORTFALLS: ${short.map((c) => `${c} ${report.positives[c].made}/${PER_CLASS}`).join("; ")}` : "all positive quotas filled");
