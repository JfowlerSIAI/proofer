#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. Reruns E1 of the prompt-cache study on both runtimes.
#   RAW=<dir> ./run-e1.sh [original|addendum|replay]
#     original  the 18 original scenarios            -> e1-*.jsonl
#     addendum  the 6 added with L2-conv             -> e1b-*.jsonl
#     replay    the 6 identical-re-send scenarios    -> e1c-*.jsonl
#   The three sets are disjoint, so the archive is 18 + 6 + 6 rows per runtime.
# (default RAW: the this checkout's gitignored test/harvested/cache-study)
# Needs the private Ollama already started on 11556:
#   ./serve.sh start ollama-cpu 11556 8-15 $RAW/ollama-11556-e1.log
# The standalone llama-server on 11560 is (re)started by e1-reuse.mjs itself.
set -euo pipefail
cd "$(dirname "$0")"
export RAW="${RAW:-$PWD/../harvested/cache-study}"
set_=${1:-original}
case "$set_" in
  original) pre=e1 ;;
  addendum) pre=e1b ;;
  replay)   pre=e1c ;;
  *) echo "usage: run-e1.sh [original|addendum|replay]" >&2; exit 2 ;;
esac
node e1-reuse.mjs --runtime ollama --port 11556 --log "$RAW/ollama-11556-e1.log" \
  --set "$set_" --out "$RAW/$pre-ollama-cpu.jsonl" > "$RAW/$pre-ollama-cpu.txt" 2>&1
node e1-reuse.mjs --runtime llama --port 11560 --log "$RAW/llama-11560-e1.log" \
  --set "$set_" --out "$RAW/$pre-llama-cpu.jsonl" \
  --restart "./serve.sh stop 11560 >/dev/null; ./serve.sh start llama-cpu 11560 8-15 $RAW/llama-11560-e1.log -t 8 >/dev/null" \
  > "$RAW/$pre-llama-cpu.txt" 2>&1
./serve.sh stop 11560
echo "E1 $pre done"
