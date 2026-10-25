# Published model record

The extension uses
[`jayafowler/proofer:v1-q4`](https://ollama.com/jayafowler/proofer:v1-q4), a
Q4_K_M export of Proofer's v1 LoRA fine-tune of Liquid AI's LFM2.5-2.6B.
The model is separately licensed; see [the model guide](../model.md).
This page records the existing artifact, not a fresh-clone training recipe.
The private pilot, datasets and training checkpoints are not distributed.

The public listing text is maintained in [the model card](../model-card.md).
Keep its Proofer links and the extension README's Ollama link synchronized
when publishing a release. Editing the listing does not require repushing
the model or changing its pinned digest.

## Published identity

The published copy was verified on 2026-10-02 by pulling it into an empty
Ollama model store and comparing its config and layers with the evaluated
local build. The runtime's authoritative pin is `PINNED_MODEL` in
[background.js](../../background.js).

| Property | Recorded value |
|---|---|
| Published tag | `jayafowler/proofer:v1-q4` |
| Published manifest SHA-256 | `f920607a347881f5a3482ec8a9d6ea621d9a6f7ea7c27b7372e31d8e4f54b320` |
| Quantization | Q4_K_M |
| Download size | About 1.7 GB |
| Parameters | `temperature 0.1`, `top_k 20`, `top_p 0.8`, `num_ctx 2048`, `repeat_penalty 1` |
| License layers | LFM Open License v1.0 and the Proofer modification notice |

[Modelfile.proofer-v1-q4](../Modelfile.proofer-v1-q4) records the license layers
added to the evaluated pilot. Its `FROM proofer-pilot-q4:v1` source is a private
local artifact; that Modelfile cannot recreate the weights from this repository
alone. The model carries no additional SYSTEM text: Proofer supplies the
request instructions and demonstrations.

The evaluated local wrapper had manifest digest
`8cc152b0cac4e3e2644141b725ada66b5cd7b643870118df6c766406601482c0`.
Publication reserialized the manifest and changed its digest, while the
verified config and every referenced layer remained identical. This is why a
published digest must be measured from a clean pull, not guessed from a local
build. A later mismatch with the published pin is a failure to investigate,
not a reason to silently accept new weights.

## Use and verification

Setup downloads the published tag and verifies its digest before qualification.
For an existing local Ollama installation, the equivalent model download is:

```bash
ollama pull jayafowler/proofer:v1-q4
ollama show jayafowler/proofer:v1-q4
```

The real-extension end-to-end check is documented in
[test/TESTING.md](../../test/TESTING.md). Use the exact pinned model, the
shipping prompt and the output guards when evaluating its behavior. A
replacement model or changed prompt needs deliberate quality and safety
validation; raw chat behavior is not the product's proofreading contract.

## Runtime compatibility

`OLLAMA_MIN_VERSION` in `background.js` is **0.35.0**. Setup asks for an update
below this floor. Version **0.35.0** is pinned in the repository's provisioning
and OS-install workflow because it validates model-pull digests before using
them. Checking the downloaded model's digest does not protect an older engine
while it downloads a model. Earlier performance measurements remain in
[the runtime comparison](../../test/results/ollama-0.34.3-2026-10-01.json);
they describe Ollama 0.34.3, which is below the current security floor.
Setup qualification is bound to the Ollama version, so changing the runtime
requires a new speed check.
