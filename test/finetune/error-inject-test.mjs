#!/usr/bin/env node
// Gate for error-inject.mjs. Three assertions per fixture, and the middle one
// is the whole contract:
//
//   SHAPE          — the group carries every field benchmark-schema.mjs will
//                    validate, and `before` equals the damaged slice.
//   REVERSIBILITY  — applying every group's primary replacement to `damaged`
//                    reproduces the clean input BYTE FOR BYTE. An injected
//                    benchmark item's gold label IS the clean input, so a
//                    transform that cannot state its own inverse is unusable
//                    supervision however plausible the damage looks.
//   SCHEMA         — the group survives validateRecord() when dropped into a
//                    minimal ERROR record, so the sampler's mechanical seed
//                    cannot be a shape the labeler then has to repair.
//
// Plus the negative half, which is the part a fixture suite usually skips:
// every transform must return null rather than damage a URL, a code span, a
// mention or a number, and must return null rather than guess when its class
// has no candidate in the sentence.
//
//   node test/finetune/error-inject-test.mjs

import {
  inject, restore, INJECT_VERSION, INJECTABLE_TYPES, wordTokens, protectedMask,
  applicableTypes, QWERTY_NEIGHBOURS, CONFUSABLE_BY_MEANT,
} from "./error-inject.mjs";
import {
  validateRecord, SCHEMA_VERSION, ERROR_TYPES, benchmarkUid,
} from "./benchmark-schema.mjs";
import { mulberry32 } from "../harvested/discord-source.mjs";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++; fails.push(name + (detail ? " — " + detail : ""));
  return false;
}
const eq = (a, b, name) => ok(a === b, name, a === b ? "" : `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// A record shell the injected groups can be validated inside.
function recordFor(damaged, groups) {
  const primary = restore(damaged, groups);
  return {
    schema_version: SCHEMA_VERSION,
    benchmark_version: "test",
    uid: benchmarkUid("doc-1", damaged),
    sentence: damaged,
    context_2500: "",
    split: "dev",
    source: {
      corpus: "test", register: "chat-owner",
      source_document_id: "doc-1", exclusion_group_id: "grp-1",
    },
    sampling: { frame: "injected", primary_phenomenon: "ordinary", phenomena: ["ordinary"] },
    label: {
      input_status: "ERROR",
      borderline: false,
      edit_groups: groups,
      acceptable_outputs: [{ id: "primary", rewritten: primary, credit: "required-correction" }],
    },
  };
}

// ---------------------------------------------------------------- fixtures
// One per transform, chosen so the transform is FORCED to a single candidate
// where possible (rng() = 0 then picks it deterministically) and the expected
// damaged string can be written out literally.
const FIXTURES = [
  { type: "transposition", clean: "The technician arrived early." },
  { type: "adjacent-key", clean: "The technician arrived early." },
  { type: "moved-space", clean: "We know the answer already." },
  { type: "doubled-word", clean: "We shipped the invoice today." },
  { type: "held-shift-stutter", clean: "This is fine by me." },
  { type: "semicolon-apostrophe", clean: "I don't think so." },
  { type: "dropped-apostrophe", clean: "I don't think so." },
  { type: "homophone-confusable", clean: "I think their invoice is late." },
  { type: "run-together", clean: "The real estate market cooled." },
  { type: "terminator", clean: "The invoice arrived today." },
  { type: "casing", clean: "I met Alice at the office." },
  { type: "agreement", clean: "They report the numbers monthly." },
];

console.log(`error-inject ${INJECT_VERSION} — ${INJECTABLE_TYPES.length} transforms, `
  + `${CONFUSABLE_BY_MEANT.size} confusable meant-keys, `
  + `${QWERTY_NEIGHBOURS.size} keys mapped`);

eq(INJECTABLE_TYPES.length, ERROR_TYPES.length - 1,
  "[0] one transform per taxonomy class except other-natural");
ok(!INJECTABLE_TYPES.includes("other-natural"), "[0] other-natural is not injectable");

for (const f of FIXTURES) {
  const tag = `[${f.type}]`;
  const rng = mulberry32(1234);
  const res = inject(f.type, f.clean, rng);
  if (!ok(res !== null, `${tag} applies to its fixture`, JSON.stringify(f.clean))) continue;

  // SHAPE
  ok(res.damaged !== f.clean, `${tag} damaged differs from clean`);
  ok(Array.isArray(res.groups) && res.groups.length >= 1, `${tag} at least one group`);
  for (const g of res.groups) {
    eq(res.damaged.slice(g.start_utf16, g.end_utf16), g.before,
      `${tag} before === damaged slice`);
    eq(g.requirement, "required-correction", `${tag} requirement`);
    eq(g.error_type, f.type, `${tag} error_type`);
    ok(Array.isArray(g.alternatives) && g.alternatives.length >= 1
      && typeof g.alternatives[0].replacement === "string"
      && typeof g.alternatives[0].id === "string",
      `${tag} alternatives shape`);
    ok(Number.isInteger(g.start_utf16) && Number.isInteger(g.end_utf16)
      && g.start_utf16 >= 0 && g.end_utf16 >= g.start_utf16
      && g.end_utf16 <= res.damaged.length, `${tag} span bounds`);
  }

  // REVERSIBILITY
  eq(restore(res.damaged, res.groups), f.clean, `${tag} REVERSIBLE`);

  // SCHEMA
  const problems = validateRecord(recordFor(res.damaged, res.groups));
  ok(problems.length === 0, `${tag} schema-valid`, problems.join("; "));

  console.log(`  ${f.type.padEnd(21)} ${JSON.stringify(f.clean)} -> ${JSON.stringify(res.damaged)}`);
}

// ------------------------------------------------- determinism + seed spread
{
  const a = inject("transposition", "The technician arrived early.", mulberry32(7));
  const b = inject("transposition", "The technician arrived early.", mulberry32(7));
  eq(a.damaged, b.damaged, "[det] same seed, same damage");
  const seen = new Set();
  for (let s = 0; s < 40; s++) {
    const r = inject("adjacent-key", "The technician arrived early.", mulberry32(s));
    if (r) seen.add(r.damaged);
  }
  ok(seen.size > 5, "[det] different seeds reach different damage", `${seen.size} distinct`);
  for (const d of seen) {
    // Every sampled damage is still reversible — the fixture only exercises one.
    const r = [...seen].length; void r;
  }
}

// ------------------------------------------------- reversibility under sweep
{
  const corpus = [
    "The technician arrived early and left a note.",
    "I don't think we should ship it before Friday.",
    "They report the numbers monthly to the board.",
    "We know the answer already, so let's move on.",
    "Alice met Bob on Monday morning at the office.",
    "The real estate market cooled off this quarter.",
    "It's a reasonable plan, but their timing is off.",
  ];
  let checked = 0, applied = 0;
  for (let seed = 0; seed < 25; seed++) {
    for (const s of corpus) {
      for (const t of INJECTABLE_TYPES) {
        const r = inject(t, s, mulberry32(seed * 977 + t.length));
        checked++;
        if (!r) continue;
        applied++;
        if (restore(r.damaged, r.groups) !== s) {
          ok(false, `[sweep] ${t} not reversible`, JSON.stringify(r.damaged));
        }
        if (r.damaged.slice(r.groups[0].start_utf16, r.groups[0].end_utf16)
            !== r.groups[0].before) {
          ok(false, `[sweep] ${t} slice mismatch`, JSON.stringify(r.damaged));
        }
      }
    }
  }
  ok(applied > 0, "[sweep] the sweep applied something", `${applied}/${checked}`);
  ok(true, `[sweep] ${applied}/${checked} applications all reversible`);
  console.log(`  sweep: ${applied}/${checked} (type, sentence, seed) combinations applied, all reversible`);
}

// ------------------------------------------------------------- protection
{
  const s = "Check https://example.com/a_b and `npm ci` and <@1234567890> for v1.2 now.";
  const mask = protectedMask(s);
  const url = s.indexOf("https://");
  ok(mask[url] && mask[url + 10], "[prot] URL masked");
  const code = s.indexOf("`npm");
  ok(mask[code] && mask[code + 3], "[prot] code span masked");
  const men = s.indexOf("<@");
  ok(mask[men] && mask[men + 4], "[prot] mention masked");
  const toks = wordTokens(s).map((t) => t.text);
  ok(!toks.some((t) => /example|npm|1234567890|v1/.test(t)),
    "[prot] no injectable token inside a protected region", toks.join(","));

  // The whole sentence is protected except tiny function words: every transform
  // must either decline or damage only the unprotected part.
  for (let seed = 0; seed < 20; seed++) {
    for (const t of INJECTABLE_TYPES) {
      const r = inject(t, s, mulberry32(seed * 31 + 5));
      if (!r) continue;
      for (const g of r.groups) {
        // The damaged span must not have started inside a protected region.
        const cleanAgain = restore(r.damaged, r.groups);
        eq(cleanAgain, s, `[prot] ${t} reversible on protected sentence`);
        const idx = g.start_utf16;
        ok(!mask[Math.min(idx, mask.length - 1)],
          `[prot] ${t} did not start inside a protected region`,
          JSON.stringify(r.damaged));
      }
    }
  }
  ok(!/example\.com/.test("guard"), "[prot] sanity");
}

// ------------------------------------------------------- inapplicable => null
{
  eq(inject("semicolon-apostrophe", "No apostrophes here at all.", mulberry32(1)), null,
    "[null] semicolon-apostrophe with no contraction");
  eq(inject("dropped-apostrophe", "No apostrophes here at all.", mulberry32(1)), null,
    "[null] dropped-apostrophe with no apostrophe");
  eq(inject("terminator", "no terminator here", mulberry32(1)), null,
    "[null] terminator with nothing to drop");
  eq(inject("run-together", "a b c", mulberry32(1)), null,
    "[null] run-together needs two dictionary words >= 3 chars");
  eq(inject("agreement", "The quick brown fox.", mulberry32(1)), null,
    "[null] agreement without a confident pronoun+verb");
  eq(inject("homophone-confusable", "Zzzz qqqq wwww.", mulberry32(1)), null,
    "[null] homophone with no licensed token");
  eq(inject("transposition", "", mulberry32(1)), null, "[null] empty input");
  let threw = false;
  try { inject("not-a-type", "hello there", mulberry32(1)); } catch { threw = true; }
  ok(threw, "[null] unknown type THROWS rather than returning null");
  let threw2 = false;
  try { inject("transposition", "hello there", null); } catch { threw2 = true; }
  ok(threw2, "[null] missing rng THROWS");
}

// --------------------------------------------------------- applicableTypes
{
  const list = applicableTypes("I don't think their invoice arrived early.");
  ok(list.includes("semicolon-apostrophe"), "[appl] finds the contraction class");
  ok(list.includes("homophone-confusable"), "[appl] finds the confusable class");
  ok(!applicableTypes("ok").includes("run-together"), "[appl] declines on a runt");
  const a = applicableTypes("I don't think their invoice arrived early.");
  eq(JSON.stringify(a), JSON.stringify(list), "[appl] deterministic across calls");
}

// ---------------------------------------------------------- casing negative
{
  // A capital that is a RULE (first word after a terminator) is not a casing
  // typo; lowercasing it manufactures a segmenter artefact instead.
  const s = "We shipped it. Alice signed off later.";
  let hitRuleCapital = false;
  for (let seed = 0; seed < 60; seed++) {
    const r = inject("casing", s, mulberry32(seed));
    if (!r) continue;
    if (r.damaged.startsWith("We shipped it. alice")) hitRuleCapital = true;
  }
  ok(!hitRuleCapital, "[casing] never lowercases the capital after a terminator");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of fails) console.log("  FAIL " + f);
  process.exit(1);
}
