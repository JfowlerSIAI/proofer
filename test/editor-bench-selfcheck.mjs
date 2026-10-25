#!/usr/bin/env node
/**
 * DOES THE BENCH FAIL LOUDLY? Offline checks, ~90 seconds.
 *
 *   cd test && node editor-bench-selfcheck.mjs
 *
 * editor-recipe-probe.mjs measures editors; this measures the probe. It exists
 * because that file's whole history is one failure family -- THE RUN COMPLETES,
 * EXITS GREEN, AND PRODUCES NOTHING -- and eight separate instances of it were
 * found by reading rather than by running. A misconfigured bench is now the
 * commonest way to reach that state: point PROOFER_CANDIDATE_SELECTOR at a
 * class the page does not have and every mechanism downstream behaves
 * perfectly, on nothing.
 *
 * So each case here BREAKS the harness (or one of its tables) on purpose and
 * asserts that the break is
 * visible in the exit code AND named in the output. Both halves matter: an exit
 * 2 nobody can read sends the next person to the wrong file, and a good message
 * behind an exit 0 is not going to be read at all.
 *
 * OFFLINE BY CONSTRUCTION. Every probe is passed --offline. Cases needing a page use a file:// URL
 * pointing at test-page.html -- a demo site outage must not be able to turn
 * this into a skip, because the property under test is "does it complain", and
 * an unreachable site is one more thing to complain about rather than a reason
 * not to.
 *
 * Exit codes: 0 all mutants failed loudly, 1 one of them did not.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { crossCheckEditorsSuite, normalizeTarget, adHocTargetFromEnv,
         resolveTargets, EDITOR_TARGETS } from "./lib/editor-targets.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PROBE = path.join(HERE, "editor-recipe-probe.mjs");
const PAGE = "file://" + path.join(HERE, "test-page.html");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-bench-"));

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}: ${label}${cond || !detail ? "" : `\n         ${detail}`}`);
  cond ? pass++ : fail++;
  return !!cond;
};

// UNSET, not "". The probe reads `PROOFER_TRIALS === undefined ? 8 : Number(...)`
// and `Number("") === 0`, so a reset that assigns an empty string turns every
// mutant here into the trials mutant -- eleven cases passing for one reason.
const CARRIED = ["PROOFER_RESULT_JSON", "PROOFER_CANDIDATES", "PROOFER_ARMS", "PROOFER_TRIALS",
  "PROOFER_CANDIDATE_URL", "PROOFER_CANDIDATE_SELECTOR", "PROOFER_CANDIDATE_NAME",
  "PROOFER_CANDIDATE_FOCUS", "PROOFER_CANDIDATE_MIN_CLICK_Y", "PROOFER_CANDIDATE_CLEAR_PASSES",
  "PROOFER_CANDIDATE_READY_MS", "PROOFER_ALLOW_VOID", "PROOFER_ALLOW_TARGET_DRIFT",
  // PROOFER_CONTENT above all: an exported override would measure a different
  // file and say so only in a banner nobody is reading here.
  "PROOFER_CONTENT", "PROOFER_SEED"];

/** Run the probe with a mutated environment and report what it said and returned. */
function run(env, args = []) {
  const clean = { ...process.env };
  for (const k of CARRIED) delete clean[k];
  const r = spawnSync(process.execPath, [PROBE, "--offline", ...args], {
    env: { ...clean, ...env }, encoding: "utf8", timeout: 300000,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const mutant = (label, env, args, wantCode, wantText) => {
  const r = run(env, args);
  const said = wantText.every((t) => r.out.includes(t));
  ok(r.code === wantCode && said, `${label} -> exit ${wantCode}, and says so`,
     `got exit ${r.code}; missing: ${wantText.filter((t) => !r.out.includes(t)).join(" | ")}`
     + `\n         tail: ${r.out.trim().split("\n").slice(-3).join(" / ")}`);
};

console.log("\nThe bench fails loudly\n" + "=".repeat(64));

// --- Argument mutants: these must not reach Chrome at all -------------------
console.log("\n[A] Arguments that would measure nothing");
mutant("PROOFER_TRIALS=0", { PROOFER_TRIALS: "0" }, [], 2, ["not a positive integer"]);
mutant("PROOFER_TRIALS=abc", { PROOFER_TRIALS: "abc" }, [], 2, ["not a positive integer"]);
mutant("PROOFER_CANDIDATES matches nothing", { PROOFER_CANDIDATES: "NoSuchEditor" }, [], 2,
       ["matched nothing", "Known:"]);
mutant("PROOFER_ARMS names an unknown arm", { PROOFER_ARMS: "mutation-guess" }, [], 2,
       ["unknown arm"]);
mutant("a URL with no selector", { PROOFER_CANDIDATE_URL: PAGE }, [], 2,
       ["must be set TOGETHER"]);
mutant("a selector with no URL", { PROOFER_CANDIDATE_SELECTOR: "#ce" }, [], 2,
       ["must be set TOGETHER"]);
mutant("an ad-hoc URL that is not a URL",
       { PROOFER_CANDIDATE_URL: "codemirror.net", PROOFER_CANDIDATE_SELECTOR: "#ce" }, [], 2,
       ["url is not a URL"]);
mutant("an ad-hoc focus strategy that does not exist",
       { PROOFER_CANDIDATE_URL: PAGE, PROOFER_CANDIDATE_SELECTOR: "#ce",
         PROOFER_CANDIDATE_FOCUS: "keyboard" }, [], 2,
       ['focusVia must be "click" or "el"']);

// --- The artifact -----------------------------------------------------------
//
// `--nesting-only` accepted PROOFER_RESULT_JSON and silently ignored it for as
// long as the flag existed. A destination that cannot be written was an
// uncaught exception ten minutes into a run.
console.log("\n[B] The artifact");
{
  const dest = path.join(TMP, "nesting.json");
  const r = run({ PROOFER_RESULT_JSON: dest }, ["--nesting-only"]);
  const wrote = fs.existsSync(dest);
  const body = wrote ? JSON.parse(fs.readFileSync(dest, "utf8")) : null;
  ok(r.code === 0 && wrote, "--nesting-only honours PROOFER_RESULT_JSON", `exit ${r.code}, wrote ${wrote}`);
  ok(body && body.status === "ok" && body.mode === "nesting-only" && body.nesting.length > 0,
     "and the artifact says what it is and holds the checks",
     body ? `status=${body.status} mode=${body.mode} nesting=${body.nesting.length}` : "no file");
  ok(body && body.probe && body.probe.sha256 && body.content && body.content.sha256
     && body.chrome && body.chrome.version && body.env && body.env.seed !== undefined,
     "and it is self-describing: probe, content, chrome and seed",
     body ? JSON.stringify({ probe: !!body.probe, chrome: body.chrome && body.chrome.version,
                             seed: body.env && body.env.seed }) : "no file");
}
// A DIRECTORY, not a permission trick. The first version of this case used a
// path under /proc, where the write neither succeeded nor failed -- it HUNG, and
// the mutant was killed by the harness timeout five minutes later reporting
// "exit null", which is a third outcome neither the probe nor this file has a
// story for. An existing directory gives EISDIR immediately on every platform,
// and it is the destination a caller actually mistypes.
mutant("PROOFER_RESULT_JSON that cannot be written",
       { PROOFER_RESULT_JSON: TMP }, ["--nesting-only"], 2,
       ["cannot be written", "Refusing to run"]);

// --- --nesting-only resolves NO TARGETS -------------------------------------
//
// That path is in the CI battery and answers one question: does an unmeasured
// editor inherit a certified adapter. It must not be able to fail for a reason
// it does not depend on -- a target descriptor disagreeing with another file's
// table would report that answer as wrong when it was never asked. It is also
// what keeps CI's per-file grep for `https?://` honest instead of quietly
// passing because the URLs moved into an imported module.
//
// So this is an assertion rather than a comment, and it fails if the resolution
// ever drifts back above the early exit: a target selection that would EXIT 2 on
// the full path must be inert here, and the artifact must show zero targets and
// no cross-check.
console.log("\n[B2] --nesting-only drives no editor, so it selects no target");
{
  const dest = path.join(TMP, "nesting-inert.json");
  const r = run({ PROOFER_RESULT_JSON: dest, PROOFER_CANDIDATES: "NoSuchEditor",
                  PROOFER_CANDIDATE_URL: "https://example.invalid/" }, ["--nesting-only"]);
  // PROOFER_CANDIDATES=NoSuchEditor is exit 2 on the full path (asserted above),
  // and a URL with no selector is exit 2 there too. Both are inert here.
  ok(r.code === 0, "a target filter that is fatal on the full path is inert here",
     `exit ${r.code}`);
  ok(r.out.includes("had no effect on this run"),
     "and it SAYS they had no effect, rather than ignoring them in silence");
  const body = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, "utf8")) : null;
  ok(body && Array.isArray(body.targets) && body.targets.length === 0
     && body.targetDriftCheck === null,
     "and the artifact records zero targets and no cross-check",
     body ? `targets=${JSON.stringify(body.targets)} drift=${JSON.stringify(body.targetDriftCheck)}` : "no file");
}

// --- The two mutants that need a page ---------------------------------------
console.log("\n[C] A page that is there and an element that is not");
{
  // AD-HOC, so exit 2: the caller typed this selector and nothing in the repo
  // ever asserted it. The same miss on a BUILT-IN row is exit 1 -- the repo says
  // the page has that selector and the page says otherwise, which is the
  // contract sentence-editors-test.mjs and sentence-slate-test.mjs already
  // follow ("a page that loads without the selector is a failure, not a skip").
  // That arm needs a reachable demo site, so it is exercised by the live runs
  // rather than here; stated because an untested branch should be visible.
  const dest = path.join(TMP, "wrong-selector.json");
  const r = run({ PROOFER_CANDIDATE_URL: PAGE, PROOFER_CANDIDATE_SELECTOR: ".no-such-editor",
                  PROOFER_CANDIDATE_NAME: "Mutant", PROOFER_TRIALS: "1",
                  PROOFER_RESULT_JSON: dest });
  ok(r.code === 2 && r.out.includes("AD-HOC ROW(S) LOADED WITHOUT THEIR SELECTOR")
     && r.out.includes("configuration error"),
     "an AD-HOC selector that matches nothing -> exit 2, named as configuration",
     `exit ${r.code}`);
  ok(r.out.includes("BROKEN ROW"), "and the row itself is called out where it happened");
  const body = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, "utf8")) : null;
  ok(body && body.status === "adhoc-selector-missed" && body.summary.cells === 0
     && body.summary.broken.length === 1,
     "and the artifact records the emptiness rather than looking like a result",
     body ? `status=${body.status}` : "no artifact");
}
{
  // AN OUTAGE IS NOT A CONFIGURATION ERROR, and the two produce the same empty
  // table. Port 1 on loopback refuses instantly and needs no network, so this
  // is the offline stand-in for every demo site being down: it must be the 77
  // that tells a batch runner "not measured", never the 2 that says "you typed
  // it wrong". The first version of the no-cells branch collapsed them and
  // running the probe with no network reported a configuration error.
  const r = run({ PROOFER_CANDIDATE_URL: "http://127.0.0.1:1/", PROOFER_CANDIDATE_SELECTOR: ".x",
                  PROOFER_CANDIDATE_NAME: "Offline", PROOFER_TRIALS: "1", PROOFER_ARMS: "intent" });
  ok(r.code === 77 && r.out.includes("all 1 row(s) were unreachable")
     && !r.out.includes("NO CELLS WERE MEASURED"),
     "every row unreachable -> exit 77, named as an outage",
     `exit ${r.code}`);
}
{
  // An IP literal bypasses the resolver rule. It must fail at the page request
  // boundary itself, even outside the CI network namespace, and never retry
  // in live mode. A DNS error or an unreachable socket would not prove that.
  const url = "http://192.0.2.1/proofer-offline-boundary";
  const dest = path.join(TMP, "external-blocked.json");
  const r = run({ PROOFER_CANDIDATE_URL: url, PROOFER_CANDIDATE_SELECTOR: ".x",
                  PROOFER_CANDIDATE_NAME: "External", PROOFER_TRIALS: "1",
                  PROOFER_ARMS: "intent", PROOFER_RESULT_JSON: dest });
  ok(r.code === 77 && r.out.includes(`OFFLINE BLOCKED: ${url}`)
     && r.out.includes("ERR_BLOCKED_BY_CLIENT"),
     "--offline blocks an external IP before a socket attempt, with no live fallback",
     `exit ${r.code}; ${r.out.trim().split("\n").slice(-3).join(" / ")}`);
  const body = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, "utf8")) : null;
  ok(body && body.offline === true && Array.isArray(body.blockedRequests)
     && body.blockedRequests.includes(url) && body.summary?.cells === 0,
     "and the artifact names the blocked target rather than reporting measurements",
     body ? JSON.stringify(body.summary) : "no artifact");
}
{
  // #ce-outer is contenteditable and focuses; an <h3> is a real, visible
  // element that a click cannot focus -- Trix's failure shape without Trix.
  //
  // NOT 77. A page that loaded and then could not be focused is a broken click
  // calculation, a stale descriptor or a probe bug -- never an outage -- and
  // classifying it as an environmental skip meant a probe regression reported
  // itself as "the site is down". This row is AD-HOC, so the failed claim is the
  // caller's and the exit is 2; the same failure on a built-in row is 1, which
  // needs a reachable demo site and is covered by the live paired runs rather
  // than here. That gap is real and stated rather than faked with a fixture row.
  const r = run({ PROOFER_CANDIDATE_URL: PAGE, PROOFER_CANDIDATE_SELECTOR: "h3",
                  PROOFER_CANDIDATE_NAME: "Unfocusable", PROOFER_TRIALS: "1",
                  PROOFER_ARMS: "intent" });
  ok(r.code === 2 && r.out.includes("FAILED TO SET UP on a page that LOADED")
     && r.out.includes("could not focus"),
     "an element that cannot be focused -> exit 2, a harness failure and NOT an outage",
     `exit ${r.code}`);
  ok(r.out.includes("not an outage") && !r.out.includes("DID NOT FULLY MEASURE"),
     "and it says so, rather than being filed under the void/skip wording");
  // The advice has to fit the row: PROOFER_CANDIDATE_FOCUS=el reaches an ad-hoc
  // descriptor and nothing else, so it must not be offered to a built-in one.
  ok(r.out.includes("PROOFER_CANDIDATE_FOCUS=el"),
     "and an AD-HOC row is told about the env var that can actually help it");
}

// --- [C1] A nesting failure outranks everything -----------------------------
//
// THE ORDERING BUG, pinned. `!table.length` was tested BEFORE `nestingFailed`,
// so a real nesting failure exited as "no cells" whenever the live rows also
// produced none -- and nesting is the one thing in this file that is a safety
// property rather than a measurement. It cannot be excused by anything the live
// run did or failed to do, so it is checked first and unconditionally.
//
// The mutant is content.js with the `unknown-editor` status renamed, which makes
// every inner-editor check fail while leaving the registry populated (an EMPTY
// registry is a different, already-covered exit). Not the historical bug -- that
// one lived in nearestTransport -- but it produces the same condition, which is
// what the ordering claim is about.
console.log("\n[C1] A nesting failure is checked first, and cannot be hidden");
{
  const brokenContent = path.join(TMP, "content-broken.js");
  const real = fs.readFileSync(path.join(HERE, "..", "content.js"), "utf8");
  fs.writeFileSync(brokenContent, real.replace(/"unknown-editor"/g, '"unknown-editor-XX"'));
  const bare = run({ PROOFER_CONTENT: brokenContent }, ["--nesting-only"]);
  // The count line, not the full path's summary sentence -- --nesting-only exits
  // before that block, which is the whole point of the second arm below.
  ok(bare.code === 1 && /FAIL: .*unregistered/.test(bare.out) && /nesting: \d+\/24 passed/.test(bare.out),
     "a broken adapter lookup fails the nesting matrix with exit 1", `exit ${bare.code}`);
  // The same run, PLUS a condition that is exit 2 on its own (an ad-hoc selector
  // that matches nothing). Nesting must still win.
  const both = run({ PROOFER_CONTENT: brokenContent, PROOFER_CANDIDATE_URL: PAGE,
                     PROOFER_CANDIDATE_SELECTOR: ".no-such-editor", PROOFER_TRIALS: "1",
                     PROOFER_ARMS: "intent" });
  ok(both.code === 1 && both.out.includes("checked FIRST"),
     "and it still exits 1 when a cardinality failure would otherwise claim the exit",
     `exit ${both.code}`);
}

// --- [C2] A successful full run, inspected ----------------------------------
//
// THE GAP THAT MATTERED MOST. Every case above breaks something, so deleting
// `table[].trials`, the per-trial final texts, or most of the full-mode schema
// left the whole file green: nothing here had ever looked at a run that WORKED.
// A harness that only tests its own failure paths cannot notice its output
// becoming useless.
//
// Offline, because it has to be: a plain `contenteditable` div in test-page.html
// over file://, driven by the mutation recipe, which is a real cell — clear,
// type, splice, type again, score — with no network and no demo site.
console.log("\n[C2] A run that WORKS, and whether its artifact is still usable");
{
  const dest = path.join(TMP, "fullcell.json");
  // Exercise subresources on BOTH reachability and measurement pages. Only
  // session() installs this chrome.runtime stub; the distinct URLs let the
  // artifact prove that no alternate page creation path escaped interception.
  const boundaryPage = path.join(TMP, "boundary-page.html");
  const probeURL = "http://192.0.2.1/proofer-probe-subresource";
  const sessionURL = "http://192.0.2.1/proofer-session-subresource";
  fs.writeFileSync(boundaryPage, fs.readFileSync(path.join(HERE, "test-page.html"), "utf8")
    .replace("</body>", `<script>fetch(window.chrome?.runtime?.id === "t" ? ${JSON.stringify(sessionURL)} : ${JSON.stringify(probeURL)}).catch(() => {});</script></body>`));
  const r = run({ PROOFER_CANDIDATE_URL: "file://" + boundaryPage, PROOFER_CANDIDATE_SELECTOR: "#ce",
                  PROOFER_CANDIDATE_NAME: "LocalCE", PROOFER_TRIALS: "1",
                  PROOFER_ARMS: "mutation-checked", PROOFER_RESULT_JSON: dest });
  ok(r.code === 0 && /LocalCE \/ mutation-checked\s+1\/0\/0\s+1\/0\/0/.test(r.out),
     "a real cell runs offline against a plain contenteditable and lands 1/0/0",
     `exit ${r.code}`);
  const body = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, "utf8")) : null;
  ok(body && body.status === "ok" && body.mode === "full" && body.summary.cells === 1
     && body.exit.code === 0,
     "the artifact reports a finished full run", body ? JSON.stringify(body.summary) : "no file");
  const trials = body && body.table && body.table[0] && body.table[0].trials;
  ok(Array.isArray(trials) && trials.length === 2
     && trials.every((t) => typeof t.final === "string" && t.final.length > 0
                         && typeof t.verdict === "string" && typeof t.ms === "number")
     && trials.map((t) => t.phase).join(",") === "idle,burst",
     "and EVERY trial is in it, with its phase, verdict, timing and final text",
     JSON.stringify(trials && trials.map((t) => ({ p: t.phase, v: t.verdict, f: typeof t.final }))));
  ok(body && body.table[0].source === "ad-hoc" && body.table[0].selector === "#ce",
     "and the cell records which row produced it -- the exit rule depends on it");
  ok(body && body.offline === true && Array.isArray(body.blockedRequests)
     && body.blockedRequests.includes(probeURL) && body.blockedRequests.includes(sessionURL),
     "and both reachability and measurement pages block external subresources",
     body ? JSON.stringify(body.blockedRequests) : "no artifact");
  ok(!fs.existsSync(dest + ".tmp"), "and the atomic write leaves no .tmp behind");
}

// --- [C3] The FINAL write fails ---------------------------------------------
//
// The EISDIR case proves only the initial claim. This is the other end: the
// destination was writable at startup, the run measured, and finalization
// fails. It used to be caught, logged, and exited 0 -- a green run whose
// artifact is the `in-progress` placeholder.
//
// Injected from outside with no test-only code path: finalization writes
// `<dest>.tmp` and renames it, so a DIRECTORY at that path makes exactly the
// final write fail while the claim succeeds.
{
  const dest = path.join(TMP, "finalfail.json");
  fs.mkdirSync(dest + ".tmp", { recursive: true });
  const r = run({ PROOFER_RESULT_JSON: dest }, ["--nesting-only"]);
  ok(r.code !== 0 && r.out.includes("COULD NOT WRITE THE ARTIFACT"),
     "a failed FINAL write is nonzero and says the run cannot be checked",
     `exit ${r.code}`);
  const body = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, "utf8")) : null;
  ok(body && body.status === "in-progress",
     "and the placeholder survives intact, still saying the run did not finish",
     body ? `status=${body.status}` : "no file");
  fs.rmSync(dest + ".tmp", { recursive: true, force: true });
}

// --- The descriptors --------------------------------------------------------
console.log("\n[D] The descriptors");
{
  const bad = (row) => { try { normalizeTarget(row); return null; } catch (e) { return e.message; } };
  ok(!!bad({ family: "X", url: "https://x/", selector: "" }), "an empty selector is refused");
  ok(!!bad({ family: "X", url: "https://x/", selector: ".a", minclickY: 200 }),
     "a MISTYPED field is refused, not silently defaulted");
  ok(bad({ family: "X", url: "https://x/", selector: ".a" }) === null, "and a good row is accepted");
  // An unknown arm does not fail -- the engine's dispatch ends in an else, so
  // the typo RUNS mutation/checked and reports itself under the typo'd name. A
  // cell that is wrong about what it measured is the one error this bench
  // exists to prevent, so it is refused at the descriptor.
  ok(/arms names "intentt"/.test(bad({ family: "X", url: "https://x/", selector: ".a",
                                       arms: ["intentt"] }) || ""),
     "an arm TYPO is refused by name, not measured as another recipe");
  ok(bad({ family: "X", url: "https://x/", selector: ".a", arms: ["intent", "none"] }) === null,
     "and a real arm subset is still allowed");
  // A scheme-prefix regex accepted these, and they reach Chrome and come back
  // classified as somebody else's outage.
  // Not "http:/x": WHATWG normalises that to http://x/ and so would Chrome, so
  // it is a URL and refusing it would be this file inventing a rule.
  for (const u of ["https://", "https://[", "ftp://x/", "not a url", ""]) {
    ok(bad({ family: "X", url: u, selector: ".a" }) !== null,
       `a URL that only looks like one is refused (${JSON.stringify(u)})`);
  }
  const d = crossCheckEditorsSuite();
  ok(d.ok && d.checked >= 7 && !d.error,
     `the descriptors agree with sentence-editors-test.mjs (${d.checked} rows)`,
     JSON.stringify(d.drift || d.error));
  const e = crossCheckEditorsSuite(path.join(HERE, "no-such-file.mjs"));
  ok(!e.ok && !!e.error, "and a cross-check that could not run reports an error, not agreement");
  // AND IT ACTUALLY CATCHES DRIFT. Asserting only that it agrees today, and
  // that a missing file errors, is a check that has never been shown to fail --
  // the same defect as a probe whose oracle is the predicate under test. So the
  // suite's own source is copied with ONE url changed, and the copy must come
  // back red. (A copy, never the file itself: it is a gate, and a self-check
  // that edits a gate to prove a point is a worse idea than the one it tests.)
  {
    const src = fs.readFileSync(path.join(HERE, "sentence-editors-test.mjs"), "utf8");
    const moved = path.join(TMP, "drifted-editors-test.mjs");
    fs.writeFileSync(moved, src.replace("https://draftjs.org/", "https://draftjs.example/"));
    const d2 = crossCheckEditorsSuite(moved);
    ok(!d2.ok && d2.drift.some((s) => s.startsWith("Draft.url")) && !d2.error,
       "a changed URL in one table is caught as drift, not absorbed",
       JSON.stringify(d2.drift));
    // And the check must not be a string search that finds any difference
    // anywhere: a comment edit is not drift.
    fs.writeFileSync(moved, src.replace("// The positive control", "// A comment nobody reads"));
    ok(crossCheckEditorsSuite(moved).ok, "and an edited comment is not drift");
    // THE OTHER DIRECTION. Walking only the suite's rows is silent about a
    // DELETED one -- the descriptor then claims a certification nothing
    // exercises, which is the repo's "a registry row without a suite row is an
    // assertion nobody checked" one level out.
    // A MIDDLE row, and the first draft of this case is why. Deleting the LAST
    // row left the array's closing bracket indented (`  ];`), which the
    // extractor rejects -- so it came back as "could not run" instead of as the
    // drift it was testing for. That is the documented formatting sensitivity,
    // reached accidentally by the file that documents it, and it is the reason
    // extraction failure must be an error rather than a pass.
    fs.writeFileSync(moved, src.replace(/\n  \{\n    family: "Quill", recipe: "mutation",[\s\S]*?\n  \},/, ""));
    const d3 = crossCheckEditorsSuite(moved);
    ok(!d3.ok && d3.drift.some((s) => s.startsWith("Quill:")) && !d3.error,
       "a DELETED suite row is drift too, not silence",
       JSON.stringify({ drift: d3.drift, error: d3.error }));
    // A literal read cannot see a later mutation, so half a check must report
    // as "could not run" rather than as agreement.
    fs.writeFileSync(moved, src + '\nTARGETS.push({ family: "Later" });\n');
    const d4 = crossCheckEditorsSuite(moved);
    ok(!d4.ok && !!d4.error && /MUTATES TARGETS/.test(d4.error),
       "and a TARGETS.push after the literal is 'could not run', not a partial pass",
       JSON.stringify(d4.error));
  }
  const { rows } = resolveTargets({ names: [], env: { PROOFER_CANDIDATE_URL: PAGE,
    PROOFER_CANDIDATE_SELECTOR: "#ce", PROOFER_CANDIDATE_NAME: "Ad" } });
  ok(rows.length === 1 && rows[0].family === "Ad" && rows[0].source === "ad-hoc",
     "an ad-hoc row is the WHOLE set when no filter was given",
     JSON.stringify(rows.map((r) => r.label)));
  ok(adHocTargetFromEnv({}) === null && EDITOR_TARGETS.length >= 8,
     "and an unset environment adds no row");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
