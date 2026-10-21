#!/usr/bin/env node
// The sentence retry router: gate, keep-list, prompt derivation, and the
// helper's no-request early exits.
//
// A first-pass guard refusal may earn ONE guard-informed second request (the
// 2026-08-26/27 retry round, "arm B"; reworked 2026-08-28 after audit). The
// load-bearing properties, none visible from any other suite:
//
//   1. The GATE reads the FULL reasons list, not the first reason -- one hard
//      reason (`low-overlap`, `sanitizer-would-change`) anywhere vetoes the
//      retry, exactly because a borderline first reason can conceal a hard one.
//   2. The KEEP-LIST is built from UNEXPLAINED losses only -- contentLost also
//      holds typos the guards paired with their corrections, and a keep-list
//      naming those forfeits the fix on the retry. Restoration to the typed
//      form is unambiguous-only, and an empty keep-list means NO retry.
//   3. The RETRY PROMPT is DERIVED from buildSentenceMessages plus one system
//      line, never restated, with the keeps JSON-encoded (user text in a
//      system turn, same convention as the prior context) and the user turn
//      bare.
//   4. The helper refuses to fetch on an aborted signal, a hard reason, an
//      empty keep-list, or too little remaining budget -- the retry shares the
//      first pass's timeout budget rather than adding a second one.
//
// The handler wiring (two fetches max, fallback, consent, cancellation, the
// record schema) is sentence-retry-handler-test.mjs. The live half -- does the
// retry salvage passengers without laundering hazards -- is the bakeoff
// harness, the gate for any change to the retry PROMPT.
//
//   node sentence-retry-test.mjs

import { readFileSync } from "fs";
import {
  sentenceRetryDecision, sentenceRetryKeepList, buildSentenceRetryMessages,
  SENTENCE_NO_RETRY_REASONS, SENTENCE_RETRY_MIN_BUDGET_MS,
  SENTENCE_RETRY_DELIVERY_CAP_MS, retrySentenceRewrite,
  buildSentenceMessages, guardSentenceReport,
} from "./lib/sentence-guards.mjs";

let pass = 0, fail = 0;
const check = (ok, what) => {
  if (ok) pass++;
  else { fail++; console.log(`  FAIL ${what}`); }
};

// ---------------------------------------------------------------- [1] the gate
{
  console.log("[1] retry decision reads the whole reasons list");
  check(sentenceRetryDecision(["word-substituted:folx"]).retry === true, "a substitution refusal retries");
  check(sentenceRetryDecision(["protected-token"]).retry === true, "protected-token retries");
  check(sentenceRetryDecision(["capital-removed", "terminator-changed"]).retry === true, "two soft reasons retry");
  check(sentenceRetryDecision(["low-overlap"]).retry === false, "low-overlap never retries");
  check(sentenceRetryDecision(["sanitizer-would-change"]).retry === false, "sanitizer-would-change never retries");
  // The pin that matters: a hard reason CONCEALED behind a soft first reason
  // still vetoes. A gate reading only reasons[0] passes every other case in
  // this file and fails exactly here.
  check(sentenceRetryDecision(["word-substituted:x", "low-overlap"]).retry === false,
    "a hard reason behind a soft one vetoes");
  check(sentenceRetryDecision([]).retry === false, "no refusal, no retry");
  check(sentenceRetryDecision(null).retry === false, "malformed reasons, no retry");
  // The no-retry list is a decision, not a convenience: exactly these two.
  check(SENTENCE_NO_RETRY_REASONS.length === 2 &&
    SENTENCE_NO_RETRY_REASONS.includes("low-overlap") &&
    SENTENCE_NO_RETRY_REASONS.includes("sanitizer-would-change"),
    "the no-retry list is exactly the two documented reasons");
  // The budget floor is a real number inside the shared timeout, not a second
  // timeout: it must be positive and clearly smaller than SENTENCE_TIMEOUT_MS.
  check(SENTENCE_RETRY_MIN_BUDGET_MS > 0 && SENTENCE_RETRY_MIN_BUDGET_MS < 20000,
    "the retry budget floor sits inside the shared timeout");
  // The delivery cap mirrors content.js's SENTENCE_MAX_JOB_MS, and the two
  // files must not drift -- same cross-file contract as the warmup lease
  // invariant, extracted from the source the same way.
  const contentSrc = readFileSync(new URL("../content.js", import.meta.url), "utf8");
  const m = contentSrc.match(/SENTENCE_MAX_JOB_MS\s*=\s*(\d+)/);
  check(!!m, "content.js still declares SENTENCE_MAX_JOB_MS");
  check(m && Number(m[1]) === SENTENCE_RETRY_DELIVERY_CAP_MS,
    `the worker's delivery cap equals content's job lease (${m && m[1]} vs ${SENTENCE_RETRY_DELIVERY_CAP_MS})`);
  check(SENTENCE_RETRY_MIN_BUDGET_MS < SENTENCE_RETRY_DELIVERY_CAP_MS,
    "the floor fits inside the delivery cap, so a retry can ever run at all");
}

// ----------------------------------------------------------- [2] the keep-list
{
  console.log("[2] keep-list from synthetic refusal evidence");
  // This invented carrier makes "folx" an unexplained substitution, so the
  // keep must quote it as typed -- terminator and all.
  const input = "The sample label was meant to greet group of folx?";
  const out = "The sample label was meant to greet a group of fixed?";
  const rep = guardSentenceReport(input, out, out, { trigger: null });
  check(rep.reason === "word-substituted:folx", `folx fixture still refuses (got ${rep.reason})`);
  const keeps = sentenceRetryKeepList(rep.evidence, input);
  check(keeps.includes("folx?"), `keep-list quotes the typed form (got ${JSON.stringify(keeps)})`);

  // UNEXPLAINED losses only. "teh" was lost AND explained (paired with "the"),
  // so it must not be kept -- a keep-list naming the typo forfeits that fix on
  // the retry. This is the 2026-08-28 audit's finding 6, pinned on its own
  // reproduction case: the pre-fix code returned ["folx.", "teh"].
  const rep2 = guardSentenceReport("Fix teh label but preserve folx.",
    "Fix the label but preserve fixed.", "Fix the label but preserve fixed.", { trigger: null });
  const keeps2 = sentenceRetryKeepList(rep2.evidence, "Fix teh label but preserve folx.");
  check(keeps2.includes("folx."), `the unexplained loss is kept (got ${JSON.stringify(keeps2)})`);
  check(!keeps2.some((k) => k.toLowerCase().includes("teh")),
    `the explained typo is NOT kept (got ${JSON.stringify(keeps2)})`);

  // Original casing is restored from the sentence, not taken from the bare
  // lowercased evidence tokens.
  const cased = sentenceRetryKeepList({ unexplainedLost: ["white"] },
    "We have enough to fill White paper envelopes today.");
  check(cased.length === 1 && cased[0] === "White", `casing restored (got ${JSON.stringify(cased)})`);
  // ...but only when unambiguous: two occurrences with different casing cannot
  // say which was lost, so the bare evidence token goes out, never a guess.
  const amb = sentenceRetryKeepList({ unexplainedLost: ["apple"] },
    "Apple reviewed the report while apple waited nearby.");
  check(amb.length === 1 && amb[0] === "apple", `ambiguous casing falls back to bare (got ${JSON.stringify(amb)})`);
  // Edge punctuation the guard tokenizer strips is restored: a lost #Project
  // arrives in evidence as "project" and must go out as typed.
  const hash = sentenceRetryKeepList({ unexplainedLost: ["project"] }, "Ship #Project today.");
  check(hash.length === 1 && hash[0] === "#Project", `edge punctuation restored (got ${JSON.stringify(hash)})`);

  // Capped at 4, deduplicated, and empty evidence yields an empty list.
  const many = sentenceRetryKeepList(
    { unexplainedLost: ["aa", "bb", "cc", "dd", "ee", "aa"] }, "aa bb cc dd ee ff.");
  check(many.length === 4, `cap at 4 (got ${many.length})`);
  check(sentenceRetryKeepList({}, "anything at all.").length === 0, "empty evidence, empty list");
  check(sentenceRetryKeepList(null, "anything at all.").length === 0, "null evidence, empty list");
  // Bare `lost` is the fallback only, and it excludes matched typos for the
  // same reason as [2]'s main pin.
  const fb = sentenceRetryKeepList({ lost: ["then"] }, "better then ever.");
  check(fb.length === 1 && fb[0] === "then", "falls back to lost when nothing stronger exists");
  const fbx = sentenceRetryKeepList(
    { lost: ["teh", "it"], matched: [{ lost: "teh", gained: "the" }] }, "teh it thing.");
  check(fbx.length === 1 && fbx[0] === "it", `fallback excludes matched typos (got ${JSON.stringify(fbx)})`);

  // The fallback's REAL reachability, pinned from guard-produced evidence
  // rather than synthetic objects. A pure case-only capital-removed loses no
  // token at all (the diff runs lowercased), so it yields NO keeps and the
  // retry is skipped -- a named residual, not a promise. The capital-removed
  // shape that does reach the fallback is one whose diff also lost a token,
  // as in the synthetic casing-and-typo carrier below.
  const caseOnly = guardSentenceReport("Alice met Bob on monday morning.",
    "alice met Bob on Monday morning.", "alice met Bob on Monday morning.", { trigger: null });
  check(caseOnly.reason === "capital-removed", `case-only fixture refuses capital-removed (got ${caseOnly.reason})`);
  check(sentenceRetryKeepList(caseOnly.evidence, "Alice met Bob on monday morning.").length === 0,
    "pure case-only loss yields no keeps (the documented residual)");
  const capitalTypo = guardSentenceReport("We have enought to fill White paper envelopes today.",
    "We have enough to fill white paper envelopes today.",
    "We have enough to fill white paper envelopes today.", { trigger: null });
  const capitalTypoKeeps = sentenceRetryKeepList(capitalTypo.evidence, "We have enought to fill White paper envelopes today.");
  check(capitalTypo.reason === "capital-removed" && capitalTypoKeeps.length > 0,
    `a capital-removed WITH a lost token reaches the fallback (got ${capitalTypo.reason}, ${JSON.stringify(capitalTypoKeeps)})`);
}

// ------------------------------------------ [2a] a licensed name is not a keep
// Mutant: if (subs2.length && subDetail) Object.assign(subDetail, viewDetail);
// The empty keep-list assertion turns red (the stale typo becomes a keep).
{
  console.log("[2a] a licensed name typo is not a keep");
  const input = "The sample index lists an Antrhopic paper.";
  const out = "The sample index lists an Anthropic paper!";
  const rep = guardSentenceReport(input, out, out, {});
  check(JSON.stringify(sentenceRetryKeepList(rep.evidence, input)) === "[]",
    "[2a] licensed Antrhopic loss yields no keeps");
}

// ------------------------------------------------ [2b] dedup is not a keep
// Mutant: remove `for (const t of evidence.dedupExcused || []) explained.add(t);`
// Both pins turn red: dedup-only must skip, while the mixed loss must keep to.
{
  console.log("[2b] dedup is not a keep; a lost function word still is");
  const input = "i know know that Alice left.";
  const out = "i know that alice left.";
  const rep = guardSentenceReport(input, out, out, {});
  check(JSON.stringify(sentenceRetryKeepList(rep.evidence, input)) === "[]",
    "[2b] excused duplicate yields no keeps");
  const mixed = "i know know that Alice went to town.";
  const mixedOut = "i know that alice went town.";
  const mixedRep = guardSentenceReport(mixed, mixedOut, mixedOut, {});
  check(JSON.stringify(sentenceRetryKeepList(mixedRep.evidence, mixed)) === '["to"]',
    "[2b] mixed loss retains only the function word to");
}

// -------------------------------------------------------- [3] the retry prompt
{
  console.log("[3] retry messages derive from the shipping builder");
  const sentence = "The sample label was meant to greet group of folx?";
  const ctx = "Prior sentence for context.";
  for (const model of ["proofer-pilot-q8:latest", "qwen3.5:9b"]) {
    const base = buildSentenceMessages(sentence, ctx, {}, model);
    const retry = buildSentenceRetryMessages(sentence, ctx, {}, model, ["folx?"]);
    check(retry.length === base.length, `[${model}] same turn count`);
    check(retry[0].content.startsWith(base[0].content), `[${model}] system turn is the shipping one plus a suffix`);
    check(retry[0].content.includes('keep each exactly as written: "folx?"'),
      `[${model}] constraint line names the keep`);
    let identical = true;
    for (let i = 1; i < base.length; i++) {
      if (retry[i].role !== base[i].role || retry[i].content !== base[i].content) identical = false;
    }
    check(identical, `[${model}] every non-system turn is byte-identical`);
    check(retry[retry.length - 1].content === sentence, `[${model}] the user turn stays bare`);
    // The first-pass builder is untouched -- the retry copies, it never mutates.
    const again = buildSentenceMessages(sentence, ctx, {}, model);
    check(!again[0].content.includes("Do not change these words"),
      `[${model}] first-pass prompt carries no constraint`);
    // An empty keep-list adds nothing: the retry prompt IS the shipping prompt.
    const bare = buildSentenceRetryMessages(sentence, ctx, {}, model, []);
    check(JSON.stringify(bare) === JSON.stringify(base), `[${model}] empty keeps -> shipping prompt exactly`);
  }
  // The keeps are user text going into a system turn, so they are
  // JSON-encoded: a token carrying a quote cannot break out of the quoting.
  const quoted = buildSentenceRetryMessages("x", "", {}, "m", ['foo"bar']);
  check(quoted[0].content.includes('"foo\\"bar"'),
    `a quote in a keep token is escaped (got ...${quoted[0].content.slice(-40)})`);
  // The suffix is EXACTLY the constraint line -- not the constraint line plus
  // anything else. An includes() check would stay green while extra system
  // instructions rode in on the retry, which is a prompt change nobody
  // measured.
  const b = buildSentenceMessages("x", "", {}, "m");
  const rmsg = buildSentenceRetryMessages("x", "", {}, "m", ["kept", "also"]);
  check(rmsg[0].content === b[0].content +
    '\n\nDo not change these words; keep each exactly as written: "kept", "also".',
    "the system suffix is exactly the constraint line and nothing more");
}

// --------------------------------------------- [4] the helper's no-request exits
{
  console.log("[4] retrySentenceRewrite refuses to fetch");
  // Every case here must return BEFORE any network call: ollamaUrl points at a
  // closed port, so a helper that fetches anyway fails loudly, not silently.
  const req = { body: { model: "x", options: { num_ctx: 2048 } }, timeoutMs: 20000 };
  // A REAL AbortController: the consent race listens on the signal, so a
  // plain {aborted: false} object is not signal enough.
  const base = {
    priorContext: "", pageContext: {}, req, ollamaUrl: "http://127.0.0.1:1",
    trigger: null, ac: new AbortController(), deadlineMs: Date.now() + 20000,
  };
  const folxIn = "The sample label was meant to greet group of folx?";
  const folxOut = "The sample label was meant to greet a group of fixed?";

  const preAborted = new AbortController();
  preAborted.abort();
  const aborted = await retrySentenceRewrite({ ...base, sentence: folxIn,
    firstRaw: folxOut, firstCleaned: folxOut, firstReason: "word-substituted:folx",
    ac: preAborted });
  check(aborted.outcome === "cancelled", `aborted signal -> cancelled (got ${aborted.outcome})`);

  // The deadline is ABSOLUTE, and a spent one refuses before any evidence work.
  const noBudget = await retrySentenceRewrite({ ...base, sentence: folxIn,
    firstRaw: folxOut, firstCleaned: folxOut, firstReason: "word-substituted:folx",
    deadlineMs: Date.now() + SENTENCE_RETRY_MIN_BUDGET_MS - 50 });
  check(noBudget.outcome === "no-budget", `spent deadline -> no-budget (got ${noBudget.outcome})`);

  // A doubled-sentence output refuses with nothing lost, so there is nothing
  // to constrain on: no-keeps, no request. Its first reason is soft, so this
  // also exercises the full-report path.
  const s = "The plan was approved.";
  const doubled = "The plan was approved. The plan was approved.";
  const noKeeps = await retrySentenceRewrite({ ...base, sentence: s,
    firstRaw: doubled, firstCleaned: doubled, firstReason: "length-band" });
  check(noKeeps.outcome === "no-keeps", `nothing lost -> no-keeps (got ${noKeeps.outcome})`);

  // A hard FIRST reason short-circuits before the evidence report is paid for
  // (a long low-overlap report prices at ~0.5s); the outcome is the same
  // not-retryable the full-list rule would reach.
  const recited = "The technician replaced the faulty sensor.";
  const notRetryable = await retrySentenceRewrite({ ...base,
    sentence: "why did that one not get any better?",
    firstRaw: recited, firstCleaned: recited, firstReason: "low-overlap" });
  check(notRetryable.outcome === "not-retryable" && notRetryable.reason === "low-overlap",
    `a hard first reason -> not-retryable (got ${notRetryable.outcome}/${notRetryable.reason})`);

  // The CONCEALED hard reason, at the helper level: the first reason is soft
  // (length-band) and low-overlap sits behind it in the full report. A helper
  // mutated to route on the first reason alone sails past the veto and hits
  // the closed port ("error"), so this fixture is what makes the whole-list
  // rule a property of the WIRING, not just of the pure decision function.
  const doubledRecited = recited + " " + recited;
  const concealed = await retrySentenceRewrite({ ...base,
    sentence: "why did that one not get any better?",
    firstRaw: doubledRecited, firstCleaned: doubledRecited, firstReason: "length-band" });
  check(concealed.outcome === "not-retryable" && concealed.reason === "low-overlap",
    `a concealed hard reason still vetoes in the helper (got ${concealed.outcome}/${concealed.reason})`);

  // Consent gone at fetch time refuses the send. checkAllowed runs after every
  // cheaper gate, so this fixture needs a retryable refusal with keeps -- the
  // folx one -- and a callback that says no.
  const revoked = await retrySentenceRewrite({ ...base, sentence: folxIn,
    firstRaw: folxOut, firstCleaned: folxOut, firstReason: "word-substituted:folx",
    checkAllowed: async () => false });
  check(revoked.outcome === "not-allowed", `revoked consent -> not-allowed, no fetch (got ${revoked.outcome})`);
}

console.log(`\n${"=".repeat(72)}`);
console.log(`${pass} passed | ${fail} failed`);
process.exit(fail ? 1 : 0);
