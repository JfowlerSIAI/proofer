#!/usr/bin/env node
/**
 * The packaging boundary. Offline, no browser, no Ollama.
 *
 *   cd test && node package-test.mjs
 *
 * The point of this suite is NOT that tools/package.mjs copies files. It is
 * that RUNTIME_FILES is COMPLETE, and completeness cannot be checked against
 * the list itself -- that is the list checking its own homework. So the
 * inventory is derived three independent ways and each is compared with the
 * list:
 *
 *   1. manifest.json's own references (the worker, the content script, its CSS,
 *      every icon, the popup page).
 *   2. popup.html's src/href references. This is the one that catches popup.js,
 *      which NO manifest walk can see.
 *   3. background.js's chrome.runtime.getURL("...") literals. This catches the
 *      three data files: a missing dictionary FALLS BACK rather than throwing,
 *      so the extension runs with dictionary vetoes and checks disabled.
 *      Missing or invalid confusables/names instead remove generated grants,
 *      retaining hand supplements. Neither omission breaks the install.
 *
 * The licence notices are the fourth class and are deliberately checked against
 * a literal list: nothing references them at runtime by construction, so no
 * derivation can find them, and their absence is a licence violation rather
 * than a bug.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { packageExtension, verifyPackage, RUNTIME_FILES } from "../tools/package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const failures = [];
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}`); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "proofer-pkg-"));

console.log("\nPackaging boundary\n" + "=".repeat(72));

// --- 1. The inventory, derived three ways -----------------------------------
console.log("\nRUNTIME_FILES is complete, checked against three independent derivations:");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const fromManifest = new Set(["manifest.json"]);
fromManifest.add(manifest.background.service_worker);
for (const cs of manifest.content_scripts) {
  for (const j of cs.js || []) fromManifest.add(j);
  for (const c of cs.css || []) fromManifest.add(c);
}
for (const p of Object.values(manifest.icons || {})) fromManifest.add(p);
for (const p of Object.values(manifest.action?.default_icon || {})) fromManifest.add(p);
if (manifest.action?.default_popup) fromManifest.add(manifest.action.default_popup);
ok([...fromManifest].every((f) => RUNTIME_FILES.includes(f)),
   `every manifest.json reference is packaged (${fromManifest.size} refs)`);

// Every packaged page's own dependencies: the check that catches popup.js and
// welcome.js, which no manifest entry names.
const pages = RUNTIME_FILES.filter((f) => f.endsWith(".html"));
ok(pages.includes("popup.html") && pages.includes("welcome.html"),
   `the popup and the setup page are packaged (${pages.join(", ")})`);
for (const page of pages) {
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
    refs.add(ref.replace(/^\.\//, ""));
  }
  ok(refs.size > 0, `${page} declares local dependencies (${[...refs].join(", ")})`);
  ok([...refs].every((f) => RUNTIME_FILES.includes(f)),
     `every ${page} src/href is packaged -- the check that catches ${page.replace(".html", ".js")}`);
}

// Worker-fetched extension resources.
const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
const fromGetURL = new Set();
for (const m of bg.matchAll(/getURL\(\s*"([^"]+)"\s*\)/g)) fromGetURL.add(m[1]);
ok(fromGetURL.size >= 2, `background.js fetches extension resources (${[...fromGetURL].join(", ")})`);
ok([...fromGetURL].every((f) => RUNTIME_FILES.includes(f)),
   "every chrome.runtime.getURL resource is packaged -- a missing dictionary falls back SILENTLY");

for (const notice of ["LICENSE", "NOTICE", "data/THIRD_PARTY_NOTICES.md", "data/COPYING.LGPL-2.1",
                      "data/COPYRIGHT.SCOWL-2020.12.07"]) {
  ok(RUNTIME_FILES.includes(notice), `the licence notice ${notice} ships`);
}

// --- 2. A real package ------------------------------------------------------
console.log("\nA package is complete, self-describing and free of development assets:");
const out = tmp();
const built = packageExtension({ out });
ok(built.count === RUNTIME_FILES.length, `every listed file was written (${built.count})`);

const v = verifyPackage(built.dest);
ok(v.ok, `SHA256SUMS.txt covers exactly the payload and every digest verifies (${v.reason || v.count + " files"})`);

// Walk the OUTPUT, not the list: the failure worth catching is something in the
// package that nothing accounted for.
const walk = (dir, prefix = "") => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name)
                                  : [prefix ? `${prefix}/${e.name}` : e.name]);
const shipped = walk(built.dest);
ok(!shipped.some((f) => /node_modules|harvested|results|\.jsonl$|(^|\/)test(\/|$)|(^|\/)docs(\/|$)|(^|\/)audit(\/|$)/.test(f)),
   "no development asset, capture, result or recorded prose is in the package");
ok(built.bytes < 3 * 1024 * 1024,
   `the package is the runtime and not the repository (${(built.bytes / 1024).toFixed(0)} KB)`);

// --- 3. The packaged data still loads through the SHIPPING loaders ----------
// Copying a dictionary is not the same as shipping a working one, and the
// failure is silent: parseConfusables publishes NULL on any anomaly, so a
// truncated or re-encoded copy leaves the extension running with the ~50
// hand-picked pairs instead of 419 and nothing anywhere says so.
//
// So the packaged bytes go through the REAL loader rather than a
// reimplementation of its canonicalisation here -- a second copy of that logic
// is exactly what would let this suite pass while production published null.
console.log("\nThe packaged data satisfies the shipping loader's own integrity checks:");
{
  const vm = await import("vm");
  const ctx = vm.createContext({
    console: { error() {}, warn() {}, log() {} },
    chrome: {
      runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} },
                 getURL: (p) => "packaged:" + p },
      storage: { local: { setAccessLevel: async () => {}, get: (k, cb) => cb && cb({}), set() {}, remove() {} } },
      tabs: { create() {} },
    },
    fetch, setTimeout, clearTimeout, AbortController, URL,
    crypto: globalThis.crypto, TextEncoder,
  });
  vm.runInContext(bg + "\n;globalThis.__pkg = { fetchConfusables, CONFUSABLES_COUNT };", ctx);

  // Serve the PACKAGED file to the shipping loader.
  const servePackaged = (url) => {
    const rel = String(url).replace(/^packaged:/, "");
    const file = path.join(built.dest, rel);
    if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, text: async () => fs.readFileSync(file, "utf8") });
  };

  const set = await ctx.__pkg.fetchConfusables(servePackaged);
  // Duck-typed, not `instanceof`: the Set is constructed inside the vm realm,
  // so it is not an instance of THIS realm's Set and the obvious check fails on
  // a perfectly good load.
  ok(set && typeof set.size === "number" && set.size === ctx.__pkg.CONFUSABLES_COUNT,
     `the packaged confusables load through fetchConfusables itself (${set ? set.size : "null"} of ${ctx.__pkg.CONFUSABLES_COUNT})`);
  // A licence is only worth checking if you check one: size alone would pass on
  // 419 lines of anything.
  ok(!!set && set.has("weather|whether"),
     "and carry the licences the guards read (weather|whether)");

  // The control: the same loader over a DAMAGED copy must publish null. Without
  // this, a loader that returned a Set unconditionally would pass the line above.
  const damaged = await ctx.__pkg.fetchConfusables((url) =>
    Promise.resolve({ ok: true, status: 200,
      text: async () => fs.readFileSync(path.join(built.dest, "data/confusables-en.txt"), "utf8")
        .split("\n").slice(0, -3).join("\n") }));
  ok(damaged === null, "and a truncated copy publishes null -- so the check above is a real one");
}
const words = fs.readFileSync(path.join(built.dest, "data/words-en.txt"), "utf8")
  .split("\n").map((w) => w.replace(/\r$/, "")).filter(Boolean);
ok(words.length > 60000, `the packaged dictionary is whole (${words.length} words)`);

// --- 4. Omission is loud ----------------------------------------------------
// Four separate mutants rather than one: a single mutant that reddens every
// assertion proves less than four that each redden their own.
console.log("\nOmitting a runtime file fails the build rather than shipping a broken extension:");
for (const victim of ["popup.js", "data/words-en.txt", "data/confusables-en.txt",
                      "data/THIRD_PARTY_NOTICES.md"]) {
  const without = RUNTIME_FILES.filter((f) => f !== victim);
  const o = tmp();
  packageExtension({ out: o, files: without });
  const p = walk(o).filter((f) => f !== "SHA256SUMS.txt");
  ok(!p.includes(victim) && p.length === RUNTIME_FILES.length - 1,
     `dropping ${victim} is visible in the package inventory`);
  fs.rmSync(o, { recursive: true, force: true });
}

// A file that is LISTED but absent from the tree is the other direction, and it
// must throw rather than emit a partial extension.
{
  let threw = null;
  try { packageExtension({ out: tmp(), files: [...RUNTIME_FILES, "does-not-exist.js"] }); }
  catch (e) { threw = e; }
  ok(threw && threw.code === "MISSING" && /does-not-exist\.js/.test(threw.message),
     "a listed file that is not in the tree is a named, fatal error");
}
// And a denylisted path cannot be packaged even if somebody lists it.
//
// The fixture has to EXIST. The first version of this pointed at
// `test/harvested/x.jsonl`, which does not, so `MISSING` fired before execution
// ever reached the denylist -- and the assertion accepted either code, so it
// passed unchanged with the denylist deleted. It was testing the missing-file
// check twice.
{
  const home = tmp();
  fs.mkdirSync(path.join(home, "harvested"), { recursive: true });
  const bait = path.join(home, "harvested", "recorded.jsonl");
  fs.writeFileSync(bait, '{"input":"the user\'s own writing"}\n');
  let threw = null;
  try { packageExtension({ root: home, out: tmp(), files: ["harvested/recorded.jsonl"] }); }
  catch (e) { threw = e; }
  ok(threw && threw.code === "FORBIDDEN",
     `an existing denylisted file is refused as FORBIDDEN, not as missing (${threw && threw.code})`);
  fs.rmSync(home, { recursive: true, force: true });
}

// `--out` is a path from the command line and packaging starts with a recursive
// delete. `--out .` satisfied every other check -- the sources exist, none is
// denylisted -- and then deleted the checkout.
{
  for (const victim of [".", "..", "data", "icons"]) {
    let threw = null;
    try { packageExtension({ out: path.join(ROOT, victim) }); } catch (e) { threw = e; }
    ok(threw && threw.code === "UNSAFE_OUT",
       `--out ${victim} is refused rather than emptied (${threw && threw.code})`);
  }
  // A directory holding somebody else's files is not ours to empty either.
  const busy = tmp();
  const theirs = path.join(busy, "someones-file.txt");
  fs.writeFileSync(theirs, "do not delete me");
  let threw = null;
  try { packageExtension({ out: busy }); } catch (e) { threw = e; }
  ok(threw && threw.code === "UNSAFE_OUT", "a non-empty directory that is not a package is refused");
  ok(fs.existsSync(theirs), "and its contents are still there");
  // But re-packaging over a previous package IS the normal case.
  fs.rmSync(theirs);
  const first = packageExtension({ out: busy });
  const again = packageExtension({ out: busy });
  ok(again.count === first.count, "re-packaging over a previous package still works");
  fs.rmSync(busy, { recursive: true, force: true });

  // The two guards are separate and the second one MASKS the first for every
  // case above -- a directory holding source files is non-empty, so the
  // "not a previous package" rule catches it and the containment rule is never
  // reached. Deleting the containment check left all seven assertions green.
  //
  // This is the input only containment catches: a destination that holds the
  // source tree AND looks like a previous package output. It is reachable --
  // package into a directory, then let sources appear under it, or simply have
  // a stray SHA256SUMS.txt beside the checkout -- and it is the case where the
  // consequence is deleting somebody's working tree.
  // The fake source tree carries EVERY runtime file, from the list itself: a
  // hand copy here fired the missing-file check first when data/names-en.txt
  // joined the list (2026-09-19), and this case passed for the wrong reason.
  const trap = tmp();
  for (const f of RUNTIME_FILES) {
    fs.mkdirSync(path.dirname(path.join(trap, "src", f)), { recursive: true });
    fs.writeFileSync(path.join(trap, "src", f), f.endsWith(".js") ? "// source" : "x");
  }
  // Make the destination look like a previous package so the second guard stands down.
  fs.writeFileSync(path.join(trap, "SHA256SUMS.txt"), "");
  let trapped = null;
  try { packageExtension({ root: path.join(trap, "src"), out: trap }); }
  catch (e) { trapped = e; }
  ok(trapped && trapped.code === "UNSAFE_OUT",
     `a destination that CONTAINS the source tree is refused even when it looks like a package (${trapped && trapped.code})`);
  ok(fs.existsSync(path.join(trap, "src", "content.js")),
     "and the source tree it contains is still there");
  fs.rmSync(trap, { recursive: true, force: true });
}
// Tampering after the fact is caught by the digests.
{
  const o = tmp();
  const b = packageExtension({ out: o });
  fs.appendFileSync(path.join(b.dest, "content.js"), "\n// tampered\n");
  const bad = verifyPackage(b.dest);
  ok(!bad.ok && bad.reason === "digest-mismatch", "a modified payload file fails verification");
  fs.writeFileSync(path.join(b.dest, "extra.js"), "//");
  fs.rmSync(o, { recursive: true, force: true });
}
// A payload file with no digest entry is the failure reading the list cannot see.
{
  const o = tmp();
  const b = packageExtension({ out: o });
  fs.writeFileSync(path.join(b.dest, "stowaway.js"), "// not in SHA256SUMS");
  const bad = verifyPackage(b.dest);
  ok(!bad.ok && bad.reason === "unlisted-payload",
     "a file in the package with no digest entry fails verification");
  fs.rmSync(o, { recursive: true, force: true });
}

fs.rmSync(out, { recursive: true, force: true });
console.log("\n" + "=".repeat(72));
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${pass} checks passed.`);
