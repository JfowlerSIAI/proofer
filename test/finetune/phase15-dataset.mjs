#!/usr/bin/env node
// Phase 1.5 final dataset assembly (plan stage 4).
//
//   node phase15-dataset.mjs [--seed 20260827]
//
// Combines, in order:
//   v1 base           pilot-dataset.v2-preR3.bak.jsonl, untouched
//   Arm A             phase15-armA.jsonl (mechanical injections + re-emitted
//                     negatives; clusters inherited from v1 by construction)
//   Arm B             judged teacher corrections from phase15-teacherout-
//                     {armB,negtop}.jsonl x phase15-judge-verdicts.jsonl,
//                     D1 applied per group (keep required-correction and
//                     benign-optional; revert the rest; drop on damage/
//                     uncertain-only or quarantine)
//   negtop negatives  teacher-no-op rows for the four Arm A screen shortfalls
//   identity top-up   remaining certified no-ops until the identity slot
//                     reaches 60% of the final dataset
//
// GUARDS RE-ASKED AFTER REVERTS: the teacher row's `guard` was computed on the
// teacher's own output; a judge revert changes the target, so every kept
// correction is re-checked with guardSentenceResult(input, target) and a
// refusal drops the row (counted, named).
//
// CLUSTERS FOR FRESH ROWS: new sentences are clustered TOGETHER WITH all v1
// sentences (5-gram Jaccard >= 0.8 union-find). A new row landing in a cluster
// containing a v1 row inherits that row's cluster id and split — so a
// near-duplicate cannot straddle the train/validation line — and new-only
// clusters are split 85/15 by assignSplits.
//
// Counts only on stdout. Artifacts 0600: phase15-dataset.jsonl,
// phase15-dataset-report.json.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { applyGroups } from "./edit-groups.mjs";
import { clusterSentences, assignSplits, loadExcluded } from "./build-pilot-dataset.mjs";
import { mulberry32, argOf, fail, isKeepVerdict } from "./verdicts.mjs";
import {
  guardSentenceResult, fetchConfusables, setConfusables, diskFetch,
} from "../lib/sentence-guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const SEED = Number(argOf("--seed") ?? 20260827);
const IDENTITY_SLOT_TARGET = 0.60;
const NEG_TOPUP_NEED = { "doubled-word": 298, "terminator": 214, "moved-space": 100, "british-spelling": 22 };

setConfusables(await fetchConfusables(diskFetch()));
const readJsonl = (name) => {
  const p = path.join(ART, name);
  if (!fs.existsSync(p)) fail(`missing ${p}`);
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};

const v1 = readJsonl("pilot-dataset.v2-preR3.bak.jsonl");
const armA = readJsonl("phase15-armA.jsonl");
const verdictByUid = new Map();
for (const r of readJsonl("phase15-judge-verdicts.jsonl")) {
  if (r.type) continue; // quarantine-since markers
  verdictByUid.set(r.uid, r);
}

// -------------------------------------------- judged corrections + no-op pools
const rng = mulberry32(SEED);
const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const report = {
  seed: SEED, corrections: {}, drops: { quarantined: 0, damage: 0, uncertain: 0, unjudged: 0, guardAfterRevert: 0 },
  negatives: {}, identityTopup: 0,
};
const corrections = [], noopPool = [];
for (const name of ["armB", "negtop"]) {
  for (const r of readJsonl(`phase15-teacherout-${name}.jsonl`)) {
    if (r.error || r.malformed) continue;
    const base = {
      teacherRow: name,
      sentence: r.sentence,
      context: (r.passthrough?.context ?? r.context_window) ?? "",
      register: r.passthrough.register,
      source_document_id: r.passthrough.source_document_id,
      exclusion_group_id: r.passthrough.exclusion_group_id,
      segment: r.passthrough.segment,
      segmenterProduced: r.passthrough.segmenterProduced === true,
      shape: r.passthrough.shape ?? null,
      wanted: r.passthrough.wanted ?? null,
      uid: r.uid,
    };
    const changed = r.outcome !== "no-op" && r.guard === "applied"
      && r.rewritten != null && r.rewritten.trim() !== r.sentence.trim();
    if (!changed) {
      if (r.outcome === "no-op") noopPool.push(base);
      continue; // guard-refused teacher edits: sentence unverified, unusable either way
    }
    const j = verdictByUid.get(r.uid);
    if (!j) { report.drops.unjudged++; continue; }
    if (j.quarantined) { report.drops.quarantined++; continue; }
    const vOf = new Map((j.verdicts ?? []).map((v) => [v.group, v.verdict]));
    const keepIds = (j.groups ?? []).filter((g) => isKeepVerdict(vOf.get(g.id))).map((g) => g.id);
    const rejected = (j.groups ?? []).filter((g) => !isKeepVerdict(vOf.get(g.id)));
    if (!keepIds.length) {
      if (rejected.every((g) => vOf.get(g.id) === "unnecessary")) noopPool.push(base);
      else if (rejected.some((g) => vOf.get(g.id) === "meaning-damage")) report.drops.damage++;
      else report.drops.uncertain++;
      continue;
    }
    if (rejected.some((g) => vOf.get(g.id) === "meaning-damage")) { report.drops.damage++; continue; }
    const target = applyGroups(base.sentence, j.groups, keepIds);
    if (target.trim() === base.sentence.trim()) { noopPool.push(base); continue; }
    if (guardSentenceResult(base.sentence, target, target) !== null) { report.drops.guardAfterRevert++; continue; }
    corrections.push({ ...base, target });
    const cls = base.wanted ?? `negtop:${base.shape}`;
    report.corrections[cls] = (report.corrections[cls] ?? 0) + 1;
  }
}
console.log(`judged corrections kept ${corrections.length}; certified no-op pool ${noopPool.length}`);
console.log(`drops ${JSON.stringify(report.drops)}`);

// ------------------------------------------------------- negatives + identity
const negatives = [], identities = [];
const negTaken = Object.fromEntries(Object.keys(NEG_TOPUP_NEED).map((k) => [k, 0]));
for (const b of shuffled(noopPool)) {
  const need = b.shape && NEG_TOPUP_NEED[b.shape] != null && negTaken[b.shape] < NEG_TOPUP_NEED[b.shape];
  if (need) { negatives.push(b); negTaken[b.shape]++; } else identities.push(b);
}
report.negatives = negTaken;

// ---------------------------------------------------------- clusters + splits
// Cluster new rows together with every v1 sentence so near-dups inherit.
const newBases = [...corrections, ...negatives, ...identities];
const allTexts = [...v1.map((r) => r.input), ...newBases.map((b) => b.sentence)];
const clusters = clusterSentences(allTexts);
const v1N = v1.length;
const clusterToV1 = new Map(); // computed cluster -> {cluster, split} of first v1 member
for (let i = 0; i < v1N; i++) {
  const c = clusters[i];
  if (!clusterToV1.has(c)) clusterToV1.set(c, { cluster: v1[i].lineage.cluster, split: v1[i].lineage.split });
}
const freshRows = [];
for (let k = 0; k < newBases.length; k++) {
  const c = clusters[v1N + k];
  freshRows.push({ base: newBases[k], computed: c, inherit: clusterToV1.get(c) ?? null });
}
const newOnly = freshRows.filter((f) => !f.inherit);
const splitByCluster = assignSplits(
  newOnly.map((f) => ({ cluster: f.computed, register: f.base.register })), 0.15, rng);
let inheritedSplit = 0;
for (const f of freshRows) {
  if (f.inherit) {
    f.cluster = f.inherit.cluster; f.split = f.inherit.split; inheritedSplit++;
  } else {
    f.cluster = `p15-${f.computed}`; f.split = splitByCluster.get(f.computed) ?? "train";
  }
}
console.log(`fresh rows ${freshRows.length}; inherited v1 cluster/split ${inheritedSplit}`);

// -------------------------------------------------------------- row emission
const REG_TO_SOURCE = { "chat-irc": "s2", "email-workplace": "s3", "chat-owner": "s1" };
const LICENSE_OF = {
  s2: "Public Domain (common-pile/ubuntu_irc_filtered)",
  s3: "public record, no formal dedication — owner-accepted risk (§6.2)",
};
const mkRow = (f, kind, target, mechanism, arm) => {
  const b = f.base;
  const src = REG_TO_SOURCE[b.register];
  return {
    uid: "p15_" + createHash("sha256").update(`phase15/fresh\0${b.uid}\0${kind}`).digest("hex").slice(0, 16),
    lineage: {
      source_document_id: b.source_document_id,
      exclusion_group_id: b.exclusion_group_id,
      sentence: b.sentence,
      segment: b.segment,
      segmenter_produced: b.segmenterProduced,
      variant: mechanism,
      cluster: f.cluster,
      split: f.split,
    },
    register: b.register,
    kind,
    // v1 trained with a 500-char context window (build-pilot-dataset
    // DEFAULT_WINDOW); fresh rows carry full pool contexts, and 2 of them
    // overflow the trainer's asserted max_seq 1024. Same trim, same recipe.
    context: String(b.context ?? "").slice(-500),
    input: b.sentence,
    target,
    // card.split duplicates lineage.split because pilot-train.py reads the
    // split from the card (v1 rows carry it in both places).
    card: { source: src, license: LICENSE_OF[src], register: b.register, mechanism, arm, phase15: true, teacher: "qwen3.5:9b", split: f.split },
  };
};
const role = new Map();
for (const b of corrections) role.set(b, "correction");
for (const b of negatives) role.set(b, "negative");
const newRows = [];
for (const f of freshRows) {
  const b = f.base;
  if (role.get(b) === "correction") {
    newRows.push(mkRow(f, "real-error", b.target, `phase15-armB real:${b.wanted ?? b.shape}`, "B"));
  } else if (role.get(b) === "negative") {
    newRows.push(mkRow(f, "identity", b.sentence, `phase15-armA negative-topup:${b.shape}`, "A"));
  }
}
// identity top-up to the 60% slot, computed on the FINAL total.
const idFresh = freshRows.filter((f) => !role.has(f.base));
const slotOf = (rows) => rows.filter((r) => r.kind === "identity" || r.kind === "hard-negative").length;
const baseSlot = slotOf(v1) + slotOf(armA) + newRows.filter((r) => r.kind === "identity").length;
const baseTotal = v1.length + armA.length + newRows.length;
// (slot + x) / (total + x) = target  =>  x = (target*total - slot) / (1 - target)
let topup = Math.ceil(Math.max(0, (IDENTITY_SLOT_TARGET * baseTotal - baseSlot) / (1 - IDENTITY_SLOT_TARGET)));
topup = Math.min(topup, idFresh.length);
for (const f of shuffled(idFresh).slice(0, topup)) {
  newRows.push(mkRow(f, "identity", f.base.sentence, "phase15-rebalance teacher-clean", "rebalance"));
}
report.identityTopup = topup;
report.identityTopupAvailable = idFresh.length;

// ----------------------------------------------------------- assemble + assert
const all = [...v1, ...armA, ...newRows];
const uids = new Set();
for (const r of all) {
  if (uids.has(r.uid)) fail(`duplicate uid ${r.uid}`);
  uids.add(r.uid);
}
const { ids: reservedIds } = loadExcluded();
const evalReserve = JSON.parse(fs.readFileSync(path.join(ART, "phase15-eval-docreserve.json"), "utf8"));
const panelReserve = JSON.parse(fs.readFileSync(path.join(ART, "phase15-panel-docreserve.json"), "utf8"));
const forbidden = new Set([...evalReserve.documents, ...panelReserve.documents]);
const forbiddenGroups = new Set([...evalReserve.groups, ...panelReserve.groups]);
for (const line of fs.readFileSync(path.join(ART, "benchmark-frozen-v1.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  forbidden.add(r.source.source_document_id);
  forbiddenGroups.add(r.source.exclusion_group_id);
}
for (const r of newRows) {
  const d = r.lineage.source_document_id, g = r.lineage.exclusion_group_id;
  if (forbidden.has(d) || forbiddenGroups.has(g)) fail(`fresh row from forbidden document: ${d}`);
  if (reservedIds.has(String(d)) || reservedIds.has(String(g))) fail(`fresh row from reserved id: ${d}`);
}

const finalSlot = slotOf(all);
report.total = all.length;
report.identitySlotShare = +(finalSlot / all.length).toFixed(4);
report.kinds = {};
for (const r of all) report.kinds[r.kind] = (report.kinds[r.kind] ?? 0) + 1;
report.splits = {};
for (const r of all) report.splits[r.lineage.split] = (report.splits[r.lineage.split] ?? 0) + 1;

fs.writeFileSync(path.join(ART, "phase15-dataset.jsonl"),
  all.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
fs.writeFileSync(path.join(ART, "phase15-dataset-report.json"),
  JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(`dataset ${all.length} rows (v1 ${v1.length} + armA ${armA.length} + fresh ${newRows.length})`);
console.log(`identity slot ${finalSlot} (${(100 * finalSlot / all.length).toFixed(1)}%), top-up ${topup}/${idFresh.length} available`);
console.log(`splits ${JSON.stringify(report.splits)}`);
const short = Object.entries(NEG_TOPUP_NEED).filter(([k, n]) => negTaken[k] < n);
console.log(short.length ? `NEG SHORTFALLS: ${short.map(([k, n]) => `${k} ${negTaken[k]}/${n}`).join("; ")}` : "negative top-ups filled");
