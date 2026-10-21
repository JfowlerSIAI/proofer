#!/usr/bin/env node
// Sentence segmentation tests. No Ollama, no browser.
//
//   node sentence-split-test.mjs
//
// Sentence mode picks its own target by segmenting the user's text. A wrong
// boundary hands the model a fragment, and the model will "correct" a fragment
// into something that passes the output guards — measured: `He said "this is
// fine.` came back as `He said, 'This is fine.'`, which has 1.00 token overlap
// and would be spliced into the middle of a quotation. So a boundary bug is a
// text-corruption bug, not a cosmetic one.
//
// Intl.Segmenter output is identical in Node 20 and headless Chrome 145 over
// this corpus, so testing in Node is a valid proxy for what ships.
//
// segmentSentences is loaded OUT OF content.js (see lib/content-sandbox.mjs),
// not from a copy in test/lib -- a copy is exactly what would let the shipping
// segmenter drift while this suite stayed green.

import { segmentSentences, nextSentenceTarget, MIN_SENTENCE_CHARS } from "./lib/content-sandbox.mjs";

let pass = 0;
const failures = [];

/** Assert the exact sentence split, ignoring surrounding whitespace. */
function split(label, input, expected, opts) {
  const got = segmentSentences(input, opts).map((s) => s.text.trim());
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; return; }
  failures.push(label);
  console.log(`  FAIL  ${label}`);
  console.log(`          input    ${JSON.stringify(input)}`);
  console.log(`          got      ${JSON.stringify(got)}`);
  console.log(`          expected ${JSON.stringify(expected)}`);
}

/** Assert offsets round-trip: text.slice(start,end) is the trimmed sentence. */
function offsets(label, input) {
  const segs = segmentSentences(input);
  for (const s of segs) {
    const sliced = input.slice(s.start, s.end);
    if (sliced !== s.text.replace(/\s+$/, "")) {
      failures.push(label);
      console.log(`  FAIL  ${label}\n          slice ${JSON.stringify(sliced)} != ${JSON.stringify(s.text.replace(/\s+$/, ""))}`);
      return;
    }
  }
  // and the pieces must reconstruct the input
  if (segs.map((s) => s.text).join("") !== input) {
    failures.push(label);
    console.log(`  FAIL  ${label} (pieces do not reconstruct input)`);
    return;
  }
  pass++;
}

console.log("\nSentence segmentation\n" + "=".repeat(72));

console.log("\nAbbreviations must not end a sentence:");
split("title + name", "Dr. Smith arrived early. We started at nine.",
  ["Dr. Smith arrived early.", "We started at nine."]);
split("two titles", "Mr. Jones met Mrs. Patel today. They agreed on terms.",
  ["Mr. Jones met Mrs. Patel today.", "They agreed on terms."]);
split("initials", "J. R. R. Tolkien wrote it. We all read it.",
  ["J. R. R. Tolkien wrote it.", "We all read it."]);
split("company", "Acme Inc. filed today. We responded promptly.",
  ["Acme Inc. filed today.", "We responded promptly."]);
split("month", "We ship Jan. 5 this year. Book it now please.",
  ["We ship Jan. 5 this year.", "Book it now please."]);
split("reference", "Refer to Fig. 3 for detail. Then continue reading.",
  ["Refer to Fig. 3 for detail.", "Then continue reading."]);
split("latin", "Use e.g. apples and pears. Then stop counting.",
  ["Use e.g. apples and pears.", "Then stop counting."]);
// Closing punctuation has to be stripped BEFORE looking for the period, or the
// abbreviation is never seen.
split("abbreviation inside parens", "Use examples (e.g.) Here is one that is long.",
  ["Use examples (e.g.) Here is one that is long."]);
// Repeated letter-dot forms are handled generically, so the word list does not
// have to enumerate a.m./p.m./U.S./Ph.D.
split("time of day", "Meet at 3 p.m. Monday works for me here.",
  ["Meet at 3 p.m. Monday works for me here."]);
split("country abbreviation", "The U.S. Congress met today. It went badly.",
  ["The U.S. Congress met today.", "It went badly."]);
// The generic form has to allow a TWO-letter component. `(?:[A-Za-z]\.){2,}`
// cannot match "Ph." at all, so "She earned a Ph.D. in physics." split after
// the degree -- and the comment claimed coverage the test never checked.
split("two-letter component", "She earned a Ph.D. in physics. Then she taught.",
  ["She earned a Ph.D. in physics.", "Then she taught."]);
split("unit abbreviation", "Take 5 mg. daily with food. Then call the clinic.",
  ["Take 5 mg. daily with food.", "Then call the clinic."]);

console.log("\nNot sentence ends:");
// A period with a digit on either side is a decimal point. ICU rule SB6
// (ATerm x Numeric) is what enforces this and no pass in content.js can undo
// it, so these cases pin the dependency rather than any of our own code: if a
// future Intl.Segmenter changes its mind, the failure would otherwise surface
// as a corruption bug somewhere downstream of the splice.
split("decimal", "Version 3.14 is ready. Ship it now please.",
  ["Version 3.14 is ready.", "Ship it now please."]);
split("decimal, lowercase after", "the reading was 176.2 today. it went up again.",
  ["the reading was 176.2 today.", "it went up again."]);
split("decimal ends the sentence", "The reading was 176.2. It went up again.",
  ["The reading was 176.2.", "It went up again."]);
split("decimal, no leading integer", "We measured 0.5 of it. Then we stopped.",
  ["We measured 0.5 of it.", "Then we stopped."]);
split("dotted version", "We shipped v1.2.3 to staging. Nothing broke.",
  ["We shipped v1.2.3 to staging.", "Nothing broke."]);
split("ip address", "The server is at 192.168.1.1 now. Try it again.",
  ["The server is at 192.168.1.1 now.", "Try it again."]);
split("thousands separator", "The total is 1,000.5 for it. That seems high.",
  ["The total is 1,000.5 for it.", "That seems high."]);
split("member call", "Call foo.bar() now. Then check the output.",
  ["Call foo.bar() now.", "Then check the output."]);
split("url", "Visit https://example.com/a.b now. Then report back.",
  ["Visit https://example.com/a.b now.", "Then report back."]);
split("file extension", "Open report.pdf first thing. Then read it.",
  ["Open report.pdf first thing.", "Then read it."]);
split("ellipsis", "Wait... but continue anyway. Done now, thanks.",
  ["Wait... but continue anyway.", "Done now, thanks."]);
split("list markers", "1. First item here\n2. Second item here",
  ["1. First item here", "2. Second item here"]);

console.log("\nApostrophes are not quotation marks:");
// Regression: counting ' as a quote made the parity check odd for almost every
// English sentence, which suppressed the break after it. Measured before the
// fix: "I don't think so. Next sentence here." segmented as ONE sentence.
// Since most prose contains a contraction, that alone stopped sentence mode
// from ever firing.
split("contraction", "I don't think so. Next sentence here now.",
  ["I don't think so.", "Next sentence here now."]);
split("curly apostrophe", "I don’t think so. Next sentence here now.",
  ["I don’t think so.", "Next sentence here now."]);
split("possessive plural", "The clients' feedback arrived. We read all of it.",
  ["The clients' feedback arrived.", "We read all of it."]);
split("multiple contractions", "It's fine and we're happy. They've already signed off.",
  ["It's fine and we're happy.", "They've already signed off."]);
// Regression: the first apostrophe fix blanket-removed every quote preceded by
// a word character, which deleted the CLOSING quote of a quoted word. The
// opener then looked unmatched and suppressed the next boundary.
split("single-quoted word", "He called it 'fine' yesterday. Next sentence is valid.",
  ["He called it 'fine' yesterday.", "Next sentence is valid."]);
split("curly-quoted word", "He called it ‘fine’ yesterday. Next sentence is valid.",
  ["He called it ‘fine’ yesterday.", "Next sentence is valid."]);
split("unclosed single quote suppresses", "He said 'this is fine. And more' then left. Next sentence here.",
  ["He said 'this is fine. And more' then left.", "Next sentence here."]);
// An opener can follow punctuation, not just whitespace. Without the colon in
// the opener class the veto never fired and the break landed inside the quote.
split("quote opens after a colon", "He said:'this is fine. and more' before leaving today.",
  ["He said:'this is fine. and more' before leaving today."]);
// A quote before a DIGIT is a decade, not an opener. Read as an unmatched
// opener it suppressed every boundary after it.
split("decade apostrophe is not an opener", "Music from the '90s was loud. next question please.",
  ["Music from the '90s was loud.", "next question please."]);

console.log("\nLowercase sentence starts (ICU rule SB8 suppresses these breaks):");
// SB8 is right for "Wait... but" and "e.g. apples" and wrong for anyone who
// writes without capitals. Measured over lib/sentence-corpus.mjs: lowercasing
// every sentence start drops boundary coverage from 95% to 23%, which would
// hand the model five sentences as one blob and eventually exceed
// maxTargetChars entirely. So the break is restored, minus SB8's real cases.
split("plain lowercase continuation", "Version 3.14 is ready. ship it now please.",
  ["Version 3.14 is ready.", "ship it now please."]);
split("chat style throughout", "ok will do. thanks for the update.",
  ["ok will do.", "thanks for the update."]);
split("question mark", "did that land? looks fine from here.",
  ["did that land?", "looks fine from here."]);
// The three vetoes. Each one is a case where SB8 is correct.
split("ellipsis is not a terminator", "Wait... but continue anyway. done now, thanks.",
  ["Wait... but continue anyway.", "done now, thanks."]);
split("abbreviation before lowercase", "Use e.g. apples and pears. then stop counting.",
  ["Use e.g. apples and pears.", "then stop counting."]);
split("letter-dot before lowercase", "Meet at 3 p.m. monday works for me here.",
  ["Meet at 3 p.m. monday works for me here."]);
split("no split inside an open quotation",
  'He said "this is fine. and more" then left. next sentence here.',
  ['He said "this is fine. and more" then left.', "next sentence here."]);
split("digits are left to ICU", "He said (see Fig. 3 above). then he left quickly.",
  ["He said (see Fig. 3 above).", "then he left quickly."]);

console.log("\nQuotations:");
// The quote veto costs a boundary (a closing quote after a terminator gets
// merged) and buys the one that matters: never splitting INSIDE a quotation,
// which would hand the model half of someone's quoted sentence.
split("sentence inside quotation stays whole",
  'He said "this is fine. And more" then left. Next sentence here.',
  ['He said "this is fine. And more" then left.', "Next sentence here."]);
split("curly quotation", "She wrote, “this is the part.” Then she stopped talking.",
  ["She wrote, “this is the part.”", "Then she stopped talking."]);
split("parenthetical", "He said (see Fig. 3 above). Then he left quickly.",
  ["He said (see Fig. 3 above).", "Then he left quickly."]);

console.log(`\nShort fragments merge into a neighbour (MIN_SENTENCE_CHARS=${MIN_SENTENCE_CHARS}):`);
// A two-word fragment gives the model nothing to work with. Rather than
// proofread it alone or skip it, attach it to its neighbour so the text stays
// fully covered.
split("short merges forward", "Ship it. I will tell the team this afternoon.",
  ["Ship it. I will tell the team this afternoon."]);
split("trailing short merges backward", "We reviewed the whole document today. On it.",
  ["We reviewed the whole document today. On it."]);
// Two fragments merge into one another and the result stands alone. This case
// used to expect all three merged, which was an artifact of "no" being in the
// abbreviation list: "The answer is no. Then we can move on." merged too, so a
// perfectly ordinary sentence was never proofread on its own. "No. 5 in the
// list." still segments correctly without it, because the digit is handled by
// ICU rather than by the abbreviation pass.
split("cascade of short fragments", "On it. lol no. That all works for me though.",
  ["On it. lol no.", "That all works for me though."]);
split("no is a word, not an abbreviation", "The answer is no. Then we can move on.",
  ["The answer is no.", "Then we can move on."]);
split("No. still works as a number", "See No. 5 in the list. Then check the rest.",
  ["See No. 5 in the list.", "Then check the rest."]);
split("exactly at the threshold stands alone", "It's fine. We can ship it tomorrow morning.",
  ["It's fine.", "We can ship it tomorrow morning."]);
split("all-short input still returns something", "Ok. Fine. Sure.",
  ["Ok. Fine. Sure."]);
split("threshold is configurable", "Ship it. I will tell the team this afternoon.",
  ["Ship it.", "I will tell the team this afternoon."], { minChars: 0 });

console.log("\nA URL is one token, whatever is inside it:");
// This synthetic URL retains a query-string boundary hazard: reading the
// `?` before its parameters as a terminator would create a second target
// with no words in it.
const SYNTHETIC_URL = "https://example.com/catalog/items/3141592653?s=7&t=syntheticQueryToken";
// One segment, not two: "Max." is in ABBREVIATIONS, so the boundary before the
// link is suppressed for a reason that has nothing to do with URLs. What
// matters is what is NOT here -- no segment begins at the `?`, so the tracking
// parameters are never a target of their own.
split("query string is not a boundary",
  `The display lists the limit as Max. ${SYNTHETIC_URL}`,
  [`The display lists the limit as Max. ${SYNTHETIC_URL}`]);
split("query string is not a boundary (plain sentence before it)",
  `The display shows the current limit. ${SYNTHETIC_URL}`,
  ["The display shows the current limit.", SYNTHETIC_URL]);
split("question mark mid-URL, sentence continues",
  "See https://example.com/a?b=1&c=2 for the details. Then report back.",
  ["See https://example.com/a?b=1&c=2 for the details.", "Then report back."]);
split("bang and dots inside a URL",
  "Open https://example.com/a.b!c?d=1 now please. Then close it.",
  ["Open https://example.com/a.b!c?d=1 now please.", "Then close it."]);
// The span must stop before a terminator that belongs to the sentence: `\S+`
// is greedy, so an unbounded match would swallow it and never break.
split("terminator after a URL still breaks",
  "Go to https://example.com/a?b=1. Then leave the page.",
  ["Go to https://example.com/a?b=1.", "Then leave the page."]);
split("URL then a real sentence, lowercase start",
  "check https://example.com/x?y=2 first. then tell me what you see.",
  ["check https://example.com/x?y=2 first.", "then tell me what you see."]);
offsets("offsets: URL with query string",
  "See https://example.com/a?b=1&c=2 for the details. Then report back.");
offsets("offsets: synthetic abbreviation and URL",
  `The display lists the limit as Max. ${SYNTHETIC_URL}`);

console.log("\nA target has to be language:");
/** Assert what nextSentenceTarget makes of `text` with the watermark at 0. */
function target(label, text, expected) {
  const t = nextSentenceTarget(text, 0, true);
  const got = !t ? "none" : t.skip ? `skip:${t.skip}` : t.sentence;
  if (got === expected) { pass++; return; }
  failures.push(label);
  console.log(`  FAIL  ${label}\n          got      ${JSON.stringify(got)}\n          expected ${JSON.stringify(expected)}`);
}
// A pasted link with no terminator was never a target anyway -- the point is
// that it is not one WITH one either, and that it no longer produces a second
// target made of its query string.
target("bare URL is not a target", `${SYNTHETIC_URL} `, "none");
target("bare URL with a terminator is not a target",
  "https://example.com/a?b=1&c=2. ", "skip:no-words");
target("the synthetic message yields one target, not two",
  `The display shows the current limit. ${SYNTHETIC_URL} `, "The display shows the current limit.");
target("a sentence containing a URL still fires",
  "See https://example.com/a?b=1 for the details. ",
  "See https://example.com/a?b=1 for the details.");
// Two words of two letters or more, ANYWHERE -- not two adjacent ones.
target("short ordinary sentence still fires", "I don't know what happened. ",
  "I don't know what happened.");

console.log("\nDegenerate input:");
split("empty", "", []);
split("whitespace only", "   ", []);
split("single short word", "Hi.", ["Hi."]);
split("no terminator", "this has no terminator at all", ["this has no terminator at all"]);
split("terminator only", "...", ["..."]);

console.log("\nOffsets round-trip:");
for (const [label, text] of [
  ["simple", "First sentence here. Second sentence here."],
  ["with abbreviation", "Dr. Smith arrived early. We started at nine."],
  ["with newline", "First paragraph text.\n\nSecond paragraph text here."],
  ["with merged short", "Ship it. I will tell the team this afternoon."],
  ["trailing whitespace", "First sentence here. Second sentence here.   "],
  ["leading whitespace", "   First sentence here. Second sentence here."],
  ["contraction", "I don't think so. Next sentence here now."],
]) offsets(`offsets: ${label}`, text);

console.log("\n" + "=".repeat(72));
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`All ${pass} checks passed.`);
