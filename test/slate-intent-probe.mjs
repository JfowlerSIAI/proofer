#!/usr/bin/env node
/**
 * EXPERIMENT (not a regression suite): can the INTENT recipe drop its wait?
 *
 *   cd test && node slate-intent-probe.mjs                       # everything
 *   node slate-intent-probe.mjs --phase 1                        # spec check only
 *   PROOFER_TRIALS=6 node slate-intent-probe.mjs --phase 3       # 12 trials per cell
 *   PROOFER_ARMS=real node slate-intent-probe.mjs --phase 4      # one arm
 *
 * Every filter is fatal when it matches nothing: an unknown --phase, an unknown
 * arm or variant, a non-numeric PROOFER_TRIALS all exit 2, and an inert phase 1
 * exits 1. A run that measured nothing must not print the same colour as a run
 * that measured everything -- and note the env vars are ENV, not arguments: a
 * trailing `PROOFER_ARMS=shipping` is silently ignored by node, which is how a
 * self-report once quoted a command that would not reproduce its own numbers.
 *
 * THE QUESTION (answered; the recipe below is what ships). spliceSentenceSlate
 * USED TO set the DOM selection, wait SN_CE_SYNC_MS (~30ms) for Slate to read
 * it into `editor.selection`, and only then dispatch a synthetic `beforeinput`.
 * That wait WAS the abort window -- the interval in which a user keystroke
 * collides with the write and has to be swallowed and replayed. Harper
 * (packages/lint-framework, replaceRichTextEditorValue) writes to Slate with NO
 * wait at all: it dispatches `beforeinput{insertReplacementText}` carrying
 * `targetRanges: [new StaticRange(range)]`. Slate honours the event's own
 * target range, so the wait -- and the window -- went to zero.
 *
 * METHOD, copied from the SN_TRANSPORTS measurement recorded in content.js
 * around line 2240, because every rule in it was bought by a wrong answer:
 *
 *   - real Slate over the network, never a fixture. A Slate-shaped div has no
 *     model to disagree with the DOM, so it passes while the write is broken.
 *   - the ONLY assertion that can fail: type more characters afterwards and see
 *     whether the correction survives AT THE RIGHT OFFSET.
 *   - JITTER the inter-keystroke delay (22-129ms). Fixed cadence hides
 *     collision completely: at one spacing 10/10 broken, at the next 0/10.
 *   - split IDLE from BURST. Keystroke deletion is invisible in the idle column.
 *   - and one bought by THIS file's own audit: a phase that has never been run
 *     is not a phase that passed. Phases 2 and 3 collide the write with TYPING
 *     and reported the recipe clean; phase 4 collides it with a SELECTION MOVE
 *     and phase 5 with a Backspace, and both found real corruption. Every arm
 *     here types ordinary letters unless it is deliberately made not to.
 *
 * Exits 77 (not 0, not 1) if slatejs.org is unreachable: a green run that
 * measured nothing is the failure mode this policy exists for.
 *
 * Every number below was taken against the LIVE site. `test/fixtures/slatejs.org`
 * is a capture of the real bundle served over loopback (see
 * sentence-slate-test.mjs) and is a legitimate target to iterate against --
 * it is the actual slate-react, not a Slate-shaped DOM, and the model/DOM
 * divergence still fires offline. It is not wired up here: a recipe measurement
 * is worth re-taking against the editor as it currently ships.
 *
 * WHAT IT MEASURED, 2026-08-13/14, Chrome for Testing 145, real slatejs.org.
 *
 * Phase 1. Chrome hands a SYNTHETIC InputEvent's constructed `targetRanges`
 * back from `getTargetRanges()` during dispatch -- same container, same
 * offsets, `isTrusted: false`. An event constructed without them reads 0, and
 * so does the same event once dispatch is over, so the handler's view is the
 * real one. Harper's StaticRange is not inert.
 *
 * Phase 2, the raw transport, 4 trials per cell, "intact" = the final text is
 * exactly the correction plus everything typed after it:
 *
 *   variant                                            idle   burst
 *   select + 30ms wait + insertText   (was shipping)   4/4    3/4
 *   select + NO wait + insertText, no targetRanges     0/4    0/4
 *   select + NO wait + insertReplacementText + ranges  4/4    3/4
 *   NO select, NO wait, insertReplacementText + ranges 4/4    4/4
 *   NO select, NO wait, insertText + ranges            4/4    4/4
 *   select + 30ms wait + insertReplacementText + ranges 4/4   2/4
 *
 * The second row is the control that makes the rest mean something: without a
 * target range the no-wait write lands at Slate's stale selection, every time.
 * With one, the DOM selection and the wait are both unnecessary -- and the
 * inputType is not what buys it, since insertText + ranges works too.
 *
 * The burst column of this phase was ONCE 0/4 in every cell, and that was the
 * probe's own bug, not the recipe's: it restored the caret to `end + delta`
 * where the shipping splice restores to `caretBefore + delta`, dragging the
 * caret in front of everything typed since the write began. Every burst number
 * here was partly measuring the harness. Corrected 2026-08-14 after audit; the
 * cells that remain below 4/4 are the genuine cost of having no swallow/replay,
 * which is what phase 3 adds.
 *
 * Phase 3, the same recipes carrying the shipping guards, 12 trials per cell:
 *
 *                                        idle              burst
 *   shipping (select + wait), pre-patch   12/12 intact      8/12 intact,
 *                                                           4 refused `aborted`
 *   mirror of the same                    12/12             10/12, 2 refused
 *   targetRanges, no select, no wait      12/12             12/12
 *   ...and no caret restore               12/12             12/12
 *   ...and no swallow/replay either       12/12             12/12
 *   shipping AFTER the patch              12/12             12/12
 *
 * DAMAGED -- a character of the user's own text gone -- is 0 in every cell of
 * every arm. The old recipe's cost was never corruption, it was refusal: a
 * third of mid-burst corrections thrown away to protect a window that did not
 * have to exist.
 *
 * Phase 4, a selection move the editor has not processed yet, 4 trials per
 * cell, sweeping the delay between the move and the write:
 *
 *                          0ms   1ms   2ms   4ms   8ms   16ms
 *   no selection set       0/4   4/4   4/4   4/4   4/4   4/4
 *   selection set, no wait 4/4   4/4   4/4   4/4   4/4   4/4
 *   shipping, after fix    4/4   4/4   4/4   4/4   4/4   4/4   (and 32, 64)
 *
 * At 0ms the recipe that names the range and nothing else left the typo in
 * place and dumped the correction at the caret, silently, reporting `landed`.
 * One task turn later the race is over and it is invisible. This is why the
 * DOM selection is still set: see spliceSentenceSlate.
 *
 * Phase 5, actions inside the ~90ms window behind the write, at +10ms, scored
 * on WHAT THE USER ASKED FOR rather than on the correction. Every one is a real
 * trusted event; the clipboard is loaded with execCommand because the async API
 * is refused headless:
 *
 *                     old guards   after the fix
 *   Backspace         0/4          4/4
 *   char+Backspace    1/4          4/4
 *   ArrowLeft+char    0/4          4/4
 *   char (control)    0/4          4/4
 *   ArrowLeft+Delete  -            4/4
 *   Enter+char        -            4/4
 *   paste             -            4/4
 *   click+char        -            4/4
 *
 * The last one is the caret-clobber finding measured directly: click into the
 * text mid-window, type, and the character must land at the CLICK.
 *
 * Phase 6, the cross-product phases 4 and 5 each test half of -- a selection
 * move AND an action, 4 trials per cell, real keys:
 *
 *                        before        after
 *   Backspace  +2ms      4/4 CORRUPT   no-op
 *   Backspace  +80ms     4/4 CORRUPT   no-op
 *   Backspace  +150ms    correct       correct (the guard has detached)
 *   ArrowLeft  +2/+80    caret wrong   no-op
 *   ArrowLeft  +150ms    correct       correct
 *
 * CORRUPT there is the correction eating its own character:
 * "The technician arrived early Then we shipped". Inside the window in the
 * dirty branch the action is now CANCELLED -- a keypress that did nothing and
 * will be pressed again, against a character of the correction that will not
 * come back. Note what the +150ms row is for: it proves the cancellation is
 * scoped to the guarded window rather than blanket.
 *
 * The control failing is the important one: it says the swallow/replay was
 * mishandling an ordinary character too, not just the actions it obviously
 * could not replay. `replayInto` in content.js has the mechanism -- a single
 * [a-z ] character dispatched as `insertText` takes slate-react's
 * `native = true` fast path, which waits for a browser default action that an
 * untrusted event does not have.
 *
 * Read the phase 5 numbers with that in mind: the character is DEFERRED, not
 * destroyed, and the next input event flushes it. This phase presses its keys
 * and then stops, which is exactly the case that loses -- and exactly the case
 * a user produces when the swallowed keystroke is their last before a pause.
 * A phase that kept typing would score it 4/4 and prove nothing.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { resolveChrome } from "./lib/chrome.mjs";

const EXT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
// PROOFER_CONTENT runs the probe against a DIFFERENT content.js -- the
// executable control this file had been missing. A claim of the form "before
// the fix this corrupted 4/4" is only checkable if the before is still runnable,
// and a prose note that it used to is not evidence. Point it at a copy of the
// pre-fix file, or at a deliberate variant, and every phase measures that
// instead.
const CONTENT_PATH = process.env.PROOFER_CONTENT || path.join(EXT, "content.js");
if (!fs.existsSync(CONTENT_PATH)) {
  console.error(`PROOFER_CONTENT=${CONTENT_PATH} does not exist.`);
  process.exit(2);
}
const CONTENT = fs.readFileSync(CONTENT_PATH, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXIT_SKIPPED = 77;

const argv = process.argv.slice(2);
const phaseArg = argv.includes("--phase") ? argv[argv.indexOf("--phase") + 1] : null;
if (argv.includes("--phase") && phaseArg === undefined) {
  // `--phase` with nothing after it used to run the WHOLE suite, which is the
  // fail-open shape this file keeps finding in itself: the run you asked to
  // narrow is the one that quietly widened.
  console.error("--phase needs a value.");
  process.exit(2);
}
// An unknown phase used to run nothing and exit 0 -- "measured nothing" and
// "measured everything" printing the same colour is the one failure this file's
// exit policy exists to prevent, and a typo in --phase was the cheapest way to
// get it. Every filter here fails loudly for the same reason.
const PHASES = ["1", "2", "3", "4", "5", "6"];
if (phaseArg && !PHASES.includes(String(phaseArg))) {
  console.error(`--phase ${phaseArg} is not a phase. Known: ${PHASES.join(", ")}`);
  process.exit(2);
}
const wantPhase = (n) => !phaseArg || String(n) === String(phaseArg);
const TRIALS = Number(process.env.PROOFER_TRIALS || 4);
if (!Number.isInteger(TRIALS) || TRIALS < 1) {
  console.error(`PROOFER_TRIALS=${process.env.PROOFER_TRIALS} is not a positive integer.`);
  process.exit(2);
}

// 22-129ms, being 22 + [0,107]. The band is the point: a human types unevenly,
// and every fixed cadence is a resonance waiting to hide a bug.
const jitter = () => 22 + Math.floor(Math.random() * 108);

const SLATE_URL = "https://www.slatejs.org/examples/richtext";
const SLATE_SEL = '[data-slate-editor="true"]';

const TYPO  = "The techncian arrived early.";
const FIXED = "The technician arrived early.";
const TAIL  = " We recieved the invoice.";

/**
 * Leave the numbers on disk, per phase.
 *
 * A claim in a header comment that no artifact supports is a claim nobody can
 * check -- phases 5 and 6 had none, so the cells they asserted rested on
 * scrollback. PROOFER_RESULT_JSON still overrides for a single-phase run.
 */
const RESULTS_DIR = path.join(EXT, "test", "results");
const contentHash = () => crypto.createHash("md5").update(CONTENT).digest("hex");
function writeArtifact(name, rows) {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = process.env.PROOFER_RESULT_JSON
      || path.join(RESULTS_DIR, `slate-intent-${name}-${stamp}.json`);
    // THE BYTES, NOT JUST THEIR NAME. Twice today a claim was checkable only
    // because somebody happened to have kept a copy of the source it was
    // measured against; the third time, another agent made that mechanical
    // rather than lucky. A hash proves two files differ -- it cannot tell you
    // WHAT differed, which is the question ("is that changed line executable?")
    // that actually settles whether a number is stale.
    try {
      fs.writeFileSync(file.replace(/\.json$/, "") + ".content.js", CONTENT);
    } catch (e) {
      console.error(`    could not save the measured source: ${e.message}`);
    }
    fs.writeFileSync(file, JSON.stringify({
      phase: name, at: new Date().toISOString(),
      // The BYTES these numbers describe. An artifact that names only a path is
      // undated evidence: the file moves and the JSON still looks current.
      content: CONTENT_PATH, contentMd5: contentHash(), chrome: chrome.path,
      trials: TRIALS, rows,
    }, null, 2));
    console.log(`    -> ${file}`);
  } catch (e) {
    console.error(`    could not write artifact: ${e.message}`);
  }
}

/**
 * Print a cell's notes WITHOUT letting the interesting ones be starved.
 *
 * The sixth instance of the artifact fail-open family, found in another agent's
 * probe and then in this one. Notes are pushed in trial order and printed with a
 * flat `slice(0, N)`, so a cell whose early trials were ordinary refusals prints
 * refusals and never reaches the damaged trial the cell exists to characterise.
 * Theirs combined two phases into one budget and hid every burst detail behind
 * idle ones; mine prints 8 of 16 in phase 3 and 2 of 8 elsewhere, which starves
 * the same way with fewer trials.
 *
 * Severity first, then trial order, and ALWAYS say what was dropped. A truncated
 * list that does not admit it is truncated is the same lie as a green run that
 * measured nothing -- the reader has no way to know there is more.
 */
const noteRank = (n) => (/CORRUPT|misplaced|LOST|threw|pageerror|in the correction/.test(n) ? 0 : 1);
function printNotes(notes, budget, indent) {
  const ordered = notes.map((n, i) => ({ n, i })).sort((a, b) =>
    noteRank(a.n) - noteRank(b.n) || a.i - b.i).map((x) => x.n);
  for (const n of ordered.slice(0, budget)) console.log(`${indent}${n}`);
  const rest = ordered.length - budget;
  if (rest > 0) console.log(`${indent}... and ${rest} more (all of them in the JSON artifact)`);
}

const chrome = await resolveChrome();
console.log("\nThe Slate intent recipe: is the sync wait load-bearing?\n" + "=".repeat(72));
console.log(`  Chrome: ${chrome.path} (${chrome.source})`);
if (process.env.PROOFER_CONTENT) console.log(`  content.js: ${CONTENT_PATH}`);
console.log(`  Trials per cell: ${TRIALS}\n`);

const browser = await puppeteer.launch({
  headless: true,
  executablePath: chrome.path,
  args: ["--disable-gpu"],
});

/* ------------------------------------------------------------------ phase 1
 * Does a SYNTHETIC InputEvent carry its targetRanges?
 *
 * Harper's recipe rests entirely on this. If getTargetRanges() returns [] on an
 * untrusted event, the StaticRange is inert and Harper's Slate write is
 * succeeding for some other reason -- which is a different mechanism and a
 * different set of preconditions.
 */
if (wantPhase(1)) {
  console.log("[1] getTargetRanges() on a synthetic (untrusted) InputEvent");
  const page = await browser.newPage();
  await page.setContent(`<div id="e" contenteditable>The techncian arrived early.</div>`);
  const r = await page.evaluate(() => {
    const el = document.getElementById("e");
    const node = el.firstChild;
    const range = document.createRange();
    range.setStart(node, 4); range.setEnd(node, 13);   // "techncian"
    const out = {};
    let seen = null;
    el.addEventListener("beforeinput", (e) => {
      const tr = e.getTargetRanges();
      seen = {
        isTrusted: e.isTrusted,
        length: tr.length,
        startOffset: tr[0] ? tr[0].startOffset : null,
        endOffset: tr[0] ? tr[0].endOffset : null,
        sameNode: tr[0] ? tr[0].startContainer === node : null,
        cancelable: e.cancelable,
        inputType: e.inputType,
        data: e.data,
      };
      e.preventDefault();
    }, true);
    const ev = new InputEvent("beforeinput", {
      inputType: "insertReplacementText", data: "technician",
      bubbles: true, cancelable: true, composed: true,
      targetRanges: [new StaticRange(range)],
    });
    out.beforeDispatch = ev.getTargetRanges().length;   // outside dispatch
    el.dispatchEvent(ev);
    out.duringDispatch = seen;
    out.afterDispatch = ev.getTargetRanges().length;
    // Control: the same event with no targetRanges in its init.
    let bare = null;
    el.addEventListener("beforeinput", (e) => { bare = e.getTargetRanges().length; }, true);
    el.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText", data: "x", bubbles: true, cancelable: true,
    }));
    out.withoutTargetRanges = bare;
    return out;
  });
  console.log("    outside dispatch, before:", r.beforeDispatch);
  console.log("    DURING dispatch:         ", JSON.stringify(r.duringDispatch));
  console.log("    outside dispatch, after: ", r.afterDispatch);
  console.log("    control (no targetRanges in init): length =", r.withoutTargetRanges);
  const honoured = r.duringDispatch && r.duringDispatch.length === 1
    && r.duringDispatch.startOffset === 4 && r.duringDispatch.endOffset === 13
    && r.duringDispatch.sameNode === true;
  console.log(`    => synthetic targetRanges are ${honoured ? "VISIBLE to the handler" : "NOT visible (INERT)"}\n`);
  // An artifact here too. This phase measured something -- the whole recipe
  // rests on its one bit -- and it was the only one that produced no file, so
  // PROOFER_RESULT_JSON was accepted and silently ignored on this path. A flag
  // that does nothing is worse than one that is rejected: the caller goes
  // looking for a file that was never going to exist.
  writeArtifact("phase1", [{ honoured, ...r.duringDispatch,
    beforeDispatch: r.beforeDispatch, afterDispatch: r.afterDispatch,
    withoutTargetRanges: r.withoutTargetRanges }]);
  await page.close();
  // The whole recipe rests on this one bit. If a future Chrome makes synthetic
  // target ranges inert, every later phase would still print numbers -- they
  // would just be measuring a different mechanism -- so this exits rather than
  // letting the run continue and read like a confirmation.
  if (!honoured) {
    console.error("  Synthetic targetRanges are INERT in this browser. The shipped recipe\n"
      + "  depends on them; phases 2-5 would measure something else. Stopping.");
    await browser.close();
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ phase 2
 * The variant matrix, against real Slate.
 */
const VARIANTS = {
  // (c) the shipping recipe, as the positive control.
  control: { label: "control: select + 30ms wait + insertText", select: true, waitMs: 30, inputType: "insertText", targetRanges: false },
  // (a) Harper's recipe: select, no wait, insertReplacementText + targetRanges.
  harper:  { label: "harper: select + NO wait + insertReplacementText + targetRanges", select: true, waitMs: 0, inputType: "insertReplacementText", targetRanges: true },
  // (b) targetRanges only -- the DOM selection is never touched.
  rangesOnly: { label: "rangesOnly: NO select, NO wait, insertReplacementText + targetRanges", select: false, waitMs: 0, inputType: "insertReplacementText", targetRanges: true },
  // Decomposition: is the win the targetRanges or the inputType?
  noWaitPlain: { label: "noWaitPlain: select + NO wait + insertText, no targetRanges", select: true, waitMs: 0, inputType: "insertText", targetRanges: false },
  noWaitTextRanges: { label: "noWaitTextRanges: NO select, NO wait, insertText + targetRanges", select: false, waitMs: 0, inputType: "insertText", targetRanges: true },
  waitRanges: { label: "waitRanges: select + 30ms wait + insertReplacementText + targetRanges", select: true, waitMs: 30, inputType: "insertReplacementText", targetRanges: true },
};

/**
 * The write, in the page. Deliberately NOT spliceSentenceSlate: this is the
 * variant under test, stripped to the transport so the measurement is about the
 * dispatch and not about the surrounding guards. No swallow, no replay -- a
 * collision here shows up as damage, which is exactly what is being counted.
 */
const PAGE_WRITE = `
window.__probeWrite = async function (v, start, end, replacement) {
  const P = window.__prooferSentence;
  const el = window.__ed;
  const before = P.snText(el);
  // The caret WHERE THE USER HAS IT, which in a burst is several characters
  // past the sentence. Restoring to end+delta instead was a probe bug: it
  // dragged the caret back in front of everything typed since the write began,
  // so the tail could transpose even when the transport behaved perfectly --
  // which means the burst cells below were measuring the probe as well as the
  // recipe. Same checked arithmetic as the shipping splice now.
  const caretBefore = P.snCaret(el);
  const range = P.rangeForInnerTextOffset(el, start, end - start);
  if (!range) return { ok: false, why: "no-range" };
  const sel = window.getSelection();
  if (v.select) { sel.removeAllRanges(); sel.addRange(range); }
  if (v.waitMs) await new Promise((r) => setTimeout(r, v.waitMs));
  const init = {
    inputType: v.inputType, data: replacement,
    bubbles: true, cancelable: true, composed: true,
  };
  if (v.targetRanges) init.targetRanges = [new StaticRange(range)];
  const ev = new InputEvent("beforeinput", init);
  el.dispatchEvent(ev);
  await new Promise((r) => setTimeout(r, 30));
  const after = P.snText(el);
  if (after === before) return { ok: false, why: "ignored", defaultPrevented: ev.defaultPrevented };
  // Put the caret back by the same checked arithmetic the shipping splice uses.
  const delta = replacement.length - (end - start);
  if (caretBefore.start != null && caretBefore.start >= end) {
    const target = caretBefore.start + delta;
    if (P.snText(el).slice(target) === before.slice(caretBefore.start)) {
      const back = P.snCollapsedRange(el, target);
      if (back) { try { sel.removeAllRanges(); sel.addRange(back); } catch (e) {} }
    }
  }
  if (v.waitMs) await new Promise((r) => setTimeout(r, v.waitMs));
  return { ok: true, defaultPrevented: ev.defaultPrevented };
};`;

/** A page with Slate found, focused, emptied, and content.js injected. */
async function slateSession() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e).split("\n")[0]));
  await page.evaluateOnNewDocument(`window.chrome = {
    runtime: { id: "t", lastError: undefined, onMessage: { addListener() {} },
      sendMessage: (m, cb) => setTimeout(() => cb({ ok: true, noChanges: true }), 10) },
    storage: { local: { get: (d, cb) => cb({ ...d }), set: (o, cb) => cb && cb() },
               onChanged: { addListener: () => {} } } };`);
  await page.goto(SLATE_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(SLATE_SEL, { timeout: 25000 });
  await sleep(1200);
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    window.__ed = el;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 120), y: r.top + 14 };
  }, SLATE_SEL);
  await page.mouse.click(box.x, box.y);
  await sleep(250);
  const focused = await page.evaluate(() =>
    !!document.activeElement && (document.activeElement === window.__ed
      || window.__ed.contains(document.activeElement)));
  if (!focused) throw new Error("click did not focus the editor");
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await sleep(220);
    if (!(await userText(page))) break;
  }
  if (await userText(page)) throw new Error("editor not empty after clearing");
  await page.evaluate(CONTENT);
  await page.evaluate(PAGE_WRITE);
  await sleep(200);
  errors.length = 0;
  return { page, errors };
}

const userText = (page) => page.evaluate(() => {
  const c = window.__ed.cloneNode(true);
  for (const n of c.querySelectorAll('[contenteditable="false"], [data-slate-placeholder], [aria-hidden="true"]')) n.remove();
  return c.textContent.replace(/[﻿​]/g, "").trim();
});

const text = async (page) =>
  (await page.evaluate(() => window.__prooferSentence.snText(window.__ed))).replace(/\n$/, "");

async function typeJittered(page, s) {
  for (const ch of s) {
    await page.keyboard.type(ch);
    await sleep(jitter());
  }
}

async function clearEditor(page) {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await sleep(200);
    if (!(await userText(page))) return;
  }
}

/**
 * One trial.
 *
 * idle  -- type the sentence, pause, write, then type the tail.
 * burst -- type the sentence, start typing the tail, and fire the write
 *          mid-burst. That is the condition the shipping recipe defers away
 *          from, and the one the swallow/replay machinery exists for.
 *
 * The verdict is the FINAL text: the correction has to be there AND the tail
 * has to have landed after it, character for character.
 */
async function trial(page, variant, mode) {
  await clearEditor(page);
  await typeJittered(page, TYPO);
  await sleep(300);
  const start = 0, end = TYPO.length;
  let write;
  if (mode === "idle") {
    write = await page.evaluate((a) => window.__probeWrite(a.v, a.start, a.end, a.rep),
      { v: variant, start, end, rep: FIXED });
    await typeJittered(page, TAIL);
  } else {
    // Fire the write between the 3rd and 4th character of the tail -- the
    // trigger's own worst moment, three characters into the next sentence.
    const head = TAIL.slice(0, 3), rest = TAIL.slice(3);
    await typeJittered(page, head);
    const pending = page.evaluate((a) => window.__probeWrite(a.v, a.start, a.end, a.rep),
      { v: variant, start, end, rep: FIXED });
    await typeJittered(page, rest);
    write = await pending;
  }
  await sleep(400);
  const final = await text(page);
  const expected = mode === "idle" ? FIXED + TAIL : null;
  return { write, final, expected };
}

/**
 * Did the trial end in the right place?
 *
 * Two separate columns, never one boolean -- conflating them produced a false
 * 0/2 for Lexical in the SN_TRANSPORTS run and sent the diagnosis to a harness
 * artifact that did not exist.
 *
 *   applied  -- the correction is in the final text at all
 *   intact   -- the final text is EXACTLY the correction plus the tail: no
 *               dropped, doubled or transposed character anywhere
 */
function score(r) {
  const want = FIXED + TAIL;
  const applied = r.final.includes("technician");
  const intact = r.final === want;
  return { applied, intact, final: r.final, why: r.write && r.write.why, dp: r.write && r.write.defaultPrevented };
}

if (wantPhase(2)) {
  let sess;
  try {
    sess = await slateSession();
  } catch (e) {
    console.error(`  slatejs.org unreachable or changed shape: ${e.message}`);
    await browser.close();
    process.exit(EXIT_SKIPPED);
  }
  const { page, errors } = sess;
  const only = (process.env.PROOFER_VARIANTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const names = only.length ? only : Object.keys(VARIANTS);
  const unknown = names.filter((n) => !VARIANTS[n]);
  if (unknown.length) {
    console.error(`PROOFER_VARIANTS names no such variant: ${unknown.join(", ")}. `
      + `Known: ${Object.keys(VARIANTS).join(", ")}`);
    await browser.close();
    process.exit(2);
  }
  const table = [];
  for (const name of names) {
    const v = VARIANTS[name];
    console.log(`\n[2] ${v.label}`);
    for (const mode of ["idle", "burst"]) {
      let applied = 0, intact = 0;
      const notes = [];
      for (let i = 0; i < TRIALS; i++) {
        errors.length = 0;
        let s;
        try {
          s = score(await trial(page, v, mode));
        } catch (e) {
          notes.push(`trial ${i}: threw ${e.message}`);
          continue;
        }
        if (s.applied) applied++;
        if (s.intact) intact++;
        if (!s.intact) notes.push(`t${i} ${s.why || ""}${s.dp ? " dp" : ""}: ${JSON.stringify(s.final)}`);
        if (errors.length) notes.push(`t${i} pageerror: ${errors[0]}`);
      }
      console.log(`    ${mode.padEnd(5)}  applied ${applied}/${TRIALS}   intact ${intact}/${TRIALS}`);
      printNotes(notes, 6, "           ");
      table.push({ variant: name, mode, applied, intact, trials: TRIALS });
    }
  }
  console.log("\n" + "-".repeat(72));
  console.log("variant                 mode    applied   intact");
  for (const row of table) {
    console.log(`${row.variant.padEnd(22)}  ${row.mode.padEnd(6)}  ${String(row.applied + "/" + row.trials).padEnd(8)}  ${row.intact}/${row.trials}`);
  }
  writeArtifact("phase2", table);
  await page.close();
}

/* ------------------------------------------------------------------ phase 3
 * The same two recipes, WITH the guards the shipping path actually has.
 *
 * Phase 2 strips the write down to the transport, which is right for asking
 * "does the editor honour this dispatch" and wrong for asking "should we ship
 * it": nothing there swallows the colliding keystroke, so its burst column
 * measures the transport bare. (That column read 0/N in every cell until the
 * caret arithmetic above was fixed -- part of which was the harness, not the
 * recipe.) The decision needs both recipes carrying the same swallow/replay
 * machinery, so the only difference left is the window itself.
 *
 *   guarded-shipping  select the sentence, wait 30ms, dispatch insertText
 *   guarded-intent    dispatch insertReplacementText + targetRanges directly,
 *                     with no selection change and no wait before it
 *
 * Both then restore the caret by the same checked arithmetic, wait for Slate to
 * read that, and replay whatever the bail handler ate.
 */
const PAGE_SPLICE = `
window.__probeSplice = async function (opt, start, end, replacement) {
  const mode = typeof opt === "string" ? opt : opt.mode;
  const guards = typeof opt === "string" ? true : opt.guards !== false;
  const ourCaret = typeof opt === "string" ? true : opt.caret !== "slate";
  const P = window.__prooferSentence;
  const el = window.__ed;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SYNC = 30, REPLAY = 30;
  const beforeText = P.snText(el);
  const before = beforeText.slice(start, end);
  const caretBefore = P.snCaret(el);
  const range = P.rangeForInnerTextOffset(el, start, end - start);
  if (!range) return { ok: false, why: "no-range" };
  if (range.toString() !== before) return { ok: false, why: "stale-range" };
  const sel = window.getSelection();
  if (!sel) return { ok: false, why: "no-selection" };

  let aborted = false, writing = false, swallowed = "", keyTook = false, swallows = 0;
  const bail = (e) => {
    if (writing) return;
    if (e.type === "keydown") {
      keyTook = !!(e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey);
      if (keyTook) { swallowed += e.key; swallows++; }
    } else if (e.type === "beforeinput" && e.inputType === "insertText" && e.data && !keyTook) {
      swallowed += e.data; swallows++;
    }
    aborted = true;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
  };
  const attach = () => {
    if (!guards) return;
    document.addEventListener("beforeinput", bail, true);
    document.addEventListener("keydown", bail, true);
    document.addEventListener("compositionstart", bail, true);
  };
  const detach = () => {
    document.removeEventListener("beforeinput", bail, true);
    document.removeEventListener("keydown", bail, true);
    document.removeEventListener("compositionstart", bail, true);
  };
  const restore = () => {
    const back = caretBefore.start != null ? P.snCollapsedRange(el, caretBefore.start) : null;
    if (back) { try { sel.removeAllRanges(); sel.addRange(back); } catch (e) {} }
  };
  async function replaySwallowed() {
    if (!el.isConnected) { detach(); return; }
    await sleep(REPLAY);
    const t = swallowed; swallowed = ""; detach();
    if (!t || !el.isConnected) return;
    writing = true;
    try {
      el.dispatchEvent(new InputEvent("beforeinput", {
        inputType: "insertText", data: t, bubbles: true, cancelable: true, composed: true,
      }));
    } catch (e) {} finally { writing = false; }
  }

  attach();
  try {
    if (mode === "shipping") {
      sel.removeAllRanges();
      sel.addRange(range);
      await sleep(SYNC);
      if (aborted || P.snText(el) !== beforeText) {
        restore(); await replaySwallowed();
        return { ok: false, why: aborted ? "aborted" : "text-moved", swallows };
      }
    } else if (mode === "intent-select") {
      // Same tick as the dispatch below -- no await, so no window. This is the
      // candidate fix for the dirty-map hole phase 4 measures: whichever branch
      // Slate takes, both point at the same span.
      sel.removeAllRanges();
      sel.addRange(range);
      if (P.snText(el) !== beforeText) { detach(); return { ok: false, why: "text-moved", swallows }; }
    } else if (P.snText(el) !== beforeText) {
      // No window to abort in -- there was no wait. The only thing worth
      // re-checking is the same-tick truth the shipping path checks anyway.
      detach();
      return { ok: false, why: "text-moved", swallows };
    }
    const init = {
      inputType: mode === "shipping" ? "insertText" : "insertReplacementText",
      data: replacement, bubbles: true, cancelable: true, composed: true,
    };
    if (mode !== "shipping") init.targetRanges = [new StaticRange(range)];
    writing = true;
    try { el.dispatchEvent(new InputEvent("beforeinput", init)); }
    finally { writing = false; }

    await sleep(SYNC);
    if (P.snText(el) === beforeText) {
      restore(); await replaySwallowed();
      return { ok: false, why: "ignored", swallows };
    }
    // caret: "slate" leaves it entirely to the editor. slate-react takes a
    // rangeRef of the user's selection before it adopts the event's target
    // range, and re-selects it after the edit -- transformed by the very
    // operations the edit performed. If that holds, our arithmetic restore is
    // a second answer to a question already answered, and it costs a window.
    if (ourCaret) {
      const delta = replacement.length - before.length;
      if (caretBefore.start != null && caretBefore.start >= end) {
        const target = caretBefore.start + delta;
        if (P.snText(el).slice(target) === beforeText.slice(caretBefore.start)) {
          const back = P.snCollapsedRange(el, target);
          if (back) { try { sel.removeAllRanges(); sel.addRange(back); } catch (e) {} }
        }
      }
      await sleep(SYNC);
    }
    await replaySwallowed();
    const caretAfter = P.snCaret(el);
    return { ok: true, swallows, caret: caretAfter.start };
  } finally { detach(); }
};`;

/**
 * How many characters of the intended final text are missing.
 *
 * A misplaced tail and a DELETED character are not the same failure -- the
 * first is a caret bug the user can see and fix, the second is text they typed
 * and will never get back -- so the multiset of characters is compared rather
 * than the string.
 */
function countLost(got, want) {
  const bag = new Map();
  for (const ch of got) bag.set(ch, (bag.get(ch) || 0) + 1);
  let lost = 0;
  for (const ch of want) {
    const n = bag.get(ch) || 0;
    if (n === 0) lost++;
    else bag.set(ch, n - 1);
  }
  return lost;
}

if (wantPhase(3)) {
  let sess;
  try {
    sess = await slateSession();
  } catch (e) {
    console.error(`  slatejs.org unreachable or changed shape: ${e.message}`);
    await browser.close();
    process.exit(EXIT_SKIPPED);
  }
  const { page, errors } = sess;
  await page.evaluate(PAGE_SPLICE);

  /** One guarded trial. `real` drives the SHIPPING function rather than the mirror. */
  async function guardedTrial(opt, kind, real) {
    await clearEditor(page);
    await typeJittered(page, TYPO);
    await sleep(300);
    const start = 0, end = TYPO.length;
    const call = (a) => (a.real
      ? window.__prooferSentence.spliceSentenceSlate(window.__ed, a.start, a.end, a.rep)
      : window.__probeSplice(a.opt, a.start, a.end, a.rep));
    let write;
    if (kind === "idle") {
      write = await page.evaluate(call, { opt, start, end, rep: FIXED, real: !!real });
      await typeJittered(page, TAIL);
    } else {
      // TYPING IN FLIGHT, not typing resumed. The old shape awaited three
      // characters and only then fired, which is a settled moment: the last
      // keystroke has been delivered, its `selectionchange` has been processed,
      // and Slate's node map is clean. Firing there took the CLEAN branch
      // almost every time, whose guard detaches ~30ms after the settle -- so
      // one swallow batch per trial, and the whole class of "a second batch
      // arrives after the first has been replayed" was unreachable.
      //
      // It cost a real regression: this phase read 16/16 on bytes that another
      // agent's continuous-typing probe measured at 3/8 with 7 of the user's
      // characters deleted. A burst that can only produce one batch is not a
      // burst, it is a collision.
      //
      // So typing is started and NOT awaited, and the write is fired into the
      // middle of it. That also makes the dirty branch ordinary rather than
      // exotic -- a keystroke in flight leaves a `selectionchange` pending,
      // which is exactly what dirties the map.
      const typing = typeJittered(page, TAIL);
      await sleep(120);
      const pending = page.evaluate(call, { opt, start, end, rep: FIXED, real: !!real });
      await typing;
      write = await pending;
    }
    await sleep(700);
    return { write, final: await text(page) };
  }

  const ALL_ARMS = [
    { opt: { mode: "shipping" }, real: true, label: "shipping spliceSentenceSlate (the real function)" },
    { opt: { mode: "shipping" }, label: "guarded-shipping (mirror: select + 30ms + insertText)" },
    { opt: { mode: "intent" }, label: "guarded-intent   (no select/wait, targetRanges, our caret)" },
    { opt: { mode: "intent", caret: "slate" }, label: "intent-slatecaret (as above, Slate keeps the caret)" },
    { opt: { mode: "intent", caret: "slate", guards: false }, label: "intent-bare      (no caret restore, NO swallow/replay)" },
  ];
  const pick = (process.env.PROOFER_ARMS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Every NAME must match something. Filtering on "matched at least one arm"
  // let `PROOFER_ARMS=shipping,intnet` run one arm and report success for two.
  const unmatched = pick.filter((p) => !ALL_ARMS.some((a) => a.label.startsWith(p)));
  if (unmatched.length) {
    console.error(`PROOFER_ARMS names no such arm: ${unmatched.join(", ")}. `
      + `Known: ${ALL_ARMS.map((a) => a.label.split(" ")[0]).join(", ")}`);
    await browser.close();
    process.exit(2);
  }
  const ARMS = pick.length
    ? ALL_ARMS.filter((a) => pick.some((p) => a.label.startsWith(p)))
    : ALL_ARMS;
  if (!ARMS.length) {
    console.error(`PROOFER_ARMS=${process.env.PROOFER_ARMS} matched no arm. `
      + `Known: ${ALL_ARMS.map((a) => a.label.split(" ")[0]).join(", ")}`);
    await browser.close();
    process.exit(2);
  }
  const table = [];
  for (const arm of ARMS) {
    console.log(`\n[3] ${arm.label}`);
    for (const kind of ["idle", "burst"]) {
      // Three outcomes, and the middle one is the whole reason the abort path
      // exists. A refusal that leaves the user's text perfect is a MISSED
      // CORRECTION and costs nothing; damage is characters they typed and will
      // not get back. Scoring "the final text is not what we wanted" as one
      // number puts those in the same column and makes the abort path look like
      // corruption -- which is exactly backwards.
      let intact = 0, refusedClean = 0, damaged = 0, swallows = 0;
      const notes = [];
      const n = TRIALS * 2;
      for (let i = 0; i < n; i++) {
        errors.length = 0;
        let r;
        try { r = await guardedTrial(arm.opt, kind, arm.real); }
        catch (e) { notes.push(`t${i} threw ${e.message}`); damaged++; continue; }
        if (r.final === FIXED + TAIL) intact++;
        else if (r.final === TYPO + TAIL) refusedClean++;
        else damaged++;
        const w = r.write && typeof r.write === "object" ? r.write.swallows : null;
        if (w) swallows += w;
        const why = r.write && (r.write.reason || r.write.why || (r.write.ok ? "ok" : "?"));
        // Characters of what the USER typed that are simply gone. FIXED is TYPO
        // plus one letter, so this is independent of whether the correction
        // landed -- it answers "did we delete their text", nothing else.
        const lost = countLost(r.final, TYPO + TAIL);
        if (r.final !== FIXED + TAIL) {
          notes.push(`t${i} ${why}${lost ? ` LOST ${lost} user chars` : ""}: ${JSON.stringify(r.final)}`);
        }
        if (errors.length) notes.push(`t${i} pageerror: ${errors[0]}`);
      }
      console.log(`    ${kind.padEnd(5)}  intact ${intact}/${n}   refused-clean ${refusedClean}/${n}   DAMAGED ${damaged}/${n}   swallowed ${swallows}`);
      printNotes(notes, 8, "           ");
      table.push({ arm: arm.label, kind, intact, refusedClean, damaged, trials: n });
    }
  }
  console.log("\n" + "-".repeat(72));
  for (const r of table) {
    console.log(`${r.arm.slice(0, 40).padEnd(42)} ${r.kind.padEnd(6)} intact ${r.intact}/${r.trials}  refused ${r.refusedClean}/${r.trials}  DAMAGED ${r.damaged}/${r.trials}`);
  }
  writeArtifact("phase3", table);
  await page.close();
}

/* ------------------------------------------------------------------ phase 4
 * THE DIRTY-MAP HOLE. A selection change the editor has not processed yet makes
 * Slate ignore the target range and write somewhere else entirely.
 *
 * Found by audit, not by the phases above -- they collide the write with
 * TYPING, and this collides it with a SELECTION MOVE, which changes no text and
 * so passes every check the anchor and the write make.
 *
 * The mechanism, read out of the bundle slatejs.org serves:
 *
 *   1. `onDOMBeforeInput` opens with `scheduleOnDOMSelectionChange.flush();
 *      onDOMSelectionChange.flush()` -- so a selection read that is merely
 *      PENDING is executed synchronously INSIDE our own dispatch.
 *   2. that read calls `Transforms.select`, whose `set_selection` operation
 *      does `IS_NODE_MAP_DIRTY.set(editor, true)` (slate-dom/with-dom.ts).
 *   3. the target-range branch is guarded by `!IS_NODE_MAP_DIRTY.get(editor)`,
 *      so it is skipped -- and the switch still runs
 *      `Editor.insertText(editor, data)`, at whatever the flush just selected.
 *
 * React clears the flag when it re-renders, so the hazard is a race, not a
 * constant. The variable is therefore the DELAY between the selection moving
 * and the write, and it is swept rather than guessed -- a single delay proves
 * nothing here, the same way a fixed keystroke cadence proved nothing about
 * collisions.
 *
 * The selection is moved by setting a collapsed DOM range, which is exactly
 * what a click does to the DOM and what Slate's `selectionchange` listener
 * sees. A real Puppeteer click cannot be timed to a task turn.
 *
 * THE FIX UNDER TEST is `intent-select`: set the DOM selection to the sentence
 * in the SAME TICK as the dispatch. No await, so no window is reopened -- but
 * now the flush in step 1 reads OUR range rather than the user's click, so the
 * dirty branch selects the sentence and replaces exactly the same span the
 * clean branch would have. Both roads lead to the same place.
 */
if (wantPhase(4)) {
  let sess;
  try {
    sess = await slateSession();
  } catch (e) {
    console.error(`  slatejs.org unreachable or changed shape: ${e.message}`);
    await browser.close();
    process.exit(EXIT_SKIPPED);
  }
  const { page } = sess;
  await page.evaluate(PAGE_SPLICE);

  const DELAYS = (process.env.PROOFER_DELAYS || "0,1,2,4,8,16,32,64")
    .split(",").map(Number);
  const KNOWN4 = ["intent", "intent-select", "shipping", "real"];
  const ARMS = process.env.PROOFER_ARMS
    ? process.env.PROOFER_ARMS.split(",").map((s) => s.trim()).filter(Boolean)
    : ["intent", "intent-select", "real"];
  const bad4 = ARMS.filter((a) => !KNOWN4.includes(a));
  if (!ARMS.length || bad4.length) {
    console.error(`phase 4 arms ${bad4.join(", ") || "(none)"} unknown. Known: ${KNOWN4.join(", ")}`);
    await browser.close();
    process.exit(2);
  }
  if (DELAYS.some((d) => !Number.isFinite(d) || d < 0)) {
    console.error(`PROOFER_DELAYS=${process.env.PROOFER_DELAYS} is not a list of delays in ms.`);
    await browser.close();
    process.exit(2);
  }

  /**
   * One trial: type, move the selection like a click would, wait `delay`, write.
   *
   * The "click" lands AFTER the sentence -- the position the anchor explicitly
   * allows, since a caret at or after job.end is exactly what the trigger
   * expects while the user types on.
   */
  async function dirtyTrial(arm, delay) {
    await clearEditor(page);
    await typeJittered(page, TYPO + TAIL);
    await sleep(400);
    return page.evaluate(async (a) => {
      const P = window.__prooferSentence, el = window.__ed;
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const before = P.snText(el);
      const cr = P.snCollapsedRange(el, a.clickAt);
      if (!cr) return { why: "no-click-range" };
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(cr);
      await nap(a.delay);
      const w = a.arm === "real"
        ? await P.spliceSentenceSlate(el, 0, a.end, a.rep)
        : await window.__probeSplice({ mode: a.arm }, 0, a.end, a.rep);
      await nap(200);
      return { w, before, after: P.snText(el) };
    }, { arm, delay, end: TYPO.length, rep: FIXED, clickAt: TYPO.length + 3 });
  }

  console.log("\n[4] A selection move the editor has not processed yet");
  console.log("    correct = the sentence is replaced in place");
  console.log("    WRONG   = the replacement landed somewhere else (silent corruption)\n");
  const want = (FIXED + TAIL).replace(/\n$/, "");
  const table = [];
  for (const arm of ARMS) {
    for (const delay of DELAYS) {
      let correct = 0, wrong = 0, refused = 0;
      const notes = [];
      for (let i = 0; i < TRIALS; i++) {
        let r;
        try { r = await dirtyTrial(arm, delay); }
        catch (e) { notes.push(`threw ${e.message}`); wrong++; continue; }
        const after = (r.after || "").replace(/\n$/, "");
        const before = (r.before || "").replace(/\n$/, "");
        // A REFUSAL IS A DOCUMENT THAT DID NOT MOVE, not a result object that
        // says ok:false. `failed-transport/misplaced` reports a failure AFTER
        // the foreign mutation has already happened, so counting it as refused
        // scored the corruption this phase exists to find as a clean stop.
        if (after === want) correct++;
        else if (after === before) { refused++; notes.push(`t${i} refused clean: ${r.w && (r.w.reason || r.w.why)}`); }
        else { wrong++; notes.push(`t${i} ${r.w && (r.w.reason || r.w.why) || "?"}: ${JSON.stringify(after)}`); }
      }
      table.push({ arm, delay, correct, wrong, refused, trials: TRIALS });
      const flag = wrong ? "   <-- WRONG LOCATION" : "";
      console.log(`    ${arm.padEnd(14)} delay ${String(delay).padStart(2)}ms   correct ${correct}/${TRIALS}   wrong ${wrong}   refused ${refused}${flag}`);
      printNotes(notes, 2, "                   ");
    }
    console.log("");
  }
  writeArtifact("phase4", table);
  await page.close();
}

/* ------------------------------------------------------------------ phase 6
 * THE CROSS-PRODUCT. Phase 4 moves the selection and does not press a key;
 * phase 5 presses a key after 400ms of stable selection. Each tests half of a
 * hazard that only exists when both are true at once, and the audit that found
 * it said so in as many words: the dangerous product was untested.
 *
 * Why it bites. In the dirty branch Slate skips the target-range block, and
 * that block is where it takes the rangeRef of the user's caret -- so it never
 * restores one. The replacement leaves Slate's selection at the CORRECTION END
 * rather than where the user was. Measured directly, 5ms after the write:
 *
 *     clean   caret 45  = caretBefore 44 + delta 1   (the user's own caret)
 *     dirty   caret 29  = the end of the correction
 *
 * A Backspace in that window is then applied at 29, and eats a character of the
 * sentence we just corrected -- silently, with the write still reporting
 * `landed`:
 *
 *     "The technician arrived early Then we shipped"
 *                                 ^ the correction's own period, deleted
 *
 * ArrowLeft is the quieter twin: it changes no text, so every check passes and
 * the caret simply ends up somewhere the user did not put it.
 */
if (wantPhase(6)) {
  let sess;
  try {
    sess = await slateSession();
  } catch (e) {
    console.error(`  slatejs.org unreachable or changed shape: ${e.message}`);
    await browser.close();
    process.exit(EXIT_SKIPPED);
  }
  const { page } = sess;
  await page.evaluate(PAGE_SPLICE);

  const TAIL6 = " Then we shipped";
  const FULL6 = FIXED + TAIL6;
  const KNOWN6 = ["intent-select", "real"];
  const ARMS = process.env.PROOFER_ARMS
    ? process.env.PROOFER_ARMS.split(",").map((s) => s.trim()).filter(Boolean)
    : KNOWN6;
  const bad6 = ARMS.filter((a) => !KNOWN6.includes(a));
  if (!ARMS.length || bad6.length) {
    console.error(`phase 6 arms ${bad6.join(", ") || "(none)"} unknown. Known: ${KNOWN6.join(", ")}`);
    await browser.close();
    process.exit(2);
  }

  // The key is pressed from the page, not from Puppeteer: the whole point is
  // to land it inside a window measured in single milliseconds, and the CDP
  // round trip is longer than the window.
  // ArrowLeft is the quiet twin: it changes NO text, so a text-only score reads
  // it as clean whatever happened. It has to be judged on the caret, against
  // where the user's caret would be after one step left.
  // The user's caret offset past the sentence, PARAMETERISED -- it was
  // hardcoded at +3, and that is exactly why this phase could not see the
  // ±1-delta alias. With a correction one character longer than the typo, a
  // user caret at +1 sits at original offset 29 while the dirty correction end
  // is also 29, so a gate that accepts "the original caret" reads Slate's caret
  // as the user's. At +3 the two are three apart and nothing shows.
  const OFFSETS = (process.env.PROOFER_OFFSETS || "3,1").split(",").map(Number);
  // Where the user's caret is once the correction has shifted the text.
  const DELTA = FIXED.length - TYPO.length;
  // And what each key does THERE. The first version of this expected a
  // Backspace to eat the last character of the message, which is where the
  // caret sits in every other phase -- here the user has clicked into the
  // middle, so the correct deletion is at their caret and the "wrong" answer
  // looks superficially similar. Scoring against the wrong expectation reported
  // a correct deletion as corruption at +150ms.
  const casesFor = (clickAt) => {
    const userCaret = clickAt + DELTA;
    return [
      // Deleting the character before the caret also moves the caret back one.
      // Leaving wantCaret undefined here made a CORRECT Backspace score as
      // unsafe, because the success branch compared against undefined.
      { name: "Backspace", key: "Backspace", userCaret,
        want: FULL6.slice(0, userCaret - 1) + FULL6.slice(userCaret),
        wantCaret: userCaret - 1 },
      { name: "ArrowLeft", key: "ArrowLeft", userCaret, want: FULL6,
        wantCaret: userCaret - 1 },
      // BLOCKER 2's cases, in the branch where the hazard exists. A printable is
      // buffered first, so `yieldWindow` has something to place when the click
      // or the IME start arrives -- and on dirty Slate an ungated synchronous
      // flush puts it at the correction end. Scored by what must NOT happen,
      // because two outcomes are both correct: flushed at the user's caret, or
      // refused because the caret could not be proven.
      { name: "char+click", keys: ["z", "__click"], userCaret, safeOnly: true },
      { name: "char+composition", keys: ["z", "__composition"], userCaret, safeOnly: true },
    ];
  };

  /**
   * One trial, with a REAL key.
   *
   * The first version dispatched a synthetic KeyboardEvent for the arrow, and
   * that measured nothing at all: an untrusted event has no default action, so
   * the caret could not move however the code behaved -- the cell read "no-op"
   * whatever it was given. Same class of defect as everything else this file
   * keeps finding: a probe that cannot observe the thing it claims to score.
   *
   * So the splice is STARTED inside the page (the map has to be dirtied one
   * task turn before it, which Puppeteer cannot time) and then left running
   * while the key is pressed from here, for real. `at` is measured from the
   * start of that evaluate, so it runs a fraction early -- which errs toward
   * the dangerous side of the window rather than away from it.
   */
  async function crossTrial(arm, kase, at, clickAt) {
    await clearEditor(page);
    await typeJittered(page, TYPO + TAIL6);
    await sleep(400);
    await page.evaluate((a) => {
      const P = window.__prooferSentence, el = window.__ed;
      window.__p = (async () => {
        const cr = P.snCollapsedRange(el, a.clickAt);
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(cr);
        await new Promise((r) => setTimeout(r, 0));   // let selectionchange queue
        const w = a.arm === "real"
          ? await P.spliceSentenceSlate(el, 0, a.end, a.rep)
          : await window.__probeSplice({ mode: "intent-select" }, 0, a.end, a.rep);
        return w;
      })();
    }, { arm, end: TYPO.length, rep: FIXED, clickAt });
    await sleep(at);
    for (const k of (kase.keys || [kase.key])) {
      if (k === "__click") {
        const box = await page.evaluate(() => {
          const r = window.__ed.getBoundingClientRect();
          return { x: r.left + 2, y: r.top + 10 };
        });
        await page.mouse.click(box.x, box.y);
      } else if (k === "__composition") {
        await page.evaluate(() => {
          window.__ed.dispatchEvent(new CompositionEvent("compositionstart", {
            bubbles: true, cancelable: true, composed: true }));
        });
      } else {
        await page.keyboard.press(k.length === 1 ? `Key${k.toUpperCase()}` : k);
      }
      await sleep(12);
    }
    const w = await page.evaluate(() => window.__p);
    await sleep(400);
    const out = await page.evaluate(() => ({
      after: window.__prooferSentence.snText(window.__ed),
      caret: window.__prooferSentence.snCaret(window.__ed),
    }));
    return { w, after: out.after, caret: out.caret };
  }

  console.log("\n[6] A selection move AND a key in the window (the cross-product)");
  console.log("    correct = the correction is intact and the key acted where the USER was\n");
  const ATS = (process.env.PROOFER_ATS || "2,10,25").split(",").map(Number);
  const table6 = [];
  for (const arm of ARMS) {
   for (const clickAt of OFFSETS.map((o) => TYPO.length + o)) {
    for (const kase of casesFor(clickAt)) {
      for (const at of ATS) {
        let correct = 0, corrupt = 0, blocked = 0, unsafeCaret = 0;
        const notes = [];
        for (let i = 0; i < TRIALS; i++) {
          let r;
          try { r = await crossTrial(arm, kase, at, clickAt); }
          catch (e) { notes.push(`threw ${e.message}`); corrupt++; continue; }
          const after = (r.after || "").replace(/\n$/, "");
          const caret = r.caret && r.caret.start;
          // FOUR OUTCOMES, and the one that used to hide inside "no-op" is the
          // point of this rewrite. A cancelled action is only safe if the caret
          // it leaves behind is the USER's: park it inside the correction and
          // the very next printable key lands there, which is the damage this
          // phase exists to catch, one keystroke later. Scoring intact-text as
          // success regardless of caret is what let "caret 28 wanted 31" read
          // as a pass.
          if (kase.safeOnly) {
            // EXACT, because the dangerous placement is at the correction END --
            // one character past it — and "the correction is still intact" cannot
            // see that: FULL6.slice(0, FIXED.length) is unchanged whether the
            // character went in at the user's caret or at the boundary. The
            // first version of this assertion passed against a deliberately
            // ungated build for exactly that reason.
            const placed = FULL6.slice(0, kase.userCaret) + "z" + FULL6.slice(kase.userCaret);
            if (after === placed) correct++;        // flushed where the user was
            else if (after === FULL6) blocked++;    // refused; character held back
            else { corrupt++; notes.push(`t${i} misplaced: ${JSON.stringify(after)}`); }
          } else if (after !== FULL6 && !after.startsWith(FIXED)) {
            corrupt++; notes.push(`t${i} CORRUPT ${JSON.stringify(after)}`);
          } else if (after === kase.want && caret === kase.wantCaret) {
            correct++;                       // the action took effect, correctly
          } else if (after === FULL6 && caret === kase.userCaret) {
            blocked++;                       // refused, and the caret is theirs
          } else {
            unsafeCaret++;
            notes.push(`t${i} text ${after === FULL6 ? "unchanged" : "changed"}, `
              + `caret ${caret} (user ${kase.userCaret}, acted ${kase.wantCaret})`);
          }
        }
        const flag = corrupt ? "   <-- CORRECTION DAMAGED"
          : unsafeCaret ? "   <-- CARET LEFT IN THE CORRECTION" : "";
        table6.push({ arm, key: kase.name, clickAt, at, correct, blocked, corrupt,
                      unsafeCaret, trials: TRIALS });
        console.log(`    ${arm.padEnd(13)} ${kase.name.padEnd(10)} @+${clickAt - TYPO.length} `
          + `+${String(at).padStart(3)}ms   acted ${correct}/${TRIALS}   no-op ${blocked}   `
          + `unsafe-caret ${unsafeCaret}   corrupt ${corrupt}${flag}`);
        printNotes(notes, 2, "                   ");
      }
    }
   }
    console.log("");
  }
  writeArtifact("phase6", table6);
  await page.close();
}

/* ------------------------------------------------------------------ phase 5
 * WHAT THE WINDOW EATS. Every trial in phases 2-4 types ordinary letters, and
 * the buffer replays as TEXT -- so a printable character is the one thing the
 * swallow can give back, and the phases were built out of exactly that case.
 *
 * A Backspace, an Enter, an arrow, Ctrl+Z, a paste and an IME start were all
 * cancelled by `bail` and never replayed. This measures the sequences a user
 * actually produces in the ~90ms behind the write, and scores the FINAL TEXT
 * against what THEY asked for -- not against what the correction wanted.
 *
 *   old  the mirror in PAGE_SPLICE, which still swallows everything
 *   new  the shipping spliceSentenceSlate, which yields the window to anything
 *        it cannot replay
 */
if (wantPhase(5)) {
  let sess;
  try {
    sess = await slateSession();
  } catch (e) {
    console.error(`  slatejs.org unreachable or changed shape: ${e.message}`);
    await browser.close();
    process.exit(EXIT_SKIPPED);
  }
  const { page } = sess;
  await page.evaluate(PAGE_SPLICE);

  const FULL = FIXED + TAIL;
  // Each case: the keys the user presses inside the window, and the text they
  // are entitled to end up with. `z` stands in for any printable character.
  // Every one of these is a REAL trusted event -- the whole point is that a
  // synthesised one takes a different path through the guard. `paste` needs the
  // clipboard, so it is granted below and skipped (loudly) if the grant fails.
  //
  // NOT covered, and said plainly rather than implied: a real IME composition.
  // Puppeteer cannot produce a trusted compositionstart, and a synthetic one
  // proves only that the listener is attached. `bail` yields on it
  // unconditionally for that reason -- an IME session is not cancellable and
  // fighting one is worse than any caret it might open at.
  const CASES = [
    { name: "Backspace", keys: ["Backspace"], want: FULL.slice(0, -1) },
    { name: "char+Backspace", keys: ["z", "Backspace"], want: FULL },
    { name: "ArrowLeft+char", keys: ["ArrowLeft", "z"], want: FULL.slice(0, -1) + "z" + FULL.slice(-1) },
    { name: "char (control)", keys: ["z"], want: FULL + "z" },
    // Delete at the end of the text is a no-op, so it is paired with an arrow
    // to make it decidable: without the arrow, "cancelled" and "let through"
    // produce the same field and the case proves nothing.
    { name: "ArrowLeft+Delete", keys: ["ArrowLeft", "Delete"], want: FULL.slice(0, -1) },
    // Enter followed by a character, so the new block has content: `text()`
    // strips one trailing newline, and an empty final block is invisible to it.
    { name: "Enter+char", keys: ["Enter", "z"], want: FULL + "\nz" },
    { name: "paste (Ctrl+V)", keys: ["__paste"], want: FULL + "PASTED", needsClipboard: true },
    // The keydown route yields on Control and detaches the guard BEFORE the
    // paste event, so Ctrl+V never exercised the paste listener it was added
    // for. This one dispatches the `paste` event itself, carrying a real
    // DataTransfer -- the menu, mobile and accessibility route, and the only
    // one that reaches the listener.
    { name: "paste (event)", keys: ["__pasteEvent"], want: FULL + "PASTED" },
    { name: "click+char", keys: ["__click", "z"], want: "z" + FULL },
    // THE REVERSE ORDERINGS, and they are the ones that matter for the
    // synchronous flush: a character is already buffered when the click or the
    // IME start arrives, so `yieldWindow` has something to place at a caret it
    // may not be able to prove. Scored by what must NOT happen -- the character
    // inside the correction -- because two outcomes are both acceptable: the
    // flush lands it at the user's caret, or the caret cannot be proven and it
    // is refused and recorded.
    // NOTE: char+click and char+composition live in phase 6, not here. They were
    // written here first and a negative control showed the cases could not fail:
    // the hazard they exist for is the synchronous flush placing a buffered
    // character at the CORRECTION END, which only happens on the dirty branch,
    // and this phase's harness is clean-branch throughout. Gated and ungated
    // builds behave identically here, so the cases passed against both.
  ];
  const KNOWN5 = ["old", "new"];
  const ARMS = process.env.PROOFER_ARMS
    ? process.env.PROOFER_ARMS.split(",").map((s) => s.trim()).filter(Boolean)
    : KNOWN5;
  const bad5 = ARMS.filter((a) => !KNOWN5.includes(a));
  if (!ARMS.length || bad5.length) {
    console.error(`phase 5 arms ${bad5.join(", ") || "(none)"} unknown. Known: ${KNOWN5.join(", ")}`);
    await browser.close();
    process.exit(2);
  }
  const AT_MS = Number(process.env.PROOFER_AT || 10);
  const table5 = [];

  async function keyTrial(arm, kase) {
    await clearEditor(page);
    await typeJittered(page, TYPO + TAIL);
    await sleep(400);
    const pending = page.evaluate((a) => {
      const P = window.__prooferSentence, el = window.__ed;
      return a.arm === "new"
        ? P.spliceSentenceSlate(el, 0, a.end, a.rep)
        : window.__probeSplice({ mode: "intent-select" }, 0, a.end, a.rep);
    }, { arm, end: TYPO.length, rep: FIXED });
    await sleep(AT_MS);
    for (const k of kase.keys) {
      if (k === "__composition") {
        // A synthetic compositionstart. It cannot prove anything about a real
        // IME -- Puppeteer cannot produce a trusted one -- but it does drive
        // OUR handler, which is the half under test here.
        await page.evaluate(() => {
          window.__ed.dispatchEvent(new CompositionEvent("compositionstart", {
            bubbles: true, cancelable: true, composed: true }));
        });
      } else if (k === "__pasteEvent") {
        await page.evaluate(() => {
          const dt = new DataTransfer();
          dt.setData("text/plain", "PASTED");
          window.__ed.dispatchEvent(new ClipboardEvent("paste", {
            clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
        });
      } else if (k === "__paste") {
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyV");
        await page.keyboard.up("Control");
      } else if (k === "__click") {
        // A real mousedown at the very start of the text. The assertion is that
        // the caret STAYS there -- an unconditional restore would drag it back
        // to where the user was before the correction, and the character typed
        // next would land at the end instead of the beginning.
        const box = await page.evaluate(() => {
          const r = window.__ed.getBoundingClientRect();
          return { x: r.left + 2, y: r.top + 10 };
        });
        await page.mouse.click(box.x, box.y);
      } else {
        await page.keyboard.press(k.length === 1 ? `Key${k.toUpperCase()}` : k);
      }
      await sleep(12);
    }
    const w = await pending;
    await sleep(500);
    return { w, final: await text(page) };
  }

  // The clipboard has to be granted before it can be written, and the grant is
  // per-origin. A failure here SKIPS the paste case out loud rather than
  // scoring it, because a paste that never reached the page would otherwise
  // read as a paste the guard handled perfectly.
  //
  // The async clipboard API is refused in headless even with the permission
  // granted ("Write permission denied"), so the clipboard is loaded the old
  // way: put the text in the editor, select it, and copy it with execCommand,
  // which is a real copy from a real selection. The editor is cleared again
  // before any trial runs.
  let clipboardOk = false;
  try {
    await browser.defaultBrowserContext().overridePermissions("https://www.slatejs.org",
      ["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("PASTED"));
    clipboardOk = true;
  } catch {
    try {
      await clearEditor(page);
      await page.keyboard.type("PASTED", { delay: 30 });
      await sleep(200);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await sleep(80);
      const copied = await page.evaluate(() => document.execCommand("copy"));
      await clearEditor(page);
      clipboardOk = !!copied;
      if (!copied) console.error("  execCommand('copy') returned false; paste case SKIPPED");
    } catch (e2) {
      console.error(`  clipboard unavailable, paste case SKIPPED: ${e2.message}`);
    }
  }

  console.log(`\n[5] Actions inside the window (at +${AT_MS}ms)\n`);

  // --- [5b] The failure paths, driven through applySentenceWrite -----------
  //
  // ON ITS OWN PAGE, and that is not tidiness. The forced-misplaced stub writes
  // `el.textContent = ...`, which replaces every child of a live Slate editor
  // with one text node -- the DOM and the model are irreconcilable afterwards
  // and every later trial in that page inherits a broken editor. Sharing a page
  // with the cases above turned all eight of them red at once, with the
  // dirty-branch signature, and the cause was the harness rather than anything
  // measured. A destructive stub gets its own session.
  //
  // Every case above calls the splice directly, so the caret gating on the
  // `ignored` and `misplaced` exits -- which lives in the CALLER -- was never
  // measured. A hostile editor supplies each failure on demand: the guard's
  // contract is "the editor did something other than what we asked", so the
  // stub is that editor rather than a fake Slate.
  async function failureTrial(mode) {
    await clearEditor(failPage);
    await typeJittered(failPage, TYPO + TAIL);
    await sleep(400);
    return failPage.evaluate(async (a) => {
      const P = window.__prooferSentence, el = window.__ed;
      const before = P.snText(el);
      const h = (e) => {
        if (e.isTrusted || !e.data || e.inputType !== "insertReplacementText") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (a.mode === "misplaced") el.textContent = el.textContent + e.data;
        // "ignored" does nothing at all beyond swallowing the event.
      };
      document.addEventListener("beforeinput", h, true);
      // A real click BEFORE the write, so there is a user selection that the
      // failure path must not clobber.
      const cr = P.snCollapsedRange(el, 5);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(cr);
      let res;
      try {
        res = await P.applySentenceWrite(
          { el, start: 0, end: a.end, sentence: before.slice(0, a.end), id: "sn_probe_" + a.mode },
          a.rep, "sentence-applied");
      } catch (e) {
        res = { threw: String(e && e.message || e) };
      } finally {
        document.removeEventListener("beforeinput", h, true);
      }
      await new Promise((r) => setTimeout(r, 200));
      return { res, after: P.snText(el), caret: P.snCaret(el).start, before };
    }, { mode, end: TYPO.length, rep: FIXED });
  }

  const failSess = await slateSession();
  const failPage = failSess.page;
  for (const mode of ["ignored", "misplaced"]) {
    let ok = 0;
    const notes = [];
    for (let i = 0; i < TRIALS; i++) {
      let r;
      try { r = await failureTrial(mode); }
      catch (e) { notes.push(`threw ${e.message}`); continue; }
      // `ignored` must leave the document byte-identical. `misplaced` has
      // already mutated by definition, so what is asserted there is that the
      // ORIGINAL sentence is still present -- no rollback, no second write.
      const clean = mode === "ignored"
        ? r.after === r.before
        : r.after.startsWith(TYPO);
      if (clean) ok++;
      else notes.push(`t${i} ` + JSON.stringify(r.after).slice(0, 90));
    }
    table5.push({ arm: "prod", case: "forced-" + mode, asked: ok, trials: TRIALS });
    console.log(`    prod ${("forced-" + mode).padEnd(16)} field intact ${ok}/${TRIALS}`);
    printNotes(notes, 2, "         ");
  }
  await failPage.close();
  console.log("");
  for (const arm of ARMS) {
    for (const kase of CASES) {
      if (kase.needsClipboard && !clipboardOk) {
        console.log(`    ${arm.padEnd(4)} ${kase.name.padEnd(16)} SKIPPED (no clipboard)`);
        continue;
      }
      let asked = 0;
      const notes = [];
      for (let i = 0; i < TRIALS; i++) {
        let r;
        try { r = await keyTrial(arm, kase); }
        catch (e) { notes.push(`threw ${e.message}`); continue; }
        if (kase.safeOnly) {
          // The correction must be whole, and the buffered character must not
          // have been inserted inside it.
          const inCorrection = r.final.slice(0, FIXED.length) !== FIXED;
          if (!inCorrection) asked++;
          else notes.push(`t${i} character landed in the correction: ${JSON.stringify(r.final)}`);
        } else if (r.final === kase.want) asked++;
        else notes.push(`t${i} got ${JSON.stringify(r.final)}`);
      }
      const bad = asked < TRIALS ? "   <-- USER ACTION LOST" : "";
      table5.push({ arm, case: kase.name, asked, trials: TRIALS });
      console.log(`    ${arm.padEnd(4)} ${kase.name.padEnd(16)} as asked ${asked}/${TRIALS}${bad}`);
      printNotes(notes, 2, "         ");
    }
    console.log("");
  }
  writeArtifact("phase5", table5);
  await page.close();
}

await browser.close();
