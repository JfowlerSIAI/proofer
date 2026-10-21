#!/usr/bin/env node
// Build data/confusables-en.txt -- the loaded half of the CONFUSABLE list --
// and the integrity constants in background.js that gate loading it.
//
//   node build-confusables.mjs                 # rebuild from the vendored inputs
//   node build-confusables.mjs --fetch         # re-download, re-pin and re-vendor
//   node build-confusables.mjs --report        # print the rejected pairs too
//   node build-confusables.mjs --check         # build in memory and verify the
//                                              # artifact AND background.js's
//                                              # constants match; exit 1 on drift
//
// It also EXPORTS `build`, `render` and `payloadDigest`, so
// sentence-guard-test.mjs can rebuild from the vendored inputs in-process and
// fail if the checked-in artifact is stale. A changed builder with a stale
// artifact used to leave every test green.
//
// WHY THIS EXISTS
//
// isRespelling() refuses every real-word -> real-word substitution, because the
// distinction between a correction and an edit is not structural: it is whether
// the ORIGINAL was a word. That rule is right and it has one price -- the
// commonest corrections in English ("their" -> "there", "weather" -> "whether")
// are word-to-word. CONFUSABLE buys them back as a closed, documented list.
//
// Hand-writing that list caps it at the thirty pairs somebody thought of.
// LanguageTool publishes ~780 English confusion pairs with per-pair MEASURED
// precision and recall, which is a documented linguistic set of exactly the
// kind the hand list was approximating.
//
// WHY LANGUAGETOOL'S PRECISION DOES NOT TRANSFER ON ITS OWN
//
// LT's p is the precision of an N-GRAM CLASSIFIER deciding, in context, which
// member of the pair belongs. Proofer has no such classifier. A pair here is an
// unconditional LICENCE: once "and|end" is in the set, the model may replace
// any "and" with "end" and the guards will not object. One guard overlaps this
// licence and defers to it: idle-final-inflection treats a suffix "n" as an
// inflection, so "dam" <-> "damn" satisfies it. It consults isConfusable and
// stands down, because a pair here is a decision about one word and that guard
// is a heuristic about a class. sentence-guard-test.mjs asserts those are the
// ONLY two directed overlaps, so regenerating this file cannot quietly create
// more. So a filter on p alone admits, at p >= 0.995 and edit distance <= 2:
//
//     and -> end     as -> at      bad -> bed     avid -> avoid
//     able -> bale   by -> my      but -> nut     be -> we
//
// which is precisely the "salt" -> "slat" family the dictionary rule exists to
// refuse. Orthographic distance is not the discriminator, and neither is p.
//
// WHAT IS THE DISCRIMINATOR: the two words must SOUND THE SAME. A writer picks
// the wrong homophone because their ear cannot tell them apart; nothing about
// "and"/"end" makes a writer type one for the other except a slipped finger,
// and a slipped finger onto another real word is the case the dictionary rule
// is deliberately refusing.
//
// HOW STRICT "SOUND THE SAME" HAS TO BE, measured the hard way. The first cut
// stripped CMUdict's stress digits and accepted an intersection of ANY
// pronunciation variants of either word. That is exact equality only after
// lossy normalisation, and a gpt-5.6 audit produced four APPLYs from it:
//
//     "The speech incites anger."   -> "...insights..."   stress REVERSED
//                                       (IH2 N S AY1 T S vs IH1 N S AY2 T S)
//     "We need to devise a plan."   -> "...device..."     matched only via
//                                       devise(2), a secondary /S/ variant
//     "The Sahara desert..."        -> "...dessert..."    matched only via
//                                       desert(2), the VERB reading
//     "That was a close call."      -> "...clothes call..." matched only via
//                                       close(2)/clothes(2)
//
// Every one is a silent real-word substitution -- the exact failure this guard
// exists to prevent. So the test is now unconditional homophony: the CANONICAL
// (unindexed) CMUdict pronunciations of the two words must be identical
// INCLUDING stress. A word whose only agreement is through a `(2)` variant is a
// word that sounds the same only in one of its readings, and the guard has no
// way to know which reading the writer meant.
//
// INPUTS (vendored under test/data/ so the build is reproducible offline)
//
//   confusion_sets.txt      LanguageTool, LGPL-2.1-or-later. Header preserved.
//   cmudict-subset.txt      CMU Pronouncing Dictionary, BSD-2-clause, cut down
//                           to the words confusion_sets.txt mentions. Carries
//                           CMU's full copyright, conditions and disclaimer.
//   SOURCES.json            upstream commit SHAs and sha256 of every fetched
//                           byte, so an audited snapshot can be identified and
//                           recreated later. `--fetch` pins to the SHA it
//                           resolves; nothing here is fetched from a moving ref.
//
// The emitted artifact is derived from LGPL data, so data/confusables-en.txt
// carries the LGPL notice and points at data/COPYING.LGPL-2.1. This is a separate
// runtime data file; its LGPL terms are independent of Proofer’s code licence,
// stated in data/THIRD_PARTY_NOTICES.md.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(HERE, "data");
const CONFUSION = join(VENDOR, "confusion_sets.txt");
const CMUDICT = join(VENDOR, "cmudict-subset.txt");
const CMU_LICENSE = join(VENDOR, "cmudict-LICENSE.txt");
const SOURCES = join(VENDOR, "SOURCES.json");
const WORDS = join(HERE, "..", "data", "words-en.txt");
const OUT = join(HERE, "..", "data", "confusables-en.txt");
const LGPL = join(HERE, "..", "data", "COPYING.LGPL-2.1");
const BACKGROUND = join(HERE, "..", "background.js");

const REPOS = {
  languagetool: {
    repo: "languagetool-org/languagetool",
    path: "languagetool-language-modules/en/src/main/resources/org/languagetool/resource/en/confusion_sets.txt",
  },
  cmudict: { repo: "cmusphinx/cmudict", path: "cmudict.dict" },
  cmudictLicense: { repo: "cmusphinx/cmudict", path: "LICENSE" },
  // The LGPL text the derived artifact must be distributed with. Taken from
  // LanguageTool's own tree at the same pinned commit, so the copy we ship is
  // demonstrably the one the upstream work refers to rather than a lookalike.
  lgpl: { repo: "languagetool-org/languagetool", path: "COPYING.txt" },
};
const raw = (repo, sha, path) => `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;

// Precision floor. LT's own comments; a pair below this is one its own
// evaluation could not call reliably even WITH an n-gram model, and we have
// less information than it does, not more.
const MIN_PRECISION = 0.995;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Lines are the payload; the header is documentation and must not be part of
// what the loader verifies, or a comment edit becomes a licence revocation.
export const payloadDigest = (pairs) => sha256(pairs.map((e) => `${e.typed}|${e.meant}`).join("\n") + "\n");

// ------------------------------------------------------------------ parsing

/**
 * LanguageTool's format:
 *
 *   word1; word2; factor        # p=0.999, r=0.913, ...     bidirectional
 *   word1 -> word2; factor      # p=0.998, r=0.659, ...     word1-as-typed only
 *   #word1; word2; factor       # ...                        DISABLED in LT
 *
 * The factor is n-gram-specific and meaningless here. A line commented out is
 * one LT itself switched off, and is skipped.
 */
export function parseConfusionSets(text) {
  const out = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const hash = line.indexOf("#");
    const code = (hash < 0 ? line : line.slice(0, hash)).trim();
    const comment = hash < 0 ? "" : line.slice(hash + 1);
    const p = /\bp=([\d.]+)/.exec(comment);
    const r = /\br=([\d.]+)/.exec(comment);
    const directional = code.includes("->");
    const parts = code.split(/->|;/).map((s) => s.trim()).filter(Boolean);
    const [w1, w2] = parts;
    if (!w1 || !w2) continue;
    const meta = { p: p ? +p[1] : null, r: r ? +r[1] : null, line };
    // A bidirectional line is two licences; a `->` line is one. Direction is
    // (typed, meant) -- exactly the key isRespelling looks up.
    out.push({ typed: w1, meant: w2, ...meta });
    if (!directional) out.push({ typed: w2, meant: w1, ...meta });
  }
  return out;
}

/**
 * CMUdict, CANONICAL pronunciations only.
 *
 * `word PH PH PH` is the canonical entry; `word(2) ...` and beyond are
 * alternates. Stress digits are KEPT -- "incites" (IH2 N S AY1 T S) and
 * "insights" (IH1 N S AY2 T S) are the same phonemes with the stress the other
 * way round, and stripping the digits makes them look identical.
 */
export function parseCmudict(text) {
  const pron = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "").split("#")[0].trim();
    if (!line || line.startsWith(";;;")) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const word = line.slice(0, sp);
    if (/\(\d+\)$/.test(word)) continue;               // an alternate reading
    const seq = line.slice(sp + 1).trim();
    if (!seq) continue;
    if (!pron.has(word)) pron.set(word, seq);          // first wins; there is one
  }
  return pron;
}

// ------------------------------------------------------------------- filters

export function build({ confusion, cmudict, words }) {
  const pron = parseCmudict(cmudict);
  // \r matters: a CRLF checkout would otherwise make every dictionary word
  // unrecognisable and silently empty the list.
  const dict = new Set(words.split("\n").map((w) => w.replace(/\r$/, "")).filter(Boolean));
  const all = parseConfusionSets(confusion);

  const homophone = (a, b) => {
    const A = pron.get(a), B = pron.get(b);
    if (!A || !B) return null;                 // unknown, not "no"
    return A === B;
  };

  const rejected = { case: [], multiword: [], notInDict: [], noPron: [], notHomophone: [], lowP: [] };
  const kept = [];
  for (const e of all) {
    const { typed, meant } = e;
    // bare() in background.js lowercases and splits on whitespace, so an entry
    // with a capital or a space can never match a token. Dead weight, not risk.
    if (typed !== typed.toLowerCase() || meant !== meant.toLowerCase()) { rejected.case.push(e); continue; }
    if (/\s/.test(typed) || /\s/.test(meant)) { rejected.multiword.push(e); continue; }
    // Both sides must be words WE know. If `typed` is not one, the pair is a
    // no-op (isRespelling's ordinary path already handles a non-word original);
    // if `meant` is not one, the pair would licence turning a word into
    // something our own dictionary calls a non-word.
    if (!dict.has(typed) || !dict.has(meant)) { rejected.notInDict.push(e); continue; }
    const h = homophone(typed, meant);
    if (h === null) { rejected.noPron.push(e); continue; }
    if (h === false) { rejected.notHomophone.push(e); continue; }
    if (!(e.p >= MIN_PRECISION)) { rejected.lowP.push(e); continue; }
    kept.push(e);
  }
  // A pair can appear twice (LT lists some both ways and directionally).
  const seen = new Map();
  for (const e of kept) if (!seen.has(`${e.typed}|${e.meant}`)) seen.set(`${e.typed}|${e.meant}`, e);
  return {
    pairs: [...seen.values()].sort((a, b) => (a.typed + a.meant).localeCompare(b.typed + b.meant)),
    rejected, all, pron, dict,
  };
}

/**
 * The LGPL §2(b) date-of-change notice for the derived file.
 *
 * A plain "generated on <today>" would be a new value on every rebuild, and the
 * suite's freshness check compares the RENDERED FILE exactly -- so rebuilding on
 * a different day would fail a test while changing nothing. Two truthful options
 * and we take the stable one: the date records when the DERIVED CONTENT last
 * changed, so it is bumped only if the payload digest differs from the artifact
 * already on disk. A no-op rebuild keeps the old date, which is correct -- the
 * work was not modified that day.
 *
 * Falls back to today when there is no artifact yet, or when its date line is
 * missing or malformed.
 */
const TODAY = () => new Date().toISOString().slice(0, 10);
export function modifiedDate(pairs, previous) {
  const prevDate = /^# Modified from upstream on (\d{4}-\d{2}-\d{2})\b/m.exec(previous || "");
  const prevDigest = /^# SHA-256 of the lines below: ([0-9a-f]{64})/m.exec(previous || "");
  if (prevDate && prevDigest && prevDigest[1] === payloadDigest(pairs)) return prevDate[1];
  return TODAY();
}

export function render(pairs, previous) {
  const head = [
    "# Confusable word pairs for Proofer's sentence-mode guards.",
    "#",
    "# GENERATED by test/build-confusables.mjs -- do not edit by hand. The",
    "# loader in background.js verifies this file's pair count and SHA-256",
    "# against constants that the builder writes into background.js, and",
    "# publishes NOTHING if either disagrees -- so a hand edit here does not",
    `# grant a licence, it revokes all ${pairs.length}.`,
    "#",
    "# Each line is `typed|meant`: a licence for the model to replace `typed`",
    "# with `meant`, which isRespelling() would otherwise refuse because both",
    "# sides are real words. Directional, one direction per line.",
    "#",
    "# Derived from LanguageTool's confusion_sets.txt (English), filtered to",
    "# pairs whose CANONICAL CMUdict pronunciations are identical including",
    `# stress, with LanguageTool precision >= ${MIN_PRECISION}.`,
    "#",
    "# ---------------------------------------------------------------------",
    "# THIS IS A MODIFIED VERSION of a work licensed under the LGPL. Carrying",
    "# the date of change is required by LGPL section 2(b); the date is the day",
    "# the DERIVED CONTENT below last changed, not the day the file was last",
    "# rewritten, so a rebuild that produces identical pairs does not move it.",
    "#",
    `# Modified from upstream on ${modifiedDate(pairs, previous)} by`,
    "# test/build-confusables.mjs: parsed, filtered to homophone pairs above a",
    "# precision floor, and re-expressed one direction per line. No pair here is",
    "# absent from the upstream file; nothing has been added.",
    "# ---------------------------------------------------------------------",
    "# Source: LanguageTool, languagetool-language-modules/en/src/main/",
    "#         resources/org/languagetool/resource/en/confusion_sets.txt",
    "# Copyright (C) the LanguageTool contributors.",
    "# License: GNU Lesser General Public License as published by the Free",
    "#          Software Foundation; either version 2.1 of the License, or",
    "#          (at your option) any later version.",
    "#          A copy is distributed alongside this file as",
    "#          data/COPYING.LGPL-2.1; see also data/THIRD_PARTY_NOTICES.md.",
    "#          This library is distributed in the hope that it will be useful,",
    "#          but WITHOUT ANY WARRANTY; without even the implied warranty of",
    "#          MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the",
    "#          GNU Lesser General Public License for more details.",
    "# The upstream file's own header credits After the Deadline's",
    "#          homophonedb.txt as its original source.",
    "#",
    "# Pronunciations came from the CMU Pronouncing Dictionary (BSD-2-clause)",
    "# at BUILD time only; no CMUdict data appears below. Its copyright,",
    "# conditions and disclaimer travel with the vendored subset at",
    "# test/data/cmudict-subset.txt and in data/THIRD_PARTY_NOTICES.md.",
    "# Exact upstream commits: test/data/SOURCES.json.",
    "# ---------------------------------------------------------------------",
    `# Pairs: ${pairs.length}`,
    `# SHA-256 of the lines below: ${payloadDigest(pairs)}`,
    "",
  ];
  return head.join("\n") + pairs.map((e) => `${e.typed}|${e.meant}`).join("\n") + "\n";
}

/**
 * Write the loader's integrity constants into background.js.
 *
 * They are generated for the same reason the artifact is: a constant somebody
 * has to remember to update by hand is a constant that goes stale, and a stale
 * one here means the loader publishes nothing and the feature silently loses
 * every licence in it.
 */
function patchBackground(src, pairs, { write }) {
  const count = pairs.length, digest = payloadDigest(pairs);
  const next = src
    .replace(/(const CONFUSABLES_COUNT = )\d+(;)/, `$1${count}$2`)
    .replace(/(const CONFUSABLES_SHA256 = ")[0-9a-f]*("\;)/, `$1${digest}$2`);
  if (!/const CONFUSABLES_COUNT = \d+;/.test(next) || !/const CONFUSABLES_SHA256 = "[0-9a-f]{64}";/.test(next)) {
    throw new Error("background.js has no CONFUSABLES_COUNT / CONFUSABLES_SHA256 to patch");
  }
  if (write && next !== src) writeFileSync(BACKGROUND, next);
  return { changed: next !== src, count, digest };
}

// ---------------------------------------------------------------------- main

async function resolveSha(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/master`, {
    headers: { Accept: "application/vnd.github.sha" },
  });
  if (!res.ok) throw new Error(`resolving ${repo}@master: HTTP ${res.status}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`resolving ${repo}@master: got ${JSON.stringify(sha.slice(0, 60))}`);
  return sha;
}

async function fetchPinned(url) {
  process.stderr.write(`fetching ${url}\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.text();
}

async function doFetch() {
  const sources = { fetched: new Date().toISOString(), sources: {} };
  const ltSha = await resolveSha(REPOS.languagetool.repo);
  const cmuSha = await resolveSha(REPOS.cmudict.repo);

  const confusion = await fetchPinned(raw(REPOS.languagetool.repo, ltSha, REPOS.languagetool.path));
  const cmudictFull = await fetchPinned(raw(REPOS.cmudict.repo, cmuSha, REPOS.cmudict.path));
  const cmuLicense = await fetchPinned(raw(REPOS.cmudictLicense.repo, cmuSha, REPOS.cmudictLicense.path));
  const lgplText = await fetchPinned(raw(REPOS.lgpl.repo, ltSha, REPOS.lgpl.path));

  mkdirSync(VENDOR, { recursive: true });
  writeFileSync(CONFUSION, confusion);
  writeFileSync(CMU_LICENSE, cmuLicense);
  // Ships in the extension, not just the repo: the LGPL requires a copy of the
  // licence to accompany the derived data file.
  writeFileSync(LGPL, lgplText);

  // Vendor only the CMUdict entries confusion_sets.txt actually mentions --
  // 135k lines of pronunciation to answer ~1.4k questions is not a dependency
  // worth checking in. CMU's licence requires the copyright, conditions and
  // disclaimer to travel WITH a source redistribution, so they are reproduced
  // in full at the top rather than referenced.
  const wanted = new Set();
  for (const e of parseConfusionSets(confusion)) { wanted.add(e.typed.toLowerCase()); wanted.add(e.meant.toLowerCase()); }
  const head = [
    ";;; CMU Pronouncing Dictionary -- SUBSET, redistributed under its own licence.",
    ";;;",
    ";;; Upstream: https://github.com/cmusphinx/cmudict",
    `;;; Commit:   ${cmuSha}`,
    ";;; Cut down by test/build-confusables.mjs to the words confusion_sets.txt",
    ";;; mentions. Build-time input only; none of it ships in the extension.",
    ";;;",
    ...cmuLicense.split("\n").map((l) => (l.trim() ? `;;; ${l.trimEnd()}` : ";;;")),
    ";;;",
  ];
  const body = [];
  for (const line of cmudictFull.split("\n")) {
    const w = line.split(" ")[0]?.replace(/\(\d+\)$/, "");
    if (w && wanted.has(w)) body.push(line.trimEnd());
  }
  writeFileSync(CMUDICT, head.concat(body).join("\n") + "\n");

  sources.sources = {
    "confusion_sets.txt": {
      repo: REPOS.languagetool.repo, commit: ltSha, path: REPOS.languagetool.path,
      url: raw(REPOS.languagetool.repo, ltSha, REPOS.languagetool.path),
      sha256_upstream: sha256(confusion), license: "LGPL-2.1-or-later",
    },
    "cmudict-subset.txt": {
      repo: REPOS.cmudict.repo, commit: cmuSha, path: REPOS.cmudict.path,
      url: raw(REPOS.cmudict.repo, cmuSha, REPOS.cmudict.path),
      sha256_upstream: sha256(cmudictFull), sha256_subset: sha256(readFileSync(CMUDICT, "utf8")),
      license: "BSD-2-clause", note: "vendored file is a subset plus a licence header, so only sha256_upstream identifies the snapshot",
    },
    "cmudict-LICENSE.txt": {
      repo: REPOS.cmudict.repo, commit: cmuSha, path: REPOS.cmudictLicense.path,
      url: raw(REPOS.cmudictLicense.repo, cmuSha, REPOS.cmudictLicense.path),
      sha256_upstream: sha256(cmuLicense), license: "BSD-2-clause",
      note: "reproduced in full at the top of cmudict-subset.txt as well, because CMU's terms require the notices to travel with a source redistribution",
    },
    "data/COPYING.LGPL-2.1 (shipped)": {
      repo: REPOS.lgpl.repo, commit: ltSha, path: REPOS.lgpl.path,
      url: raw(REPOS.lgpl.repo, ltSha, REPOS.lgpl.path),
      sha256_upstream: sha256(lgplText), license: "LGPL-2.1",
      note: "SHIPS in the extension; the licence copy that must accompany data/confusables-en.txt",
    },
  };
  writeFileSync(SOURCES, JSON.stringify(sources, null, 2) + "\n");
  process.stderr.write(`  pinned languagetool@${ltSha} cmudict@${cmuSha}\n`);
  process.stderr.write(`  wrote ${LGPL}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (has("--fetch")) await doFetch();

  for (const f of [CONFUSION, CMUDICT, WORDS]) {
    if (!existsSync(f)) {
      console.error(`missing input: ${f}\nrun: node build-confusables.mjs --fetch`);
      process.exit(2);
    }
  }

  const R = build({
    confusion: readFileSync(CONFUSION, "utf8"),
    cmudict: readFileSync(CMUDICT, "utf8"),
    words: readFileSync(WORDS, "utf8"),
  });

  const n = (a) => String(a.length).padStart(5);
  const row = (label, v) => console.log(`  ${label.padEnd(49)}${v}`);
  console.log("LanguageTool confusion sets -> data/confusables-en.txt");
  console.log("=".repeat(64));
  row("directed pairs parsed (LT-disabled lines skipped)", n(R.all));
  row("- capitalised (bare() lowercases; unmatchable)", n(R.rejected.case));
  row("- multi-word  (tokens never contain a space)", n(R.rejected.multiword));
  row("- a side missing from data/words-en.txt", n(R.rejected.notInDict));
  row("- a side missing from CMUdict (cannot judge)", n(R.rejected.noPron));
  row("- canonical pronunciations differ (incl. stress)", n(R.rejected.notHomophone));
  row(`- homophone but p < ${MIN_PRECISION}`, n(R.rejected.lowP));
  row("= kept", n(R.pairs));

  if (has("--report")) {
    const show = (label, list, k = 40) => {
      console.log(`\n${label} (${list.length}), first ${k}:`);
      console.log("  " + list.slice(0, k).map((e) => `${e.typed}>${e.meant}`).join(" "));
    };
    show("REJECTED canonical pronunciations differ", R.rejected.notHomophone);
    show("REJECTED homophone but low precision", R.rejected.lowP);
    show("REJECTED no pronunciation", R.rejected.noPron);
    console.log(`\nKEPT (${R.pairs.length}):`);
    console.log("  " + R.pairs.map((e) => `${e.typed}>${e.meant}`).join(" "));
  }

  // The existing artifact is an INPUT to render(): the LGPL date-of-change line
  // is only bumped when the pairs actually change, so a no-op rebuild is a no-op.
  const previous = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const text = render(R.pairs, previous);
  const bgSrc = readFileSync(BACKGROUND, "utf8");
  if (has("--check")) {
    let bad = false;
    const cur = previous;
    if (cur !== text) { console.error(`\nDRIFT: ${OUT} does not match a fresh build.`); bad = true; }
    const { changed, count, digest } = patchBackground(bgSrc, R.pairs, { write: false });
    if (changed) {
      console.error(`\nDRIFT: background.js integrity constants are stale (want ${count} / ${digest}).`);
      bad = true;
    }
    if (bad) process.exit(1);
    console.log(`\n${OUT} and background.js's integrity constants are up to date.`);
    console.log(`  pairs ${R.pairs.length}  sha256 ${payloadDigest(R.pairs)}`);
  } else {
    writeFileSync(OUT, text);
    const { changed, count, digest } = patchBackground(bgSrc, R.pairs, { write: true });
    console.log(`\nwrote ${OUT}  (${count} pairs, ${text.length} bytes)`);
    console.log(`  payload sha256 ${digest}`);
    console.log(`  background.js integrity constants ${changed ? "UPDATED" : "already current"}`);
  }
}
