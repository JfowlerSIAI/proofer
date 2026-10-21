# Checked-in measurement summaries

These artifacts retain measurement evidence for the historical comparisons in
[TESTING.md](../TESTING.md). They are measurements of the recorded source and
model versions, not promises about the current release or other hardware.

The public source retains aggregate model comparisons and synthetic editor
benchmark trials, including counts, timing, model identifiers and source hashes.
Raw user interaction logs, training corpora, private review narratives and
unrelated local-project checks are excluded. The editor benchmark uses the
synthetic sentences in `editor-recipe-probe.mjs`.

Machine-specific metadata paths have been replaced with `<checkout>`, `<home>`
and `<temporary-directory>`. These placeholders do not imply that historical
checkouts or temporary source snapshots are included. Measurements and source
hashes are unchanged; results were not rerun as part of the metadata cleanup.

The private corpus underlying some aggregate model comparisons is not
distributed. Use the checked-in regression suites for reproducible public
checks; optional research scripts require separately obtained, authorized
inputs. Earlier private commit identifiers are provenance labels and are not
resolvable from this source snapshot.
