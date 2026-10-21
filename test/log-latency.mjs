#!/usr/bin/env node
// What the interaction log says about latency. No Ollama, no browser.
//
//   node log-latency.mjs ~/Downloads/proofer-log-2026-08-12.jsonl
//   node log-latency.mjs log.jsonl --reload-ms 500
//
// Interactions own the user's wait; dispatched attempts own Ollama counters.
// v2 uses canonical attempts exclusively. Legacy missing evidence stays visible;
// see TESTING.md §13b for the six attribution hypotheses and coverage labels.
// A requested lease is not proof of receipt, residency or a successful load.

import { readFileSync } from "fs";
import { latencyStats, formatMs, percentile } from "./lib/harness.mjs";
import { normalizeInteraction, latencyAttempts } from "./lib/log-record.mjs";
import { SENTENCE_KEEP_ALIVE, SENTENCE_NUM_CTX } from "./lib/sentence-guards.mjs";

// The manual rewrite path's lease, "1.5m". That path was removed from the
// extension on 2026-09-24, so this is history rather than an import: records
// written before `keepAliveMs` existed were armed with it, and a gap longer
// than it is an idle expiry under either lease the extension has ever sent.
const MANUAL_KEEP_ALIVE = "1.5m";
const MANUAL_KEEP_ALIVE_MS = 90000;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
if (!file) {
  console.error("usage: node log-latency.mjs <export.jsonl> [--reload-ms 500]");
  process.exit(2);
}

// Warm is 70-120ms, cold is ~2100ms; anything between is a reload of a smaller
// model or a partially-cached one. 500 sits in the empty middle.
const RELOAD_MS = Number(arg("--reload-ms") || 500);

const exported = readFileSync(file, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);
const warmups = exported.filter((r) => r.path === "warmup");
// The trailing "skips" row is the skip-counter map, not a request: without
// this exclusion it counted as one record "older than the timings field". The
// "notice" row (the export notice's version, since the beta) is not one either.
const records = exported.filter((r) => !["warmup", "skips", "notice"].includes(r.path))
  .map((r) => normalizeInteraction(r, { schema: "browser" }));
const numeric = (v) => typeof v === "number" && Number.isFinite(v);
const interactions = records.filter((r) => numeric(r.timings?.wallMs));
const attempts = records.flatMap((r) => latencyAttempts(r))
  .map((r) => ({ ...r, keepAliveMs: r.keepAliveMs ?? (r.leaseEvidence === "legacy-manual-90s" ? MANUAL_KEEP_ALIVE_MS : null) }))
  .sort((a, b) => (a.orderAt ?? Infinity) - (b.orderAt ?? Infinity));
const timedAttempts = attempts.filter((r) => numeric(r.timings.wallMs));
const pctOf = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : "0%";

console.log(`\n${file}`);
console.log("=".repeat(76));
console.log(`${records.length} interactions, ${attempts.length} dispatched attempts (${attempts.filter((r) => r.attempt === "retry").length} retries)`);
console.log(`Coverage: ${interactions.length} timed interactions, ${timedAttempts.length} timed attempts; ` +
  `${records.filter((r) => r.dispatched === false).length} unsent interactions, ` +
  `${records.filter((r) => r.dispatched === null).length} unknown-dispatch interactions`);
function coverage(label, values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  console.log(`  ${label}: ${[...counts].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
}
coverage("attempt arrival", attempts.map((r) => r.arrivalEvidence));
coverage("attempt completion", attempts.map((r) => r.completionEvidence));
coverage("lease", attempts.map((r) => r.leaseEvidence));
console.log(`  attempt wall: recorded=${timedAttempts.length}, unknown=${attempts.length - timedAttempts.length}`);
console.log(`  load counters: recorded=${attempts.filter((r) => numeric(r.timings.loadMs)).length}, unknown=${attempts.filter((r) => !numeric(r.timings.loadMs)).length}`);
const writes = records.map((r) => r.ts).filter(numeric).sort((a, b) => a - b);
if (writes.length) {
  const span = (writes[writes.length - 1] - writes[0]) / 3600000;
  console.log(`record-write span: ${span >= 1 ? span.toFixed(1) + " hours" : (span * 60).toFixed(0) + " minutes"}` +
    `, model(s): ${[...new Set(attempts.map((r) => r.model).filter(Boolean))].join(", ") || "unrecorded"}`);
}

// --- Per machine class --------------------------------------------------------
//
// Beta records carry the qualification's backend class (GPU / Apple / CPU and
// its thread count -- nothing identifying), so latency can be read by the kind
// of machine that produced it. Records from before that field say "unrecorded".
// Interactions only: a retry's second request is part of the same wait.
{
  const byBackend = new Map();
  for (const r of interactions) {
    const b = r.backend && typeof r.backend === "object"
      ? [r.backend.kind || "?", r.backend.numThread ? `${r.backend.numThread} threads` : null].filter(Boolean).join(", ")
      : (typeof r.backend === "string" ? r.backend : "unrecorded");
    if (!byBackend.has(b)) byBackend.set(b, []);
    byBackend.get(b).push(r);
  }
  if (byBackend.size) {
    console.log("\nLatency by machine class (interactions, wall clock):");
    console.log("  backend                     n     median      p95   over 5s");
    for (const [b, rs] of [...byBackend].sort((x, y) => y[1].length - x[1].length)) {
      const st = latencyStats(rs.map((r) => r.timings));
      if (!st) continue;
      const over = rs.filter((r) => r.timings.wallMs > 5000).length;
      console.log(`  ${b.slice(0, 24).padEnd(24)} ${String(st.count).padStart(5)} ` +
        `${formatMs(st.medianMs).padStart(9)} ${formatMs(st.p95Ms).padStart(8)} ${String(over).padStart(9)}`);
    }
  }
}

// --- Per path ---------------------------------------------------------------
//
// Split because they were different jobs with different budgets: the manual
// path (removed 2026-09-24; its records remain in old exports) showed a panel
// and the user knew they were waiting, while sentence mode fires silently and a
// slow one is just a correction that arrives after the sentence has scrolled
// out of attention.

function wallTable(title, rows) {
  const byPath = new Map();
  for (const r of rows) {
    const p = r.path || "unknown";
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push(r);
  }
  console.log(`\n${title}:`);
  console.log("  path         n     median     p95      mean    max");
  if (byPath.size > 1) byPath.set("ALL", rows);
  for (const [label, rs] of byPath) {
    const st = latencyStats(rs.map((r) => r.timings));
    console.log(`  ${label.padEnd(14)} ${String(st.count).padStart(4)}  ` +
      `${formatMs(st.medianMs).padStart(8)} ${formatMs(st.p95Ms).padStart(8)} ` +
      `${formatMs(st.meanMs).padStart(8)} ${formatMs(st.maxMs).padStart(7)}`);
  }
}
wallTable("Interaction latency by path (arrival to response)", interactions);
wallTable("Attempt latency by path (dispatch through body)", timedAttempts);
// Only paired counters contribute throughput; missing counters are unavailable.
console.log("\nAttempt tokens (recorded counters only):");
for (const [label, tokens, ms] of [["generation", "evalTokens", "evalMs"], ["prompt", "promptTokens", "promptMs"]]) {
  const counted = attempts.filter((r) => numeric(r.timings[tokens]));
  const paired = counted.filter((r) => numeric(r.timings[ms]));
  const duration = paired.reduce((n, r) => n + r.timings[ms], 0);
  const rate = duration > 0 ? (paired.reduce((n, r) => n + r.timings[tokens], 0) * 1000 / duration).toFixed(1) : "n/a";
  console.log(`  ${label}: ${counted.length ? counted.reduce((n, r) => n + r.timings[tokens], 0) : "n/a"} tokens, ` +
    `coverage=${counted.length}/${attempts.length}, ${rate} tok/s`);
}

// --- Reloads ----------------------------------------------------------------

const numCtxOf = (r) => (r.options && typeof r.options.num_ctx === "number") ? r.options.num_ctx : null;
// An earlier ambiguous legacy retry need not poison the rest of the file once
// its whole interaction ended. This bound is not its attempt completion time.
const endedBy = (r) => r.completedAt ?? r.interaction.completedAt ??
  (numeric(r.interaction.arrivedAt) && numeric(r.interaction.timings?.wallMs)
    ? r.interaction.arrivedAt + r.interaction.timings.wallMs : r.interaction.ts) ?? Infinity;

const reloads = [];
for (let i = 0; i < attempts.length; i++) {
  const r = attempts[i];
  const load = r.timings.loadMs;
  if (!numeric(load) || load < RELOAD_MS) continue;
  const prev = i > 0 ? attempts[i - 1] : null;
  const endpoint = r.endpoint;
  const gap = prev && numeric(endpoint) && numeric(prev.completedAt) ? endpoint - prev.completedAt : null;
  const here = numCtxOf(r), there = prev ? numCtxOf(prev) : null;
  const lease = prev?.keepAliveMs;
  // Overlapping attempts cannot establish which request last held the runner.
  // Unknown legacy retry ordering likewise must not acquire a precise cause.
  const ambiguous = r.orderingUnknown || r.orderAt === null || (prev &&
    (prev.orderingUnknown || gap === null || gap < 0 || attempts.slice(0, i).some((a) =>
      endedBy(a) > endpoint || a.orderAt > endpoint)));
  let cause;
  if (ambiguous) cause = "insufficient-evidence";
  else if (!prev) cause = "log-start";
  else if (r.model && prev.model && r.model !== prev.model) cause = "model-switch";
  else if (here != null && there != null && here !== there) cause = "ctx-switch";
  else if (gap > MANUAL_KEEP_ALIVE_MS) cause = "idle-expiry";
  else if (lease == null) cause = "insufficient-evidence";
  else if (gap > lease) cause = "short-tail";
  else cause = "unexplained";
  reloads.push({ r, cause, load, gap, from: there, to: here });
}

console.log(`\nReloads (loadMs >= ${RELOAD_MS}ms), leases: manual "${MANUAL_KEEP_ALIVE}" (removed path), sentence "${SENTENCE_KEEP_ALIVE}":`);
if (!reloads.length) {
  console.log("  none in recorded load counters; missing counters cannot establish runner warmth.");
} else {
  const lost = reloads.reduce((n, x) => n + x.load, 0);
  console.log(`  ${reloads.length} of ${attempts.length} attempts (${pctOf(reloads.length, attempts.length)}), ` +
    `${formatMs(lost)} spent loading — ${pctOf(lost, interactions.reduce((n, r) => n + r.timings.wallMs, 0))} of recorded interaction wall time`);
  const causes = new Map();
  for (const x of reloads) {
    if (!causes.has(x.cause)) causes.set(x.cause, []);
    causes.get(x.cause).push(x);
  }
  console.log("");
  for (const [cause, xs] of [...causes].sort((a, b) => b[1].length - a[1].length)) {
    const ms = xs.reduce((n, x) => n + x.load, 0);
    console.log(`  ${cause.padEnd(13)} ${String(xs.length).padStart(4)}  ${formatMs(ms).padStart(8)} lost` +
      (cause === "ctx-switch"
        ? `   (${[...new Set(xs.map((x) => `${x.from}->${x.to}`))].slice(0, 4).join(", ")})`
        : ""));
  }
  // The one that is actionable and invisible: a silent path paying for the
  // manual path's context window.
  const silent = reloads.filter((x) => x.cause === "ctx-switch" && x.r.path === "sentence");
  if (silent.length) {
    console.log(`\n  ${silent.length} of those landed on SENTENCE mode — a silent correction that waited ` +
      `${formatMs(percentile(silent.map((x) => x.load).sort((a, b) => a - b), 50))} (median) with no panel to explain it.`);
  }
}

// The historical short-tail/idle-expiry attribution above remains a hypothesis
// about REQUEST gaps. Correlate actual warmup observations separately, without
// counting pure loads as proofreading or pretending missing telemetry is proof
// that no ping fired. Retention, recordAll and worker restarts limit coverage.
if (warmups.length) {
  const byId = new Map(warmups.map((w) => [w.id, w]));
  console.log("\nWarmup observations for sentence reloads (bounded retained window):");
  for (const { r, cause } of reloads.filter((x) => x.r.path === "sentence")) {
    if (typeof r.interaction.arrivedAt !== "number") {
      console.log(`  ${r.id} ${cause}: arrival-unrecorded`);
      continue;
    }
    const sameRunner = (w) => w && w.model === r.model && w.numCtx === numCtxOf(r);
    const activeIds = Array.isArray(r.warmupIds) ? r.warmupIds : [];
    const active = activeIds.map((id) => byId.get(id)).filter(sameRunner);
    const preceding = warmups.filter((w) => sameRunner(w) && w.ts <= r.interaction.arrivedAt)
      .sort((a, b) => b.ts - a.ts);
    const w = active[0] || preceding[0];
    let observation;
    if (active.length) observation = "sentence-arrived-during-load";
    else if (activeIds.some((id) => !byId.has(id))) observation = "in-flight-detail-evicted";
    else if (!w) observation = "no-retained-warmup";
    else if (w.dispatchedAt === null) observation = `skipped:${w.reason}`;
    else if (w.dispatchedAt > r.interaction.arrivedAt) observation = "sentence-arrived-before-dispatch";
    else if (w.completedAt === null || w.completedAt > r.interaction.arrivedAt) observation = "load-not-complete-at-arrival";
    else observation = `completed:${w.outcome}`;
    console.log(`  ${r.id} ${cause}: ${observation}` +
      (w ? ` reason=${w.reason} dispatch=${w.dispatchedAt} complete=${w.completedAt}` +
        ` outcome=${w.outcome} ageMs=${r.interaction.arrivedAt - w.ts} leaseMs=${w.keepAliveMs}` : ""));
  }
} else {
  console.log("\nNo retained warmup telemetry; request gaps cannot establish whether a warmup fired.");
}

// --- num_ctx ----------------------------------------------------------------
//
// The collision's raw material. Sentence mode pins SENTENCE_NUM_CTX, so any
// manual request at another value evicts its runner.

const ctxCounts = new Map();
for (const r of attempts) {
  const c = numCtxOf(r);
  const k = `${c == null ? "unrecorded" : c}`;
  ctxCounts.set(k, (ctxCounts.get(k) || 0) + 1);
}
console.log(`\nnum_ctx actually used (sentence mode is pinned at ${SENTENCE_NUM_CTX}):`);
for (const [k, n] of [...ctxCounts].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${k.padStart(10)}  ${String(n).padStart(4)}  ${pctOf(n, attempts.length)}` +
    (k !== "unrecorded" && Number(k) !== SENTENCE_NUM_CTX ? "   evicts the sentence runner" : ""));
}

// --- Errors -----------------------------------------------------------------

const errors = records.filter((r) => r.error);
if (errors.length) {
  const kinds = new Map();
  for (const r of errors) kinds.set(r.error, (kinds.get(r.error) || 0) + 1);
  console.log(`\nInteraction errors: ${errors.length} (${pctOf(errors.length, records.length)})`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(14)} ${String(n).padStart(4)}`);
  }
}

console.log("");
coverage("attempt errors", attempts.filter((r) => r.error).map((r) => r.error));
