#!/usr/bin/env node
// The owner's labeling flow for the 400 Terra-calibration examples (§4).
//
//   node label-calibration.mjs --in <calibration-set.jsonl> [--out <labels.jsonl>]
//                              [--dev <uids.json> | --sealed <uids.json>] [--resume]
//
// Writes owner labels in EXACTLY the schema `calibrate-judge.mjs` documents.
// One row per LABELLED EDIT GROUP:
//
//   {uid, group, verdict, keep, damage, borderline, note, split, ms, ts}
//
// `keep` and `damage` are DERIVED from `verdict` through `ownerLabelFor` in
// verdicts.mjs — never typed independently, and re-checked by calibrate-judge
// on read. The full five-class `verdict` is recorded as well as the two
// booleans because the booleans cannot represent the five classes:
// `required-correction` and `benign-optional` project to the same pair, and §4
// explicitly requires those two to be told apart, since under D1 they are the
// same decision for the target and a different statement about the edit.
//
// APPEND-ONLY, INCLUDING UNDO. Every answer is written the instant it is given,
// so a crash, a closed terminal or a Ctrl-C costs nothing. Undo cannot rewrite
// history in an append-only file, so it appends a TOMBSTONE
// (`{type:"undo", uid, group}`) and `--resume` folds tombstones over labels when
// it replays. The alternative — rewriting the file on every undo — is a
// truncate-and-rewrite on the one artifact that represents hours of the owner's
// attention, and it fails destructively exactly when the process is dying.
//
// The session loop is separated from the terminal so it can be driven by a
// test: `runLabelSession` takes an input source rather than reading stdin, and
// label-calibration-test.mjs drives it with scripted answers. A labeling flow
// whose only test is a human using it has no test.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { editGroups, markSource } from "./edit-groups.mjs";
import {
  VERDICT_CLASSES, VERDICT_KEYS, VERDICT_ABBR, ownerLabelFor,
  readJsonl, readJsonlIfPresent, appendSink, argOf, hasFlag, fail,
} from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");

// ------------------------------------------------------------------ session

/**
 * Fold an append-only label file into the answers that currently stand.
 * Tombstones remove the label they name; a later re-answer replaces it.
 */
export function foldLabels(rows) {
  const answers = new Map();          // "uid group" -> row
  for (const r of rows) {
    if (!r) continue;
    const key = `${r.uid} ${r.group}`;
    if (r.type === "undo") answers.delete(key);
    else if (typeof r.uid === "string" && typeof r.group === "number") answers.set(key, r);
  }
  return answers;
}

/**
 * The labeling state machine. Pure of the terminal: `io.next(mode)` returns the
 * next answer ("key" for a single keypress, "line" for a typed string) and
 * `io.render(view)` presents the current item. Returns a summary.
 *
 * @param {object} o
 * @param {Array}  o.items    [{uid, context, input, output, groups, split}]
 * @param {object} o.io       {next(mode), render(view), say(text)}
 * @param {object} o.sink     {write(row), close()}
 * @param {Map}    o.answered folded existing answers (for --resume)
 * @param {() => number} [o.now]
 */
export async function runLabelSession({ items, io, sink, answered = new Map(), now = Date.now }) {
  // Flatten to (item, group) units. A no-op example has zero groups and is
  // skipped with a note rather than shown: there is nothing to label, and
  // presenting an empty screen reads as a bug.
  const units = [];
  let emptyItems = 0;
  for (const it of items) {
    if (!it.groups.length) { emptyItems++; continue; }
    for (const g of it.groups) units.push({ item: it, group: g });
  }

  const stats = { labelled: 0, skipped: 0, undone: 0, resumed: 0, emptyItems, byClass: {}, msTotal: 0 };
  const history = [];                     // units answered this session, for undo

  let i = 0;
  let borderline = false;
  while (i < units.length) {
    const u = units[i];
    const key = `${u.item.uid} ${u.group.id}`;
    if (answered.has(key)) { stats.resumed++; i++; continue; }

    io.render({
      index: i, total: units.length,
      item: u.item, group: u.group, borderline,
      remaining: units.length - i,
    });

    const t0 = now();
    const k = String(await io.next("key") ?? "").trim();
    const ms = now() - t0;

    if (k === "" ) continue;                                   // stray newline
    const lower = k.toLowerCase();

    if (lower === "q") { io.say("\nquit — everything answered so far is saved."); break; }

    if (lower === "?" || lower === "h") { io.say(helpText()); continue; }

    if (lower === "b") {
      borderline = !borderline;
      io.say(`  borderline ${borderline ? "ON" : "off"} for this group`);
      continue;
    }

    if (lower === "u") {
      const last = history.pop();
      if (!last) { io.say("  nothing to undo"); continue; }
      sink.write({ type: "undo", uid: last.uid, group: last.group, ts: new Date(now()).toISOString() });
      answered.delete(`${last.uid} ${last.group}`);
      if (last.verdict) { stats.byClass[last.verdict]--; stats.labelled--; } else stats.skipped--;
      stats.undone++;
      i = units.findIndex((x) => x.item.uid === last.uid && x.group.id === last.group);
      borderline = false;
      io.say(`  undid ${last.uid} group ${last.group}`);
      continue;
    }

    if (lower === "s") {
      io.say("  skip reason (one line): ");
      const reason = String(await io.next("line") ?? "").trim();
      const row = {
        uid: u.item.uid, group: u.group.id, skipped: true,
        skip_reason: reason || "(none given)",
        split: u.item.split ?? null, ms, ts: new Date(now()).toISOString(),
      };
      sink.write(row);
      answered.set(key, row);
      history.push({ uid: u.item.uid, group: u.group.id, verdict: null });
      stats.skipped++; stats.msTotal += ms;
      borderline = false; i++;
      continue;
    }

    const verdict = VERDICT_KEYS[k];
    if (!verdict) { io.say(`  "${k}" is not a choice. ${Object.keys(VERDICT_KEYS).join("/")}, b, s, u, q, ?`); continue; }

    const { keep, damage } = ownerLabelFor(verdict);
    const row = {
      uid: u.item.uid, group: u.group.id, verdict, keep, damage,
      borderline, note: "", split: u.item.split ?? null,
      ms, ts: new Date(now()).toISOString(),
    };
    sink.write(row);
    answered.set(key, row);
    history.push({ uid: u.item.uid, group: u.group.id, verdict });
    stats.labelled++; stats.msTotal += ms;
    stats.byClass[verdict] = (stats.byClass[verdict] || 0) + 1;
    borderline = false;
    i++;
  }

  stats.total = units.length;
  stats.done = i;
  return stats;
}

function helpText() {
  return "\n" + VERDICT_CLASSES.map((c, n) => `  ${n + 1}  ${c}`).join("\n") +
    "\n  b  toggle BORDERLINE on this group (then press 1-5)" +
    "\n  s  skip this group, with a reason" +
    "\n  u  undo the last answer" +
    "\n  q  save and quit" +
    "\n  ?  this help\n";
}

// ------------------------------------------------------------------ display

const C = process.stdout.isTTY ? {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`,
} : {
  dim: (s) => s, bold: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s,
};

export function renderView(view, say) {
  const { item, group, index, total, borderline } = view;
  const lines = [];
  lines.push("");
  lines.push("=".repeat(76));
  lines.push(C.dim(`  ${index + 1}/${total}   ${item.uid}   group ${group.id} of ${item.groups.length}` +
                   (item.split ? `   [${item.split}]` : "")));
  lines.push("");
  const ctx = String(item.context || "");
  if (ctx) {
    const tail = ctx.slice(-240).replace(/\n+/g, " ⏎ ");
    lines.push(C.dim(`  context…  ${tail}`));
  } else {
    lines.push(C.dim(`  context…  (none)`));
  }
  lines.push("");
  // markSource is the same machinery judge-harness renders with, so the owner
  // and the judge are looking at the identical decomposition.
  lines.push(`  source    ${markSource(item.input, item.groups)}`);
  lines.push(`  teacher   ${item.output}`);
  lines.push("");
  for (const g of item.groups) {
    const cur = g.id === group.id;
    const mark = cur ? C.bold(C.cyan("▶")) : " ";
    const b = g.before === "" ? C.dim("(nothing)") : C.red(JSON.stringify(g.before));
    const a = g.after === "" ? C.dim("(deleted)") : C.green(JSON.stringify(g.after));
    lines.push(`  ${mark} [${g.id}] ${b} ${C.dim("→")} ${a}`);
  }
  lines.push("");
  lines.push("  " + VERDICT_CLASSES.map((c, n) => `${C.bold(String(n + 1))} ${VERDICT_ABBR[c]}`).join("   ") +
             `   ${C.bold("b")} borderline${borderline ? C.yellow(" ON") : ""}   ${C.bold("s")} skip   ${C.bold("u")} undo   ${C.bold("q")} quit   ${C.bold("?")} help`);
  say(lines.join("\n"));
}

// ------------------------------------------------------------------- tty io

function ttyIo() {
  const say = (s) => process.stdout.write(s + "\n");
  let queue = [];
  let waiter = null;
  let mode = "key";
  let lineBuf = "";

  process.stdin.setEncoding("utf8");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    for (const ch of chunk) {
      if (ch === "") {                       // Ctrl-C: everything is saved
        process.stdout.write("\n(interrupted — every answer given is already on disk)\n");
        process.exit(130);
      }
      if (mode === "key") { push(ch); continue; }
      if (ch === "\r" || ch === "\n") { push(lineBuf); lineBuf = ""; continue; }
      if (ch === "") { lineBuf = lineBuf.slice(0, -1); process.stdout.write("\b \b"); continue; }
      lineBuf += ch;
      process.stdout.write(ch);
    }
  });

  function push(v) {
    if (waiter) { const w = waiter; waiter = null; w(v); }
    else queue.push(v);
  }

  return {
    say,
    render: (view) => renderView(view, say),
    next(m) {
      mode = m;
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => { waiter = res; });
    },
  };
}

// --------------------------------------------------------------------- main

async function main() {
  const IN = argOf("--in", path.join(ART, "calibration-set.jsonl"));
  const OUT = argOf("--out", path.join(ART, "calibration-owner-labels.jsonl"));
  const DEV = argOf("--dev");
  const SEALED = argOf("--sealed");
  const RESUME = hasFlag("--resume");
  const LIMIT = argOf("--limit") ? Number(argOf("--limit")) : Infinity;

  const rows = readJsonl(IN, "calibration set");
  const splitOf = new Map();
  const loadUids = (p, name) => {
    const raw = fs.readFileSync(p, "utf8").trim();
    const list = raw.startsWith("[") ? JSON.parse(raw)
      : raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const u of list) splitOf.set(u, name);
    return new Set(list);
  };
  let only = null;
  if (DEV && SEALED) fail("pass --dev or --sealed, not both.");
  if (DEV) only = loadUids(DEV, "dev");
  if (SEALED) only = loadUids(SEALED, "sealed");

  const items = [];
  let malformed = 0;
  for (const r of rows) {
    if (!r || typeof r.uid !== "string" || typeof r.input !== "string" || typeof r.output !== "string") {
      malformed++; continue;
    }
    if (only && !only.has(r.uid)) continue;
    items.push({
      uid: r.uid, context: r.context || "", input: r.input, output: r.output,
      groups: editGroups(r.input, r.output),
      split: splitOf.get(r.uid) ?? r.split ?? null,
    });
    if (items.length >= LIMIT) break;
  }
  if (malformed) console.log(`  MALFORMED: ${malformed} row(s) lacked uid/input/output and were dropped.`);
  if (!items.length) fail(`no items to label from ${IN}${only ? " within the given split" : ""}.`);

  const existing = RESUME ? readJsonlIfPresent(OUT) : [];
  if (!RESUME && fs.existsSync(OUT) && fs.readFileSync(OUT, "utf8").trim()) {
    fail(`${OUT} already has labels in it.\n` +
         `  Pass --resume to continue that session. Refusing to interleave two sessions into\n` +
         `  one append-only file without being told to — the fold would silently mix them.`);
  }
  const answered = foldLabels(existing);

  const totalGroups = items.reduce((n, it) => n + it.groups.length, 0);
  console.log(`\nCalibration labeling`);
  console.log("=".repeat(76));
  console.log(`  set        ${IN}`);
  console.log(`  labels     ${OUT}${RESUME ? "  (resuming, append-only)" : ""}`);
  console.log(`  items      ${items.length} example(s), ${totalGroups} edit group(s)` +
              (only ? `   [${DEV ? "dev" : "sealed"} split]` : ""));
  if (answered.size) console.log(`  already    ${answered.size} group(s) answered — they will be skipped`);
  console.log(helpText());

  if (!process.stdin.isTTY) {
    fail("stdin is not a TTY. This is the interactive labeling flow.\n" +
         "  For automated exercise of the assembly and schema path, run label-calibration-test.mjs,\n" +
         "  which drives runLabelSession() with scripted answers.");
  }

  const sink = appendSink(OUT);
  const io = ttyIo();
  const stats = await runLabelSession({ items, io, sink, answered });
  sink.close();

  console.log("\n" + "=".repeat(76));
  console.log(`  labelled   ${stats.labelled}   skipped ${stats.skipped}   undone ${stats.undone}` +
              (stats.resumed ? `   already-answered ${stats.resumed}` : ""));
  console.log(`  by class   ` + VERDICT_CLASSES.map((c) => `${VERDICT_ABBR[c]}=${stats.byClass[c] || 0}`).join("  "));
  if (stats.labelled + stats.skipped) {
    console.log(`  pace       ${Math.round(stats.msTotal / (stats.labelled + stats.skipped))} ms/group median-ish (mean)`);
  }
  if (stats.emptyItems) console.log(`  no-op controls with zero groups, nothing to label: ${stats.emptyItems}`);
  console.log(`  progress   ${stats.done}/${stats.total} group(s)`);
  console.log(`  written to ${OUT}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
