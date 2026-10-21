#!/usr/bin/env node
// Rank prompt-lab candidates from a result JSON, with a few-shot contamination
// check against the corpus they were scored on and the untouched holdout.
//
//   node rank-candidates.mjs results/broad-core.json results/candidates.json

import { readFileSync } from "fs";
import { contaminationRate } from "./lib/contamination.mjs";
import { ALL_TESTS as CORE_TESTS } from "./proofer-test.mjs";

const [resultPath, promptsPath] = process.argv.slice(2);
if (!resultPath) {
  console.error("usage: node rank-candidates.mjs <result.json> [candidates.json]");
  process.exit(1);
}

const result = JSON.parse(readFileSync(resultPath, "utf8"));
const prompts = promptsPath ? JSON.parse(readFileSync(promptsPath, "utf8")) : [];
const promptByName = new Map(prompts.map(p => [p.name, p]));

const variants = [...result.variants].sort((a, b) => b.passRate - a.passRate);
const baseline = result.variants.find(v => v.name === "production");

const header =
  "Variant".padEnd(38) + "Pass%".padEnd(8) + "Miss".padEnd(6) + "FP".padEnd(5) +
  "Bad".padEnd(6) + "Ctr".padEnd(5) + "Fail".padEnd(6) + "Median".padEnd(9) +
  "Fmt".padEnd(6) + "Turn".padEnd(8) + "Contam";
console.log(header);
console.log("-".repeat(header.length));

for (const v of variants) {
  const p = promptByName.get(v.name);
  const text = p ? [p.system, p.userTemplate].filter(Boolean).join("\n") : "";
  const contam = text ? contaminationRate(text, CORE_TESTS) : null;
  const delta = baseline && v !== baseline ? v.passRate - baseline.passRate : 0;
  const mark = v === baseline ? " (baseline)" : (delta > 0 ? ` +${delta.toFixed(1)}` : ` ${delta.toFixed(1)}`);
  console.log(
    v.name.slice(0, 37).padEnd(38) +
    `${v.passRate.toFixed(1)}%`.padEnd(8) +
    String(v.issues.MISSED_ERROR).padEnd(6) +
    String(v.issues.FALSE_POSITIVE).padEnd(5) +
    String(v.issues.BAD_CORRECTION).padEnd(6) +
    String(v.issues.CONTRACTION_STYLE).padEnd(5) +
    String(v.issues.CONTRACT_FAIL).padEnd(6) +
    `${Math.round(v.latency?.medianMs ?? 0)}ms`.padEnd(9) +
    String(v.format || "json").padEnd(6) +
    (v.userTurn ? "user" : "system").padEnd(8) +
    (contam && contam.taught ? `${contam.rate.toFixed(1)}%` : "-") +
    mark
  );
}

// Format and turn aggregates — the axes the literature says matter most.
console.log("\nBy output format:");
for (const fmt of ["json", "raw"]) {
  const set = result.variants.filter(v => (v.format || "json") === fmt);
  if (!set.length) continue;
  const mean = set.reduce((a, v) => a + v.passRate, 0) / set.length;
  const best = Math.max(...set.map(v => v.passRate));
  const lat = set.reduce((a, v) => a + (v.latency?.medianMs || 0), 0) / set.length;
  console.log(`  ${fmt.padEnd(5)} n=${String(set.length).padStart(2)}  mean ${mean.toFixed(1)}%  best ${best.toFixed(1)}%  median latency ${Math.round(lat)}ms`);
}
console.log("\nBy instruction placement:");
for (const turn of [false, true]) {
  const set = result.variants.filter(v => !!v.userTurn === turn);
  if (!set.length) continue;
  const mean = set.reduce((a, v) => a + v.passRate, 0) / set.length;
  const best = Math.max(...set.map(v => v.passRate));
  console.log(`  ${(turn ? "user" : "system").padEnd(6)} n=${String(set.length).padStart(2)}  mean ${mean.toFixed(1)}%  best ${best.toFixed(1)}%`);
}
