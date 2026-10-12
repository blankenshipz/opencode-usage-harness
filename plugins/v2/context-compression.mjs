// Recoverable model-facing projections. Originals are local history artifacts;
// retrieval uses the native read tool, never a permission-bypassing plugin tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { statePath } from './paths.mjs';
import { compactToolText } from './result-compactor.mjs';
import { createCompressionDiagnostics } from './compression-diagnostics.mjs';

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const key = e => JSON.stringify([e.sessionID, e.messageID, e.id]);
const marker = '[harness compacted';
const MAX_RECORDS = 256, MAX_STORE_BYTES = 128 * 1024 * 1024;

export function compressionKind(event) {
  // No speculative classification of third-party tools: unknown means unchanged.
  if (event.tool === 'execute') return 'json';
  if (['grep', 'glob'].includes(event.tool)) return event.tool;
  if (event.tool === 'shell') {
    const command = event.input?.command;
    // Exact repeats only for an uncomplicated test/build command. Shell scripts,
    // source reads, pipes and redirection are deliberately excluded.
    if (typeof command !== 'string') return 'json';
    const trimmed = command.trim();
    if (/^git diff(?:\s+(?:--[\w-]+(?:=[\w./:@,+-]+)?|[\w./:@,+-]+))*\s*$/.test(trimmed)) return 'diff';
    return /^(?:npm (?:test|run (?:test|build|lint|typecheck))|pnpm (?:test|build|lint|typecheck)|bun test|pytest|python3? -m (?:pytest|unittest)|cargo (?:test|check|build)|go test)(?:\s+[\w./=@,:+-]+)*\s*$/.test(trimmed) ? 'shell' : 'json';
  }
}

export function createOutputStore(directory = statePath('tool-output-store'), options = {}) {
  const io = options.io ?? fs;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  const maxBytes = options.maxBytes ?? MAX_STORE_BYTES;
  const reserveBytes = options.reserveBytes ?? 256 * 1024 * 1024;
  return async (event, index, original, compacted, onSkip = () => {}) => {
    const skip = reason => { try { onSkip(reason); } catch {} return undefined; };
    const hash = digest(original);
    const reference = digest(JSON.stringify([event.sessionID, event.messageID, event.id, index, hash]));
    const destination = path.join(directory, reference);
    const chunksPath = path.join(destination, 'chunks.jsonl');
    const preservation = compacted.lossless === false
      ? 'unchanged context omitted; every file, hunk, and changed line retained; this preview is not an applyable patch.'
      : 'all values/entries retained.';
    const projected = `${compacted.text}\n${marker} ${compacted.strategy}; ${preservation} Exact original snapshot: ${path.join(destination, 'original.txt')}. For bounded retrieval use native read on ${chunksPath}, offset=1, limit=3; ignore native read headers and strip each N: line prefix; each stored line is a JSON string, concatenate decoded strings in order. Snapshot is not current source.]`;
    // Include the retrieval instructions in the saving; compression must pay for itself.
    if (Buffer.byteLength(projected) > 24 * 1024 || projected.split('\n').length > 1500) return skip('projection_over_budget');
    if (original.length - projected.length < 512 || projected.length > original.length * 0.85) return skip('no_net_saving');
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await io.lstat(directory)).isSymbolicLink()) throw new Error('unsafe output store');
    await io.chmod(directory, 0o700);
    // Nonblocking writer lock: optional compression never waits behind another call.
    const lockPath = path.join(directory, '.writer.lock');
    let lock;
    try { lock = await io.open(lockPath, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') return skip('store_busy'); throw error; }
    let temporary;
    try {
      await lock.writeFile(String(process.pid));
      try {
        for (const file of [destination, path.join(destination, 'metadata.json'), path.join(destination, 'original.txt'), chunksPath]) {
          if ((await io.lstat(file)).isSymbolicLink()) throw new Error('unsafe cached artifact');
        }
        const saved = JSON.parse(await io.readFile(path.join(destination, 'metadata.json'), 'utf8'));
        if (saved.digest === hash && saved.projected_chars === projected.length &&
            digest(await io.readFile(path.join(destination, 'original.txt'), 'utf8')) === hash &&
            digest(await io.readFile(chunksPath, 'utf8')) === saved.chunks_digest) return projected;
        return skip('snapshot_conflict');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const entries = await io.readdir(directory, { withFileTypes: true });
      const directories = entries.filter(x => x.isDirectory());
      if (directories.length >= maxRecords) return skip('store_record_limit');
      let used = 0;
      for (const entry of directories) {
        for (const file of await io.readdir(path.join(directory, entry.name))) {
          used += (await io.lstat(path.join(directory, entry.name, file))).size;
        }
      }
      // Native read clamps each line at 2,000 code units. Budget escaped JSON,
      // not raw characters, and iterate code points to retain surrogate pairs.
      const chunks = []; let chunk = '', encodedLength = 2;
      for (const character of original) {
        const size = JSON.stringify(character).length - 2;
        if (encodedLength + size > 1800) { chunks.push(JSON.stringify(chunk)); chunk = ''; encodedLength = 2; }
        chunk += character; encodedLength += size;
      }
      if (chunk) chunks.push(JSON.stringify(chunk));
      const chunkText = chunks.join('\n') + '\n';
      const metadata = JSON.stringify({ version: 1, reference, session_id: event.sessionID, created_ms: Date.now(),
        strategy: compacted.strategy, digest: hash, chunks_digest: digest(chunkText), original_chars: original.length, projected_chars: projected.length });
      const bytes = Buffer.byteLength(original) + Buffer.byteLength(chunkText) + Buffer.byteLength(metadata);
      const space = await io.statfs(directory);
      if (used + bytes > maxBytes) return skip('store_byte_limit');
      if (space.bavail * space.bsize < reserveBytes + bytes) return skip('disk_reserve');
      temporary = await io.mkdtemp(path.join(directory, '.pending-'));
      await io.chmod(temporary, 0o700);
      for (const [name, content] of [['original.txt', original], ['chunks.jsonl', chunkText], ['metadata.json', metadata]]) {
        const handle = await io.open(path.join(temporary, name), 'wx', 0o600);
        try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      }
      const pendingDirectory = await io.open(temporary, 'r');
      try { await pendingDirectory.sync(); } finally { await pendingDirectory.close(); }
      await io.rename(temporary, destination); temporary = undefined;
      const parent = await io.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      options.onPublished?.({ sessionID: event.sessionID, chunksPath });
      return projected;
    } finally {
      if (temporary) await io.rm(temporary, { recursive: true, force: true }).catch(() => {});
      await lock.close(); await io.unlink(lockPath).catch(() => {});
    }
  };
}

export async function installContextCompression(ctx, options = {}) {
  if (typeof ctx.tool?.hook !== 'function') return () => {}; // Older runtimes retain native output.
  const diagnostics = options.diagnostics ?? createCompressionDiagnostics();
  const roots = new Map(), mcpNamespaces = new Set();
  const snapshotDirectory = options.snapshotDirectory ?? (options.save ? undefined : statePath('tool-output-store'));
  const isSnapshotRead = requested => typeof requested === 'string' && typeof snapshotDirectory === 'string' &&
    (path.basename(requested) === 'chunks.jsonl' || path.basename(requested) === 'original.txt') &&
    path.dirname(path.dirname(requested)) === snapshotDirectory && /^[a-f0-9]{64}$/.test(path.basename(path.dirname(requested)));
  const save = options.save ?? createOutputStore(snapshotDirectory);
  const controller = new AbortController();
  const observe = event => {
    try { diagnostics?.record?.(event); } catch { /* Telemetry is never on the result path. */ }
  };
  // Identify MCP registrations from native namespace metadata, never name guesses.
  if (typeof ctx.mcp?.transform === 'function') {
    await ctx.mcp.transform(editor => {
      mcpNamespaces.clear();
      for (const [server] of editor.list()) mcpNamespaces.add(server.replace(/[^a-zA-Z0-9_-]/g, '_'));
    });

  }
  if (typeof ctx.event?.subscribe === 'function') void (async () => {
    try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      const data = event.data;
      if (data?.executed === false && ['session.tool.success', 'session.tool.failed'].includes(event.type)) {
        roots.delete(key({ sessionID: data.sessionID, messageID: data.assistantMessageID, id: data.id }));
      }
    } } catch { /* Observer failure only reduces compression coverage. */ }
  })();
  await ctx.tool.hook('execute.before', event => {
    const id = key(event), current = roots.get(id);
    if (current) { current.depth++; return; }
    // Bounded tracking. When busy, skip new roots instead of evicting active ones.
    if (roots.size < 2048) roots.set(id, { tool: event.tool, depth: 1 });
  });
  await ctx.tool.hook('execute.after', async event => {
    const started = Date.now();
    let blockStarted = started;
    const id = key(event), current = roots.get(id);
    if (event.tool === 'read' && event.status === 'completed' && isSnapshotRead(event.input?.path)) {
      observe({ type: 'native_original_retrieval', sessionID: event.sessionID });
    }
    if (!current) { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'missing_root_tracking', processingMs: Date.now() - started }); return; }
    if (--current.depth > 0) return; // CodeMode leaves must keep even fallback text untouched.
    roots.delete(id);
    if (current.tool !== event.tool) { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'tool_changed', processingMs: Date.now() - started }); return; }
    if (event.status !== 'completed') { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'not_completed', processingMs: Date.now() - started }); return; }
    try {
      let kind = compressionKind(event);
      if (!kind && mcpNamespaces.size && typeof ctx.tool.list === 'function') {
        // Consult the settled catalog: MCP transforms may register after ours,
        // and reconnects can replace tools without re-running plugin setup.
        const tools = await ctx.tool.list();
        const nativeMcp = tools.some(tool => mcpNamespaces.has(tool.options?.namespace) &&
          `${tool.options.namespace}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_')}` === event.tool);
        if (nativeMcp) kind = 'json';
      }
      if (!kind) { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'unsupported_tool', processingMs: Date.now() - started }); return; }
      const content = event.result.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      if (!Array.isArray(blocks)) { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'non_text_content', processingMs: Date.now() - started }); return; }
      const next = [];
      for (let index = 0; index < blocks.length; index++) {
        if (index > 0) blockStarted = Date.now();
        const block = blocks[index];
        if (block?.type !== 'text' || typeof block.text !== 'string') { next.push(block); continue; }
        if (block.text.includes(marker)) { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'already_projected', processingMs: Date.now() - blockStarted }); next.push(block); continue; }
        let excluded;
        if (block.text.length < 4096) excluded = 'below_minimum';
        else if (Buffer.byteLength(block.text) > 1024 * 1024) excluded = 'input_over_budget';
        else if (Buffer.from(block.text,'utf8').toString('utf8') !== block.text) excluded = 'invalid_unicode';
        if (excluded) { observe({ type:'candidate', sessionID:event.sessionID, reason:excluded, processingMs:Date.now()-blockStarted, originalChars:block.text.length }); next.push(block); continue; }
        const compacted = compactToolText(block.text, kind);
        if (!compacted) { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'no_useful_projection', processingMs: Date.now() - blockStarted, originalChars: block.text.length }); next.push(block); continue; }
        let skipReason = 'store_not_published';
        const text = await save(event, index, block.text, compacted, reason => { skipReason = reason; });
        if (text) {
          observe({ type: 'candidate', sessionID: event.sessionID, reason: 'prepared', processingMs: Date.now() - blockStarted, originalChars: block.text.length, projectedChars: text.length, strategy: compacted.strategy });
        } else observe({ type: 'candidate', sessionID: event.sessionID, reason: skipReason, processingMs: Date.now() - blockStarted, originalChars: block.text.length, strategy: compacted.strategy });
        next.push(text ? { ...block, text } : block);
      }
      event.result = { ...event.result, content: typeof content === 'string' ? next[0].text : next };
    } catch { observe({ type: 'candidate', sessionID: event.sessionID, reason: 'processing_failed', processingMs: Date.now() - blockStarted }); /* Optional optimization fails open to the original result, not to provider fallback. */ }
  });
  return () => { controller.abort(); roots.clear(); };
}
