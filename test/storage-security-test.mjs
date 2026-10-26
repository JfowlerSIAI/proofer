#!/usr/bin/env node
// Worker storage security, without a browser or model. Drives production
// message handlers and holds real storage boundaries to exercise revocation.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const extensionId = "proofer-security-test";
const popup = { id: extensionId, url: `chrome-extension://${extensionId}/popup.html` };
const content = { id: extensionId, url: "https://example.test/editor", frameId: 0,
  tab: { id: 7, url: "https://example.test/editor" } };
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
const turn = () => new Promise((resolve) => setImmediate(resolve));

function worker(restrict) {
  const store = { settingsVersion: 5, recordAll: true };
  const handlers = [], changes = [], messages = [], operations = [], errors = [];
  const chrome = {
    runtime: { id: extensionId, lastError: undefined,
      getURL: (p) => `chrome-extension://${extensionId}/${p}`,
      onMessage: { addListener: (f) => handlers.push(f) }, onInstalled: { addListener() {} } },
    storage: { local: {
      ...(restrict ? { setAccessLevel: (options) => { operations.push(["restrict", options]); return restrict(); } } : {}),
      get: (keys, cb) => {
        operations.push(["get"]);
        const out = keys === null ? { ...store } : {};
        if (Array.isArray(keys)) for (const k of keys) out[k] = store[k];
        else if (keys && typeof keys === "object") for (const [k, fallback] of Object.entries(keys)) out[k] = k in store ? store[k] : fallback;
        else if (typeof keys === "string") out[keys] = store[keys];
        cb(out);
      },
      set: (values, cb) => { operations.push(["set"]); Object.assign(store, values); cb?.(); },
      remove: (keys, cb) => { operations.push(["remove"]); for (const k of keys) delete store[k]; cb?.(); },
    }, onChanged: { addListener: (f) => changes.push(f) } },
    tabs: { create() {}, query: async () => [{ id: 7 }, { id: 8 }],
      sendMessage: async (tabId, message) => {
        messages.push({ tabId, message });
        if (tabId === 8) throw new Error("No content script in this tab");
        return { ok: true };
      } },
  };
  const ctx = vm.createContext({ chrome, URL, AbortController, AbortSignal,
    setTimeout, clearTimeout, crypto: globalThis.crypto, TextEncoder,
    console: { error: (...a) => errors.push(a), warn: (...a) => errors.push(a), log() {} },
    fetch: async () => { throw new Error("This test must not fetch"); },
  });
  vm.runInContext(source, ctx);
  const api = vm.runInContext("({getSettings, setSettings, storageGet, storageSet, drain: () => logQueue, ready: storageAccessReady})", ctx);
  const send = (message, sender = content) => new Promise((resolve) => {
    for (const f of handlers) f(message, sender, resolve);
  });
  return { ctx, chrome, store, api, send, changes, messages, operations, errors };
}

// Restriction must precede even migration/settings reads. Rejected and missing
// APIs never fall back to the browser's content-script-readable default.
for (const mode of ["missing", "rejected"]) {
  const w = worker(mode === "missing" ? null : async () => { throw new Error("restriction rejected"); });
  const consent = await w.send({ type: "SENTENCE_CONSENT" });
  const settings = await w.send({ type: "GET_SETTINGS" }, popup);
  const rewrite = await w.send({ type: "SENTENCE_REWRITE", requestId: "sn_denied", sentence: "A harmless test sentence." });
  await w.api.drain();
  check(consent.allowed === false && settings.ok === false && rewrite.ok === false,
    `${mode} storage restriction refuses consent, settings and processing`);
  check(!w.operations.some(([kind]) => ["get", "set", "remove"].includes(kind)), `${mode} restriction prevents all storage access`);
  check(w.errors.length > 0, `${mode} restriction is diagnosed`);
}
{
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const w = worker(() => barrier);
  let answered = false;
  const pending = w.send({ type: "SENTENCE_CONSENT" }).then((r) => { answered = true; return r; });
  await turn();
  check(!answered && w.operations.length === 1, "a pending restriction holds the first settings read and reply");
  check(w.operations[0][1].accessLevel === "TRUSTED_CONTEXTS", "the access policy excludes content scripts");
  release();
  const reply = await pending;
  check(reply.ok && reply.allowed === false, "initialization resumes only after the restriction succeeds");
  check(Object.keys(reply).sort().join(",") === "activated,allowed,apply,ok,reason,sentenceDebug,siteDisabled",
    "the consent reply exposes only the field's permission and debug flag");
}

const w = worker(async () => {});
await w.api.getSettings();
const id = "sn_privacy", key = `slog:${id}`;
w.store[key] = { id, path: "sentence", origin: content.tab.url, input: "Original test sentence.", finalText: null, verdict: null };
w.store.slogIndex = [id];
const outcome = (text) => w.send({ type: "REWRITE_OUTCOME", requestId: id, verdict: "user-edited-correction", finalText: text });
await outcome("First permitted edit."); await w.api.drain();
check(w.store[key].finalText === "First permitted edit.", "recording-on control saves ordinary edit feedback");
const off = await w.send({ type: "SET_SETTINGS", settings: { recordAll: false } }, popup);
check(off.ok && off.settings.recordAll === false, "the protected settings handler turns recording off");
await outcome("Private text typed after switching off."); await w.api.drain();
check(w.store[key].finalText === "First permitted edit.", "recording off blocks new prose on an existing record");

// Hold an outcome after its permission read but before its record read. The
// recording switch must serialize with it, rather than acknowledge revocation
// while a previously-authorized write is still about to persist.
await w.api.setSettings({ recordAll: true });
const get = w.chrome.storage.local.get;
let releaseRead, reachedRead;
const reached = new Promise((resolve) => { reachedRead = resolve; });
w.chrome.storage.local.get = (keys, cb) => {
  if (keys && Object.hasOwn(keys, key) && !releaseRead) {
    releaseRead = () => get(keys, cb); reachedRead(); return;
  }
  get(keys, cb);
};
await outcome("Edit already in progress before revocation.");
await reached;
let switched = false;
const switching = w.api.setSettings({ recordAll: false }).then(() => { switched = true; });
await turn();
check(!switched && w.store.recordAll === true, "revocation waits for a previously authorized write to finish");
releaseRead(); await switching;
w.chrome.storage.local.get = get;
const atRevocation = JSON.stringify(w.store[key]);
await outcome("Another private edit after the switch completed."); await w.api.drain();
check(JSON.stringify(w.store[key]) === atRevocation, "no queued outcome can append prose after revocation completes");

// A content-free invalidation reaches every tab/frame; raw storage values,
// log records, and changes from unrelated storage areas never ride along.
for (const key of ["sentenceMode", "sentenceModeDisabledSites", "disabledSites", "setupQualification", "ollamaUrl", "sentenceDebug", "recordAll"]) {
  w.messages.length = 0;
  for (const f of w.changes) f({ [key]: { oldValue: "PRIVATE_OLD", newValue: "PRIVATE_NEW" } }, "local");
  await turn();
  check(w.messages.length === 2 && w.messages.every(({ message }) => JSON.stringify(message) === '{"type":"SENTENCE_SETTINGS_CHANGED"}'),
    `${key} broadcasts invalidation without stored values, tolerating tabs without receivers`);
}
w.messages.length = 0;
for (const f of w.changes) { f({ "slog:secret": { newValue: "PRIVATE_PROSE" } }, "local"); f({ sentenceMode: { newValue: false } }, "sync"); }
await turn();
check(w.messages.length === 0, "log changes and other storage areas are not broadcast");

console.log(`Storage security: ${checks} checks passed.`);
