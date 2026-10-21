# Encoder shim — LFM2.5-Encoder-350M-Spellchecker through the Proofer suites

Serves an Ollama-compatible `/api/chat` on `127.0.0.1:11500` backed by
LiquidAI's GECToR-style spellchecker encoder, so the sentence-mode LLM suites
(`sentence-owner-bench.mjs`, `sentence-live-test.mjs`, `sentence-multi-typo-test.mjs`,
`sentence-context-test.mjs`) can score it unmodified. Built 2026-08-20 for the
optional encoder baseline study; its private run artifacts are
`test/harvested/bench-{random,error}-holdout-encoder.jsonl`.

## Model weights (not in this repo)

`~/models/LFM2.5-Encoder-350M-Spellchecker/` — the full HF repo
`LiquidAI/LFM2.5-Encoder-350M-Spellchecker` (created 2026-07-04, last modified
2026-07-28), downloaded file-by-file and verified against HF's recorded LFS
hashes:

```
model.safetensors           sha256 e788053172f2dbc5a1573454475230dca21f19cd3ca1193e2dca5b1a9fd27bfa
reranker/pytorch_model.bin  sha256 628d648c0754a5a50838f9251491fa4a116a59fb11d035849e7b00e4ab51c725
```

Security posture (reviewed 2026-08-20): the custom modeling code
(`modeling_gectagger.py`, `reranker_gectagger.py`) imports only
torch/transformers/stdlib — no subprocess/socket/eval; the reranker pickle's
globals are exactly `collections.OrderedDict`, `torch.FloatStorage`,
`torch._utils._rebuild_tensor_v2` (would pass `weights_only=True`). Loading
requires `trust_remote_code=True` and at first load transformers ALSO fetches
`modeling_lfm2_bidirectional.py` from the base repo `LiquidAI/LFM2.5-Encoder-350M`
(reviewed clean; cached under `~/.cache/huggingface/modules/` at commit
`b886781f7c6f10ca9b7096e21b83e30a073c2f39`). Load from the LOCAL directory, not
the hub id, so upstream pushes can't change what executes.

## Environment (pinned; SIAI 10-day quarantine verified 2026-08-20)

```
uv venv <dir>/spellenv --python 3.12
uv pip install --python <dir>/spellenv/bin/python --torch-backend=cpu \
    "torch==2.13.0" "transformers==5.14.1" "safetensors==0.8.0" "huggingface_hub==1.27.0"
uv pip install --python <dir>/spellenv/bin/python "errant==3.0.2" "spacy==3.8.14"
uv pip install --python <dir>/spellenv/bin/python \
    "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
```

CPU torch is deliberate: 350M runs at ~40-230 ms/sentence on CPU and never
touches the GPU the production model owns. `errant`+spacy give the reranker its
published ERRANT edit extraction (it falls back to difflib without them,
slightly lower recall).

## Run

```
<venv>/bin/python shim.py     # PROOFER_ENCODER_DIR / PROOFER_ENCODER_PORT to override
PROOFER_OLLAMA_URL=http://127.0.0.1:11500 PROOFER_MODEL=lfm2.5-spellchecker-encoder \
  node sentence-owner-bench.mjs --corpus random-holdout.json --tag encoder
```

`smoke.py` sanity-checks the load and the model card's examples first.

## Caveats that shape the numbers

- The model wants whitespace-tokenized input but handles raw text well; only
  INSERTED tokens come out GECToR-spaced, which `detok()` re-joins minimally.
  Some scored damage may be detokenizer artifacts — the 15 error-holdout damage
  cases were not individually adjudicated.
- Prior context never reaches the model (measured: flat 21/24 across all
  context conditions; all 7 live-corpus contexts byte-identical). Deterministic
  and prompt-injection-immune by construction.
- The HTTP server is single-threaded; concurrent suite requests serialize.
  Latency medians are per-request wall clock, not throughput.
- 2026-08-20 reference numbers (current guards): random-holdout fixSafe 8/14
  DAMAGE 12 (2.4/100); error-holdout fixSafe 22/50 DAMAGE 15 (3.93/100);
  live 42/903 bad applies; multi-typo 29/57 fixed / 25/57 applied.
