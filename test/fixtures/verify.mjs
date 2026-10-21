#!/usr/bin/env node
/**
 * Does each captured page still boot with the network unplugged?
 *
 *   cd test && node fixtures/verify.mjs            # every capture present
 *   cd test && node fixtures/verify.mjs slate
 *
 * A capture rots quietly: an asset that was never fetched during the capture
 * run, a reference to a CDN that survived rewriting, a bundle that needs an
 * origin it no longer has. None of that shows as an exception -- it shows as a
 * page that renders slightly differently from the site it came from, months
 * later, in a test that measures something else.
 *
 * So four questions per capture, all cheap:
 *   1. does it render the editor's own selector
 *   2. does typing reach the text
 *   3. did anything try to leave the loopback origin (DNS is cut off, so an
 *      attempt is all that can happen)
 *   4. did the server get asked for a path that was never captured
 *
 * `sentence-slate-test.mjs` checks both the accepting August Slate capture and
 * the rejecting October capture as part of its own
 * gate. TARGETS includes both as separate mandatory captures. All seven captures
 * are verified here; the six editor families also feed the flash probe.
 */
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { resolveChrome } from "../lib/chrome.mjs";
import { serveFixture } from "../lib/fixture-server.mjs";
import { TARGETS } from "./capture.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPE_ME = "Zq typed offline.";

const names = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = names.length ? names : Object.keys(TARGETS);

const unknown = wanted.filter((n) => !TARGETS[n]);
if (unknown.length) {
  console.log(`Unknown target(s): ${unknown.join(", ")}`);
  console.log(`Known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(2);
}

// A MISSING capture is a failure, not a target to quietly drop. This used to
// filter the absent ones out and fail only when NOTHING remained, so deleting
// three of the four captures left a green run that verified one -- the
// "completes green and produces nothing" shape, with the extra sting that the
// count in the summary line was the only place it showed. Every capture is
// committed, so absence means a broken checkout or a bad merge, and naming
// which one is the whole diagnostic.
const missing = wanted.filter((n) => !fs.existsSync(path.join(HERE, TARGETS[n].dir)));
if (missing.length) {
  console.log(`Missing capture(s): ${missing.join(", ")}`);
  for (const n of missing) console.log(`    node fixtures/capture.mjs ${n}`);
  console.log(`  Expected ${wanted.length} capture(s); ${wanted.length - missing.length} present.`);
  process.exit(1);
}

const chrome = await resolveChrome();
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chrome.path,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
         "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
});

let bad = 0;
console.log("\nCaptured editor pages, offline\n" + "=".repeat(72));
for (const name of wanted) {
  const t = TARGETS[name];
  const dir = path.join(HERE, t.dir);
  const server = await serveFixture(dir);
  const page = await browser.newPage();
  // Desktop viewport, matching capture.mjs: draftjs.org hides its demo editor
  // below ~997px, so at Puppeteer's 800x600 default the editor renders 0x0 --
  // LIVE AS WELL AS CAPTURED -- and a click can land in nothing.
  await page.setViewport({ width: 1366, height: 900 });
  const offsite = [], errors = [];
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (u.startsWith(server.origin) || u.startsWith("data:") || u === "about:blank") return r.continue();
    offsite.push(u);
    r.abort();
  });
  const responseTypes = new Map();
  page.on("response", (r) => responseTypes.set(r.url(), r.headers()["content-type"] || ""));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let typed = null, rendered = false, note = "";
  try {
    // The TRAILING SLASH is load-bearing. ProseMirror's example references
    // `../prosemirror.js` and `example.js` relatively, so serving the same file
    // at `/examples/basic` instead of `/examples/basic/` resolves both one
    // directory too high and the page loads with no editor at all.
    await page.goto(server.url("/" + t.entry.replace(/index\.html$/, "")),
                    { waitUntil: "networkidle2", timeout: 30000 });
    rendered = await page.waitForSelector(t.ready, { timeout: 20000 }).then(() => true, () => false);
    if (rendered) {
      // The LARGEST match, not the first: a demo page can carry several
      // editors, some of them hidden, and `querySelector` picks whichever is
      // first in the document. Typing into a hidden one reads as a broken
      // capture. Same reason the text is then looked for across ALL matches.
      const box = await page.evaluate((sel) => {
        const best = [...document.querySelectorAll(sel)]
          .map((e) => e.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .sort((a, b) => b.width * b.height - a.width * a.height)[0];
        return best && { x: best.left + best.width / 2, y: best.top + Math.min(12, best.height / 2) };
      }, t.ready);
      const readBack = () => page.evaluate((sel) =>
        [...document.querySelectorAll(sel)].map((e) => e.textContent).join("   "), t.ready);
      if (box) {
        await page.mouse.click(box.x, box.y);
        await sleep(200);
        await page.keyboard.type(TYPE_ME, { delay: 15 });
        await sleep(400);
        typed = await readBack();
      }
      // A click is the faithful way in and does not always land -- quilljs.com
      // carries three synchronised editors below the fold, and a click at the
      // top of the first types into none of them, LIVE AS WELL AS CAPTURED.
      // That is a property of the page, not evidence about the capture, so the
      // caret is placed directly and the question re-asked. The keystrokes are
      // real CDP keystrokes either way.
      if (!typed || !typed.includes(TYPE_ME)) {
        await page.evaluate((sel) => {
          const e = document.querySelector(sel);
          e.scrollIntoView({ block: "center" });
          e.focus();
          const r = document.createRange();
          r.selectNodeContents(e); r.collapse(true);
          getSelection().removeAllRanges(); getSelection().addRange(r);
        }, t.ready);
        await page.keyboard.type(TYPE_ME, { delay: 15 });
        await sleep(400);
        typed = await readBack();
        if (typed.includes(TYPE_ME)) note = "typed after placing the caret; a plain click did not land";
      }
    }
  } catch (e) {
    note = e.message.split("\n")[0];
  }
  // Every resource the page loads AS A STYLESHEET must have been served as one.
  // This is the failure a console-error check cannot see: an extension-less
  // `.../css` served as text/html for want of a recorded type.
  //
  // Checked against what the SERVER SENT, not against `link.sheet`. The obvious
  // version -- "the browser refused it, so `.sheet` is null" -- was written
  // first and measured second, and it is vacuous: Chrome sniffs, so with the
  // type deliberately broken `.sheet` is still true and the check passes
  // exactly when it should fail. The header is the fact; the DOM is a
  // downstream opinion about it.
  let badTypes = [];
  try {
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll('link[rel~="stylesheet"]')].map((l) => l.href));
    badTypes = hrefs
      .filter((h) => responseTypes.has(h) && !/css/i.test(responseTypes.get(h)))
      .map((h) => `${h.replace(server.origin, "")} -> ${responseTypes.get(h)}`);
  } catch { /* page already gone */ }
  await page.close();
  await server.close();

  const files = fs.readdirSync(dir, { recursive: true }).filter((f) =>
    fs.statSync(path.join(dir, f)).isFile()).length;
  const bytes = Number(execSize(dir));
  const good = rendered && typed && typed.includes(TYPE_ME)
    && offsite.length === 0 && server.misses.length === 0 && badTypes.length === 0;
  if (!good) bad++;
  console.log(`  ${good ? "PASS" : "FAIL"}: ${name.padEnd(12)} ${String(files).padStart(3)} files `
    + `${(bytes / 1024).toFixed(0).padStart(5)} KB  ${t.ready}`);
  if (good && note) console.log(`        ${note}`);
  if (!good) {
    console.log(`        rendered=${rendered} typed=${JSON.stringify(typed && typed.slice(-24))}`);
    if (offsite.length) console.log(`        left the loopback origin: ${offsite.slice(0, 3).join(", ")}`);
    if (server.misses.length) console.log(`        uncaptured paths: ${server.misses.slice(0, 3).join(", ")}`);
    if (badTypes.length) console.log(`        served as a stylesheet but typed otherwise: ${badTypes.slice(0, 3).join(", ")}`);
    if (note) console.log(`        ${note}`);
  }
  // Console errors are reported, never failed on: a demo page is allowed its
  // own warnings, and a capture that renders and types is doing its job.
  if (errors.length) console.log(`        (${errors.length} console error(s), first: ${errors[0].slice(0, 110)})`);
}

await browser.close();
console.log("=".repeat(72));
console.log(bad ? `${bad} capture(s) unusable` : `${wanted.length} capture(s) boot offline and accept typing`);
process.exit(bad ? 1 : 0);

function execSize(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) total += fs.statSync(p).size;
  }
  return total;
}
