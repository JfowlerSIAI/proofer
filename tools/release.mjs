#!/usr/bin/env node
// Build the installable ZIP from the runtime allowlist, never the checkout.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageExtension, verifyPackage, RUNTIME_FILES } from "./package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error("Invalid extension version");
if (process.argv.length !== 2) throw new Error("Usage: node tools/release.mjs");

// Check prerequisites before replacing a previous release artifact.
try { execFileSync("zip", ["-v"], { stdio: "ignore" }); }
catch { throw new Error("The release command requires the zip utility. Use Linux/macOS or the release workflow on GitHub."); }

const out = path.join(root, "dist", "release");
fs.mkdirSync(out, { recursive: true });
const pkg = packageExtension({ root, out: path.join(out, "proofer") });
const verified = verifyPackage(pkg.dest);
if (!verified.ok) throw new Error(`Package verification failed: ${verified.reason}`);
const files = [...RUNTIME_FILES, "SHA256SUMS.txt"].sort();

// Normalize timestamps and modes so repeated runs of the same checkout with
// the same zip implementation produce the same artifact.
const stamp = new Date("2000-01-01T00:00:00Z");
for (const rel of files) {
  const file = path.join(pkg.dest, rel);
  fs.chmodSync(file, 0o644);
  fs.utimesSync(file, stamp, stamp);
}
const archive = path.join(out, `proofer-${version}.zip`);
fs.rmSync(archive, { force: true });
execFileSync("zip", ["-q", "-X", archive, ...files], {
  cwd: pkg.dest, env: { ...process.env, TZ: "UTC" }, stdio: ["ignore", "inherit", "inherit"],
});
const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), `${digest}  ${path.basename(archive)}\n`);
console.log(`Built ${archive}`);
console.log(`SHA-256: ${digest}`);
console.log(`Verified ${verified.count} runtime files; licenses and attribution are included.`);
