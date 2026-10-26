# Changelog

## 0.2.1 — 2026-10-25

Security update for the public beta. Upgrade from 0.2.0 and refresh open writing
pages after reloading the extension.

- Restrict local extension storage to trusted extension pages and the service
  worker before reading or changing settings or records. Content scripts receive
  only the consent and debug fields they need; stale consent replies cannot
  restore permission after it is revoked.
- Serialize recording changes with log writes and recheck recording consent
  before updating existing records. Turning recording off also drops pending
  feedback collection in the page.
- Require Ollama 0.35.0 or newer and pin the optional Docker helper to the
  reviewed 0.35.0 image digest.
- Reject traversal, symlinks and ambiguous paths in development fixture servers
  and capture output. Keep live browser tools sandboxed and restrict explicit
  offline fallback runs to local fixtures.
- Pin test Chrome to 156.0.8078.47, enforce its minimum security version and
  check release age before downloading. Add storage, recording, fixture-path
  and browser-security regression gates.
- Load the optional encoder research helper from hash-verified local model
  files and isolated caches, with remote code references rewritten for offline
  loading. Include a reviewed dependency lock and fail-closed loader tests.

## 0.2.0 — 2026-10-23

Initial public source release. Preparation reviewed: 21 October 2026.

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

### Licensing and distribution

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

The existing version number is retained for the initial source release.
Subsequent extension releases must increment `manifest.json`'s
version and record their user-visible changes here.
