#!/usr/bin/env node
/**
 * Activation: the only place Proofer is turned on, and so the only place the
 * silent-write permission is granted. Puppeteer, no Ollama, no network — the
 * real popup.html and popup.js with a stubbed chrome.*.
 *
 *   cd test && node popup-activation-test.mjs
 *
 * Settings v5 (2026-09-24) has ONE switch: suggestion mode is gone, so "on"
 * means corrections are written into the field. The mode ships off, and one
 * deliberate Turn on is the consent. Turning a default into a consent is how
 * silent edits arrive unasked, so every path that could set the bit without
 * that click is pinned shut here.
 *
 * What is worth gating:
 *   [1] The block is visible exactly while the mode is off, and says what
 *       turning it on does (written in, Escape, which sites, the local log).
 *   [2] Turn on is ONE `SET_SENTENCE_MODE {on: true}` and no settings write —
 *       the worker refuses a SET_SETTINGS that carries the consent (a v4-shaped
 *       payload meant "suggest" by the same bit), and this stub does the same.
 *   [3] A refused Turn on (the worker fails closed until the v5 migration has
 *       persisted) is reported, not shown as on.
 *   [4] Both switch handlers gate on isTrusted.
 *   [5] Save never carries the switch, and Turn off is one `{on: false}`.
 *   [6] Opened with no web page in front: the per-site control is disabled and
 *       says why; recording stays usable.
 *   [7] The per-site box applies at once as single-origin toggles, and turning
 *       a site back on clears BOTH switch-off lists.
 *   [9b] Worker engine/floor states render without inventories; configured
 *       health observations refresh qualification and activation controls.
 *   [11a–c] Opening and button health checks distinguish callback transport
 *       failures and synchronous throws from worker-reported service failures.
 *   [12a], [12d–e] Refused site writes reconcile both directions; lost
 *       acknowledgements reread stored state, with explicit uncertainty if
 *       that read fails. The box stays disabled until reconciliation settles.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { chromePath } from "./lib/chrome.mjs";

const EXT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
let pass = 0; const failures = [];
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { failures.push(l); console.log(`  FAIL  ${l}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: true, executablePath: await chromePath(),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});

async function openPopup({ settings, tabs = [{ url: "https://example.com/x", id: 1 }], refuseOn = false,
  consent, pageStatus = null, afterWriteConsent, healthFailure = null,
  health = { ok: true, version: "0.35.0", ollama: { state: "ok", version: "0.35.0", floor: "0.35.0", versionOk: true }, engine: { state: "ok" } } } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  // Reuse the shipping projection for ordinary fixtures. New permission cases
  // supply explicit answers below and assert literal DOM text and classes.
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  await page.addScriptTag({ content: bg.slice(bg.indexOf("function sentenceModeState("), bg.indexOf("// Extension-page settings views only.")) });
  await page.evaluate((init, tabsIn, refuse, healthIn, consentIn, pageStatusIn, afterWrite, failure) => {
    window.__healthFailure = failure;
    window.__pendingHealth = [];
    window.__releaseHealth = () => {
      for (const cb of window.__pendingHealth.splice(0)) {
        chrome.runtime.lastError = { message: "The message port closed before a response was received." };
        try { cb(); } finally { chrome.runtime.lastError = null; }
      }
    };
    window.__consent = consentIn;
    window.__pageStatus = pageStatusIn;
    window.__settingsRequests = [];
    window.__pendingSettings = [];
    window.__releaseSettings = () => {
      for (const release of window.__pendingSettings.splice(0)) release();
    };
    const reply = () => structuredClone({ ok: true, settings: window.__settings,
      consent: window.__consent || sentenceModeState({ migrated: true, ...window.__settings },
        tabsIn[0] ? new URL(tabsIn[0].url).origin : null),
      pinnedModel: { tag: "proofer:v1-q4", digest: "0".repeat(64), sizeBytes: 1674464650 } });
    window.__opened = [];                     // chrome.tabs.create urls
    window.close = () => { window.__closed = true; };
    // Every write, in order: a SET_SETTINGS payload as sent, or a
    // SET_SENTENCE_MODE as {__consent: on}.
    window.__writes = [];
    window.__settings = init;
    window.chrome = {
      runtime: {
        id: "test", lastError: null,
        getURL: (p) => "chrome-extension://test/" + p,
        sendMessage: (msg, cb) => {
          msg = structuredClone(msg);
          if (msg.type === "CHECK_HEALTH") {
            if (window.__healthFailure === "throw") throw new Error("Extension context invalidated.");
            if (window.__healthFailure === "callback") { window.__pendingHealth.push(cb); return; }
            if (healthIn.configured && healthIn.settings) { window.__settings = structuredClone(healthIn.settings); window.__consent = healthIn.consent; }
            cb(healthIn); return;
          }
          if (msg.type === "GET_SETTINGS") {
            window.__settingsRequests.push(msg);
            const response = reply();
            if (window.__holdSettings) {
              window.__pendingSettings.push(() => cb(window.__failedSettings ? { ok: false } : response));
              return;
            }
            cb(response);
          } else if (msg.type === "SET_SENTENCE_MODE") {
            window.__writes.push({ __consent: msg.on });
            if (typeof msg.on !== "boolean") { cb({ ok: false, error: "bad-request" }); return; }
            if (refuse && msg.on === true) {
              cb({ ok: false, error: "Settings are still being upgraded -- try again in a moment." });
              return;
            }
            window.__settings.sentenceMode = msg.on;
            if (afterWrite) window.__consent = afterWrite;
            cb(reply());
          } else if (msg.type === "SET_SETTINGS") {
            window.__writes.push(JSON.parse(JSON.stringify(msg.settings)));
            // The worker's contract: the consent has its own message.
            if ("sentenceMode" in msg.settings || "sentenceModeApply" in msg.settings) {
              cb({ ok: false, error: "Proofer is turned on and off with its own switch." });
              return;
            }
            if (msg.settings.sentenceDisabledSiteToggle && window.__siteWriteFailure === "refuse") {
              window.__releaseSiteWrite = () => cb({ ok: false, error: window.__siteWriteError });
              return;
            }
            const s = window.__settings;
            const toggle = (list, t) => {
              const next = (list || []).slice();
              const i = next.indexOf(t.origin);
              if (t.enabled && i < 0) next.push(t.origin);
              if (!t.enabled && i >= 0) next.splice(i, 1);
              return next;
            };
            const { sentenceDisabledSiteToggle: st, disabledSiteToggle: dt, ...rest } = msg.settings;
            Object.assign(s, rest);
            if (st) s.sentenceModeDisabledSites = toggle(s.sentenceModeDisabledSites, st);
            if (dt) s.disabledSites = toggle(s.disabledSites, dt);
            const response = reply();
            if (st && window.__holdSiteWrite) {
              window.__releaseSiteWrite = () => {
                if (window.__siteWriteFailure === "callback") {
                  chrome.runtime.lastError = { message: "The message port closed before a response was received." };
                  try { cb(); } finally { chrome.runtime.lastError = null; }
                } else cb(response);
              };
              return;
            }
            cb(response);
          } else if (msg.type === "GET_LOG_STATS") cb({ ok: true, stats: {} });
          else if (msg.type === "GET_RECENT_SENTENCES") cb({ ok: true, rows: [], cap: 20 });
          else cb({ ok: true });
        },
      },
      storage: { local: { get: (a, c) => c && c({}), set: (a, c) => c && c() } },
      tabs: { query: (a, c) => c(tabsIn), sendMessage: (a, b, c) => c && c(window.__pageStatus),
              create: (o) => { window.__opened.push(o.url); } },
    };
  }, settings, tabs, refuseOn, health, consent, pageStatus, afterWriteConsent, healthFailure);
  await page.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await sleep(250);
  return { page, errors };
}

const center = (page, id) => page.evaluate((i) => {
  const r = document.getElementById(i).getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, id);
const click = async (page, id) => { const b = await center(page, id); await page.mouse.click(b.x, b.y); await sleep(200); };
// An install that has passed the speed check and is switched off: the state in
// which Turn on is the one action.
const OFF = () => ({
  ollamaUrl: "http://localhost:11434",
  disabledSites: [], sentenceMode: false, sentenceModeDisabledSites: [], recordAll: true,
  qualified: true, qualification: { pass: true },
});

{
  const { page, errors } = await openPopup({ settings: OFF() });
  const block = await page.evaluate(() => ({
    shown: document.getElementById("sentenceActivate").style.display !== "none",
    onShown: document.getElementById("sentenceOn").style.display !== "none",
    text: document.getElementById("sentenceActivate").textContent.replace(/\s+/g, " "),
    buttons: [...document.querySelectorAll("#sentenceActivate button")]
      .filter((b) => b.style.display !== "none").map((b) => b.textContent.trim()),
  }));
  ok(block.shown && !block.onShown, "[1] the activation block is shown while the mode is off");
  ok(block.buttons.length === 1 && block.buttons[0] === "Turn on",
    `[1] ...with exactly one choice, Turn on (got ${JSON.stringify(block.buttons)})`);
  ok(/straight into the field/.test(block.text) && /Escape/.test(block.text)
     && /every site except/.test(block.text) && /log on this computer/.test(block.text),
    "[1] ...which says what it does: written in, Escape, which sites, the local log");

  // A synthetic click must do NOTHING -- the isTrusted gate.
  await page.evaluate(() => document.getElementById("activateOn").click());
  await sleep(120);
  ok(await page.evaluate(() => window.__writes.length) === 0, "[4] a synthetic Turn on grants nothing");

  await click(page, "activateOn");
  const on = await page.evaluate(() => ({ writes: window.__writes, s: window.__settings,
    hidden: document.getElementById("sentenceActivate").style.display === "none",
    onShown: document.getElementById("sentenceOn").style.display !== "none" }));
  ok(on.writes.length === 1, `[2] Turn on is ONE write (got ${on.writes.length})`);
  ok(JSON.stringify(on.writes[0]) === JSON.stringify({ __consent: true }),
    `[2] ...and it is SET_SENTENCE_MODE {on: true}, not a settings save (got ${JSON.stringify(on.writes[0])})`);
  ok(on.hidden && on.onShown, "[1] ...and the block gives way to the on state");

  // [5] Save must not carry the switch, in either direction.
  await page.evaluate(() => { window.__writes = []; });
  await click(page, "saveBtn");
  const saved = await page.evaluate(() => window.__writes[0] || {});
  ok(!("sentenceMode" in saved) && !("sentenceModeApply" in saved),
    `[5] Save carries no consent key (got ${JSON.stringify(Object.keys(saved))})`);
  ok(!("sentenceDisabledSiteToggle" in saved) && !("disabledSiteToggle" in saved),
    "[5] ...and no site toggle either (those apply at once)");

  // [4] Turn off is gated too, and is one write of false.
  await page.evaluate(() => { window.__writes = []; document.getElementById("turnOff").click(); });
  await sleep(120);
  ok(await page.evaluate(() => window.__writes.length) === 0, "[4] a synthetic Turn off does nothing");
  await click(page, "turnOff");
  const off = await page.evaluate(() => ({ writes: window.__writes,
    shown: document.getElementById("sentenceActivate").style.display !== "none" }));
  ok(JSON.stringify(off.writes) === JSON.stringify([{ __consent: false }]),
    `[5] Turn off is one SET_SENTENCE_MODE {on: false} (got ${JSON.stringify(off.writes)})`);
  ok(off.shown, "[1] ...and the block comes back, which is the way back on");

  // No trace of the removed controls.
  const gone = await page.evaluate(() => ["activateApply", "activateSuggest", "sentenceModeApply",
    "sentenceModel", "sentenceMode", "siteEnabled"].filter((id) => document.getElementById(id)));
  ok(gone.length === 0, `the suggestion, model and second site controls are gone (${gone.join(",") || "none left"})`);
  ok(errors.length === 0, `no page errors (${errors.join("; ") || "none"})`);
  await page.close();
}

// [3] The worker refuses Turn on until v5 is persisted; the popup must say so
// rather than render the on state it asked for.
{
  const { page, errors } = await openPopup({ settings: OFF(), refuseOn: true });
  await click(page, "activateOn");
  const r = await page.evaluate(() => ({
    status: document.getElementById("status").textContent,
    isError: document.getElementById("status").classList.contains("error"),
    stillOff: document.getElementById("sentenceActivate").style.display !== "none",
  }));
  ok(r.isError && /upgraded/.test(r.status), `[3] a refused Turn on is reported ("${r.status}")`);
  ok(r.stillOff, "[3] ...and the popup still shows Proofer off");
  ok(errors.length === 0, `[3] no page errors (${errors.join("; ") || "none"})`);
  await page.close();
}

// [7] The per-site box: one origin, applied at once, both lists cleared on the
// way back on.
{
  const s = OFF();
  s.sentenceMode = true;
  s.disabledSites = ["https://example.com"];          // switched off the old way
  const { page, errors } = await openPopup({ settings: s });
  ok(await page.evaluate(() => document.getElementById("sentenceModeSite").checked) === false,
    "[7] a site in the OLD disabledSites list reads as off");
  await click(page, "sentenceModeSite");
  const w = await page.evaluate(() => ({ writes: window.__writes, s: window.__settings }));
  ok(w.writes.length === 1, `[7] one write per change (got ${w.writes.length})`);
  ok(JSON.stringify(w.writes[0]) === JSON.stringify({
    sentenceDisabledSiteToggle: { origin: "https://example.com", enabled: false },
    disabledSiteToggle: { origin: "https://example.com", enabled: false } }),
    `[7] ...turning it back on clears both lists (got ${JSON.stringify(w.writes[0])})`);
  ok(w.s.disabledSites.length === 0 && w.s.sentenceModeDisabledSites.length === 0,
    "[7] ...and the site is on again");
  await click(page, "sentenceModeSite");
  const w2 = await page.evaluate(() => window.__writes[1]);
  ok(JSON.stringify(w2) === JSON.stringify({
    sentenceDisabledSiteToggle: { origin: "https://example.com", enabled: true } }),
    `[7] switching it off touches only the sentence list (got ${JSON.stringify(w2)})`);
  await page.evaluate(() => { window.__writes = []; document.getElementById("sentenceModeSite").click(); });
  await sleep(150);
  ok(await page.evaluate(() => window.__writes.length) === 0, "[4] a synthetic site toggle does nothing");
  ok(errors.length === 0, `[7] no page errors (${errors.join("; ") || "none"})`);
  await page.close();
}

// [12a] Refused disable restores checked; [12d] refused enable restores unchecked.
// Mutant: replace `await reconcileSiteSwitch()` with `true` in the site listener.
// Red: [12a]/[12d] authoritative reread, restored checkbox, and retry payload.
// Mutant: replace the listener's error selection with "Could not update this site.".
// Red: [12a]/[12d] exact worker refusal text.
// Mutant: remove `sentenceSiteEl.disabled = true` from the site listener.
// Red: [12a]/[12d] disabled during write and reconciliation, one pending write.
for (const initiallyOff of [false, true]) {
  const id = initiallyOff ? "[12d]" : "[12a]";
  const lists = initiallyOff ? ["https://example.com"] : [];
  const { page, errors } = await openPopup({ settings: { ...OFF(), sentenceMode: true,
    disabledSites: lists.slice(), sentenceModeDisabledSites: lists.slice() } });
  const reads = await page.evaluate(() => window.__settingsRequests.length);
  await page.evaluate(() => {
    window.__siteWriteFailure = "refuse";
    window.__siteWriteError = "Storage refused the site update.";
    window.__holdSettings = true;
  });
  await click(page, "sentenceModeSite");
  ok(await page.$eval("#sentenceModeSite", (e) => e.disabled), `${id} checkbox disabled during write`);
  await click(page, "sentenceModeSite");
  ok(await page.evaluate(() => window.__writes.length) === 1, `${id} second pending click cannot submit a write`);
  await page.evaluate(() => window.__releaseSiteWrite());
  ok(await page.evaluate(() => window.__settingsRequests.length) === reads + 1,
    `${id} refusal requests an authoritative reread`);
  ok(await page.$eval("#sentenceModeSite", (e) => e.disabled), `${id} checkbox disabled during reconciliation`);
  const stored = await page.evaluate(() => [window.__settings.disabledSites, window.__settings.sentenceModeDisabledSites]);
  ok(JSON.stringify(stored) === JSON.stringify([lists, lists]), `${id} refused write preserves both stored lists`);
  await page.evaluate(() => window.__releaseSettings());
  const settled = await page.$eval("#sentenceModeSite", (e) => ({ checked: e.checked, disabled: e.disabled }));
  ok(settled.checked === !initiallyOff, `${id} checkbox restored to acknowledged state`);
  ok(!settled.disabled, `${id} checkbox enabled after reconciliation`);
  ok(await page.$eval("#status", (e) => e.classList.contains("error") && e.textContent === "Storage refused the site update."),
    `${id} exact worker refusal text is displayed`);
  const expected = initiallyOff ? {
    sentenceDisabledSiteToggle: { origin: "https://example.com", enabled: false },
    disabledSiteToggle: { origin: "https://example.com", enabled: false },
  } : { sentenceDisabledSiteToggle: { origin: "https://example.com", enabled: true } };
  await click(page, "sentenceModeSite");
  ok(JSON.stringify(await page.evaluate(() => window.__writes)) === JSON.stringify([expected, expected]),
    `${id} retry repeats the same single-origin payload`);
  await page.evaluate(() => { window.__releaseSiteWrite(); });
  await page.evaluate(() => window.__releaseSettings());
  // A refusal without detail retains the generic fallback.
  await page.evaluate(() => { window.__siteWriteError = undefined; });
  await click(page, "sentenceModeSite");
  await page.evaluate(() => window.__releaseSiteWrite());
  await page.evaluate(() => window.__releaseSettings());
  ok(await page.$eval("#status", (e) => e.textContent) === "Could not update this site.",
    `${id} missing refusal text uses the generic fallback`);
  ok(errors.length === 0, `${id} no page errors`);
  await page.close();
}

// [12e] A lost acknowledgement may follow a committed write; ask the authority.
// Mutant: replace reconcileSiteSwitch's GET_SETTINGS await with `null`.
// Red: [12e] fresh reread and committed checkbox after lost acknowledgement.
// Mutant: replace the failed-read uncertainty suffix with an empty string.
// Red: [12e] failed reread displays original failure and explicit uncertainty.
for (const failRead of [false, true]) {
  const { page, errors } = await openPopup({ settings: { ...OFF(), sentenceMode: true } });
  const reads = await page.evaluate(() => window.__settingsRequests.length);
  await page.evaluate(() => {
    window.__holdSiteWrite = true;
    window.__siteWriteFailure = "callback";
    window.__holdSettings = true;
  });
  await click(page, "sentenceModeSite");
  ok(await page.$eval("#sentenceModeSite", (e) => e.disabled), "[12e] lost acknowledgement keeps write pending");
  ok(JSON.stringify(await page.evaluate(() => window.__settings.sentenceModeDisabledSites)) ===
    '["https://example.com"]', "[12e] stub committed the disable before losing its acknowledgement");
  await page.evaluate(() => window.__releaseSiteWrite());
  ok(await page.evaluate(() => chrome.runtime.lastError === null), "[12e] lost acknowledgement lastError is callback-scoped");
  ok(await page.evaluate(() => window.__settingsRequests.length) === reads + 1,
    "[12e] lost acknowledgement requests a fresh settings read");
  ok(await page.$eval("#sentenceModeSite", (e) => e.disabled), "[12e] checkbox disabled while fresh read is pending");
  // A successful reply describes the store at request time, not release time.
  // This later change must not leak through an aliased response array.
  await page.evaluate((failed) => {
    window.__settings.sentenceModeDisabledSites.push("https://later.example");
    window.__failedSettings = failed;
    window.__releaseSettings();
  }, failRead);
  const settled = await page.$eval("#sentenceModeSite", (e) => ({ checked: e.checked, disabled: e.disabled }));
  ok(settled.checked === failRead, failRead
    ? "[12e] failed reread restores last confirmed checkbox"
    : "[12e] fresh read preserves committed checkbox after lost acknowledgement");
  ok(!settled.disabled, "[12e] checkbox enabled after fresh read settles");
  const message = "The message port closed before a response was received." +
    (failRead ? " The current setting could not be confirmed." : "");
  ok(await page.$eval("#status", (e) => ({ text: e.textContent, error: e.classList.contains("error") }))
    .then((v) => v.error && v.text === message), failRead
    ? "[12e] failed reread displays original failure and explicit uncertainty"
    : "[12e] confirmed reread preserves original messaging error");
  ok(await page.$eval("#sentenceSites", (e) => !e.textContent.includes("https://later.example")),
    "[12e] later store mutation cannot leak into captured settings response");
  ok((await page.evaluate(() => window.__settingsRequests)).every((m) => m.tabId === 1),
    "[12e] reconciliation uses the active tab id");
  ok(errors.length === 0, "[12e] no page errors");
  await page.close();
}

// [6] Opened with no web page in front. Ported from interaction-test.mjs [32]
// when the manual path went (2026-09-24). Greying the per-site control out in
// silence under a label reading "(not supported)" is how a real session once
// lost a day of records; recording is global, so it stays usable here.
{
  const { page, errors } = await openPopup({ settings: { ...OFF(), sentenceMode: true }, tabs: [] });
  const noSite = await page.evaluate(() => ({
    text: document.getElementById("originText").textContent,
    siteDisabled: document.getElementById("sentenceModeSite").disabled,
    siteTitle: document.getElementById("sentenceModeSite").title,
    recordDisabled: document.getElementById("recordAll").disabled,
    recordChecked: document.getElementById("recordAll").checked,
  }));
  ok(noSite.siteDisabled, "[6] the per-site control is disabled with no web page in front");
  ok(/open Proofer from the toolbar/i.test(noSite.text), `[6] ...and the line says what to do ("${noSite.text}")`);
  ok(/toolbar/i.test(noSite.siteTitle), "[6] ...and the disabled control carries the same hint");
  ok(!noSite.recordDisabled && noSite.recordChecked, "[6] recording stays usable, and is on by default");
  ok(errors.length === 0, `[6] no page errors (${errors.join("; ") || "none"})`);
  await page.close();
}

// [8] Before this computer has passed the speed check, the activation block's
// one action is setup: Turn on is hidden (the worker would refuse it), and
// Open setup opens the setup page rather than writing anything.
{
  const { page, errors } = await openPopup({ settings: { ...OFF(), qualified: false, qualification: null } });
  const view = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll("#sentenceActivate button")]
      .filter((b) => b.style.display !== "none").map((b) => b.textContent.trim()),
    hint: document.getElementById("activateNeedsSetup").style.display !== "none",
  }));
  ok(JSON.stringify(view.buttons) === JSON.stringify(["Open setup"]) && view.hint,
    `[8] not yet checked: the one choice is Open setup, with why (got ${JSON.stringify(view.buttons)})`);
  await page.evaluate(() => document.getElementById("activateSetup").click());
  await sleep(120);
  ok(await page.evaluate(() => window.__opened.length) === 0, "[8] a synthetic Open setup does nothing");
  await click(page, "activateSetup");
  const after = await page.evaluate(() => ({ opened: window.__opened, writes: window.__writes }));
  ok(JSON.stringify(after.opened) === JSON.stringify(["chrome-extension://test/welcome.html"]) && after.writes.length === 0,
    `[8] ...a real one opens the setup page and writes nothing (${JSON.stringify(after)})`);
  ok(errors.length === 0, `[8] no page errors (${errors.join("; ") || "none"})`);
  await page.close();
}

// [9] The first line names what stops Proofer working, and is absent when
// nothing does.
{
  const cases = [
    ["all well", { ...OFF(), sentenceMode: true }, undefined, null],
    ["Ollama not answering", { ...OFF(), sentenceMode: true }, { ok: false }, /needs Ollama running/],
    ["the engine missing", { ...OFF(), sentenceMode: true },
      { ok: true, engine: { state: "missing" } }, /downloaded again/],
    ["Ollama updated", { ...OFF(), sentenceMode: true, qualified: false,
      qualification: { pass: true, stale: "ollama-updated" } }, undefined, /Ollama was updated/],
    ["a failed check", { ...OFF(), qualified: false, qualification: { pass: false, category: "too-slow" } },
      undefined, /didn't pass/],
    ["switched off, all well", OFF(), { ok: false }, null],
  ];
  for (const [label, settings, health, want] of cases) {
    const { page } = await openPopup({ settings, ...(health ? { health } : {}) });
    const line = await page.evaluate(() => {
      const el = document.getElementById("setupLine");
      return el.style.display === "none" ? null : document.getElementById("setupLineText").textContent;
    });
    ok(want === null ? line === null : want.test(line || ""), `[9] ${label}: ${line === null ? "no line" : JSON.stringify(line)}`);
    await page.close();
  }
}

// [9b] Mutant: renderEngine sets `st` to "unknown" instead of worker state.
// Red: literal engine text for ok/missing/mismatch without any model inventory.
// Mutant: disable adoptHealth's configured settings/consent branch.
// Red: newly stale qualification removes Turn on and names setup as required.
{
  for (const [state, text] of [["ok", "installed"], ["missing", "not installed — open setup"],
    ["mismatch", "a different version is installed — open setup"], ["unknown", "could not check"]]) {
    const { page } = await openPopup({ settings: OFF(), health: { ok: true, engine: { state } } });
    ok(await page.$eval("#engineLine", (e) => e.textContent) === text, `[9b] worker ${state} renders without model inventories`);
    await page.close();
  }
  const settings = { ...OFF(), qualified: false, qualification: { pass: true, stale: "ollama-updated" } };
  const health = { ok: true, configured: true, settings,
    consent: { activated: false, siteDisabled: false, allowed: false, reason: "switched-off", apply: false },
    ollama: { state: "ok", version: "0.35.0", versionOk: true, floor: "0.35.0" }, engine: { state: "ok" } };
  const { page } = await openPopup({ settings: OFF(), health });
  ok(await page.$eval("#activateOn", (e) => e.style.display === "none")
    && await page.$eval("#activateSetup", (e) => e.style.display !== "none"),
    "[9b] configured health qualification refresh removes Turn on");
  ok(await page.$eval("#setupLineText", (e) => e.textContent) === "Ollama was updated, so Proofer needs its speed check again.",
    "[9b] configured health qualification refresh names the stale check");
  await page.close();
  const old = await openPopup({ settings: OFF(), health: { ok: true,
    ollama: { state: "ok", version: "0.32.5", floor: "0.35.0", versionOk: false }, engine: { state: "ok" } } });
  ok(await old.page.$eval("#setupLineText", (e) => e.textContent) === "Ollama needs an update. Open setup.",
    "[9b] popup uses the worker floor decision");
  await old.page.close();
}

// [11a] Opening health loses its channel after settings succeed.
// Mutant: remove messaging:true from sendMessage's callback failure object.
// Red: wrapper discriminator, no Ollama setup diagnosis, incomplete engine check.
// Mutant: delete renderEngine's messaging branch. Red: incomplete engine check.
{
  const { page, errors } = await openPopup({ settings: { ...OFF(), sentenceMode: true }, healthFailure: "callback" });
  ok(await page.$eval("#sentenceOn", (e) => e.style.display !== "none"), "[11a] settings loaded before health fails");
  ok(await page.evaluate(() => window.__pendingHealth.length) === 1, "[11a] opening health callback is deferred");
  await page.evaluate(() => {
    sendMessage({ type: "CHECK_HEALTH" }).then((r) => { window.__healthResult = r; });
    window.__releaseHealth();
  });
  const r = await page.evaluate(() => window.__healthResult);
  ok(r?.ok === false && r.messaging === true && r.error === "The message port closed before a response was received.",
    "[11a] wrapper preserves callback failure detail and messaging discriminator");
  ok(await page.evaluate(() => chrome.runtime.lastError === null), "[11a] lastError is scoped to the callback");
  ok(await page.$eval("#setupLine", (e) => e.style.display === "none") &&
    !/needs Ollama running/.test(await page.$eval("#setupLineText", (e) => e.textContent)),
    "[11a] no Ollama setup diagnosis after messaging failure");
  ok(await page.$eval("#engineLine", (e) => e.textContent) ===
    "Could not contact Proofer; the engine check could not be completed.",
    "[11a] engine line names an incomplete Proofer check");
  ok(errors.length === 0, "[11a] no page errors");
  await page.close();
}

// [11b] The button distinguishes transport failure from a worker service result.
// Mutant: delete the Test connection listener's messaging branch.
// Red: button names an incomplete Proofer check, not Ollama unreachability.
{
  const health = { ok: false, error: "service unavailable" };
  const { page, errors } = await openPopup({ settings: { ...OFF(), sentenceMode: true }, health });
  await page.$eval("#testBtn", (e) => { e.closest("details").open = true; });
  await page.evaluate(() => { window.__healthFailure = "callback"; });
  await page.click("#testBtn");
  ok(await page.evaluate(() => window.__pendingHealth.length) === 1, "[11b] button health callback is deferred");
  await page.evaluate(() => window.__releaseHealth());
  const status = await page.$eval("#status", (e) => ({ text: e.textContent, error: e.classList.contains("error") }));
  ok(status.error && status.text === "Could not contact Proofer; the connection check could not be completed.",
    "[11b] button names an incomplete Proofer check, not Ollama unreachability");
  await page.evaluate(() => { window.__healthFailure = null; });
  await page.click("#testBtn");
  ok(await page.$eval("#status", (e) => e.textContent) === "Cannot reach Ollama at http://localhost:11434.",
    "[11b] worker-returned failure still reports Ollama unreachability");
  ok(JSON.stringify(await page.evaluate(() => sendMessage({ type: "CHECK_HEALTH" }))) === JSON.stringify(health),
    "[11b] worker response passes through unchanged");
  ok(errors.length === 0, "[11b] no page errors");
  await page.close();
}

// [11c] A synchronous send failure settles visibly after settings load.
// Mutant: replace sendMessage's catch resolution with throw e.
// Red: resolved messaging result, visible incomplete engine check, no page errors.
{
  const { page, errors } = await openPopup({ settings: { ...OFF(), sentenceMode: true }, healthFailure: "throw" });
  const result = await page.evaluate(() => sendMessage({ type: "CHECK_HEALTH" })
    .then((r) => ({ resolved: true, ...r }), (e) => ({ resolved: false, error: e.message })));
  ok(result.resolved && result.ok === false && result.messaging === true && result.error === "Extension context invalidated.",
    "[11c] synchronous send failure resolves with messaging discriminator and detail");
  ok(await page.$eval("#sentenceOn", (e) => e.style.display !== "none"), "[11c] settings loaded before synchronous failure");
  ok(await page.$eval("#engineLine", (e) => e.textContent) ===
    "Could not contact Proofer; the engine check could not be completed.",
    "[11c] synchronous failure shows an incomplete Proofer check");
  ok(errors.length === 0, "[11c] synchronous failure has no unhandled page error");
  await page.close();
}

// [10] Keep a log applies at once, as one key, and only on a real click.
{
  const { page } = await openPopup({ settings: OFF() });
  await page.evaluate(() => document.getElementById("recordAll").click());
  await sleep(120);
  const synthetic = await page.evaluate(() => ({ writes: window.__writes.length, checked: document.getElementById("recordAll").checked }));
  ok(synthetic.writes === 0 && synthetic.checked === true, "[10] a synthetic click on Keep a log changes nothing");
  // page.click scrolls it into view first (it sits below Puppeteer's default
  // viewport); the click it dispatches is a trusted one.
  await page.click("#recordAll");
  await sleep(150);
  const w = await page.evaluate(() => window.__writes);
  ok(JSON.stringify(w) === JSON.stringify([{ recordAll: false }]), `[10] a real one is one write of recordAll (${JSON.stringify(w)})`);
  await page.close();
}

// [11] Incomplete upgrade is shown as incomplete, even if a stale settings
// bit claims on. Mutant: disable sentenceOffReason's upgrading case.
// Red: [11] the upgrading explanation is visible.
const ALLOWED = { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true };
{
  const { page, errors } = await openPopup({ settings: { ...OFF(), sentenceMode: true, migrated: false },
    consent: { activated: false, siteDisabled: false, allowed: false, reason: "upgrading", apply: false },
    afterWriteConsent: ALLOWED });
  ok(/still being upgraded/.test(await page.$eval("#sentenceWhere", (e) => e.textContent)),
    "[11] the upgrading explanation is visible");
  ok(await page.$eval("#sentenceOn", (e) => e.style.display === "none"), "[11] no on block before migration");
  ok(await page.$eval("#activateOn", (e) => e.style.display !== "none"), "[11] qualified users retain Turn on");
  await click(page, "activateOn");
  ok(await page.$eval("#sentenceOn", (e) => e.style.display !== "none"), "[11] a successful retry shows activation");
  ok((await page.evaluate(() => window.__settingsRequests)).every((m) => m.tabId === 1),
    "[11] settings reads carry the active tab id");
  ok(errors.length === 0, "[11] no page errors");
  await page.close();
}

const statusView = (page) => page.$eval("#sentenceWhere", (e) => ({ text: e.textContent, green: e.classList.contains("ok") }));
const remembered = { status: "active", detail: null, family: "textarea" };
// [12] Denied worker consent beats remembered activity, even if a frame still
// reports apply:true. Mutant: replace refreshSentenceWhere's worker-refusal
// condition with false. Red: [12] refusal/no Running/non-green assertions.
{
  const denied = { activated: true, siteDisabled: false, allowed: false, reason: "qualification-required", apply: false };
  const { page } = await openPopup({ settings: { ...OFF(), sentenceMode: true, qualified: false,
    qualification: { pass: true, stale: "ollama-updated" } }, consent: denied,
    pageStatus: { ok: true, status: "off", apply: true, last: remembered } });
  let v = await statusView(page);
  ok(/current, passing speed check/.test(v.text), "[12] worker refusal explains the missing qualification");
  ok(!v.green && !/Running/.test(v.text), "[12] worker denial cannot show Running or green");
  ok(await page.$eval("#sentenceOn", (e) => e.style.display !== "none"), "[12] qualification loss retains activation");
  await page.evaluate(() => { window.__pageStatus.status = "active"; });
  await page.$eval("#saveBtn", (e) => { e.closest("details").open = true; });
  await page.click("#saveBtn");
  await sleep(200);
  v = await statusView(page);
  ok(!v.green && !/Running/.test(v.text), "[12] worker denial also defeats current frame activity");
  // A new refresh must clear the last green result while it is unresolved,
  // then stay non-green if the worker cannot answer.
  await page.evaluate((c) => { window.__consent = c; window.__pageStatus = { ok: true, status: "active", apply: true }; }, ALLOWED);
  await page.$eval("#saveBtn", (e) => { e.closest("details").open = true; });
  await page.click("#saveBtn");
  await sleep(200);
  v = await statusView(page);
  ok(v.green && /Running/.test(v.text), "[12] a fresh allowed answer can show Running");
  await page.evaluate(() => { window.__holdSettings = true; });
  await page.$eval("#saveBtn", (e) => { e.closest("details").open = true; });
  await page.click("#saveBtn");
  await sleep(200);
  v = await statusView(page);
  ok(!v.green && v.text === "Checking permission…", "[12] pending refresh clears the previous green status");
  await page.evaluate(() => { window.__failedSettings = true; window.__releaseSettings(); });
  await sleep(80);
  v = await statusView(page);
  ok(!v.green && /Could not check permission/.test(v.text), "[12] failed refresh stays non-green");
  await page.close();
}

// [12b] Frame permission is independently required; a missing value is denied.
// Mutant: remove r.apply === true from the history-substitution condition.
// Red: both [12b] current off explanation/no historical suffix assertions.
for (const apply of [false, undefined]) {
  const { page } = await openPopup({ settings: { ...OFF(), sentenceMode: true }, consent: ALLOWED,
    pageStatus: { ok: true, status: "off", detail: "site-disabled", apply, last: remembered } });
  let v = await statusView(page);
  ok(v.text === "Not running: Proofer is disabled on this site.", `[12b] apply=${apply}: current off explanation wins`);
  ok(!v.green && !/Running|last field you used|previously focused field in this frame/.test(v.text), `[12b] apply=${apply}: no Running or historical suffix`);
  for (const status of ["active", "unsafe-range"]) {
    await page.evaluate((st) => { window.__pageStatus = { ok: true, ...st, detail: "maxlength" }; }, { status, apply });
    await page.$eval("#saveBtn", (e) => { e.closest("details").open = true; });
    await page.click("#saveBtn");
    await sleep(200);
    v = await statusView(page);
    ok(!v.green && v.text === "Not running here.", `[12b] ${status} apply=${apply} cannot say Running`);
  }
  await page.evaluate(() => { window.__pageStatus = { ok: true, status: "unsupported-editor", detail: "canvas-host", apply: false }; });
  await page.$eval("#saveBtn", (e) => { e.closest("details").open = true; });
  await page.click("#saveBtn");
  await sleep(200);
  ok(/draws its editor on a canvas/.test((await statusView(page)).text), "[12b] direct canvas capability diagnostics survive");
  await page.close();
}

// [12c] Ordinary blur preserves useful history with both permissions allowed.
// Mutant: disable the history-substitution branch in refreshSentenceWhere.
// Red: [12c] running label and last-field suffix.
{
  const { page } = await openPopup({ settings: { ...OFF(), sentenceMode: true }, consent: ALLOWED,
    pageStatus: { ok: true, status: "no-field", apply: true, last: remembered } });
  const v = await statusView(page);
  ok(v.green && v.text === "Running in the field you focused. (previously focused field in this frame)",
    "[12c] permitted history shows the running label and last-field suffix");
  await page.close();
}

console.log("=".repeat(72));
console.log(`${pass} passed, ${failures.length} failed`);
await browser.close();
process.exit(failures.length ? 1 : 0);
