/**
 * Do ordinary typing mistakes actually get corrected?
 *
 *   cd test && node sentence-typo-recall-test.mjs
 *
 * No Ollama, no browser. The other guard suite (sentence-guard-test.mjs) asks
 * "does a bad rewrite get refused"; this one asks the opposite question, and it
 * is the one nobody was asking. Every guard is a filter, every filter has a
 * false-positive rate, and nothing measured it -- so the guards drifted until
 * they refused 7 of these 25, including `teh` -> `the`. A user typing normally
 * saw the feature do nothing at all and reported it as broken, which is exactly
 * what it looked like from outside.
 *
 * Both halves matter and they pull against each other, so they live in one
 * file: a change that raises SHOULD-APPLY by leaking a MUST-REFUSE has not
 * improved anything. Ranking is on the live corpus (sentence-live-test.mjs);
 * this suite is the fast check that runs in a second.
 */
import { guardSentenceResult } from "./lib/sentence-guards.mjs";
// Ordinary typing mistakes with the correction a human would make.
// Identified log-derived sentence carriers use standalone examples here.
// Every one of these SHOULD apply.
const should = [
  ["The techncian arrived early.", "The technician arrived early."],
  ["We recieved the invoice yesterday.", "We received the invoice yesterday."],
  ["I don;t think the model station is painted yet.", "I don't think the model station is painted yet."],
  ["We can;t ship it on Friday.", "We can't ship it on Friday."],
  ["It;s a bit long for a first draft.", "It's a bit long for a first draft."],
  ["I dont think the model station is painted yet.", "I don't think the model station is painted yet."],
  ["WHere did you put the report?", "Where did you put the report?"],
  ["THis is the part I keep getting wrong.", "This is the part I keep getting wrong."],
  ["teh meeting is at four.", "The meeting is at four."],
  ["Its a bit long for a first draft.", "It's a bit long for a first draft."],
  ["The model is testing tsting testing on this track.", "The model is testing testing testing on this track."],
  ["We seperate the two concerns here.", "We separate the two concerns here."],
  ["The results was better than expected.", "The results were better than expected."],
  ["He dont know what he is doing.", "He doesn't know what he is doing."],
  ["Their going to be late again.", "They're going to be late again."],
  ["I should of checked first.", "I should have checked first."],
  ["She has alot of experience with this.", "She has a lot of experience with this."],
  // Three typos in six words. Documented as an accepted loss while overlap
  // asked for VERBATIM tokens, which measured how many typos a sentence had
  // rather than how much of it survived.
  ["The techncian arrived erly this mroning.", "The technician arrived early this morning."],
  ["and how doyu oknow which tracks you knoww?", "and how do you know which tracks you know?"],
  ["yah I've hear dmodel trians can still cross here.", "Yeah, I've heard that model trains can still cross here."],
  ["DOes the model station come wit hthis kind of roof?", "Does the model station come with this kind of roof?"],
  ["I can't tell if the train moves because nothign has crossed the bridge yet but maybe it will?", "I can't tell if the train moves because nothing has crossed the bridge yet, but maybe it will?"],
  ["How do yo know if that is right?", "How do you know if that is right?"],
  // ...and the reading the guard must NOT block: one edit, nothing closer.
  ["The sample label refers to that emtal.", "The sample label refers to that metal."],
  // The d=3 band: since 2026-08-20 closerWordExists scans past the d-1 shell
  // when the budget allows three edits, and these two are the measured cost
  // column. These synthetic carriers preserve two permitted d=3 repairs.
  // Nothing sits closer to either spelling, so both must still apply.
  ["This toy bridge is admitesyl a difficult model to paint.", "This toy bridge is admittedly a difficult model to paint."],
  ["The toy station is closed temprratilu.", "The toy station is closed temporarily."],
  ["Another fairly easy imrpvoement is possible here.", "Another fairly easy improvement is possible here."],
  ["You are nto allowed to move the toy bridge during the game.", "You are not allowed to move the toy bridge during the game."],
  // A moved space. Word-to-word, none of these has a reading: "nwo" is two
  // edits from "know" and zero from "know" once the boundary is where the
  // corrected form witnesses it. Three invented carriers preserve those shapes.
  ["Can the parser filtererrors from a sample file?", "Can the parser filter errors from a sample file?"],
  ["How do wek nwo hwat is hoing on in the model town?", "How do we know what is going on in the model town?"],
  ["Drawing mroe incase htis fills the map that's empty.", "Drawing more in case this fills the map that's empty."],
  ["I will be there aslong as it stays dry.", "I will be there as long as it stays dry."],
  ["Howdo you know if that is right?", "How do you know if that is right?"],
  ["We was going to ship it Friday.", "We were going to ship it Friday."],
  ["Can you send me teh link agian?", "Can you send me the link again?"],
  ["Thats not what I meant at all.", "That's not what I meant at all."],
  ["Im not sure that follows.", "I'm not sure that follows."],
  ["The data shows a clear trend, dont you think?", "The data shows a clear trend, don't you think?"],
  ["Whats the status on the migration?", "What's the status on the migration?"],
  ["I definately want this working.", "I definitely want this working."],
  ["We need to discus the timeline.", "We need to discuss the timeline."],
  ["Their are three options on the table.", "There are three options on the table."],
  ["The server keep crashing overnight.", "The server keeps crashing overnight."],
  // Synthetic carrier for three typos corrected together. The old change
  // budget refused this shape at 4, and "wim" -> "swim"
  // was refused as a first-letter change until prefix insertion was separated
  // from first-letter substitution.
  ["Whles are biggger than seals and wim around the toy boats!",
   "Whales are bigger than seals and swim around the toy boats!"],
  ["Let me now if you need anything else.", "Let me know if you need anything else."],
];
// Corrections that are refused ON PURPOSE, asserted so the reason stays a
// decision rather than an accident. Each needs the model to infer more than a
// respelling, and a missed typo is free.
const knownRefused = [
  // Two errors at once: the wrong key AND a missing letter. Reading "don;" as
  // "don't" means inventing a character and a negation.
  ["I don; think the model station is painted yet.", "I don't think the model station is painted yet."],
];

// These MUST be refused -- the damage classes the guards exist for.
const mustRefuse = [
  // From a codex audit of edb1e10. Every one of these APPLIED before the fix.
  ["OBrien reviewed the report today.", "Obrien reviewed the report today."],
  // A fully-capitalised word IS the acronym shape, and position cannot rescue
  // it: an initialism is a noun, and nouns head sentences. A first-token
  // allowlist was tried and let all of these through (gpt-5.6 audit).
  ["My SO is coming over later.", "My so is coming over later."],
  ["SO means significant other here.", "So means significant other here."],
  ["THE released its new rankings today.", "The released its new rankings today."],
  ["BUT supplied the railcars used here.", "But supplied the railcars used here."],
  ["IT said the ticket was closed.", "It said the ticket was closed."],
  ["WHO published the guidance today.", "Who published the guidance today."],
  // `capital-removed` compared a COUNT against the unstuttered original only,
  // which made capitals fungible: "THis" keeps the capital that "Alice" lost,
  // the totals match, and bare() lowercases both names so nothing else sees it.
  // Pre-dates the caps-stutter work; found by the same audit.
  ["THis met Alice at the office today.", "THis met alice at the office today."],
  ["SO met Alice at the office today.", "SO met alice at the office today."],
  ["SO) Alice reviewed the report today.", "SO) alice reviewed the report today."],
  // Unstuttering BOTH sides fixed the three above and not the general case: a
  // capital the model correctly ADDS is currency too. `monday` -> `Monday` is a
  // real fix, and it bought the erasure of a name. Second audit pass; a total
  // cannot answer this, so capitals are now compared per word.
  ["Alice met Bob on monday morning.", "alice met Bob on Monday morning."],
  ["The Committee met on monday morning.", "The committee met on Monday morning."],
  ["Alice reviewed the london office today.", "alice reviewed the London office today."],
  ["THis met Alice on monday morning.", "This met alice on Monday morning."],
  ["I DMed the client yesterday.", "I Dmed the client yesterday."],
  ["We are DMing the client now.", "We are Dming the client now."],
  ["The salt was on the table.", "The slat was in the table."],
  ["The answer is insight.", "The answer is in sight."],
  // A synthetic carrier for an observed ambiguity: "emtal" is two edits
  // from "email" and one from "metal" -- a plain transposition. The guard
  // rejects the more distant reading without guessing at the author's intent.
  ["The sample label refers to that emtal.", "The sample label refers to that email."],
  ["Do you reant?", "Do you read?"],
  // The same defect one budget out (2026-08-20): "practiveity" took a d=3
  // reading while "proactivity" sat at d=2, unchecked because only the d-1
  // shell was enumerated. Confirmed damage -- the user edited it back.
  ["The sample report mentions a level of practiveity.", "The sample report mentions a level of practicality."],
  // The price of a respelling-aware overlap: a sentence can now be mostly
  // typos and still count as surviving, so the DAMAGE cases have to hold on
  // their own. Neither of these is a respelling of anything -- "Wairdling" is
  // not a word, so nothing explains it.
  ["Weirdling maybe?", "Wairdling maybe?"],
  ["The story has a wairdling tiger beside the toy station.", "The story has a wandering tiger beside the toy station."],
  ["The toy catalogue includes a section on incendiaries.", "The toy catalogue includes a section on incinerations."],
  ["I do agree with the proposal.", "I don't agree with the proposal."],
  ["We can ship it on Friday.", "We can't ship it on Friday."],
  // The price of the resegmentation rule, and what keeps it from being paid.
  // These are letter-identical, so nothing about the characters can separate
  // them -- only that BOTH sides are ordinary words, which means the model is
  // not correcting a typo. Both directions, because the rule is symmetric.
  ["She saw the rapist leave the building.", "She saw the therapist leave the building."],
  ["He is a therapist in the same building.", "He is a the rapist in the same building."],
  ["I have a bout of flu this week.", "I have about of flu this week."],
  ["We put the note book on the table.", "We put the notebook on the table."],
  ["The policy is very very strict.", "The policy is very strict."],
  ["The safe sane plan was approved.", "The same plan was approved."],
  // Prefix insertion is allowed; a first-letter SWAP still is not.
  ["The invoice went to the wrong team.", "The invoice sent to the wrong team."],
  ["We reviewed the port this morning.", "We reviewed the support this morning."],
  ["I do agree with the proposal.", "I don't agree with the proposal."],
  ["We use OpenAI for this workflow.", "We use Openai for this workflow."],
  ["Alice signed off on it.", "alice signed off on it."],
  ["The red carpet was rolled out.", "The red car was rolled out."],
  ["Revenue was $1,200 in Q3.", "Revenue was $1,500 in Q3."],
  ["Only Alice approved it.", "Alice only approved it."],
  ["The __init__ method take three arguments.", "The init method takes three arguments."],
  ["It's worth doing properly.", "It is worth doing properly."],
  ["Let's park that for now.", "Let's postpone that for now."],
  ["We can ship it on Friday.", "We can't ship it on Friday."],
  ["Send the IDs over when you can.", "Send the Ids over when you can."],
  ["The iPhone build is broken.", "The Iphone build is broken."],
  // A gap in `data/words-en.txt` is a licence to substitute, not just a missed
  // correction. The dictionary rule refuses a real word -> real word swap, so a
  // word the list happens to OMIT is not protected by it: "scalable" was absent
  // while "salable" was present, which made the swap read as an ordinary typo
  // fix at distance 1 and it applied silently. Measured on real Discord typing:
  // five of the eleven unlisted words users actually typed had a listed word one
  // edit away. These pin the three that were verified applying before the words
  // were added, so a future prune of the list cannot quietly reopen it.
  ["We need a scalable answer to this.", "We need a salable answer to this."],
  ["That reads unclearly to me.", "That reads uncleanly to me."],
  ["The deployable artifact is ready.", "The deplorable artifact is ready."],
];
let miss = 0, leak = 0, unexpected = 0;
console.log("\nOrdinary typo corrections vs the output guards\n" + "=".repeat(72));
console.log("\n=== should apply, but refused ===");
for (const [a, b] of should) {
  const g = guardSentenceResult(a, b);
  if (g) { miss++; console.log(`  ${g.padEnd(26)} ${JSON.stringify(a)}\n  ${" ".repeat(26)} -> ${JSON.stringify(b)}`); }
}
console.log(`\n${should.length - miss}/${should.length} ordinary corrections apply\n`);
console.log("\n=== documented refusals that unexpectedly applied ===");
for (const [a, b] of knownRefused) {
  const g = guardSentenceResult(a, b);
  if (!g) { unexpected++; console.log(`  NOW APPLIES ${JSON.stringify(a)}`); }
}
console.log(`\n${knownRefused.length - unexpected}/${knownRefused.length} still refused as documented\n`);

console.log("=== must refuse, but applied ===");
for (const [a, b] of mustRefuse) {
  const g = guardSentenceResult(a, b);
  if (!g) { leak++; console.log(`  LEAK ${JSON.stringify(a)} -> ${JSON.stringify(b)}`); }
}
console.log(`\n${mustRefuse.length - leak}/${mustRefuse.length} damage cases refused`);

// A leak is a silent bad edit in someone's text and fails outright. Recall is
// held at the measured level so a guard change cannot quietly trade it away.
// No slack in either direction. An earlier version allowed one of `should` to
// fail, so the suite printed "24/25" and "All checks passed" on the same
// screen -- and the case it was tolerating was the one the commit message
// claimed to have fixed. A case that is expected to refuse belongs in
// knownRefused, where it is asserted, not in a tolerance.
console.log("\n" + "=".repeat(72));
if (miss) console.log(`FAIL: ${miss} ordinary correction(s) refused`);
if (leak) console.log(`FAIL: ${leak} damage case(s) leaked through`);
if (unexpected) console.log(`FAIL: ${unexpected} documented refusal(s) now apply -- re-check the reason`);
const bad = miss + leak + unexpected;
if (!bad) console.log(`All checks passed (${should.length} apply, ${mustRefuse.length} refuse, ${knownRefused.length} documented).`);
process.exit(bad ? 1 : 0);
