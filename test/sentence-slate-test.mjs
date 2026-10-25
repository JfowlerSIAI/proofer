#!/usr/bin/env node
/**
 * The write, against REAL Slate.
 *
 *   cd test && node sentence-slate-test.mjs                 # captured Slate, offline
 *   cd test && PROOFER_SLATE_LIVE=1 node sentence-slate-test.mjs   # slatejs.org
 *
 * This is the only suite that can answer the question that matters for Discord.
 * Everything else in the sentence-mode suites uses a Slate-SHAPED DOM, which is
 * worth having -- it catches offset and adapter bugs -- but is structurally
 * incapable of catching the failure this suite exists for.
 *
 * The failure: writing to a rich editor is two problems, and only one is
 * visible. Put the right characters in the DOM, and get the editor's own MODEL
 * to agree. A same-tick `execCommand` splice does the first and not the second.
 * The correction appears, looks perfect, and survives every check we have --
 * `sentenceWriteLanded` at 0, 150 and 600ms all pass, because for those 600ms
 * the DOM really is correct. Then the user types one more character, Slate
 * re-renders from a model that never saw the edit, and:
 *
 *     typed:    "The techncian arrived early. Then we shipped"
 *     spliced:  "The technician arrived early. Then we shipped"     <- 1.4s of this
 *     +" it":   "Tthe techncian arrived early. Then we shipped "    <- typo back,
 *                                                                      keystrokes at offset 1
 *
 * A fixture cannot produce that, because a fixture has no model to disagree.
 *
 * WHICH IS WHY THE DEFAULT IS A CAPTURE, NOT A FIXTURE. `test/fixtures/slatejs.org`
 * is the slatejs.org rich-text example with its real bundle -- the same
 * JavaScript, byte for byte, served from a local http server at its original
 * path. There is a real Slate model behind it, so case [2] below still fails
 * the way real Slate fails; that assertion passing offline is the proof that
 * this is a capture and not a look-alike. Preserve this accepting capture.
 * `slatejs.org-2026-10-09` is the second real build, rejecting untrusted input;
 * [19–21] gate safe refusal, and [22] gates a rejected Escape after an apply.
 * Capture it with `node fixtures/capture.mjs slate-current`; both headers carry
 * provenance. `--untrusted-only` runs [19–22] for mutant replay (not the full gate).
 *
 * For most of this suite's life the only mode was the live site, and a network
 * outage meant the only suite that can catch a DOM/model divergence did not run
 * -- first reporting that as exit 0 (indistinguishable from a pass), later as
 * exit 77. Neither is a gate. The gate is now offline and unconditional; the
 * live canary observes cancellation and runs the landing or safe-refusal contract.
 * The default gate always runs both captures, including every old success case.
 *
 *   PROOFER_SLATE_LIVE=1      run against slatejs.org instead of the capture
 *   PROOFER_SLATE_URL=<url>   run against some other URL (implies live)
 *   PROOFER_SLATE_OPTIONAL=1  LIVE ONLY: an unreachable site exits 0 rather
 *                             than 77. It has no meaning in fixture mode --
 *                             there is nothing to be unreachable, and a missing
 *                             capture is a hard failure with a fix attached.
 *   PROOFER_CHROME=<path>     see lib/chrome.mjs
 *   PROOFER_CONTENT=<path>    run against a DIFFERENT content.js -- a proposed
 *                             variant of the write, or a checked-out "before".
 *                             Announced in the banner and the final line, so a
 *                             variant run can never be read as a shipping one.
 *   PROOFER_SEED=<n>          replay [4]'s exact typing rhythm. Every run prints
 *                             its own seed, so an intermittent red is handed on
 *                             as a command rather than as a description.
 *
 * Exit codes: 0 pass, 1 assertion failed (or a broken/missing capture, or a
 * live page that loaded without a Slate editor -- someone must re-point it),
 * 77 live site unreachable.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { resolveChrome } from "./lib/chrome.mjs";
import { serveFixture } from "./lib/fixture-server.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.join(HERE, "..");
// Which content.js is under test. Almost always the one that ships -- but a
// proposed change to the write is exactly the thing this suite exists to judge,
// and describing a variant's behaviour in prose is how a design argument gets
// settled by whoever writes the most confident paragraph. Pointing the gate at
// a variant keeps the "before" (or the "instead") EXECUTABLE. [11] is the case
// this matters most for: a `never cancel` variant of the mid-window design
// corrupts 4/4 where the shipping one is a no-op, and that is a measurement
// rather than an opinion only because both can be run.
//
// Loud, not silent: a run against a variant announces itself in the banner and
// in the final line. A suite that quietly tests something other than what ships
// is a green that proves nothing, which is the failure this whole file is built
// against.
const CONTENT_PATH = process.env.PROOFER_CONTENT
  ? path.resolve(process.env.PROOFER_CONTENT)
  : path.join(EXT, "content.js");
if (!fs.existsSync(CONTENT_PATH)) {
  console.log(`\nFAIL: PROOFER_CONTENT is set to ${CONTENT_PATH}, which does not exist.`);
  process.exit(1);
}
const VARIANT = CONTENT_PATH !== path.join(EXT, "content.js");
const CONTENT = fs.readFileSync(CONTENT_PATH, "utf8");

// [4] jitters its typing on purpose -- a fixed cadence resonates, and the phase
// of a keystroke against the write is the whole phenomenon. The cost of random
// timing is an intermittent failure nobody can reproduce, which is the hardest
// kind to hand to whoever owns the code. So the stream is SEEDED and the seed is
// printed on every run, failing or not: any red names the seed that produced it,
// and PROOFER_SEED replays exactly that typing. Randomness for coverage,
// determinism for the bug report.
const SEED = process.env.PROOFER_SEED ? Number(process.env.PROOFER_SEED) >>> 0
                                      : (Math.random() * 2 ** 32) >>> 0;
let randState = SEED;
const rand = () => {
  randState = (randState + 0x6D2B79F5) >>> 0;
  let t = randState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Printed HERE, before anything that can exit. It used to be in the run banner,
// which is after the capture check, the live-outage exit and the browser
// launch -- so precisely the runs that ended early were the ones that never
// said which typing they would have used. A seed you only get on success is not
// a reproduction aid.
console.log(`\n[seed ${SEED}]  PROOFER_SEED=${SEED} replays this run's [4] typing exactly`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXIT_SKIPPED = 77;

const LIVE = process.env.PROOFER_SLATE_LIVE === "1" || !!process.env.PROOFER_SLATE_URL;
const LIVE_URL = process.env.PROOFER_SLATE_URL || "https://www.slatejs.org/examples/richtext";
const FIXTURE_DIR = path.join(HERE, "fixtures", "slatejs.org");
const FIXTURE_ENTRY = "/examples/richtext";
const CURRENT_FIXTURE_DIR = path.join(HERE, "fixtures", "slatejs.org-2026-10-09");
const UNTRUSTED_ONLY = process.argv.includes("--untrusted-only");

let pass = 0, fail = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  cond ? pass++ : fail++;
};

const TYPED = "The techncian arrived early. Then we shipped";
const FIXED = "The technician arrived early.";
// The hostile-editor cases hold the SAME text the real editor is typed with, so
// the span [0, SPAN) means the same thing in every case in this file and a
// number read off one case is safe to read off another. Named separately
// because what it is doing there is different: this is the text a fake editor
// is handed, not the text a user typed.
const HOSTILE = TYPED;
const SPAN = "The techncian arrived early.".length;    // 28

// The capture is served before the browser starts, so a missing or broken one
// is reported as itself rather than as a page that would not load.
let server = null;
let currentServer = null;
if (!LIVE) {
  try {
    server = await serveFixture(FIXTURE_DIR);
    currentServer = await serveFixture(CURRENT_FIXTURE_DIR);
  } catch (e) {
    console.log(`\nFAIL: ${e.message}`);
    console.log("    cd test && node fixtures/capture.mjs slate");
    console.log("  This is the deterministic gate -- it does not skip.");
    process.exit(1);
  }
}
const URL_ = LIVE ? LIVE_URL : server.url(FIXTURE_ENTRY);

const chrome = await resolveChrome();
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chrome.path,
  args: [
    // Only captured fixtures run as namespace-root in the offline CI gate.
    ...(LIVE ? [] : ["--no-sandbox", "--disable-setuid-sandbox"]), "--disable-gpu",
    // One of three independent layers, and worth being exact about what each
    // one is -- an earlier version of this comment claimed an absolute
    // guarantee that the code did not give, which is the same defect as a
    // comment describing an assertion that cannot fail:
    //
    //   1. this resolver rule    every hostname but 127.0.0.1 fails to
    //                            RESOLVE. Not a socket boundary: an IP
    //                            literal, a proxy, or anything that does not
    //                            go through the host resolver is unaffected.
    //   2. the CSP in the capture  the page may not fetch off-origin at all.
    //                            Enforced by the browser, page-scoped.
    //   3. request interception  installed on EVERY page this suite opens
    //                            (`monitoredPage`), aborting and RECORDING
    //                            anything that is not the loopback origin.
    //                            This is the layer that can say what happened;
    //                            [0] asserts it saw nothing.
    //
    // Together that is strong enough to run on an aeroplane and to notice if it
    // ever stops being true. It is not a sandbox, and nothing here claims to be.
    ...(LIVE ? [] : ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']),
  ],
});

// Every request this suite's pages make, and every one that was refused.
// Installed on EVERY page, not just the probe: interception is per-page in
// Puppeteer, so a single monitored page proves nothing about the four others,
// and the offline claim is about the run rather than about one navigation.
const offsite = [];
const ALLOWED_SCHEMES = new Set(["data:", "blob:", "about:", "chrome-extension:"]);
function sameOrigin(u) {
  // An ORIGIN comparison, not a prefix test. `startsWith(server.origin)` says
  // yes to `http://127.0.0.1:8080.evil.test/` -- the port boundary is not a
  // character boundary, and a prefix check cannot see that.
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (ALLOWED_SCHEMES.has(parsed.protocol)) return true;
  return [server, currentServer].some((s) => s && parsed.origin === s.origin);
}
/** A page that cannot reach the network without saying so. */
async function monitoredPage() {
  const page = await browser.newPage();
  if (!LIVE) {
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (sameOrigin(r.url())) return r.continue().catch(() => {});
      offsite.push(r.url());
      r.abort().catch(() => {});
    });
  }
  return page;
}

/** A page with a real Slate editor holding exactly TYPED, typed by hand. */
async function slatePage(url = URL_) {
  const page = await monitoredPage();
  await page.evaluateOnNewDocument(`window.chrome = {
    runtime: { id: "test-ext", lastError: undefined, onMessage: { addListener() {} },
      sendMessage: (m, cb) => setTimeout(() => cb({ ok: true, noChanges: true }), 10) },
    storage: { local: { get: (d, cb) => cb({ ...d }), set: (o, cb) => cb && cb() },
               onChanged: { addListener: () => {} } } };`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1500);
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-slate-editor="true"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 20 };
  });
  if (!box) throw new Error("no Slate editor on the page");
  await page.mouse.click(box.x, box.y);
  await sleep(200);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await sleep(400);
  await page.keyboard.type(TYPED, { delay: 25 });
  await sleep(400);
  await page.evaluate(CONTENT);
  await sleep(200);
  return page;
}

/**
 * A page with the right ATTRIBUTES and no editor behind them, so the case
 * supplies one.
 *
 * [10], [13] and [14] each state a contract about what the extension does when
 * an editor does something other than what it was asked, and no real editor can
 * be made to do those things on demand. A hostile editor states the contract
 * directly, which is the honest way to test it: the contract is not "Slate
 * misbehaved", it is "the editor did something other than what we asked".
 *
 * One function rather than three copies of the setup. The chrome stub and the
 * content.js evaluation are the whole environment these cases share, and cases
 * that are meant to differ only in what the editor does must not also differ in
 * how the extension was loaded.
 *
 * MODULE STATE IS PER PAGE, and that is load-bearing rather than incidental:
 * `sentenceDemotedFamilies` lives for the life of the injection, so an arm that
 * demotes Slate poisons every later arm in the same page. Each arm gets its own.
 */
async function hostilePage(body) {
  const page = await monitoredPage();
  await page.setContent(`<!doctype html><html lang="en"><body>${body}</body></html>`);
  // Messages are RECORDED, not just answered. What content.js reports about a
  // write is half of what a write is -- a correction the log never hears about
  // is the defect `sentence-skipped:` exists for -- and until this array was
  // here no case in this file could see a verdict at all.
  await page.evaluate(`window.__sent = []; window.__storageListeners = [];
    window.chrome = { runtime: { id:"t", lastError: undefined,
      onMessage: { addListener: (f) => { window.__statusListener = f; } },
      sendMessage: (m, cb) => { window.__sent.push(m);
        setTimeout(() => cb({ ok:true, noChanges:true }), 10); } },
    storage: { local: { get:(d,cb)=>cb({...d}), set:(o,cb)=>cb&&cb() },
      onChanged:{ addListener(f){ window.__storageListeners.push(f); } } } };`);
  await page.evaluate(CONTENT);
  return page;
}

const text = (page) => page.evaluate(() =>
  document.querySelector('[data-slate-editor="true"]').textContent);

// The probe answers one question -- is the page there -- and must not answer
// any other. Opening it is a BROWSER failure and belongs outside the catch:
// swallowing it here would report a broken Chrome as a network outage and send
// whoever reads it to debug their connection. (Same shape as the FAB reporting
// a dead extension context as "Ollama unreachable".)
const probe = await monitoredPage();
let unreachable = null;
try {
  await probe.goto(URL_, { waitUntil: "domcontentloaded", timeout: 30000 });
} catch (e) {
  const msg = e.message.split("\n")[0];
  // "Could not open the page" is not the same claim as "the site is down", and
  // only the second earns a 77. A malformed PROOFER_SLATE_URL, a protocol
  // error, a crashed tab: those are this run's fault and must fail loudly
  // rather than exit as a tolerated outage -- which, with OPTIONAL=1, would be
  // exit 0 for a suite that never started. Chrome names genuine network
  // failures `net::...`; a navigation timeout is the other one worth tolerating.
  const networkish = /net::|ERR_|timeout/i.test(msg);
  if (!networkish) {
    console.log(`\nFAIL: could not open ${URL_} -- and this is not a network failure.`);
    console.log(`  ${msg}`);
    console.log("  A bad URL or a browser fault is this run's problem, not an outage.");
    await browser.close();
    if (server) await server.close();
    process.exit(1);
  }
  unreachable = msg;
}
if (unreachable) {
  if (!LIVE) {
    // Not a skip in any circumstance: the capture is on this disk.
    console.log(`\nFAIL: the captured page would not load (${unreachable}).`);
    console.log(`  Re-capture with: cd test && node fixtures/capture.mjs slate`);
    await browser.close();
    await server.close();
    process.exit(1);
  }
  const optional = process.env.PROOFER_SLATE_OPTIONAL === "1";
  console.log(`\nSKIP: ${URL_} unreachable (${unreachable})`);
  console.log("  The LIVE Slate check was not run. The offline gate " +
              "(node sentence-slate-test.mjs, no env) is unaffected and still gates.");
  console.log("  " + (optional ? "PROOFER_SLATE_OPTIONAL=1, so exiting 0."
                                : `Exiting ${EXIT_SKIPPED} (skipped, not passed).`));
  await browser.close();
  process.exit(optional ? 0 : EXIT_SKIPPED);
}
// Reachable but no editor is not a skip. The selector is this suite's contract
// with the page; if the site moved, someone has to re-point it, and a quiet 77
// would let that sit unnoticed for as long as the outage excuse held.
// Waited for, not sampled: the editor is client-rendered and does not exist at
// domcontentloaded.
const hasEditor = await probe
  .waitForSelector('[data-slate-editor="true"]', { timeout: 20000 })
  .then(() => true, () => false);

console.log(`\nThe write, against real Slate (${LIVE ? "LIVE" : "captured, offline"})\n` + "=".repeat(72));
console.log(`  ${URL_}`);
if (!LIVE) console.log(`  capture: ${path.relative(EXT, FIXTURE_DIR)}`);
console.log(`  Chrome: ${chrome.path} (${chrome.source})`);
if (VARIANT) console.log(`  content.js: ${CONTENT_PATH}   <-- NOT the shipping file`);
console.log("");

if (!hasEditor) {
  console.log(`FAIL: ${URL_} loaded but has no [data-slate-editor="true"].`);
  console.log(LIVE ? "  The example page moved or changed shape -- re-point the suite."
                   : "  The capture is broken or incomplete -- node fixtures/capture.mjs slate");
  await browser.close();
  if (server) await server.close();
  process.exit(1);
}

// --- [0] The capture boots with nothing but a loopback server --------------
//
// The claim this mode makes is that the gate runs on an aeroplane, and it is
// cheap to check rather than believe. Two ways it can be false and one way it
// cannot: an off-origin request (the capture missed an asset and the live site
// is quietly still doing the work) and a 404 from the fixture server (the
// capture missed an asset and the page is quietly running degraded). Neither
// shows up as a failed assertion later; both show up as a flake months from
// now. In live mode there is nothing here to measure.
//
// `offsite` is filled by `monitoredPage`, which is every page this suite opens
// -- so this is a statement about the run, not about one navigation. It is
// re-asserted at the end for the pages opened after this point.
if (!LIVE) {
  ok(offsite.length === 0,
     `no request left the loopback origin: ${JSON.stringify(offsite.slice(0, 4))}`);
  ok(server.misses.length === 0,
     `every path the page asked for was captured: ${JSON.stringify(server.misses.slice(0, 4))}`);
}
// Observe the site's behavior, independently of the production check. The live
// canary runs the applicable contract; the default ALWAYS keeps the old control.
const liveRejects = LIVE && await probe.evaluate(() => {
  const el = document.querySelector('[data-slate-editor="true"]');
  const node = el.querySelector('[data-slate-string]').firstChild;
  const range = new Range(); range.selectNodeContents(node);
  const e = new InputEvent("beforeinput", { inputType: "insertReplacementText",
    data: node.textContent, targetRanges: [new StaticRange(range)],
    bubbles: true, cancelable: true, composed: true });
  el.dispatchEvent(e);
  return !e.defaultPrevented;
});
await probe.close();

if (!UNTRUSTED_ONLY && !liveRejects) {
// --- [1] The shipping write survives the user typing on --------------------
{
  const page = await slatePage();
  ok((await text(page)) === TYPED, `typed into real Slate: ${JSON.stringify(await text(page))}`);

  const wrote = await page.evaluate(async (FIXED) => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const S = window.__prooferSentence;
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    return S.spliceSentenceSlate(el, start, start + "The techncian arrived early.".length, FIXED);
  }, FIXED);
  ok(wrote.ok === true && wrote.outcome === "landed",
     `spliceSentenceSlate reports success (${JSON.stringify(wrote)})`);

  await sleep(300);
  ok((await text(page)) === "The technician arrived early. Then we shipped",
     `the correction is in the DOM: ${JSON.stringify(await text(page))}`);

  // THE assertion. Everything above passed with the old execCommand splice too.
  await page.keyboard.type(" it", { delay: 40 });
  await sleep(300);
  const after = await text(page);
  ok(after === "The technician arrived early. Then we shipped it",
     `it survives the next keystrokes, at the right offset: ${JSON.stringify(after)}`);
  await page.close();
}

// --- [2] execCommand is what fails, and it fails exactly this way -----------
//
// Pinned deliberately. If a future Slate makes execCommand work, this test goes
// red and the extra 90ms of selection sync can be dropped -- that is worth
// knowing. It is not a test of our code; it is the evidence for the design.
//
// It is also what distinguishes a capture from a fixture -- and THAT is what
// this case has to assert, not merely "the text is not the ideal one".
//
// It used to close on `after !== "…Then we shipped it"`, which was too weak to
// do the job it was written for. A shaped contenteditable with no Slate behind
// it keeps the replacement and inserts the keys at the caret, giving
// "The technician arrived early. it Then we shipped" -- unequal to the ideal,
// so the old assertion PASSED on exactly the counterfactual it existed to rule
// out. An inequality accepts every wrong answer including the interesting one.
//
// So the signature is pinned exactly, and it has two halves that only a real
// model produces: the TYPO COMES BACK (`techncian`), and the typed keys SURVIVE
// at the offset Slate's re-render puts them. Measured, deterministic 3/3:
//
//     real Slate   "The techncian arrived early.  itThen we shipped"
//     shaped DOM   "The technician arrived early. it Then we shipped"
//
// The caret is restored to the correction end before typing so the shaped-DOM
// counterfactual is well defined rather than incidental -- otherwise the two
// arms differ in where the keys go for a reason that has nothing to do with
// model reversion.
//
// The second arm runs that counterfactual for real, every time. A negative
// control quoted in a comment decays; one that executes cannot.
{
  const execCommandSplice = async (page) => {
    await page.evaluate(async (FIXED) => {
      const el = document.querySelector('[data-slate-editor="true"]');
      const S = window.__prooferSentence;
      const t = S.snText(el);
      const start = t.indexOf("The techncian");
      const range = S.rangeForInnerTextOffset(el, start, "The techncian arrived early.".length);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, FIXED);
      // Caret to the correction end, explicitly. Both arms then type from the
      // same place and the only variable left is whether an editor model exists.
      await new Promise((r) => setTimeout(r, 50));
      const c = S.snCollapsedRange(el, start + FIXED.length);
      if (c) { const s2 = getSelection(); s2.removeAllRanges(); s2.addRange(c); }
    }, FIXED);
    await sleep(300);
    const mid = await text(page);
    await page.keyboard.type(" it", { delay: 40 });
    await sleep(400);
    return { mid, after: await text(page) };
  };

  const REVERTED = "The techncian arrived early.  itThen we shipped";
  const NO_MODEL = "The technician arrived early. it Then we shipped";

  const page = await slatePage();
  const real = await execCommandSplice(page);
  await page.close();
  ok(real.mid === "The technician arrived early. Then we shipped",
     "execCommand also puts the right characters in the DOM");
  ok(real.after === REVERTED,
     `...and Slate reverts it on the next keystroke -- typo back, keys surviving: `
     + `${JSON.stringify(real.after)}`);

  // THE CONTROL. Same script, same keys, no Slate: a shaped contenteditable
  // carrying the attribute and nothing else. If this ever produces REVERTED,
  // the assertion above is not measuring model reversion and this whole case is
  // decorative.
  const shaped = await monitoredPage();
  await shaped.setContent(`<!doctype html><html lang="en"><body>
    <div id="fake" contenteditable="true" data-slate-editor="true"
         style="width:400px;min-height:40px"></div></body></html>`);
  await shaped.evaluate(`window.chrome = { runtime: { id:"t", lastError: undefined, onMessage: { addListener() {} },
      sendMessage: (m, cb) => setTimeout(() => cb({ ok:true, noChanges:true }), 10) },
    storage: { local: { get:(d,cb)=>cb({...d}), set:(o,cb)=>cb&&cb() }, onChanged:{ addListener(){} } } };`);
  await shaped.evaluate(CONTENT);
  await shaped.evaluate((TYPED) => {
    const el = document.querySelector("#fake");
    el.textContent = TYPED;
    el.focus();
  }, TYPED);
  const fake = await execCommandSplice(shaped);
  await shaped.close();
  ok(fake.after !== REVERTED && fake.after === NO_MODEL,
     `and a Slate-SHAPED DOM cannot produce that signature -- it keeps the `
     + `correction, so the assertion above can go red: ${JSON.stringify(fake.after)}`);
}

// --- [3] A keystroke mid-write costs nothing: not the correction, not the key
//
// This case used to assert the opposite, and the opposite was correct for the
// recipe it was written against. That recipe SELECTED the sentence, waited
// ~30ms for Slate to read the selection into `editor.selection`, and only then
// dispatched -- so for those 30ms the sentence sat selected, a keystroke there
// would have REPLACED it, and the only safe answer was to cancel the keystroke
// and back the write out with `refused-precondition` / `aborted`. The sentence
// survived and the correction was lost.
//
// The intent recipe (2026-08-14) carries the span ON the event as
// `targetRanges` and lets slate-react call `Transforms.select` itself, so
// nothing is selected in advance and everything from reading the text to the
// dispatch is synchronous. The window is gone, and `aborted` is no longer a
// reason this function can return -- the branch is deleted, not quiet. So the
// assertion inverts: the write should LAND, and the keystroke should still be
// there afterwards. (Owner of that change measured 12/12 exact mid-burst on the
// new recipe against 8/12 with 4 `aborted` on the old.)
//
// The keystroke is checked by typing ON, not by reading the DOM straight after:
// [5] establishes that the replay is honoured by Slate's model but not RENDERED
// until the next input event, so a DOM read here would score a working replay
// as a lost character. `q` is the flush.
{
  const page = await slatePage();
  const wrotePromise = page.evaluate(async (FIXED) => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const S = window.__prooferSentence;
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    return S.spliceSentenceSlate(el, start, start + "The techncian arrived early.".length, FIXED);
  }, FIXED);
  await sleep(10);                       // mid-write, where the window used to be
  // A LOWERCASE letter, not the "X" this used to type. Both are one character
  // and slate-react's fast path tests /[a-z ]/i, so the two were the same code
  // path -- but only by the `i` flag, and the case that path was written for is
  // the lowercase one. A test of a documented condition should not depend on a
  // flag in the condition it is testing.
  await page.keyboard.type("z");
  const wrote = await wrotePromise;
  ok(wrote.ok === true && wrote.outcome === "landed",
     `a keystroke mid-write no longer costs the correction (${JSON.stringify(wrote)})`);
  await page.keyboard.type("q", { delay: 40 });
  await sleep(300);
  const after = await text(page);
  ok(after === "The technician arrived early. Then we shippedzq",
     `...and the keystroke is still there, in order: ${JSON.stringify(after)}`);
  await page.close();
}

// --- [8] The swallowed character is a SPACE -------------------------------
//
// The same pipeline as [3] and one character different, because that character
// is the one with a history. A lost space is what produced the failure this
// path was rebuilt around:
//
//     "The technician arrived early.We recieved the invoice yesterday."
//                                  ^ the space the user typed
//
// and a space is the other half of slate-react's `/[a-z ]/i` fast path -- the
// half that is easy to forget, since every hand-written test types letters.
// [5] measures the transport in isolation; this measures it where it is used,
// with a real keystroke swallowed by `bail` and given back by `replaySwallowed`.
// A space is also the one swallowed character whose loss is nearly invisible on
// screen while being a word-boundary error in the text, which is exactly the
// kind of damage this suite exists to refuse.
{
  const page = await slatePage();
  const wrotePromise = page.evaluate(async (FIXED) => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const S = window.__prooferSentence;
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    return S.spliceSentenceSlate(el, start, start + "The techncian arrived early.".length, FIXED);
  }, FIXED);
  await sleep(10);
  await page.keyboard.type(" ");
  const wrote = await wrotePromise;
  ok(wrote.ok === true && wrote.outcome === "landed",
     `the write lands with a space swallowed (${JSON.stringify(wrote)})`);
  await page.keyboard.type("it", { delay: 40 });
  await sleep(300);
  const after = await text(page);
  ok(after === "The technician arrived early. Then we shipped it",
     `...and the space came back, so the words did not run together: ${JSON.stringify(after)}`);
  await page.close();
}

// --- [4] Typing through corrections never loses a character ---------------
//
// [3] proves the write backs out. It does not prove the USER keeps what they
// typed, and for most of this path's life they did not. `bail` has to swallow
// the keystroke -- preventDefault alone lets Slate act on it, see [3] -- and
// swallowing on its own is deletion. Measured over the whole pipeline before
// the replay existed, four of six runs lost characters:
//
//     typed "We recieved the invoice yesterday."
//     left  "e recieved the invoice yesterday."      the abort window
//     and   "...arrived early.We recieved..."        the POST-WRITE window
//
// Two separate holes, and then a third once they were plugged: detaching the
// handler before waiting for the sync let the next keystroke overtake the
// replay, giving "eW recieved". Order matters as much as presence.
//
// This drives the real pipeline rather than calling the splice, because the
// windows are only a few tens of milliseconds wide and their phase against the
// user's typing is the whole phenomenon -- a hand-timed keystroke tests one
// arbitrary point in it. Every sentence must come out as either exactly what
// was typed or exactly its correction. Anything else is a character the user
// lost.
{
  const SENTS = ["The techncian arrived early.", "We recieved the invoice yesterday.",
                 "The meeting was moved to thursday."];
  const FIXES = { [SENTS[0]]: "The technician arrived early.",
                  [SENTS[1]]: "We received the invoice yesterday.",
                  [SENTS[2]]: "The meeting was moved to Thursday." };
  const OK = new Set([...SENTS, ...Object.values(FIXES)]);
  const MSG = SENTS.join(" ");

  let corrupted = [], landed = 0;
  for (let trial = 0; trial < 2; trial++) {
    const page = await monitoredPage();
    await page.evaluateOnNewDocument(`window.__FIX = ${JSON.stringify(FIXES)};
      window.chrome = { runtime: { id:"t", lastError: undefined, onMessage: { addListener() {} }, sendMessage: (m, cb) => setTimeout(() => {
          if (m.type === "SENTENCE_CONSENT") return cb({ ok:true, allowed:true, apply:true });
          if (m.type === "SENTENCE_REWRITE") { const f = window.__FIX[m.sentence];
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
    // content.js loads settings on FOCUSIN. Injecting into an already-focused
    // field means that event never comes and sentence mode never starts -- it
    // sends no messages at all, which looks exactly like the feature being off.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await sleep(150);
    await page.evaluate(CONTENT);
    await sleep(250);
    await page.mouse.click(box.x, box.y); await sleep(600);

    // SEED 1608963965 IS THE ONE TO REACH FOR. It is a rhythm that caught a
    // real character-loss regression: a caret fix removed the original-caret
    // alias from the live gate correctly and from the success-path REPLAY too,
    // where it is needed, so legitimate replays were refused and the buffered
    // characters dropped. Random runs saw it 3 times in 4 and reported a
    // frequency; this seed held the phase fixed and turned it into a pair --
    // 3/3 red on the broken build, 3/3 green on the fix, same typing. Worth
    // running against any change to the swallow/replay path:
    //
    //     PROOFER_SEED=1608963965 node sentence-slate-test.mjs
    //
    // It is a spot check and not a substitute for the random ones: the value of
    // this case is that it samples phases nobody chose, and a seed that has
    // already been fixed samples exactly one.
    //
    // Jittered, because a fixed cadence resonates: at one spacing the write
    // lands on a keystroke every single time and at the next it never does.
    const jitter = (base) => Math.round(base * (0.55 + rand() * 0.9));
    for (const ch of MSG) {
      await page.keyboard.type(ch);
      await sleep(jitter(ch === "." ? 700 : ch === " " ? 260 : 110));
    }
    await sleep(2500);
    const out = await page.evaluate(() =>
      document.querySelector('[data-slate-editor="true"]').textContent);
    await page.close();

    const parts = out.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);
    corrupted.push(...parts.filter((x) => !OK.has(x)));
    landed += parts.filter((x) => Object.values(FIXES).includes(x)).length;
  }
  ok(corrupted.length === 0,
     `no character was lost or reordered over 2 runs: ${JSON.stringify(corrupted)}`);
  // Not a threshold to tune here -- just evidence the pipeline is alive. If this
  // is 0 the run above proved nothing.
  ok(landed > 0, `corrections actually landed while typing (${landed}/6)`);
}

// --- [9] A Backspace mid-write is YIELDED to, and lands where the user is --
//
// ON THE CLEAN BRANCH, `bail` swallows what it can replay and YIELDS everything
// else -- Backspace, Enter, arrows, Ctrl+*, paste, mousedown -- letting the
// event through, ending the window, and skipping the caret restore. The branch
// qualifier is load-bearing and this comment did without it for a while: on the
// DIRTY branch the same unreplayable action is CANCELLED instead, because the
// caret is not provably the user's there. [11] is that case. This one types
// normally, so it is always clean-branch, which is why it passes and should
// keep passing.
//
// Skipping the restore is the part worth a test: the write has just moved the
// caret to the end of the span it replaced, so a Backspace arriving in that
// moment could plausibly delete a character out of the MIDDLE of the sentence
// just corrected, silently, while the write still reports success.
//
// It does not. Measured, deterministic across trials: the deletion lands at the
// user's own caret (the last character they typed), the correction still lands,
// and the write reports `landed`. Enter and ArrowLeft behave as themselves.
//
// The assertion is on the TEXT and not on the outcome, because the outcome is
// the half that was already true when this path was broken -- a yield that
// deleted the wrong character would still return `landed`.
{
  const page = await slatePage();
  const wrotePromise = page.evaluate(async (FIXED) => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const S = window.__prooferSentence;
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    return S.spliceSentenceSlate(el, start, start + "The techncian arrived early.".length, FIXED);
  }, FIXED);
  await sleep(10);
  await page.keyboard.press("Backspace");
  const wrote = await wrotePromise;
  await sleep(400);
  const after = await text(page);
  ok(wrote.ok === true && wrote.outcome === "landed",
     `the correction survives a yielded Backspace (${JSON.stringify(wrote)})`);
  ok(after === "The technician arrived early. Then we shippe",
     `...and the deletion landed at the user's caret, not inside the correction: `
     + `${JSON.stringify(after)}`);
  await page.close();
}

// --- [11] The DIRTY branch: where the caret is not the user's -------------
//
// [9] measures a Backspace mid-write and finds it lands at the user's caret.
// That is the CLEAN branch, and it was the only branch either this suite or the
// probe was testing -- each of them exercising one half of a two-part failure
// that needs both halves at once.
//
// slate-react adopts `getTargetRanges()` only while its node map is clean, and
// it takes the rangeRef that restores the USER's caret inside that same block.
// So a selection change one task turn before the write (a click, a `.focus()`,
// anything that leaves a pending selection read for Slate's own handler to
// flush) puts it on the dirty path: the correction still lands -- the same-tick
// selection sees to that -- and the caret is left at the CORRECTION END instead
// of where the user was. Measured 29 against a user caret of 45. A Backspace
// passed through in that state eats a character of the sentence just corrected,
// silently, while the write still reports `landed`:
//
//     "The technician arrived early Then we shipped"
//                                 ^ the correction's own period, gone
//
// So an action that cannot be replayed and arrives before the caret is provably
// the user's is now CANCELLED. That is the familiar asymmetry: a cancelled
// Backspace is a keypress that did nothing and will be pressed again, a
// passed-through one is a character of the correction destroyed.
//
// The second arm is the one that keeps this honest. "Cancel the key" is only a
// fix if it is SCOPED -- a blanket version would read identically here and
// would mean Backspace silently stops working on Slate. So the same keypress is
// measured again after the guard detaches, and it must behave normally.
//
// THIS CASE IS CONTESTED, AND THE ARGUMENT AGAINST IT IS ALREADY MEASURED. A
// later proposal would have removed the cancellation on the principle that "a
// cancelled action is deleted user intent" -- which is a good principle and is
// the wrong trade here. Built as a faithful variant and run through this
// scenario:
//
//     what ships          Backspace @ +2/+10/+25ms    no-op, 0 corrupt
//     `never cancel`      Backspace @ +2/+10/+25ms    4/4 CORRUPT
//
// and CORRUPT is the exact string asserted below. Note what that implies about
// the assertion: a substring check ("does it still say technician") passes the
// corrupt variant, because only the period is gone. The whole string is the
// test. Re-run the comparison with PROOFER_CONTENT=<variant> rather than
// re-deriving it -- that is what the flag is for.
{
  const dirtySplice = (page) => page.evaluate(async (FIXED) => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const S = window.__prooferSentence;
    // The selection change, and then a task turn -- which is what leaves the
    // read PENDING for Slate's handler to flush, rather than already done.
    const r = S.snCollapsedRange(el, S.snText(el).length);
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    await new Promise((res) => setTimeout(res, 0));
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    return S.spliceSentenceSlate(el, start, start + "The techncian arrived early.".length, FIXED);
  }, FIXED);

  {
    const page = await slatePage();
    const wrotePromise = dirtySplice(page);
    await sleep(10);                     // inside the guarded window
    await page.keyboard.press("Backspace");
    const wrote = await wrotePromise;
    await sleep(400);
    const after = await text(page);
    // The correction's own period is the character that used to go, so the
    // whole string is asserted rather than "does it still say technician".
    ok(after === "The technician arrived early. Then we shipped",
       `a Backspace on the dirty path destroys nothing: ${JSON.stringify(after)}`);
    ok(wrote.ok === true && wrote.window && wrote.window.blocked === "key:Backspace",
       `...and the record says which action was cancelled, rather than losing it `
       + `(${JSON.stringify(wrote.window)})`);
    await page.close();
  }
  {
    // AWAITED, not slept on. This arm used to press the key at +150ms, chosen
    // when the cancel window was ~60ms -- and when the window's ceiling moved
    // to 160ms the arm went red, having tested nothing about the change: the
    // number was standing in for "after the guard detaches", which is a
    // mechanism this test can simply wait for. `detach()` runs in the splice's
    // own `finally`, so the promise resolving IS the guard being gone. No
    // constant here to drift against one in content.js.
    const page = await slatePage();
    const wrotePromise = dirtySplice(page);
    const wrote = await wrotePromise;
    await page.keyboard.press("Backspace");
    await sleep(400);
    const after = await text(page);
    ok(after === "The technician arrived early. Then we shippe",
       `...and once the guard is gone the same key works normally, so the `
       + `cancellation is scoped rather than "Backspace is broken on Slate": `
       + `${JSON.stringify(after)}`);
    ok(wrote.window === null,
       `...which the record shows as no guarded window at all (${JSON.stringify(wrote.window)})`);
    await page.close();
  }
}

// --- [12] Two splices at once on one element ------------------------------
//
// `splice-in-flight`. Reachable in the shipping code -- Escape during a
// correction starts the undo, which begins a second Slate splice, and the
// global keydown listener is registered before the splice's own guard, so the
// key is never swallowed. Two writes interleaved on one element is the one
// shape where every careful thing this function does about carets and windows
// is computed from a document the other one is moving.
//
// Asserted at the guard rather than through Escape: the pipeline route depends
// on winning a race by a margin the test would have to guess at, and a case
// that only sometimes reaches the code it names is worse than one that always
// does. The cost is that this pins the contract, not the reachability -- so the
// comment carries the reachability, which is where the argument for the guard
// lives.
//
// Through `spliceSentenceVia`, which is where the guard IS. Written first
// against `spliceSentenceSlate` -- the function this file names throughout --
// and it went red for the most misleading possible reason: the second call was
// not refused, because the recipe function does not own the guard and never
// sees it. Worth keeping in the record, because the failure was informative
// rather than wrong. The two writes really did interleave (the first splice's
// own record showed it cancelling the second's dispatch as
// `blocked: "input:insertReplacementText"`) and the second still returned
// `landed` having written nothing at all. Nothing ships that way -- the only
// caller of the recipe is the wrapper -- but a future direct caller would get a
// false success, and this is what that looks like.
{
  const page = await slatePage();
  const both = await page.evaluate(async (FIXED) => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const S = window.__prooferSentence;
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    const end = start + "The techncian arrived early.".length;
    // Started in the same tick, deliberately not awaited in between.
    const first = S.spliceSentenceVia(el, start, end, FIXED);
    const second = S.spliceSentenceVia(el, start, end, FIXED);
    return { first: await first, second: await second };
  }, FIXED);
  ok(both.second.ok === false && both.second.reason === "splice-in-flight",
     `the second splice is refused while the first is in flight `
     + `(${JSON.stringify(both.second)})`);
  ok(both.first.ok === true && both.first.outcome === "landed",
     `...and the first one still lands -- the guard refuses the newcomer, not the `
     + `work already in progress (${JSON.stringify(both.first)})`);
  ok((await text(page)) === "The technician arrived early. Then we shipped",
     `...leaving exactly one correction in the field: ${JSON.stringify(await text(page))}`);
  await page.close();
}

// --- [5] The replay transport: a COLLAPSED synthetic beforeinput -----------
//
// `replaySwallowed` gives a swallowed keystroke back through a synthetic
// `beforeinput` with the caret COLLAPSED, which is a different shape from the
// write's EXPANDED-range dispatch and had never been measured on its own. A
// weak observation once read it as `ignored`, which would have meant the replay
// does not work on the one editor it was built for -- every swallowed character
// deleted outright.
//
// It replicates, and it is not what it looks like. Measured here, 3 trials each:
//
//     transport                data   immediate   after the next keystroke
//     insertText               "Z"    0/3         3/3   <- both, in order
//     execCommand              "Z"    3/3         0/3   <- Z reverted
//     insertText               "z"    0/3         3/3   <- deferred, not dropped
//     insertReplacementText    "z"    3/3         3/3   <- what ships
//
// So Slate HONOURS the collapsed synthetic event and simply does not render it
// until the next input event arrives -- input-gated, not render-delayed (2.5s
// changes nothing). Polling the DOM after dispatching therefore reads a working
// transport as a broken one, which is exactly how the doubt arose.
//
// The bottom two rows are why the replay now dispatches `insertReplacementText`
// (2026-08-14). slate-react has a `native = true` fast path for `insertText`
// carrying ONE character matching /[a-z ]/i: it declines to `preventDefault`
// and queues its own insert behind the BROWSER performing the edit, which for
// an untrusted event never happens. Measured on that path, `defaultPrevented`
// is false 0/3 and the DOM does not move -- which reads as the character being
// destroyed. It is not: it is DEFERRED, and the next input flushes it, 3/3.
// The two readings differ in what they cost. "Dropped" would mean every
// mid-burst correction eats a letter, which [4] would have caught long ago;
// "deferred" costs the character only when the swallowed keystroke is the last
// thing the user types -- the residual noted at the bottom of this comment, and
// `insertReplacementText` removes it by landing at once.
//
// And the obvious "fix" is the actual bug: execCommand puts the character on
// screen immediately and Slate reverts it on the next keystroke, deleting the
// very character the replay exists to preserve. Same DOM/model divergence as
// [2], in miniature. Both arms are asserted, because the counter-case is the
// entire argument for keeping the transport that looks broken.
//
// That residual -- a swallowed keystroke that was the LAST thing the user
// typed staying invisible until they type again -- was real for as long as the
// replay went out as `insertText`, and is closed by the row above: the shipping
// transport lands immediately, so there is nothing left waiting on a flush.
// The first two rows are kept all the same. They are the evidence that a
// synthetic event reaches Slate's model at all, which is the fact the whole
// swallow/replay design rests on, and they are the counter-case that stops
// anyone "simplifying" the replay back to execCommand.
{
  const TRIALS = 3;
  const replay = async (how, data = "Z") => {
    let survived = 0, immediate = 0, sample = null;
    for (let i = 0; i < TRIALS; i++) {
      const page = await slatePage();
      const before = await text(page);
      await page.evaluate(async ({ how, data }) => {
        const el = document.querySelector('[data-slate-editor="true"]');
        const S = window.__prooferSentence;
        // Caret at the very end, collapsed -- exactly what restore() leaves
        // behind before the replay fires.
        const r = S.snCollapsedRange(el, S.snText(el).length);
        const sel = getSelection();
        sel.removeAllRanges(); sel.addRange(r);
        await new Promise((res) => setTimeout(res, 40));
        if (how === "execCommand") {
          document.execCommand("insertText", false, data);
        } else {
          el.dispatchEvent(new InputEvent("beforeinput", {
            inputType: how === "replacement" ? "insertReplacementText" : "insertText",
            data,
            bubbles: true, cancelable: true, composed: true,
          }));
        }
      }, { how, data });
      await sleep(400);
      if ((await text(page)) === before + data) immediate++;
      // THE assertion, the same one the rest of this file uses: type on, and
      // see what is actually in the field.
      await page.keyboard.type("q", { delay: 40 });
      await sleep(300);
      const after = await text(page);
      if (after === before + data + "q") survived++;
      if (i === 0) sample = after.slice(-14);
      await page.close();
    }
    return { survived, immediate, sample };
  };

  const syn = await replay("synthetic");
  ok(syn.survived === TRIALS,
     `the synthetic collapsed replay reaches Slate's model: ${syn.survived}/${TRIALS} `
     + `(${JSON.stringify(syn.sample)}) -- a red here means every swallowed character is deleted`);
  ok(syn.immediate === 0,
     `...and is NOT visible before the next input (${syn.immediate}/${TRIALS} immediate) `
     + `-- which is why polling the DOM reads this working transport as broken`);

  const cmd = await replay("execCommand");
  ok(cmd.immediate === TRIALS && cmd.survived === 0,
     `execCommand shows the character and Slate then eats it: `
     + `${cmd.immediate}/${TRIALS} immediate, ${cmd.survived}/${TRIALS} survive `
     + `(${JSON.stringify(cmd.sample)}) -- this is why the replay must NOT "just use execCommand"`);

  // The SINGLE-CHARACTER cells, which are the ones the shipping transport was
  // changed for -- and the reason to measure them rather than accept the
  // diagnosis is that "did not land" and "has not landed yet" are the same
  // observation taken at different moments, with very different consequences.
  // Both are asserted so that a future slate-react moving either way is
  // reported rather than absorbed.
  const synOne = await replay("synthetic", "z");
  ok(synOne.immediate === 0 && synOne.survived === TRIALS,
     `insertText DEFERS a lone character rather than dropping it: `
     + `${synOne.immediate}/${TRIALS} immediate, ${synOne.survived}/${TRIALS} after the next key `
     + `-- lost only if the user never types again`);

  const repOne = await replay("replacement", "z");
  ok(repOne.immediate === TRIALS && repOne.survived === TRIALS,
     `insertReplacementText lands it AT ONCE: ${repOne.immediate}/${TRIALS} immediate, `
     + `${repOne.survived}/${TRIALS} after the next key -- which is what closes that gap`);
}

// --- [6] The accepted-but-ignored exit gives the keystroke back -----------
//
// The fourth hole in the swallow/replay machinery, and the last one found: the
// abort path replays and the success path replays, and the exit in between --
// taken when the editor declines the write and the text is unchanged -- did
// `restore(); return false;`. Every character typed during that call was
// deleted outright.
//
// Asserted on the REPLAY BEING ISSUED rather than on the character appearing,
// because [5] just established that those are different things: the transport
// is honoured but not rendered until the next input, and this fixture has no
// model behind it: it cancels the event but never writes (accepted then ignored). What
// can be proven here is that the path calls the mechanism; [5] proves the
// mechanism reaches Slate.
{
  const page = await monitoredPage();
  await page.setContent(`<!doctype html><html lang="en"><body>
    <div id="fake" contenteditable="true" data-slate-editor="true"
         style="width:400px;min-height:40px"></div></body></html>`);
  await page.evaluate(`window.__replayed = [];
    window.chrome = { runtime: { id:"t", lastError: undefined, onMessage: { addListener() {} },
      sendMessage: (m, cb) => setTimeout(() => cb({ ok:true, noChanges:true }), 10) },
    storage: { local: { get:(d,cb)=>cb({...d}), set:(o,cb)=>cb&&cb() }, onChanged:{ addListener(){} } } };`);
  await page.evaluate(CONTENT);
  await page.evaluate(() => {
    const el = document.querySelector("#fake");
    el.textContent = "The techncian arrived early. Then we";
    // Bubble phase, so the capture-phase `bail` has already decided; it lets our
    // own dispatch through (`writing`), which is precisely the replay.
    // EVERY untrusted beforeinput, with its inputType, rather than the ones
    // carrying a chosen inputType. Filtering on `insertText` here was a probe
    // that silently stopped covering anything the day the replay was renamed
    // to `insertReplacementText` -- it recorded nothing, and "the keystroke was
    // dropped" is exactly what a dropped keystroke looks like. A probe must not
    // encode the answer it is checking for.
    el.addEventListener("beforeinput", (e) => {
      if (!e.isTrusted) { e.preventDefault(); window.__replayed.push({ inputType: e.inputType, data: e.data }); }
    });
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  const wrotePromise = page.evaluate(async () => {
    const S = window.__prooferSentence;
    const el = document.querySelector("#fake");
    return S.spliceSentenceSlate(el, 0, 28, "The technician arrived early.");
  });
  // Land a keystroke inside the call, after the selection window has passed --
  // it is swallowed by `bail` on the way to the exit that used to eat it.
  await sleep(45);
  await page.keyboard.type("X");
  const wrote = await wrotePromise;
  await sleep(250);
  const replayed = await page.evaluate(() => window.__replayed);
  const after = await page.evaluate(() => document.querySelector("#fake").textContent);
  ok(wrote.ok === false && wrote.outcome === "failed-transport" && wrote.reason === "ignored",
     `an editor that does not act is a transport failure (${JSON.stringify(wrote)})`);
  const replayOfX = replayed.filter((e) => e.data === "X");
  ok(replayOfX.length === 1,
     `the swallowed keystroke is replayed rather than dropped: ${JSON.stringify(replayed)}`);
  // The transport, pinned separately from the fact of the replay. slate-react
  // has a `native = true` fast path for `insertText` carrying a SINGLE
  // character matching /[a-z ]/i: it declines to preventDefault and queues its
  // own insert behind the BROWSER performing the edit, which for an untrusted
  // event never happens. So a one-character replay sent as `insertText` is the
  // one shape of this call that can go missing, and [5] measures what actually
  // becomes of it. Naming the event honestly is the whole fix, and it is a
  // choice a future edit could quietly undo.
  ok(replayOfX.length === 1 && replayOfX[0].inputType !== "insertText",
     `...and not as insertText, which slate-react's single-character fast path drops `
     + `(${JSON.stringify(replayOfX)})`);
  ok(after.includes("techncian arrived early."),
     `and the user's sentence is intact: ${JSON.stringify(after)}`);
  await page.close();
}

// --- [10] An editor that writes the right text in the WRONG PLACE ----------
//
// `misplaced` is a `failed-transport`: the editor acted, the text moved, and
// what came out is not the sentence replaced in place. It blocks the field and
// demotes the editor family, and there is deliberately no rollback -- so it is
// worth a test, and it cannot be provoked through real Slate at all. The
// same-tick selection closed the only known cause.
//
// A HOSTILE EDITOR states the guard's contract directly, which is the honest
// way to test it: the contract is not "Slate misbehaved", it is "the editor did
// something other than what we asked". Same family as [6], where a DOM with no
// model behind it cancels the transport but never writes, pinning `ignored`.
//
// Three arms, and the middle one is what makes this a test rather than a
// tautology -- without an editor that obeys, a guard hard-wired to return
// `misplaced` would pass every assertion here.
{
  const page = await hostilePage(`<div id="fake" contenteditable="true"
      data-slate-editor="true" style="width:400px;min-height:40px"></div>`);

  const arm = (mode) => page.evaluate(async ({ mode, HOSTILE, FIXED, SPAN }) => {
    const el = document.querySelector("#fake");
    if (window.__h) el.removeEventListener("beforeinput", window.__h);
    el.textContent = HOSTILE;
    let acted = false;
    window.__h = (e) => {
      // Our own write only: the replay carries the same inputType, and `acted`
      // keeps a second dispatch from being answered twice.
      if (e.isTrusted || e.inputType !== "insertReplacementText" || acted) return;
      acted = true;
      e.preventDefault();
      if (mode === "ignore") return;              // accepts transport, but never writes
      const node = el.firstChild;
      const r = e.getTargetRanges()[0];
      if ((mode === "obey" || mode === "normalize") && r && r.startContainer === node) {
        node.data = node.data.slice(0, r.startOffset) + e.data + node.data.slice(r.endOffset);
        // ...and then tidies something else, the way a custom Slate normalizer
        // rewriting whitespace or block wrappers would. AFTER the span, so the
        // span's own offsets still describe what we asked for.
        if (mode === "normalize") node.data = node.data + "!";
      } else if (mode === "append") {
        node.data = node.data + e.data;           // right text, wrong place
      }
    };
    el.addEventListener("beforeinput", window.__h);
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    const wrote = await window.__prooferSentence.spliceSentenceSlate(
      el, 0, SPAN, FIXED);
    return { wrote, after: el.textContent };
  }, { mode, HOSTILE, FIXED, SPAN });

  const obeyed = await arm("obey");
  ok(obeyed.wrote.ok === true && obeyed.wrote.outcome === "landed",
     `an editor that replaces the span it was given is accepted `
     + `(${JSON.stringify(obeyed.wrote)}) -- the control arm, without which this case `
     + `would pass for a guard that always refused`);

  const wrong = await arm("append");
  ok(wrong.wrote.ok === false && wrong.wrote.outcome === "failed-transport"
     && wrong.wrote.reason === "misplaced",
     `the right text in the wrong place is a transport failure (${JSON.stringify(wrong.wrote)})`);
  // The property that actually matters. `misplaced` blocks the field and does
  // not roll back, so the one thing that must be true afterwards is that the
  // user's own sentence was not eaten on the way.
  ok(wrong.after.startsWith("The techncian arrived early."),
     `...and the user's original sentence is untouched: ${JSON.stringify(wrong.after)}`);

  // The split. A full-text mismatch used to be one verdict, and `misplaced`
  // demotes the WHOLE editor family -- so an editor that honoured our span
  // exactly and then normalised something else in the document was withdrawn
  // for the session on the strength of doing nothing wrong. The span is the
  // discriminator: honoured means the correction is where we asked, whatever
  // else moved, and that blocks this element only.
  const tidied = await arm("normalize");
  ok(tidied.wrote.ok === false && tidied.wrote.reason === "normalized",
     `an editor that honours the span and tidies elsewhere is 'normalized', not `
     + `'misplaced' (${JSON.stringify(tidied.wrote)})`);
  ok(tidied.after.startsWith(FIXED),
     `...and the discriminator is real -- the correction IS where it was asked for: `
     + `${JSON.stringify(tidied.after)}`);

  const ignored = await arm("ignore");
  ok(ignored.wrote.ok === false && ignored.wrote.outcome === "failed-transport"
     && ignored.wrote.reason === "ignored",
     `an editor that does nothing is still 'ignored', not 'misplaced' `
     + `(${JSON.stringify(ignored.wrote)}) -- the two have the same consequence and `
     + `different causes, and a log that conflates them cannot tell you which`);
  await page.close();
}

// --- [13] The CONSEQUENCE of that split: which failure withdraws the family -
//
// [10] pins the two REASONS apart. That is half the distinction and it was the
// only half anybody checked: `misplaced` and `normalized` were drawn as
// different verdicts precisely because they have different costs, and the cost
// is decided in `applySentenceWrite`, not in the splice --
//
//     misplaced   -> blockSentenceField(el, "wrote-elsewhere")  -> DEMOTES Slate
//     normalized  -> blockSentenceField(el, "write-normalized")   -> this element
//
// -- so a change that collapsed the two back into one verdict, or that swapped
// which one demotes, passed [10] with its reasons intact and every other suite
// green. The reason strings are the evidence; the block is the behaviour, and
// only the behaviour is what a user experiences.
//
// The instrument is `sentenceFieldStatus` on a FRESH SIBLING that was never
// written to. That is the whole point of demotion: `sentenceBlockedEls` is a
// WeakSet, so React replacing the composer hands us a new element and silently
// clears an element-keyed veto -- a family withdrawal has to survive exactly
// that, and an element that never saw a write is the only thing that can tell
// the two apart.
//
// TWO CONTROLS, because this case can fail in both directions. Without the
// `normalize` arm's fresh sibling coming back OK, a build that demoted on every
// transport failure would pass; without the `obey` arm, one that blocked on
// every write would.
//
// Driven through `applySentenceWrite` rather than the splice, because the
// branch under test is the caller's -- a probe that calls the splice directly
// measures half the behaviour and reports it as all of it.
// [13b] Mutant: spliceFailurePolicy's normalized apply prefix -> "sentence-skipped:";
// the exact normalized outcome assertion turns red while the DOM control holds.
{
  console.log("\n[13b] Caller outcomes preserve the hostile editor's observation");
  const consequence = async (mode) => {
    // A page per arm: demotion lives for the life of the injection, so an arm
    // that withdraws Slate would answer for the arm after it.
    const page = await hostilePage(
      `<div id="wrote" contenteditable="true" data-slate-editor="true"
            style="width:400px;min-height:40px"></div>
       <div id="fresh" contenteditable="true" data-slate-editor="true"
            style="width:400px;min-height:40px"></div>`);
    const out = await page.evaluate(async ({ mode, HOSTILE, FIXED, SPAN }) => {
      const el = document.querySelector("#wrote");
      const fresh = document.querySelector("#fresh");
      el.textContent = HOSTILE;
      fresh.textContent = HOSTILE;
      let acted = false;
      el.addEventListener("beforeinput", (e) => {
        // Our own write only, and once: the replay carries the same inputType.
        if (e.isTrusted || e.inputType !== "insertReplacementText" || acted) return;
        acted = true;
        e.preventDefault();
        const node = el.firstChild;
        const r = e.getTargetRanges()[0];
        if (mode === "ignore") return;
        if (mode === "append") { node.data = node.data + e.data; return; }   // wrong place
        if (!r || r.startContainer !== node) return;
        node.data = node.data.slice(0, r.startOffset) + e.data + node.data.slice(r.endOffset);
        // The span honoured, and then something ELSE in the document tidied --
        // a custom normalizer rewriting whitespace or block wrappers. After the
        // span, so the span's own offsets still describe what we asked for.
        if (mode === "normalize") node.data = node.data + "!";
      });
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      const P = window.__prooferSentence;
      await P.applySentenceWrite(
        { el, start: 0, end: SPAN, sentence: HOSTILE.slice(0, SPAN), id: "sn_conseq_" + mode },
        FIXED, "sentence-applied");
      return {
        acted,
        verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
        said: P.sentenceStatusReport(),
        wroteEl: P.sentenceFieldStatus(el),
        freshEl: P.sentenceFieldStatus(fresh),
        after: el.textContent,
      };
    }, { mode, HOSTILE, FIXED, SPAN });
    if (mode !== "obey") {
      await page.keyboard.press("Escape");
      const afterEscape = await page.evaluate(() => ({
        text: document.querySelector("#wrote").textContent,
        verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
      }));
      ok(afterEscape.text === out.after && JSON.stringify(afterEscape.verdicts) === JSON.stringify(out.verdicts),
        `[13b/${mode}] failed write arms no Escape slot and leaves the mutation intact`);
    }
    ok(out.acted, `[13b/${mode}] the editor handled the dispatched intent`);
    await page.close();
    return out;
  };

  const gone = await consequence("append");
  ok(gone.after === HOSTILE + FIXED, "[13b/append] the misplaced mutation is not rolled back");
  ok(JSON.stringify(gone.verdicts) === JSON.stringify(["sentence-written:splice-failed:misplaced"]),
    "[13b/append] exact misplaced post-write outcome");
  ok(gone.said.status === "session-blocked" && gone.said.detail === "wrote-elsewhere",
     `a misplaced write is reported as wrote-elsewhere (${JSON.stringify(gone.said.status)}/`
     + `${JSON.stringify(gone.said.detail)})`);
  ok(gone.freshEl.ok === false && gone.freshEl.status === "session-blocked"
     && gone.freshEl.detail === "wrote-elsewhere" && gone.freshEl.family === "Slate",
     `...and the FAMILY is withdrawn -- an element that was never written to is `
     + `refused too, which is the only thing an element-keyed WeakSet could not do `
     + `(${JSON.stringify(gone.freshEl)})`);

  const tidy = await consequence("normalize");
  ok(tidy.after === FIXED + HOSTILE.slice(SPAN) + "!", "[13b/normalize] normalization is not rolled back");
  ok(JSON.stringify(tidy.verdicts) === JSON.stringify(["sentence-written:splice-failed:normalized"]),
    "[13b/normalize] exact normalized post-write outcome");
  ok(tidy.said.status === "session-blocked" && tidy.said.detail === "write-normalized",
     `an editor that honoured the span and tidied elsewhere blocks with `
     + `write-normalized, not wrote-elsewhere (${JSON.stringify(tidy.said.status)}/`
     + `${JSON.stringify(tidy.said.detail)})`);
  ok(tidy.wroteEl.ok === false && tidy.wroteEl.status === "session-blocked",
     `...this element is unusable (${JSON.stringify(tidy.wroteEl)})`);
  ok(tidy.freshEl.ok === true && tidy.freshEl.family === "Slate",
     `...and the family is NOT -- the transport told the truth, so a second Slate `
     + `field still works. Without this the case would pass for a build that `
     + `demoted on every failure (${JSON.stringify(tidy.freshEl)})`);

  const ignored = await consequence("ignore");
  ok(ignored.after === HOSTILE, "[13b/ignore] unchanged field stays unchanged");
  ok(JSON.stringify(ignored.verdicts) === JSON.stringify(["sentence-skipped:splice-failed:ignored"]),
    "[13b/ignore] exact delivery-skip outcome");
  ok(ignored.said.detail === "write-rejected" && !ignored.wroteEl.ok && ignored.freshEl.ok,
    "[13b/ignore] refusal blocks only this element");

  const fine = await consequence("obey");
  ok(JSON.stringify(fine.verdicts) === JSON.stringify(["sentence-applied"]),
    "[13b/obey] verified apply retains its outcome");
  ok(fine.after === FIXED + HOSTILE.slice(SPAN),
     `the control arm's editor really did replace the span: ${JSON.stringify(fine.after)}`);
  ok(fine.said.status !== "session-blocked" && fine.wroteEl.ok === true
     && fine.freshEl.ok === true,
     `...and a write that landed blocks neither the element nor the family `
     + `(${JSON.stringify(fine.said.status)}, ${JSON.stringify(fine.wroteEl.ok)}, `
     + `${JSON.stringify(fine.freshEl.ok)})`);
}

// [13c] Mutant: doSentenceUndo's blockSentenceField(u.el, cause) ->
// blockSentenceField(u.el, "write-rejected"); misplaced status and fresh-sibling
// ineligibility turn red, while normalization and ignore keep their own scope.
{
  console.log("\n[13c] Escape shares apply's transport consequences");
  for (const [mode, verdict, cause, demoted] of [
    ["append", "sentence-undo-unverified", "wrote-elsewhere", true],
    ["normalize", "sentence-undo-unverified", "write-normalized", false],
    ["ignore", "sentence-undo-reconciled", "write-rejected", false],
    ["obey", "sentence-undone", null, false],
  ]) {
    const page = await hostilePage(`<div id="wrote" contenteditable="true" data-slate-editor="true"
      style="width:400px;min-height:40px"></div><div id="fresh" contenteditable="true" data-slate-editor="true"></div>`);
    await page.evaluate(async ({ mode, HOSTILE, FIXED, SPAN }) => {
      const el = document.querySelector("#wrote");
      el.textContent = HOSTILE;
      document.querySelector("#fresh").textContent = HOSTILE;
      window.__writes = [];
      window.__escTrusted = false;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") window.__escTrusted = e.isTrusted;
      }, true);
      el.addEventListener("beforeinput", (e) => {
        if (e.isTrusted || e.inputType !== "insertReplacementText") return;
        e.preventDefault();
        const node = el.firstChild, r = e.getTargetRanges()[0];
        const undo = window.__writes.length > 0;
        window.__writes.push({ data: e.data, atTarget: !!r && r.startContainer === node && r.startOffset === 0 });
        if (undo && mode === "ignore") return;
        if (undo && mode === "append") { node.data += e.data; return; }
        if (!r || r.startContainer !== node) return;
        node.data = node.data.slice(0, r.startOffset) + e.data + node.data.slice(r.endOffset);
        if (undo && mode === "normalize") node.data += "!";
      });
      el.focus();
      const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      await window.__prooferSentence.applySentenceWrite(
        { el, start: 0, end: SPAN, sentence: HOSTILE.slice(0, SPAN), id: "sn_undo_" + mode }, FIXED, "sentence-applied");
    }, { mode, HOSTILE, FIXED, SPAN });
    ok((await page.$eval("#wrote", (el) => el.textContent)) === FIXED + HOSTILE.slice(SPAN),
      `[13c/${mode}] the correction is anchored before Escape`);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => window.__writes.length === 2);
    await sleep(200); // the dispatched intent has a 30 ms settle ceiling
    const out = await page.evaluate(() => ({
      text: document.querySelector("#wrote").textContent,
      writes: window.__writes, trusted: window.__escTrusted,
      verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
      status: window.__prooferSentence.sentenceStatusReport(),
      wrote: window.__prooferSentence.sentenceFieldStatus(document.querySelector("#wrote")),
      fresh: window.__prooferSentence.sentenceFieldStatus(document.querySelector("#fresh")),
      announcements: [...document.querySelectorAll("[aria-live]")].map((el) => el.textContent),
    }));
    ok(out.trusted && out.writes.length === 2 && out.writes[1].atTarget && out.writes[1].data === HOSTILE.slice(0, SPAN),
      `[13c/${mode}] real Escape dispatched an anchored restoration`);
    const expected = mode === "append" ? FIXED + HOSTILE.slice(SPAN) + HOSTILE.slice(0, SPAN)
      : mode === "normalize" ? HOSTILE + "!" : mode === "ignore" ? FIXED + HOSTILE.slice(SPAN) : HOSTILE;
    ok(out.text === expected, `[13c/${mode}] observed undo mutation remains without rollback`);
    ok(JSON.stringify(out.verdicts) === JSON.stringify(["sentence-applied", verdict]),
      `[13c/${mode}] exact apply/undo outcome sequence`);
    ok(cause ? out.status.status === "session-blocked" && out.status.detail === cause && out.wrote.detail === cause
      : out.wrote.ok && out.status.status !== "session-blocked", `[13c/${mode}] undo reports its distinct block cause`);
    ok(out.fresh.ok === !demoted && (!demoted || out.fresh.detail === "wrote-elsewhere"),
      `[13c/${mode}] only misplaced undo withdraws the fresh Slate sibling`);
    ok(out.announcements.includes("Proofer correction undone") === (mode === "obey"),
      `[13c/${mode}] only verified restoration announces success`);
    await page.close();
  }
}

// --- [14] The waiver is keyed on isTrusted, and no CDP suite can see it ----
//
// `windowRecord().userEdited` is `(yielded || replayed) && sawTrusted`, and
// `sawTrusted` is set only by an event with `isTrusted`. The bit ENDS
// verification: `applySentenceWrite` skips `sentenceWriteLanded` entirely when
// it is set, on the argument that once the user has touched the field nothing
// found afterwards is attributable to the page.
//
// That argument holds for a USER action and for nothing else. Drop the
// `isTrusted` test -- one word, and it reads like a tidy-up -- and an editor's
// own synthetic keydown buys a correction a pass through the one check that
// catches a controlled component throwing the write away. The field stays
// enabled, every later sentence is written into a page that discards it, and
// nothing is logged as anything but a success.
//
// EVERY SUITE IS BLIND TO IT, structurally rather than by omission: every
// swallowed keystroke in every case in this file and in sentence-typing-test is
// a real CDP key, so `sawTrusted` is true in all of them and the gate is never
// the thing that decides. The regression passes green everywhere. So the arms
// here differ in exactly one property -- where the keystroke came from -- and
// the assertion is that this is what the answer turns on.
//
// The synthetic keydown is not a contrivance. `bail` deliberately reaches this
// path for an editor's own synthetic insert (see its `keyTook` comment): IME
// commits, dictation and mobile shims all arrive as events the page made.
{
  const KEY = "z";
  // Both arms take the SAME shape and the same 10ms, so the only difference in
  // the record is provenance.
  const fire = async (page, trusted) => {
    await sleep(10);                       // inside the window, after the write
    if (trusted) return page.keyboard.type(KEY);
    return page.evaluate((k) => document.querySelector("#fake").dispatchEvent(
      new KeyboardEvent("keydown",
        { key: k, bubbles: true, cancelable: true, composed: true })), KEY);
  };

  // --- the bit itself, at the splice -----------------------------------
  const windowArm = async (trusted) => {
    const page = await hostilePage(`<div id="fake" contenteditable="true"
        data-slate-editor="true" style="width:400px;min-height:40px"></div>`);
    const running = page.evaluate(async ({ HOSTILE, FIXED, SPAN }) => {
      const el = document.querySelector("#fake");
      el.textContent = HOSTILE;
      let acted = false;
      el.addEventListener("beforeinput", (e) => {
        if (e.isTrusted || e.inputType !== "insertReplacementText" || acted) return;
        acted = true;                      // the replay carries the same inputType
        e.preventDefault();
        const node = el.firstChild;
        const r = e.getTargetRanges()[0];
        if (r && r.startContainer === node) {
          node.data = node.data.slice(0, r.startOffset) + e.data + node.data.slice(r.endOffset);
        }
      });
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return window.__prooferSentence.spliceSentenceSlate(el, 0, SPAN, FIXED);
    }, { HOSTILE, FIXED, SPAN });
    await fire(page, trusted);
    const wrote = await running;
    await page.close();
    return wrote;
  };

  const synthetic = await windowArm(false);
  const trusted = await windowArm(true);
  // THE CONTROL, and without it the case is worthless: `userEdited: false` is
  // also what "the synthetic event never arrived" looks like. `replayed` proves
  // the window swallowed the keystroke and handed it back in BOTH arms, so the
  // two records differ in one field and it is not the one that says whether
  // anything happened.
  ok(synthetic.window && synthetic.window.replayed === KEY
     && trusted.window && trusted.window.replayed === KEY,
     `both arms swallowed the keystroke and replayed it, so the window saw the `
     + `synthetic one exactly as it saw the real one `
     + `(synthetic ${JSON.stringify(synthetic.window)}, trusted ${JSON.stringify(trusted.window)})`);
  ok(synthetic.window && synthetic.window.userEdited === false,
     `...and a keystroke the PAGE dispatched does not count as the user editing `
     + `(${JSON.stringify(synthetic.window)})`);
  ok(trusted.window && trusted.window.userEdited === true,
     `...while a real one does (${JSON.stringify(trusted.window)})`);

  // --- and what the bit BUYS, at the caller -----------------------------
  //
  // The bit is only interesting because of what it waives. This editor honours
  // the span and then throws the write away on the replay -- the last thing the
  // splice does, so the reconcile lands after the splice has verified itself and
  // before `applySentenceWrite` asks `sentenceWriteLanded`. That is a controlled
  // component reconciling, and it must block the field. Unless the window says
  // the user touched it, in which case the result is unattributable and we do
  // not judge it at all.
  const waiverArm = async (trusted) => {
    const page = await hostilePage(`<div id="fake" contenteditable="true"
        data-slate-editor="true" style="width:400px;min-height:40px"></div>`);
    const running = page.evaluate(async ({ HOSTILE, FIXED, SPAN }) => {
      const el = document.querySelector("#fake");
      el.textContent = HOSTILE;
      let writes = 0;
      el.addEventListener("beforeinput", (e) => {
        if (e.isTrusted || e.inputType !== "insertReplacementText") return;
        e.preventDefault();
        if (++writes === 1) {
          const node = el.firstChild;
          const r = e.getTargetRanges()[0];
          if (r && r.startContainer === node) {
            node.data = node.data.slice(0, r.startOffset) + e.data + node.data.slice(r.endOffset);
          }
          return;
        }
        el.textContent = HOSTILE;          // render from a model that never saw it
      });
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      const P = window.__prooferSentence;
      await P.applySentenceWrite(
        { el, start: 0, end: SPAN, sentence: HOSTILE.slice(0, SPAN), id: "sn_waiver" },
        FIXED, "sentence-applied");
      return { said: P.sentenceStatusReport(), field: P.sentenceFieldStatus(el),
               after: P.snText(el),
               // Read INSIDE the arm, because reportOutcome runs synchronously
               // within applySentenceWrite and the page is closed straight
               // after it resolves.
               verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME")
                 .map((m) => m.verdict) };
    }, { HOSTILE, FIXED, SPAN });
    await fire(page, trusted);
    const out = await running;
    await page.close();
    return out;
  };

  const judged = await waiverArm(false);
  const waived = await waiverArm(true);
  // The second control. If the editor did not actually discard the write in one
  // of the arms, "not blocked" means nothing -- so the reconcile is asserted in
  // both before either verdict is read.
  ok(judged.after === HOSTILE && waived.after === HOSTILE,
     `the editor discarded the correction in both arms, so both had something to `
     + `catch (${JSON.stringify(judged.after)} / ${JSON.stringify(waived.after)})`);
  ok(judged.said.status === "session-blocked" && judged.said.detail === "reconciled"
     && judged.field.ok === false,
     `a page-dispatched keystroke does NOT waive verification: the reconcile is `
     + `caught and the field is blocked (${JSON.stringify(judged.said.status)}/`
     + `${JSON.stringify(judged.said.detail)})`);
  ok(waived.said.status !== "session-blocked" && waived.field.ok === true,
     `...and the waiver is real for a REAL keystroke, so this is a test of `
     + `provenance and not of a check that never fires `
     + `(${JSON.stringify(waived.said.status)}/${JSON.stringify(waived.said.detail)})`);
  // AND THE RECORD SAYS WHICH ONE HAPPENED. The waiver is the one place this
  // path reports an apply it did not check, and reporting that as a plain
  // `sentence-applied` makes it indistinguishable from a verified one -- in the
  // log built to decide whether silent writing is safe, on the only arm where
  // it was not verified. The waived arm is also the one whose correction is
  // GONE from the field, which is exactly why "we declined to judge" has to be
  // legible: `waived.after === HOSTILE` above is that, asserted.
  ok(JSON.stringify(waived.verdicts) === JSON.stringify(["sentence-applied-unverified"]),
     `an unverified landing is recorded as one: ${JSON.stringify(waived.verdicts)}`);
  ok(JSON.stringify(judged.verdicts) === JSON.stringify(["sentence-reconciled"]),
     `and a judged one is not tarred with it: ${JSON.stringify(judged.verdicts)}`);
}

// --- [7] The write is invisible to the bulk-input guard --------------------
//
// `insertReplacementText` -- the inputType the intent recipe dispatches -- is a
// member of `BULK_INPUT_TYPES`, the paste/drop/undo set that makes the trigger
// skip a scan. So IF Slate echoed our write back as a native `input` event
// carrying that inputType, every correction would silently skip the scan of the
// sentence after it and log `bulk:insertReplacementText`. Nothing would look
// broken: corrections would land, and roughly every other sentence would go
// unchecked. That is a segmentation bug someone finds months later.
//
// Measured, it does not happen: Slate mutates its model and React re-renders,
// and a re-render is not a native edit, so no `input` follows. But that fact
// lived in a comment, and a comment cannot fail. Here it is an assertion, and
// the set is read out of the SHIPPING source rather than copied, so adding a
// type to `BULK_INPUT_TYPES` cannot quietly stop this from covering it.
//
// The assertion is the harm, not the measurement: any `input` at all would be a
// surprise worth reading about, so the whole event list is printed, but only an
// `input` carrying a bulk type is a failure.
{
  const m = CONTENT.match(/const BULK_INPUT_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  const BULK = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  ok(BULK.includes("insertReplacementText"),
     `BULK_INPUT_TYPES read from content.js and it does contain our own inputType `
     + `(${BULK.length} types) -- a red here means the extraction broke, not the code`);

  const page = await slatePage();
  await page.evaluate(() => {
    window.__seen = [];
    const rec = (e) => window.__seen.push(
      { type: e.type, inputType: e.inputType, trusted: e.isTrusted });
    document.addEventListener("input", rec, true);
    document.addEventListener("beforeinput", rec, true);
  });
  const wrote = await page.evaluate(async (FIXED) => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const S = window.__prooferSentence;
    const t = S.snText(el);
    const start = t.indexOf("The techncian");
    return S.spliceSentenceSlate(el, start, start + "The techncian arrived early.".length, FIXED);
  }, FIXED);
  await sleep(400);
  const seen = await page.evaluate(() => window.__seen);
  ok(wrote.ok === true && (await text(page)).startsWith("The technician"),
     `the write landed, so there was something for Slate to echo (${JSON.stringify(wrote)})`);
  const bulk = seen.filter((e) => e.type === "input" && BULK.includes(e.inputType));
  ok(bulk.length === 0,
     `no input event reached the bulk guard: ${JSON.stringify(seen)}`);
  await page.close();
}

// --- The pipeline stub with a CLOCK, shared by [15]–[17] and the clear-receipt
// group. Outcome ARRIVAL is stamped synchronously in `sendMessage`, before the
// artificial round-trip delay -- so `sentence-applied`'s `at` is the moment the
// verifier armed its samples, and a key's distance from it is measured rather
// than assumed from a sleep. `__FIX` is keyed by SUBSTRING: the key under test
// is typed immediately after the first sentence's terminator, so it becomes
// the opening character of the second one, and an exact-match table then
// answers `noChanges` for a reason that has nothing to do with the code.
const TIMED_STUB = (fixes, delay = 60) => `window.__req = []; window.__outs = [];
  window.__FIX = ${JSON.stringify(fixes)};
  window.chrome = { runtime: { id:"t", lastError: undefined, onMessage: { addListener() {} }, sendMessage: (m, cb) => {
      if (m.type === "SENTENCE_REWRITE") window.__req.push({ id: m.requestId, sentence: m.sentence, at: performance.now() });
      if (m.type === "REWRITE_OUTCOME") window.__outs.push({ id: m.requestId, verdict: m.verdict, finalText: m.finalText, at: performance.now() });
      setTimeout(() => {
        if (m.type === "SENTENCE_CONSENT") return cb({ ok:true, allowed:true, apply:true });
        if (m.type === "SENTENCE_REWRITE") { let f = null;
          for (const [typo, fix] of Object.entries(window.__FIX))
            if (m.sentence.includes(typo)) { f = m.sentence.replace(typo, fix); break; }
          return cb(f ? { ok:true, rewritten:f, apply:true } : { ok:true, noChanges:true }); }
        cb({ ok:true, noChanges:true });
      }, ${delay}); } },
    storage: { local: { get:(d,cb)=>cb({...d}), set:(o,cb)=>cb&&cb() }, onChanged:{ addListener(){} } } };`;
const PIPELINE_FIXES = { techncian: "technician", recieved: "received" };

// Boot the shipping pipeline on a fresh page: load, click in, empty the editor,
// blur (content.js loads settings on FOCUSIN, so injecting into an already
// focused field starts nothing), inject, click back in. Returns the click box.
async function bootPipeline(page) {
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
  return box;
}

// Wait for the FIRST `sentence-applied` and return its arrival time -- the
// verifier's t0. A timeout here is a failure of the premise, not of the case.
async function awaitApply(page, timeout = 3000) {
  await page.waitForFunction(() => window.__outs.some((o) => o.verdict === "sentence-applied"),
    { timeout, polling: 16 });
  return page.evaluate(() => window.__outs.find((o) => o.verdict === "sentence-applied"));
}

// Every outcome reported for one request, in order.
const outcomesFor = (outs, id) => outs.filter((o) => o.id === id).map((o) => o.verdict);

// The verifier samples at rAF / 150 / 600 ms and closes at 650. A key is
// "inside the window" when it lands before the LAST sample can read the field
// -- anything under 600 ms from the apply is seen by that sample; a key past
// the 650 close is seen by nobody. The two constants are content.js's, quoted
// here rather than imported because the suite must fail if they move.
const SN_VERIFY_LAST_SAMPLE_MS = 600;
const SN_VERIFY_CLOSE_MS = 650;

// --- [15] A model-applied key must not read as the PAGE ---------------------
//
// The defect this exists for: the async write verifier attributed user edits
// with an `input` listener, and slate-react fires NO `input` for a period -- it
// applies the edit through its own model and cancels the default. So a
// correction, then a "." typed inside the 600ms verification window, read as
// the page having rewritten the field: `reconciled-async`, and the composer
// blocked for the life of the content script. Thirty of thirty-five reconciles
// in a month of the owner's real traffic were discord.com; none was a textarea.
//
// AT THE CALLER, NOT THE SPLICE. [1] drives spliceSentenceSlate directly and
// never reaches the verifier, which is why this class survived every green run
// of that case. And it has to be REAL Slate: a Slate-shaped fixture has no
// model to cancel the event with, so the whole phenomenon is absent from it.
//
// WHAT THE ASSERTIONS REQUIRE, and why it changed (2026-09-15). The first
// version asserted only that `sentence-reconciled` was ABSENT, so a mutant
// that never reported `sentence-applied-unverified` -- the distinction the
// 09-09 round introduced -- passed all three arms; and it timed the key by a
// nominal sleep after a nominal sleep, so "inside the window" was assumed. Now
// the apply is awaited, the key's distance from it is measured in the page,
// the premise is asserted, and the outcome list is asserted PER REQUEST and in
// full: `[sentence-applied, sentence-applied-unverified]` for a key inside the
// window, and exactly `[sentence-applied]` for the outside-the-window control.
//
// The last assertion is still the one that matters. Eligibility alone does
// not prove the consequence is gone -- what the user experienced was that the
// composer stopped correcting -- so the case types a SECOND erroneous sentence
// and requires a new request and a landed correction in the same element.
// Arm identity (`inside`) is stated SEPARATELY from the stimulus delay, so a
// delay edited from 100 to 900 on an inside arm goes red on the timing premise
// instead of silently turning that arm into a second outside control.
for (const [label, key, expectInput, keyAfterMs, inside] of [
  ["a period", ".", false, 100, true],
  ["a digit", "7", false, 100, true],
  // A capital is the CONTROL: /[a-z ]/i is case-insensitive, so slate-react
  // takes its native path for it and an `input` event DOES fire. Do not assume
  // the three behave alike -- the first draft of this fix said capitals were
  // silent and they are not.
  ["a capital", "K", true, 100, true],
  // OUTSIDE the window: the same period past the 650 ms close. The verifier
  // saw a quiet field at every sample and reports nothing further, so the
  // record holds exactly one verdict. Without this arm, an implementation that
  // reported `unverified` on every apply would pass the three above.
  ["a period, outside the window", ".", false, 900, false],
]) {
  const page = await monitoredPage();
  console.log(`\n[15] a correction, then ${label} typed at +${keyAfterMs} ms`);
  await page.evaluateOnNewDocument(TIMED_STUB(PIPELINE_FIXES));
  await bootPipeline(page);
  // Record what the editor actually emits for the key, rather than inferring it
  // from the character class -- that inference is what the capital arm exists
  // to keep honest. The first trusted beforeinput carrying the key is stamped:
  // that is the key's arrival on the verifier's clock.
  await page.evaluate((k) => {
    window.__key = k;
    window.__ev = { before: 0, input: 0, at: null };
    const el = document.querySelector('[data-slate-editor="true"]');
    el.addEventListener("beforeinput", (e) => {
      if (!e.isTrusted || e.data !== window.__key) return;
      window.__ev.before++;
      if (window.__ev.at == null) window.__ev.at = performance.now();
    }, true);
    el.addEventListener("input", (e) => { if (e.isTrusted && e.data === window.__key) window.__ev.input++; }, true);
  }, key);
  // Type the sentence and let the correction land with the field at rest.
  await page.keyboard.type("The techncian arrived early", { delay: 30 });
  await page.keyboard.type(" ");   // no terminator yet
  await page.keyboard.press("Backspace");
  await page.keyboard.type(".");
  const applied = await awaitApply(page);
  ok(!!applied && (await text(page)).includes("technician"),
     `[15/${label}] the correction landed first`);
  // Armed AFTER the apply: the period arm's key is the same character as the
  // sentence's own terminator, and a recorder armed before typing stamps that
  // one instead (measured: -731 ms).
  await page.evaluate(() => { window.__ev = { before: 0, input: 0, at: null }; });
  await sleep(keyAfterMs);
  await page.keyboard.type(key);
  // Past the close either way, and past the durability settle.
  await sleep(1200);

  const out = await page.evaluate(() => ({
    text: document.querySelector('[data-slate-editor="true"]').innerText,
    ev: window.__ev,
    outs: window.__outs,
    req: window.__req,
    eligible: window.__prooferSentence.sentenceEligibleEl(
      document.querySelector('[data-slate-editor="true"]')),
  }));
  const gap = out.ev.at == null ? null : out.ev.at - applied.at;
  ok(out.ev.before > 0, `[15/${label}] the key fired a trusted beforeinput: ${JSON.stringify(out.ev)}`);
  ok(expectInput ? out.ev.input > 0 : out.ev.input === 0,
     `[15/${label}] input events are as measured, not as assumed: ${JSON.stringify(out.ev)}`);
  // THE TIMING PREMISE, measured. A red here means the case is not testing
  // what its name says, whatever the verdicts look like.
  ok(gap != null && (inside ? gap > 0 && gap < SN_VERIFY_LAST_SAMPLE_MS : gap > SN_VERIFY_CLOSE_MS),
     `[15/${label}] the key landed ${inside ? "inside" : "outside"} the verifier's window: `
     + `+${gap == null ? "?" : gap.toFixed(0)} ms after the apply`);
  ok(out.text.includes("technician") && out.text.includes(key),
     `[15/${label}] the correction and the key coexist: ${JSON.stringify(out.text)}`);
  // THE VERDICT, per request and in full. Not "reconciled is absent": the
  // distinction the round introduced is that an accounted-for edit inside the
  // window ends as `unverified`, and only an exact list can see it missing.
  const first = out.req.find((r) => r.sentence.includes("techncian"));
  const verdicts = first ? outcomesFor(out.outs, first.id) : [];
  const want = inside ? ["sentence-applied", "sentence-applied-unverified"] : ["sentence-applied"];
  ok(JSON.stringify(verdicts) === JSON.stringify(want),
     `[15/${label}] the record holds exactly ${JSON.stringify(want)}: ${JSON.stringify(verdicts)}`);
  ok(out.eligible === true, `[15/${label}] the composer is still eligible`);

  // THE CONSEQUENCE. Eligibility is a property of the element; what the user
  // lost was the next correction.
  await page.keyboard.type(" We recieved the invoice.", { delay: 30 });
  await sleep(1500);
  const after = await page.evaluate(() => ({
    text: document.querySelector('[data-slate-editor="true"]').innerText,
    reqs: (window.__req || []).map((r) => r.sentence),
  }));
  ok(after.reqs.some((r) => r.includes("recieved")),
     `[15/${label}] the next sentence still reaches the model: ${JSON.stringify(after.reqs)}`);
  ok(after.text.includes("received"),
     `[15/${label}] and its correction still lands: ${JSON.stringify(after.text)}`);
  await page.close();
}

// --- [16] Escape on real Slate, end to end -----------------------------------
//
// Escape had no coverage at the CALLER on a real editor at all -- [2] presses it
// on a textarea, which has no write window to get wrong. This is that coverage:
// the undo restores what the user typed, their next keystroke survives, the
// composer is not blocked, and the undo now always carries a verdict (the
// reconciled exit used to report nothing, so an undo the editor threw away was
// indistinguishable from one still in flight).
//
// WHAT IT DOES NOT GATE, stated rather than implied: the undo consulting
// `wrote.window` instead of judging unconditionally. That branch needs a key
// swallowed INSIDE the undo's write window, and when the write verifies on its
// first tick that window is a few milliseconds wide -- probed at 0/3/8/15/25/40
// ms after Escape and never hit, which is why [4] has to jitter across a whole
// message to sample it at all. The predicate itself is gated by
// sentence-typing-test.mjs [19c]; [16b] below pins the hostile undo caller.
//
// Two arms, because the apply verifier's 650ms budget and the undo decision are
// different mechanisms and a single timing would not say which one answered --
// and since 2026-09-15 the Escape's distance from the apply is MEASURED and
// asserted on each arm, so the arms are known to be on opposite sides of the
// close rather than assumed to be. The record is asserted in full: the apply,
// then exactly one undo verdict.
for (const [label, escAfterMs, inside] of [["inside", 200, true], ["after", 900, false]]) {
  const page = await monitoredPage();
  console.log(`\n[16] Escape ${label} the apply verifier's budget (+${escAfterMs} ms), with a key in the window`);
  await page.evaluateOnNewDocument(TIMED_STUB({ techncian: "technician" }));
  await bootPipeline(page);
  await page.evaluate(() => {
    window.__esc = null;
    document.addEventListener("keydown", (e) => {
      if (e.isTrusted && e.key === "Escape" && window.__esc == null) window.__esc = performance.now();
    }, true);
  });
  await page.keyboard.type("The techncian arrived early", { delay: 30 });
  await page.keyboard.type(".");
  const applied = await awaitApply(page);
  ok(!!applied && (await text(page)).includes("technician"),
     `[16/${label}] the correction landed first`);
  await sleep(escAfterMs);
  // Escape, then a key immediately -- into the undo's own write window, where
  // the splice swallows and replays it.
  await page.keyboard.press("Escape");
  await page.keyboard.type("z");
  await sleep(1200);
  const out = await page.evaluate(() => ({
    text: document.querySelector('[data-slate-editor="true"]').innerText,
    esc: window.__esc,
    outs: window.__outs,
    req: window.__req,
    eligible: window.__prooferSentence.sentenceEligibleEl(
      document.querySelector('[data-slate-editor="true"]')),
  }));
  const gap = out.esc == null ? null : out.esc - applied.at;
  // "Inside" means before the LAST SAMPLE, not merely before the close: an
  // Escape between 600 and 650 ms interferes with nothing the sampler does.
  ok(gap != null && (inside ? gap > 0 && gap < SN_VERIFY_LAST_SAMPLE_MS : gap > SN_VERIFY_CLOSE_MS),
     `[16/${label}] Escape landed ${inside ? "inside" : "after"} the verifier's budget: `
     + `+${gap == null ? "?" : gap.toFixed(0)} ms after the apply`);
  // The undo restored the typo the user typed, and their keystroke survived.
  ok(out.text.includes("techncian"), `[16/${label}] the undo restored the original: ${JSON.stringify(out.text)}`);
  ok(out.text.includes("z"), `[16/${label}] and the keystroke was not eaten: ${JSON.stringify(out.text)}`);
  ok(out.eligible === true, `[16/${label}] the composer is not blocked`);
  // Whatever it decided, it SAID so, once, after the apply. The exit this
  // replaces reported nothing; a verifier that spoke over the undo would
  // report twice.
  const first = out.req.find((r) => r.sentence.includes("techncian"));
  const verdicts = first ? outcomesFor(out.outs, first.id) : [];
  ok(verdicts.length === 2 && verdicts[0] === "sentence-applied"
     && (verdicts[1] === "sentence-undone" || verdicts[1] === "sentence-undo-unverified"),
     `[16/${label}] the record is the apply and exactly one undo verdict: ${JSON.stringify(verdicts)}`);
  await page.close();
}

// [16b] Mutant: doSentenceUndo reports "sentence-applied-unverified" instead
// of "sentence-undo-unverified"; the exact outcome sequence turns red.
{
  console.log("\n[16b] A trusted replay makes the undo unverified");
  const page = await hostilePage(`<div id="fake" contenteditable="true"
    data-slate-editor="true" style="width:400px;min-height:40px"></div>`);
  await page.evaluate(async ({ HOSTILE, FIXED, SPAN }) => {
    const el = document.querySelector("#fake");
    el.textContent = HOSTILE;
    window.__undoEvidence = { restored: null, replay: [], trusted: 0 };
    document.addEventListener("keydown", (e) => {
      if (e.isTrusted && e.key === "z") window.__undoEvidence.trusted++;
    }, true);
    el.addEventListener("beforeinput", (e) => {
      if (e.isTrusted || e.inputType !== "insertReplacementText") return;
      e.preventDefault();
      const node = el.firstChild;
      const r = e.getTargetRanges()[0];
      if (e.data === "z") {
        window.__undoEvidence.replay.push({ data: e.data, trusted: e.isTrusted });
        el.textContent = FIXED + HOSTILE.slice(SPAN) + "z";
      } else if (r && r.startContainer === node) {
        node.data = node.data.slice(0, r.startOffset) + e.data + node.data.slice(r.endOffset);
        if (e.data === HOSTILE.slice(0, SPAN)) window.__undoEvidence.restored = el.textContent;
      }
    });
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    await window.__prooferSentence.applySentenceWrite(
      { el, start: 0, end: SPAN, sentence: HOSTILE.slice(0, SPAN), id: "sn_undo_waiver" },
      FIXED, "sentence-applied");
  }, { HOSTILE, FIXED, SPAN });
  ok((await page.$eval("#fake", (el) => el.textContent)) === FIXED + HOSTILE.slice(SPAN),
    "[16b] the real apply landed first");
  await page.keyboard.press("Escape");
  await page.keyboard.type("z");
  await page.waitForFunction(() => window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").length >= 2);
  const out = await page.evaluate(() => ({ evidence: window.__undoEvidence,
    after: document.querySelector("#fake").textContent,
    verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
    announcements: [...document.querySelectorAll('[aria-live]')].map((el) => el.textContent),
  }));
  ok(out.evidence.restored === HOSTILE, "[16b] the editor honored restoration before replay");
  ok(out.evidence.trusted === 1 && JSON.stringify(out.evidence.replay) === JSON.stringify([{ data: "z", trusted: false }]),
    `[16b] one trusted key was captured and replayed: ${JSON.stringify(out.evidence)}`);
  ok(out.after === FIXED + HOSTILE.slice(SPAN) + "z", "[16b] the replay altered the restored field");
  ok(JSON.stringify(out.verdicts) === JSON.stringify(["sentence-applied", "sentence-undo-unverified"]),
    `[16b] exact apply/unverified-undo outcome sequence: ${JSON.stringify(out.verdicts)}`);
  ok(!out.announcements.includes("Proofer correction undone"), "[16b] no successful undo is announced");
  await page.close();
}

// --- [17] Real Slate feedback consumes a settled beforeinput-only edit ---
// Mutant: `if (via === "input") noteSentenceEditWatch(st, text, st.userEditSeq);`
// in noteSentenceUserEdit. Red: [17] exact apply/edit sequence, settled finalText
// and exactly one feedback report.
{
  console.log("\n[17] A digit inside the correction after the verifier closes");
  const page = await monitoredPage();
  await page.evaluateOnNewDocument(TIMED_STUB(PIPELINE_FIXES));
  await bootPipeline(page);
  await page.keyboard.type("The techncian arrived early.", { delay: 30 });
  const applied = await awaitApply(page);
  ok((await text(page)).trim() === "The technician arrived early.",
     "[17] the correction landed first");
  await sleep(900);
  await page.evaluate(() => {
    window.__ev = { before: 0, input: 0, at: null, caret: null };
    const el = document.querySelector('[data-slate-editor="true"]');
    el.addEventListener("beforeinput", (e) => {
      if (!e.isTrusted || e.data !== "7") return;
      window.__ev.before++;
      window.__ev.at = performance.now();
      window.__ev.caret = window.__prooferSentence.snCaret(el);
    }, true);
    // Count all input events, including synthetic ones an editor could emit.
    el.addEventListener("input", () => window.__ev.input++, true);
  });
  // Let Slate adopt one explicit DOM selection; rapid arrow keys can outrun
  // its selection rendering and leave the digit at another in-span offset.
  await page.evaluate(() => {
    const el = document.querySelector('[data-slate-editor="true"]');
    const range = window.__prooferSentence.rangeForInnerTextOffset(el, 9, 1);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await sleep(150);
  await page.keyboard.type("7");
  await sleep(2600);
  const out = await page.evaluate(() => ({
    text: document.querySelector('[data-slate-editor="true"]').innerText.trim(),
    ev: window.__ev, outs: window.__outs,
    eligible: window.__prooferSentence.sentenceEligibleEl(
      document.querySelector('[data-slate-editor="true"]')),
  }));
  ok(out.ev.before === 1 && out.ev.input === 0 && out.ev.caret?.start === 9 && out.ev.caret?.end === 9,
     `[17] one trusted beforeinput at offset 9 and no input: ${JSON.stringify(out.ev)}`);
  const gap = out.ev.at == null ? null : out.ev.at - applied.at;
  ok(gap != null && gap > SN_VERIFY_CLOSE_MS,
     `[17] the digit arrived after the measured verifier close: +${gap?.toFixed(0)} ms`);
  ok(out.text === "The techn7ician arrived early.",
     `[17] the digit changed the corrected span: ${JSON.stringify(out.text)}`);
  const got = out.outs.filter((o) => o.id === applied.id);
  ok(JSON.stringify(got.map((o) => o.verdict)) === JSON.stringify(["sentence-applied", "user-edited-correction"]),
     `[17] exact apply/edit sequence: ${JSON.stringify(got)}`);
  ok(got.length === 2 && got[1].finalText === "The techn7ician arrived early.",
     `[17] feedback carries the settled finalText: ${JSON.stringify(got[1]?.finalText)}`);
  ok(out.eligible === true, "[17] the composer is not blocked");
  await sleep(500);
  const count = await page.evaluate((id) => window.__outs.filter((o) =>
    o.id === id && o.verdict === "user-edited-correction").length, applied.id);
  ok(count === 1, "[17] the settled edit is reported exactly once");
  await page.close();
}

// [18] Mutant: replace markSentenceFieldDetached(el, lastField) at the caller
// with setSentenceStatus("unsafe-range", wrote.reason, sentenceFieldStatus(el).family);
// detached live/history, replacement and off-state assertions go red.
{
  console.log("\n[18] Removal during INTENT is a field lifecycle diagnosis");
  for (const mode of ["removed", "replacement", "revoked"]) {
    const page = await hostilePage(`<div id="gone" contenteditable="true"
      data-slate-editor="true" style="width:400px;min-height:40px"></div>
      <textarea id="fresh"></textarea><button id="outside">Outside</button>`);
    await page.evaluate(({ HOSTILE }) => {
      document.querySelector("#gone").textContent = HOSTILE;
      window.__allowed = true;
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = (m, cb) => m.type === "SENTENCE_CONSENT"
        ? cb({ ok: true, allowed: window.__allowed }) : send(m, cb);
    }, { HOSTILE });
    await page.click("#gone");
    await page.waitForFunction(() => window.__prooferSentence.sentenceStatusReport().status === "active");
    const before = await page.evaluate(() => ({
      focused: document.activeElement === document.querySelector("#gone"),
      status: window.__prooferSentence.sentenceStatusReport(),
    }));
    ok(before.focused && before.status.family === "Slate" && before.status.apply === true,
      `[18/${mode}] an allowed, focused Slate field is attached before the write`);
    const out = await page.evaluate(async ({ mode, HOSTILE, FIXED, SPAN }) => {
      const P = window.__prooferSentence;
      const el = document.querySelector("#gone");
      let intent = null, revoked = null;
      el.addEventListener("beforeinput", (e) => {
        if (e.isTrusted || e.inputType !== "insertReplacementText") return;
        e.preventDefault();
        const r = e.getTargetRanges()[0];
        intent = { data: e.data, start: r.startOffset, end: r.endOffset,
          connected: el.isConnected, target: r.startContainer === el.firstChild };
        // Honor the intent, then remove synchronously, before any settle sample.
        el.firstChild.data = el.firstChild.data.slice(0, r.startOffset)
          + e.data + el.firstChild.data.slice(r.endOffset);
        el.remove();
        if (mode === "replacement") document.querySelector("#fresh").focus();
        if (mode === "revoked") {
          // Let removal's queued blur settle first, then withdraw consent
          // before the splice's first sample, which is queued after dispatch.
          setTimeout(() => {
            window.__allowed = false;
            window.__statusListener({ type: "SENTENCE_SETTINGS_CHANGED" }, { id: chrome.runtime.id }, () => {});
            revoked = P.sentenceStatusReport();
          }, 0);
        }
      });
      const r = document.createRange();
      r.selectNodeContents(el); r.collapse(false);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      await P.applySentenceWrite({ el, start: 0, end: SPAN,
        sentence: HOSTILE.slice(0, SPAN), id: "sn_detached_" + mode }, FIXED, "sentence-applied");
      const status = P.sentenceStatusReport();
      // Read the actual message path, including its priority. A stale focused
      // reference takes the 0 ms lane even though its element has been removed.
      let delay;
      const schedule = window.setTimeout;
      const reply = await new Promise((resolve) => {
        window.setTimeout = (fn, ms, ...args) => { delay = ms; return schedule(fn, ms, ...args); };
        window.__statusListener({ type: "SENTENCE_STATUS" }, {}, resolve);
        window.setTimeout = schedule;
      });
      return { intent, revoked, connected: el.isConnected, text: el.textContent, status, reply, delay,
        verdicts: window.__sent.filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict),
        freshFocused: document.activeElement === document.querySelector("#fresh") };
    }, { mode, HOSTILE, FIXED, SPAN });
    ok(out.intent?.connected && out.intent.target && out.intent.data === FIXED
       && out.intent.start === 0 && out.intent.end === SPAN,
      `[18/${mode}] the real caller dispatched the anchored INTENT before removal`);
    ok(!out.connected && out.text === FIXED + HOSTILE.slice(SPAN),
      `[18/${mode}] the host was removed after honoring the write, without rollback`);
    ok(JSON.stringify(out.verdicts) === JSON.stringify(["sentence-skipped:splice-refused:detached"]),
      `[18/${mode}] the detached observation retains its exact skip verdict`);
    if (mode === "removed") {
      ok(out.status.status === "field-detached" && out.status.detail === "detached"
         && out.status.family === "Slate" && out.reply.status === "field-detached",
        "[18/removed] live and message status name field-detached, not a running range refusal");
      ok(out.delay === 60, "[18/removed] clearing the focused reference uses remembered reply priority");
      // Removal itself need not fire blur. A real subsequent blur exercises
      // the same live-to-remembered transition as opening the toolbar.
      await page.focus("#outside");
      await page.$eval("#outside", (el) => el.blur());
      await page.waitForFunction(() => window.__prooferSentence.sentenceStatusReport().status === "no-field");
      const blurred = await page.evaluate(() => window.__prooferSentence.sentenceStatusReport());
      ok(blurred.last?.status === "field-detached" && blurred.last.detail === "detached"
         && blurred.last.family === "Slate",
        "[18/removed] blur remembers the detached field diagnosis");
      await page.click("#fresh");
      await page.waitForFunction(() => window.__prooferSentence.sentenceStatusReport().status === "active");
      const fresh = await page.evaluate(() => window.__prooferSentence.sentenceStatusReport());
      ok(fresh.family === "textarea" && fresh.last?.status === "active" && fresh.last.family === "textarea",
        "[18/removed] a later eligible attachment replaces the detached diagnosis");
    } else if (mode === "replacement") {
      ok(out.freshFocused && out.status.status === "active" && out.status.family === "textarea"
         && out.status.last?.status === "active" && out.status.last.family === "textarea" && out.delay === 0,
        "[18/replacement] an attachment during the await keeps its active status and focused priority");
    } else {
      ok(out.revoked?.status === "off" && out.revoked.apply === false,
        "[18/revoked] consent withdrawal established off before the settle sample");
      ok(out.status.status === "off" && out.status.detail === "not-allowed" && out.status.apply === false
         && out.reply.status === "off",
        "[18/revoked] detached cleanup preserves withdrawn consent and its off status");
    }
    await page.close();
  }
}

} // Existing accepted-transport cases [1]–[18].

// --- [19] Idle refusal, [20] burst refusal, [21] exact selection restore ---
// New real capture: no editor shim, version guess, or content.js substitute.
// [19] mutant: return spliceFailed("ignored") at the synchronous rejection.
//   Red: structured reason, exact record and counter.
// [20] mutant: if (!event.defaultPrevented) -> if (false).
//   Red: every typed character present/in order, same-tick caret, no replay.
// [21] mutant: delete the selectionBefore setBaseAndExtent line.
//   Red: exact DOM endpoints/direction and next key replaces only user's range.
// [21] empty-selection mutant: delete sel.removeAllRanges() in the rejection.
//   Red: an originally empty DOM selection stays empty.
// [19/20] mutant: change spliceFailurePolicy's default block to wrote-elsewhere.
//   Red: write-rejected cause and fresh sibling eligibility.
// [19/20] mutant: delete the outer finally's detach().
//   Red: all five capture listeners absent before the next task, typing intact.
async function observeRefusal(page) {
  await page.evaluate(() => {
    const P = window.__prooferSentence;
    const el = document.querySelector('[data-slate-editor="true"]');
    window.__sent = [];
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = (m, cb) => { __sent.push(m); return send(m, cb); };
    const fresh = el.cloneNode(true); fresh.id = 'fresh-slate'; el.after(fresh);
    window.__intent = []; window.__keys = [];
    document.addEventListener('keydown', e => {
      if (e.isTrusted) __keys.push({ key: e.key, at: performance.now() });
    }, true);
    const dispatch = el.dispatchEvent;
    el.dispatchEvent = function(e) {
      const ranges = e.type === 'beforeinput' ? e.getTargetRanges().length : 0;
      const result = dispatch.call(this, e);
      if (!e.isTrusted && e.type === 'beforeinput') {
        __intent.push({ at: performance.now(), cancelled: e.defaultPrevented,
          type: e.inputType, ranges, data: e.data });
      }
      return result;
    };
    const types = ['beforeinput', 'keydown', 'compositionstart', 'mousedown', 'paste'];
    const active = new Map(types.map(t => [t, new Set()]));
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, options) => {
      if (active.has(type) && options === true) active.get(type).add(listener);
      return add(type, listener, options);
    };
    document.removeEventListener = (type, listener, options) => {
      if (active.has(type) && options === true) active.get(type).delete(listener);
      return remove(type, listener, options);
    };
    window.__guards = () => [...active].filter(([, s]) => s.size).map(([t]) => t);
    window.__direct = (span, replacement) => {
      const sel = getSelection();
      const before = [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset, sel.rangeCount];
      const pending = P.spliceSentenceSlate(el, 0, span, replacement);
      // Synchronous, in the SAME evaluation as the call, before any await.
      window.__sync = {
        selectionExact: before.every((v, i) => v === [sel.anchorNode, sel.anchorOffset,
          sel.focusNode, sel.focusOffset, sel.rangeCount][i]),
        guards: __guards(), text: P.snText(el), caret: P.snCaret(el),
      };
      return pending;
    };
  });
}

if (!LIVE || liveRejects) {
  const currentURL = LIVE ? LIVE_URL : currentServer.url(FIXTURE_ENTRY);
  for (const burst of [false, true]) {
    const id = burst ? '[20]' : '[19]';
    console.log(`\n${id} Untrusted INTENT: ${burst ? 'burst' : 'idle'} on ${currentURL}`);
    const page = await slatePage(currentURL);
    await observeRefusal(page);
    ok(await text(page) === TYPED, `${id} real editor starts with exact user text`);
    const pending = page.evaluate((a) => __direct(a.span, a.fixed), { span: SPAN, fixed: FIXED });
    const tail = burst ? 'qwerty789' : '';
    if (burst) {
      await page.waitForFunction(() => __intent.length > 0, { polling: 1, timeout: 3000 });
      await page.keyboard.type(tail, { delay: 1 });
    }
    const wrote = await pending;
    await sleep(200);
    const out = await page.evaluate(() => ({ sync: __sync, intents: __intent,
      keys: __keys, guards: __guards(), text: document.querySelector('[data-slate-editor="true"]').textContent,
      caret: __prooferSentence.snCaret(document.querySelector('[data-slate-editor="true"]')) }));
    ok(wrote.ok === false && wrote.outcome === 'failed-transport' && wrote.reason === 'untrusted-rejected',
      `${id} structured untrusted-rejected refusal: ${JSON.stringify(wrote)}`);
    ok(out.intents[0]?.cancelled === false && out.intents[0]?.ranges === 1
       && out.intents[0]?.type === 'insertReplacementText' && out.intents[0]?.data === FIXED,
      `${id} the real editor left the range-bearing correction uncancelled`);
    ok(out.sync.selectionExact && out.sync.caret.start === TYPED.length && out.sync.caret.end === TYPED.length,
      `${id} user's exact caret restored synchronously; no selected sentence`);
    ok(out.sync.guards.length === 0 && out.guards.length === 0,
      `${id} all five swallow/cancel listeners detached in the dispatch tick: ${JSON.stringify(out.sync.guards)}`);
    ok(wrote.window === null && out.intents.length === 1,
      `${id} no swallowed characters and no synthetic replay`);
    if (burst) {
      const gap = out.keys[0]?.at - out.intents[0]?.at;
      ok(out.keys.length === tail.length && gap >= 0 && gap < 30,
        `${id} trusted burst overlaps the former 30ms settle window (+${gap?.toFixed(1)}ms)`);
    }
    ok(out.text === TYPED + tail,
      `${id} every typed character present and in order: ${JSON.stringify(out.text)}`);
    ok(out.caret.start === TYPED.length + tail.length && out.caret.end === out.caret.start,
      `${id} caret remains at the user's typing position`);

    // The real production caller supplies policy, record, counter and undo slot.
    const caller = await page.evaluate(async ({ span, fixed }) => {
      const P = __prooferSentence, el = document.querySelector('[data-slate-editor="true"]');
      await P.applySentenceWrite({ el, start: 0, end: span, sentence: P.snText(el).slice(0, span), id: 'reject' }, fixed, 'sentence-applied');
      P.flushSentenceSkips();
      return { verdicts: __sent.filter(m => m.type === 'REWRITE_OUTCOME').map(m => m.verdict),
        skips: __sent.filter(m => m.type === 'SENTENCE_SKIPS').flatMap(m => Object.entries(m.counts)),
        field: P.sentenceFieldStatus(el), fresh: P.sentenceFieldStatus(document.querySelector('#fresh-slate')),
        dispatches: __intent.length, text: P.snText(el) };
    }, { span: SPAN, fixed: FIXED });
    ok(JSON.stringify(caller.verdicts) === JSON.stringify(['sentence-skipped:splice-failed:untrusted-rejected']),
      `${id} record names the transport refusal, never a written/misplaced outcome: ${JSON.stringify(caller.verdicts)}`);
    ok(caller.skips.some(([k, v]) => k === 'splice-failed:untrusted-rejected' && v === 1),
      `${id} counter carries splice-failed:untrusted-rejected exactly once`);
    ok(caller.field.ok === false && caller.field.status === 'session-blocked' && caller.field.detail === 'write-rejected',
      `${id} rejected field is blocked as write-rejected: ${JSON.stringify(caller.field)}`);
    ok(caller.fresh.ok === true && caller.fresh.family === 'Slate',
      `${id} fresh sibling stays eligible; no family demotion`);
    await page.keyboard.press('Escape');
    await page.keyboard.type('x');
    await sleep(200);
    const escaped = await page.evaluate(() => ({ count: __intent.length,
      verdicts: __sent.filter(m => m.type === 'REWRITE_OUTCOME').map(m => m.verdict),
      text: document.querySelector('[data-slate-editor="true"]').textContent }));
    ok(escaped.count === caller.dispatches && JSON.stringify(escaped.verdicts) === JSON.stringify(caller.verdicts),
      `${id} refused apply arms no Escape undo on new Slate`);
    ok(escaped.text === TYPED + tail + 'x', `${id} Escape and the next key keep all user text at its caret`);
    await page.close();
  }

  console.log('\n[21] Untrusted refusal preserves a backwards selection exactly');
  {
    const page = await slatePage(currentURL);
    await observeRefusal(page);
    await page.evaluate(() => {
      const el = document.querySelector('[data-slate-editor="true"]');
      const r = __prooferSentence.rangeForInnerTextOffset(el, el.textContent.length - 7, 7);
      getSelection().setBaseAndExtent(r.endContainer, r.endOffset, r.startContainer, r.startOffset);
    });
    await sleep(150);
    const wrote = await page.evaluate((a) => __direct(a.span, a.fixed), { span: SPAN, fixed: FIXED });
    const sync = await page.evaluate(() => __sync);
    ok(wrote.reason === 'untrusted-rejected' && sync.selectionExact,
      '[21] same DOM anchor/focus nodes, offsets and backwards direction in the dispatch tick');
    await page.keyboard.type('q'); await sleep(200);
    ok(await text(page) === TYPED.slice(0, -7) + 'q',
      `[21] next keystroke replaces only the user's selected tail, never the sentence: ${JSON.stringify(await text(page))}`);
    // A selection with no range must also remain empty.
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.evaluate((a) => __direct(a.span, a.fixed), { span: SPAN, fixed: FIXED });
    ok(await page.evaluate(() => __sync.selectionExact && getSelection().rangeCount === 0),
      '[21] an originally empty DOM selection stays empty');
    await page.close();
  }
}

// --- [22] Reachable Escape undo loses transport acceptance after an apply ---
// New Slate cannot naturally arm an undo (pinned above). Use the real old model
// for the apply, then a capture listener with the new handler's early-return
// behavior for the undo. No pretend successful write or injected undo slot.
// Mutant: if (!event.defaultPrevented) -> if (false).
// Red: undo's typed characters, synchronous selection, empty window and counter.
if (!LIVE) {
  console.log('\n[22] Escape undo gets the same synchronous transport protection');
  const page = await slatePage();
  await observeRefusal(page);
  await page.evaluate(async ({ span, fixed }) => {
    const P = __prooferSentence, el = document.querySelector('[data-slate-editor="true"]');
    await P.applySentenceWrite({ el, start: 0, end: span, sentence: P.snText(el).slice(0, span), id: 'undo-reject' }, fixed, 'sentence-applied');
  }, { span: SPAN, fixed: FIXED });
  await sleep(700);
  const corrected = FIXED + TYPED.slice(SPAN);
  ok(await text(page) === corrected, '[22] real old-Slate apply landed and armed Escape');
  await page.evaluate(() => {
    const el = document.querySelector('[data-slate-editor="true"]');
    // Added before the recipe's document guard. The event stays uncancelled.
    el.addEventListener('beforeinput', e => {
      if (!e.isTrusted) e.stopImmediatePropagation();
    }, true);
    __intent.length = 0; __keys.length = 0;
  });
  await page.keyboard.press('Escape');
  await page.keyboard.type('qwerty789', { delay: 1 });
  await sleep(250);
  const undo = await page.evaluate(() => {
    const P = __prooferSentence, el = document.querySelector('[data-slate-editor="true"]');
    P.flushSentenceSkips();
    return { text: el.textContent, caret: P.snCaret(el), guards: __guards(), intents: __intent,
      field: P.sentenceFieldStatus(el), fresh: P.sentenceFieldStatus(document.querySelector('#fresh-slate')),
      verdicts: __sent.filter(m => m.type === 'REWRITE_OUTCOME').map(m => m.verdict),
      skips: __sent.filter(m => m.type === 'SENTENCE_SKIPS').flatMap(m => Object.entries(m.counts)) };
  });
  ok(undo.intents.length === 1 && !undo.intents[0].cancelled && undo.intents[0].data === TYPED.slice(0, SPAN),
    '[22] Escape attempted the original through the uncancelled transport, without replay');
  ok(undo.text === corrected + 'qwerty789', `[22] undo refusal keeps every typed character in order: ${JSON.stringify(undo.text)}`);
  ok(undo.caret.start === undo.text.length && undo.caret.end === undo.text.length && undo.guards.length === 0,
    '[22] undo restores caret and removes every swallow/cancel listener');
  ok(JSON.stringify(undo.verdicts) === JSON.stringify(['sentence-applied', 'sentence-undo-reconciled']),
    `[22] exact existing failed-undo verdict: ${JSON.stringify(undo.verdicts)}`);
  ok(undo.skips.some(([k, v]) => k === 'undo:failed-transport:untrusted-rejected' && v === 1),
    '[22] undo counter names untrusted-rejected');
  ok(undo.field.detail === 'write-rejected' && !undo.field.ok && undo.fresh.ok,
    '[22] undo refusal blocks only this field as write-rejected');
  await page.close();
}


await browser.close();
if (server) {
  // Checked once at the end as well as at [0]: cases [1]-[5] each load the page
  // again, and an asset that only some of them ask for would not be in the
  // probe's numbers.
  ok(server.misses.length === 0,
     `nothing asked the fixture server for an uncaptured path: ${JSON.stringify(server.misses.slice(0, 4))}`);
  // [0] could only speak for the probe page, because the rest had not been
  // opened yet. Every case page since has been monitored too, so this is the
  // one that covers the actual run.
  ok(offsite.length === 0,
     `no page opened by this run reached off the loopback origin: `
     + `${JSON.stringify(offsite.slice(0, 4))}`);
  await server.close();
  ok(currentServer.misses.length === 0, `new capture has no uncaptured paths: ${JSON.stringify(currentServer.misses)}`);
  await currentServer.close();
}
console.log("\n" + "=".repeat(72));
console.log(`${pass} passed, ${fail} failed`
  + (LIVE ? "   [LIVE -- the offline gate is the one that gates]" : "")
  + (VARIANT ? `\n[VARIANT -- this ran ${path.basename(CONTENT_PATH)}, NOT the shipping content.js]` : ""));
process.exit(fail ? 1 : 0);
