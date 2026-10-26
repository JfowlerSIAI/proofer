import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { browserVersionAllowed, checkedChrome } from "./lib/chrome.mjs";
import { checkArtifactAge } from "./scripts/install-chrome.mjs";

const pin = JSON.parse(fs.readFileSync(new URL("./chrome-version.json", import.meta.url), "utf8"));
const DAY = 86400000;
const NOW = Date.parse("2026-10-24T12:00:00Z");
const dateBefore = (milliseconds) => new Date(NOW - milliseconds).toUTCString();
const normal = { version: "156.0.8078.47", quarantineDays: 10 };
const exception = {
  version: "156.0.8078.47", quarantineDays: 1,
  securityFixes: ["CVE-2026-113341"],
  advisory: "https://chromereleases.googleblog.com/2026/10/security-release.html",
};

test("the browser floor compares all four numeric components", () => {
  const floor = "156.0.8078.47";
  for (const version of [floor, "156.0.8078.48", "156.0.8079.0", "156.1.0.0", "157.0.0.0"]) {
    assert.equal(browserVersionAllowed(version, floor), true, version);
  }
  for (const version of ["145.0.7632.77", "155.99.9999.999", "156.0.8077.999", "156.0.8078.9", "156.0.8078.46"]) {
    assert.equal(browserVersionAllowed(version, floor), false, version);
  }
});

test("unknown and malformed browser versions never satisfy the floor", () => {
  for (const version of [undefined, null, "", "unknown", "stable", "156", "156.0.8078",
    "156.0.8078.47-beta", "Google Chrome 156.0.8078.47", "156.0.8078.47.0"]) {
    assert.equal(browserVersionAllowed(version), false, String(version));
  }
});

// Exercise the executable-checking boundary without launching a real browser.
// Built-in ESM bindings are synchronized so the production named import sees
// the mock; cleanup restores them before another test can use child_process.
function mockVersionCommand(t, { version, output, error } = {}) {
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    calls.push({ file, args, options });
    if (error) throw error;
    if (output !== undefined) return output;
    return /powershell|pwsh/i.test(String(file))
      ? `${version}\r\n`
      : `Google Chrome for Testing ${version}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return calls;
}

test("an old executable is rejected even when explicitly selected", (t) => {
  mockVersionCommand(t, { version: "145.0.7632.77" });
  assert.throws(() => checkedChrome("browser-security-old", "PROOFER_CHROME"), /security floor|below/i);
});

test("a browser with unrecognizable output is rejected", (t) => {
  mockVersionCommand(t, { output: "version unavailable\n" });
  assert.throws(() => checkedChrome("browser-security-unknown", "PROOFER_CHROME"), /unknown|verify|security floor/i);
});

test("a failed version command cannot authorize a browser", (t) => {
  mockVersionCommand(t, { error: new Error("spawn failed") });
  assert.throws(() => checkedChrome("browser-security-failed", "PROOFER_CHROME"), /verify/i);
});

test("a verified executable at the reviewed floor remains usable", (t) => {
  mockVersionCommand(t, { version: pin.minimumVersion });
  const result = checkedChrome("browser-security-current", "PROOFER_CHROME");
  assert.equal(result.path, "browser-security-current");
  assert.equal(result.source, "PROOFER_CHROME");
  assert.equal(result.version, pin.minimumVersion);
});

test("Windows checks PE metadata and treats quoted executable paths as data", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const calls = mockVersionCommand(t, { version: pin.minimumVersion });
  const executable = "browser-security-Windows 'quoted' $(not-a-command).exe";
  assert.equal(checkedChrome(executable, "PROOFER_CHROME").version, pin.minimumVersion);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "powershell.exe");
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.PROOFER_VERSION_BINARY, path.resolve(executable));
  assert.ok(calls[0].args.includes("-NoProfile"));
  assert.ok(calls[0].args.includes("-NonInteractive"));
  assert.ok(calls[0].args.every((argument) => !argument.includes(executable)));
});

test("the ordinary quarantine requires ten complete days", () => {
  assert.doesNotThrow(() => checkArtifactAge(dateBefore(10 * DAY), NOW, normal));
  assert.doesNotThrow(() => checkArtifactAge(dateBefore(11 * DAY), NOW, normal));
  assert.throws(() => checkArtifactAge(dateBefore(10 * DAY - 1000), NOW, normal), /eligible|requires/i);
  assert.throws(() => checkArtifactAge(dateBefore(2 * DAY), NOW, normal), /eligible|requires/i);
});

test("a documented exact-version CVE exception still requires a complete day", () => {
  assert.doesNotThrow(() => checkArtifactAge(dateBefore(DAY), NOW, exception));
  assert.throws(() => checkArtifactAge(dateBefore(DAY - 1000), NOW, exception), /eligible|requires/i);
});

test("missing, invalid, and future artifact dates fail under either policy", () => {
  for (const policy of [normal, exception]) {
    for (const date of [undefined, null, "", "not a date", new Date(NOW + DAY).toUTCString()]) {
      assert.throws(() => checkArtifactAge(date, NOW, policy), /eligible|date|requires/i, String(date));
    }
  }
});

test("unsupported quarantine intervals cannot bypass the date gate", () => {
  for (const quarantineDays of [undefined, null, 0, -1, 2, 9, "1", "10"]) {
    assert.throws(() => checkArtifactAge(dateBefore(30 * DAY), NOW, { ...normal, quarantineDays }), /quarantine|exception/i);
  }
});

test("a one-day exception needs actual CVE identifiers", () => {
  for (const securityFixes of [undefined, null, [], "CVE-2026-113341", [""], ["not-a-CVE"],
    ["CVE-2026-1"], ["CVE-2026-113341", ""], [{ id: "CVE-2026-113341" }]]) {
    assert.throws(() => checkArtifactAge(dateBefore(30 * DAY), NOW, { ...exception, securityFixes }),
      /quarantine|exception|CVE/i, JSON.stringify(securityFixes));
  }
});

test("a one-day exception cannot use a moving version or unrelated advisory", () => {
  for (const version of [undefined, "latest", "stable", "156", "156.0.8078", "^156.0.8078.47"]) {
    assert.throws(() => checkArtifactAge(dateBefore(30 * DAY), NOW, { ...exception, version }), /quarantine|exception|exact.*version/i);
  }
  for (const advisory of [undefined, "", "http://chromereleases.googleblog.com/release",
    "https://example.com/release", "https://chromereleases.googleblog.com.evil.invalid/release"]) {
    assert.throws(() => checkArtifactAge(dateBefore(30 * DAY), NOW, { ...exception, advisory }), /quarantine|exception/i);
  }
});
