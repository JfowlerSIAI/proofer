#!/usr/bin/env node
// Output guards for sentence mode. No Ollama, no browser.
//
//   node sentence-guard-test.mjs
//
// Sentence mode applies the model's output with no panel and no click, so these
// guards are the last thing between the model and the user's text. Two error
// directions, and they are NOT symmetric:
//
//   a LEAK (bad edit applied)         silently rewrites words the user typed
//   a FALSE REJECT (real fix blocked) leaves the original text unchanged
//
// These regression cases pin the guard policy independently of model output.
// Identified log-derived sentence carriers are rewritten as standalone
// examples, retaining the spelling, punctuation, casing and token-boundary
// mechanisms needed by the assertions.

// Both sides are loaded out of the files that SHIP -- guardSentenceResult from
// background.js, MIN_SENTENCE_CHARS from content.js -- so the drift check below
// compares the two real copies rather than two copies in test/lib.
import {
  guardSentenceResult, guardSentenceReport, changedWordCount, THRESHOLDS,
  parseConfusables, fetchConfusables, setConfusables, diskFetch,
  fetchNames, setNames, NAMES_COUNT, HAND_NAMES,
  CONFUSABLES_COUNT, CONFUSABLES_SHA256,
  setDictionary, isWord,
  sentenceTriggerOf, SENTENCE_TRIGGERS,
  isReinflection, isConfusable, CONFUSABLE, finalTokenInflectionOnly,
  isBlessedContractionReplacement, BLESSED_CONTRACTION_REPLACEMENTS,
} from "./lib/sentence-guards.mjs";
import { MIN_SENTENCE_CHARS } from "./lib/content-sandbox.mjs";
import { readFileSync } from "fs";
import { build, render, payloadDigest } from "./build-confusables.mjs";

let pass = 0;
const leaks = [], falseRejects = [];
const failures = [];

function ok(label, cond, detail = "") {
  if (cond) { pass++; return; }
  failures.push(label);
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ""}`);
}

function check(label, original, output, shouldApply) {
  const reason = guardSentenceResult(original, output, output);
  const applied = reason === null;
  if (applied === shouldApply) { pass++; return; }
  (shouldApply ? falseRejects : leaks).push({ label, original, output, reason });
  console.log(`  FAIL  ${label}`);
  console.log(`          ${JSON.stringify(original)}`);
  console.log(`       -> ${JSON.stringify(output)}`);
  console.log(`          got ${applied ? "APPLY" : `REFUSE (${reason})`}, wanted ${shouldApply ? "APPLY" : "REFUSE"}`);
}

const refuse = (l, o, r) => check(l, o, r, false);
const apply = (l, o, r) => check(l, o, r, true);

/**
 * The same pair, pinned to the WHOLE chain rather than to its first answer.
 *
 * `refuse` proves a guard fired. It cannot prove which one, and it cannot prove
 * that the guards AFTER it stayed quiet -- so a narrowing that opens a hole two
 * guards further down reads as green, because a hazard is still refused by
 * something. Every fixture of the 2026-08-15 narrowing round names its full
 * expected list: the first entry proves the intended guard fired, and each
 * later one proves the chain did not stop before it. An empty list is an APPLY.
 */
function reasonsAre(label, original, output, expected) {
  const rep = guardSentenceReport(original, output, output);
  const got = rep.reasons;
  const same = JSON.stringify(got) === JSON.stringify(expected);
  // guardSentenceResult is what production calls; assert the two agree here
  // too, so a fixture can never be pinned against a mode nobody ships.
  const live = guardSentenceResult(original, output, output);
  const agrees = live === (expected.length ? expected[0] : null);
  if (same && agrees) { pass++; return; }
  (expected.length ? leaks : falseRejects).push({ label, original, output, reason: got.join(",") });
  console.log(`  FAIL  ${label}`);
  console.log(`          ${JSON.stringify(original)}`);
  console.log(`       -> ${JSON.stringify(output)}`);
  console.log(`          got ${JSON.stringify(got)}, wanted ${JSON.stringify(expected)}`
    + (agrees ? "" : `; guardSentenceResult said ${JSON.stringify(live)}`));
}

console.log("\nSentence-mode output guards\n" + "=".repeat(72));

// The guards ship inside background.js and the segmenter inside content.js, and
// MV3 gives them no way to share a module — so this constant exists twice on
// purpose. Assert the two SHIPPING copies agree, because a silent divergence
// would let the segmenter emit targets the guards then reject as too short, and
// the feature would just quietly stop working on short sentences.
console.log("\nDuplicated constants agree (background.js vs content.js):");
if (THRESHOLDS.minTargetChars === MIN_SENTENCE_CHARS) {
  pass++;
} else {
  falseRejects.push({ label: "MIN_SENTENCE_CHARS drift" });
  console.log(`  FAIL  background.js minTargetChars=${THRESHOLDS.minTargetChars} but content.js MIN_SENTENCE_CHARS=${MIN_SENTENCE_CHARS}`);
}

// --- The dominant failure: the model EDITS instead of proofreading -----------
// Every one of these passes token overlap, length, sentence count and the
// changed-word limit. Substitution of a content word is what catches them.
console.log("\nSynonym substitution (measured on the clean corpus):");
refuse("problem -> issue", "It turned out to be a caching problem.", "It turned out to be a caching issue.");
refuse("done -> complete", "Once the audit is done, we can close out the remaining tickets.", "Once the audit is complete, we can close out the remaining tickets.");
refuse("park -> postpone", "Let's park that until after the review.", "Let's postpone that until after the review.");
refuse("asked -> requested", "They've asked for a written summary by Friday.", "They have requested a written summary by Friday.");
refuse("went -> was sent", "The invoice went to Smith & Co. by mistake.", "The invoice was sent to Smith & Co. by mistake.");
refuse("abbreviation expanded", "That's approx. 200 users a day.", "That's approximately 200 users a day.");

console.log("\nContraction expansion (asymmetric: removing one is an edit, adding one is a fix):");
refuse("They've -> They have", "They've asked for a written summary by Friday.", "They have asked for a written summary by Friday.");
refuse("It's -> It is", "It's worth doing properly the first time.", "It is worth doing properly the first time.");
refuse("He's -> He has", "He's been on leave since the start of the month.", "He has been on leave since the start of the month.");

console.log("\nTypography the user chose:");
refuse("curly -> straight quotes", "She called it a “best-effort” estimate.", "She called it a \"best-effort\" estimate.");
refuse("en dash -> hyphen", "The range is 40–60 basis points.", "The range is 40-60 basis points.");

console.log("\nRegister and scope:");
refuse("casual note formalised", "ok will do", "ok, we'll do that.");
refuse("restyled entirely", "Can you take a look at slide 11 before we send it?", "Please review slide 11 prior to distribution.");
refuse("negation added", "I think we should wait for the numbers.", "I think we should not wait for the numbers.");
// Negation hides inside contractions. Listing "n't" as a protected token could
// never match — bare("don't") is "don't" — so these two silently reversed the
// meaning of the user's sentence and passed every other guard.
refuse("negation added via contraction", "I do agree with the proposal today.", "I don't agree with the proposal today.");
refuse("negation added via can't", "We can ship it on Friday morning.", "We can't ship it on Friday morning.");
refuse("negation removed", "I don't agree with the proposal today.", "I do agree with the proposal today.");
refuse("number changed", "Revenue was $1,200 in Q3.", "Revenue was $1,500 in Q3.");

// Found by the GPT-5.6 audit, by running them rather than reading the code.
// Each passed every other guard.
console.log("\nWord substitution the first guard set missed:");
// "car" is a prefix of "carpet" three characters shorter, so a bare length
// check read it as a reinflection. The suffix has to look like an inflection.
refuse("prefix truncation is not an inflection",
  "The red carpet was rolled out before the event.",
  "The red car was rolled out before the event.");
refuse("prefix truncation 2",
  "We reviewed the banner design again this morning.",
  "We reviewed the ban design again this morning.");
// "-er" and "-est" turn one real word into another often enough that they are
// not treated as inflections at all. The only thing they cost is comparative
// adjectives, which is not a correction a proofreader makes.
refuse("form -> former", "The form value is recorded in this report.",
  "The former value is recorded in this report.");
refuse("arch -> archer", "The arch was damaged during the storm yesterday.",
  "The archer was damaged during the storm yesterday.");
// bare() lowercases before comparing, so brand casing was invisible to every
// word-level check. ^[A-Z]{2,}$ catches IBM; it does not catch OpenAI.
refuse("brand casing destroyed", "We use OpenAI for this workflow today.",
  "We use Openai for this workflow today.");
// bare() lowercases, so a name losing its capital is invisible to every
// word-level check. Measured on the clean corpus for "Committee"; the same
// hole silently lowercases any ordinary name.
refuse("named body lowercased", "The Committee resolved to defer the matter.",
  "The committee resolved to defer the matter.");
refuse("person's name lowercased", "Alice reviewed the draft again this morning.",
  "alice reviewed the draft again this morning.");
refuse("place name lowercased", "The London office confirmed the numbers today.",
  "The london office confirmed the numbers today.");
refuse("product casing destroyed", "The iPhone build is ready for review.",
  "The Iphone build is ready for review.");
// content.js treats a lowercase sentence start as a real boundary, so the
// boundary guard has to see the same thing. Requiring a capital meant a
// lowercase writer's splits counted zero on both sides and were invisible.
// ONE added boundary is now a permitted correction -- splitting a run-on is
// something the model does well -- so this applies. What must not is a split
// that MOVES a boundary, or that leaves a fragment; both are asserted below.
apply("split into two lowercase sentences",
  "we shipped the fix on monday and it has been stable since.",
  "we shipped the fix on monday. it has been stable since.");
// Paying for a new boundary by deleting an old one. "Dr." loses its period, so
// a net count is unchanged and only a POSITIONAL check sees it.
refuse("boundary moved, not added",
  "Dr. Smith said the report was ready and we should send it.",
  "Dr Smith said the report was ready. And we should send it.");
refuse("split leaves a fragment",
  "Please review the report before sending it today.",
  "Please review the report. Before sending it today.");
refuse("two boundaries added",
  "one thing happened then another thing happened then a third thing",
  "One thing happened. Then another thing happened. Then a third thing.");

// collapseResegmentations matched any n:m run whose joined strings were within
// one edit, excluding only the literal 1:1 case. So a plain substitution with an
// UNCHANGED NEIGHBOUR was a 2:2 run -- "teh invoice" -> "the invoice" joins to
// "tehinvoice" -> "theinvoice" -- and collapsed whole, costing nothing. The
// change budget therefore depended on a word's neighbours rather than on the
// change: the same five corrections counted 10 when adjacent and 4 when spaced
// out, so maxChangedWords bounded four typos in one sentence and nine in the
// other. Both of these must now count the same.
// Asserted on the COUNT, not on apply/refuse. Whether ten changes clears the
// ceiling is a threshold question that moves; whether the same ten corrections
// cost the same in both sentences is the invariant, and it is what broke.
console.log("\nA substitution may not hide behind an unchanged neighbour:");
{
  const spaced = changedWordCount(
    "we recieved teh invoice yesterday and definately need to seperate the workstreams befor friday",
    "we received the invoice yesterday and definitely need to separate the workstreams before friday");
  const adjacent = changedWordCount(
    "teh recieved definately seperate befor",
    "the received definitely separate before");
  if (spaced === adjacent) {
    pass++;
  } else {
    leaks.push({ label: "changedWordCount depends on neighbours" });
    console.log(`  FAIL  five corrections cost ${adjacent} adjacent but ${spaced} when each sits beside an unchanged word`);
  }
}
// Synthetic carriers for observed resegmentation shapes. Trimming shared
// TRAILING tokens is what separates these repairs
// from the passenger case -- "Howdo you" -> "How do you" reduces to 1:2.
apply("one token becomes two", "Can the parser filtererrors from a sample file?",
  "Can the parser filter errors from a sample file?");
apply("boundary moved between two tokens", "How do wek nwo which toy train will stop?",
  "How do we know which toy train will stop?");
apply("boundary moved, shared trailing token", "Howdo you find the toy station on this map?",
  "How do you find the toy station on this map?");

// --- The 2026-08-15 resegmentation round ------------------------------------
// A structural survey damaged every word boundary in both holdouts three ways
// and asked whether the guards admit the CORRECT repair: 80.7% did. The wall
// decomposed into two defects and one policy, and these fixtures are the two
// defects. Pinned with reasonsAre, so a fixture proves the WHOLE chain stayed
// quiet rather than that the one guard being narrowed did.
console.log("\nA moved space is one correction, whichever pairing explains it:");
// collapseResegmentations searched n=1..3 then m=1..3 and took the FIRST hit.
// For a space shifted RIGHT onto a short word that is the wrong span: (1,2)
// pairs `divertingt` against `diverting to` at one edit and wins the race
// against the (2,2) that is letter-identical, leaving a dangling `o`.
reasonsAre("space shifted right onto a two-letter word",
  "Divertingt o a different route.", "Diverting to a different route.", []);
reasonsAre("space shifted right, one-letter remainder",
  "The sectioni s ready for review now.", "The section is ready for review now.", []);
// ...and the three guards that never consulted the collapse at all.
reasonsAre("moved space landing on a negation",
  "I'm notsure this model has more or less detail.",
  "I'm not sure this model has more or less detail.", []);
reasonsAre("moved space landing on a meaning word",
  "I'm not sure I've everseen so much detail.",
  "I'm not sure I've ever seen so much detail.", []);
// The gained `more` pairs with a LATER `more` in the sentence, so every content
// word between them read as reordered.
reasonsAre("moved space desynchronising the content sequence",
  "Sometimes it's mor elike the toy railway is fixed and there are more bridges between the stations.",
  "Sometimes it's more like the toy railway is fixed and there are more bridges between the stations.", []);

console.log("\n...but the collapse licenses the space move, never the meaning change riding on it:");
// These three are the whole reason the meaning guards run on the EXACT collapse
// (letter-identical runs) rather than the one-edit collapse the word guards use.
reasonsAre("space fixed AND a negation invented",
  "I'm notsure it works well.", "I'm not sure it doesn't work well.", ["negation-changed"]);
// `notsure` -> `no sure` joins at ONE edit, which the word guards forgive and
// the meaning guards must not: it is a negation the model made up.
reasonsAre("one-edit resegmentation carrying a negation",
  "I'm notsure about the plan.", "I'm no sure about the plan.", ["negation-changed"]);
reasonsAre("space fixed AND a meaning word swapped",
  "we shipped it to allof the sites and it worked.",
  "we shipped it to most of the sites and it worked.",
  ["meaning-word-changed", "word-substituted:allof"]);
reasonsAre("...and the same sentence repaired honestly applies",
  "we shipped it to allof the sites and it worked.",
  "we shipped it to all of the sites and it worked.", []);
reasonsAre("space fixed AND the content genuinely reordered",
  "the reportcovers budget and timeline for the client.",
  "the report covers timeline and budget for the client.", ["content-reordered"]);
reasonsAre("...and the same sentence repaired honestly applies",
  "the reportcovers budget and timeline for the client.",
  "the report covers budget and timeline for the client.", []);
// The trailing trim was written for the 1:1-with-passengers rule and the
// non-word condition kept reading the UNTRIMMED run, so a shared trailing token
// could supply the non-word by itself: `no wand i've` -> `now and i've` is
// letter-identical and `i've` is not in the dictionary, so two ordinary words
// were resegmented into two other ordinary words on a passenger's evidence.
// That is "the rapist" -> "therapist" with a chaperone.
reasonsAre("a passenger may not supply the non-word",
  "I'm painting the toy signal right no wand I've finished the base.",
  "I'm painting the toy signal right now and I've finished the base.",
  ["negation-changed", "word-substituted:no"]);
// The policy itself, unchanged and deliberately: both fragments are ordinary
// words, so nothing here says the model is correcting a typo.
reasonsAre("both fragments are real words -- still refused",
  "I met the rapist at the clinic that day.", "I met therapist at the clinic that day.",
  ["word-substituted:rapist"]);

console.log("\nA meaning-word near miss with two equally near readings is refused BOTH ways:");
// meaningKey returned the FIRST match in MEANING's iteration order, and `must`
// is written before `most` -- so `moust` canonicalized to `must`, and the wrong
// one of the two corrections was the one that applied.
reasonsAre("moust -> must (was applied, on a Set's insertion order)",
  "we lost moust of the budget this quarter.", "we lost must of the budget this quarter.",
  ["meaning-word-changed"]);
reasonsAre("moust -> most (equally near, equally refused)",
  "we lost moust of the budget this quarter.", "we lost most of the budget this quarter.",
  ["meaning-word-changed"]);
// The unambiguous near misses this canonicalization exists for are untouched.
reasonsAre("shoud -> should still applies",
  "we shoud ship it today.", "we should ship it today.", []);

console.log("\nRunaway output:");
// Measured: the model returned its own few-shot demonstrations as a "correction".
// At 92 chars for a 70-char input it passes background.js's max(50, len*2) cap.
refuse("few-shot recitation", "Its a bit long and we could cut the second paragraph.", "The report was long and detailed. Turnout improved after we moved the workshop to Thursday.");
apply("split into two sentences", "We shipped the fix on Monday and it has been stable since.", "We shipped the fix on Monday. It has been stable since.");
refuse("truncated to a fragment", "The revenue projection on slide 11 uses the old churn assumption.", "The revenue projection.");
refuse("ballooned", "Either option works for me.", "Either option works for me, and I am happy to go with whichever you prefer.");

console.log("\nSanitiser must not launder the output:");
// On the manual path a sanitiser repairs a result the user is about to LOOK at.
// Here nobody looks, so a result that needs sanitising is evidence the model
// misbehaved -- refuse rather than silently clean it up.
refuse("markdown added", "I ran npm run build and it failed.", "I ran `npm run build` and it failed.");
refuse("identifier mangled", "The __init__ method takes three arguments.", "The init method takes three arguments.");
refuse("code expression mangled", "The answer is 2*3*4 in that case.", "The answer is 234 in that case.");
refuse("url changed", "See https://example.com/docs/setup.html for detail.", "See https://example.com/docs/setup for detail.");

// --- Real corrections that MUST get through ---------------------------------
console.log("\nGenuine corrections must still apply:");
apply("misspelling", "We recieved the invoice yesterday.", "We received the invoice yesterday.");
apply("misspelling 2", "The techncian replaced the broken sensor.", "The technician replaced the broken sensor.");
apply("misspelling 3", "The migration definately needs a rollback plan.", "The migration definitely needs a rollback plan.");
apply("misspelling 4", "We need to seperate the two workstreams.", "We need to separate the two workstreams.");
apply("misspelling 5", "Please reveiw the attached before Friday.", "Please review the attached before Friday.");
apply("misspelling 6", "I have alredy sent the summary to legal.", "I have already sent the summary to legal.");
apply("wrong word, same stem", "He asked me weather the deadline had moved.", "He asked me whether the deadline had moved.");
// They are NOT structurally identical, which an earlier version of this
// comment claimed. A dropped first letter is a pure PREFIX INSERTION -- the
// whole original survives as a suffix of the candidate, and "know" ends with
// "now". A first-letter swap is a substitution, and "sent" does not end with
// "went". Separating the two needs no dictionary, only that distinction.
//
// A recorded correction was refused on "wim" -> "swim" before this change.
// The synthetic carriers below pin the prefix-insertion distinction. The
// historical replay left BAD-APPLY unchanged at 7/847 (0.8%).
apply("dropped first letter", "Let me now if you need anything else.", "Let me know if you need anything else.");
apply("dropped first letter 2", "The dolphins also wim in the water.", "The dolphins also swim in the water.");
// The substitution case it was conflated with must still refuse.
refuse("first letter SWAPPED, not dropped", "The invoice went to the wrong team.", "The invoice sent to the wrong team.");
refuse("two letters prepended is not a typo", "We reviewed the port this morning.", "We reviewed the support this morning.");
apply("inflection", "The __init__ method take three arguments.", "The __init__ method takes three arguments.");
apply("subject-verb agreement", "The results was better than we expected.", "The results were better than we expected.");
apply("doubled word", "I will send you the the updated file.", "I will send you the updated file.");
// 2026-08-26: adjacent-duplicate CONTENT-word deletion is excused in
// substitutedContentWords (a doubled content word was refused as
// word-substituted for as long as the guard existed — 379 of 579
// exactly-correct injected repairs in the Phase 1.5 round, 7 of the pilot's
// 13 benchmark doubled-word misses guard-unreachable). The excuse is
// positional, keeps-a-copy, lowercase-exact, and REDUPLICATION_WORDS never
// qualify. Each refuse fixture below pins one of those edges.
apply("doubled content word", "I know know the answer.", "I know the answer.");
apply("doubled content word + typo fix in one edit", "I know know teh answer.", "I know the answer.");
apply("tripled content word", "I know know know the answer.", "I know the answer.");
refuse("reduplication is intensity, not a typo", "It is very very good.", "It is very good.");
refuse("reduplication 2", "That was really really fast.", "That was really fast.");
refuse("capitalized double is a name shape", "Duran Duran played the show.", "Duran played the show.");
refuse("plain deletion with no adjacent double", "I know the answer.", "I the answer.");
refuse("deleted copy was not the adjacent one", "I know about the know answer.", "I about the know answer.");
apply("missing article", "She left note on my desk this morning.", "She left a note on my desk this morning.");
apply("pronoun case", "Marcus and me reviewed it together last night.", "Marcus and I reviewed it together last night.");
apply("should of", "We should of caught that in review.", "We should have caught that in review.");
apply("contraction added", "Its a bit long and we could cut it.", "It's a bit long and we could cut it.");
apply("apostrophe added", "I dont have context on that thread.", "I don't have context on that thread.");
apply("function word repaired", "He dont think the timeline is realistic.", "He doesn't think the timeline is realistic.");
apply("possessive added", "The clients feedback arrived late again.", "The client's feedback arrived late again.");
apply("their -> there", "Their are three open questions left.", "There are three open questions left.");
apply("fix next to an identifier", "I ran npm run build and it fail on the linter step.", "I ran npm run build and it failed on the linter step.");
apply("fix next to a number", "Our p95 went from 340ms to 210ms after the changes was made.", "Our p95 went from 340ms to 210ms after the changes were made.");
apply("no change at all", "The board meeting starts at nine on Thursday.", "The board meeting starts at nine on Thursday.");
// The inflection rule must not have cost these.
apply("doubled-consonant inflection", "We stop the rollout after the third failure.", "We stopped the rollout after the third failure.");
apply("short stem still takes a plain suffix", "He run the migration every Tuesday.", "He runs the migration every Tuesday.");
apply("plural added", "The client asked for two more seat on the plan.", "The client asked for two more seats on the plan.");
apply("capitalisation added", "we shipped it on monday morning.", "We shipped it on Monday morning.");

// --- 2026-08-10 guard-headroom audit + gpt-5.6 review -----------------------
// Recovered corrections. Each of these was a CORRECT model output the guards
// refused, measured on the live path (test/results/guard-headroom-report.txt).
console.log("\nRecovered by the 2026-08-10 audit (correct fixes, previously refused):");
apply("whose -> who's", "Whose going to run the retro this week?", "Who's going to run the retro this week?");
apply("typo'd contraction doen't", "I wonder if taht timing doen't work for them.", "I wonder if that timing doesn't work for them.");
apply("typo'd contraction dno't", "That is the prat I dno't follow at all.", "That is the part I don't follow at all.");
apply("shift stutter on a weekday", "We shpiped the fix on MOnday as planned.", "We shipped the fix on Monday as planned.");
apply("shift stutter on given", "GIven how long this has dragged on, let's decide.", "Given how long this has dragged on, let's decide.");

// Shift stutter beyond the closed list (2026-08-12). STUTTER_WORDS could not
// grow to cover ordinary vocabulary, and one unlisted stutter refuses the whole
// sentence as `protected-token`, taking every real typo beside it down too.
// The synthetic sample combines a misspelling with several held-shift tokens,
// including ordinary words that a short hand-maintained list would omit.
console.log("\nShift stutter, dictionary-backed (2026-08-12):");
apply("a synthetic sentence with multiple stutters",
  "ERors LIke THis ARe COmmon WHen THe SMall RObot TYpes.",
  "Errors like this are common when the small robot types.");
apply("common noun off the closed list", "We went to the LAke early yesterday morning.",
  "We went to the lake early yesterday morning.");
apply("stutter through a typo'd word", "ERors like this are common ones.",
  "Errors like this are common ones.");
apply("mid-sentence stutter may lose BOTH capitals", "I think THis is fine for now.",
  "I think this is fine for now.");
// A held shift produces two capitals, so unstuttering to "Like" leaves one the
// user never meant and the correct mid-sentence fix reads as capital-removed.
// Calendar names are the exception -- capitalised by rule, so still protected.
refuse("a weekday may not be lowercased", "We shipped the fix on MOnday as planned.",
  "We shipped the fix on monday as planned.");
refuse("two-letter initialism glued to a word is not a stutter",
  "The USbased team ships on Friday afternoon.",
  "The Usbased team ships on Friday afternoon.");
refuse("nor is an initialism whose tail is a whole word",
  "The AIsafety group meets on Thursday morning.",
  "The Aisafety group meets on Thursday morning.");

// The hazards those recoveries must NOT have bought. The first is the measured
// wrong-apply the dictionary-based stutter variant admitted in the 2026-08-10
// audit, and it is now refused by its own guard rather than by "REfer" being
// protected as a side effect: capitalising a token that is a NON-word one edit
// from a real one is the model dressing up a typo instead of fixing it.
console.log("\nHazards the recoveries must not admit:");
refuse("stutter relaxation must not license a new capital",
  "REfer to Fig. 3 for the brekadown by semgent.",
  "Refer to Fig. 3 for the breakdown by Semgent.");
// A capital added to a proper noun with no dictionary neighbour is the fix a
// proofreader should make, and refusing it also loses any typo beside it.
apply("...but a real proper noun may still be capitalised",
  "we should meet in london next wek.", "We should meet in London next week.");
// FLIPPED 2026-08-12, deliberately. This was `refuse`, on the grounds that
// dictionary membership makes protection depend on whether a surname collides
// with a common noun ("SMith" relaxed, "MArcus" protected). The asymmetry is
// real and is now accepted: the arbitrariness is in WHICH surnames relax, not
// in what happens when one does. Every output that damages a relaxed
// surname-shaped stutter is still refused by substitutedContentWords --
// "SMith" -> "Smyth", "Smithe" and "Jones" all come back
// `word-substituted:smith` -- so what relaxing admits is the correct rendering
// of the name and nothing else. Refusing this sentence also cost `inovice`,
// `wnet` and `mitsake`, which is the trade the owner asked to stop making.
apply("surname-shaped stutter, correctly rendered",
  "The inovice wnet to SMith & Co. by mitsake.",
  "The invoice went to Smith & Co. by mistake.");
refuse("...but a relaxed surname may not become a different name",
  "The inovice wnet to SMith & Co. by mitsake.",
  "The invoice went to Jones & Co. by mistake.");
// Negation-MOVEMENT leaks (gpt-5.6): a misspelled contraction in one clause
// must not pay for a negation added in another. Bag-of-words matching let the
// first of these through; the excuse is now positional.
refuse("moved negation: typo'd contraction pays for don't elsewhere",
  "I do agree that the label doen't fit.",
  "I don't agree that the label does fit.");
apply("same sentence, fixed in place",
  "I do agree that the label doen't fit.",
  "I do agree that the label doesn't fit.");
refuse("negation added with no typo to excuse it",
  "I do agree that the label fits well.",
  "I don't agree that the label fits well.");
refuse("moved negation: dno't pays for can't at the front",
  "I can ship once the label dno't fit.",
  "I can't ship once the label does fit.");
// The contraction respelling must not weaken the original rule: a REAL word
// gaining a negation is still a meaning flip.
refuse("can -> can't still refused", "We can ship it on Friday afternoon.", "We can't ship it on Friday afternoon.");

// Hyphenating a compound is punctuation moved, not a word changed (owner's
// call, 2026-08-10: qwen lost 12 real compounds to word-substituted on the
// harvested Discord corpus). Letter-identity plus a required hyphen is the
// whole mechanism; the run-together hazard has no hyphen and stays refused.
console.log("\nCompound hyphenation:");
apply("compound hyphenated", "The pre pandemic model uses a wooden bridge.", "The pre-pandemic model uses a wooden bridge.");
apply("compound hyphenated mid-sentence", "The toy shop sells small scale models today.", "The toy shop sells small-scale models today.");
refuse("letter-identical join WITHOUT a hyphen stays refused", "We saw the rapist leave the building early.", "We saw therapist leave the building early.");
refuse("un-hyphenating the user's compound stays refused", "The pre-pandemic model uses a wooden bridge.", "The pre pandemic model uses a wooden bridge.");

// Terminators compare by CLASS: "." / "..." / absent are all statements, so a
// correction no longer dies because trailing punctuation style rode along.
// "?" and "!" still bind in both directions.
console.log("\nTerminator class:");
apply("fix survives a dropped final period", "I don;t think someoen should have to ask twice.", "I don't think someone should have to ask twice");
apply("ellipsis tightened to a period alongside a fix", "The shrubs looked undernourshed in the sketch...", "The shrubs looked undernourished in the sketch.");
refuse("statement must not become a question", "We are shipping the new build today.", "We are shipping the new build today?");
// ...unless the sentence is interrogative-SHAPED, where there is no statement
// reading to protect. These invented questions preserve both boundary shapes.
apply("aux-opener question gets its mark", "But does the toy battery lose 1% or 10% before the lamp goes dark.", "But does the toy battery lose 1% or 10% before the lamp goes dark?");
apply("tag question gets its mark", "These model trains have quite a speed gap don't they.", "These model trains have quite a speed gap, don't they?");
refuse("imperative Do stays a statement", "Do the dishes before you leave tonight.", "Do the dishes before you leave tonight?");
refuse("exclamative What stays a statement", "What a mess this turned out to be.", "What a mess this turned out to be?");
refuse("embedded question stays a statement", "I wonder if the new build works.", "I wonder if the new build works?");

// Synthetic carriers for permitted recoveries: a possessive apostrophe is
// not part of a protected identifier, and "kefir"/"bizarro" are real words the
// list was missing. The reverse apostrophe edit stays refused via
// contraction-expanded (the count may only rise).
console.log("\nPossessive apostrophes and dictionary gaps:");
apply("acronym gains its possessive", "The diagram labels the ICs pins in blue.", "The diagram labels the IC's pins in blue.");
refuse("stripping the user's possessive stays refused", "The diagram labels the IC's pins in blue.", "The diagram labels the ICs pins in blue.");
apply("keifer -> kefir", "Label the bottle of keifer in the drawing.", "Label the bottle of kefir in the drawing.");
apply("Bizzaro -> Bizarro", "The sample uses Bizzaro as its placeholder name.", "The sample uses Bizarro as its placeholder name.");
refuse("question must not become a statement", "Are we shipping the new build today?", "Are we shipping the new build today.");
refuse("exclamation must not be flattened", "That demo went really well!", "That demo went really well.");

// A comma after a sentence-initial "No"/"Not" re-parses the sentence: the
// determiner reading ("there is no session on the 31st") becomes an
// interjection plus an assertion ("no -- and it is on the 31st"). The letter
// stream is identical, so every other guard here is blind to it. The synthetic
// date-and-event fragment below preserves that polarity hazard.
console.log("\nPolarity scope (a comma is not always punctuation):");
refuse("comma after No inverts a determiner", "No July 14th, puppet show.", "No, July 14th, puppet show.");
apply("comma before a finite clause is a real fix", "No I dont think so.", "No, I don't think so.");
apply("ordinary comma insertion elsewhere", "Reading a small chart I think the train uses 4% less power.", "Reading a small chart, I think the train uses 4% less power.");
// "no" and "not" are the only openers with a determiner reading to destroy.
// This one fails loudly if the opener list is ever widened to the interjections
// (yeah, ok, nah, sure), whose comma insertions the owner blessed as cosmetic.
// The invented carrier exercises an interjection followed by a full clause.
apply("a non-negation opener still takes its comma", "Nah the green carriage is stored here.", "Nah, the green carriage is stored here.");

// --------------------------------------------------------------------------
// data/confusables-en.txt: 419 directed pairs generated from LanguageTool's
// published confusion sets by test/build-confusables.mjs.
//
// THE ARTIFACT MUST BE THE ONE THE BUILDER PRODUCES. Loading the checked-in
// file and testing that proves nothing about the filter -- a changed builder
// with a stale artifact left all 128 of these green. So rebuild in-process from
// the vendored inputs and compare.
console.log("\nGenerated confusables -- artifact freshness:");
{
  const R = build({
    confusion: readFileSync(new URL("./data/confusion_sets.txt", import.meta.url), "utf8"),
    cmudict: readFileSync(new URL("./data/cmudict-subset.txt", import.meta.url), "utf8"),
    words: readFileSync(new URL("../data/words-en.txt", import.meta.url), "utf8"),
  });
  const onDisk = readFileSync(new URL("../data/confusables-en.txt", import.meta.url), "utf8");
  // The artifact is an INPUT to render(), exactly as it is for the CLI: the
  // LGPL date-of-change line is the day the PAIRS last changed, so a build that
  // emits identical pairs must reproduce the existing date rather than today's.
  // Omitting it made this assertion fail on every day but the one the artifact
  // was generated -- a red suite that says "run build-confusables.mjs" over a
  // build that would change nothing but the date it just failed on.
  ok("data/confusables-en.txt matches a fresh build from test/data/",
    render(R.pairs, onDisk) === onDisk, "run: node build-confusables.mjs");
  ok("background.js CONFUSABLES_COUNT matches the build",
    CONFUSABLES_COUNT === R.pairs.length, `const says ${CONFUSABLES_COUNT}, build has ${R.pairs.length}`);
  ok("background.js CONFUSABLES_SHA256 matches the build",
    CONFUSABLES_SHA256 === payloadDigest(R.pairs), `const says ${CONFUSABLES_SHA256}`);
}

// THE LOADER MUST FAIL CLOSED. Missing words disable dictionary membership
// vetoes and dictionary-dependent checks (and some dictionary-backed permissions).
// Confusables and names GRANT licences, so invalid generated data must leave only
// their hand supplements. A gpt-5.6 audit demonstrated it end to
// end -- a mocked non-OK response whose body contained "salt|slat" made
// isRespelling("salt","slat") return true and the guard return APPLY, which is
// the substitution the dictionary rule was written to refuse.
//
// These drive the SHIPPING fetchConfusables() with a substituted fetch, so they
// test the real res.ok / shape / count / digest checks rather than a mirror.
console.log("\nGenerated confusables -- the loader fails closed:");
{
  const good = await fetchConfusables(diskFetch());
  // Not `instanceof Set`: background.js is evaluated in a vm realm, so its Set
  // is a different constructor and instanceof is false for a perfectly good Set.
  ok("a good file loads", !!good && good.size === CONFUSABLES_COUNT,
    `got ${good === null ? "null" : `size ${good && good.size}`}, want ${CONFUSABLES_COUNT}`);

  const POISON = "# comment\n" + "salt|slat\n".repeat(CONFUSABLES_COUNT);
  const body = (text, extra = {}) => ({ ok: true, status: 200, text: async () => text, ...extra });

  const cases = [
    ["HTTP 404 whose body is a valid-looking list",
      { "confusables-en.txt": { ok: false, status: 404, text: async () => POISON } }],
    ["HTTP 200 with a poisoned body of the right length",
      { "confusables-en.txt": body(POISON) }],
    ["a body with one line appended",
      { "confusables-en.txt": body(readFileSync(new URL("../data/confusables-en.txt", import.meta.url), "utf8") + "salt|slat\n") }],
    ["a body with one pair swapped (count intact, digest wrong)",
      { "confusables-en.txt": body(readFileSync(new URL("../data/confusables-en.txt", import.meta.url), "utf8").replace("peace|piece", "salt|slat")) }],
    ["a body of the right length in the wrong format",
      { "confusables-en.txt": body("# x\n" + "salt slat -> yes\n".repeat(CONFUSABLES_COUNT)) }],
    ["a fetch that throws",
      { "confusables-en.txt": null }],
  ];
  for (const [label, override] of cases) {
    const impl = override["confusables-en.txt"] === null
      ? async () => { throw new Error("network"); }
      : diskFetch(override);
    const got = await fetchConfusables(impl);
    ok(`publishes null: ${label}`, got === null, `got ${got && `a Set of ${got.size}`}`);
  }

  // And the consequence, end to end: with a poisoned load the guard must still
  // refuse. Anything else means the loader's return value is not what gates it.
  setConfusables(await fetchConfusables(diskFetch({ "confusables-en.txt": body(POISON) })));
  refuse("a poisoned confusables file cannot grant salt -> slat",
    "Pass the salt please, it needs more.", "Pass the slat please, it needs more.");
  // Restore the state this suite STARTED in, not unconditionally the good list:
  // PROOFER_NO_CONFUSABLES=1 is the negative control that proves these cases
  // test the generated allowlist and not something else, and a blanket restore
  // here quietly repaired it -- the control passed 143/143 and proved nothing.
  const control = !!process.env.PROOFER_NO_CONFUSABLES;
  setConfusables(control ? null : good);
  ok(`the starting state is restored for the rest of the suite (${control ? "control" : "shipping"})`,
    (guardSentenceResult("Can I have a peace of cake now?", "Can I have a piece of cake now?",
      "Can I have a piece of cake now?") === null) === !control);
}

// DIRECTION. A pair is a one-way licence. LanguageTool measures each direction
// separately and they are not equal: "fair" -> "fare" is p=1.000 and
// "fare" -> "fair" is p=0.979, so only the first is shipped. Both of these
// isolate the allowlist specifically -- "fair" and "fare" are both ordinary
// words, so nothing else in the guard stack can explain either verdict.
console.log("\nGenerated confusables -- direction and precision:");
apply("licensed direction: fair -> fare (p=1.000)",
  "I paid the fair on the bus again.", "I paid the fare on the bus again.");
refuse("reverse direction is NOT licensed: fare -> fair (p=0.979)",
  "It was not a fare price for that.", "It was not a fair price for that.");
apply("licensed direction: taught -> taut (p=1.000)",
  "The rope was taught across the deck.", "The rope was taut across the deck.");
refuse("reverse is disabled in LanguageTool itself: taut -> taught (p=0.981)",
  "She taut the class about it.", "She taught the class about it.");

// PRECISION. A homophone below the floor stays refused, so lowering the floor
// is a visible change rather than a silent one.
refuse("homophone below the precision floor: bare -> bear (p=0.994)",
  "I can not bare the noise any more.", "I can not bear the noise any more.");

// AND THE HALF THAT PRECISION CANNOT BUY. LanguageTool's p is the precision of
// an n-gram classifier choosing between the two words IN CONTEXT; a pair here
// is an unconditional licence, with no classifier behind it. So a high p on a
// pair that is not a homophone means nothing to us -- these are the
// "salt" -> "slat" family, and every one of them clears the precision floor
// comfortably. If the homophone requirement is ever dropped, these apply.
refuse("high precision, not a homophone: bad -> bed (p=0.999)",
  "It was a bad day for the whole team.", "It was a bed day for the whole team.");
refuse("high precision, not a homophone: caller -> collar (p=1.000)",
  "I left the caller on the table again.", "I left the collar on the table again.");
refuse("high precision, not a homophone: and -> end (p=0.998)",
  "We shipped it and moved on.", "We shipped it end moved on.");

// HOMOPHONY HAS TO BE UNCONDITIONAL. The first cut of the filter stripped
// CMUdict's stress digits and accepted an intersection of ANY pronunciation
// variants; the same audit produced all three of these as APPLY. They are now
// rejected because the CANONICAL pronunciations differ -- by stress for the
// first, and because the only agreement was through a `(2)` variant for the
// other two. A word that sounds the same in only one of its readings is a word
// the guard cannot place, since it has no idea which reading was meant.
console.log("\nGenerated confusables -- audible non-homophones (2026-08-14 audit):");
refuse("stress reversed: incites -> insights (IH2 N S AY1 vs IH1 N S AY2)",
  "The speech incites anger among the crowd.", "The speech insights anger among the crowd.");
refuse("matches only via devise(2), a secondary /S/ reading",
  "We need to devise a better plan for this.", "We need to device a better plan for this.");
refuse("matches only via close(2)/clothes(2)",
  "That was a close call for the whole team.", "That was a clothes call for the whole team.");
// The fourth of the four, and the only one that was NOT the generated filter's
// doing: "desert|dessert" was hand-picked, and both directions were removed on
// 2026-08-14 because of this exact sentence. The noun is D EH1 Z ER0 T against
// dessert's D IH0 Z ER1 T -- the pair only ever fitted the VERB reading, and an
// unconditional licence cannot tell the readings apart. Kept as a regression
// case so restoring the entry is a deliberate act with a failing test attached.
refuse("hand-picked desert|dessert, removed: the noun is not a homophone",
  "The Sahara desert is extremely hot there.", "The Sahara dessert is extremely hot there.");

// The ordinary job the list exists for. "peace"/"piece" and "brake"/"break"
// are both real words either way, so only the allowlist can explain an APPLY.
console.log("\nGenerated confusables -- the ordinary job:");
apply("peace -> piece", "Can I have a peace of cake now?", "Can I have a piece of cake now?");
apply("brake -> break", "I need to take a brake before the call.", "I need to take a break before the call.");
apply("waist -> waste", "That was a total waist of an afternoon.", "That was a total waste of an afternoon.");
// The hand-picked half is unconditional and must survive the generated one
// being absent or failing to load.
apply("hand-picked pair, not derivable by any rule: buy -> but",
  "The blue train is here buy the red train is elsewhere.", "The blue train is here but the red train is elsewhere.");

// --- The 2026-08-15 narrowing round -----------------------------------------
//
// Four guards were refusing a class of edit their own rationale never claimed,
// measured by replaying 1282 recorded real sentences: 145 refusals, of which 12
// were recovered here with no other verdict moving anywhere. Each shape below is
// pinned in BOTH directions -- the recovered edit as an apply, the hazard the
// guard exists for as a refuse with its full reason list -- because a narrowing
// asserted only on what it now admits is a measurement of half the change.
//
// Every REFUSE case here was verified to refuse on the PRE-change revision too,
// and every APPLY case to have been refused by it. A fixture that passed before
// the change proves nothing about the change.

console.log("\ncapital-added-to-non-word: a possessive and a plural are not typos (2026-08-15):");
// bare() keeps the apostrophe, so "mother's" and "it's" are non-words that sit
// one edit from a real word -- the guard read a capitalised possessive as the
// model dressing up a misspelling. 3 of the 4 refusals on real traffic.
reasonsAre("possessive capitalised", "The model shop has a mother's day display.",
  "The model shop has a Mother's Day display.", []);
reasonsAre("contraction capitalised at a sentence start",
  "Oh. it's beside the small model bridge.",
  "Oh. It's beside the small model bridge.", []);
// The plural of a word the dictionary does not hold is not a misspelling of
// one: "jews" is one edit from "news" and "jewel", and its singular "jew" is
// absent too, which is what a proper noun a common-noun list cannot hold looks
// like. The invented carrier preserves the same plural-casing shape.
reasonsAre("plural of an unknown word", "The spelling exercise asks for the plural jews.",
  "The spelling exercise asks for the plural Jews.", []);
// ...and the two hazards this guard was BUILT for, both from the 2026-08-10
// audit. Neither has a plural reading, so neither is reached by the exemption.
reasonsAre("typo dressed up with a capital", "Refer to the brekadown by semgent please.",
  "Refer to the brekadown by Semgent please.", ["capital-added-to-non-word"]);
reasonsAre("...and the other one", "i asked the guide about the sedule.",
  "i asked the guide about the Sedule.", ["capital-added-to-non-word"]);

console.log("\ncontraction-expanded: a moved apostrophe is not an expansion (2026-08-15):");
// The count was a tripwire standing in for the question. 5 of 8 refusals on
// real traffic were a possessive being re-punctuated; none was an expansion.
reasonsAre("possessive moved across the s", "The worker's labels sit beside the toy tracks.",
  "The workers' labels sit beside the toy tracks.", []);
reasonsAre("possessive dropped from a plural", "Lot's of toy trains fit inside this box.",
  "Lots of toy trains fit inside this box.", []);
// Rule 2, the expansion the guard is named for.
reasonsAre("It's -> It is", "It's worth doing properly this time.",
  "It is worth doing properly this time.", ["contraction-expanded"]);
reasonsAre("They've -> They have", "They've asked for a summary of it.",
  "They have asked for a summary of it.", ["contraction-expanded"]);
reasonsAre("Let's -> Let us", "Let's go over the numbers again tomorrow.",
  "Let us go over the numbers again tomorrow.", ["contraction-expanded"]);
// Rule 4: the surviving token has to be a real word. This is the pinned case
// protectedMultiset's apostrophe folding was written against.
reasonsAre("IC's -> ICs stays refused", "The IC's were delivered to the lab today.",
  "The ICs were delivered to the lab today.", ["contraction-expanded"]);
// Rule 5, and it is load-bearing rather than belt-and-braces: "dont", "cant",
// "wont", "ill", "were" and "hes" are all dictionary words, so rule 4 alone
// would let the apostrophe be stripped off half the contractions in English.
reasonsAre("don't -> dont stays refused", "I don't think the timeline is realistic.",
  "I dont think the timeline is realistic.", ["contraction-expanded"]);
// T1 and T2 were refused here by the 2026-08-15 narrowing round and are BLESSED
// by the owner on the same day, with the chip/offer route rejected permanently
// -- so the choice was apply or discard, and these two apply. The assertions
// below were REFUSE fixtures and were flipped deliberately; that is what
// "approving them later means deleting an assertion deliberately" looks like.
reasonsAre("who's -> whose applies (T1, owner-blessed 2026-08-15)",
  "The toy builder who's label is blue will lead.",
  "The toy builder whose label is blue will lead.", []);
reasonsAre("it's -> its applies (T2, owner-blessed 2026-08-15)",
  "The shed was painted by it's current owner.",
  "The shed was painted by its current owner.", []);
// A longer synthetic carrier checks the same replacement in a relative clause.
reasonsAre("it's -> its in a longer synthetic carrier",
  "Painting the model shed is a simple task when the colour was chosen by it's current owner.",
  "Painting the model shed is a simple task when the colour was chosen by its current owner.", []);
// THE EDGES OF THE CARVE-OUT. It is two directed pairs, not a rule, and these
// are the four ways a rule would have been wider than the evidence.
//
// (a) The pairs it must NOT open, and the reason a licence gate alone would
//     have: "they're|their" and "you're|your" are already in the hand list in
//     BOTH directions, so `isConfusable` says yes to each of these.
reasonsAre("they're -> their stays refused, though the pair is licensed",
  "I think they're coming to the party later.",
  "I think their coming to the party later.", ["contraction-expanded"]);
reasonsAre("you're -> your stays refused, though the pair is licensed",
  "I think you're car is parked outside now.",
  "I think your car is parked outside now.", ["contraction-expanded"]);
// (b) A blessed replacement does not buy an ordinary expansion sitting beside
//     it. The carve-out is per lost contraction, and every one has to clear.
reasonsAre("who's -> whose plus They've -> They have is still refused",
  "I have a model who's label is blue and they've painted it.",
  "I have a model whose label is blue and they have painted it.", ["contraction-expanded"]);
reasonsAre("it's -> its plus don't -> dont is still refused",
  "It's fine but I don't think it's type matters.",
  "It's fine but I dont think its type matters.", ["contraction-expanded"]);
// (c) The blessed pair is the WHOLE key. "who's" losing its apostrophe is not
//     "who's" -> "whose", and "it's" losing its "s" is not "it's" -> "its".
reasonsAre("who's -> whos is not the blessed replacement",
  "I know who's coming to the party tonight.",
  "I know whos coming to the party tonight.", ["contraction-expanded"]);
reasonsAre("it's -> it is not the blessed replacement",
  "I think it's going to be fine today.",
  "I think it going to be fine today.", ["contraction-expanded"]);
// (d) The reverse directions were already free and must stay free: adding a
//     contraction raises contractionCount, so rule 1 returns before any of this.
reasonsAre("its -> it's still applies", "I think its going to rain later today.",
  "I think it's going to rain later today.", []);
// ...and the set itself, so a wider one is a failing assertion rather than a
// silently wider carve-out.
ok(`BLESSED_CONTRACTION_REPLACEMENTS is exactly the two owner-blessed pairs `
  + `(found ${JSON.stringify([...BLESSED_CONTRACTION_REPLACEMENTS].sort())})`,
  JSON.stringify([...BLESSED_CONTRACTION_REPLACEMENTS].sort())
    === JSON.stringify(["it's|its", "who's|whose"]));
ok("...and each one is REQUIRED to hold a confusable licence as well",
  [...BLESSED_CONTRACTION_REPLACEMENTS].every((p) => {
    const [w, c] = p.split("|");
    return isBlessedContractionReplacement(w, c) && isConfusable(w, c);
  }));
ok("...while the licensed-but-unblessed pronoun pairs are refused by the set",
  !isBlessedContractionReplacement("they're", "their")
  && !isBlessedContractionReplacement("you're", "your")
  && isConfusable("they're", "their") && isConfusable("you're", "your"));

console.log("\nreasonably -> reasonable: a hand CONFUSABLE, owner-blessed 2026-08-15:");
// 3/3 correct on the four recordings. Not a homophone -- same family as
// "than|then" and "buy|but", a real word one suffix away from another, which
// is exactly what the dictionary rule refuses by design.
reasonsAre("a synthetic sentence-final correction", "At the current size the model station seems directionally reasonably.",
  "At the current size the model station seems directionally reasonable.", []);
reasonsAre("...and its twin, with the comma the model also adds",
  "Honestly the model layout seems directionally reasonably beside the toy bridge.",
  "Honestly, the model layout seems directionally reasonable beside the toy bridge.", []);
reasonsAre("mid-sentence", "That seems reasonably safe to me honestly.",
  "That seems reasonable safe to me honestly.", []);
// DIRECTED, and this is the direction that stays shut: turning a correct
// adjective into an adverb is the damage the pair would otherwise buy.
reasonsAre("reasonable -> reasonably is NOT licensed",
  "That seems reasonable safe to me honestly.",
  "That seems reasonably safe to me honestly.", ["word-substituted:reasonable"]);
reasonsAre("...nor in a sentence where the adjective is right",
  "The price seems reasonable to me right now.",
  "The price seems reasonably to me right now.", ["word-substituted:reasonable"]);

console.log("\nterminator-changed: a stray period deleted after a closer (2026-08-15):");
// terminator() strips the closers to READ the terminator, which also throws
// away the evidence that nothing about it changed: "?)." and "?)" differ only
// by a deletion, and the strip leaves "." against "?". Both shapes are reproduced
// with invented carrier text below.
reasonsAre("stray period after ?)", "That is a small model shed (isn't this the blue one?).",
  "That is a small model shed (isn't this the blue one?)", []);
reasonsAre("stray period after ?'", "The toy guide asks 'where is the blue bridge?'.",
  "The toy guide asks 'where is the blue bridge?'", []);
// Same class AND deletion-only. Every class change still refuses...
reasonsAre("? -> . refused", "Are we still on for today?",
  "Are we still on for today.", ["terminator-changed"]);
reasonsAre("! -> . refused", "That went really well!",
  "That went really well.", ["terminator-changed"]);
reasonsAre(". -> ? refused", "The migration finished today.",
  "The migration finished today?", ["terminator-changed"]);
reasonsAre(". -> ! inside closers refused", "He said it was \"completely fine.\"",
  "He said it was \"completely fine!\"", ["terminator-changed"]);
// ...and an emptied run classes as "" rather than ".", which is what keeps a
// URL's own "?" deleted with nothing left behind outside the exemption.
reasonsAre("a URL's trailing ? deleted", "See https://example.com/a/b?",
  "See https://example.com/a/b", ["terminator-changed"]);
// The pre-existing "." / "..." / absent tolerance is untouched.
reasonsAre("a final period dropped, class unchanged",
  "The pipeline works fine now, it realy does.",
  "The pipeline works fine now, it really does", []);

console.log("\nprotected-token: PRESENCE, not equality (2026-08-15):");
// All 5 damages in this guard on real traffic are a protected token
// DISAPPEARING. The commonest wanted edit it was refusing is a hyphen join,
// where the number is still there wearing a compound -- so the OUTPUT side is
// split on hyphens and the original side is not, which makes the tolerance
// one-directional by construction.
reasonsAre("hyphen join", "I started a 36 day model project today.",
  "I started a 36-day model project today.", []);
reasonsAre("hyphen join 2", "The diagram marks a 70 degree corner here.",
  "The diagram marks a 70-degree corner here.", []);
reasonsAre("a range recombined", "The model uses 20 - 30 small wooden wheels.",
  "The model uses 20-30 small wooden wheels.", []);
// The reverse of a join -- a protected compound SPLIT apart -- is still refused,
// because the original's whole token appears nowhere on the output side.
reasonsAre("a compound split apart", "The covid-19 numbers came in today.",
  "The covid 19 numbers came in today.", ["protected-token", "word-substituted:covid-19"]);
reasonsAre("an identifier split apart", "The sample chart labels the S&P500 in green.",
  "The sample chart labels the S&P 500 in green.", ["protected-token", "word-substituted:s&p500"]);
// ABSENCE IS EXACT-TOKEN, NOT SUBSTRING, and these two are the whole reason:
// "3" is a substring of "30" and "100" of "1000", so a substring test would
// read a changed number as an identifier that survived.
reasonsAre("a digit appended", "I have 3 tickets left for tonight.",
  "I have 30 tickets left for tonight.", ["protected-token", "word-substituted:3"]);
reasonsAre("a digit appended 2", "The build failed on step 100 again.",
  "The build failed on step 1000 again.", ["protected-token", "word-substituted:100"]);
// The dangerous classes named in the round's brief: numbers changed, case
// destroyed, identifiers truncated or stripped, a mention deleted.
reasonsAre("a number changed", "Revenue was $1,200 in Q3 and it was flat.",
  "Revenue was $1,500 in Q3 and it was flat.", ["protected-token", "word-substituted:$1,200"]);
reasonsAre("brand casing destroyed", "I think OpenAI shipped it last week.",
  "I think Openai shipped it last week.", ["protected-token", "capital-removed"]);
reasonsAre("brand casing destroyed 2", "My iPhone battery died again.",
  "My Iphone battery died again.", ["protected-token", "capital-added-to-non-word"]);
reasonsAre("an initialism's case destroyed", "We need the IDs before Friday.",
  "We need the Ids before Friday.", ["protected-token", "capital-removed"]);
reasonsAre("a version truncated", "We are on v1.2.3 in production.",
  "We are on v1.2 in production.", ["protected-token", "word-substituted:v1.2.3"]);
reasonsAre("an identifier stripped", "The __init__ method runs three checks.",
  "The init method runs three checks.", ["protected-token", "word-substituted:__init__"]);
reasonsAre("a multiplier dropped", "I bought 3x model trains for the display.",
  "I bought 3 model trains for the display.", ["protected-token", "word-substituted:3x"]);
reasonsAre("a mention deleted", "<@111111111111111111> can you check the model?",
  "Can you check the model?",
  ["length-band", "protected-token", "word-substituted:111111111111111111"]);
// ADDITIONS are still refused, and the measurement decided it rather than
// caution: dropping the direction recovers two more real sentences and both are
// ones to refuse. An added protected token has to be ACCOUNTED FOR by the
// original -- every hyphen segment of it already a token there, case for case,
// which is what a join is and is nothing a model invents.
reasonsAre("brand casing invented", "I talked to obrien about the plan.",
  "I talked to OBrien about the plan.", ["protected-token"]);
reasonsAre("a number invented", "We shipped it to the team on time.",
  "We shipped it to the team on the 15th.", ["protected-token", "word-substituted:time"]);

// --- edge brackets and acronymization (2026-08-25) --------------------------
//
// Scored the repo-standard way: replayed over 32,863 recorded rows across 63
// files -- 40 refuse->apply (13 unique pairs, every one adjudicated by the
// round's judge panel), 0 apply->refuse, 0 no-op->refuse. Two shapes.
// [MODEL-ADJUDICATED: flips judged by a GPT-5.6 panel calibrated against the
// owner's adjudication ledger (4-class agreement 0.75, damage recall 0.80),
// two framings plus an independent third review, refuse-on-any-refute for
// elements the change itself released. NOT owner-blessed individually.]
//
// stripTokenEdges: an edge bracket is sentence punctuation, so "REquest)" can
// be seen as the stutter it is. Quotes are NOT stripped (with them stripped,
// the replay admitted a corrupted email-header quote and the documented
// invented-quotation hazard, pinned below); markup (*, _, backtick) is not
// stripped; a token with INTERNAL brackets is left whole ("RV(s?)", the
// panel-refuted pluralization hedge, pinned below).
//
// Acronymization: an alphabetic token whose lowercase is not a dictionary
// word may come back as exactly its own uppercase. Digit-bearing identifiers,
// real words, and inexact case ("iW") stay refused.

console.log("\nedge brackets and acronymization (2026-08-25):");
apply("stutter against a closing paren",
  "The toy guide lists part #2718 (a feature REquest).",
  "The toy guide lists part #2718 (a feature request).");
apply("capitalisation against an opening paren",
  "It fits. (to be clear the toy train fits.)",
  "It fits. (To be clear, the toy train fits.)");
apply("acronym under-shifted",
  "The model controller uses an unsupported oS for this test.",
  "The model controller uses an unsupported OS for this test.");
apply("acronym typed lowercase",
  "We can paint the model with the ui today.",
  "We can paint the model with the UI today.");
reasonsAre("brand casing is not an acronymization", "run the iw command now.",
  "run the iW command now.", ["protected-token"]);
reasonsAre("a real word is not an acronym", "it was us against them.",
  "it was US against them.", ["protected-token"]);
reasonsAre("a digit-bearing token keeps its case", "the 3x speedup held.",
  "the 3X speedup held.", ["protected-token"]);
reasonsAre("invented quotation still refused",
  "One of them asked when the model train had arrived and I said two days ago.",
  "One of them asked when the model train had arrived, and I said, \"Two days ago.\"",
  ["protected-token"]);
reasonsAre("markup edges are not stripped",
  "today someone gave me a command that *din't* work at all.",
  "today someone gave me a command that *didn't* work at all.",
  ["protected-token"]);
reasonsAre("an identifier deleted with its brackets",
  "see the (x86) build notes first.",
  "see the build notes first.", ["protected-token", "word-substituted:x86"]);
reasonsAre("an internal bracket keeps its token whole",
  "The model kit includes extra RV(s?)",
  "The model kit includes extra RV(s)?", ["protected-token"]);
reasonsAre("acronymization does not excuse the sibling guard",
  "It's a diy model train, i am painting it rn.",
  "It's a DIY model train, I am painting it rn.", ["capital-added-to-non-word"]);

// --- closerWordExists past the d-1 shell (2026-08-20) -----------------------
//
// The shell was the whole strictly-closer question while the edit budget
// capped at 2; long words got a budget of 3 and a d=3 candidate slipped past
// it. In the rejected lexical shape, "proactivity" sits at d=2 while the model
// proposes "practicality" at d=3: a strictly closer word exists outside the
// old shell. Invented carrier sentences retain that rejection and two valid
// d=3 repairs, so a broader check cannot discard the permitted fixes.
// Note "proactivity" is also a dictionary addition here: the correct word was
// absent from the 64k list, which is what had emptied the strictly-closer set.

console.log("\ncloserWordExists honours its rationale past the shell (2026-08-20):");
reasonsAre("model picked past a closer word",
  "The sample report mentions a level of practiveity.",
  "The sample report mentions a level of practicality.", ["word-substituted:practiveity"]);
reasonsAre("a genuine d=3 fix still applies",
  "This toy bridge is admitesyl a difficult model to paint.",
  "This toy bridge is admittedly a difficult model to paint.", []);
reasonsAre("...and another synthetic carrier for a d=3 repair",
  "The toy station is closed temprratilu.",
  "The toy station is closed temporarily.", []);

// --- Three words the list lacked (2026-09-15) --------------------------------
//
// These synthetic cases exercise non-word -> formerly unlisted word repairs
// at d <= 2, with the typo as the sole unexplained pair. The lexical additions
// were missing from both `data/words-en.txt` and Debian's `american-english`.
// An addition licenses every nearby non-word and can also release a wrong
// correction. The REFUSE half of each pair pins what the guard still says
// when the new word is the ORIGINAL and comes back changed.
// What those three fixtures can and cannot isolate, measured rather than
// claimed (review, 2026-09-15): a Damerau scan of the whole list finds NO
// listed word within d <= 2 of `anthropomorphized` or `subagents`, and only
// `intelligence` (an inflection, admitted by design) near `intelligences` --
// so the real-word-original protection in isRespelling is structurally
// unreachable for these words, and a mutant dropping it leaves the first
// two refuse fixtures at their exact reason lists. `indulgences` is refused
// on distance (d = 4) and `anthropomorphised` on being unlisted; they pin
// the chain's answer, not that one rule. The `sub agents` fixture is the one
// that moves: it APPLIED with `subagents` unlisted (the collapse's non-word
// -> words policy) and refuses now, so the addition made that guard stricter.

console.log("\nThree dictionary additions from the 2026-09-14 review:");
reasonsAre("inteligences -> intelligences (synthetic carrier)",
  "The toy robots represent several inteligences here.",
  "The toy robots represent several intelligences here.", []);
reasonsAre("...and intelligences as an original is not a different word",
  "Two intelligences agreed on it.",
  "Two indulgences agreed on it.", ["word-substituted:intelligences"]);
reasonsAre("anthropomoprhized -> anthropomorphized (synthetic carrier)",
  "The story anthropomoprhized its toy trains.",
  "The story anthropomorphized its toy trains.", []);
reasonsAre("...and a respelling of the listed word is still a substitution",
  "They anthropomorphized the model.",
  "They anthropomorphised the model.", ["word-substituted:anthropomorphized"]);
reasonsAre("ssubagents -> subagents (synthetic carrier)",
  "The sample diagram contains three ssubagents.",
  "The sample diagram contains three subagents.", []);
reasonsAre("...the same edit shape, two typos in one synthetic sentence",
  "Does the toy simulation use 1,000 isntances of ssubagents?",
  "Does the toy simulation use 1,000 instances of subagents?", []);
reasonsAre("...and subagents as an original is not split apart",
  "The subagents are done with it.",
  "The sub agents are done with it.", ["word-substituted:subagents"]);

// --- The trigger the request came from -------------------------------------
//
// content.js reports which evidence said the sentence was finished. It is
// recorded on the log record and passed to the guards, where exactly ONE reads
// it: idle-final-inflection. Three things are asserted below, in order -- the
// normaliser (the field is untrusted input on its way into a storage record),
// that one rule's idle/finished SPLIT, and the narrowness of the split, because
// a trigger-conditional guard has two ways to be wrong and "it fires too widely
// on the idle path" is the one no other suite here can see.

console.log("\nTrigger normalisation (untrusted payload field):");
for (const t of SENTENCE_TRIGGERS) {
  ok(`"${t}" survives`, sentenceTriggerOf({ trigger: t }) === t);
}
ok("an unknown value becomes null", sentenceTriggerOf({ trigger: "paste" }) === null);
ok("a missing field becomes null (old content script)", sentenceTriggerOf({}) === null);
ok("no message at all becomes null", sentenceTriggerOf(null) === null);
ok("a non-string becomes null", sentenceTriggerOf({ trigger: { toString: () => "idle" } }) === null);
ok("an array becomes null", sentenceTriggerOf({ trigger: ["idle"] }) === null);
// SENTENCE_TRIGGERS is an array, so `includes` is doing the work rather than
// property lookup -- a payload naming an Object.prototype member must not pass.
ok("a prototype member becomes null", sentenceTriggerOf({ trigger: "constructor" }) === null);

// --- idle-final-inflection --------------------------------------------------
//
// The ONE rule the trigger decides, and the only place in this file where two
// identical (original, output) pairs are allowed to disagree. Both halves are
// asserted for every case, because a rule that refuses on idle and *also*
// refuses on next-sentence is not a trigger policy, it is an unconditional
// guard that has been mislabelled -- and one that refuses nowhere is dead code
// that reads as shipped.
//
// The carriers below are invented. Their final-token edit pairs preserve
// observed premature-completion shapes, while both trigger outcomes remain
// explicit assertions. See the policy in guardSentenceResult in background.js.
console.log("\nidle-final-inflection: refused on a pause, applied once the user has typed past:");
const IDLE_REFUSED = [
  ["anyways -> anyway, synthetic", "The blue toy train can wait here anyways.", "The blue toy train can wait here anyway."],
  ["anyways -> anyway with a bang, synthetic", "The small toy station is closed anyways!", "The small toy station is closed anyway!"],
  ["thing -> things, synthetic", "The next label on the toy box will name the thing.", "The next label on the toy box will name the things."],
  ["offering -> offerings, synthetic", "Does the toy catalogue include the latest offering?", "Does the toy catalogue include the latest offerings?"],
  // Doubled-consonant inflection, the other half of isInflection.
  ["a doubled-consonant inflection counts", "We talked about how the meeting was plan.", "We talked about how the meeting was planned."],
];
for (const [label, original, output] of IDLE_REFUSED) {
  ok(`${label} — refused on idle`,
    guardSentenceResult(original, output, output, { trigger: "idle" }) === "idle-final-inflection",
    `got ${JSON.stringify(guardSentenceResult(original, output, output, { trigger: "idle" }))}`);
  for (const t of ["next-sentence", "newline", null, undefined]) {
    ok(`${label} — applied on ${JSON.stringify(t)}`,
      guardSentenceResult(original, output, output, t === undefined ? {} : { trigger: t }) === null,
      `got ${JSON.stringify(guardSentenceResult(original, output, output, t === undefined ? {} : { trigger: t }))}`);
  }
}

console.log("\n...and it is narrow: everything else is unchanged by the trigger:");
// The rule is three conjuncts and each one is load-bearing. Drop any of them
// and a real correction starts being refused on the idle path, which is the
// direction that costs the user something they would not see.
const IDLE_UNAFFECTED = [
  ["ordinary mid-sentence typo", "The techncian arrived early today.", "The technician arrived early today."],
  // POSITION: same inflection relation, but not on the final token.
  ["an inflection that is not the final token", "The report was plan for Monday.", "The report was planned for Monday."],
  // EXCLUSIVITY: an inflection on the last word is fine if something else was
  // fixed too -- the model was doing the job, not editing the tail.
  ["a final inflection alongside a real fix", "The techncian arrived early and left the thing.", "The technician arrived early and left the things."],
  // EQUAL TOKEN COUNT, and this case is the only oracle for it. Verified by
  // mutation: delete `A.length !== B.length` and every other case in this file
  // stays green -- including the realestate one, whose final tokens are
  // "realestate"/"real", not an inflection relation -- while this one flips to
  // idle-final-inflection. It is a completion the user should get.
  ["a completion that lengthens the sentence", "The meeting was plan.", "The meeting was planned for us."],
  // RELATION: the commonest final-token corrections there are, and none is an
  // inflection. These are why the cost column is zero.
  ["final-token fix, synthetic", "The model puzzle has a simple asnwer.", "The model puzzle has a simple answer."],
  ["final-token fix, synthetic", "These toy labels are excpetions.", "These toy labels are exceptions."],
  ["final-token fix, synthetic", "The next label says incoporating.", "The next label says incorporating."],
  ["final-token resegmentation, synthetic", "The toy town includes a model office for realestate.", "The toy town includes a model office for real estate."],
  // A LEXICAL change is required. A third of the "edit begins at the final
  // word" population is punctuation or whitespace only, and none of it is this
  // rule's business.
  ["punctuation added at the very end", "yeah I think that works for me", "yeah I think that works for me."],
  ["a comma added mid-sentence", "That is fine by me and I will do it today.", "That is fine by me, and I will do it today."],
  ["a pre-existing refusal is unchanged", "That is fine by me.", "That is fine by me!"],
  ["an unrelated refusal stays refused", "The report was late.", "Send the invoice tomorrow."],
  ["a clean sentence stays a no-op", "The report was late.", "The report was late."],
  // PRECEDENCE. "n" is an inflectional suffix, so dam/damn satisfies the
  // relation -- and it is also a licensed confusable, which is the stronger
  // claim, so it applies on every trigger including idle.
  ["a confusable licence outranks the rule", "I dont give a dam.", "I don't give a damn."],
  ["...in the other direction too", "Well damn that is fast.", "Well dam that is fast."],
];
for (const [label, original, output] of IDLE_UNAFFECTED) {
  const base = guardSentenceResult(original, output, output);
  for (const t of [...SENTENCE_TRIGGERS, null, undefined, "nonsense"]) {
    const got = guardSentenceResult(original, output, output, t === undefined ? {} : { trigger: t });
    ok(`${label} — trigger=${JSON.stringify(t)} matches the no-context verdict`,
      got === base, `got ${JSON.stringify(got)}, baseline ${JSON.stringify(base)}`);
  }
}

// The precedence above is only interesting where the two mechanisms actually
// overlap, and that set is a property of a GENERATED file. Pin it: regenerating
// data/confusables-en.txt must not silently enlarge the set of pairs whose
// licence this guard is standing down for. A new overlap is not necessarily
// wrong -- it needs a look, which is what a failing assertion buys.
console.log("\nThe confusable/inflection overlap is exactly two directed pairs:");
const generatedPairs = readFileSync(new URL("../data/confusables-en.txt", import.meta.url), "utf8")
  .split("\n").map((l) => l.replace(/\r$/, "").trim()).filter((l) => l && !l.startsWith("#"));
const overlap = [...new Set([...CONFUSABLE, ...generatedPairs])]
  .filter((p) => { const [w, c] = p.split("|"); return isReinflection(w, c); }).sort();
ok(`exactly the dam/damn pair, both directions (found ${JSON.stringify(overlap)})`,
  JSON.stringify(overlap) === JSON.stringify(["damn|dam", "dam|damn"]));
// ...and the exemption is reached through isConfusable, not by luck: the
// relation itself must still say yes for these, or the assertion above is
// measuring nothing.
ok("dam/damn really is an inflection relation, so the exemption is load-bearing",
  isReinflection("dam", "damn") && isReinflection("damn", "dam") && isConfusable("dam", "damn"));
ok("and finalTokenInflectionOnly stands down on it while still firing on thing/things",
  finalTokenInflectionOnly("I dont give a dam.", "I don't give a damn.") === false
  && finalTokenInflectionOnly("The model label describes the thing.", "The model label describes the things.") === true);

// --- 2026-09-06 log review: four guard changes ------------------------------
// Scored on the recordings the repo-standard way (a month of real use, 565
// changed outputs): 2 refuse->apply, both correct fixes; 2 apply->refuse, both
// recorded damages the user undid by hand. Owner-bench --reguard passes both
// holdouts with zero NEW damage and one baseline damage REPAIRED; the
// resegmentation survey moves nothing in either direction.
//
// The cases below pin observed edit mechanisms. Identified recorded carriers
// have been replaced with standalone examples for the public fixtures.

console.log("\nA negation resolved past a better-supported reading (negation-ambiguous):");
// A synthetic analogue of the failure. "na" is one edit from the negation by SUBSTITUTION and
// one from an indefinite article by TRANSPOSITION -- the likelier error -- so
// the model read past the better-supported word to reach a negation, and the
// sentence it wrote asserts the opposite of what was typed. Applied silently on
// 2026-09-06 and edited back by hand; every guard in the chain was clean.
reasonsAre("the model picks a negation over a transposition rival",
  "The paint was havign na effect beside the toy bridge?",
  "The paint was having no effect beside the toy bridge?", ["negation-ambiguous"]);
// ...and the OTHER direction applies. Landing on the wrong ordinary word reads
// oddly; landing on the wrong negation asserts the opposite.
apply("...while the article reading is left alone",
  "The paint was havign na effect beside the toy bridge?",
  "The paint was having an effect beside the toy bridge?");
// THE COST OF SYMMETRY, which is what makes one-directionality a measurement
// rather than a preference. Dropping `!isNeg(c)` turns the rule into "refuse
// any distance-1 substitution with a transposition rival" -- 40,734 shapes over
// the shipping word list, of which these are two. Both go red on that mutant,
// and neither has anything to do with negation.
apply("betaer -> better, with \"beater\" one transposition away",
  "This one is betaer than the last.", "This one is better than the last.");
apply("prople -> people, with \"propel\" one transposition away",
  "A lot of prople showed up.", "A lot of people showed up.");
// THE COST COLUMN, and the reason the rule ranks by edit type rather than
// refusing every distance-1 tie. These synthetic carriers preserve four
// permitted correction shapes. A tie-only rule refuses all four: "to" is a listed
// non-negation one edit from "nto". What separates them is that here the
// NEGATION is the transposition -- the likeliest reading -- and the rival is
// not. Delete the isTransposition1 early-continue and these go red.
apply("nto -> not: the negation IS the transposition",
  "The small toy bridge was nto ready for painting.", "The small toy bridge was not ready for painting.");
apply("...even mid-sentence with a comma added",
  "and the blue train would nto cross the wooden bridge.",
  "and the blue train would not cross the wooden bridge.");
// THE early-continue's own oracle. Enumerated exhaustively over the shipping
// word list: exactly two non-words transpose to BOTH a negation and an ordinary
// word -- "nevre" (never / nerve) and "noen" (none / neon). Everywhere else the
// rule's main clause already allows the correction, so these two cases are the
// only thing standing between the early-continue and being unreachable. Delete
// it and "nevre" -> "never", the commonest negation typo there is, goes red.
apply("nevre -> never: the negation and the rival are BOTH transpositions",
  "So I will nevre agree to that plan.", "So I will never agree to that plan.");
apply("...and the same for noen -> none",
  "So far noen of them have agreed.", "So far none of them have agreed.");
// THE EDIT TYPE THAT REACHES THE NEGATION matters too, and this half was found
// by audit rather than by the recordings (2026-09-07). Only a SUBSTITUTION is
// weak enough for a transposition rival to outrank: a transposition invents
// nothing and discards nothing, an insertion keeps every character the user
// typed, a deletion drops one, and a substitution is the only single edit that
// both discards a typed character AND invents one. Ranking a transposition
// above all three refuses these two ordinary typos -- the first a dropped
// doubled letter, which is about as common as a transposition. Delete the
// `w.length !== c.length` line and both go red.
apply("canot -> cannot: an insertion, rival \"canto\"",
  "I canot attend the meeting today.", "I cannot attend the meeting today.");
apply("noe -> no: a deletion, rival \"one\"",
  "I have noe idea what happened.", "I have no idea what happened.");
// A deletion reading with no transposition rival at all ("riot" is a
// substitution of "niot", not a transposition), so nothing was read past.
apply("niot -> not: no transposition rival exists",
  "The toy guide did niot list the blue carriage.",
  "The toy guide did not list the blue carriage.");
// A MOVED SPACE fakes the alignment: "ot" sits against "not" and "to" is a
// transposition of "ot". The letters-identical window excuses it. Without that
// window the survey walls 70 correct repairs of this exact shape. NOTE the
// excuse is deliberately NOT collapseResegmentations, which every sibling in
// this tier consults -- that version was written first and measured redundant
// against both instruments; see the comment on the guard.
apply("a moved space is not a chosen reading",
  "I'm pretty sure the toy train hasn ot stopped here.",
  "I'm pretty sure the toy train has not stopped here.");
// ...including where the repair holds a token the 64k list lacks -- a proper
// noun, a whole documented class -- and where a typo sits in the very next
// word, which is the shape an audit used to show a letters-identical WINDOW
// excuse could be defeated. None of these needs an excuse any more: re-spacing
// changes the length of the token at the aligned index, so a resegmentation
// cannot present as a substitution at all, and the length test above is what
// they now depend on. Delete it and every one of them goes red.
apply("...including where a proper noun blocks the collapse",
  "Velnorn ot moving fits the drawing of the train.",
  "Velnor not moving fits the drawing of the train.");
apply("...and where an unknown proper noun is split before not",
  "I moved it to Velnorn ot Pexton this year.", "I moved it to Velnor not Pexton this year.");
apply("...and where the NEXT word is also wrong",
  "She hasn ot recieved the package yet.", "She has not received the package yet.");
// SCOPE. Unequal token counts mean the alignment is a guess, and a guess is not
// evidence -- the same rule negationChangeIsSpelling already follows.
reasonsAre("an added negation with no aligned non-word is the OLD guard's business",
  "I do agree with the plan.", "I don't agree with the plan.", ["negation-changed"]);

console.log("\nHeld-shift casing on a name (the name licence; was ACCOUNTED_NAME_EDITS):");
// isShiftStutter needs the unstuttered token to be a dictionary word and
// data/words-en.txt carries no proper nouns, so a held shift on a NAME read as
// deliberate brand casing and refused the whole sentence -- taking every other
// typo in it. The synthetic carriers retain both isolated names and names
// beside other typos. Shipped 2026-09-09 as five exact directed pairs,
// because every general SHAPE discriminator that admits these also admits
// "OBrien" -> "Obrien" (pinned as a MUST-REFUSE two suites over). Since
// 2026-09-19 the pairs are a RULE over data/names-en.txt -- the cased entries of
// the SCOWL source -- which survives OBrien on data: `Obrien` is not in it.
// Every fixture below still holds; the ones that changed are marked.
apply("a licensed name, with a real typo beside it",
  "I think the AMerican approach is beter here.",
  "I think the American approach is better here.");
apply("two corrections that used to die together",
  "The sample title says SOnoran Resturant Week in blue letters.",
  "The sample title says Sonoran Restaurant Week in blue letters.");
apply("two licensed names in one sentence",
  "The map labels TUcson with a SPanish caption.",
  "The map labels Tucson with a Spanish caption.");
apply("a licensed name the four other fixtures do not cover",
  "The ANthropic model seems beter today.",
  "The Anthropic model seems better today.");
// THE ORIGINAL-SIDE CONJUNCT. Substituting the licensed form also removes the
// stuttered spelling from the comparison view's token set, so a sentence
// holding BOTH spellings can have the surviving one read as invented by the
// licensed view alone. Asking the plain original first is what stops the
// licence turning that into a refusal the guard never made -- drop the
// `missingProtectedToken(orig, out) &&` conjunct and this goes red.
// (Found by review, 2026-09-09.)
apply("both spellings present, the licence must not accuse",
  "The AMerican and American teams met today.",
  "The American and AMerican teams met today.");
// BOTH guards fire on this shape and the licence has to answer both. The second
// is `capital-removed`, through its upperCount backstop: "AMerican" carries two
// capitals and "American" one -- so a fix to either guard alone leaves the
// sentence refused. Every negative arm below carries `capital-removed` as its
// second reason for exactly that reason, which is also what makes them a gate
// on the PAIR: relax either conjunct and the list loses an entry.
// FLIPPED DELIBERATELY 2026-09-19. This was the documented cost of the pair
// list ("title-casing FLordia gives Flordia, so the residue is a spelling change
// that word-substituted owns"); the name list closes exactly that: `Florida` is
// listed, one edit from `flordia`, and no dictionary word is as close.
apply("a held shift THROUGH a misspelt name is one correction now",
  "We drove to FLordia last summer.", "We drove to Florida last summer.");
// NEGATIVE FIXTURES. The licence is directed and exact: it buys the ONE target
// casing and nothing else about the token.
reasonsAre("a licensed name lowercased outright is not the licensed target",
  "I think the AMerican approach is beter.",
  "I think the american approach is better.",
  ["protected-token", "capital-removed"]);
reasonsAre("...nor is a different word at the same position",
  "I think the AMerican approach is beter.",
  "I think the Mexican approach is better.",
  ["protected-token", "capital-removed", "word-substituted:american"]);
reasonsAre("...nor is deleting it",
  "I think the AMerican approach is beter.",
  "I think the approach is better.",
  ["protected-token", "capital-removed", "word-substituted:american"]);
// The initialism-glued-to-a-word hazard the dictionary test was protecting, and
// the surname hazard that sank the general version of this rule.
reasonsAre("an initialism plus a word keeps its protection",
  "The ITteam is on it.", "The Itteam is on it.",
  ["protected-token", "capital-removed"]);
reasonsAre("...and so does a surname carrying an internal capital",
  "OBrien reviewed the report today.", "Obrien reviewed the report today.",
  ["protected-token", "capital-removed"]);
// The licence must not become a general capital-erasing allowance.
reasonsAre("an ordinary name still may not lose its capital",
  "Alice met Bob on monday morning.", "alice met Bob on Monday morning.",
  ["capital-removed"]);
// EQUAL TOKEN COUNTS, and this is a gate rather than caution: without it the
// peer lookup walks off alignment and a target landing under a licensed token
// by accident buys the casing change. Both of these still refuse overall -- the
// word guards catch the gained or lost word -- but two reasons vanish from the
// list, which is exactly what a reason-list fixture exists to see.
reasonsAre("a longer output does not misalign the peer onto the target",
  "The AMerican plan.", "The American plan is fine.",
  ["protected-token", "capital-removed", "word-substituted:+fine"]);
reasonsAre("...nor does a shorter one",
  "The AMerican big plan.", "The American plan.",
  ["protected-token", "capital-removed", "word-substituted:big"]);
// Positional and equal-count: the target must be witnessed AT THE SAME token
// index, so "it turns up somewhere later" buys nothing.
reasonsAre("the target appearing elsewhere is not evidence about where",
  "The AMerican plan is fine.", "The plan is fine American.",
  ["protected-token", "capital-removed", "content-reordered"]);

// --- The cased name list (2026-09-19) ----------------------------------------
//
// data/names-en.txt: 10,553 cased entries from the SCOWL source, loaded through
// a fail-closed loader like the confusables. The licence (`nameLicence`) admits a
// NON-word corrected to a listed name at a small distance when no dictionary
// word and no other listed name sits as close. Each condition below has a
// synthetic fixture that goes red when that condition alone is dropped.
console.log("\nThe cased name list:");
apply("a lowercase misspelling of a listed name, capitalised and fixed",
  "The sample index lists a budhist text.",
  "The sample index lists a Buddhist text.");
apply("a capitalised misspelling of a listed name",
  "The sample index lists an Antrhopic paper.",
  "The sample index lists an Anthropic paper.");
apply("a lowercase misspelt first name",
  "The display label lists margraet as the model builder.",
  "The display label lists Margaret as the model builder.");
apply("a held shift on a name the hand pairs never listed",
  "which olves grow in ALgeria?", "Which olives grow in Algeria?");
apply("a brand's conventional casing (distance zero after lowercasing)",
  "The sample index lists github beside other tools.", "The sample index lists GitHub beside other tools.");
apply("a space moved onto a name, possessive kept",
  "The worksheet quotes a line fro mTrump's speech.", "The worksheet quotes a line from Trump's speech.");
// THE COST, pinned: a dictionary word as close as the name wins, always.
reasonsAre("a common word at the same distance beats the name (angles)",
  "Los Angales is the worst!", "Los Angeles is the worst!",
  ["word-substituted:angales"]);
reasonsAre("...and a closer common word beats it too (the -> Ted)",
  "I saw teh dog run past.", "I saw Ted dog run past.",
  ["word-substituted:teh"]);
// A NAME strictly closer than the witness beats it: `American` is at distance
// zero from `american`, so a held shift is not a licence to write `Mexican`.
// (The same fixture stands above under the pair list; this is the rule's copy.)
reasonsAre("a held shift on one name is not a licence for a different name",
  "I think the AMerican approach is beter.", "I think the Mexican approach is better.",
  ["protected-token", "capital-removed", "word-substituted:american"]);
// A listed name is never the ORIGINAL side: two names are a substitution.
reasonsAre("one listed name may not become another",
  "Alice met Bob at the office today.", "Alicia met Bob at the office today.",
  ["word-substituted:alice"]);
reasonsAre("...even at distance one",
  "Mark met Bob at the office today.", "Marc met Bob at the office today.",
  ["word-substituted:mark"]);
// A possessive ADDED to a name is grammar, not spelling, and is refused as it
// is for a common word (`client` -> `client's`); a possessive on both sides is
// fine (`mTrump's` -> `Trump's`, above). The synthetic negative carrier adds
// a possessive without correcting the name itself.
reasonsAre("a possessive added to a listed name is not licensed",
  "The toy label shows Cassandra name in blue.", "The toy label shows Cassandra's name in blue.",
  ["word-substituted:cassandra"]);
// A dictionary WORD is never the original side either: `albeit` is one edit
// from `Albert` with no other word or name that close, and it is still a word
// the user typed on purpose.
reasonsAre("a common word may not become a name",
  "I went, albeit reluctantly, to the meeting.", "I went, Albert reluctantly, to the meeting.",
  ["word-substituted:albeit"]);
// The distance budget is the respelling budget capped at 2: the rejected pair,
// `Zelazney` -> `Zealand`, is more than two edits from a listed name and stays
// refused -- and so does a three-edit corruption of a long name with nothing
// else nearby, which is the fixture the budget alone answers.
reasonsAre("a listed name three edits away is not a respelling",
  "The sample index has a heading for Zelazney.", "The sample index has a heading for Zealand.",
  ["word-substituted:zelazney"]);
reasonsAre("...even when nothing else is anywhere near it",
  "I flew to Massachxsxtxs on Monday.", "I flew to Massachusetts on Monday.",
  ["word-substituted:massachxsxtxs"]);
// A name the list does not carry is exactly as protected as before.
reasonsAre("an unlisted name with a held shift stays protected",
  "The SNecko was fast today.", "The Snecko was fast today.",
  ["protected-token", "capital-removed"]);
// `capital-added-to-non-word` is NOT excused by the list: `url` is one edit
// from `curl`, which is the question that guard asks and a name cannot answer.
reasonsAre("a capitalised non-word one edit from a common word stays refused",
  "Please put the url in the doc.", "Please put the URL in the doc.",
  ["capital-added-to-non-word"]);
// Two-letter initialisms are excluded from the list by the builder, so the
// documented `SO` ambiguity is out of the licence's reach either way.
reasonsAre("the all-caps initialism policy is untouched",
  "SO means significant other here.", "So means significant other here.",
  ["protected-token", "capital-removed"]);
// A digit or symbol in the original is never a misspelt name: a handle or an
// identifier one edit from a city is still a handle.
reasonsAre("an identifier is not a misspelt name",
  "I asked Stephani3 about it yesterday.", "I asked Stephanie about it yesterday.",
  ["protected-token", "word-substituted:stephani3"]);

// --- Three narrow protected-token tolerances (2026-09-20) ------------------
//
// Synthetic carriers exercise three formerly blocked correction shapes.
// Each tolerance is one-directional like the hyphen join -- the original's token
// must be WITNESSED by the output in the form the shape explains -- and each
// has a hazard fixture that goes red when its own condition is dropped.
console.log("\nHeld shift on a contraction, a caps-lock slip, a space next to a number:");
// (a) A held shift on a canonical contraction. `THat's` failed the shape rule
// at the apostrophe and `that's` is not a dictionary word, so the whole
// sentence was protected-token.
apply("a held shift on a contraction is a stutter",
  "THat's a tiny model bridge.", "That's a tiny model bridge.");
apply("...with the semicolon-for-apostrophe slip",
  "DOn;t read the article yet.", "Don't read the article yet.");
apply("...beside a licensed name",
  "THat's the AMerican way.", "That's the American way.");
// The two capitals must be followed by a lowercase run BEFORE the apostrophe:
// `IT's` is a possessive of an initialism and stays protected, as `ITs` does.
reasonsAre("an initialism's possessive is not a contraction stutter",
  "The IT's budget was cut.", "The It's budget was cut.",
  ["protected-token", "capital-removed"]);
// (b) A caps-lock slip: one lowercase letter, then three or more capitals,
// witnessed by an all-caps token whose lowercase is a listed word -- the
// original's own lowercase, or a respelling of it when that is a non-word.
apply("a caps-lock slip with a typo inside it",
  "The toy train aCTUAALY stopped here.", "The toy train ACTUALLY stopped here.");
apply("a caps-lock slip on a real word",
  "The toy label says cAPABILITY!", "The toy label says CAPABILITY!");
// The witness must be ALL CAPS: title-casing the slip is a different edit and
// is not licensed: the permitted target is an all-caps token.
reasonsAre("a caps-lock slip title-cased is not the witnessed shape",
  "The toy train aCTUAALY stopped here.", "The toy train Actually stopped here.",
  ["protected-token", "capital-removed"]);
// The witness must be ALL CAPS: an internal-capital respelling is protected
// in its own right and is not what a caps-lock slip corrects to.
reasonsAre("an internal-capital witness is not a caps-lock correction",
  "The toy train aCTUAALY stopped here.", "The toy train AcTUALLY stopped here.",
  ["protected-token"]);
// For the record: `gRPC` -> `GRPC` and `xQZZT` -> `XQZZT` are admitted by the
// 2026-08-25 acronymization rule (whole-token uppercase of a non-word), not by
// this one, and `eSIM` -> `ESIM` is refused by capital-added-to-non-word first.
reasonsAre("a lowercase-initial identifier one edit from a word stays refused",
  "My eSIM broke today.", "My ESIM broke today.",
  ["capital-added-to-non-word"]);
// (c) A space moved next to a number. `3hours` -> `3 hours` lost `3hours` from
// the multiset; the digit run witnesses it when the letters are a listed word
// of two or more characters standing as an output token, and the collapse
// counts a bare number as a word on the gained side so word-substituted does
// not then refuse `+3`.
apply("a space restored after a number",
  "The toy train needs 3hours to circle this track.", "The toy train needs 3 hours to circle this track.");
apply("...and the ordinary time-of-day shape",
  "We met at 10am sharp.", "We met at 10 am sharp.");
apply("a range dash spaced away from its number",
  "The model bridge is 2.5 -3 inches long.", "The model bridge is 2.5 - 3 inches long.");
// `3x` -> `3 x`: `x` is one letter, and `3x` -> `3` is an unlicensed deletion.
reasonsAre("a one-letter suffix is an identifier, not a moved space",
  "It costs 3x more here.", "It costs 3 x more here.",
  ["protected-token"]);
// A dropped sign is not a spaced dash: the dash must survive as a token.
reasonsAre("a dropped minus sign stays refused",
  "The temperature was -3 degrees.", "The temperature was 3 degrees.",
  ["protected-token"]);
// A number split in two is not a moved space: protected-token owns the digits.
reasonsAre("a number split in two is refused",
  "The code is 12345 for the door.", "The code is 123 45 for the door.",
  ["protected-token"]);
// THE COST, pinned: `pm` is not in the word list, so `5pm` -> `5 pm` stays
// refused. If `pm` is ever added by the per-word precedent this flips
// deliberately.
reasonsAre("an unlisted suffix does not witness the number",
  "It is 5pm now.", "It is 5 pm now.",
  ["protected-token"]);

// --- An accidental mid-sentence capital on a function word (2026-09-20) ------
//
// The licence covers function words, adverbs and determiners ONLY -- never
// a content word or a verb -- and only when isolated from other capitals,
// not sentence-initial, not a listed name, and lowercased exactly. The invented
// carriers below preserve each condition and its production-mutant check.
console.log("\nAn accidental capital on a function word:");
apply("an auxiliary capitalised by accident in synthetic text",
  "I still arrange the toy display as I Was taught.",
  "I still arrange the toy display as I was taught.");
apply("...a modal, after the pronoun I",
  "The guide thinks I Should paint the model train today.",
  "The guide thinks I should paint the model train today.");
apply("...beside a real typo, with the pronoun fixed too",
  "While tsting this model how Do i stop the train?",
  "While testing this model how do I stop the train?");
apply("...a determiner from the adverb/determiner list, with a comma added",
  "Put the total at the bottom Each number should be bold.",
  "Put the total at the bottom, each number should be bold.");
apply("...a conjunction",
  "I stayed home Because it rained.", "I stayed home because it rained.");
// CONTENT WORDS are not licensed -- accidental or not. The synthetic `Air`
// example stays refused: it is the same protected shape as `Fable`.
reasonsAre("a content word keeps its capital even when it was accidental",
  "The toy catalogue uses Air in a model name.",
  "The toy catalogue uses air in a model name.",
  ["capital-removed"]);
reasonsAre("...and so does a capitalised product-name example",
  "The sample label has Fable in blue letters.", "The sample label has fable in blue letters.",
  ["capital-removed"]);
// A VERB from the stutter list is not licensed: a capitalised verb mid-sentence
// is how a quoted title reads, as the invented heading below demonstrates.
reasonsAre("a capitalised verb is a title, not a slip",
  "The sample heading says Make a tiny train.", "The sample heading says make a tiny train.",
  ["capital-removed"]);
// A function word that is also a listed NAME keeps its capital.
reasonsAre("a function word that is a name stays a name",
  "We met Will at the office.", "We met will at the office.",
  ["capital-removed"]);
reasonsAre("...including the modal that is a month",
  "I think we should ship in May this year.", "I think we should ship in may this year.",
  ["capital-removed"]);
// NEIGHBOURS: a capital either side means a name or a title.
reasonsAre("a function word inside a name is not isolated",
  "We ate at Still Point yesterday.", "We ate at still point yesterday.",
  ["capital-removed"]);
reasonsAre("...nor one inside a slogan",
  "The game is Only Connect on Monday.", "The game is only Connect on Monday.",
  ["capital-removed"]);
// SENTENCE-INITIAL is a different question and never licensed, and a URL
// ends a sentence for this purpose.
reasonsAre("a sentence-initial capital is not accidental",
  "It was fine. Which is why I left.", "It was fine. which is why I left.",
  ["capital-removed"]);
reasonsAre("...and a word after a pasted link starts a sentence",
  "See https://example.com/x This is not right.", "See https://example.com/x this is not right.",
  ["capital-removed"]);
// EXACT lowercase only: the licence is for the case, not for the word.
reasonsAre("changing the word as well as its case is not licensed",
  "I stayed home Because it rained.", "I stayed home since it rained.",
  ["capital-removed", "word-substituted:because"]);

// The loader fails closed, exactly as the confusables loader does -- and for
// the same reason: this file GRANTS.
console.log("\nThe name list -- the loader fails closed:");
{
  const good = await fetchNames(diskFetch());
  ok("a good file loads", !!good && good.size === NAMES_COUNT,
    `got ${good === null ? "null" : `size ${good && good.size}`}, want ${NAMES_COUNT}`);
  const POISON = "# comment\n" + "Obrien\n".repeat(NAMES_COUNT);
  const body = (text, extra = {}) => ({ ok: true, status: 200, text: async () => text, ...extra });
  const real = readFileSync(new URL("../data/names-en.txt", import.meta.url), "utf8");
  const cases = [
    ["HTTP 404 whose body is a valid-looking list", { "names-en.txt": { ok: false, status: 404, text: async () => POISON } }],
    ["HTTP 200 with a poisoned body of the right length", { "names-en.txt": body(POISON) }],
    ["a body with one line appended", { "names-en.txt": body(real + "Obrien\n") }],
    ["a body with one entry swapped (count intact, digest wrong)", { "names-en.txt": body(real.replace("\nFlorida\n", "\nObrien\n")) }],
    ["a body of the right length in the wrong format", { "names-en.txt": body("# x\n" + "o'brien\n".repeat(NAMES_COUNT)) }],
    ["a fetch that throws", { "names-en.txt": null }],
  ];
  for (const [label, override] of cases) {
    const impl = override["names-en.txt"] === null ? async () => { throw new Error("network"); } : diskFetch(override);
    const got = await fetchNames(impl);
    ok(`publishes null: ${label}`, got === null, `got ${got && `a Set of ${got.size}`}`);
  }
  // The consequence: a poisoned load must not license OBrien -> Obrien.
  setNames(await fetchNames(diskFetch({ "names-en.txt": body(POISON) })));
  reasonsAre("a poisoned name list cannot grant OBrien -> Obrien",
    "OBrien reviewed the report today.", "Obrien reviewed the report today.",
    ["protected-token", "capital-removed"]);
  // Null publishes the HAND names and nothing else.
  setNames(null);
  apply("with no list at all the hand names still hold",
    "The ANthropic model seems beter today.", "The Anthropic model seems better today.");
  reasonsAre("...and a listed-only name does not",
    "We drove to FLordia last summer.", "We drove to Florida last summer.",
    ["protected-token", "capital-removed", "word-substituted:flordia"]);
  const control = !!process.env.PROOFER_NO_NAMES;
  setNames(control ? null : good);
  ok(`the starting state is restored (${control ? "control" : "shipping"})`,
    (guardSentenceResult("We drove to FLordia last summer.", "We drove to Florida last summer.",
      "We drove to Florida last summer.") === null) === !control);
}

console.log("\nDiscord's emoji separator (emojiSeparatorOmission):");
// Discord's emoji autocomplete writes a U+FEFF straight after the shortcode it
// completes, so the field holds ":doom:\uFEFF vs ...". The model drops it --
// reasonably, it is invisible -- and typographyPreserved compares the NON-ASCII
// multiset, so the whole sentence died and every real typo in it died with the
// separator. Synthetic shortcode carriers retain the invisible separator,
// including one beside the lexical repair "inetentional" -> "intentional".
apply("the separator dropped, with a real typo fixed beside it",
  "The sample label has :thumbsdown:\uFEFF beside the word inetentional.",
  "The sample label has :thumbsdown: beside the word intentional.");
apply("the separator dropped and nothing else changed",
  "The toy map has :doom:\uFEFF beside the blue bridge.",
  "The toy map has :doom: beside the blue bridge.");
// NEGATIVE FIXTURES. The excuse is for ONE separator against ONE shortcode that
// occurs once, and each of these kills a different way of widening it. A mutant
// that drops any single condition passes the two cases above and fails one of
// these.
reasonsAre("two marked shortcodes are outside it",
  "I like :doom:\uFEFF and :sauropod:\uFEFF alot.",
  "I like :doom: and :sauropod: a lot.", ["typography-changed"]);
reasonsAre("...so is a shortcode that occurs twice",
  "I like :doom:\uFEFF but not :doom: realy.",
  "I like :doom: but not :doom: really.", ["typography-changed"]);
// The output side is asked too: a model that DUPLICATES the shortcode has not
// merely dropped a separator, and pinning the full list keeps the first entry
// as the thing this fixture is about.
reasonsAre("...and so is a shortcode the model duplicated",
  "I like :doom:\uFEFF alot.", "I like :doom: :doom: a lot.",
  ["typography-changed", "word-substituted:+doom"]);
// The shortcode is what identifies the character as the autocomplete's leaving
// rather than the user's own text. U+FEFF is also a byte-order mark and a
// historical no-break space, so a bare one is not excused.
reasonsAre("a bare U+FEFF with no shortcode against it",
  "This\uFEFF sentance is wrong.", "This sentence is wrong.", ["typography-changed"]);
// Pinned to the FULL list: a U+FEFF that is not followed by a space sits INSIDE
// a token, so removing it necessarily changes that token and the word guards
// have something to say too. Both reasons are asserted, so a mutant dropping
// the trailing-space condition goes red on the missing first entry rather than
// hiding behind the second.
reasonsAre("...and one not followed by an ordinary space",
  "The :doom:\uFEFFthing is bad and wrogn.",
  "The :doom:thing is bad and wrong.",
  ["typography-changed", "word-substituted:doom"]);
// THE MARKED SEPARATOR is the one that has to have gone. Discounting a U+FEFF
// and re-asking establishes only that the count fell by one; these two differ in
// WHICH occurrence disappeared and the arithmetic cannot tell them apart, so the
// token is asked about directly. (Found by review, 2026-09-09.)
reasonsAre("the shortcode's separator surviving while another is deleted",
  "I like :doom:\uFEFF sent\uFEFFence.",
  "I like :doom:\uFEFF sentence.", ["typography-changed"]);
// Occurrences can OVERLAP, and `split` does not find overlapping ones -- so a
// split-based uniqueness test read ":doom:doom:" as a single occurrence.
reasonsAre("an overlapping second occurrence of the shortcode",
  "I like :doom:doom:\uFEFF alot.",
  "I like :doom:doom: a lot.", ["typography-changed"]);
// Two marked separators with only ONE deleted balances the discount arithmetic
// exactly, so the re-ask cannot see it and the mark count is what refuses.
reasonsAre("two marked separators, only one of them dropped",
  "I like :doom:\uFEFF and :sauropod:\uFEFF alot.",
  "I like :doom: and :sauropod:\uFEFF a lot.", ["typography-changed"]);
// A SECOND, unrelated zero-width character the model correctly PRESERVED is not
// a reason to refuse. This is the case that made an explicit "the output must
// contain no U+FEFF" test wrong rather than merely redundant; it pins the
// deletion, so restoring that line goes red here.
apply("a stray zero-width elsewhere, preserved, does not block the excuse",
  "I like :doom:\uFEFF a\uFEFFlot.",
  "I like :doom: a\uFEFFlot.");
// Discounting ONE character must not license a second typographic change in the
// same sentence: the real question is re-asked with only that one removed.
reasonsAre("a smart quote changed alongside the separator",
  "I like :doom:\uFEFF \u201Calot\u201D.",
  "I like :doom: \"a lot\".", ["typography-changed"]);
reasonsAre("...or an emoji deleted alongside it",
  "I like :doom:\uFEFF \u{1F600} alot.",
  "I like :doom: a lot.", ["typography-changed"]);

console.log("\nA closing bracket invented out of nothing (closer-added):");
// Synthetic analogue of an observed shape: a bare "}" is appended to a
// sentence containing no brace at all. typographyPreserved compares
// the non-ASCII multiset and a brace is ASCII, so nothing saw it.
reasonsAre("a brace appended with no opener anywhere",
  "The plan is fine and we should ship it.",
  "The plan is fine and we should ship it.}", ["closer-added"]);
// NEGATIVE FIXTURES. Each kills a different plausible mutant of the rule; a
// mutant that exempts an addition whenever ANY opener appears anywhere passes
// the case above and fails this one.
reasonsAre("an already-BALANCED pair does not license a third closer",
  "The plan (as written) is fine here.",
  "The plan (as written) is fine here.)", ["closer-added"]);
reasonsAre("...nor does an opener of a DIFFERENT type",
  "I am (not sure about this one.",
  "I am (not sure about this one.]", ["closer-added"]);
// The original already has MORE closers than openers, so there is nothing
// unmatched to close and a further one is invented. This is the emoticon shape.
reasonsAre("...nor does an excess closer already in the original",
  "I sent the whole thing to him :)",
  "I sent the whole thing to him :))", ["closer-added"]);
// COUNTED IN ORDER, not by subtraction, and both directions were wrong under a
// subtraction (found by audit, 2026-09-07). An earlier stray closer cannot pay
// for a later genuine opener...
apply("an earlier smiley does not cancel a later unmatched opener",
  "I sent it to him :) (at noon.", "I sent it to him :) (at noon).");
// ...and one unmatched opener licenses exactly one closer, not any number.
reasonsAre("one opener does not license four closers",
  "The rewriter was ready (at last.",
  "The rewriter was ready (at last.))))", ["closer-added"]);
apply("two openers license two closers",
  "We opened two ((at once.", "We opened two ((at once.))");
// A multi-reason failure pinned to its FULL list, so an early return that
// suppresses later evidence is visible here rather than passing as "refused".
reasonsAre("a closer added ON TOP of a substitution reports both",
  "The salt was on the table already.",
  "The slat was on the table already.}", ["closer-added", "word-substituted:salt"]);
// ...and what stays allowed. An unmatched opener in the original licenses
// its corresponding closer, as these synthetic bracket cases demonstrate.
apply("the user left an opener unclosed and the model closes it",
  "The plan (as written is fine here.", "The plan (as written) is fine here.");
apply("an emoticon the model does not touch",
  "I sent it to hiim :)", "I sent it to him :)");
apply("a wrong-type opener is still unmatched for ITS type",
  "I am [not sure about this one.", "I am [not] sure about this one.");

console.log("\nA fragment completed at the front (leading-word-added):");
// substitutedContentWords exempts gained FUNCTION words -- deliberately, since
// an inserted "the" is a common real fix -- which leaves the front of a
// sentence unguarded. The lowercase arm is the gate: it APPLIES on the
// pre-change revision.
reasonsAre("a leading article invented on a lowercase fragment",
  "terrible person behaves badly.", "A terrible person behaves badly.",
  ["leading-word-added"]);
// The same edit with the original capitalised was already refused -- by
// capital-removed, an accident of the displaced capital rather than a
// judgement about the insertion. Pinned to the FULL list so the new guard is
// shown to fire underneath it rather than to be masked by it.
reasonsAre("...and it fires underneath capital-removed on the capitalised arm",
  "Terrible person behaves badly.", "A terrible person behaves badly.",
  ["capital-removed", "leading-word-added"]);
// The insertion must be at the FRONT, and two alignments explain the same token
// counts. isRespelling pairs "as" with an inserted "a" (and "then" with "the")
// as reinflections, so an INTERNAL insertion read as a leading one and both of
// these were refused until an audit produced them (2026-09-07). An unchanged
// opener settles it; delete `ow[0] === rw[0]` and both go red.
apply("an internal insertion is not a leading one",
  "As child I loved trains.", "As a child I loved trains.");
apply("...and the same with a conjunction opener",
  "Then dog barked loudly.", "Then the dog barked loudly.");
// TRAP. A moved space at the start gains a leading token too, and that token is
// a function word. Remove the collapseResegmentations call and both go red.
apply("a moved space at the front is a repair, not an invention",
  "Ithink it works fine now.", "I think it works fine now.");
apply("...and the same with a wh-word",
  "Howdo you feel about it?", "How do you feel about it?");
// SCOPE, stated rather than implied. An unexplained TRAILING insertion is a
// real and separate leak and is still open; this fixture records that, so the
// day it is closed this line is what has to change deliberately.
apply("an unexplained TRAILING insertion is a NAMED RESIDUAL, still applied",
  "Send the report.", "Send the report to me.");
// The insertion must be the ONLY unexplained change; anything else is another
// guard's business and this one stands down rather than double-reporting.
apply("an ordinary correction with no insertion is untouched",
  "the report was recieved late.", "the report was received late.");

console.log("\nA hyphen inserted into a run-together compound (isRespelling):");
// The one part of "trust the model's unlisted word" that survives measurement.
// The candidate is absent from the 64k list because the list holds single
// words; nothing is invented, because de-hyphenating it reproduces the original
// character for character.
apply("a compound the word list cannot hold",
  "The sample report uses cherrypicked figures.", "The sample report uses cherry-picked figures.");
apply("...and a second, longer one",
  "I need to run the twoparagraph version.", "I need to run the two-paragraph version.");
// THE NEGATIVE. Remove the exact-letters condition and this walks through
// behind a hyphen -- which is the whole general rule that was built, replayed
// and refuted, arriving one edit at a time.
reasonsAre("a letter invented behind the hyphen is still refused",
  "I need to run the twoparagrpah version.",
  "I need to run the two-paragraph version.", ["word-substituted:twoparagrpah"]);
// DIRECTION. A compound SPLIT APART is a different edit and stays refused; the
// original here is a listed word, so the branch cannot fire at all.
reasonsAre("a listed compound is not a run-together token",
  "We worked overtime on it.", "We worked over-time on it.",
  ["word-substituted:overtime"]);
// EVERY PIECE must be in the dictionary. Delete the isWord() call from the
// every() and this walks through -- the previous fixture set could not see it,
// because both its positives have listed pieces and its negative fails on the
// LETTERS instead.
reasonsAre("a piece that is not a word is not a compound",
  "The sample report uses cherrypickd figures.", "The sample report uses cherry-pickd figures.",
  ["word-substituted:cherrypickd"]);
// ...and every piece must be a CONTENT word, which is what keeps the
// `the rapist` family out. Both of these satisfy every other condition --
// unlisted source, listed pieces, letters exact, distance within budget -- and
// both were APPLIED until an audit produced them (2026-09-07).
reasonsAre("a hyphen either side of a function word is a mis-segmentation",
  "The therapiston call arrived early.", "The the-rapist-on call arrived early.",
  ["word-substituted:therapiston"]);
reasonsAre("...and so is one beside a preposition",
  "I will livein a small town.", "I will live-in a small town.",
  ["word-substituted:livein"]);

console.log("\nThe closed calendar set in data/words-en.txt:");
// 25 words: seven days, the ten months the list lacked, and a handful of fixed
// holidays. A closed, enumerable, complete set that is never revisited -- which
// is what separates it from the personal-and-brand-name treadmill, where an
// experimental name list was measured admitting a one-letter name-variant
// substitution (the salt/slat hazard wearing a proper noun).
//
// SCOPE, measured 2026-09-06 and worth recording because it settles the
// standing "rebuild from a larger SCOWL size or hand-add?" question for this
// source. Debian's SCOWL-derived american-english holds 104,334 entries, 39,335
// of which this file lacks: 29,590 possessives and contractions, 9,574
// capitalised proper nouns, 159 accented proper nouns, and 12 mixed-case brand
// and unit tokens (iPhone, kHz, pH). ZERO all-lowercase ASCII words. A rebuild
// from this source therefore adds no ordinary lower-case vocabulary; the
// calendar entries below are deliberate, individually checked additions.
//
// These four synthetic carriers preserve the calendar repair shapes. A
// dictionary rebuild that drops their licensed words turns these checks red.
apply("mondya -> Monday", "The toy calendar marks mondya in blue.",
  "The toy calendar marks Monday in blue.");
apply("tuesdasy -> Tuesday", "The next toy calendar label is tuesdasy morning.",
  "The next toy calendar label is Tuesday morning.");
apply("haloween -> Halloween", "The toy catalogue has a haloween display.",
  "The toy catalogue has a Halloween display.");
apply("decmber -> December", "The toy calendar begins with decmber the third.",
  "The toy calendar begins with December the third.");
// ...and the addition is NOT monotonically safe, which is why every candidate
// word gets a replay before it goes in. A rare-but-real noun added to this file
// releases a recorded WRONG correction: the source is a non-word, the target
// becomes listed at distance 1, and isRespelling admits it. The calendar set
// was cleared the same way -- 3 refuse->apply on the month's recordings, all
// correct, 0 reverse, both holdout gates unmoved, and the resegmentation
// survey's POLICY count unchanged at 560.

console.log("\nA blessed contraction replacement, twice in one sentence:");
// isBlessedContractionReplacement licenses "it's" -> "its" (owner decision,
// 2026-08-15). The pairing rule asked for exactly ONE mate, which is two
// conditions wearing one number -- unambiguity, and accounting for what was
// lost. They come apart when the sentence holds the same contraction twice.
apply("a sole occurrence, unchanged behaviour",
  "The toy bridge has it's own small label here.",
  "The toy bridge has its own small label here.");
apply("two occurrences, both re-punctuated",
  "The toy bridge has it's own small label and it's own box.",
  "The toy bridge has its own small label and its own box.");
// ...and the UNAMBIGUITY half is still enforced, which is the other condition
// the old single number was carrying. Two occurrences of the same contraction,
// one re-punctuated to the blessed word and one to a bare non-word: the counts
// balance, so a bare `mates.length !== nLost` test lets it through and leaks
// "whos". Only the distinct-FORM test refuses it. This fixture is the sole
// oracle for that half -- verified by mutation, it is the one case in the file
// that flips.
reasonsAre("two occurrences resolved to two DIFFERENT forms still refuses",
  "I know who's coming and who's paying for it.",
  "I know whose coming and whos paying for it.", ["contraction-expanded"]);

// SD-55 — word-list absent: acronym veto stands down.
// Mutant: prepend `haveDictionary() &&` to missingProtectedToken's acronymizable
// predicate; the absent-word-list full-reason and production-result checks below
// turn red (protected-token instead of [], and protected-token instead of null).
console.log("\nWord-list fallback preserves the chosen admission policy:");
{
  const original = "Send it to us today.", output = "Send it to US today.";
  reasonsAre("word-list present: acronym veto holds", original, output, ["protected-token"]);
  // Clear only words: the generated names and confusables stay installed.
  setDictionary(null);
  ok("word-list absent: isWord answers false", isWord("us") === false);
  reasonsAre("word-list absent: acronym veto stands down", original, output, []);
}

console.log("\n" + "=".repeat(72));
console.log(`${pass} passed | ${leaks.length} LEAKS | ${falseRejects.length} false rejects`
  + (failures.length ? ` | ${failures.length} other failures` : ""));


// Known and accepted, documented in ARCHITECTURE.md:
//   - "Whom should I ask" -> "Who should I ask": a function-word change, the
//     class deliberately allowed so that "Marcus and me" -> "and I" works.
//   - "the first version tested well" -> "was tested well": a one-word
//     insertion that changes meaning while passing every structural check.
//     Nothing at this layer can catch it; the green flash and Undo (§6) are the
//     defence, which is why they are not decoration.
if (leaks.length || falseRejects.length || failures.length) process.exit(1);
console.log("All checks passed.");
