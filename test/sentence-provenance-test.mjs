/**
 * Does the idle path send text the user did not type?
 *
 *   cd test && node sentence-provenance-test.mjs
 *
 * The suspected gap, from code inspection: a trusted keystroke arms the 600ms
 * idle timer in `onSentenceInput`; the page then assigns `el.value` -- which
 * fires NO input event -- before the timer fires. The bulk-size diff
 * (`sentenceEditSize` against `st.lastText`, threshold SENTENCE_BULK_CHARS=8)
 * is the only provenance check the trigger has, and it lives in the input
 * handler. With no input event there is nothing to run it, so `maybeFireSentence`
 * reads `snText(el)` live and segments whatever the page put there.
 *
 * Every keystroke here is a REAL CDP one, for the same reason
 * sentence-typing-test.mjs uses them: `handleInput` drops `isTrusted: false`,
 * so synthetic events cannot drive this code at all. Keystroke spacing is
 * jittered -- a fixed cadence hides phase-dependent behaviour completely (see
 * "Tuning a timing constant that is standing in for a missing mechanism").
 *
 * The page mutation is scheduled in-page and both it and every outgoing message
 * are stamped with performance.now(), so the ordering is measured rather than
 * assumed from the nominal delay.
 *
 *   PROOFER_CONTENT=<path>   run against a different content.js — how the
 *                            pre-fix control was taken
 *   PROOFER_SEED=<n>         replay a run's exact typing rhythm
 *
 * Pre-fix result, for the record: [P2] and [P3] were 0/16, page-authored text
 * sent at every delay and silently rewritten in the field. [P6] is the control
 * that keeps the fix honest — the same field contents typed by a real user.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import http from "http";
import { chromePath } from "./lib/chrome.mjs";

const EXT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Jitter for coverage, determinism for the bug report. A red produced by an
// unrepeatable rhythm is the hardest kind to hand back, so the stream is seeded
// and the seed is printed BEFORE anything that can exit early.
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
console.log(`\n[seed ${SEED}]  PROOFER_SEED=${SEED} replays this run's typing exactly`);

let pass = 0, fail = 0;
const ok = (cond, label) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}`);
  cond ? pass++ : fail++;
};

const CONTENT = fs.readFileSync(process.env.PROOFER_CONTENT || path.join(EXT, "content.js"), "utf8");
const STYLES = fs.readFileSync(path.join(EXT, "styles.css"), "utf8");

// Keyed by the exact sentence the trigger sends. Each of these is a sentence
// the USER never typed in the injection trials -- so an entry firing at all is
// the finding, and an entry being APPLIED is the same finding one stage worse.
const CORRECTIONS = {
  "The techncian arrived early.": "The technician arrived early.",
  "This sentance is wrong.": "This sentence is wrong.",
  "Please wire the funds to the acount today.": "Please wire the funds to the account today.",
  "Internal only, we are cutting the team next month.":
    "Internal only: we are cutting the team next month.",
  "We recieved it.": "We received it.",
  // [P3c]'s injected fragment, once the user's terminator completes it. Without
  // an entry here the stub answers `noChanges` and the field assertion passes
  // even on code that sent the sentence -- a false green that hid the whole
  // point of the case behind a table lookup.
  "The leaked pge sentence is here.": "The leaked page sentence is here.",
  // [P3g]. Kept SHORT on purpose: the floor it establishes has to be smaller
  // than the sentence the user then inserts in front of it, or the watermark
  // never advances past the floor and the bypass is not reproduced at all.
  "The leaked pge is here.": "The leaked page is here.",
};

const STUB = (apply) => `
window.__sent = [];
window.__mutAt = null;
window.__store = { disabledSites: [], sentenceDebug: false };
window.__corrections = ${JSON.stringify(CORRECTIONS)};
window.__delayMs = 20;
// Every trusted input event the page sees, so a probe can ask whether a
// page-driven edit reached handleInput at all rather than inferring it.
window.__inputs = [];
document.addEventListener("input", (e) => {
  window.__inputs.push({ trusted: e.isTrusted, inputType: e.inputType, t: performance.now() });
}, true);
window.chrome = {
  runtime: {
    id: "test-ext",
    lastError: undefined, onMessage: { addListener() {} },
    sendMessage: (msg, cb) => {
      const ta = document.activeElement;
      window.__sent.push(Object.assign({}, msg, {
        __field: ta && ta.tagName === "TEXTAREA" ? ta.value : null,
        __t: performance.now(),
      }));
      setTimeout(() => {
        if (msg.type === "SENTENCE_CONSENT") return cb({ ok: true, allowed: true, apply: ${apply} });
        if (msg.type === "SENTENCE_REWRITE") {
          const fix = window.__corrections[msg.sentence];
          if (!fix) return cb({ ok: true, noChanges: true });
          return cb({ ok: true, rewritten: fix, apply: ${apply} });
        }
        cb({ ok: true });
      }, msg.type === "SENTENCE_REWRITE" ? window.__delayMs : 20);
    },
  },
  storage: {
    local: { get: (d, cb) => cb({ ...d, ...window.__store }), set: (o, cb) => cb && cb() },
    onChanged: { addListener: () => {} },
  },
};
`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><body style="padding:20px">
<textarea id="ta" style="width:520px;height:120px;font:14px monospace"></textarea>
<!-- A certified fingerprint, because an unrecognised contenteditable is denied
     outright and would prove nothing. Shaped only: there is no Slate model
     behind it, so it can answer "does the veto read through snText" and
     nothing whatever about a real editor's write path. -->
<div id="slate" contenteditable="true" data-slate-editor="true" style="width:520px;min-height:60px;font:14px monospace;border:1px solid #ccc"></div>
</body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: await chromePath(),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--window-size=1280,900"],
});

async function freshPage(apply) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on("pageerror", (e) => console.error("  PAGE ERROR:", e.message));
  await page.evaluateOnNewDocument(STUB(apply));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.addStyleTag({ content: STYLES });
  await page.evaluate(CONTENT);
  await sleep(150);
  return page;
}

/**
 * Jittered keystrokes. A fixed cadence can sit entirely inside one phase.
 *
 * Deliberately does NOT sleep after the final character. It used to, and that
 * silently moved every "inside the 600 ms window" trial 15-44 ms later than its
 * label before CDP overhead was even counted -- so the +520 ms arm was landing
 * at 535-564 ms+ and a mutation that arrived AFTER the window would have passed
 * as a clean result on vulnerable code. The nominal delay is now measured
 * against the last observed input rather than trusted; see assertInWindow.
 */
async function typeJittered(page, text) {
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    if (i < text.length - 1) await sleep(15 + Math.floor(rand() * 30));
  }
}

// `priorContext` is kept, not dropped. Dropping it made every "no page text
// reached the model" assertion narrower than it read: the target sentence is
// only half of what goes out, and up to 2500 characters of preceding text goes
// with it. That is a real channel -- context exists precisely to steer an
// ambiguous correction -- so the suite has to be able to see it.
const requests = (page) => page.evaluate(() =>
  window.__sent.filter((m) => m.type === "SENTENCE_REWRITE")
    .map((m) => ({ sentence: m.sentence, trigger: m.trigger, t: m.__t,
                   priorContext: m.priorContext || "" })));

const val = (page, sel = "#ta") => page.evaluate((s) => {
  const el = document.querySelector(s);
  return "value" in el ? el.value : el.innerText;
}, sel);

// Read out of the SHIPPING content.js rather than copied. A duplicated timing
// constant is the same defect as a second copy of a guard: retune the window in
// content.js and this suite goes on asserting the old one, green, while every
// "inside the window" claim it makes has quietly become false.
const SENTENCE_IDLE_MS = await (async () => {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${PORT}/`);
  await p.evaluate(CONTENT);
  const v = await p.evaluate(() => globalThis.__prooferSentence.SENTENCE_IDLE_MS);
  await p.close();
  if (typeof v !== "number" || !v) throw new Error("could not read SENTENCE_IDLE_MS from content.js");
  return v;
})();
console.log(`[SENTENCE_IDLE_MS=${SENTENCE_IDLE_MS} read from content.js]`);

/**
 * The inside-the-window claim, asserted from observed timestamps rather than
 * from the nominal delay. Without this the timing data was collected and never
 * used, which is the same defect class as a probe section that reports instead
 * of gating.
 */
function assertInWindow(r, label) {
  const lastInput = r.inputs.filter((i) => i.trusted).pop();
  if (!lastInput || r.mutAt == null) {
    ok(false, `${label}: no timing evidence (input=${!!lastInput} mutAt=${r.mutAt})`);
    return;
  }
  const gap = r.mutAt - lastInput.t;
  ok(gap > 0 && gap < SENTENCE_IDLE_MS,
     `${label}: mutation landed ${gap.toFixed(0)}ms after the last input — inside the ${SENTENCE_IDLE_MS}ms window`);
}

/**
 * Type, then mutate the field from page script at `delay` ms after the last
 * keystroke, then wait out the idle window and the round trip.
 *
 * `mutation` is a source string evaluated in the page with `ta` in scope.
 */
async function trial({ typed, mutation, delay, apply = true, sel = "#ta", after = null }) {
  const page = await freshPage(apply);
  await page.click(sel);
  await sleep(100);
  await typeJittered(page, typed);
  if (mutation !== null) {
    await page.evaluate((d, src, s) => {
      setTimeout(() => {
        const ta = document.querySelector(s);
        // eslint-disable-next-line no-new-func
        new Function("ta", src)(ta);
        window.__mutAt = performance.now();
      }, d);
    }, delay, mutation, sel);
  }
  await sleep(1500);
  // Some trials need a keystroke AFTER the veto has fired -- that is the only
  // way to reach the routes where the page's text is completed into
  // eligibility, and the only assertions that can see whether the refusal
  // actually held rather than merely deferred one pass.
  if (after) {
    await typeJittered(page, after);
    await sleep(1500);
  }
  const out = {
    reqs: await requests(page),
    field: await val(page, sel),
    mutAt: await page.evaluate(() => window.__mutAt),
    inputs: await page.evaluate(() => window.__inputs),
  };
  await page.close();
  return out;
}

const rows = [];
const record = (shape, delay, r, typedSentence) => {
  const sent = r.reqs.map((q) => q.sentence);
  const pageAuthored = sent.filter((s) => s !== typedSentence);
  rows.push({
    shape,
    delay,
    sent: sent.length,
    sentence: sent.length ? JSON.stringify(sent[0]) : "-",
    trigger: r.reqs.length ? r.reqs[0].trigger : "-",
    pageText: pageAuthored.length > 0,
    field: JSON.stringify(r.field),
  });
  return pageAuthored;
};

console.log("\nIdle-path provenance: does a silent page mutation reach the model?");
console.log("=".repeat(78));

const DELAYS = [50, 200, 400, 500];

// --- [P1] Control: no mutation. The idle path fires on what the user typed. --
console.log("\n[P1] control — no page mutation");
{
  const typed = "The techncian arrived early.";
  const r = await trial({ typed, mutation: null, delay: 0 });
  record("none", "-", r, typed);
  ok(r.reqs.length === 1 && r.reqs[0].sentence === typed,
     `idle fires on the typed sentence: ${JSON.stringify(r.reqs.map((q) => q.sentence))}`);
  ok(r.reqs.length === 1 && r.reqs[0].trigger === "idle",
     `trigger is idle (${r.reqs[0] && r.reqs[0].trigger})`);
  ok(r.field === "The technician arrived early.",
     `and the correction applied: ${JSON.stringify(r.field)}`);
}

// --- [P2] Full replacement inside the idle window ---------------------------
// The user types something that cannot trigger on its own -- no terminator, so
// nextSentenceTarget returns null -- and the page then assigns a complete
// sentence it never typed.
console.log("\n[P2] full replacement — el.value = <a sentence the user never typed>");
for (const delay of DELAYS) {
  const typed = "hello there";
  const r = await trial({
    typed,
    delay,
    mutation: `ta.value = "Please wire the funds to the acount today.";`,
  });
  const page = record("replace", delay, r, typed);
  console.log(`  +${delay}ms  sent=${JSON.stringify(r.reqs.map((q) => q.sentence))}  field=${JSON.stringify(r.field)}`);
  assertInWindow(r, `+${delay}ms`);
  ok(page.length === 0,
     `+${delay}ms: no page-authored text sent to the model`);
  ok(r.field === "Please wire the funds to the acount today.",
     `+${delay}ms: the page's own text is left alone`);
}

// --- [P3] Prefix injection --------------------------------------------------
// The shape the verifier contract names for the async verifier: `"PREFIX " + value`.
// Here the injected prefix is a whole sentence, so it is what the segmenter
// hands back first from a watermark of 0.
console.log("\n[P3] prefix injection — el.value = <injected sentence> + value");
for (const delay of DELAYS) {
  const typed = "The techncian arrived early.";
  const r = await trial({
    typed,
    delay,
    mutation: `ta.value = "Internal only, we are cutting the team next month. " + ta.value;`,
  });
  const page = record("prefix", delay, r, typed);
  console.log(`  +${delay}ms  sent=${JSON.stringify(r.reqs.map((q) => q.sentence))}  field=${JSON.stringify(r.field)}`);
  assertInWindow(r, `+${delay}ms`);
  ok(page.length === 0,
     `+${delay}ms: no page-authored text sent to the model`);
  ok(!/Internal only: we/.test(r.field),
     `+${delay}ms: the injected sentence is not silently rewritten`);
}

// --- [P3b] ...and the refusal must HOLD once the user types again -----------
// P2/P3 only prove one pass was refused. A refusal that merely defers is worth
// nothing: the next keystroke re-baselines and the same text goes out. This is
// also what makes the recovery half load-bearing -- the user's OWN sentence,
// typed after the injection, still has to be corrected.
console.log("\n[P3b] the refusal holds across the next keystrokes, and recovery works");
{
  const typed = "The techncian arrived early.";
  const r = await trial({
    typed,
    delay: 200,
    mutation: `ta.value = "Internal only, we are cutting the team next month. " + ta.value;`,
    after: " We recieved it.",
  });
  console.log(`  sent=${JSON.stringify(r.reqs.map((q) => q.sentence))}`);
  console.log(`  field=${JSON.stringify(r.field)}`);
  ok(!r.reqs.some((q) => /Internal only/.test(q.sentence)),
     "the injected sentence is still refused after further typing");
  ok(!/Internal only: we/.test(r.field),
     "and was never rewritten in the field");
  ok(r.reqs.some((q) => q.sentence === "We recieved it."),
     "the sentence the user typed AFTER the injection is still sent");
  ok(/We received it\./.test(r.field),
     `and corrected — the refusal is scoped, not a shutdown: ${JSON.stringify(r.field)}`);

  // The residual, ASSERTED so it cannot quietly change without being noticed.
  // The floor governs which sentence may be WRITTEN; it does not filter the
  // prior context that travels with the request. So the injected sentence does
  // reach the model, as read-only context for a target that is legitimately
  // the user's. Bounded -- only the target sentence is ever written back, and
  // context is never echoed into the field -- but not nothing, because context
  // exists precisely to steer an ambiguous correction.
  const legit = r.reqs.find((q) => q.sentence === "We recieved it.");
  ok(!!legit && /Internal only/.test(legit.priorContext),
     "KNOWN RESIDUAL: page text still travels as priorContext for a legitimate target");
}

// --- [P3c] An UNFINISHED injected sentence, completed by one keystroke ------
// The second laundering route. rederiveWatermark advances past COMPLETED
// segments only, so an injected fragment stays AHEAD of the watermark. The veto
// re-baselines it, and one later keystroke finishes it into eligibility -- at
// which point every provenance check sees a one-character diff and agrees.
console.log("\n[P3c] unfinished injection, then the user types the terminator");
{
  const typed = "hello there";
  const r = await trial({
    typed,
    delay: 200,
    // No terminator: this cannot be sent as it stands, and it is not behind the
    // watermark either.
    mutation: `ta.value = "The leaked pge sentence is here";`,
    after: ".",
  });
  console.log(`  sent=${JSON.stringify(r.reqs.map((q) => q.sentence))}`);
  console.log(`  field=${JSON.stringify(r.field)}`);
  ok(!r.reqs.some((q) => /leaked/.test(q.sentence)),
     "a page fragment completed by the user's keystroke is still refused");
  // Meaningful only because CORRECTIONS now has an entry for the completed
  // fragment: vulnerable code really does rewrite it, so this can go red.
  ok(!/leaked page sentence/.test(r.field),
     `and never rewritten: ${JSON.stringify(r.field)}`);
}

// --- [P3f] The same fragment arriving as a >8-char TRUSTED bulk insert ------
// The bulk branch sees a real input event, so provenance used to be adopted
// before the size check ever ran -- and re-deriving the watermark cannot retire
// an UNFINISHED segment. A page-called execCommand is the delivery mechanism,
// and [P5] establishes that it arrives trusted.
console.log("\n[P3f] >8-char page execCommand of an unfinished sentence, then the terminator");
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await typeJittered(page, "hello there. ");
  await page.evaluate(() => {
    document.getElementById("ta").focus();
    document.execCommand("insertText", false, "The leaked pge sentence is here");
  });
  await sleep(800);
  await typeJittered(page, ".");
  await sleep(1500);
  const reqs = await requests(page);
  const field = await val(page);
  console.log(`  sent=${JSON.stringify(reqs.map((q) => q.sentence))}`);
  console.log(`  field=${JSON.stringify(field)}`);
  rows.push({
    shape: "bulk-frag", delay: "-", sent: reqs.length,
    sentence: reqs.length ? JSON.stringify(reqs[0].sentence) : "-",
    trigger: reqs.length ? reqs[0].trigger : "-",
    pageText: reqs.some((q) => /leaked/.test(q.sentence)),
    field: JSON.stringify(field),
  });
  ok(!reqs.some((q) => /leaked/.test(q.sentence)),
     "a bulk-classified injection is fenced, not merely re-derived");
  ok(!/leaked page sentence/.test(field),
     `and never rewritten: ${JSON.stringify(field)}`);
}

// --- [P3g] The floor must survive an edit BEFORE it -------------------------
// The floor is a raw offset, and an edit before it slides the text it marks
// without changing the number. The audit's bypass, and the lengths are the
// whole mechanism rather than incidental:
//
//   * the page installs a SHORT unfinished sentence -- floor lands at 22;
//   * the user inserts a LONGER sentence at position 0;
//   * that sentence starts below the floor, so it is refused, and the refusal
//     advances the watermark to 33 -- past 22, which RETIRES the floor;
//   * the injected fragment has meanwhile slid to offset 34, out from under a
//     floor that no longer exists. Completing it sends it.
//
// A shorter inserted sentence does not reproduce it: the watermark stops below
// the floor and the stale offset still happens to cover the fragment. The first
// draft of this case made exactly that mistake and passed against the mutant.
console.log("\n[P3g] an edit before the floor must move it, not strand it");
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await typeJittered(page, "hello there");
  await page.evaluate(() => {
    document.getElementById("ta").value = "The leaked pge is here";
  });
  await sleep(900);                       // the veto fires and sets the floor
  // Longer than the floor, with real keystrokes.
  await page.keyboard.down("Control");
  await page.keyboard.press("Home");
  await page.keyboard.up("Control");
  await typeJittered(page, "We recieved the invoice yesterday. ");
  await sleep(1200);
  // ...and complete the injected fragment.
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await typeJittered(page, ".");
  await sleep(1500);
  const reqs = await requests(page);
  const field = await val(page);
  console.log(`  sent=${JSON.stringify(reqs.map((q) => q.sentence))}`);
  console.log(`  field=${JSON.stringify(field)}`);
  rows.push({
    shape: "floor-shift", delay: "-", sent: reqs.length,
    sentence: reqs.length ? JSON.stringify(reqs[0].sentence) : "-",
    trigger: reqs.length ? reqs[0].trigger : "-",
    pageText: reqs.some((q) => /leaked/.test(q.sentence)),
    field: JSON.stringify(field),
  });
  ok(!reqs.some((q) => /leaked/.test(q.sentence)),
     "the floor moved with the text and still refuses the injected fragment");
  ok(!/leaked page is here/.test(field),
     `and it was never rewritten: ${JSON.stringify(field)}`);
}

// --- [P3d] Tail mutation while a request is IN FLIGHT -----------------------
// The laundering route with no idle timer in it at all. The page changes only
// the tail AFTER job.end, so the response's anchor check -- which validates
// through job.end -- still passes; the correction lands correctly; and the
// bookkeeping that follows must not adopt the unobserved tail as observed,
// because the scan chained straight off that response would then send it.
console.log("\n[P3d] the page mutates the tail while a request is in flight");
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.evaluate(() => { window.__delayMs = 900; });
  // Fires on the next-sentence trigger (three characters past the terminator),
  // so a job is genuinely in flight rather than merely pending.
  // Three characters past the terminator, which is SENTENCE_TRIGGER_CHARS --
  // two is one short and leaves nothing in flight to mutate underneath.
  await typeJittered(page, "The techncian arrived early. Thi");
  await sleep(150);
  const inFlight = await page.evaluate(() =>
    window.__sent.filter((m) => m.type === "SENTENCE_REWRITE").length);
  await page.evaluate(() => {
    const ta = document.getElementById("ta");
    // Strictly after job.end, so the anchor's prefix check still passes.
    ta.value = ta.value + "s is a leaked page sentence.";
    window.__mutAt = performance.now();
  });
  await sleep(2500);
  const reqs = await requests(page);
  const field = await val(page);
  console.log(`  in flight at mutation: ${inFlight}`);
  console.log(`  sent=${JSON.stringify(reqs.map((q) => q.sentence))}`);
  console.log(`  field=${JSON.stringify(field)}`);
  rows.push({
    shape: "in-flight", delay: "mid", sent: reqs.length,
    sentence: reqs.length ? JSON.stringify(reqs[reqs.length - 1].sentence) : "-",
    trigger: reqs.length ? reqs[reqs.length - 1].trigger : "-",
    pageText: reqs.some((q) => /leaked/.test(q.sentence)),
    field: JSON.stringify(field),
  });
  ok(inFlight === 1, `a request really was in flight when the page mutated (${inFlight})`);
  ok(!reqs.some((q) => /leaked/.test(q.sentence)),
     "the unobserved tail is not sent by the scan chained off the response");
  ok(/The technician arrived early\./.test(field),
     `and the user's own correction still landed: ${JSON.stringify(field)}`);
  await page.close();
}

// --- [P3e] ...and the same, shaped so the CHAINED scan can fire it ----------
// This is the case that decides whether the veto may be gated on `fromIdle`.
//
// In [P3d] the injected tail has nothing after it, so the non-idle scan chained
// off the response refuses it for an unrelated reason -- `nextSentenceTarget`
// wants SENTENCE_TRIGGER_CHARS past the terminator when fromIdle is false --
// and the protection ends up coming from the re-armed idle timer. A page can
// simply supply those three characters. Then the chained scan fires
// IMMEDIATELY, on a path an idle-gated veto never inspects, and no later timer
// gets a turn.
console.log("\n[P3e] in-flight tail mutation, shaped to satisfy the non-idle trigger");
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await page.evaluate(() => { window.__delayMs = 900; });
  await typeJittered(page, "The techncian arrived early. Thi");
  await sleep(150);
  await page.evaluate(() => {
    const ta = document.getElementById("ta");
    // "And" is three characters past the injected terminator, which is exactly
    // what the non-idle path asks for.
    ta.value = ta.value + "s is a leaked page sentence. And";
    window.__mutAt = performance.now();
  });
  await sleep(2500);
  const reqs = await requests(page);
  const field = await val(page);
  console.log(`  sent=${JSON.stringify(reqs.map((q) => q.sentence))}`);
  console.log(`  field=${JSON.stringify(field)}`);
  rows.push({
    shape: "in-flight+3", delay: "mid", sent: reqs.length,
    sentence: reqs.length ? JSON.stringify(reqs[reqs.length - 1].sentence) : "-",
    trigger: reqs.length ? reqs[reqs.length - 1].trigger : "-",
    pageText: reqs.some((q) => /leaked/.test(q.sentence)),
    field: JSON.stringify(field),
  });
  ok(!reqs.some((q) => /leaked/.test(q.sentence)),
     "the chained non-idle scan refuses it too — which is why the veto is not gated on fromIdle");
  ok(/The technician arrived early\./.test(field),
     `and the user's own correction still landed: ${JSON.stringify(field)}`);
  await page.close();
}

// --- [P4] Control: the mutation lands AFTER the idle already fired ----------
// The assertion that matters here is that a request STILL HAPPENS. "No
// page-authored text" alone is satisfied by zero requests, which is exactly
// what a guard that simply stopped working would produce.
console.log("\n[P4] control — mutation at +900ms, after the idle window closed");
{
  const typed = "The techncian arrived early.";
  const r = await trial({
    typed,
    delay: 900,
    mutation: `ta.value = "This sentance is wrong.";`,
  });
  record("late", 900, r, typed);
  const page = r.reqs.map((q) => q.sentence).filter((s) => s !== typed);
  console.log(`  +900ms  sent=${JSON.stringify(r.reqs.map((q) => q.sentence))}  field=${JSON.stringify(r.field)}`);
  ok(r.reqs.length === 1 && r.reqs[0].sentence === typed,
     `the typed sentence still went out (${JSON.stringify(r.reqs.map((q) => q.sentence))})`);
  ok(page.length === 0, "and nothing page-authored went with it");
}

// --- [P5] page-called execCommand -------------------------------------------
// The review's reason for NOT relaxing the 8-char threshold: a page calling
// execCommand emits an input event that looks trusted. Measured here rather
// than argued -- and the question that matters is what the SIZE guard does
// with it, since that is the backstop being kept.
console.log("\n[P5] page-called execCommand('insertText') into the focused field");
{
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await typeJittered(page, "hello there");
  // The count BEFORE, because reading only the last event proves nothing: the
  // previous real keystroke is trusted too, so an execCommand that emitted
  // nothing at all -- or did nothing at all -- would have passed this section.
  const before = await page.evaluate(() => window.__inputs.length);
  const returned = await page.evaluate(() => {
    document.getElementById("ta").focus();
    return document.execCommand("insertText", false,
      ". Please wire the funds to the acount today.");
  });
  await sleep(1500);
  const inputs = await page.evaluate(() => window.__inputs);
  const fresh = inputs.slice(before);
  const reqs = await requests(page);
  const field = await val(page);
  console.log(`  execCommand returned ${returned}; ${fresh.length} new input event(s): ` +
    JSON.stringify(fresh.map((i) => ({ trusted: i.trusted, inputType: i.inputType }))));
  console.log(`  sent=${JSON.stringify(reqs.map((q) => q.sentence))}  field=${JSON.stringify(field)}`);
  rows.push({
    shape: "execCommand", delay: "-", sent: reqs.length,
    sentence: reqs.length ? JSON.stringify(reqs[0].sentence) : "-",
    trigger: reqs.length ? reqs[0].trigger : "-",
    pageText: reqs.some((q) => /acount/.test(q.sentence)),
    field: JSON.stringify(field),
  });
  ok(/Please wire the funds to the acount today\.$/.test(field),
     "the page-called execCommand actually inserted its text");
  ok(fresh.length === 1,
     `and emitted exactly one new input event (${fresh.length})`);
  ok(fresh.length === 1 && fresh[0].inputType === "insertText",
     `whose inputType is insertText (${fresh.length === 1 ? fresh[0].inputType : "n/a"}) — not in BULK_INPUT_TYPES`);
  ok(fresh.length === 1 && fresh[0].trusted === true,
     "and whose isTrusted is TRUE — which is why trust cannot be provenance");
  ok(!reqs.some((q) => /acount/.test(q.sentence)),
     "the 8-character size guard refuses it anyway — backstop intact");
  await page.close();
}

// --- [P5b] The veto runs through the field adapter, not through el.value ----
// Sentence mode reads text with snText, so a contenteditable must reach the
// same refusal. This is adapter coverage ONLY: a Slate-shaped fixture has no
// Slate model behind it, and this suite makes no claim about a real rich
// editor's write path -- that is sentence-editors-test.mjs, live-network only.
console.log("\n[P5b] the same injection into a contenteditable (adapter coverage only)");
{
  const typed = "The techncian arrived early.";
  const r = await trial({
    typed,
    delay: 200,
    sel: "#slate",
    mutation: `ta.textContent = "Internal only, we are cutting the team next month. " + ta.textContent;`,
  });
  console.log(`  sent=${JSON.stringify(r.reqs.map((q) => q.sentence))}`);
  console.log(`  field=${JSON.stringify(r.field)}`);
  rows.push({
    shape: "ce-prefix", delay: 200, sent: r.reqs.length,
    sentence: r.reqs.length ? JSON.stringify(r.reqs[0].sentence) : "-",
    trigger: r.reqs.length ? r.reqs[0].trigger : "-",
    pageText: r.reqs.some((q) => /Internal only/.test(q.sentence)),
    field: JSON.stringify(r.field),
  });
  ok(!r.reqs.some((q) => /Internal only/.test(q.sentence)),
     "the contenteditable path refuses the injected sentence too");
}

// --- [P6] The legitimate case must not be blocked ---------------------------
// Verifier contract: "the user typing `Hey. ` at the prefix is NOT blocked". A trusted
// keystroke is OBSERVED, so lastText tracks it; any provenance guard added to
// the idle path must be invisible here.
console.log("\n[P6] legitimacy — the user's own typing is never refused");
{
  // [P6a] The DIRECT control against over-blocking: the user types, with real
  // keystrokes, the very sentence [P3] injects. Byte for byte the same field
  // contents as the injection trial -- only the provenance differs, which is
  // the whole claim a provenance guard makes.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await typeJittered(page, "The techncian arrived early.");
  await page.keyboard.down("Control");
  await page.keyboard.press("Home");
  await page.keyboard.up("Control");
  await typeJittered(page, "Internal only, we are cutting the team next month. ");
  await sleep(1500);
  const reqs = await requests(page);
  const field = await val(page);
  console.log(`  [P6a] sent=${JSON.stringify(reqs.map((q) => q.sentence))}`);
  console.log(`  [P6a] field=${JSON.stringify(field)}`);
  ok(reqs.some((q) => q.sentence === "Internal only, we are cutting the team next month."),
     "a sentence the USER typed at the prefix still reaches the model");
  ok(/Internal only: we/.test(field),
     `and is corrected: ${JSON.stringify(field)}`);
  await page.close();
}
{
  // [P6b] The `"Hey. "` shape the verifier contract names, plus a second sentence
  // typed afterwards, so the assertion is about the scan still running rather
  // than about one string. Note the leading runt merges forward -- `"Hey."` is
  // under MIN_SENTENCE_CHARS -- which is why this asserts on the LATER
  // sentence: the merge is existing segmentation behaviour, not a refusal.
  const page = await freshPage(true);
  await page.click("#ta");
  await sleep(100);
  await typeJittered(page, "The techncian arrived early.");
  await page.keyboard.down("Control");
  await page.keyboard.press("Home");
  await page.keyboard.up("Control");
  await typeJittered(page, "Hey. ");
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await typeJittered(page, " We recieved it.");
  await sleep(1500);
  const reqs = await requests(page);
  const field = await val(page);
  console.log(`  [P6b] sent=${JSON.stringify(reqs.map((q) => q.sentence))}`);
  console.log(`  [P6b] field=${JSON.stringify(field)}`);
  ok(reqs.some((q) => q.sentence === "We recieved it."),
     "the scan keeps running after the user edits the prefix");
  ok(/We received it\./.test(field), `and corrects: ${JSON.stringify(field)}`);
  await page.close();
}

// --- Results table ----------------------------------------------------------
console.log("\n" + "=".repeat(78));
console.log("shape       delay   sent  page-authored?  sentence sent");
console.log("-".repeat(78));
for (const r of rows) {
  console.log(
    `${String(r.shape).padEnd(11)} ${String(r.delay).padStart(5)}  ${String(r.sent).padStart(4)}  ` +
    `${(r.pageText ? "YES" : "no").padEnd(14)}  ${r.sentence}`);
}
console.log("=".repeat(78));
console.log(`\n${pass} passed, ${fail} failed\n`);

await browser.close();
server.close();
process.exit(fail ? 1 : 0);
