#!/usr/bin/env node
// Proofer LLM holdout test set
// 50 NEW sentences never used for prompt tuning. Tests genuine generalization.
// IMPORTANT: No overlap with proofer-test.mjs cases or prompt examples.

// Model, Ollama URL and sampling options live in lib/harness.mjs and are
// overridable with PROOFER_MODEL / PROOFER_OPTIONS — see TESTING.md.
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

// The prompt is read from background.js so this always tests production.
const latency = createLatencyTracker();


// --- Holdout test cases ---
// None of these sentences, error words, or patterns appear in the training set or prompt examples.
const ALL_TESTS = [
  // === Typos (1-10) — different misspellings than training set ===
  { input: "The goverment passed a new law.", expected: "The government passed a new law.", category: "typo", description: "goverment → government" },
  { input: "She showed great commtiment to the project.", expected: "She showed great commitment to the project.", category: "typo", description: "commtiment → commitment" },
  { input: "The enviroment needs protection.", expected: "The environment needs protection.", category: "typo", description: "enviroment → environment" },
  { input: "We had a wonderfull time at the party.", expected: "We had a wonderful time at the party.", category: "typo", description: "wonderfull → wonderful" },
  { input: "His arguement was unconvincing.", expected: "His argument was unconvincing.", category: "typo", description: "arguement → argument" },
  { input: "The calender shows a holiday next week.", expected: "The calendar shows a holiday next week.", category: "typo", description: "calender → calendar" },
  { input: "We reached a concensus on the plan.", expected: "We reached a consensus on the plan.", category: "typo", description: "concensus → consensus" },
  { input: "The libary closes at nine.", expected: "The library closes at nine.", category: "typo", description: "libary → library" },
  { input: "She maintaned her composure throughout.", expected: "She maintained her composure throughout.", category: "typo", description: "maintaned → maintained" },
  // "judgement" is standard British spelling and the system prompt specifies no
  // dialect, so leaving it alone is equally correct.
  { input: "The judgement was fair.", expected: "The judgment was fair.", accepted: ["The judgement was fair."], category: "typo", description: "judgement → judgment (either spelling accepted)" },

  // === Word boundary errors (11-17) — different splits than training set ===
  { input: "We mustnt forget the deadline.", expected: "We mustn't forget the deadline.", category: "word-boundary", description: "mustnt → mustn't" },
  { input: "They wantto leave early today.", expected: "They want to leave early today.", category: "word-boundary", description: "wantto → want to" },
  { input: "The car brokedown on the highway.", expected: "The car broke down on the highway.", category: "word-boundary", description: "brokedown → broke down" },
  { input: "I forgot tobring my umbrella.", expected: "I forgot to bring my umbrella.", category: "word-boundary", description: "tobring → to bring" },
  // Was categorised "word-boundary" with expected === input, which made it
  // mathematically unpassable: unchanged scored MISSED_ERROR, and any change
  // scored BAD_CORRECTION because inputDist is 0. It capped the holdout at
  // 54/55 = 98.2%. It is a clean case and is now labelled as one.
  { input: "She was in favor of the new rule.", expected: "She was in favor of the new rule.", category: "wrong-word-clean", description: "in favor already correctly split — must not change" },
  { input: "He always shows uplate to meetings.", expected: "He always shows up late to meetings.", category: "word-boundary", description: "uplate → up late" },
  { input: "We needto talk about this later.", expected: "We need to talk about this later.", category: "word-boundary", description: "needto → need to" },

  // === Missing letters (18-23) ===
  { input: "The managar approved the budget.", expected: "The manager approved the budget.", category: "missing-letter", description: "managar → manager" },
  { input: "Please clik the submit button.", expected: "Please click the submit button.", category: "missing-letter", description: "clik → click" },
  { input: "The computr froze during the update.", expected: "The computer froze during the update.", category: "missing-letter", description: "computr → computer" },
  { input: "We hav enough supplies for now.", expected: "We have enough supplies for now.", category: "missing-letter", description: "hav → have" },
  { input: "The custmer service was excellent.", expected: "The customer service was excellent.", category: "missing-letter", description: "custmer → customer" },
  { input: "Send the inviation by tomorrow.", expected: "Send the invitation by tomorrow.", category: "missing-letter", description: "inviation → invitation" },

  // === Duplicate words (24-27) ===
  { input: "Please make make sure it works.", expected: "Please make sure it works.", category: "duplicate", description: "make make → make" },
  { input: "We have have a problem here.", expected: "We have a problem here.", category: "duplicate", description: "have have → have" },
  { input: "The report was was submitted on time.", expected: "The report was submitted on time.", category: "duplicate", description: "was was → was" },
  { input: "I think think we should wait.", expected: "I think we should wait.", category: "duplicate", description: "think think → think" },

  // === Wrong word (28-33) ===
  { input: "The whether looks good for Saturday.", expected: "The weather looks good for Saturday.", category: "wrong-word", description: "whether → weather" },
  { input: "He past the exam on his first try.", expected: "He passed the exam on his first try.", category: "wrong-word", description: "past → passed" },
  { input: "They excepted the offer immediately.", expected: "They accepted the offer immediately.", category: "wrong-word", description: "excepted → accepted" },
  { input: "The team lead gave good advise.", expected: "The team lead gave good advice.", category: "wrong-word", description: "advise → advice (noun)" },
  { input: "She was quite discrete about it.", expected: "She was quite discreet about it.", category: "wrong-word", description: "discrete → discreet" },
  { input: "The brake system needs an upgrade.", expected: "The brake system needs an upgrade.", category: "wrong-word-clean", description: "brake is correct here (not break)" },

  // === Missing words (34-37) ===
  { input: "She working on the presentation.", expected: "She is working on the presentation.", category: "missing-word", description: "missing 'is'" },
  { input: "They went the concert last night.", expected: "They went to the concert last night.", category: "missing-word", description: "missing 'to'" },
  { input: "I forgot bring my laptop.", expected: "I forgot to bring my laptop.", category: "missing-word", description: "missing 'to'" },
  { input: "He been waiting for an hour.", expected: "He has been waiting for an hour.", category: "missing-word", description: "missing 'has'" },

  // === Mixed errors (38-42) ===
  { input: "The compny wil anounce the desicion tommorow.", expected: "The company will announce the decision tomorrow.", category: "mixed", description: "compny→company, wil→will, anounce→announce, desicion→decision, tommorow→tomorrow" },
  { input: "Plese confrim your atendance.", expected: "Please confirm your attendance.", category: "mixed", description: "Plese→Please, confrim→confirm, atendance→attendance" },
  { input: "The managment team will will revew the proposal.", expected: "The management team will review the proposal.", category: "mixed", description: "managment→management, will will→will, revew→review" },
  { input: "We shuld upgarde the the sofware.", expected: "We should upgrade the software.", category: "mixed", description: "shuld→should, upgarde→upgrade, the the→the, sofware→software" },
  { input: "Ther are severl importent changes.", expected: "There are several important changes.", category: "mixed", description: "Ther→There, severl→several, importent→important" },

  // === Clean sentences (43-50) — should return no suggestions ===
  { input: "The quarterly report has been finalized.", expected: "The quarterly report has been finalized.", category: "clean", description: "correct sentence" },
  { input: "She graduated with honors last spring.", expected: "She graduated with honors last spring.", category: "clean", description: "correct sentence" },
  { input: "The infrastructure upgrade is on schedule.", expected: "The infrastructure upgrade is on schedule.", category: "clean", description: "correct sentence" },
  { input: "Please forward the email to the team.", expected: "Please forward the email to the team.", category: "clean", description: "correct sentence" },
  { input: "The database migration completed without issues.", expected: "The database migration completed without issues.", category: "clean", description: "correct sentence" },
  { input: "He submitted his resignation yesterday.", expected: "He submitted his resignation yesterday.", category: "clean", description: "correct sentence" },
  { input: "The client approved the final design.", expected: "The client approved the final design.", category: "clean", description: "correct sentence" },
  { input: "We have a meeting at two o'clock.", expected: "We have a meeting at two o'clock.", category: "clean", description: "correct sentence" },

  // === Preference/synonym words — must NOT be changed (51-55) ===
  { input: "The committee shall convene at noon.", expected: "The committee shall convene at noon.", category: "clean", description: "preference word: shall/convene (not will/meet)" },
  { input: "He demonstrated considerable expertise.", expected: "He demonstrated considerable expertise.", category: "clean", description: "preference word: considerable (not significant)" },
  { input: "The endeavor proved worthwhile in the end.", expected: "The endeavor proved worthwhile in the end.", category: "clean", description: "preference word: endeavor (not effort)" },
  { input: "They furnished us with the necessary documents.", expected: "They furnished us with the necessary documents.", category: "clean", description: "preference word: furnished (not provided)" },
  { input: "The subsequent analysis confirmed our hypothesis.", expected: "The subsequent analysis confirmed our hypothesis.", category: "clean", description: "preference word: subsequent (not following)" },
];

// PROOFER_LIMIT truncates the run for harness smoke tests.
// One sentence per case, as the product sends them (the manual path this suite
// was written for was removed on 2026-09-24; see proofer-test.mjs).
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
  console.log(`\nProofer LLM HOLDOUT Test`);
  console.log(configBanner(TESTS, SENTENCE_TESTS));
  console.log(`Pipeline: the sentence request from background.js, guards applied`
    + ` (${SKIPPED.length} of ${ALL_TESTS.length} cases skipped: not one sentence)`);
  console.log(`Tests: ${TESTS.length} (none used for prompt tuning)`);
  console.log(`${"=".repeat(80)}\n`);
  const suiteStarted = performance.now();

  const results = { PASS: 0, PARTIAL: 0, FAIL: 0 };
  const byCategory = {};
  const failures = [];
  const antiPatterns = { FALSE_POSITIVE: 0, MISSED_ERROR: 0, BAD_CORRECTION: 0, CONTRACT_FAIL: 0, CONTRACTION_STYLE: 0 };

  for (let i = 0; i < TESTS.length; i++) {
    const test = TESTS[i];
    const num = String(i + 1).padStart(3);
    process.stdout.write(`[${num}/${TESTS.length}] ${test.category.padEnd(18)} ${test.description.slice(0, 40).padEnd(40)} `);

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
      failures.push({ num: i + 1, test, corrected: eval_.corrected, issues: eval_.issues });
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`HOLDOUT SUMMARY`);
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

  writeResultJson({
    suite: "proofer-holdout",
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

main().catch(e => { console.error(e); process.exit(1); });
