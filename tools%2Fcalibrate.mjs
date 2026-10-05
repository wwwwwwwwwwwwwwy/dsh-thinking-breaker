/**
 * Calibration probe (development tool, not shipped logic).
 *
 * Feeds realistic reasoning shapes through the detector's block-overlap measure
 * and reports the longest consecutive run above each candidate threshold. The
 * shipped defaults in lib/detector.js are set from this table instead of guessed.
 *
 * Run with: node tools/calibrate.mjs
 */

import { shingleSet, setOverlap, DETECTOR_DEFAULTS } from '../lib/detector.js';

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
