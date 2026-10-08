/**
 * Unit tests for the pure degeneracy detector. Run with:
 *   node --test test/degeneracy.test.mjs
 *
 * Two things are pinned here:
 *
 *   1. **Every degenerate shape trips** — a wall of `***`, a rotating emoji
 *      flood, punctuation soup — and it trips *early*, at the second block, long
 *      before the repetition rules could see anything.
 *   2. **No clean shape ever trips**, including the ones that look structurally
 *      similar to a flood: markdown rules, tables, code fences, dense code,
 *      base64, numeric tables, arrow chains, ASCII boxes and emoji used as
 *      ordinary annotation. The `meaningless` hard gate is what makes this a
 *      property rather than a hope, so it is tested directly as well.
 *
 * Thresholds these assertions rely on are justified by tools/calibrate.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockFeatures,
  classifyCodePoint,
  createDegeneracyDetector,
  degeneracyEvidence,
  degeneracyRule,
  isDegenerate,
  isEmojiCodePoint,
  resolveThresholds,
  KIND_EMOJI,
  KIND_MEANING,
  KIND_SPACE,
  KIND_SYMBOL,
  DEGENERACY_DEFAULTS,
} from '../lib/degeneracy.js';

/** Feed a whole string in fixed-size chunks; return the first trip. */
function run(detector, text, chunk = 37) {
  for (let i = 0; i < text.length; i += chunk) {
    const trip = detector.push(text.slice(i, i + chunk));
    if (trip !== null) return trip;
  }
  return null;
}

/** Feed and return the trip, using the shipped defaults. */
function tripOf(text, chunk = 37, overrides = {}) {
  return run(createDegeneracyDetector(overrides), text, chunk);
}

const THRESHOLDS = resolveThresholds({});

// ---------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------

/** Degenerate: a wall of markdown emphasis markers, the reported failure. */
const STAR_FLOOD = '*** '.repeat(120);
const STAR_LINES = '***\n'.repeat(120);
const STAR_ONE_RUN = '*'.repeat(400);
const EMOJI_ROTATING = '\u{1F600}\u{1F389}\u{1F525}'.repeat(120);
const EMOJI_SAME = '\u{1F600}'.repeat(300);
const CJK_PERIOD_FLOOD = '\u3002'.repeat(300);
const QUESTION_FLOOD = '?'.repeat(300);
const BACKTICK_FLOOD = '`'.repeat(300);
const UNDERSCORE_FLOOD = '___ '.repeat(100);
const PIPE_FLOOD = '||||||||| '.repeat(40);
const EQUALS_FLOOD = '====='.repeat(60);
const MIXED_SYMBOL_EMOJI = '*** \u{1F600} *** \u{1F389} *** \u{1F525} '.repeat(20);
const CJK_PUNCT_MIX = '\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A'.repeat(50);

const DEGENERATE = {
  'star flood (space separated)': STAR_FLOOD,
  'star flood (line separated)': STAR_LINES,
  'one very long star run': STAR_ONE_RUN,
  'rotating emoji flood': EMOJI_ROTATING,
  'repeated single emoji': EMOJI_SAME,
  'cjk period flood': CJK_PERIOD_FLOOD,
  'question mark flood': QUESTION_FLOOD,
  'backtick flood': BACKTICK_FLOOD,
  'underscore flood': UNDERSCORE_FLOOD,
  'pipe flood': PIPE_FLOOD,
  'equals flood': EQUALS_FLOOD,
  'symbol and emoji mixed': MIXED_SYMBOL_EMOJI,
  'cjk punctuation soup': CJK_PUNCT_MIX,
};

function variedReasoning(sentences) {
  const out = [];
  for (let i = 0; i < sentences; i++) {
    out.push(
      `Step ${i}: I should verify the adapter because reason${(i * 13) % 9973} suggests case ${(i * 31) % 7919}. `,
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

const CLEAN = {
  'varied english reasoning': variedReasoning(600),
  'varied chinese reasoning': variedCJK(600),
  'markdown emphasis and rule': '这里要强调 **重点** 内容，然后换行。\n\n---\n\n接下来是第二段说明文字。\n\n'.repeat(12),
  'markdown table': '| 列一 | 列二 | 列三 |\n|---|---|---|\n| 值甲 | 值乙 | 值丙 |\n'.repeat(10),
  'wide markdown table': '| 一 | 二 | 三 | 四 | 五 | 六 | 七 | 八 | 九 | 十 |\n|---|---|---|---|---|---|---|---|---|---|\n'.repeat(4),
  'code block': 'const x = compute(a, b);\nif (x > 0) { return x; }\n'.repeat(20),
  'long equals rule inside prose': `下面是结论：\n${'='.repeat(60)}\n然后继续解释为什么这个结论成立。\n`.repeat(6),
  'very long equals rule inside prose': `正文说明如下：\n${'='.repeat(200)}\n以上是全部内容说明。\n`,
  'arrow chain reasoning': 'A → B → C → D → E → F → G → H 表示依赖链。'.repeat(8),
  'emoji as annotation': '先确认✅再核对🔍然后记录📝最后汇报📌另外注意⚠️细节🔎不要漏。'.repeat(10),
  'json fragment': '{"name":"dsh","version":"0.2.0","deps":["cordis","schemastery"]}'.repeat(6),
  'numeric table': Array.from({ length: 200 }, (_, i) => `${i * 7919},`).join(''),
  'base64 blob': 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmdlciBiYXNlNjQgc3RyaW5nIA=='.repeat(6),
  'bullets with words': '* 检查 * 检查 * 检查 * 检查 * 检查 * 检查 '.repeat(10),
  'math expression': 'f(x) = ∫ x^2 dx = 1/3，这是定积分的计算结果。'.repeat(8),
  'windows path list': 'C:\\Users\\a\\b\\c.txt, D:\\x\\y\\z.log, E:\\m\\n\\o.ini'.repeat(6),
  'ascii box with labels': '+----------------------+\n| 名称 | 数值 | 说明 |\n+----------------------+\n'.repeat(6),
  'regex literals': '^[a-zA-Z0-9_-]{3,16}$ 和 \\d{4}-\\d{2}-\\d{2} 是两种常见模式。'.repeat(6),
  'whitespace only': ' '.repeat(400),
};

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------

test('markdown markers and punctuation are symbols, not emoji', () => {
  for (const ch of ['*', '#', '=', '-', '_', '~', '`', '|', '.', ',', '!', '?', '\u3002', '\uFF0C']) {
    assert.equal(classifyCodePoint(ch.codePointAt(0)), KIND_SYMBOL, `${ch} must be a symbol`);
  }
});

test('arrows are text symbols, not emoji', () => {
  // U+2194 IS Extended_Pictographic, so the deny-list is doing real work here:
  // arrow chains are ordinary reasoning notation, not an emoji flood.
  for (const ch of ['\u2190', '\u2192', '\u2194', '\u21D2', '\u00A9', '\u00AE', '\u2122']) {
    assert.equal(isEmojiCodePoint(ch.codePointAt(0)), false, `${ch} must not count as emoji`);
    assert.equal(classifyCodePoint(ch.codePointAt(0)), KIND_SYMBOL);
  }
});

test('letters and digits are meaning, in both scripts', () => {
  for (const ch of ['a', 'Z', '0', '9', '中', '文', '\uFF11']) {
    assert.equal(classifyCodePoint(ch.codePointAt(0)), KIND_MEANING, `${ch} must be meaning`);
  }
});

test('whitespace is space, in both widths', () => {
  for (const ch of [' ', '\n', '\t', '\r', '\u3000']) {
    assert.equal(classifyCodePoint(ch.codePointAt(0)), KIND_SPACE, `${JSON.stringify(ch)} must be space`);
  }
});

test('pictographs and emoji sequence code points are emoji', () => {
  for (const ch of ['\u{1F600}', '\u{1F525}', '\u2705', '\u{1F1E6}', '\uFE0F', '\u200D']) {
    assert.equal(isEmojiCodePoint(ch.codePointAt(0)), true, `${ch} must count as emoji`);
  }
});

// ---------------------------------------------------------------------------
// Block features
// ---------------------------------------------------------------------------

test('a star flood measures as meaningless, noisy and low-variety', () => {
  const f = blockFeatures(STAR_FLOOD, 0, DEGENERACY_DEFAULTS.blockChars);
  assert.equal(f.meaning, 0, 'a star flood contains no letters or digits');
  assert.equal(f.meaningRatio, 0);
  assert.equal(f.noiseRatio, 1, 'every non-space code point is a symbol');
  assert.ok(f.variety < 0.1, `variety should be tiny, got ${f.variety}`);
  assert.ok(f.runCount >= DEGENERACY_DEFAULTS.runCountMin, 'a flood has many runs');
});

test('a single long rule is one run, a flood is many — the separator discriminator', () => {
  const oneRun = blockFeatures(`${'='.repeat(100)}\n`, 0, 128);
  const manyRuns = blockFeatures(`${'===== '.repeat(18)}\n`, 0, 128);
  assert.equal(oneRun.runCount, 1, 'a markdown rule is exactly one run');
  assert.ok(manyRuns.runCount > oneRun.runCount, 'a flood is many runs');
  assert.ok(manyRuns.runCount >= DEGENERACY_DEFAULTS.runCountMin);
});

test('runs shorter than three code points are not counted', () => {
  // `**bold**` must not register as a symbol run; `***` must.
  const bold = blockFeatures(`${'**x** '.repeat(20)}\n`, 0, 128);
  const triple = blockFeatures(`${'*** '.repeat(30)}\n`, 0, 128);
  assert.ok(triple.runCount > bold.runCount, '*** runs count, ** runs do not');
});

test('prose measures as meaningful with high variety', () => {
  const f = blockFeatures(variedCJK(50), 0, 128);
  assert.ok(f.meaningRatio > 0.5, `cjk prose must be meaningful, got ${f.meaningRatio}`);
  assert.ok(f.variety > DEGENERACY_DEFAULTS.varietyRatioMax, `variety must clear the bar, got ${f.variety}`);
});

test('an astral-only block counts code points, not UTF-16 units', () => {
  // 300 emoji are 600 UTF-16 units; a 128-code-unit block therefore holds 64 of
  // them and the measurement must not be halved by the surrogate pairs.
  const f = blockFeatures(EMOJI_SAME, 0, 128);
  assert.equal(f.emoji, 64, 'the block holds 64 code points, each a surrogate pair');
  assert.equal(f.n, 64);
  assert.equal(f.emojiRatio, 1);
});

// ---------------------------------------------------------------------------
// The rule: a hard gate plus a vote
// ---------------------------------------------------------------------------

test('the meaningless gate alone is never sufficient', () => {
  // `evidenceMin` counts the SECONDARY flags; the gate is separate. One
  // secondary signal is never enough.
  assert.equal(isDegenerate(['meaningless'], THRESHOLDS), false);
  assert.equal(isDegenerate(['meaningless', 'noisy'], THRESHOLDS), false);
  assert.equal(isDegenerate(['meaningless', 'noisy', 'low-variety'], THRESHOLDS), true);
});

test('a block with words is never degenerate, whatever else fires', () => {
  // This is the property the whole design rests on: no amount of symbol noise
  // can flag a block that still carries lexical content.
  const withWords = ['noisy', 'low-variety', 'run-heavy', 'emoji-flood'];
  assert.equal(isDegenerate(withWords, THRESHOLDS), false);
  assert.equal(isDegenerate([...withWords, 'meaningless'], THRESHOLDS), true);
});

test('a purely symbolic block still needs two secondary signals', () => {
  const one = { ...THRESHOLDS, evidenceMin: 1 };
  assert.equal(isDegenerate(['meaningless', 'noisy'], one), true, 'one secondary suffices when asked');
  assert.equal(isDegenerate(['meaningless'], one), false, 'the gate still needs a secondary signal');
});

test('the trip is named after the most specific evidence', () => {
  assert.equal(degeneracyRule(['meaningless', 'noisy', 'run-heavy']), 'symbol-flood');
  assert.equal(degeneracyRule(['meaningless', 'emoji-flood']), 'emoji-flood');
  assert.equal(degeneracyRule(['meaningless', 'noisy', 'low-variety']), 'degenerate-output');
});

test('evidence and thresholds line up on a real flood', () => {
  const f = blockFeatures(EMOJI_ROTATING, 0, 128);
  const evidence = degeneracyEvidence(f, THRESHOLDS);
  assert.ok(evidence.includes('meaningless'));
  assert.ok(evidence.includes('emoji-flood'));
  assert.equal(isDegenerate(evidence, THRESHOLDS), true);
});

// ---------------------------------------------------------------------------
// Degenerate streams must trip, and trip early
// ---------------------------------------------------------------------------

for (const [label, text] of Object.entries(DEGENERATE)) {
  test(`degenerate: ${label} trips`, () => {
    const trip = tripOf(text);
    assert.notEqual(trip, null, `${label} must trip`);
    assert.ok(Array.isArray(trip.evidence) && trip.evidence.length >= 2, 'a trip must carry its evidence');
    assert.ok(trip.evidence.includes('meaningless'), 'every trip must pass the hard gate');
  });
}

test('a star flood trips at the second block, well before the repetition rules', () => {
  const trip = tripOf(STAR_FLOOD);
  assert.notEqual(trip, null);
  assert.equal(trip.rule, 'symbol-flood');
  assert.equal(trip.block, 1, 'two blocks = 256 code units is the whole confirmation window');
  assert.equal(trip.blockChars, DEGENERACY_DEFAULTS.blockChars);
  assert.equal(trip.streak, DEGENERACY_DEFAULTS.streak);
  assert.ok(trip.fingerprint > 0, 'a trip carries a stable block signature for logs');
});

test('an emoji flood is reported as an emoji flood, not a symbol flood', () => {
  const trip = tripOf(EMOJI_ROTATING);
  assert.equal(trip.rule, 'emoji-flood');
  assert.ok(trip.evidence.includes('emoji-flood'));
});

test('chunk size does not change the verdict on a flood', () => {
  for (const chunk of [1, 3, 37, 128, 4096]) {
    assert.notEqual(tripOf(STAR_FLOOD, chunk), null, `flood must trip with chunk=${chunk}`);
  }
});

test('a flood reached through a surrogate-splitting chunk still trips', () => {
  // With chunk=1 the caller hands over one UTF-16 unit at a time, so half the
  // pushes end inside a surrogate pair. The block buffer is a plain string, so
  // reassembly must still yield whole code points.
  assert.notEqual(tripOf(EMOJI_ROTATING, 1), null);
  assert.notEqual(tripOf(EMOJI_SAME, 1), null);
});

test('degStreak=1 trips on the first block', () => {
  const trip = tripOf(STAR_FLOOD, 37, { streak: 1 });
  assert.equal(trip.block, 0);
});

test('a stricter evidenceMin suppresses the marginal shapes', () => {
  // The cjk punctuation soup raises meaningless + noisy + low-variety and no
  // run-heavy, so requiring three secondary signals must silence it.
  assert.notEqual(tripOf(CJK_PUNCT_MIX), null);
  assert.equal(tripOf(CJK_PUNCT_MIX, 37, { evidenceMin: 3 }), null);
});

test('a wider streak window delays the trip without losing it', () => {
  // Long enough to hold four whole blocks, so the window is the only variable.
  const trip = tripOf('*** '.repeat(400), 37, { streak: 4 });
  assert.notEqual(trip, null);
  assert.equal(trip.block, 3, 'four blocks = 512 code units before aborting');
});

test('the block size is configurable and is honoured in the descriptor', () => {
  const trip = tripOf(STAR_FLOOD, 37, { blockChars: 64 });
  assert.notEqual(trip, null);
  assert.equal(trip.blockChars, 64);
});

// ---------------------------------------------------------------------------
// Clean streams must never trip — the false-positive guard
// ---------------------------------------------------------------------------

for (const [label, text] of Object.entries(CLEAN)) {
  test(`clean: ${label} never trips`, () => {
    assert.equal(tripOf(text, 512), null, `${label} must not trip`);
  });
}

test('a clean stream never trips at any chunk size', () => {
  for (const chunk of [1, 7, 37, 128, 4096]) {
    assert.equal(tripOf(variedCJK(200), chunk), null, `clean text must survive chunk=${chunk}`);
  }
});

test('a legitimate markdown rule inside prose is not a flood', () => {
  // The closest legitimate shape to the reported failure: `***` really does
  // appear in healthy output, as an emphasis or horizontal rule.
  const healthy = [
    '结论如下：',
    '',
    '***',
    '',
    '第一，约束条件需要逐一核对，不能想当然。',
    '',
    '---',
    '',
    '第二，边界情况要单独验证，尤其是空输入和超长输入。',
    '',
  ]
    .join('\n')
    .repeat(20);
  assert.equal(tripOf(healthy, 512), null);
});

test('an isolated symbol-only block does not trip on its own', () => {
  // One block of pure symbols can be a wide table separator or a code fence.
  // The streak requirement is what makes it harmless.
  const separator = `${'|'.repeat(126)}\n`;
  assert.equal(tripOf(`${separator}${variedCJK(400)}`, 512), null);
});

// ---------------------------------------------------------------------------
// Bounded memory
// ---------------------------------------------------------------------------

test('a long clean stream keeps its buffer bounded', () => {
  const detector = createDegeneracyDetector();
  run(detector, variedCJK(20000), 512);
  assert.ok(
    detector.consumed < DEGENERACY_DEFAULTS.blockChars,
    `unconsumed prefix must stay under one block, got ${detector.consumed}`,
  );
});

// ---------------------------------------------------------------------------
// Regression guard on the calibration table
// ---------------------------------------------------------------------------

test('the measured defaults separate every degenerate shape from every clean corpus', () => {
  for (const [label, text] of Object.entries(DEGENERATE)) {
    assert.notEqual(tripOf(text, 512), null, `degenerate corpus "${label}" must trip`);
  }
  for (const [label, text] of Object.entries(CLEAN)) {
    assert.equal(tripOf(text, 512), null, `clean corpus "${label}" must not trip`);
  }
});

test('threshold overrides never produce an undefined field', () => {
  for (const value of [undefined, null, {}, { streak: 0 }, { evidenceMin: -1 }, { meaningRatioMax: 'x' }]) {
    const resolved = resolveThresholds(value);
    for (const [k, v] of Object.entries(resolved)) {
      assert.notEqual(v, undefined, `resolveThresholds(${JSON.stringify(value)}).${k} must be defined`);
      assert.equal(Number.isFinite(v), true, `${k} must be a finite number`);
    }
  }
});
