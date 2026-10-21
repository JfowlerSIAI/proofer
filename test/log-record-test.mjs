#!/usr/bin/env node
// Synthetic exports only; no model, browser, dependencies or external URLs.
// Keep admission disabled if replay ever imports the shared research harness.
process.env.PROOFER_SKIP_DIGEST_CHECK = "1";
const { normalizeInteraction, interactionAttempts } = await import("./lib/log-record.mjs");
const { normalizeRecord, loadRecords, replayFile } = await import("./replay-log-guards.mjs");
const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
let passed = 0, failed = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else { failed++; console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}
const temp = mkdtempSync(join(tmpdir(), "proofer-log-record-"));
const input = "The sample label was meant to greet group of folx?";
const first = "The sample label was meant to greet a group of fixed?";
const accepted = "The sample label was meant to greet a group of folx?";
const guard = "word-substituted:folx";
const t = { wallMs: 3000, totalMs: 400, loadMs: 100, promptTokens: 100, promptMs: 200, evalTokens: 12, evalMs: 100 };
function file(name, rows) {
  const path = join(temp, name + ".jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}
try {
  // [2a] Mutant: set duplicate = false in interactionAttempts. The unavailable
  // accepted-retry output and replayed refusal count turn red.
  console.log("[2a] legacy timeout duplicate and explicit unknown evidence");
  const old = { v: 1, path: "sentence", id: "sn_old", input, output: first, guard,
    error: "consent-read-timeout", startedAt: 1000, ts: 5000, timings: t,
    verdict: "sentence-undo-unverified",
    retry: { outcome: "applied", dispatched: true, firstOutput: first, firstGuard: guard, timings: { ...t, wallMs: 1000 } } };
  const path = file("legacy", [old]);
  const attempts = interactionAttempts(old);
  check("[2a] legacy timeout has one refusal and an unavailable accepted output", attempts.map((a) => [a.attempt, a.output, a.guard, a.outcome, a.unavailable || null]),
    [["first", first, guard, "refused", null], ["retry", null, null, "applied", "legacy-accepted-retry-output"]]);
  const replay = replayFile(path);
  check("[2a] replay counts first refusal once", [replay.total, replay.counts.refused, replay.unreplayable, replay.coverage.unavailableOutputs], [2, 1, 1, 1]);
  check("[2a] legacy attempt wall is unknown, retry wall retained", attempts.map((a) => a.timings.wallMs), [null, 1000]);
  check("[2a] no invented attempt endpoints", attempts.map((a) => [a.dispatchedAt, a.completedAt]), [[null, null], [null, null]]);
  const n = normalizeInteraction(old);
  check("[2a] arrival uses startedAt, completion and sentence lease stay unknown",
    [n.arrivedAt, n.arrivalEvidence, n.completedAt, n.keepAliveMs, n.backend, n.dispatched], [1000, "legacy-startedAt", null, null, null, true]);
  const unknown = normalizeInteraction({ path: "sentence", options: { num_ctx: 2048 }, timings: { wallMs: 44 }, ts: 999 });
  // Mutant: treat a numeric wall as dispatch evidence. Unknown-dispatch red.
  check("[2a] prepared wall is unknown dispatch and write time is not arrival",
    [unknown.dispatched, unknown.arrivedAt, unknown.arrivalEvidence], [null, null, "unknown"]);
  check("[2a] later undo verdict stays a user outcome", normalizeRecord(old).userVerdict, "sentence-undo-unverified");
  const shape = normalizeRecord({ input, output: "", error: "invalid-json", guard: "invalid-json" });
  check("[2a] G1 historical model-shape error is not a guard", [shape.recorded, shape.recordedGuard, shape.output], ["error", null, ""]);
  const corpus = normalizeRecord({ sentence: input, output: first, verdict: guard, outcome: "refused" });
  check("[2a] corpus verdict is a guard, never a user verdict", [corpus.recorded, corpus.recordedGuard, corpus.userVerdict], ["refused", guard, null]);
  check("[2a] no-change echo remains replayable", normalizeRecord({ path: "sentence", input, noChanges: true }).output, input);
  const delivered = { ...old, output: accepted, guard: null, error: null, verdict: "sentence-suggestion-applied" };
  check("[2a] delivered legacy retry expands in attempt order", loadRecords(file("delivered", [delivered])).map((a) => [a.output, a.recorded]), [[first, "refused"], [accepted, "applied"]]);

  // [2b] Mutant: filter replayAttempts by equal output text. Both the legacy
  // and v2 genuine-identical refusals must still replay twice.
  console.log("[2b] genuine repeated refusals and canonical v2 attempts");
  const repeated = { ...old, error: null, retry: { outcome: "refused", dispatched: true, output: first, guard, timings: t } };
  const modern = { ...repeated, v: 2, arrivedAt: 1000, completedAt: 4000, dispatched: true,
    // Deliberately stale compatibility projections: v2 must not expand them.
    output: accepted, retry: { ...old.retry, output: "ignored alias" },
    attempts: ["first", "retry"].map((attempt, i) => ({ attempt, dispatchedAt: 1000 + i * 1000,
      completedAt: 1500 + i * 1000, timings: { ...t, wallMs: 500 }, output: first, guard, error: null, outcome: "refused" })) };
  for (const [name, row] of [["legacy", repeated], ["v2", modern]]) {
    const rows = loadRecords(file("repeat-" + name, [row]));
    check(`[2b] ${name} equal genuine refusals remain two`, rows.map((r) => [r.attempt, r.output, r.recordedGuard]), [["first", first, guard], ["retry", first, guard]]);
  }
  // Mutant: bypass the v2 attempts return. Canonical empty output and exact
  // attempt fields/measurements fail, independently of compatibility aliases.
  const empty = { ...modern, attempts: [{ ...modern.attempts[0], output: "" }] };
  check("[2b] v2 attempt rows retained without reconstruction", interactionAttempts(empty), empty.attempts);
  check("[2b] v2 raw empty string survives replay", loadRecords(file("empty", [empty])).map((r) => r.output), [""]);
  const unsent = { ...modern, dispatched: false, attempts: [], keepAliveMs: null, output: null, error: "model-unverified" };
  const mixed = file("mixed", [modern, modern, unsent, { path: "warmup", id: "w1" }]);
  const rows = loadRecords(mixed);
  check("[2b] repeated IDs retain source row identity", rows.filter((r) => r.path === "sentence").map((r) => r.source.row), [1, 1, 2, 2]);
  const result = replayFile(mixed);
  check("[2b] unsent interaction contributes coverage, no attempt", result.coverage,
    { interactions: 3, unsent: 1, unknownDispatch: 0, unavailableOutputs: 0 });
  check("[2b] mixed replay counts canonical attempts only", [result.total, result.counts.refused, result.skips["not-sentence"]], [5, 4, 1]);
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
