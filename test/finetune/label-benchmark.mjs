#!/usr/bin/env node
// The owner's keyboard-first benchmark labeler, and the assembly step that
// turns its decisions into schema records.
//
// The design constraint is the 50-item timed pilot gate (Sol brainstorm
// 2026-08-20): median <= 15 s, p90 <= 45 s per item. 1,000 items at 15 s is
// four hours; at 40 s it is eleven, and the benchmark does not get built. So
// every design choice below is a time choice:
//
//   - ONE KEY decides the common case. `C` is the answer for ~67% of items and
//     costs a single keystroke with no confirmation and no cursor.
//   - The correction editor is PREFILLED WITH THE SENTENCE, not empty. The
//     owner edits a typo out; they never retype a sentence. For an injected
//     candidate it is prefilled with the KNOWN ORIGINAL — that is a MECHANICAL
//     seed (a transform's own inverse), which the brainstorm allows; a model
//     seed, which it forbids, would make the benchmark measure the model.
//   - The edit groups are DERIVED from the correction by `edit-groups.mjs` —
//     the same decomposition the judge and the scorer use. Asking the owner to
//     mark spans by hand would cost minutes per item and would produce a second
//     decomposition that drifts from the first.
//   - `error_type` arrives PRE-SUGGESTED, from the injection metadata where
//     there is one and from the natural screens otherwise, so the common case
//     is "accept the suggestion" (zero keys) rather than "choose from 13".
//   - Every action AUTOSAVES. A labeling session that loses an hour of work to
//     a terminal close has a worse effective rate than one that is slower.
//
// The decision log is APPEND-ONLY. `--resume` folds it (last write per
// candidate wins; an UNDO record retracts the one before it) rather than
// rewriting history, so a crashed session cannot corrupt what it already had.
// Undo is LAST-ONLY, deliberately: an undo stack is a second editing surface
// to build, test and get wrong, and the recovery for anything deeper is to
// re-label the candidate, which the fold handles for free.
//
// Usage:
//   node test/finetune/label-benchmark.mjs --register chat-owner            # label
//   node test/finetune/label-benchmark.mjs --register chat-owner --resume
//   node test/finetune/label-benchmark.mjs --register chat-owner --pilot 50
//   node test/finetune/label-benchmark.mjs --register chat-owner --timing
//   node test/finetune/label-benchmark.mjs --register chat-owner --assemble
//   node test/finetune/label-benchmark.mjs --register chat-owner --selftest-render

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { editGroups } from "./edit-groups.mjs";
import {
  SCHEMA_VERSION, ERROR_TYPES, REGISTERS, REQUIREMENTS,
  validateRecord, validateFile, normalizeOut,
} from "./benchmark-schema.mjs";
import { TAG_TO_ERROR_TYPE } from "./natural-screens.mjs";

export const LABELER_VERSION = "label-benchmark/v1";
export const DEFAULT_BENCHMARK_VERSION = "proofer-benchmark-v1";

/** The Sol pilot gate. Fifty items, timed; below this the flow gets redesigned
 *  before the other 950 are attempted. */
export const PILOT_GATE = Object.freeze({ medianMs: 15_000, p90Ms: 45_000, n: 50 });

const OUT_DIR = new URL("../harvested/finetune/", import.meta.url);
const LABELS_FILE = "benchmark-labels.jsonl";

export const ACTIONS = Object.freeze(["CLEAN", "ERROR", "OPTIONAL", "SKIP", "UNDO"]);

function die(msg) { console.error("label-benchmark: " + msg); process.exit(1); }

// =====================================================================
// CORE — no TTY, no I/O beyond explicit paths. The test drives all of this.
// =====================================================================

/** Fold an append-only decision log: last write per candidate wins, and an
 *  UNDO retracts whatever was standing for that candidate. */
export function foldDecisions(records) {
  const byId = new Map();
  for (const d of records) {
    if (!d || typeof d.candidate_id !== "string") continue;
    if (d.action === "UNDO") byId.delete(d.candidate_id);
    else byId.set(d.candidate_id, d);
  }
  return byId;
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out = [];
  text.split("\n").forEach((line, i) => {
    const l = line.trim();
    if (!l) return;
    try { out.push(JSON.parse(l)); }
    catch { die(`${path}:${i + 1} is not JSON — refusing to guess past a corrupt line`); }
  });
  return out;
}

/**
 * Schema edit groups from a source sentence and the owner's corrected text.
 *
 * `edit-groups.mjs` owns the decomposition; this only re-shapes it into the
 * benchmark record's field names and attaches the requirement and the
 * (suggested, overridable) error type. Group ids are `g<n>` in source order,
 * so a stored type override still names the same span on a re-fold.
 */
export function groupsFromCorrection(sentence, corrected, opts = {}) {
  const { requirement = "required-correction", types = {}, alternatives = {},
    defaultType = "other-natural" } = opts;
  if (!REQUIREMENTS.includes(requirement)) die(`bad requirement ${requirement}`);
  return editGroups(sentence, corrected).map((g) => {
    const id = "g" + g.id;
    const extra = (alternatives[id] ?? []).filter((a) => a !== g.after);
    const group = {
      id,
      start_utf16: g.srcSpan[0],
      end_utf16: g.srcSpan[1],
      before: g.before,
      requirement,
      alternatives: [
        { id: `${id}a1`, replacement: g.after },
        ...extra.map((a, i) => ({ id: `${id}a${i + 2}`, replacement: a })),
      ],
      kind: g.kind,
    };
    if (requirement === "required-correction") {
      group.error_type = types[id] ?? defaultType;
    }
    return group;
  });
}

/**
 * Splice `groups` into `sentence`. `choice` maps group id -> alternative index,
 * or `null` to revert that group to the source text.
 *
 * A local splice rather than `applyGroups`, because the record's groups carry
 * an ALTERNATIVE LIST and applyGroups knows only a single `after`. Same
 * arithmetic, and the round trip is asserted in the test.
 */
export function materialize(sentence, groups, choice = {}) {
  const sorted = groups.slice().sort((a, b) => a.start_utf16 - b.start_utf16);
  let out = "", pos = 0;
  for (const g of sorted) {
    if (g.start_utf16 < pos) die("overlapping edit groups — the decomposition is broken");
    out += sentence.slice(pos, g.start_utf16);
    const idx = (g.id in choice) ? choice[g.id] : 0;
    out += idx === null ? g.before : g.alternatives[idx].replacement;
    pos = g.end_utf16;
  }
  return out + sentence.slice(pos);
}

/**
 * The acceptable-output set for a record.
 *
 * primary            every group's FIRST alternative applied.
 * required-only      benign-optional groups reverted (an ERROR record whose
 *                    only remaining edits are the required ones is a correct
 *                    output too, and scoring it as a miss would penalise
 *                    exactly the minimal-edit behaviour D1 wants).
 * per-alternative    one output per extra alternative, that alternative swapped
 *                    in and everything else at primary. Enumerating the full
 *                    cross product is combinatorial and buys nothing: the
 *                    blinded adjudication queue exists for outputs this set
 *                    does not contain.
 *
 * CREDIT is derived from the OUTPUT, never asserted alongside it (schema
 * `CREDITS`, split from the judge's `VERDICTS` on 2026-08-20): an output equal
 * to the input is `no-op`, one that applies at least one required-correction
 * group is `required-correction`, and anything else — a benign rewrite of a
 * clean sentence — is `benign-optional`. Deriving it is what keeps the
 * schema's "no-op credit only on an output identical to the input" rule true
 * by construction rather than by remembering to.
 */
export function creditFor(sentence, groups, choice, rewritten) {
  if (normalizeOut(rewritten) === normalizeOut(sentence)) return "no-op";
  const applied = (g) => (g.id in choice ? choice[g.id] : 0) !== null;
  return groups.some((g) => g.requirement === "required-correction" && applied(g))
    ? "required-correction" : "benign-optional";
}

export function acceptableOutputs(sentence, groups) {
  const out = [];
  const seen = new Set();
  const push = (id, choice) => {
    const rewritten = materialize(sentence, groups, choice);
    const k = normalizeOut(rewritten);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ id, rewritten, credit: creditFor(sentence, groups, choice, rewritten) });
  };
  push("primary", {});
  if (groups.some((g) => g.requirement === "benign-optional")) {
    const choice = {};
    for (const g of groups) if (g.requirement === "benign-optional") choice[g.id] = null;
    push("required-only", choice);
  }
  for (const g of groups) {
    for (let i = 1; i < g.alternatives.length; i++) push(`${g.id}-alt${i}`, { [g.id]: i });
  }
  return out;
}

/** The error_type the labeler SUGGESTS for a candidate, per group.
 *  Injection metadata first (it is ground truth about the mechanism), then the
 *  screen tags, then `other-natural`. A suggestion, always overridable. */
export function suggestErrorType(candidate) {
  if (candidate.inject?.error_type) return candidate.inject.error_type;
  const tags = candidate.sampling?.screen_reasons ?? [];
  for (const t of tags) {
    if (TAG_TO_ERROR_TYPE[t]) return TAG_TO_ERROR_TYPE[t];
  }
  return "other-natural";
}

/** The text the correction editor opens with. */
export function prefillFor(candidate) {
  // MECHANICAL seed only: for an injected candidate the clean original is the
  // transform's own inverse, so it is known without consulting anything.
  return candidate.inject?.original ?? candidate.sentence;
}

/**
 * One decision -> one schema record (or a skip).
 * Returns `{ record }`, `{ skipped }`, or `{ error }`.
 */
export function assembleRecord(candidate, decision, opts = {}) {
  const benchmark_version = opts.benchmark_version ?? DEFAULT_BENCHMARK_VERSION;
  if (!decision) return { error: "no decision" };
  if (decision.action === "SKIP") {
    return { skipped: { candidate_id: candidate.candidate_id, reason: decision.skip_reason ?? "unspecified" } };
  }
  if (!["CLEAN", "ERROR", "OPTIONAL"].includes(decision.action)) {
    return { error: `unknown action ${decision.action}` };
  }
  const sentence = candidate.sentence;
  let groups = [], input_status = "CLEAN";
  if (decision.action === "ERROR") {
    input_status = "ERROR";
    if (typeof decision.corrected !== "string" || decision.corrected === sentence) {
      return { error: "ERROR decision with no correction" };
    }
    groups = groupsFromCorrection(sentence, decision.corrected, {
      requirement: "required-correction",
      types: decision.group_types ?? {},
      alternatives: decision.alternatives ?? {},
      defaultType: suggestErrorType(candidate),
    });
    if (!groups.length) return { error: "ERROR decision produced no edit groups" };
    // A group the owner marked optional inside an ERROR item stays in the
    // record but stops being required — that is exactly the distinction D1
    // needs and the flag exists for.
    for (const id of decision.optional_groups ?? []) {
      const g = groups.find((x) => x.id === id);
      if (g) { g.requirement = "benign-optional"; delete g.error_type; }
    }
    if (!groups.some((g) => g.requirement === "required-correction")) {
      return { error: "every group in an ERROR item was marked optional — label it O instead" };
    }
  } else if (decision.action === "OPTIONAL") {
    if (typeof decision.corrected !== "string" || decision.corrected === sentence) {
      return { error: "OPTIONAL decision with no rewrite" };
    }
    groups = groupsFromCorrection(sentence, decision.corrected, {
      requirement: "benign-optional",
      alternatives: decision.alternatives ?? {},
    });
    if (!groups.length) return { error: "OPTIONAL decision produced no edit groups" };
  }

  const acceptable = decision.action === "CLEAN"
    ? [{ id: "noop", rewritten: sentence, credit: "no-op" }]
    : acceptableOutputs(sentence, groups);
  // A CLEAN record must offer the input itself. An OPTIONAL item's groups are
  // all benign, so `required-only` already produces it — but a build where
  // that stops being true must still be valid, not silently missing the entry.
  if (input_status === "CLEAN"
    && !acceptable.some((a) => normalizeOut(a.rewritten) === normalizeOut(sentence))) {
    acceptable.unshift({ id: "noop", rewritten: sentence, credit: "no-op" });
  }

  const record = {
    schema_version: SCHEMA_VERSION,
    benchmark_version,
    uid: candidate.uid,
    sentence,
    context_2500: candidate.context_2500 ?? "",
    split: candidate.split,
    source: { ...candidate.source },
    sampling: { ...candidate.sampling },
    label: {
      input_status,
      borderline: !!decision.borderline,
      edit_groups: groups,
      acceptable_outputs: acceptable,
      labeled_at: decision.at ?? null,
      label_ms: decision.ms ?? null,
      labeler_version: decision.labeler_version ?? LABELER_VERSION,
    },
  };
  if (candidate.inject) {
    record.provenance = {
      mechanism: "injected",
      error_type: candidate.inject.error_type,
      inject_version: candidate.inject.inject_version,
    };
  }
  const problems = validateRecord(record);
  if (problems.length) return { error: problems.join("; "), record };
  return { record };
}

/** Assemble a whole queue. Refuses (returns problems) rather than writing a
 *  file with an invalid record in it. */
export function assembleAll(candidates, decisionMap, opts = {}) {
  const records = [], skipped = [], problems = [];
  for (const c of candidates) {
    const d = decisionMap.get(c.candidate_id);
    if (!d) continue;
    const res = assembleRecord(c, d, opts);
    if (res.skipped) { skipped.push(res.skipped); continue; }
    if (res.error) { problems.push(`${c.candidate_id}: ${res.error}`); continue; }
    records.push(res.record);
  }
  if (records.length) problems.push(...validateFile(records));
  return { records, skipped, problems };
}

// ------------------------------------------------------------------ timing

export function timingStats(msList) {
  const xs = msList.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!xs.length) return { n: 0, median: null, p90: null, pass: false };
  // Nearest-rank percentile (ceil(q*n)), not a linear interpolation: the p90 is
  // a GATE, and the conservative reading is the one that cannot pass a session
  // whose 90th-slowest item was over the line.
  const at = (q) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))];
  const median = xs.length % 2
    ? xs[(xs.length - 1) / 2]
    : Math.round((xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  const p90 = at(0.9);
  return {
    n: xs.length, median, p90,
    pass: median <= PILOT_GATE.medianMs && p90 <= PILOT_GATE.p90Ms,
  };
}

// =====================================================================
// RENDER — pure string, so `--selftest-render` and the test both use it.
// =====================================================================

const CONTEXT_TAIL = 300;

export function renderFrame(candidate, state = {}) {
  const { index = 1, total = 1, expandedContext = false, decided = 0,
    lastMs = null, mode = "decide", buffer = null, cursor = 0,
    groups = null, message = "" } = state;
  const L = [];
  const ctx = candidate.context_2500 ?? "";
  L.push(`── ${candidate.source?.register ?? "?"}  ${index}/${total}  `
    + `decided ${decided}  split=${candidate.split}  frame=${candidate.sampling?.frame}`
    + (lastMs != null ? `  last ${(lastMs / 1000).toFixed(1)}s` : ""));
  if (ctx) {
    const truncated = ctx.length > CONTEXT_TAIL;
    const shown = expandedContext || !truncated ? ctx : ctx.slice(-CONTEXT_TAIL);
    L.push("CONTEXT" + (expandedContext && truncated ? " (full)"
      : truncated ? ` (last ${CONTEXT_TAIL} of ${ctx.length}, Space for all)` : "") + ":");
    for (const line of shown.split("\n").slice(-12)) L.push("  │ " + line);
  } else {
    L.push("CONTEXT: (none)");
  }
  L.push("");
  L.push("SENTENCE:");
  L.push("  " + candidate.sentence);
  const phen = candidate.sampling?.phenomena ?? [];
  const screens = candidate.sampling?.screen_reasons ?? [];
  L.push("");
  L.push(`  phenomena: ${phen.join(", ") || "-"}`
    + (screens.length ? `   screens: ${screens.join(", ")}` : ""));
  if (candidate.inject) {
    L.push(`  INJECTED ${candidate.inject.error_type} (${candidate.inject.inject_version}) `
      + `— editor prefilled with the known original`);
  }
  L.push("");
  if (mode === "edit") {
    L.push("EDIT the sentence into the correction. Enter=commit  Esc=cancel");
    L.push("  > " + buffer);
    L.push("    " + " ".repeat(cursor) + "^");
  } else if (mode === "type") {
    L.push("ERROR TYPE per group — number to set, Enter to accept:");
    (groups ?? []).forEach((g, i) => {
      L.push(`  [${i + 1}] ${JSON.stringify(g.before)} -> `
        + `${JSON.stringify(g.alternatives[0].replacement)}   type=${g.error_type ?? "-"}`);
    });
    L.push("  " + ERROR_TYPES.map((t, i) => `${i + 1}:${t}`).join("  "));
  } else {
    L.push("C clean   E error   O clean+benign-optional   A add alternative");
    L.push("B borderline   Space context   S skip   U undo-last   Q quit");
  }
  if (message) { L.push(""); L.push("» " + message); }
  return L.join("\n");
}

// =====================================================================
// TTY
// =====================================================================

/**
 * Raw-mode byte chunk -> key. Exported for the test, which is the only way to
 * exercise it without a pty: this repo has no dependencies and a pty is one.
 *
 * A bare ESC chunk is Escape; anything longer starting with ESC is a CSI
 * sequence. No disambiguation timer is needed — a terminal delivers a CSI
 * sequence as one chunk.
 */
export function decodeKey(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  if (s === "\u0003") return { name: "ctrl-c" };
  if (s === "\r" || s === "\n") return { name: "enter" };
  if (s === "\u007f" || s === "\b") return { name: "backspace" };
  if (s === "\u0001") return { name: "home" };
  if (s === "\u0005") return { name: "end" };
  if (s === "\u0015") return { name: "clear" };
  if (s === "\u001b") return { name: "escape" };
  if (s === "\u001b[D") return { name: "left" };
  if (s === "\u001b[C") return { name: "right" };
  if (s === "\u001b[H" || s === "\u001b[1~") return { name: "home" };
  if (s === "\u001b[F" || s === "\u001b[4~") return { name: "end" };
  if (s === "\u001b[3~") return { name: "delete" };
  if (s.startsWith("\u001b")) return { name: "unknown" };
  if (s.length === 1 && s.charCodeAt(0) < 0x20) return { name: "unknown" };
  return { name: "char", ch: s };
}

function keyReader() {
  const stdin = process.stdin;
  if (!stdin.isTTY) die("not a TTY — use --assemble, --timing or --selftest-render");
  stdin.setRawMode(true);
  stdin.resume();
  const queue = [], waiters = [];
  stdin.on("data", (buf) => {
    const k = decodeKey(buf);
    if (waiters.length) waiters.shift()(k);
    else queue.push(k);
  });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => waiters.push(res));
    },
    close() { stdin.setRawMode(false); stdin.pause(); },
  };
}

function draw(text) {
  process.stdout.write("\u001b[2J\u001b[H" + text + "\n");
}

async function lineEdit(keys, candidate, state, initial) {
  let buffer = initial, cursor = initial.length;
  for (;;) {
    draw(renderFrame(candidate, { ...state, mode: "edit", buffer, cursor }));
    const k = await keys.next();
    if (k.name === "ctrl-c") return null;
    if (k.name === "escape") return null;
    if (k.name === "enter") return buffer;
    if (k.name === "left") cursor = Math.max(0, cursor - 1);
    else if (k.name === "right") cursor = Math.min(buffer.length, cursor + 1);
    else if (k.name === "home") cursor = 0;
    else if (k.name === "end") cursor = buffer.length;
    else if (k.name === "clear") { buffer = ""; cursor = 0; }
    else if (k.name === "backspace") {
      if (cursor > 0) { buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor); cursor--; }
    } else if (k.name === "delete") {
      buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
    } else if (k.name === "char") {
      buffer = buffer.slice(0, cursor) + k.ch + buffer.slice(cursor);
      cursor += k.ch.length;
    }
  }
}

async function chooseTypes(keys, candidate, state, groups) {
  let sel = 0;
  for (;;) {
    draw(renderFrame(candidate, { ...state, mode: "type", groups,
      message: groups.length > 1 ? `group ${sel + 1}/${groups.length} — Tab/Enter next` : "" }));
    const k = await keys.next();
    if (k.name === "ctrl-c") return null;
    if (k.name === "enter" || k.name === "escape") {
      if (sel + 1 < groups.length && k.name === "enter") { sel++; continue; }
      return groups;
    }
    if (k.name === "char" && /[0-9]/.test(k.ch)) {
      // Two-digit types (10..13) need a second digit; take it if one follows.
      let n = Number(k.ch);
      if (n === 1) {
        const k2 = await keys.next();
        if (k2.name === "char" && /[0-3]/.test(k2.ch)) n = 10 + Number(k2.ch);
      }
      const t = ERROR_TYPES[n - 1];
      if (t) groups[sel].error_type = t;
    }
  }
}

async function labelSession(opts) {
  const candPath = candidatesPath(opts.register);
  if (!existsSync(candPath)) {
    die(`no candidate queue at ${candPath} — run benchmark-sample.mjs --registers ${opts.register}`);
  }
  const candidates = readJsonl(candPath);
  if (!candidates.length) die(`${candPath} is empty`);
  const labelsPath = fileURLToPath(new URL(LABELS_FILE, OUT_DIR));
  mkdirSync(fileURLToPath(OUT_DIR), { recursive: true });
  const decided = foldDecisions(readJsonl(labelsPath));
  const queue = opts.resume
    ? candidates.filter((c) => !decided.has(c.candidate_id))
    : candidates;
  if (!queue.length) die("every candidate in this queue already has a decision "
    + "— nothing to label (drop --resume to re-label)");

  const limit = opts.pilot || queue.length;
  const keys = keyReader();
  const sessionMs = [];
  let lastId = null, lastMs = null, message = "";

  const write = (d) => appendFileSync(labelsPath, JSON.stringify(d) + "\n");

  try {
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      const c = queue[i];
      const state = {
        index: i + 1, total: Math.min(limit, queue.length),
        decided: decided.size, lastMs, expandedContext: false, message,
      };
      message = "";
      const t0 = Date.now();
      let done = false;
      while (!done) {
        draw(renderFrame(c, state));
        const k = await keys.next();
        if (k.name === "ctrl-c") { done = true; i = limit; break; }
        if (k.name !== "char") continue;
        const key = k.ch.toUpperCase();
        if (key === "Q") { i = limit; done = true; break; }
        if (key === " ") { state.expandedContext = !state.expandedContext; continue; }
        if (key === "B") { state.borderline = !state.borderline; state.message = `borderline=${!!state.borderline}`; continue; }
        if (key === "U") {
          if (!lastId) { state.message = "nothing to undo"; continue; }
          write({ candidate_id: lastId, action: "UNDO", at: new Date().toISOString() });
          decided.delete(lastId);
          state.message = `undid ${lastId}`;
          lastId = null;
          continue;
        }
        if (key === "S") {
          const reason = await lineEdit(keys, c, state, "");
          if (reason === null) { state.message = "skip cancelled"; continue; }
          const d = base(c, "SKIP", t0, state);
          d.skip_reason = reason || "unspecified";
          write(d); decided.set(c.candidate_id, d); lastId = c.candidate_id;
          lastMs = d.ms; sessionMs.push(d.ms); done = true; break;
        }
        if (key === "C") {
          const d = base(c, "CLEAN", t0, state);
          write(d); decided.set(c.candidate_id, d); lastId = c.candidate_id;
          lastMs = d.ms; sessionMs.push(d.ms); done = true; break;
        }
        if (key === "E" || key === "O") {
          const corrected = await lineEdit(keys, c, state, prefillFor(c));
          if (corrected === null || corrected === c.sentence) {
            state.message = "no change — not recorded";
            continue;
          }
          const d = base(c, key === "E" ? "ERROR" : "OPTIONAL", t0, state);
          d.corrected = corrected;
          if (key === "E") {
            const groups = groupsFromCorrection(c.sentence, corrected, {
              defaultType: suggestErrorType(c),
            });
            const chosen = await chooseTypes(keys, c, state, groups);
            if (chosen === null) { state.message = "cancelled"; continue; }
            d.group_types = Object.fromEntries(chosen.map((g) => [g.id, g.error_type]));
          }
          write(d); decided.set(c.candidate_id, d); lastId = c.candidate_id;
          lastMs = d.ms; sessionMs.push(d.ms); done = true; break;
        }
        if (key === "A") {
          const d = decided.get(lastId);
          if (!d || !d.corrected) {
            state.message = "A adds an alternative to the LAST error/optional item";
            continue;
          }
          const cand = candidates.find((x) => x.candidate_id === lastId);
          const alt = await lineEdit(keys, cand, state, d.corrected);
          if (alt === null || alt === d.corrected) { state.message = "no alternative added"; continue; }
          // An alternative is a different acceptable replacement for a span the
          // primary correction ALREADY names. Matching on the exact span rather
          // than on group order is what keeps a stored alternative attached to
          // the right group when a later re-fold recomputes the diff.
          const primary = groupsFromCorrection(cand.sentence, d.corrected, {});
          const altGroups = editGroups(cand.sentence, alt);
          const spanKey = (s, e) => s + ":" + e;
          const bySpan = new Map(primary.map((g) => [spanKey(g.start_utf16, g.end_utf16), g]));
          const added = [];
          for (const ag of altGroups) {
            const g = bySpan.get(spanKey(ag.srcSpan[0], ag.srcSpan[1]));
            if (!g) continue;
            if (ag.after === g.alternatives[0].replacement) continue;
            added.push([g.id, ag.after]);
          }
          if (!added.length) {
            state.message = "an alternative must differ INSIDE a span the "
              + "correction already edits — nothing attached";
            continue;
          }
          const updated = { ...d, alternatives: { ...(d.alternatives ?? {}) } };
          for (const [gid, text] of added) {
            updated.alternatives[gid] = [...(updated.alternatives[gid] ?? []), text];
          }
          updated.at = new Date().toISOString();
          write(updated); decided.set(lastId, updated);
          state.message = `alternative added to ${added.map(([g]) => g).join(", ")}`;
          continue;
        }
      }
    }
  } finally {
    keys.close();
  }

  draw("");
  const stats = timingStats(sessionMs);
  console.log(`session: ${sessionMs.length} decisions`);
  if (stats.n) {
    console.log(`  median ${(stats.median / 1000).toFixed(1)}s   p90 ${(stats.p90 / 1000).toFixed(1)}s`);
    if (opts.pilot) printGate(stats);
  }
  console.log(`labels: ${labelsPath}`);
}

function base(candidate, action, t0, state) {
  return {
    candidate_id: candidate.candidate_id,
    uid: candidate.uid,
    action,
    borderline: !!state.borderline,
    ms: Date.now() - t0,
    at: new Date().toISOString(),
    labeler_version: LABELER_VERSION,
  };
}

function printGate(stats) {
  const okMed = stats.median <= PILOT_GATE.medianMs;
  const okP90 = stats.p90 <= PILOT_GATE.p90Ms;
  console.log(`\nPILOT GATE (n=${stats.n}, target n=${PILOT_GATE.n})`);
  console.log(`  median ${(stats.median / 1000).toFixed(1)}s <= 15s  ${okMed ? "PASS" : "FAIL"}`);
  console.log(`  p90    ${(stats.p90 / 1000).toFixed(1)}s <= 45s  ${okP90 ? "PASS" : "FAIL"}`);
  if (stats.n < PILOT_GATE.n) {
    console.log(`  VERDICT: INCONCLUSIVE — ${stats.n} of ${PILOT_GATE.n} items`);
  } else {
    console.log(`  VERDICT: ${okMed && okP90 ? "PASS" : "FAIL — redesign the flow before labeling the rest"}`);
  }
}

// =====================================================================
// PATHS + SUBCOMMANDS
// =====================================================================

const candidatesPath = (register) =>
  fileURLToPath(new URL(`benchmark-candidates-${register}.jsonl`, OUT_DIR));

function runAssemble(opts) {
  const candPath = candidatesPath(opts.register);
  if (!existsSync(candPath)) die(`no candidate queue at ${candPath}`);
  const candidates = readJsonl(candPath);
  const labelsPath = fileURLToPath(new URL(LABELS_FILE, OUT_DIR));
  const decisions = foldDecisions(readJsonl(labelsPath));
  if (!decisions.size) die(`${labelsPath} holds no decisions — nothing to assemble`);
  const { records, skipped, problems } =
    assembleAll(candidates, decisions, { benchmark_version: opts.benchmarkVersion });
  console.log(`assembled ${records.length} records, ${skipped.length} skipped, `
    + `${problems.length} problems`);
  for (const p of problems.slice(0, 40)) console.log("  PROBLEM " + p);
  if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
  if (problems.length) die("refusing to write a benchmark file with invalid records");
  if (!records.length) die("0 valid records — refusing to write an empty benchmark");
  const outPath = fileURLToPath(new URL(`benchmark-${opts.register}.jsonl`, OUT_DIR));
  writeFileSync(outPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${outPath}`);
  if (skipped.length) {
    const sp = fileURLToPath(new URL(`benchmark-skipped-${opts.register}.json`, OUT_DIR));
    writeFileSync(sp, JSON.stringify(skipped, null, 2) + "\n");
    console.log(`wrote ${sp} (${skipped.length} quarantined)`);
  }
  const stats = timingStats([...decisions.values()].map((d) => d.ms));
  if (stats.n) {
    console.log(`labeling time: n=${stats.n} median ${(stats.median / 1000).toFixed(1)}s `
      + `p90 ${(stats.p90 / 1000).toFixed(1)}s`);
  }
}

function runTiming() {
  const labelsPath = fileURLToPath(new URL(LABELS_FILE, OUT_DIR));
  const decisions = foldDecisions(readJsonl(labelsPath));
  if (!decisions.size) die(`${labelsPath} holds no decisions — nothing to time`);
  const stats = timingStats([...decisions.values()].map((d) => d.ms));
  printGate(stats);
}

function runSelftestRender(opts) {
  // Deliberately SYNTHETIC, not the first real candidate: a render self-check
  // must not depend on an artifact existing, must be byte-stable between runs,
  // and must not print the owner's own text to a terminal that may be shared.
  const c = {
    candidate_id: "demo:0", uid: "sha256:demo",
    sentence: "The techncian arrived early.",
    context_2500: "sure, go ahead\nlet me know when it lands",
    split: "dev",
    source: { corpus: "demo", register: opts.register,
      source_document_id: "0", exclusion_group_id: "demo#0" },
    sampling: { frame: "natural-screen", primary_phenomenon: "ordinary",
      phenomena: ["ordinary"], screen_reasons: ["uniqueDamerau1"] },
    inject: null,
  };
  console.log(renderFrame(c, { index: 1, total: 480, decided: 0, lastMs: 8200 }));
  console.log("\n--- edit mode ---");
  console.log(renderFrame(c, { index: 1, total: 480, mode: "edit",
    buffer: prefillFor(c), cursor: 8 }));
  console.log("\n--- type mode ---");
  console.log(renderFrame(c, { index: 1, total: 480, mode: "type",
    groups: groupsFromCorrection(c.sentence, "The technician arrived early.",
      { defaultType: suggestErrorType(c) }) }));
}

function main(argv) {
  const opts = {
    register: null, resume: false, pilot: 0, assemble: false, timing: false,
    selftestRender: false, benchmarkVersion: DEFAULT_BENCHMARK_VERSION,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--register") opts.register = argv[++i];
    else if (a === "--resume") opts.resume = true;
    else if (a === "--pilot") {
      const v = argv[i + 1];
      if (v && /^\d+$/.test(v)) { opts.pilot = Number(v); i++; }
      else opts.pilot = PILOT_GATE.n;
    } else if (a === "--assemble") opts.assemble = true;
    else if (a === "--timing") opts.timing = true;
    else if (a === "--selftest-render") opts.selftestRender = true;
    else if (a === "--benchmark-version") opts.benchmarkVersion = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("node test/finetune/label-benchmark.mjs --register <r> "
        + "[--resume] [--pilot N] [--assemble] [--timing] [--selftest-render]");
      return;
    } else die(`unknown argument ${a}`);
  }
  if (opts.timing) return runTiming();
  if (!opts.register) die("--register is required");
  // A pseudo-register (e.g. "validation", the machine-benchmark owner draw) is
  // any candidates file that exists without being one of the four schema
  // registers. Its rows keep their TRUE source.register, so schema validation
  // is untouched; only queue-file resolution accepts the extra name.
  if (!REGISTERS.includes(opts.register) && !existsSync(candidatesPath(opts.register))) {
    die(`unknown register ${opts.register}`);
  }
  if (opts.selftestRender) return runSelftestRender(opts);
  if (opts.assemble) return runAssemble(opts);
  return labelSession(opts);
}

const invokedDirectly = process.argv[1]
  && existsSync(process.argv[1])
  && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main(process.argv.slice(2));
