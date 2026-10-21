// The speed check and its stored verdict, driven
// through the SHIPPING message handlers in a vm against a scripted Ollama.
//
// Offline: no model, no browser, no node_modules. What is pinned:
//
//   [1] a passing run on a GPU is stored, current, and is what lets Proofer be
//       turned on and write; its report holds timings and no text
//   [2] a wrong answer fails the machine as "unexpected", and Turn on is refused
//   [3] one case past the deadline fails it as "too-slow"
//  [3b] ...except the long-context case (owner, 2026-09-25): dropped cleanly
//       it passes, and the ready screen is told; the sentence after it must
//       be an ordinary one; a wrong answer there still fails the machine
//   [4] on a CPU the thread count is calibrated, the qualifying run uses the
//       chosen count, and every later request and warmup carries it
//   [5] the engine missing at the start: the run stops, and the failure is
//       what is stored -- never an earlier pass (checkpoint 3); an Ollama
//       updated mid-run, a run the worker lost, a failed retest: the same
// [5g] settings replies distinguish live and orphaned runs without persisting
//      the projection or changing effective consent and the pin
// [5h] a rejected new attempt leaves historical report identity/measurements
// [5i] bounds are snapshotted, preserved on export, or explicitly unknown
//   [6] the Ollama URL changed mid-run, or during the finish: no pass stored;
//       during a sentence's inference, or during its final consent read: that
//       correction is not delivered; an engine found missing by setup voids a
//       correction in flight and a warmup never loads another digest
//  [10] the bounds at their edges: warm p95 past 3.5 s with every case under
//       4.5 s; calibration picks the FASTEST thread count; /api/ps and the
//       unload must answer, and "could not tell" is never "cold"; the version
//       cache expires on the clock
//   [7] freshness: an Ollama update marks the verdict stale and stops the next
//       sentence before it is sent; the badge says why; and the first consent
//       ask (a field's first focus) is where it is noticed
//   [8] only the setup page may send the setup messages
//   [9] setup's check of the download: digest, template and parameters
// [7c-d] badge recovery, cancellation and configured-endpoint preview isolation
//  [9b] fresh verification/state reads inside TTL, ordinary cache control
// [11a-c] failed inventory observations and worker/recorded-version floor
// [12a-c] bounded diagnostics and terminal operational failures
// [13a-c] installer tag/digest parity, inventory failures and pull recovery
//
// The first sentence of a burst waits SETUP_FIRST_DELAY_MS (6 s) after its
// warmup in the product; this harness compresses exactly that one delay so a
// run takes seconds, not a minute. Nothing else about time is changed.
//
//   node setup-check-test.mjs

import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const src = readFileSync(join(ROOT, "background.js"), "utf8");

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL ${label}`); } };

// --- chrome.* -------------------------------------------------------------------
let store = {};
let fastPoll = false;
let rejectRunningWrite = false;
// The worker's clock, advanced by [10]'s cache-expiry case.
let clockOffset = 0;
class TestDate extends Date { static now() { return Date.now() + clockOffset; } }
const listeners = [];
let badge = { text: "", title: "" };
const EXT = "chrome-extension://setuptestid/";
const ctx = vm.createContext({
  chrome: {
    runtime: {
      id: "setuptestid", lastError: undefined,
      getURL: (p) => EXT + p,
      getManifest: () => ({ version: "0.0.0-test" }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    action: {
      setBadgeText: async ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: async () => {},
      setTitle: async ({ title }) => { badge.title = title; },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const out = {};
          if (keys === null) Object.assign(out, store);
          else if (keys && typeof keys === "object" && !Array.isArray(keys)) {
            for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
          } else for (const k of (Array.isArray(keys) ? keys : [keys])) out[k] = store[k];
          cb(JSON.parse(JSON.stringify(out)));
        },
        set: (obj, cb) => {
          if (rejectRunningWrite && obj.setupQualification?.category === "running") {
            ctx.chrome.runtime.lastError = { message: "injected running-record write failure" };
            try { cb && cb(); } finally { ctx.chrome.runtime.lastError = undefined; }
            return;
          }
          Object.assign(store, JSON.parse(JSON.stringify(obj))); cb && cb();
        },
        remove: (keys, cb) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k]; cb && cb(); },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: { create: () => {}, get: async () => ({ url: "https://x.com/a" }) },
  },
  console, clearTimeout, AbortController, URL, TextEncoder, crypto: globalThis.crypto,
  AbortSignal, Date: TestDate,
  navigator: { hardwareConcurrency: 8 },
  // Only the first-sentence delay is compressed (see the header) -- and, for
  // [10]'s cases that wait out the unload poll, its 250 ms step when asked.
  setTimeout: (fn, ms, ...a) => setTimeout(fn, ms === 6000 ? 30 : ms === 250 && fastPoll ? 1 : ms, ...a),
  fetch: (...a) => fakeFetch(...a),
});
vm.runInContext(src, ctx);
const W = (expr) => vm.runInContext(expr, ctx);
ok(W("SETUP_FIRST_DELAY_MS") === 6000, "the compressed delay is the one this harness means (6000)");
const PIN = W("PINNED_MODEL");
const FIXTURES = W("SETUP_FIXTURES");
const CASES = W("SETUP_CASE_COUNT");
const KEY = W("QUALIFICATION_KEY");

// --- A scripted Ollama ------------------------------------------------------------
// The template and parameters /api/show reports. The real template is the
// model's own; this suite checks the comparison, so it pins a stand-in's hash.
const FAKE_TEMPLATE = "{{- range .Messages }}<|{{ .Role }}|>{{ .Content }}{{ end }}";
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
W(`PINNED_MODEL.templateSha256 = ${JSON.stringify(await sha(FAKE_TEMPLATE))}`);

let fake;
function resetFake(over = {}) {
  fake = {
    version: "0.32.12", installed: true, digest: PIN.digest, loaded: false, gpu: true,
    template: FAKE_TEMPLATE, parameters: "temperature 0.1\ntop_k 20\ntop_p 0.8\nnum_ctx 2048\nrepeat_penalty 1",
    // fixture id -> { answer?, delayMs? }; "<id>#<n>" scripts only the n-th
    // time that fixture is sent (SETUP_AFTER_LONG is sent twice)
    script: {}, sent: {}, chats: [], loads: [], down: false,
    // numThread -> extra ms per sentence, for calibration; the HTTP status
    // /api/ps and the unload answer with; whether an unload unloads.
    threadDelay: {}, psStatus: 200, psBody: null, unloadStatus: 200, unloadWorks: true,
    versionCalls: 0, tagsCalls: 0, showCalls: 0, unloadCalls: 0, loadDuration: true,
    tagsFault: null, versionFault: null, warmupFault: null, chatFault: null, downUrl: null, ...over,
  };
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body) });
const byText = new Map(FIXTURES.map((f) => [f.text, f]));
function faultResponse(fault) {
  if (fault === "abort") throw Object.assign(new Error("synthetic cancellation"), { name: "AbortError" });
  if (fault === "body-abort") return { ...json(null), json: async () => { throw Object.assign(new Error("synthetic body cancellation"), { name: "AbortError" }); } };
  if (fault === "transport") throw new TypeError("raw-service-secret");
  if (fault === "json") return { ...json(null), json: async () => { throw new SyntaxError("raw-service-secret"); } };
  if (fault === "http") return json({ error: "raw-service-secret" }, 500);
  if (fault === "error") return json({ error: "raw-service-secret" });
  if (fault === "model-json") return json({ message: { content: "raw-service-secret" } });
  if (fault === "model-key") return json({ message: { content: '{"text":"raw-service-secret"}' } });
  if (fault === "truncated") return json({ done_reason: "length", message: { content: "raw-service-secret" } });
  return json({ unexpected: "raw-service-secret" });
}
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(u)) {
    // The extension's own data files, off disk.
    try { return { ok: true, status: 200, text: async () => readFileSync(join(ROOT, u.slice(EXT.length)), "utf8") }; }
    catch { return { ok: false, status: 404, text: async () => "" }; }
  }
  if (fake.down || u.startsWith(fake.downUrl || "not-a-url")) throw new TypeError("Failed to fetch");
  const path = new URL(u).pathname;
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (path === "/api/version") { fake.versionCalls++; return fake.versionFault ? faultResponse(fake.versionFault) : json({ version: fake.version }); }
  if (path === "/api/tags") {
    fake.tagsCalls++;
    if (fake.inventory) return { ok: !fake.inventory.httpFailure, status: fake.inventory.httpFailure ? 500 : 200,
      json: async () => JSON.parse(fake.inventory.body) };
    return fake.tagsFault ? faultResponse(fake.tagsFault) : json({ models: fake.installed ? [{ name: PIN.tag, model: PIN.tag, digest: fake.digest }] : [] });
  }
  if (path === "/api/ps") {
    if (fake.psStatus !== 200) return json({ error: "boom" }, fake.psStatus);
    if (fake.psBody) return json(fake.psBody);
    return json({ models: fake.loaded ? [{ name: PIN.tag, model: PIN.tag,
      size: 2000000000, size_vram: fake.gpu ? 2000000000 : 0 }] : [] });
  }
  if (path === "/api/generate") {
    fake.unloadCalls++;
    if (fake.unloadStatus !== 200) return json({ error: "boom" }, fake.unloadStatus);
    if (body.keep_alive === 0 && fake.unloadWorks) fake.loaded = false;
    return json({ done: true });
  }
  if (path === "/api/show") { fake.showCalls++; return json({ template: fake.template, parameters: fake.parameters }); }
  if (path === "/api/chat") {
    if (!body.messages.length) {
      if (fake.warmupFault) return faultResponse(fake.warmupFault);
      fake.loaded = true;
      fake.loads.push({ numThread: body.options.num_thread ?? null });
      return json({ done: true, done_reason: "load", ...(fake.loadDuration ? { load_duration: 1.2e9 } : {}), message: { content: "" } });
    }
    fake.loaded = true;
    const text = body.messages[body.messages.length - 1].content;
    const fx = byText.get(text);
    fake.chats.push({ id: fx ? fx.id : null, numThread: body.options.num_thread ?? null });
    if (fake.chatFault) return faultResponse(fake.chatFault);
    const nth = fx ? (fake.sent[fx.id] = (fake.sent[fx.id] || 0) + 1) : 0;
    const s = (fx && (fake.script[`${fx.id}#${nth}`] || fake.script[fx.id])) || {};
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    const td = fake.threadDelay[body.options.num_thread ?? "default"];
    if (td) await new Promise((r) => setTimeout(r, td));
    const answer = s.answer ?? (fx ? (fx.fixed ?? fx.text) : text);
    return json({ message: { content: JSON.stringify({ rewritten: answer }) }, done_reason: "stop",
      total_duration: 2e8, load_duration: 0, prompt_eval_count: 300, eval_count: 20 });
  }
  return json({ error: "unknown" }, 404);
}

// --- Messaging ---------------------------------------------------------------------
const SETUP = { id: "setuptestid", url: EXT + "welcome.html", tab: { id: 7, url: EXT + "welcome.html" } };
const POPUP = { id: "setuptestid", url: EXT + "popup.html" };
const PAGE = { id: "setuptestid", tab: { url: "https://x.com/a" }, url: "https://x.com/a", frameId: 0 };
function send(msg, sender = SETUP) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no response to ${msg.type}`)), 60000);
    let handled = false;
    for (const h of listeners) if (h(msg, sender, (r) => { clearTimeout(t); resolve(r); }) === true) handled = true;
    if (!handled) { /* synchronous responders already resolved */ }
  });
}
async function runCheck() {
  const b = await send({ type: "SETUP_BEGIN" });
  if (!b || !b.ok) return { begin: b };
  const labels = [];
  for (let i = 0; i < 200; i++) {
    const r = await send({ type: "SETUP_STEP", runId: b.runId });
    if (!r.ok) return { error: r.error, labels };
    if (r.label) labels.push(r.label);
    if (r.done) return { result: r.result, labels, sawWait: labels.some((l) => /idle/.test(l)) };
  }
  return { error: "no-end" };
}
function freshStore() {
  store = { settingsVersion: W("SETTINGS_VERSION"), ollamaUrl: "http://localhost:11434" };
  W("forgetModelDigests(); versionCache = null; lastOllamaContact = 'unknown'; lastEngineState = 'unknown'; setupRuns.clear()");
  fastPoll = false;
  rejectRunningWrite = false;
  clockOffset = 0;
}
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

console.log("\nThe speed check, through the setup messages\n" + "=".repeat(72));

// [1]
{
  freshStore(); resetFake();
  const r = await runCheck();
  const q = store[KEY];
  ok(r.result && r.result.pass === true && r.result.category === "pass", `[1] a GPU run passes (got ${JSON.stringify(r.result || r)})`);
  ok(q && q.pass && q.backend.kind === "gpu" && q.options.num_thread === null && q.calibration.length === 0,
    "[1] ...stored as passing, on a GPU, with no thread count and no calibration");
  ok(q && q.cases.length === CASES && CASES === FIXTURES.length + 1 && q.cases.every((c) => c.outcome === "matched"),
    `[1] ...every fixture ran and matched, and one again after the long one (${q && q.cases.length} cases)`);
  const afterLong = q && q.cases[q.cases.length - 1];
  const longCase = q && q.cases[q.cases.length - 2];
  ok(longCase && longCase.long === true && longCase.id === "notes-8" && q.cases.filter((c) => c.long).length === 1
    && afterLong.id === `${W("SETUP_AFTER_LONG")}:after-long` && afterLong.phase === "warm" && afterLong.long === false,
    `[1] ...the long-context case is the last fixture, flagged, and an ordinary sentence follows it (${longCase && longCase.id}, ${afterLong && afterLong.id})`);
  ok(q && q.numbers.longDropped === 0 && typeof q.numbers.longMs === "number",
    "[1] ...and its time is recorded on its own, not dropped");
  ok(q && q.ollamaVersion === "0.32.12" && q.promptRevision === W("PROMPT_REVISION")
    && q.benchmarkRevision === W("SETUP_BENCHMARK_REVISION") && q.digest === PIN.digest,
    "[1] ...bound to the Ollama version, the prompt, the check and the engine");
  ok(r.sawWait, "[1] ...with the idle pause in it, handed to the page as a wait");
  // Cold measured cold: the engine was unloaded before each burst's load.
  ok(fake.loads.length >= 3, `[1] ...loaded for the probe and each burst (${fake.loads.length} loads)`);
  ok(q && q.numbers.loads.length === 2 && q.numbers.loads.every((l) => l.loadMs === 1200 && typeof l.wallMs === "number"),
    `[1] ...and each burst's load is recorded, with Ollama's own duration when it reports one (${JSON.stringify(q && q.numbers.loads)})`);
  const st = await send({ type: "SETUP_STATUS" });
  ok(st.ok && st.qualified === true, "[1] SETUP_STATUS says qualified");
  const on = await send({ type: "SET_SENTENCE_MODE", on: true }, SETUP);
  ok(on.ok && on.settings.sentenceMode === true, "[1] ...and Turn on is accepted from the setup page");
  const consent = await send({ type: "SENTENCE_CONSENT" }, PAGE);
  ok(consent.allowed === true, "[1] ...so a page is allowed");
  const rep = await send({ type: "SETUP_REPORT" });
  const repText = JSON.stringify(rep.report);
  ok(rep.ok && rep.report.result.pass === true && rep.report.result.cases.length === CASES
    && rep.report.result.cases.filter((c) => c.long).length === 1 && rep.report.result.bounds.longContext === "may-drop",
    "[1] the report carries the result and every case");
  ok(!FIXTURES.some((f) => repText.includes(f.text) || (f.fixed && repText.includes(f.fixed))) && !repText.includes("localhost"),
    "[1] ...and no sentence, no answer and no address");
}

// [2]
{
  // A change the guards accept -- a comma -- on a sentence expected to come
  // back untouched. (A change the guards REFUSE leaves the field unchanged,
  // which is what a clean fixture expects, so it would not fail the machine.)
  freshStore(); resetFake({ script: { "chat-3": { answer: "We could leave around eight, and be back by lunch." } } });
  const r = await runCheck();
  ok(r.result && r.result.pass === false && r.result.category === "unexpected",
    `[2] a wrong answer fails the machine as unexpected (got ${JSON.stringify(r.result || r)})`);
  const on = await send({ type: "SET_SENTENCE_MODE", on: true });
  ok(on.ok === false && /speed check/.test(on.error), `[2] ...and Turn on is refused, saying why (${on.error})`);
  ok((await send({ type: "SENTENCE_CONSENT" }, PAGE)).allowed === false, "[2] ...and no page is allowed");
}

// [3]
{
  freshStore(); resetFake({ script: { "email-5": { delayMs: 5000 } } });
  const r = await runCheck();
  const c = store[KEY] && store[KEY].cases.find((x) => x.id === "email-5");
  ok(r.result && r.result.category === "too-slow" && c && c.outcome === "expired",
    `[3] one case past the deadline fails it as too-slow (got ${JSON.stringify(r.result || r)}, ${c && c.outcome})`);
}

// [3b] The long-context case (owner, 2026-09-25: "as long as it's a clean
// drop that should be fine").
{
  // Dropped: the deadline passes on the long case alone. A pass, with the drop
  // recorded and handed to the ready screen, and the bounds untouched by it.
  freshStore(); resetFake({ script: { "notes-8": { delayMs: 5000 } } });
  let r = await runCheck();
  let q = store[KEY];
  const long = q && q.cases.find((c) => c.long);
  ok(r.result && r.result.pass === true && long.outcome === "expired" && q.numbers.longDropped === 1
    && q.numbers.longMs >= 4700 && q.numbers.warmMax < 4500 && q.numbers.warmP95 < 3500,
    `[3b] the long case dropped at the deadline: a pass, recorded as a drop (${JSON.stringify(r.result || r)}, ${JSON.stringify(q && q.numbers)})`);
  const st = await send({ type: "SETUP_STATUS" });
  ok(st.qualified === true && st.lastResult.longDropped === 1, `[3b] ...and SETUP_STATUS tells the ready screen (${JSON.stringify(st.lastResult)})`);
  // Slow but delivered (4.6 s, inside the 4.75 s deadline): no worse than a
  // drop, so no more a failure.
  freshStore(); resetFake({ script: { "notes-8": { delayMs: 4600 } } });
  r = await runCheck();
  q = store[KEY];
  ok(r.result && r.result.pass === true && q.cases.find((c) => c.long).outcome === "matched" && q.numbers.longDropped === 0,
    `[3b] the long case slow but delivered: a pass, not a drop (${JSON.stringify(r.result || r)})`);
  // Not clean: the sentence after the drop is slow (it waited on the engine).
  freshStore(); resetFake({ script: { "notes-8": { delayMs: 5000 }, [`${W("SETUP_AFTER_LONG")}#2`]: { delayMs: 4600 } } });
  r = await runCheck();
  q = store[KEY];
  ok(r.result && r.result.category === "too-slow" && q.cases[q.cases.length - 1].ms > 4500
    && q.cases.filter((c) => c.id === W("SETUP_AFTER_LONG")).every((c) => c.ms < 4500),
    `[3b] the sentence after the drop over 4.5 s: too-slow, the drop was not clean (${JSON.stringify(r.result || r)})`);
  // A wrong answer on the long case still fails the machine: only its TIME is
  // exempt. (A comma the guards accept, on top of the expected correction.)
  freshStore(); resetFake({ script: { "notes-8": { answer: "Please keep a copy of the signed forms, for your records." } } });
  r = await runCheck();
  ok(r.result && r.result.category === "unexpected" && store[KEY].cases.find((c) => c.long).outcome === "wrong",
    `[3b] a wrong answer on the long case: unexpected (${JSON.stringify(r.result || r)})`);
}

// [4]
{
  freshStore(); resetFake({ gpu: false });
  const r = await runCheck();
  const q = store[KEY];
  const candidates = W("threadCandidates(8)");
  ok(r.result && r.result.pass === true && q.backend.kind === "cpu", `[4] a CPU run passes (got ${JSON.stringify(r.result || r)})`);
  ok(q.calibration.length === candidates.length && candidates.includes(q.options.num_thread),
    `[4] ...after trying ${JSON.stringify(candidates)} threads, choosing ${q.options.num_thread}`);
  const qualifyingChats = fake.chats.slice(-CASES);
  ok(qualifyingChats.every((c) => c.numThread === q.options.num_thread),
    "[4] ...and the whole qualifying run used the chosen count");
  store.sentenceMode = true;
  fake.chats = [];
  const res = await send({ type: "SENTENCE_REWRITE", requestId: "sn_cpu1", sentence: "We recieved the invoice yesterday.",
    priorContext: "", trigger: "next-sentence" }, PAGE);
  ok(res && fake.chats.length === 1 && fake.chats[0].numThread === q.options.num_thread,
    `[4] a sentence request carries the chosen count (${JSON.stringify(fake.chats)})`);
  const body = W("sentenceWarmupBody(requestOptionsFor({ qualification: " + JSON.stringify(q) + " }))");
  ok(body.options.num_thread === q.options.num_thread, "[4] ...and so does the warmup body");
  await W("logQueue");
  const rec = store["slog:sn_cpu1"];
  ok(rec && rec.backend && rec.backend.kind === "cpu" && rec.backend.numThread === q.options.num_thread,
    `[4] ...and its record names the backend class, for latency by hardware (${JSON.stringify(rec && rec.backend)})`);
}
// [4b] Apple silicon holds the whole model in unified memory: its own class.
{
  freshStore(); resetFake();
  ctx.navigator.userAgentData = { platform: "macOS" };
  await runCheck();
  delete ctx.navigator.userAgentData;
  ok(store[KEY] && store[KEY].backend.kind === "apple" && store[KEY].options.num_thread === null,
    `[4b] a GPU run on macOS is named apple, with no thread count (${JSON.stringify(store[KEY] && store[KEY].backend)})`);
}

// A run that failed is stored as that failure, and is what everything reads.
const failedAs = (reason) => {
  const q = store[KEY];
  return !!q && q.pass === false && q.category === "operational" && q.reason === reason && typeof q.runId === "string";
};

// [5]
{
  freshStore(); resetFake({ installed: false });
  const r = await runCheck();
  ok(r.error === "engine-missing" && failedAs("engine-missing"),
    `[5] no engine: the run stops, and the failure is stored with its reason (${r.error}, ${JSON.stringify(store[KEY] && store[KEY].reason)})`);
  const rep = await send({ type: "SETUP_REPORT" });
  ok(rep.ok && rep.report.result && rep.report.result.category === "operational" && rep.report.result.reason === "engine-missing",
    "[5] ...and the report describes that attempt");
}
// [5b] A failed RETEST replaces the pass before it: while it runs the old pass
// is not authoritative, and afterwards neither the status nor the report is
// the old pass (checkpoint 3 removed the engine after a pass and re-ran).
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  ok((await send({ type: "SETUP_STATUS" })).qualified === true, "[5b] a pass first");
  const b = await send({ type: "SETUP_BEGIN" });
  ok((await send({ type: "SENTENCE_CONSENT" }, PAGE)).allowed === false,
    "[5b] while a retest runs, the old pass does not let a page write");
  fake.installed = false;
  W("forgetModelDigests()");
  const r = await send({ type: "SETUP_STEP", runId: b.runId });
  const st = await send({ type: "SETUP_STATUS" });
  const rep = await send({ type: "SETUP_REPORT" });
  ok(r.ok === false && st.qualified === false && st.lastResult.category === "operational"
    && rep.report.result.reason === "engine-missing" && rep.report.result.pass === false,
    `[5b] a retest that failed early: not qualified, and the report is the failure, not the old pass (${JSON.stringify(st.lastResult)})`);
}
// [5c] A run the worker lost (it was stopped mid-run): the "running" verdict
// it left reads as interrupted, never as running, and never as a pass.
{
  freshStore(); resetFake();
  const b = await send({ type: "SETUP_BEGIN" });
  await send({ type: "SETUP_STEP", runId: b.runId });
  W("setupRuns.clear()");
  const st = await send({ type: "SETUP_STATUS" });
  ok(st.qualified === false && st.lastResult && st.lastResult.category === "operational" && st.lastResult.reason === "run-lost",
    `[5c] a run the worker lost reads as interrupted (${JSON.stringify(st.lastResult)})`);
}
// [5d] Ollama updated DURING the run: the run notices (the idle step and the
// finish both ask past the cache) and no pass labelled with the old version
// is stored (checkpoint 3 stored one).
{
  freshStore(); resetFake();
  const b = await send({ type: "SETUP_BEGIN" });
  let r;
  for (let i = 0; i < 200; i++) {
    if (i === 3) fake.version = "0.40.0";
    r = await send({ type: "SETUP_STEP", runId: b.runId });
    if (!r.ok || r.done) break;
  }
  ok(r.ok === false && r.error === "ollama-updated" && failedAs("ollama-updated"),
    `[5d] an Ollama updated mid-run: the run fails, no pass is stored (${JSON.stringify(r)})`);
}
// [5e] ...and updated at the very end, after the idle step: the finish asks.
{
  freshStore(); resetFake();
  const b = await send({ type: "SETUP_BEGIN" });
  for (let i = 0; i < 200 && W(`setupRuns.get(${JSON.stringify(b.runId)}).queue[0].kind`) !== "finish"; i++) {
    await send({ type: "SETUP_STEP", runId: b.runId });
  }
  fake.version = "0.40.0";
  const r = await send({ type: "SETUP_STEP", runId: b.runId });
  ok(r.ok === false && r.error === "ollama-updated" && failedAs("ollama-updated"),
    `[5e] updated before the finish: the finish asks past the cache and stores no pass (${JSON.stringify(r)})`);
}
// [5f] Opening setup after an update: SETUP_STATUS asks past the cache, so a
// pass is not shown Ready and a failure under the old version is not shown as
// today's.
{
  freshStore(); resetFake();
  await runCheck();
  fake.version = "0.40.0";            // the cache still holds 0.32.12, fresh
  const st = await send({ type: "SETUP_STATUS" });
  ok(st.qualified === false && st.lastResult.stale === "ollama-updated",
    `[5f] setup opened after an update: not Ready, the verdict marked stale (${JSON.stringify(st.lastResult)})`);
  freshStore(); resetFake({ script: { "email-5": { delayMs: 5000 } } });
  await runCheck();                   // too-slow, under 0.32.12
  fake.version = "0.40.0";
  const st2 = await send({ type: "SETUP_STATUS" });
  ok(st2.lastResult.category === "too-slow" && st2.lastResult.current === false,
    `[5f] ...and a failure under the old version is not today's (${JSON.stringify(st2.lastResult)})`);
}

// [5g] Settings replies project lifecycle without changing the stored attempt.
// Mutant: settingsForPage uses `qualification: settings.qualification`.
// Red: all three orphaned reply categories/reasons; live controls stay running.
{
  freshStore(); resetFake();
  store.sentenceMode = true;
  store.sentenceModeDisabledSites = ["https://x.com"];
  const b = await send({ type: "SETUP_BEGIN" });
  ok(b.ok && store[KEY].category === "running", "[5g] a real run stores running");
  const before = JSON.stringify(store[KEY]);
  const messages = [
    { type: "GET_SETTINGS" },
    { type: "SET_SETTINGS", settings: { sentenceDebug: true } },
    { type: "SET_SENTENCE_MODE", on: false },
  ];
  for (const live of [true, false]) {
    if (!live) W("setupRuns.clear()");
    for (const msg of messages) {
      // Restore activation so each reply must retain the effective consent
      // for its own operation, including Turn off's changed activation.
      store.sentenceMode = true;
      const r = await send({ ...msg, tabId: 7 }, POPUP);
      ok(r.ok && r.settings.qualification.category === (live ? "running" : "operational")
        && r.settings.qualification.reason === (live ? null : "run-lost"),
        `[5g] ${msg.type}: ${live ? "live stays running" : "orphan reads operational/run-lost"}`);
      ok(r.settings.qualified === false && r.settings.migrated === true
        && r.settings.sentenceModeDisabledSites.join() === "https://x.com"
        && r.consent.activated === (msg.type !== "SET_SENTENCE_MODE") && r.consent.siteDisabled === true
        && r.consent.allowed === false && r.consent.apply === false
        && r.consent.reason === (msg.type === "SET_SENTENCE_MODE" ? "switched-off" : "qualification-required")
        && r.pinnedModel.tag === "jayafowler/proofer:v1-q4"
        && r.pinnedModel.digest === "f920607a347881f5a3482ec8a9d6ea621d9a6f7ea7c27b7372e31d8e4f54b320",
        `[5g] ${msg.type} (${live ? "live" : "orphan"}): unqualified, effective consent and pin retained`);
      ok(JSON.stringify(store[KEY]) === before,
        `[5g] ${msg.type} (${live ? "live" : "orphan"}): stored attempt unchanged`);
    }
  }
}

// [5h] An update followed by a rejected new attempt retains historical identity.
// Mutants: setupReport substitutes PINNED_MODEL.tag / PINNED_MODEL.digest /
// PROMPT_REVISION / SETUP_BENCHMARK_REVISION / OLLAMA_MIN_VERSION for the
// corresponding q field. Red: the matching retained-identity assertion below.
{
  freshStore(); resetFake();
  const historical = { v: 1, runId: "historical", pass: false, category: "too-slow", reason: null,
    date: 17, ollamaUrl: "http://localhost:11434", ollamaVersion: "0.20.0",
    tag: "historical-engine:v0", digest: "a".repeat(64), promptRevision: "sentence-v0", benchmarkRevision: "speed-v1",
    options: { num_thread: 4 }, backend: { kind: "cpu", numThread: 4 },
    numbers: { warmP95: 3700 }, calibration: [], durationMs: 12345,
    cases: [{ id: "old-case", phase: "warm", ms: 3700, outcome: "matched", answer: "same", retry: false, loadMs: 0, long: false }] };
  store[KEY] = structuredClone(historical);
  rejectRunningWrite = true;
  const b = await send({ type: "SETUP_BEGIN" });
  rejectRunningWrite = false;
  ok(b.ok === false && b.error === "setup-error" && JSON.stringify(store[KEY]) === JSON.stringify(historical),
    "[5h] rejected running-record write leaves the historical attempt intact");
  const { report: rep } = await send({ type: "SETUP_REPORT" });
  ok(rep.model?.tag === "historical-engine:v0", "[5h] retained tag labels the attempt");
  ok(rep.model?.digest === "a".repeat(64), "[5h] retained digest labels the attempt");
  ok(rep.promptRevision === "sentence-v0", "[5h] retained prompt revision labels the attempt");
  ok(rep.benchmarkRevision === "speed-v1", "[5h] retained benchmark revision labels the attempt");
  ok(rep.ollamaVersion === "0.20.0", "[5h] retained Ollama version labels the attempt");
  ok(rep.reportVersion === 2 && rep.currentBuild?.model.tag === "jayafowler/proofer:v1-q4"
    && rep.currentBuild?.model.digest === "f920607a347881f5a3482ec8a9d6ea621d9a6f7ea7c27b7372e31d8e4f54b320"
    && rep.currentBuild?.promptRevision === "sentence-v1" && rep.currentBuild?.benchmarkRevision === "speed-v2"
    && rep.extensionVersion === "0.0.0-test" && rep.engineNow.loaded === false,
    "[5h] report v2 labels current build and observations separately");
  ok(rep.result.pass === false && rep.result.category === "too-slow" && rep.result.date === 17
    && rep.result.numbers.warmP95 === 3700 && rep.result.durationMs === 12345
    && JSON.stringify(rep.result.cases) === JSON.stringify(historical.cases),
    "[5h] retained verdict and measurements survive the failed new attempt");
  store[KEY].category = "running";
  const orphan = (await send({ type: "SETUP_REPORT" })).report;
  ok(orphan.result.category === "operational" && orphan.result.reason === "run-lost"
    && orphan.model.tag === "historical-engine:v0" && orphan.model.digest === "a".repeat(64)
    && orphan.promptRevision === "sentence-v0" && orphan.benchmarkRevision === "speed-v1"
    && orphan.ollamaVersion === "0.20.0" && store[KEY].category === "running",
    "[5h] an orphan keeps its identity while only its reported lifecycle changes");
}

// [5i] Bounds belong to the stored attempt, with no invented historical values.
// Mutants: setupReport uses today's bounds instead of `q.bounds ?? null`
// (red: historical bounds + absent bounds); uses today's bounds for just the
// null fallback (red: absent bounds). setupRecord uses `warmP95Ms: SETUP_WARM_P95_MS + 1`
// (red: new running/completed records snapshot the literal bounds).
{
  freshStore(); resetFake();
  const absent = (await send({ type: "SETUP_REPORT" })).report;
  ok(absent.result === null && absent.model === null && absent.promptRevision === null
    && absent.benchmarkRevision === null && absent.ollamaVersion === null,
    "[5i] no attempt has null result and null attempt identity");
  await send({ type: "SETUP_BEGIN" });
  const bounds = { warmP95Ms: 3500, caseMaxMs: 4500, longContext: "may-drop" };
  ok(JSON.stringify(store[KEY].bounds) === JSON.stringify(bounds), "[5i] new running record snapshots literal bounds");
  await runCheck();
  ok(JSON.stringify(store[KEY].bounds) === JSON.stringify(bounds), "[5i] new completed record snapshots literal bounds");
  store[KEY].bounds = { warmP95Ms: 3100, caseMaxMs: 4100, longContext: "must-complete", historicalExtra: 123 };
  const historical = (await send({ type: "SETUP_REPORT" })).report;
  ok(JSON.stringify(historical.result.bounds) === JSON.stringify({ warmP95Ms: 3100, caseMaxMs: 4100,
    longContext: "must-complete", historicalExtra: 123 }), "[5i] historical bounds exported exactly");
  delete store[KEY].bounds;
  const legacy = (await send({ type: "SETUP_REPORT" })).report;
  ok(legacy.result.bounds === null, "[5i] absent historical bounds exported as explicit null");
  ok(!Object.hasOwn(store[KEY], "bounds") && store[KEY].pass === true,
    "[5i] reporting neither migrates nor invalidates a legacy pass");
}

// [6]
{
  freshStore(); resetFake();
  const b = await send({ type: "SETUP_BEGIN" });
  await send({ type: "SETUP_STEP", runId: b.runId });
  await send({ type: "SET_SETTINGS", settings: { ollamaUrl: "http://127.0.0.1:11435" } }, POPUP);
  const r = await send({ type: "SETUP_STEP", runId: b.runId });
  ok(r.ok === false && r.error === "config-changed" && failedAs("config-changed"),
    `[6] the URL changed mid-run: the run stops, stored as that failure (${JSON.stringify(r)})`);
}

// [6b] The configuration changes during the FINISH step itself -- after the
// step's own check, while the finish asks for the version: no pass stored.
{
  freshStore(); resetFake();
  const b = await send({ type: "SETUP_BEGIN" });
  for (let i = 0; i < 200 && W(`setupRuns.get(${JSON.stringify(b.runId)}).queue[0].kind`) !== "finish"; i++) {
    await send({ type: "SETUP_STEP", runId: b.runId });
  }
  const origFetch = ctx.fetch;
  ctx.fetch = async (u, o) => {
    if (String(u).endsWith("/api/version")) { W("bumpConfigGeneration()"); ctx.fetch = origFetch; }
    return origFetch(u, o);
  };
  const r = await send({ type: "SETUP_STEP", runId: b.runId });
  ctx.fetch = origFetch;
  ok(r.ok === false && r.error === "config-changed" && failedAs("config-changed"),
    `[6b] a change during the finish: reported, no pass stored (${JSON.stringify(r)})`);
}

// [6c] The URL changes while a sentence is at the model: the job was begun
// under the old configuration, and is not delivered under the new one.
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  // A fixture sentence, so the fake answers with a real correction (a
  // no-change answer writes nothing and needs no delivery check).
  const text = FIXTURES.find((f) => f.id === "email-2").text;
  const slowAnswer = new Promise((r) => setTimeout(r, 400));
  const origFetch = ctx.fetch;
  ctx.fetch = async (u, o) => { if (String(u).endsWith("/api/chat") && o && o.body && JSON.parse(o.body).messages.length) await slowAnswer; return origFetch(u, o); };
  const pending = send({ type: "SENTENCE_REWRITE", requestId: "sn_urlchange", sentence: text, priorContext: "", trigger: "next-sentence" }, PAGE);
  await new Promise((r) => setTimeout(r, 100));
  await send({ type: "SET_SETTINGS", settings: { ollamaUrl: "http://127.0.0.1:11435" } }, POPUP);
  const res = await pending;
  ctx.fetch = origFetch;
  ok(res && res.ok === false && res.error === "not-allowed",
    `[6c] a URL change during inference: the correction is not delivered (${JSON.stringify(res)})`);
}

// [6d] A new verdict is stored while a sentence is at the model (a re-run of
// the check, perhaps choosing another thread count). Consent still says yes --
// only the configuration generation separates the two -- and the job begun
// under the old one is not delivered.
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  const text = FIXTURES.find((f) => f.id === "email-2").text;
  const slowAnswer = new Promise((r) => setTimeout(r, 400));
  const origFetch = ctx.fetch;
  ctx.fetch = async (u, o) => { if (String(u).endsWith("/api/chat") && o && o.body && JSON.parse(o.body).messages.length) await slowAnswer; return origFetch(u, o); };
  const pending = send({ type: "SENTENCE_REWRITE", requestId: "sn_newverdict", sentence: text, priorContext: "", trigger: "next-sentence" }, PAGE);
  await new Promise((r) => setTimeout(r, 100));
  await W(`storeQualification({ ...${JSON.stringify(store[KEY])}, date: Date.now() })`);
  const allowed = (await send({ type: "SENTENCE_CONSENT" }, PAGE)).allowed;
  const res = await pending;
  ctx.fetch = origFetch;
  ok(allowed === true && res && res.ok === false && res.error === "not-allowed",
    `[6d] a new verdict mid-flight: consent still yes, the old job not delivered (${allowed}, ${JSON.stringify(res)})`);
}

// [6e] The same, during the FINAL consent read itself: that read is held, a
// new passing verdict with another thread count is stored, then the read is
// released. Checkpoint 3 reproduced the old job delivering here, because the
// generation was compared before the read was awaited.
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  const text = FIXTURES.find((f) => f.id === "email-2").text;
  const realGet = ctx.chrome.storage.local.get;
  let answered = false;
  let heldCb = null;
  const origFetch = ctx.fetch;
  ctx.fetch = async (u, o) => {
    const r = await origFetch(u, o);
    if (String(u).endsWith("/api/chat") && o && o.body && JSON.parse(o.body).messages.length) answered = true;
    return r;
  };
  ctx.chrome.storage.local.get = (keys, cb) => {
    if (answered && !heldCb) { heldCb = () => realGet(keys, cb); return; }
    realGet(keys, cb);
  };
  const pending = send({ type: "SENTENCE_REWRITE", requestId: "sn_heldread", sentence: text, priorContext: "", trigger: "next-sentence" }, PAGE);
  for (let i = 0; i < 100 && !heldCb; i++) await settle(10);
  ctx.chrome.storage.local.get = realGet;
  await W(`storeQualification({ ...${JSON.stringify(store[KEY])}, options: { num_thread: 6 }, date: Date.now() })`);
  heldCb && heldCb();
  const res = await pending;
  ctx.fetch = origFetch;
  ok(heldCb && res && res.ok === false && res.error === "not-allowed",
    `[6e] a new verdict stored during the final consent read: not delivered (${!!heldCb}, ${JSON.stringify(res)})`);
}

// [6f] Setup's check of the download finds another engine while a sentence is
// at the model: the one invalidation path voids the verdict and cancels the
// work in flight (checkpoint 3 had the correction delivered, and the check
// still current).
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  const text = FIXTURES.find((f) => f.id === "email-2").text;
  const slowAnswer = new Promise((r) => setTimeout(r, 300));
  const origFetch = ctx.fetch;
  ctx.fetch = async (u, o) => { if (String(u).endsWith("/api/chat") && o && o.body && JSON.parse(o.body).messages.length) await slowAnswer; return origFetch(u, o); };
  const pending = send({ type: "SENTENCE_REWRITE", requestId: "sn_verifymid", sentence: text, priorContext: "", trigger: "next-sentence" }, PAGE);
  await settle(80);
  fake.digest = "f".repeat(64);
  W("forgetModelDigests()");
  const v = await send({ type: "SETUP_VERIFY" });
  const res = await pending;
  ctx.fetch = origFetch;
  const st = await send({ type: "SETUP_STATUS" });
  ok(v.verified === false && res && res.ok === false && st.qualified === false && store[KEY].stale === "engine-mismatch",
    `[6f] a mismatch found by setup: the correction in flight is not delivered, the verdict is void (${JSON.stringify(res)}, ${st.qualified})`);
}

// [6g] A warmup checks the digest as a sentence does: another engine under the
// pinned tag is never loaded, and the verdict is voided the same way.
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  fake.digest = "f".repeat(64);
  W("forgetModelDigests(); forgetOllamaRunner()");
  const loadsBefore = fake.loads.length;
  await send({ type: "SENTENCE_WARMUP" }, PAGE);
  for (let i = 0; i < 50 && !(store[KEY] && store[KEY].stale); i++) await settle(10);
  await settle(50);
  ok(fake.loads.length === loadsBefore && store[KEY].stale === "engine-mismatch",
    `[6g] a warmup finds another digest: nothing loaded, the verdict void (${fake.loads.length - loadsBefore} loads, ${store[KEY].stale})`);
}

// [7]
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  W("versionCache = null");
  fake.version = "0.40.0";
  fake.chats = [];
  const res = await send({ type: "SENTENCE_REWRITE", requestId: "sn_fresh", sentence: "We recieved the invoice yesterday.",
    priorContext: "", trigger: "next-sentence" }, PAGE);
  ok(res && res.ok === false && res.error === "not-allowed" && fake.chats.length === 0,
    `[7] an Ollama update stops the next sentence before it is sent (${JSON.stringify(res)})`);
  ok(store[KEY].stale === "ollama-updated", "[7] ...and marks the verdict stale");
  ok((await send({ type: "SENTENCE_CONSENT" }, PAGE)).allowed === false, "[7] ...so consent is refused until the check runs again");
  await new Promise((r) => setTimeout(r, 20));
  ok(badge.text === "!" && /updated/.test(badge.title), `[7] ...and the badge says so (${JSON.stringify(badge)})`);
  const st = await send({ type: "SETUP_STATUS" });
  ok(st.lastResult && st.lastResult.stale === "ollama-updated", "[7] SETUP_STATUS reports the stale verdict");
  // Ollama gone altogether: the badge says to start it.
  fake.down = true;
  W("versionCache = null");
  await send({ type: "SENTENCE_REWRITE", requestId: "sn_down", sentence: "We recieved the invoice yesterday.",
    priorContext: "", trigger: "next-sentence" }, PAGE);
  await new Promise((r) => setTimeout(r, 20));
  ok(badge.text === "!", "[7] Ollama not answering keeps the badge up");
  fake.down = false;
}

// [7b] Early status: the first focus of an editable asks for consent, and
// that is where an Ollama update is noticed -- before the first sentence.
{
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  fake.version = "0.41.0";
  W("versionCache = null");
  badge = { text: "", title: "" };
  const c = await send({ type: "SENTENCE_CONSENT" }, PAGE);
  await new Promise((r) => setTimeout(r, 50));
  ok(c.allowed === true && store[KEY].stale === "ollama-updated" && badge.text === "!",
    `[7b] a consent ask finds the Ollama update: the verdict goes stale and the badge says so (${store[KEY].stale}, ${badge.text})`);
}

// [8]
{
  freshStore(); resetFake();
  for (const [label, sender] of [["the popup", POPUP], ["a web page", PAGE],
    ["a page URL named welcome.html", { id: "setuptestid", url: "https://evil.example/welcome.html" }]]) {
    const r = await send({ type: "SETUP_BEGIN" }, sender);
    ok(r && r.ok === false && r.error === "not-allowed", `[8] SETUP_BEGIN from ${label} is refused`);
  }
  const q = await send({ type: "SETUP_STATUS" }, { ...SETUP, url: EXT + "welcome.html?from=popup" });
  ok(q && q.ok === true, "[8] ...while the setup page with a query string is accepted");
}

// [9]
{
  freshStore(); resetFake();
  ok((await send({ type: "SETUP_VERIFY" })).verified === true, "[9] the pinned engine verifies");
  resetFake({ digest: "f".repeat(64) });
  W("forgetModelDigests()");
  let v = await send({ type: "SETUP_VERIFY" });
  ok(v.verified === false && v.reason === "digest", `[9] another digest under the tag fails (${JSON.stringify(v)})`);
  resetFake({ template: "something else" });
  W("forgetModelDigests()");
  v = await send({ type: "SETUP_VERIFY" });
  ok(v.verified === false && v.reason === "template", `[9] a different template fails (${JSON.stringify(v)})`);
  resetFake({ parameters: "temperature 0.7\ntop_k 20\ntop_p 0.8\nnum_ctx 2048\nrepeat_penalty 1" });
  W("forgetModelDigests()");
  v = await send({ type: "SETUP_VERIFY" });
  ok(v.verified === false && v.reason === "parameters", `[9] different parameters fail (${JSON.stringify(v)})`);
}

// [10] Ollama 0.32.12 reports no load_duration for a load-only request
// (measured on a cold CPU runner): the load is recorded as unknown, not 0 ms.
{
  freshStore(); resetFake({ loadDuration: false });
  await runCheck();
  const loads = store[KEY] && store[KEY].numbers.loads;
  ok(loads && loads.length === 2 && loads.every((l) => l.loadMs === null && typeof l.wallMs === "number"),
    `[10] a load Ollama does not time is recorded as unknown, with its wall time (${JSON.stringify(loads)})`);
}

// [10] The bounds at their edges, and the instruments they depend on.
{
  // Warm p95 over 3.5 s with every case under 4.5 s. 22 warm cases: the p95
  // is the 21st, so ONE slow case is an outlier the percentile ignores and
  // TWO are the p95.
  const two = ["email-3", "chat-3"];
  freshStore(); resetFake({ script: { [two[0]]: { delayMs: 3800 } } });
  let r = await runCheck();
  ok(r.result && r.result.pass === true, `[10] one warm case at 3.8 s: still a pass (${JSON.stringify(r.result || r)})`);
  freshStore(); resetFake({ script: { [two[0]]: { delayMs: 3800 }, [two[1]]: { delayMs: 3800 } } });
  r = await runCheck();
  const q = store[KEY];
  ok(r.result && r.result.category === "too-slow" && q.numbers.warmP95 > 3500
    && q.cases.every((c) => c.ms < 4500 && c.outcome === "matched"),
    `[10] two at 3.8 s: warm p95 ${q && q.numbers.warmP95} ms fails it, though every case is under 4.5 s (${JSON.stringify(r.result || r)})`);
}
{
  // Calibration picks the FASTEST count, not the first tried: the first
  // candidate for 8 cores (4 threads) is made the slow one.
  freshStore(); resetFake({ gpu: false, threadDelay: { 4: 250, 8: 0 } });
  const cands = W("threadCandidates(8)");
  const r = await runCheck();
  const q = store[KEY];
  ok(cands[0] === 4 && r.result && q.options.num_thread === 8
    && q.calibration.find((c) => c.numThread === 4).medianMs > q.calibration.find((c) => c.numThread === 8).medianMs,
    `[10] calibration chooses the fastest count (tried ${JSON.stringify(cands)}, chose ${q && q.options.num_thread})`);
}
{
  // "Could not tell" is never "cold": /api/ps failing, a body with no model
  // list, an unload refused, and an engine that will not unload all stop the
  // run as ollama-status -- none of them measures a warm engine as cold.
  for (const [label, over] of [["/api/ps answering HTTP 500", { psStatus: 500 }],
    ["/api/ps answering without a model list", { psBody: { error: "x" } }],
    ["the unload refused", { unloadStatus: 500 }],
    ["an engine that stays loaded after the unload", { unloadWorks: false, loaded: true }]]) {
    freshStore(); resetFake(over);
    fastPoll = true;
    const r = await runCheck();
    ok(r.error === "ollama-status" && failedAs("ollama-status"),
      `[10] ${label}: the run stops as ollama-status (${JSON.stringify(r.result || r.error)})`);
  }
  // The unload itself, asked directly -- in the run, the probe's own "must be
  // listed after loading" check would also stop a machine whose /api/ps
  // lies, so these are what separate the two halves of "verified cold".
  const unload = () => W(`unloadEngine("http://localhost:11434")`).then((v) => ({ value: v }), (e) => ({ reason: e.reason }));
  freshStore(); resetFake({ psStatus: 500, loaded: true, unloadWorks: false });
  fastPoll = true;
  let u = await unload();
  ok(u.reason === "ollama-status", `[10] an engine still loaded behind an /api/ps error is not "unloaded" (${JSON.stringify(u)})`);
  freshStore(); resetFake({ unloadStatus: 500, loaded: true, unloadWorks: false });
  fastPoll = true;
  u = await unload();
  ok(u.reason === "ollama-status", `[10] an unload Ollama refused is a failure at once, not a wait (${JSON.stringify(u)})`);
}
{
  // The version cache: used within its 30 s, asked again past them. A
  // sentence 31 s after the last ask finds the update; one inside it cannot.
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  const ask = (id) => send({ type: "SENTENCE_REWRITE", requestId: id, sentence: "We recieved the invoice yesterday.",
    priorContext: "", trigger: "next-sentence" }, PAGE);
  await ask("sn_cache0");
  const calls = fake.versionCalls;
  fake.version = "0.40.0";
  clockOffset = 20000;
  W("forgetModelDigests()");
  const inside = await ask("sn_cache1");
  ok(fake.versionCalls === calls && inside.ok === true && !store[KEY].stale,
    `[10] inside the 30 s the cached version is used (${fake.versionCalls - calls} asks)`);
  clockOffset = 31000;
  W("forgetModelDigests()");
  const past = await ask("sn_cache2");
  ok(fake.versionCalls === calls + 1 && past.ok === false && store[KEY].stale === "ollama-updated",
    `[10] past it, the version is asked again and the update found (${JSON.stringify(past)})`);
  // A failed request drops the cached version with the digests.
  freshStore(); resetFake();
  await runCheck();
  store.sentenceMode = true;
  await ask("sn_cache3");
  ok(W("versionCache") !== null, "[10] (the version is cached after a request)");
  fake.down = true;
  await ask("sn_cache4");
  fake.down = false;
  ok(W("versionCache") === null, "[10] ...and dropped after a failed request");
}

// G3.2 cases use only synthetic service responses and the shipping handlers.
function seedPass(version = "0.32.12") {
  store[KEY] = { v: 1, runId: "seed", pass: true, category: "pass", reason: null,
    ollamaUrl: "http://localhost:11434", ollamaVersion: version,
    tag: PIN.tag, digest: PIN.digest, promptRevision: W("PROMPT_REVISION"),
    benchmarkRevision: "speed-v2", options: { num_thread: null }, cases: [] };
}

// [7c] Mutant: checkFreshness's successful publishServiceState call becomes
// `lastOllamaContact = "ok"`. Red: recovered badge empty / title Proofer.
{
  freshStore(); resetFake(); seedPass(); store.sentenceMode = true;
  await send({ type: "SETUP_STATUS" });
  fake.down = true;
  await W("getSettings().then(s => checkFreshness(s, undefined, { fresh: true }))");
  await settle();
  ok(badge.text === "!" && badge.title === "Proofer: Proofer needs Ollama running.", "[7c] outage publishes the action warning");
  fake.down = false;
  await W("getSettings().then(s => checkFreshness(s, undefined, { fresh: true }))");
  await settle();
  ok(badge.text === "", "[7c] recovered contact clears badge before any sentence outcome");
  ok(badge.title === "Proofer", "[7c] recovered contact restores title before any sentence outcome");
}

// [7c] Cancellation is a control, not an Ollama outage. Mutant: remove the
// AbortError rethrow in ollamaVersionAt's fetch or JSON catch. Red: the matching
// cancellation keeps its identity and does not publish a service warning.
for (const phase of ["abort", "body-abort"]) {
  freshStore(); resetFake(); seedPass(); store.sentenceMode = true;
  await send({ type: "SETUP_STATUS" });
  fake.versionFault = phase;
  const error = await W("getSettings().then(s => checkFreshness(s, undefined, { fresh: true })).then(() => null, e => e.name)");
  await settle();
  ok(error === "AbortError" && badge.text === "" && badge.title === "Proofer",
    `[7c] ${phase} freshness check retains AbortError without changing the badge`);
}

// [7d] Mutant: delete publishServiceState's configured-endpoint guard.
// Red: a healthy unsaved preview cannot clear the configured outage badge.
{
  freshStore(); resetFake(); seedPass(); store.sentenceMode = true;
  await send({ type: "SETUP_STATUS" });
  fake.down = true;
  await W("getSettings().then(s => checkFreshness(s, undefined, { fresh: true }))");
  store[KEY].stale = "ollama-updated";
  fake.down = false;
  await send({ type: "SETUP_STATUS" });
  await settle();
  ok(badge.text === "!" && badge.title === "Proofer: Ollama was updated: run Proofer's speed check again.", "[7d] recovery preserves a genuinely stale qualification warning");
  seedPass();
  fake.downUrl = "http://localhost:11434";
  await send({ type: "SETUP_STATUS" });
  const before = JSON.stringify(store[KEY]);
  const preview = await send({ type: "CHECK_HEALTH", urlOverride: "http://127.0.0.1:11435" }, POPUP);
  await settle();
  ok(preview.ok && preview.engine?.state === "ok" && preview.configured === false, "[7d] unsaved preview reports its own healthy endpoint");
  ok(badge.text === "!" && badge.title === "Proofer: Proofer needs Ollama running.", "[7d] healthy preview cannot clear the configured outage badge");
  fake.version = "0.40.0"; fake.digest = "a".repeat(64);
  await send({ type: "CHECK_HEALTH", urlOverride: "http://127.0.0.1:11435" }, POPUP);
  ok(JSON.stringify(store[KEY]) === before && (await send({ type: "GET_SETTINGS" }, POPUP)).settings.qualified,
    "[7d] preview cannot stale or disqualify the configured attempt");
}

// [9b] Mutant: verifyEngine's lookup uses `{ fresh: false }`.
// Red: new tags request, repaired verification/cache, reverse mismatch refusal.
{
  freshStore(); resetFake({ digest: "a".repeat(64) });
  await W("installedModelDigest('http://localhost:11434', PINNED_MODEL.tag)");
  fake.digest = PIN.digest;
  const cached = await W("installedModelDigest('http://localhost:11434', PINNED_MODEL.tag)");
  ok(cached === "a".repeat(64) && fake.tagsCalls === 1, "[9b] ordinary lookup retains its present-tag cache inside TTL");
  const fixed = await send({ type: "SETUP_VERIFY" });
  ok(fake.tagsCalls === 2 && fixed.verified === true && fake.showCalls === 1,
    "[9b] post-pull verification reads fresh tags and checks show");
  ok(await W("installedModelDigest('http://localhost:11434', PINNED_MODEL.tag)") === PIN.digest && fake.tagsCalls === 2,
    "[9b] fresh verification replaces the shared digest cache");
  fake.digest = "b".repeat(64);
  const moved = await send({ type: "SETUP_VERIFY" });
  ok(fake.tagsCalls === 3 && moved.verified === false && moved.reason === "digest" && fake.showCalls === 1,
    "[9b] reverse pin-to-mismatch change is refused inside TTL");
  // Mutant: observeEngine passes { fresh: false }. Red: status/health detect
  // both directions inside TTL, even with a present cached tag.
  for (const [type, digest, state] of [["SETUP_STATUS", PIN.digest, "ok"], ["CHECK_HEALTH", "c".repeat(64), "mismatch"]]) {
    fake.digest = digest;
    const before = fake.tagsCalls;
    const r = await send({ type }, type === "CHECK_HEALTH" ? POPUP : SETUP);
    ok(r.engine?.state === state && fake.tagsCalls === before + 1, `[9b] ${type} refresh bypasses present-tag cache`);
  }
}

// [11a] Mutant: observeEngine's catch returns state "missing".
// Red: both handlers report unknown for HTTP, envelope, JSON and transport failures.
{
  for (const fault of ["http", "malformed", "json", "transport"]) {
    freshStore(); resetFake({ tagsFault: fault });
    for (const type of ["SETUP_STATUS", "CHECK_HEALTH"]) {
      const r = await send({ type }, type === "CHECK_HEALTH" ? POPUP : SETUP);
      ok(r.ok && r.ollama?.state === "ok" && r.engine?.state === "unknown",
        `[11a] ${type} ${fault} inventory is unknown, not missing`);
    }
  }
  freshStore(); resetFake({ installed: false });
  for (const type of ["SETUP_STATUS", "CHECK_HEALTH"]) {
    const r = await send({ type }, type === "CHECK_HEALTH" ? POPUP : SETUP);
    ok(r.ok && r.engine?.state === "missing", `[11a] ${type} successful empty inventory is missing`);
  }
}

// [11b] Mutant: remove the probe's `if (!ollama.versionOk)` refusal.
// Red: unsupported direct retests fail as ollama-version before unload/load/chat.
{
  for (const version of ["0.32.5", "v0.34.3", "0.33", "0.32.6", "0.34.3", "0.34.3-rc1"]) {
    freshStore(); resetFake({ version });
    const begin = await send({ type: "SETUP_BEGIN" });
    const r = await send({ type: "SETUP_STEP", runId: begin.runId });
    const supported = ["0.32.6", "0.34.3", "0.34.3-rc1"].includes(version);
    ok(supported ? r.ok && fake.loads.length === 1 : r.error === "ollama-version" && store[KEY].reason === "ollama-version",
      `[11b] ${version} worker floor verdict`);
    ok(supported || (fake.loads.length === 0 && fake.chats.length === 0 && fake.unloadCalls === 0
      && !(await send({ type: "GET_SETTINGS" }, POPUP)).settings.qualified), `[11b] ${version} no unsupported benchmark traffic or qualification`);
  }
  for (const kind of ["idle", "finish"]) {
    freshStore(); resetFake();
    const begin = await send({ type: "SETUP_BEGIN" });
    await send({ type: "SETUP_STEP", runId: begin.runId });
    fake.version = "0.32.5";
    W(`setupRuns.get(${JSON.stringify(begin.runId)}).queue = [{ kind: ${JSON.stringify(kind)} }]`);
    const r = await send({ type: "SETUP_STEP", runId: begin.runId });
    ok(r.error === "ollama-version" && store[KEY].pass === false, `[11b] ${kind} enforces the same worker floor`);
  }
}

// [11c] Mutant: remove qualificationIsCurrent's recorded-version floor predicate.
// Red: same-revision below-floor passes cannot qualify; supported speed-v2 holds.
{
  ok(W("SETUP_BENCHMARK_REVISION") === "speed-v2", "[11c] supported benchmark revision remains speed-v2");
  for (const version of ["0.32.5", "v0.34.3", "0.33", "0.32.6", "0.34.3"]) {
    freshStore(); resetFake({ version }); seedPass(version);
    const r = await send({ type: "GET_SETTINGS" }, POPUP);
    ok(r.settings.qualified === ["0.32.6", "0.34.3"].includes(version), `[11c] recorded ${version} floor validity controls qualification`);
  }
}

// [12a] Mutants: change each answered warmup error's reason to ollama-stopped
// (HTTP / JSON / envelope lines). Red: stored/reported status and bounded code.
{
  for (const [fault, reason, code] of [["http", "ollama-status", "warmup-http-500"],
    ["json", "ollama-status", "warmup-not-json"], ["error", "ollama-status", "warmup-error"],
    ["malformed", "ollama-status", "warmup-malformed"], ["transport", "ollama-stopped", "warmup-unreachable"]]) {
    freshStore(); resetFake({ warmupFault: fault });
    const begin = await send({ type: "SETUP_BEGIN" });
    const r = await send({ type: "SETUP_STEP", runId: begin.runId });
    const report = (await send({ type: "SETUP_REPORT" })).report;
    ok(r.error === reason && store[KEY].reason === reason && report.result.reason === reason,
      `[12a] ${fault} warmup stores and reports ${reason}`);
    ok(r.code === code && report.result.code === code && !JSON.stringify(report).includes("raw-service-secret"),
      `[12a] ${fault} warmup retains only bounded diagnostic ${code}`);
  }
}

// [12a] Mutant: remove burst's `if (w.error) throw w.error`.
// Red: a failed warmup remains operational even when the parallel case matches.
{
  freshStore(); resetFake();
  const begin = await send({ type: "SETUP_BEGIN" });
  await send({ type: "SETUP_STEP", runId: begin.runId });
  fake.warmupFault = "http";
  W(`setupRuns.get(${JSON.stringify(begin.runId)}).queue = [{ kind: "burst", fixture: "${FIXTURES[0].id}" }]`);
  const r = await send({ type: "SETUP_STEP", runId: begin.runId });
  ok(r.error === "ollama-status" && store[KEY].code === "warmup-http-500" && store[KEY].cases[0].outcome === "matched",
    "[12a] failed burst warmup stays terminal despite a matched case");
}

// [12b] Mutants (separate): map status engine errors to stopped; omit
// "ollama-status" from SETUP_OPERATIONAL; omit engineError from report cases.
// Red respectively: status classification; immediate/finish termination;
// exported controlled engineError. Raw service text must never reach the report.
{
  for (const [field, fault, code, reason] of [["chatFault", "http", "http-500", "ollama-status"],
    ["chatFault", "json", "bad-response", "ollama-status"], ["chatFault", "error", "ollama-error", "ollama-status"],
    ["chatFault", "model-json", "invalid-json", "ollama-status"], ["chatFault", "model-key", "no-rewritten-key", "ollama-status"],
    ["chatFault", "truncated", "truncated", "ollama-status"],
    ["tagsFault", "http", "model-unverified", "ollama-status"], ["chatFault", "transport", "unreachable", "ollama-stopped"]]) {
    freshStore(); resetFake();
    const begin = await send({ type: "SETUP_BEGIN" });
    await send({ type: "SETUP_STEP", runId: begin.runId });
    fake[field] = fault; W("forgetModelDigests()");
    W(`setupRuns.get(${JSON.stringify(begin.runId)}).queue = [{ kind: "case", fixture: "${FIXTURES[0].id}" }]`);
    const run = W(`setupRuns.get(${JSON.stringify(begin.runId)})`);
    const r = await send({ type: "SETUP_STEP", runId: begin.runId });
    ok(run.cases[0]?.outcome === reason, `[12b] ${code} case classification is ${reason}`);
    ok(r.ok === false && r.error === reason && store[KEY].category === "operational" && !store[KEY].pass,
      `[12b] ${code} terminates immediately as operational`);
    const report = (await send({ type: "SETUP_REPORT" })).report;
    ok(report.result.cases[0]?.engineError === code && report.result.code === code,
      `[12b] ${code} report retains controlled engineError`);
    ok(!JSON.stringify(report).includes("raw-service-secret"), `[12b] ${code} report excludes raw response text`);
    ctx.__finishRun = { ...run, generation: W("configGeneration") };
    const finish = await W("finishSetupRun(__finishRun)");
    ok(finish.failure === reason, `[12b] ${code} finish also refuses operational cases`);
  }
}

// [12b] Mutant: remove calibrate's SETUP_OPERATIONAL early return.
// Red: status failures during CPU calibration terminate with their case/code.
{
  freshStore(); resetFake({ gpu: false });
  const begin = await send({ type: "SETUP_BEGIN" });
  await send({ type: "SETUP_STEP", runId: begin.runId });
  fake.chatFault = "http";
  const r = await send({ type: "SETUP_STEP", runId: begin.runId });
  ok(r.error === "ollama-status" && store[KEY].category === "operational" && store[KEY].cases[0]?.engineError === "http-500",
    "[12b] calibration status failure terminates with its controlled case code");
}

// [12c] Mutant: probe's unknown-engine failure becomes engine-missing.
// Red: unreadable tags is status while verified absence is engine-missing.
// Mutant: SETUP_STEP's unexpected-exception fallback becomes ollama-stopped.
// Red: internal exception is setup-error, without raw exception text.
// Mutant: CHECK_HEALTH ok uses ollama.state === "ok" instead of httpOk.
// Red: answered-but-unusable JSON/envelope preserves HTTP service meaning.
{
  for (const [field, fault, reason] of [["tagsFault", "http", "ollama-status"], ["tagsFault", "json", "ollama-status"],
    ["versionFault", "http", "ollama-status"], ["versionFault", "json", "ollama-status"],
    ["versionFault", "malformed", "ollama-status"], ["versionFault", "transport", "ollama-stopped"],
    ["installed", false, "engine-missing"]]) {
    freshStore(); resetFake({ [field]: fault });
    const begin = await send({ type: "SETUP_BEGIN" });
    const r = await send({ type: "SETUP_STEP", runId: begin.runId });
    ok(r.error === reason && store[KEY].reason === reason, `[12c] ${field}/${fault} fails as ${reason}`);
    ok(fake.loads.length === 0 && fake.chats.length === 0, `[12c] ${field}/${fault} stops before benchmark requests`);
    if (field === "versionFault") {
      const health = await send({ type: "CHECK_HEALTH" }, POPUP);
      ok(health.ok === ["json", "malformed"].includes(fault)
        && health.ollama?.state === (fault === "transport" ? "unreachable" : "unusable"),
        `[12c] ${fault} health keeps HTTP service meaning separate from usable status`);
    }
  }
  freshStore(); resetFake();
  const begin = await send({ type: "SETUP_BEGIN" });
  W(`setupRuns.get(${JSON.stringify(begin.runId)}).queue = [null]`);
  const r = await send({ type: "SETUP_STEP", runId: begin.runId });
  ok(r.error === "setup-error" && store[KEY].reason === "setup-error" && r.code === null,
    "[12c] unexpected internal step exception is setup-error without raw diagnostics");
}

// Run copied shipping inputs with a closed PATH: no real Docker or curl can
// be reached, including the legacy Compose fallback. Unexpected calls fail.
function runInstallerFixture({ body = "{}", httpFailure = false, pullFailure = false, noNode = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "proofer-installer-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const name of ["setup.sh", "background.js", "docker-compose.yml"]) copyFileSync(join(ROOT, name), join(dir, name));
    for (const name of ["bash", "dirname", "sed", "seq", "cat", "grep"]) symlinkSync(`/usr/bin/${name}`, join(bin, name));
    if (!noNode) symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(join(dir, "inventory.json"), body);
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$FIXTURE_DIR/calls"
case "$*" in
  'compose version'|'compose up -d') exit 0 ;;
  "compose exec -T ollama ollama pull $FIXTURE_TAG") exit "$FIXTURE_PULL_FAILURE" ;;
  *) echo 'unexpected docker call' >&2; exit 99 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >> "$FIXTURE_DIR/calls"
case "$*" in
  '-fsS http://127.0.0.1:11434/api/version') printf '{"version":"0.34.3"}'; exit 0 ;;
  '-fsS http://127.0.0.1:11434/api/tags') cat "$FIXTURE_DIR/inventory.json"; exit "$FIXTURE_HTTP_FAILURE" ;;
  *) echo 'unexpected curl call' >&2; exit 99 ;;
esac
`, { mode: 0o755 });
    const result = spawnSync(join(bin, "bash"), [join(dir, "setup.sh")], {
      cwd: dir, encoding: "utf8", timeout: 10000,
      env: { PATH: bin, FIXTURE_DIR: dir, FIXTURE_TAG: PIN.tag,
        FIXTURE_PULL_FAILURE: pullFailure ? "1" : "0", FIXTURE_HTTP_FAILURE: httpFailure ? "22" : "0" },
    });
    if (result.error || result.signal) throw result.error || new Error(`installer killed: ${result.signal}`);
    const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "";
    if (/unexpected .* call/.test(result.stderr)) throw new Error(result.stderr);
    return { ...result, calls };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// [13a] Mutant: replace byTag.get(want) === expectedDigest with
// [...byTag.values()].includes(expectedDigest). Red: wrong-tag pin is refused.
{
  const wrong = "a".repeat(64);
  const inventory = { body: JSON.stringify({ models: [{ name: PIN.tag, digest: wrong },
    { name: "saved-copy:v1", digest: PIN.digest }] }) };
  const r = runInstallerFixture(inventory);
  ok(r.status !== 0, "[13a] installer refuses wrong-tag pin");
  freshStore(); resetFake({ inventory });
  ok(await W("installedModelDigest('http://localhost:11434', PINNED_MODEL.tag)") === wrong,
    "[13a] worker selects the pinned tag's wrong digest");
  ok(r.calls.includes(`docker compose exec -T ollama ollama pull ${PIN.tag}`)
    && r.calls.includes("curl -fsS http://127.0.0.1:11434/api/tags"),
    "[13a] copied installer pulls the source pin then reads inventory through fakes");
}

// [13b] One-line mutants in setup.sh (each run separately):
// - replace either `if (typeof m.name/model === "string")` with `if (false)`;
//   red: name/model (and corresponding prefix/alias) acceptance.
// - replace `m.digest.replace(/^sha256[:-]/, "")` with `m.digest`;
//   red: sha256 colon/hyphen acceptance.
// - replace the tags-malformed throw with `data = { models: [] }`;
//   red: missing/non-array/null inventory is indeterminate, not mismatch.
// - append `|| true` to the inventory curl substitution;
//   red: HTTP failure exit and indeterminate diagnostic.
// - replace the node command-v condition with `if false; then`;
//   red: missing Node prerequisite and no service/network start.
{
  const fixtures = [
    ["name", { models: [{ name: PIN.tag, digest: PIN.digest }] }, PIN.digest],
    ["model", { models: [{ model: PIN.tag, digest: PIN.digest }] }, PIN.digest],
    ["sha256 colon", { models: [{ name: PIN.tag, digest: `sha256:${PIN.digest}` }] }, PIN.digest],
    ["sha256 hyphen", { models: [{ model: PIN.tag, digest: `sha256-${PIN.digest}` }] }, PIN.digest],
    ["both aliases", { models: [{ name: "saved-copy:v1", model: PIN.tag, digest: PIN.digest }] }, PIN.digest],
    ["missing tag", { models: [{ name: "saved-copy:v1", digest: PIN.digest }] }, null],
    ["empty inventory", { models: [] }, null],
    ["missing array", {}, "unknown"],
    ["non-array", { models: {} }, "unknown"],
    ["null inventory", null, "unknown"],
    ["invalid JSON", "{", "unknown"],
    // A plausible success body with HTTP failure must still fail verification.
    ["HTTP failure", { models: [{ name: PIN.tag, digest: PIN.digest }] }, "unknown", true],
  ];
  for (const [label, data, expected, httpFailure = false] of fixtures) {
    const inventory = { body: typeof data === "string" ? data : JSON.stringify(data, null, 2), httpFailure };
    const r = runInstallerFixture(inventory);
    ok(expected === PIN.digest ? r.status === 0 : r.status !== 0, `[13b] ${label} installer exit matches literal expectation`);
    freshStore(); resetFake({ inventory });
    let observed;
    try { observed = await W("installedModelDigest('http://localhost:11434', PINNED_MODEL.tag)"); }
    catch { observed = "unknown"; }
    ok(observed === expected, `[13b] ${label} worker lookup matches literal expectation`);
    if (expected === "unknown") ok(r.stderr.includes("Could not verify") && !r.stderr.includes("digest is not"),
      `[13b] ${label} is indeterminate, not a positively observed mismatch`);
  }
  const r = runInstallerFixture({ noNode: true });
  ok(r.status !== 0 && r.stderr.includes("node is required."), "[13b] missing Node has actionable prerequisite failure");
  ok(!r.calls.includes("compose up") && !r.calls.includes("curl "), "[13b] missing Node stops before services or network");
}

// [13c] Mutant: replace the connectivity/retry sentence with the old
// "build it locally instead" sentence. Red: actionable recovery and no local
// build/publication-record recommendation (pull still exits nonzero).
{
  const r = runInstallerFixture({ pullFailure: true });
  ok(r.status !== 0 && !r.calls.includes("/api/tags"), "[13c] failed pull stops before verification");
  ok(r.stderr.includes("Check connectivity and retry ./setup.sh"), "[13c] pull failure gives connectivity and retry guidance");
  ok(r.stderr.includes("A local build is not an accepted substitute for this build's pin."),
    "[13c] pull failure explains the pin's local-build restriction");
  ok(!r.stderr.includes("build it locally instead") && !r.stderr.includes("docs/maintainers/publish-model.md"),
    "[13c] pull failure never recommends a local build or publication record");
}

console.log("\n" + "=".repeat(72));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
