// Deterministic rerun of intent checks that declare an exact argv.
// Only allowlisted test/build runners run, via execFile (no shell), inside the
// session directory, with a timeout, a 1 MB output cap and a scrubbed env.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const RUNNERS = new Set(['npm', 'npx', 'node', 'pnpm', 'yarn', 'bun', 'pytest', 'python', 'python3', 'go', 'cargo', 'make', 'tsc', 'ruff', 'uv', 'deno', 'bash']);
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
  if (runner !== 'bash') return true;
  const script = argv[1];
  if (typeof script !== 'string' || !script || path.isAbsolute(script) || script.startsWith('-') || hasDotDot(script)) return false;
  try { const real = await fs.realpath(path.join(cwd, script)); return inside(root, real) && (await fs.stat(real)).isFile(); } catch { return false; }
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
    if (!Array.isArray(check?.argv) || check.argv.length < 1) continue;
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
