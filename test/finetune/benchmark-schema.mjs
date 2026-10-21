// The benchmark record contract — proofer-benchmark/v1.
//
// Every Phase 0 instrument imports this shared schema rather than restating
// its shapes, so split and scoring rules stay consistent. Historical study
// references are explained in README.md#historical-references.
//
// Design decisions bound here:
// - Offsets are UTF-16 code units, half-open [start, end), because the
//   implementation language is JavaScript. Every span also carries its exact
//   source substring, and validation REJECTS a record whose slice disagrees —
//   an offset that cannot be checked is an assertion nobody checked.
// - `requirement` distinguishes required-correction from benign-optional at
//   the edit-group level (rubric dated 2026-08-10): without it,
//   clean-edit pressure and recall are not separately computable.
// - Two reweighting profiles, named: `benchmark-standard-v1` is STANDARDIZED
//   (fixed register weights x the measured owner clean prior), not a
//   deployment estimate; `owner-discord-random-v1` is the only slice that may
//   be called a deployment estimate (probability-sampled owner messages).
// - Candidate identity for adjudication dedup: for a fixed input sentence,
//   the output string determines the edit set, so the signature is a hash of
//   the normalized output — no diff machinery needed, no drift possible.
// - Normalization for output comparison is NFC + CRLF->LF ONLY. Case,
//   punctuation, apostrophe style and whitespace are supervision differences
//   and must NOT be normalized away.

import { createHash } from "crypto";

export const SCHEMA_VERSION = "proofer-benchmark/v1";

export const REGISTERS = Object.freeze([
  "chat-owner", "chat-irc", "email-workplace", "forum-comments",
]);

// benchmark-standard-v1: standardized register weights (Sol Q1.5) and the
// measured owner clean prior (random holdout: 14 errors in 500 -> 97.2%).
export const PROFILES = Object.freeze({
  "benchmark-standard-v1": Object.freeze({
    registerWeights: Object.freeze({
      "chat-owner": 0.30, "chat-irc": 0.25,
      "email-workplace": 0.25, "forum-comments": 0.20,
    }),
    cleanPrior: 0.972,
    kind: "standardized",
  }),
  "owner-discord-random-v1": Object.freeze({
    registerWeights: Object.freeze({ "chat-owner": 1 }),
    cleanPrior: 0.972,
    kind: "deployment-estimate",
    // Named restriction a scorer implements in code (frame === "random" AND
    // register === "chat-owner"); a JS-expression string here could only be
    // mirrored, never executed, and mirrors drift.
    restriction: "owner-random",
  }),
});

// The measured error taxonomy. `primary` on a record is exactly
// one of these; multi-error records carry secondaries on their edit groups.
export const ERROR_TYPES = Object.freeze([
  "transposition", "adjacent-key", "moved-space", "doubled-word",
  "held-shift-stutter", "semicolon-apostrophe", "dropped-apostrophe",
  "homophone-confusable", "run-together", "terminator", "casing",
  "agreement", "other-natural",
]);

export const PHENOMENA = Object.freeze([
  "ordinary", "names", "numbers", "negation", "urls", "code-tokens",
  "emoji", "instruction-like", "fragments", "multi-error",
  "segmenter-produced",
]);

export const FRAMES = Object.freeze([
  "random", "natural-screen", "injected", "hard-negative",
]);

export const SPLITS = Object.freeze(["dev", "sealed"]);

export const REQUIREMENTS = Object.freeze([
  "required-correction", "benign-optional",
]);

// Judge/adjudication verdict classes.
export const VERDICTS = Object.freeze([
  "required-correction", "benign-optional", "unnecessary",
  "meaning-damage", "uncertain",
]);

// Credits an acceptable output can carry — deliberately DISTINCT from
// VERDICTS: an acceptable output is the unchanged input ("no-op"), the
// required correction, or a benign variant; the other verdict classes
// cannot be "acceptable" by definition. Added 2026-08-20 after both
// builder agents independently hit the gap and diverged (one credited
// no-ops "required-correction", the other "benign-optional") — exactly the
// drift a split vocabulary exists to stop.
export const CREDITS = Object.freeze([
  "no-op", "required-correction", "benign-optional",
]);

/** The ONLY normalization applied before output comparison. */
export function normalizeOut(s) {
  return String(s).normalize("NFC").replace(/\r\n/g, "\n");
}

/**
 * Canonical candidate identity for the blinded-adjudication ledger: dedup by
 * (uid, candidateSignature) across models, seeds and reruns. For a fixed
 * input, output-string equality is edit-set equality.
 */
export function candidateSignature(uid, rewritten) {
  return "sha256:" + createHash("sha256")
    .update("proofer-cand/v1\0" + uid + "\0" + normalizeOut(rewritten))
    .digest("hex");
}

/** Stable uid for a benchmark record: hash of the exact input sentence plus
 *  its source document, so a re-sample of the same sentence collides loudly
 *  and a changed sentence changes identity (same doctrine as uidFor in
 *  discord-source.mjs). */
export function benchmarkUid(sourceDocumentId, sentence) {
  return "sha256:" + createHash("sha256")
    .update("proofer-bench/v1\0" + sourceDocumentId + "\0" + sentence)
    .digest("hex").slice(0, 24);
}

const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === "string" && v.length > 0;

/**
 * Validate one benchmark record. Returns an array of problem strings —
 * empty means valid. Loaders must REFUSE files containing any problem.
 */
export function validateRecord(r) {
  const p = [];
  if (r?.schema_version !== SCHEMA_VERSION) p.push("schema_version");
  if (!isStr(r?.benchmark_version)) p.push("benchmark_version");
  if (!isStr(r?.uid)) p.push("uid");
  if (!isStr(r?.sentence)) p.push("sentence");
  if (typeof r?.context_2500 !== "string") p.push("context_2500");
  if (!SPLITS.includes(r?.split)) p.push("split");
  const src = r?.source;
  if (!src) p.push("source");
  else {
    if (!REGISTERS.includes(src.register)) p.push("source.register");
    if (!isStr(src.source_document_id)) p.push("source.source_document_id");
    if (!isStr(src.exclusion_group_id)) p.push("source.exclusion_group_id");
  }
  const samp = r?.sampling;
  if (!samp) p.push("sampling");
  else {
    if (!FRAMES.includes(samp.frame)) p.push("sampling.frame");
    if (!PHENOMENA.includes(samp.primary_phenomenon)) p.push("sampling.primary_phenomenon");
    if (!Array.isArray(samp.phenomena)
      || samp.phenomena.some((x) => !PHENOMENA.includes(x))) p.push("sampling.phenomena");
  }
  const label = r?.label;
  if (!label) { p.push("label"); return p; }
  if (!["CLEAN", "ERROR"].includes(label.input_status)) p.push("label.input_status");
  if (typeof label.borderline !== "boolean") p.push("label.borderline");
  const groups = label.edit_groups ?? [];
  if (!Array.isArray(groups)) p.push("label.edit_groups");
  else {
    const ids = new Set();
    for (const g of groups) {
      const tag = `edit_group ${g?.id ?? "?"}`;
      if (!isStr(g?.id) || ids.has(g.id)) p.push(`${tag}: id`);
      ids.add(g?.id);
      if (!isInt(g?.start_utf16) || !isInt(g?.end_utf16)
        || g.start_utf16 < 0 || g.end_utf16 < g.start_utf16
        || g.end_utf16 > r.sentence.length) p.push(`${tag}: span bounds`);
      else if (r.sentence.slice(g.start_utf16, g.end_utf16) !== g.before)
        p.push(`${tag}: slice(${g.start_utf16},${g.end_utf16}) !== before`);
      if (!REQUIREMENTS.includes(g?.requirement)) p.push(`${tag}: requirement`);
      if (g.requirement === "required-correction"
        && !ERROR_TYPES.includes(g?.error_type)) p.push(`${tag}: error_type`);
      if (!Array.isArray(g?.alternatives) || !g.alternatives.length)
        p.push(`${tag}: alternatives (need >=1, the primary replacement)`);
    }
    // Groups must be in ascending source order and non-overlapping, or
    // applying/materializing them is undefined (both consumers enforced
    // this at runtime; the contract owns it now).
    let prevG = null;
    for (const g of groups) {
      if (prevG && isInt(g?.start_utf16) && isInt(prevG?.end_utf16)
        && g.start_utf16 < prevG.end_utf16)
        p.push(`edit_group ${g?.id}: overlaps or out of order vs ${prevG.id}`);
      prevG = g;
    }
  }
  const required = groups.filter?.((g) => g?.requirement === "required-correction") ?? [];
  if (label.input_status === "ERROR" && required.length === 0)
    p.push("ERROR record with no required-correction group");
  if (label.input_status === "CLEAN" && required.length > 0)
    p.push("CLEAN record with a required-correction group");
  const acc = label.acceptable_outputs;
  if (!Array.isArray(acc) || !acc.length) p.push("label.acceptable_outputs");
  else for (const a of acc) {
    if (!isStr(a?.id)) p.push("acceptable_outputs id");
    if (!isStr(a?.rewritten)) p.push(`acceptable_outputs ${a?.id}: rewritten`);
    if (!CREDITS.includes(a?.credit)) p.push(`acceptable_outputs ${a?.id}: credit`);
    if (a?.credit === "no-op" && isStr(a?.rewritten)
      && normalizeOut(a.rewritten) !== normalizeOut(r.sentence))
      p.push(`acceptable_outputs ${a?.id}: credit "no-op" on an output that differs from the input`);
    if (a?.credit === "no-op" && label.input_status === "ERROR")
      p.push(`acceptable_outputs ${a?.id}: an ERROR record cannot accept a no-op — that reclassifies a miss as clean-untouched`);
  }
  if (label.input_status === "CLEAN") {
    const noop = Array.isArray(acc)
      ? acc.find((a) => isStr(a?.rewritten)
        && normalizeOut(a.rewritten) === normalizeOut(r.sentence)) : null;
    if (!noop) p.push("CLEAN record must list the input itself as an acceptable no-op");
    else if (noop.credit !== "no-op")
      p.push('the no-op acceptable output must carry credit "no-op"');
  }
  // R8's hard gate reads these; an unvalidated probe is an assertion nobody
  // checked (scorer agent's proposal, adopted).
  const asrt = label.assertions;
  if (asrt) {
    const sigs = Array.isArray(asrt.obedience_signatures) ? asrt.obedience_signatures : [];
    const mp = Array.isArray(asrt.must_preserve) ? asrt.must_preserve : [];
    if (asrt.injection_probe === true && !sigs.length && !mp.length)
      p.push("injection probe carries neither obedience_signatures nor must_preserve");
    for (const s of sigs) if (isStr(s) && r.sentence.includes(s))
      p.push("an obedience signature occurs in the input — the probe would always fire");
    for (const s of mp) if (isStr(s) && !r.sentence.includes(s))
      p.push("a must_preserve string is absent from the input");
  }
  return p;
}

/**
 * Cross-record checks over a whole benchmark file. Returns problems array.
 */
export function validateFile(records) {
  const p = [];
  const uids = new Set();
  const bySplit = { dev: 0, sealed: 0 };
  const versions = new Set();
  for (const r of records) {
    if (uids.has(r.uid)) p.push(`duplicate uid ${r.uid}`);
    uids.add(r.uid);
    bySplit[r.split] = (bySplit[r.split] ?? 0) + 1;
    versions.add(r.benchmark_version);
  }
  if (versions.size > 1) p.push(`mixed benchmark_version: ${[...versions].join(", ")}`);
  if (!bySplit.dev || !bySplit.sealed) p.push("a split is empty");
  // A sealed/dev split must partition exclusion groups, not sentences:
  // the same conversation episode on both sides leaks the sealed set.
  const groupSplit = new Map();
  for (const r of records) {
    const g = r.source?.exclusion_group_id;
    if (!g) continue;
    if (groupSplit.has(g) && groupSplit.get(g) !== r.split)
      p.push(`exclusion group ${g} spans both splits`);
    groupSplit.set(g, r.split);
  }
  // The bootstrap resamples groups WITHIN a register stratum; a group that
  // spans registers silently breaks the pairing (scorer agent's proposal).
  const groupReg = new Map();
  for (const r of records) {
    const g = r.source?.exclusion_group_id;
    if (!g) continue;
    if (groupReg.has(g) && groupReg.get(g) !== r.source?.register)
      p.push(`exclusion group ${g} spans registers`);
    groupReg.set(g, r.source?.register);
  }
  return p;
}

/** Enumerate the acceptable outputs of a record as [{id, credit, out}] with
 *  normalized text, for scorers and adjudication-queue construction. */
export function acceptableSet(record) {
  return (record.label.acceptable_outputs ?? []).map((a) => ({
    id: a.id, credit: a.credit, out: normalizeOut(a.rewritten),
  }));
}
