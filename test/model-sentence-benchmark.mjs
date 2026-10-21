#!/usr/bin/env node
// Frozen benchmark through the shipping engine, including retries and deadline.
// Raw results stay private under test/harvested. No dependencies beyond Node.
// Usage: PROOFER_MODEL=... PROOFER_OLLAMA_URL=... node test/model-sentence-benchmark.mjs --out <new.jsonl>
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MODEL, OLLAMA_URL, researchModelPolicy } from './lib/harness.mjs';
import {
  prepareSentenceRequest, runSentenceEngine,
  SENTENCE_CONTEXT_CHARS, SENTENCE_TIMEOUT_MS,
  SENTENCE_RETRY_DELIVERY_CAP_MS, SENTENCE_RETRY_DELIVERY_MARGIN_MS,
} from './lib/sentence-guards.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const input = arg('--benchmark', new URL('./harvested/finetune/benchmark-frozen-v1.jsonl', import.meta.url).pathname);
const output = arg('--out');
if (!output) throw new Error('--out <new.jsonl> is required');
const limit = Number(arg('--limit', 'Infinity'));
if (!(limit > 0)) throw new Error('--limit must be positive');
const bytes = fs.readFileSync(input);
const rows = bytes.toString().trim().split('\n').map(JSON.parse).slice(0, limit);
if (!rows.length || new Set(rows.map(r => r.uid)).size !== rows.length) throw new Error('Empty or duplicate benchmark');
const deadlineMs = Math.min(SENTENCE_TIMEOUT_MS, SENTENCE_RETRY_DELIVERY_CAP_MS - SENTENCE_RETRY_DELIVERY_MARGIN_MS);
const policy = researchModelPolicy(MODEL);
const hash = b => createHash('sha256').update(b).digest('hex');
fs.mkdirSync(path.dirname(output), { recursive: true });
const fd = fs.openSync(output, 'wx', 0o600);
const request = async (route, body) => {
  const res = await fetch(`${OLLAMA_URL}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`${route}: ${JSON.stringify(data)}`);
  return data;
};
const started = new Date().toISOString();
const show = await request('/api/show', { model: policy.model });
const warm = prepareSentenceRequest('Please reveiw the document.', '', { hostname: 'discord.com' }, { model: policy.model });
const warmStart = performance.now();
const warmResult = await request('/api/chat', warm.body);
const warmupMs = performance.now() - warmStart;
const metadata = {
  started, model: MODEL, server: OLLAMA_URL, version: await request('/api/version'),
  tags: await request('/api/tags'), show, residency: await request('/api/ps'),
  benchmark: input, benchmark_sha256: hash(bytes), count: rows.length,
  background_sha256: hash(fs.readFileSync(new URL('../background.js', import.meta.url))),
  runner_sha256: hash(fs.readFileSync(new URL(import.meta.url))),
  deadlineMs, trigger: 'idle', hostname: 'discord.com', concurrency: 1,
  warmup_ms: warmupMs, warmup: warmResult,
};
fs.writeFileSync(output + '.meta.json', JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
console.log(`${MODEL}: ${rows.length} rows, ${deadlineMs} ms deadline, warmup ${Math.round(metadata.warmup_ms)} ms`);
const counts = {};
for (const [i, row] of rows.entries()) {
  const priorContext = (row.context_2500 || '').slice(-SENTENCE_CONTEXT_CHARS);
  const pageContext = { hostname: 'discord.com' };
  const req = prepareSentenceRequest(row.sentence, priorContext, pageContext, { model: policy.model });
  const t = performance.now();
  const { payload, meta } = await runSentenceEngine({
    sentence: row.sentence, priorContext, pageContext, trigger: 'idle', req,
    ollamaUrl: OLLAMA_URL, ac: new AbortController(), deadlineMs: Date.now() + deadlineMs,
    checkAllowed: async () => true,
    expectedDigest: policy.expectedDigest,
  });
  const latency_ms = performance.now() - t;
  const outcome = payload.ok ? (payload.noChanges ? 'no-change' : 'applied') : (payload.refused || payload.error || 'unknown');
  const delivered = payload.ok && typeof payload.rewritten === 'string' ? payload.rewritten : row.sentence;
  // Scorer-compatible delivery projection. Keep the engine response separately:
  // operational failures are never mislabeled as malformed model JSON.
  const malformed = ['invalid-json', 'no-rewritten-key'].includes(outcome);
  const result = {
    uid: row.uid, model: MODEL, run_idx: 0,
    raw: meta.data?.message?.content ?? '', // First-pass wire output; retry details are in meta.
    malformed, rewritten: malformed ? null : delivered,
    guard: payload.ok ? 'applied' : outcome,
    delivered, outcome, latency_ms, payload, meta,
  };
  fs.writeSync(fd, JSON.stringify(result) + '\n');
  counts[outcome] = (counts[outcome] || 0) + 1;
  if (/^http-/.test(outcome) || ['model-missing', 'model-mismatch', 'model-unverified', 'unreachable'].includes(outcome)) {
    throw new Error(`Infrastructure failure at ${i + 1}: ${outcome}; partial output retained`);
  }
  if ((i + 1) % 50 === 0 || i + 1 === rows.length) console.log(`${i + 1}/${rows.length} ${JSON.stringify(counts)}`);
}
fs.closeSync(fd);
fs.writeFileSync(output + '.summary.json', JSON.stringify({ model: MODEL, started, finished: new Date().toISOString(), count: rows.length, counts }, null, 2) + '\n', { mode: 0o600 });
