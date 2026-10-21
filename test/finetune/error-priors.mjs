#!/usr/bin/env node
// v0 error-class priors for the Phase 1 injection mixture (plan §6.1).
//
//   node error-priors.mjs [--out <path>] [--in <a.jsonl> ...] [--all-changed]
//
// §6.1 fits class priors from sources that actually contain typed -> intended
// pairs. The raw owner corpus is not one of them — those messages are final
// sends. What IS on disk is the ~1,800 recorded {input, output, verdict} rows
// from the shipping sentence path: `qwen.jsonl`, `lfm.jsonl`, the two
// `bench-*-holdout-run.jsonl` recordings, and the 2026-08-20 interaction-log
// export (its `path === "sentence"` rows). Those sources contain 1,845 raw
// rows, of which 1,789 are sentence interactions used for these priors.
//
// WHAT THIS IS AND IS NOT. It is a v0 prior: the shape distribution of
// corrections the shipping model+guards actually made on real typing. It is
// NOT the keystroke error channel. Two biases are structural and are recorded
// in the artifact rather than smoothed away:
//   * it can only see errors a model found and (by default) the guards let
//     through, so classes the guards refuse by design are under-counted;
//   * a model output is not a typist's intent, so a "correction" that was
//     meddling is counted as an error of whatever shape it took.
// Plan §6.1's other two estimators close exactly these gaps and are PHASE 2:
// the ITE Typing Dataset (keystroke-level, mobile-skewed) and, if the two
// disagree materially, a stratified owner-labelled sample. The artifact
// carries `"version": "v0-recorded-pairs-only"` so nothing downstream can
// mistake this for the fitted channel.
//
// By default only pairs the SHIPPING GUARD CHAIN accepted are counted
// (schema-normalized interaction acceptance, independent of user verdict):
// a refused pair is the model misbehaving, and its shape is a prior over model damage, not over typing.
// `--all-changed` counts every changed pair and prints both columns, which is
// how the size of that bias is read rather than assumed.
//
// No model is contacted and no owner text is written: the artifact holds
// counts and rates only.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { editGroups, tokenize } from "./edit-groups.mjs";
import { ERROR_TYPES } from "./benchmark-schema.mjs";
import { INJECTABLE_TYPES, QWERTY_NEIGHBOURS } from "./error-inject.mjs";
import {
  isWord, isConfusable, isShiftStutter, editDistance,
} from "../lib/sentence-guards.mjs";
import { normalizeInteraction } from "../lib/log-record.mjs";
import { argOf, hasFlag, fail } from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARVEST = path.join(HERE, "..", "harvested");
const ART = path.join(HARVEST, "finetune");

/** The recorded-pair sources §6.1 names, with how to read a pair out of each. */
export const RECORDING_SOURCES = Object.freeze([
  { file: "qwen.jsonl", schema: "corpus" },
  { file: "lfm.jsonl", schema: "corpus" },
  { file: "bench-error-holdout-run.jsonl", schema: "corpus" },
  { file: "bench-random-holdout-run.jsonl", schema: "corpus" },
  { file: "export-20260820.jsonl", schema: "browser", onlySentencePath: true },
]);

// =====================================================================
// The classifier
// =====================================================================

const APOS = /['’]/g;
const PUNCT_ONLY = /^[\s.,;:!?'"()\[\]{}‘’“”\-–—…]*$/;
const TERMINATORS = /[.!?]/;
const INFLECTIONS = ["s", "es", "ed", "d", "ing", "n", "'s"];

const words = (s) => tokenize(s).filter((t) => t.kind === "word").map((t) => t.text);
const squash = (s) => s.replace(/\s+/g, "");
const lower = (s) => s.toLowerCase();

function isTransposition(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i + 1 < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] === b[i + 1] && a[i + 1] === b[i]
      && a.slice(i + 2) === b.slice(i + 2);
  }
  return false;
}

function substitutionIndex(a, b) {
  if (a.length !== b.length) return -1;
  let idx = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (idx >= 0) return -1;
    idx = i;
  }
  return idx;
}

function inflectionOnly(a, b) {
  const [shortSide, longSide] = a.length <= b.length ? [a, b] : [b, a];
  if (!longSide.startsWith(shortSide)) {
    // `carry`/`carries`, `run`/`running` — allow one stem edit before the suffix.
    const stem = longSide.slice(0, shortSide.length);
    if (editDistance(stem, shortSide) > 1) return false;
  }
  const suffix = longSide.slice(shortSide.length);
  return INFLECTIONS.includes(suffix);
}

/**
 * A doubled word removed. Two shapes, and the second is why `ctx` exists: the
 * repair of `the the` is usually a DELETION group whose `before` is one token
 * and whose `after` is empty, so the evidence that it was a duplicate lives in
 * the source either side of the span and not in the group at all. Without it
 * the class read 0 over 1,058 real groups.
 */
function dropsAdjacentDuplicate(before, after, ctx) {
  const b = words(before).map(lower), a = words(after).map(lower);
  if (b.length === a.length + 1) {
    for (let i = 0; i + 1 < b.length; i++) {
      if (b[i] !== b[i + 1]) continue;
      const trial = b.slice(0, i).concat(b.slice(i + 1));
      if (trial.join(" ") === a.join(" ")) return true;
    }
  }
  if (b.length === 1 && !a.length && ctx && typeof ctx.source === "string"
      && Array.isArray(ctx.srcSpan)) {
    const [s, e] = ctx.srcSpan;
    const beforeTok = words(ctx.source.slice(0, s)).map(lower).pop();
    const afterTok = words(ctx.source.slice(e)).map(lower)[0];
    if (b[0] === beforeTok || b[0] === afterTok) return true;
  }
  return false;
}

/**
 * The taxonomy class one edit group's evidence best supports.
 *
 * `before` is what the typist wrote, `after` is the correction — the direction
 * matters for `run-together` (a missing space) versus `moved-space` (a space in
 * the wrong place), and for the apostrophe classes.
 *
 * This is a HEURISTIC over shapes, deliberately in the vocabulary of
 * `benchmark-schema.ERROR_TYPES` so injection, judging and evaluation share one
 * taxonomy (§6.1). Anything it cannot place is `other-natural`, which is a real
 * class rather than a bucket for failures: a real-word substitution with no
 * licence has no lexical evidence to place it by, which is the same blind spot
 * the guards and the screens have.
 *
 * @param {{source: string, srcSpan: [number,number]}|null} ctx  the group's home,
 *        needed for the deletion-shaped doubled word (see dropsAdjacentDuplicate)
 * @returns {string} one of ERROR_TYPES
 */
export function classifyEdit(before, after, ctx = null) {
  const b = String(before ?? ""), a = String(after ?? "");
  if (b === a) return null;

  // Punctuation-only, either side. A terminator change is its own class; any
  // other pure-punctuation edit has no better home.
  if (PUNCT_ONLY.test(b) && PUNCT_ONLY.test(a)) {
    return TERMINATORS.test(b) || TERMINATORS.test(a) ? "terminator" : "other-natural";
  }

  // A `;` standing where an apostrophe belongs — checked BEFORE the apostrophe
  // class, because the repaired token satisfies both tests by construction.
  if (b.replace(/;/g, "'").replace(APOS, "'") === a.replace(APOS, "'")) {
    return "semicolon-apostrophe";
  }

  // Casing is asked BEFORE the whitespace test, not after: with no whitespace
  // difference the squash test is vacuously true, so a plain `this` -> `This`
  // was reported as a moved space and `casing`/`held-shift-stutter` both read 0
  // over 1,058 real edit groups.
  if (lower(b) === lower(a)) {
    return isShiftStutter(words(b)[0] ?? b) || /^[A-Z]{2,}[a-z]/.test(b)
      ? "held-shift-stutter" : "casing";
  }

  // Whitespace moved or missing. Case-insensitive so `Howdo you` -> `How do
  // you` is a moved space rather than a casing edit riding on one.
  if (squash(lower(b)) === squash(lower(a))) {
    const bs = /\s/.test(b), as = /\s/.test(a);
    if (bs !== as) return "run-together";
    return "moved-space";
  }

  // A space moved ACROSS a typo — `wek nwo` -> `we know`, the shape the repo's
  // own `collapseResegmentations` licenses at one edit. The squashed sides are
  // within one edit and the SPACE SIGNATURE (the run lengths between spaces)
  // differs, which is what keeps `teh` -> `the` (identical signature, no spaces
  // at all) and `the cat` -> `the bat` out of this branch.
  const sig = (s) => s.trim().split(/\s+/).map((t) => t.length).join("-");
  if ((/\s/.test(b) || /\s/.test(a)) && sig(b) !== sig(a)
      && editDistance(squash(lower(b)), squash(lower(a))) <= 1) {
    return words(b).length === words(a).length ? "moved-space" : "run-together";
  }

  if (dropsAdjacentDuplicate(b, a, ctx)) return "doubled-word";

  if (lower(b).replace(APOS, "") === lower(a).replace(APOS, "")) {
    return "dropped-apostrophe";
  }

  const bw = words(b), aw = words(a);
  if (bw.length === 1 && aw.length === 1) {
    const bl = lower(bw[0]), al = lower(aw[0]);
    if (isConfusable(bl, al)) return "homophone-confusable";
    if (isTransposition(bl, al)) return "transposition";
    const si = substitutionIndex(bl, al);
    if (si >= 0 && (QWERTY_NEIGHBOURS[bl[si]] ?? "").includes(al[si])) {
      return "adjacent-key";
    }
    if (inflectionOnly(bl, al) && isWord(bl) && isWord(al)) return "agreement";
    if (editDistance(bl, al) === 1) return "adjacent-key";
  }
  return "other-natural";
}

/** Every group's class for one recorded pair. */
export function classifyPair(input, output) {
  return editGroups(input, output).map(
    (g) => classifyEdit(g.before, g.after, { source: input, srcSpan: g.srcSpan }));
}

// =====================================================================
// Interaction accounting and CLI
// =====================================================================

export function buildErrorPriors({ sources = RECORDING_SOURCES, root = HARVEST, allChanged = false } = {}) {
  const perSource = [];
  const counts = { applied: {}, all: {} };
  for (const t of ERROR_TYPES) { counts.applied[t] = 0; counts.all[t] = 0; }
  let rows = 0, changed = 0, changedApplied = 0, groupsAll = 0, groupsApplied = 0;

  for (const src of sources) {
    const p = path.isAbsolute(src.file) ? src.file : path.join(root, src.file);
    if (!fs.existsSync(p)) {
      fail(`missing recording ${p}\n  §6.1's prior is fitted from these files; a missing one is a\n`
         + "  smaller sample silently, which is exactly what this refuses to do.");
    }
    let n = 0, ch = 0, chApplied = 0, gr = 0;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const l = line.trim();
      if (!l) continue;
      let d; try { d = JSON.parse(l); } catch { fail(`${src.file}: malformed jsonl line`); }
      if (src.onlySentencePath && d.path !== "sentence") continue;
      const record = normalizeInteraction(d, { schema: src.schema });
      const inp = record.input, out = record.output;
      n++;
      if (typeof inp !== "string" || typeof out !== "string" || inp === out) continue;
      ch++;
      // Count the selected interaction pair once, never its individual attempts.
      const applied = record.recorded === "applied" && !record.error;
      if (applied) chApplied++;
      for (const cls of classifyPair(inp, out)) {
        if (!cls) continue;
        gr++;
        counts.all[cls]++;
        if (applied) counts.applied[cls]++;
      }
    }
    perSource.push({ file: src.file, rows: n, changed_pairs: ch, changed_applied: chApplied });
    rows += n; changed += ch; changedApplied += chApplied; groupsAll += gr;
  }
  groupsApplied = Object.values(counts.applied).reduce((s, n) => s + n, 0);

  const base = allChanged ? counts.all : counts.applied;
  const baseN = allChanged ? groupsAll : groupsApplied;
  if (!baseN) fail("0 classified edit groups — the recordings changed shape, or every pair was refused.");

  // Two normalisations, because they answer different questions. `rates` is the
  // observed class distribution over everything, `inject_mix` is what the
  // injector can actually produce (INJECTABLE_TYPES = taxonomy minus
  // `other-natural`, which by definition has no transform).
  const rates = {}, injectMix = {};
  for (const t of ERROR_TYPES) rates[t] = base[t] / baseN;
  const injN = INJECTABLE_TYPES.reduce((s, t) => s + base[t], 0);
  if (!injN) fail("0 groups in any INJECTABLE class — cannot derive an injection mixture.");
  for (const t of INJECTABLE_TYPES) injectMix[t] = base[t] / injN;

  const artifact = {
    version: "v0-recorded-pairs-only",
    note: "Class priors fitted from the recorded {input, output} pairs of the shipping "
        + "sentence path only. This is NOT the fitted keystroke error channel: plan "
        + "§6.1's ITE Typing Dataset estimator and the stratified owner-labelled "
        + "tiebreak sample are PHASE 2 and are not integrated here. Known biases are "
        + "recorded in `biases` below.",
    ite_integration: "phase-2, not done",
    generated_by: "test/finetune/error-priors.mjs",
    generated_at: new Date().toISOString(),
    basis: allChanged ? "every changed interaction pair" : "guard-accepted interaction pairs, excluding delivery errors",
    biases: [
      "only errors the model found are visible; classes the guards refuse by design are under-counted",
      "a model output is not a typist's intent — meddling is counted as an error of whatever shape it took",
      "classifyEdit is a lexical heuristic; unplaceable edits fall to other-natural",
    ],
    sources: perSource,
    totals: {
      rows, changed_pairs: changed, changed_pairs_applied: changedApplied,
      groups_all: groupsAll, groups_applied: groupsApplied, groups_used: baseN,
    },
    counts: base,
    counts_applied: counts.applied,
    counts_all_changed: counts.all,
    rates,
    inject_mix: injectMix,
  };
  return artifact;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const OUT = argOf("--out", path.join(ART, "error-priors-v0.json"));
  const explicit = process.argv.reduce((acc, a, i) =>
    (process.argv[i - 1] === "--in" ? acc.concat({ file: a, schema: "corpus" }) : acc), []);
  const artifact = buildErrorPriors({ sources: explicit.length ? explicit : RECORDING_SOURCES,
    allChanged: hasFlag("--all-changed") });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  const { sources: perSource, rates, inject_mix: injectMix, counts_all_changed: all, counts_applied: applied } = artifact;
  const { rows, changed_pairs: changed, changed_pairs_applied: changedApplied,
    groups_all: groupsAll, groups_applied: groupsApplied } = artifact.totals;
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log("\nError-class priors  (v0-recorded-pairs-only)");
  console.log("=".repeat(74));
  for (const s of perSource) {
    console.log(`  ${pad(s.file, 38)} ${num(s.rows, 6)} rows  ${num(s.changed_pairs, 5)} changed  ${num(s.changed_applied, 5)} applied`);
  }
  console.log("-".repeat(74));
  console.log(`  ${pad("TOTAL", 38)} ${num(rows, 6)} rows  ${num(changed, 5)} changed  ${num(changedApplied, 5)} applied`);
  console.log(`\n  classified edit groups: ${groupsApplied} applied / ${groupsAll} all-changed\n`);
  console.log(`  ${pad("class", 24)}${num("applied", 9)}${num("rate", 9)}${num("inject", 9)}${num("all", 9)}`);
  console.log("  " + "-".repeat(58));
  for (const t of ERROR_TYPES) {
    const inj = INJECTABLE_TYPES.includes(t) ? (injectMix[t] * 100).toFixed(1) + "%" : "—";
    console.log(`  ${pad(t, 24)}${num(applied[t], 9)}${num((rates[t] * 100).toFixed(1) + "%", 9)}${num(inj, 9)}${num(all[t], 9)}`);
  }
  console.log("\n  ITE integration is PHASE 2 — this prior sees model-found errors only.");
  console.log(`  written to ${OUT}\n`);
}
