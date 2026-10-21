#!/usr/bin/env node
// Where does a window help, if it helps anywhere?
//
// The pooled table can hide an effect that is real but confined: the case for a
// window is strongest for a SHORT sentence and for one that is not the first in
// its message, because those are the sentences the model has to correct with
// the least to go on. This splits every outcome on both axes.
//
//   node sentence-window-strata.mjs k1 k2a k3a

import { readFileSync, existsSync } from "fs";
import { buildMessages } from "./sentence-window-test.mjs";
import { compileLabels, classifyEdit } from "./sentence-owner-bench.mjs";

const DIR = process.env.PROOFER_CORPUS_DIR || new URL("./harvested/", import.meta.url).pathname;
const CORPORA = (process.env.PROOFER_WINDOW_CORPORA || "error-holdout,random-holdout,dev-corpus").split(",");
const tags = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const band = (n) => (n < 40 ? "<40" : n < 80 ? "40-79" : n < 140 ? "80-139" : ">=140");
const BANDS = ["<40", "40-79", "80-139", ">=140"];

function collect(tag) {
  const cells = new Map();
  const bump = (key, field) => {
    if (!cells.has(key)) cells.set(key, { n: 0, err: 0, fix: 0, dmg: 0, style: 0, gram: 0, touched: 0 });
    cells.get(key)[field]++;
  };
  for (const name of CORPORA) {
    const f = `${DIR}window-${name}-${tag}.jsonl`;
    if (!existsSync(f)) continue;
    const corpus = JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8"));
    const labels = compileLabels(JSON.parse(readFileSync(`${DIR}labels-${name}.json`, "utf8")));
    const msgs = new Map(buildMessages(corpus).messages.map((m) => [m.message_id, m]));
    for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
      const run = JSON.parse(line);
      const msg = msgs.get(run.message_id);
      if (!msg) continue;
      for (let k = 0; k < msg.items.length; k++) {
        const src = msg.items[k].sentence.trim();
        const fin = String(run.final[k]).trim();
        const L = labels.get(msg.items[k].uid);
        for (const key of [`len ${band(src.length)}`, k === 0 ? "pos first" : "pos later"]) {
          bump(key, "n");
          if (fin !== src) bump(key, "touched");
          if (L && L.cls === "ERROR") {
            bump(key, "err");
            if (L.fix.test(fin)) bump(key, "fix");
          } else if (fin !== src) {
            const c = classifyEdit(src, fin);
            if (c.kind === "meaning") bump(key, "dmg");
            else if (c.kind === "style") bump(key, "style");
            else bump(key, "gram");
          }
        }
      }
    }
  }
  return cells;
}

const all = tags.map((t) => [t, collect(t)]);
const keys = [...BANDS.map((b) => `len ${b}`), "pos first", "pos later"];
const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

console.log(pad("stratum", 12) + rp("n", 5) + tags.map((t) => rp(t + " fix", 12) + rp("dmg", 5) + rp("style", 6)).join(""));
for (const key of keys) {
  const first = all[0][1].get(key);
  if (!first) continue;
  let line = pad(key, 12) + rp(first.n, 5);
  for (const [, cells] of all) {
    const c = cells.get(key) || { err: 0, fix: 0, dmg: 0, style: 0 };
    line += rp(`${c.fix}/${c.err}`, 12) + rp(c.dmg, 5) + rp(c.style, 6);
  }
  console.log(line);
}
console.log("\nfix here is FIXED-in-final (collateral not deducted), so it reads slightly higher than fixSafe");
