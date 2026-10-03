import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { recordCompletion, deduplicateCompletionRecords, readCompletionLedger } from '../plugins/v2/completion-ledger.mjs';

const row = (session_id, message_id) => ({ session_id, message_id, model: 'gpt-6-sol' });

test('completion ledger deduplicates concurrent writers and retries after a failed attempt', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'completion-ledger-'));
  try {
    const database = path.join(directory, 'completions.sqlite3');
    const results = await Promise.all(Array.from({ length: 4 }, () => recordCompletion({ database, value: row('session-a', 'message-a') })));
    assert.equal(results.filter(Boolean).length, 1, 'concurrent plugin instances make one claim');
    assert.equal(await recordCompletion({ database, value: row('session-a', 'message-a') }), false, 'reload is ignored');
    assert.equal(await recordCompletion({ database, value: row('session-b', 'message-a') }), true, 'message ids are scoped to session');
    await assert.rejects(recordCompletion({ database, value: row('session-c', 'message-c'), run: async () => { throw new Error('private'); } }), /ledger write failed/);
    assert.equal(await recordCompletion({ database, value: row('session-c', 'message-c') }), true, 'failed transaction did not claim identity');
    assert.equal(readCompletionLedger({ database }).length, 3, 'the ledger retains every unique completion');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('historical completion reporting counts each session/message tuple once', () => {
  const report = deduplicateCompletionRecords([row('s1', 'm1'), row('s1', 'm1'), row('s2', 'm1'), {}]);
  assert.equal(report.records.length, 2);
  assert.equal(report.duplicateCount, 1);
  assert.equal(report.malformedCount, 1);
});

test('report merges raw and paginated ledger rows once, totals valid tokens, and tolerates missing or truncated raw logs', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'completion-report-'));
  try {
    const database = path.join(directory, 'completions.sqlite3'), raw = path.join(directory, 'completions.jsonl');
    const duplicate = { ...row('s1', 'm1'), tokens: { input: 1, output: 2, reasoning: 3, cache: 4, cache_write: -1 } };
    writeFileSync(raw, `${JSON.stringify(duplicate)}\ntruncated`);
    await recordCompletion({ database, value: { ...row('s1', 'm1'), tokens: { input: 5, output: 6, reasoning: 7, cache: { read: 8, write: 9 } } } });
    await Promise.all(Array.from({ length: 3 }, (_, index) => recordCompletion({ database, value: row('bulk', String(index)) })));
    assert.equal(readCompletionLedger({ database, pageSize: 2 }).length, 4, 'small pages exercise cursor pagination');
    const run = target => JSON.parse(spawnSync(process.execPath, ['bin/completion-telemetry-report.mjs', target, database], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' }).stdout);
    const report = run(raw);
    assert.equal(report.unique, 4);
    assert.equal(report.duplicates, 1);
    assert.equal(report.malformed, 1);
    assert.deepEqual(report.tokens, { input: 5, output: 6, reasoning: 7, cache_read: 8, cache_write: 9 });
    assert.equal(run(path.join(directory, 'missing.jsonl')).unique, 4, 'fresh ledger-only install reports successfully');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('legacy identity validation rejects empty IDs and tuple encoding cannot collide', () => {
  const result = deduplicateCompletionRecords([
    { session_id: '', message_id: '' },
    { session_id: 'a\0b', message_id: 'c' },
    { session_id: 'a', message_id: 'b\0c' },
  ]);
  assert.equal(result.malformedCount, 1);
  assert.equal(result.records.length, 2);
  assert.equal(result.duplicateCount, 0);
});
