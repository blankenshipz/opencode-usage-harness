import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageRoot, statePath, configuredPython } from './paths.mjs';

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0');
export function prepareCheck(args, root = packageRoot) {
  if (!/^[a-z0-9-]{1,64}$/.test(args.label ?? '') || !Array.isArray(args.argv) || !args.argv.length || args.argv.length > 128 || !args.argv.every(string)) throw new Error('check_prepare: valid label and argv required');
  if (args.revision !== undefined && (!string(args.revision) || args.revision.length > 160 || /[\x00-\x1f\x7f]/.test(args.revision))) throw new Error('check_prepare: invalid revision');
  const command = [configuredPython, path.join(root, 'src/check_receipt.py'), '--label', args.label];
  if (args.revision !== undefined) command.push('--revision', args.revision);
  command.push('--', ...args.argv);
  return { command: command.map(quote).join(' '), executed: false,
    next: 'Run this command through the normal shell tool in the intended project directory. Existing permissions apply. Do not put secrets in argv. The runner checks free space before launch, retains full private logs, and prints a receipt path. Read only relevant log ranges after failure; no automatic retry.' };
}

export async function installCheckTools(ctx, { run = exec, receiptRoot = statePath('check-receipts') } = {}) {
  const invoke = async (script, args) => {
    const result = await run(configuredPython, [path.join(packageRoot, 'src', script), ...args], { timeout: 8000, maxBuffer: 32768 });
    return { content: JSON.stringify(JSON.parse(result.stdout)) };
  };
  await ctx.tool.transform(editor => {
    editor.add({ name: 'check_prepare', description: 'Prepare a safely quoted harness-check command for a substantial build/test. Does not execute it; use normal shell permissions. Full logs stay outside model context.',
      input: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', pattern: '^[a-z0-9-]{1,64}$' }, revision: { type: 'string', maxLength: 160 }, argv: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 8192 } } }, required: ['label', 'argv'] },
      execute: async args => ({ content: JSON.stringify(prepareCheck(args)) }) });
    editor.add({ name: 'check_status', description: 'Inspect one harness check receipt without reading command logs. Reports verified process ownership or unknown; never stops/retries anything.',
      input: { type: 'object', additionalProperties: false, properties: { receipt: { type: 'string', minLength: 1, maxLength: 4096 } }, required: ['receipt'] },
      execute: async args => {
        if (!string(args.receipt)) throw new Error('check_status: invalid receipt');
        const root = await fs.realpath(receiptRoot), file = await fs.realpath(args.receipt);
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(file) !== 'receipt.json') throw new Error('check_status: receipt must be inside the harness receipt directory');
        return invoke('check_receipt.py', ['--status', file]);
      } });
    editor.add({ name: 'harness_health', description: 'Read-only check of saved session claim versus live native execution ownership. Use after an apparent stall, not every tool call. Unknown is not idle; no automatic retries, cleanup, or restart.',
      input: { type: 'object', additionalProperties: false, properties: { sessionID: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,160}$' } } },
      execute: async (args, call) => {
        const target = args.sessionID ?? call.sessionID;
        if (!identifier(target) || !identifier(call.sessionID)) throw new Error('harness_health: valid session identifiers required');
        return invoke('runtime_health.py', ['--session', target, '--caller', call.sessionID]);
      } });
  });
}
