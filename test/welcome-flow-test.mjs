// Setup, end to end: the REAL setup page and service worker
// in Chrome, against a scripted fake Ollama on the default address.
//
// It must own 127.0.0.1:11434, because a fresh install opens setup by itself
// against the default Ollama address -- so it runs inside a network namespace
// where nothing else does, exactly as CI's browser job runs every suite:
//
//   unshare -rn sh -c 'ip link set lo up && node welcome-flow-test.mjs'
//
// Run outside one with an Ollama on 11434, it refuses (exit 2) rather than
// drive the real one.
//
// What is pinned, in order:
//   [1] install opens setup by itself; with Ollama absent it asks for Ollama,
//       in plain words, with the installer steps for this OS
//   [2] Ollama appears: the page carries on with no click, and the download
//       starts by itself, with progress
//   [3] a cut connection mid-download: the "download stopped" screen; Try again
//       resumes from where it stopped (the fake counts the resumed bytes)
//   [4] the download is checked and the speed check runs by itself -- through
//       the worker, the fixtures and the pinned engine -- to the ready screen,
//       with the logging copy, the refresh note, and no Turn on done for you
//   [5] nothing is written before Turn on: a typo typed on a page stays
//   [6] Turn on from setup; the same typo is now corrected
//   [7] an Ollama update mid-field: the next sentence is not corrected, the
//       badge says why, and setup reopened shows the check running again
//   [8] Pause is a real state: it survives reopening setup, and Resume carries
//       on the partial download
//   [9] Ollama too old: the update screen; something else on the port: its own
//       screen; a too-slow or unexpected verdict: its own screen with Retry
//       and Save report
//  [10] Ready's "Run the speed check again" runs a NEW check to a new verdict
//  [11] a real failure and recovery: Ollama stops in the middle of a retest;
//       the check says so, the stored verdict and the saved report are that
//       failure and not the pass before it, and Try again with Ollama back is
//       Ready again (checkpoint 3: failures were only ever seeded)
//  [12] the long-context case dropped at the deadline (owner, 2026-09-25): the
//       check still passes, and Ready says what that means in use
// [9b-c] direct retests obey the worker floor; failed status messages stop
// [14-16] unknown inventory, fresh post-pull verification and real action recovery
// [17a-b] answered-error wording and missing-engine operational recovery
//  [18] the real toolbar popup distinguishes a live check from an interrupted
//       one after closing setup and stopping/restarting the service worker
//
//   PROOFER_RESULT_JSON=<path>  writes the per-row results

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

let pass = 0;
const failures = [];
const rows = [];
const ok = (cond, label) => {
  rows.push({ label, ok: !!cond });
  if (cond) { pass++; console.log(`  PASS  ${label}`); } else { failures.push(label); console.log(`  FAIL  ${label}`); }
};

// --- The port must be ours -------------------------------------------------------
const taken = await new Promise((resolve) => {
  const probe = http.get("http://127.0.0.1:11434/api/version", () => resolve(true));
  probe.on("error", () => resolve(false));
  probe.setTimeout(500, () => { probe.destroy(); resolve(false); });
});
if (taken) {
  console.log("Something already answers on 127.0.0.1:11434 (a real Ollama?). Run this inside a network namespace:\n"
    + "  unshare -rn sh -c 'ip link set lo up && node welcome-flow-test.mjs'");
  process.exit(2);
}

// --- The extension -----------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-flow-"));
const EXT = path.join(tmp, "proofer");
execFileSync(process.execPath, [path.join(REPO, "tools", "package.mjs"), "--out", EXT], { stdio: "ignore" });
const bgSrc = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const PIN = {
  tag: bgSrc.match(/tag: "([^"]+)"/)[1],
  digest: bgSrc.match(/digest: "([0-9a-f]{64})"/)[1],
  size: Number(bgSrc.match(/sizeBytes: (\d+)/)[1]),
  floor: bgSrc.match(/const OLLAMA_MIN_VERSION = "([^"]+)"/)[1],
};

// --- A scripted Ollama ---------------------------------------------------------------
// The worker's SETUP_FIXTURES are read out of the running worker once it is up,
// so the fake answers each fixture the way the pinned engine does.
const FAKE_TEMPLATE = "{{- range .Messages }}<|{{ .Role }}|>{{ .Content }}{{ end }}";
const fake = {
  up: true, version: "0.35.0", installed: false, digest: PIN.digest, loaded: false,
  pulled: 0,                 // bytes "on disk" of a partial pull, for resume
  cutAfter: null,            // cut the connection after this many bytes, once
  pullStepMs: 40, pullSteps: 25,
  notOllama: false, tagsStatus: 200, warmupStatus: 200, loads: 0, unloads: 0, events: [],
  answers: new Map(),        // sentence -> answer
  delays: new Map(),         // sentence -> ms before answering
  chats: [], pulls: 0, resumedFrom: [], pullsClosed: new Set(),
};
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, "http://x");
  if (fake.notOllama) { res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>not ollama</h1>"); return; }
  if (!fake.up) { req.socket.destroy(); return; }
  switch (url.pathname) {
    case "/api/version": return send(res, 200, { version: fake.version });
    case "/api/tags":
      fake.events.push(`tags:${fake.digest}`);
      return send(res, fake.tagsStatus, fake.tagsStatus !== 200 ? { error: "synthetic inventory error" } : { models: fake.installed
        ? [{ name: PIN.tag, model: PIN.tag, digest: fake.digest, size: PIN.size }] : [] });
    case "/api/ps": return send(res, 200, { models: fake.loaded
      ? [{ name: PIN.tag, model: PIN.tag, size: 2e9, size_vram: 2e9 }] : [] });
    case "/api/generate":
      fake.unloads++;
      if (body && body.keep_alive === 0) fake.loaded = false;
      return send(res, 200, { done: true });
    case "/api/show":
      fake.events.push("show");
      return send(res, 200, { template: FAKE_TEMPLATE,
        parameters: "temperature 0.1\ntop_k 20\ntop_p 0.8\nnum_ctx 2048\nrepeat_penalty 1" });
    case "/api/pull": {
      const pullId = ++fake.pulls;
      fake.resumedFrom.push(fake.pulled);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // Chrome's reader rejects before this server necessarily sees the
      // cancellation. Bytes can advance in between; the partial download is
      // stable only after this response's close event.
      let gone = false;
      res.on("close", () => { gone = true; fake.pullsClosed.add(pullId); });
      const line = (o) => res.write(JSON.stringify(o) + "\n");
      line({ status: "pulling manifest" });
      const layer = `sha256:${"1".repeat(64)}`;
      const step = Math.ceil(PIN.size / fake.pullSteps);
      while (fake.pulled < PIN.size) {
        await sleep(fake.pullStepMs);
        if (gone) return;
        fake.pulled = Math.min(PIN.size, fake.pulled + step);
        // Two lines per write, split mid-line: the page must parse NDJSON
        // across chunk boundaries.
        const s = JSON.stringify({ status: "pulling 1111", digest: layer, total: PIN.size, completed: fake.pulled }) + "\n";
        res.write(s.slice(0, 17));
        res.write(s.slice(17));
        if (fake.cutAfter !== null && fake.pulled >= fake.cutAfter) { fake.cutAfter = null; res.socket.destroy(); return; }
      }
      line({ status: "verifying sha256 digest" });
      line({ status: "writing manifest" });
      fake.installed = true; fake.digest = PIN.digest;
      fake.events.push("pull-complete");
      line({ status: "success" });
      res.end();
      return;
    }
    case "/api/chat": {
      fake.loaded = true;
      if (!body.messages.length) {
        fake.loads++; fake.events.push("load");
        return send(res, fake.warmupStatus, fake.warmupStatus !== 200 ? { error: "synthetic load error" }
          : { done: true, done_reason: "load", load_duration: 9e8, message: { content: "" } });
      }
      const text = body.messages[body.messages.length - 1].content;
      fake.chats.push(text);
      if (fake.delays.has(text)) await sleep(fake.delays.get(text));
      const answer = fake.answers.has(text) ? fake.answers.get(text) : text;
      return send(res, 200, { message: { content: JSON.stringify({ rewritten: answer }) }, done_reason: "stop",
        total_duration: 2e8, load_duration: 0, prompt_eval_count: 300, eval_count: 20 });
    }
  }
  send(res, 404, { error: "not found" });
});
let listening = false;
const startOllama = () => new Promise((r) => { if (listening) return r(); server.listen(11434, "127.0.0.1", () => { listening = true; r(); }); });

// A plain page to type into, on another loopback origin.
const pageServer = http.createServer((q, s) => { s.setHeader("content-type", "text/html");
  s.end('<!doctype html><html lang="en"><body><textarea id="ta" rows="6" cols="60"></textarea></body></html>'); });
await new Promise((r) => pageServer.listen(0, "127.0.0.2", r));
const PAGE = `http://127.0.0.2:${pageServer.address().port}/`;

// --- The browser ---------------------------------------------------------------------
const ud = fs.mkdtempSync(path.join(tmp, "profile-"));
const browser = await puppeteer.launch({ headless: true, executablePath: (await resolveChrome()).path,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
    `--user-data-dir=${ud}`, "--no-first-run", "--window-size=1200,900"] });
const done = async (code) => {
  await browser.close().catch(() => {});
  server.close(); pageServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.env.PROOFER_RESULT_JSON) fs.writeFileSync(process.env.PROOFER_RESULT_JSON, JSON.stringify(rows, null, 2));
  console.log("\n" + "=".repeat(72));
  console.log(`${pass} passed, ${failures.length} failed`);
  process.exit(code);
};

console.log("\nSetup, end to end\n" + "=".repeat(72));

const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30000 });
let sw = await swTarget.worker();
// The worker's target can be attached before background.js has finished
// running, and then its top-level constants do not exist yet: on CI's slower
// runner this test died at once with "PINNED_MODEL is not defined" (every run
// since it joined the browser job). Wait until the script has run.
for (let i = 0; ; i++) {
  const up = await sw.evaluate(() => typeof PINNED_MODEL !== "undefined" && typeof SETUP_FIXTURES !== "undefined").catch(() => false);
  if (up) break;
  if (i >= 150) { console.error("the worker never finished loading background.js"); process.exit(1); }
  await sleep(100);
}
const extId = new URL(swTarget.url()).host;
const WELCOME = `chrome-extension://${extId}/welcome.html`;
const sha = (t) => import("crypto").then((c) => c.createHash("sha256").update(t).digest("hex"));
// The fake's template is a stand-in, so the worker is told its hash. Nothing
// else about the worker is touched.
await sw.evaluate((h) => { PINNED_MODEL.templateSha256 = h; }, await sha(FAKE_TEMPLATE));
for (const fx of await sw.evaluate(() => SETUP_FIXTURES.map((f) => ({ text: f.text, fixed: f.fixed })))) {
  fake.answers.set(fx.text, fx.fixed ?? fx.text);
}
fake.answers.set("We recieved the invoice yesterday.", "We received the invoice yesterday.");
const CASES = await sw.evaluate(() => SETUP_CASE_COUNT);
const LONG_TEXT = await sw.evaluate(() => SETUP_FIXTURES.find((f) => f.long).text);

// [1] setup opened by itself on install, and Ollama is absent.
let welcome = null;
for (let i = 0; i < 40 && !welcome; i++) {
  welcome = (await browser.pages()).find((p) => p.url() === WELCOME) || null;
  if (!welcome) await sleep(250);
}
ok(!!welcome, "[1] install opens the setup page by itself");
if (!welcome) await done(1);
const stateOf = (p = welcome) => p.evaluate(() => document.body.dataset.screen || null);
const waitState = async (want, ms = 20000, p = welcome) => {
  const until = Date.now() + ms;
  let s = null;
  while (Date.now() < until) { s = await stateOf(p).catch(() => null); if ((Array.isArray(want) ? want : [want]).includes(s)) return s; await sleep(100); }
  return s;
};
ok(await waitState("install-needed") === "install-needed", "[1] with Ollama absent, it asks for Ollama");
const copy = await welcome.evaluate(() => document.querySelector('[data-state="install-needed"]').innerText);
ok(/Proofer needs Ollama running/.test(copy) && /Get Ollama/.test(copy) && !/model|digest|num_thread/i.test(copy),
  "[1] ...in plain words, with no model, digest or thread talk");
ok(await welcome.evaluate(() => document.querySelectorAll("#installSteps li").length) >= 2, "[1] ...and the installer steps for this OS");

// [2] Ollama appears; no click.
fake.cutAfter = Math.floor(PIN.size * 0.4);
await startOllama();
ok(await waitState(["downloading", "interrupted"], 8000) !== "install-needed", "[2] Ollama appears: the page carries on with no click");
const sawProgress = await welcome.waitForFunction(() => /of .* GB/.test(document.getElementById("dlText").textContent),
  { timeout: 8000 }).then(() => true).catch(() => false);
ok(sawProgress, "[2] ...and the download starts by itself, with progress");

// [3] the cut connection, then Try again resumes.
ok(await waitState("interrupted", 15000) === "interrupted", "[3] a cut connection stops the download, and says so");
const partial = fake.pulled;
await welcome.click("#retryDownload");
ok(await waitState(["verifying", "testing"], 20000) !== "interrupted", "[3] Try again carries on");
ok(fake.resumedFrom[fake.resumedFrom.length - 1] === partial && partial > 0,
  `[3] ...from where it stopped (${fake.resumedFrom.map((b) => Math.round(b / 1e6) + "MB").join(" → ")})`);

// [4] verified, checked, ready -- with nothing turned on for the user.
ok(await waitState("testing", 20000) === "testing", "[4] the download is checked and the speed check starts by itself");
console.log("  ...  the speed check runs (about 40 s: two bursts and the idle pause)");
ok(await waitState(["ready", "too-slow", "unexpected", "operational"], 120000) === "ready", "[4] the speed check passes and setup is ready");
const ready = await welcome.evaluate(() => ({
  text: document.querySelector('[data-state="ready"]').innerText,
  turnOn: !document.getElementById("turnOnActions").hidden,
  pin: !document.getElementById("pinBox").hidden,
  longNote: !document.getElementById("longNote").hidden,
}));
ok(ready.turnOn && /Turn on/.test(ready.text), "[4] ...offering Turn on, not doing it");
ok(/keeps a log on this computer/.test(ready.text) && /400 characters/.test(ready.text), "[4] ...saying what the log holds");
ok(/already open/.test(ready.text) && /refresh/.test(ready.text), "[4] ...and that pages open from before need one refresh");
ok(ready.pin, "[4] ...and how to pin Proofer (headless is never pinned)");
ok(!ready.longNote, "[4] ...and nothing about long documents, when nothing was dropped");
const q = await sw.evaluate(async () => (await getSettings()).qualification);
ok(q && q.pass === true && q.cases.length === CASES, `[4] the worker stored a passing verdict over all ${CASES} cases (${q && q.cases.length})`);

// [4b] Save test report: the page's dialog, the file it saves, and what is in
// it -- timings, versions, hardware the browser can tell, the optional model
// name typed in the dialog, and no sentence, answer or address.
// Mutant: setupReport returns `reportVersion: 1`.
// Red: [4b] saved report v2 separates attempt identity from current build.
const dlDir = fs.mkdtempSync(path.join(tmp, "downloads-"));
const cdp = await browser.target().createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir });
await welcome.click("#saveReport");
await welcome.waitForSelector("#reportDialog[open]", { timeout: 3000 });
await welcome.type("#laptopModel", "Test Laptop 1");
await welcome.click('#reportDialog button[value="save"]');
let reportFile = null;
for (let i = 0; i < 50 && !reportFile; i++) {
  reportFile = fs.readdirSync(dlDir).find((f) => /^proofer-test-report-.*\.json$/.test(f)) || null;
  if (!reportFile) await sleep(100);
}
ok(!!reportFile, `[4b] Save test report saves a file (${reportFile})`);
if (reportFile) {
  const text = fs.readFileSync(path.join(dlDir, reportFile), "utf8");
  const rep = JSON.parse(text);
  ok(rep.result && rep.result.pass === true && rep.result.cases.length === CASES && rep.model.digest === PIN.digest,
    "[4b] ...with the result, every case and the engine");
  ok(rep.reportVersion === 2 && rep.model.tag === "jayafowler/proofer:v1-q4"
    && rep.model.digest === "f920607a347881f5a3482ec8a9d6ea621d9a6f7ea7c27b7372e31d8e4f54b320"
    && rep.promptRevision === "sentence-v1" && rep.benchmarkRevision === "speed-v2" && rep.ollamaVersion === "0.35.0"
    && rep.currentBuild?.model.tag === "jayafowler/proofer:v1-q4"
    && rep.currentBuild?.model.digest === "f920607a347881f5a3482ec8a9d6ea621d9a6f7ea7c27b7372e31d8e4f54b320"
    && rep.currentBuild?.promptRevision === "sentence-v1" && rep.currentBuild?.benchmarkRevision === "speed-v2"
    && rep.result.bounds?.warmP95Ms === 3500 && rep.result.bounds?.caseMaxMs === 4500
    && rep.result.bounds?.longContext === "may-drop" && Object.keys(rep.result.bounds).length === 3,
    "[4b] saved report v2 separates attempt identity from current build and carries stored bounds");
  ok(rep.laptopModel === "Test Laptop 1" && typeof rep.computer.logicalCores === "number",
    `[4b] ...the optional model typed in the dialog, and what the browser can tell (${rep.computer.logicalCores} cores)`);
  ok(![...fake.answers.keys()].some((t) => text.includes(t)) && !text.includes("localhost") && !text.includes("11434"),
    "[4b] ...and no sentence, no answer and no address");
}

// [5] nothing is written before Turn on.
const typer = await browser.newPage();
await typer.goto(PAGE);
await typer.click("#ta");
await typer.keyboard.type("We recieved the invoice yesterday. Then we", { delay: 20 });
await sleep(2500);
ok(await typer.$eval("#ta", (e) => e.value) === "We recieved the invoice yesterday. Then we",
  "[5] before Turn on, a typo typed on a page stays");
ok(!fake.chats.includes("We recieved the invoice yesterday."), "[5] ...and it was never even sent");

// [6] Turn on, then the same typo is corrected.
await welcome.bringToFront();
await welcome.click("#turnOn");
ok(await welcome.waitForFunction(() => !document.getElementById("onNote").hidden, { timeout: 5000 }).then(() => true).catch(() => false),
  "[6] Turn on from setup: Proofer is on");
await typer.bringToFront();
await typer.goto(PAGE);
await typer.click("#ta");
await typer.keyboard.type("We recieved the invoice yesterday. Then we", { delay: 20 });
let fixed = "";
for (let i = 0; i < 40; i++) { await sleep(200); fixed = await typer.$eval("#ta", (e) => e.value); if (fixed.includes("received")) break; }
ok(fixed === "We received the invoice yesterday. Then we", `[6] ...and the typo is corrected (${JSON.stringify(fixed)})`);

// [7] Ollama updated while typing in the same field.
fake.version = "0.40.0";
await sw.evaluate(() => { versionCache = null; });
const chatsBefore = fake.chats.length;
await typer.keyboard.type(" shipped it on tuesday. Anoter one.", { delay: 20 });
await sleep(2500);
const after = await typer.$eval("#ta", (e) => e.value);
ok(!/Another/.test(after) && fake.chats.length === chatsBefore,
  `[7] after an Ollama update, the next sentence is not sent or corrected (${JSON.stringify(after.slice(-24))})`);
const badge = await sw.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }));
ok(badge.text === "!" && /updated/.test(badge.title), `[7] ...the badge says why (${JSON.stringify(badge)})`);
await welcome.bringToFront();
await welcome.reload();
ok(await waitState(["testing", "ready"], 15000) === "testing", "[7] ...and setup reopened runs the check again by itself");
await welcome.close();

// [8] Pause survives reopening; Resume carries on.
await sw.evaluate(async () => { await chrome.storage.local.remove(["setupQualification", "setupPaused"]); });
fake.installed = false; fake.pulled = 0; fake.version = "0.35.0"; fake.pullStepMs = 120;
const w2 = await browser.newPage();
await w2.goto(WELCOME);
ok(await waitState("downloading", 15000, w2) === "downloading", "[8] reopened with no engine: the download starts");
await sleep(500);
const pausedPull = fake.pulls;
await w2.click("#pauseBtn");
ok(await waitState("paused", 5000, w2) === "paused", "[8] Pause stops it");
// The UI's paused state acknowledges the reader abort, not the fake server's
// close event. Taking pausedAt before that event raced one last chunk on CI,
// falsely blaming reopening and Resume for bytes already in flight.
const closeDeadline = Date.now() + 5000;
while (!fake.pullsClosed.has(pausedPull) && Date.now() < closeDeadline) await sleep(10);
ok(fake.pullsClosed.has(pausedPull) && fake.pulled < PIN.size, "[8] ...and closes the unfinished download request");
const pausedAt = fake.pulled;
await w2.reload();
await sleep(3000);
ok(await stateOf(w2) === "paused" && fake.pulls === pausedPull && fake.pulled === pausedAt,
  "[8] ...and reopening setup does not restart it");
fake.pullStepMs = 20;
await w2.click("#resumeBtn");
ok(["verifying", "testing"].includes(await waitState(["verifying", "testing"], 20000, w2)), "[8] Resume carries on");
ok(fake.pulls === pausedPull + 1 && fake.resumedFrom[fake.resumedFrom.length - 1] === pausedAt
  && pausedAt > 0 && pausedAt < PIN.size, "[8] ...from the partial download");
await w2.close();

// [9] the other screens.
const screenFor = async (label, prep, want) => {
  await prep();
  const p = await browser.newPage();
  await p.goto(WELCOME);
  const s = await waitState(want, 10000, p);
  ok(s === want, `[9] ${label}: the "${want}" screen (${s})`);
  const buttons = await p.evaluate(() => [...document.querySelectorAll(`[data-state="${document.body.dataset.screen}"] button`)].map((b) => b.textContent.trim()));
  await p.close();
  return buttons;
};
await screenFor("Ollama too old", async () => { fake.version = "0.1.0"; }, "update-needed");
fake.version = "0.35.0";
await screenFor("something else on the port", async () => { fake.notOllama = true; }, "not-ollama");
fake.notOllama = false;
fake.installed = true;
const seed = (v) => sw.evaluate(async (v) => {
  const s = await getSettings();
  await chrome.storage.local.set({ setupQualification: { v: 1, pass: false, category: v.category, reason: v.reason,
    ollamaUrl: s.ollamaUrl, ollamaVersion: "0.35.0", tag: PINNED_MODEL.tag, digest: PINNED_MODEL.digest,
    promptRevision: PROMPT_REVISION, benchmarkRevision: SETUP_BENCHMARK_REVISION, options: { num_thread: null }, cases: [] } });
}, v);
for (const [category, reason] of [["too-slow", null], ["unexpected", null]]) {
  const b = await screenFor(`a failed check (${category})`, () => seed({ category, reason }), category);
  ok(b.some((x) => /again|Try/.test(x)) && b.some((x) => /Save test report/.test(x)),
    `[9] ...with a Retry and Save test report (${JSON.stringify(b)})`);
}

// [10] Ready's retest: a new check, a new verdict. Starts from a stored pass,
// which setup shows as Ready without running anything.
await sw.evaluate(async () => {
  const s = await getSettings();
  await chrome.storage.local.set({ setupQualification: { v: 1, runId: "seeded", pass: true, category: "pass", reason: null,
    ollamaUrl: s.ollamaUrl, ollamaVersion: "0.35.0", tag: PINNED_MODEL.tag, digest: PINNED_MODEL.digest,
    promptRevision: PROMPT_REVISION, benchmarkRevision: SETUP_BENCHMARK_REVISION, options: { num_thread: null },
    backend: { kind: "gpu", numThread: null }, cases: [], date: 1 } });
});
fake.installed = true; fake.version = "0.35.0"; fake.up = true;
const w3 = await browser.newPage();
await w3.goto(WELCOME);
ok(await waitState("ready", 15000, w3) === "ready", "[10] a stored pass: setup shows Ready, running nothing");
await w3.click("#retestReady");
ok(await waitState("testing", 5000, w3) === "testing", "[10] Run the speed check again: the check runs");
console.log("  ...  the speed check runs again (about 40 s)");
ok(await waitState(["ready", "too-slow", "unexpected", "operational"], 120000, w3) === "ready", "[10] ...to Ready");
const q10 = await sw.evaluate(async () => (await getSettings()).qualification);
ok(q10 && q10.pass === true && q10.runId !== "seeded" && q10.cases.length === CASES,
  `[10] ...and the stored verdict is the new run's (${q10 && q10.runId})`);

// [11] A real failure in the middle of a retest, then recovery.
await w3.click("#retestReady");
ok(await waitState("testing", 5000, w3) === "testing", "[11] a second retest starts");
await sleep(3000);
fake.up = false;
ok(await waitState(["operational", "ready", "too-slow", "unexpected"], 60000, w3) === "operational",
  "[11] Ollama stopping mid-check: the check couldn't finish");
ok(/stopped answering/.test(await w3.$eval("#operationalWhy", (e) => e.textContent)), "[11] ...saying Ollama stopped");
const q11 = await sw.evaluate(async () => { const s = await getSettings(); return { q: s.qualification, qualified: s.qualified }; });
ok(q11.qualified === false && q11.q.pass === false && q11.q.category === "operational" && q11.q.reason === "ollama-stopped"
  && q11.q.runId !== q10.runId,
  `[11] ...stored as that failure, not the pass before it (${JSON.stringify({ category: q11.q.category, reason: q11.q.reason })})`);
// CDP's "allow" writes over a file of the same name (the date is in it), so
// the download is awaited by its completion event and read back by name.
const dlDone = [];
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir, eventsEnabled: true });
cdp.on("Browser.downloadWillBegin", (e) => dlDone.push({ guid: e.guid, name: e.suggestedFilename, state: null }));
cdp.on("Browser.downloadProgress", (e) => { const d = dlDone.find((x) => x.guid === e.guid); if (d) d.state = e.state; });
await w3.click("#saveReportOps");
await w3.waitForSelector("#reportDialog[open]", { timeout: 3000 });
await w3.click('#reportDialog button[value="save"]');
for (let i = 0; i < 50 && !(dlDone[0] && dlDone[0].state === "completed"); i++) await sleep(100);
const rep11 = dlDone[0] && dlDone[0].state === "completed"
  ? JSON.parse(fs.readFileSync(path.join(dlDir, dlDone[0].name), "utf8")) : null;
ok(rep11 && rep11.result && rep11.result.pass === false && rep11.result.reason === "ollama-stopped",
  `[11] ...and the saved report is the failed attempt (${rep11 && JSON.stringify({ pass: rep11.result.pass, reason: rep11.result.reason })})`);
fake.up = true;
// [12] rides on this run: the long-context sentence misses the deadline.
fake.delays.set(LONG_TEXT, 5500);
await w3.click("#retestOps");
console.log("  ...  Ollama back; the check runs again (about 45 s)");
ok(await waitState(["ready", "too-slow", "unexpected", "operational"], 120000, w3) === "ready",
  "[11] Ollama back, Try again: Ready");
ok((await sw.evaluate(async () => (await getSettings()).qualified)) === true, "[11] ...and qualified again");
const q12 = await sw.evaluate(async () => (await getSettings()).qualification);
ok(q12 && q12.pass === true && q12.numbers.longDropped === 1 && q12.cases.find((c) => c.long).outcome === "expired",
  `[12] the long-context case dropped at the deadline, and the check still passed (${q12 && JSON.stringify(q12.numbers)})`);
const note12 = await w3.evaluate(() => ({ shown: !document.getElementById("longNote").hidden,
  text: document.getElementById("longNote").textContent }));
ok(note12.shown && /skip/.test(note12.text) && /as you typed/.test(note12.text),
  `[12] ...and Ready says so, in plain words (${note12.shown})`);
await w3.close();

// [13] Qualification does not complete a rejected settings migration.
// Mutant: disable showReady's upgrading-reason override in welcome.js.
// Red: [13] Ready explains the incomplete upgrade (instead of just the pass).
// Reject only the stamp write; qualification still uses the shipping writer.
const raw13 = await sw.evaluate(async () => {
  const q = (await getSettings()).qualification;
  await chrome.storage.local.set({ settingsVersion: 4, sentenceMode: true, sentenceModeApply: false });
  globalThis.__migrationStorageSet = storageSet;
  globalThis.__migrationRejects = 0;
  storageSet = async (obj) => {
    if (Object.prototype.hasOwnProperty.call(obj, "settingsVersion")) {
      globalThis.__migrationRejects++;
      throw new Error("injected migration write failure");
    }
    return globalThis.__migrationStorageSet(obj);
  };
  try { await migrateSettings(); } catch {}
  await storeQualification(q);
  return { raw: await chrome.storage.local.get(["settingsVersion", "sentenceMode", "sentenceModeApply"]),
    qualified: (await getSettings()).qualified, rejected: globalThis.__migrationRejects };
});
ok(raw13.rejected === 1 && raw13.qualified === true && raw13.raw.settingsVersion === 4
  && raw13.raw.sentenceMode === true && raw13.raw.sentenceModeApply === false,
  "[13] migration failed, qualification persisted, and the legacy inputs survived");
const w13 = await browser.newPage();
try {
  await w13.goto(WELCOME);
  ok(await waitState("ready", 15000, w13) === "ready", "[13] a qualified legacy install reaches Ready");
  const v = await w13.evaluate(() => ({ lead: document.getElementById("readyLead").textContent,
    title: document.getElementById("readyTitle").textContent,
    on: !document.getElementById("onNote").hidden, turnOn: !document.getElementById("turnOnActions").hidden }));
  ok(/still being upgraded/.test(v.lead), "[13] Ready explains the incomplete upgrade");
  ok(!v.on && v.title === "Ready" && v.turnOn, "[13] no on claim, and the explicit Turn on action remains");
  await sw.evaluate(() => { storageSet = globalThis.__migrationStorageSet; });
  await w13.click("#turnOn");
  ok(await w13.waitForFunction(() => !document.getElementById("onNote").hidden
    && document.getElementById("readyTitle").textContent === "Proofer is on", { timeout: 5000 }).then(() => true).catch(() => false),
    "[13] Turn on retries migration and reaches the on state");
  const final = await sw.evaluate(async () => chrome.storage.local.get(["settingsVersion", "sentenceMode", "sentenceModeApply"]));
  ok(final.settingsVersion === 5 && final.sentenceMode === true,
    `[13] retry persisted the v5 stamp and explicit consent (${JSON.stringify(final)})`);
} finally {
  await sw.evaluate(() => { storageSet = globalThis.__migrationStorageSet; delete globalThis.__migrationStorageSet; delete globalThis.__migrationRejects; });
  await w13.close();
}

// [18] A real MV3 restart loses the live run, but not its stored history.
// Mutant: settingsForPage uses `qualification: settings.qualification`.
// Red: [18] restarted popup shows interrupted wording and no running wording.
// The live control opens the actual toolbar popup, with no chrome.* stubs.
fake.delays.delete(LONG_TEXT);
const w18 = await browser.newPage();
await w18.goto(WELCOME);
ok(await waitState("ready", 15000, w18) === "ready", "[18] the previous pass opens Ready");
await w18.click("#retestReady");
ok(await waitState("testing", 5000, w18) === "testing", "[18] a real check starts");
const openToolbarPopup = async (problem = true) => {
  await sw.evaluate(() => chrome.action.openPopup());
  const target = await browser.waitForTarget((t) => t.url() === `chrome-extension://${extId}/popup.html`, { timeout: 10000 });
  // Chrome exposes a toolbar popup as an "other" target, not a tab.
  const page = await target.asPage();
  if (problem) await page.waitForFunction(() => document.getElementById("setupLineText")?.textContent, { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById("engineLine")?.textContent !== "Checking…", { timeout: 10000 });
  return page;
};
const screenshotPopup = async (p, name) => {
  if (!process.env.PROOFER_SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.PROOFER_SCREENSHOT_DIR, { recursive: true });
  await p.screenshot({ path: path.join(process.env.PROOFER_SCREENSHOT_DIR, name), fullPage: true });
};
const livePopup = await openToolbarPopup();
const liveText = await livePopup.$eval("#setupLineText", (e) => e.textContent);
ok(liveText === "The speed check hasn't finished. Open setup to see it or run it again.",
  `[18] live popup shows running wording (${liveText})`);
await screenshotPopup(livePopup, "popup-live.png");
await livePopup.close();
await w18.close();
const stored18 = await sw.evaluate(async () => (await chrome.storage.local.get("setupQualification")).setupQualification);
ok(stored18.category === "running" && stored18.pass === false, "[18] closing setup leaves the running attempt stored");

const workerCDP = await typer.createCDPSession();
const versions18 = new Map();
workerCDP.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
  for (const v of versions) versions18.set(v.versionId, v);
});
await workerCDP.send("ServiceWorker.enable");
const waitWorker18 = async (predicate) => {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const v = [...versions18.values()].find((v) => v.scriptURL === `chrome-extension://${extId}/background.js` && predicate(v));
    if (v) return v;
    await sleep(50);
  }
  throw new Error("[18] service worker lifecycle transition timed out");
};
await waitWorker18((v) => v.runningStatus === "running");
// close() stops the worker AND detaches Puppeteer's debugger. stopWorker alone
// leaves Chrome reusing the old target and Puppeteer holding a dead context.
await sw.close();
await waitWorker18((v) => v.runningStatus === "stopped");
await workerCDP.send("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${extId}/` });
const restartedTarget = await browser.waitForTarget((t) => t !== swTarget && t.type() === "service_worker"
  && t.url() === `chrome-extension://${extId}/background.js`, { timeout: 10000 });
sw = await restartedTarget.worker();
for (let i = 0; ; i++) {
  if (await sw.evaluate(() => typeof setupRuns !== "undefined").catch(() => false)) break;
  if (i >= 100) throw new Error("[18] restarted worker did not load");
  await sleep(100);
}
ok(await sw.evaluate(() => setupRuns.size === 0), "[18] restarted worker has no live setup run");
const orphanPopup = await openToolbarPopup();
const orphanText = await orphanPopup.$eval("#setupLineText", (e) => e.textContent);
ok(orphanText === "The speed check didn't finish. Open setup to run it again.",
  `[18] restarted popup shows interrupted wording (${orphanText})`);
ok(!orphanText.includes("hasn't finished"), "[18] restarted popup has no running wording");
await screenshotPopup(orphanPopup, "popup-interrupted.png");
const after18 = await sw.evaluate(async () => (await chrome.storage.local.get("setupQualification")).setupQualification);
ok(JSON.stringify(after18) === JSON.stringify(stored18), "[18] opening the restarted popup does not rewrite the stored attempt");
await orphanPopup.close();
await workerCDP.detach();

// G3.2 observation/recovery cases retain this same restarted worker.
await sw.evaluate((h) => { PINNED_MODEL.templateSha256 = h; }, await sha(FAKE_TEMPLATE));
const restorePass = async () => {
  fake.up = true; fake.version = "0.35.0"; fake.installed = true;
  fake.digest = PIN.digest; fake.tagsStatus = 200; fake.warmupStatus = 200;
  await sw.evaluate(async (q) => { await storeQualification(q); }, q10);
};
const openWelcome = async () => { const p = await browser.newPage(); await p.goto(WELCOME); return p; };
const traffic = () => ({ pulls: fake.pulls, loads: fake.loads, chats: fake.chats.length, unloads: fake.unloads });

// [9b] Mutant: remove setupStep probe's worker versionOk refusal.
// Red: a trusted retest after downgrade reaches update-needed, no benchmark traffic.
await restorePass();
await seed({ category: "too-slow", reason: null });
const w9b = await openWelcome();
ok(await waitState("too-slow", 10000, w9b) === "too-slow", "[9b] failed-check screen is open before downgrade");
fake.version = "0.32.5";
const before9b = traffic();
await w9b.click("#retestSlow");
ok(await waitState("update-needed", 10000, w9b) === "update-needed", "[9b] trusted direct retest after downgrade reaches update-needed");
ok(JSON.stringify(traffic()) === JSON.stringify(before9b), "[9b] downgraded retest sends no load/chat/unload/pull requests");
await w9b.close();

// [9c] Mutant: delete refresh's unsuccessful SETUP_STATUS early return.
// Red: initial failed message stays operational, with no pulls/checks.
await restorePass(); fake.installed = false;
const w9c = await browser.newPage();
await w9c.evaluateOnNewDocument(() => {
  const send = chrome.runtime.sendMessage.bind(chrome.runtime);
  let first = true;
  chrome.runtime.sendMessage = (msg, cb) => {
    if (msg.type === "SETUP_STATUS" && first) {
      first = false;
      // Keep observations in the refused reply so bypassing the guard reaches
      // the unsafe action, rather than failing on a missing fixture property.
      send(msg, (r) => cb({ ...r, ok: false }));
    } else send(msg, cb);
  };
});
const before9c = traffic();
await w9c.goto(WELCOME);
ok(await waitState("operational", 7000, w9c) === "operational", "[9c] failed initial status reply shows the failure screen");
await sleep(2300);
ok(JSON.stringify(traffic()) === JSON.stringify(before9c), "[9c] failed initial status reply starts no pulls or checks");
await w9c.close();

// [14] Mutant: refresh's unknown-engine branch calls runDownload().
// Red: HTTP-500 inventory stays checking across polling with zero pulls.
await restorePass(); fake.installed = false; fake.tagsStatus = 500;
const before14 = fake.pulls;
const w14 = await openWelcome();
ok(await waitState("checking", 7000, w14) === "checking", "[14] failed inventory remains checking");
await sleep(4500);
ok(await stateOf(w14) === "checking" && fake.pulls === before14,
  "[14] failed inventory never starts a pull across polling");
fake.tagsStatus = 200; fake.pulled = 0; fake.pullStepMs = 30;
await waitState(["downloading", "verifying", "testing"], 10000, w14);
ok(fake.pulls === before14 + 1, "[14] successful missing inventory automatically downloads");
// "testing" is shown before SETUP_BEGIN and the first worker step finish.
// Closing the page there leaves an in-flight probe that can record its load
// in [15]'s event list. Let this complete run settle before reusing the worker.
ok(await waitState(["ready", "too-slow", "unexpected", "interrupted", "operational"], 120000, w14) === "ready",
  "[14] the completed setup check is idle before the next verification case");
await w14.close();

// [15] Mutant: verifyEngine's digest lookup uses `{ fresh: false }`.
// Red: fast mismatch repair reaches verification and automatic speed check.
await restorePass(); fake.digest = "a".repeat(64); fake.pulled = PIN.size;
await sw.evaluate(async () => { forgetModelDigests(); await installedModelDigest("http://localhost:11434", PINNED_MODEL.tag); });
const before15 = fake.pulls; fake.events.length = 0;
const w15 = await openWelcome();
const state15 = await waitState(["testing", "interrupted", "operational"], 12000, w15);
ok(state15 === "testing" && fake.pulls === before15 + 1, "[15] same-worker fast mismatch pull automatically starts speed check");
const events15 = fake.events.slice();
const pull15 = events15.indexOf("pull-complete"), fresh15 = events15.indexOf(`tags:${PIN.digest}`, pull15 + 1);
const show15 = events15.indexOf("show");
// The page can show testing before its first step finishes: wait for its load.
for (let i = 0; i < 50 && !fake.events.includes("load"); i++) await sleep(100);
ok(pull15 >= 0 && fresh15 > pull15 && show15 > fresh15 && fake.events.indexOf("load") > show15,
  `[15] completed pull precedes fresh tags, show verification and benchmark load (${JSON.stringify(fake.events)})`);
await w15.close();

// [16] Mutant: checkFreshness's recovery publishes only lastOllamaContact="ok".
// Red: the real Chrome action badge/title clears before any sentence compensation.
await restorePass();
await sw.evaluate(async () => { await setupStatus(); });
fake.up = false;
await sw.evaluate(async () => { await checkFreshness(await getSettings(), undefined, { fresh: true }); });
await sleep(100);
const outage16 = await sw.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }));
ok(outage16.text === "!" && outage16.title === "Proofer: Proofer needs Ollama running.", "[16] real action publishes outage");
fake.up = true;
await sw.evaluate(async () => { await checkFreshness(await getSettings(), undefined, { fresh: true }); });
await sleep(100);
const recovery16 = await sw.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }));
ok(recovery16.text === "" && recovery16.title === "Proofer", "[16] same-worker recovery clears the real action badge and title");
const recoveredPopup = await openToolbarPopup(false);
await recoveredPopup.waitForFunction(() => document.getElementById("engineLine").textContent === "installed", { timeout: 10000 });
ok(await recoveredPopup.$eval("#engineLine", (e) => e.textContent) === "installed"
  && await recoveredPopup.$eval("#setupLine", (e) => e.style.display === "none"), "[16] real toolbar popup renders recovered worker engine state");
await screenshotPopup(recoveredPopup, "popup-recovered.png");
await recoveredPopup.close();

// [17a] Mutant: warmup's HTTP failure is ollama-stopped instead of ollama-status.
// Red: actual operational screen explains an answered but unusable response.
await restorePass();
const w17 = await openWelcome();
ok(await waitState("ready", 10000, w17) === "ready", "[17a] installed engine starts at Ready");
fake.warmupStatus = 500;
await w17.click("#retestReady");
ok(await waitState("operational", 10000, w17) === "operational", "[17a] answered warmup error ends the check");
ok(await w17.$eval("#operationalWhy", (e) => e.textContent) === "Ollama answered, but Proofer couldn't read a usable status or response. Restart Ollama and try again.",
  "[17a] answered-error wording does not claim Ollama stopped");

// [17b] Mutant: retestOps always calls runSpeedCheck().
// Red: missing-engine recovery refreshes, pulls, verifies and starts the check.
fake.warmupStatus = 200; fake.installed = false;
await w17.click("#retestOps");
const missing17 = await w17.waitForFunction(() => document.body.dataset.screen === "operational"
  && document.getElementById("operationalWhy").textContent.includes("missing"), { timeout: 10000 }).then(() => true).catch(() => false);
ok(missing17 && (await sw.evaluate(async () => (await getSettings()).qualification)).reason === "engine-missing",
  "[17b] engine removal during retest is a verified missing-engine failure");
const before17 = fake.pulls; fake.events.length = 0;
if (missing17) { await w17.click("#retestOps"); await waitState("testing", 12000, w17); }
// A fast mutant can return to operational before waitState samples testing.
for (let i = 0; i < 100 && !fake.events.includes("show") && (await stateOf(w17)) !== "operational"; i++) await sleep(100);
ok(fake.pulls === before17 + 1 && fake.events.includes("pull-complete") && fake.events.includes("show"),
  "[17b] recovery refresh pulls and verifies the missing engine");
ok(missing17 && await waitState(["testing", "operational", "interrupted"], 10000, w17) === "testing",
  "[17b] verified operational recovery automatically starts speed check");
await w17.close();

await done(failures.length ? 1 : 0);
