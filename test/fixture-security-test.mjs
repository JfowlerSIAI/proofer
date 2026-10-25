import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fixtureUrlPath, fixtureFile, writeFixtureFile } from "./lib/fixture-paths.mjs";
import { serveFixture } from "./lib/fixture-server.mjs";
import { writeTrixFixture } from "./fixtures/trix-page.mjs";

const unsafeRequests = [
  "/..%2foutside.txt", "/%2e%2e%2foutside.txt", "/assets%2f..%2foutside.txt",
  "/..%5coutside.txt", "/C:%5coutside.txt", "/%00.txt", "/%zz", "/%E0%A4%A",
  "/..%20%2foutside.txt", "/NUL.txt", "/assets%2fCOM1.js", "/file.txt:stream",
];

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proofer-fixture-security-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(origin, requestedPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(origin, { path: requestedPath }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, location: res.headers.location }));
    });
    req.on("error", reject);
  });
}

test("decoded fixture URLs reject traversal and Windows separators", () => {
  for (const value of unsafeRequests) assert.throws(() => fixtureUrlPath(value), undefined, value);
  assert.equal(fixtureUrlPath("https://example.test/examples/%5Brich%20text%5D/"), "examples/[rich text]/");
});

test("capture writes cannot leave the output directory", (t) => {
  const dir = temporary(t), root = path.join(dir, "capture");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(dir, "outside.txt"), "unchanged");
  for (const rel of ["../outside.txt", "nested/../../outside.txt", "..\\outside.txt", "/outside.txt", "C:/outside.txt", ".. /outside.txt", "NUL.txt"]) {
    assert.throws(() => writeFixtureFile(root, rel, "replacement"), undefined, rel);
  }
  assert.equal(fs.readFileSync(path.join(dir, "outside.txt"), "utf8"), "unchanged");
  writeFixtureFile(root, "nested/captured.js", "safe asset");
  assert.equal(fs.readFileSync(path.join(root, "nested/captured.js"), "utf8"), "safe asset");
});

test("fixture paths reject existing and dangling symlink components", (t) => {
  const dir = temporary(t), root = path.join(dir, "capture"), outside = path.join(dir, "outside");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "private");
  fs.symlinkSync(outside, path.join(root, "linked"), "junction");
  fs.symlinkSync(path.join(dir, "missing"), path.join(root, "dangling"), "junction");
  for (const relative of ["linked/secret.txt", "linked/new.txt", "dangling/new.txt"]) {
    assert.throws(() => fixtureFile(root, relative));
    assert.throws(() => writeFixtureFile(root, relative, "replacement"));
  }
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "private");
  assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
});

test("the local Trix wrapper cannot overwrite a symlink target", (t) => {
  const dir = temporary(t), root = path.join(dir, "capture");
  fs.mkdirSync(root);
  const assets = "_external/unpkg.com/trix@2.1.19/dist/";
  for (const name of ["trix.umd.min.js", "trix.css"]) writeFixtureFile(root, assets + name, "synthetic fixture asset");
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "unchanged");
  for (const name of ["index.html", "_types.json"]) {
    fs.rmSync(path.join(root, name), { force: true });
    fs.symlinkSync(outside, path.join(root, name));
    assert.throws(() => writeTrixFixture(root), /symlink/i);
    assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
    fs.unlinkSync(path.join(root, name));
  }
});

test("HTTP rejects malformed and traversal requests without recording unsafe misses or crashing", async (t) => {
  const root = temporary(t);
  writeFixtureFile(root, "index.html", "healthy");
  writeFixtureFile(root, "examples/richtext/index.html", "editor");
  const server = await serveFixture(root);
  try {
    for (const pathname of unsafeRequests) assert.equal((await request(server.origin, pathname)).status, 400, pathname);
    assert.deepEqual(server.misses, []);
    assert.equal((await request(server.origin, "/")).body, "healthy");
    assert.equal((await request(server.origin, "/examples/richtext")).location, "/examples/richtext/");
    assert.equal((await request(server.origin, "/examples/richtext/")).body, "editor");
    assert.equal((await request(server.origin, "/assets/missing.js")).status, 404);
    assert.deepEqual(server.misses, ["assets/missing.js"]);
  } finally { await server.close(); }
});

test("HTTP refuses a symlinked directory index and does not backfill it", async (t) => {
  const dir = temporary(t), root = path.join(dir, "capture");
  fs.mkdirSync(path.join(root, "route"), { recursive: true });
  const outside = path.join(dir, "outside.html");
  fs.writeFileSync(outside, "private");
  fs.symlinkSync(outside, path.join(root, "route/index.html"));
  const server = await serveFixture(root);
  try {
    assert.equal((await request(server.origin, "/route/")).status, 403);
    assert.deepEqual(server.misses, []);
  } finally { await server.close(); }
});
