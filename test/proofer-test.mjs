#!/usr/bin/env node
// Proofer LLM prompt test harness
// Sends broken/clean sentences to Ollama and judges correction quality.
//
// Since 2026-09-24 every case goes through the SENTENCE pipeline -- the request
// background.js actually sends, and the guards it actually applies (see
// callSentence in lib/scoring.mjs). This suite was written against the manual
// rewrite path, which the beta removed; the cases that are one sentence were
// ported, the rest are reported as skipped. Numbers from before that date
// measured a different prompt and are not comparable.

// Model, Ollama URL and sampling options live in lib/harness.mjs and are
// overridable with PROOFER_MODEL / PROOFER_OPTIONS — see TESTING.md.
import { pathToFileURL } from "url";
import {
  MODEL,
  OLLAMA_URL,
  OPTIONS,
  applyLimit,
  configBanner,
  createLatencyTracker,
  formatLatencyReport,
  writeResultJson,
} from "./lib/harness.mjs";
import { callSentence, singleSentenceCases, evaluate, formatSentenceOutcomes } from "./lib/scoring.mjs";

const latency = createLatencyTracker();

// --- Test cases ---
// Each: { input, expected, category, description }
// "expected" is the corrected text after applying ALL valid suggestions.
// For clean sentences, expected === input.
// Exported so prompt-lab.mjs can tune against this corpus (the designated
// tuning set). The holdout stays unexported and untouched by tuning.
export const ALL_TESTS = [
  // === Simple typos (1-20) ===
  { input: "I went to teh store yesterday.", expected: "I went to the store yesterday.", category: "typo", description: "teh → the" },
  { input: "She was veyr happy about it.", expected: "She was very happy about it.", category: "typo", description: "veyr → very" },
  { input: "The meeting is schedlued for Monday.", expected: "The meeting is scheduled for Monday.", category: "typo", description: "schedlued → scheduled" },
  { input: "Please reveiw the document.", expected: "Please review the document.", category: "typo", description: "reveiw → review" },
  { input: "We need to adress this issue.", expected: "We need to address this issue.", category: "typo", description: "adress → address" },
  { input: "The progam crashed again.", expected: "The program crashed again.", category: "typo", description: "progam → program" },
  { input: "He recieved the package today.", expected: "He received the package today.", category: "typo", description: "recieved → received" },
  { input: "Can you explian this to me?", expected: "Can you explain this to me?", category: "typo", description: "explian → explain" },
  { input: "The restuarant was closed.", expected: "The restaurant was closed.", category: "typo", description: "restuarant → restaurant" },
  { input: "That is definately wrong.", expected: "That is definitely wrong.", category: "typo", description: "definately → definitely" },
  { input: "I will probaly be late.", expected: "I will probably be late.", category: "typo", description: "probaly → probably" },
  { input: "The seperate files need merging.", expected: "The separate files need merging.", category: "typo", description: "seperate → separate" },
  { input: "This is an independant decision.", expected: "This is an independent decision.", category: "typo", description: "independant → independent" },
  { input: "Please accomodate our request.", expected: "Please accommodate our request.", category: "typo", description: "accomodate → accommodate" },
  { input: "The occurance was unexpected.", expected: "The occurrence was unexpected.", category: "typo", description: "occurance → occurrence" },

  // === Word boundary errors (16-25) ===
  { input: "Can the model wit ha wooden roof cross bridges?", expected: "Can the model with a wooden roof cross bridges?", category: "word-boundary", description: "wit ha → with a" },
  // The rubric expectation leaves "be default" (non-English) in place, so a
  // model that also fixes it to "by default" was being failed for being right.
  { input: "Usually the ysee the blue toy train be default.", expected: "Usually they see the blue toy train be default.", accepted: ["Usually they see the blue toy train by default."], category: "word-boundary", description: "the ysee → they see" },
  { input: "I donot think that is correct.", expected: "I do not think that is correct.", category: "word-boundary", description: "donot → do not" },
  { input: "We shouldof gone earlier.", expected: "We should have gone earlier.", category: "word-boundary", description: "shouldof → should have" },
  { input: "It hasto be done by Friday.", expected: "It has to be done by Friday.", category: "word-boundary", description: "hasto → has to" },
  { input: "Can you setup the meeting?", expected: "Can you set up the meeting?", category: "word-boundary", description: "setup → set up (verb)" },
  { input: "I can not belive it worked.", expected: "I cannot believe it worked.", category: "word-boundary", description: "can not belive → cannot believe" },
  { input: "She some times forgets her keys.", expected: "She sometimes forgets her keys.", category: "word-boundary", description: "some times → sometimes" },
  { input: "That is al ot of work.", expected: "That is a lot of work.", category: "word-boundary", description: "al ot → a lot" },
  { input: "He went a head without asking.", expected: "He went ahead without asking.", category: "word-boundary", description: "a head → ahead" },

  // === Missing letters (26-35) ===
  { input: "The defaut setting is fine.", expected: "The default setting is fine.", category: "missing-letter", description: "defaut → default" },
  { input: "Please chek the configuration.", expected: "Please check the configuration.", category: "missing-letter", description: "chek → check" },
  { input: "The databse needs updating.", expected: "The database needs updating.", category: "missing-letter", description: "databse → database" },
  { input: "We shoud fix this soon.", expected: "We should fix this soon.", category: "missing-letter", description: "shoud → should" },
  { input: "The pasword was incorrect.", expected: "The password was incorrect.", category: "missing-letter", description: "pasword → password" },
  { input: "Submit the requst by noon.", expected: "Submit the request by noon.", category: "missing-letter", description: "requst → request" },
  { input: "The mesage was delivered.", expected: "The message was delivered.", category: "missing-letter", description: "mesage → message" },
  { input: "Check the documnt for errors.", expected: "Check the document for errors.", category: "missing-letter", description: "documnt → document" },
  { input: "The serach returned no results.", expected: "The search returned no results.", category: "missing-letter", description: "serach → search" },
  { input: "Update the confguration file.", expected: "Update the configuration file.", category: "missing-letter", description: "confguration → configuration" },

  // === Extra letters (36-42) ===
  { input: "I will do it whenn I can.", expected: "I will do it when I can.", category: "extra-letter", description: "whenn → when" },
  { input: "The systemm is running smoothly.", expected: "The system is running smoothly.", category: "extra-letter", description: "systemm → system" },
  { input: "Please waitt for the response.", expected: "Please wait for the response.", category: "extra-letter", description: "waitt → wait" },
  { input: "The reesult looks correct.", expected: "The result looks correct.", category: "extra-letter", description: "reesult → result" },
  { input: "Checkk the logs for errors.", expected: "Check the logs for errors.", category: "extra-letter", description: "Checkk → Check" },
  { input: "The filees are too large.", expected: "The files are too large.", category: "extra-letter", description: "filees → files" },
  { input: "We neeed more time.", expected: "We need more time.", category: "extra-letter", description: "neeed → need" },

  // === Duplicated words (43-50) ===
  { input: "I went to the the store.", expected: "I went to the store.", category: "duplicate", description: "the the → the" },
  { input: "She said said it was fine.", expected: "She said it was fine.", category: "duplicate", description: "said said → said" },
  { input: "Please review the the document carefully.", expected: "Please review the document carefully.", category: "duplicate", description: "the the → the" },
  { input: "We need to to fix this.", expected: "We need to fix this.", category: "duplicate", description: "to to → to" },
  { input: "The system is is working now.", expected: "The system is working now.", category: "duplicate", description: "is is → is" },
  { input: "I can can help you with that.", expected: "I can help you with that.", category: "duplicate", description: "can can → can" },
  { input: "It was was a good meeting.", expected: "It was a good meeting.", category: "duplicate", description: "was was → was" },
  { input: "They are are coming tomorrow.", expected: "They are coming tomorrow.", category: "duplicate", description: "are are → are" },

  // === Wrong word (51-60) ===
  { input: "Their going to the park.", expected: "They're going to the park.", category: "wrong-word", description: "Their → They're" },
  { input: "I should of known better.", expected: "I should have known better.", category: "wrong-word", description: "of → have" },
  { input: "The affect was immediate.", expected: "The effect was immediate.", category: "wrong-word", description: "affect → effect (noun)" },
  { input: "Your the best person for this.", expected: "You're the best person for this.", category: "wrong-word", description: "Your → You're" },
  { input: "I could care less about it.", expected: "I couldn't care less about it.", category: "wrong-word", description: "could → couldn't" },
  { input: "We need to go their first.", expected: "We need to go there first.", category: "wrong-word", description: "their → there" },
  { input: "Its a beautiful day outside.", expected: "It's a beautiful day outside.", category: "wrong-word", description: "Its → It's" },
  { input: "The principle approved the plan.", expected: "The principal approved the plan.", category: "wrong-word", description: "principle → principal" },
  { input: "I want to loose some weight.", expected: "I want to lose some weight.", category: "wrong-word", description: "loose → lose" },
  { input: "Who's book is this?", expected: "Whose book is this?", category: "wrong-word", description: "Who's → Whose" },

  // === Transposed letters (61-67) ===
  { input: "He is my freind.", expected: "He is my friend.", category: "transposed", description: "freind → friend" },
  { input: "The buiding is tall.", expected: "The building is tall.", category: "transposed", description: "buiding → building" },
  { input: "I need a peice of paper.", expected: "I need a piece of paper.", category: "transposed", description: "peice → piece" },
  { input: "The wierd noise continued.", expected: "The weird noise continued.", category: "transposed", description: "wierd → weird" },
  { input: "She beleives in fairness.", expected: "She believes in fairness.", category: "transposed", description: "beleives → believes" },
  { input: "The acheive button is broken.", expected: "The achieve button is broken.", category: "transposed", description: "acheive → achieve" },
  { input: "We reccomend this approach.", expected: "We recommend this approach.", category: "transposed", description: "reccomend → recommend" },

  // === Missing words (68-73) ===
  { input: "I going to the store.", expected: "I am going to the store.", category: "missing-word", description: "missing 'am'" },
  { input: "She been working all day.", expected: "She has been working all day.", category: "missing-word", description: "missing 'has'" },
  { input: "The report due tomorrow.", expected: "The report is due tomorrow.", category: "missing-word", description: "missing 'is'" },
  { input: "We need finish this today.", expected: "We need to finish this today.", category: "missing-word", description: "missing 'to'" },
  { input: "He went the store.", expected: "He went to the store.", category: "missing-word", description: "missing 'to'" },
  // "Can you give a hand?" is idiomatic English as written; inserting "me" is a
  // valid edit but not a required one.
  { input: "Can you give a hand?", expected: "Can you give me a hand?", accepted: ["Can you give a hand?"], category: "missing-word", description: "missing 'me' (leaving it is also valid)" },

  // === Extra words (74-78) ===
  // A double negative can be repaired from either side; both models produced
  // "I did not say that." and were failed for it.
  { input: "I did not never said that.", expected: "I never said that.", accepted: ["I did not say that.", "I never say that."], category: "extra-word", description: "double negative — either repair accepted" },
  { input: "She is is very talented.", expected: "She is very talented.", category: "extra-word", description: "is is → is" },
  { input: "The the cat sat on the mat.", expected: "The cat sat on the mat.", category: "extra-word", description: "The the → The" },
  { input: "I want to to go home.", expected: "I want to go home.", category: "extra-word", description: "to to → to" },
  { input: "Please do not not worry.", expected: "Please do not worry.", category: "extra-word", description: "not not → not" },

  // === Mixed errors (79-85) ===
  { input: "I dont thnk its going to wrk.", expected: "I don't think it's going to work.", category: "mixed", description: "dont→don't, thnk→think, its→it's, wrk→work" },
  { input: "Ther are to many erors here.", expected: "There are too many errors here.", category: "mixed", description: "Ther→There, to→too, erors→errors" },
  { input: "We shoud definately reveiw this.", expected: "We should definitely review this.", category: "mixed", description: "shoud→should, definately→definitely, reveiw→review" },
  { input: "The progam has a a bug in teh code.", expected: "The program has a bug in the code.", category: "mixed", description: "progam→program, a a→a, teh→the" },
  { input: "Pleese chek youre email adress.", expected: "Please check your email address.", category: "mixed", description: "Pleese→Please, chek→check, youre→your, adress→address" },
  { input: "I recieved teh mesage yestarday.", expected: "I received the message yesterday.", category: "mixed", description: "recieved→received, teh→the, mesage→message, yestarday→yesterday" },
  { input: "Can you halp me wit this problam?", expected: "Can you help me with this problem?", category: "mixed", description: "halp→help, wit→with, problam→problem" },

  // === Clean sentences — should return [] (86-100) ===
  { input: "The meeting is scheduled for 3 PM.", expected: "The meeting is scheduled for 3 PM.", category: "clean", description: "correct sentence" },
  { input: "Please review the attached document.", expected: "Please review the attached document.", category: "clean", description: "correct sentence" },
  { input: "I'll be there in five minutes.", expected: "I'll be there in five minutes.", category: "clean", description: "correct sentence" },
  { input: "The system is running smoothly.", expected: "The system is running smoothly.", category: "clean", description: "correct sentence" },
  { input: "She completed the project on time.", expected: "She completed the project on time.", category: "clean", description: "correct sentence" },
  { input: "We need to discuss the budget.", expected: "We need to discuss the budget.", category: "clean", description: "correct sentence" },
  { input: "The results exceeded our expectations.", expected: "The results exceeded our expectations.", category: "clean", description: "correct sentence" },
  { input: "Can you send me the report by Friday?", expected: "Can you send me the report by Friday?", category: "clean", description: "correct sentence" },
  { input: "The server will be down for maintenance.", expected: "The server will be down for maintenance.", category: "clean", description: "correct sentence" },
  { input: "I appreciate your help with this.", expected: "I appreciate your help with this.", category: "clean", description: "correct sentence" },
  { input: "The new feature works as expected.", expected: "The new feature works as expected.", category: "clean", description: "correct sentence" },
  { input: "Let me know if you have any questions.", expected: "Let me know if you have any questions.", category: "clean", description: "correct sentence" },
  { input: "The deadline has been extended to next week.", expected: "The deadline has been extended to next week.", category: "clean", description: "correct sentence" },
  { input: "All tests passed successfully.", expected: "All tests passed successfully.", category: "clean", description: "correct sentence" },
  { input: "Thanks for the update.", expected: "Thanks for the update.", category: "clean", description: "correct sentence" },

  // === Preference/synonym words — must NOT be changed (101-105) ===
  { input: "Given the circumstances, we decided to wait.", expected: "Given the circumstances, we decided to wait.", category: "clean", description: "preference word: circumstances (not situations)" },
  { input: "She provided an adequate explanation.", expected: "She provided an adequate explanation.", category: "clean", description: "preference word: adequate (not sufficient)" },
  { input: "The team utilized the new framework effectively.", expected: "The team utilized the new framework effectively.", category: "clean", description: "preference word: utilized (not used)" },
  { input: "We commenced the project on Monday morning.", expected: "We commenced the project on Monday morning.", category: "clean", description: "preference word: commenced (not started)" },
  { input: "The procedure was quite straightforward.", expected: "The procedure was quite straightforward.", category: "clean", description: "preference word: procedure (not process)" },
];

// One sentence per case, as the product sends them; PROOFER_LIMIT truncates the
// run for harness smoke tests.
const { kept: SENTENCE_TESTS, skipped: SKIPPED } = singleSentenceCases(ALL_TESTS);
const TESTS = applyLimit(SENTENCE_TESTS);

// Sanitization, the Ollama call and the scoring rubric all live in
// lib/scoring.mjs so the suites, prompt-lab.mjs and model-bakeoff.mjs score
// identically. They used to be copy-pasted per suite and had silently
// diverged (this file's evaluate() did not recognise the wrong-word-clean
// category that the holdout uses).

async function callOllama(text) {
  return (await callSentence(text, { latency })).text;
}

// --- Main ---
async function main() {
  console.log(`\nProofer LLM Test Harness`);
  console.log(configBanner(TESTS, SENTENCE_TESTS));
  console.log(`Pipeline: the sentence request from background.js, guards applied`
    + ` (${SKIPPED.length} of ${ALL_TESTS.length} cases skipped: not one sentence)`);
  console.log(`Tests: ${TESTS.length}`);
  console.log(`${"=".repeat(80)}\n`);
  const suiteStarted = performance.now();

  const results = { PASS: 0, PARTIAL: 0, FAIL: 0 };
  const byCategory = {};
  const failures = [];
  const antiPatterns = { FALSE_POSITIVE: 0, MISSED_ERROR: 0, BAD_CORRECTION: 0, CONTRACT_FAIL: 0, CONTRACTION_STYLE: 0 };

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(3);
    process.stdout.write(`[${num}/${TESTS.length}] ${test.category.padEnd(15)} ${test.description.slice(0, 40).padEnd(40)} `);

    let rewritten, eval_;
    try {
      rewritten = await callOllama(test.input);
      eval_ = evaluate(test, rewritten);
    } catch (e) {
      eval_ = { verdict: "FAIL", issues: ["API_ERROR: " + e.message], corrected: test.input };
      rewritten = null;
    }

    results[eval_.verdict]++;

    if (!byCategory[test.category]) byCategory[test.category] = { PASS: 0, PARTIAL: 0, FAIL: 0, total: 0 };
    byCategory[test.category][eval_.verdict]++;
    byCategory[test.category].total++;

    for (const issue of eval_.issues) {
      if (antiPatterns[issue] !== undefined) antiPatterns[issue]++;
    }

    const icon = eval_.verdict === "PASS" ? "OK" : eval_.verdict === "PARTIAL" ? "~~" : "XX";
    console.log(`${icon}${eval_.issues.length ? "  [" + eval_.issues.join(", ") + "]" : ""}`);

    if (eval_.verdict === "FAIL") {
      failures.push({
        num: i + 1,
        test,
        corrected: eval_.corrected,
        issues: eval_.issues,
      });
    }
  }

  // --- Summary ---
  console.log(`\n${"=".repeat(80)}`);
  console.log(`SUMMARY`);
  console.log(`${"=".repeat(80)}`);
  const total = TESTS.length;
  console.log(`PASS:    ${results.PASS}/${total} (${((results.PASS / total) * 100).toFixed(1)}%)`);
  console.log(`PARTIAL: ${results.PARTIAL}/${total} (${((results.PARTIAL / total) * 100).toFixed(1)}%)`);
  console.log(`FAIL:    ${results.FAIL}/${total} (${((results.FAIL / total) * 100).toFixed(1)}%)`);

  console.log(`\nBy category:`);
  for (const [cat, counts] of Object.entries(byCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = ((counts.PASS / counts.total) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(18)} ${counts.PASS}/${counts.total} pass (${pct}%)${counts.PARTIAL ? `, ${counts.PARTIAL} partial` : ""}${counts.FAIL ? `, ${counts.FAIL} fail` : ""}`);
  }

  console.log(`\nAnti-patterns detected:`);
  for (const [name, count] of Object.entries(antiPatterns)) {
    if (count > 0) console.log(`  ${name}: ${count}`);
  }
  if (Object.values(antiPatterns).every(v => v === 0)) console.log(`  None`);

  if (failures.length) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`FAILURE DETAILS (${failures.length} tests)`);
    console.log(`${"=".repeat(80)}`);
    for (const f of failures) {
      console.log(`\n#${f.num} [${f.test.category}] ${f.test.description}`);
      console.log(`  Input:    "${f.test.input}"`);
      console.log(`  Expected: "${f.test.expected}"`);
      console.log(`  Got:      "${f.corrected}"`);
      console.log(`  Issues:   ${f.issues.join(", ")}`);
    }
  }

  const latencyStats = latency.stats();
  console.log(`\n${formatLatencyReport(latencyStats)}`);
  console.log(formatSentenceOutcomes());

  console.log(`\n${"=".repeat(80)}`);
  const passRate = ((results.PASS / total) * 100).toFixed(1);
  const passPartialRate = (((results.PASS + results.PARTIAL) / total) * 100).toFixed(1);
  console.log(`Final: ${passRate}% pass, ${passPartialRate}% pass+partial`);
  // Rate-based so the verdict still holds under PROOFER_LIMIT. The thresholds
  // are the old absolute counts (80 and 70 of 105) expressed as percentages.
  if (Number(passRate) >= 76) console.log(`VERDICT: Prompt is performing well.`);
  else if (Number(passPartialRate) >= 67) console.log(`VERDICT: Prompt needs minor tuning.`);
  else console.log(`VERDICT: Prompt needs significant rework.`);

  writeResultJson({
    suite: "proofer-test",
    total,
    pass: results.PASS,
    partial: results.PARTIAL,
    fail: results.FAIL,
    passRate: Number(passRate),
    passPartialRate: Number(passPartialRate),
    truncated: TESTS.length < SENTENCE_TESTS.length,
    skippedNotOneSentence: SKIPPED.length,
    byCategory,
    antiPatterns,
    latency: latencyStats,
    suiteWallMs: Math.round(performance.now() - suiteStarted),
    failures: failures.map(f => ({
      num: f.num,
      category: f.test.category,
      description: f.test.description,
      input: f.test.input,
      expected: f.test.expected,
      got: f.corrected,
      issues: f.issues,
    })),
  });
}

// Only run when executed directly — prompt-lab.mjs imports ALL_TESTS from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
