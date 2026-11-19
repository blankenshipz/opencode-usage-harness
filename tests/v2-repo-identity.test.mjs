import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoIdentity, installRepoIdentity } from '../plugins/v2/repo-identity.mjs';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

test('repo_identity reports toplevel, branch, HEAD and dirty summary without writing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-identity-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'b\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    // A repository-configured fsmonitor command must not run.
    git(dir, 'config', 'core.fsmonitor', `touch ${path.join(dir, 'PWNED')}`);
    const identity = await repoIdentity(path.join(dir, 'sub'));
    assert.equal(identity.git, true);
    assert.equal(fs.realpathSync(identity.toplevel), fs.realpathSync(dir));
    assert.equal(identity.branch, 'main');
    assert.equal(identity.head, git(dir, 'rev-parse', 'HEAD'));
    assert.equal(identity.dirty, true);
    assert.equal(identity.modified, 1);
    assert.equal(identity.untracked, 1);
    assert.equal(fs.existsSync(path.join(dir, 'PWNED')), false);
    assert.equal(fs.existsSync(path.join(dir, '.git', 'index.lock')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('repo_identity outside git and tool registration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-identity-none-'));
  try {
    assert.deepEqual(await repoIdentity(dir, { run: (_cmd, _args, _opts, cb) => cb(new Error('not a repo')) }), { cwd: dir, git: false });
    let tool;
    await installRepoIdentity({ location: { directory: dir }, tool: { transform: async fn => fn({ add: entry => { tool = entry; } }) } },
      { run: (_cmd, _args, _opts, cb) => cb(new Error('not a repo')) });
    assert.equal(tool.name, 'repo_identity');
    assert.deepEqual(tool.input.properties, {});
    assert.deepEqual(JSON.parse((await tool.execute({}, {})).content), { cwd: dir, git: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
