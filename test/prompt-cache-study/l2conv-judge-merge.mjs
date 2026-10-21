#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Merges the judge's verdicts for the L2-conv training
// trial into a new ledger and reports the hidden controls' agreement.
//   verdicts: the judge's JSONL ({id, verdict, hard, why}); controls are
//   scored against the ledger and NOT written (the ledger already has them);
//   the rest become ledger rows {signature, verdict, hard, source}.
//
//   node l2conv-judge-merge.mjs --verdicts <f> --key <key.jsonl> --ledger <base.jsonl>
//        --out <merged.jsonl> --source <label>

import { readFileSync, writeFileSync, chmodSync } from "fs";
const args = process.argv.slice(2);
const argOf = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const V = argOf("--verdicts"), K = argOf("--key"), L = argOf("--ledger"), OUT = argOf("--out"), SRC = argOf("--source", "l2conv-trial-judge");
if (!V || !K || !L || !OUT) { console.error("usage: --verdicts <f> --key <f> --ledger <f> --out <f> --source <s>"); process.exit(2); }
const VERDICTS = new Set(["required-correction", "benign-optional", "unnecessary", "meaning-damage", "uncertain"]);
const KEEP = new Set(["required-correction", "benign-optional"]);
const lines = readFileSync(V, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
const verdicts = new Map();
for (const l of lines) { let o; try { o = JSON.parse(l); } catch { console.error("unparseable verdict line"); process.exit(1); }
  if (!VERDICTS.has(o.verdict)) { console.error(`bad verdict for ${o.id}: ${o.verdict}`); process.exit(1); }
  verdicts.set(o.id, o); }
const key = readFileSync(K, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const missing = key.filter((k) => !verdicts.has(k.id)).map((k) => k.id);
if (missing.length) { console.error(`judge gave no verdict for ${missing.length} items: ${missing.join(" ")}`); process.exit(1); }
let exact = 0, keepRevert = 0, nCtrl = 0, stricter = 0, looser = 0;
const ctrlRows = [];
for (const k of key.filter((k) => k.control)) {
  nCtrl++;
  const j = verdicts.get(k.id).verdict, l = k.ledger_verdict;
  if (j === l) exact++;
  if (KEEP.has(j) === KEEP.has(l)) keepRevert++;
  else if (KEEP.has(l) && !KEEP.has(j)) stricter++; else looser++;
  ctrlRows.push({ id: k.id, ledger: l, judge: j, stratum: k.stratum });
}
const base = readFileSync(L, "utf8").split("\n").filter(Boolean);
const added = [];
const tally = {};
for (const k of key.filter((k) => !k.control)) {
  const o = verdicts.get(k.id);
  added.push(JSON.stringify({ signature: k.signature, verdict: o.verdict, hard: !!o.hard, source: SRC }));
  tally[o.verdict] = (tally[o.verdict] || 0) + 1;
}
writeFileSync(OUT, base.join("\n") + "\n" + added.join("\n") + "\n", { mode: 0o600 }); chmodSync(OUT, 0o600);
console.log(JSON.stringify({ judged: added.length, verdicts: tally, controls: nCtrl, exact, keep_or_revert: keepRevert, judge_stricter: stricter, judge_looser: looser, ledger_rows: base.length + added.length, out: OUT }));
console.log(JSON.stringify(ctrlRows));
