#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. E4 analysis for the prompt-cache study: each layout's
// frozen-benchmark run paired against L0 on the same items.
//
// Two instruments, both reading the run-files test/finetune/benchrun-to-runfile.mjs
// wrote from e4-bench.mjs's rows:
//   1. test/finetune/benchmark-score.mjs (the paired bootstrap scorer every
//      earlier round used), run here as a subprocess per layout and profile,
//      with the adjudication ledger the 2026-09-06 q4/q8 round used; its JSON
//      artifacts land next to the runs.
//   2. per-STRATUM paired rates computed here with the scorer's own
//      classifyRow: on CLEAN records, how often the model edited (output !=
//      input, before the guards) and how often an edit reached the field; on
//      ERROR records, how often a safe correction reached the field, was
//      missed, refused or malformed. Paired against L0 with an exact McNemar
//      test on the discordant records -- the split the 2026-09-06 entry showed
//      the pooled numbers hide.
//      The ERROR-stratum test is also run at two PENDING-AWARE bounds (added
//      after checkpoint 2): worst for the layout (its unjudged outputs not
//      safe, L0's safe) and best (the reverse), identical unjudged outputs in
//      both arms kept concordant. A difference counts as resolved only when
//      both bounds are significant in the same direction; a test that is not
//      significant is "no difference detected", never "parity". (The scorer's
//      weighted CIs already span every resolution of the pending rows.)
//
//   node analyze-e4.mjs --tag full --ref L0 [--layouts ...] [--reps 10000]
//        [--ledger <adjudications.jsonl>] [--out-dir <dir>]
// Prints a markdown table (numbers only) and writes <out-dir>/e4-summary.json
// (out-dir defaults to RAW). --ledger replaces the 2026-09-06 ledger, e.g. with
// the merged one the 2026-09-25 adjudication of the pending outputs wrote.

import { execFileSync } from "child_process";
import { writeFileSync, existsSync, readFileSync, chmodSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadBenchmark, loadLedger, readJsonl, classifyRow } from "../finetune/benchmark-score.mjs";
import { normalizeOut } from "../finetune/benchmark-schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const { RAW: RAW_DEFAULT, FT: FT_DEFAULT } = await import("./paths.mjs");
const RAW = arg("--raw", RAW_DEFAULT);
const FT = arg("--art", FT_DEFAULT);
const TAG = arg("--tag", "full");
const REF = arg("--ref", "L0");
const REPS = arg("--reps", "10000");
const LAYOUTS = arg("--layouts", "L0@rerun,L1p-sys,L1a-sys,L2-sys,L3-sys,L1p-post,L1a-post,L2-post,L3-post,L1p-usr,L4-conv,L2-conv").split(",");
const BENCH = `${FT}/benchmark-frozen-v1.jsonl`;
const LEDGER = arg("--ledger", `${FT}/adjudication-ledger-q4q8-0906.jsonl`);
const OUT = arg("--out-dir", RAW);
const PROFILES = ["benchmark-standard-v1", "owner-discord-random-v1"];

const runfile = (spec) => { const [l, t] = spec.split("@"); return `${RAW}/runfile-${t || TAG}-${l}.jsonl`; };

// The demonstrations' answers: an output equal to one of them (on an input that
// is not that demonstration) is the model reciting the prompt, not correcting.
const { PIECES } = await import("./layouts.mjs");
const DEMO_ANSWERS = new Set([...PIECES.DEMOS, ...PIECES.SHOT].filter((m) => m.role === "assistant")
  .map((m) => normalizeOut(JSON.parse(m.content).rewritten)));
const refFile = runfile(REF);

const { records } = loadBenchmark(BENCH);
const byUid = new Map(records.map((r) => [r.uid, r]));
const { ledger } = loadLedger(LEDGER);
const rowsOf = (f) => new Map(readJsonl(f).map((r) => [r.uid, r]));
const sigOf = (rec, row) => classifyRow(rec, row, ledger).signature;

function strata(rowsA, rowsB) {
  const acc = { clean: { n: 0, editA: 0, editB: 0, e10: 0, e01: 0, landA: 0, landB: 0, l10: 0, l01: 0 },
    error: { n: 0, safeA: 0, safeB: 0, s10: 0, s01: 0, missedA: 0, missedB: 0, refusedA: 0, refusedB: 0, malA: 0, malB: 0, pendA: 0, pendB: 0, dmgA: 0, dmgB: 0,
      wSafeA: 0, wSafeB: 0, w10: 0, w01: 0, bSafeA: 0, bSafeB: 0, b10: 0, b01: 0, samePending: 0 },
    pendingA: 0, pendingB: 0, malformedA: 0, malformedB: 0, recitedA: 0, recitedB: 0 };
  for (const [uid, rec] of byUid) {
    const a = rowsA.get(uid), b = rowsB.get(uid);
    if (!a || !b) continue;
    const recited = (row) => row.rewritten != null && DEMO_ANSWERS.has(normalizeOut(row.rewritten))
      && !DEMO_ANSWERS.has(normalizeOut(rec.sentence));
    acc.recitedA += recited(a); acc.recitedB += recited(b);
    const ca = classifyRow(rec, a, ledger).cls, cb = classifyRow(rec, b, ledger).cls;
    if (ca === "pending-adjudication") acc.pendingA++;
    if (cb === "pending-adjudication") acc.pendingB++;
    if (ca === "malformed") acc.malformedA++;
    if (cb === "malformed") acc.malformedB++;
    const edited = (row) => !row.malformed && row.rewritten != null && normalizeOut(row.rewritten) !== normalizeOut(rec.sentence);
    if (rec.label.input_status === "CLEAN") {
      const s = acc.clean; s.n++;
      const ea = edited(a), eb = edited(b);
      s.editA += ea; s.editB += eb; if (ea && !eb) s.e10++; if (!ea && eb) s.e01++;
      const la = ea && a.guard === "applied", lb = eb && b.guard === "applied";
      s.landA += la; s.landB += lb; if (la && !lb) s.l10++; if (!la && lb) s.l01++;
    } else {
      const s = acc.error; s.n++;
      const sa = ca === "safe-correction", sb = cb === "safe-correction";
      s.safeA += sa; s.safeB += sb; if (sa && !sb) s.s10++; if (!sa && sb) s.s01++;
      // Pending-aware bounds on the paired test (checkpoint 2, finding 2).
      // A pending output is one the ledger has not judged, so either
      // resolution is possible. WORST for the layout (A): its pending outputs
      // not safe, L0's pending outputs safe. BEST for the layout: the reverse.
      // Where both arms produced the SAME pending output for a record, it must
      // resolve the same way in both, so that pair stays concordant.
      const pa = ca === "pending-adjudication", pb = cb === "pending-adjudication";
      const same = pa && pb && sigOf(rec, a) === sigOf(rec, b);
      const wA = sa, wB = sb || (pb && !same);
      const bA = sa || pa, bB = sb || same;
      s.wSafeA += wA; s.wSafeB += wB; if (wA && !wB) s.w10++; if (!wA && wB) s.w01++;
      s.bSafeA += bA; s.bSafeB += bB; if (bA && !bB) s.b10++; if (!bA && bB) s.b01++;
      s.samePending += same;
      s.missedA += ca === "missed"; s.missedB += cb === "missed";
      s.refusedA += ca === "refused"; s.refusedB += cb === "refused";
      s.malA += ca === "malformed"; s.malB += cb === "malformed";
      s.pendA += ca === "pending-adjudication"; s.pendB += cb === "pending-adjudication";
      s.dmgA += ca === "meaning-damage"; s.dmgB += cb === "meaning-damage";
    }
  }
  return acc;
}

// exact two-sided McNemar (binomial on the discordant pairs)
function mcnemar(b, c) {
  const n = b + c; if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0, coef = 1;
  for (let i = 0; i <= n; i++) { if (i > 0) coef = coef * (n - i + 1) / i; if (i <= k) p += coef; }
  return Math.min(1, 2 * p / 2 ** n);
}
const pc = (x, n) => (n ? (100 * x / n).toFixed(1) : "-");

const summary = { ref: REF, tag: TAG, ledger: path.basename(LEDGER), layouts: {} };
const refRows = rowsOf(refFile);
for (const spec of LAYOUTS) {
  const f = runfile(spec);
  if (!existsSync(f)) { console.error(`missing ${f}`); continue; }
  const s = strata(rowsOf(f), refRows);
  const scores = {};
  for (const prof of PROFILES) {
    const out = `${OUT}/score-${spec.replace("@", "-")}-vs-${REF}-${prof}.json`;
    try {
      execFileSync("node", [path.join(HERE, "..", "finetune", "benchmark-score.mjs"), "--benchmark", BENCH,
        "--runs", f, refFile, "--adjudications", LEDGER, "--profile", prof, "--reps", REPS, "--seed", "1", "--out", out],
        { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) { /* exit 1 = problems listed in the artifact; still read it */ }
    if (existsSync(out)) { chmodSync(out, 0o600); scores[prof] = JSON.parse(readFileSync(out, "utf8")); }
  }
  summary.layouts[spec] = { strata: s, scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, {
    point: v.point, ci: v.ci, delta: v.delta ?? null, deltaCi: v.deltaCi ?? null, degenerate: v.degenerate, discordant: v.discordant, pending: v.pending, problems: v.problems } ])) };
  const c = s.clean, e = s.error;
  // the error-stratum verdict: resolved only if BOTH pending bounds are
  // significant in the same direction; a non-significant test is not parity
  const pw = mcnemar(e.w10, e.w01), pb = mcnemar(e.b10, e.b01);
  const dirW = Math.sign(e.w10 - e.w01), dirB = Math.sign(e.b10 - e.b01);
  e.pWorst = pw; e.pBest = pb;
  e.verdict = pw < 0.05 && pb < 0.05 && dirW === dirB ? (dirW < 0 ? "fewer fixes (resolved)" : "more fixes (resolved)")
    : pw >= 0.05 && pb >= 0.05 ? "no difference detected at either bound" : "unresolved (depends on the pending outputs)";
  console.log(`| ${spec} | ${pc(c.editA, c.n)} vs ${pc(c.editB, c.n)} (${c.e10}/${c.e01}, p=${mcnemar(c.e10, c.e01).toPrecision(2)}) | ` +
    `${pc(c.landA, c.n)} vs ${pc(c.landB, c.n)} (${c.l10}/${c.l01}, p=${mcnemar(c.l10, c.l01).toPrecision(2)}) | ` +
    `${pc(e.safeA, e.n)} vs ${pc(e.safeB, e.n)} (${e.s10}/${e.s01}, p=${mcnemar(e.s10, e.s01).toPrecision(2)}) | ` +
    `worst ${pc(e.wSafeA, e.n)} vs ${pc(e.wSafeB, e.n)} (${e.w10}/${e.w01}, p=${pw.toPrecision(2)}) · best ${pc(e.bSafeA, e.n)} vs ${pc(e.bSafeB, e.n)} (${e.b10}/${e.b01}, p=${pb.toPrecision(2)}) → ${e.verdict} | ` +
    `${pc(e.missedA, e.n)} / ${pc(e.refusedA, e.n)} / ${pc(e.malA, e.n)} | pending ${s.pendingA} vs ${s.pendingB} (error ${e.pendA} vs ${e.pendB}, identical ${e.samePending}) | malformed ${s.malformedA} vs ${s.malformedB} | recited ${s.recitedA} vs ${s.recitedB} |`);
}
writeFileSync(`${OUT}/e4-summary.json`, JSON.stringify(summary, null, 1), { mode: 0o600 });
console.log(`\nwrote ${OUT}/e4-summary.json`);
