# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-10-08

**A second lens over the reasoning stream.** The 1.1.0 breaker answers one
question — *is this text repeating itself?* — and that turned out to be only half
of the observed failure. The other half is a stream that stops carrying meaning
without repeating: literal asterisks (`***`, `*****`), a rotating emoji flood,
punctuation soup. The shingle rule is unreliable against those (a rotating emoji
set keeps its shingle overlap high enough to slip through), and the loop rule
needs 1280 code units of confirmed repetition to fire at all.

### Added

- **Degeneracy breaker (`lib/degeneracy.js`).** A second pure detector, fed the
  same `reasoning-delta` chunks, measuring *what a block is made of* instead of
  *whether it has been seen before*. Either lens can abort the request, and both
  share the forced no-think retry, the per-turn budget and the post-trip hint.
- **Five signals, a hard gate, and a streak.** A block is degenerate when it has
  no lexical content at all (`meaningless`, letters + digits ≤ 8 % of non-space)
  **and** at least `degEvidenceMin` (default 2) of `noisy`, `low-variety`,
  `run-heavy`, `emoji-flood` agree, for `degStreak` (default 2) consecutive
  blocks. The gate buys a property rather than a tuned threshold: **a block
  carrying real words can never be degenerate**, so markdown tables, code,
  base64, numeric tables, arrow chains and `====` rules are excluded by
  construction. `tools/calibrate.mjs` measures this: removing the gate makes
  three clean corpora trip.
- **`run-heavy` separates a flood from a rule.** A `====` separator is *one*
  symbol run; a `***` flood is *many*. Both are covered (`degRunCountMin`,
  `degRunLenMin`) and neither is sufficient alone.
- **Optional answer-stream guarding** (`degeneracyOnAnswer`, default off) with
  its own detector instance, so a thought ending and an answer beginning are
  never read as one continuous block.
- **`test/degeneracy.test.mjs`** — 61 cases, including the corpora that matter:
  every degenerate shape must trip, every clean shape must not.
- **Calibration sweep for the second lens** in `tools/calibrate.mjs`: per-block
  evidence flags for every corpus, plus an `evidenceMin × streak` grid reporting
  `cleanTrips / degenerateMisses`. The shipped `2 / 2` scores `0 / 0`; `1` trips
  on legitimate markdown and `3` misses two real floods.
- 10 integration cases in `test/plugin.test.mjs` covering the abort shape, the
  log line, the shared retry path, and the config plumbing.

### Changed

- `llm/stream` now runs two lenses and takes whichever fires first. The trip log
  gains a `stream=` field and, for degeneracy trips, the full evidence set and
  the measurements behind the verdict — enough to diagnose a false positive from
  the log alone.
- Trip latency for a `***` flood drops from 1280 code units (the repetition
  rule) to **256** (two blocks). Measured on the shipped defaults.
- `tools/check.mjs` and `npm test` now include the new test file.

### Notes

- The two lenses stay complementary, not redundant: a repetitive flood is caught
  by the repetition rule first, and a *non-repeating* emoji flood — the corpus
  that justifies this release — is caught only by the degeneracy rule. Both
  directions are pinned by tests.
- Emoji classification uses `\p{Extended_Pictographic}` with a deny-list for
  pictographs that ordinary technical prose uses as text (arrows, `©`, `®`,
  `™`). Without it, an arrow chain reads as an emoji flood. A coarse range check
  is the fallback if the property escape is unavailable.

## [1.1.0] - 2026-10-05

First public release.

### Added

- **Reasoning-loop breaker.** Watches `reasoning-delta` chunks on `llm/stream`; when the model
  repeats itself for `noveltyStreak` consecutive blocks, the request is aborted with a terminal
  `finish` chunk (`kind: 'aborted'`).
- **Forced re-think.** `agent/request-error` recovers the plugin's own abort once per turn by
  returning `{ kind: 'retry' }`, and `agent/request` pins that retry to `reasoningEffort: 'off'`
  so the step answers instead of re-reasoning.
- **Post-trip guidance.** The next top-level tool result carries an explicit instruction not to
  resume the aborted line of reasoning. Delivered on successful results too, because most
  recovering turns contain no successful tool call at all.
- **Tool-failure breaker.** After `toolFailureSteerAfter` failures in one turn, the result is
  rewritten with change-approach guidance; after `toolFailureDenyAfter` the identical call is
  denied before dispatch. A success through the same call clears both the deny marker and its
  failure count.
- **Pure block detector** (`lib/detector.js`) with measured thresholds, plus `tools/calibrate.mjs`
  to re-measure them and `tools/verify-cordis-contract.mjs` to pin the host contract.
- CI across Node 22.19 and 24.

### Notes

- The thresholds in `DETECTOR_DEFAULTS` are measured, not guessed; the calibration table is in
  the README.
- Under the documented `link:` install the module exports no `Config`, so the entry activates
  without host validation or a generated settings form. This is deliberate: cordis calls
  `schema.validate` on whatever is exported, and a stand-in schema crashed the host during
  development. Every option still works through the plugin's own defaults.
