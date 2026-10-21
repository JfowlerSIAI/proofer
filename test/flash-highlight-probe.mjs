#!/usr/bin/env node
/**
 * Can a CSS Custom Highlight carry the contenteditable green flash?
 *
 *   cd test && node flash-highlight-probe.mjs
 *   PROOFER_EDITORS=Slate,Lexical node flash-highlight-probe.mjs
 *   PROOFER_FLASH_LIVE=1 node flash-highlight-probe.mjs   # demo sites, not fixtures
 *
 * THE QUESTION. The flash marks the words a SILENT correction changed, and it
 * is the only signal the user gets, so it has to be on screen for the whole
 * 1600 ms while they keep typing into the next sentence. The textarea paints
 * fixed-position divs from rects measured once, so it is torn down the instant
 * anything could have moved them. A contenteditable's text is in the document,
 * so it can register live Ranges in a `Highlight` and let the browser paint
 * them wherever the text went.
 *
 * The hazard that buys is the opposite one: a live Range is only alive while
 * its boundary nodes are, and a framework that replaces the text node on
 * re-render collapses it. A flash that dies at 200 ms because React re-rendered
 * is "never shown" -- the failure teardown-on-input already produced once.
 *
 * WHAT SHIPPED, AND WHAT DID NOT. The GEOMETRY half of the overlay's teardown
 * rule is dropped (a live Range has no stored position to be wrong). The TEXT
 * half is kept exactly: `sentenceUndo` is a fixed `{start, endAfter}` pair, so
 * an edit before the correction breaks Escape whether the Range noticed or not,
 * and a green mark advertising a dead Escape is worse than none. Section [B]
 * therefore measures the Range's tracking as DATA -- what a re-anchored undo
 * could spend -- while section [F] gates that the flash dies on a before-edit
 * exactly as the overlay does.
 *
 * Sections, all of which gate the exit status:
 *   [A] SURVIVAL      1600 ms of jittered typing: registered, naming the same
 *                     word, and visibly tinted -- pixel-proved three times.
 *   [B] MOVEMENT      what the Range does when text before it changes.
 *   [C] RTL/CENTRE    the overlay's blind spot, on a plain contenteditable.
 *   [E] SHIPPED       the whole pipeline: real editor, real keystrokes, canned
 *                     model reply, styles.css loaded.
 *   [F] CONTRACT      Escape, edit-inside-the-word, a framework RE-RENDER that
 *                     replaces the text node without changing a character, a
 *                     correction that only DELETES, before-edit inside and
 *                     outside the 600 ms verify window, fade steps, textarea
 *                     overlay, and the overlay FALLBACK's block alignment.
 *                     (Suggestion mode's amber mark and chip, and the cases
 *                     coupling them to scroll, went with that mode on
 *                     2026-09-24.)
 *
 * PAINT IS PROVED BY DIFFERENCE, NOT BY COLOUR. An earlier version counted
 * "green" pixels over the whole viewport and reported 1765 of them on Trix --
 * which paints its own page green. It screenshots the Range's own rect twice,
 * with the registration present and removed, and counts pixels that got
 * greener. Page-native colour cancels; only the highlight survives the
 * subtraction. (The clip is in PAGE coordinates and getClientRects is in
 * VIEWPORT coordinates -- conflating them measured a box scrollY pixels away
 * and reported a confident zero.)
 *
 * Fixtures by default (test/fixtures, read-only, via lib/fixture-server.mjs),
 * live demo sites for the two families with no capture.
 */
import puppeteer from "puppeteer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import http from "http";
import { resolveChrome } from "./lib/chrome.mjs";
import { serveFixture } from "./lib/fixture-server.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXT = path.join(HERE, "..");
// PROOFER_CONTENT runs the whole probe against a DIFFERENT content.js, which
// is how a case earns the right to be called a gate: `git show HEAD:content.js
// > /tmp/pre.js` and the cases a fix was written for must go red against it.
// Same idiom as sentence-slate-test.mjs, and it is also the pre-fix control for
// any proposed change. The resolved path is stamped into the banner and the
// artifact below, so a result can never be read as being about the repo's own
// bytes when it is not.
const CONTENT_PATH = process.env.PROOFER_CONTENT || path.join(EXT, "content.js");
const CONTENT = fs.readFileSync(CONTENT_PATH, "utf8");
const STYLES = fs.readFileSync(path.join(EXT, "styles.css"), "utf8");
// Stamped into the artifact. A result is only evidence about the bytes it ran
// against, and an earlier artifact was read as current when it predated
// content.js by sixteen minutes -- which nothing in the file could have shown.
// Several sessions edit content.js at once here, so this is not hypothetical.
const SOURCE = {
  content: crypto.createHash("md5").update(CONTENT).digest("hex"),
  styles: crypto.createHash("md5").update(STYLES).digest("hex"),
  // Of the file that was actually READ, not of the repo's -- under
  // PROOFER_CONTENT those are different files, and stamping the repo's mtime
  // beside another file's hash is the exact confusion this stamp exists for.
  contentMtime: fs.statSync(CONTENT_PATH).mtime.toISOString(),
  contentPath: CONTENT_PATH,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIVE = process.env.PROOFER_FLASH_LIVE === "1";

// 22-129 ms inclusive. The band is the point: a human types unevenly, and every
// fixed cadence is a resonance waiting to hide a bug.
const jitter = () => 22 + Math.floor(Math.random() * 108);

const FLASH_MS = 1600;
const TYPO = "The techncian arrived early.";
// Typed ahead of the sentence under test where a fixture must OVERFLOW.
const LEAD = "Some earlier words here. ";
const FIXED = "The technician arrived early.";
const WORD = "technician";
const WORD_START = 4, WORD_END = 4 + WORD.length;
const FLASH_NAMES = ["proofer-sn-flash-3", "proofer-sn-flash-2", "proofer-sn-flash-1"];

let pass = 0, fail = 0;
// A check that could not be run at all. Treated the way sentence-editors-test
// treats an unreachable demo site: exit 77, never 0, because a green run that
// quietly skipped the assertion is the failure mode this file exists for.
const notRun = [];
const ok = (cond, label) => {
  console.log(`    ${cond ? "PASS" : "FAIL"}: ${label}`);
  cond ? pass++ : fail++;
  return !!cond;
};
// Measured and reported, deliberately not gated: numbers that describe the
// world rather than assert about our code.
const note = (label) => console.log(`    note: ${label}`);

const TARGETS = [
  { family: "Slate", fixture: "slatejs.org", entry: "/examples/richtext",
    url: "https://www.slatejs.org/examples/richtext", selector: '[data-slate-editor="true"]' },
  { family: "ProseMirror", fixture: "prosemirror.net", entry: "/examples/basic/",
    url: "https://prosemirror.net/examples/basic/", selector: ".ProseMirror" },
  { family: "Quill", fixture: "quilljs.com", entry: "/",
    url: "https://quilljs.com/", selector: ".ql-editor" },
  { family: "Lexical", fixture: "playground.lexical.dev", entry: "/",
    url: "https://playground.lexical.dev/", selector: "[data-lexical-editor]", clearPasses: 3 },
  { family: "Draft", fixture: "draftjs.org", entry: "/",
    url: "https://draftjs.org/", selector: ".public-DraftEditor-content" },
  { family: "Trix", fixture: "trix-editor.org", entry: "/",
    url: "https://trix-editor.org/", selector: "trix-editor", focusVia: "el" },
];

const only = (process.env.PROOFER_EDITORS || "").split(",").map((s) => s.trim()).filter(Boolean);
const rows = only.length ? TARGETS.filter((t) => only.includes(t.family)) : TARGETS;
if (!rows.length) {
  console.error(`PROOFER_EDITORS matched no target. Known: ${TARGETS.map((t) => t.family).join(", ")}`);
  process.exit(2);
}
if (rows.length !== TARGETS.length) {
  notRun.push(`filtered out: ${TARGETS.filter((t) => !rows.includes(t)).map((t) => t.family).join(", ")}`);
}

// --- the in-page probe -----------------------------------------------------
const PROBE = `
window.__hl = {
  arm(start, end) {
    const el = window.__ed;
    const range = window.__prooferSentence.rangeForInnerTextOffset(el, start, end - start);
    if (!range) return { ok: false, why: "no-range" };
    if (!window.CSS || !CSS.highlights || typeof Highlight === "undefined") {
      return { ok: false, why: "no-highlight-api" };
    }
    const st = document.createElement("style");
    st.textContent = "::highlight(proofer-sn-probe-flash){background-color:rgba(46,160,67,0.28);}";
    document.head.appendChild(st);
    CSS.highlights.set("proofer-sn-probe-flash", new Highlight(range));
    window.__hlRange = range;
    window.__hlName = "proofer-sn-probe-flash";
    const rects = [...range.getClientRects()].map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
    window.__ovRects = rects.map((r) => ({ ...r }));
    window.__ovGuard = {
      end: end,
      prefix: window.__prooferSentence.snText(el).slice(0, end),
      rect: (() => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width }; })(),
    };
    return { ok: true, text: range.toString(), rects };
  },
  sample() {
    const r = window.__hlRange, el = window.__ed;
    let text = null, rects = [], collapsed = null;
    try { text = r.toString(); collapsed = r.collapsed; } catch (e) {}
    try { rects = [...r.getClientRects()].map((x) => ({ left: x.left, top: x.top, width: x.width, height: x.height })); } catch (e) {}
    const g = window.__ovGuard;
    const er = el.getBoundingClientRect();
    const overlayAlive = el.isConnected
      && window.__prooferSentence.snText(el).slice(0, g.end) === g.prefix
      && Math.abs(er.left - g.rect.left) <= 0.5 && Math.abs(er.top - g.rect.top) <= 0.5
      && Math.abs(er.width - g.rect.width) <= 0.5;
    const o = window.__ovRects[0], n = rects[0];
    const dx = (o && n) ? +(n.left - o.left).toFixed(1) : null;
    const dy = (o && n) ? +(n.top - o.top).toFixed(1) : null;
    let scrolled = window.scrollY;
    for (let p = el; p; p = p.parentElement) scrolled += (p.scrollTop || 0);
    return {
      text, collapsed, rects,
      connected: !!(r.startContainer && r.startContainer.isConnected && r.endContainer && r.endContainer.isConnected),
      contained: !!(el.contains(r.startContainer) && el.contains(r.endContainer)),
      registered: CSS.highlights.has(window.__hlName),
      hasBoxes: rects.length > 0 && rects.every((x) => x.width >= 1 && x.height >= 1),
      overlayAlive, overlayDrift: (o && n) ? Math.max(Math.abs(dx), Math.abs(dy)) : null, dx, dy, scrolled,
    };
  },
  disarm() { CSS.highlights.delete(window.__hlName); },
};
`;

const chrome = await resolveChrome();
const servers = new Map();
async function urlFor(t) {
  if (LIVE || !t.fixture) return { url: t.url, mode: t.fixture ? "live" : "live (no capture)" };
  if (!servers.has(t.fixture)) {
    try { servers.set(t.fixture, await serveFixture(path.join(HERE, "fixtures", t.fixture))); }
    catch (e) { servers.set(t.fixture, { err: e.message }); }
  }
  const s = servers.get(t.fixture);
  if (s.err) return { url: t.url, mode: "live (capture missing)" };
  return { url: s.url(t.entry), mode: "fixture" };
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath: chrome.path,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});

const userText = (page) => page.evaluate(() => {
  const c = window.__ed.cloneNode(true);
  for (const n of c.querySelectorAll('[contenteditable="false"], [data-slate-placeholder], [aria-hidden="true"]')) n.remove();
  return c.textContent.replace(/[﻿​]/g, "").trim();
});
const dom = (page) => page.evaluate(() => window.__ed.textContent);

async function typeJittered(page, s) {
  for (const ch of s) { await page.keyboard.type(ch); await sleep(jitter()); }
}

function splice(page, start, end, replacement) {
  return page.evaluate((a) => window.__prooferSentence.spliceSentenceVia(
    window.__ed, a.start, a.end, a.replacement), { start, end, replacement });
}

/**
 * Is the highlight VISIBLY TINTED, over the Range's own rect, and is the tint
 * OURS rather than the page's?
 *
 * THREE frames, not two, and the registrations are frozen for all of them:
 *
 *   [on]   as it is now
 *   [off1] every proofer highlight name deleted, and `CSS.highlights.set`
 *          neutered first -- content.js's fade steps on a timer, and a step
 *          landing between the delete and the screenshot re-registers the next
 *          name, so the "without" frame comes back still tinted and a visible
 *          highlight measures zero. Freezing the setter is the only way to hold
 *          the page still across an async screenshot.
 *   [off2] the same state again.
 *
 * `on - off1` is the highlight PLUS whatever the page was animating; `off2 -
 * off1` is the page animating on its own, with nothing of ours in it. A hover
 * transition, a spinner or a reflow inside the clip produces the same signed
 * green delta as a tint, so the highlight only counts if it clears that floor
 * by a margin. And the accepted signal has to be a COHERENT AREA the size of
 * the range, not `n > 0`: one stray pixel is noise however green it is.
 *
 * `name` is the registered name to toggle: the probe's own in [A]-[C],
 * content.js's in [E].
 */
async function paintProof(page, name) {
  const geo = await page.evaluate((n) => {
    const h = n ? CSS.highlights.get(n) : null;
    const range = n ? (h && h.values().next().value) : window.__hlRange;
    if (!range) return { why: "no-range" };
    const r = range.getClientRects()[0];
    if (!r) return { why: "no-rect" };
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      return { why: "off-screen", rect: { left: r.left, top: r.top } };
    }
    return {
      // PAGE coordinates for the screenshot clip; getClientRects is viewport.
      x: Math.max(0, r.left + scrollX - 3), y: Math.max(0, r.top + scrollY - 3),
      w: r.width + 6, h: r.height + 6,
      rect: { left: +r.left.toFixed(1), top: +r.top.toFixed(1),
              width: +r.width.toFixed(1), height: +r.height.toFixed(1) },
      pad: { left: r.left - 3, top: r.top - 3 },
    };
  }, name || null);
  if (geo.why) return { ok: false, why: geo.why, rect: geo.rect || null };

  const clip = { x: geo.x, y: geo.y, width: geo.w, height: geo.h };
  const on = await page.screenshot({ clip, encoding: "binary" });
  const stash = await page.evaluate(() => {
    const names = ["proofer-sn-flash-3", "proofer-sn-flash-2", "proofer-sn-flash-1",
                   "proofer-sn-probe-flash"];
    window.__stash = names.filter((n) => CSS.highlights.has(n)).map((n) => [n, CSS.highlights.get(n)]);
    for (const [n] of window.__stash) CSS.highlights.delete(n);
    // FREEZE. For two screenshots the registry is empty to the COMPOSITOR and
    // unchanged to JAVASCRIPT. Both halves are needed and each was learned by
    // breaking something:
    //
    //   set/delete are stubbed and logged IN ORDER, because two screenshots
    //   take longer than the rest of a flash's life on a slow page. The 1600ms
    //   expiry ran inside an earlier freeze, its delete went nowhere, and the
    //   restore put the flash back -- a measurement that resurrects what it is
    //   measuring, which would hide any teardown bug.
    //
    //   get/has serve the PRE-FREEZE view, because content.js's watchdog now
    //   asks every frame whether its own name still holds its Ranges (the
    //   page-collision defence). Deleting for the screenshot looked exactly
    //   like a page stealing the name, so the guard correctly tore the flash
    //   down -- and the probe's own instrument was what killed it.
    const view = new Map(window.__stash);
    window.__real = {
      set: CSS.highlights.set.bind(CSS.highlights),
      del: CSS.highlights.delete.bind(CSS.highlights),
      get: CSS.highlights.get.bind(CSS.highlights),
      has: CSS.highlights.has.bind(CSS.highlights),
    };
    window.__ops = [];
    CSS.highlights.set = (n, h) => { window.__ops.push(["set", n, h]); view.set(n, h); return CSS.highlights; };
    CSS.highlights.delete = (n) => { window.__ops.push(["del", n]); return view.delete(n); };
    CSS.highlights.get = (n) => (view.has(n) ? view.get(n) : window.__real.get(n));
    CSS.highlights.has = (n) => (view.has(n) ? true : window.__real.has(n));
    return window.__stash.length;
  });
  const off1 = await page.screenshot({ clip, encoding: "binary" });
  const off2 = await page.screenshot({ clip, encoding: "binary" });
  await page.evaluate(() => {
    const R = window.__real;
    if (R) {
      CSS.highlights.set = R.set; CSS.highlights.delete = R.del;
      CSS.highlights.get = R.get; CSS.highlights.has = R.has;
    }
    // Put back what was there, then replay everything content.js asked for
    // while it was frozen, in order. A fade step ends as one registration; an
    // expiry ends as none.
    for (const [n, h] of (window.__stash || [])) CSS.highlights.set(n, h);
    for (const op of (window.__ops || [])) {
      if (op[0] === "set") CSS.highlights.set(op[1], op[2]);
      else CSS.highlights.delete(op[1]);
    }
    window.__ops = [];
  });
  if (!stash) return { ok: false, why: "nothing-registered", rect: geo.rect };

  return page.evaluate(async (a) => {
    const load = async (d) => {
      const img = new Image();
      img.src = "data:image/png;base64," + d;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return { px: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    };
    const A = await load(a.on), B = await load(a.off1), C = await load(a.off2);
    if (A.w !== B.w || A.h !== B.h || A.w !== C.w || A.h !== C.h) {
      return { ok: false, why: "size-mismatch" };
    }
    // "Greener than it was", not "green". Page-native colour is in every frame
    // and cancels; this is what exonerated Trix, whose page is itself green.
    const tint = (p, i) => p[i + 1] - (p[i] + p[i + 2]) / 2;
    const count = (X, Y) => {
      let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let i = 0; i < X.px.length; i += 4) {
        if (tint(X.px, i) - tint(Y.px, i) > 8) {
          n++;
          const p = i / 4, x = p % X.w, y = (p / X.w) | 0;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      return { n, minX, minY, maxX, maxY };
    };
    const sig = count(A, B);          // highlight + any page animation
    const noise = count(C, B).n;      // page animation alone
    const dpr = A.w / a.w;
    // The expected tinted area, in device pixels, allowing for the glyphs
    // inside it (which tint too, but less) and antialiasing at the edges.
    const expect = a.rect.width * a.rect.height * dpr * dpr;
    const floor = Math.max(24, expect * 0.4, noise * 3);
    return {
      ok: sig.n >= floor, px: sig.n, noise, floor: Math.round(floor), expect: Math.round(expect),
      box: sig.maxX < 0 ? null : {
        left: +(a.padLeft + sig.minX / dpr).toFixed(1), top: +(a.padTop + sig.minY / dpr).toFixed(1),
        width: +((sig.maxX - sig.minX + 1) / dpr).toFixed(1),
      },
      rect: a.rect,
    };
  }, { on: Buffer.from(on).toString("base64"), off1: Buffer.from(off1).toString("base64"),
       off2: Buffer.from(off2).toString("base64"),
       w: geo.w, padLeft: geo.pad.left, padTop: geo.pad.top, rect: geo.rect });
}

/** How far the visible tint sits from the Range's own rect. */
function paintOffset(p) {
  if (!p || !p.ok || !p.box || !p.rect) return null;
  return {
    left: +Math.abs(p.box.left - p.rect.left).toFixed(1),
    top: +Math.abs(p.box.top - p.rect.top).toFixed(1),
    width: +Math.abs(p.box.width - p.rect.width).toFixed(1),
  };
}

async function session(t) {
  const { url, mode } = await urlFor(t);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e).split("\n")[0]));
  await page.evaluateOnNewDocument(`window.chrome = {
    runtime: { id: "t", lastError: undefined,
      sendMessage: (m, cb) => setTimeout(() => cb({ ok: true, noChanges: true }), 10) },
    storage: { local: { get: (d, cb) => cb({ ...d }), set: (o, cb) => cb && cb() },
               onChanged: { addListener: () => {} } } };`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector(t.selector, { timeout: 25000 });
  await sleep(1200);

  const box = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    const vis = els.find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 60 && r.height > 12 && r.left >= 0 && r.top >= -10000;
    }) || els[0];
    window.__ed = vis;
    vis.scrollIntoView({ block: "center" });
    const r = vis.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 120), y: r.top + 14 };
  }, t.selector);
  if (t.focusVia === "el") await page.evaluate(() => window.__ed.focus());
  else await page.mouse.click(box.x, box.y);
  await sleep(250);
  const focused = await page.evaluate(() =>
    !!document.activeElement && (document.activeElement === window.__ed
      || window.__ed.contains(document.activeElement)));
  if (!focused) throw new Error("click did not focus the editor");

  for (let i = 0; i < (t.clearPasses || 2); i++) {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await sleep(220);
    if (!(await userText(page))) break;
  }
  await page.evaluate(CONTENT);
  await page.evaluate(PROBE);
  await sleep(200);
  errors.length = 0;
  return { page, errors, mode, box };
}

const report = [];

// ===========================================================================
// [A] SURVIVAL and [B] MOVEMENT -- the mechanism, with a probe-built Range
// ===========================================================================
for (const t of rows) {
  const row = { family: t.family, mode: "?", A: null, B: null };
  report.push(row);
  console.log(`\n${"=".repeat(72)}\n${t.family}`);

  try {
    const { page, errors, mode } = await session(t);
    row.mode = mode;
    console.log(`  source: ${mode}`);
    console.log(`  [A] survival: 1600ms of jittered typing after the correction`);
    await typeJittered(page, TYPO + " Then we");
    await sleep(300);
    const before = await dom(page);
    if (before !== TYPO + " Then we") throw new Error(`typing did not land: ${JSON.stringify(before)}`);

    await splice(page, 0, TYPO.length, FIXED);
    await sleep(60);
    const armed = await page.evaluate((a) => window.__hl.arm(a.s, a.e), { s: WORD_START, e: WORD_END });
    if (!armed.ok) throw new Error(`could not arm: ${armed.why}`);
    ok(armed.text === WORD, `armed on exactly ${JSON.stringify(WORD)} (${JSON.stringify(armed.text)})`);

    // Pixel proof at birth. `registered` gates the predicate: geometry alone is
    // not paint, which is what an earlier version of this file asserted.
    const paint0 = await paintProof(page, null);
    ok(paint0.ok, `visibly tinted at t=0 (${paint0.px || 0} px vs floor ${paint0.floor}, `
       + `page-animation noise ${paint0.noise}, ${paint0.why || "ok"})`);
    const off0 = paintOffset(paint0);
    ok(off0 && off0.left <= 3 && off0.top <= 3 && off0.width <= 4,
       `and the tint sits on the Range's own rect (|dleft| ${off0 && off0.left}, |dtop| ${off0 && off0.top}, `
       + `|dwidth| ${off0 && off0.width}; tolerance 3/3/4 px)`);

    const t0 = Date.now();
    const samples = [];
    const take = async () => {
      const s = await page.evaluate(() => window.__hl.sample());
      samples.push({ t: Date.now() - t0, ...s });
    };
    await take();
    let paintMid = null;
    for (const ch of " shipped later") {
      await page.keyboard.type(ch);
      await take();
      // A second pixel proof, mid-burst, after the text has actually changed.
      if (!paintMid && Date.now() - t0 > 400) paintMid = await paintProof(page, null);
      await sleep(jitter());
      if (Date.now() - t0 > FLASH_MS) break;
    }
    while (Date.now() - t0 < FLASH_MS) { await sleep(70); await take(); }
    await take();
    const paintEnd = await paintProof(page, null);

    // A sample is good only if it is REGISTERED, contained, naming the word,
    // and has boxes. Any of those missing is a flash the user is not getting.
    const bad = samples.find((s) => s.text !== WORD || !s.hasBoxes || !s.contained || !s.registered);
    ok(!bad, `registered, contained and naming ${JSON.stringify(WORD)} at every one of `
       + `${samples.length} samples across ${FLASH_MS}ms`
       + (bad ? ` -- first bad at ${bad.t}ms: ${JSON.stringify({ text: bad.text, boxes: bad.hasBoxes, contained: bad.contained, registered: bad.registered })}` : ""));
    ok(!!(paintMid && paintMid.ok), `still visibly tinted mid-burst `
       + `(${(paintMid && paintMid.px) || 0} px vs floor ${paintMid && paintMid.floor})`);
    ok(!!(paintEnd && paintEnd.ok), `and at the end of the burst `
       + `(${(paintEnd && paintEnd.px) || 0} px vs floor ${paintEnd && paintEnd.floor})`);
    const offEnd = paintOffset(paintEnd);
    ok(!!offEnd && offEnd.left <= 3 && offEnd.top <= 3,
       `the tint has followed the text, not stayed put (|dleft| ${offEnd && offEnd.left}, |dtop| ${offEnd && offEnd.top})`);

    const overlayDied = samples.find((s) => !s.overlayAlive);
    const maxDrift = Math.max(...samples.map((s) => s.overlayDrift ?? 0));
    const worst = samples.find((s) => (s.overlayDrift ?? 0) === maxDrift) || {};
    const scrolledBy = samples.length ? worst.scrolled - samples[0].scrolled : 0;
    note(`the overlay guard would have said "alive" until `
      + `${overlayDied ? overlayDied.t + "ms" : "the end"}, while the text moved `
      + `dx=${worst.dx} dy=${worst.dy} (page/inner scroll ${scrolledBy}px). `
      + `That gap is the overlay showing a stale box.`);
    row.A = {
      samples: samples.length, allGood: !bad,
      paint: { birth: paint0.px || 0, mid: (paintMid && paintMid.px) || 0, end: (paintEnd && paintEnd.px) || 0 },
      offsets: { birth: off0, end: offEnd },
      overlayDiedAtMs: overlayDied ? overlayDied.t : null,
      overlayWorstDxDy: [worst.dx ?? null, worst.dy ?? null],
      scrolledByPx: scrolledBy,
      trace: samples,
    };
    ok(errors.filter((e) => !/Failed to fetch|NetworkError|ERR_/.test(e)).length === 0,
       `no page exception (${JSON.stringify(errors.slice(0, 2))})`);
    await page.close();
  } catch (e) {
    row.A = { error: String(e.message || e) };
    ok(false, `[A] ${t.family}: ${e.message}`);
  }

  // --- [B] an edit BEFORE it -----------------------------------------------
  //
  // DATA, not a shipped behaviour: the flash is torn down on this either way
  // (the undo is offset-anchored). What is measured is what a re-anchored undo
  // would have to spend -- and, gated, that the Range never paints over the
  // WRONG words at any point during the editor's normalization.
  try {
    const { page, mode } = await session(t);
    row.mode = mode;
    console.log(`  [B] movement: five characters inserted BEFORE the flashed word`);
    await typeJittered(page, TYPO + " Then we");
    await sleep(300);
    await splice(page, 0, TYPO.length, FIXED);
    await sleep(60);
    const armed = await page.evaluate((a) => window.__hl.arm(a.s, a.e), { s: WORD_START, e: WORD_END });
    if (!armed.ok) throw new Error(`could not arm: ${armed.why}`);
    const rect0 = armed.rects[0];

    await page.keyboard.down("Control");
    await page.keyboard.press("Home");
    await page.keyboard.up("Control");
    await sleep(120);
    // Sampled through the whole edit, not once at the end: a transient wrong
    // word during normalization is exactly what a single late sample misses.
    const seen = [];
    for (const ch of "Hey. ") {
      await page.keyboard.type(ch);
      seen.push(await page.evaluate(() => window.__hl.sample()));
      await sleep(jitter());
      seen.push(await page.evaluate(() => window.__hl.sample()));
    }
    await sleep(250);
    const s = await page.evaluate(() => window.__hl.sample());
    seen.push(s);
    // The one outcome that would be worse than dying.
    const misleading = seen.find((x) => x.text && x.text !== WORD && x.hasBoxes && x.registered);
    ok(!misleading, `never painted over other words at any of ${seen.length} samples`
       + (misleading ? ` -- saw ${JSON.stringify(misleading.text)}` : ""));
    const r1 = s.rects[0];
    row.B = {
      text: s.text, collapsed: s.collapsed, contained: s.contained,
      movedPx: (rect0 && r1) ? +(r1.left - rect0.left).toFixed(1) : null,
      tracked: s.text === WORD && s.hasBoxes,
      overlayAlive: s.overlayAlive,
    };
    note(`the Range ${row.B.tracked ? `TRACKED the text (+${row.B.movedPx}px)`
      : `COLLAPSED (text ${JSON.stringify(s.text)}) -- the block was re-rendered`}`
      + `; the overlay guard is dead here either way (${s.overlayAlive})`);
    await page.close();
  } catch (e) {
    row.B = { error: String(e.message || e) };
    ok(false, `[B] ${t.family}: ${e.message}`);
  }
}

// ===========================================================================
// [C] RTL / centred -- the overlay's known blind spot
// ===========================================================================
console.log(`\n${"=".repeat(72)}\n[C] RTL / centred (plain contenteditable, no framework)`);
const rtl = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("about:blank");
  await page.evaluate(PROBE
    .replace("window.__prooferSentence.rangeForInnerTextOffset(el, start, end - start)",
      "(() => { const t = el.firstChild; const r = document.createRange(); r.setStart(t, start); r.setEnd(t, end); return r; })()")
    .replaceAll("window.__prooferSentence.snText(el)", "el.textContent"));
  for (const style of ["direction:rtl", "text-align:center", "text-align:right", "text-align:left"]) {
    const out = await page.evaluate((st) => {
      document.body.innerHTML = "";
      const d = document.createElement("div");
      d.contentEditable = "true";
      d.style.cssText = "width:600px;font:16px monospace;" + st;
      d.textContent = "The technician arrived early. Then we";
      document.body.appendChild(d);
      window.__ed = d;
      const a = window.__hl.arm(4, 14);
      const before = a.rects[0];
      d.firstChild.appendData(" shipped later on and on");
      const s = window.__hl.sample();
      const after = s.rects[0];
      return { text: s.text, hasBoxes: s.hasBoxes,
               dx: after && before ? +(after.left - before.left).toFixed(1) : null };
    }, style);
    const paint = await paintProof(page, null);
    await page.evaluate(() => window.__hl.disarm());
    const offset = paintOffset(paint);
    rtl.push({ style, ...out, px: paint.px || 0, offset });
    ok(out.text === WORD && out.hasBoxes && paint.ok && offset && offset.left <= 3,
       `${style.padEnd(18)} tint follows the line (moved ${out.dx}px, ${paint.px || 0} px tinted `
       + `vs floor ${paint.floor}, |dleft| ${offset && offset.left})`);
  }
  await page.close();
} catch (e) {
  ok(false, `[C] ${e.message}`);
}

// ===========================================================================
// [E] the SHIPPED path -- content.js's own flashSentenceRanges, end to end
// ===========================================================================
const SHIP_STUB = (apply = true, typo = TYPO, fixed = FIXED) => `
window.__sent = [];
window.__store = { disabledSites: [], sentenceDebug: false };
window.chrome = {
  runtime: {
    id: "test-ext", lastError: undefined,
    sendMessage: (msg, cb) => {
      window.__sent.push(msg);
      setTimeout(() => {
        if (msg.type === "SENTENCE_CONSENT") return cb({ ok: true, allowed: true, apply: ${apply} });
        if (msg.type === "SENTENCE_REWRITE") {
          return msg.sentence === ${JSON.stringify(typo)}
            ? cb({ ok: true, rewritten: ${JSON.stringify(fixed)}, apply: ${apply} })
            : cb({ ok: true, noChanges: true });
        }
        cb({ ok: true });
      }, 20);
    },
  },
  storage: { local: { get: (d, cb) => cb({ ...d, ...window.__store }), set: (o, cb) => cb && cb() },
             onChanged: { addListener: () => {} } },
};
`;

/** What content.js has registered right now, and over which words. */
const shipState = (page) => page.evaluate(() => {
  const names = ["proofer-sn-flash-3", "proofer-sn-flash-2", "proofer-sn-flash-1"];
  // The fallback case stubs `CSS.highlights` away entirely, and reading through
  // it threw from inside the helper -- which reads as a broken assertion rather
  // than as the arrangement the case is actually testing.
  const live = CSS.highlights ? names.filter((n) => CSS.highlights.has(n)) : [];
  const texts = [];
  for (const n of live) for (const r of CSS.highlights.get(n)) texts.push(r.toString());
  return { live, texts, overlayNodes: document.querySelectorAll(".proofer-sentence-mark").length };
});
const fieldStatus = (page) => page.evaluate(() =>
  window.__prooferSentence.sentenceFieldStatus(window.__ed));

console.log(`\n${"=".repeat(72)}\n[E] the shipped flash, driven through a real silent apply`);
for (const t of rows) {
  console.log(`\n  ${t.family}`);
  let page = null;
  try {
    const { url } = await urlFor(t);
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const perr = [];
    page.on("pageerror", (e) => perr.push(String(e.message || e).split("\n")[0]));
    await page.evaluateOnNewDocument(SHIP_STUB());
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForSelector(t.selector, { timeout: 25000 });
    await sleep(1200);
    const box = await page.evaluate((sel) => {
      const els = [...document.querySelectorAll(sel)];
      const vis = els.find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 60 && r.height > 12 && r.left >= 0;
      }) || els[0];
      window.__ed = vis;
      vis.scrollIntoView({ block: "center" });
      const r = vis.getBoundingClientRect();
      return { x: r.left + Math.min(r.width / 2, 120), y: r.top + 14 };
    }, t.selector);
    if (t.focusVia === "el") await page.evaluate(() => window.__ed.focus());
    else await page.mouse.click(box.x, box.y);
    await sleep(200);
    for (let i = 0; i < (t.clearPasses || 2); i++) {
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await sleep(220);
      if (!(await userText(page))) break;
    }
    await page.addStyleTag({ content: STYLES });
    await page.evaluate(CONTENT);
    await sleep(200);
    // BLUR, then focus. content.js attaches sentence mode on `focusin`, and the
    // editor was already focused by the clearing pass -- so clicking it again
    // moves focus nowhere, fires no event, and sentence mode never attaches.
    // Every message stayed unsent and it read as a trigger bug.
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await sleep(120);
    if (t.focusVia === "el") await page.evaluate(() => window.__ed.focus());
    else await page.mouse.click(box.x, box.y);
    await sleep(300);

    await typeJittered(page, TYPO + " The");
    // POLL for the flash. A fixed sleep put every "still up at +900ms" question
    // on a clock that started wherever the sleep happened to end: on the
    // mutation recipe the flash was already ~700ms old when first seen, so a
    // +900ms check read +1600ms and four families "failed" by expiring on time.
    let born = 0;
    const tBegin = Date.now();
    while (Date.now() - tBegin < 4000) {
      if ((await shipState(page)).live.length) { born = Date.now(); break; }
      await sleep(20);
    }
    const applied = await dom(page);
    if (!applied.startsWith(FIXED)) {
      const status = await fieldStatus(page).catch(() => null);
      console.log(`    NOT RUN: the correction never landed (${JSON.stringify(applied)}); `
        + `field status ${JSON.stringify(status)}; flash never appeared (born=${born}). `
        + `That is the write path, upstream of any flash code.`);
      notRun.push(`${t.family}: write did not land (born=${born}, ${status && status.detail})`);
      // The stronger claim, recorded rather than asserted in prose: execution
      // returned before the flash, so this run says nothing about the flash.
      if (born !== 0) ok(false, `${t.family}: no correction, yet a flash appeared -- that is not the write path`);
      await page.close();
      page = null;
      continue;
    }
    ok(true, `the correction applied silently: ${JSON.stringify(applied)}`);
    ok(born > 0, `and its birth was observed, so the clock below is real`);

    const s0 = await shipState(page);
    ok(s0.live.length === 1 && /^proofer-sn-flash-/.test(s0.live[0] || ""),
       `one flash highlight is registered (${JSON.stringify(s0.live)})`);
    // EXACTLY the changed word. "substring of FIXED" passed a Range over the
    // whole sentence, under an assertion labelled "and nothing else".
    ok(s0.texts.length === 1 && s0.texts[0] === WORD,
       `over exactly ${JSON.stringify(WORD)} and nothing else (${JSON.stringify(s0.texts)})`);
    ok(s0.overlayNodes === 0, `and no overlay div was painted (${s0.overlayNodes})`);
    const paint0 = await paintProof(page, s0.live[0]);
    ok(paint0.ok, `the extension's own stylesheet visibly tints it `
       + `(${paint0.px || 0} px vs floor ${paint0.floor}, noise ${paint0.noise}, ${paint0.why || "ok"})`);
    const off0 = paintOffset(paint0);
    ok(!!off0 && off0.left <= 3 && off0.top <= 3,
       `on the Range's rect (|dleft| ${off0 && off0.left}, |dtop| ${off0 && off0.top})`);

    const waitTo = async (ms) => {
      const w = born + ms - Date.now();
      if (w > 0) await sleep(w);
      return shipState(page);
    };
    await typeJittered(page, "n we s");
    const s1 = await waitTo(900);
    ok(s1.live.length === 1, `still up at +900ms, mid-burst (${JSON.stringify(s1.live)})`);
    ok(s1.texts.length === 1 && s1.texts[0] === WORD,
       `still over exactly the changed word (${JSON.stringify(s1.texts)})`);
    const paint1 = await paintProof(page, s1.live[0]);
    ok(paint1.ok, `and still visibly tinted after the keystrokes `
       + `(${paint1.px || 0} px vs floor ${paint1.floor})`);

    const s2 = await waitTo(FLASH_MS + 500);
    ok(s2.live.length === 0, `cleared when the 1600ms is up (${JSON.stringify(s2.live)})`);
    // A captured fixture is offline by construction, so the page's own
    // analytics and font fetches reject. Ours is the only code under test.
    const mine = perr.filter((e) => !/Failed to fetch|NetworkError|ERR_/.test(e));
    ok(mine.length === 0, `no page exception (${JSON.stringify(mine.slice(0, 2))})`);
    await page.close();
    page = null;
  } catch (e) {
    ok(false, `[E] ${t.family}: ${e.message}`);
    if (page) await page.close().catch(() => {});
  }
}

// ===========================================================================
// [F] the contract -- teardown, undo coherence, and the overlay fallback
// Includes fallback later-word edit: the whole undo anchor on the overlay path.
// ===========================================================================
console.log(`\n${"=".repeat(72)}\n[F] the contract`);

const localPage = `<!doctype html><html lang="en"><body style="padding:20px">
<textarea id="ta" style="width:520px;height:120px;font:14px monospace"></textarea>
<!-- Exactly long enough to hold the typo and not the correction, so the chip's
     Apply reaches applySentence's maxlength refusal. -->
<textarea id="capped" maxlength="32" style="width:520px;height:60px;font:14px monospace"></textarea>
<!-- A ProseMirror FINGERPRINT, deliberately, and not a Slate-shaped div: Slate
     takes the INTENT recipe, which dispatches beforeinput and waits for a model
     to act on it, so on a div with no model behind it every write is correctly
     rejected and there is no flash to make assertions about. The mutation
     recipe writes with execCommand, which a plain contenteditable honours -- so
     this page can answer questions about the FLASH. What the editors themselves
     do is [A], [B] and [E]. -->
<div id="ce" class="ProseMirror" contenteditable="true" lang="en"
     style="width:520px;min-height:60px;font:14px monospace;border:1px solid #ccc"></div>
<!-- The overlay FALLBACK's blind spot: a centred BLOCK inside a host that
     computes text-align:start. -->
<div id="centred" class="ProseMirror" contenteditable="true" lang="en"
     style="width:520px;min-height:60px;font:14px monospace;border:1px solid #ccc"
  ><p style="text-align:center;margin:0;min-height:20px"></p></div>
<!-- Its control. Byte-identical apart from the block's text-align, so the pair
     can ONLY come apart if the alignment is read from the block. Both hosts
     compute text-align:start, which is what the old code looked at. -->
<div id="plain" class="ProseMirror" contenteditable="true" lang="en"
     style="width:520px;min-height:60px;font:14px monospace;border:1px solid #ccc"
  ><p style="text-align:left;margin:0;min-height:20px"></p></div>
<!-- A scrollable editor: the Range moves, the field's rect does not. -->
<div id="scroller" class="ProseMirror" contenteditable="true" lang="en"
     style="width:150px;height:34px;overflow:auto;font:14px monospace;border:1px solid #ccc"></div>
</body></html>`;
const localServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(localPage);
});
await new Promise((r) => localServer.listen(0, "127.0.0.1", r));
const LOCAL = `http://127.0.0.1:${localServer.address().port}/`;

/** A local page with sentence mode attached, a correction applied, flash up. */
async function localFresh(sel, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  // `typo`/`fixed` override the canned pair, which is how a case can ask what
  // happens for a correction of a DIFFERENT SHAPE -- a pure deletion has no
  // inserted text, and that is a property of the reply, not of the fixture.
  const typo = opts.typo || TYPO;
  await page.evaluateOnNewDocument(SHIP_STUB(opts.apply !== false, typo, opts.fixed || FIXED));
  // `noHighlightApi` forces the overlay FALLBACK on a contenteditable, which is
  // the only way to exercise the path that still measures rects.
  if (opts.noHighlightApi) {
    await page.evaluateOnNewDocument(`Object.defineProperty(CSS, "highlights",
      { configurable: true, get: () => undefined });`);
  }
  await page.goto(LOCAL);
  await page.addStyleTag({ content: STYLES });
  await page.evaluate(CONTENT);
  await sleep(150);
  await page.evaluate((s) => { window.__ed = document.querySelector(s); }, sel);
  await page.click(sel);
  await sleep(120);
  // Put the caret INSIDE the inner block when there is one. Clicking the host
  // put it beside the empty <p>, so the typed text became a direct child of the
  // host and inherited the host's alignment -- the fixture quietly stopped
  // being a centred-block fixture, and the case passed the code it was meant
  // to catch. (Verified in the DOM: `...early. The<p style="text-align:center">`.)
  if (opts.caretInside) {
    await page.evaluate((s) => {
      const inner = document.querySelector(s + " p");
      const r = document.createRange();
      r.setStart(inner, 0);
      r.collapse(true);
      const sel2 = getSelection();
      sel2.removeAllRanges();
      sel2.addRange(r);
    }, sel);
    await sleep(60);
  }
  if (opts.type !== false) {
    // The tail is what makes the keystroke trigger fire on a TEXTAREA, three
    // characters into the next sentence. On a contenteditable it is not needed
    // and is now actively unhelpful for the suggestion cases: the field's own
    // trailing block boundary stopped being read as a newline, so a rich editor
    // fires on the keystroke that FINISHES the sentence -- which puts the chip
    // on screen while these characters are still being typed, and on a narrow
    // field the typing scrolls it, which correctly drops the mark before the
    // case has arranged anything. `tail: ""` stops at the terminator so the
    // arrangement is deterministic; what is under test is unchanged.
    // `lead` is typed BEFORE the sentence under test. The narrow #scroller
    // fixture has to overflow to scroll at all, and it used to get that from
    // the tail; a sentence the stub answers `noChanges` to buys the same two
    // lines without putting keystrokes after the trigger point.
    if (opts.lead) await typeJittered(page, opts.lead);
    await typeJittered(page, typo + (opts.tail !== undefined ? opts.tail : " The"));
    // POLL, do not sleep. A flat 500ms wait was how the "inside the 600ms
    // verify window" case ended up acting at ~620ms and measuring the window it
    // was written to avoid. `page.appliedAt` is the moment the flash appeared,
    // which is within a few ms of the apply, so every later case can time
    // itself against the verifier's own clock.
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const st = await shipState(page);
      if (st.live.length || st.overlayNodes) break;
      await sleep(15);
    }
    page.appliedAt = Date.now();
    if (opts.settle !== false) await sleep(opts.settle || 0);
  }
  return page;
}

/** Sleep until `ms` after the correction landed. */
async function sinceApply(page, ms) {
  const w = (page.appliedAt || Date.now()) + ms - Date.now();
  if (w > 0) await sleep(w);
}

// --- Escape takes the correction back, and the flash with it ---------------
try {
  const p = await localFresh("#ce");
  ok((await shipState(p)).live.length === 1, "Escape: the flash is a highlight before it");
  await p.keyboard.press("Escape");
  await sleep(200);
  ok((await shipState(p)).live.length === 0, "Escape clears the highlight");
  const txt = await p.evaluate(() => window.__prooferSentence.snText(document.querySelector("#ce")));
  ok(txt.includes("techncian"), `and the correction is reverted: ${JSON.stringify(txt.trim())}`);
  await p.close();
} catch (e) { ok(false, `[F] Escape: ${e.message}`); }

// --- An edit INSIDE the flashed word grows the Range ------------------------
try {
  const p = await localFresh("#ce");
  ok((await shipState(p)).live.length === 1, "inside-edit: flash up before the edit");
  await p.evaluate(() => {
    const el = document.querySelector("#ce");
    const t = window.__prooferSentence.rangeForInnerTextOffset(el, 9, 1);
    const sel = getSelection();
    sel.removeAllRanges();
    t.collapse(true);
    sel.addRange(t);
  });
  await p.keyboard.type("XX", { delay: 40 });
  await sleep(200);
  ok((await shipState(p)).live.length === 0, "an edit inside the flashed word clears it");
  await p.close();
} catch (e) { ok(false, `[F] inside-edit: ${e.message}`); }

// --- A FRAMEWORK RE-RENDER IS NOT AN EDIT ----------------------------------
//
// The hazard named in this file's own header, and it shipped for as long as the
// highlight path has existed. React replaces a text node outright whenever the
// host element does not have exactly one text child (`textContent = ...` rather
// than an in-place `nodeValue` write), so a composer re-rendering from its own
// app state -- a draft persisted, a decorator resolved -- detaches every Range
// we registered without moving one character on screen. The watchdog read that
// as gone and cleared, and the whole signal for a silent correction was a green
// tint nobody ever saw.
//
// [A] cannot catch it: it measures survival under TYPING, and the editors it
// runs against re-render in the way that PRESERVES the node (React keeps a lone
// text child), which is why every one of them is green while the bug is live.
// The discriminator has to be applied to the DOM directly.
try {
  const p = await localFresh("#ce");
  ok((await shipState(p)).live.length === 1, "re-render: flash up before it");
  const swapped = await p.evaluate(() => {
    const el = document.querySelector("#ce");
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (w.nextNode()) nodes.push(w.currentNode);
    const target = nodes.find((n) => n.nodeValue && n.nodeValue.trim());
    if (!target) return null;
    // Byte-identical, so nothing about the TEXT has changed -- only which node
    // object holds it. Anything the flash or Escape depends on is untouched.
    const fresh = document.createTextNode(target.nodeValue);
    target.parentNode.replaceChild(fresh, target);
    return { detached: !el.contains(target), text: fresh.nodeValue };
  });
  ok(swapped && swapped.detached,
     `the text node really was replaced and the old one detached (${JSON.stringify(swapped)})`);
  await sleep(200);   // ~12 watchdog frames
  const after = await shipState(p);
  ok(after.live.length === 1,
     `the flash survives it (${JSON.stringify(after.live)})`);
  ok(after.texts.length === 1 && after.texts[0] === WORD,
     `still naming exactly the changed word (${JSON.stringify(after.texts)})`);
  // Registered is not painted: the re-anchor rebuilds Range objects, and a
  // Highlight holding ranges nobody re-registered paints nothing at all.
  const paint = after.live.length ? await paintProof(p, after.live[0]) : { ok: false, px: 0 };
  ok(paint.ok, `and is still visibly tinted (${paint.px || 0} px vs floor ${paint.floor})`);
  // The affordance the teardown existed to protect, proved unharmed rather than
  // assumed: green visible must still mean Escape works.
  await p.keyboard.press("Escape");
  await sleep(200);
  const txt = await p.evaluate(() => window.__prooferSentence.snText(document.querySelector("#ce")));
  ok(txt.includes("techncian"), `and Escape still takes it back (${JSON.stringify(txt.trim())})`);
  await p.close();
} catch (e) { ok(false, `[F] re-render: ${e.message}`); }

// --- ALIASING *AND* A RE-RENDER, WHICH IS THE UNSAFE COMBINATION -----------
//
// The two hazards are covered separately below and above and neither catches
// this. Aliasing alone is caught by the offset check: the live Range TRACKS the
// insertion, so it reports an offset that is not the one it was armed at. A
// re-render alone is repaired. Together, the Range collapses -- so there is no
// tracked offset left to catch the aliasing with -- and a repair that rebuilds
// at the armed offset finds a byte-identical copy sitting there and re-arms
// onto it. Every string comparison in the guard is satisfied, the mark goes
// green again, and `sentenceUndo` is a fixed offset pair, so Escape would
// splice the copy: a WRONG splice advertised as safe.
//
// Found by an adversarial review of the repair, not by running it, which is why
// it gets a case: the repair's own verification is the whole safety argument
// and this is the shape that verification cannot make on its own.
try {
  const p = await localFresh("#ce");
  // OUTSIDE THE 600ms VERIFY WINDOW, and this is the whole arrangement rather
  // than a detail. Inside it, applySentence's own async verifier notices the
  // page rewriting the field and clears the flash itself -- so the case goes
  // green against a build with no protection in the repair at all, measuring a
  // mechanism it is not about. Traced, not guessed: the teardown came from
  // `verify`, not from the flash guard. Same shape as the before-edit pair
  // below, which splits on this window for the same reason.
  await sinceApply(p, 900);
  ok((await shipState(p)).live.length === 1, "alias+re-render: flash up before it, past the verify window");
  const done = await p.evaluate((fixed) => {
    const el = document.querySelector("#ce");
    // One mutation batch: insert a byte-identical copy of the corrected
    // sentence in FRONT, and rebuild the node while doing it -- which is how a
    // controlled editor would apply an insertion in the first place.
    const all = el.textContent;
    el.textContent = fixed + " " + all;
    return { text: el.textContent };
  }, FIXED);
  await sleep(200);
  const after = await shipState(p);
  ok(after.live.length === 0,
     `the flash is withdrawn rather than re-armed onto the copy (${JSON.stringify(after.live)})`);
  // The consequence, stated rather than implied: with the mark gone the user is
  // not told Escape is available, which is correct, because it is not.
  ok(done.text.startsWith(FIXED + " " + FIXED),
     `and the arrangement really did alias (${JSON.stringify(done.text.slice(0, 64))})`);
  await p.close();
} catch (e) { ok(false, `[F] alias+re-render: ${e.message}`); }

// --- A RE-RENDER THAT CHANGES ONLY MARKUP ---------------------------------
//
// Byte-identical is not the same as unchanged. A composer can rebuild the
// sentence with one word bold -- a decorator resolving, a search term
// highlighted -- and every text comparison the repair makes still passes. But
// `spliceSentenceCE` refuses a non-uniform range, so Escape would be swallowed
// and do nothing, under a mark saying it is safe to press. Green visible has to
// mean Escape works, so the repair asks the splice's own question over the span
// the undo will splice.
try {
  const p = await localFresh("#ce");
  await sinceApply(p, 900);
  ok((await shipState(p)).live.length === 1, "markup-only re-render: flash up first");
  const made = await p.evaluate((word) => {
    const el = document.querySelector("#ce");
    const t = el.textContent;
    const at = t.indexOf(word);
    // Rebuilt, byte-identical in TEXT, with one word bold. The node swap is
    // what collapses the Range; the <b> is what makes the undo unwritable.
    el.innerHTML = "";
    el.append(document.createTextNode(t.slice(0, at)));
    const b = document.createElement("b");
    b.textContent = word;
    el.append(b, document.createTextNode(t.slice(at + word.length)));
    return { text: el.textContent, bold: !!el.querySelector("b") };
  }, WORD);
  ok(made.bold && made.text === FIXED + " The",
     `the rebuild changed markup and not one character (${JSON.stringify(made)})`);
  await sleep(200);
  const after = await shipState(p);
  ok(after.live.length === 0,
     `the flash is withdrawn rather than advertising a dead Escape (${JSON.stringify(after.live)})`);
  // The consequence the case is really about, proved rather than assumed:
  // Escape here cannot do anything, so the mark had to go.
  await p.keyboard.press("Escape");
  await sleep(200);
  const txt = await p.evaluate(() => window.__prooferSentence.snText(document.querySelector("#ce")));
  ok(txt.includes("technician"),
     `and Escape is indeed a no-op on it (${JSON.stringify(txt.trim())})`);
  await p.close();
} catch (e) { ok(false, `[F] markup-only re-render: ${e.message}`); }

// --- A CORRECTION THAT ONLY DELETES ----------------------------------------
//
// `changedRanges(..., "ins")` returns the segments present in the AFTER text,
// and a pure deletion has none -- so `flashSentenceRanges` returned on the
// empty array and a doubled word vanished with no signal whatsoever. It is not
// an exotic shape: `the the` -> `the` passes every guard in the chain, and a
// silent apply's flash is also the only thing telling the user Escape has
// something to take back.
try {
  const DUP = "Can you send me the the invoice.";
  const DEDUP = "Can you send me the invoice.";
  const p = await localFresh("#ce", { typo: DUP, fixed: DEDUP });
  const st = await shipState(p);
  const txt = await p.evaluate(() => window.__prooferSentence.snText(document.querySelector("#ce")));
  ok(txt.includes(DEDUP), `deletion-only: the correction landed (${JSON.stringify(txt.trim())})`);
  ok(st.live.length === 1, `and it is flashed rather than silent (${JSON.stringify(st.live)})`);
  // The word that CLOSED UP over the gap. There is no changed span to paint --
  // what changed is a gap -- so the mark points at the word that visibly moved.
  ok(st.texts.length === 1 && st.texts[0] === "invoice.",
     `over the word that closed up over it (${JSON.stringify(st.texts)})`);
  const paint = st.live.length ? await paintProof(p, st.live[0]) : { ok: false, px: 0 };
  ok(paint.ok, `and visibly tinted (${paint.px || 0} px vs floor ${paint.floor})`);
  await p.close();
} catch (e) { ok(false, `[F] deletion-only: ${e.message}`); }

// --- THE UNDO CONTRACT: an edit BEFORE the correction ----------------------
//
// The Range would happily follow it ([B] measures how far). The flash must not,
// because `sentenceUndo` is a fixed {start, endAfter} pair: following the text
// would leave a green mark advertising an Escape that silently does nothing.
// Both sides of the 600ms verify window, because they reach it differently.
for (const [label, atMs] of [["inside the 600ms verify window", 120], ["after it", 900]]) {
  try {
    const p = await localFresh("#ce");
    ok((await shipState(p)).live.length === 1, `before-edit ${label}: flash up first`);
    // TIMED FROM THE APPLY, not from an arbitrary sleep. The earlier version
    // waited 500ms in localFresh and then added 120ms more, so the "inside"
    // case was already past 600ms and both cases measured the same window.
    await sinceApply(p, atMs);
    const at = Date.now() - p.appliedAt;
    await p.keyboard.down("Control");
    await p.keyboard.press("Home");
    await p.keyboard.up("Control");
    await typeJittered(p, "Hey. ");
    const done = Date.now() - p.appliedAt;
    ok(atMs > 600 ? done > 600 : at < 600,
       `before-edit ${label}: the insertion really happened ${atMs > 600 ? "after" : "inside"} `
       + `the window (started +${at}ms, finished +${done}ms)`);
    await sleep(250);
    const st = await shipState(p);
    ok(st.live.length === 0, `before-edit ${label}: the flash is gone (${JSON.stringify(st.live)})`);
    // And it agrees with the undo: Escape must not half-work.
    const textBefore = await p.evaluate(() => document.querySelector("#ce").textContent);
    await p.keyboard.press("Escape");
    await sleep(200);
    const textAfter = await p.evaluate(() => document.querySelector("#ce").textContent);
    ok(textAfter === textBefore,
       `and Escape is a no-op rather than a wrong splice (${JSON.stringify(textAfter)})`);
    // Whether the verifier ALSO blocks the field is the write path's business,
    // not the flash's -- item3-targetranges owns that surface. Reported so the
    // artifact carries the answer either way; deliberately not gated here.
    const status = await p.evaluate(() =>
      window.__prooferSentence.sentenceFieldStatus(document.querySelector("#ce")));
    const verdicts = await p.evaluate(() => window.__sent
      .filter((m) => m.type === "REWRITE_OUTCOME").map((m) => m.verdict));
    note(`before-edit ${label}: field status afterwards ${status.status}`
      + `${status.detail ? "/" + status.detail : ""}, verdicts ${JSON.stringify(verdicts)}`);
    await p.close();
  } catch (e) { ok(false, `[F] before-edit ${label}: ${e.message}`); }
}

// --- A LATER WORD in the corrected sentence -------------------------------
//
// The flash marks "technician"; Escape anchors the whole rewritten sentence.
// Editing "early" leaves the flashed word untouched and kills Escape, so a
// guard watching only as far as the last change stayed green over a dead
// affordance. This is the assertion that fails without `anchorEnd`.
try {
  const p = await localFresh("#ce");
  ok((await shipState(p)).live.length === 1, "later-word edit: flash up first");
  await p.evaluate(() => {
    const el = document.querySelector("#ce");
    // Just before the final "." of "...arrived early." -- inside the anchor,
    // after the highlighted word.
    const t = window.__prooferSentence.rangeForInnerTextOffset(el, 28, 1);
    t.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(t);
  });
  await p.keyboard.type("XX", { delay: 40 });
  await sleep(250);
  const st = await shipState(p);
  const anchored = await p.evaluate(() => {
    const el = document.querySelector("#ce");
    return window.__prooferSentence.snText(el).slice(0, 29);
  });
  ok(st.live.length === 0,
     `an edit to a later word in the same sentence clears it (${JSON.stringify(st.live)}, `
     + `text now ${JSON.stringify(anchored)})`);
  await p.close();
} catch (e) { ok(false, `[F] later-word edit: ${e.message}`); }

// --- [F] fallback later-word edit -----------------------------------------
// SD-44 mutant: replace the overlay guard's end/prefix line with
// end: Math.max(...ranges.map((r) => r.end)), prefix: snText(el).slice(0, Math.max(...ranges.map((r) => r.end))),
// Only "fallback later-word edit: clears the overlay before expiry" turns red;
// arrangement, append survival, geometry, Escape refusal and the Highlight
// later-word control above must stay green.
try {
  const p = await localFresh("#ce", { noHighlightApi: true, tail: "" });
  const geometry = () => p.evaluate(() => {
    const el = document.querySelector("#ce"), r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height, el.scrollLeft, el.scrollTop, scrollX, scrollY];
  });
  const initialGeometry = await geometry();
  const text = () => p.evaluate(() => window.__prooferSentence.snText(document.querySelector("#ce")));
  ok(await text() === "The technician arrived early.",
     "fallback later-word edit: the technician correction lands");
  const first = await shipState(p);
  ok(first.overlayNodes > 0 && first.live.length === 0,
     "fallback later-word edit: overlay nodes and no Highlight registration");
  await p.keyboard.type(" Then we", { delay: 20 });
  ok(await text() === "The technician arrived early. Then we" && (await shipState(p)).overlayNodes > 0,
     "fallback later-word edit: append after the undo sentence preserves the overlay");
  await sinceApply(p, 900);
  await p.evaluate(() => {
    const r = window.__prooferSentence.rangeForInnerTextOffset(document.querySelector("#ce"), 28, 1);
    r.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
  const at = Date.now() - p.appliedAt;
  await p.keyboard.type("X");
  const done = Date.now() - p.appliedAt;
  ok(at > 650 && done < 1600,
     `fallback later-word edit: after verification and before expiry (+${at}..${done}ms)`);
  ok(await text() === "The technician arrived earlyX. Then we",
     "fallback later-word edit: technician remains intact");
  await sleep(60);
  const st = await shipState(p), observed = Date.now() - p.appliedAt;
  ok(observed < 1600, `fallback later-word edit: removal checked before expiry (+${observed}ms)`);
  ok(st.overlayNodes === 0, "fallback later-word edit: clears the overlay before expiry");
  ok(JSON.stringify(await geometry()) === JSON.stringify(initialGeometry),
     "fallback later-word edit: field geometry and field/window scroll remain unchanged");
  await p.keyboard.press("Escape");
  await sleep(100);
  ok(await text() === "The technician arrived earlyX. Then we",
     "fallback later-word edit: Escape leaves edited text unchanged");
  await p.close();
} catch (e) { ok(false, `[F] fallback later-word edit: ${e.message}`); }

// --- ALIASING: a byte-identical copy inserted before the correction --------
//
// The nastiest case the byte-equality guards had. Insert a second copy of the
// corrected sentence in front of the first: `snText.slice(0, end)` is unchanged
// and so is `slice(start, endAfter)`, so BOTH the old flash guard and
// `sentenceUndoAnchored` still report anchored -- while the live Range has
// moved onto the second copy and Escape would splice the first. Green over one
// sentence, Escape editing another.
//
// Inserted atomically rather than typed, because typing it would trip the
// prefix check character by character long before the copy was complete -- and
// the hazard is precisely the state where the text is byte-identical again.
try {
  const p = await localFresh("#ce");
  ok((await shipState(p)).live.length === 1, "aliasing: flash up first");
  const moved = await p.evaluate((fixed) => {
    const el = document.querySelector("#ce");
    const node = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild
      : el.querySelector("*") && [...el.childNodes].find((n) => n.nodeType === 3);
    const t = node || el.firstChild;
    const before = window.__prooferSentence.snText(el);
    t.insertData(0, fixed + " ");
    const after = window.__prooferSentence.snText(el);
    return { before, after, sliceStillEqual: after.slice(0, fixed.length) === before.slice(0, fixed.length) };
  }, FIXED);
  ok(moved.sliceStillEqual,
     `aliasing: the prefix is byte-identical after the insertion, so byte equality cannot see it`);
  await sleep(300);
  const st = await shipState(p);
  ok(st.live.length === 0,
     `and the offset check clears it anyway (${JSON.stringify(st.live)}) -- ${JSON.stringify(moved.after.slice(0, 70))}`);
  await p.close();
} catch (e) { ok(false, `[F] aliasing: ${e.message}`); }

// --- The fade, on a clock we control ---------------------------------------
try {
  // Stop at the terminator. This case times the fade against the flash's OWN
  // birth, and it can only do that if it is watching when the flash is born:
  // polling starts after typing ends, so any keystrokes typed AFTER the trigger
  // point are dead reckoning added to `born`. On a contenteditable the trigger
  // point is now the terminator, so the tail was ~300ms of unmeasured age --
  // enough to read the 1150ms sample as the 1420ms one and call a correct fade
  // wrong. That the flash survives later keystrokes is [2b] and [E]'s question,
  // not this one's.
  const p = await localFresh("#ce", { type: false });
  await typeJittered(p, TYPO);
  let born = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if ((await shipState(p)).live.length) { born = Date.now(); break; }
    await sleep(25);
  }
  ok(born > 0, "fade: the flash appeared");
  const at = async (ms) => {
    const w = born + ms - Date.now();
    if (w > 0) await sleep(w);
    return (await shipState(p)).live[0] || null;
  };
  const s1 = await at(200), s2 = await at(1150), s3 = await at(1420), s4 = await at(1900);
  ok(s1 === "proofer-sn-flash-3", `full strength at +200ms (${s1})`);
  ok(s2 === "proofer-sn-flash-2", `first fade step at +1150ms (${s2})`);
  ok(s3 === "proofer-sn-flash-1", `second fade step at +1420ms (${s3})`);
  ok(s4 === null, `gone at +1900ms (${s4})`);
  await p.close();
} catch (e) { ok(false, `[F] fade steps: ${e.message}`); }

// --- The textarea keeps the overlay ----------------------------------------
try {
  const p = await localFresh("#ta");
  const st = await shipState(p);
  ok(st.live.length === 0 && st.overlayNodes > 0,
     `a textarea still gets the overlay, not a highlight (${JSON.stringify(st)})`);
  const anim = await p.evaluate(() => {
    const m = document.querySelector(".proofer-sentence-flash");
    return m ? getComputedStyle(m).animationDuration : null;
  });
  ok(anim === "1.6s", `and its fade lasts the whole 1600ms (${anim})`);
  await p.close();
} catch (e) { ok(false, `[F] textarea path: ${e.message}`); }

// --- The overlay FALLBACK reads alignment off the BLOCK -------------------
//
// With no Highlight API a contenteditable falls back to measured rects, which
// have the original blind spot: `stableUnderAppend` computed from the HOST
// reads `start` while the paragraph is centred, so appending slides the text
// out from under a box that stays put. That is the slatejs.org case, 48px.
//
// A DIFFERENTIAL, because a single case cannot tell the fix from an accident:
// `#centred` and `#plain` are the same DOM with one style changed, and both
// HOSTS compute `start`. Read the alignment off the host -- the old code -- and
// the two behave identically. Only reading it off the block can separate them.
//
// (Traced, when this case first read as vacuous: the correction's own trailing
// input event reaches `revalidateSentenceFlash` immediately, so the centred
// mark is already gone by the time anything can observe it. That is the
// designed behaviour -- lose the flash rather than show a wrong one -- and it
// is why the assertion is the PAIR rather than a timing.)
//
// Negative control, run once by hand against the pre-fix line
// (`getComputedStyle(el)` instead of `getComputedStyle(sentenceAlignmentEl(...))`):
//   old code:   centred 1 mark, plain 1 mark  -> differential FAILS
//   fixed code: centred 0 marks, plain 1 mark -> differential PASSES
// The old code's centred mark is the bug itself: an overlay still on screen
// over a line that has already slid out from under it.
try {
  const centred = await localFresh("#centred", { noHighlightApi: true, caretInside: true });
  const align = await centred.evaluate(() => ({
    host: getComputedStyle(document.querySelector("#centred")).textAlign,
    block: getComputedStyle(document.querySelector("#centred p")).textAlign,
  }));
  ok(align.host !== "center" && align.block === "center",
     `fallback: the host hides the centring the block declares (${JSON.stringify(align)})`);
  const cText = await centred.evaluate(() => document.querySelector("#centred").textContent);
  ok(cText.startsWith(FIXED), `fallback: the correction applied into the centred block (${JSON.stringify(cText)})`);
  const cMarks = (await shipState(centred)).overlayNodes;
  await centred.close();

  const plain = await localFresh("#plain", { noHighlightApi: true, caretInside: true });
  const pAlign = await plain.evaluate(() =>
    getComputedStyle(document.querySelector("#plain p")).textAlign);
  const pText = await plain.evaluate(() => document.querySelector("#plain").textContent);
  ok(pText.startsWith(FIXED), `fallback: and into the left-aligned control (${JSON.stringify(pText)})`);
  const pMarks = (await shipState(plain)).overlayNodes;
  await plain.close();

  ok(pMarks > 0, `fallback: the left-aligned control keeps its overlay (${pMarks} mark(s), ${pAlign})`);
  ok(cMarks === 0,
     `fallback: the centred block does not (${cMarks} mark(s)) -- read off the HOST both would be ${pMarks}`);
} catch (e) { ok(false, `[F] overlay fallback alignment: ${e.message}`); }

// Chrome can retain speculative connections after its pages close. Stop the
// client before waiting for the HTTP servers to drain those connections.
await browser.close();
await new Promise((r) => localServer.close(r));

// ===========================================================================
// summary
// ===========================================================================
console.log(`\n${"=".repeat(72)}\nSUMMARY\n`);
console.log("  family        source     [A] 1600ms survival        [B] Range under a before-edit");
for (const r of report) {
  const A = r.A || {}, B = r.B || {};
  const a = A.error ? `ERROR ${A.error.slice(0, 24)}`
    : A.allGood ? `held (${A.samples} samples, ${A.paint.birth}/${A.paint.mid}/${A.paint.end} px)`
    : "BROKE";
  const b = B.error ? "ERROR" : (B.tracked ? `tracked +${B.movedPx}px` : `collapsed (${JSON.stringify(B.text)})`);
  console.log(`  ${r.family.padEnd(13)} ${String(r.mode).padEnd(10)} ${a.padEnd(26)} ${b}`);
}
console.log(`\n  ${pass} passed, ${fail} failed`
  + (notRun.length ? `, ${notRun.length} NOT RUN` : ""));
for (const n of notRun) console.log(`    NOT RUN: ${n}`);

const out = { at: new Date().toISOString(), chrome: chrome.path, live: LIVE, source: SOURCE,
              rows: report, rtl, pass, fail, notRun };
const dest = path.join(HERE, "results", "flash-highlight-probe.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(`  written: ${dest}`);
console.log(`  content.js md5 ${SOURCE.content} (mtime ${SOURCE.contentMtime})`);
if (process.env.PROOFER_CONTENT) console.log(`  PROOFER_CONTENT ${SOURCE.contentPath}`);

for (const s of servers.values()) if (s.close) await s.close();
// EVERY section gates. An earlier version let A-D populate a report while only
// E and F could fail, and shipped an artifact recording a failed paint result
// inside a run that printed "0 failed".
process.exit(fail ? 1 : (notRun.length ? 77 : 0));
