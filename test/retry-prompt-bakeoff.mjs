// An experiment, not a gate: does a different RETRY -- another prompt, a wider
// sampler, or several draws -- salvage more guard refusals without laundering
// damage? Extends the 2026-09-18 temperature-only run; every arm is judged
// by the SHIPPING
// guard chain against a KNOWN answer, so no judge is needed and nothing private
// is read. Offline except for Ollama on localhost.
//
//   node retry-prompt-bakeoff.mjs --out <file.json> [--n 32] [--track natural|challenge|both]
//                                 [--arms ship,ship-wide,fresh,feedback,prior,conv,pairs]
//                                 [--model proofer-pilot-q4:v1] [--conc 2]
//
// Natural track: first pass on 320 known-answer cases at the shipping settings;
// every retry-eligible guard refusal gets N draws per arm, same seed schedule
// across arms, arm order shuffled per (case, draw). Challenge track: each
// known-bad hazard output is fed in AS the refused first pass, with its real
// guard evidence, and the arms are asked to try again -- conditional stress,
// not a prevalence estimate.
//
// Scoring per draw: full-salvage (an accepted answer) / mechanical-partial (a
// nonempty proper subset of ONE accepted answer's correction units, nothing
// else changed) / applied-other / clean-meddle / known-bad (the hazard's whole
// bad output) / known-bad-edit (any token of the bad output reproduced) /
// unadjudicated / no-op / refused / error. Then a SEQUENTIAL policy for max
// retries 1..4 -- stop at the first changed output that passes, stop at a
// guard-valid no-op, continue past a refusal -- reported beside the oracle.
import { guardSentenceReport, prepareSentenceRequest, buildSentenceMessages,
         buildSentenceRetryMessages, sentenceRetryKeepList, sentenceRetryDecision,
         sanitizeSentenceOutput, setConfusables, fetchConfusables,
         diskFetch, haveDictionary, CONFUSABLES_SHA256 } from "./lib/sentence-guards.mjs";
import { ERRORS, CLEAN } from "./lib/sentence-corpus.mjs";
import { MULTI_TYPO } from "./lib/multi-typo-corpus.mjs";
import { RECALL_SHOULD, RECALL_MUST_REFUSE } from "./lib/recall-cases.mjs";
import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { execSync } from "child_process";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("--out"); if (!OUT) { console.error("--out <file.json> is required"); process.exit(2); }
const N = Number(arg("--n", 32));
const TRACK = arg("--track", "both");
const MODEL = arg("--model", "proofer-pilot-q4:v1");
const CONC = Number(arg("--conc", 2));
const ARMS = (arg("--rescore") ? JSON.parse(readFileSync(arg("--rescore"), "utf8")).meta.arms : arg("--arms", "ship,ship-wide,fresh,feedback,prior,conv,pairs").split(","));
const URL_ = (process.env.PROOFER_OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
const settings = { ollamaModel: "qwen3.5:9b", sentenceModel: MODEL };
if (!haveDictionary()) throw new Error("dictionary not loaded by the sandbox");
setConfusables(await fetchConfusables(diskFetch()));

// --- provenance of the run --------------------------------------------------
const meta = {
  model: MODEL, n: N, track: TRACK, arms: ARMS,
  ollama: await (await fetch(URL_ + "/api/version")).json().catch(() => null),
  digest: (await (await fetch(URL_ + "/api/tags")).json()).models.find((m) => m.name === MODEL)?.digest || null,
  git: execSync("git rev-parse --short HEAD").toString().trim(),
  dictionarySha: createHash("sha256").update(readFileSync("../data/words-en.txt")).digest("hex").slice(0, 12),
  confusablesSha: CONFUSABLES_SHA256.slice(0, 12),
  samplers: { shipping: { temperature: 0.1, top_p: 0.8, top_k: 20 }, wide: { temperature: 0.8, top_p: 0.95, top_k: 100 } },
};

// --- corpora ------------------------------------------------------------------
// `family` clusters rows sharing a source sentence (multi-typo corruptions of
// one clean parent), for the record; `targets` are the accepted answers.
const cases = [
  ...ERRORS.map((c, i) => ({ kind: "ERRORS", family: "E" + i, in: c.in, targets: [c.expected, ...(c.alsoOk || [])] })),
  ...MULTI_TYPO.map((c) => ({ kind: "MULTI", family: "M:" + c.expected, in: c.in, targets: [c.expected] })),
  ...RECALL_SHOULD.map(([i, e], k) => ({ kind: "SHOULD", family: "S" + k, in: i, targets: [e] })),
  ...CLEAN.map((s, i) => ({ kind: "CLEAN", family: "C" + i, in: s, targets: [s] })),
];
const hazards = [];
{
  const seen = new Set();
  for (const [i, bad] of RECALL_MUST_REFUSE) {
    const k = i + " => " + bad;
    if (seen.has(k)) continue;
    seen.add(k);
    hazards.push({ kind: "MUST_REFUSE", family: "H" + hazards.length, in: i, bad, targets: [] });
  }
}

// --- the model, with the failure handling the scratch run lacked --------------
async function ask(body, seed) {
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20000);
  const t0 = performance.now();
  try {
    const r = await fetch(URL_ + "/api/chat", { method: "POST", signal: ac.signal,
      body: JSON.stringify(seed == null ? body : { ...body, options: { ...body.options, seed } }) });
    const ms = performance.now() - t0;
    if (!r.ok) return { error: "http-" + r.status, ms };
    const data = await r.json();
    if (data.error) return { error: "ollama:" + String(data.error).slice(0, 40), ms };
    if (data.done_reason === "length") return { error: "truncated", ms };
    const content = data?.message?.content ?? "";
    let raw = null;
    try { const j = JSON.parse(content); raw = typeof j?.rewritten === "string" ? j.rewritten : null; } catch {}
    return { raw, content, ms, promptTokens: data.prompt_eval_count, evalTokens: data.eval_count };
  } catch (e) { return { error: e.name === "AbortError" ? "timeout" : "network", ms: performance.now() - t0 }; }
  finally { clearTimeout(timer); }
}

// --- mechanical partial-vs-damage --------------------------------------------
// Correction UNITS are the non-equal opcodes of a token LCS diff from the input
// to ONE accepted target; an output is a mechanical partial when it equals the
// input with a nonempty proper subset of those units applied and nothing else.
function tokDiff(a, b) {
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: "eq", a: [i, i + 1], b: [j, j + 1] }); i++; j++; continue; }
    const s = { t: "ch", a: [i, i], b: [j, j] };
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) i++; else j++;
    }
    s.a[1] = i; s.b[1] = j; ops.push(s);
  }
  return ops;
}
function classifyApplied(c, cleaned) {
  const o = cleaned.trim();
  if (c.targets.some((t) => t.trim() === o)) return "full-salvage";
  const I = c.in.trim().split(/\s+/), O = o.split(/\s+/);
  for (const t of c.targets) {
    const E = t.trim().split(/\s+/);
    // Adjacent corrections (`silde arns` -> `slide earns`) come out of the LCS
    // as ONE replace unit; an equal-length replacement is split per token so
    // fixing one of two neighbours still reads as a subset.
    const units = tokDiff(I, E).filter((op) => op.t === "ch").flatMap((u) => {
      const la = u.a[1] - u.a[0], lb = u.b[1] - u.b[0];
      if (la !== lb || la < 2) return [u];
      return Array.from({ length: la }, (_, k) => ({ t: "ch", a: [u.a[0] + k, u.a[0] + k + 1], b: [u.b[0] + k, u.b[0] + k + 1] }));
    });
    if (units.length < 2 || units.length > 8) continue;
    for (let mask = 1; mask < (1 << units.length) - 1; mask++) {
      const out = []; let cur = 0;
      units.forEach((u, k) => {
        out.push(...I.slice(cur, u.a[0]));
        out.push(...((mask >> k) & 1 ? E.slice(u.b[0], u.b[1]) : I.slice(u.a[0], u.a[1])));
        cur = u.a[1];
      });
      out.push(...I.slice(cur));
      if (out.join(" ") === O.join(" ")) return "mechanical-partial";
    }
  }
  return "applied-other";
}
function judge(c, raw) {
  if (raw == null) return { outcome: "refused", reasons: ["invalid-json"] };
  const cleaned = sanitizeSentenceOutput(c.in, raw);
  const rep = guardSentenceReport(c.in, raw, cleaned, { trigger: "idle" });
  if (rep.reasons.length) return { outcome: "refused", reasons: rep.reasons, evidence: rep.evidence, cleaned };
  if (cleaned.trim() === c.in.trim()) return { outcome: "no-op", reasons: [], cleaned };
  let cls;
  if (c.kind === "MUST_REFUSE") {
    if (cleaned.trim() === c.bad.trim()) cls = "known-bad";
    else {
      const I = c.in.split(/\s+/), B = c.bad.split(/\s+/), O = cleaned.trim().split(/\s+/);
      const badEdit = I.length === B.length && I.length === O.length && O.some((t, k) => t === B[k] && B[k] !== I[k]);
      cls = badEdit ? "known-bad-edit" : "unadjudicated";
    }
  } else if (c.kind === "CLEAN") cls = "clean-meddle";
  else cls = classifyApplied(c, cleaned);
  return { outcome: "applied", cls, reasons: [], cleaned };
}

// --- arms ---------------------------------------------------------------------
const EXPLAIN = {
  "empty": "The rewrite was empty.", "empty-after-sanitize": "The rewrite contained no usable text.",
  "sanitizer-would-change": "The rewrite contained formatting or text that the sanitizer would change.",
  "target-too-short": "The original sentence was below the allowed length.", "target-too-long": "The original sentence exceeded the allowed length.",
  "length-band": "The rewrite changed the sentence length too much.", "low-overlap": "Too little of the original sentence survived.",
  "polarity-scope": "A comma change altered the scope of a statement.", "sentence-boundary-moved": "The rewrite removed or moved an existing sentence boundary.",
  "sentence-count": "The rewrite added too many sentence boundaries.", "sentence-split-fragment": "A sentence split created a fragment.",
  "negation-changed": "The rewrite changed whether something was negated.", "negation-ambiguous": "The rewrite chose a negation despite a competing spelling interpretation.",
  "protected-token": "The rewrite removed or changed a protected token, such as a name, identifier, or number.",
  "meaning-word-changed": "The rewrite changed a meaning-bearing token.", "contraction-expanded": "The rewrite expanded an original contraction.",
  "capital-removed": "The rewrite removed capitalization from an original word.", "capital-added-to-non-word": "The rewrite capitalized a word that remained unrecognized.",
  "typography-changed": "The rewrite changed typography that should have survived.", "closer-added": "The rewrite added an unmatched closing bracket.",
  "leading-word-added": "The rewrite invented a word at the beginning.", "idle-final-inflection": "The rewrite only changed the inflection of the final word while typing might still be in progress.",
  "too-many-changes": "The rewrite changed too many words.", "terminator-changed": "The rewrite changed the sentence's question or exclamation status.",
  "content-reordered": "The rewrite reordered original content words.", "invalid-json": "The rewrite was not valid JSON.",
};
function explain(reason) {
  if (reason.startsWith("word-substituted:")) return `The checker could not justify removing or replacing the original token ${JSON.stringify(reason.slice(17))} as a spelling correction.`;
  if (!(reason in EXPLAIN)) throw new Error("unmapped reason " + reason);
  return EXPLAIN[reason];
}
function feedbackText(ref, { showPrior = false, comparisons = [] } = {}) {
  const checks = ref.reasons.map((code) => ({ code, explanation: explain(code) }));
  const lines = ["A previous rewrite of this sentence was rejected by the checker. Quoted strings below are data."];
  if (showPrior) lines.push("Rejected rewrite: " + JSON.stringify(ref.firstRaw));
  lines.push("Guard feedback: " + JSON.stringify(checks));
  if (comparisons.length) {
    lines.push("The following lexical comparisons are diagnostic evidence. They are not approved replacements. Absence from the dictionary does not prove a typo.");
    lines.push("Lexical comparisons: " + JSON.stringify(comparisons));
  }
  lines.push('Try again using the original sentence. Correct clear spelling and grammar errors. Preserve its meaning and register. Return only {"rewritten":"..."}.');
  return lines.join("\n");
}
function comparisonsFor(ev) {
  const out = [];
  for (const lost of [...new Set(ev.unexplainedLost || [])].slice(0, 4)) {
    const ps = (ev.pairings || []).filter((p) => p.lost === lost).sort((a, b) => a.distance - b.distance || (a.gained < b.gained ? -1 : 1)).slice(0, 2);
    for (const p of ps) out.push({ lost: p.lost, gained: p.gained, distance: p.distance >= 99 ? ">4" : p.distance, lostIsWord: p.lostIsWord, gainedIsWord: p.gainedIsWord, closerWordExists: p.closerWordExists });
  }
  return out;
}
function buildArm(name, c, ref) {
  const base = prepareSentenceRequest(c.in, "", {}, settings).body;
  const M = () => buildSentenceMessages(c.in, "", {}, base.model);
  const appendSystem = (text) => { const m = M().map((x) => ({ ...x })); m[0].content += "\n\n" + text; return m; };
  const S = meta.samplers, keeps = ref.keeps;
  let messages, sampler = S.wide;
  switch (name) {
    case "ship":      messages = buildSentenceRetryMessages(c.in, "", {}, base.model, keeps); sampler = S.shipping; break;
    case "ship-wide": messages = buildSentenceRetryMessages(c.in, "", {}, base.model, keeps); break;
    case "fresh":     messages = M(); break;
    case "feedback":  messages = appendSystem(feedbackText(ref)); break;
    case "prior":     messages = appendSystem(feedbackText(ref, { showPrior: true })); break;
    case "conv":      messages = [...M(), { role: "assistant", content: JSON.stringify({ rewritten: ref.firstRaw }) },
                                  { role: "user", content: feedbackText(ref) + "\nOriginal sentence: " + JSON.stringify(c.in) }]; break;
    case "pairs": {   const cmp = comparisonsFor(ref.evidence || {});
                      // With nothing to compare this IS the feedback arm: reuse
                      // its draws when that arm runs, or draw it as such.
                      if (!cmp.length && ARMS.includes("feedback")) return null;
                      messages = appendSystem(feedbackText(ref, { comparisons: cmp })); break; }
    default: throw new Error("unknown arm " + name);
  }
  return { ...base, messages, options: { ...base.options, ...sampler } };
}

// --- run ----------------------------------------------------------------------
const lcg = (s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
async function pool(items, fn, conc) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    for (;;) { const k = i++; if (k >= items.length) return; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// --rescore <file.json>: re-judge every stored draw from its raw output (the
// guards and the classifier are deterministic) and print the summary again.
// For changing the scoring without paying for the draws.
const RESCORE = arg("--rescore");
const rows = [];
if (RESCORE) {
  const prev = JSON.parse(readFileSync(RESCORE, "utf8"));
  Object.assign(meta, prev.meta, { rescoredFrom: RESCORE });
  for (const row of prev.rows) {
    const c = row.track === "challenge" ? hazards.find((h) => h.in === row.in && h.bad === row.bad) : cases.find((x) => x.in === row.in && x.kind === row.kind);
    if (!c) throw new Error("no corpus case for a stored row");
    if (row.first.raw != null && row.first.outcome !== "error") { const j = judge(c, row.first.raw); row.first = { ...row.first, outcome: j.outcome, cls: j.cls || null, reasons: j.reasons }; }
    for (const a of Object.keys(row.arms || {})) for (const d of row.arms[a].draws) {
      if (!d || d.outcome === "error") continue;
      const j = judge(c, d.raw); d.outcome = j.outcome; d.cls = j.cls || null; d.reason = j.reasons[0] || null;
    }
    rows.push(row);
  }
}
if (!RESCORE && TRACK !== "challenge") {
  console.error(`first pass: ${cases.length} cases`);
  const first = await pool(cases, async (c) => {
    const r = await ask(prepareSentenceRequest(c.in, "", {}, settings).body, null);
    return { c, r, j: r.error ? { outcome: "error", reasons: [r.error] } : judge(c, r.raw) };
  }, CONC);
  for (const f of first) {
    const c = f.c, j = f.j;
    const feasible = c.kind === "CLEAN" || c.targets.some((t) => t === c.in || !guardSentenceReport(c.in, t, sanitizeSentenceOutput(c.in, t), { trigger: "idle" }).reasons.length);
    const row = { track: "natural", kind: c.kind, family: c.family, in: c.in, feasible, first: { raw: f.r.raw ?? null, outcome: j.outcome, cls: j.cls || null, reasons: j.reasons, ms: f.r.ms } };
    if (j.outcome === "refused" && f.r.raw != null) {
      const decision = sentenceRetryDecision(j.reasons);
      const keeps = j.evidence ? sentenceRetryKeepList(j.evidence, c.in) : [];
      row.bucket = !decision.retry ? "no-retry:" + decision.reason : keeps.length ? "eligible-keeps" : "eligible-no-keeps";
      row.ref = { firstRaw: f.r.raw, reasons: j.reasons, evidence: j.evidence, keeps };
    }
    rows.push(row);
  }
}
if (!RESCORE && TRACK !== "natural") {
  for (const h of hazards) {
    const j = judge(h, h.bad);
    const row = { track: "challenge", kind: h.kind, family: h.family, in: h.in, bad: h.bad, feasible: true,
                  first: { raw: h.bad, outcome: j.outcome, cls: j.cls || null, reasons: j.reasons, ms: null } };
    if (j.outcome === "refused") {
      const decision = sentenceRetryDecision(j.reasons);
      const keeps = j.evidence ? sentenceRetryKeepList(j.evidence, h.in) : [];
      row.bucket = !decision.retry ? "no-retry:" + decision.reason : keeps.length ? "eligible-keeps" : "eligible-no-keeps";
      row.ref = { firstRaw: h.bad, reasons: j.reasons, evidence: j.evidence, keeps };
    } else row.bucket = "guards-pass-known-bad";   // a leak in the guards, recorded, not retried
    rows.push(row);
  }
}
const todo = RESCORE ? [] : rows.filter((r) => r.ref && r.bucket.startsWith("eligible"));
console.error(`retry cases: ${todo.length} (${rows.filter((r) => r.bucket === "eligible-keeps").length} keeps, ${rows.filter((r) => r.bucket === "eligible-no-keeps").length} no-keeps); draws ${todo.length * ARMS.length * N}`);
const jobs = [];
for (const row of todo) {
  const c = row.track === "challenge" ? hazards.find((h) => h.family === row.family) : cases.find((x) => x.family === row.family && x.in === row.in);
  row.arms = {};
  row._bodies = {};
  for (const a of ARMS) {
    const body = buildArm(a, c, row.ref);
    row.arms[a] = { alias: body ? null : "feedback", draws: [] };
    if (body) row._bodies[a] = body;
  }
  const rnd = lcg(createHash("md5").update(row.in).digest().readUInt32LE(0));
  for (let s = 0; s < N; s++) {
    const order = ARMS.filter((a) => row._bodies[a]).sort(() => rnd() - 0.5);
    for (const a of order) jobs.push({ row, c, a, s, seed: 1000 + s });
  }
}
let done = 0;
await pool(jobs, async (jb) => {
  const r = await ask(jb.row._bodies[jb.a], jb.seed);
  const j = r.error ? { outcome: "error", reasons: [r.error] } : judge(jb.c, r.raw);
  jb.row.arms[jb.a].draws[jb.s] = { seed: jb.seed, raw: r.raw ?? null, outcome: j.outcome, cls: j.cls || null, reason: j.reasons[0] || null,
    same: r.raw === jb.row.ref.firstRaw, ms: Math.round(r.ms), promptTokens: r.promptTokens ?? null,
    keepsHonored: jb.row.ref.keeps.length ? jb.row.ref.keeps.every((k) => (r.raw || "").includes(k)) : null };
  if (++done % 200 === 0) console.error(`${done}/${jobs.length}`);
}, CONC);
for (const row of rows) {
  delete row._bodies;
  for (const a of ARMS) if (row.arms?.[a]?.alias) row.arms[a].draws = row.arms[row.arms[a].alias].draws;
}
writeFileSync(OUT, JSON.stringify({ meta, rows }, null, 1));

// --- summary ------------------------------------------------------------------
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "-";
const BAD = ["known-bad", "known-bad-edit", "clean-meddle", "unadjudicated"];
function seqPolicy(draws, maxRetries) {
  for (let k = 0; k < Math.min(maxRetries, draws.length); k++) {
    const d = draws[k]; if (!d) break;
    if (d.outcome === "applied") return { stop: k + 1, result: d.cls };
    if (d.outcome === "no-op") return { stop: k + 1, result: "no-op" };
    if (d.outcome === "error") return { stop: k + 1, result: "error" };
  }
  return { stop: maxRetries, result: "refused" };
}
for (const track of ["natural", "challenge"]) {
  const T = rows.filter((r) => r.track === track);
  if (!T.length) continue;
  console.log(`\n${"=".repeat(96)}\n${track.toUpperCase()} TRACK  model ${MODEL} (${meta.digest?.slice(0, 12)})  ollama ${meta.ollama?.version}  n=${N}`);
  if (track === "natural") {
    const byKind = {};
    for (const r of T) { byKind[r.kind] ??= { n: 0, refused: 0, infeasible: 0 }; byKind[r.kind].n++; if (r.ref) byKind[r.kind].refused++; if (!r.feasible) byKind[r.kind].infeasible++; }
    const buckets = T.reduce((m, r) => { if (r.bucket) m[r.bucket] = (m[r.bucket] || 0) + 1; return m; }, {});
    console.log("first pass:", JSON.stringify(byKind), " buckets:", JSON.stringify(buckets));
  } else {
    console.log(`hazards ${T.length}: buckets ${JSON.stringify(T.reduce((m, r) => { m[r.bucket] = (m[r.bucket] || 0) + 1; return m; }, {}))}`);
  }
  for (const bucket of ["eligible-keeps", "eligible-no-keeps"]) {
    const R = T.filter((r) => r.bucket === bucket); if (!R.length) continue;
    const feasible = R.filter((r) => r.feasible);
    console.log(`\n-- ${bucket}: ${R.length} refusals (${feasible.length} with a guard-passable target)`);
    console.log("arm        | per-draw: full partial  other meddle known-bad bad-edit unadj  no-op refused  err | same  keeps-ok | ms p50/p95 | seq max1..4: full/bad");
    for (const a of ARMS) {
      const draws = R.flatMap((r) => r.arms[a].draws.filter(Boolean));
      const cnt = (k) => draws.filter((d) => d.cls === k).length, oc = (k) => draws.filter((d) => d.outcome === k).length;
      const ms = draws.map((d) => d.ms).sort((x, y) => x - y);
      const seq = [1, 2, 3, 4].map((m) => {
        let full = 0, bad = 0;
        for (const r of R) { const p = seqPolicy(r.arms[a].draws, m); if (p.result === "full-salvage") full++; if (BAD.includes(p.result)) bad++; }
        return `${full}/${bad}`;
      }).join(" ");
      console.log(`${a.padEnd(10)} | ${String(cnt("full-salvage")).padStart(4)} ${String(cnt("mechanical-partial")).padStart(7)} ${String(cnt("applied-other")).padStart(6)} ${String(cnt("clean-meddle")).padStart(6)} ${String(cnt("known-bad")).padStart(9)} ${String(cnt("known-bad-edit")).padStart(8)} ${String(cnt("unadjudicated")).padStart(5)} ${String(oc("no-op")).padStart(6)} ${String(oc("refused")).padStart(7)} ${String(oc("error")).padStart(4)} | ${pct(draws.filter((d) => d.same).length, draws.length).padStart(5)} ${pct(draws.filter((d) => d.keepsHonored).length, draws.filter((d) => d.keepsHonored != null).length).padStart(8)} | ${ms[ms.length >> 1]}/${ms[Math.floor(ms.length * 0.95)]} | ${seq}`);
    }
    console.log("per-case over all n draws: full-only / bad-only / both / neither");
    for (const a of ARMS) {
      let f = 0, b = 0, both = 0, none = 0;
      for (const r of R) {
        const ds = r.arms[a].draws.filter(Boolean);
        const hf = ds.some((d) => d.cls === "full-salvage"), hb = ds.some((d) => BAD.includes(d.cls));
        if (hf && hb) both++; else if (hf) f++; else if (hb) b++; else none++;
      }
      console.log(`  ${a.padEnd(10)} ${f} / ${b} / ${both} / ${none}`);
    }
  }
}
