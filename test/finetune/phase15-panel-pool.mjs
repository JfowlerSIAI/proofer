#!/usr/bin/env node
// Phase 1.5 clean safety panel draw (plan: gate battery §2).
//
//   node phase15-panel-pool.mjs [--seed 20260826]
//
// 6,000 source-disjoint sentences for the v1-vs-finalist clean-exposure panel:
// ~4,500 screened-cleanish plus ~1,500 hazard-shaped (150 per shape), all from
// documents absent from v1 training, the benchmark, every reservation, AND
// every phase15 teacher draw (training or eval) — the four teacher input files
// plus the eval doc reserve are read and excluded, so the panel cannot share a
// document with anything either model trained on or was selected against.
//
// NO TEACHER CERTIFICATION, deliberately: both models see the same sentence and
// only discordant edits are adjudicated, so a residual real error affects both
// symmetrically and the adjudicator resolves it (required-correction is not an
// unnecessary edit). Screens-only cleanliness is enough for a PAIRED panel;
// it would not be enough for gold labels, which is why the eval slice's
// parents DO go through the teacher.
//
// Output: phase15-panel.jsonl ({uid, sentence, context, shape|null, register,
// lineage fields}), phase15-panel-docreserve.json. Counts only on stdout.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { ircPool, enronPool, dictionaryRatioReject } from "./corpus-pools.mjs";
import { screen } from "./natural-screens.mjs";
import { loadExcluded } from "./build-pilot-dataset.mjs";
import { mulberry32, argOf, fail } from "./verdicts.mjs";
import { shapeScreens } from "./phase15-screens.mjs";
import { fetchConfusables, setConfusables, diskFetch } from "../lib/sentence-guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const SEED = Number(argOf("--seed") ?? 20260826);
const CLEAN_N = 4500, PER_SHAPE = 150;

const irc = await ircPool();
const enron = enronPool();
const items = [];
for (const [pool, register] of [[irc, "chat-irc"], [enron, "email-workplace"]]) {
  for (const it of pool.items) items.push({ ...it, register });
}

const { ids: reservedIds } = loadExcluded();
const excludedDocs = new Set(), excludedGroups = new Set();
const addJsonl = (file, docKey, groupKey) => {
  const p = path.join(ART, file);
  if (!fs.existsSync(p)) fail(`missing ${file} — run its producer first`);
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const doc = docKey(r), grp = groupKey(r);
    if (doc) excludedDocs.add(doc);
    if (grp) excludedGroups.add(grp);
  }
};
addJsonl("benchmark-frozen-v1.jsonl", (r) => r.source.source_document_id, (r) => r.source.exclusion_group_id);
addJsonl("pilot-dataset.v2-preR3.bak.jsonl", (r) => r.lineage.source_document_id, (r) => r.lineage.exclusion_group_id);
for (const f of ["phase15-teacher-evalparents.jsonl", "phase15-teacher-evalneg.jsonl",
  "phase15-teacher-armB.jsonl", "phase15-teacher-negtop.jsonl"]) {
  addJsonl(f, (r) => r.source_document_id, (r) => r.exclusion_group_id);
}
const reserve = JSON.parse(fs.readFileSync(path.join(ART, "phase15-eval-docreserve.json"), "utf8"));
for (const d of reserve.documents) excludedDocs.add(d);
for (const g of reserve.groups) excludedGroups.add(g);

const eligible = items.filter((it) => it.sentence && it.sentence.trim()
  && !reservedIds.has(String(it.source_document_id)) && !reservedIds.has(String(it.exclusion_group_id))
  && !excludedDocs.has(it.source_document_id) && !excludedGroups.has(it.exclusion_group_id));
console.log(`panel-eligible items ${eligible.length} of ${items.length}`);

setConfusables(await fetchConfusables(diskFetch()));
const SHAPES = shapeScreens({ hasConfusableTok: () => false });
const shapeOf = (it) => ({ text: it.sentence, segmenterProduced: it.segmenterProduced === true });

const rng = mulberry32(SEED);
const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const used = new Set();
const key = (it) => `${it.source_document_id}\0${it.segment_start}\0${it.segment_end}`;
const rows = [];
const take = (n, accept, shape) => {
  let got = 0;
  for (const it of shuffled(eligible)) {
    if (got >= n) break;
    if (used.has(key(it)) || !accept(it)) continue;
    used.add(key(it));
    rows.push({
      uid: "p15p_" + createHash("sha256").update(`phase15/panel\0${key(it)}`).digest("hex").slice(0, 16),
      sentence: it.sentence,
      context: it.context_2500 ?? "",
      shape: shape ?? null,
      register: it.register,
      source_document_id: it.source_document_id,
      exclusion_group_id: it.exclusion_group_id,
      segment: [it.segment_start, it.segment_end],
    });
    got++;
  }
  return got;
};

const cleanish = (it) => !dictionaryRatioReject(it.sentence)
  && screen(it.sentence).every((t) => t === "licensedConfusableSuspect");
const tally = {};
for (const [shape, fn] of Object.entries(SHAPES)) {
  if (shape === "homophone-confusable") continue;
  tally[shape] = take(PER_SHAPE, (it) => fn(shapeOf(it)) && !dictionaryRatioReject(it.sentence), shape);
}
tally.clean = take(CLEAN_N, cleanish, null);

fs.writeFileSync(path.join(ART, "phase15-panel.jsonl"),
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
const docs = new Set(rows.map((r) => r.source_document_id));
const groups = new Set(rows.map((r) => r.exclusion_group_id));
fs.writeFileSync(path.join(ART, "phase15-panel-docreserve.json"), JSON.stringify({
  seed: SEED, documents: [...docs].sort(), groups: [...groups].sort(),
}, null, 2) + "\n", { mode: 0o600 });
console.log(`panel rows ${rows.length}; docs ${docs.size}; per shape ${JSON.stringify(tally)}`);
const short = Object.entries(tally).filter(([k, v]) => v < (k === "clean" ? CLEAN_N : PER_SHAPE));
console.log(short.length ? `SHORTFALLS: ${short.map(([k, v]) => `${k} ${v}`).join("; ")}` : "panel quotas filled");
