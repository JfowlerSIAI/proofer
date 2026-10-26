#!/usr/bin/env node
// Run the same deterministic groups used by CI without a package manager.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const groups = {
  source: [
    ["storage-security-test.mjs"],
    ["fixture-security-test.mjs"],
    ["encoder-security-test.mjs"],
    ["sanitizer-test.mjs"],
    ["sentence-split-test.mjs"],
    ["build-confusables.mjs", "--check"],
    ["sentence-guard-test.mjs"],
    ["sentence-typo-recall-test.mjs"],
    ["sentence-anchor-test.mjs"],
    ["sentence-settings-test.mjs"],
    ["sentence-request-bytes-test.mjs"],
    ["sentence-retry-test.mjs"],
    ["log-record-test.mjs"],
    ["log-latency-test.mjs"],
    ["sentence-retry-handler-test.mjs"],
    ["scoring-engine-test.mjs"],
    ["log-to-cases-test.mjs"],
    ["setup-check-test.mjs"],
    ["contributions-test.mjs"],
    ["sentence-evidence-test.mjs"],
    ["fixtures/verify-provenance.mjs"],
    ["privacy-policy-test.mjs"],
    ["package-test.mjs"],
  ],
  browser: [
    ["browser-security-test.mjs"],
    ["runtime-security-test.mjs"],
    ["editor-recipe-probe.mjs", "--nesting-only"],
    ["fixtures/verify.mjs"],
    ["sentence-typing-test.mjs"],
    ["sentence-provenance-test.mjs"],
    ["editor-bench-selfcheck.mjs"],
    ["popup-views-test.mjs"],
    ["welcome-flow-test.mjs"],
    ["popup-activation-test.mjs"],
    ["sentence-slate-test.mjs"],
    ["flash-highlight-probe.mjs"],
  ],
  e2e: [["sentence-e2e-test.mjs"]],
};

const args = process.argv.slice(2);
const group = args[0] || "source";
if (args.length > 1 || !Object.hasOwn(groups, group)) {
  console.error("Usage: node tools/test.mjs [source|browser|e2e]");
  process.exit(2);
}
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  console.error("Use Node.js 22.12 or later; Node.js 24 is recommended (see .nvmrc).");
  process.exit(2);
}

const env = { ...process.env };
if (group !== "e2e") {
  // A research shell can point at private corpora, alternate code, live sites,
  // disabled guards, or arbitrary output paths. The routine battery accepts
  // only the browser path and replay seed from that namespace.
  for (const name of Object.keys(env)) {
    if (name.startsWith("PROOFER_") && !["PROOFER_CHROME", "PROOFER_SEED"].includes(name)) {
      delete env[name];
    }
  }
  env.PROOFER_OLLAMA_URL = "http://127.0.0.1:1";
  env.PROOFER_SEED ||= "1";
} else {
  console.log("This group uses real Ollama at the extension's default loopback address and the pinned model.");
}

console.log(`Running ${groups[group].length} ${group} suites with Node ${process.versions.node}.`);
if (group === "browser") {
  console.log("Browser tests use local fixtures. For OS-enforced isolation on Linux, run this command inside a loopback-only network namespace (see CONTRIBUTING.md).");
  console.log("The setup suite needs 127.0.0.1:11434 free and refuses to use an existing Ollama server.");
}
for (const command of groups[group]) {
  console.log(`\n> node ${command.join(" ")}`);
  const run = spawnSync(process.execPath, command, {
    cwd: path.join(root, "test"), env, stdio: "inherit",
  });
  if (run.error || run.status !== 0) {
    console.error(`\n${command[0]} did not pass${run.signal ? ` (${run.signal})` : ""}.`);
    if (run.error) console.error(run.error.message);
    if (run.status === 77) console.error("A skipped suite is not a passing gate.");
    process.exit(run.status && run.status !== 77 ? run.status : 1);
  }
}
console.log(`\nAll ${groups[group].length} ${group} suites passed.`);
