#!/usr/bin/env node
// Phase 1.5 pool draw — candidate files for the optional targeted teacher pass.
//
//   node phase15-pool.mjs [--seed 20260825]
//
// FOUR OUTPUTS, one per purpose, all in teacher-pass.mjs input shape
// ({uid, sentence, context} + passthrough fields):
//
//   phase15-teacher-evalparents.jsonl  fresh-slice CLEAN parents — drawn ONLY
//                                      from the eval document reserve (documents
//                                      absent from v1 training, the benchmark,
//                                      and every reservation manifest)
//   phase15-teacher-evalneg.jsonl      fresh-slice negative parents (tempting
//                                      shapes), same reserve
//   phase15-teacher-armB.jsonl         Arm B error candidates: uniqueDamerau1-
//                                      screened (transposition) plus random
//                                      draws (other-natural fishing) — NON-
//                                      reserve documents (may share documents
//                                      with v1 training; both are training)
//   phase15-teacher-negtop.jsonl       training negative top-ups for the four
//                                      Arm A screen shortfalls (doubled-word
//                                      repetition, emphatic terminator,
//                                      moved-space join, British spelling)
//
// The eval reserve is chosen FIRST and written to phase15-eval-docreserve.json;
// training draws then exclude it, so document-level eval disjointness is a
// property of the manifests rather than of anybody's discipline.
//
// REGISTERS: chat-irc (S2) and email-workplace (S3) only. chat-owner is
// deliberately not drawn tonight — v1's 894 owner real-error rows carry that
// register in training, the frozen benchmark still measures it, and drawing
// fresh owner text at 1 am adds privacy surface for marginal coverage.
//
// Counts only on stdout. Artifacts 0600.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { ircPool, enronPool, dictionaryRatioReject } from "./corpus-pools.mjs";
import { screen } from "./natural-screens.mjs";
import { loadExcluded } from "./build-pilot-dataset.mjs";
import { mulberry32, argOf, fail } from "./verdicts.mjs";
import { shapeScreens } from "./phase15-screens.mjs";
import { CONFUSABLE, fetchConfusables, setConfusables, diskFetch } from "../lib/sentence-guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const SEED = Number(argOf("--seed") ?? 20260825);

const QUOTAS = {
  evalparents: 2600,
  evalneg: { perShape: 150 },
  armB: { transposition: 1400, "other-natural-fishing": 1500 },
  negtop: { "doubled-word": 700, "terminator": 500, "moved-space": 250, "british-spelling": 80 },
};

// ---------------------------------------------------------------- load pools
console.log("loading pools...");
const irc = await ircPool();
const enron = enronPool();
const items = [];
for (const [pool, register] of [[irc, "chat-irc"], [enron, "email-workplace"]]) {
  for (const it of pool.items) items.push({ ...it, register });
}
console.log(`pool items: ${items.length} (irc ${irc.items.length}, enron ${enron.items.length})`);

// ---------------------------------------------------------------- exclusions
const { ids: reservedIds } = loadExcluded();
const benchDocs = new Set(), benchGroups = new Set();
for (const line of fs.readFileSync(path.join(ART, "benchmark-frozen-v1.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  benchDocs.add(r.source.source_document_id);
  benchGroups.add(r.source.exclusion_group_id);
}
const v1Docs = new Set(), v1Groups = new Set();
for (const line of fs.readFileSync(path.join(ART, "pilot-dataset.v2-preR3.bak.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  v1Docs.add(r.lineage.source_document_id);
  v1Groups.add(r.lineage.exclusion_group_id);
}
const isReserved = (it) => reservedIds.has(String(it.source_document_id))
  || reservedIds.has(String(it.exclusion_group_id))
  || benchDocs.has(it.source_document_id) || benchGroups.has(it.exclusion_group_id);
const inV1 = (it) => v1Docs.has(it.source_document_id) || v1Groups.has(it.exclusion_group_id);

const usable = items.filter((it) => !isReserved(it) && it.sentence && it.sentence.trim());
const evalEligible = usable.filter((it) => !inV1(it));
const trainEligible = usable; // v1-doc overlap is fine for training draws
console.log(`usable ${usable.length}; eval-eligible (also v1-disjoint) ${evalEligible.length}`);

// ------------------------------------------------------------- shape screens
setConfusables(await fetchConfusables(diskFetch()));
const hasConfusableTok = () => false; // eval-family logic lives in stage 6; pool screens don't need it
const SHAPES = shapeScreens({ hasConfusableTok });
const shapeOf = (it) => ({ text: it.sentence, segmenterProduced: it.segmenterProduced === true });

// ---------------------------------------------------------------- draw logic
const rng = mulberry32(SEED);
const shuffled = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const uidOf = (it, purpose) => "p15c_" + createHash("sha256")
  .update(`phase15/pool\0${it.source_document_id}\0${it.segment_start}-${it.segment_end}\0${it.sentence}\0${purpose}`)
  .digest("hex").slice(0, 16);
const globalUsed = new Set();
const key = (it) => `${it.source_document_id}\0${it.segment_start}\0${it.segment_end}`;
const row = (it, purpose, extra) => ({
  uid: uidOf(it, purpose),
  sentence: it.sentence,
  context: it.context_2500 ?? "",
  purpose,
  register: it.register,
  source_document_id: it.source_document_id,
  exclusion_group_id: it.exclusion_group_id,
  segment: [it.segment_start, it.segment_end],
  segmenterProduced: it.segmenterProduced === true,
  ...extra,
});
// Register-balanced take: alternate registers while both have supply.
const takeBalanced = (cands, n, accept) => {
  const byReg = { "chat-irc": [], "email-workplace": [] };
  for (const it of shuffled(cands)) byReg[it.register]?.push(it);
  const taken = [];
  const idx = { "chat-irc": 0, "email-workplace": 0 };
  let turn = 0;
  while (taken.length < n) {
    const regs = ["chat-irc", "email-workplace"];
    let progressed = false;
    for (let k = 0; k < 2 && taken.length < n; k++) {
      const reg = regs[(turn + k) % 2];
      const list = byReg[reg];
      while (idx[reg] < list.length) {
        const it = list[idx[reg]++];
        if (globalUsed.has(key(it))) continue;
        if (accept && !accept(it)) continue;
        globalUsed.add(key(it));
        taken.push(it);
        progressed = true;
        break;
      }
    }
    turn++;
    if (!progressed) break; // both registers dry
  }
  return taken;
};

// ------------------------------------------- 1. eval document reserve + parents
// Clean parents: no screen tag other than the weak confusable-suspect one
// (which fires on ~60% of ordinary English — requiring zero tags would bias
// the clean slice toward atypical text), and the dictionary-ratio filter.
const cleanish = (it) => {
  if (dictionaryRatioReject(it.sentence)) return false;
  const tags = screen(it.sentence);
  return tags.every((t) => t === "licensedConfusableSuspect");
};
const evalParents = takeBalanced(evalEligible, QUOTAS.evalparents, cleanish);

const evalNeg = [];
for (const [shape, fn] of Object.entries(SHAPES)) {
  if (shape === "homophone-confusable") continue; // needs family state; stage 6 screens it
  const got = takeBalanced(evalEligible, QUOTAS.evalneg.perShape,
    (it) => fn(shapeOf(it)) && !dictionaryRatioReject(it.sentence));
  for (const it of got) evalNeg.push(row(it, "evalneg", { shape }));
}
// The reserve manifest is EVERY document/group any eval draw touched.
const reserveDocs = new Set(), reserveGroups = new Set();
for (const it of [...evalParents]) { reserveDocs.add(it.source_document_id); reserveGroups.add(it.exclusion_group_id); }
for (const r of evalNeg) { reserveDocs.add(r.source_document_id); reserveGroups.add(r.exclusion_group_id); }

// --------------------------------------------------- 2. Arm B error candidates
const notReserve = (it) => !reserveDocs.has(it.source_document_id) && !reserveGroups.has(it.exclusion_group_id);
const armB = [];
for (const it of takeBalanced(trainEligible, QUOTAS.armB.transposition,
  (it) => notReserve(it) && screen(it.sentence).includes("uniqueDamerau1"))) {
  armB.push(row(it, "armB", { wanted: "transposition" }));
}
for (const it of takeBalanced(trainEligible, QUOTAS.armB["other-natural-fishing"],
  (it) => notReserve(it) && !dictionaryRatioReject(it.sentence))) {
  armB.push(row(it, "armB", { wanted: "other-natural-fishing" }));
}

// --------------------------------------------------- 3. training negative top-ups
const negtop = [];
for (const [shape, n] of Object.entries(QUOTAS.negtop)) {
  const fn = SHAPES[shape];
  for (const it of takeBalanced(trainEligible, n,
    (it) => notReserve(it) && fn(shapeOf(it)) && !dictionaryRatioReject(it.sentence))) {
    negtop.push(row(it, "negtop", { shape }));
  }
}

// ---------------------------------------------------------------- write + report
const write = (name, rows) => {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  fs.writeFileSync(path.join(ART, name), body, { mode: 0o600 });
  console.log(`wrote ${name}: ${rows.length} rows`);
};
write("phase15-teacher-evalparents.jsonl", evalParents.map((it) => row(it, "evalparents", {})));
write("phase15-teacher-evalneg.jsonl", evalNeg);
write("phase15-teacher-armB.jsonl", armB);
write("phase15-teacher-negtop.jsonl", negtop);
fs.writeFileSync(path.join(ART, "phase15-eval-docreserve.json"), JSON.stringify({
  seed: SEED,
  documents: [...reserveDocs].sort(),
  groups: [...reserveGroups].sort(),
}, null, 2) + "\n", { mode: 0o600 });
console.log(`eval reserve: ${reserveDocs.size} documents, ${reserveGroups.size} groups`);

const tally = {};
for (const r of [...evalNeg, ...negtop]) tally[`${r.purpose}:${r.shape}`] = (tally[`${r.purpose}:${r.shape}`] ?? 0) + 1;
for (const r of armB) tally[`armB:${r.wanted}`] = (tally[`armB:${r.wanted}`] ?? 0) + 1;
console.log(JSON.stringify(tally, null, 1));
const short = [];
for (const [shape, n] of Object.entries(QUOTAS.negtop)) {
  if ((tally[`negtop:${shape}`] ?? 0) < n) short.push(`negtop:${shape} ${tally[`negtop:${shape}`] ?? 0}/${n}`);
}
if (evalParents.length < QUOTAS.evalparents) short.push(`evalparents ${evalParents.length}/${QUOTAS.evalparents}`);
console.log(short.length ? `SHORTFALLS: ${short.join("; ")}` : "all pool quotas filled");
