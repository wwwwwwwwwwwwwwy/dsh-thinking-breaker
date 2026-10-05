# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
