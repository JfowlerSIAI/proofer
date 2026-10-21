#!/usr/bin/env node
// The out-of-box install, automated, for an operating system nobody here owns.
//
//   node tools/package.mjs                       # the package this installs
//   node test/os-install-check.mjs --out <dir>   # or PROOFER_INSTALL_CHECK_OUT=<dir>
//
// Run by .github/workflows/os-install.yml on GitHub's hosted Windows and macOS
// runners (TESTING.md §32). It installs the PACKAGED extension (dist/proofer)
// into Chrome for Testing with a fresh profile and a REAL Ollama already
// running on the default address, and then touches nothing until setup is
// done: the check is that install opens setup by itself, setup finds Ollama,
// setup ITSELF downloads the pinned engine from ollama.com, checks it, runs
// the real speed check and reaches a verdict. No stub, no fake Ollama, no
// worker variable changed.
//
// Verdicts. These runners have no usable GPU, so "too-slow" is an expected
// answer and passes this check: it is the product working, on a machine it
// should refuse. "unexpected" (a wrong answer on this OS), "operational", a
// stopped download, a screen nobody can get past without a click, or no
// terminal screen inside the time limit is a failure. If the verdict is Ready,
// it also clicks Turn on and types a typo into a plain textarea page, and the
// correction must land, as sentence-e2e-test.mjs requires.
//
// Exit codes: 0 ready or too-slow, with every check below holding; 1 anything
// else, including a step that did not happen; 2 bad invocation (unknown flag,
// no package built, Linux outside a private network namespace).
//
// Artifacts (in --out):
//   summary.json            {os, ollamaVersion, verdict, screens, timings, checks, ...}
//   verdict.json            the stored verdict (setupQualification): numbers, backend,
//                           calibration, per-case outcome categories -- no text
//   setup-report.json       the worker's SETUP_REPORT, asked by the setup page
//   setup-report-saved.json the file "Save test report" saves, when the final
//                           screen has that button (the report plus what the
//                           browser can tell about the computer)
//   NN-<screen>.png         each setup screen as it was first reached, plus
//                           NN-<screen>-progress.png every 5 minutes on a long one
//   console.txt             the setup page's and the worker's console
//
// Neither report may hold any sentence, site, address or path: checked here,
// as the acceptance test's step 13 asks a person to check it.
//
// On Linux it refuses to run outside a private network namespace (any
// non-loopback interface), because there the Ollama on 11434 is somebody's
// live service. Locally:
//   unshare -rn sh -c 'ip link set lo up && <start a private ollama serve> && node os-install-check.mjs ...'
// --allow-host-ollama overrides that for a disposable Linux machine.

import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { resolveChrome } from "./lib/chrome.mjs";
import { verifyPackage } from "../tools/package.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const OLLAMA = "http://127.0.0.1:11434";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Invocation ---------------------------------------------------------------------
const USAGE = `usage: node test/os-install-check.mjs [--out <dir>] [--ext <dir>] [--timeout-min <n>] [--allow-host-ollama]
  --out <dir>          artifacts directory (or PROOFER_INSTALL_CHECK_OUT; default test/results/os-install-check)
  --ext <dir>          the packaged extension (default dist/proofer, from node tools/package.mjs)
  --timeout-min <n>    minutes to wait for a final setup screen (or PROOFER_INSTALL_CHECK_TIMEOUT_MIN; default 35)
  --allow-host-ollama  on Linux, run against whatever answers on 11434 outside a namespace`;
const bad = (msg) => { console.error(`${msg}\n\n${USAGE}`); process.exit(2); };
const opts = { out: process.env.PROOFER_INSTALL_CHECK_OUT || null, ext: null,
  timeoutMin: process.env.PROOFER_INSTALL_CHECK_TIMEOUT_MIN || null, allowHost: false };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith("--")) bad(`${a} needs a value`); return v; };
    if (a === "--out") opts.out = val();
    else if (a === "--ext") opts.ext = val();
    else if (a === "--timeout-min") opts.timeoutMin = val();
    else if (a === "--allow-host-ollama") opts.allowHost = true;
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    else bad(`unknown argument: ${a}`);
  }
}
const OUT = path.resolve(opts.out || path.join(__dirname, "results", "os-install-check"));
const EXT = path.resolve(opts.ext || path.join(REPO, "dist", "proofer"));
const TIMEOUT_MIN = opts.timeoutMin === null ? 35 : Number(opts.timeoutMin);
if (!Number.isFinite(TIMEOUT_MIN) || TIMEOUT_MIN <= 0) bad(`--timeout-min must be a positive number, not ${opts.timeoutMin}`);
if (!fs.existsSync(path.join(EXT, "manifest.json"))) bad(`no packaged extension at ${EXT}: run  node tools/package.mjs  first`);
const pkg = verifyPackage(EXT);
if (!pkg.ok) bad(`${EXT} does not match its own SHA256SUMS.txt (${pkg.reason}): rebuild it with  node tools/package.mjs`);
if (fs.existsSync(OUT) && !fs.statSync(OUT).isDirectory()) bad(`--out ${OUT} is a file`);
if (process.platform === "linux" && !opts.allowHost) {
  const external = Object.entries(os.networkInterfaces())
    .filter(([, addrs]) => (addrs || []).some((a) => !a.internal)).map(([name]) => name);
  if (external.length) {
    bad(`Refusing: this Linux machine has network interfaces (${external.join(", ")}), so the Ollama on 11434 is not\n`
      + `a private one. Run inside a namespace with a private Ollama (TESTING.md §32), or pass --allow-host-ollama.`);
  }
}
fs.mkdirSync(OUT, { recursive: true });

// --- What happened, written whatever happens ------------------------------------------
const T0 = Date.now();
const since = () => Date.now() - T0;
const stamp = () => `[${(since() / 1000).toFixed(1).padStart(7)} s]`;
const log = (msg) => console.log(`${stamp()} ${msg}`);
const checks = [];
const ok = (cond, label) => {
  checks.push({ label, ok: !!cond });
  console.log(`${stamp()} ${cond ? "PASS" : "FAIL"}  ${label}`);
  return !!cond;
};
const consoleLines = [];
const summary = {
  check: "os-install-check", startedAt: new Date(T0).toISOString(),
  os: { platform: process.platform, release: os.release(), arch: os.arch(), version: os.version ? os.version() : null,
    cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model || null, memoryGB: Math.round(os.totalmem() / 1e9 * 10) / 10,
    runner: process.env.RUNNER_NAME || null, image: process.env.ImageOS || null, imageVersion: process.env.ImageVersion || null },
  node: process.version, chrome: null, extension: { dir: EXT, files: pkg.count, version: null },
  pinned: null, ollamaVersion: null, engineBefore: null, engineAfter: null,
  verdict: null, finalScreen: null, screens: [], timings: {}, typing: null, reports: {}, checks, failure: null, exitCode: null,
};
const writeJson = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + "\n");

// --- Ollama, asked directly ---------------------------------------------------------------
function getJson(url, ms = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(ms, () => { req.destroy(); resolve(null); });
  });
}
async function engineState(tag) {
  const r = await getJson(`${OLLAMA}/api/tags`);
  if (!r || !r.json || !Array.isArray(r.json.models)) return { known: false };
  const m = r.json.models.find((x) => x && (x.name === tag || x.model === tag));
  return { known: true, installed: !!m, digest: m ? String(m.digest || "").replace(/^sha256[:-]/, "") : null };
}

// --- The run --------------------------------------------------------------------------------
let browser = null;
let pageServer = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-os-install-"));

const GOOD = new Set(["ready", "too-slow"]);
const BAD_NOW = new Set(["unexpected", "operational", "interrupted"]);
// Screens that wait for a person: a failure here once they have held this long,
// because Ollama was confirmed running before Chrome started.
const STUCK = new Set(["install-needed", "update-needed", "not-ollama", "unsupported", "paused"]);
const STUCK_MS = 30_000;
const SAVE_BUTTON = { ready: "saveReport", "too-slow": "saveReportSlow", unexpected: "saveReportOdd", operational: "saveReportOps" };

async function main() {
  // The pin, from the package that is installed -- never from this checkout.
  const bg = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
  const PIN = { tag: (bg.match(/tag: "([^"]+)"/) || [])[1], digest: (bg.match(/digest: "([0-9a-f]{64})"/) || [])[1] };
  summary.pinned = PIN;
  summary.extension.version = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).version;
  log(`Proofer ${summary.extension.version} from ${EXT}; engine ${PIN.tag} ${PIN.digest && PIN.digest.slice(0, 12)}…`);
  log(`${summary.os.platform} ${summary.os.release} ${summary.os.arch}, ${summary.os.cpus} logical CPUs, ${summary.os.memoryGB} GB`);

  // [0] Ollama must already be running: this checks setup, not Ollama's installer.
  let v = null;
  for (let i = 0; i < 30 && !v; i++) { v = await getJson(`${OLLAMA}/api/version`, 3000); if (!v) await sleep(1000); }
  summary.ollamaVersion = v && v.json ? v.json.version : null;
  if (!ok(!!summary.ollamaVersion, `Ollama answers on 127.0.0.1:11434 (${summary.ollamaVersion})`)) {
    summary.failure = "ollama-not-running";
    return;
  }
  summary.engineBefore = await engineState(PIN.tag);
  log(`engine before setup: ${summary.engineBefore.installed ? `installed, ${summary.engineBefore.digest.slice(0, 12)}…` : "not installed"}`);

  // [1] Install: a fresh profile, the packaged extension.
  const chrome = await resolveChrome();
  const profile = fs.mkdtempSync(path.join(tmp, "profile-"));
  const downloads = fs.mkdtempSync(path.join(tmp, "downloads-"));
  const tLaunch = since();
  browser = await puppeteer.launch({
    headless: true, executablePath: chrome.path, protocolTimeout: 180_000,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", `--user-data-dir=${profile}`,
      "--no-first-run", "--disable-infobars", "--window-size=1200,900"],
  });
  summary.chrome = { source: chrome.source, version: await browser.version() };
  log(`${summary.chrome.version} (${chrome.source})`);
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  const dls = [];
  cdp.on("Browser.downloadWillBegin", (e) => dls.push({ guid: e.guid, name: e.suggestedFilename, state: null }));
  cdp.on("Browser.downloadProgress", (e) => { const d = dls.find((x) => x.guid === e.guid); if (d) d.state = e.state; });

  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"),
    { timeout: 60_000 }).catch(() => null);
  if (!ok(!!swTarget, "the extension's service worker started")) { summary.failure = "no-service-worker"; return; }
  const extId = new URL(swTarget.url()).host;
  const WELCOME = `chrome-extension://${extId}/welcome.html`;
  const sw0 = await swTarget.worker();
  sw0.on("console", (m) => consoleLines.push(`${stamp()} [worker] ${m.type()}: ${m.text()}`));

  let welcome = null;
  for (let i = 0; i < 120 && !welcome; i++) {
    welcome = (await browser.pages()).find((p) => p.url() === WELCOME) || null;
    if (!welcome) await sleep(250);
  }
  summary.timings.setupOpenedMs = welcome ? since() - tLaunch : null;
  if (!ok(!!welcome, `install opened setup by itself (${summary.timings.setupOpenedMs} ms after launch)`)) {
    // Not the product's path any more, but the rest still says something.
    welcome = await browser.newPage();
    await welcome.goto(WELCOME);
  }
  welcome.on("console", (m) => consoleLines.push(`${stamp()} [setup] ${m.type()}: ${m.text()}`));
  welcome.on("pageerror", (e) => consoleLines.push(`${stamp()} [setup] pageerror: ${e.message}`));

  // [2] Hands off until setup reaches a final screen. Every screen change is
  // logged inside the page by a MutationObserver on the attribute setup stamps
  // (`data-screen`), so a screen shorter than one poll is still recorded -- a
  // download that fails at once lasts ~100 ms. Only what is on screen at a
  // poll can be photographed; a screen that came and went says so.
  const timeoutMs = TIMEOUT_MIN * 60_000;
  const launchEpoch = T0 + tLaunch;
  let last = null, enteredAt = 0, lastProgressShot = 0, lastDlLog = 0, lastDl = null, lastTest = null, evalErrors = 0;
  const shot = (name) => welcome.screenshot({ path: path.join(OUT, name), fullPage: true }).catch((e) => log(`screenshot ${name}: ${e.message}`));
  for (;;) {
    if (since() - tLaunch > timeoutMs) { summary.failure = `timeout:${last}`; break; }
    let st;
    try {
      st = await welcome.evaluate(() => {
        if (!window.__prooferScreens) {
          const seen = window.__prooferScreens = [];
          const note = () => seen.push({ screen: document.body.dataset.screen || null, t: Date.now() });
          note();
          new MutationObserver(note).observe(document.body, { attributes: true, attributeFilter: ["data-screen"] });
        }
        return {
          events: window.__prooferScreens.splice(0),
          screen: document.body.dataset.screen || null,
          dl: (document.getElementById("dlText") || {}).textContent || null,
          test: (document.getElementById("testText") || {}).textContent || null,
        };
      });
      evalErrors = 0;
    } catch (e) {
      if (welcome.isClosed() || ++evalErrors > 30) { summary.failure = `setup-page-lost:${e.message}`; break; }
      await sleep(1000);
      continue;
    }
    const now = since();
    const fresh = [];
    for (const ev of st.events) {
      if (!ev.screen || ev.screen === last) continue;
      last = ev.screen;
      enteredAt = ev.t - T0;
      const entry = { screen: last, atMs: ev.t - launchEpoch };
      summary.screens.push(entry);
      fresh.push(entry);
    }
    for (const entry of fresh) {
      const live = entry === fresh.at(-1) && st.screen === entry.screen;
      if (!live) entry.screenshot = false;
      log(`screen: ${entry.screen}${live ? "" : " (gone before it could be photographed)"}`);
      if (live) { await shot(`${String(summary.screens.indexOf(entry) + 1).padStart(2, "0")}-${entry.screen}.png`); lastProgressShot = now; }
    }
    if (last === "downloading" && st.dl !== lastDl && (now - lastDlLog > 20_000 || /Finishing/.test(st.dl || ""))) {
      log(`  download: ${st.dl}`); lastDl = st.dl; lastDlLog = now;
    }
    if (last === "testing" && st.test !== lastTest) { log(`  speed check: ${st.test}`); lastTest = st.test; }
    if ((last === "downloading" || last === "testing") && now - lastProgressShot > 300_000) {
      await shot(`${String(summary.screens.length).padStart(2, "0")}-${last}-progress.png`);
      lastProgressShot = now;
    }
    if (GOOD.has(last) || BAD_NOW.has(last)) break;
    if (STUCK.has(last) && now - enteredAt > STUCK_MS) break;
    await sleep(500);
  }
  summary.finalScreen = last;
  const at = (s) => (summary.screens.find((x) => x.screen === s) || {}).atMs ?? null;
  const after = (s) => { const i = summary.screens.findIndex((x) => x.screen === s); return i >= 0 && summary.screens[i + 1] ? summary.screens[i + 1].atMs : null; };
  const span = (s) => (at(s) !== null && after(s) !== null ? after(s) - at(s) : null);
  Object.assign(summary.timings, { downloadMs: span("downloading"), verifyMs: span("verifying"),
    speedCheckMs: GOOD.has(last) || last === "unexpected" || last === "operational" ? span("testing") : null,
    toFinalScreenMs: summary.screens.length ? summary.screens[summary.screens.length - 1].atMs : null });
  const lastEntry = summary.screens[summary.screens.length - 1];
  if (lastEntry && lastEntry.screenshot === false) await shot(`${String(summary.screens.length).padStart(2, "0")}-${last}-final.png`);
  // The observer goes in at the first poll, a few hundred ms after setup
  // opened; whatever it showed before that is not knowable from here.
  if (summary.screens.length && summary.screens[0].screen !== "checking") {
    summary.screensNote = `the first screen watched was "${summary.screens[0].screen}"; any before it passed before the page could be watched`;
  }
  if (last === "interrupted" || last === "operational") {
    const why = await welcome.evaluate((s) => (document.getElementById(s === "interrupted" ? "interruptedWhy" : "operationalWhy") || {}).textContent || null, last).catch(() => null);
    summary.finalScreenWhy = why;
    log(`  ${last}: ${why}`);
  }

  ok(GOOD.has(last), `setup reached a final verdict screen that is not a failure (${last})`);
  ok(!summary.screens.some((s) => ["install-needed", "update-needed", "not-ollama", "unsupported"].includes(s.screen)),
    "setup found the running Ollama without asking for it");

  // [3] The engine: setup downloads it when it is not there, and what is there after is the pin.
  summary.engineAfter = await engineState(PIN.tag);
  const needed = !(summary.engineBefore.installed && summary.engineBefore.digest === PIN.digest);
  summary.downloaded = summary.screens.some((s) => s.screen === "downloading");
  if (needed) ok(summary.downloaded, "the engine was missing, and setup started the download itself");
  ok(summary.engineAfter.installed && summary.engineAfter.digest === PIN.digest,
    `the engine installed now is the pinned digest (${summary.engineAfter.digest && summary.engineAfter.digest.slice(0, 12)}…)`);

  // [4] The verdict, as the worker stored it (read through the setup page, which
  // has storage access and keeps no worker awake on our behalf).
  const stored = await welcome.evaluate(() => new Promise((r) => chrome.storage.local.get(["setupQualification", "sentenceMode"], r))).catch(() => null);
  const q = stored && stored.setupQualification;
  if (q) {
    writeJson("verdict.json", q);
    summary.verdict = { category: q.category, pass: q.pass, reason: q.reason, ollamaVersion: q.ollamaVersion,
      backend: q.backend, calibration: q.calibration, numbers: q.numbers, durationMs: q.durationMs,
      cases: (q.cases || []).length,
      outcomes: (q.cases || []).reduce((m, c) => ({ ...m, [c.outcome]: (m[c.outcome] || 0) + 1 }), {}) };
    log(`verdict: ${q.category}${q.reason ? ` (${q.reason})` : ""}, ${q.backend && q.backend.kind}${q.backend && q.backend.numThread ? ` ${q.backend.numThread} threads` : ""}, `
      + `first ${q.numbers && q.numbers.firstMs} ms, warm p50 ${q.numbers && q.numbers.warmP50} / p95 ${q.numbers && q.numbers.warmP95} / max ${q.numbers && q.numbers.warmMax} ms, `
      + `after idle ${q.numbers && q.numbers.afterIdleMs} ms, long ${q.numbers && q.numbers.longMs} ms (dropped ${q.numbers && q.numbers.longDropped}); outcomes ${JSON.stringify(summary.verdict.outcomes)}`);
  }
  if (GOOD.has(last)) {
    ok(!!q && q.category === (last === "ready" ? "pass" : "too-slow") && q.digest === PIN.digest && q.ollamaVersion === summary.ollamaVersion,
      `the stored verdict is this screen's, for the pinned engine and this Ollama (${q && q.category})`);
  }

  // [5] The test report: the worker's, asked the way the page asks, and the file
  // the page's own button saves. Neither may hold a sentence, site, address or path.
  const fixtures = await (async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const t = browser.targets().find((x) => x.type() === "service_worker" && x.url().endsWith("/background.js"));
        if (t) return await (await t.worker()).evaluate(() => SETUP_FIXTURES.map((f) => [f.text, f.fixed, f.host, f.priorContext]));
      } catch {}
      await welcome.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "SETUP_STATUS" }, () => r()))).catch(() => {});
      await sleep(1000);
    }
    return null;
  })();
  const forbidden = [...new Set([...(fixtures || []).flat(), "localhost", "127.0.0.1", "11434", "We recieved the invoice",
    os.homedir(), EXT, OUT, tmp].filter((s) => typeof s === "string" && s.length >= 4))];
  const leaks = (text) => forbidden.filter((s) => text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1))).map((s) => s.slice(0, 40));
  ok(!!fixtures, "the worker's fixtures were readable, so the reports can be checked for text");
  const rep = await welcome.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: "SETUP_REPORT" }, r))).catch(() => null);
  if (ok(!!(rep && rep.ok && rep.report), "SETUP_REPORT answered the setup page")) {
    writeJson("setup-report.json", rep.report);
    const text = JSON.stringify(rep.report);
    const l = leaks(text);
    summary.reports.worker = { category: rep.report.result && rep.report.result.category, leaks: l };
    ok(l.length === 0, `the test report holds no sentence, site, address or path${l.length ? ` (found: ${JSON.stringify(l)})` : ""}`);
    // Equal when both are absent too: a download that stopped leaves no verdict.
    ok((rep.report.result ? rep.report.result.category : null) === (q ? q.category : null),
      `the test report's result is the stored verdict (${q ? q.category : "none stored"})`);
  }
  if (SAVE_BUTTON[last]) {
    await welcome.bringToFront();
    const before = dls.length;
    let saved = null;
    try {
      await welcome.click(`#${SAVE_BUTTON[last]}`);
      await welcome.waitForSelector("#reportDialog[open]", { timeout: 5000 });
      await welcome.click('#reportDialog button[value="save"]');
      for (let i = 0; i < 150 && !(dls[before] && dls[before].state === "completed"); i++) await sleep(100);
      if (dls[before] && dls[before].state === "completed") saved = fs.readFileSync(path.join(downloads, dls[before].name), "utf8");
    } catch (e) { log(`Save test report: ${e.message}`); }
    if (ok(!!saved, `"Save test report" on the ${last} screen saved a file (${dls[before] && dls[before].name})`)) {
      fs.writeFileSync(path.join(OUT, "setup-report-saved.json"), saved);
      let parsed = null;
      try { parsed = JSON.parse(saved); } catch {}
      const l = leaks(saved);
      summary.reports.saved = { file: dls[before].name, category: parsed && parsed.result && parsed.result.category, computer: parsed && parsed.computer, leaks: l };
      ok(!!parsed && parsed.result && q && parsed.result.category === q.category, "...holding the stored verdict");
      ok(l.length === 0, `...and no sentence, site, address or path${l.length ? ` (found: ${JSON.stringify(l)})` : ""}`);
    }
  }

  // [6] Ready: Turn on, then a typo typed on an ordinary page is corrected.
  if (last === "ready") await turnOnAndType(welcome, PIN);
  else summary.typing = { skipped: `verdict ${last}` };
}

async function turnOnAndType(welcome, PIN) {
  await welcome.bringToFront();
  await welcome.click("#turnOn");
  const on = await welcome.waitForFunction(() => !document.getElementById("onNote").hidden, { timeout: 10_000 }).then(() => true).catch(() => false);
  ok(on, "Turn on: setup says Proofer is on");
  await welcome.screenshot({ path: path.join(OUT, `${String(summary.screens.length).padStart(2, "0")}-ready-turned-on.png`), fullPage: true }).catch(() => {});
  if (!on) { summary.typing = { skipped: "turn-on-failed" }; return; }

  pageServer = http.createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html lang="en"><body style="padding:20px"><textarea id="ta" style="width:560px;height:140px;font:14px monospace"></textarea></body></html>');
  });
  await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${pageServer.address().port}/`, { waitUntil: "networkidle0" });
  await sleep(1500);
  await page.click("#ta");
  await sleep(300);
  // At a person's pace, not a robot's: the first keystroke's warmup has the
  // time to load the engine that the speed check's own burst case assumes
  // (SETUP_FIRST_DELAY_MS, 6 s from the first keystroke to the finished
  // sentence). Typed in 30 ms per key, a cold engine on a slow machine misses
  // the 5 s lease and the correction is dropped -- sentence-e2e-test.mjs's
  // documented cold-load sensitivity, which is not what this checks.
  const first = "We recieved the invoice yesterday.";
  const tType = Date.now();
  await page.keyboard.type(first, { delay: Math.ceil(6000 / first.length) });
  await page.keyboard.type(" Then we", { delay: 30 });
  const typedMs = Date.now() - tType;
  const tEnd = Date.now();
  let text = "";
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    text = await page.evaluate(() => document.querySelector("#ta").value);
    if (text.includes("received")) break;
  }
  const correctedAfterMs = text.includes("received") ? Date.now() - tEnd : null;
  await page.screenshot({ path: path.join(OUT, `${String(summary.screens.length + 1).padStart(2, "0")}-typed-on-a-page.png`) }).catch(() => {});
  let rec = null;
  for (let i = 0; i < 3 && !rec; i++) {
    try {
      const t = browser.targets().find((x) => x.type() === "service_worker" && x.url().endsWith("/background.js"));
      rec = t ? await (await t.worker()).evaluate(async () => {
        const all = (await readLogRecords()).filter((x) => x.path === "sentence");
        const r = all[all.length - 1];
        return r ? { n: all.length, verdict: r.verdict, error: r.error || null, guard: r.guard || null,
          trigger: r.trigger, modelDigest: r.modelDigest, wallMs: r.timings ? r.timings.wallMs : null } : { n: 0 };
      }) : null;
    } catch { await sleep(1000); }
  }
  summary.typing = { typedMs, correctedAfterMs, landed: text === "We received the invoice yesterday. Then we", record: rec };
  ok(summary.typing.landed, `the typo typed on a page was corrected (${correctedAfterMs} ms after the last key)`);
  ok(!!rec && rec.verdict === "sentence-applied" && rec.modelDigest === PIN.digest,
    `...recorded as applied, by the pinned engine (${rec && rec.verdict}, ${rec && rec.modelDigest && rec.modelDigest.slice(0, 12)}…)`);
}

let code = 1;
try {
  await main();
  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  code = GOOD.has(summary.finalScreen) && allOk && !summary.failure ? 0 : 1;
  if (code && !summary.failure) {
    summary.failure = !GOOD.has(summary.finalScreen) ? `final-screen:${summary.finalScreen}`
      : `check:${(checks.find((c) => !c.ok) || {}).label}`;
  }
} catch (e) {
  console.error(e);
  summary.failure = `script-error:${e && e.message}`;
  code = 1;
} finally {
  summary.timings.totalMs = since();
  summary.exitCode = code;
  writeJson("summary.json", summary);
  fs.writeFileSync(path.join(OUT, "console.txt"), consoleLines.join("\n") + "\n");
  if (browser) await browser.close().catch(() => {});
  if (pageServer) pageServer.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
const failed = checks.filter((c) => !c.ok).length;
console.log("\n" + "=".repeat(72));
console.log(`final screen: ${summary.finalScreen}; verdict: ${summary.verdict ? summary.verdict.category : "none"}; `
  + `${checks.length - failed} checks passed, ${failed} failed${summary.failure ? `; failure: ${summary.failure}` : ""}`);
console.log(`artifacts: ${OUT}`);
process.exit(code);
