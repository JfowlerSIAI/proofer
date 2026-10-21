#!/usr/bin/env node
// EXPERIMENT, NOT A GATE. Audits E3's reset-and-prime protocol from the
// PRIMARY evidence, the runtime's own log, rather than from the rows the
// harness wrote: for each runner process Ollama started (one per reset), how
// many requests it served and whether its first request (the prime) started
// from an empty cache (first batch at 0, i.e. "cached n_tokens = 0").
//
//   node e3-audit.mjs <ollama-<port>-e3-<backend>.log> [...]
//
// Expected for the final runs: one runner for the warm-up, then per (email,
// layout) in main a runner serving 9 requests (prime + 8 sentences); per cold
// request a runner serving 1; switch 16 (prime A1, then B1 A2 B2 ... A8 B8);
// switch-replay (the first protocol, cpu4 only) 17 (prime + A1 again + 15);
// retry 11 (prime + 8 + 2 retries); rollover 33 (prime + 32).

import { readFileSync } from "fs";

for (const path of process.argv.slice(2)) {
  const text = readFileSync(path, "latin1");
  const runners = text.split(/llama_server: listening on http:\/\/127\.0\.0\.1:\d+/).slice(1);
  const counts = new Map();
  let freshFirst = 0, withRequests = 0;
  for (const chunk of runners) {
    const tasks = chunk.split(/new prompt, n_ctx_slot/).slice(1);
    if (!tasks.length) continue;
    withRequests++;
    const m = /cached n_tokens = (\d+), memory_seq_rm/.exec(tasks[0]);
    if (m && Number(m[1]) === 0) freshFirst++;
    counts.set(tasks.length, (counts.get(tasks.length) || 0) + 1);
  }
  console.log(`${path.split("/").pop()}: ${runners.length} runner starts, ${withRequests} served requests; ` +
    `first request read from token 0 in ${freshFirst}/${withRequests}; requests per runner: ` +
    [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x${v}`).join(", "));
}
