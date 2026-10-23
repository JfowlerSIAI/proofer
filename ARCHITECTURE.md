# Proofer architecture

Proofer is a local-first Chrome/Brave Manifest V3 extension. It watches
DOM-backed editable fields, sends each sentence the user finishes to a locally
running Ollama model, and writes the correction back behind the caret. The
extension itself is plain JavaScript with no build step or runtime
dependencies.

There is one correction path, **live sentence editing** (called `sentenceMode`
in the runtime). It can write without a review
click, so it has its own consent, prompting, output guards, anchoring, editor
support, and telemetry, and its guards refuse suspicious output rather than
repair it. A second path — the **manual rewrite** (a floating button or hotkey,
a review panel, tone buttons, partial selection, auto-apply grants) — was
removed on 2026-09-24 when Proofer became a correct-as-you-type product. Where this document still names it, it is saying why something is the
way it is.

This document describes the current source tree. The runtime files are
authoritative when documentation disagrees. Internal planning archives and
private research corpora are excluded from the public source. Public test
commands and their prerequisites are documented in [test/TESTING.md](test/TESTING.md).

## Start here

- Follow [Sentence-mode flow](#sentence-mode-flow) from a completed sentence to
  a local Ollama request and a checked editor write. The
  [consent rules](#consent-and-eligibility) and
  [setup speed check](#setup-and-the-speed-check) decide whether editing can run.
- Use the [source map](#source-map) to find the implementation and the
  [runtime protocol](#runtime-protocol) to follow messages between components.
- Before changing behavior, consult the [change map](#change-map) and
  [testing quick start](test/TESTING.md#start-here). Routine source and browser
  checks need no private corpora; optional model research may require inputs
  that are not distributed.

## System context

~~~text
                     Chrome / Brave

  untrusted web page and editor model
              │ DOM events, text, selection
              ▼
  content.js in an isolated world ─────── injected flash
              │ chrome.runtime messages          (nodes live in page DOM)
              ▼
  background.js MV3 service worker ◄──── popup.html + popup.js
       │               │                       settings / consent / export
       │               └──── chrome.storage.local
       │                     settings, bounded logs, counters
       │
       ├──── packaged data/words-en.txt
       │
       └──── HTTP on loopback only ───── Ollama
                                         /api/chat
                                         /api/version
                                         /api/tags
~~~

The browser extension has three execution contexts:

| Context | Entry point | Responsibility |
| --- | --- | --- |
| Page content script | [content.js](content.js) | Editable-field adapters, offset mapping, page UI (the flash), and the sentence-mode state machine |
| Extension service worker | [background.js](background.js) | Settings authority, origin checks, request cancellation, Ollama transport, prompts, response validation, guards, and logs |
| Toolbar popup | [popup.html](popup.html), [popup.js](popup.js) | Global activation, per-site exclusions, pinned-engine health, Recent changes, and log export/clear |
| Setup page | [welcome.html](welcome.html), [welcome.js](welcome.js) | Local Ollama discovery, pinned-engine download and verification, speed check, and deliberate Turn on |

[manifest.json](manifest.json) wires these contexts together. The service
worker is a classic script. The content script and [styles.css](styles.css) are
injected at document_idle into every frame on every eligible URL matched by
<all_urls>. The action popup is also a classic script. Google Docs, Sheets,
Slides, and Figma are rejected at the start of content.js because their primary
editors are canvas-based rather than DOM-backed.

The manifest's API permissions are activeTab, storage, and
declarativeNetRequestWithHostAccess. Its content-script
scope is <all_urls>, while outbound HTTP host access is limited to localhost
and 127.0.0.1. The Origin rule is scoped to the extension's own requests and
the configured loopback endpoint; it does not require widening Ollama's
default allowlist. There is no bundler, transpiler, or root package manifest.
`node tools/package.mjs` copies the runtime allowlist into `dist/proofer`,
which is the installable package. The repository root also holds tests and
research and should not be distributed as the extension.

## Source map

| Path | Role |
| --- | --- |
| [manifest.json](manifest.json) | MV3 metadata, permissions, runtime entry points, icons |
| [content.js](content.js) | Per-frame page adapter and the sentence-mode flow |
| [background.js](background.js) | Worker-side application core and trust boundary |
| [popup.html](popup.html), [popup.js](popup.js) | Settings and local telemetry UI; its first line names what stops Proofer working, with Open setup |
| [welcome.html](welcome.html), [welcome.js](welcome.js) | [Setup](#setup-and-the-speed-check): finds Ollama, owns the engine download, and drives the worker's speed check; opens by itself on install |
| [styles.css](styles.css) | Sentence-correction flash, reduced-motion behavior, and print hiding |
| [data/words-en.txt](data/words-en.txt) | English word list loaded lazily by sentence guards |
| [data/confusables-en.txt](data/confusables-en.txt) | 419 generated homophone pairs (~8 KB), loaded and digest-verified alongside the word list |
| [data/names-en.txt](data/names-en.txt) | 10,553 cased proper nouns, brands and initialisms (~83 KB) from the same SCOWL source, loaded and digest-verified alongside the word list; a licence for correcting a non-word to a listed name |
| [data/COPYING.LGPL-2.1](data/COPYING.LGPL-2.1), [data/THIRD_PARTY_NOTICES.md](data/THIRD_PARTY_NOTICES.md) | Licence text the LGPL requires, and the runtime package’s third-party data notice; repository build inputs are documented below |
| [tools/package.mjs](tools/package.mjs) | The packaging boundary: copies `RUNTIME_FILES` into `dist/proofer` with a `SHA256SUMS.txt`. There is no bundler, so this list is the only written answer to "what is the extension" |
| [test/build-confusables.mjs](test/build-confusables.mjs), [test/data](test/data) | Builder for the confusables artifact and its SHA-pinned, vendored inputs |
| [test/fixtures](test/fixtures) | Captured third-party editor pages, served offline by the real-editor suites |
| [docker-compose.yml](docker-compose.yml), [setup.sh](setup.sh) | Optional local Ollama provisioning; Docker Compose, curl and Node.js preflight, then tag-scoped JSON digest verification against `PINNED_MODEL`. Unreadable inventory fails verification; failed pulls advise connectivity/retry, never a local substitute |
| [.github/workflows/no-network.yml](.github/workflows/no-network.yml), [.github/workflows/os-install.yml](.github/workflows/os-install.yml) | `no-network.yml` is the deterministic regression battery, triggered by push, pull request, and manual dispatch. `os-install.yml` is a separate Windows/macOS installation check with a real Ollama and engine download; its triggers are documented in TESTING.md §32 |
| [icons](icons) | Packaged icons. The code licence is stated in the packaged third-party notice; third-party data terms are retained under `data/`. |
| [test](test) | Node, VM, Puppeteer, Ollama, benchmark, and real-editor harnesses |
| [test/lib](test/lib) | Shared harness code and the source-extraction seams the suites read production functions through |
| [README.md](README.md) | User-facing install, configuration, and model notes |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Public development and contribution workflow |
| [test/TESTING.md](test/TESTING.md) | Test commands, prerequisites and measurement limitations |

The two large runtime files are intentionally monolithic. MV3 content scripts
cannot be ES modules in this buildless setup, and introducing shared modules
would require a packaging step. Section comments and deliberately exposed test
seams provide the internal structure.

That is the practical position, and it is worth stating what it does *not*
claim. "No bundler" does not imply "cannot split": MV3 accepts several classic
scripts in one `content_scripts.js` array and the classic worker can
`importScripts()`, so the files could be divided without any build step. The
actual reason not to is that the source LAYOUT is currently a test API —
`test/lib/sentence-guards.mjs` and `test/lib/content-sandbox.mjs` evaluate whole
files in a `vm` and read production functions out of them, which is what makes
the suites test what ships instead of a copy. Rearranging the files underneath
those seams is a real project with a real payoff, and it should be the only
thing in its commit rather than a free-seeming side effect of another change.

Keep design rationale and regression instructions in this document and
[test/TESTING.md](test/TESTING.md), so contributors can review changes using the
public source. Historical private measurements below are context; they do not
make private datasets a prerequisite for the deterministic public test suite.

## Runtime protocol

Almost all cross-context calls go through chrome.runtime messages handled by
one router in background.js. There is exactly one exception, and it runs the
other way: the popup asks the *page* directly with chrome.tabs.sendMessage, so
content.js registers its own chrome.runtime.onMessage listener.

| Message | Producer | Purpose |
| --- | --- | --- |
| CANCEL_REWRITE | content script | Abort a sentence request by request ID. The name is the removed manual path's; renaming it would be churn |
| SENTENCE_CONSENT | content script | Read effective top-level-origin permission |
| SENTENCE_WARMUP | content script | Ask the worker to preload the sentence runner when useful |
| SENTENCE_REWRITE | content script | Rewrite one finished, anchored sentence. Carries a `trigger` naming the evidence that the sentence was finished — `newline`, `next-sentence`, or `idle` — which the worker validates against a fixed allowlist, writes to the log record, and feeds to one guard |
| SENTENCE_SKIPS | content script | Flush batched pre-request skip counters |
| REWRITE_OUTCOME | content script | Attach the outcome of a correction (see [Outcome vocabulary](#outcome-vocabulary)) to its record. Named for the removed manual path, like CANCEL_REWRITE |
| CHECK_HEALTH | popup (page-only, like every row marked popup) | Returns the worker's `setupSnapshot`: `ollama` (state, version, floor, versionOk), `engine` (state, digest), freshness, qualification and the last attempt's current-install projection. `ok` retains the version endpoint's HTTP service-health meaning, independent of the engine, floor or qualification; `ollama.state` distinguishes an unusable answer. The popup renders `engine.state` directly, without model inventories. Configured-endpoint replies also carry current settings and tab-scoped consent for activation controls. An unsaved `urlOverride` is observation-only: it cannot stale the configured verdict, change its consent, or publish its badge. Callback `runtime.lastError` and synchronous send exceptions still resolve as `{ok:false,error,messaging:true}`; the popup reports an incomplete Proofer check before interpreting service state |
| GET_SETTINGS / SET_SETTINGS | popup | Read or update effective settings. Successful replies include `settings` (with only `qualification` projected by `settingsForPage` through `shownVerdict`: an orphaned running attempt reads as `operational/run-lost`, without rewriting storage), the worker’s `consent` projection for the popup’s `tabId`, and `pinnedModel` (`PINNED_MODEL`: tag, digest, size) so no page keeps a second copy of the model's name — the 2026-08-13 bug was exactly that. There is no model setting to write. A write carrying `sentenceMode` or `sentenceModeApply` is refused whole (the consent has its own message), and every write is refused until the v5 migration is stored. A failed site toggle retains the worker’s refusal text and rereads GET_SETTINGS: a lost acknowledgement may follow a committed write |
| SET_SENTENCE_MODE | popup or setup page | Turn on / Turn off: `{on: boolean, tabId?}`, the only way the write consent changes. Successful replies use the same settings/consent/pin shape as GET_SETTINGS. Refused until the v5 migration is stored, and Turn on is refused without a current, passing speed check |
| SETUP_READY / SETUP_STATUS / SETUP_VERIFY / SETUP_BEGIN / SETUP_STEP / SETUP_PING / SETUP_REPORT | **setup page only** | The speed check and its verdict. The page names nothing but a run id: fixtures, model, options and URL are the worker's. `SETUP_READY` is the page's barrier before it talks to Ollama itself: it returns the URL and pin to use once the Origin rule for that URL is installed and checked. `SETUP_STATUS` uses the same worker snapshot as CHECK_HEALTH, reading version and digest past their caches, and returns global activation and any upgrading reason in `consent` (no target editing tab). `SETUP_STEP` returns controlled failure codes with operational reasons and performs one step per message (so the worker stays awake) and hands the page any deliberate wait; `SETUP_REPORT` returns report version 2: the LAST ATTEMPT's identity, stored bounds and measurements, with current build metadata labeled separately, without text, sites or paths. Refused from any sender whose URL is not this extension's `welcome.html` — not the popup, not a content script |
| GET_LOG_STATS / EXPORT_LOG / CLEAR_LOG | popup | Inspect, download, or delete local records. The stats describe the sentence ring only (since 2026-09-24): `legacyManual` counts old manual records, `clearable` is the worker's authoritative answer to "is there anything Clear would remove" (asked of storage by the prefixes Clear sweeps, so legacy, orphaned and telemetry-only storage all count), `evictions` reports a quota eviction that came before the count cap (written BEFORE the replacement record is tried, so a failed retry still says so), and `writeFailures` counts records or verdicts that could not be written at all — stored, and held in memory too, since a storage refusing every write refuses that count as well. The popup sends CLEAR_LOG even when `clearable` says nothing is stored: a sentence in flight writes its record when its response lands, and only CLEAR_LOG advances the generation that drops it. EXPORT_LOG returns `{ok, records, counts: {records, warmups, skips}}`: counts come from the same indexed interaction array, warmup array and optional skip row being exported; `skips` is zero or one, not the counter sum. Export excludes orphaned prose, while Clear’s prefix inventory includes it. Counts are response metadata, never JSONL rows. The popup names interaction records and diagnostics separately, allows diagnostic-only downloads with “No interaction records. Exported diagnostics only.”, and saves nothing when all counts are zero. The export is both rings plus the warmup events, and — since 2026-09-14 — one trailing `path: "skips"` row carrying the skip-counter map, the only measure of failures that never produced a record. The popup shows the [export notice](docs/privacy-policy.md#exporting-and-sharing-for-support) the first time, and appends one more row, `path: "notice"`, naming the notice seen, which `test/contributions.mjs` records as notice provenance. Acknowledging the export notice does not grant training permission |
| GET_RECENT_SENTENCES | popup | The last 20 corrections that reached a text field, newest first, for the popup's "Recent changes" receipt. Eligibility is decided on the VERDICT and never on whether the text changed: on a guard refusal the record's `output` holds the raw model text that was refused, so an `input !== output` filter would present refusals as receipts for edits that happened. Filtered before the cap, and capped worker-side |
| SENTENCE_STATUS | **popup to content script** | Ask a page why sentence mode is or is not running there. The only message the worker does not route |

SENTENCE_STATUS reaches every frame, and Chrome keeps only the first reply.
Both content listeners use `replySentenceStatus` to schedule bounded priority
buckets: a focused editable at 0 ms, remembered status younger than 30 seconds
at 60 ms, older remembered status at 120 ms, and an empty top frame at 150 ms.
An empty subframe does not reply. Age is measured from `sentenceLastField.at`,
updated by `setSentenceStatus`, not from the last keystroke. Two- and five-minute
histories tie; renderer scheduling can decide which wins. The popup describes
remembered status as “(previously focused field in this frame)”, not as the
latest field across the page.

Canvas hosts (Google Docs, Figma) retain their early return from editor handling
but use the same reply helper: their `canvas-host` refusal is the top frame's
150 ms fallback, and canvas subframes supply no reply. A supported child can
answer before a canvas top frame. Reports are produced when the timer fires;
the helper keeps the asynchronous response channel open. The popup needs no
permission beyond activeTab, which the toolbar click grants for that tab.

Current permission and remembered field eligibility are separate. The status
reply’s `apply` is the frame’s cached worker `allowed` answer. The popup refreshes
worker consent before asking for status, clearing its previous running label
while the refresh is pending or failed. Worker refusal wins over any field
answer; a remembered field is substituted only with worker `allowed === true`
and frame `apply === true`. Active and unsafe-range fields without current
frame permission cannot be described as running. Direct capability explanations,
such as canvas-host refusal, remain available.

Sentence request IDs are opaque `sn_<namespace>_<counter>` values. Each content
instance lazily mints a 128-bit namespace with `crypto.getRandomValues` on its
first request; the counter starts at 1. Separate frames and reloads get separate
namespaces even when their wall clocks agree. Cancellation, outcomes and watchers
pass the original ID unchanged. Historical IDs remain opaque (the removed manual
path's started with rw_, and its records may still be in a user's log). The
prefix is part of the storage contract because later outcome messages contain
only an ID and must route to the correct log ring. REWRITE and OPEN_SETTINGS went
with the manual path on 2026-09-24.

### Outcome vocabulary

| Verdict / family | Accepted for new reports | Meaning and read treatment |
|---|---|---|
| `sentence-applied` | yes | Verified automatic correction; kept; receipt; not harvested. |
| `sentence-applied-unverified` | yes | Correction landed without verification; kept; receipt; not harvested. |
| `sentence-written:splice-failed:normalized` | yes | Optional `:window=…`; replacement occupied its target while surrounding text changed; applied with `writtenNormalized` detail; kept; receipt; not harvested. |
| `sentence-written:splice-failed:misplaced` | yes | Optional `:window=…`; field changed without honoring the target; other with `writtenMisplaced` detail; outside keep rate and lost; receipt identifies proposed output; not harvested. |
| `sentence-undone` | yes | Verified Escape undo; rejected; receipt; ratified input when harvested. |
| `sentence-undo-reconciled` | yes | Escape rejected the correction; the page discarded the undo; rejected with `undoReconciled` detail; receipt; ratified input. |
| `sentence-undo-unverified` | yes | Escape rejected the correction; undo not verified; rejected with `undoUnverified` detail; receipt; ratified input. |
| `user-reverted` | yes | User restored the original wording; rejected; receipt; ratified input. |
| `user-edited-correction` | yes | User changed the corrected span; rejected; receipt; ambiguous final-text harvest. |
| `sentence-reconciled` | yes | Page discarded the correction; lost; receipt; not harvested. |
| `sentence-not-durable` | yes | Editor discarded the correction on subsequent typing; lost; receipt; not harvested. |
| `sentence-skipped:*` | yes | Delivery drop with a reason; other; no receipt or harvest. The historical post-write aliases below are read-only exceptions. |
| `sentence-edited` | legacy only | Old user-edit outcome; rejected; receipt; ambiguous final-text harvest. |
| `sentence-suggested` | legacy only | Old suggestion offer; legacySuggestion in other; no receipt or harvest. |
| `sentence-dismissed` | legacy only | Old suggestion rejection; legacySuggestion in other; no receipt; ratified input. |
| `sentence-suggestion-applied` | legacy only | Old accepted suggestion; legacySuggestion in other; receipt; ratified output. |
| `sentence-no-change` | legacy only | Read from the record's `noChanges` flag; no receipt or harvest. |

`SENTENCE_OUTCOMES` in background.js owns acceptance, distribution, breakdown,
keep-rate contribution, receipt label and harvesting policy. `sentenceOutcomeDefinition`
reads exact entries, the declared skip family, the two post-write families with
optional nonempty `:window=…`, and their historical aliases; `VERDICTS` and `RECENT_VERDICTS`
are derived from that table. Unknown outcomes are refused on arrival and visibly
unclassified when read from storage. Manual-path verdicts, including `dismissed`,
are retired and refused for new reports; old manual records remain exportable.
The settings suite checks emitted literals against the evaluated definitions,
probes accepted families and retired reports through the real handler, and
cross-checks this table's accepted entries.

`canonicalSentenceReason` preserves up to 128 characters of a reason for both
`SENTENCE_SKIPS` counter keys and `sentence-skipped:<reason>` or declared
`sentence-written:<reason>` outcome suffixes.
The verdict prefix is outside that bound; the complete verdict is not sliced
again. Stats and exports retain the same reason on both paths. Historical keys
and verdicts truncated under the old 48-character counter / 64-character whole
verdict bounds stay as recorded, without reconstruction or merging into newly
complete reasons. Settings **[V2]** pins both handlers, stats and export at the
128/129-character boundary for both families and preserves distinct deletion-window reasons.

Only `splice-failed:normalized` and `splice-failed:misplaced`, optionally followed
by a window qualifier, are accepted under `sentence-written:`. A normalized
write contributes to kept/applied and `breakdown.writtenNormalized`; a misplaced
write contributes to `otherDetail.writtenMisplaced` and `breakdown.writtenMisplaced`,
outside both keep rate and lost. Both have receipts and neither is harvested.
The misplaced receipt identifies its output as the proposed replacement, not the
final field. Old `sentence-skipped:splice-failed:normalized…` and
`…:misplaced…` records are read-only aliases of those categories, including
truncated window tails: storage and exports keep the original strings. They
are excluded from delivery drops. Settings [V3]/[V3b] pin the literal partition,
labels, rejection of unknown families, salvage and unchanged historical storage.

Failed Escape outcomes contribute once to rejection and the keep-rate denominator,
never to lost or an automatic-apply breakdown. Their details are subcounts,
not additional records. Old `sentence-reconciled` and `sentence-applied-unverified`
records remain lost and kept respectively: those strings cannot distinguish an
apply from an undo exit. Storage is not rewritten and history is not guessed.

`sentence-applied-unverified` is the write that landed and was *not* checked. A
trusted user action inside the intent recipe's guarded window makes the field
unattributable, so verification is ended rather than relaxed — and "verified"
versus "declined to judge" is a fact about the correction, so it belongs on the
correction's record. It counts as kept in the popup's keep rate: the text is in
the field and the user did not reject it. A cancelled keypress in the same
window is deliberately *not* folded into it — that correction was verified like
any other, and the cancellation is a fact about the window, so it stays a debug
log line until there is a field on the record for it that is not the verdict.

The popup renders these as a stacked bar over an icon key, from
`GET_LOG_STATS.sentence.distribution` — a **partition**: every sentence record
in exactly one of six buckets, with `other` a sum of named parts rather than a
remainder, so an outcome nobody classified surfaces as `unclassified` instead of
vanishing into a bucket that still adds up. It is a second object beside
`breakdown` and not a replacement, because `breakdown` is a set of overlapping
counts covering neither guard refusals nor errors: a bar drawn from it would be
a proportion of the wrong denominator and would look entirely correct.
The keep-rate line says “N% kept without rejection of M applied corrections”:
kept automatic corrections divided by kept plus rejected corrections. The two
failed-Escape details appear under rejection; they do not add records or claim
correction loss, and lost corrections remain outside the rate.

The guard vocabulary the worker can return has grown with the same care. It
gained `idle-final-inflection`, which is the one guard that reads the request's
`trigger`, and `negation-ambiguous`, `closer-added` and `leading-word-added` in
2026-09-06's log review. The content script's own refusal vocabulary gained `wrote-elsewhere`
(the block reason for a `misplaced` transport) and `no-static-range`,
`splice-in-flight` and `normalized` as splice reasons.

## The removed manual path

Until 2026-09-24 a second flow ran on an explicit click or hotkey: it sent the
whole field (or a selection, or a tone request) as REWRITE, repaired the
model's answer with the sanitizer, and showed a diff in a panel with Apply,
Copy, Cancel and tone buttons, or applied it under a time-limited auto-apply
grant. Its num_ctx was bucketed per request, its lease was 1.5 minutes, and its
records went to the plog: ring. It was removed when Proofer became a
correct-as-you-type product. What it left behind on
purpose: the shared proofreading instructions (now PROOFREAD_SYSTEM_PROMPT,
extracted byte for byte and pinned by test/sentence-request-bytes-test.mjs),
the request-id counter, the outcome and cancel message names, and the read-only
handling of its old log records.

## Sentence-mode flow

Sentence mode is the product's one state machine.

### Consent and eligibility

Sentence mode is **off on a fresh install** and is turned on by one deliberate
**Turn on** in the popup. Since settings v5 (2026-09-24) that is one bit, and on
means corrections are written into the field: suggestion mode — a chip offering
Apply/Dismiss — was removed with the manual path, so turning Proofer on IS the
consent to silent writes and nothing else grants it. Once on, it is switched off
**per site**. History: opt-in per site behind an expiring grant until
2026-09-02; on by default and off per site (v3); off until activated, with a
separate `sentenceModeApply` choosing between writing and suggesting (v4,
2026-09-06). A sentence request is allowed only when all of these are true:

- Intl.Segmenter is available and the field language resolves to English.
- The stored settings are at the current schema (`settingsVersion` 5). Until
  the v5 migration is persisted the worker refuses consent, warmups and Turn on:
  under v4 a stored `sentenceMode: true` could be a SUGGESTION consent.
- Sentence mode is globally enabled (`sentenceMode`, the one switch).
- This install has a current, passing speed check (`qualified`).
- The top-level origin is an HTTP(S) origin, and it is in neither
  disabledSites nor sentenceModeDisabledSites. The scheme rule exists because
  a denylist cannot refuse an origin that could never be put on it: the origin
  lists hold http(s) origins only, and the content script is injected into
  `<all_urls>`, so a file:// or about:blank tab (origin `"null"`) or a
  chrome-extension:// page would otherwise be on with no way to switch it off.
- The field is a writable textarea, or a contenteditable whose editor matches a
  row of the transport registry (see below) that has not been demoted.

The worker derives the top-level origin from the browser-supplied message
sender. Content has no frame-origin veto: an excluded editor origin embedded
in an allowed top-level page can attach. Its first trusted editable focus
registers the storage listener and asks for worker consent; both switch-off
lists still invalidate that cached answer. The worker checks consent for the
initial probe, every warmup, and every SENTENCE_REWRITE, so a content script's
cached permission cannot survive the mode or the site being switched off. The migration is one pass and one write. `runSettingsMigration` computes every
historical step from the stored values — v3 flipped a stored `sentenceMode:
false` on (every popup Save under the opt-in model had written the old default
back) and reset the old model's apply bit (a consent does not survive a
redefinition of its own scope); v4 materialised the old default for an install
that never stored the key — and then v5: `sentenceMode = (sentenceMode === true)
&& (sentenceModeApply === true)`, strict on both, so an install that was already
correcting automatically stays on and a suggestion user goes off and waits for
Turn on. No model is carried across: requests use the release's pinned model
whatever was stored (see Worker validation). The new consent and
`settingsVersion: 5` are persisted in **one** `storage.set`; the legacy keys
(`sentenceModeApply`, `sentenceModel`, `ollamaModel`, the manual path's
`rewriteHotkey`/`autoApply*`/`showFab`, and the v1/v2 keys) are removed
afterwards, in a step of its own that runs on every migration call. The order is
the safety argument: removing the apply bit before the stamp would make an
interrupted migration unsafe to re-run, because the retry would read a missing
bit and drop an automatic user's consent. A fresh install (no
`CONFIGURED_MARKERS`, legacy keys included) is stamped current without running
history.

The migration runs **on `settingsQueue`**, like every other settings write.
`getSettings` keeps settings readable after a migration failure, reports
`migrated` from the stored version, and exposes `sentenceMode` as effective v5
activation rather than the raw legacy bit. `runSettingsMigration` still reads
untouched raw storage, including `sentenceModeApply`. `applySettingsUpdate`
refuses EVERY write without the stamp and never writes the computed flags back.
Every write, not only Turn on: the migration is enqueued ahead of each
write, so reaching the write unmigrated means it failed, and a write then puts
today's defaults into the old schema — an install that never stored
`sentenceMode` gets the new default `false` written over its old one, and the
retried migration reads that as a choice and switches an automatic user off
(checkpoint 1). Turn on and Turn off are `SET_SENTENCE_MODE`, not a settings
save; see Trust and privacy boundaries.
`sentence-settings-test.mjs` drives a rejected write at each persistence
boundary, a worker killed between the write and the cleanup, re-runs after each,
and a concurrent `SET_SETTINGS` during the migration on a deferred-callback
storage stub.

`sentenceModeState(settings, topOrigin)` owns the projection: `activated` is
migration persisted AND the stored mode bit true; qualification loss preserves
that choice. `siteDisabled` is membership of either switch-off list, independent
of activation. `allowed` is the complete worker permission; `reason` is null or,
in precedence order, `upgrading`, `switched-off`, `qualification-required`,
`no-http-page`, or `site-disabled`. `apply` is a compatibility alias of `allowed`;
content consumes `allowed`. A missing origin still refuses permission.
`settingsReply` resolves a popup’s tab through `chrome.tabs.get`; missing, closed
or unreadable tabs yield a refused page state while settings remain readable.
Measured in Chrome for Testing 145: a native extension-action activation grants
`activeTab`, after which the worker receives `tab.url` for a 127.0.0.2 page
outside the localhost host permissions. No `tabs` permission or origin fallback
is needed. These messages are extension-page-only. Content consent still derives
its origin solely from the browser-supplied sender. The popup’s site checkbox uses
`consent.siteDisabled`; its list of excluded sites is only a display.

Successful rewrites carry `apply:true`. Revocation before delivery instead
returns `{ok:false, error:"not-allowed", revoked:true}`, which tears down the
content attachment. The defensive successful-but-non-writing drop remains for
unexpected replies and test doubles; it is not a suggestion mode.

Sentence mode ships **off** and is turned on by the popup's one **Turn on**
(see Consent and eligibility). Flipping a default on instead was rejected at v4
and still is: `getSettings` merges `DEFAULT_SETTINGS`, so that would hand a
write permission to every install that never chose one.

`sentenceAttach` also counts what it decided: `field:ok:<family>` and
`field:<status>:<detail>`, once per field, through the existing skip batching.
It records a reason and never an origin. This is the only measurement of how
often deny-by-default refuses a real writing surface; the popup partitions it
out of the skip total and reports the ratio among rich editors. The counters
are diagnostic and do not grant support to a new editor family.

Inputs and unrecognized rich editors are excluded. An input has no useful
look-ahead sentence, and writing safely to a rich editor requires evidence that
the editor's internal document model accepts the change — not merely that its
DOM looked correct for one frame.

Every refusal has a name, and the popup reports it. content.js keeps a
per-frame status — off, no-field, field-detached, unsupported-editor, unsafe-range,
session-blocked, or active — plus the last verdict about an actual field, which
survives the blur that opening the popup causes. This history describes field
state, never permission: it is useful only while both the worker and the
answering frame still allow writes. Before this existed, a
ProseMirror composer got no flash, no warmup, no log line and no error;
the consent was stored and honoured and there was simply no eligible field,
which from outside is indistinguishable from a broken extension. A curated
allowlist of editors is defensible; one that never says it refused is not.

`field-detached` with detail `detached` means the field was removed before the
write could be checked. `markSentenceFieldDetached` tears down that field's
track and clears its focused reference, then records the lifecycle diagnosis
for both live and remembered popup rendering. It preserves a newer attachment
(including one already blurred) or an off-state established by consent withdrawal.
A later eligible attachment replaces the diagnosis. The existing
`sentence-skipped:splice-refused:detached` observation is unchanged; the popup
says the field was removed and asks the user to click into a text field.

A name is not enough on its own: it has to be the name of what actually
happened. `session-blocked` has five causes — `write-rejected`, `write-normalized`,
`reconciled`, `wrote-elsewhere`, `not-durable` — and until recently only the two demoting ones
survived, because the demotion map keeps its reason while the element set kept
only membership. Every non-demoting block therefore recomputed as
`write-rejected` whatever had been recorded, so "the editor refused the write"
and "the write landed and the page threw it away" were indistinguishable in the
popup; two readers were sent to the wrong branch by it in a single day. The
element half is now a WeakMap holding the cause, first cause winning, and
sentence-typing-test.mjs [10c]/[10f] pins each cause end to end — including the path
that actually lied, which is the refocus: the block itself always set the live
status correctly, and attachSentence then overwrote it with the constant when
the user clicked away and back on their way to the toolbar. popup.js renders all
five (`BLOCK_DETAIL`), including changed surroundings during a write, rather than special-casing `not-durable` and calling
everything else "the page rejected it", which was true of `reconciled` and false
of the other two. The typing suite pins the vocabulary; popup-activation
[12]/[12b]/[12c] pins worker/frame permission precedence and permitted blur
history in the real popup DOM. A browser check still covers the walk from a
focused field through qualification withdrawal to opening the toolbar popup.

### Setup and the speed check

Proofer writes into people's text with nobody looking, so it runs only where it
has shown it answers in time **and** with the answers it gives on the machines
it was tested on. See the [installation acceptance test](docs/maintainers/acceptance-test.md).

- **Setup** is `welcome.html`, opened by `onInstalled` on a fresh install and on
  an update when the stored verdict no longer holds. It rebuilds its state from
  the worker's `setupSnapshot` each time. `observeOllama` owns the version
  comparison against `OLLAMA_MIN_VERSION` (0.32.6); `observeEngine` uses the
  tag-scoped `installedModelDigest`; `setupVerdictView` projects `shownVerdict`
  and its applicability to the observed installation. Service states are `ok`,
  `unreachable`, `unusable`; engine states are `ok`, `missing`, `mismatch`,
  `unknown`; freshness is `fresh`, `stale`, or `unknown`. A failed inventory is
  unknown and stays checking. Only a successful missing/mismatch observation
  starts an automatic pull; an unsuccessful status message stops on the failure
  screen. Neither page compares versions, digests or model inventories itself.
  It polls every ~2 s while
  visible and at once on `visibilitychange`, so coming back from Ollama's
  installer carries on with no click. It **owns the download** (`/api/pull`,
  streamed NDJSON parsed across chunk boundaries; a service worker can be
  stopped mid-stream, a visible tab cannot). Pause is stored (`setupPaused`)
  and survives reopening; Try again and Resume continue a partial pull.
  Screens: checking, install-needed (OS-specific steps; an OS the browser
  reliably identifies as too old is refused, and an ambiguous Windows 10 says
  "unknown" rather than guessing), update-needed, not-ollama, downloading,
  paused, interrupted (which failure, in plain words), verifying, testing,
  ready (with "Run the speed check again", which a laptop's battery retest
  needs), and the three failed-check screens — too-slow, unexpected,
  operational — each with Retry and Save test report. Before refresh and
  again before the download's POST, the page waits on
  `SETUP_READY`. A stored too-slow or unexpected verdict about this Ollama is
  shown; an interrupted or failed-to-run check is not a verdict and runs again.
  Missing/different-engine operational recovery returns through refresh, pull,
  verification and the check. Other retries start a worker-gated attempt; a
  direct retest rejected as `ollama-version` refreshes into update-needed.
  Ready and the Turn-on response consume the worker’s `consent.activated`.
  Qualification alone does not finish migration: an unstamped store says its
  settings are still being upgraded, makes no on claim, and retains Turn on
  when qualified so the existing settings queue can retry migration.
- **The speed check** is the worker's. `SETUP_BEGIN` starts a run; each
  `SETUP_STEP` does one thing: probe (version and digest asked past their
  caches; a below-floor or unparseable version fails as `ollama-version`
  before any unload, load, calibration or timed case; unload verified by
  `/api/ps`, a load, and the backend from
  `size_vram`; an `/api/ps` or unload that does not answer successfully, or an
  engine not listed right after loading, is `ollama-status` — "could not tell"
  is never "cold"), on a CPU a
  calibration step per candidate `num_thread` (from `hardwareConcurrency`), a
  cold **burst** (the first keystroke's warmup, then the sentence
  `SETUP_FIRST_DELAY_MS` = 6 s later, timed from its own send), warm cases, the
  idle pause past the 20 s lease (handed to the page as a wait), a second
  burst, and the finish. Every case runs through `runSentenceEngine` with the
  product's request, guards, retry and deadline; its outcome is judged on what
  would reach the field — the exact correction, or no change. 24 synthetic
  fixtures (`SETUP_FIXTURES`) in three documents, growing context, all three
  triggers, one context at the window limit, and then `SETUP_AFTER_LONG` (a
  short-context fixture) sent again: 25 cases. Pass: every case matched, warm
  p95 ≤ 3.5 s, no case over 4.5 s — except the long-context case, which is
  held to its answer and not its time (owner, 2026-09-25): if it misses the
  deadline it is a clean drop (in use the worker answers `delivery-expired`
  and the field keeps what was typed), recorded as `numbers.longDropped` and
  said on the Ready screen, and the case after it — which would wait on an
  abandoned request — must be inside the bounds like any other.
  `SETUP_BENCHMARK_REVISION` `speed-v2`. Otherwise too-slow, unexpected (a wrong
  answer, the long case included) or operational. Fetch failure before an answer
  is `ollama-stopped`; an answered HTTP failure, unusable JSON/envelope or unknown
  inventory is `ollama-status`; verified absence/mismatch is `engine-missing`;
  an unexpected internal step exception is `setup-error`. Other operational
  reasons remain `ollama-updated`, `ollama-version`, `config-changed`, `run-lost`.
  A case that could
  not run ends the run there; the idle step and the finish ask Ollama's
  version through the same floor-aware observation past the cache and fail the
  run if it changed or is unsupported. The expectations were
  verified against the pinned engine on a GPU at the shipping temperature
  (5/5 each) and at 0.8 (6/6 each), and on the CPU (every GPU hidden,
  `size_vram` 0) at 8 threads (3/3 each) and 4 threads (2/2 each). The whole
  check, calibration included, was run for real against that CPU-only Ollama
  pinned to 8 cores: it chose 8 threads over 4 and failed as too-slow on ONE
  case, the fixture whose context is at the 2,500-character window limit,
  which expires at the deadline (twice, reproducibly); every other case
  finished in 3.3 s or less. Under `speed-v2` (the clean-drop rule) the same
  CPU passes: 8 threads, the long case dropped at 4.75 s, the case after it
  and every other ≤ 3.23 s, warm p95 3.12 s. Ollama 0.32.12 reports no `load_duration` for a
  load-only request, so a burst's load is recorded as its wall time, and the
  duration as null.
- **The verdict** (`setupQualification`) is written only by the worker, and
  describes the LAST ATTEMPT (checkpoint 3). `SETUP_BEGIN` stores a
  `category: "running"` record with the run's id — so a pass from before is not
  authoritative while a retest runs (Proofer stops writing for its length) and
  never stands in for its result — and cancels work in flight. Every terminal
  failure is stored as `operational` with its reason and whatever was
  measured, only while the run still owns the record; a `running` record whose
  run the worker no longer holds reads as `operational/run-lost` through
  `shownVerdict`. `settingsForPage` applies that projection to all three
  successful settings reply paths; effective settings, consent and the pin
  remain intact, and opening a page does not rewrite the stored attempt.
  A live run still reads as `running`; setup can retry an interrupted run.
  A pass is stored only if
  the configuration generation it started under is unchanged, compared after
  the finish's last await. It is
  bound to the Ollama URL, the pinned tag and digest, `PROMPT_REVISION` and
  `SETUP_BENCHMARK_REVISION`, and carries the chosen `num_thread`, which every
  later request and warmup then sends (`requestOptionsFor`). `getSettings`
  reports it as `qualified`; consent, Turn on, sentence requests and warmups
  all require it. `qualificationIsCurrent` also requires a floor-valid recorded
  version. G3.2 retains `speed-v2`: supported-installation fixtures, expectations,
  bounds and timing procedure are unchanged; below-floor passes alone cease to
  qualify, without a migration or blanket requalification.
- **The test report** (`SETUP_REPORT`, `reportVersion: 2`) preserves the
  attempt's `model` (tag and digest), `promptRevision`, `benchmarkRevision`
  and `ollamaVersion` from the stored qualification, even if a new attempt's
  first storage write fails. `result` carries its verdict and measurements;
  lifecycle is projected through `shownVerdict` without losing identity.
  Operational failures carry a bounded `code` through the step reply, stored
  record and report; cases retain a bounded `engineError`. Controlled endpoint
  codes and engine error names are allowed, never response bodies or arbitrary
  exception messages. Historical cases without `engineError` remain unchanged.
  `setupRecord` snapshots `{warmP95Ms: 3500, caseMaxMs: 4500,
  longContext: "may-drop"}` in each new record. `result.bounds` exports that
  snapshot unchanged, or explicit `null` for older records without bounds;
  today's bounds are never substituted for unknown historical bounds.
  With no attempt, `result` and all four attempt identity fields are `null`.
  `currentBuild` separately holds today's `model`, `promptRevision` and
  `benchmarkRevision`; `extensionVersion` and `engineNow` are current
  observations. This schema change neither migrates stored qualifications nor
  changes what a pass means: the benchmark remains `speed-v2`.
- **The configuration generation** (`configGeneration`) advances when the URL
  changes, a verdict is stored, or freshness marks one stale. A sentence job
  captures it at arrival and sends and delivers only if it is unchanged: the
  engine's `isCurrent` is asked SYNCHRONOUSLY with nothing awaited between it
  and each send (first pass and retry) and each successful answer, and
  `checkAllowed` reads settings first and compares after (checkpoint 3 held
  that read, stored a new verdict, and the old job delivered). Warmups do the
  same before they dispatch. content.js drops pending work — including a rich
  editor's correction held for a pause, recorded as
  `sentence-skipped:consent-changed` — when `setupQualification` or `ollamaUrl`
  change in storage.
- **The engine found missing or different** by a sentence's pre-send lookup,
  a warmup's, or setup's configured-endpoint observation/check goes through one path,
  `invalidateEngine`: a passing verdict is marked stale (`engine-missing` /
  `engine-mismatch`, which advances the generation and fires the storage
  change content.js acts on), every request in flight is aborted, and the
  badge and popup say the engine needs downloading again.
- **Freshness**: at a field's first consent ask (off the answer's path, for
  early status) and before a sentence or a warmup is dispatched, the worker asks
  Ollama's version (cached 30 s, dropped with the digests on any request
  error) and compares it with the verdict's; a different version marks the
  verdict stale (`stale: "ollama-updated"`), stops the request, and setup
  re-runs the check when opened — opening setup asks past the cache. The
  digest half is the engine's own check before it sends, and the warmup's.
  Their ordinary 30 s cache is unchanged. The optional fourth lookup argument
  `{fresh:true}` bypasses and replaces a successful cached observation for setup
  refresh, the speed-check probe and `SETUP_VERIFY` after the completed pull.
- **The badge**: `!` on the toolbar icon when Proofer is on but cannot work —
  Ollama not answering, the engine missing, the check needed again — with the
  reason as the title; nothing when all is well or the user turned it off.
  Updated at worker start, on `onStartup`, on storage changes and on every
  contact/engine transition through `publishServiceState`, the pair's single
  writer. Recovery publishes even with the same engine state, while stale
  qualification/engine warnings remain. Only the configured endpoint can publish;
  an unsaved preview has no badge authority. Caller cancellation keeps its
  `AbortError` identity without publishing an outage. Chrome puts a new extension in
  the Extensions menu, so setup's ready
  screen shows how to pin it when `chrome.action.getUserSettings()` says it is
  not on the toolbar.
- **Tabs open before install** get no Proofer until they reload: measured
  (`test/inject-probe.mjs`, Chrome for Testing 145 and Brave 153),
  `scripting` plus the `<all_urls>` content-script matches does NOT grant
  `executeScript` into an open page — only `host_permissions` do — and the
  extension does not request broader ones. The ready screen says so, and
  the popup says "reload it" on such a page.

### The transport registry

Two decisions used to be tangled in one Slate check, and they are not the same
decision. A **fingerprint selects an adapter** — which write mechanism this
editor takes; it is cheap and structural. A **certificate grants authority** —
whether we may write silently here; it is curated and revocable. Extending a
single check that did both felt like whack-a-mole because each new editor needed
a new mechanism decision *and* a new trust decision.

SN_TRANSPORTS in content.js is the table, ordered most-specific-first, and each
row is backed by a row of test/sentence-editors-test.mjs:

| Fingerprint | Text recipe | Caret policy | Family |
| --- | --- | --- | --- |
| `[data-slate-editor="true"]` | INTENT; synchronous cancellation required | in-recipe | Slate: old capture accepts, current capture safely refuses |
| `.ProseMirror` | MUTATION | checked arithmetic | ProseMirror (also matches TipTap) |
| `.ql-editor` | MUTATION | checked arithmetic | Quill |
| `[data-lexical-editor]` | MUTATION | **re-imposed after the editor reconciles** | Lexical |
| `.public-DraftEditor-content` | MUTATION | checked arithmetic | Draft.js |
| `trix-editor` | MUTATION | checked arithmetic | Trix |

Draft and Trix are ordered last deliberately, and safely: `.public-DraftEditor-content`
is a class no other editor emits and `trix-editor` is a custom element, so
neither can be an ancestor or descendant of another registry match and the
nesting rule settles them without registry order getting a say.

CKEditor 5 was measured against both recipes and **refused**; it is recorded in
Known limitations so the measurement is not repeated.

A textarea is not a transport: it has no model to disagree with its own value
and keeps its direct path.

INTENT sets the DOM range and, in the **same tick with no await**, dispatches a
synthetic `beforeinput` carrying `insertReplacementText` and a `StaticRange` in
`targetRanges`. It reads **that event's `defaultPrevented` synchronously** when
`dispatchEvent` returns. An uncancelled event returns `failed-transport` /
`untrusted-rejected`, restores the original DOM anchor/focus nodes, offsets and
selection direction (or empty selection), and removes all five capture listeners
in `finally`, before any task can deliver a user key. Its window is null and
there is nothing to replay. Apply and Escape undo share this recipe. The caller
records `sentence-skipped:splice-failed:untrusted-rejected`, counts the same
reason and blocks only this element as `write-rejected`; it does not demote Slate
or count a written/misplaced outcome. The popup explains that the editor did not
accept input from Proofer. A rejected undo keeps `sentence-undo-reconciled` and
counts `undo:failed-transport:untrusted-rejected`.

If the editor cancels, the established range, verification, caret and replay
path is unchanged. Slate reads `getTargetRanges()` and calls `Transforms.select`;
the same-tick DOM selection also covers its dirty-node-map branch, which skips
the target range. MUTATION sets the range and calls `execCommand("insertText")`,
then restores the caret by checked arithmetic. It is not a fallback for Slate.
Chrome 145 emits a trusted **input**, no beforeinput, for that call; both measured
Slate builds revert the foreign DOM edit on the next key.

**Trust is now an axis for Slate.** slate-react 0.128.0 added the early
`if (!event.isTrusted) return`, retained by the live 0.132.0 source fingerprint.
The old 0.126.3 capture cancels and accepts INTENT; the second 0.132.0 capture
ignores it. DOM fingerprints are identical and cannot choose between them.
The invariant comes from published source, not from a version test in production:
all 201 stable hooks-era releases 0.50.0–0.132.0 cancel handled, non-native,
non-composition insertions synchronously (0.66.2–0.66.7 cancel after their switch).
The legacy source audit covers another 172 stable releases. Native one-character
`insertText`, composition, Android input managers and custom callbacks are
separate branches; Proofer sends a cancelable desktop `insertReplacementText`.
A custom callback that writes without cancelling is outside this invariant.
The detailed historical source tables, hashes, excerpts and raw measurement
artifacts are excluded from the public snapshot. The checked-in
[Slate suite](test/sentence-slate-test.mjs) exercises the two preserved builds,
including acceptance and safe refusal; it does not reproduce the full historical
source audit.

**The registry lookup is itself a boundary.** A fingerprint match counts only if
its host sits inside getEditableRoot(el), because closest() walks straight
through a `contenteditable="false"` node view and getEditableRoot stops at one.
Without that clause an editor with no registry row, hosted inside one that has a
row, inherited the outer family's adapter and eligibility answered ok — naming an
editor that had never been measured. All six certified families leaked.

A caret policy is part of the transport rather than part of the recipe, and
Lexical is what shows it: its text behaves as MUTATION while its selection
behaves as INTENT. The checked arithmetic succeeds — the caret reads the
intended offset synchronously — and one task turn later Lexical has reconciled
and re-imposed its own. Re-setting it after reconciliation holds. That is one
field and one post-reconcile re-set, not a second splice.

**The recipe is chosen from the fingerprint before any write, and only that
recipe ever runs.** "Try one, and if nothing happened try the other" is not a
safe fallback: a handler can queue a model update and leave the DOM unchanged
long enough to read as a no-op, after which both writes land. Before the
synchronous cancellation guard, INTENT also swallowed keys and replayed them
through the ignored transport: Draft lost 4 characters over 8 burst trials and
Trix 5. The new guard closes that uncancelled-event window, but does not certify
INTENT for those editors or make trying transports safe. Trix's input controller
also read a null dataTransfer and threw inside the host page in 8 of 8 measured
trials, idle and burst alike.

**A MUTATION write is narrowed to the span that differs, and it checks its own
result.** Replacing all of a block's text is a *node*-level DOM mutation — the
browser empties the text node the editor is managing rather than editing its
data — and two certified families reconcile that away silently, in opposite
directions. Lexical drops the write outright: execCommand returns true, the DOM
never changes, and the typo stands; measured 6 of 6 at every delay from 0 to
600 ms after the last keystroke, and it lands with a single character of tail at
either end, so the *coverage* is the variable and timing is not one at all.
Draft duplicates the corrected block over the next one, destroying a paragraph.
A sentence that fills its block is the ordinary shape of a chat message, and
through the pipeline it was 0 of 8 on Lexical — the write vanished and the field
blocked for the session — while every scenario in the editors suite passed,
because every one of them typed a tail first. `narrowEdit` trims the common
prefix and suffix so the write stays an edit *inside* the node, keeping both
sides non-empty (a zero-length range cannot be built, and an empty insertText is
a beforeinput carrying no data, which no family was measured on) and never
splitting a surrogate pair. The preconditions — staleness and uniformity — are
still asked about the whole sentence, so this narrows what is *written* and
nothing about what is allowed.

Narrowing is a mitigation and not a proof: a correction changing both the first
and the last character still covers the block. So the recipe now verifies its
own result before reporting a landing, the way INTENT always has, and reports
`ignored` / `normalized` / `misplaced` on the same epistemic split. It is a
synchronous check because the failure is synchronous — across all six families
every write that lands is in the DOM in the same tick, and both failures are
already visible in it. Previously it returned `landed` on execCommand's boolean
and the caller read the same failure one frame later as `reconciled-sync`: a
claim that the page had thrown our write away, when nobody had observed any such
thing.

### Segmentation and trigger

content.js uses Intl.Segmenter plus custom handling for abbreviations, URLs,
quotes, lowercase sentence starts, and trailing fragments. Each tracked field
has a watermark: text before it has already been considered. Focusing an
existing draft derives the watermark from live text so old completed sentences
are not replayed.

A sentence becomes eligible when any of these holds:

- three characters have been typed beyond its terminator;
- a newline follows the terminator, which fires immediately;
- on a contenteditable, the sentence is finished and nothing follows it — the
  chat-client case, where Enter sends the message rather than adding a line, so
  no further evidence is ever coming; or
- input has been idle for 600 ms.

**Trailing whitespace is not evidence on a contenteditable.**
buildSegmentsForElement synthesises a newline per block boundary including the
last one, so a rich editor's text ends in one whether or not anybody pressed
Enter — and Draft, which wraps each block twice, ends in two. Read as typing,
that phantom made `newline` the only reachable trigger on all six certified
families: `The techncian arrived early.` returns null on a textarea and fired as
`newline` with the trailing newline a contenteditable always has. So the
sentence went out with no look-ahead while claiming the strongest evidence
there is, the weak-boundary refusals below were bypassed outright, and the
trigger label — which one guard reads — was wrong for every correction the mode
made there. The trailing run is now stripped before the evidence is read, which
also stops it counting as a character the user typed; a textarea is untouched,
because there the newline is a keystroke.

A sentence with no look-ahead — nothing follows the terminator — refuses any
boundary the next character could still overturn, and refuses by *waiting*: the
watermark does not advance, and the sentence is reconsidered as soon as typing
resumes. Three shapes qualify: a trailing abbreviation or initial
(`Please refer to Fig.`), an unclosed quote or bracket, and a period with a
digit immediately before it (`The reading was 176.`), which is a decimal point
whenever the next character is a digit. This test is asked wherever the
look-ahead is missing, whichever scan arrived — it used to be asked only on the
idle timer's path, which is the gap the phantom newline walked an abbreviation
straight through. Where the segmenter did have look-ahead, its decision stands.

**A sendable target is deferred, not sent, while the caret sits inside it**
(2026-09-15). Immediately before `fireSentenceRequest`, and only once a
provenanced target exists, the scan reads the caret and asks the delivery
anchor's own three questions through the shared `sentenceCaretRefusal`: no
caret → `pre-send:no-caret`, a selection → `pre-send:selection-active`, caret
strictly before `end` → `pre-send:caret-inside`. A deferral returns without
moving the watermark, the `weak-boundary` shape. Strict `<`, because the
contenteditable last-sentence trigger fires with the caret exactly at `end`.
The delivery anchor would have refused the same target as `anchor:caret-inside`
— after a model call, and after the post-response step had advanced the
watermark to `job.end` on a still-matching prefix, so a caret that merely moved
into a finished sentence *retired* it. One recorded burst: eight requests in
eleven seconds for a sentence being rewritten in place. Resumption is part of
the mechanism: the caret leaves with an arrow or a click and fires no `input`,
so a coalesced `selectionchange` listener re-arms the idle scan once while a
deferral is outstanding (`caretHeld`), and that scan re-reads caret and
provenance like any other. Delivery anchoring is unchanged.

Four input paths reject the current offsets and re-derive the watermark rather
than sending text: a paste/drop/undo input type, an edit touching more than
eight characters, an edit anywhere before the watermark, and an edit that lands
against the watermark instead of on the whitespace gap it must sit on. The last
is what keeps a continued sentence from being proofread as if it were whole.

All four are input handlers, and a page assigning `el.value` fires no event for
them to run on. Wherever time passes between one input event and the next scan,
none of them has run. Three such routes were measured, all reproducing: the idle
timer, armed by a keystroke and firing up to 600 ms later (8 of 8, two mutation
shapes at +50/+200/+400/+500 ms); a tail mutation while a request is **in
flight**, sent by the scan chained straight off the response with no timer
involved; and an **unfinished** injected sentence, which no watermark movement
puts behind us, completed into eligibility by one later keystroke. In each case
the page's text reached the model *and* had a correction written back into it.

So the scan asks the provenance question directly, before every send. Two pieces
carry it, because one cannot.

**`observedText`** is the field as of the last thing the extension can account
for. The list of sites allowed to write it is the invariant, and it is shorter
than "wherever an event arrived":

- the input path, **after** classification — ordinary typing adopts directly; a
  bulk-classified edit adopts only behind a fence (below). Adopting before
  classification was a hole rather than a simplification: a page-called
  `execCommand` arrives *trusted*, so a >8-character injection was accounted for
  by the time the size guard said it had not been typed;
- a trusted `beforeinput` on the tracked field, which adopts **nothing** on
  trust: it starts a settle poll from the *existing* baseline, so whatever
  appeared since is measured in full and fenced if it clears the size cap. This
  is what covers an editor that cancels the browser's default and applies the
  edit itself — see residual 5, where relying on `input` alone took Slate to
  0/6 corrections;
- `compositionend`, once per session. The input path deliberately skips every
  intermediate composition state, so without this the first scan after
  committing Japanese would refuse the whole field. Both composition handlers
  check `isTrusted`, and composition events cannot be synthesized as trusted;
- a write of our own that verified — and these **derive** the new value from the
  old one rather than reading the field back;
- the baseline taken on focus, which is a **trust boundary**, not evidence of
  authorship. See below.

It is deliberately not the same value as `lastText` — that one is the edit-size
baseline and is refreshed from the whole live field by `setWatermark`, tail
included, from callers that validated only the first `job.end` characters. Using
it reported equality on exactly the in-flight route.

**Our own writes derive rather than read back**, and this rule cost three
separate fixes because it is the same bug in four places. A page that changed
the tail after `job.end` still passes the anchor check, so reading the field
back adopts its text. The sentence apply derives from a baseline captured
*before* the splice is awaited — the Slate INTENT window yields what it cannot
replay, and a yielded Backspace fires a real `input` that re-baselines from a
DOM already containing the correction, so applying the delta at completion would
produce text that was never in the field. (Swallowed printable keys are not
involved: the guard calls `preventDefault` on their `beforeinput`, so no `input`
event is produced.) The Escape undo derives too, and adopts only when the field
matches exactly — the undo's expectation is built from live text because that
is the right question for the *transport*; it is the wrong one for provenance.
(The removed manual apply derived the same way, for the same reason.)

**A provenance floor** covers what re-deriving cannot. Re-deriving puts every
*completed* segment behind the watermark; an unfinished trailing segment is left
ahead of it on purpose, so a half-written draft still gets proofread when the
user finishes it. For injected text that is the leak, and it cannot be closed by
moving the watermark to the end — that would put it hard against a character
instead of the whitespace gap it must sit on, and the next keystroke would trip
`boundary-edit` and re-derive it away. Instead the offset is recorded, and any
target *starting* before it is refused as `unprovenanced` however well-formed
the user later makes it. The refusal is scoped: the scan advances past those
sentences in the same pass, the floor retires once the watermark clears it, and
a sentence typed after the injection is still corrected.

The floor is an offset, so it **moves with its content**. An edit before it
slides the text it marks without changing the number, and left untransformed
that is a bypass rather than a rounding error: install a short unfinished
sentence (floor 22), insert a *longer* sentence at position 0, and the user's
own sentence — starting below the floor — is refused and advances the watermark
to 33, retiring a floor the injected fragment has meanwhile slid out from under.
The same prefix/suffix diff the size guard already computes transforms it: an
edit at or after the floor leaves it alone, an edit entirely before it shifts it
by the length delta, and an edit straddling it takes the conservative answer,
the end of the changed region.

The bulk branch **fences before it adopts**, for the case re-deriving cannot
reach. Its cost is deliberate and falls on genuine pastes as well as on
injections, because size is the only discriminator that path has: a sentence
containing pasted text is not proofread, though sentences typed after it are.
A user sentence typed *in front of* unaccounted text is refused for the same
reason — visible in the suite, where `[P3g]` sends nothing at all until the
floor is cleared. That is the standing asymmetry, not an oversight: a refused
correction leaves a typo alone, an accepted one rewrites text nobody typed.

The check is not gated on the idle path. An earlier revision gated it there and
justified that by saying the other callers were only reachable on rich editors;
that was wrong, because `resumeSentenceScan` re-arms the idle timer after every
response and every apply, and a page that appends three characters past its
injected terminator is fired **immediately** by the chained non-idle scan, which
an idle-gated check never inspects.

Neither backstop moved. The eight-character edit cap and the bulk input-type
list are untouched, because neither can reach a mutation that fires no event —
and trust cannot either: a page calling `execCommand` emits an `input` event
with `isTrusted` **true**, so it is the size cap and not the trust bit that
refuses that shape.

`test/sentence-provenance-test.mjs` pins all of it, including the control that
matters most: the same field contents *typed by the user* are still sent and
still corrected. Each decision is held by a mutant, so none of it is decoration.

**Residuals — what this does NOT close.** Provenance here is a bound, not a
proof, and the list is exhaustive as far as two audits reached:

1. **A sub-eight-character mutation merged with a keystroke.** Observe
   `The report is good. Th`, let the page change `good` to `godo`, let the user
   type `e`: the combined span is seven characters, under the cap, and it
   arrives as **one event**. Provenance cannot separate two edits delivered
   together, so this is bounded by the size cap rather than closed. The same
   shape exists on the `newline` path.
2. **Trust on focus.** Text already in the field when it is focused is trusted
   as the user's, because the watermark-plus-runt design exists precisely to
   proofread a half-written draft that was there on arrival. So a page can
   install unfinished text, wait for a blur and refocus — which tears the whole
   attribution state down, floor included — and the fragment is trusted again.
   This is a **trust boundary**, deliberately, not a claim about authorship; the
   backstops that still apply are the ones that never depended on attribution:
   the output guards, and the durability watch on anything silently applied.
3. **Prior context is not floored.** The floor governs which sentence may be
   *written*; up to 2,500 characters of preceding text still travel with a
   legitimate target, so page-authored text can reach the model as read-only
   context. Bounded — only the target sentence is ever written back, and context
   is never echoed into the field — but not inert, since context exists to steer
   an ambiguous correction. Asserted rather than hoped for, in `[P3b]`. A
   context floor is a possible follow-up and is not in this change.
4. **A page mutation during an IME session** is committed with the session at
   `compositionend`, because at that point the two are no longer separable.
5. **Rich editors were the sharp edge, and the first version of this shipped
   broken.** It was written up here as an unmeasured risk — "an editor that
   normalizes on every input could refuse every scan" — and then the Slate gate
   measured it as a total failure: corrections went from 6/6 to **0/6**. The
   cause was worse than normalization. slate-react takes the browser's native
   edit path only for `insertText` whose data matches `/[a-z ]/i` over a
   collapsed selection; for anything else — **a period** — it calls
   `preventDefault()` on `beforeinput` and applies the edit through its own
   model, so **no `input` event is ever fired** while the DOM changes anyway.
   Every letter of `The techncian arrived early` delivered an event and the
   terminator delivered none, so every sentence completion read as an
   unaccounted mutation.

   `beforeinput` is the evidence that survives an editor cancelling its own
   default: trusted, unforgeable by a page, and fired whether or not the browser
   performs the edit. It says only *the user is editing this field*; what they
   typed is read afterwards, by the same settle poll, and is still size-bounded.
   The remaining exposure is a sub-threshold page mutation landing inside that
   ~30 ms window, which merges into residual 1 rather than opening a new one.

   Two lessons are worth more than the fix. A page assigning `.value` and a rich
   editor applying the user's own keystroke are **both** invisible to an `input`
   listener, so `input` alone was never a provenance signal — it only looked
   like one on a `<textarea>`. And no offline suite could see it: a
   Slate-*shaped* fixture has no model to cancel anything, so the browser
   applies the period natively and the event arrives as normal. The provenance
   suite stayed 55/55 and the typing suite 135/135 through a mode that had
   stopped working on every real Slate editor. `sentence-slate-test.mjs` is the
   only thing that caught it, and the change map requires it for exactly this
   reason.

   What is still claimed only as *named, not silent*: if a provenance refusal
   does happen, it lands in `sentenceSkip` as `unprovenanced` or
   `unseen-mutation`, is persisted under `sentenceSkips`, returned by
   `GET_LOG_STATS` as `sentence.skips`, and rendered in the popup. That last
   step had to be added — the counters existed and nothing displayed them, and
   the sentence line was blank whenever no sentence had been sent, which is
   exactly the state this failure produces.

7. **The async write verifier had the same blind spot; FIXED 2026-09-09.** It
   decided whether the page threw our correction away by asking whether a
   trusted `input` arrived since the write — so on Slate a user typing a
   terminator inside that 600 ms window was invisible, the tail looked
   page-rewritten, and the field was blocked as `reconciled-async` for the life
   of the content script, silently, with every later sentence in that composer
   unserviced and unlogged. It was the largest single failure class in a month
   of real traffic: 35 reconciles, 30 of them Discord, none a textarea.
   It now consumes the provenance observer's own conclusion rather than running
   a second listener — `noteSentenceUserEdit` records what the field held once a
   trusted edit settled, or `null` where the observer could not account for it,
   and the verifier turns `null` into `sentence-applied-unverified` rather than
   a block. A user edit does not end verification: the later samples stay armed,
   so a page rewrite arriving after it still blocks. `doSentenceUndo` had the
   same defect in its own form and both paths now share
   `sentenceWriteDisposition` (`verified` / `unverified` / `reconciled`, with
   `landed` computed first so a noisy window cannot downgrade a write that
   landed). Gated at the caller on real Slate: `sentence-slate-test.mjs` [15]
   and [16] — since 2026-09-15 timed against the measured apply and asserting
   the full per-request verdict list — plus [19b]/[19c] in the typing suite.
   Failed undo now has its own outcomes: typing [2d] pins a discarded undo,
   and Slate [16b] proves restoration then a trusted replay reaching the
   unverified undo exit without announcing success.
   What remains is three message-final Discord reconciles that look like
   Enter-to-send inside the window; `snVerifierTrace` (console, text-free,
   `sentenceDebug` only) is the instrument for distinguishing a send from a
   draft clear, navigation or remount before changing the verifier.
6. **The pre-write baseline capture for the Slate INTENT window is argued, not
   measured.** Its mutant passes the whole suite, because a textarea splice has
   no awaited window to interleave with. Reaching it needs a real Slate editor
   and a yielded action inside a ~30–60 ms window after a 250 ms pause.

IME composition does not re-derive on each input: it marks the in-flight job
dirty, cancels the idle timer and returns, so typing resumes in place. The
re-derive happens once at `compositionend`, together with the session's single
provenance adoption. Only one sentence request may be in flight per frame;
collisions are skipped rather than queued.

The job snapshot contains its request ID, element, start/end offsets, exact
sentence, the byte-exact prefix through the target, capture time, and the
trigger that made the sentence eligible. Up to 2,500 characters of preceding
text are sent as context.

The trigger travels with the request, is written to the log record, and one
guard reads it. It names the evidence, not the timer: `newline`,
`next-sentence` (three characters typed past the terminator), or `idle` (only
the pause says the sentence is finished) — the distinction matters because the
idle timer also picks up sentences the user has typed past, whenever a keystroke
scan was skipped. The worker validates it against a fixed allowlist; anything
unrecognised, and a content script old enough not to send it, records null and
takes the pre-existing path. The guard is **idle-final-inflection**: on an
idle-triggered request only, an edit whose single lexical change is an
inflection of the final token is refused.

### Worker validation

The sentence path has its own prompt, few-shot set, fixed 2,048-token context,
20-second timeout, and literal rewritten response key. Prior writing is
JSON-encoded into the system turn and the target sentence remains the bare
user turn.

**The sentence engine.** `runSentenceEngine` is one sentence through the
request, the guards, the guard-informed retry and the deadlines — everything
SENTENCE_REWRITE does between "consent says yes" and the reply. It never sends,
records or reads consent on its own: the caller passes `checkAllowed` (asked
before the retry's send and again before delivery) and gets back
`{payload, meta}`. The message handler runs it, the quality suites run it
(`test/lib/scoring.mjs` callSentence, through the file itself), and setup's
timing test is to. Extracted 2026-09-25 because the suites had a caller of
their own — a 120 s timeout, no retry, a truncated reply accepted when its JSON
parsed — and scored outcomes the product never delivers (checkpoint 1).

Before it sends, the engine asks `/api/tags` which digest is installed under
the requested tag (`installedModelDigest`, cached per URL for at most 30 s and
dropped whenever a request fails; setup can require a fresh read without
changing ordinary sentence/research callers). A copy under the pinned tag with
another
digest is refused as `model-mismatch`, a missing one as `model-missing`, and
one that cannot be verified at all as `model-unverified` (or `unreachable`,
with the network flag, when nothing answered) — all without sending the
user's text. The digest seen is written on the record as `modelDigest`, so two
weights under one tag can be told apart in an export. The record's `backend`
stays null until [setup's timing test](#setup-and-the-speed-check) produces one. Then the
engine asks the caller's consent question once more, immediately before the
first send: the caller's first read came before the lookup, and a switch-off
can land during it. And every answer leaves through one helper that holds a
success to the delivery deadline, so a caller other than the message handler
cannot count a correction the product would drop. (Three findings of the
checkpoint 1 re-check: the unverified digest was let through, consent was not
re-read before the send, and the deadline gate lived only in the handler.)

The model is not a setting. Requests go to the release's pinned model,
`PINNED_MODEL` in `background.js` — a tag **and** a digest — and no stored
value can override it, so an upgraded install cannot keep
sending requests to a model it chose before. It is the Q4_K_M export of the v1
LoRA distillation of LFM2.5-2.6B that the pilot was measured as, re-published
with the LFM licence layers (the weights, parameters and template are
byte-identical; only the manifest digest differs). `docs/maintainers/publish-model.md`
records the build and the verification. `prepareSentenceRequest` still takes a
model override for the test suites (`PROOFER_MODEL`); the message handler
passes none.

The context demonstration — the extra system/user/assistant triple that
teaches the model to resolve an ambiguous misspelling from prior writing — is
appended whenever prior context exists. Until 2026-09-25 it was skipped for
model tags matching `/qwen/i`, where it was measured worth nothing, and kept for
every other model, where it was worth 15/24 → 18/24 on LFM2.5; on the pilot,
stripping it measured −8.0 safe corrections /1k, CI [−17.4, −1.4] (2026-08-24).
With one pinned non-qwen model the keying selected nothing, so it went, and the
pilot's requests are byte-identical to before
(`test/sentence-request-bytes-test.mjs`). The same 2026-08-24 round measured the
pilot's minimal training prompt (task sentinel, no demonstrations) against this
one and this one won on every quality metric: the demonstrations did not move
into the weights. The earlier q4-against-q8 comparison of the same checkpoint
(2026-09-06: q4 edits clean text more often, p = 0.019, and is faster) used
private evaluation inputs and is retained here as historical context.

Parsing precedes the guards. First-pass `truncated`, `invalid-json`, and
`no-rewritten-key` failures return `{ok:false, error:<code>}` without a
network flag or a retry; `refused` and the record's `guard` name only an actual
guard-chain decision. Early target-length validation likewise returns
`error: "target-length"`, without a model request or a record. Content resets
its network breaker, advances or rederives the watermark, counts
`worker:<code>`, and continues scanning after a model-shape error.
`callSentence` keeps its input-text fallback and result shape, reports the
error code as `outcome`, and counts truncation from `payload.error` separately
from guard refusals and other errors.

For historical records, `sentenceRecordGuard` suppresses only a matching
`guard`/`error` pair for those three model-shape codes. All stats guard tallies
and replay normalization use that reader. A genuine guard with another error
stays a guard refusal; storage and exported fields are never rewritten.
Settings [V4] and log-to-cases [7] pin this narrow compatibility rule.

After parsing, both engine attempts call `sanitizeSentenceOutput(original, raw)`
in background.js: tag stripping, markdown, asciify, then edge whitespace, in
that order. This is only a diagnostic; raw output stays separate. If sanitizing
would change the raw model answer, the answer is refused before no-op detection.
`asciify(raw, original = "")` preserves each of its six replacement families
when it occurs in the original (dashes, hyphens, apostrophes, double quotes,
ellipses and non-breaking spaces); absent families keep their ASCII replacement.
The unchanged exact non-ASCII multiset guard still refuses added, removed or
substituted characters, even within a preserved family. Accented letters are
outside asciify's character set, and tag stripping is unchanged. Faithful
corrections and clean echoes can pass on either attempt without repairing text.
`guardSentenceResult` then checks preservation of protected tokens,
capitalization, punctuation, sentence boundaries, negation, meaning-bearing
words, ordering, overlap, edit size, and related structural invariants, plus the
trigger-conditional idle-final-inflection rule. Every failed guard returns a
reason — 26 distinct ones — and no guard repairs a result.

Three of those arrived on 2026-09-06 from a month of recorded use, each closing
a leak that had passed the whole chain and been undone by hand.
**`negation-ambiguous`** refuses a negation the model reached by SUBSTITUTING a
character in a non-word when a listed non-negation sits one TRANSPOSITION away.
The existing rule ranks readings of a typo by edit distance, which at distance 1
does not discriminate; ranking them by likelihood does. A transposition invents
and discards nothing, an insertion keeps every typed character, a deletion drops
one, and a substitution is the only single edit that both discards a typed
character and invents one — so it is the only reading a transposition rival
clearly beats. Ranking a transposition above every other edit is the obvious
version and refuses ordinary typos (`canot` → `cannot`, `noe` → `no`). It is
one-directional, because landing on the wrong ordinary word reads oddly and
landing on the wrong negation asserts the opposite. **`closer-added`** refuses
an added `)`, `]` or `}` beyond the number of openers the original leaves
unmatched, counted by scanning in order — a stray closer cannot pay for an
opener that follows it, and one unmatched opener licenses one closer rather than
any number. `typographyPreserved` compares the non-ASCII multiset, so an
invented ASCII brace was invisible to it — and, in the other direction, a single
invisible character the user never typed refused the whole sentence.
**`emojiSeparatorOmission`** excuses that one case: Discord's emoji autocomplete
writes a U+FEFF straight after the shortcode it completes, the model drops it,
and the multiset comparison refuses the sentence with every real typo in it. The
excuse is scoped to exactly one U+FEFF against a shortcode that occurs once on
each side (tested with `indexOf`/`lastIndexOf`, since occurrences can overlap)
and is followed by an ordinary space; it requires that **that** separator is the
one the output dropped, and then re-asks the real typography question with the
single character discounted — so it can remove a reason and never add one. It is deliberately not a sanitizer repair: restoring
the character would make `sanitizer-would-change` compare restored text with
itself. It is deliberately not extended to zero-width characters in general
either, because U+200B, U+200C/U+200D and U+00AD all carry meaning — ZWJ joins
emoji sequences.
Name corrections use `nameLicence` over the loaded name set and `HAND_NAMES`.
`accountedNameOriginal` constructs a comparison-only original at matching token
positions; `protected-token`, `capital-removed`, and `word-substituted` consult
that view. Resegmentation separately accepts listed names on the gained side.
The five directed pairs were replaced on 2026-09-19; see the name-list discussion
below.
**`leading-word-added`** refuses a function word invented at the front of a
sentence when the first word actually changed and everything after it is
accounted for at the same offset; the gained-word guard exempts function words
on purpose, which left fragment completion unguarded, and the owner writes
fragments constantly. The same round relaxed `isRespelling` in one bounded way:
an unlisted candidate is admitted when it is solely hyphen-separated listed
CONTENT words and de-hyphenating it reproduces the original exactly, so a hyphen
may be inserted but no letter invented and no word boundary moved around a
function word.

Four of those guards were narrowed on 2026-08-15, after replaying 1282 recorded
real sentences showed each refusing a class of edit its own rationale never
claimed. Refusals over those recordings went 145 → 133, with no verdict moving
in the other direction anywhere, and with the hazard corpora unmoved (48/48
still refused, 43 recall applies and 129 clean sentences unchanged).

- **protected-token** asks PRESENCE rather than equality. Losing an identifier
  is the harm — a deleted `<@mention>`, `3x` → `3`, `S&P500` → `S&P 500` — so
  every protected token of the original must still be in the output. Absence is
  exact-token, never substring, because `3` is a substring of `30`. The first
  tolerance is a hyphen JOIN (`36 day` → `36-day`), which is why the output side
  is split on hyphens and the original side is not: that makes the tolerance
  one-directional, so a compound SPLIT apart is still refused. An added
  protected token must be accounted for by the original — every hyphen segment
  of it already a token there, case for case. Two more tolerances since
  2026-08-25, both replay-scored (32,863 recorded rows, 0 flips toward refusal):
  tokens shed EDGE brackets before comparison the way they already shed trailing
  `.,;:!?` — so `(a feature REquest).` reads as the stutter it holds — but
  never quotes (stripping them was measured to admit invented quotation and a
  corrupted quote), never markup (`__init__`, `2*3*4`), and never a token with
  INTERNAL brackets (`RV(s?)`, a deliberate pluralization hedge); and a purely
  alphabetic token whose lowercase is not a dictionary word may come back as
  exactly its own uppercase (`oS` → `OS`, `ui` → `UI`) — digit-bearing
  identifiers, real words (`us`, `it`), and inexact case (`iw` → `iW`) all
  still refuse.
- **contraction-expanded** asks whether an expansion happened, with the count
  drop demoted to a tripwire that decides whether to ask. An expansion word
  arriving (`It's` → `It is`), a lost contraction with no unique re-punctuated
  counterpart, a surviving token that is not a dictionary word (`IC's` → `ICs`),
  or a canonical contraction being replaced rather than re-punctuated (`don't` →
  `dont`, `they're` → `their`, `you're` → `your`) all still refuse. A possessive
  apostrophe moving (`worker's` → `workers'`, `Lot's` → `Lots`) applies. Two
  replacements are exempted by name, on the owner's 2026-08-15 decision:
  `BLESSED_CONTRACTION_REPLACEMENTS` holds `who's|whose` and `it's|its`, and each
  must **also** hold a CONFUSABLE licence. The licence alone is not the gate,
  because `they're|their` and `you're|your` are licensed confusables too and are
  not blessed — nothing structural separates the four, so the discriminator is
  per-pair evidence rather than a rule. The pairing is extended as well as rule 5:
  `who's` and `whose` are not the same letters re-punctuated, so the exemption
  has to supply the mate the letters test cannot find.
- **capital-added-to-non-word** exempts a token that is a word once its
  apostrophes are removed (`mother's`, `it's`) and one whose singular is also
  absent from the dictionary (`jews`), since a plural of an unknown word is an
  unknown word rather than a misspelling. `semgent` → `Semgent` still refuses.
- **terminator-changed** exempts a deletion out of the trailing run of
  terminators and closers when the run's class is unchanged (`?).` → `?)`), which
  is what the closer-stripping needed to read the terminator was throwing away.
  An emptied run classes as "" rather than ".", so a URL's own `?` deleted with
  nothing behind it stays refused.

One rule was tightened on 2026-08-20. A substituted word two or more edits from
the original must be the best available reading — no dictionary word strictly
closer — and closerWordExists asked that with the distance-1 shell alone, which
was the whole question while the edit budget capped at 2 but not once long words
got a budget of 3. The measured gap: `practiveity` → `practicality` (d=3)
applied silently while `proactivity` sat at d=2, and the user edited it back.
For d≥3 the guard now also scans the dictionary for anything at distance ≤ d−1
(a character-histogram bound keeps the scan to ~5ms, on a band real traffic hits
about 3 times per 750 sentences); `proactivity` itself was added to
data/words-en.txt, since its absence was what had emptied the strictly-closer
set. Exactly one verdict moved across 1,845 recorded rows — the damage case, to
refused — and the only other licensed d=3 substitutions on record
(`admitesyl` → `admittedly`, `temprratilu` → `temporarily`, both genuine fixes)
are pinned as apply fixtures so the band cannot silently over-tighten. The same
precedent added `intelligences`, `anthropomorphized` and `subagents` on
2026-09-15 — three ordinary words absent from both the list and its Debian
source, each a recorded correct fix refused as `word-substituted` — with an
apply/refuse fixture pair per word, a per-word attribution of the replay's
three flips, and the survey run once per dictionary (its `--compare` cannot
see a dictionary-only change). The complete word-list modification history is
in the [packaged third-party notice](data/THIRD_PARTY_NOTICES.md#datawords-entxt--scowl-20201207--wamerican).

A moved space is the one typo with no word-to-word reading, and
collapseResegmentations is what gives it one: it walks the two token arrays
positionally and drops any run whose two sides join to the same string, or to
within one edit of it, provided the lost run contains a non-word and every
gained token is a word. Both sides of that condition are asked about the run
*after* shared trailing tokens are trimmed off, so a passenger cannot supply the
evidence for the run it is riding in. Where several pairings qualify, the one
whose sides are letter-identical wins; ties keep the search order. Nothing about
the conditions is relaxed by that choice — a run with no qualifying pairing is
left in the diff for the word guards to refuse, which is what keeps
`the rapist` → `therapist` refused in both directions.

Six guards consult it, and not all with the same strictness. The word-level
three — substitutedContentWords, changedWordCount, tokenOverlap — take the
one-edit collapse, because a typo inside a resegmented run is still one
correction. The three that ask about MEANING — negation-changed,
meaning-word-changed, content-reordered — take the **exact** collapse, letter-
identical runs only: a pure whitespace move cannot have changed what the
sentence says, where a one-edit move can (`notsure` → `no sure` invents a
negation and joins at one edit). All three ask their own question first and
re-ask against the collapse only when it has already refused, so the collapse
can excuse a refusal and can never cause one. capital-removed is the guard that
still does not consult it — deliberately, because the collapse works on
case-folded tokens and that guard's
whole question is about case.

substitutedContentWords carries one more excuse of the same excuse-never-accuse
shape (2026-08-26): a lost content word whose original shows an **adjacent
lowercase duplicate** ("know know" → "know") is the commonest typo there is,
not a substitution, and was refused as `word-substituted` for as long as the
guard existed — measured at 395/1000 exact repairs admitted before, 822/1000
after, on injected doubles over certified-clean sentences. Three conditions
keep it narrow: the result must keep a copy, a run of k+1 copies excuses at
most k losses, and `REDUPLICATION_WORDS` (very, really, much, many, …) never
qualify — deleting one "very" from "very very strict" is an intensity edit,
which is exactly what the multiset multiplicity exists to catch. Capitalized
pairs ("Duran Duran", sentence-initial "Know know") are excluded by the
lowercase-exact positional check; function-word doubles ("had had", "the the")
never reach the excuse and behave as before.

The chain lives in one function, runSentenceGuards, and is read two ways.
guardSentenceResult is what production calls and returns the first failing
reason or null; guardSentenceReport returns { reason, reasons, evidence } and
asks every guard rather than stopping at the first. The two cannot disagree by
construction: each guard site calls fail(), which records the reason and answers
"stop here?" — always yes when collecting is off — and `reason` is `reasons[0]`
at every exit. An exact no-op returns early in both modes, since there is no
edit to describe.

guardSentenceReport exists because a reason string cannot be routed on: the
first failure may be a borderline one sitting in front of a hard one, so "the
sole failure is X" is a question only the whole chain can answer. `evidence`
also carries the lost-word-to-gained-word pairing that substitutedContentWords
computes and used to discard — distances, dictionary membership, confusable and
inflection status. The shipping path consumes it in exactly one place — the
retry router below — alongside test/graded-routing-study.mjs, and
test/sentence-evidence-test.mjs is the gate that keeps the two modes in
agreement. Token accounting and pairings describe the adjudicated name-adjusted
view, including when that view clears every substitution: its empty losses
replace the plain detail. `dedupExcused` carries the selected detail's explained
duplicate losses. Surface measures such as length and overlap still describe
the actual original and output.

A first-pass refusal may earn ONE guard-informed retry (2026-08-27, reworked
2026-08-28 across three external audit rounds). The retry is a second model
request, never a repair. retrySentenceRewrite gates in order: the request has
not been cancelled; its ABSOLUTE deadline —
startedAt + min(SENTENCE_TIMEOUT_MS, SENTENCE_RETRY_DELIVERY_CAP_MS minus a
250 ms delivery margin for capture→arrival and response-travel skew), the cap
mirroring content.js's SENTENCE_MAX_JOB_MS (5 s) because a retry that cannot
land before deliverSentenceResult's stale-age cutoff is guaranteed-useless
work, with the cross-file equality asserted by the retry suite — still has at
least 2.5 s remaining, checked cheaply on entry and AGAIN after the evidence
work AND the pre-send consent read (both cost real time, and a budget taken
before them is stale by exactly that much) — the consent read itself RACED
against the deadline and the abort signal, so a stalled storage read cannot
suspend the interaction and a cancel mid-read ends it promptly; the
first reason is not `low-overlap` or `sanitizer-would-change` (checked against
the already-known first reason BEFORE paying for guardSentenceReport, since a
hard first reason vetoes on its own); the full reasons list from the report
contains no hard reason either (a borderline first reason can conceal one);
the evidence names at least one token whose loss the guards could not explain;
and consent is RE-READ at the moment the second request is about to go out —
the retry is a new send of the user's text that re-arms the lease, so it
re-checks like one, the warmup's own contract; the final pre-delivery check
protects only the write. A runner-level failure inside an HTTP 200
(data.error) forgets the runner on both attempts; startedAt is captured at
request arrival before any await, so the deadline and wallMs cannot start
late by the initial settings read; a failed retry reports its own wallMs;
and a refused empty retry output survives onto the record. The final consent read
after an applied retry is raced against the same deadline: a timeout answers
the original refusal with error consent-read-timeout and the salvage
uncounted, so no storage await on a retried interaction can outlive the
delivery lease. The first pass also races every await against that arrival
deadline: settings, headers, body, dictionary readiness and final consent.
Its expiry is recorded as delivery-expired, without the network flag. The
retry's refusal fallback and service breaker keep their existing behavior.
Named residuals: the retry breaker is worker-lifetime state (an MV3 restart
clears it; the pattern that opened it re-trips within three refusals), and
retrySalvaged counts a delivery the content script never reported on at all. It then sends the SAME shipping prompt with one
system-turn line appended: "Do not change these words; keep each exactly as
written: …". The keeps are UNEXPLAINED losses only
(contentLost also holds typos the guards already paired with corrections, and
naming those forfeits the fix). When none remain, the bare-loss fallback excludes
matched corrections and `dedupExcused`, preserving legitimate function-word
losses. Licensed name corrections have already been removed by selecting the
adjudicated detail, even when it is empty. These explanations are consumed from
the evidence, never reconstructed by the retry. Keeps are JSON-encoded because
they are user text entering a system turn, restored to the typed form only when the sentence
makes that unambiguous, and capped at 4. Named residual: a pure case-only
capital-removed loses no token in the lowercased diff, so it yields no keeps
and never retries. The second output goes through the full guard chain exactly
like a first output; the constraint is advisory to the model, and the guards
remain the enforcement layer. Any retry failure — transport, parse, a second
refusal, a no-op — falls back to responding with the ORIGINAL refusal. The
request stays in activeRequests for the entire handler, so a CANCEL_REWRITE
arriving while the first response is being guarded stops the retry from ever
starting; the timeout timer stays armed through the BODY read on both
attempts — headers are not the response, and the first pass had the same gap —
with a body-read failure on either attempt calling forgetOllamaRunner, per its
invariant that a failed request proves nothing about what is loaded; and
ac.signal.aborted is checked across the remaining awaits (the dictionary load,
the final consent read), so a cancel landing in those windows is answered
"cancelled" rather than with a success the content script will ignore — a
cancel that aborts the retry's own fetch instead follows the fallback
contract and is answered with the original refusal, the retry field carrying
"cancelled". Retry SERVICE failures (timeout, unreachable, http, bad
response, runner error — not cancellation, not model-shape errors) feed a
worker-side breaker: three in a row open it for two minutes (recorded as
breaker-open) and any retry verdict closes it, because a failed retry is
folded into a refusal the content script's own network breaker reads as
health. The final consent
re-check runs after the retry, at the moment of the write, exactly as it does
after a first pass. The v2 log record means one INTERACTION holding zero to two inference
attempts: `timings.wallMs` is arrival-to-response, while `attempts` owns each
fetch/body wall, raw output, guard disposition and Ollama counters. Top-level
Ollama counters and `retry` output/timing fields remain compatibility
projections. `sentenceResultFields` runs after final delivery checks; a
consent-timeout reply still carries the original refusal, but its recorded
interaction has `error:"consent-read-timeout"`, null output/guard and both
attempts, including the accepted retry. replay-log-guards.mjs reads v2 attempts
exclusively. The legacy adapter suppresses only the specific timeout duplicate
and marks the lost accepted output unavailable; two genuine equal outputs
remain two attempts. log-latency.mjs uses that same adapter: interaction walls
are counted once, with dispatched attempt walls and token metrics in a separate
request view. Reload load counters are summed over attempts and divided by
recorded interaction wall time, never by interaction plus retry walls.
GET_LOG_STATS and the quality harness use the worker-owned `isRetrySalvaged` to report only DELIVERED salvages — a
consent-blocked one was never received, and one the content script reported
dropping is excluded too. Normalized writes reached their target and count;
misplaced writes do not. Historical post-write aliases follow the same policy.
Later rejection, reconciliation and durability failure do not undo delivery,
and a pending verdict does not require a positive report. `callSentence` passes
`sentenceResultFields(payload, meta)` without a page verdict: guard acceptance
alone cannot count an expired or output-less retry as salvaged. The popup renders it, because a salvaged refusal has `guard: null` and would
otherwise vanish from the guard-rate picture. Measured
before shipping (2026-08-26 bakeoff plus a live gate rerun after the round-one
fixes): 0 of 49 RECALL_MUST_REFUSE hazards laundered, every applied retry
adjudicated correct (e.g. `folx` kept while a dropped "an" is recovered; a
coined word kept while `it's`→`its` lands), and the conservative-instruction
variant that was NOT shipped laundered one hazard — which is why the feedback
is a keep-list, not a "be careful" instruction.
test/sentence-retry-test.mjs (53 checks; 50 before G6.5) pins the pure half offline,
including the concealed-hard-reason veto at the helper level and the
cross-file delivery-lease equality, plus [2a–b]'s licensed-name and duplicate
exclusions with the mixed duplicate/function-word fallback;
test/sentence-retry-handler-test.mjs drives the handler in a vm
with a signal-aware scripted Ollama, a scripted clock and a deferrable
storage read (request count, cancellation during the body read /
mid-retry-fetch / the final consent await, the delivery-capped absolute
deadline including a stalled body and the post-evidence re-check, consent
revoked before and during the retry, delivered-only salvage counting, record
schema ([H16] verifies serialized paths/nullability against the schema below
and measures record sizes), [H11b] arrival/body clocks, [H14a] both timeout
attempts, [T4c–d] unsent versus failed dispatch, [H15a–d]'s model-shape/target-length errors without guard attribution,
[H17]'s first-pass typography correction/echo and [H18]'s typography-preserving
retry (each pinned by an empty-original call-site mutant), and [H19–H20]'s
explained losses returning the original refusal with one
canonical attempt and `retry.outcome:"no-keeps"`,
and — its [T] cases — the installed-digest check before the send).
The retry wiring had twenty-four mutants checked red across the pair;
G1.4 adds four error/refusal mutants, one per [H15] arm.
test/retry-prompt-bakeoff.mjs is the instrument for any change to the retry's
PROMPT or sampler (2026-09-19, an experiment, not a gate): seven retry arms x N
draws on the known-answer corpora, plus every hazard's known-bad output fed in
as the refused first pass, all judged by the shipping chain, with the
sequential stop-at-first-landing policy reported beside the oracle. Its first
run: guard feedback rendered in English on a wide sampler salvages 3 of 25
eligible refusals where the shipping keep-list salvages 0, at one wrong-word
apply; showing the model its own refused draft anchors it (86% of outputs
identical to the draft) and is the worst arm. These experimental retry
variants are not shipped.

The packaged English word list supplies membership vetoes and other
dictionary-dependent checks. When it is absent, `isWord` answers false and those
checks stand down, making the guards less strict; some dictionary-backed
permissions also disappear, so not every heuristic weakens. In contrast,
data/confusables-en.txt grants licences: accepting corrupt data could permit
substituting one real word for another. Its loader fails closed on evidence
rather than on availability — it requires a 200 response, a `typed|meant` shape
on every line, a pair count equal to CONFUSABLES_COUNT, and a payload SHA-256 equal to
CONFUSABLES_SHA256, and publishes null on any anomaly, leaving only the
hand-picked pairs compiled into background.js. Verification is of the canonical
payload rather than the bytes: comments, a BOM, CRLF and edge whitespace are
normalised away first, so a checkout cannot break the load while no edit can
change a licence without colliding the digest.

A third file, data/names-en.txt (2026-09-19), is a licence of the same kind
and loads through the same fail-closed shape (NAMES_COUNT, NAMES_SHA256, a
cased-entry line shape). It holds the 10,553 capitalised entries of the SCOWL
source the word list came from — proper nouns, brands, initialisms of three
letters or more, no possessives — plus two hand names the source lacks
(`HAND_NAMES`: Anthropic, Sonoran). `nameLicence` admits a NON-word being
corrected to a listed name when: the witness is listed and three characters or
more; both or neither side carries a possessive; the original is letters only,
not a dictionary word in lower case, and not itself a name (enforced at distance
zero by the closer-name test); the lowercase distance is within the respelling
budget capped at 2 (so re-casing is distance zero: `AMerican` → `American`,
`github` → `GitHub`); and no dictionary word or other listed name sits as close
or closer to the original — the common reading always wins, so `Whles` → `Wales`
and `teh` → `Ted` stay refused and, as the pinned cost, so does `Angales` →
`Angeles` (`angles`). `accountedNameOriginal` builds the comparison-only view
the guards re-ask against (protected-token, capital-removed and, since this
change, word-substituted), and the resegmentation collapse counts a listed name
as a word on the gained side (`fro mTrump's` → `from Trump's`).
`capital-added-to-non-word` is deliberately NOT excused by the list. This
generalised the five hand pairs of 2026-09-09 into a rule; every one of that
round's fixtures still holds, and one (`FLordia` → `Florida`) was flipped to
APPLY on purpose. Measured: 8 refuse→apply and 0 apply→refuse over the four
exports (1,815 rows), both holdouts reguarded against a before-baseline with
0 new damage on error and two classifier flags on random that are both correct
name fixes on unlabelled sentences (`Brazilin` → `Brazilian`, `Shakkleton` →
`Shackleton`; owner-blessed 2026-09-20), and the resegmentation survey 49
recovered / 0 newly walled / 0 POLICY newly admitted; e2e 10/10 once the GPU
was back. test/build-names.mjs regenerates the file and the
constants; `--check` exits 1 on drift.

Three narrow `protected-token` tolerances followed on 2026-09-20, from the
same inventory (that guard had blocked 22 correct fixes per 3 damages caught),
each one-directional like the hyphen join: a held shift on a **canonical
contraction** (`THat's`, `DOn;t` — `isShiftStutter` now recognises
`[A-Z][A-Z][a-z]+['’;:][a-z]+` whose lowercase is in `CANONICAL_CONTRACTIONS`;
`IT's` has no lowercase run before the apostrophe and stays protected); a
**caps-lock slip** (`aCTUAALY` → `ACTUALLY`, `cAPABILITY!` → `CAPABILITY!` —
one lowercase letter then three or more capitals, witnessed by the ALL-CAPS
uppercase of the token or of a respelling of it, which the acronymization
rule could not see because it wants the whole token's exact uppercase and
skips listed words); and a **space moved next to a number** (`3hours` →
`3 hours`, `2.5 -3` → `2.5 - 3` — the digit run witnesses a digits-then-word
token when the word is listed, two letters or more, and an output token, so
`3x` → `3 x` is refused as the recorded `3x` → `3` damage is; a dash-then-
digits token is witnessed by its digits only when a bare dash survives, so a
dropped minus sign stays refused; the resegmentation collapse counts a bare
number as a word on the gained side, on an exact join only, since the one-edit
form would also explain `covid-19` → `covid 19`). Measured: 7 refuse→apply and
0 apply→refuse over the four exports, exactly the inventory's rows; both
holdouts reguarded against a before-baseline 0 new / 0 repaired; survey
0 / 0 / 0; nine production mutants each red on its own fixture; e2e 10/10.

The accidental mid-sentence capital followed the same day, item 3 of that
batch and the one the inventory called hardest (`Bob`, `Will`, `May`, `Grace`
are names AND common words). It was **priced before it was written**: a census
of the four exports found 296 mid-sentence Title-case tokens whose lowercase
is a dictionary word; the model lowercased 9, all nine accidental, and left
`Fable` (34), `Opus` (22), `Codex` (14), `Still Point` and `Just Do It` alone
every time. `accidentalCapitalOriginal` is a comparison-only view like the
name view — `capital-removed` re-asks its whole predicate against it and it
can remove a reason, never add one — that lowercases a token only when: its
lowercase is in `FUNCTION_WORDS` or `ACCIDENTAL_CAPITAL_EXTRA` (adverbs,
determiners, wh-words; **no verbs**, because `I did one Make a plan run` is a
quoted title on the record) and is neither a calendar name nor a listed name
(`Will`, `May`); it is not sentence-initial, where "sentence-initial" includes
following a URL; **neither neighbour is capitalised** (the pronoun `I`
excepted) — every deliberate function-word capital on the record sits beside
another capital; and the output token is the original's exact lowercase,
edges included. Content words stay refused and the cost is stated: `Air`,
`Apply`, `Two`, `Investing` were accidental on the record and are the same
shape as `Fable`. Measured: 4 refuse→apply and 0 apply→refuse over the four
exports (three refused rows and one recorded `sentence-dismissed` row that
the current guards had been refusing and now apply again); both holdouts
reguarded 0 new / 0 repaired; survey 0 / 0 / 0; eight production mutants
each red on its own fixture; e2e 10/10.

### Third-party build inputs and provenance

These files belong to the source repository and are not included in the
runtime package. Their licences apply when those source files are redistributed.
The build inputs below are read by `test/build-confusables.mjs`; the running
extension never fetches them.

#### `test/data/confusion_sets.txt` — LGPL-2.1-or-later

The unmodified upstream LanguageTool file, header intact. Same copyright and
licence as `data/confusables-en.txt`; the licence copy is
[data/COPYING.LGPL-2.1](data/COPYING.LGPL-2.1).

#### `test/data/cmudict-subset.txt` and `test/data/cmudict-LICENSE.txt` — BSD-2-clause

A subset of the CMU Pronouncing Dictionary — only the ~1,400 words
`confusion_sets.txt` mentions — used to decide which confusion pairs are
homophones. **No CMUdict data is shipped in the extension**; pronunciations are
consumed at build time and only `typed|meant` pairs are emitted.

| | |
|---|---|
| Upstream | [cmusphinx/cmudict](https://github.com/cmusphinx/cmudict), `cmudict.dict` |
| Pinned commit | `74790861f652b15e4ac49015a90074ad62a27690` |
| Copyright | © 1993-2015 Carnegie Mellon University. All rights reserved. |
| Licence | BSD-2-clause; full text in `test/data/cmudict-LICENSE.txt` and reproduced in the subset's own header |

CMU's licence requires the copyright notice, the list of conditions and the
disclaimer to be retained with redistributions of source, and states that the
contents of the dictionary file are deemed to be source code — so the full text
is reproduced at the top of `cmudict-subset.txt` itself rather than referenced.

#### `test/data/SOURCES.json`

Upstream commit SHAs and the SHA-256 of every fetched byte, written by
`node test/build-confusables.mjs --fetch`. Nothing is fetched from a moving
branch ref, so an audited snapshot can be identified and recreated later.

#### Word-list provenance

See [docs/data-provenance.md](docs/data-provenance.md) for the word list's
`wamerican 2020.12.07-2` and SCOWL provenance. The exact retained source and
licence texts matter: a dictionary from another system release may differ.

### Delivery and editor writes

Before delivery, content.js rechecks that:

- the element is connected, focused, and not session-blocked;
- the exact prefix and target sentence are unchanged;
- the caret is collapsed after the target (the same three questions the
  pre-send deferral asks, through one helper);
- no IME composition is active; and
- the job is no more than five seconds old.

Full language/editor/read-only/size eligibility is checked when the field is
attached, not repeated at response delivery.

A correction is written behind the caret, the changed words flash, and one
anchored Escape-to-undo record is kept. A user edit or exact revert of the
corrected span is recorded as feedback from the provenance observer's settled
trusted-edit receipts. Only the current track and watched element can arm its
two-second settle; the live field must still equal the receipt's text and its
sequence must remain current. A null receipt cancels pending attribution, and
an eventless page mutation cannot become the user's final text. The watch keeps
its stable-prefix and span checks, duplicate suppression and thirty-second
expiry; a weaker `user-edited-correction` can still become terminal
`user-reverted`. Undo, blocking, detachment and replacement tear the watch down.

A correction that only *deletes* has no changed words to flash — what changed is
a gap — so the flash falls back to the word that closed up over it, taken off
the same forward diff. Without that fallback a silent deletion showed nothing at all, which on the one path that
writes unattended also hides that Escape has something to take back.
(Suggestion mode's amber mark and Apply/Dismiss chip went on 2026-09-24.)

Undo stops the apply verifier before its own splice and shares the verified-first
`sentenceWriteDisposition` check. At that check, a discarded undo reports
`sentence-undo-reconciled`; an uncertain restoration reports
`sentence-undo-unverified`. Escape remains a
rejection in either case; only `sentence-undone` announces a verified restoration.
Transport failures use the shared `spliceFailurePolicy` and
`reportSentenceSpliceFailure`: normalized or misplaced undo mutations report
`sentence-undo-unverified`; ignored/rejected dispatches report
`sentence-undo-reconciled`. Preconditions preventing dispatch retain their
existing behavior. Block explanations describe a Proofer write, since either
an apply or an undo can be replaced, normalized, misplaced or rejected. Typing [2d] and Slate [16b] pin the failed
undo callers; old apply-named records retain the meanings in the outcome table.

On a contenteditable the flash is painted with the **CSS Custom Highlight
API** — Ranges registered under names that styles.css matches with
`::highlight()` — so they track the text rather than a rectangle, and geometry
is not a teardown condition there. A textarea keeps the mirror overlay, and the
overlay is also the fallback when the API is absent or no usable Highlight can
be built. Because `::highlight()`
matches by registered *name*, the name is a cross-file contract that a page can
collide with: the watchdog re-asserts every frame that the registered name still
holds our own Ranges.

Both Highlight and overlay guard the text through the supplied **undo anchor
end**, resolved once by `flashSentenceRanges` as the maximum of `anchorEnd` and
the painted-range ends (range-only when no finite anchor is supplied). Editing
an unchanged later word in the sentence must clear either mark; appending after
the anchor can preserve it. The overlay checks this prefix on input and retains
its alignment, scroll and resize rules plus the geometry watchdog for its fixed
rectangles.

The Highlight path also checks each Range's start offset against the offset it
was armed at, since a byte-identical duplicate inserted earlier leaves every
string comparison satisfied while the live Range has moved. Its rAF watchdog
checks text and registration each frame; the expensive anchoring check is gated
on a MutationObserver dirty flag, because editor normalization is a mutation
with no input event behind it and a capture-phase input handler cannot see it.

A framework re-render is deliberately **not** a teardown condition. Removing a
node relocates every live Range boundary inside it onto the parent, so a React
composer swapping a text node for an identical one leaves the Range collapsed
and empty while the characters on screen do not move — indistinguishable, to the
frame check, from the user having retyped the word. The frame check therefore
reports a *cause* rather than a boolean, and every cause but a name collision is
offered to a repair that rebuilds each Range from the offset it was armed at.
The repair is what separates the two, and it does so by requiring the **whole
field** to be byte-identical to the last text the anchoring check passed on —
not merely the same characters at the armed offset, which is byte equality
standing in for identity and which a byte-identical duplicate inserted earlier
satisfies. An unchanged field is what makes every offset still mean what it
meant, and the undo record is a fixed `{start, endAfter}` pair in text-offset
space, so that is the whole claim it needs. A real edit, an aliased duplicate,
or any other text change therefore clears the mark as before.

Every splice first refuses ranges that cross formatting, block boundaries or
non-text structure, whatever the recipe. For textareas the splice uses
insertText and restores the caret and scroll. For a MUTATION editor it sets the
range and inserts in one tick — there is no window, so those writes apply
immediately rather than waiting for a pause. For Slate it sets the DOM selection
and dispatches the target-range beforeinput in the same tick, then checks its
cancellation before yielding. Uncancelled dispatches restore selection and end
without a guarded window. Cancelled dispatches let Slate own the edit; the
established caret restore and keystroke replay follow.

There is no window in front of an INTENT write. The window behind an **accepted**
dispatch is what the swallow/replay machinery protects. It buffers printable
text and yields actions it cannot replay when the caret is provably the user's.
Otherwise it cancels the unsafe action; clicks and composition always yield.
A transport that ignores synthetic input must be refused before entering that
wait, since it also ignores replay. Waiting to report `ignored` lost user
characters on the current Slate build, 5/8 bursts in the pre-fix paired bench.

Verification of an accepted INTENT write is polled — one task tick, then every 5 ms to a
30 ms ceiling — because there is no synchronous or microtask checkpoint at which
the DOM shows the correction. The write then compares the field against the
exact expected string before reporting a landing.

A splice returns a structured outcome rather than a boolean, because a
precondition refusal and a transport failure used to be the same `false` and
their correct responses are opposite:

| Outcome | Reasons | Response |
| --- | --- | --- |
| refused-precondition | no-adapter, splice-in-flight, not-writable, no-range, stale-range, non-uniform-range, no-selection, no-static-range | skip this sentence, leave the field enabled |
| refused-precondition | detached | apply: keep the skip verdict; tear down the removed field and report `field-detached`, preserving newer attachments and withdrawn consent |
| failed-transport | untrusted-rejected (uncancelled INTENT, synchronous exit), ignored (accepted transport, no write observed), execcommand-false | apply: `sentence-skipped:splice-failed:<reason>`; undo: `sentence-undo-reconciled`; block this field with `write-rejected` |
| failed-transport | normalized (our span was honoured, surrounding text changed) | apply: `sentence-written:splice-failed:normalized`; undo: `sentence-undo-unverified`; block this field with `write-normalized` |
| failed-transport | misplaced (the field changed without honoring our span) | apply: `sentence-written:splice-failed:misplaced`; undo: `sentence-undo-unverified`; block with `wrote-elsewhere` and demote the family |
| landed | verified against the exact expected string | proceed |

A splice returns only those three, and carries a `window` record
(`userEdited`, `yielded`, `replayed`, `blocked`) that the caller uses to decide
whether verification is attributable at all. `not-durable` is a fourth *outcome
of the write* but not a return value: whether the editor keeps the correction
cannot be known at write time — that is the entire premise — so it arrives later,
from the durability watcher, as the `sentence-not-durable` verdict.

The split inside failed-transport is epistemic rather than cosmetic. not-durable
and wrote-elsewhere (the block reason a misplaced splice raises) are the two
cases where the transport told us it had done what we asked when it had not, and
both recur for every later sentence, so the fingerprint is withdrawn for the life
of the injection. write-rejected, write-normalized and reconciled block the
element only. `spliceFailurePolicy` supplies the same cause to apply and undo;
`reportSentenceSpliceFailure` records it without repeating the splice's DOM
comparison. `spliceWindowTag` preserves window evidence in the reason. A failed
apply arms neither a flash nor an Escape slot; neither caller rolls a mutation
back. Slate [13b]/[13c] and typing [13e] assert actual DOM mutations and outcomes
with ignored/obeying controls and fresh siblings to pin the demotion boundary.
Slate [19–22] add current-build idle/burst refusal, exact selection restoration,
listener teardown and rejected Escape with no family demotion.

Every applied sentence write is verified immediately and again after rendering
delays. If a controlled component restores, changes, or remounts the field, the
outcome becomes sentence-reconciled and that element is blocked from further
sentence writes for the session.

**Attribution decides how strictly that check reads, and it is decided by
provenance rather than by region.** A user edit fires a trusted input event; a
page assigning `.value` fires none — except on Slate, which applies a period or
a digit through its own model and fires no `input` at all, which is why the
verifier and correction feedback no longer run `input` listeners of their own.
Both consume the provenance observer's receipts (`noteSentenceUserEdit`): the
field as of the last trusted edit that observer could account for, or `null`
where it could not (a fenced bulk edit, an open IME session, a poll superseded by
a later one). Feedback's `noteSentenceEditWatch` stores the accounted text and
sequence for its settle;
null cancels that settle without inventing a rejection. Neither consumer writes
provenance or authorizes new text. Slate [17] measures a trusted in-span digit
with no `input` after verification closes; typing [5g3]/[5g4] exclude later page
mutations and synthetic input from feedback. Verification returns early only
when a user edit has been seen *and* the field's current text
equals that receipt — both halves, so the waiver needs a user edit and full
attribution — and `null` ends verification as `sentence-applied-unverified`
rather than blocking. A user edit does not disable the later samples, so a page
rewrite arriving after one is still caught. A
field the user never touched gets the strict byte-identical check, and so does
text that moved with no event behind it. Region rules lose here in both
directions: a page prepending text after the user typed must still be caught,
and a user clicking to the start and typing must not be. Known gap, recorded
rather than papered over: a page rewrite *followed by* a user keystroke
re-baselines the attribution and is missed; the durability watch runs regardless
and bounds the cost. The rule this replaced allowed the tail to grow, which
covers typing forwards and reads an ordinary backspace as the page discarding
the write.

**The durability veto** is the backstop under the registry, and it can only
demote. Sampling cannot catch the failure the registry exists for: an editor
that re-renders from a model that never saw our write reverts it on the user's
*next keystroke*, which is usually seconds after the last verification sample,
and provoking a reconcile instead was measured not to work. So the veto watches
the next trusted beforeinput and fires only on an exact proof: the correction
was still present, no composition has occurred, the event supplies exactly one
collapsed target range strictly outside the corrected span, and the resulting
text equals pre-correction text plus exactly that user edit, byte for byte.
Anything less exact is inconclusive rather than a veto. On a veto it records
sentence-not-durable, blocks the element, and demotes the whole family for the
life of that injection — an element-keyed map does not survive React replacing
the composer. It never rolls the write back: a blind
execCommand("undo") may undo the user's own work if the editor grouped or never
created a history entry. And it is never a promotion mechanism; an uncertified
editor is not authorized by observed success.

Automatic network failures do not open an error panel for every sentence.
They trip an exponential circuit breaker from 30 seconds up to five minutes;
the popup is where a connection problem is shown.

### Runner warmup — a typing lease

Sentence-mode keystrokes send SENTENCE_WARMUP: the first one after any pause,
and then at most one every ten seconds while typing continues
(SENTENCE_WARM_RENEW_MS throttles in content.js — there is no burst test,
only the throttle). background.js rechecks consent and tracks the last model,
num_ctx, thread count and contact time in worker memory. It sends an empty-message Ollama
load request only when the loaded model or context is wrong or the last
contact is older than SENTENCE_WARM_STALE_MS — the model matters because
anything else on the same Ollama can leave a runner warm at the right size for
the wrong weights (a manual rewrite on another model once did exactly that),
and a decision reading only num_ctx reported that as hot. The state is noted at send time (a request arriving
mid-load queues rather than loading twice), so every failure path — network
error, HTTP error, abort — forgets it: a failed request proved nothing about
what is loaded, and "unknown" fails safe. Real and warmup request bodies share
the same builder so their load-time options cannot drift.

Sentence requests carry a 20-second keep-alive (since 2026-08-25) and the
pings above are what hold the runner up while the user types — a typing lease —
so it unloads about 20 seconds after typing stops instead of 90. (The manual
path kept its own 1.5-minute lease until it was removed.) The invariant that makes 20 seconds safe is arithmetic and is
asserted cross-file by sentence-settings-test.mjs: the stale threshold (8 s)
plus the renewal spacing (10 s) must fit inside the lease, or a
continuously-typing user's runner expires mid-sentence.

Two consequences of *where* the warmup fires, both measured rather than argued.
It runs on the first keystroke of a burst, before any sentence exists, so no
per-sentence decision can prevent the load or the lease re-arm — a request
skipped later costs its inference and nothing else. And residency, not
inference, is the energy: over the owner's 49,784 real messages with real
timestamps, the shared-90s policy held 74,724 kJ and the 20-second lease
models a 44–55% cut across typing speeds, with zero of 70,702 simulated
sentence requests finding a cold runner (test/prefilter-probe.mjs section 13,
event-level simulation — the interval model cannot see a mid-burst expiry by
construction). The reloads the shorter tail provokes (~11,400 over those
messages) are each paid by a ping with nobody waiting; post-ship,
log-latency.mjs attributes any that reach a real request as `short-tail`, and
each dispatched sentence interaction records the requested keepAliveMs.
Unsent interactions carry null; dispatch does not prove server receipt or that
a runner lease was successfully armed. The analyzer orders measured dispatches
and compares first-attempt interaction arrival (retry dispatch for a retry) to
the preceding attempt's completion. Unsent and unknown-dispatch interactions
are excluded from predecessor selection. Overlaps or ambiguous legacy retry
ordering report insufficient evidence. Its six causes are `model-switch`,
`ctx-switch`, `short-tail`, `idle-expiry`, `unexplained` and `log-start`; thread
switches are not distinguished. Separate retained warmup observations cannot
prove that an unrecorded ping did not fire. TESTING.md §13b defines the evidence
labels: measured endpoints, legacy startedAt/wall proxies, write-time proxies,
unknown duration/dispatch/lease and the manual-only historical 90-second lease.

## Text and editor model

content.js represents contenteditable text as a string plus spans pointing back
to DOM text nodes. BR elements and recognized block boundaries become synthetic
newlines. The same mapping supports:

- DOM selection to text offsets;
- text offsets back to a DOM Range;
- sentence caret and anchor checks; and
- measuring changed ranges for page overlays.

Every write verifies against the field rather than against execCommand's
boolean, which returns true while silently truncating against maxlength and true
when a controlled component restores its own value, and every expectation is
built from text captured before the write. (The removed manual path wrote to any
contenteditable and compared normalized text; sentence mode has the stricter
contract.) Only a certified family is
admitted, and a target spanning incompatible styles, block boundaries, links,
embeds, mentions, decorated spans, or other structure is refused. The authorized
operation is exactly one class — replace one uniform inline run, inside a single
block, containing no atoms.

Injected UI is appended under document.documentElement rather than placed in a
shadow root. CSS class names and variables are prefixed with proofer-, and
dynamic strings are assigned with textContent. The page can still observe,
remove, or restyle these nodes; the isolated JavaScript world does not isolate
DOM nodes.

## Settings and state

background.js owns the complete settings schema, normalization, and
message-based writes. getSettings merges and normalizes persisted values on
read; sanitizeSettingsUpdate and setSettings validate writes. The popup renders
the effective settings returned by the worker instead of maintaining another
defaults table. The `sentenceMode` it reads is effective v5 activation; the raw
migration inputs are not changed by that projection. Page replies carry
`consent` beside settings, never stored, from `sentenceModeState`.

content.js reads only sentenceDebug directly from chrome.storage.local, when
asking for worker consent. It registers one storage listener lazily on the first
trusted editable focus; changes to either disabledSites or
sentenceModeDisabledSites re-ask the worker, without caching either list or
comparing the frame origin. Frames with no editable focus do neither read nor
consent IPC. (It duplicated the manual path's hotkey and auto-apply defaults
until that path was removed.)

Per-site arrays are updated through single-origin toggles applied against the
latest stored value. This prevents an old popup snapshot from resurrecting a
permission revoked elsewhere, or from switching back on a site the user
switched sentence mode off for elsewhere. The popup disables its site checkbox
while the write and any reconciliation are pending, then reenables it in
`finally`. A requested checkbox value is not an acknowledged setting. After a
refusal or messaging failure, `reconcileSiteSwitch` rereads `GET_SETTINGS` and
adopts the returned settings and consent together. If that read also fails, it
renders the last confirmed state and explicitly says the current setting could
not be confirmed. The original write error stays visible; only a missing error
uses the generic message.

### Persistent browser state

chrome.storage.local holds:

- the Ollama URL (`ollamaUrl`); no configurable model-name setting;
- disabled origins;
- recording flag;
- sentence-mode switch (off until Turn on; since v5 on means write),
  per-site switch-off list, and debug flag;
- settings migration version;
- `setupQualification`, the worker-owned setup result used to determine whether
  qualification is current;
- `setupPaused`, the setup page's persisted download-pause flag;
- `exportNoticeSeen`, the popup's acknowledged export-notice version;
- two log rings and their indexes (the manual ring is only read and cleared now);
- aggregate sentence skip counters, which also carry the `field:*` editor
  coverage tallies (a reason per field, never an origin and never any text);
  and
- a separate 256-observation, text-free warmup array under wlog:events; and
- `logEvictions`, a count and a time, set when a quota rejection evicted
  records before the count cap;
- `logWriteFailures`, the best-effort persisted count and last time of failed
  log writes; the worker also retains an in-memory count.

Model identity is stored as evidence inside qualification and log records.
Those fields are not model-selection settings. Legacy model-setting keys may
remain until migration cleanup succeeds, but requests do not read them.

Recording is on by default. Records contain actual user text, model output,
origin, request configuration, timings, error/guard state, and later user
outcomes. They are local but persistent and are not application-level
encrypted.

Manual records used plog: keys with a 2,000-record FIFO index; nothing writes
them since the manual path was removed, but existing ones stay exportable until
Clear. Sentence records use slog: keys with a 5,000-record FIFO index (was
1,000). The six synthetic v2 handler exports in [H16] average
~1,573 serialized bytes, maximum 1,894 (2026-10-08): 5,000 × average is
~7.86 MB against chrome.storage.local's 10 MB, below the ~8 MB gate. Projected onto the owner's 1,000-record
2026-09-24 export (an `attempts` row per dispatch added to each v1 row), v2
averages ~1,080 serialized bytes, p90 1,306 (v1: 702): ~5.4 MB of rows at
5,000, so the synthetic mix above, which is half retries, is the pessimistic
figure. Keep the
5,000 cap and compatibility projections. The earlier ~921-byte / ~4.4 MB
figure measured v1 owner-export records, including key/index overhead; the v2
measurement is serialized rows only, not a maximum storage bound. A quota rejection before the
count cap evicts the oldest tenth and records it under `logEvictions` BEFORE
the replacement write is tried, which the popup turns into "older entries were
dropped — export now"; a record or verdict that cannot be written at all is
counted under `logWriteFailures` (and in memory) and said too. Every sentence
record carries `promptRevision` (the stamp sentence-request-bytes-test.mjs ties
to the golden request) and `modelDigest`, the digest the engine saw installed
before it sent, so beta data cannot be confused with a later model's; the
machine's qualification backend `{kind, numThread}` is recorded when known,
otherwise null.
Worker writes are serialized
through an in-memory promise chain to avoid lost read-modify-write updates.
The popup's JSONL export merges both rings with the separate warmup array
in record-write (`ts`) order, not an arrival timeline. `EXPORT_LOG.counts`
reports the lengths of these same interaction and warmup inputs plus the optional
trailing skip row (zero or one). This metadata does not change the JSONL rows;
the popup still appends the notice row. Interaction counts include pathless
legacy manual rows and exclude orphaned prose that Clear's prefix inventory
counts. Mixed exports name interactions and diagnostic rows separately;
diagnostic-only exports remain downloadable through the notice and say
“No interaction records. Exported diagnostics only.” An all-zero export says
“Nothing recorded yet.” without a notice or file. Sentence arrival is
captured before the initial settings await; completion precedes queued logging.
Warmup rows contain only identity, decision, timestamps, fixed outcomes and an
overlap flag. completedAt means the attempt ended; outcome loaded requires
consuming a JSON response acknowledging a load. Pending attempts retain null
completion times. Sentence records carry their arrival time and overlapping
warmup IDs so log-latency.mjs can correlate retained observations.
Warmup writes share logQueue and honor recordAll. Clear sweeps wlog: alongside
the prose prefixes and bumps one `logGeneration` that every warmup AND every
sentence request captures when it begins, so neither can write after a Clear
— a sentence in flight at Clear used to write its text afterwards, since its
record is written when the response completes. Missing rows can reflect retention or recording gaps.

### Sentence interaction record

`runSentenceEngine` and `retrySentenceRewrite` produce ordered attempt rows at
inference fetch/body boundaries. `sentenceResultFields(payload, meta)` projects
the interaction after the handler's final deadline/configuration check;
`recordInteraction` queues it for persistence. `test/lib/log-record.mjs` is the
Node compatibility reader. New sentence rows are version 2; other row kinds and
historical exports retain their shapes. IDs are opaque, including old IDs.

| Field path | Contract |
|---|---|
| `v` | 2 for new sentence interactions. |
| `path` | `sentence`; warmup, skips, notices and manual rows are separate kinds. |
| `id` | Content-instance request identity, retaining `sn_` routing. |
| `origin` | Worker-derived top-level origin. |
| `arrivedAt` | Worker message arrival, captured before any await. |
| `startedAt` | Compatibility alias of the same `arrivedAt`. |
| `completedAt` | Time the handler fixes its terminal response, before queued persistence. |
| `ts` | Record-write time; outcome patches do not change it to arrival time. |
| `dispatched` | Whether an inference `/api/chat` fetch was invoked; a tags lookup is not inference. |
| `attempts` | Zero, one or two ordered inference dispatches; authoritative for outputs and measurements. |
| `model` | Prepared model tag, null before preparation; does not establish dispatch. |
| `options` | Prepared inference options shared by both attempts, null before preparation. |
| `keepAliveMs` | Requested inference lease, null when unsent; no proof of server receipt or residency. |
| `promptRevision` | Worker prompt revision. |
| `modelDigest` | Observed installed digest, null when unknown. |
| `backend` | Qualification backend `{kind, numThread}`, null when unknown. |
| `input` | Target sentence; null on early settings failure to avoid retaining unconsented text. |
| `context` | Existing two-sentence preceding context projection; null before consent/preparation. |
| `trigger` | Captured trigger evidence, null when absent or before preparation. |
| `output` | Delivered correction or ordinary refused output; null for errors and undelivered accepted retries. |
| `guard` | Interaction guard refusal; null for errors, including consent-read-timeout. |
| `noChanges` | Successful no-change interaction. |
| `error` | Terminal interaction error, or null. |
| `retry` | Routing outcome/reason/keep-list, or null; compatibility output/guard/timings derive from attempts. `applied` means guard acceptance, not delivery. |
| `timings` | `wallMs` is arrival-to-response; other counters project the first attempt. |
| `verdict` | Later page/user outcome, null until reported; never a guard result. |
| `finalText` | Later sampled edited text, or null. |
| `warmupIds` | Retained warmups in flight at arrival. |
| `attempts[].attempt` | `first` or `retry`. |
| `attempts[].dispatchedAt` | Time inference fetch was invoked. |
| `attempts[].completedAt` | Body consumption or terminal transport failure time. |
| `attempts[].timings` | `wallMs` covers this dispatch/body lifetime only. |
| `attempts[].output` | Parsed raw `rewritten`, including the empty string; null when unavailable. |
| `attempts[].guard` | Guard refusal, or null. |
| `attempts[].error` | Attempt error, or null; later delivery errors do not erase accepted attempts. |
| `attempts[].outcome` | `applied`, `refused`, `no-op` or `error`. |

Both timing objects contain `wallMs`, `totalMs`, `loadMs`, `promptTokens`,
`promptMs`, `evalTokens` and `evalMs`. Durations are milliseconds; unavailable
Ollama counters are null. First-attempt wall is measured directly, never
interaction wall minus retry wall. `generation` is an internal Clear token
and is never persisted. Compatibility retry fields retain the first refusal
on an accepted retry, or the second output/guard on a failed retry, while
canonical attempts retain both outputs even after a final-consent timeout.
The reply still falls back to the original refusal on that timeout.

Old exports are read without migration. Missing arrival uses `startedAt`;
without either, arrival is unknown. Missing dispatch evidence is unknown:
Ollama counters establish a legacy dispatch, prepared options or an interaction
wall do not. Missing attempt walls/endpoints, sentence leases and backends
remain unknown (backend reports may label this `unrecorded`). A 90-second
historical lease fallback belongs only to identifiable legacy manual rows.
Browser verdicts are page/user outcomes; corpus verdicts follow their corpus
schema. Replay uses v2 attempts exclusively. For v1 applied-retry
consent-read-timeout rows with matching top-level/first output and guard, replay
counts the first refusal once and reports the accepted retry output unavailable.
Equal outputs from two genuine attempts remain two rows. Source file and row
identity survive replay; matching IDs do not deduplicate interactions.

Priors and harvesting normalize once per interaction, without expanding attempts
into training cases. `error-priors.mjs::buildErrorPriors` gives each configured
source an explicit browser/corpus schema: the selected changed pair counts as
accepted only for an applied interaction without a delivery error. A later
user rejection does not undo guard acceptance; a refused pair remains in
`counts_all_changed`. `counts_applied` retains the accepted column even under
`--all-changed`. `log-to-cases.mjs` retains the worker-owned verdict-to-label
policy and per-source provenance, and excludes timeout interactions even when
an attempt was accepted.

The deletion inventory, `interactionProse`, covers `input`, `output`,
`finalText`, `context`, `retry.firstOutput`, `retry.output`, `attempts[].output`
and `retry.keep[]`. Absent fields contribute nothing and identical compatibility
aliases contribute once. Contributions use this same inventory for deletion
and other contributors' shared-text subtraction. The existing
10-character minimum, raw/JSON-string search forms, dry-run and residual-failure
reporting apply to every path.

### Ephemeral state

An MV3 worker may stop at any time. The following are intentionally rebuilt
after a worker restart:

- request AbortControllers;
- the serialized log-write queue;
- the lazily loaded dictionary; and
- Ollama runner context/last-contact observations.

Each content-script frame separately owns its focused field, sentence consent,
watermark, one
sentence job, deferred write, undo record, circuit breaker,
sentence-mode status, session-only blocked-element set, and the set of editor
families demoted by the durability veto.

## Trust and privacy boundaries

1. **Host page to content script.** Field text, selection, page metadata, DOM
   structure, input events, and editor reconciliation are untrusted. Apply
   operations are anchored to snapshots and trusted user events gate UI
   actions.
2. **Content script or popup to worker.** background.js is authoritative for
   settings, localhost URL normalization, disabled-site checks, sentence
   consent, network access, logs, and accepted outcome names. A content script
   runs in the page's renderer, so what it sends is treated as possibly the
   page's: the messages only this extension's own pages send
   (`PAGE_ONLY_MESSAGES` — settings, the write consent, log stats, export,
   Clear, Recent changes, health) are refused from any sender whose URL is not
   under the extension's own origin (`isExtensionPage`; `sender.tab` is not the
   test, since setup's page is a tab). `sentence-settings-test.mjs` [F9] checks
   the list against what content.js and popup.js actually send, in both
   directions. And the write consent has exactly one way in,
   `SET_SENTENCE_MODE`: a `SET_SETTINGS` carrying `sentenceMode` or the v4
   `sentenceModeApply` is refused whole, because under v4 the same bit in a
   popup's Save meant "suggest" (checkpoint 1, 2026-09-25). The setup messages
   (`SETUP_*`) are narrower still: only this extension's `welcome.html`, and
   they carry a run id and nothing else — no text, model, options or URL — so
   no page can make the worker run anything but its own fixtures.
3. **Worker to Ollama.** The manifest, popup, and worker all restrict the base
   URL to plain HTTP on localhost or 127.0.0.1. Model output is still untrusted:
   it is parsed, bounded, and sanitized. Sentence-mode output additionally
   passes the strict guard set before it can be applied without review.
4. **The transport lookup.** "An unrecognized contenteditable is denied" is a
   boundary, and it held only until one was nested inside a recognized editor
   across a `contenteditable="false"` island. Resolving a fingerprint therefore
   ends at getEditableRoot, and the same walk answers both "which recipe" and
   "is this eligible" so the two cannot drift.
5. **Packaged data files.** The loaders have different contracts. An absent
   word list disables dictionary membership vetoes and dictionary-dependent
   checks; some dictionary-backed
   permissions also disappear. The generated confusables and names grant
   permission, so their loaders check shape, count and SHA-256 and publish null
   on any anomaly, retaining only the hand supplements.
6. **Persistent local data.** Local-first means no application cloud service;
   it does not mean no storage. With recording enabled, browser storage and
   exported JSONL contain the user's writing. [.gitignore](.gitignore) excludes
   JSONL and harvested corpora because they must not be committed accidentally.
7. **The packaging boundary.** There are three boundaries around the user's
   recorded writing and they are not the same one. `.gitignore` keeps it out of
   the repository; `0600` inside a `0700` tree keeps it from other local users;
   and until 2026-09-06 there was no boundary at all around what gets INSTALLED.
   With no build step, `Load unpacked → the repository root` packages the whole
   working tree — measured on the authoring checkout, 1.4 MB of runtime against
   367 MB of `test/`, of which 294 MB was `test/harvested/`. Chrome will not
   serve those files to a page (`web_accessible_resources` is undeclared), so
   this was never a live leak; what it was is the absence of any artifact you
   could hand someone that was not also a copy of the owner's corpus.
   [tools/package.mjs](tools/package.mjs) is that boundary, and its
   `RUNTIME_FILES` list is the answer to "what is the extension".
8. **Recorded prose rendered back into the popup.** `GET_RECENT_SENTENCES` is
   the first path that puts recorded field text and model output into an
   extension DOM. Both are untrusted by rule (1) and (3), so the receipt view
   builds every node with `createTextNode`/`textContent` and never interpolates
   markup; the response carries only the six receipt fields rather than the
   whole record; the cap is applied in the worker so a rendering bug cannot pull
   the ring into a page; the view is loaded on demand rather than with the
   popup; and `CLEAR_LOG` empties it, because clearing is the user's guarantee
   that their writing is gone and an open list would keep it on screen and
   copyable at exactly that moment.

Raw Ollama errors stay in the extension worker console. Page-facing UI receives
generic messages so backend details are not inserted into the host DOM.

Ollama's Origin allowlist holds no extension scheme, so a POST from the
worker or an extension page (`Origin: chrome-extension://<id>`) is answered 403.
Since 2026-09-24 background.js installs ONE dynamic declarativeNetRequest rule
(`ensureOriginRule`, permission `declarativeNetRequestWithHostAccess`, no new
warning) that sets `Origin` to the configured Ollama origin — which the default
allowlist holds — for requests to that origin only (`urlFilter`), started by
this extension only (`initiatorDomains: [chrome.runtime.id]`), fetches only
(`xmlhttprequest`, `other`). It is reconciled at worker start, on install and
update, and on every URL change, and every POST awaits it. Updates are
SERIALIZED and each is read back (`getDynamicRules` must show exactly the rule
wanted) before its promise resolves true, so the last URL asked for is the
last rule written — memoized alone, two quick URL changes could finish out of
order and leave the rule on the old URL while the cache said the new one was
ready (checkpoint 3). The setup page waits on `SETUP_READY` for the same
reason before its own requests. A web page's POST
to the same port keeps its own Origin and stays 403, and so does another
extension's; test/origin-rule-probe.mjs measures all of that against a stock
Ollama in Chrome for Testing and Brave (Edge is the acceptance test's). The
allowlist is not authentication either way: loopback binding and the
extension's validation remain the boundary. docker-compose.yml keeps Ollama's
default Origin allowlist; only the scoped extension rule grants Proofer access.

## Testing architecture

`tools/test.mjs` runs the deterministic suites in three groups: `source`
(Node only; `npm test` from `test/` runs this group), `browser` (Puppeteer and
Chrome for Testing, no model) and `e2e` (the real extension, Ollama and the
pinned model). Those groups are the gates; they say nothing about correction
quality, which the research suites measure. Maintainers choose further suites
according to the changed boundary; [test/TESTING.md](test/TESTING.md) is the
command matrix and [CONTRIBUTING.md](CONTRIBUTING.md) says which group each
kind of change needs.

| Tier | Examples | External requirements |
| --- | --- | --- |
| Source/VM tests | Sanitizer, sentence split, guards, anchors, settings, packaging | Node only |
| Stubbed browser tests | Sentence typing, provenance, popup views and activation | Puppeteer/Chrome; no Ollama |
| Extension integration | Sentence end-to-end | Chrome with unpacked extension, fixtures, and Ollama |
| Model quality | Core, holdout and meaning drift (single sentences through the sentence pipeline since 2026-09-24), owner bench, frozen benchmark | Local Ollama and selected model |
| Captured editor | Slate integration | Browser only — the capture is served from loopback |
| Real editor | The certified-editor suite, and the Slate live canary | Browser and network access to the real editor demo sites |
| Editor experiments | Slate intent probe, candidate-editor recipe probe, flash paint probe | Browser; network for the probes that drive live demo sites. The recipe probe's `--nesting-only` mode is the exception — it drives no demo site, is offline, and is the one part of this tier that CI runs |
| Research/benchmark | Model bakeoff, repeat and sentence-window studies, the prompt-cache study (test/prompt-cache-study/: private servers only, raw data in test/harvested/cache-study/) (prompt lab, prompt A/B and parameter sweep are frozen: they measured the removed manual prompt) | Local Ollama; potentially long-running |
| Replay experiments | The pre-filter probe: recorded model outputs re-scored under a hypothetical change | Node only, plus the gitignored corpora and recordings |

The Node harness reads the production model and digest from background.js.
Its `researchModelPolicy(model)` supplies the canonical tag and expected digest
to import-time admission, `callSentence` and the frozen benchmark. The existing
pin map includes the pilot aliases; an unpinned research model has no expected
digest. Any nonempty `PROOFER_SKIP_DIGEST_CHECK` disables the research check at
both admission and inference. The extension still passes `PINNED_MODEL.digest`
directly; research settings never enter runtime policy.

The suites build requests with background.js's own prepareSentenceRequest. Sentence tests evaluate explicit seams from the
shipping files rather than maintaining a second segmenter or guard
implementation. These source-extraction seams make some symbol names and
source shapes test contracts; refactors must update the harnesses together.
Sampling defaults are still duplicated in test/lib/harness.mjs, so a production
sampling change must update that copy too.

`callSentence` consumes the engine's attempt rows unchanged through
`createLatencyTracker.recordInteraction(wallMs, attempts)`. Interaction walls
include preflight, guards and retry overhead; attempt walls cover dispatch
through response-body consumption or terminal transport failure. All dispatched
attempts count, including failures, while an unsent interaction adds no request.
The tracker's existing top-level `.stats()` fields remain request metrics, with
an additive `interaction` wall summary inherited by core/holdout JSON. Token
totals include both attempts; absent counters remain null, and throughput uses
only paired token/duration counters. Reports label the two walls separately.
`recordTiming` accepts normalized timings; direct-fetch `record(wallMs, data)`
still accepts raw Ollama counters. `scoring-engine-test.mjs` [4d–e], [6b–c] and
[7] pin expiry/salvage, two-attempt timing, shared research policy and direct-fetch
compatibility against a fake loopback server.

`test/lib/sentence-guards.mjs` owns `loadSentenceGuards({ source, dataRoot,
controls })`: each call creates a fresh VM and the same export/data setup.
Ordinary exports come from its default instance; `SENTENCE_SOURCE` is the
already-read worker snapshot. The audit supplies its patched source to this
loader, with no separate dictionary or VM implementation. Words use the seam's
CRLF normalization; generated confusables and names use the shipping integrity
checks. `dataRoot` selects the data directory. Explicit controls replace the
environment defaults: `noDict` (the historical `PROOFER_NO_DICT` control) removes
words and both generated datasets, while `noConfusables` and `noNames` each
remove only their generated grants and retain hand supplements. The combined
control is not a simulation of a words-only fetch failure.

The seam derives ordered, distinct `REASON_FAMILIES` from the loaded
`runSentenceGuards` fail sites, normalizing the dynamic token payload. Unknown
fail-site expressions throw. `guard-tools-test.mjs` [2a–b] pins 26 families and
the routing CLI; [3a–b] exercises the audit's real variant path with normal and
controlled datasets. [4a–d] exercises owner live/reguard and audit collection,
analysis, sweeps and variants against fake loopback Ollama, plus the survey's
revision selection and baseline legacy extraction. Together with [1a–b], the
suite runs 48 checks without a browser or model.

The seam exposes the worker's `sanitizeSentenceOutput`; owner-bench, audit,
survey, replay, routing study, preguard scoring, retry bakeoff and the two
finetune context probes use it with raw output retained separately. Audit clean
echoes, like owner-bench echoes, must pass the question before counting as
no-ops. Each survey comparator uses its own helper. For pre-extraction snapshots
such as b332d8d, the seam extracts and validates the actual sanitizer statements
from that revision's engine; an unsupported shape fails. [4c–d] pin current
faithful-typography admissions against both a synthetic comparator and b332d8d's
literal sanitizer refusals; borrowing today's question for either goes red.
Newer outcome/projection exports remain available on current source and are absent on old snapshots.
Rejudging fixed outputs does not rerun the engine, model or retry.
G6.4 verified identical runtime questions, full reasons and outcomes on 6,015
fixed recorded outputs. The corrected instruments changed seven holdout outcomes
to refusals and lowered the survey ceiling from 19,677 to 19,294 of 20,990 repairs;
both holdout damage gates reported zero new damage. These are G6.4 measurement
corrections, separate from G6.6's runtime change: on the same 6,015 fixed
outputs, five refusals become faithful no-ops and two become adjudicated safe
edits, with no reverse flips. Both holdout reguard gates and the integrated live
engine on 500 random / 382 error items have zero new damage UIDs. The survey
recovers 383 repairs (19,677/20,990 admitted), with zero newly admitted POLICY
cases or newly walled repairs. All four applied retries in the 49-hazard live
gate are adjudicated safe. Detailed before/after results and judgments stay in
`test/results/shape-drift-exec/G6.6/`.

`test/preguard-score.mjs` imports the guard seam from its own tree. Its labels
resolve from `PROOFER_CORPUS_DIR`, or `test/harvested/` relative to the script,
not the working directory. Recognized `bench-error-holdout-*`,
`bench-random-holdout-*` and `bench-dev-corpus-*` filenames select the matching
labels file. `test/guard-tools-test.mjs` [1a–b] pins this with ordinary copied
files, a broken-worker control, a candidate-only admission and contrasting
synthetic corpus labels; it requires neither Chrome nor Ollama.

Core, holdout, and meaning-drift suites are measurement tools: ordinary
quality failures are printed in their reports but do not by themselves produce
a nonzero exit code. Deterministic assertion suites are conventional pass/fail
checks. Do not treat an exit-zero quality run as proof
that its documented score threshold was met.

Every browser suite resolves its binary through [test/lib/chrome.mjs](test/lib/chrome.mjs):
PROOFER_CHROME, then Puppeteer's Chrome for Testing, then a system install, and
an error naming the install command if none exists. Chrome for Testing comes
before any system Chrome because branded Chrome 137 and later ignore
--load-extension without reporting it. Four suites previously chose for
themselves and two hard-coded /usr/bin/google-chrome, which is a Debian-branded
path and the wrong preference wherever it did exist.

test/sentence-slate-test.mjs serves **two** real captured Slate builds from
loopback. `fixtures/slatejs.org/` (2026-08-25, slate-react 0.126.3) remains the
positive control: all existing cases [1–18] and their assertions stay in place.
`fixtures/slatejs.org-2026-10-09/` (slate-react/slate-dom 0.132.0, build
`tsAE1mpvWW79X1Ug5Z89V`) supplies [19–21]'s safe-refusal contract. [22] first arms
Escape with a real old-model apply, then installs the current handler's refusal
behavior for undo; a stock current build cannot naturally arm an undo slot.
The full offline gate has 223 checks. Missing either capture is a hard failure.
Both captures are included in `fixtures/verify.mjs` (seven captures total).
Browser DNS rules, captured CSP and per-request interception enforce offline
operation; each server's misses and all offsite attempts are asserted.

`PROOFER_SLATE_LIVE=1` observes whether the site's own handler cancels the
range-bearing dispatch and runs the corresponding landing or refusal contract.
It does not use a hard-coded version; the current refusing site runs 32 checks.
The live editors suite retains every
scenario (growth, shrinkage, inverse write, range/format refusals, emoji, blocks,
burst and subsequent typing); uncancelled Slate events must report the precise
refusal with unchanged text and caret, while cancelled events must still land.
The current full live run has 302 checks; the targeted Slate run has 68, with
exit 77 for its deliberately filtered other rows. Exit 77 also denotes an
unreachable site. The old capture's successful writes
remain independently required even when the live canary correctly refuses.

The remaining network suites exit 77, not 0, when a demo site is unreachable, so
a skip is never mistaken for the pass it looks identical to; 77 also is not 1, so
it is never mistaken for a failed assertion. PROOFER_SLATE_OPTIONAL=1 (live mode
only) and PROOFER_EDITORS_OPTIONAL=1 restore exit 0 for a batch run that
tolerates the gap. A page that loads without the expected editor selector is a
failure rather than a skip: the selector is the suite's contract with the site,
and a quiet skip would hide a broken contract behind the outage excuse for as
long as it lasted.

Two flags cut across the browser suites. PROOFER_CONTENT=<path> runs a suite
against a different content.js, which is how a proposed change gets a pre-fix
control and how a green run can be pinned to bytes that still exist — a pass
whose input moved underneath it is not evidence, and that happened twice while
several sessions edited one file. PROOFER_SEED fixes the jittered keystroke
stream and is printed on every run, so an intermittent red names the rhythm that
produced it and the fix can be demonstrated as a paired experiment rather than
as three lucky greens.

test/flash-highlight-probe.mjs (does the contenteditable flash actually paint,
survive, and tear down when Escape stops working) sits with the gates, not the
experiments: it asserts, and since 2026-08-24 — when its Draft and Trix targets
were captured — it runs fixtures-only in CI's browser job.

Alongside the gates sit probes and studies, which are experiments and not
pass/fail contracts: test/slate-intent-probe.mjs (the INTENT recipe against real
Slate, including the dirty branch and caret coincidences no end-to-end run
reaches), test/editor-recipe-probe.mjs (a *candidate* editor against both
recipes, both caret policies, idle and burst, with a no-write control and an
offline editable-island nesting matrix), and test/graded-routing-study.mjs (should a refusal band be
OFFERED via the chip rather than discarded — measured no, for now, on the
grounds recorded in its own output; the follow-up it pointed at instead, four
guards narrowed to apply silently, was taken on 2026-08-15). Being experiments does not make them
allowed to false-green: the study exits 1 when the private corpus is missing and
2 on an unknown band name, because a run that measured four small checked-in
corpora must not read like one that measured 1282 real sentences. Automatic
bands come from the selected guard source's derived families; specialized
band predicates remain study-owned. `test/guard-headroom-audit.mjs --from`
compares recorded outputs with source-patched variants under the shared loader's
same datasets and controls; it does not rerun the engine or its retry.

test/replay-log-guards.mjs is neither gate nor probe. It re-runs every recorded
{input, output} through the current guards and reports outcome flips by
direction, which is how a guard change is scored against real typing without
Ollama. Its JSON artifact is redacted by default and --include-text refuses a
destination git would not ignore: the interaction log holds what the user typed,
and an analysis derived from it is the same text under another name.

test/editor-recipe-probe.mjs is a *bench*: the trial engine is general and the
setup is not, so the per-editor facts — URL, selector, focus strategy, click
floor, clearing passes, which furniture to strip before asking whether the field
is empty — live as descriptors in test/lib/editor-targets.mjs, and
PROOFER_CANDIDATE_URL + PROOFER_CANDIDATE_SELECTOR synthesise one, so an editor
nothing here has heard of can be characterised with no code change. Half a
request is refused rather than guessed: a URL with no selector exits 2, because a
guessed selector attributes the matrix to whatever it found. The descriptors are
a second copy of what sentence-editors-test.mjs keeps in its own TARGETS — that
suite is a gate and is deliberately left driving its own list — so the
duplication is *checked* rather than argued away: the probe reads that file's
literal and exits 2 when the identity fields (url, selector, family, recipe,
focusVia) disagree, or when the cross-check could not run at all. Neither the
descriptors nor that cross-check are on the `--nesting-only` path, which answers
one question and must not be able to fail for a reason it does not depend on;
that path also runs in CI with the network denied, so keeping targets off it
makes "the nesting matrix touches no demo site" true of the text as well as of
the run. It is an assertion rather than a comment — a target filter that is fatal
on the full path must be inert there, say so, and leave no targets and no
cross-check in the artifact.
test/editor-bench-selfcheck.mjs is the bench's own test, offline: it breaks the
bench on purpose — configuration, runtime, descriptors, and the cross-check —
and requires each break to produce the right exit code *and* to name the problem,
because a mistyped selector is the cheapest route to this repo's oldest harness
failure, a run that completes, exits green, and measured nothing. It also runs
one cell that WORKS and inspects the artifact, since a harness that only tests
its own failure paths cannot notice its output becoming useless. The bench's exit
codes say whose claim failed: a nesting failure or a wrong built-in descriptor is
1, a wrong ad-hoc argument is 2, and only genuine unreachability is 77 — a focus
or setup failure on a page that loaded is a harness bug, not an outage.

test/sentence-editors-test.mjs is table-driven, one row per registry entry, so
adding an editor is a row rather than a file — and its registry scenario reads
SN_TRANSPORTS out of the selected content.js and asserts every family has a
target, because a registry row without a suite row is an assertion nobody
checked. `test/lib/content-sandbox.mjs` exports the resolved `CONTENT_PATH` and
one `CONTENT_SOURCE` snapshot: both its VM and the editor suite's `injectContent`
use those bytes, including `PROOFER_CONTENT` overrides, without rereading the
file. The banner and final result identify that path; styles remain local.
Case [0b] runs a child against an ordinary temporary source with Quill's recipe
set to `intent`, then checks the VM registry, the browser's actual adapter and
source attribution. Its local Quill-shaped editable proves source selection,
not Quill's document model. `--source-test` runs those seven checks without
network access; `--source-probe` runs only the two browser/VM checks for a
selected input. The full run retains the real-editor and exit-77 contracts.
Its rows exercise growth, shrinkage, undo, atomic refusal, an emoji, a
second block, and a write landing mid-burst. Every scenario that WRITES ends on
the only assertion that can fail — typing more characters afterwards and reading
what is actually in the field; the refusal scenario instead asserts the field is
byte-for-byte unchanged, which is the corresponding claim when nothing was
written. The old Slate capture is the positive control for synthetic dispatch;
current Slate supplies the safe-refusal control,
because without a known-honouring editor in the run "the write worked" cannot be
told apart from a probe that never fired. A branch that cannot set itself up (no
bold run, an editor that turns the emoji into an atom) is recorded and exits 77
rather than printing SKIP into a green run, and a PROOFER_EDITORS filter that
matches nothing exits 2 rather than passing zero rows.

Only [test/package.json](test/package.json) has an npm dependency, an
exact-pinned Puppeteer. [test/package-lock.json](test/package-lock.json) locks
the tree, [test/.npmrc](test/.npmrc) disables lifecycle scripts and enforces
exact pins plus a release-age quarantine, and [test/scripts](test/scripts)
contains the dependency-check and targeted CVE-update workflows. Puppeteer's
dependency metadata requires Node 18 or newer. Because install scripts are
disabled, acquiring a Puppeteer-managed browser is a separate documented step.

Most generated results, node_modules, harvested user writing, and JSONL files
are ignored. repeat-study.sh overwrites the committed
test/results/repeat-study.tsv exception; model bakeoffs and optional
PROOFER_RESULT_JSON summaries go to ignored result files. Some local
owner/window benchmark inputs are private ignored artifacts and are therefore
not available in every clone.

[no-network.yml](.github/workflows/no-network.yml) is the deterministic regression
battery, triggered by push, pull request, and manual dispatch.
[os-install.yml](.github/workflows/os-install.yml) is a separate Windows/macOS
installation check with a real Ollama and engine download; its triggers are
documented in TESTING.md §32.

The no-network battery covers the source/VM and stubbed-browser tiers of the
table above, the captured-editor tier, and the one offline mode of the editor-experiment tier
(`editor-recipe-probe.mjs --nesting-only`) — that is, the suites that are
deterministic and self-contained, which is not the same as a clean cut across
tiers. It runs as two jobs: `source-only` (the Node/VM tier,
including log-record compatibility and log-latency suites, and it runs with
`test/node_modules` absent, so it needs no install at all) and `browser` (Puppeteer over loopback, ~5 min). Third-party
actions are pinned by commit SHA and the workflow takes only `contents: read`.

The test phase is network-free by enforcement rather than by argument: every
browser suite runs inside a loopback-only network namespace, and a preflight
step proves that namespace actually denies before any suite runs, failing the
job rather than degrading to an unenforced run if it cannot. It did exactly
that on the workflow's first five runs — `ubuntu-latest` is 24.04 and ships
`kernel.apparmor_restrict_unprivileged_userns=1`, which denies `unshare -rn` to
a non-root user, so the `browser` job died at the preflight every time and no
browser suite ran until 2026-08-15. A step ahead of the preflight clears that
sysctl, keeping the namespace unprivileged rather than running the battery as
root. A grep audit is
recorded alongside it in the workflow header as the weaker, secondary check —
it can only support "nothing fetches", never "no external URL appears". Setup
— `npm ci` and the Chrome for Testing download — is allowed the network;
nothing after it is.

The battery is reproducible in its verdicts but not byte-for-byte: `PROOFER_SEED`
is pinned so a failure replays, and two seeded runs still differ in an ephemeral
port and one timing-derived count. `PROOFER_CHROME` is pinned to the resolved Chrome for
Testing path, because `ubuntu-latest` ships branded Chrome that `lib/chrome.mjs`
would otherwise fall back to silently, and branded Chrome ≥ 137 ignores
`--load-extension` without saying so.

Model-quality suites and tests requiring live editor sites are outside the
no-network battery. The separate OS-install workflow builds the package and
exercises installation and setup with real Ollama. Both `ready` and `too-slow`
are accepted installation outcomes; the typed-correction check runs only after
`ready`. Neither workflow is a broad correction-quality gate. There is no
store-publishing or release automation. For local installation, build and load
`dist/proofer`, reload after rebuilding, and refresh writing pages after
content-script changes.

The 77-means-skipped contract is preserved rather than special-cased — no suite
in the no-network battery can return it, and GitHub fails a step on any non-zero
exit, so a 77 that ever surfaced would be red.

## Maintenance invariants

- Keep background.js as the canonical full settings schema and the consent and
  network authority. UI validation is not the security boundary.
- Keep sentence validation fail-closed: the sanitizer is asked whether it WOULD
  change the answer, and a yes is a refusal, never a repair. The question leaves
  original typography families alone; the exact non-ASCII multiset guard still
  enforces character preservation, including within those families.
- Gate every listener on injected UI with `e.isTrusted`. Injected UI lives in
  the page's DOM, so an ungated handler is a control the page can operate — the
  removed manual panel's auto-apply checkbox was one, and a synthetic `change`
  minted a 30-day cross-site grant.
- Never deliver a sentence response without rechecking its exact anchor.
- Recheck sentence consent in the worker for probe, warmup, and every request —
  and once more before returning a sentence result: the pre-fetch check is
  consent at send time, the write happens after the reply, and a reply already
  in flight can land before the content script's re-ask on the switch-off's
  storage event resolves.
- Serialize settings writes through `settingsQueue`. Every write is a
  read-modify-write of the whole object, so unserialized overlapping handlers
  can resurrect a revoked grant.
- Keep request IDs unique across content instances and restarts with the lazy
  128-bit namespace and per-instance counter; never derive identity from a wall
  clock. Preserve the original opaque ID and rw_/sn_ routing unless the log lookup
  contract changes at the same time. Typing case [24] pins isolation and routing.
- Keep page context out of the user text. Prior sentence context must remain
  encoded as data rather than executable-looking instructions.
- Treat num_ctx as load-time state. The fixed sentence value, warmup behavior,
  and keep-alive policy are one performance design.
- Keep everything that varies between sentences at or after the last user
  message. On stock Ollama the pinned hybrid model's prompt is resumed only at
  checkpoints the bundled llama.cpp saves (user-message starts, and near the
  prompt's end), so a host line, context or keep-list earlier than that makes
  every sentence re-read the whole prompt — on a CPU that is most of the
  deadline (see the optional prompt-cache study in `test/TESTING.md` §29).
  Today's layout (L0) re-reads it; a cacheable one needs a model trained for it.
  (Until beta step 3b buildSentenceMessages also branched on the model tag,
  which a retag could flip; with one pinned model that branch is gone.)
- Treat a rich-editor DOM write as provisional until the editor's own model has
  demonstrably retained it.
- Choose the write recipe from the fingerprint before writing, and never chain
  recipes. Both failure modes of a fallback chain — the delayed double edit, and
  a swallowed keystroke replayed through a transport the editor ignores — belong
  to the chain rather than to either recipe.
- Resolve a transport inside the editable island. A bare closest() crosses a
  `contenteditable="false"` node view and hands an unmeasured inner editor the
  outer family's authority; reuse getEditableRoot rather than writing a second
  walk.
- Treat the request's trigger as a guard input, not as telemetry. One guard
  branches on it, so removing it or widening its allowlist changes what is
  refused, not just what is logged.
- Keep packaged data that GRANTS fail-closed, and generate it from a filter
  rather than editing it. data/confusables-en.txt is produced by
  test/build-confusables.mjs from SHA-pinned vendored inputs, and both integrity
  constants in background.js are written by that builder — a constant somebody has
  to remember to update goes stale, and a stale one here silently drops every
  generated licence.
- Keep the durability veto one-way. Demotion on exact evidence is the contract;
  promotion from observed success would trade "zero silent bad writes" for "one
  per editor, probably once", which is not defensible when fingerprints collide
  and apps redeploy.
- Every refusal reachable by a user must have a status name the popup can
  render. A path that returns false without one is a silence bug, whatever else
  it gets right.
- Preserve the local log's bounded rings and serialized writes. Recording must
  never delay the response shown to the user.
- `tools/package.mjs` packages the explicit `RUNTIME_FILES` allowlist into
  `dist/proofer`. Install and distribute that artifact, not the working tree.
  First-party code is available under the root [Apache-2.0 licence](LICENSE).
  Preserve the third-party data notices and licence texts; their terms are
  documented separately.
- When constants must be duplicated across classic scripts, keep their tests
  in sync. MIN_SENTENCE_CHARS is duplicated across the two runtime files.
- Keep this document current with the runtime. An architectural change — a new
  message type, a new trust boundary, a state machine that gains or loses a
  path, a constant that stops meaning what its name says — is not finished until
  this file and the relevant test documentation say so. Contributors should
  not need private maintainer notes to understand the contract.
- Keep test/lib/harness.mjs sampling defaults synchronized with the production
  options in background.js; unlike the prompt/model extraction, this is still
  a manual mirror.
- If prompts, demonstrations, sampling, the model tag, or its expected digest
  change, run the relevant quality and holdout workflow before updating quoted
  measurements.

## Change map

| Change | Primary files | Minimum test area |
| --- | --- | --- |
| Production model | background.js (`PINNED_MODEL`), setup.sh reads and verifies the tag/digest pair with Node.js, docs/maintainers/publish-model.md | A new model is a new pin: publish it with the licence layers, pull it into a clean Ollama and compare the digest, then put the tag AND digest in `PINNED_MODEL` — a different digest is a failure, never a new pin. For a model change, run the sentence-mode quality suites and the owner bench on the published copy; the setup's timing test re-qualifies every install. Installer changes run `bash -n setup.sh`, `setup-check-test.mjs` [13a–c] (fake Bash commands, Node.js and worker parity), then namespaced `welcome-flow-test.mjs` |
| Sentence prompt or demonstrations | background.js | test/sentence-request-bytes-test.mjs fails on ANY byte change to the request (golden file under test/golden/): a deliberate prompt change re-records it with `--write` in the same commit, a refactor must leave it green. Then contamination, then the owner bench against both holdouts, then the live suite across every context as the meddling diagnostic. Measure with the pinned model: every quality number is a property of prompt and weights together. A change to the LAYOUT (message order, where the host line, context or retry keep-list go) also changes what the runtime can reuse: check it with the cache study's E1 (test/prompt-cache-study/, TESTING.md §29) first, and ship it only after the [model-quality evaluation](test/TESTING.md#evaluating-a-replacement-for-the-pinned-model) and [release checks](docs/releasing.md#verify-the-candidate), on a model trained for it |
| Sampling options | background.js, test/lib/harness.mjs | Sweep sampling on a fixed benchmark with `test/finetune/teacher-pass.mjs`, using `PROOFER_OPTIONS` and separate output files for each configuration; then run the owner bench on both holdouts. See TESTING.md, “Evaluating a replacement for the pinned model.” |
| Worker transport, parser, or sanitizer | background.js (`sanitizeSentenceOutput` owns the question) | Sanitizer, guard-tools caller/comparator fixtures, guard/typo-recall/evidence, settings, retry/handler, scoring-engine and request-byte suites, then sentence end-to-end. Both attempt call sites also require the live retry hazard gate. Rejudge recorded outputs separately from live engine/retry measurements |
| Popup/settings/consent | popup.js, popup.html, background.js | Settings suite ([F10]/[F11] cover migration and page consent), popup activation ([11]/[12]/[12b]/[12c] for consent; [12a]/[12d–e] for pending/refused site writes and reconciliation) and views suites ([13] pins frame-scoped history), then open the popup for qualification withdrawal, permitted blur and refused site updates |
| Setup, the speed check, freshness or the badge | welcome.html, welcome.js, background.js (`SETUP_*`, `SETUP_FIXTURES`, `qualificationIsCurrent`, `checkFreshness`, `setupSnapshot`, `publishServiceState`, `updateBadge`) | `test/setup-check-test.mjs` (the worker half: verdicts, lifecycle/reports, observation failures, fresh digest reads, floor enforcement, failure codes, badge recovery and preview isolation), then `test/welcome-flow-test.mjs` under `unshare -rn` (the page/worker transitions and real toolbar popup against a fake Ollama), popup activation/views, digest handler/scoring/request-byte gates, typing/flash and live sentence end-to-end. G3.2 keeps `speed-v2` because supported-installation pass semantics are unchanged. A change to a fixture, its expectation, a bound or the procedure bumps `SETUP_BENCHMARK_REVISION` — every stored verdict then needs the check again — and the fixtures are re-verified against the pinned engine |
| Sentence segmentation or trigger | content.js | Split, typing, anchor, and end-to-end suites — and the guard suite, since the trigger label is a guard input. Add the provenance suite when the change touches what the idle path is allowed to send. The pre-send caret deferral is typing [21]/[21b]/[21c] plus the anchor suite's `sentenceCaretRefusal` boundaries; its six named mutants are the bar |
| The provenance baseline (`observedText`, the floor, anything deciding what may be sent) | content.js | The provenance suite, then **the Slate gate — not optional**. The offline suites are textarea-only plus a *shaped* contenteditable, and a shaped fixture has no model to cancel `beforeinput`, so it cannot see an editor that applies keystrokes itself. Keying provenance to `input` alone passed 55/55 and 135/135 while taking real Slate to 0/6 corrections |
| Sentence output safety | background.js, data/words-en.txt, data/names-en.txt | Use the shared sanitizer question and each comparison revision's own question. Guard, typo-recall, multi-typo, and live/model suites — plus the evidence suite, which is the only one a premature return inside a single guard turns red. Score a narrowing by replaying the recorded corpora through both revisions and diffing the verdicts, not by the suites alone: they are hand-built, so a change that moves nothing in them can still move real traffic in both directions |
| The resegmentation collapse (collapseResegmentations, or which guards consult it) | background.js | The same as above, plus test/reseg-wall-survey.mjs, because the recordings are blind here: it damages every alphabetic word boundary in both holdouts three ways and count how many correct repairs the guards admit. The 2026-08-15 round took that from 4,046 walled of 20,990 to 1,364 while moving **zero** verdicts across 2,364 recorded model outputs — a moved space is what a typist produces, not what a model emits. Run it `--compare` against the revision being replaced and read the POLICY-newly-admitted line, not the total: recovering a case whose every fragment is an ordinary word is the documented hazard, not a win |
| A confusable pair | test/build-confusables.mjs, then the regenerated data/confusables-en.txt | Edit the builder's filter, never the artifact; the integrity constants in background.js regenerate with it. `--check`, then the guard and typo-recall suites, then the owner-bench gate on both holdouts, then the end-to-end suite for the worker's crypto path |
| The name list or `nameLicence` | test/build-names.mjs (source: the system `wamerican` list), data/names-en.txt, background.js | Rebuild with the builder, never edit the artifact; `--check`. The name fixtures in the guard suite each pin one condition and each has a named production mutant (ten were run on 2026-09-19); then typo-recall (`OBrien` → `Obrien` is the leak every general rule admitted), the replay of the exports by direction, both holdout `--reguard` runs against a before-baseline, and the resegmentation survey (`--compare` sees this change: the collapse consults the list) |
| Slate/contenteditable writes | content.js | Both captures in sentence-slate-test and fixtures/verify under `unshare -rn` with loopback up; the live Slate canary and full certified-editor suite; paired recipe bench on live and both captures, including burst and no-write controls. The historical `results/slate-fix/bench-matrix.mjs` runner is not included; use the included `test/editor-recipe-probe.mjs` with the [documented baseline override](test/TESTING.md#configuration) |
| The transport registry (a new editor, a recipe, a caret policy) | content.js | test/editor-recipe-probe.mjs first — both recipes, both caret policies, idle and burst, with the no-write control; an editor with no descriptor takes `PROOFER_CANDIDATE_URL` + `PROOFER_CANDIDATE_SELECTOR` and needs no code change, and one worth keeping becomes a row in test/lib/editor-targets.mjs. Then a row in test/sentence-editors-test.mjs in the same commit; the registry entry is the claim and the suite row is its evidence. Then sentence-typing-test.mjs case [10b] for the routing table |
| The bench itself (test/editor-recipe-probe.mjs, test/lib/editor-targets.mjs) | test/ | test/editor-bench-selfcheck.mjs — offline, and the only thing that checks the harness fails loudly rather than measuring nothing — then `--nesting-only` (offline, verdicts must be unchanged) and paired runs against the old accepting capture, new refusing capture and live Slate |
| The sentence flash or its teardown | content.js, styles.css | test/sentence-typing-test.mjs and test/flash-highlight-probe.mjs: typing [2c] pins the textarea undo anchor; probe [F] fallback later-word edit masks Highlight support before injection to pin the contenteditable overlay, alongside the existing Highlight later-word control. Put teardown questions to the DOM directly and run the probe under `PROOFER_CONTENT=<the file you are replacing>` as the pre-fix control: its survival section measures typing, and every editor it drives re-renders in the way that preserves the text node, so all six can stay green over a teardown bug |
| Sentence-mode status or the popup's "is it running here" line | content.js, popup.js, popup.html | sentence-typing-test.mjs [10]/[10b–c] for the status vocabulary and [10d–e] for the shared producer’s canvas fallback and bounded frame priority; sentence-slate-test.mjs [18] for detached cleanup, replacement attachment and consent withdrawal; popup-views-test.mjs [13]/[15] for frame-scoped history and live/remembered removal copy; popup-activation-test.mjs [12]/[12b]/[12c] for worker/frame permission and permitted history; then open the popup in a browser after removal, blur, replacement focus, qualification withdrawal and the intercepted canvas/child frame arrangements |
| The durability veto | content.js, background.js | The verdict allowlist must gain the outcome first, or it logs nothing with no error anywhere; then the certified-editor suite |
| Logs or outcome vocabulary | background.js, content.js, popup.js | sentence-settings-test.mjs cross-checks emitted literals and the documented vocabulary against evaluated worker definitions; [V1] pins stats/receipts and [V5] real-handler family/retired-value acceptance. [V2]/[V3]/[V3b] also pin the shared reason bound, post-write families and read-only historical aliases. Then log-to-cases [4–6], popup-views [14]/[16], typing [2d]/[10f]/[13e] and Slate [13b]/[13c]/[16b] for failed-Escape and post-write consumers and callers |
| Manifest/runtime files | manifest.json and named entries | Reload the unpacked extension and run the sentence end-to-end suite |
| **Adding a runtime file** (a script, a data file, an asset the extension loads) | manifest.json or popup.html, **tools/package.mjs** | test/package-test.mjs. A file that is not in `RUNTIME_FILES` is not in the extension, and the failure is loudest for the three data files: a missing dictionary FALLS BACK rather than throwing, so the package installs cleanly with dictionary vetoes and checks disabled. Missing or invalid confusables/names instead remove generated grants, retaining hand supplements. The suite derives the inventory three ways — manifest references, popup.html `src`/`href`, and `getURL()` literals — because no single one of them can see all three classes |
| **The popup's recorded-prose views** (recent changes, log stats breakdown, export counts) | background.js, popup.js, popup.html | sentence-settings-test.mjs drives the real handlers, including [C8a–b] indexed export counts; popup-views-test.mjs [12a–c] pins snapshotted counts, downloaded diagnostics and empty exports; then open the popup. Eligibility must stay keyed to the VERDICT — a guard refusal's `output` is the text that was refused, so any "did it change" filter turns refusals into receipts — and rendering must stay `createTextNode`/`textContent`, since this is the one path that puts untrusted prose into an extension DOM |
| Adding a suite to CI | .github/workflows/no-network.yml, test/TESTING.md | Prove it offline before adding it, not after: grep it for external URLs, then run it under a loopback-only network namespace (`unshare -rn`, `lo` up). A suite that can exit 77 does not belong in the battery — fix the condition or leave it out |

## Known limitations and current drift

- Canvas editors are unsupported. Sentence mode writes to a textarea or a
  certified editor family, and names the refusal otherwise. Google Docs
  has experimental probes in `docs/spikes/`, but these do not establish
  production support. Their headless results are limited to their fixtures.
- CKEditor 5 is measured and refused, not merely uncertified. Under INTENT it is
  clean at rest and scrambles the user's own text mid-burst, because it honours
  the replay at its own model selection and lands the swallowed character at the
  end of the document; under MUTATION its renderer reverts the write outright
  with the user's text intact. Neither column is a row. The matrix is in
  test/editor-recipe-probe.mjs's header.
- Every finished sentence is sent to the model, and gating that on a cheap
  lexical pre-check is measured and refused rather than merely unbuilt. Three
  results, all in test/prefilter-probe.mjs. The proposed check — a non-word, a
  doubled word, or a word the confusable lists license — clears only 32.4% of
  real sentences, because the licensed-confusable clause covers `to`, `of`,
  `its`, `there` and `then` and so fires almost everywhere. Restricted to
  unknown words it clears 82.8%, at 13% of the corrections and ~62% of the
  welcome style edits, three quarters of which are a comma no word list can see.
  And its apparent damage prevention is an artifact of doing less work: against a
  matched-count random skip it retains corrections far better than chance
  (z = +3.9 to +5.7) but retains *damage* no better than chance, because the damage
  that reaches users is real-word → real-word and the output guards are lexical
  too — the pre-filter's reachable set is the guards' reachable set.
- A correct repair of a moved space is admitted 93.5% of the time, not always,
  and what remains is two policies and one known defect. Structural survey,
  2026-08-15: 20,990 damaged word boundaries across both holdouts, 1,364 correct
  repairs still refused. **560** are the documented policy — every damaged
  fragment is an ordinary dictionary word, so nothing in the sentence says a typo
  is being corrected (`the rapist` → `therapist`, `overtime` → `over time`).
  **783** are the same dictionary gating one step along: the correct repair
  itself contains a token the 64k word list does not have — proper nouns are
  deliberately absent, and so are `capita`, `findable`, `ChatGPT` — so the
  collapse declines and every downstream guard sees an unexplained token. The
  remaining **21** are 13 capital-removed, 5 target-too-short and 3
  protected-token. Only the capital-removed 13 are a defect: that guard does not
  consult the collapse, and wiring it in needs a **case-preserving** collapse
  (`It hink` → `I think` licensed, `Alicea t` → `alice at` not), which is new
  machinery on the most-audited guard in the chain and is not attempted here.
- The Lexical pipeline refusal is **closed**, and the diagnosis it was reported
  under was wrong in an instructive way. It was not the caller misjudging a
  successful write: the write had genuinely not happened, because the sentence
  filled its block and Lexical drops a whole-block replacement. "The transport
  returns landed when called directly" was true and misleading — the direct call
  typed a tail first. The write is now narrowed to the differing span and the
  recipe verifies its own result; Lexical is 8 of 8 through the shipping
  pipeline at a jittered cadence, and every other family 4 of 4.
- **Draft can destroy a paragraph, and it is pinned rather than fixed.**
  Correcting a block while the caret sits in a *later* one replaces that later
  block with a second copy of the correction — the user's own paragraph, gone.
  It is not the whole-block hazard above: narrowing does not change it, and
  putting the caret back in the corrected block makes it clean. It did not
  reproduce through the shipping pipeline (type, Enter, keep typing), so the
  real condition is narrower than "the caret is in another block" and is not
  characterised — which is why no guard was invented for it. What changed is
  that the transport reports `normalized`, the element is blocked with
  `write-normalized`, and the record says `sentence-written:splice-failed:normalized`.
  Its target was occupied, so it counts as applied with a receipt explaining
  changed surroundings; it does not arm a flash or Escape slot. sentence-editors-test.mjs [9] pins the measurement in both
  directions, so Draft starting to keep the block fails the suite too and gets
  promoted to the plain assertion the other five families carry.
- Every exit of applySentenceWrite now reports what became of the correction.
  The maxlength refusal was the last one that counted a skip and returned, so a
  correction the model produced and the field could not hold was
  indistinguishable in the log from a request still in flight. It goes through
  dropSentenceResult, which pairs the counter with the record, using
  `sentence-skipped:` for a pre-write drop. Post-write normalization and
  misplacement use the two declared `sentence-written:` families instead.
  sentence-typing-test.mjs [5i] pins it; that case already typed into a capped
  field and asserted only that nothing was applied, which is also what a hang
  looks like.
- The two pieces of the write path that were tested by nobody now are, in
  `sentence-slate-test.mjs` [13b]/[13c] and [14]. The consequence half of the
  misplaced/normalized split — family demotion versus an element block, shared
  by apply and undo — is
  asserted through `sentenceFieldStatus` on a fresh sibling that was never
  written to, which is the only observation that separates the two, and with
  controls in both directions so neither "demote on every failure" nor "block on
  every write" can pass. The isTrusted gate on the verification waiver is
  measured by two arms differing only in where the keystroke came from, with the
  replayed character asserted in both so a false negative cannot be mistaken for
  an event that never arrived. Both were confirmed by mutation: four one-line
  changes to `content.js`, each turning only its own assertions red.
- test/fixtures contains seven captured third-party pages, including both Slate
  builds. All seven boot and accept typing offline; both Slate captures gate
  transport behavior and the six editor families also feed the flash probe.
  Provenance headers name source, capture date and licence; the new Slate header
  also records the build, slate-react/slate-dom source fingerprints and bundle
  SHA-256. These captures are excluded from the runtime package.
- There is no streaming or cloud fallback. A correction waits for the complete
  local response; an unavailable Ollama trips the circuit breaker and shows in
  the popup.
- UI nodes share the page DOM and can conflict with hostile or unusually broad
  page CSS despite namespacing and maximum z-index values.
- All-frame injection is needed for embedded editors but makes origin semantics
  important. Sentence consent is decided on the top-level origin the worker
  derives from the sender, so disabling a site covers its embedded editors.
  An embedded editor's own origin cannot veto that permission. Both switch-off
  lists apply to the parent, including live revocation and a fresh page load;
  sentence-e2e-test.mjs covers cross-origin editors and the real popup in each
  state. Typing [14b] pins worker refusal, [14c] embedded attachment, and [14d]
  lazy initialization.
- claude.ai cannot be certified headless: it needs a login, so its ProseMirror
  composer is covered by the family row rather than by a run against the site
  itself. [test/TESTING.md](test/TESTING.md) carries the manual checklist, which
  has not yet been run; the durability veto is the backstop until it is.
- Authorization is per family, not per origin. `.ProseMirror` matches TipTap,
  Linear, GitHub and claude.ai alike, each with different plugins; that is the
  standard already in force, since `[data-slate-editor="true"]` has authorized
  every Slate site on the web on the evidence of one demo page. The plugin worry
  is measured rather than argued — TipTap is indistinguishable from core
  ProseMirror for this transport — and Phase 3's veto is the enforcement.
- Slate >= 0.128 rejects synthetic beforeinput, so automatic corrections and
  new Escape undo slots are unavailable on those stock builds. The first
  uncancelled attempt restores the user's exact selection synchronously and
  blocks only that field as `write-rejected`; a fresh sibling remains eligible.
  There is no MUTATION fallback. This is a safe refusal, not a successful write.
  On accepting older builds, replay still uses `insertReplacementText`: a lone
  synthetic `insertText` takes the native fast path and stays invisible until a
  later input. The cancellation check prevents replay through an already
  rejected transport; it does not certify custom uncancelled handlers, Android,
  IME, arbitrary plugins, or every historical release in a browser.
- The release pins the engine's tag and digest in `PINNED_MODEL`. Before the
  first sentence send, the worker refuses an unavailable digest check, a missing
  pinned tag, or a different digest. The lookup can reuse evidence for up to
  30 seconds; the retry does not perform a separate lookup. Requests still
  address an Ollama tag, so verification and dispatch are not atomic against
  concurrent retagging. See “Worker validation” for the enforcement path.
- Docker Compose pins Ollama 0.34.3 by digest (it pinned 0.18.2, below the
  0.32.6 floor setup enforces, until 2026-10-01). The beta's probes and timing
  were taken on 0.32.12; 0.34.3 was measured on 2026-10-01 against the same
  pinned model — quality level within run-to-run noise, the prompt-cache reuse
  map identical, ~125 ms less per warm request
  (aggregate evidence: `test/results/ollama-0.34.3-2026-10-01.json`). The floor stays
  0.32.6.
