#!/usr/bin/env node
// Gate for the three register preprocessors and the shared entity scrub.
//
// EVERY FIXTURE IS SYNTHETIC. No corpus text is committed — not an IRC line,
// not an Enron body, not a Stack Exchange comment. The fixtures are written to
// the SHAPES the three data cards document (`[HH:MM] <nick> text`; RFC822 with
// `-----Original Message-----` chains; blank-line-separated blocks with no
// per-comment marker), which is what the preprocessors key on. A test that
// pasted real rows in would put the corpora in git, which is the one thing
// none of these sources permits.
//
// What each section can falsify:
//   [irc]    a nick/timestamp prefix surviving into a sentence; an emote or a
//            system line read as prose; a session boundary at the wrong gap.
//   [dict]   the apt-get filter passing a command line, or rejecting ordinary
//            chat that merely contains a typo — the failure that would empty
//            the error slice.
//   [enron]  a header, a quoted chain, a forward, a signature or a table row
//            surviving into the body; a thread id that does not survive `Re:`.
//   [se]     a title, an answer, a code block or a list read as a comment.
//   [scrub]  a class not replaced; a placeholder destroyed by a later pass; a
//            date/version/IP misread as a phone.
//   [shape]  every pool's item shape is the one benchmark-sample.mjs consumes.
//
//   node test/finetune/corpus-pools-test.mjs

import {
  parseIrcDocument, ircSessionIndices, dictionaryRatioReject, targetsFromUnit,
  parseEnronMessage, cleanEnronBody, enronThreadId, splitSeComments,
  assertSeBenchmarkUse, IRC_SESSION_GAP_MS, MIN_DICT_RATIO,
} from "./corpus-pools.mjs";
import { scrubText, placeholderCount, phoneLike, handlePseudonymiser }
  from "./entity-scrub.mjs";
import { MIN_SENTENCE_CHARS } from "../harvested/discord-source.mjs";

let pass = 0, fail = 0;
const fails = [];
const ok = (c, name, detail) => {
  if (c) { pass++; return true; }
  fail++; fails.push(name + (detail ? " — " + detail : "")); return false;
};
const eq = (a, b, name) =>
  ok(a === b, name, a === b ? "" : `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const deepEq = (a, b, name) => eq(JSON.stringify(a), JSON.stringify(b), name);

// ==================================================================== [irc]
{
  const doc = [
    "[09:00] === alice [~a@host] has joined #chan",
    "[09:01] <alice> I think the installer is broken on this release.",
    "[09:01]  * alice waves",
    "[09:02] <bob> alice: did you try the recovery mode option first?",
    "[09:03] -!- bob has quit",
    "[10:05] <carol> Sorry, I was away for a bit there.",
    "",
    "not a log line at all",
  ].join("\n");
  const msgs = parseIrcDocument(doc);
  eq(msgs.length, 3, "[irc] only real messages survive");
  eq(msgs[0].nick, "alice", "[irc] nick parsed");
  eq(msgs[0].text, "I think the installer is broken on this release.",
    "[irc] the timestamp and nick prefix are STRIPPED, not kept");
  ok(!msgs.some((m) => /^\[\d\d:\d\d\]/.test(m.text)), "[irc] no timestamp leaks into text");
  ok(!msgs.some((m) => /waves/.test(m.text)), "[irc] an emote is dropped, not stripped");
  ok(!msgs.some((m) => /has joined|has quit/.test(m.text)), "[irc] system lines dropped");
  eq(msgs[0].minutes, 9 * 60 + 1, "[irc] minutes from the timestamp");

  const sessions = ircSessionIndices(msgs);
  deepEq(sessions, [0, 0, 1],
    `[irc] a gap over ${IRC_SESSION_GAP_MS / 60000} min opens a new session`);
  const tight = ircSessionIndices([{ minutes: 0 }, { minutes: 29 }, { minutes: 58 }]);
  deepEq(tight, [0, 0, 0], "[irc] consecutive sub-gap messages stay in one session");
  const exact = ircSessionIndices([{ minutes: 0 }, { minutes: 30 }, { minutes: 61 }]);
  deepEq(exact, [0, 0, 1], "[irc] the gap boundary is exclusive, not off by one");
  deepEq(ircSessionIndices([]), [], "[irc] an empty day has no sessions");

  // The shape the parser must NOT accept: a bare line with no timestamp.
  eq(parseIrcDocument("just some text\n<alice> hi").length, 0,
    "[irc] a line with no timestamp is not a message");
  eq(parseIrcDocument("").length, 0, "[irc] empty document");
}

// =================================================================== [dict]
{
  eq(dictionaryRatioReject("I think the installer is broken on this release."), null,
    "[dict] ordinary chat passes");
  eq(dictionaryRatioReject("I think the instaler is broken on this release."), null,
    "[dict] ordinary chat WITH A TYPO still passes — the filter is a register "
    + "filter, not a correctness one");
  ok(!!dictionaryRatioReject("sudo apt-get install libgtk2.0-dev xserver-xorg-video-intel"),
    "[dict] an apt-get line is rejected");
  ok(!!dictionaryRatioReject("hi"), "[dict] too few words is rejected");
  eq(dictionaryRatioReject("hi"), "too-few-words", "[dict] and NAMES the reason");
  eq(dictionaryRatioReject("sudo apt-get install libgtk2.0-dev xserver-xorg-video-intel"),
    "low-dictionary-ratio", "[dict] the ratio rejection names itself");
  ok(MIN_DICT_RATIO > 0.5 && MIN_DICT_RATIO < 1, "[dict] the threshold is a ratio");
}

// ================================================================== [enron]
{
  const raw = [
    "Message-ID: <12345.1075855679981.JavaMail.evans@thyme>",
    "Date: Tue, 5 Dec 2000 07:31:00 -0800 (PST)",
    "From: first.person@example.com",
    "To: second.person@example.com",
    "Subject: Re: Quarterly headcount",
    "X-From: First Person",
    "X-To: Second Person",
    "X-Folder: \\Some_Folder\\Sent",
    "",
    "Thanks for putting the numbers together so quickly.",
    "I think we should walk through them before the meeting on Thursday.",
    "",
    "West Desk    14     Mid Market    16",
    "1 2 3 4 5 6 7 8 9 10",
    "",
    "Regards,",
    "First",
    "",
    "-----Original Message-----",
    "From: someone.else@example.com",
    "Sent: Monday, December 04, 2000 9:12 AM",
    "Please send me the headcount by close of business.",
  ].join("\n");

  const { headers, body } = parseEnronMessage(raw);
  eq(headers["message-id"], "<12345.1075855679981.JavaMail.evans@thyme>", "[enron] message-id");
  eq(headers.subject, "Re: Quarterly headcount", "[enron] subject");
  ok(!/^Message-ID/m.test(body), "[enron] headers are not in the body");

  const clean = cleanEnronBody(body);
  ok(/Thanks for putting the numbers together/.test(clean), "[enron] prose survives");
  ok(/walk through them before the meeting/.test(clean), "[enron] second prose line survives");
  ok(!/West Desk/.test(clean), "[enron] a TABLE ROW is dropped");
  ok(!/1 2 3 4 5/.test(clean), "[enron] a digit row is dropped");
  ok(!/Regards/.test(clean), "[enron] the signature block is cut");
  ok(!/Original Message/.test(clean), "[enron] the quoted-chain banner is cut");
  ok(!/close of business/.test(clean), "[enron] the QUOTED CHAIN ITSELF is cut, "
    + "not just its banner");
  ok(!/someone\.else@/.test(clean), "[enron] the quoted headers go with it");

  // Forward banner, `>` quoting, quoted-printable, [IMAGE].
  const fwd = cleanEnronBody([
    "Here is my own note about the schedule change.",
    "[IMAGE] [IMAGE]",
    "> they said it moved to Friday",
    "Some line with =20 soft breaks in it",
    "---------------------- Forwarded by Someone/HOU/ECT on 01/01/2001 ---",
    "This paragraph belongs to the forwarded message entirely.",
  ].join("\n"));
  ok(/my own note about the schedule change/.test(fwd), "[enron] own prose kept");
  ok(!/moved to Friday/.test(fwd), "[enron] `>` quoted lines dropped");
  ok(!/soft breaks/.test(fwd), "[enron] quoted-printable artefacts dropped");
  ok(!/belongs to the forwarded message/.test(fwd), "[enron] the forward is cut");
  ok(!/\[IMAGE\]/.test(fwd), "[enron] image markers removed");

  // Thread identity survives Re:/Fwd: and does not collide across subjects.
  const a = enronThreadId({ subject: "Quarterly headcount", from: "a@x.com", to: "b@x.com" });
  const b = enronThreadId({ subject: "RE: Quarterly headcount", from: "a@x.com", to: "b@x.com" });
  const c = enronThreadId({ subject: "Fwd:  Re: quarterly HEADCOUNT ", from: "b@x.com", to: "a@x.com" });
  const d = enronThreadId({ subject: "Something else", from: "a@x.com", to: "b@x.com" });
  eq(a, b, "[enron] `Re:` does not start a new thread");
  eq(a, c, "[enron] nested prefixes, case and participant order all normalise");
  ok(a !== d, "[enron] a different subject is a different thread");
  ok(/^enron:/.test(a), "[enron] thread ids are namespaced");

  const empty = parseEnronMessage("no headers at all, just text");
  eq(empty.body, "", "[enron] a message with no header/body break has no body");
}

// ===================================================================== [se]
{
  const text = [
    "How do I level a heated bed?",
    "",
    "I have a printer with a glass bed and I cannot get the first layer to stick "
    + "anywhere near the front left corner. What should I try first?",
    "",
    "Start with a paper-thickness gap at each corner and repeat the pass twice.",
    "",
    "    G28 ; home all axes",
    "    G29 ; auto bed level",
    "",
    "- check the springs",
    "- check the nozzle",
    "",
    "> quoting the question here",
    "",
    "Did you try turning the bed temperature up by five degrees first?",
    "",
    "See [the docs](https://example.com/docs) for the full procedure here now.",
    "",
    "ok",
  ].join("\n");
  const cs = splitSeComments(text);
  const texts = cs.map((c) => c.text);
  ok(!texts.some((t) => /How do I level/.test(t)), "[se] the TITLE block is never a comment");
  ok(texts.some((t) => /paper-thickness gap/.test(t)), "[se] a one-line comment is taken");
  ok(texts.some((t) => /bed temperature up by five/.test(t)), "[se] a second one is taken");
  ok(!texts.some((t) => /G28/.test(t)), "[se] an indented code block is not a comment");
  ok(!texts.some((t) => /check the springs/.test(t)), "[se] a list is not a comment");
  ok(!texts.some((t) => /quoting the question/.test(t)), "[se] a blockquote is not a comment");
  ok(!texts.some((t) => /the docs/.test(t)), "[se] markdown link markup is refused");
  ok(!texts.some((t) => t === "ok"), "[se] a runt block is refused");
  ok(!texts.some((t) => /cannot get the first layer/.test(t)),
    "[se] the question BODY block is refused — a length window alone reads it "
    + "as a comment", texts.join(" | "));
  ok(cs.every((c) => c.index >= 2), "[se] indices start past the title and the body");
  ok(!splitSeComments([
    "Title here",
    "",
    "body",
    "",
    "One sentence. Two sentences. Three sentences here, which is expository prose.",
  ].join("\n")).some((c) => /Three sentences/.test(c.text)),
  "[se] a three-sentence block is expository prose, not a comment");
  eq(splitSeComments("").length, 0, "[se] empty document");

  let threw = false;
  const realExit = process.exit;
  process.exit = () => { threw = true; throw new Error("exit"); };
  try { assertSeBenchmarkUse("training"); } catch { /* expected */ }
  process.exit = realExit;
  ok(threw, "[se] the pool REFUSES a training purpose (CC BY-SA, benchmark only)");
  assertSeBenchmarkUse("benchmark");
  ok(true, "[se] and permits the benchmark purpose");
}

// ================================================================== [scrub]
{
  const r = scrubText(
    "Mail me at first.last@example.com or ring 555 123 4567, see "
    + "https://example.com/a?b=1 and www.example.org, box is 192.168.1.10, "
    + "ftp://files.example.net has it, or try example.com/page.");
  ok(!/first\.last@/.test(r.text), "[scrub] email replaced");
  ok(!/555 123 4567/.test(r.text), "[scrub] phone replaced");
  ok(!/https:\/\//.test(r.text), "[scrub] URL replaced");
  ok(!/www\./.test(r.text), "[scrub] bare www replaced");
  ok(!/192\.168\.1\.10/.test(r.text), "[scrub] IPv4 replaced");
  ok(!/ftp:\/\//.test(r.text), "[scrub] non-http scheme replaced");
  ok(!/example\.com\/page/.test(r.text), "[scrub] schemeless domain replaced");
  ok(r.hits.email >= 1 && r.hits.phone >= 1 && r.hits.url >= 1 && r.hits.ip >= 1,
    "[scrub] every class is COUNTED, so a caller can drop over-redacted text",
    JSON.stringify(r.hits));
  ok(placeholderCount(r.text) >= 6, "[scrub] placeholderCount sees them all",
    String(placeholderCount(r.text)));
  ok(!/<PHONE>[A-Za-z]|[A-Za-z]<PHONE>/.test(r.text), "[scrub] placeholders are not glued into words");

  // The S1 bug this ordering exists to avoid: a numeric pass eating a
  // placeholder that sits next to a number.
  const near = scrubText("ping https://example.com 2027 2028 and stop");
  ok(/<URL>/.test(near.text), "[scrub] the URL placeholder SURVIVES the phone pass",
    near.text);

  eq(scrubText("nothing to see here at all").text, "nothing to see here at all",
    "[scrub] clean text is byte-identical");
  const keep = scrubText("see https://example.com/x now", { keepUrls: true });
  ok(/https:\/\/example\.com\/x/.test(keep.text), "[scrub] keepUrls opts out");

  ok(phoneLike("555 123 4567"), "[scrub] a phone window is a phone");
  ok(!phoneLike("2001-09-11"), "[scrub] an ISO date is not");
  ok(!phoneLike("192.168.1.10"), "[scrub] an IP is not");
  ok(!phoneLike("1.2.3.4.5"), "[scrub] a version is not");
  ok(!phoneLike("1999 - 2004"), "[scrub] a year range is not");
  ok(!phoneLike("12345"), "[scrub] too few digits is not");

  const p = handlePseudonymiser(["alice", "bob", "dark-sun", "dark-sun0"]);
  const out = p.apply("alice: did dark-sun0 or dark-sun ping bob about this?");
  ok(!/alice|bob|dark-sun/.test(out), "[scrub] every handle pseudonymised", out);
  ok(/NICK_\d/.test(out), "[scrub] pseudonyms are stable tokens", out);
  const again = handlePseudonymiser(["bob", "alice", "dark-sun0", "dark-sun"]);
  eq(again.apply("alice and bob"), p.apply("alice and bob"),
    "[scrub] the mapping does not depend on input order");
  eq(p.apply("malice is not alice").includes("malice"), true,
    "[scrub] a handle inside a word is left alone");
  eq(handlePseudonymiser([]).apply("nothing here"), "nothing here",
    "[scrub] no handles is a no-op");
}

// ================================================================== [shape]
{
  const text = "The techncian arrived early. We recieved the invoice later on.";
  const items = targetsFromUnit(text, "some prior line", {
    source_document_id: "irc:doc#3", exclusion_group_id: "irc:ab:2015-01-01:0",
  });
  ok(items.length >= 2, "[shape] the SHIPPING segmenter cut two sentences", String(items.length));
  for (const it of items) {
    for (const k of ["sentence", "context_2500", "source_document_id",
      "exclusion_group_id", "segment_start", "segment_end", "segmenterProduced"]) {
      ok(k in it, `[shape] item carries ${k}`);
    }
    ok(it.sentence.length >= MIN_SENTENCE_CHARS,
      "[shape] every target clears MIN_SENTENCE_CHARS");
    ok(it.context_2500.length <= 2500, "[shape] context is the production 2500-char tail");
  }
  ok(items[0].context_2500.startsWith("some prior line"),
    "[shape] prior text leads the context");
  ok(items[1].context_2500.includes("The techncian arrived early."),
    "[shape] the earlier part of the SAME unit is in the later sentence's context");
  ok(items[1].segmenterProduced, "[shape] a non-initial segment is segmenter-produced");
  eq(targetsFromUnit("hi", "", { source_document_id: "x", exclusion_group_id: "y" }).length, 0,
    "[shape] a runt yields no target");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log("  FAIL " + f); process.exit(1); }
