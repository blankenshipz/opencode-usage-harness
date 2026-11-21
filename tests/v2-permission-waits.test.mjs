// 0.3.3: permission waits (r35). Logged asks that are safe now auto-allow; MUST-ASK forms still ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fullAutoShellCheck, literalVariables, expandVariables, serviceDanger, pushDeployDanger } from '../plugins/v2/full-auto.mjs';
import { scanShell, isSecretPath } from '../plugins/v2/shell-guard.mjs';
import { startsBackground, decideAutoPermission } from '../plugins/v2/auto-permission.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r35-'));
const P = path.join(root, 'proj'), OTHER = path.join(root, 'other');
for (const dir of [P, path.join(P, 'backend'), path.join(P, '.review'), path.join(OTHER, '.git')]) fs.mkdirSync(dir, { recursive: true });
const project = { directory: P, roots: [P] };
const noDeploy = { ...project, noPushDeploy: true };
const check = (command, cwd = P, p = project) => fullAutoShellCheck(command, cwd, p, { home: '/home/nobody' });

test('literal variables, for-loop values and && cd chains resolve redirect targets', () => {
  const vars = literalVariables(scanShell('B=/x/y; for i in 1 2; do echo; done').segments);
  assert.deepEqual(expandVariables('$B/z-$i', vars), ['/x/y/z-1', '/x/y/z-2']);
  assert.equal(expandVariables('$UNKNOWN/z', vars), undefined);
  for (const command of [
    `D=${P}/.review/run; mkdir -p $D; git log > $D/log.txt; echo $? > $D/exit`,
    'mkdir -p .review/a && cd backend && (ruff check . > ../.review/a/ruff.txt; echo $? > ../.review/a/exit)',
    'TS=$(date +%s); git rev-parse HEAD > .review/verify-$TS/revision.txt',
    'for i in 1 2; do pytest > .review/pytest$i.txt; done',
    'mkdir -p /tmp/opencode/x && cd /tmp/opencode/x && (sleep 1 & echo $! > tun.pid)',
    `git diff | grep -c sk- > ${P}/.review/secret-scan.txt; wc -l < ${P}/.review/secret-scan.txt`,
  ]) assert.deepEqual(check(command), [], command);
});

test('unsafe variable and cd forms still ask', () => {
  for (const command of ['echo x > $OUT', 'cd backend; (echo x > ../../../../etc/escape.txt)', 'cd backend || echo x > ../../../../etc/e', 'B=/tmp/opencode/base; rm -rf $B', 'rm -rf $X/y', 'echo > ../$V/x',
    'cd /tmp && rm -rf data', 'cat .review/secret-scan.txt > ~/.ssh/config'])
    assert.notDeepEqual(check(command), [], command);
});

test('secret-scan report names are not secrets; real secret files still are', () => {
  for (const name of ['secret-scan.txt', '.review/x/secret-hits-lines.txt', 'secrets_scan-a.out']) assert.equal(isSecretPath(name), false, name);
  for (const name of ['client_secret.json', 'secrets.txt', 'secrets/secret-scan.txt', '.env', 'id_rsa']) assert.equal(isSecretPath(name), true, name);
});

test('sudo and system service changes ask under full-auto, reads do not', () => {
  for (const command of ['sudo apt-get install x', 'sudo -u deploy ls', 'systemctl restart nginx', 'systemctl --user stop x', "ssh host 'sudo systemctl daemon-reload'", 'service nginx reload', 'doas ls'])
    assert.notDeepEqual(check(command), [], command);
  for (const command of ['systemctl status nginx', 'systemctl is-active x', "ssh host 'systemctl cat x'", 'service nginx status', 'journalctl -u x -n 50', 'echo sudo'])
    assert.deepEqual(check(command), [], command);
  assert.equal(serviceDanger(['git', 'log']), undefined);
});

test('no_push_deploy projects ask for pushes and deploys; others do not', () => {
  for (const command of ['git push', 'git push origin feature', 'git -C . push -u origin x', 'gh pr create --fill', 'railway up', 'vercel --prod', 'eas submit -p ios', 'docker push img', 'npm publish', 'rsync -a dist/ host:/srv/app', 'fly deploy'])
    assert.notDeepEqual(check(command, P, noDeploy), [], command);
  for (const command of ['git commit -m x', 'git fetch', 'gh pr view 1', 'railway logs', 'docker build .', 'npm test'])
    assert.deepEqual(check(command, P, noDeploy), [], command);
  assert.deepEqual(check('git push origin feature'), []);
  assert.equal(pushDeployDanger(['git', 'status']), undefined);
});

test('background detection ignores && and 2>&1', () => {
  for (const text of ['a && b', 'cmd 2>&1 | tee .review/x', 'cmd &> log', 'x >&2']) assert.equal(startsBackground(text), false, text);
  for (const text of ['npm run dev &', 'nohup x', 'a & b', 'echo $!', '(server &) && curl x']) assert.equal(startsBackground(text), true, text);
});

test('full-auto external_directory: read-only tools anywhere but credentials and dirty other projects', () => {
  const decide = (tool, resources, input = {}, extra = {}) => decideAutoPermission({ action: 'external_directory', resources, tool, input, directory: P, home: '/home/nobody', fullAutoProject: project, ...extra }).decision;
  assert.equal(decide('glob', ['/usr/local/*'], { pattern: '**/initdb', path: '/usr/local' }), 'allow');
  assert.equal(decide('read', ['/var/lib/x/shell/*']), 'allow');
  assert.equal(decide('read', ['/home/nobody/.ssh/*']), 'ask');
  assert.equal(decide('read', ['/srv/app/.env']), 'ask');
  assert.equal(decide('edit', ['/etc/x/*']), 'ask');
  // Another project: a dirty/untracked path asks (the temp repo has no commits, so nothing is clean).
  assert.equal(decide('read', [`${OTHER}/src/*`]), 'ask');
  assert.equal(decideAutoPermission({ action: 'external_directory', resources: [`${OTHER}/a/*`], tool: 'read', directory: P, fullAutoProject: project, home: '/home/nobody' }).reason, 'other_project_uncommitted');
  // Shell: allowed when the full-auto check is clean (cd ../web from a nested dir) and names no other project.
  assert.equal(decide('shell', [`${root}/web/*`], { command: 'cd backend && npx tsc --noEmit; cd ../web && npx tsc --noEmit 2>&1 | tail -3' }), 'allow');
  assert.equal(decide('shell', ['/opt/x/*'], { command: 'sudo ls /opt/x' }), 'ask');
  assert.equal(decide('shell', [`${OTHER}/*`], { command: `cat ${OTHER}/notes.md` }), 'ask');
});
