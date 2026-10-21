#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. The runs made after the first E3 pass, in the order
# they were made (2026-09-25):
#   1. E3 on the iGPU, after the first iGPU attempt was found running on the
#      RTX 4090 through Vulkan and discarded (see serve.sh);
#   2. E3 on cpu4 for L2-conv, the layout added after cpu4's main run had
#      started (its rows are appended to e3-cpu4.jsonl with the rest);
#   3. the E1 addendum (L2-conv and new-document scenarios, e1b-*.jsonl).
set -euo pipefail
cd "$(dirname "$0")"
export RAW="${RAW:-$PWD/../harvested/cache-study}"
./run-e3.sh igpu
./run-e3.sh cpu4 --layouts L2-conv --extra-layouts L2-conv
./serve.sh start ollama-cpu 11556 8-15 "$RAW/ollama-11556-e1.log"
for _ in $(seq 1 50); do curl -sf 127.0.0.1:11556/api/version >/dev/null && break; sleep 0.2; done
./run-e1.sh addendum
./serve.sh stop 11556
echo "late runs done"
