#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Summarises E1, E2 and E3 of the prompt-cache study
// from the raw rows in <RAW> into markdown tables (numbers only -- no text from
// the corpora) and <RAW>/e123-summary.json.
//
//   node analyze.mjs [--raw <dir>] [--only e1,e2,e3]

import { readFileSync, existsSync, writeFileSync } from "fs";

const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const { RAW: RAW_DEFAULT } = await import("./paths.mjs");
const RAW = arg("--raw", RAW_DEFAULT);
const ONLY = arg("--only", "e1,e2,e3").split(",");
const read = (f) => existsSync(`${RAW}/${f}`) ? readFileSync(`${RAW}/${f}`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const q = (xs, p) => { const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const med = (xs) => { const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r0 = (x) => (x == null ? "-" : Math.round(x));
const summary = {};

// ------------------------------------------------------------------ E1
if (ONLY.includes("e1")) {
  for (const rt of ["ollama", "llama"]) {
    // e1b-*: the scenarios added after E3 (L2-conv, new document);
    // e1c-*: the identical-re-send (replay) set added after checkpoint 2
    const rows = [...read(`e1-${rt}-cpu.jsonl`), ...read(`e1b-${rt}-cpu.jsonl`), ...read(`e1c-${rt}-cpu.jsonl`)];
    if (!rows.length) continue;
    console.log(`\n### E1 (${rt === "ollama" ? "Ollama 0.32.12" : "standalone llama-server"}, CPU)\n`);
    console.log("| scenario (A then B) | B prompt tokens | first differing token | checkpoints A left | B resumed from | B reused | B evaluated | API prompt count | render = runtime |");
    console.log("|---|---:|---:|---|---|---:|---:|---:|---|");
    for (const r of rows) {
      const b = r.b;
      const api = b.api?.prompt_eval_count ?? (b.api?.prompt_n != null ? `${b.api.prompt_n} (cache_n ${b.api.cache_n})` : "-");
      console.log(`| ${r.scenario} | ${b.nTokens} | ${r.renderedDivergenceToken} | ${r.a.checkpoints.join(", ")} | ` +
        `${b.restored ? "checkpoint @" + b.restored.nTokens : b.forcedFull ? "none (full re-read)" : "-"} | ${b.reused} | ${b.evaluated} | ${api} | ` +
        `${r.renderCountsMatchLog && r.debugMatchesRender !== false ? "yes" : "NO"} |`);
    }
    summary[`e1-${rt}`] = rows.map((r) => ({ scenario: r.scenario, n: r.b.nTokens, div: r.renderedDivergenceToken, divChar: r.tokenHoldingFirstDifferentChar, ckA: r.a.checkpoints, restored: r.b.restored?.nTokens ?? null, reused: r.b.reused, evaluated: r.b.evaluated, api: r.b.api, ok: r.renderCountsMatchLog && r.debugMatchesRender !== false }));
    // the replay set: what each request did to the checkpoints
    const rep = rows.filter((r) => r.set === "replay");
    if (rep.length) {
      console.log(`\n#### E1 replay set (${rt}): checkpoints created and evicted per request\n`);
      console.log("| scenario | 1st A: created | 2nd A (identical): resumed from / evaluated | 2nd A: evicted as too close | 2nd A: created | B resumed from | B evaluated |");
      console.log("|---|---|---|---|---|---|---:|");
      for (const r of rep) {
        const p = r.pre[0];
        const first = p || { created: r.a.checkpoints };
        console.log(`| ${r.scenario} | ${first.created.join(", ")} | ${p ? `${r.a.restored ?? "none"} / ${r.a.evaluated}` : "(no replay)"} | ` +
          `${p ? r.a.erasedTooClose.join(", ") || "-" : "-"} | ${p ? r.a.checkpoints.join(", ") : "-"} | ` +
          `${r.b.restored ? r.b.restored.nTokens : r.b.forcedFull ? "none" : "-"} | ${r.b.evaluated} |`);
      }
    }
  }
}

// ------------------------------------------------------------------ E2
if (ONLY.includes("e2")) {
  for (const rt of ["ollama", "llama", "llama-minstep0"]) {
    const rows = read(`e2-${rt === "llama-minstep0" ? "llama-cpu-minstep0" : rt + "-cpu"}.jsonl`);
    if (!rows.length) continue;
    // protocol audit: every prime must have read the whole baseline (a runner
    // that kept ANY state from the previous point -- which primed the same
    // baseline -- would have reused part of it), every mutation must be a
    // verified single-token change, and reused + evaluated must be n.
    const fresh = rows.filter((r) => r.primeReused === 0 && r.primeEvaluated === r.n).length;
    const verified = rows.filter((r) => r.verified).length;
    const sums = rows.filter((r) => r.reused + r.evaluated === r.n).length;
    const dbg = rows.filter((r) => r.debugMatches === true).length;
    console.log(`\nE2 ${rt}: ${rows.length} points; primes that read the whole baseline ${fresh}/${rows.length}; ` +
      `verified single-token changes ${verified}/${rows.length}; reused + evaluated = n ${sums}/${rows.length}; ` +
      `runtime's mismatch ids agree with the study's rendering ${dbg}/${rows.length}; RAM-cache loads ${rows.filter((r) => r.ramCacheHit).length}`);
    const byP = new Map();
    for (const r of rows) { if (!byP.has(r.prompt)) byP.set(r.prompt, []); byP.get(r.prompt).push(r); }
    for (const [p, rs] of byP) {
      const n = rs[0].n;
      console.log(`\n### E2 ${p} (${rt}): ${rs[0].desc}; n = ${n}; user-message starts ${rs[0].userStarts.join(", ")}; checkpoints the primed baseline holds: ${rs[0].primeCheckpoints.join(", ")}\n`);
      console.log("| point | changed token | % of prompt | reused | evaluated | resumed from | verified single-token change | runtime ids agree |");
      console.log("|---|---:|---:|---:|---:|---|---|---|");
      for (const r of [...rs].sort((a, b) => a.index - b.index)) {
        console.log(`| ${r.kind === "point" ? (100 * r.targetFrac).toFixed(0) + "%" : r.kind.replace("control-", "control: ")} | ${r.index} | ${(100 * r.frac).toFixed(1)} | ${r.reused} | ${r.evaluated} | ` +
          `${r.restored ? "checkpoint @" + r.restored.nTokens : r.forcedFull ? "none" : "-"} | ${r.verified ? "yes" : "no"} | ${r.debugMatches === null ? "-" : r.debugMatches ? "yes" : "NO"} |`);
      }
      summary[`e2-${rt}-${p}`] = rs.map((r) => ({ kind: r.kind, index: r.index, frac: r.frac, reused: r.reused, evaluated: r.evaluated, restored: r.restored?.nTokens ?? null, verified: r.verified, dbg: r.debugMatches, ckpts: r.primeCheckpoints, n: r.n }));
    }
  }
}

// ------------------------------------------------------------------ E3
if (ONLY.includes("e3")) {
  // every run of a backend appends to e3-<b>.jsonl (the cpu4 L2-conv run and
  // the second-pass switch/retry runs included)
  const files = ["cpu4", "cpu8", "igpu"].map((b) => [b, read(`e3-${b}.jsonl`)]).filter(([, r]) => r.length);
  const order = ["L0", "L1p-sys", "L1a-sys", "L2-sys", "L3-sys", "L1p-post", "L1a-post", "L2-post", "L3-post", "L4-conv", "L2-conv"];
  for (const [backend, rows] of files) {
    // this backend's decode speed and fixed overhead, from L0 rows (normal-length outputs)
    const l0 = rows.filter((r) => r.layout === "L0" && r.decoded >= 5 && r.decodeMs);
    const msPerTok = med(l0.map((r) => r.decodeMs / r.decoded));
    const overhead = med(rows.filter((r) => r.promptMs != null && r.decodeMs != null).map((r) => r.wallMs - r.promptMs - r.decodeMs));
    const proj = (r) => r.promptMs + r.expectedAnswerTokens * msPerTok + overhead;
    const la = rows.map((r) => r.loadavg[0]);
    console.log(`\n### E3 ${backend}: decode ${msPerTok?.toFixed(1)} ms/token (L0 median), fixed overhead ${r0(overhead)} ms; ` +
      `1-min load average during the run: median ${med(la)?.toFixed(1)}, p90 ${q(la, 0.9)?.toFixed(1)}, max ${Math.max(...la).toFixed(1)}\n`);
    summary[`e3-${backend}`] = { msPerTok, overhead, loadavg: { median: med(la), p90: q(la, 0.9), max: Math.max(...la) }, scenarios: {} };
    for (const scen of ["main", "cold", "switch", "switch-replay", "retry", "retry-seq", "rollover"]) {
      // switch-replay's replayed request (an identical re-send of the prime)
      // is left out of its statistics; its effect on the NEXT request is not
      // (that is what the scenario shows)
      const sr = rows.filter((r) => r.scenario === scen && !r.replayOfPrime);
      if (!sr.length) continue;
      console.log(`\n#### ${backend} / ${scen}\n`);
      console.log("| layout | requests | prompt tokens (med) | reused (med) | evaluated (med / p90) | prompt ms (med / p90) | decode ms (med) | total ms measured (med / p90 / max) | ≤ 5 s measured | total ms projected (med / p90) | ≤ 5 s projected | long outputs |");
      console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
      summary[`e3-${backend}`].scenarios[scen] = {};
      for (const L of order) {
        const xs = sr.filter((r) => r.layout === L);
        if (!xs.length) continue;
        const long = xs.filter((r) => r.decoded > 2 * r.expectedAnswerTokens + 5).length;
        const pj = xs.map(proj);
        const s = {
          n: xs.length, nTokens: med(xs.map((r) => r.nTokens)), reused: med(xs.map((r) => r.reused)),
          evaluated: med(xs.map((r) => r.evaluated)), evaluatedP90: q(xs.map((r) => r.evaluated), 0.9),
          promptMs: med(xs.map((r) => r.promptMs)), promptMsP90: q(xs.map((r) => r.promptMs), 0.9),
          decodeMs: med(xs.map((r) => r.decodeMs)), wall: med(xs.map((r) => r.wallMs)), wallP90: q(xs.map((r) => r.wallMs), 0.9),
          wallMax: Math.max(...xs.map((r) => r.wallMs)), beat5: xs.filter((r) => r.wallMs < 5000).length,
          proj: med(pj), projP90: q(pj, 0.9), projBeat5: pj.filter((x) => x < 5000).length, long,
        };
        summary[`e3-${backend}`].scenarios[scen][L] = s;
        console.log(`| ${L} | ${s.n} | ${r0(s.nTokens)} | ${r0(s.reused)} | ${r0(s.evaluated)} / ${r0(s.evaluatedP90)} | ${r0(s.promptMs)} / ${r0(s.promptMsP90)} | ${r0(s.decodeMs)} | ` +
          `${r0(s.wall)} / ${r0(s.wallP90)} / ${r0(s.wallMax)} | ${s.beat5}/${s.n} | ${r0(s.proj)} / ${r0(s.projP90)} | ${s.projBeat5}/${s.n} | ${long} |`);
      }
    }
    // switch-replay: the request right after the replay, and the rest
    const sw = rows.filter((r) => r.scenario === "switch-replay");
    if (sw.length) {
      console.log(`\n#### ${backend} / switch-replay: the first B request (right after the identical re-send) vs the later switch requests\n`);
      console.log("| layout | first B: reused / evaluated (each pair) | first B: measured ms | first B: projected ms | first B: slow-laptop estimate s | later: evaluated (med) |");
      console.log("|---|---|---|---|---|---:|");
      for (const L of order) {
        const xs = sw.filter((r) => r.layout === L && !r.replayOfPrime);
        if (!xs.length) continue;
        const firstB = xs.filter((r) => r.k === 0);   // B's k=0 follows the replay
        const later = xs.filter((r) => r.k > 0);
        const slow = (r) => r.evaluated / 70 + r.expectedAnswerTokens / 12 + 0.12;
        console.log(`| ${L} | ${firstB.map((r) => `${r.reused} / ${r.evaluated}`).join("; ")} | ${firstB.map((r) => r0(r.wallMs)).join("; ")} | ` +
          `${firstB.map((r) => r0(proj(r))).join("; ")} | ${firstB.map((r) => slow(r).toFixed(2)).join("; ")} | ${r0(med(later.map((r) => r.evaluated)))} |`);
      }
    }
    // main, split: first sentence of an email vs the rest
    const main = rows.filter((r) => r.scenario === "main");
    if (main.length) {
      console.log(`\n#### ${backend} / main, first sentence of each email vs sentences 2-8 (projected total ms, median)\n`);
      console.log("| layout | first: evaluated | first: projected | later: evaluated | later: projected |");
      console.log("|---|---:|---:|---:|---:|");
      for (const L of order) {
        const f = main.filter((r) => r.layout === L && r.k === 0), l = main.filter((r) => r.layout === L && r.k > 0);
        if (!f.length) continue;
        console.log(`| ${L} | ${r0(med(f.map((r) => r.evaluated)))} | ${r0(med(f.map(proj)))} | ${r0(med(l.map((r) => r.evaluated)))} | ${r0(med(l.map(proj)))} |`);
      }
    }
  }
}

// ------------------------------------------------ E3 across backends (compact)
if (ONLY.includes("e3")) {
  const order = ["L0", "L1p-sys", "L1a-sys", "L2-sys", "L3-sys", "L1p-post", "L2-post", "L3-post", "L4-conv", "L2-conv"];
  const backs = ["cpu4", "cpu8", "igpu"].map((b) => [b, read(`e3-${b}.jsonl`)]).filter(([, r]) => r.length);
  // The plan's research rates for a 2018-21 Windows laptop (70 prompt / 12
  // output tokens per second) applied to this study's token counts: an
  // ESTIMATE of how the same layouts would land on the slowest class, not a
  // measurement.
  const SLOW = { prompt: 70, decode: 12 };
  console.log("\n### E3 summary: main scenario, sentences 2-8 of each email (median; projected = normal-length answer)\n");
  console.log(`| layout | evaluated tokens | ${backs.map(([b]) => `${b} measured ms (≤ 5 s)`).join(" | ")} | ${backs.map(([b]) => `${b} projected ms (≤ 5 s)`).join(" | ")} | slow-laptop estimate s |`);
  console.log(`|---|---:|${backs.map(() => "---:").join("|")}|${backs.map(() => "---:").join("|")}|---:|`);
  for (const L of order) {
    const cells = [], pcells = [];
    let ev = null, slow = null;
    for (const [, rows] of backs) {
      const l0 = rows.filter((r) => r.layout === "L0" && r.decoded >= 5 && r.decodeMs);
      const msPerTok = med(l0.map((r) => r.decodeMs / r.decoded));
      const overhead = med(rows.filter((r) => r.promptMs != null && r.decodeMs != null).map((r) => r.wallMs - r.promptMs - r.decodeMs));
      const xs = rows.filter((r) => r.scenario === "main" && r.layout === L && r.k > 0);
      if (!xs.length) { cells.push("-"); pcells.push("-"); continue; }
      // token counts do not depend on the backend; take them from the first
      // backend that ran this layout (cpu4 unless it is missing there)
      if (ev == null) {
        ev = med(xs.map((r) => r.evaluated));
        slow = med(xs.map((r) => r.evaluated / SLOW.prompt + r.expectedAnswerTokens / SLOW.decode + 0.12));
      }
      const pj = xs.map((r) => r.promptMs + r.expectedAnswerTokens * msPerTok + overhead);
      cells.push(`${r0(med(xs.map((r) => r.wallMs)))} (${Math.round(100 * xs.filter((r) => r.wallMs < 5000).length / xs.length)}%)`);
      pcells.push(`${r0(med(pj))} (${Math.round(100 * pj.filter((x) => x < 5000).length / pj.length)}%)`);
    }
    if (ev == null) continue;
    console.log(`| ${L} | ${r0(ev)} | ${cells.join(" | ")} | ${pcells.join(" | ")} | ${slow.toFixed(1)} |`);
  }

  // the other patterns, compact: tokens read (from the first backend that ran
  // the layout; token counts do not depend on the backend) and measured total
  // per backend
  const extra = ["L0", "L1p-sys", "L1p-post", "L3-post", "L4-conv", "L2-conv"];
  for (const s of ["switch", "switch-replay", "retry", "retry-seq", "rollover", "cold"]) {
    const any = backs.some(([, rows]) => rows.some((r) => r.scenario === s));
    if (!any) continue;
    console.log(`\n### E3 across backends: ${s} (tokens read med / p90; total ms measured median (share under 5 s))\n`);
    console.log(`| layout | tokens read | ${backs.map(([b]) => b).join(" | ")} |`);
    console.log(`|---|---:|${backs.map(() => "---:").join("|")}|`);
    for (const L of extra) {
      let tok = null;
      const cells = backs.map(([, rows]) => {
        const xs = rows.filter((r) => r.scenario === s && r.layout === L && !r.replayOfPrime);
        if (!xs.length) return "not run";
        if (tok == null) tok = `${r0(med(xs.map((r) => r.evaluated)))} / ${r0(q(xs.map((r) => r.evaluated), 0.9))}`;
        return `${r0(med(xs.map((r) => r.wallMs)))} (${Math.round(100 * xs.filter((r) => r.wallMs < 5000).length / xs.length)}%)`;
      });
      if (tok == null) continue;
      console.log(`| ${L} | ${tok} | ${cells.join(" | ")} |`);
    }
  }

  // which scenario ran on which backend, for which layouts (requests counted)
  const scens = ["main", "cold", "switch", "switch-replay", "retry", "retry-seq", "rollover"];
  console.log("\n### E3 scenario × backend matrix (requests; layouts)\n");
  console.log(`| scenario | ${backs.map(([b]) => b).join(" | ")} |`);
  console.log(`|---|${backs.map(() => "---").join("|")}|`);
  for (const s of scens) {
    const cells = backs.map(([, rows]) => {
      const xs = rows.filter((r) => r.scenario === s && !r.replayOfPrime);
      if (!xs.length) return "not run";
      const ls = order.filter((L) => xs.some((r) => r.layout === L));
      return `${xs.length} (${ls.length === order.length ? "all" : ls.join(", ")})`;
    });
    console.log(`| ${s} | ${cells.join(" | ")} |`);
  }
}

writeFileSync(`${RAW}/e123-summary.json`, JSON.stringify(summary, null, 1), { mode: 0o600 });
console.log(`\nwrote ${RAW}/e123-summary.json`);
