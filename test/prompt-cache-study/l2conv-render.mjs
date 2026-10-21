#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Renders the pilot training dataset into the L2-conv
// prompt layout for the 2026-10-02 L2-conv training trial
// (optional research; see TESTING.md §29).
//
// Every prompt is built by the SAME function E4 serves the layout with --
// layoutMessages("L2-conv", ...) in layouts.mjs, whose instruction text and
// page line are read out of the shipping background.js -- over the SAME
// context policy e4-bench.mjs applies (l3ContextFor: the 500-character jump
// window, then the shipping segmenter's sentences, one user turn each). So
// what the model is trained on and what e4-bench.mjs sends it are the same
// bytes by construction; l2conv-render-check.mjs asserts it on a sample.
//
// The assistant turn is NOT rendered here: trial-train.py appends it with the
// pilot's own json.dumps({"rewritten": target}, ensure_ascii=False), so the
// answer format is byte-identical to the control arm's.
//
// Output (PRIVATE -- the dataset is the owner's text): one JSON row per
// dataset row, {uid, split, kind, register, messages, target, window_chars,
// n_ctx}, mode 0600, plus a counts-only manifest.
//
//   node l2conv-render.mjs --dataset <pilot-dataset.jsonl> --out <rendered.jsonl> [--host discord.com]

import { readFileSync, writeFileSync, chmodSync } from "fs";
import { createHash } from "crypto";
import { pathToFileURL } from "url";
import { layoutMessages, PIECES, buildContextLine } from "./layouts.mjs";
import { l3ContextFor, sentencesOf } from "./context-policy.mjs";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const DATASET = arg("--dataset"), OUT = arg("--out");
const ENTRY = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// One host for every row: the benchmark (e4-bench.mjs) serves every item as
// discord.com, so training on that line makes the served fixed part exactly
// the trained one. A production retrain should vary it (recorded as a limit).
export const HOST = arg("--host", "discord.com");
if (ENTRY && (!DATASET || !OUT)) { console.error("usage: --dataset <jsonl> --out <jsonl>"); process.exit(2); }

export function renderRow(row, host = HOST) {
  const win = l3ContextFor(row.context || "");
  const sents = sentencesOf(win);
  const messages = layoutMessages("L2-conv", { sentence: row.input, contextSentences: sents, pageContext: { hostname: host } });
  return { uid: row.uid, split: row.card.split, kind: row.kind, register: row.register,
    messages, target: row.target, window_chars: win.length, n_ctx: sents.length };
}

if (ENTRY) main();
function main() {
const rows = readFileSync(DATASET, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const out = [];
const counts = { rows: 0, split: {}, with_context: 0, n_ctx_hist: {}, window_trimmed: 0, roles_ok: 0 };
for (const r of rows) {
  const x = renderRow(r);
  counts.rows++;
  counts.split[x.split] = (counts.split[x.split] || 0) + 1;
  if (x.n_ctx) counts.with_context++;
  counts.n_ctx_hist[x.n_ctx] = (counts.n_ctx_hist[x.n_ctx] || 0) + 1;
  if ((r.context || "").trim().length > x.window_chars) counts.window_trimmed++;   // a real jump, not the trim
  const roles = x.messages.map((m) => m.role).join(",");
  if (roles === ["system", "system", ...Array(x.n_ctx).fill("user"), "user"].join(",")) counts.roles_ok++;
  if (x.messages[x.messages.length - 1].content !== r.input) throw new Error(`last user turn is not the input (${r.uid})`);
  out.push(JSON.stringify(x));
}
if (counts.roles_ok !== counts.rows) throw new Error("some rows did not render as system,system,user*,user");
writeFileSync(OUT, out.join("\n") + "\n", { mode: 0o600 });
chmodSync(OUT, 0o600);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const manifest = { dataset: DATASET, host: HOST, counts,
  instr_sha256: sha(PIECES.INSTR), instr_chars: PIECES.INSTR.length,
  host_line: buildContextLine({ hostname: HOST }), host_line_sha256: sha(buildContextLine({ hostname: HOST })) };
writeFileSync(OUT + ".manifest.json", JSON.stringify(manifest, null, 1) + "\n", { mode: 0o600 });
console.log(JSON.stringify(manifest, null, 1));
}
