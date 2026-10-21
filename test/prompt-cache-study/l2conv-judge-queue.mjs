#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Builds the blind adjudication queue for the
// 2026-10-02 L2-conv training trial, the way the study's §8a addendum did:
// every output in the given run-files that neither the benchmark labels nor
// the ledger covers (classifyRow -> pending-adjudication), deduplicated by
// candidate signature, plus N already-judged outputs from the same runs mixed
// in as HIDDEN controls (the judge cannot tell them apart). Items are
// shuffled with a fixed seed.
//
//   queue.jsonl  {id, context, sentence, candidate}        <- what the judge reads (corpus text; 0600)
//   key.jsonl    {id, signature, uid, control, ledger_verdict, stratum, arms}
//
//   node l2conv-judge-queue.mjs --runs <runfile.jsonl>... --ledger <ledger.jsonl>
//        --out-dir <dir> [--controls 15] [--seed 7]

import { readFileSync, writeFileSync, chmodSync, mkdirSync } from "fs";
import { loadBenchmark, loadLedger, readJsonl, classifyRow } from "../finetune/benchmark-score.mjs";

const args = process.argv.slice(2);
const argOf = (f, d = null) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const listOf = (f) => { const i = args.indexOf(f); if (i < 0) return []; const out = []; for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]); return out; };
const RUNS = listOf("--runs"), LEDGER = argOf("--ledger"), OUT = argOf("--out-dir");
const NCTRL = Number(argOf("--controls", "15"));
const { FT } = await import("./paths.mjs");
if (!RUNS.length || !LEDGER || !OUT) { console.error("usage: --runs <f>... --ledger <f> --out-dir <d>"); process.exit(2); }
mkdirSync(OUT, { recursive: true, mode: 0o700 });

const { records } = loadBenchmark(`${FT}/benchmark-frozen-v1.jsonl`);
const byUid = new Map(records.map((r) => [r.uid, r]));
const { ledger, problems } = loadLedger(LEDGER);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
const ctxOf = new Map(readJsonl(`${FT}/benchmark-run-input.jsonl`).map((r) => [r.uid, r.context || ""]));
// benchmark-run-input uids are candidate ids; the frozen uid is derived from (document, sentence)
const { benchmarkUid } = await import("../finetune/benchmark-schema.mjs");
const candCtx = new Map();
for (const f of ["chat-irc", "chat-owner", "email-workplace", "forum-comments"])
  for (const c of readJsonl(`${FT}/benchmark-candidates-${f}.jsonl`))
    candCtx.set(benchmarkUid(c.source.source_document_id, c.sentence), ctxOf.get(c.candidate_id) ?? c.context_2500 ?? "");

const pending = new Map(), judged = new Map();
for (const f of RUNS) {
  const arm = f.replace(/^.*runfile-/, "").replace(/\.jsonl$/, "");
  for (const row of readJsonl(f)) {
    const rec = byUid.get(row.uid); if (!rec) continue;
    const c = classifyRow(rec, row, ledger);
    const item = { signature: c.signature, uid: row.uid, candidate: row.rewritten, stratum: rec.label.input_status, arm };
    if (c.cls === "pending-adjudication") { const p = pending.get(c.signature) || { ...item, arms: [] }; p.arms.push(arm); pending.set(c.signature, p); }
    else if (c.adjudicated) { const p = judged.get(c.signature) || { ...item, arms: [], ledger_verdict: ledger.get(c.signature) }; p.arms.push(arm); judged.set(c.signature, p); }
  }
}
let s = Number(argOf("--seed", "7"));
const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const shuffle = (a) => a.map((x) => [rnd(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const controls = shuffle([...judged.values()]).slice(0, NCTRL).map((x) => ({ ...x, control: true }));
const items = shuffle([...[...pending.values()].map((x) => ({ ...x, control: false, ledger_verdict: null })), ...controls]);
const queue = [], key = [];
items.forEach((x, i) => {
  const id = `q${String(i + 1).padStart(3, "0")}`;
  const rec = byUid.get(x.uid);
  const ctx = candCtx.get(x.uid) ?? rec.context_2500 ?? "";
  queue.push(JSON.stringify({ id, context: String(ctx).slice(-500), sentence: rec.sentence, candidate: x.candidate }));
  key.push(JSON.stringify({ id, signature: x.signature, uid: x.uid, control: x.control, ledger_verdict: x.ledger_verdict ?? null, stratum: x.stratum, arms: x.arms }));
});
writeFileSync(`${OUT}/queue.jsonl`, queue.join("\n") + "\n", { mode: 0o600 }); chmodSync(`${OUT}/queue.jsonl`, 0o600);
writeFileSync(`${OUT}/key.jsonl`, key.join("\n") + "\n", { mode: 0o600 }); chmodSync(`${OUT}/key.jsonl`, 0o600);
const byArm = {};
for (const p of pending.values()) for (const a of new Set(p.arms)) byArm[a] = (byArm[a] || 0) + 1;
const byStratum = {};
for (const p of pending.values()) byStratum[p.stratum] = (byStratum[p.stratum] || 0) + 1;
console.log(JSON.stringify({ pending_distinct: pending.size, pending_by_arm: byArm, pending_by_stratum: byStratum, controls: controls.length, queue: queue.length, out: OUT }));
