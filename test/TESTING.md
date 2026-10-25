# Proofer Test Harnesses

Tests for Proofer's live sentence editing, safety gates, setup, packaging, and
model quality. Many suites run without Ollama: source-only suites use Node
builtins, and browser suites drive real keystrokes and captured editor bundles
with canned model replies. Model-quality and real-model end-to-end suites need
Ollama. Historical studies below retain the models and measurements they used;
they are not current product defaults.

The public deterministic suite does not require private writing or training
corpora. The sections marked as studies, research or corpus-based benchmarks
are optional and may need inputs that are not distributed. Missing private
inputs mean those measurements cannot be reproduced from a fresh clone; they
are not a prerequisite for contributing an unrelated runtime change. Historical
commit IDs identify earlier private snapshots and may not resolve in the
public repository. See [results/README.md](results/README.md) for the retained
measurement artifacts and their publication cleanup.

## Start here

Run these commands from the repository root:

| Check | Command | What it needs |
| --- | --- | --- |
| 22 source suites | `npm --prefix test test` | Node.js; no dependency install, browser or model |
| 12 browser suites | `npm --prefix test run test:browser` | Locked test dependencies and Chrome for Testing; local fixtures and canned replies |
| Real-model end-to-end | `npm --prefix test run test:e2e` | Ollama, the exact pinned model, a browser and a passing setup speed check |

Follow [contributor setup](../CONTRIBUTING.md#set-up-a-checkout) for the browser
installation and isolation steps. [Configuration](#configuration) explains
supported overrides, and [tools/test.mjs](../tools/test.mjs) lists the routine
suites. The optional [research instruments](finetune/README.md) may require
private corpora or omitted adapters; they are not part of these routine groups.

## Prerequisites

- Use Node.js 22.12 or later; Node.js 24 is recommended. Source-only suites need no
  npm dependencies or model.
- Browser suites: npm 11.9 or later (11.12.1 recommended and used by CI),
  `npm ci` from this directory, plus Chrome for Testing or `PROOFER_CHROME`
  (see below). Linux/macOS need `unzip` to extract the browser download;
  Windows uses its native archive tools. See
  [contributor setup](../CONTRIBUTING.md#set-up-a-checkout) for the pinned npm
  upgrade command if Node's bundled npm is too old for the quarantine policy.
- Model-quality suites: Ollama running at `http://localhost:11434`, with the
  exact `PINNED_MODEL` from `../background.js` installed. The current tag is
  `jayafowler/proofer:v1-q4`; `ollama pull jayafowler/proofer:v1-q4` installs it.
  The shared harness verifies its digest rather than trusting the tag.
- `sentence-e2e-test.mjs`: also needs the product's setup speed check to pass;
  it loads the real extension in a fresh browser profile and activates through
  the setup page. It does not bypass qualification or consent.

## Configuration

Shared config lives in `lib/harness.mjs` — model name, Ollama URL, sampling
options, prompt extraction from `background.js`, and latency instrumentation.
Quality suites use the shipping pinned model by default and retain research
overrides. The extension itself has no model selector. Real-extension suites
such as `sentence-e2e-test.mjs` always use the product pin.

| Variable | Default | Purpose |
|---|---|---|
| `PROOFER_MODEL` | production model | Model to test |
| `PROOFER_SKIP_DIGEST_CHECK` | off | Any nonempty value opts research admission and inference out of the pinned digest check; never changes the extension's pin |
| `PROOFER_OLLAMA_URL` | `http://localhost:11434` | Ollama base URL |
| `PROOFER_OPTIONS` | production config | Research sampling override for suites that support it; does not configure the installed extension |
| `PROOFER_LIMIT` | (all) | Run only the first N cases — for smoke-testing the harness, not for real numbers |
| `PROOFER_RESULT_JSON` | (off) | Write a machine-readable summary to this path |
| `PROOFER_TRIGGER` | `idle` | The trigger label `proofer-test`, `proofer-holdout` and `meaning-drift-test` hand the guards (it is a guard input) |
| `PROOFER_CORPUS_DIR` | script-relative `harvested/` for `preguard-score.mjs` | Select the scorer's labels directory; recognized run filenames still select the matching labels file |
| `PROOFER_NO_DICT` | off | Combined historical guard-seam control: no words or generated confusables/names; not a words-only fetch failure |
| `PROOFER_NO_CONFUSABLES` | off | Retain only hand confusables in both default and audit variant chains |
| `PROOFER_NO_NAMES` | off | Retain only hand names in both default and audit variant chains |
| `PROOFER_SENTENCE_GUARDS` | on | `0` scores the cleaned model output instead of what the guards let through — separates the model from the guards |

The manual-path prompt overrides (`PROOFER_PROMPT`, `PROOFER_PROMPT_FILE`,
`PROOFER_USER_TEMPLATE`, `PROOFER_FORMAT`, `PROOFER_VARIANT_FILE`) went with
that path on 2026-09-24. The suites that still run build the **sentence**
request through `background.js` itself, so the prompt is whatever ships.
`proofer-test`, `proofer-holdout`, and `meaning-drift-test` use the shipping
sentence engine, whose request carries
its production options. Consult the scoring-engine section below for the
explicit research override supported by `callSentence`.

```bash
node proofer-test.mjs   # current pinned product model
```

`lib/harness.mjs` is a Node ESM module. The runtime content scripts use classic
scripts in a buildless MV3 setup; these harnesses run in Node and can use ESM.

Two more cut across the **browser** suites rather than the LLM ones:

| Variable | Default | Purpose |
|---|---|---|
| `PROOFER_CONTENT` | shipping `content.js` | Run the suite against a different `content.js` — a proposed variant, a checked-out "before" (`git show HEAD:content.js > /tmp/old.js`), or a scratchpad snapshot. A missing path is exit 1, and the run announces the override in its banner *and* its final line. Two uses: a pre-fix control, so a new assertion is shown to go red; and pinning a green to bytes that still exist, since several sessions can edit one file and a pass whose input moved underneath it is not evidence. Supported wherever `content.js` is read through a path that consults it, which is two routes rather than a list: the browser suites that read the file directly (`sentence-typing-test.mjs`, `sentence-slate-test.mjs`, `slate-intent-probe.mjs`, `editor-recipe-probe.mjs`) and **everything that goes through `lib/content-sandbox.mjs`**, which honours it for its callers — `sentence-guard-test.mjs`, `sentence-anchor-test.mjs`, `sentence-split-test.mjs`, `sentence-editors-test.mjs`, `sentence-window-test.mjs`. The editor suite evaluates and injects the single `CONTENT_SOURCE` snapshot exported alongside `CONTENT_PATH`; it never rereads the selected file during a run. Its banner and final result identify that resolved path. Checking the route is reliable; checking this list is not, and it had drifted by six suites before anyone read it. Note `styles.css` has **no** override, so a variant `content.js` is always measured against the local stylesheet — irrelevant to text and caret assertions, and a real trap for anything measuring paint |
| `PROOFER_SEED` | random, printed | Fixes the jittered keystroke stream. The jitter is deliberate — a fixed cadence resonates and hides corruption completely — and its cost is an intermittent failure nobody can reproduce. The seed is printed on every run, so a red names the rhythm that produced it and `PROOFER_SEED=<n>` replays it. It turned a 3-in-4 failure into a paired experiment inside an hour: same seed, broken build 3/3 FAIL, fixed build 3/3 PASS |

### Which Chrome the browser suites run

`lib/chrome.mjs` answers that for all of them, in one order:

1. `PROOFER_CHROME`, if set — and it's an error, not a fallback, if that path
   doesn't exist.
2. The pinned Chrome for Testing build (`node scripts/install-chrome.mjs`).
   `.npmrc` disables lifecycle scripts, so this is a separate step and its
   absence is normal.
3. A system install — `google-chrome`, `chromium`, or the macOS bundle.

Chrome for Testing is preferred over any system Chrome because branded Chrome
>= 137 silently ignores `--load-extension`, which the extension-loading suites
need. Nothing found throws with the install command rather than falling through
to a path that doesn't exist — a bad `executablePath` surfaces as an ENOENT from
inside Puppeteer's launcher, which reads like a Puppeteer bug.

All candidates must meet the security floor in `chrome-version.json`. The
explicit installer checks the official artifact release age before downloading;
its targeted Chrome CVE exception does not relax the npm dependency quarantine.

### Exit codes

`0` pass, `1` failure.

`sentence-slate-test.mjs` **no longer needs the network at all**. Its default
mode serves two real slatejs.org rich-text builds at their original paths from
loopback: the preserved August accepting build and the October untrusted-input
refusing build. Both are mandatory; see §17 for the 223-check inventory:

| Situation | Exit |
|---|---|
| fixture mode, assertions pass | 0 |
| fixture mode, assertion fails | 1 |
| **fixture missing** | **1**, naming the missing capture (preserve the August capture; use `slate-current` for the current snapshot). No 77, and `PROOFER_SLATE_OPTIONAL=1` does *not* rescue it |
| fixture present but broken, or no `[data-slate-editor="true"]` | 1 |
| live mode (`PROOFER_SLATE_LIVE=1`), slatejs.org unreachable | 77 (0 with `PROOFER_SLATE_OPTIONAL=1`) |
| live mode, page loads without the selector | 1 |

`sentence-editors-test.mjs` still drives live demo sites and keeps the original
77 contract, and the reason it exists is worth keeping: both suites used to exit
**0** on an unreachable site, which is also what a clean pass returns — the only
suites that can catch a DOM/model divergence were indistinguishable from suites
that never started. 77 stops an `&&` chain and is not `1`, so a skip never reads
as a failed assertion. `PROOFER_EDITORS_OPTIONAL=1` restores exit 0 for a batch
run that tolerates the gap. A page that loads but has no editor at the expected
selector exits 1 — the site moved and the selector needs re-pointing, which is
not an outage.

Offline is **enforced**, not asserted: a `--host-resolver-rules` mapping
everything but `127.0.0.1` to NOTFOUND, a CSP baked into the captured HTML, and
per-request interception that fails the run if anything leaves the loopback
origin, re-checked at end of run because most cases load the page again.

The live canary observes cancellation and chooses the corresponding landing or
safe-refusal contract; no hard-coded version controls it. Five offline-only
checks and the old-model Escape setup are absent from a refusing live run. The
default always exercises both builds. Historical totals describe their revision.

### Capturing and verifying fixtures

```bash
node fixtures/capture.mjs slate-current # current Slate, separate from the August control
node fixtures/verify.mjs                # all 7 captures, including BOTH Slate builds
node fixtures/verify.mjs slate slate-current # the two Slate builds only
```

Each captured HTML carries a provenance header: source URL, capture date,
project and licence, the two edits made to the wire bytes (a CSP added, an
external `<link rel=preconnect>` removed), the Chrome that captured it, and the
re-capture command. Assets are kept as separate files at their real paths and the
entry is served at its **original** URL, so a framework router hydrates against
the pathname it shipped with. `slatejs.org` stays the 2026-08-25 positive control
(slate-react 0.126.3 / slate-dom 0.126.0, build `3dCeb8NLi7F0NNZ8qwnk-`).
The second directory, `slatejs.org-2026-10-09`, fingerprints as slate-react and
slate-dom 0.132.0, build `tsAE1mpvWW79X1Ug5Z89V`. Its header names the exact
bundle SHA-256 and source fingerprints, cross-checked against the drift audit.
Do not overwrite the old capture or use `--all` to refresh it. All six editor
families also feed the flash probe; the two Slate builds gate transport behavior.

Four capture facts, each bought by a wrong answer: `<head([^>]*)>` also matches
`<header >`, so the CSP meta landed inside ProseMirror's `<header>` where Chrome
ignores it — a fixture with no offline guarantee that looked exactly like one
that had it. A **trailing slash** is load-bearing: `/examples/basic` resolves
relative asset paths one directory too high and the page loads with no editor. An
extension-less path served as `application/octet-stream` makes Chrome abort the
navigation with a bare `ERR_ABORTED` and nothing pointing at the MIME type. And a
capture that never **scrolls** is incomplete, because a prefetching framework
only asks for the links it can see.

## Continuous integration — the no-network battery

`.github/workflows/no-network.yml` runs the selected deterministic groups on
push, pull request and manual dispatch. The suite lists and execution order
live in `tools/test.mjs`, shared by local runs and CI:

| Job | What it runs | Needs | Measured |
|---|---|---|---|
| `source-only` | `storage-security-test`, `fixture-security-test`, `sanitizer-test`, `sentence-split-test`, `build-confusables --check`, `sentence-guard-test`, `sentence-typo-recall-test`, `sentence-anchor-test`, `sentence-settings-test`, `sentence-request-bytes-test`, `sentence-retry-test`, `log-record-test`, `log-latency-test`, `sentence-retry-handler-test`, `scoring-engine-test`, `log-to-cases-test`, `setup-check-test`, `contributions-test`, `sentence-evidence-test`, `fixtures/verify-provenance`, `privacy-policy-test`, `package-test` | **nothing** — Node builtins and `test/lib` only | Historical: **~20 s** before the later source suites joined (0.5 s before the retry suites); use the workflow step logs for current durations |
| `browser` | `browser-security-test`, `runtime-security-test`, `editor-recipe-probe --nesting-only`, `fixtures/verify`, `sentence-typing-test`, `sentence-provenance-test`, `editor-bench-selfcheck`, `popup-views-test`, `welcome-flow-test`, `popup-activation-test`, `sentence-slate-test`, `flash-highlight-probe` | headless Chrome, loopback | **~5 min** before the flash probe joined (2026-08-24, ~2 min locally); remeasure on its first CI run |

`source-only` runs with `test/node_modules` **absent** — measured, not assumed.
Every suite in it resolves to Node builtins and other files under `test/`
(`test/lib`, and `sentence-guard-test.mjs` also imports its sibling
`build-confusables.mjs`) — nothing reaches `node_modules`, so the job needs no
`npm ci` and finishes in about the time the checkout takes.

**The gate is that the deterministic half did not regress.** It says nothing
about correction quality: the model, the prompt and everything measured against
them are out of scope by construction.

The OS-install workflow runs only through `workflow_dispatch`; ordinary pushes
do not start it. Manual dispatch can select Windows, macOS or both. This
separate installation check uses the packaged extension and real Ollama; see
[§32](#32-os-install-checkmjs--the-out-of-box-install-on-windows-and-macos).

### What is excluded, and why

- Anything needing **Ollama** — `proofer-test`, `proofer-holdout`,
  `sentence-live`, `sentence-owner-bench`, `sentence-e2e`, the sweeps.
- Anything needing a **third-party site to be up** — `sentence-editors-test`,
  `slate-intent-probe`, and `editor-recipe-probe`'s full matrix. Only
  `--nesting-only` runs, which returns before it reads a target row.
- `flash-highlight-probe.mjs` **is no longer excluded** (2026-08-24). It was
  the near miss — Draft and Trix had no capture, so it needed the network or
  exit 77. Both were captured (the probe was not relaxed), and it now runs in
  the browser job inside the namespace like every other browser suite.

### Why the test phase is provably network-free

One mechanism and one argument, and they are not of equal standing:

1. **Enforcement — this is what gates.** Every browser suite in CI runs inside
   a loopback-only network namespace (`unshare -rn`, then `ip link set lo up`),
   so an accidental external fetch *fails* rather than passing quietly. A
   preflight step proves the namespace really denies (creating one is not the
   same as it isolating) and **fails the job** if it cannot, rather than
   degrading to an unenforced run.

   That last clause was load-bearing on the **first five runs**, all of which
   were red and none of which executed a single browser suite: `ubuntu-latest`
   is 24.04, which ships
   `kernel.apparmor_restrict_unprivileged_userns=1` and so denies `unshare -rn`
   to a non-root user. A step before the preflight now clears that sysctl with
   `sudo`, which keeps the namespace **unprivileged** — the alternative,
   `sudo unshare -n`, buys the same isolation by running the whole battery as
   root. The step is best-effort by design and cannot weaken anything: the
   preflight after it is unconditional and fatal, so a runner where the clear
   does not work fails exactly as it did before.

   Measured both directions: the battery is green inside the namespace, and
   `PROOFER_SLATE_LIVE=1` inside it exits **77** with
   `net::ERR_INTERNET_DISCONNECTED` — so the sandbox demonstrably bites, and 77
   is non-zero and therefore red.

   **It is not byte-reproducible, and the earlier claim that it was is
   withdrawn.** Two runs at the same pinned `PROOFER_SEED` agree on every
   verdict (44/44 both times) but differ in the ephemeral loopback port and in
   a timing-derived count inside one `PASS` label — `corrections actually
   landed while typing` measured 6/6 and 4/6. That assertion is `landed > 0`
   by design ("just evidence the pipeline is alive"), so the flake surface is
   small but real: a runner slow enough to land *nothing* would fail it.

2. **A grep audit, which is weaker than it looks.** What it can support is
   "nothing **fetches**", not "no external URL appears" — several included
   suites contain external URL strings. `sentence-settings-test.mjs`'s are
   origin-normalisation *test data*; `sentence-slate-test.mjs` names slatejs.org
   only behind `PROOFER_SLATE_LIVE`, which CI does not set; and
   `editor-recipe-probe.mjs` knows about live demo sites, which
   `--nesting-only` does not navigate to. How many, and where they are
   declared, is deliberately not recorded here — it has already moved twice,
   and the only property CI depends on is that nothing fetches.

   **And it must follow imports.** The audit behind the workflow was per-*file*,
   which sufficed only because the probe's URL literals are inline today. Move
   them into a module the probe imports and a per-file grep returns clean while
   nothing has actually changed — the "passes for the wrong reason" shape this
   repo keeps re-finding. Prefer running the battery offline over greping it.

Setup (`npm ci`, the Chrome download) is allowed the network. Everything after
it is offline by construction. Loopback is used heavily — the captures are
served from a local HTTP server — so a namespace with `lo` *down* fails.

### Two CI-specific hazards worth knowing

**The runner already has a Chrome, and it is the wrong one.** `ubuntu-latest`
ships branded Google Chrome at `/usr/bin/google-chrome`, which `lib/chrome.mjs`
would silently fall back to if the Chrome for Testing download failed — and
branded Chrome ≥ 137 ignores `--load-extension` without saying so. The workflow
therefore awaits `puppeteer.executablePath()` and pins `PROOFER_CHROME` to it,
failing loudly there rather than changing browser mid-battery.

**77 must never read as a pass**, and here it cannot: no suite in the battery
can return it (the Slate gate is offline-only and exits 1 on a missing capture;
`--nesting-only` returns before the probe's outage paths). Should one ever
surface, GitHub fails a step on any non-zero exit, so 77 is red.

### Reproducing a CI run locally

```bash
cd test
npm ci                                   # see the worktree warning below
node scripts/install-chrome.mjs
export PROOFER_CHROME="$(node -e "import('puppeteer').then(async p=>console.log(await p.default.executablePath()))")"
```

Return to the repository root and use the same group runner as CI:

```bash
cd ..
node tools/test.mjs source
unshare -rn sh -c 'ip link set lo up && node tools/test.mjs browser'
```

The browser command above is the Linux CI isolation boundary. The source group
uses no browser, model or npm packages; some suites bind local loopback ports.
Its network behavior is checked by inspection, rather than a network namespace.
The runner clears research `PROOFER_*` overrides for these two groups, except
`PROOFER_CHROME` and `PROOFER_SEED`, and points model access at a closed port.
Run a specific suite directly when deliberately testing a research override.

> **Worktree warning.** If `test/node_modules` is a **symlink** into another
> checkout — a common way to share one install across `git worktree` trees —
> then `npm ci` run here will delete the *shared* directory, because `npm ci`
> removes `node_modules` before installing and follows the link to do it.
> Remove only the symlink before installing dependencies into this checkout.
> The repository's `test/node_modules` ignore rule covers both a directory and
> a symlink; that does not make installing through a shared symlink safe.

### Diagnostics

On browser-job failure, the workflow uploads any available
`test/results/*.json` diagnostic files. The group runner does not force every
suite to create a JSON artifact, so a failed run may have no such files.
Standard output and errors remain in the workflow step logs.

OS-install artifacts are uploaded on success and failure and include the
installation report, setup evidence, screenshots, and Ollama server log.

## Latency

Every LLM suite reports interaction and attempt latency alongside pass rates.
An illustrative two-attempt interaction:

```
Latency (per interaction, wall-clock over 1 calls):
  median 1050ms   p95 1050ms   mean 1050ms   min 1050ms   max 1050ms
  total 1050ms recorded interaction wall time
Latency (per attempt, wall-clock over 2 calls):
  median 300ms   p95 700ms   mean 500ms   min 300ms   max 700ms
  total 1000ms recorded attempt wall time
  tokens: generation 24   prompt 200   generation 120 tok/s   prompt 2000 tok/s
```

`callSentence` records the whole engine interaction once, including preflight,
guards and retry work. Each dispatched attempt uses the engine's own timing
row: fetch through body consumption or terminal failure. Failed attempts count;
an unsent interaction contributes no attempt. Retry counters are included.
Missing counters stay null, token totals sum recorded counts, and throughput
uses only paired token/duration counters from the same attempt. Model load is
reported separately; it can recur after the first request.

`createLatencyTracker.recordInteraction(wallMs, attempts)` consumes these rows;
`recordTiming(timings)` accepts normalized milliseconds, and direct-fetch callers
retain `record(wallMs, data)` for raw Ollama nanosecond counters. Existing
top-level `.stats()` fields remain request metrics; `.interaction` adds a wall
summary (null for direct-fetch-only callers). Core/holdout result JSON inherits
both views. Historically, the parameter-sweep and prompt-A/B tools reported
latency for the removed manual path; both tools are frozen and do not run today.

## Test Suites

### 1. `proofer-test.mjs` — Main suite (single-sentence cases)

The primary regression test. Covers typos, missing letters, extra letters, transposed letters, word boundaries, duplicates, wrong words, missing words, extra words, mixed errors, and clean text.

```bash
node proofer-test.mjs
```

- **Since 2026-09-24 every case goes through the sentence pipeline**, and since
  2026-09-25 through `background.js`'s own sentence engine (`runSentenceEngine`,
  via `callSentence` in `lib/scoring.mjs`): the request it sends (no prior
  context), the guards, the guard-informed retry, truncation handling and the
  product's 4.75 s arrival deadline. What is scored is what would reach the
  field — a refused, truncated or expired correction scores as the unchanged
  input — and the banner's `engine:` line says how the answers were reached
  (applied, refused, retried and salvaged, past the deadline). Until 2026-09-25
  `callSentence` had its own caller with a 120 s timeout, no retry and no
  truncation check (checkpoint 1); `scoring-engine-test.mjs` now pins the
  difference offline. Research knobs the product does not have:
  `PROOFER_MODEL`, `PROOFER_OPTIONS` (laid over the request's options),
  `PROOFER_DEADLINE_MS` (slow hardware; the run then no longer measures what a
  user gets), `PROOFER_SENTENCE_GUARDS=0` (the model's cleaned output, no
  engine). It was written against the manual rewrite path, which the beta
  removed; cases that are not one sentence are skipped and counted in the
  banner. **Numbers from before 2026-09-24 measured a different prompt and are
  not comparable.**
- Reports per-test PASS/PARTIAL/FAIL with detailed failure output

### 2. `proofer-holdout.mjs` — Holdout validation

Tests the model has never seen during prompt tuning. No overlap with proofer-test.mjs cases or system prompt examples. Measures genuine generalization.

```bash
node proofer-holdout.mjs
```

- Ported to the sentence pipeline on 2026-09-24, exactly as `proofer-test.mjs`
  above; multi-sentence cases are skipped and counted.

### 3. `prompt-ab-test.mjs` — retired prompt A/B comparison

The manual-path prompt comparison was retired on 2026-09-24. The checked-in
stub exits 2, and its historical implementation is not part of the public
snapshot. For the current sentence prompt, use `sentence-request-bytes-test.mjs`
to detect accidental request changes, then the core and holdout quality suites
against the pinned model. See “Evaluating a replacement for the pinned model”
for the research override and scoring workflow.

### 4. `param-sweep.mjs` — retired sampling sweep

The manual-path sampling sweep was retired with that path; its stub exits 2.
The earlier implementation is unavailable in the public history. Current
sampling experiments use `finetune/teacher-pass.mjs` with a fixed, separately
supplied benchmark and `PROOFER_OPTIONS`; those optional research inputs are
not included. Record each configuration separately and retain a baseline.

### 5. `interaction-test.mjs` — RETIRED 2026-09-24

It drove the manual rewrite UI (the floating button, the panel, the hotkey)
against a real Ollama. Before it was deleted, the four checks that were not
about that UI were ported: the generic-error check is "Ollama's own error text
never reaches the content script" in `sentence-settings-test.mjs` (a 404 and a
200 carrying an error both answer with a code, never a model name or a raw
body); the popup's no-site line
is `popup-activation-test.mjs` [6]; the disabled-site check is
`sentence-typing-test.mjs` [14b] (worker consent is asked and its refusal
prevents attachment, warmup and rewriting); and
"every message type closes its port" is an offline section of
`sentence-settings-test.mjs` that reads the handled types out of
`background.js`, so a new handler without a probe fails. The deleted manual-UI
suite is not included in this public snapshot.

### 6. `panel-controls-test.mjs` — DELETED 2026-09-24

It tested the rewrite panel's form controls, which were removed with the manual
path. Its historical implementation is not included in the public snapshot;
current popup controls are covered by the popup suites below.

### 7. `repeat-study.sh` + `analyze-repeats.mjs` — Run-to-run variance

```bash
./repeat-study.sh 5 && node analyze-repeats.mjs
```

Runs both LLM suites N times per model and reports the pass-count distribution,
standard deviation, and whether two models' ranges actually separate.

Use it before quoting any model comparison. A single suite pass is one sample:
qwen3.5's core score moves between 103 and 104 of 105 across identical runs,
which is the same magnitude as the gap between the two models. Point estimates
from n=1 cannot tell those apart; disjoint ranges over n=5 can.

### 8. `path-smoke-test.mjs` — DELETED 2026-09-24

It checked the manual path's tone and partial-selection prompts, which were
removed. Its historical implementation is not included in the public snapshot.
Use the sentence request-byte and live-sentence suites for the current path.

### 9. `prompt-lab.mjs` — retired prompt iteration study

The old high-n prompt lab measured the removed manual path. Its checked-in
stub exits 2, and the historical implementation and override API are not
available in this public snapshot. New prompt experiments must use the
current sentence request and scoring engine. Keep the holdout separate from
prompt tuning, record both improvements and regressions, and evaluate repeated
runs before drawing conclusions from small pass-count differences.

### 10. `model-bakeoff.mjs` — Multi-model comparison

Runs the suites against several models and prints one comparison table. Each
suite runs as a child process with `PROOFER_MODEL` set, so the suites stay the
single source of truth for test cases and scoring.

```bash
node model-bakeoff.mjs --list                          # what's installed
node model-bakeoff.mjs qwen3.5:9b ministral-3:14b      # core + holdout, both models
node model-bakeoff.mjs --limit 5 a:1b b:2b             # smoke run (~1 min, not valid numbers)
```

| Flag | Effect |
|---|---|
| `--suites <list>` | `test`, `holdout` (the default; `ab` and `sweep` went with the manual path) |
| `--limit <n>` | First n cases per suite — smoke runs only |
| `--options <json>` | Sampling options applied to every model |
| `--json <path>` | Report location (default `test/results/bakeoff-<timestamp>.json`) |
| `--no-warmup` | Skip the warmup call before each suite |
| `--no-unload` | Leave models resident (default evicts everything else before a run, and the model itself after) |
| `--verbose` | Stream child suite output instead of a progress line |

Output columns: pass% and pass+partial% for core and holdout, median and p95
latency, generation tok/s, and model size. Ranked by PASS + half credit for
PARTIAL, averaged across the scored suites.

Two fairness details that matter on a single GPU, both on by default: each
model is **warmed up** before its suite runs (so load time doesn't land in the
first sample), and every *other* model is **evicted** via `keep_alive: 0`
before the run — including models loaded by unrelated work, so a leftover
resident model can't skew the latency numbers. `--no-unload` turns both
evictions off.

The report JSON carries every failed case for each model, so two models can be
diffed case by case after the fact.

Budget: core + holdout is 160 model calls per model. At ~400ms that's about a
minute per model on a warm 9B; a 14B on a busy GPU can be 5x that.

### 11. `meaning-drift-test.mjs` — Meaning preservation

Ported to the sentence pipeline on 2026-09-24 (see §1); the table below was
measured on the manual path and is history.

The other suites ask "did it fix the error?". This asks "did it fix **only** the
error?" Every case pairs an obvious typo with something the model must not
touch — a negation, a hedge, a quantifier, a proper noun, or a second reading
the typo could support.

```bash
node meaning-drift-test.mjs
PROOFER_MODEL=qwen3.5:9b node meaning-drift-test.mjs
```

Failures split into **DRIFT** (changed something it shouldn't) and **UNFIXED**
(left the typo alone), because the two call for opposite remedies. Contraction
style (`they're` / `they are`) is not counted as drift.

This suite exists because a model can score well on core and holdout while
quietly rewording what the user said — the typo does get fixed, so the other
suites are satisfied. Measured 2026-08-05:

| Model | Core | Holdout | Meaning drift |
|---|---|---|---|
| LFM2.5-2.6B | 97.1% | 98.2% | **87.5%** (4 drift, 1 unfixed) |
| qwen3.5:9b | 98-99% | 100% | **95.0%** (1 drift, 1 unfixed) |

Near-parity on error-fixing, 7.5pp apart on preservation. The drift is
**lexical, not semantic**: negation 6/6, quantifier 5/5 and hedge 5/5 are
perfect on both models, so LFM2.5 is not inverting sentences. It expands
jargon (`postgres` → `PostgreSQL`, `deploy` → `deployment`) and occasionally
drops an intensifier (`to many reminders` → `many reminders`).

Note `±1` case of run-to-run variance here. Core shows it too — 101-102/105
across ~10 runs on 2026-08-06, against the `sd 0` the n=5 repeat study recorded
earlier — so the model is not as deterministic as that study suggested. Repeat
before believing any 1-case delta, on any suite.

### 12. `sanitizer-test.mjs` — Output sanitizer (108 checks; 20 before G6.6)

No Ollama, no browser. Pulls `stripMarkdown` / `asciify` / `normalizeWhitespace`
out of `background.js` with `vm`, so it tests the shipping functions rather
than a copy. (`stripPromptTags` and `isSubstantivelyEqual` had only manual
callers and went with that path on 2026-09-24; their 11 checks went with them.)

```bash
node sanitizer-test.mjs
```

The sanitizer runs on the **model's** output, but the model echoes most of the
user's text back verbatim — so anything it strips too eagerly was a silent edit
to words the user typed on the manual path, and on the sentence path (which only
asks whether the sanitizer WOULD change the answer) a refusal of every sentence
carrying the user's own markers.
Blanket markdown stripping did exactly that: `__init__` → `init`, `**kwargs` →
`kwargs`, `` `npm run build` `` lost its backticks, `2*3*4 = 24` → `234 = 24`.
Markers already present in the original are now left alone. Run this after any
change to the sanitization pipeline. The complete sentence question now lives
in `background.js:sanitizeSentenceOutput(original, raw)`, used by both engine
attempts and exposed by the guard seam. `asciify(raw, original = "")` preserves
any of its six families present in the original, retaining the old replacement
for absent families. The six named family fixtures cover every code point in
the existing regexes (22 total), legacy replacements and cross-family isolation.
Making a family's replacement unconditional breaks its preservation pins.
The exact non-ASCII multiset guard remains unchanged: added, removed and
substituted characters still refuse, including within an original family.
Accents are outside asciify's character set; tag stripping is unchanged. The
question never repairs a delivered answer. `guard-tools-test.mjs` [4a–d] pins
callers and legacy comparisons.

`stripPromptTags` (manual path, removed 2026-09-24) was the same defect found
again in 2026-09-06 and fixed the same way. The prompt wraps text in `<context>` / `<excerpt>` and asks for
`<rewritten>`, so the model sometimes emits one and it has to come off — but the
strip ran unconditionally, so `Keep <context>customer text</context> intact.`
came back with both tags deleted, as a "correction" the model never made. The
guard is per tag family: writing `<context>` says nothing about `<excerpt>`, and
the presence test is the tag rather than the word, so prose about context buys a
hallucinated wrapper nothing.

### 12b. `package-test.mjs` — The packaging boundary (36 checks)

No Ollama, no browser, no `node_modules`. Builds a package into a temp
directory and checks that it is complete, self-describing, and free of
development assets.

```bash
node package-test.mjs          # the gate
node ../tools/package.mjs      # build dist/proofer for real
```

There is no bundler, so `Load unpacked → the repository` installs the whole
working tree, including local test outputs and any private recordings a
developer has collected. `.gitignore` is the git boundary and `0600`/`0700` is the
local-user one; neither is a packaging boundary. `tools/package.mjs`'s
`RUNTIME_FILES` is that boundary, and the only written answer to "what is the
extension".

The suite's real job is proving that list is **complete**, which cannot be
checked against the list itself. Three independent derivations, each compared
with it:

| derived from | catches |
|---|---|
| `manifest.json` references | the worker, content script, CSS, icons, popup page |
| `popup.html` `src`/`href` | **`popup.js`** — no manifest walk can see it |
| `background.js` `getURL("…")` literals | **the three data files** |

The third matters most: a missing dictionary **falls back** rather than
throwing, so omitting it installs cleanly with dictionary vetoes and checks
disabled. Some dictionary-backed permissions also disappear. Missing or invalid
confusables/names instead remove generated grants, retaining hand supplements.
The guard suite's `word-list absent: acronym veto stands down` case pins the
chosen word-list policy: `us` → `US` has exactly `protected-token` with words
loaded, then no reasons after clearing only words; `isWord("us")` is false.
The generated names and confusables remain installed for that check.
So the packaged bytes also go through the shipping `fetchConfusables` itself —
not a reimplementation of its canonicalisation, which is exactly what would let
this suite pass while production published `null` — with a truncated copy as the
control proving the check can fail.

The licence notices are the fourth class and are checked against a literal list:
nothing references them at runtime by construction, so no derivation can find
them, and their absence is a licence violation rather than a bug. Packaging
copies and hashes their bytes; the suite does not interpret their content,
provenance, licence statements, or links. Inspect the built notice separately
and resolve every accompanying-file reference inside the output.

Four separate omission mutants (`popup.js`, each data file, a notice) each
redden their own named assertion; a single mutant that reddens everything would
prove less.

**What this suite does NOT prove.** It never launches a browser, so it cannot
say the packaged extension *runs* — and it stays that way deliberately: it is
in CI's `source-only` job, which is measured with `test/node_modules` absent,
and importing Puppeteer would end that.

**Current packaged CSS smoke procedure.** On a disposable ordinary page with
the packaged extension loaded, insert an empty element with classes
`proofer-sentence-mark proofer-sentence-flash` and inline `animation: none`.
Its computed position is `fixed`, pointer events are `none`, and background
colour is `rgba(46, 160, 67, 0.28)`. Remove the probe afterward. Check computed
style; enumerating `document.styleSheets` does not reliably expose
content-script CSS. This verifies stylesheet delivery, not a typed correction.
Redo this after changing `manifest.json`, `popup.html`, or anything about how
a runtime asset is loaded.

**Historical smoke result — 2026-09-06.** The packaged artifact was smoke-tested
by hand, loading `dist/proofer` into Chrome with `--load-extension`. The FAB
below was removed with the manual path; this table is not the current procedure:

| checked | result |
| --- | --- |
| service worker starts (so `background.js` parses) | running |
| both data files fetch from the worker by `getURL` | 594,179 and 7,821 bytes — full size |
| `popup.html` loads and `popup.js` runs | HTTP 200, no page errors, settings populated from `GET_SETTINGS` |
| `styles.css` reaches the page | a `.proofer-fab` element computes to `44px`/`fixed`/`rgb(13,148,136)` |

### 12e. `popup-activation-test.mjs` — Turning Proofer on (132 checks; 125 before G3.2)

Puppeteer, no Ollama, no network. Settings v5 (2026-09-24) has ONE switch:
suggestion mode is gone, so "on" means corrections are written into the field,
and the popup's **Turn on** is the only thing that grants that.

```bash
node popup-activation-test.mjs
```

A default must never be a consent — `getSettings` merges `DEFAULT_SETTINGS`, so
flipping a default hands the permission to every install that never chose it —
so the mode ships off and every other path that could set the bit is pinned
shut:

1. The block is visible **exactly while the mode is off** (so it is also the way
   back), offers exactly one choice, and says what it does: written in, Escape,
   which sites, the local log.
2. **Turn on is ONE `SET_SENTENCE_MODE {on: true}` and no settings write** —
   not a whole-form Save, and not a `SET_SETTINGS` at all: the worker refuses a
   settings save carrying the consent (under v4 the same bit in a Save meant
   "suggest"), and the stub refuses it the same way.
3. A Turn on the worker refuses (it fails closed until the v5 migration is
   persisted) is reported, and the popup keeps showing off.
4. Turn on, Turn off and the per-site box all gate on **`isTrusted`**.
5. **Save never carries the switch** or a site toggle; Turn off is one
   `SET_SENTENCE_MODE {on: false}`.
6. With no web page in front, the per-site box is disabled and says why; the
   log switch stays usable (ported from `interaction-test.mjs` [32]).
7. The per-site box applies at once as single-origin toggles, reads a site in
   either switch-off list as off, and turning it back on clears both. **[12a]**
   refuses a disable and restores checked; **[12d]** refuses an enable and
   restores unchecked, retaining both stored memberships. Both hold the write
   and reread separately, require a disabled control throughout, preserve the
   exact worker error (generic fallback only without one), and pin the next
   trusted click's identical single-origin payload. **[12e]** commits a disable
   before losing its acknowledgement through callback-scoped `lastError`; a
   fresh settings read keeps that committed state. Its failed-read arm restores
   the last confirmed value and adds explicit uncertainty to the original error.
   Requests and settings responses are deep copies; a successful response is
   captured when handled, then released later. A later store mutation cannot
   leak into it, and refused writes leave storage untouched. Five one-line
   production mutants remove reconciliation ([12a]/[12d] restoration and retry),
   replace the worker error with generic text (exact error), remove pending
   disablement (pending state and duplicate click), skip the fresh read ([12e]
   authoritative read/committed state), and omit the failed-read uncertainty
   suffix ([12e] exact uncertain error).
8. Before this computer has passed the speed check, the one action is **Open
   setup** (Turn on hidden, the reason shown); a real click opens
   `welcome.html` and writes nothing, a synthetic one does nothing.
9. The first line names what stops Proofer working — Ollama not answering, an
   unusable status or unsupported version, the engine missing, an Ollama update,
   a failed check — and is absent when all is well. **[9b]** supplies only worker
   engine states, with no inventory metadata, and pins literal text for `ok`,
   `missing`, `mismatch`, `unknown`, the worker floor decision and adoption of
   configured-endpoint qualification/consent into activation controls. Mutants
   replace the engine state with `unknown` and disable health-state adoption.
10. Keep a log applies at once, as one `recordAll` write, on a real click only
   (Save carries only the address now, under Advanced).

G2.1 adds **[11]** (upgrading explanation, no on claim, successful retry),
**[12]** (worker refusal beats remembered activity; a pending or failed refresh
clears green), **[12b]** (false or missing frame permission cannot promote history
or report active/unsafe-range as running; canvas capability remains visible),
and **[12c]** (permitted blur retains the running label and last-field suffix).
The ordinary harness responses reuse the shipping `sentenceModeState`; these
cases inject explicit consent and page-status answers and pin literal text and
classes. Settings reads and writes carry the active tab id.

G4.1 adds **[11a–c]** for popup health messaging. **[11a]** loads qualified,
enabled settings before deferring the opening health callback; `lastError` is
set only during callback delivery and cleared in `finally`. It pins the wrapper's
`messaging:true` and error detail, no Ollama setup diagnosis, and an incomplete
Proofer engine check. **[11b]** drives the same channel failure from Test
connection, then checks that a worker-returned service failure still reports
Ollama unreachability and passes through unchanged. **[11c]** throws synchronously
from the health stub after settings load, requiring a resolved messaging result,
a visible incomplete check and no unhandled page error. No fixture supplies a
ready-made messaging result.

Four production mutants gate these paths: remove the callback failure's
`messaging:true` ([11a]'s discriminator/setup/engine assertions); remove
`renderEngine`'s messaging branch ([11a]'s engine assertion, also [11c]); remove
the Test connection messaging branch ([11b]'s status assertion); replace the
wrapper catch resolution with `throw e` ([11c]'s resolved-result, engine and
page-error assertions). Real-browser fixtures exercise the shipping popup DOM;
these limited failure cases supplement actual unpacked-popup inspection.

The worker half is `sentence-settings-test.mjs` (481 checks; 471 before G4.4):
**[F10]** rejects migration for suggestion and automatic v4 stores with valid
qualification, pins effective mode false/upgrading and untouched raw bits, then
retries to off/on respectively. **[F11]** drives settings reads and successful
writes through real handlers, pinning literal decisions for allowed, off,
unqualified, either disabled-site list and missing/closed/unreadable/non-web
tabs, then comparing with the canonical projection. The page-only sender gate
and content sender-derived origin remain pinned.

G2.1 mutants: remove the effective-mode assignment ([F10]); pass null instead of
the resolved origin ([F11]); disable upgrading text ([11]); disable worker
refusal ([12]); remove the frame-permission history check ([12b]); disable
history substitution ([12c]). Each fixture names its intended red assertions.
Observed failures: [F10] 2, [F11] 24, [11] 1, [12] 3 (its two refusal checks
plus [11]'s upgrading explanation), [12b] 4, [12c] 1. All were restored and
passed again; saved patches and commands are in the G2.1 execution manifest.
The browser check still covers focused field → qualification withdrawal →
toolbar opening, and ordinary permitted blur. G2.1 measured `chrome.tabs.get`
returning the URL after a native extension-action activation under `activeTab`
in Chrome for Testing 145 (127.0.0.2, outside the localhost host permissions).
The real popup document, with unstubbed Chrome APIs and the editing tab still
active, showed permitted history as running and qualification withdrawal as a
non-green refusal while retaining activation.

The earlier activation coverage was mutation-checked six ways, each red on its
own assertions: Turn on sent as a settings save (the pre-2026-09-25 protocol), the Turn-on write carrying a second
key, the `isTrusted` gate dropped on Turn on, Save carrying
the switch, the site box clearing only one list, and the site box's gate
dropped. That last one found a real defect while this was written: an
`isTrusted` test on the checkbox's `change` event gates nothing, because a
scripted `el.click()` makes the browser fire a TRUSTED `change` as the
checkbox's own activation behaviour. The box is gated on the click, which is
untrusted, and cancelling it undoes the toggle.

### 12d. (removed) `popup-models-test.mjs`

Retired in beta step 3b (2026-09-25) with the model dropdown it tested: the
model is pinned in `background.js` (`PINNED_MODEL`, tag and digest) and there is
no model setting. The popup's "Proofreading engine" line reads the pinned
model's state by digest; `sentence-settings-test.mjs` pins that no stored value
reaches the request.

#### Manual popup checklist

Engine-state checks can use controlled health replies; no live model is needed.

1. Open Advanced. It contains “Ollama address” and the read-only “Proofreading
   engine” line, with Save, Test connection, and Open setup.
2. Check the engine line against the health response: matching pinned digest →
   “installed”; missing pinned tag → “not installed — open setup”; different
   digest → “a different version is installed — open setup”; unavailable
   inventory → “could not check”. With Ollama unavailable, Test connection
   reports that it cannot reach the configured address.
3. Toggle OS dark mode and check popup legibility.

### 12c. `popup-views-test.mjs` — The popup's recorded-prose views (94 checks; 91 before the Slate refusal explanation)

Since 2026-09-24 it also pins the log's own line ("N of 5,000 sentences kept"),
a Clear on storage holding only records from the removed manual path (decided
by the worker's `clearable`, not by counts — a count-based decision said
"Nothing to clear." and left the text; mutation-checked), the early-eviction
notice and, since 2026-09-25, the failed-write notice beside it, and **[1e]**:
with nothing stored, Clear still sends `CLEAR_LOG` — without asking — because a
sentence in flight writes its record when its response lands and only
`CLEAR_LOG` advances the generation that drops it. The popup used to answer
"Nothing to clear." itself and let that record be written after the Clear
(checkpoint 1; mutation-checked, as is the failed-write line). And **[12]**,
the [export notice](../docs/privacy-policy.md#exporting-and-sharing-for-support): the first Export shows what the file
holds and what sending it would mean, declining saves nothing, accepting saves
a file whose last row (`{path: "notice"}`) names the notice seen, the next
Export does not ask again, and a synthetic click does nothing.

**[12a–c]** snapshots `EXPORT_LOG.records` and `counts` together at request time
and releases them after mutating the stub's source. [12a] pins three interaction
records (including a legacy row without `path`) and three diagnostic rows,
independent of the stats fixture. [12b] pins warmup-only and skip-only downloads,
the exact “No interaction records. Exported diagnostics only.” message, unchanged
diagnostic rows and the appended notice. [12c] pins “Nothing recorded yet.” with
no confirmation or Blob for all-zero counts. One-line mutants respectively
restore the popup's merged-row-minus-skips count, select the interaction message
using the merged row count, and remove the all-zero early return; the literal
mixed count, both diagnostic-only messages, and empty-message/no-download
assertions go red.

The producer half is settings **[C8a–b]**, through the real worker handler.
[C8a] seeds two sentence rows, a pathless legacy manual row, two warmups, a skip
map and an orphaned prose key: export counts are literally `{records: 3,
warmups: 2, skips: 1}`, six unchanged rows in chronological order with skips
last, while `clearable.records` is four. [C8b] pins zero interactions for
warmup-only, skip-only and empty storage and preserves diagnostic rows. Mutants
count the merged array as interactions, add warmups to interactions, or count
skip-counter values rather than rows; the corresponding literal count
assertions go red. Export metadata never adds a JSONL row.

**[13]** delivers a deferred `no-field` response with a snapshotted older
`last` report, preserving worker/frame consent. It pins the older field's label,
“(previously focused field in this frame)”, and absence of “last field you used”.
The one-line production mutant restores the old suffix and breaks both scope
assertions; changing the stub's history after dispatch cannot change the reply.

**[14]** renders normalized writes under Applied and misplaced writes under
Other, with literal two-record counts, distinct block diagnoses, and receipts
that identify misplaced output as proposed. Omitting `writtenMisplaced` from
`subRowsFor` turns the exact bucket/detail assertion red. **[16]** retains the
separate failed-Escape rejection details and receipts.

**[15]** renders `field-detached` live and under `no-field` remembered history.
It pins the exact removal explanation, frame-scoped suffix, and absence of
“Running” or a raw-code refusal. A live replacement outranks detached history;
current worker permission still outranks both. Mutant: remove the detached
switch branch by renaming its case label; both exact-copy assertions turn red.

**[16]** pins both failed-Escape details beneath rejection, six literal records
partitioned 2/3/1, explicit “kept without rejection” rate wording, operation-neutral
block copy, both receipts and unchanged legacy readings. Omitting the
`undoReconciled` sub-row turns its named detail assertion red.

Puppeteer, no Ollama, no extension side-loading, no network. Loads the real
`popup.html` and `popup.js` with a stubbed `chrome.*`.

```bash
node popup-views-test.mjs
```

The popup had no automated coverage at all, which was fine while it rendered
nothing but its own labels and numbers. `GET_RECENT_SENTENCES` changed that: it
is the only path that puts the user's own writing and a language model's output
into an extension DOM, and the project treats both as untrusted. Three gates:

1. **Prose is rendered as text.** The mutant is one line — `innerHTML = row.input`
   instead of `appendChild(createTextNode(...))` — and it turns
   `<img src=x onerror=…>` in a proofread sentence into a live element with a
   running handler. Three assertions go red on it.
2. **Clear empties both views.** `renderSentenceStats` returned early on empty
   stats without touching the breakdown, so "Applied silently 1" survived a
   Clear that had just deleted the record it counted.
3. **A reply already in flight cannot paint into a view that was cleared or
   closed.** Emptying the DOM does not cancel a request. Without a generation
   counter the deleted prose comes back, with a Copy button on it, into a view
   the user just emptied — and a response can repopulate a closed one.

The stub **defers** its `GET_RECENT_SENTENCES` replies and snapshots the rows at
**request** time, the way the worker does. Both details matter: a stub that
answers synchronously serializes the interleaving away and can never show (3),
and one that snapshots at release time forces stale rows onto the post-clear
reload as well, which the worker would never do — asserting on that is testing
the stub.

### 13. `log-to-cases.mjs` — Harvest real cases from the interaction log

(Its provenance is pinned offline by `log-to-cases-test.mjs`, 64 checks (59 before G5.4), in CI's
`source-only` job: a repeated sentence and target from two records or releases
is ONE case carrying both sources, the same sentence with another target is its
own case marked `conflict`, and every source names the contributor and the
batch — a hash of the export, never its file name — and keeps the model and
digest it was answered under. [8] also pins normalized old/new interactions,
timeout exclusion despite accepted retries, and one provenance entry per
interaction rather than per attempt; bypassing normalization loses the legacy
source.)

`log-to-cases` calls `normalizeInteraction` once per parsed browser row before
`toCase`; G1's worker-owned verdict policies still determine labels. Priors use
the same reader with explicit browser/corpus schemas and count one selected
accepted interaction pair, independently of later user verdicts. Refusals remain
in all-changed counts; accepted attempts with a terminal delivery error never
become accepted interaction pairs. The synthetic configured-source regression is:

```bash
node finetune/pilot-dataset-test.mjs  # 90 checks; [8] pins counts, rates and mixture
```

G5.4 regenerated the private configured-source priors separately: 1,789 rows,
744 changed pairs, 502 accepted pairs and 639 accepted edit groups (previously
531 and 728). All-changed groups remain 1,058. The saved pilot pool and frozen
datasets retain their historical mixture; the fresh artifact and aggregate
comparison are under `test/results/shape-drift-exec/G5.4/`.

The extension records what you typed, what came back, and what you did with it.
This is **on by default on every site** (a single `Keep a log` switch in
the popup turns it off). Export from the popup, then:

```bash
node log-to-cases.mjs ~/Downloads/proofer-log-2026-08-06.jsonl
```

Harvesting reads the worker's `sentenceOutcomeDefinition` through the VM bridge.
Only some outcomes are human labels; a silent apply is not ratification.
**[4]** pins both failed-Escape outcomes to ratified negatives with their exact
source strings, while old applied-unverified/reconciled records remain unharvested.
Changing either undo harvest target from input to skip turns its assertion red.
**[6]** proves normalized and misplaced writes, including historical skip aliases
and window tags, remain unharvested. It separately preserves the exact
`userVerdict` and replays the guard-accepted candidate as applied; the write's
fate is not an engine refusal. Giving normalization a ratified-input harvest
policy turns the zero-harvest assertion red.
Settings **[V1]** independently drives outcomes through the handler, checking
literal stats and receipts; **[V5]** checks the single documented vocabulary,
evaluated definitions, declared-family acceptance and retired-value rejection.
**[V3]** drives both post-write families through real handlers, pinning literal
partitions, details, receipt labels, normalized-only retry salvage and invalid
family rejection; later rejection/loss and pending-verdict delivery remain
controls. **[V3b]** pins historical aliases, including truncated window tails,
without rewriting storage or export. Mutants put misplacement in Applied,
bypass the family validator, or remove the alias lookup.

Settings **[V2]** sends the same reasons through `SENTENCE_SKIPS` and
`REWRITE_OUTCOME`, waits for `logQueue`, and pins counter keys, verdict suffixes,
stats and export to one 128-character reason bound, excluding the verdict
prefix. It covers Backspace, backward/forward deletion, a long precondition
reason and the literal 128/129-character boundary for both skipped and declared
post-write prefixes. Old truncated keys and
records remain unchanged and separate from complete new reasons. Restoring
the whole-verdict 64-character cap turns ten [V2] verdict/stats/export assertions
and [V3]'s exact window-tag assertion red; restoring the counter's 48-character
cap turns three counter/stats/export assertions red.

The harvesting policies are:

| Verdict | Becomes | Why |
|---|---|---|
| `user-reverted`, `sentence-undone`, `sentence-undo-reconciled`, `sentence-undo-unverified` | `expected` = the input, ratified | you put your own words back, or pressed Escape, regardless of whether the editor honored it |
| `user-edited-correction` | `expected` = your edit, **ambiguous** | a rejection, an elaboration, or writing carried on inside the sentence (the watcher says so itself), and `finalText` is a sampled state — adjudicate before using it as a target. It was labelled `gold` until 2026-09-24 |
| `sentence-applied`, `sentence-applied-unverified`, `sentence-reconciled` | skipped | no human ratification; old apply/undo ambiguity is not reconstructed |
| (legacy) `edited-after-apply` | `expected` = your edit | the manual path: the model was wrong and you fixed it — a real correction, not an invented one |
| `edited-after-no-change` | `expected` = your edit | it said "looks good" and missed an error |
| `applied` | `expected` = the rewrite | you ratified it |
| `dismissed` | `expected` = the input | false positive: this should not have changed |
| `cancelled`, errors, tone, partial | dropped | no judgement, or no single correct answer to score |

The converter dedupes, drops anything already in the core suite, flags cases
whose substitution the few-shot demonstrations already teach (via
`lib/contamination.mjs` — since 2026-09-24 against the demonstrations the
sentence path actually sends, `SENTENCE_FEW_SHOT` plus the context shot; it read
the manual path's set before, which covered none of the sentence prompt), and splits tuning/holdout on a **hash of the input**
rather than at random — so re-running on a longer export keeps every case on
the side it was first assigned. A case that drifts between the two has quietly
destroyed the holdout.

Every case carries **provenance** — `--contributor <pseudonym>` (default
`owner`), the source record id, and the record's `promptRevision` and
`modelDigest` — so a beta contributor's deletion request can reach every case
made from their file, and `v1` data is never mistaken for a later model's.
See the [contribution and deletion policy](../docs/privacy-policy.md#exporting-and-sharing-for-support).

It writes to `test/harvested/` (gitignored) and wires nothing into any suite.
That is deliberate: these are sentences you actually wrote, and every one needs
reading before it enters the repo.

### 13a. `contributions.mjs` — historical research ingestion and deletion

This optional maintainer tool records separately provided files and supports
deletion across derived artifacts. It is not an automatic collection path.
The public export notice is for support and grants no training permission.
Training use requires separate explicit permission; for a file carrying the
public support notice, `--training yes` also requires a `--training-agreement`
reference to that separately recorded permission. The notice version is
provenance, not a substitute for that agreement.

```bash
node contributions.mjs ingest support.jsonl --contributor p07 --training no --channel email
node contributions.mjs list
node contributions.mjs register <dir>      # a directory outside the tree that holds derived files
node contributions.mjs delete --contributor p07 [--batch <id>] [--dry-run]
```

Files a contribution under `test/harvested/beta/<pseudonym>/<batch>/` (0600 in
0700; the batch is the file's SHA-256 prefix, never its name) with a manifest:
who, when, which export notice they saw — read from the file's own `notice`
row, and a disagreeing `--consent` is refused — the separately recorded
training permission, if any, and how it arrived. `delete` removes the raw files
and manifests and then every case whose provenance names them, in `.json` and `.jsonl`
files at any depth, under the tree AND in every registered directory: a case
with other sources keeps those, a case with none goes. Then it CHECKS its own
work (checkpoint 3): every file of any extension in those places is searched
for provenance still naming them and for the sentences only they wrote (read
from their raw files first via `interactionProse`: input, output, finalText,
context, both legacy retry-output fields, canonical attempt outputs and retry
keep strings, less prose another contributor's raw file also holds through the
same inventory; aliases deduplicate, absent fields add nothing, and the existing
10-character minimum and raw/JSON-string forms apply), and any hit — including
a file it cannot rewrite, or a symbolic link to a place it does not walk — prints `NOT fully deleted` and exits 1. `--batch`
must be a batch id as ingest makes them, and a contributor or batch path that
is a symbolic link or resolves outside the contributor's directory is refused
(exit 2) before anything is removed. **`contributions-test.mjs`** (84 checks; 35 before G5.4,
offline, CI's `source-only` job) demonstrates deletion on
synthetic contributors: a sentence two wrote merged into one case with both
sources, copies as a `.json` dataset, a `.jsonl` one, an analysis artifact, one
nested two keys deep and one in a registered directory outside the tree;
deleting p07 leaves p08's case with p08's source alone everywhere and p07's
own sentence nowhere; a dry run changes nothing and names what it could not
rewrite; a `.txt` note or malformed `.jsonl` still holding a contributor's
sentence fails the run by name, a note holding only a shared sentence does
not; an unregistered symbolic link fails it; and `--batch ../p08`, a batch or
contributor symlink and a bare `--batch` are refused with p08 intact.
[7a–e] each leave only one nested prose field in raw and JSON-escaped notes;
both dry and real deletion must name the residuals and exit 1. [7f] subtracts
text shared only through another contributor's nested field. Each new path has
a removal mutant; [7f] restricts shared subtraction to flat fields. Each earlier
check was mutation-checked (no recursion, `.jsonl` skipped, registered
directories not walked, no residual check, no batch validation, links
followed or ignored, a dry run that writes, a world-readable raw file). Known
limit: the owner's own corpus is not subtracted from the residual check, so a
contributor sentence the owner also wrote is reported, in the safe direction.

### 13b. `log-latency.mjs` — What the log says about latency

```bash
PROOFER_SKIP_DIGEST_CHECK=1 node log-latency.mjs <export.jsonl>
PROOFER_SKIP_DIGEST_CHECK=1 node log-latency.mjs log.jsonl --reload-ms 500
node log-latency-test.mjs
```

The analyzer reads `normalizeInteraction` and `latencyAttempts` from
`lib/log-record.mjs`. Interactions and dispatched inference attempts are
separate collections: interaction wall time measures arrival to response once,
while attempt walls measure dispatch through body consumption or transport
failure. V2 reads canonical `attempts` exclusively; v1 expands retry fields
once. Repeated IDs remain separate source rows. Warmups, skips and notice rows
are not interactions or inference attempts.

Path and backend summaries describe timed interactions, including unsent
errors. A separate attempt view reports available request walls and token
counters (including retries); missing counters remain unavailable. Backend
`{kind, numThread}` is recorded when known and otherwise shown as `unrecorded`.
Reload load counters sum over attempts; their percentage denominator sums
interaction walls once, labelled **of recorded interaction wall time**. It is
not time spent entirely in Ollama: consent, preflight and guarding are part of
that interaction wait. Coverage counts expose missing measurements.

Reload attribution compares an ordinary interaction's arrival to the preceding
dispatched attempt's completion; a retry uses its own dispatch as the current
endpoint. Measured dispatch timestamps determine request ordering, never
`ts + 1`. Export `ts` remains write time. Unsent interactions and legacy rows
with unknown dispatch do not become requests or predecessors. A dispatched
failure counts as a request but does not prove a lease was armed.

Model, context and thread count key the worker's runner state. This analyzer
currently distinguishes model and context changes, not a thread-switch cause.
The six existing cause names are hypotheses about request gaps, not proof of
residency or of the absence of a typing warmup:

| Cause | Means | Follow-up |
|---|---|---|
| `model-switch` | the preceding request used a different model | inspect competing model use |
| `ctx-switch` | the preceding request used a different `num_ctx` | inspect context changes and the warmup's wrong-context branch |
| `short-tail` | the gap exceeds the preceding requested lease but not 90 seconds | inspect whether typing warmups hid the short sentence tail |
| `idle-expiry` | the gap exceeds the historical 90-second lease | inspect idle gaps |
| `unexplained` | no preceding model/context change or recorded lease boundary explains the reload | external eviction, thread changes and restarts remain possible |
| `log-start` | no earlier dispatched attempt is retained | expected, not actionable |

`insufficient-evidence` is a coverage result, not a seventh cause. It is emitted
when missing endpoints/lease, legacy retry ordering or overlapping requests
cannot establish attribution. Legacy ordinary arrivals use `startedAt`, labelled
`legacy-startedAt`; absent arrival uses `ts`, labelled `write-time-proxy`.
Legacy ordinary completion uses `startedAt + timings.wallMs`, labelled
`legacy-wall-proxy`, otherwise `ts` (`write-time-proxy`). V2 endpoints are
`measured`, with retry arrival labelled `measured-dispatch`. Legacy retry
endpoints/order remain `unknown`; first-attempt duration stays unknown, never
interaction wall minus retry wall. Attempt wall and counter coverage is printed
as recorded/unknown counts. Dispatch coverage separates explicit unsent from
`unknown-dispatch` interactions; prepared options and interaction wall alone
prove neither dispatch nor a lease.

Leases are labelled `recorded`, `legacy-manual-90s`, or `unknown`. Only an
identifiable legacy `manual` row gets the analyzer's historical
`MANUAL_KEEP_ALIVE_MS = 90000` fallback. A missing sentence lease stays unknown.
`SENTENCE_KEEP_ALIVE` (currently `20s`) and `SENTENCE_NUM_CTX` are read from the
shipping worker through `lib/sentence-guards.mjs`. The removed manual path's
lease description is `1.5m`; it is history, not current runtime configuration.

Warmup observations remain separate: retained in-flight IDs, dispatch and
completion are compared to sentence arrival, including records that have only
legacy `startedAt`. Missing arrival is `arrival-unrecorded`. No retained warmup
telemetry cannot establish that no ping fired; retention, recording gaps and
worker restarts limit the evidence.

`log-latency-test.mjs` has **32 checks**, Node only: [1] pins the v1/v2 33.3%
denominator, cardinality and counters; [2a–b] pin 18.5s/89s arrival boundaries
and retry dispatch; [2c] pins labelled legacy fallbacks, unknown lease and
overlap; [3] pins unsent/unknown dispatch and failure accounting; [4] pins all
six causes against this table, backend groups, leases and warmup correlation.
Each names its production mutant. The CLI children set
`PROOFER_SKIP_DIGEST_CHECK=1` before importing the harness, so digest admission
makes no request. The suite is in CI's `source-only` job and was proven without
`test/node_modules` in an isolated source copy under
`unshare -rn sh -c 'ip link set lo up && node log-latency-test.mjs'`, with no
exit-77 skip.

### 14. `sentence-owner-bench.mjs` — Owner-rubric benchmark + the damage gate

Builds the shipping sentence request over a corpus of **real** sentences with
**real** prior context and scores against the owner's rubric rather than exact
match. Live scoring and `--replay ... --reguard` both call the shared
`sanitizeSentenceOutput` question and guards before no-op detection, retaining
raw output. The bench measures individual answers; it does not run the engine's
retry. Reguard rejudges fixed outputs without requesting new model answers:

```bash
node sentence-owner-bench.mjs --corpus random-holdout.json --tag base
node sentence-owner-bench.mjs --corpus error-holdout.json --tag cand \
     --baseline baseline-error-holdout.json      # exits 1 on NEW meaning damage
node sentence-owner-bench.mjs --corpus dev-corpus.json --replay run.jsonl --review
```

| Bucket | Meaning |
|---|---|
| `fixed-safe-applied` | a labelled error was corrected, applied, and nothing else moved — **raise this** |
| `fixed-with-collateral` | corrected, applied, and something else moved too |
| `fixed-refused` | the model got it right and a guard stopped it |
| `wrong-output` | a different edit; **counted as damage if it was applied** |
| `meaning-damage-applied` | a clean sentence had its meaning changed — **hold this** |
| `welcome-style-applied` | comma, capital, hyphen, possessive. Not harm under this rubric |
| `meddling` | % of clean sentences touched at all — the old exact-clean number, **a diagnostic, never a gate** |

The gate is `--baseline`: **zero NEW meaning damage**, compared as a set of
uids. A count would let a change damage one sentence, repair another, and read
as even.

Corpora live in `test/harvested/` (gitignored, owner's Discord data) and are
resolved against `$PROOFER_CORPUS_DIR`; this runner holds none of them. Labels
are keyed by `<message_id>:<sha1(sentence)>`, **not row index** — an index label
does not fail when the segmenter changes, it slides onto the neighbouring
sentence and keeps scoring, green and wrong. These private holdouts and their
baselines are not distributed; use the checked-in suites for public regression
checks, or supply a separately authorized corpus with compatible labels.

G6.4 rejudged the `bench-*-holdout-q4v1-0906.jsonl` recordings against
before-change measurement baselines: both damage gates have zero new damage
(random 4 existing damage uids, error 5). Corrected measurement changes one
random-holdout no-op to refused, and four no-ops plus two applies to refused
in the error holdout.
The runtime question, full reasons and outcomes themselves are identical
before/after on those 882 outputs and 5,133 replayable owner-export attempts.
Reports stay under `results/shape-drift-exec/G6.4/`.

### 15. `sentence-window-test.mjs` — Would a multi-sentence window beat one at a time?

Sentence mode sends **one** finished sentence and supplies the text before it as
read-only `prior_context`. The alternative is a sliding, overlapping window:
when sentence *n* is finished, send *n-K+1 .. n* as editable text, so every
sentence is visited K times — once as the newest, K-1 more as an older member of
a later window.

That cannot be measured one request at a time, for two reasons. The window's
earlier members are the **already-corrected** text, not what the user typed; and
the whole claimed benefit is a second bite — an error the first pass missed
being caught when a later window revisits it — which is invisible to any harness
that scores a single request. So this one **simulates typing a whole message**:
it reconstructs each multi-sentence message from the corpus, types it one
sentence at a time, applies what the guards allow, and scores the **final** text
against the owner rubric. `--k 1` is the shipping path, measured in the same
loop as its own control.

```bash
node sentence-window-test.mjs --corpus error-holdout.json --k 1 --tag k1
node sentence-window-test.mjs --corpus error-holdout.json --k 3 --adapt --tag k3a
node sentence-window-test.mjs --corpus error-holdout.json --k 2 --adapt --inject last --tag L2a
node sentence-window-compare.mjs k1 k2a k3a k4a       # pool the corpora, one table
node sentence-window-diff.mjs k1 k2a                  # which sentences actually differ
node sentence-window-strata.mjs k1 k2a                # by sentence length and position
node sentence-window-latency.mjs --n 40               # serial, warm, per K
```

| Flag | What it isolates |
|---|---|
| `--k <n>` | window size. 1 is production |
| `--adapt` | rewrites the one system-prompt line that says "the **sentence** the user sends". Leaving it while sending four sentences makes any K>1 result unreadable |
| `--apply newest` | the window is material the model may **read** and rewrite, but only the newest sentence is written back — the churn-free variant |
| `--guard win` | one verdict for the whole window instead of one per sentence |
| `--inject first\|last` | damage one word of one sentence per message, with the generator `sentence-multi-typo-test.mjs` uses. 58 hand-labelled errors cannot resolve a 2-case difference; this gives ~175 with the **position** under control |

The two injection modes are the experiment's whole decomposition. At step 0 the
window is a single sentence whatever K is, so `--inject first` measures **only**
the second bite; the last sentence of a message is never revisited, so
`--inject last` measures **only** the richer editable neighbourhood.

Three things it counts that the owner bench cannot: `older`, edits landing on a
sentence the user had already finished and watched flash (split into
second-bite fixes, style, and meaning damage); `re2x`, sentences edited in more
than one window; and `merged-output`, the window's own failure mode, where the
model returns fewer sentences than it was given.

Two reconstruction details, both of which produced silently wrong results first:
the separator between two sentences is recovered from the **next row's context
tail**, never from `start - (prevStart + prevLength)` — the stored `sentence` is
trimmed while `start` still points at the segment, so the arithmetic is off by
one per blank line and drops the longest messages entirely. And an injected typo
only goes into a sentence every word of which is in `data/words-en.txt`, or a
model that correctly fixes a typo the corpus already contained is scored as
collateral damage.

### 16. `build-confusables.mjs` — the confusables artifact

`data/confusables-en.txt` is **generated**. Edit the filter, never the file.

```bash
node build-confusables.mjs            # rebuild the artifact and patch background.js's constants
node build-confusables.mjs --check    # exit 1 on drift in the artifact OR in either constant
node build-confusables.mjs --report   # the filter and everything it rejected, with counts
node build-confusables.mjs --fetch    # re-pin upstream to fresh commit SHAs
```

Inputs are vendored under `test/data/` and pinned by commit SHA, with
`SOURCES.json` recording each repo, commit, path, URL and the SHA-256 of every
fetched byte: LanguageTool's `confusion_sets.txt` (LGPL-2.1+) and a CMUdict
subset (BSD-2-clause). Nothing is fetched from a moving ref, and that paid off
immediately — LanguageTool's `master` moved between two `--fetch` runs while the
recorded content hash and the emitted artifact stayed identical, which is the
difference between "upstream moved" and "the data changed".

`sentence-guard-test.mjs` imports the builder and **rebuilds in process**, then
asserts the checked-in artifact and both `background.js` constants match. A
changed builder with a stale artifact used to leave every test green.

Two flags exercise the parts that would otherwise be untested:

- `PROOFER_NO_CONFUSABLES=1 node sentence-guard-test.mjs` must **fail** — 139
  passed, 5 false rejects, exit 1. If the control passes, the suite is not
  testing the allowlist. (An earlier draft restored the good list
  unconditionally and the control passed 143/143, proving nothing.)
- The loader's six fail-closed cases drive the **shipping** `fetchConfusables()`
  with a substituted `fetch`, not a re-implementation: 404-with-valid-body,
  200-with-poisoned-body-of-the-right-length, one line appended, one pair swapped,
  right length in the wrong format, and a throwing fetch — plus the end-to-end
  consequence, that `salt → slat` is still refused under a poisoned load.

`sentence-e2e-test.mjs` is part of this workflow, not an optional extra: the
digest check needs `crypto.subtle` in a **real** service worker.

`sentence-e2e-test.mjs` talks to whatever owns `127.0.0.1:11434`, so a
different runtime or a CPU-only engine is tested by starting it inside a
separate network namespace, where it owns that port and the live service is
untouched. Namespace setup is a local testing prerequisite, not a bundled tool. On 8 CPU cores the speed check
takes ~2.5 min; the suite waits 240 s for it, with Puppeteer's protocol timeout
at 300 s — at 120 s it cut every CPU wait short and reported `timeout`.

### 17. `sentence-slate-test.mjs` — both real Slate builds (223 checks)

See "Exit codes" above for the mode split and "Capturing and verifying fixtures"
for the capture tooling. The preserved accepting capture keeps every existing
assertion. Its coverage, in one line each: the correction
lands in the DOM and **survives the next keystrokes** at the right offset; the
`execCommand` recipe puts the right characters in the DOM and Slate reverts them
on the next keystroke (case `[2]` — this is the assertion a Slate-shaped fixture
cannot fail, so it passing *offline* is the proof the capture is real); a
keystroke mid-write no longer costs the correction and is still there in order;
the write emits no native `input`, so the correction cannot skip the next scan as
`bulk:insertReplacementText`; a hostile editor pins `misplaced`, `normalized` and
`ignored` against a control arm that obeys; and `splice-in-flight` refuses the
second of two splices started in one tick.

Two cases state contracts that the rest of the suite structurally cannot reach,
and both are worth knowing about before editing the write:

- **`[13b]` — apply outcomes and which failure withdraws the FAMILY.** `[10]`
  pins the reasons; [13b] extends [13] through `applySentenceWrite` with exact
  DOM and outcome assertions for normalize, append, ignore and obey. Misplacement
  reports `sentence-written:splice-failed:misplaced` and blocks with
  `wrote-elsewhere` (demotes Slate); normalization reports
  `sentence-written:splice-failed:normalized` and blocks with `write-normalized`
  (this element only). Ignored writes remain skips, obeyed writes remain applied,
  failed applies arm no Escape slot and mutations are not rolled back. The instrument is `sentenceFieldStatus`
  on a **fresh sibling that was never written to**, because `sentenceBlockedEls`
  is element-keyed and an element-keyed block is exactly what a React remount
  clears — a sibling is the only observation that separates the two. Controls in
  both directions: the `normalize` arm's sibling must come back `ok`, and an
  obeying editor must block nothing. Mutant: normalized apply prefix back to
  `sentence-skipped:`; the exact normalized outcome turns red.
- **`[13c]` — real Escape shares those consequences.** Each arm first honors
  an apply and proves the correction is anchored, then receives a trusted Escape
  and normalizes, appends, ignores or honors its restoration. Exact DOM and
  apply/undo sequences, distinct causes, fresh-sibling eligibility and success
  announcements are pinned. Mutant: force the undo block to `write-rejected`;
  misplacement's cause and family withdrawal turn red. Typing **[10f]** pins
  `write-normalized` status/first-cause readback and fresh-element eligibility
  (mutant: add it to `DEMOTING_BLOCKS`). Typing **[13e]** drives normalization
  and misplacement through a registered MUTATION editor, pinning DOM, records,
  scope and no rollback/undo slot (mutant: misplaced apply prefix back to skipped).
- **`[14]` — the `isTrusted` gate on the verification waiver.** `userEdited` is
  `(yielded || replayed) && sawTrusted`, and it *ends* verification. Every
  swallowed keystroke in every other case here and in `sentence-typing-test.mjs`
  is a real CDP key, so `sawTrusted` is true throughout and the gate never
  decides anything — deleting `if (e.isTrusted)` passes green everywhere else.
  The arms differ in one property: `page.keyboard.type("z")` against a
  page-dispatched `KeyboardEvent`, same key, same 10 ms. The control is that
  `window.replayed === "z"` in **both**, so a `false` cannot be read as "the
  synthetic event never arrived". A second pair drives `applySentenceWrite`
  against an editor that honours the span and then discards the write on the
  replay: the synthetic arm must catch it (`session-blocked` / `reconciled`) and
  the trusted arm must waive it — **and the record must say which**, so the
  waived arm asserts `["sentence-applied-unverified"]` and the judged one
  `["sentence-reconciled"]`. That is the only place a waiver is observable end
  to end: it is the one path that reports an apply it did not check, and
  reporting it as a plain `sentence-applied` would make it indistinguishable
  from a verified one in the log built to decide whether silent writing is safe.

**[16b]** drives the undo caller after a real apply on a hostile INTENT editor.
It proves the original was restored, one trusted key was captured and replayed,
and the replay changed that field before asserting exactly
`[sentence-applied, sentence-undo-unverified]` and no successful-undo announcement.
Its mutant restores the old `sentence-applied-unverified` undo report. Existing
[16] uses the new undo vocabulary while retaining its captured-Slate happy path.
Typing **[2d]** is the textarea counterpart: real apply and Escape, a page input
handler retains the correction, and the exact sequence ends in
`sentence-undo-reconciled`. Restoring its old report literal turns that assertion red.

**[17]** drives the real captured Slate model through a quiet correction, then
types one digit inside the corrected sentence after the measured 650 ms verifier
close and stops. It measures one trusted `beforeinput` and zero `input` events,
the exact changed text, `[sentence-applied, user-edited-correction]`, the literal
settled `finalText`, one feedback report and no block. Mutant: notify
`noteSentenceEditWatch` only when `via === "input"`; the exact sequence,
final-text and single-report assertions turn red.

**[18]** removes a focused, allowed Slate host synchronously after honoring the
caller's INTENT, before the first settle sample. It pins the anchored dispatch,
detached DOM, unchanged `sentence-skipped:splice-refused:detached` verdict,
`field-detached` live/message status, cleared-focus reply priority, remembered
diagnosis after blur, and a later eligible attachment. Controls attach a
replacement or withdraw consent during the await; their active/off states must
survive cleanup. Mutant: route detached back to `unsafe-range`; the lifecycle,
remembered status, replacement and off-state assertions turn red.

**[19] / [20]** drive the new real capture at idle and during trusted typing.
They assert exact `failed-transport` / `untrusted-rejected`, an observed
uncancelled range-bearing replacement, original DOM caret in the **dispatch
call's own task**, all five capture listeners removed in that task, no replay,
every typed character present in order, and caret at the typing position. [20]
requires its first key within the former 30 ms settle window. Both then drive
`applySentenceWrite`: exact skip record and counter, `write-rejected` on this
field, eligible fresh Slate sibling, no written outcome and no Escape slot.
**[21]** pins backward anchor/focus endpoints and the next key replacing only the
user's selected tail; it also preserves an empty selection. **[22]** first makes
a real apply on the old capture, then installs the new handler's early refusal
behavior for Escape: the same exact text/caret protection, no replay, precise
undo counter, existing failed-undo verdict and non-demoting block. A stock new
build cannot naturally create an undo slot; [19/20] assert that limitation.

Each fixture names its one-line mutant. Seven patches and their replay commands
are in `results/slate-fix/mutants/manifest.tsv`; removing the cancellation check
**must fail [20]'s every-character/in-order assertion**. The other mutants remove
selection restore, leave an originally empty selection holding the recipe range,
misname the reason, demote the family, retain guard listeners, and remove popup
explanation ([17], stats and breakdown). All are applied to
production, run red, restored, and saved as patches applying to the final tree.
The focused `--untrusted-only` mode runs [19–22] for replay; it is not the full
gate. Existing hostile [6]/[10] now explicitly cancel without writing so their
unchanged `ignored` and replay assertions still reach that accepted-but-ignored
path. Actual old-capture scenarios are unchanged. Typing [11], a bare Slate-shaped
DOM with no handler, now requires exact `untrusted-rejected` and a null window
in place of the former delayed `ignored` reason; its text assertion stays intact.

Historical development included a source audit of the cancellation premise
across 373 stable releases. Its detailed source tables, excerpts and tarball
hashes are excluded from the public snapshot. The checked-in
[Slate suite](sentence-slate-test.mjs) reruns the two preserved builds, including
acceptance and safe refusal; it does not reproduce that full source audit.
The shipping check uses observed cancellation, not version numbers.

Typing **[5g3]** follows an accounted in-span edit with an eventless page change
before feedback settles: the page's text stays visible but is not reported as
user feedback. Mutant: remove the live-text/receipt equality check; the exact
apply-only sequence turns red. **[5g4]** changes the span and dispatches synthetic
input without a trusted observer receipt; it produces no feedback. Mutant:
restore an independent `input` subscription to the watcher; its apply-only
sequence turns red. Existing [5g2] exact-revert, third-text and moved-prefix
controls remain unchanged.

Both [13] and [14] were confirmed by mutation rather than by argument — four one-line changes
to `content.js`, run through `PROOFER_CONTENT`, each turning only its own
assertions red, and nothing else.

```bash
node sentence-slate-test.mjs                        # offline, BOTH captures; 223 checks
PROOFER_SLATE_LIVE=1 node sentence-slate-test.mjs   # canary; 32 checks on current rejecting site
PROOFER_CONTENT=/tmp/candidate.js node sentence-slate-test.mjs
PROOFER_SEED=1608963965 node sentence-slate-test.mjs
```

### 18. `slate-intent-probe.mjs` — the INTENT recipe, experiment not gate

Real slatejs.org, exits **77** if unreachable, **2** on a bad argument (an
unknown phase, arm or variant, or a non-numeric trial count — each of those used
to run zero trials and exit 0). Phases: 1 does a synthetic event carry its
`targetRanges`, 2 the transport variants, 3 the shipping function under its own
guards, 4 a selection move colliding with the write, 5 unreplayable keys in the
window, 6 the dirty branch. `PROOFER_TRIALS`, `PROOFER_ARMS`, `PROOFER_VARIANTS`,
`PROOFER_OFFSETS`, `PROOFER_CONTENT`, `PROOFER_RESULT_JSON`; artifacts land in
`test/results/` stamped with the bytes they describe.

It is the only place several hazards are reachable at all — the dirty branch, and
a ±1 caret delta where the user's own offset coincides with the correction end —
because an end-to-end run repairs the caret before the replay fires. The method
rule the probe carries in its header is the one that produced most of its
findings: **a phase that has never been run is not a phase that passed.** Phases 2
and 3 collide the write with typing and reported the recipe clean at 32/32;
phase 4 collides it with a selection move and phase 5 with a Backspace, and both
found real corruption, one of it predating the work.

### 19. `editor-recipe-probe.mjs` — the editor characterization bench

Run this **before** adding an `SN_TRANSPORTS` row. Candidate × {intent,
mutation-checked, mutation-reimpose, **none**} × {idle, burst}, 8 trials each,
keystrokes jittered 22–129 ms, scored APPLIED / REFUSED / DAMAGED plus a
`DELETED` column counting characters of the user's own typing that are missing.

```bash
node editor-recipe-probe.mjs                       # the four default candidates
PROOFER_CANDIDATES=Draft node editor-recipe-probe.mjs
PROOFER_CANDIDATES=Quill,Lexical node editor-recipe-probe.mjs   # a certified row, re-characterised
PROOFER_ARMS=intent node editor-recipe-probe.mjs
PROOFER_SEED=1234 node editor-recipe-probe.mjs     # replay a run's typing rhythm
node editor-recipe-probe.mjs --nesting-only        # offline; no network needed

# An editor this repo has never heard of — no code change:
PROOFER_CANDIDATE_URL=https://codemirror.net/ \
PROOFER_CANDIDATE_SELECTOR=.cm-content \
PROOFER_CANDIDATE_NAME=CodeMirror6 node editor-recipe-probe.mjs
```

**Give it a URL and a selector and it produces the matrix.** The engine
("run both recipes in both phases, score three outcomes") is general; the setup
is not, and every field of it was bought by a wrong number — `minClickY: 260`
exists because one docs site has a sticky header, `focusVia: "el"` because a real
click at Trix's own coordinates leaves `activeElement` on `BODY` and every cell
then reads as a dead write. Those live in **`lib/editor-targets.mjs`**, one
descriptor per editor, with `PROOFER_CANDIDATE_URL` / `_SELECTOR` (plus optional
`_NAME`, `_FOCUS`, `_MIN_CLICK_Y`, `_CLEAR_PASSES`, `_READY_MS`) synthesising one
ad-hoc row. Half a request is an error: a URL with no selector exits 2 rather
than guessing an element, because a guessed selector attributes the whole matrix
to whatever it happened to find. `PROOFER_CANDIDATES` keeps its old meaning
exactly — a filter, and matching nothing is exit 2 — and now reaches all eight
descriptors plus the ad-hoc row; naming nothing runs the four the recorded matrix
in the probe's header was taken against.

The descriptors are a **second** copy of what `sentence-editors-test.mjs` keeps
in its own `TARGETS`, and that suite is deliberately left alone — it is a gate,
and changing what a gate iterates to prove a refactor is how it stops being one.
So the duplication is *checked* rather than argued away: `crossCheckEditorsSuite()`
reads that file's literal, compares the identity fields (`url`, `selector`,
`family`, `recipe`, `focusVia`) for every row present in both, and the probe
exits 2 on drift or on a cross-check that could not run at all
(`PROOFER_ALLOW_TARGET_DRIFT=1` to measure anyway).

**Neither the descriptors nor the cross-check are on the `--nesting-only` path**,
and that is an assertion (`editor-bench-selfcheck.mjs` [B2]) rather than a
comment. That path answers one question — does an unmeasured editor inherit a
certified adapter — and must not be able to fail for a reason it does not depend
on: a target descriptor disagreeing with another file's table would report that
answer as wrong when it was never asked. Secondarily, that path runs in CI with
the network denied, so keeping targets off it makes "the nesting matrix touches
no demo site" true of the **text** as well as of the run — settleable by reading,
without executing anything.

The property is measured rather than argued, and the **control** is the half that
matters: under `unshare -rn` with only `lo` up, `--nesting-only` is 24/24 exit 0
while a full run against slatejs.org **in the same namespace** is exit 77 naming
`ERR_INTERNET_DISCONNECTED` — without that arm, a suite that had quietly stopped
measuring would read identically. A target-selecting variable on that path is
inert **and says so**. Tuning values — `clearPasses`,
`readyMs` — are not compared: both loop until the field reads empty, and a red
for a difference with no consequence is a red nobody will keep.

Five things it does that a simpler harness would not:

- **The `none` arm fires no write at all.** It is what makes the burst column
  mean anything — 24/24 intact across every candidate, so "the recipe ate a
  keystroke" and "the demo site drops keystrokes under load" are separable.
- **`--nesting-only` is the editable-island matrix**, and needs no network: for
  each certified family, an unregistered editor inside a `contenteditable="false"`
  node view must resolve to **no adapter at all**, checked at both doors
  (`editorAdapterFor` picks the recipe, `sentenceFieldStatus` decides eligibility
  and names the family to the popup — checking one lets the other drift). Three
  controls per family stop the fix being "deny everything". 18/24 before the
  boundary fix, 24/24 after, demonstrated in one run via `PROOFER_CONTENT`.
- **`DELETED` self-checks before Chrome launches** — nine cases, exit 2 on
  failure. It has been wrong twice in opposite directions: a length difference
  invented data loss on CKEditor (a reverted correction is one character shorter
  than the fixed sentence), and a plain multiset **hid** one, because the letter
  the correction added could pay for a letter the editor deleted elsewhere. It is
  now an excluded-region deficit, and the auditor's counterexample is one of the
  nine.
- **Nothing exits 0 having measured nothing, and the exit says WHOSE CLAIM
  FAILED.** That one rule replaces a set of special cases that had drifted into
  contradicting the repo's own contract, and in which an exit code could change
  with *how many* editors you happened to ask for:

  | What happened | Exit | Why |
  |---|---|---|
  | A nesting check failed | **1** | The shipping registry lookup is wrong. Checked **first**, unconditionally — it needs no live editor, so nothing in the run below can excuse it |
  | A page **loaded** and the probe could not focus/click/clear/inject | **1** built-in, **2** ad-hoc | Not an outage. A broken click calculation, a stale descriptor or a probe bug |
  | A page **loaded** and the selector matched nothing | **1** built-in, **2** ad-hoc | The repo's standing contract: reachable-but-wrong is a failure, not a skip. Ad-hoc is **2** because nothing in the repo asserted that selector |
  | Every row unreachable | **77** | An outage. Nobody's claim failed |
  | A VOID trial, or a phase that never ran | **77** | The editor did something the trial did not expect *on a page that loaded and focused* — usually demo-site flakiness. `PROOFER_ALLOW_VOID=1` accepts it |
  | The artifact could not be written | **2** (1 stands) | The measurement happened and cannot be checked |
  | Bad `PROOFER_TRIALS`, filter, arm, URL or descriptor | **2** | Before Chrome launches |
  | An empty registry in the file under test | **2** | Zero checks would print 0/0 and exit 0 |

  Two of those were wrong before the audit that found them. `!table.length` was
  tested **before** `nestingFailed`, so a genuine nesting failure could exit as
  "no cells" whenever the live rows also produced none — the safety property
  hidden behind a cardinality accident. And a focus or setup failure exited 77,
  so a probe regression reported itself as *the site is down* and a batch runner
  skipped past it.

- **The artifact is written atomically and its loss fails the run.** The
  destination is claimed before Chrome launches with a placeholder reading
  `status: "in-progress"`, so an artifact from a killed run cannot be read as a
  finished one; an unwritable destination exits 2 up front; and the final write
  goes to `<dest>.tmp` and is renamed, so a write that dies halfway cannot leave
  a truncated JSON where a complete one is expected. A failed final write is
  **nonzero** — it used to be caught, logged, and exited 0, which is this file's
  own "completes green and produces nothing" with the production step moved to
  the very end.
- **The artifact is self-describing, and no truncation is silent.** `probe`
  and `targetsLib` hashes as well as `content` path + hash + snapshot, the Chrome
  version, the seed and jitter band, the full resolved descriptor for every row
  (`focusVia` is the setup; "Trix" is not), the final URL after redirects, the
  cross-check result, and **every trial** with its verdict, reason, page errors
  and final text. The console prints a per-phase budget worst-first and says how
  many it dropped; a final text longer than 90 characters is cut with `…` and a
  count, never clipped bare (a final clipped without a mark reads as the whole
  field, and "the correction is missing from the end" is exactly what hides in a
  silent clip). The JSON keeps all of it. Provenance hashes are taken **at
  startup**, not at completion — editing the probe while it measures, which is
  how the paired runs in its header were produced, used to stamp the artifact
  with bytes that never executed — and a source file that cannot be read is
  fatal rather than a `null` field, because an artifact with `sha256: null` still
  looks like an artifact. The `sha256` fields hold the **full** digest; the
  banner prints the first 16 characters, which is what the field used to store
  under that name.

**Four runs are retained in `results/`** — `test/results/*` is gitignored with
per-file negations, the same mechanism `repeat-study.tsv` uses — so the claims
made for this bench are checkable rather than quoted:

| File | What it is |
|---|---|
| `editor-bench-paired-parent.json` | The **pre-refactor** probe, Slate + Draft, 3 trials — the baseline, and the one file here that cannot be regenerated once that version is gone from the tree |
| `editor-bench-paired-refactor.json` | The same command on the refactored probe, run in the same session against the same sites — the controlled arm |
| `editor-bench-paired-postaudit.json` | The same command again after the audit fixes, showing the final code still reproduces |
| `editor-bench-adhoc-codemirror.json` | The ad-hoc path, `PROOFER_CANDIDATE_URL`/`_SELECTOR` only: CodeMirror 6 ignores INTENT and loses a typed character 3/3 mid-burst, takes MUTATION 3/3 in both phases under both caret policies |

Every A/R/D cell agrees across all three paired runs. What moves between them is
inside **Draft's intent burst cell only** — 0/2/1 with 2 characters deleted,
0/2/1 with 1, and 0/1/2 with 3 — which is the refused-versus-damaged split of a
cell that never applies, at a different jitter phase each time. That is the
phenomenon the jitter exists to sample, and reading those three as a regression
is the mistake a fixed cadence would have hidden in the other direction.

The parent artifact is the older schema (no `schema` field) and both earlier
paired files carry 16-character `content.sha256` values, because they were taken
before the full-digest fix — which is exactly the kind of thing a retained
artifact is for.

The INTENT column is **versioned by `spliceSentenceSlate`** and must be retaken
when that function changes; the banner and the result JSON carry the resolved
content path, its hash, and a recipe stamp. The MUTATION column does not depend
on it. There is deliberately **no baseline or gating mode**: the splice this
file characterises is under active change, so a matrix recorded today would be a
stale expectation by the time anything compared against it. A scheduled canary is
a follow-up, and it needs the INTENT column to hold still first.

### 19a. `editor-bench-selfcheck.mjs` — does the bench fail loudly? (49 checks)

Offline, ~90 s, no demo site. It breaks the bench on purpose and requires each
break to produce the **right exit code** *and* to name the problem in its output.
Both halves matter: an exit 2 nobody can read sends the next person to the wrong
file, and a good message behind an exit 0 will not be read at all.

Configuration mutants: `PROOFER_TRIALS=0` and `=abc`, a filter matching nothing,
an unknown arm, a URL without a selector and a selector without a URL, a URL that
is not a URL, a bad focus strategy, an unwritable `PROOFER_RESULT_JSON`. Runtime
mutants: a selector that matches nothing, a row that is unreachable (port 1 on
loopback — refuses instantly, needs no network, and is the offline stand-in for
every demo site being down, the case that must be **77** rather than 2), an
element that cannot be focused, and a **failed final artifact write** (a
directory pre-created at `<dest>.tmp`, which is fault injection from outside with
no test-only code path). Descriptor and cross-check mutants: an empty selector, a
mistyped field name, an arm typo, four not-quite-URLs, a changed URL in the other
table, a deleted row in the other table, a `TARGETS.push` after the literal, and
a changed *comment* that must **not** be drift.

Three sections carry the load:

- **[B2]** a target filter that is fatal on the full path must be *inert* under
  `--nesting-only`, say so, and leave zero targets and a null cross-check in the
  artifact — the assertion that fails if target resolution drifts back above that
  early exit.
- **[C1]** a nesting failure (injected via `PROOFER_CONTENT` with the
  `unknown-editor` status renamed) must exit **1**, *and still exit 1* when a
  cardinality failure would otherwise claim the exit. That is the ordering bug
  itself, pinned.
- **[C2]** a run that **works**, inspected. Every other case breaks something, so
  deleting `table[].trials` or most of the full-mode schema left the whole file
  green — a harness that only tests its own failure paths cannot notice its
  output becoming useless. A plain `contenteditable` in `test-page.html` over
  `file://`, driven by the mutation recipe, is a real cell (clear, type, splice,
  type again, score) with no network, and its artifact is checked for both trials
  with phase, verdict, timing and final text, and for no leftover `.tmp`.

**Two arms are not covered offline and are stated rather than faked**: the
built-in-row versions of "loaded without its selector" and "failed to set up"
exit **1** rather than 2, and reaching them needs a reachable demo site, so they
are exercised by the live runs. There is no fixture row for them, because adding
one to `EDITOR_TARGETS` to satisfy a test would make the table lie.

**The drift check is shown to go red**, not just to agree today: the suite's own
source is copied with one URL changed and the copy must be reported as drift,
while a copy with an edited *comment* must not — a cross-check that has never
failed is the same defect as a probe whose oracle is the predicate under test.
The copy is always a copy; a self-check that edits a gate to prove a point is a
worse idea than the one it is testing.

The two cases that need a page use a `file://` URL to `test-page.html`, so a demo
site outage cannot turn this into a skip — the property under test is "does it
complain", and an outage is one more thing to complain about. One case is worth
knowing about if it is ever edited: the unwritable destination is an existing
**directory** (`EISDIR`, instantly, everywhere). The first version used a path
under `/proc`, where the write neither succeeded nor failed — it hung, and the
mutant was killed five minutes later reporting "exit null", a third outcome
nothing here has a story for.

```bash
node editor-bench-selfcheck.mjs
```

### 20. `flash-highlight-probe.mjs` — does the flash actually paint? (186 checks)

`sentence-typing-test.mjs` exercises only the **textarea overlay**. The
contenteditable flash is a different mechanism — Ranges registered for
`::highlight()` — with a different teardown rule, and this is its only coverage.
All six certified families run from captures as of 2026-08-24 (Draft and Trix
were live-or-nothing before that); `PROOFER_FLASH_LIVE=1` runs the demo sites
instead, and exit **77** belongs to that mode's unreachable targets. It stamps
`content.js`'s md5 and
mtime into `results/flash-highlight-probe.json`, because a result read against
bytes it never saw is a live hazard when several sessions edit one file.

Detector soundness is the part worth knowing about. Acceptance is a **coherent
area**, not "some pixels changed": three frames with the registry frozen for all
of them (`on`, `off1`, `off2`), where `on − off1` is the highlight plus whatever
the page was animating and `off2 − off1` is the page alone, against a floor of
`max(24, 0.4 × rect area × dpr², 3 × animation noise)`. The freeze took three
attempts, and each failure is a rule: delete **all** registered names, or a fade
step re-registers the next one between screenshots; log `set` *and* `delete` and
replay them in order, or a 1600 ms expiry running inside the freeze is
**resurrected** by the restore — a measurement that resurrects what it measures
can hide any teardown bug; and serve the pre-freeze view to `get`/`has`, or the
collision guard reads the probe's own deletion as a page stealing the name.

Section `[2]` reports NOT RUN with exit 77 rather than passing when the pipeline
never produces a flash — which is how Lexical's open write-path defect surfaced.

`[F] fallback later-word edit` adds nine checks (177 → 186). It uses
`localFresh("#ce", { noHighlightApi: true, tail: "" })`: its
`evaluateOnNewDocument` getter masks `CSS.highlights` before content-script
injection, so even Chrome with Highlight support takes the
overlay branch. It requires a real correction, overlay nodes without a Highlight
registration, and survival while appending after the undo anchor. At about
900 ms after flash appearance, a trusted `X` at offset 28 edits an unchanged
later word: the overlay must clear before its 1,600 ms expiry and Escape must
leave the edited text alone. Timing, unchanged geometry and unchanged field and
window scroll exclude verifier/expiry/movement teardown as false greens.
Typing **[2c]** pins the same contract for a textarea; the existing Highlight
later-word case is the other mechanism's control. Restoring the range-only
overlay end/prefix makes only the two new removal assertions red.

### 21. `replay-log-guards.mjs` — every refusal ever recorded, re-judged

```bash
node replay-log-guards.mjs proofer-log-2026-08-14.jsonl
node replay-log-guards.mjs harvested/qwen.jsonl --examples 20
node replay-log-guards.mjs log.jsonl --json report.json              # redacted
node replay-log-guards.mjs log.jsonl --json h/x.jsonl --include-text # checked
```

**The JSON is redacted by default.** The input is the interaction log, which
holds what the user typed on real sites; an analysis derived from it is the same
text under another name, and `--json out.json` in the repo root is stageable —
`test/harvested/` and `*.jsonl` are ignored, `out.json` is not. The default
artifact carries counts, reasons and SHA-256 prefixes, with the reason payload
stripped (`word-substituted:emtal` names a word the user typed).
`--include-text` runs `git check-ignore` on the destination and **refuses**
rather than warning — a warning printed above a written file is a written file.

No Ollama, no browser, about a second. Every refusal in the log is an
`{input, output}` pair, so a guard change can be scored against real typing
offline — including the direction a spot-check never produces, applies that
would **now be refused**. Reads both record shapes: the popup's `EXPORT_LOG`
and the bench/harvest runners'.

`recorded` describes the engine's guard decision, while `userVerdict` preserves
the exact editor/user outcome. Failed Escape still replays the guard-accepted
candidate as applied; it does not turn user rejection into a guard refusal.
`log-to-cases-test.mjs` **[5]** pins both new strings and this separate guard
outcome; setting `normalizeRecord`'s `userVerdict` to null breaks both preservation
assertions. Historical apply-named outcomes are not rewritten.

Post-write outcomes also preserve `userVerdict` while replay still evaluates
the guard-accepted candidate, as **[6]** in log-to-cases-test proves. Historical
post-write skip strings are read aliases for stats and receipts, never rewritten
in storage or exported logs, and are not human training labels.

Reason strings also preserve their stored identity: new skip counters,
`sentence-skipped:*` suffixes and the two declared `sentence-written:` families
share the worker's 128-character reason bound;
old truncated strings are neither reconstructed nor merged. Settings **[V2]**
pins this through the reporting handlers, stats and export, including distinct
forward/backward deletion window tags. The outcome prefix is outside the bound.

`lib/log-record.mjs` owns row-kind normalization and retry expansion. New v2
sentence records replay `attempts` exclusively, preserving each raw output,
error and guard decision. Legacy applied-retry consent-timeout rows that repeat
the first output/guard count that refusal once and report the accepted retry
output as unavailable. Equal text from two actual attempts remains two rows;
file/row identity survives repeated IDs. Coverage reports interaction count,
explicit unsent interactions, unknown dispatch and unavailable retry outputs.
An unsent v2 interaction contributes coverage but no inference attempt.

`log-record-test.mjs` (18 checks, Node only, CI source-only) pins this with
synthetic exports: **[2a]** the precise legacy timeout duplicate, unknown
arrival/dispatch/attempt wall/lease/backend, G1 error/user-verdict meanings and
delivered retry ordering; **[2b]** equal genuine refusals, v2 canonical outputs
(including empty), unsent coverage and repeated source IDs. Fixture comments
name the one-line mutants and assertions. It was run successfully in an
isolated source copy with no `test/node_modules`, with digest admission disabled,
under `unshare -rn sh -c 'ip link set lo up && node log-record-test.mjs'`.

It calls the shipping `sanitizeSentenceOutput(input, output)` before the guards
and no-op detection, retaining normalized trigger evidence. This rejudges fixed
attempt outputs; it does not rerun the engine or its retry. Legacy top-level
`output` is raw on refusal and cleaned on apply; v2 attempt output is raw, so
running the sanitizer over it is right in both cases and
`sanitizer-would-change` replays rather than being unreachable. Records decided
*before* the guards ran (truncation, invalid JSON, a network error) have
`output: null` and are counted as `unreplayable` — a run that silently drops
them reads exactly like a run where the guards agreed. `sentenceRecordGuard`
removes historical guard attribution only for matching `guard`/`error` pairs
of `truncated`, `invalid-json` and `no-rewritten-key`. **[7]** in log-to-cases-test
pins new and historical records to `recorded:"error"`, no recorded guard, and
`unreplayable:errored`; source records stay untouched. Genuine guard refusals
with a separate error, mismatched pairs and unknown reasons remain guarded.
Bypassing the reader in `normalizeRecord` breaks all three historical
error/absent-guard assertions. Settings **[V4]** independently pins three
historical errors plus a real refusal to `guarded=1`, `errors=3`, the real
`topGuard`, and three `otherDetail.errored` records, with unchanged storage
and export. Making the reader return `r.guard` unconditionally breaks those
four stats assertions.

### 22. `sentence-evidence-test.mjs` — the two guard modes cannot disagree (59 checks; 41 before G6.6)

`guardSentenceResult` is a wrapper over `runSentenceGuards`, which
`guardSentenceReport` also drives. First-failure-wins is therefore a property of
`fail()` returning `!collect` rather than something visible in the chain, and
every silent write the extension makes is downstream of it.

**What it proves is MODE AGREEMENT, not equivalence to any earlier revision.**
Both APIs are wrappers over the same runner, so a change that reorders the chain
consistently leaves this green. Guard *order* is pinned by
`sentence-guard-test.mjs` and `sentence-typo-recall-test.mjs`; the old-vs-new
comparison against `9f6e044` was a one-off (39,306 harvested pairs, plus 250,000
randomized in the audit, 0 mismatches) and is not re-run here.

458 checked-in pairs × 3 triggers, plus the harvested corpora when
`PROOFER_CORPUS_DIR` is set. It asserts the reasons agree, that `reason` is
`reasons[0]` at every exit, that `sanitizer-would-change` is reachable (four
pairs pass a raw that differs from its sanitized form — every other pair passes
one string twice, which makes that guard untestable), and **that evidence mode
runs past each guard**:

- `[2]` requires ≥10 multi-failure cases. Catches a collector that early-exits
  *globally* — which would agree with production everywhere and be useless.
- `[2b]` pins named fixtures to their **full** reason list. `[2]` alone does not
  catch a premature `return` added to **one** guard: the count barely moves.
  Verified by mutation — making `protected-token` return early scores
  **271/271** on the guard suite and **43/48/1** on typo-recall, and is caught
  only here. In the original 32-check run, mutating `fail()` to always stop
  took the suite 32/0 → 31/1 on `[2b]` and further on `[2]`.

- **[4a]** pins the full `terminator-changed` reason list and empty `subs`,
  `lost`, `contentLost` and `unexplainedLost` after a licensed name correction.
  The selected name-adjusted detail replaces the plain detail even when every
  substitution clears. Restoring the `subs2.length` condition breaks the three
  loss assertions.
- **[4b]** pins `capital-removed`, `lost:["know"]`, empty `unexplainedLost`,
  and `dedupExcused:["know"]` for the duplicate-removal witness. Publishing
  an empty `dedupExcused` breaks its projection assertion. Token accounting and
  pairings describe the adjudicated view; surface measures still use the actual
  original and output.
- **[4c]** calls the shared question and both guard APIs: faithful U+2019
  correction and echo pass with `reasons:[]`, while ASCII replacement, a new
  family and within-family additions/substitutions retain literal refusals.
  Omitting `original` from the question's asciify call breaks the pass pins.

`sentence-retry-test.mjs` has **53 checks** (50 before G6.5). **[2a–b]** pass
these reports directly to the keep-list: licensed name corrections and excused
duplicates yield no keeps; a mixed duplicate/function-word loss retains only
`["to"]`. Restoring stale name detail breaks [2a]; removing the duplicate
exclusion breaks both [2b] pins. Matched corrections, licensed names and
duplicate removal are explanations that cannot become keeps. The fallback
still protects legitimate function-word losses, with unchanged typed-form
restoration and the four-token cap.

### 23. `graded-routing-study.mjs` — should some refusals be OFFERED? (no, for now)

```bash
PROOFER_CORPUS_DIR=/path/to/test/harvested node graded-routing-study.mjs
PROOFER_CORPUS_DIR=... node graded-routing-study.mjs --band sole-sub-d1 --list
```

A study, not a gate — but it still fails closed: **exit 1** with no private
corpus (it would otherwise measure four small checked-in corpora, print a HARD
GATE banner and exit 0, indistinguishable from a run over 1282 real sentences)
and **exit 2** on an unknown `--band`. Automatic sole-reason bands come from
`REASON_FAMILIES`, derived from the selected `runSentenceGuards` fail sites in
source order (26 distinct families today). Dynamic word payloads become their
family; unsupported fail expressions throw. Specialized predicates remain
study-owned. The sweep includes `negation-ambiguous`, `closer-added` and
`leading-word-added`, and all three are accepted by `--band sole-<family>`.

It scores every candidate "offer instead of discard" band against 1282 real
model outputs and the checked-in corpora at once, with a column per cost:
`MUST_REFUSE` leakage, `SHOULD` downgrades, `ERRORS`/`MULTI_TYPO` recovered,
`CLEAN` interruptions, and my adjudication of each real hit. It runs the
**shipping** chain using the shared `sanitizeSentenceOutput` question — passing the recorded output as both raw
and sanitized makes `sanitizer-would-change` unreachable and moves the totals
by 2/4/2. A band is a predicate over the **whole chain**
(`reasons.length === 1`), never over the reason string.

Adjudications are persisted in `ADJUDICATIONS`, **keyed by hash** — the
sentences are the owner's private corpus and this file is checked in, so the key
is stable and reveals nothing when the corpus is absent. `--list` prints each
hit's key so a judgement can be found and changed. They are mine, not the
owner's; the holdout `ERROR`/`CLEAN` labels classify the *input* and say nothing
about whether a proposed *output* is good.

What the run concludes, and the limits on it, are printed by the run itself
rather than living only in a report. In short: distance-1 real-word substitution
is unsafe for **silent** apply and the nominated bands are low-volume, so
no-ship now — but `MUST_REFUSE` is an enriched hazard corpus rather than a
prevalence denominator, and there is no agreed precision threshold or
interruption cost, so this does not establish "never offer for review". It also
asserts inline that no band fires on anything the guards **passed**, so the
silent-apply set is provably untouched by any band defined in it.

### 23a. `preguard-score.mjs` and `guard-tools-test.mjs` — source and guard state

`node preguard-score.mjs <bench-run.jsonl> [more.jsonl ...]` reports emitted
edits and surviving guards by CLEAN/ERROR label. Its guard import is relative
to the script, so a copied tree scores its own `background.js`. Labels resolve
from `PROOFER_CORPUS_DIR` or the script-relative `harvested/` directory, even
when invoked from another working directory. The existing filename rules stay:
`bench-(error-holdout|random-holdout|dev-corpus)-*` selects `labels-<corpus>.json`;
other filenames have no labels. This is scoring recorded answers, not rerunning
the engine or its retry.

`node guard-tools-test.mjs` runs 48 checks without Chrome, a real model or private
data (the owner/audit entrypoints use fake loopback Ollama). [1a] uses ordinary copied files (not symlinked modules), first requires a
broken copied worker to fail, then pins the caching-problem → caching-issue
refusal and an admission added only to that copied guard. [1b] selects a second
synthetic corpus and pins its ERROR bucket instead of the default CLEAN label.
Restoring the scorer's absolute seam import or absolute corpus path makes the
corresponding literal count assertions fail.

[2a–b] pins the literal family count, order and normalized payload, source
selection, unsupported-shape rejection, a sole `closer-added` hit and the three
new CLI selections. Removing any formerly omitted family makes its CLI
assertion fail. [3a–b] drives the audit's actual prefix-insertion variant with
a generated-name witness, then compares names-disabled and the other dataset
controls. Dropping the variant's names or ignoring any selected control turns
the corresponding literal admission/refusal and state assertions red.

[4a] pins live/reguard raw markdown and a sanitizer-altered tag echo, including
refusal before no-op. [4b] drives audit collection, `--from`, all 11 threshold
sweeps, prefix variants and perfect-model paths with literal sanitizer reason
lists and refused counts; sanitizer-altered echoes also count as refused. Each tested
caller has a raw-as-sanitized mutant; early-no-op and clean-classification
mutants pin ordering. The audit's two-reason fixture combines added markdown
with straightened original typography; a tag-preserving correction passes
raw-only judging and keeps sweep/variant/perfect-model mutants discriminating. [4c] pins current survey admissions
against both a synthetic comparator and b332d8d, which retain their own
`sanitizer-would-change` refusal family. [4d] pins b332d8d's full original
curly-apostrophe refusals, current correction/echo admissions and rejection of
unsupported legacy sanitizer shapes. Substituting the current question for a
comparator turns its literal reason and admission assertions red.

The routing study, preguard scoring, retry bakeoff and finetune context-floor /
context-stability probes also use the shared helper instead of composite copies.
Run the finetune scripts as entrypoints with `--dry-run` (stability also requires
`--windows 375,500,2500`); importing them starts or refuses a sweep.

### 23b. `guard-headroom-audit.mjs` — guard cost and variant parity

```bash
node guard-headroom-audit.mjs --from results/guard-headroom-raw.jsonl
```

An offline analysis of recorded input/output pairs; omit `--from` only to
collect new model outputs. It compares refusal costs, threshold sweeps and
source-patched variants. The variant path calls the same
`loadSentenceGuards({ source, dataRoot, controls })` as the default seam.
`source` defaults to the exported worker snapshot `SENTENCE_SOURCE`;
`dataRoot` defaults to the tree's data directory. Every instance uses the same
normalized word list and shipping integrity-checked confusables/names loaders.
Omitted controls read the environment switches above; explicit
`{ noDict, noConfusables, noNames }` replaces those defaults. The combined
no-dictionary control is historical, not a words-only failure simulation.
`--from` rejudges fixed outputs in its guard comparisons; it does not rerun the
engine or retry. Collection, full reason reports, threshold sweeps, variants
and perfect-model analysis all supply the shared sanitizer result separately
from raw output; variants use their own loaded helper. Stored collection
verdicts remain historical. A disagreement warning can indicate either code
changes or older measurement callers; don't treat it as a runtime delta. Store
reports under ignored `results/` because the audit prints recorded sentences.
G6.4's 1,283 fixed audit outputs gain the sanitizer reason on 22 rows, including
21 former measured no-ops. The historical raw file also has 10 older verdict
disagreements; a separate rejudged copy establishes the corrected baseline
without changing the source recording.

### 24. `sentence-provenance-test.mjs` — can the scan be fed? (55 checks)

No Ollama. Real CDP keystrokes, then a silent page mutation, asking one
question: can text the user never typed reach the model or the field?

Every other defence — the edit-size diff, `SENTENCE_BULK_CHARS`,
`BULK_INPUT_TYPES` — lives in the **input handler**, and a `.value` assignment
fires no event for them to run on. Against the pre-fix base, **28 checks are
red**. Four routes are covered, and the last three were added after an audit
found the first fix closed only the first:

- `[P2]`/`[P3]` the **idle window**: full replacement and prefix injection at
  +50/+200/+400/+500 ms. `[P3b]` then types afterwards, because a refusal that
  merely defers one pass is worth nothing.
- `[P3c]` an **unfinished** injected sentence, completed by one later keystroke.
  Re-deriving the watermark cannot catch this — an unfinished trailing segment is
  left ahead of it by design — so it is the provenance floor's case.
- `[P3d]`/`[P3e]` a tail mutation **while a request is in flight**, which the
  scan chained off the response can send with no timer involved. `[P3e]` shapes
  the injection with three characters past its terminator so the *non-idle*
  chained scan fires it immediately; that is the case that decides the check
  cannot be gated on the idle path.

Four sections keep it honest rather than merely green:

- `[P4]` mutates at +900 ms, **after** the window, and asserts a request still
  goes out. "Nothing page-authored was sent" is satisfied by sending nothing at
  all, which is what a guard that simply stopped working would produce.
- `[P5]` measures rather than assumes: event-count growth, the new event's
  `inputType`, that the insertion actually happened, *and* `isTrusted` — reading
  only the last event passes even if `execCommand` did nothing, because the
  previous real keystroke was trusted too.
- `[P6]` is the control that matters most: the **same field contents typed by a
  real user**, byte for byte, still sent and still corrected. A guard that
  cannot pass this is a guard on content, not on provenance.
- Timing is **asserted**, not just collected: each in-window trial checks the
  observed gap between the last trusted input and the mutation. The helper used
  to sleep after the final keystroke, which pushed the nominal +520 ms arm to
  535–564 ms before CDP overhead — a mutation landing after the window would
  have read as a clean pass on vulnerable code.

Two more routes came from a second audit and are pinned the same way. `[P3f]`
delivers the unfinished sentence as a >8-character page `execCommand`, which
arrives **trusted** — so the bulk branch has to fence the region before adopting
it, since re-deriving cannot retire an unfinished segment. `[P3g]` is the moving
floor: the lengths are the mechanism, not decoration. The page installs a short
fragment (floor 22) and the user inserts a *longer* sentence in front of it, so
the refusal advances the watermark past 22 and retires a floor the fragment has
slid out from under. A shorter insertion does not reproduce it — the first draft
of that case made exactly that mistake and passed against its own mutant.

Each piece of the fix is pinned by a mutant:

| mutant | goes red |
|---|---|
| floor disabled | `[P3c]` |
| apply site reads the field back | `[P3d]` |
| veto compares `lastText` | `[P3d]` |
| `fromIdle` gate restored | `[P3e]` |
| adopt before classification | `[P3f]` |
| floor never shifts | `[P3g]` |

One fix has **no** mutant that this suite can catch: deriving the sentence
apply's baseline from the pre-write epoch. Its mutant passes all 55, because a
textarea splice has no awaited window to interleave with — reaching it needs a
real Slate editor and a yielded action inside the INTENT window. Recorded as
argued rather than measured, not quietly counted as covered.

`[P3b]` also **asserts a residual** rather than only asserting the fix: page
text still travels as `priorContext` for a legitimate target. The harness used
to drop `priorContext` on the floor, which made every "no page text reached the
model" claim narrower than it read.

Honours `PROOFER_CONTENT` (how the paired control and every mutant were run) and
`PROOFER_SEED`. `SENTENCE_IDLE_MS` is read out of the shipping `content.js`
rather than copied, so retuning the window cannot leave this suite asserting the
old one.

`sentence-provenance-probe.mjs` sits beside it as an experiment rather than a
gate: it types the Slate gate's message into the real capture and prints what
reached the extension, which is how the regression below was diagnosed. Point
`PROOFER_CONTENT` at an instrumented `content.js` and read the trace.

**This suite cannot certify the provenance work on its own, and a regression
proved it.** It is textarea-only plus one Slate-*shaped* fixture. A shaped
fixture has no editor model, so the browser applies every keystroke natively and
an `input` event always arrives — while real slate-react cancels `beforeinput`
for anything outside `/[a-z ]/i` and applies the edit itself, firing **no**
`input` event for a period. A provenance check keyed to `input` therefore read
every sentence terminator as a page mutation and took Slate to **0/6**
corrections, with this suite at 55/55 and `sentence-typing-test.mjs` at 135/135
throughout. Run `sentence-slate-test.mjs` for anything that touches the apply
path or the provenance baseline; the change map says so and this is why.
### 25. `prefilter-probe.mjs` — should a lexical check gate the model call?

```bash
node prefilter-probe.mjs                  # 13 sections, offline, a few seconds
node prefilter-probe.mjs --run item5live  # score a different recording
node prefilter-probe.mjs --json out.json
```

An **experiment, not a gate**, and the answer it recorded is **no** — kept so the
proposal is not re-run from scratch. It asks whether "does this sentence contain
a non-word, a doubled word, or a licensed confusable?" earns the right to skip
the request. Nothing is called: it decides from the input sentence, forces every
skipped row to `no-op`, and re-scores the recorded runs with
`sentence-owner-bench.mjs`'s own scorer, so the model is held fixed by
construction and the whole thing runs offline. The lexical internals come out of
`background.js` in a `vm`, because a probe that re-implements `isWord()` is
measuring a filter the extension could not build.

Three of its sections are worth reusing whatever the subject:

- **§11, the matched-count random control.** Anything that drops N% of the
  workload prevents ~N% of the harm in it for free. The control skips the same
  *number* of requests at random, 200 trials, so "it suppressed the damage" has
  to beat chance before it means anything. Here fix retention did (z = +3.9 to
  +5.7) and damage prevention did not.
- **§13, the residency duty cycle.** Unioned load intervals over the owner's
  49,784 real messages, which is the only view in this repo where the dominant
  energy term is visible. It needs `harvested/discord-source.mjs` and the CSV
  export, and says so and skips if either is absent.
- **§8, skip precision.** Of the requests a policy cancels, how many would the
  model have answered with the input unchanged — and of the rest, what *kind* of
  edit was cancelled. Three of every four here were a comma the owner's rubric
  welcomes.

### 26. `reseg-wall-survey.mjs` — how much of a moved space can the guards repair?

```bash
PROOFER_CORPUS_DIR=$PWD/harvested node reseg-wall-survey.mjs
PROOFER_CORPUS_DIR=$PWD/harvested node reseg-wall-survey.mjs \
  --compare /tmp/old-background.js          # two guard revisions, one process
PROOFER_CORPUS_DIR=$PWD/harvested node reseg-wall-survey.mjs --examples 12
PROOFER_CORPUS_DIR=$PWD/harvested node reseg-wall-survey.mjs --trigger idle
PROOFER_CORPUS_DIR=$PWD/harvested node reseg-wall-survey.mjs --json out.json
```

An **experiment, not a gate**, and the only instrument in this repo that can see
its subject. Every other guard measurement is a replay of what the model
produced; a **moved space** is what a *typist* produces — `Divertingt o`,
`notsure`, `mor elike` — and a model emits it almost never. The 2026-08-15
resegmentation round moved **2,686** verdicts here and **zero** across 2,364
recorded model outputs, so a green replay is no evidence at all about
`collapseResegmentations`.

It manufactures the input instead: every alphabetic word boundary in both
holdouts, damaged three ways (`left` the space slides left, `right` it slides
right, `join` it is deleted), asking the shipping guards whether they would
admit the **correct** repair — the original sentence, byte for byte. 20,990
damages, offline, a few seconds. It is a **ceiling**, not a rate: it says what
the guards would admit if the model produced the right repair, nothing about how
often it does.

The wall is decomposed rather than totalled, because the buckets mean opposite
things:

- **POLICY** — every damaged fragment is a dictionary word, so nothing says a
  typo is being corrected. This is the `the rapist` → `therapist` protection and
  it must not shrink. **A change that newly ADMITS a POLICY case is the result
  that sinks it**, and `--compare` prints that line first for exactly that
  reason. The total going down is not the same as the change being good.
- **DICT** — the correct repair itself holds a token the 64k word list does not
  have (proper nouns are deliberately absent; so are `capita`, `findable`,
  `ChatGPT`). The collapse declines and every downstream guard sees an
  unexplained token. Same design decision, one step along.
- **OTHER** — neither. This is where a defect shows up.

`--compare <background.js>` uses `loadSentenceGuards` for a second revision's
guards and sanitizer question, and reports flips both ways over the identical
damage set. A pre-extraction snapshot such as b332d8d uses its actual engine
sanitizer statements, validated by the seam; unsupported shapes fail rather than
borrowing today's helper. Both revisions use the selected datasets and controls.
The current guard call also runs the shared question before judging the repair.
G6.4's corrected baseline admitted 19,294 of 20,990 (1,696 walled), versus
19,677 admitted / 1,313 walled under the old raw-twice instrument. Its runtime
comparison had zero flips: those 383 extra refusals were tool corrections.
G6.6 now recovers those 383 repairs through the original-aware question,
admitting 19,677 of 20,990, with zero newly walled and zero newly admitted
POLICY cases. This runtime recovery is measured with the corrected instrument.
Its counterpart for
recorded traffic is `sentence-owner-bench.mjs --replay <run.jsonl> --reguard`,
which discards the recorded verdicts and re-judges each recorded output under
the current guards — so a guard-only change gates offline against fixed model
outputs, immune to the live gate's ≥1-uid sampling noise floor. This file
covers the manufactured half, the bench flag the recorded half.

The holdouts are gitignored and live only in the main checkout, so a missing one
is **exit 1** naming the file and the path, never a clean run over a smaller
corpus. Zero sentences and zero damages are nonzero failures too; a bad
`--trigger` or an unreadable `--compare` is **exit 2**, the caller's claim.

### 27. `sentence-request-bytes-test.mjs` — the sentence request, byte for byte (8 shapes)

Offline. Builds every request the sentence path sends — first pass with and
without prior context, with a page heading, hostile context text, no page
context, the retry's WHOLE body with and without a keep-list (from
`prepareSentenceRetryRequest`, the builder the worker sends it with, so its
options, model, format and lease are pinned as well as its messages — until
2026-09-25 only the messages were, and a retry sent at another temperature
passed), and the warmup body — and compares each serialization with
`test/golden/sentence-request-bytes.json`. (The `/qwen/i` cases went with that
keying in step 3b; the pilot's requests were unchanged by it.)

It was added when the manual rewrite path was removed from `background.js`,
because the sentence prompt had shared that builder. Every measurement of the pilot was taken
against these exact bytes. A prompt change is allowed — it is step 1's job — but
it has to be a deliberate re-record (`--write`), measured, never a refactor's
side effect. `--write` refuses changed or new bytes under an unchanged
`PROMPT_REVISION`, and accepts without a bump only a removed case (a shape the
product no longer sends). A "widening" allowance let the retry cases grow from
messages to the whole body on 2026-09-25 and was removed the same day: an added
sampler field is a widening too, and it changes what the model does. Mutation-checked: one character
changed in the shared instructions turns every case with messages red, one in
the retry's keep-list line turns exactly `retry-keeps` red, and a retry sent at
temperature 0.9 or without its lease turns both retry cases red. In CI's
`source-only` job.

```bash
node sentence-request-bytes-test.mjs          # compare (the gate)
node sentence-request-bytes-test.mjs --write  # re-record, deliberately
```

### 27a. `sentence-retry-handler-test.mjs` — the sentence handler's wiring

Offline (no Ollama, no browser; CI's `source-only` job). Drives the SHIPPING
`SENTENCE_REWRITE` handler in a vm against a scripted Ollama that honours the
abort signal the way real fetch does (an aborted request and any later body read
both reject), with a scripted clock and a storage read the test can hold open.
The suite's final summary reports the executed assertion count.
It pins the handler's retry and delivery contract: at most two model requests
per sentence, the keep-list constraint on the wire, a failed retry falling back
to the original refusal, cancellation during the first body read, mid-retry and
across the final consent read, the absolute deadline capped by the content
script's 5 s delivery lease (a stalled body included), consent revoked before
and during the retry, `retrySalvaged` counting only delivered salvages, and the
record's interaction/request timing split. `[T1]`–`[T7]` pin the installed-model
check before the send: the digest the record names, another digest refused as
`model-mismatch` and a missing tag as `model-missing` without the text being
sent, an unverifiable one refused too, the 30 s lookup cache (reused in a burst,
dropped after a failed request, expired on the clock), consent re-read right
before the send, and the engine's own deadline gate. Since checkpoint 3,
`[T2b]`/`[T3b]` require a mismatch or a missing engine to void the speed-check
verdict for the next sentence too, and `[T2c]` that a sentence already at the
model when the mismatch is found is cancelled with its request aborted (not
merely refused at delivery). Its mutants are listed in the commits that added
each case. **[H15a–c]** script first-pass truncation (including parsable JSON),
invalid JSON and a missing rewritten key through the real handler. Each pins
one request, a non-network error without `refused`, `guard:null` with the
matching error, and no retry. **[H15d]** checks both out-of-range target lengths:
`error:"target-length"`, no chat and no record. Changing each response's
`error` property back to `refused` breaks that arm's assertions.

**[H17]** pins a first-pass U+2019 correction and faithful clean echo, with no
guard attribution and one canonical attempt. **[H18]** starts with straightened
typography and an unexplained substitution, then accepts only the typo fix
with the original U+2019 on retry. It pins two requests, delivered text and
both canonical attempts. Passing an empty original to the corresponding
first-pass/retry question turns these delivery and record assertions red.

**[H19–H20]** give a licensed name correction and an excused duplicate removal
another, soft refusal, with current consent and sufficient budget. Both must
return that original refusal, send exactly one chat request, record one v2
attempt and report `retry.outcome:"no-keeps"`. Restoring the conditional name
detail breaks H19's request-count, no-keeps and attempt-count assertions;
omitting `dedupExcused` from either the evidence or the fallback exclusions
breaks the same H20 assertions. Scripted Ollama isolates dispatch; the separate
live 49-hazard gate adjudicates what retries actually apply.

```bash
node sentence-retry-handler-test.mjs
```

**[H11b]** holds the initial settings read and verifies exported arrival,
completion, the `startedAt` alias and independent fetch/body wall.
**[T4c–d]** distinguish a tags failure (no inference, no lease, retained
interaction duration) from a POST transport failure (one attempt with a measured
wall and null Ollama counters). **[H14a]** preserves the refusal reply while
exporting the undelivered interaction and both first/refused and retry/accepted
outputs exactly once. **[H16]** serializes real EXPORT_LOG replies and checks
literal field paths against ARCHITECTURE.md's v2 table, timing aliases and
nullability, including the pre-settings-failure response path. Its six synthetic
size samples include realistic IDs, context and backend: no retry, applied retry,
refused retry, refusal, transport error and consent-timeout. Set
`PROOFER_RECORD_SIZES=<ignored-path>` to save their byte measurements.

### 27b. `scoring-engine-test.mjs` — do the quality suites score what the product delivers? (62 checks; 24 before G5.5)

Offline: a loopback fake Ollama, no model, no browser, no `node_modules`. In
CI's `source-only` job. `callSentence` runs the shipping sentence engine, and
each case is an outcome the old caller scored wrongly: a correction lands; a
reply truncated at `num_predict` whose JSON still parses scores as the input
(the engine returns a non-network `truncated` error); a reply slower than the product's 4,750 ms deadline
scores as the input and is abandoned AT the deadline (~5 s of real time); a
refusal the retry salvages scores as the salvage in two requests; a refusal with no
budget left sends one request and counts no retry, while a retry sent and refused
again counts one (a retry is counted only when it was dispatched);
`PROOFER_OPTIONS` reaches every request sent; and the pinned tag under another
digest stops the run with nothing sent. Mutation-checked six ways: the engine
accepting a truncated reply, `callSentence` ignoring `PROOFER_OPTIONS`, a 120 s
deadline, no retry, counting pre-send retries, and never marking a retry
dispatched. **[2b]** adds exact error outcomes and counter deltas for all three
model-shape failures: one send, no refusal or retry count, truncation in its
own counter and invalid JSON/missing key in errors. The input fallback and
`{text, raw, refused, outcome}` result shape stay intact; `refused` retains the
error code for caller compatibility while `outcome` names the error rather
than a guard refusal. Classifying `payload.error === "truncated"` in the
guard-refusal branch breaks its outcome and counter assertions. [2] remains
the separate parsable-truncation control, including its counter assertions.

**[4d]** uses the engine clock seam to expire a guard-accepted retry: unchanged
scored text, one dispatched retry, one expiry and zero salvage. `callSentence`
uses the worker's `isRetrySalvaged(sentenceResultFields(payload, meta))`, with no
page verdict; [4] remains the delivered control. **[4e]** pins one interaction,
two attempts with 300/700 ms walls, 24 evaluation/200 prompt tokens, and a failed
retry's null counters. **[7]** retains the direct-fetch API and checks raw-counter
conversion, missing values and paired throughput. **[6b]/[6c]** run fresh scoring
and tiny benchmark children: mismatched pinned tags send nothing without opt-out,
nonempty opt-out permits inference, and an unpinned research tag is permitted.
`researchModelPolicy` supplies both admission and engine invocation, preserving
canonical tags and pinned aliases; the extension continues passing its pin
directly. One-line mutants restore outcome-only salvage, drop the second attempt,
restore each caller's tag-only digest expression, or discard direct-fetch
evaluation counts; the corresponding literal assertions turn red.

```bash
node scoring-engine-test.mjs
```

### 27c. `setup-check-test.mjs` — the speed check and its verdict (265 checks; 227 before G3.3)

Offline: the SHIPPING message handlers in a vm against a scripted Ollama, no
model, no browser, no `node_modules`. The installer fixtures also require Bash,
Node.js and standard shell utilities (`dirname`, `sed`, `seq`, `cat`, `grep`);
Docker and curl are fake commands. In CI's `source-only` job; about 45 s
(it waits out real 3.8 s cases and three long-context deadlines on purpose),
because the harness compresses exactly one delay (the 6 s first-sentence wait
after a burst's warmup) and nothing else. Pinned: a GPU run passes, is stored
bound to the Ollama version, prompt, check and engine, lets Proofer be turned
on and a page allowed, and its report holds no sentence, answer or address; a
wrong answer the guards accept fails as `unexpected` (an answer they REFUSE on
a clean fixture leaves the field unchanged, which is what that fixture
expects); one case past the deadline fails as `too-slow`; [3b] the
long-context case (the one sent with a full 2,500-character context) is held
to its answer and not its time (owner, 2026-09-25): dropped at the deadline the
run passes, records `longDropped`, and SETUP_STATUS hands that to the ready
screen; slow but delivered is not a drop and passes; the sentence run again
after it (`SETUP_AFTER_LONG`) over 4.5 s fails as `too-slow` — the drop was
not clean; a wrong answer on the long case is still `unexpected`; a CPU run calibrates
`num_thread` over `threadCandidates`, qualifies with the chosen count, and every
later request and warmup carries it, and every sentence record names the
backend class (GPU, Apple — a GPU run on macOS — or CPU, with the thread count)
so beta latency can be read by hardware; a missing engine stops the run and
the FAILURE is what is stored and reported (checkpoint 3); a failed retest
replaces the pass before it, which does not let a page write while the retest
runs; a run the worker lost reads as interrupted; [5g] all three successful
settings replies retain effective settings, consent and the pin while only
projecting the qualification through `shownVerdict`: live `running` versus
orphaned `operational/run-lost`, unqualified in both cases, with the stored
attempt unchanged. [5h] a rejected new running-record write retains the old
attempt: report version 2 labels its tag, digest, prompt revision, benchmark
revision and Ollama version as historical, its measurements unchanged, and
labels today's pin/revisions in `currentBuild` (`extensionVersion` and
`engineNow` are current observations). An orphan's projected lifecycle retains
that identity too. [5i] new running and completed records snapshot the literal
3,500/4,500 ms bounds and `may-drop` policy; export preserves historical bounds
exactly and returns explicit `null` when absent, with no migration or
invalidation. No attempt means null result and null attempt identity.
Mutants bypass the settings projection, substitute today's constants for each
historical identity field, alter the bounds snapshot, replace historical bounds
with today's or invent only the missing bounds. Each case names its mutant
and intended red assertions beside the fixture. An Ollama updated mid-run, or
just before the finish, stores no pass; opening setup after an update is not
Ready and a failure under the old version is not today's; the URL changing
mid-run, or during the finish itself, stores no pass; a URL change while a
sentence is at the model, a NEW verdict stored then (consent still yes — only
the configuration generation separates them), and a new verdict stored during
the job's final consent READ all stop that correction's delivery; setup's
check of the download finding another engine voids the verdict and the
correction in flight, and a warmup never loads another digest; [10] the
bounds at their edges — one warm case at 3.8 s passes, two fail the p95 with
every case under 4.5 s — calibration picking the FASTEST count, `/api/ps` or
the unload failing (and an engine that stays loaded) stopping the run as
`ollama-status` rather than measuring it cold, and the version cache used for
30 s, asked again past them, and dropped after a failed request; a burst's load recorded with Ollama's
own duration when reported and as unknown (null, never 0) when not — 0.32.12
reports none for a load-only request; an Ollama update marks the verdict stale, stops the next sentence
before it is sent, refuses consent and raises the badge, and the first consent
ask (a field's first focus) is where it is noticed; only the setup page
may send `SETUP_*`; and setup's check of the download fails on a different
digest, template or parameters. Mutation-checked ten ways: consent ignoring the
verdict, wrong answers not failing, expired cases not counted, no calibration,
no thread count on requests, no freshness check, any extension page accepted as
the setup page, parameters unchecked, a verdict stored across a configuration
change, a URL change not advancing the generation, the record dropping the
backend class, no Apple class, and a job not checking the generation; and
for checkpoint 3 sixteen more, each red on its own case: failures not
recorded, no running record, a lost run shown as running, no version check in
the run, setup's status using the cached version, no invalidation from setup's
check, no digest check in the warmup, an infinite p95 bound, calibration
taking the first candidate, `/api/ps` read without its status, the unload's
answer ignored, the unload not polled, an infinite version-cache life, the
version cache not dropped on errors, and the synchronous generation check and
read-then-compare removed together ([6e] — each alone is covered by the
other). The clean-drop rule, seven more: the long case's exemption from the
time bound removed, every expiry exempted, no sentence after the long one, the
long case exempt from `wrong`, the long case's time left in the percentiles,
the drop not reported to setup's status, and the after-long case not named as
such.

```bash
node setup-check-test.mjs
```

G3.2 adds **[7c–d]** for recovered contact publishing the empty badge and
`Proofer` title before any sentence can compensate, cancellation retaining
`AbortError` without a service warning, retained stale warnings,
and an unsaved healthy/mismatched preview that cannot affect the configured
outage or qualification. **[9b]** primes digest X, repairs it inside the TTL,
and verifies P with a new tags request, `/api/show` and the shared cache; the
reverse change refuses, ordinary lookup still caches, and both state readers
refresh past a present tag. **[11a]** scripts HTTP 500 JSON, a missing array,
invalid JSON and transport failure for both status readers: unknown, with an
empty successful array as missing control. **[11b–c]** drive direct worker
retests below the floor and with unparseable versions, exact-floor/supported/
suffix controls, idle/finish checks and stored-version qualification. The
literal revision stays `speed-v2`; unsupported probes send no benchmark traffic.
**[12a–c]** separate answered failures from stopped service and verified missing
engines, retain only controlled codes in step/store/report, and keep status
failures terminal during cases, calibration, burst warmups and finish. They
include G1.4's model-shape errors and an unexpected internal exception.
Mutants beside the fixtures bypass fresh reads, floor refusals and badge
publication/endpoint guards, conflate failure classes, admit operational cases,
omit report codes or reinterpret HTTP health as usable status. No live model
or installer tooling is needed for these cases.

G3.3 adds **[13a–c]** for the shipping `setup.sh`, copied with `background.js`
and Compose configuration into a temporary directory. A closed command PATH
intercepts every Docker/curl invocation; no real service, pull or network is
used. [13a] refuses digest X under the pinned tag even when another tag has P.
[13b] accepts `name` and `model` aliases, formatted JSON and both `sha256:` and
`sha256-` prefixes; missing tags fail, while HTTP failure (even with a plausible
success body), invalid JSON and missing/non-array inventories remain
indeterminate. Every inventory also drives the worker lookup with an independent
literal expectation. Missing Node fails before services/network. [13c] keeps
pull failure nonzero, gives connectivity/retry guidance and refuses a local
build substitute. One-line mutants beside the cases replace tag selection with
any-digest matching, omit each alias or normalization, default malformed inventory
to empty, ignore HTTP failure, bypass Node preflight, or restore local-build
advice. Installer changes also run `bash -n setup.sh` and the namespaced
welcome-flow gate below; the benchmark stays `speed-v2`.

### 27d. `welcome-flow-test.mjs` — setup end to end (87 checks; 68 before G3.2)

Puppeteer with the REAL extension, setup page and worker, against a scripted
fake Ollama on the default address 127.0.0.1:11434 — which it must own, because
a fresh install opens setup by itself against that address. So it runs inside a
network namespace, as CI's browser job runs every suite, and refuses (exit 2) if
something already answers there:

```bash
unshare -rn sh -c 'ip link set lo up && node welcome-flow-test.mjs'
```

About five minutes (four full speed checks with their idle pause). It pins:
install opens setup; Ollama absent asks for it in plain words with OS steps;
Ollama appearing carries on with no click and the download starts with
progress; a cut connection shows "the download stopped" and Try again resumes
from the partial bytes; the download is checked and the speed check runs by
itself to the ready screen, which offers Turn on without doing it, says what
the log holds, that pages open from before need one refresh, and how to pin;
Save test report saves a file through the page's dialog, holding the result,
every case, the attempt's engine/revisions and stored bounds, separately labeled
`currentBuild` metadata under report version 2, the optional laptop model typed
there and what the browser can tell (cores), and no sentence, answer or address;
**a typo typed before Turn on stays and is never sent**; Turn on from setup
then corrects it; an Ollama update mid-field stops the next sentence before it
is sent and raises the badge with the reason, and setup reopened runs the check
again; Pause survives reopening and Resume continues the partial download; and
the update-needed and not-Ollama screens and the too-slow and unexpected
verdict screens, each with Retry and Save test report; Ready's "Run the speed
check again" runs a NEW check to a new stored verdict; and a REAL failure and
recovery (checkpoint 3 found every failure here was seeded): Ollama stopping
in the middle of a retest shows the operational screen saying so, the stored
verdict and the saved report are that failure and not the pass before it, and
Try again with Ollama back reaches Ready and qualified — and, on that same
run, the long-context sentence made to miss the deadline: the check still
passes, and Ready says in plain words that on this computer a sentence with a
lot of text before it may be skipped and left as typed (the first Ready, where
nothing was dropped, says nothing about it). Mutation-checked: the Ready retest
button unwired, no running record at the start of a run, and the long-context
note never shown and always shown. It found a real defect on its first run: setup stamped
its state on `<body>` as `data-state`, which its own `[data-state]` selector
then matched, so every screen after the first was hidden. The fake's chat
template is a stand-in, so the worker is told its hash. **[13]** additionally
wraps the worker’s storage writer in a scoped failure injection: the migration
stamp is rejected while qualification storage succeeds. Ready must explain the
incomplete upgrade, make no on claim and retain Turn on; restoring the writer
lets that existing action retry migration and activate. The writer is restored
in `finally`. Its mutant disables `showReady`’s upgrading override and turns the
explanation assertion red (58 passed, 1 failed at G2.1). **[18]** starts a real
check, opens the real toolbar popup to pin its running wording, closes setup,
stops and restarts the service worker through CDP, and opens the toolbar popup
again. It must now say the check did not finish, with no running wording and
no stored-attempt rewrite. Bypassing `settingsForPage`'s projection turns the
two interrupted-wording assertions red. [4b]'s saved-file check rejects a
`reportVersion: 1` mutant. `PROOFER_SCREENSHOT_DIR` optionally saves both popup
views for visual inspection.

G3.2 adds **[9b–c]** (trusted retest after downgrade, and a failed first status
message with no pulls/checks), **[14]** (HTTP-500 inventory remains checking
across polls; a restored missing inventory downloads), **[15]** (same-worker
fast mismatch repair, with pull completion before fresh tags, show verification
and automatic check), **[16]** (real action badge/title recovery and the real
recovered toolbar popup), and **[17a–b]** (answered-error wording; missing-engine
operational recovery through refresh, pull, verification and check). Each names
its one-line production mutant and intended red. The saved screenshots include
the recovered popup as well as the live/interrupted views. These are scripted
service witnesses; the separate live `sentence-e2e-test.mjs` gate still runs the
real speed check, with no benchmark revision or extra GPU/CPU verification round.

### 28b. `inject-probe.mjs` — can Proofer reach tabs open before install? (experiment)

Needs a browser, not Ollama. Packages Proofer with `scripting` added and asks
`chrome.scripting.executeScript` to run in a page on an origin the content
scripts match but `host_permissions` do not cover. **Measured 2026-09-25: no**,
in Chrome for Testing 145 and Brave (Chromium 153) — "Extension manifest must
request permission to access the respective host", exactly as for
chrome://version. Proofer does not request broader host permissions or inject
into existing tabs, so setup says a page open from before needs one
refresh, and content.js needs no double-injection guard.

```bash
node inject-probe.mjs
```

### 28. `origin-rule-probe.mjs` — does Proofer's Origin rule get through a stock Ollama, and only Proofer's?

An experiment, not a gate: it needs the `ollama` binary and
a real browser. It starts a private `ollama serve` on a spare port (default
11591, `PROOFER_PROBE_PORT`) with **no** `OLLAMA_ORIGINS` and `OLLAMA_NOPRUNE=1`,
packages Proofer with `tools/package.mjs`, loads it beside a second throwaway
extension, points Proofer at the private port the way the popup's Save would,
and POSTs `/api/show` for a model that does not exist — Ollama's origin check
answers 403 before routing and anything it lets through answers 404, so the
status separates "refused at the door" from "processed" with no model load.

```bash
node origin-rule-probe.mjs      # Chrome for Testing, and Brave if installed
```

Rows per browser: the rule is scoped to Proofer's id; Proofer's worker, popup
and setup page (`welcome.html`) get through; a second extension and a web
page on 127.0.0.2 stay 403 (the page's opaque request is read from Ollama's own
log); and with the rule removed the worker is 403 again, so the rule is what
made the difference. **2026-09-25: every row as expected on Chrome for Testing
145 and Brave 1.x (Chromium 153), Ollama 0.32.12** — re-run the same day with
the setup page packaged, whose download and checks go through the same rule:
it gets through in both. Edge is not installed here;
it is the Windows acceptance test's. The offline half — one rule, scoped,
following the URL, awaited before a POST — is in `sentence-settings-test.mjs`,
mutation-checked three ways.

### 29. `prompt-cache-study/` — can the prompt be cached? (experiment, beta step 1)

Optional research, not a gate and not in CI. The original measurements were
run on 2026-09-25. This instrument explores where a prompt can be reused on
the runtime. **E1** diffs two consecutive
requests' rendered token streams and reads what the runtime actually reused;
**E2** changes one token at a time across the prompt, from a fresh runner primed
with the identical baseline every time, and maps reuse against position; **E3**
types twenty real 8-sentence emails (public Enron mail) in order through each
candidate layout on 4 and 8 CPU threads and the Intel iGPU, plus document
switches, retries and context rollover; **E4** screens each layout's quality on
the frozen benchmark with the current pilot.

The answer, for anyone changing the prompt: Ollama 0.32.12's bundled llama.cpp
resumes this hybrid model only at saved checkpoints — the starts of the first,
second and last user messages and 4 and 512 tokens before the end — so anything
that varies between sentences (the `writing on <host>` line, `prior_context`,
the retry keep-list) must start at or after the last user message, or the
whole prompt is re-read. An identical re-send prunes checkpoints (one slow read
for L3-post, then caching resumes). E4 is a screen on an untrained model: it
ranks layouts and cannot clear one to ship.

**Rerun on Ollama 0.34.3 (2026-10-01)**: E1 24/24 and E2 66/66 identical to
0.32.12; the identical re-send no longer prunes (407 tokens reused, not 112);
and the API's `prompt_eval_cached_count`, which 0.32.12 did not report, equals
the log-measured reuse on all 96 requests, so on 0.34.3 the API is the reuse
instrument. `serve.sh` runs another release with `OLLAMA_ROOT=<its tree>`.
Aggregate evidence is in `results/ollama-0.34.3-2026-10-01.json`.

Rules for running it: private servers on spare ports only, started and stopped
with `serve.sh` (never the owner's service on 11434); `OLLAMA_NOPRUNE=1` on
the shared model store; a CPU run must hide Vulkan as well as CUDA, and
`/api/ps` must show `size_vram` 0 before its numbers count. Raw data and server
logs go to `test/harvested/cache-study/` (git-ignored, 0600 in 0700); the
public summaries retain aggregate numbers and synthetic examples only.
E1/E2 use checked-in synthetic fixtures. E3/E4 and the training trial need
separately supplied benchmark artifacts and are not reproducible from the
public source alone. These are example commands; choose available CPU cores
and configure the runtime/model paths before running:

```bash
cd test/prompt-cache-study
export RAW="$PWD/../harvested/cache-study"
mkdir -p "$RAW"
chmod 700 "$RAW"
./serve.sh start ollama-cpu 11556 8-15 $RAW/ollama-11556-e1.log
./run-e1.sh original && ./run-e1.sh addendum && ./run-e1.sh replay && ./serve.sh stop 11556
# E2-E4 have separate run scripts; E3/E4 require local benchmark inputs.
node analyze.mjs && node analyze-e4.mjs
```

The report's §8a (2026-09-25) adjudicated the candidates' unjudged outputs: a
merged ledger (the later ledgers of the same benchmark, plus one blind GPT-6
pass over the rest, with hidden controls) rescored with
`node analyze-e4.mjs --layouts L0@rerun,L3-post,L4-conv,L2-conv --ledger
<merged.jsonl> --out-dir <dir>`; `--out-dir` keeps the study's own artifacts
untouched. **Every script here runs its experiment at import** — there is no
"load it to see if it parses": importing `e3-messages.mjs` rewrites the
messages file, `analyze.mjs` the summary. Checking that they load after a
change to `background.js` (step 2 removed a helper `layouts.mjs` still named,
and the scripts stopped loading until 2026-09-25) means running
`node -e "import('./layouts.mjs')"` — the module every script that builds a
request imports, and the one that runs nothing.

**The L2-conv training trial (2026-10-02)** reused this directory to train
and score an engine on a layout rather than screen the pilot on it. Its
training data and resulting weights are not included in the public source.
What it added: `e4-bench.mjs` and `e3-typing.mjs` take `--model <tag>`;
`serve.sh` honours `OLLAMA_MODELS` (a private store, so trial models never
enter the owner's); `run-e3.sh` hides Vulkan on its CPU kinds and records
`/api/ps` mid-run; and the `l2conv-*` scripts — `l2conv-render.mjs` (renders
a training set through `layoutMessages`, importable: it renders only as the
entry module), `l2conv-render-check.mjs` (train bytes == served bytes),
`l2conv-create.sh` (a model into a private store through a private server),
`l2conv-judge-queue.mjs` / `l2conv-judge-merge.mjs` (the §8a blind
adjudication with hidden controls), `l2conv-agreement.mjs` (output agreement
between two run-files) and `l2conv-e3-summary.mjs` (E3 rows without L0 rows).
Two lessons from it: run one GPU job at a time on this machine (it went down
hard twice with training and serving together), and keep CPU-heavy scoring
off the cores a CPU timing run is pinned to — a 10,000-replicate bootstrap
running beside E3 put six requests over 5 s, and that run was discarded.

### 30. `store-screenshots.mjs` — the Chrome Web Store images (a tool, not a gate)

Re-creates every image in `docs/maintainers/store-assets/` from the REAL packaged
extension, setup page, worker, content script and popup, against the fake
Ollama `welcome-flow-test.mjs` uses and a made-up webmail page served as
`https://mail.example.com` inside the namespace. All text in the images is
invented; nothing under `test/harvested/` is read. It must own 11434, so:

```bash
unshare -rn sh -c 'ip link set lo up && node store-screenshots.mjs'   # ~1.5 min
```

Exits 2 if something already answers on 11434, and 1 if a step did not happen
or an image's size (read back from its PNG header) is wrong. Re-run it after
any change to what setup, the flash or the popup shows, before uploading a new
listing. The popup is opened as a tab (headless Chrome cannot click the
toolbar), with only `chrome.tabs.query` pointed at the mail tab.

### 31. `model-sentence-benchmark.mjs` — frozen corpus through the shipping engine

Runs the private frozen 1,590-record benchmark with `prepareSentenceRequest`
and `runSentenceEngine` from `background.js`: the production prompt, guards,
retry, 2,500-character context limit, and 4,750 ms delivery deadline. Requests
are sequential, with one unscored warmup. Use the same runtime for every arm.
Admission and engine inference share `researchModelPolicy`: canonical tags use
the harness's pin map unless `PROOFER_SKIP_DIGEST_CHECK` is nonempty. Unpinned
research models remain permitted. This opt-out never changes the extension's
pin; scoring-engine [6c] checks it with a synthetic one-row benchmark.

```bash
PROOFER_MODEL='<candidate>' PROOFER_OLLAMA_URL=http://127.0.0.1:11436 \
  node model-sentence-benchmark.mjs --out harvested/<study>/<candidate>.jsonl
```

`--benchmark <file>` selects another benchmark-schema input; `--limit 5` is a
smoke test only. Existing output files are refused. The output carries the
actual delivered text, engine payload and metadata, first-pass wire output,
retry details and wall-clock latency. Adjacent `.meta.json` and `.summary.json`
files record model details/digests, runtime version, GPU residency, input/source
hashes and completion counts. Infrastructure failures stop the run and retain
partial evidence; verify the final summary and expected row count.

The scorer-compatible `rewritten`/`guard` fields project **delivery**, including
no-ops on refusal. `raw` is the first response, not necessarily the successful
retry; inspect `meta` to study model behavior. Format errors remain distinct
from truncation and delivery failures. Novel delivered outputs still require
adjudication; a clean-text edit count is not a damage count.

This is an engine benchmark, not a browser typing/segmentation test. It retains
all frozen records, including 166 entries the small suites' one-sentence filter
would skip. It does not alter the production model pin or tune the prompt.

### 32. `os-install-check.mjs` — the out-of-box install on Windows and macOS

The mechanics of the acceptance test's install (`docs/maintainers/acceptance-test.md`)
on hosted operating systems, run by
`.github/workflows/os-install.yml` on GitHub's hosted `windows-latest` and
`macos-latest` runners. It installs the **packaged** extension
(`node tools/package.mjs` → `dist/proofer`, verified against its own
`SHA256SUMS.txt`) into Chrome for Testing with a fresh profile, a real Ollama
0.34.3 already running on 127.0.0.1:11434 with an **empty** model store, and
then clicks nothing until setup is done. Checks: install opens setup by itself;
setup finds Ollama without asking for it; with the engine missing, setup starts
the download itself, from ollama.com; the engine installed afterwards is the
pinned digest; setup reaches a final screen; the stored verdict is that
screen's, for the pinned engine and the Ollama that answered; the worker's
`SETUP_REPORT` and the file the screen's **Save test report** button saves both
hold the verdict and **no sentence, site, address or path** (every fixture's
text, fixed text, host and context, plus `localhost`, `127.0.0.1`, `11434`, the
home directory and the run's own paths); and, when the verdict is Ready, Turn on
and a typo typed into a plain textarea page is corrected and recorded as
`sentence-applied` by the pinned digest. The typo is typed at a person's pace
(6 s from the first key to the finished sentence, the speed check's own
`SETUP_FIRST_DELAY_MS`), because at robot speed a cold engine on a slow machine
misses the 5 s lease — `sentence-e2e-test.mjs`'s documented cold-load
sensitivity, which is not what this checks.

**A correct `too-slow` verdict passes** (exit 0): hosted CPU and virtual-GPU
resources can be insufficient, and the product should refuse such a machine. `unexpected` (a wrong answer on
that OS), `operational`, `interrupted` (the download stopped), a screen that
waits for a person (`install-needed`, `paused`, …) for 30 s, or no final screen
within 35 minutes (`--timeout-min`, `PROOFER_INSTALL_CHECK_TIMEOUT_MIN`) is
exit 1, as is any failed check. Exit 2 is a bad invocation: an unknown flag, no
package built, or Linux outside a private network namespace (it refuses to
drive an Ollama on 11434 while the machine has any non-loopback interface,
because there it is somebody's live service; `--allow-host-ollama` overrides
that for a disposable machine).

```bash
gh workflow run os-install.yml --ref main -f os=both
gh run list --workflow os-install.yml --limit 5
gh run download <run-id>                 # choose the intended run from the list
```

Historical hosted run, 2026-10-03: both jobs green, 15/15
checks each. Windows Server 2025, 2 CPUs: calibration chose 1 thread, every
case at the 4.75 s deadline, too-slow in 217 s. macOS 26 on a virtual M2 Pro:
Ollama put the engine on the (paravirtual) Metal GPU, so no calibration; 3
cases matched and 22 hit the deadline, too-slow in 161 s. The engine download
took ~10.5 s on both.

The workflow must be present on the public repository's default branch before
it can be dispatched. Use `--ref` to select the reviewed branch or tag, and
`-f os=windows` or `-f os=macos` to run one operating system. The public
repository uses `main`; no dedicated force-pushed trigger branch is needed.

The OS-install workflow runs only through `workflow_dispatch`; ordinary pushes
do not start it. Manual dispatch can select Windows, macOS or both.

Ollama comes from the official release assets for v0.34.3
(`ollama-windows-amd64.zip`, `ollama-darwin.tgz`),
each SHA-256 pinned in the workflow AND required to agree with the release's own
`sha256sum.txt`; never an install script. It is started in the same step as the
check (a background process is not guaranteed to outlive its step on Windows),
and its server log is uploaded with the rest. OS-install artifacts are uploaded
on success and failure and include the installation report, setup evidence,
screenshots, and Ollama server log. Artifacts (`--out`,
`PROOFER_INSTALL_CHECK_OUT`): `summary.json` (OS, Chrome, Ollama version,
engine before and after, the verdict's numbers and per-outcome counts, every
screen with its time since launch, download / verify / speed-check durations,
the typing result, every check), `verdict.json` (the stored
`setupQualification`: per-case outcome categories, no text), `setup-report.json`,
`setup-report-saved.json`, `NN-<screen>.png` for each screen reached (and a
`-progress` image every 5 minutes on a long one), `console.txt` and
`ollama-server.log`. Screens are logged inside the page by a MutationObserver,
so one shorter than a poll is still listed (marked `screenshot: false`); what
setup showed before the observer went in, a few hundred ms after it opened, is
not knowable, and `screensNote` says so.

Locally it must run inside a network namespace with a private Ollama owning
11434 — CPU-only, every GPU hidden, never the owner's service:

```bash
# a COPY of a store holding the published engine (or an empty dir), and where to write
export store=<model store copy> out=<artifacts dir>
unshare -rn bash -c 'ip link set lo up
  OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=$store OLLAMA_NOPRUNE=1 \
  CUDA_VISIBLE_DEVICES=-1 GGML_VK_VISIBLE_DEVICES=-1 OLLAMA_VULKAN=0 \
  taskset -c 0-7 /opt/ollama-v0.34.3/bin/ollama serve >ollama.log 2>&1 &
  sleep 3; cd test && taskset -c 8-23 node os-install-check.mjs --out $out'
```

The namespace has no network, so setup cannot download there: a seeded store
exercises the "already installed" path, an empty one the failed download.
**Validated 2026-10-02** (all CPU-only, Ollama 0.34.3, Chrome for Testing 145,
the published engine `f920607a…b320`): no Ollama at all → exit 1
(`ollama-not-running`, 30 s); empty store → setup POSTs `/api/pull` itself,
Ollama cannot reach `registry.ollama.ai`, `interrupted` in 0.5 s, exit 1, the
report still checked clean; seeded store, Ollama on 8 P-cores → **Ready** in
145 s (8 threads chosen over 16, warm p50 2,859 / p95 3,086 ms, the long-context
case dropped at 4,750 ms), the typo corrected 2.3 s after the last key, 17/17
checks, exit 0; and the workflow's own check step, verbatim under `bash
-eo pipefail`, with Ollama, Chrome and Node all on 4 cores (a hosted runner,
roughly) → **too-slow** in 190 s (all 25 cases expired at 4,750 ms), 14/14,
step exit 0 — and with an empty store, step exit 1 with the server log printed.
The Ollama install step was exercised on Linux bash against the real
`sha256sum.txt` and a fake asset (a wrong asset and a wrong release file both
refuse; an agreeing set extracts and finds the top-level binary). What no Linux
run can show is the Windows half of that step (`cygpath`, Windows' own
`tar.exe` reading the zip) and either OS's Chrome and Ollama: that is the
workflow's first run.

It does not replace the human run. Ollama's own installer and its dialogs, the
Get Ollama page, Pause and Resume, the badge, pinning, Brave and Edge, and every
"could a person stall here" judgment are the acceptance test's.

## When to Run What

Run the public source and browser groups for the relevant behavior change.
The corpus-based quality measurements below are optional maintainer research
that requires separately supplied data; a contributor without those inputs
should report that limitation, not claim the private checks passed. Real-model
checks also require the published engine and Ollama, as described above.


### Changing Slate INTENT, replay, or either capture

Run both mandatory captures and their boot verification with the network cut:

```bash
unshare -rn sh -c 'ip link set lo up && node sentence-slate-test.mjs'
unshare -rn sh -c 'ip link set lo up && node fixtures/verify.mjs'
```

Then the typing/provenance, popup, anchor/settings, flash and bench-selfcheck
gates plus offline `editor-recipe-probe.mjs --nesting-only`. Run the live
`PROOFER_EDITORS=Slate` row, full editors suite and `PROOFER_SLATE_LIVE=1` canary.
Pair idle/burst benches (including `none`) on live and **both** captures.
Historical runs used `results/slate-fix/bench-matrix.mjs` and its `before`/`after`
modes; that internal runner and its saved artifacts are not included in this
public snapshot. Use the included `editor-recipe-probe.mjs` and the
[documented `PROOFER_CONTENT` override](#configuration) to compare revisions.
Confirm zero lost characters after the fix, not merely zero reported
successful corrections.
Finally preload `jayafowler/proofer:v1-q4` with `num_ctx: 2048` and run
`node sentence-e2e-test.mjs`. Preserve old capture bytes when adding another
snapshot. Uncancelled callbacks outside stock desktop Slate remain a limitation;
source checks and two real builds cannot certify every site plugin or IME.

### Evaluating a replacement for the pinned model

Run in this order:

1. **Bake off the candidates** — `node model-bakeoff.mjs jayafowler/proofer:v1-q4 <candidate>`. No product edits needed; compare against the current pin and report the request options and model digests used
2. **Sweep the sampling on the frozen benchmark** (`finetune/teacher-pass.mjs`), the way the pilot was re-swept. Sampling parameters that work for one model may not work for another. The repeat_penalty finding (1.0 vs 1.1 = 42pp difference) was specific to qwen3.5's architecture
3. **Run meaning-drift-test.mjs on both** — core and holdout can be at parity while the candidate reWORDS what the user wrote. That gap is invisible to every other suite
4. **Then the sentence gates** — the owner bench on both holdouts, the context diagnostics and the live retry hazard gate. These quality checks may require private research inputs; the public [release checks](../docs/releasing.md#verify-the-candidate) do not replace them
5. **Only after the release gates, update the product pin** — publish and verify the replacement as described in `../docs/maintainers/publish-model.md`, then change `PINNED_MODEL` in `background.js`, including its digest, template and parameters. There is no `ollamaModel` setting. Verify setup fixtures and qualification against the new pin; existing installations must qualify again

For each sampling configuration, pass the same fixed JSONL file to
`finetune/teacher-pass.mjs --in <fixed.jsonl> --out <configuration.jsonl>` and
set `PROOFER_OPTIONS` to a JSON object of sampling overrides. Input rows contain
`uid`, `sentence`, and `context`. Use a separate output file per configuration;
do not tune on the validation holdout.

### Changing the prompt

The prompt is the sentence path's (`buildSentenceMessages`). Any byte change
turns `sentence-request-bytes-test.mjs` red; re-record it with `--write` in the
same commit, then run the sentence gates: contamination, the owner bench on
both holdouts, `sentence-context-test.mjs`, `sentence-live-test.mjs` across its
contexts, and the retry hazard gate. `prompt-lab.mjs`, `prompt-ab-test.mjs` and
`param-sweep.mjs` measured the removed manual prompt and are frozen.

A change to the prompt's LAYOUT — the order of the messages, or where the host
line, `prior_context` or the retry keep-list go — also changes what the runtime
can reuse between sentences, and so the latency on every machine the speed
check qualifies. Check it against the cache study (§29) first: anything that
varies must start at or after the last user message, and E1 shows directly how
many tokens a pair of consecutive requests re-reads. A new layout is a serving
change: it needs the [model-quality evaluation](#evaluating-a-replacement-for-the-pinned-model)
and [release checks](../docs/releasing.md#verify-the-candidate), on a model
trained for it.

### Changing `guardSentenceResult` or anything in the chain

```bash
node sentence-guard-test.mjs && node sentence-typo-recall-test.mjs   # they pull against each other
node sentence-evidence-test.mjs                                      # the two APIs still agree
node replay-log-guards.mjs <any exported log or harvested run>       # what the change does to real traffic
```

Then the owner-bench gate on **both** holdouts, against a baseline recorded on
the model that ships (§14). `sentence-evidence-test.mjs` is new to this list and
is not optional: the chain is now shared with the evidence mode, so a change
that reorders it or forgets to route a new guard through `fail()` breaks
first-failure-wins in a way the other two suites cannot see.

If the change touches `collapseResegmentations` or **which guards consult it**,
add the structural survey (§26) — the replays above are blind to it:

```bash
git show HEAD:background.js > /tmp/old-background.js
PROOFER_CORPUS_DIR=$PWD/harvested node reseg-wall-survey.mjs --compare /tmp/old-background.js
```

Read the **POLICY newly admitted** line, not the total. The 2026-08-15 round is
the calibration: 4,046 walled → 1,364 with 0 policy cases admitted, and 0
verdicts moved across all four recordings and all five hand-built corpora.

### Routine check (nothing changed, just want a health check)

```bash
node proofer-test.mjs && node proofer-holdout.mjs
```

### UI / content.js / popup changes

`sentence-typing-test.mjs` has 266 checks (258 before G1.5). Case [14b]
asks for worker consent even with a local exclusion and pins off/not-allowed,
no warmup and no rewrite on denial. Its mutant forces `sentenceAllowed = true`
in the consent reply handler. [14c] seeds an embedded frame's own origin in
`disabledSites` and pins active permission, a request and a correction under
worker approval; inserting `if (window !== window.top) return;` in
`handleFocusIn` breaks those assertions. [14d] pins zero storage reads, consent
messages and listeners before trusted editable focus (including synthetic-focus
and noneditable controls), then one listener across repeated focus and only the
`sentenceDebug` read. Adding `loadSettings();` at initialization breaks its
zero-listener assertion.

**[25]** passes a loopback fake Ollama's truncated reply through the shipping
engine and feeds that response into the content harness. Trusted typing pins
`worker:truncated` once, no `guard:truncated`, unchanged failed text, the next
sentence's successful correction, and no resend past the advanced watermark.
Restoring the engine's truncated `refused` response breaks the engine-error
and counter assertions. No live model or content implementation change is
needed for this fixture.

**[10d]** loads shipping content in normal/canvas top and child frames, serving
canvas hostnames with intercepted local HTML. Real focus and blur establish a
remembered textarea. Captured runtime listeners feed a first-response bus: it
records production timers, releases them deterministically, and accepts delayed
callbacks only if the listener returned `true`. Assertions pin canvas-child
silence, the remembered textarea winner, a standalone canvas top's 150 ms
refusal, and a focused supported child's 0 ms priority over that fallback.
Mutants replace the canvas helper call with synchronous `sendResponse(report)`
(wrong winner/timing) or remove the helper's `return true` (lost async reports).

**[10e]** controls `Date.now` around real status history and dispatches through
the captured listener: 29,999 ms schedules 60 ms; 30,000 ms, two minutes and five
minutes all schedule 120 ms, before the empty top's 150 ms. Both dispatch orders
of the tied older frames are accepted; neither age must win. Removing the
`Math.min` cap breaks the older-history delays and priority assertions. Existing
[10]/[10b–c] vocabulary/cause cases remain. These controlled tests complement
inspection of the actual unpacked popup on the same frame arrangements.

The live `sentence-e2e-test.mjs` case **embedded editor inherits top-level
consent** serves the parent and editor at different loopback origins. For each
switch-off list, it asserts a real correction despite the frame's exclusion,
revocation without reload, and refusal after reopening the disabled parent.
It also opens the real popup document in a background tab, preserving the
editing tab as active, and checks running versus parent-disabled status. The
same subframe-return mutant breaks the allowed-parent correction and status
assertions. This suite has 35 checks (13 before G2.2).

Case [24]
drives real keystrokes in two fresh pages with equal frozen wall clocks: their
first request IDs have distinct 128-bit namespaces, cancellation and apply/undo
outcomes retain the original ID, and reload starts counter 1 in a fresh
namespace. Its one-line mutant restores the counter-plus-wall-clock ID in
`fireSentenceRequest`, turning the isolation and namespace assertions red.

```bash
node sentence-typing-test.mjs && node flash-highlight-probe.mjs      # content.js
node popup-activation-test.mjs && node popup-views-test.mjs          # the popup
node sentence-e2e-test.mjs                                           # the real extension, real model
```

The manual path's `panel-controls-test.mjs` and `interaction-test.mjs` went
with it on 2026-09-24; see §5–§6 for where their surviving checks live.

### Adding an editor to the transport registry

`SN_TRANSPORTS` in `content.js` is a claim about a real editor's document
model, and `sentence-editors-test.mjs` is its evidence. Add the row to both in
the same commit — a registry entry without a suite row is an assertion nobody
checked, and the failure it hides is silent in both directions.

Measure **first**, with `editor-recipe-probe.mjs` (§19): both recipes, both
caret policies, idle *and* burst, with the `none` control. A row without a probe
measurement is an assertion nobody checked from the other direction.

```bash
node editor-recipe-probe.mjs                         # the candidate matrix
node editor-recipe-probe.mjs --nesting-only          # the editable-island matrix
node sentence-editors-test.mjs                       # 302 checks on current sites; 7 targets + 7 source checks
PROOFER_EDITORS=Quill node sentence-editors-test.mjs # one row, while iterating
node sentence-typing-test.mjs                        # [10b], the routing table
```

The suite's [0b] source regression also runs alone, offline:

```bash
unshare -rn sh -c 'ip link set lo up && node sentence-editors-test.mjs --source-test'
PROOFER_CONTENT=/tmp/candidate.js node sentence-editors-test.mjs --source-probe
```

`--source-test` runs seven checks, including a child with Quill's recipe changed
to literal `intent` in an ordinary temporary file, and the missing-path failure
control. The child mode `--source-probe` runs only the two browser/VM adapter
checks. Both use the same injection helper as real sessions. This local
Quill-shaped editable proves which source reached Chrome; the normal suite
still needs the internet and real editor models, and retains exit 77 for skips.

**Registered: Slate, ProseMirror (and TipTap), Quill, Lexical, Draft, Trix.**
Slate now requires its replacement event to be cancelled. The live row measures
that fact on every dispatched write; an uncancelled event must produce the exact
safe refusal, unchanged user text and no misplaced/lost typing. All nine
scenarios remain, including a reverse-direction write from user-entered corrected
text when a refused forward write cannot arm an undo. The old accepting capture
remains the independent landing control. A targeted live Slate run currently
executes 68 checks, but exits 77 for the deliberately filtered-out other rows;
the full live run covers all seven targets and passes 302 checks on the current
sites. Counts depend on observed transport acceptance; every executed assertion
and the final count are printed.
Draft and Trix were added 2026-08-14 on the mutation recipe with
`caret: "checked"` — 16/16 idle and 16/16 burst each, zero damage, and
`mutation-reimpose` measured *identically*, so the two extra timers buy nothing
here. That is a measurement, not a default.

**CKEditor 5 was measured and refused**, recorded so nobody re-runs it. It is
the only candidate that honours the intent dispatch (8/8 idle) and it scrambles
the user's own text 3/8 mid-burst, because it honours the **replay** too and
applies it at its own model selection rather than at the DOM caret the splice
just restored — the swallowed character lands at the end of the document,
`...shipped it out to everyone.h`. Nothing is lost and the sentence is still
wrong. A `caret` field cannot buy it back (the caret restore is not what is
misrouted), and MUTATION is not the way out: CKEditor's renderer reverts the
`execCommand` outright, 0/8 in both phases, user text intact.

Four method rules, each of which produced a wrong answer when broken:

1. **Jitter the inter-keystroke delay** (22–130 ms). A fixed cadence hides
   corruption completely — at one spacing 10/10 broken, at the next 0/10.
2. **Report text survival and caret correctness separately.** Conflating them
   into one boolean produced a false 0/2 for Lexical and sent the diagnosis to a
   harness artifact that did not exist.
3. **Split idle firing from burst firing.** The keystroke-deletion finding is
   invisible in the idle column (12/12 clean there, and 5–10 of 14 corrupted in
   the burst column).
4. **Carry the old Slate capture as a positive control.** The new capture and
   live site can correctly reject INTENT. Pair them with the preserved accepting
   build, and retain the no-write burst control, so a clean refusal never stands
   in for evidence that accepted writes still work.

Harness facts, bought the hard way — the suite encodes all of these, so nobody
has to rediscover them:

| Editor | Selector | Quirk |
|---|---|---|
| Slate | `[data-slate-editor="true"]` | — |
| ProseMirror | `.ProseMirror` | the editor sits **below the fold**; scroll it into view or the click lands on the page and types nothing |
| TipTap | `.tiptap.ProseMirror` | drive it **top-level**, not as an embedded iframe |
| Quill | `.ql-editor` | three instances; index 0 sits at `x=-1028`. Pick the in-view one, then assert `document.activeElement` is inside it |
| Lexical | `[data-lexical-editor]` | needs **two** Ctrl+A/Backspace passes — the first leaves 844 characters, which silently confounds any caret arithmetic measured against it |
| Draft | `.public-DraftEditor-content` | wraps each block **twice**, so its text tail is `"\n\n"`; strip *all* trailing synthesised newlines or a correction that landed perfectly fails an `endsWith` |
| Trix | `trix-editor` | does not focus from a real click at its own coordinates (`activeElement` stays on `BODY`), so focus is set on the element and the keystrokes stay real; does not bind **Ctrl+B** in the build its homepage serves, so the bold-run refusal needs `editor.activateAttribute("bold")`; and emits the space before a bold run as an **NBSP** about 1 run in 5, which sent that branch to SKIP at random until NBSP was folded |
| CKEditor 5 | `.ck-editor__editable` | **refused, not certified** — see above. Use the docs *example* page; `ckeditor.com/ckeditor-5/demo/` serves no `.ck-editor__editable` at all |

### claude.ai cannot be certified headless

It needs a login, so it is covered by the `.ProseMirror` family row plus a
manual checklist run once and recorded as *last validated on `<date>`, Chrome
`<version>`*:

1. Type three sentences with one typo each; confirm each correction lands and
   the following keystrokes are at the right offset.
2. Correct a sentence containing an @-mention and one containing an attachment
   chip — expect a refusal, not a damaged pill.
3. Shift+Enter for a line break, then a correction: the break must not move,
   collapse or duplicate.
4. Send with Enter and read the **sent message** — the strongest available
   evidence that the app's own state, not just the DOM, took the correction.
5. Undo once after a correction: it removes the correction, not prior typing.
6. Trigger a correction and immediately open an `@` menu or move the caret — the
   result must be refused, and must not close the menu or move the caret.
7. DevTools console open throughout; any new page exception coincident with a
   write fails the run.
8. IME composition, if anyone can run one. If not, record that IME was not
   certified.

## Current Production Config

The live-editing product uses `background.js` as its authority:

```
Model: jayafowler/proofer:v1-q4
Digest: f920607a347881f5a3482ec8a9d6ea621d9a6f7ea7c27b7372e31d8e4f54b320
Parameters: temperature 0.1, top_k 20, top_p 0.8, num_ctx 2048, repeat_penalty 1
Prompt: buildSentenceMessages(), with the request shapes pinned in test/golden/
Transport: POST /api/chat, JSON output, one guarded retry where permitted
Activation: passing setup qualification plus deliberate Turn on; per-site exclusions
```

Setup checks the model digest, template and parameters. The extension has no
model selector; research overrides apply only to harnesses. CPU thread choices
come from the setup calibration. See `../docs/maintainers/publish-model.md` for pin
provenance and §27d for setup checks. The historical model scores below are
preserved as evidence of those runs, not scores for this published pin.

## Historical production config and prompt studies (August 2026)

The following snapshot and measurements describe the older implementation.
As of 2026-08-13, `background.js` used:

```
Model: qwen3.5:9b
Options: { temperature: 0.1, top_p: 0.8, top_k: 20, repeat_penalty: 1.0, num_ctx: dynamic (up to 16384) }
Prompt: buildSystemPrompt() + PROOFREAD_FEW_SHOT, via /api/chat
Transport: POST /api/chat with a messages array (was /api/generate)
```

Measured: **core 103–104/105 (98.5% ± 0.55), holdout 55/55 (100.0%, sd 0),
334ms median, 8.6GB VRAM.** At that time `setup.sh` pulled this model; it had pulled LFM2.5
while the extension asked for qwen, so a documented fresh install ended with a
model that was not installed.

The previous default, `hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M`, measured **core
102/105 (97.1%, sd 0), holdout 54/55 (98.2%, sd 0), 234ms, 2.1GB VRAM** and was
perfectly deterministic. It was the small-GPU alternative in that version, and
most of this document's prompt research was done against it — quote it as
history, not as the shipping configuration.

The switch was decided on 200 harvested real Discord sentences rather than the
synthetic corpus, which pointed the other way. Of 33 genuine errors qwen
fixed-and-applied 61% against LFM's 36%, with meaning-affecting damage on clean
sentences at 1.8% against 3.6%. LFM's characteristic failure — landing the typo
*and* damaging a neighbouring word — scores as a miss rather than as harm in
every synthetic suite here, which is why they could not see it.

`lib/harness.mjs` mirrors the **sampling options** as harness defaults (it fixes
`num_ctx` at 2048, since every test case is one short sentence). Change one,
change the other. The model name, the prompt and the few-shot messages are *not*
duplicated — `DEFAULT_MODEL` reads the model out of `background.js`, and the
suites build the request with `background.js`'s own `prepareSentenceRequest`
(the manual path's `extractSystemPrompt()` / `extractFewShot()` went with it on
2026-09-24), so the suites always test what ships.

### The page-context line is part of the request shape

Production appends a page-context line to the **system** prompt on every
request. The suites now build the request through `background.js` itself, so
they cannot leave it out; on the manual path `extractSystemPrompt()` had to
append it by hand. This is not cosmetic:

The line originally prefixed the **user** turn, and no suite sent it. Both
models copied it straight into the rewrite — most reliably on short inputs,
where the prefix is the bulk of the message. Measured with the line in the user
turn: **core 38.1%** (LFM2.5-2.6B) and **56%** on the first 25 (qwen3.5:9b),
against 97.1% for the same prompt without it. Real usage was hitting that,
while the suites reported 97.1%.

The rule this leaves behind: whatever wraps the text in production must be in
the harness. A suite that measures a request shape the extension never sends
measures nothing. An explicit `PROOFER_PROMPT` / `PROOFER_VARIANT_FILE` skips
the append — that is the caller saying "measure exactly this".

The winning variant as the search produced it is kept at
`../docs/lfm25-champion-prompt.json` (name `liquid-native-chat-fewshot-json`,
with its hypothesis). It is a valid `--prompts` input, so the result can be
replayed directly:

```bash
node prompt-lab.mjs --prompts ../docs/lfm25-champion-prompt.json
```

That file expresses the six demonstrations as **injected ChatML turns** in a
`userTemplate`, which is how they were searched. `background.js` ships the same
demonstrations as a real messages array instead — measured identical, and
portable across model templates (see below). Treat the JSON as the provenance
record, not as something to copy into production.

### Why /api/chat

Few-shot demonstrations are the single biggest quality lever for this model
(+6.6pp core, +7.3pp holdout). Expressing them requires real user/assistant
turns. Injecting raw ChatML tokens into `/api/generate` works but only for
models that happen to use ChatML; `/api/chat` with a messages array lets Ollama
apply whatever template the model ships with. Both were measured and scored
**identically** on a paired single run each (LFM2.5 97.1/98.2, qwen3.5
99.0/100.0), so the portable one won. Equal on n=1 only rules out a large
transport effect; it does not establish exact parity.

Few-shot is sent **only on the plain proofreading path**. The partial-selection
path (`<context>`/`<excerpt>` tags) and the tone-rewrite path are different
tasks that were not measured with these examples, so they get the system prompt
alone. (Both paths, and `path-smoke-test.mjs` which covered them, were removed
on 2026-09-24.)

### num_ctx is a load-time parameter — bucket it

`num_ctx` is not a sampling knob. Ollama sizes the KV cache when it loads the
runner, so **every distinct value evicts the model and reloads it** (~1.1s for
LFM2.5). `background.js` used to size it exactly per request, and since text
length varies with every edit, almost every rewrite paid that reload:

```
                          per request   reloads (8 requests)
exact per request (old)        1302ms   8
bucketed to 2048/4096/…         245ms   0
```

**5.3x**, measured on eight sentences of realistic mixed length. This never
showed up in the suites because they pin `num_ctx` at 2048 for every case,
which is exactly the warm path. `keep_alive` was raised from `1m` to Ollama's
`5m` default for the same reason: a normal pause in writing was unloading the
model between rewrites.

`CTX_BUCKETS` went with the manual path on 2026-09-24; the sentence path pins
`num_ctx` at 2048, which is this finding taken to its end.

### Reducing meaning drift: what did not work

All measured on `meaning-drift-test.mjs` against LFM2.5-2.6B, baseline 35/40.

| Attempt | Drift | Core | Verdict |
|---|---|---|---|
| System clause: "Keep the user's own wording…" | 35/40 | 97.1% | No gain; holdout fell to 96.4% |
| +2 demos (abbreviation survives, function word repaired) | 35-36/40 | 97.1% | Inside ±1 noise |
| Same 2 demos, compact demo JSON | **37/40** | 96.2% | Rejected — see below |
| `temperature` 0.0 / 0.1 / 0.3 | 35/40 | — | Completely flat |
| Reject rewrites with low word retention vs input | — | — | No usable threshold |

Two things worth knowing:

**Demo JSON spacing changes behaviour.** Writing the demonstrations as
`{"rewritten":"…"}` instead of `{"rewritten": "…"}` scored 37/40 with sd 0,
against 35-36/40 for the shipped spacing. It is not free: it costs a core case
by breaking persona — `"Please review the attached document."` came back as
*"I don't have the ability to access or review attached documents."* A 2.6B
model is sensitive to demonstration formatting; measure any demo edit at the
exact spacing that ships, or the result will not transfer.

**Word retention can't gate output.** A rewrite that shares few words with its
input looks like a runaway, but legitimate heavy-typo fixes bottom out at 17-20%
retention (`"Pleese chek youre email adress."` → `"Please check your email
address."` keeps nothing) — the same score as the model reciting a
demonstration. The distributions overlap completely. The only guard that
survived is the length cap in `background.js`: 0 false positives over 145 real
inputs, and it catches the extreme case where the model emits every
demonstration at once.

The remaining gap is the model. LFM2.5-2.6B expands jargon and drops the
occasional intensifier; qwen3.5:9b does not. Nothing at the prompt or sampling
layer moved it.

### Key findings from parameter sweep

| Parameter | Spread | Best | Notes |
|-----------|--------|------|-------|
| repeat_penalty | **42pp** | **1.0** | Disabling it was the single biggest win. With 1.1, the model penalizes tokens from the system prompt examples, which are exactly the tokens it needs to output for corrections. |
| temperature | 4pp | 0.3 | Marginal. 0.1 is fine. |
| top_p | 4pp | 0.8 | Default is already optimal. |
| tfs_z | 3pp | 0.8 | Marginal difference vs default 1.0. |
| top_k | 2pp | 20 | Default is already optimal. |

### Historical test results at that config

| Suite | Pass | Pass+Partial |
|-------|------|-------------|
| proofer-test.mjs (105) | 90.5% | 91.4% |
| proofer-holdout.mjs (55) | 87.3% | 90.9% |
| param-sweep.mjs (100) | 84.0% | 85.0% |

## Prompting LFM2.5-2.6B: research findings (2026-08-05)

From Liquid AI's own documentation and the small-model prompting literature,
cross-checked against this machine.

### LFM2.5-2.6B is a mandatory reasoning model

Liquid's model card calls it "a pure reasoning model that always thinks before
it answers", with `<think>` hardcoded in `chat_template.jinja` and no off
switch. Consequences, all verified locally:

- **`think: false` is a no-op.** The model emits `<think>…</think>` anyway, and
  Ollama returns `thinking: null` because its converted template lacks the
  markers — so the reasoning block lands in `.response` as raw text. Anything
  reading non-JSON output must strip it (`lib/scoring.mjs` does).
- **`format: "json"` structurally suppresses the reasoning.** Constrained
  decoding forces the object immediately: measured 15 output tokens in JSON mode
  versus 900–1300 in raw mode, and 232ms versus 1170–1811ms. Every score in this
  file was measured under that suppression.
- Restoring reasoning is **not** obviously good: it costs 4–8x latency, which
  erases the model's entire speed advantage over qwen3.5:9b (raw 924ms+ vs qwen
  363ms).

### Ollama's template drops the BOS token without a system prompt

```
TEMPLATE "{{ if .System }}<|startoftext|><|im_start|>system ..."
```

`<|startoftext|>` is emitted **only** inside the `{{ if .System }}` branch, so a
variant with an empty system prompt silently loses BOS and is not comparable.
Liquid's official Jinja template emits it unconditionally. Always send a
non-empty system prompt in an A/B on Ollama.

### Sampling parameters are closed

Liquid's official settings for this model (temperature 0.1, top_k 50,
repeat_penalty 1.1, min_p 0.15, no top_p) scored **89.5% vs our 90.5%** on the
core suite — one case worse. Combined with the 2pp spread across the 16-config
sweep, sampling is not a lever for this task. `min_p`, which the sweep never
tested, does not change that.

### What the literature says (and what we reproduced)

| Finding | Evidence | Our result |
|---|---|---|
| Constrained JSON decoding degrades small models ("constraint tax") | 19.7%→11.0% answer accuracy at 0.5–1.7B scale | Testable now via `format: "raw"` |
| Negated constraints fail below ~3B | Negation handling vs size, Spearman ρ=0.867 | Positive-scope rewrite scored 92.4% vs production's 89.5% |
| Prompt accuracy decays with instruction count/length | −8pp per log-token; accuracy = (per-instruction accuracy)^n | Our 279→396→449→639 char series fell 75.4→71.5→72.3→68.5% |
| Demonstrations beat prose instructions | Min et al. 2022: demos convey format/label space, not content | Listing confusable pairs hurt −3.1pp; showing them helped +6.9pp |
| Few-shot saturates at 4–8 examples | GEC literature | 5-shot 83.1% → 8-shot 83.8% for +151 chars |
| Role framing beats terse imperatives for GEC | Largest GEC prompting study | 83-char "role-verb" prompt: 0 misses but 6 false positives, 79.0% |

### Broad prompt sample: 30 from-scratch designs (2026-08-05)

Six design philosophies × 5 prompts, scored on the 105-case core suite under the
corrected rubric. Baseline (production prompt) = 89.5%; qwen3.5:9b = 96.2%.

| Variant | Pass | Miss | FP | Median | Format | Turn |
|---|---|---|---|---|---|---|
| **liquid-native-chat-fewshot-json** | **96.2%** | 1 | 1 | 233ms | json | user |
| role-and-procedure-copy-editor | 94.3% | 3 | 0 | 235ms | json | system |
| recall-then-precision-earned-clean-exit | 94.3% | 2 | 0 | 232ms | json | system |
| liquid-native-card-persona | 94.3% | 2 | 0 | 229ms | json | system |
| few-shot-architecture-json-contract-6 | 94.3% | 2 | 1 | 234ms | json | system |
| few-shot-architecture-simulated-turns-8 | 94.3% | 2 | 0 | 248ms | json | user |
| production | 89.5% | 9 | 0 | 261ms | json | system |
| minimal-imperative-role-verb (83ch) | 79.0% | 0 | 6 | 259ms | json | system |
| few-shot-architecture-arrow-mixed-8 | 63.8% | 4 | 6 | 244ms | json | system |

Two literature predictions did **not** replicate here:

- **The "constraint tax" did not appear.** Dropping `format: "json"` was the
  highest-value predicted experiment (published 19.7%→11.0% degradation at this
  model scale). Measured: json mean 82.5% / best 96.2% / 240ms versus raw mean
  81.5% / best 93.3% / **1128ms**. Raw variants genuinely correct better (several
  hit 0 missed AND 0 false positives) but 5–20 of their 105 responses per variant
  fail to yield a usable answer, and unsuppressed reasoning makes them 4.7x
  slower — slower than qwen3.5:9b, which erases the entire reason to use LFM2.5.
- **User-turn placement beat the system prompt**, mean 86.5% vs 80.7%, despite
  Liquid's documentation saying instructions belong in the system role. The
  winner puts a short system role in place (which is required — Ollama's template
  only emits BOS when the system prompt is non-empty) and the task instruction
  plus few-shot turns in the user field.

The winner uses Liquid's documented multi-turn few-shot mechanism, expressed
through `/api/generate` by injecting ChatML turns into the user field:

```
system: You are a helpful assistant trained by Liquid AI.
        Correct the errors in the user's text and copy everything else through
        exactly as written. Return the result as a JSON object with a single
        field named rewritten.
user:   The techncian replaced the faulty sensor.<|im_end|>
        <|im_start|>assistant
        {"rewritten": "The technician replaced the faulty sensor."}<|im_end|>
        ... 5 more turns, including two clean sentences returned unchanged ...
        <|im_start|>user
        {{text}}
```

Its examples were screened with `lib/contamination.mjs`: **0 of 105 core cases
have their required substitution pre-taught.** The examples demonstrate skills
(dedupe a doubled word, insert a missing article, add a possessive, return clean
text unchanged) rather than answers.

## Rubric Defects Found and Fixed (2026-08-05)

A multi-agent audit of the corpora and rubric found defects that were distorting
every measurement in this file. All were verified by hand before fixing.

| Defect | Effect | Fix |
|---|---|---|
| `proofer-holdout.mjs` "She was in favor of the new rule." was categorised `word-boundary` with `expected === input` | **Mathematically unpassable**: unchanged scored MISSED_ERROR, any change scored BAD_CORRECTION (`inputDist` 0 makes the partial band `corrDist < 0` unreachable). Capped the holdout at 54/55 = 98.2% — which is exactly what qwen had been "failing" to beat | Recategorised as `wrong-word-clean` |
| `evaluate()` treated a null (unparseable JSON / missing key) as "made no changes" | A model that **broke the output contract on clean text was scored PASS** | Null is now its own `CONTRACT_FAIL` verdict, never a pass |
| `prompt-lab.mjs` McNemar used PASS‖PARTIAL while the headline `passRate` used PASS-only | Reported effect sizes and their p-values measured **different metrics** | Both now use PASS |
| Corpora contradicted each other on contraction style: core #18 demands `donot → do not` (expansion), holdout #11 demands `mustnt → mustn't` (contraction) | A model was failed on one convention or the other no matter what it did | `evaluate()` treats contraction-style-only differences as equivalent (`strictContractions: true` restores old behaviour) |
| `isContractionStyleOnly` expanded `it's` to "it is" only | Missed "it has" readings; under-counted the artifact rate roughly 2x | Ambiguous `'s`/`'d` clitics now expand to a set of readings and match on intersection |
| Three divergent copies of the rubric (`proofer-test.mjs`, `proofer-holdout.mjs`, `lib/scoring.mjs`) | `proofer-test.mjs` did not recognise `wrong-word-clean`, so adding such a case to it would have created a second unpassable case | All suites now import from `lib/scoring.mjs` |
| Four cases had a wrong or over-specified `expected` | Both models failed on cases where they were right | `accepted: [...]` alternatives added |

Cases may now carry `accepted: ["..."]` listing equally-valid outputs. Use it
whenever more than one correction is legitimate.

### Blind adjudication of the failure set

All 27 failing cases from the 2026-08-05 bakeoff were shuffled, stripped of
model identity, and scored by four independent judges with different lenses
(strict-editor, reader-impact, minimal-edit, devil's-advocate). Majority rule:

| Model | Scored failures | Rubric artifacts | Genuine failures |
|---|---|---|---|
| qwen3.5:9b | 7 | 6 | **1** |
| LFM2.5-2.6B | 20 | 8 | **12** |

**52% of all recorded failures were rubric artifacts.** The corpus was mildly
unfair to LFM2.5 — the fixes were worth +3.8pp core / +1.8pp holdout to it
versus +1.9pp / 0 for qwen — but correcting it does not rescue the model. It
makes qwen look near-perfect. LFM2.5's 12 genuine failures are all knowledge
errors (`its/it's`, `principle/principal`, `excepted/accepted`, `Who's/whose`,
`discrete/discreet`, `setup`, `documnt`, `not not`), matching Liquid's own model
card: "not recommended for knowledge-heavy tasks".

## Model Bakeoff Results

2026-08-05, Ollama 0.20.6, production sampling params for both models
(`model-bakeoff.mjs qwen3.5:9b hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M`):

### Final head-to-head (2026-08-05, corrected rubric, best prompt)

All figures below are over **n=5 independent runs** per model per suite
(20 suite passes, 3,200 calls). Earlier revisions of this file quoted single
runs as point values, which hid the fact that qwen's core score is a
distribution, not a number.

| Model | Size | VRAM | Core (105) | Holdout (55) | Median | tok/s |
|---|---|---|---|---|---|---|
| qwen3.5:9b | 6.6GB | 8.6GB | **103–104/105** (98.5% ± 0.55) | **55/55** (100.0%, sd 0) | 416ms | 106.5 |
| LFM2.5-2.6B (Q4_K_M) | 1.7GB | 2.1GB | **102/105** (97.1%, sd 0) | **54/55** (98.2%, sd 0) | **253ms** | **160.6** |

**The gap is ~2.4 cases out of 160** — 1–2 on core, exactly 1 on holdout. The
per-run ranges are **disjoint on both suites**, so the difference is consistent
rather than noise: LFM2.5 never exceeded 102 on core across 5 runs, qwen never
dropped below 103.

LFM2.5 was **perfectly deterministic** (sd 0.00 on all 10 of its runs). All the
observed variance was qwen's, and only on the core suite. Reproduce with
`./repeat-study.sh 5 && node analyze-repeats.mjs`.

LFM2.5 is 1.6x faster, 4x smaller on disk, and uses 4x less VRAM.

How it got there — every step measured on the same suites. The two intermediate
rows are **single runs** (n=1), recorded before the variance study existed; only
the final row has been repeated. Read them as the trajectory, not as figures
precise to one case:

| Stage | LFM2.5 core / holdout | qwen core / holdout | Gap | n |
|---|---|---|---|---|
| Original rubric, production prompt | 86.7% / 89.1% | 94.3% / 98.2% | ~20 cases | 1 |
| + rubric defects fixed | 90.5% / 90.9% | 96.2% / 98.2% | ~14 cases | 1 |
| + champion prompt | 97.1% / 98.2% | 98.5% / 100.0% | **~2.4 cases** | 5 |

Roughly a third of the closure came from fixing the measurement and two thirds
from the prompt. **The champion prompt improves both models** (qwen gained too),
so it is worth adopting regardless of which model ships.

LFM2.5's 4 remaining failures: one hallucinated word (`the ysee` → "the user
see" — qwen makes the same error), one missed homophone (`Who's book` →
`Whose`), one false positive on clean text (`Thanks` → `Thank you`), and one
dropped word (`shows uplate` → "shows up", losing "late").

### Earlier prompt-tuning attempt (superseded)

The first four tuning rounds plateaued at 88.6% / 87.3% and concluded the gap
was a capability limit. That conclusion was wrong, and the two reasons are
worth recording:

1. **The rubric was measuring badly** — 52% of failures were artifacts (see
   below), and the defects fell disproportionately on LFM2.5.
2. **The tuning corpus was built from the model's own failures**, making it 28%
   homophones against a real-suite rate far lower. An 8.4pp gain at p=0.027 on
   that corpus transferred to +1 case in 160. The corpus that finally worked
   was `proofer-test.mjs` itself — the real error distribution.

qwen3.5:9b scored above its 90.5%/87.3% record from March — same prompt and
params, so that's Ollama-version drift or run variance, not a change of ours.

### LFM2.5-2.6B parameter sweep (2026-08-05)

`param-sweep.mjs` against LFM2.5-2.6B: **84.0%–86.0% across all 16 configs, a
2pp total spread.** The model is essentially insensitive to sampling params,
and the production values are already at the top of that range.

| Parameter | Spread | Best | vs qwen3.5 |
|---|---|---|---|
| repeat_penalty | **0pp** | 1.0 (tie) | 42pp on qwen — the finding does not transfer |
| top_k | 1pp | 20 | same as qwen |
| top_p | 1pp | 0.5 | qwen: 0.8 |
| tfs_z | 1pp | 1.0 | qwen: 0.8 |
| temperature | 0pp | any | 4pp on qwen |

False positives were **zero in every config** — LFM2.5 never corrupts clean
text; it only under-corrects. That's why the tuning effort moved to the prompt:
there's no accuracy hiding in the sampling params.

### LFM2.5-2.6B prompt tuning (2026-08-05)

Twelve variants over the 130-case lab corpus. Baseline (production prompt) is
75.4%. Nothing beat it significantly; two variants regressed significantly.

| Variant | Chars | Pass | Missed | FalsePos | Bad | McNemar vs production |
|---|---|---|---|---|---|---|
| v5-fewshot | 540 | 78.5% | 13 | 0 | 15 | +4 net, p=0.45 |
| v11-terse-assertive | 124 | 76.9% | 6 | 0 | 23 | +3 net, p=0.51 |
| v6-assertive | 265 | 76.2% | 15 | 0 | 16 | +1 net, p=1.00 |
| production | 279 | 75.4% | 18 | 1 | 13 | — |
| v9-short | 126 | 75.4% | 14 | 0 | 18 | 0 net, p=1.00 |
| v3-combined | 639 | 68.5% | 26 | 0 | 15 | **-9 net, p=0.035** |
| v8-minimal | 60 | 67.7% | 4 | 8 | 29 | -9 net, p=0.09 |
| v10-short-safe | 143 | 66.9% | 24 | 2 | 17 | **-11 net, p=0.007** |

What the experiment established:

- **Naming error categories in the prompt makes things worse, not better.**
  Adding a homophone list (its/it's, their/they're, …) *raised* misses from 18
  to 26. Same for a word-boundary clause. The abstract instruction competes with
  the task rather than focusing it.
- **Concrete examples beat abstract instructions.** The only two directions that
  helped were few-shot examples (word-boundary 65% → 78%, typo +10pp) and terse
  assertive framing (misses 18 → 6, no new false positives).
- **The precision/recall dial is the "minimum changes" language.** Strip it
  entirely (v8, 60 chars) and misses collapse to 4 — but false positives go 1 → 8
  and bad corrections 13 → 29. Every variant lands somewhere on that frontier;
  none escapes it.
- Prompt length per se is not the variable. v10 at 143 chars (66.9%) is worse
  than v7 at 625 (73.1%); v5 at 540 beat both. Content, not budget.

Rounds 3–4 then broke the homophone ceiling that rounds 1–2 had run into
(51–59% for every variant, including a few-shot prompt containing *one*
homophone example). The fix was more examples of the weak category:

| Variant | Examples | Pass | Homophone | McNemar |
|---|---|---|---|---|
| **v16-homophone-max** | 8 homophone + 1 clean | **83.8%** | **76%** (+22pp) | **+11 net, p=0.027** |
| v15-homophone-plus | 5 homophone + 2 other + 1 clean | 82.3% | 70% (+16pp) | +9 net, p=0.049 |
| v13-fewshot-homophone | 5 homophone + 1 clean | 82.3% | 73% (+19pp) | +9 net, p=0.064 |
| v12-fewshot-terse | 4 mixed + 1 clean | 79.2% | 54% (+0) | +5 net, p=0.23 |
| production | none | 75.4% | 54% | — |

- **Demonstrate, don't enumerate.** Listing the confusable pairs as an
  instruction (v1) made misses *worse* (18 → 26) and moved homophone accuracy
  not at all. Showing eight corrected examples moved it 22pp. Same information,
  opposite result.
- **Concentrate examples on the weak category.** v14 spread its examples across
  homophones, boundaries and missing words and scored 81.5%; v16 spent them all
  on homophones and scored 83.8%.
- **No precision cost.** Every winning variant held clean text at 100% and
  wrong-word-clean at 100% (production leaks one false positive). The gains were
  not bought with over-correction.
- Idiom cases (`should of`, `mute point`) went 75% → 50% on every few-shot
  variant, but that is 4 cases total — noise, not signal.

### The winning prompt did not transfer (2026-08-05)

v16 was validated on the real suites with
`PROOFER_PROMPT_FILE=... node model-bakeoff.mjs qwen3.5:9b <lfm>`:

| Model | Prompt | Core (105) | Holdout (55) | Net vs production |
|---|---|---|---|---|
| LFM2.5-2.6B | production | 86.7% | 89.1% | — |
| LFM2.5-2.6B | **v16** | 88.6% | 87.3% | **+1 case in 160** |
| qwen3.5:9b | production | 94.3% | 98.2% | — |
| qwen3.5:9b | **v16** | 93.3% | 98.2% | **−1 case in 160** |

Each row is a single run, and ±1 case is inside qwen's measured run-to-run
swing (sd 0.55 on core) — so the sign of those net columns is not established,
only that the effect is small.

An **8.4pp gain at p=0.027 on the tuning corpus became ≤1 case out of 160 on
the real suites.** The effect was real and reproducible — it just didn't
matter. Homophones are 37 of 130 cases in the lab corpus (28%) and a far
smaller share of proofer-test/proofer-holdout, so a 22pp homophone gain barely
registers in the aggregate.

This is the reason the holdout exists, and it is worth remembering before
adopting anything tuned in `prompt-lab.mjs`: **a corpus built from a model's
failures over-weights those failures by construction.** Report lab-corpus wins
as category-level findings, and let the holdout decide whether to ship.

v16 was therefore **not adopted** — `background.js` keeps the production
prompt, which is better for qwen3.5 by one case and worse for LFM2.5 by one.
The variant is preserved in `prompt-lab.mjs` for anyone revisiting this.

LFM2.5-2.6B is 1.5x faster at a quarter of the size, and its losses are
concentrated in one place: homophone/wrong-word cases it declines to touch
(`its`/`it's`, `principle`/`principal`, `Who's`/`Whose`, `could care less`) plus
word-boundary splits (`setup` → `set up`, `al ot` → `a lot`). 9 of its 14 core
failures were MISSED_ERROR — it under-corrects rather than mangling text, which
is the safer failure mode but still a miss. This historical comparison did not
test LFM2.5-tuned sampling. Current sampling evaluation uses the workflow under
“Evaluating a replacement for the pinned model.”

## Test Case Design

Each test case has: `{ input, expected, category, description }`

- `input`: the text sent to the model
- `expected`: the fully corrected text after applying all suggestions
- `category`: error type (typo, word-boundary, duplicate, wrong-word, missing-word, clean, directive, mixed, etc.)
- `description`: human-readable label

For clean text cases, `expected === input` — the model should return no suggestions.

### Adding new test cases

- Add to `proofer-test.mjs` for cases you want to tune against
- Add to `proofer-holdout.mjs` for cases you want to validate generalization (never use these for tuning)
- For parameter sensitivity, run the same fixed JSONL inputs through
  `finetune/teacher-pass.mjs` for each `PROOFER_OPTIONS` configuration. Do not add
  cases to the frozen `param-sweep.mjs` stub or tune on the validation holdout.
- Avoid duplicating inputs across suites — each suite should test different sentences
