# Proofer's separately licensed model

The extension uses `jayafowler/proofer:v1-q4`, a Q4_K_M quantization of a LoRA
fine-tune of Liquid AI's LFM2.5-2.6B. It is downloaded through Ollama, separately
from the extension and its source distribution. The expected tag, digest,
template, and parameters are pinned in `background.js`. Setup verifies the
engine before it can qualify this computer for live editing.

See the [model card](model-card.md) for a concise overview and usage instructions.

## License boundary

Proofer's original extension code is Apache-2.0. The model is a derivative
governed by the **LFM Open License v1.0**, including its commercial-use
restriction for legal entities whose annual revenue exceeds US$10 million.
Above that threshold, the license calls for a separate commercial license from
Liquid AI. Read the complete terms, including how revenue is defined, before
relying on the model in a business.

- [The model's license and modification notice](Modelfile.proofer-v1-q4)
- [Liquid AI's license page](https://www.liquid.ai/lfm-license)
- [Published model](https://ollama.com/jayafowler/proofer:v1-q4)

The extension's Apache-2.0 license does not grant additional rights to the
model. Describe this project as an open-source extension with a separately
licensed model dependency. A fully open model stack would require a suitable
replacement model and new quality and safety validation.

## Training and reproducibility

The published engine is the v1 LoRA distillation described in
[the publication record](maintainers/publish-model.md). The development tools in
`test/finetune/` support dataset construction, evaluation, and experiments;
some require private datasets, omitted corpus-adapter code, or external
training environments. They are historical research instruments, not a
self-contained training pipeline in this release.

The source release excludes raw user recordings and training corpora. It does
not promise that a fresh clone can reproduce the trained weights. Historical
development sources included owner-provided writing and external corpora;
availability of a dataset on the internet does not establish redistribution
permission. Publishing a dataset or new model is a separate review of source
rights, consent, privacy, and extraction risk.

Contributors can build and test the extension without these corpora. The
source-only and offline browser suites use the included test material. The
real-model end-to-end suite requires Ollama and the exact published model.

## Scope and limitations

The model is evaluated for English sentence proofreading through Proofer's
prompt and output guards. It can make incorrect corrections. The product
checks model output, sentence position, consent, timing, and editor support
before writing, and provides a limited undo window. It is not a general chat
model or a guarantee that text meaning is preserved.
