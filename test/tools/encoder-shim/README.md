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

Both entry points use `secure_model.py` before importing Transformers. It checks
every executable model file, config, tokenizer, and both weight files against
`model-pins.json`, then copies only verified bytes into a private temporary
directory. It needs about **2.1 GB of temporary disk space** while running; the
copy is removed at normal process exit. Original model files are never modified.

The nested encoder must already be present at the fixed local Hub snapshot:

```
~/.cache/huggingface/hub/models--LiquidAI--LFM2.5-Encoder-350M/snapshots/b886781f7c6f10ca9b7096e21b83e30a073c2f39/
```

It needs `config.json` and `modeling_lfm2_bidirectional.py`. `HF_HOME` and
`HF_HUB_CACHE` are honored, or set `PROOFER_ENCODER_BASE_DIR` to a local directory
containing those exact pinned files. Missing or changed files stop startup with a
security error. Restore reviewed assets; do not update hashes just to silence it.

The verified tagger and reranker configs are rewritten **in the temporary copy**
to point to the verified local encoder. `HF_HUB_OFFLINE=1` and
`TRANSFORMERS_OFFLINE=1` are forced before library imports, with an empty private
`HF_MODULES_CACHE`. Both entry points also use `local_files_only=True`. No model
code or weights are downloaded. `trust_remote_code=True` remains necessary to
load these custom classes, but their code is now local and hash checked.

The previous assumption that a local top-level model directory prevented all
remote code loading was incorrect: both the tagger and reranker independently
loaded the base encoder by a mutable Hub ID. Pinning only the outer model or
setting only its `local_files_only` option does not close that nested path.

## Environment

`requirements.in` records the existing direct package pins. The local `uv.toml`
and security scripts enforce the SIAI 10-day quarantine, hashed lock generation,
and vulnerability audit for this optional encoder environment.
Before changing or installing dependencies, follow the current
`~/github/siai-package-security/README-FOR-AGENTS.md` instructions. Generate and
audit the CPU environment with:

```bash
cd test/tools/encoder-shim
./scripts/generate-requirements-txt.sh
```

On 2026-10-24, the initial lock audit found vulnerabilities in the transitive
packages `certifi`, `filelock`, and `setuptools`. The lock was regenerated with
the policy's package-specific CVE exceptions (all other packages kept the 10-day
cutoff):

```bash
./scripts/generate-requirements-txt.sh --upgrade \
  --allow-recent-package certifi --allow-recent-package filelock \
  --allow-recent-package setuptools
```

The selected fixes were `certifi==2026.10.23` (published October 23),
`filelock==4.2.4` (October 19), and `setuptools==84.2.1` (October 20). Their
[PyPI release metadata](https://pypi.org/pypi/certifi/2026.10.23/json),
[filelock metadata](https://pypi.org/pypi/filelock/4.2.4/json), and
[setuptools metadata](https://pypi.org/pypi/setuptools/84.2.1/json) were checked
to be non-yanked and more than 24 hours old. The regenerated lock audit found no
known vulnerabilities. Before these fixes age beyond 10 days, use those same
explicit exception flags when regenerating; the default cutoff can otherwise
select an older vulnerable version, which the audit rejects.

The generator uses the official PyTorch CPU wheel source and supplies its fixed
Torch wheel listing to the hash-checked audit. PyPI does not register
`torch==2.13.0+cpu`, so the script additionally audits the corresponding
`torch==2.13.0` release metadata without resolving or installing the CUDA wheel.
That supplementary check found no known vulnerabilities; it is not a separate
binary audit of the CPU distribution.

CPU torch is deliberate: 350M runs at ~40-230 ms/sentence on CPU and never
touches the GPU the production model owns. `errant`+spacy give the reranker its
published ERRANT edit extraction when the separately reviewed
`en_core_web_sm==3.8.0` model is already installed. No spaCy model is downloaded
by these scripts; without it, extraction falls back to difflib with slightly
lower recall.

## Run

```
<venv>/bin/python shim.py     # PROOFER_ENCODER_DIR / PROOFER_ENCODER_BASE_DIR / PROOFER_ENCODER_PORT
PROOFER_OLLAMA_URL=http://127.0.0.1:11500 PROOFER_MODEL=lfm2.5-spellchecker-encoder \
  node sentence-owner-bench.mjs --corpus random-holdout.json --tag encoder
```

`smoke.py` sanity-checks the load and the model card's examples first.

The security regression suite uses only Python's standard library and tiny
temporary fixtures. It does not load a model or contact the network:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 test/tools/encoder-shim/security_test.py
```

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
