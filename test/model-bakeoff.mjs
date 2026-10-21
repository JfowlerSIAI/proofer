#!/usr/bin/env node
// Model bakeoff — run the Proofer suites against several local models and
// compare accuracy and latency side by side.
//
//   node model-bakeoff.mjs qwen3.5:9b ministral-3:14b
//   node model-bakeoff.mjs --limit 10 qwen3.5:9b other:model     # fast smoke run
//   node model-bakeoff.mjs --suites test,holdout,ab qwen3.5:9b
//
// Each suite runs as a child process with PROOFER_MODEL set, so the suites
// themselves stay the single source of truth for test cases and scoring.
// Results come back through PROOFER_RESULT_JSON rather than stdout scraping.

import { spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = (process.env.PROOFER_OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");

const SUITES = {
  // Single-sentence cases through the sentence pipeline since 2026-09-24; the
  // call counts are the suites' sizes before that, an upper bound. The manual
  // path's prompt-ab and param-sweep suites are frozen and are not offered.
  test: { file: "proofer-test.mjs", label: "core", calls: 105 },
  holdout: { file: "proofer-holdout.mjs", label: "holdout", calls: 55 },
};

// --- Args ---

function parseArgs(argv) {
  const opts = {
    models: [],
    suites: ["test", "holdout"],
    limit: null,
    options: null,
    json: null,
    verbose: false,
    warmup: true,
    unload: true,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const needsValue = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === "--suites") opts.suites = needsValue().split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--limit") opts.limit = needsValue();
    else if (a === "--options") opts.options = needsValue();
    else if (a === "--json") opts.json = needsValue();
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--no-warmup") opts.warmup = false;
    else if (a === "--no-unload") opts.unload = false;
    else if (a === "--list") opts.list = true;
    else if (a === "--help" || a === "-h") usage(0);
    else if (a.startsWith("-")) die(`unknown flag: ${a}`);
    else opts.models.push(a);
  }
  for (const s of opts.suites) {
    if (!SUITES[s]) die(`unknown suite "${s}" (choose from: ${Object.keys(SUITES).join(", ")})`);
  }
  if (opts.limit !== null && !(Number.isInteger(Number(opts.limit)) && Number(opts.limit) > 0)) {
    die(`--limit must be a positive integer, got: ${opts.limit}`);
  }
  if (opts.options) {
    try {
      JSON.parse(opts.options);
    } catch (e) {
      die(`--options is not valid JSON: ${e.message}`);
    }
  }
  return opts;
}

function usage(code) {
  console.log(`
Usage: node model-bakeoff.mjs [options] <model> [model...]

Options:
  --suites <list>   comma-separated: test, holdout  (default: test,holdout)
  --limit <n>       run only the first n cases per suite (smoke run)
  --options <json>  sampling options for every model, e.g. '{"temperature":0.3}'
  --json <path>     write the full report here (default: test/results/bakeoff-<ts>.json)
  --no-warmup       skip the warmup call before each suite
  --no-unload       leave models resident (default: evict every other model before
                    a run and this model after it, so nothing competes for VRAM --
                    note this also evicts models loaded by unrelated work)
  --verbose, -v     stream child suite output instead of a progress line
  --list            list installed Ollama models and exit
`);
  process.exit(code);
}

function die(msg) {
  console.error(`model-bakeoff: ${msg}`);
  process.exit(1);
}

// --- Ollama helpers ---

async function fetchInstalled() {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    die(`cannot reach Ollama at ${OLLAMA_URL} (${e.message}). Is it running?`);
  }
  if (!res.ok) die(`Ollama returned HTTP ${res.status} for /api/tags`);
  const data = await res.json();
  const models = Array.isArray(data.models) ? data.models : [];
  return models.map(m => ({
    name: m.name,
    sizeBytes: m.size,
    params: m.details?.parameter_size || null,
    quant: m.details?.quantization_level || null,
    family: m.details?.family || null,
  }));
}

async function warmup(model) {
  // One throwaway call so weights are resident before the suite starts timing.
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: "hi", stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    console.log(`  warmup failed (${e.message}) — continuing`);
  }
}

async function unload(model) {
  // keep_alive: 0 evicts the model so the next one gets a clean VRAM budget.
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0, stream: false }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    /* best effort */
  }
}

/**
 * Evict everything except `keep`. A model left resident by unrelated work still
 * competes for VRAM, which shows up as latency noise in the comparison.
 * Returns the names it evicted so the run can report the side effect.
 */
async function unloadOthers(keep) {
  let loaded = [];
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      loaded = (Array.isArray(data.models) ? data.models : []).map(m => m.name).filter(Boolean);
    }
  } catch {
    return [];
  }
  const others = loaded.filter(n => n !== keep);
  for (const name of others) await unload(name);
  return others;
}

// --- Running one suite ---

let activeChild = null;

function runSuite(suiteKey, model, opts, resultPath) {
  const suite = SUITES[suiteKey];
  const env = { ...process.env, PROOFER_MODEL: model, PROOFER_RESULT_JSON: resultPath };
  if (opts.limit !== null) env.PROOFER_LIMIT = String(opts.limit);
  if (opts.options) env.PROOFER_OPTIONS = opts.options;

  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(__dirname, suite.file)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;

    const stdoutLines = [];
    const stderrLines = [];
    let pending = "";
    const isTTY = process.stdout.isTTY && !opts.verbose;

    child.stdout.on("data", chunk => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        stdoutLines.push(line);
        if (opts.verbose) {
          console.log(`    ${line}`);
          continue;
        }
        // Suites print "[ 12/105] category  description  OK" per case.
        const m = line.match(/^\[\s*(\d+)\/(\d+)\]/);
        if (m && isTTY) {
          process.stdout.write(`\r  ${suite.label}: ${m[1]}/${m[2]} cases`);
        }
      }
    });
    child.stderr.on("data", chunk => stderrLines.push(chunk.toString()));

    child.on("error", err => {
      activeChild = null;
      resolve({ ok: false, error: `could not spawn: ${err.message}`, wallMs: Date.now() - started });
    });

    child.on("close", code => {
      activeChild = null;
      if (isTTY) process.stdout.write("\r\x1b[K");
      const wallMs = Date.now() - started;
      if (code !== 0) {
        const detail = stderrLines.join("").trim().split("\n").slice(-3).join(" | ")
          || stdoutLines.slice(-3).join(" | ")
          || `exit code ${code}`;
        return resolve({ ok: false, error: detail, wallMs });
      }
      let result;
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
      } catch (e) {
        return resolve({ ok: false, error: `no result JSON (${e.message})`, wallMs });
      }
      resolve({ ok: true, result, wallMs });
    });
  });
}

// --- Formatting ---

function fmtMs(ms) {
  if (ms == null) return "n/a";
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function fmtSize(bytes) {
  if (!bytes) return "n/a";
  return `${(bytes / 1e9).toFixed(1)}GB`;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function pct(v) {
  return v == null ? "n/a" : `${v.toFixed(1)}%`;
}

// Accuracy score used for ranking: full credit for PASS, half for PARTIAL,
// averaged over whichever scored suites ran.
function scoreOf(row) {
  const parts = [];
  for (const key of ["test", "holdout"]) {
    const r = row.suites[key];
    if (r?.ok && r.result?.total) {
      parts.push(((r.result.pass + r.result.partial * 0.5) / r.result.total) * 100);
    }
  }
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

// --- Main ---

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const installed = await fetchInstalled();

  if (opts.list) {
    console.log(`\nInstalled models at ${OLLAMA_URL}:\n`);
    for (const m of installed.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${m.name.padEnd(48)} ${fmtSize(m.sizeBytes).padStart(7)}  ${(m.params || "").padStart(7)}  ${m.quant || ""}`);
    }
    console.log();
    return;
  }

  if (!opts.models.length) {
    console.error("model-bakeoff: no models given.\n");
    console.error(`Installed: ${installed.map(m => m.name).join(", ") || "(none)"}`);
    usage(1);
  }

  const byName = new Map(installed.map(m => [m.name, m]));
  const missing = opts.models.filter(m => !byName.has(m));
  if (missing.length) {
    console.error(`model-bakeoff: not installed: ${missing.join(", ")}\n`);
    for (const m of missing) console.error(`  ollama pull ${m}`);
    console.error(`\nInstalled: ${installed.map(m => m.name).join(", ") || "(none)"}`);
    process.exit(1);
  }

  const totalCalls = opts.suites.reduce((sum, s) => {
    const per = opts.limit !== null ? Math.min(Number(opts.limit), SUITES[s].calls) : SUITES[s].calls;
    return sum + per;
  }, 0) * opts.models.length;

  console.log(`\nProofer Model Bakeoff`);
  console.log(`Ollama:  ${OLLAMA_URL}`);
  console.log(`Models:  ${opts.models.join(", ")}`);
  console.log(`Suites:  ${opts.suites.map(s => SUITES[s].label).join(", ")}`);
  if (opts.options) console.log(`Options: ${opts.options}`);
  if (opts.limit !== null) console.log(`Limit:   first ${opts.limit} cases per suite -- SMOKE RUN, not a valid comparison`);
  console.log(`Roughly ${totalCalls} model calls total.`);
  console.log(`${"=".repeat(100)}`);

  const tmpDir = mkdtempSync(join(tmpdir(), "proofer-bakeoff-"));
  const startedAt = Date.now();
  const rows = [];

  try {
    for (const model of opts.models) {
      const meta = byName.get(model);
      console.log(`\n--- ${model}  (${fmtSize(meta.sizeBytes)}, ${meta.params || "?"} params, ${meta.quant || "?"}) ---`);
      const row = { model, meta, suites: {} };
      const modelStarted = Date.now();

      if (opts.unload) {
        const evicted = await unloadOthers(model);
        if (evicted.length) console.log(`  evicted from VRAM first: ${evicted.join(", ")}`);
      }

      for (const suiteKey of opts.suites) {
        const suite = SUITES[suiteKey];
        if (opts.warmup) {
          process.stdout.write(`  warming up... `);
          await warmup(model);
          process.stdout.write(`done\n`);
        }
        process.stdout.write(`  ${suite.label}: running\n`);
        const resultPath = join(tmpDir, `${model.replace(/[^a-zA-Z0-9._-]/g, "_")}-${suiteKey}.json`);
        const outcome = await runSuite(suiteKey, model, opts, resultPath);
        row.suites[suiteKey] = outcome;

        if (!outcome.ok) {
          console.log(`  ${suite.label}: ERROR after ${fmtDuration(outcome.wallMs)} -- ${outcome.error}`);
          continue;
        }
        const r = outcome.result;
        // ab and sweep score variants rather than the model, so they have no
        // single pass rate — their detail lives in the report JSON.
        const accuracy = r.passRate == null
          ? "multi-variant, see report JSON"
          : `${pct(r.passRate)} pass, ${pct(r.passPartialRate)} pass+partial`;
        console.log(
          `  ${suite.label}: ${accuracy}` +
          `  |  median ${fmtMs(r.latency?.medianMs)}, p95 ${fmtMs(r.latency?.p95Ms)}` +
          `, ${r.latency?.genTokensPerSec ?? "n/a"} tok/s  |  ${fmtDuration(outcome.wallMs)}`
        );
      }

      row.wallMs = Date.now() - modelStarted;
      rows.push(row);
      if (opts.unload) await unload(model);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // --- Comparison table ---
  const ranked = [...rows].sort((a, b) => (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1));

  console.log(`\n${"=".repeat(100)}`);
  console.log(`BAKEOFF SUMMARY`);
  console.log(`${"=".repeat(100)}`);
  const header =
    "Model".padEnd(30) + "Size".padEnd(9) + "Core".padEnd(9) + "Core+P".padEnd(9) +
    "Hold".padEnd(9) + "Hold+P".padEnd(9) + "Median".padEnd(9) + "p95".padEnd(9) + "tok/s".padEnd(8);
  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of ranked) {
    const core = row.suites.test?.ok ? row.suites.test.result : null;
    const hold = row.suites.holdout?.ok ? row.suites.holdout.result : null;
    // Latency is pooled across the suites that ran — same call shape either way.
    const lats = [core?.latency, hold?.latency].filter(Boolean);
    const median = lats.length ? Math.round(lats.reduce((a, l) => a + l.medianMs, 0) / lats.length) : null;
    const p95 = lats.length ? Math.max(...lats.map(l => l.p95Ms)) : null;
    const toks = lats.filter(l => l.genTokensPerSec != null);
    const tps = toks.length ? (toks.reduce((a, l) => a + l.genTokensPerSec, 0) / toks.length).toFixed(1) : "n/a";
    console.log(
      row.model.slice(0, 29).padEnd(30) +
      fmtSize(row.meta.sizeBytes).padEnd(9) +
      pct(core?.passRate).padEnd(9) +
      pct(core?.passPartialRate).padEnd(9) +
      pct(hold?.passRate).padEnd(9) +
      pct(hold?.passPartialRate).padEnd(9) +
      fmtMs(median).padEnd(9) +
      fmtMs(p95).padEnd(9) +
      String(tps).padEnd(8) +
      (row === ranked[0] && scoreOf(row) != null ? " <<< best accuracy" : "")
    );
  }

  const errored = rows.filter(r => Object.values(r.suites).some(s => !s.ok));
  if (errored.length) {
    console.log(`\nSuites that failed to complete:`);
    for (const row of errored) {
      for (const [key, outcome] of Object.entries(row.suites)) {
        if (!outcome.ok) console.log(`  ${row.model} / ${SUITES[key].label}: ${outcome.error}`);
      }
    }
  }

  // --- Verdict ---
  const scored = ranked.filter(r => scoreOf(r) != null);
  if (scored.length) {
    console.log(`\n${"=".repeat(100)}`);
    const best = scored[0];
    console.log(`Best accuracy: ${best.model} (score ${scoreOf(best).toFixed(1)}, PASS + half credit for PARTIAL)`);

    const withLat = scored
      .map(r => {
        const lats = [r.suites.test, r.suites.holdout]
          .filter(s => s?.ok && s.result?.latency)
          .map(s => s.result.latency.medianMs);
        return lats.length ? { row: r, median: lats.reduce((a, b) => a + b, 0) / lats.length } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.median - b.median);
    if (withLat.length) {
      console.log(`Fastest:       ${withLat[0].row.model} (median ${fmtMs(withLat[0].median)} per rewrite)`);
    }
    if (opts.limit !== null) {
      console.log(`\nNOTE: --limit was set, so these rates come from a truncated slice of each suite.`);
    }
    console.log(`\nBefore adopting a new model, sweep its sampling on the frozen benchmark`);
    console.log(`(finetune/teacher-pass.mjs) and run the sentence release gate -- see TESTING.md.`);
  }

  // --- Report file ---
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = opts.json || join(__dirname, "results", `bakeoff-${stamp}.json`);
  const report = {
    startedAt: new Date(startedAt).toISOString(),
    wallMs: Date.now() - startedAt,
    ollamaUrl: OLLAMA_URL,
    suites: opts.suites,
    limit: opts.limit === null ? null : Number(opts.limit),
    optionsOverride: opts.options ? JSON.parse(opts.options) : null,
    models: rows.map(row => ({
      model: row.model,
      meta: row.meta,
      wallMs: row.wallMs,
      score: scoreOf(row),
      suites: Object.fromEntries(
        Object.entries(row.suites).map(([k, v]) => [k, v.ok ? v.result : { error: v.error }])
      ),
    })),
  };
  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nFull report (including every failed case): ${reportPath}`);
  } catch (e) {
    console.error(`\nWarning: could not write report to ${reportPath}: ${e.message}`);
  }

  console.log(`Total time: ${fmtDuration(Date.now() - startedAt)}\n`);
}

// Ctrl-C should take the child suite down with it.
process.on("SIGINT", () => {
  if (activeChild) activeChild.kill("SIGTERM");
  console.log("\nInterrupted.");
  process.exit(130);
});

main().catch(e => {
  console.error(e);
  process.exit(1);
});
