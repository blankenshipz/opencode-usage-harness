// Deterministic rerun of intent checks that declare an exact argv.
// Only allowlisted test/build runners run, via execFile (no shell), inside the
// session directory, with a timeout, a 1 MB output cap and a scrubbed env.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// npx/uv/bunx can fetch and run arbitrary packages, so they are not runners.
export const RUNNERS = new Set(['npm', 'node', 'pnpm', 'yarn', 'bun', 'pytest', 'python', 'python3', 'go', 'cargo', 'make', 'tsc', 'ruff', 'deno', 'bash']);
// Inline code would let a declared "check" run arbitrary code outside the permission
// system; only repo files, package scripts and test runners are rerun.
const INLINE = new Set(['-e', '--eval', '-p', '--print', '-c', '--command', '-r', '--require', '--import', '--loader', '--experimental-loader', 'eval', 'x', 'dlx', 'exec']);
const PY_MODULES = new Set(['pytest', 'unittest']);
const SECRET_ENV = /^(ANTHROPIC_|OPENAI_|GH_|GITHUB_)|TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i;

export function scrubEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV.test(key)));
}

const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const hasDotDot = value => value.split(/[\\/]/).includes('..');

async function resolveCwd(root, rel) {
  if (rel === undefined) return root;
  if (typeof rel !== 'string' || path.isAbsolute(rel) || hasDotDot(rel)) return undefined;
  try { const real = await fs.realpath(path.join(root, rel)); return inside(root, real) ? real : undefined; } catch { return undefined; }
}

async function allowed(argv, root, cwd) {
  const runner = path.basename(argv[0]);
  if (argv[0] !== runner || !RUNNERS.has(runner)) return false; // bare runner names only, resolved via PATH
  const args = argv.slice(1);
  if (args.some(a => INLINE.has(a) || /^-(e|c|p|r)\S+/.test(a) && ['node', 'python', 'python3', 'deno', 'bun'].includes(runner) || /^--(eval|print|require|import|loader)=/.test(a))) return false;
  // Every path-like argument must be repo-relative, inside the repo and outside the
  // auto-allowed .review/ scratch (which agents can write without an ask).
  const scratch = path.join(root, '.review');
  const pathArg = a => !a.startsWith('-') && (a.includes('/') || /\.(m?[jt]s|cjs|py|sh)$/.test(a));
  const safePath = async a => {
    if (path.isAbsolute(a) || hasDotDot(a)) return false;
    let real; try { real = await fs.realpath(path.join(cwd, a)); } catch { return !a.includes('/') ? false : false; }
    return inside(root, real) && !inside(scratch, real);
  };
  for (const a of args) {
    const value = a.includes('=') && a.startsWith('-') ? a.slice(a.indexOf('=') + 1) : a;
    if ((pathArg(value) || path.isAbsolute(value)) && !(await safePath(value))) return false;
  }
  if (runner === 'make' && args.some(a => /^(-f|--file|--makefile|-C|--directory)/.test(a))) return false;
  if (runner === 'deno' && !['test', 'check', 'lint', 'fmt'].includes(args[0])) return false;
  if (['python', 'python3'].includes(runner)) {
    const m = args.indexOf('-m');
    if (m >= 0 && !PY_MODULES.has(args[m + 1])) return false;
    if (m < 0) { const script = args.find(a => !a.startsWith('-')); if (!script || !(await safePath(script))) return false; }
  }
  if (['node', 'bun'].includes(runner) && args[0] !== 'test') { const script = args.find(a => !a.startsWith('-')); if (!script || !(await safePath(script))) return false; }
  if (runner !== 'bash') return true;
  const script = argv[1];
  if (typeof script !== 'string' || !script || script.startsWith('-')) return false;
  return safePath(script);
}

const defaultRun = (file, args, options) => new Promise(resolve => {
  execFile(file, args, options, error => {
    if (!error) return resolve({ exitCode: 0, timedOut: false });
    resolve({ exitCode: typeof error.code === 'number' ? error.code : null, timedOut: error.killed === true });
  });
});

export async function rerunChecks({ checks, directory, run = defaultRun, timeoutMs = 600000, now = () => Date.now() }) {
  const results = [], skipped = [];
  let root;
  try { root = await fs.realpath(directory); } catch { root = undefined; }
  for (const check of Array.isArray(checks) ? checks : []) {
    // A check without argv cannot be verified deterministically: it makes the set unverified.
    if (!Array.isArray(check?.argv) || check.argv.length < 1) { skipped.push(check?.id); continue; }
    const cwd = root && await resolveCwd(root, check.cwd);
    if (!cwd || !(await allowed(check.argv, root, cwd))) { skipped.push(check.id); continue; }
    const startedAt = now();
    let outcome;
    try { outcome = await run(check.argv[0], check.argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, env: scrubEnv(), shell: false, windowsHide: true }); }
    catch { outcome = { exitCode: null, timedOut: false }; }
    results.push({ id: check.id, exitCode: outcome?.exitCode ?? null, timedOut: outcome?.timedOut === true, durationMs: Math.max(0, now() - startedAt) });
  }
  const checksVerified = results.length > 0 && skipped.length === 0 && results.every(result => result.exitCode === 0 && !result.timedOut);
  return { checks: results, skipped, checksVerified };
}
