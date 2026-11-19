import test from 'node:test';
import assert from 'node:assert/strict';
import { installPermissionReevaluation } from '../plugins/v2/permission-reevaluate.mjs';
import { markers } from '../plugins/v2/shell-guard.mjs';

function stream() {
  const queue = [], waiters = [];
  return {
    push(event) { const waiter = waiters.shift(); if (waiter) waiter({ value: event, done: false }); else queue.push(event); },
    subscribe() { return { [Symbol.asyncIterator]() { return { next: () => queue.length ? Promise.resolve({ value: queue.shift(), done: false }) : new Promise(resolve => waiters.push(resolve)) }; } }; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

// Simulates the native evaluator: rules decide allow/ask/deny; plugin evaluate hooks may change it.
function harness(effectFor) {
  const events = stream(), hooks = [], toolHooks = {}, replies = [], probes = [], timers = [];
  const pending = new Map();
  const ctx = {
    event: { subscribe: () => events.subscribe() },
    tool: { hook: async (name, callback) => { toolHooks[name] = callback; } },
    permission: {
      hook: async (name, callback) => { assert.equal(name, 'evaluate'); hooks.push(callback); },
      list: async ({ sessionID }) => ({ data: [...pending.values()].filter(request => request.sessionID === sessionID) }),
      reply: async input => { replies.push(input); pending.delete(input.requestID); },
      assert: async input => {
        probes.push(input);
        const event = { ...input, effect: effectFor(input) };
        for (const hook of hooks) await hook(event);
        if (event.effect === 'ask') throw new Error('probe created a real ask');
        if (event.effect === 'deny') throw new Error(event.message ?? 'denied');
      },
    },
  };
  const ask = request => { pending.set(request.id, request); events.push({ type: 'permission.asked', data: request }); };
  return { ctx, events, replies, probes, ask, pending, toolHooks, setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, timers };
}

test('config reload resolves only pending asks the new rules allow', async () => {
  let rules = 'old';
  const h = harness(input => rules === 'old' ? 'ask' : input.resources.includes('rm -rf /') ? 'ask' : input.resources.includes('mkfs') ? 'deny' : 'allow');
  const reevaluation = await installPermissionReevaluation(h.ctx, { setTimer: h.setTimer, clearTimer: () => {} });
  await h.toolHooks['execute.before']({ sessionID: 'ses_a', id: 'call_1', agent: 'harness-builder' });
  h.ask({ id: 'per_1', sessionID: 'ses_a', action: 'shell', resources: ['env'], source: { type: 'tool', messageID: 'm', id: 'call_1' } });
  h.ask({ id: 'per_2', sessionID: 'ses_a', action: 'shell', resources: ['rm -rf /'] });
  h.ask({ id: 'per_3', sessionID: 'ses_b', action: 'shell', resources: ['mkfs'] });
  h.ask({ id: 'per_4', sessionID: 'ses_b', action: 'shell', resources: ['echo > .env'], metadata: { [markers.GUARD_MARKER]: 'secret redirect' } });
  await tick();
  // Still old rules: probes never create asks and nothing is resolved.
  assert.deepEqual(await reevaluation.recheck(), []);
  rules = 'new';
  h.events.push({ type: 'config.updated', data: {} });
  await tick();
  assert.deepEqual(h.timers.map(timer => timer.delay), [1500, 6000]);
  assert.deepEqual(await reevaluation.recheck(), ['per_1']);
  assert.deepEqual(h.replies, [{ sessionID: 'ses_a', requestID: 'per_1', decision: 'once' }]);
  assert.ok([...h.pending.keys()].includes('per_2') && h.pending.has('per_3') && h.pending.has('per_4'));
  // The probe used the agent that raised the call and carried the probe marker.
  const probe = h.probes.findLast(entry => entry.resources[0] === 'env');
  assert.equal(probe.agent, 'harness-builder');
  assert.equal(probe.metadata[markers.PROBE_MARKER], true);
  // Guarded requests are never probed.
  assert.equal(h.probes.some(entry => entry.metadata?.[markers.GUARD_MARKER]), false);
  // Replying twice is avoided: a second pass resolves nothing new.
  assert.deepEqual(await reevaluation.recheck(), []);
  reevaluation.stop();
});

test('replied requests are forgotten and reload without pending asks schedules nothing', async () => {
  const h = harness(() => 'allow');
  const reevaluation = await installPermissionReevaluation(h.ctx, { setTimer: h.setTimer, clearTimer: () => {} });
  h.ask({ id: 'per_1', sessionID: 'ses_a', action: 'shell', resources: ['ls'] });
  await tick();
  h.pending.delete('per_1');
  h.events.push({ type: 'permission.replied', data: { sessionID: 'ses_a', requestID: 'per_1', reply: 'once' } });
  h.events.push({ type: 'agent.updated', data: {} });
  await tick();
  assert.equal(h.timers.length, 0);
  reevaluation.stop();
});

test('without the permission hook API no probe is attempted', async () => {
  const h = harness(() => 'allow');
  delete h.ctx.permission.hook;
  const reevaluation = await installPermissionReevaluation(h.ctx);
  assert.deepEqual(await reevaluation.recheck(), []);
  assert.equal(h.probes.length, 0);
});
