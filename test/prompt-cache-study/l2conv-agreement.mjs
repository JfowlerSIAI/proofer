#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Output agreement between two frozen-benchmark
// run-files, paired by uid: how often the normalised outputs are identical,
// by stratum, and how often the scorer's class is the same. Used by the
// L2-conv training trial to say how far a retrain (the control arm) sits from
// the shipped pilot, beside the shipped pilot's own second run.
//   node l2conv-agreement.mjs --a <runfile> --b <runfile> --ledger <ledger.jsonl>
import { loadBenchmark, loadLedger, readJsonl, classifyRow } from "../finetune/benchmark-score.mjs";
import { normalizeOut } from "../finetune/benchmark-schema.mjs";
const args = process.argv.slice(2);
const argOf = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const { FT } = await import("./paths.mjs");
const A = argOf("--a"), B = argOf("--b"), L = argOf("--ledger");
if (!A || !B || !L) { console.error("usage: --a <runfile> --b <runfile> --ledger <f>"); process.exit(2); }
const { records } = loadBenchmark(`${FT}/benchmark-frozen-v1.jsonl`);
const { ledger } = loadLedger(L);
const ra = new Map(readJsonl(A).map((r) => [r.uid, r])), rb = new Map(readJsonl(B).map((r) => [r.uid, r]));
const acc = { all: { n: 0, same: 0, sameClass: 0 }, CLEAN: { n: 0, same: 0, sameClass: 0 }, ERROR: { n: 0, same: 0, sameClass: 0 } };
for (const rec of records) {
  const a = ra.get(rec.uid), b = rb.get(rec.uid); if (!a || !b) continue;
  const same = a.rewritten != null && b.rewritten != null && normalizeOut(a.rewritten) === normalizeOut(b.rewritten);
  const sameClass = classifyRow(rec, a, ledger).cls === classifyRow(rec, b, ledger).cls;
  for (const k of ["all", rec.label.input_status]) { acc[k].n++; acc[k].same += same; acc[k].sameClass += sameClass; }
}
const pc = (x, n) => (100 * x / n).toFixed(1) + "%";
console.log(JSON.stringify({ a: A.replace(/^.*\//, ""), b: B.replace(/^.*\//, ""),
  identical_output: { all: pc(acc.all.same, acc.all.n), CLEAN: pc(acc.CLEAN.same, acc.CLEAN.n), ERROR: pc(acc.ERROR.same, acc.ERROR.n) },
  same_class: { all: pc(acc.all.sameClass, acc.all.n), CLEAN: pc(acc.CLEAN.sameClass, acc.CLEAN.n), ERROR: pc(acc.ERROR.sameClass, acc.ERROR.n) }, n: acc.all.n }));
