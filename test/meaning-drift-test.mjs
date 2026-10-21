#!/usr/bin/env node
// Meaning-drift probe (40 cases).
//
// The core and holdout suites ask "did it fix the error?". This asks the
// opposite question: "did it fix ONLY the error?" Every case here has a typo
// whose minimal correction is obvious to a human, sitting next to something the
// model must NOT touch — a negation, a hedge, a quantifier, a proper noun, or a
// second reading the typo could plausibly support.
//
// A model that rewrites the sentence to fit its own reading scores well on the
// other suites (the typo does get fixed) while quietly changing what the user
// said. That is the failure this measures.
//
//   node meaning-drift-test.mjs
//   PROOFER_MODEL=qwen3.5:9b node meaning-drift-test.mjs
//
// Scoring is exact-match against a hand-written set of acceptable minimal
// corrections, normalised for smart quotes and whitespace. Failures are split
// into UNFIXED (returned the input untouched) and DRIFT (changed something it
// should not have), because the two call for opposite remedies.

import { pathToFileURL } from "url";
import {
  MODEL,
  OPTIONS,
  applyLimit,
  configBanner,
  createLatencyTracker,
  formatLatencyReport,
  writeResultJson,
} from "./lib/harness.mjs";
import { callSentence, singleSentenceCases, asciify, isContractionStyleOnly, formatSentenceOutcomes } from "./lib/scoring.mjs";

const latency = createLatencyTracker();

// Each case: { input, acceptable[], category, protects }
// "protects" names the thing the model must carry through untouched — it is
// what the failure report prints, so a drift is legible without re-reading the
// sentence.
export const ALL_TESTS = [
  // --- Homophones fixed by context. One word changes; nothing else may. ---
  { input: "Their going to be late again.", acceptable: ["They're going to be late again."], category: "homophone", protects: "late again" },
  { input: "The server lost it's connection.", acceptable: ["The server lost its connection."], category: "homophone", protects: "server/connection" },
  { input: "I have know idea what happened.", acceptable: ["I have no idea what happened."], category: "homophone", protects: "what happened" },
  { input: "I cant here you on the call.", acceptable: ["I can't hear you on the call."], category: "homophone", protects: "negation + on the call" },
  { input: "We loose about two hours a week to this.", acceptable: ["We lose about two hours a week to this."], category: "homophone", protects: "about two hours a week" },
  { input: "She ate the hole thing.", acceptable: ["She ate the whole thing."], category: "homophone", protects: "she ate" },
  { input: "I was board for most of the talk.", acceptable: ["I was bored for most of the talk."], category: "homophone", protects: "most of the talk" },
  { input: "This is worse then last quarter.", acceptable: ["This is worse than last quarter."], category: "homophone", protects: "worse, last quarter" },
  { input: "The change had no affect on latency.", acceptable: ["The change had no effect on latency."], category: "homophone", protects: "no (negation)" },
  { input: "We sent to many reminders.", acceptable: ["We sent too many reminders."], category: "homophone", protects: "sent, reminders" },

  // --- Typos with more than one plausible expansion. Any minimal reading is
  // fine; inventing a new sentence is not. ---
  { input: "Can you send me the fiel?", acceptable: ["Can you send me the file?", "Can you send me the field?"], category: "ambiguous", protects: "sentence shape" },
  { input: "testing testing tsting", acceptable: ["testing testing testing", "Testing testing testing.", "testing testing testing."], category: "ambiguous", protects: "three words" },
  { input: "The manger approved the budget.", acceptable: ["The manager approved the budget."], category: "ambiguous", protects: "approved the budget" },
  { input: "We ran the trail again with new data.", acceptable: ["We ran the trial again with new data.", "We ran the trail again with new data."], category: "ambiguous", protects: "again with new data" },
  { input: "Please chose one of the options.", acceptable: ["Please choose one of the options."], category: "ambiguous", protects: "one of the options" },
  { input: "He sent the form to the wrong adress.", acceptable: ["He sent the form to the wrong address."], category: "ambiguous", protects: "form (not 'from')" },
  { input: "The deploy failed becuase of the migration.", acceptable: ["The deploy failed because of the migration."], category: "ambiguous", protects: "deploy, migration" },
  { input: "I recieved you're message.", acceptable: ["I received your message."], category: "ambiguous", protects: "first person, past tense" },

  // --- Negations. Dropping or flipping one inverts the sentence. ---
  { input: "We cant ship this on Friday.", acceptable: ["We can't ship this on Friday."], category: "negation", protects: "cannot" },
  { input: "The tests are not passing yet, so we should waite.", acceptable: ["The tests are not passing yet, so we should wait."], category: "negation", protects: "not passing" },
  { input: "I dont think thats a good idea.", acceptable: ["I don't think that's a good idea."], category: "negation", protects: "don't think" },
  { input: "Nothing was lost in the migraton.", acceptable: ["Nothing was lost in the migration."], category: "negation", protects: "nothing" },
  { input: "She never recieved the invite.", acceptable: ["She never received the invite."], category: "negation", protects: "never" },
  { input: "This wont work without the token.", acceptable: ["This won't work without the token."], category: "negation", protects: "won't, without" },

  // --- Quantifiers and numbers. These must survive verbatim. ---
  { input: "Only 3 of the 12 servers recieved the update.", acceptable: ["Only 3 of the 12 servers received the update."], category: "quantifier", protects: "only, 3, 12" },
  { input: "At least half the team was'nt notified.", acceptable: ["At least half the team wasn't notified."], category: "quantifier", protects: "at least half" },
  { input: "We saw a 12% drop, not a 12x drop.", acceptable: ["We saw a 12% drop, not a 12x drop."], category: "quantifier", protects: "12% vs 12x (clean)" },
  { input: "Up to five people can join the call.", acceptable: ["Up to five people can join the call."], category: "quantifier", protects: "up to (clean)" },
  { input: "The limit is 100 requests per minit.", acceptable: ["The limit is 100 requests per minute."], category: "quantifier", protects: "100 requests" },

  // --- Hedges. Models like to promote "might" to "will". ---
  { input: "I think we might be able to finish by Friday.", acceptable: ["I think we might be able to finish by Friday."], category: "hedge", protects: "think, might (clean)" },
  { input: "This could possibly be a race conditon.", acceptable: ["This could possibly be a race condition."], category: "hedge", protects: "could possibly" },
  { input: "It seems like the cache is stale, but Im not sure.", acceptable: ["It seems like the cache is stale, but I'm not sure."], category: "hedge", protects: "seems, not sure" },
  { input: "We probably shouldnt merge this yet.", acceptable: ["We probably shouldn't merge this yet."], category: "hedge", protects: "probably, yet" },
  { input: "Maybe we should wate for the review.", acceptable: ["Maybe we should wait for the review."], category: "hedge", protects: "maybe, should" },

  // --- Jargon and proper nouns sitting next to a typo. ---
  { input: "The kubernetes pod was evicted becuase of memory pressure.", acceptable: ["The kubernetes pod was evicted because of memory pressure.", "The Kubernetes pod was evicted because of memory pressure."], category: "jargon", protects: "pod, evicted, memory pressure" },
  { input: "Ping Sanjay about the Grafana dashbord.", acceptable: ["Ping Sanjay about the Grafana dashboard."], category: "jargon", protects: "Sanjay, Grafana" },
  { input: "The postgres replica fell behind agian.", acceptable: ["The postgres replica fell behind again.", "The Postgres replica fell behind again."], category: "jargon", protects: "replica fell behind" },
  { input: "We use nginx as a reverse proxy infront of the app.", acceptable: ["We use nginx as a reverse proxy in front of the app.", "We use Nginx as a reverse proxy in front of the app."], category: "jargon", protects: "nginx, reverse proxy" },
  { input: "The regex didnt match the utf-8 input.", acceptable: ["The regex didn't match the utf-8 input.", "The regex didn't match the UTF-8 input."], category: "jargon", protects: "regex, utf-8" },
  { input: "Run npm run buld before the deploy.", acceptable: ["Run npm run build before the deploy."], category: "jargon", protects: "npm run" },
];

const norm = (s) => asciify(String(s)).replace(/\s+/g, " ").trim();

function judge(test, got) {
  if (got === null) return { verdict: "ERROR", detail: "no usable response" };
  const g = norm(got);
  if (test.acceptable.some((a) => norm(a) === g)) return { verdict: "PASS" };
  // "They're" -> "They are" is a style choice, not a change of meaning. The
  // other suites already treat it that way; so does this one.
  if (test.acceptable.some((a) => isContractionStyleOnly(got, a))) return { verdict: "PASS" };
  if (g === norm(test.input)) return { verdict: "UNFIXED", detail: "returned unchanged" };
  return { verdict: "DRIFT", detail: `must preserve: ${test.protects}` };
}

async function main() {
  // One sentence per case, through the sentence pipeline (the manual path this
  // probe was written for was removed on 2026-09-24; see proofer-test.mjs).
  const { kept, skipped } = singleSentenceCases(ALL_TESTS);
  const TESTS = applyLimit(kept);
  console.log(`\nMeaning-drift probe`);
  console.log(configBanner(TESTS, kept));
  console.log(`Pipeline: the sentence request from background.js, guards applied`
    + ` (${skipped.length} of ${ALL_TESTS.length} cases skipped: not one sentence)`);

  const results = [];
  for (const test of TESTS) {
    const got = (await callSentence(test.input, { latency })).text;
    results.push({ test, got, ...judge(test, got) });
  }

  const by = (v) => results.filter((r) => r.verdict === v);
  const pass = by("PASS").length;
  const drift = by("DRIFT");
  const unfixed = by("UNFIXED");

  for (const r of [...drift, ...unfixed, ...by("ERROR")]) {
    console.log(`\n[${r.verdict}] ${r.test.category}`);
    console.log(`  Input: ${JSON.stringify(r.test.input)}`);
    console.log(`  Got:   ${JSON.stringify(r.got)}`);
    console.log(`  Want:  ${r.test.acceptable.map((a) => JSON.stringify(a)).join(" | ")}`);
    if (r.detail) console.log(`  Note:  ${r.detail}`);
  }

  const cats = [...new Set(ALL_TESTS.map((t) => t.category))];
  console.log(`\nBy category:`);
  for (const c of cats) {
    const rs = results.filter((r) => r.test.category === c);
    if (!rs.length) continue;
    const p = rs.filter((r) => r.verdict === "PASS").length;
    console.log(`  ${c.padEnd(12)} ${String(p).padStart(2)}/${String(rs.length).padEnd(2)}  drift ${rs.filter((r) => r.verdict === "DRIFT").length}  unfixed ${rs.filter((r) => r.verdict === "UNFIXED").length}`);
  }

  console.log(formatLatencyReport(latency.stats()));
  console.log(formatSentenceOutcomes());
  console.log("\n" + "=".repeat(80));
  console.log(`Final: ${((pass / results.length) * 100).toFixed(1)}% preserved (${pass}/${results.length})  —  ${drift.length} drift, ${unfixed.length} unfixed`);

  writeResultJson({
    suite: "meaning-drift",
    model: MODEL,
    total: results.length,
    pass,
    drift: drift.length,
    unfixed: unfixed.length,
    failures: [...drift, ...unfixed].map((r) => ({ input: r.test.input, got: r.got, category: r.test.category, verdict: r.verdict })),
  });
}

// ALL_TESTS is exported for the contamination checker, which must be able to
// import this file without firing 40 Ollama calls.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
