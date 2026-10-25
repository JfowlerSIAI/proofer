# Contributing to Proofer

Bug reports, documentation improvements, and focused pull requests are welcome.
For a substantial feature or a new editor integration, open an issue explaining
the problem and proposed behavior before investing in the implementation.
Review and support are best-effort.

## Set up a checkout

Use **Node.js 22.12 or later (Node.js 24 recommended)**. For dependency installation,
use **npm 11.9 or later**, which supports the minimum-release-age policy.
**npm 11.12.1** is the recommended pinned version used by CI. Node's bundled
npm may be older; check your versions:

```bash
node --version
npm --version
```

If your npm is older than 11.9, or you need to match CI's version, install the
reviewed version explicitly:

```bash
npm install --global npm@11.12.1 --ignore-scripts
```

The extension itself is vanilla JavaScript and has no runtime npm dependencies
or bundler.

From the repository root:

```bash
npm --prefix test test
node tools/package.mjs
```

The first command runs the source-only regression checks without installing
packages. The second creates `dist/proofer`; load that directory through your
browser's extensions page with Developer mode and **Load unpacked** enabled.
Follow the [install guide](docs/install-guide.md) to set up Ollama and
activate proofreading. After a change, rebuild, reload the extension, then
refresh writing pages after saving drafts.

## Choose the right checks

| Command from the repository root | What it exercises | Prerequisites |
| --- | --- | --- |
| `npm --prefix test test` or `npm --prefix test run test:source` | Source-only regression battery: guards, consent, setup logic, request bytes, records, and packaging | Node.js 22.12+ (24 recommended); no npm install or model |
| `npm --prefix test run test:browser` | Real browser behavior with canned replies and local editor captures | Locked test dependencies, Chrome for Testing, and port 11434 free in the test environment |
| `npm --prefix test run test:e2e` | Real extension, Ollama, and pinned model; setup and a correction through the full pipeline | Browser prerequisites, running Ollama, pinned model, and a machine that passes setup's speed check |

Install the browser prerequisites from `test/`:

```bash
cd test
npm ci
node scripts/install-chrome.mjs
npm run test:browser
```

`test/.npmrc` disables lifecycle scripts, so `npm ci` does not download a
browser. The explicit command checks release age, then installs the exact
Chrome for Testing build in `test/chrome-version.json`. The reviewed security
floor applies to overrides and system browser fallbacks too. Its download needs `unzip` on Linux/macOS
or the native archive tools on Windows. You can instead set `PROOFER_CHROME` to a
compatible Chrome for Testing binary. Use Chrome for Testing for suites that
load the extension automatically; the everyday branded Chrome browser is not
an interchangeable test runner.

The source and browser batteries need no model or external service. They use
local files and loopback servers. CI additionally runs the browser battery
inside a Linux network namespace that blocks outbound traffic; a normal local
run does not provide that isolation. Some source tests also bind a loopback
port, so a sandbox that prohibits local listeners cannot run the entire battery.

The browser setup suite must own `127.0.0.1:11434` for its fake Ollama server.
If you already have Ollama running, stop it before this group or use an isolated
network namespace. On Linux with unprivileged user/network namespaces and the
`ip` command available, run this from the repository root:

```bash
unshare -rn sh -c 'ip link set lo up && node tools/test.mjs browser'
```

This keeps the test server separate from your running Ollama and also blocks
outbound traffic. If your operating system prohibits namespace creation, use
the ordinary command with port 11434 free, or rely on CI for the isolated run.

For the real-model check, start Ollama locally and install the pinned engine
through Proofer's setup or with `ollama pull jayafowler/proofer:v1-q4`, then run
`npm run test:e2e` from `test/`. The suite creates its own browser profile and
requires the real setup speed check to pass. A machine that is too slow cannot
pass this suite. Read the model's separate licence before using or distributing
it; see [README.md](README.md#licensing).

Run the source battery for every code change. Run the browser battery for
changes to content editing, setup, popup UI, or browser integration. Changes to
prompts, guards, or the model also need relevant quality checks; a passing
mocked test does not establish correction quality. Describe tests you could
not run and why in the pull request. Individual suites and research commands
are documented in [test/TESTING.md](test/TESTING.md).

## Understand the code

| Area | Files |
| --- | --- |
| Sentence capture, editor integration, applying and undoing corrections | `content.js`, `styles.css` |
| Settings, local records, Ollama requests, output guards, setup qualification | `background.js` |
| First-run setup | `welcome.html`, `welcome.js` |
| Toolbar controls and recent changes | `popup.html`, `popup.js` |
| Installed-file allowlist and checksums | `tools/package.mjs` |
| Regression and browser harnesses | `test/` |

[ARCHITECTURE.md](ARCHITECTURE.md) explains the message flow and safety checks.
The runtime uses classic scripts; the Node harnesses use ES modules. Several
tests extract production functions from the runtime source, so moving or
renaming code can affect those test seams. Keep structural refactors separate
from behavior changes when practical.

When adding a runtime file, update the allowlist in `tools/package.mjs` and
verify it with `node test/package-test.mjs`. Keep changes to consent, sentence
position checks, editor compatibility, deadlines, model identity, and undo
behavior covered by an appropriate regression test. Reproduce editing bugs with
synthetic text and a minimal editor example.

## Dependency updates

Keep direct dependencies pinned to exact versions and commit the reviewed
lockfile. Normal updates use stable, non-deprecated releases **older than 10
days**. Explain why a new dependency is needed and retain its licence notices.

The read-only [upgrade checker](test/scripts/check-direct-npm-dependency-upgrades.sh)
queries the npm registry and lists eligible direct dependency upgrades. Run it
from the repository root with:

```bash
bash test/scripts/check-direct-npm-dependency-upgrades.sh
```

An urgent fix for a specific known vulnerability may use an exact target
version **older than one day**. This exception applies only to that targeted
package; it must not introduce other packages newer than 10 days. The
[CVE remediation helper](test/scripts/apply-npm-cve-fix.sh) implements that
workflow: it changes the direct pin or override, regenerates the lockfile,
checks the release ages, and runs `npm audit`. Use it only for a documented
vulnerability, review every resulting change, and rerun the relevant tests.

Do not disable the release-age policy for general upgrades or enable all
package lifecycle scripts to install the test browser. Use the explicit browser
installation command above.

## Reports and pull requests

For a bug, include the Proofer version or commit, browser and OS versions,
editor type if known, steps using made-up text, and expected versus actual
behavior. A setup test report contains environment details and timings; review
it before sharing. An exported proofreading log contains actual writing and
site information: **do not post it in an issue or pull request**.

For a pull request, describe the user-visible problem, the resulting behavior,
and the checks you ran. Keep unrelated changes separate. Include a screenshot
for a visible UI change when it helps review, using synthetic text and no
personal browser data.

Please communicate respectfully and assume good intent. Security reports go
privately to the contact in [SECURITY.md](SECURITY.md), not the public issue
tracker. General support is available on a best-effort basis through the
[project contact](docs/privacy-policy.md#contact).

Contributions to Proofer's original code and documentation are submitted under
the [Apache License 2.0](LICENSE). Only contribute material you have the right
to share, and identify any third-party material and its licence. Model weights
and bundled third-party materials retain their separate terms.

Please follow the [code of conduct](CODE_OF_CONDUCT.md) when participating in
the project.
