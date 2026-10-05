/**
 * Integration tests for the host wiring. Run with:
 *   node --test test/plugin.test.mjs
 *
 * `apply` is exercised against a stub context that mirrors the verified DSH
 * surface: `ctx.on(name, handler, { prepend })` and `ctx.logger`. The stream
 * generator is driven directly, which is also what pins the two contract facts
 * that are easy to get wrong:
 *
 *   1. the stream must end with a terminal `finish` chunk — dsh-llm's own
 *      prepend validator fails the call with "LLM stream ended without a
 *      terminal finish chunk" otherwise;
 *   2. that terminal chunk must be `aborted`, not `error`, because `ABORTED` is
 *      outside the retryable code set, so the turn closes instead of retrying.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

/** Minimal stub of the cordis host surface the plugin touches. */
function makeCtx() {
  const listeners = new Map();
  const logs = [];
  return {
    ctx: {
      on(name, handler, options) {
        const entry = { handler, options };
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(entry);
        return () => {};
      },
      logger: {
        warn: (...args) => logs.push(['warn', args]),
        info: (...args) => logs.push(['info', args]),
      },
    },
    logs,
    /**
     * Invoke the first registered handler for an event.
     *
     * Two `next` conventions exist on the host and this stub must serve both:
     *  - waterfall-only (`agent/request`, `agent/request-error`) takes `next` as
     *    its last argument;
     *  - result waterfalls (`tools/post-execute`, `tools/pre-execute`,
     *    `llm/stream`) take `next` before the payload/result, so it is passed
     *    positionally and also exposed as `this.next` for convenience.
     */
    async call(name, a, b, c) {
      const entry = listeners.get(name)?.[0];
      assert.ok(entry, `no listener registered for ${name}`);
      const next =
        typeof b === 'function' ? b : typeof c === 'function' ? c : async () => undefined;
      const result = entry.handler(a, b, c);
      return result;
    },
    /** A `next` that resolves to a fixed value, for result waterfalls. */
    fixed(value) {
      return async () => value;
    },
    optionsFor(name) {
      return listeners.get(name)?.[0]?.options;
    },
  };
}

/**
 * A realistic runaway reasoning loop: the model re-emits the same paragraph with
 * a ticking counter. Comfortably longer than one detector block and repeated
 * often enough that the trip is unambiguous.
 */
function loopDeltas(count = 40, i0 = 0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      `I need to verify the adapter accepts this reasoning effort value. ` +
        `Checking attempt ${i0 + i} of ${count}, still no new conclusion, ` +
        `so I will check the same field once more.\n`,
    );
  }
  return out;
}

function reasoningChunks(texts) {
  return texts.map((text) => ({ type: 'reasoning-delta', index: 0, text }));
}

/** Collect a guarded stream into an array. */
async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

test('both listeners register with prepend', () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  assert.equal(stub.optionsFor('agent/request')?.prepend, true);
  assert.equal(stub.optionsFor('llm/stream')?.prepend, true);
});

test('a clean reasoning stream passes through untouched and without a finish', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    ...reasoningChunks(['The file lists one model. ', 'I will read the second row next. ']),
    { type: 'text-delta', index: 1, text: 'Done.' },
  ];
  const stream = await stub.call('llm/stream', { sessionId: 's1' }, async function* () {
    for (const c of chunks) yield c;
  });
  const out = await drain(stream);
  assert.deepEqual(out, chunks, 'a clean stream must pass through byte-for-byte');
  assert.equal(
    out.some((c) => c.type === 'finish'),
    false,
    'the breaker must not inject a finish chunk when it never tripped',
  );
});

test('a looping reasoning stream is aborted with a terminal aborted finish chunk', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  const chunks = reasoningChunks(loopDeltas());
  const stream = await stub.call('llm/stream', { sessionId: 's2' }, async function* () {
    for (const c of chunks) yield c;
  });
  const out = await drain(stream);

  const finish = out.find((c) => c.type === 'finish');
  assert.ok(finish, 'the host validator requires a terminal finish chunk');
  assert.equal(finish.reason.kind, 'aborted', 'must be aborted: ABORTED is not retryable');
  assert.equal(finish.reason.failure.code, 'ABORTED');
  assert.ok(
    out.filter((c) => c.type === 'reasoning-delta').length < loopDeltas().length,
    'content after the trip must not be relayed',
  );
  assert.equal(out.at(-1), finish, 'the finish chunk must be terminal (last)');
  assert.equal(stub.logs.some(([level]) => level === 'warn'), true, 'a trip must be logged');
});

test('the abort is always terminal and always drains the provider stream', async () => {
  // `stopStreamOnTrip` is not configurable by design: draining without relaying
  // is required to close the provider stream cleanly, and every terminal path
  // must still emit a finish chunk for the host validator.
  const stub = makeCtx();
  apply(stub.ctx, {});
  const chunks = reasoningChunks(loopDeltas());
  const stream = await stub.call('llm/stream', { sessionId: 's3' }, async function* () {
    for (const c of chunks) yield c;
  });
  const out = await drain(stream);
  const finish = out.find((c) => c.type === 'finish');
  assert.ok(finish);
  assert.equal(finish.reason.kind, 'aborted');
  assert.equal(out.at(-1), finish, 'the finish chunk must be last');
});

test('maxReasoningChars trips on a long non-repeating stream', async () => {
  const stub = makeCtx();
  apply(stub.ctx, { maxReasoningChars: 500 });
  const texts = [];
  for (let i = 0; i < 60; i++) texts.push(`unique reasoning token ${i} x${(i * 7919) % 104729}. `);
  const stream = await stub.call('llm/stream', { sessionId: 's4' }, async function* () {
    for (const c of reasoningChunks(texts)) yield c;
  });
  const out = await drain(stream);
  const finish = out.find((c) => c.type === 'finish');
  assert.ok(finish, 'the ceiling must terminate the stream lawfully');
  assert.equal(finish.reason.kind, 'aborted');
});

test('auxiliary calls are skipped by default', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  const chunks = reasoningChunks(loopDeltas());
  let called = 0;
  const stream = await stub.call('llm/stream', { sessionId: 's5', purpose: 'session-title' }, async function* () {
    called++;
    for (const c of chunks) yield c;
  });
  const out = await drain(stream);
  assert.equal(called, 1);
  assert.equal(out.length, chunks.length, 'aux stream must pass through untouched');
  assert.equal(out.at(-1).type, 'reasoning-delta');
});

test('a tripped session is forced to reasoningEffort=off on the next request', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});

  // The turn is stamped by agent/request before the stream runs.
  const seeded = await stub.call(
    'agent/request',
    { agent: { id: 'sess-a' }, turn: 4 },
    async () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }),
  );
  assert.equal(seeded.reasoningEffort, 'high', 'an unarmed breaker must not change the config');

  const chunks = reasoningChunks(loopDeltas());
  const stream = await stub.call('llm/stream', { sessionId: 'sess-a' }, async function* () {
    for (const c of chunks) yield c;
  });
  await drain(stream);

  const afterTrip = await stub.call(
    'agent/request',
    { agent: { id: 'sess-a' }, turn: 4 },
    async () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }),
  );
  assert.equal(afterTrip.reasoningEffort, 'off', 'the tripped session must be forced to off');
});

test('the force-off does not leak into a later turn', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 'sess-b' }, turn: 1 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  const stream = await stub.call('llm/stream', { sessionId: 'sess-b' }, async function* () {
    for (const c of reasoningChunks(loopDeltas())) yield c;
  });
  await drain(stream);

  const nextTurn = await stub.call('agent/request', { agent: { id: 'sess-b' }, turn: 2 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  assert.equal(nextTurn.reasoningEffort, 'high', 'a new turn must start clean');
});

test('a trip in one session does not arm another', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 'sess-c' }, turn: 1 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  const stream = await stub.call('llm/stream', { sessionId: 'sess-c' }, async function* () {
    for (const c of reasoningChunks(loopDeltas())) yield c;
  });
  await drain(stream);

  const other = await stub.call('agent/request', { agent: { id: 'sess-d' }, turn: 1 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  assert.equal(other.reasoningEffort, 'high', 'breakers are per-session');
});

test('the force-off applies only to the retried attempt of the tripping turn', async () => {
  // There is deliberately no `tripsBeforeForceOff` knob any more: after a trip
  // the recovery attempt runs with thinking off, and the NEXT turn starts clean
  // (asserted by "the force-off does not leak into a later turn").
  const stub = makeCtx();
  apply(stub.ctx, {});
  await tripOnce(stub, 'sess-t', 1);

  const retryAttempt = await stub.call('agent/request', { agent: { id: 'sess-t' }, turn: 1 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  assert.equal(retryAttempt.reasoningEffort, 'off');

  const nextTurn = await stub.call('agent/request', { agent: { id: 'sess-t' }, turn: 2 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  assert.equal(nextTurn.reasoningEffort, 'high');
});

test('maxTokens is only lowered, never raised', async () => {
  const stub = makeCtx();
  apply(stub.ctx, { maxTokens: 60000 });
  const lowered = await stub.call('agent/request', { agent: { id: 'sess-f' }, turn: 1 }, async () => ({
    provider: 'p',
    model: 'm',
    maxTokens: 256000,
  }));
  assert.equal(lowered.maxTokens, 60000);

  const alreadyLower = await stub.call('agent/request', { agent: { id: 'sess-g' }, turn: 1 }, async () => ({
    provider: 'p',
    model: 'm',
    maxTokens: 1000,
  }));
  assert.equal(alreadyLower.maxTokens, 1000, 'a lower seed value must win');
});

test('enabled=false makes both arms inert', async () => {
  const stub = makeCtx();
  apply(stub.ctx, { enabled: false });
  const chunks = reasoningChunks(loopDeltas());
  const stream = await stub.call('llm/stream', { sessionId: 'sess-h' }, async function* () {
    for (const c of chunks) yield c;
  });
  const out = await drain(stream);
  assert.deepEqual(out, chunks);

  const cfg = await stub.call('agent/request', { agent: { id: 'sess-h' }, turn: 1 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  assert.equal(cfg.reasoningEffort, 'high');
});

test('a missing sessionId still yields a lawful, aborted stream', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  const stream = await stub.call('llm/stream', {}, async function* () {
    for (const c of reasoningChunks(loopDeltas())) yield c;
  });
  const out = await drain(stream);
  assert.equal(out.find((c) => c.type === 'finish')?.reason.kind, 'aborted');
});

// ---------------------------------------------------------------------------
// The re-think recovery path (arm agent/request-error)
// ---------------------------------------------------------------------------

/** Drive a full turn: stamp the turn, trip the loop, then report the failure. */
async function tripOnce(stub, sessionId, turn, config = {}) {
  apply(stub.ctx, config);
  await stub.call('agent/request', { agent: { id: sessionId }, turn }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  const stream = await stub.call('llm/stream', { sessionId }, async function* () {
    for (const c of reasoningChunks(loopDeltas())) yield c;
  });
  const out = await drain(stream);
  return out;
}

test('all four arms register with prepend', () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  for (const name of ['agent/request', 'agent/request-error', 'llm/stream', 'tools/pre-execute', 'tools/post-execute']) {
    assert.equal(stub.optionsFor(name)?.prepend, true, `${name} must be prepended`);
  }
});

test('our own loop abort is recovered once with a fresh attempt', async () => {
  const stub = makeCtx();
  await tripOnce(stub, 'sess-r', 7);

  const action = await stub.call(
    'agent/request-error',
    {
      agent: { id: 'sess-r' },
      turn: 7,
      step: 1,
      provider: 'p',
      failure: {
        message: 'thinking-breaker aborted a runaway reasoning stream (low-novelty, 1300 reasoning chars)',
        code: 'ABORTED',
      },
    },
    async () => undefined,
  );
  assert.deepEqual(action, { kind: 'retry' }, 'the loop abort must be retried, not left terminal');
});

test('the retry budget is spent after one recovery', async () => {
  const stub = makeCtx();
  await tripOnce(stub, 'sess-r2', 3);
  const payload = {
    agent: { id: 'sess-r2' },
    turn: 3,
    step: 1,
    provider: 'p',
    failure: { message: 'thinking-breaker aborted ...', code: 'ABORTED' },
  };
  let delegated = 0;
  const first = await stub.call('agent/request-error', payload, async () => {
    delegated++;
    return undefined;
  });
  assert.deepEqual(first, { kind: 'retry' });
  assert.equal(delegated, 0, 'the first recovery must not delegate');

  const second = await stub.call('agent/request-error', payload, async () => {
    delegated++;
    return undefined;
  });
  assert.equal(second, undefined, 'the second failure must be left terminal');
  assert.equal(delegated, 1, 'the exhausted path must delegate to next()');
});

test('foreign failures are never retried by this plugin', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  let delegated = 0;
  const out = await stub.call(
    'agent/request-error',
    { agent: { id: 'sess-x' }, turn: 1, provider: 'p', failure: { message: 'socket hang up', code: 'TRANSPORT' } },
    async () => {
      delegated++;
      return undefined;
    },
  );
  assert.equal(out, undefined);
  assert.equal(delegated, 1, 'a non-breaker failure must delegate');
});

test('maxLoopRetriesPerTurn=0 makes the loop abort terminal', async () => {
  const stub = makeCtx();
  await tripOnce(stub, 'sess-r3', 1, { maxLoopRetriesPerTurn: 0 });
  let delegated = 0;
  const out = await stub.call(
    'agent/request-error',
    { agent: { id: 'sess-r3' }, turn: 1, provider: 'p', failure: { message: 'thinking-breaker aborted', code: 'ABORTED' } },
    async () => {
      delegated++;
      return undefined;
    },
  );
  assert.equal(out, undefined);
  assert.equal(delegated, 1, 'with a zero budget the failure must stay terminal');
});

test('retryWithoutThinking=false leaves the effort alone', async () => {
  const stub = makeCtx();
  await tripOnce(stub, 'sess-r4', 2, { retryWithoutThinking: false });
  const cfg = await stub.call('agent/request', { agent: { id: 'sess-r4' }, turn: 2 }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  assert.equal(cfg.reasoningEffort, 'high');
});

// ---------------------------------------------------------------------------
// Tool-failure arm
// ---------------------------------------------------------------------------

function toolExec(sessionId, name, args) {
  return { callId: 'c1', name, arguments: args, agent: { id: sessionId }, signal: new AbortController().signal };
}

function failedResult(message = 'TypeError: bad escape at line 42') {
  return {
    kind: 'accept',
    isError: true,
    error: { message, info: { name: 'Error', code: 'E_BAD_INPUT' } },
    content: [{ type: 'text', text: message }],
  };
}

async function failTwice(stub, sessionId, args) {
  apply(stub.ctx, {});
  const exec = toolExec(sessionId, 'run_python', args);
  await stub.call('agent/request', { agent: { id: sessionId }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const first = await stub.call('tools/post-execute', exec, failedResult(), async () => failedResult());
  const second = await stub.call('tools/post-execute', exec, failedResult(), async () => failedResult());
  return { first, second, exec };
}

test('the first tool failure passes through untouched', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 't1' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const original = failedResult();
  const decision = await stub.call(
    'tools/post-execute',
    toolExec('t1', 'run_python', { code: 'x' }),
    original,
    async () => original,
  );
  assert.equal(decision, original, 'a single failure must not be rewritten');
});

test('the second similar tool failure is steered to change approach', async () => {
  const stub = makeCtx();
  const { second } = await failTwice(stub, 't2', { code: 'print(1)' });
  assert.equal(second.kind, 'accept');
  const text = second.content.map((b) => b.text).join('');
  assert.match(text, /thinking-breaker/);
  assert.match(text, /failed 2 time/);
  assert.match(text, /Do NOT retry it unchanged/i);
  assert.match(text, /Original error:/);
  assert.match(text, /bad escape/, 'the original error must be preserved');
});

test('a third failure of the identical call is denied before dispatch', async () => {
  const stub = makeCtx();
  const { exec } = await failTwice(stub, 't3', { code: 'print(1)' });

  // Tool calls are counted, so the gate must see the two failures recorded above.
  await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' })); // 2 recorded -> threshold 3 not met
  const thirdFail = await stub.call('tools/post-execute', exec, failedResult(), async () => failedResult());
  assert.equal(thirdFail.kind, 'accept');

  const decision = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny', 'after toolFailureDenyAfter failures the call must be denied');
  assert.match(decision.reason, /thinking-breaker/);
  assert.match(decision.reason, /Change the approach/);

  // Once denied it stays denied for the turn, even before another failure.
  const again = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(again.kind, 'deny');
});

test('changed arguments start a fresh streak', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 't4' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const a = toolExec('t4', 'run_python', { code: 'print(1)' });
  await stub.call('tools/post-execute', a, failedResult(), async () => failedResult());
  await stub.call('tools/post-execute', a, failedResult(), async () => failedResult());

  // Different arguments => different call signature => not denied.
  const b = toolExec('t4', 'run_python', { code: 'print(2)' });
  const decision = await stub.call('tools/pre-execute', b, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'allow', 'a structurally different call must not be denied');
});

test('a new turn clears the tool-failure streak', async () => {
  const stub = makeCtx();
  const { exec } = await failTwice(stub, 't5', { code: 'print(1)' });
  await stub.call('tools/post-execute', exec, failedResult(), async () => failedResult());
  const denied = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(denied.kind, 'deny');

  await stub.call('agent/request', { agent: { id: 't5' }, turn: 2 }, async () => ({ provider: 'p', model: 'm' }));
  const fresh = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(fresh.kind, 'allow', 'a new turn must earn a fresh chance');
});

test('toolFailureGuard=false disables both tool arms', async () => {
  const stub = makeCtx();
  apply(stub.ctx, { toolFailureGuard: false });
  await stub.call('agent/request', { agent: { id: 't6' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const exec = toolExec('t6', 'run_python', { code: 'x' });
  for (let i = 0; i < 5; i++) {
    const original = failedResult();
    const decision = await stub.call('tools/post-execute', exec, original, async () => original);
    assert.equal(decision, original);
  }
  const gate = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'allow');
});

test('success through the same call does not itself trigger the guard', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 't7' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const exec = toolExec('t7', 'read', { path: 'a.txt' });
  const ok = { kind: 'accept', isError: false, value: 'hi', content: [{ type: 'text', text: 'hi' }] };
  const decision = await stub.call('tools/post-execute', exec, ok, async () => ok);
  assert.equal(decision, ok, 'a successful result is never rewritten');
  const gate = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'allow');
});

test('signature normalisation collapses numbers so similar failures share a streak', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 't8' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const exec = toolExec('t8', 'run_python', { code: 'x' });
  const r1 = failedResult('ValueError: bad input at line 42');
  const r2 = failedResult('ValueError: bad input at line 99');
  await stub.call('tools/post-execute', exec, r1, async () => r1);
  const second = await stub.call('tools/post-execute', exec, r2, async () => r2);
  const text = second.content.map((b) => b.text).join('');
  assert.match(text, /failed 2 time/, 'differing line numbers must still count as the same failure kind');
});

// ---------------------------------------------------------------------------
// Post-trip guidance delivery (option A)
// ---------------------------------------------------------------------------

const OK_RESULT = () => ({ kind: 'accept', isError: false, value: 'ok', content: [{ type: 'text', text: 'file contents' }] });

async function tripTurn(stub, sessionId, turn, config = {}) {
  apply(stub.ctx, config);
  await stub.call('agent/request', { agent: { id: sessionId }, turn }, async () => ({
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  }));
  const stream = await stub.call('llm/stream', { sessionId }, async function* () {
    for (const c of reasoningChunks(loopDeltas())) yield c;
  });
  await drain(stream);
}

test('post-trip guidance is delivered once, on the next tool result', async () => {
  const stub = makeCtx();
  await tripTurn(stub, 'h1', 1);

  const exec = toolExec('h1', 'read', { path: 'a.txt' });
  const first = await stub.call('tools/post-execute', exec, OK_RESULT(), async () => OK_RESULT());
  const text = first.content.map((b) => b.text).join('\n');
  assert.match(text, /thinking-breaker/, 'the hint must be delivered');
  assert.match(text, /kept repeating itself/);
  assert.match(text, /Do not resume or restate that line of reasoning/);
  assert.ok(
    text.includes('file contents'),
    'the original result content must be preserved after the hint',
  );

  // Delivered once: the following result must be untouched.
  const second = await stub.call('tools/post-execute', exec, OK_RESULT(), async () => OK_RESULT());
  assert.deepEqual(second.content, [{ type: 'text', text: 'file contents' }]);
});

test('the hint is delivered even when the next result FAILS', async () => {
  // Most recovering turns have no successful tool call at all, so gating the
  // hint on success would mean it frequently never ships.
  const stub = makeCtx();
  await tripTurn(stub, 'h2', 1);
  const exec = toolExec('h2', 'run_python', { code: 'boom' });
  const r = failedResult('SyntaxError: unexpected EOF');
  const decision = await stub.call('tools/post-execute', exec, r, async () => r);
  const text = decision.content.map((b) => b.text).join('\n');
  assert.match(text, /kept repeating itself/);
  assert.match(text, /unexpected EOF/, 'the real failure must survive the hint');
});

test('nested (subagent) calls do not consume the hint', async () => {
  const stub = makeCtx();
  await tripTurn(stub, 'h3', 1);
  const nested = { ...toolExec('h3', 'read', { path: 'x' }), parent: Symbol('parent') };
  const nestedOut = await stub.call('tools/post-execute', nested, OK_RESULT(), async () => OK_RESULT());
  assert.equal(nestedOut.content.some((b) => /thinking-breaker/.test(b.text ?? '')), false, 'nested call must not take it');

  const top = await stub.call('tools/post-execute', toolExec('h3', 'read', { path: 'y' }), OK_RESULT(), async () => OK_RESULT());
  assert.equal(top.content.some((b) => /thinking-breaker/.test(b.text ?? '')), true, 'the top-level call still gets it');
});

test('a new turn clears an undelivered hint', async () => {
  const stub = makeCtx();
  await tripTurn(stub, 'h4', 1);
  await stub.call('agent/request', { agent: { id: 'h4' }, turn: 2 }, async () => ({ provider: 'p', model: 'm' }));
  const out = await stub.call('tools/post-execute', toolExec('h4', 'read', { path: 'z' }), OK_RESULT(), async () => OK_RESULT());
  assert.equal(out.content.some((b) => /thinking-breaker/.test(b.text ?? '')), false);
});

test('postTripHint=false suppresses the guidance', async () => {
  const stub = makeCtx();
  await tripTurn(stub, 'h5', 1, { postTripHint: false });
  const out = await stub.call('tools/post-execute', toolExec('h5', 'read', { path: 'z' }), OK_RESULT(), async () => OK_RESULT());
  assert.deepEqual(out.content, [{ type: 'text', text: 'file contents' }]);
});

test('a hint never replaces a pre-existing decision with a non-accept kind', async () => {
  const stub = makeCtx();
  await tripTurn(stub, 'h6', 1);
  const blocked = { kind: 'block' };
  const out = await stub.call('tools/post-execute', toolExec('h6', 'read', { path: 'z' }), OK_RESULT(), async () => blocked);
  assert.equal(out, blocked, 'a non-accept decision must pass through untouched');
  // And the hint must still be pending afterwards, since it was never delivered.
  const later = await stub.call('tools/post-execute', toolExec('h6', 'read', { path: 'w' }), OK_RESULT(), async () => OK_RESULT());
  assert.equal(later.content.some((b) => /thinking-breaker/.test(b.text ?? '')), true);
});

// ---------------------------------------------------------------------------
// Bug-hunt regressions
// ---------------------------------------------------------------------------

test('a deny is lifted once the same call actually succeeds', async () => {
  // Without this, a call that was denied early could stay refused for the rest of
  // the turn even after the model found a working input.
  const stub = makeCtx();
  const { exec } = await failTwice(stub, 'b1', { code: 'print(1)' });
  await stub.call('tools/post-execute', exec, failedResult(), async () => failedResult());

  const denied = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(denied.kind, 'deny');

  // The model fixes it and the call succeeds -> the deny must be cleared.
  const ok = { kind: 'accept', isError: false, value: 'done', content: [{ type: 'text', text: 'done' }] };
  await stub.call('tools/post-execute', exec, ok, async () => ok);

  const allowed = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(allowed.kind, 'allow', 'a succeeded call must not stay denied');
});

test('a BigInt in tool arguments does not throw inside the gate', async () => {
  // stableJson -> JSON.stringify throws on BigInt; the gate must degrade, not
  // break the dispatch it is supposed to be protecting.
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 'b2' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const exec = toolExec('b2', 'run_python', { code: 'x', n: 1n });
  const gate = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'allow');
  const r = failedResult('TypeError: nope');
  const post = await stub.call('tools/post-execute', exec, r, async () => r);
  assert.ok(post === r || post.kind === 'accept', 'post-execute must not throw either');
});

test('the guidance reports the turn total, not just one failure kind', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 'b3' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const exec = toolExec('b3', 'run_python', { code: 'x' });
  // Two failures with DIFFERENT texts: two signatures, but one turn total.
  await stub.call('tools/post-execute', exec, failedResult('Error A at line 1'), async () => failedResult('Error A at line 1'));
  const second = await stub.call('tools/post-execute', exec, failedResult('Error B at line 2'), async () => failedResult('Error B at line 2'));
  const text = second.content.map((b) => b.text).join('\n');
  assert.match(text, /failed 2 time/, 'the count must reflect the whole turn');
});

test('a cycle in tool arguments does not hang or throw', async () => {
  const stub = makeCtx();
  apply(stub.ctx, {});
  await stub.call('agent/request', { agent: { id: 'b4' }, turn: 1 }, async () => ({ provider: 'p', model: 'm' }));
  const cyc = { a: 1 };
  cyc.self = cyc;
  const exec = toolExec('b4', 'run_python', cyc);
  const gate = await stub.call('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.equal(gate.kind, 'allow');
});
