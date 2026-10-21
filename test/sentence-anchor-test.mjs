#!/usr/bin/env node
// Sentence-mode trigger and anchor tests. No Ollama, no browser.
//
//   node sentence-anchor-test.mjs
//
// Two decision tables, both loaded out of content.js (lib/content-sandbox.mjs):
//
//   nextSentenceTarget      when a finished sentence becomes eligible
//   sentenceAnchorFailure   whether the result may still be spliced in
//
// The failure mode these exist to prevent is not "a missed correction" -- that
// costs nothing -- it is splicing a correction into the WRONG SPAN, which
// silently mangles text the user typed. So every case here asserts apply or
// refuse, and every returned target is checked to slice back to exactly the
// string that was sent to the model.

import {
  nextSentenceTarget, sentenceAnchorFailure, sentenceCaretRefusal, sentenceContextFor, changedRanges,
  describeChange, segmentSentences, MIN_SENTENCE_CHARS, SENTENCE_TRIGGER_CHARS,
  SENTENCE_MAX_JOB_MS, SENTENCE_CONTEXT_CHARS,
} from "./lib/content-sandbox.mjs";

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; return; }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  console.log(`          got      ${JSON.stringify(actual)}`);
  console.log(`          expected ${JSON.stringify(expected)}`);
}

// --- Trigger ---------------------------------------------------------------

/** Assert which sentence fires (or that none does), and that offsets are sane. */
function fires(label, text, watermark, fromIdle, expected) {
  const t = nextSentenceTarget(text, watermark, fromIdle);
  const got = !t ? null : (t.skip ? { skip: t.skip } : t.sentence);
  check(label, got, expected);
  // The invariant that matters: a target must slice back to exactly what gets
  // sent, or the splice would land on different bytes than the model saw.
  if (t && !t.skip) {
    if (text.slice(t.start, t.end) !== t.sentence) {
      failures.push(label + " (offsets)");
      console.log(`  FAIL  ${label}: slice ${JSON.stringify(text.slice(t.start, t.end))} != ${JSON.stringify(t.sentence)}`);
    } else if (t.start < watermark) {
      failures.push(label + " (behind watermark)");
      console.log(`  FAIL  ${label}: start ${t.start} is behind watermark ${watermark}`);
    } else pass++;
  }
}

const typed = (label, text, wm, exp) => fires(label, text, wm, false, exp);
const paused = (label, text, wm, exp) => fires(label, text, wm, true, exp);

console.log("\nSentence-mode trigger and anchor\n" + "=".repeat(72));

console.log(`\nTyping path: needs ${SENTENCE_TRIGGER_CHARS} characters of lookahead:`);
typed("nothing typed yet", "The report was late.", 0, null);
typed("one character", "The report was late. T", 0, null);
typed("two characters", "The report was late. Th", 0, null);
typed("three characters fires", "The report was late. The", 0, "The report was late.");
typed("well past the boundary", "The report was late. The next one was fine too.", 0, "The report was late.");
// A newline is a finished thought by itself -- waiting for three more
// characters would mean the last line of a message never gets proofread.
typed("newline fires immediately", "The report was late.\n", 0, "The report was late.");
typed("newline then text", "The report was late.\nAnd more", 0, "The report was late.");

console.log("\nUnfinished text never fires:");
typed("no terminator at all", "The report was late and we", 0, null);
typed("mid-word", "The report was lat", 0, null);
typed("terminator but nothing after", "The report was late.", 0, null);

console.log(`\nShort fragments merge forward rather than firing alone (min ${MIN_SENTENCE_CHARS}):`);
typed("two-word fragment waits", "On it. And", 0, null);
typed("fragment merges into the next sentence",
  "On it. I will tell the whole team this afternoon. Then", 0,
  "On it. I will tell the whole team this afternoon.");
typed("exactly at the threshold stands alone", "It's fine. We can ship", 0, "It's fine.");

console.log("\nThe watermark is respected -- nothing behind it is re-proofread:");
typed("first sentence is behind us", "Alpha beta gamma. Delta epsilon zeta. Now", 18, "Delta epsilon zeta.");
typed("watermark past everything", "Alpha beta gamma. Delta epsilon zeta.", 37, null);
// A watermark landing inside whitespace must not put that whitespace into the
// target: the model would see a leading space and the splice would eat it.
typed("watermark inside the gap", "Alpha beta gamma.  Delta epsilon zeta. Now", 17, "Delta epsilon zeta.");

console.log("\nPause path has no lookahead, so it needs a strong boundary:");
paused("plain sentence fires", "The report was late.", 0, "The report was late.");
// "Refer to Fig." plus a pause looks exactly like a finished sentence.
paused("abbreviation refuses", "Please refer to Fig.", 0, { skip: "weak-boundary" });
paused("initial refuses", "The author is J.", 0, { skip: "weak-boundary" });
paused("open quotation refuses", 'She said "that is fine.', 0, { skip: "weak-boundary" });
paused("open bracket refuses", "The result (see the appendix.", 0, { skip: "weak-boundary" });
// A period with a digit before it and nothing after it yet is the one boundary
// no segmenter can settle: `The reading was 176.` and the first 20 characters
// of `The reading was 176.2 across the run.` are the same string. Firing here
// proofread the first, advanced the watermark past it, and then handed the
// model the fragment `2 across the run.`
paused("trailing decimal point refuses", "The reading was 176.", 0, { skip: "weak-boundary" });
check("trailing decimal point does not advance the watermark",
  nextSentenceTarget("The reading was 176.", 0, true).end, null);
paused("a fraction already typed still refuses", "I think it is nearer 4.5.", 0, { skip: "weak-boundary" });
// Only a bare period. Anything else after the digit has already settled it.
paused("exclamation after a number fires", "The reading was 176!", 0, "The reading was 176!");
paused("closer after the period fires", "The reading was (176.)", 0, "The reading was (176.)");
paused("a word between the digit and the period fires",
  "The reading was 176 units.", 0, "The reading was 176 units.");
// Once there IS lookahead the segmenter has already made the call, so the
// pause path does not second-guess it.
paused("abbreviation with lookahead is fine",
  "Please refer to Fig. 3 for the detail. Then", 0, "Please refer to Fig. 3 for the detail.");
// ...and the decimal resolves itself the moment the next character arrives:
// the segmenter merges it, so there is no finished sentence to fire on at all,
// and the whole sentence fires once it is actually finished.
typed("half-typed decimal has no target", "The reading was 176.2 ac", 0, null);
typed("the completed sentence fires whole",
  "The reading was 176.2 across the run. Then", 0, "The reading was 176.2 across the run.");
paused("the completed sentence fires whole on a pause too",
  "The reading was 176.2 across the run.", 0, "The reading was 176.2 across the run.");

// --- Which trigger fired ---------------------------------------------------
//
// Every target names the EVIDENCE that the sentence is finished, and that label
// travels with the request into the log. Exactly ONE guard reads it
// (idle-final-inflection, in background.js), so an inaccurate label is now a
// wrong verdict and not merely a wrong log line -- what has to hold is that the
// label is honest.

console.log("\nThe trigger label names the evidence, not the timer:");
const label = (text, wm, fromIdle) => {
  const t = nextSentenceTarget(text, wm, fromIdle);
  return t && !t.skip ? t.trigger : t;
};
check("typed past the terminator is next-sentence",
  label("The report was late. The", 0, false), "next-sentence");
check("well past the terminator is still next-sentence",
  label("The report was late. The next one was fine.", 0, false), "next-sentence");
check("a newline is newline", label("The report was late.\n", 0, false), "newline");
check("a newline outranks the character count",
  label("The report was late.\nAnd more", 0, false), "newline");
check("a pause with nothing after it is idle",
  label("The report was late.", 0, true), "idle");
// The idle timer is not the same set as the idle EVIDENCE. A keystroke scan
// skipped as busy/panel-open leaves a sentence the user HAS typed past to be
// picked up by the pause, and that sentence carries the strong evidence
// however late it is read. Labelling by timer would call it `idle` and a
// replay would then attribute the whole population wrongly.
check("a pause on a sentence already typed past reports next-sentence",
  label("The report was late. The next one was fine.", 0, true), "next-sentence");
check("a pause after a newline reports newline",
  label("The report was late.\nAnd more", 0, true), "newline");
// Under the threshold there is no lookahead worth the name, so it is idle --
// and this is exactly the boundary the keystroke path refuses to fire on.
check("one character of lookahead on the pause path is idle",
  label("The report was late. T", 0, true), "idle");
check("two characters of lookahead on the pause path is idle",
  label("The report was late. Th", 0, true), "idle");

// --- A contenteditable's trailing newline is structure, not typing ----------
//
// buildSegmentsForElement synthesises a "\n" per block boundary INCLUDING the
// last, so every rich editor's text ends in one whether or not anybody pressed
// Enter -- and Draft, which wraps each block twice, ends in two. Read as
// evidence, that phantom made `newline` the ONLY reachable trigger on every
// certified family: the sentence went out with zero lookahead while claiming
// the strongest evidence there is, the weak-boundary refusals were bypassed
// (they are asked only where there is no lookahead), and idle-final-inflection
// -- which fires only on `idle` -- was silently off on every contenteditable.
//
// `structuralTail` says the trailing whitespace of this field is not something
// the user typed. What changes is the STANDARD, not the timing: the sentence
// still fires on the keystroke that finished it, because on a contenteditable
// Enter usually sends the message and there is no later evidence coming, but it
// is judged as the no-lookahead case it always was.
console.log("\nA contenteditable's own trailing boundary is not evidence:");
const CE = { structuralTail: true };
const ceLabel = (text, wm, fromIdle) => {
  const t = nextSentenceTarget(text, wm, fromIdle, CE);
  return t && !t.skip ? t.trigger : (t && t.skip ? "skip:" + t.skip : t);
};
check("the field's own trailing newline is not a newline trigger",
  ceLabel("The report was late.\n", 0, false), "idle");
check("nor are two of them, which is what Draft's double wrapper produces",
  ceLabel("The report was late.\n\n", 0, false), "idle");
check("a newline the user typed, with text after it, still is",
  ceLabel("The report was late.\nAnd more\n", 0, false), "newline");
check("and the sentence still fires on the keystroke that finished it",
  nextSentenceTarget("The report was late.\n", 0, false, CE).sentence,
  "The report was late.");
// The refusals that the phantom was walking straight past. A textarea has
// always refused these; a contenteditable proofread them as finished.
check("an abbreviation is now refused on a contenteditable",
  ceLabel("Please refer to Fig.\n", 0, false), "skip:weak-boundary");
check("as is an unclosed quotation", ceLabel('She said "that is fine.\n', 0, false),
  "skip:weak-boundary");
check("as is a trailing decimal point", ceLabel("The reading was 176.\n", 0, false),
  "skip:weak-boundary");
check("and the watermark does not advance past any of them",
  nextSentenceTarget("Please refer to Fig.\n", 0, false, CE).end, null);
// The phantom also inflated the character count, so a contenteditable fired one
// character earlier than a textarea on the same typing -- and on Draft, two.
check("one character past the terminator still waits",
  nextSentenceTarget("The report was late. T\n", 0, false, CE), null);
check("two characters past the terminator still waits",
  nextSentenceTarget("The report was late. Th\n", 0, false, CE), null);
check("three is the threshold, exactly as on a textarea",
  ceLabel("The report was late. The\n", 0, false), "next-sentence");
// And nothing about a textarea moved: its trailing newline IS a keystroke.
check("a textarea's trailing newline is still a newline trigger",
  label("The report was late.\n", 0, false), "newline");
check("a textarea with nothing after the terminator still waits",
  nextSentenceTarget("The report was late.", 0, false), null);

// The hazard a trigger-aware guard was proposed to fix -- "the last word may be
// half-typed, `cor` is not a typo for `core`" -- cannot occur on this path, and
// this is the demonstration rather than the argument.
//
// TWO ORACLES, AND NEITHER IS THE PREDICATE UNDER TEST. The first version of
// this sweep called endsSentence() -- the very function whose decision it was
// checking -- and asserted full.includes(t.sentence), which is vacuous because
// the target was sliced out of a prefix of `full`. Both held while the property
// was broken: relaxing endsSentence to /\S\s*$/ in a scratch copy of content.js
// still reported all checks passed. So:
//
//   TERMINATOR  a literal regex written out HERE. Strip a trailing run of
//               closers, then the last character must be one of . ! ?
//   COMPLETE    the target must be one of the sentences of the FINISHED text,
//               not merely a substring of it. `The reading was 176.` is a
//               substring of `The reading was 176.2 across the run.` and is not
//               one of its sentences, which is precisely the fragment this is
//               looking for.
//
// Verified by mutation, and the numbers are the point. Relax endsSentence to
// /\S\s*$/ in a copy of content.js and run this file with PROOFER_CONTENT
// pointing at it (lib/content-sandbox.mjs honours it). Of the 136 idle targets
// the mutant produces, the OLD oracles flag **0** and these flag **115**; the
// suite exits 1. Recorded rather than run in code -- a suite that patches its
// own subject to prove it can fail is a maintenance liability -- but an
// unrecorded mutation check is one nobody ever repeats, which is how the first
// version of this sweep shipped green and vacuous.
console.log("\nAn idle target is never a fragment of what the user went on to type:");
const KEYSTROKE_TEXTS = [
  "The reading was 176.2 across the run. Then we packed up.",
  "Please refer to Fig. 3 for the detail. It explains the drop.",
  "I will ask Dr. Smith about it tomorrow morning.",
  "I think that is correct. Let me check the other one.",
  'She said "that is fine." Then she left the room.',
  "We shipped it on Monday. The client has not replied yet.",
];
const endsInTerminator = (s) => ".!?".includes(
  String(s).trim().replace(/["'”’)\]}»]+$/, "").slice(-1));
let fragments = 0, idleTargets = 0, nonIdleSeen = 0;
for (const full of KEYSTROKE_TEXTS) {
  const finished = new Set(segmentSentences(full).map((s) => s.text.trim()));
  for (let i = 1; i <= full.length; i++) {
    const t = nextSentenceTarget(full.slice(0, i), 0, true);
    if (!t || t.skip) continue;
    // Only the idle-EVIDENCE targets are this property's business. A prefix
    // long enough to have typed past the terminator is labelled next-sentence
    // even when the pause is what read it, and those are covered above.
    if (t.trigger !== "idle") { nonIdleSeen++; continue; }
    idleTargets++;
    if (!endsInTerminator(t.sentence) || !finished.has(t.sentence.trim())) {
      fragments++;
      console.log(`  FAIL  fragment target ${JSON.stringify(t.sentence)} from ${JSON.stringify(full.slice(0, i))}`);
    }
  }
}
check("no idle target is a fragment", fragments, 0);
// A sweep that produced nothing would pass the line above for the wrong reason.
check("the sweep actually produced idle targets", idleTargets > 0, true);
check("and the trigger filter is doing work, not passing everything", nonIdleSeen > 0, true);

console.log("\nTargets we will never send still advance the watermark:");
const long = "We " + "really ".repeat(90) + "did it.";
check("over-long sentence skips", nextSentenceTarget(long + " Next", 0, false).skip, "too-long");
check("over-long sentence reports an end",
  typeof nextSentenceTarget(long + " Next", 0, false).end, "number");
typed("punctuation-only is not a sentence", "..... ..... ... Next", 0, { skip: "no-words" });

console.log("\nDegenerate input:");
typed("empty", "", 0, null);
typed("whitespace only", "     ", 0, null);
typed("watermark past the end", "Short.", 99, null);

// --- Anchor ----------------------------------------------------------------

const TEXT = "Alpha beta gamma. The report was late. Delta epsilon.";
const START = 18, END = 38;                       // "The report was late."
const JOB = {
  start: START, end: END,
  sentence: TEXT.slice(START, END),
  prefixThrough: TEXT.slice(0, END),
  capturedAt: 1000,
  dirty: false,
};
const NOW = 1200;

function anchor(label, opts, expected) {
  const job = { ...JOB, ...(opts.job || {}) };
  const live = opts.live !== undefined ? opts.live : TEXT;
  const caret = opts.caret !== undefined ? opts.caret : live.length;
  const caretEnd = opts.caretEnd !== undefined ? opts.caretEnd : caret;
  check(label, sentenceAnchorFailure(job, live, caret, caretEnd, opts.now || NOW), expected);
}

console.log("\nAnchor holds:");
anchor("unchanged text, caret at the end", {}, null);
anchor("caret exactly at the target end", { caret: END }, null);
// The whole point of the feature: the fix lands while you write the next
// sentence, so typing AFTER the target must not invalidate it.
anchor("user kept typing after it",
  { live: TEXT + " And then some more text here." }, null);
anchor("user deleted text after it", { live: TEXT.slice(0, END + 5), caret: END + 5 }, null);

console.log("\nAnchor lost -- every one of these would splice the wrong bytes:");
anchor("edit before the target", { live: "ALPHA beta gamma. The report was late. Delta." }, "prefix-changed");
anchor("insertion before the target",
  { live: "x" + TEXT }, "prefix-changed");
// Deliberately byte-for-byte, unlike the manual path's normalised guard: a
// second space before the target shifts every offset by one.
anchor("whitespace-only change before the target",
  { live: TEXT.replace("Alpha beta", "Alpha  beta") }, "prefix-changed");
anchor("the target itself changed",
  { live: "Alpha beta gamma. The report was LATE. Delta epsilon." }, "prefix-changed");
anchor("text shrank past the target", { live: "Alpha beta", caret: 10 }, "shrunk");
anchor("caret moved back inside the target", { caret: END - 5 }, "caret-inside");
anchor("caret before the target", { caret: 3 }, "caret-inside");
anchor("a selection is active", { caret: END, caretEnd: END + 4 }, "selection-active");
anchor("no caret at all (element not focusable)", { caret: null }, "no-caret");
anchor("job too old", { now: 1000 + SENTENCE_MAX_JOB_MS + 1 }, "stale-age");
anchor("paste or undo since capture", { job: { dirty: true } }, "edited-since-capture");
// Ordering matters: a dirty job must be refused even when everything else still
// looks perfect, because the flag is set by events the text comparison cannot see.
anchor("dirty beats a clean-looking document",
  { job: { dirty: true }, live: TEXT }, "edited-since-capture");

console.log("\nThe pre-send caret check is the anchor's own three questions:");
// `sentenceCaretRefusal` is asked in maybeFireSentence BEFORE a request goes
// out (2026-09-15) and by sentenceAnchorFailure at delivery, so the two cannot
// disagree on what "inside" means. The boundary that matters is strict `<`: a
// contenteditable's last-sentence trigger fires with the caret exactly AT
// `end`, and that is the chat-client sentence this path exists for.
check("caret at end is not inside", sentenceCaretRefusal(END, END, END), null);
check("caret one past end is not inside", sentenceCaretRefusal(END + 1, END + 1, END), null);
check("caret one before end IS inside", sentenceCaretRefusal(END - 1, END - 1, END), "caret-inside");
check("caret at the target's start is inside", sentenceCaretRefusal(0, 0, END), "caret-inside");
check("a selection outranks position", sentenceCaretRefusal(END, END + 3, END), "selection-active");
check("a selection inside is still 'selection'", sentenceCaretRefusal(END - 4, END - 1, END), "selection-active");
check("no caret outranks both", sentenceCaretRefusal(null, END, END), "no-caret");
check("no caret end outranks both", sentenceCaretRefusal(END, null, END), "no-caret");
check("undefined reads as no caret", sentenceCaretRefusal(undefined, undefined, END), "no-caret");
// And the delivery anchor still answers through it, in the same order.
anchor("delivery: selection reported before caret-inside",
  { caret: END - 5, caretEnd: END - 2 }, "selection-active");
anchor("delivery: caret exactly at end applies", { caret: END }, null);

console.log("\nRepeated sentences do not confuse the anchor:");
// This is why the anchor is offset-based and never re-finds the sentence by
// searching for its text: "Thanks!" appears twice and neither occurrence is
// distinguishable from the other.
const REPEAT = "Thanks for that. Sounds good to me. Thanks for that. More";
anchor("identical sentence later in the document",
  { job: { start: 0, end: 16, sentence: "Thanks for that.", prefixThrough: "Thanks for that." },
    live: REPEAT, caret: REPEAT.length }, null);

// --- Context ---------------------------------------------------------------

console.log("\nContext window:");
check("nothing precedes the first sentence", sentenceContextFor("The first sentence. Next", 0), "");
check("preceding text is the context",
  sentenceContextFor("Alpha beta gamma. The report was late.", 18), "Alpha beta gamma.");
{
  const filler = "Filler sentence number one here. ".repeat(200);
  const doc = filler + "The target sentence.";
  const ctx = sentenceContextFor(doc, filler.length);
  check("bounded to the window", ctx.length <= SENTENCE_CONTEXT_CHARS, true);
  // Snapped to a boundary, so the model is never handed half a word
  check("starts at a sentence boundary", /^[A-Z]/.test(ctx), true);
  // It is the text immediately BEFORE the target, not an arbitrary slice
  check("ends at the target", doc.slice(0, filler.length).trimEnd().endsWith(ctx), true);
}

// --- Change ranges (what the green flash paints) ---------------------------

console.log("\nChanged-word ranges:");
{
  const before = "The techncian arrived.";
  const after = "The technician arrived.";
  const r = changedRanges(before, after, 100, "ins");
  check("one range for one changed word", r.length, 1);
  check("range covers the new word", after.slice(r[0].start - 100, r[0].end - 100), "technician");
  const d = changedRanges(before, after, 100, "del");
  check("del side covers the old word", before.slice(d[0].start - 100, d[0].end - 100), "techncian");
  check("no ranges when nothing changed", changedRanges(before, before, 0, "ins").length, 0);
}
{
  // Adjacent changes merge into one highlight rather than flickering as two
  const r = changedRanges("we was there", "we were there", 0, "ins");
  check("adjacent inserts merge", r.length, 1);
}

console.log("\nScreen-reader announcement:");
check("substitution", describeChange("The techncian arrived.", "The technician arrived."),
  "techncian to technician");
check("insertion", describeChange("She left note.", "She left a note."), "added a");
check("deletion", describeChange("the the report", "the report"), "removed the");

console.log("\n" + "=".repeat(72));
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`All ${pass} checks passed.`);
