#!/usr/bin/env node
// Gate for label-benchmark.mjs's non-TTY core: scripted decisions over
// synthetic candidates, driven through the exact path the interactive session
// uses (diff -> groups -> acceptable outputs -> validateRecord/validateFile).
//
// The TTY loop itself is not driven here — a pty is a dependency and this repo
// has none. What IS driven is everything the loop delegates to: `decodeKey`
// (every key the editor reacts to, as raw byte chunks), `renderFrame` (a pure
// string), the fold of the append-only log, and assembly. `--selftest-render`
// covers "does it launch and draw"; a human covers "does it feel fast", which
// is what the pilot gate measures rather than asserts.
//
// Cases, chosen for what they can each falsify:
//   [1] CLEAN            — a CLEAN record MUST list its input as a no-op.
//   [2] single error     — one group, type from the screen suggestion.
//   [3] MULTI-error      — two groups, independently typed; the round trip and
//                          the per-group revert both have to hold.
//   [4] injected prefill — the editor opens on the KNOWN ORIGINAL, and
//                          committing it unchanged reproduces the injection.
//   [5] benign-optional  — a CLEAN record carrying a rewrite; the schema forbids
//                          a required-correction group here, so a build that
//                          mislabels the requirement fails rather than passes.
//   [6] alternative      — a second acceptable output for one group.
//   [7] skip             — quarantined, not assembled, and NAMED.
//   [8] fold/undo        — append-only semantics.
//   [9] refusals         — an invalid decision must be REPORTED, not written.
//
//   node test/finetune/label-benchmark-test.mjs

import {
  foldDecisions, groupsFromCorrection, materialize, acceptableOutputs,
  assembleRecord, assembleAll, suggestErrorType, prefillFor, timingStats, creditFor,
  renderFrame, decodeKey, PILOT_GATE, LABELER_VERSION, DEFAULT_BENCHMARK_VERSION,
} from "./label-benchmark.mjs";
import {
  validateRecord, validateFile, SCHEMA_VERSION, normalizeOut, benchmarkUid,
  CREDITS, VERDICTS,
} from "./benchmark-schema.mjs";
import { inject } from "./error-inject.mjs";
import { mulberry32 } from "../harvested/discord-source.mjs";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; return true; }
  fail++; fails.push(name + (detail ? " — " + detail : ""));
  return false;
}
const eq = (a, b, name) =>
  ok(a === b, name, a === b ? "" : `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const deepEq = (a, b, name) => eq(JSON.stringify(a), JSON.stringify(b), name);

// ------------------------------------------------------------- fixtures

let seq = 0;
function candidate(sentence, extra = {}) {
  const docId = "doc" + (++seq);
  return {
    candidate_id: "chat-owner:c" + seq,
    uid: benchmarkUid(docId, sentence),
    sentence,
    context_2500: extra.context ?? "earlier line\nanother earlier line",
    split: extra.split ?? "dev",
    source: {
      corpus: "owner-discord", register: "chat-owner",
      source_document_id: docId,
      exclusion_group_id: extra.group ?? "grp" + seq,
      segment_start: 0, segment_end: sentence.length,
    },
    sampling: {
      frame: extra.frame ?? "natural-screen",
      primary_phenomenon: "ordinary",
      phenomena: ["ordinary"],
      screen_reasons: extra.screens ?? ["uniqueDamerau1"],
    },
    inject: extra.inject ?? null,
  };
}

const decide = (c, action, extra = {}) => ({
  candidate_id: c.candidate_id, uid: c.uid, action,
  borderline: !!extra.borderline, ms: extra.ms ?? 9000,
  at: "2026-08-20T12:00:00.000Z", labeler_version: LABELER_VERSION,
  ...extra,
});

const OPTS = { benchmark_version: DEFAULT_BENCHMARK_VERSION };

// ============================================================ [1] CLEAN
{
  const c = candidate("We shipped it on Friday.", { screens: [] });
  const r = assembleRecord(c, decide(c, "CLEAN"), OPTS);
  ok(!r.error, "[1] CLEAN assembles", r.error);
  eq(r.record.label.input_status, "CLEAN", "[1] input_status");
  deepEq(r.record.label.edit_groups, [], "[1] no edit groups");
  const noop = r.record.label.acceptable_outputs.find(
    (a) => normalizeOut(a.rewritten) === normalizeOut(c.sentence));
  ok(!!noop, "[1] the input itself is an acceptable no-op");
  eq(noop.credit, "no-op", "[1] the no-op carries credit \"no-op\", not a verdict class");
  deepEq(validateRecord(r.record), [], "[1] schema-valid");
}

// ==================================================== [2] single error
{
  const c = candidate("The techncian arrived early.");
  eq(suggestErrorType(c), "transposition", "[2] type suggested from the screen tag");
  const d = decide(c, "ERROR", { corrected: "The technician arrived early." });
  const r = assembleRecord(c, d, OPTS);
  ok(!r.error, "[2] ERROR assembles", r.error);
  eq(r.record.label.input_status, "ERROR", "[2] input_status");
  eq(r.record.label.edit_groups.length, 1, "[2] one group");
  const g = r.record.label.edit_groups[0];
  eq(g.before, "techncian", "[2] group before");
  eq(g.alternatives[0].replacement, "technician", "[2] group replacement");
  eq(g.requirement, "required-correction", "[2] requirement");
  eq(g.error_type, "transposition", "[2] error_type defaulted from the suggestion");
  eq(c.sentence.slice(g.start_utf16, g.end_utf16), g.before, "[2] span slices to before");
  eq(materialize(c.sentence, r.record.label.edit_groups), d.corrected,
    "[2] ROUND TRIP: applying every group reproduces the correction");
  eq(r.record.label.acceptable_outputs[0].credit, "required-correction",
    "[2] the primary output of an ERROR item is credited required-correction");
  ok(r.record.label.acceptable_outputs.every((a) => a.credit !== "no-op"),
    "[2] an ERROR record offers no no-op");
  deepEq(validateRecord(r.record), [], "[2] schema-valid");
}

// ==================================================== [2b] type override
{
  const c = candidate("I think its late.", { screens: ["licensedConfusableSuspect"] });
  const d = decide(c, "ERROR", {
    corrected: "I think it's late.",
    group_types: { g1: "dropped-apostrophe" },
  });
  const r = assembleRecord(c, d, OPTS);
  ok(!r.error, "[2b] assembles", r.error);
  eq(r.record.label.edit_groups[0].error_type, "dropped-apostrophe",
    "[2b] number-key override beats the suggestion");
}

// ======================================================= [3] MULTI-error
{
  const c = candidate("The techncian arrived early and left a not.");
  const d = decide(c, "ERROR", {
    corrected: "The technician arrived early and left a note.",
    group_types: { g1: "transposition", g2: "adjacent-key" },
  });
  const r = assembleRecord(c, d, OPTS);
  ok(!r.error, "[3] multi-error assembles", r.error);
  eq(r.record.label.edit_groups.length, 2, "[3] two groups");
  const [g1, g2] = r.record.label.edit_groups;
  eq(g1.error_type, "transposition", "[3] group 1 typed independently");
  eq(g2.error_type, "adjacent-key", "[3] group 2 typed independently");
  ok(g1.end_utf16 <= g2.start_utf16, "[3] groups are disjoint and in source order");
  eq(materialize(c.sentence, r.record.label.edit_groups), d.corrected, "[3] ROUND TRIP");
  eq(materialize(c.sentence, r.record.label.edit_groups, { g2: null }),
    "The technician arrived early and left a not.",
    "[3] reverting ONE group leaves the other applied");
  eq(materialize(c.sentence, r.record.label.edit_groups, { g1: null, g2: null }),
    c.sentence, "[3] reverting every group is the input");
  deepEq(validateRecord(r.record), [], "[3] schema-valid");
}

// ==================================================== [4] injected prefill
{
  const clean = "The technician arrived early and left a note.";
  const res = inject("transposition", clean, mulberry32(11));
  ok(res !== null, "[4] the fixture injection applied");
  const c = candidate(res.damaged, {
    frame: "injected", screens: [],
    inject: { error_type: "transposition", original: clean,
      groups: res.groups, inject_version: "v1" },
  });
  eq(prefillFor(c), clean, "[4] the editor opens on the KNOWN ORIGINAL");
  eq(suggestErrorType(c), "transposition", "[4] type suggested from the injection");
  // The owner presses Enter without editing: the prefill IS the correction.
  const d = decide(c, "ERROR", { corrected: prefillFor(c) });
  const r = assembleRecord(c, d, OPTS);
  ok(!r.error, "[4] assembles", r.error);
  eq(materialize(c.sentence, r.record.label.edit_groups), clean,
    "[4] committing the prefill reproduces the clean original");
  eq(r.record.label.edit_groups[0].error_type, "transposition",
    "[4] error_type comes from the injection, not from a screen");
  eq(r.record.provenance?.mechanism, "injected", "[4] provenance recorded");
  eq(r.record.provenance?.inject_version, "v1", "[4] inject version recorded");
  deepEq(validateRecord(r.record), [], "[4] schema-valid");
}

// =================================================== [5] benign-optional
{
  const c = candidate("ok will do", { screens: [] });
  const d = decide(c, "OPTIONAL", { corrected: "Ok, will do." });
  const r = assembleRecord(c, d, OPTS);
  ok(!r.error, "[5] OPTIONAL assembles", r.error);
  eq(r.record.label.input_status, "CLEAN",
    "[5] a benign-optional item is CLEAN — the edit is not required");
  ok(r.record.label.edit_groups.length >= 1, "[5] carries its groups");
  ok(r.record.label.edit_groups.every((g) => g.requirement === "benign-optional"),
    "[5] every group is benign-optional");
  ok(r.record.label.edit_groups.every((g) => !("error_type" in g)),
    "[5] a benign-optional group carries no error_type");
  const acc5 = r.record.label.acceptable_outputs;
  const byText = (t) => acc5.find((a) => normalizeOut(a.rewritten) === normalizeOut(t));
  ok(!!byText(c.sentence), "[5] the no-op is acceptable");
  eq(byText(c.sentence).credit, "no-op", "[5] the no-op is credited no-op");
  ok(!!byText(d.corrected), "[5] the benign rewrite is acceptable");
  eq(byText(d.corrected).credit, "benign-optional",
    "[5] the benign rewrite is credited benign-optional, not required-correction");
  deepEq(validateRecord(r.record), [], "[5] schema-valid");
}

// ============================================ [5b] optional group inside ERROR
{
  const c = candidate("i dont think thats right");
  const d = decide(c, "ERROR", {
    corrected: "I don't think that's right.",
    group_types: { g1: "casing", g2: "dropped-apostrophe", g3: "dropped-apostrophe" },
    optional_groups: ["g1"],
  });
  const r = assembleRecord(c, d, OPTS);
  ok(!r.error, "[5b] assembles", r.error);
  const g1 = r.record.label.edit_groups.find((g) => g.id === "g1");
  eq(g1.requirement, "benign-optional", "[5b] the marked group became optional");
  ok(r.record.label.edit_groups.some((g) => g.requirement === "required-correction"),
    "[5b] the rest stayed required");
  const acc5b = r.record.label.acceptable_outputs;
  const reqOnly = acc5b.find((a) => a.id === "required-only");
  ok(!!reqOnly, "[5b] the required-only output is acceptable too",
    acc5b.map((a) => a.id).join(","));
  eq(reqOnly.credit, "required-correction",
    "[5b] required-only still applies a required group, so it keeps that credit");
  eq(acc5b.find((a) => a.id === "primary").credit, "required-correction",
    "[5b] the primary carries the required credit even with an optional group in it");
  deepEq(validateRecord(r.record), [], "[5b] schema-valid");
}

// ======================================================== [6] alternative
{
  const c = candidate("I think its late.", { screens: ["licensedConfusableSuspect"] });
  const d = decide(c, "ERROR", {
    corrected: "I think it's late.",
    group_types: { g1: "dropped-apostrophe" },
    alternatives: { g1: ["it is"] },
  });
  const r = assembleRecord(c, d, OPTS);
  ok(!r.error, "[6] assembles", r.error);
  const g = r.record.label.edit_groups[0];
  eq(g.alternatives.length, 2, "[6] two alternatives on the group");
  eq(g.alternatives[1].replacement, "it is", "[6] the added alternative");
  const outs = r.record.label.acceptable_outputs.map((a) => normalizeOut(a.rewritten));
  ok(outs.includes(normalizeOut("I think it's late.")), "[6] primary output present");
  ok(outs.includes(normalizeOut("I think it is late.")),
    "[6] the ALTERNATIVE is materialized as its own acceptable output", outs.join(" | "));
  ok(r.record.label.acceptable_outputs.every((a) => a.credit === "required-correction"),
    "[6] every output of this ERROR item is credited required-correction");
  deepEq(validateRecord(r.record), [], "[6] schema-valid");
}

// ============================================================== [7] skip
{
  const c = candidate("¯\\_(ツ)_/¯", { screens: [] });
  const r = assembleRecord(c, decide(c, "SKIP", { skip_reason: "not prose" }), OPTS);
  ok(!!r.skipped, "[7] SKIP is quarantined, not assembled");
  eq(r.skipped.reason, "not prose", "[7] the reason is NAMED");
  ok(!r.record, "[7] no record produced");
}

// ========================================================= [8] fold / undo
{
  const log = [
    { candidate_id: "a", action: "CLEAN" },
    { candidate_id: "b", action: "ERROR", corrected: "x" },
    { candidate_id: "b", action: "UNDO" },
    { candidate_id: "c", action: "CLEAN" },
    { candidate_id: "a", action: "ERROR", corrected: "y" },
  ];
  const folded = foldDecisions(log);
  eq(folded.size, 2, "[8] fold size after one undo");
  eq(folded.get("a").action, "ERROR", "[8] last write per candidate wins");
  ok(!folded.has("b"), "[8] UNDO retracts the standing decision");
  eq(folded.get("c").action, "CLEAN", "[8] untouched decisions survive");
  const reFolded = foldDecisions([...log, { candidate_id: "b", action: "CLEAN" }]);
  eq(reFolded.get("b").action, "CLEAN", "[8] a re-label after an undo lands");
}

// ============================================================ [9] refusals
{
  const c = candidate("Nothing wrong here.", { screens: [] });
  ok(!!assembleRecord(c, decide(c, "ERROR", { corrected: c.sentence }), OPTS).error,
    "[9] ERROR with no change is REFUSED");
  ok(!!assembleRecord(c, decide(c, "ERROR"), OPTS).error,
    "[9] ERROR with no corrected text is REFUSED");
  ok(!!assembleRecord(c, decide(c, "OPTIONAL", { corrected: c.sentence }), OPTS).error,
    "[9] OPTIONAL with no rewrite is REFUSED");
  ok(!!assembleRecord(c, decide(c, "WAT"), OPTS).error,
    "[9] an unknown action is REFUSED");
  ok(!!assembleRecord(c, null, OPTS).error, "[9] a missing decision is REFUSED");
  const c2 = candidate("teh cat", { screens: [] });
  const bad = assembleRecord(c2, decide(c2, "ERROR", {
    corrected: "the cat", optional_groups: ["g1"],
  }), OPTS);
  ok(!!bad.error, "[9] an ERROR whose every group was marked optional is REFUSED",
    bad.error);
}

// ======================================== assembleAll + cross-record checks
{
  const a = candidate("All fine here.", { split: "dev", group: "G1", screens: [] });
  const b = candidate("The techncian arrived.", { split: "sealed", group: "G2" });
  const s = candidate("???", { split: "dev", group: "G3", screens: [] });
  const cands = [a, b, s];
  const decisions = foldDecisions([
    decide(a, "CLEAN", { ms: 4000 }),
    decide(b, "ERROR", { corrected: "The technician arrived.", ms: 21000 }),
    decide(s, "SKIP", { skip_reason: "unjudgeable", ms: 3000 }),
  ]);
  const { records, skipped, problems } = assembleAll(cands, decisions, OPTS);
  eq(records.length, 2, "[all] two records");
  eq(skipped.length, 1, "[all] one quarantined");
  deepEq(problems, [], "[all] no problems");
  deepEq(validateFile(records), [], "[all] file-level checks pass");
  ok(records.every((r) => r.schema_version === SCHEMA_VERSION), "[all] schema_version stamped");
  ok(records.every((r) => r.benchmark_version === DEFAULT_BENCHMARK_VERSION),
    "[all] one benchmark_version");

  // A split that partitions SENTENCES instead of episodes must be caught.
  const leaky = records.map((r, i) => ({
    ...r, source: { ...r.source, exclusion_group_id: "SAME" },
    split: i ? "sealed" : "dev",
  }));
  ok(validateFile(leaky).some((p) => /spans both splits/.test(p)),
    "[all] a group spanning both splits is a FILE-level failure");

  // An undecided candidate contributes nothing and is not an error.
  const partial = assembleAll([...cands, candidate("Unlabelled.", { screens: [] })],
    decisions, OPTS);
  eq(partial.records.length, 2, "[all] an undecided candidate is skipped silently");
}

// ================================================================= timing
{
  const t = timingStats([5000, 7000, 9000, 11000, 13000]);
  eq(t.n, 5, "[t] n");
  eq(t.median, 9000, "[t] median");
  eq(t.p90, 13000, "[t] p90");
  ok(t.pass, "[t] a fast session passes the gate");
  const slow = timingStats([20000, 22000, 60000, 61000, 62000]);
  ok(!slow.pass, "[t] a slow session FAILS the gate");
  const even = timingStats([4000, 6000]);
  eq(even.median, 5000, "[t] even-length median averages the middle pair");
  eq(timingStats([]).n, 0, "[t] empty input is n=0");
  ok(!timingStats([]).pass, "[t] an empty session cannot PASS the gate");
  eq(PILOT_GATE.medianMs, 15000, "[t] gate median is the Sol value");
  eq(PILOT_GATE.p90Ms, 45000, "[t] gate p90 is the Sol value");
}

// ================================================================= keys
{
  const k = (s) => decodeKey(Buffer.from(s, "binary")).name;
  eq(k("\x03"), "ctrl-c", "[k] ctrl-c");
  eq(k("\r"), "enter", "[k] CR");
  eq(k("\n"), "enter", "[k] LF");
  eq(k("\x7f"), "backspace", "[k] DEL is backspace");
  eq(k("\x1b"), "escape", "[k] bare ESC");
  eq(k("\x1b[D"), "left", "[k] left");
  eq(k("\x1b[C"), "right", "[k] right");
  eq(k("\x1b[H"), "home", "[k] home");
  eq(k("\x1b[F"), "end", "[k] end");
  eq(k("\x1b[3~"), "delete", "[k] delete");
  eq(k("\x01"), "home", "[k] ctrl-a");
  eq(k("\x05"), "end", "[k] ctrl-e");
  eq(k("\x15"), "clear", "[k] ctrl-u");
  eq(k("C"), "char", "[k] a printable is a char");
  eq(decodeKey(Buffer.from("C")).ch, "C", "[k] char payload");
  eq(k("\x1b[Z"), "unknown", "[k] an unhandled CSI is not mistaken for text");
  eq(k("\x0c"), "unknown", "[k] a stray control byte is not inserted as text");
}

// ================================================= line-editor simulation
// The exact reducer the interactive editor runs, driven by scripted keys —
// the loop around it is TTY plumbing, this is the part that can be wrong.
{
  let buffer = "The techncian arrived early.", cursor = buffer.length;
  const apply = (name, ch) => {
    if (name === "left") cursor = Math.max(0, cursor - 1);
    else if (name === "right") cursor = Math.min(buffer.length, cursor + 1);
    else if (name === "home") cursor = 0;
    else if (name === "end") cursor = buffer.length;
    else if (name === "clear") { buffer = ""; cursor = 0; }
    else if (name === "backspace") {
      if (cursor > 0) { buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor); cursor--; }
    } else if (name === "delete") buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
    else if (name === "char") { buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor); cursor += ch.length; }
  };
  apply("home");
  for (let i = 0; i < 8; i++) apply("right");     // after "The tech"
  apply("char", "n");                              // -> "The techn" + "ncian..."
  apply("right"); apply("right");                  // over "nc"
  apply("backspace"); apply("backspace");          // remove "nc"
  apply("char", "i"); apply("char", "c");
  eq(buffer, "The technician arrived early.",
    "[e] scripted keys turn the prefill into the correction");
  apply("end"); apply("backspace");
  eq(buffer, "The technician arrived early", "[e] end + backspace drops the terminator");
  apply("clear");
  eq(buffer + "|" + cursor, "|0", "[e] ctrl-u clears and homes the cursor");
}

// ================================================================ render
{
  const c = candidate("The techncian arrived early.", {
    inject: { error_type: "transposition", original: "The technician arrived early.",
      groups: [], inject_version: "v1" },
  });
  const frame = renderFrame(c, { index: 3, total: 480, decided: 2, lastMs: 8200 });
  ok(frame.includes("The techncian arrived early."), "[r] the sentence is rendered");
  ok(frame.includes("CONTEXT"), "[r] context header");
  ok(frame.includes("3/480"), "[r] progress");
  ok(frame.includes("INJECTED transposition"), "[r] injected candidates are announced");
  ok(frame.includes("C clean") && frame.includes("E error") && frame.includes("S skip"),
    "[r] the key legend is on screen");
  ok(!frame.includes("undefined"), "[r] no undefined leaks into the frame");
  const long = candidate("x".repeat(20), { context: "y".repeat(1200) });
  const short = renderFrame(long, {});
  ok(short.includes("Space for all"), "[r] a long context says how to expand it");
  const full = renderFrame(long, { expandedContext: true });
  ok(full.includes("(full)"), "[r] expanded context is labelled");
  const edit = renderFrame(c, { mode: "edit", buffer: "abc", cursor: 2 });
  ok(edit.includes("Enter=commit"), "[r] the edit frame states its keys");
  const groups = groupsFromCorrection(c.sentence, "The technician arrived early.",
    { defaultType: "transposition" });
  const typed = renderFrame(c, { mode: "type", groups });
  ok(typed.includes("type=transposition"), "[r] the type frame shows the suggestion");
  ok(typed.includes("1:transposition"), "[r] the type frame lists the number keys");
}

// ============================================== acceptableOutputs dedup
{
  const sentence = "teh cat sat";
  const groups = groupsFromCorrection(sentence, "the cat sat",
    { defaultType: "transposition", alternatives: { g1: ["the", "The"] } });
  // "the" duplicates the primary replacement and must not create a duplicate
  // acceptable output; "The" must.
  eq(groups[0].alternatives.length, 2, "[o] the duplicate alternative was dropped");
  const outs = acceptableOutputs(sentence, groups);
  eq(outs.length, 2, "[o] one primary plus one distinct alternative",
    outs.map((o) => o.rewritten).join(" | "));
  ok(new Set(outs.map((o) => o.id)).size === outs.length, "[o] output ids are unique");
}

// ======================================================== credit vocabulary
{
  deepEq(CREDITS, ["no-op", "required-correction", "benign-optional"],
    "[cr] the acceptable-output vocabulary is the schema's, not a local copy");
  ok(!CREDITS.some((c) => c !== "required-correction" && c !== "benign-optional"
    && VERDICTS.includes(c)),
    "[cr] `no-op` exists in CREDITS and NOT in the judge's VERDICTS");

  const c = candidate("teh cat sat", { screens: [] });
  const groups = groupsFromCorrection(c.sentence, "the cat sat",
    { defaultType: "transposition" });
  eq(creditFor(c.sentence, groups, {}, "the cat sat"), "required-correction",
    "[cr] applying a required group credits required-correction");
  eq(creditFor(c.sentence, groups, { g1: null }, c.sentence), "no-op",
    "[cr] reverting to the input credits no-op");
  const benign = groupsFromCorrection(c.sentence, "the cat sat",
    { requirement: "benign-optional" });
  eq(creditFor(c.sentence, benign, {}, "the cat sat"), "benign-optional",
    "[cr] a purely optional rewrite credits benign-optional");

  // Every record this file assembles must satisfy the two new schema rules.
  const all = [
    assembleRecord(c, decide(c, "CLEAN"), OPTS),
    assembleRecord(c, decide(c, "ERROR", { corrected: "the cat sat" }), OPTS),
    assembleRecord(c, decide(c, "OPTIONAL", { corrected: "The cat sat." }), OPTS),
  ];
  for (const [i, r] of all.entries()) {
    ok(!r.error, `[cr] fixture ${i} assembles`, r.error);
    deepEq(validateRecord(r.record), [], `[cr] fixture ${i} passes the NEW validator`);
    for (const a of r.record.label.acceptable_outputs) {
      ok(CREDITS.includes(a.credit), `[cr] fixture ${i} credit in vocabulary`, a.credit);
      if (a.credit === "no-op") {
        eq(normalizeOut(a.rewritten), normalizeOut(r.record.sentence),
          `[cr] fixture ${i}: a no-op credit only ever sits on the input itself`);
      }
    }
  }

  // The validator now owns group order/non-overlap; `materialize` keeps its own
  // check as a belt, so a broken decomposition dies at the splice rather than
  // producing a silently wrong string.
  const overlapping = [
    { id: "g1", start_utf16: 0, end_utf16: 5, before: "teh c",
      requirement: "required-correction", error_type: "transposition",
      alternatives: [{ id: "g1a1", replacement: "the c" }] },
    { id: "g2", start_utf16: 3, end_utf16: 7, before: "cat",
      requirement: "required-correction", error_type: "transposition",
      alternatives: [{ id: "g2a1", replacement: "dog" }] },
  ];
  const bad = { ...all[0].record };
  bad.label = { ...bad.label, input_status: "ERROR", edit_groups: overlapping,
    acceptable_outputs: [{ id: "primary", rewritten: "x", credit: "required-correction" }] };
  ok(validateRecord(bad).some((p) => /overlaps or out of order/.test(p)),
    "[cr] the validator catches overlapping groups");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of fails) console.log("  FAIL " + f);
  process.exit(1);
}
