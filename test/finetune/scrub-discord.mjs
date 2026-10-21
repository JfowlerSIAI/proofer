#!/usr/bin/env node
// S1 scrubber for optional, separately authorized corpus research.
// Scrubbing is not a guarantee against reproduction of private source text.
//
// Reads the owner Discord export through ../harvested/discord-source.mjs (the
// one loader; this file adds no CSV parsing of its own) and writes a scrubbed,
// deduplicated, holdout-free and benchmark-free copy into
// test/harvested/finetune/ — gitignored, 0700/0600, because everything
// downstream of loadMessages() is owner data.
//
//   node test/finetune/scrub-discord.mjs --exclude <manifest.json> [...]
//   node test/finetune/scrub-discord.mjs --check
//
// An exclusion manifest is MANDATORY. Producing S1 without naming what the
// benchmark reserved is how a stale corpus gets built by default, so the run
// refuses unless a manifest is given or --no-benchmark-exclusion is typed out.
//
// Five outputs, none of them committable:
//   s1-scrubbed.jsonl        one record per kept message, in corpus order
//   s1-pseudonym-map.json    entity -> pseudonym. THIS IS THE REVERSE MAP.
//   s1-name-candidates.md    person-name candidates for owner review (TOKENS ONLY)
//   s1-data-card.md          counts only, no message text (§6.3)
//   s1-manifest.json         sha256 of code, inputs, outputs, exclusion manifests
//
// Message order and timestamps are preserved and (server, channel) identity
// survives as a stable pseudonym pair, so a targetsFor()-style context window
// (prior messages, same channel, 30 min) still builds on the output.
//
// --check is a SEPARATE implementation (see the CHECK section): its detectors
// are written from an external audit's oracles rather than shared with the
// scrub regexes above them, it verifies the manifest against what is on disk,
// and it plants one adversarial fixture per class every run so a detector that
// has stopped firing is reported rather than silently green.
//
// Audit disposition implemented here: GPT-5.6 Sol, 2026-08-20, items 1-11.
// Items 5 and 6 (sentence-level dedup, exact-string holdout exclusion) are
// Phase 2 assembly requirements by disposition; they are recorded as binding
// in the data card's "Assembly requirements" section rather than done here.

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync,
  renameSync, chmodSync, unlinkSync,
} from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { loadMessages, CSV } from "../harvested/discord-source.mjs";

const SCRUB_VERSION = "s1-scrub-2";
const SELF = new URL(import.meta.url);
const OUT_DIR = new URL("../harvested/finetune/", import.meta.url);
const HARVESTED_DIR = new URL("../harvested/", import.meta.url);
const WORDS = new URL("../../data/words-en.txt", import.meta.url);
const BENCHMARK_MANIFEST = "test/harvested/finetune/benchmark-reserved-message-ids.json";

const OUT_JSONL = "s1-scrubbed.jsonl";
const OUT_MAP = "s1-pseudonym-map.json";
const OUT_NAMES = "s1-name-candidates.md";
const OUT_CARD = "s1-data-card.md";
const OUT_MANIFEST = "s1-manifest.json";
// Owner + agent rulings over the person-name candidates. Written by review, not
// by this file. It OVERRIDES the auto-scrub heuristic in both directions: a
// KEEP is never replaced even if all four signals fired on it (`OpenAI` was
// auto-scrubbed by the heuristic and is a keep), and a SCRUB is replaced
// everywhere even though it never met the bar. ASK is left in the corpus and is
// the only thing the candidates report still asks about.
const OUT_DECISIONS = "s1-name-decisions.json";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// ============================================================ SCRUB DETECTORS
// URLs first: a URL can carry an @ in its userinfo or query, so scrubbing it
// before the email rule keeps the email rule from biting a fragment.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.[^\s<>]+/gi;
// Schemeless domains and invite links — the class the first revision missed
// entirely (21 records survived it). The TLD list is closed on purpose: an open
// `\.[a-z]{2,}` rule eats every sentence with a missing space after a period.
const TLD = "com|org|net|edu|gov|mil|int|io|co|gg|dev|app|ai|me|us|uk|ca|de|fr|au|jp|nl|se|no|ru|cn|in|it|es|br|info|biz|xyz|tech|online|site|cloud|space|tv|fm|ly|sh|to|cc|ws|pro|name|mobi|news|blog|wiki|art|zip|link|life|world|store|shop|club";
const DOMAIN_RE = new RegExp(
  String.raw`\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:${TLD})(?::\d{2,5})?(?:\/[\w\-./?%&=+#~:,;@]*)?`,
  "gi");
const SCHEME_RE = /\b(?:ftp|ftps|sftp|ssh|git|svn|mailto|tel|callto|steam|discord|irc|ircs|magnet|data|file|ws|wss):(?:\/\/)?[^\s<>]+/gi;
const IPV4_RE = /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const OBF_EMAIL_RE = /\b[A-Za-z0-9._%+-]+\s*(?:\[at\]|\(at\)|\s+at\s+)\s*[A-Za-z0-9.-]+\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*[A-Za-z]{2,}\b/gi;
const EMOJI_RE = /<(a?):([A-Za-z0-9_]+):(\d+)>/g;       // custom emoji carries a snowflake
const TSMARK_RE = /<t:\d+(?::[tTdDfFR])?>/g;            // Discord unix-timestamp markup
const USER_RE = /<@!?(\d+)>/g;
const ROLE_RE = /<@&(\d+)>/g;
const CHANREF_RE = /<#(\d+)>/g;
// A bare @handle: one character is enough, Unicode letters count, and neither
// our own pseudonyms nor @everyone/@here are entities.
const BARE_AT_RE = /(^|[^\w@<])@(?!USER_\d|HANDLE_\d|ROLE_\d)([\p{L}\p{N}_][\p{L}\p{N}_.-]{0,31})/gu;
// Phone windows. This is the AUDIT's loose oracle rather than the first
// revision's conservative one: the conservative rule left a residue the
// independent check could only report as advisory, and an advisory count in a
// privacy gate is a number nobody can act on. The loose window plus four
// exclusions costs ~20 mangled records in 45k and buys a true zero-gate.
// Whitespace excludes newlines, so a numbered list cannot be swallowed whole.
const PHONE_RE = /\+?\d[\d \t().\-\u2013\u2014/]{5,}\d/g;

const PLACEHOLDER_RE = /<URL>|<EMAIL>|<PHONE>|<IP>|<TIME>|@USER_\d+|@HANDLE_\d+|@ROLE_\d+|#CHANREF_\d+|PERSON_\d+/g;
// Tokens the numeric passes must not see INSIDE. A pseudonym's index is digits,
// and `<@1080…>` + " 2027" became `@USER_161 2027`, which the phone window read
// as a 7-digit number and replaced with <PHONE> — destroying the pseudonym and
// leaving `@USER_<PHONE>`. Found by the independent check, not by this code.
const MASKABLE_RE = /<URL>|<EMAIL>|<TIME>|@USER_\d+|@HANDLE_\d+|@ROLE_\d+|#CHANREF_\d+/g;
const SENTINEL_RE = /\u0000([a-j]+)\u0000/g;
const toSentinel = (i) => "\u0000" + String(i).replace(/\d/g, (d) => "abcdefghij"[Number(d)]) + "\u0000";
const fromSentinel = (a) => Number([...a].map((c) => "abcdefghij".indexOf(c)).join(""));
const RESERVED_TOKEN_RE = /(?:@USER_|@HANDLE_|@ROLE_|#CHANREF_|SERVER_|CHANNEL_|PERSON_)\d+|<(?:URL|EMAIL|PHONE|IP|TIME)>/;

const BLOCKQUOTE_RE = /^[ \t]*>/m;
const ATTRIB_RE = /\b(said|says|wrote|writes|posted|replied|responded|asked|answered)\s*:/i;

const UID_RE = /^(\d{6,}):[0-9a-f]{10}$/;

const PREFIX = {
  user: "@USER_",
  handle: "@HANDLE_",
  role: "@ROLE_",
  chanref: "#CHANREF_",
  person: "PERSON_",
  server: "SERVER_",
  channel: "CHANNEL_",
};

/** Shared by the scrubber and (re-implemented) by the check. */
function phoneLike(raw) {
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s)) return false;          // ISO-ish date
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return false;                 // IPv4
  if (/^\d+(?:\.\d+){2,}$/.test(s)) return false;                        // version number
  if (/^\d{4}\s*[-\u2013\u2014]\s*\d{4}$/.test(s)) return false;         // year range
  return true;
}

// ------------------------------------------- structural paste candidates (§3)
// A message shaped like something PASTED rather than typed. None of these is
// proof of a third-party quote; the disposition is to drop the union anyway,
// because D2's accepted risk covers the OWNER's text and nothing else.
function pasteSignals(s) {
  const hit = [];
  const chars = [...s].length;
  const lines = s.split("\n");
  const fences = (s.match(/```|~~~/g) || []).length;
  const indented = lines.filter((x) => /^(?: {4}|\t)/.test(x)).length;
  const logLines = lines.filter((x) =>
    /^\s*(?:\[?\d{2,4}[-/:T]\d{1,2}[-/:T]\d{1,2}|\d{1,2}:\d{2}:\d{2}|(?:DEBUG|INFO|WARN(?:ING)?|ERROR|TRACE|FATAL)\b)/i.test(x)).length;
  const speakerLines = lines.filter((x) => /^\s*[\p{L}\p{N}_. -]{2,40}:\s+\S/u.test(x)).length;
  const headerLines = lines.filter((x) => /^\s*(?:from|to|cc|bcc|subject|date|sent):\s+\S/i.test(x)).length;
  const quoteChars = (s.match(/["\u201c\u201d\u201e\u201f\u00ab\u00bb]/g) || []).length;
  let jsonish = false;
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { const q = JSON.parse(t); jsonish = !!q && typeof q === "object"; } catch { /* not JSON */ }
  }

  if (chars >= 1000) hit.push("chars>=1000");
  if (lines.length >= 10) hit.push("lines>=10");
  if (fences > 0) hit.push("code-fence");
  if (indented >= 3) hit.push("indented-block");
  if (logLines >= 3) hit.push("log-lines");
  if (speakerLines >= 2) hit.push("speaker-labels");
  if (headerLines >= 2) hit.push("forwarded-headers");
  if (jsonish) hit.push("whole-message-json");
  if (/<(?:html|body|div|p|table|script|style)\b/i.test(s)) hit.push("html-shape");
  if (chars >= 300 && quoteChars >= 4) hit.push("quote-dense");
  return hit;
}

// ------------------------------------------------- person names in prose (§2)
// Candidate signals. AUTO-SCRUB requires a vocative or relational pattern AND a
// non-dictionary token AND a capital where a sentence does not start — three
// independent signals, because chat capitalisation alone is worthless. The
// possessive pattern is a REVIEW signal only: it cannot tell a person from a
// product, and auto-scrubbing it would rewrite brand names.
const VOCATIVE_RE = /\b(?:hey|hi|hello|yo|thanks|thanx|thx|ty|cc|welcome|congrats|congratulations|sorry|please|morning|gm|gn|sup|dear|hola|nice work|good work|wb)\b[ ,]+([\p{Lu}][\p{L}'\u2019-]{1,30})/gu;
const RELATIONAL_RE = /\b([\p{Lu}][\p{L}'\u2019-]{1,30})\s+(?:said|says|wrote|writes|told|asked|thinks|thought|mentioned|replied|posted|noted|added|suggested|pointed out|reckons)\b/gu;
const POSSESSIVE_RE = /\b([\p{Lu}][\p{L}'\u2019-]{1,30})['\u2019]s\b/gu;

const bareToken = (t) => t.replace(/['\u2019]/g, "").toLowerCase();
const CAP_TOKEN_RE = /\p{Lu}[\p{L}'\u2019-]{1,30}/gu;
// A token is auto-scrubbed only if the name patterns account for a real share
// of the times it is written at all. This is the discriminator that separates a
// person from a topic word, and it is structural rather than a guess: a
// person's name is mostly written TO or ABOUT that person, while a product name
// is written hundreds of times about the product and occasionally in a sentence
// shaped like "X said". Measured on this corpus, the first cut without it
// auto-scrubbed 5,284 occurrences against 157 with it — nearly all of the
// difference being contractions (`I've said`, `hey I'm`) and three model names.
const NAME_PATTERN_SHARE = 0.2;

function startsSentence(text, index) {
  for (let i = index - 1; i >= 0; i--) {
    const c = text[i];
    if (c === " " || c === "\t") continue;
    return c === "\n" || c === "." || c === "!" || c === "?" || c === ":" || c === "-" || c === "*";
  }
  return true;
}

/** Candidate person-name tokens in one already-entity-scrubbed message. */
function nameCandidates(text, dict) {
  const out = new Map();     // token -> { signals:Set, auto:boolean, hits:number }
  const note = (tok, signal, index, strong) => {
    if (!tok || tok.length < 2) return;
    if (tok === tok.toUpperCase()) return;                 // an acronym, not a name
    if (/['\u2019]/.test(tok)) return;                     // a contraction: `I've said`, `hey I'm`
    if (/^(?:URL|EMAIL|PHONE|IP|TIME|SERVER|CHANNEL|PERSON|USER|HANDLE|ROLE|CHANREF)$/i.test(tok)) return;
    const b = bareToken(tok);
    const inDict = dict.has(b);
    let e = out.get(tok);
    if (!e) { e = { signals: new Set(), inDict, auto: false, hits: 0 }; out.set(tok, e); }
    e.hits++;
    e.signals.add(signal);
    if (strong && !inDict && !startsSentence(text, index)) e.auto = true;
  };
  for (const m of text.matchAll(VOCATIVE_RE)) note(m[1], "vocative", m.index + m[0].indexOf(m[1]), true);
  for (const m of text.matchAll(RELATIONAL_RE)) note(m[1], "relational", m.index + m[0].indexOf(m[1]), true);
  for (const m of text.matchAll(POSSESSIVE_RE)) note(m[1], "possessive", m.index + m[0].indexOf(m[1]), false);
  return out;
}

// ------------------------------------------------------------------- helpers
const die = (msg) => { console.error("scrub-discord: " + msg); process.exit(1); };

const outPath = (dir, name) => fileURLToPath(new URL(name, dir));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sha256File = (p) => sha256(readFileSync(p));

function writeSecret(path, data) {
  const tmp = path + ".tmp-" + process.pid;
  try {
    writeFileSync(tmp, data, { mode: FILE_MODE });
    renameSync(tmp, path);
    chmodSync(path, FILE_MODE);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

const loadDict = () => new Set(readFileSync(WORDS, "utf8").split("\n").filter(Boolean));

/** The review rulings. Absent is fatal: an unreviewed run silently ships names. */
function loadDecisions(dir) {
  const p = outPath(dir, OUT_DECISIONS);
  if (!existsSync(p)) {
    die("name decisions not found: " + p + "\n" +
      "  Every person-name candidate must carry a KEEP / SCRUB / ASK ruling before S1 is built.\n" +
      "  Produce it from " + OUT_NAMES + " and re-run.");
  }
  let j;
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch { die("name decisions is not valid JSON: " + p); }
  if (!j || typeof j.decisions !== "object" || !j.decisions) die("name decisions has no decisions object: " + p);
  const keep = new Set(), scrub = new Set(), ask = new Map();
  const owner = new Set();
  for (const [tok, v] of Object.entries(j.decisions)) {
    if (!v || typeof v !== "object") die("name decisions: entry " + JSON.stringify(tok) + " is not an object");
    if (v.owner_ruled) owner.add(tok);
    if (v.decision === "KEEP") keep.add(tok);
    else if (v.decision === "SCRUB") scrub.add(tok);
    else if (v.decision === "ASK") ask.set(tok, v.gist || "");
    else die("name decisions: entry " + JSON.stringify(tok) + " has unknown decision " + JSON.stringify(v.decision));
  }
  for (const t of scrub) if (keep.has(t)) die("name decisions: " + t + " is both KEEP and SCRUB");
  return { path: p, keep, scrub, ask, owner, sha256: sha256File(p) };
}

/** Names worth checking for: long enough and not an ordinary word. */
function sensitiveNames(msgs, dict) {
  const raw = new Set();
  for (const m of msgs) { raw.add(m.server); raw.add(m.channel); }
  const out = [];
  let skippedShort = 0, skippedWord = 0;
  for (const n of raw) {
    const t = (n || "").trim().toLowerCase();
    if (t.length < 5) { skippedShort++; continue; }
    if (dict.has(t)) { skippedWord++; continue; }
    out.push(t);
  }
  return { names: out, total: raw.size, skippedShort, skippedWord };
}

// --------------------------------------------------- holdout / benchmark IDs
function harvestIds(value, key, out) {
  if (typeof value === "string") {
    const m = UID_RE.exec(value);
    if (m) out.add(m[1]);
    else if (key === "message_id" && /^\d{6,}$/.test(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    const childKey = key === "message_ids" ? "message_id" : key;
    for (const v of value) harvestIds(v, childKey, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const km = UID_RE.exec(k);
      if (km) out.add(km[1]);
      harvestIds(v, k, out);
    }
  }
}

function idsFromText(text, out) {
  const before = out.size;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { harvestIds(JSON.parse(trimmed), null, out); return out.size - before; } catch { /* fall through */ }
  }
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    if (l.startsWith("{") || l.startsWith("[")) {
      try { harvestIds(JSON.parse(l), null, out); continue; } catch { /* not JSON */ }
    }
    if (/^\d{6,}$/.test(l)) out.add(l);
    else { const m = UID_RE.exec(l); if (m) out.add(m[1]); }
  }
  return out.size - before;
}

function scanHoldouts() {
  const dir = fileURLToPath(HARVESTED_DIR);
  if (!existsSync(dir)) die("harvested directory not found: " + dir);
  const files = readdirSync(dir)
    .filter((f) => /\.jsonl?(\.|$)/.test(f))
    .filter((f) => statSync(fileURLToPath(new URL(f, HARVESTED_DIR))).isFile())
    .sort();
  const ids = new Set();
  const perFile = [];
  for (const f of files) {
    const before = ids.size;
    idsFromText(readFileSync(fileURLToPath(new URL(f, HARVESTED_DIR)), "utf8"), ids);
    perFile.push({ file: f, newIds: ids.size - before });
  }
  if (!files.length) die("no holdout/baseline files found under " + dir);
  if (!ids.size) die("scanned " + files.length + " holdout/baseline files and found no message_ids — the scan is broken, not the corpus");
  return { ids, files, perFile };
}

// ------------------------------------------------------------- pseudonyms (§11)
function validateMap(m, path) {
  const bad = (why) => die("pseudonym map " + path + " failed validation: " + why + " (use --fresh-map to start over)");
  if (!m || typeof m !== "object") bad("not an object");
  if (m.version !== SCRUB_VERSION) bad("version " + JSON.stringify(m.version) + " != " + SCRUB_VERSION);
  if (!m.entries || typeof m.entries !== "object") bad("no entries object");
  if (!Number.isInteger(m.counter) || m.counter < 0) bad("counter is not a non-negative integer");
  const seen = new Set();
  let maxSuffix = 0;
  for (const [k, v] of Object.entries(m.entries)) {
    const i = k.indexOf(":");
    if (i < 1) bad("entry key is not kind:key");
    const kind = k.slice(0, i);
    if (!PREFIX[kind]) bad("unknown namespace " + JSON.stringify(kind));
    if (typeof v !== "string" || !v.startsWith(PREFIX[kind])) bad("value for a " + kind + " entry does not carry the " + kind + " prefix");
    const n = Number(v.slice(PREFIX[kind].length));
    if (!Number.isInteger(n) || n < 1) bad("value has no positive index");
    if (seen.has(v)) bad("value collision — the map is not a bijection");
    seen.add(v);
    if (n > maxSuffix) maxSuffix = n;
  }
  if (m.counter < maxSuffix) bad("counter " + m.counter + " is below the largest index " + maxSuffix + " — a later run would re-issue a token");
}

function makePseudonyms(existing) {
  const entries = new Map(Object.entries(existing?.entries || {}));
  let counter = existing?.counter || 0;
  const perKind = {};
  for (const k of Object.keys(PREFIX)) perKind[k] = 0;
  for (const k of entries.keys()) { const kind = k.slice(0, k.indexOf(":")); if (perKind[kind] !== undefined) perKind[kind]++; }
  const reused = entries.size;
  return {
    get(kind, key) {
      const k = kind + ":" + key;
      let v = entries.get(k);
      if (!v) { v = PREFIX[kind] + (++counter); entries.set(k, v); perKind[kind]++; }
      return v;
    },
    toJSON() {
      return {
        version: SCRUB_VERSION,
        created: new Date().toISOString(),
        warning: "SENSITIVE. This is the reverse map from real Discord entities and person-name tokens to their pseudonyms. Local only, mode 0600; test/harvested/ is gitignored. Never commit, never quote.",
        counter,
        entries: Object.fromEntries([...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      };
    },
    get perKind() { return perKind; },
    get size() { return entries.size; },
    get reused() { return reused; },
  };
}

const STUB_PSEUD = { get: (kind) => PREFIX[kind] + "0" };

// --------------------------------------------------------------- the scrubber
function scrubEntities(content, pseud, acts) {
  let s = content;
  s = s.replace(URL_RE, () => { acts.url++; return "<URL>"; });
  s = s.replace(SCHEME_RE, () => { acts.uriScheme++; return "<URL>"; });
  s = s.replace(OBF_EMAIL_RE, () => { acts.obfuscatedEmail++; return "<EMAIL>"; });
  s = s.replace(EMAIL_RE, () => { acts.email++; return "<EMAIL>"; });
  s = s.replace(EMOJI_RE, (_m, _a, name) => { acts.emojiId++; return ":" + name + ":"; });
  s = s.replace(TSMARK_RE, () => { acts.tsMarkup++; return "<TIME>"; });
  s = s.replace(USER_RE, (_m, id) => { acts.userMention++; return pseud.get("user", id); });
  s = s.replace(ROLE_RE, (_m, id) => { acts.roleMention++; return pseud.get("role", id); });
  s = s.replace(CHANREF_RE, (_m, id) => { acts.chanMention++; return pseud.get("chanref", id); });
  s = s.replace(BARE_AT_RE, (m, lead, name) => {
    const low = name.toLowerCase();
    if (low === "everyone" || low === "here") { acts.genericAt++; return m; }
    acts.bareHandle++;
    return lead + pseud.get("handle", low);
  });
  // Everything already replaced is masked before the numeric passes, so a
  // pseudonym's own index cannot be read as part of a phone number, an IP or a
  // domain. Domains come after the mention pass because a bare handle can look
  // domain-shaped, which is what puts them on this side of the mask.
  const store = [];
  s = s.replace(MASKABLE_RE, (m) => { store.push(m); return toSentinel(store.length - 1); });
  s = s.replace(DOMAIN_RE, () => { acts.bareDomain++; return "<URL>"; });
  s = s.replace(IPV4_RE, () => { acts.ipv4++; return "<IP>"; });
  s = s.replace(PHONE_RE, (m) => {
    if (!phoneLike(m)) return m;
    acts.phone++;
    return "<PHONE>";
  });
  s = s.replace(SENTINEL_RE, (m, id) => store[fromSentinel(id)] ?? m);
  return s;
}

function scrubNames(text, autoTokens, pseud, acts) {
  if (!autoTokens.size) return text;
  // The token CORE, not a whole word run: a possessive or a hyphenated compound
  // must not hide the name inside it. This is the same span the independent
  // check looks for, and the first cut differed from it — which is how the
  // check earned its keep, catching 29 possessive forms the scrub walked past.
  return text.replace(/(?<![\p{L}])[\p{L}]+(?![\p{L}])/gu, (tok, i, whole) => {
    if (!autoTokens.has(tok)) return tok;
    acts.personName++;
    const p = pseud.get("person", bareToken(tok));
    // A pseudonym ends in digits, so a name written hard against a number
    // (`Sam6789`) would emit `PERSON_1246789` — a token that parses as a
    // DIFFERENT pseudonym and is in no map. Separate it; the alternative is
    // an unreadable identifier collision the check can only report as unknown.
    return /\d/.test(whole[i + tok.length] || "") ? p + " " : p;
  });
}

const normalizeForDedup = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------- args
function parseArgs(argv) {
  const opts = { check: false, exclude: [], out: OUT_DIR, freshMap: false, noBenchmark: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--fresh-map") opts.freshMap = true;
    else if (a === "--no-benchmark-exclusion") opts.noBenchmark = true;
    else if (a === "--exclude") {
      const v = argv[++i];
      if (!v) die("--exclude needs a file of message_ids (one per line, or a JSON corpus/uid file)");
      opts.exclude.push(v);
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) die("--out needs a directory");
      opts.out = new URL(v.endsWith("/") ? v : v + "/", "file://" + process.cwd() + "/");
    } else if (a === "--help" || a === "-h") {
      console.log([
        "scrub-discord.mjs — S1 scrubber (plan §6.2)",
        "",
        "  --exclude <file>   message_ids to drop (repeatable). Takes a plain list, a JSON",
        "                     corpus file, or a uid list. AT LEAST ONE IS REQUIRED — normally",
        "                     " + BENCHMARK_MANIFEST,
        "  --no-benchmark-exclusion",
        "                     run with no exclusion manifest at all. Types out that the output",
        "                     may contain benchmark-reserved messages; the manifest records it.",
        "  --check            independent re-scan of the output + manifest verification;",
        "                     exit 1 on any hit. Plants adversarial fixtures every run.",
        "  --fresh-map        ignore an existing pseudonym map instead of extending it",
        "  --out <dir>        output directory (default test/harvested/finetune/)",
      ].join("\n"));
      process.exit(0);
    } else die("unknown argument: " + a);
  }
  return opts;
}

// ================================================================ SCRUB (main)
function runScrub(opts) {
  if (!opts.exclude.length && !opts.noBenchmark) {
    die("refusing to run with no exclusion manifest.\n" +
      "  The benchmark reserves whole conversation episodes and S1 must not contain them.\n" +
      "  Normal invocation:\n" +
      "    node test/finetune/scrub-discord.mjs --exclude " + BENCHMARK_MANIFEST + "\n" +
      "  If there is genuinely nothing to exclude, say so explicitly with --no-benchmark-exclusion.");
  }

  let msgs;
  try {
    msgs = loadMessages();
  } catch (e) {
    if (e && e.code) die("could not read the Discord export (" + e.code + "): " + CSV);
    throw e;
  }
  if (!msgs.length) die("loadMessages() returned 0 messages from " + CSV);

  const dict = loadDict();
  const decisions = loadDecisions(opts.out);
  const nameInfo = sensitiveNames(msgs, dict);
  const holdout = scanHoldouts();

  const extra = new Set();
  const extraPerFile = [];
  for (const f of opts.exclude) {
    if (!existsSync(f)) die("--exclude file not found: " + f);
    const before = extra.size;
    idsFromText(readFileSync(f, "utf8"), extra);
    if (extra.size === before) die("--exclude file yielded no message_ids: " + f);
    extraPerFile.push({ file: f, ids: extra.size - before, sha256: sha256File(f) });
  }

  const outDir = fileURLToPath(opts.out);
  mkdirSync(outDir, { recursive: true, mode: DIR_MODE });
  try { chmodSync(outDir, DIR_MODE); } catch { /* not ours; the file modes still hold */ }

  const mapPath = outPath(opts.out, OUT_MAP);
  let priorMap = null;
  if (!opts.freshMap && existsSync(mapPath)) {
    try { priorMap = JSON.parse(readFileSync(mapPath, "utf8")); } catch { die("existing pseudonym map is not valid JSON: " + mapPath); }
    validateMap(priorMap, mapPath);
  }
  const pseud = makePseudonyms(priorMap);

  // ---- the pre-scrub drop filters, shared by both passes -------------------
  const preDrop = (m) => {
    if (holdout.ids.has(m.message_id)) return "holdout-excluded";
    if (extra.has(m.message_id)) return "excluded-manifest";
    if (RESERVED_TOKEN_RE.test(m.content)) return "reserved-token-collision";
    if (BLOCKQUOTE_RE.test(m.content)) return "quote-blockquote";
    if (ATTRIB_RE.test(m.content)) return "quote-attribution";
    if (pasteSignals(m.content).length) return "paste-candidate";
    const low = m.content.toLowerCase();
    for (const n of nameInfo.names) if (low.includes(n)) return "contains-raw-name";
    return null;
  };

  // The filters are decided ONCE and both passes read the same verdict, so a
  // message cannot be a name donor in pass 1 and a drop in pass 2.
  const pre = msgs.map((m) => ({ m, why: preDrop(m) }));

  // ---- pass 1: person-name candidates over the whole surviving corpus ------
  // Corpus-wide, so a token decided a name anywhere is a name everywhere; the
  // stub allocator keeps pass 1 from issuing pseudonyms it would then re-issue.
  const cand = new Map();     // token -> { signals:Set, inDict, auto, count, total, share }
  const totals = new Map();   // every capitalised token -> times written at all
  const throwaway = { url: 0, uriScheme: 0, obfuscatedEmail: 0, email: 0, emojiId: 0, tsMarkup: 0, userMention: 0, roleMention: 0, chanMention: 0, bareHandle: 0, genericAt: 0, bareDomain: 0, ipv4: 0, phone: 0, personName: 0 };
  const pasteHitCounts = new Map();
  for (const { m, why } of pre) {
    if (why) {
      if (why === "paste-candidate") for (const sig of pasteSignals(m.content)) pasteHitCounts.set(sig, (pasteHitCounts.get(sig) || 0) + 1);
      continue;
    }
    const text = scrubEntities(m.content, STUB_PSEUD, throwaway);
    for (const t of text.match(CAP_TOKEN_RE) || []) totals.set(t, (totals.get(t) || 0) + 1);
    for (const [tok, info] of nameCandidates(text, dict)) {
      let e = cand.get(tok);
      if (!e) { e = { signals: new Set(), inDict: info.inDict, auto: false, count: 0 }; cand.set(tok, e); }
      e.count += info.hits;
      e.auto = e.auto || info.auto;
      for (const s of info.signals) e.signals.add(s);
    }
  }
  for (const [tok, e] of cand) {
    e.total = Math.max(totals.get(tok) || 0, e.count);
    e.share = e.count / e.total;   // <= 1: both sides count OCCURRENCES, not messages
    if (e.share < NAME_PATTERN_SHARE) e.auto = false;
  }
  // The heuristic proposes; the review disposes. Overriding in BOTH directions
  // is the point: reversing a wrong auto-scrub matters as much as adding a name
  // the heuristic could not see, and a keep must survive a re-run of the
  // heuristic that would otherwise re-scrub it.
  const heuristic = new Set([...cand.entries()].filter(([, e]) => e.auto).map(([t]) => t));
  const autoTokens = new Set(heuristic);
  const reversed = [];
  for (const t of decisions.keep) if (autoTokens.delete(t)) reversed.push(t);
  const added = [];
  for (const t of decisions.scrub) if (!autoTokens.has(t)) { autoTokens.add(t); added.push(t); }
  const undecided = [...cand.keys()].filter((t) =>
    !decisions.keep.has(t) && !decisions.scrub.has(t) && !decisions.ask.has(t));
  if (undecided.length) {
    die("name decisions cover " + (cand.size - undecided.length) + " of " + cand.size + " candidates.\n" +
      "  Unruled: " + undecided.sort().join(", ") + "\n" +
      "  Every candidate must be KEEP, SCRUB or ASK before S1 is built.");
  }

  // ---- pass 2: emit ------------------------------------------------------
  const drops = new Map();
  const drop = (r) => drops.set(r, (drops.get(r) || 0) + 1);
  const acts = { url: 0, uriScheme: 0, bareDomain: 0, ipv4: 0, email: 0, obfuscatedEmail: 0, phone: 0, userMention: 0, roleMention: 0, chanMention: 0, bareHandle: 0, genericAt: 0, emojiId: 0, tsMarkup: 0, personName: 0 };
  const seen = new Map();          // normalized content -> the record that owns it
  let dupExact = 0, dupNormalized = 0, emptyRawNoLetters = 0;
  const records = [];

  for (const { m, why } of pre) {
    if (why) { drop(why); continue; }

    const tally = { url: 0, uriScheme: 0, bareDomain: 0, ipv4: 0, email: 0, obfuscatedEmail: 0, phone: 0, userMention: 0, roleMention: 0, chanMention: 0, bareHandle: 0, genericAt: 0, emojiId: 0, tsMarkup: 0, personName: 0 };
    let content = scrubEntities(m.content, pseud, tally);
    content = scrubNames(content, autoTokens, pseud, tally).trim();
    // Asked again on the SCRUBBED text: a PERSON_N is longer than the name it
    // replaced, so a message just under a threshold can cross it, and the
    // independent check reads the output rather than the input.
    if (pasteSignals(content).length) { drop("paste-candidate"); continue; }
    if (!content || !/\p{L}/u.test(content.replace(PLACEHOLDER_RE, " "))) {
      if (!/\p{L}/u.test(m.content)) emptyRawNoLetters++;
      drop("empty-after-scrub");
      continue;
    }

    const key = normalizeForDedup(content);
    const owner = seen.get(key);
    if (owner) {
      if (owner.content === content) dupExact++; else dupNormalized++;
      owner.aliases.push(m.message_id);       // §10: duplicate provenance survives
      drop("duplicate");
      continue;
    }

    for (const k of Object.keys(acts)) acts[k] += tally[k];
    const rec = {
      message_id: m.message_id,
      aliases: [],
      ts: m.ts,
      timestamp: m.timestamp,
      server_pseudo: pseud.get("server", m.server),
      channel_pseudo: pseud.get("channel", m.server + "\u0000" + m.channel),
      content,
    };
    seen.set(key, rec);
    records.push(rec);
  }

  if (!records.length) die("every message was dropped — refusing to write an empty corpus");

  // ---- write --------------------------------------------------------------
  const jsonlPath = outPath(opts.out, OUT_JSONL);
  writeSecret(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeSecret(mapPath, JSON.stringify(pseud.toJSON(), null, 1) + "\n");
  const namesPath = outPath(opts.out, OUT_NAMES);
  writeSecret(namesPath, buildNameCandidates(cand, autoTokens, acts.personName, decisions, heuristic, reversed, added));

  const dropped = msgs.length - records.length;
  const cardPath = outPath(opts.out, OUT_CARD);
  writeSecret(cardPath, buildCard({
    msgs, records, dropped, drops, acts, pseud, holdout, extraPerFile, extra,
    nameInfo, dupExact, dupNormalized, emptyRawNoLetters, priorMap: !!priorMap,
    cand, autoTokens, pasteHitCounts, noBenchmark: opts.noBenchmark,
    decisions, heuristic, reversed, added,
  }));

  const manifest = {
    version: SCRUB_VERSION,
    generated: new Date().toISOString(),
    argv: process.argv.slice(2),
    benchmark_exclusion_waived: opts.noBenchmark,
    counts: {
      messages_in: msgs.length,
      kept: records.length,
      dropped,
      drops: Object.fromEntries([...drops.entries()].sort()),
      scrub_actions: acts,
      pseudonyms: pseud.size,
      auto_scrubbed_name_tokens: autoTokens.size,
      name_review_candidates: decisions.ask.size,
      name_decisions: {
        keep: decisions.keep.size,
        scrub: decisions.scrub.size,
        ask: decisions.ask.size,
        owner_ruled: decisions.owner.size,
        heuristic_proposed: heuristic.size,
        reversed_by_keep: reversed.length,
        added_by_scrub: added.length,
      },
    },
    exclusion: {
      holdout_files_scanned: holdout.files.length,
      holdout_ids: holdout.ids.size,
      manifest_ids: extra.size,
      union_ids: new Set([...holdout.ids, ...extra]).size,
      union_sha256: sha256([...new Set([...holdout.ids, ...extra])].sort().join("\n")),
      manifests: extraPerFile,
    },
    sha256: {
      scrubber: sha256File(fileURLToPath(SELF)),
      source_csv: sha256File(CSV),
      [OUT_JSONL]: sha256File(jsonlPath),
      [OUT_MAP]: sha256File(mapPath),
      [OUT_NAMES]: sha256File(namesPath),
      [OUT_CARD]: sha256File(cardPath),
    },
    auto_name_tokens_sha256: sha256([...autoTokens].sort().join("\n")),
    [OUT_DECISIONS + "_sha256"]: decisions.sha256,
  };
  writeSecret(outPath(opts.out, OUT_MANIFEST), JSON.stringify(manifest, null, 1) + "\n");

  console.log("messages in     " + msgs.length);
  console.log("kept            " + records.length);
  console.log("dropped         " + dropped);
  for (const [r, n] of [...drops.entries()].sort((a, b) => b[1] - a[1])) console.log("  " + r.padEnd(24) + n);
  console.log("scrub actions   " + Object.entries(acts).filter(([, v]) => v).map(([k, v]) => k + "=" + v).join(" "));
  console.log("name tokens     scrubbed " + autoTokens.size + " (" + acts.personName + " occurrences); heuristic proposed " + heuristic.size + ", " + reversed.length + " reversed by KEEP, " + added.length + " added by SCRUB, " + decisions.ask.size + " still ASK");
  console.log("pseudonyms      " + pseud.size + " (" + Object.entries(pseud.perKind).filter(([, v]) => v).map(([k, v]) => k + "=" + v).join(" ") + ")");
  console.log("exclusion       " + holdout.ids.size + " repo ids + " + extra.size + " manifest ids");
  console.log("wrote           " + jsonlPath);
  console.log("                " + mapPath + "   <- SENSITIVE reverse map");
  console.log("                " + namesPath + "   <- SENSITIVE, awaits owner review");
  console.log("                " + cardPath);
  console.log("                " + outPath(opts.out, OUT_MANIFEST));
  console.log("next            node test/finetune/scrub-discord.mjs --check");
}

// ------------------------------------------------------ name candidate report
// Only the ASK residue. Every other candidate carries a ruling in
// s1-name-decisions.json, and reprinting 214 settled tokens is how a review
// list stops being read at all.
function buildNameCandidates(cand, autoTokens, occurrences, decisions, heuristic, reversed, added) {
  const rows = [...cand.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const ask = rows.filter(([t]) => decisions.ask.has(t));
  const out = [];
  out.push("# S1 person-name candidates — the ASK residue");
  out.push("");
  out.push("SENSITIVE (mode 0600). Tokens, counts and a **paraphrased** one-line gist — no");
  out.push("verbatim message text, by construction.");
  out.push("");
  out.push("Generated by `test/finetune/scrub-discord.mjs` (`" + SCRUB_VERSION + "`) on " + new Date().toISOString() + ".");
  out.push("");
  out.push("## Where the rulings live");
  out.push("");
  out.push("`" + OUT_DECISIONS + "` holds a KEEP / SCRUB / ASK ruling for every one of the");
  out.push(cand.size + " candidates the heuristic surfaced. The scrubber reads it and it OVERRIDES");
  out.push("the heuristic in both directions: **" + reversed.length + "** auto-scrubs were reversed by a KEEP and");
  out.push("**" + added.length + "** tokens were scrubbed that the heuristic never proposed. The bar is *the name");
  out.push("of an actual private individual* — brands, models, places, public figures, concepts,");
  out.push("fiction, jargon and typos are all keeps.");
  out.push("");
  out.push("| | tokens |");
  out.push("|---|---|");
  out.push("| KEEP | " + decisions.keep.size + " (of which owner-ruled: " + decisions.owner.size + ") |");
  out.push("| SCRUB | " + decisions.scrub.size + " |");
  out.push("| ASK — below | " + decisions.ask.size + " |");
  out.push("| heuristic proposed | " + heuristic.size + " |");
  out.push("| scrubbed in the end | " + autoTokens.size + " (" + occurrences + " occurrences replaced) |");
  out.push("");
  out.push("## Still to rule on (" + ask.length + ")");
  out.push("");
  out.push("Each is left **in** `" + OUT_JSONL + "`. Mark keep or scrub and move it into");
  out.push("`" + OUT_DECISIONS + "`; the next run applies it.");
  out.push("");
  out.push("| token | times written | signals | gist |");
  out.push("|---|---|---|---|");
  for (const [t, e] of ask) {
    out.push("| `" + t + "` | " + (e.total ?? e.count) + " | " + [...e.signals].sort().join(", ") +
      " | " + (decisions.ask.get(t) || "_(no gist recorded)_") + " |");
  }
  if (!ask.length) out.push("| _(none — every candidate is ruled)_ | | | |");
  out.push("");
  out.push("The SCRUB set is the checked-in-nowhere sealed list that R3's extraction audit reuses");
  out.push("as its name/handle probe set (\u00a79, R3: \"zero name/handle reproductions\" needs a list of");
  out.push("names to look for).");
  out.push("");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- data card
function buildCard(d) {
  const pct = (n) => ((n / d.msgs.length) * 100).toFixed(2) + "%";
  const contributing = d.holdout.perFile.filter((f) => f.newIds > 0);
  const out = [];
  out.push("# S1 data card — owner Discord corpus, scrubbed");
  out.push("");
  out.push("Generated by `test/finetune/scrub-discord.mjs` (`" + SCRUB_VERSION + "`) on " + new Date().toISOString() + ".");
  out.push("Counts only — no message text appears in this file, by construction.");
  out.push("Hashes of every input and output are in `" + OUT_MANIFEST + "`; `--check` verifies them.");
  out.push("");
  out.push("## Provenance");
  out.push("");
  out.push("| field | value |");
  out.push("|---|---|");
  out.push("| source | `" + CSV + "` |");
  out.push("| source sha256 | `" + sha256File(CSV) + "` |");
  out.push("| source bytes | " + statSync(CSV).size + " |");
  out.push("| loader | `test/harvested/discord-source.mjs` `loadMessages()` |");
  out.push("| role (plan §6.2) | S1 — real typos, chat register; error-channel fitting; eval slices |");
  out.push("| license | the owner's own messages; no third-party grant. D2: scrubbed verbatim may enter distributed weights |");
  out.push("| register (D4) | casual chat |");
  out.push("| privacy posture | D2 (scrubbed verbatim), compensating control R3 (preregistered extraction audit before any release) |");
  out.push("| output | `" + OUT_JSONL + "` (gitignored, mode 0600) |");
  out.push("| pseudonym map reused | " + (d.priorMap ? "yes — validated and extended, so pseudonyms are stable across runs" : "no — fresh map") + " |");
  out.push("| benchmark exclusion | " + (d.noBenchmark ? "**WAIVED** with --no-benchmark-exclusion — this corpus may contain benchmark-reserved messages" : "enforced from " + d.extraPerFile.length + " manifest(s)") + " |");
  out.push("");
  out.push("## Counts");
  out.push("");
  out.push("| | messages |");
  out.push("|---|---|");
  out.push("| in (non-empty, from `loadMessages()`) | " + d.msgs.length + " |");
  out.push("| kept | " + d.records.length + " (" + pct(d.records.length) + ") |");
  out.push("| dropped | " + d.dropped + " (" + pct(d.dropped) + ") |");
  out.push("");
  out.push("## Drop reasons");
  out.push("");
  out.push("First reason wins — a message is charged to the first check it fails, in the order");
  out.push("holdout → exclude-manifest → reserved-token → blockquote → attribution → paste →");
  out.push("raw-name → empty-after-scrub → duplicate.");
  out.push("");
  out.push("| reason | messages | share of input |");
  out.push("|---|---|---|");
  for (const [k, v] of [...d.drops.entries()].sort((a, b) => b[1] - a[1])) out.push("| `" + k + "` | " + v + " | " + pct(v) + " |");
  out.push("");
  out.push("- `holdout-excluded` — the message_id appears in a holdout, benchmark, baseline or label file under `test/harvested/` (R4).");
  out.push("- `excluded-manifest` — supplied via `--exclude`: " + (d.extraPerFile.length ? d.extraPerFile.map((f) => "`" + f.file + "` (" + f.ids + " ids)").join(", ") : "**none — the benchmark exclusion was waived**") + ".");
  out.push("- `reserved-token-collision` — the raw message already contained a token shaped like one of our pseudonyms or placeholders, so a scrubbed record could not be told from an injected one.");
  out.push("- `quote-blockquote` — some line begins with `>`; a Discord quote of somebody else.");
  out.push("- `quote-attribution` — matches an attribution pattern (`said:`, `wrote:` …). Deliberately over-broad: D2's accepted risk covers the OWNER's text, not third parties'.");
  out.push("- `paste-candidate` — structurally shaped like pasted material rather than typed chat. See the next section.");
  out.push("- `contains-raw-name` — the body literally contains a server or channel name (thread titles recur inside their own opening post). Dropped rather than rewritten, so no kept sentence is mangled.");
  out.push("- `empty-after-scrub` — nothing but placeholders and pseudonyms was left. " + d.emptyRawNoLetters +
    " of these had no letter to begin with (a bare emoji, a bare number); the rest were a link or a mention and nothing else.");
  out.push("- `duplicate` — exact " + d.dupExact + ", whitespace/case-normalized only " + d.dupNormalized + "; first occurrence kept and every dropped `message_id` recorded in its `aliases` array (§7.2 lineage).");
  out.push("");
  out.push("## Paste candidates (dropped, not reviewed)");
  out.push("");
  out.push("Markup-only quote detection found 16 messages in 49,784 — an external audit's");
  out.push("structural probe found ~159 more that are shaped like pasted material. None of these");
  out.push("signals is *proof* of a third-party quote; the disposition is to drop the union");
  out.push("anyway, because D2's accepted risk covers the OWNER's text and nothing else.");
  out.push("");
  out.push("| signal | messages firing it |");
  out.push("|---|---|");
  for (const [k, v] of [...d.pasteHitCounts.entries()].sort((a, b) => b[1] - a[1])) out.push("| `" + k + "` | " + v + " |");
  if (!d.pasteHitCounts.size) out.push("| _(none)_ | 0 |");
  out.push("");
  out.push("(Signals overlap; one message can fire several, so the column sums above the drop count.)");
  out.push("");
  out.push("## Person names in prose");
  out.push("");
  out.push("| | value |");
  out.push("|---|---|");
  out.push("| candidate tokens found | " + d.cand.size + " |");
  out.push("| ruled KEEP | " + d.decisions.keep.size + " (owner-ruled: " + d.decisions.owner.size + ") |");
  out.push("| ruled SCRUB | " + d.decisions.scrub.size + " |");
  out.push("| ruled ASK — still in the corpus | " + d.decisions.ask.size + " |");
  out.push("| heuristic proposed | " + d.heuristic.size + " |");
  out.push("| auto-scrubs reversed by a KEEP | " + d.reversed.length + " |");
  out.push("| scrubbed because a ruling said so | " + d.added.length + " |");
  out.push("| replaced by `PERSON_N` | " + d.autoTokens.size + " tokens, " + d.acts.personName + " occurrences |");
  out.push("");
  out.push("Rulings live in `" + OUT_DECISIONS + "` and OVERRIDE the heuristic in both");
  out.push("directions — a KEEP is never replaced however many signals fired, and a SCRUB is");
  out.push("replaced everywhere however few did. The bar is *the name of an actual private");
  out.push("individual*: brands, models, places, public figures, concepts, fiction, jargon and");
  out.push("typos are keeps. The scrubber refuses to run if any candidate is unruled.");
  out.push("");
  out.push("**" + d.decisions.ask.size + " tokens remain ASK** and are still present in the corpus"
    + (d.decisions.ask.size ? ": " + [...d.decisions.ask.keys()].sort().map((t) => "`" + t + "`").join(", ") : "") + ".");
  out.push("`" + OUT_NAMES + "` carries them with a paraphrased context gist each. The SCRUB set is");
  out.push("the sealed name list R3's extraction audit probes for — R3's acceptance rule (\"zero");
  out.push("name/handle reproductions\") needs a list of names to look for, and this is that list.");
  out.push("");
  out.push("Auto-scrub requires four independent signals (vocative/relational pattern, absent");
  out.push("from `data/words-en.txt`, capitalised where a sentence does not start, and the name");
  out.push("patterns accounting for >= " + NAME_PATTERN_SHARE.toFixed(2) + " of every time the token is written at all). A lowercase");
  out.push("first name, a name that is also an ordinary word, and a name only ever seen in a");
  out.push("possessive are all **out of scope of the automatic pass** by construction.");
  out.push("");
  out.push("## Scrub actions (kept messages only)");
  out.push("");
  out.push("| rule | replacements |");
  out.push("|---|---|");
  for (const [k, v] of Object.entries(d.acts)) out.push("| `" + k + "` | " + v + " |");
  out.push("");
  out.push("`genericAt` is `@everyone`/`@here`, counted and deliberately left in place: it names no person and carries chat register.");
  out.push("The phone rule is the audit's **loose** window (7-15 digits over space/dot/hyphen/dash/slash, no newline) minus four");
  out.push("exclusions (ISO date, IPv4, dotted version, year range). It mangles roughly twenty ordinary numeric ranges in 46k");
  out.push("messages, and that is the price of the independent check being able to demand **zero** residual phone windows rather");
  out.push("than reporting an advisory count nobody can act on.");
  out.push("");
  out.push("## Pseudonymized entities");
  out.push("");
  out.push("| namespace | token form | distinct entities |");
  out.push("|---|---|---|");
  for (const [k, v] of Object.entries(d.pseud.perKind)) out.push("| `" + k + "` | `" + PREFIX[k] + "N` | " + v + " |");
  out.push("");
  out.push("Indices come from one global counter, so no two entities of any kind share a number.");
  out.push("A reused map is validated before it is extended (version, namespaces, prefix/kind");
  out.push("agreement, bijection, monotonic counter) and a raw message already containing a");
  out.push("reserved-shaped token is dropped rather than scrubbed.");
  out.push("The reverse map is `" + OUT_MAP + "` — sensitive, mode 0600, local only, never committed.");
  out.push("");
  out.push("## Holdout / benchmark exclusion");
  out.push("");
  out.push("| | value |");
  out.push("|---|---|");
  out.push("| files scanned under `test/harvested/` | " + d.holdout.files.length + " |");
  out.push("| files contributing message_ids | " + contributing.length + " |");
  out.push("| distinct message_ids from those files | " + d.holdout.ids.size + " |");
  out.push("| ids from `--exclude` manifests | " + d.extra.size + " |");
  out.push("| union | " + new Set([...d.holdout.ids, ...d.extra]).size + " |");
  out.push("");
  out.push("Harvested from `message_id` fields, `message_ids` arrays, and any `<message_id>:<sha1[0:10]>`");
  out.push("uid string or object key (`uidFor()`, `discord-source.mjs`). Files contributing at least one id:");
  out.push("");
  out.push("| file | new ids |");
  out.push("|---|---|");
  for (const f of contributing) out.push("| `" + f.file + "` | " + f.newIds + " |");
  out.push("");
  out.push("(\"new ids\" is ids this file added to the running union, so the same corpus recorded many times");
  out.push("contributes once — the order is alphabetical, not causal.)");
  out.push("");
  out.push("An exclusion manifest is **mandatory**: with no `--exclude` and no explicit");
  out.push("`--no-benchmark-exclusion`, the run refuses. The directory scan alone is not enough —");
  out.push("it is non-recursive, and the benchmark reservation lives in a subdirectory.");
  out.push("");
  out.push("## Raw-name check set");
  out.push("");
  out.push("| | value |");
  out.push("|---|---|");
  out.push("| distinct server + channel names in the input | " + d.nameInfo.total + " |");
  out.push("| checked (>= 5 chars and not a dictionary word) | " + d.nameInfo.names.length + " |");
  out.push("| skipped, under 5 chars | " + d.nameInfo.skippedShort + " |");
  out.push("| skipped, an ordinary dictionary word | " + d.nameInfo.skippedWord + " |");
  out.push("");
  out.push("Names are never emitted: the metadata carries `SERVER_N` / `CHANNEL_N` only. The skipped");
  out.push("names are short or are ordinary dictionary words, so a literal occurrence in a body is not");
  out.push("evidence of anything — checking them would fire on ordinary prose.");
  out.push("");
  out.push("## Assembly requirements (BINDING — Phase 2 cannot skip these)");
  out.push("");
  out.push("Two audit findings are **correctly** fixed at assembly rather than here, because both");
  out.push("operate on sentences and this file emits messages. They are recorded here so the");
  out.push("requirement cannot be lost between phases:");
  out.push("");
  out.push("1. **Sentence-level dedup is required before training.** Message-level dedup leaves");
  out.push("   duplicate *sentences* across different messages: measured on the pre-benchmark-");
  out.push("   exclusion output, **449 normalized-exact groups totalling 881 excess instances,");
  out.push("   875 of them across different messages**. Assigning near-duplicate clusters to one");
  out.push("   split does not remove a memorization multiplier — the duplicates must be collapsed,");
  out.push("   with every contributing `message_id` retained as a lineage alias (the `aliases`");
  out.push("   field here is the message-level half of the same mechanism).");
  out.push("2. **Holdout exclusion must also run on exact sentence strings, at every length.**");
  out.push("   ID-level exclusion passes and is not sufficient: **26 distinct exact sentence");
  out.push("   strings from excluded messages survive through other messages, 142 training");
  out.push("   instances**, and all are under five tokens — so the planned normalized 5-gram");
  out.push("   Jaccard sweep can miss every one of them. Run exact normalized-string exclusion");
  out.push("   for all lengths *before* the 5-gram sweep, then assert zero train/eval cluster");
  out.push("   overlap as the Phase 2 gate, with the counts in the assembled dataset's card.");
  out.push("");
  out.push("## Downstream contract");
  out.push("");
  out.push("Records are in corpus order (oldest first) and keep `ts`/`timestamp`, so a");
  out.push("`targetsFor()`-style context window — prior messages in the same channel within 30 min —");
  out.push("rebuilds by grouping on `(server_pseudo, channel_pseudo)`, which is a 1:1 image of the real");
  out.push("`(server, channel)` pair. `message_id` plus `aliases` is the message-level lineage");
  out.push("(plan §7.2); document → sentence → cluster → variant IDs are generated at segmentation.");
  out.push("");
  out.push("Note the context so rebuilt is over KEPT messages only: a dropped message leaves a hole in");
  out.push("its channel's history. " + d.dropped + " of " + d.msgs.length + " messages are missing, so a context window");
  out.push("built from this file is a subset of what production would have shown — and the");
  out.push("benchmark reservation deliberately removes whole episodes, not scattered messages.");
  out.push("");
  out.push("## Limitations");
  out.push("");
  out.push("- **Person names are closed to the candidate set, not to the corpus.** Every token");
  out.push("  the candidate heuristic surfaced is ruled, but the heuristic only surfaces tokens a");
  out.push("  vocative, relational or possessive pattern fired on. A name written only in plain");
  out.push("  apposition was never a candidate and is still in S1." +
    (d.decisions.ask.size ? " " + d.decisions.ask.size + " ruled ASK are also still in." : ""));
  out.push("- **The paste-candidate union is structural, not semantic.** It drops shapes, so it");
  out.push("  drops the owner's own long posts along with anything pasted, and a short quoted");
  out.push("  sentence with no markup still survives.");
  out.push("- **Postal-address shapes are not scrubbed.** The oracle fires on ordinary");
  out.push("  abbreviations (`st`, `dr`, `ct`, `way`) and auto-scrubbing it would mangle prose;");
  out.push("  `--check` reports the count as advisory and it is an owner-review item.");
  out.push("- **Two `@` keyspaces cannot be joined.** `<@id>` mentions carry a snowflake and bare");
  out.push("  `@handle` mentions carry a display name; the same person appears under both `@USER_N`");
  out.push("  and `@HANDLE_N` with no way to link them from this data.");
  out.push("- **Inline `<#id>` channel refs cannot be joined to channel names** either: the loader");
  out.push("  exposes names, not ids, so `#CHANREF_N` is its own namespace and does not correspond");
  out.push("  to the `CHANNEL_N` in the metadata.");
  out.push("- **Third-party text inside owner prose survives** unless it trips the blockquote,");
  out.push("  attribution or paste rules — a paraphrase, a name dropped mid-sentence, a short");
  out.push("  pasted fragment. This is D2's accepted residual, sampled by R3 rather than bounded.");
  out.push("- **`--check` is independent but not exhaustive.** It re-implements its detectors from");
  out.push("  an external audit's oracles rather than sharing the scrub regexes, and plants one");
  out.push("  adversarial fixture per class every run, so it can go red. It still cannot prove the");
  out.push("  class list is complete.");
  out.push("");
  return out.join("\n") + "\n";
}

// ==================================================================== CHECK
// Deliberately a SECOND implementation. Nothing below reuses the scrub regexes
// above: the first revision's self-check shared them and therefore passed over
// two whole classes of residue. Detectors are written from the audit's oracles.

const X = {
  mention: /<@!?\d+>|<@&\d+>|<#\d+>/,
  emojiId: /<a?:[A-Za-z0-9_]+:\d+>/,
  scheme: /\b(?:https?|ftp|ftps|sftp|ssh|git|svn|mailto|tel|callto|steam|discord|irc|ircs|magnet|file|ws|wss):\/?\/?[^\s<>]/i,
  www: /\bwww\.[a-z0-9-]+\./i,
  domain: new RegExp(String.raw`\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:${TLD})\b`, "i"),
  ipv4: /(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])/,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  obfEmail: /\b[A-Za-z0-9._%+-]+\s*(?:\[at\]|\(at\)|\s+at\s+)\s*[A-Za-z0-9.-]+\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*[A-Za-z]{2,}\b/i,
  postal: /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|highway|hwy)\b/i,
  reservedTok: /(?:@USER_|@HANDLE_|@ROLE_|#CHANREF_|SERVER_|CHANNEL_|PERSON_)\d+/g,
  // Our own emitted tokens, blanked before the digit- and dot-sensitive
  // oracles. A pseudonym index is digits: `@USER_116 2027` reads as a 7-digit
  // phone window to any oracle that does not know the first three digits are
  // ours, and demanding the scrub remove them would demand it destroy its own
  // output. Nothing else is blanked, so a real URL beside a pseudonym still
  // fires.
  ours: /<(?:URL|EMAIL|PHONE|IP|TIME)>|(?:@USER_|@HANDLE_|@ROLE_|#CHANREF_|SERVER_|CHANNEL_|PERSON_)\d+/g,
};

/** An @handle the scrub should have taken: any length, any script, not ours. */
function xHandle(s) {
  for (const m of s.matchAll(/(^|[^\w@<])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*)/gu)) {
    const t = m[2];
    // Prefix, not exact: the greedy capture takes the trailing "." of
    // "@USER_23." and any letters abutting it ("<@id>ing" -> "@USER_10ing").
    // A raw handle that genuinely began "USER_12" cannot reach here — such a
    // message is dropped as reserved-token-collision before it is scrubbed.
    if (/^(?:USER|HANDLE|ROLE)_\d+/.test(t)) continue;
    const low = t.toLowerCase();
    if (low === "everyone" || low === "here") continue;
    return true;
  }
  return false;
}

/** The audit's loose phone window, re-derived rather than imported. */
function xPhone(s) {
  const windows = s.match(/\+?\d[\d \t().\-\u2013\u2014/]{5,}\d/g) || [];
  for (const w of windows) {
    const t = w.trim();
    const d = t.replace(/\D/g, "");
    if (d.length < 7 || d.length > 15) continue;
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t)) continue;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(t)) continue;
    if (/^\d+(?:\.\d+){2,}$/.test(t)) continue;
    if (/^\d{4}\s*[-\u2013\u2014]\s*\d{4}$/.test(t)) continue;
    return true;
  }
  return false;
}

const REC_KEYS = ["message_id", "aliases", "ts", "timestamp", "server_pseudo", "channel_pseudo", "content"];

function xSchemaBad(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return true;
  const keys = Object.keys(r).sort();
  if (keys.length !== REC_KEYS.length || keys.join(",") !== [...REC_KEYS].sort().join(",")) return true;
  if (typeof r.message_id !== "string" || !/^\d{6,}$/.test(r.message_id)) return true;
  if (!Array.isArray(r.aliases) || r.aliases.some((a) => typeof a !== "string" || !/^\d{6,}$/.test(a))) return true;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return true;
  if (typeof r.timestamp !== "string" || !r.timestamp) return true;
  if (!/^SERVER_\d+$/.test(r.server_pseudo || "")) return true;
  if (!/^CHANNEL_\d+$/.test(r.channel_pseudo || "")) return true;
  if (typeof r.content !== "string" || !r.content.trim()) return true;
  return false;
}

/** Every fatal content class one record can be guilty of. */
function xClasses(r, ctx) {
  const hits = [];
  if (xSchemaBad(r)) { hits.push("schema"); return hits; }
  const c = r.content;
  const cs = c.replace(X.ours, " ");     // our own tokens blanked; see X.ours
  if (X.mention.test(c)) hits.push("mention-syntax");
  if (X.emojiId.test(c)) hits.push("emoji-snowflake");
  if (X.scheme.test(c) || X.www.test(c)) hits.push("uri-scheme");
  if (X.domain.test(cs)) hits.push("bare-domain");
  if (X.ipv4.test(cs)) hits.push("ipv4");
  if (X.email.test(c)) hits.push("email");
  if (X.obfEmail.test(c)) hits.push("obfuscated-email");
  if (xHandle(c)) hits.push("handle");
  if (xPhone(cs)) hits.push("phone-window");
  if (pasteSignals(c).length) hits.push("paste-shape");
  const low = c.toLowerCase();
  for (const n of ctx.names) if (low.includes(n)) { hits.push("raw-name"); break; }
  for (const t of ctx.autoNameTokens) if (new RegExp("(?:^|[^\\p{L}])" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\p{L}])", "u").test(c)) { hits.push("name-token-leak"); break; }
  for (const t of c.match(X.reservedTok) || []) if (!ctx.mapValues.has(t)) { hits.push("unknown-pseudonym"); break; }
  if (!ctx.mapValues.has(r.server_pseudo) || !ctx.mapValues.has(r.channel_pseudo)) hits.push("metadata-not-in-map");
  if (ctx.excluded.has(r.message_id) || r.aliases.some((a) => ctx.excluded.has(a))) hits.push("excluded-id-present");
  if (ctx.rawIds && !ctx.rawIds.has(r.message_id)) hits.push("not-in-raw-corpus");
  return hits;
}

/** One planted violation per class. A detector that has stopped firing is a
 *  silent hole, so the gate proves it can go red before it reports green. */
function xFixtures(ctx) {
  const base = { message_id: "123456789012345678", aliases: [], ts: 1, timestamp: "2026-01-01 00:00:00", server_pseudo: "SERVER_1", channel_pseudo: "CHANNEL_1", content: "ok sounds good to me" };
  const rec = (o) => ({ ...base, ...o });
  const cases = [
    ["schema", rec({ ts: "1" })],
    ["mention-syntax", rec({ content: "ping <@1234567890123> about it" })],
    ["emoji-snowflake", rec({ content: "nice <:blob:1234567890> one" })],
    ["uri-scheme", rec({ content: "see https://example.com/x later" })],
    ["bare-domain", rec({ content: "it is on example.com somewhere" })],
    ["ipv4", rec({ content: "box at 192.168.10.24 is up" })],
    ["email", rec({ content: "mail someone@example.org today" })],
    ["obfuscated-email", rec({ content: "reach me at someone [at] example [dot] org" })],
    ["handle", rec({ content: "thanks @q for that" })],
    ["phone-window", rec({ content: "call 555-123-4567 tomorrow" })],
    ["paste-shape", rec({ content: "aa: x\nbb: y\ncc: z" })],
    ["unknown-pseudonym", rec({ content: "hello @USER_99999999 there" })],
    ["metadata-not-in-map", rec({ server_pseudo: "SERVER_99999999" })],
    ["excluded-id-present", rec({ message_id: ctx.someExcludedId || "999999999999999999" })],
    ["not-in-raw-corpus", rec({ message_id: "111111111111111111" })],
  ];
  const missed = [];
  for (const [cls, r] of cases) if (!xClasses(r, ctx).includes(cls)) missed.push(cls);
  if (ctx.names.length) {
    const r = { ...base, content: "we talked about " + ctx.names[0] + " earlier" };
    if (!xClasses(r, ctx).includes("raw-name")) missed.push("raw-name");
  }
  if (ctx.autoNameTokens.length) {
    const r = { ...base, content: "hey " + ctx.autoNameTokens[0] + " are you around" };
    if (!xClasses(r, ctx).includes("name-token-leak")) missed.push("name-token-leak");
  }
  return missed;
}

function runCheck(opts) {
  const jsonlPath = outPath(opts.out, OUT_JSONL);
  const manifestPath = outPath(opts.out, OUT_MANIFEST);
  if (!existsSync(jsonlPath)) die("no output to check: " + jsonlPath + " (run the scrubber first)");
  if (!existsSync(manifestPath)) die("no manifest to check against: " + manifestPath + " (re-run the scrubber; a corpus with no manifest is unattributable)");
  const text = readFileSync(jsonlPath, "utf8").trim();
  if (!text) die("output is empty: " + jsonlPath);

  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { die("manifest is not valid JSON: " + manifestPath); }
  if (manifest.version !== SCRUB_VERSION) die("manifest version " + JSON.stringify(manifest.version) + " != " + SCRUB_VERSION + " — regenerate S1");

  let msgs;
  try { msgs = loadMessages(); } catch (e) {
    if (e && e.code) die("could not read the Discord export (" + e.code + "), so the differential check cannot run: " + CSV);
    throw e;
  }
  const dict = loadDict();
  const nameInfo = sensitiveNames(msgs, dict);
  const rawIds = new Set(msgs.map((m) => m.message_id));

  // --- manifest integrity (§9) --------------------------------------------
  const mismatches = [];
  const expect = (label, path) => {
    const want = manifest.sha256?.[label];
    if (!want) { mismatches.push(label + ": absent from the manifest"); return; }
    if (!existsSync(path)) { mismatches.push(label + ": file missing"); return; }
    if (sha256File(path) !== want) mismatches.push(label + ": on-disk sha256 differs");
  };
  expect("scrubber", fileURLToPath(SELF));
  expect("source_csv", CSV);
  expect(OUT_JSONL, jsonlPath);
  expect(OUT_MAP, outPath(opts.out, OUT_MAP));
  expect(OUT_NAMES, outPath(opts.out, OUT_NAMES));
  expect(OUT_CARD, outPath(opts.out, OUT_CARD));
  for (const m of manifest.exclusion?.manifests || []) {
    if (!existsSync(m.file)) mismatches.push("exclusion manifest " + m.file + ": missing");
    else if (sha256File(m.file) !== m.sha256) mismatches.push("exclusion manifest " + m.file + ": sha256 differs");
  }
  if (manifest.benchmark_exclusion_waived) mismatches.push("the benchmark exclusion was WAIVED for this corpus");

  // --- rebuild the exclusion union independently ---------------------------
  const excluded = new Set();
  const holdout = scanHoldouts();
  for (const id of holdout.ids) excluded.add(id);
  for (const m of manifest.exclusion?.manifests || []) {
    if (existsSync(m.file)) idsFromText(readFileSync(m.file, "utf8"), excluded);
  }

  const map = JSON.parse(readFileSync(outPath(opts.out, OUT_MAP), "utf8"));
  const mapValues = new Set(Object.values(map.entries || {}));
  // Sourced from the RULINGS, not from the scrubber's own report: the oracle is
  // "no token ruled SCRUB survives in the output", and reading it back out of a
  // file the same run wrote would make the check agree with itself.
  const decPath = outPath(opts.out, OUT_DECISIONS);
  if (!existsSync(decPath)) die("--check: name decisions not found: " + decPath);
  const decJson = JSON.parse(readFileSync(decPath, "utf8"));
  const autoNameTokens = Object.entries(decJson.decisions || {})
    .filter(([, v]) => v && v.decision === "SCRUB").map(([t]) => t).sort();
  if (!autoNameTokens.length) die("--check: no SCRUB rulings in " + decPath + " — the name-leak detector has nothing to look for");

  const ctx = {
    names: nameInfo.names, autoNameTokens, mapValues, excluded, rawIds,
    someExcludedId: [...excluded][0],
  };

  const missed = xFixtures(ctx);
  const fixturesOk = !missed.length;
  if (missed.length) {
    console.error("FAIL: the check's own detectors did not fire on planted violations: " + missed.join(", "));
    process.exit(1);
  }

  const fatal = new Map();
  const advisory = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let n = 0, badJson = 0;
  const seenIds = new Set();
  let prevTs = -Infinity;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    n++;
    let r;
    try { r = JSON.parse(line); } catch { badJson++; bump(fatal, "unparseable-line"); continue; }
    for (const cls of xClasses(r, ctx)) bump(fatal, cls);
    if (seenIds.has(r.message_id)) bump(fatal, "duplicate-message-id");
    seenIds.add(r.message_id);
    if (typeof r.ts === "number") { if (r.ts < prevTs) bump(fatal, "nonmonotonic-ts"); prevTs = r.ts; }
    if (typeof r.content === "string") {
      if (X.postal.test(r.content)) bump(advisory, "postal-shape");
      if (/\d{7,}/.test(r.content.replace(PLACEHOLDER_RE, " "))) bump(advisory, "digit-run-7plus");
      if (r.content.length >= 500) bump(advisory, "chars-ge-500");
    }
  }
  if (!n) die("output contains no records: " + jsonlPath);

  console.log("checked         " + n + " records in " + jsonlPath);
  console.log("fixtures        " + (fixturesOk ? "all classes fire on a planted violation" : "FAILED"));
  console.log("exclusion union " + excluded.size + " message_ids (" + holdout.ids.size + " repo + manifests)");
  console.log("raw-name set    " + nameInfo.names.length + " of " + nameInfo.total + " | auto-scrubbed name tokens " + autoNameTokens.length);
  console.log("manifest        " + (mismatches.length ? mismatches.length + " PROBLEM(S)" : "matches every hash on disk"));
  for (const m of mismatches) console.log("  ! " + m);
  const classes = ["schema", "unparseable-line", "mention-syntax", "emoji-snowflake", "uri-scheme", "bare-domain", "ipv4",
    "email", "obfuscated-email", "handle", "phone-window", "paste-shape", "raw-name", "name-token-leak",
    "unknown-pseudonym", "metadata-not-in-map", "excluded-id-present", "not-in-raw-corpus", "duplicate-message-id", "nonmonotonic-ts"];
  for (const k of classes) console.log("  " + k.padEnd(22) + (fatal.get(k) || 0));
  console.log("advisory (reported, not fatal — these oracles fire on ordinary prose):");
  for (const [k, v] of [...advisory.entries()].sort()) console.log("  " + k.padEnd(22) + v);

  const hits = [...fatal.entries()].filter(([, v]) => v > 0);
  if (hits.length || mismatches.length) {
    console.error("FAIL: " + [...hits.map(([k, v]) => k + "=" + v), ...(mismatches.length ? ["manifest=" + mismatches.length] : [])].join(", ") +
      " (counts only; matched text is never printed)");
    process.exit(1);
  }
  console.log("clean");
}

const opts = parseArgs(process.argv.slice(2));
if (opts.check) runCheck(opts); else runScrub(opts);
