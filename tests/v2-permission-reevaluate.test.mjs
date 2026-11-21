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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pendingStore } from '../plugins/v2/permission-reevaluate.mjs';

test('asks pending under the previous plugin instance are re-checked on reload, approve-only and logged', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-pending-'));
  const store = pendingStore('/w/p', { root });
  // Previous instance: two asks were raised and persisted.
  const before = harness(() => 'ask');
  const logs1 = [];
  const first = await installPermissionReevaluation(before.ctx, { setTimer: before.setTimer, clearTimer: () => {}, store, log: r => logs1.push(r) });
  await before.toolHooks['execute.before']({ sessionID: 'ses_1', id: 'call_a', agent: 'verifier', tool: 'read' });
  await before.toolHooks['execute.before']({ sessionID: 'ses_1', id: 'call_b', agent: 'builder', tool: 'bash' });
  before.ask({ id: 'per_a', sessionID: 'ses_1', action: 'read', resources: ['/x/own.out'], source: { id: 'call_a' } });
  before.ask({ id: 'per_b', sessionID: 'ses_1', action: 'shell', resources: ['rm -rf /tmp/y'], source: { id: 'call_b' } });
  before.ask({ id: 'per_c', sessionID: 'ses_1', action: 'read', resources: ['/x/other.out'] });
  await tick(); await tick();
  assert.deepEqual(store.load().map(([id]) => id).sort(), ['per_a', 'per_b', 'per_c']);
  assert.deepEqual(store.load().find(([id]) => id === 'per_a')[2], { agent: 'verifier', tool: 'read' });
  first.stop();
  assert.equal(store.load().length, 3, 'stop keeps the persisted asks for the next instance');

  // New instance (deploy hot reload): the native asks still exist; new rules allow only per_a.
  const after = harness(input => input.action === 'read' ? 'allow' : 'ask');
  for (const id of ['per_a', 'per_b', 'per_c']) after.pending.set(id, { id, sessionID: 'ses_1', action: id === 'per_b' ? 'shell' : 'read', resources: [] });
  const logs = [];
  const second = await installPermissionReevaluation(after.ctx, { setTimer: after.setTimer, clearTimer: () => {}, store, log: r => logs.push(r) });
  assert.equal(after.timers.length, 2, 'a recheck is scheduled on install');
  after.timers[0].fn(); await second.recheck();
  assert.deepEqual(after.replies, [{ sessionID: 'ses_1', requestID: 'per_a', decision: 'once' }]);
  assert.ok(after.replies.every(reply => reply.decision === 'once'), 'never rejects');
  assert.ok(after.pending.has('per_b'), 'the still-ask request stays answerable');
  assert.ok(logs.some(r => r.requestID === 'per_a' && r.outcome === 'approved_once' && r.trigger === 'reload'));
  assert.ok(logs.some(r => r.requestID === 'per_b' && r.outcome === 'still_pending'));
  assert.ok(logs.some(r => r.requestID === 'per_c' && r.why === 'agent_unknown'), 'no agent: not probed under broader rules');
  assert.equal(after.probes.find(p => p.metadata?.[markers.PROBE_MARKER] && p.agent === 'verifier')?.metadata.harnessProbeTool, 'read');
  assert.deepEqual(store.load().map(([id]) => id).sort(), ['per_b', 'per_c']);
  second.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

import { sweepEmptyPending, isEmptyPendingText } from '../plugins/v2/permission-reevaluate.mjs';

test('r32: the pending file is deleted when its map becomes empty and rewritten when an ask appears', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-pending-'));
  const store = pendingStore('/w/q', { root });
  store.save(new Map([['per_1', 'ses_1']]), new Map([['per_1', { agent: 'builder' }]]));
  assert.ok(fs.existsSync(store.file));
  store.save(new Map(), new Map());
  assert.equal(fs.existsSync(store.file), false, 'empty map: no file left behind');
  store.save(new Map(), new Map()); // already absent: no throw, no file
  assert.equal(fs.existsSync(store.file), false);
  store.save(new Map([['per_2', 'ses_1']]));
  assert.deepEqual(store.load().map(([id]) => id), ['per_2']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('r32: startup sweep removes only empty pending files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-pending-'));
  const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
  write('aaaaaaaaaaaaaaaaaaaaaaaa.json', '{"pending":{},"meta":{}}');
  write('bbbbbbbbbbbbbbbbbbbbbbbb.json', '{"pending":{"per_x":"ses_1"},"meta":{}}');
  write('cccccccccccccccccccccccc.json', '{not json');
  write('dddddddddddddddddddddddd.json', '{"pending":[]}');
  write('notes.json', '{"pending":{}}');
  const removed = sweepEmptyPending({ root });
  assert.deepEqual(removed, ['aaaaaaaaaaaaaaaaaaaaaaaa.json']);
  assert.deepEqual(fs.readdirSync(root).sort(), ['bbbbbbbbbbbbbbbbbbbbbbbb.json', 'cccccccccccccccccccccccc.json', 'dddddddddddddddddddddddd.json', 'notes.json']);
  assert.equal(fs.readFileSync(path.join(root, 'bbbbbbbbbbbbbbbbbbbbbbbb.json'), 'utf8'), '{"pending":{"per_x":"ses_1"},"meta":{}}');
  assert.equal(isEmptyPendingText('{"pending":{"a":"b"}}'), false);
  assert.deepEqual(sweepEmptyPending({ root: path.join(root, 'missing') }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('r32: sweep restores a file that gained an entry between the check and the move', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-pending-'));
  const file = path.join(root, 'eeeeeeeeeeeeeeeeeeeeeeee.json');
  fs.writeFileSync(file, '{"pending":{},"meta":{}}');
  // A concurrent writer replaces the file right before the sweep moves it aside.
  const io = { ...fs, renameSync(from, to) { fs.writeFileSync(from, '{"pending":{"per_live":"ses_9"},"meta":{}}'); return fs.renameSync(from, to); } };
  assert.deepEqual(sweepEmptyPending({ root, io }), []);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"pending":{"per_live":"ses_9"},"meta":{}}');
  assert.deepEqual(fs.readdirSync(root), ['eeeeeeeeeeeeeeeeeeeeeeee.json'], 'no .sweep leftovers');
  fs.rmSync(root, { recursive: true, force: true });
});

test('r32: install sweeps empty files once and logs the count', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-pending-'));
  fs.writeFileSync(path.join(root, 'ffffffffffffffffffffffff.json'), '{"pending":{},"meta":{}}');
  const store = pendingStore('/w/r', { root });
  const h = harness(() => 'ask'), logs = [];
  const handle = await installPermissionReevaluation(h.ctx, { setTimer: h.setTimer, clearTimer: () => {}, store, log: r => logs.push(r) });
  assert.equal(fs.existsSync(path.join(root, 'ffffffffffffffffffffffff.json')), false);
  assert.ok(logs.some(r => r.event === 'pending_files_swept' && r.removed === 1));
  handle.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
