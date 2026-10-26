/**
 * Sentence mode under real keystrokes. Headless Chrome, no Ollama.
 *
 *   cd test && node sentence-typing-test.mjs
 *
 * content.js runs in the page with a stubbed chrome.* API that answers
 * SENTENCE_REWRITE from a canned table, so this measures the machinery rather
 * than the model: does the splice land behind the caret, is a keystroke ever
 * lost, does the caret move, does scrollTop jump, does Undo put back exactly
 * what was there, and do paste and bulk insertion stay silent.
 * [10d–e] capture production status listeners and timers across intercepted
 * normal/canvas frames to pin the first-response bus and bounded age buckets.
 *
 * Every keystroke here is a REAL one dispatched through CDP. Synthetic
 * InputEvents cannot drive this at all -- handleInput drops anything with
 * isTrusted false, which is the same reason the extension writes with
 * execCommand rather than assigning .value.
 *
 * The page is served over http://127.0.0.1 rather than page.setContent,
 * because consent is keyed to the top-level origin and about:blank has none.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import http from "http";
import { chromePath } from "./lib/chrome.mjs";
import { runSentenceEngine, prepareSentenceRequest, PINNED_MODEL } from "./lib/sentence-guards.mjs";

const EXT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  cond ? pass++ : fail++;
};

const CONTENT = fs.readFileSync(process.env.PROOFER_CONTENT || path.join(EXT, "content.js"), "utf8");
const STYLES = fs.readFileSync(path.join(EXT, "styles.css"), "utf8");

// Canned corrections, keyed by the exact sentence the trigger sends.
const CORRECTIONS = {
  "The techncian arrived early.": "The technician arrived early.",
  "We recieved the invoice yesterday.": "We received the invoice yesterday.",
  "This sentance is wrong.": "This sentence is wrong.",
  // A correction that SHORTENS. Every other entry here grows or holds length,
  // which is why the stale-watermark window in [16] was invisible: the whole
  // corpus could only move offsets in the safe direction.
  "The the report was late.": "The report was late.",
};

// apply:false injects a non-writing test double to isolate request scheduling;
// it is not a shipping suggestion mode.
const STUB = (apply) => `
window.__sent = [];
window.__messageListeners = [];
window.__storageReads = [];
window.__store = { disabledSites: [], sentenceDebug: false };
window.__corrections = ${JSON.stringify(CORRECTIONS)};
// Held open so a test can edit the document while a request is in flight --
// which is the only way to reach the stale-anchor paths.
window.__delayMs = 20;
window.chrome = {
  runtime: {
    id: "test-ext",
    lastError: undefined,
    onMessage: { addListener: (fn) => window.__messageListeners.push(fn) },
    sendMessage: (msg, cb) => {
      // Snapshot the field as it was when the request went out, so a test can
      // ask whether the target actually began at a sentence boundary.
      const ta = document.activeElement;
      window.__sent.push(Object.assign({}, msg, {
        __field: ta && ta.tagName === "TEXTAREA" ? ta.value : null,
      }));
      setTimeout(() => {
        // __allowed lets a case withdraw consent the way the worker would
        // after a configuration change (a stale speed check, a new URL).
        if (msg.type === "SENTENCE_CONSENT") return cb({ ok: true, allowed: window.__allowed !== false,
          sentenceDebug: window.__store.sentenceDebug === true, apply: ${apply} && window.__allowed !== false });
        if (msg.type === "SENTENCE_REWRITE") {
          if (window.__rewriteReplies && msg.sentence in window.__rewriteReplies) {
            return cb(window.__rewriteReplies[msg.sentence]);
          }
          const fix = window.__corrections[msg.sentence];
          if (!fix) return cb({ ok: true, noChanges: true });
          return cb({ ok: true, rewritten: fix, apply: ${apply} });
        }
        cb({ ok: true });
      }, msg.type === "SENTENCE_REWRITE" ? window.__delayMs : 20);
    },
  },
  storage: {
    local: { get: (d, cb) => { window.__storageReads.push(d); cb({ ...d, ...window.__store }); }, set: (o, cb) => cb && cb() },
    // Captured, so a case can fire a storage change as the browser would.
    onChanged: { addListener: (fn) => { (window.__onChanged = window.__onChanged || []).push(fn); } },
  },
};
`;

let engineChats = 0;
const server = http.createServer((req, res) => {
  // [25] A fake Ollama response travels through the shipping engine before
  // content sees it. A hand-written error reply would miss the producer bug.
  if (req.url === "/api/tags" || req.url === "/api/chat") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/tags") {
      res.end(JSON.stringify({ models: [{ name: PINNED_MODEL.tag, digest: PINNED_MODEL.digest }] }));
    } else {
      engineChats++;
      res.end(JSON.stringify({ done_reason: "length",
        message: { content: '{"rewritten":"The technician arrived early."}' } }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><body style="padding:20px">
<textarea id="ta" style="width:520px;height:120px;font:14px monospace"></textarea>
<textarea id="tall" style="width:520px;height:40px;font:14px monospace"></textarea>
<textarea id="capped" maxlength="32" style="width:520px;height:60px;font:14px monospace"></textarea>
<textarea id="rtl" dir="rtl" style="width:520px;height:60px;font:14px monospace"></textarea>
<div id="ce" contenteditable="true" style="width:520px;min-height:60px;font:14px monospace;border:1px solid #ccc"></div>
<!-- Shaped like Discord's composer: the editing host is the outer element and
     the text lives several levels down, so an identity check against
     document.activeElement or e.target has to be wrong somewhere if the
     adapter is wrong. -->
<div id="slate" contenteditable="true" data-slate-editor="true" style="width:520px;min-height:60px;font:14px monospace;border:1px solid #ccc"><div data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-string="true"></span></span></span></div></div>
<div id="rich" contenteditable="true" style="width:520px;min-height:60px;font:14px monospace;border:1px solid #ccc"></div>
<!-- Fingerprints only. There is no editor behind any of these, so they can
     answer "which recipe would run here" and nothing whatever about the write
     -- that is sentence-editors-test.mjs, against the real thing. -->
<div id="pm" class="ProseMirror" contenteditable="true" style="width:520px;min-height:40px"></div>
<div id="tiptap" class="tiptap ProseMirror" contenteditable="true" style="width:520px;min-height:40px"></div>
<div id="quill" class="ql-editor" contenteditable="true" style="width:520px;min-height:40px"></div>
<div id="lexical" data-lexical-editor="true" contenteditable="true" style="width:520px;min-height:40px"></div>
</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: await chromePath(),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--window-size=1280,900"],
});

async function freshPage(apply, frozenNow = null) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("pageerror", (e) => console.error("  PAGE ERROR:", e.message));
  await page.evaluateOnNewDocument(STUB(apply));
  if (frozenNow !== null) await page.evaluateOnNewDocument((now) => { Date.now = () => now; }, frozenNow);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.addStyleTag({ content: STYLES });
  await page.evaluate(CONTENT);
  await sleep(150);
  return page;
}

// Intercept canvas hostnames locally: frame identity is real, no remote site
// participates. CONTENT is evaluated unchanged in every frame, including the
// canvas early return. Date.now is controlled before focus establishes history.
async function statusFrames(canvasTop, child = null) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(STUB(true));
  await page.evaluateOnNewDocument(() => {
    window.__now = 1000000;
    Date.now = () => window.__now;
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const iframe = req.isNavigationRequest() && req.frame() === page.mainFrame() && child
      ? `<iframe src="https://${child === "canvas" ? "docs.google.com" : "editor.test"}/child"></iframe>` : "";
    req.respond({ status: 200, contentType: "text/html", body:
      `<textarea id="ta"></textarea><button id="blur">Blur</button>${iframe}` });
  });
  await page.goto(`https://${canvasTop ? "docs.google.com" : "page.test"}/`);
  for (const frame of page.frames()) await frame.evaluate(CONTENT);
  await sleep(150);
  return page;
}

async function rememberTextarea(frame) {
  await frame.page().bringToFront();
  await frame.click("#ta");
  await frame.waitForFunction(() => window.__prooferSentence.sentenceStatusReport().status === "active");
  await frame.click("#blur");
  await frame.waitForFunction(() => window.__prooferSentence.sentenceStatusReport().status === "no-field");
}

// Capture only timers scheduled DURING production listener dispatch. Deliver
// synchronous responses immediately, then release timers in delay order. A
// delayed sendResponse is accepted only when its listener returned true; the
// bus retains only its first response, even though all frames are inspected.
async function statusBus(frames) {
  const scheduled = [], responses = [];
  let winner = null;
  for (const [index, frame] of frames.entries()) {
    const state = await frame.evaluate(() => {
      window.__statusTimers = [];
      window.__statusResponses = [];
      const realTimeout = window.setTimeout;
      window.setTimeout = (fn, delay) => { window.__statusTimers.push({ fn, delay }); return 1; };
      try {
        for (const listener of window.__messageListeners) {
          let dispatching = true, open = false;
          const result = listener({ type: "SENTENCE_STATUS" }, {}, (report) => {
            if (dispatching || open) window.__statusResponses.push(report);
          });
          dispatching = false;
          open = result === true;
        }
      } finally { window.setTimeout = realTimeout; }
      return { delays: window.__statusTimers.map((t) => t.delay), responses: window.__statusResponses.splice(0) };
    });
    for (const report of state.responses) {
      responses.push({ index, report });
      winner ??= { index, report };
    }
    state.delays.forEach((delay, timer) => scheduled.push({ index, timer, delay }));
  }
  for (const entry of [...scheduled].sort((a, b) => a.delay - b.delay)) {
    const replies = await frames[entry.index].evaluate((timer) => {
      window.__statusTimers[timer].fn();
      return window.__statusResponses.splice(0);
    }, entry.timer);
    for (const report of replies) {
      responses.push({ index: entry.index, report });
      winner ??= { index: entry.index, report };
    }
  }
  return { scheduled, responses, winner };
}

const val = (page, sel = "#ta") => page.evaluate((s) => document.querySelector(s).value, sel);
const caret = (page, sel = "#ta") => page.evaluate((s) => {
  const el = document.querySelector(s);
  return { start: el.selectionStart, end: el.selectionEnd };
}, sel);
const requests = (page) => page.evaluate(() =>
  window.__sent.filter((m) => m.type === "SENTENCE_REWRITE").map((m) => m.sentence));

console.log("\nSentence mode under real keystrokes\n" + "=".repeat(72));

// --- [1] The correction lands behind the caret while typing continues -------
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  // "The techncian arrived early." then four more characters -- the trigger
  // needs three, so this fires while the user is mid-word in sentence two.
  await page.keyboard.type("The techncian arrived early. Then we shipped", { delay: 25 });
  await sleep(600);

  const text = await val(page);
  ok(text === "The technician arrived early. Then we shipped",
     `spliced behind the caret: ${JSON.stringify(text)}`);
  const c = await caret(page);
  ok(c.start === text.length && c.end === text.length,
     `caret still at the end (${c.start}/${text.length})`);
  ok((await requests(page)).length === 1, "exactly one request for one sentence");

  console.log("\n[1b] The green flash is the ONLY signal");
  // The flash is the whole affordance, which is why it lives 1600ms. (Suggestion
  // mode's chip went on 2026-09-24; there is no control beside the caret.)
  ok(await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length > 0),
     "the flash is still up at 600ms (1600ms life)");
  const flashed = await page.evaluate(() =>
    [...document.querySelectorAll(".proofer-sentence-flash")].length);
  ok(flashed >= 1, `the changed word is highlighted (${flashed} range(s))`);
  await sleep(1200);
  ok(await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length === 0),
     "and it clears itself afterwards");

  console.log("\n[2] Escape restores exactly what the user typed");
  // Escape replaced the chip's Undo button. Ctrl+Z works too -- the write goes
  // in with execCommand so it is on the field's own undo stack -- but that is a
  // claim about the page's history handling, and this path is one we own.
  await page.keyboard.press("Escape");
  await sleep(120);
  const undone = await val(page);
  ok(undone === "The techncian arrived early. Then we shipped",
     `undo put back the original: ${JSON.stringify(undone)}`);
  ok((await caret(page)).start === undone.length, "and the caret is still at the end");
  ok(await page.evaluate(() =>
       window.__sent.some((m) => m.verdict === "sentence-undone")),
     "undo is reported as a verdict");
  await page.close();
}

// [2d] Mutant: doSentenceUndo reports "sentence-reconciled" instead of
// "sentence-undo-reconciled"; the exact outcome sequence below turns red.
{
  console.log("\n[2d] The page discards Escape but retains the correction");
  const page = await freshPage(true);
  await page.evaluate(() => document.querySelector("#ta").addEventListener("input", (e) => {
    if (e.inputType === "insertText" && e.data && e.data.length > 1) {
      e.target.value = e.target.value.replace(/techncian/g, "technician");
    }
  }));
  await page.click("#ta");
  await page.keyboard.type("The techncian arrived early.", { delay: 25 });
  await page.waitForFunction(() => window.__sent.some((m) => m.verdict === "sentence-applied"));
  ok(await val(page) === "The technician arrived early.", "[2d] the real apply landed first");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").length >= 2);
  ok(await val(page) === "The technician arrived early.", "[2d] corrected text remains after Escape");
  const verdicts = await page.evaluate(() => window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict));
  ok(JSON.stringify(verdicts) === JSON.stringify(["sentence-applied", "sentence-undo-reconciled"]),
    `[2d] exact apply/failed-undo outcome sequence: ${JSON.stringify(verdicts)}`);
  await page.close();
}

// --- [2b] The flash outlives the keystrokes that follow it -----------------
{
  // This is the regression that matters most about the flash. It appears while
  // the user is mid-word in the NEXT sentence, so a keystroke ALWAYS follows
  // it within milliseconds. An earlier version tore the overlay down on any
  // input at all -- which meant the one signal a user gets for an edit they
  // did not ask for was never actually on screen.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await sleep(120);                                   // splice lands here
  const born = await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length);
  ok(born === 1, `flash painted over the changed word (${born})`);
  await page.keyboard.type("n we", { delay: 20 });    // four more keystrokes
  ok(await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length) === 1,
     "still on screen after typing continued past it");

  // But an edit that could MOVE it takes it down immediately -- a drifted
  // highlight points at the wrong word, which is worse than no highlight.
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.setSelectionRange(0, 0);
    document.execCommand("insertText", false, "X");
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await sleep(60);
  ok(await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length) === 0,
     "removed as soon as an edit before it could have moved it");
  await page.close();
}

// --- [2c] The overlay guards the whole undo sentence -----------------------
// SD-44 mutant: replace the overlay guard's end/prefix line with
// end: Math.max(...ranges.map((r) => r.end)), prefix: snText(el).slice(0, Math.max(...ranges.map((r) => r.end))),
// Only "[2c] later-word edit clears the overlay before expiry" must turn red;
// arrangement, append survival, geometry and Escape refusal must stay green.
{
  const page = await freshPage(true);
  await page.click("#ta");
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await page.waitForFunction(() => document.querySelector(".proofer-sentence-flash"));
  const born = Date.now();
  const geometry = () => page.evaluate(() => {
    const el = document.querySelector("#ta"), r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height, el.scrollLeft, el.scrollTop, scrollX, scrollY];
  });
  const initialGeometry = await geometry();
  ok(await val(page) === "The technician arrived early. The",
     "[2c] the technician correction lands");
  const overlays = () => page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length);
  ok(await overlays() === 1, "[2c] the correction paints an overlay");
  await page.keyboard.type("n we", { delay: 20 });
  ok(await val(page) === "The technician arrived early. Then we" && await overlays() === 1,
     "[2c] appending after the undo sentence preserves the overlay");
  await sleep(Math.max(0, born + 900 - Date.now()));
  await page.evaluate(() => document.querySelector("#ta").setSelectionRange(28, 28));
  const at = Date.now() - born;
  await page.keyboard.type("X");
  const done = Date.now() - born;
  ok(at > 650 && done < 1600,
     `[2c] later-word edit is after verification and before expiry (+${at}..${done}ms)`);
  ok(await val(page) === "The technician arrived earlyX. Then we",
     "[2c] the later-word edit leaves technician intact");
  await sleep(60);
  const remaining = await overlays(), observed = Date.now() - born;
  ok(observed < 1600, `[2c] removal is checked before expiry (+${observed}ms)`);
  ok(remaining === 0, "[2c] later-word edit clears the overlay before expiry");
  ok(JSON.stringify(await geometry()) === JSON.stringify(initialGeometry),
     "[2c] field geometry and field/window scroll remain unchanged");
  await page.keyboard.press("Escape");
  await sleep(100);
  ok(await val(page) === "The technician arrived earlyX. Then we",
     "[2c] Escape leaves the edited sentence unchanged");
  await page.close();
}

// --- [3] No keystroke is lost across the splice window ---------------------
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  // Type continuously through the moment the splice lands. The splice selects
  // the target and replaces it; a keystroke arriving inside that window would
  // overwrite the selection, which is the whole reason this path is textarea-
  // only and re-checks the anchor in the same tick as the write.
  const tail = "Then we shipped the whole thing on Friday afternoon";
  await page.keyboard.type("The techncian arrived early. " + tail, { delay: 12 });
  await sleep(700);
  const text = await val(page);
  ok(text.endsWith(tail), `every later keystroke survived: ${JSON.stringify(text.slice(-20))}`);
  ok(text.startsWith("The technician arrived early."), "and the correction still landed");
  await page.close();
}

// --- [4] scrollTop is preserved -------------------------------------------
{
  const page = await freshPage(true);
  await page.click("#tall");
  await sleep(100);
  await page.keyboard.type("Filler line one here.\nFiller line two here.\nFiller line three.\n", { delay: 8 });
  await page.keyboard.type("We recieved the invoice yesterday. And", { delay: 25 });
  await sleep(300);
  const before = await page.evaluate(() => document.querySelector("#tall").scrollTop);
  await sleep(500);
  const after = await page.evaluate(() => document.querySelector("#tall").scrollTop);
  ok(Math.abs(after - before) <= 2, `scrollTop stable across the splice (${before} -> ${after})`);
  ok((await val(page, "#tall")).includes("We received the invoice yesterday."),
     "the correction landed in the scrolled field");
  await page.close();
}

// --- [5] Bulk insertion never triggers -------------------------------------
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  // execCommand("insertText", "<long>") reports inputType "insertText" with a
  // long `data` -- byte for byte what a keystroke reports. This is why the
  // discriminator is size, not inputType.
  await page.evaluate(() => {
    document.querySelector("#ta").focus();
    document.execCommand("insertText", false,
      "The techncian arrived early. We recieved the invoice yesterday. And more text here.");
  });
  await sleep(900);
  ok((await requests(page)).length === 0,
     `a bulk execCommand insert fired nothing (${JSON.stringify(await requests(page))})`);
  ok(await val(page) === "The techncian arrived early. We recieved the invoice yesterday. And more text here.",
     "and the pasted text was left exactly as pasted");

  console.log("\n[5b] A direct .value assignment fires no event at all");
  await page.evaluate(() => { document.querySelector("#ta").value = ""; });
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.value = "This sentance is wrong. The techncian arrived early. Padding text follows here.";
    el.setSelectionRange(el.value.length, el.value.length);
  });
  // The next real keystroke is the first thing that sees it, and the size rule
  // is the only thing that can catch it.
  await page.keyboard.type(" x", { delay: 25 });
  await sleep(900);
  ok((await requests(page)).length === 0,
     `no request after a silent .value assignment (${JSON.stringify(await requests(page))})`);
  await page.close();
}

// --- [5c] Typing AT the watermark never produces a fragment ---------------
{
  // The nasty one. Everything before the watermark is untouched, so the prefix
  // check passes -- but the text after it is now a continuation of the
  // already-proofread sentence rather than a new one. Handing the model a
  // fragment is how a "correction" gets spliced into the middle of a sentence.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then", { delay: 20 });
  await sleep(300);
  // Go back to just after the proofread sentence and keep writing there.
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.focus();
    el.setSelectionRange(29, 29);            // immediately after "early."
    document.execCommand("insertText", false, "ish");
  });
  await page.keyboard.type(" and it was fine. Then more", { delay: 20 });
  await sleep(800);

  // The property that matters is not "looks like a sentence" -- "ish and it was
  // fine." passes that and is exactly the fragment. It is "began at a sentence
  // boundary in the document it was taken from".
  const bad = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "SENTENCE_REWRITE").filter((m) => {
      if (!m.__field) return true;
      const i = m.__field.indexOf(m.sentence);
      return i < 0 || (i > 0 && !/\s/.test(m.__field[i - 1]));
    }).map((m) => m.sentence));
  ok(bad.length === 0, `no fragment was ever sent (${JSON.stringify(await requests(page))})`);
  await page.close();
}

// --- [5d] A stale in-flight response never moves the watermark ------------
{
  // The corruption path the audit found. The prefix check compares only
  // through the CURRENT watermark, so an edit between the watermark and the
  // target goes unseen -- and installing the captured job.end afterwards put
  // the watermark into the middle of a later word, making the NEXT request a
  // fragment that a plausible capitalisation-only reply would splice back in.
  const page = await freshPage(true);
  await page.evaluate(() => { window.__delayMs = 1200; });
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The report was late. Next", { delay: 20 });
  await sleep(250);                                  // request is now in flight
  ok((await requests(page)).length === 1, "a request is in flight");

  // Delete "was " from the sentence that is out for proofreading.
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.focus();
    el.setSelectionRange(11, 15);
    document.execCommand("delete");
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type(" sentence here. And", { delay: 20 });
  await sleep(1600);

  const text = await val(page);
  ok(text === "The report late. Next sentence here. And",
     `nothing was spliced into the wrong span: ${JSON.stringify(text)}`);
  const bad = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "SENTENCE_REWRITE").filter((m) => {
      if (!m.__field) return true;
      const i = m.__field.indexOf(m.sentence);
      return i < 0 || (i > 0 && !/\s/.test(m.__field[i - 1]));
    }).map((m) => m.sentence));
  ok(bad.length === 0, `no fragment followed the stale response (${JSON.stringify(await requests(page))})`);
  await page.close();
}

// --- [5e] A short .value assignment is still not typing --------------------
{
  // Net length growth misses this: "This is wrong." is 14 characters, under the
  // 25 threshold, so the first real keystroke made it eligible. Diffing against
  // the previous text sees a 14-character edit.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.value = "This sentance is wrong.";
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type(" abc", { delay: 25 });
  await sleep(900);
  ok((await requests(page)).length === 0,
     `a 23-character silent assignment fired nothing (${JSON.stringify(await requests(page))})`);
  await page.close();
}

// --- [5f] Opening a draft that ends mid-word ------------------------------
{
  // rederiveWatermark used default segmentation, which folds a trailing runt
  // backward: "This sentance is wrong. Dr" became ONE unfinished segment, the
  // watermark landed at 0, and three keystrokes later the already-finished
  // first sentence was proofread as if it were new.
  const page = await freshPage(true);
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.value = "This sentance is wrong. Dr";
  });
  await page.click("#ta");
  await sleep(200);
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await page.keyboard.type("aper", { delay: 25 });
  await sleep(900);
  ok((await requests(page)).length === 0,
     `text already in the field on focus is left alone (${JSON.stringify(await requests(page))})`);
  await page.close();
}

// --- [5g] Carrying on typing is not a reverted correction -----------------
{
  // The keep rate is the number that decides whether this ships. The watcher
  // added the field's total length drift to the span end, so every keystroke
  // after the correction pulled the next sentence into the "edit" and reported
  // it as sentence-edited -- which is the normal operating mode.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await sleep(300);
  await page.keyboard.type("n we shipped the whole thing", { delay: 20 });
  await sleep(2600);                                  // past the 2s settle
  const verdicts = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict));
  ok(!verdicts.includes("user-edited-correction") && !verdicts.includes("user-reverted"),
     `continuing to write is not logged as an edit (${JSON.stringify(verdicts)})`);
  ok(verdicts.includes("sentence-applied"), "the apply itself is still recorded");
  await page.close();
}

// --- [5g2] The user editing the correction back is the log's own label ------
//
// A silent apply is the only write here nobody ratifies, so this is the
// strongest "that was wrong" signal the log can carry -- and until it existed
// the one bad apply this feature produced in the wild was known only because
// the owner said so out loud.

// Outcomes for one request, in the order they were reported.
const outcomes = (page, id) => page.evaluate((wanted) =>
  window.__sent
    .filter((m) => m.type === "REWRITE_OUTCOME" && (!wanted || m.requestId === wanted))
    .map((m) => ({ verdict: m.verdict, finalText: m.finalText })), id || null);

{
  // (a) Retyping the original INSIDE the span -> user-reverted.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  // Past the 600ms async reconcile check: until it has run, an edit inside the
  // span is indistinguishable from a controlled component throwing our write
  // away, and it is correctly read as the latter. No human reverts a
  // correction they have not yet seen.
  await sleep(800);
  ok((await val(page)).startsWith("The technician"), "correction applied first");

  // Take the inserted "i" back out with a REAL Backspace: "technician" ->
  // "techncian" is exactly what the user typed before we touched it.
  await page.evaluate(() => document.querySelector("#ta").setSelectionRange(10, 10));
  await page.keyboard.press("Backspace");
  await sleep(2600);                                  // past the 2s settle

  const got = await outcomes(page);
  const rev = got.find((o) => o.verdict === "user-reverted");
  ok(!!rev, `an exact revert is logged as user-reverted (${JSON.stringify(got.map((o) => o.verdict))})`);
  ok(rev && rev.finalText === "The techncian arrived early.",
     `and it carries what the user put back: ${JSON.stringify(rev && rev.finalText)}`);
  await page.close();
}

{
  // (c) An in-span edit that does NOT restore the original is the weaker
  // verdict -- changed, but to a third thing.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await sleep(800);
  // Between "early" and its full stop -- inside the corrected span.
  await page.evaluate(() => document.querySelector("#ta").setSelectionRange(28, 28));
  await page.keyboard.type(" today", { delay: 25 });
  await sleep(2600);

  const got = await outcomes(page);
  const ed = got.find((o) => o.verdict === "user-edited-correction");
  ok(!!ed, `an in-span edit is logged (${JSON.stringify(got.map((o) => o.verdict))})`);
  ok(ed && ed.finalText === "The technician arrived early today.",
     `with the user's own version of the sentence: ${JSON.stringify(ed && ed.finalText)}`);
  ok(!got.some((o) => o.verdict === "user-reverted"),
     "and it is not confused with a revert");
  await page.close();
}

{
  // (d) An edit BEFORE the span abandons the watch. The offsets are measured
  // from the start of the field, so text appearing in front of them makes
  // every later comparison a slice of unrelated text -- the same
  // prefix-stability rule the anchor and the flash overlay are built on.
  //
  // Two sentences, because the first correction starts at offset 0 and nothing
  // can be typed before it.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("This sentance is wrong. We recieved the invoice yesterday. The",
                           { delay: 20 });
  await sleep(700);
  const both = await val(page);
  ok(both.startsWith("This sentence is wrong. We received"),
     `both sentences corrected: ${JSON.stringify(both)}`);

  // Prepend, then revert the second correction. The revert is real and would
  // otherwise report; the watch has to be gone.
  await page.evaluate(() => document.querySelector("#ta").setSelectionRange(0, 0));
  await page.keyboard.type("Hm. ", { delay: 20 });
  await sleep(2600);
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    const i = el.value.indexOf("received") + 4;       // between "rece" and "ived"
    el.setSelectionRange(i, i);
  });
  await page.keyboard.type("i", { delay: 20 });       // "received" -> "receiived"...
  await sleep(2600);

  const got = await outcomes(page);
  ok(!got.some((o) => o.verdict === "user-reverted" || o.verdict === "user-edited-correction"),
     `nothing is attributed once the prefix moved (${JSON.stringify(got.map((o) => o.verdict))})`);
  await page.close();
}

// --- [5g3] Feedback cannot attribute an eventless page mutation -----------
// Mutant: delete `if (live !== w.text) return;` in watchSentenceEdit.
// Red: [5g3] only the apply is reported; the page's text is not user feedback.
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await sleep(900);
  ok((await val(page)) === "The technician arrived early. The",
     "[5g3] the correction landed before the edit");
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    window.__editInputs = [];
    el.addEventListener("input", (e) => {
      if (e.isTrusted) window.__editInputs.push(el.value);
    });
    el.setSelectionRange(9, 9);
  });
  await page.keyboard.type("7");
  await sleep(100); // after the observer's settle, before feedback's two seconds
  const edited = await page.evaluate(() => window.__editInputs);
  ok(JSON.stringify(edited) === JSON.stringify(["The techn7ician arrived early. The"]),
     `[5g3] one trusted in-span edit reached input: ${JSON.stringify(edited)}`);
  await page.evaluate(() => {
    document.querySelector("#ta").value = "The page changed this sentence. The";
  });
  await sleep(2600);
  ok((await val(page)) === "The page changed this sentence. The",
     "[5g3] the later eventless page text is still in the field");
  const got = await outcomes(page);
  ok(JSON.stringify(got) === JSON.stringify([{ verdict: "sentence-applied" }]),
     `[5g3] only the apply is reported; the page's text is not user feedback: ${JSON.stringify(got)}`);
  await page.close();
}

// --- [5g4] Synthetic input is not a settled user-edit receipt -------------
// Mutant: in watchSentenceEdit, add `el.addEventListener("input", () =>
// noteSentenceEditWatch(st, snText(el), st.userEditSeq));` beside w.expiry.
// Red: [5g4] synthetic input produces no feedback.
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await sleep(900);
  ok((await val(page)) === "The technician arrived early. The",
     "[5g4] the correction landed before the synthetic edit");
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    window.__editEvents = [];
    for (const type of ["beforeinput", "input"]) {
      el.addEventListener(type, (e) => window.__editEvents.push({ type, trusted: e.isTrusted }));
    }
    el.value = "The techn7ician arrived early. The";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "7" }));
  });
  await sleep(2600);
  const events = await page.evaluate(() => window.__editEvents);
  ok(JSON.stringify(events) === JSON.stringify([{ type: "input", trusted: false }]),
     `[5g4] the only event was the page's synthetic input: ${JSON.stringify(events)}`);
  ok((await val(page)) === "The techn7ician arrived early. The",
     "[5g4] the page's in-span mutation remains");
  const got = await outcomes(page);
  ok(JSON.stringify(got) === JSON.stringify([{ verdict: "sentence-applied" }]),
     `[5g4] synthetic input produces no feedback: ${JSON.stringify(got)}`);
  await page.close();
}

// --- [5h] Removing the field tears the job down ---------------------------
{
  // Removing an element changes focus WITHOUT firing blur, so focusout-based
  // teardown never runs and a pending idle timer would still send the text.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early.", { delay: 20 });
  await page.evaluate(() => document.querySelector("#ta").remove());
  await sleep(1200);                                  // past the 600ms idle timer
  ok((await requests(page)).length === 0,
     `a detached field sends nothing (${JSON.stringify(await requests(page))})`);
  await page.close();
}

// --- [5i] maxlength must refuse, not truncate -----------------------------
{
  // execCommand does NOT fail on maxlength -- it returns true and silently
  // truncates the replacement to fit, deleting a character of the user's own
  // text. The truncation was then misread as the page reconciling our write,
  // so the field was blocked and nothing was logged: corrupted text, and no
  // signal at all. Capped fields are everywhere.
  const page = await freshPage(true);
  await page.click("#capped");
  await sleep(100);
  const typedText = "The techncian arrived early. The";   // exactly 32 chars
  await page.keyboard.type(typedText, { delay: 20 });
  await sleep(900);
  const got = await val(page, "#capped");
  ok(got === typedText,
     `a capped field is left exactly as typed: ${JSON.stringify(got)}`);
  const verdicts = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict));
  ok(!verdicts.includes("sentence-applied"), "and nothing was logged as applied");
  // "Nothing was applied" is only half of it, and the weaker half. The model
  // produced a correction and the field could not hold it, and this exit
  // counted a skip and returned -- so the record kept `verdict: null`, which is
  // what a request still in flight looks like. The one refusal a user can
  // actually act on ("your correction did not fit") was the one the log could
  // not distinguish from a hang.
  ok(verdicts.includes("sentence-skipped:maxlength"),
     `and the refusal says so on the record: ${JSON.stringify(verdicts)}`);
  await page.close();
}

// --- [5j] An RTL field never shows a stale highlight ----------------------
{
  // "Typing after the range cannot move it" holds only for a left-aligned LTR
  // line. In RTL, appending slides the whole line -- measured at 58.9px, seven
  // characters off, with the green box over the wrong glyphs.
  const page = await freshPage(true);
  await page.click("#rtl");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await sleep(150);
  const born = await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length);
  await page.keyboard.type("n we go", { delay: 20 });
  await sleep(80);
  const after = await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length);
  ok(after === 0, `RTL drops the flash rather than leaving it misplaced (born ${born}, after ${after})`);
  ok((await val(page, "#rtl")).startsWith("The technician arrived early."),
     "the correction itself still applied");
  await page.close();
}

// --- [5k] A late reconcile is caught, and un-claims the apply -------------
{
  // One frame is not enough: a React render behind a debounce lands at
  // 100-400ms. Missing it left a bogus sentence-applied in the log and no
  // block -- so it kept fighting.
  const page = await freshPage(true);
  // A controlled component that rejects our edit on its own render, 250ms
  // later -- far outside the one frame the check used to allow.
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.addEventListener("input", () => {
      if (!el.value.includes("technician")) return;
      const restored = el.value.replace("technician", "techncian");
      setTimeout(() => { el.value = restored; }, 250);
    });
  });
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. The", { delay: 25 });
  await sleep(1400);
  const verdicts = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict));
  ok(verdicts.includes("sentence-reconciled"),
     `a late reconcile is detected and reported (${JSON.stringify(verdicts)})`);
  await page.close();
}

// --- [5l] The flash does not outlive the field moving ---------------------
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then", { delay: 25 });
  await sleep(300);
  ok(await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length > 0),
     "the flash is up");
  // Nothing here fires `input` -- an ad loading above the field, an accordion
  // opening, a font swapping in. The overlay is positioned in the viewport, so
  // without the watchdog it stays where it was and highlights unrelated content.
  await page.evaluate(() => { document.body.style.paddingTop = "160px"; });
  await sleep(120);
  ok(await page.evaluate(() => document.querySelectorAll(".proofer-sentence-flash").length === 0),
     "flash removed when the field moved without any input event");
  await page.close();
}

// --- [5m] Escape refuses when the correction no longer anchors -------------
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then", { delay: 25 });
  await sleep(300);
  // Overwrite the corrected span from the page. The undo record still points at
  // [4,14) and still remembers "techncian" -- writing that back over whatever
  // is there now is exactly the wrong-span splice this path exists to prevent.
  await page.evaluate(() => {
    const el = document.querySelector("#ta");
    el.focus();
    el.setSelectionRange(4, 14);
    document.execCommand("insertText", false, "ENGINEER!!");
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await sleep(150);
  const before = await val(page);
  await page.keyboard.press("Escape");
  await sleep(150);
  ok((await val(page)) === before,
     `Escape leaves the text alone once the anchor is gone: ${JSON.stringify(before)}`);
  ok(await page.evaluate(() =>
       !window.__sent.some((m) => m.verdict === "sentence-undone")),
     "and nothing is reported as undone");
  await page.close();
}

// --- [5n] The overlay measures from the PADDING box, not the border box ---
{
  // In an RTL textarea Chrome puts the vertical scrollbar on the LEFT, so the
  // text starts a scrollbar-width further right than a mirror div's does.
  // Measuring border-box-to-border-box put every highlight 15px off, covering
  // "e techncia" instead of "techncian".
  //
  // Headless always uses zero-width overlay scrollbars, so the real thing is
  // unreachable here. clientLeft is exactly "left border + any scrollbar on
  // that side", so overriding it simulates the gutter and proves the offset is
  // read from it.
  // A fresh page per measurement: clearing the field programmatically is
  // (correctly) treated as a bulk insertion. Measured inside the flash's
  // 1600ms life (it ran on suggestion mode's persistent mark until that mode
  // was removed on 2026-09-24).
  const measure = async (fakeGutter) => {
    const p = await freshPage(true);
    if (fakeGutter) {
      await p.evaluate((g) => {
        Object.defineProperty(document.querySelector("#ta"), "clientLeft",
          { configurable: true, value: g });
      }, fakeGutter);
    }
    await p.click("#ta");
    await sleep(80);
    await p.keyboard.type("The techncian arrived early. Then", { delay: 20 });
    await sleep(500);
    const r = await p.evaluate(() => {
      const m = document.querySelector(".proofer-sentence-mark");
      const el = document.querySelector("#ta");
      return m ? { left: m.getBoundingClientRect().left, clientLeft: el.clientLeft } : null;
    });
    await p.close();
    return r;
  };
  const plain = await measure(0);
  const gutter = await measure(17);
  ok(plain !== null && gutter !== null,
     `both cases produced a mark (${JSON.stringify(plain)}, ${JSON.stringify(gutter)})`);
  // The expected shift is the CHANGE in clientLeft, not the raw 17 -- the
  // textarea already had a 1px border of its own.
  const want = plain && gutter ? gutter.clientLeft - plain.clientLeft : NaN;
  const got = plain && gutter ? gutter.left - plain.left : NaN;
  ok(Math.abs(got - want) < 0.5,
     `the highlight moves with the left gutter (expected +${want}, got +${got})`);
}

// --- [8] Non-English fields are left alone ---------------------------------
{
  const page = await freshPage(true);
  await page.evaluate(() => document.documentElement.setAttribute("lang", "fr"));
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then we shipped", { delay: 20 });
  await sleep(700);
  ok((await requests(page)).length === 0, "nothing fired on a lang=fr document");
  ok(await val(page) === "The techncian arrived early. Then we shipped", "and the text is untouched");
  await page.close();
}

// --- [9] Contenteditable: the adapter reads text and a caret ---------------
{
  const page = await freshPage(true);
  const api = async (fn, ...args) => page.evaluate(fn, ...args);

  console.log("\n[9] Contenteditable field adapter");
  await page.click("#ce");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early.", { delay: 20 });

  ok(await api(() => window.__prooferSentence.snIsCE(document.querySelector("#ce"))),
     "snIsCE recognises a contenteditable");
  ok(await api(() => !window.__prooferSentence.snIsCE(document.querySelector("#ta"))),
     "and does not claim a textarea");
  ok(await api(() => window.__prooferSentence.snText(document.querySelector("#ce"))
       === "The techncian arrived early."),
     "snText reads the typed text back out of the DOM");
  ok(await api(() => window.__prooferSentence.snCaret(document.querySelector("#ce")).start === 28),
     "snCaret reports the caret as a text offset");
  ok(await api(() => window.__prooferSentence.snMaxLength(document.querySelector("#ce")) === Infinity),
     "a contenteditable has no maxlength to truncate against");
  ok(await api(() => window.__prooferSentence.snIsFocused(document.querySelector("#ce"))),
     "snIsFocused is true for the focused editable");
  await page.close();
}

// --- [10] A plain contenteditable is not eligible at all -------------------
//
// It used to be. Writing to a rich editor means getting the EDITOR'S MODEL to
// agree, not just the DOM, and that was measured for Slate and for nothing
// else -- see sentence-slate-test.mjs. A ProseMirror or Lexical field can take
// the write, show it for 600ms, pass every check we have, and then revert it on
// the next keystroke with the user's keystrokes at the wrong offset.
{
  const page = await freshPage(true);
  await page.click("#ce");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then we shipped", { delay: 25 });
  await sleep(700);

  ok((await requests(page)).length === 0,
     `no request fired on an unrecognized contenteditable (${JSON.stringify(await requests(page))})`);
  ok(await page.evaluate(() => document.querySelector("#ce").textContent
       === "The techncian arrived early. Then we shipped"),
     "and nothing was written to it");

  // The refusal has to have a NAME. Attaching to nothing and saying nothing is
  // what made "I turned it on for claude.ai and it is not running" impossible
  // to tell apart from a broken extension.
  const why = await page.evaluate(() =>
    window.__prooferSentence.sentenceFieldStatus(document.querySelector("#ce")));
  ok(why.ok === false && why.status === "unsupported-editor" && why.detail === "unknown-editor",
     `and the refusal says why: ${JSON.stringify(why)}`);
  ok(await page.evaluate(() => window.__prooferSentence.snIsSlate(document.querySelector("#slate"))),
     "and it does recognise the Slate-shaped one");
  await page.close();
}

// --- [10b] The transport registry picks a recipe per family ----------------
//
// Fingerprint only: these fixtures have no editor behind them, so this is the
// ROUTING decision and nothing else. Which recipe each family takes was
// measured against the real editors -- see sentence-editors-test.mjs. Getting
// it backwards is silent in both directions: INTENT on ProseMirror writes
// nothing and eats a keystroke, MUTATION on Slate shows the correction and
// reverts it on the next one.
{
  const page = await freshPage(true);
  console.log("\n[10b] Transport registry");
  const rows = await page.evaluate(() => {
    const S = window.__prooferSentence;
    const out = {};
    for (const id of ["slate", "pm", "tiptap", "quill", "lexical", "ce", "rich"]) {
      const a = S.editorAdapterFor(document.querySelector("#" + id));
      out[id] = a ? { family: a.family, recipe: a.recipe, caret: a.caret } : null;
    }
    return out;
  });
  const expect = {
    slate:   { family: "Slate",       recipe: "intent",   caret: "in-recipe" },
    pm:      { family: "ProseMirror", recipe: "mutation", caret: "checked" },
    // A heavily-plugged ProseMirror, deliberately matched by the same row:
    // measured indistinguishable from core PM on both text and caret, 8/8 each.
    tiptap:  { family: "ProseMirror", recipe: "mutation", caret: "checked" },
    quill:   { family: "Quill",       recipe: "mutation", caret: "checked" },
    // Text behaves as MUTATION, selection behaves as INTENT: Lexical reconciles
    // one task turn later and re-imposes its own caret (0/8 without the
    // re-impose, 3/3 with it).
    lexical: { family: "Lexical",     recipe: "mutation", caret: "reimpose" },
    ce:      null,
    rich:    null,
  };
  for (const [id, want] of Object.entries(expect)) {
    ok(JSON.stringify(rows[id]) === JSON.stringify(want),
       `#${id} -> ${JSON.stringify(rows[id])}`);
  }

  // Deny by default is the whole contract: an editor nobody measured is not
  // "probably fine", it is an unknown model with a silent failure mode.
  const eligible = await page.evaluate(() => {
    const S = window.__prooferSentence;
    const r = {};
    for (const id of ["slate", "pm", "quill", "lexical", "ce"]) {
      r[id] = S.sentenceEligibleEl(document.querySelector("#" + id));
    }
    return r;
  });
  ok(eligible.slate && eligible.pm && eligible.quill && eligible.lexical && !eligible.ce,
     `every certified family is eligible and nothing else is: ${JSON.stringify(eligible)}`);
  await page.close();
}

// --- [10c] A block reports the cause it was given -------------------------
//
// `session-blocked` has distinct causes (the original four here, normalization
// in [10f]), and they are not interchangeable: "the editor refused the write" sends you to the transport,
// "the page reconciled it away" sends you to the host app, and the two demoting
// causes withdraw the fingerprint for every field of that family. The element
// half used to be a WeakSet, so every non-demoting block came back as
// `write-rejected` whatever had actually happened -- a diagnostic naming a
// cause it never observed, which sent two readers to the wrong branch in a day.
//
// Driven directly. Reaching the two non-demoting causes through real writes
// needs two editors that fail in two different ways, and a suite built that way
// measures the fixtures rather than the reporting.
{
  const page = await freshPage(true);
  console.log("\n[10c] Block causes");
  const seen = await page.evaluate(() => {
    const S = window.__prooferSentence;
    const el = (id) => document.querySelector("#" + id);
    const out = {};
    // Two different NON-demoting causes, on two different families, so neither
    // can be reading the other's answer.
    S.blockSentenceField(el("pm"), "reconciled");
    out.reconciled = S.sentenceFieldStatus(el("pm"));
    S.blockSentenceField(el("quill"), "write-rejected");
    out.refused = S.sentenceFieldStatus(el("quill"));
    // The first cause is the one that stopped the field; a later block is
    // downstream of a field we had already given up on.
    S.blockSentenceField(el("pm"), "write-rejected");
    out.firstWins = S.sentenceFieldStatus(el("pm"));
    // A demoting cause is reported off the family map, which already kept its
    // own reason -- pinned here so the two halves cannot drift apart.
    S.blockSentenceField(el("lexical"), "wrote-elsewhere");
    out.demoted = S.sentenceFieldStatus(el("lexical"));
    out.adapter = S.editorAdapterFor(el("lexical"));
    // ...and demotion is per family: blocking Lexical must not touch Quill's.
    out.otherFamily = S.editorAdapterFor(el("tiptap"));
    return out;
  });
  ok(seen.reconciled.status === "session-blocked" && seen.reconciled.detail === "reconciled",
     `a reconciled write says so: ${JSON.stringify(seen.reconciled)}`);
  ok(seen.refused.status === "session-blocked" && seen.refused.detail === "write-rejected",
     `a refused write says so, distinctly: ${JSON.stringify(seen.refused)}`);
  ok(seen.firstWins.detail === "reconciled",
     `a second block does not overwrite the cause: ${JSON.stringify(seen.firstWins)}`);
  ok(seen.demoted.status === "session-blocked" && seen.demoted.detail === "wrote-elsewhere",
     `a demoting cause keeps its name too: ${JSON.stringify(seen.demoted)}`);
  ok(seen.adapter === null, "and it withdrew the whole family");
  ok(seen.otherFamily && seen.otherFamily.family === "ProseMirror",
     `while another family is untouched: ${JSON.stringify(seen.otherFamily)}`);

  // THE PATH THAT ACTUALLY LIED, end to end. blockSentenceField sets the live
  // status from the cause it was handed, so the moment of the block always read
  // correctly and the defect hid behind it. attachSentence RECOMPUTES on focus
  // -- so clicking away and back, which is what a user does on the way to the
  // toolbar, overwrote the real cause with the constant. That is the state the
  // popup reports.
  await page.click("#pm");
  await sleep(150);
  const report = await page.evaluate(() => window.__prooferSentence.sentenceStatusReport());
  ok(report.status === "session-blocked" && report.detail === "reconciled",
     `refocusing a blocked field still reports the real cause: ${JSON.stringify(
       { status: report.status, detail: report.detail, family: report.family })}`);
  ok(report.last && report.last.detail === "reconciled",
     `and the verdict kept across the blur agrees: ${JSON.stringify(report.last)}`);
  await page.close();
}

// [10f] Mutant: add "write-normalized" to DEMOTING_BLOCKS; the fresh-element
// eligibility assertion turns red while the blocked field retains its cause.
{
  console.log("\n[10f] Normalization is a non-demoting block cause");
  const page = await freshPage(true);
  const out = await page.evaluate(() => {
    const S = window.__prooferSentence;
    const el = document.querySelector("#pm");
    S.blockSentenceField(el, "write-normalized");
    const said = S.sentenceStatusReport();
    S.blockSentenceField(el, "write-rejected");
    return { said, field: S.sentenceFieldStatus(el), fresh: S.sentenceFieldStatus(document.querySelector("#tiptap")) };
  });
  ok(out.said.status === "session-blocked" && out.said.detail === "write-normalized"
    && out.field.detail === "write-normalized", "[10f] normalized cause survives status readback and a later block");
  ok(out.fresh.ok && out.fresh.family === "ProseMirror", "[10f] a fresh same-family field remains eligible");
  await page.close();
}

// --- [10d] Canvas fallback obeys frame priority ---------------------------
// SD-15 one-line mutants in content.js:
// `return replySentenceStatus(null, null, () => ({` ->
// `return ((focused, last, report, respond) => respond(report()))(null, null, () => ({`
// makes child suppression, remembered winner and 150 ms fallback assertions red.
// In replySentenceStatus, `return true;` -> `return;` loses delayed replies
// (remembered winner, standalone fallback and supported-child winner go red).
{
  console.log("\n[10d] Canvas fallback obeys frame priority");
  const normal = await statusFrames(false, "canvas");
  await rememberTextarea(normal.mainFrame());
  const child = normal.frames().find((f) => f !== normal.mainFrame());
  const remembered = await statusBus([child, normal.mainFrame()]);
  ok(!remembered.responses.some((r) => r.index === 0) && !remembered.scheduled.some((t) => t.index === 0),
     "[10d] canvas child supplies no response or timer");
  ok(remembered.winner?.index === 1 && remembered.winner.report.last?.family === "textarea",
     "[10d] remembered textarea wins over canvas child");
  await normal.close();

  const canvas = await statusFrames(true);
  const fallback = await statusBus([canvas.mainFrame()]);
  ok(JSON.stringify(fallback.scheduled.map((t) => t.delay)) === "[150]",
     "[10d] canvas top schedules the 150 ms empty-frame fallback");
  ok(fallback.winner?.report.detail === "canvas-host" && fallback.winner.report.top === true
    && fallback.winner.report.apply === false && fallback.winner.report.last === null,
     "[10d] canvas top delivers its unchanged refusal through the async channel");
  await canvas.close();

  const embedded = await statusFrames(true, "supported");
  const editor = embedded.frames().find((f) => f !== embedded.mainFrame());
  await editor.click("#ta");
  await editor.waitForFunction(() => window.__prooferSentence.sentenceStatusReport().status === "active");
  const focused = await statusBus([embedded.mainFrame(), editor]);
  ok(JSON.stringify(focused.scheduled.map((t) => t.delay)) === "[150,0]",
     "[10d] focused child schedules 0 ms ahead of canvas top at 150 ms");
  ok(focused.winner?.index === 1 && focused.winner.report.family === "textarea" && focused.winner.report.top === false,
     "[10d] supported child wins before canvas fallback");
  await embedded.close();
}

// --- [10e] Remembered replies remain bounded -----------------------------
// SD-16 one-line mutant: replace the helper's Math.min expression with
// `? Math.round((Date.now() - last.at) / 60000) * SN_STATUS_STALENESS_MS`
// Two/five-minute 120 ms delays and their priority over 150 ms turn red.
{
  console.log("\n[10e] Remembered replies remain bounded");
  const empty = await statusFrames(false);
  const recent = await statusFrames(false);
  const older = await statusFrames(false);
  await rememberTextarea(recent.mainFrame());
  await rememberTextarea(older.mainFrame());
  const age = (page, ms) => page.evaluate((ms) => {
    window.__now = window.__prooferSentence.sentenceStatusReport().last.at + ms;
  }, ms);
  for (const [ms, expected] of [[29999, 60], [30000, 120], [120000, 120], [300000, 120]]) {
    await age(recent, ms);
    const result = await statusBus([empty.mainFrame(), recent.mainFrame()]);
    ok(JSON.stringify(result.scheduled.map((t) => t.delay)) === JSON.stringify([150, expected]),
       `[10e] age ${ms} ms schedules ${expected} ms against empty top at 150 ms`);
    ok(result.winner?.index === 1 && result.winner.report.last?.family === "textarea",
       `[10e] age ${ms} ms remembered report precedes empty fallback`);
  }
  await age(recent, 120000);
  await age(older, 300000);
  for (const frames of [[recent.mainFrame(), older.mainFrame()], [older.mainFrame(), recent.mainFrame()]]) {
    const tied = await statusBus([empty.mainFrame(), ...frames]);
    ok(JSON.stringify(tied.scheduled.map((t) => t.delay)) === "[150,120,120]"
      && [120000, 300000].includes(tied.winner?.report.last?.agoMs),
       "[10e] either tied older history may win, both precede empty fallback");
  }
  await Promise.all([empty.close(), recent.close(), older.close()]);
}

// --- [11] Discord-shaped Slate DOM ----------------------------------------
{
  const page = await freshPage(true);
  await page.click("#slate");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then we shipped", { delay: 25 });
  await sleep(1400);            // CE writes wait for the idle path, not 3-chars-in
  ok((await requests(page)).includes("The techncian arrived early."),
     "the trigger fires when the editing host is an ancestor of the text");

  // What this fixture CANNOT test is the write, and that is the point. There is
  // no Slate behind this DOM, so nothing handles the beforeinput -- which is
  // exactly the shape of an editor that ignores us. The write must notice and
  // report failure, rather than returning true for a change it never made.
  const wrote = await page.evaluate(async () => {
    const el = document.querySelector("#slate");
    const S = window.__prooferSentence;
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    return S.spliceSentenceSlate(el, start, start + "The techncian arrived early.".length,
                                 "The technician arrived early.");
  });
  // A TRANSPORT failure, not a precondition refusal, and the two now have
  // opposite consequences: the editor was asked and did not act, so every later
  // sentence would fail the same way and the field is blocked. A stale range or
  // an atom in the range costs one sentence and nothing else.
  ok(wrote.ok === false && wrote.outcome === "failed-transport" && wrote.reason === "untrusted-rejected" && wrote.window === null,
     `a DOM with no editor behind it is an immediate transport rejection (${JSON.stringify(wrote)})`);
  ok(await page.evaluate(() => document.querySelector("#slate").textContent
       === "The techncian arrived early. Then we shipped"),
     "and the user's text is untouched");
  await page.close();
}

// --- [12] A sentence crossing a formatting boundary is refused ------------
{
  const page = await freshPage(true);
  // "The <b>techncian</b> arrived early." -- replacing this range would
  // flatten the bold run, so spliceSentenceCE must refuse rather than apply.
  await page.evaluate(() => {
    const el = document.querySelector("#rich");
    el.innerHTML = 'The <b>techncian</b> arrived early.';
  });
  const landed = await page.evaluate(() => {
    const el = document.querySelector("#rich");
    const S = window.__prooferSentence;
    const text = S.snText(el);
    return { text, ok: text === "The techncian arrived early." };
  });
  ok(landed.ok, `snText flattens formatting for reading: ${JSON.stringify(landed.text)}`);

  const spliced = await page.evaluate(() => {
    const el = document.querySelector("#rich");
    el.focus();
    // Drive the shipping splice directly; there is no way to type a bold run.
    return window.__prooferSentence.spliceSentenceCE(el, 0, 28, "The technician arrived early.");
  });
  // A PRECONDITION refusal: this range is not ours to replace. It costs this
  // sentence and leaves the field enabled -- unlike a transport failure, which
  // blocks it. Those used to be the same `false`.
  ok(spliced.ok === false && spliced.outcome === "refused-precondition"
     && spliced.reason === "non-uniform-range",
     `a splice across a <b> boundary is refused (${JSON.stringify(spliced)})`);
  const untouched = await page.evaluate(() => document.querySelector("#rich").innerHTML);
  ok(untouched === "The <b>techncian</b> arrived early.",
     `the markup is untouched: ${JSON.stringify(untouched)}`);

  // An emoji image and a mention pill carry no text of their own, so a
  // style comparison cannot see them. Discord's composer is full of both, and
  // replacing the range would silently delete them.
  for (const [label, html] of [
    ["an emoji image", 'The techncian <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""> arrived early.'],
    ["a mention pill", 'The techncian <span data-mention="1">@ops</span> arrived early.'],
    ["a non-editable chip", 'The techncian <span contenteditable="false">[x]</span> arrived early.'],
  ]) {
    const kept = await page.evaluate((h) => {
      const el = document.querySelector("#rich");
      el.innerHTML = h;
      el.focus();
      const S = window.__prooferSentence;
      const text = S.snText(el);
      const r = S.spliceSentenceCE(el, 0, text.length, "The technician arrived early.");
      const refused = r.ok === false && r.outcome === "refused-precondition";
      return { refused, html: el.innerHTML };
    }, html);
    ok(kept.refused && kept.html === html, `${label} is refused, not deleted`);
  }

  // From a codex audit: a link styled to match its surroundings has an
  // IDENTICAL style signature, so the computed-style comparison cannot see it.
  // Replacing the range drops the <a> and its href.
  for (const [label, html] of [
    ["a style-matched link", 'The <a href="/t/1" style="color:inherit;text-decoration:none">techncian</a> arrived early.'],
    ["a plain link", 'The <a href="/t/1">techncian</a> arrived early.'],
    ["a code span", 'The <code>techncian</code> arrived early.'],
  ]) {
    const kept = await page.evaluate((h) => {
      const el = document.querySelector("#rich");
      el.innerHTML = h;
      el.focus();
      const S = window.__prooferSentence;
      const r = S.spliceSentenceCE(el, 0, S.snText(el).length,
        "The technician arrived early.");
      const refused = r.ok === false && r.outcome === "refused-precondition";
      return { refused, html: el.innerHTML };
    }, html);
    ok(kept.refused && kept.html === html, `${label} is refused, not flattened`);
  }

  // The positive case must still work: two text nodes that render identically
  // are one run as far as the user is concerned, and Slate splits lines like
  // this routinely.
  const uniform = await page.evaluate(() => {
    const el = document.querySelector("#rich");
    el.innerHTML = '<span>The techncian </span><span>arrived early.</span>';
    el.focus();
    const S = window.__prooferSentence;
    const okSplice = S.spliceSentenceCE(el, 0, S.snText(el).length, "The technician arrived early.");
    return { okSplice, text: el.textContent };
  });
  ok(uniform.okSplice.ok === true && uniform.okSplice.outcome === "landed"
     && uniform.text === "The technician arrived early.",
     `identically-styled runs still splice: ${JSON.stringify(uniform)}`);
  await page.close();
}

// --- [13] An editor that restructures during the write -------------------
{
  const page = await freshPage(true);

  console.log("\n[13] A synchronous re-render during the splice");
  // An input handler that splits the field into blocks the moment we write,
  // which is what a controlled rich editor does. buildSegmentsForElement then
  // synthesises a "\n" the length delta knows nothing about.
  const res = await page.evaluate(() => {
    const el = document.querySelector("#rich");
    el.innerHTML = "";
    el.textContent = "The techncian arrived early. Next";
    el.focus();
    const S = window.__prooferSentence;
    // Put the caret after "Next", where a real user would be.
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);

    let fired = false;
    el.addEventListener("input", () => {
      if (fired) return;
      fired = true;
      const t = el.textContent;
      const cut = t.indexOf("early.") + 6;
      el.innerHTML = "";
      const a = document.createElement("div");
      a.textContent = t.slice(0, cut);
      const b = document.createElement("div");
      b.textContent = t.slice(cut);
      el.append(a, b);
    });

    S.spliceSentenceCE(el, 0, 28, "The technician arrived early.");
    const live = S.snText(el);
    const caret = S.snCaret(el);
    // Whatever happened, the caret must not sit INSIDE the trailing word.
    const idx = live.lastIndexOf("Next");
    const insideNext = caret.start != null && caret.start > idx && caret.start < idx + 4;
    return { live, caret: caret.start, insideNext, text: el.textContent };
  });
  ok(res.insideNext === false,
     `the caret is not left inside the trailing word (offset ${res.caret}, ${JSON.stringify(res.live)})`);
  ok(res.text.includes("technician") && res.text.includes("Next"),
     `the correction landed and the user's text survived: ${JSON.stringify(res.text)}`);

  console.log("\n[13b] Text mutated elsewhere is not reported as a clean write");
  const landed = await page.evaluate(() => {
    const el = document.querySelector("#rich");
    el.innerHTML = "";
    el.textContent = "The techncian arrived early.  Two  spaces  later.";
    const S = window.__prooferSentence;
    const live = S.snText(el);
    const expected = live.slice(0, 0) + "The technician arrived early." + live.slice(28);
    // Simulate the editor collapsing the double spaces while handling our write.
    el.textContent = "The technician arrived early. Two spaces later.";
    return S.sentenceWriteLanded(el, expected, 0, 29, "The technician arrived early.");
  });
  ok(landed === false, `whitespace rewritten elsewhere is caught (${landed})`);
  await page.close();
}

// --- [13c] The write is narrowed to the span that DIFFERS ------------------
//
// Replacing all of a block's text is a node-level DOM mutation rather than an
// edit inside a text node, and two certified families reconcile that away
// silently and in opposite directions -- Lexical drops the write outright
// (measured 6/6, and it lands with one character of tail at either end), Draft
// duplicates the corrected block over the next one. Narrowing keeps the write
// inside the node. What that costs is an invariant with three parts, and each
// one is a way to corrupt text rather than merely a tidiness rule.
{
  const page = await freshPage(true);
  console.log("\n[13c] narrowEdit keeps the write inside the node");

  const cases = [
    ["The techncian arrived early.", "The technician arrived early.", "one letter inserted mid-word"],
    ["The team have been working on it.", "The team has been working on it.", "a shortening substitution"],
    ["i went to the store.", "I went to the store.", "the FIRST character only"],
    ["We shipped it out", "We shipped it out.", "the LAST character only"],
    ["I went to store.", "I went to the store.", "a pure insertion"],
    ["the the report was late.", "the report was late.", "a pure deletion"],
    ["ok", "OK.", "both ends change -- nothing to narrow"],
    ["The techncian arrived early \u{1F600}.", "The technician arrived early \u{1F600}.", "an emoji after the edit"],
    ["I saw \u{1F600} yesterday.", "I saw \u{1F601} yesterday.", "the emoji IS the edit"],
  ];
  const out = await page.evaluate((cs) => cs.map(([before, after, what]) => {
    const e = window.__prooferSentence.narrowEdit(before, after);
    const head = e.head, tail = e.tail;
    return {
      what, head, tail, text: e.text,
      // The whole point: applying the narrowed write to the original must
      // produce exactly the correction the guards approved.
      rebuilt: before.slice(0, head) + e.text + before.slice(before.length - tail),
      after,
      rangeLen: (before.length - tail) - head,
      // A boundary through a surrogate pair leaves a lone half on each side --
      // a different string from the one that was approved.
      lone: /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(e.text)
        || /[\uD800-\uDBFF]$/.test(before.slice(0, head))
        || /^[\uDC00-\uDFFF]/.test(before.slice(before.length - tail)),
    };
  }), cases);

  for (const r of out) {
    ok(r.rebuilt === r.after,
       `${r.what}: rebuilds the approved correction exactly (${JSON.stringify(r.text)} at +${r.head})`);
  }
  // Both sides non-empty. A zero-length range cannot be built at all, and an
  // empty insertText is a `beforeinput` carrying no data -- a branch none of
  // the six families was measured on, where every one of them was measured on
  // a replacement.
  ok(out.every((r) => r.rangeLen >= 1 && r.text.length >= 1),
     `every write stays a replacement, both sides non-empty `
     + `(${JSON.stringify(out.map((r) => [r.rangeLen, r.text.length]))})`);
  ok(out.every((r) => !r.lone), "and no boundary splits a surrogate pair");
  // The narrowing has to actually narrow, or it buys nothing: the ordinary
  // correction must write far less than the whole sentence.
  const typo = out[0];
  ok(typo.rangeLen <= 2 && typo.text.length <= 2,
     `an ordinary typo writes a couple of characters, not the sentence `
     + `(range ${typo.rangeLen}, text ${typo.text.length})`);
  // And the residue is stated rather than hidden: when both ends change there
  // is nothing to narrow, which is the case sentenceWriteLanded has to name.
  const both = out.find((r) => r.what.startsWith("both ends"));
  ok(both.head === 0 && both.tail === 0,
     "a correction changing both ends still covers the sentence (nothing to narrow)");

  // End to end on a real contenteditable, with the sentence filling the block:
  // the shape that was 0/8 through the pipeline on Lexical.
  console.log("\n[13d] A sentence that fills its block still lands");
  const filled = await page.evaluate(() => {
    const el = document.querySelector("#rich");
    el.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = "The techncian arrived early.";
    el.append(p);
    el.focus();
    const S = window.__prooferSentence;
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    const res = S.spliceSentenceCE(el, 0, 28, "The technician arrived early.",
                                   S.editorAdapterFor(el));
    return { res, text: el.textContent, blocks: el.querySelectorAll("p").length };
  });
  ok(filled.res.ok === true && filled.res.outcome === "landed",
     `the splice lands with no tail to write into (${JSON.stringify(filled.res)})`);
  ok(filled.text === "The technician arrived early.",
     `and the block holds exactly the correction: ${JSON.stringify(filled.text)}`);
  ok(filled.blocks === 1, `with no block duplicated (${filled.blocks})`);
  await page.close();
}

// --- [14b] A trailing sentence with nobody typing after it -----------------
//
// The post-response chain fires with fromIdle=false, which needs three
// characters of the NEXT sentence. A trailing sentence has none, so it needs
// the idle timer -- and the idle timer only exists while the user is typing.
// At a realistic round trip the ordering is: sentence one fires mid-typing,
// typing stops, the idle timer fires into a busy request and is spent, then the
// response chains with fromIdle=false and finds nothing eligible. The last
// sentence the user wrote is never checked. The stub's default 20ms hides this
// completely, and so does 800ms: the response has to land more than one idle
// period after the last keystroke, so the timer is spent and not replaced.
// 1400ms is a slow-but-real round trip against a 419ms median.
{
  const page = await freshPage(true);
  await page.evaluate(() => { window.__delayMs = 1400; });
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. We recieved the invoice yesterday.",
                           { delay: 20 });
  await sleep(3000);

  const seen = await requests(page);
  ok(seen.includes("We recieved the invoice yesterday."),
     `the trailing sentence was checked on idle (${JSON.stringify(seen)})`);
  const text = await val(page);
  ok(text === "The technician arrived early. We received the invoice yesterday.",
     `both sentences corrected: ${JSON.stringify(text)}`);
  await page.close();
}

// [13e] Mutant: spliceFailurePolicy's misplaced apply prefix -> "sentence-skipped:";
// the exact misplaced outcome turns red, with the actual DOM mutation unchanged.
{
  console.log("\n[13e] MUTATION caller distinguishes post-write failures");
  for (const [mode, reason, cause, demoted] of [
    ["normalize", "normalized", "write-normalized", false],
    ["misplace", "misplaced", "wrote-elsewhere", true],
  ]) {
    const page = await freshPage(true);
    const out = await page.evaluate(async ({ mode }) => {
      const P = window.__prooferSentence, el = document.querySelector("#pm");
      const input = "The techncian arrived early.", output = "The technician arrived early.";
      el.textContent = input + " Next.";
      el.focus();
      const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      let inputs = 0;
      el.addEventListener("input", () => {
        inputs++;
        if (mode === "normalize") el.textContent += "!";
        else el.textContent = input + " Next." + output;
      });
      const recipe = P.editorAdapterFor(el).recipe;
      await P.applySentenceWrite({ el, start: 0, end: input.length, sentence: input, id: "sn_mutation_" + mode }, output, "sentence-applied");
      return { recipe, inputs, text: el.textContent, status: P.sentenceStatusReport(),
        fresh: P.sentenceFieldStatus(document.querySelector("#tiptap")),
        verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict) };
    }, { mode });
    ok(out.recipe === "mutation" && out.inputs === 1, `[13e/${mode}] registered MUTATION editor handled the real write`);
    const expected = mode === "normalize" ? "The technician arrived early. Next.!"
      : "The techncian arrived early. Next.The technician arrived early.";
    ok(out.text === expected, `[13e/${mode}] post-write mutation is not rolled back`);
    ok(JSON.stringify(out.verdicts) === JSON.stringify(["sentence-written:splice-failed:" + reason]),
      `[13e/${mode}] exact post-write outcome`);
    ok(out.status.status === "session-blocked" && out.status.detail === cause && out.fresh.ok === !demoted,
      `[13e/${mode}] distinct cause and family scope`);
    await page.keyboard.press("Escape");
    const afterEscape = await page.evaluate(() => ({ text: document.querySelector("#pm").textContent,
      verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict) }));
    ok(afterEscape.text === expected && afterEscape.verdicts.length === 1, `[13e/${mode}] failure armed no Escape slot`);
    await page.close();
  }
}

// --- [13] The warmup is a typing lease: first keystroke, then renewals -----
//
// The whole point is to move the ~2.0s model load off the end of the sentence,
// where the user is waiting, and onto the start of typing, where they are not
// — and, since the sentence lease dropped to 20s, to keep the runner up by
// RENEWING while keystrokes flow rather than by a 90s keep_alive tail after
// they stop. It must not fire per keystroke: the ping traffic is bounded by
// SENTENCE_WARM_RENEW_MS, and background.js's staleness dedup decides which
// pings actually touch Ollama.
{
  const page = await freshPage(true);
  const warmups = () => page.evaluate(() =>
    window.__sent.filter((m) => m.type === "SENTENCE_WARMUP").length);

  ok(await warmups() === 0, "no warmup before anything is typed");

  await page.click("#ta");
  await sleep(100);
  ok(await warmups() === 0, "focus alone does not warm — typing is the signal");

  await page.keyboard.type("The techncian arrived early.", { delay: 25 });
  await sleep(200);
  const afterFirst = await warmups();
  ok(afterFirst === 1, `exactly one warmup for one typing burst (got ${afterFirst})`);

  // Short continuous typing stays under the renewal throttle — a second ping
  // inside SENTENCE_WARM_RENEW_MS would be pure traffic.
  await page.keyboard.type(" Then we shipped it out the door.", { delay: 25 });
  await sleep(200);
  ok(await warmups() === 1, `still one within the renewal spacing (got ${await warmups()})`);

  // A pause longer than the throttle makes the next keystroke ping again.
  // This is also what covers the num_ctx collision: after a long manual
  // rewrite leaves the 4096 runner loaded, going back to typing is what
  // reloads 2048 before the next sentence needs it.
  await sleep(10200);                              // > SENTENCE_WARM_RENEW_MS
  await page.keyboard.type(" More.", { delay: 25 });
  await sleep(200);
  ok(await warmups() === 2, `typing after a pause warms again (got ${await warmups()})`);

  // And a burst LONGER than the renewal spacing re-pings mid-burst — this is
  // the renewal that keeps the 20s lease from expiring inside a long sentence,
  // and it is load-bearing, not tolerated traffic. ~11.5s of continuous
  // keystrokes (no terminator, so no request re-arms anything) must produce
  // exactly one more ping: at least one or the lease dies mid-sentence, and
  // no more than one because the throttle bounds it.
  await page.keyboard.type("word ".repeat(92), { delay: 25 });
  await sleep(200);
  const afterLong = await warmups();
  ok(afterLong === 3, `one renewal ping inside a long burst (got ${afterLong})`);
  await page.close();
}

// --- [14] A site sentence mode is switched off for has no warmup path at all
//
// Not "suppressed" — unreachable. The warmup hangs off the sentence-mode input
// handler, and that handler is never installed when the worker says no, which
// is why there is no second copy of the gating to drift.
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // The worker says no: the stub's consent switch, set before the page runs.
  // (This used to string-replace the stub's consent line, which a rewording
  // of that line silently turned into a no-op.)
  await page.evaluateOnNewDocument(STUB(true) + "\nwindow.__allowed = false;");
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.addStyleTag({ content: STYLES });
  await page.evaluate(CONTENT);
  await sleep(150);

  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then we shipped", { delay: 25 });
  await sleep(800);

  const warms = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "SENTENCE_WARMUP").length);
  const reqs = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "SENTENCE_REWRITE").length);
  ok(warms === 0, `no warmup on a site sentence mode is off for (got ${warms})`);
  ok(reqs === 0, `and no rewrite either (got ${reqs})`);
  await page.close();
}

// --- [14b] Worker refusal stops attachment -------------------------------
// Mutant: set sentenceAllowed = true in loadSentenceConsent's reply handler;
// the no-warmup/no-rewrite and off/not-allowed assertions turn red.
{
  const page = await freshPage(true);
  await page.evaluate(() => {
    window.__store.disabledSites = [location.origin];
    window.__allowed = false;
  });
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The techncian arrived early. Then we shipped", { delay: 25 });
  await sleep(800);

  const types = await page.evaluate(() => window.__sent.map((m) => m.type));
  ok(types.includes("SENTENCE_CONSENT"), "[14b] worker consent is asked even with a local exclusion");
  ok(!types.includes("SENTENCE_WARMUP") && !types.includes("SENTENCE_REWRITE"),
    "[14b] worker refusal prevents warmup and rewriting");
  const status = await page.evaluate(() => window.__prooferSentence.sentenceStatusReport());
  ok(status.status === "off" && status.detail === "not-allowed" && status.apply === false,
    "[14b] worker refusal reports off/not-allowed and no current permission");
  await page.close();
}

// --- [14c] Frame-local exclusion cannot veto worker consent --------------
// Mutant: insert `if (window !== window.top) return;` in handleFocusIn;
// embedded active permission and rewrite-request assertions turn red.
{
  const page = await freshPage(true);
  await page.evaluate((port) => {
    const iframe = document.createElement("iframe");
    iframe.src = `http://127.0.0.1:${port}/`;
    iframe.style.cssText = "width:700px;height:240px";
    document.body.prepend(iframe);
  }, PORT);
  await page.waitForSelector("iframe");
  const frame = await (await page.$("iframe")).contentFrame();
  await frame.waitForSelector("#ta");
  await frame.evaluate(() => { window.__store.disabledSites = [location.origin]; });
  await frame.evaluate(CONTENT);
  await frame.click("#ta");
  await sleep(100);
  const status = await frame.evaluate(() => window.__prooferSentence.sentenceStatusReport());
  ok(status.top === false && status.status === "active" && status.apply === true,
    "[14c] excluded embedded frame attaches with worker permission");
  await page.keyboard.type("The techncian arrived early. Then we shipped", { delay: 25 });
  await sleep(800);
  ok((await requests(frame)).includes("The techncian arrived early."),
    "[14c] excluded embedded frame sends a rewrite request");
  ok(await val(frame) === "The technician arrived early. Then we shipped",
    "[14c] excluded embedded frame receives the correction");
  await page.close();
}

// --- [14d] Initialization stays lazy -------------------------------------
// Storage access is forbidden; the status/invalidation message listener is
// registered once, and consent is requested only after trusted field focus.
{
  const page = await freshPage(true);
  await page.evaluate(() => {
    document.querySelector("#ta").dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  await page.click("body", { offset: { x: 5, y: 5 } });
  await sleep(100);
  const idle = await page.evaluate(() => ({
    reads: window.__storageReads.length,
    consent: window.__sent.filter(m => m.type === "SENTENCE_CONSENT").length,
    storageListeners: (window.__onChanged || []).length,
    messageListeners: window.__messageListeners.length,
  }));
  ok(idle.reads === 0 && idle.consent === 0,
    "[14d] no storage reads or consent before trusted editable focus");
  ok(idle.storageListeners === 0 && idle.messageListeners === 1,
    "[14d] one worker-message listener and no storage listener before focus");
  await page.click("#ta");
  await sleep(100);
  await page.click("#tall");
  await sleep(100);
  await page.click("#ta");
  await sleep(100);
  const focused = await page.evaluate(() => ({
    reads: window.__storageReads, storageListeners: (window.__onChanged || []).length,
    messageListeners: window.__messageListeners.length,
    consent: window.__sent.filter(m => m.type === "SENTENCE_CONSENT").length,
  }));
  ok(focused.storageListeners === 0 && focused.messageListeners === 1,
    "[14d] repeated focus keeps one message listener and no storage listener");
  ok(focused.consent === 1 && focused.reads.length === 0,
    "[14d] focus asks worker consent once without accessing storage");
  await page.close();
}

// --- [15] The durability veto ---------------------------------------------
//
// The backstop under the transport registry, and it fires on the ONE thing no
// sampling check can see: the editor takes the write, holds it through every
// verification sample, and discards it on the user's next keystroke. Provoking
// a reconcile instead was measured not to work -- after a MUTATION write on
// Slate, nudging the selection and polling at nine points out to 1500ms read
// correct at every sample.
//
// Driven directly, because a fixture that reproduced the failure on its own
// would be an editor with a model, which is the thing a fixture cannot be. The
// #rich div plays the editor: a listener rewrites the field to
// (pre-correction text + exactly the user's character), which is the exact
// signature the veto requires and nothing weaker.
//
// The rule must have NO false positives, so two of the three cases here are
// negative: an ordinary keystroke on a durable write, and an edit landing
// INSIDE the corrected span, which is inconclusive by construction.
{
  const BEFORE = "The techncian arrived early.";
  const AFTER = "The technician arrived early.";
  const TAIL = " Then we";

  // `mode`: "durable" lets the keystroke land normally; "revert" plays the
  // stale-model editor; "revert" + caretAt inside the span is the ambiguous one.
  const run = async (mode, caretAt) => {
    const page = await freshPage(true);
    // Focus FIRST and let it settle. handleFocusIn resolves loadSettings
    // asynchronously and then calls sentenceAttach -> teardownSentence, which
    // stops the durability watch -- so arming the watch in the same tick as the
    // focus arms it and then has it torn down 20ms later. In production the
    // watch is armed from applySentence, long after any focus.
    await page.evaluate((a) => {
      const el = document.querySelector("#rich");
      el.setAttribute("data-slate-editor", "true");
      el.textContent = a.AFTER + a.TAIL;
      el.focus();
    }, { AFTER, TAIL });
    await sleep(300);
    await page.evaluate((a) => {
      const el = document.querySelector("#rich");
      const S = window.__prooferSentence;
      S.watchSentenceDurability("sn_dur_1", el, 0, a.AFTER.length, a.AFTER, a.BEFORE);
      if (a.mode === "revert") {
        // Bubble phase, so the veto's capture-phase listener has already read
        // the target range off the untouched field.
        el.addEventListener("beforeinput", (e) => {
          if (!e.isTrusted || e.inputType !== "insertText" || !e.data) return;
          e.preventDefault();
          const pre = a.BEFORE + a.TAIL;
          const at = a.caretAt >= a.AFTER.length
            ? a.caretAt - (a.AFTER.length - a.BEFORE.length) : a.caretAt;
          el.textContent = pre.slice(0, at) + e.data + pre.slice(at);
        });
      }
      const r = document.createRange();
      const t = el.firstChild;
      r.setStart(t, a.caretAt); r.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }, { AFTER, BEFORE, TAIL, mode, caretAt });
    await sleep(80);
    await page.keyboard.type("X");
    await sleep(400);
    const out = await page.evaluate(() => ({
      verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
      adapter: window.__prooferSentence.editorAdapterFor(document.querySelector("#rich")),
      status: window.__prooferSentence.sentenceFieldStatus(document.querySelector("#rich")),
      text: document.querySelector("#rich").textContent,
    }));
    await page.close();
    return out;
  };

  console.log("\n[15] The durability veto");

  const durable = await run("durable", (AFTER + TAIL).length);
  ok(!durable.verdicts.includes("sentence-not-durable"),
     `a write the editor keeps is not vetoed (${JSON.stringify(durable.verdicts)})`);
  ok(durable.adapter && durable.adapter.family === "Slate",
     "and the transport is not demoted");

  const reverted = await run("revert", (AFTER + TAIL).length);
  ok(reverted.verdicts.includes("sentence-not-durable"),
     `a write discarded on the next keystroke is vetoed (${JSON.stringify(reverted.verdicts)})`);
  // Demoting the FAMILY, not just the element: sentenceBlockedEls is a WeakSet,
  // so React replacing the composer silently clears an element-keyed veto and
  // the editor would be rediscovered once per remount.
  ok(reverted.adapter === null, "and the whole family is demoted, not just the element");
  ok(reverted.status.status === "session-blocked" && reverted.status.detail === "not-durable",
     `and the popup can say why: ${JSON.stringify(reverted.status)}`);
  // NO automatic rollback: a blind execCommand("undo") may undo the user's own
  // work if the editor grouped our write with their typing, or never made a
  // history entry for it. The field is left exactly as the editor left it.
  ok(reverted.text === BEFORE + TAIL.slice(0, 8) + "X" || reverted.text.includes("X"),
     `and nothing was rolled back: ${JSON.stringify(reverted.text)}`);

  // Inside the corrected span the user's own edit and a revert are
  // indistinguishable, so the answer is "inconclusive", not "veto".
  const inside = await run("revert", 10);
  ok(!inside.verdicts.includes("sentence-not-durable"),
     `an edit inside the corrected span is inconclusive, not a veto `
     + `(${JSON.stringify(inside.verdicts)})`);
  ok(inside.adapter && inside.adapter.family === "Slate",
     "and it does not demote the transport on an ambiguous sample");
}

// --- [16] The watermark is correct before the scan chains --------------------
//
// `fireSentenceRequest` advances the watermark to the CAPTURED end, delivers,
// and then chains straight into `maybeFireSentence` for a sentence the user
// finished during the round trip. The apply is what installs the corrected
// watermark -- and it does so AFTER the splice. So if the apply suspends
// between the write and that install, the chained scan runs against text the
// correction has already shortened while still holding the pre-correction
// offset, and targets a FRAGMENT.
//
// That is the documented CRITICAL pattern -- "advancing an offset from a
// captured value after an async round trip" -- reached from the other side.
// Invisible until a correction SHORTENS the sentence: a growth moves the
// watermark into the corrected span, which segments harmlessly.
{
  const page = await freshPage(true);
  console.log("\n[16] No fragment is targeted while an apply is in flight");
  // Long enough that the user finishes the SECOND sentence, plus the three
  // characters the trigger needs, before the first response lands.
  await page.evaluate(() => { window.__delayMs = 1400; });
  await page.click("#ta");
  await sleep(100);
  await page.keyboard.type("The the report was late. We recieved the invoice yesterday. Then",
                           { delay: 22 });
  await sleep(3000);

  const asked = await requests(page);
  const expected = ["The the report was late.", "We recieved the invoice yesterday."];
  const stray = asked.filter((x) => !expected.includes(x));
  ok(stray.length === 0, `every request is a whole sentence: ${JSON.stringify(asked)}`);
  ok(await val(page) === "The report was late. We received the invoice yesterday. Then",
     `and both corrections landed cleanly: ${JSON.stringify(await val(page))}`);
  await page.close();
}

// --- [17] A real silent apply ARMS the durability watch ---------------------
//
// [15] drives `watchSentenceDurability` directly, which proves the watcher and
// nothing about whether anything calls it: deleting the arming line in
// `applySentence` leaves [15] entirely green. This runs the whole pipeline
// instead — and it can, because `#pm` is a plain contenteditable wearing the
// ProseMirror fingerprint, so it takes the MUTATION recipe and `execCommand`
// really writes to it. No editor model to disagree, which is exactly why this
// says nothing about ProseMirror itself; that is sentence-editors-test.mjs.
{
  const page = await freshPage(true);
  console.log("\n[17] The apply path arms the veto");
  await page.click("#pm");
  await sleep(120);
  // Stop at the trigger point. Typing on is what PROVES the write durable, and
  // that correctly disarms the watch -- so checking after a whole burst
  // measures the teardown and reports it as a missing arm.
  //
  // On a contenteditable the trigger point is the TERMINATOR, not three
  // characters past it: a rich editor's own trailing block boundary is not
  // evidence the user typed anything after the sentence, so its last sentence is
  // scanned as soon as it is complete and held to the no-lookahead standard.
  // This case used to type " Th" as well, which is now a keystroke AFTER the
  // apply -- and a keystroke that keeps the correction is exactly what disarms
  // the watch, so it read as a missing arm.
  await page.keyboard.type("The techncian arrived early.", { delay: 22 });
  await sleep(700);
  const out = await page.evaluate(() => ({
    text: document.querySelector("#pm").textContent,
    armed: window.__prooferSentence.sentenceDurabilityArmed(),
  }));
  ok(out.text === "The technician arrived early.",
     `the correction landed through the MUTATION recipe: ${JSON.stringify(out.text)}`);
  ok(out.armed === true, "and the apply armed the durability watch");

  // The other half of the lifecycle. One real keystroke that keeps the
  // correction IS the proof of durability, and there is nothing further to
  // watch for -- a watch that stayed armed would re-read the whole field on
  // every keystroke for thirty seconds.
  await page.keyboard.type(" Then", { delay: 40 });
  await sleep(400);
  ok(await page.evaluate(() => window.__prooferSentence.sentenceDurabilityArmed()) === false,
     "and a keystroke that keeps the correction disarms it again");
  ok(await page.evaluate(() => document.querySelector("#pm").textContent)
       === "The technician arrived early. Then",
     "with the correction and the keystrokes both intact");
  await page.close();
}

// --- [18] Escape never truncates against maxlength --------------------------
//
// The apply checks the cap before writing, because execCommand does not fail on
// maxlength — it returns true and silently TRUNCATES, deleting a character of
// the user's own text. Undo had no such check for its whole life, and it is the
// direction that needs one MORE: it restores the ORIGINAL, which after a
// correction that shortened the sentence is longer than what is in the field
// now. The anchor check cannot see it, because it only looks at the corrected
// span.
{
  const page = await freshPage(true);
  console.log("\n[18] Escape refuses rather than truncating a capped field");
  await page.click("#capped");
  await sleep(120);
  // 24 chars, corrected to 20 -- four bytes of headroom bought by the fix.
  await page.keyboard.type("The the report was late. ", { delay: 22 });
  await sleep(1200);
  const corrected = await val(page, "#capped");
  ok(corrected.startsWith("The report was late."),
     `the correction landed inside the cap: ${JSON.stringify(corrected)}`);
  // Fill the headroom back up, so restoring the original would overflow.
  await page.keyboard.type("Then we ship", { delay: 22 });
  await sleep(200);
  const before = await val(page, "#capped");
  await page.keyboard.press("Escape");
  await sleep(300);
  const after = await val(page, "#capped");
  ok(after === before,
     `Escape left the field untouched rather than truncating it: ${JSON.stringify(after)}`);
  ok(await page.evaluate(() =>
       !window.__sent.some((m) => m.verdict === "sentence-undone")),
     "and nothing was recorded as undone");
  await page.close();
}

// --- [19] Backspacing after a correction is not "the page threw it away" ----
//
// The async verifier runs at 150 and 600 ms, and used to require the tail to
// have GROWN — which covers typing forwards and nothing else. Backspacing a
// character you had already typed, taking an autocomplete, or letting
// autocorrect swap a word all SHRINK or rewrite the tail, and every one of them
// was read as the page reconciling our write: the correction logged as thrown
// away, and the field blocked for the rest of the session, over an ordinary
// edit with nothing to do with the correction.
//
// What is still enforced is the part that is attributable: the corrected span
// and everything before it. Typing after the caret cannot move either.
{
  const page = await freshPage(true);
  console.log("\n[19] An ordinary edit after a correction is not a reconcile");
  // The response is held so the user finishes the tail before the write lands.
  // That is what makes the captured tail LONG -- fire at the 3-character
  // trigger and it is " Th", which almost any later edit still starts with, so
  // the growth-only rule looks fine for the wrong reason.
  await page.evaluate(() => { window.__delayMs = 900; });
  await page.click("#ta");
  await sleep(120);
  await page.keyboard.type("The techncian arrived early. Then we shipped it out", { delay: 22 });
  await sleep(500);
  // Inside the 600ms verification window, and in the direction the old rule
  // could not express at all: shrink the tail.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await sleep(900);

  ok(await val(page) === "The technician arrived early. Then we shipped it o",
     `the correction and the user's edit coexist: ${JSON.stringify(await val(page))}`);
  const out = await page.evaluate(() => ({
    verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
    eligible: window.__prooferSentence.sentenceEligibleEl(document.querySelector("#ta")),
  }));
  ok(!out.verdicts.includes("sentence-reconciled"),
     `and it is not logged as reconciled: ${JSON.stringify(out.verdicts)}`);
  ok(out.eligible === true, "and the field is still enabled for the rest of the session");
  await page.close();
}

// --- [19b] A page rewriting the field IS still caught ------------------------
//
// The other side of [19]: relaxing the tail must not relax the prefix or the
// corrected span. A controlled component that rewrites the whole value is what
// the async verifier exists for, and it still has to be caught after the user
// has typed — which is when a real one would fire.
{
  const page = await freshPage(true);
  console.log("\n[19b] ...but a page rewriting the field still is");
  await page.click("#ta");
  await sleep(120);
  await page.keyboard.type("The techncian arrived early. Then we", { delay: 22 });
  await sleep(120);
  // A trusted keystroke first, so `userEdited` is set and the tail is ignored —
  // then the page rewrites text BEFORE the correction, which never is.
  await page.keyboard.type("x");
  await page.evaluate(() => {
    const ta = document.querySelector("#ta");
    ta.value = "PREFIX " + ta.value;
  });
  await sleep(900);
  const out = await page.evaluate(() => ({
    verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
    eligible: window.__prooferSentence.sentenceEligibleEl(document.querySelector("#ta")),
  }));
  ok(out.verdicts.includes("sentence-reconciled"),
     `a rewrite before the correction is still caught: ${JSON.stringify(out.verdicts)}`);
  ok(out.eligible === false, "and the field is blocked");
  await page.close();
}

// [19c] The three-way write disposition, which the apply and undo paths share.
//
// `doSentenceUndo` asked only "did it land", where the apply path first asks
// whether the window is attributable at all -- so a key typed while the undo
// was writing was yielded or replayed, moved the tail, failed the strict
// compare, and blocked the field as `undo:reconciled`, an exit that reported no
// verdict at all. One helper answers for both now.
//
// LIMIT, NAMED: this pins the PREDICATE. The undo call site passing
// `wrote.window` rather than null is not gated by a red-able browser case --
// the Slate write window is only a few milliseconds wide when the write
// verifies on its first tick, so a single-shot keystroke cannot be aimed into
// it. sentence-slate-test.mjs [16] covers the caller's happy path end to end.
{
  const page = await freshPage(true);
  console.log("\n[19c] the shared write disposition:");
  await page.click("#ta");
  await sleep(120);
  await page.keyboard.type("Hi team. The report is ready.");
  await sleep(200);
  const d = await page.evaluate(() => {
    const el = document.querySelector("#ta");
    const S = window.__prooferSentence;
    const live = el.value;
    const start = live.indexOf("The report is ready.");
    const end = start + "The report is ready.".length;
    const call = (expected, win) =>
      S.sentenceWriteDisposition(el, expected, start, end, "The report is ready.", win);
    return {
      quietLanded: call(live, null),
      quietFailed: call(live + " EXTRA", null),
      noisyLanded: call(live, { userEdited: true }),
      noisyFailed: call(live + " EXTRA", { userEdited: true }),
      quietWindowFailed: call(live + " EXTRA", { userEdited: false }),
    };
  });
  ok(d.quietLanded === "verified", `a quiet window that landed is verified: ${d.quietLanded}`);
  ok(d.quietFailed === "reconciled", `a quiet window that did not is reconciled: ${d.quietFailed}`);
  // Order matters: `landed` is computed first, so a noisy window does not
  // downgrade a write that verifiably landed.
  ok(d.noisyLanded === "verified", `a noisy window that landed is still verified: ${d.noisyLanded}`);
  ok(d.noisyFailed === "unverified", `a noisy window that did not is unverified: ${d.noisyFailed}`);
  ok(d.quietWindowFailed === "reconciled",
     `a window object with no user edit does not waive: ${d.quietWindowFailed}`);
  await page.close();
}

// [20] Coverage accounting. Deny-by-default per family is the main product
// risk and NOTHING counted it -- `unsupported-editor` was a status the popup
// rendered on demand with no tally anywhere. The tally rides the skip batch, so
// it is flushed here rather than waited for (30s timer).
{
  console.log("\n[20] every editable focused is tallied, once, by outcome:");
  const page = await freshPage(true);
  // Consent is answered asynchronously and `sentenceAttach` returns at the
  // `sentenceAllowed` gate BEFORE the tally, so a focus while that answer is
  // in flight is not counted -- correct behaviour (nothing runs before
  // activation), and the reason for the settle below rather than a bare loop.
  await page.click("#ta");
  await sleep(350);
  await page.evaluate(() => { window.__sent.length = 0; });
  // ALTERNATE. `sentenceAttach` returns early when refocusing the element it
  // already tracks, so a run of clicks on one field never reaches the counter
  // and the WeakSet is not what stops the double count -- a first version of
  // this case did exactly that and the "count every focus" mutant survived it.
  // Alternating forces every click past the track check, leaving the WeakSet
  // as the only thing standing between one tally and four.
  for (const sel of ["#ce", "#ta", "#ce", "#ta"]) {
    await page.click(sel);
    await sleep(150);
  }
  await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  await sleep(80);
  const counts = await page.evaluate(() => {
    const m = window.__sent.filter((x) => x.type === "SENTENCE_SKIPS").pop();
    return (m && m.counts) || {};
  });
  const fields = Object.fromEntries(
    Object.entries(counts).filter(([k]) => k.startsWith("field:")));
  // The textarea was tallied on the warm-up focus, before the buffer was
  // cleared, so refocusing it must add NOTHING -- the once-per-field property,
  // without which focus churn inflates whichever side the user fights with.
  ok(fields["field:ok:textarea"] === undefined,
     `a field tallied on an earlier focus is never counted again: ${JSON.stringify(fields)}`);
  ok(fields["field:unsupported-editor:unknown-editor"] === 1,
     `and a field focused twice is tallied ONCE: ${JSON.stringify(fields)}`);
  // The SERVED side needs its own page, because the warm-up focus above is
  // consumed before the buffer is cleared. Both sides must be counted or the
  // ratio has no denominator, and a suite that only ever saw refusals would
  // keep "delete the ok branch" green.
  await page.close();
  const page2 = await freshPage(true);
  await page2.click("#ta");
  await sleep(350);
  await page2.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  await sleep(80);
  const served = await page2.evaluate(() => {
    const m = window.__sent.filter((x) => x.type === "SENTENCE_SKIPS").pop();
    return (m && m.counts) || {};
  });
  ok(served["field:ok:textarea"] === 1,
     `a servable field is tallied on the OK side: ${JSON.stringify(served)}`);
  await page2.close();
  ok(Object.keys(fields).every((k) => k.length <= 48),
     "every coverage key fits the worker's 48-char bound");
  ok(!JSON.stringify(fields).includes("http"),
     "and no key carries an origin");
}

// --- [21] A caret INSIDE the target defers the request rather than paying for it
//
// Recorded 2026-09-11: eight requests in eleven seconds for one sentence the
// user was rewriting in place -- caret before its existing terminator, text
// after it. Every one was refused at delivery as `anchor:caret-inside`, each
// cost a model call, and the refusal was not even free: the post-response
// step advances the watermark to `job.end` whenever the prefix still matches,
// so a caret that merely MOVED into a finished sentence retired it. The three
// caret questions are now asked before `fireSentenceRequest`, through the same
// helper the delivery anchor uses, and a deferral returns without moving the
// watermark.
//
// The arrangement matters and is the reason for the held reply. The typing
// trigger fires three characters into the NEXT sentence -- before a caret has
// any chance to move back -- so a scan cannot meet "a legitimate, unretired
// target with the caret inside it" from plain typing. Holding the reply for a
// first, clean sentence keeps `sentenceJob` set (every scan skips `busy`, no
// watermark movement) while the user finishes the second sentence, types past
// its trigger point and moves the caret back inside; the CHAINED scan off the
// released reply then meets exactly that target. The keystroke scans (in-place
// edits) and the idle scan (a pause) are exercised after it.
//
// RESUMPTION is asserted, not assumed: the caret leaves with End -- no `input`
// event, no keystroke scan -- and exactly one request must follow. "Pausing an
// input-driven scan without arranging to restart it" is a named bug pattern.
//
// Two elements: the textarea, and the Discord-shaped Slate DOM (an injected
// non-writing reply, so the absent editor model is not asked to take a write --
// what is measured here is the request, and the write is [11]'s question).
for (const [sel, apply] of [["#ta", true], ["#slate", false]]) {
  const page = await freshPage(apply);
  console.log(`\n[21] ${sel}: a caret inside the target defers the request`);
  const skipsSince = async () => {
    await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
    await sleep(60);
    return page.evaluate(() => {
      const all = {};
      for (const m of window.__sent.filter((x) => x.type === "SENTENCE_SKIPS")) {
        for (const [k, v] of Object.entries(m.counts)) all[k] = (all[k] || 0) + v;
      }
      return all;
    });
  };
  const sent = () => requests(page).then((r) => r.filter((s) => s.includes("recieved")));
  await page.click(sel);
  await sleep(120);
  // Hold the FIRST reply; the sentence is clean so nothing is written. It goes
  // out on the idle path (the typing trigger counts three NON-SPACE characters
  // after the terminator, so it cannot fire before sentence two has begun).
  await page.evaluate(() => { window.__delayMs = 2500; });
  await page.keyboard.type("Hello team.", { delay: 20 });
  await sleep(800);
  ok((await requests(page)).includes("Hello team."), `${sel}: the first sentence is out and held`);
  await page.evaluate(() => { window.__delayMs = 20; });
  await page.keyboard.type(" We recieved the invoice yesterday. Then", { delay: 20 });
  // Back INSIDE sentence two, before its terminator, with no text edit.
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  await sleep(2000);            // the held reply lands; the chained scan runs
  ok((await sent()).length === 0,
     `${sel}: the chained scan did not send a sentence the caret sits inside`);
  // In-place edits: each keystroke scan meets the same target, and the edits
  // net to nothing so the sentence the model eventually sees is the table's.
  for (const k of ["x", "Backspace", "y", "Backspace"]) {
    if (k.length === 1) await page.keyboard.type(k); else await page.keyboard.press(k);
    await sleep(40);
  }
  await sleep(900);             // and the IDLE scan, which the fix must cover too
  const before = await skipsSince();
  ok((await sent()).length === 0,
     `${sel}: zero requests across four in-place edits and an idle pause`);
  ok((before["pre-send:caret-inside"] || 0) >= 5,
     `${sel}: every deferral is named: ${JSON.stringify(before)}`);
  ok(!Object.keys(before).some((k) => k.startsWith("anchor:")),
     `${sel}: and none reached the delivery anchor: ${JSON.stringify(before)}`);
  // OUT, with no text edit. End fires selectionchange and nothing else.
  await page.keyboard.press("End");
  await sleep(1000);
  const after = await sent();
  ok(after.length === 1 && after[0] === "We recieved the invoice yesterday.",
     `${sel}: exactly one request once the caret leaves, and the watermark had not moved past it: ${JSON.stringify(after)}`);
  if (sel === "#ta") {
    await sleep(300);
    ok(await val(page) === "Hello team. We received the invoice yesterday. Then",
       `${sel}: and the correction lands where it was deferred: ${JSON.stringify(await val(page))}`);
  }
  await page.close();
}

// [21b] A SELECTION defers too, and collapsing it resumes.
{
  const page = await freshPage(true);
  console.log("\n[21b] a selection over the field defers, collapsing it resumes");
  await page.click("#ta");
  await sleep(120);
  await page.evaluate(() => { window.__delayMs = 2500; });
  await page.keyboard.type("Hello team.", { delay: 20 });
  await sleep(800);
  await page.evaluate(() => { window.__delayMs = 20; });
  await page.keyboard.type(" We recieved the invoice yesterday. Then", { delay: 20 });
  // Select the tail: start !== end, and the anchor's order puts that question
  // before "inside", so it is the reason that must be reported.
  await page.keyboard.down("Shift");
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await sleep(2000);
  await sleep(800);             // idle scan too
  await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  await sleep(60);
  const skips = await page.evaluate(() => {
    const all = {};
    for (const m of window.__sent.filter((x) => x.type === "SENTENCE_SKIPS")) {
      for (const [k, v] of Object.entries(m.counts)) all[k] = (all[k] || 0) + v;
    }
    return all;
  });
  ok((await requests(page)).filter((s) => s.includes("recieved")).length === 0,
     "nothing is sent over an active selection");
  ok((skips["pre-send:selection-active"] || 0) >= 1 && !skips["pre-send:caret-inside"],
     `named as the selection, not as the caret: ${JSON.stringify(skips)}`);
  await page.keyboard.press("End");   // collapses the selection at the end
  await sleep(1000);
  const after = (await requests(page)).filter((s) => s.includes("recieved"));
  ok(after.length === 1, `one request once the selection collapses: ${JSON.stringify(after)}`);
  await page.close();
}

// [21c] The contenteditable last-sentence trigger fires with the caret AT `end`.
//
// The whole chat-client path: the keystroke that finishes the sentence is the
// trigger, and the caret is exactly at the terminator's far side. Strict `<`
// keeps it; `<=` would turn every Discord message's final sentence into a
// deferral that resumes only when the caret moves -- which, in a chat client,
// is never, because the next key is Enter.
{
  const page = await freshPage(true);
  console.log("\n[21c] the CE trigger at the terminator is not a deferral");
  await page.click("#slate");
  await sleep(100);
  await page.keyboard.type("We recieved the invoice yesterday.", { delay: 20 });
  await sleep(400);
  ok((await requests(page)).includes("We recieved the invoice yesterday."),
     "the sentence went out on the keystroke that finished it");
  await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  await sleep(60);
  const skips = await page.evaluate(() => {
    const m = window.__sent.filter((x) => x.type === "SENTENCE_SKIPS").pop();
    return (m && m.counts) || {};
  });
  ok(!Object.keys(skips).some((k) => k.startsWith("pre-send:")),
     `and nothing was deferred on the way: ${JSON.stringify(skips)}`);
  await page.close();
}

// --- [22] "Is this composer empty" is scaffold-aware -------------------------
//
// `snText` of an empty Slate composer is not "": the zero-width U+FEFF in
// `data-slate-zero-width` and the `contenteditable="false"` placeholder both
// land in it. `snIsEmptyComposer` is the predicate the verifier TRACE reads.
// It ignores non-editable descendants and zero-width/whitespace characters,
// and nothing else -- one real character is content.
{
  const page = await freshPage(true);
  console.log("\n[22] the empty-composer predicate on a Discord-shaped Slate DOM");
  const r = await page.evaluate(() => {
    const S = window.__prooferSentence;
    const el = document.querySelector("#slate");
    const str = el.querySelector("[data-slate-string]");
    str.textContent = "\uFEFF";
    const ph = document.createElement("span");
    ph.setAttribute("contenteditable", "false");
    ph.setAttribute("data-slate-placeholder", "true");
    ph.textContent = "Message #general";
    el.firstElementChild.appendChild(ph);
    const out = { textLen: S.snText(el).length, emptyWithScaffold: S.snIsEmptyComposer(el) };
    str.textContent = "\uFEFFx";
    out.oneChar = S.snIsEmptyComposer(el);
    str.textContent = " \n\u200B";
    out.whitespaceOnly = S.snIsEmptyComposer(el);
    // Non-editable CONTENT is not scaffold: a mention chip carries text the
    // user chose and an emoji image carries none, and both are a message.
    const chip = document.createElement("span");
    chip.setAttribute("contenteditable", "false");
    chip.textContent = "@someone";
    el.firstElementChild.appendChild(chip);
    out.chipOnly = S.snIsEmptyComposer(el);
    chip.remove();
    const img = document.createElement("img");
    img.setAttribute("alt", ":smile:");
    el.firstElementChild.appendChild(img);
    out.imageOnly = S.snIsEmptyComposer(el);
    img.remove();
    out.backToEmpty = S.snIsEmptyComposer(el);
    const ta = document.querySelector("#ta");
    ta.value = "";  out.taEmpty = S.snIsEmptyComposer(ta);
    ta.value = " "; out.taSpace = S.snIsEmptyComposer(ta);
    ta.value = "a"; out.taChar = S.snIsEmptyComposer(ta);
    return out;
  });
  ok(r.textLen > 0 && r.emptyWithScaffold === true,
     `zero-width plus a placeholder reads as empty (snText saw ${r.textLen} chars)`);
  ok(r.oneChar === false, "one real character is content");
  ok(r.whitespaceOnly === true, "whitespace and zero-width alone are not content");
  ok(r.chipOnly === false, "a mention chip alone is content, not scaffold");
  ok(r.imageOnly === false, "an emoji image alone is content");
  ok(r.backToEmpty === true, "and removing it reads empty again");
  ok(r.taEmpty === true && r.taSpace === true && r.taChar === false,
     `a textarea answers the same way: ${JSON.stringify(r)}`);
  await page.close();
}


// [22b] The verifier trace, with the flag ON: text-free, root-scoped, one end.
//
// [22] pins the predicate; nothing above pins that `snVerifierTrace` exists,
// that it logs no text, that it ignores keys pressed elsewhere, or that each
// request gets exactly one terminal line -- deleting the trace outright left
// the suite green (review, 2026-09-15). This turns `sentenceDebug` on through
// the storage stub, captures the console, and asserts on the packets against
// KNOWN state rather than the trace's own booleans. It also requires the
// production outcome to be the same one the flag-off cases record.
{
  const page = await freshPage(true);
  console.log("\n[22b] the verifier trace is text-free, root-scoped and ends once");
  const lines = [];
  page.on("console", (m) => { const t = m.text(); if (t.includes('"kind"')) lines.push(t); });
  await page.evaluate(() => { window.__store.sentenceDebug = true; });
  await page.click("#ta");
  await sleep(200);
  // Two corrections close together: the second apply supersedes the first
  // verifier inside its window, which is the lifecycle that ended twice.
  await page.keyboard.type("The techncian arrived early. We recieved the invoice yesterday. Then", { delay: 12 });
  await sleep(300);
  await page.keyboard.press("ArrowLeft");        // a named key, on the root
  await page.keyboard.type("q");                 // a character, on the root
  await page.click("#tall");                     // focus elsewhere...
  await page.keyboard.press("Enter");            // ...a named key OFF the root
  await sleep(1000);
  const packets = lines.map((l) => JSON.parse(l.slice(l.indexOf("{"))));
  const ids = [...new Set(packets.map((p) => p.id))];
  ok(ids.length === 2, `both applies armed a trace: ${JSON.stringify(ids)}`);
  for (const id of ids) {
    const mine = packets.filter((p) => p.id === id);
    ok(mine.filter((p) => p.kind === "apply").length === 1
       && mine.filter((p) => p.kind === "end").length === 1
       && mine[mine.length - 1].kind === "end",
       `${id}: one apply, one end, and the end is last: ${mine.map((p) => p.kind + (p.reason ? ":" + p.reason : "")).join(" ")}`);
  }
  const keys = packets.filter((p) => p.kind === "keydown");
  ok(keys.every((p) => p.key === "char" || /^[A-Z][a-zA-Z]+$/.test(p.key)),
     `keys are named or "char", never a character: ${JSON.stringify(keys.map((p) => p.key))}`);
  ok(!keys.some((p) => p.key === "Enter"),
     `the Enter pressed on another element was not recorded: ${JSON.stringify(keys.map((p) => p.key))}`);
  const blob = lines.join("\n");
  ok(!/techn|recieved|received|invoice|arrived/.test(blob),
     "no packet carries a word the user typed");
  const verdicts = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict));
  ok(verdicts.length === 2 && verdicts.every((v) => v === "sentence-applied"),
     `production outcomes are unchanged with the flag on: ${JSON.stringify(verdicts)}`);
  ok(await val(page) === "The technician arrived early. We received the invoice yesterday. Theqn",
     `and both corrections are in the field: ${JSON.stringify(await val(page))}`);
  await page.close();
}

// [21d] No caret at all defers, and a caret arriving resumes -- at the caller.
//
// A contenteditable can be focused with no selection range in it (a page can
// remove the ranges; a caret probe returns {null, null}). The anchor suite
// pins the predicate's answer; this pins that the SCAN asks it and that a
// selection appearing afterwards -- a selectionchange, no input -- resumes.
{
  const page = await freshPage(true);
  console.log("\n[21d] #slate: no selection range defers as no-caret; a range arriving resumes");
  await page.click("#slate");
  await sleep(120);
  await page.evaluate(() => { window.__delayMs = 2500; });
  await page.keyboard.type("Hello team.", { delay: 20 });
  await sleep(800);
  await page.evaluate(() => { window.__delayMs = 20; });
  await page.keyboard.type(" We recieved the invoice yesterday. Then", { delay: 20 });
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await sleep(2000);
  await sleep(800);
  ok((await requests(page)).filter((s) => s.includes("recieved")).length === 0,
     "nothing is sent while the field has no caret");
  await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  await sleep(60);
  const skips = await page.evaluate(() => {
    const all = {};
    for (const m of window.__sent.filter((x) => x.type === "SENTENCE_SKIPS")) {
      for (const [k, v] of Object.entries(m.counts)) all[k] = (all[k] || 0) + v;
    }
    return all;
  });
  ok((skips["pre-send:no-caret"] || 0) >= 1, `named as no-caret: ${JSON.stringify(skips)}`);
  // A caret appears at the end of the text, by selection alone.
  await page.evaluate(() => {
    const el = document.querySelector("#slate");
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let str = null; while (w.nextNode()) str = w.currentNode;
    const r = document.createRange();
    r.setStart(str, str.nodeValue.length); r.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  });
  await sleep(1000);
  const after = (await requests(page)).filter((s) => s.includes("recieved"));
  ok(after.length === 1, `one request once a caret exists: ${JSON.stringify(after)}`);
  await page.close();
}

// [21e] A silent page mutation while deferred is still refused on resumption.
//
// The resumption schedules the guarded scan and nothing else. A mutant that
// adopted the live field, or cleared the provenance floor, from the
// selectionchange handler would send page text here.
{
  const page = await freshPage(true);
  console.log("\n[21e] #ta: a page mutation during the deferral is refused when the caret leaves");
  await page.click("#ta");
  await sleep(120);
  await page.evaluate(() => { window.__delayMs = 2500; });
  await page.keyboard.type("Hello team.", { delay: 20 });
  await sleep(800);
  await page.evaluate(() => { window.__delayMs = 20; });
  await page.keyboard.type(" We recieved the invoice yesterday. Then", { delay: 20 });
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  await sleep(2000);
  ok((await requests(page)).filter((s) => s.includes("recieved")).length === 0, "deferred");
  // The page rewrites the field with no event, then the caret leaves.
  await page.evaluate(() => { const ta = document.querySelector("#ta"); ta.value = "PREFIX " + ta.value; });
  await page.keyboard.press("End");
  await sleep(1000);
  await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  await sleep(60);
  const skips = await page.evaluate(() => {
    const all = {};
    for (const m of window.__sent.filter((x) => x.type === "SENTENCE_SKIPS")) {
      for (const [k, v] of Object.entries(m.counts)) all[k] = (all[k] || 0) + v;
    }
    return all;
  });
  ok((await requests(page)).filter((s) => s.includes("recieved")).length === 0,
     `the resumed scan sent nothing over an unaccounted field: ${JSON.stringify(await requests(page))}`);
  ok((skips["unseen-mutation"] || 0) >= 1, `and named the reason: ${JSON.stringify(skips)}`);
  await page.close();
}

// --- [23] A configuration change drops a correction still on its way -------
// Invalidation clears content-script writes that are waiting.
// The speed check's verdict changing (e.g. marked stale after an Ollama
// update) or the Ollama URL changing arrives as a worker invalidation; content.js
// drops what is in flight and re-asks consent, which the worker now refuses.
// A textarea writes the moment the response lands, so the change is fired
// while the request is out; a rich editor's result held for a pause goes
// through the same teardown.
for (const key of ["setupQualification", "ollamaUrl"]) {
  const page = await freshPage(true);
  await page.evaluate(() => { window.__delayMs = 600; });
  await page.click("#ta");
  await page.keyboard.type("We recieved the invoice yesterday. Then we", { delay: 20 });
  for (let i = 0; i < 40 && !(await requests(page)).includes("We recieved the invoice yesterday."); i++) await sleep(25);
  ok((await requests(page)).includes("We recieved the invoice yesterday."), `[23] ${key}: the sentence went out`);
  await page.evaluate((k) => {
    window.__allowed = false;
    for (const fn of window.__messageListeners) fn({ type: "SENTENCE_SETTINGS_CHANGED" }, { id: chrome.runtime.id }, () => {});
  }, key);
  await sleep(1200);
  ok(await val(page) === "We recieved the invoice yesterday. Then we",
    `[23] ${key} changing while it is out: the correction is dropped (${JSON.stringify(await val(page))})`);
  await page.close();
}

// [23b] ...and a rich editor's correction HELD for a pause when the change
// lands (checkpoint 3: [23] covered only the textarea in flight). The INTENT
// recipe waits for the user to stop typing; a configuration change during
// that wait drops the held correction -- no write is attempted -- and its
// record says why rather than being left with no verdict.
{
  const page = await freshPage(true);
  await page.click("#slate");
  await sleep(100);
  await page.keyboard.type("We recieved the invoice yesterday. The", { delay: 20 });
  let held = false;
  for (const ch of "n we shipped it all out to everyone") {
    await page.keyboard.type(ch);
    await sleep(40);
    held = await page.evaluate(() => window.__prooferSentence.sentenceDeferredHeld());
    if (held) break;
  }
  ok(held, "[23b] the Slate correction is held for a pause");
  await page.evaluate(() => {
    window.__allowed = false;
    for (const fn of window.__messageListeners) fn({ type: "SENTENCE_SETTINGS_CHANGED" }, { id: chrome.runtime.id }, () => {});
  });
  await sleep(900);
  await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  await sleep(60);
  const r = await page.evaluate(() => {
    const skips = window.__sent.filter((m) => m.type === "SENTENCE_SKIPS").reduce((a, m) => Object.assign(a, m.counts), {});
    const req = window.__sent.find((m) => m.type === "SENTENCE_REWRITE" && m.sentence === "We recieved the invoice yesterday.");
    const verdicts = window.__sent.filter((m) => m.type === "REWRITE_OUTCOME" && req && m.requestId === req.requestId).map((m) => m.verdict);
    return { text: document.querySelector("#slate").textContent, skips, verdicts,
      held: window.__prooferSentence.sentenceDeferredHeld() };
  });
  ok(!r.held && r.text.startsWith("We recieved the invoice yesterday.")
    && !Object.keys(r.skips).some((k) => k.startsWith("splice-failed")),
    `[23b] a configuration change while it is held: dropped, no write attempted (${JSON.stringify(r.skips)})`);
  ok(r.verdicts.includes("sentence-skipped:consent-changed"),
    `[23b] ...and its record says why (${JSON.stringify(r.verdicts)})`);
  await page.close();
}

// --- [24] Request identity survives equal clocks, routing and reload -------
// Mutant: in fireSentenceRequest, replace id: nextSentenceRequestId() with
// id: "sn_" + (++rewriteRequestId) + "_" + Date.now(). The distinct-instance,
// 128-bit namespace and fresh-after-reload assertions below turn red.
{
  console.log("\n[24] request namespaces belong to content instances, not clocks");
  const first = await freshPage(true, 1800000000000);
  const second = await freshPage(true, 1800000000000);
  await first.evaluate(() => { window.__delayMs = 2000; });
  for (const page of [first, second]) {
    await page.bringToFront();
    await page.click("#ta");
    await page.keyboard.type("The techncian arrived early. Then", { delay: 20 });
    await page.waitForFunction(() => window.__sent.some((m) => m.type === "SENTENCE_REWRITE"));
  }
  const sentId = (page) => page.evaluate(() =>
    window.__sent.find((m) => m.type === "SENTENCE_REWRITE").requestId);
  const firstId = await sentId(first), secondId = await sentId(second);
  ok(await first.evaluate(() => Date.now()) === 1800000000000
    && await second.evaluate(() => Date.now()) === 1800000000000,
    "[24] both content instances have the same frozen wall clock");
  ok(firstId !== secondId, "[24] first requests from distinct instances have distinct IDs");
  ok(/^sn_[0-9a-f]{32}_1$/.test(firstId) && /^sn_[0-9a-f]{32}_1$/.test(secondId),
    "[24] first IDs carry a 128-bit namespace and counter 1");
  await first.evaluate(() => {
    window.__allowed = false;
    for (const fn of window.__messageListeners) fn({ type: "SENTENCE_SETTINGS_CHANGED" }, { id: chrome.runtime.id }, () => {});
  });
  const cancellations = await first.evaluate(() =>
    window.__sent.filter((m) => m.type === "CANCEL_REWRITE").map((m) => m.requestId));
  ok(cancellations.length === 1 && cancellations[0] === firstId,
    "[24] cancellation carries the original opaque request ID");
  await second.waitForFunction(() => window.__sent.some((m) => m.verdict === "sentence-applied"));
  await second.bringToFront();
  await second.keyboard.press("Escape");
  const outcomes = await second.evaluate(() =>
    window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => ({ id: m.requestId, verdict: m.verdict })));
  ok(outcomes.length === 2 && outcomes[0].verdict === "sentence-applied"
    && outcomes[1].verdict === "sentence-undone" && outcomes.every((m) => m.id === secondId),
    "[24] apply and undo outcomes carry the original opaque request ID");
  await first.reload();
  await first.addStyleTag({ content: STYLES });
  await first.evaluate(CONTENT);
  await sleep(150);
  await first.bringToFront();
  await first.click("#ta");
  await first.keyboard.type("The techncian arrived early. Then", { delay: 20 });
  await first.waitForFunction(() => window.__sent.some((m) => m.type === "SENTENCE_REWRITE"));
  const reloadedId = await sentId(first);
  ok(await first.evaluate(() => Date.now()) === 1800000000000,
    "[24] reload preserves the frozen wall clock");
  ok(/^sn_[0-9a-f]{32}_1$/.test(reloadedId) && reloadedId.split("_")[1] !== firstId.split("_")[1]
    && reloadedId.split("_")[1] !== secondId.split("_")[1],
    "[24] reload starts counter 1 in a fresh namespace");
  await first.close();
  await second.close();
}

// [25] Mutant: the engine's truncated error response -> refused: "truncated";
// the engine-error and worker:truncated/no-guard counter assertions turn red.
{
  console.log("\n[25] model-shape errors reach content as worker errors and scanning continues");
  const sentence = "The techncian arrived early.";
  const req = prepareSentenceRequest(sentence, "", { hostname: "example.com" });
  const { payload } = await runSentenceEngine({ sentence, priorContext: "", pageContext: {},
    trigger: "next-sentence", req, ollamaUrl: `http://127.0.0.1:${PORT}`,
    ac: new AbortController(), deadlineMs: Date.now() + 4750,
    checkAllowed: async () => true, expectedDigest: PINNED_MODEL.digest });
  ok(engineChats === 1 && payload.ok === false && payload.error === "truncated"
    && !("refused" in payload) && !("network" in payload),
    "[25] the shipping engine produces a non-network truncated error in one request");
  const page = await freshPage(true);
  await page.evaluate((reply) => {
    window.__rewriteReplies = { "The techncian arrived early.": reply };
  }, payload);
  await page.click("#ta");
  await page.keyboard.type("The techncian arrived early. We", { delay: 20 });
  await page.waitForFunction(() => window.__sent.some((m) => m.type === "SENTENCE_REWRITE"));
  await sleep(150);
  await page.evaluate(() => window.__prooferSentence.flushSentenceSkips());
  const skips = await page.evaluate(() => {
    const counts = {};
    for (const m of window.__sent.filter((m) => m.type === "SENTENCE_SKIPS")) {
      for (const [k, n] of Object.entries(m.counts)) counts[k] = (counts[k] || 0) + n;
    }
    return counts;
  });
  ok(skips["worker:truncated"] === 1 && !("guard:truncated" in skips),
    `[25] worker:truncated is counted once without guard:truncated (${JSON.stringify(skips)})`);
  ok(await val(page) === "The techncian arrived early. We", "[25] the errored sentence stays unchanged");
  await page.keyboard.type(" recieved the invoice yesterday. Then", { delay: 20 });
  await page.waitForFunction(() => window.__sent.some((m) => m.verdict === "sentence-applied"));
  ok(await val(page) === "The techncian arrived early. We received the invoice yesterday. Then",
    "[25] the next request succeeds after the non-network error");
  ok(JSON.stringify(await requests(page)) === JSON.stringify([
    "The techncian arrived early.", "We recieved the invoice yesterday."]),
    "[25] the watermark advances past the error without resending it");
  await page.close();
}

await browser.close();
server.close();

console.log("\n" + "=".repeat(72));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
