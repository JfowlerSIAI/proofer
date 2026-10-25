#!/usr/bin/env node
// Exact Chrome build, official download origin, and the SIAI release-age gate.
// The exception is recorded for this specific browser security fix, never for
// npm dependencies or a moving stable/latest alias.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
import { Browser, detectBrowserPlatform, getDownloadUrl, install } from "@puppeteer/browsers";

const pin = JSON.parse(fs.readFileSync(new URL("../chrome-version.json", import.meta.url), "utf8"));
const OFFICIAL = "https://storage.googleapis.com/chrome-for-testing-public";

export function checkArtifactAge(lastModified, now = Date.now(), policy = pin) {
  const days = policy.quarantineDays;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(policy.version)) throw new Error("Chrome must have an exact four-part version.");
  if (days !== 10 && !(days === 1
      && Array.isArray(policy.securityFixes) && policy.securityFixes.length
      && policy.securityFixes.every((cve) => typeof cve === "string" && /^CVE-\d{4}-\d{4,}$/.test(cve))
      && typeof policy.advisory === "string" && policy.advisory.startsWith("https://chromereleases.googleblog.com/"))) {
    throw new Error("Chrome needs a 10-day quarantine or a documented, exact-version CVE exception.");
  }
  const published = Date.parse(lastModified);
  if (!Number.isFinite(published) || now - published < days * 86400000) {
    throw new Error(`Chrome ${policy.version} has no eligible publication date (${lastModified || "missing"}); requires ${days} full day(s).`);
  }
}

export async function installChrome() {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error("Unsupported Chrome for Testing platform.");
  const configuration = await puppeteer.configuration();
  if (configuration.chrome?.version !== pin.version) {
    throw new Error("Puppeteer browser configuration differs from chrome-version.json; remove the version override.");
  }
  const url = await getDownloadUrl(Browser.CHROME, platform, pin.version, OFFICIAL);
  if (url.origin !== new URL(OFFICIAL).origin || !url.pathname.startsWith(`/chrome-for-testing-public/${pin.version}/`)) {
    throw new Error("Chrome download escaped the pinned official artifact location.");
  }
  const response = await fetch(url, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Chrome artifact check failed: HTTP ${response.status}`);
  checkArtifactAge(response.headers.get("last-modified"));
  console.log(`Installing reviewed Chrome ${pin.version}; artifact date ${response.headers.get("last-modified")}.`);
  const browser = await install({
    browser: Browser.CHROME, buildId: pin.version, platform,
    cacheDir: configuration.cacheDirectory, baseUrl: OFFICIAL,
  });
  console.log(browser.executablePath);
  return browser;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await installChrome();
}
