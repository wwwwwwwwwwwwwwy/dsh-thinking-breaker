/**
 * dsh-thinking-breaker — host half.
 *
 * Three circuit breakers over the live DSH host surface:
 *
 *   A.  Runaway REASONING loop   -> stop the request, then force a fresh re-think.
 *   A2. Degenerate REASONING     -> stop a stream that has stopped meaning
 *       anything (a wall of `***` or emoji, with no words left in it) on the
 *       same terms. This is the arm that answers "there is no way to interrupt
 *       it while it is still thinking": the repetition arm only sees text that
 *       repeats, and a rotating emoji flood is not a repeat.
 *   B.  Repeated TOOL failure    -> stop the blind retry, then steer the next try.
 *
 * Two lenses, one interruption path. A and A2 are independent pure detectors
 * (`detector.js`, `degeneracy.js`) fed the same `reasoning-delta` chunks; the
 * first to trip ends the request, and everything downstream — the forced
 * no-think retry, the per-turn budget, the post-trip hint — is shared.
 *
 * Four hooks, every one read off the live host contract:
 *
 *   1. `llm/stream` (waterfall) — every model call's chunk stream passes here
 *      (`options: GenerateOptions`, `next(): AsyncIterable<StreamChunk>`, chunks
 *      `block-start | text-delta | reasoning-delta | tool-call-delta | block-end |
 *      usage | finish`; the incremental text field is `text` for BOTH delta
 *      kinds). `reasoning-delta` chunks feed both pure detectors; on a trip the
 *      request is terminated at once. `text-delta` feeds a third, separate
 *      degeneracy detector when `degeneracyOnAnswer` is on — separate so that a
 *      thought ending and an answer beginning cannot be read as one continuous
 *      block.
 *
 *      Termination shape is forced by the host: `dsh-llm` registers a prepend
 *      `llm/stream` validator that fails the call with "LLM stream ended without a
 *      terminal finish chunk" if the generator ends without one — and a listener
 *      that throws is a middleware/consumer failure, documented to "remain thrown
 *      and close the turn directly", i.e. it never reaches `agent/request-error`.
 *      So the generator drains the rest without relaying and then emits a terminal
 *      `finish` chunk with `reason: { kind: 'aborted', failure }`. `aborted` (not
 *      `error`) is deliberate: `ABORTED` is outside the retryable code set
 *      (`EMPTY_RESPONSE | RATE_LIMIT | SERVER | TIMEOUT | TRANSPORT`), so the
 *      *default* handling is terminal — which is exactly what arm 4 overrides,
 *      deliberately and for one attempt only.
 *
 *   2. `agent/request` (waterfall) — returns the frozen `LlmCallConfig`
 *      (`{ provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }`).
 *      It stamps the session's current turn (so a trip is attributed to the turn
 *      it happened in) and, when the breaker has tripped for that turn, forces
 *      `reasoningEffort: 'off'` — the retried attempt answers instead of
 *      re-reasoning, which is what actually breaks the loop.
 *
 *      Registered with `prepend: true`: the host's model-selection listener
 *      overwrites `reasoningEffort` after `next()` resolves, so this plugin must
 *      be OUTERMOST (registered first) to win — the same ordering
 *      `dsh-thinking-levels` relies on. Note that plugin also prepends, so
 *      among prepended listeners this one should be registered last to win.
 *
 *   3. `agent/request-error` (waterfall) — recovers a breaker-aborted attempt by
 *      returning `{ kind: 'retry' }`, but only when the abort was this plugin's
 *      loop trip AND a per-turn retry budget remains. Every other failure is left
 *      terminal (delegating to `next()`), so provider errors keep their normal
 *      handling.
 *
 *   4. `tools/pre-execute` + `tools/post-execute` (waterfalls) — arm B. A failing
 *      tool result is rewritten with explicit "do not repeat this, change
 *      approach" guidance once the same failure signature is seen
 *      `toolFailureSteerAfter` times in a turn; after `toolFailureDenyAfter` the
 *      identical call is denied before dispatch instead of being re-run, which is
 *      what "stop processing and start a fresh round" means at this layer.
 *      Success through the same path clears the streak.
 */

import { createDetector, DETECTOR_DEFAULTS } from './detector.js';
import { createDegeneracyDetector, DEGENERACY_DEFAULTS } from './degeneracy.js';
import { loadSchemaFactory } from './schema-fallback.js';

const { z, isFallback: SCHEMA_IS_FALLBACK } = await loadSchemaFactory();

/** The failure codes that mean "this plugin ended the attempt on purpose". */
export const LOOP_ABORT_CODE = 'ABORTED';

/**
 * Composition-entry schema, present only when the real
 * `@deepseek-ai/schemastery` resolved.
 *
 * When it is absent the module publishes NO schema: cordis calls
 * `schema.validate` on whatever is exported, so a stand-in schema crashes the
 * host (see lib/schema-fallback.js). Without a schema the entry still activates;
 * it only loses host validation and the generated settings form, and every option
 * below keeps working through `resolveConfig`.
 *
 * `kind` + `default` drive both the schema builder and `DEFAULT_CONFIG`, so the
 * two can never drift apart.
 */
const FIELDS = {
  enabled: { kind: 'boolean', default: true },

  // ---- A. reasoning loop ----
  /** Hard ceiling on one response's reasoning characters (0 = no ceiling). */
  maxReasoningChars: { kind: 'number', default: 120000 },
  /** Force a fresh attempt with thinking off once the loop trips. */
  retryWithoutThinking: { kind: 'boolean', default: true },
  /** Aborts allowed to be retried per turn; 0 = let the turn stop instead. */
  maxLoopRetriesPerTurn: { kind: 'number', default: 1 },
  /** Hard output ceiling applied while armed (0 = leave the value alone). */
  maxTokens: { kind: 'number', default: 0 },
  /** Skip auxiliary calls (title generation etc.) — never loop-prone. */
  skipAuxCalls: { kind: 'boolean', default: true },
  /** After a trip, tell the model on its next tool result not to resume that line. */
  postTripHint: { kind: 'boolean', default: true },

  // ---- A2. degenerate output (a wall of *** / emoji) ----
  /**
   * Master switch for the degeneracy arm. It answers a different question from
   * the repetition arm: not "has this been said before" but "does this still say
   * anything". Either arm can abort the request.
   */
  degeneracyGuard: { kind: 'boolean', default: true },
  /**
   * Watch the ANSWER stream too, not only the reasoning stream. Off by default:
   * aborting a thought is cheap, aborting output the user is already reading is
   * not, and the reported failure is a *thinking* failure.
   */
  degeneracyOnAnswer: { kind: 'boolean', default: false },
  /** Secondary evidence flags required, on top of the `meaningless` hard gate. */
  degEvidenceMin: { kind: 'number', default: DEGENERACY_DEFAULTS.evidenceMin },
  /** Consecutive degenerate blocks before aborting. */
  degStreak: { kind: 'number', default: DEGENERACY_DEFAULTS.streak },
  /** Gate: letters + digits over non-space, at or below this, is "no words". */
  degMeaningRatioMax: { kind: 'number', default: DEGENERACY_DEFAULTS.meaningRatioMax },
  /** Signal: punctuation + emoji over non-space, at or above this. */
  degNoiseRatioMin: { kind: 'number', default: DEGENERACY_DEFAULTS.noiseRatioMin },
  /** Signal: distinct glyphs over the first 48 non-space, at or below this. */
  degVarietyRatioMax: { kind: 'number', default: DEGENERACY_DEFAULTS.varietyRatioMax },
  /** Signal: one symbol run at least this long. */
  degRunLenMin: { kind: 'number', default: DEGENERACY_DEFAULTS.runLenMin },
  /** Signal: this many symbol runs of >= 3 code points. */
  degRunCountMin: { kind: 'number', default: DEGENERACY_DEFAULTS.runCountMin },
  /** Signal: at least this many emoji in one block. */
  degEmojiMin: { kind: 'number', default: DEGENERACY_DEFAULTS.emojiMin },
  /** Signal: emoji density at or above this. */
  degEmojiRatioMin: { kind: 'number', default: DEGENERACY_DEFAULTS.emojiRatioMin },

  // ---- B. repeated tool failure ----
  /** Master switch for the tool-failure arm. */
  toolFailureGuard: { kind: 'boolean', default: true },
  /** Inject change-approach guidance after this many similar failures in a turn. */
  toolFailureSteerAfter: { kind: 'number', default: 2 },
  /** Deny the identical call before dispatch after this many failures in a turn. */
  toolFailureDenyAfter: { kind: 'number', default: 3 },
  /** Failures remembered per turn before the oldest are dropped. */
  toolFailureHistory: { kind: 'number', default: 64 },
  /** Failure signature mode: 'code' reuses only the failure code, 'text' adds normalized text. */
  toolFailureSignatures: { kind: 'string', default: 'text' },

  // ---- detector ----
  blockChars: { kind: 'number', default: DETECTOR_DEFAULTS.blockChars },
  historyBlocks: { kind: 'number', default: DETECTOR_DEFAULTS.historyBlocks },
  minRepeatGap: { kind: 'number', default: DETECTOR_DEFAULTS.minRepeatGap },
  noveltyOverlap: { kind: 'number', default: DETECTOR_DEFAULTS.noveltyOverlap },
  noveltyStreak: { kind: 'number', default: DETECTOR_DEFAULTS.noveltyStreak },
};

export const Config = SCHEMA_IS_FALLBACK
  ? undefined
  : z.object(
      Object.fromEntries(
        Object.entries(FIELDS).map(([key, spec]) => [key, z[spec.kind]().default(spec.default).volatile()]),
      ),
    );

/** Schema defaults, derived from the single field table so they cannot drift. */
export const DEFAULT_CONFIG = Object.freeze(
  Object.fromEntries(Object.entries(FIELDS).map(([key, spec]) => [key, spec.default])),
);

/**
 * Whether the real schema library resolved. Exported for diagnostics: when true,
 * the host neither validates the config entry nor renders a settings form.
 */
export const usingFallbackSchema = SCHEMA_IS_FALLBACK;

/**
 * Read a `.volatile()` field: a live `Volatile` ref on a DSH host that supports
 * it, a plain value otherwise. `get()` may return undefined, so the schema
 * default is the fallback.
 */
export function readVolatile(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    const snapshot = value.get();
    return snapshot === undefined ? fallback : snapshot;
  }
  return value ?? fallback;
}

/**
 * Resolve an entry to a plain config object, using only this plugin's own
 * defaults rule.
 *
 * Deliberately NOT delegating to the schema object: cordis owns validation and
 * calls `schema.validate` itself (that is how the real `@deepseek-ai/schemastery`
 * object is reached). Passing the fallback shim's `.object()` as a config schema
 * made cordis crash with `Cannot read properties of undefined (reading
 * 'validate')`, so the shim is never used as a schema — when the real library is
 * absent the module exports no `Config` at all (see the bottom of this file).
 */
export function resolveConfig(entry) {
  const out = { ...DEFAULT_CONFIG };
  if (entry === null || typeof entry !== 'object') return out;
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    // Per-field, never `entry.get(key)`: `entry` is a plain config object whose
    // values may individually be live `.volatile()` refs, so the ref handling
    // belongs in readVolatile, not here.
    out[key] = readVolatile(entry[key], DEFAULT_CONFIG[key]);
  }
  return out;
}

/** Maximum retry marker used to recognise our own aborts across the waterfall. */
const THINKING_BREAKER_MARKER = 'thinking-breaker';

/** Stable hash (FNV-1a) over a string. */
function hash32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Collapse variability so "failure at line 42" and "at line 99" are one signature. */
function normalizeForSignature(value, limit = 400) {
  return String(value)
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** Deterministic JSON with sorted keys and truncated leaves. Never throws. */
function stableJson(value, depth = 0) {
  try {
    return stableJsonUnsafe(value, depth);
  } catch {
    // `JSON.stringify` throws on BigInt, and on exotic cycles beyond the depth
    // guard. A signature is a nice-to-have; crashing inside a pre-dispatch gate
    // would break the actual tool call, so degrade instead.
    return '"<unserializable>"';
  }
}

function stableJsonUnsafe(value, depth) {
  if (depth > 3) return '"<deep>"';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    if (typeof value === 'string') return JSON.stringify(value.slice(0, 200));
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.slice(0, 8).map((v) => stableJsonUnsafe(v, depth + 1)).join(',')}]`;
  }
  const keys = Object.keys(value).sort().slice(0, 16);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonUnsafe(value[k], depth + 1)}`).join(',')}}`;
}

/**
 * Identify "the same failing call" for STEERING.
 *
 * Arguments are normalised (digits, hex and whitespace collapse), so a retry that
 * only changes a number or a path fragment still counts as the same call — which
 * is exactly the blind-retry pattern this arm exists to stop. Genuine progress
 * changes the arguments structurally and so starts a fresh signature.
 */
export function failureSignature(exec, result, mode = 'text') {
  const info = result?.error?.info ?? {};
  const code = String(info.code ?? '');
  if (mode === 'code') return `${callSignature(exec)}|${code}`;
  const detail = normalizeForSignature(result?.error?.message ?? '', 160);
  return `${callSignature(exec)}|${code}|${detail}`;
}

/**
 * Identify "the same call" for the PRE-DISPATCH gate.
 *
 * Deliberately depends only on the tool name and its normalised arguments: at
 * pre-dispatch time there is no result yet, so a signature that folded in error
 * text could never be matched against what the post-execute arm recorded. This is
 * the signature the gate must use, and the one the post-execute arm must also
 * record so the gate has something to match.
 */
export function callSignature(exec) {
  const name = String(exec?.name ?? '?');
  const args = hash32(stableJson(exec?.arguments ?? null)).toString(16);
  return `${name}|${args}`;
}

/** Best-effort session id from an agent handle (only `id` is public). */
function sessionIdOf(agent) {
  if (agent === undefined || agent === null) return undefined;
  const direct = agent.id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const nested = agent.session?.header?.id ?? agent.session?.id;
  if (typeof nested === 'string' && nested.length > 0) return nested;
  if (direct !== undefined) return String(direct);
  return undefined;
}

/**
 * `options.sessionId` is typed as a branded string, but this is the plugin
 * boundary: fall back to a per-request anonymous key rather than throw.
 */
function streamSessionKey(options, seq) {
  const id = options?.sessionId;
  if (typeof id === 'string' && id.length > 0) return id;
  if (id !== undefined && id !== null) return String(id);
  return `anonymous#${seq}`;
}

/**
 * Per-session breaker state.
 *
 * `currentTurn` is stamped by `agent/request` and is what every turn-scoped
 * decision keys on: the force-off, the retry budget and the tool-failure window
 * all reset when it advances, so a later turn starts clean. (An earlier revision
 * also carried a `tripTurn` field that was written in three places and never
 * read; it was removed rather than left as dead state.)
 */
const BREAKER_TTL_MS = 30 * 60 * 1000;
const BREAKER_MAX_SESSIONS = 64;

function createBreakerStore() {
  const map = new Map();
  return {
    for_(key) {
      const now = Date.now();
      if (map.size > BREAKER_MAX_SESSIONS) {
        for (const [k, v] of map) {
          if (now - v.touched > BREAKER_TTL_MS) map.delete(k);
        }
      }
      let entry = map.get(key);
      if (entry === undefined) {
        entry = {
          touched: now,
          currentTurn: -1,
          // reasoning loop
          tripped: false,
          trips: 0,
          retriesUsed: 0,
          retryArmed: false,
          /** A trip happened and the guidance has not been handed to the model yet. */
          hintPending: false,
          // tool failures
          toolTurn: -1,
          toolFailures: new Map(),
          toolCalls: new Map(),
          toolDenied: new Set(),
          toolFailuresTotal: 0,
        };
        map.set(key, entry);
      }
      entry.touched = now;
      return entry;
    },
    get size() {
      return map.size;
    },
  };
}

export function apply(ctx, entry = {}) {
  // A composition entry is a live config object; normalise it so the plugin also
  // works when the host passed the raw entry or nothing at all.
  const cfg = resolveConfig(entry);
  const store = createBreakerStore();
  let seq = 0;

  const detectorOptions = () => ({
    blockChars: cfg.blockChars,
    historyBlocks: cfg.historyBlocks,
    minRepeatGap: cfg.minRepeatGap,
    noveltyOverlap: cfg.noveltyOverlap,
    noveltyStreak: cfg.noveltyStreak,
  });

  // The degeneracy detector deliberately shares `blockChars`: both lenses must
  // cut the stream at identical boundaries or their offsets stop being
  // comparable in a log.
  const degeneracyOptions = () => ({
    blockChars: cfg.blockChars,
    evidenceMin: cfg.degEvidenceMin,
    streak: cfg.degStreak,
    meaningRatioMax: cfg.degMeaningRatioMax,
    noiseRatioMin: cfg.degNoiseRatioMin,
    varietyRatioMax: cfg.degVarietyRatioMax,
    runLenMin: cfg.degRunLenMin,
    runCountMin: cfg.degRunCountMin,
    emojiMin: cfg.degEmojiMin,
    emojiRatioMin: cfg.degEmojiRatioMin,
  });

  // ---------------------------------------------------------------------------
  // Arm 2: stamp the session's turn; force thinking off for a tripped turn.
  // ---------------------------------------------------------------------------
  ctx.on(
    'agent/request',
    async function thinkingBreakerRequest(payload, next) {
      const seed = await next();
      if (!cfg.enabled) return seed;

      const key = sessionIdOf(payload?.agent) ?? '(unknown)';
      const breaker = store.for_(key);
      const turn = Number.isFinite(payload?.turn) ? payload.turn : -1;

      if (turn !== breaker.currentTurn) {
        // A new turn starts clean and earns a fresh retry budget.
        breaker.tripped = false;
        breaker.trips = 0;
        breaker.retriesUsed = 0;
        breaker.hintPending = false;
        breaker.currentTurn = turn;
      }

      let out = seed;
      if (cfg.retryWithoutThinking && breaker.tripped && seed.reasoningEffort !== 'off') {
        out = { ...out, reasoningEffort: 'off' };
        ctx.logger?.info?.(
          '[thinking-breaker] agent/request: session=%s turn=%s reasoningEffort=%s => off (re-thinking attempt, trips=%d)',
          key,
          String(turn),
          String(seed.reasoningEffort),
          breaker.trips,
        );
      }

      if (cfg.maxTokens > 0 && (seed.maxTokens === undefined || seed.maxTokens > cfg.maxTokens)) {
        out = { ...out, maxTokens: cfg.maxTokens };
      }

      return out;
    },
    { prepend: true },
  );

  // ---------------------------------------------------------------------------
  // Arm 4: recover exactly our own loop aborts, within a per-turn budget.
  // ---------------------------------------------------------------------------
  ctx.on(
    'agent/request-error',
    async function thinkingBreakerRequestError(payload, next) {
      if (cfg.enabled) {
        const failure = payload?.failure;
        const message = String(failure?.message ?? '');
        const isOurs = message.includes(THINKING_BREAKER_MARKER);
        const key = sessionIdOf(payload?.agent) ?? '(unknown)';
        const breaker = store.for_(key);

        if (isOurs && failure?.code === LOOP_ABORT_CODE && breaker.retryArmed) {
          breaker.retryArmed = false;
          breaker.retriesUsed += 1;
          ctx.logger?.warn?.(
            '[thinking-breaker] agent/request-error: session=%s turn=%s recovering loop abort with a fresh attempt (%d/%d)',
            key,
            String(payload?.turn),
            breaker.retriesUsed,
            cfg.maxLoopRetriesPerTurn,
          );
          return { kind: 'retry' };
        }
      }
      // Everything else (including a spent retry budget) keeps its normal path.
      return next();
    },
    { prepend: true },
  );

  // ---------------------------------------------------------------------------
  // Arm 1: watch every model stream. Two lenses run side by side over the same
  // blocks — "has this been said before" (repetition) and "does this still say
  // anything" (degeneracy). Whichever fires first ends the request.
  // ---------------------------------------------------------------------------
  ctx.on(
    'llm/stream',
    function thinkingBreakerStream(options, next) {
      if (!cfg.enabled) return next();
      if (cfg.skipAuxCalls && options?.purpose !== undefined) return next();

      const key = streamSessionKey(options, seq++);
      const breaker = store.for_(key);
      const detector = createDetector(detectorOptions());
      const reasoningDegeneracy = cfg.degeneracyGuard ? createDegeneracyDetector(degeneracyOptions()) : null;
      const answerDegeneracy =
        cfg.degeneracyGuard && cfg.degeneracyOnAnswer ? createDegeneracyDetector(degeneracyOptions()) : null;

      let reasoningChars = 0;
      let tripped = null;
      let trippedStream = 'reasoning';
      const inner = next();

      /**
       * Record a trip on this session and decide whether the attempt may be
       * retried. Called at most once per stream: `tripped` latches, and every
       * later chunk is drained without being relayed.
       */
      function armTrip(trip, stream) {
        trippedStream = stream;
        breaker.trips += 1;
        breaker.tripped = true;
        // The looped reasoning is already committed to the transcript and cannot
        // be removed (no hook rewrites history, and doing so would break the
        // provider prompt cache). The best available counter-measure is to tell
        // the model, at its very next observation, that this line was already
        // diagnosed as spinning — so it does not resume it.
        breaker.hintPending = true;
        if (cfg.retryWithoutThinking && breaker.retriesUsed < cfg.maxLoopRetriesPerTurn) {
          breaker.retryArmed = true;
        }
        ctx.logger?.warn?.(
          '[thinking-breaker] trip: session=%s turn=%s stream=%s rule=%s reasoningChars=%d detail=%s — request aborted',
          key,
          String(breaker.currentTurn),
          stream,
          trip.rule,
          reasoningChars,
          describeTrip(trip),
        );
      }

      async function* guarded() {
        for await (const chunk of inner) {
          if (tripped !== null) {
            // Drain the provider stream silently so it closes cleanly; relay
            // nothing more. Ending without a terminal chunk would fail the
            // host's own validator, so one is emitted below.
            continue;
          }

          if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            reasoningChars += chunk.text.length;
            tripped = detector.push(chunk.text);
            if (tripped === null && reasoningDegeneracy !== null) {
              tripped = reasoningDegeneracy.push(chunk.text);
            }

            if (tripped === null && cfg.maxReasoningChars > 0 && reasoningChars > cfg.maxReasoningChars) {
              tripped = { rule: 'max-reasoning-chars', blockChars: 0, block: 0, offset: reasoningChars };
            }

            if (tripped !== null) {
              armTrip(tripped, 'reasoning');
              continue;
            }
          } else if (
            chunk?.type === 'text-delta' &&
            answerDegeneracy !== null &&
            typeof chunk.text === 'string'
          ) {
            tripped = answerDegeneracy.push(chunk.text);
            if (tripped !== null) {
              armTrip(tripped, 'answer');
              continue;
            }
          }

          yield chunk;
        }

        if (tripped !== null) {
          yield {
            type: 'finish',
            reason: {
              kind: 'aborted',
              failure: {
                message:
                  `${THINKING_BREAKER_MARKER} aborted a runaway ${trippedStream} stream ` +
                  `(${tripped.rule}, ${reasoningChars} reasoning chars)`,
                code: LOOP_ABORT_CODE,
              },
            },
          };
        }
      }

      return guarded();
    },
    { prepend: true },
  );

  // ---------------------------------------------------------------------------
  // Arm 3b: deliver post-trip guidance, and steer a repeatedly failing tool call.
  //
  // The post-trip hint is deliberately handled BEFORE the isError check: a
  // successful top-level result is the most likely next observation after a
  // forced retry, and gating the hint on failure would mean it often never ships.
  // ---------------------------------------------------------------------------
  ctx.on(
    'tools/post-execute',
    async function thinkingBreakerToolResult(exec, result, next) {
      const decision = await next();
      if (!cfg.enabled) return decision;
      if (!decision || decision.kind !== 'accept') return decision;

      const key = sessionIdOf(exec?.agent);
      if (key === undefined) return decision;
      const breaker = store.for_(key);
      resetToolWindow(breaker, breaker.currentTurn);

      // Nested calls (subagent-internal) must not consume the hint: the parent's
      // own observation is the one that matters, and `exec.parent` identifies them.
      const topLevel = exec?.parent === undefined;

      if (topLevel && breaker.hintPending && cfg.postTripHint) {
        breaker.hintPending = false;
        const hint = buildPostTripHint(breaker.trips);
        const existing = decision.content ?? result?.content;
        ctx.logger?.info?.(
          '[thinking-breaker] post-trip hint delivered: session=%s tool=%s trips=%d',
          key,
          String(exec?.name),
          breaker.trips,
        );
        return {
          kind: 'accept',
          content: [{ type: 'text', text: hint }, ...(Array.isArray(existing) ? existing : [])],
        };
      }

      const call = callSignature(exec);

      if (!cfg.toolFailureGuard) return decision;
      if (result?.isError !== true) {
        // A success through this exact call means the model found a working input.
        // Both marks must be cleared for that call: the deny marker AND its failure
        // count. Clearing only the marker left the count at/above the threshold, so
        // the gate re-denied immediately and "the model fixed it" never took effect.
        breaker.toolDenied.delete(call);
        breaker.toolCalls.delete(call);
        return decision;
      }

      // Two signatures, on purpose: `byCall` is what the pre-dispatch gate can
      // match (tool + normalised args only), `byFailure` additionally folds in the
      // error text so steering targets the same KIND of failure.
      const byFailure = failureSignature(exec, result, cfg.toolFailureSignatures);

      breaker.toolCalls.set(call, (breaker.toolCalls.get(call) ?? 0) + 1);
      breaker.toolFailures.set(byFailure, (breaker.toolFailures.get(byFailure) ?? 0) + 1);
      // Steering is driven by the TURN's total, not by one kind's count: a model
      // varying its mistakes would otherwise be told "failed 1 time" forever, which
      // understates the situation and withholds guidance exactly when it is needed.
      breaker.toolFailuresTotal += 1;
      trimMap(breaker.toolFailures, cfg.toolFailureHistory);
      trimMap(breaker.toolCalls, cfg.toolFailureHistory);

      if (breaker.toolFailuresTotal < Math.max(1, cfg.toolFailureSteerAfter)) return decision;

      const original = flattenText(decision.content ?? result.content);
      const guidance = buildToolGuidance(exec?.name ?? 'tool', breaker.toolFailuresTotal, original);
      ctx.logger?.warn?.(
        '[thinking-breaker] tool failures x%d in this turn: session=%s tool=%s — injecting change-approach guidance',
        breaker.toolFailuresTotal,
        key,
        String(exec?.name),
      );
      return { kind: 'accept', content: [{ type: 'text', text: guidance }] };
    },
    { prepend: true },
  );

  // ---------------------------------------------------------------------------
  // Arm 3a: refuse the identical call once steering has been ignored.
  // ---------------------------------------------------------------------------
  ctx.on(
    'tools/pre-execute',
    async function thinkingBreakerToolGate(exec, next) {
      if (!cfg.enabled || !cfg.toolFailureGuard) return next();

      const key = sessionIdOf(exec?.agent);
      if (key === undefined) return next();
      const breaker = store.for_(key);
      resetToolWindow(breaker, breaker.currentTurn);

      const call = callSignature(exec);
      if (breaker.toolDenied.has(call)) {
        return { kind: 'deny', reason: buildToolDenial(exec?.name, breaker.toolCalls.get(call) ?? 0, true) };
      }

      const failed = breaker.toolCalls.get(call) ?? 0;
      if (failed >= Math.max(1, cfg.toolFailureDenyAfter)) {
        ctx.logger?.warn?.(
          '[thinking-breaker] denying repeated failing call: session=%s tool=%s after %d failures',
          key,
          String(exec?.name),
          failed,
        );
        breaker.toolDenied.add(call);
        return { kind: 'deny', reason: buildToolDenial(exec?.name, failed, false) };
      }

      return next();
    },
    { prepend: true },
  );
}

/**
 * One log fragment describing why a trip fired, for either lens.
 *
 * The repetition lens reports the block geometry; the degeneracy lens reports the
 * measurements behind its verdict, so a false positive can be diagnosed from the
 * log alone instead of by re-running the stream.
 */
function describeTrip(trip) {
  if (Array.isArray(trip.evidence)) {
    const s = trip.stats ?? {};
    return (
      `evidence=${trip.evidence.join('+')} block=${trip.block} offset=${trip.offset} window=${trip.blockChars} ` +
      `nonSpace=${s.nonSpace} noise=${s.noiseRatio} meaning=${s.meaningRatio} variety=${s.variety} ` +
      `emoji=${s.emoji} emojiRatio=${s.emojiRatio} maxRun=${s.maxRun} runs=${s.runCount}`
    );
  }
  return `block=${trip.block} offset=${trip.offset} window=${trip.blockChars}`;
}

/** Reset the per-turn tool-failure window when the turn advances. */
function resetToolWindow(breaker, turn) {
  if (breaker.toolTurn === turn) return;
  breaker.toolTurn = turn;
  breaker.toolFailures.clear();
  breaker.toolCalls.clear();
  breaker.toolDenied.clear();
  breaker.toolFailuresTotal = 0;
}

/** Bound a Map by dropping its oldest insertion once it exceeds `limit`. */
function trimMap(map, limit) {
  const max = Math.max(8, Number.isFinite(limit) ? Math.floor(limit) : 64);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/** The denial text the model sees instead of the tool running again. */
function buildToolDenial(toolName, failures, alreadyDenied) {
  const lead = alreadyDenied
    ? `Blocked by thinking-breaker: "${toolName}" is already blocked for this turn.`
    : `Blocked by thinking-breaker: this exact call to "${toolName}" already failed ${failures} time(s) in this turn ` +
      `with unchanged arguments.`;
  return (
    `${lead} Retrying it verbatim will fail the same way, so it was not dispatched. ` +
    'Change the approach instead: fix the input, split the work into a smaller verifiable step, use a different tool, ' +
    'or stop and report the blocker.'
  );
}

/** Flatten the plain text of a normalized result's content blocks. */
function flattenText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * The guidance prepended to the model's next observation after a trip.
 *
 * Why this exists at all: the looped reasoning is already committed to the
 * transcript and no hook can remove it (assembly re-reads the log, and rewriting
 * history would break the provider prompt cache). So the only lever left is to
 * tell the model, as soon as it next looks at something, that its previous
 * reasoning was already diagnosed as spinning.
 */
function buildPostTripHint(trips) {
  return [
    '[thinking-breaker] Your previous reasoning in this turn was aborted: it kept repeating itself',
    `without making progress (${trips} trip(s) in this turn). That reasoning is still visible in the`,
    'transcript, but it is not a usable basis for the next step.',
    '',
    'Do this instead:',
    '  1. Do not resume or restate that line of reasoning. Treat it as already proven to be a dead end.',
    '  2. If the same question still needs an answer, answer it directly and briefly from what you already know.',
    '  3. If you genuinely lack information, say what is missing and stop — instead of re-deriving it.',
  ].join('\n');
}

/** The replacement text shown to the model instead of a bare repeated error. */
function buildToolGuidance(toolName, count, original) {  const detail = original.trim() === '' ? '(no error text provided by the tool)' : original.trim();
  return [
    `[thinking-breaker] The tool "${toolName}" has now failed ${count} time(s) in this turn with the same kind of input.`,
    'Do NOT retry it unchanged — the same call will produce the same failure.',
    '',
    'Change the approach before calling any tool again:',
    '  1. Read the error below and identify the exact bad input (escaping, quoting, path, type, encoding).',
    '  2. Fix that input, or narrow the work into a smaller step you can verify.',
    '  3. If the same fix has already failed, switch tools or stop and report the blocker instead of looping.',
    '',
    'Original error:',
    detail,
  ].join('\n');
}

// `Config` is exported only when the real `@deepseek-ai/schemastery` resolved.
// cordis validates the composition entry through that schema object; handing it a
// stand-in makes cordis itself crash, so absence of the library must degrade to
// "no schema, no settings form" rather than to a broken schema. Every option in
// DEFAULT_CONFIG still works in that case.
export default SCHEMA_IS_FALLBACK
  ? { name: 'dsh-thinking-breaker', apply }
  : { name: 'dsh-thinking-breaker', Config, apply };
