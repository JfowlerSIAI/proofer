#!/usr/bin/env node
// PRE-FREEZE POWER CHECK for the benchmark (Sol Q3, binding).
//
// The question it answers, before ~1,000 owner judgments are spent and the
// split is sealed: *can this benchmark resolve the gate it is being built for?*
// Plan §7.3 sets the damage gate as "95% CI upper bound on meaning-damage /1k
// (deployment-reweighted) no more than the qwen reference point +0.5/1k". That
// is a claim about a rate of roughly one event in a few thousand requests, and
// the benchmark's enrichment (60-70% clean against a measured 97.2% deployment
// prior, audit finding 9) buys power for RECALL, not for damage: reweighting
// puts most of the mass back on a CLEAN stratum whose realized n is small, so
// each individual clean record's weight — and therefore the cost of one damage
// event landing on it — is large.
//
// The report is deliberately quotable: it prints what one event costs, what a
// zero-event run can bound, and the panel size that would close the gap. It is
// an arithmetic instrument, not a simulation — no model is called and no run
// file is read.
//
// The bound at zero events is the RULE OF THREE — with 0 events observed in n
// independent trials the one-sided 95% upper bound on the rate is 3/n — taken
// at the Kish effective sample size of the reweighting weights,
// n_eff = (sum w)^2 / sum w^2, because the weights are not uniform. That is an
// approximation and is labelled as one everywhere it is printed: it treats the
// weighted estimator as a binomial with n_eff trials.
//
// Usage:
//   node benchmark-power-report.mjs [--benchmark <bench.jsonl>]
//                                   [--profile benchmark-standard-v1]
//                                   [--panel 6000] [--margin 0.5]
//                                   [--out <path.json>]
//
// With no --benchmark it reports on the committed 30-record fixture set, which
// is what the self-test asserts against; the real numbers come from pointing it
// at the frozen benchmark jsonl.

import { writeFileSync, renameSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { PROFILES, REGISTERS, SPLITS } from "./benchmark-schema.mjs";
import { computeWeights, kishEss, ruleOfThreePer1k, loadBenchmark, profileScope } from "./benchmark-score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = resolve(HERE, "..", "harvested", "finetune");

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

function median(xs) {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Everything the report needs about one slice of records. */
export function sliceStats(records, profile) {
  const { w, wClean, cells, emptyCells, unallocated, ess, cleanEss } = computeWeights(records, profile);
  const errIdx = records.map((r, i) => [r, i]).filter(([r]) => r.label.input_status === "ERROR").map(([, i]) => i);
  const errMass = errIdx.reduce((s, i) => s + w[i], 0);
  const wErr = errIdx.map((i) => (errMass > 0 ? w[i] / errMass : 0));
  const costs = [...w].filter((x) => x > 0).map((x) => 1000 * x);
  const groups = new Set(records.map((r) => r.source.exclusion_group_id));
  return {
    n: records.length,
    nClean: records.length - errIdx.length,
    nError: errIdx.length,
    groups: groups.size,
    cells, emptyCells, unallocated,
    ess, cleanEss, errorEss: kishEss(wErr),
    oneEventPer1k: { min: Math.min(...costs), median: median(costs), max: Math.max(...costs) },
    ruleOfThreePer1k: ruleOfThreePer1k(ess),
  };
}

export function powerReport(allRecords, {
  profile = "benchmark-standard-v1", panel = 6000, margin = 0.5,
} = {}) {
  const prof = PROFILES[profile];
  const inScope = profileScope(profile);
  const records = allRecords.filter(inScope);

  const slices = {};
  for (const sp of SPLITS) slices[sp] = sliceStats(records.filter((r) => r.split === sp), profile);
  slices.all = sliceStats(records, profile);

  // A hypothetical CLEAN safety-exposure panel of N sentences, drawn at the
  // profile's register weights. At zero damage events its one-sided 95% upper
  // bound on P(damage | clean) is 3/N, and the CLEAN stratum carries
  // cleanPrior of the deployment mass, so its contribution to damage/1k is
  // 1000 * cleanPrior * 3/N. The ERROR stratum is not covered by a clean panel
  // and must still come from the benchmark's sealed split.
  const cleanPanelBound = (N) => 1000 * prof.cleanPrior * 3 / N;
  const errorTermFrom = (s) => 1000 * (1 - prof.cleanPrior) * 3 / (s.errorEss || Infinity);

  const sealedErrTerm = errorTermFrom(slices.sealed);
  const composite = (N) => cleanPanelBound(N) + sealedErrTerm;
  // Panel size that brings the composite bound to `margin`.
  const room = margin - sealedErrTerm;
  const panelNeeded = room > 0 ? Math.ceil(1000 * prof.cleanPrior * 3 / room) : Infinity;
  const cleanOnlyNeeded = Math.ceil(1000 * prof.cleanPrior * 3 / margin);

  return {
    profile, profileKind: prof.kind, restriction: prof.restriction ?? null,
    scope: { selected: records.length, of: allRecords.length },
    cleanPrior: prof.cleanPrior, margin, panel,
    slices,
    panelTable: [1000, 2000, 4000, panel, 10000, 20000]
      .filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
      .map((N) => ({ N, cleanOnly: cleanPanelBound(N), composite: composite(N) })),
    verdict: {
      sealedAloneBound: slices.sealed.ruleOfThreePer1k,
      sealedResolvesMargin: slices.sealed.ruleOfThreePer1k <= margin,
      devAloneBound: slices.dev.ruleOfThreePer1k,
      sealedErrorTerm: sealedErrTerm,
      panelNeededWithSealedErrorTerm: panelNeeded,
      cleanOnlyPanelForMargin: cleanOnlyNeeded,
      panelBoundAtRequested: composite(panel),
    },
  };
}

export function renderPowerReport(R) {
  const L = [];
  L.push("=".repeat(78));
  L.push(`benchmark power report   profile ${R.profile} (${R.profileKind})`);
  if (R.restriction) L.push(`RESTRICTED SUBSET: ${R.restriction}  (${R.scope.selected} of ${R.scope.of} records)`);
  L.push(`clean prior ${R.cleanPrior}   non-inferiority margin ${R.margin}/1k (plan §7.3)`);
  L.push("");
  L.push("-- composition (records / exclusion groups), weights computed WITHIN each slice --");
  L.push(`  ${"slice".padEnd(10)} ${"n".padStart(4)} ${"CLEAN".padStart(6)} ${"ERROR".padStart(6)}`
    + ` ${"groups".padStart(7)} ${"n_eff".padStart(8)} ${"n_eff(clean)".padStart(13)} ${"n_eff(err)".padStart(11)}`);
  for (const k of [...SPLITS, "all"]) {
    const s = R.slices[k];
    L.push(`  ${k.padEnd(10)} ${String(s.n).padStart(4)} ${String(s.nClean).padStart(6)} `
      + `${String(s.nError).padStart(6)} ${String(s.groups).padStart(7)} ${f(s.ess, 1).padStart(8)} `
      + `${f(s.cleanEss, 1).padStart(13)} ${f(s.errorEss, 1).padStart(11)}`);
  }
  for (const k of [...SPLITS, "all"]) {
    const s = R.slices[k];
    if (!s.emptyCells.length) continue;
    L.push(`  !! ${k}: EMPTY CELLS ${s.emptyCells.map((c) => `${c.register}/${c.status}`).join(", ")}`
      + ` — ${f(s.unallocated, 4)} of the target mass had to be renormalized away`);
  }

  L.push("");
  L.push("-- what ONE meaning-damage event costs, reweighted (1000 x that record's weight) --");
  for (const k of [...SPLITS, "all"]) {
    const s = R.slices[k];
    L.push(`  ${k.padEnd(10)} min ${f(s.oneEventPer1k.min).padStart(8)}/1k   `
      + `median ${f(s.oneEventPer1k.median).padStart(8)}/1k   max ${f(s.oneEventPer1k.max).padStart(8)}/1k`);
  }
  L.push(`  Read this against the ${R.margin}/1k margin: a single damage event on a high-weight`);
  L.push(`  CLEAN record moves the estimate by more than the whole margin, so the gate is`);
  L.push(`  decided by one judgment call unless n_eff is far larger than it is here.`);

  L.push("");
  L.push("-- achievable one-sided 95% upper bound at ZERO observed events (rule of three at n_eff) --");
  for (const k of [...SPLITS, "all"]) {
    L.push(`  ${k.padEnd(10)} ${f(R.slices[k].ruleOfThreePer1k).padStart(9)} /1k`);
  }
  L.push(`  hypothetical CLEAN safety-exposure panel (register-weighted, 0 events):`);
  L.push(`    ${"N".padStart(7)} ${"clean-stratum bound".padStart(21)} ${"+ sealed ERROR term".padStart(21)}`);
  for (const row of R.panelTable) {
    L.push(`    ${String(row.N).padStart(7)} ${(f(row.cleanOnly) + " /1k").padStart(21)} `
      + `${(f(row.composite) + " /1k").padStart(21)}`);
  }
  L.push(`  (the panel covers the CLEAN stratum only; the ERROR stratum's contribution`);
  L.push(`   still comes from the sealed split, ${f(R.verdict.sealedErrorTerm)}/1k at zero events)`);

  L.push("");
  L.push("-- VERDICT " + "-".repeat(66));
  L.push(`  Sealed split alone bounds damage at ${f(R.verdict.sealedAloneBound)}/1k at ZERO events.`);
  L.push(`  Margin to resolve: ${R.margin}/1k.`);
  L.push(`  => ${R.verdict.sealedResolvesMargin ? "RESOLVABLE" : "NOT RESOLVABLE"} by the sealed split alone.`);
  if (!R.verdict.sealedResolvesMargin) {
    L.push(`  The sealed split is short by a factor of ${f(R.verdict.sealedAloneBound / R.margin, 1)}x.`);
    if (Number.isFinite(R.verdict.panelNeededWithSealedErrorTerm)) {
      L.push(`  A CLEAN safety-exposure panel of N = ${R.verdict.panelNeededWithSealedErrorTerm} sentences`);
      L.push(`  brings the composite bound to ${R.margin}/1k (clean stratum ${f(R.verdict.cleanOnlyPanelForMargin === 0 ? 0 : R.margin - R.verdict.sealedErrorTerm)}/1k`);
      L.push(`  + sealed ERROR term ${f(R.verdict.sealedErrorTerm)}/1k).`);
    } else {
      L.push(`  NO clean panel can reach ${R.margin}/1k on its own: the sealed split's ERROR-stratum`);
      L.push(`  term alone is ${f(R.verdict.sealedErrorTerm)}/1k. The ERROR slice needs to grow too.`);
      L.push(`  A clean-only panel ignoring that term would need N = ${R.verdict.cleanOnlyPanelForMargin}.`);
    }
  }
  L.push(`  At the requested panel N = ${R.panel}: composite bound ${f(R.verdict.panelBoundAtRequested)}/1k.`);
  L.push("");
  L.push("  This is why the gate needs a safety-exposure panel and not a bigger benchmark:");
  L.push("  the benchmark buys RECALL power (it is error-enriched); damage power is bought");
  L.push("  in CLEAN sentences, which are cheap to collect and cheap to judge (no-op or not).");
  L.push("=".repeat(78));
  return L.join("\n");
}

// --------------------------------------------------------------------- CLI

function arg(argv, name) { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; }

async function main(argv) {
  const profile = arg(argv, "--profile") ?? "benchmark-standard-v1";
  const panel = Number(arg(argv, "--panel") ?? 6000);
  const margin = Number(arg(argv, "--margin") ?? 0.5);
  const benchPath = arg(argv, "--benchmark");

  let records;
  if (benchPath) {
    const { records: recs, problems } = loadBenchmark(benchPath);
    if (problems.length) {
      console.error(`benchmark ${benchPath} is INVALID — refusing to report on it:`);
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    records = recs;
  } else {
    records = (await import("./benchmark-fixtures.mjs")).RECORDS;
    console.error("(no --benchmark: reporting on the committed 30-record fixture set — ILLUSTRATIVE)");
  }

  const R = powerReport(records, { profile, panel, margin });
  console.log(renderPowerReport(R));

  const out = resolve(arg(argv, "--out") ?? process.env.PROOFER_RESULT_JSON
    ?? resolve(ARTIFACT_DIR, "benchmark-power-report.json"));
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(R, null, 2) + "\n");
  renameSync(tmp, out);
  console.log(`\nArtifact: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
