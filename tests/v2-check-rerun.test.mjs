import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { rerunChecks, scrubEnv } from '../plugins/v2/check-rerun.mjs';
import { sessionEndOutcome, verifySessionEnd } from '../plugins/v2/session-end-receipts.mjs';
import { setIntent } from '../plugins/v2/task-intent.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'check-rerun-'));

test('reruns allowlisted argv checks for real and reports exit codes', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'ok.js'), 'process.exit(0)'); await fs.writeFile(path.join(dir, 'bad.js'), 'process.exit(3)'); await fs.writeFile(path.join(dir, 'slow.js'), 'setTimeout(()=>{},5000)');
  const ok = await rerunChecks({ directory: dir, checks: [{ id: 'a', argv: ['node', 'ok.js'] }] });
  assert.equal(ok.checksVerified, true);
  assert.equal(ok.checks[0].exitCode, 0);
  const bad = await rerunChecks({ directory: dir, checks: [{ id: 'a', argv: ['node', 'ok.js'] }, { id: 'b', argv: ['node', 'bad.js'] }] });
  assert.equal(bad.checksVerified, false);
  assert.deepEqual(bad.checks.map(c => c.exitCode), [0, 3]);
  const slow = await rerunChecks({ directory: dir, timeoutMs: 200, checks: [{ id: 's', argv: ['node', 'slow.js'] }] });
  assert.equal(slow.checks[0].timedOut, true);
  assert.equal(slow.checksVerified, false);
});

test('skips non-allowlisted runners, escaping cwd and bash outside the repo; skipped blocks verification', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'check.sh'), 'exit 0\n');
  const calls = [];
  const run = async (file, args, options) => { calls.push({ file, args, options }); return { exitCode: 0, timedOut: false }; };
  const r = await rerunChecks({ directory: dir, run, checks: [
    { id: 'curl', argv: ['curl', 'x'] }, { id: 'abs', argv: ['/usr/bin/node', '-v'] }, { id: 'up', argv: ['node', '-v'], cwd: '../' },
    { id: 'bashc', argv: ['bash', '-c', 'true'] }, { id: 'bashout', argv: ['bash', '/etc/profile'] }, { id: 'bashok', argv: ['bash', 'check.sh'] }, { id: 'noargv' },
  ] });
  assert.deepEqual(r.skipped, ['curl', 'abs', 'up', 'bashc', 'bashout', 'noargv']);
  assert.deepEqual(calls.map(c => c.file), ['bash']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  assert.equal(r.checksVerified, false);
  const none = await rerunChecks({ directory: dir, run, checks: [{ id: 'noargv' }] });
  assert.equal(none.checksVerified, false);
});

test('scrubEnv removes Anthropic and token variables', () => {
  const env = scrubEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x', GITHUB_TOKEN: 'y', MY_SECRET: 'z', HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
});

test('intent checks accept argv/cwd and reject bad ones', () => {
  const base = { outcome: 'o', target: 't', nonGoals: [], authorizedEffects: [], assumptions: [], sourceMessageIDs: ['msg_1'] };
  const state = {};
  const entry = setIntent(state, { rootID: 'r', taskId: 't', expectedRevision: 0, actorSessionID: 's', intent: { ...base, checks: [{ id: 'c', description: 'd', mode: 'local', argv: ['npm', 'test'], cwd: 'pkg' }] } });
  assert.deepEqual(entry.intent.checks[0].argv, ['npm', 'test']);
  for (const bad of [{ argv: [] }, { argv: ['a\0b'] }, { argv: Array(65).fill('x') }, { cwd: '../x' }, { cwd: '/abs' }]) {
    assert.throws(() => setIntent({}, { rootID: 'r', taskId: 't', expectedRevision: 0, actorSessionID: 's', intent: { ...base, checks: [{ id: 'c', description: 'd', mode: 'local', argv: ['npm'], ...bad }] } }));
  }
});

test('sessionEndOutcome sets checksVerified only for succeeded sessions with verification', async () => {
  const record = { childID: 'c', parentID: 'p', taskId: 't', workKey: 'w', agent: 'a' };
  const receipt = { writtenAt: 0, generation: 1, outcome: 'succeeded' };
  const vdir = await tmp(); await fs.writeFile(path.join(vdir, 'ok.js'), '');
  const verification = await verifySessionEnd({ record, directory: vdir, intent: { checks: [{ id: 'a', argv: ['node', 'ok.js'] }] } });
  assert.equal(sessionEndOutcome({ record, receipt, verification }).checksVerified, true);
  assert.equal(sessionEndOutcome({ record, receipt, verification }).checks[0].id, 'a');
  assert.equal(sessionEndOutcome({ record, receipt }).checksVerified, false);
  assert.equal(sessionEndOutcome({ record, receipt: { ...receipt, outcome: 'failed' }, verification }).checksVerified, false);
  assert.equal(await verifySessionEnd({ record, directory: '/tmp', intent: { checks: [{ id: 'x' }] } }), undefined);
});

test('r26: inline code and package fetchers are never rerun', async () => {
  const { rerunChecks } = await import('../plugins/v2/check-rerun.mjs');
  const ran = [];
  const run = async (file, args) => { ran.push([file, ...args]); return { exitCode: 0, timedOut: false }; };
  const dir = process.cwd();
  for (const argv of [['node', '-e', 'x'], ['python3', '-c', 'x'], ['npx', 'jest'], ['python3', '-m', 'http.server'], ['node', '--eval=x'], ['bash', '-c', 'x'], ['npm', 'exec', 'x'], ['deno', 'eval', 'x']]) {
    const r = await rerunChecks({ checks: [{ id: 'c', argv }], directory: dir, run });
    assert.equal(r.checksVerified, false, argv.join(' ')); assert.deepEqual(r.skipped, ['c']);
  }
  assert.equal(ran.length, 0);
  const ok = await rerunChecks({ checks: [{ id: 't', argv: ['python3', '-m', 'pytest', '-q'] }, { id: 'n', argv: ['npm', 'test'] }], directory: dir, run });
  assert.equal(ok.checksVerified, true);
});

test('r26 fable: scratch, absolute and indirect scripts are never rerun', async () => {
  const { rerunChecks } = await import('../plugins/v2/check-rerun.mjs');
  const dir = await fs.realpath(await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'cr-')));
  await fs.mkdir(path.join(dir, '.review')); await fs.writeFile(path.join(dir, '.review', 'x.js'), ''); await fs.writeFile(path.join(dir, 'ok.js'), '');
  const ran = []; const run = async (f, a) => { ran.push([f, ...a]); return { exitCode: 0, timedOut: false }; };
  for (const argv of [['node', '.review/x.js'], ['node', path.join(dir, 'ok.js')], ['deno', 'run', 'ok.js'], ['make', '-f', '.review/x.js'], ['bun', '.review/x.js'], ['bash', '.review/x.js'], ['python3', '/etc/x.py']]) {
    const r = await rerunChecks({ checks: [{ id: 'c', argv }], directory: dir, run });
    assert.equal(r.checksVerified, false, argv.join(' '));
  }
  assert.equal(ran.length, 0);
  assert.equal((await rerunChecks({ checks: [{ id: 'c', argv: ['node', 'ok.js'] }], directory: dir, run })).checksVerified, true);
});
