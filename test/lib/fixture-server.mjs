/**
 * Serve a captured site from test/fixtures/ over http, at its original paths.
 *
 * Over HTTP and not `file://`, deliberately. A captured Next.js page hydrates
 * against `location.pathname` and its router, service-worker and history calls
 * all assume an http origin; `file://` also gives every page an opaque origin,
 * which changes how `getSelection()`, `execCommand` and CSP behave -- the exact
 * machinery under test. The point of the fixture is to be the real page minus
 * the network, not minus the origin.
 *
 * Paths are served as captured, so `/examples/richtext` is `/examples/richtext`
 * and the router hydrates without a `history.replaceState` fix-up.
 */
import fs from "fs";
import http from "http";
import path from "path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * @param {string} root  directory holding the captured site
 * @returns {Promise<{ origin: string, url: (p?: string) => string, close: () => Promise<void>, misses: string[] }>}
 */
export async function serveFixture(root) {
  // Resolved up front. The containment check below compares against the
  // resolved root, so a RELATIVE root made every single path fail it -- the
  // server 404'd its own captured files and reported them as never captured,
  // which reads as a broken capture rather than a broken argument.
  root = path.resolve(root);
  if (!fs.existsSync(root)) {
    throw new Error(
      `No captured fixture at ${root}.\n` +
      `    cd test && node fixtures/capture.mjs <target>   # needs the network, once`);
  }
  // What the ORIGINAL server said each path was, recorded at capture time.
  // Without it an extension-less path can only be guessed at, and the guess was
  // wrong for three real files: `fonts.googleapis.com/css` and
  // `@docsearch/css@3` are stylesheets, and serving them as text/html makes the
  // browser drop them silently -- a fixture that renders unstyled while every
  // assertion stays green. A recorded answer cannot be wrong about this; a
  // sniffer would be a heuristic guarding a heuristic.
  let recorded = {};
  const typesFile = path.join(root, "_types.json");
  if (fs.existsSync(typesFile)) {
    try { recorded = JSON.parse(fs.readFileSync(typesFile, "utf8")); } catch { /* fall through */ }
  }

  const misses = [];
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const asked = rel;
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const parts = rel.split("/").filter((s) => s && s !== "." && s !== "..");
    let file = path.join(root, ...parts);
    // `/examples/basic` is a directory: REDIRECT rather than serve its
    // index.html here. Serving it at the un-slashed URL leaves the browser
    // resolving `../prosemirror.js` and `example.js` against the wrong base --
    // the same class of bug as serving a stylesheet as HTML, silent and
    // downstream. A redirect is what the original server does.
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!asked.endsWith("/") && fs.existsSync(path.join(file, "index.html"))) {
        res.writeHead(301, { location: "/" + asked + "/" });
        return res.end();
      }
      file = path.join(file, "index.html");
    }
    // Containment is checked on the REAL path, so a symlink pointing out of the
    // capture is caught rather than merely a `..` in the URL. Two limits, both
    // accepted: this is a loopback-only test server, and the fixtures contain
    // no symlinks today (`find -type l` is empty) -- the realpath check is here
    // so that stays true by construction rather than by habit.
    let real = null;
    try { real = fs.realpathSync(file); } catch { /* missing */ }
    const inside = real !== null
      && (real === root || real.startsWith(root + path.sep));
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // Recorded rather than swallowed: a 404 here means the capture is
      // incomplete, and an incomplete capture is a page that quietly behaves
      // differently from the site it came from.
      misses.push(rel);
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not captured: " + rel);
    }
    // Recorded type first. Then the extension. An extension-less path with no
    // recorded type is a page (`/examples/richtext`): served as octet-stream
    // Chrome aborts the navigation and the failure arrives as a bare
    // ERR_ABORTED with nothing pointing at the MIME type. That last case is a
    // fallback for hand-made fixtures -- every captured file has a recorded
    // type.
    const ext = path.extname(file);
    const type = recorded[rel] || TYPES[ext]
      || (ext ? "application/octet-stream" : TYPES[".html"]);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    misses,
    url: (p = "/") => origin + (p.startsWith("/") ? p : "/" + p),
    close: () => new Promise((r) => server.close(r)),
  };
}
