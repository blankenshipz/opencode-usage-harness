// r26 item 3: explicit review verdicts by git tree, for the pre-push gate
// (scripts/git-hooks/pre-push reads <state>/review-verdicts.jsonl).
//
// Only a reviewer/verifier session can record a verdict, through the
// review_verdict tool, naming the HEAD it reviewed. The harness checks that HEAD
// is still current and records the tree of the exact working tree (HEAD^{tree}
// when clean; otherwise a tree written from a temporary index, so a later commit
// or squash of exactly those files has the same tree). Nothing is inferred from
// task completion.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { statePath } from './paths.mjs';
import { runtimeSessions } from './dispatch-registry.mjs';

const REVIEW_AGENT = /(review|verif)/i;
export const VERDICTS = ['pass', 'needs_fixes', 'fail'];

const git = (cwd, args, env) => new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));

export async function workingTree(directory, runGit = git) {
  const status = await runGit(directory, ['status', '--porcelain']);
  if (!status) return runGit(directory, ['rev-parse', 'HEAD^{tree}']);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-verdict-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    await runGit(directory, ['read-tree', 'HEAD'], env);
    await runGit(directory, ['add', '-A'], env);
    return await runGit(directory, ['write-tree'], env);
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

export async function recordReviewVerdict({ agent, verdict, reviewedHead, summary, sessionId, directory, now = Date.now(), file = statePath('review-verdicts.jsonl'), runGit = git }) {
  if (typeof agent !== 'string' || !REVIEW_AGENT.test(agent)) throw new Error('review_verdict: only reviewer/verifier sessions can record a verdict');
  if (!VERDICTS.includes(verdict)) throw new Error(`review_verdict: verdict must be one of ${VERDICTS.join(', ')}`);
  if (typeof directory !== 'string' || !directory) throw new Error('review_verdict: session directory unknown');
  const head = await runGit(directory, ['rev-parse', 'HEAD']);
  if (typeof reviewedHead !== 'string' || reviewedHead.length < 7 || !head.startsWith(reviewedHead)) throw new Error(`review_verdict: reviewedHead does not match the current HEAD ${head.slice(0, 12)}; re-review the current tree`);
  const [tree, repo] = await Promise.all([workingTree(directory, runGit), runGit(directory, ['rev-parse', '--show-toplevel'])]);
  const line = { tree, head, repo, verdict, sessionId, agent, ...(summary ? { summary: String(summary).slice(0, 300) } : {}), recordedAt: new Date(now).toISOString() };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.appendFile(file, JSON.stringify(line) + '\n', { mode: 0o600 });
  return line;
}

export async function installReviewVerdictTool(ctx, { loadSessions = runtimeSessions, record = recordReviewVerdict } = {}) {
  if (typeof ctx?.tool?.transform !== 'function') return;
  await ctx.tool.transform(editor => editor.add({ name: 'review_verdict',
    description: 'Reviewer/verifier only: record your verdict for the exact working tree you reviewed (pass | needs_fixes | fail) with the HEAD sha you reviewed. Pushes to main require a pass for that tree.',
    input: { type: 'object', additionalProperties: false, properties: { verdict: { type: 'string', enum: VERDICTS }, reviewedHead: { type: 'string', minLength: 7, maxLength: 64, pattern: '^[0-9a-f]+$' }, summary: { type: 'string', maxLength: 300 } }, required: ['verdict', 'reviewedHead'] },
    execute: async (args, call) => {
      const session = (await loadSessions()).find(s => s.id === call.sessionID);
      const line = await record({ agent: session?.agent ?? call.agent, verdict: args.verdict, reviewedHead: args.reviewedHead, summary: args.summary, sessionId: call.sessionID, directory: session?.directory ?? ctx.location?.directory });
      return { content: `Recorded ${line.verdict} for tree ${line.tree.slice(0, 12)} (HEAD ${line.head.slice(0, 12)}).` };
    } }));
}
