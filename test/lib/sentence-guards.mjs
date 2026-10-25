// The sentence-mode output guards, LOADED OUT OF background.js.
//
// This file holds no guard logic. It used to be the reference implementation, with
// the intent that it be ported into background.js by hand -- which is two
// copies of 200 lines of security-critical comparison code, kept in sync by
// remembering to. The guards are what stand between the model and the user's
// text; a test suite passing against a copy that has drifted from the shipping
// one is worse than no suite.
//
// Same trick as sanitizer-test.mjs: background.js is a plain script, so it
// evaluates in a vm context and its top-level functions can be read straight
// out of it.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SENTENCE_SOURCE = readFileSync(join(__dirname, "..", "..", "background.js"), "utf8");
const DATA_ROOT = join(__dirname, "..", "..", "data");

// Read fail calls from the evaluated runner, excluding its comments.
// Supported fail sites are literal families and the chain's token payload. A
// new expression must extend this parser explicitly, never disappear silently.
function reasonFamilies(runSentenceGuards) {
  const source = runSentenceGuards.toString().replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const sites = /\bfail\s*\(/g;
  const families = [];
  for (const site of source.matchAll(sites)) {
    const argument = source.slice(site.index + site[0].length);
    const literal = argument.match(/^\s*(["'])([a-z]+(?:-[a-z]+)*)\1\s*\)/);
    const payload = argument.match(/^\s*`(word-substituted):\$\{subs\[0\]\}`\s*\)/);
    if (!literal && !payload) throw new Error("Unsupported runSentenceGuards fail site: " + argument.slice(0, 80));
    const family = literal ? literal[2] : payload[1];
    if (!families.includes(family)) families.push(family);
  }
  if (!families.length) throw new Error("No runSentenceGuards fail sites found");
  return Object.freeze(families);
}

// Pre-extraction revisions kept this question inside runSentenceEngine. Read
// their actual statements, not today's helper, and reject unfamiliar shapes.
function legacySanitizer(runSentenceEngine) {
  const engine = runSentenceEngine.toString();
  const blocks = [...engine.matchAll(/const stripped = rewritten\.replace\([^\n]+\n\s*const cleaned = [^\n]+/g)];
  if (blocks.length !== 1 || !/^const stripped = rewritten\.replace\(\/[^\n]+\/gi, ""\);\n\s*const cleaned = normalizeWhitespace\(asciify\(stripMarkdown\(stripped, sentence\)\), sentence\);$/.test(blocks[0][0])) {
    throw new Error("Unsupported legacy engine sanitizer shape");
  }
  return `function sanitizeSentenceOutput(sentence, rewritten) {
    ${blocks[0][0]}
    return cleaned;
  }`;
}

/** Fresh VM and shipping datasets for both the default chain and source variants.
 * controls defaults to the existing environment switches; explicit controls
 * replace those defaults so a caller can make its experiment independent of env.
 */
export async function loadSentenceGuards({
  source = SENTENCE_SOURCE, dataRoot = DATA_ROOT,
  controls = {
    noDict: !!process.env.PROOFER_NO_DICT,
    noConfusables: !!process.env.PROOFER_NO_CONFUSABLES,
    noNames: !!process.env.PROOFER_NO_NAMES,
  },
} = {}) {
  const noop = () => {};
  // getURL, crypto and TextEncoder are here so the REAL confusables loader --
  // res.ok check, shape check, count check, SHA-256 check -- runs in this context
  // rather than being re-implemented below. A mirrored loader is a second copy of
  // security-critical code kept in sync by remembering to, which is the thing
  // this whole file exists to avoid.
  const ctx = vm.createContext({
    chrome: {
      runtime: {
        onMessage: { addListener: noop }, onInstalled: { addListener: noop },
        // data/ follows dataRoot (a variant may bring its own datasets); any
        // other path is the extension root, as chrome.runtime.getURL resolves it.
        getURL: (p) => p.startsWith("data/") ? join(dataRoot, p.slice(5))
          : new URL("../../" + p, import.meta.url).pathname,
      },
      storage: { local: { setAccessLevel: async () => {}, get: (k, cb) => cb({}), set: noop, remove: noop } },
      tabs: { create: noop },
    },
    console, fetch, setTimeout, clearTimeout, AbortController, AbortSignal, URL,
    crypto: globalThis.crypto, TextEncoder,
  });

  vm.runInContext(source + `
  ;globalThis.__sentenceApi = {
    // These policies postdate supported comparison snapshots. Keep the full
    // current API while allowing old guards to load without newer policies.
    SENTENCE_OUTCOMES: typeof SENTENCE_OUTCOMES === "undefined" ? undefined : SENTENCE_OUTCOMES,
    sentenceOutcomeDefinition: typeof sentenceOutcomeDefinition === "undefined" ? undefined : sentenceOutcomeDefinition,
    sentenceRecordGuard: typeof sentenceRecordGuard === "undefined" ? undefined : sentenceRecordGuard,
    runSentenceGuards, guardSentenceResult, guardSentenceReport, MIN_SENTENCE_CHARS,
    stripMarkdown, asciify, normalizeWhitespace,
    sanitizeSentenceOutput: typeof sanitizeSentenceOutput === "undefined" ? undefined : sanitizeSentenceOutput,
    editDistance, isWord,
    sentenceTriggerOf, SENTENCE_TRIGGERS,
    THRESHOLDS: SENTENCE_THRESHOLDS,
    negationCount, contractionCount, tokenOverlap, changedWordCount,
    substitutedContentWords,
    buildSentenceMessages, prepareSentenceRequest, tailSentences,
    SENTENCE_FEW_SHOT, SENTENCE_CONTEXT_SHOT, SENTENCE_NUM_CTX, SENTENCE_NUM_PREDICT, SENTENCE_CONTEXT_CHARS,
    setDictionary, setConfusables, haveDictionary,
    parseConfusables, fetchConfusables, CONFUSABLES_COUNT, CONFUSABLES_SHA256,
    parseNames, fetchNames, setNames, isName, nameLicence, accountedNameOriginal, NAMES_COUNT, NAMES_SHA256, HAND_NAMES,
    protectedMultiset, isShiftStutter, unstutter, isRespelling, collapseResegmentations,
    isReinflection, isConfusable, CONFUSABLE, finalTokenInflectionOnly,
    isBlessedContractionReplacement, BLESSED_CONTRACTION_REPLACEMENTS,
    sentenceRetryDecision, sentenceRetryKeepList, buildSentenceRetryMessages, prepareSentenceRetryRequest,
    runSentenceEngine, installedModelDigest, forgetModelDigests, PINNED_MODEL,
    SETUP_FIXTURES, threadCandidates, qualificationIsCurrent, SETUP_BENCHMARK_REVISION, PROMPT_REVISION,
    SENTENCE_TIMEOUT_MS, SENTENCE_RETRY_DELIVERY_MARGIN_MS,
    SENTENCE_NO_RETRY_REASONS, SENTENCE_RETRY_MIN_BUDGET_MS, SENTENCE_RETRY_DELIVERY_CAP_MS, retrySentenceRewrite,
    extractTimings,
    sentenceResultFields: typeof sentenceResultFields === "undefined" ? undefined : sentenceResultFields,
    isRetrySalvaged: typeof isRetrySalvaged === "undefined" ? undefined : isRetrySalvaged,
    setEngineClock: (now) => { Date.now = now; },
    sentenceWarmupBody, sentenceWarmupDecision, noteOllamaRequest,
    SENTENCE_WARM_STALE_MS, sentenceModeState,
    SENTENCE_KEEP_ALIVE, SENTENCE_KEEP_ALIVE_MS,
  };`, ctx);

  const api = ctx.__sentenceApi;
  if (!api.sanitizeSentenceOutput) {
    api.sanitizeSentenceOutput = vm.runInContext(`(${legacySanitizer(api.runSentenceEngine)})`, ctx);
  }
  api.REASON_FAMILIES = reasonFamilies(api.runSentenceGuards);
  // Load the SHIPPING word list by default, so every suite measures the
  // configuration that actually runs. noDict is the combined historical control:
  // it disables words AND generated confusables/names, not just a words fetch.
  // The other controls independently retain only their hand supplements.
  if (!controls.noDict) {
    const words = readFileSync(
      join(dataRoot, "words-en.txt"), "utf8"
    ).split("\n").map((w) => w.replace(/\r$/, "")).filter(Boolean);
    api.setDictionary(words);
    // The generated half of CONFUSABLE, for the same reason: the guards consult
    // it, so a suite that does not load it is measuring a configuration that does
    // not ship. `PROOFER_NO_CONFUSABLES=1` loads only the hand-picked half, which
    // is what shipped before data/confusables-en.txt existed and is the control
    // the expansion was measured against.
    //
    // Loaded through the SHIPPING loader, not a re-read: the count and digest
    // checks are the part most worth exercising on every suite run, and a suite
    // that bypassed them would be measuring a configuration the extension cannot
    // actually reach.
    if (!controls.noConfusables) {
      const loaded = await api.fetchConfusables(diskFetch());
      if (!loaded) throw new Error(
        "data/confusables-en.txt failed the shipping loader's integrity check. "
        + "Run: node build-confusables.mjs");
      api.setConfusables(loaded);
    }
    // The cased name list, through its shipping loader for the same reason.
    // `PROOFER_NO_NAMES=1` is the control: the hand names only, which is what
    // shipped before data/names-en.txt existed (2026-09-19).
    if (!controls.noNames) {
      const names = await api.fetchNames(diskFetch());
      if (!names) throw new Error(
        "data/names-en.txt failed the shipping loader's integrity check. "
        + "Run: node build-names.mjs");
      api.setNames(names);
    }
  }
  return api;
}

export const {
  SENTENCE_OUTCOMES, sentenceOutcomeDefinition, sentenceRecordGuard,
  guardSentenceResult, guardSentenceReport, MIN_SENTENCE_CHARS, THRESHOLDS,
  stripMarkdown, asciify, normalizeWhitespace, sanitizeSentenceOutput,
  editDistance, isWord,
  sentenceTriggerOf, SENTENCE_TRIGGERS,
  negationCount, contractionCount, tokenOverlap, changedWordCount,
  substitutedContentWords,
  buildSentenceMessages, prepareSentenceRequest, tailSentences,
  SENTENCE_FEW_SHOT, SENTENCE_CONTEXT_SHOT, SENTENCE_NUM_CTX, SENTENCE_NUM_PREDICT, SENTENCE_CONTEXT_CHARS,
  setDictionary, setConfusables, haveDictionary,
  parseConfusables, fetchConfusables, CONFUSABLES_COUNT, CONFUSABLES_SHA256,
  parseNames, fetchNames, setNames, isName, nameLicence, accountedNameOriginal, NAMES_COUNT, NAMES_SHA256, HAND_NAMES,
  protectedMultiset, isShiftStutter, unstutter, isRespelling, collapseResegmentations,
  isReinflection, isConfusable, CONFUSABLE, finalTokenInflectionOnly,
  isBlessedContractionReplacement, BLESSED_CONTRACTION_REPLACEMENTS,
  sentenceRetryDecision, sentenceRetryKeepList, buildSentenceRetryMessages, prepareSentenceRetryRequest,
  runSentenceEngine, installedModelDigest, forgetModelDigests, PINNED_MODEL,
  SETUP_FIXTURES, threadCandidates, qualificationIsCurrent, SETUP_BENCHMARK_REVISION, PROMPT_REVISION,
  SENTENCE_TIMEOUT_MS, SENTENCE_RETRY_DELIVERY_MARGIN_MS,
  SENTENCE_NO_RETRY_REASONS, SENTENCE_RETRY_MIN_BUDGET_MS, SENTENCE_RETRY_DELIVERY_CAP_MS, retrySentenceRewrite,
  extractTimings, sentenceResultFields, isRetrySalvaged, setEngineClock,
  sentenceWarmupBody, sentenceWarmupDecision, noteOllamaRequest,
  SENTENCE_WARM_STALE_MS, sentenceModeState,
  SENTENCE_KEEP_ALIVE, SENTENCE_KEEP_ALIVE_MS, REASON_FAMILIES,
} = await loadSentenceGuards();

/**
 * A `fetch` that serves the extension's own data/ directory off disk, so
 * fetchConfusables() can be driven exactly as it runs in the service worker.
 * `overrides` lets a test substitute a 404 or a corrupt body for one URL.
 */
export function diskFetch(overrides = {}) {
  return async (url) => {
    const key = String(url).split("/").pop();
    if (key in overrides) return overrides[key];
    try {
      return { ok: true, status: 200, text: async () => readFileSync(url, "utf8") };
    } catch {
      return { ok: false, status: 404, text: async () => "not found" };
    }
  };
}
