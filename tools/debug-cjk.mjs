/**
 * Placeholder. This file used to hold an ad-hoc diagnostic for why one specific
 * Chinese near-verbatim loop did not trip under the FIRST detector design (the
 * sliding-window one, which was measurably broken — see the "Design note:
 * disjoint blocks, not a sliding window" section in lib/detector.js).
 *
 * That design is gone, so the diagnostic no longer applies and its imports no
 * longer resolve. Use tools/calibrate.mjs instead: it measures the block-overlap
 * signal for English and Chinese, verbatim and near-verbatim, loops and clean
 * corpora, and sweeps candidate thresholds.
 *
 * Run with: node tools/calibrate.mjs
 */

export {};
