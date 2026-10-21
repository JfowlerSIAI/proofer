#!/usr/bin/env node
// Synthetic CLI fixtures: Node builtins only, no browser or external URLs.
// The child disables harness digest admission before imports can fetch tags.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const here = dirname(fileURLToPath(import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "proofer-log-latency-"));
let passed = 0, failed = 0, serial = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else { failed++; console.log(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}
function run(rows) {
  const file = join(temp, `${++serial}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const child = spawnSync(process.execPath, [join(here, "log-latency.mjs"), file], {
    encoding: "utf8", env: { ...process.env, PROOFER_SKIP_DIGEST_CHECK: "1" }, timeout: 15000,
  });
  if (child.status !== 0) throw new Error(`CLI failed (${child.status}): ${child.stderr}\n${child.stdout}`);
  return child.stdout;
}
const t = (wallMs, loadMs = 0) => ({ wallMs, loadMs, totalMs: wallMs, promptTokens: 100, promptMs: 100, evalTokens: 12, evalMs: 100 });
function row(arrivedAt = 1000, wallMs = 1000, loadMs = 0, extra = {}) {
  return { v: 2, path: "sentence", id: "sn_same", arrivedAt, startedAt: arrivedAt,
    completedAt: arrivedAt + wallMs, ts: arrivedAt + wallMs + 100, dispatched: true,
    model: "synthetic-a", options: { num_ctx: 2048 }, keepAliveMs: 20000,
    timings: t(wallMs, loadMs), attempts: [{ attempt: "first", dispatchedAt: arrivedAt,
      completedAt: arrivedAt + wallMs, timings: t(wallMs, loadMs), error: null }], ...extra };
}
function causes(out) {
  return [...out.matchAll(/^  ([a-z-]+)\s+\d+\s+\S+ lost/gm)].map((m) => m[1]).sort();
}
try {
  // [1] Mutant: add retry walls to the interaction denominator in log-latency.
  // Only the v1/v2 "loading denominator" assertions turn red (33.3% -> 25.0%).
  console.log("[1] one interaction, two attempts, one loading denominator");
  const modern = row(1000, 3000, 1000, {
    attempts: [
      { attempt: "first", dispatchedAt: 1000, completedAt: 3000, timings: t(2000, 1000) },
      { attempt: "retry", dispatchedAt: 3000, completedAt: 4000, timings: t(1000) },
    ], retry: { dispatched: true, outcome: "applied", timings: t(1000) },
  });
  const legacy = { ...modern, v: 1, arrivedAt: undefined, completedAt: undefined, attempts: undefined };
  for (const [name, r] of [["v1", legacy], ["v2", modern]]) {
    const out = run([r]);
    check(`[1] ${name} loading denominator`, out.includes("33.3% of recorded interaction wall time"), true);
    check(`[1] ${name} cardinality`, out.includes("1 interactions, 2 dispatched attempts (1 retries)"), true);
    check(`[1] ${name} separate token totals`, out.includes("generation: 24 tokens, coverage=2/2"), true);
    check(`[1] ${name} attempt wall coverage`, out.includes(name === "v1" ? "attempt wall: recorded=1, unknown=1" : "attempt wall: recorded=2, unknown=0"), true);
  }
  // Canonical aliases cannot introduce a third request or supply its counters.
  const aliases = run([{ ...modern, retry: { ...modern.retry, timings: t(9999, 9999) } }]);
  check("[1] v2 ignores retry aliases", aliases.includes("1000ms spent loading") && aliases.includes("generation: 24 tokens"), true);

  // [2a]/[2b] Mutant: const endpoint = r.ts (write time replaces arrival).
  // "18.5s arrival" and "89s arrival" become short-tail and idle-expiry.
  console.log("[2a] arrival before the 20s boundary");
  check("[2a] 18.5s arrival", causes(run([row(), row(20500, 3000, 1000)])), ["unexplained"]);
  console.log("[2b] arrival before the 90s boundary");
  check("[2b] 89s arrival", causes(run([row(), row(91000, 3000, 1000)])), ["short-tail"]);
  // A retry compares its own dispatch, not its interaction's earlier arrival.
  // Mutant: endpoint: arrival in latencyAttempts; "retry dispatch endpoint" fails.
  check("[2b] retry dispatch endpoint", causes(run([row(1000, 23000, 0, { attempts: [
    { attempt: "first", dispatchedAt: 1000, completedAt: 2000, timings: t(1000) },
    { attempt: "retry", dispatchedAt: 23000, completedAt: 24000, timings: t(1000, 1000) },
  ] })])), ["short-tail"]);

  // [2c] Additional mutants: ignore the ambiguous branch (legacy retry/overlap
  // assertions fail); default a missing predecessor lease to 90000 (the missing
  // sentence lease assertion fails).
  // [2c] Mutant: label the write-time-proxy arrival as measured in latencyAttempts.
  // "write-time fallback labelled" turns red; unknown evidence stays explicit.
  console.log("[2c] legacy endpoints, missing evidence and overlap");
  const old = (r) => ({ ...r, v: 1, arrivedAt: undefined, completedAt: undefined, attempts: undefined });
  const started = run([old(row()), old(row(20500, 3000, 1000))]);
  check("[2c] legacy startedAt boundary", causes(started), ["unexplained"]);
  check("[2c] legacy startedAt labelled", started.includes("legacy-startedAt=2") && started.includes("legacy-wall-proxy=2"), true);
  const proxy = run([old(row(1000, 1000, 1000, { startedAt: undefined }))]);
  check("[2c] write-time fallback labelled", proxy.includes("attempt arrival: write-time-proxy=1") && proxy.includes("attempt completion: write-time-proxy=1"), true);
  check("[2c] legacy retry ordering insufficient", causes(run([legacy])), ["insufficient-evidence"]);
  check("[2c] overlap insufficient", causes(run([row(1000, 5000), row(2000, 1000, 1000)])), ["insufficient-evidence"]);
  check("[2c] missing sentence lease insufficient", causes(run([old(row(1000, 1000, 0, { keepAliveMs: undefined })), row(25000, 1000, 1000)])), ["insufficient-evidence"]);
  const manual = run([old(row(1000, 1000, 0, { path: "manual", keepAliveMs: undefined })), row(25000, 1000, 1000)]);
  check("[2c] historical manual lease only", causes(manual), ["unexplained"]);
  check("[2c] manual lease labelled", manual.includes("legacy-manual-90s=1"), true);

  // [3] Mutant: the attempts flatMap admits a fallback row for every interaction
  // with a numeric wall. "dispatch cardinality" and "unsent not predecessor" fail.
  console.log("[3] unsent and unknown-dispatch interactions are not requests");
  const unsent = row(15000, 1000, 0, { dispatched: false, attempts: [], keepAliveMs: null,
    model: "different-prepared-model", error: "model-unverified" });
  const unknown = { path: "sentence", ts: 17500, startedAt: 16500, model: "also-prepared",
    options: { num_ctx: 8192 }, timings: { wallMs: 1000 }, error: "settings-failed" };
  const out = run([row(), unsent, unknown, row(20500, 3000, 1000), { path: "skips" }, { path: "notice" }]);
  check("[3] dispatch cardinality", out.includes("4 interactions, 2 dispatched attempts (0 retries)"), true);
  check("[3] unsent not predecessor", causes(out), ["unexplained"]);
  check("[3] dispatch coverage", out.includes("1 unsent interactions, 1 unknown-dispatch interactions"), true);
  check("[3] unsent errors retained", out.includes("Interaction errors: 2 (50.0%)") && out.includes("settings-failed") && out.includes("model-unverified"), true);
  const onlyUnsent = run([unsent]);
  check("[3] all-unsent report retains duration and errors", onlyUnsent.includes("1 timed interactions, 0 timed attempts") && onlyUnsent.includes("Interaction errors: 1 (100.0%)"), true);
  const transport = row(1000, 1000, 0, { error: "unreachable", attempts: [{ attempt: "first", dispatchedAt: 1000,
    completedAt: 2000, timings: { wallMs: 1000 }, error: "unreachable" }] });
  const failure = run([transport]);
  check("[3] dispatched failure is an attempt with unknown counters", failure.includes("1 dispatched attempts") && failure.includes("load counters: recorded=0, unknown=1") && failure.includes("generation: n/a tokens"), true);
  // Mutant: remove hasCounters(raw.retry?.timings) from normalizeInteraction;
  // "legacy retry counters prove dispatch independently" turns red.
  const retryOnly = run([{ ...legacy, timings: { wallMs: 3000 }, retry: { outcome: "error", timings: t(1000), reason: "timeout" } }]);
  check("[3] legacy retry counters prove dispatch independently", retryOnly.includes("1 dispatched attempts (1 retries)") && retryOnly.includes("0 unknown-dispatch interactions") && retryOnly.includes("attempt errors: timeout=1"), true);

  // [4] Mutant: emit model-change instead of model-switch in the reload loop.
  // "literal causes" and "documented cause vocabulary" turn red.
  console.log("[4] six cause names, backend groups, leases and warmup observations");
  const matrix = [
    [row(1000, 1000, 1000)],
    [row(), row(3000, 1000, 1000, { model: "synthetic-b" })],
    [row(), row(3000, 1000, 1000, { options: { num_ctx: 4096 } })],
    [row(), row(93000, 1000, 1000)],
    [row(), row(23000, 1000, 1000)],
    [row(), row(3000, 1000, 1000)],
  ];
  const observed = matrix.flatMap((rs) => causes(run(rs))).sort();
  check("[4] literal causes", observed, ["ctx-switch", "idle-expiry", "log-start", "model-switch", "short-tail", "unexplained"]);
  const docs = readFileSync(join(here, "TESTING.md"), "utf8").split("### 13b.")[1].split("### 14.")[0];
  const documented = [...docs.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort();
  check("[4] documented cause vocabulary", observed, documented);
  const groups = run([row(1000, 1000, 0, { backend: { kind: "cpu", numThread: 4 } }), row(3000, 1000, 1000)]);
  check("[4] recorded and unrecorded backends", /cpu, 4 threads\s+1/.test(groups) && /unrecorded\s+1/.test(groups), true);
  check("[4] lease descriptions", groups.includes('manual "1.5m" (removed path), sentence "20s"'), true);
  const warm = { path: "warmup", id: "w1", model: "synthetic-a", numCtx: 2048, ts: 1000,
    dispatchedAt: 1000, completedAt: 22000, outcome: "loaded", reason: "stale", keepAliveMs: 20000 };
  const warmReport = run([row(), row(20500, 3000, 1000, { warmupIds: ["w1"] }), warm]);
  check("[4] warmup uses arrival and stays separate", warmReport.includes("2 interactions, 2 dispatched attempts") && warmReport.includes("sentence-arrived-during-load"), true);
} finally { rmSync(temp, { recursive: true, force: true }); }
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
