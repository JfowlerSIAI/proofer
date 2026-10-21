#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. Reruns E4 (the frozen-benchmark screen per layout) of
# the prompt-cache study against a private GPU Ollama on 11558:
#   ./serve.sh start ollama-gpu 11558 12-15 $RAW/ollama-11558-e4.log
#   ./run-e4.sh <tag> <limit|all> <layout...>
# writes $RAW/e4-<tag>-<layout>.jsonl (teacher-pass row schema), then converts
# each to the scorer's run-file with e4-runfile.mjs (benchrun-to-runfile.mjs's
# join with the artifact directory as a parameter).
set -euo pipefail
cd "$(dirname "$0")"
export RAW="${RAW:-$PWD/../harvested/cache-study}"
tag=$1; limit=$2; shift 2
lim=(); [ "$limit" = all ] || lim=(--limit "$limit")
for L in "$@"; do
  node e4-bench.mjs --layout "$L" --port 11558 --out "$RAW/e4-$tag-$L.jsonl" "${lim[@]}" --concurrency 2
  if [ "$limit" = all ]; then
    node e4-runfile.mjs --in "$RAW/e4-$tag-$L.jsonl" --out "$RAW/runfile-$tag-$L.jsonl"
  fi
done
