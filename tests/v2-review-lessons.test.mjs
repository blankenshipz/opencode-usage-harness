import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLesson } from '../plugins/v2/review-verdicts.mjs';
import { canonicalHarnessRole } from '../plugins/v2/agent-mode.mjs';

test('parity 4.8: needs_fixes lessons are appended bounded to .review/lessons.md', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));
  for (let i = 0; i < 5; i++) await appendLesson(repo, { summary: `finding ${i}\n  detail`, head: 'abcdef1234567890', recordedAt: '2026-11-22T00:00:00Z' }, { maxLines: 3 });
  await appendLesson(repo, { summary: '' });
  const lines = fs.readFileSync(path.join(repo, '.review', 'lessons.md'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '- 2026-11-22 needs_fixes @abcdef123456: finding 4 detail');
  fs.rmSync(repo, { recursive: true });
});
test('parity 4.9: senior-builder is a canonical harness role', () => {
  assert.equal(canonicalHarnessRole('harness-senior-builder'), 'senior-builder');
});
