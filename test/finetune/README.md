# Fine-tune Phase 0 instruments

Optional research tools for benchmark construction, model evaluation and
fine-tuning. The public repository includes the instruments and synthetic
unit-test fixtures. It does not include the private corpora, annotation
history, training datasets, checkpoints or experimental model weights.
Some original corpus adapters are also omitted, including
`test/harvested/discord-source.mjs`; tools that import them need a replacement
adapter for an authorized dataset before they can run. The routine public
source and browser test groups do not depend on those adapters.
These tools are not needed to build or run the extension.

Use only data you are authorized to process and distribute. Scrubbing names
and handles is not a guarantee against reproduction of private training text.
Any release of derived datasets or model weights needs a separate review of
source rights, contribution consent and memorization behavior. A sampled
extraction check cannot prove the absence of memorization.

Layout:
- **Code lives here** (committed). Vanilla Node, no new dependencies.
- **Derived data and run artifacts** go to `test/harvested/finetune/`
  (gitignored — much of it derives from the owner corpus; the directory is
  0700 and the S1 artifacts 0600).
- **Raw corpora** live outside the repo at `~/proofer-finetune/corpora/`,
  each with a `DATA-CARD.md` and `SHA256SUMS`; this directory is a suggested
  local layout, not supplied data.

## Historical references

Section numbers such as "plan §6.2" in these study scripts refer to an
unpublished research plan. They are historical provenance labels, not links
to documentation supplied with this snapshot. The retained
[benchmark schema](benchmark-schema.mjs), script comments and the instrument
table below describe the procedures that remain public. Paths to private
run artifacts, including `test/results/shape-drift-exec/`, are historical
references; those artifacts are not included or fresh-clone prerequisites.
See [model reproducibility](../../docs/model.md#training-and-reproducibility)
for the limits of reproducing the published weights.

## Instruments

| file | what it is | proof it works |
|---|---|---|
| `benchmark-schema.mjs` | the proofer-benchmark/v1 contract: UTF-16 spans, CREDITS vs VERDICTS, profiles, candidate signatures, file-level split/register-group validation | consumed + asserted by both suites below |
| `benchmark-fixtures.mjs` | 30 golden benchmark records | validate 0-problem; drive the scorer test |
| `benchmark-score.mjs` | paired scorer: credit-first classification, group-cluster bootstrap, two reweighting profiles, blinded adjudication queue | `benchmark-score-test.mjs` 344 asserts + mutants |
| `benchmark-power-report.mjs` | pre-freeze power check (effective n, one-event cost, rule-of-three bounds, panel sizing) | same suite |
| `benchmark-sample.mjs` | quota-driven candidate sampler; episode exclusion groups; training-reservation manifests | run for real: chat-owner 480 candidates, 445 episodes reserved |
| `error-inject.mjs` | 12 versioned reversible taxonomy transforms | `error-inject-test.mjs` 385 asserts |
| `natural-screens.mjs` | 8 teacher-independent likely-error screens | exercised by sampler + calibration draws |
| `label-benchmark.mjs` | owner's keyboard-first benchmark labeler (+ `--pilot` timing gate, `--assemble`) | `label-benchmark-test.mjs` 147 asserts |
| `edit-groups.mjs` | deterministic tokenizer/aligner → edit groups | `judge-edit-groups-test.mjs` 32 asserts |
| `judge-prompt.md` / `sentinels.json` | Terra judge prompt v1 + 32 immutable sentinels | real-Terra smoke 16/16 |
| `judge-harness.mjs` | batched Terra judging via codex exec; sentinel drift → quarantine-since | smoke + mutation-verified failure paths |
| `calibrate-judge.mjs` | judge-vs-owner agreement scorer (§4 gate) | driven by `label-calibration-test.mjs` end-to-end |
| `verdicts.mjs` | the one owner of the verdict vocabulary + keep/revert projection | rewired consumers reproduce pre-refactor bytes |
| `calibration-sample.mjs` | calibration candidate pool + post-teacher `--stratify` | run for real: 1,400 candidates |
| `label-calibration.mjs` | owner's TTY calibration labeler | `label-calibration-test.mjs` 48 asserts |
| `teacher-pass.mjs` | reusable teacher batch runner (guards applied per row, resume by uid) | `--dry-run`; first live use is the calibration pass |
| `scrub-discord.mjs` | S1 scrubber + independent differential `--check` + manifest | Sol-audited, 11 findings closed; planted-fixture mutation tests |
| `context-distance-survey.mjs` | where evidence sits in real contexts (feeds the panel design) | historical private design input; artifact not distributed |
| `context-floor-panel.mjs` | distance-stratified 24-stimulus window panel | dry-run geometry checks + 9B smoke |
| `context-stability-probe.mjs` | N=300 teacher-target stability under trimming | dry-run; runs after the panel picks W* |
| `build-pilot-dataset.mjs` | two-stage pilot generator: pool draw (§6.3 arithmetic) + assemble (teacher × judge × leakage) | `pilot-dataset-test.mjs` 90 asserts (74 before G5.4); run for real 2026-08-22: 8,778 records |
| `corpus-pools.mjs` | IRC/Enron/SE source pools with reservation manifests | `corpus-pools-test.mjs` 102 asserts |
| `error-priors.mjs` | v0 priors from 1,789 schema-normalized interaction rows: 502 guard-accepted changed pairs / 639 groups; user verdicts do not imply guard acceptance | consumed by pool stage; G5.4 regeneration in `test/results/shape-drift-exec/G5.4/priors-after.json`; historical `error-priors-v0.json` and pilot pool unchanged |
| `pilot-audit-sample.mjs` | §7.1 blind 150-judgment stratified draw of pilot Terra verdicts | run for real: 13/20/25/92 across strata, seed 20260822 |

Keep this README and the schema documentation synchronized with changes to
the research instruments. The historical run counts below describe private
experiments; they are not fresh-clone verification instructions.

G5.4's schema correction (2026-10-08) changes accepted pairs from 531 to 502
and accepted groups from 728 to 639: 85 browser refusals leave the accepted
column and 56 guard-accepted pairs with later user verdicts enter it. Corpus
sources are unchanged; all-changed remains 744 pairs / 1,058 groups. The
aggregate counts/rates/mixture comparison is
`test/results/shape-drift-exec/G5.4/priors-comparison.json`. The existing
`pilot-pool-manifest.json` embeds the old mixture: `pilot-pool.jsonl` and its
assembled `pilot-dataset.jsonl` are historical derived artifacts, not regenerated
by this repair. Frozen datasets and historical measurements remain untouched.
