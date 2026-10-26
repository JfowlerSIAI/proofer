// Keep the optional encoder's offline/hash checks in the source-only battery.
// This suite needs only Python's standard library, not its model dependencies.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./tools/encoder-shim/security_test.py", import.meta.url));
const candidates = process.platform === "win32" ? ["python3", "python"] : ["python3"];
for (const command of candidates) {
  const probe = spawnSync(command, ["-c", "import sys; print(sys.version_info.major)"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT" || (process.platform === "win32" && probe.status === 9009)) continue;
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== "3") {
    if (probe.error) console.error(probe.error.message);
    console.error(`Cannot use ${command}: Python 3 is required for the encoder security suite.`);
    process.exit(1);
  }
  const run = spawnSync(command, ["-B", script], {
    stdio: "inherit", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (run.error) console.error(run.error.message);
  process.exit(run.error ? 1 : run.status ?? 1);
}
console.error("Python 3 is required for the encoder security suite; no model packages are needed.");
process.exit(1);
