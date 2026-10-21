<p align="center">
  <img src="docs/assets/proofer-hero.svg" alt="Proofer. All local. All yours." width="960">
</p>

<p align="center">
  <strong>All proofreading runs on your computer.</strong><br>
  Your writing goes to local Ollama, never a cloud proofreading service.<br>
  Live corrections in Chrome and Brave. No cloud fallback.
</p>

<p align="center">
  Local logging is on by default. <a href="#your-writing-and-local-records">Control or clear your log.</a>
</p>

> [!WARNING]
> **A GPU is a practical requirement for meaningfully fast proofreading.**
> CPU-only proofreading can be slow. **Proofer keeps corrections disabled until
> your computer passes setup's speed check.**
>
> **Windows and macOS are rough around the edges.** Very little work has gone
> into making Proofer friendly on those platforms. Development and validation
> have focused on Linux; Windows/macOS installer flows have not been validated
> for this release.

<p align="center">
  <a href="https://github.com/JfowlerSIAI/proofer/releases/tag/v0.2.0"><img src="docs/assets/install-proofer.svg" alt="Install Proofer beta" height="44"></a>
  &nbsp;
  <a href="https://ollama.com/jayafowler/proofer:v1-q4"><img src="docs/assets/explore-model.svg" alt="Explore the Ollama model" height="44"></a>
</p>

<p align="center">
  <a href="#install-proofer">Quick start</a> ·
  <a href="docs/usage.md">Usage guide</a> ·
  <a href="#supported-fields">Supported fields</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

Finish a sentence and keep going. Proofer checks the sentence behind your
cursor and applies accepted corrections directly in supported English text
fields. Changed words flash green. Press **Escape** promptly to undo the
latest correction while its undo is available.

<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (max-width: 600px)" srcset="docs/assets/proofer-demo-compact-still.png">
    <source media="(prefers-reduced-motion: reduce)" srcset="docs/assets/proofer-demo-still.png">
    <source media="(max-width: 600px)" srcset="docs/assets/proofer-demo-compact.gif">
    <img src="docs/assets/proofer-demo.gif" alt="Starting from an empty field, four sentences are typed and corrected in place: should of to should have; recieved to received; seperate to separate; were to was; definately to definitely; have to has; theyre to their; adress to address; theres to there's. Only corrected words flash green, then return to ordinary text. These examples were verified with the pinned model; animation timing is illustrative." width="960">
  </picture>
</p>

*Verified correction examples. Animation timing is illustrative; actual response times depend on your hardware.*

## Proofreading that fits your flow

| Everything local | Keep your momentum | Stay in control |
| --- | --- | --- |
| The model, proofreading, and Proofer's logs live on your computer. No cloud proofreading or fallback. | Finished sentences are checked as you keep typing. No separate editor or copy-and-paste step. | Undo promptly with **Escape**, copy originals from **Recent changes**, or turn Proofer off for a site. |

Output, cursor, timing, and editor checks can reject an edit before it reaches
the field. **This is beta software:** those checks do not guarantee correctness.
Proofer changes your writing directly, so review important text before sending it.

## Will my computer be fast enough?

Setup measures your computer before enabling corrections. For scale, these
[historical Linux setup measurements](test/results/ollama-0.34.3-2026-10-01.json)
used the v1 Q4 model and Ollama 0.34.3 on **1 October 2026**:

| Hardware | Warm median | Observed limit |
| --- | --- | --- |
| NVIDIA RTX 4090 | 131 ms | Measured on the setup cases, not all writing |
| Intel Core Ultra 9 285K, CPU only, 8 performance cores | About 2.9 s | Long-context cases exceeded the deadline and were left unchanged |

These are examples, not a speed guarantee. Windows/macOS installer flows and
performance are unvalidated for this release. Plan on a GPU for responsive use;
the setup check on your computer is the deciding test.

<a name="install-from-this-repository"></a>

## Install Proofer

**[Download Proofer 0.2.0](https://github.com/JfowlerSIAI/proofer/releases/download/v0.2.0/proofer-0.2.0.zip)**
· [Release notes and checksums](https://github.com/JfowlerSIAI/proofer/releases/tag/v0.2.0)

You need **Chrome or Brave** and **Ollama on this computer**. The model download
is about **1.7 GB**; allow additional space for Ollama and temporary downloads.
**Plan on a GPU for a responsive experience.** Setup measures your computer's
actual speed before enabling corrections. Installing the ZIP does not require
Node.js.

1. Download and extract the ZIP to a folder you will keep in place.
2. Open `chrome://extensions` or `brave://extensions` and enable
   **Developer mode**.
3. Choose **Load unpacked**, then select the extracted folder containing
   `manifest.json`. **Set up Proofer** opens automatically.
4. Complete setup, let it download and verify the engine, and click
   **Turn on** after the speed check passes. Save drafts and refresh writing
   pages that were already open.

<a name="2-complete-setup"></a>

Basic Ollama download links and setup instructions are included for Windows
and macOS, but those paths have had little polish and remain unvalidated for
this release. Linux users must install and start Ollama themselves. Proofer starts off on a fresh
install; turning it on allows direct corrections on all sites except those
you switch off. See the [usage guide](docs/usage.md) for setup, Docker,
updates, and moving an existing installation.

**From source:** with Node.js 22.12 or later (Node.js 24 recommended), run
`node tools/package.mjs` from the checkout and load the generated
`dist/proofer` folder. Packaging needs no npm dependencies.
[Source installation details →](docs/usage.md#install-from-source)

## Your writing and local records

**Proofreading and its records stay on your computer.** Proofer sends text only
to your local Ollama service. Setup downloads Ollama and the model from the
internet; the website you are writing on still handles your text normally.
You decide whether to share an exported log.

**Keep a log is on by default.** Proofer stores up to 5,000 checked sentences
locally, including preceding context, site information, proposals, outcomes,
and subsequent edits to corrections. The log can include sentences it left
unchanged.

In the toolbar menu, switch **Keep a log** off to stop recording, use
**Clear** to delete stored records, or **Export** to save a file. Exporting
does not send anything. The [privacy policy](docs/privacy-policy.md)
explains what is stored, retention, and optional sharing.

## Supported fields

Proofer works in English multiline text boxes and supported rich editors:
**Slate, ProseMirror/TipTap, Quill, Lexical, Draft, and Trix**. The toolbar
menu explains when it cannot run in a field.

Firefox is not supported; Edge has not been validated.

Single-line inputs, including passwords, are skipped, as are other rich
editors such as CKEditor 5 and canvas apps including Google Docs, Sheets,
Slides, and Figma. Supported editors can still be refused when a write would
be unsafe. Paste, bulk edits, undo, and IME composition do not trigger ordinary
typing checks. [Coverage and limits →](docs/usage.md#supported-fields)

## Model and licensing

The pinned engine is
[jayafowler/proofer:v1-q4 on Ollama](https://ollama.com/jayafowler/proofer:v1-q4),
a Q4_K_M v1 LoRA fine-tune of LFM2.5-2.6B. Proofer supplies its prompt and
output guards; raw model chat does not reproduce the application's behavior.
[Model details →](docs/model.md)

<a name="licensing"></a>

Original code and documentation use [Apache-2.0](LICENSE). The downloaded
model separately uses **LFM Open License v1.0**, including its commercial-use
conditions. Third-party code and data retain their own terms; see the
[inventory](THIRD_PARTY_NOTICES.md) and [data notices](data/THIRD_PARTY_NOTICES.md).

Created by **[Jay Fowler](https://jay-fowler.com/)**. Visible credit for substantial reuse is appreciated
and voluntary; [ATTRIBUTION.md](ATTRIBUTION.md) explains the request and
[NOTICE](NOTICE) records attribution.

## Contribute or get help

Start with [CONTRIBUTING.md](CONTRIBUTING.md), the
[architecture](ARCHITECTURE.md), [test guide](test/TESTING.md), or
[release guide](docs/releasing.md). For bugs, use made-up text in your
reproduction; keep actual writing logs out of public issues. Support is
best-effort; contact [the maintainer](docs/privacy-policy.md#contact).
Report security concerns privately using [SECURITY.md](SECURITY.md).
