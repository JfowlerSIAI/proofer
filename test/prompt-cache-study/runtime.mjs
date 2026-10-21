// EXPERIMENT, NOT A GATE. The reuse instrument for the 2026-09-24 prompt-cache
// study (see TESTING.md §29).
//
// WHY THE LOG AND NOT THE API. Ollama 0.32.12 serves this model (lfm2) through
// the llama-server it bundles (llama.cpp 0b1bad14f; Ollama logs "using
// llama-server for model"), and its /api/chat response carries only
// prompt_eval_count / prompt_eval_duration. Whether a token was READ FROM
// CACHE or EVALUATED is decided inside llama-server, which logs it at the
// verbosity Ollama already starts it with (--log-verbosity 4):
//
//   new prompt, ... task.n_tokens = N              the whole rendered prompt
//   restored context checkpoint (... n_past = P)   resumed from a checkpoint
//   forcing full prompt re-processing ...          no usable checkpoint
//   cached n_tokens = R, memory_seq_rm [R, end)    first batch starts at R:
//                                                  tokens [0,R) were REUSED
//   prompt eval time = T ms / E tokens             E tokens were EVALUATED
//   created context checkpoint k of 32 (... n_tokens = C)
//   found better prompt with f_keep, f_sim         state loaded from the RAM
//                                                  prompt cache (--cache-ram)
//
// and, with LLAMA_SERVER_SLOTS_DEBUG=1 in the environment (Ollama passes it
// through), the token ids around the first mismatch between the cached
// sequence and the new prompt: old ids / new ids from max(n_past-4, 0). That is
// what lets a run check its OWN rendering against the runtime's: renderTokens()
// below tokenizes through the runner's /apply-template + /tokenize, and every
// request asserts that its token count equals task.n_tokens.
//
// A standalone llama-server (same binary, same GGUF) additionally reports
// timings.cache_n / timings.prompt_n in its /v1/chat/completions response; the
// LlamaServer class reads both and cross-checks them against the log.

import { openSync, readSync, fstatSync, closeSync, readFileSync } from "fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ log tail

export class LogTail {
  constructor(path) { this.path = path; }
  size() { const fd = openSync(this.path, "r"); try { return fstatSync(fd).size; } finally { closeSync(fd); } }
  mark() { return this.size(); }
  readFrom(offset) {
    const fd = openSync(this.path, "r");
    try {
      const end = fstatSync(fd).size;
      if (end <= offset) return "";
      const buf = Buffer.alloc(end - offset);
      readSync(fd, buf, 0, buf.length, offset);
      return buf.toString("latin1");
    } finally { closeSync(fd); }
  }
  /** Wait until the request that started after `offset` has been released. */
  async waitForRelease(offset, timeoutMs = 5000) {
    const t0 = Date.now();
    for (;;) {
      const text = this.readFrom(offset);
      if (/stop processing: n_tokens = \d+/.test(text) && /total time =/.test(text)) return text;
      if (Date.now() - t0 > timeoutMs) return text;
      await sleep(20);
    }
  }
}

const num = (m, i = 1) => (m ? Number(m[i]) : null);

/** Parse the llama-server lines of ONE request (text between two marks). */
export function parseRequestLog(text) {
  const out = {
    nTokens: num(/task\.n_tokens = (\d+)/.exec(text)),
    lcp: null,               // n_past before the checkpoint decision (slots debug)
    debugOld: null, debugNew: null, debugFrom: null,
    restored: null,          // {nTokens, nPast} of the checkpoint resumed from
    forcedFull: /forcing full prompt re-processing/.test(text),
    reused: null,            // tokens NOT re-evaluated (first batch start)
    evaluated: null, promptMs: null,
    decoded: null, decodeMs: null,
    checkpoints: [],         // n_tokens of every checkpoint created
    erasedTooClose: [], erasedInvalidated: [],
    ramCacheHit: null,       // {fKeep, fSim} when a cached prompt state was loaded
    ramCacheCandidates: [],  // [{len, lcp}] prompts the RAM cache considered
    needOne: /need to evaluate at least 1 token/.test(text),
    released: num(/stop processing: n_tokens = (\d+)/.exec(text)),
  };
  // slots-debug block: an "old: ..." piece line and a "new: ..." piece line
  // (pieces may contain newlines, so each can span several physical lines),
  // then two lines of right-aligned token ids (setw(8)) for positions
  // [max(n_past-4,0), ...). We keep only the ids; they are what a run checks
  // its own rendering against.
  const lines = text.split("\n");
  const newAt = lines.findIndex((l) => /\| task \d+ \| new: /.test(l));
  if (newAt >= 0) {
    const idLine = /\| task \d+ \|((?:\s+\d+)+)\s*$/;
    const found = [];
    for (let i = newAt + 1; i < lines.length && found.length < 2; i++) {
      const m = idLine.exec(lines[i]);
      if (m) found.push(m[1].trim().split(/\s+/).map(Number));
    }
    if (found.length === 2) { out.debugOld = found[0]; out.debugNew = found[1]; }
  }
  const r = /restored context checkpoint \(pos_min = (\d+), pos_max = (\d+), n_tokens = (\d+), n_past = (\d+)/.exec(text);
  if (r) out.restored = { posMin: +r[1], posMax: +r[2], nTokens: +r[3], nPast: +r[4] };
  const afterNew = text.slice(Math.max(0, text.search(/new prompt, /)));
  out.reused = num(/cached n_tokens = (\d+), memory_seq_rm/.exec(afterNew));
  const pe = /prompt eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/.exec(text);
  if (pe) { out.promptMs = +pe[1]; out.evaluated = +pe[2]; }
  const de = /\|\s+eval time =\s+([\d.]+) ms \/\s+(\d+) tokens/.exec(text);
  if (de) { out.decodeMs = +de[1]; out.decoded = +de[2]; }
  for (const m of text.matchAll(/created context checkpoint \d+ of \d+ \(pos_min = \d+, pos_max = \d+, n_tokens = (\d+)/g))
    out.checkpoints.push(+m[1]);
  // evictions: "too close to an earlier one" (create_checkpoint dropping an
  // OLDER request's checkpoints) and "invalidated" (past the first difference)
  out.erasedTooClose = [...text.matchAll(/erasing context checkpoint too close to an earlier one \(pos_min = \d+, pos_max = \d+, n_tokens = (\d+)/g)].map((m) => +m[1]);
  out.erasedInvalidated = [...text.matchAll(/erased invalidated context checkpoint \(pos_min = \d+, pos_max = \d+, n_tokens = (\d+)/g)].map((m) => +m[1]);
  const hit = /found better prompt with f_keep = ([\d.]+), f_sim = ([\d.]+)/.exec(text);
  if (hit) out.ramCacheHit = { fKeep: +hit[1], fSim: +hit[2] };
  for (const m of text.matchAll(/prompt with length\s+(\d+), lcp =\s+(\d+)/g))
    out.ramCacheCandidates.push({ len: +m[1], lcp: +m[2] });
  return out;
}

// ------------------------------------------------------------------ Ollama

export class Ollama {
  constructor({ port, log }) {
    if (Number(port) === 11434) throw new Error("refusing the owner's live Ollama on 11434");
    this.base = `http://127.0.0.1:${port}`;
    this.tail = new LogTail(log);
  }
  /** The bundled llama-server's own port, from the most recent start line
   *  (the log is scanned incrementally; a reload writes a new line). */
  runnerPort() {
    const from = this._scanned || 0;
    const text = this.tail.readFrom(from);
    this._scanned = from + Buffer.byteLength(text, "latin1");
    const all = [...text.matchAll(/llama_server: listening on http:\/\/127\.0\.0\.1:(\d+)/g)];
    if (all.length) this._port = Number(all[all.length - 1][1]);
    return this._port ?? null;
  }
  async chat(body) {
    const mark = this.tail.mark();
    const t0 = performance.now();
    const res = await fetch(`${this.base}/api/chat`, { method: "POST", body: JSON.stringify(body) });
    const json = await res.json();
    const wallMs = performance.now() - t0;
    if (json.error) throw new Error(`ollama error: ${json.error}`);
    const text = await this.tail.waitForRelease(mark);
    return { json, wallMs, log: parseRequestLog(text) };
  }
  /** Unload the model: the runner process exits, so slot, checkpoints and the
   *  RAM prompt cache all go with it. Returns once /api/ps is empty. */
  async unload(model) {
    await fetch(`${this.base}/api/chat`, { method: "POST", body: JSON.stringify({ model, messages: [], keep_alive: 0 }) });
    for (let i = 0; i < 200; i++) {
      const ps = await (await fetch(`${this.base}/api/ps`)).json();
      if (!(ps.models || []).length) return true;
      await sleep(50);
    }
    throw new Error("model did not unload");
  }
  async load(model, options) {
    const t0 = performance.now();
    await fetch(`${this.base}/api/chat`, { method: "POST", body: JSON.stringify({ model, messages: [], keep_alive: "30m", options }) });
    return performance.now() - t0;
  }
}

// ------------------------------------------------------------ llama-server

export class LlamaServer {
  constructor({ port, log }) {
    this.base = `http://127.0.0.1:${port}`;
    this.port = port;
    this.tail = log ? new LogTail(log) : null;
  }
  async ready(timeoutMs = 60000) {
    const t0 = Date.now();
    for (;;) {
      try { const r = await fetch(`${this.base}/health`); if (r.ok) return true; } catch {}
      if (Date.now() - t0 > timeoutMs) throw new Error("llama-server not ready");
      await sleep(100);
    }
  }
  /** Same sampling as the shipping request; response_format json_object is
   *  llama-server's equivalent of Ollama's format:"json". */
  async chat(messages, { maxTokens = 512 } = {}) {
    const mark = this.tail ? this.tail.mark() : 0;
    const t0 = performance.now();
    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        messages, temperature: 0.1, top_p: 0.8, top_k: 20, repeat_penalty: 1.0,
        max_tokens: maxTokens, response_format: { type: "json_object" },
        cache_prompt: true, stream: false,
      }),
    });
    const json = await res.json();
    const wallMs = performance.now() - t0;
    if (json.error) throw new Error(`llama-server error: ${JSON.stringify(json.error)}`);
    const log = this.tail ? parseRequestLog(await this.tail.waitForRelease(mark)) : null;
    return { json, wallMs, log, timings: json.timings || null };
  }
}

// ---------------------------------------------------------------- rendering

/**
 * Render messages through the runtime's own chat template and tokenizer.
 * `port` is a llama-server port (Ollama's runner or a standalone one).
 * Returns {prompt, ids, pieces}; ids include the BOS the runtime adds, so
 * ids.length must equal the log's task.n_tokens.
 */
export async function renderTokens(port, messages) {
  const post = async (p, b) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(b) });
    return r.json();
  };
  const { prompt } = await post("/apply-template", { messages });
  const k = await post("/tokenize", { content: prompt, add_special: true, parse_special: true, with_pieces: true });
  return { prompt, ids: k.tokens.map((t) => t.id), pieces: k.tokens.map((t) => t.piece) };
}

/** First index where two id arrays differ (= LCP length). */
export function lcp(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/** User-message start positions (token index where "<|im_start|>user\n" begins). */
export function userStarts(pieces) {
  const out = [];
  for (let i = 0; i + 1 < pieces.length; i++) if (pieces[i] === "<|im_start|>" && pieces[i + 1] === "user") out.push(i);
  return out;
}

export function loadavg() {
  const [a, b, c] = readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).map(Number);
  return [a, b, c];
}

export const median = (xs) => {
  const s = xs.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const pct = (xs, q) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
