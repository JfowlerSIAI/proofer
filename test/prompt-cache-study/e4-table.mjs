#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Prints the E4 weighted-metric table (numbers only)
// from <RAW>/e4-summary.json written by analyze-e4.mjs.
//   node e4-table.mjs [--profile benchmark-standard-v1]
import { readFileSync } from "fs";
const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const { RAW: RAW_DEFAULT } = await import("./paths.mjs");
const RAW = arg("--raw", RAW_DEFAULT);
const PROF = arg("--profile", "benchmark-standard-v1");
const S = JSON.parse(readFileSync(`${RAW}/e4-summary.json`, "utf8"));
const METRICS = [["safe_per1k", "safe /1k"], ["damage_per1k", "damage /1k"], ["unnecessary_per1k_clean", "unnecessary /1k clean"],
  ["missed_per1k", "missed /1k"], ["refused_per1k", "refused /1k"], ["malformed_rate", "malformed rate"]];
const f = (x, d = 1) => (x == null ? "-" : x.toFixed(d));
const rng = (lo, hi, d = 1) => (Math.abs(lo - hi) < 1e-9 ? f(lo, d) : `${f(lo, d)}–${f(hi, d)}`);
console.log(`\nprofile ${PROF}; every delta is layout minus L0 (same items, paired bootstrap 95% CI; a range is the envelope over outputs still pending adjudication)\n`);
console.log(`| layout | ${METRICS.map(([, l]) => l).join(" | ")} | pending (layout / L0) |`);
console.log(`|---|${METRICS.map(() => "---").join("|")}|---|`);
let refRow = null;
for (const [layout, v] of Object.entries(S.layouts)) {
  const sc = v.scores[PROF];
  if (!sc) continue;
  const d = METRICS.map(([k]) => (k === "malformed_rate" ? 4 : 1));
  if (!refRow) {
    refRow = `| L0 (reference) | ${METRICS.map(([k], i) => rng(sc.point.B.lo[k], sc.point.B.hi[k], d[i])).join(" | ")} | - |`;
    console.log(refRow);
  }
  const cells = METRICS.map(([k], i) => {
    const lo = sc.point.A.lo[k] - sc.point.B.hi[k], hi = sc.point.A.hi[k] - sc.point.B.lo[k];
    const ci = sc.ci.delta?.[k];
    const deg = sc.degenerate?.delta?.[k]?.degenerate;
    const sig = ci && (ci.lower > 0 || ci.upper < 0) ? " **" : "";
    return `${lo >= 0 ? "+" : ""}${rng(lo, hi, d[i])} [${ci ? f(ci.lower, d[i]) + ", " + f(ci.upper, d[i]) : "-"}]${deg ? " (0 disc.)" : ""}${sig}`;
  });
  console.log(`| ${layout} | ${cells.join(" | ")} | ${sc.pending.A} / ${sc.pending.B} |`);
}
console.log(`\n** = the 95% CI excludes zero.`);
