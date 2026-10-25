#!/usr/bin/env node
/**
 * EDITOR CHARACTERIZATION BENCH (an experiment, not a regression suite): does an
 * editor take one of the two shipping recipes, cleanly, in both idle and burst?
 *
 *   cd test && node editor-recipe-probe.mjs            # 8 trials per phase
 *   node editor-recipe-probe.mjs --nesting-only        # no network, ~2s
 *   node editor-recipe-probe.mjs --offline             # local files/127.0.0.1 only
 *   PROOFER_CANDIDATES=Trix node editor-recipe-probe.mjs
 *   PROOFER_ARMS=intent,none PROOFER_TRIALS=10 node editor-recipe-probe.mjs
 *   PROOFER_RESULT_JSON=out.json node editor-recipe-probe.mjs
 *   PROOFER_CONTENT=/path/to/content.js node editor-recipe-probe.mjs
 *   PROOFER_SEED=1234 node editor-recipe-probe.mjs     # replay a run's typing
 *
 *   # AN EDITOR THIS FILE HAS NEVER HEARD OF, with no code change:
 *   PROOFER_CANDIDATE_URL=https://codemirror.net/ \
 *   PROOFER_CANDIDATE_SELECTOR=.cm-content \
 *   PROOFER_CANDIDATE_NAME=CodeMirror6 node editor-recipe-probe.mjs
 *
 * These are ENV VARS, not arguments: a trailing `PROOFER_TRIALS=8` after the
 * filename is an ignored argv entry, which is exactly how a self-report comes
 * to quote a command that cannot reproduce its own numbers.
 *
 * The default is 8 because 8 is what the recorded matrix below was taken at.
 * The two cells that read 16 are the SAME command run twice and the counts
 * added -- a replication, deliberately not a `PROOFER_TRIALS=16` single run,
 * because a fresh page per run is part of what is being replicated.
 *
 * WHAT IT IS FOR. sentence-editors-test.mjs is the regression suite for editors
 * that ALREADY have an SN_TRANSPORTS row; it asks "is the certified write still
 * right". This asks the question one step earlier -- "may this editor have a
 * row at all" -- which needs a different shape: every candidate is run against
 * EVERY recipe, including the ones it will fail, and a cell is a rate over many
 * trials rather than a single assertion. A refusal is as much a deliverable as
 * a row, so a candidate that measures dirty is reported, not skipped.
 *
 * ENGINE AND DESCRIPTORS ARE SEPARATE, and the split is not cosmetic. What is
 * general here is "run both recipes in both phases and score three outcomes";
 * what is not general is `minClickY: 260`, which exists because one docs site
 * has a sticky header. Those setup facts live in lib/editor-targets.mjs, one
 * row per editor, and an ad-hoc row can be synthesised from PROOFER_CANDIDATE_*
 * so a NEW editor needs no code at all. What the ad-hoc path deliberately does
 * NOT do is guess: a URL with no selector is an error, because a guessed
 * selector attributes the whole matrix to whatever the guess happened to find.
 * A row that has never been measured also has no quirks recorded, so the first
 * ad-hoc run of an editor should be read as "what happened", not as its answer
 * -- Trix's cells were a dead write until `focusVia: "el"` was known.
 *
 * THE ARMS. Both are the shipping functions, driven directly -- an unregistered
 * editor has no row for spliceSentenceVia to route from, and a probe that
 * reimplemented either recipe would be measuring the copy.
 *
 *   intent             spliceSentenceSlate, WHATEVER IT CURRENTLY IS. It is
 *                      imported from the shipping file rather than described
 *                      here, and the description is the part that rots: the
 *                      first matrix below was taken against a "no selection, no
 *                      wait" variant that had already been superseded by the
 *                      time it was written up, and the refusal it justified
 *                      turned on exactly that difference. As of 2026-08-14 the
 *                      recipe sets the DOM selection to the target range and
 *                      dispatches beforeinput/insertReplacementText carrying
 *                      targetRanges:[StaticRange] IN THE SAME TICK, then checks
 *                      its own result exactly and returns `misplaced` if the
 *                      text did not change the way it asked for.
 *                      (Its own caret handling is part of the recipe, so there
 *                      is no caret arm to choose: `caret: "in-recipe"`.)
 *                      RE-RUN THE INTENT CELLS whenever that function changes;
 *                      the mutation cells are independent of it.
 *   mutation-checked   spliceSentenceCE with caret: "checked"
 *   mutation-reimpose  spliceSentenceCE with caret: "reimpose"
 *   none               NO WRITE AT ALL. The control for the burst column: it
 *                      establishes that this harness, typing at this cadence
 *                      into this editor, does not lose characters on its own.
 *                      Without it "the recipe ate a keystroke" and "the demo
 *                      site drops keystrokes under load" are the same reading.
 *
 * METHOD, inherited from the SN_TRANSPORTS measurement in content.js -- every
 * rule in it was bought by a wrong answer:
 *
 *   - REAL editors over the network, never a fixture. A Slate-shaped div has no
 *     model to disagree with its DOM, so it passes while the write is broken.
 *   - The ONLY assertion that can fail: TYPE MORE CHARACTERS AFTERWARDS and see
 *     whether the correction survives AT THE RIGHT OFFSET.
 *   - JITTER the inter-keystroke delay (22-129ms). A fixed cadence hides
 *     collision completely: at one spacing 10/10 broken, at the next 0/10. The
 *     stream is SEEDED and the seed is printed and recorded, so an intermittent
 *     red is handed on as a command rather than as a description.
 *   - Split IDLE from BURST. Keystroke deletion is invisible in the idle column.
 *   - Carry SLATE as a positive control, so "the write did nothing" is
 *     distinguishable from "the probe never fired". It earned this outright on
 *     2026-08-14: it caught a regression in the SPLICE that no candidate cell
 *     could have shown, because a candidate that measures dirty is expected to.
 *   - A burst that produces ONE swallow batch per trial is a COLLISION, not a
 *     burst. A sibling probe fired after three characters and then typed the
 *     rest, so a second batch was unreachable by construction; it read 16/16
 *     clean on the exact bytes this file measured at 3/8 with user characters
 *     deleted. Reshaped to fire into a live burst it scored those bytes 13/16 --
 *     so it was the SHAPE, not the trial count. The same hazard is latent here:
 *     the IDLE trial is single-batch by construction and can therefore say
 *     nothing about buffering. Stated, rather than left as an accident.
 *
 * AND ONE FAILURE FAMILY WORTH NAMING, because six instances of it turned up
 * across two probes in a single afternoon: THE RUN COMPLETES, EXITS GREEN, AND
 * PRODUCES NOTHING. `PROOFER_TRIALS=0` ran zero trials and exited 0; a filter
 * matching no candidate did the same; a candidate source with an empty registry
 * generated no nesting checks and printed "0/0 passed"; `--nesting-only`
 * accepted `PROOFER_RESULT_JSON` and silently ignored it; the console printed
 * the first six details overall, so a cell with 8 idle refusals showed NOT ONE
 * of its 8 damaged burst finals. (The sibling probe supplied two more of its
 * own.) This is the suite-level rule -- "a skipped suite must not exit like a
 * passing one" -- one level down, at the ARTIFACT rather than the process, and
 * it is invisible precisely because nothing went wrong in the sense the code
 * was checking. When adding a path here, ask what it produces, not just what it
 * returns.
 *
 * Three more of the same family are closed by the bench shape, and each one is
 * an ad-hoc run away from being reachable by anybody:
 *   - a PROOFER_RESULT_JSON that cannot be written is checked BEFORE Chrome
 *     launches, and the placeholder written there says `status: "in-progress"`,
 *     so an artifact from a killed run cannot be read as a finished one;
 *   - a run that measured NO CELLS is a named exit rather than an empty table
 *     under a full banner -- 2 when a page loaded and matched no element, which
 *     is a claim about the selector, and the usual 77 when every row was merely
 *     unreachable, which is an outage. Collapsing those two made running the
 *     probe with no network report a configuration error;
 *   - a descriptor with a missing or malformed field is refused by name at
 *     startup, not twenty seconds into a `waitForSelector(undefined)` that
 *     reports as an outage.
 *
 * SCORING, and why three outcomes rather than a boolean. A refusal and a
 * deletion are not the same failure -- one costs a correction, the other costs
 * the user's own text:
 *
 *   APPLIED     the correction landed and survived the following keystrokes at
 *               the right offset.
 *   REFUSED     the recipe reported failure and the field holds exactly what
 *               was typed. Costs a correction; costs nothing else.
 *   DAMAGED     anything else. The typo came back after the write claimed
 *               success (a model that never learned), the caret was left in the
 *               wrong place, or a character the user typed is gone.
 *
 * Exits 77 (not 0, not 1) if a demo site is unreachable: a green run that
 * measured nothing is the failure this policy exists for.
 *
 * WHAT IT MEASURED, 2026-08-14, Chrome for Testing 145, each editor's own demo
 * site. A/R/D is APPLIED / REFUSED / DAMAGED out of 8 trials; the two cells
 * that became registry rows were replicated, so they read 16. DELETED counts
 * characters the USER typed that are absent from the final text ALTOGETHER.
 *
 * Every INTENT cell here is the 2026-08-14 spliceSentenceSlate (selection set
 * in the same tick as the dispatch, plus the `misplaced` exactness check). The
 * first version of this table measured a superseded "no selection, no wait"
 * variant and had to be retaken -- see the intent arm's note above.
 *
 *   editor / arm                   idle A/R/D    burst A/R/D   DELETED
 *   Slate / intent  (control)      8/0/0         8/0/0         0
 *   Slate / none    (control)      --            0/8/0         0
 *   Draft / intent                 0/8/0         0/4/4         4
 *   Draft / mutation-checked       16/0/0        16/0/0        0
 *   Draft / mutation-reimpose      8/0/0         8/0/0         0
 *   Draft / none    (control)      --            0/8/0         0
 *   Trix / intent                  0/8/0         0/4/4         5
 *   Trix / mutation-checked        16/0/0        16/0/0        0
 *   Trix / mutation-reimpose       8/0/0         8/0/0         0
 *   Trix / none     (control)      --            0/8/0         0
 *   CKEditor5 / intent             8/0/0         5/0/3         0
 *   CKEditor5 / mutation-checked   0/0/8         0/0/8         0
 *   CKEditor5 / mutation-reimpose  0/0/8         0/0/8         0
 *   CKEditor5 / none (control)     --            0/8/0         0
 *
 * DRAFT and TRIX took SN_TRANSPORTS rows on the mutation recipe with
 * caret: "checked" -- the `reimpose` arm scored identically, so the weaker
 * policy is the whole of what is needed. Their INTENT rows are the
 * no-fallback-chain evidence: the recipe the registry does NOT give them
 * deletes 4 and 5 of their user's characters over 8 burst trials. Trix's intent
 * arm additionally throws inside the host page in 8 of 8 idle trials and 8 of 8
 * burst (12 exceptions), because its input controller reads
 * `event.dataTransfer.getData` off a beforeinput it did not expect.
 *
 * CKEDITOR 5 WAS REFUSED, and it is the only one of the three whose Harper
 * prior was right: it honours the intent dispatch, 8/8 idle, clean. Mid-burst
 * it scrambles the user's own text 3/8 -- "Then we" comes back as
 * "Ten we shipped it out to everyone.h". Nothing is DELETED; the swallowed
 * character is replayed AT THE END of the document, because CKEditor honours
 * the replay's synthetic beforeinput too and applies it at its own model
 * selection rather than at the DOM caret the splice just restored. That is not
 * a caret policy -- the caret restore is not what is misrouted -- and mutation
 * is not the way out either, since CKEditor's renderer reverts the execCommand
 * outright, 0/8 in both phases.
 *
 * The CKEditor mutation DELETED column read 8 for a day and was WRONG. `lost`
 * was `expected.length - final.length` against the CORRECTED sentence, which is
 * one character longer than the typo -- so a reverted correction scored as a
 * deleted keystroke, and "8 gone in 8 trials" went into content.js as fact.
 * Every one of those finals held the user's complete typed text. See
 * userCharsLost: damage and data loss are different claims, and a probe that
 * conflates them will always report the worse one.
 *
 * The `none` column is why the burst numbers mean anything: 24/24 intact across
 * every candidate with no write fired at all.
 *
 * NESTING. A section that needs no network: an editor with no registry row,
 * hosted inside a `contenteditable="false"` node view inside one that HAS a
 * row, must resolve to no adapter at all. It measured 18/24 before the fix in
 * nearestTransport and 24/24 after -- all six certified families were handing
 * their recipe to an unmeasured inner editor, and sentenceFieldStatus reported
 * ok:true. `--nesting-only` runs just that, and PROOFER_CONTENT points it at a
 * candidate content.js.
 *
 * NOT A GATE, AND NOT YET A CANARY. There is no baseline mode here on purpose:
 * the splice this file characterises is under active change, so a matrix
 * recorded today would be a stale expectation by the time anything compared
 * against it. Scheduling a recurring run is a follow-up, and it needs the
 * INTENT column to hold still first.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { resolveChrome } from "./lib/chrome.mjs";
import { EDITOR_TARGETS, resolveTargets, crossCheckEditorsSuite, KNOWN_ARMS } from "./lib/editor-targets.mjs";

const PROBE_PATH = new URL(import.meta.url).pathname;
const EXT = path.join(path.dirname(PROBE_PATH), "..");
const TARGETS_PATH = path.join(EXT, "test/lib/editor-targets.mjs");
// A FULL digest in a field called sha256. It held the first 16 hex characters --
// a 64-bit prefix under a name that promises 256 bits, which is the kind of
// quiet approximation that gets compared across artifacts and trusted. The
// banner still PRINTS 16, because a banner is for reading; the artifact stores
// all of it, because an artifact is for checking.
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const short = (h) => (h || "").slice(0, 16);

/**
 * Source provenance, taken AT STARTUP and never re-read.
 *
 * These hashes used to be computed when the artifact was written, which is
 * minutes later on a real run: edit the probe while it measures -- entirely
 * normal, that is how the paired runs in this file's history were produced --
 * and the artifact stamps bytes that never executed. Reading at startup is the
 * fix that is actually available; it is NOT the module's in-memory bytes, which
 * Node does not expose, and the residual window is the moment between import and
 * this line.
 *
 * And a file that cannot be read is fatal rather than `null`. Provenance whose
 * failure mode is a blank field is worse than none, because an artifact with
 * `sha256: null` still looks like an artifact.
 */
function loadedSource(p, what) {
  try { return { path: p, sha256: sha256(fs.readFileSync(p, "utf8")) }; }
  catch (e) {
    console.error(`\n  Cannot read ${what} at ${p} (${e.message}). Refusing to run: `
      + `a measurement that cannot say what produced it is not evidence.`);
    process.exit(2);
  }
}
const PROBE_SRC = loadedSource(PROBE_PATH, "the probe itself");
const TARGETS_SRC = loadedSource(TARGETS_PATH, "lib/editor-targets.mjs");

// PROOFER_CONTENT so a candidate content.js can be measured without touching
// the tree -- which is how the nesting section below was shown to FAIL before
// the fix and pass after it, on the same run of the same probe.
//
// AND ITS PROVENANCE IS PRINTED AND RECORDED. An exported PROOFER_CONTENT
// outlives the shell command that set it, so an ordinary-looking run can
// measure a snapshot from an hour ago and say nothing -- and the whole second
// blocker in this file's history was a matrix taken against a superseded
// version of one function. Path and hash, in the banner and in the JSON, so a
// recorded cell can always be tied back to the source it measured.
//
// The PROBE's own hash is recorded beside it for the same reason one step out:
// the engine decides what a cell means, and two artifacts that disagree are
// unreadable without knowing whether the harness moved between them.
const CONTENT_PATH = path.resolve(process.env.PROOFER_CONTENT || path.join(EXT, "content.js"));
const CONTENT = fs.readFileSync(CONTENT_PATH, "utf8");
const CONTENT_SHA = sha256(CONTENT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXIT_SKIPPED = 77;

// 22-129ms inclusive. The band is the point: a human types unevenly, and every
// fixed cadence is a resonance waiting to hide a bug.
//
// SEEDED, because the cost of random timing is an intermittent failure nobody
// can reproduce -- the phase of a keystroke against the write IS the phenomenon
// here, so a damaged cell that cannot be replayed is a description rather than
// a bug report. Printed before anything that can exit, for the same reason
// sentence-slate-test.mjs prints its own there: a seed you only get on success
// is not a reproduction aid.
const JITTER_MIN = 22, JITTER_MAX = 129;
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
const jitter = () => JITTER_MIN + Math.floor(rand() * (JITTER_MAX - JITTER_MIN + 1));
console.log(`\n[seed ${SEED}]  PROOFER_SEED=${SEED} replays this run's keystroke rhythm`);

// 8, which is what the recorded matrix was taken at -- a default that does not
// reproduce the numbers in the header is a command nobody can check.
//
// And it FAILS LOUD. `Number(undefined)` is NaN and `Number("0")` is 0, and
// either one ran zero trials, printed 0/0/0, and exited 0: a green run that
// measured nothing, which is the exact failure this file's exit-code policy
// exists to prevent.
const TRIALS = process.env.PROOFER_TRIALS === undefined
  ? 8 : Number(process.env.PROOFER_TRIALS);
if (!Number.isInteger(TRIALS) || TRIALS < 1) {
  console.error(`PROOFER_TRIALS=${process.env.PROOFER_TRIALS} is not a positive integer. `
    + `A run of zero trials exits 0 and proves nothing.`);
  process.exit(2);
}
const TYPO = "The techncian arrived early.";
const FIXED = "The technician arrived early.";
const HEAD = " Then we";                 // typed before an idle write
const MORE = " shipped";                 // typed after it -- THE assertion
const TAIL = " Then we shipped it out to everyone.";   // the burst tail

/**
 * How many characters the USER typed are absent from the final text ALTOGETHER.
 *
 * THE CORRECTION'S OWN CHARACTERS MUST NOT PAY FOR A DELETED ONE. This has now
 * been wrong twice, in opposite directions, and both were caught by audit
 * rather than by the probe:
 *
 *   v1  `expected.length - final.length` against `FIXED + TAIL`. FIXED is one
 *       character longer than TYPO, so an editor that REVERTED the correction
 *       scored one deleted keystroke per trial -- and "CKEditor: 8 gone in 8"
 *       reached content.js as fact when every final held the user's complete
 *       text. A FALSE POSITIVE.
 *   v2  a plain multiset deficit of `TYPO + TAIL` against the whole final. The
 *       available pool then included the `i` the correction ADDED
 *       (techncian -> technician), which could settle the debt for an `i` the
 *       editor deleted somewhere else:
 *
 *         "The technician arrived early. Then we shpped it out to everyone."
 *                                                    ^ the user's i is gone
 *
 *       and the metric returned 0. A FALSE NEGATIVE, which is the worse of the
 *       two: this column's only job is to notice deleted user text.
 *
 * So the correction's region is EXCLUDED rather than counted. Every trial in
 * this file applies exactly one edit -- TYPO -> FIXED at offset 0 -- so:
 *
 *   correction present   the sentence region is the CORRECTION's text, not the
 *                        user's. Subtract one FIXED per occurrence from the
 *                        available pool (every occurrence: a doubled write must
 *                        not donate a second set of characters either), and the
 *                        user is still owed exactly TAIL.
 *   correction absent    nothing of the user's was superseded, so they are owed
 *                        TYPO + TAIL and the whole final is available.
 *
 * Still a multiset and still deliberately not an LCS. Order damage is a
 * different failure with a different fix, and it is already carried by the
 * DAMAGED verdict and the recorded final -- CKEditor's intent arm replays the
 * swallowed character at the END of the document, so the character is present
 * and the sentence is still wrong. An LCS scores that as a loss and puts the
 * number straight back into the column this function exists to keep honest.
 */
const ADDED_BY_CORRECTION = FIXED;      // named for the comment above

function counts(s) {
  const m = new Map();
  for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1);
  return m;
}

function userCharsLost(final) {
  const have = counts(final);
  let corrections = 0;
  for (let at = final.indexOf(ADDED_BY_CORRECTION); at !== -1;
       at = final.indexOf(ADDED_BY_CORRECTION, at + ADDED_BY_CORRECTION.length)) corrections++;
  for (let n = 0; n < corrections; n++) {
    for (const [ch, k] of counts(ADDED_BY_CORRECTION)) {
      have.set(ch, Math.max(0, (have.get(ch) || 0) - k));   // clamped: under-crediting
    }                                                       // can only RAISE the deficit
  }
  const owed = corrections > 0 ? TAIL : TYPO + TAIL;
  let lost = 0;
  for (const ch of owed) {
    const n = have.get(ch) || 0;
    if (n > 0) have.set(ch, n - 1); else lost++;
  }
  return lost;
}

/**
 * The metric checks itself, before Chrome is launched and on every run.
 *
 * A measurement function that has been wrong twice does not get to be the one
 * thing here with no test. The third case is the auditor's counterexample
 * verbatim; the second is the shape that produced the false "8 gone in 8".
 */
{
  const CASES = [
    [FIXED + TAIL,                                            0, "clean apply"],
    [TYPO + TAIL,                                             0, "clean refusal -- the v1 false positive"],
    [FIXED + " Then we shpped it out to everyone.",            1, "deleted i, masked by the correction's i -- the v2 false negative"],
    [FIXED + " Ten we shipped it out to everyone.h",           0, "CKEditor: relocated, not deleted"],
    [TYPO + " Ten we shipped it out to everyone.",             1, "Draft/Trix: swallowed and never replayed"],
    [TYPO + TAIL.slice(0, -1),                                 1, "last character gone"],
    [FIXED + FIXED + TAIL,                                     0, "doubled write, nothing of the user's lost"],
    [FIXED + FIXED + " Then we shpped it out to everyone.",     1, "doubled write must not pay for a deletion either"],
    ["",                                                      TYPO.length + TAIL.length, "field emptied"],
  ];
  let bad = 0;
  for (const [text, want, name] of CASES) {
    const got = userCharsLost(text);
    if (got !== want) { console.error(`  userCharsLost SELF-CHECK FAILED: ${name} -> ${got}, want ${want}`); bad++; }
  }
  if (bad) {
    console.error(`${bad} self-check(s) failed. The DELETED column cannot be trusted; refusing to run.`);
    process.exit(2);
  }
}

// --- The candidates ---------------------------------------------------------
//
// Only the ARM filter is decided here. WHICH EDITORS -- and the cross-check
// against sentence-editors-test.mjs -- are resolved AFTER the `--nesting-only`
// exit, deliberately: see the note above that exit. `PROOFER_ARMS` is a check
// against a constant in this file and reaches no descriptor, so it stays.

const onlyC = (process.env.PROOFER_CANDIDATES || "").split(",").map((s) => s.trim()).filter(Boolean);
const onlyA = (process.env.PROOFER_ARMS || "").split(",").map((s) => s.trim()).filter(Boolean);
// One list, in lib/editor-targets.mjs, because a descriptor may name a subset
// and BOTH have to reject the same typo. A second copy here is how `arms:
// ["intentt"]` passed descriptor validation and ran mutation/checked under the
// typo'd name.
const ALL_ARMS = KNOWN_ARMS;

if (onlyA.length && onlyA.some((a) => !ALL_ARMS.includes(a))) {
  console.error(`PROOFER_ARMS: unknown arm. Known: ${ALL_ARMS.join(", ")}`);
  process.exit(2);
}
// Declared here, resolved below the nesting exit; the artifact writer reads them
// on both paths and gets `undefined` on the one that never selects a target.
let rows, pool, adHoc, drift = null;

// The nesting section needs no network and no editor, so it is worth being able
// to run on its own -- a two-second check of a safety property against a
// candidate content.js.
const NESTING_ONLY = process.argv.includes("--nesting-only");
const OFFLINE = process.argv.includes("--offline");

// --- The artifact, claimed before anything is measured ----------------------
//
// A destination that cannot be written is an exit 2 HERE, not an uncaught
// exception after ten minutes of Chrome. And what it claims the destination
// with is a placeholder saying the run has not finished: an artifact from a
// killed run then reads as a killed run, where a missing file reads as "the
// flag did not work" and a stale one reads as this run's numbers.
const RESULT_JSON = process.env.PROOFER_RESULT_JSON || null;
if (RESULT_JSON) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(RESULT_JSON)), { recursive: true });
    fs.writeFileSync(RESULT_JSON, JSON.stringify({
      schema: "editor-recipe-probe/2", status: "in-progress",
      startedAt: new Date().toISOString(), seed: SEED, pid: process.pid,
      note: "This run did not finish. Numbers below, if any, are not a result.",
    }, null, 2));
  } catch (e) {
    console.error(`\n  PROOFER_RESULT_JSON=${RESULT_JSON} cannot be written (${e.message}).`);
    console.error(`  Refusing to run: a measurement whose artifact has nowhere to go is one `
      + `nobody can check.`);
    process.exit(2);
  }
}

const chrome = await resolveChrome();
const startedAt = new Date();
console.log("\nEditor characterization bench: candidates x the shipping recipes\n" + "=".repeat(74));
console.log(`  Chrome: ${chrome.path} (${chrome.source})`);
if (OFFLINE) console.log("  offline: local files and 127.0.0.1 only; external page requests are blocked");
console.log(`  content.js: ${CONTENT_PATH}`);
console.log(`  sha256: ${short(CONTENT_SHA)}${process.env.PROOFER_CONTENT ? "   << PROOFER_CONTENT OVERRIDE IN EFFECT" : ""}`);
console.log(`  probe: ${short(PROBE_SRC.sha256)}  targets: ${short(TARGETS_SRC.sha256)}`);
console.log(`  ${TRIALS} idle + ${TRIALS} burst trials per cell, keystrokes jittered ${JITTER_MIN}-${JITTER_MAX}ms`);
console.log("");
// THE MEASURED SOURCE, saved beside the result -- not just its hash, and
// written HERE rather than at the end so that every path which PRODUCES
// NUMBERS is covered, `--nesting-only` included. (Argument validation exits 2
// above this line and leaves no snapshot, which is right: it measured nothing,
// and a stray 200KB file for a typo in an env var is noise.)
//
// A hash proves two things are different and tells you nothing about WHAT.
// Three times in one afternoon a hash moved under a published claim, and each
// time the question was the same: did the executable content change, or only a
// comment? Answering it needs the bytes, and both times it was answerable only
// because somebody happened to have kept a copy.
//
// So the run keeps one. `<result>.content.js` beside `<result>.json` makes the
// check mechanical rather than lucky: diff the snapshot against the live file,
// confirm every changed line is a comment, and say so. That is a verification;
// "it was only comments" is an assurance. ~200KB against a measurement that
// costs minutes.
let contentSnapshot = null;
if (RESULT_JSON) {
  const beside = RESULT_JSON.replace(/\.json$/, "") + ".content.js";
  try {
    fs.writeFileSync(beside, CONTENT);
    contentSnapshot = beside;
    console.log(`  measured source saved: ${beside}\n`);
  } catch (e) {
    // Not fatal, and it says so. The measurement is still valid; the audit
    // trail is just thinner. Failing silently is what would make it worthless.
    console.log(`  COULD NOT save the measured source (${e.message}) -- `
      + `sha ${short(CONTENT_SHA)} is this run's only provenance\n`);
  }
}


const browser = await puppeteer.launch({
  headless: true, executablePath: chrome.path,
  // CI's network namespace runs as root, which Chromium cannot sandbox.
  // Only the explicit local-only modes permit that exception. Every live run
  // and every ordinary-user run keeps Chromium's sandbox.
  args: [...((NESTING_ONLY || OFFLINE) && process.getuid?.() === 0
    ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
    ...(OFFLINE ? ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] : []), "--disable-gpu"],
});
const chromeVersion = await browser.version();
const blockedRequests = new Set();

// All three page creation paths use this boundary, including reachability
// probes. A file URL with a host can be a remote UNC share on Windows, so only
// local files are accepted. The network namespace remains CI's socket boundary;
// request interception and the resolver rule protect these pages, not Chrome
// itself. In particular, --offline never retries a blocked URL in live mode.
async function newPage() {
  const page = await browser.newPage();
  if (OFFLINE) {
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      let allowed = false;
      try {
        const url = new URL(request.url());
        allowed = ["about:", "data:", "blob:"].includes(url.protocol)
          || (url.protocol === "file:" && (!url.hostname || url.hostname === "localhost"))
          || (["http:", "https:"].includes(url.protocol) && url.hostname === "127.0.0.1");
      } catch { /* malformed URLs are refused */ }
      if (allowed) {
        request.continue().catch(() => {});
      } else {
        if (!blockedRequests.has(request.url())) console.log(`  OFFLINE BLOCKED: ${request.url()}`);
        blockedRequests.add(request.url());
        request.abort("blockedbyclient").catch(() => {});
      }
    });
  }
  return page;
}

// --- The page ---------------------------------------------------------------
//
// Descriptor-driven, and every branch in it is a field rather than a name: the
// engine must not know that Trix is Trix. That is the whole difference between
// a bench and four hard-coded rows -- an ad-hoc editor gets the same setup path
// the certified ones get, and the ONLY thing it lacks is a quirk somebody has
// already paid for.

async function session(c) {
  const page = await newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e).split("\n")[0]));
  await page.evaluateOnNewDocument(`window.chrome = {
    runtime: { id: "t", lastError: undefined, onMessage: { addListener() {} },
      sendMessage: (m, cb) => setTimeout(() => cb({ ok: true, noChanges: true }), 10) },
    storage: { local: { get: (d, cb) => cb({ ...d }), set: (o, cb) => cb && cb() },
               onChanged: { addListener: () => {} } } };`);
  try {
    await page.goto(c.url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector(c.selector, { timeout: 25000 });
    await sleep(c.readyMs);
    c.finalUrl = page.url();

    const box = await page.evaluate((a) => {
      const els = [...document.querySelectorAll(a.selector)];
      // The OUTERMOST match, not the first. CKEditor's figcaptions carry the same
      // class as the root, and picking one of those measures a 50-character
      // caption instead of the document.
      const outer = a.pickOutermost
        ? els.filter((e) => !els.some((o) => o !== e && o.contains(e))) : els;
      const vis = outer.find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > a.minWidth && r.height > a.minHeight && r.left >= 0;
      }) || outer[0] || els[0];
      if (!vis) return null;
      window.__ed = vis;
      vis.scrollIntoView({ block: "center" });
      const r = vis.getBoundingClientRect();
      const y = Math.min(Math.max(r.top + 14, a.minClickY), Math.max(r.bottom - 14, a.minClickY));
      return { x: Math.round(r.left + Math.min(r.width / 2, 120)), y: Math.round(y),
               matches: els.length, tag: vis.tagName.toLowerCase() };
    }, { selector: c.selector, minClickY: c.minClickY, pickOutermost: c.pickOutermost,
         minWidth: c.minWidth, minHeight: c.minHeight });
    if (!box) throw new Error(`no element for ${c.selector}`);
    c.picked = box;

    if (c.focusVia === "el") {
      await page.evaluate(() => window.__ed.focus());
    } else {
      await page.mouse.click(box.x, box.y);
    }
    await sleep(c.focusSettleMs);
    const focused = await page.evaluate(() => !!document.activeElement
      && (document.activeElement === window.__ed || window.__ed.contains(document.activeElement)));
    // Named, because the fix differs: `focusVia: "el"` is what Trix needed, and
    // a run that reports this as a dead write sends the reader to the splice.
    // The advice has to fit the row. `PROOFER_CANDIDATE_FOCUS=el` reaches an
    // ad-hoc descriptor and NOTHING else, so suggesting it for a built-in row
    // sends the reader to an env var that cannot affect their problem -- and it
    // does not rescue an element that is simply unfocusable either.
    if (!focused) {
      throw new Error(`could not focus ${c.selector} via ${c.focusVia}`
        + (c.focusVia === "click"
            ? (c.source === "ad-hoc"
                ? " -- if this element takes .focus() but not a click, PROOFER_CANDIDATE_FOCUS=el;"
                  + " if it is not editable at all, the selector is wrong"
                : ` -- set focusVia on the ${c.label} row in lib/editor-targets.mjs, or the`
                  + ` page changed and the descriptor is stale`)
            : ""));
    }

    await clear(page, c);
    await page.evaluate(CONTENT);
    await sleep(200);
    errors.length = 0;                 // injection noise is not a write error
    return { page, errors };
  } catch (e) {
    // A page left open per failed setup is a leak that only shows up as a
    // machine slowing down under a long run -- which then reads as jitter.
    await page.close().catch(() => {});
    throw e;
  }
}

// Only used to decide "is it empty", and it has to be: an empty Slate composer
// is not an empty element. Which furniture to remove is a DESCRIPTOR fact --
// see the strip* note in lib/editor-targets.mjs.
const userText = (page, c) => page.evaluate((a) => {
  const n = window.__ed.cloneNode(true);
  if (a.strip.length) for (const x of n.querySelectorAll(a.strip.join(","))) x.remove();
  return n.textContent.replace(new RegExp(`[${a.chars}]`, "g"), "").trim();
}, { strip: c.stripSelectors, chars: c.stripChars });
const dom = (page) => page.evaluate(() => window.__ed.textContent);

async function clear(page, c) {
  for (let i = 0; i < c.clearPasses; i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await sleep(c.clearSettleMs);
    if (!(await userText(page, c))) return true;
  }
  return !(await userText(page, c));
}

async function typeJittered(page, s) {
  for (const ch of s) {
    await page.keyboard.type(ch);
    await sleep(jitter());
  }
}

/** The shipping recipe under test, called directly. */
function fire(page, arm, start, end, replacement) {
  if (arm === "none") return Promise.resolve({ ok: false, outcome: "not-fired", reason: "control" });
  return page.evaluate((a) => {
    const S = window.__prooferSentence;
    if (a.arm === "intent") {
      return S.spliceSentenceSlate(window.__ed, a.start, a.end, a.replacement);
    }
    const caret = a.arm === "mutation-reimpose" ? "reimpose" : "checked";
    return S.spliceSentenceCE(window.__ed, a.start, a.end, a.replacement,
                              { family: "probe", recipe: "mutation", caret });
  }, { arm, start, end, replacement });
}

// --- The trials -------------------------------------------------------------

/**
 * IDLE: nothing is being typed when the write fires. Answers "does the
 * correction land, does the editor's MODEL agree, and is the caret right".
 */
async function idleTrial(page, arm, c) {
  if (!(await clear(page, c))) return { verdict: "VOID", why: "could not clear" };
  await typeJittered(page, TYPO + HEAD);
  await sleep(300);
  const typed = await dom(page);
  if (typed !== TYPO + HEAD) return { verdict: "VOID", why: `typed as ${JSON.stringify(typed)}`, final: typed };

  const res = await fire(page, arm, 0, TYPO.length, FIXED);
  await sleep(350);
  const mid = await dom(page);
  // THE assertion. Everything before it passes with the wrong recipe too.
  await typeJittered(page, MORE);
  await sleep(450);
  const final = await dom(page);

  if (res.ok !== true) {
    return final === TYPO + HEAD + MORE
      ? { verdict: "REFUSED", reason: res.reason || res.outcome, final, res }
      : { verdict: "DAMAGED", why: "refused but the text moved", reason: res.reason || res.outcome, final, res };
  }
  if (mid !== FIXED + HEAD) return { verdict: "DAMAGED", why: "wrong text at the write", final: mid, res };
  if (final === FIXED + HEAD + MORE) return { verdict: "APPLIED", final, res };
  // Two named divergences, because they need different fixes.
  if (final.includes("techncian")) return { verdict: "DAMAGED", why: "model reverted it", final, res };
  if (final === FIXED + MORE + HEAD) return { verdict: "DAMAGED", why: "caret left at the write", final, res };
  return { verdict: "DAMAGED", why: "survived wrong", final, res };
}

/**
 * BURST: the write fires while the user is still typing. The column the idle
 * trials cannot see -- and the only one in which a keystroke can be deleted.
 */
async function burstTrial(page, arm, c) {
  if (!(await clear(page, c))) return { verdict: "VOID", why: "could not clear" };
  await typeJittered(page, TYPO);
  const typing = typeJittered(page, TAIL);
  await sleep(120);
  const res = await fire(page, arm, 0, TYPO.length, FIXED);
  await typing;
  await sleep(700);
  const final = await dom(page);

  const head = res.ok === true ? FIXED : TYPO;
  if (final === head + TAIL) {
    return { verdict: res.ok === true ? "APPLIED" : "REFUSED", reason: res.reason, lost: 0, final, res };
  }
  const lost = userCharsLost(final);
  // Three damage shapes, and they are not the same bug. Naming them is what
  // stops "DAMAGED 8/8" being read as "8 keystrokes deleted".
  const why = lost > 0 ? `${lost} user character(s) DELETED`
    : final.includes(TYPO) ? "correction reverted, user text intact"
    : "user text scrambled, nothing deleted";
  return { verdict: "DAMAGED", why: `${res.ok === true ? "wrote" : `refused (${res.reason})`}: ${why}`,
           reason: res.reason || res.outcome, lost, final, res };
}



// --- Nesting: does an UNMEASURED editor inherit a certified adapter? ---------
//
// The one section here that needs no network and no editor model, because the
// question is purely "which row does the lookup hand back". It runs first and
// unconditionally: it is a safety property, not a candidate measurement, and a
// filtered run that skipped it would be the more dangerous half going unchecked.
//
// THE BUG IT PINS. `getEditableRoot()` stops at a `contenteditable="false"`
// island; `nearestTransport()` used `el.closest()`, which walks straight
// through one. So an editor this registry has never measured -- CKEditor 5
// inside a ProseMirror or Slate node view is the live shape -- resolved to the
// OUTER family's adapter, passed eligibility, and would have been written to
// with a recipe measured against a different editor entirely. Deny-by-default
// was defeated by nesting alone, and CKEditor is a family this registry has
// explicitly REFUSED.
//
// The fixtures are DOM shapes only. That is the whole of what is being tested
// and it is why a fixture is honest here, where it would not be for a write:
// there is no editor model to disagree with, because no adapter should be
// returned at all.
const NEST_HOSTS = {
  Slate:       '<div data-slate-editor="true" contenteditable="true" id="%ID%">%KIDS%</div>',
  ProseMirror: '<div class="ProseMirror" contenteditable="true" id="%ID%">%KIDS%</div>',
  Quill:       '<div class="ql-editor" contenteditable="true" id="%ID%">%KIDS%</div>',
  Lexical:     '<div data-lexical-editor="true" contenteditable="true" id="%ID%">%KIDS%</div>',
  Draft:       '<div class="public-DraftEditor-content" contenteditable="true" id="%ID%">%KIDS%</div>',
  Trix:        '<trix-editor contenteditable="true" id="%ID%">%KIDS%</trix-editor>',
};
// An editor with NO registry row. CKEditor 5 by name, because it is the one
// this round measured and refused, so "unregistered" is not hypothetical here.
const UNREGISTERED = '<div class="ck-editor__editable" contenteditable="true" id="%ID%">The techncian arrived early.</div>';
const island = (kids) => `<div contenteditable="false" data-node-view="1">${kids}</div>`;
const host = (family, id, kids) =>
  NEST_HOSTS[family].replace("%ID%", id).replace("%KIDS%", kids);

const nesting = [];
let nestingFailed = 0;
{
  console.log("Nesting: an unmeasured editor must not inherit a certified adapter");
  const known = await import("./lib/content-sandbox.mjs").then((m) => m.SN_TRANSPORTS);
  // An empty registry generates no checks, prints "0/0 passed" and exits 0 --
  // the same vacuous green this file's exit policy exists to prevent, one level
  // up. A candidate content.js that lost its registry must FAIL here, not pass
  // by having nothing to test.
  if (!Array.isArray(known) || known.length === 0) {
    console.error(`  FAIL: ${CONTENT_PATH} exposes no SN_TRANSPORTS rows. `
      + `Zero checks would print 0/0 and exit 0.`);
    process.exit(2);
  }
  const missing = known.filter((r) => !NEST_HOSTS[r.family]).map((r) => r.family);
  if (missing.length) {
    // A second hand-maintained table, so it says so when it falls behind:
    // a family with no fixture here is a family whose boundary is unchecked.
    console.log(`  FAIL: no nesting fixture for ${missing.join(", ")}`);
    nestingFailed += missing.length;
  }
  const page = await newPage();
  await page.goto("about:blank");
  const checks = [];
  for (const row of known) {
    if (!NEST_HOSTS[row.family]) continue;
    checks.push(
      // The hazard, exactly as the audit describes it.
      { name: `${row.family} > [ce=false] > unregistered`, id: "inner", want: null,
        html: host(row.family, "outer", island(UNREGISTERED.replace("%ID%", "inner"))) },
      // The control that stops the fix being "deny everything": the outer host
      // itself still resolves, and to its own family.
      { name: `${row.family} itself still resolves`, id: "outer", want: row.family,
        html: host(row.family, "outer", island(UNREGISTERED.replace("%ID%", "inner"))) },
      // A REGISTERED inner host across the same boundary takes ITS OWN row,
      // not the outer one -- the boundary must not deny a measured editor.
      { name: `${row.family} > [ce=false] > Quill`, id: "inner", want: "Quill",
        html: host(row.family, "outer", island(host("Quill", "inner", "text"))) },
      // And the pre-existing nesting rule survives: continuously editable, no
      // island, innermost still wins.
      { name: `${row.family} > Quill, no island`, id: "inner", want: "Quill",
        html: host(row.family, "outer", host("Quill", "inner", "text")) },
    );
  }
  for (const ch of checks) {
    await page.setContent(`<body>${ch.html}</body>`);
    await page.evaluate(CONTENT);
    const got = await page.evaluate((id) => {
      const el = document.getElementById(id);
      const a = window.__prooferSentence.editorAdapterFor(el);
      const st = window.__prooferSentence.sentenceFieldStatus(el);
      return { family: a ? a.family : null, ok: st.ok, detail: st.detail, stFamily: st.family };
    }, ch.id);
    // Both doors, not one. `editorAdapterFor` picks the recipe and
    // `sentenceFieldStatus` decides eligibility and names the family to the
    // popup; they call the same lookup, and checking only one would leave the
    // other free to drift into reporting a family that cannot be written to.
    const pass = got.family === ch.want
      && (ch.want === null ? got.ok === false && got.detail === "unknown-editor" && got.stFamily === null
                           : got.ok === true && got.stFamily === ch.want);
    console.log(`  ${pass ? "PASS" : "FAIL"}: ${ch.name} -> ${JSON.stringify(got)} (want ${ch.want})`);
    nesting.push({ ...ch, got, pass, html: undefined });
    if (!pass) nestingFailed++;
  }
  await page.close();
  console.log("");
}

/**
 * One writer for the artifact, on every exit path that got far enough to have
 * one. `status` is the field that makes it self-describing: the placeholder
 * written before Chrome launched says "in-progress", and anything that reads
 * this file can tell a killed run from a finished one without knowing what the
 * numbers should have looked like.
 */
function writeArtifact(status, extra = {}) {
  if (!RESULT_JSON) return true;      // nothing asked for is not a failure
  const finishedAt = new Date();
  const body = {
    schema: "editor-recipe-probe/2",
    status,
    mode: NESTING_ONLY ? "nesting-only" : "full",
    offline: OFFLINE,
    blockedRequests: [...blockedRequests],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    command: { argv: process.argv.slice(1), node: process.version },
    env: {
      trials: TRIALS,
      seed: SEED,
      jitterMs: [JITTER_MIN, JITTER_MAX],
      candidates: process.env.PROOFER_CANDIDATES || null,
      arms: process.env.PROOFER_ARMS || null,
      allowVoid: process.env.PROOFER_ALLOW_VOID === "1",
      allowTargetDrift: process.env.PROOFER_ALLOW_TARGET_DRIFT === "1",
      adHoc: adHoc ? { url: adHoc.url, selector: adHoc.selector, name: adHoc.family } : null,
    },
    probe: PROBE_SRC,
    targetsLib: TARGETS_SRC,
    content: { path: CONTENT_PATH, sha256: CONTENT_SHA,
               override: !!process.env.PROOFER_CONTENT, snapshot: contentSnapshot },
    chrome: { path: chrome.path, source: chrome.source, version: chromeVersion },
    recipeStamp: "spliceSentenceSlate 2026-08-14: same-tick selection + targetRanges + misplaced check",
    // `null` on the nesting-only path, and that is a fact about the run rather
    // than a missing field: that path resolves no targets and cross-checks
    // nothing, because it drives no editor.
    targetDriftCheck: drift,
    // The FULL resolved descriptor, not the name. A cell means nothing without
    // the setup that produced it, and "Trix" is not the setup -- `focusVia` is.
    targets: rows || [],
    nesting,
    ...extra,
  };
  // TEMP THEN RENAME, and the caller must act on `false`.
  //
  // Two defects in one line before this. Overwriting the placeholder IN PLACE
  // means a write that dies halfway leaves a truncated JSON where a complete one
  // is expected -- and the placeholder it destroyed was the thing that would
  // have said the run did not finish. And the failure was caught and logged
  // beside `exit 0`: a green run whose artifact is `in-progress`, partial, or
  // invalid, which is this file's own "completes green and produces nothing"
  // with the production step moved to the very end. The pre-refactor version was
  // accidentally better here -- its final write threw and the process died
  // nonzero.
  //
  // Rename is atomic within a filesystem, and `<dest>.tmp` sits beside the
  // destination so it is the same one.
  const tmp = RESULT_JSON + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, RESULT_JSON);
    console.log(`\n  wrote ${RESULT_JSON}`);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    console.error(`\n  COULD NOT WRITE THE ARTIFACT to ${RESULT_JSON} (${e.message}).`);
    console.error(`  The measurement happened and cannot be checked, so this run FAILS: `
      + `the console above is not a substitute for the per-trial record.`);
    return false;
  }
}

if (NESTING_ONLY) {
  await browser.close();
  console.log(`\n  nesting: ${nesting.filter((n) => n.pass).length}/${nesting.length} passed`);
  // A flag that SELECTS A TARGET on the path that drives no editor does nothing,
  // and saying so is the difference between "ignored" and "did not work". The
  // targets themselves are never resolved here, so this reads the raw
  // environment rather than the descriptors.
  const irrelevant = ["PROOFER_CANDIDATES", "PROOFER_CANDIDATE_URL", "PROOFER_CANDIDATE_SELECTOR",
                      "PROOFER_ARMS", "PROOFER_TRIALS", "PROOFER_SEED"]
    .filter((k) => process.env[k]);
  if (irrelevant.length) {
    console.log(`  NOTE: --nesting-only drives no editor, so ${irrelevant.join(", ")} `
      + `had no effect on this run.`);
  }
  // It used to exit here having silently ignored PROOFER_RESULT_JSON -- a flag
  // that does nothing is worse than one that is rejected, because the caller
  // goes looking for a file that was never going to exist.
  const wrote = writeArtifact(nestingFailed ? "failed" : "ok",
                              { table: [], skipped: [], ignoredEnv: irrelevant });
  process.exit(nestingFailed ? 1 : (wrote ? 0 : 2));
}

// --- WHICH EDITORS, and do the two tables agree ------------------------------
//
// BELOW THE NESTING EXIT ON PURPOSE, and the reason that decides it is
// ATTRIBUTION rather than anything about URLs. `--nesting-only` answers one
// question -- does an unmeasured editor inherit a certified adapter -- and
// failing it because a *target descriptor* disagreed with another file's table
// would report that answer as wrong when it was never asked. A run must not be
// able to fail for a reason it does not depend on.
//
// The second reason is that this path runs in CI, where the network is denied
// outright -- so keeping targets off it makes "the nesting matrix touches no
// demo site" true of the TEXT as well as of the run, and a reader can settle it
// without executing anything.
//
// STATED WITHOUT REACHING INTO THE CI FILES, deliberately, and the restraint was
// bought twice this week. Two headers here described mechanisms their code did
// not have; both were fixed; and one of the fixes was itself a fresh claim about
// the statement order in THIS file, which a refactor invalidated days later.
// Correcting a claim is not the same as noticing it should not have been made.
// So: nothing above asserts what any CI file checks or how. What is asserted is
// about this file, which is the only thing it can keep true.
//
// editor-bench-selfcheck exercises both paths with --offline: nesting ignores
// target selection, local full runs measure real cells, and an external target
// is blocked and exits 77 with no cells. None may fall back to a live request.
//
// PROOFER_CANDIDATES keeps its exact old meaning -- a comma-separated filter,
// and matching NOTHING is an error rather than a run of zero cells -- and it now
// also reaches the certified editors the probe's default four leave out, plus an
// ad-hoc row.
try { ({ rows, pool, adHoc } = resolveTargets({ names: onlyC })); }
catch (e) { console.error(`\n  ${e.message}`); await browser.close(); process.exit(2); }
if (!rows.length) {
  console.error(`PROOFER_CANDIDATES=${process.env.PROOFER_CANDIDATES} matched nothing. `
    + `Known: ${pool.map((c) => c.label).join(", ")}`);
  await browser.close();
  process.exit(2);
}

// sentence-editors-test.mjs keeps its own TARGETS list -- it is a gate, and it
// launches Chrome at module scope, so it cannot be imported. The copy is
// therefore CHECKED rather than trusted: identity fields only (url, selector,
// family, recipe, focusVia), because two files disagreeing about those means one
// of them measured a different editor. MANDATORY on every path that measures a
// live editor, which is every path that gets this far.
drift = crossCheckEditorsSuite();
if (drift.error || !drift.ok) {
  console.error(`\n  TARGET DRIFT against ${path.basename(drift.file)}:`);
  if (drift.error) console.error(`    ${drift.error}`);
  for (const d of drift.drift) console.error(`    ${d}`);
  console.error(`  One of the two tables is driving a different editor than it says. `
    + `PROOFER_ALLOW_TARGET_DRIFT=1 to measure anyway.`);
  if (process.env.PROOFER_ALLOW_TARGET_DRIFT !== "1") { await browser.close(); process.exit(2); }
}
// After an override the banner used to say the targets "agree", which is the
// override reporting itself as the thing it overrode.
console.log(drift.ok
  ? `  targets agree with sentence-editors-test.mjs on ${drift.checked} row(s)`
  : `  TARGETS DO NOT AGREE with sentence-editors-test.mjs `
    + `(${drift.error ? "cross-check could not run" : `${drift.drift.length} disagreement(s)`}); `
    + `PROOFER_ALLOW_TARGET_DRIFT=1 is set, so this run measured anyway`);
for (const c of rows) {
  console.log(`  - ${c.label.padEnd(22)} ${c.source === "ad-hoc" ? "[AD-HOC] " : ""}${c.url}  ${c.selector}`);
}
console.log("");

// --- Reachability -----------------------------------------------------------

const skipped = [];
for (const c of rows) {
  const probe = await newPage();
  try {
    await probe.goto(c.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // The URL a run actually measured. A demo site that redirects to a new
    // examples path is the shape the "the page moved" branch exists for, and a
    // recorded request URL cannot show it.
    c.finalUrl = probe.url();
    const has = await probe.waitForSelector(c.selector, { timeout: 20000 }).then(() => true, () => false);
    // Reachable but no editor is NOT an outage: the selector is this file's
    // contract with the demo site, and a quiet skip would let a moved page hide
    // behind it.
    if (!has) c.moved = `loaded but has no ${c.selector}`;
  } catch (e) {
    c.unreachable = String(e.message || e).split("\n")[0];
    skipped.push(c);
  }
  await probe.close();
}

// --- The run ----------------------------------------------------------------

const table = [];
for (const c of rows) {
  console.log(`\n${c.label}  ${c.url}${c.finalUrl && c.finalUrl !== c.url ? `  -> ${c.finalUrl}` : ""}`);
  if (c.quirk) console.log(`  — ${c.quirk}`);
  if (c.unreachable) { console.log(`  SKIP: unreachable (${c.unreachable})`); continue; }
  if (c.moved) { console.log(`  BROKEN ROW: ${c.moved}`); continue; }

  const arms = (onlyA.length ? onlyA : (c.arms || ALL_ARMS));
  for (const arm of arms) {
    // `source` and `selector` ride along because the exit rule needs them: a
    // built-in row failing setup is a failure and an ad-hoc one is a
    // configuration error, and by the time that is decided the descriptor is no
    // longer in hand.
    const cell = { family: c.family, label: c.label, source: c.source, selector: c.selector,
                   arm, idle: {}, burst: {}, errors: [], details: [], trials: [] };
    table.push(cell);
    for (const phase of ["idle", "burst"]) {
      if (arm === "none" && phase === "idle") continue;   // no write to score
      let s;
      try { s = await session(c); } catch (e) {
        console.log(`  ${arm}/${phase}: SETUP FAILED — ${e.message}`);
        cell[phase].setup = e.message;
        continue;
      }
      const { page, errors } = s;
      // PER-TRIAL exception attribution. Keeping three per phase made
      // "Trix throws on every dispatch, 8/8" unprovable from the artifact --
      // six identical strings in a JSON say "repeatedly", not "every time",
      // and the claim that went into content.js was the stronger one.
      cell[phase].threwIn = 0;
      cell[phase].errorTotal = 0;
      for (let i = 0; i < TRIALS; i++) {
        errors.length = 0;
        const t0 = Date.now();
        let r;
        try {
          r = phase === "idle" ? await idleTrial(page, arm, c) : await burstTrial(page, arm, c);
        } catch (e) { r = { verdict: "VOID", why: String(e.message).split("\n")[0] }; }
        cell[phase][r.verdict] = (cell[phase][r.verdict] || 0) + 1;
        if (r.lost) cell[phase].lost = (cell[phase].lost || 0) + r.lost;
        if (errors.length) {
          cell[phase].threwIn++;
          cell[phase].errorTotal += errors.length;
          if (cell.errors.length < 4) cell.errors.push(`trial ${i}: ${errors[0]}`);
        }
        // EVERY trial, with its final text -- not only the interesting ones.
        // The console prints a budget; the artifact prints the run. A cell that
        // is 8/8 APPLIED and one that is 8/8 APPLIED with a different final in
        // trial 3 are the same summary and different measurements.
        cell.trials.push({ phase, i, verdict: r.verdict, why: r.why || null,
                           reason: r.reason || (r.res && (r.res.reason || r.res.outcome)) || null,
                           lost: r.lost || 0, final: r.final === undefined ? null : r.final,
                           result: r.res || null, pageErrors: errors.slice(), ms: Date.now() - t0 });
        if (r.verdict !== "APPLIED") {
          // Say when it was cut. A final clipped at 90 characters with no mark
          // reads as the whole field, and "the correction is missing from the
          // end" is exactly the shape that hides in a silent clip -- the same
          // rule this file applies to its detail budget, one level down at the
          // string. The JSON keeps the full text either way.
          const full = JSON.stringify(r.final || "");
          const shown = full.length > 90 ? `${full.slice(0, 90)}… (+${full.length - 90} more, full text in the JSON)` : full;
          cell.details.push(`${phase}[${i}] ${r.verdict} ${r.why || r.reason || ""} ${shown}`);
        }
      }
      await page.close();
      const n = cell[phase];
      console.log(`  ${arm.padEnd(18)} ${phase.padEnd(5)} `
        + `APPLIED ${n.APPLIED || 0}/${TRIALS}  REFUSED ${n.REFUSED || 0}  `
        + `DAMAGED ${n.DAMAGED || 0}  VOID ${n.VOID || 0}`
        + (n.lost ? `  user chars DELETED ${n.lost}` : "")
        + (n.threwIn ? `  page exceptions in ${n.threwIn}/${TRIALS} trials (${n.errorTotal})` : ""));
    }
    // PER PHASE, AND BY SEVERITY -- two rounds of the same defect.
    //
    // First round: the console printed `details.slice(0, 6)` across both phases
    // combined, and idle notes are pushed first, so a cell with 8 idle refusals
    // and 8 damaged burst trials printed eight refusals and NOT ONE damaged
    // final. A whole phase hidden behind another.
    //
    // Second round, and a per-phase budget alone does NOT fix it: within a
    // phase the notes are still in TRIAL order, so a cell whose early trials
    // happened to be ordinary starves the damaged ones the cell exists to
    // characterise. Measured on this run's own artifacts rather than imagined --
    // Draft and Trix burst held 6 DAMAGED notes each and a trial-order slice
    // showed 4. (Caught by the sibling probe's author finding the same shape in
    // their file and saying so; mine hid a phase, theirs hid whatever sorted
    // late.)
    //
    // So: worst first, then trial order, and ALWAYS say what was dropped. A
    // truncation that does not announce itself is indistinguishable from
    // "that is all there was", which is this whole family in one line.
    const SEVERITY = { DAMAGED: 0, VOID: 1, REFUSED: 2 };
    const rank = (line) => {
      const m = line.match(/\]\s+(\w+)/);
      return m && SEVERITY[m[1]] !== undefined ? SEVERITY[m[1]] : 3;
    };
    for (const phase of ["idle", "burst"]) {
      const d = cell.details
        .map((line, i) => ({ line, i }))
        .filter((x) => x.line.startsWith(phase))
        .sort((a, b) => rank(a.line) - rank(b.line) || a.i - b.i);
      for (const x of d.slice(0, 4)) console.log(`      ${x.line}`);
      if (d.length > 4) {
        console.log(`      ... and ${d.length - 4} more ${phase}, worst shown first; `
          + `all of them are in the JSON artifact`
          + (RESULT_JSON ? "" : " -- SET PROOFER_RESULT_JSON, this run keeps none"));
      }
    }
    if (cell.errors.length) console.log(`      page errors: ${JSON.stringify(cell.errors)}`);
  }
}

await browser.close();

// --- The matrix -------------------------------------------------------------

console.log("\n" + "=".repeat(74));
console.log(`  ${TRIALS} trials per phase, seed ${SEED}. A/R/D is APPLIED / REFUSED / DAMAGED;`);
console.log("  DELETED counts characters the USER typed that are absent from the final");
console.log("  text altogether -- a reverted correction is damage, not data loss.");
// 34 wide, not 28: an ad-hoc row is named by whoever ran it, and
// "CodeMirror6 / mutation-reimpose" overflowed the column and pushed every
// number in that line out of its heading. A matrix that does not line up is one
// people read by counting, which is how a cell gets attributed to the arm above.
console.log("\n  editor / arm                       idle A/R/D        burst A/R/D   DELETED  VOID  setup");
// VOID and setup are COLUMNS, not a footnote. A cell that could not run is the
// one thing a matrix must not print as a quiet zero: 0/0/0 next to a row of
// real numbers reads as "measured, and nothing happened".
let unmeasured = 0;
for (const c of table) {
  const i = c.idle, b = c.burst;
  const f = (n) => `${n.APPLIED || 0}/${n.REFUSED || 0}/${n.DAMAGED || 0}`;
  const voids = (i.VOID || 0) + (b.VOID || 0);
  const setup = [i.setup ? "idle" : null, b.setup ? "burst" : null].filter(Boolean).join("+") || "-";
  // A cell with no trials at all in a phase that should have run.
  const ranIdle = c.arm === "none" || (i.APPLIED || 0) + (i.REFUSED || 0) + (i.DAMAGED || 0) + (i.VOID || 0) > 0;
  const ranBurst = (b.APPLIED || 0) + (b.REFUSED || 0) + (b.DAMAGED || 0) + (b.VOID || 0) > 0;
  if (!ranIdle || !ranBurst || voids || i.setup || b.setup) unmeasured++;
  c.unmeasured = !ranIdle || !ranBurst || !!voids || !!i.setup || !!b.setup;
  console.log(`  ${(c.label + " / " + c.arm).padEnd(34)} ${f(i).padEnd(17)} ${f(b).padEnd(13)} `
    + `${String(b.lost || 0).padEnd(8)} ${String(voids).padEnd(5)} ${setup}`
    + (ranIdle && ranBurst ? "" : "   << PHASE DID NOT RUN"));
}
const broken = rows.filter((c) => c.moved);
if (skipped.length) {
  console.log(`\n  SKIPPED (unreachable): ${skipped.map((c) => c.label).join(", ")}`);
  console.log("  Those editors were NOT measured by this run.");
}
if (broken.length) {
  console.log(`\n  BROKEN ROWS: ${broken.map((c) => `${c.label} (${c.moved})`).join(", ")}`);
}

// FAIL LOUD. An unreachable site is a 77; a site that loaded and then failed to
// set up, or a trial that voided, used to be a comment in the scroll-back next
// to an exit 0. Both are "this run did not measure what it printed", which is
// the same condition, so they get the same exit code.
//
// And a run with NO CELLS AT ALL is its own exit, ahead of both. Every row
// unreachable or every row broken prints a banner, a heading and an empty
// table, which is the most convincing shape a vacuous run can take -- it looks
// like a matrix in which nothing went wrong. It is the commonest outcome of a
// mistyped ad-hoc selector, so it is now the loudest thing this file says.
//
// BUT NOT ALL EMPTINESS IS THE SAME EMPTINESS, and collapsing the two undid the
// exit-code contract this file has had from the start. A machine with no network
// leaves every row UNREACHABLE, which is an outage and has always been a 77; a
// page that LOADED and matched no element is a claim about the selector, and no
// outage excuse covers it. The first version of this branch exited 2 for both,
// so running the probe offline reported a configuration error -- the one reading
// a 77 exists to prevent. The evidence is already separated (`skipped` vs
// `moved`), so the exit follows it: any broken row is a 2, otherwise an outage.
// WHOSE CLAIM FAILED. That is the whole rule, and it decides 1 from 2 from 77:
//
//   the SITE was unreachable          nobody's claim -- an outage        77
//   a BUILT-IN descriptor was wrong   this repo says the page has that
//                                     selector, and it does not          1
//   an AD-HOC row was wrong           the caller typed it on the
//                                     command line                       2
//   a NESTING check failed            the shipping registry lookup       1
//
// Two things this replaces, both of which the audit was right about. Cardinality
// decided the meaning: one broken row among several was a 77 and the same broken
// row alone was a 2, so an exit code moved with how many editors you happened to
// ask for. And `!table.length` was tested BEFORE `nestingFailed`, so a genuine
// nesting failure -- the safety property, the one thing here that is a gate --
// could exit as "no cells" whenever the live rows also failed to produce any.
// Nesting is first now, unconditionally.
//
// The repo's contract is explicit and this file was contradicting it: a page
// that LOADS and has no editor at the expected selector "exits 1 -- the site
// moved and the selector needs re-pointing, which is not an outage"
// (TESTING.md, the sentence-editors-test 77 contract). The ad-hoc exception is
// not a softening of that rule but a different claim failing: nothing in the
// repo asserted that URL, so there is no repo claim to falsify.
const isAdHoc = (x) => x.source === "ad-hoc";
const setupCells = table.filter((c) => c.idle.setup || c.burst.setup);
const voidCells = table.filter((c) => !c.idle.setup && !c.burst.setup && c.unmeasured);
const brokenBuiltIn = broken.filter((c) => !isAdHoc(c));
const setupBuiltIn = setupCells.filter((c) => !isAdHoc(c));

let status = "ok", code = 0;
if (nestingFailed) {
  console.log(`\n  ${nestingFailed} NESTING CHECK(S) FAILED -- the transport lookup is `
    + `handing an adapter to an editor that has none. Exiting 1.`);
  console.log(`  This is a safety property and it is checked FIRST: it does not depend on `
    + `any live editor, so nothing about the run below can excuse it.`);
  status = "nesting-failed"; code = 1;
} else if (setupCells.length) {
  // A page that LOADED and then could not be focused, clicked, cleared or
  // injected into is not an outage. It is a broken click calculation, a wrong
  // focus strategy, a descriptor that has gone stale, or a bug in this probe --
  // and every one of those used to exit 77, so a probe regression reported
  // itself as "the site is down" and a batch runner skipped past it.
  console.log(`\n  ${setupCells.length} CELL(S) FAILED TO SET UP on a page that LOADED `
    + `(${setupCells.map((c) => c.label).join(", ")}).`);
  console.log(`  That is a harness or descriptor failure, not an outage: the site answered, `
    + `and the probe could not drive it.`);
  status = "setup-failed"; code = setupBuiltIn.length ? 1 : 2;
} else if (brokenBuiltIn.length) {
  console.log(`\n  ${brokenBuiltIn.length} BUILT-IN ROW(S) LOADED WITHOUT THEIR SELECTOR `
    + `(${brokenBuiltIn.map((c) => `${c.label}: ${c.selector}`).join(", ")}).`);
  console.log(`  The example page moved and the descriptor needs re-pointing. Exiting 1, `
    + `per the repo's contract: reachable-but-wrong is a failure, not a skip.`);
  status = "row-broken"; code = 1;
} else if (broken.length) {
  console.log(`\n  ${broken.length} AD-HOC ROW(S) LOADED WITHOUT THEIR SELECTOR `
    + `(${broken.map((c) => `${c.label}: ${c.selector}`).join(", ")}).`);
  console.log(`  Nothing in this repo asserted that selector, so this is a configuration `
    + `error rather than a broken claim. Check it against the live page.`);
  status = "adhoc-selector-missed"; code = 2;
} else if (!table.length && skipped.length === rows.length) {
  console.log(`\n  NOTHING WAS MEASURED: all ${rows.length} row(s) were unreachable. `
    + `That is an outage, not a result.`);
  status = "all-unreachable"; code = EXIT_SKIPPED;
} else if (!table.length) {
  // Backstop. Every route to an empty table is named above, so reaching this is
  // itself a defect -- and it says so rather than picking a plausible exit.
  console.log(`\n  NO CELLS WERE MEASURED, for a reason this file does not have a name for `
    + `(${rows.length} row(s), ${skipped.length} unreachable, ${broken.length} broken).`);
  status = "no-cells"; code = 2;
} else if (voidCells.length && process.env.PROOFER_ALLOW_VOID !== "1") {
  // VOID keeps 77, and the distinction from setup failure is deliberate: a void
  // trial is the editor doing something the trial did not expect ON a page that
  // loaded and focused -- demo-site flakiness far more often than a probe bug --
  // whereas setup never got as far as a trial at all.
  console.log(`\n  ${voidCells.length} CELL(S) DID NOT FULLY MEASURE (a void trial or a phase `
    + `that never ran).\n  PROOFER_ALLOW_VOID=1 to accept that deliberately.`);
  status = "incomplete"; code = EXIT_SKIPPED;
} else if (skipped.length) {
  status = "skipped"; code = EXIT_SKIPPED;
}
if (voidCells.length && code === 0) {
  console.log(`\n  ${voidCells.length} cell(s) did not fully measure; PROOFER_ALLOW_VOID=1 is set.`);
  status = "incomplete-allowed";
}
// The artifact is part of the deliverable, so failing to write it changes the
// answer. A run that measured everything and then lost the per-trial record is
// not a pass -- the console kept a budget, not the run. It cannot make a real
// failure less severe, so exit 1 stands; anything else becomes 2.
const wrote = writeArtifact(status, {
  table,
  summary: { cells: table.length, unmeasured, nestingFailed,
             setupFailed: setupCells.map((c) => `${c.label}/${c.arm}`),
             voids: voidCells.map((c) => `${c.label}/${c.arm}`),
             skipped: skipped.map((c) => c.label), broken: broken.map((c) => c.label) },
  exit: { code, status },
});
if (!wrote && code !== 1) { status = "artifact-write-failed"; code = 2; }
process.exit(code);
