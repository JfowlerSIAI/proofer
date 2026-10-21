#!/usr/bin/env node
/**
 * Does prior context actually decide an AMBIGUOUS typo?
 *
 *   cd test && node sentence-context-test.mjs
 *   PROOFER_MODEL=qwen3.5:9b node sentence-context-test.mjs
 *
 * Sentence mode sends up to 2500 characters of what came before, and the whole
 * point of paying for those tokens is the case where the sentence alone is not
 * enough. This suite is the only thing that measures whether it buys anything.
 *
 * An observed ambiguity motivated this suite: `emtal` can be read as
 * `metal` or `email`, despite context that points toward a material. The
 * carrier and contextual clue below are newly authored examples of that
 * mechanism; they are not a transcript of the original interaction.
 *
 * Every case is a non-word with two plausible dictionary readings, run against
 * three contexts:
 *
 *   none      the sentence alone -- the model's unaided judgement
 *   implied   a human would infer the answer (copper -> we are discussing metals)
 *   stated    the target word appears verbatim in the context
 *
 * The three columns separate reasoning from priming. Historical development
 * runs found that a contextual demonstration helped the model use context,
 * while moving the context after the demonstrations also increased unwanted
 * edits. The current synthetic carriers need fresh model measurements;
 * historical rates are not results for this fixture revision.
 *
 * Not a pass/fail gate: it reports three rates. `implied` moving is the only
 * evidence that the context window does more than prime, so re-run this before
 * spending anything on context size or shape.
 */
import { MODEL, OLLAMA_URL, createLatencyTracker, formatLatencyReport }
  from "./lib/harness.mjs";
import { prepareSentenceRequest } from "./lib/sentence-guards.mjs";

const N = Number(process.env.PROOFER_CONTEXT_N || 3);
const PAGE_CONTEXT = { hostname: "discord.com" };

const CASES = [
  // Synthetic ambiguity: "emtal" is 2 edits from "email", 1 from "metal".
  { s: "The sample label refers to that emtal.", want: /\bmetal\b/i,
    implied: "The display includes copper.", stated: "We need a metal for the model." },
  { s: "I need to by some more of it.", want: /\bbuy\b/i,
    implied: "I am at the shop now.", stated: "Did you buy anything?" },
  { s: "He sent me the fom yesterday.", want: /\bform\b/i,
    implied: "HR needs the paperwork signed.", stated: "Did you fill in the form?" },
  { s: "The hoarse was in the field.", want: /\bhorse\b/i,
    implied: "We drove past the stables.", stated: "There was a horse there." },
  { s: "We are out of paer again.", want: /\bpaper\b/i,
    implied: "The printer keeps jamming.", stated: "Order more paper." },
  { s: "Check the setings before you run it.", want: /\bsettings\b/i,
    implied: "It is under the gear icon.", stated: "Open the settings panel." },
  { s: "The disert was the best part.", want: /\bdessert\b/i,
    implied: "We had three courses at dinner.", stated: "The dessert was chocolate." },
  { s: "I read the artical this morning.", want: /\barticle\b/i,
    implied: "It was on the front page.", stated: "Did you see that article?" },
];

const lat = createLatencyTracker();

async function ask(sentence, context) {
  const req = prepareSentenceRequest(sentence, context, PAGE_CONTEXT, { ollamaModel: MODEL });
  const t0 = Date.now();
  let data;
  try {
    const res = await fetch(OLLAMA_URL + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    data = await res.json();
  } catch (e) {
    console.error(`\nCannot reach Ollama at ${OLLAMA_URL}: ${e.message}`);
    process.exit(1);
  }
  lat.record(Date.now() - t0, data);
  try { return String(JSON.parse(String(data.message?.content ?? "").trim()).rewritten ?? ""); }
  catch { return ""; }
}

console.log("\nDoes prior context decide an ambiguous typo?");
console.log("=".repeat(78));
console.log(`Model: ${MODEL}`);
console.log(`${CASES.length} ambiguous sentences x 3 context conditions x n=${N}\n`);

const total = { none: 0, implied: 0, stated: 0 };
for (const c of CASES) {
  const row = {};
  let unaided = "";
  for (const k of ["none", "implied", "stated"]) {
    const ctx = k === "none" ? "" : c[k];
    let hit = 0;
    for (let i = 0; i < N; i++) {
      const out = await ask(c.s, ctx);
      if (k === "none" && !unaided) unaided = out;
      if (c.want.test(out)) hit++;
    }
    row[k] = hit;
    total[k] += hit;
  }
  console.log(`  none ${row.none}/${N}   implied ${row.implied}/${N}   stated ${row.stated}/${N}   ${JSON.stringify(c.s)}`);
  console.log(`       unaided: ${JSON.stringify(unaided)}`);
}

const T = CASES.length * N;
const pct = (x) => `${String(x).padStart(2)}/${T}  ${((100 * x) / T).toFixed(1).padStart(5)}%`;
console.log("\n" + "-".repeat(78));
console.log(`  no context        ${pct(total.none)}`);
console.log(`  implied by it     ${pct(total.implied)}   ${total.implied === total.none
  ? "<- worth NOTHING over no context at all" : `<- ${total.implied - total.none} over none`}`);
console.log(`  stated verbatim   ${pct(total.stated)}   <- priming, not comprehension`);
console.log("-".repeat(78));
console.log(formatLatencyReport(lat.stats()));
