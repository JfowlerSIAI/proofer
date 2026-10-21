#!/usr/bin/env node
// Quota-driven benchmark candidate sampler (plan §4, §6.1; Sol brainstorm
// 2026-08-20).
//
// Produces two artifacts and nothing else:
//
//   1. test/harvested/finetune/benchmark-candidates-<register>.jsonl
//      the labeling queue — one candidate per line, oversampled ~1.6x per cell
//      so the owner can skip the unjudgeable without emptying a quota cell.
//   2. test/harvested/finetune/benchmark-reserved-message-ids.json
//      the TRAINING RESERVATION. Every message_id in every sampled EPISODE, not
//      merely the sampled messages: reserving one message of a conversation and
//      training on the rest leaks the conversation into the model whose
//      benchmark it is. Consumed by `scrub-discord.mjs --exclude` and by
//      training assembly.
//
// WHAT IS A QUOTA AND WHAT IS NOT.
//
// The `random` frame is a UNIFORM PROBABILITY SAMPLE over the register's
// sentence targets and is deliberately exempt from every phenomenon and
// error-type preference. It is the only slice `owner-discord-random-v1` (the
// one profile allowed to be called a deployment estimate) may draw from, and a
// phenomenon-balanced "random" frame would silently stop being one. Quota
// pressure is applied to the other three frames only.
//
// A candidate's CLEAN/ERROR status is an INTENT, never a label. `natural-screen`
// says a lexical screen fired; `injected` says a known mechanical transform was
// applied; `hard-negative` says a pattern that tempts an unnecessary edit is
// present. The owner's label decides all of it, which is why the ~670/330
// clean/error target is a design target for the mix and not an assertion here.
//
// MECHANICAL SEEDS ONLY. An injected candidate ships with the transform's own
// inverse as the prefilled correction. No model is consulted anywhere in this
// file — the Sol decision was explicit that gold may not be model-seeded, and a
// benchmark seeded by a model measures that model.
//
// Usage:
//   node test/finetune/benchmark-sample.mjs --registers chat-owner
//   node test/finetune/benchmark-sample.mjs --registers chat-owner --seed 20260820
//   node test/finetune/benchmark-sample.mjs --plan     (print the tables, sample nothing)

import { mkdirSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import {
  loadMessages, channelIndex, targetsFor, mulberry32, shuffled,
  CONTEXT_WINDOW_MS,
} from "../harvested/discord-source.mjs";
import { screen, screenScore, TAG_TO_ERROR_TYPE, damerau1Words, maskProtected }
  from "./natural-screens.mjs";
import { inject, applicableTypes, INJECT_VERSION } from "./error-inject.mjs";
import { isWord } from "../lib/sentence-guards.mjs";
import { ircPool, enronPool, sePool } from "./corpus-pools.mjs";
import {
  REGISTERS, ERROR_TYPES, PHENOMENA, FRAMES, benchmarkUid,
} from "./benchmark-schema.mjs";

const OUT_DIR = new URL("../harvested/finetune/", import.meta.url);
const DEFAULT_SEED = 20260820;

function die(msg) { console.error("benchmark-sample: " + msg); process.exit(1); }

// =====================================================================
// TABLES — Sol brainstorm 2026-08-20. Edit here, nowhere else; every derived
// number below is computed from these and asserted against them at load.
// =====================================================================

/**
 * Register totals, dev/sealed split (60/40 per cell) and the clean/error mix.
 * Totals: 1000 items, 600 dev / 400 sealed, 670 CLEAN / 330 ERROR.
 *
 * The clean/error column is the DESIGN TARGET for the mix — deliberately
 * enriched against the measured 97.2%-clean deployment prior for statistical
 * power (audit finding 9), with every per-1k metric reweighted downstream.
 */
export const REGISTER_PLAN = Object.freeze({
  "chat-owner":      { total: 300, dev: 180, sealed: 120, clean: 200, error: 100 },
  "chat-irc":        { total: 250, dev: 150, sealed: 100, clean: 168, error:  82 },
  "email-workplace": { total: 250, dev: 150, sealed: 100, clean: 168, error:  82 },
  "forum-comments":  { total: 200, dev: 120, sealed:  80, clean: 134, error:  66 },
});

/** Sampling-frame totals across all registers (Sol: 200 uniform-random natural
 *  + 500 pre-screened natural + ~300 adaptive injected/hard-negative fill). The
 *  last 300 is split ADAPTIVELY between `injected` and `hard-negative` per
 *  register — injection takes what it needs to close open error-type cells and
 *  hard negatives take the rest. */
export const FRAME_TOTALS = Object.freeze({
  random: 200, "natural-screen": 500, fill: 300,
});

/** Overall error-type quotas (sum 330). */
export const ERROR_TYPE_TOTALS = Object.freeze({
  "transposition": 30, "adjacent-key": 30, "moved-space": 30,
  "doubled-word": 22, "held-shift-stutter": 22, "semicolon-apostrophe": 18,
  "dropped-apostrophe": 22, "homophone-confusable": 34, "run-together": 22,
  "terminator": 18, "casing": 22, "agreement": 26, "other-natural": 34,
});

/** Every named type gets at least this many items per register, so no cell is
 *  measured on one or two sentences. 13 x 4 = 52 <= 66, the smallest register
 *  error total, so the floor is always satisfiable. */
export const ERROR_TYPE_FLOOR = 4;

/**
 * Primary-phenomenon x register quotas. Rows sum to the register total; the
 * `ordinary` row is the remainder. Targeted phenomena come from §4's list; the
 * emoji row is thinner for email/forum because the register genuinely carries
 * fewer, and a quota that cannot be filled is a permanent red line in the
 * report rather than a target.
 */
export const PHENOMENON_BY_REGISTER = Object.freeze({
  "names":              { "chat-owner": 20, "chat-irc": 17, "email-workplace": 17, "forum-comments": 13 },
  "numbers":            { "chat-owner": 20, "chat-irc": 17, "email-workplace": 17, "forum-comments": 13 },
  "negation":           { "chat-owner": 15, "chat-irc": 12, "email-workplace": 12, "forum-comments": 10 },
  "urls":               { "chat-owner": 10, "chat-irc":  8, "email-workplace":  8, "forum-comments":  7 },
  "code-tokens":        { "chat-owner": 10, "chat-irc":  8, "email-workplace":  8, "forum-comments":  7 },
  "emoji":              { "chat-owner": 10, "chat-irc":  8, "email-workplace":  4, "forum-comments":  4 },
  "instruction-like":   { "chat-owner": 10, "chat-irc":  8, "email-workplace":  8, "forum-comments":  7 },
  "fragments":          { "chat-owner": 15, "chat-irc": 12, "email-workplace": 12, "forum-comments": 10 },
  "multi-error":        { "chat-owner": 15, "chat-irc": 12, "email-workplace": 12, "forum-comments": 10 },
  "segmenter-produced": { "chat-owner": 15, "chat-irc": 12, "email-workplace": 12, "forum-comments": 10 },
  "ordinary":           { "chat-owner": 160, "chat-irc": 136, "email-workplace": 140, "forum-comments": 109 },
});

/** Oversample factor per cell: the owner will mark some candidates
 *  unjudgeable/skip, and a cell that arrives exactly full arrives short. */
export const OVERSAMPLE = 1.6;

/** Fraction of exclusion GROUPS assigned to dev. Groups are atomic — a split
 *  that partitions sentences instead of episodes leaks the sealed set
 *  (validateFile in benchmark-schema.mjs refuses it), so per-cell dev/sealed
 *  counts land NEAR 60/40 rather than exactly on it. Realized counts are in
 *  the report. */
export const DEV_FRACTION = 0.6;

// ------------------------------------------------- derived: error-type x register

/**
 * Deterministic biproportional allocation with a per-cell floor.
 *
 * Round the margins independently and they disagree — a per-type largest
 * remainder gave chat-irc 89 error items against its row total of 82, because
 * nothing in a column-wise rounding can see a row. So: seat every cell at the
 * floor, seat the INDEPENDENCE product `rowLeft x colLeft / N` under it, and
 * hand the rounding remainder out by largest fractional part subject to BOTH
 * remaining margins. A cell is always available while any row and any column
 * still owe units, so the loop terminates with both margins exact — and the
 * result stays near-proportional instead of merely feasible (zipping two
 * divisor sequences is feasible and lands `agreement` on 4/8/10/4, which is a
 * rounding artefact masquerading as a decision).
 */
export function allocate(rowTotals, colTotals, floor) {
  const rows = Object.keys(rowTotals), cols = Object.keys(colTotals);
  const cell = {};
  for (const r of rows) { cell[r] = {}; for (const c of cols) cell[r][c] = floor; }
  const rowLeft = {}, colLeft = {};
  for (const r of rows) {
    rowLeft[r] = rowTotals[r] - floor * cols.length;
    if (rowLeft[r] < 0) die(`allocate: row ${r} total ${rowTotals[r]} < floor ${floor} x ${cols.length}`);
  }
  for (const c of cols) {
    colLeft[c] = colTotals[c] - floor * rows.length;
    if (colLeft[c] < 0) die(`allocate: col ${c} total ${colTotals[c]} < floor ${floor} x ${rows.length}`);
  }
  const N = rows.reduce((n, r) => n + rowLeft[r], 0);
  const colSum = cols.reduce((n, c) => n + colLeft[c], 0);
  if (N !== colSum) die(`allocate: margins disagree after the floor (${N} vs ${colSum})`);
  const frac = {};
  const rowRem = { ...rowLeft }, colRem = { ...colLeft };
  for (const r of rows) {
    frac[r] = {};
    for (const c of cols) {
      const want = N ? (rowLeft[r] * colLeft[c]) / N : 0;
      const base = Math.floor(want);
      cell[r][c] += base;
      frac[r][c] = want - base;
      rowRem[r] -= base; colRem[c] -= base;
    }
  }
  let guard = N + 1;
  while (guard-- > 0) {
    let best = null, bestF = -1;
    for (const r of rows) {
      if (rowRem[r] <= 0) continue;
      for (const c of cols) {
        if (colRem[c] <= 0) continue;
        if (frac[r][c] > bestF + 1e-12) { bestF = frac[r][c]; best = [r, c]; }
      }
    }
    if (!best) break;
    cell[best[0]][best[1]]++;
    rowRem[best[0]]--; colRem[best[1]]--;
    frac[best[0]][best[1]] = -1;          // spend it once
  }
  // Assert both margins rather than trusting the construction.
  for (const r of rows) {
    const s = cols.reduce((n, c) => n + cell[r][c], 0);
    if (s !== rowTotals[r]) die(`allocate: row ${r} realized ${s} != ${rowTotals[r]}`);
  }
  for (const c of cols) {
    const s = rows.reduce((n, r) => n + cell[r][c], 0);
    if (s !== colTotals[c]) die(`allocate: col ${c} realized ${s} != ${colTotals[c]}`);
  }
  return cell;
}

export const ERROR_TYPE_BY_REGISTER = allocate(
  Object.fromEntries(REGISTERS.map((r) => [r, REGISTER_PLAN[r].error])),
  ERROR_TYPE_TOTALS, ERROR_TYPE_FLOOR);

// ------------------------------------------------------------ table self-check
(function checkTables() {
  const total = REGISTERS.reduce((n, r) => n + REGISTER_PLAN[r].total, 0);
  if (total !== 1000) die(`register totals sum to ${total}, expected 1000`);
  let dev = 0, sealed = 0, clean = 0, error = 0;
  for (const r of REGISTERS) {
    const p = REGISTER_PLAN[r];
    if (p.dev + p.sealed !== p.total) die(`${r}: dev+sealed != total`);
    if (p.clean + p.error !== p.total) die(`${r}: clean+error != total`);
    dev += p.dev; sealed += p.sealed; clean += p.clean; error += p.error;
  }
  if (dev !== 600 || sealed !== 400) die(`dev/sealed ${dev}/${sealed}, expected 600/400`);
  if (clean !== 670 || error !== 330) die(`clean/error ${clean}/${error}, expected 670/330`);
  const et = Object.values(ERROR_TYPE_TOTALS).reduce((a, b) => a + b, 0);
  if (et !== error) die(`error-type totals sum to ${et}, expected ${error}`);
  for (const t of ERROR_TYPES) {
    if (!(t in ERROR_TYPE_TOTALS)) die(`error type ${t} has no quota`);
  }
  for (const p of PHENOMENA) {
    if (!(p in PHENOMENON_BY_REGISTER)) die(`phenomenon ${p} has no quota row`);
  }
  for (const r of REGISTERS) {
    const s = PHENOMENA.reduce((n, p) => n + PHENOMENON_BY_REGISTER[p][r], 0);
    if (s !== REGISTER_PLAN[r].total) die(`phenomenon column ${r} sums to ${s}, expected ${REGISTER_PLAN[r].total}`);
  }
  const ft = FRAME_TOTALS.random + FRAME_TOTALS["natural-screen"] + FRAME_TOTALS.fill;
  if (ft !== 1000) die(`frame totals sum to ${ft}, expected 1000`);
  for (const r of REGISTERS) {
    for (const t of ERROR_TYPES) {
      if (ERROR_TYPE_BY_REGISTER[r][t] < ERROR_TYPE_FLOOR)
        die(`cell (${r}, ${t}) below the floor`);
    }
  }
})();

/** Per-register frame budgets, proportional to the register total. */
export function frameBudget(register) {
  const share = REGISTER_PLAN[register].total / 1000;
  const random = Math.round(FRAME_TOTALS.random * share);
  const naturalScreen = Math.round(FRAME_TOTALS["natural-screen"] * share);
  const fill = REGISTER_PLAN[register].total - random - naturalScreen;
  if (fill < 0) die(`${register}: frame budgets exceed the register total`);
  return { random, "natural-screen": naturalScreen, fill };
}

// =====================================================================
// PHENOMENA
// =====================================================================

// `<URL>` is entity-scrub.mjs's placeholder. The scrubbed registers carry it
// where a link stood, so the `urls` row still measures the thing it exists to
// measure — leave a foreign, non-prose token alone — rather than emptying out.
const RE_URL = /\bhttps?:\/\/\S+|\bwww\.\S+|<URL>/i;
const RE_CODE = /`|\b\w+_\w+\b|\b\w+\(\)|::|\bnpm |\bgit |\/[a-z]+\/[a-z]/i;
const RE_EMOJI = /<a?:\w+:\d+>|:[a-z0-9_+-]{2,}:|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const RE_NUMBER = /\d/;
const RE_NEGATION = /\b(not|no|never|none|nobody|nothing|nowhere|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|shouldn't|wouldn't|couldn't|haven't|hasn't|hadn't)\b/i;
const RE_INSTRUCTION = [
  /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instruction|prompt|rule|message)/i,
  /\byou are (?:a|an|now)\b/i,
  /\b(respond|reply|answer|output|return) (?:with|only|in)\b/i,
  /\b(translate|summar[iy]|rewrite this) \w+ (?:into|to|as)\b/i,
  /\bsystem prompt\b/i,
];

/** Which PHENOMENA are present. `ordinary` only when nothing else is. */
export function detectPhenomena(sentence, opts = {}) {
  const s = String(sentence);
  const found = new Set();
  if (RE_URL.test(s)) found.add("urls");
  if (RE_CODE.test(s)) found.add("code-tokens");
  if (RE_EMOJI.test(s)) found.add("emoji");
  if (RE_NUMBER.test(s)) found.add("numbers");
  if (RE_NEGATION.test(s)) found.add("negation");
  if (RE_INSTRUCTION.some((re) => re.test(s))) found.add("instruction-like");
  // A capitalised token that is not sentence-initial and is not a dictionary
  // word: the dictionary deliberately holds no proper nouns.
  const masked = maskProtected(s);
  const caps = masked.match(/(?<=\S\s+)[A-Z][a-z]{2,}/g) || [];
  if (caps.some((w) => !isWord(w.toLowerCase()))) found.add("names");
  if (!/[.!?]["'’)\]]*\s*$/.test(s.trim())) found.add("fragments");
  // `ordinary` is decided on the CONTENT phenomena alone. `segmenter-produced`
  // and `multi-error` are structural facts about how the item was produced, not
  // things in the text — and segmentation fires on 53% of the owner corpus, so
  // treating it as disqualifying left `ordinary` unfillable (62/160 realized)
  // while `segmenter-produced` overshot its own row eight-fold.
  if (!found.size) found.add("ordinary");
  if (opts.multiError) found.add("multi-error");
  if (opts.segmenterProduced) found.add("segmenter-produced");
  return [...found].sort((a, b) => PHENOMENA.indexOf(a) - PHENOMENA.indexOf(b));
}

// Rarest-first tie-break when several phenomena are present and no cell is
// short: a sentence with a URL and a number is worth more to the `urls` row.
const PHENOMENON_PRIORITY = Object.freeze([
  "instruction-like", "urls", "code-tokens", "emoji", "multi-error",
  "segmenter-produced", "names", "numbers", "negation", "fragments", "ordinary",
]);

/** Every phenomenon a frame may actively pursue. `ordinary` is the remainder
 *  and is never pursued — pursuing it would just mean "take anything". */
export const TARGETED_PHENOMENA = Object.freeze(
  PHENOMENA.filter((p) => p !== "ordinary"));

/**
 * A budgeted selector with a RESERVATION for scarce phenomenon cells.
 *
 * Without it the scarce rows never fill: `urls`, `code-tokens`, `emoji` and
 * `instruction-like` are 2.6% / 1.4% / 1.0% / 0.1% of the owner pool, so a
 * frame that takes the best-scoring N items takes essentially none of them
 * (measured: code-tokens 0/10, instruction-like 1/10). The rule is: admit an
 * item that serves a short targeted cell immediately; admit an item that
 * serves nothing only while the budget still exceeds the outstanding
 * shortfall. `relax()` opens the gate at the end so a frame cannot come up
 * short because it was holding seats for cells the pool cannot fill.
 */
function reservingSelector(want, filled, quotaOver) {
  // Three passes, not two. Pass 0 reserves seats for the SCARCE targeted rows.
  // Pass 1 relaxes to "serves any short row, `ordinary` included" — measured
  // addition: without it `ordinary` came back 43/218 on chat-irc, 89/224 on
  // email-workplace and 114/175 on forum-comments, because in those registers
  // almost every line carries a number, a code token or a fragment, so an item
  // that is plain prose is exactly the item a score-ranked frame never reaches.
  // Pass 2 takes anything, so a row the pool genuinely cannot fill costs
  // candidates rather than the frame's budget.
  let taken = 0, mode = 0;
  const shortSomewhere = (phenomena, includeOrdinary) => phenomena.some(
    (p) => (includeOrdinary || p !== "ordinary") && filled[p] < quotaOver[p]);
  return {
    get count() { return taken; },
    get done() { return taken >= want; },
    /** 1 = prefer any short row; 2 = take anything. */
    setPass(n) { mode = n; },
    relax() { mode = 2; },
    admit(phenomena) {
      if (taken >= want) return false;
      if (mode >= 2) { taken++; return true; }
      if (mode === 1) {
        if (!shortSomewhere(phenomena, true)) return false;
        taken++; return true;
      }
      if (shortSomewhere(phenomena, false)) { taken++; return true; }
      const reserve = TARGETED_PHENOMENA
        .reduce((n, p) => n + Math.max(0, quotaOver[p] - filled[p]), 0);
      // The leftover seats go to items that still serve SOME short row —
      // `ordinary` included. Handing them to anything at all is what let the
      // score-ranked head of the queue, which is phenomenon-dense by
      // construction, spend pass 0 entirely and leave pass 1 nothing to do.
      if (want - taken > reserve && shortSomewhere(phenomena, true)) { taken++; return true; }
      return false;
    },
  };
}

/** Pick the primary phenomenon: whichever detected cell is furthest from its
 *  quota, ties broken by PHENOMENON_PRIORITY. Choosing greedily is what makes
 *  the table fillable at all — a fixed priority order would starve every row
 *  below `numbers`. */
export function primaryPhenomenon(phenomena, filled, quota) {
  let best = null, bestGap = -Infinity, bestPri = Infinity;
  for (const p of phenomena) {
    const gap = (quota[p] ?? 0) - (filled[p] ?? 0);
    const pri = PHENOMENON_PRIORITY.indexOf(p);
    if (gap > bestGap || (gap === bestGap && pri < bestPri)) {
      best = p; bestGap = gap; bestPri = pri;
    }
  }
  return best ?? "ordinary";
}

// =====================================================================
// HARD NEGATIVES — pattern-based, no model, no teacher.
// =====================================================================

const RE_VERSIONISH = /\bv?\d+\.\d+(\.\d+)?\b|\b\d+[a-z]{1,3}\b|\b\d{1,3}(,\d{3})+\b|\$\d/;
const RE_INITIALISM = /\b[A-Z]{2,5}\b/;
const RE_QUOTEY = /["“”]|(?:^|\s)['‘][^'’]{2,}['’]/;

/**
 * Does this sentence TEMPT an unnecessary edit? The anti-meddling substrate
 * (§6.3: "valid-but-rare words, names, slang, jargon one edit from a dictionary
 * word; numbers/casing/quotation shapes that tempt normalization").
 *
 * Returns the reasons that fired, or [] — a sentence with a strong error screen
 * is not a hard negative, it is a suspected error, and the two frames must not
 * compete for the same sentence.
 */
export function hardNegativeReasons(sentence) {
  const s = String(sentence);
  const reasons = [];
  const masked = maskProtected(s);
  const toks = masked.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  let sawNameNearWord = false, sawSlangNearWord = false;
  toks.forEach((t, i) => {
    const b = t.replace(/['’]/g, "").toLowerCase();
    if (b.length < 3 || b.length > 14) return;
    if (/^[A-Z]/.test(t) && i > 0 && !isWord(b)) {
      if (damerau1Words(b).size >= 1) sawNameNearWord = true;
    } else if (!/^[A-Z]/.test(t) && isWord(b)) {
      // A real word with a real-word neighbour one edit away is the shape the
      // dictionary rule cannot protect and the confusable licences can open.
      if (b.length >= 5 && damerau1Words(b).size >= 2) sawSlangNearWord = true;
    }
  });
  if (sawNameNearWord) reasons.push("name-one-edit-from-word");
  if (sawSlangNearWord) reasons.push("rare-word-with-neighbours");
  if (RE_VERSIONISH.test(s)) reasons.push("number-shape");
  if (RE_INITIALISM.test(masked)) reasons.push("initialism");
  if (RE_QUOTEY.test(s)) reasons.push("quotation-shape");
  if (/[a-z]+[A-Z]/.test(masked)) reasons.push("internal-capital");
  return reasons;
}

// =====================================================================
// POOLS — pluggable per register.
// =====================================================================

/**
 * A pool returns `{ items, episodes, corpus }` where each item is
 * `{ sentence, context_2500, source_document_id, exclusion_group_id,
 *    segment_start, segment_end, segmenterProduced }`
 * and `episodes` is a Map exclusion_group_id -> string[] of source document ids
 * (the TRAINING RESERVATION unit).
 */
const POOLS = {
  "chat-owner": ownerPool,
  "chat-irc": ircPool,
  "email-workplace": enronPool,
  // The SE pool takes a stated PURPOSE and refuses anything but "benchmark":
  // CC BY-SA share-alike, local unpublished benchmark only (its DATA-CARD.md).
  "forum-comments": () => sePool("benchmark"),
};

export function poolFor(register) {
  if (!REGISTERS.includes(register)) die(`unknown register: ${register}`);
  const p = POOLS[register];
  if (!p) die(`pool not implemented: ${register} — preprocessors land after corpus fetch`);
  return p;
}

function ownerPool() {
  let msgs;
  try {
    msgs = loadMessages();
  } catch (e) {
    if (e && e.code) die(`could not read the Discord export (${e.code})`);
    throw e;
  }
  if (!msgs.length) die("loadMessages() returned 0 messages");
  const byChannel = channelIndex(msgs);

  // Episodes: maximal chains of same-channel messages with pairwise gaps <=
  // CONTEXT_WINDOW_MS. That bound makes an episode a SUPERSET of every context
  // window targetsFor can build inside it — if a prior message is within 30 min
  // of a target, every message between them is too, so the whole chain is one
  // episode and reserving the episode reserves the context.
  const episodeOf = new Map();          // message_id -> exclusion_group_id
  const episodes = new Map();           // exclusion_group_id -> message_id[]
  for (const [key, list] of byChannel) {
    const chanHash = createHash("sha1").update(key).digest("hex").slice(0, 8);
    let idx = 0, prev = null;
    for (const m of list) {
      if (prev !== null && m.ts - prev > CONTEXT_WINDOW_MS) idx++;
      prev = m.ts;
      const gid = `${chanHash}#${idx}`;
      episodeOf.set(m.message_id, gid);
      if (!episodes.has(gid)) episodes.set(gid, []);
      episodes.get(gid).push(m.message_id);
    }
  }

  const items = [];
  for (const m of msgs) {
    const targets = targetsFor(m, byChannel);
    for (const t of targets) {
      items.push({
        sentence: t.sentence,
        context_2500: t.context,
        source_document_id: t.message_id,
        exclusion_group_id: episodeOf.get(t.message_id),
        segment_start: t.start,
        segment_end: t.end,
        // A sentence that is not the whole message came out of the segmenter
        // rather than off the user's Enter key — R7's slice.
        segmenterProduced: t.start > 0 || t.end < m.content.length,
      });
    }
  }
  if (!items.length) die("chat-owner pool produced 0 sentence targets");
  return { items, episodes, corpus: "owner-discord" };
}

// =====================================================================
// SPLIT
// =====================================================================

/** Uniform [0,1) from a seeded hash of the exclusion GROUP. Group-atomic by
 *  construction; per-cell dev/sealed therefore lands near DEV_FRACTION rather
 *  than exactly on it. */
export function groupUnit(groupId, seed) {
  const h = createHash("sha256").update(`bench-split/v1\0${seed}\0${groupId}`).digest();
  return h.readUInt32BE(0) / 4294967296;
}

export const splitForGroup = (groupId, seed) =>
  (groupUnit(groupId, seed) < DEV_FRACTION ? "dev" : "sealed");

// =====================================================================
// SAMPLING
// =====================================================================

const ceilOver = (n) => Math.ceil(n * OVERSAMPLE);

function candidateId(register, uid) {
  return `${register}:${uid.slice(uid.indexOf(":") + 1, uid.indexOf(":") + 17)}`;
}

function makeCandidate(register, pool, item, frame, extra, filled, quota) {
  const corpus = pool.corpus;
  const sentence = extra.sentence ?? item.sentence;
  const phenomena = detectPhenomena(sentence, {
    multiError: !!extra.multiError,
    segmenterProduced: !!item.segmenterProduced,
  });
  const primary = primaryPhenomenon(phenomena, filled, quota);
  const uid = benchmarkUid(item.source_document_id, sentence);
  return {
    candidate_id: candidateId(register, uid),
    uid,
    sentence,
    context_2500: item.context_2500,
    source: {
      corpus,
      register,
      ...(pool.benchmarkOnly ? { benchmark_only: true } : {}),
      source_document_id: item.source_document_id,
      exclusion_group_id: item.exclusion_group_id,
      segment_start: item.segment_start,
      segment_end: item.segment_end,
    },
    split: extra.split,
    sampling: {
      frame,
      primary_phenomenon: primary,
      phenomena,
      screen_reasons: extra.screen_reasons ?? [],
    },
    inject: extra.inject ?? null,
  };
}

/** The taxonomy classes no screen and no transform can pre-seed.
 *  `other-natural` is by definition what the mechanical transforms do NOT
 *  produce — a missing word, a real-word substitution, an agreement slip in the
 *  wild — so its cell is filled at LABEL time out of the `random` and
 *  `natural-screen` frames. Reporting it as an unfilled cell would be reporting
 *  a category error as a defect. */
export const UNSEEDABLE_TYPES = Object.freeze(["other-natural"]);

export async function sampleRegister(register, { seed = DEFAULT_SEED, verbose = true } = {}) {
  const pool = await poolFor(register)();
  const budget = frameBudget(register);
  const quota = Object.fromEntries(
    PHENOMENA.map((p) => [p, PHENOMENON_BY_REGISTER[p][register]]));
  // Selection runs against the OVERSAMPLED quota, because the queue is
  // oversampled: holding a row to its 1x quota mid-run would starve it once
  // the owner skips items out of it.
  const quotaOver = Object.fromEntries(
    PHENOMENA.map((p) => [p, ceilOver(quota[p])]));
  const filled = Object.fromEntries(PHENOMENA.map((p) => [p, 0]));
  const typeQuota = { ...ERROR_TYPE_BY_REGISTER[register] };
  const typeFilled = Object.fromEntries(ERROR_TYPES.map((t) => [t, 0]));

  const taken = new Set();              // uid -> already a candidate
  const out = [];
  const note = (c) => {
    out.push(c);
    filled[c.sampling.primary_phenomenon]++;
    taken.add(c.uid);
  };

  // --- frame 1: random. Uniform over targets, NO quota pressure at all.
  // This is the only slice `owner-discord-random-v1` may draw from; a
  // phenomenon-balanced "random" frame is not a probability sample and cannot
  // carry a deployment estimate.
  const order = shuffled(pool.items.map((_, i) => i), seed);
  const wantRandom = ceilOver(budget.random);
  for (const i of order) {
    if (out.length >= wantRandom) break;
    const item = pool.items[i];
    const uid = benchmarkUid(item.source_document_id, item.sentence);
    if (taken.has(uid)) continue;
    note(makeCandidate(register, pool, item, "random",
      { split: splitForGroup(item.exclusion_group_id, seed) }, filled, quotaOver));
  }
  const randomCount = out.length;

  // --- screen everything once. The tags are reused by all three later frames.
  const screened = [];
  for (let i = 0; i < pool.items.length; i++) {
    const tags = screen(pool.items[i].sentence);
    screened.push(tags);
  }

  // --- frame 2: natural-screen. Ranked by screen score, credited to the
  // suggested error-type cell up to its quota; surplus still enriches.
  const wantScreen = ceilOver(budget["natural-screen"]);
  const ranked = pool.items
    .map((item, i) => ({ i, item, tags: screened[i], score: screenScore(screened[i]) }))
    .filter((r) => r.score >= 4)          // below 4 is the confusable tag alone
    .sort((a, b) => b.score - a.score
      || (a.item.source_document_id < b.item.source_document_id ? -1 : 1));
  const screenSel = reservingSelector(wantScreen, filled, quotaOver);
  for (const pass of [0, 1, 2]) {
    screenSel.setPass(pass);
    for (const r of ranked) {
      if (screenSel.done) break;
      const uid = benchmarkUid(r.item.source_document_id, r.item.sentence);
      if (taken.has(uid)) continue;
      const strong = r.tags.filter((t) => screenScore([t]) >= 4);
      const cand = makeCandidate(register, pool, r.item, "natural-screen", {
        split: splitForGroup(r.item.exclusion_group_id, seed),
        screen_reasons: r.tags,
        multiError: strong.length >= 2,
      }, filled, quotaOver);
      if (!screenSel.admit(cand.sampling.phenomena)) continue;
      note(cand);
      const suggested = TAG_TO_ERROR_TYPE[r.tags[0]] ?? "other-natural";
      if (typeFilled[suggested] < typeQuota[suggested]) typeFilled[suggested]++;
    }
  }
  const screenCount = screenSel.count;

  // --- frame 3: injected. Closes the (register, error_type) cells the natural
  // screens could not reach — adjacent-key, casing, agreement, terminator and
  // run-together have no screen at all, by construction.
  const rng = mulberry32(seed ^ 0x5bf03635);
  const cleanPool = pool.items
    .map((item, i) => ({ item, tags: screened[i] }))
    .filter((r) => screenScore(r.tags) <= 1                // no error suspicion
      && r.item.sentence.length >= 25)
    .map((r) => ({ ...r, reasons: hardNegativeReasons(r.item.sentence) }))
    // A STRONG hard negative is worth more unmodified, in frame 4. A weak one
    // (a number, an initialism) is still a fine injection host — the transforms
    // never touch a number or a protected token, so damaging such a sentence
    // elsewhere produces an error item that ALSO carries the phenomenon.
    .filter((r) => r.reasons.length < 3);
  const cleanOrder = shuffled(cleanPool.map((_, i) => i), seed ^ 0x9e3779b9);

  const shortfall = ERROR_TYPES
    .filter((t) => !UNSEEDABLE_TYPES.includes(t))
    .map((t) => ({ t, need: Math.max(0, typeQuota[t] - typeFilled[t]) }))
    .filter((x) => x.need > 0);
  const totalShortfall = shortfall.reduce((n, x) => n + x.need, 0);
  const wantInject = Math.min(ceilOver(totalShortfall), ceilOver(budget.fill));
  const need = Object.fromEntries(shortfall.map((x) => [x.t, ceilOver(x.need)]));
  let injectCount = 0;
  const openTypes = new Set(shortfall.map((x) => x.t));
  const injectSel = reservingSelector(wantInject, filled, quotaOver);
  for (const pass of [0, 1, 2]) {
    injectSel.setPass(pass);
    for (const idx of cleanOrder) {
      if (injectSel.done || !openTypes.size) break;
      const r = cleanPool[idx];
      const uid0 = benchmarkUid(r.item.source_document_id, r.item.sentence);
      if (taken.has(uid0)) continue;
      const applicable = applicableTypes(r.item.sentence)
        .filter((t) => (need[t] ?? 0) > 0);
      if (!applicable.length) continue;
      // Prefer the emptiest open cell this sentence can serve.
      applicable.sort((a, b) => need[b] - need[a] || (a < b ? -1 : 1));
      const type = applicable[0];
      const res = inject(type, r.item.sentence, rng);
      if (!res) continue;
      const cand = makeCandidate(register, pool, r.item, "injected", {
        sentence: res.damaged,
        split: splitForGroup(r.item.exclusion_group_id, seed),
        screen_reasons: [],
        inject: {
          error_type: type,
          original: r.item.sentence,
          groups: res.groups,
          inject_version: INJECT_VERSION,
        },
      }, filled, quotaOver);
      if (taken.has(cand.uid)) continue;
      if (!injectSel.admit(cand.sampling.phenomena)) continue;
      note(cand);
      typeFilled[type] = Math.min(typeQuota[type], typeFilled[type] + 1);
      need[type]--;
      if (need[type] <= 0) openTypes.delete(type);
      injectCount++;
    }
  }

  // --- frame 4: hard negatives, plus the phenomenon top-up. Whatever the fill
  // budget has left, and then — explicitly and reported — as many more as the
  // still-short targeted phenomenon cells demand. A benchmark row that cannot
  // be filled is a finding; a benchmark row silently left at zero is a defect.
  const wantHard = Math.max(0, ceilOver(budget.fill) - injectCount);
  const hardPool = pool.items
    .map((item, i) => ({ item, tags: screened[i] }))
    .filter((r) => screenScore(r.tags) <= 1)
    .map((r) => ({ ...r, reasons: hardNegativeReasons(r.item.sentence) }))
    .filter((r) => r.reasons.length >= 1)
    .sort((a, b) => b.reasons.length - a.reasons.length
      || (a.item.source_document_id < b.item.source_document_id ? -1 : 1));
  const hardSel = reservingSelector(wantHard, filled, quotaOver);
  let hardCount = 0;
  for (const pass of [0, 1, 2]) {
    hardSel.setPass(pass);
    for (const r of hardPool) {
      if (hardSel.done) break;
      const uid = benchmarkUid(r.item.source_document_id, r.item.sentence);
      if (taken.has(uid)) continue;
      const cand = makeCandidate(register, pool, r.item, "hard-negative", {
        split: splitForGroup(r.item.exclusion_group_id, seed),
        screen_reasons: r.reasons,
      }, filled, quotaOver);
      if (!hardSel.admit(cand.sampling.phenomena)) continue;
      note(cand);
      hardCount++;
    }
  }

  // Top-up: the scarce rows the four budgeted frames could not reach. Drawn
  // from the whole pool, tagged `phenomenon-topup:<row>` so the report and the
  // labeler both show why the item is here, and counted separately from the
  // hard-negative budget rather than hidden inside it.
  let topupCount = 0;
  const topupOrder = shuffled(pool.items.map((_, i) => i), seed ^ 0x2545f491);
  for (const p of TARGETED_PHENOMENA) {
    let short = quotaOver[p] - filled[p];
    if (short <= 0) continue;
    for (const i of topupOrder) {
      if (short <= 0) break;
      const item = pool.items[i];
      const uid = benchmarkUid(item.source_document_id, item.sentence);
      if (taken.has(uid)) continue;
      const ph = detectPhenomena(item.sentence, { segmenterProduced: item.segmenterProduced });
      if (!ph.includes(p)) continue;
      const cand = makeCandidate(register, pool, item, "hard-negative", {
        split: splitForGroup(item.exclusion_group_id, seed),
        screen_reasons: [`phenomenon-topup:${p}`],
      }, filled, quotaOver);
      // Force the row this item was drawn for; the greedy would otherwise
      // credit it to whichever cell happened to be emptier and the top-up
      // would never converge.
      cand.sampling.primary_phenomenon = p;
      note(cand);
      hardCount++; topupCount++; short--;
    }
  }

  if (!out.length) die(`${register}: sampled 0 candidates — refusing to write an empty queue`);

  const realized = {
    frames: { random: randomCount, "natural-screen": screenCount, injected: injectCount, "hard-negative": hardCount },
    wanted: {
      random: wantRandom, "natural-screen": wantScreen,
      injected: wantInject, "hard-negative": wantHard,
    },
    topup: topupCount,
    phenomena: { ...filled },
    phenomenaQuota: quota,
    phenomenaQuotaOver: quotaOver,
    errorTypes: { ...typeFilled },
    errorTypeQuota: { ...typeQuota },
    injectedByType: {},
    splits: { dev: 0, sealed: 0 },
    poolSize: pool.items.length,
    episodesTotal: pool.episodes.size,
  };
  for (const c of out) {
    realized.splits[c.split]++;
    if (c.inject) {
      realized.injectedByType[c.inject.error_type] =
        (realized.injectedByType[c.inject.error_type] ?? 0) + 1;
    }
  }

  // The reservation: every message of every SAMPLED episode.
  const sampledGroups = new Set(out.map((c) => c.source.exclusion_group_id));
  const reserved = new Set();
  for (const g of sampledGroups) {
    const ids = pool.episodes.get(g);
    if (!ids) die(`${register}: sampled group ${g} has no episode — the pool and the reservation disagree`);
    for (const id of ids) reserved.add(id);
  }

  realized.funnel = pool.funnel ?? null;
  if (verbose) report(register, realized, out, sampledGroups, reserved);
  return {
    register, candidates: out, realized, sampledGroups, reserved,
    episodes: pool.episodes, benchmarkOnly: !!pool.benchmarkOnly,
  };
}

// =====================================================================
// REPORT + ARTIFACTS
// =====================================================================

function bar(n, q) {
  const flag = n >= q ? " " : (n === 0 ? "!!" : " <");
  return `${String(n).padStart(4)} / ${String(q).padEnd(4)}${flag}`;
}

function report(register, r, out, groups, reserved) {
  console.log(`\n=== ${register} — ${out.length} candidates `
    + `(target ${REGISTER_PLAN[register].total} x ${OVERSAMPLE} oversample) ===`);
  console.log(`pool: ${r.poolSize} sentence targets in ${r.episodesTotal} episodes`);
  if (r.funnel) {
    console.log("\npreprocessing funnel (raw units -> kept sentences):");
    for (const [stage, n] of r.funnel) {
      console.log(`  ${String(n).padStart(10)}  ${stage}`);
    }
  }
  console.log(`\nframe            realized / wanted`);
  for (const f of FRAMES) {
    console.log(`  ${f.padEnd(16)}${bar(r.frames[f], r.wanted[f])}`
      + (f === "hard-negative" && r.topup ? `   (incl. ${r.topup} phenomenon top-ups)` : ""));
  }
  console.log(`\nprimary phenomenon   realized / oversampled quota   (1x quota)`);
  for (const p of PHENOMENA) {
    console.log(`  ${p.padEnd(20)}${bar(r.phenomena[p], r.phenomenaQuotaOver[p])}`
      + `         ${String(r.phenomenaQuota[p]).padStart(4)}`);
  }
  console.log(`\nerror-type cell      pre-credited / 1x quota   injected`);
  for (const t of ERROR_TYPES) {
    if (UNSEEDABLE_TYPES.includes(t)) {
      console.log(`  ${t.padEnd(20)}   n/a  / ${String(r.errorTypeQuota[t]).padEnd(4)}  `
        + `filled at LABEL time from random + natural-screen`);
      continue;
    }
    console.log(`  ${t.padEnd(20)}${bar(r.errorTypes[t], r.errorTypeQuota[t])}`
      + `      ${String(r.injectedByType[t] ?? 0).padStart(4)}`);
  }
  console.log(`\nsplit: dev ${r.splits.dev} / sealed ${r.splits.sealed} `
    + `(group-atomic at DEV_FRACTION=${DEV_FRACTION})`);
  console.log(`reservation: ${groups.size} episodes -> ${reserved.size} message_ids`);
}

/**
 * The reservation filename per register. `chat-owner` keeps the historical name
 * because `scrub-discord.mjs` hard-codes it as its benchmark manifest, and a
 * rename there would silently produce an unreserved S1.
 */
const RESERVATION_FILE = {
  "chat-owner": "benchmark-reserved-message-ids.json",
  "chat-irc": "benchmark-reserved-ids-irc.json",
  "email-workplace": "benchmark-reserved-ids-enron.json",
  // Emitted for uniformity only: SE is benchmark-only, so there is no training
  // set for it to be excluded from. Stated in the file rather than assumed.
  "forum-comments": "benchmark-reserved-ids-se.json",
};

function writeArtifacts(results, seed) {
  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });
  for (const res of results) {
    const path = fileURLToPath(new URL(`benchmark-candidates-${res.register}.jsonl`, OUT_DIR));
    writeFileSync(path, res.candidates.map((c) => JSON.stringify(c)).join("\n") + "\n");
    console.log(`\nwrote ${path} (${res.candidates.length} candidates)`);

    const ids = [...res.reserved].sort();
    if (!ids.length) die(`${res.register}: reservation would be empty — refusing to write a no-op exclusion list`);
    const resPath = fileURLToPath(new URL(RESERVATION_FILE[res.register], OUT_DIR));
    writeFileSync(resPath, JSON.stringify({
      note: "Every source document id of every SAMPLED EPISODE, not merely the "
        + "sampled units. Reserving one message of a conversation and training "
        + "on the rest leaks the conversation.",
      consumed_by: res.register === "chat-owner"
        ? "scrub-discord.mjs --exclude, and training assembly"
        : "training assembly (and any future per-register scrubber)",
      benchmark_only: !!res.benchmarkOnly,
      training_set_exists: !res.benchmarkOnly,
      generated_by: "test/finetune/benchmark-sample.mjs",
      register: res.register,
      seed,
      inject_version: INJECT_VERSION,
      episodes: res.sampledGroups.size,
      message_ids: ids,
    }, null, 2) + "\n");
    console.log(`wrote ${resPath} (${res.sampledGroups.size} episodes, ${ids.length} ids)`);
  }
}

function printPlan() {
  console.log("register        total   dev sealed  clean error   random screen  fill");
  for (const r of REGISTERS) {
    const p = REGISTER_PLAN[r], b = frameBudget(r);
    console.log(`  ${r.padEnd(16)}${String(p.total).padStart(3)}`
      + `${String(p.dev).padStart(6)}${String(p.sealed).padStart(7)}`
      + `${String(p.clean).padStart(7)}${String(p.error).padStart(6)}`
      + `${String(b.random).padStart(9)}${String(b["natural-screen"]).padStart(7)}`
      + `${String(b.fill).padStart(6)}`);
  }
  console.log("\nerror-type x register (floor " + ERROR_TYPE_FLOOR + ")");
  console.log("  " + "type".padEnd(21) + REGISTERS.map((r) => r.slice(0, 9).padStart(10)).join("") + "     tot");
  for (const t of ERROR_TYPES) {
    const row = REGISTERS.map((r) => String(ERROR_TYPE_BY_REGISTER[r][t]).padStart(10)).join("");
    console.log("  " + t.padEnd(21) + row + String(ERROR_TYPE_TOTALS[t]).padStart(8));
  }
  console.log("\nphenomenon x register");
  console.log("  " + "phenomenon".padEnd(21) + REGISTERS.map((r) => r.slice(0, 9).padStart(10)).join(""));
  for (const p of PHENOMENA) {
    console.log("  " + p.padEnd(21)
      + REGISTERS.map((r) => String(PHENOMENON_BY_REGISTER[p][r]).padStart(10)).join(""));
  }
}

// ------------------------------------------------------------------- main

async function main(argv) {
  let registers = null, seed = DEFAULT_SEED, plan = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--registers") {
      const v = argv[++i];
      if (!v) die("--registers needs a comma-separated list");
      registers = v.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--seed") {
      seed = Number(argv[++i]);
      if (!Number.isFinite(seed)) die("--seed needs a number");
    } else if (a === "--plan") plan = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log("node test/finetune/benchmark-sample.mjs [--registers chat-owner]"
        + " [--seed N] [--plan] [--dry-run]");
      return;
    } else die(`unknown argument ${a}`);
  }
  if (plan) { printPlan(); return; }
  if (!registers) die("--registers is required (today: chat-owner). "
    + "Refusing to guess which pools you meant.");
  for (const r of registers) if (!REGISTERS.includes(r)) die(`unknown register: ${r}`);

  console.log(`benchmark-sample — seed ${seed}, inject ${INJECT_VERSION}, `
    + `oversample ${OVERSAMPLE}x`);
  const results = [];
  for (const r of registers) results.push(await sampleRegister(r, { seed }));
  if (dryRun) { console.log("\n--dry-run: no artifacts written"); return; }
  writeArtifacts(results, seed);
}

const invokedDirectly = process.argv[1]
  && existsSync(process.argv[1])
  && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main(process.argv.slice(2));
