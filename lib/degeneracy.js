/**
 * Pure degeneracy detector — the second lens over the reasoning stream.
 * No DSH imports, no I/O, so it is unit-testable in isolation and pinned by
 * `test/degeneracy.test.mjs`.
 *
 * ## Why this exists next to `detector.js`
 *
 * `detector.js` answers one question: *is this text repeating itself?* It is
 * blind to a different, equally common collapse — a stream that stops carrying
 * meaning without repeating. The reported shape is literal punctuation and
 * emoji: a wall of `***`, `*****`, `。。。。`, `????`, or a rotating run of
 * emoji. None of that is a "repeat" in the whole-block fingerprint sense, and the
 * shingle rule is unreliable against it: a rotating emoji set keeps its shingle
 * overlap high enough to slip through, while a single long `====` separator
 * looks like a legitimate markdown rule and must NOT trip.
 *
 * So this module measures **what a block is made of** rather than **whether it
 * has been seen before**. The two detectors run side by side and either can abort
 * the request.
 *
 * ## Why several signals ANDed, and not one rule
 *
 * A single "mostly punctuation" rule cannot be shipped: markdown separators
 * (`---`, `***`, `===`), tables (`|---|---|`), code fences, ASCII box drawing
 * and dense code all legitimately look like that for one block. A single
 * "too few distinct characters" rule cannot be shipped either: a long numeric
 * table, a base64 blob and a repeated file path all score low on variety while
 * being perfectly meaningful.
 *
 * Each block therefore yields a set of **independent evidence flags**, and the
 * decision is:
 *
 *   degenerate(block)  =  `meaningless`  AND  at least `evidenceMin` others
 *
 * `meaningless` is a **hard gate**, not a vote. It fires only when a block has
 * almost no letters and no digits at all (`meaningRatioMax`, default 0.08), which
 * buys a guarantee that is worth more than any threshold tuning:
 *
 *   > A block carrying real lexical content can never be degenerate.
 *   > Every false-positive risk listed above — markdown tables, dense code,
 *   > base64, numeric tables, arrow chains, JSON, `====` rules surrounded by
 *   > prose — contains words, so all of them are excluded by construction.
 *
 * The remaining flags then vote among themselves, so the rule stays
 * multi-signal rather than a single test: an OR would fire on ordinary markdown,
 * and "do not disturb normal thinking" is a hard requirement here, not a
 * preference. On top of that, degeneracy must persist for `streak` consecutive
 * blocks, which keeps one isolated oddity from aborting a healthy stream.
 *
 * ## The signals
 *
 * | Flag | Reads | Fires when |
 * |---|---|---|
 * | `meaningless` | letters + digits over non-space | **gate**: almost no lexical content |
 * | `noisy` | punctuation + emoji over non-space | the block is mostly symbols |
 * | `low-variety` | distinct code points over the first 48 | a handful of glyphs reused |
 * | `run-heavy` | longest / count of symbol runs (>= 3) | one absurd run, or many runs |
 * | `emoji-flood` | emoji count and density | emoji are the block's substance |
 *
 * `run-heavy` is what separates a `***` flood from a `====` rule: a separator is
 * **one** run, the flood is **many**. Both are covered (`runCountMin` /
 * `runLenMin`), and neither is sufficient on its own.
 *
 * The two arms stay complementary rather than overlapping: degenerate-but-wordy
 * shapes — `* 检查 * 检查 * 检查`, `好的好的好的` — carry lexical content and are
 * therefore out of scope here, and are exactly what `detector.js`'s repetition
 * rules catch.
 *
 * ## What this deliberately does not do
 *
 * It does not look at semantics. A model circling the same *idea* in fresh
 * wording is invisible here (that is `detector.js`'s near-verbatim rule, and even
 * that only sees wording). It does not rewind context. It does not choose which
 * stream to watch — the caller decides what it feeds in.
 */

const FNV_OFFSET = 0x811c9dc5;

/** Number of non-space code points over which variety is measured. */
const VARIETY_WINDOW = 48;
/** Symbol runs shorter than this are not counted as runs at all. */
const RUN_MIN = 3;

/** Code-point classes. Integers, not strings: this runs once per code point. */
export const KIND_SPACE = 0;
export const KIND_MEANING = 1;
export const KIND_EMOJI = 2;
export const KIND_SYMBOL = 3;

/**
 * `\p{Extended_Pictographic}` is the precise test and every official Node build
 * carries the ICU tables for it. The fallback exists only so a build without
 * property escapes degrades to a coarse range check instead of throwing inside a
 * stream listener — a throw there closes the turn directly (see lib/index.js).
 */
const EMOJI_RE = (() => {
  try {
    return /\p{Extended_Pictographic}/u;
  } catch {
    return null;
  }
})();

/**
 * Pictographic code points that ordinary technical prose uses as text. They are
 * reclassified as symbols, which costs nothing for detection — symbols feed the
 * same `noisy` signal — and avoids calling an arrow chain "emoji".
 */
const TEXT_SYMBOL_RANGES = [
  [0x00a9, 0x00a9], // (c)
  [0x00ae, 0x00ae], // (r)
  [0x203c, 0x203c],
  [0x2049, 0x2049],
  [0x2122, 0x2122], // (tm)
  [0x2139, 0x2139],
  [0x2190, 0x21ff], // arrows
  [0x25aa, 0x25ab],
  [0x25fb, 0x25fe],
  [0x2900, 0x297f], // supplemental arrows
  [0x2b00, 0x2bff], // misc symbols and arrows (incl. the star bullet)
  [0x3030, 0x3030],
  [0x303d, 0x303d],
  [0x3297, 0x3297],
  [0x3299, 0x3299],
];

/**
 * Code points that belong to an emoji sequence without being pictographic
 * themselves: the zero-width joiner, both variation selectors, the combining
 * keycap, the skin-tone modifiers and the regional indicators used for flags.
 */
const EMOJI_SEQUENCE_RANGES = [
  [0x200d, 0x200d],
  [0x20e3, 0x20e3],
  [0xfe0e, 0xfe0f],
  [0x1f1e6, 0x1f1ff],
  [0x1f3fb, 0x1f3ff],
];

/** Coarse emoji ranges, used only when the property escape is unavailable. */
const EMOJI_FALLBACK_RANGES = [
  [0x2300, 0x23ff],
  [0x2600, 0x27bf],
  [0x1f000, 0x1f2ff],
  [0x1f300, 0x1faff],
];

/** Ranges are sorted, so a code point below the first range cannot match. */
function inRanges(cp, ranges) {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/** True for a code point that should count as an emoji glyph. */
export function isEmojiCodePoint(cp) {
  if (inRanges(cp, TEXT_SYMBOL_RANGES)) return false;
  if (inRanges(cp, EMOJI_SEQUENCE_RANGES)) return true;
  if (EMOJI_RE !== null) return EMOJI_RE.test(String.fromCodePoint(cp));
  return inRanges(cp, EMOJI_FALLBACK_RANGES);
}

const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /\s/u;

/**
 * Classify one code point. Letters (including CJK) and digits are `MEANING`;
 * whitespace is `SPACE`; pictographs are `EMOJI`; everything else — ASCII and CJK
 * punctuation, markdown markers, math symbols — is `SYMBOL`.
 */
export function classifyCodePoint(cp) {
  if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)) return KIND_SPACE;
  if (isEmojiCodePoint(cp)) return KIND_EMOJI;
  const ch = String.fromCodePoint(cp);
  if (LETTER_OR_NUMBER_RE.test(ch)) return KIND_MEANING;
  if (SPACE_RE.test(ch)) return KIND_SPACE;
  return KIND_SYMBOL;
}

/**
 * Measure one block. `base` is a UTF-16 offset and `blockChars` counts UTF-16
 * code units, exactly like `detector.js`, so both detectors cut the same stream
 * at the same boundaries.
 */
export function blockFeatures(str, base, blockChars) {
  const limit = Math.min(base + blockChars, str.length);
  let n = 0;
  let spaces = 0;
  let meaning = 0;
  let emoji = 0;
  let symbol = 0;
  let maxRun = 0;
  let runCount = 0;
  let runCp = -1;
  let runLen = 0;
  const distinct = new Set();

  let i = base;
  while (i < limit) {
    const cp = str.codePointAt(i);
    if (cp === undefined) break;
    i += cp > 0xffff ? 2 : 1;
    n += 1;
    distinct.add(cp);

    const kind = classifyCodePoint(cp);
    if (kind === KIND_SPACE) {
      if (runLen >= RUN_MIN) runCount += 1;
      runCp = -1;
      runLen = 0;
      spaces += 1;
      continue;
    }
    if (kind === KIND_MEANING) {
      if (runLen >= RUN_MIN) runCount += 1;
      runCp = -1;
      runLen = 0;
      meaning += 1;
      continue;
    }
    // Non-meaningful and non-space: a candidate for a symbol run.
    if (kind === KIND_EMOJI) emoji += 1;
    else symbol += 1;
    if (cp === runCp) runLen += 1;
    else {
      if (runLen >= RUN_MIN) runCount += 1;
      runCp = cp;
      runLen = 1;
    }
    if (runLen > maxRun) maxRun = runLen;
  }
  if (runLen >= RUN_MIN) runCount += 1;

  const nonSpace = n - spaces;
  const denom = Math.max(1, nonSpace);
  return {
    n,
    nonSpace,
    meaning,
    emoji,
    symbol,
    maxRun,
    runCount,
    distinct: distinct.size,
    /** letters + digits, over non-space code points. */
    meaningRatio: meaning / denom,
    /** punctuation + emoji, over non-space code points. */
    noiseRatio: (symbol + emoji) / denom,
    /** distinct glyphs over the first VARIETY_WINDOW non-space code points. */
    variety: distinct.size / Math.max(1, Math.min(nonSpace, VARIETY_WINDOW)),
    /** emoji, over non-space code points. */
    emojiRatio: emoji / denom,
  };
}

/** Measured defaults. `tools/calibrate.mjs` sweeps both corpora against them. */
export const DEGENERACY_DEFAULTS = {
  /**
   * Shared with the repetition detector so both cut the stream identically.
   * 128 code units is the size calibrated in `detector.js`; there is no reason
   * for a second opinion about block size.
   */
  blockChars: 128,
  /**
   * How many **secondary** flags must also fire, on top of the `meaningless`
   * hard gate, before a block counts as degenerate. 2 is the smallest value that
   * admits every degenerate shape measured in `tools/calibrate.mjs`; the gate
   * alone already carries the false-positive guarantee.
   */
  evidenceMin: 2,
  /**
   * Consecutive degenerate blocks before aborting. 2 blocks = 256 code units,
   * roughly a fifth of what the repetition rule needs, which is deliberate: a
   * stream made of `***` is unambiguous long before it is repetitive. Raising it
   * is the first thing to try if a workload trips on legitimate ASCII art.
   */
  streak: 2,
  /** `meaningless`: letters + digits / non-space must be at or below this. */
  meaningRatioMax: 0.08,
  /** `noisy`: punctuation + emoji / non-space must be at or above this. */
  noiseRatioMin: 0.65,
  /** `low-variety`: distinct glyphs / first 48 non-space must be at or below this. */
  varietyRatioMax: 0.3,
  /** `run-heavy`: one symbol run at least this long. */
  runLenMin: 24,
  /** `run-heavy`: this many symbol runs of >= 3 code points. */
  runCountMin: 3,
  /** `emoji-flood`: at least this many emoji in one block. */
  emojiMin: 8,
  /** `emoji-flood`: emoji density at or above this. */
  emojiRatioMin: 0.4,
};

/** FNV-1a over a string, used only to expose a stable block signature in logs. */
function hash32(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function num(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampRatio(value, fallback) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** Resolve the signal thresholds from overrides, falling back per field. */
export function resolveThresholds(overrides = {}) {
  const o = overrides ?? {};
  const d = DEGENERACY_DEFAULTS;
  return {
    evidenceMin: num(o.evidenceMin, d.evidenceMin),
    streak: num(o.streak, d.streak),
    meaningRatioMax: clampRatio(o.meaningRatioMax, d.meaningRatioMax),
    noiseRatioMin: clampRatio(o.noiseRatioMin, d.noiseRatioMin),
    varietyRatioMax: clampRatio(o.varietyRatioMax, d.varietyRatioMax),
    runLenMin: num(o.runLenMin, d.runLenMin),
    runCountMin: num(o.runCountMin, d.runCountMin),
    emojiMin: num(o.emojiMin, d.emojiMin),
    emojiRatioMin: clampRatio(o.emojiRatioMin, d.emojiRatioMin),
  };
}

/**
 * The evidence flags a block raises. Exported so `tools/calibrate.mjs` can print
 * *why* a corpus scored what it scored, instead of only that it did.
 */
export function degeneracyEvidence(features, thresholds) {
  const out = [];
  if (features.meaningRatio <= thresholds.meaningRatioMax) out.push('meaningless');
  if (features.noiseRatio >= thresholds.noiseRatioMin) out.push('noisy');
  if (features.variety <= thresholds.varietyRatioMax) out.push('low-variety');
  if (features.maxRun >= thresholds.runLenMin || features.runCount >= thresholds.runCountMin) {
    out.push('run-heavy');
  }
  if (features.emoji >= thresholds.emojiMin && features.emojiRatio >= thresholds.emojiRatioMin) {
    out.push('emoji-flood');
  }
  return out;
}

/**
 * Apply the rule: the `meaningless` gate must be open, and `evidenceMin`
 * secondary flags must agree. Exported so the gate itself is directly testable
 * rather than only observable through a whole-stream trip.
 */
export function isDegenerate(evidence, thresholds) {
  let secondary = 0;
  let gate = false;
  for (const flag of evidence) {
    if (flag === 'meaningless') gate = true;
    else secondary += 1;
  }
  return gate && secondary >= thresholds.evidenceMin;
}

/** Name the trip after the most specific evidence that fired. */
export function degeneracyRule(evidence) {
  if (evidence.includes('emoji-flood')) return 'emoji-flood';
  if (evidence.includes('run-heavy')) return 'symbol-flood';
  return 'degenerate-output';
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Create a per-request degeneracy detector.
 *
 * `push(delta)` returns a trip descriptor on the first breach, else null — the
 * same contract as `createDetector`, so a caller can run both over one stream
 * and take whichever fires first. `maxReasoningChars` accounting deliberately
 * stays with the caller: this module never guesses what "too long" means.
 */
export function createDegeneracyDetector(overrides = {}) {
  const o = overrides ?? {};
  const blockChars = num(o.blockChars, DEGENERACY_DEFAULTS.blockChars);
  const thresholds = resolveThresholds(o);

  let text = '';
  let nextBase = 0;
  let idx = 0;
  let streak = 0;

  function push(delta) {
    if (typeof delta !== 'string' || delta.length === 0) return null;
    text += delta;

    while (text.length - nextBase >= blockChars) {
      const here = idx++;
      const features = blockFeatures(text, nextBase, blockChars);
      const evidence = degeneracyEvidence(features, thresholds);
      streak = isDegenerate(evidence, thresholds) ? streak + 1 : 0;

      const offset = nextBase + 1;
      const fingerprint = hash32(text.slice(nextBase, nextBase + blockChars));
      nextBase += blockChars;

      if (streak >= thresholds.streak) {
        return {
          rule: degeneracyRule(evidence),
          blockChars,
          block: here,
          offset,
          streak: thresholds.streak,
          evidence,
          // Diagnostics only: enough to tell two different floods apart in a log
          // without dumping the offending block into the transcript.
          fingerprint,
          stats: {
            meaningRatio: round3(features.meaningRatio),
            noiseRatio: round3(features.noiseRatio),
            variety: round3(features.variety),
            emojiRatio: round3(features.emojiRatio),
            maxRun: features.maxRun,
            runCount: features.runCount,
            emoji: features.emoji,
            nonSpace: features.nonSpace,
          },
        };
      }
    }

    // Drop the consumed prefix so a long healthy stream cannot grow this string
    // without limit.
    if (nextBase >= blockChars) {
      text = text.slice(nextBase);
      nextBase = 0;
    }
    return null;
  }

  return {
    push,
    /** Unconsumed prefix length, mirroring `createDetector`'s accessor. */
    get consumed() {
      return nextBase;
    },
    /** Number of complete blocks consumed so far. */
    get blocks() {
      return idx;
    },
    /** Consecutive degenerate blocks currently standing. */
    get streak() {
      return streak;
    },
  };
}
