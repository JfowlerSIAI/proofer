#!/usr/bin/env node
// Historical contribution and support-file provenance, with deletion on request. See docs/privacy-policy.md for the sharing/deletion policy.
//
//   node contributions.mjs ingest <export.jsonl> --contributor p07 \
//        --consent <notice version> --training yes|no --channel <how it arrived>
//        [--training-agreement <reference to a separate explicit agreement>]
//   node contributions.mjs list
//   node contributions.mjs register <dir>
//   node contributions.mjs delete --contributor p07 [--batch <id>] [--dry-run]
//
//   --root <dir>   the harvested tree (default: test/harvested)
//
// Each contribution goes to <root>/beta/<contributor>/<batch>/ -- never merged
// unlabelled into the owner's corpus -- as raw.jsonl (the file as received) and
// manifest.json: the pseudonym, the batch (the first 12 hex of the file's
// SHA-256, never its name), when it arrived, which consent notice they saw,
// whether they authorised training use, and how it arrived. Directories 0700,
// files 0600: this is somebody's writing.
//
// `register <dir>` records a directory OUTSIDE the root that holds anything
// made from contributions -- a dataset exported for training, an analysis kept
// elsewhere -- in <root>/beta/artifact-roots.json. `list` shows them, and
// `delete` walks every one of them as well as the root.
//
// DELETION HAS TO REACH EVERYTHING, AND SAY WHEN IT DID NOT. `delete` removes
// the contributor's raw files and manifests, then walks the root and every
// registered directory and removes each case whose provenance names them
// (log-to-cases.mjs keeps a list of sources per case, merged across
// duplicates) wherever it sits: in any array at any depth of a .json file, or
// on any line of a .jsonl file, at the top of the line or nested inside it. A
// case with sources left keeps only those; a case with none left goes. It
// prints what it removed, file by file.
//
// Then it checks its own work. Before anything is removed it reads the
// prose the contributor recorded -- flat input/output/finalText, context,
// legacy retry outputs, canonical attempt outputs and retry keep strings --
// less any that another contributor's raw file
// also holds: a shared sentence stays, for them. After the rewrite it re-reads
// every file in every walked location, whatever its extension, and looks for a
// provenance entry still naming the contributor (and batch, if given) and for
// any of those sentences, as written or inside a JSON string. Each hit is
// printed with its path and the command exits 1, "NOT fully deleted". A file
// it could not rewrite -- not JSON or JSONL, a line that does not parse, too
// large to read whole -- is named as an unsupported artifact rather than
// passed over. --dry-run runs the same check against what the files would
// hold and changes nothing; run it first, because a real run removes the raw
// file, and with it the list of sentences a second run could look for.
//
// Symbolic links are never followed. One under a walked location is fine when
// its target is itself walked (under the root, or registered); one pointing
// anywhere else is a place the check could not look, so it fails the run
// (exit 1) with the advice to register its target. A --contributor or --batch that names a link, a --batch that is
// not a batch id as ingest makes them, or a path that resolves outside the
// contributor's own directory is refused (exit 2) before anything is removed.
// test/contributions-test.mjs shows all of this on synthetic contributors.

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync,
  statSync, lstatSync, realpathSync, rmSync, unlinkSync, copyFileSync, openSync, readSync, closeSync } from "fs";
import { interactionProse } from "./lib/log-record.mjs";
import { createHash } from "crypto";
import { basename, dirname, extname, isAbsolute, join, resolve, relative, sep } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = args[0];
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
// A flag given with no value is an error, not an absent flag: `--batch
// --dry-run` must not quietly become "delete every batch", and `--contributor
// --dry-run` must not name a directory called --dry-run.
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : die(`${name} needs a value`);
};
const has = (name) => args.includes(name);
const ROOT = resolve(flag("--root") || join(__dirname, "harvested"));
const BETA = join(ROOT, "beta");
const REGISTRY = join(BETA, "artifact-roots.json");
const BATCH_ID = /^[0-9a-f]{12}$/;     // what ingest makes: the first 12 hex of the file's SHA-256
const MIN_TEXT = 10;                   // the product's MIN_SENTENCE_CHARS: nothing shorter was a sentence
const PARSE_LIMIT = 256 << 20;         // bytes; a larger file is searched, never parsed or rewritten

const pseudonym = (s) => (/^[A-Za-z0-9_-]{1,32}$/.test(s || "") ? s : die("--contributor must be a pseudonym: letters, digits, _ and -, at most 32"));
const mkdirPrivate = (d) => { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); };
const writePrivate = (p, text) => { writeFileSync(p, text, { mode: 0o600 }); chmodSync(p, 0o600); };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const inside = (rel) => !!rel && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
const show = (p) => { const r = relative(existsSync(ROOT) ? realpathSync(ROOT) : ROOT, p); return inside(r) ? r : p; };

// Every file under dir. A symbolic link is never followed -- it could lead the
// walk, and a rewrite, out of the tree it was asked to cover -- and comes back
// in `links` so the caller can say it skipped it.
function walk(dir, out = { files: [], links: [] }) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.links.push(p);
    else if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.files.push(p);
  }
  return out;
}

// Refuses (exit 2) unless p lies strictly beneath parent, both resolved
// through any link on the way. Behind the batch pattern and the link checks
// no argument reaches this with a path in it; it is here so that loosening
// either cannot turn an argument into a directory outside the contributor's.
function within(p, parent, what) {
  const real = (x) => (existsSync(x) ? realpathSync(x) : resolve(x));
  if (!inside(relative(real(parent), real(p)))) die(`refusing ${what}: ${p} is not inside ${parent}`);
}

function registered() {
  if (!existsSync(REGISTRY)) return [];
  let list = null;
  try { list = JSON.parse(readFileSync(REGISTRY, "utf8")); } catch {}
  if (!Array.isArray(list) || !list.every((d) => typeof d === "string" && isAbsolute(d))) {
    die(`${REGISTRY} is not a list of absolute directories: fix it by hand before anything is deleted`);
  }
  return list;
}

// Which of `needles` occur in a file or a string. A contributor's ring holds
// up to 5,000 records and the harvested tree is over a gigabyte, so this is
// one pass per file however many needles there are (Rabin-Karp over a fixed
// window), read in chunks because a file can be too large to hold as one
// string. The few needles under 8 bytes (a short pseudonym) use indexOf.
function scanner(needles) {
  const all = [...new Set(needles)].filter(Boolean).map((s) => ({ s, b: Buffer.from(s, "utf8") }));
  const few = all.filter((n) => n.b.length < 8), many = all.filter((n) => n.b.length >= 8);
  const K = Math.min(32, ...many.map((n) => n.b.length));
  const B = 257, MASK = (1 << 20) - 1;
  let pow = 1;
  for (let i = 1; i < K; i++) pow = Math.imul(pow, B);
  const hashAt = (buf, at) => { let h = 0; for (let i = at; i < at + K; i++) h = (Math.imul(h, B) + buf[i]) | 0; return h; };
  const buckets = new Map(), maybe = new Uint8Array(MASK + 1);
  for (const n of many) {
    const h = hashAt(n.b, 0);
    maybe[h & MASK] = 1;
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h).push(n);
  }
  const search = (buf, found) => {
    for (const n of few) if (!found.has(n.s) && buf.indexOf(n.b) >= 0) found.add(n.s);
    if (!many.length || buf.length < K) return;
    let h = hashAt(buf, 0);
    for (let i = 0; ; i++) {
      if (maybe[h & MASK]) {
        for (const n of buckets.get(h) || []) {
          if (!found.has(n.s) && i + n.b.length <= buf.length
              && buf.compare(n.b, 0, n.b.length, i, i + n.b.length) === 0) found.add(n.s);
        }
      }
      if (i + K >= buf.length) break;
      h = (Math.imul(h - Math.imul(buf[i], pow), B) + buf[i + K]) | 0;
    }
  };
  const longest = Math.max(1, ...all.map((n) => n.b.length));
  return {
    inText: (s) => { const found = new Set(); if (all.length) search(Buffer.from(s, "utf8"), found); return found; },
    // Chunks overlap by one byte less than the longest needle, so every
    // occurrence lies whole inside one of them.
    inFile: (p) => {
      const found = new Set();
      if (!all.length) return found;
      const fd = openSync(p, "r"), chunk = Buffer.allocUnsafe(Math.max(1, Math.min(16 << 20, statSync(p).size)));
      try {
        let carry = Buffer.alloc(0), n;
        while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
          const buf = Buffer.concat([carry, chunk.subarray(0, n)]);
          search(buf, found);
          carry = buf.subarray(buf.length - Math.min(buf.length, longest - 1));
        }
      } finally { closeSync(fd); }
      return found;
    },
  };
}

// The ways a sentence is likely to sit in a file: as typed, whitespace
// collapsed (log-to-cases compares that way), and inside a JSON string --
// escaped as JSON.stringify does, or as Python's json.dumps does by default,
// every non-ASCII character as \uXXXX (a curly apostrophe is enough).
const norm = (s) => s.replace(/\s+/g, " ").trim();
const jsonBody = (s) => JSON.stringify(s).slice(1, -1);
const asciiBody = (s) => jsonBody(s).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const forms = (t) => [...new Set([t, norm(t)].flatMap((s) => [s, jsonBody(s), asciiBody(s)]))].filter((s) => s.length >= MIN_TEXT);

// Takes the contributor's sources off every case anywhere inside v: in any
// array, under any key, at any depth. A case is an object with a provenance
// list; one left with no source comes back GONE, and its container drops it.
const GONE = Symbol("gone");
function scrub(v, matches, tally) {
  if (Array.isArray(v)) return v.map((x) => scrub(x, matches, tally)).filter((x) => x !== GONE);
  if (!v || typeof v !== "object") return v;
  let out = v;
  if (Array.isArray(v.provenance)) {
    const keep = v.provenance.filter((src) => !matches(src));
    if (keep.length < v.provenance.length) {
      if (!keep.length) { tally.removed++; return GONE; }
      tally.trimmed++;
      out = { ...v, provenance: keep };
    }
  }
  const next = {};
  for (const [k, x] of Object.entries(out)) { const y = scrub(x, matches, tally); if (y !== GONE) next[k] = y; }
  return next;
}

// How many provenance lists anywhere inside v still name the contributor.
function stillNamed(v, matches) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + stillNamed(x, matches), 0);
  if (!v || typeof v !== "object") return 0;
  let n = Array.isArray(v.provenance) && v.provenance.some(matches) ? 1 : 0;
  for (const x of Object.values(v)) n += stillNamed(x, matches);
  return n;
}

// A .json file's value, or a .jsonl file's values one per line; null when the
// file is neither, does not parse, or is too large to read whole -- which is
// what makes it an unsupported artifact.
function parseArtifact(p, text) {
  const ext = extname(p);
  if (ext !== ".json" && ext !== ".jsonl") return null;
  if (text == null) { if (statSync(p).size > PARSE_LIMIT) return null; text = readFileSync(p, "utf8"); }
  try {
    return ext === ".json" ? [JSON.parse(text)] : text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return null; }
}

if (cmd === "ingest") {
  const file = args[1] && !args[1].startsWith("--") ? args[1] : die("usage: ingest <export.jsonl> --contributor ...");
  const contributor = pseudonym(flag("--contributor"));
  if (isLink(join(BETA, contributor))) die(`refusing: ${join(BETA, contributor)} is a symbolic link`);
  // The notice version travels in the file: Proofer's export ends with a
  // {path: "notice"} row naming the notice the person saw (popup.js). An
  // explicit --consent must agree with it; a file from before that row needs
  // one.
  const fileRows = readFileSync(resolve(file), "utf8").split("\n").filter((l) => l.trim());
  let noticeRow = null;
  try { const last = JSON.parse(fileRows[fileRows.length - 1] || "null"); if (last && last.path === "notice") noticeRow = last; } catch {}
  const given = flag("--consent");
  if (noticeRow && given && given !== noticeRow.notice) {
    die(`--consent ${given} disagrees with the notice named in the file (${noticeRow.notice})`, 1);
  }
  const consent = (noticeRow && noticeRow.notice) || given
    || die("--consent: the version of the export notice they saw (this file does not name one)");
  const training = flag("--training");
  if (training !== "yes" && training !== "no") die("--training yes|no: whether they authorised training use");
  // A public export notice authorizes no training. Historical notices still
  // require the operator's explicit yes/no choice; other versions also need a
  // reference to the separately recorded agreement, never merely the export.
  const trainingAgreement = flag("--training-agreement");
  const legacyDonationNotices = new Set(["draft-2026-09-24", "2026-10-02"]);
  if (training === "yes" && !legacyDonationNotices.has(consent) && !trainingAgreement?.trim()) {
    die("This export notice grants no training permission. Use --training no, or supply --training-agreement naming a separate explicit agreement.");
  }
  const channel = flag("--channel") || die("--channel: how the file arrived (e.g. email)");
  const bytes = readFileSync(resolve(file));
  const batch = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const dir = join(BETA, contributor, batch);
  if (existsSync(join(dir, "manifest.json"))) die(`already ingested: ${contributor}/${batch}`, 1);
  const records = bytes.toString("utf8").split("\n").filter((l) => l.trim()).length;
  mkdirPrivate(ROOT); mkdirPrivate(BETA); mkdirPrivate(join(BETA, contributor)); mkdirPrivate(dir);
  copyFileSync(resolve(file), join(dir, "raw.jsonl"));
  chmodSync(join(dir, "raw.jsonl"), 0o600);
  const manifest = { contributor, batch, receivedAt: new Date().toISOString(), consentVersion: consent,
    training: training === "yes", channel, records, bytes: bytes.length,
    ...(training === "yes" && trainingAgreement ? { trainingAgreement } : {}) };
  writePrivate(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`ingested ${contributor}/${batch}: ${records} lines, training ${manifest.training ? "authorised" : "NOT authorised"}`);
  console.log(`  ${relative(process.cwd(), dir)}`);
  console.log(`next: node log-to-cases.mjs ${relative(process.cwd(), join(dir, "raw.jsonl"))} --contributor ${contributor} --out ${relative(__dirname, dir)}`);
  process.exit(0);
}

if (cmd === "list") {
  const rows = walk(BETA).files.filter((p) => basename(p) === "manifest.json").map((p) => JSON.parse(readFileSync(p, "utf8")));
  if (!rows.length) console.log("no contributions");
  for (const m of rows) console.log(`${m.contributor}/${m.batch}  ${m.receivedAt.slice(0, 10)}  ${m.records} lines  consent ${m.consentVersion}  training ${m.training ? "yes" : "no"}  via ${m.channel}`);
  const roots = registered();
  console.log(roots.length ? `registered locations outside the root (delete walks these too):\n${roots.map((d) => "  " + d).join("\n")}`
    : "no locations registered outside the root");
  process.exit(0);
}

if (cmd === "register") {
  const given = args[1] && !args[1].startsWith("--") ? resolve(args[1]) : die("usage: register <dir>");
  if (!existsSync(given) || !statSync(given).isDirectory()) die(`not a directory: ${given}`);
  const dir = realpathSync(given);
  const roots = registered();
  if (roots.includes(dir)) { console.log(`already registered: ${dir}`); process.exit(0); }
  mkdirPrivate(ROOT); mkdirPrivate(BETA);
  writePrivate(REGISTRY, JSON.stringify([...roots, dir], null, 2) + "\n");
  console.log(`registered ${dir}: delete walks it as well as ${ROOT}`);
  process.exit(0);
}

if (cmd === "delete") {
  const contributor = pseudonym(flag("--contributor"));
  const batch = flag("--batch");
  if (batch !== null && !BATCH_ID.test(batch)) die("--batch must be a batch id as ingest printed it: 12 hex digits");
  const dry = has("--dry-run");
  const who = contributor + (batch ? "/" + batch : "");
  const matches = (p) => !!p && p.contributor === contributor && (!batch || p.batch === batch);

  // 0. The directory about to be removed recursively must be exactly the one
  // the arguments name: neither it nor the contributor's directory a symbolic
  // link, each strictly beneath its parent once resolved.
  const beta = existsSync(BETA) ? realpathSync(BETA) : BETA;
  const contribDir = join(beta, contributor);
  const own = batch ? join(contribDir, batch) : contribDir;
  for (const d of new Set([contribDir, own])) if (isLink(d)) die(`refusing to delete: ${d} is a symbolic link`);
  within(contribDir, beta, "--contributor");
  if (batch) within(own, contribDir, "--batch");
  const inOwn = (p) => p === own || p.startsWith(own + sep);

  // 1. Where derived artifacts live: the root and every registered directory.
  // One that cannot be walked may still hold their writing.
  const problems = [];
  const starts = existsSync(ROOT) ? [realpathSync(ROOT)] : [];
  for (const d of registered()) {
    if (isLink(d)) problems.push(`registered location ${d} is now a symbolic link, so it was not followed`);
    else if (!existsSync(d)) problems.push(`registered location ${d} does not exist, so it could not be checked (take it out of ${show(REGISTRY)} if it is gone for good)`);
    else starts.push(d);
  }
  const survey = () => {
    const files = new Set(), links = new Set();
    for (const s of starts) { const w = walk(s); w.files.forEach((f) => files.add(f)); w.links.forEach((l) => links.add(l)); }
    return { files: [...files], links: [...links] };
  };

  // 2. What they wrote, read before anything is removed, less what another
  // raw file still kept (someone else's, or this contributor's other batches)
  // also holds.
  const rawFiles = walk(beta).files.filter((p) => basename(p) === "raw.jsonl");
  const theirs = new Set();
  let unreadable = 0, short = 0;
  for (const p of rawFiles.filter(inOwn)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { unreadable++; continue; }
      for (const value of interactionProse(r)) {
        if (value.length >= MIN_TEXT) theirs.add(value); else short++;
      }
    }
  }
  const candidates = scanner([...theirs].flatMap(forms));
  const sharedForms = new Set();
  for (const p of rawFiles.filter((f) => !inOwn(f))) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const prose = interactionProse(r);
      for (const value of prose) for (const form of forms(value)) {
        for (const hit of candidates.inText(form)) sharedForms.add(hit);
      }
    }
  }
  const texts = [...theirs].filter((t) => !forms(t).some((f) => sharedForms.has(f)));

  const report = [];
  if (!rawFiles.some(inOwn)) report.push(`no raw file for ${who} under ${show(beta)}: the check below looks for provenance only, not for their sentences`);
  if (unreadable) report.push(`${unreadable} line(s) of ${who}'s raw file(s) did not parse: whatever they held is not searched for`);
  if (short) report.push(`${short} text(s) under ${MIN_TEXT} characters are too short to attribute and are not searched for`);

  // 3. The contribution itself.
  if (existsSync(own)) {
    report.push(`removed ${walk(own).files.length} file(s) under ${show(own)}`);
    if (!dry) rmSync(own, { recursive: true, force: true });
  }

  // 4. Everything derived from it. A provenance entry naming them holds their
  // pseudonym as a JSON string however it is spaced, so a file without one is
  // not parsed at all.
  const marker = JSON.stringify(contributor);
  const planned = new Map();   // path -> what it will hold; null when nothing is left of it
  const before = survey();
  for (const p of before.files) {
    const ext = extname(p);
    if (inOwn(p) || (ext !== ".json" && ext !== ".jsonl") || statSync(p).size > PARSE_LIMIT) continue;
    const text = readFileSync(p, "utf8");
    if (!text.includes(marker)) continue;
    const tally = { removed: 0, trimmed: 0 };
    let next;
    if (ext === ".json") {
      let data;
      try { data = JSON.parse(text); } catch { continue; }   // unsupported: step 5 names it if it holds anything
      const v = scrub(data, matches, tally);
      next = v === GONE ? null : JSON.stringify(v, null, 2) + "\n";
    } else {
      // One value per line, written back one per line; a line left alone is
      // kept byte for byte. A line that does not parse makes the whole file
      // unsupported: rewriting around it could keep what it holds unseen.
      const lines = [];
      let bad = false;
      for (const line of text.split("\n")) {
        if (!line.trim()) { lines.push(line); continue; }
        let v;
        try { v = JSON.parse(line); } catch { bad = true; break; }
        const was = tally.removed + tally.trimmed;
        const w = scrub(v, matches, tally);
        if (w !== GONE) lines.push(tally.removed + tally.trimmed === was ? line : JSON.stringify(w));
      }
      if (bad) continue;
      next = lines.join("\n");
    }
    if (!tally.removed && !tally.trimmed) continue;
    planned.set(p, next);
    report.push(`${show(p)}: ${tally.removed} case(s) removed, ${tally.trimmed} kept with ${who}'s source taken off${next === null ? " -- nothing left, file removed" : ""}`);
    if (!dry) { if (next === null) unlinkSync(p); else writePrivate(p, next); }
  }

  // 5. Check the work. Every file in every walked location, whatever its
  // extension -- re-read from disk after a real run, as it would be written
  // on a dry one -- for a provenance entry still naming them and for any
  // sentence that is theirs alone.
  const probe = scanner([...texts.flatMap(forms), marker, ...(batch ? [JSON.stringify(batch)] : [])]);
  const end = dry ? before : survey();
  const after = end.files.filter((p) => !(dry && (inOwn(p) || planned.get(p) === null)));
  for (const p of after) {
    const pending = dry && planned.has(p) ? planned.get(p) : null;
    const found = pending !== null ? probe.inText(pending) : probe.inFile(p);
    if (!found.size) continue;
    const held = texts.filter((t) => forms(t).some((f) => found.has(f))).length;
    const values = parseArtifact(p, pending);
    const named = !found.has(marker) ? 0
      : values ? stillNamed(values, matches)
      : !batch || found.has(JSON.stringify(batch)) ? 1 : 0;
    if (!held && !named) continue;
    const what = [held && `${held} sentence(s) only ${contributor} wrote`,
      named && (values ? `${named} provenance list(s) naming ${who}` : `what looks like provenance naming ${who}`)].filter(Boolean).join(" and ");
    problems.push(`${show(p)}: ${values ? "" : "unsupported artifact (not JSON or JSONL this tool can rewrite), "}still holds ${what}`);
  }
  // A link is not followed, so what it points at is checked only if it is
  // itself walked. Anywhere else is a place this check could not look: a
  // failure, not a note -- "fully deleted" is a claim about everywhere.
  const covered = (t) => starts.some((st) => t === st || t.startsWith(st + sep));
  for (const l of end.links) {
    let target = null;
    try { target = realpathSync(l); } catch {}
    if (target && covered(target)) report.push(`did not follow the symbolic link ${show(l)}; its target is checked where it is`);
    else problems.push(`${show(l)} is a symbolic link to ${target || "nothing"}, which this check does not walk (register the target, then run again)`);
  }

  console.log(report.length ? report.join("\n") : `nothing found for ${who}`);
  if (problems.length) {
    console.error(problems.map((x) => `${dry ? "would NOT be fully deleted" : "NOT fully deleted"}: ${x}`).join("\n"));
    console.error(dry ? `(dry run: nothing was changed. ${who} would NOT be fully deleted: deal with the above first)`
      : `${who} is NOT fully deleted: remove what is listed above by hand. Their raw file is gone, so a second run can check provenance but not their sentences.`);
    process.exit(1);
  }
  console.log(`checked ${after.length} file(s) in ${starts.length} location(s): nothing of ${who}'s is left in them${texts.length ? "" : " that carries provenance"}`);
  if (dry) console.log("(dry run: nothing was changed)");
  process.exit(0);
}

die("usage: node contributions.mjs ingest|list|register|delete ... (see the header)");
