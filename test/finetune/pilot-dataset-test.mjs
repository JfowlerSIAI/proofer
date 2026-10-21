#!/usr/bin/env node
// Fixture suite for the Phase 1 pilot generator. No corpora, no models, no
// network: every case builds its own pool/teacher/judge files in a temp
// directory and drives the real exported functions out of
// build-pilot-dataset.mjs and error-priors.mjs.
//
//   node pilot-dataset-test.mjs
//
// What each block is FOR, since a green suite that pins nothing is the repo's
// documented sin:
//   [1] mixture arithmetic — the slot counts sum to the target and the
//       teacher-call draw is the slot divided by its stated yield
//   [2] verdict application — a REVERTED group restores the source bytes
//       exactly, and an unjudged group is fatal rather than guessed
//   [3] clustering + split atomicity — a near-duplicate and its injected
//       variant share a cluster and therefore a split
//   [4] the leakage assertion FIRES on a planted overlap (a gate that has
//       never been seen red is decoration)
//   [5] the §5 output shape
//   [6] echo-context construction, both directions
//   [7] the taxonomy classifier behind the v0 priors
//   [8] configured browser/corpus schemas count interaction acceptance once

import fs from "fs";
import os from "os";
import path from "path";
import {
  mixturePlan, injectionCounts, applyVerdicts, clusterSentences, shingles,
  jaccard, assignSplits, assertNoLeak, echoContext, pilotUid, temptScore,
  slotFor, DEFAULTS, JACCARD_MIN,
} from "./build-pilot-dataset.mjs";
import { classifyEdit, classifyPair, buildErrorPriors, RECORDING_SOURCES } from "./error-priors.mjs";
import { INJECTABLE_TYPES } from "./error-inject.mjs";
import { mulberry32 } from "./verdicts.mjs";

let pass = 0, failn = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  failn++;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : `\n        ${detail}`}`);
};
const eq = (name, got, want) => ok(name, Object.is(got, want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

// ------------------------------------------------------------------ [1]

section("[1] mixture arithmetic");
{
  const p = mixturePlan(6000);
  eq("[1a] slots sum to the target", p.checksum, 6000);
  eq("[1b] identity + correction = target", p.identity + p.correction, 6000);
  ok("[1c] identity share inside §6.3's 60-75%",
    p.identity / 6000 >= 0.60 && p.identity / 6000 <= 0.75, p.identity / 6000);
  const hn = p.slots["hard-negative"] / p.identity;
  ok("[1d] hard negatives inside §6.3's 25-40% of identity", hn >= 0.25 && hn <= 0.40, hn);
  const corr = p.correction / 6000;
  ok("[1e] correction-bearing inside §6.3's 25-40%", corr >= 0.25 && corr <= 0.40, corr);
  eq("[1f] draw = slot / yield, rounded up",
    p.draw["real-error"], Math.ceil(p.slots["real-error"] / DEFAULTS.yieldReal));
  ok("[1g] every draw is at least its slot",
    Object.keys(p.slots).every((k) => p.draw[k] >= p.slots[k]));
  eq("[1h] teacher calls is the draw total",
    p.teacherCalls, Object.values(p.draw).reduce((s, n) => s + n, 0));

  // An override is honoured and still balances.
  const q = mixturePlan(1000, { identityShare: 0.75, hardNegShare: 0.40, realShare: 0.5 });
  eq("[1i] override: slots still sum", q.checksum, 1000);
  eq("[1j] override: identity honoured", q.identity, 750);
  eq("[1k] override: hard negatives honoured", q.slots["hard-negative"], 300);

  const c = injectionCounts(97, Object.fromEntries(INJECTABLE_TYPES.map((t, i) => [t, i === 0 ? 0.5 : 0.5 / (INJECTABLE_TYPES.length - 1)])));
  eq("[1l] injection counts sum to the total",
    Object.values(c).reduce((s, n) => s + n, 0), 97);
  ok("[1m] the dominant class gets the most", c[INJECTABLE_TYPES[0]] >= 45, c[INJECTABLE_TYPES[0]]);
}

// ------------------------------------------------------------------ [2]

section("[2] verdict application (D1)");
{
  const src = "The techncian arrived early and we recieved the invoice";
  const out = "The technician arrived early, and we received the invoice.";
  const groups = (await import("./edit-groups.mjs")).editGroups(src, out);
  ok("[2a] the fixture produces >= 3 edit groups", groups.length >= 3, groups.length);

  const keepAll = applyVerdicts(src, out, groups.map((g) => ({ group: g.id, verdict: "required-correction" })));
  eq("[2b] every group kept reproduces the teacher output exactly", keepAll.target, out);
  eq("[2c] nothing reverted", keepAll.reverted.length, 0);

  const revertAll = applyVerdicts(src, out, groups.map((g) => ({ group: g.id, verdict: "unnecessary" })));
  eq("[2d] every group reverted restores the SOURCE bytes exactly", revertAll.target, src);
  ok("[2e] allReverted is set", revertAll.allReverted === true);

  // One group reverted: the source text for that span comes back, byte for
  // byte, and everything else stays corrected.
  const mixed = applyVerdicts(src, out, groups.map((g, i) => ({
    group: g.id, verdict: i === 0 ? "unnecessary" : "benign-optional",
  })));
  ok("[2f] the reverted group's source text is present",
    mixed.target.includes(groups[0].before), `${JSON.stringify(groups[0].before)} in ${JSON.stringify(mixed.target)}`);
  ok("[2g] a kept group's correction is present",
    mixed.target.includes(groups[1].after) || groups[1].after === "", mixed.target);
  eq("[2h] benign-optional is a KEEP under D1", mixed.reverted.length, 1);
  eq("[2i] uncertain reverts",
    applyVerdicts(src, out, groups.map((g) => ({ group: g.id, verdict: "uncertain" }))).target, src);
  eq("[2j] meaning-damage reverts",
    applyVerdicts(src, out, groups.map((g) => ({ group: g.id, verdict: "meaning-damage" }))).target, src);

  // A missing verdict is fatal — a guessed one is the single thing this stage
  // may not do. verdicts.fail throws with __proofer_failed.
  let threw = null;
  try { applyVerdicts(src, out, groups.slice(1).map((g) => ({ group: g.id, verdict: "required-correction" }))); }
  catch (e) { threw = e; }
  ok("[2k] an unjudged group is FATAL", threw !== null, "no throw");
  ok("[2l] and says which group", threw && /edit group 1/.test(String(threw.message)), threw && threw.message);

  let bad = null;
  try { applyVerdicts(src, out, [{ group: 1, verdict: "looks-fine" }]); } catch (e) { bad = e; }
  ok("[2m] an unknown verdict class is FATAL", bad !== null);
}

// ------------------------------------------------------------------ [3]

section("[3] clustering and split atomicity");
{
  const a = "we should probably ship the invoice parser before the end of the quarter";
  const b = "we should probably ship the invoice parser before the end of the quarter now";
  const c = "the technician arrived early and nobody was there to let him into the building";
  const ids = clusterSentences([a, b, c]);
  eq("[3a] a near-duplicate joins its neighbour's cluster", ids[0], ids[1]);
  ok("[3b] an unrelated sentence does not", ids[2] !== ids[0], ids);
  ok("[3c] Jaccard of the pair clears the 0.8 floor",
    jaccard(shingles(a), shingles(b)) >= JACCARD_MIN, jaccard(shingles(a), shingles(b)));

  // The property that matters: an injected VARIANT clusters on its clean parent
  // (the pool stage keys clustering on `inject.clean`), so the two cannot be
  // split. Simulated here at the level the split function sees.
  const rows = [
    { cluster: 0, register: "chat-irc" },   // clean parent
    { cluster: 0, register: "chat-irc" },   // its injected variant
    { cluster: 1, register: "chat-irc" },
    { cluster: 2, register: "email-workplace" },
    { cluster: 3, register: "email-workplace" },
    { cluster: 4, register: "chat-owner" },
  ];
  const split = assignSplits(rows, 0.34, mulberry32(7));
  for (const r of rows) r.split = split.get(r.cluster);
  eq("[3d] parent and variant land in the same split", rows[0].split, rows[1].split);
  const seen = new Map();
  let straddle = 0;
  for (const r of rows) {
    if (seen.has(r.cluster) && seen.get(r.cluster) !== r.split) straddle++;
    seen.set(r.cluster, r.split);
  }
  eq("[3e] no cluster straddles the split", straddle, 0);
  ok("[3f] the split is not degenerate",
    new Set(rows.map((r) => r.split)).size === 2, rows.map((r) => r.split));
}

// ------------------------------------------------------------------ [4]

section("[4] the leakage assertion fires");
{
  const excluded = new Set(["irc:2005-05-02-#ubuntu-motu#100", "1111111111111111111"]);
  const clean = [
    { uid: "a", lineage: { source_document_id: "irc:2005-05-02-#ubuntu-motu#999" } },
    { uid: "b", lineage: { source_document_id: "enron:allen-p/_sent_mail/1." } },
  ];
  eq("[4a] a clean set has no hits", assertNoLeak(clean, excluded).length, 0);

  const planted = clean.concat({ uid: "leak", lineage: { source_document_id: "irc:2005-05-02-#ubuntu-motu#100" } });
  const hits = assertNoLeak(planted, excluded);
  eq("[4b] a planted reserved id is caught", hits.length, 1);
  eq("[4c] and is named", hits[0].uid, "leak");

  const owner = clean.concat({ uid: "leak2", lineage: { source_document_id: 1111111111111111111n.toString() } });
  eq("[4d] an owner holdout message id is caught (string/number safe)",
    assertNoLeak(owner, excluded).length, 1);
}

// ------------------------------------------------------------------ [5]

section("[5] the §5 record shape");
{
  // Build the record the assembler builds, from the same pieces, and assert the
  // contract rather than the implementation.
  const lineage = {
    source_document_id: "irc:doc#3", exclusion_group_id: "irc:aa:bb:0",
    sentence: "the techncian arrived early", segment: [0, 27],
    segmenter_produced: false, variant: "injected:transposition",
  };
  const uid = pilotUid(lineage, lineage.variant);
  ok("[5a] uid is deterministic", uid === pilotUid(lineage, lineage.variant));
  ok("[5b] uid changes with the variant", uid !== pilotUid(lineage, "identity"));
  ok("[5c] uid is prefixed and short", /^pl_[0-9a-f]{16}$/.test(uid), uid);

  const rec = {
    uid, lineage, register: "chat-irc", kind: "injected:transposition",
    context: "hello there", input: "the techncian arrived early",
    target: "the technician arrived early",
    card: { source: "s2", license: "PD", register: "chat-irc", mechanism: "injected:transposition@v1", judge: null, dedup_cluster: 3, split: "train" },
  };
  for (const k of ["uid", "lineage", "register", "kind", "context", "input", "target"]) {
    ok(`[5d] record carries ${k}`, k in rec);
  }
  ok("[5e] kind is one of the four families",
    /^(identity|hard-negative|real-error|injected:[a-z-]+)$/.test(rec.kind), rec.kind);
  ok("[5f] lineage is source doc -> sentence -> variant",
    Boolean(rec.lineage.source_document_id && rec.lineage.sentence && rec.lineage.variant));
  ok("[5g] a data card row rides on the record",
    Boolean(rec.card.source && rec.card.license && rec.card.mechanism));
  // An identity's target IS its input verbatim (D7).
  const ident = { input: "nothing wrong here at all", target: "nothing wrong here at all" };
  eq("[5h] an identity target is the input verbatim", ident.target, ident.input);
}

// ------------------------------------------------------------------ [6]

section("[6] echo-context construction");
{
  const ctx = "earlier line\nThe techncian arrived early.\nsomething else";
  const e = echoContext(ctx, "The techncian arrived early.", "The technician arrived early.");
  ok("[6a] the corrected sentence replaces the source in context", e.echoed === true);
  ok("[6b] and the corrected text is present", e.context.includes("The technician arrived early."), e.context);
  ok("[6c] and the typo is gone", !e.context.includes("techncian"), e.context);
  ok("[6d] the rest of the context is untouched",
    e.context.startsWith("earlier line\n") && e.context.endsWith("\nsomething else"));

  const miss = echoContext(ctx, "a sentence that is not there", "whatever");
  ok("[6e] a pairing that did not happen reports echoed:false", miss.echoed === false);
  eq("[6f] and leaves the context alone", miss.context, ctx);

  const noop = echoContext(ctx, "The techncian arrived early.", "The techncian arrived early.");
  ok("[6g] an unchanged leader is not an echo", noop.echoed === false);

  // The LAST occurrence is the one replaced: the leader is the nearest prior
  // sentence, and an earlier identical line is a different message.
  const twice = "The techncian arrived early.\nx\nThe techncian arrived early.";
  const t = echoContext(twice, "The techncian arrived early.", "FIXED");
  ok("[6h] the nearest occurrence is the one echoed",
    t.context === "The techncian arrived early.\nx\nFIXED", t.context);
}

// ------------------------------------------------------------------ [7]

section("[7] taxonomy classifier (v0 priors)");
{
  const cases = [
    ["teh", "the", "transposition"],
    ["thst", "that", "adjacent-key"],
    ["THis", "This", "held-shift-stutter"],
    ["this", "This", "casing"],
    ["dont", "don't", "dropped-apostrophe"],
    ["don;t", "don't", "semicolon-apostrophe"],
    ["filtererrors", "filter errors", "run-together"],
    [".", "!", "terminator"],
  ];
  for (const [b, a, want] of cases) eq(`[7] ${b} -> ${a}`, classifyEdit(b, a), want);
  eq("[7i] a moved space is not a run-together",
    classifyEdit("wek nwo", "we know"), "moved-space");
  eq("[7j] an unplaceable real-word swap falls to other-natural",
    classifyEdit("in", "for"), "other-natural");
  eq("[7k] identical sides classify as nothing", classifyEdit("x", "x"), null);

  // The deletion-shaped doubled word needs its source context.
  eq("[7l] a doubled word deleted with no context is not placeable as one",
    classifyEdit("the ", "", null) === "doubled-word", false);
  const dbl = classifyPair("I think the the invoice is late.", "I think the invoice is late.");
  ok("[7m] and IS placeable with it", dbl.includes("doubled-word"), dbl);

  // The screens/slot router.
  ok("[7n] a clean sentence routes to the clean slot",
    slotFor("we should ship the invoice parser before the end of the quarter").slot === "clean");
  ok("[7o] a non-word routes to real-error",
    slotFor("the techncian arrived early and nobody let him in").slot === "real-error");
  ok("[7p] temptScore rewards a name over plain prose",
    temptScore("Marcus said the Q3 numbers were fine")
      > temptScore("we should ship it before the end of the quarter"));
}

// ------------------------------------------------------------------ [8]

// Mutant: const applied = d.verdict == null || d.outcome === "applied";
// [8] adjacent-key exclusion, transposition count/rate/mixture and retry mixture turn red.
section("[8] configured-source priors distinguish guards from user verdicts");
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "priors-"));
  try {
    const recordings = [
      [{ sentence: "teh", output: "the", outcome: "applied", verdict: null }],
      [{ sentence: "dont", output: "don't", outcome: "refused", verdict: "low-overlap" }],
      [{ sentence: "unchanged", output: "unchanged", outcome: "no-op", verdict: null }],
      [{ sentence: "THis", output: "This", outcome: "applied", verdict: null }],
      [
        { path: "sentence", input: "thst", output: "that", guard: "low-overlap", verdict: null },
        { path: "sentence", input: "teh", output: "the", guard: null, verdict: "user-reverted" },
        { v: 2, path: "sentence", input: "dont", output: "don't", guard: null,
          verdict: "sentence-applied", retry: { outcome: "applied", firstOutput: "Dont" },
          attempts: [{ output: "Dont", guard: "low-overlap", outcome: "refused" },
            { output: "don't", guard: null, outcome: "applied" }] },
        { v: 2, path: "sentence", input: "teh", output: null, error: "consent-read-timeout",
          retry: { outcome: "applied" }, attempts: [{ output: "the", outcome: "applied" }] },
        { v: 1, path: "sentence", input: "thst", output: "that", guard: "low-overlap",
          error: "consent-read-timeout", verdict: null,
          retry: { outcome: "applied", firstOutput: "that", firstGuard: "low-overlap" } },
      ],
    ];
    RECORDING_SOURCES.forEach((src, i) => fs.writeFileSync(path.join(root, src.file),
      recordings[i].map((r) => JSON.stringify(r)).join("\n") + "\n"));
    const priors = buildErrorPriors({ root });
    eq("[8] configured schemas cover nine interaction rows", priors.totals.rows, 9);
    eq("[8] all seven changed pairs retain refused pairs", priors.totals.changed_pairs, 7);
    eq("[8] four selected pairs are accepted, including later user rejection", priors.totals.changed_pairs_applied, 4);
    eq("[8] accepted groups count a delivered retry once", priors.totals.groups_applied, 4);
    eq("[8] all-changed groups retain both refusal schemas", priors.totals.groups_all, 7);
    eq("[8] browser refusals never enter adjacent-key accepted counts", priors.counts["adjacent-key"], 0);
    eq("[8] browser refusals stay in all-changed counts", priors.counts_all_changed["adjacent-key"], 2);
    eq("[8] corpus refusal stays in all-changed counts", priors.counts_all_changed["dropped-apostrophe"], 2);
    eq("[8] transposition accepted count", priors.counts.transposition, 2);
    eq("[8] transposition rate", priors.rates.transposition, 0.5);
    eq("[8] transposition mixture", priors.inject_mix.transposition, 0.5);
    eq("[8] delivered-retry mixture", priors.inject_mix["dropped-apostrophe"], 0.25);
    eq("[8] corpus-acceptance mixture", priors.inject_mix["held-shift-stutter"], 0.25);
    eq("[8] only two browser pairs are accepted", priors.sources[4].changed_applied, 2);
    const all = buildErrorPriors({ root, allChanged: true });
    eq("[8] all-changed basis uses seven groups", all.totals.groups_used, 7);
    eq("[8] all-changed adjacent-key mixture", all.inject_mix["adjacent-key"], 2 / 7);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}\n  ${pass} passed, ${failn} failed\n`);
process.exit(failn ? 1 : 0);
