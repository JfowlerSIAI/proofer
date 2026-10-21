# Changelog

## Unreleased — 0.2.0 public release preparation

Preparation reviewed: 21 October 2026. The public release date is not yet set.

- Replace the invited-tester training-donation notice with local export and
  support-only sharing. Show the revised notice before an existing user exports
  again. Keep maintainer contact in one setting and generate the canonical policy.
- Support Node.js 22.12 and newer; recommend Node 24 and check 22/24 in source CI.
- Upgrade development-only Puppeteer from 24.37.5 to 25.13.0, await asynchronous
  Chrome path resolution and close the browser before draining fixture servers.
- Replace recorded-message regression carriers and identifiers with synthetic
  examples, remove private machine paths, and document historical test evidence.
- Add the illustrated README, release-ZIP installation path, usage guide and
  community contribution files.

## 0.2.0 — initial source release candidate

- Release the original extension code and development tools under Apache-2.0,
  with author attribution and a voluntary request for visible credit on
  substantial reuse.
- Explain the separately licensed LFM-derived model and third-party data.
- Provide public contributor and security-reporting instructions, grouped
  test commands, and a release ZIP with checksums and license notices.
- Exclude private research transcripts, recordings, and training corpora from
  the public source distribution.

The proofreading algorithm and default settings are unchanged. The export notice
and development/browser tooling changes are listed above. Proofer remains
an English proofreading extension for Chrome and Brave, with local Ollama
inference, guarded live edits, a speed qualification check, and limited undo.

The existing version number is retained for the initial source release. Once
published, subsequent extension releases must increment `manifest.json`'s
version and record their user-visible changes here.
