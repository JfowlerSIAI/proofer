/**
 * Which Chrome the browser suites run against — one answer, in one place.
 *
 * Four suites used to decide this for themselves and two of them decided it by
 * hard-coding `/usr/bin/google-chrome`. That path is a Debian/Ubuntu branded
 * install: absent on macOS, absent on a Chromium-only box, absent in most CI
 * images, and — since branded Chrome 137 silently ignores `--load-extension` —
 * the *wrong* choice on the machines where it does exist.
 *
 * The order is deliberate:
 *
 *   1. `PROOFER_CHROME`         — an explicit override always wins.
 *   2. Puppeteer's Chrome for Testing — the pinned build, and the only one that
 *      still honours `--load-extension`. `test/.npmrc` disables lifecycle
 *      scripts, so this is only present after `node scripts/install-chrome.mjs`
 *      from test/; absence is normal, not an error.
 *   3. A system install — google-chrome, chromium, or the macOS bundle.
 *
 * Nothing found is thrown, not fallen back on: a non-existent `executablePath`
 * reaches Puppeteer as an ENOENT from a spawn deep inside the launcher, which
 * reads like a Puppeteer bug rather than "install a browser".
 */
import fs from "fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer";

const { minimumVersion } = JSON.parse(fs.readFileSync(new URL("../chrome-version.json", import.meta.url), "utf8"));
// Puppeteer 25 made this asynchronous. Resolve once during ESM initialization
// so the existing synchronous resolver remains usable by all harnesses.
let cft;
try { cft = await puppeteer.executablePath(); } catch { /* not installed */ }
const checked = new Map();

export function browserVersionAllowed(version, minimum = minimumVersion) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) return false;
  const actual = version.split(".").map(Number), floor = minimum.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if (actual[i] !== floor[i]) return actual[i] > floor[i];
  }
  return true;
}

export function checkedChrome(executablePath, source) {
  if (!checked.has(executablePath)) {
    let output;
    try {
      // Chrome 156 handles --version only on POSIX. Read the Windows PE
      // metadata without launching the browser; pass the path as data, never
      // splice it into PowerShell source (paths may contain quotes or spaces).
      output = process.platform === "win32"
        ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          '$ErrorActionPreference = "Stop"; [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:PROOFER_VERSION_BINARY).ProductVersion'],
          { encoding: "utf8", timeout: 10000, windowsHide: true,
            env: { ...process.env, PROOFER_VERSION_BINARY: path.resolve(executablePath) } })
        : execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 10000 });
    }
    catch { throw new Error(`Cannot verify browser version: ${executablePath}`); }
    const version = process.platform === "win32"
      ? output.trim().match(/^(\d+\.\d+\.\d+\.\d+)(?:\s|$)/)?.[1]
      : output.match(/(?:Chrome(?: for Testing)?|Chromium|Brave Browser)\s+(\d+\.\d+\.\d+\.\d+)/)?.[1];
    if (!version || !browserVersionAllowed(version)) {
      throw new Error(`Browser ${version || "unknown"} is below the reviewed security floor ${minimumVersion}: ${executablePath}. Run cd test && node scripts/install-chrome.mjs.`);
    }
    checked.set(executablePath, version);
  }
  return { path: executablePath, source, version: checked.get(executablePath) };
}

const SYSTEM_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/**
 * @returns {Promise<{ path: string, source: string, version: string }>}
 * @throws if no browser can be found — with the commands that would fix it.
 */
export async function resolveChrome() {
  const env = process.env.PROOFER_CHROME;
  if (env) {
    if (!fs.existsSync(env)) {
      throw new Error(`PROOFER_CHROME is set to ${env}, which does not exist.`);
    }
    return checkedChrome(env, "PROOFER_CHROME");
  }

  if (cft && fs.existsSync(cft)) return checkedChrome(cft, "Chrome for Testing");

  for (const candidate of SYSTEM_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      try { return checkedChrome(candidate, "system"); } catch { /* try another current browser */ }
    }
  }

  throw new Error(
    "No Chrome found. Install the pinned build with\n" +
    "    cd test && node scripts/install-chrome.mjs\n" +
    "or point PROOFER_CHROME at an existing binary.",
  );
}

/** The path alone, for the common case. */
export const chromePath = async () => (await resolveChrome()).path;
