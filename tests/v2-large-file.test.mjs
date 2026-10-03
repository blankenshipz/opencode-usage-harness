import test from 'node:test';
import assert from 'node:assert/strict';
import { createLargeFileContext, shellReads } from '../plugins/v2/large-file-context.mjs';

const page = (content, truncated = false) => ({ output: { type: 'text-page', content, offset: 1, truncated, ...(truncated ? { next: 352 } : {}) }, content: content });
const denied = async (promise, pattern) => assert.match((await promise).content, pattern);
function harness({ lines = 351, subagentOutput = 'fixture.txt:4: concise finding', nativeOutput, nativeReadError, changeDuringDirectRead = false, now = () => Date.now(), agent = 'builder' } = {}) {
  const calls = []; const tools = new Map(); const file = '/tmp/large-file-context-fixture.txt';
  let version = 4;
  const nativeRead = async input => { calls.push({ kind: 'read', input }); if (nativeReadError) throw new Error(nativeReadError); if (changeDuringDirectRead && input.limit > 351) version++; return nativeOutput ? { output: nativeOutput(), content: 'native content', metadata: { retained: true } } : page(Array.from({ length: Math.min(input.limit, lines) }, (_, i) => `SECRET ${i + 1}`).join('\n'), lines > input.limit); };
  const nativeQuestion = async input => { calls.push({ kind: 'question', input }); return { output: { answers: [['Allow once']] }, content: '' }; };
  const nativeSubagent = async input => { calls.push({ kind: 'subagent', input }); return { output: { output: subagentOutput }, content: '' }; };
  const nativeShell = async input => { calls.push({ kind: 'shell', input }); return { output: {}, content: 'ok' }; };
  const editor = { get: id => ({ read: { id: 'read', name: 'read', description: '', execute: nativeRead }, question: { id: 'question', name: 'question', execute: nativeQuestion }, subagent: { id: 'subagent', name: 'subagent', execute: nativeSubagent }, shell: { id: 'shell', name: 'shell', execute: nativeShell } })[id], update: (id, callback) => { const value = editor.get(id); callback(value); tools.set(value.name, value); }, add: tool => tools.set(tool.name, tool) };
  const plugin = createLargeFileContext({ now, fs: { realpath: async p => p, stat: async () => ({ dev: 1, ino: 2, size: 1, mtimeMs: version, ctimeMs: 4 }) } });
  return plugin.setup({ location: { directory: '/workspace' }, tool: { transform: async callback => callback(editor) } }).then(() => ({ tools, calls, file, context: { sessionID: 's', agent } }));
}

test('preflight does not leak bytes and accepts exactly 350 lines', async () => {
  const h = await harness({ lines: 350 }); const result = await h.tools.get('read').execute({ path: h.file }, h.context);
  assert.equal(h.calls.filter(c => c.kind === 'read').length, 2);
  assert.equal(h.calls[0].input.limit, 351); assert.equal(h.calls[1].input.limit, 350);
  assert.match(result.content, /SECRET 1/);
  const check = await h.tools.get('large_file_check').execute({ path: h.file }, h.context);
  assert.doesNotMatch(check.content, /SECRET/);
});

test('351 lines route broad reads but keep bounded ranges usable for scouts', async () => {
  const h = await harness();
  await denied(h.tools.get('read').execute({ path: h.file }, h.context), /Large-file context block/);
  await h.tools.get('read').execute({ path: h.file, offset: 99 }, h.context);
  await h.tools.get('read').execute({ path: h.file, offset: 99, limit: 20 }, { ...h.context, agent: 'scout' });
  assert.deepEqual(h.calls.filter(call => call.kind === 'read').at(-1).input, { path: h.file, offset: 99, limit: 20 });
  await denied(h.tools.get('read').execute({ path: h.file, limit: 0 }, h.context), /limit from 1/);
  await denied(h.tools.get('read').execute({ path: h.file, limit: 351 }, h.context), /limit from 1/);
});

test('direct grant keeps reason, skips questions, expires and is consumed once concurrently', async () => {
  let time = 100; const h = await harness({ now: () => time }); const permit = h.tools.get('large_file_allow_direct');
  await permit.execute({ path: h.file, reason: 'Need complete function context.' }, h.context);
  assert.equal(h.calls.some(call => call.kind === 'question'), false);
  await Promise.all([h.tools.get('read').execute({ path: h.file, limit: 999 }, h.context), denied(h.tools.get('read').execute({ path: h.file, limit: 999 }, h.context), /limit from 1|Large-file/) ]);
  await permit.execute({ path: h.file, reason: 'Need complete function context.' }, h.context); time += 60_001;
  await denied(h.tools.get('read').execute({ path: h.file }, h.context), /Large-file/);
  const scout = await harness({ agent: 'scout' });
  await denied(scout.tools.get('large_file_allow_direct').execute({ path: scout.file, reason: 'Need complete function context.' }, scout.context), /cannot request/);
  const changed = await harness({ changeDuringDirectRead: true });
  await changed.tools.get('large_file_allow_direct').execute({ path: changed.file, reason: 'Need complete function context.' }, changed.context);
  await denied(changed.tools.get('read').execute({ path: changed.file, limit: 999 }, changed.context), /changed during direct read/);
});

test('direct grant cannot bypass denied native preflight', async () => {
  const h = await harness({ nativeReadError: 'permission denied' });
  await denied(h.tools.get('large_file_allow_direct').execute({ path: h.file, reason: 'Need complete function context.' }, h.context), /preflight was denied/);
  assert.equal(h.calls.some(call => call.kind === 'question'), false);
});

test('shell does not bypass denied native preflight', async () => {
  const h = await harness({ nativeReadError: 'permission denied' });
  await assert.rejects(h.tools.get('shell').execute({ command: `cat '${h.file}'` }, h.context), /permission denied/);
  assert.equal(h.calls.some(call => call.kind === 'shell'), false);
});

test('summary delegates through the native executor and caps its result', async () => {
  const h = await harness({ agent: 'coordinator' }); const result = await h.tools.get('large_file_summary').execute({ path: h.file, question: 'Where is the declaration?' }, h.context);
  assert.match(result.content, /fixture.txt:4/);
  const call = h.calls.find(c => c.kind === 'subagent');
  assert.equal(call.input.agent, 'scout'); assert.equal(call.input.background, false); assert.match(call.input.prompt, /limit <= 350/);
  const oversized = await harness({ agent: 'coordinator', subagentOutput: 'x'.repeat(6001) });
  await denied(oversized.tools.get('large_file_summary').execute({ path: oversized.file, question: 'Summarize.' }, oversized.context), /bounded summary/);
});

test('leaf summaries give bounded-read or parent guidance without nested delegation', async () => {
  const h = await harness({ agent: 'scout' });
  const result = await h.tools.get('large_file_summary').execute({ path: h.file, question: 'Where is the declaration?' }, h.context);
  assert.match(result.content, /cannot create a nested scout/);
  assert.match(result.content, /do not retry this tool/);
  assert.match(result.content, /bounded native read/);
  assert.equal(h.calls.some(call => call.kind === 'subagent'), false);
});

test('shell parser catches dump forms without classifying ordinary build commands', () => {
  assert.equal(shellReads('npm test').length, 0);
  assert.ok(shellReads("cat '/tmp/example.txt'").some(read => read.file === '/tmp/example.txt'));
  assert.ok(shellReads("node -e \"require('fs').readFileSync('/tmp/example.txt')\"").some(read => read.file === '/tmp/example.txt'));
  assert.deepEqual(shellReads('cat .pytest_cache/v/cache/lastfailed 2>/dev/null; true').map(read => read.file), ['.pytest_cache/v/cache/lastfailed']);
  assert.equal(shellReads("cat > /tmp/result <<'EOF'\nfixture\nEOF\nnpm test").length, 0);
});

test('shell wrapper blocks broad literal dumps while leaving build commands alone', async () => {
  const h = await harness();
  await denied(h.tools.get('shell').execute({ command: `cat '${h.file}'` }, h.context), /shell bypass blocked/);
  await denied(h.tools.get('shell').execute({ command: 'cat relative.txt', workdir: 'other' }, h.context), /shell bypass blocked/);
  assert.equal(h.calls.filter(call => call.kind === 'read').at(-1).input.path, '/workspace/other/relative.txt');
  await denied(h.tools.get('shell').execute({ command: 'cd other && cat relative.txt' }, h.context), /literal path without directory changes/);
  await denied(h.tools.get('shell').execute({ command: 'curl -o /tmp/new https://example.invalid/x && cat /tmp/new' }, h.context), /Run the write command separately/);
  await h.tools.get('shell').execute({ command: 'npm test' }, h.context);
  assert.ok(h.calls.some(call => call.kind === 'shell' && call.input.command === 'npm test'));
});

test('native read results become plain JSON while preserving content and metadata', async () => {
  class NativeTextPage { constructor() { this.type = 'text-page'; this.mime = 'text/plain'; this.content = 'one'; this.offset = 1; this.truncated = false; } }
  const h = await harness({ lines: 1, nativeOutput: () => new NativeTextPage() });
  const result = await h.tools.get('read').execute({ path: h.file, limit: 1 }, h.context);
  assert.deepEqual(result.output, { type: 'text-page', mime: 'text/plain', content: 'one', offset: 1, truncated: false });
  assert.equal(Object.getPrototypeOf(result.output), Object.prototype);
  assert.equal(result.content, 'native content');
  assert.deepEqual(result.metadata, { retained: true });
});
