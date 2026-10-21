#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. Creates a trial model in a PRIVATE Ollama store for
# the 2026-10-02 L2-conv training trial, through a private server on a spare
# port -- never the owner's daemon on 11434, never the owner's store.
#
#   OLLAMA_MODELS=<private store> ./l2conv-create.sh <port> <tag> <gguf> <log>
#
# Starts serve.sh's ollama-gpu kind on <port> with that store (the server must
# not already be running there), writes a Modelfile with the pilot's shipping
# parameters (temperature 0.1, top_p 0.8, top_k 20, repeat_penalty 1.0,
# num_ctx 2048 -- pilot-train.py's Modelfile), `ollama create`s it with the
# 0.32.12 client, then prints /api/show's parameters and the sha256 of the
# template it reports, which must equal the pinned model's templateSha256
# (background.js PINNED_MODEL: the base model's chat_template.jinja). The
# server is LEFT RUNNING for the benchmark; stop it with serve.sh stop <port>.
set -euo pipefail
cd "$(dirname "$0")"
port=$1; tag=$2; gguf=$3; log=$4
[ -n "${OLLAMA_MODELS:-}" ] || { echo "set OLLAMA_MODELS to the private store" >&2; exit 2; }
[ "$OLLAMA_MODELS" != /usr/share/ollama/.ollama/models ] || { echo "refusing the owner's store" >&2; exit 2; }
[ -f "$gguf" ] || { echo "no such gguf: $gguf" >&2; exit 2; }
OLLAMA_ROOT=${OLLAMA_ROOT:-/opt/ollama-v0.32.12}
if ! curl -sf "127.0.0.1:$port/api/version" >/dev/null 2>&1; then
  OLLAMA_MODELS="$OLLAMA_MODELS" ./serve.sh start ollama-gpu "$port" 12-15 "$log"
  for _ in $(seq 1 100); do curl -sf "127.0.0.1:$port/api/version" >/dev/null && break; sleep 0.2; done
fi
mf=$(mktemp)
printf 'FROM %s\nPARAMETER temperature 0.1\nPARAMETER top_p 0.8\nPARAMETER top_k 20\nPARAMETER repeat_penalty 1.0\nPARAMETER num_ctx 2048\n' "$gguf" >"$mf"
OLLAMA_HOST=127.0.0.1:$port "$OLLAMA_ROOT/bin/ollama" create "$tag" -f "$mf" 2>&1 | tail -2
rm -f "$mf"
show=$(curl -s "127.0.0.1:$port/api/show" -d "{\"model\":\"$tag\"}")
echo "$show" | python3 -c '
import json,sys,hashlib
d=json.load(sys.stdin)
print("parameters:", d.get("parameters","").replace("\n","; "))
t=d.get("template","")
print("template sha256:", hashlib.sha256(t.encode()).hexdigest(), "chars", len(t))
print("digest:", d.get("modelinfo",{}).get("general.file_type"), "arch", d.get("details",{}).get("family"), d.get("details",{}).get("quantization_level"))
'
echo "created $tag on 127.0.0.1:$port (store $OLLAMA_MODELS)"
