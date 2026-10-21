#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. One-off, documented relabel of archived E3 rows
// (run once, 2026-09-25, after GPT-6 Astra checkpoint 2).
//
// The first E3 "switch" protocol primed with document A's first sentence and
// then SENT IT AGAIN as its first measured request. That identical re-send
// evicts the -post layouts' last-user-message checkpoint (report §3), so those
// rows describe a different sequence -- A1, A1, B1, A2, B2, ... -- from an
// ordinary switch. This script renames them `switch-replay` and flags the
// replayed request `replayOfPrime: true`; e3-typing.mjs --scenarios
// switch-replay reproduces exactly that protocol under that name, and its
// `switch` now primes with A1 and measures from B1.
//
// Only rows written before CUTOFF are touched (every row of the first
// protocol; the corrected protocol's rows are appended after it). The
// original file is kept byte for byte as <file>.pre-relabel.
//
//   node relabel-switch-replay.mjs <e3-cpu4.jsonl>

import { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync } from "fs";
import { createHash } from "crypto";

const CUTOFF = "2026-09-25T14:25:00Z";
const file = process.argv[2];
if (!file) { console.error("usage: relabel-switch-replay.mjs <e3-cpu4.jsonl>"); process.exit(2); }
const backup = `${file}.pre-relabel`;
if (existsSync(backup)) { console.error(`${backup} exists: already relabelled`); process.exit(1); }
const text = readFileSync(file, "utf8");
const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
let relabelled = 0, flagged = 0;
for (const r of rows) {
  if (r.scenario !== "switch" || r.ts >= CUTOFF) continue;
  r.scenario = "switch-replay";
  relabelled++;
  // A is email 0 or 1 in the two pairs (0,10) and (1,11); its k=0 request
  // repeated the prime
  if (r.k === 0 && (r.email === 0 || r.email === 1)) { r.replayOfPrime = true; flagged++; }
}
copyFileSync(file, backup);
chmodSync(backup, 0o600);
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
console.log(`relabelled ${relabelled} rows switch -> switch-replay, flagged ${flagged} replayOfPrime; ` +
  `backup ${backup} sha256:${sha(backup)}, new sha256:${sha(file)}`);
