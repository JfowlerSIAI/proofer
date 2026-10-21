// Compatibility reader for ARCHITECTURE.md's "Sentence interaction record".
// Never rewrite an export or infer dispatch from prepared options or wall time.
import { sentenceRecordGuard } from "./sentence-guards.mjs";

const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value) => typeof value === "string" ? value : null;
const counters = ["totalMs", "loadMs", "promptTokens", "promptMs", "evalTokens", "evalMs"];
const timings = (value, wallMs = null) => Object.fromEntries([
  ["wallMs", wallMs], ...counters.map((key) => [key, number(value?.[key])]),
]);
const hasCounters = (value) => counters.some((key) => number(value?.[key]) !== null);

export function normalizeInteraction(raw, { schema } = {}) {
  const browser = schema ? schema === "browser" : typeof raw.input === "string" || typeof raw.path === "string";
  const guard = browser ? sentenceRecordGuard(raw) : raw.outcome === "refused" ? raw.verdict : null;
  const arrival = number(raw.arrivedAt) ?? number(raw.startedAt);
  return {
    ...raw,
    schema: browser ? "browser" : "corpus",
    path: browser ? raw.path || "sentence" : "sentence",
    input: browser ? raw.input : raw.sentence,
    guard: guard || null,
    userVerdict: browser ? raw.verdict ?? null : null,
    recorded: browser ? guard ? "refused" : raw.error ? "error"
      : raw.noChanges === true ? "no-op" : typeof raw.output === "string" ? "applied" : null
      : raw.outcome || null,
    arrivedAt: arrival,
    arrivalEvidence: number(raw.arrivedAt) !== null ? "measured" : number(raw.startedAt) !== null ? "legacy-startedAt" : "unknown",
    completedAt: number(raw.completedAt),
    dispatched: raw.v === 2 && raw.path === "sentence" ? raw.dispatched === true
      : hasCounters(raw.timings) || raw.retry?.dispatched === true || hasCounters(raw.retry?.timings) ? true : null,
    keepAliveMs: number(raw.keepAliveMs),
    backend: raw.backend ?? null,
    raw,
  };
}

// v1 has no first-attempt wall or measured attempt endpoints. Counters establish
// dispatch; wall/options alone do not. A missing retry output stays unavailable.
export function interactionAttempts(record) {
  const r = record.raw || record;
  if (r.v === 2 && r.path === "sentence") return r.attempts || [];
  const n = record.raw ? record : normalizeInteraction(r);
  if (n.path !== "sentence") return [];
  const retry = r.retry;
  const salvaged = retry?.outcome === "applied";
  const duplicate = salvaged && r.error === "consent-read-timeout"
    && typeof retry.firstOutput === "string" && r.output === retry.firstOutput && r.guard === retry.firstGuard;
  const first = {
    attempt: "first", dispatched: hasCounters(r.timings) ? true : null,
    dispatchedAt: null, completedAt: null, timings: timings(r.timings),
    output: salvaged ? text(retry.firstOutput) : text(r.output) ?? (r.noChanges === true ? text(n.input) : null),
    guard: salvaged ? retry.firstGuard || null : n.guard,
    error: salvaged ? null : r.error || null,
    outcome: salvaged ? "refused" : n.recorded,
    reconstructed: !salvaged && r.noChanges === true && typeof r.output !== "string",
  };
  const rows = [first];
  if (salvaged || retry?.dispatched === true || hasCounters(retry?.timings)
      || (retry?.outcome === "refused" && typeof retry.output === "string")) {
    rows.push({
      attempt: "retry", dispatched: retry.dispatched === true || hasCounters(retry.timings) ? true : null,
      dispatchedAt: null, completedAt: null,
      timings: timings(retry.timings, number(retry.timings?.wallMs)),
      output: duplicate ? null : salvaged ? text(r.output) : text(retry.output),
      guard: salvaged ? null : retry.guard || null,
      error: retry.outcome === "error" ? retry.reason || "retry-error" : null,
      outcome: retry.outcome,
      unavailable: duplicate ? "legacy-accepted-retry-output" : null,
    });
  }
  return rows;
}

// Latency-only projection: legacy completion proxies are not attempt facts.
// Manual rows predate the engine seam; only Ollama counters prove their dispatch.
export function latencyAttempts(record) {
  const n = record.raw ? record : normalizeInteraction(record);
  const canonical = n.v === 2 && n.path === "sentence";
  const rows = n.path === "sentence" ? interactionAttempts(n)
    : [{ attempt: "first", dispatched: n.dispatched, timings: timings(n.timings), error: n.error }];
  return rows.filter((a) => canonical || a.dispatched === true).map((a) => {
    const arrival = n.arrivedAt ?? number(n.ts);
    const arrivalEvidence = n.arrivedAt !== null ? n.arrivalEvidence : "write-time-proxy";
    const legacySingle = !canonical && rows.length === 1;
    const completion = number(a.completedAt) ?? (legacySingle
      ? n.arrivedAt !== null && number(n.timings?.wallMs) !== null
        ? n.arrivedAt + n.timings.wallMs : number(n.ts)
      : null);
    return {
      ...n, ...a, interaction: n,
      path: a.attempt === "retry" ? "sentence-retry" : n.path,
      timings: a.timings || timings(null),
      dispatchedAt: number(a.dispatchedAt), completedAt: completion,
      endpoint: a.attempt === "retry" ? number(a.dispatchedAt) : arrival,
      arrivalEvidence: a.attempt === "retry" ? canonical ? "measured-dispatch" : "unknown" : arrivalEvidence,
      completionEvidence: number(a.completedAt) !== null ? "measured" : legacySingle
        ? n.arrivedAt !== null && number(n.timings?.wallMs) !== null ? "legacy-wall-proxy" : "write-time-proxy"
        : "unknown",
      // Group legacy retries without inventing an offset or precise ordering.
      orderAt: number(a.dispatchedAt) ?? arrival,
      orderingUnknown: !canonical && rows.length > 1,
      leaseEvidence: n.keepAliveMs !== null ? "recorded" : n.path === "manual" ? "legacy-manual-90s" : "unknown",
    };
  });
}

// Keep normalizeRecord's interaction API for evidence/harvesting studies. Replay
// expansion is separate: page/user labels belong to the interaction throughout.
export function replayProjection(raw) {
  const n = normalizeInteraction(raw);
  const noChangeEcho = n.schema === "browser" && raw.noChanges === true && typeof raw.output !== "string";
  return {
    id: raw.id || raw.uid || raw.message_id || null, path: n.path, input: n.input,
    output: text(raw.output) ?? (noChangeEcho ? n.input : null), reconstructed: noChangeEcho,
    trigger: raw.trigger ?? null, context: raw.context ?? "", error: raw.error ?? null,
    recorded: n.recorded, recordedGuard: n.guard, userVerdict: n.userVerdict, raw,
  };
}

export function replayAttempts(raw) {
  const base = replayProjection(raw);
  if (base.path !== "sentence") return [base];
  return interactionAttempts(raw).map((attempt) => ({
    ...base, attempt: attempt.attempt, output: attempt.output, error: attempt.error,
    recorded: attempt.outcome, recordedGuard: attempt.guard,
    reconstructed: attempt.reconstructed === true, unavailable: attempt.unavailable || null,
  }));
}

// Deletion covers every prose-bearing path, including compatibility aliases.
// Length/attribution limits belong to the caller, not the schema inventory.
export function interactionProse(record) {
  const r = record?.raw || record;
  if (!r || typeof r !== "object") return [];
  return [...new Set([
    r.input, r.output, r.finalText,
    r.context,
    r.retry?.firstOutput,
    r.retry?.output,
    ...(Array.isArray(r.attempts) ? r.attempts.map((a) => a?.output) : []),
    ...(Array.isArray(r.retry?.keep) ? r.retry.keep : []),
  ].filter((value) => typeof value === "string" && value.length > 0))];
}
