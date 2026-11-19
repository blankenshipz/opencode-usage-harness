// Read-only repository identity for roles without shell (router, coordinator,
// scout, architect, reviewer). Runs fixed git argv only (no shell, no user
// arguments), with optional locks and fsmonitor hooks disabled so it cannot
// write the index or execute repository-configured commands.
import { execFile } from 'node:child_process';

const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '--no-optional-locks'];
const MAX_PATHS = 20;

function git(args, cwd, run) {
  return new Promise(resolve => {
    run('git', [...GIT_SAFE, ...args], { cwd, timeout: 5000, maxBuffer: 1 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout) => resolve(error ? undefined : String(stdout).trimEnd()));
  });
}

export async function repoIdentity(cwd, { run = execFile } = {}) {
  const toplevel = await git(['rev-parse', '--show-toplevel'], cwd, run);
  if (toplevel === undefined) return { cwd, git: false };
  const [branch, head, status] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, run),
    git(['rev-parse', 'HEAD'], cwd, run),
    git(['status', '--porcelain=v1', '--untracked-files=normal'], cwd, run),
  ]);
  const lines = status ? status.split('\n').filter(Boolean) : [];
  const summary = { staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  for (const line of lines) {
    const x = line[0], y = line[1];
    if (x === '?' && y === '?') summary.untracked++;
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) summary.conflicted++;
    else { if (x !== ' ') summary.staged++; if (y !== ' ') summary.modified++; }
  }
  return {
    cwd, git: true, toplevel,
    branch: branch === 'HEAD' ? null : branch ?? null, detached: branch === 'HEAD', head: head ?? null,
    dirty: status === undefined ? null : lines.length > 0, ...summary,
    paths: lines.slice(0, MAX_PATHS), pathsTruncated: lines.length > MAX_PATHS,
  };
}

export async function installRepoIdentity(ctx, options = {}) {
  if (typeof ctx?.tool?.transform !== 'function') return;
  await ctx.tool.transform(editor => editor.add({
    name: 'repo_identity',
    description: 'Read-only repository identity: working directory, git toplevel, branch, HEAD commit and a dirty-state summary. Use instead of shell pwd/git status when shell is unavailable.',
    input: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const cwd = ctx.location?.directory ?? process.cwd();
      return { content: JSON.stringify(await repoIdentity(cwd, options)) };
    },
  }));
}
