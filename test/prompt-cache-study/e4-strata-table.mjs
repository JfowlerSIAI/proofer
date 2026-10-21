#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Prints the E4 per-stratum table (numbers only) from
// <RAW>/e4-summary.json written by analyze-e4.mjs, with the pending-aware
// bounds on the ERROR-stratum paired test.
//   node e4-strata-table.mjs
import { readFileSync } from "fs";
const { RAW } = await import("./paths.mjs");
const S = JSON.parse(readFileSync(`${RAW}/e4-summary.json`, "utf8"));
const pc = (x, n) => (100 * x / n).toFixed(1);
function mcnemar(b, c) { const n = b + c; if (!n) return 1; const k = Math.min(b, c); let p = 0, coef = 1; for (let i = 0; i <= n; i++) { if (i > 0) coef = coef * (n - i + 1) / i; if (i <= k) p += coef; } return Math.min(1, 2 * p / 2 ** n); }
const fp = (p) => (p < 0.001 ? p.toExponential(0) : p.toFixed(p < 0.01 ? 3 : 2));

console.log("\nCLEAN stratum (no adjudication involved): layout vs L0, discordant records (layout only / L0 only), exact McNemar p\n");
console.log("| layout | model edited | edit reached the field | answers reciting a demonstration |");
console.log("|---|---|---|---:|");
let first = true;
for (const [L, v] of Object.entries(S.layouts)) {
  const c = v.strata.clean;
  if (first) { console.log(`| L0 (reference) | ${pc(c.editB, c.n)}% | ${pc(c.landB, c.n)}% | ${v.strata.recitedB} |`); first = false; }
  console.log(`| ${L} | ${pc(c.editA, c.n)}% (${c.e10}/${c.e01}, p ${fp(mcnemar(c.e10, c.e01))}) | ${pc(c.landA, c.n)}% (${c.l10}/${c.l01}, p ${fp(mcnemar(c.l10, c.l01))}) | ${v.strata.recitedA} |`);
}

console.log("\nERROR stratum: a fix reached the field. Worst = the layout's unjudged outputs not safe and L0's safe; best = the reverse (identical unjudged outputs kept paired)\n");
console.log("| layout | unjudged (layout / L0) | worst: rate, discordant, p | best: rate, discordant, p | reading | missed / refused / malformed |");
console.log("|---|---|---|---|---|---|");
first = true;
for (const [L, v] of Object.entries(S.layouts)) {
  const e = v.strata.error;
  if (first) { console.log(`| L0 (reference) | ${e.pendB} | ${pc(e.safeB, e.n)}% (unjudged not safe) – ${pc(e.safeB + e.pendB, e.n)}% (safe) | | | ${pc(e.missedB, e.n)} / ${pc(e.refusedB, e.n)} / ${pc(e.malB, e.n)}% |`); first = false; }
  console.log(`| ${L} | ${e.pendA} / ${e.pendB} | ${pc(e.wSafeA, e.n)}% vs ${pc(e.wSafeB, e.n)}% (${e.w10}/${e.w01}, p ${fp(e.pWorst)}) | ` +
    `${pc(e.bSafeA, e.n)}% vs ${pc(e.bSafeB, e.n)}% (${e.b10}/${e.b01}, p ${fp(e.pBest)}) | ${e.verdict} | ${pc(e.missedA, e.n)} / ${pc(e.refusedA, e.n)} / ${pc(e.malA, e.n)}% |`);
}
console.log(`\nCLEAN n = ${Object.values(S.layouts)[0].strata.clean.n}, ERROR n = ${Object.values(S.layouts)[0].strata.error.n}`);
