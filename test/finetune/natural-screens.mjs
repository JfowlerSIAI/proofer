// Teacher-independent "this sentence probably contains an error" screens.
//
// NEVER a model call. The benchmark's error slice has to be sampled before any
// teacher exists, and a screen that consulted a model would make the benchmark
// a measurement of that model's recall rather than of the sentences. Every
// screen here is lexical, runs offline in microseconds, and reuses the SHIPPING
// dictionary and confusable licences out of background.js rather than a second
// copy (`test/lib/sentence-guards.mjs` is the seam; a mirrored word list is how
// a screen and a guard drift apart while both stay green).
//
// A screen is a SUSPICION, not a verdict. `screen()` returns tags; the owner's
// label decides. The sampler uses the tags twice — to rank candidates into the
// `natural-screen` frame, and to SUGGEST an error_type for the labeler's
// number-key override — and nothing downstream treats a tag as ground truth.
//
// The reachable-set caveat is worth stating where the code lives: everything a
// word list can see, `guardSentenceResult` can also see, so these screens are
// blind to exactly the class the guards are blind to — real-word -> real-word
// substitution with no licence (`in` -> `for`, `is is` -> `I am`). That class is
// what the `random` sampling frame and human review are for. Dictionary
// prefiltering cannot establish that the original sentence is correct.
//
// No side effects at import beyond the guards' own dictionary/confusable load.

import { isWord, CONFUSABLE, fetchConfusables, diskFetch } from "../lib/sentence-guards.mjs";
import {
  endsWithAbbreviation, hasUnbalancedOpener, endsMidNumber,
} from "../lib/content-sandbox.mjs";

/** Every tag `screen()` can emit, in report order. */
export const SCREEN_TAGS = Object.freeze([
  "uniqueDamerau1", "movedSpaceRepair", "doubledToken", "heldShift",
  "semicolonApostrophe", "contractionError", "licensedConfusableSuspect",
  "segmenterEdge",
]);

/**
 * A screen tag's best guess at the taxonomy class, for the labeler's suggested
 * `error_type`. A guess, shown and overridable — never written as a label.
 */
export const TAG_TO_ERROR_TYPE = Object.freeze({
  uniqueDamerau1: "transposition",       // the commonest distance-1 shape
  movedSpaceRepair: "moved-space",
  doubledToken: "doubled-word",
  heldShift: "held-shift-stutter",
  semicolonApostrophe: "semicolon-apostrophe",
  contractionError: "dropped-apostrophe",
  licensedConfusableSuspect: "homophone-confusable",
  segmenterEdge: "other-natural",
});

// ------------------------------------------------------------- masking

// Same shapes error-inject.mjs protects: a screen that fires on a URL or a code
// span is a false positive by construction, and the benchmark wants those
// sentences sampled as CLEAN phenomena rather than as suspected errors.
const MASK_RES = [
  /```[\s\S]*?```/g, /`[^`\n]*`/g,
  /\bhttps?:\/\/\S+/gi, /\bwww\.\S+/gi,
  /<a?:\w+:\d+>/g, /<@[!&]?\d+>|<#\d+>/g, /@\S+/g,
  /:[a-z0-9_+-]{2,}:/gi,
  /\S*[\p{L}\p{N}]@[\p{L}\p{N}][\S]*/gu,
];

/** Replace protected runs with spaces of the SAME LENGTH, so offsets survive. */
export function maskProtected(s) {
  let out = String(s);
  for (const re of MASK_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => " ".repeat(m.length));
  }
  return out;
}

const TOKEN_RE = /[\p{L}][\p{L}\p{N}_'’;-]*/gu;

/** Screenable tokens: letter-initial, digit-free, underscore-free, unmasked. */
export function screenTokens(s) {
  const masked = maskProtected(s);
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(masked)) !== null) {
    if (/[\p{N}_]/u.test(m[0])) continue;
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const bare = (t) => t.replace(/^['’;]+|['’;]+$/g, "").replace(/’/g, "'").toLowerCase();

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * Every dictionary word at Damerau distance exactly 1 from `w` (deletions,
 * substitutions, insertions, adjacent transpositions), as a Set.
 *
 * The same enumeration `closerWordExists` runs in background.js — ~52L+26 Set
 * lookups — restated here rather than exported from there because the guard's
 * version answers "is anything strictly closer" and this one needs the members.
 */
export function damerau1Words(w) {
  const found = new Set();
  const L = w.length;
  for (let i = 0; i < L; i++) {
    const d = w.slice(0, i) + w.slice(i + 1);
    if (d.length >= 2 && isWord(d)) found.add(d);
  }
  for (let i = 0; i < L; i++) {
    for (const c of LETTERS) {
      if (c === w[i]) continue;
      const s = w.slice(0, i) + c + w.slice(i + 1);
      if (isWord(s)) found.add(s);
    }
  }
  for (let i = 0; i <= L; i++) {
    for (const c of LETTERS) {
      const s = w.slice(0, i) + c + w.slice(i);
      if (isWord(s)) found.add(s);
    }
  }
  for (let i = 0; i + 1 < L; i++) {
    if (w[i] === w[i + 1]) continue;
    const s = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
    if (isWord(s)) found.add(s);
  }
  found.delete(w);
  return found;
}

// ------------------------------------------------------- confusable licences

/** typed -> true for every licensed directed pair's TYPED side. */
export const CONFUSABLE_TYPED = await (async () => {
  const set = new Set();
  const add = (k) => { const t = k.split("|")[0]; if (t && !/\s/.test(t)) set.add(t); };
  for (const k of CONFUSABLE) add(k);
  const loaded = await fetchConfusables(diskFetch());
  if (!loaded) {
    throw new Error("data/confusables-en.txt failed the shipping loader's "
      + "integrity check — run `node test/build-confusables.mjs`. Screening on "
      + "the hand list alone would silently narrow the confusable class.");
  }
  for (const k of loaded) add(k);
  return set;
})();

// -------------------------------------------------------------- contractions

// Contractions whose de-apostrophised form is the error shape.
const DEAPOSTROPHISED = new Map(Object.entries({
  dont: "don't", cant: "can't", wont: "won't", isnt: "isn't", wasnt: "wasn't",
  arent: "aren't", werent: "weren't", didnt: "didn't", doesnt: "doesn't",
  havent: "haven't", hasnt: "hasn't", hadnt: "hadn't", couldnt: "couldn't",
  shouldnt: "shouldn't", wouldnt: "wouldn't", aint: "ain't",
  im: "I'm", ive: "I've", ill: "I'll", id: "I'd",
  youre: "you're", youve: "you've", youll: "you'll",
  weve: "we've", wed: "we'd",
  theyre: "they're", theyve: "they've", theyll: "they'll",
  thats: "that's", theres: "there's", heres: "here's", whats: "what's",
  whos: "who's", lets: "let's", shes: "she's", hes: "he's",
}));

// A de-apostrophised form that is ALSO a dictionary word is ambiguous, and a
// screen that fires on the ambiguous ones fills the error slice with clean
// sentences: `ill`, `id`, `wed`, `lets`, `whats` and `were` all have a common
// plain-word reading, and `we're` -> `were` is unscreenable for exactly that
// reason (it is the real-word -> real-word class the header names). The four
// below are the exceptions — in chat register the contraction reading
// dominates by enough to be worth the false positives. Everything else fires
// only when the form is NOT a dictionary word, checked at call time so a
// dictionary edit moves the screen with it.
const AMBIGUOUS_WORTH_SCREENING = new Set(["cant", "wont", "hes", "shes"]);

// ------------------------------------------------------------------ screens

function uniqueDamerau1(toks) {
  for (const t of toks) {
    const b = bare(t.text);
    if (b.length < 3 || b.length > 18) continue;
    if (/[';]/.test(b)) continue;
    if (isWord(b)) continue;
    // A capitalised non-initial token is a name until proved otherwise — the
    // dictionary deliberately holds no proper nouns, so every name would screen
    // as a typo and the error slice would fill with them.
    if (t.start > 0 && /^[A-Z]/.test(t.text)) continue;
    if (/^[A-Z]{2,}$/.test(t.text)) continue;
    const stem = b.replace(/'s$/, "");
    if (isWord(stem)) continue;
    if (b.endsWith("s") && isWord(b.slice(0, -1))) continue;
    const near = damerau1Words(b);
    if (near.size === 1) return true;
  }
  return false;
}

function movedSpaceRepair(toks, s) {
  // A single non-word token that splits into two dictionary words: the
  // `filtererrors` -> `filter errors` shape, which has no token PAIR to look at
  // and is the repo's own headline example of the class.
  for (const t of toks) {
    const b = bare(t.text);
    if (b.length < 6 || b.length > 24 || !/^[a-z]+$/.test(b) || isWord(b)) continue;
    if (t.start > 0 && /^[A-Z]/.test(t.text)) continue;   // names, see uniqueDamerau1
    for (let k = 3; k + 3 <= b.length; k++) {
      if (isWord(b.slice(0, k)) && isWord(b.slice(k))) return true;
    }
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (b.start - a.end !== 1) continue;
    const at = bare(a.text), bt = bare(b.text);
    if (!/^[a-z]+$/.test(at) || !/^[a-z]+$/.test(bt)) continue;
    // Only worth asking when at least one side is not a word: two real words
    // separated by a space is the ordinary case and repairing it is the
    // `the rapist` -> `therapist` hazard, not a screen hit.
    if (isWord(at) && isWord(bt)) continue;
    const joined = at + bt;
    if (joined.length > 24) continue;
    if (isWord(joined)) return true;
    for (let k = 1; k < joined.length; k++) {
      const l = joined.slice(0, k), r = joined.slice(k);
      if (l === at) continue;              // the boundary as typed
      if (l.length < 2 || r.length < 2) continue;
      if (isWord(l) && isWord(r)) return true;
    }
  }
  void s;
  return false;
}

function doubledToken(toks) {
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = bare(toks[i].text), b = bare(toks[i + 1].text);
    if (a.length >= 2 && a === b) return true;
  }
  return false;
}

// The held-shift shape, asked directly rather than through the guards'
// `isShiftStutter`: that function is a PROTECTION decision (may the model touch
// this token) and carries carve-outs — calendar names, near-miss rescue — that
// a screen must not inherit. Two leading capitals on an otherwise lowercase
// word is the shape.
function heldShift(toks) {
  return toks.some((t) => /^[A-Z]{2}[a-z]{1,}$/.test(t.text)
    && !/^[A-Z]{3,}$/.test(t.text));
}

function semicolonApostrophe(s) {
  return /[A-Za-z];(?:t|s|d|m|re|ve|ll)\b/.test(maskProtected(s));
}

function contractionError(toks) {
  for (const t of toks) {
    const b = bare(t.text);
    if (!b || !DEAPOSTROPHISED.has(b)) continue;
    if (AMBIGUOUS_WORTH_SCREENING.has(b) || !isWord(b)) return true;
  }
  return false;
}

function licensedConfusableSuspect(toks) {
  for (const t of toks) {
    const b = bare(t.text);
    if (b.length < 2) continue;
    if (CONFUSABLE_TYPED.has(b)) return true;
  }
  return false;
}

// The repo's three documented weak-boundary shapes, asked through the SHIPPING
// predicates so a segmenter change moves the screen with it.
function segmenterEdge(s) {
  return endsMidNumber(s) || hasUnbalancedOpener(s) || endsWithAbbreviation(s);
}

/**
 * Screen one sentence. Returns the tags that fired, in SCREEN_TAGS order.
 *
 * @param {string} sentence
 * @returns {string[]}
 */
export function screen(sentence) {
  const s = String(sentence ?? "");
  if (!s.trim()) return [];
  const toks = screenTokens(s);
  const tags = [];
  if (uniqueDamerau1(toks)) tags.push("uniqueDamerau1");
  if (movedSpaceRepair(toks, s)) tags.push("movedSpaceRepair");
  if (doubledToken(toks)) tags.push("doubledToken");
  if (heldShift(toks)) tags.push("heldShift");
  if (semicolonApostrophe(s)) tags.push("semicolonApostrophe");
  if (contractionError(toks)) tags.push("contractionError");
  if (licensedConfusableSuspect(toks)) tags.push("licensedConfusableSuspect");
  if (segmenterEdge(s)) tags.push("segmenterEdge");
  return tags;
}

/**
 * Rank weight for the `natural-screen` frame. The confusable suspect tag fires
 * on ~60% of ordinary English (the commonest confusions are between the
 * commonest words — measured in `prefilter-probe.mjs`), so it is worth almost
 * nothing on its own and is weighted accordingly; a tag that implies a NON-WORD
 * is present is worth much more.
 */
export const TAG_WEIGHT = Object.freeze({
  uniqueDamerau1: 10,
  movedSpaceRepair: 9,
  semicolonApostrophe: 9,
  heldShift: 7,
  doubledToken: 6,
  contractionError: 4,
  segmenterEdge: 3,
  licensedConfusableSuspect: 1,
});

export function screenScore(tags) {
  return tags.reduce((n, t) => n + (TAG_WEIGHT[t] ?? 0), 0);
}
