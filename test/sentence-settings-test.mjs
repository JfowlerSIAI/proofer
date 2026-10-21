#!/usr/bin/env node
// Sentence-mode settings and consent. No Ollama, no browser.
//
//   node sentence-settings-test.mjs
//
// These decide whether the feature is allowed to write to somebody's text at
// all, and until now nothing tested them -- a browser pass over the popup found
// eight defects here, including a Save from a stale popup silently restoring a
// grant the user had revoked.
//
// background.js is a plain script, so it runs in a vm with an in-memory
// storage stub and its top-level functions are read straight out. This tests
// what ships.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "background.js"), "utf8");

const noop = () => {};
let store = {};
let tabs = new Map();
// >0 defers every storage callback by that many ms, so two read-modify-write
// handlers can genuinely interleave -- the synchronous stub serializes them by
// accident, which is exactly the concurrency bug it could never reproduce.
let storageDelay = 0;
const defer = (fn) => { if (storageDelay > 0) setTimeout(fn, storageDelay); else fn(); };
// Failure injection for the migration's persistence boundaries. `failSets`
// rejects the next N storage.set calls the way Chrome does -- the callback runs
// with chrome.runtime.lastError set and NOTHING is written (a set is atomic).
// `failRemoves` makes the next N storage.remove calls throw, which is how a
// worker killed between the stamp and the cleanup looks to the next run.
let failSets = 0;
let failRemoves = 0;
// Per-write, in order, for the log's multi-write paths: `true` rejects that
// storage.set, `false` lets it through. Consumed before `failSets`.
let failPattern = [];
const installed = [];
const messageHandlers = [];
let fetchImpl = () => Promise.reject(new Error("no fetch scripted"));
// Serves the extension's own data/ directory off disk, so a handler that
// reaches ensureDictionary loads the SHIPPING word list and confusables through
// the shipping loader rather than failing and falling back to string
// heuristics. Everything else here scripts /api/chat.
const diskFetch = async (url) => {
  try { return { ok: true, status: 200, text: async () => readFileSync(String(url), "utf8") }; }
  catch { return { ok: false, status: 404, text: async () => "not found" }; }
};
// Answer one Ollama /api/chat call with `content`, the way the model would.
// Non-chat URLs fall through to disk: a scripted fetch that answers EVERY url
// with a model reply hands the dictionary loader a chat response, which it
// correctly refuses -- so the guards then run without a dictionary and the
// suite measures a configuration the extension cannot reach.
const scriptOllama = (content) => {
  fetchImpl = (url) => {
    if (!String(url).includes("/api/chat")) return diskFetch(url);
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ message: { content }, done_reason: "stop" }),
      text: async () => JSON.stringify({ message: { content } }),
    });
  };
};
const ollamaVersionAnswer = () => Promise.resolve({ ok: true, status: 200,
  json: async () => ({ version: "0.32.12" }), text: async () => '{"version":"0.32.12"}' });
const pinnedTags = () => {
  const pin = ctx.__cfg.PINNED_MODEL;
  const body = { models: [{ name: pin.tag, model: pin.tag, digest: pin.digest }] };
  return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
};
let warmSignals = [];
let warmNow = null;
class TestDate extends Date {
  static now() { return warmNow === null ? Date.now() : warmNow; }
}
// An in-memory declarativeNetRequest, so the Origin rule's shape and its
// reconciliation are checked here, offline; test/origin-rule-probe.mjs is the
// live half (a stock Ollama and a real browser).
let dnrRules = [];
let dnrUpdates = 0;
// When set, each update waits on the promise this returns before it applies:
// the out-of-order case holds one URL's update while another's completes.
let dnrHold = null;
// When true, an update is accepted and silently not applied.
let dnrDrop = false;
const ctx = vm.createContext({
  chrome: {
    declarativeNetRequest: {
      getDynamicRules: async () => JSON.parse(JSON.stringify(dnrRules)),
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        dnrUpdates++;
        if (dnrHold) await dnrHold(addRules);
        if (dnrDrop) return;
        dnrRules = dnrRules.filter((r) => !removeRuleIds.includes(r.id)).concat(JSON.parse(JSON.stringify(addRules)));
      },
    },
    runtime: {
      id: "proofertestid",
      getURL: (p) => new URL("../" + p, import.meta.url).pathname,
      getManifest: () => ({ version: "0.0.0-test" }),
      lastError: undefined,
      // Captured, not dropped: the log-stats and recent-changes sections drive
      // the SHIPPING message handler rather than a reimplementation of what it
      // computes. It was a noop before nothing needed it.
      onMessage: { addListener: (fn) => messageHandlers.push(fn) },
      onInstalled: { addListener: (fn) => installed.push(fn) },
    },
    storage: {
      local: {
        get: (keys, cb) => defer(() => {
          const out = {};
          if (keys === null) Object.assign(out, store);
          else if (keys && typeof keys === "object" && !Array.isArray(keys)) {
            for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
          } else for (const k of (Array.isArray(keys) ? keys : [keys])) out[k] = store[k];
          cb(out);
        }),
        set: (obj, cb) => defer(() => {
          const patterned = failPattern.length ? failPattern.shift() : null;
          if (patterned === true || (patterned === null && failSets > 0)) {
            if (patterned === null) failSets--;
            ctx.chrome.runtime.lastError = { message: "QUOTA_BYTES quota exceeded" };
            try { cb && cb(); } finally { ctx.chrome.runtime.lastError = undefined; }
            return;
          }
          Object.assign(store, obj); cb && cb();
        }),
        remove: (keys, cb) => {
          if (failRemoves > 0) { failRemoves--; throw new Error("worker stopped"); }
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
          cb && cb();
        },
      },
    },
    tabs: { create: noop, get: async (id) => {
      if (!tabs.has(id)) throw new Error("No tab with id");
      return tabs.get(id);
    } },
  },
  console, setTimeout, clearTimeout, AbortController, AbortSignal, URL, Date: TestDate,
  // The confusables loader takes a SHA-256 of the payload, so without these it
  // fails closed and the guards run with the hand-picked pairs only -- a
  // configuration that ships nowhere.
  crypto: globalThis.crypto, TextEncoder,
  // Scriptable, so a handler can be driven end to end against a model reply.
  // The real `fetch` was in here and nothing used it. /api/tags answers as the
  // pinned engine installed: the engine refuses a sentence whose model it
  // cannot verify (checkpoint 1 re-check), and these cases are about what
  // happens after that check.
  // /api/version answers the version the seeded speed-check verdict names
  // (QUAL), so the freshness check before a sentence or warmup is satisfied
  // and the cases see only the request they script.
  fetch: (...a) => String(a[0]).includes("/api/tags") ? pinnedTags()
    : String(a[0]).includes("/api/version") ? ollamaVersionAnswer() : fetchImpl(...a),
});
vm.runInContext(src + `
;globalThis.__cfg = { SENTENCE_OUTCOMES, VERDICTS, sentenceOutcomeDefinition, getSettings, setSettings, setSentenceMode, sanitizeSettingsUpdate,
  PROMPT_REVISION, SETUP_BENCHMARK_REVISION, QUALIFICATION_KEY, qualificationIsCurrent,
  requestOptionsFor, threadCandidates, SETUP_FIXTURES, SETTINGS_NOT_QUALIFIED,
  getConfigGeneration: () => configGeneration,
  PAGE_ONLY_MESSAGES: [...PAGE_ONLY_MESSAGES], SETTINGS_UPGRADING, SETTINGS_CONSENT_ELSEWHERE,
  sentenceModeState, normalizeOriginList, applySiteToggle, topLevelOriginOf,
  DEFAULT_SETTINGS, migrateSettings, SETTINGS_VERSION, LEGACY_SETTINGS_KEYS, PINNED_MODEL,
  sentenceWarmupBody, sentenceWarmupDecision, noteOllamaRequest,
  prepareSentenceRequest,
  SENTENCE_NUM_CTX, SENTENCE_WARM_STALE_MS,
  SENTENCE_KEEP_ALIVE, SENTENCE_KEEP_ALIVE_MS };`, ctx);
const S = ctx.__cfg;

// A current, passing speed check for the default URL: what "a switched-on
// install" means since beta step 3d. Consent, Turn on, requests and warmups all
// require one.
const QUAL = (over = {}) => ({
  v: 1, pass: true, category: "pass", ollamaUrl: "http://localhost:11434", ollamaVersion: "0.32.12",
  tag: S.PINNED_MODEL.tag, digest: S.PINNED_MODEL.digest, promptRevision: S.PROMPT_REVISION,
  benchmarkRevision: S.SETUP_BENCHMARK_REVISION, options: { num_thread: null }, ...over,
});

let pass = 0;
const failures = [];
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  failures.push(label);
  console.log(`  FAIL  ${label}\n          got      ${JSON.stringify(actual)}\n          expected ${JSON.stringify(expected)}`);
}
const reset = () => { store = {}; };
const DAY = 86400000;

// Who sent a message. The popup is the default: every message a test sends
// without naming a sender is one only the popup sends, and the worker refuses
// those from anything but this extension's own pages. A content script's
// sender carries the PAGE's URL.
const POPUP = { id: "proofertestid", url: ctx.chrome.runtime.getURL("popup.html") };
const CONTENT = { id: "proofertestid", tab: { url: "https://x.com/a" }, url: "https://x.com/a", frameId: 0 };
// The setup page: an extension page in a tab. Only it may send SETUP_*.
const SETUP = { id: "proofertestid", tab: { url: "chrome-extension://proofertestid/welcome.html" },
  url: ctx.chrome.runtime.getURL("welcome.html") };

// Drive the shipping onMessage handler and resolve what it sends back. The
// handlers return true to keep the port open for an async reply, which is what
// every path used here does.
function send(msg, sender = POPUP) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no response to ${msg.type}`)), 5000);
    let answered = false;
    const respond = (r) => { if (answered) return; answered = true; clearTimeout(t); resolve(r); };
    let handled = false;
    for (const h of messageHandlers) if (h(msg, sender, respond) === true) handled = true;
    if (!handled && !answered) { clearTimeout(t); resolve(undefined); }
  });
}

// Seed the sentence ring the way writeLogRecord does: one storage key per
// record under the ring's prefix, plus an index naming them in order.
function seedSentenceRing(records) {
  const ids = [];
  records.forEach((r, i) => {
    const id = r.id || `sn_${i}`;
    ids.push(id);
    store["slog:" + id] = { id, path: "sentence", ts: 1000 + i, ...r };
  });
  store.slogIndex = ids;
}

console.log("\nSentence-mode settings and consent\n" + "=".repeat(72));

// --- Origin hygiene --------------------------------------------------------

console.log("\nOrigin lists are normalized and deduped:");
check("path is reduced to an origin",
  S.normalizeOriginList(["https://example.com/inbox"]), ["https://example.com"]);
// Two paths on one site normalize to the same origin. Without a dedupe the
// popup removed with indexOf/splice -- one occurrence -- so "Use it on this
// site" could not be switched off and the checkbox re-rendered checked.
check("duplicates collapse",
  S.normalizeOriginList(["https://x.com/a", "https://x.com/b"]), ["https://x.com"]);
check("case is normalized", S.normalizeOriginList(["https://Example.COM/p"]), ["https://example.com"]);
check("bare hostname is dropped", S.normalizeOriginList(["example.com"]), []);
check("non-http schemes are dropped",
  S.normalizeOriginList(["file:///tmp/x", "chrome://settings", "ftp://h/"]), []);
check("junk is dropped", S.normalizeOriginList([null, 42, "", "   "]), []);
check("port is part of the origin",
  S.normalizeOriginList(["http://127.0.0.1:8080/x"]), ["http://127.0.0.1:8080"]);

console.log("\nSite toggles act on one origin:");
check("add", S.applySiteToggle(["https://a.com"], { origin: "https://b.com", enabled: true }),
  ["https://a.com", "https://b.com"]);
check("remove", S.applySiteToggle(["https://a.com", "https://b.com"], { origin: "https://a.com", enabled: false }),
  ["https://b.com"]);
check("adding twice is idempotent",
  S.applySiteToggle(["https://a.com"], { origin: "https://a.com", enabled: true }), ["https://a.com"]);
check("removing a duplicated origin removes ALL of it",
  S.applySiteToggle(["https://a.com", "https://a.com"], { origin: "https://a.com", enabled: false }), []);
check("a full URL toggles its origin",
  S.applySiteToggle([], { origin: "https://a.com/deep/path", enabled: true }), ["https://a.com"]);
check("an unusable origin changes nothing",
  S.applySiteToggle(["https://a.com"], { origin: "notaurl", enabled: true }), ["https://a.com"]);

// --- The consent decision --------------------------------------------------

// `base` is a switched-on install at the current schema with nothing switched
// off anywhere. Since v5 there is one bit and on means WRITE, so `apply` is
// always `allowed`; `migrated` is getSettings' "the stored schema is current".
const base = (over) => ({
  sentenceMode: true, migrated: true, qualified: true,
  sentenceModeDisabledSites: [], disabledSites: [], ...over,
});
const state = (over, origin = "https://x.com") => S.sentenceModeState(base(over), origin);

console.log("\nsentenceModeState: on unless something switches it off, fail-closed on the rest:");
check("on means write", state({}), { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });
check("a stale apply bit changes nothing", state({ sentenceModeApply: false }), { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });
check("global off", state({ sentenceMode: false }), { activated: false, siteDisabled: false, allowed: false, reason: "switched-off", apply: false });
// The v5 fail-closed half: until the migration is persisted a stored
// `sentenceMode: true` may be a SUGGESTION consent, and it is not a write one.
check("not yet migrated: refused", state({ migrated: false }), { activated: false, siteDisabled: false, allowed: false, reason: "upgrading", apply: false });
// No current, passing speed check: refused.
check("no passing speed check: refused", state({ qualified: false }), { activated: true, siteDisabled: false, allowed: false, reason: "qualification-required", apply: false });
check("...including a missing flag", state({ qualified: undefined }), { activated: true, siteDisabled: false, allowed: false, reason: "qualification-required", apply: false });
check("...including a missing flag", state({ migrated: undefined }), { activated: false, siteDisabled: false, allowed: false, reason: "upgrading", apply: false });
check("switched off on this site", state({ sentenceModeDisabledSites: ["https://x.com"] }),
  { activated: true, siteDisabled: true, allowed: false, reason: "site-disabled", apply: false });
check("...and only on this site", state({ sentenceModeDisabledSites: ["https://x.com"] }, "https://other.com"),
  { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });
check("no origin at all", state({}, null), { activated: true, siteDisabled: false, allowed: false, reason: "no-http-page", apply: false });
check("disabledSites wins", state({ disabledSites: ["https://x.com"] }), { activated: true, siteDisabled: true, allowed: false, reason: "site-disabled", apply: false });
// A denylist cannot say no to an origin that could never be put ON it.
// normalizeOriginList keeps http(s) only, so a file:// or about:blank tab
// (origin "null" -- the string, and truthy), a chrome-extension:// page or
// anything else the manifest's <all_urls> reaches would be on with no way to
// switch it off. Refused, exactly as it could never have been granted.
check("a file:// tab's origin is refused", state({}, "null"), { activated: true, siteDisabled: false, allowed: false, reason: "no-http-page", apply: false });
check("a chrome-extension:// origin is refused",
  state({}, "chrome-extension://abcdefghijklmnop"), { activated: true, siteDisabled: false, allowed: false, reason: "no-http-page", apply: false });
check("a bare hostname is refused", state({}, "x.com"), { activated: true, siteDisabled: false, allowed: false, reason: "no-http-page", apply: false });
check("plain http is a web page", state({}, "http://127.0.0.1:8080"), { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });
// The old keys are gone, not dormant: a stale write naming them changes nothing.
check("a stale expiry has no effect", state({ sentenceModeExpiry: Date.now() - 1 }), { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });
check("a stale allowlist has no effect", state({ sentenceModeSites: [] }), { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });

console.log("\nThe top-level origin comes from the sender, never from the message:");
check("tab url wins over frame url",
  S.topLevelOriginOf({ tab: { url: "https://top.com/page" }, url: "https://frame.com/x", frameId: 3 }),
  "https://top.com");
check("top frame with no tab record falls back to its own url",
  S.topLevelOriginOf({ url: "https://top.com/page", frameId: 0 }), "https://top.com");
// A subframe with no tab record must NOT fall back to its own origin -- that
// is precisely the third-party frame inheriting a grant.
check("subframe with no tab record fails closed",
  S.topLevelOriginOf({ url: "https://frame.com/x", frameId: 7 }), null);
check("no sender at all", S.topLevelOriginOf(null), null);

// --- Writes ----------------------------------------------------------------

console.log("\nThe sanitizer takes the denylist and nothing from the old model:");
check("the denylist is normalized",
  S.sanitizeSettingsUpdate({ sentenceModeDisabledSites: ["https://X.com/p", "junk"] }).sentenceModeDisabledSites,
  ["https://x.com"]);
check("a non-array denylist is dropped",
  "sentenceModeDisabledSites" in S.sanitizeSettingsUpdate({ sentenceModeDisabledSites: "https://x.com" }), false);
// The expiry and its duration went with the grant. A stale popup or a direct
// storage write naming them must not resurrect a mechanism nothing reads.
check("the old expiry is not accepted", "sentenceModeExpiry" in S.sanitizeSettingsUpdate({ sentenceModeExpiry: 12345 }), false);
check("the old duration is not accepted", "sentenceModeDays" in S.sanitizeSettingsUpdate({ sentenceModeDays: 14 }), false);
check("the old allowlist is not accepted",
  "sentenceModeSites" in S.sanitizeSettingsUpdate({ sentenceModeSites: ["https://x.com"] }), false);

console.log("\nA stale caller cannot switch a site back on that the user switched off:");
{
  // The mirror image of the opt-in hazard: there, a stale Save resurrected a
  // revoked grant; here it would drop an origin from the disabled list. Both
  // are a permission to edit text coming back by read-modify-write.
  reset();
  store[S.QUALIFICATION_KEY] = QUAL();
  // The mode is off by default since v4, and these cases are about the
  // DENYLIST rather than the default, so turn it on first -- otherwise every
  // origin is refused for a reason that has nothing to do with what is
  // being tested.
  await S.setSentenceMode(true);
  // Popup A opened here and snapshotted an empty disabled list. Popup B
  // switches x off -- `enabled` on the toggle is MEMBERSHIP of the disabled
  // list, the disabledSiteToggle contract the popup inverts its box into.
  await S.setSettings({ sentenceDisabledSiteToggle: { origin: "https://x.com", enabled: true } });
  check("B's switch-off took effect", (await S.getSettings()).sentenceModeDisabledSites, ["https://x.com"]);
  // Now A saves with its own site left on. A whole-array write from A's
  // snapshot would empty the list.
  await S.setSettings({ sentenceDisabledSiteToggle: { origin: "https://y.com", enabled: false } });
  const after = await S.getSettings();
  check("A's later Save does not switch x back on", after.sentenceModeDisabledSites, ["https://x.com"]);
  check("and x is still refused", S.sentenceModeState(after, "https://x.com").allowed, false);
  check("while y is on", S.sentenceModeState(after, "https://y.com").allowed, true);
}
{
  reset();
  store[S.QUALIFICATION_KEY] = QUAL();
  await S.setSentenceMode(true);
  await S.setSettings({ sentenceDisabledSiteToggle: { origin: "https://x.com", enabled: true } });
  // A switch-off made elsewhere while a popup was open must survive that
  // popup's unrelated Save.
  await S.setSettings({ sentenceDisabledSiteToggle: { origin: "https://z.com", enabled: true } });
  await S.setSettings({ recordAll: false });
  check("a switch-off made elsewhere survives an unrelated Save",
    (await S.getSettings()).sentenceModeDisabledSites, ["https://x.com", "https://z.com"]);
}
{
  reset();
  store[S.QUALIFICATION_KEY] = QUAL();
  await S.setSentenceMode(true);
  await S.setSettings({ sentenceModeDisabledSites: ["https://x.com", "https://y.com"] });
  await S.setSettings({ clearSentenceModeDisabledSites: true });
  const after = await S.getSettings();
  check("turn on everywhere empties the denylist", after.sentenceModeDisabledSites, []);
  check("and x is allowed after it", S.sentenceModeState(after, "https://x.com").allowed, true);
}
{
  // Switching the whole mode off is the global flag, not a list action, and
  // it wins over an empty denylist.
  reset();
  await S.setSentenceMode(false);
  const after = await S.getSettings();
  check("global off is stored", after.sentenceMode, false);
  check("and nothing is allowed under it", S.sentenceModeState(after, "https://x.com").allowed, false);
}

console.log("\nCONCURRENT writes cannot switch a site back on either:");
{
  // The stale-caller cases above are sequential. Every settings write is a
  // read-modify-write of the whole object, so without serialization two
  // OVERLAPPING handlers each read the same snapshot and the second write
  // spreads the pre-switch-off list back in over the first's toggle.
  reset();
  storageDelay = 2;                 // force both handlers to read before either writes
  const switchOff = S.setSettings({ sentenceDisabledSiteToggle: { origin: "https://x.com", enabled: true } });
  const unrelated = S.setSettings({ recordAll: false });
  await Promise.all([switchOff, unrelated]);
  storageDelay = 0;
  const after = await S.getSettings();
  check("the switch-off survives an overlapping unrelated save", after.sentenceModeDisabledSites, ["https://x.com"]);
  check("...and the unrelated save still landed", after.recordAll, false);
  check("...and x is still refused after it", S.sentenceModeState(after, "https://x.com").allowed, false);
}

console.log("\nStored settings are normalized on READ, not only on write:");
{
  reset();
  // Written by direct storage access, or by a popup that sent the whole array.
  store = {
    sentenceModeDisabledSites: ["example.com", "https://Example.COM/some/path", "https://x.com", "https://x.com"],
  };
  const s = await S.getSettings();
  check("junk entries do not sit in the list looking like switch-offs",
    s.sentenceModeDisabledSites, ["https://example.com", "https://x.com"]);
  check("the normalized form is what is switched off",
    S.sentenceModeState(s, "https://example.com").allowed, false);
  check("and the duplicate did not double up",
    s.sentenceModeDisabledSites.filter((o) => o === "https://x.com").length, 1);
}

// --- The warmup ------------------------------------------------------------
//
// The warmup pins 8.6GB of VRAM and re-arms the lease at +18.5W, so "not on a
// site it is switched off for" is a real constraint and not a nicety. It goes
// through the same consent check as a rewrite.

console.log("\nA warmup is refused wherever a rewrite would be:");
{
  const decide = (over, origin = "https://x.com") => {
    S.noteOllamaRequest(S.SENTENCE_NUM_CTX, S.PINNED_MODEL.tag);   // hot, so only consent can refuse
    return S.sentenceWarmupDecision(base(over), origin, Date.now());
  };
  check("global off", decide({ sentenceMode: false }).reason, "not-allowed");
  check("site switched off", decide({ sentenceModeDisabledSites: ["https://x.com"] }).reason, "not-allowed");
  check("no origin at all", decide({}, null).reason, "not-allowed");
  check("a non-http origin", decide({}, "null").reason, "not-allowed");
  check("disabledSites wins", decide({ disabledSites: ["https://x.com"] }).reason, "not-allowed");
  check("a site that is on is not refused", decide({}).warm, false);   // refused as "hot", not consent
  check("...and says so", decide({}).reason, "hot");
}

console.log("\nOn a granted site, the decision is about the runner:");
{
  const now = Date.now();
  const decide = () => S.sentenceWarmupDecision(base({}), "https://x.com", now);

  S.noteOllamaRequest(S.SENTENCE_NUM_CTX, S.PINNED_MODEL.tag);
  check("just talked to Ollama at the right ctx -> nothing to do", decide(), { warm: false, reason: "hot" });

  // A long manual rewrite loads 4096 and evicts the sentence runner. Without
  // this the NEXT sentence pays the ~2.1s reload with no panel on screen.
  S.noteOllamaRequest(4096, S.PINNED_MODEL.tag);
  check("a manual rewrite left the wrong runner loaded", decide(), { warm: true, reason: "wrong-ctx" });
  S.noteOllamaRequest(16384, S.PINNED_MODEL.tag);
  check("...at any size", decide(), { warm: true, reason: "wrong-ctx" });

  // The runner is keyed by MODEL as well as size. A contact on another model
  // at the sentence path's own num_ctx leaves a runner warm at the right SIZE
  // for the wrong WEIGHTS -- a decision reading only num_ctx reported that as
  // `hot` and skipped the warmup, so the next sentence paid the full load.
  const one = base({});
  S.noteOllamaRequest(S.SENTENCE_NUM_CTX, "other-model");
  check("a contact on another model at 2048 is still the wrong runner",
    S.sentenceWarmupDecision(one, "https://x.com", now), { warm: true, reason: "wrong-model" });
  S.noteOllamaRequest(S.SENTENCE_NUM_CTX, S.PINNED_MODEL.tag);
  check("a contact on the model itself is hot",
    S.sentenceWarmupDecision(one, "https://x.com", now), { warm: false, reason: "hot" });
}

console.log("\nStaleness is measured against the sentence lease:");
{
  S.noteOllamaRequest(S.SENTENCE_NUM_CTX, S.PINNED_MODEL.tag);
  const t = Date.now();
  check("inside the window", S.sentenceWarmupDecision(base({}), "https://x.com", t + 1000),
    { warm: false, reason: "hot" });
  check("past it, the model may have dropped",
    S.sentenceWarmupDecision(base({}), "https://x.com", t + S.SENTENCE_WARM_STALE_MS + 1000),
    { warm: true, reason: "stale" });
  // THE relationship, and it is cross-FILE as well as cross-constant. The
  // sentence lease is renewed by pings content.js sends at most every
  // SENTENCE_WARM_RENEW_MS, and background.js answers `hot` (no Ollama
  // contact) to any ping younger than SENTENCE_WARM_STALE_MS -- so the
  // worst-case gap between two real contacts under continuous typing is
  // stale + renew, and that has to fit inside the lease or a typing user
  // watches the runner unload mid-sentence. MV3 gives the two files no shared
  // module, so the renewal constant is extracted from content.js source; a
  // failed extraction is a FAILURE, not a pass.
  const contentSrc = readFileSync(join(__dirname, "..", "content.js"), "utf8");
  const renewMatch = contentSrc.match(/const SENTENCE_WARM_RENEW_MS = (\d+);/);
  check("content.js declares SENTENCE_WARM_RENEW_MS", !!renewMatch, true);
  const renewMs = renewMatch ? Number(renewMatch[1]) : Infinity;
  check("stale + renew fits inside the sentence lease, with margin",
    S.SENTENCE_WARM_STALE_MS + renewMs <= S.SENTENCE_KEEP_ALIVE_MS - 1000, true);
  // The strings Ollama actually receives have to be the same durations as the
  // ms figures everything else reasons about.
  check("the sentence ms constant matches the string sent to Ollama",
    S.SENTENCE_KEEP_ALIVE, "20s");
  check("...which is SENTENCE_KEEP_ALIVE_MS", S.SENTENCE_KEEP_ALIVE_MS, 20000);
  // The record carries the lease in force, because log-latency.mjs attributes
  // idle-expiry by comparing request gaps against it. There was a second, 90s
  // lease on the manual path until it was removed (2026-09-24); records
  // written before `keepAliveMs` existed are read against that one.
  check("the sentence request sends the typing lease",
    S.prepareSentenceRequest("A sentence.", "", {}, { ollamaModel: "m" }).body.keep_alive, S.SENTENCE_KEEP_ALIVE);
  check("...and names it in ms for the record",
    S.prepareSentenceRequest("A sentence.", "", {}, { ollamaModel: "m" }).keepAliveMs, S.SENTENCE_KEEP_ALIVE_MS);
}

console.log("\nThe warmup body cannot drift from the real request:");
{
  const settings = { ollamaModel: "test-model", ollamaUrl: "http://localhost:11434" };
  const warm = S.sentenceWarmupBody(settings);
  const real = S.prepareSentenceRequest("A sentence to fix.", "", {}, settings).body;
  // THE test. num_ctx is a load-time parameter, so a warmup at the wrong value
  // is worse than no warmup at all -- measured, it loads one runner (~2.0s) and
  // the real request then evicts it and loads another (~2.6s), 4.6s against
  // 2.4s for doing nothing. It is derived rather than restated so this holds.
  check("num_ctx matches the real sentence request", warm.options.num_ctx, real.options.num_ctx);
  check("...and that is SENTENCE_NUM_CTX", warm.options.num_ctx, S.SENTENCE_NUM_CTX);
  check("same model", warm.model, real.model);
  check("same keep_alive", warm.keep_alive, real.keep_alive);
  // Empty messages is what makes it a pure load: Ollama answers done_reason
  // "load" with no eval_count, so it costs no GPU work (0.029 J measured,
  // against 57 J for a real request).
  check("messages are empty", warm.messages, []);
  check("the real request's messages are not", real.messages.length > 0, true);
}

console.log("\nOne model, pinned in code:");
{
  check("there is no model setting", ["ollamaModel", "sentenceModel"].filter((k) => k in S.DEFAULT_SETTINGS), []);
  check("...and the sanitizer will not write one",
    Object.keys(S.sanitizeSettingsUpdate({ ollamaModel: "x", sentenceModel: "y" })), []);
  // The extension's own call sites pass no options: the pinned model.
  check("the request goes to the pinned model",
    S.prepareSentenceRequest("A sentence.", "", {}).body.model, S.PINNED_MODEL.tag);
  check("...and so does the warmup, from the settings the worker holds",
    S.sentenceWarmupBody({ ollamaUrl: "http://localhost:11434", sentenceMode: true }).model, S.PINNED_MODEL.tag);
  check("the pin is a tag AND a 64-hex digest",
    [typeof S.PINNED_MODEL.tag, /^[0-9a-f]{64}$/.test(S.PINNED_MODEL.digest)], ["string", true]);
  // Through the real handler: whatever is stored, the POST names the pin.
  const sender = { tab: { url: "https://example.com/a" }, url: "https://example.com/a" };
  reset();
  store = { settingsVersion: S.SETTINGS_VERSION, ollamaUrl: "http://localhost:11434",
    ollamaModel: "stale-stored-model", sentenceModel: "another", sentenceMode: true, recordAll: false , [S.QUALIFICATION_KEY]: QUAL() };
  let posted = null;
  fetchImpl = (url, opts) => {
    if (!String(url).includes("/api/chat")) return diskFetch(url);
    posted = JSON.parse(opts.body).model;
    return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ message: { content: JSON.stringify({ rewritten: "This sentence is wrong." }) }, done_reason: "stop" }) });
  };
  await send({ type: "SENTENCE_REWRITE", requestId: "sn_pin", sentence: "This sentance is wrong.", trigger: "idle" }, sender);
  check("a stored model setting cannot redirect a sentence request", posted, S.PINNED_MODEL.tag);
  // The context demonstration no longer keys on the tag: it goes whenever
  // there is a context (it is a 3-message group).
  const ctx = "Prior context that exists.";
  const withCtx = S.prepareSentenceRequest("A sentence.", ctx, {}).body.messages;
  const noCtx = S.prepareSentenceRequest("A sentence.", "", {}).body.messages;
  check("the context demonstration goes whenever there is a context", withCtx.length - noCtx.length, 3);
}

// --- The verdict allowlist cannot drift from what content.js emits ---------
//
// REWRITE_OUTCOME accepts exact entries and declared reason families, dropping
// anything else with no error anywhere, so a verdict added to content.js and not here logs NOTHING:
// the record keeps whatever it said before, or stays null, and the only symptom
// is a number quietly missing from the popup. It has happened twice --
// `sentence-not-durable` and `apply-failed` both had to be added here before
// either was worth emitting -- and until now the only thing standing between it
// and a third time was a maintainer note telling whoever came next to
// remember.
//
// Reason-bearing families carry a colon and do not match the emitted-literal
// pattern below; [V2]/[V3]/[V5] probe their acceptance through the real handler.
console.log("\nEvery verdict content.js emits is one background.js accepts:");
{
  const content = readFileSync(join(__dirname, "..", "content.js"), "utf8");
  const allowed = new Set(S.VERDICTS);
  check("the evaluated definitions supply accepted exact verdicts", [...allowed].sort(),
    Object.keys(S.SENTENCE_OUTCOMES).filter((v) => S.SENTENCE_OUTCOMES[v].accepted && !v.endsWith("*")).sort());
  check("and it is not empty", allowed.size > 0, true);
  // Verdict-shaped literals, which is the whole vocabulary and nothing else:
  // status details (`write-rejected`, `not-durable`), skip reasons
  // (`reconciled-sync`) and CSS class names (`proofer-sentence-flash`) all fail
  // the anchor or the prefix.
  // The manual path's bare verdicts (applied, dismissed, cancelled, ...) are
  // no longer in this pattern: that path is gone, and `"cancelled"` survives in
  // content.js only as a response error code, which is not a verdict.
  const emitted = new Set((content.match(
    /"(sentence-[a-z0-9-]+|user-[a-z0-9-]+)"/g
  ) || []).map((s) => s.slice(1, -1)));
  check("content.js emits a verdict vocabulary at all", emitted.size > 5, true);
  check("nothing content.js emits is dropped on arrival",
    [...emitted].filter((v) => !allowed.has(v)).sort(), []);
  // And the other direction, for NEW records: the removed modes' verdicts are
  // refused (the stats still read them in old records, as legacy).
  const RETIRED = ["applied", "dismissed", "cancelled", "edited-after-apply",
    "edited-after-no-change", "apply-failed", "sentence-suggested",
    "sentence-dismissed", "sentence-suggestion-applied", "sentence-edited", "sentence-no-change"];
  check("no retired verdict is accepted for a new record",
    RETIRED.filter((v) => allowed.has(v)), []);
  // ...and driven through the real handler: an outcome naming one does not
  // patch the record it names.
  reset();
  seedSentenceRing([{ id: "sn_legacy", verdict: null, input: "x", output: "y" }]);
  await send({ type: "REWRITE_OUTCOME", requestId: "sn_legacy", verdict: "sentence-suggestion-applied" });
  await vm.runInContext("logQueue", ctx);
  check("a retired verdict does not patch a record", store["slog:sn_legacy"].verdict, null);
  await send({ type: "REWRITE_OUTCOME", requestId: "sn_legacy", verdict: "sentence-applied" });
  await vm.runInContext("logQueue", ctx);
  check("...while a current one does", store["slog:sn_legacy"].verdict, "sentence-applied");
}

// [V1] Mutants: either undo definition's keep: "rejected" -> "kept"
// turns the literal rate/count assertions red; removing either receipt turns
// its exact label assertion red. No expectations come from the policy table.
console.log("\n[V1] Failed Escape is rejection, never correction loss:");
{
  reset();
  const verdicts = ["sentence-applied", "sentence-applied-unverified", "sentence-undone",
    "sentence-undo-reconciled", "sentence-undo-unverified", "sentence-reconciled"];
  seedSentenceRing(verdicts.map((v, i) => ({ id: `sn_v1_${i}`, verdict: null,
    input: "The techncian arrived early.", output: "The technician arrived early." })));
  for (const [i, verdict] of verdicts.entries()) {
    await send({ type: "REWRITE_OUTCOME", requestId: `sn_v1_${i}`, verdict }, CONTENT);
  }
  await vm.runInContext("logQueue", ctx);
  check("[V1] all six reports persist exactly", verdicts.map((v, i) => store[`slog:sn_v1_${i}`].verdict), verdicts);
  const s = (await send({ type: "GET_LOG_STATS" })).sentence;
  check("[V1] kept/reverted/lost/rate are 2/3/1/40", [s.applied, s.reverted, s.lost, s.keepRate], [2, 3, 1, 40]);
  check("[V1] six records partition as 2/3/1", s.distribution,
    { noChange: 0, guarded: 0, applied: 2, rejected: 3, lost: 1, other: 0 });
  check("[V1] undo details are subcounts of rejection", [s.breakdown.rejected,
    s.breakdown.undoReconciled, s.breakdown.undoUnverified], [3, 1, 1]);
  check("[V1] old apply outcomes retain their breakdown", [s.breakdown.appliedSilently,
    s.breakdown.appliedUnverified, s.breakdown.lost], [1, 1, 1]);
  const rows = (await send({ type: "GET_RECENT_SENTENCES" })).rows;
  const labels = ["applied", "applied (not verified)", "you undid this",
    "you pressed Escape; the page discarded the undo", "you pressed Escape; the undo was not verified",
    "the page discarded it"];
  for (const [i, label] of labels.entries()) {
    check(`[V1] receipt ${verdicts[i]}`, rows.find((r) => r.id === `sn_v1_${i}`)?.outcome, label);
  }
}

// [V2] Mutants: patch.verdict = msg.verdict.slice(0, 64) turns stored
// verdicts, delivery stats and exported verdicts red; const key = String(reason).slice(0, 48)
// turns stored counters, skip stats and exported counters red.
console.log("\n[V2] Counter keys and verdict reasons share one 128-character bound:");
{
  reset();
  const backspace = "splice-failed:misplaced:window=yield/key:Backspace";
  const backward = "splice-failed:misplaced:window=yield/input:deleteContentBackward";
  const forward = "splice-failed:misplaced:window=yield/input:deleteContentForward";
  const precondition = "splice-refused:selection-shifted:window=blocked/input:deleteContentBackward";
  const boundary128 = "x".repeat(128);
  const boundary129 = boundary128 + "y";
  const written128 = "splice-failed:normalized:window=" + "x".repeat(96);
  const written129 = written128 + "y";
  const reasons = [backspace, backward, forward, precondition, boundary128, boundary129, written128, written129];
  const canonical = [backspace, backward, forward, precondition, boundary128, boundary128, written128, written128];
  const prefixes = ["sentence-written:", "sentence-written:", "sentence-written:",
    "sentence-skipped:", "sentence-skipped:", "sentence-skipped:", "sentence-written:", "sentence-written:"];
  check("[V2] fixtures reach the long reasons and both bound edges",
    reasons.map((r) => r.length), [50, 64, 63, 75, 128, 129, 128, 129]);
  // Old counter and verdict truncations stay distinct; new reports cannot
  // reconstruct or merge their missing tails.
  const oldCounter = "splice-failed:misplaced:window=yield/key:Backspa";
  const oldReason = "splice-failed:misplaced:window=yield/key:Backsp";
  seedSentenceRing([
    ...reasons.map((r, i) => ({ id: `sn_v2_${i}`, verdict: null })),
    { id: "sn_v2_old", verdict: "sentence-skipped:" + oldReason },
  ]);
  const oldRecord = JSON.stringify(store["slog:sn_v2_old"]);
  store.sentenceSkips = { [oldCounter]: 7 };
  for (const [i, reason] of reasons.entries()) {
    await send({ type: "SENTENCE_SKIPS", counts: { [reason]: 1 } }, CONTENT);
    await send({ type: "REWRITE_OUTCOME", requestId: `sn_v2_${i}`,
      verdict: prefixes[i] + reason }, CONTENT);
  }
  await vm.runInContext("logQueue", ctx);
  const currentCounts = { [backspace]: 1, [backward]: 1, [forward]: 1,
    [precondition]: 1, [boundary128]: 2, [written128]: 2 };
  const counts = { [oldCounter]: 7, ...currentCounts };
  check("[V2] stored counters preserve full reasons and bound oversized input", store.sentenceSkips, counts);
  for (const [i, reason] of canonical.entries()) {
    check(`[V2] stored verdict reason ${i} is canonical outside the prefix`,
      store[`slog:sn_v2_${i}`].verdict, prefixes[i] + reason);
  }
  check("[V2] historical record is not rewritten", JSON.stringify(store["slog:sn_v2_old"]), oldRecord);
  const stats = (await send({ type: "GET_LOG_STATS" })).sentence;
  check("[V2] skip stats preserve the canonical counter keys", stats.skips, counts);
  check("[V2] delivery stats preserve the canonical verdict reasons", stats.breakdown.deliverySkipped,
    { [precondition]: 1, [boundary128]: 2 });
  check("[V2] post-write reasons and historical aliases are not delivery drops",
    [stats.breakdown.writtenNormalized, stats.breakdown.writtenMisplaced], [2, 4]);
  const rows = (await send({ type: "EXPORT_LOG" })).records;
  const skipRows = rows.filter((r) => r.path === "skips");
  check("[V2] export has one counter row", skipRows.length, 1);
  check("[V2] exported counters preserve the canonical keys", skipRows[0]?.skips, counts);
  check("[V2] exported verdicts preserve the canonical reasons",
    reasons.map((r, i) => rows.find((row) => row.id === `sn_v2_${i}`)?.verdict),
    canonical.map((r, i) => prefixes[i] + r));
  check("[V2] exported historical record is unchanged",
    JSON.stringify(rows.find((r) => r.id === "sn_v2_old")), oldRecord);
}

// [V3] Mutants: misplaced distribution: "other" -> "applied" turns the
// partition red; bypass sentenceOutcomeDefinition(msg.verdict)?.accepted for
// sentence-written: turns the unknown/malformed no-patch assertions red.
console.log("\n[V3] Post-write outcomes are bounded families with distinct delivery policy:");
{
  reset();
  const verdicts = ["sentence-written:splice-failed:normalized", "sentence-written:splice-failed:misplaced",
    "sentence-written:splice-failed:normalized:window=replay",
    "sentence-written:splice-failed:misplaced:window=yield/input:deleteContentBackward",
    "sentence-skipped:splice-failed:ignored"];
  seedSentenceRing(verdicts.map((v, i) => ({ id: `sn_v3_${i}`, verdict: null,
    input: "The techncian arrived early.", output: "The technician arrived early.", retry: { outcome: "applied" } })));
  for (const [i, verdict] of verdicts.entries()) {
    await send({ type: "REWRITE_OUTCOME", requestId: `sn_v3_${i}`, verdict }, CONTENT);
  }
  await vm.runInContext("logQueue", ctx);
  check("[V3] reports retain their exact family and window tags",
    verdicts.map((v, i) => store[`slog:sn_v3_${i}`].verdict), verdicts);
  const s = (await send({ type: "GET_LOG_STATS" })).sentence;
  check("[V3] five records partition as two applied and three other", s.distribution,
    { noChange: 0, guarded: 0, applied: 2, rejected: 0, lost: 0, other: 3 });
  check("[V3] only normalized writes enter the keep rate", [s.applied, s.reverted, s.lost, s.keepRate], [2, 0, 0, 100]);
  check("[V3] post-write breakdown and other detail are named",
    [s.breakdown.writtenNormalized, s.breakdown.writtenMisplaced, s.otherDetail.writtenMisplaced,
      s.otherDetail.deliverySkipped, s.otherDetail.unclassified], [2, 2, 2, 1, 0]);
  check("[V3] only the ignored write is a delivery drop", s.breakdown.deliverySkipped, { "splice-failed:ignored": 1 });
  check("[V3] only normalized post-writes salvage a retry", s.retrySalvaged, 2);
  const rows = (await send({ type: "GET_RECENT_SENTENCES" })).rows;
  check("[V3] all four mutations have receipts", rows.map((r) => r.id).sort(), ["sn_v3_0", "sn_v3_1", "sn_v3_2", "sn_v3_3"]);
  for (const i of [0, 2]) check(`[V3] normalized receipt ${i}`, rows.find((r) => r.id === `sn_v3_${i}`)?.outcome,
    "replacement reached its target; the editor changed surrounding text");
  for (const i of [1, 3]) check(`[V3] misplaced receipt ${i} identifies proposed output`, rows.find((r) => r.id === `sn_v3_${i}`)?.outcome,
    "write changed the field without honoring its target; proposed replacement shown");
  for (const verdict of ["sentence-written:splice-failed:unknown", "sentence-written:splice-failed:ignored",
    "sentence-written:splice-failed:normalized-extra", "sentence-written:splice-failed:normalized:other=x",
    "sentence-written:splice-failed:misplaced:window="]) {
    const before = JSON.stringify(store["slog:sn_v3_0"]);
    await send({ type: "REWRITE_OUTCOME", requestId: "sn_v3_0", verdict }, CONTENT);
    await vm.runInContext("logQueue", ctx);
    check(`[V3] invalid family does not patch: ${verdict}`, JSON.stringify(store["slog:sn_v3_0"]), before);
  }
  reset();
  seedSentenceRing(["sentence-undone", "sentence-reconciled", "sentence-not-durable", null].map((verdict, i) => ({
    id: `sn_v3_later_${i}`, verdict, input: "x", output: "y", retry: { outcome: "applied" },
  })));
  check("[V3] later rejection, loss and pending verdict still count delivered retries",
    (await send({ type: "GET_LOG_STATS" })).sentence.retrySalvaged, 4);
  // Mutant: remove !record.error from isRetrySalvaged. An accepted retry with
  // an interaction error cannot count as delivered, even in a legacy row.
  seedSentenceRing([
    { id: "sn_v3_v2", v: 2, output: "A corrected sentence.", error: null, retry: { outcome: "applied" }, verdict: "sentence-written:splice-failed:normalized" },
    { id: "sn_v3_v1", v: 1, output: "A corrected sentence.", error: "consent-read-timeout", retry: { outcome: "applied" } },
    { id: "sn_v3_missing", v: 2, output: null, error: "delivery-expired", retry: { outcome: "applied" } },
  ]);
  check("[V3] mixed-schema salvage excludes accepted but undelivered retries",
    (await send({ type: "GET_LOG_STATS" })).sentence.retrySalvaged, 1);

}

// [V3b] Mutant: remove the legacy alias return in sentenceOutcomeDefinition;
// historical partition, details, retry salvage and receipt assertions turn red.
console.log("\n[V3b] Historical post-write aliases are read without rewriting storage:");
{
  reset();
  const verdicts = ["sentence-skipped:splice-failed:normalized", "sentence-skipped:splice-failed:misplaced",
    "sentence-skipped:splice-failed:normalized:window=yield/key:Back",
    "sentence-skipped:splice-failed:misplaced:window=yield/key:Backsp"];
  seedSentenceRing(verdicts.map((verdict, i) => ({ id: `sn_v3b_${i}`, verdict,
    input: "The techncian arrived early.", output: "The technician arrived early.", retry: { outcome: "applied" } })));
  const before = verdicts.map((v, i) => JSON.stringify(store[`slog:sn_v3b_${i}`]));
  const s = (await send({ type: "GET_LOG_STATS" })).sentence;
  check("[V3b] historical records partition as two applied and two other", s.distribution,
    { noChange: 0, guarded: 0, applied: 2, rejected: 0, lost: 0, other: 2 });
  check("[V3b] historical mutations have named details",
    [s.breakdown.writtenNormalized, s.breakdown.writtenMisplaced, s.otherDetail.writtenMisplaced], [2, 2, 2]);
  check("[V3b] historical writes are not delivery drops", s.breakdown.deliverySkipped, {});
  check("[V3b] historical normalization alone contributes to keep and salvage",
    [s.applied, s.lost, s.keepRate, s.retrySalvaged], [2, 0, 100, 2]);
  const rows = (await send({ type: "GET_RECENT_SENTENCES" })).rows;
  check("[V3b] all historical mutations are receipt eligible", rows.length, 4);
  check("[V3b] historical receipts use corrected labels", verdicts.map((v, i) => rows.find((r) => r.id === `sn_v3b_${i}`)?.outcome), [
    "replacement reached its target; the editor changed surrounding text",
    "write changed the field without honoring its target; proposed replacement shown",
    "replacement reached its target; the editor changed surrounding text",
    "write changed the field without honoring its target; proposed replacement shown",
  ]);
  const exported = (await send({ type: "EXPORT_LOG" })).records;
  check("[V3b] stored records are untouched", verdicts.map((v, i) => JSON.stringify(store[`slog:sn_v3b_${i}`])), before);
  check("[V3b] exports preserve stored strings", verdicts.map((v, i) => exported.find((r) => r.id === `sn_v3b_${i}`)?.verdict), verdicts);
  seedSentenceRing([{ id: "sn_v3b_new", verdict: null }]);
  await send({ type: "REWRITE_OUTCOME", requestId: "sn_v3b_new", verdict: verdicts[0] }, CONTENT);
  await vm.runInContext("logQueue", ctx);
  check("[V3b] legacy alias does not authorize new reports", store["slog:sn_v3b_new"].verdict, null);
}

// [V4] Mutant: sentenceRecordGuard returns r.guard || null unconditionally;
// guarded=1, the literal partition, topGuard and errored=3 assertions turn red.
console.log("\n[V4] Historical model-shape errors never count as guard decisions:");
{
  store = {};
  const errors = ["truncated", "invalid-json", "no-rewritten-key"];
  seedSentenceRing([
    ...errors.map((error, i) => ({ id: `sn_v4_${i}`, guard: error, error, output: null })),
    { id: "sn_v4_guard", guard: "word-substituted:folx", error: null, output: "a candidate" },
  ]);
  const before = JSON.stringify(store);
  const s = (await send({ type: "GET_LOG_STATS" })).sentence;
  check("[V4] guarded=1 and errors=3", [s.guarded, s.errors], [1, 3]);
  check("[V4] four records partition as one guard and three other", s.distribution,
    { noChange: 0, guarded: 1, applied: 0, rejected: 0, lost: 0, other: 3 });
  check("[V4] topGuard names the real guard", s.topGuard, { reason: "word-substituted", n: 1 });
  check("[V4] three other records are explicitly errored", s.otherDetail,
    { legacySuggestion: 0, deliverySkipped: 0, writtenMisplaced: 0, errored: 3, unresolved: 0, unclassified: 0 });
  const exported = (await send({ type: "EXPORT_LOG" })).records;
  check("[V4] reading stats and export leaves storage intact", JSON.stringify(store), before);
  check("[V4] export retains the historical dual fields", errors.map((error, i) => {
    const r = exported.find((r) => r.id === `sn_v4_${i}`);
    return [r?.guard, r?.error];
  }), errors.map((error) => [error, error]));
  // Compatibility is deliberately narrow: a real guard with another error,
  // an unmatched old reason, and an unknown matching pair keep their guard.
  seedSentenceRing([
    { guard: "word-substituted:folx", error: "consent-read-timeout" },
    { guard: "truncated", error: "unreachable" },
    { guard: "unknown-reason", error: "unknown-reason" },
  ]);
  const controls = (await send({ type: "GET_LOG_STATS" })).sentence;
  check("[V4] unmatched and genuine guards survive accompanying errors", controls.guarded, 3);
  check("[V4] all compatibility controls remain in the guarded bucket", controls.distribution,
    { noChange: 0, guarded: 3, applied: 0, rejected: 0, lost: 0, other: 0 });
}

// [V5] Mutants: accept sentence-dismissed in SENTENCE_OUTCOMES (accepted
// vocabulary and retired no-patch assertions); restore "dismissed" in the
// protocol row (row assertion).
console.log("\n[V5] One documented outcome vocabulary matches the worker:");
{
  const doc = readFileSync(join(__dirname, "..", "ARCHITECTURE.md"), "utf8");
  const row = doc.split("\n").find((l) => l.startsWith("| REWRITE_OUTCOME"));
  check("[V5] protocol row references the vocabulary without retired dismissal",
    !!row && row.includes("[Outcome vocabulary](#outcome-vocabulary)") && !row.includes("dismissed"), true);
  check("[V5] there is one outcome vocabulary table", (doc.match(/^### Outcome vocabulary$/gm) || []).length, 1);
  const table = doc.split("### Outcome vocabulary\n")[1]?.trimStart().split("\n\n")[0] || "";
  const documented = [...table.matchAll(/^\| `([^`]+)` \| yes \|/gm)].map((m) => m[1]).sort();
  check("[V5] accepted documented entries match evaluated definitions", documented,
    Object.keys(S.SENTENCE_OUTCOMES).filter((v) => S.SENTENCE_OUTCOMES[v].accepted).sort());
  reset();
  for (const verdict of ["dismissed", "sentence-dismissed", "sentence-written:unknown", "sentence-unknown"]) {
    seedSentenceRing([{ id: "sn_v5", verdict: null, input: "x", output: "y" }]);
    await send({ type: "REWRITE_OUTCOME", requestId: "sn_v5", verdict }, CONTENT);
    await vm.runInContext("logQueue", ctx);
    check(`[V5] ${verdict} does not patch the record`, store["slog:sn_v5"].verdict, null);
  }
  await send({ type: "REWRITE_OUTCOME", requestId: "sn_v5", verdict: "sentence-skipped:anchor:stale-age" }, CONTENT);
  await vm.runInContext("logQueue", ctx);
  check("[V5] declared parameterized family is accepted", store["slog:sn_v5"].verdict, "sentence-skipped:anchor:stale-age");
}

console.log("\nDefaults: a fresh install does nothing until it is activated:");
{
  reset();
  const s = await S.getSettings();
  // FLIPPED DELIBERATELY at settings v4 (2026-09-06). It was `true` from
  // 2026-09-02, which paired badly with the write staying off: the mode ran,
  // segmented and sent every finished sentence to the model, then offered a
  // chip instead of the silent correction that is the point. Full price for
  // the weaker half. The answer is not to flip the WRITE on -- turning a
  // default into a consent is how silent edits arrive unasked -- so the mode
  // starts off and the popup carries one deliberate activation.
  check("sentenceMode is OFF on a fresh install", s.sentenceMode, false);
  check("there is no second consent bit", "sentenceModeApply" in S.DEFAULT_SETTINGS, false);
  check("nothing is switched off", s.sentenceModeDisabledSites, []);
  check("so a fresh install does nothing on a web page",
    S.sentenceModeState(s, "https://x.com"), { activated: false, siteDisabled: false, allowed: false, reason: "upgrading", apply: false });
  check("and the old keys are not part of the schema",
    ["sentenceModeSites", "sentenceModeExpiry", "sentenceModeDays"].filter((k) => k in S.DEFAULT_SETTINGS), []);
  // The manual path's settings went with it: not in the
  // schema, and the sanitizer refuses to write them back.
  const MANUAL_KEYS = ["rewriteHotkey", "autoApply", "autoApplyExpiry", "autoApplyDays", "showFab"];
  check("the manual path's keys are not part of the schema",
    MANUAL_KEYS.filter((k) => k in S.DEFAULT_SETTINGS), []);
  check("...and the sanitizer drops every one of them",
    Object.keys(S.sanitizeSettingsUpdate({ rewriteHotkey: { ctrl: true, key: "p" }, autoApply: true,
      autoApplyExpiry: 5, autoApplyDays: 7, showFab: true })), []);
}

console.log("\nThe migration: every historical step, one write, and v5's one consent bit:");
{
  // v5 (2026-09-24) removed suggestion mode, so the stored pair
  // {sentenceMode, sentenceModeApply} becomes ONE bit that means "write".
  // The migration rule: anyone on suggestions becomes OFF, waiting
  // for Turn on; anyone already correcting automatically stays on; a migration
  // never turns a suggestion consent into a write consent. Every fixture here
  // is a real past shape, and the expected values are literals.
  const migrateFrom = async (stored) => {
    reset();
    store = JSON.parse(JSON.stringify(stored));
    await S.migrateSettings();
    return { store, s: await S.getSettings() };
  };
  const ON = "https://x.com";

  let r = await migrateFrom({ settingsVersion: 4, sentenceMode: true, sentenceModeApply: true, ollamaModel: "m" });
  // The bit survives, and it is still not enough on its own: an upgrading
  // install writes nothing until its speed check has passed (setup opens by
  // itself on the update) ...
  check("[v5] an automatic user stays on, and waits for the speed check", [r.store.sentenceMode, S.sentenceModeState(r.s, ON)],
    [true, { activated: true, siteDisabled: false, allowed: false, reason: "qualification-required", apply: false }]);
  // ... after which it is writing again with no Turn on.
  r = await migrateFrom({ settingsVersion: 4, sentenceMode: true, sentenceModeApply: true, ollamaModel: "m",
    [S.QUALIFICATION_KEY]: QUAL() });
  check("[v5] ...and writes once it has passed, with no second Turn on", S.sentenceModeState(r.s, ON),
    { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });
  r = await migrateFrom({ settingsVersion: 4, sentenceMode: true, sentenceModeApply: false, ollamaModel: "m" });
  check("[v5] a SUGGESTION user goes off, waiting for Turn on", [r.store.sentenceMode, S.sentenceModeState(r.s, ON)],
    [false, { activated: false, siteDisabled: false, allowed: false, reason: "switched-off", apply: false }]);
  r = await migrateFrom({ settingsVersion: 4, sentenceMode: true, ollamaModel: "m" });
  check("[v5] ...and so does one whose apply bit was never stored", r.store.sentenceMode, false);
  r = await migrateFrom({ settingsVersion: 4, sentenceMode: false, sentenceModeApply: true, ollamaModel: "m" });
  check("[v5] an apply bit under a mode that was off grants nothing", r.store.sentenceMode, false);
  r = await migrateFrom({ settingsVersion: 4, sentenceMode: "true", sentenceModeApply: 1, ollamaModel: "m" });
  check("[v5] strict: garbage that looks truthy is not a consent", r.store.sentenceMode, false);
  // The separate sentence model folds into the one model setting.
  // No model is carried across: the model is pinned in code (step 3b), and
  // both model keys are legacy.
  r = await migrateFrom({ settingsVersion: 4, sentenceMode: false, ollamaModel: "qwen3.5:9b",
    sentenceModel: " proofer-pilot-q4:v1 " });
  check("[v5] neither stored model key survives",
    ["ollamaModel", "sentenceModel"].filter((k) => k in r.store), []);
  check("[v5] every legacy key is removed after the stamp",
    Object.keys(r.store).filter((k) => S.LEGACY_SETTINGS_KEYS.includes(k)), []);
  check("[v5] and the version is current", r.store.settingsVersion, S.SETTINGS_VERSION);

  // The historical steps still run, composed in one pass. An install saved
  // under the opt-in model persisted the OLD default (sentenceMode: false)
  // whatever the user thought -- v3 flipped it on -- but its apply bit meant
  // "write on my approved sites, until the grant expires", and v3 reset it.
  // Composed with v5, that install lands OFF: it was a suggestion user.
  r = await migrateFrom({
    settingsVersion: 2, sentenceMode: false, sentenceModeApply: true,
    sentenceModeSites: ["https://x.com"], sentenceModeExpiry: Date.now() + DAY, sentenceModeDays: 7,
    ollamaUrl: "http://localhost:11500",
  });
  check("[v2->v5] an opt-in-era grant does not become a write consent",
    [r.store.sentenceMode, S.sentenceModeState(r.s, ON).allowed], [false, false]);
  check("[v2->v5] unrelated settings are kept", r.store.ollamaUrl, "http://localhost:11500");
  check("[v2->v5] the allowlist and expiry are removed",
    ["sentenceModeSites", "sentenceModeExpiry", "sentenceModeDays", "sentenceModeApply"].filter((k) => k in r.store), []);
  // A v3 install that granted silent writes AFTER v3 (a deliberate tick under
  // the on-by-default model) is an automatic user, and v4's "materialise the
  // old default" keeps its mode on for v5 to read.
  r = await migrateFrom({ settingsVersion: 3, sentenceModeApply: true, ollamaUrl: "http://localhost:11434" });
  check("[v3->v5] a post-v3 write grant stays on", r.store.sentenceMode, true);
  r = await migrateFrom({ settingsVersion: 3, ollamaUrl: "http://localhost:11434" });
  check("[v3->v5] ...and one that only ever suggested goes off", r.store.sentenceMode, false);
  // A pre-v2 install walks every step in one pass.
  r = await migrateFrom({ fixAllHotkey: { ctrl: true, shift: true, key: "p" }, ltEnabled: true });
  check("[v1->v5] a pre-v2 install lands current, off, with its dead keys gone",
    [r.store.settingsVersion, r.store.sentenceMode, ["fixAllHotkey", "ltEnabled", "rewriteHotkey"].filter((k) => k in r.store)],
    [S.SETTINGS_VERSION, false, []]);

  // A FRESH install has no markers at all and is stamped current without
  // running history (v3 turned the mode on, which is exactly wrong for it).
  r = await migrateFrom({});
  check("[fresh] stamped current, off, nothing else written",
    [r.store, S.sentenceModeState(r.s, ON).allowed],
    [{ settingsVersion: S.SETTINGS_VERSION }, false]);

  // Fired through the REGISTERED LISTENER, not by calling migrateSettings()
  // directly: only this proves the extension actually runs it on install.
  reset();
  store = { settingsVersion: 4, sentenceMode: true, sentenceModeApply: true, ollamaModel: "m" };
  check("background.js registered the install hook", installed.length, 1);
  await installed[0]();
  await new Promise((res) => setTimeout(res, 0));
  check("[hook] the install event runs v5", [store.settingsVersion, store.sentenceMode],
    [S.SETTINGS_VERSION, true]);
  // ONCE. A choice made after the migration survives every later
  // onInstalled -- and every extension reload fires one.
  await S.setSentenceMode(false);
  await S.migrateSettings();
  check("[hook] a post-migration off survives the next install event", store.sentenceMode, false);
}

console.log("\nThe v5 migration fails CLOSED at every persistence boundary:");
{
  const SUGGESTION_USER = { settingsVersion: 4, sentenceMode: true, sentenceModeApply: false,
    sentenceModel: "pilot", ollamaModel: "qwen" };
  const AUTOMATIC_USER = { settingsVersion: 4, sentenceMode: true, sentenceModeApply: true, ollamaModel: "qwen" };
  const sender = { tab: { url: "https://x.com/a" }, url: "https://x.com/a" };

  // [F1] The one write is REJECTED. Nothing may be served from the stored v4
  // shape, whose `sentenceMode: true` is a SUGGESTION consent -- under the old
  // swallow-and-serve behaviour this user would have been writing silently.
  reset();
  store = JSON.parse(JSON.stringify(SUGGESTION_USER));
  failSets = 1;
  let threw = false;
  try { await S.migrateSettings(); } catch { threw = true; }
  failSets = 0;
  check("[F1] a rejected write fails the migration and writes nothing",
    [threw, store.settingsVersion, store.sentenceModeApply], [true, 4, false]);
  let s = await S.getSettings();
  check("[F1] ...and the worker refuses consent from the unmigrated state",
    [s.migrated, S.sentenceModeState(s, "https://x.com")], [false, { activated: false, siteDisabled: false, allowed: false, reason: "upgrading", apply: false }]);
  const consent = await send({ type: "SENTENCE_CONSENT" }, sender);
  check("[F1] ...through the real SENTENCE_CONSENT handler", consent && consent.allowed, false);
  check("[F1] ...and refuses a warmup", S.sentenceWarmupDecision(s, "https://x.com", Date.now()).reason, "not-allowed");
  // Turn on is refused too, rather than written over a schema nothing can
  // read. setSettings retries the migration first, so make that fail again.
  failSets = 1;
  let turnOn = null;
  try { turnOn = await S.setSentenceMode(true); } catch (e) { turnOn = e.message; }
  failSets = 0;
  check("[F1] ...and refuses Turn on while unmigrated",
    [typeof turnOn === "string" && /upgraded/.test(turnOn), store.settingsVersion], [true, 4]);
  // Re-running once storage works gives the right answer from the untouched
  // original -- the failed attempt left nothing behind to confuse it.
  await S.migrateSettings();
  s = await S.getSettings();
  check("[F1] re-run: the suggestion user lands off, the model keys gone",
    [store.settingsVersion, store.sentenceMode, "ollamaModel" in store, S.sentenceModeState(s, "https://x.com").allowed],
    [S.SETTINGS_VERSION, false, false, false]);

  // [F2] The worker is killed BETWEEN the stamp and the cleanup. The legacy
  // keys survive, but the stamp and the new consent are one atomic write, so
  // the runtime is already right -- and the next run finishes the cleanup.
  // This is why the cleanup comes after the stamp: removing sentenceModeApply
  // first, then dying, would make the re-run read a missing apply bit and drop
  // an automatic user's consent.
  reset();
  store = { ...JSON.parse(JSON.stringify(AUTOMATIC_USER)), [S.QUALIFICATION_KEY]: QUAL() };
  failRemoves = 1;
  threw = false;
  try { await S.migrateSettings(); } catch { threw = true; }
  failRemoves = 0;
  check("[F2] killed after the stamp: stamped, consent kept, legacy keys still there",
    [threw, store.settingsVersion, store.sentenceMode, "sentenceModeApply" in store],
    [true, S.SETTINGS_VERSION, true, true]);
  s = await S.getSettings();
  check("[F2] ...and the runtime already reads the new state",
    S.sentenceModeState(s, "https://x.com"), { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true });
  await S.migrateSettings();
  check("[F2] the next run finishes the cleanup and changes nothing else",
    [store.sentenceMode, Object.keys(store).filter((k) => S.LEGACY_SETTINGS_KEYS.includes(k))], [true, []]);
  // And a re-run on a fully migrated install is a no-op.
  const before = JSON.stringify(store);
  await S.migrateSettings();
  check("[F2] re-running on a current install changes nothing", JSON.stringify(store), before);

  // [F3] The same, for a SUGGESTION user killed between stamp and cleanup:
  // the leftover `sentenceModeApply: false` must not be re-read by anything
  // that could turn the stamped `false` back into a consent.
  reset();
  store = JSON.parse(JSON.stringify(SUGGESTION_USER));
  failRemoves = 1;
  try { await S.migrateSettings(); } catch {}
  failRemoves = 0;
  await S.migrateSettings();
  check("[F3] a suggestion user killed mid-migration still lands off",
    [store.settingsVersion, store.sentenceMode, "sentenceModeApply" in store], [S.SETTINGS_VERSION, false, false]);

  // [F5] The write is rejected for an AUTOMATIC user. Nothing may have been
  // removed before the stamp: if the cleanup ran first, the retry would read a
  // missing apply bit and switch off someone who was writing.
  reset();
  store = JSON.parse(JSON.stringify(AUTOMATIC_USER));
  failSets = 1;
  try { await S.migrateSettings(); } catch {}
  failSets = 0;
  check("[F5] a rejected write removes nothing", "sentenceModeApply" in store, true);
  await S.migrateSettings();
  check("[F5] ...so the retry keeps an automatic user on",
    [store.settingsVersion, store.sentenceMode], [S.SETTINGS_VERSION, true]);

  // [F4] A concurrent SET_SETTINGS during the migration. The deferred storage
  // stub is what makes this reproducible: a synchronous stub serializes the
  // two by accident. A stale popup's save -- including one still carrying the
  // removed apply bit -- must not leave a suggestion user with write consent,
  // nor undo the stamp.
  // A save carrying a consent key is refused whole (see [F7]), so settle
  // rather than require both to succeed.
  for (const save of [{ recordAll: false }, { sentenceModeApply: true }, { sentenceModel: "x" },
    { sentenceMode: true, sentenceModeApply: false }]) {
    reset();
    store = JSON.parse(JSON.stringify(SUGGESTION_USER));
    storageDelay = 1;
    await Promise.allSettled([S.setSettings(save), S.migrateSettings()]);
    storageDelay = 0;
    s = await S.getSettings();
    check(`[F4] a racing save ${JSON.stringify(save)} cannot make a suggestion user write`,
      [store.settingsVersion, store.sentenceMode, S.sentenceModeState(s, "https://x.com").allowed],
      [S.SETTINGS_VERSION, false, false]);
  }
  // ...and in the other order, the save issued first.
  reset();
  store = JSON.parse(JSON.stringify(AUTOMATIC_USER));
  storageDelay = 1;
  {
    const saving = S.setSettings({ recordAll: false });
    const migrating = S.migrateSettings();
    await Promise.all([saving, migrating]);
  }
  storageDelay = 0;
  check("[F4] a save racing an automatic user's migration keeps them on, and lands",
    [store.settingsVersion, store.sentenceMode, store.recordAll], [S.SETTINGS_VERSION, true, false]);
  // A save racing a FRESH install cannot turn the mode on (a write that lands
  // first materialises every default and must not make the install read as
  // configured -- v3 used to switch it on from there).
  reset();
  store = {};
  storageDelay = 1;
  {
    const saving = S.setSettings({ recordAll: false });
    const migrating = S.migrateSettings();
    await Promise.all([saving, migrating]);
  }
  storageDelay = 0;
  check("[F4] a save racing a FRESH install cannot turn the mode on",
    [(await S.getSettings()).sentenceMode, store.recordAll], [false, false]);
  // The whole-object write never carries the schema flags back.
  check("[F4] a settings write never stores `migrated`", "migrated" in store, false);

  // [F6] An unrelated Save after a FAILED migration (checkpoint 1, finding 2).
  // A v3 install that was writing automatically and never stored
  // `sentenceMode` -- the state v4's "materialise the old default" step exists
  // for. The migration fails, then a Save arrives (its own migration retry
  // fails too). Writing the Save would put today's default `sentenceMode:
  // false` into the v3 schema, and the retried migration would read that as a
  // choice and switch the user off. So no write is served until v5 is stored.
  reset();
  store = { settingsVersion: 3, sentenceModeApply: true, ollamaUrl: "http://localhost:11434" };
  failSets = 1;
  try { await S.migrateSettings(); } catch {}
  failSets = 1;
  let saved = null;
  try { saved = await S.setSettings({ recordAll: false }); } catch (e) { saved = e.message; }
  failSets = 0;
  check("[F6] an unrelated Save after a failed migration is refused and writes nothing",
    [saved, "sentenceMode" in store, "recordAll" in store, store.settingsVersion],
    [S.SETTINGS_UPGRADING, false, false, 3]);
  await S.migrateSettings();
  check("[F6] ...so the retried migration keeps the automatic user on",
    [store.settingsVersion, store.sentenceMode], [S.SETTINGS_VERSION, true]);
  // Turn off is refused the same way (the worker refuses consent from the
  // unmigrated state regardless, so nothing writes meanwhile).
  reset();
  store = JSON.parse(JSON.stringify(AUTOMATIC_USER));
  failSets = 2;
  let off = null;
  try { await S.migrateSettings(); } catch {}
  try { off = await S.setSentenceMode(false); } catch (e) { off = e.message; }
  failSets = 0;
  check("[F6] Turn off is refused while unmigrated too", [off, store.sentenceMode], [S.SETTINGS_UPGRADING, true]);
}

// [F10] Failed migration is not activation, even with a valid speed check.
// Mutant: delete getSettings' final sentenceMode = ...activated assignment.
// Red: both [F10] effective-mode assertions (the raw legacy true leaks out).
for (const automatic of [false, true]) {
  reset();
  store = { settingsVersion: 4, sentenceMode: true, sentenceModeApply: automatic,
    [S.QUALIFICATION_KEY]: QUAL() };
  failSets = 1;
  try { await S.migrateSettings(); } catch {}
  const reply = await send({ type: "GET_SETTINGS", tabId: 1 });
  const setup = await send({ type: "SETUP_STATUS" }, SETUP);
  check(`[F10] ${automatic ? "automatic" : "suggestion"}: effective mode is off`,
    [reply.settings.sentenceMode, reply.settings.migrated, reply.settings.qualified], [false, false, true]);
  const denied = { activated: false, siteDisabled: false, allowed: false, reason: "upgrading", apply: false };
  check("[F10] settings and setup expose upgrading, not activation", [reply.consent, setup.consent], [denied, denied]);
  check("[F10] the raw migration inputs are unchanged",
    [store.sentenceMode, store.sentenceModeApply, store.settingsVersion], [true, automatic, 4]);
  await S.migrateSettings();
  const retried = await send({ type: "GET_SETTINGS" });
  check("[F10] retry preserves only automatic consent",
    [retried.settings.sentenceMode, retried.consent.activated, store.settingsVersion,
      "sentenceModeApply" in store], [automatic, automatic, 5, false]);
}

// [F11] Settings reads and successful writes carry the worker's page decision.
// Mutant: settingsReply passes null instead of topOrigin to sentenceModeState.
// Red: [F11] allowed/site-disabled literal decisions and projection comparisons.
{
  tabs = new Map([[1, { url: "https://x.com/path" }], [2, {}], [3, { url: "chrome://extensions" }]]);
  const cases = [
    ["allowed", {}, 1, { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true }],
    ["globally off", { sentenceMode: false }, 1,
      { activated: false, siteDisabled: false, allowed: false, reason: "switched-off", apply: false }],
    ["unqualified", { [S.QUALIFICATION_KEY]: QUAL({ stale: "ollama-updated" }) }, 1,
      { activated: true, siteDisabled: false, allowed: false, reason: "qualification-required", apply: false }],
    ["site disabled", { sentenceModeDisabledSites: ["https://x.com"] }, 1,
      { activated: true, siteDisabled: true, allowed: false, reason: "site-disabled", apply: false }],
    ["legacy site disabled", { disabledSites: ["https://x.com"] }, 1,
      { activated: true, siteDisabled: true, allowed: false, reason: "site-disabled", apply: false }],
    ["off with site membership", { sentenceMode: false, disabledSites: ["https://x.com"] }, 1,
      { activated: false, siteDisabled: true, allowed: false, reason: "switched-off", apply: false }],
    ...[["missing tab", undefined], ["closed tab", 99], ["unreadable tab", 2], ["non-web tab", 3]].map(([label, id]) =>
      [label, {}, id, { activated: true, siteDisabled: false, allowed: false, reason: "no-http-page", apply: false }]),
  ];
  for (const [label, over, tabId, want] of cases) {
    store = { settingsVersion: 5, sentenceMode: true, [S.QUALIFICATION_KEY]: QUAL(), ...over };
    for (const msg of [{ type: "GET_SETTINGS" }, { type: "SET_SETTINGS", settings: { recordAll: false } },
      // Turning ON is deliberately refused without qualification; its refusal
      // is pinned in [F7]. Other cases can preserve their bit through this path.
      ...(label === "unqualified" ? [] : [{ type: "SET_SENTENCE_MODE", on: store.sentenceMode }])]) {
      const r = await send({ ...msg, tabId });
      check(`[F11] ${label} ${msg.type}: literal page decision`, [r.ok, r.consent], [true, want]);
      check(`[F11] ${label} ${msg.type}: agrees with the canonical projection`, r.consent,
        S.sentenceModeState(r.settings, tabId === 1 ? "https://x.com" : tabId === 3 ? "null" : null));
      check(`[F11] ${label} ${msg.type}: the pin travels and consent is not stored`,
        [r.pinnedModel.tag, "consent" in store], ["jayafowler/proofer:v1-q4", false]);
    }
  }
  store = { settingsVersion: 5, sentenceMode: true, [S.QUALIFICATION_KEY]: QUAL({ stale: "ollama-updated" }) };
  const turnedOff = await send({ type: "SET_SENTENCE_MODE", on: false, tabId: 1 });
  check("[F11] unqualified Turn off succeeds with the new decision", [turnedOff.ok, turnedOff.consent],
    [true, { activated: false, siteDisabled: false, allowed: false, reason: "switched-off", apply: false }]);
  store = { settingsVersion: 5, sentenceMode: true, [S.QUALIFICATION_KEY]: QUAL(), disabledSites: ["https://x.com"] };
  check("[F11] a content sender cannot claim a different tab for settings",
    await send({ type: "GET_SETTINGS", tabId: 1 }, CONTENT), { ok: false, error: "not-allowed" });
  const r = await send({ type: "SENTENCE_CONSENT", tabId: 99, origin: "https://allowed.com" }, CONTENT);
  check("[F11] content consent still uses sender identity", [r.allowed, r.reason], [false, "site-disabled"]);
  tabs = new Map();
}

console.log("\nThe write consent has one way in, and only the extension's own pages reach it:");
{
  const ON_X = "https://x.com";
  const consentAt = async () => (await send({ type: "SENTENCE_CONSENT" }, CONTENT)).allowed;
  // [F7] A generic settings write carrying the consent bit, or the v4 apply
  // bit, is refused whole (checkpoint 1, finding 1): under v5 `sentenceMode:
  // true` means WRITE, and in a v4-shaped payload it meant "suggest".
  reset();
  await S.migrateSettings();
  let r = await send({ type: "SET_SETTINGS", settings: { sentenceMode: true } });
  check("[F7] SET_SETTINGS carrying sentenceMode is refused",
    [r.ok, r.error, store.sentenceMode === true, await consentAt()],
    [false, S.SETTINGS_CONSENT_ELSEWHERE, false, false]);
  r = await send({ type: "SET_SETTINGS", settings: { sentenceMode: true, sentenceModeApply: false, recordAll: false } });
  check("[F7] ...and so is a v4-shaped payload, whole (its other keys are not applied)",
    [r.ok, store.sentenceMode === true, "recordAll" in store], [false, false, false]);
  // The stale v4 snapshot before, during and after a suggestion user's
  // migration: none of them ends with write consent.
  const SUGGESTION_USER = { settingsVersion: 4, sentenceMode: true, sentenceModeApply: false, ollamaModel: "q" };
  const V4_SAVE = { sentenceMode: true, sentenceModeApply: false, recordAll: true };
  for (const when of ["before", "during", "after"]) {
    reset();
    store = JSON.parse(JSON.stringify(SUGGESTION_USER));
    if (when === "after") await S.migrateSettings();
    storageDelay = when === "during" ? 1 : 0;
    const saving = send({ type: "SET_SETTINGS", settings: V4_SAVE });
    const migrating = when === "during" ? S.migrateSettings() : Promise.resolve();
    await Promise.allSettled([saving, migrating]);
    storageDelay = 0;
    await S.migrateSettings();
    check(`[F7] a stale v4 Save ${when} the migration leaves a suggestion user off`,
      [store.settingsVersion, store.sentenceMode, await consentAt()], [S.SETTINGS_VERSION, false, false]);
  }
  // SET_SENTENCE_MODE from the popup is the way in -- after a passing speed
  // check, and not before.
  reset();
  await S.migrateSettings();
  r = await send({ type: "SET_SENTENCE_MODE", on: true });
  check("[F7] Turn on without a passing speed check is refused, and says why",
    [r.ok, r.error, store.sentenceMode === true], [false, S.SETTINGS_NOT_QUALIFIED, false]);
  store[S.QUALIFICATION_KEY] = QUAL();
  r = await send({ type: "SET_SENTENCE_MODE", on: true });
  check("[F7] SET_SENTENCE_MODE from the popup turns it on",
    [r.ok, r.settings && r.settings.sentenceMode, await consentAt()], [true, true, true]);
  r = await send({ type: "SET_SENTENCE_MODE", on: "yes" });
  check("[F7] a non-boolean `on` changes nothing", [r.ok, r.error, store.sentenceMode], [false, "bad-request", true]);
  r = await send({ type: "SET_SENTENCE_MODE", on: false });
  check("[F7] ...and off", [r.ok, store.sentenceMode, await consentAt()], [true, false, false]);

  // [F8] From a content script -- the page's renderer -- every popup-only
  // message is refused, including the consent and the log's text.
  reset();
  await S.migrateSettings();
  seedSentenceRing([{ id: "sn_secret", input: "My private sentance.", output: "My private sentence.",
    verdict: "sentence-applied", origin: ON_X }]);
  r = await send({ type: "SET_SENTENCE_MODE", on: true }, CONTENT);
  check("[F8] SET_SENTENCE_MODE from a content script is refused",
    [r.ok, r.error, store.sentenceMode === true, await consentAt()], [false, "not-allowed", false, false]);
  for (const type of S.PAGE_ONLY_MESSAGES) {
    const before = JSON.stringify(store);
    r = await send({ type, settings: { recordAll: false }, on: true }, CONTENT);
    check(`[F8] ${type} from a content script is refused and changes nothing`,
      [r && r.ok, r && r.error, JSON.stringify(store) === before, JSON.stringify(r).includes("sentance")],
      [false, "not-allowed", true, false]);
  }
  // A sender claiming this extension's id with a page URL is still a page.
  r = await send({ type: "GET_RECENT_SENTENCES" }, { id: "proofertestid", url: "https://evil.example/popup.html" });
  check("[F8] a page URL is not an extension page, whatever the id", r.error, "not-allowed");
  r = await send({ type: "GET_RECENT_SENTENCES" });
  check("[F8] ...while the popup still reads Recent changes", r.ok === true && JSON.stringify(r).includes("sentance"), true);

  // [F9] Both directions, against what each file actually sends: nothing
  // content.js sends may be refused (it would break the product), and
  // everything the popup sends to the worker must be (a new popup message
  // left ungated is a new way for a page to reach the user's text).
  const typesIn = (file) => [...new Set([...readFileSync(join(__dirname, "..", file), "utf8")
    .matchAll(/type:\s*"([A-Z_]+)"/g)].map((m) => m[1]))];
  const contentTypes = typesIn("content.js");
  const popupTypes = typesIn("popup.js").filter((t) => t !== "SENTENCE_STATUS"); // to tabs, not the worker
  check("[F9] content.js sends messages at all (the extraction found them)", contentTypes.length >= 5, true);
  check("[F9] nothing content.js sends is page-only",
    contentTypes.filter((t) => S.PAGE_ONLY_MESSAGES.includes(t)), []);
  check("[F9] everything the popup sends the worker is page-only",
    popupTypes.filter((t) => !S.PAGE_ONLY_MESSAGES.includes(t)), []);
}

console.log("\nGET_LOG_STATS separates outcomes without moving the keep rate:");
{
  reset();
  // One record of every sentence outcome the system can record. Literal
  // expected counts below -- a breakdown asserted against a formula would pass
  // on the formula being wrong in both places.
  seedSentenceRing([
    { verdict: "sentence-applied" },
    { verdict: "sentence-applied" },
    { verdict: "sentence-applied-unverified" },
    { verdict: "sentence-suggestion-applied" },
    { verdict: "sentence-suggested" },
    { verdict: "sentence-dismissed" },
    { verdict: "sentence-undone" },
    { verdict: "sentence-edited" },
    { verdict: "user-reverted" },
    { verdict: "user-edited-correction" },
    { verdict: "sentence-reconciled" },
    { verdict: "sentence-not-durable" },
    // Production-shaped: a no-change record carries `noChanges: true` and NO
    // verdict. Nothing has emitted `sentence-no-change` for a long time -- it
    // is a legacy allowlist entry -- and seeding it here hid a breakdown that
    // counted the verdict and therefore read 0 on every real record.
    { noChanges: true },
    { verdict: "sentence-skipped:anchor:stale-age" },
    { verdict: "sentence-skipped:anchor:stale-age" },
    { verdict: "sentence-skipped:blocked" },
    { guard: "word-substituted:carpet" },
    // A verdict this build does not know about. It exists so the partition can
    // be shown to REPORT the unclassified rather than absorb it -- which is
    // what an `other` computed as a remainder does, while still adding up
    // perfectly. The day a new outcome is added and nobody classifies it, this
    // is the assertion that says so.
    { verdict: "sentence-outcome-from-the-future" },
    // The two remaining `other` categories. Without them the partition's
    // detail assertions are green against a build that folds errors into
    // `unclassified` -- the fixture simply never produces one, which is the
    // "interesting case where the bug cannot reach it" pattern.
    { error: "timeout" },
    {},
  ]);
  const r = await send({ type: "GET_LOG_STATS" });
  const b = r.sentence.breakdown;
  check("a silent write is counted as one", b.appliedSilently, 2);
  check("an unverified landing is its own category", b.appliedUnverified, 1);
  // Suggestion mode was removed on 2026-09-24. Its three verdicts in old
  // records are LEGACY: not automatic corrections, not rejections of one,
  // and not unclassified.
  check("suggestion mode's verdicts are legacy, one count", b.legacySuggestion, 3);
  check("...and the breakdown no longer has an acceptance or an offer",
    ["acceptedSuggestion", "offered"].filter((k) => k in b), []);
  check("every rejection of an automatic correction lands in `rejected`", b.rejected, 4);
  check("a write the editor took back is lost, not rejected", b.lost, 2);
  check("a no-change is neither", b.noChange, 1);
  check("recorded delivery drops are grouped by reason",
    b.deliverySkipped, { "anchor:stale-age": 2, blocked: 1 });

  // The half that makes this an ADDITION rather than a redefinition: the
  // popup renders `applied + reverted` as its denominator and `keepRate` as
  // the number that decides whether the feature ships. Both must be exactly
  // what they were before the breakdown existed.
  // The keep rate describes AUTOMATIC corrections: 3 kept (2 silent + 1
  // unverified) against 4 rejected. A legacy acceptance or dismissal answered a
  // different question and is in neither half.
  check("`applied` counts automatic landings only", r.sentence.applied, 3);
  check("`reverted` counts rejections of them", r.sentence.reverted, 4);
  check("`lost` is unchanged", r.sentence.lost, 2);
  check("and the keep rate is 3 of 7", r.sentence.keepRate, 43);

  // ...and the PARTITION the popup's bar is drawn from. A bar is a claim about
  // a whole, so what it is drawn from has to be one -- and `breakdown` is not:
  // it covers neither guard refusals nor errors nor a record whose verdict
  // never arrived, so a bar built from it would silently be a proportion of the
  // wrong denominator.
  const d = r.sentence.distribution, od = r.sentence.otherDetail;
  check("every applied verdict is one green bucket", d.applied, 3);
  check("every rejection shape is one red bucket", d.rejected, 4);
  check("a transport loss is its own bucket", d.lost, 2);
  check("a guard refusal has a bucket at all, which the breakdown never gave it",
    d.guarded, 1);
  check("a no-op is its own bucket", d.noChange, 1);
  check("and everything else is `other`", d.other, 9);
  // THE assertion. The literal record count, not a number the worker also
  // computed from the same buckets -- sum === somethingTheWorkerReported would
  // pass against a partition of its own invention.
  check("the six buckets account for all 20 seeded records",
    d.noChange + d.guarded + d.applied + d.rejected + d.lost + d.other, 20);
  check("...and 20 is what the ring actually holds", r.sentence.count, 20);
  // The literal, not the worker's own report of it.
  check("the sentence log keeps 5,000 records", r.sentence.cap, 5000);
  check("...which is the ring's own cap", vm.runInContext("LOG_RINGS.sentence.cap", ctx), 5000);
  // `other` is a SUM OF NAMED PARTS, never a remainder. A remainder is how an
  // outcome nobody classified vanishes into a bucket that still adds up: the
  // bar keeps partitioning perfectly while hiding a whole new failure mode.
  check("`other` is broken out into named parts",
    od.legacySuggestion + od.deliverySkipped + od.errored + od.unresolved + od.unclassified,
    d.other);
  check("legacy suggestion outcomes are one of them, not unclassified", od.legacySuggestion, 3);
  check("and so are the recorded delivery drops", od.deliverySkipped, 3);
  check("an errored record is its own detail, not folded into unclassified",
    od.errored, 1);
  check("a record whose verdict never arrived is its own detail too",
    od.unresolved, 1);
  check("an unrecognised verdict is REPORTED as unclassified, not absorbed",
    od.unclassified, 1);

  // A field refusing every scan sends nothing, so it has no records at all and
  // its whole diagnosis lives in the separate counter map. The two populations
  // have different denominators and must never be summed.
  reset();
  store[Object.keys(store).length ? "" : "sentenceSkips"] = undefined;
  delete store[""];
  store.sentenceSkips = { "no-transport": 40, composing: 3 };
  const quiet = await send({ type: "GET_LOG_STATS" });
  check("a field that refuses every scan has no sentence records",
    quiet.sentence.count, 0);
  check("its reasons are still reported, from the counter map",
    quiet.sentence.skips, { "no-transport": 40, composing: 3 });
  check("and the record-derived breakdown stays empty rather than borrowing them",
    quiet.sentence.breakdown.deliverySkipped, {});
}

console.log("\nClear is authoritative, and nothing begun before it writes after it:");
{
  const sender = { tab: { url: "https://example.com/a" }, url: "https://example.com/a" };
  const flush = () => vm.runInContext("logQueue", ctx);
  // [C1] A sentence request in flight survives Clear -- the defect this fixes.
  // Its record is written when the response completes, so without a Clear
  // generation the text lands AFTER the user was told it was gone.
  reset();
  store = { settingsVersion: S.SETTINGS_VERSION, ollamaUrl: "http://localhost:11434", ollamaModel: "m",
    sentenceMode: true, recordAll: true , [S.QUALIFICATION_KEY]: QUAL() };
  let release;
  fetchImpl = (url) => String(url).includes("/api/chat")
    ? new Promise((res) => { release = () => res({ ok: true, status: 200,
        json: async () => ({ message: { content: JSON.stringify({ rewritten: "This sentence is wrong." }) },
          done_reason: "stop" }) }); })
    : diskFetch(url);
  const pending = send({ type: "SENTENCE_REWRITE", requestId: "sn_clearrace",
    sentence: "This sentance is wrong.", trigger: "idle" }, sender);
  await new Promise((r) => setTimeout(r, 20));
  await send({ type: "CLEAR_LOG" });
  release();
  await pending;
  await flush();
  check("[C1] a sentence in flight at Clear writes nothing after it",
    Object.keys(store).filter((k) => k.startsWith("slog:")), []);
  check("[C1] ...and the export is empty",
    (await send({ type: "EXPORT_LOG" })).records.filter((r) => r.id === "sn_clearrace").length, 0);
  // The control: the same request with no Clear in between IS recorded, so
  // the check above is about the generation and not about recording at all.
  fetchImpl = (url) => String(url).includes("/api/chat")
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({
        message: { content: JSON.stringify({ rewritten: "This sentence is wrong." }) }, done_reason: "stop" }) })
    : diskFetch(url);
  await send({ type: "SENTENCE_REWRITE", requestId: "sn_after_clear",
    sentence: "This sentance is wrong.", trigger: "idle" }, sender);
  await flush();
  const rec = store["slog:sn_after_clear"];
  check("[C1] ...while one begun after it is recorded", !!rec, true);
  // Every record says which prompt answered it.
  check("[C1] the record carries its prompt revision",
    rec && rec.promptRevision, vm.runInContext("PROMPT_REVISION", ctx));
  check("[C1] ...and the generation itself is not stored", rec && "generation" in rec, false);

  // [C2] Legacy-only storage: records from the removed manual path. The
  // product's stats no longer count them, so the popup's old "is there
  // anything to clear" read them as nothing.
  reset();
  store.plogIndex = ["rw_1"];
  store["plog:rw_1"] = { id: "rw_1", path: "plain", input: "OLD MANUAL TEXT" };
  let st = await send({ type: "GET_LOG_STATS" });
  check("[C2] legacy manual records are counted", st.legacyManual, 1);
  check("[C2] ...and Clear knows there is something to remove",
    [st.clearable.any, st.clearable.records, st.clearable.legacy], [true, 1, 1]);
  check("[C2] ...and Export still carries them until Clear",
    (await send({ type: "EXPORT_LOG" })).records.map((r) => r.id), ["rw_1"]);
  // Mixed old/new rings retain stored versions byte for byte. Mutant:
  // readLogRecords maps every row to {...r, v: LOG_VERSION}; this equality fails.
  const old = { v: 1, id: "sn_old_schema", path: "sentence", input: "OLD SENTENCE TEXT", ts: 1 };
  const modern = { ...rec, id: "sn_new_schema", ts: 2 };
  seedSentenceRing([old, modern]);
  const mixedBefore = JSON.stringify([store["plog:rw_1"], store["slog:sn_old_schema"], store["slog:sn_new_schema"]]);
  const mixed = (await send({ type: "EXPORT_LOG" })).records;
  check("[C2] mixed export retains legacy manual and old/new sentence rows",
    JSON.stringify(mixed), mixedBefore);
  check("[C2] a new handler record uses v2 while the old sentence keeps v1",
    [mixed[1]?.v, mixed[2]?.v, mixed[2]?.dispatched, mixed[2]?.attempts?.length], [1, 2, true, 1]);
  await send({ type: "CLEAR_LOG" });
  check("[C2] Clear removes them", Object.keys(store).filter((k) => k.startsWith("plog")), []);

  // [C3] Orphaned keys: a record no index names (an interrupted write).
  reset();
  store["slog:orphan"] = { id: "orphan", path: "sentence", input: "ORPHANED TEXT" };
  st = await send({ type: "GET_LOG_STATS" });
  check("[C3] an orphaned record is invisible to the stats", st.sentence.count, 0);
  check("[C3] ...but not to Clear", [st.clearable.any, st.clearable.records], [true, 1]);
  await send({ type: "CLEAR_LOG" });
  check("[C3] and Clear removes it", "slog:orphan" in store, false);

  // [C4] Telemetry only: text-free, but stored, and Clear sweeps it.
  reset();
  store["wlog:events"] = [{ v: 1, path: "warmup", id: "w1" }];
  store.sentenceSkips = { busy: 2 };
  st = await send({ type: "GET_LOG_STATS" });
  check("[C4] telemetry alone is still clearable",
    [st.clearable.any, st.clearable.records, st.clearable.telemetry], [true, 0, 2]);
  // [C5] Truly empty.
  reset();
  st = await send({ type: "GET_LOG_STATS" });
  check("[C5] an empty store has nothing to clear", st.clearable, { any: false, records: 0, legacy: 0, telemetry: 0 });

  // [C6] Early eviction is recorded, reported, and cleared. A quota-rejected
  // write evicts the oldest tenth before the count cap is reached, and the
  // count alone would never say so.
  reset();
  seedSentenceRing([{ id: "old1" }, { id: "old2" }, { id: "old3" }]);
  failSets = 1;
  await vm.runInContext("writeLogRecord", ctx)({ id: "sn_new", path: "sentence", ts: 9 });
  failSets = 0;
  st = await send({ type: "GET_LOG_STATS" });
  check("[C6] a quota eviction is recorded and reported",
    [!!st.evictions, st.evictions && st.evictions.count > 0, "slog:sn_new" in store], [true, true, true]);
  await send({ type: "CLEAR_LOG" });
  check("[C6] ...and Clear takes the record of it too", "logEvictions" in store, false);
  check("[C6] a log that never evicted reports none", (await send({ type: "GET_LOG_STATS" })).evictions, null);

  // [C7] A FAILED write says so too (checkpoint 1, 2026-09-25). The notice
  // used to be written only after a successful replacement, so a retry that
  // failed had deleted the oldest records and reported nothing.
  const record = (id) => vm.runInContext("recordInteraction", ctx)({ id, origin: "https://x.com", path: "sentence" });
  const settle = () => vm.runInContext("logQueue", ctx);
  // The in-memory count lives as long as the worker, so each case starts
  // from a Clear, not only from an empty store.
  const fresh = async () => { reset(); await send({ type: "CLEAR_LOG" }); };
  // (a) first write refused, the notice lands, the replacement is refused.
  await fresh();
  seedSentenceRing([{ id: "old1" }, { id: "old2" }, { id: "old3" }]);
  failPattern = [true, false, true];
  record("sn_a");
  await settle();
  failPattern = [];
  st = await send({ type: "GET_LOG_STATS" });
  check("[C7a] a failed retry still reports the eviction and the failure, and drops the dropped ids",
    [!!st.evictions, !!st.writeFailures, "slog:sn_a" in store, "slog:old1" in store, store.slogIndex.includes("old1")],
    [true, true, false, false, false]);
  // (b) the notice write is refused and the replacement lands: it carries
  // the notice itself.
  await fresh();
  seedSentenceRing([{ id: "old1" }, { id: "old2" }]);
  failPattern = [true, true, false];
  record("sn_b");
  await settle();
  failPattern = [];
  st = await send({ type: "GET_LOG_STATS" });
  check("[C7b] the replacement carries the notice when the notice write was refused",
    [!!st.evictions, st.writeFailures, "slog:sn_b" in store], [true, null, true]);
  // (c) a refused write with nothing to evict.
  await fresh();
  failSets = 1;
  record("sn_c");
  await settle();
  failSets = 0;
  st = await send({ type: "GET_LOG_STATS" });
  check("[C7c] a refused write with nothing to evict is reported",
    [st.evictions, st.writeFailures && st.writeFailures.count, "slog:sn_c" in store], [null, 1, false]);
  // (d) storage refuses EVERYTHING, the failure count included: the worker
  // still knows, for its own lifetime.
  failSets = 10;
  record("sn_d");
  await settle();
  failSets = 0;
  st = await send({ type: "GET_LOG_STATS" });
  check("[C7d] with storage refusing even the failure count, the worker still reports it",
    st.writeFailures && st.writeFailures.count >= 2, true);
  // (e) a verdict that cannot be attached counts too.
  await fresh();
  seedSentenceRing([{ id: "sn_e" }]);
  failSets = 1;
  vm.runInContext("updateLogRecord", ctx)("sn_e", { verdict: "sentence-applied" });
  await settle();
  failSets = 0;
  st = await send({ type: "GET_LOG_STATS" });
  check("[C7e] a verdict that could not be written is reported", !!st.writeFailures, true);
  // (f) Clear takes both, stored and in memory.
  await send({ type: "CLEAR_LOG" });
  st = await send({ type: "GET_LOG_STATS" });
  check("[C7f] Clear takes the failure record, stored and in memory",
    ["logWriteFailures" in store, st.writeFailures, st.evictions], [false, null, null]);
}

// [C8a] Mutant: records: records.length in EXPORT_LOG counts; indexed counts go red.
console.log("\n[C8a] Export counts its indexed interaction inputs:");
{
  reset();
  const sentences = [
    { id: "sn_c8_1", path: "sentence", ts: 2, v: 1, input: "First sentence." },
    { id: "sn_c8_2", path: "sentence", ts: 4, v: 2, input: "Second sentence." },
  ];
  const legacy = { v: 1, id: "rw_c8", ts: 1, input: "Legacy manual text." };
  const warmups = [
    { v: 1, id: "w_c8_1", path: "warmup", ts: 3 },
    { v: 1, id: "w_c8_2", path: "warmup", ts: 5 },
  ];
  seedSentenceRing(sentences);
  store.plogIndex = [legacy.id];
  store["plog:rw_c8"] = legacy;
  store["wlog:events"] = warmups;
  store.sentenceSkips = { busy: 7, "not-sentence": 2 };
  store["slog:orphan_c8"] = { id: "orphan_c8", input: "Orphaned prose." };
  const out = await send({ type: "EXPORT_LOG" });
  check("[C8a] counts use indexed interactions, not merged rows or Clear", out.counts,
    { records: 3, warmups: 2, skips: 1 });
  check("[C8a] chronological rows preserve both schemas and pathless legacy text",
    out.records.slice(0, 5), [legacy, sentences[0], warmups[0], sentences[1], warmups[1]]);
  check("[C8a] six rows end with the unchanged skip map",
    [out.records.length, out.records[5]?.v, out.records[5]?.path, out.records[5]?.skips],
    [6, 1, "skips", { busy: 7, "not-sentence": 2 }]);
  check("[C8a] Clear also counts orphaned prose", (await send({ type: "GET_LOG_STATS" })).clearable.records, 4);
}

// [C8b] Mutants: records: interactions.length + warmups.length makes warmup-only
// counts red; skips: Object.values(skips).reduce((a, b) => a + b, 0) makes
// skip-only counts red (a diagnostic row is not the sum of its counters).
console.log("\n[C8b] Diagnostics and empty storage have zero interactions:");
{
  reset();
  const warmup = { v: 1, id: "w_c8_only", path: "warmup", ts: 1 };
  store["wlog:events"] = [warmup];
  let out = await send({ type: "EXPORT_LOG" });
  check("[C8b] warmup-only counts", out.counts, { records: 0, warmups: 1, skips: 0 });
  check("[C8b] warmup-only rows survive", out.records, [warmup]);
  reset();
  store.sentenceSkips = { busy: 7, "not-sentence": 2 };
  out = await send({ type: "EXPORT_LOG" });
  check("[C8b] skip-only counts one diagnostic row", out.counts, { records: 0, warmups: 0, skips: 1 });
  check("[C8b] skip-only row preserves counters",
    [out.records.length, out.records[0]?.v, out.records[0]?.path, out.records[0]?.skips],
    [1, 1, "skips", { busy: 7, "not-sentence": 2 }]);
  reset();
  out = await send({ type: "EXPORT_LOG" });
  check("[C8b] empty counts", out.counts, { records: 0, warmups: 0, skips: 0 });
  check("[C8b] empty rows", out.records, []);
}

console.log("\nEXPORT_LOG carries the skip counters as one trailing row:");
{
  // A field that refuses every scan has no records at all -- its whole
  // diagnosis lives in the counter map, which the popup rendered and the export
  // omitted. Every "why is it not correcting" diagnosis run against an export
  // had to work around that (2026-09-09), so the map now rides along as ONE row.
  reset();
  seedSentenceRing([
    { id: "a", verdict: "sentence-applied", input: "teh cat", output: "the cat" },
  ]);
  store.sentenceSkips = { "reconciled-async": 4, "field:ok:Slate": 9,
    "field:unsupported-editor:unknown-editor": 2 };
  const out = (await send({ type: "EXPORT_LOG" })).records;
  const skipRows = out.filter((r) => r.path === "skips");
  check("exactly one skips row", skipRows.length, 1);
  check("and it is the LAST row, so consumers that stop at records are unaffected",
    out[out.length - 1].path, "skips");
  check("it carries the stored map verbatim",
    skipRows[0].skips,
    { "reconciled-async": 4, "field:ok:Slate": 9, "field:unsupported-editor:unknown-editor": 2 });
  check("a reason and never a text or an origin: no record fields on it",
    ["input", "output", "origin", "context", "id"].filter((k) => k in skipRows[0]), []);
  check("the interaction records are untouched beside it",
    out.filter((r) => r.path === "sentence").length, 1);
  // Empty map, no row -- an empty log has to read as empty to the popup's
  // "Nothing recorded yet" and to every tool that counts rows.
  reset();
  store.sentenceSkips = {};
  check("an empty counter map adds no row",
    (await send({ type: "EXPORT_LOG" })).records.filter((r) => r.path === "skips").length, 0);
  // And Clear takes it with the rest: the row is a view of the stored key, and
  // clearLog sweeps that key.
  reset();
  store.sentenceSkips = { "reconciled-async": 4 };
  await send({ type: "CLEAR_LOG" });
  check("Clear removes the counters from the export too",
    (await send({ type: "EXPORT_LOG" })).records.filter((r) => r.path === "skips").length, 0);
}

console.log("\nGET_RECENT_SENTENCES is a receipt for what reached the field:");
{
  reset();
  seedSentenceRing([
    // Delivered. All of these changed the user's text and belong in a receipt.
    { id: "a", verdict: "sentence-applied", input: "teh cat", output: "the cat" },
    { id: "b", verdict: "sentence-applied-unverified", input: "recieve", output: "receive" },
    { id: "c", verdict: "sentence-suggestion-applied", input: "seperate", output: "separate" },
    { id: "d", verdict: "sentence-undone", input: "anyways", output: "anyway" },
    { id: "e", verdict: "user-reverted", input: "thing", output: "things" },
    { id: "f", verdict: "sentence-not-durable", input: "wich", output: "which" },
    // Excluded, one per class -- and every one of them has input !== output,
    // which is exactly why eligibility cannot be decided on that.
    { id: "g", guard: "word-substituted:slat", input: "the salt", output: "the slat" },
    { id: "h", verdict: "sentence-suggested", input: "definately", output: "definitely" },
    { id: "i", verdict: "sentence-dismissed", input: "alot", output: "a lot" },
    { id: "j", verdict: "sentence-skipped:anchor:stale-age", input: "occured", output: "occurred" },
    { id: "k", verdict: "sentence-no-change", input: "fine", output: "fine", noChanges: true },
    { id: "l", input: "in flight", output: "in flight, still" },
  ]);
  const r = await send({ type: "GET_RECENT_SENTENCES" });
  const ids = r.rows.map((x) => x.id).sort();
  check("only corrections that reached the field are listed",
    ids, ["a", "b", "c", "d", "e", "f"]);
  check("a guard refusal is NOT a receipt -- its `output` is the text that was REFUSED",
    r.rows.some((x) => x.id === "g"), false);
  check("neither is an offer that was never applied",
    r.rows.some((x) => x.id === "h" || x.id === "i"), false);
  check("nor a result dropped before the write", r.rows.some((x) => x.id === "j"), false);
  check("nor a request still in flight", r.rows.some((x) => x.id === "l"), false);
  check("newest first", r.rows[0].id, "f");
  check("each row says what became of it", r.rows.find((x) => x.id === "d").outcome,
    "you undid this");
  check("an undone correction is still shown -- it is the one most worth explaining",
    r.rows.some((x) => x.id === "d"), true);
  // Only the receipt's own fields cross into the popup.
  check("the payload carries nothing but the receipt",
    Object.keys(r.rows[0]).sort(), ["id", "input", "origin", "outcome", "output", "ts"]);

  // Filter BEFORE the cap, or a run of refusals hides every real change.
  //
  // The real change is seeded FIRST, so it is the OLDEST and sits behind all
  // forty refusals in newest-first order. That ordering is the whole test: with
  // it at the newest end (where this fixture had it first time round) a
  // cap-then-filter implementation keeps it anyway and the case passes while
  // proving nothing -- caught by mutating the worker and watching this stay
  // green.
  reset();
  const many = [{ id: "real", verdict: "sentence-applied", input: "teh", output: "the" }];
  for (let i = 0; i < 40; i++) many.push({ id: "x" + i, guard: "low-overlap", input: "a", output: "b" });
  seedSentenceRing(many);
  const capped = await send({ type: "GET_RECENT_SENTENCES" });
  check("forty refusals do not push the one real change off the list",
    capped.rows.map((x) => x.id), ["real"]);

  // The cap is enforced worker-side so a rendering bug cannot pull the ring.
  reset();
  seedSentenceRing(Array.from({ length: 60 }, (_, i) =>
    ({ id: "r" + i, verdict: "sentence-applied", input: "teh", output: "the" })));
  const big = await send({ type: "GET_RECENT_SENTENCES" });
  // A LITERAL 20, not `big.cap`. Asserting the response against the number the
  // same response reported is the implementation being its own oracle: raising
  // RECENT_CAP to 60 kept every check in this file green.
  check("the cap is enforced in the worker, not in the popup", big.rows.length, 20);
  check("and the worker reports the cap it actually applied", big.cap, 20);

  // Clearing is the user's guarantee their text is gone. It has to hold for
  // this view too, and CLEAR_LOG sweeps by prefix rather than by index.
  reset();
  seedSentenceRing([{ id: "z", verdict: "sentence-applied", input: "teh", output: "the" }]);
  check("there is something to clear", (await send({ type: "GET_RECENT_SENTENCES" })).rows.length, 1);
  await send({ type: "CLEAR_LOG" });
  check("and after CLEAR_LOG the receipts are gone",
    (await send({ type: "GET_RECENT_SENTENCES" })).rows, []);

  // Markup-shaped prose is returned as DATA. The popup renders with text nodes;
  // this asserts the worker does not "helpfully" alter it, so what the
  // rendering pin is written against is what actually arrives.
  reset();
  const nasty = '<img src=x onerror="alert(1)"> & <b>bold</b>';
  seedSentenceRing([{ id: "m", verdict: "sentence-applied", input: nasty, output: nasty + "." }]);
  const raw = await send({ type: "GET_RECENT_SENTENCES" });
  check("markup-shaped prose is passed through unchanged, as data", raw.rows[0].input, nasty);
}

// Ported from the REWRITE handler's pin when the manual path went (2026-09-24).
// The sentence handler never APPLIES the sanitizer -- it asks whether the
// sanitizer WOULD change the model's answer and refuses if so -- and that
// question has to be asked by the handler, not merely be answerable by the
// helper. Driven through the real SENTENCE_REWRITE handler.
console.log("\nThe SENTENCE_REWRITE handler refuses what the sanitizer would have to repair:");
{
  const sender = { tab: { url: "https://example.com/a" }, url: "https://example.com/a" };
  reset();
  store = { settingsVersion: S.SETTINGS_VERSION, ollamaUrl: "http://localhost:11434", ollamaModel: "m",
    disabledSites: [], sentenceMode: true, sentenceModeApply: true , [S.QUALIFICATION_KEY]: QUAL() };
  scriptOllama(JSON.stringify({ rewritten: "<rewritten>The cat sat on the mat.</rewritten>" }));
  const r = await send({ type: "SENTENCE_REWRITE", requestId: "sn_wrap",
    sentence: "The cat sat on teh mat.", trigger: "idle" }, sender);
  check("a hallucinated wrapper is refused, not cleaned and written",
    [r && r.rewritten, r && String(r.refused || "").split(":")[0]], [undefined, "sanitizer-would-change"]);
  // The control, so this is not "every answer is refused": the same correction
  // without the wrapper is delivered.
  reset();
  store = { settingsVersion: S.SETTINGS_VERSION, ollamaUrl: "http://localhost:11434", ollamaModel: "m",
    disabledSites: [], sentenceMode: true, sentenceModeApply: true , [S.QUALIFICATION_KEY]: QUAL() };
  scriptOllama(JSON.stringify({ rewritten: "The cat sat on the mat." }));
  const r2 = await send({ type: "SENTENCE_REWRITE", requestId: "sn_plain",
    sentence: "The cat sat on teh mat.", trigger: "idle" }, sender);
  check("...while the same correction unwrapped is delivered", r2 && r2.rewritten, "The cat sat on the mat.");
}

// Ported from interaction-test.mjs [26] when the manual path went (2026-09-24):
// an Ollama failure reaches the content script as a CODE, never as Ollama's own
// text. The content script turns the code into a `worker:<code>` skip reason the
// popup renders, so a raw body -- which can carry a model name or JSON -- would
// otherwise travel from Ollama to extension UI.
console.log("\nOllama's own error text never reaches the content script:");
{
  const sender = { tab: { url: "https://example.com/a" }, url: "https://example.com/a" };
  const RAW = 'model "proofer-bogus-model:1b" not found, try pulling it first {"error":1}';
  const cases = [
    ["an HTTP 404", async (url) => String(url).includes("/api/chat")
      ? { ok: false, status: 404, text: async () => RAW, json: async () => ({ error: RAW }) }
      : diskFetch(url)],
    ["a 200 carrying an error", async (url) => String(url).includes("/api/chat")
      ? { ok: true, status: 200, json: async () => ({ error: RAW }), text: async () => JSON.stringify({ error: RAW }) }
      : diskFetch(url)],
  ];
  for (const [label, impl] of cases) {
    reset();
    store = { settingsVersion: S.SETTINGS_VERSION, ollamaUrl: "http://localhost:11434",
      ollamaModel: "proofer-bogus-model:1b", disabledSites: [], sentenceMode: true, sentenceModeApply: true , [S.QUALIFICATION_KEY]: QUAL() };
    fetchImpl = impl;
    const r = await send({ type: "SENTENCE_REWRITE", requestId: "sn_err_" + label.length,
      sentence: "This sentance is wrong.", trigger: "idle" }, sender);
    const wire = JSON.stringify(r || {});
    check(`${label}: answered with a code`, [r && r.ok, /^(http-\d+|ollama-error)$/.test(String(r && r.error))], [false, true]);
    check(`${label}: no model name, no raw body`, [wire.includes("bogus"), wire.includes("try pulling"), wire.includes("{\"error")], [false, false, false]);
  }
}

// Actual warmup messages: the helper checks above cannot prove a load is sent.
console.log("\nSENTENCE_WARMUP dispatch, completion, overlap and bounded telemetry:");
{
  const sender = { tab: { url: "https://example.com/a" }, url: "https://example.com/a" };
  const ping = { type: "SENTENCE_WARMUP", sentence: "NEVER STORE THIS",
    priorContext: "NEVER STORE THIS", pageContext: { title: "NEVER STORE THIS" } };
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vm.runInContext("logQueue", ctx);
  };
  const rows = async () => (await send({ type: "EXPORT_LOG" })).records.filter((r) => r.path === "warmup");
  const configure = () => {
    reset();
    warmNow = 1000;
    store = { settingsVersion: S.SETTINGS_VERSION, ollamaUrl: "http://localhost:11434",
      ollamaModel: "sentence-m", sentenceMode: true, recordAll: true , [S.QUALIFICATION_KEY]: QUAL() };
    S.noteOllamaRequest(4096, "manual-m");
  };
  configure();
  let calls = [], headers, body;
  fetchImpl = (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), signal: opts.signal });
    warmSignals.push(opts.signal || null);
    return new Promise((resolve) => { headers = resolve; });
  };
  storageDelay = 40;
  warmSignals = [];
  const ack = await send(ping, sender);
  check("[W1] acknowledgement precedes even the settings read", [ack, calls.length], [{ ok: true }, 0]);
  storageDelay = 0;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await flush();
  // The warmup's own 15s timeout is what stops a hung load holding VRAM, and it
  // works by aborting a controller the fetch has to be listening to. Asserting
  // the outcome would mean waiting 15s of real time; asserting that the signal
  // reached the transport gates the same mutation in milliseconds. Dropping
  // `signal: ac.signal` from the warmup fetch left every other check here green.
  check("[W2b] the warmup fetch is given the abort signal",
    warmSignals.length === 1 && warmSignals[0] !== null && "aborted" in warmSignals[0], true);
  check("[W2] the handler sends the sentence runner's pure load",
    calls.map((c) => [c.url, c.body.model, c.body.options.num_ctx, c.body.messages, c.body.keep_alive]),
    [["http://localhost:11434/api/chat", S.PINNED_MODEL.tag, 2048, [], "20s"]]);
  let row = (await rows())[0];
  check("[W3] the dispatched decision is exported before completion",
    [row?.reason, row?.decisionAt, row?.dispatchedAt, row?.completedAt, row?.outcome],
    ["wrong-model", 1000, 1000, null, "pending"]);

  warmNow = 1100;
  headers?.({ ok: true, status: 200, json: () => new Promise((resolve) => { body = resolve; }) });
  await flush();
  row = (await rows())[0];
  check("[W4] headers alone do not complete the load", [row?.completedAt, row?.outcome], [null, "pending"]);
  warmNow = 1150;
  // A REAL sentence, not an empty one. An empty sentence exits the rewrite
  // handler before a record exists, so the sentence-side half of the overlap --
  // the warmup ids written onto the interaction record, which is what
  // log-latency.mjs correlates -- was never reached and "omit warmupIds from
  // the record" was a mutation this suite stayed green on.
  scriptOllama(JSON.stringify({ rewritten: "We received the invoice." }));
  await send({ type: "SENTENCE_REWRITE", requestId: "sn_overlap",
    sentence: "We recieved the invoice.", trigger: "idle" }, sender);
  await flush();
  check("[W5] arrival during BODY loading is recorded", (await rows())[0]?.sentenceDuringLoad, true);
  {
    const rec = Object.values(store).find((v) => v && v.id === "sn_overlap");
    check("[W5b] ...and the sentence record names the warmup it overlapped",
      [Array.isArray(rec?.warmupIds), rec?.warmupIds?.[0] === (await rows())[0]?.id],
      [true, true]);
  }
  // Restore the deferred-body warmup transport for the rest of the sequence.
  fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return new Promise((resolve) => { headers = resolve; });
  };

  warmNow = 1200;
  body?.({ done_reason: "load", message: { content: "NEVER STORE THIS" } });
  await flush();
  row = (await rows())[0];
  check("[W6] only the consumed load acknowledgement reports loaded",
    [row?.completedAt, row?.outcome], [1200, "loaded"]);
  check("[W6b] ...and a truthy body that is NOT one does not",
    await (async () => {
      // Same shape, no load acknowledgement. "the JSON parsed" is not "the
      // model loaded", and without this the whole done_reason test is
      // decoration: every fixture above hands back a valid acknowledgement.
      S.noteOllamaRequest(4096, "manual-m");
      fetchImpl = async () => ({ ok: true, json: async () => ({ done_reason: "stop" }) });
      await send(ping, sender);
      await flush();
      const bad = (await rows()).at(-1);
      S.noteOllamaRequest(4096, "manual-m");
      fetchImpl = async () => ({ ok: true, json: async () => ({ error: "no such model" }) });
      await send(ping, sender);
      await flush();
      return [bad?.outcome, (await rows()).at(-1)?.outcome];
    })(),
    ["bad-response", "bad-response"]);
  row = (await rows()).find((r) => r.outcome === "loaded");
  check("[W15] telemetry carries the actual runner identity and lease",
    [row?.model, row?.numCtx, row?.keepAliveMs], [S.PINNED_MODEL.tag, 2048, 20000]);
  check("[W7] the export has a closed, text-free schema",
    [Object.keys(row || {}).sort(), JSON.stringify(row || {}).includes("NEVER STORE THIS")],
    [["completedAt", "decisionAt", "dispatchedAt", "id", "keepAliveMs", "model",
      "numCtx", "outcome", "path", "reason", "sentenceDuringLoad", "ts", "v"], false]);

  // Make a second load complete WITHOUT an overlapping arrival.
  S.noteOllamaRequest(4096, "manual-m");
  fetchImpl = async () => ({ ok: true, json: async () => ({ done_reason: "load" }) });
  await send(ping, sender);
  await flush();
  await send({ type: "SENTENCE_REWRITE", requestId: "sn_after", sentence: "" }, sender);
  await flush();
  check("[W8] a completed warmup is removed from the in-flight set",
    (await rows()).at(-1)?.sentenceDuringLoad, false);

  // A body failure proves nothing about runner residency, even with HTTP 200.
  S.noteOllamaRequest(4096, "manual-m");
  fetchImpl = async () => ({ ok: true, json: async () => { throw new Error("NEVER STORE THIS"); } });
  await send(ping, sender);
  await flush();
  row = (await rows()).at(-1);
  check("[W9] body failure forgets the runner and records only a fixed outcome",
    [row?.outcome, S.sentenceWarmupDecision(await S.getSettings(), "https://example.com", warmNow).reason],
    ["failed", "wrong-model"]);

  configure();
  calls = [];
  fetchImpl = async (...args) => { calls.push(args); return { ok: true, json: async () => ({ done_reason: "load" }) }; };
  store.sentenceMode = false;
  await send(ping, sender);
  await flush();
  check("[W10] revoked consent reaches the handler's no-fetch branch",
    [calls.length, (await rows())[0]?.reason], [0, "not-allowed"]);
  store.sentenceMode = true;
  calls = [];
  S.noteOllamaRequest(2048, S.PINNED_MODEL.tag);
  await send(ping, sender);
  await flush();
  check("[W11] a hot decision is recorded without dispatch",
    [calls.length, (await rows()).at(-1)?.reason], [0, "hot"]);

  // Drive the cap through the handler, with the oldest item beyond the cap.
  store.plogIndex = ["manual"];
  store["plog:manual"] = { id: "manual", path: "manual" };
  seedSentenceRing([{ id: "sentence" }]);
  for (let i = 0; i < 260; i++) {
    warmNow++;
    await send(ping, sender);
  }
  await flush();
  const bounded = await rows();
  check("[W12] warmups have their own literal 256-row storage bound",
    [bounded.length, bounded[0]?.ts, store.plogIndex, store.slogIndex],
    [256, 1005, ["manual"], ["sentence"]]);

  store.recordAll = false;
  await send(ping, sender);
  await flush();
  check("[W13] recording off writes no warmup", (await rows()).map((r) => r.id), bounded.map((r) => r.id));

  configure();
  fetchImpl = () => new Promise((resolve) => { headers = resolve; });
  await send(ping, sender);
  await flush();
  store["wlog:orphan"] = { stray: true };
  await send({ type: "CLEAR_LOG" });
  headers?.({ ok: true, json: async () => ({ done_reason: "load" }) });
  await flush();
  check("[W14] Clear sweeps the prefix and a late completion cannot restore it",
    Object.keys(store).filter((k) => k.startsWith("wlog:")), []);
  warmNow = null;
}

// --- The Origin rule ------------------------------------
console.log("\nThe Origin rule: one rule, scoped to Proofer, following the configured URL:");
{
  reset();
  await new Promise((r) => setTimeout(r, 20));
  await vm.runInContext("ensureOriginRule", ctx)("http://localhost:11434");
  check("exactly one dynamic rule", dnrRules.length, 1);
  const r = dnrRules[0];
  check("it SETS Origin to the Ollama origin, which Ollama's default allowlist holds",
    r.action, { type: "modifyHeaders",
      requestHeaders: [{ header: "Origin", operation: "set", value: "http://localhost:11434" }] });
  // The scope is the safety argument: without initiatorDomains, a web page's
  // request to the same port would be rewritten too and a site could reach
  // the user's model. Only this extension's own requests are touched.
  check("scoped to this extension's own requests",
    r.condition.initiatorDomains, ["proofertestid"]);
  check("...and to the Ollama origin only", r.condition.urlFilter, "|http://localhost:11434/");
  check("...for fetch, never navigation", r.condition.resourceTypes, ["xmlhttprequest", "other"]);
  // A new URL is a new rule, installed by the settings write itself.
  store = { settingsVersion: S.SETTINGS_VERSION };
  await S.setSettings({ ollamaUrl: "http://127.0.0.1:11500" });
  await new Promise((r) => setTimeout(r, 20));      // the write starts it; nothing else asks
  check("a changed URL replaces the rule rather than adding a second",
    [dnrRules.length, dnrRules[0].action.requestHeaders[0].value, dnrRules[0].condition.urlFilter],
    [1, "http://127.0.0.1:11500", "|http://127.0.0.1:11500/"]);
  // Memoized: the per-request await costs nothing once the rule is in.
  const before = dnrUpdates;
  await vm.runInContext("ensureOriginRule", ctx)("http://127.0.0.1:11500");
  check("asking again for the same URL does not rewrite the rule", dnrUpdates, before);
  // And a sentence request waits for it: the POST must not go out first.
  const sender = { tab: { url: "https://example.com/a" }, url: "https://example.com/a" };
  store = { settingsVersion: S.SETTINGS_VERSION, ollamaUrl: "http://127.0.0.1:11600",
    ollamaModel: "m", sentenceMode: true, recordAll: false , [S.QUALIFICATION_KEY]: QUAL({ ollamaUrl: "http://127.0.0.1:11600" }) };
  let ruleAtPost = null;
  fetchImpl = (url) => {
    if (!String(url).includes("/api/chat")) return diskFetch(url);
    ruleAtPost = dnrRules[0] && dnrRules[0].condition.urlFilter;
    return Promise.resolve({ ok: true, status: 200,
      json: async () => ({ message: { content: JSON.stringify({ rewritten: "This sentence is wrong." }) }, done_reason: "stop" }) });
  };
  await send({ type: "SENTENCE_REWRITE", requestId: "sn_rule", sentence: "This sentance is wrong.", trigger: "idle" }, sender);
  check("a sentence POST goes out only once the rule names its URL", ruleAtPost, "|http://127.0.0.1:11600/");

  // Two URL changes in quick succession, the FIRST update held until the
  // second has had every chance to finish (checkpoint 3: memoized but not
  // serialized, the late first update left the rule on the old URL while the
  // cached promise said the new one was ready -- a 403 on every request).
  const ensure = vm.runInContext("ensureOriginRule", ctx);
  let releaseA;
  const heldA = new Promise((r) => { releaseA = r; });
  dnrHold = (add) => (add[0] && add[0].condition.urlFilter === "|http://127.0.0.1:11701/" ? heldA : null);
  const pA = ensure("http://127.0.0.1:11701");
  const pB = ensure("http://127.0.0.1:11702");
  let bSettled = false;
  pB.then(() => { bSettled = true; });
  await new Promise((r) => setTimeout(r, 20));
  check("the second URL's update waits for the first (nothing reported ready early)", bSettled, false);
  releaseA();
  const [ra, rb] = await Promise.all([pA, pB]);
  check("...then both apply in order, and the rule that stays is the LAST URL's",
    [ra, rb, dnrRules.length, dnrRules[0].condition.urlFilter], [true, true, 1, "|http://127.0.0.1:11702/"]);
  dnrHold = null;
  // An update accepted and not applied is not "ready".
  dnrDrop = true;
  const dropped = await ensure("http://127.0.0.1:11703");
  dnrDrop = false;
  check("an update that did not take resolves false, and is asked again next time",
    [dropped, await ensure("http://127.0.0.1:11703"), dnrRules[0].condition.urlFilter], [false, true, "|http://127.0.0.1:11703/"]);
}

// --- Every message type answers ------------------------------------------
//
// Ported from interaction-test.mjs [35] when the manual path went (2026-09-24),
// and moved offline: a listener that neither calls sendResponse nor returns
// true makes Chrome hand the caller "The message port closed before a response
// was received" -- one console error per use, which is how this was first
// found, in a real Discord session. `send` resolves undefined for exactly that
// case and rejects for a handler that returned true and never answered.
//
// The list of types is READ FROM background.js, so a handler added without a
// row here fails rather than going untested.
console.log("\nEvery message type the worker handles answers its caller:");
{
  const sender = { tab: { url: "https://example.com/a" }, url: "https://example.com/a" };
  const PAYLOADS = {
    CANCEL_REWRITE: { requestId: "sn_probe" },
    SENTENCE_CONSENT: {},
    SENTENCE_SKIPS: { counts: { busy: 1 } },
    SENTENCE_WARMUP: {},
    SENTENCE_REWRITE: { requestId: "sn_probe2", sentence: "This sentance is wrong.", trigger: "idle" },
    CHECK_HEALTH: {},
    GET_SETTINGS: {},
    SET_SETTINGS: { settings: { recordAll: true } },
    SET_SENTENCE_MODE: { on: false },
    SETUP_READY: {}, SETUP_STATUS: {}, SETUP_VERIFY: {}, SETUP_BEGIN: {}, SETUP_STEP: { runId: "none" },
    SETUP_PING: { runId: "none" }, SETUP_REPORT: {},
    REWRITE_OUTCOME: { requestId: "sn_probe2", verdict: "sentence-applied" },
    GET_LOG_STATS: {},
    GET_RECENT_SENTENCES: {},
    EXPORT_LOG: {},
    CLEAR_LOG: {},
  };
  const bg = readFileSync(join(__dirname, "..", "background.js"), "utf8");
  const handled = [...new Set([...bg.matchAll(/msg\.type === "([A-Z_]+)"/g)].map((m) => m[1]))];
  check("every handled message type has a probe here",
    handled.filter((t) => !(t in PAYLOADS)), []);
  reset();
  store = { settingsVersion: S.SETTINGS_VERSION, sentenceMode: true, sentenceModeApply: true,
    ollamaUrl: "http://localhost:11434", ollamaModel: "m" , [S.QUALIFICATION_KEY]: QUAL() };
  fetchImpl = async (url) => {
    const u = String(url);
    if (!/\/api\//.test(u)) return diskFetch(u);
    const body = u.includes("/api/version") ? { version: "0.0.0" }
      : u.includes("/api/tags") ? { models: [] }
      : { message: { content: JSON.stringify({ rewritten: "This sentence is wrong." }) }, done_reason: "load" };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  for (const type of handled) {
    let r, err = null;
    // Each from the sender that really sends it, so the page-only ones reach
    // their handler rather than the sender gate.
    const from = /^SETUP_/.test(type) ? SETUP : S.PAGE_ONLY_MESSAGES.includes(type) ? POPUP : sender;
    try { r = await send({ type, ...(PAYLOADS[type] || {}) }, from); }
    catch (e) { err = e.message; }
    check(`${type} answers`, err ? err : r === undefined ? "closed the port without answering" : "answered", "answered");
  }
}

console.log("\n" + "=".repeat(72));
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`All ${pass} checks passed.`);
