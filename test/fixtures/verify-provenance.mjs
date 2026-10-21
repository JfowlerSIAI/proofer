#!/usr/bin/env node
// Read-only, dependency-free publication checks for vendored editor fixtures.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function verifyProvenance(root = HERE) {
  const errors = [];
  const safePath = (rel) => {
    if (typeof rel !== "string" || path.isAbsolute(rel) || rel.includes("\\") ||
        rel.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`unsafe provenance path: ${rel}`);
    }
    return path.join(root, rel);
  };
  const read = (rel) => JSON.parse(fs.readFileSync(safePath(rel), "utf8"));
  const exists = (rel) => fs.existsSync(safePath(rel));
  const checked = new Set();
  const checkFile = (rel, expected) => {
    const target = safePath(rel);
    if (!fs.existsSync(target)) { errors.push(`missing file: ${rel}`); return; }
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) { errors.push(`not a regular file: ${rel}`); return; }
    if (expected && digest(fs.readFileSync(target)) !== expected) errors.push(`hash mismatch: ${rel}`);
    checked.add(rel);
  };
  const walk = (dir) => fs.readdirSync(safePath(dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(rel) : [rel];
  });

  const ledger = read("ASSET_PROVENANCE.json");
  const assets = new Map(ledger.assets.map((asset) => [asset.file, asset]));
  if (assets.size !== ledger.assets.length) errors.push("duplicate asset provenance entries");
  for (const asset of ledger.assets) {
    checkFile(asset.file, asset.sha256);
    for (const license of asset.license_files) checkFile(license);
    if (exists(asset.file) && asset.file.endsWith(".js")) {
      const text = fs.readFileSync(safePath(asset.file), "utf8");
      for (const match of text.matchAll(/For license information please see ([A-Za-z0-9._-]+)/g)) {
        const sidecar = path.posix.join(path.posix.dirname(asset.file), match[1]);
        if (!assets.has(sidecar)) errors.push(`unrecorded license sidecar: ${sidecar}`);
        checkFile(sidecar);
      }
    }
  }
  for (const site of Object.keys(ledger.sites)) {
    for (const rel of walk(site)) if (!assets.has(rel)) errors.push(`unrecorded asset: ${rel}`);
  }
  for (const removed of ledger.removed) {
    if (exists(removed.file)) errors.push(`removed asset reintroduced: ${removed.file}`);
  }

  for (const license of read("LICENSES/SOURCES.json").licenses) checkFile(license.file, license.sha256);
  const fontRows = read("LICENSES/font-sources.json").fonts;
  const fonts = new Set(fontRows.map((font) => font.file));
  for (const font of fontRows) {
    checkFile(font.file, font.sha256);
    checkFile(font.license_file);
  }
  for (const rel of assets.keys()) {
    if (/\.(woff2?|ttf|otf)$/i.test(rel) && !fonts.has(rel)) errors.push(`font lacks license mapping: ${rel}`);
  }
  const images = read("LICENSES/image-sources.json").assets;
  for (const asset of images) {
    checkFile(asset.file, asset.sha256);
    if (!asset.matching_source_urls?.length) errors.push(`artwork lacks source match: ${asset.file}`);
  }

  const restored = new Map();
  for (const notice of read("LICENSES/npm-upstream-notices.json").notices) {
    if (notice.error || !notice.file) {
      errors.push(`unresolved package notice: ${notice.package}@${notice.version}`);
      continue;
    }
    restored.set(`${notice.package}@${notice.version}`, notice);
    checkFile(notice.file, notice.sha256);
  }
  const packages = new Set();
  for (const manifest of ["npm-sources.json", "npm-extra-sources.json", "npm-coverage-sources.json", "npm-helper-sources.json"]) {
    for (const pkg of read(`LICENSES/${manifest}`).packages) {
      const key = `${pkg.package}@${pkg.version}`;
      packages.add(key);
      if (pkg.error || (!pkg.notices?.length && !restored.has(key))) errors.push(`package lacks a notice: ${key}`);
      for (const notice of pkg.notices || []) checkFile(notice.file, notice.sha256);
    }
  }
  // These standard texts supplement upstream link-only notices and the fonts'
  // embedded terms; they must not disappear when the notice inventory changes.
  for (const rel of ["LICENSES/W3C-20150513.txt", "LICENSES/fonts/KaTeX-Fonts-OFL.txt"]) checkFile(rel);

  return { errors, assets: assets.size, fonts: fonts.size, packages: packages.size, files: checked.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyProvenance();
    if (result.errors.length) {
      for (const error of result.errors) console.error(`FAIL ${error}`);
      console.error("Review fixture provenance and notices before updating the ledger.");
      process.exitCode = 1;
    } else {
      console.log(`Fixture provenance: ${result.assets} assets, ${result.fonts} fonts, ${result.packages} package notices; all hashes and references verified.`);
    }
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}
