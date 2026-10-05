# dsh-thinking-breaker

**Two circuit breakers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent sessions — in one host plugin.**

- **A. Reasoning-loop breaker** — when the model repeats itself ≥10 consecutive times while thinking, the request is aborted immediately and the step is retried once with thinking forced **off**, so it answers instead of re-reasoning.
- **B. Tool-failure breaker** — when the same tool call keeps failing in one turn, the model is first told to change approach, and after the threshold the identical call is **denied before dispatch**.

English | [简体中文](./README.zh.md)

---

## Why a plugin and not just a prompt

A skill or prompt is a document the model has to choose to read. A model already stuck in a loop will not read it, and nothing can interrupt it mid-thought from the prompt layer. Interruption has to happen in the host — which is what this plugin does.

It is also worth stating what dsh has **natively**: nothing for this. `maxTokens` only caps a whole response (it cannot see that the model is going in circles), `reasoningEffort` only picks a level, and `streamIdleTimeoutMs` only fires when **no** token arrives — a loop keeps emitting, so it never fires. There is **no thinking-token budget** (`reasoningTokens` is a reporting field, not a budget) and **no `maxSteps`/`maxTurns`** anywhere in the harness.

## Hooks

| Hook | Role |
|---|---|
| `llm/stream` (prepend) | Feeds `reasoning-delta` chunks to a pure detector. On a trip: drain the rest silently, emit a terminal `finish` chunk (`kind: 'aborted'`). |
| `agent/request-error` (prepend) | Recovers **only this plugin's own** loop abort, within a per-turn budget, by returning `{ kind: 'retry' }`. Everything else delegates to `next()`. |
| `agent/request` (prepend) | Stamps the session's turn; forces `reasoningEffort: 'off'` on the recovered attempt. |
| `tools/post-execute` + `tools/pre-execute` (prepend) | Post-trip guidance; then tool-failure steering, then pre-dispatch denial. |

### Three design constraints that are not preferences

1. **A `llm/stream` listener must not throw, and the stream must not end without a terminal chunk.** `dsh-llm` registers its own prepend validator that fails the call with `LLM stream ended without a terminal finish chunk`; and a throwing listener is a middleware/consumer failure, documented to *"remain thrown and close the turn directly"* — so it **never reaches `agent/request-error`** and the recovery logic could not take over. Hence: lawful abort first, explicit recovery second.

2. **The terminal reason is `aborted`, not `error`.** The retryable code set is `EMPTY_RESPONSE | RATE_LIMIT | SERVER | TIMEOUT | TRANSPORT`; **`ABORTED` is not in it**. So the default handling is terminal (safe), and the retry is something this plugin opts into explicitly — once per turn, then it falls back to terminal.

3. **The pre-dispatch gate can only key on tool + normalised arguments.** At pre-dispatch time there is no result, so a signature that folded in error text could never match what `post-execute` recorded. Steering uses tool + args + code + normalised error text; the gate uses tool + args only. Digits and hex collapse during normalisation, so a retry that only changes a line number still counts as the same call — while a structurally different approach gets a fresh signature and passes.

## Detection algorithm

See the header comment in [`lib/detector.js`](./lib/detector.js). The stream is cut into **disjoint blocks** (`blockChars`, default 128 UTF-16 code units); each block yields

- a **128-bit whole-block fingerprint** (four independent FNV-1a seeds) → `exact-repeat`;
- a set of **4-code-point shingles**, compared by Jaccard overlap against recent blocks → `low-novelty` after `noveltyStreak` consecutive blocks.

### Why not a sliding window

The first implementation compared overlapping sliding windows. It is **measurably broken**: with window `W` and stride `S`, two windows `S` apart already share `W−S` characters *by position*, so the overlap score has a structural floor. Measured on a real case (a 35-code-unit Chinese paragraph, `W=256`, `S=64`) the loop scored **0.67** — inside the clean-text band, so **no threshold separated them**. Disjoint blocks share nothing by position, so all overlap is genuine repetition.

### Thresholds are measured, not guessed

[`tools/calibrate.mjs`](./tools/calibrate.mjs) sweeps the signal over 6 loop shapes × 3 clean corpora. `blockChars` was swept over 96/128/192/256 — **only 128** lets every loop shape clear the threshold with a long run while all clean corpora score zero.

At `noveltyStreak: 10`, `noveltyOverlap: 0.7`:

| Corpus | Result |
|---|---|
| Verbatim / near-verbatim / ping-pong loops, English and Chinese | trip at block **12–18** |
| Clean: unique prose, varied English reasoning, varied Chinese reasoning | **no trip** |

Measured cost before the abort fires: **533** code units for a tight short loop, 1 681 ping-pong / CJK paragraph, 1 927 English paragraph, 2 952 near-verbatim, 6 027 CJK paragraph with a counter. Longer repeated units need longer confirmation windows.

## Configuration

The full recommended block lives in [`cordis.patch.yml`](./cordis.patch.yml). Every key is optional; the plugin's defaults equal the values shown there.

## Known limits (stated plainly)

- **Context is never rewound.** This is the fundamental limit: the looped reasoning is already committed to the transcript and no hook removes it (assembly re-reads the log, and rewriting history would break the provider prompt cache). "Re-think" means *the same step, done cleanly once* — not a cleared history. The post-trip hint is the available counter-measure.
- **No round budget.** Cross-step loops (failing differently every time) are out of scope; the harness has no `maxSteps`/`maxTurns`.
- **A loop unit shorter than one block, dragged along by varying content, is missed** (measured overlap 0.22 for a 6-character phrase followed by a ticking counter).
- **Semantic circling is missed** — detection is character-repetition based.
- **A tool that reports failure as success is not caught** (by design: that is the tool's semantics).
- **Each trip costs something**: a few hundred to a few thousand tokens.

## Verify

```bash
npm test          # 59 tests
npm run calibrate # re-measure the thresholds
npm run verify    # cordis contract regression
```

## Install

See [INSTALL.md](./INSTALL.md).

## License

MIT
