#!/usr/bin/env node
// Output sanitizer tests. No Ollama, no browser — pure functions pulled out of
// background.js itself, so this tests what ships rather than a copy.
//
//   node sanitizer-test.mjs
//
// The sanitizer runs on the MODEL's output, and the model echoes most of the
// user's text back verbatim. The sentence path never applies it: it asks
// whether the sanitizer WOULD change the answer and refuses the correction as
// `sanitizer-would-change` if so. So a step that strips too eagerly turns into
// a refusal of every sentence carrying the user's own markers -- and on the
// manual path (removed 2026-09-24) it was a silent edit to words they typed.
//
// stripPromptTags and isSubstantivelyEqual had only manual callers and went
// with that path; the sentence handler's own tag question is pinned through the
// real handler in sentence-settings-test.mjs.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "background.js"), "utf8");

const noop = () => {};
const ctx = vm.createContext({
  chrome: {
    runtime: { onMessage: { addListener: noop }, onInstalled: { addListener: noop } },
    storage: { local: { get: (k, cb) => cb({}), set: noop, remove: noop } },
    tabs: { create: noop },
  },
  console, fetch, setTimeout, clearTimeout, AbortController, URL,
});
vm.runInContext(src + "\n;globalThis.__api = { stripMarkdown, asciify, normalizeWhitespace };", ctx);
const { stripMarkdown, asciify, normalizeWhitespace } = ctx.__api;

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (actual === expected) { passed++; console.log(`  PASS  ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}\n          got      ${JSON.stringify(actual)}\n          expected ${JSON.stringify(expected)}`);
}

console.log("\nSanitizer tests\n" + "=".repeat(72));

console.log("\nstripMarkdown leaves the user's own markers alone:");
// Each case: the model echoed the user's text back unchanged, so the sanitized
// result must equal the input exactly.
for (const text of [
  "The __init__ method is broken.",
  "Pass **kwargs and *args to the function.",
  "Use `npm run build` before deploying.",
  "The file is named my__test__file.py",
  "We need 2*3*4 = 24 widgets.",
  "Prices are marked with * and ** footnotes.",
  "The __repr__ output was wrong.",
]) {
  check(JSON.stringify(text).slice(0, 52), stripMarkdown(text, text), text);
}

console.log("\nstripMarkdown still removes markdown the MODEL added:");
check("bold added by model", stripMarkdown("The **report** was late.", "The report was late."), "The report was late.");
check("italic added by model", stripMarkdown("The *report* was late.", "The report was late."), "The report was late.");
check("bold-italic added by model", stripMarkdown("The ***report*** was late.", "The report was late."), "The report was late.");
check("underscores added by model", stripMarkdown("The __report__ was late.", "The report was late."), "The report was late.");
check("backticks added by model", stripMarkdown("Run the `build` step.", "Run the build step."), "Run the build step.");

// The prompt wraps text in <context>/<excerpt> and asks for <rewritten>, so
// the model sometimes emits one and it has to come off. But the model also
// echoes the user's text back, and this strip ran unconditionally: a user who
// typed `<context>` had it deleted and -- with auto-apply on -- written back
// as a "correction" nobody made. Same defect stripMarkdown was fixed for.
console.log("\nasciify normalises typography:");
check("smart quotes", asciify("“hello” and ‘hi’"), '"hello" and \'hi\'');
check("em dash", asciify("wait—stop"), "wait--stop");
check("ellipsis", asciify("well…"), "well...");
check("non-breaking space", asciify("a b"), "a b");

console.log("\noriginal typography survives each family:");
// Each named fixture's mutant removes its family's !/.../.test(original)
// condition in asciify. Its preservation and family-wide assertions turn red;
// the absent-family and cross-family replacements remain the controls.
for (const [name, points, replacement] of [
  ["original typography: dash family", [0x2012, 0x2013, 0x2014, 0x2015, 0x2212], "--"],
  ["hyphen family", [0x2011, 0xFE58, 0xFE63, 0xFF0D], "-"],
  ["apostrophe family", [0x2018, 0x2019, 0x2032, 0x00B4], "'"],
  ["double-quote family", [0x201C, 0x201D, 0x2033, 0x00AB, 0x00BB], '"'],
  ["ellipsis family", [0x2026], "..."],
  ["space family", [0x00A0, 0x2007, 0x202F], " "],
]) {
  for (const point of points) {
    const char = String.fromCodePoint(point);
    const text = `a${char}b`;
    const label = `${name} U+${point.toString(16).toUpperCase()}`;
    check(`${label} preserved`, asciify(text, text), text);
    check(`${label} without original`, asciify(text), `a${replacement}b`);
    check(`${label} family-wide preservation`, asciify(text, `x${String.fromCodePoint(points[0])}y`), text);
    check(`${label} other family does not license it`, asciify(text, point === 0x2026 ? "x’y" : "x…y"), `a${replacement}b`);
  }
}

console.log("\nnormalizeWhitespace matches the original's edges:");
check("strips added leading space", normalizeWhitespace(" fixed", "broken"), "fixed");
check("restores original leading space", normalizeWhitespace("fixed", "  broken"), "  fixed");
check("restores original trailing newline", normalizeWhitespace("fixed", "broken\n"), "fixed\n");
check("drops added trailing space", normalizeWhitespace("fixed   ", "broken"), "fixed");

console.log("\n" + "=".repeat(72));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
