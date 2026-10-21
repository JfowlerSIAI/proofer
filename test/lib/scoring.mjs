// The scoring rubric shared by the LLM suites (proofer-test, proofer-holdout,
// meaning-drift), and the one way they reach the model: callSentence, which
// runs background.js's own sentence engine.
//
// The manual-path caller that used to live here (callOllama, with its prompt,
// template and raw-format options) went with that path on 2026-09-24.

import { OLLAMA_URL, MODEL, OPTIONS_OVERRIDE, researchModelPolicy } from "./harness.mjs";
import {
  prepareSentenceRequest, runSentenceEngine, sentenceResultFields, isRetrySalvaged, MIN_SENTENCE_CHARS,
  SENTENCE_TIMEOUT_MS, SENTENCE_RETRY_DELIVERY_CAP_MS, SENTENCE_RETRY_DELIVERY_MARGIN_MS,
  stripMarkdown as shipStripMarkdown, asciify as shipAsciify,
  normalizeWhitespace as shipNormalizeWhitespace,
} from "./sentence-guards.mjs";

// --- Sanitization (mirrors background.js) ---

// Markers already present in `original` are the user's own text, not markdown
// the model added, so that family is left alone. See background.js.
export function stripMarkdown(s, original = "") {
  let out = s;
  if (!original.includes("*")) {
    out = out
      .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/\*(.*?)\*/g, "$1");
  }
  if (!original.includes("__")) out = out.replace(/__(.*?)__/g, "$1");
  if (!original.includes("`")) out = out.replace(/`([^`]+)`/g, "$1");
  return out;
}

export function asciify(s) {
  return s
    .replace(/[‒–—―−]/g, "--")
    .replace(/[‑﹘﹣－]/g, "-")
    .replace(/[‘’′´]/g, "'")
    .replace(/[“”″«»]/g, '"')
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ");
}

export function normalizeWhitespace(rewritten, original) {
  let result = rewritten;
  if (!original.match(/^\s/) && result.match(/^\s/)) result = result.trimStart();
  if (original.match(/^\s/) && !result.match(/^\s/)) result = original.match(/^(\s+)/)[1] + result;
  const origTrailing = original.match(/(\s+)$/);
  result = result.trimEnd();
  if (origTrailing) result += origTrailing[1];
  return result;
}

export function isSubstantivelyEqual(a, b) {
  return asciify(a).replace(/\s+/g, " ").trim() === asciify(b).replace(/\s+/g, " ").trim();
}

export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// --- The sentence pipeline (the product since 2026-09-24) ---

// The product's arrival deadline: the worker answers inside the content
// script's 5 s delivery lease or not at all (background.js, the same
// expression). PROOFER_DEADLINE_MS overrides it for research on slow
// hardware -- a run that sets it is no longer measuring what a user gets, and
// the counts say how many answers would have been dropped.
const PRODUCT_DEADLINE_MS = Math.min(SENTENCE_TIMEOUT_MS,
  SENTENCE_RETRY_DELIVERY_CAP_MS - SENTENCE_RETRY_DELIVERY_MARGIN_MS);
const DEADLINE_MS = Number(process.env.PROOFER_DEADLINE_MS) || PRODUCT_DEADLINE_MS;

/** How callSentence's answers were reached; the suites print it. */
export const sentenceOutcomes = { sent: 0, applied: 0, noChange: 0, refused: 0, retried: 0,
  salvaged: 0, expired: 0, truncated: 0, errors: 0, deadlineMs: DEADLINE_MS };

/**
 * One sentence through the SHIPPING sentence engine (background.js
 * runSentenceEngine, read out of the file rather than copied): the request the
 * product sends, the guards, the guard-informed retry, truncation handling and
 * the arrival deadline. What is scored is what would reach the field -- a
 * refused, expired or failed correction scores as the unchanged input.
 *
 * Until 2026-09-25 this had its own caller: a 120 s timeout, no retry, and a
 * truncated reply accepted when its JSON happened to parse -- so it scored
 * outcomes the product never delivers (checkpoint 1). The manual rewrite path
 * these suites were written against went on 2026-09-24; the cases that fit one
 * sentence were ported here.
 *
 * Research knobs, none of which the product has: PROOFER_MODEL (the model --
 * held to the shared researchModelPolicy, including pinned aliases and the
 * nonempty PROOFER_SKIP_DIGEST_CHECK opt-out), PROOFER_OPTIONS (laid over the
 * request's options), PROOFER_DEADLINE_MS (above).
 * PROOFER_SENTENCE_GUARDS=0 skips the engine and scores the cleaned model
 * output, to separate the model from the guards; it measures no product path.
 *
 * Returns { text, raw, refused, outcome } -- text is what lands in the field.
 */
export async function callSentence(text, {
  model = MODEL,
  latency = null,
  trigger = process.env.PROOFER_TRIGGER || "idle",
  hostname = "example.com",
  priorContext = "",
} = {}) {
  const policy = researchModelPolicy(model);
  model = policy.model;
  const req = prepareSentenceRequest(text, priorContext, { hostname }, { ollamaModel: model });
  Object.assign(req.body.options, OPTIONS_OVERRIDE);
  if (process.env.PROOFER_SENTENCE_GUARDS === "0") return callModelOnly(text, req, latency);
  const ac = new AbortController();
  const started = performance.now();
  sentenceOutcomes.sent++;
  const { payload, meta } = await runSentenceEngine({
    sentence: text, priorContext, pageContext: { hostname }, trigger, req,
    ollamaUrl: OLLAMA_URL, ac, deadlineMs: Date.now() + DEADLINE_MS,
    checkAllowed: async () => true,
    expectedDigest: policy.expectedDigest,
  });
  if (latency) latency.recordInteraction(performance.now() - started, meta.attempts);
  const o = sentenceOutcomes;
  // A retry counts only when a second request actually went out; no-budget,
  // breaker-open and the other pre-send outcomes did not send one.
  if (meta.retry && meta.retry.dispatched === true) o.retried++;
  if (isRetrySalvaged(sentenceResultFields(payload, meta))) o.salvaged++;
  const raw = meta.rawOutput ?? null;
  if (payload.ok && typeof payload.rewritten === "string") {
    o.applied++;
    return { text: payload.rewritten, raw, refused: null, outcome: "applied" };
  }
  if (payload.ok && payload.noChanges) { o.noChange++; return { text, raw, refused: null, outcome: "no-change" }; }
  if (payload.refused) {
    o.refused++;
    return { text, raw, refused: payload.refused, outcome: "refused" };
  }
  if (payload.error === "delivery-expired") o.expired++;
  else if (payload.error === "truncated") o.truncated++;
  else o.errors++;
  // A model-level failure is a result to count, not a crash, EXCEPT when the
  // suite is pointed at nothing: that has to stop the run, as it always did.
  if (["unreachable", "model-missing", "model-mismatch", "model-unverified"].includes(payload.error)
      || /^http-/.test(payload.error || "")) {
    throw new Error(`sentence engine: ${payload.error}`);
  }
  return { text, raw, refused: payload.error, outcome: payload.error };
}

/** One line for a suite's banner: how the answers were reached. */
export function formatSentenceOutcomes() {
  const o = sentenceOutcomes;
  return `engine: ${o.sent} sent · ${o.applied} applied · ${o.noChange} no change · ${o.refused} refused`
    + ` · ${o.retried} retried (${o.salvaged} salvaged) · ${o.expired} past the ${o.deadlineMs} ms deadline`
    + ` · ${o.truncated} truncated · ${o.errors} other`;
}

// PROOFER_SENTENCE_GUARDS=0: the model's cleaned output, no guards, no retry,
// no deadline. For separating the model from the guards only.
async function callModelOnly(text, req, latency) {
  const started = performance.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body), signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (latency) latency.record(performance.now() - started, data);
  let raw = null;
  try { raw = JSON.parse(String(data.message?.content ?? "").trim())?.rewritten; } catch { raw = null; }
  if (typeof raw !== "string" || data.done_reason === "length") return { text, raw: null, refused: "invalid-json", outcome: "refused" };
  const stripped = raw.replace(/<\/?(excerpt|context|rewritten)>/gi, "");
  return { text: shipNormalizeWhitespace(shipAsciify(shipStripMarkdown(stripped, text)), text), raw, refused: null, outcome: "model-only" };
}

/**
 * The cases the sentence pipeline can be asked about: one sentence, at least
 * MIN_SENTENCE_CHARS long (content.js never sends a shorter one). A case with
 * two sentences in it was a whole-field rewrite, which the product no longer
 * does.
 */
export function singleSentenceCases(tests) {
  const kept = [], skipped = [];
  for (const t of tests) {
    const input = String(t.input || "");
    const sentences = input.trim().split(/(?<=[.!?]["')\]]*)\s+(?=\S)/).filter(Boolean);
    if (input.trim().length < MIN_SENTENCE_CHARS) skipped.push({ t, why: "shorter than a sentence" });
    else if (sentences.length > 1) skipped.push({ t, why: "more than one sentence" });
    else kept.push(t);
  }
  return { kept, skipped };
}

const norm = s => s.replace(/\s+/g, " ").trim().toLowerCase();

export function isCleanCategory(category) {
  return category === "clean" || category === "wrong-word-clean";
}

/**
 * Score one result.
 *
 * opts.strictContractions (default false) — when false, an output that differs
 * from `expected` ONLY in contraction style counts as PASS. The corpora
 * contradict each other on this point (proofer-test #18 demands
 * `donot -> do not` while proofer-holdout #11 demands `mustnt -> mustn't` for
 * the same phenomenon), so penalising either convention scores a coin flip.
 * Pass true to reproduce pre-2026-08 numbers.
 *
 * A test case may also carry `accepted: [...]`, a list of additional outputs
 * that are equally valid. Exact-match against any of them is a PASS.
 */
export function evaluate(test, rewritten, opts = {}) {
  const { strictContractions = false } = opts;
  const issues = [];
  const isClean = isCleanCategory(test.category);

  // A null means the model broke the output contract (unparseable JSON, missing
  // key, empty). That is NOT the same as "chose to make no changes", and must
  // never be credited as a correct no-op on clean text.
  if (rewritten === null) {
    issues.push("CONTRACT_FAIL");
    return { verdict: "FAIL", issues, corrected: null };
  }

  // Declared-valid alternatives are checked FIRST. When `accepted` contains the
  // input itself ("leaving this alone is also correct"), the no-change branch
  // below would otherwise fail it as a missed error before we ever got here.
  const matchesAccepted = Array.isArray(test.accepted) &&
    test.accepted.some(a => norm(rewritten) === norm(a));
  if (matchesAccepted) return { verdict: "PASS", issues, corrected: rewritten };

  const noChanges = isSubstantivelyEqual(rewritten, test.input);

  if (isClean) {
    if (noChanges) return { verdict: "PASS", issues, corrected: rewritten };
    issues.push("FALSE_POSITIVE");
    return { verdict: "FAIL", issues, corrected: rewritten };
  }
  if (noChanges) {
    issues.push("MISSED_ERROR");
    return { verdict: "FAIL", issues, corrected: test.input };
  }

  const corrected = rewritten;
  if (norm(corrected) === norm(test.expected)) return { verdict: "PASS", issues, corrected };

  // Equally-valid alternatives declared on the case itself.
  if (Array.isArray(test.accepted) && test.accepted.some(a => norm(corrected) === norm(a))) {
    return { verdict: "PASS", issues, corrected };
  }

  if (!strictContractions && isContractionStyleOnly(corrected, test.expected)) {
    issues.push("CONTRACTION_STYLE");
    return { verdict: "PASS", issues, corrected };
  }

  const inputDist = levenshtein(norm(test.input), norm(test.expected));
  const corrDist = levenshtein(norm(corrected), norm(test.expected));
  if (corrDist === 0) return { verdict: "PASS", issues, corrected };
  if (corrDist < inputDist * 0.4) return { verdict: "PARTIAL", issues, corrected };
  issues.push("BAD_CORRECTION");
  return { verdict: "FAIL", issues, corrected };
}

// --- Diagnostics ---

// Only UNAMBIGUOUS contractions live here. Anything ending in 's or 'd has two
// readings ("it's" = "it is" or "it has") and is handled by AMBIGUOUS below —
// listing it here would consume it before the second reading can be generated.
const CONTRACTIONS = [
  [/\bthey're\b/g, "they are"], [/\byou're\b/g, "you are"],
  [/\bwe're\b/g, "we are"], [/\blet's\b/g, "let us"],
  [/\bdon't\b/g, "do not"], [/\bdoesn't\b/g, "does not"], [/\bdidn't\b/g, "did not"],
  [/\bcan't\b/g, "cannot"], [/\bwon't\b/g, "will not"], [/\bisn't\b/g, "is not"],
  [/\baren't\b/g, "are not"], [/\bwasn't\b/g, "was not"], [/\bweren't\b/g, "were not"],
  [/\bcouldn't\b/g, "could not"], [/\bwouldn't\b/g, "would not"], [/\bshouldn't\b/g, "should not"],
  [/\bmustn't\b/g, "must not"], [/\bneedn't\b/g, "need not"], [/\bmightn't\b/g, "might not"],
  [/\bshan't\b/g, "shall not"], [/\boughtn't\b/g, "ought not"], [/\bhadn't\b/g, "had not"],
  [/\bhaven't\b/g, "have not"], [/\bhasn't\b/g, "has not"], [/\bi'm\b/g, "i am"],
  [/\bi've\b/g, "i have"], [/\bi'll\b/g, "i will"],
];

// Ambiguous clitics: "it's" is "it is" OR "it has", "he'd" is "he would" OR
// "he had". Expanding to a single form misses half the cases, so expand to a
// SET of readings and treat two strings as equivalent if the sets intersect.
const AMBIGUOUS = [
  [/\b(\w+)'s\b/g, ["$1 is", "$1 has"]],
  [/\b(\w+)'d\b/g, ["$1 would", "$1 had"]],
];

function expandContractions(s) {
  let out = norm(s);
  for (const [re, full] of CONTRACTIONS) out = out.replace(re, full);
  return out.replace(/\s+/g, " ").trim();
}

function contractionReadings(s) {
  const base = expandContractions(s);
  const readings = new Set([base]);
  for (const [re, forms] of AMBIGUOUS) {
    for (const current of [...readings]) {
      for (const form of forms) {
        readings.add(current.replace(re, form).replace(/\s+/g, " ").trim());
      }
    }
  }
  return readings;
}

/**
 * Distinguish a genuinely wrong rewrite from one that only differs in
 * contraction style ("They are going" where the rubric wanted "They're going").
 * The model found the error either way — that's a rubric artifact, not a miss,
 * and it's worth counting separately when comparing models.
 */
export function isContractionStyleOnly(corrected, expected) {
  if (!corrected) return false;
  if (norm(corrected) === norm(expected)) return false;
  const a = contractionReadings(corrected);
  for (const reading of contractionReadings(expected)) if (a.has(reading)) return true;
  return false;
}

// --- McNemar's exact test for paired binary outcomes ---

function logFactorial(n) {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

function binomPmf(k, n) {
  // p = 0.5, so pmf = C(n,k) / 2^n. Logs keep it stable for large n.
  return Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) - n * Math.log(2));
}

/**
 * Two-sided exact McNemar test.
 * `fixed` = variant passes where baseline failed; `broke` = the reverse.
 * Returns the p-value for "the two prompts are equally likely to flip a case".
 */
export function mcnemarExactP(fixed, broke) {
  const n = fixed + broke;
  if (n === 0) return 1;
  const k = Math.min(fixed, broke);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomPmf(i, n);
  return Math.min(1, 2 * tail);
}
