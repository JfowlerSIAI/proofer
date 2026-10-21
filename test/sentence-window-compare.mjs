#!/usr/bin/env node
// Pool the per-corpus window runs for one or more tags and print a table.
//
//   node sentence-window-compare.mjs k1 k2a k3a k4a
//
// Reads <dir>/window-<corpus>-<tag>.jsonl for every corpus it can find and
// scores the pooled runs with the same function the runner uses, so the pooled
// row is not a sum of rounded rates.

import { readFileSync, existsSync } from "fs";
import { buildMessages, scoreRuns, injectMessages, injectionLabels } from "./sentence-window-test.mjs";
import { compileLabels } from "./sentence-owner-bench.mjs";

// Injected runs must be rebuilt with the SAME mode and seed they were run with,
// or the scorer scores a different set of damaged words than the model saw.
const INJECT = process.env.PROOFER_WINDOW_INJECT || null;
const SEED = Number(process.env.PROOFER_WINDOW_SEED || 20260812);

const DIR = process.env.PROOFER_CORPUS_DIR || new URL("./harvested/", import.meta.url).pathname;
const CORPORA = (process.env.PROOFER_WINDOW_CORPORA || "error-holdout,random-holdout,dev-corpus").split(",");
const tags = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const perCorpus = process.argv.includes("--per-corpus");
const review = process.argv.includes("--review");

const rows = [];
for (const tag of tags) {
  const allRuns = [], allMsgs = [];
  const labels = new Map();
  const byCorpus = [];
  for (const name of CORPORA) {
    const f = `${DIR}window-${name}-${tag}.jsonl`;
    if (!existsSync(f)) continue;
    const corpus = JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8"));
    let msgs = buildMessages(corpus).messages;
    let L;
    if (INJECT) {
      msgs = injectMessages(msgs, INJECT, SEED);
      L = injectionLabels(msgs);
    } else {
      L = compileLabels(JSON.parse(readFileSync(`${DIR}labels-${name}.json`, "utf8")));
    }
    for (const [k, v] of L) labels.set(k, v);
    const runs = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    allRuns.push(...runs); allMsgs.push(...msgs);
    byCorpus.push([name, runs, msgs, L]);
  }
  if (!allRuns.length) { console.error(`no runs found for tag ${tag}`); continue; }
  const R = scoreRuns(allRuns, allMsgs, labels);
  rows.push([tag, R]);
  if (perCorpus) {
    for (const [name, runs, msgs, L] of byCorpus) {
      const r = scoreRuns(runs, msgs, L);
      console.log(`  ${tag}/${name}  fixSafe ${r.fixedSafe}/${r.errors}  damage ${r.damage.length}  style ${r.welcomeStyle}  older ${r.editsOnOlder}`);
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);
console.log("");
console.log(pad("tag", 8) + rpad("fixSafe", 12) + rpad("collat", 7) + rpad("missed", 7) + rpad("wrong", 6)
  + rpad("DAMAGE", 8) + rpad("/100", 7) + rpad("style", 7) + rpad("gram", 6)
  + rpad("edits", 7) + rpad("older", 7) + rpad("revFix", 7) + rpad("revMean", 8) + rpad("re2x", 6)
  + rpad("refused", 8) + rpad("ms", 7) + rpad("ptok", 6));
for (const [tag, R] of rows) {
  console.log(pad(tag, 8)
    + rpad(`${R.fixedSafe}/${R.errors}`, 12)
    + rpad(R.fixedWithCollateral, 7) + rpad(R.errNoOp, 7) + rpad(R.wrongOutput, 6)
    + rpad(R.damage.length, 8) + rpad(R.damagePer100, 7)
    + rpad(R.welcomeStyle, 7) + rpad(R.grammar, 6)
    + rpad(R.applyEvents, 7) + rpad(R.editsOnOlder, 7) + rpad(R.revisionFix, 7) + rpad(R.revisionMeaning, 8)
    + rpad(R.reEdited, 6) + rpad(R.stepRefused, 8) + rpad(R.medianMs, 7) + rpad(R.medianPromptTokens, 6));
}
console.log("\nfixSafe = labelled error fixed in the FINAL text with no meaning damage alongside it");
console.log("DAMAGE  = meaning-damaged clean sentences + collateral + wrong-fix-applied, scored on the FINAL text");
console.log("older   = edits landing on a sentence the user had already finished (revFix/revMeaning split them)");

if (review) {
  for (const [tag, R] of rows) {
    console.log(`\n--- ${tag} damage`);
    for (const d of R.damage) console.log(`  ! ${d.uid} (${d.why})\n      ${JSON.stringify(d.sentence)}\n   -> ${JSON.stringify(d.output)}`);
    console.log(`--- ${tag} revisions (edits to already-finished sentences)`);
    for (const r of R.revisions) console.log(`  ~ ${r.uid} [${r.kind}]\n      ${JSON.stringify(r.before)}\n   -> ${JSON.stringify(r.after)}`);
    console.log(`--- ${tag} refusals`, Object.entries(R.refusals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "));
  }
}
