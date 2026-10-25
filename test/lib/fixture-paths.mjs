import fs from "node:fs";
import path from "node:path";

// URLs and filesystem paths have different normalization rules. Validate the
// decoded path before any lookup, miss recording, or capture write.
export function validateFixturePath(relative) {
  const unsafeComponent = (part) => part === "." || part === ".." ||
    /[<>:"|?*]/.test(part) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
  if (typeof relative !== "string" || relative.startsWith("/") ||
      /[\\\x00-\x1f\x7f]/.test(relative) || path.isAbsolute(relative) ||
      relative.split("/").some(unsafeComponent)) {
    throw new Error("Unsafe fixture path");
  }
  return relative.split("/").filter(Boolean).join("/");
}

export function fixtureUrlPath(value) {
  const pathname = new URL(value, "http://fixture.invalid").pathname;
  const decoded = decodeURIComponent(pathname);
  const trailingSlash = decoded.endsWith("/");
  const relative = validateFixturePath(decoded.replace(/^\/+/, ""));
  return relative + (relative && trailingSlash ? "/" : "");
}

// Reject symlink components for reads as well as writes. Checking the nearest
// existing ancestor also covers new output paths, before mkdir creates them.
export function fixtureFile(root, relative) {
  relative = validateFixturePath(relative);
  const canonicalRoot = fs.realpathSync(root);
  if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error("Fixture root is not a directory");
  let file = canonicalRoot;
  for (const part of relative.split("/").filter(Boolean)) {
    file = path.join(file, part);
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("Symlink in fixture path");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return file;
}

export function writeFixtureFile(root, relative, bytes) {
  const file = fixtureFile(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Recheck after mkdir, and do not follow a final symlink when opening.
  const fd = fs.openSync(fixtureFile(root, relative),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
}
