# Installing Proofer

Proofer corrects finished sentences in supported English text fields. The
proofreading runs on your computer through Ollama. Setup needs an internet
connection to download Ollama if necessary and the proofreading engine, which
is about **1.7 GB**. Allow additional disk space for Ollama and temporary
downloads; requirements vary by operating system and Ollama version.

Use Chrome or Brave and **Node.js 22.12 or later (24 recommended)** to package the
extension from source. Packaging needs no npm dependencies.
Guided Ollama setup is available on Windows and macOS. On Linux, install and
start Ollama yourself before completing Proofer's setup. Check the current
Ollama download instructions for its operating-system requirements.

Proofer is beta software and edits your writing directly. Review important
text before sending it. Whether a computer is fast enough is determined by the
setup speed check. A GPU is a practical requirement for responsive use.
Windows/macOS installer flows remain unvalidated for this release.

## Install the release ZIP

The [release ZIP](https://github.com/JfowlerSIAI/proofer/releases/tag/v0.2.1)
needs no Node.js. Download and extract `proofer-0.2.1.zip`, enable Developer mode
on `chrome://extensions` or `brave://extensions`, and choose **Load unpacked**.
Select the extracted folder containing `manifest.json`, then continue with
**Start Ollama** below. Keep that folder in place while using Proofer.

## Load the extension from source

1. Clone or download this repository and open a terminal in its root folder.
2. Run:

   ```bash
   node tools/package.mjs
   ```

3. Open `chrome://extensions` or `brave://extensions` and enable **Developer
   mode**.
4. Choose **Load unpacked** and select the generated **`dist/proofer`** folder.
   The **Set up Proofer** tab opens automatically. You can also open setup from
   the extension's toolbar menu.

Keep `dist/proofer` in place while the browser uses it. After updating the
source, rerun the packaging command, reload the extension on the extensions
page, and refresh writing pages after saving drafts.

If you already use another copy of Proofer, note your disabled sites and export
any local log you want to keep. Disable the old copy before enabling the new
one, then refresh writing pages. A different installation path has separate
settings and logs; restore your site exclusions before turning it on.

## Start Ollama

- **Windows:** if setup says it needs Ollama running, click **Get Ollama** and
  follow the official installer instructions. Start Ollama from the Start menu
  if it is not already running.
- **macOS:** click **Get Ollama** if needed and follow the official installation
  instructions, then open Ollama from Applications.
- **Linux:** install Ollama using its official instructions and start its local
  service. The optional Docker helper is documented in the
  [usage guide](usage.md#complete-setup).

If Ollama is already installed, start it and return to the setup tab. Proofer
checks its version and offers an update link if it is too old. The supported
minimum is **0.35.0**, defined by `OLLAMA_MIN_VERSION` in `background.js`.

## Complete setup

1. Return to **Set up Proofer**. Once Ollama is available, setup downloads and
   verifies the pinned proofreading engine. You can pause the download and
   return to setup later.
2. Wait for the speed check. It uses made-up sentences and includes an idle
   pause; duration depends on the computer. If it reports that the machine is
   too slow, Proofer stays off and you can run the check again.
3. When setup is ready, click **Turn on**. This allows direct corrections on
   all sites except those you switch off in the toolbar menu.
4. Pin Proofer using the browser's extensions menu so its status is visible.
5. Save drafts and refresh pages that were already open before installation.

The engine is the separately licensed `jayafowler/proofer:v1-q4` model. See
[Licensing](../README.md#licensing) for its LFM Open License v1.0 terms.

## Use Proofer

- Type in an English multiline text box or supported rich editor. Accepted
  corrections appear after a completed sentence, and changed words flash green.
- Press **Escape** promptly to undo the latest correction while its undo is
  available. **Recent changes** in the toolbar menu also lets you copy the
  original text afterwards.
- Use **Use Proofer on this site** to exclude a site, or **Turn off** to stop
  corrections everywhere.
- Single-line inputs, unknown editors, and canvas editors such as Google Docs
  are skipped. See [supported fields](../README.md#supported-fields) for
  the current coverage and limits.

## Get help

If setup reports **Too slow for Proofer today**, try closing other programs or
plugging in a laptop, then use **Run the speed check again**. A **!** on the
toolbar icon means the menu has a status message and an **Open setup** action.
Make sure Ollama is still running.

For an unresolved problem, report the steps using made-up text in an issue or
contact [the maintainer](privacy-policy.md#contact). Support is best-effort.
**Save test report** in setup creates a file with timings, versions, and hardware
details; review it before sharing. It does not contain typed text or site names.

Do not attach exported proofreading logs to public issues. They contain actual
writing and site information. Report security concerns privately using
[SECURITY.md](../SECURITY.md).

## Local records

**Keep a log** is on by default. The log remains on your computer; you can turn
logging off, **Export** a file, or **Clear** stored records from the toolbar menu.
Exporting does not send anything. Sending a log is optional and subject to the
notice shown when you export. Read the [privacy policy](privacy-policy.md)
before sharing one.
