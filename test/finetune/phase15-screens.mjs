// Phase 1.5 tempting-but-clean shape screens, shared by phase15-assemble.mjs
// (which re-emits certified v1 rows as matched negatives) and phase15-pool.mjs
// (which draws fresh candidates carrying the same shapes for teacher
// certification). One copy, because a screen that drifts between the two tools
// selects negatives the eval slice does not match.
//
// Each screen answers "does this text CONTAIN the tempting shape" — it says
// nothing about cleanliness; certification is the caller's problem (v1 rows
// are already certified, pool draws go to the teacher).

import { isWord } from "../lib/sentence-guards.mjs";

export const APOS_BARE = /\b(its|were|well|whose|your|their|lets)\b/i;
export const BRITISH = /\b(colou?r(?:s|ed|ing)?|behaviours?|organis(?:e|es|ed|ing|ations?)|analys(?:e|es|ed|ing)|centres?|licence[sd]?|favourites?|realis(?:e|es|ed|ing)|programmes?|apologis(?:e|es|ed|ing)|catalogues?|travell(?:ed|ing|er)|cancell(?:ed|ing)|metres?|theatres?|defence|offence|grey)\b/;

export const bareTok = (w) => String(w).toLowerCase().replace(/^[^a-z']+|[^a-z']+$/g, "");

/** Adjacent word pair whose join is itself a dictionary word. */
export const joinablePair = (s) => {
  const toks = String(s).split(/\s+/).map(bareTok).filter(Boolean);
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (a.length >= 3 && b.length >= 3 && isWord(a) && isWord(b) && isWord(a + b)) return true;
  }
  return false;
};

/**
 * The shape screens. `opts.hasConfusableTok` is supplied by the caller because
 * it depends on the loaded confusable pair list and the eval-family holdout,
 * which are the caller's state; `opts.segmenterProduced(r)` likewise, because
 * the two tools carry that bit in different places (v1 lineage vs pool item).
 * Each screen takes ({ text, segmenterProduced }) normalized by the caller.
 */
export function shapeScreens({ hasConfusableTok }) {
  return {
    "doubled-word": (r) => /\b([A-Za-z']+)[ \t]+\1\b/i.test(r.text),
    "homophone-confusable": (r) => hasConfusableTok(r.text),
    "dropped-apostrophe": (r) => APOS_BARE.test(r.text),
    "terminator": (r) => /([?!]{2,}|[?!]['")\]]+)\s*$/.test(r.text.trim()),
    "moved-space": (r) => joinablePair(r.text),
    "casing-hardwrap": (r) => r.segmenterProduced === true && /^[a-z]/.test(r.text),
    "casing-brand": (r) => /\b(?:[a-z]+[A-Z][A-Za-z]*|[A-Z]{2,}[a-z]*)\b/.test(r.text.replace(/\bI\b/g, "")),
    "quote-boundary": (r) => /"[^"]{3,}"|“[^”]{3,}”|'[^']{6,}'/.test(r.text),
    "code-token": (r) => /`[^`]+`|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\(|\b\w+\(\)|(?:^|\s)[\w.~/-]*\/[\w.-]+/.test(r.text),
    "hardwrap-extra": (r) => r.segmenterProduced === true && /^[a-z]/.test(r.text),
    "british-spelling": (r) => BRITISH.test(r.text),
  };
}
