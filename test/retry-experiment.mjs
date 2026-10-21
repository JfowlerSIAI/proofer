#!/usr/bin/env node
// EXPERIMENT (not a regression suite): does retrying after a guard refusal buy
// anything?
//
//   node retry-experiment.mjs
//   node retry-experiment.mjs --contexts none,benign,messy
//
// The premise under test is that a guard refusal is a near miss — that the
// model, asked again, would produce something the guards accept. The premise
// under suspicion is that retry-until-a-guard-passes is adversarial search
// against the only thing standing between the model and the user's text. On a
// CLEAN sentence the model wrongly changed, the refusal IS the success case,
// and resampling until something passes converts a prevented bad apply into a
// real one.
//
// So every variant is scored on BOTH directions, from ONE baseline pass:
//
//   APPLIED    error sentences correctly fixed AND passing the guards
//   BAD-APPLY  clean sentences changed AND passing the guards  <- the gate
//
// Retries only fire where the baseline was refused, so the baseline pass is run
// once and every variant reuses its refusal set.
//
// Nothing here is imported by the extension and nothing shipping is modified.

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { MODEL, OLLAMA_URL, applyLimit } from "./lib/harness.mjs";
import { CLEAN, ERRORS, CONTEXTS } from "./lib/sentence-corpus.mjs";
import { prepareSentenceRequest, guardSentenceResult, SENTENCE_FEW_SHOT } from "./lib/sentence-guards.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_CONTEXT = { hostname: "example.com" };
const ESCALATION_MODEL = process.env.PROOFER_ESCALATION_MODEL || "qwen3.5-9b-distilled:latest";

const argv = process.argv.slice(2);
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const ctxKeys = (argOf("--contexts") || "none,benign,messy").split(",").map((s) => s.trim());
const contexts = ctxKeys.map((k) => {
  const c = CONTEXTS.find((x) => x.key === k);
  if (!c) { console.error(`Unknown context ${k}. Have: ${CONTEXTS.map((x) => x.key).join(", ")}`); process.exit(1); }
  return c;
});

// --- the near-miss set, for variant (d) -------------------------------------
//
// Justification is in the report, from the baseline refusal breakdown: these
// are the guards that fire on a SHAPE mismatch (too much rewritten, too little
// left, boundaries moved) rather than on evidence that a specific word the user
// typed was replaced by a different one. The excluded reasons are the ones that
// name a substitution: retrying those is asking the model to have a second go
// at replacing the user's word.
// Everything here is a STRUCTURAL failure — the model lost the task, produced
// nothing, or reshaped the sentence. Deliberately absent: word-substituted,
// meaning-word-changed, negation-changed, capital-removed, typography-changed,
// contraction-expanded, terminator-changed, content-reordered, and
// target-too-short/long. The first eight mean the model altered a protected
// aspect of what the user typed, and asking it again is adversarial search
// against the guard that just did its job; the last two are properties of the
// INPUT, so a retry cannot change the verdict at all.
//
// Caveat on all of this: guardSentenceResult returns the FIRST guard that
// fires, so these buckets are order-dependent. A refusal filed under
// low-overlap may also have been substituting a word.
const NEAR_MISS = new Set([
  "low-overlap", "length-band", "too-many-changes", "sanitizer-would-change",
  "sentence-count", "sentence-boundary-moved", "sentence-split-fragment",
  "empty", "empty-after-sanitize", "no-output",
]);

// ---------------------------------------------------------------------------

const timings = new Map();   // label -> [ms]
function timed(label, ms) {
  if (!timings.has(label)) timings.set(label, []);
  timings.get(label).push(ms);
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * One call down the SHIPPING request path. `override` mutates only the sampling
 * options / model — the messages array, format, num_ctx and few-shot set are
 * whatever background.js builds.
 */
async function ask(sentence, priorContext, override = {}, label = "baseline") {
  const req = prepareSentenceRequest(sentence, priorContext, PAGE_CONTEXT, { ollamaModel: MODEL });
  if (override.model) req.body.model = override.model;
  Object.assign(req.body.options, override.options || {});
  const t0 = Date.now();
  let data;
  try {
    const res = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    data = await res.json();
  } catch (e) {
    timed(label, Date.now() - t0);
    return { out: null, error: String(e.message), ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  timed(label, ms);
  if (data.error) return { out: null, error: String(data.error), ms };
  if (data.done_reason === "length") return { out: null, error: "truncated", ms };
  let parsed;
  try { parsed = JSON.parse(String(data.message?.content ?? "").trim()); }
  catch { return { out: null, error: "bad-json", ms }; }
  const v = parsed?.rewritten;
  return { out: typeof v === "string" ? v : null, error: typeof v === "string" ? null : "no-rewritten-key", ms };
}

const guard = (orig, out) => (out === null ? "no-output" : guardSentenceResult(orig, out, out));

// --- baseline ---------------------------------------------------------------

console.log(`\nRetry experiment — sentence mode`);
console.log(`Base model:       ${MODEL}`);
console.log(`Escalation model: ${ESCALATION_MODEL}`);
console.log(`Ollama:           ${OLLAMA_URL}`);
console.log(`Corpus: ${applyLimit(CLEAN).length} clean + ${applyLimit(ERRORS).length} errors x ${contexts.length} context(s), ` +
  `${SENTENCE_FEW_SHOT.length} demonstrations`);

const baseline = [];   // one record per (context, sentence)
for (const ctx of contexts) {
  process.stdout.write(`\nbaseline [${ctx.key}] `);
  let n = 0;
  for (const s of applyLimit(CLEAN)) {
    const { out, error } = await ask(s, ctx.text, {}, "baseline");
    const changed = out !== s;
    const reason = changed ? guard(s, out) : null;
    baseline.push({
      ctx: ctx.key, kind: "clean", orig: s, expected: s, out, error,
      changed, reason, badApply: changed && !reason,
    });
    if (++n % 20 === 0) process.stdout.write(".");
  }
  for (const e of applyLimit(ERRORS)) {
    const { out, error } = await ask(e.in, ctx.text, {}, "baseline");
    const correct = out === e.expected || (e.alsoOk || []).includes(out);
    const reason = guard(e.in, out);
    baseline.push({
      ctx: ctx.key, kind: "error", orig: e.in, expected: e.expected, alsoOk: e.alsoOk || [],
      out, error, correct, reason,
      applied: correct && !reason,
      wrongApply: !correct && !reason && out !== null && out !== e.in,
    });
    if (++n % 20 === 0) process.stdout.write(".");
  }
}
process.stdout.write("\n");

// Every refusal is a retry candidate. On a clean sentence the model left alone
// there is nothing to retry; the refusal set is exactly where a retry fires.
const candidates = baseline.filter((r) => r.kind === "error" ? !!r.reason : (r.changed && !!r.reason));

console.log(`\nBaseline refusal set: ${candidates.length} candidates ` +
  `(${candidates.filter((c) => c.kind === "clean").length} clean, ${candidates.filter((c) => c.kind === "error").length} error)`);
const byReason = new Map();
for (const c of candidates) {
  const k = `${c.reason}`;
  if (!byReason.has(k)) byReason.set(k, { clean: 0, error: 0, errorCorrect: 0 });
  const b = byReason.get(k);
  b[c.kind]++;
  if (c.kind === "error" && c.correct) b.errorCorrect++;
}
console.log("reason                       clean  error  (of which the model was CORRECT)");
for (const [k, v] of [...byReason].sort((a, b) => (b[1].clean + b[1].error) - (a[1].clean + a[1].error))) {
  console.log(`  ${k.padEnd(26)}${String(v.clean).padStart(5)}${String(v.error).padStart(7)}${String(v.errorCorrect).padStart(9)}`);
}

// --- variants ---------------------------------------------------------------

const VARIANTS = [
  { key: "control-t0.1", label: "same prompt, temp 0.1, 1 retry (determinism control)",
    attempts: [{}] },
  { key: "a-t0.4x1", label: "resample temp 0.4, 1 retry",
    attempts: [{ options: { temperature: 0.4, seed: 101 } }] },
  { key: "b-t0.7x2", label: "resample temp 0.7, up to 2 retries",
    attempts: [{ options: { temperature: 0.7, seed: 202 } }, { options: { temperature: 0.7, seed: 303 } }] },
  { key: "c-qwen", label: `escalate to ${ESCALATION_MODEL} @ temp 0.1, 1 retry`,
    attempts: [{ model: ESCALATION_MODEL, options: { temperature: 0.1, repeat_penalty: 1.0 } }] },
];

const results = new Map();   // variant key -> [ per-candidate outcome ]

for (const v of VARIANTS) {
  process.stdout.write(`\n${v.key} `);
  const out = [];
  for (const c of candidates) {
    let landed = null, identical = null, attemptsUsed = 0, msTotal = 0;
    for (const a of v.attempts) {
      const r = await ask(c.orig, contexts.find((x) => x.key === c.ctx).text, a, v.key);
      attemptsUsed++;
      msTotal += r.ms;
      if (identical === null) identical = r.out === c.out;
      const reason = guard(c.orig, r.out);
      if (!reason) { landed = { out: r.out, reason: null }; break; }
      landed = { out: r.out, reason };
    }
    const passed = landed && !landed.reason;
    const correct = c.kind === "error" &&
      (landed?.out === c.expected || (c.alsoOk || []).includes(landed?.out));
    out.push({
      ...c, retryOut: landed?.out ?? null, retryReason: landed?.reason ?? null,
      retryPassed: !!passed, retryIdentical: identical, attemptsUsed, msTotal,
      // clean: passing the guards after a change is a NEW bad apply, unless the
      // retry happened to reproduce the original byte for byte.
      newBadApply: c.kind === "clean" && passed && landed.out !== c.orig,
      recoveredClean: c.kind === "clean" && landed?.out === c.orig,
      newApplied: c.kind === "error" && passed && correct,
      newWrongApply: c.kind === "error" && passed && !correct && landed.out !== c.orig,
    });
    process.stdout.write(".");
  }
  results.set(v.key, out);
}
process.stdout.write("\n");

// --- scoring ----------------------------------------------------------------

function score(rows, filter = () => true) {
  const fired = rows.filter(filter);
  return {
    fired: fired.length,
    passed: fired.filter((r) => r.retryPassed).length,
    newApplied: fired.filter((r) => r.newApplied).length,
    newBadApply: fired.filter((r) => r.newBadApply).length,
    newWrongApply: fired.filter((r) => r.newWrongApply).length,
    recoveredClean: fired.filter((r) => r.recoveredClean).length,
    identical: fired.filter((r) => r.retryIdentical).length,
    calls: fired.reduce((n, r) => n + r.attemptsUsed, 0),
    medMs: median(fired.map((r) => r.msTotal)),
  };
}

const baseApplied = baseline.filter((r) => r.kind === "error" && r.applied).length;
const baseBad = baseline.filter((r) => r.kind === "clean" && r.badApply).length;
const baseWrong = baseline.filter((r) => r.kind === "error" && r.wrongApply).length;
const nClean = baseline.filter((r) => r.kind === "clean").length;
const nErr = baseline.filter((r) => r.kind === "error").length;

// The ceiling on ANY retry-on-refusal policy: an error sentence the model
// failed to fix but whose output the guards ACCEPTED never triggers a retry, so
// no policy can reach it. Separating the two kinds of miss is the difference
// between "the guards are throwing away good corrections" and "the model is not
// producing them".
const errMisses = baseline.filter((r) => r.kind === "error" && !r.applied);
const missRefused = errMisses.filter((r) => r.reason).length;
const missUnchanged = errMisses.filter((r) => !r.reason && r.out === r.orig).length;
const missPassedWrong = errMisses.filter((r) => !r.reason && r.out !== r.orig).length;

console.log("\n" + "=".repeat(96));
console.log(`BASELINE over ${contexts.length} contexts: APPLIED ${baseApplied}/${nErr}   ` +
  `BAD-APPLY ${baseBad}/${nClean}   wrong-but-applied on errors ${baseWrong}/${nErr}`);
console.log(`Misses on error sentences: ${errMisses.length} total = ${missRefused} refused by a guard ` +
  `(the only ones a retry can reach) + ${missUnchanged} returned unchanged + ${missPassedWrong} changed wrongly but ACCEPTED`);

// The whole retry question in one table. `correct+refused` is the guards
// throwing away a good correction — the case the premise assumes. Everything
// else in the refused column is the model being wrong, where a retry has to
// produce a BETTER ANSWER, not merely a differently-shaped one.
{
  const cls = (r) => r.correct ? (r.reason ? "correct+refused" : "correct+pass")
    : (r.out === r.orig ? "no-op" : (r.reason ? "wrongChange+refused" : "wrongChange+PASS"));
  const keys = ["correct+pass", "correct+refused", "no-op", "wrongChange+refused", "wrongChange+PASS"];
  console.log("\nError-sentence outcome matrix (per context, n=" + (nErr / contexts.length) + "):");
  console.log("context".padEnd(12) + keys.map((k) => k.padStart(21)).join(""));
  const tot = {};
  for (const c of contexts) {
    const m = {};
    for (const r of baseline.filter((r) => r.ctx === c.key && r.kind === "error")) {
      const k = cls(r); m[k] = (m[k] || 0) + 1; tot[k] = (tot[k] || 0) + 1;
    }
    console.log(c.key.padEnd(12) + keys.map((k) => String(m[k] || 0).padStart(21)).join(""));
  }
  console.log("TOTAL".padEnd(12) + keys.map((k) => String(tot[k] || 0).padStart(21)).join(""));
  console.log(`Retry headroom = the two refused columns; correct+refused is ${tot["correct+refused"] || 0}.`);
}
console.log("=".repeat(96));
console.log("variant                              fired  pass  +APPLIED  +BAD-APPLY  +wrong  med-ms  identical");
console.log("-".repeat(96));

const table = [];
for (const v of VARIANTS) {
  const rows = results.get(v.key);
  const all = score(rows);
  table.push({ key: v.key, label: v.label, ...all, selective: null });
  console.log(`${v.key.padEnd(34)}${String(all.fired).padStart(6)}${String(all.passed).padStart(6)}` +
    `${String(all.newApplied).padStart(10)}${String(all.newBadApply).padStart(12)}` +
    `${String(all.newWrongApply).padStart(8)}${String(all.medMs ?? "—").padStart(8)}` +
    `${String(all.identical + "/" + all.fired).padStart(11)}`);
}

// Variant (d): a pure FILTER over the already-measured retries of (a) and (c).
// It fires no extra requests — a selective policy is the same retry restricted
// to a subset of refusal reasons, so its outcome per candidate is known.
console.log("-".repeat(96));
console.log("selective (near-miss reasons only) — a filter over the runs above, no extra calls:");
for (const base of ["a-t0.4x1", "c-qwen", "b-t0.7x2"]) {
  const rows = results.get(base);
  const s = score(rows, (r) => NEAR_MISS.has(r.reason));
  table.push({ key: `d-selective(${base})`, label: `selective retry over ${base}`, ...s, selective: true });
  console.log(`${("d/" + base).padEnd(34)}${String(s.fired).padStart(6)}${String(s.passed).padStart(6)}` +
    `${String(s.newApplied).padStart(10)}${String(s.newBadApply).padStart(12)}` +
    `${String(s.newWrongApply).padStart(8)}${String(s.medMs ?? "—").padStart(8)}` +
    `${String(s.identical + "/" + s.fired).padStart(11)}`);
}

// Per-context bad-apply totals, because the gate is per context.
console.log("\nBAD-APPLY per context (gate is 2 per context, on the clean set):");
const hdr = ["variant".padEnd(24), ...contexts.map((c) => c.key.padStart(11))].join("");
console.log(hdr);
const baseRow = contexts.map((c) =>
  String(baseline.filter((r) => r.ctx === c.key && r.kind === "clean" && r.badApply).length).padStart(11)).join("");
console.log("baseline".padEnd(24) + baseRow);
for (const v of VARIANTS) {
  const rows = results.get(v.key);
  const line = contexts.map((c) => {
    const b = baseline.filter((r) => r.ctx === c.key && r.kind === "clean" && r.badApply).length;
    const add = rows.filter((r) => r.ctx === c.key && r.newBadApply).length;
    return `${b + add}(+${add})`.padStart(11);
  }).join("");
  console.log(v.key.padEnd(24) + line);
}
for (const base of ["a-t0.4x1", "c-qwen", "b-t0.7x2"]) {
  const rows = results.get(base).filter((r) => NEAR_MISS.has(r.reason));
  const line = contexts.map((c) => {
    const b = baseline.filter((r) => r.ctx === c.key && r.kind === "clean" && r.badApply).length;
    const add = rows.filter((r) => r.ctx === c.key && r.newBadApply).length;
    return `${b + add}(+${add})`.padStart(11);
  }).join("");
  console.log(("d/" + base).padEnd(24) + line);
}

// --- examples ---------------------------------------------------------------

function show(title, rows, n = 8) {
  if (!rows.length) { console.log(`\n${title}: none`); return; }
  console.log(`\n${title}:`);
  for (const r of rows.slice(0, n)) {
    console.log(`  [${r.ctx}] ${JSON.stringify(r.orig)}`);
    console.log(`     baseline -> ${JSON.stringify(r.out)}   (${r.reason})`);
    console.log(`     retry    -> ${JSON.stringify(r.retryOut)}`);
  }
}
for (const v of VARIANTS) {
  const rows = results.get(v.key);
  show(`${v.key} — correct fixes RECOVERED by retry`, rows.filter((r) => r.newApplied));
  show(`${v.key} — BAD APPLIES introduced by retry`, rows.filter((r) => r.newBadApply));
  show(`${v.key} — wrong-but-applied on error sentences (silent damage)`, rows.filter((r) => r.newWrongApply), 4);
}

// --- latency ----------------------------------------------------------------

console.log("\nWall-clock per call (median / n). Another process may be sharing this Ollama,");
console.log("so treat these as an upper bound rather than a clean measurement:");
for (const [k, a] of timings) console.log(`  ${k.padEnd(24)} ${String(median(a)).padStart(6)}ms   n=${a.length}`);

const outPath = process.env.PROOFER_RESULT_JSON ||
  join(__dirname, "results", "retry-experiment.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({
  model: MODEL, escalationModel: ESCALATION_MODEL, contexts: ctxKeys,
  baseline: { applied: baseApplied, badApply: baseBad, wrongApply: baseWrong, nClean, nErr,
    misses: { total: errMisses.length, refused: missRefused, unchanged: missUnchanged, passedWrong: missPassedWrong } },
  baselineRecords: baseline,
  nearMiss: [...NEAR_MISS], table,
  candidates: candidates.map((c) => ({ ctx: c.ctx, kind: c.kind, orig: c.orig, out: c.out, reason: c.reason, correct: c.correct })),
  variants: Object.fromEntries([...results].map(([k, v]) => [k, v])),
  timings: Object.fromEntries([...timings].map(([k, a]) => [k, { median: median(a), n: a.length }])),
}, null, 2));
console.log(`\nWrote ${outPath}`);
