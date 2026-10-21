#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. The second-pass runs made after GPT-6 Astra
# checkpoint 2 (2026-09-25), in the order they were made:
#   0. relabel-switch-replay.mjs on e3-cpu4.jsonl (run once, by hand, before
#      this script: the first switch protocol's rows become switch-replay)
#   1. E1 replay set on both runtimes          -> e1c-*.jsonl
#   2. E3 corrected switch on cpu4             -> appended to e3-cpu4.jsonl
#   3. E3 switch + retry on cpu8 and the iGPU  -> appended to e3-cpu8/igpu.jsonl
set -euo pipefail
cd "$(dirname "$0")"
export RAW="${RAW:-$PWD/../harvested/cache-study}"
if [ "${1:-}" != skip-e1 ]; then
  ./serve.sh start ollama-cpu 11556 8-15 "$RAW/ollama-11556-e1.log"
  for _ in $(seq 1 50); do curl -sf 127.0.0.1:11556/api/version >/dev/null && break; sleep 0.2; done
  ./run-e1.sh replay
  ./serve.sh stop 11556
fi
./run-e3.sh cpu4 --scenarios switch
./run-e3.sh cpu8 --scenarios switch,retry
./run-e3.sh igpu --scenarios switch,retry
echo "second pass done"
