#!/usr/bin/env node
// Replay a recorded interaction log through the CURRENT sentence guards.
//
// "Replaying the log against the current guards is the cheapest audit there is"
// has been true in this project for a while and lived in a scratch script. This
// is that script, checked in: every refusal ever recorded is an {input, output}
// pair, so the whole history re-runs offline in about a second and says which
// refusals a guard change would now let through -- and, in the other direction,
// which applies it would now refuse. That second column is the one worth having
// and the one a "did my fix work" spot-check never produces.
//
// No Ollama, no browser. It calls the SHIPPING guardSentenceResult through
// lib/sentence-guards.mjs, so it cannot drift from what the service worker does.
//
// Usage:
//   node replay-log-guards.mjs proofer-log-2026-08-14.jsonl
//   node replay-log-guards.mjs harvested/qwen.jsonl --examples 20
//   node replay-log-guards.mjs a.jsonl b.jsonl          # several at once
//   node replay-log-guards.mjs log.jsonl --json report.json           # redacted
//   node replay-log-guards.mjs log.jsonl --json h/x.json --include-text
//
// Flags:
//   --examples <n>   how many flip examples to print per direction (default 8)
//   --json <file>    dump the result object, REDACTED (see below)
//   --include-text   put the real sentences in the JSON. Refuses a path that
//                    git would not ignore.
//   --quiet          totals and flips only, no reason histogram
//
// THE JSON IS REDACTED BY DEFAULT, and that is a privacy rule rather than a
// preference. The input to this tool is the interaction log, which holds what
// the user typed on real sites; the log itself is gitignored and capped and
// clearable for that reason. An analysis artifact derived from it is the same
// text under a different name, and `--json out.json` in the repo root is
// stageable -- `test/harvested/` and `*.jsonl` are ignored, `out.json` is not.
// So the default artifact carries counts, reasons and SHA-256 prefixes, the
// reason payload is stripped (`word-substituted:emtal` names a word the user
// typed), and `--include-text` is an explicit flag that CHECKS the destination
// with `git check-ignore` and refuses rather than warns. Terminal output is not
// covered by any of this and never was: it is the operator's own screen.
//
// FAITHFULNESS, and its one limit. The service worker sanitizes the model's RAW
// output and calls guardSentenceResult(sentence, raw, cleaned) -- so a sanitizer
// that had to change anything refuses as `sanitizer-would-change`. The log's
// `output` field is the RAW output on a refusal and the CLEANED output on an
// apply (see recordInteraction in background.js), so running the sanitizer over
// it here reproduces the shipping call exactly in both cases: on a refusal
// because the field is genuinely raw, and on an apply because the sanitizer is
// idempotent on text it has already passed. Nothing is approximated.
//
// What CANNOT be replayed is anything decided before the guards ran -- a
// truncated generation, invalid JSON, a missing "rewritten" key, a network
// error. Those records are counted under `unreplayable`, with the reason
// alongside, rather than being quietly dropped into the no-op bucket: a run
// that silently discards records reads exactly like a run where the guards
// agreed.
//
// One shape LOOKS unreplayable and is not. A successful no-change result logs
// `noChanges: true` with `output: null` -- the handler has nothing to report --
// but production reached that branch by proving `cleaned.trim() === input.trim()`,
// so the output IS the input and the row replays exactly. Skipping them dropped
// real successes out of the denominator.

import { readFileSync, writeFileSync, chmodSync } from "fs";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { dirname, resolve } from "path";
import {
  guardSentenceResult, sanitizeSentenceOutput,
} from "./lib/sentence-guards.mjs";

import { normalizeInteraction, replayProjection, replayAttempts } from "./lib/log-record.mjs";

// Compatibility API used by sentence-evidence-test and research tools.
export const normalizeRecord = replayProjection;

function readInteractions(file) {
  return readFileSync(file, "utf8").split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [{ raw: JSON.parse(line), source: { file, row: index + 1 } }]; }
    catch { throw new Error(`${file}:${index + 1} is not JSON`); }
  });
}

export function loadRecords(file) {
  return readInteractions(file).flatMap(({ raw, source }) =>
    replayAttempts(raw).map((row) => ({ ...row, source })));
}

/**
 * Run one normalized record through the shipping guards.
 *
 * Returns null when the record cannot be replayed at all -- the caller decides
 * what to call that, and this tool calls it `unreplayable` rather than folding
 * it into any of the three real buckets.
 */
export function replayRecord(rec, opts = {}) {
  if (rec.path !== "sentence") return { skip: "not-sentence" };
  if (typeof rec.input !== "string" || !rec.input) return { skip: "unreplayable:no-input" };
  if (rec.output === null) {
    return { skip: rec.unavailable ? "unreplayable:" + rec.unavailable : rec.error ? "unreplayable:errored" : "unreplayable:no-output" };
  }

  // Exactly what the SENTENCE_REWRITE handler does, in the same order.
  const cleaned = sanitizeSentenceOutput(rec.input, rec.output);
  const reason = guardSentenceResult(rec.input, rec.output, cleaned,
    { trigger: rec.trigger, ...opts });
  const outcome = reason ? "refused"
    : cleaned.trim() === rec.input.trim() ? "no-op" : "applied";
  return { reason, outcome, cleaned };
}

export function replayFile(file, opts = {}) {
  const interactions = readInteractions(file);
  const records = interactions.flatMap(({ raw, source }) => replayAttempts(raw).map((row) => ({ ...row, source })));
  const sentence = interactions.map(({ raw }) => normalizeInteraction(raw)).filter((r) => r.path === "sentence");
  const coverage = {
    interactions: sentence.length,
    unsent: sentence.filter((r) => r.dispatched === false).length,
    unknownDispatch: sentence.filter((r) => r.dispatched === null).length,
    unavailableOutputs: records.filter((r) => r.unavailable).length,
  };
  const counts = { applied: 0, refused: 0, "no-op": 0 };
  const skips = {};
  const reasons = new Map();
  const flips = [];
  for (const rec of records) {
    const r = replayRecord(rec, opts);
    if (r.skip) { skips[r.skip] = (skips[r.skip] || 0) + 1; continue; }
    counts[r.outcome]++;
    if (r.reason) reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
    if (rec.recorded && rec.recorded !== r.outcome) {
      flips.push({
        id: rec.id, source: rec.source, attempt: rec.attempt || "main", was: rec.recorded, now: r.outcome,
        wasGuard: rec.recordedGuard, nowGuard: r.reason,
        reconstructed: !!rec.reconstructed,
        input: rec.input, output: rec.output,
      });
    }
  }
  const unreplayable = Object.entries(skips)
    .filter(([k]) => k.startsWith("unreplayable"))
    .reduce((a, [, n]) => a + n, 0);
  return { file, total: records.length, coverage, counts, skips, unreplayable, flips,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]) };
}

// ------------------------------------------------------------------- redaction

const hash = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
/** `word-substituted:emtal` names a token the user typed. The guard does not. */
const guardName = (g) => (g ? String(g).split(":")[0] : g);

/**
 * The default artifact. Enough to diff two guard versions -- which rows flipped,
 * which way, under which guard -- and not enough to reconstruct a sentence.
 */
function redact(R) {
  return {
    ...R,
    redacted: true,
    reasons: R.reasons.map(([k, n]) => [guardName(k), n])
      .reduce((acc, [k, n]) => {
        const at = acc.findIndex((x) => x[0] === k);
        if (at >= 0) acc[at][1] += n; else acc.push([k, n]);
        return acc;
      }, []),
    flips: R.flips.map((f) => ({
      id: f.id, source: f.source, attempt: f.attempt || "main", was: f.was, now: f.now,
      wasGuard: guardName(f.wasGuard), nowGuard: guardName(f.nowGuard),
      reconstructed: f.reconstructed,
      inputHash: hash(f.input), outputHash: hash(f.output),
      inputLen: f.input.length, outputLen: f.output.length,
    })),
  };
}

/**
 * Would git ignore this path? `git check-ignore -q` exits 0 when it would.
 *
 * A non-zero exit is treated as "not ignored" including the case where git is
 * not there at all, because the failure this guards against -- user text
 * committed by accident -- is not one to fail open on.
 */
function gitWouldIgnore(path) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path],
      { cwd: dirname(resolve(path)), stdio: "ignore" });
    return true;
  } catch { return false; }
}

function insideRepo(path) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"],
      { cwd: dirname(resolve(path)), encoding: "utf8" }).trim();
    return resolve(path).startsWith(top + "/");
  } catch { return false; }
}

// --------------------------------------------------------------------- report

function report(R, { examples, quiet }) {
  const s = R.counts;
  const scored = s.applied + s.refused + s["no-op"];
  console.log(`\n=== ${R.file}`);
  console.log(`${R.coverage.interactions} interactions | ${R.total} attempt/other rows | replayed ${scored} | `
    + `applied ${s.applied}  refused ${s.refused}  no-op ${s["no-op"]}`);
  console.log(`coverage: unsent ${R.coverage.unsent} | unknown dispatch ${R.coverage.unknownDispatch} | unavailable retry outputs ${R.coverage.unavailableOutputs}`);
  const skipped = Object.entries(R.skips);
  if (skipped.length) {
    console.log(`skipped: ${skipped.map(([k, n]) => `${k} ${n}`).join("  ")}`
      + (R.unreplayable ? `  (unreplayable ${R.unreplayable})` : ""));
  }
  if (!quiet && R.reasons.length) {
    console.log("\nrefusal reasons:");
    for (const [k, n] of R.reasons) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }

  // The flips are the point of the tool, so they are grouped by DIRECTION: a
  // refusal that now applies and an apply that now refuses are opposite kinds of
  // news and a single count of "12 flips" hides which one you got.
  const by = new Map();
  for (const f of R.flips) {
    const k = `${f.was} -> ${f.now}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(f);
  }
  console.log(`\nflips vs the recorded outcome: ${R.flips.length}`);
  for (const [k, group] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${k}  (${group.length})`);
    for (const f of group.slice(0, examples)) {
      const was = f.wasGuard ? ` [${f.wasGuard}]` : "";
      const now = f.nowGuard ? ` [${f.nowGuard}]` : "";
      // A retried interaction contributes up to two attempts under ONE id; the
      // attempt tag is what says which of them flipped.
      const att = f.attempt && f.attempt !== "main" ? ` (${f.attempt} attempt)` : "";
      console.log(`    ${f.id || "?"}${att}${was} ->${now || " applied"}`);
      console.log(`       ${JSON.stringify(f.input)}`);
      console.log(`    -> ${JSON.stringify(f.output)}`);
    }
    // Never let a truncation be silent: a run that prints eight of forty and
    // says nothing reads exactly like a run that found eight.
    if (group.length > examples) {
      console.log(`    ... and ${group.length - examples} more (--examples ${group.length} to see them)`);
    }
  }
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const files = argv.filter((a, i) =>
    !a.startsWith("--") && argv[i - 1] !== "--examples" && argv[i - 1] !== "--json");
  if (!files.length) {
    console.error("usage: node replay-log-guards.mjs <log.jsonl> [more.jsonl ...] "
      + "[--examples n] [--json out] [--include-text] [--quiet]");
    process.exit(2);
  }
  const examples = Number(arg("--examples", 8));
  const quiet = argv.includes("--quiet");
  const includeText = argv.includes("--include-text");
  const all = files.map((f) => replayFile(f));
  for (const R of all) report(R, { examples, quiet });

  const jsonOut = arg("--json", null);
  if (includeText && !jsonOut) {
    console.error("\n--include-text only affects --json; nothing was written.");
    process.exit(2);
  }
  if (jsonOut) {
    // Refuse rather than warn. A warning printed above a written file is a file
    // that exists, and the mistake this prevents is one nobody notices until it
    // is in a commit.
    if (includeText && insideRepo(jsonOut) && !gitWouldIgnore(jsonOut)) {
      console.error(`\nREFUSED: ${jsonOut} is inside the repository and git would not `
        + `ignore it.\n--include-text writes the user's own sentences. Write it outside `
        + `the repo, or\ninto a path .gitignore covers (test/harvested/, or any *.jsonl).`);
      process.exit(2);
    }
    writeFileSync(jsonOut, JSON.stringify(includeText ? all : all.map(redact), null, 2), { mode: 0o600 });
    // chmod as well: the mode option only applies at CREATION, and overwriting
    // an earlier permissive file would leave the user's sentences 0644.
    chmodSync(jsonOut, 0o600);
    console.log(`\nwrote ${jsonOut}${includeText ? " WITH SENTENCE TEXT" : " (redacted)"}`);
  }
  console.log();
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main(process.argv.slice(2));
}
