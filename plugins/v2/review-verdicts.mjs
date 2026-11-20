// Records passing reviewer/verifier task outcomes by git tree, for the pre-push gate
// (scripts/git-hooks/pre-push reads statePath('review-verdicts.jsonl')).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath } from './paths.mjs';

const REVIEW_AGENT = /(review|verif)/i;

const git = (cwd, args) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));

// The task_outcome schema has no verdict field: a completed task-scope outcome
// recorded by a reviewer/verifier agent counts as verdict "pass".
export function reviewVerdict({ agent, scope, status }) {
  if (typeof agent !== 'string' || !REVIEW_AGENT.test(agent)) return undefined;
  return scope === 'task' && status === 'completed' ? 'pass' : undefined;
}

export async function recordReviewVerdict({ agent, scope, status, sessionId, directory, now = Date.now(), file = statePath('review-verdicts.jsonl'), runGit = git }) {
  try {
    const verdict = reviewVerdict({ agent, scope, status });
    if (!verdict || typeof directory !== 'string' || !directory) return undefined;
    const [tree, head, repo] = await Promise.all([runGit(directory, ['rev-parse', 'HEAD^{tree}']), runGit(directory, ['rev-parse', 'HEAD']), runGit(directory, ['rev-parse', '--show-toplevel'])]);
    const line = { tree, head, repo, verdict, sessionId, recordedAt: new Date(now).toISOString() };
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.appendFile(file, JSON.stringify(line) + '\n', { mode: 0o600 });
    return line;
  } catch { return undefined; }
}
