/**
 * WHICH EDITOR, AND HOW TO GET A KEYSTROKE INTO IT.
 *
 * A target descriptor is the harness half of an editor measurement: the URL, the
 * selector, and the handful of setup facts that were each bought by a
 * confidently wrong number. It is deliberately separate from the TRIAL ENGINE in
 * editor-recipe-probe.mjs, because the engine is general and every one of these
 * fields is not: `minClickY: 260` exists because CKEditor's docs site has a
 * sticky header, and nothing about "run both recipes in both phases" knows that.
 *
 * WHAT A FIELD HERE COSTS IF IT IS WRONG. Every quirk below was a run of write
 * failures with no write in them:
 *
 *   focusVia      A real mouse click at Trix's own coordinates leaves
 *                 activeElement on BODY. The keystrokes then go to the page and
 *                 every cell reads as a dead write rather than as a focus
 *                 problem. `el` calls .focus() instead; the KEYSTROKES are still
 *                 real, which is the half being measured.
 *   minClickY     CKEditor's editable is taller than the viewport under a sticky
 *                 header, so scrollIntoView({block:"center"}) puts its top
 *                 BEHIND the nav. Clicking there NAVIGATES, and the element
 *                 reference then reads as "the editor vanished".
 *   pickOutermost CKEditor's figcaptions carry the editable's own class. Taking
 *                 the first match measures a 50-character caption instead of the
 *                 document.
 *   clearPasses   Lexical's first Ctrl+A/Backspace leaves 844 characters behind,
 *                 which silently confounds every offset measured against it.
 *   strip*        An empty Slate composer is NOT an empty element: it holds a
 *                 zero-width ﻿ inside data-slate-zero-width plus an
 *                 absolutely-positioned [contenteditable="false"] placeholder,
 *                 and both land in textContent. Read as 21 characters of
 *                 leftover content it fails every Slate row -- on the one editor
 *                 carried as the positive control, so the run reports a broken
 *                 write where the write was never reached. (Quill, ProseMirror
 *                 and Lexical put their placeholders in CSS ::before or a
 *                 sibling node, so none of them shows it.)
 *
 * TWO TABLES, ONE OF THEM CHECKED. sentence-editors-test.mjs keeps its own
 * TARGETS array and still does: it is a GATE, it must stay importable-by-nobody
 * (it launches Chrome at module scope), and changing what it iterates to prove a
 * refactor is how a gate stops being one. The duplication is therefore
 * DECLARED rather than assumed away -- `crossCheckEditorsSuite()` reads that
 * file's literal and fails loudly when a shared field disagrees, so "two files
 * point at different URLs for the same editor" is a red rather than a discovery
 * six months later. An unchecked copy is the thing that rots; a checked one is
 * just two callers.
 */
import fs from "fs";
import path from "path";
import vm from "vm";

export const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Every field the engine reads, with the value it takes when a row is silent. */
export const TARGET_DEFAULTS = {
  label: null,               // display name; defaults to family
  recipe: null,              // the certified recipe, if this family has a row
  control: false,            // a known-honouring editor, so "nothing happened"
                             // is distinguishable from "the probe never fired"
  arms: null,                // null = every arm the engine knows
  probeDefault: false,       // in the probe's default candidate set
  quirk: null,

  focusVia: "click",         // "click" | "el"
  minClickY: 0,
  clearPasses: 6,
  readyMs: 1500,             // settle after the selector appears
  focusSettleMs: 350,
  clearSettleMs: 240,

  pickOutermost: true,       // the OUTERMOST match, not the first
  minWidth: 60,
  minHeight: 12,

  // Furniture removed before asking "is this editor empty".
  stripSelectors: ['[contenteditable="false"]', "[data-slate-placeholder]", '[aria-hidden="true"]'],
  stripChars: "﻿​",

  source: "built-in",
};

const REQUIRED = ["family", "url", "selector"];

/**
 * The arms an engine can run. HERE rather than in the probe, because a
 * descriptor may name a subset and something has to be able to reject a typo.
 *
 * `arms: ["intentt"]` used to be accepted -- `arms` was checked for being an
 * array and nothing else -- and the engine's dispatch is an if/else whose final
 * branch is mutation/checked, so the typo ran a DIFFERENT RECIPE and reported
 * itself under the typo'd name. A cell labelled `intentt` holding mutation
 * numbers is worse than a crash: it is a measurement that is wrong about what it
 * measured, which is the one error this whole file exists to prevent.
 */
export const KNOWN_ARMS = ["intent", "mutation-checked", "mutation-reimpose", "none"];

/**
 * A URL that Chrome can actually open.
 *
 * A scheme-prefix regex accepted `https://` and `https://[` -- values that reach
 * `page.goto`, fail there, and are then classified as UNREACHABLE, i.e. reported
 * as somebody else's outage rather than as the bad input they are.
 */
function urlProblem(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return `is not a URL`; }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    return `must be http(s):// or file:// (got ${parsed.protocol}//)`;
  }
  if (parsed.protocol !== "file:" && !parsed.hostname) return `has no host`;
  if (parsed.protocol === "file:" && !parsed.pathname) return `has no path`;
  return null;
}

/**
 * Fill the defaults and REFUSE a descriptor that cannot be measured.
 *
 * Loud, and before Chrome launches. A row with no selector used to be a
 * `waitForSelector(undefined)` twenty seconds into a run, reported as an
 * outage -- which is the same failure family as every other entry in this
 * repo's probe rules: the run completes, says something, and it is not true.
 */
export function normalizeTarget(row, { where = "descriptor" } = {}) {
  const bad = [];
  for (const k of REQUIRED) {
    if (typeof row[k] !== "string" || !row[k].trim()) bad.push(`${k} must be a non-empty string`);
  }
  if (typeof row.url === "string" && row.url.trim()) {
    const problem = urlProblem(row.url);
    if (problem) bad.push(`url ${problem} (got ${JSON.stringify(row.url)})`);
  }
  if (row.focusVia && !["click", "el"].includes(row.focusVia)) {
    bad.push(`focusVia must be "click" or "el" (got ${JSON.stringify(row.focusVia)})`);
  }
  for (const k of ["minClickY", "clearPasses", "readyMs", "focusSettleMs", "clearSettleMs",
                   "minWidth", "minHeight"]) {
    if (row[k] !== undefined && !(Number.isFinite(row[k]) && row[k] >= 0)) {
      bad.push(`${k} must be a non-negative number (got ${JSON.stringify(row[k])})`);
    }
  }
  if (row.arms !== undefined && row.arms !== null) {
    if (!Array.isArray(row.arms)) bad.push(`arms must be an array or null`);
    else {
      const unknownArms = row.arms.filter((a) => !KNOWN_ARMS.includes(a));
      // By name, not by count: the whole hazard is that the typo survives into
      // the report, so the error has to be the string that will be printed.
      if (unknownArms.length) {
        bad.push(`arms names ${unknownArms.map((a) => JSON.stringify(a)).join(", ")}; `
          + `known: ${KNOWN_ARMS.join(", ")}. An unknown arm does not fail -- it runs `
          + `mutation/checked and reports itself under the typo`);
      }
    }
  }
  const unknown = Object.keys(row).filter(
    (k) => !(k in TARGET_DEFAULTS) && !REQUIRED.includes(k));
  // A typo'd field is silently the default, which is exactly how `minclicky`
  // would produce CKEditor's navigation bug with the fix apparently applied.
  if (unknown.length) bad.push(`unknown field(s): ${unknown.join(", ")}`);
  if (bad.length) {
    const e = new Error(`${where} ${JSON.stringify(row.family || row.label || "?")}: ${bad.join("; ")}`);
    e.descriptorErrors = bad;
    throw e;
  }
  const out = { ...TARGET_DEFAULTS, ...row };
  out.label = out.label || out.family;
  return out;
}

/**
 * The rows. `probeDefault` marks the four the recorded matrix in
 * editor-recipe-probe.mjs was taken against -- the default set is those, so the
 * default command still reproduces the numbers in that header. The rest are
 * reachable by name (PROOFER_CANDIDATES=Quill), which is the whole point of a
 * bench: a certified editor can be re-characterised without editing a file.
 */
export const EDITOR_TARGETS = [
  {
    family: "Slate", recipe: "intent", control: true, probeDefault: true,
    url: "https://www.slatejs.org/examples/richtext",
    selector: '[data-slate-editor="true"]',
    arms: ["intent", "none"],
    quirk: "positive control; \\uFEFF placeholder furniture",
  },
  {
    family: "CKEditor5", probeDefault: true,
    url: "https://ckeditor.com/docs/ckeditor5/latest/examples/builds/classic-editor.html",
    selector: ".ck-editor__editable",
    minClickY: 260,
    // CKEditor's Renderer normalizes attributes on the editable root, so a
    // data-* marker set from the probe is REMOVED on the next render. The
    // element reference survives; a tag on it does not.
    quirk: "sticky header; renderer strips probe attributes; nested figcaptions",
  },
  {
    family: "Draft", recipe: "mutation", probeDefault: true,
    url: "https://draftjs.org/",
    selector: ".public-DraftEditor-content",
    quirk: "starts empty",
  },
  {
    family: "Trix", recipe: "mutation", probeDefault: true,
    url: "https://trix-editor.org/",
    selector: "trix-editor",
    focusVia: "el",
    quirk: "mouse click does not focus it; el.focus() does",
  },
  {
    family: "ProseMirror", recipe: "mutation", label: "ProseMirror (core)",
    url: "https://prosemirror.net/examples/basic/",
    selector: ".ProseMirror",
    quirk: "below the fold",
  },
  {
    family: "ProseMirror", recipe: "mutation", label: "ProseMirror (TipTap)",
    // Driven TOP-LEVEL. As an embedded iframe the keyboard never reaches it.
    url: "https://embed.tiptap.dev/src/examples/default/react/",
    selector: ".tiptap.ProseMirror",
    quirk: "top-level, not an iframe",
  },
  {
    family: "Quill", recipe: "mutation",
    url: "https://quilljs.com/",
    selector: ".ql-editor",
    quirk: "three instances, one off-screen",
  },
  {
    family: "Lexical", recipe: "mutation",
    url: "https://playground.lexical.dev/",
    selector: "[data-lexical-editor]",
    clearPasses: 6,
    quirk: "needs several clear passes",
  },
].map((r) => normalizeTarget(r, { where: "EDITOR_TARGETS" }));

/**
 * A descriptor synthesised from the environment: URL + selector, no code change.
 *
 * This is the entry point that makes the file a bench rather than a list. It
 * returns null when nothing was asked for, and THROWS when half of it was --
 * a URL with no selector is a request that cannot be honoured, and honouring it
 * approximately (guess a selector, take the first contenteditable) is how a
 * matrix gets attributed to the wrong element.
 */
export function adHocTargetFromEnv(env = process.env) {
  const url = (env.PROOFER_CANDIDATE_URL || "").trim();
  const selector = (env.PROOFER_CANDIDATE_SELECTOR || "").trim();
  if (!url && !selector) return null;
  if (!url || !selector) {
    throw new Error(
      "PROOFER_CANDIDATE_URL and PROOFER_CANDIDATE_SELECTOR must be set TOGETHER "
      + `(url=${JSON.stringify(url)}, selector=${JSON.stringify(selector)}). `
      + "A URL with no selector cannot name an element, and guessing one attributes "
      + "the matrix to whatever the guess found.");
  }
  const num = (k, d) => {
    if (env[k] === undefined || env[k] === "") return d;
    const n = Number(env[k]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k}=${env[k]} is not a non-negative number`);
    return n;
  };
  return normalizeTarget({
    family: (env.PROOFER_CANDIDATE_NAME || "Candidate").trim() || "Candidate",
    url, selector,
    focusVia: (env.PROOFER_CANDIDATE_FOCUS || "click").trim(),
    minClickY: num("PROOFER_CANDIDATE_MIN_CLICK_Y", 0),
    clearPasses: num("PROOFER_CANDIDATE_CLEAR_PASSES", TARGET_DEFAULTS.clearPasses),
    readyMs: num("PROOFER_CANDIDATE_READY_MS", TARGET_DEFAULTS.readyMs),
    source: "ad-hoc",
    quirk: "ad-hoc target from PROOFER_CANDIDATE_* -- nothing here has been measured before",
  }, { where: "PROOFER_CANDIDATE_*" });
}

/**
 * The duplication, checked.
 *
 * sentence-editors-test.mjs cannot be imported -- it launches Chrome at module
 * scope -- so its TARGETS literal is read as source and evaluated on its own.
 * That is the same trick lib/content-sandbox.mjs uses on content.js, and it is
 * honest for the same reason: the thing being compared is the actual shipping
 * literal, not a description of it.
 *
 * Returns { ok, checked, drift[], error }. A PARSE failure is an `error`, not a
 * quiet pass: "the shape changed so the check stopped running" is precisely the
 * silence this repo keeps paying for.
 *
 * IDENTITY fields only -- url, selector, family, recipe, focusVia. Those are
 * claims about WHICH editor is being driven, and two files disagreeing about one
 * means one of them measured something else. `clearPasses`, `readyMs` and the
 * rest are tuning: the suite stops at 3 passes and the probe at 6, both loop
 * until the field reads empty, and demanding they match would report a red for
 * a difference with no consequence.
 *
 * BOTH DIRECTIONS. Iterating the suite's rows alone answers "does the suite
 * disagree with a descriptor" and is silent on the two drifts that point the
 * other way: a suite row DELETED (its descriptor keeps pointing at an editor
 * nothing certifies any more) and a CERTIFIED descriptor with no suite row at
 * all -- which is the repo's own "a registry row without a suite row is an
 * assertion nobody checked", one level out. `recipe` is what makes that
 * checkable: a descriptor carrying one is claiming the family has an
 * SN_TRANSPORTS row, so it must have a suite row; CKEditor5 carries `null`
 * because it was measured and REFUSED, and is exempt by the same field.
 *
 * KNOWN LIMIT, recorded rather than papered over: this reads the suite's
 * `TARGETS` array LITERAL by substring, between `const TARGETS = [` and an
 * unindented `\n];`. Reordered fields and added rows are fine; wrapping the
 * array, moving the declaration, or building it from a helper is NOT, and comes
 * back as `error` -- "could not run", which the probe treats as failure rather
 * than as agreement. That is the safe direction, and the cost is that a
 * harmless reformat of a file this one does not own can block a run
 * (PROOFER_ALLOW_TARGET_DRIFT=1). A later `TARGETS.push(...)` is invisible to a
 * literal read, so it is detected textually and reported as "could not run"
 * too, rather than being silently half-checked.
 */
export function crossCheckEditorsSuite(file = path.join(HERE, "..", "sentence-editors-test.mjs")) {
  const out = { ok: false, checked: 0, drift: [], error: null, file };
  let src;
  try { src = fs.readFileSync(file, "utf8"); }
  catch (e) { out.error = `cannot read ${file}: ${e.message}`; return out; }
  const at = src.indexOf("const TARGETS = [");
  if (at === -1) {
    out.error = `no \`const TARGETS = [\` in ${file} -- the declaration moved or `
      + `changed shape, so this check cannot run (it is NOT agreement)`;
    return out;
  }
  const end = src.indexOf("\n];", at);
  if (end === -1) { out.error = `no terminating \`\\n];\` for TARGETS in ${file}`; return out; }
  // A literal read cannot see a later mutation, and half a check reported as a
  // whole one is the failure this file keeps arguing against.
  if (/\bTARGETS\s*\.\s*(push|splice|unshift|concat)\s*\(/.test(src)) {
    out.error = `${path.basename(file)} MUTATES TARGETS after the literal `
      + `(push/splice/unshift/concat); a literal read would check only part of it`;
    return out;
  }
  let theirs;
  try {
    theirs = vm.runInNewContext(src.slice(at + "const TARGETS = ".length, end + 3), {}, { timeout: 1000 });
  } catch (e) { out.error = `could not evaluate the TARGETS literal: ${e.message}`; return out; }
  if (!Array.isArray(theirs) || !theirs.length) {
    out.error = `TARGETS evaluated to ${JSON.stringify(theirs)} -- zero rows compares clean and proves nothing`;
    return out;
  }
  const mine = new Map(EDITOR_TARGETS.map((t) => [t.label, t]));
  const seen = new Set();
  for (const t of theirs) {
    const key = t.label || t.family;
    seen.add(key);
    const m = mine.get(key);
    if (!m) { out.drift.push(`${key}: in ${path.basename(file)} but not in EDITOR_TARGETS`); continue; }
    out.checked++;
    for (const f of ["url", "selector", "family", "recipe"]) {
      const a = t[f] === undefined ? null : t[f];
      const b = m[f] === undefined ? null : m[f];
      if (a !== b) out.drift.push(`${key}.${f}: suite ${JSON.stringify(a)} vs descriptor ${JSON.stringify(b)}`);
    }
    const theirFocus = t.focusVia || "click";
    if (theirFocus !== m.focusVia) {
      out.drift.push(`${key}.focusVia: suite ${JSON.stringify(theirFocus)} vs descriptor ${JSON.stringify(m.focusVia)}`);
    }
  }
  // THE OTHER DIRECTION. A descriptor carrying a `recipe` claims the family has
  // an SN_TRANSPORTS row, and the repo's standing rule is that such a row needs
  // a suite row as its evidence. So a certified descriptor the suite does not
  // cover is drift -- whether it was added here or DELETED there, which is the
  // case a one-directional walk is silent about.
  for (const m of EDITOR_TARGETS) {
    if (!m.recipe || seen.has(m.label)) continue;
    out.drift.push(`${m.label}: carries recipe ${JSON.stringify(m.recipe)} but `
      + `${path.basename(file)} has no row for it -- either the suite row was deleted `
      + `or the descriptor claims a certification nothing exercises`);
  }
  out.ok = out.drift.length === 0;
  return out;
}

/**
 * Pick the rows to run.
 *
 * `names` keeps its old meaning exactly: a comma-separated filter over family
 * (or label) names, and matching NOTHING is an error rather than a run of zero
 * cells. What is new is that an ad-hoc row exists to be matched, and that a
 * named ad-hoc row becomes the WHOLE set when no filter was given -- asking for
 * one URL and silently also getting four demo sites is not what was asked.
 */
export function resolveTargets({ names = [], env = process.env, defaults = null } = {}) {
  const adHoc = adHocTargetFromEnv(env);
  const pool = (defaults || EDITOR_TARGETS).concat(adHoc ? [adHoc] : []);
  if (!names.length) {
    const chosen = adHoc ? [adHoc] : pool.filter((t) => t.probeDefault);
    return { rows: chosen, pool, adHoc };
  }
  const rows = pool.filter((t) => names.includes(t.family) || names.includes(t.label));
  return { rows, pool, adHoc };
}
