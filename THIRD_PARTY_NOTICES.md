# Third-party materials

The root [LICENSE](LICENSE) applies to Proofer's original code and documentation.
It does not replace the licenses of third-party code, data, model weights, or
assets. The extension has no runtime npm dependencies.

| Material | Where it is used | License and provenance |
| --- | --- | --- |
| SCOWL-derived English word list | Runtime, `data/words-en.txt` | SCOWL 2020.12.07 component terms, reproduced in [data/COPYRIGHT.SCOWL-2020.12.07](data/COPYRIGHT.SCOWL-2020.12.07); [provenance](data/THIRD_PARTY_NOTICES.md) |
| LanguageTool-derived confusion pairs | Runtime, `data/confusables-en.txt` | LGPL-2.1-or-later; [notice and pinned upstream](data/THIRD_PARTY_NOTICES.md), [license](data/COPYING.LGPL-2.1) |
| Names list | Runtime, `data/names-en.txt` | See [data/THIRD_PARTY_NOTICES.md](data/THIRD_PARTY_NOTICES.md) for its construction and terms |
| CMU Pronouncing Dictionary subset | Development, `test/data/cmudict-subset.txt` | [CMU license](test/data/cmudict-LICENSE.txt); pinned inputs in `test/data/SOURCES.json` and `test/build-confusables.mjs` |
| LanguageTool confusion-set input | Development, `test/data/confusion_sets.txt` | LGPL-2.1-or-later; upstream commit and digest in `test/build-confusables.mjs`, [license](data/COPYING.LGPL-2.1) |
| Captured editor demos and their dependencies | Offline browser tests, `test/fixtures/` | [Fixture notices and provenance](test/fixtures/THIRD_PARTY_NOTICES.md) |
| Puppeteer and its dependencies | Development only | Exact resolved versions, upstream locations, and integrity hashes in [test/package-lock.json](test/package-lock.json); their license files accompany installed packages, which are not included in this source distribution |
| LFM2.5-derived Proofer model | Downloaded separately through Ollama | [LFM Open License v1.0 and modification notice](docs/Modelfile.proofer-v1-q4), [model details](docs/model.md) |

The source release contains no model weights, raw user recordings, or private
training corpora. Installing test dependencies or downloading the model brings
in separately licensed materials.
