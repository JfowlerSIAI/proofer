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
 *      scripts, so this is only present after `npx --no-install puppeteer browsers install
 *      chrome`; absence is normal, not an error.
 *   3. A system install — google-chrome, chromium, or the macOS bundle.
 *
 * Nothing found is thrown, not fallen back on: a non-existent `executablePath`
 * reaches Puppeteer as an ENOENT from a spawn deep inside the launcher, which
 * reads like a Puppeteer bug rather than "install a browser".
 */
import fs from "fs";
import puppeteer from "puppeteer";

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
 * @returns {Promise<{ path: string, source: string }>}
 * @throws if no browser can be found — with the commands that would fix it.
 */
export async function resolveChrome() {
  const env = process.env.PROOFER_CHROME;
  if (env) {
    if (!fs.existsSync(env)) {
      throw new Error(`PROOFER_CHROME is set to ${env}, which does not exist.`);
    }
    return { path: env, source: "PROOFER_CHROME" };
  }

  let cft;
  try { cft = await puppeteer.executablePath(); } catch { /* not installed */ }
  if (cft && fs.existsSync(cft)) return { path: cft, source: "Chrome for Testing" };

  for (const candidate of SYSTEM_CANDIDATES) {
    if (fs.existsSync(candidate)) return { path: candidate, source: "system" };
  }

  throw new Error(
    "No Chrome found. Install the pinned build with\n" +
    "    cd test && npx --no-install puppeteer browsers install chrome\n" +
    "or point PROOFER_CHROME at an existing binary.",
  );
}

/** The path alone, for the common case. */
export const chromePath = async () => (await resolveChrome()).path;
