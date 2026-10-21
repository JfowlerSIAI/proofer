// The three non-owner register pools behind `poolFor()` in benchmark-sample.mjs
// — S2 Ubuntu IRC, S3 Enron email, and the Stack Exchange comment slice.
//
// Every pool returns the SAME shape `chat-owner` returns, because the sampler,
// the quota engine, the screens and the injection frames are register-agnostic
// by construction and adding a register must not mean adding a code path:
//
//   { items, episodes, corpus, benchmarkOnly?, funnel }
//   item = { sentence, context_2500, source_document_id, exclusion_group_id,
//            segment_start, segment_end, segmenterProduced }
//   episodes = Map exclusion_group_id -> source_document_id[]   (reservation unit)
//   funnel   = ordered [stage, count] survival record, printed by the sampler
//
// THREE THINGS ARE SHARED WITH chat-owner AND ARE NOT RE-IMPLEMENTED HERE: the
// shipping segmenter (`segmentSentences`), the sentence-length window
// (`MIN_SENTENCE_CHARS` / `MAX_TARGET`), and the 2,500-character production
// context tail. A register whose sentences were cut by a different segmenter is
// not measuring the same task.
//
// PREPROCESSING DIFFERS BY SOURCE:
// nick/timestamp stripping and a non-dictionary-token-ratio filter for S2;
// header, signature and quoted-chain stripping for S3; a shape split for SE,
// whose comments are concatenated into `text` with no per-line marker (its data
// card says so explicitly — there is no `comments` field to read).
//
// PII/entity scrub runs on all three (audit finding 18) through
// `entity-scrub.mjs`. `scrub-discord.mjs` is NOT edited and NOT imported: it
// exports nothing, and its detectors are entangled with a reversible pseudonym
// map that belongs to S1's training contract. The classes are mirrored; the
// divergence is documented in entity-scrub.mjs's header.
//
// No side effects at import: every pool is a function, and the corpora are read
// only when one is called.

import { readFileSync, readdirSync, statSync, existsSync, createReadStream } from "fs";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { segmentSentences } from "../lib/content-sandbox.mjs";
import { isWord } from "../lib/sentence-guards.mjs";
import {
  MIN_SENTENCE_CHARS, MAX_TARGET, CONTEXT_CHARS, CONTEXT_WINDOW_MS,
} from "../harvested/discord-source.mjs";
import { scrubText, placeholderCount, handlePseudonymiser } from "./entity-scrub.mjs";

export const CORPORA_ROOT = process.env.PROOFER_CORPORA
  ?? join(homedir(), "proofer-finetune", "corpora");

const die = (msg) => { console.error("corpus-pools: " + msg); process.exit(1); };

// ---------------------------------------------------------------- shared bits

/** Session gap for IRC, matching the repo's own context window (30 min). Using
 *  a DIFFERENT constant here would mean an episode that is not a superset of
 *  the context windows built inside it, which is the property that makes the
 *  reservation file complete. */
export const IRC_SESSION_GAP_MS = CONTEXT_WINDOW_MS;

/** At least this share of a line's alphabetic tokens must be dictionary words.
 *  This filters command-heavy lines using data/words-en.txt and the guard
 *  tokenizer. 0.70 was chosen against the measured IRC yield curve (see the funnel
 *  the sampler prints); it is a REGISTER filter, not a correctness one, so a
 *  sentence with a genuine typo still passes at four content words. */
export const MIN_DICT_RATIO = 0.70;
export const MIN_ALPHA_TOKENS = 4;

const ALPHA_TOKEN = /[A-Za-z][A-Za-z'’-]*/g;

/** The dictionary-ratio register filter. Returns null when the line passes,
 *  or the reason it did not. */
export function dictionaryRatioReject(text) {
  const toks = String(text).match(ALPHA_TOKEN) || [];
  if (toks.length < MIN_ALPHA_TOKENS) return "too-few-words";
  let known = 0;
  for (const t of toks) {
    const b = t.replace(/[’]/g, "'").toLowerCase();
    if (isWord(b) || isWord(b.replace(/'s$/, "")) || (b.endsWith("s") && isWord(b.slice(0, -1)))) known++;
  }
  return known / toks.length >= MIN_DICT_RATIO ? null : "low-dictionary-ratio";
}

const shortHash = (s, n = 10) => createHash("sha1").update(String(s)).digest("hex").slice(0, n);

/**
 * Sentence targets out of one text unit, built exactly as `targetsFor` builds
 * them for chat-owner: the shipping segmenter, the same length window, and a
 * context that is prior text plus the earlier part of this unit, tail-trimmed
 * to CONTEXT_CHARS.
 */
export function targetsFromUnit(text, priorBase, meta) {
  const out = [];
  for (const s of segmentSentences(text)) {
    const t = s.text.trim();
    if (t.length < MIN_SENTENCE_CHARS || t.length > MAX_TARGET) continue;
    const ctx = (priorBase ? priorBase + "\n" : "") + text.slice(0, s.start);
    out.push({
      sentence: t,
      context_2500: ctx.slice(-CONTEXT_CHARS),
      source_document_id: meta.source_document_id,
      exclusion_group_id: meta.exclusion_group_id,
      segment_start: s.start,
      segment_end: s.end,
      segmenterProduced: s.start > 0 || s.end < text.length,
    });
  }
  return out;
}

function funnelRecorder() {
  const rows = [];
  return {
    rows,
    note(stage, n) { rows.push([stage, n]); },
  };
}

// =====================================================================
// S2 — Ubuntu IRC
// =====================================================================

const IRC_DIR = join(CORPORA_ROOT, "s2-ubuntu-irc");
const IRC_SHARDS = [
  "ubuntu-chat-dolma-0000.json.gz",
  "ubuntu-chat-dolma-0001.json.gz",
  "ubuntu-chat-dolma-0002.json.gz",
];

// `[HH:MM] <nick> text` is the message shape. `[HH:MM]  * nick action` is an
// emote and `[HH:MM] === ...` / `-!-` are system lines; neither is prose the
// user typed as a sentence, so both are dropped rather than stripped.
const IRC_MSG_RE = /^\[(\d{2}):(\d{2})\]\s+<([^>\s]+)>\s?(.*)$/;
const IRC_EMOTE_RE = /^\[(\d{2}):(\d{2})\]\s+\*\s/;
const IRC_SYSTEM_RE = /^\[(\d{2}):(\d{2})\]\s+(===|-!-|\*\*\*)/;

/**
 * Split one common-pile IRC document (a channel-DAY) into stripped messages.
 * Exported for the unit test — the fixture is synthetic, this file carries no
 * corpus text.
 *
 * @returns {{ index: number, minutes: number, nick: string, text: string }[]}
 */
export function parseIrcDocument(rawText) {
  const out = [];
  const lines = String(rawText ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (IRC_SYSTEM_RE.test(line) || IRC_EMOTE_RE.test(line)) continue;
    const m = IRC_MSG_RE.exec(line);
    if (!m) continue;                       // a continuation or an unknown shape
    const text = m[4].trim();
    if (!text) continue;
    out.push({
      index: i,
      minutes: Number(m[1]) * 60 + Number(m[2]),
      nick: m[3],
      text,
    });
  }
  return out;
}

/** Session blocks inside one channel-day: a new block whenever the gap between
 *  consecutive kept messages exceeds IRC_SESSION_GAP_MS. */
export function ircSessionIndices(messages) {
  const gapMin = IRC_SESSION_GAP_MS / 60000;
  let idx = 0, prev = null;
  return messages.map((m) => {
    if (prev !== null && m.minutes - prev > gapMin) idx++;
    prev = m.minutes;
    return idx;
  });
}

/**
 * Documents are sampled by a CONTENT-BLIND hash of their id, not by taking a
 * prefix of the files: a prefix is a date and a channel bias (shard 0000 opens
 * in April 2015), and the register slice is supposed to be the register, not
 * one month of it. The whole corpus is still STREAMED — the hash decides what
 * is kept, not where the read stops — so the sample is order-free.
 *
 * 0.004 is a MEMORY number, and it was measured rather than guessed: this
 * corpus is 234,982 channel-days, and at 0.05 the pool OOMs a 8 GB heap partway
 * through the second shard (each target carries its own 2,500-character
 * production context, so the pool is ~2.5 KB per sentence). 0.004 lands near
 * the chat-owner pool size, which is the size the quota engine was tuned on.
 * `POOL_MAX_ITEMS` makes a future raise fail LOUDLY with the remedy instead of
 * dying in the garbage collector.
 */
export const IRC_DOC_FRACTION = Number(process.env.PROOFER_IRC_DOC_FRACTION ?? 0.004);
export const POOL_MAX_ITEMS = Number(process.env.PROOFER_POOL_MAX_ITEMS ?? 400_000);

function unitHash(s) {
  return createHash("sha256").update("pool-sample/v1\0" + s).digest().readUInt32BE(0) / 4294967296;
}

async function* streamJsonlGz(path) {
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const l = line.trim();
    if (!l) continue;
    try { yield JSON.parse(l); } catch { /* a truncated line is not a corpus */ }
  }
}

export async function ircPool() {
  for (const f of IRC_SHARDS) {
    if (!existsSync(join(IRC_DIR, f))) {
      die(`missing IRC shard ${join(IRC_DIR, f)} — see its DATA-CARD.md for the retrieval route`);
    }
  }
  const fn = funnelRecorder();
  let docs = 0, docsKept = 0, rawLines = 0, parsed = 0, afterLen = 0,
    afterDict = 0, afterScrub = 0;
  const items = [];
  const episodes = new Map();

  for (const shard of IRC_SHARDS) {
    for await (const doc of streamJsonlGz(join(IRC_DIR, shard))) {
      docs++;
      if (unitHash(doc.id) >= IRC_DOC_FRACTION) continue;
      const text = doc.text || "";
      if (!text) continue;
      docsKept++;
      rawLines += text.split("\n").length;
      const msgs = parseIrcDocument(text);
      parsed += msgs.length;
      if (!msgs.length) continue;
      const sessions = ircSessionIndices(msgs);
      const channel = doc.metadata?.channel ?? "unknown";
      const pseudo = handlePseudonymiser(
        [...(doc.metadata?.authors ?? []), ...msgs.map((m) => m.nick)]);
      const chanKey = shortHash(channel, 8);

      // Prior kept lines of the SAME session are the context, exactly as the
      // owner pool's prior messages within the same window are.
      const priorBySession = new Map();
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.text.length < MIN_SENTENCE_CHARS || m.text.length > MAX_TARGET) continue;
        afterLen++;
        if (dictionaryRatioReject(m.text)) continue;
        afterDict++;
        const scrubbed = scrubText(pseudo.apply(m.text));
        // A line that is mostly redaction is not a sentence any more.
        if (placeholderCount(scrubbed.text) > 2) continue;
        if (dictionaryRatioReject(scrubbed.text)) continue;
        afterScrub++;

        const gid = `irc:${chanKey}:${doc.created ?? doc.id}:${sessions[i]}`;
        const sdid = `irc:${doc.id}#${m.index}`;
        if (items.length > POOL_MAX_ITEMS) {
          die(`chat-irc pool exceeded POOL_MAX_ITEMS (${POOL_MAX_ITEMS}) — lower `
            + `PROOFER_IRC_DOC_FRACTION (currently ${IRC_DOC_FRACTION}) or raise `
            + "PROOFER_POOL_MAX_ITEMS with the heap to match. Failing here rather "
            + "than in the garbage collector, which is what 0.05 did.");
        }
        const prior = priorBySession.get(sessions[i]) ?? [];
        for (const t of targetsFromUnit(scrubbed.text, prior.join("\n"),
          { source_document_id: sdid, exclusion_group_id: gid })) items.push(t);
        prior.push(scrubbed.text);
        if (prior.length > 60) prior.shift();
        priorBySession.set(sessions[i], prior);
        if (!episodes.has(gid)) episodes.set(gid, []);
        episodes.get(gid).push(sdid);
      }
    }
  }
  if (!items.length) die("chat-irc pool produced 0 sentence targets");
  fn.note("documents streamed", docs);
  fn.note(`documents sampled (hash < ${IRC_DOC_FRACTION})`, docsKept);
  fn.note("raw log lines", rawLines);
  fn.note("messages after nick/timestamp strip", parsed);
  fn.note("messages in the sentence-length window", afterLen);
  fn.note(`messages past the dictionary ratio (>= ${MIN_DICT_RATIO})`, afterDict);
  fn.note("messages surviving the entity scrub", afterScrub);
  fn.note("sentence targets", items.length);
  fn.note("exclusion groups (channel-day sessions)", episodes.size);
  return { items, episodes, corpus: "ubuntu-irc", funnel: fn.rows };
}

// =====================================================================
// S3 — Enron
// =====================================================================

const ENRON_ROOT = join(CORPORA_ROOT, "s3-enron", "extracted", "maildir");

// Only folders the employee WROTE into. Two reasons, both register reasons: an
// inbox is full of newsletters, spam and machine reports that are not workplace
// prose at all (measured — the first inbox message sampled was an iWon
// sweepstake), and a received message's register is the SENDER's, who may be a
// vendor's mail robot. `sent` is the D4 register the source was taken for.
const ENRON_SENT_DIRS = new Set(["sent", "sent_items", "_sent_mail"]);

const HEADER_END = /\r?\n\r?\n/;
// Quoted chains, forwards and the reply banner, in the shapes this corpus
// actually uses.
const ENRON_CUT_RE = [
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Forwarded by/im,
  /^\s*_{10,}\s*$/m,
  /^On .{0,60}\bwrote:\s*$/im,
  /^From:\s.+$/im,
  /^To:\s.+$/im,
  /^Sent by:/im,
];
// Signature blocks. `-- ` is the RFC convention; the rest are what a corporate
// footer looks like.
const ENRON_SIG_RE = [
  /^--\s*$/m,
  /^\s*(?:Best regards|Kind regards|Regards|Thanks|Thank you|Sincerely|Cheers)\s*[,.]?\s*$/im,
  /^\s*This (?:e-?mail|message)(?: and any attachments)? .{0,80}(?:confidential|privileged)/im,
];
const IMAGE_RE = /\[IMAGE\]/g;

/** Split an RFC822 message into headers and body. Exported for the test. */
export function parseEnronMessage(raw) {
  const s = String(raw ?? "");
  const m = HEADER_END.exec(s);
  const headText = m ? s.slice(0, m.index) : s;
  const body = m ? s.slice(m.index + m[0].length) : "";
  const headers = {};
  let lastKey = null;
  for (const line of headText.split(/\r?\n/)) {
    if (/^\s/.test(line) && lastKey) { headers[lastKey] += " " + line.trim(); continue; }
    const hm = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
    if (!hm) continue;
    lastKey = hm[1].toLowerCase();
    headers[lastKey] = hm[2];
  }
  return { headers, body };
}

/**
 * Reduce a body to the prose the sender WROTE: cut at the first quoted chain or
 * forward banner, cut at the signature, and drop lines that are not prose —
 * tables (multiple 2+-space runs), digit-heavy rows, `[IMAGE]` runs, and
 * quoted-printable artefacts. Exported for the test.
 */
export function cleanEnronBody(body) {
  let s = String(body ?? "").replace(/\r\n/g, "\n").replace(IMAGE_RE, " ");
  let cut = s.length;
  for (const re of ENRON_CUT_RE) {
    const m = re.exec(s);
    if (m && m.index < cut) cut = m.index;
  }
  s = s.slice(0, cut);
  cut = s.length;
  for (const re of ENRON_SIG_RE) {
    const m = re.exec(s);
    if (m && m.index < cut) cut = m.index;
  }
  s = s.slice(0, cut);

  const kept = [];
  for (const line of s.split("\n")) {
    const l = line.trim();
    if (!l) { if (kept.length && kept[kept.length - 1] !== "") kept.push(""); continue; }
    if (/^>/.test(l)) continue;                              // quoted
    if (/=\d\d/.test(l)) continue;                           // quoted-printable
    if (/\s{2,}\S+\s{2,}/.test(l)) continue;                 // a table row
    const digits = (l.match(/\d/g) || []).length;
    if (digits / l.length > 0.30) continue;                  // a figure row
    const alpha = (l.match(ALPHA_TOKEN) || []).length;
    if (alpha < 3) continue;
    kept.push(l);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Thread identity. Message-ID `References`/`In-Reply-To` are absent from this
 *  corpus's headers, so the thread is the NORMALISED SUBJECT plus the
 *  participant set — the two things a reply preserves. Documented as a choice
 *  rather than a fact: a generic subject ("Meeting") between the same two people
 *  in different months collapses into one group, which over-reserves and never
 *  under-reserves, and over-reserving is the safe direction for a leak guard. */
export function enronThreadId(headers) {
  const subj = String(headers.subject ?? "")
    .replace(/^(?:\s*(?:re|fw|fwd)\s*:\s*)+/i, "").trim().toLowerCase()
    .replace(/\s+/g, " ");
  const people = [headers.from, headers.to, headers.cc]
    .filter(Boolean).join(",").toLowerCase()
    .split(/[,;]/).map((x) => x.trim()).filter(Boolean).sort();
  return "enron:" + shortHash(subj + "␟" + [...new Set(people)].join(","), 12);
}

function* walkEnron(root) {
  const users = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const u of users) {
    for (const folder of readdirSync(join(root, u.name), { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      if (!ENRON_SENT_DIRS.has(folder.name.toLowerCase())) continue;
      const dir = join(root, u.name, folder.name);
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try { if (!statSync(p).isFile()) continue; } catch { continue; }
        yield { path: p, rel: `${u.name}/${folder.name}/${f}` };
      }
    }
  }
}

export function enronPool() {
  if (!existsSync(ENRON_ROOT)) {
    die(`Enron maildir not found at ${ENRON_ROOT} — extract the tarball first:\n`
      + `  mkdir -p ${join(CORPORA_ROOT, "s3-enron", "extracted")} && `
      + `tar xzf ${join(CORPORA_ROOT, "s3-enron", "enron_mail_20150507.tar.gz")} `
      + `-C ${join(CORPORA_ROOT, "s3-enron", "extracted")}/`);
  }
  const fn = funnelRecorder();
  let files = 0, parsedOk = 0, afterClean = 0, afterScrub = 0;
  const items = [];
  const episodes = new Map();

  for (const { path, rel } of walkEnron(ENRON_ROOT)) {
    files++;
    let raw;
    try { raw = readFileSync(path, "utf8"); } catch { continue; }
    const { headers, body } = parseEnronMessage(raw);
    if (!headers["message-id"]) continue;
    parsedOk++;
    const cleaned = cleanEnronBody(body);
    if (cleaned.length < MIN_SENTENCE_CHARS) continue;
    afterClean++;
    const pseudo = handlePseudonymiser(
      [headers["x-from"], headers["x-to"]].filter(Boolean)
        .flatMap((v) => v.split(/[,;<>]/).map((x) => x.trim()))
        .filter((x) => x.length >= 4 && /^[A-Za-z][A-Za-z .'-]*$/.test(x)),
      "PERSON");
    const scrubbed = scrubText(pseudo.apply(cleaned));
    if (placeholderCount(scrubbed.text) > 6) continue;
    afterScrub++;

    const gid = enronThreadId(headers);
    const sdid = `enron:${rel}`;
    for (const t of targetsFromUnit(scrubbed.text, "",
      { source_document_id: sdid, exclusion_group_id: gid })) {
      if (dictionaryRatioReject(t.sentence)) continue;
      items.push(t);
    }
    if (!episodes.has(gid)) episodes.set(gid, []);
    episodes.get(gid).push(sdid);
  }
  if (!items.length) die("email-workplace pool produced 0 sentence targets");
  fn.note("maildir files in sent folders", files);
  fn.note("messages with parseable headers", parsedOk);
  fn.note("messages with prose left after header/quote/signature strip", afterClean);
  fn.note("messages surviving the entity scrub", afterScrub);
  fn.note("sentence targets (past the dictionary ratio)", items.length);
  fn.note("exclusion groups (subject+participant threads)", episodes.size);
  return { items, episodes, corpus: "enron-email", funnel: fn.rows };
}

// =====================================================================
// SE — Stack Exchange comments. BENCHMARK ONLY.
// =====================================================================

const SE_DIR = join(CORPORA_ROOT, "se-stackexchange");
const SE_SHARDS = [
  "3dprinting.meta.stackexchange.com/documents/00000_se.jsonl.gz",
  "3dprinting.stackexchange.com/documents/00000_se.jsonl.gz",
];

/**
 * The SE use restriction, enforced in code rather than in a comment. Its data
 * card is unambiguous: CC BY-SA, local unpublished benchmark only, never
 * training, never published. The pool refuses any other stated purpose.
 */
export function assertSeBenchmarkUse(purpose) {
  if (purpose !== "benchmark") {
    die("Stack Exchange is BENCHMARK ONLY (CC BY-SA share-alike; see its "
      + `DATA-CARD.md). Refusing purpose ${JSON.stringify(purpose)}.`);
  }
}

/**
 * Comments are concatenated into `text` with NO per-line marker, so selecting
 * them is a SHAPE job. Conservative on purpose — a false positive here puts an
 * answer's prose in the comment register and mislabels the slice, and the pool
 * only needs a few hundred sentences out of 6,091 documents.
 *
 * A block qualifies when it is a single paragraph on one line, 40-240 chars, at
 * most two sentences, carries no markdown structure (heading, list, quote, code
 * fence, indent, table, image or link markup) and is not block 0 or 1 — block 0
 * is always the title and block 1 is the question's opening paragraph, which a
 * length rule alone reads as a comment (measured on the fixture: a 145-char
 * one-paragraph body sailed through a 40-320 window).
 *
 * RESIDUAL, named rather than closed: a short single-paragraph ANSWER is
 * indistinguishable from a comment by shape, and some will be sampled. That is
 * tolerable because this slice is the "forum/comment" register rather than
 * "comments specifically", and because the data card states outright that there
 * is no marker to key on. What the rule does buy is that titles, code, lists,
 * quotes and long expository prose are never mistaken for either.
 */
export const SE_MAX_COMMENT_CHARS = 240;
export const SE_MIN_COMMENT_CHARS = 40;
export const SE_FIRST_COMMENT_BLOCK = 2;

export function splitSeComments(text) {
  const blocks = String(text ?? "").split(/\n\s*\n/);
  const out = [];
  for (let i = SE_FIRST_COMMENT_BLOCK; i < blocks.length; i++) {
    const b = blocks[i].trim();
    if (!b || b.includes("\n")) continue;
    if (b.length < SE_MIN_COMMENT_CHARS || b.length > SE_MAX_COMMENT_CHARS) continue;
    if ((b.match(/[.!?]["'’)\]]*(\s|$)/g) || []).length > 2) continue;
    if (/^(#|>|\*|-|\d+\.|\||```|    )/.test(b)) continue;
    if (/```|\[[^\]]*\]\(|!\[|<\/?[a-z]+>|\|\s*-{3,}/i.test(b)) continue;
    out.push({ index: i, text: b });
  }
  return out;
}

export async function sePool(purpose = "benchmark") {
  assertSeBenchmarkUse(purpose);
  for (const f of SE_SHARDS) {
    if (!existsSync(join(SE_DIR, f))) {
      die(`missing SE shard ${join(SE_DIR, f)} — see its DATA-CARD.md`);
    }
  }
  const fn = funnelRecorder();
  let docs = 0, blocks = 0, commentLike = 0, afterDict = 0, afterScrub = 0;
  const items = [];
  const episodes = new Map();

  for (const shard of SE_SHARDS) {
    for await (const doc of streamJsonlGz(join(SE_DIR, shard))) {
      docs++;
      const text = doc.text || "";
      if (!text) continue;
      blocks += text.split(/\n\s*\n/).length;
      const cands = splitSeComments(text);
      commentLike += cands.length;
      if (!cands.length) continue;
      const site = doc.metadata?.site ?? "unknown";
      const gid = `se:${shortHash(site, 6)}:${doc.id}`;
      const prior = [];
      for (const c of cands) {
        if (dictionaryRatioReject(c.text)) { prior.push(c.text); continue; }
        afterDict++;
        const scrubbed = scrubText(c.text);
        if (placeholderCount(scrubbed.text) > 2) { prior.push(scrubbed.text); continue; }
        afterScrub++;
        const sdid = `se:${shortHash(site, 6)}:${doc.id}#${c.index}`;
        for (const t of targetsFromUnit(scrubbed.text, prior.join("\n"),
          { source_document_id: sdid, exclusion_group_id: gid })) items.push(t);
        prior.push(scrubbed.text);
        if (!episodes.has(gid)) episodes.set(gid, []);
        episodes.get(gid).push(sdid);
      }
    }
  }
  if (!items.length) die("forum-comments pool produced 0 sentence targets");
  fn.note("documents streamed", docs);
  fn.note("blank-line blocks", blocks);
  fn.note("comment-shaped blocks", commentLike);
  fn.note(`blocks past the dictionary ratio (>= ${MIN_DICT_RATIO})`, afterDict);
  fn.note("blocks surviving the entity scrub", afterScrub);
  fn.note("sentence targets", items.length);
  fn.note("exclusion groups (source questions)", episodes.size);
  return {
    items, episodes, corpus: "stackexchange-comments",
    benchmarkOnly: true, funnel: fn.rows,
  };
}
