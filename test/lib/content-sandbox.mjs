// Sentence-mode internals, LOADED OUT OF content.js.
//
// content.js is an IIFE, so nothing inside it is reachable the way
// sanitizer-test.mjs reaches into background.js. It therefore exposes a
// deliberate seam -- globalThis.__prooferSentence -- which is invisible in
// production (content scripts run in an isolated world, so the page cannot see
// it) and is what these suites drive.
//
// The alternative was a second copy of the segmenter in test/lib. That copy is
// exactly what MIN_SENTENCE_CHARS drift would hide: the segmenter would emit
// targets the guards reject as too short, the feature would quietly stop
// working on short sentences, and both suites would still be green.
//
// Intl.Segmenter output is identical in Node 20 and headless Chrome 145 over
// this corpus, so segmenting in Node is a valid proxy for what ships.

import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONTENT_PATH = resolve(
  process.env.PROOFER_CONTENT || join(__dirname, "..", "..", "content.js"));
export const CONTENT_SOURCE = readFileSync(CONTENT_PATH, "utf8");

const noop = () => {};
const rect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
const stubEl = () => ({
  style: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop, removeEventListener: noop, appendChild: noop, remove: noop,
  setAttribute: noop, getAttribute: () => null,
  querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  contains: () => false, focus: noop, getBoundingClientRect: rect, getClientRects: () => [],
});

const ctx = vm.createContext({
  console, setTimeout, clearTimeout, AbortController, URL,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  navigator: { language: "en-US" },
  getComputedStyle: () => ({}),
  window: {
    location: {
      hostname: "example.com", origin: "https://example.com",
      protocol: "https:", ancestorOrigins: { length: 0 },
    },
    addEventListener: noop, removeEventListener: noop,
    getSelection: () => null,
    innerWidth: 1280, innerHeight: 900,
  },
  document: {
    addEventListener: noop, removeEventListener: noop,
    documentElement: stubEl(),
    body: stubEl(),
    activeElement: null,
    getElementById: () => null,
    createElement: () => stubEl(),
    createTextNode: () => ({}),
    createRange: () => null,
    execCommand: () => false,
    dispatchEvent: () => true,
  },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4 },
  chrome: {
    runtime: { id: "test", lastError: undefined, sendMessage: (m, cb) => cb && cb({ ok: true }) },
    storage: { local: { get: (d, cb) => cb(d), set: noop }, onChanged: { addListener: noop } },
  },
});

vm.runInContext(CONTENT_SOURCE, ctx);

if (!ctx.__prooferSentence) {
  throw new Error("content.js did not expose __prooferSentence -- the test seam is gone");
}

export const {
  MIN_SENTENCE_CHARS, SENTENCE_TRIGGER_CHARS, SENTENCE_IDLE_MS,
  SENTENCE_BULK_CHARS, SENTENCE_MAX_JOB_MS, SENTENCE_CONTEXT_CHARS,
  segmentSentences, nextSentenceTarget, sentenceContextFor,
  sentenceAnchorFailure, sentenceCaretRefusal, changedRanges, endsSentence,
  endsWithAbbreviation, hasUnbalancedOpener, endsMidNumber, describeChange,
  // The transport registry, so a suite can assert it is fully covered rather
  // than trusting a second hand-maintained table to have kept up with it.
  SN_TRANSPORTS,
} = ctx.__prooferSentence;
