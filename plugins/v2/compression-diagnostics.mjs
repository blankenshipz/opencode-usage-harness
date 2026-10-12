// Best-effort, metadata-only observations for local context compression.
// This file intentionally never persists tool input, output, paths, prompts, or
// content digests. Diagnostics must not affect the compression result.
import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath } from './paths.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 256;

export function createCompressionDiagnostics(file = statePath('telemetry/compression-diagnostics.jsonl'), options = {}) {
  const io = options.io ?? fs;
  let disabled = false;
  let pending = 0;
  let tail = Promise.resolve();
  const append = async event => {
    try {
      if (disabled) return;
      // Construct an allowlisted record instead of serializing the caller's event.
      const record = {
        version: 1,
        type: event.type,
        session_id: event.sessionID,
        created_ms: Date.now(),
      };
      if (typeof event.reason === 'string') record.reason = event.reason;
      if (Number.isSafeInteger(event.processingMs) && event.processingMs >= 0) record.processing_ms = event.processingMs;
      if (Number.isSafeInteger(event.originalChars) && event.originalChars >= 0) record.original_chars = event.originalChars;
      if (Number.isSafeInteger(event.projectedChars) && event.projectedChars >= 0) record.projected_chars = event.projectedChars;
      if (typeof event.strategy === 'string') record.strategy = event.strategy;
      // A tokenizer is deliberately not selected from model/provider metadata.
      record.token_estimate = { status: 'unavailable', reason: 'no-model-specific-tokenizer' };
      await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const stat = await io.lstat(file).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error));
      if (stat?.isSymbolicLink() || stat?.isFile() === false) { disabled = true; return; }
      if (stat) await io.chmod(file, 0o600);
      const line = `${JSON.stringify(record)}\n`;
      if (stat && (stat.size + Buffer.byteLength(line)) > (options.maxBytes ?? MAX_BYTES)) {
        await io.rename(file, `${file}.1`);
      }
      await io.appendFile(file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    } catch { disabled = true; } finally { pending--; }
  };
  return { flush: () => tail, record: event => {
    if (disabled || pending >= (options.maxPending ?? MAX_PENDING)) return;
    pending++;
    tail = tail.then(() => append(event), () => append(event));
  } };
}
