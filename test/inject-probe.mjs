#!/usr/bin/env node
// Can Proofer put its content script into a tab that was open before it was
// installed, WITHOUT asking for broader host permissions? An experiment, not a
// gate: it tests whether `scripting` plus the existing match patterns can
// inject without new host permissions.
//
//   node inject-probe.mjs        # Chrome for Testing, and Brave if installed
//
// It packages Proofer with ONE change -- "scripting" added to permissions --
// and asks chrome.scripting.executeScript to run content.js in a page on
// 127.0.0.2, an origin the manifest's host_permissions (localhost only) do not
// cover but its content_scripts matches (<all_urls>) do. A control page is
// opened with the extension disabled from injecting into it: an http page
// is covered by <all_urls>, so the control is a chrome:// page, which no
// permission reaches. Rows:
//   injected into the page          want: yes, if match patterns suffice
//   the injection ran content.js    want: a global content.js sets
//   chrome://version refused        want: refused (the control)
// Exit 0 when every row is observed (the answer is printed, not asserted),
// 1 on a probe failure, 77 when there is nothing to measure with.
//
// MEASURED 2026-09-25 -- the answer is NO, in both browsers: Chrome for Testing
// 145.0.7632.77 and Brave (Chromium 153.0.8010.53) refuse executeScript into
// the 127.0.0.2 page with "Cannot access contents of the page. Extension
// manifest must request permission to access the respective host", exactly as
// they refuse chrome://version. Content-script match patterns do not grant
// scripting access; only host_permissions (or activeTab, for the one tab a
// user gesture on the toolbar names) do. Proofer keeps its existing
// permissions, so it does not inject into open tabs: setup's
// ready screen says a page open from before needs one refresh, and the popup
// already says "reload it" on such a page. That also removes the reason for a
// double-injection guard in content.js -- and a naive global guard would be
// harmful, since an orphaned script from a previous version shares the
// isolated world and would block the live one. Untested: activeTab covering
// the tab the popup was opened on (needs a real toolbar click).

import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { resolveChrome } from "./lib/chrome.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browsers = [(await resolveChrome()).path, "/usr/bin/brave-browser"].filter((b) => b && fs.existsSync(b));
if (!browsers.length) { console.log("no browser -- nothing to measure"); process.exit(77); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inject-probe-"));
const EXT = path.join(tmp, "proofer");
execFileSync(process.execPath, [path.join(REPO, "tools", "package.mjs"), "--out", EXT], { stdio: "ignore" });
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
manifest.permissions = [...new Set([...(manifest.permissions || []), "scripting"])];
fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`permissions: ${JSON.stringify(manifest.permissions)}`);
console.log(`host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
console.log(`content_scripts.matches: ${JSON.stringify(manifest.content_scripts.map((c) => c.matches))}`);

const server = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<textarea id=t></textarea>"); });
await new Promise((r) => server.listen(0, "127.0.0.2", r));
const PAGE = `http://127.0.0.2:${server.address().port}/`;

let failed = 0;
const results = [];
for (const exe of browsers) {
  const name = exe.includes("brave") ? "Brave" : "Chrome for Testing";
  const ud = fs.mkdtempSync(path.join(tmp, "profile-"));
  const browser = await puppeteer.launch({ headless: true, executablePath: exe,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", `--user-data-dir=${ud}`, "--no-first-run"] });
  console.log(`\n${name} (${await browser.version()})`);
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const t = browser.targets().find((x) => x.type() === "service_worker" && x.url().endsWith("/background.js"));
    if (t) sw = await t.worker(); else await sleep(250);
  }
  if (!sw) { console.log("  extension did not load"); failed++; await browser.close(); continue; }
  const page = await browser.newPage();
  await page.goto(PAGE);
  const ctl = await browser.newPage();
  await ctl.goto("chrome://version");
  const out = await sw.evaluate(async (pageUrl) => {
    const tabs = await chrome.tabs.query({});
    const rows = [];
    for (const tab of tabs) {
      let r;
      try {
        const res = await chrome.scripting.executeScript({ target: { tabId: tab.id },
          func: () => ({ href: location.href, hadProofer: typeof globalThis.__prooferSentence !== "undefined" }) });
        r = { ok: true, result: res && res[0] && res[0].result };
      } catch (e) { r = { ok: false, error: String(e && e.message) }; }
      rows.push({ url: tab.url || "(url hidden)", ...r });
    }
    let fileRun = null;
    const target = tabs.find((t) => t.url && t.url.startsWith(pageUrl)) || null;
    if (target) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
        fileRun = { ok: true };
      } catch (e) { fileRun = { ok: false, error: String(e && e.message) }; }
    }
    return { rows, fileRun, sawUrls: tabs.some((t) => !!t.url) };
  }, PAGE);
  for (const r of out.rows) console.log(`  ${r.ok ? "injected" : "refused "} ${r.url}  ${r.ok ? JSON.stringify(r.result) : r.error}`);
  console.log(`  tab URLs visible to the worker: ${out.sawUrls}`);
  console.log(`  content.js injected by file into the page: ${JSON.stringify(out.fileRun)}`);
  results.push({ browser: name, ...out });
  await browser.close();
}
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (process.env.PROOFER_RESULT_JSON) fs.writeFileSync(process.env.PROOFER_RESULT_JSON, JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
