// EXPERIMENT, NOT A GATE. Candidate sentence-mode prompt layouts for the
// 2026-09-24 prompt-cache study (see TESTING.md §29).
//
// Every piece of prompt TEXT here is read out of the shipping background.js in
// a vm (the same trick as test/lib/sentence-guards.mjs), never retyped:
//
//   - L0 IS prepareSentenceRequest / buildSentenceRetryMessages, byte for byte;
//   - the other layouts rearrange the shipping pieces, which are DERIVED by
//     calling the shipping builders and slicing their output (asserted below):
//       INSTR       the first system turn minus its trailing page-context line
//       hostLine    buildContextLine(pageContext) -- "writing on <host>" + heading
//       ctxLine     contextTurn(text) -- `prior_context: "<json>"`
//       keepSuffix  what buildSentenceRetryMessages appends for a retry
//       SHOT        SENTENCE_CONTEXT_SHOT's three turns
//       DEMOS       SENTENCE_FEW_SHOT's fourteen turns
//
// So a change to the shipping prompt moves every layout with it, and a change
// to its SHAPE (the slicing no longer lines up) throws instead of measuring a
// prompt nobody wrote.
//
// Layouts (V = the variable block: host line [+ heading], prior_context line
// when there is context, retry keep-list when retrying):
//
//   L0        shipping. V is spread through system[0]; the context
//             demonstration appears only when there is context.
//   L1p-sys   [system INSTR] SHOT DEMOS [system V] [user S]
//   L1a-sys   [system INSTR]      DEMOS [system V] [user S]
//   L2-sys    [system INSTR]            [system V] [user S]
//   L1p-post  [system INSTR] SHOT DEMOS [user S] [system V]
//   L1a-post, L2-post       the same with the demonstrations cut as above
//   L1p-usr   [system INSTR] SHOT DEMOS [user V "\n\n" S]
//   L3-*      L1p with the L3 context policy (see l3Context): a 500-character
//             window trimmed in whole-sentence jumps, so between jumps the
//             context only grows at its end.
//   L4-conv, L2-conv  study additions (see below LAYOUTS): the L3 window's
//             sentences as one user turn each, with (L4) or without (L2) the
//             demonstrations.
//
// "p" = the context demonstration (SHOT) ALWAYS present, "a" = always absent,
// so in L1/L3 the fixed part never changes between sentences.
// -sys/-post/-usr is WHERE V goes. The placement is not cosmetic: the runtime
// Ollama 0.32.12 uses (its bundled llama-server) can resume this hybrid model
// only from a context checkpoint, and it creates checkpoints at user-message
// starts, not at system-message starts -- see the study report.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "..", "background.js"), "utf8");
const noop = () => {};
const ctx = vm.createContext({
  chrome: {
    runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop }, getURL: (p) => p },
    storage: { local: { get: (k, cb) => cb({}), set: noop, remove: noop } },
    tabs: { create: noop },
  },
  console, fetch, setTimeout, clearTimeout, AbortController, URL,
  crypto: globalThis.crypto, TextEncoder,
});
vm.runInContext(src + `
;globalThis.__pl = {
  buildContextLine, contextTurn, buildSentenceMessages,
  prepareSentenceRequest, buildSentenceRetryMessages,
  SENTENCE_FEW_SHOT, SENTENCE_CONTEXT_SHOT, SENTENCE_CONTEXT_CHARS, SENTENCE_NUM_CTX,
};`, ctx);

export const {
  buildContextLine, contextTurn, buildSentenceMessages, prepareSentenceRequest,
  buildSentenceRetryMessages, SENTENCE_FEW_SHOT, SENTENCE_CONTEXT_SHOT,
  SENTENCE_CONTEXT_CHARS, SENTENCE_NUM_CTX,
} = ctx.__pl;

// vm objects carry the vm's prototypes; JSON round-trip makes them plain.
const plain = (x) => JSON.parse(JSON.stringify(x));

export const MODEL = "proofer-pilot-q4:v1";

// ------------------------------------------------------------ derived pieces

function derivePieces() {
  const page = { hostname: "example.invalid" };
  const line = buildContextLine(page);
  const bare = plain(buildSentenceMessages("S", "", page, MODEL));
  const sys0 = bare[0].content;
  if (!sys0.endsWith("\n\n" + line)) throw new Error("system[0] no longer ends with the page-context line; update layouts.mjs");
  const INSTR = sys0.slice(0, -("\n\n" + line).length);

  const withCtx = plain(buildSentenceMessages("S", "C", page, MODEL));
  if (withCtx[0].content !== sys0 + "\n\n" + contextTurn("C"))
    throw new Error("system[0] with context is no longer INSTR + host line + prior_context; update layouts.mjs");
  const SHOT = withCtx.slice(1, 4);
  if (SHOT.map((m) => m.role).join() !== "system,user,assistant" || SHOT[0].content !== contextTurn(SENTENCE_CONTEXT_SHOT.context))
    throw new Error("context demonstration is no longer messages[1..3]; update layouts.mjs");
  const DEMOS = withCtx.slice(4, -1);
  if (DEMOS.length !== 2 * SENTENCE_FEW_SHOT.length) throw new Error("demonstration count drifted");
  if (JSON.stringify(bare.slice(1, -1)) !== JSON.stringify(DEMOS)) throw new Error("no-context demos differ from context demos");

  const retry = plain(buildSentenceRetryMessages("S", "", page, MODEL, ["k1", "k2"]));
  if (!retry[0].content.startsWith(sys0)) throw new Error("retry no longer appends to system[0]");
  const keepTail = retry[0].content.slice(sys0.length); // "\n\nDo not change ... "k1", "k2"."
  const keyAt = keepTail.indexOf('"k1"');
  if (keyAt < 0 || !keepTail.endsWith('"k2".')) throw new Error("keep-list shape drifted");
  const keepHead = keepTail.slice(0, keyAt);           // "\n\nDo not change these words; keep each exactly as written: "
  const keepSuffix = (keeps) => keeps && keeps.length
    ? keepHead + keeps.map((k) => JSON.stringify(String(k))).join(", ") + "." : "";
  // Round-trip check: the derived keep suffix reproduces the shipping one.
  if (keepSuffix(["k1", "k2"]) !== keepTail) throw new Error("keepSuffix does not reproduce the shipping keep-list");
  return { INSTR, SHOT, DEMOS, keepSuffix };
}

export const PIECES = derivePieces();

// --------------------------------------------------------- L3 context policy
//
// A 500-character window that only moves in jumps. While the text before the
// sentence fits, the whole of it is the context (append-only as the user types
// on). When it would exceed L3_WINDOW, the window start jumps forward to the
// first sentence boundary at or after (end - L3_TARGET), so the context drops
// to <= L3_TARGET characters and can then grow again for several sentences
// before the next jump. `boundaries` are the sentence-start offsets of the text
// (from the shipping segmenter); a cut is only ever made at one of them.
export const L3_WINDOW = 500;
export const L3_TARGET = 250;

export function makeL3Window() {
  let start = 0;
  return function l3Context(text, sentenceStart, boundaries) {
    // text: the document so far; sentenceStart: offset of the sentence being
    // checked; boundaries: sorted sentence-start offsets (< sentenceStart).
    if (start > sentenceStart) start = 0;              // document changed under us
    if (sentenceStart - start > L3_WINDOW) {
      const want = sentenceStart - L3_TARGET;
      const b = boundaries.find((o) => o >= want && o < sentenceStart);
      start = b !== undefined ? b : sentenceStart;     // nothing fits: empty context
    }
    return { context: text.slice(start, sentenceStart).trim(), start };
  };
}

// ------------------------------------------------------------------ layouts

export const LAYOUTS = [
  "L0", "L1p-sys", "L1a-sys", "L2-sys", "L1p-post", "L1a-post", "L2-post", "L1p-usr",
  "L3-sys", "L3-post", "L4-conv", "L2-conv",
];

/** Layouts whose context is the L3 jump window (L3-*, and both conversation layouts). */
export const usesL3Window = (layout) => layout.startsWith("L3") || layout.endsWith("-conv");
/** Layouts that take the context as one user turn per earlier sentence. */
export const isConv = (layout) => layout.endsWith("-conv");

// L4-conv -- NOT one of the plan's layouts; added by the study after E1 showed
// that on this runtime no placement of a JSON context block can be resumed past
// its start. The prior text arrives as one USER turn per earlier sentence, so
// the previous request's whole prompt (up to its last few tokens) is a prefix of
// the next one and the runtime's end-of-prompt checkpoint is usable:
//
//   [system INSTR] SHOT DEMOS [system hostLine] [user c1] ... [user cm] [user S]
//   (+ [system keepSuffix] after S when retrying)
//
// The caller passes the context as `contextSentences` (the L3 window's
// sentences, in order). The pilot has never seen this shape.
//
// L2-conv -- also a study addition, made after E3 showed L4-conv's weak spot:
// L4's fixed part contains the demonstration turns, so the first user-message
// start (a checkpoint the runtime always keeps) is the first demonstration,
// and a new document, a switch between documents or an edit to the context
// falls back there and re-reads the demonstrations. With no demonstrations the
// first user-message start is the first context sentence, i.e. the end of the
// fixed part:
//
//   [system INSTR] [system hostLine] [user c1] ... [user cm] [user S]
//   (+ [system keepSuffix] after S when retrying)

function vBlock(priorContext, pageContext, keeps) {
  return buildContextLine(pageContext)
    + (priorContext ? "\n\n" + contextTurn(priorContext) : "")
    + PIECES.keepSuffix(keeps);
}

/**
 * messages for one request.
 *   layout       one of LAYOUTS
 *   sentence     the sentence being checked (bare, as shipped)
 *   priorContext the context text for THIS layout's window (the caller applies
 *                the window: shipping sentenceContextFor for L0-L2, l3Context
 *                for L3)
 *   pageContext  {hostname, heading}
 *   keeps        retry keep-list, or null for a first pass
 */
export function layoutMessages(layout, { sentence, priorContext = "", contextSentences = null, pageContext, keeps = null, model = MODEL }) {
  if (layout === "L4-conv" || layout === "L2-conv") {
    const { INSTR, SHOT, DEMOS, keepSuffix } = PIECES;
    const turns = (contextSentences || []).map((c) => ({ role: "user", content: c }));
    const demos = layout === "L4-conv" ? [...SHOT, ...DEMOS] : [];
    const out = [{ role: "system", content: INSTR }, ...demos,
      { role: "system", content: buildContextLine(pageContext) }, ...turns, { role: "user", content: sentence }];
    if (keeps && keeps.length) out.push({ role: "system", content: keepSuffix(keeps).replace(/^\n\n/, "") });
    return plain(out);
  }
  if (layout === "L0") {
    return plain(keeps && keeps.length
      ? buildSentenceRetryMessages(sentence, priorContext, pageContext, model, keeps)
      : buildSentenceMessages(sentence, priorContext, pageContext, model));
  }
  const m = /^(L1p|L1a|L2|L3)-(sys|post|usr)$/.exec(layout);
  if (!m) throw new Error(`unknown layout ${layout}`);
  const [, family, place] = m;
  const { INSTR, SHOT, DEMOS } = PIECES;
  const fixed = [{ role: "system", content: INSTR }];
  if (family === "L1p" || family === "L3") fixed.push(...SHOT);
  if (family !== "L2") fixed.push(...DEMOS);
  const V = vBlock(priorContext, pageContext, keeps);
  if (place === "sys") return plain([...fixed, { role: "system", content: V }, { role: "user", content: sentence }]);
  if (place === "post") return plain([...fixed, { role: "user", content: sentence }, { role: "system", content: V }]);
  return plain([...fixed, { role: "user", content: V + "\n\n" + sentence }]);
}

/** The full /api/chat body: the shipping request with only `messages` swapped. */
export function layoutBody(layout, args) {
  const req = prepareSentenceRequest(args.sentence, args.priorContext || "", args.pageContext,
    { ollamaModel: args.model || MODEL });
  const body = plain(req.body);
  body.messages = layoutMessages(layout, args);
  return body;
}

// Self-check: L0 through layoutBody is byte-identical to prepareSentenceRequest.
{
  const a = { sentence: "Teh cat sat.", priorContext: "Earlier text.", pageContext: { hostname: "mail.example", heading: "Re: x" } };
  const ship = JSON.stringify(plain(prepareSentenceRequest(a.sentence, a.priorContext, a.pageContext, { ollamaModel: MODEL }).body));
  if (JSON.stringify(layoutBody("L0", a)) !== ship) throw new Error("L0 is not the shipping request");
}
