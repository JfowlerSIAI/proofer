// Versioned, REVERSIBLE error-injection transforms — one per measured taxonomy
// class (plan §6.1; schema ERROR_TYPES minus `other-natural`, which is by
// definition not something a transform produces).
//
// Why reversibility is the contract rather than a nicety: an injected benchmark
// item's gold label is the ORIGINAL sentence, so the injection is only usable as
// supervision if applying every group's primary replacement to the damaged
// string reproduces the clean input EXACTLY. `error-inject-test.mjs` asserts
// that per fixture; a transform that cannot state its own inverse returns null
// instead of guessing.
//
// Offsets are UTF-16 code units into the DAMAGED sentence, half-open, matching
// benchmark-schema.mjs. `before` is the damaged slice, and each alternative's
// `replacement` is the restoring text — i.e. the same shape the labeler emits,
// so an injected candidate can be prefilled without a second code path.
//
// PROTECTED REGIONS. No transform touches a URL, a code span, a mention/emoji
// token, or any token containing a digit. Those are the shapes the shipping
// guards protect (`PROTECTED` in background.js) and the shapes a benchmark must
// contain UNDAMAGED, because "does the model leave a URL alone" is one of the
// phenomena being measured. Damaging one would make the item test the wrong
// thing.
//
// KNOWN OVERLAP, recorded rather than papered over: `moved-space` with its
// `deleted` variant and `run-together` are the same mechanical operation. They
// are separated by evidence, not by mechanism — `run-together` requires BOTH
// sides to be dictionary words of length >= 3 (a genuine compound: `real estate`
// -> `realestate`), `moved-space` does not and prefers the shifting variants
// (`we know` -> `w eknow` / `wek now`). The taxonomy distinguishes them because
// the repair differs in kind, not because the keystroke does.
//
// No side effects at import beyond loading the shipping confusables file (the
// homophone transform needs the licensed pair list, and re-typing it here would
// be a second copy of a curated artifact).

import {
  CONFUSABLE, fetchConfusables, diskFetch, isWord,
} from "../lib/sentence-guards.mjs";
import { ERROR_TYPES } from "./benchmark-schema.mjs";

export const INJECT_VERSION = "v1";

/** Every class a transform exists for: the taxonomy minus `other-natural`. */
export const INJECTABLE_TYPES = Object.freeze(
  ERROR_TYPES.filter((t) => t !== "other-natural"));

// --------------------------------------------------------------- protection

const PROTECT_RES = [
  /```[\s\S]*?```/g,            // fenced code
  /`[^`\n]*`/g,                 // inline code
  /\bhttps?:\/\/\S+/gi,         // URLs
  /\bwww\.\S+/gi,
  /<a?:\w+:\d+>/g,              // custom emoji
  /<@[!&]?\d+>|<#\d+>/g,        // mentions / channel refs
  /@\S+/g,                      // bare @handles
  /:[a-z0-9_+-]{2,}:/gi,        // :shortcode:
  /\S*[\p{L}\p{N}]@[\p{L}\p{N}][\S]*/gu, // email-ish
];

/** A boolean mask over `s`: true where a transform must not touch. */
export function protectedMask(s) {
  const mask = new Array(s.length).fill(false);
  for (const re of PROTECT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = true;
    }
  }
  return mask;
}

// Word tokens with offsets. Deliberately narrower than edit-groups.mjs's
// tokenizer: a transform needs LETTER runs (with interior apostrophes and
// hyphens), and anything carrying a digit or an underscore is protected.
const TOKEN_RE = /[\p{L}][\p{L}\p{N}_'’-]*/gu;

/**
 * Injectable word tokens: letter-initial, digit-free, underscore-free, and
 * entirely outside every protected region.
 */
export function wordTokens(s) {
  const mask = protectedMask(s);
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s)) !== null) {
    const text = m[0], start = m.index, end = start + text.length;
    if (/[\p{N}_]/u.test(text)) continue;
    let clean = true;
    for (let i = start; i < end; i++) if (mask[i]) { clean = false; break; }
    if (!clean) continue;
    out.push({ text, start, end });
  }
  return out;
}

// ------------------------------------------------------------------ helpers

function pick(list, rng) {
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/**
 * The one group-construction primitive. Replaces `clean[start,end)` with
 * `damagedText` and emits the group that undoes it, with offsets into the
 * DAMAGED string.
 */
function spanEdit(clean, start, end, damagedText, error_type) {
  const original = clean.slice(start, end);
  if (damagedText === original) return null;
  const damaged = clean.slice(0, start) + damagedText + clean.slice(end);
  return {
    damaged,
    groups: [{
      id: "g1",
      start_utf16: start,
      end_utf16: start + damagedText.length,
      before: damagedText,
      requirement: "required-correction",
      error_type,
      alternatives: [{ id: "a1", replacement: original }],
    }],
  };
}

const isLetters = (t) => /^[A-Za-z]+$/.test(t);
const lower = (t) => t.toLowerCase();

/** Copy `model`'s leading-capital shape onto `word`. */
function matchCase(word, model) {
  if (/^[A-Z]/.test(model)) return word.charAt(0).toUpperCase() + word.slice(1);
  return word;
}

// ------------------------------------------------------------- QWERTY layout

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
// Physical stagger, so `s` neighbours `w` and `e` rather than only `w`.
const ROW_STAGGER = [0, 0.25, 0.75];

/** key -> sorted array of physically adjacent keys. Built once, deterministic. */
export const QWERTY_NEIGHBOURS = (() => {
  const pos = new Map();
  KEY_ROWS.forEach((row, r) => {
    [...row].forEach((ch, c) => pos.set(ch, { r, x: c + ROW_STAGGER[r] }));
  });
  const map = new Map();
  for (const [ch, a] of pos) {
    const near = [];
    for (const [other, b] of pos) {
      if (other === ch) continue;
      if (Math.abs(a.r - b.r) > 1) continue;
      if (Math.abs(a.x - b.x) > 1.0001) continue;
      near.push(other);
    }
    map.set(ch, near.sort());
  }
  return map;
})();

// -------------------------------------------------------- confusable licences

/**
 * The licensed directed pairs, as meant -> [typed]. Damaging means writing the
 * TYPED side where the MEANT side belongs, which is the direction the licence
 * describes; the restoring replacement is the original token.
 *
 * Hand list + the generated artifact, loaded through the SHIPPING loader so a
 * corrupt file degrades here exactly as it degrades in the extension.
 */
export const CONFUSABLE_BY_MEANT = await (async () => {
  const pairs = new Set(CONFUSABLE);
  const loaded = await fetchConfusables(diskFetch());
  if (!loaded) {
    throw new Error(
      "data/confusables-en.txt failed the shipping loader's integrity check — "
      + "run `node test/build-confusables.mjs`. Refusing to inject homophones "
      + "from the hand list alone, which would silently narrow the class.");
  }
  for (const k of loaded) pairs.add(k);
  const byMeant = new Map();
  for (const k of pairs) {
    const [typed, meant] = k.split("|");
    // Single-token both sides: the transform substitutes one token for one
    // token. `everyday|every day` and `alot|a lot` are multi-token on one side
    // and are handled by run-together / moved-space, not here.
    if (!typed || !meant) continue;
    if (/\s/.test(typed) || /\s/.test(meant)) continue;
    if (typed === meant) continue;
    if (!byMeant.has(meant)) byMeant.set(meant, []);
    byMeant.get(meant).push(typed);
  }
  for (const v of byMeant.values()) v.sort();
  return byMeant;
})();

// ------------------------------------------------------------- contractions

const CONTRACTION_RE = /^[A-Za-z]+['’][A-Za-z]{1,3}$/;

// Auxiliary/irregular forms an s-inflection rule must never touch, plus the
// short words where `X` and `Xs` are both dictionary words for unrelated
// reasons. Enumerated because the damage direction is a meaning change, not a
// typo — the standing asymmetry says refuse rather than guess.
const AGREEMENT_STOP = new Set([
  "is", "was", "has", "does", "goes", "says", "as", "us", "his", "hers",
  "its", "this", "thus", "plus", "gas", "bus", "less", "unless", "yes",
  "always", "perhaps", "news", "series", "means", "class", "pass", "miss",
  "was", "were", "been", "being", "am", "are", "be", "had", "did", "done",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
]);

const SUBJ_SINGULAR = /\b(he|she|it|He|She|It)\s+([A-Za-z]{4,})\b/g;
const SUBJ_PLURAL = /\b(they|we|you|I|They|We|You)\s+([A-Za-z]{4,})\b/g;

// ------------------------------------------------------------- the transforms

const TRANSFORMS = {
  transposition(clean, rng) {
    const cands = [];
    for (const t of wordTokens(clean)) {
      if (!isLetters(t.text) || t.text.length < 4) continue;
      for (let i = 1; i + 1 < t.text.length; i++) {
        if (t.text[i] === t.text[i + 1]) continue;
        cands.push({ t, i });
      }
    }
    const c = pick(cands, rng);
    if (!c) return null;
    const w = c.t.text;
    const dmg = w.slice(0, c.i) + w[c.i + 1] + w[c.i] + w.slice(c.i + 2);
    return spanEdit(clean, c.t.start, c.t.end, dmg, "transposition");
  },

  "adjacent-key"(clean, rng) {
    const cands = [];
    for (const t of wordTokens(clean)) {
      if (!isLetters(t.text) || t.text.length < 3) continue;
      for (let i = 0; i < t.text.length; i++) {
        const ch = t.text[i].toLowerCase();
        const near = QWERTY_NEIGHBOURS.get(ch);
        if (near && near.length) cands.push({ t, i, near });
      }
    }
    const c = pick(cands, rng);
    if (!c) return null;
    const repl = pick(c.near, rng);
    const w = c.t.text;
    const sub = /[A-Z]/.test(w[c.i]) ? repl.toUpperCase() : repl;
    const dmg = w.slice(0, c.i) + sub + w.slice(c.i + 1);
    return spanEdit(clean, c.t.start, c.t.end, dmg, "adjacent-key");
  },

  "moved-space"(clean, rng) {
    const pairs = adjacentPairs(clean, 2, 2, false);
    const c = pick(pairs, rng);
    if (!c) return null;
    const variants = [];
    if (c.a.length >= 2) variants.push("left");
    if (c.b.length >= 2) variants.push("right");
    variants.push("deleted");
    const v = pick(variants, rng);
    const dmg = v === "left" ? c.a.slice(0, -1) + " " + c.a.slice(-1) + c.b
      : v === "right" ? c.a + c.b[0] + " " + c.b.slice(1)
        : c.a + c.b;
    return spanEdit(clean, c.start, c.end, dmg, "moved-space");
  },

  "doubled-word"(clean, rng) {
    const cands = wordTokens(clean)
      .filter((t) => isLetters(t.text) && t.text.length >= 2);
    const c = pick(cands, rng);
    if (!c) return null;
    return spanEdit(clean, c.start, c.end, c.text + " " + c.text, "doubled-word");
  },

  "held-shift-stutter"(clean, rng) {
    const cands = wordTokens(clean).filter((t) =>
      /^[A-Za-z]{3,}$/.test(t.text)
      && !/^[A-Z]{2}/.test(t.text)
      && t.text !== t.text.toUpperCase());
    const c = pick(cands, rng);
    if (!c) return null;
    const dmg = c.text.slice(0, 2).toUpperCase() + c.text.slice(2);
    return spanEdit(clean, c.start, c.end, dmg, "held-shift-stutter");
  },

  "semicolon-apostrophe"(clean, rng) {
    const cands = wordTokens(clean).filter((t) =>
      CONTRACTION_RE.test(t.text) && /[A-Za-z]['’][A-Za-z]/.test(t.text));
    const c = pick(cands, rng);
    if (!c) return null;
    const dmg = c.text.replace(/['’]/, ";");
    return spanEdit(clean, c.start, c.end, dmg, "semicolon-apostrophe");
  },

  "dropped-apostrophe"(clean, rng) {
    const cands = wordTokens(clean).filter((t) => /['’]/.test(t.text));
    const c = pick(cands, rng);
    if (!c) return null;
    const dmg = c.text.replace(/['’]/g, "");
    if (!dmg.length) return null;
    return spanEdit(clean, c.start, c.end, dmg, "dropped-apostrophe");
  },

  "homophone-confusable"(clean, rng) {
    const cands = [];
    for (const t of wordTokens(clean)) {
      const key = lower(t.text).replace(/’/g, "'");
      const typedList = CONFUSABLE_BY_MEANT.get(key);
      if (typedList && typedList.length) cands.push({ t, typedList });
    }
    const c = pick(cands, rng);
    if (!c) return null;
    const typed = pick(c.typedList, rng);
    const dmg = matchCase(typed, c.t.text);
    return spanEdit(clean, c.t.start, c.t.end, dmg, "homophone-confusable");
  },

  "run-together"(clean, rng) {
    const pairs = adjacentPairs(clean, 3, 3, true);
    const c = pick(pairs, rng);
    if (!c) return null;
    return spanEdit(clean, c.start, c.end, c.a + c.b, "run-together");
  },

  terminator(clean, rng) {
    const m = /([.!?]+)\s*$/.exec(clean);
    if (!m) return null;                     // nothing to drop; adding one is a FIX
    const run = m[1];
    const start = m.index, end = m.index + run.length;
    const variant = rng() < 0.7 ? "drop" : "extra";
    const dmg = variant === "drop" ? "" : run + run[run.length - 1];
    return spanEdit(clean, start, end, dmg, "terminator");
  },

  casing(clean, rng) {
    const toks = wordTokens(clean);
    const cands = [];
    // Non-initial capitalised token (a name, a proper noun, `I`).
    for (const t of toks) {
      if (t.start === 0) continue;
      if (!/^[A-Z]/.test(t.text)) continue;
      // Not the first word after a terminator — that capital is a rule, and
      // lowercasing it produces a segmenter artefact rather than a casing typo.
      if (/[.!?]["'’)\]]*\s+$/.test(clean.slice(0, t.start))) continue;
      cands.push({ kind: "lower-noninitial", t });
    }
    if (/^[A-Z]/.test(clean)) cands.push({ kind: "decap-start", t: toks[0] });
    const c = pick(cands, rng);
    if (!c) return null;
    if (c.kind === "decap-start") {
      return spanEdit(clean, 0, 1, clean[0].toLowerCase(), "casing");
    }
    const dmg = c.t.text.charAt(0).toLowerCase() + c.t.text.slice(1);
    return spanEdit(clean, c.t.start, c.t.end, dmg, "casing");
  },

  agreement(clean, rng) {
    const mask = protectedMask(clean);
    const clear = (s, e) => { for (let i = s; i < e; i++) if (mask[i]) return false; return true; };
    const cands = [];
    let m;
    SUBJ_SINGULAR.lastIndex = 0;
    while ((m = SUBJ_SINGULAR.exec(clean)) !== null) {
      const verb = m[2], vs = lower(verb);
      if (AGREEMENT_STOP.has(vs) || !vs.endsWith("s") || vs.endsWith("ss")) continue;
      const stem = vs.slice(0, -1);
      if (stem.length < 4 || AGREEMENT_STOP.has(stem)) continue;
      if (!isWord(vs) || !isWord(stem)) continue;
      const vStart = m.index + m[0].length - verb.length;
      if (!clear(vStart, vStart + verb.length)) continue;
      cands.push({ start: vStart, end: vStart + verb.length, dmg: verb.slice(0, -1) });
    }
    SUBJ_PLURAL.lastIndex = 0;
    while ((m = SUBJ_PLURAL.exec(clean)) !== null) {
      const verb = m[2], vs = lower(verb);
      if (AGREEMENT_STOP.has(vs) || vs.endsWith("s")) continue;
      if (vs.length < 4 || !isWord(vs) || !isWord(vs + "s")) continue;
      const vStart = m.index + m[0].length - verb.length;
      if (!clear(vStart, vStart + verb.length)) continue;
      cands.push({ start: vStart, end: vStart + verb.length, dmg: verb + "s" });
    }
    const c = pick(cands, rng);
    if (!c) return null;
    return spanEdit(clean, c.start, c.end, c.dmg, "agreement");
  },
};

/**
 * Adjacent injectable word tokens separated by EXACTLY one space.
 * `requireDictionary` additionally demands both sides be dictionary words
 * (the run-together compound test).
 */
function adjacentPairs(clean, minA, minB, requireDictionary) {
  const toks = wordTokens(clean);
  const out = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    const a = toks[i], b = toks[i + 1];
    if (b.start - a.end !== 1 || clean[a.end] !== " ") continue;
    if (!isLetters(a.text) || !isLetters(b.text)) continue;
    if (a.text.length < minA || b.text.length < minB) continue;
    if (requireDictionary && !(isWord(lower(a.text)) && isWord(lower(b.text)))) continue;
    out.push({ a: a.text, b: b.text, start: a.start, end: b.end });
  }
  return out;
}

/**
 * Damage `cleanSentence` with one transform of class `type`.
 *
 * @param {string} type      one of INJECTABLE_TYPES
 * @param {string} cleanSentence
 * @param {() => number} rng uniform [0,1) — seed it for reproducibility
 * @returns {{damaged: string, groups: object[]} | null}  null = inapplicable
 */
export function inject(type, cleanSentence, rng) {
  const fn = TRANSFORMS[type];
  if (!fn) {
    throw new Error(`error-inject: unknown type ${JSON.stringify(type)} — `
      + `expected one of ${INJECTABLE_TYPES.join(", ")}`);
  }
  if (typeof rng !== "function") throw new Error("error-inject: rng must be a function");
  const s = String(cleanSentence);
  if (!s.trim()) return null;
  const res = fn(s, rng);
  if (!res) return null;
  // Self-check: a transform that cannot be undone is a bug, not a variant.
  if (restore(res.damaged, res.groups) !== s) {
    throw new Error(`error-inject: ${type} produced a non-reversible edit on `
      + `${JSON.stringify(s.slice(0, 60))}`);
  }
  return res;
}

/**
 * Apply every group's PRIMARY replacement to `damaged`. For an injection this
 * is the inverse of the transform; the labeler uses the same shape.
 */
export function restore(damaged, groups) {
  const sorted = groups.slice().sort((a, b) => a.start_utf16 - b.start_utf16);
  let out = "", pos = 0;
  for (const g of sorted) {
    if (g.start_utf16 < pos) throw new Error("error-inject: overlapping groups");
    out += damaged.slice(pos, g.start_utf16) + g.alternatives[0].replacement;
    pos = g.end_utf16;
  }
  return out + damaged.slice(pos);
}

/**
 * Which classes can damage this sentence at all — used by the sampler to fill
 * an open (register, error_type) cell without trial-and-error at call sites.
 *
 * Probed with a FIXED rng so applicability is a property of the sentence rather
 * than of where the caller's stream happened to be; the real injection then
 * draws from the caller's seeded stream.
 */
export function applicableTypes(cleanSentence) {
  const fixed = () => 0;
  return INJECTABLE_TYPES.filter((t) => inject(t, cleanSentence, fixed) !== null);
}

// Recorded so a caller can stamp what the artifact was built against without
// re-reading the file.
export const CONFUSABLE_MEANT_KEYS = CONFUSABLE_BY_MEANT.size;
