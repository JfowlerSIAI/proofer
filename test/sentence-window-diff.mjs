#!/usr/bin/env node
// Sentence-by-sentence diff between two window runs.
//
// The pooled table says "+1 fix, -20 style edits" and that is not enough to act
// on: the same net number can be one sentence changing or forty changing in
// both directions. This lists every sentence whose FINAL text differs between
// two tags and says which way it went.
//
//   node sentence-window-diff.mjs k1 k2a
//   PROOFER_WINDOW_INJECT=last node sentence-window-diff.mjs L1 L2a

import { readFileSync, existsSync } from "fs";
import { buildMessages, injectMessages, injectionLabels } from "./sentence-window-test.mjs";
import { compileLabels, classifyEdit } from "./sentence-owner-bench.mjs";

const DIR = process.env.PROOFER_CORPUS_DIR || new URL("./harvested/", import.meta.url).pathname;
const CORPORA = (process.env.PROOFER_WINDOW_CORPORA || "error-holdout,random-holdout,dev-corpus").split(",");
const INJECT = process.env.PROOFER_WINDOW_INJECT || null;
const SEED = Number(process.env.PROOFER_WINDOW_SEED || 20260812);
const [A, B] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const quiet = process.argv.includes("--quiet");

function load(tag) {
  const finals = new Map();
  const labels = new Map();
  const srcs = new Map();
  for (const name of CORPORA) {
    const f = `${DIR}window-${name}-${tag}.jsonl`;
    if (!existsSync(f)) continue;
    const corpus = JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8"));
    let msgs = buildMessages(corpus).messages;
    let L;
    if (INJECT) { msgs = injectMessages(msgs, INJECT, SEED); L = injectionLabels(msgs); }
    else L = compileLabels(JSON.parse(readFileSync(`${DIR}labels-${name}.json`, "utf8")));
    for (const [k, v] of L) labels.set(k, v);
    const byId = new Map(msgs.map((m) => [m.message_id, m]));
    for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const run = JSON.parse(line);
      const m = byId.get(run.message_id);
      if (!m) continue;
      for (let k = 0; k < m.items.length; k++) {
        finals.set(m.items[k].uid, String(run.final[k]).trim());
        srcs.set(m.items[k].uid, m.items[k].sentence.trim());
      }
    }
  }
  return { finals, labels, srcs };
}

const a = load(A), b = load(B);
const tally = { onlyAFixed: 0, onlyBFixed: 0, onlyADamage: 0, onlyBDamage: 0, styleAOnly: 0, styleBOnly: 0, other: 0 };
const lines = [];
for (const [uid, fa] of a.finals) {
  if (!b.finals.has(uid)) continue;
  const fb = b.finals.get(uid), src = a.srcs.get(uid);
  if (fa === fb) continue;
  const L = a.labels.get(uid) || b.labels.get(uid);
  let verdict;
  if (L && L.cls === "ERROR") {
    const ka = L.fix.test(fa), kb = L.fix.test(fb);
    if (ka && !kb) { verdict = `FIX only in ${A}`; tally.onlyAFixed++; }
    else if (kb && !ka) { verdict = `FIX only in ${B}`; tally.onlyBFixed++; }
    else verdict = "both/neither fixed, text differs";
  } else {
    const ca = fa === src ? "none" : classifyEdit(src, fa).kind;
    const cb = fb === src ? "none" : classifyEdit(src, fb).kind;
    if (ca === "meaning" && cb !== "meaning") { verdict = `DAMAGE only in ${A}`; tally.onlyADamage++; }
    else if (cb === "meaning" && ca !== "meaning") { verdict = `DAMAGE only in ${B}`; tally.onlyBDamage++; }
    else if (ca !== "none" && cb === "none") { verdict = `touched only in ${A} (${ca})`; tally.styleAOnly++; }
    else if (cb !== "none" && ca === "none") { verdict = `touched only in ${B} (${cb})`; tally.styleBOnly++; }
    else { verdict = `both touched differently (${ca}/${cb})`; tally.other++; }
  }
  lines.push({ uid, verdict, src, fa, fb });
}
console.log(`${lines.length} sentences differ between ${A} and ${B} (of ${a.finals.size})`);
console.log(tally);
if (!quiet) {
  for (const l of lines) {
    console.log(`\n  ${l.uid}  ${l.verdict}\n    src ${JSON.stringify(l.src)}\n    ${A}  ${JSON.stringify(l.fa)}\n    ${B}  ${JSON.stringify(l.fb)}`);
  }
}
