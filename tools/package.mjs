#!/usr/bin/env node
/**
 * Build a clean, installable copy of the extension.
 *
 * WHY THIS EXISTS
 *
 * Loading the repository root would include development tools, test captures,
 * and any local research data. Git ignore rules are not a packaging boundary.
 * RUNTIME_FILES below explicitly defines the installable extension, including
 * its licenses and attribution notices.
 *
 * WHY THE LIST IS EXPLICIT AND NOT DERIVED
 *
 * Three classes of runtime dependency are invisible to manifest.json, so a
 * mechanical walk of it produces a package that installs and is broken:
 *
 *   - popup.js is referenced by popup.html, not by the manifest; welcome.js
 *     by welcome.html, which the worker opens through chrome.runtime.getURL.
 *   - data/words-en.txt, data/confusables-en.txt and data/names-en.txt are fetched
 *     by the worker through chrome.runtime.getURL. A MISSING dictionary falls
 *     back rather than failing, disabling dictionary vetoes and checks in silence
 *     instead of breaking the install. Missing or invalid confusables/names instead
 *     remove generated grants, retaining hand supplements. Merely loading the
 *     extension cannot catch these omissions.
 *   - The license and notice files are redistribution obligations. Nothing references them
 *     at runtime by construction, so no dependency analysis can find them, and
 *     they are the files whose absence is a licence violation rather than a bug.
 *
 * So the list is written down, and test/package-test.mjs checks it three
 * independent ways rather than trusting any one of them.
 *
 * Usage:
 *   node tools/package.mjs [--out <dir>]     default: dist/proofer
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Everything the installed extension needs, and nothing else. Adding a runtime
// file means adding it here; the pin fails if a manifest or popup.html
// reference is missing from this list, so the two cannot drift silently.
export const RUNTIME_FILES = [
  "LICENSE",
  "NOTICE",
  "manifest.json",
  "background.js",
  "content.js",
  "popup.html",
  "popup.js",
  "maintainer.js",
  // The setup page: opened by the worker through getURL, and
  // welcome.js hangs off it the way popup.js hangs off popup.html.
  "welcome.html",
  "welcome.js",
  "styles.css",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  // Fetched at runtime by the worker. Not in the manifest.
  "data/words-en.txt",
  "data/confusables-en.txt",
  "data/names-en.txt",
  // Licence obligations. Referenced by nothing, required by both upstreams.
  "data/THIRD_PARTY_NOTICES.md",
  "data/COPYING.LGPL-2.1",
  "data/COPYRIGHT.SCOWL-2020.12.07",
];

// Nothing matching these may appear in the output, whatever RUNTIME_FILES says.
// A denylist as well as an allowlist because the two fail differently: the
// allowlist is what a careless ADDITION gets past, and this is what it does not.
// `harvested` and `*.jsonl` are the user's own recorded prose.
export const FORBIDDEN = [/(^|\/)node_modules(\/|$)/, /(^|\/)harvested(\/|$)/,
                          /(^|\/)tools\/gmail(\/|$)/,
                          /(^|\/)(oauth-client|gmail-token|token|credentials)\.json$/,
                          /(^|\/)\.env(\.|$)/,
                          /(^|\/)results(\/|$)/, /\.jsonl$/, /(^|\/)\.git(\/|$)/];

const SUMS = "SHA256SUMS.txt";

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

function sourceError(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function validPackagePath(rel) {
  // One path format for source lookup, the denylist, output and checksums.
  // Backslashes are separators on Windows but literal filename bytes on Unix.
  return typeof rel === "string" && !rel.includes("\\") && !path.isAbsolute(rel) &&
    rel.split("/").every((part) => part && part !== "." && part !== "..");
}

function safeSource(root, rel) {
  if (!validPackagePath(rel)) {
    sourceError("UNSAFE_SOURCE", "runtime source paths must be relative, use forward slashes and stay inside the package root");
  }
  const parts = rel.split("/");
  const absRoot = path.resolve(root);
  let source = absRoot;
  for (const part of [null, ...parts]) {
    if (part !== null) source = path.join(source, part);
    let stat;
    try { stat = fs.lstatSync(source); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") sourceError("MISSING", `missing runtime file(s): ${rel}`);
      throw error;
    }
    if (stat.isSymbolicLink()) sourceError("UNSAFE_SOURCE", `refusing a symlink in runtime source: ${rel}`);
  }
  const canonicalRoot = fs.realpathSync(absRoot);
  const canonicalSource = fs.realpathSync(source);
  const relative = path.relative(canonicalRoot, canonicalSource);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      !fs.lstatSync(source).isFile()) {
    sourceError("UNSAFE_SOURCE", `refusing a runtime source outside the root or not a regular file: ${rel}`);
  }
  return source;
}

function readSource(root, rel) {
  // Recheck immediately before opening, and never follow a final symlink when
  // the platform supports O_NOFOLLOW. Read the opened file, not the path again.
  const source = safeSource(root, rel);
  const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) sourceError("UNSAFE_SOURCE", `refusing a non-file runtime source: ${rel}`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function packageExtension({ root = ROOT, out, files = RUNTIME_FILES } = {}) {
  const dest = out || path.join(root, "dist", "proofer");

  // Missing input is fatal and NAMED. A packager that silently skips what it
  // cannot find emits a partial extension and reports success -- the
  // "completes green and produces nothing" shape, one level down at the
  // artifact.
  // A runtime name can be innocent while a symlink behind it points at a token.
  // Validate every source before touching the destination or reading any bytes.
  for (const rel of files) safeSource(root, rel);
  const banned = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
  if (banned.length) {
    const err = new Error(`refusing to package: ${banned.join(", ")}`);
    err.code = "FORBIDDEN";
    throw err;
  }

  // `--out` is a path from the command line and the next line is a recursive
  // delete, so this is checked before anything is removed. `--out .` passed
  // every check above -- the source files exist, none is denylisted -- and then
  // deleted the checkout and tried to read the files it had just removed.
  //
  // Three rules, each closing a different way in:
  //   1. The destination may not contain any source file. That covers the repo
  //      root, `data/`, and any ancestor, without enumerating them.
  //   2. It may not be an ancestor of the source root either, which is the same
  //      hazard one level out (`--out ..`).
  //   3. An existing NON-EMPTY directory is replaced only if it looks like a
  //      previous package output, i.e. it has a SHA256SUMS.txt. A directory
  //      somebody else's files are in is not ours to empty.
  const absDest = path.resolve(dest);
  const absRoot = path.resolve(root);
  const contains = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const captured = files.filter((f) => contains(absDest, path.resolve(root, f)));
  if (captured.length || contains(absDest, absRoot)) {
    const err = new Error(
      `refusing to empty ${absDest}: it contains the source tree (${captured[0] || absRoot})`);
    err.code = "UNSAFE_OUT";
    throw err;
  }
  if (fs.existsSync(absDest)) {
    const entries = fs.readdirSync(absDest);
    if (entries.length && !entries.includes(SUMS)) {
      const err = new Error(
        `refusing to empty ${absDest}: not empty and not a previous package (no ${SUMS})`);
      err.code = "UNSAFE_OUT";
      throw err;
    }
  }
  fs.rmSync(dest, { recursive: true, force: true });
  const lines = [];
  let bytes = 0;
  for (const rel of files) {
    const buf = readSource(root, rel);
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    lines.push(`${sha256(buf)}  ${rel}`);
    bytes += buf.length;
  }
  // Written last and excluded from itself, so "every payload file has an entry
  // and every entry is a payload file" is an exact equality the pin can assert
  // -- which is what catches a file omitted from BOTH the copy and the list.
  fs.writeFileSync(path.join(dest, SUMS), lines.join("\n") + "\n");
  return { dest, count: files.length, bytes, sums: SUMS };
}

/** Verify a packaged directory against its own SHA256SUMS.txt. */
export function verifyPackage(dest) {
  const sumsPath = path.join(dest, SUMS);
  if (!fs.existsSync(sumsPath)) return { ok: false, reason: "no-sums" };
  const listed = new Map();
  for (const line of fs.readFileSync(sumsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64})\s\s(.+)$/);
    if (!m) return { ok: false, reason: "bad-sums-line", detail: line };
    if (!validPackagePath(m[2])) return { ok: false, reason: "unsafe-payload-path", detail: m[2] };
    listed.set(m[2], m[1]);
  }
  // Walk what is ACTUALLY there rather than what the list claims: the failure
  // this catches is a payload file with no entry, which reading the list alone
  // cannot see.
  const present = [];
  const unsafe = [];
  (function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!validPackagePath(rel)) { unsafe.push(rel); continue; }
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (rel !== SUMS) present.push(rel);
    }
  })(dest, "");

  if (unsafe.length) return { ok: false, reason: "unsafe-payload-path", detail: unsafe };
  const unlisted = present.filter((f) => !listed.has(f));
  const absent = [...listed.keys()].filter((f) => !present.includes(f));
  if (unlisted.length) return { ok: false, reason: "unlisted-payload", detail: unlisted };
  if (absent.length) return { ok: false, reason: "listed-but-absent", detail: absent };
  for (const f of present) {
    if (sha256(fs.readFileSync(path.join(dest, f))) !== listed.get(f)) {
      return { ok: false, reason: "digest-mismatch", detail: f };
    }
  }
  const forbidden = present.filter((f) => FORBIDDEN.some((re) => re.test(f)));
  if (forbidden.length) return { ok: false, reason: "forbidden-path", detail: forbidden };
  return { ok: true, count: present.length };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const i = process.argv.indexOf("--out");
  const out = i > -1 ? path.resolve(process.argv[i + 1]) : undefined;
  try {
    const r = packageExtension({ out });
    const v = verifyPackage(r.dest);
    if (!v.ok) { console.error(`Package verification FAILED: ${v.reason}`, v.detail || ""); process.exit(1); }
    console.log(`Packaged ${r.count} files (${(r.bytes / 1024).toFixed(0)} KB) -> ${r.dest}`);
    console.log(`Digests in ${r.sums}; verified ${v.count} payload files.`);
    console.log(`Load unpacked -> select ${r.dest}`);
  } catch (e) {
    console.error(`Packaging failed: ${e.message}`);
    process.exit(1);
  }
}
