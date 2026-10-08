# dsh-thinking-breaker

**Three circuit breakers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) agent sessions — in one host plugin.**

- **A. Reasoning-loop breaker** — when the model repeats itself ≥10 consecutive times while thinking, the request is aborted immediately and the step is retried once with thinking forced **off**, so it answers instead of re-reasoning.
- **A2. Degeneracy breaker** — when the thinking stream stops carrying meaning altogether — literal asterisks (`***`, `*****`), a rotating emoji flood, punctuation soup — the request is aborted on the same terms, **after two blocks (256 code units)** instead of waiting for a repeat to be confirmed.
- **B. Tool-failure breaker** — when the same tool call keeps failing in one turn, the model is first told to change approach, and after the threshold the identical call is **denied before dispatch**.

English | [简体中文](./README.zh.md)

## Install

```bash
dsh plugin --profile desktop add github:wwwwwwwwwwwwwwy/dsh-thinking-breaker
```

Then **restart the host** — ESM caches are per-process. Full instructions, including the `link:` caveat and rollback, are in [INSTALL.md](./INSTALL.md).

---

## Why a plugin and not just a prompt

A skill or prompt is a document the model has to choose to read. A model already stuck in a loop will not read it, and nothing can interrupt it mid-thought from the prompt layer. Interruption has to happen in the host — which is what this plugin does.

It is also worth stating what dsh has **natively**: nothing for this. `maxTokens` only caps a whole response (it cannot see that the model is going in circles), `reasoningEffort` only picks a level, and `streamIdleTimeoutMs` only fires when **no** token arrives — a loop keeps emitting, so it never fires. There is **no thinking-token budget** (`reasoningTokens` is a reporting field, not a budget) and **no `maxSteps`/`maxTurns`** anywhere in the harness.

## Hooks

| Hook | Role |
|---|---|
| `llm/stream` (prepend) | Feeds `reasoning-delta` chunks to **two** pure detectors — repetition and degeneracy — and `text-delta` to a third when `degeneracyOnAnswer` is on. On a trip: drain the rest silently, emit a terminal `finish` chunk (`kind: 'aborted'`). |
| `agent/request-error` (prepend) | Recovers **only this plugin's own** aborts, within a per-turn budget, by returning `{ kind: 'retry' }`. Everything else delegates to `next()`. |
| `agent/request` (prepend) | Stamps the session's turn; forces `reasoningEffort: 'off'` on the recovered attempt. |
| `tools/post-execute` + `tools/pre-execute` (prepend) | Post-trip guidance; then tool-failure steering, then pre-dispatch denial. |

### Three design constraints that are not preferences

1. **A `llm/stream` listener must not throw, and the stream must not end without a terminal chunk.** `dsh-llm` registers its own prepend validator that fails the call with `LLM stream ended without a terminal finish chunk`; and a throwing listener is a middleware/consumer failure, documented to *"remain thrown and close the turn directly"* — so it **never reaches `agent/request-error`** and the recovery logic could not take over. Hence: lawful abort first, explicit recovery second.

2. **The terminal reason is `aborted`, not `error`.** The retryable code set is `EMPTY_RESPONSE | RATE_LIMIT | SERVER | TIMEOUT | TRANSPORT`; **`ABORTED` is not in it**. So the default handling is terminal (safe), and the retry is something this plugin opts into explicitly — once per turn, then it falls back to terminal.

3. **The pre-dispatch gate can only key on tool + normalised arguments.** At pre-dispatch time there is no result, so a signature that folded in error text could never match what `post-execute` recorded. Steering uses tool + args + code + normalised error text; the gate uses tool + args only. Digits and hex collapse during normalisation, so a retry that only changes a line number still counts as the same call — while a structurally different approach gets a fresh signature and passes.

## Detection algorithm — lens A: repetition

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

## Detection algorithm — lens B: degeneracy

See the header comment in [`lib/degeneracy.js`](./lib/degeneracy.js). Lens A asks *has this been said before*; lens B asks *does this still say anything*. It measures **what a block is made of** rather than comparing it to anything.

Each block yields up to five evidence flags, and the decision is

```
degenerate(block)  =  meaningless  AND  at least degEvidenceMin others
```

| Flag | Reads | Fires when |
|---|---|---|
| `meaningless` | letters + digits over non-space | **gate**: no lexical content left |
| `noisy` | punctuation + emoji over non-space | the block is mostly symbols |
| `low-variety` | distinct code points over the first 48 | a handful of glyphs reused |
| `run-heavy` | longest / count of symbol runs (≥ 3) | one absurd run, or many runs |
| `emoji-flood` | emoji count and density | emoji are the block's substance |

The trip is then named after the most specific evidence: `symbol-flood`, `emoji-flood`, or `degenerate-output`.

### Why the gate, and why several signals

`meaningless` is a **hard gate**, not a vote, and that buys a property instead of a tuned threshold:

> **A block carrying real lexical content can never be degenerate.**

Every false-positive risk — markdown tables, dense code, base64 blobs, numeric tables, arrow chains, JSON, `====` rules surrounded by prose, emoji used as annotation — contains words, so all of them are excluded by construction. This is measured, not asserted: `tools/calibrate.mjs` reports that **removing the gate makes three clean corpora trip**, and it is the gate that stops them.

The remaining flags then vote among themselves, so the rule stays multi-signal rather than a single test. An OR would fire on ordinary markdown, and "do not disturb normal thinking" is a hard requirement here, not a preference.

`run-heavy` is what separates a `***` flood from a `====` rule: a separator is **one** run, the flood is **many**. Both are covered (`degRunCountMin`, `degRunLenMin`) and neither is sufficient alone.

### Thresholds are measured, not guessed

`tools/calibrate.mjs` sweeps 11 degenerate corpora against 11 clean ones and reports `cleanTrips / degenerateMisses` for each `evidenceMin × streak` pair:

| `evidenceMin` | streak 1 | streak 2 | streak 3 | streak 4 |
|---|---|---|---|---|
| 1 | **1 / 0** | 0 / 0 | 0 / 0 | 0 / 2 |
| 2 | **1 / 0** | **0 / 0** ← shipped | 0 / 0 | 0 / 2 |
| 3 | 1 / 2 | 0 / 2 | 0 / 2 | 0 / 4 |
| 4 | 0 / 10 | 0 / 10 | 0 / 10 | 0 / 10 |

The shipped `2 / 2` is the largest setting that misses nothing and the smallest that trips on nothing. `evidenceMin: 1` trips on legitimate markdown; `3` already misses two real floods.

Measured per-block figures for the shapes that matter (default thresholds, `blockChars: 128`):

| Corpus | meaning | noise | variety | runs | verdict |
|---|---|---|---|---|---|
| `*** ` flood | 0.000 | 1.00 | 0.04 | 32 | trip at block **1** |
| one 600-char `*` run | 0.000 | 1.00 | 0.02 | 1 | trip at block **1** |
| rotating emoji flood | 0.000 | 1.00 | 0.06 | 0 | trip at block **1** |
| 200 distinct emoji, no repeat | 0.000 | 1.00 | 1.33 | 0 | trip at block **1** |
| CJK punctuation soup | 0.000 | 1.00 | 0.13 | 0 | trip at block **1** |
| varied English reasoning | 0.972 | 0.03 | 0.60 | 0 | no trip |
| markdown table | 0.333 | 0.67 | 0.25 | 9 | no trip (gate shut) |
| code block | 0.719 | 0.28 | 0.54 | 0 | no trip |
| 200-char `====` rule in prose | 0.047 | 0.95 | 0.19 | 1 | no trip (streak never reaches 2) |
| ASCII box with labels | 0.108 | 0.89 | 0.23 | 4 | no trip (gate shut) |
| emoji as annotation | 0.752 | 0.25 | 0.63 | 0 | no trip |

### Why this is not redundant with lens A

The 200-distinct-emoji corpus above is the case that justifies the second lens. It is cycled with a stride co-prime to the block size, so no two blocks are byte-identical and the 4-gram shingle sets never line up (measured overlap ≈ 0.28, against a `noveltyOverlap` of 0.70). **Lens A is blind to it by construction**; lens B catches it in two blocks. Both directions are pinned by tests — including the converse, that a repetitive flood is normally caught by lens A first.

The two lenses are also complementary in the other direction: degenerate-but-wordy shapes (`* 检查 * 检查 * 检查`, `好的好的好的`) carry lexical content and are out of scope here — they are exactly what lens A's repetition rules catch.

## Configuration

The full recommended block lives in [`cordis.patch.yml`](./cordis.patch.yml). Every key is optional; the plugin's defaults equal the values shown there.

## Known limits (stated plainly)

- **Context is never rewound.** This is the fundamental limit: the looped reasoning is already committed to the transcript and no hook removes it (assembly re-reads the log, and rewriting history would break the provider prompt cache). "Re-think" means *the same step, done cleanly once* — not a cleared history. The post-trip hint is the available counter-measure.
- **No round budget.** Cross-step loops (failing differently every time) are out of scope; the harness has no `maxSteps`/`maxTurns`.
- **A loop unit shorter than one block, dragged along by varying content, is missed** (measured overlap 0.22 for a 6-character phrase followed by a ticking counter).
- **Semantic circling is missed** — detection is character-repetition based.
- **A tool that reports failure as success is not caught** (by design: that is the tool's semantics).
- **Each trip costs something**: a few hundred to a few thousand tokens.

Specific to the degeneracy lens:

- **A block with any real lexical content is invisible to it, by design.** That is the guarantee, and it is also the blind spot: `* 检查 * 检查 * 检查` and `好的好的好的` are wordy, so they are out of scope. Lens A catches those.
- **Pure-symbol ASCII art can trip.** A block that is entirely `+`/`-`/`|` with no labels in it raises the gate plus three signals. Requiring `degStreak: 3` is the first thing to try if a workload draws a lot of it. A box with words in it (measured above) is safe.
- **The gate is a ratio, not a word count.** A block that is 95 % symbols and 5 % words passes the gate (meaning ratio 0.05 ≤ 0.08) and can trip. This is deliberate — a `***` wall with a stray word in it is still a wall — but it is the boundary to know about.
- **Emoji classification is heuristic.** `\p{Extended_Pictographic}` minus a deny-list for pictographs that technical prose uses as text (arrows, `©`, `®`, `™`). A misclassified glyph only moves it between the `emoji-flood` and `noisy` signals, both of which are secondary, so detection power is unaffected — but the rule *name* in the log can be off for exotic symbols.
- **The answer stream is not watched by default.** Aborting output the user is already reading is a bigger deal than aborting a thought; turn on `degeneracyOnAnswer` if that trade is right for you.

## Verify

```bash
npm run check     # everything below in one shot: no network, no install
npm test          # 132 tests
npm run calibrate # re-measure both threshold tables
npm run verify    # cordis contract regression
```

On Windows use `check.cmd`; on Linux/macOS use `./check.sh`.

### CI status

The workflow lives at [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) and runs on
every push and pull request: the full test suite, the host-contract regression, the
calibration sweep, a syntax pass over every module, and an `npm pack --dry-run` check that
the runtime files are actually inside the published package.

`npm run check` runs the same checks locally, with no network and no install.

## Install

See [INSTALL.md](./INSTALL.md).

## License

MIT
