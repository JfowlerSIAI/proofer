#!/usr/bin/env node
/**
 * The popup's two recorded-prose views: the outcome breakdown and Recent
 * changes. Puppeteer, no Ollama, no extension side-loading, no network — the
 * real popup.html and popup.js with a stubbed chrome.*.
 * [12a–c] pin export counts, diagnostic-only downloads and the empty state.
 * [13] also pins the frame-scoped label for deferred remembered field status.
 *
 *   cd test && node popup-views-test.mjs
 *
 * The popup had no automated coverage at all, which was defensible while it
 * rendered nothing but its own labels and numbers. `GET_RECENT_SENTENCES`
 * changed that: it is the only path that puts the user's own writing and a
 * language model's output into an extension DOM, and both are untrusted by the
 * project's standing rule. Three properties are worth a gate:
 *
 *   [1] Prose is rendered as TEXT. A single interpolated template would turn a
 *       proofread sentence into markup.
 *   [2] Clearing the log empties the views. Clear is the user's guarantee that
 *       their writing is gone, and it is worth least at exactly the moment they
 *       are exercising it.
 *   [3] A response already in flight cannot paint into a view that has since
 *       been cleared or closed. Emptying the DOM does not cancel a request, so
 *       without a generation the deleted prose comes back -- with a Copy button
 *       on it. The stub DEFERS its replies so this is reproducible; a stub that
 *       answers synchronously serializes the two by accident and can never show
 *       it.
 */
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { chromePath } from "./lib/chrome.mjs";

const EXT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const failures = [];
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}`); }
};

const NASTY = '<img src=x onerror="window.__pwned=1"> & <b>bold</b>';
const SECRET = "SECRET PROSE the user typed";

const browser = await puppeteer.launch({
  headless: true, executablePath: await chromePath(),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
await page.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));

await page.evaluate(({ nasty, secret }) => {
  window.__pwned = 0;
  window.__cleared = false;
  window.__pending = [];            // deferred GET_RECENT_SENTENCES replies
  const settings = { ollamaUrl: "http://localhost:11434", ollamaModel: "m",
    disabledSites: [], recordAll: true, sentenceMode: true, sentenceModeDisabledSites: [],
    sentenceDebug: false };
  // A stats fixture with a REAL partition. The previous one counted the same n
  // records as both silent applies and accepted suggestions, which is fine for
  // "does the breakdown render" and useless the moment anything asserts that
  // the categories add up. `distribution` here sums to `sentence.count` by
  // construction and `other` is the sum of its own named parts, so a bar drawn
  // from it is a proportion of a defined whole. Scaled by n so the cleared case
  // (n = 0) is genuinely empty.
  const mkStats = (n) => ({ ok: true, legacyManual: 0, evictions: null, warmups: 0,
    clearable: { any: n > 0, records: n ? 20 : 0, legacy: 0, telemetry: 0 },
    sentence: { count: n ? 20 : 0, cap: 5000, noChange: n ? 8 : 0, guarded: n ? 4 : 0,
      retrySalvaged: 0,
      topGuard: null, errors: 0, applied: n ? 5 : 0, reverted: n ? 1 : 0, lost: n ? 1 : 0,
      keepRate: n ? 83 : null, medianMs: null,
      // A mixed map: real scan skips AND `field:*` coverage tallies. They ride
      // the same plumbing and must NOT be summed -- field entries are far more
      // numerous, and merged they take over the "mostly <reason>" diagnosis.
      // The rich-editor ratio here is 3 served (Slate 2 + Quill 1) against
      // 3 unserved (unknown 2 + blocked 1) = 3/6, 50%. `field:ok:textarea` and
      // `field:unsupported-editor:single-line-input` are in the map on purpose
      // and belong in NEITHER side.
      skips: n ? {
        "composition": 2, "busy": 1,
        "field:ok:Slate": 2, "field:ok:Quill": 1, "field:ok:textarea": 40,
        "field:unsupported-editor:unknown-editor": 2,
        "field:session-blocked:not-durable": 1,
        "field:unsupported-editor:single-line-input": 137,
      } : {},
      breakdown: { appliedSilently: n ? 4 : 0, appliedUnverified: n ? 1 : 0,
        legacySuggestion: 0, rejected: n ? 1 : 0, lost: n ? 1 : 0, noChange: n ? 8 : 0,
        deliverySkipped: n ? { "anchor:stale-age": 1 } : {} },
      // 8 + 4 + 5 + 1 + 1 + 1 = 20
      distribution: { noChange: n ? 8 : 0, guarded: n ? 4 : 0, applied: n ? 5 : 0,
        rejected: n ? 1 : 0, lost: n ? 1 : 0, other: n ? 1 : 0 },
      otherDetail: { legacySuggestion: 0, deliverySkipped: n ? 1 : 0, errored: 0,
        unresolved: 0, unclassified: 0 } } });
  const rows = [
    { id: "a", ts: Date.now(), origin: "https://example.com",
      input: nasty, output: nasty + ".", outcome: "applied" },
    { id: "b", ts: Date.now() - 1000, origin: "https://discord.com",
      input: secret, output: "Secret prose the user typed.", outcome: "you undid this" },
  ];
  window.chrome = {
    runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => {
      if (msg.type === "GET_SETTINGS") return setTimeout(() => cb({ ok: true, settings, consent: { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true } }), 3);
      if (msg.type === "GET_LOG_STATS")
        return setTimeout(() => cb(mkStats(window.__cleared ? 0 : 2)), 3);
      // Deferred on purpose -- released by the test, so a reply can be made to
      // arrive after a Clear or a Hide. The rows are snapshotted at REQUEST
      // time, not at release time, because that is what the worker does: it
      // answers from the state it saw when it handled the message. A request
      // made before a clear therefore carries the prose whenever it lands,
      // which is the whole hazard; one made after it carries nothing, and
      // forcing stale rows onto that one would be testing the stub.
      if (msg.type === "GET_RECENT_SENTENCES") {
        const snapshot = window.__cleared ? [] : rows.slice();
        return window.__pending.push(() => cb({ ok: true, cap: 20, rows: snapshot }));
      }
      if (msg.type === "CLEAR_LOG") { window.__cleared = true; return setTimeout(() => cb({ ok: true }), 3); }
      setTimeout(() => cb({ ok: true }), 3);
    } },
    storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() },
               onChanged: { addListener() {} } },
    tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/x" }]),
            sendMessage: (i, m, cb) => cb && cb() },
  };
  window.confirm = () => true;
}, { nasty: NASTY, secret: SECRET });

await page.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
await sleep(600);
const release = () =>
  page.evaluate(() => { const p = window.__pending; window.__pending = []; p.forEach((f) => f()); });

console.log("\nPopup recorded-prose views\n" + "=".repeat(72));

console.log("\n[1] The outcome key names what each bucket is MADE of:");
{
  const b = await page.evaluate(() => document.getElementById("sentenceBarKey").innerText);
  ok(/Silently, verified/.test(b) && /Silently, not verified/.test(b),
     "the two kinds of automatic landing are named separately");
  ok(!/suggestion/i.test(b), "and suggestion mode, removed, has no row while it has no records");
  // How full the log is, in the one place a user looks.
  const line = await page.evaluate(() => document.getElementById("logStats").textContent);
  ok(/20 of 5,000 sentences kept/.test(line), `the log says how full it is (${JSON.stringify(line)})`);
  ok(/Dropped on delivery \u2014 anchor:stale-age/.test(b),
     "recorded delivery drops are listed WITH THEIR REASON, not as one number");
}

console.log("\n[1b] The outcome distribution is drawn as a bar that PARTITIONS the records:");
{
  const bar = await page.evaluate(() => {
    const segs = [...document.querySelectorAll("#sentenceBar .bar-seg")];
    // The six BUCKET rows, not the sub-rows -- those are a breakdown of a
    // bucket already counted, and summing both double-counts.
    const rows = [...document.querySelectorAll(
      "#sentenceBarKey .bar-key-row:not(.bar-key-row-sub)")];
    return {
      grows: segs.map((e) => Number(e.style.flexGrow)),
      // Colours are not the assertion -- an icon is. Six colours in a 320px
      // strip is exactly the arrangement that stops working for a colour-blind
      // reader, so the mapping has to survive with colour removed.
      icons: rows.map((e) => e.querySelector(".bar-key-icon").textContent),
      labels: rows.map((e) => e.querySelector(".bar-key-label").textContent),
      counts: rows.map((e) => Number(e.querySelector(".bar-key-count").textContent)),
      zeros: rows.filter((e) => e.classList.contains("bar-key-row-zero")).length,
      html: document.getElementById("sentenceBar").innerHTML,
    };
  });
  // The LITERAL total, not a number the popup also computed. Asserting
  // sum === somethingTheViewReported would pass against a view that partitions
  // its own invention.
  const shown = bar.counts.slice(0, 6).reduce((a, b) => a + b, 0);
  ok(shown === 20, `the six segments account for all 20 records (got ${shown})`);
  // PROPORTIONAL, not merely present. `flexGrow` is the whole layout, so a
  // build that sets every segment to 1 draws six equal blocks over wildly
  // unequal counts -- and "every width is positive" is green on it.
  ok(JSON.stringify(bar.grows) === JSON.stringify([8, 4, 5, 1, 1, 1]),
     `each segment's width is its own count (${JSON.stringify(bar.grows)})`);
  ok(bar.icons.length >= 6 && bar.icons.slice(0, 6).every((i) => i && i.trim()),
     `each key row carries an icon, so colour is not load-bearing (${JSON.stringify(bar.icons.slice(0, 6))})`);
  ok(/Refused by a guard/.test(bar.labels.join("|")) && /Lost to the editor/.test(bar.labels.join("|")),
     "guard refusals and transport losses are named categories, not folded into Other");
  const subs = await page.evaluate(() => [...document.querySelectorAll(
    "#sentenceBarKey .bar-key-row-sub .bar-key-label")].map((e) => e.textContent));
  ok(subs.some((t) => /^Dropped on delivery/.test(t)),
     `and Other is broken out into its named parts rather than left as one number (${JSON.stringify(subs)})`);
  ok(subs.some((t) => /Silently, verified/.test(t)) && subs.some((t) => /Silently, not verified/.test(t)),
     "...and Applied is split into the two kinds only the verdict can tell apart");
  ok(!/</.test(bar.html.replace(/<\/?div[^>]*>/g, "")),
     "the bar is built from elements, not from interpolated markup");
}

console.log("\n[1c] A zero category keeps its key row rather than vanishing:");
{
  // A SECOND popup, booted against a fixture with five empty categories.
  // Deliberately a fresh page rather than a test hook on the production render:
  // an exported-for-tests entry point is a second way into the code that
  // nothing else uses, and it is exactly how a view can pass its suite while
  // the path the user reaches is broken.
  const p2 = await browser.newPage();
  p2.on("pageerror", (e) => pageErrors.push("[1c] " + e.message));
  await p2.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p2.evaluate(() => {
    const settings = { ollamaUrl: "http://localhost:11434", ollamaModel: "m",
      disabledSites: [], recordAll: true, sentenceMode: true, sentenceModeDisabledSites: [],
      sentenceDebug: false };
    const stats = { ok: true, legacyManual: 0, evictions: null, warmups: 4,
      clearable: { any: true, records: 5, legacy: 0, telemetry: 1 },
      sentence: { count: 5, cap: 5000, noChange: 3, guarded: 0, retrySalvaged: 0,
        topGuard: null, errors: 0, applied: 2, reverted: 0, lost: 0,
        keepRate: 100, medianMs: null, skips: {},
        breakdown: { appliedSilently: 2, appliedUnverified: 0, legacySuggestion: 0,
          rejected: 0, lost: 0, noChange: 3, deliverySkipped: {} },
        distribution: { noChange: 3, guarded: 0, applied: 2, rejected: 0, lost: 0, other: 0 },
        otherDetail: { legacySuggestion: 0, deliverySkipped: 0, errored: 0, unresolved: 0,
          unclassified: 0 } } };
    window.chrome = {
      runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => {
        if (msg.type === "GET_SETTINGS") return setTimeout(() => cb({ ok: true, settings, consent: { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true } }), 3);
        if (msg.type === "GET_LOG_STATS") return setTimeout(() => cb(stats), 3);
        if (msg.type === "GET_RECENT_SENTENCES")
          return setTimeout(() => cb({ ok: true, cap: 20, rows: [] }), 3);
        if (msg.type === "CLEAR_LOG") { window.__cleared = true; return setTimeout(() => cb({ ok: true }), 3); }
        setTimeout(() => cb({ ok: true }), 3);
      } },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() },
                 onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/x" }]),
              sendMessage: (i, m, cb) => cb && cb() },
    };
    window.__cleared = false;
    window.confirm = () => true;
  });
  await p2.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await sleep(600);
  const r = await p2.evaluate(() => {
    const rows = [...document.querySelectorAll(
      "#sentenceBarKey .bar-key-row:not(.bar-key-row-sub)")];
    return {
      rows: rows.length,
      zero: rows.filter((e) => e.classList.contains("bar-key-row-zero")).length,
      segs: document.querySelectorAll("#sentenceBar .bar-seg").length,
      counts: rows.map((e) => Number(e.querySelector(".bar-key-count").textContent)),
      subs: [...document.querySelectorAll("#sentenceBarKey .bar-key-row-sub")]
        .map((e) => e.querySelector(".bar-key-label").textContent + "=" +
                    e.querySelector(".bar-key-count").textContent),
    };
  });
  ok(r.rows === 6, `all six key rows are present (${r.rows})`);
  ok(r.zero === 4, `the empty ones are marked zero rather than dropped (${r.zero})`);
  ok(r.segs === 2, `and only the non-empty ones take width in the bar (${r.segs})`);
  ok(r.counts.reduce((a, b) => a + b, 0) === 5,
     `the key still accounts for every record (${JSON.stringify(r.counts)})`);
  // The accepted-suggestion row that used to survive at zero went with
  // suggestion mode (2026-09-24); nothing else is required to.
  ok(!r.subs.some((t) => /suggestion/i.test(t)),
     `no suggestion row survives at zero (${JSON.stringify(r.subs)})`);
  await p2.close();
}

console.log("\n[1d] Coverage counting: partitioned, and the ratio's denominator:");
// --- coverage counting: partition, and the ratio's denominator -------------
const cov = await page.evaluate(() => {
  const el = document.getElementById("sentenceStats");
  return el ? el.textContent : "";
});
ok(/3 skipped or refused/.test(cov),
   `[cov] field:* is EXCLUDED from the skip total (line: ${cov})`);
ok(!/mostly field:/.test(cov),
   "[cov] ...so the 'mostly' diagnosis is a scan reason, not a field tally");
ok(/rich editors served: 3\/6 \(50%\)/.test(cov),
   `[cov] the ratio counts blocked and oversized rich fields as UNSERVED (line: ${cov})`);
ok(!/textarea|single-line/.test(cov),
   "[cov] ...and neither textareas nor search boxes reach either side");

console.log("\n[1d] A log holding ONLY text-free warmup telemetry is still clearable:");
{
  // Its own page because the condition is that EVERY interaction count is zero.
  // clearLog sweeps the warmup prefix, but the popup decides whether there is
  // anything to clear from the counts it is handed -- so telemetry-only storage
  // read as "Nothing to clear." and stayed on disk, which is the skip-counter
  // defect one store along.
  const p4 = await browser.newPage();
  p4.on("pageerror", (e) => pageErrors.push("[1d] " + e.message));
  await p4.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p4.evaluate(() => {
    const settings = { ollamaUrl: "http://localhost:11434", ollamaModel: "m",
      disabledSites: [], recordAll: true, sentenceMode: true, sentenceModeDisabledSites: [],
      sentenceDebug: false };
    window.__cleared = false;
    // The worker's own answer (clearableData): text-free telemetry is still
    // something Clear removes, even with every count at zero.
    const stats = { ok: true, legacyManual: 0, evictions: null, warmups: 4,
      clearable: { any: true, records: 0, legacy: 0, telemetry: 1 },
      sentence: { count: 0, cap: 5000, noChange: 0, guarded: 0, retrySalvaged: 0,
        topGuard: null, errors: 0, applied: 0, reverted: 0, lost: 0, keepRate: null,
        medianMs: null, skips: {}, breakdown: null, distribution: null, otherDetail: {} } };
    window.chrome = {
      runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => {
        if (msg.type === "GET_SETTINGS") return setTimeout(() => cb({ ok: true, settings, consent: { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true } }), 3);
        if (msg.type === "GET_LOG_STATS") return setTimeout(() => cb(stats), 3);
        if (msg.type === "CLEAR_LOG") { window.__cleared = true; return setTimeout(() => cb({ ok: true }), 3); }
        setTimeout(() => cb({ ok: true }), 3);
      } },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() },
                 onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/x" }]),
              sendMessage: (i, m, cb) => cb && cb() },
    };
    window.confirm = () => true;
  });
  await p4.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await sleep(400);
  await p4.click("#clearLogBtn");
  await sleep(300);
  const r = await p4.evaluate(() => ({
    cleared: window.__cleared,
    status: document.getElementById("status") && document.getElementById("status").textContent,
  }));
  ok(r.cleared === true,
     `CLEAR_LOG is sent rather than "Nothing to clear." (status ${JSON.stringify(r.status)})`);
  await p4.close();
}

console.log("\n[1e] With NOTHING stored, Clear still tells the worker:");
{
  // A sentence in flight when Clear is pressed writes its record when its
  // response lands; only CLEAR_LOG advances the generation that drops it. The
  // popup used to answer "Nothing to clear." itself and send nothing, so that
  // record was written after the user cleared (checkpoint 1, 2026-09-25). The
  // worker half -- CLEAR_LOG drops a pending request's record -- is
  // sentence-settings-test.mjs; this is the half that decides to send it.
  const p5 = await browser.newPage();
  p5.on("pageerror", (e) => pageErrors.push("[1e] " + e.message));
  await p5.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p5.evaluate(() => {
    const settings = { ollamaUrl: "http://localhost:11434", disabledSites: [], recordAll: true,
      sentenceMode: true, sentenceModeDisabledSites: [], sentenceDebug: false };
    window.__cleared = false;
    window.__asked = false;
    const stats = { ok: true, legacyManual: 0, evictions: null, warmups: 0,
      clearable: { any: false, records: 0, legacy: 0, telemetry: 0 },
      sentence: { count: 0, cap: 5000, noChange: 0, guarded: 0, retrySalvaged: 0,
        topGuard: null, errors: 0, applied: 0, reverted: 0, lost: 0, keepRate: null,
        medianMs: null, skips: {}, breakdown: null, distribution: null, otherDetail: {} } };
    window.chrome = {
      runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => {
        if (msg.type === "GET_SETTINGS") return setTimeout(() => cb({ ok: true, settings, consent: { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true } }), 3);
        if (msg.type === "GET_LOG_STATS") return setTimeout(() => cb(stats), 3);
        if (msg.type === "CLEAR_LOG") { window.__cleared = true; return setTimeout(() => cb({ ok: true }), 3); }
        setTimeout(() => cb({ ok: true }), 3);
      } },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() },
                 onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/x" }]),
              sendMessage: (i, m, cb) => cb && cb() },
    };
    window.confirm = () => { window.__asked = true; return false; };
  });
  await p5.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await sleep(400);
  await p5.click("#clearLogBtn");
  await sleep(300);
  const r = await p5.evaluate(() => ({ cleared: window.__cleared, asked: window.__asked,
    status: document.getElementById("status") && document.getElementById("status").textContent }));
  ok(r.cleared === true, "[1e] CLEAR_LOG is sent even when nothing is stored");
  ok(r.asked === false, "[1e] ...without asking to delete entries that do not exist");
  ok(/Nothing to clear/.test(r.status || ""), `[1e] ...and it still says so (status ${JSON.stringify(r.status)})`);
  await p5.close();
}

console.log("\n[2] Recorded prose is rendered as text, never as markup:");
{
  await page.click("#recentBtn");
  await sleep(80); await release(); await sleep(300);
  const r = await page.evaluate(() => ({
    pwned: window.__pwned,
    imgs: document.querySelectorAll("#recentChanges img").length,
    bolds: document.querySelectorAll("#recentChanges b").length,
    text: document.getElementById("recentChanges").innerText,
  }));
  ok(r.pwned === 0, "an onerror handler in recorded prose does not run");
  ok(r.imgs === 0 && r.bolds === 0, `no element is created from it (img ${r.imgs}, b ${r.bolds})`);
  ok(r.text.includes("<img src=x"), "it is displayed as the characters the user typed");
  ok(r.text.includes("you undid this"),
     "an undone correction is listed -- it is the one most worth explaining");
}

console.log("\n[3] A reply in flight cannot paint into a view that was closed:");
{
  await page.click("#recentBtn");            // hide (currently open)
  await sleep(60);
  await page.click("#recentBtn");            // show -> starts a load
  await sleep(60);
  await page.click("#recentBtn");            // hide again, load still pending
  await sleep(60);
  await release();                            // the pre-hide reply arrives now
  await sleep(300);
  const html = await page.evaluate(() =>
    document.getElementById("recentChanges").innerHTML.length);
  ok(html === 0, `the hidden view stays empty (${html} chars of HTML)`);
}

console.log("\n[4] Clearing the log empties both views, and a stale reply cannot refill them:");
{
  await page.click("#recentBtn");            // show
  await sleep(60); await release(); await sleep(200);
  ok((await page.evaluate(() => document.getElementById("recentChanges").innerText)).includes(SECRET),
     "there is something to clear");
  await page.click("#recentBtn");            // hide, so the next show starts a fresh load
  await sleep(60);
  await page.click("#recentBtn");            // show -> a load is now pending
  await sleep(60);
  await page.click("#clearLogBtn");
  await sleep(300);
  await release();                            // the PRE-clear reply, still carrying the prose
  await sleep(400);
  const after = await page.evaluate(() => ({
    recent: document.getElementById("recentChanges").innerText,
    copies: document.querySelectorAll("#recentChanges .recent-copy").length,
    breakdown: document.getElementById("sentenceBarKey").innerText,
    barSegs: document.querySelectorAll("#sentenceBar .bar-seg").length,
    barKey: document.querySelectorAll("#sentenceBarKey .bar-key-row").length,
  }));
  ok(!after.recent.includes(SECRET),
     "deleted prose does not come back when the pre-clear reply lands");
  ok(after.copies === 0, "and there is no Copy button offering it");
  ok(!/Silently, verified/.test(after.breakdown),
     `the outcome key is cleared too, not left behind by the empty-stats early return (${JSON.stringify(after.breakdown)})`);
  ok(after.barSegs === 0 && after.barKey === 0,
     `and the bar and its key go with it (${after.barSegs} segments, ${after.barKey} key rows)`);
}

console.log("\n[5] A stats reply from before a Clear cannot repaint the counts:");
{
  // The receipts view has had a generation since it shipped; refreshLogStats
  // did not, and it is the one that renders COUNTS for records a Clear has just
  // deleted. Reproducing it needs GET_LOG_STATS deferred -- the stub above
  // answers it on a timer, which serialises the two loads by accident and can
  // never show the bug. Own page, own stub, so the ordering is exact.
  const p3 = await browser.newPage();
  p3.on("pageerror", (e) => pageErrors.push("[5] " + e.message));
  await p3.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p3.evaluate(() => {
    const settings = { ollamaUrl: "http://localhost:11434", ollamaModel: "m",
      disabledSites: [], recordAll: true, sentenceMode: true, sentenceModeDisabledSites: [],
      sentenceDebug: false };
    window.__cleared = false;
    window.__stats = [];                       // deferred GET_LOG_STATS replies
    const mk = (cleared) => ({ ok: true, legacyManual: 0, evictions: null, warmups: 0,
      clearable: { any: !cleared, records: cleared ? 0 : 7, legacy: 0, telemetry: 0 },
      sentence: { count: cleared ? 0 : 7, cap: 5000, noChange: 0, guarded: 0,
        retrySalvaged: 0, topGuard: null, errors: 0, applied: 0, reverted: 0, lost: 0,
        keepRate: null, medianMs: null, skips: {},
        breakdown: { appliedSilently: 0, appliedUnverified: 0, legacySuggestion: 0,
          rejected: 0, lost: 0, noChange: 0, deliverySkipped: {} },
        distribution: { noChange: cleared ? 0 : 7, guarded: 0, applied: 0,
          rejected: 0, lost: 0, other: 0 },
        otherDetail: {} } });
    window.chrome = {
      runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => {
        if (msg.type === "GET_SETTINGS") return setTimeout(() => cb({ ok: true, settings, consent: { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true } }), 3);
        // Snapshotted at REQUEST time, the way the worker answers.
        if (msg.type === "GET_LOG_STATS") {
          const snap = mk(window.__cleared);
          return window.__stats.push(() => cb(snap));
        }
        if (msg.type === "CLEAR_LOG") { window.__cleared = true; return setTimeout(() => cb({ ok: true }), 3); }
        if (msg.type === "GET_RECENT_SENTENCES") return setTimeout(() => cb({ ok: true, cap: 20, rows: [] }), 3);
        setTimeout(() => cb({ ok: true }), 3);
      } },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() },
                 onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/x" }]),
              sendMessage: (i, m, cb) => cb && cb() },
    };
    window.confirm = () => true;
  });
  await p3.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await sleep(300);
  // [0] is the popup's own opening load, still in flight and carrying 7 records.
  const releaseOne = (i) => p3.evaluate((k) => {
    const f = window.__stats[k]; window.__stats[k] = () => {}; if (f) f();
  }, i);
  await p3.click("#clearLogBtn");            // -> [1] the handler's own read
  await sleep(120);
  await releaseOne(1);                        // it sees 7, confirms, clears
  await sleep(200);                           // -> [2] the post-clear refresh
  await releaseOne(2);
  await sleep(200);
  const cleared = await p3.evaluate(() =>
    document.querySelectorAll("#sentenceBar .bar-seg").length);
  ok(cleared === 0, `the view is empty after the clear (${cleared} segments)`);
  await releaseOne(0);                        // the PRE-clear reply, still carrying 7
  await sleep(300);
  const after = await p3.evaluate(() => ({
    segs: document.querySelectorAll("#sentenceBar .bar-seg").length,
    text: document.getElementById("sentenceStats").textContent,
  }));
  ok(after.segs === 0,
     `a reply from before the clear does not repaint the bar (${after.segs} segments)`);
  ok(!/7 sentences/.test(after.text),
     `nor the counts beside it (${JSON.stringify(after.text)})`);
  await p3.close();
}

console.log("\n[6] Legacy-only storage is clearable, and an early eviction is said out loud:");
{
  // Records from the removed manual path only: the product's own counts are
  // all zero, so a popup deciding from counts said "Nothing to clear." and
  // left the text on disk. The worker's `clearable` is what decides now.
  const p6 = await browser.newPage();
  p6.on("pageerror", (e) => pageErrors.push("[6] " + e.message));
  await p6.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p6.evaluate(() => {
    const settings = { ollamaUrl: "http://localhost:11434", ollamaModel: "m",
      disabledSites: [], recordAll: true, sentenceMode: true, sentenceModeDisabledSites: [],
      sentenceDebug: false };
    window.__cleared = false;
    window.__confirms = [];
    const stats = { ok: true, legacyManual: 3, warmups: 0,
      evictions: { count: 500, lastAt: 1 },
      writeFailures: { count: 2, lastAt: 1 },
      clearable: { any: true, records: 3, legacy: 3, telemetry: 0 },
      sentence: { count: 0, cap: 5000, noChange: 0, guarded: 0, retrySalvaged: 0,
        topGuard: null, errors: 0, applied: 0, reverted: 0, lost: 0, keepRate: null,
        medianMs: null, skips: {}, breakdown: null, distribution: null, otherDetail: {} } };
    window.chrome = {
      runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => {
        if (msg.type === "GET_SETTINGS") return setTimeout(() => cb({ ok: true, settings, consent: { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true } }), 3);
        if (msg.type === "GET_LOG_STATS") return setTimeout(() => cb(stats), 3);
        if (msg.type === "CLEAR_LOG") { window.__cleared = true; return setTimeout(() => cb({ ok: true }), 3); }
        setTimeout(() => cb({ ok: true }), 3);
      } },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() },
                 onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/x" }]),
              sendMessage: (i, m, cb) => cb && cb() },
    };
    window.confirm = (m) => { window.__confirms.push(m); return true; };
  });
  await p6.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await sleep(400);
  const before = await p6.evaluate(() => ({
    line: document.getElementById("logStats").textContent,
    evicted: document.getElementById("logEvicted").style.display !== "none"
      ? document.getElementById("logEvicted").textContent : null,
  }));
  ok(/3 from the old rewrite panel/.test(before.line),
     `old-panel records are named, not hidden (${JSON.stringify(before.line)})`);
  ok(/older entries were dropped/.test(before.evicted || "") && /export/i.test(before.evicted || ""),
     `an early eviction is said, with what to do (${JSON.stringify(before.evicted)})`);
  ok(/could not be recorded/.test(before.evicted || ""),
     `...and so is a write that failed outright (${JSON.stringify(before.evicted)})`);
  await p6.click("#clearLogBtn");
  await sleep(300);
  const r = await p6.evaluate(() => ({ cleared: window.__cleared, confirms: window.__confirms }));
  ok(r.cleared === true, "legacy-only storage is cleared rather than reported empty");
  ok(r.confirms.length === 1 && /3 recorded entries/.test(r.confirms[0])
     && /exported are not affected/.test(r.confirms[0]),
     `the confirmation names what goes and what does not (${JSON.stringify(r.confirms)})`);
  await p6.close();
}

console.log("\n[12] Export shows the notice first, and the file names it:");
{
  // Beta plan section 11: the first export shows what the file holds and what
  // sending it would mean; declining saves nothing; the file's last row names
  // the notice seen, so a contribution carries its own consent provenance.
  const p12 = await browser.newPage();
  p12.on("pageerror", (e) => pageErrors.push("[12] " + e.message));
  await p12.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p12.evaluate(() => {
    const settings = { ollamaUrl: "http://localhost:11434", disabledSites: [], recordAll: true,
      sentenceMode: true, sentenceModeDisabledSites: [], sentenceDebug: false, qualified: true };
    const stats = { ok: true, legacyManual: 0, evictions: null, warmups: 0,
      clearable: { any: true, records: 1, legacy: 0, telemetry: 0 },
      sentence: { count: 1, cap: 5000, noChange: 0, guarded: 0, retrySalvaged: 0,
        topGuard: null, errors: 0, applied: 1, reverted: 0, lost: 0, keepRate: null,
        medianMs: null, skips: {}, breakdown: null, distribution: null, otherDetail: {} } };
    window.__store = {};
    window.__confirms = [];
    window.__answer = false;
    window.__blobs = [];
    window.__exportReply = { ok: true,
      records: [{ v: 1, id: "sn_1", path: "sentence", input: "x" }],
      counts: { records: 1, warmups: 0, skips: 0 } };
    window.__deferExport = false;
    window.__releaseExport = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => { window.__blobs.push(b); return realCreate(b); };
    window.confirm = (m) => { window.__confirms.push(m); return window.__answer; };
    window.chrome = {
      runtime: { id: "t", lastError: undefined, getURL: (x) => x, sendMessage: (msg, cb) => {
        if (msg.type === "GET_SETTINGS") return setTimeout(() => cb({ ok: true, settings, consent: { activated: true, siteDisabled: false, allowed: true, reason: null, apply: true } }), 3);
        if (msg.type === "GET_LOG_STATS") return setTimeout(() => cb(stats), 3);
        if (msg.type === "EXPORT_LOG") {
          const reply = structuredClone(window.__exportReply);
          if (window.__deferExport) { window.__releaseExport = () => cb(reply); return; }
          return setTimeout(() => cb(reply), 3);
        }
        setTimeout(() => cb({ ok: true }), 3);
      } },
      storage: { local: { get: (d, cb) => cb({ ...d, ...window.__store }), set: (o, cb) => { Object.assign(window.__store, o); cb && cb(); } },
                 onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/x" }]), sendMessage: (i, m, cb) => cb && cb() },
    };
  });
  await p12.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await sleep(300);
  await p12.evaluate(() => document.getElementById("exportLogBtn").click());
  await sleep(150);
  ok(await p12.evaluate(() => window.__confirms.length + window.__blobs.length) === 0, "[12] a synthetic Export does nothing");
  await p12.click("#exportLogBtn");
  await sleep(200);
  const first = await p12.evaluate(() => ({ confirms: window.__confirms, blobs: window.__blobs.length, status: document.getElementById("status").textContent }));
  ok(first.confirms.length === 1 && /sends nothing/.test(first.confirms[0]) && /request deletion/.test(first.confirms[0])
    && /other people/.test(first.confirms[0]) && /does not authorize model training/.test(first.confirms[0])
    && /tryproofer@gmail\.com/.test(first.confirms[0]), "[12] the first Export shows the notice");
  ok(first.blobs === 0 && /Nothing was saved/.test(first.status), `[12] ...and declining saves nothing (${JSON.stringify(first.status)})`);
  await p12.evaluate(() => { window.__answer = true; });
  await p12.click("#exportLogBtn");
  await sleep(200);
  const second = await p12.evaluate(async () => ({ confirms: window.__confirms.length, blobs: window.__blobs.length,
    text: window.__blobs.length ? await window.__blobs[0].text() : "" }));
  const last = second.text.trim().split("\n").pop();
  ok(second.confirms === 2 && second.blobs === 1, "[12] accepting it saves the file");
  ok(/"path":"notice"/.test(last) && /"notice":"2026-10-21"/.test(last), `[12] ...whose last row names the notice seen (${last})`);
  await p12.click("#exportLogBtn");
  await sleep(200);
  ok(await p12.evaluate(() => window.__confirms.length) === 2, "[12] the next Export does not ask again");

  await p12.evaluate(() => { window.__store.exportNoticeSeen = "2026-10-02"; });
  await p12.click("#exportLogBtn");
  await sleep(200);
  ok(await p12.evaluate(() => window.__confirms.length) === 3, "[12] an older notice version is shown the updated support-only notice");

  // Each export snapshots rows AND counts at request time. The unrelated
  // GET_LOG_STATS fixture still claims one interaction throughout these cases.
  const exportReply = async (reply) => {
    await p12.evaluate((r) => {
      window.__exportReply = r;
      window.__deferExport = true;
      window.__releaseExport = null;
      window.__store = {};
      window.__confirms = [];
      window.__blobs = [];
    }, reply);
    await p12.click("#exportLogBtn");
    await p12.waitForFunction(() => typeof window.__releaseExport === "function");
    const pending = await p12.evaluate(() => window.__confirms.length + window.__blobs.length);
    await p12.evaluate(() => {
      window.__exportReply.records.push({ id: "late", input: "Must not reach this download." });
      window.__exportReply.counts.records = 99;
      window.__releaseExport();
    });
    await p12.waitForFunction(() => document.getElementById("status").textContent !== "");
    return p12.evaluate(async (pending) => ({ pending,
      status: document.getElementById("status").textContent,
      confirms: window.__confirms.length, blobs: window.__blobs.length,
      rows: window.__blobs.length ? (await window.__blobs[0].text()).trim().split("\n").map(JSON.parse) : [],
    }), pending);
  };
  const checkDownload = (id, result, rows) => {
    ok(result.pending === 0, `${id} pending export neither confirms nor saves`);
    ok(result.confirms === 1 && result.blobs === 1, `${id} download retains the notice flow`);
    ok(JSON.stringify(result.rows.slice(0, -1)) === JSON.stringify(rows), `${id} downloaded rows preserve the request snapshot`);
    const notice = result.rows.at(-1);
    ok(notice?.v === 1 && notice?.path === "notice" && notice?.notice === "2026-10-21"
      && typeof notice?.exportedAt === "number", `${id} download ends with the notice row`);
  };

  // [12a] Mutant: interpolate r.records.length - r.records.filter((r) => r.path === "skips").length
  // instead of records in the completion message; the literal mixed count goes red.
  console.log("\n[12a] Mixed export reports worker counts:");
  const mixedRows = [
    { v: 1, id: "rw_1", ts: 1, input: "Legacy manual text." },
    { v: 1, id: "sn_1", path: "sentence", ts: 2, input: "First sentence." },
    { v: 1, id: "w_1", path: "warmup", ts: 3 },
    { v: 2, id: "sn_2", path: "sentence", ts: 4, input: "Second sentence." },
    { v: 1, id: "w_2", path: "warmup", ts: 5 },
    { v: 1, path: "skips", ts: 6, skips: { busy: 7, "not-sentence": 2 } },
  ];
  const mixed = await exportReply({ ok: true, records: mixedRows, counts: { records: 3, warmups: 2, skips: 1 } });
  ok(mixed.status === "Exported 3 interaction records + 3 diagnostic rows.", "[12a] mixed count names interactions and diagnostics separately");
  checkDownload("[12a]", mixed, mixedRows);

  // [12b] Mutant: setStatus(r.records.length ? ...) selects the interaction
  // message for diagnostics; both exact diagnostic-only messages go red.
  console.log("\n[12b] Diagnostic-only export is identified as such:");
  for (const [kind, rows, counts] of [
    ["warmup-only", [mixedRows[2]], { records: 0, warmups: 1, skips: 0 }],
    ["skip-only", [mixedRows[5]], { records: 0, warmups: 0, skips: 1 }],
  ]) {
    const result = await exportReply({ ok: true, records: rows, counts });
    ok(result.status === "No interaction records. Exported diagnostics only.", `[12b] ${kind} names diagnostics only`);
    checkDownload(`[12b] ${kind}`, result, rows);
  }

  // [12c] Mutant: delete the all-zero early return; empty message and
  // no-confirmation/no-Blob assertions go red.
  console.log("\n[12c] Empty export saves nothing:");
  const empty = await exportReply({ ok: true, records: [], counts: { records: 0, warmups: 0, skips: 0 } });
  ok(empty.status === "Nothing recorded yet.", "[12c] empty export says nothing recorded");
  ok(empty.pending === 0 && empty.confirms === 0 && empty.blobs === 0, "[12c] empty export has no confirmation or Blob");
  await p12.close();
}

// --- [13] Remembered status names its frame scope -------------------------
// SD-16 mutant: restore "(last field you used)" in refreshSentenceWhere;
// the exact frame-scoped suffix and absence-of-latest-claim assertions go red.
console.log("\n[13] Remembered status names its frame scope");
{
  const p13 = await browser.newPage();
  p13.on("pageerror", (e) => pageErrors.push(e.message));
  await p13.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p13.evaluate(() => {
    const settings = { sentenceMode: true, disabledSites: [], sentenceModeDisabledSites: [], recordAll: false };
    window.__history = { status: "active", detail: null, family: "Slate", at: 1000, agoMs: 300000 };
    window.__pendingStatus = null;
    window.chrome = {
      runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => cb(msg.type === "GET_SETTINGS"
        ? { ok: true, settings, consent: { activated: true, allowed: true, siteDisabled: false, reason: null, apply: true } }
        : { ok: true }) },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() }, onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/" }]), sendMessage: (id, msg, cb) => {
        const snapshot = structuredClone({ ok: true, status: "no-field", apply: true,
          frame: "editor.example", top: false, last: window.__history });
        window.__pendingStatus = () => cb(snapshot);
      } },
    };
  });
  await p13.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await p13.waitForFunction(() => window.__pendingStatus !== null);
  await p13.evaluate(() => { window.__history.family = "textarea"; window.__pendingStatus(); });
  const text = await p13.$eval("#sentenceWhere", (el) => el.textContent);
  ok(text.startsWith("Running in the field you focused (Slate)."), "[13] deferred status uses the snapshotted older field");
  ok(text.endsWith("(previously focused field in this frame)"), "[13] remembered suffix names its frame scope");
  ok(!text.includes("last field you used"), "[13] remembered status makes no page-wide latest-field claim");
  await p13.close();
}

// [16] Mutant: omit undoReconciled from subRowsFor; the discarded-undo
// detail and bucket assertions turn red. Literal counts pin subcounts only.
{
  const p16 = await browser.newPage();
  p16.on("pageerror", (e) => pageErrors.push(e.message));
  await p16.setViewport({ width: 420, height: 1000 });
  await p16.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
  await p16.evaluate(() => {
    const settings = { sentenceMode: true, recordAll: true, disabledSites: [], sentenceModeDisabledSites: [] };
    const labels = ["applied", "applied (not verified)", "you undid this",
      "you pressed Escape; the page discarded the undo", "you pressed Escape; the undo was not verified",
      "the page discarded it"];
    window.chrome = {
      runtime: { id: "t", lastError: undefined, sendMessage: (m, cb) => {
        if (m.type === "GET_SETTINGS") return cb({ ok: true, settings,
          consent: { activated: true, allowed: true, siteDisabled: false, reason: null, apply: true } });
        if (m.type === "GET_LOG_STATS") return cb({ ok: true, clearable: { any: true }, sentence: {
          count: 6, cap: 5000, applied: 2, reverted: 3, lost: 1, keepRate: 40,
          breakdown: { appliedSilently: 1, appliedUnverified: 1, rejected: 3, undoReconciled: 1, undoUnverified: 1, lost: 1 },
          distribution: { noChange: 0, guarded: 0, applied: 2, rejected: 3, lost: 1, other: 0 }, otherDetail: {},
        } });
        if (m.type === "GET_RECENT_SENTENCES") return cb({ ok: true, cap: 20,
          rows: labels.map((outcome, i) => ({ id: `undo-${i}`, ts: Date.now() - i * 1000,
            input: "The techncian arrived early.", output: "The technician arrived early.", outcome })) });
        cb({ ok: true });
      } },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() }, onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/" }]), sendMessage: (id, m, cb) => cb({
        ok: true, status: "session-blocked", detail: "reconciled", family: "textarea", apply: true,
      }) },
    };
  });
  await p16.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await p16.waitForFunction(() => document.querySelectorAll("#sentenceBarKey .bar-key-row").length > 0);
  const key = await p16.$eval("#sentenceBarKey", (el) => el.innerText);
  ok(key.includes("Escape: the page discarded the undo"), "[16] rejection details name the discarded undo");
  ok(key.includes("Escape: the undo was not verified"), "[16] rejection details name the unverified undo");
  const rejectionDetails = await p16.$$eval("#sentenceBarKey .bar-key-row", (els) => {
    let bucket = "";
    return els.flatMap((el) => {
      const label = el.querySelector(".bar-key-label").textContent;
      if (!el.classList.contains("bar-key-row-sub")) { bucket = label; return []; }
      return bucket === "You rejected or undid it" ? [[label, Number(el.querySelector(".bar-key-count").textContent)]] : [];
    });
  });
  ok(JSON.stringify(rejectionDetails) === JSON.stringify([
    ["Escape: the page discarded the undo", 1], ["Escape: the undo was not verified", 1],
  ]), "[16] both undo details belong to the rejection bucket");
  const counts = await p16.$$eval("#sentenceBarKey .bar-key-row:not(.bar-key-row-sub) .bar-key-count", (els) => els.map((el) => Number(el.textContent)));
  ok(JSON.stringify(counts) === JSON.stringify([0, 0, 2, 3, 1, 0]), "[16] details do not double-count the six-record partition");
  ok((await p16.$eval("#sentenceStats", (el) => el.textContent)).includes("40% kept without rejection of 5 applied corrections"),
    "[16] keep rate explicitly means kept without rejection");
  ok((await p16.$eval("#sentenceWhere", (el) => el.textContent)).includes("a write was made and the page replaced it"),
    "[16] reconciliation block copy applies to either write");
  await p16.click("#recentBtn");
  await p16.waitForFunction(() => document.querySelectorAll(".recent-row").length === 6);
  const receipts = await p16.$$eval(".recent-row", (els) => els.map((el) => el.textContent));
  ok(receipts[3].includes("you pressed Escape; the page discarded the undo") && !receipts[3].includes("you undid this"),
    "[16] failed-undo receipt claims rejection, not successful undo");
  ok(receipts[4].includes("you pressed Escape; the undo was not verified") && !receipts[4].includes("the page discarded it"),
    "[16] unverified-undo receipt does not claim correction loss");
  ok(receipts[1].includes("applied (not verified)") && receipts[5].includes("the page discarded it"),
    "[16] legacy readings remain unchanged");
  await p16.close();
}

// [14] Mutant: omit writtenMisplaced from subRowsFor; the exact other-bucket
// detail assertion turns red while its receipt remains independently visible.
{
  console.log("\n[14] Post-write diagnoses and receipts describe the observed mutation:");
  const openPostWrite = async (cause) => {
    const p14 = await browser.newPage();
    p14.on("pageerror", (e) => pageErrors.push("[14] " + e.message));
    await p14.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
    await p14.evaluate((cause) => {
      window.__cause = cause;
      const settings = { sentenceMode: true, sentenceModeDisabledSites: [], disabledSites: [], recordAll: true, ollamaUrl: "http://localhost:11434" };
      window.chrome = {
        runtime: { lastError: undefined, sendMessage(m, cb) {
          if (m.type === "GET_SETTINGS") return cb({ ok: true, settings,
            consent: { activated: true, allowed: true, siteDisabled: false, reason: null, apply: true } });
          if (m.type === "GET_LOG_STATS") return cb({ ok: true, clearable: { any: true }, sentence: {
            count: 2, cap: 5000, applied: 1, reverted: 0, lost: 0, keepRate: 100,
            breakdown: { writtenNormalized: 1, writtenMisplaced: 1, deliverySkipped: {} },
            distribution: { noChange: 0, guarded: 0, applied: 1, rejected: 0, lost: 0, other: 1 },
            otherDetail: { writtenMisplaced: 1 },
          } });
          if (m.type === "GET_RECENT_SENTENCES") return cb({ ok: true, cap: 20, rows: [
            { id: "normalized", input: "The techncian arrived early.", output: "The technician arrived early.",
              outcome: "replacement reached its target; the editor changed surrounding text" },
            { id: "misplaced", input: "The techncian arrived early.", output: "The technician arrived early.",
              outcome: "write changed the field without honoring its target; proposed replacement shown" },
          ] });
          cb({ ok: true });
        } },
        storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() },
          onChanged: { addListener() {} } },
        tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/" }]), sendMessage: (id, m, cb) => cb({
          ok: true, status: "session-blocked", detail: window.__cause, family: "Slate", apply: true,
        }) },
      };
    }, cause);
    await p14.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
    await p14.waitForFunction(() => document.querySelectorAll("#sentenceBarKey .bar-key-row").length > 0);
    return p14;
  };
  const p14 = await openPostWrite("write-normalized");
  const details = await p14.$$eval("#sentenceBarKey .bar-key-row", (els) => {
    let bucket = "";
    return els.flatMap((el) => {
      const label = el.querySelector(".bar-key-label").textContent;
      if (!el.classList.contains("bar-key-row-sub")) { bucket = label; return []; }
      return [[bucket, label, Number(el.querySelector(".bar-key-count").textContent)]];
    });
  });
  ok(JSON.stringify(details) === JSON.stringify([
    ["Applied", "Replacement reached its target; surrounding text changed", 1],
    ["Other", "Write changed the field without honoring its target", 1],
  ]), "[14] normalized and misplaced details belong to applied and other respectively");
  const counts = await p14.$$eval("#sentenceBarKey .bar-key-row:not(.bar-key-row-sub) .bar-key-count", (els) => els.map((el) => Number(el.textContent)));
  ok(JSON.stringify(counts) === JSON.stringify([0, 0, 1, 0, 0, 1]), "[14] post-write details preserve the two-record partition");
  ok((await p14.$eval("#sentenceWhere", (el) => el.textContent)).includes("this editor (Slate) changed surrounding text during the write"),
    "[14] normalized block explains the surrounding-text change");
  const misplaced = await openPostWrite("wrote-elsewhere");
  ok((await misplaced.$eval("#sentenceWhere", (el) => el.textContent)).includes("this editor (Slate) put a Proofer write somewhere other than the sentence it was asked to replace"),
    "[14] misplacement block describes either an apply or an undo");
  await misplaced.close();
  await p14.click("#recentBtn");
  await p14.waitForFunction(() => document.querySelectorAll(".recent-row").length === 2);
  const receipts = await p14.$$eval(".recent-row", (els) => els.map((el) => el.textContent));
  ok(receipts[0].includes("replacement reached its target; the editor changed surrounding text"),
    "[14] normalized receipt states the honored span and changed surroundings");
  ok(receipts[1].includes("write changed the field without honoring its target; proposed replacement shown"),
    "[14] misplaced receipt identifies the output as proposed");
  ok((await p14.$$eval(".recent-after", (els) => els.map((el) => el.textContent))).every((t) => t === "The technician arrived early."),
    "[14] receipt output remains the proposed replacement");
  await p14.close();
}

// [15] Mutant: remove the field-detached switch branch in describePageStatus
// (one line: change its case label to "retired-field-detached"); exact removal
// copy turns red for both the live and remembered status paths.
{
  console.log("\n[15] Removed fields have a lifecycle explanation, live and remembered:");
  for (const mode of ["live", "remembered", "replacement", "revoked"]) {
    const p15 = await browser.newPage();
    p15.on("pageerror", (e) => pageErrors.push("[15] " + e.message));
    await p15.setContent(fs.readFileSync(path.join(EXT, "popup.html"), "utf8"));
    await p15.evaluate((mode) => {
      const settings = { sentenceMode: true, disabledSites: [], sentenceModeDisabledSites: [], recordAll: false };
      const detached = { status: "field-detached", detail: "detached", family: "Slate" };
      const status = mode === "live" ? detached
        : mode === "replacement" ? { status: "active", detail: null, family: "textarea" }
        : { status: "no-field", detail: null, family: null };
      window.chrome = {
        runtime: { id: "t", lastError: undefined, sendMessage: (msg, cb) => cb(msg.type === "GET_SETTINGS"
          ? { ok: true, settings, consent: { activated: true, allowed: mode !== "revoked", siteDisabled: false,
              reason: mode === "revoked" ? "qualification-required" : null, apply: mode !== "revoked" } }
          : { ok: true }) },
        storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() }, onChanged: { addListener() {} } },
        tabs: { query: (q, cb) => cb([{ id: 1, url: "https://example.com/" }]),
          sendMessage: (id, msg, cb) => cb({ ok: true, ...status, apply: true, last: detached }) },
      };
    }, mode);
    await p15.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
    await p15.waitForFunction(() => !/Checking/.test(document.getElementById("sentenceWhere").textContent));
    const text = await p15.$eval("#sentenceWhere", (el) => el.textContent);
    if (mode === "live" || mode === "remembered") {
      const suffix = mode === "remembered" ? " (previously focused field in this frame)" : "";
      ok(text === "The field was removed before the write could be checked. Click into a text field to continue." + suffix,
        `[15/${mode}] exact plain-language removal copy${suffix ? " with frame-scoped history" : ""}`);
      ok(!/Running|refused|field-detached|\(detached\)/.test(text),
        `[15/${mode}] removal is neither running nor a raw-code range refusal`);
    } else if (mode === "replacement") {
      ok(text === "Running in the field you focused.", "[15/replacement] a live replacement outranks detached history");
    } else {
      ok(text === "Not running here: Proofer needs a current, passing speed check. Open setup.",
        "[15/revoked] current worker permission outranks detached history");
    }
    await p15.close();
  }
}

// [17] Mutant: replace describeSentenceSkip's untrusted-rejected return with
// return reason; the reason's explanation in both stats and breakdown goes red.
{
  const p17 = await browser.newPage();
  p17.on('pageerror', e => pageErrors.push(e.message));
  await p17.setContent(fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8'));
  await p17.evaluate(() => {
    const settings = { sentenceMode: true, recordAll: true, disabledSites: [], sentenceModeDisabledSites: [] };
    window.chrome = {
      runtime: { id: 't', lastError: undefined, sendMessage: (m, cb) => cb(m.type === 'GET_SETTINGS'
        ? { ok: true, settings, consent: { activated: true, allowed: true, apply: true } }
        : m.type === 'GET_LOG_STATS' ? { ok: true, sentence: {
          count: 1, applied: 0, reverted: 0, keepRate: null, medianMs: null,
          skips: { 'splice-failed:untrusted-rejected': 1 },
          distribution: { noChange: 0, guarded: 0, applied: 0, rejected: 0, lost: 0, other: 1 },
          breakdown: { deliverySkipped: { 'splice-failed:untrusted-rejected': 1 } },
          otherDetail: { deliverySkipped: 1 },
        } } : { ok: true }) },
      storage: { local: { get: (d, cb) => cb(d), set: (o, cb) => cb && cb() }, onChanged: { addListener() {} } },
      tabs: { query: (q, cb) => cb([{ id: 1, url: 'https://example.com/' }]), sendMessage: (id, m, cb) => cb({ ok: true,
        status: 'session-blocked', detail: 'write-rejected', family: 'Slate', apply: true }) },
    };
  });
  await p17.addScriptTag({ content: ["maintainer.js", "popup.js"].map((file) => fs.readFileSync(path.join(EXT, file), "utf8")).join("\n") });
  await p17.waitForFunction(() => document.querySelector('#sentenceStats').textContent.includes('untrusted-rejected'));
  const out = await p17.evaluate(() => ({ stats: document.querySelector('#sentenceStats').textContent,
    key: document.querySelector('#sentenceBarKey').textContent, status: document.querySelector('#sentenceWhere').textContent }));
  for (const [view, value] of [['stats', out.stats], ['breakdown', out.key]]) {
    ok(value.includes('splice-failed:untrusted-rejected') && value.includes('the editor did not accept input from Proofer'),
      `[17/${view}] untrusted-rejected has an accurate explanation`);
  }
  ok(out.status.includes('would not accept a write'), '[17] popup describes the element-only write rejection');
  await p17.close();
}

ok(pageErrors.length === 0, `nothing thrown in the popup (${JSON.stringify(pageErrors)})`);


await browser.close();
console.log("\n" + "=".repeat(72));
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`All ${pass} checks passed.`);
