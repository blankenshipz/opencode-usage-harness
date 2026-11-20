import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'harness-daily-rollup.mjs');

test('daily rollup summarizes tasks, verdicts, commits and quota without secrets', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-'));
  const tel = path.join(state, 'telemetry'); fs.mkdirSync(tel);
  const at = h => new Date(2026, 10, 20, h).toISOString();
  fs.writeFileSync(path.join(tel, 'task-outcomes.jsonl'), [
    { at: at(9), status: 'done', source: 'session-end', token: 'SECRETTOKEN' },
    { at: at(10), status: 'blocked', source: 'dispatch' },
    { at: new Date(2026, 10, 19, 10).toISOString(), status: 'done', source: 'dispatch' },
  ].map(r => JSON.stringify(r)).join('\n') + '\nnot json\n');
  fs.writeFileSync(path.join(tel, 'review-verdicts.jsonl'), JSON.stringify({ at: at(11), verdict: 'pass', hmac: 'SECRETHMAC' }) + '\n');
  fs.mkdirSync(path.join(state, 'quota-cache'));
  fs.writeFileSync(path.join(state, 'quota-cache', 'q.jsonl'), [8, 12].map(h => JSON.stringify({ checked_at: at(h), header_value: 'SECRETHDR',
    pools: { openai: { windows: [{ scope: 'account', duration_minutes: 10080, used_percent: h * 2 }] } } })).join('\n') + '\n');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'x'],
    { env: { ...process.env, GIT_AUTHOR_DATE: at(13), GIT_COMMITTER_DATE: at(13) } });
  const stdout = execFileSync(process.execPath, [bin, '--date', '2026-11-20', '--repo', repo], { env: { ...process.env, HARNESS_STATE_DIR: state }, encoding: 'utf8' });
  const out = stdout.trim();
  assert.equal(out, path.join(tel, 'daily-rollup-2026-11-20.json'));
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  const raw = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(raw + stdout, /SECRET/);
  const s = JSON.parse(raw);
  assert.deepEqual(s.tasks.byStatus, { done: 1, blocked: 1 });
  assert.deepEqual(s.tasks.bySource, { 'session-end': 1, dispatch: 1 });
  assert.deepEqual(s.verdicts.byVerdict, { pass: 1 });
  assert.equal(s.commits[path.basename(repo)], 1);
  assert.equal(s.quotaPoints['openai/account'].start, 16);
  assert.equal(s.quotaPoints['openai/account'].delta, 8);
  // Absent quota/verdict files are tolerated.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-empty-'));
  const p2 = execFileSync(process.execPath, [bin, '--date', '2026-11-20', '--repo', repo], { env: { ...process.env, HARNESS_STATE_DIR: empty }, encoding: 'utf8' }).trim();
  assert.equal(JSON.parse(fs.readFileSync(p2, 'utf8')).tasks.total, 0);
});
