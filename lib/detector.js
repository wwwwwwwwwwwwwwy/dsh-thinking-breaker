/**
 * Pure reasoning-loop detector. No DSH imports, no I/O — so it is unit-testable
 * in isolation and its behaviour is fully pinned by `test/detector.test.mjs`.
 *
 * Why this exists: a reasoning model can enter a self-reinforcing loop while
 * emitting `reasoning-delta` chunks. Every looped token is billed as output and
 * — worse — the reasoning block is replayed in the context of every following
 * step, so the cost compounds per step. `maxTokens` cannot see this (it only
 * caps the whole response) and `reasoningEffort` only sets the level.
 *
 * ## Design note: disjoint blocks, not a sliding window
 *
 * The first implementation compared overlapping sliding windows. That is
 * measurably broken: with a window of W and a stride of S, two windows S apart
 * already share W-S characters *by position*, so the overlap score is floored by
 * a structural constant. Measured on a real case (a 35-code-unit Chinese
 * paragraph, W=256, S=64) the loop scored 0.67 — overlapping the clean-prose
 * band, so no threshold separated them. See tools/calibrate.mjs.
 *
 * This implementation therefore consumes the stream as disjoint blocks: block k
 * covers `[k*blockChars, (k+1)*blockChars)`. Two different blocks share nothing
 * by position, so every bit of overlap is genuine content repetition. The price
 * is granularity — a loop is only visible once a whole repeated block has been
 * consumed — which is exactly the trade wanted, because it buys a clean signal.
 *
 * ## Rules
 *
 *   - `exact-repeat` : the same 128-bit whole-block fingerprint as a block
 *                      >= `minRepeatGap` blocks back. Zero false-positive risk.
 *   - `low-novelty`  : the block's distinct 4-code-point-shingle set overlaps a
 *                      recent block's by >= `noveltyOverlap` for
 *                      `noveltyStreak` consecutive blocks. Catches the
 *                      near-verbatim loop — the model keeps a paragraph and
 *                      edits a word or a number — which a whole-block hash
 *                      cannot see, because one edit perturbs every hash over it.
 */

const FNV_OFFSET = 0x811c9dc5;
const SHINGLE = 4;
const SHINGLE_STEP = 2;
/** Number of independent FNV-1a passes behind one whole-block fingerprint. */
const FP_WORDS = 4;
const FP_SEEDS = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];

/**
 * FNV-1a (32-bit) over a code-unit range, folded by UTF-16 code point.
 *
 * Folding by code unit would be a real hazard here: `& 0xffffffff` on a low
 * surrogate (0xDC00-0xDFFF) yields a value in the BMP range, so an astral
 * character could alias a BMP code point. Reasoning text is often Chinese and
 * emoji-bearing, so surrogate pairs are folded into one code point instead.
 */
export function fnv1a(str, from, to) {
  let h = FNV_OFFSET;
  let i = from;
  while (i < to) {
    const cp = str.codePointAt(i);
    if (cp === undefined) break;
    h ^= cp;
    h = Math.imul(h, 0x01000193) >>> 0;
    i += cp > 0xffff ? 2 : 1;
  }
  return h >>> 0;
}

/** Advance one code point from index `i`. */
function nextCodePointIndex(str, i) {
  const cp = str.codePointAt(i);
  if (cp === undefined) return i + 1;
  return i + (cp > 0xffff ? 2 : 1);
}

/**
 * 128-bit whole-block fingerprint as four independent 32-bit words. Four
 * separate passes make a long shared prefix insufficient to collide, which a
 * single 32-bit hash would not guarantee.
 */
export function fingerprint(str, base, blockChars) {
  const words = new Array(FP_WORDS).fill(0);
  const limit = Math.min(base + blockChars, str.length);
  for (let s = 0; s < FP_WORDS; s++) {
    let h = (FNV_OFFSET ^ FP_SEEDS[s]) >>> 0;
    for (let i = base; i < limit; ) {
      h ^= str.codePointAt(i) ?? 0;
      h = Math.imul(h, 0x01000193) >>> 0;
      i = nextCodePointIndex(str, i);
    }
    words[s] = h >>> 0;
  }
  return words;
}

/** Total Hamming distance between two fingerprints (diagnostics/tests). */
export function fpDistance(a, b) {
  let bits = 0;
  for (let i = 0; i < FP_WORDS; i++) {
    let x = (a[i] ^ b[i]) >>> 0;
    while (x) {
      x = (x & (x - 1)) >>> 0; // Kernighan popcount
      bits++;
    }
  }
  return bits;
}

/**
 * Distinct shingle hashes inside one block, keyed on code-point offsets so
 * astral characters shift shingle boundaries correctly for both blocks.
 */
export function shingleSet(str, base, blockChars) {
  const set = new Set();
  const limit = Math.min(base + blockChars, str.length);
  const offsets = [];
  for (let i = base; i < limit; ) {
    offsets.push(i);
    i = nextCodePointIndex(str, i);
  }
  for (let k = 0; k + SHINGLE <= offsets.length; k += SHINGLE_STEP) {
    let h = FNV_OFFSET;
    for (let j = k; j < k + SHINGLE; j++) {
      h ^= str.codePointAt(offsets[j]) ?? 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    set.add(h);
  }
  return set;
}

/** Jaccard overlap of two sets: |A ∩ B| / |A ∪ B|. */
export function setOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (big.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

export const DETECTOR_DEFAULTS = {
  /**
   * Block size in UTF-16 code units. Measured across 96/128/192/256
   * (tools/calibrate.mjs): 128 is the only size where every loop shape — short
   * and long, English and Chinese — clears the threshold with a long run while
   * all three clean corpora score zero.
   */
  blockChars: 128,
  historyBlocks: 32,
  minRepeatGap: 3,
  /**
   * Measured, not guessed. At 0.75/0.70 every loop shape scores a run of 28-68
   * consecutive blocks (a 35-code-unit Chinese paragraph with a varying counter
   * included) while clean prose, varied English reasoning and varied Chinese
   * reasoning all score 0. 0.70 clears the shortest loop shape with the widest
   * margin; clean corpora stay at 0 well past 0.6.
   */
  noveltyOverlap: 0.7,
  /**
   * 10 consecutive blocks = 1280 code units of confirmed repetition before
   * aborting. This is the operator-facing threshold ("stop after 10 repeats").
   * Measured margin at this value: the shortest loop shape scores 28 consecutive
   * blocks, so there is ~2.8x headroom, and all three clean corpora score 0.
   */
  noveltyStreak: 10,
};

function num(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Create a per-request detector.
 *
 * `overrides` carries the live config values. A block is compared against every
 * block from `minRepeatGap` up to `historyBlocks` back.
 */
export function createDetector(overrides = {}) {
  const blockChars = num(overrides.blockChars, DETECTOR_DEFAULTS.blockChars);
  const historyBlocks = num(overrides.historyBlocks, DETECTOR_DEFAULTS.historyBlocks);
  const minRepeatGap = num(overrides.minRepeatGap, DETECTOR_DEFAULTS.minRepeatGap);
  const noveltyOverlap = Number.isFinite(overrides.noveltyOverlap)
    ? Math.min(1, Math.max(0, overrides.noveltyOverlap))
    : DETECTOR_DEFAULTS.noveltyOverlap;
  const noveltyStreak = num(overrides.noveltyStreak, DETECTOR_DEFAULTS.noveltyStreak);

  let text = '';
  let nextBase = 0;
  let idx = 0;
  /** Ring buffer of { words, shingles, index }, ordered oldest → newest. */
  const blocks = [];
  let lowNovelty = 0;
  /** Block index before which an exact-repeat pair may not fire again. */
  let repeatCooldownUntil = 0;

  /**
   * Feed a reasoning delta; returns a trip descriptor on the first breach, else
   * null. `maxReasoningChars` accounting stays with the caller: the detector
   * never guesses what "too long" means.
   */
  function push(delta) {
    if (typeof delta !== 'string' || delta.length === 0) return null;
    text += delta;

    while (text.length - nextBase >= blockChars) {
      const here = idx++;
      const words = fingerprint(text, nextBase, blockChars);
      const shingles = shingleSet(text, nextBase, blockChars);

      let exact = false;
      let bestOverlap = 0;
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j];
        const gap = here - b.index;
        if (gap < minRepeatGap) continue;
        if (gap > historyBlocks) break;
        const a = b.words;
        if (a[0] === words[0] && a[1] === words[1] && a[2] === words[2] && a[3] === words[3]) {
          exact = true;
          break;
        }
        const ov = setOverlap(shingles, b.shingles);
        if (ov > bestOverlap) bestOverlap = ov;
      }

      blocks.push({ words, shingles, index: here });
      if (blocks.length > historyBlocks) blocks.shift();

      lowNovelty = bestOverlap >= noveltyOverlap ? lowNovelty + 1 : 0;

      let trip = null;
      if (exact && here >= repeatCooldownUntil) {
        repeatCooldownUntil = here + minRepeatGap;
        trip = { rule: 'exact-repeat', blockChars, block: here, offset: nextBase + 1 };
      } else if (lowNovelty >= noveltyStreak) {
        lowNovelty = 0;
        trip = {
          rule: 'low-novelty',
          blockChars,
          block: here,
          streak: noveltyStreak,
          overlap: Math.round(bestOverlap * 1000) / 1000,
          offset: nextBase + 1,
        };
      }

      nextBase += blockChars;
      if (trip) return trip;
    }

    // Drop the consumed prefix so a long non-looping stream cannot grow this
    // string without limit.
    if (nextBase >= blockChars) {
      text = text.slice(nextBase);
      nextBase = 0;
    }
    return null;
  }

  return {
    push,
    get consumed() {
      return nextBase;
    },
    get blocks() {
      return blocks.length;
    },
  };
}
