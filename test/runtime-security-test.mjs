#!/usr/bin/env node
// Production worker/content scripts in a disposable Chrome profile, a fake
// loopback Ollama, and dummy prose only. No installed model or real site used.
// The copied welcome.js is inert so installation cannot start real onboarding.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { chromePath } from "./lib/chrome.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-runtime-security-"));
const extension = path.join(dir, "extension");
execFileSync(process.execPath, [path.join(root, "tools/package.mjs"), "--out", extension], { stdio: "ignore" });
fs.writeFileSync(path.join(extension, "welcome.js"), "// Onboarding is outside this disposable security test.\n");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await pause(25); }
  throw new Error(`Timed out: ${label}`);
}
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
let pin, childOrigin;
const chats = [];
const serve = async (req, res) => {
  if (req.url === "/api/version") { res.setHeader("Content-Type", "application/json"); res.end('{"version":"0.35.0"}'); return; }
  if (req.url === "/api/tags") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ models: pin ? [{ name: pin.tag, digest: pin.digest }] : [] })); return; }
  if (req.url === "/api/chat") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); chats.push(body);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body.messages?.length ? {
      message: { content: '{"rewritten":"The technician arrived early."}' }, done_reason: "stop",
    } : { done_reason: "load" })); return;
  }
  if (req.url?.startsWith("/api/")) { res.writeHead(503); res.end("unused fake API"); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><body><textarea id="ta" style="width:500px;height:100px"></textarea>${req.url === "/editor" ? `<iframe src="${childOrigin}/child" style="width:550px;height:150px"></iframe>` : ""}</body></html>`);
};
const server = http.createServer(serve), childServer = http.createServer(serve);
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => childServer.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  childOrigin = `http://127.0.0.1:${childServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), userDataDir: path.join(dir, "profile"),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--disable-gpu", "--no-first-run",
      // CI runs this loopback-only fixture as namespace root under unshare -rn;
      // its network namespace enforces offline execution. Normal user runs
      // retain Chromium's sandbox. No remote page or real model is loaded.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
  const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
  const worker = await target.worker();
  const extensionOrigin = `chrome-extension://${new URL(target.url()).host}`;
  await until(() => worker.evaluate(() => typeof getSettings === "function"), "worker initialization");
  await worker.evaluate(() => getSettings());
  pin = await worker.evaluate(() => ({ ...PINNED_MODEL }));
  for (const p of await browser.pages()) if (p.url().endsWith("/welcome.html")) await p.close();
  const seed = () => worker.evaluate(async (url) => {
    await storageSet({ settingsVersion: SETTINGS_VERSION, ollamaUrl: url, sentenceMode: true,
      disabledSites: [], sentenceModeDisabledSites: [], sentenceDebug: false, recordAll: true,
      setupQualification: { pass: true, category: "pass", ollamaUrl: url, ollamaVersion: "0.35.0",
        tag: PINNED_MODEL.tag, digest: PINNED_MODEL.digest, promptRevision: PROMPT_REVISION,
        benchmarkRevision: SETUP_BENCHMARK_REVISION, options: { num_thread: null } } });
  }, origin);
  await seed();
  async function openPage(route) {
    const page = await browser.newPage(), client = await page.createCDPSession(), contexts = [];
    client.on("Runtime.executionContextCreated", ({ context }) => { if (context.origin === extensionOrigin) contexts.push(context); });
    await client.send("Runtime.enable");
    await page.goto(`${origin}${route}`, { waitUntil: "networkidle0" });
    await until(() => contexts.length >= (route === "/editor" ? 2 : 1), "isolated content contexts");
    const evaluate = async (context, expression) => {
      const r = await client.send("Runtime.evaluate", { contextId: context.id, expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    const located = await Promise.all(contexts.map(async (context) => ({ context, pathname: await evaluate(context, "location.pathname") })));
    const main = located.find((c) => c.pathname === route).context;
    return { page, evaluate, main, contexts };
  }
  const { page, evaluate, main, contexts } = await openPage("/editor");
  const read = (expression) => evaluate(main, expression);
  await page.click("#ta");
  await page.frames().find((frame) => frame.url() === `${childOrigin}/child`).click("#ta");
  await page.click("#ta");
  const allAllowed = async (wanted) => (await Promise.all(contexts.map((c) => evaluate(c, "globalThis.__prooferSentence.sentenceStatusReport().apply")))).every((v) => v === wanted);
  await until(() => allAllowed(true), "initial top and embedded consent");
  check(await allAllowed(true), "proofreading works in both frames with storage restricted");
  check(await page.evaluate(() => typeof chrome.storage) === "undefined", "ordinary page JavaScript has no extension storage API");

  await read(`globalThis.__securityStorageEvents = []; chrome.storage.onChanged.addListener((changes, area) => {
    globalThis.__securityStorageEvents.push({ changes, area });
  }); true`);
  await worker.evaluate(() => storageSet({ "slog:sn_secret": { input: "SENTINEL_OTHER_SITE_PROSE" } }));
  const blocked = await read(`Promise.all([
    chrome.storage.local.get(null).then(() => false, () => true),
    chrome.storage.local.set({ recordAll: false }).then(() => false, () => true),
    chrome.storage.local.remove('slog:sn_secret').then(() => false, () => true),
    chrome.storage.local.clear().then(() => false, () => true),
    chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'}).then(() => false, () => true)
  ])`);
  check(blocked.every(Boolean), "isolated content scripts cannot read, write, delete or reopen local storage");
  const denied = await read("chrome.runtime.sendMessage({type:'EXPORT_LOG'})");
  check(denied.ok === false && denied.error === "not-allowed", "protected message handlers still reject content senders");
  const secret = await worker.evaluate(() => storageGet("slog:sn_secret"));
  check(secret["slog:sn_secret"].input === "SENTINEL_OTHER_SITE_PROSE", "the trusted worker retains access to its unchanged data");
  await read(`globalThis.__securityNotifications = []; chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'SENTENCE_SETTINGS_CHANGED') globalThis.__securityNotifications.push(m);
  }); true`);

  // A real correction arms the production edit watcher. Turning recording off
  // through the actual popup handler stops new prose reaching the old record.
  await page.keyboard.type("The techncian arrived early. Next", { delay: 15 });
  await until(() => page.$eval("#ta", (el) => el.value.includes("technician")), "the fake model's guarded correction");
  await until(() => worker.evaluate(async () => (await readLogRecords()).some((r) => r.input === "The techncian arrived early.")), "sentence log");
  const record = await worker.evaluate(async () => (await readLogRecords()).find((r) => r.input === "The techncian arrived early."));
  const popup = await browser.newPage();
  await popup.goto(`${extensionOrigin}/popup.html`, { waitUntil: "domcontentloaded" });
  const off = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: { recordAll: false } }));
  check(off.ok && off.settings.recordAll === false, "recording-off succeeds through the extension page");
  await until(() => read("globalThis.__securityNotifications.length > 0"), "recording invalidation");
  await page.bringToFront();
  await page.$eval("#ta", (el) => { el.focus(); el.setSelectionRange(4, 14); });
  await page.keyboard.type("privateword", { delay: 20 });
  await pause(2200); // production feedback settles after two seconds
  const after = await worker.evaluate(async (id) => (await storageGet(`slog:${id}`))[`slog:${id}`], record.id);
  check(after.finalText === record.finalText, "editing after recording-off does not append new text to the prior correction");
  check((await read("globalThis.__securityNotifications")).every((m) => JSON.stringify(m) === '{"type":"SENTENCE_SETTINGS_CHANGED"}'),
    "real tab broadcasts contain no stored values or prose");
  check((await read("globalThis.__securityStorageEvents")).every((event) => event.area !== "local"),
    "local storage events do not expose settings or prose to content scripts");
  await popup.close();

  for (const change of ["global", "sentence-site", "legacy-site", "qualification", "endpoint"]) {
    await seed(); await until(() => allAllowed(true), `restored consent before ${change}`);
    await worker.evaluate(async ({ change, origin }) => {
      if (change === "global") await setSentenceMode(false);
      if (change === "sentence-site") await setSettings({ sentenceModeDisabledSites: [origin] });
      if (change === "legacy-site") await setSettings({ disabledSites: [origin] });
      if (change === "qualification") await storeQualification({ ...(await getSettings()).qualification, stale: "test-revocation" });
      if (change === "endpoint") await setSettings({ ollamaUrl: origin + "/changed" });
    }, { change, origin });
    await until(() => allAllowed(false), `${change} invalidation reaches both frames`);
    check(await allAllowed(false), `${change} revocation reaches top and embedded content without storage events`);
  }

  // Delay an actual allowed consent reply, revoke permission, receive the new
  // refusal, then deliver the obsolete reply last. It must stay refused.
  await seed();
  const delayed = await openPage("/simple");
  const dRead = (expression) => delayed.evaluate(delayed.main, expression);
  await dRead(`globalThis.__securityReplies = []; globalThis.__securityRelease = null;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime); let hold = true;
    chrome.runtime.sendMessage = (m, cb) => original(m, (r) => {
      if (m.type === 'SENTENCE_CONSENT') {
        globalThis.__securityReplies.push(r);
        if (hold) { hold = false; globalThis.__securityRelease = () => cb(r); return; }
      }
      cb(r);
    }); true`);
  await delayed.page.click("#ta");
  await until(() => dRead("typeof globalThis.__securityRelease === 'function'"), "held allowed reply");
  check((await dRead("globalThis.__securityReplies"))[0].allowed === true, "the delayed control reply originally allowed proofreading");
  await worker.evaluate(() => setSentenceMode(false));
  await until(() => dRead("globalThis.__securityReplies.length >= 2"), "new revoked reply");
  await dRead("globalThis.__securityRelease(); true");
  await pause(25);
  check(await dRead("globalThis.__prooferSentence.sentenceStatusReport().apply") === false,
    "a delayed old consent cannot restore permission after revocation");
  check(chats.some((body) => body.messages?.length), "the test exercised a real guarded request to the fake loopback service");
  console.log(`Runtime security: ${checks} checks passed (${await browser.version()}).`);
} finally {
  if (browser) await browser.close();
  await Promise.all([server, childServer].map((s) => new Promise((resolve) => s.close(resolve))));
  fs.rmSync(dir, { recursive: true, force: true });
}
