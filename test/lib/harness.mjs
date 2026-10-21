// Shared configuration and instrumentation for the Proofer LLM test suites.
//
// This is test-harness code, not extension code — the "single-file, no modules"
// runtime convention applies to content.js/background.js (MV3 has no module
// loader for content scripts). The harnesses are plain Node ESM and can import.
//
// Everything here is overridable by environment variable so a suite can be run
// against a different model or sampling config without editing source:
//
//   PROOFER_MODEL       model name, e.g. "ministral-3:14b"   (default: the pinned model)
//   PROOFER_OLLAMA_URL  Ollama base URL                      (default http://localhost:11434)
//   PROOFER_OPTIONS     JSON merged over the sampling opts, e.g. '{"temperature":0.3}'
//   PROOFER_LIMIT       run only the first N test cases (smoke tests)
//   PROOFER_SKIP_DIGEST_CHECK  run even if the production tag no longer
//                       resolves to its pinned digest (any nonempty value);
//                       shared by admission, scoring and the frozen benchmark
//   PROOFER_RESULT_JSON path to write a machine-readable result summary
//
// The manual-path prompt overrides (PROOFER_PROMPT, PROOFER_PROMPT_FILE,
// PROOFER_USER_TEMPLATE, PROOFER_FORMAT, PROOFER_VARIANT_FILE) and the
// extractors behind them went with that path (2026-09-24).
// The suites that still run build the SENTENCE request through background.js
// itself (lib/sentence-guards.mjs), so there is no prompt here to override.
//
// model-bakeoff.mjs drives the suites through these.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * The production model: background.js's PINNED_MODEL (see docs/model.md), so
 * the suites cannot drift from what ships. A failed read is an ERROR -- a
 * silent fallback would measure some other model and say nothing.
 */
const PINNED = (() => {
  const bg = readFileSync(join(REPO_ROOT, "background.js"), "utf8");
  const block = bg.match(/const PINNED_MODEL = \{([\s\S]*?)\};/);
  const tag = block && block[1].match(/tag:\s*"([^"]+)"/);
  const digest = block && block[1].match(/digest:\s*"([0-9a-f]{64})"/);
  if (!tag || !digest) throw new Error("Could not read PINNED_MODEL from background.js");
  return { tag: tag[1], digest: digest[1] };
})();
export const DEFAULT_MODEL = PINNED.tag;
export const MODEL = process.env.PROOFER_MODEL || DEFAULT_MODEL;
export const OLLAMA_URL = (process.env.PROOFER_OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");

/**
 * The digest background.js says the production tag should resolve to.
 *
 * Read out of the shipping file for the same reason DEFAULT_MODEL is: a second
 * copy here is a second thing to forget to update.
 */
export const EXPECTED_MODEL_DIGEST = PINNED.digest;

/**
 * The sentence-mode pilot's pin, tag and digest together. The tag is what a
 * bench run passes as PROOFER_MODEL, so the digest is only enforceable if the
 * harness knows which tag it belongs to -- EXPECTED_SENTENCE_MODEL_DIGEST sat
 * in background.js with no reader until this pairing existed, and :latest
 * moved twice on the day it was pinned.
 */
export const [EXPECTED_SENTENCE_MODEL, EXPECTED_SENTENCE_MODEL_DIGEST] = (() => {
  try {
    const bg = readFileSync(join(REPO_ROOT, "background.js"), "utf8");
    const tag = bg.match(/const EXPECTED_SENTENCE_MODEL\s*=\s*\n?\s*"([^"]+)"/);
    const digest = bg.match(/const EXPECTED_SENTENCE_MODEL_DIGEST\s*=\s*\n?\s*"([0-9a-f]{64})"/);
    return [tag ? tag[1] : null, digest ? digest[1] : null];
  } catch {
    return [null, null];
  }
})();

/**
 * Every tag whose digest is pinned. A PROOFER_MODEL override naming one of
 * these is a claim to be measuring the pinned weights, and gets checked; an
 * override naming anything else is the caller measuring something new, which
 * is the point of the override.
 */
const PINNED_DIGESTS = new Map();
if (EXPECTED_MODEL_DIGEST) PINNED_DIGESTS.set(DEFAULT_MODEL, EXPECTED_MODEL_DIGEST);
if (EXPECTED_SENTENCE_MODEL && EXPECTED_SENTENCE_MODEL_DIGEST) {
  PINNED_DIGESTS.set(EXPECTED_SENTENCE_MODEL, EXPECTED_SENTENCE_MODEL_DIGEST);
  // The `:latest` sibling of the pinned tag is checked against the SAME digest.
  // background.js pins the immutable `:v1` (2026-09-06), and without this the
  // moveable name -- the one an `ollama create` can silently repoint, and the
  // one a person is most likely to type -- would be the only way to run these
  // suites with NO digest check at all. A pin that the obvious tag routes
  // around is not a pin.
  const latest = EXPECTED_SENTENCE_MODEL.replace(/:[^:]*$/, ":latest");
  if (latest !== EXPECTED_SENTENCE_MODEL) {
    PINNED_DIGESTS.set(latest, EXPECTED_SENTENCE_MODEL_DIGEST);
  }
}

// Ollama treats a bare name as `<name>:latest`, so `PROOFER_MODEL=proofer-pilot-q8`
// runs the pinned weights under a string no pin matches -- the lookup found
// nothing and the check returned silently. Canonicalise before the lookup, and
// use the canonical form for the /api/tags match too, or the entry is missed.
function canonicalTag(name) {
  return /:/.test(name) ? name : `${name}:latest`;
}

/** One digest policy for Node research callers; the extension always uses its pin. */
export function researchModelPolicy(model) {
  const canonical = canonicalTag(model);
  return { model: canonical,
    expectedDigest: process.env.PROOFER_SKIP_DIGEST_CHECK ? null : PINNED_DIGESTS.get(canonical) || null };
}

/**
 * A tag is a moveable pointer, so "which model was this measured against" has
 * no answer unless something checks. `ollama create`/`ollama pull` onto the
 * same name swaps the weights and every suite in this directory keeps running
 * and reporting numbers that are no longer comparable to recorded baselines.
 *
 * Run at IMPORT, before any suite gets as far as its first request, and it
 * EXITS rather than warns: a warning scrolls past above 200 lines of results,
 * and the results are the thing that would be wrong.
 *
 * Only for PINNED tags -- the production manual model and the sentence pilot.
 * A PROOFER_MODEL override naming anything else is the caller saying "measure
 * this other thing", which is the whole point of the override. An unreachable
 * Ollama is not this check's business either -- the suite's own first request
 * reports it far better than a digest check can.
 */
async function assertModelDigest() {
  const { model: canonical, expectedDigest } = researchModelPolicy(MODEL);
  if (!expectedDigest) return;
  let models;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return;
    models = (await res.json()).models;
  } catch {
    return;                       // Ollama down; the suite will say so.
  }
  if (!Array.isArray(models)) return;
  const entry = models.find((m) => m &&
    (m.name === MODEL || m.model === MODEL ||
     canonicalTag(String(m.name || "")) === canonical ||
     canonicalTag(String(m.model || "")) === canonical));
  if (!entry) {
    console.error(`\nMODEL NOT INSTALLED: ${MODEL} is not in ${OLLAMA_URL}/api/tags.`);
    process.exit(1);
  }
  const digest = String(entry.digest || "").replace(/^sha256[:-]/, "");
  if (digest !== expectedDigest) {
    // Name the constant that actually pins THIS tag. Comparing against
    // EXPECTED_SENTENCE_MODEL alone sent anyone hitting a `:latest` mismatch
    // to edit the MANUAL model's digest, which is a different model.
    const constant = expectedDigest === EXPECTED_SENTENCE_MODEL_DIGEST
      ? "EXPECTED_SENTENCE_MODEL_DIGEST" : "PINNED_MODEL.digest";
    console.error(`
MODEL DIGEST MISMATCH -- refusing to run.

  tag       ${MODEL}
  expected  ${expectedDigest}   (background.js ${constant})
  local     ${digest || "(none reported)"}

The local weights differ from the recorded model pin, so this run is not
comparable to its baseline. Either restore the measured weights, or
re-measure and update
${constant} in the same commit.

PROOFER_SKIP_DIGEST_CHECK=1 runs anyway, knowingly, at admission and inference.
`);
    process.exit(1);
  }
}

await assertModelDigest();

// Production sampling config (mirrors background.js). num_ctx is fixed at 2048
// here because every test case is a single short sentence; production computes
// it dynamically from input length.
const BASE_OPTIONS = { temperature: 0.1, top_p: 0.8, top_k: 20, repeat_penalty: 1.0, num_ctx: 2048 };

function parseOptionsEnv() {
  const raw = process.env.PROOFER_OPTIONS;
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`PROOFER_OPTIONS is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`PROOFER_OPTIONS must be a JSON object, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
}

// What PROOFER_OPTIONS overrides, on its own: callSentence lays exactly this
// over the product's own request options (a research knob; the product has
// none).
export const OPTIONS_OVERRIDE = parseOptionsEnv();
export const OPTIONS = { ...BASE_OPTIONS, ...OPTIONS_OVERRIDE };

// Sampling options excluding num_ctx; derived from OPTIONS.
// This export does not select or run a benchmark.
export const SAMPLING = (() => {
  const { num_ctx, ...rest } = OPTIONS;
  return rest;
})();

export const NUM_CTX = OPTIONS.num_ctx;

/**
 * Honour PROOFER_LIMIT so the harness can be smoke-tested in seconds.
 * Returns the (possibly truncated) test array.
 */
export function applyLimit(tests) {
  const raw = process.env.PROOFER_LIMIT;
  if (!raw) return tests;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`PROOFER_LIMIT must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  if (n >= tests.length) return tests;
  return tests.slice(0, n);
}

/** Header line describing the effective config — printed by every suite. */
export function configBanner(tests, allTests) {
  const lines = [
    `Model: ${MODEL}${MODEL === DEFAULT_MODEL ? "" : "  (PROOFER_MODEL override)"}`,
    `Ollama: ${OLLAMA_URL}`,
    `Options: ${JSON.stringify(OPTIONS)}`,
  ];
  if (allTests && tests.length < allTests.length) {
    lines.push(`Limit: first ${tests.length} of ${allTests.length} cases (PROOFER_LIMIT) — NOT a full run`);
  }
  return lines.join("\n");
}

// --- Latency ---

const NS_PER_MS = 1e6;

/**
 * Collects interaction walls separately from dispatched attempts, including
 * failures. Engine callers pass their attempt rows to recordInteraction;
 * recordTiming accepts an already-normalized timing row. Direct-fetch callers
 * keep record(wallMs, data), with the raw Ollama nanosecond counters.
 */
export function createLatencyTracker() {
  const samples = [];
  const interactions = [];
  const recordTiming = (timings = {}) => {
    samples.push(Object.fromEntries(["wallMs", "totalMs", "loadMs", "promptTokens", "promptMs", "evalTokens", "evalMs"]
      .map(k => [k, num(timings[k])])));
  };
  return {
    record(wallMs, data) {
      const d = data && typeof data === "object" ? data : {};
      const ms = (v) => num(v) === null ? null : v / NS_PER_MS;
      recordTiming({
        wallMs,
        totalMs: ms(d.total_duration),
        loadMs: ms(d.load_duration),
        promptTokens: num(d.prompt_eval_count),
        promptMs: ms(d.prompt_eval_duration),
        evalTokens: num(d.eval_count),
        evalMs: ms(d.eval_duration),
      });
    },
    recordTiming,
    recordInteraction(wallMs, attempts) {
      interactions.push({ wallMs: num(wallMs) });
      for (const attempt of attempts) recordTiming(attempt.timings);
    },
    get count() {
      return samples.length;
    },
    samples() {
      return samples.slice();
    },
    stats() {
      if (!samples.length && !interactions.length) return null;
      return { ...requestStats(samples), interaction: interactions.length ? wallStats(interactions) : null };
    },
  };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  // Nearest-rank: smallest value at or above the p-th percentile position.
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

export function latencyStats(samples) {
  if (!samples.length) return null;
  return requestStats(samples);
}

const sum = arr => arr.length ? arr.reduce((a, b) => a + b, 0) : null;

function wallStats(samples) {
  const wall = samples.map(s => num(s.wallMs)).filter(v => v !== null).sort((a, b) => a - b);
  return {
    count: samples.length,
    medianMs: wall.length ? round(percentile(wall, 50)) : null,
    p95Ms: wall.length ? round(percentile(wall, 95)) : null,
    meanMs: wall.length ? round(sum(wall) / wall.length) : null,
    minMs: wall.length ? round(wall[0]) : null,
    maxMs: wall.length ? round(wall[wall.length - 1]) : null,
    totalMs: wall.length ? round(sum(wall)) : null,
  };
}

function requestStats(samples) {
  const values = key => samples.map(s => num(s[key])).filter(v => v !== null);
  // A missing counter is unavailable, not zero. Throughput requires a paired
  // token count and duration from the same attempt; totals use all known counts.
  const throughput = (tokens, ms) => {
    const paired = samples.filter(s => num(s[tokens]) !== null && num(s[ms]) !== null);
    const duration = sum(paired.map(s => s[ms]));
    return duration > 0 ? round(sum(paired.map(s => s[tokens])) / duration * 1000, 1) : null;
  };
  const loadMs = values("loadMs");
  return {
    ...wallStats(samples),
    genTokensPerSec: throughput("evalTokens", "evalMs"),
    promptTokensPerSec: throughput("promptTokens", "promptMs"),
    evalTokensTotal: sum(values("evalTokens")),
    promptTokensTotal: sum(values("promptTokens")),
    maxLoadMs: loadMs.length ? round(Math.max(...loadMs)) : null,
  };
}

function round(n, digits = 0) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

export function formatMs(ms) {
  if (ms == null) return "n/a";
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Multi-line latency block for a suite's summary output. */
export function formatLatencyReport(stats) {
  if (!stats) return "Latency: no samples recorded";
  const walls = (s, label) => [
    `Latency (per ${label}, wall-clock over ${s.count} calls):`,
    `  median ${formatMs(s.medianMs)}   p95 ${formatMs(s.p95Ms)}   mean ${formatMs(s.meanMs)}` +
      `   min ${formatMs(s.minMs)}   max ${formatMs(s.maxMs)}`,
    `  total ${formatMs(s.totalMs)} recorded ${label} wall time`,
  ];
  const lines = stats.interaction ? walls(stats.interaction, "interaction") : [];
  lines.push(...walls(stats, "attempt"));
  lines.push(`  tokens: generation ${stats.evalTokensTotal ?? "n/a"}   prompt ${stats.promptTokensTotal ?? "n/a"}` +
    (stats.genTokensPerSec != null ? `   generation ${stats.genTokensPerSec} tok/s` : "") +
    (stats.promptTokensPerSec != null ? `   prompt ${stats.promptTokensPerSec} tok/s` : ""));
  if (stats.maxLoadMs > 50) {
    lines.push(`  max model load ${formatMs(stats.maxLoadMs)} (reported separately from token throughput)`);
  }
  return lines.join("\n");
}

// --- Machine-readable results ---

/**
 * Write a result summary when PROOFER_RESULT_JSON is set. Silent no-op
 * otherwise, so interactive runs are unaffected.
 */
export function writeResultJson(payload) {
  const path = process.env.PROOFER_RESULT_JSON;
  if (!path) return;
  const body = {
    model: MODEL,
    ollamaUrl: OLLAMA_URL,
    options: OPTIONS,
    finishedAt: new Date().toISOString(),
    ...payload,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(body, null, 2));
  } catch (e) {
    console.error(`\nWarning: could not write PROOFER_RESULT_JSON (${path}): ${e.message}`);
  }
}
