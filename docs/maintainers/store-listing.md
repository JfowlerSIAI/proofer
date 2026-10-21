# Chrome Web Store listing (unlisted beta)

Candidate listing copy for the packaged extension. The intended beta
visibility is **Unlisted**. Verify these facts against the release artifact and
hosted privacy policy before submission. [store-submission.md](store-submission.md)
describes the publisher workflow; the source release itself does not publish a
store listing.

## Name (from the package)

Proofer

The dashboard shows the name from `manifest.json` and it cannot be edited
there (75 characters max).

## Summary (from the package, 132 characters max)

Live proofreading as you type. Corrects finished sentences locally with Ollama. Changed words flash green; Escape undoes.

(121 characters.) The dashboard's summary is **the manifest's `description`**,
read-only in the dashboard, so `manifest.json` carries exactly the line above
(updated 2026-10-04). Changing the
summary means changing `manifest.json`.

## Description (16,000 characters max)

Proofer proofreads as you type in supported English multiline text boxes and
rich editors. It checks each finished sentence and writes accepted corrections
behind your cursor while you keep typing. The corrected words flash
green; press Escape to take a correction back. A list of recent changes in the
toolbar menu shows what it did.

Proofreading runs on your own computer. Proofer uses Ollama, a free app that runs
AI models locally, and a small proofreading engine made for Proofer (a 1.7 GB
download, set up for you on first run). Proofer never sends your writing to its
author or to a server outside your computer.

What Proofer keeps: a log, on your computer only, of the sentences it checks —
with up to 400 characters of the text before each, the site, what it proposed
and what you did with it — so its work can be reviewed. The log is on by
default; you can switch it off, save it to a file or clear it from the toolbar
menu. There is no automatic log upload. Export saves a local file.

- Corrects spelling mistakes and small slips, with checks that reject suspicious
  changes.
- Works in multiline text boxes and Slate, ProseMirror/TipTap, Quill, Lexical,
  Draft and Trix rich editors. Single-line inputs, unknown editors and canvas
  editors (Google Docs, Sheets, Slides, Figma) are skipped.
- Switch it off for any site.
- Needs Chrome or Brave, a working local Ollama installation, and a computer
  that passes setup's speed check. Plan on a GPU for responsive use.
- Windows/macOS setup guidance is available but their installer flows remain
  unvalidated for this release; Linux users install and start Ollama themselves.

Setup opens by itself after install: it helps you install Ollama if you need
it, downloads the proofreading engine, and runs a short speed check. Proofer
does nothing until the check passes and you press Turn on. Turning it on
authorizes direct corrections on all sites except those you switch off.

Privacy policy: https://jfowlersiai.github.io/proofer-privacy/

## Category

Tools

Confirm the available category in the dashboard at submission time.

## Language

English (United States)

## Single purpose (1,000 characters max)

Proofer corrects finished sentences as the user types in supported web fields,
using a proofreading model that runs locally on the user's computer.

## Permission justifications (1,000 characters max each)

The dashboard lists every permission `manifest.json` declares, each with its
own box, plus one box for host access. As of 0.2.0 the manifest declares:
`activeTab`, `storage`, `declarativeNetRequestWithHostAccess`; host
permissions `http://localhost/*` and `http://127.0.0.1/*`; and a content
script matching `<all_urls>` in all frames. If the manifest changes, this list
must change with it.

| Box | Justification |
|---|---|
| `activeTab` | So the toolbar menu can ask the current tab whether Proofer is running there, and say so. Nothing else uses it. |
| `storage` | Settings, and the optional local log of checked sentences, which never leaves the computer unless the user exports it. |
| `declarativeNetRequestWithHostAccess` | One dynamic rule, scoped to Proofer's own requests (initiatorDomains = Proofer's own id) and to the configured Ollama address on localhost, that sets the Origin header Ollama requires. Without it a default Ollama refuses browser extensions. It does not touch any other request. |
| Host permission (covers `http://localhost/*`, `http://127.0.0.1/*` and the `<all_urls>` content script) | Proofer corrects the sentence the user is typing, wherever they type it, so its content script must run on every site to read the text box being edited and write the correction into it. Many web editors (email, chat, document tools) run inside frames, so it runs in all frames. It only acts on editable fields the user types in. The localhost and 127.0.0.1 permissions are for reaching Ollama, the model runtime on the user's own computer; Proofer contacts no other host. |

## Remote code

**No, I am not using remote code.** All code is in the package. The
proofreading model is data run by Ollama, not code executed by the extension.

## Data inventory for the Privacy practices tab

Disclose local processing and storage as well as any transfer. Google's
[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
includes locally handled information in this requirement; the
[privacy-fields guide](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
requires the declarations to match the privacy policy.

| Data handled | Current behavior |
|---|---|
| Writing and context | Reads the sentence being checked and prior text in a supported editable field; sends them only to local Ollama. Writing can include personal communications or other website content. |
| Local recording | When enabled, stores checked sentences, up to 400 characters of preceding text, proposed changes and subsequent user edits. It is on by default and can be disabled or cleared. |
| Site and activity | Records the site, time and correction outcome; observes typing and edits needed to apply and evaluate a correction. |
| Personal or sensitive information within text | The extension does not ask for identity, health, payment or authentication details. It also does not remove such information from arbitrary prose before processing or recording it. Skipping single-line inputs does not prove that free-form text contains none of these categories. |
| Setup diagnostics | Stores speed-check outcomes and timings; an explicitly saved report includes browser/OS/hardware information, without typed text, sites or file paths. |
| Export and voluntary sharing | Export saves a local file. The user can separately choose to send it; the hosted policy explains that handling and the existing export notice. |

Use this inventory to complete the current dashboard categories; do not copy
blanket “No” answers for information that may occur in the text. Confirm the
Limited Use certifications against the actual release and the published
[privacy policy](https://jfowlersiai.github.io/proofer-privacy/).

## Notes for the reviewer (Test instructions tab, 500 characters max)

Proofer needs Ollama running on the test computer. 1) Install and open Ollama from https://ollama.com/download. 2) Install Proofer: its setup tab opens, downloads the 1.7 GB engine through Ollama and runs a 1-3 minute speed check. 3) Click Turn on. 4) In a multiline text box type: We recieved the invoice yesterday. Then we
The first sentence is corrected to "received" and flashes green; Escape takes it back. Proofer only talks to localhost.

(About 440 characters. Username and password: leave empty — there is no login.)

## Assets

All in `docs/maintainers/store-assets/`, made by `test/store-screenshots.mjs` from the
real extension against a fake Ollama, with made-up text only.

- Store icon 128×128: `icons/icon128.png` is in the package. Its artwork is
  120×120, against the store's guidance of 96×96 with 16 px transparent padding;
  `store-assets/icon128-store-proposed.png` is the same artwork padded to that
  guidance; use it for the dashboard's store-icon field.
- Screenshots (1280×800), in this order:
  1. `screenshot-1-correction.png` — a correction flashing green in an email
  2. `screenshot-2-setup-ready.png` — setup's Ready screen
  3. `screenshot-3-popup.png` — the toolbar menu and Recent changes
  4. `screenshot-4-setup-download.png` — setup downloading the engine
- Small promo tile (440×280, required): `promo-small-440x280.png`
- Marquee (1400×560) and video: none; both optional.
- Visibility: **Unlisted**.
