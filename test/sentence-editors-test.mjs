#!/usr/bin/env node
/**
 * The write, against every certified editor.
 *
 *   cd test && node sentence-editors-test.mjs
 *   node sentence-editors-test.mjs --source-test                  # offline source regression
 *   PROOFER_CONTENT=/tmp/candidate.js node sentence-editors-test.mjs --source-probe
 *   PROOFER_EDITORS=Quill,Lexical node sentence-editors-test.mjs      # one row
 *
 * Table-driven so a new editor is a ROW rather than a file. Each row is one
 * entry in content.js's SN_TRANSPORTS registry, and this suite is the evidence
 * for that entry -- a registry row without one is an assertion nobody checked.
 *
 * WHY THIS CANNOT BE A FIXTURE. Writing to a rich editor is two problems and
 * only one is visible: put the right characters in the DOM, and get the
 * editor's own MODEL to agree. A Slate-shaped div has no model to disagree, so
 * it passes while the write is silently broken. The only assertion that can
 * fail is the last one in every scenario here: TYPE MORE CHARACTERS AFTERWARDS
 * AND SEE WHETHER THE CORRECTION SURVIVES AT THE RIGHT OFFSET.
 *
 * Four method rules, each of which produced a wrong answer when broken:
 *
 *   - JITTER the inter-keystroke delay (22-130ms). A fixed cadence hides
 *     corruption completely: at one spacing 10/10 broken, at the next 0/10.
 *   - Report TEXT survival and CARET correctness separately. Conflating them
 *     into one boolean produced a false 0/2 for Lexical and sent the diagnosis
 *     to a harness artifact that did not exist. (Here they are separate
 *     scenarios: [1] is text, [1] and [7] are caret.)
 *   - Split IDLE firing from BURST firing. They answer different questions, and
 *     keystroke deletion is invisible in the idle column.
 *   - Carry SLATE as a positive control. It is the one editor on the INTENT
 *     recipe; without a known-honouring editor in the run, "the write worked"
 *     is indistinguishable from a probe that never fired.
 *
 * An unreachable demo site SKIPS THAT ROW and the suite exits 77 -- not 0,
 * which is what a clean pass returns, and not 1, so a skip never reads as a
 * failed assertion. PROOFER_EDITORS_OPTIONAL=1 for a batch run that genuinely
 * tolerates the gap.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { resolveChrome } from "./lib/chrome.mjs";
import { SN_TRANSPORTS, CONTENT_PATH, CONTENT_SOURCE } from "./lib/content-sandbox.mjs";

const EXT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const CONTENT = CONTENT_SOURCE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXIT_SKIPPED = 77;

// 22-130ms. The band is the point: a human types unevenly, and every fixed
// cadence is a resonance waiting to hide a bug.
const jitter = () => 22 + Math.floor(Math.random() * 108);

let pass = 0, fail = 0;
const results = [];
// A check that could not be run. Treated exactly like an unreachable demo site:
// it exits 77 rather than 0, because a green run that quietly skipped the
// assertion is the failure mode this whole file's exit-code policy exists for.
const notRun = [];
const ok = (cond, label) => {
  console.log(`    ${cond ? "PASS" : "FAIL"}: ${label}`);
  cond ? pass++ : fail++;
  return !!cond;
};

/**
 * The rows. `quirk` is a harness fact bought the hard way -- each one produced
 * a confidently wrong measurement before it was known.
 */
const TARGETS = [
  {
    family: "Slate", recipe: "intent",
    url: "https://www.slatejs.org/examples/richtext",
    selector: '[data-slate-editor="true"]',
    // The positive control for the synthetic dispatch.
    control: true,
  },
  {
    family: "ProseMirror", recipe: "mutation", label: "ProseMirror (core)",
    url: "https://prosemirror.net/examples/basic/",
    selector: ".ProseMirror",
    // The editor sits BELOW THE FOLD: without scrollIntoView the click lands on
    // the page, the keystrokes go nowhere, and every assertion fails for a
    // reason that has nothing to do with the write.
    quirk: "below the fold",
  },
  {
    family: "ProseMirror", recipe: "mutation", label: "ProseMirror (TipTap)",
    // Driven TOP-LEVEL. As an embedded iframe the keyboard never reaches it.
    url: "https://embed.tiptap.dev/src/examples/default/react/",
    selector: ".tiptap.ProseMirror",
    quirk: "top-level, not an iframe",
  },
  {
    family: "Quill", recipe: "mutation",
    url: "https://quilljs.com/",
    selector: ".ql-editor",
    // THREE instances, and index 0 sits at x=-1028 -- off screen, so clicking
    // its centre focuses nothing. Pick the in-view one and then ASSERT focus
    // landed inside it.
    quirk: "three instances, one off-screen",
  },
  {
    family: "Lexical", recipe: "mutation",
    url: "https://playground.lexical.dev/",
    selector: "[data-lexical-editor]",
    // TWO Ctrl+A/Backspace passes. The first leaves 844 characters behind,
    // which silently confounds every offset measured against it.
    quirk: "needs two clear passes",
    clearPasses: 3,
  },
  {
    family: "Draft", recipe: "mutation",
    url: "https://draftjs.org/",
    selector: ".public-DraftEditor-content",
    // The homepage editor starts EMPTY, which is the one thing here that makes
    // it easy. It ignores the INTENT dispatch entirely (`ignored` 8/8), so this
    // row is the mutation recipe or nothing.
    quirk: "starts empty",
    // A DEFECT PINNED, not a behaviour approved -- see [9]. Correcting a block
    // while the caret sits in a LATER one replaces that later block with a copy
    // of the correction, destroying the user's paragraph. Measured 1/1 with the
    // caret in block 2 and 1/1 clean with it back in block 1; it did not
    // reproduce through the pipeline, so the true condition is narrower and
    // unknown. Delete this line when Draft keeps the block.
    expectNeighbour: "lost",
  },
  {
    family: "Trix", recipe: "mutation",
    url: "https://trix-editor.org/",
    selector: "trix-editor",
    // A real mouse click at the editor's own coordinates leaves activeElement
    // on BODY, and the keystrokes then go to the page -- which reads as a dead
    // write in every scenario rather than as a focus problem. el.focus() puts
    // it right and the KEYSTROKES are still real, which is the part that
    // matters. (The page is one big trix-editor holding the Trix homepage, so
    // the clearing pass wipes a document rather than a composer.)
    quirk: "a mouse click does not focus it; el.focus() does; no Ctrl+B",
    focusVia: "el",
    boldVia: "(on) => window.__ed.editor[on ? 'activateAttribute' : 'deactivateAttribute']('bold')",
  },
];

const only = (process.env.PROOFER_EDITORS || "").split(",").map((s) => s.trim()).filter(Boolean);
const rows = only.length
  ? TARGETS.filter((t) => only.includes(t.family) || only.includes(t.label || t.family))
  : TARGETS;
// A filter that matches nothing used to run zero rows and exit 0 -- "135 passed"
// and "0 passed" are the same colour, and a typo in PROOFER_EDITORS was the
// cheapest possible way to prove nothing at all.
if (!rows.length) {
  console.error(`PROOFER_EDITORS=${process.env.PROOFER_EDITORS} matched no target. `
    + `Known: ${TARGETS.map((t) => t.label || t.family).join(", ")}`);
  process.exit(2);
}

const chrome = await resolveChrome();
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chrome.path,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});

// Both the live sessions and the source probe inject the VM's selected snapshot.
async function injectContent(page) {
  await page.evaluate(CONTENT);
}

async function sourceProbe() {
  const page = await browser.newPage();
  try {
    await page.setContent('<div class="ql-editor" contenteditable="true">Source probe.</div>');
    await page.evaluate(() => {
      window.chrome = {
        runtime: { id: "t", sendMessage: (m, cb) => cb && cb({ ok: true }) },
        storage: { local: { get: (d, cb) => cb(d), set: () => {} },
          onChanged: { addListener: () => {} } },
      };
    });
    await injectContent(page);
    const adapter = await page.evaluate(() => window.__prooferSentence.editorAdapterFor(
      document.querySelector(".ql-editor")));
    const recipe = SN_TRANSPORTS.find((row) => row.family === "Quill")?.recipe;
    ok(adapter?.family === "Quill", "[0b] browser selects the Quill adapter");
    ok(adapter?.recipe === recipe, "[0b] browser recipe matches the selected VM registry");
    console.log("SOURCE_PROBE " + JSON.stringify({ source: CONTENT_PATH, vmRecipe: recipe,
      browserRecipe: adapter?.recipe }));
  } finally {
    await page.close();
  }
}

// [0b] Selected source reaches the browser. This shaped editable proves source
// selection, not Quill's document model.
// Mutant: const CONTENT = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
// The child browser/VM recipe match, successful child exit and literal browser
// intent checks go red.
async function sourceRegression() {
  console.log("[0b] Selected source reaches the browser");
  await sourceProbe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-editor-source-"));
  try {
    const selected = path.join(dir, "content.js");
    const candidate = CONTENT.replace(/(family: "Quill",[^\n]*recipe: )"[^"]+"/,
      '$1"intent"');
    fs.writeFileSync(selected, candidate);
    const run = (source) => spawnSync(process.execPath,
      [fileURLToPath(import.meta.url), "--source-probe"], {
        env: { ...process.env, PROOFER_CONTENT: source }, encoding: "utf8", timeout: 60000,
      });
    const child = run(selected);
    const output = child.stdout || "";
    const result = output.match(/^SOURCE_PROBE (.+)$/m);
    const report = result ? JSON.parse(result[1]) : {};
    ok(child.status === 0, `[0b] selected-source child passes (${child.status})`);
    if (child.status !== 0) console.log(output + (child.stderr || ""));
    ok(report.vmRecipe === "intent", "[0b] selected VM uses literal intent recipe");
    ok(report.browserRecipe === "intent", "[0b] selected browser uses literal intent recipe");
    ok(report.source === selected && output.includes(`Content: ${selected}`)
      && output.includes(`content: ${selected}`), "[0b] child banner and final result identify selected source");
    const missing = run(path.join(dir, "missing.js"));
    ok(missing.status === 1 && missing.stderr.includes("ENOENT")
      && missing.stderr.includes("missing.js"), "[0b] missing override path fails before browser setup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A page with the editor found, focused and empty, and content.js injected. */
async function session(t) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  // A visible text pass with a thrown React error is not a clean pass.
  page.on("pageerror", (e) => errors.push(String(e.message || e).split("\n")[0]));
  await page.evaluateOnNewDocument(`window.chrome = {
    runtime: { id: "t", lastError: undefined,
      sendMessage: (m, cb) => setTimeout(() => cb({ ok: true, noChanges: true }), 10) },
    storage: { local: { get: (d, cb) => cb({ ...d }), set: (o, cb) => cb && cb() },
               onChanged: { addListener: () => {} } } };`);
  await page.goto(t.url, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(t.selector, { timeout: 25000 });
  await sleep(1200);

  const box = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    // In-view, not "the first one". Quill's index 0 is at x=-1028.
    const vis = els.find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 60 && r.height > 12 && r.left >= 0 && r.top >= -10000;
    }) || els[0];
    window.__ed = vis;
    vis.scrollIntoView({ block: "center" });
    const r = vis.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 120), y: r.top + 14 };
  }, t.selector);
  // A real mouse click by default -- a synthetic one is a different event and
  // some editors treat it as such. `focusVia: "el"` is for the editor that
  // simply does not take a click at its own coordinates (Trix); the keystrokes
  // after it are still real, which is the half this suite is measuring.
  if (t.focusVia === "el") await page.evaluate(() => window.__ed.focus());
  else await page.mouse.click(box.x, box.y);
  await sleep(250);

  // The Quill lesson, generalized: a click that focused the page rather than
  // the editor produces a run of failures that all look like write bugs.
  const focused = await page.evaluate(() =>
    !!document.activeElement && (document.activeElement === window.__ed
      || window.__ed.contains(document.activeElement)));
  if (!focused) throw new Error("click did not focus the editor");

  for (let i = 0; i < (t.clearPasses || 2); i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await sleep(220);
    if (!(await userText(page))) break;
  }
  const leftover = await userText(page);
  if (leftover) throw new Error(`editor not empty after clearing (${JSON.stringify(leftover)})`);

  await injectContent(page);
  await sleep(200);
  errors.length = 0;                 // injection noise is not a write error
  return { page, errors };
}

// snText synthesises a "\n" per block boundary, including a trailing one for the
// last block. That newline is structure rather than something the user typed,
// and comparing against it is how a passing write reads as a failure.
//
// ALL of them, not one. Draft wraps each block twice (`div[data-block]` around
// `div.public-DraftStyleDefault-block`), so its tail is "\n\n" -- and stripping
// a single newline left scenario [6]'s endsWith() failing on a correction that
// had landed perfectly, both blocks intact and the caret right. The same wrong
// answer this comment was written about, one newline further along.
const text = async (page) =>
  (await page.evaluate(() => window.__prooferSentence.snText(window.__ed))).replace(/\n+$/, "");
const dom = (page) => page.evaluate(() => window.__ed.textContent);

/**
 * What the USER has typed, with the editor's own furniture removed.
 *
 * Only used to decide "is it empty", and it has to be, because an empty Slate
 * composer is not an empty element: it holds a zero-width \uFEFF inside
 * `data-slate-zero-width` and an absolutely-positioned
 * `[contenteditable="false"]` placeholder span, both of which land in
 * textContent. Reading that as 21 characters of leftover content failed every
 * Slate row in this suite -- on the one editor carried as the positive control,
 * so the run reported a broken write where the write had never been reached.
 * (Quill, ProseMirror and Lexical put their placeholders in CSS ::before or a
 * sibling node, so none of them showed it.)
 */
const userText = (page) => page.evaluate(() => {
  const c = window.__ed.cloneNode(true);
  for (const n of c.querySelectorAll('[contenteditable="false"], [data-slate-placeholder], [aria-hidden="true"]')) {
    n.remove();
  }
  return c.textContent.replace(/[\uFEFF\u200B]/g, "").trim();
});

async function typeJittered(page, s) {
  for (const ch of s) {
    await page.keyboard.type(ch);
    await sleep(jitter());
  }
}

/**
 * Put the caret at a text offset and let the editor read it.
 *
 * Through content.js's own helper, so it lands where the splice's arithmetic
 * would put it, and with a real pause afterwards: an editor learns about a
 * selection from `selectionchange`, which is asynchronous, so setting it and
 * writing in the same tick measures the editor's STALE selection instead.
 */
async function putCaretAt(page, offset) {
  await page.evaluate((n) => {
    const r = window.__prooferSentence.snCollapsedRange(window.__ed, n);
    const s = window.getSelection();
    if (r && s) { s.removeAllRanges(); s.addRange(r); }
  }, offset);
  await sleep(400);
}

/** Run the SHIPPING recipe selection, exactly as applySentence does. */
function splice(page, start, end, replacement) {
  return page.evaluate(async (a) => {
    const P = window.__prooferSentence, el = window.__ed;
    if (P.editorAdapterFor(el)?.family !== "Slate") return P.spliceSentenceVia(el, a.start, a.end, a.replacement);
    const intent = [], dispatch = el.dispatchEvent;
    el.dispatchEvent = function(e) {
      const observation = e.type === "beforeinput" && !e.isTrusted ? {
        type: e.inputType, ranges: e.getTargetRanges().length, data: e.data,
      } : null;
      const value = dispatch.call(this, e);
      if (observation) intent.push({ ...observation, cancelled: e.defaultPrevented });
      return value;
    };
    try { return { ...await P.spliceSentenceVia(el, a.start, a.end, a.replacement), intent }; }
    finally { el.dispatchEvent = dispatch; }
  }, { start, end, replacement });
}

// The event itself supplies the oracle, independently of the splice's report.
// A version or host allowlist would silently accept a changed live deployment.
// Mutant: delete spliceSentenceSlate's defaultPrevented check. Red: honest
// synchronous refusal/window assertions and [7]'s exact burst text.
function assertWrite(t, res, label) {
  if (t.family !== "Slate") {
    ok(res.ok === true && res.outcome === "landed", `${label} (${JSON.stringify(res)})`);
    return false;
  }
  const event = res.intent?.[0];
  ok(res.intent?.filter(e => e.ranges === 1).length === 1 && event.type === "insertReplacementText" && event.ranges === 1,
    `${label}: exactly one range-bearing intent reached the real Slate handler`);
  const refused = event?.cancelled === false;
  ok(refused
    ? res.ok === false && res.outcome === "failed-transport" && res.reason === "untrusted-rejected" && res.window === null && res.intent.length === 1
    : res.ok === true && res.outcome === "landed",
    `${label}: ${refused ? "uncancelled intent safely refused" : "cancelled intent landed"} (${JSON.stringify(res)})`);
  return refused;
}

const TYPO = "The techncian arrived early.";
const FIXED = "The technician arrived early.";

// --- Reachability ----------------------------------------------------------
console.log("\nThe write, against every certified editor\n" + "=".repeat(72));
console.log(`  Chrome: ${chrome.path} (${chrome.source})`);
console.log(`  Content: ${CONTENT_PATH}\n`);

if (process.argv.includes("--source-probe") || process.argv.includes("--source-test")) {
  try {
    if (process.argv.includes("--source-probe")) await sourceProbe();
    else await sourceRegression();
  } finally {
    await browser.close();
  }
  console.log(`\n${pass} passed, ${fail} failed — content: ${CONTENT_PATH}`);
  process.exit(fail ? 1 : 0);
}
await sourceRegression();

// --- [0] The table covers the registry -------------------------------------
//
// TARGETS is a SECOND hand-maintained table, and the header of this file claims
// a registry row is backed by a suite row. Nothing enforced that: adding an
// editor to SN_TRANSPORTS and forgetting this file left the suite green while
// the new family shipped unmeasured — which is precisely "an assertion nobody
// checked", one level up. SN_TRANSPORTS and browser injection use the same
// selected snapshot from content-sandbox, including PROOFER_CONTENT overrides.
{
  console.log("[0] Registry coverage");
  for (const row of SN_TRANSPORTS) {
    const covered = TARGETS.filter((t) => t.family === row.family);
    ok(covered.length > 0 && covered.every((t) => t.recipe === row.recipe),
       `SN_TRANSPORTS row ${row.family}/${row.recipe} has a target `
       + `(${covered.map((t) => `${t.label || t.family}:${t.recipe}`).join(", ") || "NONE"})`);
  }
  const known = new Set(SN_TRANSPORTS.map((t) => t.family));
  const orphans = TARGETS.filter((t) => !known.has(t.family)).map((t) => t.label || t.family);
  ok(orphans.length === 0, `and no target names a family the registry dropped (${orphans})`);
  // Rows filtered out by PROOFER_EDITORS are still coverage gaps for THIS run.
  if (rows.length !== TARGETS.length) {
    notRun.push(`filtered out: ${TARGETS.filter((t) => !rows.includes(t))
      .map((t) => t.label || t.family).join(", ")}`);
  }
}

const skipped = [];
for (const t of rows) {
  const probe = await browser.newPage();
  let why = null;
  try {
    await probe.goto(t.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Reachable but no editor is NOT a skip: the selector is this suite's
    // contract with the demo site, and a quiet 77 would let a moved page sit
    // unnoticed behind the outage excuse.
    const has = await probe.waitForSelector(t.selector, { timeout: 20000 })
      .then(() => true, () => false);
    if (!has) {
      ok(false, `${t.label || t.family}: ${t.url} loaded but has no ${t.selector} `
        + `-- the example page moved, re-point the row`);
      t.broken = true;
    }
  } catch (e) {
    why = String(e.message || e).split("\n")[0];
  }
  await probe.close();
  if (why) { t.unreachable = why; skipped.push(t); }
}

// --- The rows --------------------------------------------------------------
for (const t of rows) {
  const name = t.label || t.family;
  console.log(`\n${name}  [${t.recipe}]${t.control ? "  (transport acceptance observed per write)" : ""}`);
  console.log(`  ${t.url}${t.quirk ? `   — ${t.quirk}` : ""}`);
  if (t.unreachable) { console.log(`  SKIP: unreachable (${t.unreachable})`); continue; }
  if (t.broken) continue;

  const row = { name, text: 0, caret: 0, refusals: 0, errors: [] };
  results.push(row);

  // --- [1] Growth: the correction lands, survives, and the caret is right ---
  //
  // The whole suite in one scenario. Everything before the last assertion
  // passed with the WRONG recipe too -- that is what makes the last one the
  // only one that means anything.
  try {
    const { page, errors } = await session(t);
    console.log(`  [1] ${name}: a correction that grows the sentence`);

    // The registry decides the recipe from the fingerprint, on the real page.
    const adapter = await page.evaluate(() =>
      window.__prooferSentence.editorAdapterFor(window.__ed));
    ok(adapter && adapter.family === t.family && adapter.recipe === t.recipe,
       `the registry routes it as ${t.family}/${t.recipe} (${JSON.stringify(adapter)})`);

    await typeJittered(page, TYPO + " Then we");
    await sleep(300);
    const before = await dom(page);
    ok(before === TYPO + " Then we", `typed into the real editor: ${JSON.stringify(before)}`);

    const res = await splice(page, 0, TYPO.length, FIXED);
    const refused = assertWrite(t, res, "the splice reports the observed transport honestly");
    const expected = refused ? TYPO : FIXED;
    await sleep(350);
    const mid = await dom(page);
    // Exact: no duplicated, partial or transformed replacement.
    if (ok(mid === expected + " Then we", `exactly the expected text, once: ${JSON.stringify(mid)}`)) {
      row.text++;
    }

    // THE assertion. And it is also the caret assertion: a caret left at the
    // end of the correction puts these characters inside the previous
    // sentence, which exact equality catches.
    await typeJittered(page, " shipped");
    await sleep(400);
    const after = await dom(page);
    if (ok(after === expected + " Then we shipped",
           `it survives the next keystrokes, at the right offset: ${JSON.stringify(after)}`)) {
      row.caret++;
    }
    ok(errors.length === 0, `no page exception during the write (${JSON.stringify(errors)})`);
    row.errors.push(...errors);
    await page.close();
  } catch (e) { ok(false, `[1] ${name}: ${e.message}`); }

  // --- [2] Shrinkage -------------------------------------------------------
  //
  // A separate scenario because the caret arithmetic is signed: a correction
  // that SHORTENS the sentence moves the caret backwards, and an off-by-delta
  // that is invisible when the text grows is not when it shrinks.
  try {
    const { page, errors } = await session(t);
    console.log(`  [2] ${name}: a correction that shortens the sentence`);
    const LONG = "The team have been working on it.";
    const SHORT = "The team has been working on it.";
    await typeJittered(page, LONG + " Then we");
    await sleep(300);
    const res = await splice(page, 0, LONG.length, SHORT);
    const refused = assertWrite(t, res, "shrinkage transport");
    await sleep(350);
    await typeJittered(page, " shipped");
    await sleep(400);
    const after = await dom(page);
    ok(after === (refused ? LONG : SHORT) + " Then we shipped",
       `shrinkage survives at the right offset: ${JSON.stringify(after)}`);
    ok(errors.length === 0, `no page exception (${JSON.stringify(errors)})`);
    await page.close();
  } catch (e) { ok(false, `[2] ${name}: ${e.message}`); }

  // --- [3] Undo is a write like any other ----------------------------------
  //
  // Not Ctrl+Z: sentence mode never promised the host editor's history stack,
  // and after the user types on it takes TWO to reach the splice. What is
  // promised is doSentenceUndo, which goes back through the same recipe -- so
  // it has to put the original back WITHOUT eating what was typed since.
  try {
    const { page, errors } = await session(t);
    console.log(`  [3] ${name}: undo restores the original and keeps later typing`);
    await typeJittered(page, TYPO + " Then we");
    await sleep(300);
    const forward = await splice(page, 0, TYPO.length, FIXED);
    const forwardRefused = t.family === "Slate" && assertWrite(t, forward, "forward write before inverse");
    await sleep(350);
    await typeJittered(page, " shipped");
    await sleep(350);
    if (forwardRefused) {
      ok(await dom(page) === TYPO + " Then we shipped", "refused forward write preserves later typing");
      // A refusal arms no Escape slot (offline [19/20]). Keep exercising the
      // reverse transport here, from a correction entered by the USER.
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.type(FIXED + " Then we shipped"); await sleep(350);
    }
    const undone = await splice(page, 0, FIXED.length, TYPO);
    const reverseRefused = assertWrite(t, undone, "inverse transport");
    const restoredHead = reverseRefused ? FIXED : TYPO;
    await sleep(400);
    ok((await dom(page)) === restoredHead + " Then we shipped",
       `the original is back and the later typing is intact: ${JSON.stringify(await dom(page))}`);
    // And it has to SURVIVE, for the same reason the forward write does: an
    // undo that only reaches the DOM leaves the editor's model holding the
    // correction, which is the same divergence in the other direction.
    await typeJittered(page, " out");
    await sleep(400);
    const after = await dom(page);
    ok(after === restoredHead + " Then we shipped out",
       `and the undo survives the next keystrokes: ${JSON.stringify(after)}`);
    ok(errors.length === 0, `no page exception (${JSON.stringify(errors)})`);
    await page.close();
  } catch (e) { ok(false, `[3] ${name}: ${e.message}`); }

  // --- [4] Refusals are ATOMIC ---------------------------------------------
  //
  // "Neither DOM nor model changes" -- no "delete succeeded, insert failed".
  // Two shapes: offsets that no longer describe the text, and a range crossing
  // a formatting run (which is what a mention pill and an emoji image look like
  // to snRangeIsUniform).
  try {
    const { page, errors } = await session(t);
    console.log(`  [4] ${name}: a refusal changes nothing`);
    await typeJittered(page, "First paragraph here.");
    await page.keyboard.press("Enter");
    await sleep(200);
    await typeJittered(page, TYPO + " Then we");
    await sleep(350);
    const untouched = await dom(page);
    const live = await text(page);

    // Offsets that run past the end of the text. There is no range to build, so
    // nothing can be written -- the shape a stale anchor takes once the field
    // has shrunk under a response in flight.
    const past = await splice(page, 5, live.length + 40, FIXED);
    ok(past.ok === false && past.outcome === "refused-precondition" && past.reason === "no-range",
       `offsets past the end are a precondition refusal, not a transport failure `
       + `(${JSON.stringify(past)})`);
    if (past.ok === false) row.refusals++;

    // A span crossing a BLOCK boundary. snText synthesises a "\n" there and
    // range.toString() does not, so the two disagree -- which is exactly the
    // case where replacing the range would collapse the page's own markup.
    const across = await splice(page, 0, live.indexOf(TYPO) + TYPO.length, FIXED);
    ok(across.ok === false && across.outcome === "refused-precondition",
       `a span crossing a block boundary is refused (${JSON.stringify(across)})`);
    if (across.ok === false) row.refusals++;

    await sleep(250);
    ok((await dom(page)) === untouched,
       `and the field is byte-for-byte unchanged after both: ${JSON.stringify(await dom(page))}`);

    // A bold run inside the sentence. Replacing the range would flatten it,
    // which is a formatting change nobody asked for in a sentence the user
    // only wanted spellchecked.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await sleep(220);
      if (!(await userText(page))) break;
    }
    // Ctrl+B by default -- a real keystroke, like everything else here. Trix
    // does not bind it in the build its homepage serves (measured: the markup
    // comes back plain), so a target may name its own way in. Without the hook
    // this branch SKIPPED, and the bold-run refusal is the assertion that
    // matters most on the contenteditable path.
    const bold = async (on) => {
      if (t.boldVia) return page.evaluate(`(${t.boldVia})(${on})`);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyB");
      await page.keyboard.up("Control");
    };
    await page.keyboard.type("The ");
    await bold(true);
    await page.keyboard.type("techncian");
    await bold(false);
    await page.keyboard.type(" arrived early.");
    await sleep(400);
    const bolded = await page.evaluate(() => ({
      text: window.__prooferSentence.snText(window.__ed).replace(/\n$/, ""),
      html: window.__ed.innerHTML,
      // Did the editor actually produce a bold run? If not, this assertion is
      // vacuous and must say so rather than passing for the wrong reason.
      hasBold: !!window.__ed.querySelector("strong, b, [style*='font-weight'], .ql-bold"),
    }));
    // Trix emits the space in front of a bold run as an NBSP some of the time
    // -- measured, 1 run in 5, "The&nbsp;<strong>techncian</strong>" -- so a
    // literal startsWith() on the typed sentence sent this branch to SKIP at
    // random, on the assertion that matters most on this path. NBSP is one
    // character like the space it replaced, so folding it changes no offset;
    // and the offset is taken from the live text rather than assumed to be 0.
    const at = bolded.text.replace(/\u00a0/g, " ").indexOf(TYPO);
    if (bolded.hasBold && at >= 0) {
      const across = await splice(page, at, at + TYPO.length, FIXED);
      ok(across.ok === false && across.reason === "non-uniform-range",
         `a range crossing a bold run is refused (${JSON.stringify(across)})`);
      await sleep(250);
      const html = await page.evaluate(() => window.__ed.innerHTML);
      ok(html === bolded.html, "and the markup is untouched, not flattened");
      if (across.ok === false) row.refusals++;
    } else {
      console.log(`    SKIP: could not produce a bold run here `
        + `(${JSON.stringify(bolded.text.slice(0, 40))}, bold=${bolded.hasBold})`);
      notRun.push(`${name} [4] bold-run refusal`);
    }
    ok(errors.length === 0, `no page exception (${JSON.stringify(errors)})`);
    await page.close();
  } catch (e) { ok(false, `[4] ${name}: ${e.message}`); }

  // --- [5] An emoji in the sentence: correct, or refuse -- never damage -----
  //
  // A surrogate pair is one user-perceived character and two code units, and
  // some editors replace it with an <img> that carries no text at all. Either
  // outcome is acceptable; silently deleting it is not.
  try {
    const { page, errors } = await session(t);
    console.log(`  [5] ${name}: a sentence containing an emoji`);
    const E = "The techncian arrived early \u{1F600}.";
    const EF = "The technician arrived early \u{1F600}.";
    await page.keyboard.type("The techncian arrived early ");
    // sendCharacter, not execCommand: an execCommand insert is exactly the
    // foreign DOM mutation Slate reverts, so it would set the fixture up wrong
    // on the one editor that most needs this checked.
    await page.keyboard.sendCharacter("\u{1F600}");
    await sleep(250);
    await page.keyboard.type(". Then we");
    await sleep(400);
    const live = await text(page);
    if (live.startsWith(E)) {
      const res = await splice(page, 0, E.length, EF);
      if (t.family === "Slate") assertWrite(t, res, "emoji transport");
      await sleep(350);
      // Typed on, like every other scenario here. Reading the DOM straight
      // after the splice is the check that passed for the whole time the write
      // was silently broken.
      await typeJittered(page, " shipped");
      await sleep(400);
      const after = await dom(page);
      const head = res.ok ? EF : E;
      ok(after === head + " Then we shipped",
         res.ok ? `corrected around the emoji and survived: ${JSON.stringify(after)}`
                : `refused (${res.reason}) and left it alone: ${JSON.stringify(after)}`);
      ok(after.includes("\u{1F600}"), "the emoji is still there either way");
    } else {
      console.log(`    SKIP: the editor did not take the emoji as text `
        + `(${JSON.stringify(live.slice(0, 40))})`);
      notRun.push(`${name} [5] emoji`);
    }
    ok(errors.length === 0, `no page exception (${JSON.stringify(errors)})`);
    await page.close();
  } catch (e) { ok(false, `[5] ${name}: ${e.message}`); }

  // --- [6] A sentence in the SECOND block ----------------------------------
  //
  // Block start and end in one: the offsets now run through a boundary
  // buildSegmentsForElement synthesises a "\n" for, which is exactly where a
  // delta-based caret restore goes wrong by one.
  try {
    const { page, errors } = await session(t);
    console.log(`  [6] ${name}: a sentence in the second block`);
    await typeJittered(page, "First paragraph here.");
    await page.keyboard.press("Enter");
    await sleep(250);
    await typeJittered(page, TYPO + " Then we");
    await sleep(350);
    const live = await text(page);
    const at = live.indexOf(TYPO);
    ok(at > 0, `the second block starts at ${at}: ${JSON.stringify(live)}`);
    const res = await splice(page, at, at + TYPO.length, FIXED);
    const refused = assertWrite(t, res, "second-block transport");
    await sleep(350);
    await typeJittered(page, " shipped");
    await sleep(400);
    const after = await text(page);
    ok(after.endsWith((refused ? TYPO : FIXED) + " Then we shipped") && after.startsWith("First paragraph here."),
       `both blocks are intact and the caret was right: ${JSON.stringify(after)}`);
    ok(errors.length === 0, `no page exception (${JSON.stringify(errors)})`);
    await page.close();
  } catch (e) { ok(false, `[6] ${name}: ${e.message}`); }

  // --- [7] BURST: a write that lands while the user is typing ---------------
  //
  // The column the idle scenarios cannot see. INTENT fired mid-burst DELETES a
  // character the user typed on the editors that ignore it -- Quill 7/14,
  // TipTap 10/14, Lexical 5/14, against 24/24 intact with no splice at all --
  // which is why "try INTENT and fall back" is not a safe probe and why the
  // recipe is chosen up front.
  //
  // Every sentence must come out as EXACTLY what was typed or EXACTLY its
  // correction. Anything else is a character the user lost.
  try {
    const { page, errors } = await session(t);
    console.log(`  [7] ${name}: a write during a typing burst`);
    const TAIL = " Then we shipped it out to everyone.";
    await typeJittered(page, TYPO);
    // Fire mid-burst, without waiting: the tail keeps being typed underneath.
    const typing = typeJittered(page, TAIL);
    await sleep(120);
    const res = await splice(page, 0, TYPO.length, FIXED);
    if (t.family === "Slate") assertWrite(t, res, "burst transport");
    await typing;
    await sleep(600);
    const after = await dom(page);
    const head = res.ok ? FIXED : TYPO;
    ok(after === head + TAIL,
       `${res.ok ? "corrected" : `refused (${res.reason})`} without losing a character: `
       + JSON.stringify(after));
    // Not losing a character is necessary and not sufficient. Refusing every
    // mid-burst write also loses no characters, and would pass the line above
    // while the feature did nothing -- so a MUTATION row, whose whole claim is
    // that it needs no pause, has to actually LAND here. INTENT is exempt by
    // design: its selection window is precisely what a keystroke aborts.
    if (t.recipe === "mutation") {
      ok(res.ok === true,
         `a MUTATION transport lands mid-burst rather than refusing `
         + `(${JSON.stringify(res)})`);
    }
    ok(errors.length === 0, `no page exception (${JSON.stringify(errors)})`);
    await page.close();
  } catch (e) { ok(false, `[7] ${name}: ${e.message}`); }

  // --- [8] A sentence that FILLS its block ---------------------------------
  //
  // Every scenario above types a tail after the sentence, and that one habit
  // hid a whole class of failure for as long as this file has existed: a write
  // whose range covers ALL of a block's text is a NODE-level DOM mutation
  // rather than an edit inside a text node, and two certified families
  // reconcile that away, silently and in opposite directions.
  //
  //   Lexical  dropped it outright -- execCommand returned true, the DOM never
  //            changed. 6/6 at every delay from 0 to 600ms after the last
  //            keystroke, and it lands with ONE character of tail at either
  //            end, so coverage is the variable and timing is not.
  //   Draft    duplicated the corrected block over the NEXT one, destroying a
  //            paragraph of the user's own text.
  //
  // It is not an exotic shape: it is a chat message, and every paragraph
  // holding one sentence. In the shipping pipeline it was 0/8 on Lexical --
  // the write vanished and the field was blocked for the session -- while
  // every scenario here passed, because every scenario here typed " Then we"
  // first.
  //
  // spliceSentenceCE now narrows the write to the span that actually differs,
  // which keeps it inside the text node. This scenario is what says so.
  try {
    const { page, errors } = await session(t);
    console.log(`  [8] ${name}: a sentence that fills its block`);

    // (a) the whole document is the sentence.
    await typeJittered(page, TYPO);
    await sleep(350);
    const solo = await splice(page, 0, TYPO.length, FIXED);
    if (t.family === "Slate") assertWrite(t, solo, "whole-document transport");
    await sleep(350);
    if (t.recipe === "mutation") {
      ok(solo.ok === true, `it lands with no tail to write into (${JSON.stringify(solo)})`);
    }
    await typeJittered(page, " Then we");
    await sleep(400);
    const soloAfter = await dom(page);
    ok(soloAfter === (solo.ok ? FIXED : TYPO) + " Then we",
       `${solo.ok ? "corrected" : `refused (${solo.reason})`} and survives the next keystrokes: `
       + JSON.stringify(soloAfter));
    await page.close();

    // (b) the sentence is all of the FIRST of two blocks, with the caret back
    // inside it. The second block is the assertion: a whole-block write used to
    // reach Draft's block-replacement path and put a second copy of the
    // correction where the user's next paragraph was.
    //
    // The caret is deliberately RETURNED to the corrected block here, because
    // leaving it in block 2 measures a SECOND and unrelated hazard -- see [9],
    // which is where that one is pinned.
    const two = await session(t);
    await typeJittered(two.page, TYPO);
    await two.page.keyboard.press("Enter");
    await sleep(250);
    await typeJittered(two.page, "Second paragraph here.");
    await sleep(350);
    await putCaretAt(two.page, TYPO.length);
    const live = await text(two.page);
    const res = await splice(two.page, 0, TYPO.length, FIXED);
    if (t.family === "Slate") assertWrite(t, res, "whole-block transport");
    await sleep(400);
    if (t.recipe === "mutation") {
      ok(res.ok === true, `and it lands when the block has a neighbour (${JSON.stringify(res)})`);
    }
    const after = await text(two.page);
    ok(after.endsWith("Second paragraph here."),
       `the NEXT block is still the user's own text: ${JSON.stringify(after)}`);
    ok(after.startsWith(res.ok ? FIXED : TYPO),
       `and the first block is ${res.ok ? "corrected" : "untouched"}: ${JSON.stringify(after)}`);
    ok(after.length === live.length + (res.ok ? FIXED.length - TYPO.length : 0),
       `with nothing duplicated (${live.length} -> ${after.length})`);
    ok(errors.length === 0 && two.errors.length === 0,
       `no page exception (${JSON.stringify([...errors, ...two.errors])})`);
    await two.page.close();
  } catch (e) { ok(false, `[8] ${name}: ${e.message}`); }

  // --- [9] The caret is in ANOTHER block when the write lands --------------
  //
  // The shape of a slow response: the sentence finished, the user pressed Enter
  // and typed a whole paragraph, and only then did the correction come back.
  // The anchor permits it -- it requires the caret to be at or after the
  // sentence, not in the same block as it.
  //
  // FIVE FAMILIES LAND IT CLEANLY. DRAFT DESTROYS THE PARAGRAPH: block 1 is
  // corrected and block 2 is replaced by a second copy of the correction. It is
  // NOT the whole-block hazard [8] covers -- narrowing the write does not
  // change it, and putting the caret back in block 1 makes it clean, 1/1 each
  // way -- and it is not caused by the sentence path: the same call, at the same
  // moment, with the caret elsewhere. Through the shipping pipeline (type,
  // Enter, keep typing) it did NOT reproduce, so the condition is narrower than
  // "the caret is in another block" and is not characterised.
  //
  // `expectNeighbour` therefore PINS WHAT WAS MEASURED, and Draft's cell is a
  // defect recorded, not a behaviour approved: sentence mode can destroy a
  // paragraph of the user's own text there. A change in EITHER direction is a
  // failure here -- Draft starting to keep the block is the fix, and should be
  // promoted to the plain assertion the others get.
  try {
    const { page, errors } = await session(t);
    console.log(`  [9] ${name}: the caret is in another block when the write lands`);
    await typeJittered(page, TYPO);
    await page.keyboard.press("Enter");
    await sleep(250);
    await typeJittered(page, "Second paragraph here.");
    await sleep(350);
    const res = await splice(page, 0, TYPO.length, FIXED);
    await sleep(450);
    const after = await text(page);
    const kept = after.includes("Second paragraph here.");
    const expectKept = t.expectNeighbour !== "lost";
    ok(kept === expectKept,
       expectKept
         ? `the user's next paragraph survives the write: ${JSON.stringify(after)}`
         : `KNOWN DEFECT, pinned: the next paragraph is destroyed here, and this `
           + `run agrees with the measurement: ${JSON.stringify(after)}`);
    // Whatever happened to the neighbour, the transport must not claim success.
    // This is the half that WAS wrong: execCommand returned true, the recipe
    // reported `landed`, and the caller then blamed the page for "reconciling"
    // a write the editor had mangled.
    if (t.family === "Slate") {
      const refused = assertWrite(t, res, "other-block transport");
      ok(after === (refused ? TYPO : FIXED) + "\nSecond paragraph here.",
        `both Slate blocks have exactly the expected text: ${JSON.stringify(after)}`);
      await typeJittered(page, " More"); await sleep(300);
      ok(await text(page) === after + " More", "typing stays in the user's second block");
    } else {
      ok(kept ? res.ok === true : res.ok === false,
         `and the transport reports it honestly (${JSON.stringify(res)})`);
    }
    ok(errors.length === 0, `no page exception (${JSON.stringify(errors)})`);
    await page.close();
  } catch (e) { ok(false, `[9] ${name}: ${e.message}`); }
}

await browser.close();

console.log("\n" + "=".repeat(72));
for (const r of results) {
  console.log(`  ${r.name.padEnd(22)} text ${r.text}/1   caret ${r.caret}/1   `
    + `refusals ${r.refusals}   page errors ${r.errors.length}`);
}
if (skipped.length) {
  console.log(`\n  SKIPPED (unreachable): ${skipped.map((t) => t.label || t.family).join(", ")}`);
  console.log("  Those editors were NOT exercised by this run.");
}
if (notRun.length) {
  console.log(`\n  CHECKS NOT RUN: ${notRun.join(", ")}`);
  console.log("  A branch that could not set itself up proves nothing, and used to");
  console.log("  print SKIP into a green run.");
}
console.log(`\n${pass} passed, ${fail} failed — content: ${CONTENT_PATH}`);
if (fail) process.exit(1);
if ((skipped.length || notRun.length) && process.env.PROOFER_EDITORS_OPTIONAL !== "1") {
  process.exit(EXIT_SKIPPED);
}
process.exit(0);
