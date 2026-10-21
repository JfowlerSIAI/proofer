#!/usr/bin/env bash
# EXPERIMENT, NOT A GATE. Part of the 2026-09-24 prompt-cache study
# (see TESTING.md §29).
#
# Starts or stops a PRIVATE runtime on a spare port for the study. It never
# touches the owner's live Ollama on 127.0.0.1:11434, and it stops only the PID
# it recorded when it started -- never a pattern match (`pkill -f <port>` once
# matched and killed the calling shell).
#
#   serve.sh start <kind> <port> <cpus> <log> [extra env...]
#   serve.sh stop  <port>
#   serve.sh status
#
#   kind:  ollama-cpu    stock Ollama 0.32.12, CPU only (CUDA_VISIBLE_DEVICES=-1)
#          ollama-igpu   stock Ollama 0.32.12, Intel iGPU through Vulkan
#                        (OLLAMA_VULKAN=1 OLLAMA_IGPU_ENABLE=1; stock Ollama
#                        otherwise logs "dropping integrated GPU")
#          ollama-gpu    stock Ollama 0.32.12, default device discovery (the 4090)
#          llama-cpu     the llama-server binary BUNDLED with that Ollama release
#                        (llama.cpp 0b1bad14f), run directly on the same GGUF blob,
#                        with the flags Ollama itself passes (see ARGS below);
#                        extra args after <log> are appended to its command line
#   cpus:  a taskset list, e.g. 4-7. The runtime and every thread it spawns
#          inherit it.
#
# Every Ollama instance is pointed at the shared model store (or OLLAMA_MODELS) with
# OLLAMA_NOPRUNE=1: without it a second server can prune blobs it does not
# know about. OLLAMA_DEBUG=1 and LLAMA_SERVER_SLOTS_DEBUG=1 make the bundled
# llama-server log its per-request cache decisions (cached n_tokens,
# checkpoint restores, the old/new tokens around the first mismatch), which is
# the reuse instrument (Ollama's API reports only whole-prompt counts).
set -euo pipefail

# OLLAMA_ROOT selects another release's tree (bin/ollama, lib/ollama/llama-server);
# the study was taken on 0.32.12 and its 2026-10-01 rerun on 0.34.3.
OLLAMA_ROOT=${OLLAMA_ROOT:-/opt/ollama-v0.32.12}
OLLAMA_BIN=$OLLAMA_ROOT/bin/ollama
LLAMA_SERVER=$OLLAMA_ROOT/lib/ollama/llama-server
# OLLAMA_MODELS selects another store: the 2026-10-02 L2-conv training trial
# creates its models in a PRIVATE store so the owner's is never written to.
MODELS=${OLLAMA_MODELS:-/usr/share/ollama/.ollama/models}
# proofer-pilot-q4:v1, manifest digest 43baf5b5631c...
GGUF=$MODELS/blobs/sha256-1336572c9d9f4bb7f271ca47fb347c7383018009e3493b0acc2251c22f43fd03
# Keep PID records in a per-user runtime/temp directory unless explicitly set.
PIDDIR=${PROOFER_CACHE_STUDY_PIDDIR:-${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/proofer-prompt-cache-study-${UID}}
mkdir -p "$PIDDIR"

cmd=${1:-}
case "$cmd" in
  start)
    kind=$2; port=$3; cpus=$4; log=$5; shift 5
    [ "$port" = 11434 ] && { echo "refusing: 11434 is the owner's live Ollama" >&2; exit 2; }
    if [ -f "$PIDDIR/$port" ] && kill -0 "$(cat "$PIDDIR/$port")" 2>/dev/null; then
      echo "port $port already has recorded pid $(cat "$PIDDIR/$port")" >&2; exit 2
    fi
    common=(OLLAMA_HOST=127.0.0.1:$port OLLAMA_MODELS=$MODELS OLLAMA_NOPRUNE=1
            OLLAMA_DEBUG=1 LLAMA_SERVER_SLOTS_DEBUG=1 OLLAMA_NO_CLOUD=1)
    case "$kind" in
      ollama-cpu)  env "${common[@]}" CUDA_VISIBLE_DEVICES=-1 "$@" taskset -c "$cpus" "$OLLAMA_BIN" serve >>"$log" 2>&1 & ;;
      # GGML_VK_VISIBLE_DEVICES=0: on this machine Vulkan also enumerates the
      # RTX 4090, and llama-server orders discrete GPUs first, so without it
      # the "iGPU" run silently ran on the 4090 through Vulkan (caught on
      # 2026-09-25 from the log's "using device Vulkan0 (NVIDIA ...)").
      # Index 0 is the Intel ARL iGPU in the raw Vulkan enumeration.
      ollama-igpu) env "${common[@]}" CUDA_VISIBLE_DEVICES=-1 OLLAMA_VULKAN=1 OLLAMA_IGPU_ENABLE=1 GGML_VK_VISIBLE_DEVICES=0 "$@" taskset -c "$cpus" "$OLLAMA_BIN" serve >>"$log" 2>&1 & ;;
      ollama-gpu)  env "${common[@]}" "$@" taskset -c "$cpus" "$OLLAMA_BIN" serve >>"$log" 2>&1 & ;;
      llama-cpu)
        # The flags Ollama 0.32.12 passes to its bundled llama-server for this
        # model on CPU (copied from its "starting llama-server" log line:
        # ... -c 2048 -np 1 --log-verbosity 4 --no-log-prefix
        # --no-log-timestamps --load-mode none --flash-attn auto -b 512 -ub 512
        # -ngl 0 -t 8 --context-shift --keep 4), plus the CPU pinning. Pass the
        # thread count as an extra arg (-t N). Extra args ($@) are appended so
        # a run can vary cache settings (--checkpoint-min-step, --cache-ram,
        # --ctx-checkpoints) on purpose; the defaults of this build are 8192,
        # 8192 MiB and 32.
        env LLAMA_SERVER_SLOTS_DEBUG=1 CUDA_VISIBLE_DEVICES=-1 taskset -c "$cpus" "$LLAMA_SERVER" \
          --model "$GGUF" --port "$port" --host 127.0.0.1 --no-webui --offline \
          -c 2048 -np 1 --log-verbosity 4 --no-log-prefix --no-log-timestamps \
          --load-mode none --flash-attn auto -b 512 -ub 512 -ngl 0 \
          --context-shift --keep 4 \
          "$@" >>"$log" 2>&1 & ;;
      *) echo "unknown kind $kind" >&2; exit 2 ;;
    esac
    pid=$!
    echo "$pid" >"$PIDDIR/$port"
    echo "started $kind on 127.0.0.1:$port pid=$pid cpus=$cpus log=$log"
    ;;
  stop)
    port=$2
    f="$PIDDIR/$port"
    [ -f "$f" ] || { echo "no recorded pid for port $port"; exit 0; }
    pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then
      # children by PARENT pid (Ollama's llama-server runner), never by pattern
      kids=$(pgrep -P "$pid" || true)
      kill "$pid"
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -0 "$pid" 2>/dev/null && { echo "pid $pid still alive after SIGTERM; sending SIGKILL"; kill -9 "$pid"; }
      for k in $kids; do
        for _ in $(seq 1 25); do kill -0 "$k" 2>/dev/null || break; sleep 0.2; done
        kill -0 "$k" 2>/dev/null && { echo "child $k survived its parent; SIGTERM"; kill "$k"; }
      done
      echo "stopped pid $pid (port $port)${kids:+, children: $kids}"
    else
      echo "pid $pid (port $port) was not running"
    fi
    rm -f "$f"
    ;;
  status)
    for f in "$PIDDIR"/*; do
      [ -e "$f" ] || continue
      p=$(cat "$f"); if kill -0 "$p" 2>/dev/null; then echo "port $(basename "$f") pid $p RUNNING"; else echo "port $(basename "$f") pid $p dead"; fi
    done
    ;;
  *) sed -n 2,30p "$0"; exit 2 ;;
esac
