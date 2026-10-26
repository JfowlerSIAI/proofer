# Releasing Proofer

Use Node.js 22.12 or later (Node.js 24 recommended) and a clean checkout of the revision being released. Keep
release credentials and signing material outside the source tree. The
extension version lives in `manifest.json`; update `CHANGELOG.md` and
`CITATION.cff` alongside a version change.

## Verify the candidate

1. Run `node tools/test.mjs source` with Python 3 available for the encoder
   loader's standard-library security tests; no Python packages are needed.
2. Install the pinned test dependencies and Chrome for Testing as described in
   [CONTRIBUTING.md](../CONTRIBUTING.md), then run the browser group in a
   loopback-only network namespace on Linux, matching CI.
3. On a suitable computer with Ollama and the exact pinned model, run
   `node tools/test.mjs e2e`. This exercises real setup, qualification, and a
   correction. A refused or untested machine is not evidence of a passing
   real-model check.
4. For changes to setup, run the manual **OS install check** workflow for
   Windows and macOS. Use [the acceptance checklist](maintainers/acceptance-test.md)
   for the installer and usability steps that automation does not cover.
5. Review license notices when adding code, fonts, images, data, or model
   weights. Capturing a website does not automatically establish rights to all
   its assets; see [fixture provenance](../test/fixtures/THIRD_PARTY_NOTICES.md).
6. Review the files and history intended for publication, including remote
   issue attachments and Actions artifacts where applicable. Use fabricated
   text in public reproductions. Never attach user logs or private corpora.

The source and browser CI jobs are the routine merge gates. The real-model and
OS installation checks are deliberate release checks; they need an external
model download and suitable hardware.

## Build the extension

```bash
node tools/release.mjs
```

This command requires the `zip` utility. It writes
`dist/release/proofer-<version>.zip` and `dist/release/SHA256SUMS.txt`, plus an
unpacked directory for inspection. The ZIP contains only the runtime allowlist,
including `LICENSE`, `NOTICE`, and third-party data notices. Its manifest is at
the ZIP root, so it can be submitted to an extension store.

The **Release candidate** GitHub workflow runs source checks and builds these
artifacts on a manually selected ref. It uploads them for review; it does not
publish a release or submit to a store. ZIP timestamps and modes are normalized;
repeat builds with the same ZIP implementation should have identical hashes.

Never zip an entire working checkout as an extension. `dist/`, `node_modules`,
local recordings, and Git metadata are not release payloads.

## Publish a reviewed release

- Use `main` as the public default branch. Require pull requests and the
  `source-only (Node 22, no browser, no npm)`,
  `source-only (Node 24, no browser, no npm)`, and `browser (headless Chrome, loopback)`
  checks before merging. Block force pushes and deletion on `main`. For a sole
  maintainer, required approving reviews can stay off so the branch is usable.
- Enable dependency alerts, secret scanning, push protection, and private
  vulnerability reporting where the repository/account offers them. Keep
  automated dependency changes subject to the pinned-version and quarantine
  rules in the contributor guide.
- Set the actual release date in `CHANGELOG.md` and `CITATION.cff`
  (`date-released`) when publishing; do not date an unpublished candidate as a
  completed release. Tag the reviewed commit `v<version>`. Attach the verified extension ZIP and
  checksum file to the release, and describe validation and known limitations.
- Link the source repository, [privacy policy](privacy-policy.md),
  [model terms](model.md), and [security reporting instructions](../SECURITY.md)
  from the project and any store listing. A fork should identify its own
  maintainer and privacy contact.
- If distributing a source archive, create it from the reviewed public commit
  with `git archive`, not a filesystem copy of a developer's directory.

## Initial public repository

The initial public version is a curated source snapshot with contributor
attribution. Private development archives remain outside it. Publish this
snapshot from a **new Git repository with fresh history**; do not push a branch
from the private development repository or simply change its visibility.
Deleting private files at the tip does not remove them from earlier commits.

Before the first push, inspect `git log --all` and `git ls-files`, check the
author identity used in the new initial commit, and review the public snapshot
and release artifacts. Publish only after that review. The ongoing public
repository can then retain normal contributor history.

## Maintaining the privacy policy

The authored policy is `docs/privacy-policy.template.md`. `maintainer.js` is the
single maintainer name and contact setting used by both the export notice and
the policy. After changing either file, run `node tools/privacy-policy.mjs` and
commit its generated `docs/privacy-policy.md`; source checks reject a stale copy.
Changing the export notice also requires changing `EXPORT_NOTICE_VERSION` in
`popup.js`, so users see the updated notice before exporting again.

Link to the generated policy in this repository. The legacy
`jfowlersiai.github.io/proofer-privacy/` site should redirect to that canonical
page after the public repository exists, rather than maintaining a second
policy. Replace the old hosted body as part of the same approved publication.
