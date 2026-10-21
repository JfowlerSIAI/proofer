#!/usr/bin/env node
// The SENTENCE_REWRITE handler's retry wiring, driven end-to-end in a vm with
// a scripted Ollama. No real network, no browser.
//
// The offline retry suite covers the pure functions; this one covers what it
// structurally cannot: that the handler makes AT MOST two requests, that the
// second request actually carries the constraint line, that a second output
// failing the guards falls back to the ORIGINAL refusal, that a cancellation
// arriving while the first response is being guarded stops the retry from
// starting (the request stays in activeRequests for the whole handler -- the
// 2026-08-28 audit's finding 1, pinned here against its exact failure mode),
// that the retry shares the first pass's timeout budget rather than adding a
// second one, that consent revoked between the attempts still blocks the
// write, and that one v2 interaction contains zero to two canonical attempts.
// Top-level wall time includes the whole interaction; attempt walls stop at
// body consumption, and compatibility counters project the first attempt.
//
//   node sentence-retry-handler-test.mjs

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const src = readFileSync(join(ROOT, "background.js"), "utf8");

let pass = 0, fail = 0;
const sizeRecords = {};
const check = (ok, what) => {
  if (ok) pass++;
  else { fail++; console.log(`  FAIL ${what}`); }
};

// ---- the sandbox ------------------------------------------------------------
const listeners = [];
let store = {};
// >0 defers the NEXT storage.get callback by that many ms (then clears), so a
// cancellation can land while the handler is awaiting a settings read.
let deferNextGet = 0;
// >0 delays every data-file fetch by that many ms, so [H0] can land a cancel
// while the handler is awaiting the dictionary. Only the FIRST scenario can
// use it: ensureDictionary caches globally after one load.
let deferFiles = 0;
let clockOffset = 0;
// When set, each Date.now() call inside the vm consumes one increment AFTER
// returning -- a scripted clock, so time can pass "between" two specific
// Date.now() reads with no real waiting. Used by [H6d] to burn budget between
// the helper's entry deadline check and its post-evidence re-check.
let nowScript = null;
const RealDate = Date;
class FakeDate extends RealDate {
  static now() {
    const v = RealDate.now() + clockOffset;
    if (nowScript && nowScript.length) clockOffset += nowScript.shift();
    return v;
  }
}
// Scripted Ollama: each entry is a function(parsedBody) -> response object (or
// a promise of one) or throw. Anything that is not /api/chat is served off
// disk (the dictionary and confusables loads), same as
// lib/sentence-guards.mjs's diskFetch.
//
// The fake is SIGNAL-AWARE like real fetch: aborting the request's signal
// rejects both the in-flight request and any later body read with an
// AbortError. Without this, deleting `signal: ac.signal` from a shipping fetch
// call leaves every case green -- the suite would pin the pre-fetch
// cancellation gate while the in-flight abort went untested.
let chatQueue = [];
let chatCalls = [];
let chatSignals = [];
const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const raceSignal = (p, signal) => {
  if (!signal) return Promise.resolve(p);
  if (signal.aborted) return Promise.reject(abortErr());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortErr());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(p).then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
};
// /api/tags, answered the way Ollama does, at once (not through the
// data-file delay above). `tagsScript` replaces the answer for one case: a
// function returning the models array, or throwing to play "unreachable".
// Defaults to the pinned model under its pinned digest -- the installed state
// every other case assumes.
let tagsScript = null;
let tagsCalls = 0;
// When set, /api/tags answers only once this promise resolves: a lookup held
// open while the test changes consent underneath it.
let tagsGate = null;
const fakeFetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/api/tags")) {
    tagsCalls++;
    if (tagsGate) await tagsGate;
    const pin = vm.runInContext("PINNED_MODEL", ctx);
    const models = tagsScript ? tagsScript(pin)
      : [{ name: pin.tag, model: pin.tag, digest: pin.digest }];
    return { ok: true, status: 200, json: async () => ({ models }) };
  }
  if (u.includes("/api/chat")) {
    const body = JSON.parse(opts.body);
    chatCalls.push(body);
    // Kept so a test can assert the TRANSPORT was cancelled, not merely that
    // the handler answered promptly. Since the first pass races every await
    // against the delivery deadline, a prompt "cancelled" proves the race
    // fired; it does not prove `signal: ac.signal` is still on the fetch.
    chatSignals.push(opts.signal || null);
    if (!chatQueue.length) throw new Error("chatQueue exhausted: unexpected extra request");
    const resp = await raceSignal(chatQueue.shift()(body), opts.signal);
    return {
      ...resp,
      json: () => raceSignal(resp.json(), opts.signal),
      text: resp.text ? () => raceSignal(resp.text(), opts.signal) : undefined,
    };
  }
  if (deferFiles > 0) await new Promise((r) => setTimeout(r, deferFiles));
  try { return { ok: true, status: 200, text: async () => readFileSync(u, "utf8") }; }
  catch { return { ok: false, status: 404, text: async () => "not found" }; }
};

const ctx = vm.createContext({
  chrome: {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener: () => {} },
      getURL: (p) => join(ROOT, p),
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          if (keys && typeof keys === "object" && !Array.isArray(keys)) {
            for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
          } else for (const k of (Array.isArray(keys) ? keys : [keys])) out[k] = store[k];
          if (deferNextGet > 0) {
            const d = deferNextGet;
            deferNextGet = 0;
            setTimeout(() => cb(out), d);
            return;
          }
          cb(out);
        },
        set: (obj, cb) => { Object.assign(store, obj); cb && cb(); },
        remove: (keys, cb) => {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
          cb && cb();
        },
      },
    },
    tabs: { create: () => {} },
  },
  console, fetch: fakeFetch, setTimeout, clearTimeout, AbortController, AbortSignal, URL,
  crypto: globalThis.crypto, TextEncoder, Date: FakeDate,
});
vm.runInContext(src, ctx);
check(listeners.length > 0, "background.js registered a message listener");

const ORIGIN = "https://example.com";
const SENDER = { tab: { url: ORIGIN + "/page" }, frameId: 0, url: ORIGIN + "/page" };
const DAY = 86400000;
function seedConsent() {
  // On by default since 2026-09-02. Stated anyway, so the H4 cases that flip
  // sentenceMode to false are withdrawing something visibly granted.
  store = {
    // At the current schema: the worker refuses consent until the settings
    // migration's version stamp is stored (v5 fails closed).
    settingsVersion: vm.runInContext("SETTINGS_VERSION", ctx),
    sentenceMode: true,
    sentenceModeDisabledSites: [],
    // A current, passing speed check: nothing writes without one (beta 3d).
    [vm.runInContext("QUALIFICATION_KEY", ctx)]: {
      v: 1, pass: true, category: "pass", ollamaUrl: "http://localhost:11434", ollamaVersion: "0.32.12",
      tag: vm.runInContext("PINNED_MODEL.tag", ctx), digest: vm.runInContext("PINNED_MODEL.digest", ctx),
      promptRevision: vm.runInContext("PROMPT_REVISION", ctx),
      benchmarkRevision: vm.runInContext("SETUP_BENCHMARK_REVISION", ctx), options: { num_thread: null },
    },
  };
}
// Counts sendResponse calls as well as delivering the first. A bare Promise
// `resolve` is idempotent, so a handler calling sendResponse twice -- which
// Chrome treats as an error, and which the `responded` latch exists to prevent
// -- was completely invisible to every case in this file.
// The stats are popup-only: the worker refuses them from a content script.
const POPUP = { url: join(ROOT, "popup.html") };
function dispatch(msg, sender = SENDER) {
  let calls = 0;
  const p = new Promise((resolve) => {
    const respond = (payload) => { calls++; if (calls === 1) resolve(payload); };
    for (const fn of listeners) {
      if (fn(msg, sender, respond) === true) return;
    }
    respond(undefined);
  });
  p.responseCount = () => calls;
  return p;
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
function findRecord(id) {
  for (const v of Object.values(store)) {
    if (v && typeof v === "object" && !Array.isArray(v) && v.id === id) return v;
  }
  return null;
}
const chat = (content, extra = {}) => () => ({
  ok: true, status: 200,
  json: async () => ({
    message: { content: JSON.stringify({ rewritten: content }) },
    done_reason: "stop",
    total_duration: 4e8, load_duration: extra.loadNs ?? 0,
    prompt_eval_count: 100, eval_count: 20, ...extra.body,
  }),
});
function reset() {
  seedConsent();
  chatQueue = [];
  chatCalls = [];
  chatSignals = [];
  clockOffset = 0;
  nowScript = null;
  deferNextGet = 0;
  deferFiles = 0;
  tagsScript = null;
  tagsCalls = 0;
  vm.runInContext("forgetModelDigests()", ctx);
}

// The folx pair: FIRST is refused (word-substituted:folx), RETRY_OK applies,
// RETRY_BAD is refused again. All three verified against the live guard chain.
const SENTENCE = "The sample label was meant to greet group of folx?";
const FIRST = "The sample label was meant to greet a group of fixed?";
const RETRY_OK = "The sample label was meant to greet a group of folx?";
let seq = 0;
const msgFor = () => ({
  type: "SENTENCE_REWRITE", requestId: `sn_test_${++seq}`,
  sentence: SENTENCE, priorContext: "", trigger: "idle",
});

// Realistic ID/context/backend metadata for the six size-gate samples.
function sizeMessage() {
  store[vm.runInContext("QUALIFICATION_KEY", ctx)].backend = { kind: "gpu", numThread: null };
  return { ...msgFor(), requestId: `sn_${"a".repeat(32)}_${seq}`,
    priorContext: "The meeting starts today. Please bring the draft." };
}

// ---- [H0] cancellation while the DICTIONARY load is pending -----------------
// Must run FIRST: ensureDictionary caches globally, so only the suite's first
// request ever awaits it. The cancel lands after the first body resolved but
// while dictReady is still pending; the post-dictReady abort check must answer
// "cancelled" instead of proceeding to guards and a retry.
{
  console.log("[H0] CANCEL during the dictionary await -> cancelled, no retry");
  reset();
  deferFiles = 400;
  const m = msgFor();
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        setTimeout(() => {
          for (const fn of listeners) fn({ type: "CANCEL_REWRITE", requestId: m.requestId }, SENDER, () => {});
        }, 5);
        return {
          message: { content: JSON.stringify({ rewritten: FIRST }) },
          done_reason: "stop", total_duration: 4e8, load_duration: 0,
          prompt_eval_count: 100, eval_count: 20,
        };
      },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.error === "cancelled",
    `cancelled, not a refusal or success (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `the retry never fetched (got ${chatCalls.length})`);
}

// ---- [D0] expiry while the SHARED dictionary load is pending ----------------
// H0 started the load and cancelled its own waiter; the shared load must live
// on. This case must precede H1, which sees the cached dictionary.
{
  reset();
  const m = msgFor();
  chatQueue = [(body) => { clockOffset = 4650; return chat(RETRY_OK)(body); }];
  const t0 = RealDate.now();
  const res = await dispatch(m);
  const elapsed = RealDate.now() - t0;
  await settle();
  check(res?.error === "delivery-expired" && !res.network && elapsed < 300 &&
    findRecord(m.requestId)?.error === "delivery-expired" &&
    !vm.runInContext("activeRequests.size", ctx),
    "[D0] dictionary expiry releases and records the job within its arrival lease");
  await ctx.ensureDictionary(); // settle the shared load before any clock reset
}

// ---- [H1] salvage: refused first pass, applied retry ------------------------
{
  console.log("[H1] refused first pass, retry applies");
  reset();
  chatQueue = [chat(FIRST, { loadNs: 2.1e9 }),
    (body) => { clockOffset = 700; return chat(RETRY_OK, { loadNs: 0 })(body); }];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === true && res.rewritten === RETRY_OK, `retry result is the response (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 2, `exactly two requests (got ${chatCalls.length})`);
  const sys = chatCalls[1].messages[0].content;
  check(sys.includes("Do not change these words") && sys.includes('"folx?"'),
    "the second request carries the constraint line");
  check(!chatCalls[0].messages[0].content.includes("Do not change these words"),
    "the first request does not");
  await settle();
  const rec = findRecord(m.requestId);
  check(!!rec, "a record was written");
  if (rec) {
    check(rec.guard === null, `a salvaged refusal has guard: null (got ${rec.guard})`);
    check(rec.retry && rec.retry.outcome === "applied", `retry.outcome applied (got ${rec.retry && rec.retry.outcome})`);
    check(rec.retry && rec.retry.firstGuard === "word-substituted:folx",
      `retry.firstGuard preserves the refusal (got ${rec.retry && rec.retry.firstGuard})`);
    check(rec.retry && rec.retry.firstOutput === FIRST, "retry.firstOutput preserves the first raw output");
    check(rec.output === RETRY_OK, "record.output is what shipped");
    // One record, one INTERACTION: the top-level Ollama counters are the
    // FIRST attempt's (the cold load stays visible to reload attribution),
    // the warm retry's counters ride in retry.timings, and wallMs is
    // end-to-end -- its original meaning, what the popup median reads.
    check(rec.timings && rec.timings.loadMs === 2100,
      `top-level loadMs is the first attempt's cold load (got ${rec.timings && rec.timings.loadMs})`);
    check(rec.retry && rec.retry.timings && rec.retry.timings.loadMs === 0,
      `retry.timings carries the second attempt (got ${rec.retry && rec.retry.timings && rec.retry.timings.loadMs})`);
    // wallMs is END-TO-END: the retry took 700ms of logical time, so a
    // top-level wall pinned to the first attempt reads ~0 and goes red here.
    check(rec.timings && rec.timings.wallMs >= 700,
      `top-level wallMs spans both attempts (got ${rec.timings && rec.timings.wallMs})`);
  }
  const stats = await dispatch({ type: "GET_LOG_STATS" }, POPUP);
  check(stats && stats.ok && stats.sentence.retrySalvaged === 1,
    `a delivered salvage counts in retrySalvaged (got ${stats && stats.sentence && stats.sentence.retrySalvaged})`);
}

// ---- [H2] both refused: fall back to the original refusal -------------------
{
  console.log("[H2] retry refused too -> original refusal, two requests only");
  reset();
  chatQueue = [chat(FIRST), chat(FIRST), chat(RETRY_OK)]; // a third would mean a loop
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `original refusal is the response (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 2, `no third request (got ${chatCalls.length})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.guard === "word-substituted:folx", "record keeps the first refusal");
  check(rec && rec.retry && rec.retry.outcome === "refused", `retry.outcome refused (got ${rec && rec.retry && rec.retry.outcome})`);
  check(rec && rec.retry && rec.retry.guard === "word-substituted:folx", "the second refusal's own guard is recorded");
}

// ---- [H2b] a refused EMPTY retry output is still a recorded output ----------
{
  console.log("[H2b] retry returns \"\" -> refused as empty, and the record keeps the empty string");
  reset();
  chatQueue = [chat(FIRST), chat("")];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `falls back to the refusal (got ${JSON.stringify(res)})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "refused" && rec.retry.guard === "empty",
    `retry refused as empty (got ${rec && rec.retry && rec.retry.outcome}/${rec && rec.retry && rec.retry.guard})`);
  // || would erase "" to null and the replay tool would never see this refusal.
  check(rec && rec.retry && rec.retry.output === "",
    `the empty second output survives on the record (got ${JSON.stringify(rec && rec.retry && rec.retry.output)})`);
}

// ---- [H3] retry transport error -> original refusal -------------------------
{
  console.log("[H3] retry transport failure -> original refusal");
  reset();
  chatQueue = [chat(FIRST), () => { throw Object.assign(new Error("boom"), { name: "TypeError" }); }];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `falls back to the refusal (got ${JSON.stringify(res)})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "error", `retry.outcome error (got ${rec && rec.retry && rec.retry.outcome})`);
  check(rec && rec.retry && rec.retry.timings && typeof rec.retry.timings.wallMs === "number",
    "a failed retry still reports what it cost (retry.timings.wallMs)");
}

// ---- [H4] consent revoked between the attempts ------------------------------
{
  console.log("[H4] consent revoked mid-retry -> the write is blocked");
  reset();
  chatQueue = [chat(FIRST), (body) => { store.sentenceMode = false; return chat(RETRY_OK)(body); }];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === false && res.revoked === true,
    `revocation blocks a salvaged correction (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 2, "the revocation was after the second request, so two calls");
  await settle();
  // A blocked salvage was never delivered, so it must not read as one: the
  // record carries the block, and retrySalvaged does not count it.
  const rec = findRecord(m.requestId);
  check(rec && rec.error === "not-allowed" && rec.output === null,
    `the record carries the block, not a delivery (got error=${rec && rec.error}, output=${rec && rec.output})`);
  const stats = await dispatch({ type: "GET_LOG_STATS" }, POPUP);
  check(stats && stats.ok && stats.sentence.retrySalvaged === 0,
    `a consent-blocked salvage is NOT counted as salvaged (got ${stats && stats.sentence && stats.sentence.retrySalvaged})`);
}

// ---- [H5] cancellation while the first response body is being read ----------
{
  console.log("[H5] CANCEL during the first body read cancels, no retry");
  reset();
  const m = msgFor();
  // The cancel arrives from inside the first response's json() -- while the
  // handler is awaiting the body, after the fetch resolved. The request is
  // still in activeRequests (the whole-handler registration), so the abort
  // lands: the signal-tied body read rejects, the response is "cancelled",
  // and the retry never starts. Pre-fix, the request had already been dropped
  // from activeRequests here: the cancel found nothing and the retry fired
  // anyway -- two requests and a refusal response instead of one and
  // "cancelled".
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        for (const fn of listeners) fn({ type: "CANCEL_REWRITE", requestId: m.requestId }, SENDER, () => {});
        return {
          message: { content: JSON.stringify({ rewritten: FIRST }) },
          done_reason: "stop", total_duration: 4e8, load_duration: 0,
          prompt_eval_count: 100, eval_count: 20,
        };
      },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.error === "cancelled",
    `the interaction reports cancelled (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `the retry never fetched (got ${chatCalls.length} calls)`);
  // ...and the TRANSPORT was cancelled, not merely the waiter. Every first-pass
  // await is now raced against the delivery deadline, so a prompt "cancelled"
  // answer is produced by the race whether or not the fetch ever hears about
  // it -- which made "remove `signal: ac.signal` from the first-pass fetch" a
  // mutation this whole file stayed green on. Assert the signal itself.
  check(chatSignals.length === 1 && chatSignals[0] && chatSignals[0].aborted === true,
    `the first-pass fetch carried a signal and it aborted (got ${JSON.stringify(
      chatSignals.map((x) => (x ? x.aborted : null)))})`);
  // Exactly ONE sendResponse. Chrome treats a second call as an error, and a
  // bare promise resolve makes a double call invisible.
  check(res !== undefined && chatCalls.length === 1, "sanity: one request");
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.error === "cancelled" && rec.retry === null,
    `record: cancelled, no retry attempted (got error=${rec && rec.error}, retry=${JSON.stringify(rec && rec.retry)})`);
}

// ---- [R1] exactly one sendResponse per interaction --------------------------
// Chrome treats a second sendResponse as an error, and the handler has two
// response bindings (an outer fallback for a stalled settings read, an inner
// one with the `responded` latch) plus a terminal catch that can call either.
// A bare promise resolve is idempotent, so every case above was green against
// a build that responded twice.
for (const [label, script] of [
  ["a plain applied result", () => { chatQueue = [chat(RETRY_OK)]; }],
  ["a guard refusal with a retry", () => { chatQueue = [chat(FIRST), chat(RETRY_OK)]; }],
  ["a delivery expiry mid-body", () => {
    chatQueue = [(body) => { clockOffset = 4650; return chat(RETRY_OK)(body); }];
  }],
]) {
  reset();
  script();
  const m = msgFor();
  const p = dispatch(m);
  await p;
  await settle();
  check(p.responseCount() === 1,
    `[R1] ${label}: sendResponse called once (got ${p.responseCount()})`);
  await ctx.ensureDictionary();
}

// ---- [H5b] cancellation while the RETRY fetch is in flight ------------------
{
  console.log("[H5b] CANCEL mid-retry aborts the in-flight second request");
  reset();
  const m = msgFor();
  // The second request hangs; a cancel arrives 10ms in. The signal-aware
  // fetch rejects with AbortError and the handler falls back to the original
  // refusal. The 300ms fallback resolve exists so a mutant that drops
  // `signal: ac.signal` from the retry fetch fails VISIBLY (an applied
  // response) rather than hanging the suite.
  chatQueue = [
    chat(FIRST),
    (body) => new Promise((resolve) => {
      setTimeout(() => {
        for (const fn of listeners) fn({ type: "CANCEL_REWRITE", requestId: m.requestId }, SENDER, () => {});
      }, 10);
      setTimeout(() => resolve(chat(RETRY_OK)(body)), 300);
    }),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `falls back to the refusal (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 2, `the retry did start (got ${chatCalls.length} calls)`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "error" && rec.retry.reason === "cancelled",
    `retry.outcome error/cancelled (got ${rec && rec.retry && rec.retry.outcome}/${rec && rec.retry && rec.retry.reason})`);
}

// ---- [H5c] a retry returning the original text is a no-op, not a delivery ---
{
  console.log("[H5c] retry no-op -> original refusal");
  reset();
  chatQueue = [chat(FIRST), chat(SENTENCE)];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `answers with the refusal (got ${JSON.stringify(res)})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "no-op",
    `retry.outcome no-op (got ${rec && rec.retry && rec.retry.outcome})`);
}

// ---- [H6] the retry shares the first pass's budget --------------------------
{
  console.log("[H6] a slow first pass leaves no budget -> no second request");
  reset();
  const m = msgFor();
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        clockOffset = 19000; // the first attempt "took" 19s of the 20s budget
        return {
          message: { content: JSON.stringify({ rewritten: FIRST }) },
          done_reason: "stop", total_duration: 4e8, load_duration: 0,
          prompt_eval_count: 100, eval_count: 20,
        };
      },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.error === "delivery-expired",
    `an expired first pass is not guarded (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `no second request on a spent budget (got ${chatCalls.length})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.error === "delivery-expired" && rec.retry === null,
    `delivery expiry, before any retry (got ${rec && rec.error})`);
}

// ---- [H6b] the deadline binds the retry's BODY read -------------------------
{
  console.log("[H6b] a stalled retry body aborts at the shared deadline (~2.6s)");
  reset();
  const m = msgFor();
  const ollamaBody = (text) => ({
    message: { content: JSON.stringify({ rewritten: text }) },
    done_reason: "stop", total_duration: 4e8, load_duration: 0,
    prompt_eval_count: 100, eval_count: 20,
  });
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        clockOffset = 2150; // 2.6s of the margin-shaved delivery budget remains
        return ollamaBody(FIRST);
      },
    }),
    // Headers arrive at once; the body stalls. The deadline timer must stay
    // armed through the body read and abort it at ~2.6s. The 4.5s fallback
    // resolve exists so a mutant that clears the timer at the headers fails
    // VISIBLY (an applied response) rather than hanging the suite.
    (body) => ({
      ok: true, status: 200,
      json: () => new Promise((resolve) => setTimeout(() => resolve(ollamaBody(RETRY_OK)), 4500)),
    }),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `falls back to the refusal (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 2, `the retry did start (got ${chatCalls.length} calls)`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "error" && rec.retry.reason === "timeout",
    `retry.outcome error/timeout (got ${rec && rec.retry && rec.retry.outcome}/${rec && rec.retry && rec.retry.reason})`);
}

// ---- [H6c] the DELIVERY lease binds, not just the transport timeout ---------
{
  console.log("[H6c] 3s elapsed: the 20s transport allows a retry, the 5s delivery lease does not");
  reset();
  const m = msgFor();
  // At 3s elapsed the transport deadline still has 17s -- a cap keyed to
  // SENTENCE_TIMEOUT_MS alone would happily retry into a correction the
  // content script is guaranteed to refuse as stale-age at 5s.
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => { clockOffset = 3000; return {
        message: { content: JSON.stringify({ rewritten: FIRST }) },
        done_reason: "stop", total_duration: 4e8, load_duration: 0,
        prompt_eval_count: 100, eval_count: 20,
      }; },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `answers with the refusal (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `no retry into a dead delivery window (got ${chatCalls.length})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "no-budget",
    `retry.outcome no-budget (got ${rec && rec.retry && rec.retry.outcome})`);
}

// ---- [H6d] the budget is re-checked AFTER the evidence work -----------------
{
  console.log("[H6d] budget passing on entry but spent by the evidence work is refused");
  reset();
  const m = msgFor();
  // The scripted clock burns 500ms at the helper's ENTRY deadline read, so
  // entry sees about 2.55s remaining (passes) and the post-evidence re-check sees
  // about 2.05s (fails). A helper that only checks on entry proceeds to fetch and
  // goes red here.
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        clockOffset = 2200;
        nowScript = [0, 0, 0, 0, 500];
        return {
          message: { content: JSON.stringify({ rewritten: FIRST }) },
          done_reason: "stop", total_duration: 4e8, load_duration: 0,
          prompt_eval_count: 100, eval_count: 20,
        };
      },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `answers with the refusal (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `no fetch on a budget the evidence work spent (got ${chatCalls.length})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "no-budget",
    `retry.outcome no-budget (got ${rec && rec.retry && rec.retry.outcome})`);
}

// ---- [H4-pre] consent revoked BEFORE the retry fetch ------------------------
{
  console.log("[H4-pre] consent revoked while the first response is processed: the retry never sends");
  reset();
  const m = msgFor();
  // The revocation lands from inside the first response's body -- before any
  // retry decision. The retry's own consent re-check (the moment-of-send
  // contract, same as the warmup's) must stop the second request from going
  // out at all: the retry SENDS user text and re-arms the lease, so a stale
  // consent snapshot must not authorize it.
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        store.sentenceMode = false;
        return {
          message: { content: JSON.stringify({ rewritten: FIRST }) },
          done_reason: "stop", total_duration: 4e8, load_duration: 0,
          prompt_eval_count: 100, eval_count: 20,
        };
      },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `answers with the refusal (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `the second request never went out (got ${chatCalls.length})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "not-allowed",
    `retry.outcome not-allowed (got ${rec && rec.retry && rec.retry.outcome})`);
}

// ---- [H4b] cancellation during the final consent read -----------------------
{
  console.log("[H4b] CANCEL while the final settings read is pending -> cancelled, not success");
  reset();
  const m = msgFor();
  // The retry applies; then the final consent read is deferred 40ms and a
  // cancel lands 10ms into it. The handler must answer "cancelled" -- content
  // has already cleared its job either way, but a success response and a
  // delivered-looking record would be the telemetry lying.
  chatQueue = [
    chat(FIRST),
    (body) => {
      deferNextGet = 40;
      setTimeout(() => {
        for (const fn of listeners) fn({ type: "CANCEL_REWRITE", requestId: m.requestId }, SENDER, () => {});
      }, 10);
      return chat(RETRY_OK)(body);
    },
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.error === "cancelled",
    `cancelled, not a success (got ${JSON.stringify(res)})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.error === "cancelled" && rec.retry && rec.retry.outcome === "applied",
    `record: cancelled with the applied-but-undelivered retry (got error=${rec && rec.error}, retry=${rec && rec.retry && rec.retry.outcome})`);
  const stats = await dispatch({ type: "GET_LOG_STATS" }, POPUP);
  check(stats && stats.ok && stats.sentence.retrySalvaged === 0,
    `an undelivered salvage is not counted (got ${stats && stats.sentence && stats.sentence.retrySalvaged})`);
}

// ---- [H14] a stalled FINAL consent read cannot outlive the deadline ---------
{
  console.log("[H14] the final consent read stalls after an applied retry -> refusal at the deadline (~2.7s)");
  reset();
  const m = sizeMessage();
  const t0 = RealDate.now();
  // The retry applies, then the final consent read stalls for 4s with only
  // ~2.65s of delivery budget left. The race must answer with the ORIGINAL
  // refusal at the deadline -- an unraced await turns a quick refusal into a
  // 4s job and then delivers a success the content script would refuse as
  // stale anyway.
  chatQueue = [
    chat(FIRST),
    (body) => {
      clockOffset = 2100;
      deferNextGet = 4000; // the next storage.get is the final consent read
      return chat(RETRY_OK)(body);
    },
  ];
  const res = await dispatch(m);
  const elapsed = RealDate.now() - t0;
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `falls back to the refusal (got ${JSON.stringify(res)})`);
  check(elapsed < 3500, `answered by the race, not by storage (took ${elapsed}ms)`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.error === "consent-read-timeout",
    `the record names the undelivered cause (got ${rec && rec.error})`);
  check(rec && rec.retry && rec.retry.outcome === "applied",
    `the salvage that existed is on the record (got ${rec && rec.retry && rec.retry.outcome})`);
  // [H14a] Mutant: attempts.pop() at the consent-read-timeout return.
  // The exported pair/output/outcome assertions below turn red. Also restoring
  // guard: payload.refused || null in sentenceResultFields makes the
  // undelivered-interaction assertion red.
  const exported = JSON.stringify((await dispatch({ type: "EXPORT_LOG" }, POPUP)).records);
  const row = JSON.parse(exported).find((r) => r.id === m.requestId);
  check(row?.output === null && row?.guard === null && row?.error === "consent-read-timeout",
    "[H14a] exported interaction is undelivered, not a second first refusal");
  check(JSON.stringify(row?.attempts?.map((a) => [a.attempt, a.output, a.guard, a.outcome])) ===
    JSON.stringify([["first", FIRST, "word-substituted:folx", "refused"], ["retry", RETRY_OK, null, "applied"]]),
    "[H14a] exported first refusal and accepted retry occur exactly once");
  sizeRecords["consent-timeout"] = row;
  const stats = await dispatch({ type: "GET_LOG_STATS" }, POPUP);
  check(stats && stats.ok && stats.sentence.retrySalvaged === 0,
    `an undelivered salvage is not counted (got ${stats && stats.sentence && stats.sentence.retrySalvaged})`);
}

// ---- [H6e] the consent read's own time counts against the deadline ----------
{
  console.log("[H6e] a slow pre-send consent read spends the budget -> no fetch");
  reset();
  const m = msgFor();
  // Entry sees 2.7s remaining (passes); the scripted clock burns 300ms at the
  // consent read's own Date.now, so the post-consent re-check sees 2.4s and
  // refuses. A helper that measures the budget BEFORE the consent await hands
  // Ollama a stale allowance and goes red here.
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        clockOffset = 2000;
        nowScript = [0, 0, 0, 0, 0, 300];
        return {
          message: { content: JSON.stringify({ rewritten: FIRST }) },
          done_reason: "stop", total_duration: 4e8, load_duration: 0,
          prompt_eval_count: 100, eval_count: 20,
        };
      },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `answers with the refusal (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `no fetch on a budget the consent read spent (got ${chatCalls.length})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "no-budget",
    `retry.outcome no-budget (got ${rec && rec.retry && rec.retry.outcome})`);
}

// ---- [H6f] a STALLED consent read is raced against the deadline (~2.6s) -----
{
  console.log("[H6f] the pre-send consent read stalls -> the deadline race answers, not storage");
  reset();
  const m = msgFor();
  const t0 = RealDate.now();
  // The consent read stalls for 4s; only 2.6s of budget remain. The race must
  // return no-budget at ~2.6s -- a helper that simply awaits storage answers
  // at 4s+, which the duration bound catches.
  chatQueue = [
    (body) => ({
      ok: true, status: 200,
      json: async () => {
        clockOffset = 2100;
        deferNextGet = 4000;
        return {
          message: { content: JSON.stringify({ rewritten: FIRST }) },
          done_reason: "stop", total_duration: 4e8, load_duration: 0,
          prompt_eval_count: 100, eval_count: 20,
        };
      },
    }),
    chat(RETRY_OK),
  ];
  const res = await dispatch(m);
  const elapsed = RealDate.now() - t0;
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `answers with the refusal (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `no fetch (got ${chatCalls.length})`);
  check(elapsed < 3500, `answered by the race, not by storage (took ${elapsed}ms)`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "no-budget",
    `retry.outcome no-budget (got ${rec && rec.retry && rec.retry.outcome})`);
}

// ---- [H8] an Ollama-level retry error forgets the runner --------------------
{
  console.log("[H8] retry HTTP 200 with data.error -> refusal, and the runner is forgotten");
  reset();
  const m = msgFor();
  chatQueue = [
    chat(FIRST),
    () => ({ ok: true, status: 200, json: async () => ({ error: "runner crashed" }) }),
  ];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `falls back to the refusal (got ${JSON.stringify(res)})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "error" && rec.retry.reason === "ollama-error",
    `retry.outcome error/ollama-error (got ${rec && rec.retry && rec.retry.outcome}/${rec && rec.retry && rec.retry.reason})`);
  // The failed request proved nothing about what is loaded: a warmup asked
  // right now must NOT read the phantom runner as hot -- that is
  // forgetOllamaRunner's whole invariant, and the retry noted the runner at
  // send time.
  const dec = ctx.sentenceWarmupDecision(await ctx.getSettings(), ORIGIN, FakeDate.now());
  check(dec && dec.reason !== "hot", `the next warmup is not 'hot' (got ${dec && dec.reason})`);
}

// ---- [H9] the retry output goes through the REAL sanitizer question ---------
{
  console.log("[H9] model-added markdown on the retry is refused as sanitizer-would-change");
  reset();
  const m = msgFor();
  // The retry returns the right words wrapped in markdown. The sanitizer
  // would have to repair it, and on the unattended path that is evidence of
  // misbehaviour, not something to clean up -- the retry output must face the
  // same raw-vs-cleaned question a first output does. A wiring mutant that
  // guards cleaned-against-cleaned silently applies this.
  chatQueue = [chat(FIRST), chat(`**${RETRY_OK}**`)];
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `falls back to the refusal (got ${JSON.stringify(res)})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "refused" && rec.retry.guard === "sanitizer-would-change",
    `retry.guard sanitizer-would-change (got ${rec && rec.retry && rec.retry.outcome}/${rec && rec.retry && rec.retry.guard})`);
}

// ---- [H10] a salvage the content script reported dropping is not "salvaged" -
{
  console.log("[H10] a sentence-skipped verdict removes the record from retrySalvaged");
  reset();
  chatQueue = [chat(FIRST, { loadNs: 0 }), chat(RETRY_OK)];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === true && res.rewritten === RETRY_OK, "the salvage was delivered to the worker's knowledge");
  await settle();
  let stats = await dispatch({ type: "GET_LOG_STATS" }, POPUP);
  check(stats && stats.ok && stats.sentence.retrySalvaged === 1, "counted while undisputed");
  // Content then reports the anchor was stale and the correction was dropped.
  await dispatch({ type: "REWRITE_OUTCOME", requestId: m.requestId, verdict: "sentence-skipped:anchor:stale-age" });
  await settle();
  stats = await dispatch({ type: "GET_LOG_STATS" }, POPUP);
  check(stats && stats.ok && stats.sentence.retrySalvaged === 0,
    `a reported drop uncounts the salvage (got ${stats && stats.sentence && stats.sentence.retrySalvaged})`);
}

// ---- [H7] a clean first pass never retries ----------------------------------
{
  console.log("[H7] applied first pass: one request, no retry field");
  reset();
  chatQueue = [chat(RETRY_OK), chat(RETRY_OK)];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === true && res.rewritten === RETRY_OK, "first pass applies");
  check(chatCalls.length === 1, `one request (got ${chatCalls.length})`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry === null, `no retry field on an untried request (got ${JSON.stringify(rec && rec.retry)})`);
}

// [H17] Mutant: sanitizeSentenceOutput("", rewritten) in runSentenceEngine.
// The delivered correction and echo noChanges/no-guard assertions turn red.
{
  console.log("[H17] First-pass typography and echo");
  const corrected = "I don’t think the plan works.";
  for (const [sentence, echo] of [["I don’t think teh plan works.", false], [corrected, true]]) {
    reset();
    chatQueue = [chat(corrected)];
    const m = { ...msgFor(), sentence };
    const res = await dispatch(m);
    await vm.runInContext("logQueue", ctx);
    const rec = findRecord(m.requestId);
    check(res?.ok === true && (echo ? res.noChanges === true : res.rewritten === corrected),
      `[H17] ${echo ? "echo is noChanges" : "correction delivers U+2019"}`);
    check(chatCalls.length === 1, `[H17] ${echo ? "echo" : "correction"} makes one request`);
    check(rec?.guard === null && !res?.refused, `[H17] ${echo ? "echo" : "correction"} has no guard attribution`);
    check(rec?.v === 2 && rec.attempts.length === 1 && rec.attempts[0].guard === null
      && rec.attempts[0].output === corrected, `[H17] one accepted canonical attempt preserves the raw typography`);
  }
}

// [H18] Mutant: sanitizeSentenceOutput("", raw) in retrySentenceRewrite.
// The delivered retry, applied outcome and second-attempt guard assertions
// turn red. The straightened first answer still reaches retry before the fix.
{
  console.log("[H18] Retry typography");
  reset();
  vm.runInContext("sentenceRetryFailStreak = 0; sentenceRetryBreakerUntil = 0", ctx);
  const sentence = "I don’t think teh caching problem works.";
  const first = "I don't think the caching issue works.";
  const corrected = "I don’t think the caching problem works.";
  chatQueue = [chat(first), chat(corrected)];
  const m = { ...msgFor(), sentence };
  const res = await dispatch(m);
  await vm.runInContext("logQueue", ctx);
  const rec = findRecord(m.requestId);
  check(chatCalls.length === 2, "[H18] exactly two chat requests");
  check(res?.ok === true && res.rewritten === corrected, "[H18] retry delivers U+2019 and only the typo correction");
  check(rec?.retry?.outcome === "applied" && rec.guard === null && rec.output === corrected,
    "[H18] record publishes the applied retry");
  check(rec?.v === 2 && rec.attempts.length === 2 && rec.attempts[0].guard === "typography-changed"
    && rec.attempts[0].output === first && rec.attempts[1].guard === null
    && rec.attempts[1].output === corrected, "[H18] canonical attempts retain first refusal and accepted retry");
}

// [H19] Mutant: if (subs2.length && subDetail) Object.assign(subDetail, viewDetail);
// [H20] Mutants: publish dedupExcused: []; or remove the dedupExcused exclusion
// line in sentenceRetryKeepList. Each turns its one-request/no-keeps/one-attempt
// assertions red; the original-refusal assertion remains the control.
for (const [id, sentence, output, guard] of [
  ["H19", "The sample index lists an Antrhopic paper.", "The sample index lists an Anthropic paper!", "terminator-changed"],
  ["H20", "i know know that Alice left.", "i know that alice left.", "capital-removed"],
]) {
  console.log(`[${id}] explained loss sends no retry`);
  reset(); // current consent and a fresh deadline
  vm.runInContext("sentenceRetryFailStreak = 0; sentenceRetryBreakerUntil = 0", ctx);
  const m = { ...msgFor(), sentence };
  chatQueue = [chat(output), chat(output)];
  const res = await dispatch(m);
  await vm.runInContext("logQueue", ctx);
  const rec = findRecord(m.requestId);
  check(res?.ok === false && res.refused === guard, `[${id}] original refusal is returned`);
  check(chatCalls.length === 1, `[${id}] exactly one chat request`);
  check(rec?.guard === guard && rec.output === output, `[${id}] record retains the original refusal and raw output`);
  check(rec?.retry?.outcome === "no-keeps", `[${id}] retry outcome is no-keeps`);
  check(rec?.v === 2 && rec.attempts.length === 1 && rec.attempts[0].guard === guard,
    `[${id}] one canonical refused attempt is recorded`);
}

// [H15a–c] Mutant per arm: first-pass error: "<code>" -> refused: "<code>";
// that arm's error-response and guard-null record assertions turn red.
for (const [id, error, content, doneReason] of [
  ["H15a", "truncated", JSON.stringify({ rewritten: RETRY_OK }), "length"],
  ["H15b", "invalid-json", '{"rewritten":', "stop"],
  ["H15c", "no-rewritten-key", JSON.stringify({ output: RETRY_OK }), "stop"],
]) {
  console.log(`[${id}] ${error} is a model-shape error before guards`);
  reset();
  const m = msgFor();
  chatQueue = [chat(RETRY_OK, { body: { message: { content }, done_reason: doneReason } })];
  const res = await dispatch(m);
  await vm.runInContext("logQueue", ctx);
  const rec = findRecord(m.requestId);
  check(res?.ok === false && res.error === error && !("refused" in res) && !("network" in res),
    `[${id}] error response without refused or network (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1 && chatQueue.length === 0, `[${id}] exactly one model request`);
  check(rec?.guard === null && rec.error === error && rec.output === null,
    `[${id}] stored guard is null with matching error and no output`);
  check(rec?.retry === null, `[${id}] no retry is recorded`);
}

// [H15d] Mutant: target validation error: "target-length" -> refused: "target-length";
// both out-of-range error-response assertions turn red; no chat/record are controls.
{
  console.log("[H15d] target length fails before any model request or record");
  for (const sentence of ["Hi.", "x".repeat(10001)]) {
    reset();
    const m = { ...msgFor(), sentence };
    const res = await dispatch(m);
    await vm.runInContext("logQueue", ctx);
    check(res?.ok === false && res.error === "target-length" && !("refused" in res) && !("network" in res),
      `[H15d] length ${sentence.length} returns target-length error, not refusal`);
    check(chatCalls.length === 0, `[H15d] length ${sentence.length} makes no chat request`);
    check(findRecord(m.requestId) === null, `[H15d] length ${sentence.length} creates no record`);
  }
}

// ---- [H16] serialized schema and representative record-size gate ------------
// Mutant: omit dispatched from sentenceResultFields's returned object; the
// literal exported field paths and the architecture schema agreement turn red.
{
  console.log("[H16] v2 EXPORT_LOG schema, attempt measurements and record sizes");
  const fields = "v ts verdict finalText id origin path arrivedAt startedAt completedAt warmupIds promptRevision modelDigest backend model options keepAliveMs input context trigger dispatched attempts output guard noChanges error retry timings".split(" ").sort();
  const attemptFields = "attempt dispatchedAt completedAt timings output guard error outcome".split(" ").sort();
  const timingFields = "wallMs totalMs loadMs promptTokens promptMs evalTokens evalMs".split(" ").sort();
  const doc = readFileSync(join(ROOT, "ARCHITECTURE.md"), "utf8").split("### Sentence interaction record")[1]?.split("\n### ")[0] || "";
  const documented = [...doc.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);
  check(JSON.stringify(documented.filter((p) => !p.includes(".")).sort()) === JSON.stringify(fields),
    "[H16] documented top-level field paths match the literal schema");
  check(JSON.stringify(documented.filter((p) => p.startsWith("attempts[].")).map((p) => p.slice(11)).sort()) === JSON.stringify(attemptFields),
    "[H16] documented attempt field paths match the literal schema");
  const scenarios = [
    ["no-retry", [chat(RETRY_OK)]],
    ["retry-applied", [chat(FIRST), chat(RETRY_OK)]],
    ["retry-refused", [chat(FIRST), chat("")]],
    ["refusal", [chat("A completely unrelated sentence about mountains.")]],
    ["error", [() => { throw new TypeError("synthetic transport failure"); }]],
  ];
  for (const [name, queue] of scenarios) {
    reset();
    vm.runInContext("sentenceRetryBreakerUntil = 0", ctx);
    chatQueue = queue;
    const m = sizeMessage();
    await dispatch(m);
    await vm.runInContext("logQueue", ctx);
    const exported = await dispatch({ type: "EXPORT_LOG" }, POPUP);
    const row = JSON.parse(JSON.stringify(exported.records)).find((r) => r.id === m.requestId);
    sizeRecords[name] = row;
    check(JSON.stringify(Object.keys(row || {}).sort()) === JSON.stringify(fields), `[H16] ${name} serialized field paths`);
    check(row?.v === 2 && row.dispatched === true && row.keepAliveMs === 20000, `[H16] ${name} version and dispatch lease`);
    check(row?.arrivedAt === row?.startedAt && row?.completedAt >= row?.arrivedAt && row?.ts >= row?.completedAt
      && row.timings.wallMs === row.completedAt - row.arrivedAt, `[H16] ${name} interaction clocks and alias`);
    for (const attempt of row?.attempts || []) {
      check(JSON.stringify(Object.keys(attempt).sort()) === JSON.stringify(attemptFields)
        && JSON.stringify(Object.keys(attempt.timings).sort()) === JSON.stringify(timingFields), `[H16] ${name} attempt field paths`);
      check(attempt.timings.wallMs === attempt.completedAt - attempt.dispatchedAt
        && attempt.dispatchedAt >= row.arrivedAt && attempt.completedAt <= row.completedAt, `[H16] ${name} attempt clocks`);
    }
    check(row?.timings.promptTokens === (name === "error" ? null : 100)
      && row?.timings.evalTokens === (name === "error" ? null : 20), `[H16] ${name} first-attempt counter projection`);
  }
  // The early response path cannot retain unconsented input or prepared options.
  reset();
  deferNextGet = 30;
  const m = msgFor();
  const pending = dispatch(m);
  clockOffset = 5000;
  await pending;
  await vm.runInContext("logQueue", ctx);
  const exported = await dispatch({ type: "EXPORT_LOG" }, POPUP);
  const early = JSON.parse(JSON.stringify(exported.records)).find((r) => r.id === m.requestId);
  check(JSON.stringify(Object.keys(early || {}).sort()) === JSON.stringify(fields), "[H16] early failure serialized field paths");
  check(["model", "options", "modelDigest", "backend", "keepAliveMs", "input", "context", "trigger", "output", "guard", "retry"].every((key) => early?.[key] === null)
    && early?.dispatched === false && early?.attempts?.length === 0 && early?.error === "delivery-expired", "[H16] early failure nullability and no dispatch");
  const sizes = Object.fromEntries(Object.entries(sizeRecords).filter(([, row]) => row).map(([name, row]) => [name, Buffer.byteLength(JSON.stringify(row))]));
  const average = Object.values(sizes).reduce((a, b) => a + b, 0) / 6;
  const measure = { sizes, average, maximum: Math.max(...Object.values(sizes)), ringBytes: 5000 * average };
  check(Object.keys(sizes).length === 6 && measure.ringBytes <= 8000000, "[H16] six representative records fit the 8 MB sentence budget");
  console.log("[H16] record bytes " + JSON.stringify(measure));
  if (process.env.PROOFER_RECORD_SIZES) writeFileSync(process.env.PROOFER_RECORD_SIZES, JSON.stringify(measure, null, 2) + "\n");
}

// ---- [T] the installed digest is checked before the text is sent ------------
// Checkpoint 1 (2026-09-25): records carried no digest at all, so two
// different weights under one tag were indistinguishable in an export. The
// engine now asks /api/tags before it sends, refuses a copy under the pinned
// tag with another digest, and records the digest it saw.
{
  console.log("[T1] the pinned digest installed: sent, and the record carries it");
  reset();
  chatQueue = [chat(RETRY_OK)];
  const m = msgFor();
  const res = await dispatch(m);
  await settle();
  const pin = vm.runInContext("PINNED_MODEL", ctx);
  check(res && res.ok === true && chatCalls.length === 1, "the request is sent");
  check(findRecord(m.requestId)?.modelDigest === pin.digest,
    `the record names the digest it saw (got ${findRecord(m.requestId)?.modelDigest})`);
}
{
  console.log("[T2] another digest under the pinned tag: refused, nothing sent");
  reset();
  tagsScript = (pin) => [{ name: pin.tag, model: pin.tag, digest: "f".repeat(64) }];
  chatQueue = [chat(RETRY_OK)];
  const m = msgFor();
  const res = await dispatch(m);
  await settle();
  check(res && res.ok === false && res.error === "model-mismatch" && !res.network,
    `refused as model-mismatch (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 0, `the user's text was not sent (got ${chatCalls.length})`);
  check(findRecord(m.requestId)?.modelDigest === "f".repeat(64), "the record names the digest it refused");
  // Found by a sentence, it voids the verdict for everything else too
  // (checkpoint 3): the speed check is marked stale, so the next sentence is
  // refused before any lookup at all.
  const q = store[vm.runInContext("QUALIFICATION_KEY", ctx)];
  check(q && q.stale === "engine-mismatch", `[T2b] the verdict is marked stale (got ${q && q.stale})`);
  tagsScript = null;
  const next = await dispatch(msgFor());
  check(next && next.ok === false && next.error === "not-allowed" && chatCalls.length === 0,
    `[T2b] ...and the next sentence is refused, nothing sent (got ${JSON.stringify(next)})`);
  chatQueue = [];
}
{
  // The invalidation cancels work already in flight: a second sentence whose
  // model call is out when the first finds the mismatch is not delivered.
  console.log("[T2c] a mismatch found while another sentence is out: that one is cancelled");
  reset();
  let release;
  chatQueue = [() => new Promise((r) => { release = r; })];
  const first = dispatch(msgFor());
  await settle(20);
  check(chatCalls.length === 1, "the first sentence's request is out");
  tagsScript = (pin) => [{ name: pin.tag, model: pin.tag, digest: "f".repeat(64) }];
  vm.runInContext("forgetModelDigests", ctx)();
  const second = await dispatch(msgFor());
  check(second && second.error === "model-mismatch", `the second finds the mismatch (got ${JSON.stringify(second)})`);
  await settle();
  release && release(chat(RETRY_OK)());
  const r1 = await first;
  // Cancelled, and its transport aborted -- not merely refused at delivery,
  // which the configuration generation would also do.
  check(r1 && r1.ok === false && r1.error === "cancelled" && chatSignals[0] && chatSignals[0].aborted === true,
    `[T2c] the first is cancelled, its request aborted (got ${JSON.stringify(r1)})`);
  chatQueue = [];
}
{
  console.log("[T3] the pinned tag not installed: refused, nothing sent");
  reset();
  tagsScript = () => [{ name: "something-else:latest", model: "something-else:latest", digest: "a".repeat(64) }];
  chatQueue = [chat(RETRY_OK)];
  const res = await dispatch(msgFor());
  check(res && res.error === "model-missing" && chatCalls.length === 0,
    `refused as model-missing, nothing sent (got ${JSON.stringify(res)}, ${chatCalls.length} sent)`);
  await settle();
  const q = store[vm.runInContext("QUALIFICATION_KEY", ctx)];
  check(q && q.stale === "engine-missing", `[T3b] the verdict is marked stale (got ${q && q.stale})`);
  chatQueue = [];
}
{
  // An engine that cannot be verified is not known to be the pinned one, so
  // the text does not go (checkpoint 1 re-check: it used to).
  console.log("[T4] Ollama cannot say what is installed: refused, nothing sent");
  reset();
  tagsScript = () => { throw new Error("tags broke"); };
  chatQueue = [chat(RETRY_OK)];
  const m = msgFor();
  const res = await dispatch(m);
  await settle();
  check(res && res.ok === false && res.error === "model-unverified" && !res.network && chatCalls.length === 0,
    `refused as model-unverified, nothing sent (got ${JSON.stringify(res)}, ${chatCalls.length} sent)`);
  check(findRecord(m.requestId)?.modelDigest === null, "and the record says it did not know");
  // Nothing answered at all: a network failure, which the content script
  // backs off from exactly as it would for the request itself.
  reset();
  tagsScript = () => { throw new TypeError("Failed to fetch"); };
  chatQueue = [chat(RETRY_OK)];
  const res2 = await dispatch(msgFor());
  check(res2 && res2.error === "unreachable" && res2.network === true && chatCalls.length === 0,
    `[T4b] a lookup nobody answered is a network failure, nothing sent (got ${JSON.stringify(res2)})`);
  chatQueue = [];
}
// [T4c] Mutant: startSentenceAttempt(attempts, "first") before preflight;
// zero attempts, false dispatch and null lease turn red.
{
  reset();
  tagsScript = () => { throw new TypeError("tags unreachable"); };
  const m = msgFor();
  await dispatch(m);
  await vm.runInContext("logQueue", ctx);
  const row = findRecord(m.requestId);
  check(row?.dispatched === false && row?.attempts?.length === 0 && row?.keepAliveMs === null,
    "[T4c] tags failure has no inference dispatch or lease");
  check(row?.error === "unreachable" && typeof row?.timings?.wallMs === "number", "[T4c] unsent interaction retains error and wall");
}
// [T4d] Mutant: remove the first attempt on fetch failure (append only after
// success); the dispatched attempt, measured wall and null counters turn red.
{
  reset();
  chatQueue = [async () => { await settle(20); throw new TypeError("POST unreachable"); }];
  const m = msgFor();
  await dispatch(m);
  await vm.runInContext("logQueue", ctx);
  const row = findRecord(m.requestId);
  const a = row?.attempts?.[0];
  check(row?.dispatched === true && row?.attempts?.length === 1 && row?.keepAliveMs === 20000,
    "[T4d] POST transport failure retains one dispatched attempt");
  check(a?.outcome === "error" && a?.error === "unreachable" && a?.output === null && a?.guard === null
    && a?.timings?.wallMs >= 15 && a.timings.wallMs === a.completedAt - a.dispatchedAt
    && ["totalMs", "loadMs", "promptTokens", "promptMs", "evalTokens", "evalMs"].every((key) => a.timings[key] === null),
    "[T4d] failed POST has measured wall and unavailable Ollama counters");
}
{
  console.log("[T5] the lookup is cached for a burst, and dropped after a failed request");
  reset();
  chatQueue = [chat(RETRY_OK), chat(RETRY_OK)];
  await dispatch(msgFor());
  await dispatch(msgFor());
  check(tagsCalls === 1, `two sentences in a burst ask /api/tags once (got ${tagsCalls})`);
  chatQueue = [() => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }), chat(RETRY_OK)];
  await dispatch(msgFor());
  await dispatch(msgFor());
  check(tagsCalls === 2, `a failed request makes the next one ask again (got ${tagsCalls})`);
  // And the cache runs out: 31 s later the next sentence asks again.
  chatQueue = [chat(RETRY_OK)];
  clockOffset += 31000;
  await dispatch(msgFor());
  check(tagsCalls === 3, `the lookup expires after 30 s (got ${tagsCalls})`);
}
{
  // Consent read at arrival, then withdrawn while the digest lookup is out:
  // the text must not go (checkpoint 1 re-check, finding 9).
  for (const [label, withdraw] of [
    ["global off", () => { store.sentenceMode = false; }],
    ["off for this site", () => { store.sentenceModeDisabledSites = [ORIGIN]; }],
  ]) {
    console.log(`[T6] consent withdrawn during the lookup (${label}): nothing sent`);
    reset();
    let release;
    tagsGate = new Promise((r) => { release = r; });
    chatQueue = [chat(RETRY_OK)];
    const pending = dispatch(msgFor());
    for (let i = 0; i < 100 && tagsCalls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    withdraw();
    release();
    const res = await pending;
    tagsGate = null;
    check(res && res.ok === false && res.error === "not-allowed" && chatCalls.length === 0,
      `[T6] ${label}: refused before the send (got ${JSON.stringify(res)}, ${chatCalls.length} sent)`);
    chatQueue = [];
  }
}
{
  // The engine holds its OWN answer to the delivery deadline (finding 6): a
  // retry that lands after the deadline, with a final consent read that
  // settles at once, must not come back as a success from the engine itself --
  // the handler is not the only caller (setup, the quality suites).
  console.log("[T7] a retry that lands after the deadline is expired by the engine, not only by the handler");
  reset();
  const runSentenceEngine = vm.runInContext("runSentenceEngine", ctx);
  const prepare = vm.runInContext("prepareSentenceRequest", ctx);
  const pin = vm.runInContext("PINNED_MODEL", ctx);
  const start = FakeDate.now();
  const deadlineMs = start + 4750;
  chatQueue = [chat(FIRST), (body) => { clockOffset += 4800; return chat(RETRY_OK)(body); }];
  const req = prepare(SENTENCE, "", {});
  const { payload, meta } = await runSentenceEngine({
    sentence: SENTENCE, priorContext: "", pageContext: {}, trigger: "idle", req,
    ollamaUrl: "http://localhost:11434", ac: new AbortController(), deadlineMs,
    checkAllowed: async () => true, expectedDigest: pin.digest,
  });
  check(chatCalls.length === 2 && meta.retry && meta.retry.outcome === "applied",
    `the retry went out and applied (got ${chatCalls.length} requests, ${JSON.stringify(meta.retry && meta.retry.outcome)})`);
  check(payload.ok === false && payload.error === "delivery-expired",
    `...and the engine answers delivery-expired (got ${JSON.stringify(payload)})`);
}

// ---- [H13] the trigger reaches the retry's guard call -----------------------
{
  console.log("[H13] an idle retry is held to the idle-only guard; next-sentence applies");
  // The retry output "I do that anyway." fails EXACTLY one guard and only on
  // the idle trigger (idle-final-inflection). A wiring mutant that drops
  // { trigger } from the retry's guard call silently applies the idle case.
  const S2 = "I do that anyways.";
  const S2_FIRST = "I do that always.";   // word-substituted:anyways -> retryable, keeps ["anyways."]
  const S2_RETRY = "I do that anyway.";
  for (const [trigger, expectApplied] of [["idle", false], ["next-sentence", true]]) {
    reset();
    chatQueue = [chat(S2_FIRST), chat(S2_RETRY)];
    const m = { type: "SENTENCE_REWRITE", requestId: `sn_test_${++seq}`,
      sentence: S2, priorContext: "", trigger };
    const res = await dispatch(m);
    if (expectApplied) {
      check(res && res.ok === true && res.rewritten === S2_RETRY,
        `[${trigger}] the inflection applies (got ${JSON.stringify(res)})`);
    } else {
      check(res && res.ok === false && res.refused === "word-substituted:anyways",
        `[${trigger}] falls back to the refusal (got ${JSON.stringify(res)})`);
      await settle();
      const rec = findRecord(m.requestId);
      check(rec && rec.retry && rec.retry.guard === "idle-final-inflection",
        `[${trigger}] the retry was refused by the trigger-keyed guard (got ${rec && rec.retry && rec.retry.guard})`);
    }
  }
}

// ---- [D1-D4] each first-pass await owns the SAME absolute deadline ----------
for (const phase of ["settings", "headers", "body", "consent"]) {
  reset();
  const m = msgFor();
  const t0 = RealDate.now();
  if (phase === "settings") {
    nowScript = [4650]; // arrival is captured BEFORE this increment
    deferNextGet = 400;
    chatQueue = [chat(RETRY_OK)];
  } else if (phase === "headers") {
    // Settings spends 4s of logical time AND resolves after 40ms. A fresh
    // budget after that read waits for the 1.6s fallback and fails the bound.
    nowScript = [4000];
    deferNextGet = 40;
    chatQueue = [(body) => new Promise((resolve) =>
      setTimeout(() => resolve(chat(RETRY_OK)(body)), 1600))];
  } else if (phase === "body") {
    chatQueue = [(body) => {
      clockOffset = 4650;
      const response = chat(RETRY_OK)(body);
      return { ...response, json: () => new Promise((resolve) =>
        setTimeout(async () => resolve(await response.json()), 400)) };
    }];
  } else {
    chatQueue = [(body) => {
      clockOffset = 4650;
      deferNextGet = 400; // only FINAL consent; initial settings already won
      return chat(RETRY_OK)(body);
    }];
  }
  const res = await dispatch(m);
  const elapsed = RealDate.now() - t0;
  await settle();
  const rec = findRecord(m.requestId);
  check(res?.error === "delivery-expired" && !res.network &&
    elapsed < (phase === "headers" ? 1100 : 300) &&
    chatCalls.length === (phase === "settings" ? 0 : 1) &&
    rec?.error === "delivery-expired" && rec.retry == null &&
    !vm.runInContext("activeRequests.size", ctx),
    `[D:${phase}] expiry answers, records and releases within the arrival lease (${elapsed}ms)`);
  // Let the losing storage/fetch promise settle before resetting the fixture.
  await settle(phase === "headers" ? 1700 : 450);
}

// ---- [H12] the worker-side retry breaker ------------------------------------
// LAST: the breaker is module state inside the vm, and opening it on purpose
// would poison any scenario that runs after it.
{
  console.log("[H12] three service-failing retries open the breaker; the fourth never sends");
  const boom = () => { throw Object.assign(new Error("down"), { name: "TypeError" }); };
  for (let i = 0; i < 3; i++) {
    reset();
    chatQueue = [chat(FIRST), boom];
    const res = await dispatch(msgFor());
    check(res && res.ok === false && res.refused === "word-substituted:folx",
      `failure ${i + 1} still answers with the refusal`);
  }
  reset();
  chatQueue = [chat(FIRST), chat(RETRY_OK)];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === false && res.refused === "word-substituted:folx",
    `the fourth answers with the refusal, unsalvaged (got ${JSON.stringify(res)})`);
  check(chatCalls.length === 1, `the breaker stopped the fourth retry (got ${chatCalls.length} calls)`);
  await settle();
  const rec = findRecord(m.requestId);
  check(rec && rec.retry && rec.retry.outcome === "breaker-open",
    `retry.outcome breaker-open (got ${rec && rec.retry && rec.retry.outcome})`);
}

// ---- [H11] the clock starts at request arrival, not after the settings read -
{
  console.log("[H11] a slow initial settings read is inside wallMs and the deadline");
  reset();
  deferNextGet = 40; // the initial getSettings
  chatQueue = [chat(RETRY_OK)];
  const m = msgFor();
  const res = await dispatch(m);
  check(res && res.ok === true, `clean pass (got ${JSON.stringify(res)})`);
  await settle();
  const rec = findRecord(m.requestId);
  // startedAt captured after the settings await reads ~0 here and goes red:
  // the content-side lease started at capture, so the worker's clock must
  // start at arrival.
  check(rec && rec.timings && rec.timings.wallMs >= 35,
    `wallMs includes the initial settings wait (got ${rec && rec.timings && rec.timings.wallMs})`);
}

// [H11b] Mutant: shadow arrivedAt with Date.now() after the initial settings
// await; exported arrival/alias and the held-read duration assertions turn red.
{
  reset();
  deferNextGet = 40;
  chatQueue = [(body) => { clockOffset += 13; const response = chat(RETRY_OK)(body);
    return { ...response, json: async () => { clockOffset += 17; return response.json(); } }; }];
  const m = msgFor();
  const before = RealDate.now();
  await dispatch(m);
  const after = FakeDate.now();
  await settle(30); // persistence timestamp must not replace response completion
  const exported = await dispatch({ type: "EXPORT_LOG" }, POPUP);
  const row = JSON.parse(JSON.stringify(exported.records)).find((r) => r.id === m.requestId);
  check(row?.arrivedAt >= before && row?.arrivedAt < before + 25 && row?.startedAt === row?.arrivedAt,
    "[H11b] exported arrival precedes the held settings read and equals startedAt");
  check(row?.completedAt <= after && row?.completedAt - row?.arrivedAt >= 65
    && row?.timings?.wallMs === row?.completedAt - row?.arrivedAt, "[H11b] exported completion fixes the whole interaction wall");
  check(row?.attempts?.[0]?.timings?.wallMs >= 30 && row.attempts[0].timings.wallMs < row.timings.wallMs - 25,
    "[H11b] attempt wall includes fetch and body, excludes initial consent wait");
}

console.log(`\n${"=".repeat(72)}`);
console.log(`${pass} passed | ${fail} failed`);
process.exit(fail ? 1 : 0);
