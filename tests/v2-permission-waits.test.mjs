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

test('0.4.0: no_push_deploy is a no-op; pushes and deploys are allowed', () => {
  for (const command of ['git push', 'git push origin feature', 'git -C . push -u origin x', 'gh pr create --fill', 'railway up', 'vercel --prod', 'eas submit -p ios', 'docker push img', 'npm publish', 'rsync -a dist/ host:/srv/app', 'fly deploy'])
    assert.deepEqual(check(command, P, noDeploy), [], command);
  for (const command of ['git commit -m x', 'git fetch', 'gh pr view 1', 'railway logs', 'docker build .', 'npm test'])
    assert.deepEqual(check(command, P, noDeploy), [], command);
  assert.deepEqual(check('git push origin feature'), []);
  assert.equal(pushDeployDanger(['git', 'status']), undefined);
});

test('background detection ignores && and 2>&1', () => {
  for (const text of ['a && b', 'cmd 2>&1 | tee .review/x', 'cmd &> log', 'x >&2']) assert.equal(startsBackground(text), false, text);
  for (const text of ['npm run dev &', 'nohup x', 'a & b', 'echo $!', '(server &) && curl x']) assert.equal(startsBackground(text), true, text);
});

test('full-auto external_directory: never asks; credentials and outside edits deny', () => {
  const decide = (tool, resources, input = {}, extra = {}) => decideAutoPermission({ action: 'external_directory', resources, tool, input, directory: P, home: '/home/nobody', fullAutoProject: project, ...extra }).decision;
  assert.equal(decide('glob', ['/usr/local/*'], { pattern: '**/initdb', path: '/usr/local' }), 'allow');
  assert.equal(decide('read', ['/var/lib/x/shell/*']), 'allow');
  assert.equal(decide('read', ['/home/nobody/.ssh/*']), 'deny');
  assert.equal(decide('read', ['/srv/app/.env']), 'deny');
  assert.equal(decide('edit', ['/etc/x/*']), 'deny');
  // 0.4.0 (r40b, Fable M4): full-auto never asks. Reading another project is allowed.
  assert.equal(decide('read', [`${OTHER}/src/*`]), 'allow');
  // Shell: allowed when the full-auto check is clean (cd ../web from a nested dir) and names no other project.
  assert.equal(decide('shell', [`${root}/web/*`], { command: 'cd backend && npx tsc --noEmit; cd ../web && npx tsc --noEmit 2>&1 | tail -3' }), 'allow');
  assert.equal(decide('shell', ['/opt/x/*'], { command: 'sudo ls /opt/x' }), 'allow');
  assert.equal(decide('shell', [`${OTHER}/*`], { command: `cat ${OTHER}/notes.md` }), 'allow');
});

// 0.4.0: cd T; cmd keeps T exact; only hard-deny classes stop commands.
import { fullAutoShellCheck as fasc040, hardDenyReasons as hdr040, toolOutputFileRead as tofr040 } from '../plugins/v2/full-auto.mjs';
import { test as test040 } from 'node:test';
import assert040 from 'node:assert/strict';
import fs040 from 'node:fs'; import os040 from 'node:os'; import path040 from 'node:path';
test040('0.4.0: cd sub; cmd > ../x resolves inside the project; hard denies classified', () => {
  const root = fs040.mkdtempSync(path040.join(os040.tmpdir(), 'r40-')).replace(/^\/tmp/, '/tmp');
  const proj = path040.join(root, 'proj'); fs040.mkdirSync(path040.join(proj, 'mobile'), { recursive: true });
  const project = { directory: proj, roots: [proj] };
  for (const c of ['cd mobile; npx tsc > ../.review/receipts/s6/tsc.txt', 'cd mobile\nnpx tsc > ../.review/receipts/s6/tsc.txt'])
    assert040.deepEqual(hdr040(fasc040(c, proj, project)), []);
  for (const [c, rule] of [['git push --force origin main', 'history'], ['git rebase -i HEAD~3', 'history'], ['git reset --hard origin/main', 'history'], ['rm -rf /etc/x', 'delete'], ['cat .env', 'secret'], ['cat /home/box/work/ocharness/state/x', 'secret']])
    assert040.equal(hdr040(fasc040(c, proj, project))[0]?.rule, rule, c);
  for (const c of ['git push origin main', 'railway up', 'git reset --hard HEAD', 'git commit -qm x'])
    assert040.deepEqual(hdr040(fasc040(c, proj, project)), [], c);
  assert040.equal(tofr040('read', '/home/box/work/ocharness/xdg/data/opencode/tool-output/tool_abc123'), true);
  assert040.equal(tofr040('glob', '/home/box/work/ocharness/xdg/data/opencode/tool-output/tool_abc123'), false);
  assert040.equal(tofr040('read', '/home/box/work/ocharness/xdg/data/opencode/tool-output'), false);
});
