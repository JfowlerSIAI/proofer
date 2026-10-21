#!/usr/bin/env bash
# Repeat the production suites N times per model to measure run-to-run variance.
#
# Every headline number in TESTING.md came from a single pass. At temperature
# 0.1 the model is near-deterministic but not deterministic, and qwen3.5's core
# score was observed moving by one case between identical runs — the same
# magnitude as the LFM-vs-qwen gap. This quantifies that.
#
#   ./repeat-study.sh [runs]
set -u
RUNS="${1:-5}"
OUT="results/repeat-study.tsv"
: > "$OUT"

for MODEL in "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M" "qwen3.5:9b"; do
  for i in $(seq 1 "$RUNS"); do
    for SUITE in proofer-test proofer-holdout; do
      LINE=$(PROOFER_MODEL="$MODEL" node "$SUITE.mjs" 2>/dev/null | grep -E "^PASS:" | head -1)
      PASS=$(echo "$LINE" | sed -E 's#PASS: +([0-9]+)/([0-9]+).*#\1#')
      TOT=$(echo "$LINE" | sed -E 's#PASS: +([0-9]+)/([0-9]+).*#\2#')
      printf '%s\t%s\t%s\t%s\t%s\n' "$MODEL" "$SUITE" "$i" "$PASS" "$TOT" | tee -a "$OUT"
    done
  done
done
echo "wrote $OUT"
