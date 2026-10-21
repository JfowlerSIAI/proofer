#!/usr/bin/env node
// Turn an exported interaction log into test cases.
//
//   node log-to-cases.mjs ~/Downloads/proofer-log-2026-08-06.jsonl
//   node log-to-cases.mjs log.jsonl --out harvested/
//   node log-to-cases.mjs friend.jsonl --contributor p07 --out harvested/beta/p07
//
// Every case carries its PROVENANCE, a list with one entry per source record:
// the contributor pseudonym (`owner` unless --contributor says otherwise), the
// batch (a hash of the export file it came from), the source record id, and
// the prompt revision and model digest the record was answered under -- so a
// beta contributor's deletion request can reach every case made from their
// file, and v1 data is never mistaken for a later model's. See
// docs/privacy-policy.md for the sharing/deletion policy. Deduplication MERGES
// the list: the same sentence with the same target
// from two records or two releases keeps both sources. The same sentence with
// DIFFERENT targets is kept as separate cases, each marked `conflict`, for a
// person to adjudicate -- keeping only the first was how the later source's
// identity was lost (beta checkpoint 1).
//
// Writes TWO staging files (tuning + holdout) and a report. It deliberately
// does NOT append to proofer-test.mjs or proofer-holdout.mjs: harvested cases
// are your own writing, and every one needs reading before it enters the repo.
//
// How a verdict becomes a case. The sentence path first (the product since
// 2026-09-24):
//
//   user-reverted            expected = the input     you typed your own words
//                                                     back: ratified negative
//   sentence-undone          expected = the input     Escape: ratified negative
//   sentence-undo-reconciled / sentence-undo-unverified
//                            expected = the input     Escape, even if not honored
//   user-edited-correction   expected = your edit     AMBIGUOUS, not gold: a
//                                                     rejection, an elaboration,
//                                                     or writing carried on in
//                                                     the sentence; finalText is
//                                                     the last settled state the
//                                                     watcher saw, not the final
//                                                     sentence. Adjudicate first.
//   sentence-applied         skipped                  written with nobody
//                                                     looking: not a label
//
// Legacy verdicts, still in old logs: suggestion mode's accept (ratified) and
// dismiss (ratified negative), and the manual path's below.
//
//   edited-after-apply      expected = your edit      the model's answer was
//                                                     wrong and you fixed it --
//                                                     the highest-value case
//                                                     this project can produce
//   edited-after-no-change  expected = your edit      the model said "looks
//                                                     good" and missed an error
//   applied                 expected = the rewrite    you ratified it
//   dismissed               expected = the input      false positive: this text
//                                                     should not have changed
//   cancelled / errored     skipped                   no judgement was made

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { normalizeInteraction } from "./lib/log-record.mjs";
import { substitutions } from "./lib/contamination.mjs";
import { SENTENCE_FEW_SHOT, SENTENCE_CONTEXT_SHOT, sentenceOutcomeDefinition } from "./lib/sentence-guards.mjs";
import { ALL_TESTS as CORE } from "./proofer-test.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flagValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const flagValues = new Set(["--out", "--contributor"].map(flagValue).filter(Boolean));
const logPath = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
const contributor = flagValue("--contributor") || "owner";
if (!/^[A-Za-z0-9_-]{1,32}$/.test(contributor)) {
  console.error("--contributor must be a pseudonym: letters, digits, _ and -, at most 32");
  process.exit(2);
}
const outIdx = args.indexOf("--out");
const outDir = resolve(__dirname, outIdx >= 0 ? args[outIdx + 1] : "harvested");

if (!logPath) {
  console.error("usage: node log-to-cases.mjs <export.jsonl> [--out dir]");
  process.exit(1);
}

const logBytes = readFileSync(resolve(logPath));
// Which contribution a case came from, without naming the file (a file name
// can carry a person's name): the first 12 hex of the export's SHA-256.
const batch = createHash("sha256").update(logBytes).digest("hex").slice(0, 12);
const records = logBytes.toString("utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l, i) => {
    try { return normalizeInteraction(JSON.parse(l), { schema: "browser" }); } catch { console.error(`  skipping unparseable line ${i + 1}`); return null; }
  })
  .filter(Boolean);

console.log(`\nRead ${records.length} records from ${logPath}`);

// --- Records to cases ---

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

function toCase(r) {
  if (r.error) return { skip: `error:${r.error}` };
  if (!r.input) return { skip: "no input" };
  // Sentence mode, which is a whole sentence in and a whole sentence out, maps
  // onto the suites cleanly -- but only its NEGATIVE verdicts do.
  //
  // "sentence-applied" is not a ratification. On the silent path the text was
  // written with nobody looking at it, so harvesting it as "expected" would
  // feed the model's own output back in as ground truth and launder its
  // mistakes into the corpus.
  //
  // "sentence-suggestion-applied" IS one, and it is the exception that makes
  // the rule readable: the chip showed the change, the user read it and pressed
  // Apply. That is the same act as the manual path's "applied" below, and this
  // file already harvests its counterpart -- "sentence-dismissed", the same
  // chip's other button -- as a ratified negative. Taking only the negative
  // from a two-button control biases the corpus toward the model being wrong.
  // The verdict did not exist before 2026-09-06: an accepted suggestion
  // recorded "sentence-applied", so this positive was indistinguishable from a
  // silent write and correctly skipped along with it.
  if (r.path === "sentence") {
    const policy = sentenceOutcomeDefinition(r.verdict)?.harvest;
    if (policy?.target === "output") {
      if (typeof r.output !== "string" || !r.output) return { skip: "accepted without output" };
      return { input: r.input, expected: r.output, source: r.verdict, confidence: policy.confidence };
    }
    // NOT gold. The watcher's own comment in content.js says this can be
    // continued writing inside the sentence rather than a correction of it,
    // and finalText is a sampled state. A human adjudicates before any of
    // these becomes a target.
    if (policy?.target === "finalText") {
      if (!r.finalText) return { skip: "edit without final text" };
      return { input: r.input, expected: r.finalText, source: r.verdict, confidence: policy.confidence };
    }
    // A revert puts the span back to the input byte for byte, so the expected
    // answer is the input -- and it is ratified, not inferred: the user typed
    // it twice. Escape is also deliberate rejection, even if the page discards
    // the undo. Neither rejection is inferred from the engine's output.
    if (policy?.target === "input") {
      return { input: r.input, expected: r.input, source: r.verdict, confidence: policy.confidence };
    }
    return { skip: r.verdict ? `sentence:${r.verdict}` : "sentence:unlabelled" };
  }

  // Only the plain full-text path maps cleanly onto the suites. A tone rewrite
  // has no single correct answer to score against, and a partial rewrite's
  // "expected" would be an excerpt whose surrounding text the suites never see.
  if (r.path !== "plain") return { skip: `path:${r.path}` };

  switch (r.verdict) {
    case "edited-after-apply":
    case "edited-after-no-change":
      if (!r.finalText) return { skip: "edit without final text" };
      return { input: r.input, expected: r.finalText, source: r.verdict, confidence: "gold" };
    case "applied":
      return { input: r.input, expected: r.output, source: "applied", confidence: "ratified" };
    case "dismissed":
      return { input: r.input, expected: r.input, source: "dismissed", confidence: "ratified" };
    default:
      return { skip: r.verdict ? `verdict:${r.verdict}` : "no verdict" };
  }
}

const skipped = {};
let cases = [];
for (const r of records) {
  const c = toCase(r);
  if (c.skip) { skipped[c.skip] = (skipped[c.skip] || 0) + 1; continue; }
  if (!c.expected) { skipped["no expected"] = (skipped["no expected"] || 0) + 1; continue; }
  // Survives dedup, splitting and everything downstream: this is what lets a
  // deletion request find every case made from one contributor's file.
  c.provenance = [{
    contributor,
    batch,
    recordId: typeof r.id === "string" ? r.id : null,
    promptRevision: typeof r.promptRevision === "string" ? r.promptRevision : null,
    modelDigest: typeof r.modelDigest === "string" ? r.modelDigest : null,
    model: typeof r.model === "string" ? r.model : null,
  }];
  cases.push(c);
}

// --- Dedup, and drop anything the suites already cover ---

// Keyed on input AND target: a repeat of both merges its source into the case
// already kept; the same input with another target is a case of its own.
const kept = new Map();
const existing = new Set(CORE.map((t) => norm(t.input)));
let dupes = 0, alreadyCovered = 0;
cases = cases.filter((c) => {
  if (existing.has(norm(c.input))) { alreadyCovered++; return false; }
  const key = norm(c.input) + "\u0000" + norm(c.expected);
  const first = kept.get(key);
  if (first) { first.provenance.push(...c.provenance); dupes++; return false; }
  kept.set(key, c);
  return true;
});
const targetsPerInput = new Map();
for (const c of cases) targetsPerInput.set(norm(c.input), (targetsPerInput.get(norm(c.input)) || 0) + 1);
let conflicts = 0;
for (const c of cases) if (targetsPerInput.get(norm(c.input)) > 1) { c.conflict = true; conflicts++; }

// --- Contamination ---
// A case whose required substitution the few-shot demonstrations already teach
// measures recall of the prompt, not skill. Flagged, not dropped: it is still a
// real case, it just cannot be used to claim the model generalizes.

// The demonstrations the product actually sends: the sentence path's set plus
// its one context demonstration. (This read the manual path's set until the
// beta removed that path; it never covered the sentence prompt at all.)
const shots = [...SENTENCE_FEW_SHOT, SENTENCE_CONTEXT_SHOT];
const taught = new Set();
for (const s of shots) {
  let after;
  try { after = JSON.parse(s.assistant).rewritten; } catch { continue; }
  for (const sub of substitutions(s.user, after)) taught.add(sub);
}
let contaminated = 0;
for (const c of cases) {
  if (norm(c.input) === norm(c.expected)) continue;
  for (const sub of substitutions(c.input, c.expected)) {
    if (taught.has(sub)) { c.contaminated = sub; contaminated++; break; }
  }
}

// --- Tuning / holdout split ---
// Hashed from the input, not random: re-running on a longer export keeps every
// case on the side it was first assigned. A case that drifts between tuning and
// holdout has quietly destroyed the holdout's meaning.

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const tuning = [], holdout = [];
for (const c of cases) (hash(norm(c.input)) % 5 === 0 ? holdout : tuning).push(c);

// --- Write ---

// 0700/0600: these files hold what the user typed, and the default umask
// leaves them readable by every local account. chmod as well as the creation
// modes, because mkdirSync/writeFileSync modes only apply to what they CREATE
// -- re-running into yesterday's 0755 tree or over a same-day 0644 file would
// otherwise leave the old permissions standing. Only the default harvested
// dir is chmodded: an explicit --out is the caller's directory, not ours.
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });
else if (outIdx < 0) chmodSync(outDir, 0o700);
const stamp = new Date().toISOString().slice(0, 10);
const write = (name, arr) => {
  const p = join(outDir, name);
  writeFileSync(p, JSON.stringify(arr, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
};
const tuningPath = write(`tuning-${stamp}.json`, tuning);
const holdoutPath = write(`holdout-${stamp}.json`, holdout);

// --- Report ---

const byConfidence = (arr, k) => arr.filter((c) => c.confidence === k).length;
console.log(`\nUsable cases: ${cases.length}`);
console.log(`  gold (you corrected it):      ${byConfidence(cases, "gold")}`);
console.log(`  ratified (accepted/rejected): ${byConfidence(cases, "ratified")}`);
console.log(`  ambiguous (adjudicate first): ${byConfidence(cases, "ambiguous")}`);
console.log(`  contributor: ${contributor}`);
console.log(`\nDropped:`);
for (const [reason, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${reason}`);
}
if (dupes) console.log(`  ${String(dupes).padStart(4)}  duplicate input and target (sources merged into the kept case)`);
if (alreadyCovered) console.log(`  ${String(alreadyCovered).padStart(4)}  already in the core suite`);
if (conflicts) {
  console.log(`\n${conflicts} case(s) flagged "conflict": the same sentence with different targets.`);
  console.log(`All are kept, for a person to decide between.`);
}
if (contaminated) {
  console.log(`\n${contaminated} case(s) flagged "contaminated": the few-shot demonstrations`);
  console.log(`already teach their substitution. Keep them out of any accuracy claim.`);
}
console.log(`\nWrote:\n  ${tuningPath}  (${tuning.length})\n  ${holdoutPath}  (${holdout.length})`);
console.log(`
NEXT: read both files before using them. They contain text you actually wrote.
Nothing here is wired into a suite -- that is deliberate. Once reviewed, the
holdout file must stay untouched by any tuning, exactly like proofer-holdout.mjs.
`);
