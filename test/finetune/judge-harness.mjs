#!/usr/bin/env node
// Terra judge batch runner for the distillation pipeline (§3, §12, R5).
//
//   node judge-harness.mjs --in <teacher-results.jsonl> [--out <path>]
//
// Input jsonl, one object per line: {uid, context, input, output}
//   uid     stable id for the example (used for resume and for calibration joins)
//   context prior context as production shapes it; "" or absent is fine
//   input   the source sentence
//   output  the teacher's corrected sentence
//
// Output jsonl at test/harvested/finetune/judge-verdicts.jsonl (gitignored):
//   {uid, groups, verdicts, judge_model, judge_model_reported, effort,
//    prompt_sha256, prompt_version, batch_id, ts, status}
// plus, when a sentinel flips, a record {type:"quarantine-since", ...}.
//
// Flags
//   --in <path>       required
//   --out <path>      default test/harvested/finetune/judge-verdicts.jsonl
//   --batch <n>       examples per batch, default 6 (sentinel is extra)
//   --limit <n>       stop after n input examples
//   --force           re-judge uids already present in the output
//   --keep-tmp        do not delete the per-batch prompt files
//
// Env
//   PROOFER_SEED      seeded PRNG for sentinel choice and interleave position;
//                     printed every run so a batch layout replays exactly
//   JUDGE_EFFORT      model_reasoning_effort, default "medium"
//   JUDGE_MODEL       default "gpt-5.6-terra"
//
// WHAT THIS WILL NOT DO. It never fabricates a verdict. A missing `codex`, an
// auth failure, or a second schema violation on the same batch is reported with
// the process's own stderr verbatim — the repo's standing rule that a harness
// path which completes green and produces nothing is a defect, applied to the
// one instrument whose output is training supervision.
//
// SENTINELS AND QUARANTINE (R5). Terra is hosted and version-labile, and a
// version string does not detect silent behaviour change. One sentinel from
// sentinels.json is interleaved into every batch at a random position with a
// real-looking uid, so it is indistinguishable from a live example. A verdict
// that does not match the sentinel's expected verdict is a FLIP: every label
// written since the last clean sentinel check is suspect, so a
// `quarantine-since` record naming those uids is written and the batch's own
// records are flagged `quarantined: true`. Nothing is deleted — the marker is
// the instrument, and re-running those uids under --force is the repair.
//
// The sentinels' stored groups are re-derived from their own input/output on
// every run and compared. A mismatch is fatal: it means edit-groups.mjs has
// changed under an immutable fixture, and the right response is to re-derive
// the groups AND re-confirm every expected verdict by hand, because a changed
// decomposition can change which verdict is correct.

import { createHash } from "crypto";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { editGroups, renderExample } from "./edit-groups.mjs";
import { VERDICT_SET as VERDICTS, argOf, hasFlag as has } from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const ART = path.join(REPO, "test", "harvested", "finetune");
const TMP = path.join(ART, "tmp");

// ---------------------------------------------------------------- args / env

const IN = argOf("--in", null);
const OUT = argOf("--out", path.join(ART, "judge-verdicts.jsonl"));
const BATCH_SIZE = Number(argOf("--batch", "6"));
const LIMIT = argOf("--limit", null) ? Number(argOf("--limit")) : Infinity;
const FORCE = has("--force");
const KEEP_TMP = has("--keep-tmp");
const EFFORT = process.env.JUDGE_EFFORT || "medium";
const MODEL = process.env.JUDGE_MODEL || "gpt-5.6-terra";

const SEED = process.env.PROOFER_SEED ? Number(process.env.PROOFER_SEED) >>> 0
                                      : (Math.random() * 2 ** 32) >>> 0;
let rs = SEED;
const rand = () => {
  rs = (rs + 0x6D2B79F5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function die(msg, detail) {
  console.error(`\nFATAL: ${msg}`);
  if (detail) console.error(String(detail).trimEnd());
  process.exit(1);
}

if (!IN) die("--in <teacher-results.jsonl> is required.\n" +
             "  node judge-harness.mjs --in <file.jsonl> [--out <path>] [--batch 6] [--force]");
if (!fs.existsSync(IN)) die(`input not found: ${IN}`);
if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1) die(`--batch must be a positive integer, got ${BATCH_SIZE}`);

// ------------------------------------------------------------ prompt + fixtures

// --prompt lets a CANDIDATE prompt run without touching the shipping file; the
// sha and version of whatever ran are stamped into every record either way, so
// a verdicts file always says which wording produced it.
const PROMPT_PATH = argOf("--prompt", null) ?? path.join(HERE, "judge-prompt.md");
if (!fs.existsSync(PROMPT_PATH)) die(`judge prompt missing: ${PROMPT_PATH}`);
const PROMPT_SRC = fs.readFileSync(PROMPT_PATH, "utf8");
const PROMPT_SHA = createHash("sha256").update(PROMPT_SRC).digest("hex");
const PROMPT_VERSION = (PROMPT_SRC.match(/^JUDGE_PROMPT_VERSION:\s*(\S+)/m) || [])[1] || "unversioned";
// Assembled rather than written literally, so this file's own source cannot be
// mistaken for the template's single placeholder by a careless grep.
const PLACEHOLDER = "{{" + "BATCH" + "}}";
const placeholderCount = PROMPT_SRC.split(PLACEHOLDER).length - 1;
if (placeholderCount !== 1) {
  die(`judge-prompt.md must contain the batch placeholder exactly once; found ${placeholderCount}.\n` +
      `  Zero means nothing would be judged. More than one means the batch lands at the FIRST\n` +
      `  occurrence — which is how the first smoke run handed Terra a prompt whose examples were\n` +
      `  buried inside an HTML comment, and got a well-formed empty answer back.`);
}

const SENTINELS = JSON.parse(fs.readFileSync(path.join(HERE, "sentinels.json"), "utf8")).cases;
if (!SENTINELS.length) die("sentinels.json holds no cases — R5's drift tripwire would be silently absent.");
for (const s of SENTINELS) {
  const live = editGroups(s.input, s.output);
  const same = live.length === s.groups.length && live.every((g, i) =>
    g.before === s.groups[i].before && g.after === s.groups[i].after &&
    g.srcSpan[0] === s.groups[i].srcSpan[0] && g.srcSpan[1] === s.groups[i].srcSpan[1]);
  if (!same) {
    die(`sentinel ${s.id}: stored groups no longer match editGroups(input, output).\n` +
        `  stored ${JSON.stringify(s.groups.map((g) => [g.before, g.after]))}\n` +
        `  live   ${JSON.stringify(live.map((g) => [g.before, g.after]))}\n` +
        `  edit-groups.mjs changed under an immutable fixture. Re-derive the groups AND\n` +
        `  re-confirm every expected verdict by hand — a changed decomposition can change\n` +
        `  which verdict is correct. Do not just overwrite the JSON.`);
  }
  for (const e of s.expected) {
    if (!VERDICTS.has(e.verdict)) die(`sentinel ${s.id} group ${e.group}: unknown verdict ${JSON.stringify(e.verdict)}`);
  }
}

// -------------------------------------------------------------------- codex

function codexPreflight() {
  const r = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (r.error) {
    die(`\`codex\` could not be run (${r.error.code || r.error.message}).\n` +
        `  The judge is Codex CLI + ${MODEL} (§12). Install it and authenticate, or set\n` +
        `  JUDGE_MODEL/PATH appropriately. No verdict is ever synthesised in its absence.`,
        r.stderr);
  }
  if (r.status !== 0) die(`\`codex --version\` exited ${r.status}.`, (r.stderr || "") + (r.stdout || ""));
  return (r.stdout || "").trim();
}

function runCodex(promptText, tmpFile) {
  fs.writeFileSync(tmpFile, promptText);
  const args = ["exec", "-s", "read-only", "--skip-git-repo-check",
                "-m", MODEL, "-c", `model_reasoning_effort="${EFFORT}"`, "-"];
  const t0 = Date.now();
  const r = spawnSync("codex", args, {
    input: promptText, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  if (r.error) die(`codex exec failed to start (${r.error.code || r.error.message}).`, r.stderr);
  const stdout = r.stdout || "", stderr = r.stderr || "";
  if (r.status !== 0) {
    die(`codex exec exited ${r.status}. Its own output follows verbatim.\n` +
        `  prompt kept at ${tmpFile}`,
        `--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`);
  }
  return { stdout, stderr, ms };
}

// codex prints a banner naming the model it resolved. The owner's config
// default is Sol, so -m must override it; if the banner says otherwise the run
// is not measuring what it claims to and says so loudly rather than proceeding.
function reportedModel(text) {
  const m = text.match(/^\s*(?:-{0,2}\s*)?model:\s*(\S+)/mi);
  return m ? m[1] : null;
}

// ------------------------------------------------------------- JSON recovery

// codex exec ECHOES the whole prompt to stdout before the assistant turn, and
// the prompt contains the output schema — a literal `{"examples": [...]}`. So
// the search is restricted to the region after the last `codex` turn marker
// (falling back to the whole text if the CLI's framing ever changes), and it
// scans from the END. Either guard alone would do; the pair is cheap, and
// mis-parsing the prompt's own example as an answer would fabricate verdicts.
function extractJson(text) {
  const marks = [...text.matchAll(/^codex$/gm)];
  if (marks.length) {
    const tail = text.slice(marks[marks.length - 1].index);
    const hit = scanForJson(tail);
    if (hit) return hit;
  }
  return scanForJson(text);
}

function scanForJson(text) {
  const starts = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "{") starts.push(i);
  for (let k = starts.length - 1; k >= 0; k--) {
    const s = starts[k];
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const cand = text.slice(s, i + 1);
          try {
            const o = JSON.parse(cand);
            if (o && Array.isArray(o.examples)) return o;
          } catch { /* not this one */ }
          break;
        }
      }
    }
  }
  return null;
}

// Returns null when valid, or a human-readable violation string.
function schemaViolation(obj, batch) {
  if (!obj) return "no JSON object with an `examples` array could be parsed from stdout";
  const byUid = new Map();
  for (const e of obj.examples) {
    if (!e || typeof e.uid !== "string") return "an entry in `examples` has no string `uid`";
    if (!Array.isArray(e.verdicts)) return `example ${e.uid}: \`verdicts\` is not an array`;
    byUid.set(e.uid, e);
  }
  for (const ex of batch) {
    const e = byUid.get(ex.uid);
    if (!e) return `example ${ex.uid} is missing from the response`;
    const want = new Set(ex.groups.map((g) => g.id));
    const seen = new Set();
    for (const v of e.verdicts) {
      if (!v || typeof v.group !== "number") return `example ${ex.uid}: a verdict has no numeric \`group\``;
      if (!want.has(v.group)) return `example ${ex.uid}: verdict names group ${v.group}, which does not exist (groups are ${[...want].join(", ")})`;
      if (seen.has(v.group)) return `example ${ex.uid}: group ${v.group} judged twice`;
      if (!VERDICTS.has(v.verdict)) return `example ${ex.uid} group ${v.group}: verdict ${JSON.stringify(v.verdict)} is not one of the five labels`;
      if (v.note != null && typeof v.note !== "string") return `example ${ex.uid} group ${v.group}: \`note\` is not a string`;
      seen.add(v.group);
    }
    for (const id of want) if (!seen.has(id)) return `example ${ex.uid}: group ${id} was not judged`;
  }
  return null;
}

// ---------------------------------------------------------------------- load

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim())
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { die(`${p}: line ${i + 1} is not JSON: ${e.message}`); }
    });
}

const rawIn = readJsonl(IN);
const done = new Set();
for (const r of readJsonl(OUT)) if (r && r.uid && r.type !== "quarantine-since") done.add(r.uid);

const pending = [];
const noEdit = [];
let skipped = 0, malformedIn = 0;
for (const r of rawIn) {
  if (pending.length + noEdit.length + skipped >= LIMIT) break;
  if (!r || typeof r.uid !== "string" || typeof r.input !== "string" || typeof r.output !== "string") {
    malformedIn++;
    continue;
  }
  if (!FORCE && done.has(r.uid)) { skipped++; continue; }
  const groups = editGroups(r.input, r.output);
  const ex = { uid: r.uid, context: r.context || "", input: r.input, output: r.output, groups };
  if (!groups.length) noEdit.push(ex); else pending.push(ex);
}

console.log(`\nTerra judge harness`);
console.log("=".repeat(72));
console.log(`  seed             ${SEED}   (PROOFER_SEED=${SEED} replays this batch layout)`);
console.log(`  judge model      ${MODEL}   effort=${EFFORT}`);
console.log(`  prompt           v${PROMPT_VERSION}  sha256=${PROMPT_SHA.slice(0, 16)}…`);
console.log(`  sentinels        ${SENTINELS.length} cases, ${SENTINELS.reduce((n, s) => n + s.expected.length, 0)} groups`);
console.log(`  input            ${IN}   (${rawIn.length} rows)`);
console.log(`  output           ${OUT}`);
console.log(`  to judge         ${pending.length}   no-edit ${noEdit.length}   already done ${skipped}${FORCE ? " (--force: re-judging)" : ""}`);
if (malformedIn) console.log(`  MALFORMED INPUT  ${malformedIn} row(s) lacked uid/input/output and were not judged`);
if (!pending.length && !noEdit.length) {
  console.log("\nNothing to judge. (An empty run is not a passing run — check --in and --force.)");
  process.exit(rawIn.length ? 0 : 1);
}

fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const outFd = fs.openSync(OUT, "a");
const write = (o) => fs.writeSync(outFd, JSON.stringify(o) + "\n");

const version = codexPreflight();
console.log(`  codex            ${version}`);

// ---------------------------------------------------------------- no-edit rows

const runTs = new Date().toISOString();
for (const ex of noEdit) {
  write({ uid: ex.uid, groups: [], verdicts: [], status: "no-edit",
          judge_model: null, judge_model_reported: null, effort: EFFORT,
          prompt_sha256: PROMPT_SHA, prompt_version: PROMPT_VERSION,
          batch_id: null, ts: runTs });
}
if (noEdit.length) console.log(`  ${noEdit.length} teacher no-op(s) recorded as no-edit without a judge call.`);

// ------------------------------------------------------------------- batches

const batches = [];
for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));

let flips = 0, failedBatches = 0, retried = 0;
let sinceClean = [];              // uids labelled since the last clean sentinel
const latencies = [];
const classCounts = {};

for (let bi = 0; bi < batches.length; bi++) {
  const real = batches[bi];
  const batchId = `b${String(bi + 1).padStart(4, "0")}-${SEED.toString(16)}`;

  // One sentinel, disguised with a real-looking uid and dropped at a random
  // position. A sentinel that announces itself measures nothing.
  const sent = SENTINELS[Math.floor(rand() * SENTINELS.length)];
  const sentUid = `s${batchId}-${Math.floor(rand() * 1e6).toString(36)}`;
  const sentEx = { uid: sentUid, context: sent.context || "", input: sent.input,
                   output: sent.output, groups: sent.groups, _sentinel: sent };
  const at = Math.floor(rand() * (real.length + 1));
  const batch = [...real.slice(0, at), sentEx, ...real.slice(at)];

  const body = batch.map((e) => renderExample(e)).join("\n\n");
  // Function replacement, not a string: a `$&` or `$1` in a teacher sentence
  // would otherwise be expanded by .replace() and silently corrupt the prompt.
  let prompt = PROMPT_SRC.replace(PLACEHOLDER, () => body);
  const tmpFile = path.join(TMP, `${batchId}.md`);

  let obj = null, violation = null, ms = 0, reported = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = runCodex(prompt, attempt ? tmpFile.replace(/\.md$/, ".retry.md") : tmpFile);
    ms += r.ms;
    reported = reportedModel(r.stdout) || reportedModel(r.stderr) || reported;
    obj = extractJson(r.stdout) || extractJson(r.stderr);
    violation = schemaViolation(obj, batch);
    if (!violation) break;
    if (attempt === 0) {
      retried++;
      console.log(`  [${batchId}] SCHEMA VIOLATION: ${violation}  — retrying once`);
      prompt += `\n\n# CORRECTION\n\nYour previous output violated the schema: ${violation}. ` +
                `Return ONLY the single JSON object described in "Output schema", with one entry ` +
                `per example and one verdict per edit group. No prose, no markdown fences, no rewritten text.\n`;
    }
  }

  latencies.push(ms);

  if (violation) {
    failedBatches++;
    console.log(`\n  [${batchId}] BATCH FAILED after retry: ${violation}`);
    console.log(`             ${real.length} example(s) NOT judged: ${real.map((e) => e.uid).join(", ")}`);
    console.log(`             prompt kept at ${tmpFile}`);
    continue;
  }

  if (reported && !reported.includes(MODEL)) {
    console.log(`  [${batchId}] WARNING: codex reported model ${JSON.stringify(reported)}, expected ${MODEL}. ` +
                `Verdicts are recorded with what was REPORTED, not with what was asked for.`);
  }

  const byUid = new Map(obj.examples.map((e) => [e.uid, e]));

  // Sentinel first: its verdict decides whether this batch's labels are trusted.
  const got = byUid.get(sentUid).verdicts;
  const gotBy = new Map(got.map((v) => [v.group, v.verdict]));
  const bad = sent.expected.filter((e) => gotBy.get(e.group) !== e.verdict);
  let quarantined = false;
  if (bad.length) {
    flips++;
    quarantined = true;
    const suspects = [...sinceClean, ...real.map((e) => e.uid)];
    console.log(`\n  ${"!".repeat(66)}`);
    console.log(`  SENTINEL FLIP  [${batchId}]  sentinel ${sent.id}`);
    for (const e of bad) {
      const g = sent.groups.find((x) => x.id === e.group);
      console.log(`    group ${e.group} ${JSON.stringify(g.before)} -> ${JSON.stringify(g.after)}`);
      console.log(`      expected ${e.verdict}   got ${gotBy.get(e.group)}`);
    }
    console.log(`  Every label since the last clean sentinel check is SUSPECT: ${suspects.length} uid(s).`);
    console.log(`  ${"!".repeat(66)}\n`);
    write({ type: "quarantine-since", ts: new Date().toISOString(), batch_id: batchId,
            sentinel_id: sent.id, judge_model: MODEL, judge_model_reported: reported,
            effort: EFFORT, prompt_sha256: PROMPT_SHA, prompt_version: PROMPT_VERSION,
            mismatches: bad.map((e) => ({ group: e.group, expected: e.verdict, got: gotBy.get(e.group) || null })),
            suspect_uids: suspects });
    sinceClean = [];
  } else {
    sinceClean = [];
  }

  const ts = new Date().toISOString();
  for (const ex of real) {
    const e = byUid.get(ex.uid);
    for (const v of e.verdicts) classCounts[v.verdict] = (classCounts[v.verdict] || 0) + 1;
    write({
      uid: ex.uid,
      groups: ex.groups,
      verdicts: e.verdicts.map((v) => ({ group: v.group, verdict: v.verdict, ...(v.note ? { note: v.note } : {}) })),
      status: "judged",
      judge_model: MODEL,
      judge_model_reported: reported,
      effort: EFFORT,
      prompt_sha256: PROMPT_SHA,
      prompt_version: PROMPT_VERSION,
      batch_id: batchId,
      ts,
      ...(quarantined ? { quarantined: true, quarantine_sentinel: sent.id } : {}),
    });
    if (!quarantined) sinceClean.push(ex.uid);
  }

  console.log(`  [${batchId}] ${real.length} judged + sentinel ${sent.id} ${bad.length ? "FLIPPED" : "ok"}  ${(ms / 1000).toFixed(1)}s`);
  if (!KEEP_TMP) { try { fs.unlinkSync(tmpFile); } catch {} try { fs.unlinkSync(tmpFile.replace(/\.md$/, ".retry.md")); } catch {} }
}

fs.closeSync(outFd);

const judged = pending.length - failedBatches * BATCH_SIZE;
console.log("\n" + "=".repeat(72));
console.log(`  batches          ${batches.length}   failed ${failedBatches}   schema retries ${retried}`);
console.log(`  examples judged  ${Math.max(0, judged)}   no-edit ${noEdit.length}`);
console.log(`  verdicts         ${Object.entries(classCounts).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);
if (latencies.length) {
  const sorted = [...latencies].sort((a, b) => a - b);
  console.log(`  batch wall clock median ${(sorted[sorted.length >> 1] / 1000).toFixed(1)}s   ` +
              `min ${(sorted[0] / 1000).toFixed(1)}s   max ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s`);
}
console.log(`  sentinel flips   ${flips}${flips ? "   *** labels quarantined — see quarantine-since records ***" : ""}`);
console.log(`  written to       ${OUT}`);
if (failedBatches || flips) process.exit(1);
