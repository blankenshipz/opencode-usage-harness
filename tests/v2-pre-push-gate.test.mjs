import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordReviewVerdict } from '../plugins/v2/review-verdicts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installer = path.join(root, 'scripts', 'install-git-hooks.sh');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prepush-'));
  const remote = path.join(base, 'remote.git'), work = path.join(base, 'work'), state = path.join(base, 'state');
  git(base, 'init', '-q', '--bare', remote);
  git(base, 'init', '-q', '-b', 'main', work);
  git(work, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'init');
  return { base, remote, work, state };
}
const push = (work, state, ref = 'main') => spawnSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/${ref}`], { cwd: work, env: { ...env, HARNESS_STATE_DIR: state }, encoding: 'utf8' });

test('pre-push gate: refuses main without verdict, allows with verdict, Unreviewed, or other branches', async () => {
  const { work, state } = setup();
  fs.writeFileSync(path.join(work, 'dirty'), 'x');
  assert.notEqual(spawnSync('bash', [installer, work], { encoding: 'utf8' }).status, 0, 'dirty tree refused');
  fs.rmSync(path.join(work, 'dirty'));
  assert.equal(spawnSync('bash', [installer, work], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('bash', [installer, work], { encoding: 'utf8' }).status, 0, 'idempotent');

  let r = push(work, state);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /REFUSED/);
  assert.equal(push(work, state, 'feature').status, 0);

  fs.mkdirSync(state, { recursive: true });
  const tree = git(work, 'rev-parse', 'HEAD^{tree}');
  fs.writeFileSync(path.join(state, 'review-verdicts.jsonl'), JSON.stringify({ tree, verdict: 'fail' }) + '\n');
  assert.notEqual(push(work, state).status, 0, 'failing verdict refused');
  await assert.rejects(recordReviewVerdict({ agent: 'builder', verdict: 'pass', reviewedHead: git(work, 'rev-parse', 'HEAD'), sessionId: 's', directory: work, file: path.join(state, 'review-verdicts.jsonl') }));
  await assert.rejects(recordReviewVerdict({ agent: 'reviewer', verdict: 'pass', reviewedHead: '0000000', sessionId: 's', directory: work, file: path.join(state, 'review-verdicts.jsonl') }));
  const line = await recordReviewVerdict({ agent: 'reviewer', verdict: 'pass', reviewedHead: git(work, 'rev-parse', 'HEAD'), sessionId: 's', directory: work, file: path.join(state, 'review-verdicts.jsonl') });
  assert.equal(line.tree, tree);
  assert.equal(push(work, state).status, 0);

  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'change');
  assert.notEqual(push(work, state).status, 0, 'new tree needs a new verdict');
  git(work, 'commit', '-q', '--amend', '-m', 'change\n\nUnreviewed: hotfix');
  assert.equal(push(work, state).status, 0);
});

test('installer refuses to overwrite a different existing hook', () => {
  const { work } = setup();
  const hook = path.join(work, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
  const r = spawnSync('bash', [installer, work], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('a dirty working tree verdict matches the tree of a later commit of exactly those files', async () => {
  const { work, state } = setup();
  fs.writeFileSync(path.join(work, 'new.txt'), 'n\n');
  const line = await recordReviewVerdict({ agent: 'verifier', verdict: 'pass', reviewedHead: git(work, 'rev-parse', 'HEAD'), sessionId: 's', directory: work, file: path.join(state, 'v.jsonl') });
  assert.equal(git(work, 'status', '--porcelain').includes('new.txt'), true, 'index untouched');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'squash');
  assert.equal(git(work, 'rev-parse', 'HEAD^{tree}'), line.tree);
});
