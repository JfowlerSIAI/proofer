// log-to-cases.mjs keeps every source a case came from.
//
// Offline, synthetic records only. Historical contribution files need
// deletion requests to reach every derived case, so provenance must survive
// deduplication. The public export notice grants no training permission.
// Until 2026-09-25 dedup kept the FIRST record for an input and dropped the
// rest with their identities (beta checkpoint 1):
//
//   [1] the same sentence and target from two records under two prompt
//       revisions: ONE case, both sources in its provenance
//   [2] the same sentence with a DIFFERENT target: kept as its own case, and
//       every case for that sentence marked `conflict` for adjudication
//   [3] every source names the contributor and the batch (a hash of the
//       export, never its file name)
//
//   node log-to-cases-test.mjs

import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { normalizeRecord, replayRecord } from "./replay-log-guards.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL ${label}`); } };

const tmp = mkdtempSync(join(tmpdir(), "l2c-"));
const log = join(tmp, "export.jsonl");
const rec = (id, rev, finalText) => JSON.stringify({ v: 1, id, path: "sentence", promptRevision: rev,
  modelDigest: "d".repeat(64), model: "proofer:v1-q4", input: "The vendor recieved the specs today.",
  output: "The vendor received the specs today.", verdict: "user-reverted", finalText });
const lines = [
  rec("sn_a", "sentence-v1"),
  rec("sn_b", "sentence-v2"),
  // The same input, a different (ambiguous) target.
  JSON.stringify({ v: 1, id: "sn_c", path: "sentence", promptRevision: "sentence-v2",
    input: "The vendor recieved the specs today.", output: "The vendor received the specs today.",
    verdict: "user-edited-correction", finalText: "The vendor received the new specs today." }),
];
writeFileSync(log, lines.join("\n") + "\n");
const out = join(tmp, "out");
execFileSync(process.execPath, [join(__dirname, "log-to-cases.mjs"), log, "--contributor", "p07", "--out", out],
  { stdio: "ignore", env: { ...process.env, PROOFER_OLLAMA_URL: "http://127.0.0.1:9" } });
const cases = readdirSync(out).filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(out, f), "utf8")));
const byTarget = (t) => cases.filter((c) => c.expected === t);
const reverted = byTarget("The vendor recieved the specs today.");
const edited = byTarget("The vendor received the new specs today.");

ok(reverted.length === 1, `[1] one case for the repeated sentence and target (got ${reverted.length})`);
const ids = (reverted[0]?.provenance || []).map((p) => p.recordId).sort();
ok(JSON.stringify(ids) === JSON.stringify(["sn_a", "sn_b"]), `[1] ...carrying BOTH sources (got ${JSON.stringify(ids)})`);
const revs = (reverted[0]?.provenance || []).map((p) => p.promptRevision).sort();
ok(JSON.stringify(revs) === JSON.stringify(["sentence-v1", "sentence-v2"]), `[1] ...and both revisions (got ${JSON.stringify(revs)})`);
ok(edited.length === 1 && edited[0].provenance[0].recordId === "sn_c",
  `[2] the other target is its own case (got ${edited.length})`);
ok(reverted[0]?.conflict === true && edited[0]?.conflict === true, "[2] ...and both are marked `conflict`");
const batch = createHash("sha256").update(readFileSync(log)).digest("hex").slice(0, 12);
const all = cases.flatMap((c) => c.provenance);
ok(all.length === 3 && all.every((p) => p.contributor === "p07" && p.batch === batch),
  `[3] every source names the contributor and the batch (got ${JSON.stringify(all.map((p) => [p.contributor, p.batch]))})`);
ok(!JSON.stringify(cases).includes("export.jsonl"), "[3] ...and never the file name");
// And what each source was answered under: the model and its digest ride
// along per source, not per case (the re-check found a mutant dropping the
// digest that every assertion above let through).
const ab = (reverted[0]?.provenance || []);
ok(ab.length === 2 && ab.every((p) => p.modelDigest === "d".repeat(64) && p.model === "proofer:v1-q4"),
  `[3] every merged source keeps its model and digest (got ${JSON.stringify(ab.map((p) => [p.model, p.modelDigest && p.modelDigest.slice(0, 4)]))})`);
ok(edited[0]?.provenance[0].modelDigest === null && edited[0]?.provenance[0].promptRevision === "sentence-v2",
  "[3] ...and a source that recorded none says so");

// [4] Mutant: either undo definition's harvest target "input" -> "skip";
// its ratified-negative/source and exact-count assertions turn red; old strings stay out.
const undoRecords = ["sentence-undo-reconciled", "sentence-undo-unverified",
  "sentence-applied-unverified", "sentence-reconciled"].map((verdict, i) => ({
  id: `sn_undo_${i}`, path: "sentence", verdict,
  input: `The vendor recieved the ${["specs", "plans", "notes", "files"][i]} today.`,
  output: `The vendor received the ${["specs", "plans", "notes", "files"][i]} today.`,
}));
const undoLog = join(tmp, "undo.jsonl"), undoOut = join(tmp, "undo-out");
writeFileSync(undoLog, undoRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
execFileSync(process.execPath, [join(__dirname, "log-to-cases.mjs"), undoLog, "--out", undoOut], { stdio: "ignore" });
const undoCases = readdirSync(undoOut).filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(undoOut, f), "utf8")));
for (const r of undoRecords.slice(0, 2)) {
  const c = undoCases.find((c) => c.input === r.input);
  ok(c?.expected === r.input && c?.confidence === "ratified" && c?.source === r.verdict,
    `[4] ${r.verdict} is a ratified negative with its exact source`);
}
ok(undoCases.length === 2, "[4] exactly two failed-undo cases are harvested");
ok(!undoCases.some((c) => undoRecords.slice(2).some((r) => r.input === c.input)),
  "[4] old applied-unverified and reconciled records remain unharvested");

// [5] Mutant: normalizeRecord's userVerdict -> null; both preservation
// assertions turn red while guard acceptance remains an independent control.
for (const r of undoRecords.slice(0, 2)) {
  const normalized = normalizeRecord(r);
  ok(normalized.userVerdict === r.verdict, `[5] replay preserves ${r.verdict}`);
  ok(normalized.recorded === "applied" && normalized.recordedGuard === null,
    `[5] ${r.verdict} records guard acceptance, not guard refusal`);
  ok(replayRecord(normalized).outcome === "applied", `[5] ${r.verdict} still replays the accepted candidate`);
}

// [6] Mutant: normalized writes' harvest policy -> { target: "input", confidence: "ratified" };
// the zero-harvest assertion turns red; replay still pins the separate engine outcome.
const writtenRecords = ["sentence-written:splice-failed:normalized", "sentence-written:splice-failed:misplaced",
  "sentence-written:splice-failed:normalized:window=replay", "sentence-written:splice-failed:misplaced:window=yield/key:Backspace",
  "sentence-skipped:splice-failed:normalized:window=yield/key:Back", "sentence-skipped:splice-failed:misplaced:window=yield/key:Backsp"]
  .map((verdict, i) => ({ id: `sn_written_${i}`, path: "sentence", verdict,
    input: `The vendor recieved the ${["specs", "plans", "notes", "files", "papers", "reports"][i]} today.`,
    output: `The vendor received the ${["specs", "plans", "notes", "files", "papers", "reports"][i]} today.` }));
const writtenLog = join(tmp, "written.jsonl"), writtenOut = join(tmp, "written-out");
writeFileSync(writtenLog, writtenRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
execFileSync(process.execPath, [join(__dirname, "log-to-cases.mjs"), writtenLog, "--out", writtenOut], { stdio: "ignore" });
const writtenCases = readdirSync(writtenOut).filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(writtenOut, f), "utf8")));
ok(writtenCases.length === 0, "[6] post-write outcomes and historical aliases remain unharvested");
for (const r of writtenRecords) {
  const normalized = normalizeRecord(r);
  ok(normalized.userVerdict === r.verdict, `[6] replay preserves ${r.verdict}`);
  ok(normalized.recorded === "applied" && normalized.recordedGuard === null,
    `[6] ${r.verdict} records the guard-accepted candidate`);
  ok(replayRecord(normalized).outcome === "applied", `[6] ${r.verdict} replays engine acceptance separately from the write`);
}

// [7] Mutant: normalizeRecord uses r.guard instead of sentenceRecordGuard(r);
// historical error classification/absent-guard assertions turn red for all three.
for (const error of ["truncated", "invalid-json", "no-rewritten-key"]) {
  for (const historical of [false, true]) {
    const r = { id: `sn_shape_${error}_${historical}`, path: "sentence",
      input: "The vendor recieved the specs today.", output: null,
      error, guard: historical ? error : null, verdict: null };
    const before = JSON.stringify(r);
    const normalized = normalizeRecord(r);
    ok(normalized.recorded === "error" && normalized.recordedGuard === null && normalized.error === error,
      `[7] ${historical ? "historical" : "new"} ${error} is an error without a recorded guard`);
    ok(replayRecord(normalized).skip === "unreplayable:errored",
      `[7] ${historical ? "historical" : "new"} ${error} cannot replay without a candidate`);
    ok(JSON.stringify(r) === before, `[7] ${error} normalization preserves the source record`);
  }
}
for (const [guard, error] of [["word-substituted:folx", "consent-read-timeout"],
  ["truncated", "unreachable"], ["unknown-reason", "unknown-reason"]]) {
  const r = normalizeRecord({ path: "sentence", input: "A sentence.", output: "A candidate.", guard, error });
  ok(r.recorded === "refused" && r.recordedGuard === guard,
    `[7] a nonmatching or genuine guard survives another error: ${guard}`);
}

// [8] Mutant: parsing returns JSON.parse(l) instead of normalizeInteraction(...).
// The legacy/new merged provenance assertions turn red (pathless legacy sentence).
// A retry is still ONE interaction: accepted attempts alone cannot supply a label.
const harvestInput = "The archivist recieved the cobalt ledger yesterday.";
const harvestRecords = [
  { v: 1, id: "sn_legacy", input: harvestInput, output: harvestInput.replace("recieved", "received"),
    verdict: "user-reverted", model: "old-model", modelDigest: "a".repeat(64), promptRevision: "old-prompt" },
  { v: 2, path: "sentence", id: "sn_current", input: harvestInput,
    output: harvestInput.replace("recieved", "received"), verdict: "user-reverted",
    model: "new-model", modelDigest: "b".repeat(64), promptRevision: "new-prompt",
    attempts: [{ outcome: "refused", output: "A refused candidate." },
      { outcome: "applied", output: harvestInput.replace("recieved", "received") }] },
  ...[1, 2].map((v) => ({ v, path: "sentence", id: `sn_timeout_${v}`,
    input: "The curator recieved the vermilion parcel yesterday.",
    output: v === 1 ? "The curator received a parcel." : null,
    guard: v === 1 ? "low-overlap" : null, error: "consent-read-timeout", verdict: null,
    retry: { outcome: "applied", firstOutput: "The curator received a parcel.", firstGuard: "low-overlap" },
    attempts: v === 2 ? [{ outcome: "refused", output: "The curator received a parcel." },
      { outcome: "applied", output: "The curator received the vermilion parcel yesterday." }] : undefined })),
];
const harvestLog = join(tmp, "harvest.jsonl"), harvestOut = join(tmp, "harvest-out");
writeFileSync(harvestLog, harvestRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
const harvestReport = execFileSync(process.execPath, [join(__dirname, "log-to-cases.mjs"), harvestLog,
  "--contributor", "p08", "--out", harvestOut], { encoding: "utf8" });
const harvestCases = readdirSync(harvestOut).filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(join(harvestOut, f), "utf8")));
ok(harvestCases.length === 1, "[8] old/new labelled interactions merge into one case; timeouts stay out");
const harvested = harvestCases[0];
ok(harvested?.expected === harvestInput && harvested?.source === "user-reverted"
  && harvested?.confidence === "ratified", "[8] normalized harvesting retains worker verdict policy");
ok(JSON.stringify(harvested?.provenance.map((p) => p.recordId)) === JSON.stringify(["sn_legacy", "sn_current"]),
  "[8] one provenance entry per old/new interaction, never per attempt");
const harvestBatch = createHash("sha256").update(readFileSync(harvestLog)).digest("hex").slice(0, 12);
ok(harvested?.provenance.length === 2 && harvested.provenance.every((p, i) =>
  p.contributor === "p08" && p.batch === harvestBatch && p.model === ["old-model", "new-model"][i]
  && p.modelDigest === ["a", "b"][i].repeat(64) && p.promptRevision === ["old-prompt", "new-prompt"][i]),
  "[8] both schemas preserve contributor, batch, model, digest and revision");
ok(/2  error:consent-read-timeout/.test(harvestReport), "[8] both undelivered accepted retries are excluded as errors");

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
