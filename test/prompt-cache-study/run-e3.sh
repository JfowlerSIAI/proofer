#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. Reruns E3 (layouts on realistic typing, timed) of the
# prompt-cache study on one backend. Each backend gets its own private Ollama,
# pinned with taskset, started here and stopped here by its recorded PID.
#   ./run-e3.sh cpu4   Ollama CPU-only on P-cores 4-7, num_thread 4, port 11562
#   ./run-e3.sh cpu8   Ollama CPU-only on P-cores 0-7, num_thread 8, port 11563
#   ./run-e3.sh igpu   Ollama on the Intel ARL iGPU (Vulkan), P-cores 4-7,
#                      num_thread 4, port 11564
# Extra args are passed to e3-typing.mjs (e.g. --scenarios main).
# Needs $RAW/e3-messages.json (node e3-messages.mjs).
set -euo pipefail
cd "$(dirname "$0")"
export RAW="${RAW:-$PWD/../harvested/cache-study}"
b=${1:-}; shift || true
case "$b" in
  cpu4) kind=ollama-cpu;  port=11562; cpus=4-7; threads=4; gpu=(); hide=(GGML_VK_VISIBLE_DEVICES=-1 OLLAMA_VULKAN=0) ;;
  cpu8) kind=ollama-cpu;  port=11563; cpus=0-7; threads=8; gpu=(); hide=(GGML_VK_VISIBLE_DEVICES=-1 OLLAMA_VULKAN=0) ;;
  igpu) kind=ollama-igpu; port=11564; cpus=4-7; threads=4; gpu=(--gpu); hide=() ;;
  *) echo "usage: run-e3.sh cpu4|cpu8|igpu [e3-typing args]" >&2; exit 2 ;;
esac
log="$RAW/ollama-$port-e3-$b.log"
{ echo "== $b start $(date -Is)"; uptime; } >> "$RAW/e3-$b.txt"
# A CPU run hides Vulkan as well as CUDA (TESTING.md §29): serve.sh's ollama-cpu
# kind sets CUDA_VISIBLE_DEVICES=-1 only. (Added for the 2026-10-02 L2-conv trial.)
./serve.sh start "$kind" "$port" "$cpus" "$log" "${hide[@]}"
for _ in $(seq 1 50); do curl -sf "127.0.0.1:$port/api/version" >/dev/null && break; sleep 0.2; done
# record /api/ps size_vram partway in (a CPU run counts only at size_vram 0)
( sleep 90; echo "api/ps at +90s: $(curl -s "127.0.0.1:$port/api/ps")" >> "$RAW/e3-$b.txt" ) &
node e3-typing.mjs --backend "$b" --port "$port" --log "$log" --out "$RAW/e3-$b.jsonl" \
  --threads "$threads" "${gpu[@]}" "$@" >> "$RAW/e3-$b.txt" 2>&1 || echo "e3-typing exited $?" >> "$RAW/e3-$b.txt"
./serve.sh stop "$port"
{ echo "== $b end $(date -Is)"; uptime; } >> "$RAW/e3-$b.txt"
