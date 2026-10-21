// EXPERIMENT, NOT A GATE. Context windows for the prompt-cache study's layouts,
// built on the SHIPPING segmenter and context builder read out of content.js
// (test/lib/content-sandbox.mjs), never a copy.
//
//   shippingContext(text, start)   what content.js sends today:
//                                  sentenceContextFor (last 2,500 characters,
//                                  cut forward to a sentence boundary)
//   l3State()                      the L3 policy as a typing-order state
//                                  machine: 500-character window, jumps to a
//                                  sentence boundary leaving <= 250 characters
//   l3ContextFor(context)          the L3 window a standalone item would have
//                                  if its context had been typed in order
//                                  (used by E4, where each item is one request)
//   sentencesOf(text)              the shipping segmentation, trimmed texts

import { segmentSentences, sentenceContextFor } from "../lib/content-sandbox.mjs";
import { makeL3Window } from "./layouts.mjs";

export const shippingContext = (text, start) => sentenceContextFor(text, start);

export function sentencesOf(text) {
  return segmentSentences(text).map((s) => s.text.trim()).filter(Boolean);
}

export function boundariesOf(text) {
  return segmentSentences(text).map((s) => s.start + (s.text.length - s.text.trimStart().length));
}

export function l3ContextFor(context) {
  const text = String(context || "");
  if (!text) return "";
  const starts = boundariesOf(text);
  const w = makeL3Window();
  for (const s of starts) w(text, s, starts);
  return w(text, text.length, starts).context;
}
