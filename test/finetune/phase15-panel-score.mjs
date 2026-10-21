#!/usr/bin/env node
// Phase 1.5 clean safety panel: discordance extraction and paired bounds
// (plan gate battery §2 — the instrument that protects the 2.6/1k crown jewel).
//
//   node phase15-panel-score.mjs --a <run-finalist.jsonl> --b <run-v1.jsonl>
//        [--adjudications <verdicts.jsonl>] [--reps 4000] [--seed 7]
//
// Both runs are teacher-pass outputs over phase15-panel.jsonl. An EDIT is
// guard-applied output differing from the input. Identical edits by both
// models cancel in every paired delta and are not adjudicated (counted,
// reported). Discordant edits — one model edits and the other does not, or
// they edit differently — go to phase15-panel-adjq.jsonl for verdicts in
// {required-correction, benign-optional, unnecessary, meaning-damage,
// uncertain}, one verdict PER MODEL EDIT (uid + side).
//
// With --adjudications, computes the gate: one-sided 95% upper bound
// (document-cluster bootstrap) on finalist-minus-v1 unnecessary edits and
// meaning damage per 1k panel rows. `uncertain` counts as the worse class for
// the finalist and the better for v1 — the bound must not be rescued by
// unresolved verdicts.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { mulberry32, argOf, fail } from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const A = argOf("--a") ?? fail("--a required (finalist run)");
const B = argOf("--b") ?? fail("--b required (v1 baseline run)");
const ADJ = argOf("--adjudications");
const REPS = Number(argOf("--reps") ?? 4000);
const SEED = Number(argOf("--seed") ?? 7);

const readJsonl = (p) => {
  if (!fs.existsSync(p)) fail(`missing ${p}`);
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
};
const panel = readJsonl(path.join(ART, "phase15-panel.jsonl"));
const norm = (s) => String(s ?? "").trim();
const editOf = (runRows) => {
  const m = new Map();
  for (const r of runRows) {
    const edited = !r.error && !r.malformed && r.guard === "applied"
      && r.rewritten != null && norm(r.rewritten) !== norm(r.sentence);
    m.set(r.uid, edited ? norm(r.rewritten) : null);
  }
  return m;
};
const a = editOf(readJsonl(path.resolve(A)));
const b = editOf(readJsonl(path.resolve(B)));

let identical = 0, aOnly = 0, bOnly = 0, differ = 0, neither = 0;
const queue = [];
for (const row of panel) {
  const ea = a.get(row.uid) ?? null, eb = b.get(row.uid) ?? null;
  if (ea === null && eb === null) { neither++; continue; }
  if (ea !== null && eb !== null && ea === eb) { identical++; continue; }
  if (ea !== null && eb === null) aOnly++;
  else if (ea === null && eb !== null) bOnly++;
  else differ++;
  queue.push({ uid: row.uid, sentence: row.sentence, context: row.context, shape: row.shape,
    register: row.register, a_edit: ea, b_edit: eb });
}
console.log(`panel ${panel.length}: neither ${neither}, identical-edit ${identical} (cancel), a-only ${aOnly}, b-only ${bOnly}, differ ${differ}`);
console.log(`discordant rows needing verdicts: ${queue.length}`);

if (!ADJ) {
  fs.writeFileSync(path.join(ART, "phase15-panel-adjq.jsonl"),
    queue.map((r) => JSON.stringify(r)).join("\n") + (queue.length ? "\n" : ""), { mode: 0o600 });
  console.log("wrote phase15-panel-adjq.jsonl — adjudicate (verdict per side: {uid, side: \"a\"|\"b\", verdict}), then re-run with --adjudications");
  process.exit(0);
}

// ---------------------------------------------------------- bounds with verdicts
const verd = new Map(); // `${uid}\0${side}` -> verdict
for (const r of readJsonl(path.resolve(ADJ))) verd.set(`${r.uid}\0${r.side}`, r.verdict);
const classOf = (uid, side, pessimisticFor) => {
  const v = verd.get(`${uid}\0${side}`);
  if (!v) fail(`missing verdict for ${uid} side ${side}`);
  if (v !== "uncertain") return v;
  // uncertain resolves against the finalist (side a) and for the baseline.
  return side === pessimisticFor ? "meaning-damage" : "required-correction";
};
const events = []; // per row: {docKey, unnA, unnB, dmgA, dmgB}
const byDoc = new Map();
for (const row of panel) {
  const ea = a.get(row.uid) ?? null, eb = b.get(row.uid) ?? null;
  const e = { unnA: 0, unnB: 0, dmgA: 0, dmgB: 0 };
  if (!(ea === null && eb === null) && !(ea !== null && ea === eb)) {
    if (ea !== null) {
      const c = classOf(row.uid, "a", "a");
      if (c === "unnecessary") e.unnA = 1;
      if (c === "meaning-damage") e.dmgA = 1;
    }
    if (eb !== null) {
      const c = classOf(row.uid, "b", "a");
      if (c === "unnecessary") e.unnB = 1;
      if (c === "meaning-damage") e.dmgB = 1;
    }
  }
  const d = row.source_document_id;
  if (!byDoc.has(d)) byDoc.set(d, []);
  byDoc.get(d).push(e);
  events.push(e);
}
const docs = [...byDoc.values()];
const rng = mulberry32(SEED);
const upper = (pick) => {
  const deltas = [];
  for (let i = 0; i < REPS; i++) {
    let dA = 0, dB = 0, n = 0;
    for (let k = 0; k < docs.length; k++) {
      const grp = docs[Math.floor(rng() * docs.length)];
      for (const e of grp) { n++; dA += pick(e, "A"); dB += pick(e, "B"); }
    }
    deltas.push(1000 * (dA - dB) / n);
  }
  deltas.sort((x, y) => x - y);
  return { point: +(1000 * (events.reduce((s, e) => s + pick(e, "A"), 0) - events.reduce((s, e) => s + pick(e, "B"), 0)) / events.length).toFixed(3),
    upper95: +deltas[Math.floor(REPS * 0.95)].toFixed(3) };
};
const unn = upper((e, side) => side === "A" ? e.unnA : e.unnB);
const dmg = upper((e, side) => side === "A" ? e.dmgA : e.dmgB);
const gate = { unnecessary_delta_per1k: unn, damage_delta_per1k: dmg,
  gates: { unnecessary: unn.upper95 <= 1.0, damage: dmg.upper95 <= 0.5 } };
console.log(JSON.stringify(gate, null, 2));
fs.writeFileSync(path.join(ART, "phase15-panel-gate.json"), JSON.stringify({
  a: path.basename(A), b: path.basename(B), ...gate,
}, null, 2) + "\n", { mode: 0o600 });
console.log(`GATE unnecessary (≤ +1.0/1k): ${gate.gates.unnecessary ? "PASS" : "FAIL"}; damage (≤ +0.5/1k): ${gate.gates.damage ? "PASS" : "FAIL"}`);
