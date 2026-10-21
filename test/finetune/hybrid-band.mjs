#!/usr/bin/env node
// Hybrid pipeline: compute the contested band and (given adjudications +
// owner labels) score the end-to-end result. 2026-08-23, owner decision
// recorded in the plan's §11 item 0.
//
//   node hybrid-band.mjs --a <judgeA.jsonl> --b <judgeB.jsonl> \
//        [--items <corpus.jsonl>] [--band-out <items.json>] \
//        [--adjudications <opus.jsonl>] [--labels <owner.jsonl>]
//
// Tiers:
//   agree-keep   both judges keep the group           -> ship (unless overlay)
//   agree-revert both judges revert                   -> identity
//   contested    keep/revert disagreement             -> Opus adjudicates
//   overlay      both keep BUT word→different-word substitution
//                (both sides dictionary words, not case-only) -> Opus too
//
// With --adjudications and --labels it scores the full pipeline against the
// owner: hard-flagged items count as owner-routed (always correct, but
// counted); everything else scores the pipeline's own keep/revert.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};

const KEEP = new Set(["required-correction", "benign-optional"]);
const readJsonl = (p) =>
  fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

function verdictMap(p) {
  const m = new Map();
  const groups = new Map(); // key -> group object (before/after/kind)
  const rowByUid = new Map();
  for (const r of readJsonl(p)) {
    rowByUid.set(r.uid, r);
    for (const v of r.verdicts || []) m.set(r.uid + "#" + v.group, v.verdict);
    for (const g of r.groups || []) groups.set(r.uid + "#" + g.id, g);
  }
  return { m, groups, rowByUid };
}

// --- dictionary for the overlay -------------------------------------------
const dictPath = path.join(HERE, "..", "..", "data", "words-en.txt");
const DICT = new Set(fs.readFileSync(dictPath, "utf8").split("\n").map((w) => w.trim()).filter(Boolean));
const tokens = (s) => (s.toLowerCase().match(/[a-z']+/g) || []);

// Risk overlay: kept edits that can silently change meaning.
// (1) word→different-word substitution: some before/after token differs as a
//     word (not case-only) and every changed token is a dictionary word —
//     the real-word→real-word class the guards treat as most dangerous.
// (2) word insertion/deletion: the changed text contains at least one
//     dictionary word (an inserted preposition adds a relation the author
//     never typed; the sealed shipped-damage case was exactly this shape —
//     kind=insertion, so a substitution-only overlay missed it).
// Punctuation-, casing- and whitespace-only edits stay out.
const isWord = (w) => DICT.has(w.replace(/'/g, "")) || DICT.has(w);
function wordSwapOverlay(g) {
  const b = tokens(g.before), a = tokens(g.after);
  if (g.kind === "substitution") {
    const bs = new Set(b), as = new Set(a);
    const lost = b.filter((w) => !as.has(w));
    const gained = a.filter((w) => !bs.has(w));
    if (!lost.length || !gained.length) return false; // case/punct-only
    return lost.every(isWord) && gained.every(isWord);
  }
  if (g.kind === "insertion") return a.some(isWord);
  if (g.kind === "deletion") return b.some(isWord);
  return false;
}

// --- band ------------------------------------------------------------------
const A = verdictMap(argOf("--a"));
const B = verdictMap(argOf("--b"));

const allKeys = new Set([...A.m.keys(), ...B.m.keys()]);
const band = []; // items for the adjudicator
const tier = new Map(); // key -> tier name
for (const k of allKeys) {
  const va = A.m.get(k), vb = B.m.get(k);
  if (va === undefined || vb === undefined) { tier.set(k, "one-judge-only"); band.push(k); continue; }
  const ka = KEEP.has(va), kb = KEEP.has(vb);
  if (ka !== kb) { tier.set(k, "contested"); band.push(k); continue; }
  if (ka && kb) {
    const g = A.groups.get(k) ?? B.groups.get(k);
    if (g && wordSwapOverlay(g)) { tier.set(k, "overlay"); band.push(k); continue; }
    tier.set(k, "agree-keep");
  } else tier.set(k, "agree-revert");
}

const counts = {};
for (const t of tier.values()) counts[t] = (counts[t] || 0) + 1;
console.log("groups total:", allKeys.size);
console.log("tiers:", JSON.stringify(counts));
console.log("band (to Opus):", band.length, `(${((100 * band.length) / allKeys.size).toFixed(1)}%)`);

// --- emit band items -------------------------------------------------------
const bandOut = argOf("--band-out", null);
if (bandOut) {
  const itemsPath = argOf("--items", null);
  if (!itemsPath) { console.error("--band-out needs --items <corpus.jsonl>"); process.exit(2); }
  const corpus = new Map(readJsonl(itemsPath).map((r) => [r.uid, r]));
  const items = band.map((k) => {
    const [uid, groupStr] = k.split("#");
    const group = Number(groupStr);
    const g = A.groups.get(k) ?? B.groups.get(k);
    const c = corpus.get(uid);
    if (!c || !g) { console.error("band item missing corpus/group:", k); process.exit(1); }
    return { uid, group, context: c.context ?? "", input: c.input, output: c.output,
             before: g.before, after: g.after };
  });
  fs.writeFileSync(bandOut, JSON.stringify(items, null, 1) + "\n", { mode: 0o600 });
  console.log("band items written:", bandOut);
}

// --- score the full pipeline ----------------------------------------------
const adjPath = argOf("--adjudications", null);
const labPath = argOf("--labels", null);
if (adjPath && labPath) {
  const adj = new Map();
  for (const r of readJsonl(adjPath)) adj.set(r.uid + "#" + r.group, r);
  const labels = new Map();
  for (const r of readJsonl(labPath)) labels.set(r.uid + "#" + r.group, r); // last row wins

  let scored = 0, agreeOk = 0, routed = 0;
  let expensive = 0, cheap = 0;
  let damageTotal = 0, damageShipped = 0;
  const missDetail = [];
  for (const [k, lab] of labels) {
    if (!tier.has(k)) continue;
    const t = tier.get(k);
    let pipelineKeep;
    let via = t;
    if (t === "agree-keep") pipelineKeep = true;
    else if (t === "agree-revert") pipelineKeep = false;
    else {
      const a = adj.get(k);
      if (!a) { console.error("band item lacks adjudication:", k); process.exit(1); }
      if (a.hard) { routed++; scored++; if (lab.damage) damageTotal++; continue; } // owner decides
      pipelineKeep = a.keep === true;
      via = t + "/opus";
    }
    scored++;
    const ownerKeep = lab.keep === true;
    if (lab.damage) { damageTotal++; if (pipelineKeep) { damageShipped++; missDetail.push(["DAMAGE-SHIPPED", k, via]); } }
    if (ownerKeep === pipelineKeep) { agreeOk++; continue; }
    if (pipelineKeep) { expensive++; missDetail.push(["EXPENSIVE", k, via, "owner=" + lab.verdict]); }
    else cheap++;
  }
  console.log("\nEnd-to-end vs owner labels");
  console.log("  scored:", scored, " routed-to-owner:", routed, `(${((100 * routed) / scored).toFixed(1)}%)`);
  console.log("  agreement (non-routed):", agreeOk + "/" + (scored - routed),
    `(${((100 * agreeOk) / (scored - routed)).toFixed(1)}%)`);
  console.log("  expensive (shipped, owner=revert):", expensive, "  cheap (lost, owner=keep):", cheap);
  console.log("  damage groups:", damageTotal, " shipped:", damageShipped,
    " containment:", damageTotal ? (100 * (damageTotal - damageShipped) / damageTotal).toFixed(1) + "%" : "n/a");
  for (const d of missDetail) console.log("   ", d.join("  "));
}
