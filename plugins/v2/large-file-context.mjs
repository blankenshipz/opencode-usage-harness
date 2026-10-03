import fs from 'node:fs/promises';
import path from 'node:path';
import { shellReads as legacyShellReads } from '../large-file-context/core.mjs';

const LIMIT = 350;
const SUMMARY_LIMIT = 6000;
const READ_ONLY_AGENTS = new Set(['scout', 'router', 'architect', 'reviewer', 'coordinator']);
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const lineCount = content => content === '' ? 0 : content.replace(/\n$/, '').split('\n').length;
const textPage = result => result?.output?.type === 'text-page' ? result.output : undefined;
const nativeResult = result => result?.output?.type === 'file' || result?.output?.type === 'list-page';
const delegatingAgents = new Set(['router', 'coordinator']);
const readOutput = {
  anyOf: [
    { type: 'object', required: ['type', 'mime', 'content', 'offset', 'truncated'], properties: { type: { const: 'text-page' }, mime: { type: 'string' }, content: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, truncated: { type: 'boolean' }, next: { type: 'integer', minimum: 1 } } },
    { type: 'object', required: ['type', 'mime', 'content', 'encoding'], properties: { type: { const: 'file' }, mime: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string' } } },
    { type: 'object', required: ['type', 'entries', 'truncated'], properties: { type: { const: 'list-page' }, entries: { type: 'array' }, truncated: { type: 'boolean' }, next: { type: 'integer', minimum: 1 } } },
  ],
};

// The V2 core encodes a raw JSON output schema with Schema.Json. Native ReadTool
// pages are Schema.Class instances, which are valid at the native boundary but
// are not themselves JSON values. Preserve the complete native result while
// converting only a successful output to its wire representation.
const plainJSON = value => JSON.parse(JSON.stringify(value));
const normalizedNativeRead = async (execute, input, context) => {
  const result = await execute(input, context);
  if (!result || typeof result !== 'object' || !('output' in result)) return result;
  return { ...result, output: plainJSON(result.output) };
};

// The legacy parser is shared with V1. V2 removes only file-descriptor output
// redirects before asking it for read operands, preventing `2>/dev/null` from
// becoming a fictitious read of a file named "2".
const withoutFdRedirects = command => command.replace(/(^|[\s;|&])\d+(?:>>?|<<?)\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;|&()]+)/g, '$1');
const shellSegments = command => {
  const segments = []; let start = 0; let quote = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === '\\' && quote === '"') { i++; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      if (command.slice(start, i).trim()) segments.push(command.slice(start, i));
      if ((char === '|' || char === '&') && command[i + 1] === char) i++;
      start = i + 1;
    }
  }
  if (command.slice(start).trim()) segments.push(command.slice(start));
  return segments;
};
const unquote = value => value?.replace(/^(?:'([^']*)'|"((?:\\.|[^"\\])*)")$/, (_, single, double) => single ?? double.replace(/\\(.)/g, '$1'));
const outputPath = value => value && !value.startsWith('-') ? unquote(value) : undefined;
const producedPaths = command => {
  const paths = new Set();
  for (const segment of shellSegments(command)) {
    // Explicit downloader outputs and shell redirects are observable literal
    // creates. Do not preflight a later broad read of a path that does not yet
    // exist; require the producer and read to be split instead.
    for (const match of segment.matchAll(/(?:^|\s)(?:-o|--output)(?:=|\s+)("(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&()]+)/g)) {
      const value = outputPath(match[1]); if (value) paths.add(value);
    }
    for (const match of segment.matchAll(/(?:^|\s)(?<!\d)>{1,2}\s*("(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&()]+)/g)) {
      const value = outputPath(match[1]); if (value) paths.add(value);
    }
    const tee = segment.match(/(?:^|\s)tee(?:\s+--?[^\s]+)*\s+("(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&()]+)/);
    const value = outputPath(tee?.[1]); if (value) paths.add(value);
  }
  return paths;
};

export function shellReads(command, threshold = LIMIT) {
  const reads = legacyShellReads(withoutFdRedirects(command), threshold);
  // The legacy parser intentionally does not classify interpreter scripts. Treat the
  // common literal file-dump forms as unbounded; ordinary Python/Node build commands
  // have no matching file argument and remain unaffected.
  const match = command.match(/(?:^|[;&|]\s*)(?:python(?:3)?|node)\s+(?:-[A-Za-z]+\s+)?(?:-e\s+)?[^\n;|]*?(?:readFileSync|read_text|read_bytes|open\()\s*\(?\s*['\"]([^'\"]+)['\"]/);
  if (match) reads.push({ file: match[1], bounded: false, dynamic: false, moved: false });
  return reads;
}

export function createLargeFileContext({ fs: fileSystem = fs, now = () => Date.now() } = {}) {
  return {
    id: 'subscription.large-file-context',
    async setup(ctx) {
      const directory = ctx.location.directory;
      const grants = new Map();
      let nativeRead;
      let nativeSubagent;

      const locationPath = (filePath, workdir = directory) => {
        return path.resolve(workdir, filePath);
      };
      const stamp = async filePath => {
        const real = await fileSystem.realpath(locationPath(filePath));
        const stat = await fileSystem.stat(real);
        return { filePath, real, stamp: fingerprint(stat) };
      };
      const grantKey = (context, info) => JSON.stringify([context.sessionID, info.real]);
      const preflight = async (input, context) => {
        if (!nativeRead) return { kind: 'unavailable' };
        // The native tool remains the permission and byte-access boundary. This result
        // is inspected only for paging metadata and is never returned to the caller.
        const result = await nativeRead({ path: input.path, offset: 1, limit: LIMIT + 1 }, context);
        const page = textPage(result);
        if (!page) return { kind: nativeResult(result) ? 'native' : 'other' };
        return { kind: !page.truncated && lineCount(page.content) <= LIMIT ? 'small' : 'large', page };
      };
      const callNativeRead = (input, context) => normalizedNativeRead(nativeRead, input, context);
      const directGrant = async (input, context) => {
        try { return await stamp(input.path); }
        catch { return undefined; }
      };
      const takeGrant = async (input, context) => {
        let info;
        try { info = await stamp(input.path); } catch { return false; }
        const key = grantKey(context, info);
        const grant = grants.get(key);
        if (!grant || grant.expires <= now() || grant.stamp !== info.stamp) { grants.delete(key); return false; }
        // Delete before awaiting the native read so parallel calls cannot share it.
        grants.delete(key);
        return grant;
      };
      const bounded = input => {
        if (input.limit === 0) return undefined;
        if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0)) return input;
        if (input.limit !== undefined && input.limit > LIMIT) return undefined;
        return { ...input, limit: input.limit ?? LIMIT };
      };
      const denial = message => ({ content: message });
      const readDenial = message => ({ output: { type: 'text-page', mime: 'text/plain', content: message, offset: 1, truncated: false }, content: message, metadata: { truncated: false } });
      const shellDenial = message => ({ output: { exit: 1, output: message, truncated: false }, content: message, metadata: { exit: 1 } });
      const blockLarge = input => readDenial(`Large-file context block for ${JSON.stringify(input.path)}. Use an explicit bounded native read (limit <= ${LIMIT}); a router or coordinator can use large_file_summary for a broad question; or request large_file_allow_direct for a one-use exception.`);
      const isLargePath = async (file, context) => (await preflight({ path: file }, context)).kind === 'large';

      await ctx.tool.transform(editor => {
        const read = editor.get('read');
        const subagent = editor.get('subagent');
        const shell = editor.get('shell') ?? editor.get('bash');
        nativeRead = read?.execute;
        nativeSubagent = subagent?.execute;
        if (read) editor.update('read', tool => {
          tool.description += `\nLarge-file policy: direct text reads are capped at ${LIMIT} lines. Use explicit bounded reads; a router or coordinator can use large_file_summary for broad files.`;
          // The stock ReadTool output uses Schema.Class for pages. A policy denial is
          // a plain JSON result, so use the equivalent structural public contract.
          tool.output = readOutput;
          tool.execute = async (input, context) => {
            const grant = await takeGrant(input, context);
            if (grant) {
              const result = await callNativeRead(input, context);
              const after = await stamp(input.path);
              if (after.real !== grant.real || after.stamp !== grant.stamp) return readDenial(`large-file-context: file changed during direct read. Request a new one-use exception or use an explicit bounded native read (limit <= ${LIMIT}).`);
              return result;
            }
            // Reject invalid or oversized requested final ranges before preflight.
            // A preflight is deliberately fixed at 351 lines and must not mask this.
            const range = bounded(input);
            if (!range) return readDenial(`large-file-context: direct reads must use a limit from 1 to ${LIMIT} lines.`);
            // Explicit bounded ranges remain usable by scouts and other leaf roles.
            if (input.limit !== undefined) return callNativeRead(input, context);
            if (input.offset !== undefined) return callNativeRead(range, context);
            const page = await preflight(input, context);
            if (page.kind === 'large') return blockLarge(input);
            if (page.kind === 'denied' || page.kind === 'unavailable') return readDenial(`large-file-context: native preflight was unavailable or denied. Use an explicit bounded native read (limit <= ${LIMIT}) or ask the parent to summarize the file.`);
            if (page.kind === 'native') return callNativeRead(input, context);
            return callNativeRead(range, context);
          };
        });
        if (shell) editor.update('shell', tool => {
          tool.execute = async (input, context) => {
            const command = input.command;
            if (typeof command !== 'string') return shell.execute(input, context);
            let reads;
            try { reads = shellReads(command); }
            catch { return shellDenial(`large-file-context: shell read could not be parsed; use an explicit bounded native read (limit <= ${LIMIT}), or have a router or coordinator request large_file_summary.`); }
            const workdir = input.workdir === undefined ? directory : locationPath(input.workdir);
            const produced = new Set([...producedPaths(command)].map(file => locationPath(file, workdir)));
            for (const item of reads) {
              if (item.dynamic || (item.moved && !path.isAbsolute(item.file ?? ''))) return shellDenial(`large-file-context: shell read needs a literal path without directory changes; use an explicit bounded native read (limit <= ${LIMIT}), or have a router or coordinator request large_file_summary.`);
              if (item.bounded || !item.file) continue;
              if (item.file.startsWith('~')) return shellDenial(`large-file-context: shell read does not support tilde paths; use an explicit bounded native read (limit <= ${LIMIT}), or have a router or coordinator request large_file_summary.`);
              if (produced.has(locationPath(item.file, workdir))) return shellDenial(`large-file-context: this command creates ${JSON.stringify(item.file)} before broadly reading it. Run the write command separately, then use an explicit bounded native read (limit <= ${LIMIT}) or have a router or coordinator request large_file_summary.`);
              if (await isLargePath(locationPath(item.file, workdir), context))
                return shellDenial(`Large-file shell bypass blocked for ${JSON.stringify(item.file)}. Use an explicit bounded native read (limit <= ${LIMIT}) or have a router or coordinator request large_file_summary.`);
            }
            return shell.execute(input, context);
          };
        });
        editor.add({
          name: 'large_file_check',
          description: `Check whether a file exceeds ${LIMIT} text lines without returning its contents. Then use an explicit bounded native read, or have a router or coordinator use large_file_summary for a broad question.`,
          input: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] },
          execute: async (input, context) => {
            const result = await preflight(input, context);
            if (result.kind === 'small') return denial(`File is at most ${LIMIT} lines; use an explicit bounded native read (limit <= ${LIMIT}).`);
            if (result.kind === 'large') return denial(`File exceeds ${LIMIT} lines; use an explicit bounded native read (limit <= ${LIMIT}) or have a router or coordinator request large_file_summary.`);
            return denial('Native file handling applies; use the native read tool for the normal attachment, directory, or binary result.');
          },
        });
        editor.add({
          name: 'large_file_summary',
          description: `Router/coordinator only: ask a fresh foreground scout to summarize a large file using targeted native reads of at most ${LIMIT} lines. Leaf agents should use explicit bounded native reads or ask their parent for a summary.`,
          input: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, question: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['path', 'question'] },
          execute: async (input, context) => {
            if (!delegatingAgents.has(context.agent)) return denial(`large-file-context: ${context.agent ?? 'this agent'} cannot create a nested scout; do not retry this tool. Use an explicit bounded native read (limit <= ${LIMIT}) or ask a router or coordinator to request large_file_summary.`);
            if (!nativeSubagent) return denial(`large-file-context: native subagent tool is unavailable. Use an explicit bounded native read (limit <= ${LIMIT}) or ask the parent to summarize the file.`);
            const check = await preflight(input, context);
            if (check.kind !== 'large') return denial(`large_file_summary is only for a file that exceeds the direct-read limit; use an explicit bounded native read (limit <= ${LIMIT}).`);
            const result = await nativeSubagent({ taskId: 'large-file-summary', workKey: `summary-${input.path}`.slice(0,160), operation: 'inspect', requiredCapabilities: [], agent: 'scout', description: 'Summarize large file', background: false,
              prompt: `Analyze ${JSON.stringify(input.path)} for this question: ${input.question}\nUse only native read calls with explicit offset and limit <= ${LIMIT}. Do not use file attachments, shell dumps, edits, or subagents. Return concise findings with file:line references in at most ${SUMMARY_LIMIT} characters.` }, context);
            const output = String(result?.output?.output ?? result?.content ?? '');
            if (!output || output.length > SUMMARY_LIMIT) return denial(`large-file-context: scout did not return a bounded summary. Use explicit bounded native reads (limit <= ${LIMIT}) or retry through the router or coordinator with a narrower question.`);
            return denial(output);
          },
        });
        editor.add({
          name: 'large_file_allow_direct',
          description: `Record one direct read of an unchanged large file. The reason is retained for audit context; the grant expires after 60 seconds and is consumed before the native read starts. Explicit bounded native reads (limit <= ${LIMIT}) remain available.`,
          input: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, reason: { type: 'string', minLength: 8, maxLength: 1000 } }, required: ['path', 'reason'] },
          execute: async (input, context) => {
            if (READ_ONLY_AGENTS.has(context.agent)) return denial(`large-file-context: ${context.agent} cannot request a direct-read exception. Use an explicit bounded native read (limit <= ${LIMIT}) or ask the parent for an approved exception.`);
            if (input.path.startsWith('~')) return denial(`large-file-context: direct grants do not support tilde paths. Use an explicit bounded native read (limit <= ${LIMIT}) with a literal path.`);
            // Native preflight remains the permission boundary. A failed or non-text
            // native result cannot be converted into a direct grant.
            let check;
            try { check = await preflight(input, context); }
            catch { return denial(`large-file-context: native preflight was denied; no direct grant was issued. Use an explicit bounded native read (limit <= ${LIMIT}) or ask the parent to summarize the file.`); }
            if (check.kind !== 'large') return denial(`large-file-context: native preflight was ${check.kind}; no direct grant was issued. Use an explicit bounded native read (limit <= ${LIMIT}) or ask the parent to summarize the file.`);
            const info = await directGrant(input, context);
            if (!info) return denial(`large_file_allow_direct requires an existing file. Use a literal existing path for an explicit bounded native read (limit <= ${LIMIT}).`);
            grants.set(grantKey(context, info), { real: info.real, stamp: info.stamp, reason: input.reason, expires: now() + 60_000 });
            return denial('One direct read is allowed for this unchanged path within 60 seconds.');
          },
        });
      });
    },
  };
}

export default createLargeFileContext();
