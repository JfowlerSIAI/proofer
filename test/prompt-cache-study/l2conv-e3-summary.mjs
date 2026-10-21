#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Summarises an E3 rows file (e3-typing.mjs output)
// for the L2-conv training trial, numbers only: per scenario and layout, the
// tokens in the prompt / reused / evaluated, prompt and decode time, wall time
// and the share under the 5 s deadline. Unlike analyze.mjs it needs no L0
// rows: the trained model's answers are normal length, so the measured total
// is the number, and decode ms/token is taken from the rows themselves.
//   node l2conv-e3-summary.mjs --rows <e3-cpu8.jsonl> [--study <the study's e3-cpu8.jsonl>]
// With --study, the study's rows for the same layout (untrained pilot) are
// printed beside, same columns.
import { readFileSync } from "fs";
const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const read = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2) : null; };
const q = (xs, p) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const r0 = (x) => (x == null ? "-" : Math.round(x));
function table(rows, label) {
  const layouts = [...new Set(rows.map((r) => r.layout))];
  const models = [...new Set(rows.map((r) => r.model ?? "pilot"))];
  const dec = med(rows.filter((r) => r.decoded >= 5 && r.decodeMs).map((r) => r.decodeMs / r.decoded));
  const la = rows.map((r) => r.loadavg?.[0]).filter((x) => x != null);
  console.log(`\n### ${label}: model ${models.join(", ")}; decode ${dec?.toFixed(1)} ms/token (median); 1-min load average median ${med(la)?.toFixed(1)} max ${Math.max(...la).toFixed(1)}\n`);
  console.log("| scenario | layout | requests | prompt tokens (med) | reused (med) | evaluated (med / p90) | prompt ms (med / p90) | decode ms (med) | decoded tokens (med) | total ms (med / p90 / max) | ≤ 5 s | ≤ 4.75 s | long outputs |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const out = {};
  for (const scen of ["main", "cold", "switch", "retry", "retry-seq", "rollover"]) for (const L of layouts) {
    const xs = rows.filter((r) => r.scenario === scen && r.layout === L && !r.replayOfPrime);
    if (!xs.length) continue;
    const long = xs.filter((r) => r.decoded > 2 * r.expectedAnswerTokens + 5).length;
    const s = { n: xs.length, nTokens: med(xs.map((r) => r.nTokens)), reused: med(xs.map((r) => r.reused)), evaluated: med(xs.map((r) => r.evaluated)),
      evaluatedP90: q(xs.map((r) => r.evaluated), 0.9), promptMs: med(xs.map((r) => r.promptMs)), promptMsP90: q(xs.map((r) => r.promptMs), 0.9),
      decodeMs: med(xs.map((r) => r.decodeMs)), decoded: med(xs.map((r) => r.decoded)), wall: med(xs.map((r) => r.wallMs)), wallP90: q(xs.map((r) => r.wallMs), 0.9),
      wallMax: Math.max(...xs.map((r) => r.wallMs)), beat5: xs.filter((r) => r.wallMs < 5000).length, beat4750: xs.filter((r) => r.wallMs < 4750).length, long };
    out[`${scen}/${L}`] = s;
    console.log(`| ${scen} | ${L} | ${s.n} | ${r0(s.nTokens)} | ${r0(s.reused)} | ${r0(s.evaluated)} / ${r0(s.evaluatedP90)} | ${r0(s.promptMs)} / ${r0(s.promptMsP90)} | ${r0(s.decodeMs)} | ${r0(s.decoded)} | ${r0(s.wall)} / ${r0(s.wallP90)} / ${r0(s.wallMax)} | ${s.beat5}/${s.n} | ${s.beat4750}/${s.n} | ${long} |`);
  }
  return out;
}
const rows = read(arg("--rows"));
const mine = table(rows, "trial");
if (arg("--study")) {
  const layouts = new Set(rows.map((r) => r.layout));
  table(read(arg("--study")).filter((r) => layouts.has(r.layout)), "study (untrained pilot), same layout");
}
