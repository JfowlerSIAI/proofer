// Pre-guard teacher scoring: what does the model EMIT, before any guard runs?
//
// A student distills raw teacher emissions, so the teacher-selection number is
// the pre-guard edit rate on CLEAN sentences (meddling pressure) alongside the
// pre-guard edit rate on labelled-ERROR sentences (correction reach). Guards
// are Proofer's inference-time defence; they do not clean a training set
// unless the pipeline applies them, so both views are reported: raw, and
// what survives guardSentenceResult.
//
// Guards come from this script's tree. Labels come from PROOFER_CORPUS_DIR
// or the script-relative harvested/ directory; run-filename selection is unchanged.
//
// Usage: node preguard-score.mjs <bench-run.jsonl> [more.jsonl ...]
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  guardSentenceResult, sanitizeSentenceOutput,
} from "./lib/sentence-guards.mjs";

const HARVESTED = process.env.PROOFER_CORPUS_DIR || fileURLToPath(new URL("./harvested/", import.meta.url));

function labelsFor(file) {
  const m = file.match(/bench-(error-holdout|random-holdout|dev-corpus)-/);
  if (!m) return null;
  const d = JSON.parse(readFileSync(join(HARVESTED, "labels-" + m[1] + ".json"), "utf8"));
  return d.labels;
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

for (const file of process.argv.slice(2)) {
  const labels = labelsFor(file);
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const stats = {
    CLEAN: { n: 0, emitted: 0, survived: 0 },
    ERROR: { n: 0, emitted: 0, survived: 0 },
    unlabelled: 0, errored: 0,
  };
  for (const r of rows) {
    if (r.error || typeof r.output !== "string") { stats.errored++; continue; }
    const lab = labels?.[r.uid]?.class;
    const bucket = lab === "CLEAN" ? "CLEAN" : lab ? "ERROR" : null;
    if (!bucket) { stats.unlabelled++; continue; }
    stats[bucket].n++;
    const cleaned = sanitizeSentenceOutput(r.sentence, r.output);
    const emitted = norm(cleaned) !== norm(r.sentence);
    if (!emitted) continue;
    stats[bucket].emitted++;
    const reason = guardSentenceResult(r.sentence, r.output, cleaned, {});
    if (!reason) stats[bucket].survived++;
  }
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "-";
  console.log(`\n=== ${file.split("/").pop()}`);
  for (const b of ["CLEAN", "ERROR"]) {
    const s = stats[b];
    console.log(`  ${b.padEnd(6)} n=${String(s.n).padEnd(4)} pre-guard edits=${String(s.emitted).padEnd(4)} (${pct(s.emitted, s.n)})  surviving guards=${s.survived} (${pct(s.survived, s.n)})`);
  }
  if (stats.unlabelled || stats.errored) {
    console.log(`  unlabelled=${stats.unlabelled} errored=${stats.errored}`);
  }
}
