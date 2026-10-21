# Editor fixture sources and licenses

These files exercise real editor implementations offline. They are development
fixtures and are excluded from the extension package. The repository's main
license applies to Proofer-authored test utilities and wrappers; it does not
replace the upstream licenses recorded here.

## Captured implementations

| Fixture | Identifiable upstream versions | License and source |
| --- | --- | --- |
| `slatejs.org` | Captured 2026-08-25; build `3dCeb8NLi7F0NNZ8qwnk-`; Next 14.2.35; React 18.2.0 | [Slate MIT](LICENSES/slate.txt), [upstream](https://github.com/ianstormtaylor/slate) |
| `slatejs.org-2026-10-09` | Captured 2026-10-09; build `tsAE1mpvWW79X1Ug5Z89V`; Slate React/DOM 0.132.0 fingerprints recorded in the capture header; Next 15.5.27; React 18.2.0 | [Slate MIT](LICENSES/slate.txt), [upstream](https://github.com/ianstormtaylor/slate) |
| `playground.lexical.dev` | Captured 2026-08-14; React 19.2.5; exact dependency versions survive in the bundle's source-region paths | [Lexical MIT](LICENSES/lexical.txt), [upstream](https://github.com/facebook/lexical) |
| `prosemirror.net` | Captured 2026-08-14; the browser bundle exposes the ProseMirror model, state, view, transform, commands, schema, history, keymap and example-setup modules | [Website MIT](LICENSES/prosemirror-website.txt), [component notices](LICENSES/prosemirror), [upstream](https://github.com/ProseMirror/website) |
| `draftjs.org` | Captured 2026-08-25; React 16.13.1, core-js 2.6.11 and UAParser 0.7.21 match the archived website lockfile; that lockfile pins Draft.js 0.11.5 | [Draft.js MIT](LICENSES/draft-js.txt), [upstream website lockfile](https://github.com/facebookarchive/draft-js/blob/main/website/yarn.lock) |
| `quilljs.com` | Captured 2026-08-14; Quill 2.0.3; Next 14.1.3; React 18.2.0; KaTeX 0.16.9; Highlight.js 11.9.0 | [Quill BSD-3-Clause](LICENSES/quill-2.0.3.txt), [upstream v2.0.3 lockfile](https://github.com/slab/quill/blob/v2.0.3/package-lock.json) |
| `trix-editor.org` | Locally authored page using the unchanged captured Trix 2.1.19 engine and CSS; the engine includes DOMPurify 3.4.2 | [Trix MIT](LICENSES/trix-2.1.19.txt), [DOMPurify terms](LICENSES/dompurify-3.4.2.txt), [upstream](https://github.com/basecamp/trix/tree/v2.1.19) |

The captured bundles are identified by their exact SHA-256 values in
[ASSET_PROVENANCE.json](ASSET_PROVENANCE.json). A site build identifier is not a
source commit. Where the build did not retain a release version or commit, this
inventory uses the captured bytes and does not invent one.

## Bundled dependency notices

[LICENSES/npm](LICENSES/npm) preserves notices from exact-version published
packages and their declared source repositories. The associated JSON files
record distribution URLs, archive hashes, original notice paths, notice hashes,
source revisions when available, and the method used to recover each notice:

- [Lexical and directly identified packages](LICENSES/npm-sources.json)
- [Next.js and supporting releases](LICENSES/npm-extra-sources.json)
- [Quill and Draft website dependency coverage](LICENSES/npm-coverage-sources.json)
- [Additional identified helper libraries](LICENSES/npm-helper-sources.json)
- [Notices recovered from source repositories or published license declarations](LICENSES/npm-upstream-notices.json)
- [Coverage evidence and scope](LICENSES/coverage-evidence.json)
- [Other direct upstream license sources](LICENSES/SOURCES.json)

This notice collection is deliberately conservative: it includes the client
dependency closures from the matching website lockfiles and all notices shipped
inside the corresponding Next.js packages. Some of those components are not
present in the captured browser code. It is an attribution inventory, not an
exact reconstruction of the upstream build or a claim that every listed package
is bundled. The separately loaded CodeSandbox Nodebox runtime is not present in
the captured assets and is not distributed here.

For a small number of packages, upstream published a license declaration and
author metadata without a standalone license file. Their `UPSTREAM-LICENSE.txt`
preserves that declaration and attribution, identifies the exact registry
version, and includes the declared standard terms. Those reconstructed notices
are explicitly labeled; they are not presented as verbatim upstream files.

The four license sidecars explicitly referenced by the Quill and Draft bundles
have been restored at their original relative paths. Full license conditions
also appear in `LICENSES`; a short banner alone is not used as a replacement.

## Fonts and artwork

[Font metadata and mappings](LICENSES/font-sources.json) record the name-table
copyright, family, version and license fields embedded in every retained font.
The font binaries are unchanged. Their licenses are included under
[LICENSES/fonts](LICENSES/fonts): Roboto, Source Sans Pro, Merriweather,
Inconsolata, Slabo and KaTeX use OFL-1.1; Material Icons and this captured Roboto
Slab release use Apache-2.0; Ubuntu Mono uses the Ubuntu Font Licence 1.0.
The KaTeX font notice combines the two fonts' embedded copyright and reserved-name
statements with the standard OFL-1.1 text, as documented in that file.

[Artwork provenance](LICENSES/image-sources.json) records byte-for-byte matches
between each retained image and an immutable source tree in its upstream
project. These site assets retain their respective project licenses and
attribution; inclusion here does not grant rights to the upstream trademarks.

## Public-source adjustments, 2026-10-21

- Removed four Quill Sailec/Sofia Pro webfonts, whose embedded metadata points to
  a commercial MyFonts license, and their `@font-face` declarations. The existing
  CSS fallback fonts remain in use.
- Replaced the Trix website's marketing page, artwork, stylesheet and attachment
  upload script with [a locally authored wrapper](trix-page.mjs). It loads the
  same pinned Trix engine and stylesheet and exposes a real `trix-editor` with
  its document model. `capture.mjs trix` regenerates this wrapper locally.
- Disabled the Lexical playground's optional Firebase configuration and replaced
  the two captured analytics scripts with inert Proofer-authored comments. The
  editor implementation remains present; the fixture is for offline editing.
- Removed author-machine browser paths from capture headers. Initial capture
  adjustments (local URL rewriting, a restrictive CSP, and removal of external
  preconnect links) remain in place.

The provenance ledger records hashes of the original captured files for each
modified or removed asset. Both Slate JavaScript bundles and their fonts remain
unchanged.

## Maintenance

Run `node test/fixtures/verify-provenance.mjs` to check asset hashes, retained
notices, font mappings, and explicit sidecar references. Run
`node test/fixtures/verify.mjs` to check that all seven editor fixtures still boot
and accept typing without offsite requests or missing resources.

A fresh web capture can introduce new code, commercial fonts, artwork and remote
integrations. Review its sources and terms, preserve required notices, remove
unnecessary assets without established redistribution rights, and update the
provenance ledger before publishing it. The ledger verifier deliberately rejects
changed or unrecorded assets until that review is reflected in the ledger.
