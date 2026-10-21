#!/usr/bin/env node
// Drives the calibration labeling flow with scripted answers. No TTY, no model,
// no network. All sentences are SYNTHETIC — authored for this file.
//
//   node label-calibration-test.mjs
//
// What this is for: the labeling flow is the one instrument whose normal mode of
// operation is a human at a terminal, and the repo has a standing entry about a
// harness that only ever tests its own failure paths. The parts worth pinning
// are the ones that silently corrupt hours of the owner's attention — the
// derived keep/damage projection, the append-only undo fold, resume, and the
// skip record — none of which a person can see going wrong while they work.

import fs from "fs";
import os from "os";
import path from "path";
import { runLabelSession, foldLabels } from "./label-calibration.mjs";
import { editGroups } from "./edit-groups.mjs";
import { ownerLabelFor, VERDICT_KEYS, appendSink, readJsonl } from "./verdicts.mjs";

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
        `got      ${JSON.stringify(got)}\n          expected ${JSON.stringify(want)}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-label-"));
const tmp = (n) => path.join(TMP, n);

function mkItems(pairs) {
  return pairs.map(([uid, input, output, context, split]) => ({
    uid, input, output, context: context || "",
    groups: editGroups(input, output), split: split ?? null,
  }));
}

/** An io that replays a script and records what it was shown. */
function scriptedIo(script) {
  const said = [];
  const rendered = [];
  let i = 0;
  return {
    said, rendered,
    say: (s) => said.push(String(s)),
    render: (v) => rendered.push({ uid: v.item.uid, group: v.group.id, borderline: v.borderline }),
    next: async () => (i < script.length ? script[i++] : "q"),
    consumed: () => i,
  };
}

async function session(items, script, file, answered) {
  const sink = appendSink(file);
  let t = 1_700_000_000_000;
  const io = scriptedIo(script);
  const stats = await runLabelSession({
    items, io, sink, answered, now: () => (t += 250),
  });
  sink.close();
  return { stats, io, rows: readJsonl(file) };
}

console.log("\nCalibration labeling flow\n" + "=".repeat(72));

// ---------------------------------------------------------------- [1] schema

console.log("\n[1] Every label row is the schema calibrate-judge.mjs documents:");
{
  const items = mkItems([
    ["t-1", "The techncian arrived erly.", "The technician arrived early.", "any update?", "dev"],
    ["t-2", "The salt levels were fine.", "The slat levels were fine.", "", "dev"],
  ]);
  eq("t-1 decomposes into two groups", items[0].groups.length, 2);
  const f = tmp("a.jsonl");
  // 1,1 for the two typo groups; 4 for the damage.
  const { stats, rows } = await session(items, ["1", "1", "4"], f);

  eq("three labels written", rows.length, 3);
  const REQUIRED = ["uid", "group", "verdict", "keep", "damage", "borderline", "note", "split", "ms", "ts"];
  const missing = rows.flatMap((r) => REQUIRED.filter((k) => !(k in r)).map((k) => `${r.uid}.${k}`));
  eq("no required field is missing", missing, []);

  // The projection is the point: keep/damage must never be typed by hand.
  const bad = rows.filter((r) => {
    const want = ownerLabelFor(r.verdict);
    return r.keep !== want.keep || r.damage !== want.damage;
  });
  eq("keep/damage are the derived projection of verdict", bad.map((r) => r.uid), []);
  eq("damage row is keep:false damage:true",
     rows.filter((r) => r.uid === "t-2").map((r) => [r.verdict, r.keep, r.damage]),
     [["meaning-damage", false, true]]);
  eq("required-correction rows are keep:true damage:false",
     rows.filter((r) => r.uid === "t-1").map((r) => [r.keep, r.damage]),
     [[true, false], [true, false]]);
  eq("split is carried through", [...new Set(rows.map((r) => r.split))], ["dev"]);
  check("per-item timing recorded", rows.every((r) => typeof r.ms === "number" && r.ms > 0));
  eq("stats count by class", stats.byClass, { "required-correction": 2, "meaning-damage": 1 });
}

// -------------------------------------------------------------- [2] the keys

console.log("\n[2] All five classes are reachable, and only by their own key:");
{
  const items = mkItems([
    ["k-1", "aa bb cc dd ee ff.", "aA bb cc dd ee ff.", ""],
  ]);
  for (const [key, want] of Object.entries(VERDICT_KEYS)) {
    const f = tmp(`k${key}.jsonl`);
    const { rows } = await session(items, [key], f);
    eq(`key ${key} -> ${want}`, rows.map((r) => r.verdict), [want]);
  }
  const f = tmp("k-bad.jsonl");
  const { rows, io } = await session(items, ["7", "x", "2"], f);
  eq("unknown keys are rejected, not recorded", rows.map((r) => r.verdict), ["benign-optional"]);
  check("and each rejection says so", io.said.filter((s) => s.includes("is not a choice")).length === 2,
        `said: ${JSON.stringify(io.said)}`);
}

// ------------------------------------------------------------ [3] borderline

console.log("\n[3] Borderline is a per-group toggle that resets after an answer:");
{
  // Non-adjacent on purpose: adjacent changes share a region and would be ONE
  // group, which is the merge rule and not a bug to route around silently.
  const items = mkItems([["b-1", "aa bb cc.", "aA bb cC.", ""]]);
  eq("b-1 has two groups", items[0].groups.length, 2);
  const f = tmp("b.jsonl");
  const { rows } = await session(items, ["b", "2", "2"], f);
  eq("first group borderline, second not", rows.map((r) => r.borderline), [true, false]);
}

// ------------------------------------------------------------------ [4] skip

console.log("\n[4] Skip records a reason and is not a label:");
{
  const items = mkItems([["s-1", "The counsel met.", "The council met.", ""]]);
  const f = tmp("s.jsonl");
  const { stats, rows } = await session(items, ["s", "need to ask the author"], f);
  eq("one row", rows.length, 1);
  eq("skipped row shape", [rows[0].skipped, rows[0].skip_reason, "verdict" in rows[0]],
     [true, "need to ask the author", false]);
  eq("counted as skipped, not labelled", [stats.labelled, stats.skipped], [0, 1]);

  const f2 = tmp("s2.jsonl");
  const { rows: r2 } = await session(items, ["s", ""], f2);
  eq("an empty reason is recorded as such", r2[0].skip_reason, "(none given)");
}

// ------------------------------------------------------------------ [5] undo

console.log("\n[5] Undo is an append-only tombstone, and the fold honours it:");
{
  const items = mkItems([
    ["u-1", "The techncian arrived erly.", "The technician arrived early.", ""],
  ]);
  const f = tmp("u.jsonl");
  // answer group 1 wrong, undo it, answer it right, then answer group 2.
  const { stats, rows } = await session(items, ["4", "u", "1", "1"], f);

  check("the file still contains the mistaken answer (nothing is rewritten)",
        rows.some((r) => r.verdict === "meaning-damage"));
  check("and a tombstone for it", rows.some((r) => r.type === "undo" && r.group === 1));

  const folded = foldLabels(rows);
  eq("the fold leaves two standing answers", folded.size, 2);
  eq("group 1 now stands as required-correction", folded.get("u-1 1").verdict, "required-correction");
  eq("group 2 stands as required-correction", folded.get("u-1 2").verdict, "required-correction");
  eq("undo is counted", stats.undone, 1);
  eq("labelled count is net of the undo", stats.labelled, 2);
  eq("by-class is net of the undo", stats.byClass,
     { "meaning-damage": 0, "required-correction": 2 });

  const empty = await session(mkItems([["u-2", "aa bb.", "aA bb.", ""]]), ["u", "1"], tmp("u2.jsonl"));
  check("undo with nothing to undo is refused, not a crash",
        empty.io.said.some((s) => s.includes("nothing to undo")));
  eq("and the next answer still lands", empty.rows.filter((r) => r.verdict).length, 1);
}

// ---------------------------------------------------------------- [6] resume

console.log("\n[6] Resume skips what is already answered and appends the rest:");
{
  const items = mkItems([
    ["r-1", "The techncian arrived erly.", "The technician arrived early.", ""],
    ["r-2", "The salt levels were fine.", "The slat levels were fine.", ""],
  ]);
  const f = tmp("r.jsonl");
  const first = await session(items, ["1", "q"], f);
  eq("first session answered one group then quit", first.rows.length, 1);

  const answered = foldLabels(readJsonl(f));
  const second = await session(items, ["1", "4"], f, answered);
  eq("second session resumed past the answered group", second.stats.resumed, 1);
  eq("and answered the remaining two", second.stats.labelled, 2);

  const folded = foldLabels(readJsonl(f));
  eq("all three groups now stand", folded.size, 3);
  eq("no group was answered twice",
     [...folded.keys()].sort(), ["r-1 1", "r-1 2", "r-2 1"]);
}

// ------------------------------------------------- [7] no-op controls, quit

console.log("\n[7] Zero-group items and quit:");
{
  const items = mkItems([
    ["n-1", "The report was filed on time.", "The report was filed on time.", ""],
    ["n-2", "The paket arrived.", "The packet arrived.", ""],
  ]);
  eq("the no-op item has no groups", items[0].groups.length, 0);
  const f = tmp("n.jsonl");
  const { stats, rows, io } = await session(items, ["1"], f);
  eq("the no-op item is not presented", io.rendered.map((r) => r.uid), ["n-2"]);
  eq("it is counted as an empty item", stats.emptyItems, 1);
  eq("only the real group is labelled", rows.length, 1);

  const q = await session(mkItems([["q-1", "aa bb cc.", "aA bb cC.", ""]]), ["1", "q"], tmp("q.jsonl"));
  eq("quit stops the session with work saved", q.rows.length, 1);
  check("and says so", q.io.said.some((s) => s.includes("quit")));
}

// ------------------------------------------- [8] end-to-end into calibrate

console.log("\n[8] The labels this writes are readable by calibrate-judge.mjs:");
{
  const items = mkItems([
    ["c-1", "The techncian arrived.", "The technician arrived.", "", "sealed"],
    ["c-2", "The salt levels were fine.", "The slat levels were fine.", "", "sealed"],
    ["c-3", "when it drained we restarted it", "When it drained, we restarted it", "", "sealed"],
  ]);
  const labels = tmp("c-labels.jsonl");
  await session(items, ["1", "4", "2", "2"], labels);

  // A judge-verdicts file that agrees on everything except the damage case.
  const verdicts = tmp("c-verdicts.jsonl");
  fs.writeFileSync(verdicts, items.map((it) => JSON.stringify({
    uid: it.uid, groups: it.groups, status: "judged", batch_id: "t", quarantined: false,
    verdicts: it.groups.map((g) => ({
      group: g.id,
      verdict: it.uid === "c-1" ? "required-correction"
             : it.uid === "c-2" ? "unnecessary"          // owner said damage
             : "benign-optional",
    })),
  })).join("\n") + "\n");
  const uids = tmp("c-uids.txt");
  fs.writeFileSync(uids, items.map((i) => i.uid).join("\n") + "\n");

  const { spawnSync } = await import("child_process");
  const r = spawnSync(process.execPath, [
    new URL("calibrate-judge.mjs", import.meta.url).pathname,
    "--labels", labels, "--verdicts", verdicts, "--sealed", uids,
  ], { encoding: "utf8" });

  const out = (r.stdout || "") + (r.stderr || "");
  check("calibrate-judge parsed the labels without a schema complaint",
        !/MALFORMED LABELS/.test(out), out.split("\n").slice(0, 24).join("\n"));
  check("it scored all four groups", /scored\s+4 group/.test(out), out);
  check("it saw the owner's damage group", /owner-flagged damage groups\s+1/.test(out), out);
  check("and failed the damage gate on the disagreement",
        /meaning-damage recall\s+0\.0%/.test(out) && /GATE \(§4, sealed\): FAIL/.test(out), out);
  check("exit code is 1 on a failed gate", r.status === 1, `status ${r.status}`);
}

console.log("\n" + "=".repeat(72));
console.log(`${passed} passed, ${failures.length} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
if (failures.length) {
  console.log("Failures: " + failures.join(", "));
  process.exit(1);
}
