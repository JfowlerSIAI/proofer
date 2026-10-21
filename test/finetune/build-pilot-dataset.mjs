#!/usr/bin/env node
// The Phase 1 pilot dataset generator (plan §6.3 mixture, §7.1 scale).
//
//   node build-pilot-dataset.mjs --stage pool     [--target 6000] [--seed N]
//   node build-pilot-dataset.mjs --stage assemble --teacher <f> [--judge <f>]
//
// TWO STAGES WITH FILES BETWEEN THEM, because the middle of this pipeline is
// two model passes that are the OWNER'S to schedule (R10) and that this tool
// must never make itself. `pool` draws candidate sentences by the §6.3 mixture
// arithmetic and writes a teacher-pass input file; `assemble` consumes the
// teacher's results and the judge's verdicts and writes the dataset. Nothing
// here opens a socket.
//
// WHAT DECIDES WHAT
//   * screens + dictionary (natural-screens.mjs)  — which sentences are
//     candidates for which slot. Lexical, offline, no model.
//   * the TEACHER                                 — whether a screened-clean
//     sentence is really clean (an identity needs `outcome === "no-op"`), and
//     what the correction is when it is not.
//   * the shipping GUARD CHAIN                    — already run per row by
//     teacher-pass.mjs and read off the row; a refused correction never becomes
//     a target.
//   * the JUDGE                                   — per edit group, via
//     verdicts.mjs. D1: `required-correction` and `benign-optional` survive;
//     everything else REVERTS that group to the source text (`applyGroups`).
//     A changed teacher target with no verdict is a hard failure, not a guess.
//
// Judge policy (§3/§6.3 as amended): every CHANGED teacher target is judged.
// Identities are NOT judged per example — they need the screens plus the
// teacher-clean check — and the stratified 10% clean-check sample plus every
// hard negative is emitted as its own file for a separate later pass.
//
// LEAKAGE (§7.2). Clusters are normalized 5-gram Jaccard >= 0.8 and are
// computed at the POOL stage, before any variant exists: an injected pair and
// its clean parent share a cluster by construction, so no augmentation can
// straddle the train/validation line. Whole clusters are assigned, stratified
// by register. Every reservation manifest and every holdout id is asserted
// absent — a single overlap exits 1.
//
// The Stack Exchange pool is NEVER touched here: CC BY-SA, benchmark only, and
// its own pool function refuses any other stated purpose.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { ircPool, enronPool, targetsFromUnit, dictionaryRatioReject } from "./corpus-pools.mjs";
import { screen, screenScore, TAG_TO_ERROR_TYPE, damerau1Words } from "./natural-screens.mjs";
import { inject, applicableTypes, restore, INJECT_VERSION, INJECTABLE_TYPES } from "./error-inject.mjs";
import { editGroups, applyGroups } from "./edit-groups.mjs";
import { isWord } from "../lib/sentence-guards.mjs";
import {
  readJsonl, readJsonlIfPresent, writeJsonl, argOf, hasFlag, fail,
  mulberry32, shuffled, isKeepVerdict, VERDICT_SET,
} from "./verdicts.mjs";
import { CONTEXT_WINDOW_MS } from "../harvested/discord-source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");

// The provisional context window (§7.1). Flag-tunable because it is provisional.
export const DEFAULT_WINDOW = 500;

// Slot shares. Ranges are §6.3's; these are the midpoints it starts from, and
// every one is a flag so an ablation is a command line rather than an edit.
export const DEFAULTS = Object.freeze({
  identityShare: 0.67,      // §6.3: 60-75%
  hardNegShare: 0.32,       // §6.3: 25-40% OF the identity slot
  realShare: 0.45,          // of correction-bearing; the rest is injected
  ownerShare: 0.25,         // S1's share of correction-bearing (§6.2 table)
  echoShare: 0.10,          // context containing already-corrected sentences
  validationShare: 0.15,    // §7.2: 10-20%
  // Over-draw factors: what fraction of a drawn candidate is expected to
  // SURVIVE its slot's gate. Measured on the 2026-08-22 pilot assembly
  // (11,094 draws), replacing the pre-pilot estimates in the trailing
  // comments — an under-draw is a smaller dataset, not a wrong one.
  yieldIdentity: 0.68,      // screened-clean AND teacher says no-op (est. 0.85)
  // Certified hard negatives (teacher edited, judge reverted every group) are
  // 6% of tempting draws, not the 30% estimated — the teacher declines to edit
  // tempting-but-clean sentences far more than assumed. The other 77% of a
  // tempting draw is NOT waste: 54% comes back a teacher-clean identity (the
  // tempting-shaped identity §6.3's enrichment is for; assemble routes it into
  // the identity slot, mechanism-tagged) and 23% a kept real error. But a plan
  // that sizes the certified slot off this number must look at the printed
  // teacherCalls before running: hardNeg/0.06 is a 5x draw.
  yieldHardNeg: 0.06,       // (est. 0.30; total useful yield of a tempting draw 0.83)
  yieldReal: 0.44,          // screen hit -> teacher corrects -> guards -> judge keeps (est. 0.40)
  yieldInjected: 0.81,      // teacher recovers the injected truth, guards pass (est. 0.80)
});

const REGISTER_OF = { s1: "chat-owner", s2: "chat-irc", s3: "email-workplace" };
const LICENSE_OF = {
  s1: "owner's own (S1, scrubbed; local only)",
  s2: "Public Domain (common-pile/ubuntu_irc_filtered)",
  s3: "public record, no formal dedication — owner-accepted risk (§6.2)",
};

// =====================================================================
// Reservations and holdouts — the leakage denominator
// =====================================================================

export const RESERVATION_FILES = Object.freeze([
  "benchmark-reserved-message-ids.json",
  "benchmark-reserved-ids-irc.json",
  "benchmark-reserved-ids-enron.json",
  "benchmark-reserved-ids-se.json",
]);

/** Every reserved source-document id, plus every holdout message id. */
export function loadExcluded(artDir = ART, harvestDir = path.join(ART, "..")) {
  const ids = new Set();
  const provenance = [];
  for (const f of RESERVATION_FILES) {
    const p = path.join(artDir, f);
    if (!fs.existsSync(p)) {
      fail(`missing reservation manifest ${p}\n`
        + "  Every reserved id is EXCLUDED from training sampling. A manifest that is\n"
        + "  merely absent would silently widen the training set into the benchmark.");
    }
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    const list = d.message_ids || [];
    for (const id of list) ids.add(String(id));
    provenance.push({ file: f, register: d.register, episodes: d.episodes, ids: list.length });
  }
  // The private holdouts. `scrub-discord.mjs` already excluded them from S1;
  // asserted again here because "already excluded upstream" is a claim, and the
  // cost of checking it is a set union.
  for (const f of ["bench-error-holdout-run.jsonl", "bench-random-holdout-run.jsonl"]) {
    const p = path.join(harvestDir, f);
    if (!fs.existsSync(p)) continue;   // the holdouts are gitignored owner data
    let n = 0;
    for (const r of readJsonl(p, "holdout")) if (r.message_id) { ids.add(String(r.message_id)); n++; }
    provenance.push({ file: f, register: "chat-owner", holdout: true, ids: n });
  }
  return { ids, provenance };
}

/**
 * The leakage gate. Hard failure on any overlap — never a warning, never a
 * filter: a record that reached this point through a reserved id means the
 * exclusion upstream did not run, and dropping the row would hide that.
 */
export function assertNoLeak(records, excluded) {
  const hits = [];
  for (const r of records) {
    const sd = r?.lineage?.source_document_id;
    if (sd == null) continue;
    // IRC/Enron ids are `<prefix>:<doc>#<msg>`; the manifests reserve the same
    // shape, so an exact match is the test. The owner corpus reserves bare
    // message ids, which is what `source_document_id` is there.
    if (excluded.has(String(sd))) hits.push({ uid: r.uid, source_document_id: sd });
  }
  return hits;
}

// =====================================================================
// S1 — the scrubbed owner corpus
// =====================================================================

export const S1_FILE = path.join(ART, "s1-scrubbed.jsonl");

/**
 * The S1 training pool, in the same `{items, episodes, corpus}` shape the other
 * registers return. Built from the FINAL scrubbed jsonl rather than from the
 * raw export: the scrub is what removed the entities, the benchmark episodes
 * and the holdouts, and reading around it would undo all three.
 *
 * Episodes are same-channel chains with pairwise gaps <= CONTEXT_WINDOW_MS —
 * the same rule `ownerPool` uses, so an episode stays a superset of every
 * context window built inside it and the reservation unit still means what the
 * manifest says it means.
 */
export function s1Pool(file = S1_FILE) {
  if (!fs.existsSync(file)) {
    fail(`missing ${file} — run scrub-discord.mjs first (§12).`);
  }
  const msgs = readJsonl(file, "s1-scrubbed")
    .filter((m) => m && typeof m.content === "string" && m.content.trim());
  if (!msgs.length) fail("S1 pool: 0 messages with content");
  const byChannel = new Map();
  for (const m of msgs) {
    const key = `${m.server_pseudo}/${m.channel_pseudo}`;
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key).push(m);
  }
  const items = [], episodes = new Map();
  for (const [key, list] of byChannel) {
    list.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    const chan = createHash("sha1").update(key).digest("hex").slice(0, 8);
    let idx = 0, prev = null;
    let prior = [];
    for (const m of list) {
      if (prev !== null && (m.ts ?? 0) - prev > CONTEXT_WINDOW_MS) { idx++; prior = []; }
      prev = m.ts ?? 0;
      const gid = `owner:${chan}#${idx}`;
      const sdid = String(m.message_id);
      for (const t of targetsFromUnit(m.content, prior.join("\n"),
        { source_document_id: sdid, exclusion_group_id: gid })) items.push(t);
      prior.push(m.content);
      if (prior.length > 60) prior.shift();
      if (!episodes.has(gid)) episodes.set(gid, []);
      episodes.get(gid).push(sdid);
    }
  }
  if (!items.length) fail("S1 pool produced 0 sentence targets");
  return { items, episodes, corpus: "owner-discord-scrubbed" };
}

// =====================================================================
// Screens: which slot can a sentence serve?
// =====================================================================

// A tag that implies a NON-WORD is present. These are the real-error screens;
// the other two (`licensedConfusableSuspect`, `segmenterEdge`) fire on ordinary
// English and are what makes a sentence TEMPTING rather than wrong.
export const STRONG_TAGS = Object.freeze([
  "uniqueDamerau1", "movedSpaceRepair", "doubledToken", "heldShift",
  "semicolonApostrophe", "contractionError",
]);

export function slotFor(sentence) {
  const tags = screen(sentence);
  const strong = tags.filter((t) => STRONG_TAGS.includes(t));
  if (strong.length) return { slot: "real-error", tags, strong, score: screenScore(tags) };
  if (dictionaryRatioReject(sentence)) return { slot: null, tags, strong, score: 0 };
  return { slot: "clean", tags, strong, score: screenScore(tags) };
}

/**
 * How TEMPTING a screened-clean sentence is — the hard-negative ranking (§6.3:
 * "valid-but-rare words, names, slang, jargon one edit from a dictionary word;
 * numbers/casing/quotation shapes that tempt normalization").
 *
 * A hard negative is a CANDIDATE here and a hard negative only if the teacher
 * wanted to edit it and the judge said it was unnecessary. This function
 * decides what to spend a teacher call on, nothing more.
 */
export function temptScore(sentence, tags = null, opts = {}) {
  const s = String(sentence ?? "");
  const useDictionary = opts.dictionary !== false;
  let n = 0;
  const toks = s.split(/\s+/).filter(Boolean);
  for (const raw of toks) {
    const t = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!t) continue;
    // A capitalised token no dictionary holds: a name, mid-sentence.
    if (/^[A-Z][a-z]+$/.test(t) && !isWord(t.toLowerCase())) n += 4;
    // ALL-CAPS: initialism or held shift — the shape the guards refuse over.
    if (/^[A-Z]{2,}$/.test(t)) n += 3;
    // Digits and mixed alphanumerics tempt normalisation.
    if (/\d/.test(t)) n += 2;
    // A valid but rare word sitting one edit from a commoner one. This is the
    // ONLY expensive clause — `damerau1Words` allocates ~50L+26 candidate
    // strings per token — so it is skippable, and the pool stage ranks the whole
    // clean bucket without it and refines only the head. Measured: with it on
    // all 476,240 clean sentences the stage did not finish in 30 minutes.
    if (useDictionary && /^[a-z]{4,9}$/.test(t) && isWord(t) && damerau1Words(t).size > 0) n += 1;
  }
  if (/["'“”‘’]/.test(s)) n += 1;
  // The caller has usually already screened this sentence; re-screening it here
  // is the same dictionary enumeration a second time.
  if ((tags ?? screen(s)).includes("licensedConfusableSuspect")) n += 1;
  return n;
}

// =====================================================================
// Clustering (§7.2) — normalized 5-gram Jaccard >= 0.8
// =====================================================================

export const SHINGLE_N = 5;
export const JACCARD_MIN = 0.8;

export function shingles(sentence, n = SHINGLE_N) {
  const toks = String(sentence ?? "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const out = new Set();
  if (toks.length < n) { out.add(toks.join(" ")); return out; }
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(" "));
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Union-find clusters over 5-gram Jaccard >= 0.8, with an inverted shingle
 * index so the comparison is against candidates that share at least one
 * shingle rather than against everything (two sentences with no shared shingle
 * cannot reach 0.8 unless both are empty).
 *
 * @returns {number[]} cluster id per input index
 */
export function clusterSentences(sentences) {
  const sets = sentences.map((s) => shingles(s));
  const parent = sentences.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };

  const index = new Map();
  for (let i = 0; i < sets.length; i++) {
    const seen = new Set();
    for (const sh of sets[i]) {
      const bucket = index.get(sh);
      if (bucket) for (const j of bucket) seen.add(j);
      if (!bucket) index.set(sh, [i]); else bucket.push(i);
    }
    for (const j of seen) {
      if (find(i) === find(j)) continue;
      if (jaccard(sets[i], sets[j]) >= JACCARD_MIN) union(i, j);
    }
  }
  const canon = new Map();
  return sentences.map((_, i) => {
    const r = find(i);
    if (!canon.has(r)) canon.set(r, canon.size);
    return canon.get(r);
  });
}

/**
 * Whole clusters to train/validation, stratified by register, greedy on the
 * running deficit. Atomic by construction: the unit assigned is the cluster,
 * so a variant can never land opposite its parent.
 */
export function assignSplits(rows, validationShare, rnd) {
  const byCluster = new Map();
  for (const r of rows) {
    if (!byCluster.has(r.cluster)) byCluster.set(r.cluster, []);
    byCluster.get(r.cluster).push(r);
  }
  const clusters = shuffled([...byCluster.keys()], rnd);
  const want = new Map(), got = new Map(), total = new Map();
  for (const r of rows) total.set(r.register, (total.get(r.register) ?? 0) + 1);
  for (const [reg, n] of total) { want.set(reg, n * validationShare); got.set(reg, 0); }
  const split = new Map();
  for (const c of clusters) {
    const members = byCluster.get(c);
    // A cluster goes to validation when its dominant register is still short.
    const reg = members[0].register;
    const toVal = (got.get(reg) ?? 0) + members.length <= (want.get(reg) ?? 0);
    split.set(c, toVal ? "validation" : "train");
    if (toVal) for (const m of members) got.set(m.register, (got.get(m.register) ?? 0) + 1);
  }
  return split;
}

// =====================================================================
// Mixture arithmetic (§6.3)
// =====================================================================

/**
 * The slot counts for one target size, and the number of TEACHER CALLS each
 * slot needs at its expected yield. Pure arithmetic, so the test can pin it.
 */
export function mixturePlan(target, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const identity = Math.round(target * o.identityShare);
  const correction = target - identity;
  const hardNeg = Math.round(identity * o.hardNegShare);
  const plainIdentity = identity - hardNeg;
  const real = Math.round(correction * o.realShare);
  const injected = correction - real;
  const ownerReal = Math.round(real * o.ownerShare);
  const slots = {
    "identity": plainIdentity,
    "hard-negative": hardNeg,
    "real-error": real,
    "injected": injected,
  };
  const draw = {
    "identity": Math.ceil(plainIdentity / o.yieldIdentity),
    "hard-negative": Math.ceil(hardNeg / o.yieldHardNeg),
    "real-error": Math.ceil(real / o.yieldReal),
    "injected": Math.ceil(injected / o.yieldInjected),
  };
  const teacherCalls = Object.values(draw).reduce((s, n) => s + n, 0);
  return {
    target, shares: o, slots, draw, teacherCalls,
    identity, correction, ownerReal,
    checksum: plainIdentity + hardNeg + real + injected,
  };
}

/** Per-class injection counts from the v0 prior, largest-remainder so they sum. */
export function injectionCounts(total, mix) {
  const types = INJECTABLE_TYPES.filter((t) => (mix[t] ?? 0) > 0);
  if (!types.length) fail("the error prior has no injectable class with a positive rate");
  const exact = types.map((t) => ({ t, v: total * mix[t] }));
  const out = {};
  let used = 0;
  for (const e of exact) { out[e.t] = Math.floor(e.v); used += out[e.t]; }
  exact.sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)));
  for (let i = 0; used < total; i++, used++) out[exact[i % exact.length].t]++;
  return out;
}

// =====================================================================
// Records
// =====================================================================

/**
 * The example id. The SEGMENT is part of the key, not decoration: one message
 * can contain the same sentence twice ("ok." twice, a repeated line), and
 * keying on text alone collided — teacher-pass.mjs drops a repeated uid, so the
 * draw would have shrunk silently between the two stages.
 */
export function pilotUid(lineage, variant) {
  const seg = Array.isArray(lineage.segment) ? lineage.segment.join("-") : "";
  return "pl_" + createHash("sha256")
    .update(`pilot/v1\0${lineage.source_document_id}\0${seg}\0${lineage.sentence}\0${variant}`)
    .digest("hex").slice(0, 16);
}

/**
 * Splice an already-corrected sentence into a context, which is what the model
 * sees at runtime once its own applies are behind the caret (§6.3's echo risk).
 * Returns the context unchanged, and says so, when the source sentence is not
 * in it — an echo that silently did not happen must not be labelled as one.
 */
export function echoContext(context, sourceSentence, correctedSentence) {
  const ctx = String(context ?? "");
  const i = ctx.lastIndexOf(sourceSentence);
  if (!sourceSentence || i < 0 || sourceSentence === correctedSentence) {
    return { context: ctx, echoed: false };
  }
  return {
    context: ctx.slice(0, i) + correctedSentence + ctx.slice(i + sourceSentence.length),
    echoed: true,
  };
}

/**
 * The D1 target: keep the groups the judge kept, revert the rest to the source
 * text. A reverted group restores the SOURCE bytes exactly, which is what
 * `applyGroups` guarantees and what the test pins.
 *
 * @returns {{target: string, kept: number[], reverted: number[], allReverted: boolean}}
 */
export function applyVerdicts(source, corrected, verdicts) {
  const groups = editGroups(source, corrected);
  const byId = new Map();
  for (const v of verdicts ?? []) {
    if (!VERDICT_SET.has(v.verdict)) {
      throw new Error(`unknown judge verdict ${JSON.stringify(v.verdict)} — verdicts.mjs owns the vocabulary`);
    }
    byId.set(v.group, v.verdict);
  }
  const kept = [], reverted = [];
  for (const g of groups) {
    const v = byId.get(g.id);
    if (v === undefined) {
      // THROWS rather than exits: this is a library function, and a gate that
      // calls process.exit cannot be shown to fire. The CLI turns it into a
      // fatal below.
      throw new Error(`edit group ${g.id} has no verdict. A changed target with an `
        + "unjudged group is not assemblable — §3 requires a verdict per group, and "
        + "guessing one is the one thing this stage must never do.");
    }
    (isKeepVerdict(v) ? kept : reverted).push(g.id);
  }
  return {
    target: applyGroups(source, groups, kept),
    kept, reverted, groups: groups.length,
    allReverted: groups.length > 0 && kept.length === 0,
  };
}

// =====================================================================
// STAGE: pool
// =====================================================================

function drawFrom(candidates, n, rnd) {
  return shuffled(candidates, rnd).slice(0, n);
}

async function stagePool(cfg) {
  const rnd = mulberry32(cfg.seed);
  const excluded = loadExcluded();

  const priorPath = cfg.priors;
  if (!fs.existsSync(priorPath)) {
    fail(`missing ${priorPath} — run: node error-priors.mjs`);
  }
  const priors = JSON.parse(fs.readFileSync(priorPath, "utf8"));
  if (!priors.inject_mix) fail(`${priorPath} has no inject_mix`);

  const plan = mixturePlan(cfg.target, cfg.shares);

  // ---- pools
  const phase = (m) => process.stderr.write(`  [${new Date().toISOString().slice(11, 19)}] ${m}\n`);
  const pools = [];
  const wanted = new Set(cfg.sources);
  phase("building source pools (streams the whole IRC corpus and the Enron maildir)");
  if (wanted.has("s1")) pools.push({ key: "s1", ...s1Pool() });
  if (wanted.has("s2")) pools.push({ key: "s2", ...(await ircPool()) });
  if (wanted.has("s3")) pools.push({ key: "s3", ...enronPool() });
  if (!pools.length) fail("--sources selected no pool");
  phase(`pools built: ${pools.map((p) => `${p.key}=${p.items.length}`).join(" ")}`);

  // ---- screen every item into a slot, dropping reserved ids as we go
  const buckets = { clean: [], "real-error": [] };
  const funnel = [];
  let reservedDropped = 0;
  for (const p of pools) {
    let kept = 0;
    for (const it of p.items) {
      if (excluded.ids.has(String(it.source_document_id))) { reservedDropped++; continue; }
      const s = slotFor(it.sentence);
      if (!s.slot) continue;
      kept++;
      // The pool item is REFERENCED, not spread: each one carries its own 2,500
      // character production context, so copying the whole corpus into a second
      // set of objects is a gigabyte of heap for nothing.
      it.source = p.key; it.register = REGISTER_OF[p.key];
      it.tags = s.tags; it.strong = s.strong; it.score = s.score;
      buckets[s.slot].push(it);
    }
    funnel.push({ source: p.key, corpus: p.corpus, items: p.items.length, screened: kept });
    p.items = null;        // screened rows are referenced from `buckets` now
  }
  phase(`screened: clean=${buckets.clean.length} real-error=${buckets["real-error"].length}`);
  if (!buckets.clean.length) fail("0 screened-clean sentences — the pools produced nothing usable");

  // ---- register mix within each slot, so one backbone cannot dominate
  const byRegister = (list) => {
    const m = new Map();
    for (const x of list) { if (!m.has(x.source)) m.set(x.source, []); m.get(x.source).push(x); }
    return m;
  };
  const share = { s1: cfg.ownerShare, s2: (1 - cfg.ownerShare) * 0.65, s3: (1 - cfg.ownerShare) * 0.35 };
  function drawMixed(list, n, rnd, rank) {
    const m = byRegister(list);
    const out = [];
    for (const [key, xs] of m) {
      const want = Math.round(n * (share[key] ?? 0));
      const pick = rank ? [...xs].sort((a, b) => rank(b) - rank(a)).slice(0, want * 3) : xs;
      out.push(...drawFrom(pick, want, rnd));
    }
    // Backfill from whatever is left if a register was short — a shortfall is
    // reported, never silently a smaller draw in that slot alone.
    if (out.length < n) {
      const have = new Set(out.map((x) => x.source_document_id + " " + x.sentence));
      const rest = list.filter((x) => !have.has(x.source_document_id + " " + x.sentence));
      out.push(...drawFrom(rest, n - out.length, rnd));
    }
    return out.slice(0, n);
  }

  // Disjoint draws out of the clean bucket: identity, hard-negative, injection
  // substrate. Disjoint because the same sentence appearing as both an identity
  // and an injected parent teaches the model to answer two ways.
  const cleanShuffled = shuffled(buckets.clean, rnd);
  // DECORATE, sort, undecorate. `temptScore` runs a Damerau-1 dictionary
  // enumeration per token, so calling it from inside a comparator is O(n log n)
  // of it — measured: the pool stage did not finish in four hours on the real
  // corpora and completes in minutes with the score computed once per item.
  for (const x of cleanShuffled) x.tempt = temptScore(x.sentence, x.tags, { dictionary: false });
  const temptRanked = [...cleanShuffled].sort((a, b) => b.tempt - a.tempt);
  const headN = Math.min(temptRanked.length,
    Math.max(20000, plan.draw["hard-negative"] * 20));
  const head = temptRanked.slice(0, headN);
  for (const x of head) x.tempt = temptScore(x.sentence, x.tags);
  head.sort((a, b) => b.tempt - a.tempt);
  temptRanked.splice(0, headN, ...head);
  const taken = new Set();
  const key = (x) => x.source_document_id + " " + x.sentence;
  const takeFrom = (list, n, rank) => {
    const avail = list.filter((x) => !taken.has(key(x)));
    // A RANKED draw still honours the register mix. Taking the global head is
    // what the first run did and it is wrong: Enron is dense in names and
    // numbers, so it took 3,524 of 4,287 hard negatives and the anti-meddling
    // signal — the single highest-value category in §6.3 — arrived almost
    // entirely in one register. `list` is already sorted, so a per-register
    // head is the same ranking applied inside each share.
    let got;
    if (rank) {
      const need = Object.fromEntries(
        Object.entries(share).map(([k, w]) => [k, Math.round(n * w)]));
      got = [];
      const spill = [];
      for (const x of avail) {                    // `avail` is already ranked
        if ((need[x.source] ?? 0) > 0) { need[x.source]--; got.push(x); }
        else if (spill.length < n) spill.push(x);
        if (got.length >= n) break;
      }
      for (const x of spill) { if (got.length >= n) break; got.push(x); }
      got = got.slice(0, n);
    } else {
      got = drawMixed(avail, n, rnd);
    }
    for (const x of got) taken.add(key(x));
    return got;
  };

  phase("drawing slots");
  const hardNegDraw = takeFrom(temptRanked, plan.draw["hard-negative"], true);
  const identityDraw = takeFrom(cleanShuffled, plan.draw["identity"]);
  const injectSubstrate = takeFrom(cleanShuffled, plan.draw["injected"]);
  const realDraw = drawMixed(
    buckets["real-error"], plan.draw["real-error"], rnd, (x) => x.score);

  // ---- injection at the v0 prior mix
  phase("injecting");
  const injCounts = injectionCounts(injectSubstrate.length, priors.inject_mix);
  const injected = [];
  const injFailed = { total: 0, byClass: {} };
  const remaining = { ...injCounts };
  for (const item of injectSubstrate) {
    const can = applicableTypes(item.sentence);
    // Prefer a class the mix still owes; fall back to any applicable one so a
    // substrate sentence is not wasted, and record the substitution.
    let cls = can.find((t) => (remaining[t] ?? 0) > 0) ?? null;
    let substituted = false;
    if (!cls) { cls = can[0] ?? null; substituted = Boolean(cls); }
    if (!cls) { injFailed.total++; continue; }
    const dmg = inject(cls, item.sentence, rnd);
    if (!dmg) {
      injFailed.total++;
      injFailed.byClass[cls] = (injFailed.byClass[cls] ?? 0) + 1;
      continue;
    }
    if (!substituted) remaining[cls]--;
    injected.push({ item, cls, damaged: dmg.damaged, groups: dmg.groups, substituted });
  }

  // ---- rows
  const rows = [];
  const push = (item, intent, sentence, extra) => {
    const lineage = {
      source_document_id: item.source_document_id,
      exclusion_group_id: item.exclusion_group_id,
      sentence: item.sentence,
      segment: [item.segment_start, item.segment_end],
      segmenter_produced: item.segmenterProduced,
      variant: extra?.variant ?? "identity",
    };
    rows.push({
      uid: pilotUid(lineage, lineage.variant),
      sentence,
      context: String(item.context_2500 ?? "").slice(-cfg.window),
      intent, source: item.source, register: item.register,
      screen_tags: item.tags, lineage, ...extra,
    });
  };
  for (const x of identityDraw) push(x, "identity", x.sentence);
  for (const x of hardNegDraw) push(x, "hard-negative", x.sentence, { tempt: x.tempt });
  for (const x of realDraw) push(x, "real-error", x.sentence,
    { screen_suggested_type: TAG_TO_ERROR_TYPE[x.strong[0]] ?? "other-natural" });
  for (const j of injected) {
    push(j.item, "injected", j.damaged, {
      variant: `injected:${j.cls}`,
      inject: {
        version: INJECT_VERSION, class: j.cls, clean: j.item.sentence,
        groups: j.groups, class_substituted: j.substituted,
      },
    });
  }

  // ---- clusters BEFORE variants: an injected row clusters on its CLEAN parent,
  // so the pair cannot straddle the train/validation line.
  phase(`clustering ${rows.length} rows`);
  const clusterKeys = rows.map((r) => r.inject ? r.inject.clean : r.sentence);
  const clusters = clusterSentences(clusterKeys);
  rows.forEach((r, i) => { r.cluster = clusters[i]; });
  const split = assignSplits(rows, cfg.validationShare, mulberry32(cfg.seed ^ 0x5f5f));
  for (const r of rows) r.split = split.get(r.cluster);

  // ---- echo pairing: a row whose context contains ANOTHER DRAWN row's source
  // sentence, where that other row is correction-bearing. At assemble the
  // leader's TARGET replaces its source text in this row's context.
  const byGroup = new Map();
  for (const r of rows) {
    if (!byGroup.has(r.lineage.exclusion_group_id)) byGroup.set(r.lineage.exclusion_group_id, []);
    byGroup.get(r.lineage.exclusion_group_id).push(r);
  }
  const wantEcho = Math.round(rows.length * cfg.echoShare);
  let echoed = 0;
  for (const r of shuffled(rows, mulberry32(cfg.seed ^ 0xecc0))) {
    if (echoed >= wantEcho) break;
    if (r.echo_of) continue;
    const peers = byGroup.get(r.lineage.exclusion_group_id) ?? [];
    const leader = peers.find((p) => p !== r
      && (p.intent === "real-error" || p.intent === "injected")
      && p.split === r.split
      && r.context.includes(p.intent === "injected" ? p.inject.clean : p.sentence));
    if (!leader) continue;
    r.echo_of = leader.uid;
    r.echo_source_text = leader.intent === "injected" ? leader.inject.clean : leader.sentence;
    echoed++;
  }

  // ---- write
  phase("writing");
  // teacher-pass.mjs drops a repeated uid, so a collision here is lost work that
  // reports as a completed pass. Asserted rather than deduped.
  const seenUid = new Set();
  for (const r of rows) {
    if (seenUid.has(r.uid)) {
      fail(`duplicate uid ${r.uid} in the draw — teacher-pass would drop it silently. `
        + "The uid key is (source_document_id, segment, sentence, variant); a collision "
        + "means two drawn rows agree on all four.");
    }
    seenUid.add(r.uid);
  }
  fs.mkdirSync(ART, { recursive: true });
  writeJsonl(cfg.poolOut, rows.map((r) => {
    const { sentence, context, uid, ...rest } = r;
    return { uid, sentence, context, ...rest };   // teacher-pass shape + passthrough
  }));
  const realized = {};
  for (const r of rows) realized[r.intent] = (realized[r.intent] ?? 0) + 1;
  const perSourceKind = {};
  for (const r of rows) {
    const k = `${r.source}/${r.intent}`;
    perSourceKind[k] = (perSourceKind[k] ?? 0) + 1;
  }
  const clusterSizes = new Map();
  for (const r of rows) clusterSizes.set(r.cluster, (clusterSizes.get(r.cluster) ?? 0) + 1);
  const manifest = {
    stage: "pool", generated_at: new Date().toISOString(),
    generated_by: "test/finetune/build-pilot-dataset.mjs",
    seed: cfg.seed, window: cfg.window, target: cfg.target,
    priors: { file: priorPath, version: priors.version, inject_mix: priors.inject_mix },
    plan, funnel, reserved_dropped: reservedDropped,
    reservations: excluded.provenance, excluded_ids: excluded.ids.size,
    screened: { clean: buckets.clean.length, "real-error": buckets["real-error"].length },
    drawn: realized, drawn_by_source_kind: perSourceKind,
    injection: { requested: injCounts, produced: injected.length, failed: injFailed },
    clusters: {
      count: clusterSizes.size, rows: rows.length,
      largest: Math.max(...clusterSizes.values()),
      multi_member: [...clusterSizes.values()].filter((n) => n > 1).length,
    },
    split: rows.reduce((m, r) => ({ ...m, [r.split]: (m[r.split] ?? 0) + 1 }), {}),
    echo: { wanted: wantEcho, paired: echoed, share: rows.length ? echoed / rows.length : 0 },
    pool_file: cfg.poolOut,
  };
  fs.writeFileSync(cfg.manifestOut, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// =====================================================================
// STAGE: assemble
// =====================================================================

function stageAssemble(cfg) {
  if (!fs.existsSync(cfg.manifestOut)) fail(`missing ${cfg.manifestOut} — run --stage pool first`);
  const manifest = JSON.parse(fs.readFileSync(cfg.manifestOut, "utf8"));
  const pool = readJsonl(cfg.poolOut, "pool");
  const byUid = new Map(pool.map((r) => [r.uid, r]));
  if (!cfg.teacher) fail("--teacher <teacher-results.jsonl> is required for --stage assemble");
  const teacher = readJsonl(cfg.teacher, "teacher results");
  const judge = new Map();
  for (const j of readJsonlIfPresent(cfg.judge)) {
    if (j && j.uid && Array.isArray(j.verdicts)) judge.set(j.uid, j);
  }
  const excluded = loadExcluded();
  const rnd = mulberry32(cfg.seed ^ 0xa55e);

  const out = [], drops = {}, notes = { judge_vs_injection: { agree: 0, disagree: 0, cases: [] } };
  const drop = (why) => { drops[why] = (drops[why] ?? 0) + 1; };

  for (const t of teacher) {
    const p = byUid.get(t.uid);
    if (!p) { drop("teacher-row-not-in-pool"); continue; }
    if (t.error) { drop(`teacher-error:${t.error}`); continue; }
    const changed = t.outcome !== "no-op" && typeof t.rewritten === "string"
      && t.rewritten.trim() !== p.sentence.trim();

    let kind = null, target = null, judged = null;
    if (!changed) {
      // Teacher-clean. An identity slot is satisfied; a real-error or injected
      // candidate the teacher did not correct is a MISS, not an identity — its
      // sentence is believed to contain an error.
      // A hard-negative CANDIDATE the teacher agreed was clean is not a hard
      // negative (that name needs a reverted edit) — but it passes the identity
      // slot's own gate (screened clean, teacher no-op) and is tempting-shaped,
      // which is the enrichment §6.3 wants the identity slot to carry. Dropping
      // these was what starved the identity share to 41.8% on the first
      // assembly; the card's mechanism field keeps the draw distinguishable.
      if (p.intent === "identity") { kind = "identity"; target = p.sentence; }
      else if (p.intent === "hard-negative") { kind = "identity"; target = p.sentence; }
      else { drop(`${p.intent}:teacher-found-nothing`); continue; }
    } else {
      if (t.guard !== "applied") { drop(`guard:${t.guard}`); continue; }
      const jrow = judge.get(t.uid);
      if (!jrow) {
        if (!cfg.allowUnjudged) {
          fail(`uid ${t.uid} has a CHANGED teacher target and no judge verdicts.\n`
            + "  §3: every changed target is judged per edit group. Run judge-harness.mjs\n"
            + "  over the teacher results, or pass --allow-unjudged to drop these rows.");
        }
        drop("unjudged"); continue;
      }
      try { judged = applyVerdicts(p.sentence, t.rewritten, jrow.verdicts); }
      catch (e) { fail(`uid ${t.uid}: ${e.message}`); }
      if (judged.allReverted) {
        // Every edit reverted: the teacher wanted to edit and the judge said
        // no. That IS the hard negative (§6.3), whatever slot it was drawn for.
        kind = "hard-negative"; target = p.sentence;
      } else if (p.intent === "injected") {
        kind = `injected:${p.inject.class}`;
        target = judged.target;
        const truth = restore(p.sentence, p.inject.groups);
        const agree = truth === target;
        notes.judge_vs_injection[agree ? "agree" : "disagree"]++;
        if (!agree && notes.judge_vs_injection.cases.length < 200) {
          notes.judge_vs_injection.cases.push({ uid: t.uid, class: p.inject.class });
        }
      } else {
        kind = "real-error";
        target = judged.target;
      }
    }

    const echo = p.echo_of ? { pending: true } : null;
    out.push({
      uid: t.uid,
      lineage: { ...p.lineage, cluster: p.cluster, split: p.split },
      register: p.register,
      kind,
      context: p.context,
      input: p.sentence,
      target,
      card: {
        source: p.source, license: LICENSE_OF[p.source], register: p.register,
        mechanism: p.intent === "injected"
          ? `injected:${p.inject.class}@${p.inject.version}`
          : (kind === "identity"
            ? (p.intent === "hard-negative" ? "none (teacher-clean, tempting draw)" : "none (teacher-clean)")
            : kind === "hard-negative" ? "teacher-edit ruled unnecessary" : "real (natural screen)"),
        screen_tags: p.screen_tags ?? [],
        teacher_model: t.model, teacher_outcome: t.outcome, guard: t.guard,
        judge: judged ? {
          model: judge.get(t.uid)?.judge_model, groups: judged.groups,
          kept: judged.kept, reverted: judged.reverted,
          quarantined: Boolean(judge.get(t.uid)?.quarantined),
        } : null,
        dedup_cluster: p.cluster, split: p.split,
      },
      ...(echo ? { _echo_of: p.echo_of, _echo_source_text: p.echo_source_text } : {}),
    });
  }

  // ---- echo splice, now that every leader has a final target
  const finalByUid = new Map(out.map((r) => [r.uid, r]));
  let echoed = 0, echoMissed = 0;
  for (const r of out) {
    if (!r._echo_of) continue;
    const leader = finalByUid.get(r._echo_of);
    if (!leader || leader.target === leader.input) { echoMissed++; delete r._echo_of; delete r._echo_source_text; continue; }
    const e = echoContext(r.context, r._echo_source_text, leader.target);
    delete r._echo_of; delete r._echo_source_text;
    if (!e.echoed) { echoMissed++; continue; }
    r.context = e.context;
    r.card.echo_context = { of: leader.uid };
    echoed++;
  }

  // ---- leakage gate
  const hits = assertNoLeak(out, excluded.ids);
  if (hits.length) {
    console.error(`\nLEAKAGE: ${hits.length} record(s) carry a reserved or holdout source_document_id.`);
    for (const h of hits.slice(0, 10)) console.error(`  ${h.uid}  ${h.source_document_id}`);
    fail("training assembly refuses to write a dataset that overlaps the benchmark or a holdout");
  }
  // Cluster atomicity: a cluster split across train and validation is the
  // failure §7.2 exists to prevent, so it is asserted rather than assumed.
  const clusterSplit = new Map();
  for (const r of out) {
    const c = r.lineage.cluster, s = r.lineage.split;
    if (clusterSplit.has(c) && clusterSplit.get(c) !== s) {
      fail(`cluster ${c} straddles ${clusterSplit.get(c)} and ${s} — split assignment is not atomic`);
    }
    clusterSplit.set(c, s);
  }

  // ---- the identity judge sample (§6.3: stratified 10% + every hard negative)
  const identities = out.filter((r) => r.kind === "identity");
  const byReg = new Map();
  for (const r of identities) { if (!byReg.has(r.register)) byReg.set(r.register, []); byReg.get(r.register).push(r); }
  const sample = [];
  for (const [, xs] of byReg) sample.push(...shuffled(xs, rnd).slice(0, Math.ceil(xs.length * 0.10)));
  sample.push(...out.filter((r) => r.kind === "hard-negative"));
  writeJsonl(cfg.judgeSampleOut, sample.map((r) => ({
    uid: r.uid, context: r.context, input: r.input, output: r.target,
    kind: r.kind, register: r.register, reason: r.kind === "identity"
      ? "stratified 10% clean-check" : "hard negative",
  })));

  writeJsonl(cfg.datasetOut, out);

  // ---- data card
  const counts = {};
  for (const r of out) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const bySource = {};
  for (const r of out) {
    const k = `${r.card.source}/${r.kind}`;
    bySource[k] = (bySource[k] ?? 0) + 1;
  }
  const identityN = (counts.identity ?? 0) + (counts["hard-negative"] ?? 0);
  const correctionN = out.length - identityN;
  const clusters = new Set(out.map((r) => r.lineage.cluster));
  const val = out.filter((r) => r.lineage.split === "validation").length;
  const md = [
    "# Pilot dataset — data card",
    "",
    `Generated ${new Date().toISOString()} by \`test/finetune/build-pilot-dataset.mjs --stage assemble\`.`,
    `Seed ${cfg.seed}. Context window W=${manifest.window}. Plan target ${manifest.target}.`,
    "",
    "Owner text is not reproduced here or in any committed artifact: the dataset itself",
    "lives under `test/harvested/finetune/` (gitignored) and this card carries counts only.",
    "",
    "## Realized mixture",
    "",
    "| kind | n | share |",
    "|---|---|---|",
    ...Object.entries(counts).sort().map(([k, n]) =>
      `| ${k} | ${n} | ${(100 * n / (out.length || 1)).toFixed(1)}% |`),
    `| **total** | **${out.length}** | |`,
    "",
    `Identity slot (identity + hard-negative): ${identityN} (${(100 * identityN / (out.length || 1)).toFixed(1)}%; §6.3 wants 60–75%).`,
    `Hard negatives within it: ${(100 * (counts["hard-negative"] ?? 0) / (identityN || 1)).toFixed(1)}% (§6.3 wants 25–40%).`,
    `Correction-bearing: ${correctionN} (${(100 * correctionN / (out.length || 1)).toFixed(1)}%; §6.3 wants 25–40%).`,
    "",
    "## Per source × kind",
    "",
    "| source | license | kind | n |",
    "|---|---|---|---|",
    ...Object.entries(bySource).sort().map(([k, n]) => {
      const [src, kind] = k.split("/");
      return `| ${src} | ${LICENSE_OF[src] ?? "?"} | ${kind} | ${n} |`;
    }),
    "",
    "## Leakage and clusters (§7.2)",
    "",
    `- reservation manifests consulted: ${manifest.reservations.map((r) => r.file).join(", ")}`,
    `- excluded ids: ${manifest.excluded_ids}; dropped at pool time: ${manifest.reserved_dropped}`,
    `- overlap after assembly: **0** (asserted; any hit exits 1)`,
    `- clusters: ${clusters.size} over ${out.length} records, whole-cluster split, atomicity asserted`,
    `- validation: ${val} (${(100 * val / (out.length || 1)).toFixed(1)}%)`,
    "",
    "## Judge",
    "",
    `- every CHANGED teacher target judged per edit group; D1 keep = required-correction | benign-optional`,
    `- injected truth vs judged target: ${notes.judge_vs_injection.agree} agree, ${notes.judge_vs_injection.disagree} disagree`,
    `- identity judge sample emitted for a later pass: \`${path.basename(cfg.judgeSampleOut)}\` (${sample.length} rows)`,
    "",
    "## Echo contexts (§6.3 runtime-echo risk)",
    "",
    `- spliced: ${echoed}; pairing lost at assembly: ${echoMissed}`,
    "",
    "## Drops",
    "",
    ...Object.entries(drops).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`),
    "",
  ].join("\n");
  fs.writeFileSync(cfg.cardOut, md + "\n");

  return {
    records: out.length, counts, drops, echoed, echoMissed,
    clusters: clusters.size, validation: val, judgeSample: sample.length,
    judge_vs_injection: notes.judge_vs_injection,
  };
}

// =====================================================================
// CLI
// =====================================================================

if (import.meta.url === `file://${process.argv[1]}`) {
  const STAGE = argOf("--stage");
  if (!["pool", "assemble"].includes(STAGE)) {
    fail("--stage pool | assemble is required\n"
      + "  node build-pilot-dataset.mjs --stage pool [--target 6000] [--seed N] [--window 500]\n"
      + "  node build-pilot-dataset.mjs --stage assemble --teacher <f> [--judge <f>]");
  }
  const num = (f, d) => (argOf(f) === null ? d : Number(argOf(f)));
  const cfg = {
    stage: STAGE,
    target: num("--target", 6000),
    seed: num("--seed", 20260821) >>> 0,
    window: num("--window", DEFAULT_WINDOW),
    ownerShare: num("--owner-share", DEFAULTS.ownerShare),
    echoShare: num("--echo-share", DEFAULTS.echoShare),
    validationShare: num("--validation-share", DEFAULTS.validationShare),
    sources: (argOf("--sources", "s1,s2,s3")).split(",").map((s) => s.trim()).filter(Boolean),
    priors: argOf("--priors", path.join(ART, "error-priors-v0.json")),
    poolOut: argOf("--pool-out", path.join(ART, "pilot-pool.jsonl")),
    manifestOut: argOf("--manifest", path.join(ART, "pilot-pool-manifest.json")),
    datasetOut: argOf("--dataset-out", path.join(ART, "pilot-dataset.jsonl")),
    judgeSampleOut: argOf("--judge-sample-out", path.join(ART, "pilot-identity-judge-sample.jsonl")),
    cardOut: argOf("--card-out", path.join(ART, "pilot-data-card.md")),
    teacher: argOf("--teacher"),
    judge: argOf("--judge", path.join(ART, "judge-verdicts.jsonl")),
    allowUnjudged: hasFlag("--allow-unjudged"),
    shares: {},
  };
  for (const k of ["identityShare", "hardNegShare", "realShare"]) {
    const flag = "--" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    if (argOf(flag) !== null) cfg.shares[k] = Number(argOf(flag));
  }
  cfg.shares.ownerShare = cfg.ownerShare;

  if (STAGE === "pool") {
    const m = await stagePool(cfg);
    const pad = (s, n) => String(s).padEnd(n);
    console.log("\nPilot pool draw");
    console.log("=".repeat(72));
    console.log(`  target ${m.target}   seed ${m.seed}   window ${m.window}   priors ${m.priors.version}`);
    console.log(`  excluded ids ${m.excluded_ids}   dropped at screen time ${m.reserved_dropped}`);
    console.log("\n  source pools");
    for (const f of m.funnel) console.log(`    ${pad(f.source + " " + f.corpus, 34)} ${String(f.items).padStart(8)} targets  ${String(f.screened).padStart(8)} screened`);
    console.log(`\n  screened-clean ${m.screened.clean}   screen-hit ${m.screened["real-error"]}`);
    console.log("\n  planned slots (final dataset)          teacher calls to draw");
    for (const k of Object.keys(m.plan.slots)) {
      console.log(`    ${pad(k, 20)} ${String(m.plan.slots[k]).padStart(6)}   ->   ${String(m.plan.draw[k]).padStart(6)}`);
    }
    console.log(`    ${pad("TOTAL", 20)} ${String(m.plan.checksum).padStart(6)}   ->   ${String(m.plan.teacherCalls).padStart(6)}`);
    console.log("\n  drawn by source/kind");
    for (const [k, n] of Object.entries(m.drawn_by_source_kind).sort()) {
      console.log(`    ${pad(k, 26)} ${String(n).padStart(6)}`);
    }
    console.log(`\n  injection produced ${m.injection.produced}, inapplicable ${m.injection.failed.total}`);
    console.log(`  clusters ${m.clusters.count} over ${m.clusters.rows} rows (largest ${m.clusters.largest}, multi-member ${m.clusters.multi_member})`);
    console.log(`  split ${JSON.stringify(m.split)}   echo paired ${m.echo.paired}/${m.echo.wanted}`);
    console.log(`\n  pool     ${m.pool_file}`);
    console.log(`  manifest ${cfg.manifestOut}`);
    console.log("\n  Next (the OWNER schedules the GPU — R10):");
    console.log(`    PROOFER_OLLAMA_URL=http://127.0.0.1:11436 PROOFER_MODEL=qwen3.8:27b \\`);
    console.log(`      PROOFER_SKIP_DIGEST_CHECK=1 node teacher-pass.mjs \\`);
    console.log(`      --in ${m.pool_file} \\`);
    console.log(`      --out ${path.join(ART, "pilot-teacher.jsonl")} --window ${m.window}\n`);
  } else {
    const r = stageAssemble(cfg);
    console.log("\nPilot dataset assembled");
    console.log("=".repeat(72));
    console.log(`  records         ${r.records}`);
    for (const [k, n] of Object.entries(r.counts).sort()) console.log(`    ${k.padEnd(24)} ${n}`);
    console.log(`  clusters        ${r.clusters}   validation ${r.validation}`);
    console.log(`  echo spliced    ${r.echoed}   lost ${r.echoMissed}`);
    console.log(`  judge sample    ${r.judgeSample}`);
    console.log(`  injected truth  ${r.judge_vs_injection.agree} agree / ${r.judge_vs_injection.disagree} disagree`);
    console.log(`  drops           ${JSON.stringify(r.drops)}`);
    console.log(`\n  dataset  ${cfg.datasetOut}\n  card     ${cfg.cardOut}\n`);
  }
}
