// Multi-typo sentences, for the questions the main corpus cannot answer.
//
// Every case in sentence-corpus.mjs ERRORS is a SINGLE-typo sentence -- measured:
//
//     changedWordCount needed by the 40 error cases
//       1 -> 4      2 -> 35      3 -> 1
//
// So `maxChangedWords` is never exercised on the error side there, and neither
// is any rule about how several corrections compose. Raising that threshold
// 3 -> 4 -> 6 moved APPLIED not at all, which reads as "free" and is really
// "invisible". A threshold you cannot measure is a threshold you are guessing at.
//
// These are generated rather than hand-written so the expected output is exactly
// the clean sentence, with no judgement call about what the fix should be. The
// typo kinds are the ones that actually occur at speed, and each is a class the
// guards have historically got wrong:
//
//   transpose      "the" -> "teh"          Levenshtein charges 2 for this
//   drop           "technician" -> "techncian"
//   double         "bigger" -> "biggger"
//   dropFirst      "swim" -> "wim"         looks like a first-letter swap
//   deApostrophe   "don't" -> "dont"       reads as removing a negation
//   shiftStutter   "Where" -> "WHere"      reads as brand casing
//
// Deterministic: a fixed-seed LCG, so a run is reproducible and a regression is
// a real change rather than a reroll.

import { CLEAN } from "./sentence-corpus.mjs";

export function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

const KINDS = {
  transpose(w) {
    if (w.length < 3) return null;
    const i = 1 + Math.floor((w.length - 2) / 2);
    if (w[i] === w[i - 1]) return null;
    return w.slice(0, i - 1) + w[i] + w[i - 1] + w.slice(i + 1);
  },
  drop(w) {
    if (w.length < 5) return null;
    const i = 2 + ((w.length - 3) % 3);
    return w.slice(0, i) + w.slice(i + 1);
  },
  double(w) {
    if (w.length < 4) return null;
    const i = 2;
    return w.slice(0, i) + w[i] + w.slice(i);
  },
  dropFirst(w) {
    if (w.length < 4 || !/^[a-z]/.test(w)) return null;
    return w.slice(1);
  },
  deApostrophe(w) {
    if (!/['’]/.test(w)) return null;
    return w.replace(/['’]/g, "");
  },
  shiftStutter(w) {
    if (!/^[A-Z][a-z]{2,}$/.test(w)) return null;
    return w[0] + w[1].toUpperCase() + w.slice(2);
  },
};
const ORDER = ["transpose", "drop", "double", "dropFirst", "deApostrophe", "shiftStutter"];

/** Damage `n` distinct words of `sentence`, leaving punctuation attached. */
export function injure(sentence, n, rand) {
  const parts = sentence.split(/(\s+)/);
  const idx = parts.map((p, i) => i).filter((i) => /[A-Za-z]/.test(parts[i]));
  // Never touch the first word of the sentence twice, and shuffle so the
  // damage is not always at the front.
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  let done = 0;
  for (const i of idx) {
    if (done >= n) break;
    const token = parts[i];
    const m = token.match(/^([^A-Za-z]*)([A-Za-z'’]+)([^A-Za-z]*)$/);
    if (!m) continue;
    const [, pre, word, post] = m;
    // Leave short words alone: damaging "a" or "is" produces a different word
    // rather than a typo, and the expected output stops being obvious.
    if (word.replace(/['’]/g, "").length < 4) continue;
    const start = Math.floor(rand() * ORDER.length);
    for (let k = 0; k < ORDER.length; k++) {
      const kind = ORDER[(start + k) % ORDER.length];
      const bad = KINDS[kind](word);
      if (!bad || bad === word) continue;
      parts[i] = pre + bad + post;
      done++;
      break;
    }
  }
  return { text: parts.join(""), applied: done };
}

/**
 * `count` cases at each of 2, 3 and 4 typos per sentence.
 * Each is { in, expected, typos } -- `expected` is the untouched clean sentence.
 */
export function buildMultiTypoCases(count = 20, seed = 20260807) {
  const rand = lcg(seed);
  const out = [];
  // Long enough that four typos still clears the 0.6 overlap floor; that floor
  // is a separate decision and this set is not meant to argue with it.
  const pool = CLEAN.filter((s) => s.split(/\s+/).length >= 9);
  for (const typos of [2, 3, 4]) {
    for (let i = 0; i < count; i++) {
      const clean = pool[(i * 3 + typos) % pool.length];
      const { text, applied } = injure(clean, typos, rand);
      if (applied === typos && text !== clean) out.push({ in: text, expected: clean, typos });
    }
  }
  return out;
}

export const MULTI_TYPO = buildMultiTypoCases();
