// 0.3.4 (r36/r37): protected locations ask for read tools and read-only shell under full-auto;
// source/test files named like secrets are code, not secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { explicitShellEffect, installShellGuard, isSecretPath, scanShell, CODE_EXTENSIONS } from '../plugins/v2/shell-guard.mjs';
import { fullAutoShellCheck, loadFullAutoProjects, protectedLocation, protectedRoots, PROTECTED_DIRS } from '../plugins/v2/full-auto.mjs';
import { decideFullAutoExternal, decideAutoPermission } from '../plugins/v2/auto-permission.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES = JSON.parse(execFileSync('python3', ['-c',
  'import json,configure;print(json.dumps(configure.shell_rules("permissive"))); assert list(configure.CODE_EXTENSIONS) == json.loads(input())'],
  { cwd: root, encoding: 'utf8', input: JSON.stringify(CODE_EXTENSIONS) }));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r37-')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const P = path.join(tmp, 'yrd'), PLAIN = path.join(tmp, 'plain');
const SOURCES = ['mobile/src/__tests__/screens/AgentSearchCredentials.test.tsx', 'mobile/src/__tests__/screens/AgentSearchScreen.test.tsx',
  'mobile/src/screens/AgentSearchScreen.tsx', 'mobile/src/services/agentSearch.ts', 'mobile/src/__tests__/services/agentSearchVault.test.ts',
  'backend/app/agent_search/credentials.py'];
for (const repo of [P, PLAIN]) {
  for (const file of SOURCES) { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), 'x\n'); }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'checkout', '-q', '-b', 'agent-search');
}
// A Chrome user-data dir (has `Local State`) under a neutral name, and a receipts dir.
const UD = path.join(tmp, 'neutral-name');
fs.mkdirSync(path.join(UD, 'Default'), { recursive: true });
fs.writeFileSync(path.join(UD, 'Local State'), '{}');
const choices = path.join(tmp, 'configure-choices.json');
fs.writeFileSync(choices, JSON.stringify({ shell_policy: 'permissive', full_auto_projects: [{ directory: P, data_dirs: [], no_push_deploy: true }] }));
const PROJECTS = () => loadFullAutoProjects({ choicesPath: choices });
const project = PROJECTS()[0];
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const OCH = '/home/box/work/ocharness';
const RECEIPTS = `${OCH}/state/check-receipts`;
const ext = (tool, resource, input = {}) => decideFullAutoExternal({ action: 'external_directory', resources: [resource], tool, input, project, directory: P });

// One shell call through the guard (execute.before), then the native ask over the parsed commands
// with the live permissive rules and the guard's evaluate hook. 'ask' covers both asks.
async function decide(command, base = P) {
  const hooks = {}, evaluateHooks = [];
  let guardAsked = false;
  const ctx = {
    location: { directory: base },
    tool: { hook: async (name, callback) => { hooks[name] = callback; } },
    agent: { list: async () => ({ data: [{ id: 'harness-builder', permissions: RULES }] }) },
    permission: {
      hook: async (name, callback) => { evaluateHooks.push(callback); },
      assert: async input => {
        const event = { ...input, effect: 'allow' };
        for (const hook of evaluateHooks) await hook(event);
        if (event.effect === 'ask') guardAsked = true;
      },
    },
  };
  await installShellGuard(ctx, { fullAutoProjects: PROJECTS });
  const call = { tool: 'shell', sessionID: 'ses_r37', agent: 'harness-builder', messageID: 'msg_r37', id: `call_${Math.random()}` };
  try { await hooks['execute.before']({ ...call, input: { command } }); } catch (error) { return /HARD DENY \(harness auto-approve policy; rule: [^)]*secret/.test(error.message) && /resumable blocker/.test(error.message) ? 'deny' : `throw: ${error.message}`; }
  if (guardAsked) return 'guard-ask';
  const resources = scanShell(command).segments.filter(segment => segment.hasCommand && segment.words[0] !== 'cd').map(segment => segment.text);
  if (!resources.length) return 'allow';
  const effect = resources.some(resource => explicitShellEffect(resource, RULES)?.effect !== 'allow') ? 'ask' : 'allow';
  const event = { action: 'shell', sessionID: call.sessionID, agent: call.agent, resources, source: { type: 'tool', messageID: call.messageID, id: call.id }, effect };
  for (const hook of evaluateHooks) await hook(event);
  return event.effect === 'ask' ? 'native-ask' : event.effect;
}

// The 4 post-0.3.3 asks (r36 section 1): 2 commands, each asked by the guard and again natively.
const R36_ASKS = [
  `cd ${RECEIPTS}/mobile-jest-8k3dussh && grep -hE "^(FAIL|Tests:|Test Suites:)" stdout.log stderr.log | sort -u; cd ${P} && git add mobile/src/services/agentSearch.ts mobile/src/screens/AgentSearchScreen.tsx mobile/src/__tests__/services/agentSearchVault.test.ts mobile/src/__tests__/screens/AgentSearchCredentials.test.tsx && git commit -q -m "mobile: send site with agent-run otp input" && git log --oneline -1`,
  `cd ${P} && git add mobile/src/__tests__/screens/AgentSearchScreen.test.tsx mobile/src/screens/AgentSearchScreen.tsx mobile/src/services/agentSearch.ts mobile/src/__tests__/screens/AgentSearchCredentials.test.tsx mobile/src/__tests__/services/agentSearchVault.test.ts && git commit -q -m "mobile: Agent Search credential/2FA prompts and Connected sites" && git log --oneline -1`,
];

test('r36 asks replay: git add/commit of source files named *Credentials* auto-allow with no second ask', async () => {
  for (const command of R36_ASKS) {
    assert.deepEqual(fullAutoShellCheck(command, P, project), [], command.slice(0, 80));
    assert.equal(await decide(command), 'allow', command.slice(0, 80));
    // The shell's external_directory ask (check-receipts cwd) is allowed too.
    assert.equal(ext('bash', `${RECEIPTS}/mobile-jest-8k3dussh/*`, { command }).decision, 'allow');
  }
  for (const command of ['git add backend/app/agent_search/credentials.py && git commit -q -m x', 'cat backend/app/agent_search/credentials.py | head -20', 'git add mobile/src/__tests__/screens/AgentSearchCredentials.test.tsx'])
    assert.equal(await decide(command), 'allow', command);
});

test('outside full-auto, the same commits on a feature branch get no native second ask', async () => {
  for (const command of [`git add mobile/src/__tests__/screens/AgentSearchCredentials.test.tsx backend/app/agent_search/credentials.py && git commit -q -m x`, 'cat backend/app/agent_search/credentials.py'])
    assert.equal(await decide(command, PLAIN), 'allow', command);
  // Real secrets still ask there, including next to a code file that matches the native allow.
  for (const command of ['cat credentials.json', 'cat credentials.json x.py', 'cat .env app.py', 'cat secrets.yaml', 'git add config/client_secret.json'])
    assert.notEqual(await decide(command, PLAIN), 'allow', command);
});

test('code-extension exemption covers only dotted secret-like names of source files', () => {
  for (const name of ['credentials.py', 'AgentSearchCredentials.test.tsx', 'a/secret_utils.ts', 'Secrets.kt', 'credentials.go', 'secret.rb', 'Credentials.java', 'x/credentials.mjs', 'credentials.cjs', 'secretStore.jsx', 'Credentials.swift', 'credentials.js'])
    assert.equal(isSecretPath(name), false, name);
  for (const name of ['credentials.json', 'client_secret.json', 'secrets.yaml', '.git-credentials', 'secrets.txt', 'credentials', '.secrets.py', '.env', '.env.ts', '.env.local',
    'server.pem', 'tls.key', 'auth.json', 'secrets/config.py', 'credentials/db.ts', 'aws_credentials.cfg', 'credentials.py.bak', 'credentials.tsx.orig'])
    assert.equal(isSecretPath(name), true, name);
});

test('full-auto: real secret files still ask in the project', async () => {
  for (const command of ['cat credentials.json', 'git add .env.production', 'cat config/secrets.yaml', 'git add certs/server.pem', 'cp tls.key /tmp/x', 'cat credentials.json backend/app/agent_search/credentials.py'])
    assert.equal(await decide(command), 'deny', command); // 0.4.0: hard deny (secret)
});

test('protected locations: browser profile data, agent profiles and the harness install', () => {
  const roots = protectedRoots({ env: {}, state: '/nonexistent/state', home: '/home/nobody' });
  for (const dir of PROTECTED_DIRS) assert.ok(roots.roots.includes(dir));
  const ask = [
    '/workspace/browser-probe/chrome-agent-profile/Default/Cookies', '/workspace/browser-probe/chrome-agent-profile', '/workspace/browser-probe/fb/chrome-profile-box/x',
    '/home/box/work/agent-profiles/fb-zach/Default/Login Data', '/home/box/work/agent-profiles', '/x/y/Web Data', '/x/Local State', '/x/Default/Network/Cookies-journal',
    '/home/u/.config/google-chrome/Profile 2/History', '/srv/chromium-user-data/Default/Preferences',
    `${OCH}/workrelay-bridge.json`, `${OCH}/gateway/mcp.json`, `${OCH}/claude-config/.credentials.json`, `${OCH}/xdg/data/opencode/opencode.db`, `${OCH}/state/config/opencode.json`, `${OCH}/state`, OCH,
    '/nonexistent/state/quota/x', '/nonexistent/workrelay-bridge.json', path.join(UD, 'Default', 'x'), UD,
  ];
  for (const target of ask) assert.ok(protectedLocation(target, { roots }), target);
  const allow = [`${RECEIPTS}/mobile-jest-1/stdout.log`, RECEIPTS, '/nonexistent/state/check-receipts/a/b', `${OCH}/harness/releases/0.3.3-286543a/src/check_receipt.py`,
    `${OCH}/xdg/data/opencode/shell/abc/sh_1`, '/workspace/browser-probe/html-cdp/a.html', '/workspace/browser-probe/fb/html/x.html',
    path.join(P, 'mobile/src/screens/ProfileScreen.tsx'), path.join(P, 'src/themes/Default/index.ts'), '/home/box/work/yrdsale/backend/app/x.py'];
  for (const target of allow) assert.equal(protectedLocation(target, { roots }), undefined, target);
});

test('full-auto read tools ask for protected locations; check-receipts and fixtures stay allowed', () => {
  const asks = [['read', '/workspace/browser-probe/chrome-agent-profile/Default/Cookies'], ['read', '/workspace/browser-probe/chrome-agent-profile/Local State'],
    ['glob', '/workspace/browser-probe/chrome-agent-profile/Default/*'], ['read', '/home/box/work/agent-profiles/fb-zach/Default/Login Data'],
    ['grep', '/home/box/work/agent-profiles/*'], ['read', `${OCH}/workrelay-bridge.json`], ['read', `${OCH}/gateway/mcp.json`], ['list', `${OCH}/gateway/*`],
    ['read', `${OCH}/xdg/data/opencode/opencode.db`], ['read', `${OCH}/claude-config/settings.json`], ['glob', `${OCH}/*`], ['read', `${OCH}/state/config/configure-choices.json`],
    ['read', `${RECEIPTS}/../config/opencode.json`], ['grep', '/home/box/work/*'], ['grep', '/workspace/*'], ['read', path.join(UD, 'Default/Bookmarks')]];
  for (const [tool, resource] of asks) assert.equal(ext(tool, resource).decision, 'deny', `${tool} ${resource}`);
  const allows = [['read', `${RECEIPTS}/mobile-jest-8k3dussh/stdout.log`], ['glob', `${RECEIPTS}/*`], ['grep', `${RECEIPTS}/mobile-jest-8k3dussh/*`],
    ['read', `${OCH}/xdg/data/opencode/shell/abc/sh_1`], ['read', '/workspace/browser-probe/html-cdp/box-mercari-search.html'], ['glob', '/workspace/browser-probe/*'],
    ['grep', '/workspace/browser-probe/*'], ['read', '/usr/share/doc/x']];
  for (const [tool, resource] of allows) assert.equal(ext(tool, resource).decision, 'allow', `${tool} ${resource}`);
  // The non-full-auto path refuses them as credential paths as well.
  assert.equal(decideAutoPermission({ action: 'read', resources: [`${OCH}/workrelay-bridge.json`], tool: 'read', input: {}, directory: P }).reason, 'credential_path');
});

test('full-auto read-only shell asks for protected locations (guard and external_directory agree)', async () => {
  const asks = [
    'sqlite3 /home/box/work/agent-profiles/fb-zach/Default/Cookies .dump', `cat ${OCH}/workrelay-bridge.json`, `cd ${OCH} && cat workrelay-bridge.json`,
    `ls ${OCH}/gateway`, `head -c 200 "/workspace/browser-probe/chrome-agent-profile/Default/Login Data"`, 'cp /workspace/browser-probe/chrome-agent-profile/Default/Cookies /tmp/c',
    `sqlite3 ${OCH}/xdg/data/opencode/opencode.db "select * from account"`, `B=${OCH}/claude-config; cat $B/.credentials.json`, `cat ${RECEIPTS}/../config/opencode.json`,
    `cd ${RECEIPTS} && cat ../../workrelay-bridge.json`, `grep -r token ${OCH}/gateway`, 'python3 -c "print(1)" < /home/box/work/agent-profiles/fb-zach/Default/Preferences',
    `bash -c "cat ${OCH}/workrelay-bridge.json"`, 'strings "/home/box/work/agent-profiles/fb-zach/Local State"',
  ];
  for (const command of asks) {
    assert.notDeepEqual(fullAutoShellCheck(command, P, project), [], command);
    assert.equal(await decide(command), 'deny', command); // 0.4.0: hard deny (secret)
    assert.equal(ext('bash', '/home/box/work/*', { command }).decision, 'deny', command);
  }
  const allows = [`cat ${RECEIPTS}/mobile-jest-1/stdout.log`, `cd ${RECEIPTS}/mobile-jest-1 && grep -c FAIL stdout.log stderr.log`, `ls ${RECEIPTS}`,
    `python3 ${OCH}/harness/releases/0.3.3-286543a/src/check_receipt.py --label t -- npm test`, 'ls -la /workspace/browser-probe/html-cdp',
    'head -c 1500 /workspace/browser-probe/html-cdp/box-mercari-search.html', 'grep -n Default mobile/src/screens/AgentSearchScreen.tsx', 'git log --oneline -3'];
  for (const command of allows) {
    assert.deepEqual(fullAutoShellCheck(command, P, project), [], command);
    assert.equal(await decide(command), 'allow', command);
  }
});
