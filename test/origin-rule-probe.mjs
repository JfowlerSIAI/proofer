#!/usr/bin/env node
// Does Proofer's Origin rule get a POST through a STOCK Ollama, and only
// Proofer's? An experiment, not a gate: it needs the `ollama` binary and a real
// browser, and it exercises Proofer's OWN manifest rather than a toy
// extension's.
//
//   node origin-rule-probe.mjs                 # Chrome for Testing, and Brave if installed
//   PROOFER_PROBE_BROWSERS=/path/a,/path/b node origin-rule-probe.mjs
//
// It starts a private `ollama serve` on a spare port with NO OLLAMA_ORIGINS
// (so only Ollama's default allowlist applies: loopback origins, not
// extensions) and the shared model store read-only-ish (OLLAMA_NOPRUNE=1), and
// never touches the Ollama on 11434. Every probe is a POST to /api/show for a
// model that does not exist: Ollama's origin check answers 403 before routing,
// and a request it lets through answers 404 -- so the status alone separates
// "refused at the door" from "processed", with no model load.
//
// Rows, for each browser:
//   proofer worker           POST from Proofer's service worker      want: through (404)
//   proofer popup page       POST from chrome-extension://.../popup  want: through
//   proofer welcome page     ...from welcome.html, when it exists    want: through
//   rule removed (control)   the worker again, with the rule gone    want: 403
//   second extension         another extension's worker              want: 403
//   web page                 a page on 127.0.0.2, no-cors POST       want: 403 (read from Ollama's log)
//
// Exit 0 when every row is what it should be, 1 when one is not, 77 when there
// is nothing to measure with (no ollama binary, no browser).

import { spawn, execFileSync } from "child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";
import { resolveChrome } from "./lib/chrome.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const PORT = Number(process.env.PROOFER_PROBE_PORT || 11591);
const OLLAMA = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ollamaBin;
try { ollamaBin = execFileSync("which", ["ollama"]).toString().trim(); } catch { ollamaBin = null; }
if (!ollamaBin) { console.log("no ollama binary on PATH -- nothing to measure"); process.exit(77); }

const browsers = (process.env.PROOFER_PROBE_BROWSERS
  ? process.env.PROOFER_PROBE_BROWSERS.split(",")
  : [(await resolveChrome()).path, "/usr/bin/brave-browser"]).filter((b) => b && fs.existsSync(b));
if (!browsers.length) { console.log("no browser found -- nothing to measure"); process.exit(77); }

// --- a private, stock Ollama -------------------------------------------------
const logPath = path.join(os.tmpdir(), `origin-probe-ollama-${PORT}.log`);
const logFd = fs.openSync(logPath, "w");
const env = { ...process.env, OLLAMA_HOST: `127.0.0.1:${PORT}`, OLLAMA_NOPRUNE: "1",
  OLLAMA_MODELS: process.env.OLLAMA_MODELS || "/usr/share/ollama/.ollama/models" };
delete env.OLLAMA_ORIGINS;
const server = spawn(ollamaBin, ["serve"], { env, stdio: ["ignore", logFd, logFd] });
const stopServer = () => { try { server.kill("SIGTERM"); } catch {} };
process.on("exit", stopServer);
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${OLLAMA}/api/version`)).ok) break; } catch {}
  await sleep(250);
}
const ollamaVersion = await fetch(`${OLLAMA}/api/version`).then((r) => r.json()).then((j) => j.version).catch(() => null);
if (!ollamaVersion) { console.log(`private Ollama did not start on ${PORT}; see ${logPath}`); stopServer(); process.exit(77); }

// --- the two extensions ------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "origin-probe-"));
const PROOFER = path.join(tmp, "proofer");
execFileSync(process.execPath, [path.join(REPO, "tools", "package.mjs"), "--out", PROOFER], { stdio: "ignore" });
const OTHER = path.join(tmp, "other");
fs.mkdirSync(OTHER);
fs.writeFileSync(path.join(OTHER, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: "origin-probe-other", version: "1",
  host_permissions: ["http://127.0.0.1/*"], background: { service_worker: "bg.js" },
}));
fs.writeFileSync(path.join(OTHER, "bg.js"), "globalThis.__probeOtherReady = true;");

// --- a web page on a non-allowlisted loopback origin -------------------------
const page = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<p>page</p>"); });
await new Promise((r) => page.listen(0, "127.0.0.2", r));
const PAGE_URL = `http://127.0.0.2:${page.address().port}/`;

const postFrom = (ctx, tag) => ctx.evaluate(async (url, tag) => {
  try {
    const r = await fetch(`${url}/api/show?from=${tag}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: `probe-${tag}-nonexistent` }) });
    return r.status;
  } catch (e) { return "ERR " + e.message; }
}, OLLAMA, tag);

// Ollama's own log is the only witness for the web page's opaque request.
const statusInLog = (tag) => {
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes(`from=${tag}`));
  const m = lines.length && lines[lines.length - 1].match(/\|\s*(\d{3})\s*\|/);
  return m ? Number(m[1]) : null;
};

const results = [];
let bad = 0;
const row = (browser, label, got, want) => {
  const okNow = typeof want === "function" ? want(got) : got === want;
  if (!okNow) bad++;
  results.push({ browser, label, got, ok: okNow });
  console.log(`  ${okNow ? "ok  " : "FAIL"} ${label.padEnd(26)} ${String(got)}`);
};
const through = (s) => s === 404;

for (const exe of browsers) {
  const name = path.basename(exe).includes("brave") ? "Brave" : "Chrome for Testing";
  const ud = fs.mkdtempSync(path.join(tmp, "profile-"));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: exe,
      args: [`--disable-extensions-except=${PROOFER},${OTHER}`, `--load-extension=${PROOFER},${OTHER}`,
        "--no-sandbox", `--user-data-dir=${ud}`, "--no-first-run"] });
  } catch (e) { console.log(`\n${name}: could not launch (${e.message.split("\n")[0]})`); continue; }
  const version = await browser.version();
  console.log(`\n${name} (${version}), stock Ollama ${ollamaVersion} on ${PORT}`);
  const workers = async () => {
    for (let i = 0; i < 40; i++) {
      const ts = browser.targets().filter((t) => t.type() === "service_worker");
      const pf = ts.find((t) => t.url().endsWith("/background.js"));
      const ot = ts.find((t) => t.url().endsWith("/bg.js"));
      if (pf && ot) return { pf: await pf.worker(), ot: await ot.worker(), id: new URL(pf.url()).host };
      await sleep(250);
    }
    return null;
  };
  const w = await workers();
  if (!w) {
    console.log("  extensions did not load (this browser may ignore --load-extension)");
    results.push({ browser: name, label: "extensions loaded", got: false, ok: false });
    bad++;
    await browser.close();
    continue;
  }
  // Point Proofer at the private Ollama the way the popup's Save would, and
  // wait for the rule the URL change installs.
  await w.pf.evaluate(async (url) => { await setSettings({ ollamaUrl: url }); await ensureOriginRule(url); }, OLLAMA);
  const rules = await w.pf.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
  console.log(`  rule: ${JSON.stringify(rules)}`);
  row(name, "rule is scoped to Proofer", rules.length === 1
    && JSON.stringify(rules[0].condition.initiatorDomains) === JSON.stringify([w.id]), true);

  row(name, "proofer worker", await postFrom(w.pf, "worker"), through);
  for (const pageName of ["popup.html", "welcome.html"]) {
    if (!fs.existsSync(path.join(PROOFER, pageName))) { console.log(`  --   ${pageName} not in the package yet`); continue; }
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${w.id}/${pageName}`, { waitUntil: "domcontentloaded" });
    row(name, `proofer ${pageName}`, await postFrom(p, pageName.replace(".html", "")), through);
    await p.close();
  }
  row(name, "second extension", await postFrom(w.ot, "other"), 403);
  const wp = await browser.newPage();
  await wp.goto(PAGE_URL);
  await wp.evaluate(async (url) => {
    try { await fetch(`${url}/api/show?from=webpage`, { method: "POST", mode: "no-cors",
      headers: { "content-type": "text/plain" }, body: JSON.stringify({ model: "probe-webpage" }) }); } catch {}
  }, OLLAMA);
  await sleep(300);
  row(name, "web page (Ollama's log)", statusInLog("webpage"), 403);
  await wp.close();
  // The control: take the rule away and the same worker POST is refused, so
  // the rule -- not something else about the setup -- is what let it through.
  await w.pf.evaluate(async () => {
    const ids = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  });
  row(name, "rule removed (control)", await postFrom(w.pf, "norule"), 403);
  await browser.close();
}

stopServer();
page.close();
fs.rmSync(tmp, { recursive: true, force: true });
const out = process.env.PROOFER_RESULT_JSON;
if (out) fs.writeFileSync(out, JSON.stringify({ ollamaVersion, port: PORT, results }, null, 2));
console.log(`\n${bad ? `${bad} row(s) not as expected` : "every row as expected"} (Ollama log: ${logPath})`);
process.exit(bad ? 1 : 0);
