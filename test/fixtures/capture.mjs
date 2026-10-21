#!/usr/bin/env node
/**
 * Capture a live editor demo page into test/fixtures/ so a suite can run it
 * with the network unplugged.
 *
 *   cd test && node fixtures/capture.mjs slate
 *   cd test && node fixtures/capture.mjs --all
 *
 * WHY A CAPTURE AND NOT A FIXTURE. A Slate-SHAPED DOM proves nothing about
 * Slate: the failure this project cares about is the editor's own MODEL
 * disagreeing with the DOM, and a hand-written fixture has no model to
 * disagree. So the captured page has to run the real bundle. Which means
 * capturing the JavaScript, not the markup.
 *
 * HOW. Puppeteer loads the live page and every response it makes is written to
 * disk under its own URL path, so `_next/static/chunks/framework-*.js` lands at
 * `_next/static/chunks/framework-*.js`. `lib/fixture-server.mjs` then serves
 * that directory at the ORIGINAL path (`/examples/richtext`), which is why no
 * `history.replaceState` fix-up is needed here -- Next's router hydrates
 * against `location.pathname` and finds exactly what it shipped with.
 *
 * The document body written out is the SERVER's HTML, not the hydrated DOM.
 * Serializing a hydrated React tree and re-hydrating it is a different page
 * from the one users load, and the difference is precisely the machinery under
 * test.
 *
 * Two edits are made to the captured HTML, both recorded in its header:
 *   - a CSP that permits `'self'` and nothing else, so "this fixture makes no
 *     network requests" is enforced by the browser rather than asserted by a
 *     comment. A regression here is a blocked-request error, not a silent
 *     dependency on a website being up.
 *   - external `<link rel=preconnect>` removed. They fetch nothing, but they
 *     open sockets, and "zero network" should be literal.
 *
 * Licensing: these are third-party demo pages captured for offline testing.
 * Slate is MIT (ianstormtaylor/slate), ProseMirror MIT, Quill BSD-3, Lexical
 * MIT, Draft.js MIT, Trix MIT. Provenance -- URL, capture date, and any
 * version string found in the bundle -- goes in the header comment of each
 * captured HTML file.
 */
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { resolveChrome } from "../lib/chrome.mjs";
import { serveFixture } from "../lib/fixture-server.mjs";
import { writeTrixFixture } from "./trix-page.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);

export const TARGETS = {
  slate: {
    url: "https://www.slatejs.org/examples/richtext",
    dir: "slatejs.org",
    entry: "examples/richtext",
    ready: '[data-slate-editor="true"]',
    project: "Slate (ianstormtaylor/slate, MIT)",
  },
  "slate-current": {
    url: "https://www.slatejs.org/examples/richtext",
    dir: "slatejs.org-2026-10-09",
    entry: "examples/richtext",
    ready: '[data-slate-editor="true"]',
    project: "Slate (ianstormtaylor/slate, MIT)",
  },
  prosemirror: {
    url: "https://prosemirror.net/examples/basic/",
    dir: "prosemirror.net",
    entry: "examples/basic/index.html",
    ready: ".ProseMirror",
    project: "ProseMirror (prosemirror/prosemirror, MIT)",
  },
  // The HOMEPAGE, not /playground -- the playground renders its editor inside a
  // CodeSandbox Sandpack iframe on an ephemeral `*.sandpack-static-server.
  // codesandbox.io` origin, assembled at run time from source. There is nothing
  // stable there to capture. The homepage runs the same real Quill bundle.
  quill: {
    url: "https://quilljs.com/",
    dir: "quilljs.com",
    entry: "index.html",
    ready: ".ql-editor",
    project: "Quill (slab/quill, BSD-3-Clause)",
  },
  lexical: {
    url: "https://playground.lexical.dev/",
    dir: "playground.lexical.dev",
    entry: "index.html",
    ready: '[data-lexical-editor="true"]',
    project: "Lexical (facebook/lexical, MIT)",
  },
  draft: {
    url: "https://draftjs.org/",
    dir: "draftjs.org",
    entry: "index.html",
    ready: ".public-DraftEditor-content",
    project: "Draft.js (facebook/draft-js, MIT)",
  },
  trix: {
    url: "https://trix-editor.org/",
    dir: "trix-editor.org",
    entry: "index.html",
    ready: "trix-editor",
    project: "Trix (basecamp/trix, MIT)",
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hosts whose responses are dropped and whose `<script src>` tags are cut out
 * of the captured HTML. Analytics beacons and bot challenges cannot work
 * offline by construction: they exist to talk to their own servers. Kept, they
 * are dead weight that fills the console with failures on every run and puts a
 * one-time Cloudflare session token in the repository. Not a general
 * third-party ban -- `cdn.jsdelivr.net` carries Quill's actual bundle.
 */
const DROP_HOSTS = [
  "www.googletagmanager.com", "www.google-analytics.com", "google-analytics.com",
  "challenges.cloudflare.com", "doubleclick.net", "static.cloudflareinsights.com",
  // A YouTube EMBED's document is cross-origin and never captured (only
  // script/style/font/image are), so its player assets are dead weight by
  // construction -- 4.5 MB of them on draftjs.org.
  "youtube.com", "ytimg.com", "ggpht.com", "www.google.com",
];
const dropped = (u) => DROP_HOSTS.some((h) => new URL(u).host === h || new URL(u).host.endsWith("." + h));

/** URL path -> a safe relative file path. Decoded, so `%5Bexample%5D` is `[example]`. */
function pathFor(u) {
  const url = new URL(u);
  let p = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += "index.html";
  // No traversal, no absolute escapes; a captured site never needs them. And a
  // segment longer than a filesystem allows is shortened rather than fatal --
  // a Cloudflare challenge beacon carries an 800-character path, and ENAMETOOLONG
  // from the middle of a capture reads like a bug in the capture tool.
  return p.split("/").filter((s) => s && s !== "." && s !== "..")
    .map((s) => (s.length > 100 ? s.slice(0, 60) + "-" + shortHash(s) : s))
    .join("/");
}

const shortHash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/**
 * What can actually be pinned. Editor bundles rarely carry their own version --
 * Slate's does not -- so the honest answer is the site build id plus whatever
 * framework version the bundle does state, and silence where there is nothing.
 * A guessed version number in a provenance header is worse than none.
 */
function provenanceFrom(html, bodies) {
  const out = [];
  const build = html.match(/"buildId":"([^"]+)"/);
  if (build) out.push(`site build id ${build[1]}`);
  for (const [u, body] of bodies) {
    if (!/\.js($|\?)/.test(u)) continue;
    const s = String(body);
    const react = s.match(/react-dom[\s\S]{0,40}?version:"(\d+\.\d+\.\d+)"/) || s.match(/\bversion:"(1[6-9]\.\d+\.\d+)"/);
    if (react) { out.push(`React ${react[1]}`); break; }
  }
  return out;
}

/**
 * The url() absorber below covers what a STYLESHEET can name; this covers what
 * a RUNTIME can name. draftjs.org's webpack runtime dynamically imports a
 * chunk offline that the live load never requests -- hydration diverges where
 * the CSP blocks an embed -- so a capture keeping only what the live run
 * fetched is a fixture that 404s that chunk on every future run, and a
 * ChunkLoadError takes the whole editor down with it. So: boot the capture the
 * way a suite will, let the fixture server record its misses, fetch those from
 * the origin, and repeat until a boot demands nothing new. A miss the origin
 * itself 404s (draftjs.org's own opensearch.xml) is warned and left; it was
 * missing live too, so leaving it is fidelity.
 */
async function absorbOfflineDemands(t, outDir, chromePath, verbose) {
  const origin = new URL(t.url).origin;
  const typesPath = path.join(outDir, "_types.json");
  // A zero-byte captured file is a chunk whose only responses carried no body
  // -- draftjs.org's other-route chunks arrive solely as bodiless prefetches.
  // Served empty, a webpack chunk is a ChunkLoadError; fetch the real bytes.
  const backfill = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const r = rel ? rel + "/" + name : name;
      if (fs.statSync(p).isDirectory()) { backfill(p, r); continue; }
      if (fs.statSync(p).size > 0) continue;
      const u = r.startsWith("_external/")
        ? "https://" + r.slice("_external/".length)
        : origin + "/" + r;
      fetches.push(fetch(u).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fs.writeFileSync(p, Buffer.from(await res.arrayBuffer()));
        if (verbose) console.log(`  backfilled empty capture: ${r}`);
      }).catch((e) => console.log(`  WARN: ${r} captured empty and could not be backfilled (${e.message})`)));
    }
  };
  const fetches = [];
  backfill(outDir, "");
  await Promise.all(fetches);
  for (let round = 1; round <= 3; round++) {
    const server = await serveFixture(outDir);
    const browser = await puppeteer.launch({
      headless: true, executablePath: chromePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    // Booted at the path a suite will use: the DIRECTORY, not index.html. An
    // SPA router has a route for `/` and none for `/index.html` -- Docusaurus
    // hydrates the latter into its NotFound page, editor and all.
    await page.goto(server.url("/" + t.entry.replace(/index\.html$/, "")),
      { waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
    await page.waitForSelector(t.ready, { timeout: 15000 }).catch(() => {});
    await sleep(2000);
    await browser.close();
    await server.close();
    const missing = [...new Set(server.misses)];
    if (!missing.length) return;
    const types = JSON.parse(fs.readFileSync(typesPath, "utf8"));
    let added = 0;
    for (const rel of missing) {
      const u = origin + "/" + rel;
      try {
        const r = await fetch(u);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const dest = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        const ct = r.headers.get("content-type");
        if (ct) types[rel] = ct;
        added++;
        if (verbose) console.log(`  absorbed offline-only demand: ${rel}`);
      } catch (e) {
        if (verbose) console.log(`  WARN: offline run asked for ${rel}; origin has no ${u} (${e.message})`);
      }
    }
    fs.writeFileSync(typesPath, Buffer.from(JSON.stringify(types, null, 1), "utf8"));
    if (!added) return; // every remaining miss is unrecoverable; looping cannot help
  }
}

export async function capture(name, { verbose = true } = {}) {
  const t = TARGETS[name];
  if (!t) throw new Error(`unknown capture target: ${name}`);
  const outDir = path.join(HERE, t.dir);
  if (name === "trix") {
    const result = writeTrixFixture(outDir);
    if (verbose) console.log("wrote trix: local harness with unchanged pinned Trix 2.1.19 assets");
    return result;
  }
  const chrome = await resolveChrome();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chrome.path,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  // A desktop viewport, not Puppeteer's 800x600 default: draftjs.org hides its
  // demo editor under `.hideOnTabletAndSmall` below ~997px, and a page captured
  // in its tablet layout may never request what the desktop layout needs.
  await page.setViewport({ width: 1366, height: 900 });

  const bodies = new Map();     // absolute url -> Buffer   (same-origin, kept at its own path)
  const foreign = new Map();    // absolute url -> Buffer   (other origins, kept under _external/)
  // What the origin server SAID each thing was. A path with no extension --
  // `fonts.googleapis.com/css`, `@docsearch/css@3` -- cannot be typed from its
  // name, and typing it wrong means the browser drops a stylesheet in silence.
  // Recorded here so the fixture server never has to guess.
  const contentTypes = new Map();
  const origin = new URL(t.url).origin;
  page.on("response", async (res) => {
    const u = res.url();
    if (!u.startsWith("http")) return;
    const own = new URL(u).origin === origin;
    contentTypes.set(u, res.headers()["content-type"] || "");
    // A cross-origin request is only worth keeping if the PAGE needs it to
    // render: script, stylesheet, font, image. Everything else on a third-party
    // origin is analytics, a Cloudflare challenge beacon, or a session ping --
    // things a captured page must not make and gains nothing from having.
    if (!own && (dropped(u)
      || !["script", "stylesheet", "font", "image"].includes(res.request().resourceType()))) return;
    try {
      const buf = await res.buffer();
      // A page can load the same URL twice -- draftjs.org's homepage loads two
      // of its chunks once from markup and once from the router -- and the
      // second response can be a cache hit carrying NO body. Last-write-wins
      // stored that empty buffer over the real one: a zero-byte chunk, a
      // ChunkLoadError, and a fixture with no editor in it. Emptiness never
      // replaces content.
      const store = own ? bodies : foreign;
      if (buf.length || !store.has(u)) store.set(u, buf);
    } catch { /* redirects and cached-without-body responses have none */ }
  });

  const resp = await page.goto(t.url, { waitUntil: "networkidle2", timeout: 90000 });
  if (!resp || !resp.ok()) throw new Error(`${t.url} -> HTTP ${resp && resp.status()}`);
  await page.waitForSelector(t.ready, { timeout: 30000 });
  // Scrolled through, then four seconds, not two. A Next.js router prefetches
  // the links it can SEE, and lazy images load the same way, so a capture that
  // never leaves the top of the page is missing whatever the second screenful
  // would have asked for -- which shows up as a 404 on every future run of the
  // fixture rather than here.
  await page.evaluate(async () => {
    const step = 800;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 250));
    }
    window.scrollTo(0, 0);
  });
  await sleep(4000);

  // The document's own response is the SERVER html, which is what we want.
  const docUrl = [...bodies.keys()].find((u) => pathFor(u) === pathFor(t.url));
  let html = bodies.get(docUrl).toString("utf8");
  bodies.delete(docUrl);

  const version = provenanceFrom(html, bodies).join(", ") || null;
  const stamp = new Date().toISOString().slice(0, 10);
  const csp = "default-src 'self' data: blob:; script-src 'self' data: 'unsafe-inline' "
    + "'unsafe-eval'; style-src 'self' data: 'unsafe-inline'; img-src 'self' data: blob:; "
    + "font-src 'self' data:; connect-src 'self'; frame-src 'self' data:";
  const header =
    `<!--\n`
    + `  CAPTURED THIRD-PARTY TEST FIXTURE -- do not hand-edit.\n`
    + `    source:   ${t.url}\n`
    + `    captured: ${stamp} by test/fixtures/capture.mjs\n`
    + `    project:  ${t.project}\n`
    + (version ? `    pinned:   ${version}\n` : "")
    + `    browser:  ${chrome.source}\n`
    + `\n`
    + `  This is the REAL bundle, not a look-alike. A DOM shaped like this\n`
    + `  editor's cannot fail the way the editor does, because there is no model\n`
    + `  behind it to disagree with the DOM.\n`
    + `\n`
    + `  Two edits from the wire: the CSP below (so "no network" is enforced,\n`
    + `  not asserted) and external <link rel=preconnect> removed. Re-capture\n`
    + `  with: cd test && node fixtures/capture.mjs ${name}\n`
    + `-->\n`;

  html = html.replace(/<link[^>]+rel="?preconnect"?[^>]*>/gi, "");
  for (const h of DROP_HOSTS) {
    const esc = h.replace(/\./g, "\\.");
    html = html.replace(new RegExp(`<script[^>]*\\bsrc="https?://(?:[\\w.-]*\\.)?${esc}[^"]*"[^>]*>\\s*</script>`, "gi"), "");
  }
  // `<head([^>]*)>` matches `<header >`, which is where this landed on the
  // ProseMirror page -- and a CSP meta outside <head> is IGNORED, silently
  // except for one console line. The fixture then had no offline guarantee at
  // all while looking exactly like the ones that did. Hence `(\s[^>]*)?`, and
  // hence the fallback: that page has no <head> tag, so the meta goes directly
  // after <html> where the parser puts it in the implied head.
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<head(\s[^>]*)?>/i, (m) => m + cspTag);
  } else if (/<html(\s[^>]*)?>/i.test(html)) {
    html = html.replace(/<html(\s[^>]*)?>/i, (m) => m + "\n" + cspTag);
  } else {
    html = cspTag + "\n" + html;
  }
  html = header + html;

  // A cross-origin subresource is kept too, under `_external/<host>/...`, and
  // every reference to it in a captured TEXT file is repointed. The alternative
  // -- leave the absolute URL and let the CSP block it -- is a page that is
  // quietly missing a font on an aeroplane and noisy in the console, which is
  // the sort of difference that gets blamed on the code under test.
  const rewrites = new Map();
  const adopt = (u) => rewrites.set(u, "/_external/" + new URL(u).host + "/" + pathFor(u));
  for (const u of foreign.keys()) adopt(u);

  // A `url()` this browser did not happen to request is still a request some
  // other browser will make -- the Material Icons block on the Slate page
  // declares both a .woff2 and a .woff, and Chrome fetches only the first. Left
  // behind, the second is a CSP violation logged on every single run, and a
  // console that always has an error in it is a console nobody reads.
  const absoluteUrls = new Set();
  for (const [u, buf] of [[t.entry, Buffer.from(html, "utf8")], ...bodies]) {
    const rel = u === t.entry ? u : pathFor(u);
    if (!/\.(html|css|js|json)$/.test(rel) && rel !== t.entry) continue;
    for (const m of buf.toString("utf8").matchAll(/url\((['"]?)(https?:\/\/[^)'"\s]+)\1\)/g)) {
      if (new URL(m[2]).origin !== origin && !dropped(m[2])) absoluteUrls.add(m[2]);
    }
  }
  for (const u of absoluteUrls) {
    if (foreign.has(u)) continue;
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      foreign.set(u, Buffer.from(await r.arrayBuffer()));
      adopt(u);
    } catch (e) {
      console.log(`  WARN: could not absorb ${u} (${e.message}) -- the CSP will block it at run time`);
    }
  }
  const repoint = (buf, rel) => {
    if (!/\.(html|css|js|mjs|json|txt|map)$/.test(rel) && rel !== t.entry) return buf;
    let s = buf.toString("utf8");
    let hit = false;
    for (const [from, to] of rewrites) {
      if (s.includes(from)) { s = s.split(from).join(to); hit = true; }
    }
    return hit ? Buffer.from(s, "utf8") : buf;
  };

  fs.rmSync(outDir, { recursive: true, force: true });
  let bytes = 0;
  const write = (rel, buf) => {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    bytes += buf.length;
  };
  write(t.entry, repoint(Buffer.from(html, "utf8"), t.entry));
  for (const [u, buf] of bodies) write(pathFor(u), repoint(buf, pathFor(u)));
  for (const [u, buf] of foreign) write(rewrites.get(u).replace(/^\//, ""), buf);

  // The type manifest, keyed by the path the server will be asked for.
  const types = { [t.entry]: "text/html; charset=utf-8" };
  for (const u of bodies.keys()) {
    const ct = contentTypes.get(u);
    if (ct) types[pathFor(u)] = ct;
  }
  for (const u of foreign.keys()) {
    const ct = contentTypes.get(u);
    if (ct) types[rewrites.get(u).replace(/^\//, "")] = ct;
  }
  write("_types.json", Buffer.from(JSON.stringify(types, null, 1), "utf8"));

  await browser.close();
  await absorbOfflineDemands(t, outDir, chrome.path, verbose);
  const files = bodies.size + foreign.size + 1;
  if (verbose) {
    console.log(`captured ${name}: ${files} files, ${(bytes / 1024).toFixed(0)} KB -> ${outDir}`);
    if (foreign.size) {
      console.log(`  ${foreign.size} cross-origin subresource(s) captured under _external/ and repointed:`);
      for (const u of foreign.keys()) console.log(`    ${u}`);
    }
  }
  return { name, files, bytes, external: [...foreign.keys()], version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const names = args.includes("--all") ? Object.keys(TARGETS) : args.filter((a) => !a.startsWith("-"));
  if (!names.length) {
    console.log(`usage: node fixtures/capture.mjs <${Object.keys(TARGETS).join("|")}|--all>`);
    process.exit(2);
  }
  let failed = 0;
  for (const n of names) {
    try { await capture(n); }
    catch (e) { failed++; console.log(`FAILED ${n}: ${e.message.split("\n")[0]}`); }
  }
  process.exit(failed ? 1 : 0);
}
