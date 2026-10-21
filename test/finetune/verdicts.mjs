// The judge verdict vocabulary, the keep/revert mapping it implies, and the
// jsonl plumbing every tool in this directory needs.
//
// This exists because the mapping was already living in two places — a
// `VERDICTS` set in judge-harness.mjs and a `KEEP_VERDICTS` set in
// calibrate-judge.mjs — and it is about to live in a third (the labeling flow).
// The mapping IS the D1 policy decision: `required-correction` and
// `benign-optional` survive into the training target, the other three revert
// the group to the source. A second copy of that is a second thing to forget
// when the policy moves, and the repo has a standing entry about exactly this
// shape ("which file owns a setting, a default, or a duplicated constant").
//
// No side effects at import.

import fs from "fs";
import path from "path";

/** The five labels, in the order they are offered to the owner and printed. */
export const VERDICT_CLASSES = [
  "required-correction",
  "benign-optional",
  "unnecessary",
  "meaning-damage",
  "uncertain",
];

export const VERDICT_SET = new Set(VERDICT_CLASSES);

/**
 * D1 (§2): these two survive into the target; the rest revert the edit group to
 * the source text. `uncertain` reverts — an unverifiable edit is not applied.
 */
export const KEEP_VERDICTS = new Set(["required-correction", "benign-optional"]);

export const isKeepVerdict = (v) => KEEP_VERDICTS.has(v);

/**
 * The owner-label projection of a verdict class.
 *
 * `calibrate-judge.mjs` gates on `keep` and `damage`, and those two booleans
 * cannot represent the five classes — `required-correction` and
 * `benign-optional` are both keep:false-free, and §4 explicitly requires
 * `benign-optional` and `unnecessary` to be told apart because they have
 * opposite outcomes. So the labeling flow records the full `verdict` AS WELL,
 * and this function is the single definition of how the two relate. Both
 * consumers check consistency against it rather than trusting a hand-edited
 * file.
 */
export function ownerLabelFor(verdict) {
  if (!VERDICT_SET.has(verdict)) throw new Error(`unknown verdict: ${JSON.stringify(verdict)}`);
  return { keep: KEEP_VERDICTS.has(verdict), damage: verdict === "meaning-damage" };
}

/** One-key selection: "1".."5" -> class. Printed by the labeling flow. */
export const VERDICT_KEYS = Object.fromEntries(VERDICT_CLASSES.map((c, i) => [String(i + 1), c]));

/** Short tags for tables, so a strata/confusion table fits in 80 columns. */
export const VERDICT_ABBR = {
  "required-correction": "req",
  "benign-optional": "ben",
  "unnecessary": "unn",
  "meaning-damage": "DMG",
  "uncertain": "unc",
};

// ------------------------------------------------------------------ jsonl io

export function fail(msg, detail) {
  console.error(`\nFATAL: ${msg}`);
  if (detail) console.error(String(detail).trimEnd());
  process.exit(1);
}

/**
 * Read a jsonl file. A malformed line is FATAL with its line number rather than
 * skipped: these files carry supervision, and a silently dropped row is a
 * quantity of missing training signal nobody will ever notice.
 */
export function readJsonl(p, what = "file") {
  if (!fs.existsSync(p)) fail(`${what} not found: ${p}`);
  const rows = [];
  const lines = fs.readFileSync(p, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { rows.push(JSON.parse(lines[i])); }
    catch (e) { fail(`${p}: line ${i + 1} is not JSON: ${e.message}`); }
  }
  return rows;
}

export function readJsonlIfPresent(p) {
  return fs.existsSync(p) ? readJsonl(p) : [];
}

export function writeJsonl(p, rows) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/** Append-only sink. Used by the labeling flow so a crash keeps every answer. */
export function appendSink(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  return {
    write(o) { fs.writeSync(fd, JSON.stringify(o) + "\n"); },
    close() { try { fs.closeSync(fd); } catch { /* already closed */ } },
  };
}

// --------------------------------------------------------------------- argv

export function argOf(flag, def = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : def;
}
export const hasFlag = (flag) => process.argv.includes(flag);

// ------------------------------------------------------------------- prng

/** Same generator the rest of the repo seeds with PROOFER_SEED. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(list, rnd) {
  const pool = list.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}
