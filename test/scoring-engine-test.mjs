// Do the quality suites score what the product would deliver?
//
// Offline: a loopback fake Ollama, no model, no browser, no node_modules. The
// LLM suites (proofer-test, proofer-holdout, meaning-drift) reach the model
// through lib/scoring.mjs callSentence, which since 2026-09-25 runs
// background.js's own sentence engine. Before that it had a caller of its own
// -- a 120 s timeout, no guard-informed retry, and a truncated reply accepted
// whenever its JSON happened to parse -- so it scored outcomes the product
// never delivers (beta checkpoint 1). Each case here is one of those outcomes,
// scripted, and each must score the way the product would:
//
//   [1] a correction lands                  -> the corrected text
//   [2] a reply truncated at num_predict,   -> the INPUT: a model-shape error
//       whose JSON still parses
//   [3] a reply slower than the deadline    -> the INPUT: the product drops it
//   [4] a refusal the retry salvages        -> the salvaged text, two requests
//  [4b] a refusal with no budget left       -> one request, no retry counted
//  [4c] a retry sent and refused again      -> two requests, one retry counted
//  [4d] an accepted but expired retry      -> input, expiry, zero salvage
//  [4e] two attempts, including a failure  -> separate walls and token counters
//   [5] PROOFER_OPTIONS                     -> reaches the request actually sent
//   [6] the pinned tag with another digest  -> the run stops; nothing scored
//  [6b] research digest policy in scoring  -> admission and inference agree
//  [6c] research digest policy in benchmark -> admission and inference agree
//   [7] direct-fetch latency API           -> raw counters still work
//
//   node scoring-engine-test.mjs

import http from "http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const child = (args, env) => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, args, { cwd: testDir, env });
  let output = "";
  proc.stdout.on("data", (s) => { output += s; });
  proc.stderr.on("data", (s) => { output += s; });
  proc.on("error", reject);
  proc.on("close", (code) => resolve({ code, output }));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL ${label}`); } };

// --- the fake Ollama ---------------------------------------------------------
let chats = [];          // request bodies, in order
let script = [];         // one function(body) -> { delayMs, reply } per chat call
let tagsDigest = null;   // the digest /api/tags reports for the pinned tag
let pinnedTag = null;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/tags") {
    res.end(JSON.stringify({ models: [{ name: pinnedTag, model: pinnedTag, digest: tagsDigest }] }));
    return;
  }
  if (req.url === "/api/chat") {
    const parsed = JSON.parse(body);
    chats.push(parsed);
    const next = script.shift();
    if (!next) { res.statusCode = 500; res.end(JSON.stringify({ error: "unscripted" })); return; }
    const { delayMs = 0, status = 200, reply } = next(parsed);
    if (delayMs) await sleep(delayMs);
    res.statusCode = status;
    res.end(JSON.stringify(reply));
    return;
  }
  if (["/api/show", "/api/version", "/api/ps"].includes(req.url)) {
    res.end(JSON.stringify(req.url === "/api/version" ? { version: "0.34.3" } : {}));
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.PROOFER_OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
process.env.PROOFER_OPTIONS = JSON.stringify({ temperature: 0.37 });
delete process.env.PROOFER_MODEL;
delete process.env.PROOFER_DEADLINE_MS;
delete process.env.PROOFER_SENTENCE_GUARDS;
delete process.env.PROOFER_SKIP_DIGEST_CHECK;

// The pin has to be known before the harness checks it at import.
const { PINNED_MODEL, forgetModelDigests, setEngineClock } = await import("./lib/sentence-guards.mjs");
pinnedTag = PINNED_MODEL.tag;
tagsDigest = PINNED_MODEL.digest;
const { callSentence, sentenceOutcomes } = await import("./lib/scoring.mjs");
const { createLatencyTracker, formatLatencyReport } = await import("./lib/harness.mjs");

const answer = (rewritten, extra = {}) => () => ({
  reply: { message: { content: JSON.stringify({ rewritten }) }, done_reason: "stop",
    total_duration: 3e8, load_duration: 0, prompt_eval_count: 100, eval_count: 12, ...extra },
});

console.log("\ncallSentence scores what the product would deliver\n" + "=".repeat(72));

// [1]
{
  chats = [];
  script = [answer("We received the invoice yesterday.")];
  const r = await callSentence("We recieved the invoice yesterday.");
  ok(r.text === "We received the invoice yesterday." && r.outcome === "applied",
    `[1] a correction lands (got ${JSON.stringify(r)})`);
}
// [2]
{
  chats = [];
  script = [answer("We received the invoice yesterday.", { done_reason: "length" })];
  const r = await callSentence("We recieved the invoice yesterday.");
  ok(r.text === "We recieved the invoice yesterday." && r.refused === "truncated" && r.outcome === "truncated",
    `[2] a parsable truncated reply scores as the input, outcome "truncated" (got ${JSON.stringify(r)})`);
  ok(sentenceOutcomes.truncated === 1 && sentenceOutcomes.refused === 0
    && sentenceOutcomes.errors === 0 && sentenceOutcomes.retried === 0,
    "[2] parsable truncation counts as truncated, without a guard refusal, other error or retry");
}
// [2b] Mutant: if (payload.refused || payload.error === "truncated") in
// callSentence; truncated's outcome and counter-delta assertions turn red.
for (const [error, content, doneReason, truncated, errors] of [
  ["truncated", '{"rewritten":', "length", 1, 0],
  ["invalid-json", '{"rewritten":', "stop", 0, 1],
  ["no-rewritten-key", '{"output":"a different key"}', "stop", 0, 1],
]) {
  chats = [];
  const before = { ...sentenceOutcomes };
  script = [answer("unused", { message: { content }, done_reason: doneReason })];
  const r = await callSentence("We recieved the invoice yesterday.");
  ok(r.text === "We recieved the invoice yesterday." && r.raw === null
    && r.refused === error && r.outcome === error,
    `[2b] ${error} preserves the input and result shape with the error outcome`);
  ok(chats.length === 1 && script.length === 0, `[2b] ${error} sends once without retry`);
  const deltas = Object.fromEntries(["sent", "applied", "noChange", "refused", "retried", "salvaged",
    "expired", "truncated", "errors"].map((k) => [k, sentenceOutcomes[k] - before[k]]));
  ok(JSON.stringify(deltas) === JSON.stringify({ sent: 1, applied: 0, noChange: 0, refused: 0,
    retried: 0, salvaged: 0, expired: 0, truncated, errors }),
    `[2b] ${error} has only its error counter delta (got ${JSON.stringify(deltas)})`);
}

// [3]
{
  chats = [];
  ok(sentenceOutcomes.deadlineMs === 4750,
    `[3] the deadline is the product's, 4750 ms (got ${sentenceOutcomes.deadlineMs})`);
  script = [() => ({ delayMs: 5200, ...answer("We received the invoice yesterday.")() })];
  const t0 = Date.now();
  const r = await callSentence("We recieved the invoice yesterday.");
  const took = Date.now() - t0;
  ok(r.text === "We recieved the invoice yesterday." && r.outcome === "delivery-expired",
    `[3] a reply past the deadline scores as the input (got ${JSON.stringify(r)})`);
  ok(took < 5100, `[3] ...and is abandoned AT the deadline, not waited for (${took} ms)`);
  ok(sentenceOutcomes.expired === 1, "[3] ...and counted as expired");
}
// [4] The folx pair (sentence-retry-handler-test.mjs): the first answer is
// refused word-substituted:folx, and the constrained retry keeps the word.
{
  chats = [];
  const S = "The sample label was meant to greet group of folx?";
  script = [answer("The sample label was meant to greet a group of fixed?"),
    answer("The sample label was meant to greet a group of folx?")];
  const r = await callSentence(S);
  ok(r.text === "The sample label was meant to greet a group of folx?" && chats.length === 2,
    `[4] a refusal the retry salvages scores as the salvage, in two requests (got ${JSON.stringify(r)}, ${chats.length})`);
  ok(/Do not change these words/.test(chats[1] && chats[1].messages[0].content),
    "[4] ...and the second request is the constrained retry");
  ok(sentenceOutcomes.salvaged === 1, "[4] ...counted as salvaged");
}
// [4b] A refusal that uses up the budget: the retry is not sent, and is not
// counted as one (checkpoint 1 re-check: pre-send outcomes were).
{
  chats = [];
  const retriedBefore = sentenceOutcomes.retried;
  script = [() => ({ delayMs: 2900, ...answer("The sample label was meant to greet a group of fixed?")() })];
  const r = await callSentence("The sample label was meant to greet group of folx?");
  ok(chats.length === 1 && r.refused && sentenceOutcomes.retried === retriedBefore,
    `[4b] no budget left: one request, refused, and no retry counted (got ${chats.length}, ${JSON.stringify(r.refused)}, retried ${sentenceOutcomes.retried - retriedBefore})`);
}
// [4c] A retry that is sent and refused again: counted as a retry, two
// requests, and the field keeps the input.
{
  chats = [];
  const retriedBefore = sentenceOutcomes.retried;
  const refusedAnswer = "The sample label was meant to greet a group of fixed?";
  script = [answer(refusedAnswer), answer(refusedAnswer)];
  const r = await callSentence("The sample label was meant to greet group of folx?");
  ok(chats.length === 2 && r.refused && sentenceOutcomes.retried === retriedBefore + 1,
    `[4c] a sent-and-refused retry is counted (got ${chats.length} requests, retried ${sentenceOutcomes.retried - retriedBefore})`);
}
// [4d] Mutant: if (meta.retry && meta.retry.outcome === "applied") o.salvaged++;
// in callSentence; only the zero-salvage assertion turns red.
{
  chats = [];
  const before = { ...sentenceOutcomes };
  const start = Date.now();
  let now = start;
  setEngineClock(() => now);
  script = [answer("The sample label was meant to greet a group of fixed?"),
    () => { now = start + 4800; return answer("The sample label was meant to greet a group of folx?")(); }];
  try {
    const r = await callSentence("The sample label was meant to greet group of folx?");
    ok(r.text === "The sample label was meant to greet group of folx?"
      && r.outcome === "delivery-expired", "[4d] accepted but expired retry scores unchanged input");
    ok(chats.length === 2 && sentenceOutcomes.retried - before.retried === 1,
      "[4d] one retry was dispatched");
    ok(sentenceOutcomes.expired - before.expired === 1, "[4d] one expiry is counted");
    ok(sentenceOutcomes.salvaged - before.salvaged === 0, "[4d] expired retry counts zero salvage");
  } finally { setEngineClock(Date.now); }
}
// [4e] Mutant: feed meta.attempts.slice(0, 1) to latency.recordInteraction in
// callSentence; two-attempt counts, walls and successful-retry token totals fail.
for (const failedRetry of [false, true]) {
  chats = [];
  const latency = createLatencyTracker();
  const start = Date.now();
  let now = start;
  setEngineClock(() => now);
  script = [
    () => { now = start + 300; return answer("The sample label was meant to greet a group of fixed?")(); },
    () => { now = start + 1000; return failedRetry ? { status: 503, reply: {} }
      : answer("The sample label was meant to greet a group of folx?")(); },
  ];
  try {
    const r = await callSentence("The sample label was meant to greet group of folx?", { latency });
    const label = `[4e] ${failedRetry ? "failed" : "accepted"} retry`;
    const stats = latency.stats();
    const samples = latency.samples();
    ok(chats.length === 2 && r.outcome === (failedRetry ? "refused" : "applied"), `${label}: two dispatches reach the expected outcome`);
    ok(stats.interaction?.count === 1, `${label}: one interaction`);
    ok(stats.count === 2 && latency.count === 2, `${label}: two request samples`);
    ok(JSON.stringify(samples.map(s => s.wallMs)) === "[300,700]", `${label}: each attempt has its own wall`);
    ok(stats.evalTokensTotal === (failedRetry ? 12 : 24), `${label}: evaluation tokens include every measured attempt`);
    ok(stats.promptTokensTotal === (failedRetry ? 100 : 200), `${label}: prompt tokens include every measured attempt`);
    if (failedRetry) {
      ok(samples[1] && ["totalMs", "loadMs", "promptTokens", "promptMs", "evalTokens", "evalMs"]
        .every(k => samples[1][k] === null), `${label}: missing counters stay null`);
    }
    const report = formatLatencyReport(stats);
    ok(report.includes("Latency (per interaction, wall-clock over 1 calls):")
      && report.includes("Latency (per attempt, wall-clock over 2 calls):")
      && !report.includes("spent in Ollama"), `${label}: report separates interaction and attempt walls`);
  } finally { setEngineClock(Date.now); }
}
// [5]
ok(chats.length && chats.every((b) => b.options && b.options.temperature === 0.37),
  `[5] PROOFER_OPTIONS reaches every request sent (got ${JSON.stringify(chats.map((b) => b.options && b.options.temperature))})`);
ok(chats.length && chats.every((b) => b.model === PINNED_MODEL.tag && b.format === "json"),
  "[5] ...which is otherwise the product's request (pinned model, JSON format)");
// [6]
{
  chats = [];
  tagsDigest = "f".repeat(64);
  script = [answer("We received the invoice yesterday.")];
  // The lookup is cached for 30 s and no request has failed, so start from a
  // forgotten cache, as a new run would.
  forgetModelDigests();
  const latency = createLatencyTracker();
  let threw = null;
  try { await callSentence("We recieved the invoice yesterday.", { latency }); } catch (e) { threw = e.message; }
  ok(/model-mismatch/.test(threw || "") && chats.length === 0,
    `[6] another digest under the pinned tag stops the run, nothing sent (got ${threw}, ${chats.length})`);
  ok(latency.stats()?.interaction?.count === 1 && latency.count === 0,
    "[6] unsent mismatch retains one interaction without an attempt");
}

// [6b] Mutant: restore model === PINNED_MODEL.tag ? PINNED_MODEL.digest : null
// for callSentence's expectedDigest; the opt-out child's score and send fail.
for (const [model, skip, expectedCalls] of [
  [PINNED_MODEL.tag, "", 0], [PINNED_MODEL.tag, "0", 1], ["research-candidate", "", 1],
]) {
  chats = [];
  script = [answer("We received the invoice yesterday.")];
  const r = await child(["--input-type=module", "-e", `
    const { callSentence } = await import('./lib/scoring.mjs');
    const { createLatencyTracker } = await import('./lib/harness.mjs');
    const result = await callSentence('We recieved the invoice yesterday.', { latency: createLatencyTracker() });
    if (result.text !== 'We received the invoice yesterday.' || result.outcome !== 'applied') process.exit(2);
    console.log('scored correction');
  `], { ...process.env, PROOFER_MODEL: model, PROOFER_SKIP_DIGEST_CHECK: skip });
  const label = `[6b] ${model}, opt-out ${JSON.stringify(skip)}`;
  ok(expectedCalls ? r.code === 0 && r.output.includes("scored correction")
    : r.code === 1 && r.output.includes("MODEL DIGEST MISMATCH"), `${label}: admission and scoring agree (${r.output.trim()})`);
  ok(chats.length === expectedCalls, `${label}: ${expectedCalls} chat dispatches`);
  if (expectedCalls) ok(chats[0]?.model === (model === "research-candidate" ? "research-candidate:latest" : model),
    `${label}: canonical tag reaches chat`);
}
// [6c] Mutant: restore MODEL === PINNED_MODEL.tag ? PINNED_MODEL.digest : null
// in the benchmark; its opt-out completion, delivery and dispatch assertions fail.
{
  const dir = mkdtempSync(join(tmpdir(), "proofer-scoring-benchmark-"));
  const benchmark = join(dir, "benchmark.jsonl");
  writeFileSync(benchmark, JSON.stringify({ uid: "synthetic-1", sentence: "We recieved the invoice yesterday." }) + "\n");
  try {
    for (const skip of ["", "1"]) {
      chats = [];
      script = [answer("Please review the document."), answer("We received the invoice yesterday.")];
      const output = join(dir, `result-${skip || "pinned"}.jsonl`);
      const r = await child(["model-sentence-benchmark.mjs", "--benchmark", benchmark, "--out", output],
        { ...process.env, PROOFER_MODEL: PINNED_MODEL.tag, PROOFER_SKIP_DIGEST_CHECK: skip });
      if (skip) {
        ok(r.code === 0 && r.output.includes('1/1 {"applied":1}'), `[6c] opt-out benchmark completes (${r.output.trim()})`);
        const row = JSON.parse(readFileSync(output, "utf8").trim());
        ok(row.delivered === "We received the invoice yesterday." && row.outcome === "applied",
          "[6c] opt-out benchmark records delivered correction");
        ok(chats.length === 2, "[6c] opt-out benchmark sends warmup and measured chat");
      } else {
        ok(r.code === 1 && r.output.includes("MODEL DIGEST MISMATCH"), "[6c] benchmark without opt-out rejects mismatch");
        ok(chats.length === 0, "[6c] rejected benchmark sends no chat, including warmup");
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// [7] Mutant: evalTokens: null in the direct-fetch record adapter; token totals
// and generation throughput fail. Missing counters must remain unavailable.
{
  const latency = createLatencyTracker();
  latency.record(250, { total_duration: 2e8, load_duration: 1e7,
    prompt_eval_count: 100, prompt_eval_duration: 5e7, eval_count: 12, eval_duration: 1e8 });
  const stats = latency.stats();
  ok(latency.count === 1 && stats.count === 1 && stats.totalMs === 250, "[7] direct fetch keeps request count and wall");
  ok(stats.evalTokensTotal === 12 && stats.promptTokensTotal === 100, "[7] direct fetch preserves token totals");
  ok(stats.genTokensPerSec === 120 && stats.promptTokensPerSec === 2000 && stats.maxLoadMs === 10,
    "[7] direct fetch converts nanoseconds for throughput and load");
  const missing = createLatencyTracker();
  missing.record(50, {});
  ok(missing.samples()[0].evalTokens === null && missing.stats().evalTokensTotal === null
    && missing.stats().maxLoadMs === null, "[7] missing direct-fetch counters remain unavailable");
  latency.record(50, { eval_count: 5, prompt_eval_duration: 1e8 });
  ok(latency.stats().evalTokensTotal === 17 && latency.stats().promptTokensTotal === 100
    && latency.stats().genTokensPerSec === 120 && latency.stats().promptTokensPerSec === 2000,
    "[7] totals include unpaired counts; throughput uses only paired counters");
}

server.close();
console.log("\n" + "=".repeat(72));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
