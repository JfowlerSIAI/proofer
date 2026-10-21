#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "docker compose is required (docker compose or docker-compose)." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required." >&2
  exit 1
fi

echo "Starting services..."
"${COMPOSE[@]}" up -d

OLLAMA_URL="http://127.0.0.1:11434"

echo "Waiting for Ollama..."
for _ in $(seq 1 120); do
  if curl -fsS "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
  echo "Ollama did not become ready at $OLLAMA_URL." >&2
  exit 1
fi

# The extension handles Origin access with its own scoped loopback rule.
# No Ollama allowlist change or legacy-origin probe is needed.

# The model is pinned in background.js (PINNED_MODEL, tag and digest),
# and read from there so the two cannot disagree again -- they did
# once: setup pulled LFM2.5 while the extension requested qwen3.5:9b, so a fresh
# install followed the documented steps and then asked for a model that was not
# there. The tag is mutable and the digest is the pin, so the pull is checked.
MODEL="$(sed -n '/^const PINNED_MODEL = {/,/^};/s/^ *tag: "\([^"]*\)".*/\1/p' background.js)"
DIGEST="$(sed -n '/^const PINNED_MODEL = {/,/^};/s/^ *digest: "\([0-9a-f]*\)".*/\1/p' background.js)"
if [ -z "$MODEL" ] || [ -z "$DIGEST" ]; then
  echo "Could not read PINNED_MODEL from background.js." >&2
  exit 1
fi
echo "Pulling Proofer's model ($MODEL, ~1.7 GB)..."
if ! "${COMPOSE[@]}" exec -T ollama ollama pull "$MODEL"; then
  echo "" >&2
  echo "The published pull of $MODEL failed. Check connectivity and retry ./setup.sh." >&2
  echo "A local build is not an accepted substitute for this build's pin." >&2
  exit 1
fi
if ! INVENTORY="$(curl -fsS "$OLLAMA_URL/api/tags")"; then
  echo "Could not verify $MODEL: the model inventory could not be read. Check Ollama and retry ./setup.sh." >&2
  exit 1
fi
# Keep the name/model mapping and digest normalization in agreement with
# installedModelDigest in background.js. Another tag holding the pin is not proof.
node -e '
const [tag, expectedDigest] = process.argv.slice(1);
let data;
try {
  data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!data || !Array.isArray(data.models)) throw new Error("tags-malformed");
} catch {
  console.error(`Could not verify ${tag}: the model inventory is not usable. Check Ollama and retry ./setup.sh.`);
  process.exit(1);
}
const byTag = new Map();
for (const m of data.models) {
  const d = m && typeof m.digest === "string" ? m.digest.replace(/^sha256[:-]/, "") : null;
  if (!d) continue;
  if (typeof m.name === "string") byTag.set(m.name, d);
  if (typeof m.model === "string") byTag.set(m.model, d);
}
const want = tag.includes(":") ? tag : `${tag}:latest`;
if (!(byTag.get(want) === expectedDigest)) {
  console.error(`${tag} is missing or its digest is not the one this build pins (${expectedDigest}).`);
  console.error("Proofer will not use it. Check the published model and retry ./setup.sh.");
  process.exit(1);
}
' "$MODEL" "$DIGEST" <<< "$INVENTORY"

echo ""
echo "Ollama: http://localhost:11434"
