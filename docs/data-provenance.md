# Runtime dictionary provenance

The license texts and modification notices distributed with the extension are
in [data/THIRD_PARTY_NOTICES.md](../data/THIRD_PARTY_NOTICES.md). This document
keeps the source evidence needed to maintain those files without the private
development history.

## English words

The original 63,875 entries of `data/words-en.txt` were selected from SCOWL
2020.12.07 as packaged by Debian/Ubuntu `wamerican 2020.12.07-2`: American
size 50, variants through level 2, with the Debian patches. The filter retains
existing lowercase ASCII words; it does not lowercase proper nouns.

With that exact package's word list available:

```bash
LC_ALL=C awk '/^[a-z]+$/' /usr/share/dict/american-english | sha256sum
```

The filtered original is 592,752 bytes with SHA-256
`a43c50614fda43658df3e60aa07e8cc37f657d969fcf89938731bf059db16d16`.
The source dictionary is 104,334 lines / 985,084 bytes with SHA-256
`9f513f1ceadb6a01c5485b7dbdfd5118dc66cd70b59cae2851292112d4066a32`.
The published Proofer list contains 64,028 distinct words, including 153 later
additions recorded in its third-party notice. Those additions mean the current
list has a different digest from the original filtered input.

The historical provenance investigation also reconstructed the original from
[Debian's SCOWL 2020.12.07-2 sources](https://sources.debian.org/src/scowl/2020.12.07-2/).
After applying that package's patches, it used:

```bash
for f in $(./mk-list -f american -v2 50); do
  cat "final/$f"
done | LC_ALL=C sort -d | uniq | iconv -f iso8859-1 -t utf-8 \
  | LC_ALL=C awk '/^[a-z]+$/'
```

This produces the same 63,875-word file. Without the Debian patches, upstream
adds exactly `mys`, `reprized`, and `sangs`, matching the package's three named
patches. The upstream release is
[SCOWL 2020.12.07](https://github.com/en-wl/wordlist/commit/5ef55f9c42730ebe4394a78b77855468a6f15dd2).
Its complete copyright file is included as
[data/COPYRIGHT.SCOWL-2020.12.07](../data/COPYRIGHT.SCOWL-2020.12.07), with SHA-256
`283326a422e29c510e2ba6805518c418ce3c35ed1fadc3eec83d2da4f6c5a055`.

## Names

`data/names-en.txt` is mechanically selected from the same `wamerican`
snapshot by `test/build-names.mjs`. Its header records the source digest.
It contains 10,553 cased entries; SCOWL's notices apply. The separate hand
supplements in `background.js` are Proofer's additions.

## Confusable pairs

`test/build-confusables.mjs` builds `data/confusables-en.txt` from the pinned
LanguageTool confusion sets and a CMU Pronouncing Dictionary subset. The
upstream URLs, commits, hashes, and licenses are recorded in
[test/data/SOURCES.json](../test/data/SOURCES.json). The source inputs and their
license notices are included in the source distribution.

The derived confusion-pair data is LGPL-2.1-or-later. The runtime package
contains its modification notice and the full LGPL text. To check the
generated data and the worker's integrity constants without fetching inputs:

```bash
cd test
node build-confusables.mjs --check
```

Changing a generated dictionary also requires updating the integrity constants
the runtime validates. Use the included builders and regression checks; a
missing or mismatched dictionary can weaken the guards without preventing the
extension from loading.
