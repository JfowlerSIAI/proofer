#!/usr/bin/env node
// Fixtures pinning edit-group extraction. No Ollama, no browser, no network.
//
//   node judge-edit-groups-test.mjs
//
// Every sentence here is SYNTHETIC — authored for this file. Owner text never
// enters a committed fixture (the same rule test/harvested/ is gitignored for).
//
// Two assertions per case, and the second is the one that matters:
//   1. the groups are exactly the expected (before -> after) pairs, in order;
//   2. applying ALL groups reproduces the corrected sentence BYTE FOR BYTE,
//      and reverting any single group leaves the other edits intact.
// A decomposition that reads well and does not round-trip is a decomposition
// that silently corrupts a training target the moment one group is reverted.

import { editGroups, applyGroups, tokenize, markSource } from "./edit-groups.mjs";

let passed = 0;
const failures = [];

function show(gs) {
  return gs.map((g) => `[${g.id}] ${JSON.stringify(g.before)}->${JSON.stringify(g.after)}`).join(" ");
}

function check(name, src, out, expect) {
  const gs = editGroups(src, out);
  const got = gs.map((g) => [g.before, g.after]);
  const ok = got.length === expect.length
    && got.every((p, i) => p[0] === expect[i][0] && p[1] === expect[i][1]);

  if (!ok) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`          got      ${show(gs) || "(no groups)"}`);
    console.log(`          expected ${expect.map(([b, a], i) => `[${i + 1}] ${JSON.stringify(b)}->${JSON.stringify(a)}`).join(" ") || "(no groups)"}`);
    console.log(`          marked   ${JSON.stringify(markSource(src, gs))}`);
    return;
  }

  // Invariant A: the span really is the source text it claims to be.
  for (const g of gs) {
    const slice = src.slice(g.srcSpan[0], g.srcSpan[1]);
    if (slice !== g.before) {
      failures.push(name + " (srcSpan)");
      console.log(`  FAIL  ${name} — srcSpan [${g.srcSpan}] is ${JSON.stringify(slice)}, before is ${JSON.stringify(g.before)}`);
      return;
    }
  }

  // Invariant B: keep everything -> the corrected sentence, exactly.
  const all = applyGroups(src, gs, null);
  if (all !== out) {
    failures.push(name + " (round trip)");
    console.log(`  FAIL  ${name} — apply-all gave ${JSON.stringify(all)}, expected ${JSON.stringify(out)}`);
    return;
  }

  // Invariant C: keep nothing -> the source, exactly.
  const none = applyGroups(src, gs, []);
  if (none !== src) {
    failures.push(name + " (revert all)");
    console.log(`  FAIL  ${name} — revert-all gave ${JSON.stringify(none)}, expected ${JSON.stringify(src)}`);
    return;
  }

  passed++;
  console.log(`  PASS  ${name}   ${show(gs) || "(no groups)"}`);
}

console.log("\nEdit-group extraction\n" + "=".repeat(72));

console.log("\nSingle-token corrections:");
check("transposition", "The teh cat sat.", "The the cat sat.", [["teh", "the"]]);
check("misspelling", "The techncian arrived early.", "The technician arrived early.",
      [["techncian", "technician"]]);
check("case only", "The report was due monday.", "The report was due Monday.",
      [["monday", "Monday"]]);
check("sentence capitalization", "the report was due.", "The report was due.",
      [["the", "The"]]);
check("agreement", "The clients was upset.", "The clients were upset.", [["was", "were"]]);
check("confusable", "I could not tell wether it mattered.", "I could not tell whether it mattered.",
      [["wether", "whether"]]);

console.log("\nMoved spaces, both directions:");
check("space deleted", "Please filtererrors before sending.", "Please filter errors before sending.",
      [["filtererrors", "filter errors"]]);
check("space shifted left", "Howdo you want it done?", "How do you want it done?",
      [["Howdo", "How do"]]);
check("space shifted right", "I think wek nwo the answer.", "I think we know the answer.",
      [["wek nwo", "we know"]]);
check("run-together compound", "The meeting is inperson tomorrow.", "The meeting is in person tomorrow.",
      [["inperson", "in person"]]);

console.log("\nWhitespace and punctuation:");
check("doubled space collapsed", "The report  was late.", "The report was late.", [[" ", ""]]);
check("comma inserted", "When the build finished we shipped it.",
      "When the build finished, we shipped it.", [["", ","]]);
check("terminator added", "The build finished at noon", "The build finished at noon.",
      [["", "."]]);
check("terminator run trimmed", "Was it ready?).", "Was it ready?)", [[".", ""]]);
check("punctuation only, two groups", "Hello world", "Hello, world.",
      [["", ","], ["", "."]]);

console.log("\nContractions, hyphens, doubled words:");
check("contraction expanded", "Its a long way from finished.", "It is a long way from finished.",
      [["Its", "It is"]]);
check("apostrophe restored", "I dont think that is right.", "I don't think that is right.",
      [["dont", "don't"]]);
check("compound hyphenated", "We agreed on a 36 day window.", "We agreed on a 36-day window.",
      [["36 day", "36-day"]]);
check("hyphen split apart", "The covid-19 numbers were wrong.", "The covid 19 numbers were wrong.",
      [["covid-19", "covid 19"]]);
// The SECOND "the" is the one that goes: the capitalized "The" matches its
// counterpart byte for byte and anchors, so the lowercase duplicate is what
// falls in the region. Case-sensitive anchoring is what makes that come out
// right — a case-folding aligner would be free to blame either one.
check("doubled word removed", "The the invoice arrived late.", "The invoice arrived late.",
      [["the ", ""]]);
check("held-shift stutter", "THis is fine by me.", "This is fine by me.", [["THis", "This"]]);

console.log("\nMulti-error and degenerate shapes:");
check("two adjacent errors merge into one group", "The teh techncian arrived.",
      "The the technician arrived.", [["teh techncian", "the technician"]]);
check("two separated errors are two groups", "The techncian arrived erly.",
      "The technician arrived early.", [["techncian", "technician"], ["erly", "early"]]);
// The added terminator has no anchor after it, so it shares the trailing
// region with `erly`. That is the merge rule doing its job, not a miss.
check("trailing terminator joins the last region", "the techncian arrived erly",
      "The technician arrived early.",
      [["the techncian", "The technician"], ["erly", "early."]]);
check("identity is zero groups", "The report was filed on time.", "The report was filed on time.", []);
// A shared token anchors even inside a wholesale rewrite. Two groups, not one:
// the decomposition is driven by what survived, not by how big the edit feels.
check("rewrite splits at a surviving token", "ok will do", "Understood, I will proceed.",
      [["ok", "Understood, I"], ["do", "proceed."]]);
check("rewrite with nothing surviving is one group", "ok sounds fine", "Understood, agreed.",
      [["ok sounds fine", "Understood, agreed."]]);
check("meaning damage looks like any other group", "We shipped 1200 units in March.",
      "We shipped 1300 units in March.", [["1200", "1300"]]);

console.log("\nTokenizer shapes that must not fragment:");
{
  const ids = tokenize("Call __init__ then snake_case, not it's 36-day v1.2.");
  const want = ["__init__", "snake_case", "it's", "36-day"];
  const have = ids.map((t) => t.text);
  const missing = want.filter((w) => !have.includes(w));
  if (missing.length) {
    failures.push("tokenizer whole-token shapes");
    console.log(`  FAIL  tokenizer whole-token shapes — missing ${JSON.stringify(missing)} in ${JSON.stringify(have)}`);
  } else { passed++; console.log(`  PASS  tokenizer whole-token shapes`); }
}

console.log("\nPartial revert leaves the other edits intact:");
{
  const src = "the techncian arrived erly";
  const out = "The technician arrived early.";
  const gs = editGroups(src, out);
  const keepFirstOnly = applyGroups(src, gs, [1]);
  const want = "The technician arrived erly";
  if (keepFirstOnly !== want) {
    failures.push("partial revert");
    console.log(`  FAIL  partial revert — got ${JSON.stringify(keepFirstOnly)}, expected ${JSON.stringify(want)}`);
  } else { passed++; console.log(`  PASS  partial revert   ${JSON.stringify(keepFirstOnly)}`); }
}
console.log("\nAdjacent changes merge, and the judge contract depends on knowing it:");
// §3 merges adjacent changed tokens into ONE group, so a good fix touching the
// token next to a bad one produces a single group with a single verdict. This
// is pinned rather than fixed: the group is judged as a whole and the standing
// asymmetry settles it — any damage inside the group makes the group damage, so
// the typo fix riding along is lost with it. A missed fix is cheap. The judge
// prompt states this rule explicitly because the decomposition enforces it.
check("a fix adjacent to damage is ONE group", "we shipped 1200 unts in March.",
      "We shipped 1300 units in March.",
      [["we", "We"], ["1200 unts", "1300 units"]]);
{
  // A reverted meaning-damage group inside an otherwise good correction, with
  // the damage NOT adjacent to any other edit, so it is separately revertible.
  const src = "we shipped 1200 units in march";
  const out = "We shipped 1300 units in March.";
  const gs = editGroups(src, out);
  const damage = gs.find((g) => g.before === "1200");
  if (!damage) {
    failures.push("selective revert (no 1200 group)");
    console.log(`  FAIL  selective revert — no group for "1200": ${show(gs)}`);
  } else {
    const kept = gs.filter((g) => g.id !== damage.id).map((g) => g.id);
    const got = applyGroups(src, gs, kept);
    const want = "We shipped 1200 units in March.";
    if (got !== want) {
      failures.push("selective revert");
      console.log(`  FAIL  selective revert — got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    } else { passed++; console.log(`  PASS  selective revert   ${JSON.stringify(got)}`); }
  }
}

console.log("\n" + "=".repeat(72));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failures: " + failures.join(", "));
  process.exit(1);
}
