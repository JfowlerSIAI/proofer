#!/usr/bin/env node
// Assembles the Terra-calibration example set (plan §4).
//
//   # stage 1 — candidate pool (no model calls)
//   node calibration-sample.mjs [--pool 1400] [--seed N]
//
//   # stage 2 — after the owner runs teacher-pass over the candidates
//   node calibration-sample.mjs --stratify <teacher-results.jsonl>
//
//   # migration — after the SCRUBBED CORPUS is regenerated under new rules
//   node calibration-sample.mjs --migrate [--dry-run]
//
// WHY THE SCRUBBED CORPUS AND NOT THE RAW ONE. The source is
// test/harvested/finetune/s1-scrubbed.jsonl, deliberately. Under D2 the training
// set is the SCRUBBED owner corpus, so scrubbed text is what the teacher will be
// run over and what the judge will see in production. Calibrating the judge on
// raw text would measure it on a distribution it never encounters: scrubbing
// replaces mentions, URLs, handles and server/channel names with pseudonym
// tokens (USER_1, CHANREF_2, URL), and those tokens are exactly the shapes the
// `protected-token` guard and the `meaning-damage` class turn on. A judge
// calibrated on `@realname` and deployed on `USER_1` has been calibrated on the
// wrong question. The scrub also preserves `ts` and `channel_pseudo`, which is
// what lets the episode reconstruction below be the real one rather than an
// approximation.
//
// EPISODE LOGIC IS REUSED, NOT REIMPLEMENTED. `channelIndex` and `targetsFor`
// are imported from test/harvested/discord-source.mjs — the same 30-minute,
// same-channel window that built every existing holdout — by mapping the
// scrubbed rows' `server_pseudo`/`channel_pseudo` onto the `server`/`channel`
// fields that function already reads. A second copy of the window logic is how
// a calibration set stops being comparable to the holdouts it is meant to
// stand beside.
//
// STAGE 2 selects at the EDIT-GROUP level from the teacher's actual outputs,
// because §4's 400 judgments are per edit group and the interesting strata
// (fluent real-word -> real-word) are properties of an edit, not of a sentence.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  channelIndex, targetsFor, typoTokens, loadDictionary,
} from "../harvested/discord-source.mjs";
import { fetchConfusables, diskFetch, CONFUSABLE, isWord } from "../lib/sentence-guards.mjs";
import { editGroups } from "./edit-groups.mjs";
import {
  readJsonl, writeJsonl, argOf, hasFlag, fail, mulberry32, shuffled,
} from "./verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, "..", "harvested", "finetune");
const S1 = path.join(ART, "s1-scrubbed.jsonl");

const SEED = Number(process.env.PROOFER_SEED || argOf("--seed", "20260820")) >>> 0;
const POOL = Number(argOf("--pool", "1400"));
const STRATIFY = argOf("--stratify");
const EXTEND = argOf("--extend-tempting");
const MIGRATE = hasFlag("--migrate");
const DRY = hasFlag("--dry-run");
const FINAL_N = Number(argOf("--final", "400"));
const DEV_N = Number(argOf("--dev-n", "250"));

// §4's requested pool composition. Disjoint by construction — a target is
// assigned to exactly one stratum, screen first, so the "uniform" arm really is
// the unconditioned remainder rather than a superset diluted with the others.
const WANT = { screen: 400, tempting: 300, uniform: 700 };

// Stage-2 composition, §4 as amended.
const FLUENT_FLOOR = 0.35;      // >= 35% fluent real-word -> real-word
const REFUSED_SHARE = 0.10;     // ~10% guard-refused controls
const NOOP_SHARE = 0.05;        // ~5% teacher no-op controls

const PSEUDONYM = /\b(?:USER|SERVER|CHANNEL|CHANREF|ROLE|EMAIL|PHONE)_\d+\b|\bURL\b/;
const HAS_NUMBER = /\d/;


// ============================================================== stage 1

/**
 * Every sentence target in the scrubbed corpus, with its prior context. Shared
 * by stage 1 and stage 1b so the extension draws from the identical enumeration
 * the original pool was drawn from — a second walk that agrees today is how a
 * "deduped" extension quietly re-offers a uid under a different segmentation.
 */
async function allTargets() {
  if (!fs.existsSync(S1)) {
    fail(`scrubbed corpus not found: ${S1}\n` +
         `  Produce it with the S1 scrubber first (Phase 0.5). Calibration must be drawn from\n` +
         `  the SCRUBBED distribution — see this file's header for why.`);
  }
  const rows = readJsonl(S1, "scrubbed corpus");
  const msgs = [];
  let noContent = 0;
  for (const r of rows) {
    if (!r || typeof r.content !== "string" || !r.content.trim()) { noContent++; continue; }
    msgs.push({
      message_id: r.message_id, ts: r.ts, timestamp: r.timestamp,
      server: r.server_pseudo, channel: r.channel_pseudo, content: r.content,
    });
  }
  msgs.sort((a, b) => a.ts - b.ts);
  const byChannel = channelIndex(msgs);
  const targets = [];
  const seenUid = new Set();
  for (const m of msgs) {
    for (const t of targetsFor(m, byChannel)) {
      if (seenUid.has(t.uid)) continue;
      seenUid.add(t.uid);
      targets.push(t);
    }
  }
  return { targets, msgs, byChannel, noContent, DICT: loadDictionary() };
}

async function buildPool() {
  const { targets, msgs, byChannel, noContent, DICT } = await allTargets();
  const licensed = await licensedConfusableWords();

  // Classify every target once.
  const screen = [], tempting = [], plain = [];
  for (const t of targets) {
    if (typoTokens(t.sentence, DICT).length) { screen.push(t); continue; }
    const score = temptScore(t.sentence, licensed);
    if (score > 0) { t._tempt = score; tempting.push(t); continue; }
    plain.push(t);
  }

  const rnd = mulberry32(SEED);
  const pick = (list, n) => shuffled(list, rnd).slice(0, n);

  const chosenScreen = pick(screen, WANT.screen);

  // RANK, do not merely filter. Any-one-signal catches two thirds of the corpus
  // — a sentence with a digit in it qualifies — so drawing 300 uniformly from
  // that set is very nearly the uniform arm under a second name, and the two
  // strata would measure the same thing. Draw from the densest band first and
  // fall back down, so the arm is actually enriched for the shape it is named
  // after. The band sizes are printed, because a stratum whose enrichment
  // failed should say so rather than look like a stratum.
  const byBand = new Map();
  for (const t of tempting) {
    const b = Math.min(t._tempt, 3);
    if (!byBand.has(b)) byBand.set(b, []);
    byBand.get(b).push(t);
  }
  const chosenTempt = [];
  for (const band of [3, 2, 1]) {
    if (chosenTempt.length >= WANT.tempting) break;
    chosenTempt.push(...pick(byBand.get(band) || [], WANT.tempting - chosenTempt.length));
  }
  // Uniform draws from EVERYTHING not already chosen, including screen and
  // tempting members: it is the unconditioned arm, and excluding those classes
  // from it would make it a "clean text" arm under a name that claims otherwise.
  const taken = new Set([...chosenScreen, ...chosenTempt].map((t) => t.uid));
  const rest = targets.filter((t) => !taken.has(t.uid));
  const chosenUniform = pick(rest, Math.min(WANT.uniform, Math.max(0, POOL - chosenScreen.length - chosenTempt.length)));

  const out = [];
  const emit = (list, stratum) => {
    for (const t of list) {
      out.push({
        uid: t.uid, sentence: t.sentence, context: t.context,
        stratum, message_id: t.message_id, channel: t.channel, ts: t.ts ?? null,
      });
    }
  };
  emit(chosenScreen, "screen");
  emit(chosenTempt, "tempting");
  emit(chosenUniform, "uniform");

  const dest = path.join(ART, "calibration-candidates.jsonl");
  // The candidates file is APPEND-ONLY once a teacher pass exists against it:
  // every teacher row is keyed by a uid drawn here, and re-drawing the pool
  // silently invalidates all of them (teacher-pass resumes by uid, so the
  // damage shows up as a pass that reruns everything or, worse, as a stage-2
  // join that quietly drops rows). Learned the direct way — this overwrote a
  // 1,400-row draw that a real teacher pass had already been run against, and
  // it was only recoverable because teacher-pass carries the candidate fields
  // through on every row. Widen with --extend-tempting instead.
  if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8").trim() && !hasFlag("--overwrite")) {
    fail(`${dest} already exists.\n` +
         `  Re-drawing the pool invalidates every teacher row keyed to the current uids.\n` +
         `  To WIDEN it:      node calibration-sample.mjs --extend-tempting auto\n` +
         `  To start over:    node calibration-sample.mjs --overwrite   (discards that association)`);
  }
  writeJsonl(dest, out);

  console.log("\nCalibration candidate pool  (stage 1 — no model calls)");
  console.log("=".repeat(72));
  console.log(`  seed             ${SEED}`);
  console.log(`  source           ${S1}`);
  console.log(`  messages         ${msgs.length}${noContent ? `   (${noContent} row(s) had no content)` : ""}`);
  console.log(`  channels         ${byChannel.size}`);
  console.log(`  sentence targets ${targets.length}   (30-min same-channel episodes, MIN_SENTENCE_CHARS..500)`);
  console.log(`  confusable words ${licensed.size} licensed forms`);
  console.log("");
  console.log(`  stratum      available     wanted     drawn`);
  console.log(`  ${"-".repeat(46)}`);
  console.log(`  screen       ${String(screen.length).padStart(9)}  ${String(WANT.screen).padStart(9)}  ${String(chosenScreen.length).padStart(8)}`);
  console.log(`  tempting     ${String(tempting.length).padStart(9)}  ${String(WANT.tempting).padStart(9)}  ${String(chosenTempt.length).padStart(8)}`);
  console.log(`    signal bands: ` + [3, 2, 1].map((b) =>
    `${b}+=${(byBand.get(b) || []).length}`).join("  ") +
    `   drawn from ${[3, 2, 1].filter((b) => (byBand.get(b) || []).length && chosenTempt.some((t) => Math.min(t._tempt, 3) === b)).join("/") || "-"}`);
  console.log(`  uniform      ${String(rest.length).padStart(9)}  ${String(WANT.uniform).padStart(9)}  ${String(chosenUniform.length).padStart(8)}`);
  console.log(`  ${"-".repeat(46)}`);
  console.log(`  total        ${String(targets.length).padStart(9)}  ${String(POOL).padStart(9)}  ${String(out.length).padStart(8)}`);
  console.log(`  plain (unscreened, untempting) ${plain.length}`);
  console.log(`\n  written to       ${dest}`);
  console.log(`\n  NEXT (owner, GPU): node teacher-pass.mjs --in ${path.relative(process.cwd(), dest)} \\`);
  console.log(`                       --out ${path.relative(process.cwd(), path.join(ART, "calibration-teacher.jsonl"))}`);
  console.log(`  THEN:               node calibration-sample.mjs --stratify <that file>`);

  for (const [name, want, got] of [["screen", WANT.screen, chosenScreen.length],
                                   ["tempting", WANT.tempting, chosenTempt.length],
                                   ["uniform", WANT.uniform, chosenUniform.length]]) {
    if (got < want) console.log(`\n  SHORT: stratum ${name} wanted ${want} and the corpus supplied ${got}.`);
  }
  if (!out.length) fail("drew zero candidates — an empty pool is not a pool.");
}

/** The "typed" side of every directed confusable licence, hand list + generated. */
export async function licensedConfusableWords() {
  const words = new Set();
  const add = (set) => { for (const pair of set) words.add(String(pair).split("|")[0]); };
  add(CONFUSABLE);
  const loaded = await fetchConfusables(diskFetch());
  if (!loaded) {
    fail("data/confusables-en.txt failed the SHIPPING integrity check.\n" +
         "  The tempting stratum is defined by the licence list; drawing it from a\n" +
         "  half-loaded list would silently change what the stratum means.");
  }
  add(loaded);
  return words;
}

/**
 * How strongly a clean sentence tempts a fluent real-word substitution — the R1
 * class the guards are worst at and §4 asks to be oversampled. Four cheap
 * structural signals, COUNTED rather than or-ed: a word holding a confusable
 * licence (so a swap would be ADMITTED by the guards rather than refused), a
 * pseudonym token, a capitalized non-dictionary token (the entity-damage
 * shape), and a number (the quantity-damage shape).
 *
 * A count, because any single signal is nearly ubiquitous — see the ranking
 * comment at the draw site.
 */
export function temptSignals(sentence, licensed) {
  const sig = { licensed: false, pseudonym: false, number: false, name: false };
  sig.pseudonym = PSEUDONYM.test(sentence);
  sig.number = HAS_NUMBER.test(sentence);
  const toks = sentence.split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const b = toks[i].replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
    if (!b) continue;
    if (licensed.has(b.toLowerCase())) sig.licensed = true;
    // A capitalized token that is not sentence-initial and is not a dictionary
    // word reads as a name the teacher may "correct".
    if (i > 0 && /^\p{Lu}/u.test(b) && !isWord(b.toLowerCase())) sig.name = true;
  }
  sig.score = (sig.licensed ? 1 : 0) + (sig.pseudonym ? 1 : 0) + (sig.number ? 1 : 0) + (sig.name ? 1 : 0);
  return sig;
}

function temptScore(sentence, licensed) {
  return temptSignals(sentence, licensed).score;
}

// ====================================================== stage 1b: extension
//
// Widen the tempting stratum when a real teacher pass comes in under §4's 35%
// fluent floor. APPEND-ONLY: the existing candidates keep their uids and their
// order, so the teacher rows already produced for them stay valid and
// teacher-pass's resume-by-uid runs only the delta.
//
// The draw order is MEASURED, not asserted. The prior was "licensed-confusable
// presence first", and the teacher pass confirms it on the metric that actually
// binds — fluent APPLIED examples per 100 candidates — but only on that metric:
// ranked by fluent GROUPS per candidate, `licensed && band 2` looks best,
// because that cell's fluent groups are concentrated in outputs the guards
// REFUSED, which cannot fill an applied slot. The two rankings disagree, so the
// metric is chosen to match the constraint rather than to be the tidiest
// summary, and thin cells fall back to the prior instead of trusting a rate
// built on single-digit counts.

const MIN_CELL_N = 100;          // below this a measured rate is not a rate

function cellKey(sig) { return (sig.licensed ? "lic" : "nolic") + "/band" + Math.min(sig.score, 3); }

// Prior order, used for cells with too little evidence to rank: licensed
// first, then denser signal bands.
function priorRank(key) {
  const [lic, band] = key.split("/");
  return (lic === "lic" ? 0 : 10) + (4 - Number(band.slice(4)));
}

async function extendTempting() {
  const candPath = path.join(ART, "calibration-candidates.jsonl");
  const teacherPath = argOf("--teacher", path.join(ART, "calibration-teacher.jsonl"));
  if (!fs.existsSync(candPath)) fail(`no candidates file at ${candPath} — run stage 1 first.`);
  if (!fs.existsSync(teacherPath)) {
    fail(`no teacher results at ${teacherPath}.\n` +
         `  The extension is sized from the MEASURED fluent yield of the pass that came in\n` +
         `  under the floor. Sizing it from a guess is how the second pass misses too.`);
  }

  const existing = readJsonl(candPath, "candidates");
  const haveUid = new Set(existing.map((r) => r.uid));
  const byUid = new Map(existing.map((r) => [r.uid, r]));
  const teacher = readJsonl(teacherPath, "teacher results");

  const licensed = await licensedConfusableWords();

  // ---- measure ----
  const cells = new Map();          // key -> {n, fx}
  let fluentEx = 0, fluentGroups = 0, gtF = 0;
  let plainEx = 0, gtP = 0, refusedEx = 0, gtR = 0, noop = 0, errors = 0;
  for (const r of teacher) {
    const c = byUid.get(r.uid);
    if (!c) continue;
    const key = cellKey(temptSignals(c.sentence, licensed));
    if (!cells.has(key)) cells.set(key, { n: 0, fx: 0 });
    cells.get(key).n++;
    if (r.rewritten == null || r.outcome === "error") { errors++; continue; }
    const groups = editGroups(r.sentence, r.rewritten);
    const f = groups.filter(isFluentRealWordSwap).length;
    if (!groups.length) { noop++; continue; }
    if (r.outcome === "refused") { refusedEx++; gtR += groups.length; continue; }
    if (f) { fluentEx++; fluentGroups += f; gtF += groups.length; cells.get(key).fx++; }
    else { plainEx++; gtP += groups.length; }
  }
  if (!fluentEx || !plainEx || !refusedEx) {
    fail(`teacher results are too thin to size an extension ` +
         `(fluent ${fluentEx}, plain ${plainEx}, refused ${refusedEx}).`);
  }

  const gf = fluentGroups / fluentEx;         // fluent groups per fluent example
  const gtf = gtF / fluentEx;                 // total groups per fluent example
  const gtp = gtP / plainEx;                  // total groups per plain applied example
  const gtr = gtR / refusedEx;                // total groups per refused example

  // ---- solve: how many fluent APPLIED examples does the floor need? ----
  const nNoop = Math.round(FINAL_N * NOOP_SHARE);
  const nRef = Math.round(FINAL_N * REFUSED_SHARE);
  const nApplied = FINAL_N - nNoop - nRef;
  let needFluent = null;
  for (let e = 1; e <= nApplied; e++) {
    const fl = e * gf, tot = e * gtf + (nApplied - e) * gtp + nRef * gtr;
    if (fl / tot >= FLUENT_FLOOR) { needFluent = e; break; }
  }
  const ceiling = (nApplied * gf) / (nApplied * gtf + nRef * gtr);
  if (needFluent == null) {
    fail(`the floor is unreachable at these per-example rates: even an all-fluent applied\n` +
         `  set reaches only ${(100 * ceiling).toFixed(1)}% against a ${(100 * FLUENT_FLOOR).toFixed(0)}% floor.\n` +
         `  That is a definition problem, not a sampling one — take it back to §4.`);
  }
  const shortfall = Math.max(0, needFluent - fluentEx);

  // ---- rebuild the pool and rank the cells we can draw from ----
  const { targets, DICT } = await allTargets();
  const pool = new Map();           // cellKey -> candidates
  for (const t of targets) {
    if (haveUid.has(t.uid)) continue;
    if (typoTokens(t.sentence, DICT).length) continue;     // that is the screen stratum
    const sig = temptSignals(t.sentence, licensed);
    if (sig.score < 1) continue;
    const key = cellKey(sig);
    if (!pool.has(key)) pool.set(key, []);
    pool.get(key).push(t);
  }

  const ranked = [...new Set([...cells.keys(), ...pool.keys()])]
    .map((key) => {
      const m = cells.get(key) || { n: 0, fx: 0 };
      const measured = m.n >= MIN_CELL_N;
      return {
        key, n: m.n, fx: m.fx, measured,
        yield: measured ? m.fx / m.n : null,
        available: (pool.get(key) || []).length,
      };
    })
    .filter((c) => c.available > 0)
    .sort((a, b) => (a.measured && b.measured) ? b.yield - a.yield
                  : a.measured ? -1 : b.measured ? 1 : priorRank(a.key) - priorRank(b.key));

  // ---- size N: walk the ranked cells until the projection clears the shortfall ----
  const MARGIN = Number(argOf("--margin", "1.20"));
  const wantProjected = shortfall * MARGIN;
  const plan = [];
  let projected = 0, N = 0;
  const explicitN = EXTEND !== "auto" ? Number(EXTEND) : null;
  if (explicitN != null && !Number.isFinite(explicitN)) fail(`--extend-tempting takes a count or "auto", got ${JSON.stringify(EXTEND)}`);

  for (const c of ranked) {
    if (explicitN == null ? projected >= wantProjected : N >= explicitN) break;
    const y = c.yield ?? 0.02;                 // unmeasured cells: conservative
    const room = explicitN == null
      ? Math.ceil((wantProjected - projected) / Math.max(y, 0.005))
      : explicitN - N;
    const take = Math.min(room, c.available);
    if (take <= 0) continue;
    plan.push({ ...c, take, expect: take * y });
    projected += take * y; N += take;
  }

  const rnd = mulberry32(SEED ^ 0x9e3779b9);
  const drawn = [];
  for (const p of plan) drawn.push(...shuffled(pool.get(p.key), rnd).slice(0, p.take));

  // ---- report the arithmetic BEFORE writing anything ----
  console.log("\nTempting-stratum extension  (stage 1b — no model calls)");
  console.log("=".repeat(76));
  console.log(`  seed             ${SEED}`);
  console.log(`  candidates       ${candPath}   (${existing.length} existing)`);
  console.log(`  teacher results  ${teacherPath}   (${teacher.length} rows)`);
  console.log("");
  console.log(`  MEASURED per-example rates from the pass that missed the floor`);
  console.log(`    fluent applied examples          ${fluentEx}`);
  console.log(`    fluent groups per fluent example ${gf.toFixed(3)}`);
  console.log(`    total  groups per fluent example ${gtf.toFixed(3)}`);
  console.log(`    total  groups per plain  example ${gtp.toFixed(3)}`);
  console.log(`    total  groups per refused example ${gtr.toFixed(3)}`);
  console.log(`    (${noop} no-op, ${errors} error, ${refusedEx} refused, ${plainEx} plain applied)`);
  console.log("");
  console.log(`  SOLVE for the floor at ${FINAL_N} examples = ${nApplied} applied + ${nRef} refused + ${nNoop} no-op`);
  console.log(`    need e fluent applied examples with`);
  console.log(`      e*${gf.toFixed(3)} / (e*${gtf.toFixed(3)} + (${nApplied}-e)*${gtp.toFixed(3)} + ${nRef}*${gtr.toFixed(3)}) >= ${FLUENT_FLOOR}`);
  console.log(`    -> e = ${needFluent}   (have ${fluentEx}, shortfall ${shortfall})`);
  console.log(`    ceiling if every applied example were fluent: ${(100 * ceiling).toFixed(1)}%`);
  console.log("");
  console.log(`  DRAW ORDER by measured fluent-applied-example yield (cells under n=${MIN_CELL_N} fall back to the prior)`);
  console.log(`    cell            n     fx   per100   available   take   expect`);
  for (const c of ranked) {
    const p = plan.find((x) => x.key === c.key);
    console.log(`    ${c.key.padEnd(12)}${String(c.n).padStart(6)}${String(c.fx).padStart(7)}` +
      `${(c.measured ? (100 * c.yield).toFixed(2) : "  prior").padStart(9)}${String(c.available).padStart(12)}` +
      `${String(p ? p.take : 0).padStart(7)}${(p ? p.expect.toFixed(1) : "-").padStart(9)}`);
  }
  console.log("");
  console.log(`  N = ${N}   projected +${projected.toFixed(1)} fluent applied examples ` +
              `(shortfall ${shortfall} x ${MARGIN} margin = ${wantProjected.toFixed(1)})`);
  console.log(`  margin is for yield uncertainty: the best cell rests on ${ranked[0]?.fx ?? 0} hits, so its rate has`);
  console.log(`  a wide interval; undershooting costs another whole teacher pass, overshooting costs CPU.`);

  if (!drawn.length) fail("drew zero extension candidates — the pool is exhausted at every ranked cell.");

  const rows = drawn.map((t) => ({
    uid: t.uid, sentence: t.sentence, context: t.context,
    stratum: "tempting-ext", message_id: t.message_id, channel: t.channel, ts: t.ts ?? null,
  }));
  // Distinct stratum name on purpose: it is the only way to tell later whether
  // the extension did what this arithmetic says it would.
  fs.appendFileSync(candPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const after = readJsonl(candPath);
  const dup = after.length - new Set(after.map((r) => r.uid)).size;
  if (dup) fail(`appended rows introduced ${dup} duplicate uid(s) — the candidates file is now inconsistent.`);

  console.log("");
  console.log(`  appended         ${rows.length} row(s) as stratum "tempting-ext"`);
  console.log(`  candidates now   ${after.length}   (${after.length - existing.length} new, 0 duplicates, existing uids untouched)`);
  const byStratum = after.reduce((a, r) => (a[r.stratum] = (a[r.stratum] || 0) + 1, a), {});
  console.log(`  by stratum       ` + Object.entries(byStratum).map(([k, v]) => `${k}=${v}`).join("  "));
  console.log(`\n  NEXT (owner, GPU): teacher-pass over the same file — resume-by-uid runs only the ${rows.length} new rows.`);
}

// ============================================================ migration
//
// The scrubbed corpus was regenerated under new name rules. uid is
// message_id + hash(sentence), so a sentence whose TEXT changed arrives under a
// new uid, and a full re-draw would restart the fluent-floor extension dance
// (stage 1b is sized from a teacher pass that has already been paid for).
//
// So the pool is MIGRATED rather than redrawn: every candidate row is located in
// the NEW corpus through the SAME targeting logic that drew it (`allTargets`,
// which is `targetsFor` over the scrubbed rows), and lands in exactly one of
//
//   carried  — uid resolves AND the context is byte-identical: the row is
//              carried through unchanged, so its teacher row stays valid.
//   changed  — the sentence or its context moved: new uid (or same uid, new
//              context), stratum and metadata preserved, old->new recorded.
//   dropped  — the message is gone, has no target for this sentence any more,
//              or cannot be matched unambiguously. Counted by reason.
//
// A CHANGED ROW MUST BE RE-TAUGHT. Its teacher row is pruned, never carried:
// a teacher outcome recorded against text the teacher never saw is a fabricated
// label, and it would be indistinguishable from a real one downstream. That
// includes a row whose sentence is byte-identical and whose CONTEXT moved —
// context is a prompt input, and teacher-pass keys its resume on the uid, which
// cannot see it.
//
// Matching a changed sentence back to its old row cannot use the uid (that is
// what changed) and cannot use the old corpus (it has been replaced). It uses
// the message: within one message_id, unclaimed new targets are paired to
// unmatched old rows by token similarity, best pair first, above a floor. A
// pairing under the floor is DROPPED rather than guessed — a wrong pairing
// carries a stratum label and a dev/sealed side onto the wrong sentence.

const MATCH_FLOOR = 0.55;

function simTokens(s) {
  return s.toLowerCase().split(/\s+/).map((t) =>
    t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")).filter(Boolean);
}

/** Token-multiset Jaccard. A name swap changes a token or two and little else. */
function similarity(a, b) {
  const ta = simTokens(a), tb = simTokens(b);
  if (!ta.length || !tb.length) return 0;
  const pool = tb.slice();
  let inter = 0;
  for (const t of ta) {
    const i = pool.indexOf(t);
    if (i >= 0) { pool.splice(i, 1); inter++; }
  }
  return inter / (ta.length + tb.length - inter);
}

async function migrate() {
  const candPath = path.join(ART, "calibration-candidates.jsonl");
  const teacherPath = path.join(ART, "calibration-teacher.jsonl");
  if (!fs.existsSync(candPath)) fail(`no candidates file at ${candPath} — nothing to migrate.`);

  const old = readJsonl(candPath, "candidates");
  const { targets, msgs } = await allTargets();

  const newByUid = new Map(targets.map((t) => [t.uid, t]));
  const newByMsg = new Map();
  for (const t of targets) {
    if (!newByMsg.has(t.message_id)) newByMsg.set(t.message_id, []);
    newByMsg.get(t.message_id).push(t);
  }
  const msgIds = new Set(msgs.map((m) => m.message_id));

  const carried = [], changed = [], dropped = [];
  const claimed = new Set();

  // Pass 1: exact uid hits. Byte-identical context is what separates "carried"
  // from "changed" — see the header on why a moved context still needs re-teaching.
  const leftover = [];
  for (const r of old) {
    const t = newByUid.get(r.uid);
    if (!t) { leftover.push(r); continue; }
    claimed.add(t.uid);
    if (t.sentence === r.sentence && t.context === r.context) carried.push(r);
    else changed.push({ row: { ...r, sentence: t.sentence, context: t.context, ts: t.ts ?? null, channel: t.channel }, from: r.uid, why: "context" });
  }

  // Pass 2: everything else, matched inside its own message.
  const byMsg = new Map();
  for (const r of leftover) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, []);
    byMsg.get(r.message_id).push(r);
  }
  for (const [mid, rows] of byMsg) {
    if (!msgIds.has(mid)) { for (const r of rows) dropped.push({ uid: r.uid, reason: "message-gone" }); continue; }
    const free = (newByMsg.get(mid) || []).filter((t) => !claimed.has(t.uid));
    if (!free.length) { for (const r of rows) dropped.push({ uid: r.uid, reason: "no-target" }); continue; }
    const pairs = [];
    for (const r of rows) for (const t of free) pairs.push({ r, t, s: similarity(r.sentence, t.sentence) });
    pairs.sort((a, b) => b.s - a.s);
    const usedRow = new Set(), usedT = new Set();
    for (const p of pairs) {
      if (p.s < MATCH_FLOOR || usedRow.has(p.r) || usedT.has(p.t)) continue;
      usedRow.add(p.r); usedT.add(p.t); claimed.add(p.t.uid);
      changed.push({
        row: { ...p.r, uid: p.t.uid, sentence: p.t.sentence, context: p.t.context, ts: p.t.ts ?? null, channel: p.t.channel },
        from: p.r.uid, why: "text",
      });
    }
    for (const r of rows) if (!usedRow.has(r)) dropped.push({ uid: r.uid, reason: "unmatched" });
  }

  if (carried.length + changed.length + dropped.length !== old.length) {
    fail(`accounting failure: ${carried.length}+${changed.length}+${dropped.length} != ${old.length} input rows.`);
  }

  const out = [...carried, ...changed.map((c) => c.row)];
  const dupes = out.length - new Set(out.map((r) => r.uid)).size;
  if (dupes) fail(`migration produced ${dupes} duplicate uid(s) — refusing to write.`);

  // Teacher prune: only rows whose uid survived UNCHANGED may keep their label.
  const carriedUids = new Set(carried.map((r) => r.uid));
  let teacherKept = [], teacherDropped = 0;
  if (fs.existsSync(teacherPath)) {
    for (const r of readJsonl(teacherPath, "teacher results")) {
      if (r && typeof r.uid === "string" && carriedUids.has(r.uid)) teacherKept.push(r);
      else teacherDropped++;
    }
  }
  const missingTeacher = out.length - new Set(teacherKept.map((r) => r.uid)).size;

  const byReason = dropped.reduce((a, d) => (a[d.reason] = (a[d.reason] || 0) + 1, a), {});
  const byWhy = changed.reduce((a, c) => (a[c.why] = (a[c.why] || 0) + 1, a), {});

  console.log("\nCalibration pool migration  (no model calls)");
  console.log("=".repeat(72));
  console.log(`  source           ${S1}`);
  console.log(`  candidates in    ${old.length}`);
  console.log(`  new targets      ${targets.length} over ${msgs.length} messages`);
  console.log("");
  console.log(`  carried (byte-identical)   ${String(carried.length).padStart(6)}`);
  console.log(`  changed (re-extracted)     ${String(changed.length).padStart(6)}   ` +
              Object.entries(byWhy).map(([k, v]) => `${k}=${v}`).join("  "));
  console.log(`  dropped                    ${String(dropped.length).padStart(6)}   ` +
              (Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join("  ") || "-"));
  console.log(`  ${"-".repeat(40)}`);
  console.log(`  candidates out             ${String(out.length).padStart(6)}`);
  console.log("");
  console.log(`  teacher rows kept          ${String(teacherKept.length).padStart(6)}`);
  console.log(`  teacher rows pruned        ${String(teacherDropped).padStart(6)}   (uid died or its text/context moved)`);
  console.log(`  MISSING TEACHER            ${String(missingTeacher).padStart(6)}   <- the delta the next teacher pass must run`);
  const byStratum = out.reduce((a, r) => (a[r.stratum] = (a[r.stratum] || 0) + 1, a), {});
  console.log(`  by stratum                 ` + Object.entries(byStratum).map(([k, v]) => `${k}=${v}`).join("  "));

  if (DRY) { console.log(`\n  --dry-run: nothing written.`); return; }
  if (!out.length) fail("migration produced zero candidates — refusing to write.");

  const bak = (p) => { if (fs.existsSync(p)) fs.copyFileSync(p, p.replace(/\.jsonl$/, ".pre-migrate.jsonl")); };
  bak(candPath); bak(teacherPath);
  writeJsonl(candPath, out);
  if (fs.existsSync(teacherPath)) writeJsonl(teacherPath, teacherKept);

  const lineagePath = path.join(ART, "calibration-uid-lineage.json");
  fs.writeFileSync(lineagePath, JSON.stringify({
    generated: new Date().toISOString(),
    source: path.basename(S1),
    counts: { in: old.length, carried: carried.length, changed: changed.length, dropped: dropped.length },
    dropped_by_reason: byReason,
    map: Object.fromEntries(changed.map((c) => [c.from, c.row.uid])),
  }, null, 1) + "\n");

  console.log(`\n  written          ${candPath}`);
  console.log(`                   ${teacherPath}`);
  console.log(`                   ${lineagePath}   (${changed.length} old->new pairs)`);
  console.log(`  backups          *.pre-migrate.jsonl`);
  console.log(`\n  NEXT (owner, GPU): node teacher-pass.mjs --in ${path.relative(process.cwd(), candPath)} \\`);
  console.log(`                       --out ${path.relative(process.cwd(), teacherPath)}   # resume-by-uid runs the ${missingTeacher}-row delta`);
  console.log(`  THEN:               node calibration-sample.mjs --stratify ${path.relative(process.cwd(), teacherPath)}`);
}

// ============================================================== stage 2

async function stratify() {
  const rows = readJsonl(STRATIFY, "teacher results");
  const rnd = mulberry32(SEED ^ 0x5f3759df);

  const changed = [], refused = [], noops = [];
  let errors = 0, malformed = 0;
  for (const r of rows) {
    if (!r || typeof r.uid !== "string") continue;
    if (r.malformed) malformed++;
    if (r.outcome === "error" || r.rewritten == null) { errors++; continue; }
    const groups = editGroups(r.sentence, r.rewritten);
    const item = {
      uid: r.uid,
      context: r.context_window || "",
      input: r.sentence,
      output: r.rewritten,
      groups,
      guard: r.guard,
      outcome: r.outcome,
      stratum: r.passthrough?.stratum || null,
      fluent: groups.some(isFluentRealWordSwap),
    };
    if (!groups.length) noops.push(item);
    else if (r.outcome === "refused") refused.push(item);
    else changed.push(item);
  }

  if (!changed.length && !refused.length) {
    fail(`no changed teacher targets in ${STRATIFY} — nothing to calibrate on.\n` +
         `  (${rows.length} rows: ${errors} error, ${noops.length} no-op)`);
  }

  const wantNoop = Math.round(FINAL_N * NOOP_SHARE);
  const wantRefused = Math.round(FINAL_N * REFUSED_SHARE);
  const wantApplied = FINAL_N - wantNoop - wantRefused;

  const appliedFluent = shuffled(changed.filter((i) => i.fluent), rnd);
  const appliedPlain = shuffled(changed.filter((i) => !i.fluent), rnd);
  const refusedPool = shuffled(refused, rnd);

  // THE FLOOR IS A GROUP RATIO, SO IT IS FILLED IN GROUPS. The first cut took a
  // fixed COUNT OF EXAMPLES (ceil(400 * 0.35)) and then reported the floor as a
  // fraction of GROUPS, which cannot converge: a plain multi-typo sentence
  // contributes two or three groups and a fluent substitution usually
  // contributes one, so an example-quota of 35% lands near 24% of groups and
  // the run fails a gate it was never given the means to pass. Fill greedily
  // against the running group ratio instead, and the quota is in the units the
  // §4 gate is actually scored in.
  const chosen = [];
  let gTotalRunning = 0, gFluentRunning = 0;
  const addItem = (it) => {
    chosen.push(it);
    gTotalRunning += it.groups.length;
    gFluentRunning += it.groups.filter(isFluentRealWordSwap).length;
  };

  // Controls first: their quotas are fixed, and the floor must hold over the
  // WHOLE set, so the applied fill has to see the dilution they cause.
  for (let i = 0; i < wantRefused && refusedPool.length; i++) addItem(refusedPool.shift());
  const noopChosen0 = shuffled(noops, rnd).slice(0, wantNoop);
  for (const it of noopChosen0) addItem(it);              // zero groups, no dilution

  for (let i = 0; i < wantApplied; i++) {
    const below = gTotalRunning === 0 || gFluentRunning / gTotalRunning < FLUENT_FLOOR;
    const pool = (below && appliedFluent.length) ? appliedFluent
               : (appliedPlain.length ? appliedPlain : appliedFluent);
    if (!pool.length) break;
    addItem(pool.shift());
  }
  // Still short of the floor with applied slots exhausted? Spend the remaining
  // fluent pool rather than reporting a miss that a swap would have fixed.
  while (appliedFluent.length && gTotalRunning && gFluentRunning / gTotalRunning < FLUENT_FLOOR) {
    const victim = chosen.findIndex((i) => i.outcome === "applied" && !i.fluent);
    if (victim < 0) break;
    const [dropped] = chosen.splice(victim, 1);
    gTotalRunning -= dropped.groups.length;
    gFluentRunning -= dropped.groups.filter(isFluentRealWordSwap).length;
    addItem(appliedFluent.shift());
  }
  const noopChosen = noopChosen0;

  // Split by SENTENCE UID, seeded. Groups from one sentence must not straddle
  // the dev/sealed line — a prompt tuned on group 1 of a sentence has seen
  // group 2, and the sealed half stops being sealed.
  //
  // AND A RE-STRATIFY MUST NOT MOVE AN EXAMPLE ACROSS THAT LINE. Re-running
  // stage 2 after widening the pool reshuffles the selection; if the split were
  // simply redrawn, an example the prompt was already tuned against could land
  // in the sealed half, which is a seal leak that leaves no trace — the file
  // still says "sealed" and the number still looks like a held-out number.
  // Prior assignments are therefore STICKY, and only genuinely new examples are
  // assigned fresh. The seed still governs the new ones, so a re-run is
  // reproducible; it just is not free to relabel history.
  const priorSide = new Map();
  for (const [f, side] of [["calibration-dev-uids.json", "dev"], ["calibration-sealed-uids.json", "sealed"]]) {
    const fp = path.join(ART, f);
    if (!fs.existsSync(fp)) continue;
    for (const u of JSON.parse(fs.readFileSync(fp, "utf8"))) priorSide.set(u, side);
  }
  // LINEAGE. A corpus migration (--migrate) can change a sentence's TEXT without
  // changing the message or the episode it came from, and uid = message_id +
  // hash(sentence), so the row arrives under a new uid. Read as "new example",
  // it would be free to land on the other side of the dev/sealed line — a seal
  // leak by bookkeeping. The old->new map makes the sticky assignment follow the
  // example, so the fatal-migration assert below is asking about the same thing
  // it was asking about before the corpus moved.
  const lineagePath = path.join(ART, "calibration-uid-lineage.json");
  let aliased = 0;
  if (fs.existsSync(lineagePath)) {
    const lin = JSON.parse(fs.readFileSync(lineagePath, "utf8"));
    for (const [oldUid, newUid] of Object.entries(lin.map || {})) {
      if (!priorSide.has(oldUid) || priorSide.has(newUid)) continue;
      priorSide.set(newUid, priorSide.get(oldUid));
      aliased++;
    }
    if (aliased) console.log(`\n  lineage          ${aliased} migrated uid(s) inherited their previous dev/sealed side`);
  }

  const shuffledChosen = shuffled(chosen, rnd);
  const keptDev = shuffledChosen.filter((i) => priorSide.get(i.uid) === "dev");
  const keptSealed = shuffledChosen.filter((i) => priorSide.get(i.uid) === "sealed");
  const fresh = shuffledChosen.filter((i) => !priorSide.has(i.uid));
  const devRoom = Math.max(0, Math.min(DEV_N, shuffledChosen.length) - keptDev.length);
  const dev = [...keptDev, ...fresh.slice(0, devRoom)];
  const sealed = [...keptSealed, ...fresh.slice(devRoom)];
  const split = [...dev, ...sealed];
  if (priorSide.size) {
    const migrated = shuffledChosen.filter((i) => priorSide.has(i.uid) &&
      priorSide.get(i.uid) !== (dev.includes(i) ? "dev" : "sealed")).length;
    console.log(`\n  split reuse      ${keptDev.length} dev + ${keptSealed.length} sealed kept from the previous` +
                ` assignment, ${fresh.length} assigned fresh`);
    if (migrated) {
      fail(`${migrated} example(s) would have changed side. That is a seal leak; refusing to write.`);
    }
    if (keptDev.length > DEV_N) {
      console.log(`  NOTE  ${keptDev.length} sticky dev assignments exceed the ${DEV_N} target; dev is oversized rather`);
      console.log(`        than trimmed, because trimming would mean re-sealing an example already used for tuning.`);
    }
  }

  const setPath = path.join(ART, "calibration-set.jsonl");
  writeJsonl(setPath, split.map((i) => ({
    uid: i.uid, context: i.context, input: i.input, output: i.output,
  })));
  const devPath = path.join(ART, "calibration-dev-uids.json");
  const sealedPath = path.join(ART, "calibration-sealed-uids.json");
  fs.writeFileSync(devPath, JSON.stringify(dev.map((i) => i.uid), null, 1) + "\n");
  fs.writeFileSync(sealedPath, JSON.stringify(sealed.map((i) => i.uid), null, 1) + "\n");

  const groupsOf = (list) => list.reduce((n, i) => n + i.groups.length, 0);
  const fluentGroups = (list) => list.reduce((n, i) => n + i.groups.filter(isFluentRealWordSwap).length, 0);
  const row = (label, list) =>
    `  ${label.padEnd(24)}${String(list.length).padStart(7)}${String(groupsOf(list)).padStart(9)}` +
    `${String(fluentGroups(list)).padStart(9)}`;

  console.log("\nCalibration set  (stage 2 — stratified from teacher output)");
  console.log("=".repeat(72));
  console.log(`  seed             ${SEED}`);
  console.log(`  teacher results  ${STRATIFY}   (${rows.length} rows)`);
  console.log(`  usable           ${changed.length} applied-changed, ${refused.length} refused, ${noops.length} no-op`);
  console.log(`  excluded         ${errors} error${malformed ? `, of which ${malformed} malformed output` : ""}`);
  console.log("");
  console.log(`  stratum                examples   groups   fluent`);
  console.log(`  ${"-".repeat(50)}`);
  console.log(row("applied (changed)", chosen.filter((i) => i.outcome === "applied")));
  console.log(row("guard-refused ctrl", chosen.filter((i) => i.outcome === "refused")));
  console.log(row("no-op control", noopChosen));
  console.log(`  ${"-".repeat(50)}`);
  console.log(row("TOTAL", chosen));
  const gTotal = groupsOf(chosen), gFluent = fluentGroups(chosen);
  console.log("");
  console.log(`  fluent real-word swaps   ${gFluent}/${gTotal} groups ` +
              `(${gTotal ? (100 * gFluent / gTotal).toFixed(1) : "0.0"}%)   floor ${(FLUENT_FLOOR * 100).toFixed(0)}%` +
              `${gTotal && gFluent / gTotal >= FLUENT_FLOOR ? "  ok" : "  *** BELOW FLOOR ***"}`);
  console.log(`  source strata            ` +
    Object.entries(chosen.reduce((a, i) => (a[i.stratum || "?"] = (a[i.stratum || "?"] || 0) + 1, a), {}))
      .map(([k, v]) => `${k}=${v}`).join("  "));
  console.log("");
  console.log(`  dev              ${dev.length} examples, ${groupsOf(dev)} groups   -> ${devPath}`);
  console.log(`  sealed           ${sealed.length} examples, ${groupsOf(sealed)} groups   -> ${sealedPath}`);
  console.log(`  set              ${split.length} examples              -> ${setPath}`);
  console.log(`\n  NOTE  the ${noopChosen.length} no-op control(s) carry ZERO edit groups: judge-harness records`);
  console.log(`        them as \`no-edit\` with no judge call, and they produce no owner labels.`);
  console.log(`        They are pipeline controls; the gate denominator is the GROUP counts above.`);

  if (chosen.length < FINAL_N) {
    console.log(`\n  SHORT: wanted ${FINAL_N} examples, the teacher output supplied ${chosen.length}.`);
  }
  if (gTotal && gFluent / gTotal < FLUENT_FLOOR) {
    console.log(`\n  The fluent floor is a §4 requirement, not a preference. Widen the tempting`);
    console.log(`  stratum in stage 1 and re-run the teacher rather than shipping under it.`);
    process.exit(1);
  }
}

/**
 * A group whose every lost AND gained token is a dictionary word: the fluent
 * real-word -> real-word substitution class. `salt` -> `slat` is the canonical
 * member; `techncian` -> `technician` is not, because the lost side is not a
 * word. Pure insertions and deletions are excluded — a class defined by "both
 * sides are real words" cannot have an empty side.
 */
export function isFluentRealWordSwap(g) {
  if (!g.before.trim() || !g.after.trim()) return false;
  const toks = (s) => s.split(/\s+/).map((t) =>
    t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "").toLowerCase()).filter(Boolean);
  const lost = toks(g.before), gained = toks(g.after);
  if (!lost.length || !gained.length) return false;
  return lost.every(isWord) && gained.every(isWord);
}

// ------------------------------------------------------------------ dispatch

const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
if (IS_MAIN) {
  if (MIGRATE) await migrate();
  else if (EXTEND != null) await extendTempting();
  else if (STRATIFY) await stratify();
  else await buildPool();
}
