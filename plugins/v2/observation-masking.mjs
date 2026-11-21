// r30 item A: batched observation masking (client-side context editing).
//
// Once a session's prepared context passes `triggerTokens`, old tool RESULTS
// (never the tool calls, never results inside the last `keepRecentTurns`
// assistant turns, never harness control records) are replaced by a short
// placeholder that points to the saved original in the tool-output store.
// Clearing happens in batches of at least `minBatchTokens`, so the cached
// prefix is rewritten rarely; the masked set is remembered per session and
// re-applied byte-identically on every later request, so between batches the
// prefix is stable. Originals are saved before a result is masked; a result
// whose original cannot be saved stays verbatim.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { statePath } from './paths.mjs';
import { isNativeAgent } from './agent-mode.mjs';
import { PROTECTED_TOOLS } from './context-compression.mjs';
import { loadTokenSavingConfig, logTokenSaving } from './token-saving.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const CHARS_PER_TOKEN = 4;
const MAX_MASKED_PER_SESSION = 5000;
const MAX_STORE_BYTES = 256 * 1024 * 1024;
// `read` results are the main target; every other protected control record stays.
export const MASK_PROTECTED_TOOLS = new Set([...PROTECTED_TOOLS].filter(name => name !== 'read').concat(['review_verdict', 'check_rerun']));
// Fable r30 #1: only the harness compression marker at the END of the text, pointing
// inside the tool-output store, is trusted; anything else gets its own saved original.
const EXISTING_ORIGINAL = /\[harness compacted [^\]]*Original: native read (\S+\/chunks\.jsonl) offset=1 limit=3;[^\]]*\]\s*$/;
export function trustedExistingOriginal(text, storeRoot = statePath('tool-output-store')) {
  const found = typeof text === 'string' ? text.match(EXISTING_ORIGINAL)?.[1] : undefined;
  if (!found) return undefined;
  const relative = path.relative(storeRoot, path.resolve(found));
  return /^[a-f0-9]{64}\/chunks\.jsonl$/.test(relative.split(path.sep).join('/')) ? found : undefined;
}

export function resultText(result) {
  if (!result || typeof result !== 'object') return undefined;
  if (result.type === 'text') return typeof result.value === 'string' ? result.value : JSON.stringify(result.value ?? null);
  if (result.type === 'json') { try { return JSON.stringify(result.value ?? null); } catch { return undefined; } }
  if (result.type === 'content' && Array.isArray(result.value)) {
    if (result.value.some(item => item?.type !== 'text')) return undefined; // media stays
    return result.value.map(item => item.text ?? '').join('\n');
  }
  return undefined; // errors stay verbatim
}
const partChars = part => {
  if (!part || typeof part !== 'object') return typeof part === 'string' ? part.length : 0;
  if (typeof part.text === 'string') return part.text.length;
  if (part.type === 'tool-result') return resultText(part.result)?.length ?? 0;
  if (part.type === 'tool-call') { try { return JSON.stringify(part.input ?? null).length; } catch { return 0; } }
  return 0;
};
export function estimateTokens(event) {
  let chars = 0;
  for (const part of Array.isArray(event.system) ? event.system : []) chars += partChars(part);
  for (const message of event.messages ?? []) {
    if (typeof message?.content === 'string') chars += message.content.length;
    else for (const part of Array.isArray(message?.content) ? message.content : []) chars += partChars(part);
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
// Index of the first message inside the protected recent window.
export function protectionBoundary(messages, keepRecentTurns) {
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'assistant' && ++seen >= keepRecentTurns) return index;
  }
  return 0; // fewer turns than the window: everything is protected
}
export function placeholderText({ name, input, chars, chunksPath }) {
  let digest = 'none';
  try { digest = sha(JSON.stringify(input ?? null)).slice(0, 12); } catch {}
  return `[harness cleared old tool result: ${name} call ${digest}; ${chars} chars. Original: native read ${chunksPath} offset=1 limit=3; strip "N: " prefixes, JSON-decode each line, concatenate. Snapshot, not current state; re-run the tool for fresh output.]`;
}

export function createMaskStore(directory = statePath('tool-output-store', 'masked'), { io = fs, maxBytes = MAX_STORE_BYTES } = {}) {
  let used;
  return async ({ sessionID, id, text }) => {
    const reference = sha(JSON.stringify([sessionID, id, sha(text)]));
    const destination = path.join(directory, reference);
    const chunksPath = path.join(destination, 'chunks.jsonl');
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await io.lstat(directory)).isSymbolicLink()) throw new Error('unsafe mask store');
    try { if ((await io.lstat(chunksPath)).isFile()) return chunksPath; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (used === undefined) {
      used = 0;
      for (const entry of await io.readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const file of await io.readdir(path.join(directory, entry.name))) used += (await io.lstat(path.join(directory, entry.name, file))).size;
      }
    }
    // Same chunk format as context-compression (lines below native read's clamp).
    const chunks = []; let chunk = '', encoded = 2;
    for (const character of text) {
      const size = JSON.stringify(character).length - 2;
      if (encoded + size > 1800) { chunks.push(JSON.stringify(chunk)); chunk = ''; encoded = 2; }
      chunk += character; encoded += size;
    }
    if (chunk || !chunks.length) chunks.push(JSON.stringify(chunk));
    const chunkText = chunks.join('\n') + '\n';
    const metadata = JSON.stringify({ version: 1, kind: 'observation_mask', reference, session_id: sessionID, created_ms: Date.now(), digest: sha(text), original_chars: text.length });
    const bytes = Buffer.byteLength(text) + Buffer.byteLength(chunkText) + Buffer.byteLength(metadata);
    if (used + bytes > maxBytes) return undefined;
    const temporary = await io.mkdtemp(path.join(directory, '.pending-'));
    try {
      await io.chmod(temporary, 0o700);
      for (const [name, content] of [['original.txt', text], ['chunks.jsonl', chunkText], ['metadata.json', metadata]])
        await io.writeFile(path.join(temporary, name), content, { mode: 0o600, flag: 'wx' });
      await io.rename(temporary, destination);
    } catch (error) {
      await io.rm(temporary, { recursive: true, force: true }).catch(() => {});
      try { if ((await io.lstat(chunksPath)).isFile()) return chunksPath; } catch {}
      throw error;
    }
    used += bytes;
    return chunksPath;
  };
}

function createStateStore(directory = statePath('observation-masking'), io = fs) {
  const file = sessionID => path.join(directory, `${sha(String(sessionID)).slice(0, 32)}.json`);
  return {
    async load(sessionID) {
      try {
        const value = JSON.parse(await io.readFile(file(sessionID), 'utf8'));
        return value?.version === 1 && value.masked && typeof value.masked === 'object' ? new Map(Object.entries(value.masked).filter(([, v]) => typeof v === 'string')) : new Map();
      } catch { return new Map(); }
    },
    async save(sessionID, masked) {
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = file(sessionID), temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await io.writeFile(temporary, JSON.stringify({ version: 1, masked: Object.fromEntries(masked) }), { mode: 0o600 });
      await io.rename(temporary, target);
    },
  };
}

function replaceMessage(message, content) {
  const Ctor = message && message.constructor !== Object ? message.constructor : undefined;
  if (Ctor) return new Ctor({ ...message, content });
  return { ...message, content };
}
// Apply the remembered masked set in place. Returns the number of parts replaced.
export function applyMasks(messages, masked) {
  let replaced = 0;
  if (!masked.size) return 0;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!Array.isArray(message?.content) || !message.content.some(p => p?.type === 'tool-result' && masked.has(p.id))) continue;
    let changed = 0;
    const content = message.content.map(part => {
      if (part?.type !== 'tool-result' || !masked.has(part.id)) return part;
      const value = masked.get(part.id);
      if (part.result?.type === 'text' && part.result.value === value) return part;
      changed++;
      return { ...part, result: { type: 'text', value } };
    });
    if (!changed) continue;
    try { messages[index] = replaceMessage(message, content); replaced += changed; } catch { /* leave this message verbatim */ }
  }
  return replaced;
}

// Choose a batch: unmasked, unprotected, large-enough results before the window.
export function planBatch(messages, masked, config) {
  const boundary = protectionBoundary(messages, config.keepRecentTurns);
  const calls = new Map();
  for (const message of messages) for (const part of Array.isArray(message?.content) ? message.content : []) if (part?.type === 'tool-call') calls.set(part.id, part);
  const candidates = [];
  for (let index = 0; index < boundary; index++) {
    for (const part of Array.isArray(messages[index]?.content) ? messages[index].content : []) {
      if (part?.type !== 'tool-result' || typeof part.id !== 'string' || masked.has(part.id) || part.providerExecuted) continue;
      const name = part.name ?? calls.get(part.id)?.name;
      if (!name || MASK_PROTECTED_TOOLS.has(name) || /^task_/.test(name)) continue;
      const text = resultText(part.result);
      if (text === undefined || text.length < config.minResultChars) continue;
      candidates.push({ id: part.id, name, input: calls.get(part.id)?.input, text });
    }
  }
  return candidates;
}

export async function installObservationMasking(ctx, { loadConfig = loadTokenSavingConfig, log = logTokenSaving, saveOriginal = createMaskStore(),
  state = createStateStore(), onBatch = () => {}, storeRoot = statePath('tool-output-store') } = {}) {
  if (typeof ctx?.session?.hook !== 'function') return () => {};
  const sessions = new Map(); // sessionID -> Map(id -> placeholder)
  let stopped = false;
  const masksFor = async sessionID => {
    let masked = sessions.get(sessionID);
    if (!masked) {
      masked = await state.load(sessionID);
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionID, masked);
    }
    return masked;
  };
  await ctx.session.hook('context', async event => {
    if (stopped || !Array.isArray(event?.messages) || typeof event.sessionID !== 'string' || isNativeAgent(event.agent)) return;
    try {
      const config = loadConfig().observationMasking;
      if (!config.enabled) return;
      const masked = await masksFor(event.sessionID);
      applyMasks(event.messages, masked); // keep earlier batches byte-identical
      const tokens = estimateTokens(event);
      if (tokens < config.triggerTokens || masked.size >= MAX_MASKED_PER_SESSION) return;
      const candidates = planBatch(event.messages, masked, config);
      const estimate = candidates.reduce((sum, c) => sum + Math.max(0, c.text.length - 320), 0) / CHARS_PER_TOKEN;
      if (estimate < config.minBatchTokens) return;
      const batch = new Map();
      let savedChars = 0;
      for (const candidate of candidates) {
        let chunksPath = trustedExistingOriginal(candidate.text, storeRoot);
        if (!chunksPath) {
          try { chunksPath = await saveOriginal({ sessionID: event.sessionID, id: candidate.id, text: candidate.text }); }
          catch { chunksPath = undefined; }
        }
        if (!chunksPath) continue; // unrecoverable: keep verbatim
        const placeholder = placeholderText({ name: candidate.name, input: candidate.input, chars: candidate.text.length, chunksPath });
        if (placeholder.length >= candidate.text.length) continue;
        batch.set(candidate.id, placeholder);
        savedChars += candidate.text.length - placeholder.length;
      }
      // Re-check after saving: a partial batch below the minimum is not worth a cache reset.
      if (!batch.size || savedChars / CHARS_PER_TOKEN < config.minBatchTokens) return;
      for (const [id, placeholder] of batch) masked.set(id, placeholder);
      applyMasks(event.messages, masked);
      try { await state.save(event.sessionID, masked); } catch { /* in-memory set still applies */ }
      try { onBatch(event.sessionID); } catch {}
      log({ event: 'observation_mask_batch', session: event.sessionID, agent: event.agent, results: batch.size,
        tokensBefore: tokens, tokensCleared: Math.round(savedChars / CHARS_PER_TOKEN), maskedTotal: masked.size });
    } catch (error) {
      try { log({ event: 'observation_mask_error', session: event.sessionID, error: String(error?.message ?? error).slice(0, 200) }); } catch {}
    }
  });
  // Fable r30 #2: the native compaction request must see the same masked prefix (apply only, no new batch).
  await ctx.session.hook('compaction', async event => {
    if (stopped || !Array.isArray(event?.messages) || typeof event.sessionID !== 'string' || isNativeAgent(event.agent)) return;
    try { if (loadConfig().observationMasking.enabled) applyMasks(event.messages, await masksFor(event.sessionID)); } catch { /* never block compaction */ }
  });
  return () => { stopped = true; sessions.clear(); };
}
