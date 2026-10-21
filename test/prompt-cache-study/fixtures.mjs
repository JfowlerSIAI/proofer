// EXPERIMENT, NOT A GATE. Synthetic text for the prompt-cache study's E1/E2
// (written for the study; no corpus text). The same 8-sentence email the
// 2026-09-24 synthetic CPU timing study used.

export const EMAIL = [
  "Hey, I wanted to folow up on the meeting from yesterday.",
  "I think we agreed to push the launch back by two weeks.",
  "Can you confirm that the vendor recieved the updated specs?",
  "They said they would send a quote by Friday but I havent seen it.",
  "If it doesnt arrive we should probably call them on Monday.",
  "Also, the budget spreadsheet has a few numbers that look off to me.",
  "Let me know when your free to go over it together.",
  "Thanks for pulling all of this together so quickly.",
];
export const EMAIL_PAGE = { hostname: "mail.google.com" };

// A second, unrelated document for the switching scenario.
export const NOTES = [
  "The garden club meets on the first Tuesday of every month.",
  "This year we are planting tomatos along the south fence.",
  "Bring gloves, a trowel and a water bottle if you can.",
  "We will also need volunteers to run the plant sale in May.",
];
export const NOTES_PAGE = { hostname: "docs.example.org", heading: "Garden club notes" };

// 2,156 characters of synthetic prior text (written for the study), so a
// shipping prompt runs past 512 tokens (902 in all).
export const LONG_DOC = [
  "Thanks again for the quick turnaround on the draft proposal last week.",
  "I went through it twice and shared it with the rest of the planning group on Thursday.",
  "Overall the structure works well, and the timeline section is much clearer than in the first version.",
  "There are a few places where I think we can tighten the wording before it goes to the board.",
  "The introduction still runs a little long, and the second paragraph repeats a point from the summary.",
  "I would also move the budget table closer to the start, since that is what most readers will look for first.",
  "On the staffing plan, we should say more about how the two new roles will be split between the offices.",
  "Maria raised a fair question about whether the training budget covers travel or only course fees.",
  "My understanding is that travel is handled separately, but it would help to state that plainly.",
  "The risk section is solid, although the mitigation for supplier delays feels a bit thin.",
  "Could we add a sentence about the backup vendor we talked to in the spring?",
  "I also noticed that the appendix still refers to the old project name in two places.",
  "That is an easy fix, but it is the kind of thing the board will notice right away.",
  "For the schedule, the dates in the summary and the Gantt chart do not quite line up for phase two.",
  "The summary says the phase ends in October, while the chart shows it running into early November.",
  "Whichever one is right, we should make them match before we send anything out.",
  "Finally, the conclusion could be a little more direct about what we are asking the board to approve.",
  "Right now it reads more like a status update than a request for a decision.",
  "None of this is major, and I think the proposal is in good shape overall.",
  "If you can make these changes by Wednesday, I will do one last read on Thursday morning.",
  "After that it should be ready to go out with the board packet on Friday.",
  "Let me know if any of this is unclear or if you would rather talk it through on a call.",
  "I am around most of Tuesday afternoon and all of Wednesday.",
  "Thanks for all the work you have put into this so far.",
  "It has been a real help to the whole team, and it shows in the draft.",
].join(" ");

/** Context the SHIPPING way for sentence k of a document typed in order:
 *  the text before it, joined with single spaces. */
export const priorOf = (sentences, k) => sentences.slice(0, k).join(" ");

/**
 * The re-layout measured on 2026-09-24 (the "~30%" figure), reproduced from
 * the throwaway scratchpad script cache-probe.mjs so E1 can explain it: the
 * shipping request with the tail of system[0] from the prior_context line on
 * moved into a second system message just before the final user turn.
 */
export function naiveRelayout(messages) {
  const m = messages.map((x) => ({ ...x }));
  const sys = m[0].content;
  const k = sys.search(/\n[^\n]*[Cc]ontext[^\n]*\n?[^\n]*$/);
  if (k > 0) {
    m[0].content = sys.slice(0, k);
    m.splice(m.length - 1, 0, { role: "system", content: sys.slice(k).trim() });
  }
  return m;
}
