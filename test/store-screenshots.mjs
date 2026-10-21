#!/usr/bin/env node
// Chrome Web Store images for the unlisted beta, taken from the REAL extension.
//
//   cd test
//   unshare -rn sh -c 'ip link set lo up && node store-screenshots.mjs'
//
// It packages the extension (tools/package.mjs), installs it in Chrome for
// Testing, and drives the real setup page, service worker, content script and
// popup against a scripted fake Ollama -- the same fake test/welcome-flow-test.mjs
// uses. Like that suite it must own 127.0.0.1:11434, so it runs inside a network
// namespace and refuses (exit 2) anywhere a real Ollama could answer. The
// "webmail" page is served from 127.0.0.2:443 inside the namespace and reached as
// https://mail.example.com through a host-resolver rule, so the popup names a
// plausible site. Nothing leaves the namespace.
//
// Every word in every image is made up here or in background.js's SETUP_DOCS.
// Nothing is read from test/harvested/, a corpus or any log.
//
// Writes into docs/maintainers/store-assets/ (or --out <dir>):
//   screenshot-1-correction.png      1280x800  a correction flashing green in a compose box
//   screenshot-2-setup-ready.png     1280x800  setup's Ready screen after a passing speed check
//   screenshot-3-popup.png           1280x800  the toolbar popup with Recent changes
//   screenshot-4-setup-download.png  1280x800  setup mid-download
//   promo-small-440x280.png           440x280  the small promo tile
//   icon128-store-proposed.png        128x128  ONLY if icons/icon128.png misses the
//                                              store's 96+16 padding guidance: a
//                                              proposal for the dashboard's store-icon
//                                              field. The packaged icon is not touched.
//
// Every image's pixel size is read back from the PNG header and checked; a wrong
// size is exit 1. So is a step that did not happen (no flash, no Ready screen,
// no Recent changes) -- an image of the wrong moment is worse than no image.

import http from "http";
import https from "https";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { resolveChrome } from "./lib/chrome.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(REPO, "docs", "maintainers", "store-assets");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1280, H = 800;
const SITE = "mail.example.com";

const die = (msg, code = 1) => { console.error(`\nFAILED: ${msg}`); process.exit(code); };

// --- The PNG header is the size check ---------------------------------------
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${path.basename(file)} is not a PNG`);
  }
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
const written = [];
function expectSize(file, w, h) {
  const s = pngSize(file);
  if (s.w !== w || s.h !== h) die(`${path.basename(file)} is ${s.w}x${s.h}, expected ${w}x${h}`);
  written.push(`${path.basename(file)}  ${s.w}x${s.h}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  console.log(`  wrote ${path.basename(file)} (${s.w}x${s.h})`);
}

// --- The ports must be ours ---------------------------------------------------
const taken = await new Promise((resolve) => {
  const probe = http.get("http://127.0.0.1:11434/api/version", () => resolve(true));
  probe.on("error", () => resolve(false));
  probe.setTimeout(500, () => { probe.destroy(); resolve(false); });
});
if (taken) {
  die("something already answers on 127.0.0.1:11434 (a real Ollama?). Run this inside a network namespace:\n"
    + "  unshare -rn sh -c 'ip link set lo up && node store-screenshots.mjs'", 2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-shots-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// A throwaway self-signed certificate for the fake webmail site. Chrome is told
// to ignore certificate errors; the cert exists only so the page is https, as a
// real webmail page would be.
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
  "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem"),
  "-subj", `/CN=${SITE}`, "-addext", `subjectAltName=DNS:${SITE}`], { stdio: "ignore" });

// --- The fake webmail page -------------------------------------------------------
// A generic mail client. No real product's name, logo or layout is imitated.
const COMPOSE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>New message - Mail</title>
<style>
  :root { --bg:#f4f6f9; --side:#eceff4; --line:#dde2ea; --text:#1d2733; --muted:#687384;
          --accent:#2f6fde; --card:#fff; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; font:14px/1.45 system-ui, sans-serif; color:var(--text); background:var(--bg);
         display:flex; overflow:hidden; }
  aside { width:220px; flex:none; background:var(--side); border-right:1px solid var(--line); padding:16px 12px; }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:17px; margin:2px 8px 18px; }
  .brand i { width:26px; height:26px; border-radius:7px; background:#3b6fd4; display:inline-block; position:relative; }
  .brand i::after { content:""; position:absolute; left:6px; top:8px; width:14px; height:10px;
                    border:2px solid #fff; border-radius:2px; }
  .newbtn { display:block; width:100%; padding:10px 14px; border-radius:10px; border:0; background:#dbe6fb;
            color:#1b3f8c; font:600 14px system-ui, sans-serif; text-align:left; margin-bottom:14px; }
  nav div { display:flex; justify-content:space-between; padding:7px 12px; border-radius:8px; color:#334155; }
  nav div.on { background:#dde5f3; font-weight:600; color:#1d2733; }
  nav span.n { color:var(--muted); font-size:12px; }
  .col { flex:1; display:flex; flex-direction:column; min-width:0; }
  .top { height:56px; flex:none; display:flex; align-items:center; gap:14px; padding:0 20px;
         border-bottom:1px solid var(--line); background:var(--card); }
  .search { width:440px; height:36px; border-radius:18px; background:var(--bg); border:1px solid var(--line);
            display:flex; align-items:center; padding:0 16px; color:var(--muted); }
  .me { margin-left:auto; width:32px; height:32px; border-radius:50%; background:#c9d7f2; color:#1b3f8c;
        display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; }
  .body { flex:1; display:flex; min-height:0; }
  .list { width:300px; flex:none; background:var(--card); border-right:1px solid var(--line); }
  .list h3 { margin:0; padding:14px 16px 10px; font-size:13px; color:var(--muted); font-weight:600; }
  .msg { padding:10px 16px; border-top:1px solid #eef1f5; }
  .msg b { display:flex; justify-content:space-between; font-size:13.5px; }
  .msg b small { font-weight:400; color:var(--muted); font-size:12px; }
  .msg p { margin:2px 0 0; color:var(--muted); font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .msg.sel { background:#f2f6fd; }
  .pane { flex:1; padding:22px 26px; display:flex; min-width:0; }
  .compose { flex:1; display:flex; flex-direction:column; background:var(--card); border:1px solid var(--line);
             border-radius:12px; box-shadow:0 6px 24px rgba(20,35,60,.08); overflow:hidden; }
  .ch { padding:12px 18px; font-weight:600; background:#f7f9fc; border-bottom:1px solid var(--line); }
  .field { display:flex; align-items:center; padding:9px 18px; border-bottom:1px solid var(--line); }
  .field label { width:62px; color:var(--muted); }
  .field input { flex:1; border:0; font:inherit; color:var(--text); outline:none; background:transparent; }
  textarea { flex:1; border:0; resize:none; outline:none; padding:16px 18px; color:var(--text);
             font:17px/1.65 system-ui, sans-serif; }
  .foot { display:flex; align-items:center; gap:16px; padding:12px 18px; border-top:1px solid var(--line); }
  .send { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:8px 22px; font:600 14px system-ui, sans-serif; }
  .tool { color:var(--muted); font-size:15px; }
</style></head>
<body>
  <aside>
    <div class="brand"><i></i>Mail</div>
    <button class="newbtn">&#9998;&nbsp; New message</button>
    <nav>
      <div class="on">Inbox <span class="n">12</span></div>
      <div>Starred <span class="n"></span></div>
      <div>Sent <span class="n"></span></div>
      <div>Drafts <span class="n">1</span></div>
      <div>Archive <span class="n"></span></div>
      <div>Spam <span class="n"></span></div>
    </nav>
  </aside>
  <div class="col">
    <div class="top"><div class="search">Search mail</div><div class="me">JL</div></div>
    <div class="body">
      <div class="list">
        <h3>Inbox</h3>
        <div class="msg sel"><b>Dana Whitfield <small>9:41 AM</small></b><p>September invoice attached</p></div>
        <div class="msg"><b>Priya Raman <small>9:02 AM</small></b><p>Loading dock hours next week</p></div>
        <div class="msg"><b>Marco Bellini <small>Yesterday</small></b><p>Re: Sample order for the fall catalog</p></div>
        <div class="msg"><b>Harbor Street Books <small>Yesterday</small></b><p>Your order has shipped</p></div>
        <div class="msg"><b>Alex Moreno <small>Tue</small></b><p>Team lunch on Friday?</p></div>
        <div class="msg"><b>Ruth Okafor <small>Mon</small></b><p>Notes from the planning call</p></div>
        <div class="msg"><b>Sam Lee <small>Sep 19</small></b><p>Budget numbers for Q4</p></div>
      </div>
      <div class="pane">
        <div class="compose">
          <div class="ch">Re: September invoice attached</div>
          <div class="field"><label>To</label><input value="Dana Whitfield &lt;dana@example.com&gt;" readonly></div>
          <div class="field"><label>Subject</label><input value="Re: September invoice attached" readonly></div>
          <textarea id="body" spellcheck="false" aria-label="Message body"></textarea>
          <div class="foot"><button class="send">Send</button><span class="tool">&#128206;</span><span class="tool"><b>B</b></span><span class="tool"><i>I</i></span><span class="tool">&#8942;</span></div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

// The email that is typed, and what the fake engine answers for each sentence.
// Anything not listed is answered unchanged, which is what the engine does with
// a clean sentence. The corrected sentences are short on purpose: each is one
// line in the popup's Recent changes, so three of them fit its list unscrolled.
const OPENING = "Hi Dana,\n\nThanks for sending the paperwork over so quickly. ";
const TYPO = "We recieved the invoice yesterday. ";
const NEXT = "Then we'll get it paid by Friday.";
// Typed after the hero shot, one sentence at a time, each followed by the pause
// a person makes. A keystroke inside a correction's 650 ms verification window
// records it as "applied (not verified)", which is honest and not the ordinary
// case worth showing.
const LATER = [
  { text: " The last box arived with a torn label. Cou", wait: "arrived" },
  { text: "ld you check the shiping address on your end?\n\n", wait: "shipping" },
  { text: "Thanks,\nJordan", wait: null },
];
const CORRECTIONS = new Map([
  ["We recieved the invoice yesterday.", "We received the invoice yesterday."],
  ["The last box arived with a torn label.", "The last box arrived with a torn label."],
  ["Could you check the shiping address on your end?", "Could you check the shipping address on your end?"],
]);

const pageServer = https.createServer({
  key: fs.readFileSync(path.join(tmp, "key.pem")), cert: fs.readFileSync(path.join(tmp, "cert.pem")),
}, (q, s) => { s.setHeader("content-type", "text/html; charset=utf-8"); s.end(COMPOSE_HTML); });
await new Promise((resolve) => {
  pageServer.once("error", (e) => die(`cannot listen on 127.0.0.2:443 (${e.code}). Run this inside a network namespace:\n`
    + "  unshare -rn sh -c 'ip link set lo up && node store-screenshots.mjs'", 2));
  pageServer.listen(443, "127.0.0.2", resolve);
});

// --- The extension -----------------------------------------------------------------
const EXT = path.join(tmp, "proofer");
execFileSync(process.execPath, [path.join(REPO, "tools", "package.mjs"), "--out", EXT], { stdio: "ignore" });
const bgSrc = fs.readFileSync(path.join(EXT, "background.js"), "utf8");
const PIN = {
  tag: bgSrc.match(/tag: "([^"]+)"/)[1],
  digest: bgSrc.match(/digest: "([0-9a-f]{64})"/)[1],
  size: Number(bgSrc.match(/sizeBytes: (\d+)/)[1]),
};

// --- A scripted Ollama (as in welcome-flow-test.mjs) ---------------------------------
const FAKE_TEMPLATE = "{{- range .Messages }}<|{{ .Role }}|>{{ .Content }}{{ end }}";
const fake = {
  installed: false, loaded: false, pulled: 0, pullStepMs: 60, pullSteps: 60,
  holdAt: null,              // the pull waits here until released (the mid-download shot)
  answers: new Map(), chats: [],
};
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
// About what the pinned engine takes warm on a desktop GPU, so the popup's
// "median" line reads like a real one rather than like a fake answering at once.
const chatDelay = () => 230 + Math.round(Math.random() * 60);
const ollama = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, "http://x");
  switch (url.pathname) {
    case "/api/version": return send(res, 200, { version: "0.32.12" });
    case "/api/tags": return send(res, 200, { models: fake.installed
      ? [{ name: PIN.tag, model: PIN.tag, digest: PIN.digest, size: PIN.size }] : [] });
    case "/api/ps": return send(res, 200, { models: fake.loaded
      ? [{ name: PIN.tag, model: PIN.tag, size: 2e9, size_vram: 2e9 }] : [] });
    case "/api/generate":
      if (body && body.keep_alive === 0) fake.loaded = false;
      return send(res, 200, { done: true });
    case "/api/show":
      return send(res, 200, { template: FAKE_TEMPLATE,
        parameters: "temperature 0.1\ntop_k 20\ntop_p 0.8\nnum_ctx 2048\nrepeat_penalty 1" });
    case "/api/pull": {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let gone = false;
      res.on("close", () => { gone = true; });
      const line = (o) => res.write(JSON.stringify(o) + "\n");
      line({ status: "pulling manifest" });
      const layer = `sha256:${"1".repeat(64)}`;
      const step = Math.ceil(PIN.size / fake.pullSteps);
      while (fake.pulled < PIN.size) {
        await sleep(fake.pullStepMs);
        while (fake.holdAt !== null && fake.pulled >= fake.holdAt && !gone) await sleep(50);
        if (gone) return;
        fake.pulled = Math.min(PIN.size, fake.pulled + step);
        line({ status: "pulling 1111", digest: layer, total: PIN.size, completed: fake.pulled });
      }
      line({ status: "verifying sha256 digest" });
      line({ status: "writing manifest" });
      fake.installed = true;
      line({ status: "success" });
      res.end();
      return;
    }
    case "/api/chat": {
      fake.loaded = true;
      if (!body.messages.length) return send(res, 200, { done: true, done_reason: "load", load_duration: 9e8, message: { content: "" } });
      const text = body.messages[body.messages.length - 1].content;
      fake.chats.push(text);
      const answer = fake.answers.has(text) ? fake.answers.get(text) : text;
      const ms = chatDelay();
      await sleep(ms);
      return send(res, 200, { message: { content: JSON.stringify({ rewritten: answer }) }, done_reason: "stop",
        total_duration: ms * 1e6, load_duration: 0, prompt_eval_count: 300, eval_count: 20 });
    }
  }
  send(res, 404, { error: "not found" });
});

// --- The browser ---------------------------------------------------------------------
const ud = fs.mkdtempSync(path.join(tmp, "profile-"));
const browser = await puppeteer.launch({
  headless: true, executablePath: (await resolveChrome()).path, acceptInsecureCerts: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox",
    `--user-data-dir=${ud}`, "--no-first-run", `--window-size=${W},${H}`, "--lang=en-US",
    `--host-resolver-rules=MAP ${SITE} 127.0.0.2`, "--ignore-certificate-errors"],
});
const finish = async (code, msg) => {
  await browser.close().catch(() => {});
  ollama.close(); pageServer.close();
  if (msg) die(msg, code);
  process.exit(code);
};
const light = [{ name: "prefers-color-scheme", value: "light" }];

console.log("\nChrome Web Store images\n" + "=".repeat(72));
fs.mkdirSync(OUT, { recursive: true });

const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 30000 });
const sw = await swTarget.worker();
const extId = new URL(swTarget.url()).host;
const WELCOME = `chrome-extension://${extId}/welcome.html`;
const sha = (t) => import("crypto").then((c) => c.createHash("sha256").update(t).digest("hex"));
await sw.evaluate((h) => { PINNED_MODEL.templateSha256 = h; }, await sha(FAKE_TEMPLATE));
for (const fx of await sw.evaluate(() => SETUP_FIXTURES.map((f) => ({ text: f.text, fixed: f.fixed })))) {
  fake.answers.set(fx.text, fx.fixed ?? fx.text);
}
for (const [k, v] of CORRECTIONS) fake.answers.set(k, v);

// --- Setup: the download, then Ready --------------------------------------------------
let welcome = null;
for (let i = 0; i < 40 && !welcome; i++) {
  welcome = (await browser.pages()).find((p) => p.url() === WELCOME) || null;
  if (!welcome) await sleep(250);
}
if (!welcome) await finish(1, "install did not open the setup page");
await welcome.setViewport({ width: W, height: H });
await welcome.emulateMediaFeatures(light);
const stateOf = (p = welcome) => p.evaluate(() => document.body.dataset.screen || null);
const waitState = async (want, ms = 20000, p = welcome) => {
  const until = Date.now() + ms;
  let s = null;
  while (Date.now() < until) { s = await stateOf(p).catch(() => null); if ([].concat(want).includes(s)) return s; await sleep(100); }
  return s;
};
if (await waitState("install-needed") !== "install-needed") await finish(1, "setup did not reach the install-needed screen");

fake.holdAt = Math.floor(PIN.size * 0.46);
await new Promise((r) => ollama.listen(11434, "127.0.0.1", r));
if (await waitState("downloading", 15000) !== "downloading") await finish(1, "setup did not start the download");
const heldAt = Date.now();
while (fake.pulled < fake.holdAt && Date.now() - heldAt < 15000) await sleep(50);
await welcome.waitForFunction(() => /of .* GB/.test(document.getElementById("dlText").textContent), { timeout: 5000 })
  .catch(() => finish(1, "the download screen showed no progress"));
await sleep(500);   // let the progress bar's width transition settle
const dl = path.join(OUT, "screenshot-4-setup-download.png");
await welcome.screenshot({ path: dl });
expectSize(dl, W, H);
fake.holdAt = null;

console.log("  ...  the speed check runs (about 40 s)");
if (await waitState("testing", 30000) !== "testing") await finish(1, "the speed check did not start");
const verdict = await waitState(["ready", "too-slow", "unexpected", "operational"], 150000);
if (verdict !== "ready") await finish(1, `the speed check ended on "${verdict}", not Ready`);
const q = await sw.evaluate(async () => (await getSettings()).qualification);
if (!(q && q.pass === true)) await finish(1, "Ready is showing but the worker holds no passing verdict");
// The Ready card is taller than 800 px at 100%, and cut through its last row of
// buttons it looks broken. So the page is shown at the largest browser zoom at
// which the whole card fits -- the same as the user pressing Ctrl+minus. Each
// candidate is a 16:10 viewport whose device scale factor makes it exactly
// 1280x800 pixels.
const cardBottom = await welcome.evaluate(() =>
  Math.ceil(document.querySelector('[data-state="ready"]').getBoundingClientRect().bottom + window.scrollY));
const zoom = [[1280, 800], [1360, 850], [1440, 900], [1520, 950], [1600, 1000]]
  .find(([, h]) => cardBottom + 20 <= h) || [1600, 1000];
await welcome.setViewport({ width: zoom[0], height: zoom[1], deviceScaleFactor: W / zoom[0] });
console.log(`  Ready card ends at ${cardBottom}px: shown at ${Math.round((100 * W) / zoom[0])}% zoom`);
// The demo loops; take the frame where the correction is shown in green.
await welcome.waitForFunction(() => {
  const f = document.querySelector("#demo .fixed");
  return f && !f.classList.contains("fade");
}, { timeout: 10000, polling: 20 }).catch(() => finish(1, "the Ready demo never showed its correction"));
await sleep(150);
const ready = path.join(OUT, "screenshot-2-setup-ready.png");
await welcome.screenshot({ path: ready });
expectSize(ready, W, H);
await welcome.setViewport({ width: W, height: H });

await welcome.click("#turnOn");
await welcome.waitForFunction(() => !document.getElementById("onNote").hidden, { timeout: 5000 })
  .catch(() => finish(1, "Turn on did not take"));

// --- The hero: a correction flashing green while the next sentence is typed ----------
const mail = await browser.newPage();
await mail.setViewport({ width: W, height: H });
// Reduced motion holds the flash at its full tint for its whole 1600 ms life
// (styles.css) instead of fading after 60% of it -- the colour is the one the
// user sees at the start of every flash, and the frame no longer depends on
// catching the first second.
await mail.emulateMediaFeatures([...light, { name: "prefers-reduced-motion", value: "reduce" }]);
await mail.goto(`https://${SITE}/`, { waitUntil: "load" });
await mail.click("#body");
await sleep(400);
await mail.keyboard.type(OPENING, { delay: 22 });
await mail.keyboard.type(TYPO, { delay: 30 });
const flashing = () => mail.evaluate(() => !!document.querySelector(".proofer-sentence-flash"));
// The correction is requested three characters into the next sentence and lands
// while that sentence is being typed. The frame is taken as it lands.
let typed = 0, sawFlash = false;
for (const ch of NEXT) {
  await mail.keyboard.type(ch);
  typed++;
  await sleep(60);
  if (await flashing()) { sawFlash = true; break; }
}
if (!sawFlash) await finish(1, "no correction flashed while the next sentence was typed");
const value = await mail.$eval("#body", (e) => e.value);
if (!value.includes("We received the invoice yesterday. Then") || !(await flashing())) {
  await finish(1, `the frame is not the corrected moment (${JSON.stringify(value.slice(-60))})`);
}
const hero = path.join(OUT, "screenshot-1-correction.png");
await mail.screenshot({ path: hero });
expectSize(hero, W, H);
await sleep(900);   // the pause that lets the correction be verified (see LATER)

// Finish the email, so the log holds a few corrections for Recent changes.
await mail.keyboard.type(NEXT.slice(typed), { delay: 30 });
const bodyValue = () => mail.$eval("#body", (e) => e.value);
for (const step of LATER) {
  await mail.keyboard.type(step.text, { delay: 30 });
  if (!step.wait) continue;
  let v = "";
  for (let i = 0; i < 40 && !v.includes(step.wait); i++) { await sleep(150); v = await bodyValue(); }
  if (!v.includes(step.wait)) await finish(1, `the correction to "${step.wait}" did not land (${JSON.stringify(v.slice(-80))})`);
  await sleep(900);
}
await sleep(800);

// --- The popup, with Recent changes --------------------------------------------------
// Opened as a tab, because headless Chrome cannot click the toolbar. The one
// thing a tab changes is which tab is "active", so chrome.tabs.query is pointed
// at the mail tab -- the tab the popup would be opened over. Everything else is
// the real worker, the real log and the real content script's answer.
for (const p of await browser.pages()) if (p !== mail) await p.close();
const popup = await browser.newPage();
await popup.emulateMediaFeatures(light);
await popup.setViewport({ width: 344, height: 1400 });
await popup.evaluateOnNewDocument((site) => {
  const real = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = (q, cb) => real({}, (tabs) => {
    const t = tabs.find((x) => !String(x.url || x.pendingUrl || "").startsWith("chrome-extension:"));
    const out = t ? [{ ...t, url: `https://${site}/` }] : [];
    if (cb) cb(out);
  });
}, SITE);
await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
await popup.waitForFunction(() => /Running/.test(document.getElementById("sentenceWhere").textContent), { timeout: 5000 })
  .catch(() => finish(1, "the popup never said Proofer is running on the mail page"));
await popup.click("#recentBtn");
await popup.waitForFunction(() => document.querySelectorAll("#recentChanges .recent-row").length >= 3, { timeout: 5000 })
  .catch(() => finish(1, "Recent changes did not list the corrections"));
await sleep(300);
const pop = await popup.evaluate(() => {
  const rows = [...document.querySelectorAll("#recentChanges .recent-row")];
  const list = document.getElementById("recentChanges");
  return {
    height: Math.ceil(document.body.getBoundingClientRect().bottom + 12),
    recentTop: Math.floor(document.getElementById("recentBtn").closest(".section").getBoundingClientRect().top),
    rows: rows.length,
    heads: rows.map((r) => r.querySelector(".recent-head").textContent),
    // Three rows must fit the list's own 320 px, or the popup scrolls inside it.
    listScrolls: list.scrollHeight > list.clientHeight + 1,
  };
});
console.log(`  popup: ${pop.height}px of content, Recent changes from ${pop.recentTop}px, ${pop.rows} rows`);
if (pop.listScrolls) await finish(1, "the Recent changes list scrolls inside itself; shorten the corrected sentences");
if (pop.heads.some((h) => !/— applied/.test(h) || /not verified/.test(h))) {
  await finish(1, `a correction was not recorded as a verified apply: ${JSON.stringify(pop.heads)}`);
}
await popup.setViewport({ width: 344, height: pop.height });
const popupPng = path.join(tmp, "popup.png");
await popup.screenshot({ path: popupPng, clip: { x: 0, y: 0, width: 344, height: pop.height } });

// Composite. Chrome shows a popup at most 600 px tall and scrolls the rest, so
// the popup is shown twice at that size: as it opens, and scrolled down to
// Recent changes. Over a neutral background, 1280x800 exactly.
const FRAME_H = 600;
const scrollTo = Math.max(0, Math.min(pop.recentTop - 10, pop.height - FRAME_H));
const comp = await browser.newPage();
await comp.setViewport({ width: W, height: H });
await comp.emulateMediaFeatures(light);
const popupB64 = fs.readFileSync(popupPng).toString("base64");
const GAP = 88, left = Math.round((W - (2 * 344 + GAP)) / 2), top = 128;
await comp.setContent(`<!doctype html><html><head><style>
  html, body { margin:0; width:${W}px; height:${H}px; overflow:hidden; }
  body { background: linear-gradient(160deg, #eef1f6 0%, #dde4ee 100%); font-family: system-ui, sans-serif; color:#334155; }
  .frame { position:absolute; top:${top}px; width:344px; height:${FRAME_H}px; overflow:hidden; background:#fff;
           border-radius:10px; box-shadow: 0 1px 2px rgba(15,23,42,.10), 0 18px 48px rgba(15,23,42,.20); }
  .frame img { display:block; width:344px; }
  .cap { position:absolute; top:${top - 44}px; width:344px; font-size:17px; font-weight:600; text-align:center; }
  .cap small { display:block; font-size:13px; font-weight:400; color:#64748b; margin-top:2px; }
</style></head><body>
  <div class="cap" style="left:${left}px">Proofer's toolbar menu</div>
  <div class="frame" style="left:${left}px"><img class="shot" src="data:image/png;base64,${popupB64}"></div>
  <div class="cap" style="left:${left + 344 + GAP}px">Recent changes</div>
  <div class="frame" style="left:${left + 344 + GAP}px"><img class="shot" style="margin-top:-${scrollTo}px" src="data:image/png;base64,${popupB64}"></div>
</body></html>`);
await comp.waitForFunction(() => [...document.images].every((i) => i.complete));
const popShot = path.join(OUT, "screenshot-3-popup.png");
await comp.screenshot({ path: popShot });
expectSize(popShot, W, H);

// --- The small promo tile ------------------------------------------------------------
const iconB64 = fs.readFileSync(path.join(REPO, "icons", "icon128.png")).toString("base64");
const promo = await browser.newPage();
await promo.setViewport({ width: 440, height: 280 });
await promo.setContent(`<!doctype html><html><head><style>
  html, body { margin:0; width:440px; height:280px; overflow:hidden; }
  /* The store asks for saturated colour and against mostly-white tiles. */
  body { background: linear-gradient(140deg, #0e1f4d 0%, #173a8f 100%); font-family: system-ui, sans-serif; color:#fff; }
  .wrap { position:absolute; inset:0; padding:34px 38px; display:flex; flex-direction:column; justify-content:center; }
  .head { display:flex; align-items:center; gap:18px; }
  .head img { width:88px; height:88px; }
  h1 { margin:0; font-size:48px; letter-spacing:-0.5px; font-weight:700; }
  p { margin:24px 0 0; font-size:24px; line-height:1.32; font-weight:500; color:#e3eaf8; }
  p span { background: #2e9e57; color:#fff; border-radius:5px; padding:0 5px; }
</style></head><body><div class="wrap">
  <div class="head"><img src="data:image/png;base64,${iconB64}"><h1>Proofer</h1></div>
  <p><span>Fixes typos</span> as you type.<br>Runs on your computer.</p>
</div></body></html>`);
await promo.waitForFunction(() => [...document.images].every((i) => i.complete));
const promoPng = path.join(OUT, "promo-small-440x280.png");
await promo.screenshot({ path: promoPng });
expectSize(promoPng, 440, 280);

// --- The icon against the store's guidance ---------------------------------------------
// Store guidance: a 128x128 PNG whose artwork is about 96x96, with 16 px of
// transparent padding on each side. Measured, not eyeballed: the bounding box
// of every pixel that is not fully transparent.
const iconCheck = await promo.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  // The proposal: the same artwork, scaled to 96x96 and centred with 16 px of
  // transparent padding. Offered for the dashboard's store icon, never written
  // over the packaged icon.
  const p = document.createElement("canvas");
  p.width = 128; p.height = 128;
  const pg = p.getContext("2d");
  pg.imageSmoothingEnabled = true; pg.imageSmoothingQuality = "high";
  pg.drawImage(img, box.x, box.y, box.w, box.h, 16, 16, 96, 96);
  return { size: { w: img.naturalWidth, h: img.naturalHeight }, box, proposal: p.toDataURL("image/png").split(",")[1] };
}, iconB64);
const { size: isz, box } = iconCheck;
const padOk = box.x >= 12 && box.y >= 12 && isz.w - (box.x + box.w) >= 12 && isz.h - (box.y + box.h) >= 12;
console.log(`  icon128.png: ${isz.w}x${isz.h}, artwork ${box.w}x${box.h} at (${box.x},${box.y}) -- `
  + (isz.w === 128 && isz.h === 128 && padOk ? "follows the 96+16 guidance" : "artwork runs nearly to the edge; the guidance is 96x96 with 16 px transparent padding"));
const proposed = path.join(OUT, "icon128-store-proposed.png");
if (isz.w === 128 && isz.h === 128 && padOk) {
  fs.rmSync(proposed, { force: true });
} else {
  fs.writeFileSync(proposed, Buffer.from(iconCheck.proposal, "base64"));
  expectSize(proposed, 128, 128);
}

console.log("\n" + "=".repeat(72));
console.log(`Wrote to ${path.relative(REPO, OUT) || OUT}:`);
for (const w of written) console.log(`  ${w}`);
await finish(0);
