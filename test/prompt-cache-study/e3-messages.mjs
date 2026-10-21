#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Builds the realistic-typing input for E3 of the
// prompt-cache study: twenty real 8-sentence emails, typed in order.
//
// Source: the frozen benchmark's email-workplace candidates
// (test/harvested/finetune/benchmark-candidates-email-workplace.jsonl: Enron
// sent mail). Each candidate carries `context_2500`, the text of its email
// before the candidate sentence. An email qualifies when
//   - context_2500 is shorter than 2,500 characters (so it starts at the top of
//     the email, not mid-text),
//   - context_2500 + sentence segments (with the SHIPPING segmenter) into at
//     least 8 sentences, and
//   - each of those first 8 segments is 10..400 characters.
// One candidate per email (the one giving the longest text). Twenty emails are
// taken in order of sha256(source_document_id), so the choice is fixed and
// reproducible without looking at the text. The long-document rollover
// scenario concatenates the twenty emails (first 8 sentences each, blank line
// between) into one document and measures its sentences 32..63, which carries
// the text before the sentence past the 2,500-character shipping window.
//
// Output (PRIVATE -- corpus text): <RAW>/e3-messages.json, mode 0600.
//   node e3-messages.mjs [--raw <dir>]

import { readFileSync, writeFileSync, chmodSync } from "fs";
import { createHash } from "crypto";
import { segmentSentences } from "../lib/content-sandbox.mjs";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const { RAW: RAW_DEFAULT, FT } = await import("./paths.mjs");
const RAW = arg("--raw", RAW_DEFAULT);
const SRC = `${FT}/benchmark-candidates-email-workplace.jsonl`;

const rows = readFileSync(SRC, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byDoc = new Map();
for (const r of rows) {
  const ctx = r.context_2500 || "";
  if (ctx.length >= 2500) continue;
  const text = ctx + (ctx && !/\s$/.test(ctx) ? " " : "") + r.sentence;
  const segs = segmentSentences(text).map((s) => ({ start: s.start + (s.text.length - s.text.trimStart().length), text: s.text.trim() }));
  if (segs.length < 8) continue;
  const first8 = segs.slice(0, 8);
  if (!first8.every((s) => s.text.length >= 10 && s.text.length <= 400)) continue;
  const doc = r.source.source_document_id;
  const prev = byDoc.get(doc);
  if (!prev || text.length > prev.text.length) byDoc.set(doc, { doc, text, segs });
}
const h = (s) => createHash("sha256").update(s).digest("hex");
const eligible = [...byDoc.values()].sort((a, b) => (h(a.doc) < h(b.doc) ? -1 : 1));
const chosen = eligible.slice(0, 20).map((d, i) => ({
  id: `email-${String(i).padStart(2, "0")}`, docHash: h(d.doc).slice(0, 12), text: d.text,
  sentences: d.segs.slice(0, 8),
}));

// rollover document: the twenty emails joined by a blank line, re-segmented
const longText = chosen.map((d) => d.text.slice(0, d.sentences[7].start + d.sentences[7].text.length)).join("\n\n");
const longSegs = segmentSentences(longText).map((s) => ({ start: s.start + (s.text.length - s.text.trimStart().length), text: s.text.trim() }));
const ROLL_FROM = 32, ROLL_N = 32;

const out = { source: "benchmark-candidates-email-workplace.jsonl", eligible: eligible.length, messages: chosen,
  rollover: { id: "rollover", text: longText, sentences: longSegs, measureFrom: ROLL_FROM, measureN: ROLL_N } };
writeFileSync(`${RAW}/e3-messages.json`, JSON.stringify(out, null, 1), { mode: 0o600 });
chmodSync(`${RAW}/e3-messages.json`, 0o600);
const lens = chosen.map((d) => d.sentences.map((s) => s.text.length));
console.log(`eligible emails ${eligible.length}; chose ${chosen.length}; sentence chars median ` +
  `${lens.flat().sort((a, b) => a - b)[Math.floor(lens.flat().length / 2)]}; ` +
  `text chars to sentence 8: ${chosen.map((d) => d.sentences[7].start + d.sentences[7].text.length).join(",")}`);
console.log(`rollover doc: ${longText.length} chars, ${longSegs.length} sentences; measuring ${ROLL_FROM}..${ROLL_FROM + ROLL_N - 1}, ` +
  `text before them ${longSegs[ROLL_FROM].start}..${longSegs[ROLL_FROM + ROLL_N - 1].start} chars`);
