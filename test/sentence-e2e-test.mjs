/**
 * Sentence mode end to end: the REAL extension, the REAL service worker, the
 * REAL model. No stubs.
 *
 *   cd test && node sentence-e2e-test.mjs
 *
 * sentence-typing-test.mjs stubs chrome.* so it can drive the machinery with
 * canned corrections. That leaves the two things a stub cannot prove: that the
 * consent round trip actually grants anything through a real service worker
 * (sender.tab.url -> SENTENCE_CONSENT -> sentenceModeState), and that a real
 * model response survives the guards and lands in the field.
 *
 * Prerequisites: Ollama running with the configured model pulled.
 */
import puppeteer from "puppeteer";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { resolveChrome } from "./lib/chrome.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  cond ? pass++ : fail++;
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (req.url === "/embedded") {
    res.end(`<!doctype html><html lang="en"><body>
<iframe src="${EDITOR_ORIGIN}/" style="width:700px;height:300px"></iframe>
</body></html>`);
    return;
  }
  res.end(`<!doctype html><html lang="en"><body style="padding:20px">
<textarea id="ta" style="width:560px;height:140px;font:14px monospace"></textarea>
</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const editorServer = http.createServer(server.listeners("request")[0]);
await new Promise((r) => editorServer.listen(0, "127.0.0.1", r));
const EDITOR_ORIGIN = `http://127.0.0.1:${editorServer.address().port}`;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-sentence-e2e-"));
// Chrome for Testing first: this suite side-loads the unpacked extension, and
// branded Chrome >= 137 ignores --load-extension without saying so.
const chromePath = (await resolveChrome()).path;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: chromePath,
  // Above the speed-check wait below (240 s): a waitForFunction is ONE protocol
  // call, so a 120 s protocol timeout silently cut that wait to 120 s and a CPU
  // check (~140 s on 8 cores) read as "timeout" (found 2026-10-01).
  protocolTimeout: 300_000,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--disable-infobars", "--window-size=1280,900",
  ],
});

try {
console.log("\nSentence mode end to end (real extension, real model)\n" + "=".repeat(72));

// Since beta step 3c/3d nothing writes without a passing speed check, and a
// fresh install opens setup by itself. So this run is the product's own first
// run: the setup tab finds the real Ollama, sees the pinned engine installed
// (it must be, under that tag and digest), runs the real speed check through
// the worker against the real model, and offers Turn on -- which is clicked
// there, the way a user would. Then the per-site list is cleared so a previous
// run's switch-off cannot leak in. The origin is named nowhere: the point of
// the opt-out model is that a site nobody has heard of is on.
const swTarget = await browser.waitForTarget(
  (t) => t.type() === "service_worker" && t.url().includes("background.js"), { timeout: 30000 });
const sw = await swTarget.worker();
const extId = new URL(swTarget.url()).host;
let welcome = null;
for (let i = 0; i < 60 && !welcome; i++) {
  welcome = (await browser.pages()).find((p) => p.url() === `chrome-extension://${extId}/welcome.html`) || null;
  if (!welcome) await sleep(250);
}
ok(!!welcome, "install opened setup by itself");
console.log("  ...  setup runs the real speed check (about a minute)");
const setupState = welcome ? await welcome.waitForFunction(
  () => ["ready", "too-slow", "unexpected", "operational", "interrupted", "install-needed"].includes(document.body.dataset.screen),
  { timeout: 240000 }).then(() => welcome.evaluate(() => document.body.dataset.screen))
  .catch((e) => /Waiting failed|exceeded/.test(String(e)) ? "timeout" : `error: ${e.message}`) : "none";
ok(setupState === "ready", `the real speed check passes on this machine (${setupState})`);
if (setupState === "ready") {
  await welcome.bringToFront();
  await welcome.click("#turnOn");
  await welcome.waitForFunction(() => !document.getElementById("onNote").hidden, { timeout: 10000 }).catch(() => {});
}
const settings = await sw.evaluate(async () => {
  await setSettings({ sentenceModeDisabledSites: [] });
  return getSettings();
});
ok(!!settings && settings.sentenceMode === true && settings.qualified === true,
   "Turn on in setup: the worker has sentenceMode on and a passing verdict");
if (settings && settings.qualification && settings.qualification.numbers) {
  const n = settings.qualification.numbers;
  console.log(`  ...  verdict: ${settings.qualification.backend.kind}, first ${n.firstMs} ms, warm p50 ${n.warmP50} / p95 ${n.warmP95} / max ${n.warmMax} ms, after idle ${n.afterIdleMs} ms`);
}
const allowedHere = await sw.evaluate(async (origin) =>
  sentenceModeState(await getSettings(), origin), ORIGIN);
ok(!!allowedHere && allowedHere.allowed === true && allowedHere.apply === true,
   `the worker allows a site it was never told about (${JSON.stringify(allowedHere)})`);

const page = await browser.newPage();
page.on("pageerror", (e) => console.error("  PAGE ERROR:", e.message));
await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle0" });
await sleep(1500);
ok(await page.evaluate(() => !!document.querySelector("#ta")), "test page loaded");

// A misspelling the core suite already proves this model fixes, so a failure
// here is the plumbing rather than the model.
await page.click("#ta");
await sleep(300);
await page.keyboard.type("We recieved the invoice yesterday. Then we", { delay: 30 });

// One request is ~250ms, but a cold model pays a load and the service worker
// may need waking.
let text = "";
for (let i = 0; i < 60; i++) {
  await sleep(250);
  text = await page.evaluate(() => document.querySelector("#ta").value);
  if (text.includes("received")) break;
}

ok(text === "We received the invoice yesterday. Then we",
   `the real model's correction landed behind the caret: ${JSON.stringify(text)}`);
const caret = await page.evaluate(() => {
  const el = document.querySelector("#ta");
  return { s: el.selectionStart, e: el.selectionEnd, len: el.value.length };
});
ok(caret.s === caret.len && caret.e === caret.len,
   `caret still at the end (${caret.s}/${caret.len})`);

// The whole round trip is logged under its own path and its own ring.
const rec = await sw.evaluate(async () => {
  const sent = (await readLogRecords()).filter((x) => x.path === "sentence");
  return { n: sent.length, last: sent[sent.length - 1] || null };
});
ok(rec.n >= 1, `the sentence path wrote a log record (${rec.n})`);
ok(!!rec.last && rec.last.id.startsWith("sn_"),
   `record routed to the sentence ring (id ${rec.last && rec.last.id})`);
ok(!!rec.last && rec.last.verdict === "sentence-applied",
   `verdict recorded (${rec.last && rec.last.verdict})`);
// The trigger crosses two process boundaries -- content script to worker in the
// request payload, worker to storage in the record -- and one guard now reads
// it, so a dropped field is a changed verdict and not just a thinner log. No
// stubbed suite can see this: deleting either write leaves every other suite
// green. Asserted as the SPECIFIC value, not merely "one of the three": the
// keystrokes above type three characters past the terminator with no pause, so
// `next-sentence` is the only correct answer and "some label arrived" would
// pass even if the evidence were being read backwards.
ok(!!rec.last && rec.last.trigger === "next-sentence",
   `trigger recorded, and it is the one the keystrokes justify (${JSON.stringify(rec.last && rec.last.trigger)})`);
// Which weights answered, as the worker SAW them installed before it sent:
// the pinned digest, from a real Ollama's /api/tags. The stubbed suites script
// that answer; this is the one run where it comes from the model store.
const pin = await sw.evaluate(() => ({ ...PINNED_MODEL, revision: PROMPT_REVISION }));
ok(!!rec.last && rec.last.modelDigest === pin.digest && rec.last.model === pin.tag
   && rec.last.promptRevision === pin.revision,
   `the record names the pinned model, its digest and the prompt revision (${rec.last && rec.last.modelDigest})`);

// Switching the site off has to bite without a page reload -- this is the
// path that writes. Sent exactly as the popup's Save sends it: a membership
// toggle on the disabled list.
await sw.evaluate(async (origin) =>
  setSettings({ sentenceDisabledSiteToggle: { origin, enabled: true } }), ORIGIN);
await sleep(600);
const before = await page.evaluate(() => document.querySelector("#ta").value);
await page.keyboard.type(" definately shipped it. Then more", { delay: 30 });
await sleep(4000);
const after = await page.evaluate(() => document.querySelector("#ta").value);
ok(after === before + " definately shipped it. Then more",
   `nothing was written after the site was switched off: ${JSON.stringify(after.slice(-34))}`);

// --- embedded editor inherits top-level consent --------------------------
// Mutant: insert `if (window !== window.top) return;` in handleFocusIn;
// the allowed-parent correction and active embedded status assertions turn red.
console.log("\nembedded editor inherits top-level consent");

// Open the shipping popup document in a background tab so tabs.query still
// identifies the parent. All messages use the real extension APIs and worker.
async function popupView(parent) {
  await parent.bringToFront();
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extId}/popup.html`, background: true,
  });
  try {
    const target = await browser.waitForTarget(t => t._targetId === targetId);
    const popup = await target.page();
    // Keep the terminal text and its class in the same observed snapshot: a
    // permission refresh can start between the wait and a separate evaluate.
    const terminal = await popup.waitForFunction(() => {
      const el = document.getElementById("sentenceWhere");
      const text = el.textContent;
      return text && !text.startsWith("Checking")
        ? { text, green: el.classList.contains("ok") } : false;
    }, { polling: 100, timeout: 10000 });
    try { return await terminal.jsonValue(); }
    finally { await terminal.dispose(); }
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
    await cdp.detach();
  }
}

for (const key of ["disabledSites", "sentenceModeDisabledSites"]) {
  await sw.evaluate(async ({ key, editor }) => {
    await setSettings({ disabledSites: [], sentenceModeDisabledSites: [], [key]: [editor] });
  }, { key, editor: EDITOR_ORIGIN });
  const parent = await browser.newPage();
  await parent.goto(`${ORIGIN}/embedded`, { waitUntil: "networkidle0" });
  const frame = parent.frames().find(f => f.url() === `${EDITOR_ORIGIN}/`);
  ok(!!frame && new URL(frame.url()).origin !== ORIGIN, `${key}: editor has a different origin from parent`);
  const tabId = await sw.evaluate(async url =>
    (await chrome.tabs.query({})).find(t => t.url === url).id, parent.url());
  const status = () => sw.evaluate(id => chrome.tabs.sendMessage(id, { type: "SENTENCE_STATUS" }), tabId);
  const logCount = () => sw.evaluate(async () => (await readLogRecords()).filter(r => r.path === "sentence").length);
  await frame.click("#ta");
  await sleep(300);
  const active = await status();
  ok(active.top === false && active.status === "active" && active.apply === true,
    `${key}: allowed parent grants active embedded status despite frame exclusion`);
  await parent.keyboard.type("We recieved the invoice yesterday. Then we", { delay: 30 });
  await frame.waitForFunction(() => document.querySelector("#ta").value.includes("received"),
    { timeout: 15000 }).catch(() => {});
  ok(await frame.$eval("#ta", el => el.value) === "We received the invoice yesterday. Then we",
    `${key}: allowed-parent correction lands in excluded embedded editor`);
  let popup = await popupView(parent);
  ok(popup.green && popup.text.includes("Running"),
    `${key}: allowed-parent popup reports running (${popup.text})`);

  await sw.evaluate(async ({ key, parent, editor }) =>
    setSettings({ [key]: [editor, parent] }), { key, parent: ORIGIN, editor: EDITOR_ORIGIN });
  await sleep(600);
  const denied = await status();
  ok(denied.top === false && denied.status === "off" && denied.detail === "not-allowed" && denied.apply === false,
    `${key}: top-level switch-off revokes embedded status without reload`);
  const beforeCount = await logCount();
  await parent.bringToFront();
  await frame.click("#ta");
  await parent.keyboard.type(" definately shipped it. Then more", { delay: 30 });
  await sleep(4000);
  ok(await frame.$eval("#ta", el => el.value) === "We received the invoice yesterday. Then we definately shipped it. Then more",
    `${key}: revoked embedded editor leaves subsequent typo untouched`);
  ok(await logCount() === beforeCount, `${key}: revoked embedded editor sends no logged rewrite`);
  popup = await popupView(parent);
  ok(!popup.green && popup.text === `Not running here: Proofer is disabled on ${ORIGIN}.`,
    `${key}: disabled-parent popup names the parent (${popup.text})`);
  await parent.close();

  const reopened = await browser.newPage();
  await reopened.goto(`${ORIGIN}/embedded`, { waitUntil: "networkidle0" });
  const blockedFrame = reopened.frames().find(f => f.url() === `${EDITOR_ORIGIN}/`);
  await blockedFrame.click("#ta");
  await sleep(300);
  const reopenedTabId = await sw.evaluate(async url =>
    (await chrome.tabs.query({})).find(t => t.url === url).id, reopened.url());
  const blocked = await sw.evaluate(id => chrome.tabs.sendMessage(id, { type: "SENTENCE_STATUS" }), reopenedTabId);
  ok(blocked.top === false && blocked.status === "off" && blocked.detail === "not-allowed" && blocked.apply === false,
    `${key}: reopening a disabled parent refuses embedded attachment`);
  await reopened.keyboard.type("We recieved the invoice yesterday. Then we", { delay: 30 });
  await sleep(4000);
  ok(await blockedFrame.$eval("#ta", el => el.value) === "We recieved the invoice yesterday. Then we",
    `${key}: reopened disabled parent leaves typo untouched`);
  ok(await logCount() === beforeCount, `${key}: reopened disabled parent sends no logged rewrite`);
  await reopened.close();
}

} finally {
  await browser.close();
  server.close();
  editorServer.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

console.log("\n" + "=".repeat(72));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
