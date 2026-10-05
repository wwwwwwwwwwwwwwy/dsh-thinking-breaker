/**
 * Unit tests for the pure detector. Run with:
 *   node --test test/detector.test.mjs
 *
 * These pin the two behaviours the breaker depends on: every reasoning-loop
 * shape must trip, and ordinary non-repeating reasoning must never trip. The
 * thresholds these assertions rely on are justified by tools/calibrate.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDetector,
  fnv1a,
  fpDistance,
  fingerprint,
  setOverlap,
  shingleSet,
  DETECTOR_DEFAULTS,
} from '../lib/detector.js';

/** Feed a whole string in fixed-size chunks; return the first trip. */
function run(detector, text, chunk = 37) {
  for (let i = 0; i < text.length; i += chunk) {
    const trip = detector.push(text.slice(i, i + chunk));
    if (trip !== null) return trip;
  }
  return null;
}

/** Deterministic pseudo-random prose: unique words, no repetition. */
function uniqueProse(words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(`token${i}x${(i * 7919) % 104729} `);
  return out.join('');
}

/** Plausible varied reasoning: templated sentences drawing on a shifting lexicon. */
function variedReasoning(sentences) {
  const verbs = ['check', 'verify', 'inspect', 'read', 'compare', 'trace', 'confirm'];
  const objs = ['the adapter', 'the schema', 'the config row', 'the log line', 'the registry', 'the detector'];
  const out = [];
  for (let i = 0; i < sentences; i++) {
    out.push(
      `Step ${i}: I should ${verbs[i % verbs.length]} ${objs[(i * 5 + 1) % objs.length]} ` +
        `because reason${(i * 13) % 9973} suggests case ${(i * 31) % 7919}. `,
    );
  }
  return out.join('');
}

function variedCJK(sentences) {
  const out = [];
  for (let i = 0; i < sentences; i++) {
    out.push(`第${i}步：核对项${(i * 7919) % 104729}，理由${(i * 13) % 9973}指向情形${(i * 31) % 7919}。`);
  }
  return out.join('');
}

const VERBATIM = 'The user asked about the configuration file. I should check the file. ';
const NEAR = 'I need to verify the adapter accepts this reasoning effort value. ';
const CJK = '让我再想想。这个问题的关键在于约束条件是否真的被满足了，需要逐一核对。';

// ---------------------------------------------------------------------------
// Low-level primitives
// ---------------------------------------------------------------------------

test('fingerprint is stable for identical blocks and differs for shifted ones', () => {
  const s = uniqueProse(200);
  assert.deepEqual(fingerprint(s, 0, 128), fingerprint(s, 0, 128), 'same block must hash identically');
  assert.notDeepEqual(fingerprint(s, 0, 128), fingerprint(s, 1, 128), 'a one-char shift must change it');
});

test('setOverlap is 1 for identical sets, 0 for disjoint sets', () => {
  const s = uniqueProse(400);
  assert.equal(setOverlap(shingleSet(s, 0, 128), shingleSet(s, 0, 128)), 1);
  assert.equal(setOverlap(new Set([1, 2, 3]), new Set([4, 5, 6])), 0);
});

test('disjoint blocks of distinct prose do not overlap', () => {
  const s = uniqueProse(4000);
  const ov = setOverlap(shingleSet(s, 0, 128), shingleSet(s, 2048, 128));
  assert.ok(ov < 0.5, `disjoint blocks of distinct prose should not overlap, got ${ov}`);
});

test('fpDistance is 0 for equal fingerprints and counts differing bits', () => {
  assert.equal(fpDistance([1, 2, 3, 4], [1, 2, 3, 4]), 0);
  assert.equal(fpDistance([0, 0, 0, 0], [1, 0, 0, 0]), 1);
  assert.equal(fpDistance([0b1011, 0, 0, 0], [0, 0, 0, 0]), 3);
});

// ---------------------------------------------------------------------------
// Loop shapes must trip
// ---------------------------------------------------------------------------

test('exact-repeat fires for a byte-identical block when low-novelty is disabled', () => {
  // The repeated unit must be at least one block long and block-aligned, or the
  // block boundaries never line up and no two fingerprints can ever be equal.
  const longBlock =
    'The user asked about the reasoning configuration file and I should check the exact field name ' +
    'before answering, because guessing here would be worse than saying I do not know. ';
  assert.ok(longBlock.length >= DETECTOR_DEFAULTS.blockChars, 'unit must exceed one block');
  const detector = createDetector({ noveltyStreak: 9999 });
  const trip = run(detector, longBlock.repeat(80), 13);
  assert.notEqual(trip, null, 'a verbatim repeat must trip via exact-repeat');
  assert.equal(trip.rule, 'exact-repeat');
});

test('a verbatim English loop trips', () => {
  const trip = run(createDetector(), VERBATIM.repeat(80), 41);
  assert.notEqual(trip, null);
});

test('a near-verbatim English loop with a varying integer trips', () => {
  const text = Array.from({ length: 150 }, (_, i) => `${NEAR}${i}\n`).join('');
  assert.notEqual(run(createDetector(), text), null);
});

test('a near-verbatim English loop with an extra clause trips', () => {
  const text = Array.from({ length: 150 }, (_, i) => `${NEAR}attempt ${i} of 150.\n`).join('');
  assert.notEqual(run(createDetector(), text), null);
});

test('a two-block English ping-pong loop trips', () => {
  assert.notEqual(run(createDetector(), 'Let me reconsider. Actually wait. '.repeat(120)), null);
});

test('a repeated Chinese paragraph trips', () => {
  assert.notEqual(run(createDetector(), CJK.repeat(150)), null);
});

test('a near-verbatim Chinese loop with a varying counter trips', () => {
  const text = Array.from({ length: 250 }, (_, i) => `${CJK}第${i}次核对。\n`).join('');
  assert.notEqual(run(createDetector(), text), null);
});

test('an emoji-bearing repeated block trips', () => {
  const block = '先确认✅再核对🔍然后记录📝最后汇报📌另外注意⚠️细节🔎不要漏。';
  assert.notEqual(run(createDetector(), block.repeat(120)), null);
});

test('a repeated block trips even when the block boundary splits a surrogate pair', () => {
  // "a😀b😀c😀" repeats every 6 code units, so with blockChars=128 the boundary
  // falls at different parities across blocks and some blocks begin or end inside
  // a surrogate pair. The detector folds code points, so a lone surrogate must not
  // collapse the signature and hide the loop.
  const unit = 'a\u{1F600}b\u{1F600}c\u{1F600}';
  assert.notEqual(run(createDetector(), unit.repeat(300)), null, 'a split-surrogate repeat must trip');
});

test('distinct emoji heavy text does not trip', () => {
  const out = [];
  for (let i = 0; i < 400; i++) out.push(`第${i}项✅核对${(i * 7919) % 104729}🔍理由${(i * 13) % 9973}📝情形${(i * 31) % 7919}📌`);
  assert.equal(run(createDetector(), out.join(''), 512), null);
});

test('chunk size does not change the verdict on a loop', () => {
  const text = VERBATIM.repeat(80);
  for (const chunk of [1, 7, 37, 128, 4096]) {
    assert.notEqual(run(createDetector(), text, chunk), null, `loop must trip with chunk=${chunk}`);
  }
});

// ---------------------------------------------------------------------------
// Clean streams must never trip — the false-positive guard
// ---------------------------------------------------------------------------

test('ordinary unique English prose never trips', () => {
  assert.equal(run(createDetector(), uniqueProse(15000), 512), null);
});

test('long structured-but-varied English reasoning never trips', () => {
  assert.equal(run(createDetector(), variedReasoning(500), 512), null);
});

test('long structured-but-varied Chinese reasoning never trips', () => {
  assert.equal(run(createDetector(), variedCJK(500), 512), null);
});

// ---------------------------------------------------------------------------
// Character domain: reasoning text is often Chinese and emoji-bearing
// ---------------------------------------------------------------------------

test('astral characters are not folded onto BMP code points', () => {
  assert.notEqual(fnv1a('A', 0, 1), fnv1a('\u{1F600}', 0, 2));
  assert.notEqual(fnv1a('\uFF41', 0, 1), fnv1a('A', 0, 1));
  assert.notEqual(fnv1a('\u{1F600}', 0, 2), fnv1a('\uF600', 0, 1));
});

// ---------------------------------------------------------------------------
// Bounded memory
// ---------------------------------------------------------------------------

test('a long clean stream keeps its buffer bounded', () => {
  const detector = createDetector();
  run(detector, uniqueProse(40000), 512);
  assert.ok(
    detector.consumed < DETECTOR_DEFAULTS.blockChars,
    `unconsumed prefix must stay under one block, got ${detector.consumed}`,
  );
});

test('the block ring buffer never exceeds historyBlocks', () => {
  const detector = createDetector();
  run(detector, uniqueProse(30000), 512);
  assert.ok(detector.blocks <= DETECTOR_DEFAULTS.historyBlocks);
});

test('the measured defaults separate every loop shape from every clean corpus', () => {
  // Regression guard on the calibration table: if a rule or threshold changes
  // and breaks the separation, this fails before the plugin ships.
  const loops = [
    VERBATIM.repeat(80),
    Array.from({ length: 150 }, (_, i) => `${NEAR}${i}\n`).join(''),
    Array.from({ length: 150 }, (_, i) => `${NEAR}attempt ${i} of 150.\n`).join(''),
    'Let me reconsider. Actually wait. '.repeat(120),
    CJK.repeat(150),
    Array.from({ length: 250 }, (_, i) => `${CJK}第${i}次核对。\n`).join(''),
  ];
  for (const [i, text] of loops.entries()) {
    assert.notEqual(run(createDetector(), text, 512), null, `loop shape #${i} must trip`);
  }
  const cleans = [uniqueProse(15000), variedReasoning(500), variedCJK(500)];
  for (const [i, text] of cleans.entries()) {
    assert.equal(run(createDetector(), text, 512), null, `clean corpus #${i} must not trip`);
  }
});
