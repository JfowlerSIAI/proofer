#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. Reruns E2 (the divergence sweep) of the prompt-cache
# study on one runtime.
#   ./run-e2.sh ollama [P1,P2,P3]      needs: ./serve.sh start ollama-cpu 11557 16-19 $RAW/ollama-11557-e2.log
#   ./run-e2.sh llama  [P1,P2,P3] [tag] [extra llama-server args...]
#       starts/stops its own llama-server on 11561, cores 20-23, with the flags
#       Ollama uses plus the extra args (e.g. tag minstep0 with
#       --checkpoint-min-step 0, a NON-default setting stock Ollama never passes)
# RAW defaults to the this checkout's gitignored test/harvested/cache-study.
set -euo pipefail
cd "$(dirname "$0")"
export RAW="${RAW:-$PWD/../harvested/cache-study}"
mode=${1:-}; prompts=${2:-P1,P2,P3}
case "$mode" in
  ollama)
    node e2-sweep.mjs --runtime ollama --port 11557 --threads 4 --log "$RAW/ollama-11557-e2.log" \
      --prompts "$prompts" --out "$RAW/e2-ollama-cpu.jsonl" >> "$RAW/e2-ollama-cpu.txt" 2>&1 ;;
  llama)
    tag=${3:-default}; shift 3 || shift $#
    extra="$*"
    out="$RAW/e2-llama-cpu.jsonl"; [ "$tag" = default ] || out="$RAW/e2-llama-cpu-$tag.jsonl"
    node e2-sweep.mjs --runtime llama --port 11561 --log "$RAW/llama-11561-e2.log" \
      --prompts "$prompts" --tag "$tag" --out "$out" \
      --restart "./serve.sh stop 11561 >/dev/null; ./serve.sh start llama-cpu 11561 20-23 $RAW/llama-11561-e2.log -t 4 $extra >/dev/null" \
      >> "${out%.jsonl}.txt" 2>&1
    ./serve.sh stop 11561 ;;
  *) echo "usage: run-e2.sh ollama|llama [prompts] [tag] [llama args]" >&2; exit 2 ;;
esac
echo "E2 $mode $prompts done"
