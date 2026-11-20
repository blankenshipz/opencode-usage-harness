import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOutputStore, installContextCompression, PROTECTED_TOOLS, compressionKind } from '../plugins/v2/context-compression.mjs';
import { compactToolText } from '../plugins/v2/result-compactor.mjs';

// Live 2026-11-19 telemetry: 0 of 1,252 candidates compressed (57% protected
// tools, 37% below the 4 KiB floor). These are anonymised real native results.
const { samples } = JSON.parse(await fs.readFile(new URL('./fixtures/compression-live-samples.json', import.meta.url), 'utf8'));
const base = { sessionID: 'session', messageID: 'message', input: {} };

async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-live-samples-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const hooks = {}, events = [];
  await installContextCompression({ tool: { hook: async (name, fn) => { hooks[name] = fn; } } },
    { save: createOutputStore(directory), diagnostics: { record: event => events.push(event) } });
  const run = async event => { await hooks['execute.before'](event); await hooks['execute.after'](event); return events.at(-1); };
  return { directory, run };
}
async function retrieve(text) {
  const chunks = /Original: native read (\S+\/chunks\.jsonl) offset=1 limit=3;/.exec(text)[1];
  return (await fs.readFile(chunks, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).join('');
}

test('live native grep/glob samples now compress and stay recoverable', async t => {
  const { run } = await harness(t);
  for (const [index, sample] of samples.entries()) {
    const event = { ...base, id: `live-${index}`, tool: sample.tool, status: 'completed', result: { content: sample.text } };
    const observed = await run(event);
    assert.equal(observed.reason, 'prepared', `${sample.tool} ${sample.original_chars}`);
    assert.ok(event.result.content.length < sample.text.length * 0.85);
    assert.match(event.result.content, /\[harness compacted /);
    assert.equal(await retrieve(event.result.content), sample.text);
  }
});

test('OpenCode 2.0.30 grep layout (blank line after every match) is parsed', () => {
  const grep = samples.find(sample => sample.tool === 'grep' && sample.text.length < 16 * 1024);
  assert.match(grep.text, /\n  Line \d+: [^\n]*\n\n  Line /);
  const compacted = compactToolText(grep.text, 'grep');
  assert.equal(compacted.strategy, 'search-preview');
  assert.match(compacted.text, /^\[harness search-preview; native grep reported \d+ matches/);
});

test('grep-lines is a lossless layout projection', () => {
  const matches = Array.from({ length: 160 }, (_, i) => `  Line ${i + 10}: const value${i} = compute(${i});\n`);
  const native = `Found 160 matches\n/repo/src/example/module.mjs:\n${matches.join('\n')}`;
  const compacted = compactToolText(native, 'grep');
  assert.equal(compacted.strategy, 'grep-lines');
  const [, heading, file, ...lines] = compacted.text.split('\n');
  assert.equal(heading, 'Found 160 matches');
  assert.equal(file, '/repo/src/example/module.mjs:');
  assert.deepEqual(lines.map(line => `  Line ${line}\n`), matches);
});

test('lossless projections start at 2 KiB; lossy ones keep the 4 KiB floor', () => {
  const pretty = JSON.stringify(Array.from({ length: 36 }, (_, i) => ({ identifier: i, label: 'ready' })), null, 4);
  assert.ok(pretty.length > 2048 && pretty.length < 4096);
  assert.ok(['json-whitespace', 'json-table'].includes(compactToolText(pretty, 'json').strategy));
  const rows = Array.from({ length: 30 }, (_, i) => `{"id":"dispatch_${i}","status":"completed","note":"${'n'.repeat(40)}"}`);
  const status = `{"state":"ok","dispatches":[${rows.join(',')}]}`;
  assert.ok(status.length > 2048 && status.length < 4096);
  assert.equal(compactToolText(status, 'json'), undefined);
});

test('protected list is narrowed; edit/write confirmations are no longer protected', async t => {
  for (const tool of ['edit', 'write', 'patch']) assert.equal(PROTECTED_TOOLS.has(tool), false);
  for (const tool of ['read', 'task_dispatch_status', 'task_dispatch_collect', 'task_outcome', 'task_intent', 'check_status', 'check_prepare']) assert.ok(PROTECTED_TOOLS.has(tool), tool);
  for (const tool of ['harness_health', 'subscription_quota', 'repo_identity']) assert.equal(compressionKind({ tool }), 'json');
  const { run } = await harness(t);
  const pretty = JSON.stringify({ status: 'ok', checks: Array.from({ length: 60 }, (_, i) => ({ name: `check-${i}`, status: 'pass' })) }, null, 2);
  const health = { ...base, id: 'health', tool: 'harness_health', status: 'completed', result: { content: pretty } };
  assert.equal((await run(health)).reason, 'prepared');
  assert.equal(await retrieve(health.result.content), pretty);
});

test('CodeMode calls into protected tools only get value-preserving projections', async t => {
  const { run } = await harness(t);
  const rows = Array.from({ length: 40 }, (_, i) => `{"workKey":"lane-${i}","status":"${i === 7 ? 'failed' : 'completed'}","detail":"${'d'.repeat(120)}"}`);
  const status = `{"state":"ok","owners":[${rows.join(',')}]}`;
  assert.equal(compactToolText(status, 'json').strategy, 'status-json');
  const call = { ...base, id: 'status', tool: 'execute', input: { code: 'return await tools.task_dispatch_status({taskId:"t", summary:true});' }, status: 'completed', result: { content: status } };
  assert.equal((await run(call)).reason, 'no_useful_projection');
  assert.equal(call.result.content, status);
  const compact = JSON.stringify({ state: 'ok', owners: rows.map(row => ({ ...JSON.parse(row), detail: 'short' })) });
  const pretty = JSON.stringify(JSON.parse(compact), null, 6);
  const prettyCall = { ...call, id: 'status-pretty', result: { content: pretty } };
  const observed = await run(prettyCall);
  assert.deepEqual([observed.reason, observed.strategy], ['prepared', 'json-whitespace']);
  assert.ok(prettyCall.result.content.startsWith(compact + '\n[harness compacted json-whitespace;'));
});
