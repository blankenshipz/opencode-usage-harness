import test from 'node:test';
import assert from 'node:assert/strict';
import { installExecutionTiming } from '../plugins/v2/execution-timing.mjs';

function source() {
  const channels = new Set(); let delivered = 0;
  return {
    emit(event) { for (const channel of channels) { delivered++; const waiter = channel.waiters.shift(); if (waiter) waiter(event); else channel.events.push(event); } },
    get delivered() { return delivered; },
    subscribe() {
      const channel = { events: [], waiters: [] }; channels.add(channel);
      return { async *[Symbol.asyncIterator]() { while (true) yield await new Promise(resolve => channel.events.length ? resolve(channel.events.shift()) : channel.waiters.push(resolve)); } };
    },
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
function memoryIO({ fail = false, wait } = {}) { const writes = []; return { writes, async mkdir() {}, async chmod() {}, async appendFile(_, body) { if (wait) await wait; if (fail) throw new Error('disk unavailable'); writes.push(...body.trim().split('\n').filter(Boolean).map(JSON.parse)); } }; }
function event(id, created, type, data) { return { id, created, type, data }; }

test('records only allowlisted timing metadata and explicit 429 evidence', async () => {
  const stream = source(), io = memoryIO();
  const dispose = installExecutionTiming({ event: stream }, { io, file: '/private/timing.jsonl' });
  await tick();
  stream.emit(event('one', 10, 'session.step.started', { sessionID: 'ses1', assistantMessageID: 'msg1', started: 8, model: { secret: 'no' }, prompt: 'secret' }));
  stream.emit(event('two', 30, 'session.step.streamed', { sessionID: 'ses1', assistantMessageID: 'msg1' }));
  stream.emit(event('five', 90, 'session.step.failed', { sessionID: 'ses1', assistantMessageID: 'msg2', error: { status: 429, message: 'secret' } }));
  stream.emit(event('six', 100, 'session.step.ended', { sessionID: 'ses1', assistantMessageID: 'msg1' }));
  stream.emit(event('three', 40, 'session.tool.called', { sessionID: 'ses1', assistantMessageID: 'msg1', id: 'call1', executed: false, name: 'shell', input: 'secret' }));
  stream.emit(event('four', 55, 'session.tool.success', { sessionID: 'ses1', assistantMessageID: 'msg1', id: 'call1', executed: false, content: [{ text: 'secret' }] }));
  await tick(); await tick(); await dispose(); await tick();
  assert.equal(io.writes.length, 5);
  assert.deepEqual(io.writes[1], { schemaVersion: 1, eventId: 'two', observedAt: 30, event: 'session.step.streamed', phase: 'model_request', sessionId: 'ses1', messageId: 'msg1', startedAt: 8, endedAt: 30, durationMs: 22 });
  assert.equal(io.writes[4].startBoundary, 'tool_called');
  assert.equal(io.writes[4].durationMs, 15);
  assert.equal(io.writes[2].rateLimited, true);
  assert.equal(io.writes[2].durationMs, undefined);
  assert.equal(JSON.stringify(io.writes).includes('secret'), false);
});

test('deduplicates event IDs across plugin contexts and cleanup stops observation', async () => {
  const stream = source(), first = memoryIO(), second = memoryIO();
  const stopFirst = installExecutionTiming({ event: stream }, { io: first, file: '/shared' });
  const stopSecond = installExecutionTiming({ event: stream }, { io: second, file: '/shared' });
  await tick();
  stream.emit(event('duplicate-start', 1, 'permission.asked', { sessionID: 'ses2', id: 'per1', resources: ['secret'] }));
  assert.equal(stream.delivered, 2, 'the same event reaches both subscribers');
  await tick(); await stopFirst(); await tick();
  stream.emit(event('duplicate-end', 5, 'permission.replied', { sessionID: 'ses2', requestID: 'per1', reply: 'once' }));
  await tick(); await stopSecond(); await tick();
  const writes = [...first.writes, ...second.writes];
  assert.equal(writes.length, 2, 'each broadcast event is retained once per destination');
  assert.equal(writes.find(item => item.eventId === 'duplicate-end').durationMs, 4);
});

test('storage failures and bounded overflow never block event processing', async () => {
  const stream = source(), gate = {}; gate.promise = new Promise(resolve => { gate.resolve = resolve; });
  let appendStarted; const appended = new Promise(resolve => { appendStarted = resolve; });
  const io = memoryIO();
  io.appendFile = async (_, body) => { appendStarted(); await gate.promise; io.writes.push(...body.trim().split('\n').filter(Boolean).map(JSON.parse)); };
  const dispose = installExecutionTiming({ event: stream }, { io, file: '/c', maxQueue: 1 });
  await tick();
  stream.emit(event('overflow-start', 1, 'form.created', { form: { id: 'form1', sessionID: 'ses3', fields: 'secret' } }));
  await appended;
  stream.emit(event('overflow-one', 2, 'form.replied', { id: 'form1', sessionID: 'ses3', answer: 'secret' }));
  stream.emit(event('overflow-two', 3, 'form.created', { form: { id: 'form2', sessionID: 'ses3' } }));
  await tick();
  gate.resolve(); await tick(); await tick(); await dispose(); await tick();
  assert.equal(io.writes.length, 2);
  assert.equal(io.writes.at(-1).droppedTelemetry, 1);
  assert.equal(io.writes.at(-1).telemetryScope, 'service');
  const failed = memoryIO({ fail: true });
  const stream2 = source(); const stop = installExecutionTiming({ event: stream2 }, { io: failed, file: '/d' }); await tick();
  stream2.emit(event('write-failure', 1, 'form.created', { form: { id: 'form3', sessionID: 'ses4' } }));
  await tick(); await stop();
  assert.ok(true);
});


test('provider-hosted tools are excluded and stalled storage cannot block disposal', async () => {
  const stream = source(), io = memoryIO();
  const stop = installExecutionTiming({event:stream}, {io,file:'/provider-hosted'});
  stream.emit(event('hosted-start',1,'session.tool.called',{sessionID:'s',assistantMessageID:'m',id:'t',executed:true}));
  stream.emit(event('hosted-end',8,'session.tool.success',{sessionID:'s',assistantMessageID:'m',id:'t',executed:true}));
  await tick(); stop(); await tick();
  assert.equal(io.writes.length,0);
  const stuck = source();
  const cleanup = installExecutionTiming({event:stuck}, {io:memoryIO({wait:new Promise(()=>{})}),file:'/stalled-storage'});
  stuck.emit(event('stalled-start',1,'session.step.started',{sessionID:'s',assistantMessageID:'m',started:1}));
  await tick();
  assert.equal(cleanup(),undefined,'cleanup is synchronous even with pending storage');
});
