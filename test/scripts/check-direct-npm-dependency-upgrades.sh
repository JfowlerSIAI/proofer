#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/check-direct-npm-dependency-upgrades.sh

Check pinned direct npm dependencies in package.json against the latest eligible
registry releases older than 10 days. This script does not modify any files.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

while (($# > 0)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for command_name in node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 127
  fi
done

cd "$repo_root"

if [[ ! -f package.json ]]; then
  echo "package.json not found in $repo_root" >&2
  exit 1
fi

node - "$repo_root/package.json" <<'JS'
const fs = require("fs");
const https = require("https");

const packageJsonPath = process.argv[2];
const USER_AGENT = "npm-direct-upgrade-checker";
const SECTION_NAMES = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const EXACT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const LOCAL_PREFIXES = ["workspace:", "file:", "link:"];
const QUARANTINE_DAYS = 10;

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(`Registry request failed for ${url}: HTTP ${response.statusCode}`)
          );
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Registry request failed for ${url}: invalid JSON`));
          }
        });
      }
    );

    request.setTimeout(30000, () => {
      request.destroy(new Error(`Registry request timed out for ${url}`));
    });
    request.on("error", (error) => {
      reject(new Error(`Registry request failed for ${url}: ${error.message}`));
    });
  });
}

function parseExactSemver(value) {
  const match = EXACT_SEMVER_RE.exec(value);
  if (!match) {
    return null;
  }

  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function compareSemver(left, right) {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  if (left.patch !== right.patch) {
    return left.patch - right.patch;
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === null) {
    return 1;
  }
  if (right.prerelease === null) {
    return -1;
  }

  return left.prerelease.localeCompare(right.prerelease);
}

function likelyBreakingChange(currentVersion, targetVersion) {
  const current = parseExactSemver(currentVersion);
  const target = parseExactSemver(targetVersion);
  if (!current || !target) {
    return false;
  }

  if (current.major !== target.major) {
    return true;
  }

  return current.major === 0 && current.minor !== target.minor;
}

async function latestEligibleRelease(packageName, cutoffMs) {
  const encodedName = encodeURIComponent(packageName);
  const url = `https://registry.npmjs.org/${encodedName}`;
  const data = await requestJson(url);
  const versions = data.versions ?? {};
  const times = data.time ?? {};
  const candidates = [];

  for (const [version, metadata] of Object.entries(versions)) {
    const parsed = parseExactSemver(version);
    if (!parsed || parsed.prerelease !== null) {
      continue;
    }

    if (metadata && metadata.deprecated) {
      continue;
    }

    const published = times[version];
    if (!published) {
      continue;
    }

    const publishedMs = Date.parse(published);
    if (!Number.isFinite(publishedMs) || publishedMs >= cutoffMs) {
      continue;
    }

    candidates.push({
      version,
      parsed,
      releaseDate: new Date(publishedMs).toISOString().slice(0, 10),
    });
  }

  if (candidates.length === 0) {
    throw new Error(
      `No eligible stable non-deprecated release older than ${QUARANTINE_DAYS} days found for ${packageName}`
    );
  }

  candidates.sort((left, right) => compareSemver(left.parsed, right.parsed));
  return candidates[candidates.length - 1];
}

async function main() {
  const cutoffMs = Date.now() - QUARANTINE_DAYS * 24 * 60 * 60 * 1000;
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const cache = new Map();
  const candidates = [];
  const warnings = [];
  const skipped = [];
  const violations = [];

  for (const sectionName of SECTION_NAMES) {
    const section = packageJson[sectionName];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      continue;
    }

    for (const [packageName, spec] of Object.entries(section)) {
      if (typeof spec !== "string") {
        violations.push(`${sectionName}: ${packageName} uses a non-string specifier`);
        continue;
      }

      if (LOCAL_PREFIXES.some((prefix) => spec.startsWith(prefix))) {
        skipped.push(`${sectionName}: ${packageName} (${spec})`);
        continue;
      }

      const current = parseExactSemver(spec);
      if (!current) {
        violations.push(
          `${sectionName}: ${packageName} must use an exact pinned registry version, found ${spec}`
        );
        continue;
      }

      if (!cache.has(packageName)) {
        cache.set(packageName, await latestEligibleRelease(packageName, cutoffMs));
      }

      const latest = cache.get(packageName);
      if (latest.version === spec) {
        continue;
      }

      const lineText = `${sectionName}: ${packageName} ${spec} -> ${latest.version} (${latest.releaseDate})`;
      candidates.push(lineText);
      if (likelyBreakingChange(spec, latest.version)) {
        warnings.push(lineText);
      }
    }
  }

  if (violations.length > 0) {
    console.error("package.json contains unsupported dependency specifiers:");
    for (const item of violations) {
      console.error(`  ${item}`);
    }
    console.error("Use exact pinned registry versions before running this script.");
    process.exit(2);
  }

  if (candidates.length > 0) {
    console.log("Direct npm dependency upgrade candidates:");
    for (const item of candidates) {
      console.log(`  ${item}`);
    }
    if (warnings.length > 0) {
      console.log("");
      console.log("Possible breaking changes detected:");
      for (const item of warnings) {
        console.log(`  ${item}`);
      }
      console.log("Do not apply these upgrades without first reviewing upstream release notes or migration guides.");
      console.log("If in doubt, skip the major bump and only apply minor/patch upgrades.");
    }
  } else {
    console.log("package.json already matches the latest eligible direct dependency versions");
  }

  if (skipped.length > 0) {
    console.log("");
    console.log("Skipped local/workspace dependency specs:");
    for (const item of skipped) {
      console.log(`  ${item}`);
    }
  }

  console.log("");
  console.log("No files were changed.");
  if (candidates.length > 0) {
    console.log("Review the proposed changes, update package.json manually, then run npm install --package-lock-only.");
    console.log("After that, run npm audit.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
JS
