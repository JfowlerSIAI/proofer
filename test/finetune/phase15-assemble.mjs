#!/usr/bin/env node
// Phase 1.5 Arm A assembler for the optional targeted fine-tuning study.
//
//   node phase15-assemble.mjs [--seed 20260825] [--base <v1 dataset.jsonl>]
//
// MECHANICAL BY DESIGN: unlike build-pilot-dataset.mjs, injected rows here do
// NOT go through the teacher or the judge. The parent is an already-certified
// clean sentence (a v1 identity/hard-negative row), the transform is reversible
// by contract (error-inject.mjs self-asserts restore()), so the gold target IS
// the parent. The teacher-mediated path measured 953/1107 agreement with the
// mechanical truth on v1 — it adds noise here, not information. What replaces
// the teacher is the shipping guard chain: the exact repair (damaged -> parent)
// must be APPLY through guardSentenceResult, else the row goes to a diagnostic
// file, never to training.
//
// MATCHED NEGATIVES are v1 identity rows re-emitted under a new uid with a
// mechanism tag: a deliberate second exposure of the tempting-but-clean shape,
// so no boosted shape trains at >50% injected prevalence. They are drawn from
// rows NOT used as injection parents for the same class (an injection parent
// is already its own matched negative — the model sees P->P and P'->P).
//
// HOMOPHONE FAMILY HOLDOUT: ~20% of licensed confusable families (by hash of
// the sorted bare pair) are reserved for the fresh eval slice and excluded from
// BOTH injection and negatives here. The manifest is written for stage 6.
//
// CASING per owner ruling 2026-08-25: deliberate lowercase is benign-optional,
// so positives come from all registers; the negatives are the two real hazards
// (hard-wrap continuations, brand/acronym/code casing), NOT deliberate
// lowercase.
//
// LEAKAGE: every emitted row inherits its parent's lineage cluster and split,
// so no augmentation can straddle the train/validation line and the v1 pool's
// reservation guarantees carry over. Asserted: uid uniqueness against the base
// and within the output.
//
// Counts only on stdout. Artifacts 0600: phase15-armA.jsonl,
// phase15-armA-refused.jsonl, phase15-armA-report.json,
// phase15-eval-reserved-families.json.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { inject, restore } from "./error-inject.mjs";
import {
  guardSentenceResult, fetchConfusables, setConfusables, diskFetch,
  CONFUSABLE, isWord,
} from "../lib/sentence-guards.mjs";
import { mulberry32, argOf, fail } from "./verdicts.mjs";
import { shapeScreens, bareTok } from "./phase15-screens.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const SEED = Number(argOf("--seed") ?? 20260825);
const BASE = argOf("--base") ?? path.join(ART, "pilot-dataset.v2-preR3.bak.jsonl");

const INJECT_QUOTA = {
  "doubled-word": 200,
  "homophone-confusable": 240,
  "dropped-apostrophe": 180,
  "terminator": 160,
  "moved-space": 160,
  "casing": 120,
};
// Matched clean negatives per class, plus the global anti-meddling shapes.
const NEG_QUOTA = {
  "doubled-word": 300,
  "homophone-confusable": 240,
  "dropped-apostrophe": 225,
  "terminator": 240,
  "moved-space": 200,
  "casing-hardwrap": 90,
  "casing-brand": 90,
  "quote-boundary": 48,
  "code-token": 48,
  "hardwrap-extra": 56,
  "british-spelling": 32,
};
const REGISTER_CAP = 0.5; // no class quota takes >50% from one register

// ---------------------------------------------------------------- load base
if (!fs.existsSync(BASE)) fail(`base dataset not found: ${BASE}`);
const base = fs.readFileSync(BASE, "utf8").split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l));
const baseUids = new Set(base.map((r) => r.uid));
if (baseUids.size !== base.length) fail("base dataset has duplicate uids");
const parents = base.filter((r) => r.kind === "identity" || r.kind === "hard-negative");
console.log(`base rows ${base.length}, certified clean parents ${parents.length}`);

// ------------------------------------------------- confusables + family holdout
const generated = await fetchConfusables(diskFetch());
if (generated === null) fail("confusables artifact failed its integrity check — refusing to build");
setConfusables(generated);
const allPairs = new Set([...CONFUSABLE, ...generated]);
const familyOf = (a, b) => [bareTok(a), bareTok(b)].sort().join("|");
const families = new Set();
for (const p of allPairs) {
  const [t, m] = p.split("|");
  if (t && m) families.add(familyOf(t, m));
}
const famHash = (f) => parseInt(createHash("sha256").update("phase15/" + f).digest("hex").slice(0, 8), 16);
const evalFamilies = new Set([...families].filter((f) => famHash(f) % 5 === 0));
console.log(`confusable families ${families.size}, reserved for eval ${evalFamilies.size}`);

// ---------------------------------------------------------------- helpers
const rng = mulberry32(SEED);
const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const uidOf = (parent, variant) => "p15_" + createHash("sha256")
  .update(`phase15/v1\0${parent.uid}\0${variant}`).digest("hex").slice(0, 16);
const emitRow = (parent, variant, kind, input, target, mechanism) => ({
  uid: uidOf(parent, variant),
  lineage: { ...parent.lineage, variant },
  register: parent.register,
  kind,
  context: parent.context ?? "",
  input,
  target,
  card: { ...parent.card, mechanism, arm: "A", phase15: true, parent_uid: parent.uid },
});

// ------------------------------------------------------------ injection pass
const out = [], refused = [], report = { seed: SEED, base: path.basename(BASE), inject: {}, negatives: {}, shortfalls: [] };
const usedAsParent = new Map(); // class -> Set<uid>

for (const [cls, quota] of Object.entries(INJECT_QUOTA)) {
  const cap = Math.ceil(quota * REGISTER_CAP);
  const byReg = {};
  const used = new Set();
  usedAsParent.set(cls, used);
  let made = 0, refusedN = 0, familySkipped = 0;
  for (const p of shuffled(parents)) {
    if (made >= quota) break;
    if ((byReg[p.register] ?? 0) >= cap) continue;
    const res = inject(cls, p.input, rng);
    if (!res) continue;
    if (restore(res.damaged, res.groups) !== p.input) fail(`${cls}: restore mismatch on parent ${p.uid}`);
    if (cls === "homophone-confusable") {
      const g = res.groups[0];
      if (evalFamilies.has(familyOf(g.before, g.alternatives[0].replacement))) { familySkipped++; continue; }
    }
    const verdict = guardSentenceResult(res.damaged, p.input, p.input);
    if (verdict !== null) {
      refusedN++;
      refused.push({ cls, parent_uid: p.uid, reason: verdict });
      continue;
    }
    out.push(emitRow(p, `phase15-inj:${cls}`, `injected:${cls}`, res.damaged, p.input,
      `phase15-armA inject:${cls}`));
    used.add(p.uid);
    byReg[p.register] = (byReg[p.register] ?? 0) + 1;
    made++;
  }
  report.inject[cls] = { quota, made, guardRefused: refusedN, familySkipped, byRegister: byReg };
  if (made < quota) report.shortfalls.push(`inject:${cls} ${made}/${quota}`);
}

// ------------------------------------------------------------ negative screens
const hasConfusableTok = (s) => {
  for (const w of String(s).split(/\s+/)) {
    const b = bareTok(w);
    if (!b) continue;
    for (const p of allPairs) {
      const [t, m] = p.split("|");
      if (b === t || b === m) return !evalFamilies.has(familyOf(t, m));
    }
  }
  return false;
};
const RAW_SCREENS = shapeScreens({ hasConfusableTok });
const SCREENS = Object.fromEntries(Object.entries(RAW_SCREENS).map(([k, f]) => [
  k, (r) => f({ text: r.input, segmenterProduced: r.lineage?.segmenter_produced === true }),
]));

const negUsed = new Set(); // one negative exposure per base row across ALL shapes
for (const [shape, quota] of Object.entries(NEG_QUOTA)) {
  const cls = shape.startsWith("casing") ? "casing" : shape;
  const injParents = usedAsParent.get(cls) ?? new Set();
  let made = 0;
  for (const p of shuffled(parents)) {
    if (made >= quota) break;
    if (negUsed.has(p.uid) || injParents.has(p.uid)) continue;
    if (!SCREENS[shape](p)) continue;
    out.push(emitRow(p, `phase15-neg:${shape}`, "identity", p.input, p.input,
      `phase15-armA negative:${shape}`));
    negUsed.add(p.uid);
    made++;
  }
  report.negatives[shape] = { quota, made };
  if (made < quota) report.shortfalls.push(`negative:${shape} ${made}/${quota}`);
}

// ------------------------------------------------------------ assertions + write
const outUids = new Set(out.map((r) => r.uid));
if (outUids.size !== out.length) fail("duplicate uid within Arm A output");
for (const u of outUids) if (baseUids.has(u)) fail(`uid collision with base: ${u}`);
for (const r of out) {
  if (r.kind.startsWith("injected:") && guardSentenceResult(r.input, r.target, r.target) !== null) {
    fail(`emitted injected row fails guards: ${r.uid}`);
  }
  if (!r.lineage.split || r.lineage.cluster == null) fail(`row without split/cluster: ${r.uid}`);
}
const splitCount = { train: 0, validation: 0 };
for (const r of out) splitCount[r.lineage.split] = (splitCount[r.lineage.split] ?? 0) + 1;
report.total = out.length;
report.splits = splitCount;
// Injected prevalence per boosted shape (plan: <=50%).
for (const cls of Object.keys(INJECT_QUOTA)) {
  const inj = report.inject[cls].made;
  const neg = Object.entries(report.negatives)
    .filter(([s]) => (s.startsWith("casing") ? "casing" : s) === cls)
    .reduce((s, [, v]) => s + v.made, 0);
  report.inject[cls].injectedPrevalence = inj / Math.max(1, inj + neg);
}

const write = (name, body) => {
  const f = path.join(ART, name);
  fs.writeFileSync(f, body, { mode: 0o600 });
  console.log(`wrote ${name} (${body.length} bytes)`);
};
write("phase15-armA.jsonl", out.map((r) => JSON.stringify(r)).join("\n") + "\n");
write("phase15-armA-refused.jsonl", refused.map((r) => JSON.stringify(r)).join("\n") + (refused.length ? "\n" : ""));
write("phase15-armA-report.json", JSON.stringify(report, null, 2) + "\n");
write("phase15-eval-reserved-families.json", JSON.stringify({ seed: SEED, families: [...evalFamilies].sort() }, null, 2) + "\n");

console.log(`\narmA rows ${out.length} (injected ${out.filter((r) => r.kind.startsWith("injected:")).length}, negatives ${out.filter((r) => r.kind === "identity").length})`);
console.log(`splits ${JSON.stringify(splitCount)}`);
if (report.shortfalls.length) {
  console.log(`SHORTFALLS (named, not silent): ${report.shortfalls.join("; ")}`);
} else {
  console.log("all quotas filled");
}
