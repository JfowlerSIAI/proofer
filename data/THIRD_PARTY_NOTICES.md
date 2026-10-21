# Third-party data shipped with Proofer

Proofer's original code is licensed under the Apache License, Version 2.0;
see [LICENSE](../LICENSE) and [NOTICE](../NOTICE). The third-party data files
retain their own terms, reproduced or identified below.

This notice accompanies Proofer’s runtime package. The package contains the
runtime data files described below and their accompanying licence texts. It
excludes the source repository’s tests, builders, build inputs, research, and
recordings.

---

## `data/confusables-en.txt` — LGPL-2.1-or-later

419 confusable word pairs used by the sentence-mode output guards.

**Generated** by Proofer’s source-repository confusables builder from
LanguageTool’s English confusion sets. Because it is derived from LGPL-licensed
data, the derived file is LGPL-2.1-or-later.

It is a **modified version** of that upstream work — parsed, filtered to
homophone pairs above a precision floor, and re-expressed one direction per
line. LGPL §2(b) requires the modification to carry a date of change, and the
file's own header does: `Modified from upstream on <date>`. The builder bumps
that date only when the emitted pairs actually change, so it records when the
derived content was last modified rather than when the file was last rewritten.

| | |
|---|---|
| Upstream | [LanguageTool](https://github.com/languagetool-org/languagetool), `languagetool-language-modules/en/src/main/resources/org/languagetool/resource/en/confusion_sets.txt` |
| Pinned source | LanguageTool commit `b4b4ae90f8af5ce17c1bf06df5461b7476aaa66a`; upstream confusion-set SHA-256 `2d4affcb4a6c94311f90412c9634108822cf7598066303a68e00be329c18eda4`. |
| Copyright | © the LanguageTool contributors |
| Licence | GNU Lesser General Public License, version 2.1 or (at your option) any later version |
| Licence text | [COPYING.LGPL-2.1](COPYING.LGPL-2.1), distributed alongside |

> This library is distributed in the hope that it will be useful, but WITHOUT
> ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
> FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more
> details.

The upstream file's own header credits *After the Deadline*'s
`homophonedb.txt` as its original source.

The LGPL applies to this data file, not to Proofer's code. It is a separate
work, loaded at runtime, and a user may replace it with the same `typed|meant`
line format. `background.js` verifies the pair count and SHA-256 against
`CONFUSABLES_COUNT` / `CONFUSABLES_SHA256`, so a replacement needs those
constants updated too. Rebuilding this data requires the Proofer source
repository. Its confusables builder writes the derived pairs and the worker’s
integrity constants together.

## `data/COPYING.LGPL-2.1`

Verbatim GNU LGPL version 2.1, fetched from LanguageTool’s `COPYING.txt` at
commit `b4b4ae90f8af5ce17c1bf06df5461b7476aaa66a`, the same pinned commit as
the confusion sets. Its SHA-256 is
`95a62130965bddc821631fcec03abe97246f9130f11a8be6f47579f8bc016fc8`.
The accompanying [COPYING.LGPL-2.1](COPYING.LGPL-2.1) satisfies the requirement
that a copy of the licence accompany the redistributed work.

## `data/words-en.txt` — SCOWL 2020.12.07 / `wamerican`

The original 63,875 entries are derived from SCOWL 2020.12.07 as packaged
by Debian/Ubuntu in `wamerican 2020.12.07-2`: the American SCOWL size-50
word list with variants through level 2 and Debian's word-list patches,
filtered to existing lowercase ASCII entries matching `^[a-z]+$`.

Proofer modified that derived list in commit
`bcda8571816c829189513d62ec744151a78c1037` on 2026-08-12 by adding 124
entries (hand-made derivations such as `auditable`, `debuggable`,
`deployable`). Those additions are Proofer's and are not part of SCOWL.

Later modifications to Proofer’s filtered word list were:

- 2026-08-24, commit `80e9d23`: added `proactivity`.
- 2026-09-09, commit `1e812ac`: added 25 calendar terms: `april`, `christmas`,
  `december`, `diwali`, `easter`, `february`, `friday`, `halloween`, `hanukkah`,
  `january`, `july`, `june`, `juneteenth`, `kwanzaa`, `monday`, `november`,
  `october`, `passover`, `ramadan`, `saturday`, `september`, `sunday`,
  `thursday`, `tuesday`, and `wednesday`.
- 2026-09-15, commit `dd9b05b`: added `anthropomorphized`, `intelligences`, and
  `subagents`.

At this revision the file contains 64,028 distinct entries: the original
63,875 plus 153 additions, with no original entries removed. “Added” describes
changes to the filtered file; it does not assert independent authorship of
calendar words.

Copyright 2000-2018 by Kevin Atkinson.

SCOWL's complete copyright, permission, source-component notices, and
disclaimers are reproduced verbatim in
[COPYRIGHT.SCOWL-2020.12.07](COPYRIGHT.SCOWL-2020.12.07)
(fetched from the 2020.12.07 release tag, SHA-256
`283326a422e29c510e2ba6805518c418ce3c35ed1fadc3eec83d2da4f6c5a055`).
The SCOWL notice applies to the SCOWL-derived data. Proofer’s code licence
does not replace the data’s terms. SCOWL's grant explicitly covers use, copying,
modification, distribution **and sale**, conditioned on the notice appearing in
all copies — which this file and the shipped copyright file satisfy.

Provenance was **proven, not inferred**, on 2026-08-14: filtering the
installed `wamerican 2020.12.07-2` dictionary reproduces the original
commit's blob **byte-for-byte** (both SHA-256
`a43c50614fda43658df3e60aa07e8cc37f657d969fcf89938731bf059db16d16`), a
source-level rebuild from the SCOWL 2020.12.07 tarball plus Debian's
documented size/variant/patch choices reproduces the same bytes, and
pristine upstream differs by exactly the three words Debian's named
patches remove (`mys`, `reprized`, `sangs`) — a fingerprint of the
Debian route specifically. Every other candidate source checked
(other SCOWL sizes and releases, Hunspell, Aspell, five npm word lists,
the common GitHub lists) is non-exact.

---

## `data/names-en.txt` — SCOWL 2020.12.07 / `wamerican`

The 10,553 cased entries (proper nouns, brands, initialisms of three letters
or more) are selected mechanically by Proofer’s source-repository name-list
builder from the same Debian/Ubuntu `wamerican 2020.12.07-2` word list as
`data/words-en.txt`; possessives, single letters, two-letter initialisms, the pronoun contractions
and accented entries are omitted, and two names the source lacks are added in
`background.js` (`HAND_NAMES`), which are Proofer's and not SCOWL's. The file
header records the source's SHA-256. SCOWL's copyright, permission and
disclaimer notice in [COPYRIGHT.SCOWL-2020.12.07](COPYRIGHT.SCOWL-2020.12.07)
applies to this file exactly as it does to the word list.
