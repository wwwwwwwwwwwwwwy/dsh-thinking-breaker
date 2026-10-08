/**
 * Calibration probe (development tool, not shipped logic).
 *
 * Two sweeps, one per lens:
 *
 *   1. the repetition detector's block-overlap measure, over loop shapes and
 *      clean corpora — this is where `noveltyStreak` / `noveltyOverlap` /
 *      `blockChars` come from;
 *   2. the degeneracy detector's evidence flags, over degenerate streams and
 *      clean ones — this is where `evidenceMin` / `streak` come from.
 *
 * The shipped defaults in `lib/detector.js` and `lib/degeneracy.js` are set from
 * these tables instead of guessed.
 *
 * Run with: node tools/calibrate.mjs
 */

import { shingleSet, setOverlap, DETECTOR_DEFAULTS } from '../lib/detector.js';
import {
  blockFeatures,
  createDegeneracyDetector,
  degeneracyEvidence,
  isDegenerate,
  resolveThresholds,
  DEGENERACY_DEFAULTS,
} from '../lib/degeneracy.js';

/** Per-block max overlap against blocks within the detector's comparison range. */
function overlapSeries(text, blockChars, gap, history) {
  const sets = [];
  const out = [];
  for (let base = 0; base + blockChars <= text.length; base += blockChars) {
    const s = shingleSet(text, base, blockChars);
    let max = 0;
    for (let j = sets.length - 1; j >= 0; j--) {
      const d = sets.length - j;
      if (d < gap) continue;
      if (d > history) break;
      const ov = setOverlap(s, sets[j]);
      if (ov > max) max = ov;
    }
    sets.push(s);
    out.push(max);
    if (sets.length > history) sets.shift();
  }
  return out;
}

function longestRun(values, threshold) {
  let best = 0;
  let cur = 0;
  for (const v of values) {
    cur = v >= threshold ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

function uniqueProse(words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(`token${i}x${(i * 7919) % 104729} `);
  return out.join('');
}

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

const CJK = '让我再想想。这个问题的关键在于约束条件是否真的被满足了，需要逐一核对。';
const CJK_SHORT = '让我再想想。';

function variedCJK(sentences) {
  const out = [];
  for (let i = 0; i < sentences; i++) {
    out.push(`第${i}步：核对项${(i * 7919) % 104729}，理由${(i * 13) % 9973}指向情形${(i * 31) % 7919}。`);
  }
  return out.join('');
}

const CASES = {
  'LOOP verbatim en x40': 'The user asked about the configuration file. I should check the file. '.repeat(60),
  'LOOP near-verbatim (int)': Array.from(
    { length: 120 },
    (_, i) => `I need to verify the adapter accepts this reasoning effort value. ${i}\n`,
  ).join(''),
  'LOOP near-verbatim (clause)': Array.from(
    { length: 120 },
    (_, i) => `I need to verify the adapter accepts this reasoning effort value. attempt ${i} of 120.\n`,
  ).join(''),
  'LOOP ping-pong (2 blocks)': 'Let me reconsider. Actually wait. '.repeat(100),
  'LOOP cjk verbatim x120': CJK.repeat(120),
  'LOOP cjk + counter': Array.from({ length: 200 }, (_, i) => `${CJK}第${i}次核对。\n`).join(''),
  'LOOP cjk short + counter': Array.from({ length: 300 }, (_, i) => `${CJK_SHORT}${i}`).join(''),
  'CLEAN varied reasoning': variedReasoning(500),
  'CLEAN unique prose': uniqueProse(15000),
  'CLEAN varied cjk': variedCJK(500),
};

const THRESHOLDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const BLOCK_SIZES = [96, 128, 192, 256];

for (const blockChars of BLOCK_SIZES) {
  const gap = DETECTOR_DEFAULTS.minRepeatGap;
  const history = DETECTOR_DEFAULTS.historyBlocks;
  console.log(`\n=== blockChars=${blockChars} minRepeatGap=${gap} historyBlocks=${history} ===`);
  console.log(['case'.padEnd(26), ...THRESHOLDS.map((t) => String(t).padStart(5))].join(''));
  const runs = {};
  for (const [label, text] of Object.entries(CASES)) {
    const vals = overlapSeries(text, blockChars, gap, history);
    runs[label] = vals;
    console.log(
      [label.padEnd(26), ...THRESHOLDS.map((t) => String(longestRun(vals, t)).padStart(5))].join('') +
        `   max=${(vals.length ? Math.max(...vals) : 0).toFixed(2)}`,
    );
  }
  console.log('-- separation (cleanMaxRun vs loopMinRun) --');
  for (const t of THRESHOLDS) {
    const clean = Object.entries(runs)
      .filter(([k]) => k.startsWith('CLEAN'))
      .map(([, v]) => longestRun(v, t));
    const loops = Object.entries(runs)
      .filter(([k]) => k.startsWith('LOOP'))
      .map(([, v]) => longestRun(v, t));
    const cMax = Math.max(...clean);
    const lMin = Math.min(...loops);
    console.log(`  t=${t.toFixed(2)} cleanMaxRun=${String(cMax).padStart(3)} loopMinRun=${String(lMin).padStart(3)} ${lMin > cMax ? 'SEPARATED' : ''}`);
  }
}

// ===========================================================================
// 2. Degeneracy lens — evidence flags, over degenerate and clean streams
// ===========================================================================
//
// The question this sweep answers is not "where is the threshold" but "is there
// a setting where every degenerate shape trips and no clean shape does". Because
// `meaningless` is a hard gate, the answer is structural for anything containing
// words; the sweep exists to check the shapes that contain none, and to show how
// much headroom the defaults have.

/** The reported failure: literal asterisks, as a wall. */
const STAR_FLOOD = '*** '.repeat(200);
const STAR_LINES = '***\n'.repeat(200);
const STAR_ONE_RUN = '*'.repeat(600);
const EMOJI_ROTATING = '\u{1F600}\u{1F389}\u{1F525}'.repeat(200);
const EMOJI_SAME = '\u{1F600}'.repeat(400);
const CJK_PERIOD_FLOOD = '\u3002'.repeat(400);
const PUNCT_SOUP = '\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A'.repeat(120);
const EQUALS_FLOOD = '====='.repeat(80);
const PIPE_FLOOD = '||||||||| '.repeat(60);
const MIXED_SYMBOL_EMOJI = '*** \u{1F600} *** \u{1F389} *** \u{1F525} '.repeat(30);

/**
 * A flood with no repetition to speak of: 200 distinct pictographs cycled with a
 * stride co-prime to the block size. No two blocks are identical and the shingle
 * sets never line up, so the repetition lens is blind to it by construction.
 * This is the corpus that justifies a second lens existing at all.
 */
function variedEmojiFlood(count = 800) {
  const alphabet = [];
  for (let i = 0; i < 200; i++) alphabet.push(String.fromCodePoint(0x1f300 + i));
  const out = [];
  for (let i = 0; i < count; i++) out.push(alphabet[(i * 37) % alphabet.length]);
  return out.join('');
}

const DEGENERATE_CASES = {
  'DEGEN star flood (space)': STAR_FLOOD,
  'DEGEN star flood (line)': STAR_LINES,
  'DEGEN star single run': STAR_ONE_RUN,
  'DEGEN emoji rotating': EMOJI_ROTATING,
  'DEGEN emoji same': EMOJI_SAME,
  'DEGEN emoji varied (no repeat)': variedEmojiFlood(),
  'DEGEN cjk period flood': CJK_PERIOD_FLOOD,
  'DEGEN punctuation soup': PUNCT_SOUP,
  'DEGEN equals flood': EQUALS_FLOOD,
  'DEGEN pipe flood': PIPE_FLOOD,
  'DEGEN symbol + emoji': MIXED_SYMBOL_EMOJI,
};

/** Healthy reasoning that happens to contain markdown rules, tables and code. */
function healthyWithRules(sections = 200) {
  const out = [];
  for (let i = 0; i < sections; i++) {
    out.push(`第${i}步：核对项${(i * 7919) % 104729}，理由${(i * 13) % 9973}指向情形${(i * 31) % 7919}。`);
    if (i % 4 === 3) out.push('\n\n***\n\n');
    if (i % 7 === 6) out.push('\n\n---\n\n');
    if (i % 11 === 10) out.push(`\n| 列甲 | 列乙 |\n|---|---|\n| 值${i} | 值${i + 1} |\n`);
  }
  return out.join('\n');
}

const CLEAN_CASES = {
  'CLEAN varied reasoning': variedReasoning(600),
  'CLEAN unique prose': uniqueProse(20000),
  'CLEAN varied cjk': variedCJK(600),
  'CLEAN markdown rules in prose': healthyWithRules(),
  'CLEAN markdown table': '| 列一 | 列二 | 列三 |\n|---|---|---|\n| 值甲 | 值乙 | 值丙 |\n'.repeat(20),
  'CLEAN code block': 'const x = compute(a, b);\nif (x > 0) { return x; }\n'.repeat(40),
  'CLEAN long equals rule': `正文说明如下：\n${'='.repeat(200)}\n以上是全部内容说明。\n`.repeat(4),
  'CLEAN emoji as annotation': '先确认✅再核对🔍然后记录📝最后汇报📌另外注意⚠️细节🔎不要漏。'.repeat(40),
  'CLEAN base64': 'aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmdlciBiYXNlNjQgc3RyaW5nIA=='.repeat(20),
  'CLEAN numeric table': Array.from({ length: 400 }, (_, i) => `${i * 7919},`).join(''),
  'CLEAN ascii box': '+----------------------+\n| 名称 | 数值 | 说明 |\n+----------------------+\n'.repeat(20),
};

/** First trip over a corpus, or null. */
function firstDegeneracyTrip(text, overrides = {}) {
  const detector = createDegeneracyDetector(overrides);
  for (let i = 0; i < text.length; i += 512) {
    const trip = detector.push(text.slice(i, i + 512));
    if (trip !== null) return trip;
  }
  return null;
}

const DEG_BLOCK = DEGENERACY_DEFAULTS.blockChars;
const DEG_THRESHOLDS = resolveThresholds({});

console.log(`\n=== degeneracy lens: per-block evidence (blockChars=${DEG_BLOCK}, defaults) ===`);
console.log(
  ['case'.padEnd(32), 'meaning', 'noise', 'variety', 'emoji', 'maxRun', 'runs', 'gate', 'flags', 'trip@'].join('  '),
);
for (const [label, text] of [...Object.entries(DEGENERATE_CASES), ...Object.entries(CLEAN_CASES)]) {
  const f = blockFeatures(text, 0, DEG_BLOCK);
  const evidence = degeneracyEvidence(f, DEG_THRESHOLDS);
  const trip = firstDegeneracyTrip(text);
  console.log(
    [
      label.padEnd(32),
      f.meaningRatio.toFixed(3).padStart(7),
      f.noiseRatio.toFixed(2).padStart(5),
      f.variety.toFixed(2).padStart(7),
      String(f.emoji).padStart(5),
      String(f.maxRun).padStart(6),
      String(f.runCount).padStart(4),
      (evidence.includes('meaningless') ? 'open' : 'shut').padStart(4),
      String(evidence.length - (evidence.includes('meaningless') ? 1 : 0)).padStart(5),
      (trip === null ? '-' : `blk${trip.block}`).padStart(6),
    ].join('  '),
  );
}

console.log('\n=== degeneracy lens: separation sweep (cleanTrips / degenerateMisses) ===');
console.log('evidenceMin \\ streak   1       2       3       4');
for (const evidenceMin of [1, 2, 3, 4]) {
  const row = [];
  for (const streak of [1, 2, 3, 4]) {
    const overrides = { evidenceMin, streak };
    const cleanTrips = Object.values(CLEAN_CASES).filter((t) => firstDegeneracyTrip(t, overrides) !== null).length;
    const degMisses = Object.values(DEGENERATE_CASES).filter((t) => firstDegeneracyTrip(t, overrides) === null).length;
    row.push(`${String(cleanTrips).padStart(2)}/${String(degMisses).padEnd(2)}`.padStart(6));
  }
  console.log(`         ${evidenceMin}          ${row.join('  ')}`);
}
console.log('  (the shipped default is evidenceMin=2, streak=2 -> 0/0)');

console.log('\n=== degeneracy lens: is the gate load-bearing? ===');
{
  const gateOn = Object.values(CLEAN_CASES).filter((t) => firstDegeneracyTrip(t) !== null).length;
  const gateOff = Object.values(CLEAN_CASES).filter(
    (t) => firstDegeneracyTrip(t, { meaningRatioMax: 1 }) !== null,
  ).length;
  console.log(`  clean corpora tripping with the gate: ${gateOn}`);
  console.log(`  clean corpora tripping without it (meaningRatioMax=1): ${gateOff}`);
  console.log(
    gateOff > gateOn
      ? '  -> the hard gate is what keeps markdown, code and tables safe.'
      : '  -> no clean corpus is at risk either way at these settings.',
  );
}
