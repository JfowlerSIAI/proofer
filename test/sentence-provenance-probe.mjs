/**
 * Why is the provenance baseline diverging on a REAL editor?
 *
 *   cd test && node sentence-provenance-probe.mjs
 *   PROOFER_CONTENT=<path> PROOFER_SEED=<n> node sentence-provenance-probe.mjs
 *
 * An experiment, not a gate: it prints and does not assert. It types
 * sentence-slate-test.mjs case [8]'s exact message into the real Slate capture
 * and reports what actually reached the extension, which is the one question
 * the offline suites cannot answer.
 *
 * It exists because keying provenance to the `input` event passed
 * sentence-provenance-test.mjs 55/55 and sentence-typing-test.mjs 135/135 while
 * taking real Slate from 6/6 corrections to 0/6. Instrument content.js with a
 * console.log at the site under suspicion, point PROOFER_CONTENT at the copy,
 * and run this. The finding it produced, in two lines:
 *
 *     PROBE-HI ... data="y"     <- an input event
 *     PROBE-HI ... data=" "     <- an input event
 *                               ...and NOTHING for the "." in between
 *
 * slate-react takes the browser's native edit path only for `insertText` whose
 * data matches /[a-z ]/i over a collapsed selection. For a period it calls
 * preventDefault() on `beforeinput` and applies the edit through its own model,
 * so the DOM changes with no `input` event at all -- on precisely the character
 * that finishes a sentence. A shaped fixture cannot show this: it has no model,
 * so the browser applies the period natively and the event arrives as normal.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { resolveChrome } from "./lib/chrome.mjs";
import { serveFixture } from "./lib/fixture-server.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.join(HERE, "..");
const CONTENT = fs.readFileSync(process.env.PROOFER_CONTENT || path.join(EXT, "content.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED = process.env.PROOFER_SEED ? Number(process.env.PROOFER_SEED) >>> 0
                                      : (Math.random() * 2 ** 32) >>> 0;
let rs = SEED;
const rand = () => {
  rs = (rs + 0x6D2B79F5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
console.log(`[seed ${SEED}]`);

const SENTS = ["The techncian arrived early.", "We recieved the invoice yesterday.",
               "The meeting was moved to thursday."];
const FIXES = { [SENTS[0]]: "The technician arrived early.",
                [SENTS[1]]: "We received the invoice yesterday.",
                [SENTS[2]]: "The meeting was moved to Thursday." };
const MSG = SENTS.join(" ");

const server = await serveFixture(path.join(HERE, "fixtures", "slatejs.org"));
const URL_ = server.url("/examples/richtext");
const chrome = await resolveChrome();
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chrome.path,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu",
         "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
});

const page = await browser.newPage();
const lines = [];
page.on("console", (m) => { const t = m.text(); if (t.startsWith("PROBE-")) lines.push(t); });
page.on("pageerror", (e) => lines.push("PAGEERROR " + e.message));
await page.evaluateOnNewDocument(`window.__FIX = ${JSON.stringify(FIXES)};
  window.chrome = { runtime: { id:"t", lastError: undefined, sendMessage: (m, cb) => setTimeout(() => {
      if (m.type === "SENTENCE_CONSENT") return cb({ ok:true, allowed:true, apply:true });
      if (m.type === "SENTENCE_REWRITE") { console.log("PROBE-SEND " + JSON.stringify(m.sentence));
        const f = window.__FIX[m.sentence];
        return cb(f ? { ok:true, rewritten:f, apply:true } : { ok:true, noChanges:true }); }
      cb({ ok:true, noChanges:true });
    }, 250) },
    storage: { local: { get:(d,cb)=>cb({...d}), set:(o,cb)=>cb&&cb() }, onChanged:{ addListener(){} } } };`);
await page.goto(URL_, { waitUntil: "networkidle2", timeout: 60000 });
await sleep(1200);
const box = await page.evaluate(() => {
  const el = document.querySelector('[data-slate-editor="true"]');
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + 20 };
});
await page.mouse.click(box.x, box.y); await sleep(200);
await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
await page.keyboard.press("Backspace"); await sleep(300);
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await sleep(150);
await page.evaluate(CONTENT);
await sleep(250);
await page.mouse.click(box.x, box.y); await sleep(600);

const jitter = (base) => Math.round(base * (0.55 + rand() * 0.9));
for (const ch of MSG) {
  await page.keyboard.type(ch);
  await sleep(jitter(ch === "." ? 700 : ch === " " ? 260 : 110));
}
await sleep(2500);
const out = await page.evaluate(() =>
  document.querySelector('[data-slate-editor="true"]').textContent);

console.log("\n--- events ---");
for (const l of lines) console.log(l);
console.log("\n--- final text ---");
console.log(JSON.stringify(out));
const parts = out.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);
console.log("landed:", parts.filter((x) => Object.values(FIXES).includes(x)).length, "/3");

await browser.close();
server.close && server.close();
process.exit(0);
