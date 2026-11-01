import fsPromises from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 6000;
const MAX_LIMIT = 12000;
// Keep a BOM in the decoded string so grammar validation rejects it rather than
// silently changing the bytes that this helper claims to return verbatim.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const failure = message => ({ content: JSON.stringify({ error: message }) });

const validPageInput = input => {
  if (!input || typeof input.path !== 'string' || input.path.length === 0 || input.path.startsWith('~')) return false;
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) return false;
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT)) return false;
  if (input.expectedSha256 !== undefined && (typeof input.expectedSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.expectedSha256))) return false;
  return (input.offset ?? 0) === 0 || input.expectedSha256 !== undefined;
};

const nativeText = result => {
  const output = result?.output;
  if (output?.type === 'text-page') return true;
  return output?.type === 'file' && typeof output.content === 'string' && (!output.encoding || /^utf-?8$/i.test(output.encoding));
};

export function createStructuredJSONRead({ directory, nativeRead, fs: fileSystem = fsPromises } = {}) {
  if (typeof directory !== 'string' || typeof nativeRead !== 'function') throw new TypeError('directory and nativeRead are required');

  return {
    name: 'large_file_json',
    description: `For an assigned complete JSON evidence review, read a JSON file as lossless, verbatim JSON text in UTF-16 pages (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT} code units). Concatenate pages using next and pass sourceSha256 as expectedSha256 on later pages. Partial pages are not a complete JSON document; do not use this as a broad source dump.`,
    input: {
      type: 'object', additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      },
    },
    async execute(input, context) {
      if (!validPageInput(input)) return failure('large_file_json: invalid input.');
      const original = input.path;
      // This is deliberately first: native ReadTool authorization must succeed before
      // filesystem metadata or source bytes are touched.
      const originalResult = await nativeRead({ path: original, offset: 1, limit: 1 }, context);
      if (!nativeText(originalResult)) return failure('large_file_json: native read did not authorize UTF-8 text.');

      let handle;
      let resolved;
      let canonical;
      let before;
      try {
        resolved = path.resolve(directory, original);
        canonical = await fileSystem.realpath(resolved);
        before = await fileSystem.stat(canonical);
      } catch {
        return failure('large_file_json: source could not be read safely.');
      }
      // Do not place this authorization call in the sanitizing filesystem-error
      // handler below: a native permission denial must remain a denial.
      if (canonical !== original) {
        const canonicalResult = await nativeRead({ path: canonical, offset: 1, limit: 1 }, context);
        if (!nativeText(canonicalResult)) return failure('large_file_json: native read did not authorize UTF-8 text.');
      }
      try {
        if (!before.isFile() || before.size > MAX_BYTES) return failure('large_file_json: source is not a supported JSON file.');

        // A post-stat replacement by a FIFO must not block before fstat can
        // reject the changed identity/type. Regular-file reads are unaffected.
        handle = await fileSystem.open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        const opened = await handle.stat();
        if (!opened.isFile() || stamp(opened) !== stamp(before) || await fileSystem.realpath(resolved) !== canonical) return failure('large_file_json: source changed while opening.');

        const bytes = Buffer.allocUnsafe(before.size + 1);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat();
        if (bytesRead !== before.size || stamp(after) !== stamp(before) || await fileSystem.realpath(resolved) !== canonical) return failure('large_file_json: source changed while reading.');
        const source = decoder.decode(bytes.subarray(0, bytesRead));
        try { JSON.parse(source); } catch { return failure('large_file_json: source is not valid JSON.'); }

        const sourceSha256 = createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex');
        if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sourceSha256) return failure('large_file_json: source changed; expected hash does not match.');
        const offset = input.offset ?? 0;
        if (offset > source.length) return failure('large_file_json: offset is outside the source.');
        if (offset > 0 && /[\uDC00-\uDFFF]/.test(source[offset]) && /[\uD800-\uDBFF]/.test(source[offset - 1])) return failure('large_file_json: offset splits a surrogate pair.');
        const limit = input.limit ?? DEFAULT_LIMIT;
        let end = Math.min(source.length, offset + limit);
        if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1]) && /[\uDC00-\uDFFF]/.test(source[end])) end--;
        if (end === offset && end < source.length) return failure('large_file_json: limit splits a surrogate pair; use a larger limit.');
        const next = end < source.length ? end : undefined;
        const output = { sourceSha256, sourceBytes: bytesRead, representation: 'verbatim-json-text', offset, ...(next === undefined ? {} : { next }), complete: next === undefined, content: source.slice(offset, end) };
        return { content: JSON.stringify(output) };
      } catch (error) {
        // Permission denials from either native gate intentionally escape above.
        return failure('large_file_json: source could not be read safely.');
      } finally {
        if (handle) await handle.close();
      }
    },
  };
}

export default createStructuredJSONRead;
