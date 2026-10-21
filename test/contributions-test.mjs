// One deletion request reaches everything made from a contributor's file,
// shown on synthetic contributors.
//
// Offline, synthetic records, a temporary root. Two contributors send logs; one
// sentence appears in both, so dataset assembly keeps ONE case with both
// sources. Then p07 asks to be deleted:
//
//   [1] ingest files each log under its pseudonym and batch, 0600 in 0700, with
//       the consent version, training choice and channel on its manifest
//   [2] log-to-cases derives cases carrying that provenance; copies of them go
//       into a .json dataset, a .jsonl dataset one case per line, an analysis
//       artifact holding them under a key and another holding them two keys
//       deep, and a directory OUTSIDE the root that `register` records
//   [3] delete removes p07's raw files and manifests and every p07-only case
//       from all of those, and takes p07's source off the shared case -- which
//       stays, for p08 -- then checks its own work and exits 0: nothing of
//       p07's is left, and a note holding only the SHARED sentence is p08's
//       too. A symbolic link under the root is reported and not followed.
//   [4] p08's files and cases are untouched; a dry run changes nothing, and
//       names what would remain
//   [5] a sentence only p09 wrote, left in a .txt note and in a .jsonl line
//       that does not parse, makes delete exit 1 and name both files
//   [6] --batch is a batch id and nothing else: ../p08, a path, and a batch or
//       contributor directory that is a symbolic link are refused (exit 2)
//       before anything is removed
//
//   node contributions-test.mjs

import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync, rmSync,
  symlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, label) => { if (c) pass++; else { fail++; console.log(`  FAIL ${label}`); } };
// Every run returns its exit status and everything it printed, so a check can
// read the status instead of a non-zero exit ending the suite; `node` is for
// the steps that must succeed.
const run = (script, args) => {
  const r = spawnSync(process.execPath, [join(__dirname, script), ...args],
    { encoding: "utf8", env: { ...process.env, PROOFER_OLLAMA_URL: "http://127.0.0.1:9" } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
};
const node = (script, args) => {
  const r = run(script, args);
  if (r.status !== 0) throw Object.assign(new Error(`${script} exited ${r.status}:\n${r.out}`), { status: r.status });
  return r.out;
};

const root = mkdtempSync(join(tmpdir(), "contrib-"));
// The exports as they arrived, and a directory the tool knows only because it
// is registered: both OUTSIDE the root. (An export left lying inside the root
// is exactly what delete's own check would find and refuse to call deleted.)
const inbox = mkdtempSync(join(tmpdir(), "contrib-inbox-"));
const outside = mkdtempSync(join(tmpdir(), "contrib-outside-"));
const beyond = mkdtempSync(join(tmpdir(), "contrib-beyond-"));
const rec = (id, input, finalText) => JSON.stringify({ v: 1, id, path: "sentence", promptRevision: "sentence-v1",
  modelDigest: "d".repeat(64), model: "proofer:v1-q4", input, output: input.replace("recieved", "received"),
  verdict: finalText ? "user-edited-correction" : "user-reverted", finalText: finalText || null });
const shared = "The vendor recieved the specs on time.";
const only07 = "Only p07 wrote this sentance.";
const only09 = "Nobody but p09 typed this sentance.";
const p07 = join(inbox, "p07.jsonl");
// p07's file is a historical beta export: its last row names the notice they saw.
writeFileSync(p07, [rec("sn_a", shared), rec("sn_b", only07),
  JSON.stringify({ v: 1, path: "notice", notice: "draft-2026-09-24", exportedAt: 1 })].join("\n") + "\n");
const p08 = join(inbox, "p08.jsonl");
writeFileSync(p08, [rec("sn_c", shared)].join("\n") + "\n");

// [1] ingest. p07's consent version comes from the file; p08's file is older
// and names none, so it is given.
let refused = null;
try { node("contributions.mjs", ["ingest", p07, "--contributor", "p07", "--consent", "some-other-notice",
  "--training", "yes", "--channel", "email", "--root", root]); } catch (e) { refused = e.status; }
ok(refused === 1, "[1] a --consent that disagrees with the notice named in the file is refused");
node("contributions.mjs", ["ingest", p07, "--contributor", "p07", "--training", "yes", "--channel", "email", "--root", root]);
let bare = null;
try { node("contributions.mjs", ["ingest", p08, "--contributor", "p08", "--training", "no", "--channel", "email", "--root", root]); }
catch (e) { bare = e.status; }
ok(bare === 2, "[1] a file naming no notice needs --consent");
node("contributions.mjs", ["ingest", p08, "--contributor", "p08", "--consent", "draft-2026-09-24",
  "--training", "no", "--channel", "email", "--root", root]);
const dirOf = (who) => { const d = join(root, "beta", who); return join(d, readdirSync(d)[0]); };
const m07 = JSON.parse(readFileSync(join(dirOf("p07"), "manifest.json"), "utf8"));
ok(m07.contributor === "p07" && m07.consentVersion === "draft-2026-09-24" && m07.training === true
  && m07.channel === "email" && /^[0-9a-f]{12}$/.test(m07.batch), "[1] the manifest records who, which notice, training and channel");
ok((statSync(join(dirOf("p07"), "raw.jsonl")).mode & 0o777) === 0o600 && (statSync(dirOf("p07")).mode & 0o777) === 0o700,
  "[1] ...the raw file is 0600 in a 0700 directory");
let again = null;
try { node("contributions.mjs", ["ingest", p07, "--contributor", "p07", "--consent", "x", "--training", "yes", "--channel", "email", "--root", root]); }
catch (e) { again = e.status; }
ok(again === 1, "[1] the same file twice is refused");

// Public support exports need a distinct training agreement; merely seeing
// the export notice cannot become permission through the ingestion command.
const publicExport = join(inbox, "support.jsonl");
writeFileSync(publicExport, [rec("sn_support", "A synthetic support example has a typo."),
  JSON.stringify({ v: 1, path: "notice", notice: "2026-10-21", exportedAt: 2 })].join("\n") + "\n");
const supportRoot = join(root, "support-ingest-check");
const publicArgs = ["ingest", publicExport, "--contributor", "support01", "--channel", "test", "--root", supportRoot];
const rejectedPublic = run("contributions.mjs", [...publicArgs, "--training", "yes"]);
ok(rejectedPublic.status === 2 && /separate explicit agreement/.test(rejectedPublic.out) && !existsSync(supportRoot),
  "[1a] public export notice cannot authorize training or create an ingested file");
node("contributions.mjs", [...publicArgs, "--training", "no"]);
let supportDir = join(supportRoot, "beta", "support01");
let supportManifest = JSON.parse(readFileSync(join(supportDir, readdirSync(supportDir)[0], "manifest.json"), "utf8"));
ok(supportManifest.training === false && !supportManifest.trainingAgreement, "[1a] support-only ingestion records no training grant");
rmSync(supportRoot, { recursive: true });
node("contributions.mjs", [...publicArgs, "--training", "yes", "--training-agreement", "synthetic-explicit-agreement-01"]);
supportDir = join(supportRoot, "beta", "support01");
supportManifest = JSON.parse(readFileSync(join(supportDir, readdirSync(supportDir)[0], "manifest.json"), "utf8"));
ok(supportManifest.training === true && supportManifest.trainingAgreement === "synthetic-explicit-agreement-01",
  "[1a] separately authorized ingestion preserves the agreement reference");
rmSync(supportRoot, { recursive: true });

// [2] derive cases per contribution
for (const who of ["p07", "p08"]) {
  node("log-to-cases.mjs", [join(dirOf(who), "raw.jsonl"), "--contributor", who, "--out", join(dirOf(who), "cases")]);
}
const casesOf = (who) => readdirSync(join(dirOf(who), "cases")).flatMap((f) => JSON.parse(readFileSync(join(dirOf(who), "cases", f), "utf8")));
ok(casesOf("p07").length === 2 && casesOf("p07").every((c) => c.provenance[0].contributor === "p07"),
  "[2] p07's cases carry p07's provenance");
const d08 = dirOf("p08");

// Dataset assembly: all cases, with the shared sentence merged into ONE case
// holding both sources, as log-to-cases does within a file. Then copies in
// every shape deletion has to reach: a .json dataset, the same as .jsonl one
// case per line, an analysis artifact holding the cases under a key, another
// holding them two keys deep, and a copy outside the root, in a directory the
// tool walks only because it is registered.
const all = [...casesOf("p07"), ...casesOf("p08")];
const merged = [];
for (const c of all) {
  const hit = merged.find((m) => m.input === c.input && m.expected === c.expected);
  if (hit) hit.provenance.push(...c.provenance); else merged.push(JSON.parse(JSON.stringify(c)));
}
mkdirSync(join(root, "datasets"), { recursive: true });
writeFileSync(join(root, "datasets", "train.json"), JSON.stringify(merged, null, 2));
writeFileSync(join(root, "datasets", "train.jsonl"), merged.map((c) => JSON.stringify(c)).join("\n") + "\n");
mkdirSync(join(root, "analysis"), { recursive: true });
writeFileSync(join(root, "analysis", "refusals.json"), JSON.stringify({ note: "per-batch analysis", cases: merged }, null, 2));
writeFileSync(join(root, "analysis", "nested.json"),
  JSON.stringify({ meta: { note: "nested analysis", cases: merged.length }, report: { cases: merged } }, null, 2));
writeFileSync(join(outside, "copy.json"), JSON.stringify({ kept: "elsewhere",
  cases: [merged.find((c) => c.input === only07), merged.find((c) => c.input === shared)] }, null, 2));
// A note holding only the SHARED sentence: it is p08's as much as p07's.
mkdirSync(join(root, "notes"), { recursive: true });
writeFileSync(join(root, "notes", "shared.txt"), `from the thread: ${shared}\n`);
// A symbolic link under the root, to a directory holding a p07-only case.
writeFileSync(join(beyond, "copy.json"), JSON.stringify([merged.find((c) => c.input === only07)], null, 2));
symlinkSync(beyond, join(root, "linked"));
ok(merged.length === 2 && merged.find((c) => c.input === shared).provenance.length === 2,
  "[2] the assembled dataset has the shared case once, with both sources");
const reg = run("contributions.mjs", ["register", outside, "--root", root]);
const registry = join(root, "beta", "artifact-roots.json");
// The symbolic link's target is registered too, so the link is covered.
ok(run("contributions.mjs", ["register", beyond, "--root", root]).status === 0, "[2] register the link's target as well");
ok(reg.status === 0 && JSON.parse(readFileSync(registry, "utf8")).includes(realpathSync(outside))
  && (statSync(registry).mode & 0o777) === 0o600 && (statSync(join(root, "beta")).mode & 0o777) === 0o700,
  "[2] register records the outside directory, 0600 in 0700");
ok(run("contributions.mjs", ["list", "--root", root]).out.includes(realpathSync(outside)), "[2] ...and list shows it");

// [4a] a dry run changes nothing
const snapshot = () => [join(root, "datasets", "train.json"), join(root, "datasets", "train.jsonl"),
  join(root, "analysis", "nested.json"), join(outside, "copy.json")].map((p) => readFileSync(p, "utf8")).join("\u0000");
const before = snapshot();
const dry = run("contributions.mjs", ["delete", "--contributor", "p07", "--dry-run", "--root", root]);
ok(dry.status === 0 && snapshot() === before && existsSync(join(root, "beta", "p07")),
  `[4] a dry run changes nothing (exit ${dry.status})`);
// ...and names what would remain: p07's own sentence in a note it cannot
// rewrite, but not the note holding the sentence p08 also wrote.
writeFileSync(join(root, "notes", "p07-draft.txt"), `draft: ${only07}\n`);
const dry2 = run("contributions.mjs", ["delete", "--contributor", "p07", "--dry-run", "--root", root]);
ok(dry2.status === 1 && dry2.out.includes(join("notes", "p07-draft.txt")) && /unsupported artifact/.test(dry2.out)
  && !dry2.out.includes("shared.txt"),
  `[4] a dry run names what would remain: p07's sentence in a .txt note, not the shared one (exit ${dry2.status})`);
ok(snapshot() === before && existsSync(join(root, "beta", "p07")), "[4] ...still changing nothing");
rmSync(join(root, "notes", "p07-draft.txt"));

// [3] delete p07
const del = run("contributions.mjs", ["delete", "--contributor", "p07", "--root", root]);
const out = del.out;
ok(del.status === 0, `[3] delete exits 0: its own check finds nothing of p07's left (exit ${del.status}${del.status ? ":\n" + out : ""})`);
ok(!existsSync(join(root, "beta", "p07")), "[3] p07's raw files, manifests and cases are gone");
const train = JSON.parse(readFileSync(join(root, "datasets", "train.json"), "utf8"));
ok(train.length === 1 && train[0].input === shared && train[0].provenance.length === 1
  && train[0].provenance[0].contributor === "p08",
  `[3] the dataset keeps only the shared case, with p08's source alone (${JSON.stringify(train.map((c) => c.provenance.map((p) => p.contributor)))})`);
const sources = (c) => c.provenance.map((p) => p.contributor).join(",");
const trainL = readFileSync(join(root, "datasets", "train.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
ok(trainL.length === 1 && trainL[0].input === shared && sources(trainL[0]) === "p08",
  "[3] ...and so does the .jsonl dataset, one case per line");
const refusals = JSON.parse(readFileSync(join(root, "analysis", "refusals.json"), "utf8"));
ok(refusals.cases.length === 1 && !JSON.stringify(refusals).includes("p07") && refusals.note === "per-batch analysis",
  "[3] ...and so does the analysis artifact, its other fields kept");
const nested = JSON.parse(readFileSync(join(root, "analysis", "nested.json"), "utf8"));
ok(nested.report.cases.length === 1 && sources(nested.report.cases[0]) === "p08" && nested.meta.note === "nested analysis",
  "[3] ...and the one holding its cases two keys deep, its other fields kept");
const copy = JSON.parse(readFileSync(join(outside, "copy.json"), "utf8"));
ok(copy.cases.length === 1 && copy.cases[0].input === shared && sources(copy.cases[0]) === "p08" && copy.kept === "elsewhere",
  "[3] ...and the copy in the registered directory outside the root");
ok([join(root, "datasets", "train.json"), join(root, "datasets", "train.jsonl"), join(root, "analysis", "refusals.json"),
  join(root, "analysis", "nested.json"), join(outside, "copy.json")].every((p) => !readFileSync(p, "utf8").includes("Only p07 wrote")),
  "[3] p07's own sentence is nowhere");
ok(/removed/.test(out), "[3] ...and the tool says what it removed");
ok(out.includes("symbolic link") && out.includes("linked") && !readFileSync(join(beyond, "copy.json"), "utf8").includes(only07),
  "[3] a symbolic link under the root is not followed; its registered target is scrubbed where it is");
// A link to somewhere NOT walked is a place the check could not look.
const nowhere = mkdtempSync(join(tmpdir(), "contrib-unreg-"));
symlinkSync(nowhere, join(root, "unregistered-link"));
const delLink = run("contributions.mjs", ["delete", "--contributor", "p07", "--root", root]);
ok(delLink.status === 1 && delLink.out.includes("unregistered-link"),
  `[3] a symbolic link to an unregistered directory fails the check, named (exit ${delLink.status})`);
rmSync(join(root, "unregistered-link"));
rmSync(nowhere, { recursive: true, force: true });

// [4b] p08 untouched
ok(existsSync(join(d08, "raw.jsonl")) && casesOf("p08").length === 1, "[4] p08's files and cases are untouched");

// [5] What delete cannot rewrite, it names. p09 wrote the shared sentence too,
// and one of their own; their own is left in a note and in a .jsonl line that
// does not parse.
const p09 = join(inbox, "p09.jsonl");
writeFileSync(p09, [rec("sn_d", shared), rec("sn_e", only09)].join("\n") + "\n");
node("contributions.mjs", ["ingest", p09, "--contributor", "p09", "--consent", "draft-2026-09-24",
  "--training", "no", "--channel", "email", "--root", root]);
writeFileSync(join(root, "notes", "p09-draft.txt"), `draft: ${only09}\n`);
writeFileSync(join(root, "notes", "p09-export.jsonl"), `{"input": ${JSON.stringify(only09)}, "expected": \n`);
const del09 = run("contributions.mjs", ["delete", "--contributor", "p09", "--root", root]);
ok(del09.status === 1 && /NOT fully deleted/.test(del09.out), `[5] a sentence only p09 wrote, left behind: exit 1, NOT fully deleted (exit ${del09.status})`);
ok(del09.out.includes(join("notes", "p09-draft.txt")) && del09.out.includes(join("notes", "p09-export.jsonl"))
  && /unsupported artifact/.test(del09.out), "[5] ...naming the .txt note and the .jsonl that does not parse, as unsupported");
ok(!del09.out.includes("shared.txt"), "[5] ...and not the note holding only the sentence p08 also wrote");
ok(!existsSync(join(root, "beta", "p09")), "[5] ...having removed everything it could");

// [6] --batch builds a path that is removed recursively.
const b08 = d08.split("/").pop();
const raw08 = join(d08, "raw.jsonl");
const status = (args) => run("contributions.mjs", ["delete", ...args, "--root", root]).status;
ok(status(["--contributor", "p07", "--batch", "../p08"]) === 2 && existsSync(raw08),
  "[6] --batch ../p08 is refused, and p08's files are still there");
ok(status(["--contributor", "p08", "--batch", `${b08}/cases`]) === 2 && existsSync(join(d08, "cases")),
  "[6] a --batch that is a path, even inside the contributor's own directory, is refused");
mkdirSync(join(root, "beta", "p07"));
symlinkSync(d08, join(root, "beta", "p07", "aaaaaaaaaaaa"));
ok(status(["--contributor", "p07", "--batch", "aaaaaaaaaaaa"]) === 2 && existsSync(raw08),
  "[6] a batch directory that is a symbolic link to p08's is refused");
symlinkSync(d08, join(root, "beta", "p08", "bbbbbbbbbbbb"));
ok(status(["--contributor", "p08", "--batch", "bbbbbbbbbbbb"]) === 2 && existsSync(join(root, "beta", "p08", "bbbbbbbbbbbb")),
  "[6] ...so is one that is a link to another of the contributor's own batches");
symlinkSync(join(root, "beta", "p08"), join(root, "beta", "p10"));
ok(status(["--contributor", "p10"]) === 2 && existsSync(join(root, "beta", "p10")) && existsSync(raw08),
  "[6] ...and a contributor directory that is a symbolic link");
ok(status(["--contributor", "p08", "--batch", "--dry-run"]) === 2 && existsSync(raw08),
  "[6] --batch with no id is refused, not read as every batch");

// [7a–e] Each note holds ONLY the designated field (no flat-field alias).
// Mutants in interactionProse: remove r.context [7a], r.retry?.firstOutput [7b],
// r.retry?.output [7c], the attempts output spread [7d], or the keep spread [7e].
// Each mutant turns its dry/real exit-1 and named-residual assertions red.
const nestedProse = [
  ["7a", (value) => ({ context: value })],
  ["7b", (value) => ({ retry: { firstOutput: value } })],
  ["7c", (value) => ({ retry: { output: value } })],
  ["7d", (value) => ({ v: 2, attempts: [{ output: value }] })],
  ["7e", (value) => ({ retry: { keep: [value] } })],
];
for (const [id, fields] of nestedProse) {
  const dir = mkdtempSync(join(tmpdir(), "contrib-prose-"));
  const value = `Only ${id} retained this "quoted" prose.\nAnother line.`;
  const source = join(inbox, `${id}.jsonl`);
  writeFileSync(source, JSON.stringify({ path: "sentence", ...fields(value) }) + "\n");
  node("contributions.mjs", ["ingest", source, "--contributor", "p11", "--consent", "draft-2026-09-24",
    "--training", "no", "--channel", "test", "--root", dir]);
  const note = join(dir, "residual.txt");
  writeFileSync(note, value);
  // JSON-string form is independently searched as well.
  writeFileSync(join(dir, "escaped.txt"), JSON.stringify(value));
  for (const dry of [true, false]) {
    const result = run("contributions.mjs", ["delete", "--contributor", "p11", "--root", dir,
      ...(dry ? ["--dry-run"] : [])]);
    const label = `[${id}] ${dry ? "dry" : "real"}`;
    ok(result.status === 1 && result.out.includes(dry ? "would NOT be fully deleted" : "NOT fully deleted"), `${label} residual exits 1`);
    ok(result.out.includes("residual.txt") && result.out.includes("escaped.txt"), `${label} names raw and escaped residuals`);
    ok(existsSync(join(dir, "beta", "p11")) === dry, `${label} preserves/removes contribution as requested`);
    ok(readFileSync(note, "utf8") === value, `${label} leaves unsupported note intact`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// [7f] Mutant: shared subtraction's const prose = interactionProse(r) becomes
// const prose = [r.input, r.output, r.finalText].filter((v) => typeof v === "string");
// The dry/real success and no-residual assertions turn red.
{
  const dir = mkdtempSync(join(tmpdir(), "contrib-shared-"));
  const value = "Both contributors retained this nested-only sentence.";
  for (const [who, record] of [["p11", { input: value }], ["p12", { attempts: [{ output: value }] }]]) {
    const source = join(inbox, `${who}-nested.jsonl`);
    writeFileSync(source, JSON.stringify({ path: "sentence", ...record }) + "\n");
    node("contributions.mjs", ["ingest", source, "--contributor", who, "--consent", "draft-2026-09-24",
      "--training", "no", "--channel", "test", "--root", dir]);
  }
  writeFileSync(join(dir, "shared-only.txt"), value);
  for (const dry of [true, false]) {
    const result = run("contributions.mjs", ["delete", "--contributor", "p11", "--root", dir,
      ...(dry ? ["--dry-run"] : [])]);
    ok(result.status === 0, `[7f] ${dry ? "dry" : "real"} nested shared text permits success`);
    ok(!result.out.includes("shared-only.txt"), `[7f] ${dry ? "dry" : "real"} shared note is not a residual`);
    ok(existsSync(join(dir, "beta", "p12")), `[7f] ${dry ? "dry" : "real"} other contributor remains`);
  }
  rmSync(dir, { recursive: true, force: true });
}

for (const d of [root, inbox, outside, beyond]) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
