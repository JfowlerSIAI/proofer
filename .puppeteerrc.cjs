const path = require("node:path");
const { version } = require("./test/chrome-version.json");

module.exports = {
  cacheDirectory: path.join(__dirname, "test", ".cache", "puppeteer"),
  chrome: { version },
  "chrome-headless-shell": { skipDownload: true },
  firefox: { skipDownload: true },
};
