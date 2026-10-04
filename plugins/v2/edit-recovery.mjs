import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 256;
const transient = /\b(?:permission|denied|network|timeout|timed?\s*out|temporar(?:y|ily)|unavailable|econn\w*|eacces)\b/i;
const deterministic = /\b(?:patch verification failed|patch rejected|patchText is required|invalid hunk|begin patch|end patch)\b/i;
const syntaxFailure = /\b(?:invalid hunk|first line of the patch|last line of the patch|empty patch|patchText is required)\b/i;

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sessionKey = context => typeof context?.sessionID === 'string' && context.sessionID ? context.sessionID : undefined;
const errorText = error => error instanceof Error ? error.message : String(error ?? '');
const patchPaths = patchText => {
  if (typeof patchText !== 'string') return [];
  const targets = new Set();
  for (const line of patchText.split(/\r?\n/)) {
    const header = line.trim();
    const match = /^\*\*\* (?:Add|Delete|Update) File: (.+?)\s*$/.exec(header);
    if (match?.[1]) targets.add(match[1]);
    const move = /^\*\*\* Move to: (.+?)\s*$/.exec(header);
    if (move?.[1]) targets.add(move[1]);
  }
  return [...targets];
};

const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

/**
 * Prevent an unchanged, deterministic patch failure from consuming another native
 * patch attempt in the same session. This wrapper never parses or applies patches:
 * native patch remains the sole mutation and permission authority.
 */
export async function installEditRecovery(ctx, { fileSystem = fs, maxEntries = LIMIT } = {}) {
  const failures = new Map();
  const root = ctx.location?.directory ?? process.cwd();
  const limit = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : LIMIT;
  const target = file => path.resolve(root, file);
  const stamp = async file => {
    try { return fingerprint(await fileSystem.stat(target(file))); }
    catch (error) { return error?.code === 'ENOENT' ? 'missing' : undefined; }
  };
  const snapshot = async files => Promise.all(files.map(async file => [file, await stamp(file)]));
  const trim = () => { while (failures.size > limit) failures.delete(failures.keys().next().value); };
  const blocked = async (key, files) => {
    const previous = failures.get(key);
    if (!previous) return false;
    if (previous.syntax) return true;
    const current = await snapshot(files);
    // Unknown metadata never proves that the target changed. Keeping the guard in
    // place is safer than treating an unavailable stat as a changed file.
    return current.every(([file, value]) => value === undefined || previous.fingerprints.get(file) === value);
  };
  await ctx.tool.transform(editor => {
    const patch = editor.get?.('patch');
    if (!patch?.execute) return;
    const native = patch.execute;
    editor.update('patch', tool => {
      tool.description = `${tool.description ?? ''}\nAfter a deterministic patch verification failure, correct the patch or refresh changed target content before retrying the same payload.`;
      tool.execute = async (input, context) => {
        const session = sessionKey(context);
        const patchText = input?.patchText;
        if (!session || typeof patchText !== 'string') return native(input, context);
        const hash = digest(patchText);
        const key = `${session}\0${hash}`;
        const files = patchPaths(patchText);
        if (await blocked(key, files)) {
          return { content: 'edit-recovery: this identical patch previously failed verification against unchanged target content in this session. Correct patchText, or refresh the changed target before retrying.' };
        }
        try {
          const result = await native(input, context);
          failures.delete(key);
          return result;
        } catch (error) {
          const message = errorText(error);
          if (deterministic.test(message) && !transient.test(message)) {
            const fingerprints = new Map(await snapshot(files));
            // A parse/syntax failure has no trustworthy affected-content state, so
            // only a changed payload can retry it. For target-based failures, a
            // metadata change permits the identical patch to reach native patch.
            failures.set(key, { syntax: syntaxFailure.test(message), fingerprints });
            trim();
          }
          throw error;
        }
      };
    });
  });
  return () => failures.clear();
}
