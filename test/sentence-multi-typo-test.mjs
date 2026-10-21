#!/usr/bin/env node
// How many typos can one sentence have and still get corrected?
//
//   node sentence-multi-typo-test.mjs
//   PROOFER_LIMIT=15 node sentence-multi-typo-test.mjs
//
// The main corpus cannot answer this. Every one of its 40 error cases is a
// SINGLE-typo sentence, so `maxChangedWords` is never exercised there and
// raising it moved APPLIED not at all -- which reads as "free" and is really
// "invisible". This suite generates sentences with 2, 3 and 4 typos from the
// CLEAN corpus, so the expected output is exactly the original with no
// judgement call about what the fix should be.
//
// Two numbers per bucket:
//
//   FIXED    the model returned the clean sentence exactly
//   APPLIED  ...and it also survived every guard
//
// APPLIED is the one that matters. The gap between them is what the guards are
// refusing, and it is the only direct measurement of the change budget.

import { MODEL, OLLAMA_URL, applyLimit, createLatencyTracker, formatLatencyReport }
  from "./lib/harness.mjs";
import { MULTI_TYPO } from "./lib/multi-typo-corpus.mjs";
import { prepareSentenceRequest, guardSentenceResult } from "./lib/sentence-guards.mjs";

const PAGE = { hostname: "example.com" };
const SETTINGS = { ollamaModel: MODEL };
const verbose = process.argv.includes("--verbose");
const cases = applyLimit(MULTI_TYPO);
const lat = createLatencyTracker();

console.log("\nMulti-typo sentences — the shipping request path");
console.log(`Model: ${MODEL}`);
console.log(`${cases.length} generated cases (2, 3 and 4 typos)\n` + "=".repeat(78));

const buckets = new Map();
const refusals = new Map();

for (const c of cases) {
  const req = prepareSentenceRequest(c.in, "", PAGE, SETTINGS);
  const started = Date.now();
  let out = null, data = null;
  try {
    const res = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    data = await res.json();
    try { out = JSON.parse(data.message.content).rewritten; }
    catch { out = data.message?.content ?? null; }
  } catch (e) { out = null; }
  lat.record(Date.now() - started, data || {});

  const b = buckets.get(c.typos) || { n: 0, fixed: 0, applied: 0 };
  b.n++;
  const fixed = typeof out === "string" && out.trim() === c.expected;
  if (fixed) b.fixed++;
  const guard = out == null ? "no-output" : guardSentenceResult(c.in, out, out);
  if (fixed && guard === null) b.applied++;
  else if (fixed) refusals.set(guard, (refusals.get(guard) || 0) + 1);
  buckets.set(c.typos, b);

  if (verbose && fixed && guard) {
    console.log(`  [${c.typos}] REFUSED ${guard}\n      ${JSON.stringify(c.in)}\n   -> ${JSON.stringify(out)}`);
  }
}

console.log("\ntypos      n    FIXED           APPLIED");
console.log("-".repeat(78));
let totalN = 0, totalFixed = 0, totalApplied = 0;
for (const t of [...buckets.keys()].sort()) {
  const b = buckets.get(t);
  totalN += b.n; totalFixed += b.fixed; totalApplied += b.applied;
  const pc = (x) => `${String(x).padStart(2)}/${b.n}  ${((x / b.n) * 100).toFixed(1).padStart(5)}%`;
  console.log(`  ${t}      ${String(b.n).padStart(3)}    ${pc(b.fixed)}     ${pc(b.applied)}`);
}
console.log("-".repeat(78));
console.log(`  all    ${String(totalN).padStart(3)}    ${totalFixed}/${totalN}  ${((totalFixed/totalN)*100).toFixed(1)}%     ${totalApplied}/${totalN}  ${((totalApplied/totalN)*100).toFixed(1)}%`);

if (refusals.size) {
  console.log("\nGuards refusing a CORRECT fix (this is the cost of the guard set):");
  for (const [r, n] of [...refusals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${r}`);
  }
} else {
  console.log("\nNo correct fix was refused by any guard.");
}
console.log("\n" + formatLatencyReport(lat.stats()));
