# Using Proofer

Proofer checks finished sentences in supported English fields while you keep
writing. It runs through Ollama on your computer and makes accepted corrections
directly in the field. This is beta software: review important text before
sending it.

> [!WARNING]
> **A GPU is a practical requirement for meaningfully fast proofreading.**
> CPU-only proofreading can be slow. **Proofer keeps corrections disabled until
> your computer passes setup's speed check.**
>
> **Windows and macOS have had very little usability work.** Development and
> validation have focused on Linux. Expect rough edges; Windows/macOS installer
> flows have not been validated for this release.

This guide covers installation, setup, updates, controls, and editing limits.
For the overview, return to the [Proofer README](../README.md). For guided
Windows/macOS steps, see the [install guide](install-guide.md).

## Install the release ZIP

The prebuilt extension ZIP needs Chrome or Brave; it does not require Node.js.
You also need Ollama running on this computer. Setup downloads a proofreading
model of about 1.7 GB, and its speed check decides whether the computer is fast
enough for live editing. Allow additional disk space for Ollama and temporary
downloads. Plan on GPU acceleration for a responsive experience.

1. Open the [Proofer 0.2.0 release](https://github.com/JfowlerSIAI/proofer/releases/tag/v0.2.0)
   and download **`proofer-0.2.0.zip`**. The release's `SHA256SUMS.txt` supplies
   the archive checksum for verification. The source archive is a separate
   download; use the extension ZIP for this installation path.
2. Extract the ZIP to a folder you will keep in place while using the extension.
   Keep its license, notice, and data-notice files with it.
3. Open `chrome://extensions` or `brave://extensions` and enable **Developer
   mode**.
4. Choose **Load unpacked** and select the extracted folder containing
   `manifest.json`.
5. The **Set up Proofer** tab opens automatically. Continue with
   [Complete setup](#complete-setup) below. You can also open setup from the
   toolbar menu.

Before replacing an existing installation, save your drafts. If you move to a
new folder, that installation has separate settings and logs: note your disabled
sites and export any log you want to retain. Disable the old copy and refresh
writing pages before enabling the new one, then restore your site exclusions
before clicking **Turn on**. Do not run two copies on the same writing page.
After replacing files at an existing installation path, reload its extension
card and refresh writing pages.

## Install from source

You need Chrome or Brave, Node.js 22.12 or later (Node.js 24 recommended) for packaging
and the optional Docker helper, and Ollama on this computer. A GPU is a practical
requirement for meaningfully fast proofreading; setup checks actual performance.
The proofreading engine is about
1.7 GB. Basic Ollama setup guidance exists for Windows and macOS, but those
platforms have had little polish and their installer flows remain unvalidated
for this release. Linux users must start Ollama themselves.

### 1. Package and load the extension

From the repository checkout:

```bash
node tools/package.mjs
```

The command creates **`dist/proofer`**, a clean package with only the runtime
files and their licence notices. Its `SHA256SUMS.txt` records each file's
digest. Use this directory when installing or distributing the extension;
keep its licence and notice files with it. The source checkout also contains
development tools and test fixtures that are not part of the installed extension.

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer mode**, then click **Load unpacked**.
3. Select **`dist/proofer`**. The **Set up Proofer** tab opens automatically.

After changes, rerun the packaging command, reload the extension card, and
refresh writing pages after saving any drafts.

If you already load Proofer from another directory, a new path creates a
separate extension with separate settings and logs. Export any log you want to
keep and note your disabled sites first. Disable the old copy and refresh its
writing pages before enabling the new one, so two copies cannot edit a field.
Restore your site exclusions before clicking **Turn on** in the new copy.

## Complete setup

Setup finds Ollama, provides basic Windows/macOS installation links if needed,
downloads the pinned engine, verifies it, and runs a speed check through the
real proofreading pipeline. Click **Turn on** only after the check passes.
Pages open before installation need a refresh before Proofer works in them.

See the [install guide](install-guide.md) for the guided
Windows/macOS steps. If the computer is too slow, setup leaves Proofer off and
lets you run the check again. If the toolbar shows **!**, open the menu: it
names the problem and offers **Open setup**.

For an existing native Ollama installation, start Ollama; setup handles the
engine download. Proofer requires at least the `OLLAMA_MIN_VERSION` in
[background.js](../background.js) (currently `0.32.6`).

For Docker-based Ollama, the optional helper starts the pinned Compose image,
pulls the same model, and uses Node.js to verify that the pinned tag itself
resolves to the pinned digest. It requires Docker Compose, curl and Node.js
before starting services:

```bash
./setup.sh
```

If the published pull fails, check connectivity and retry `./setup.sh`. A local
build is not an accepted substitute for this build's pin. An unreadable model
inventory fails verification without claiming a different engine was observed.

Then finish the extension's setup and speed check. To use an NVIDIA GPU in
Docker, enable the GPU section in [docker-compose.yml](../docker-compose.yml)
after installing NVIDIA Container Toolkit. Plan on GPU acceleration for a
responsive experience; the speed check still decides whether this computer
qualifies.

The current extension handles Ollama's Origin requirement with a rule scoped
to its own requests and the configured loopback address. No
`OLLAMA_ORIGINS` change is needed.

## Write with Proofer

1. Finish setup and click **Turn on**. Proofer starts off on a fresh install;
   it cannot correct anything until this computer passes its speed check.
2. Type in a supported English text field. Each completed sentence is checked
   with the text before it for context, and an accepted correction is written
   into the field as you continue typing.
3. The changed words flash green. **Escape** takes the latest correction back
   while its undo is still available. Editing the corrected sentence or leaving
   the field can end that undo; **Recent changes** in the toolbar menu lets you
   copy the original text afterwards.
4. Use **Use Proofer on this site** to switch it off for a site, or **Turn off**
   to stop it everywhere. Turning it on authorizes direct corrections on all
   sites except those you have switched off.

Proofer checks model output for suspicious changes and checks the sentence's
position and your cursor again before writing. It skips a correction when
those checks fail, when an editor is unsupported, or when the answer arrives
more than five seconds after the sentence was captured. These checks reduce
unwanted edits; they do not guarantee every correction is right.

## Settings and local records

Open the Proofer toolbar menu:

| Control | Default | What it does |
| --- | --- | --- |
| Turn on / Turn off | Off on a fresh install | Authorizes or stops direct sentence corrections; requires a passing setup check |
| Use Proofer on this site | On when globally activated | Excludes or re-enables the current site |
| Recent changes | Loaded when requested | Lists corrections that reached the field, with the original available to copy |
| Keep a log | On | Records checked sentences locally, including ones left unchanged |
| Export / Clear | — | Saves a log file locally, or deletes stored records |
| Ollama address, under Advanced | `http://localhost:11434` | Uses a custom port on `localhost` or `127.0.0.1`; changing it requires setup again |

The local log keeps up to 5,000 checked sentences, up to 400 characters of
preceding text per sentence, the site, proposals, outcomes, and subsequent
edits to corrections. Storage pressure can evict older entries earlier.
Older installations may also retain up to 2,000 manual-rewrite records until
**Clear**; see the policy below. **Keep a log** can be switched off. Exporting saves a file; nothing is sent
automatically. See the [privacy policy](privacy-policy.md).

## Supported fields

Proofer works in English multiline text fields and the rich-editor families
whose writes have been measured. The toolbar menu reports why it cannot run
in the current field.

| Field | Live editing |
| --- | --- |
| `<textarea>` | Supported |
| Slate | Supported |
| ProseMirror, including TipTap | Supported |
| Quill, Lexical, Draft, Trix | Supported |
| Single-line `<input>` fields, including passwords | Skipped |
| Other rich editors, including CKEditor 5 | Skipped |
| Google Docs, Sheets, Slides, Figma | Skipped (canvas-based editors) |

A supported family can still be refused for a read-only or non-English field,
unsafe formatting, a character limit, a changed sentence, or a failed write.
Paste, bulk edits, undo, and IME composition do not trigger proofreading as
ordinary typing. There is no cloud fallback if Ollama is unavailable.

## Engine and safety checks

The product uses one model:
[**jayafowler/proofer:v1-q4**](https://ollama.com/jayafowler/proofer:v1-q4), the Q4_K_M v1
fine-tune of LFM2.5-2.6B. [background.js](../background.js) pins its tag, digest,
parameters, and chat template. Setup verifies the download; sentence requests
check the model digest and the current setup qualification. There is no model
selector. The model is downloaded separately and is subject to the **LFM Open
License v1.0**, including its commercial-use conditions; it is not covered by
the source code's Apache-2.0 licence. The licence is included in the model's
[Modelfile](Modelfile.proofer-v1-q4).

The content script sends each finished sentence with up to 2,500 characters
of preceding text, the frame hostname, and up to 80 characters of a nearby
section heading to the service worker. The worker calls Ollama's JSON chat
API and runs the output guards and, where allowed, one guarded retry. The
content script rechecks consent, the text anchor, age, selection, and editor
compatibility before applying the result. Rich-editor writes are checked for
landing and durability. [ARCHITECTURE.md](../ARCHITECTURE.md) explains the
transport registry and these gates.

## Getting help

For a bug, open an issue with your browser, operating system, Proofer version,
and steps using made-up text. Do not attach exported writing logs or other
people's text to a public issue. Support is best-effort; you can also contact
[the maintainer](privacy-policy.md#contact). Report security concerns
privately using [SECURITY.md](../SECURITY.md).

