#!/usr/bin/env node
// The §7.1 pilot audit sample: a fixed 150-judgment stratified draw of the
// pilot's Terra verdicts for the owner to BLIND-judge.
//
//   node pilot-audit-sample.mjs [--n 150] [--seed 20260822]
//                               [--in <pilot-judge-input.jsonl>]
//                               [--verdicts <pilot-judge.jsonl>]
//                               [--out <pilot-audit-sample.jsonl>]
//                               [--manifest <pilot-audit-manifest.json>]
//
// The owner labels the sample with the SAME flow as calibration —
//
//   node label-calibration.mjs --in harvested/finetune/pilot-audit-sample.jsonl \
//                              --out harvested/finetune/pilot-audit-labels.jsonl
//
// — and the comparison against Terra is calibrate-judge.mjs over those labels
// with --verdicts pointed at the pilot verdicts. §7.1's threshold: >5%
// owner-disagreement on KEPT edits sends the judge prompt back to calibration.
//
// BLIND BY CONSTRUCTION. The sample rows carry {uid, context, input, output}
// and NOTHING the judge said: an owner who can see Terra's verdict is anchored
// by it, and the blinded-adjudication rule elsewhere in the plan (§4) is the
// same decision. The stratum of each row lives only in the manifest, keyed by
// uid, and the emitted order is shuffled so strata do not arrive in blocks.
//
// STRATIFICATION is by the judge's example-level disposition, worst first:
// any meaning-damage group > any uncertain > any reverted-unnecessary > all
// kept. Allocation: every uncertain (capped 15), meaning-damage capped 20,
// unnecessary capped 25, and kept fills the remainder — kept is the
// threshold's denominator, so it takes the bulk of the budget deliberately.
// A stratum smaller than its cap spills its unused budget into kept.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  readJsonl, writeJsonl, argOf, fail, mulberry32, shuffled, VERDICT_SET,
} from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const num = (f, d) => (argOf(f) === null ? d : Number(argOf(f)));

const cfg = {
  n: num("--n", 150),
  seed: num("--seed", 20260822) >>> 0,
  in: argOf("--in", path.join(ART, "pilot-judge-input.jsonl")),
  verdicts: argOf("--verdicts", path.join(ART, "pilot-judge.jsonl")),
  out: argOf("--out", path.join(ART, "pilot-audit-sample.jsonl")),
  manifest: argOf("--manifest", path.join(ART, "pilot-audit-manifest.json")),
};

// Last row per uid wins: a quarantined verdict re-judged under --force is
// superseded by the appended re-run, exactly as the assemble stage reads it.
const byUid = new Map();
for (const r of readJsonl(cfg.verdicts)) {
  if (r && r.uid && r.type !== "quarantine-since" && Array.isArray(r.verdicts)) byUid.set(r.uid, r);
}
if (!byUid.size) fail(`no judge verdicts in ${cfg.verdicts}`);

const inputs = readJsonl(cfg.in).filter((r) => r && r.uid && typeof r.input === "string");
if (!inputs.length) fail(`no judgeable rows in ${cfg.in}`);

const RANK = { "meaning-damage": 0, "uncertain": 1, "unnecessary": 2 };
function stratumOf(vrow) {
  let worst = "kept";
  for (const v of vrow.verdicts) {
    if (!VERDICT_SET.has(v.verdict)) fail(`uid ${vrow.uid}: unknown verdict ${JSON.stringify(v.verdict)}`);
    if (v.verdict in RANK && (worst === "kept" || RANK[v.verdict] < RANK[worst])) worst = v.verdict;
  }
  return worst;
}

const strata = { "meaning-damage": [], "uncertain": [], "unnecessary": [], "kept": [] };
let unjudged = 0;
for (const r of inputs) {
  const v = byUid.get(r.uid);
  if (!v) { unjudged++; continue; }
  strata[stratumOf(v)].push(r);
}
if (unjudged) fail(`${unjudged} input row(s) have no verdict — judge the full set before sampling`);

const CAPS = { "uncertain": 15, "meaning-damage": 20, "unnecessary": 25 };
const rnd = mulberry32(cfg.seed);
const picked = [];
const allocation = {};
for (const s of ["uncertain", "meaning-damage", "unnecessary"]) {
  const take = Math.min(CAPS[s], strata[s].length, cfg.n - picked.length);
  allocation[s] = { population: strata[s].length, sampled: take };
  picked.push(...shuffled(strata[s], rnd).slice(0, take));
}
const keptTake = Math.min(cfg.n - picked.length, strata.kept.length);
allocation.kept = { population: strata.kept.length, sampled: keptTake };
picked.push(...shuffled(strata.kept, rnd).slice(0, keptTake));
if (picked.length < cfg.n) {
  console.log(`NOTE: population supports only ${picked.length} of the requested ${cfg.n}.`);
}

// Blind rows out, stratum map into the manifest only.
const stratumByUid = {};
for (const [s, xs] of Object.entries(strata)) for (const x of xs) stratumByUid[x.uid] = s;
const rows = shuffled(picked, rnd).map((r) => ({
  uid: r.uid, context: r.context ?? "", input: r.input, output: r.output,
}));
writeJsonl(cfg.out, rows);
fs.writeFileSync(cfg.manifest, JSON.stringify({
  generated: new Date().toISOString(), seed: cfg.seed, n: rows.length,
  judge_input: path.basename(cfg.in), judge_verdicts: path.basename(cfg.verdicts),
  allocation,
  threshold: ">5% owner-disagreement on kept edits sends the judge prompt back to calibration (§7.1)",
  stratum_by_uid: Object.fromEntries(rows.map((r) => [r.uid, stratumByUid[r.uid]])),
}, null, 2) + "\n");

console.log("Pilot audit sample (§7.1)");
console.log("=".repeat(72));
console.log(`  seed ${cfg.seed}   drawn ${rows.length} of requested ${cfg.n}`);
for (const [s, a] of Object.entries(allocation)) {
  console.log(`  ${s.padEnd(16)} population ${String(a.population).padStart(5)}   sampled ${String(a.sampled).padStart(3)}`);
}
console.log(`  sample   ${cfg.out}   (BLIND — verdicts live only in the manifest/verdict files)`);
console.log(`  manifest ${cfg.manifest}`);
console.log(`\n  owner labels with:`);
console.log(`    node label-calibration.mjs --in ${path.relative(process.cwd(), cfg.out)} --out ${path.relative(process.cwd(), path.join(ART, "pilot-audit-labels.jsonl"))}`);
