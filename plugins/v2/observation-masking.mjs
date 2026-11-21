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
import { loadTokenSavingConfig, logOnce, logTokenSaving } from './token-saving.mjs';

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const CHARS_PER_TOKEN = 4;
export const MAX_MASKED_PER_SESSION = 5000;
export const MAX_STORE_BYTES = 256 * 1024 * 1024;
// r32: pruning. The unit of eviction is a whole session (its state file and all
// its originals), so a placeholder still in a live context never loses its original.
export const PRUNE_DEFAULTS = Object.freeze({
  maxIdleMs: 7 * 24 * 3600_000,      // a session untouched this long is evicted
  minIdleMs: 6 * 3600_000,           // size pressure never evicts a session active more recently
  highWaterBytes: Math.floor(MAX_STORE_BYTES * 0.75),
  lowWaterBytes: Math.floor(MAX_STORE_BYTES * 0.5),
  pendingMaxAgeMs: 3600_000,         // abandoned .pending-* temp dirs
  intervalMs: 6 * 3600_000,
});
const TOUCH_INTERVAL_MS = 10 * 60_000;
export const sessionStateName = sessionID => `${sha(String(sessionID)).slice(0, 32)}.json`;
export class MaskStoreFullError extends Error {
  constructor() { super('observation mask store is full'); this.code = 'MASK_STORE_FULL'; }
}
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

export function createMaskStore(directory = statePath('tool-output-store', 'masked'), { io = fs, maxBytes = MAX_STORE_BYTES, now = Date.now, recountMs = 10 * 60_000 } = {}) {
  let used, countedAt = 0;
  const count = async () => {
    used = 0; countedAt = now();
    for (const entry of await io.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const file of await io.readdir(path.join(directory, entry.name)).catch(() => [])) {
        try { used += (await io.lstat(path.join(directory, entry.name, file))).size; } catch {}
      }
    }
  };
  const save = async ({ sessionID, id, text }) => {
    const reference = sha(JSON.stringify([sessionID, id, sha(text)]));
    const destination = path.join(directory, reference);
    const chunksPath = path.join(destination, 'chunks.jsonl');
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await io.lstat(directory)).isSymbolicLink()) throw new Error('unsafe mask store');
    try { if ((await io.lstat(chunksPath)).isFile()) return chunksPath; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (used === undefined) await count();
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
    // Fable r32 #2: a prune by another plugin instance frees space this count cannot see.
    if (used + bytes > maxBytes && now() - countedAt >= recountMs) await count();
    if (used + bytes > maxBytes) throw new MaskStoreFullError();
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
  save.directory = directory;
  save.resetUsage = () => { used = undefined; }; // after a prune, recount on the next save
  return save;
}

async function treeBytes(io, directory) {
  let total = 0;
  for (const name of await io.readdir(directory).catch(() => [])) {
    try { const info = await io.lstat(path.join(directory, name)); if (info.isFile()) total += info.size; } catch {}
  }
  return total;
}
// r32: prune the masked-original store and the per-session mask state.
// 1. abandoned `.pending-*` temp dirs older than pendingMaxAgeMs;
// 2. sessions idle (state mtime, refreshed while the session is used) longer than maxIdleMs;
// 3. originals with no state file (orphans) older than maxIdleMs;
// 4. while the store is above highWaterBytes, the least recently active sessions idle at
//    least minIdleMs, until it is below lowWaterBytes.
// Never removes anything belonging to a session active within minIdleMs.
export async function pruneMaskStore({ maskDir = statePath('tool-output-store', 'masked'), stateDir = statePath('observation-masking'),
  io = fs, now = Date.now(), limits = {} } = {}) {
  const l = { ...PRUNE_DEFAULTS, ...limits };
  const result = { sessions: 0, originals: 0, pending: 0, freedBytes: 0, reasons: {}, remainingBytes: 0 };
  const count = reason => { result.reasons[reason] = (result.reasons[reason] ?? 0) + 1; };
  try { if ((await io.lstat(maskDir)).isSymbolicLink()) return result; } catch { /* absent store: prune state only */ }
  // Session activity from the state files.
  const states = new Map(); // state file name -> mtimeMs
  for (const name of await io.readdir(stateDir).catch(() => [])) {
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    try { states.set(name, (await io.lstat(path.join(stateDir, name))).mtimeMs); } catch {}
  }
  // Originals grouped by owning session.
  const groups = new Map(); // state name -> {entries:[{dir,bytes,created}]}
  let total = 0;
  for (const entry of await io.readdir(maskDir, { withFileTypes: true }).catch(() => [])) {
    const dir = path.join(maskDir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.pending-')) {
      try {
        if (now - (await io.lstat(dir)).mtimeMs > l.pendingMaxAgeMs) { await io.rm(dir, { recursive: true, force: true }); result.pending++; count('pending'); }
      } catch {}
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const bytes = await treeBytes(io, dir);
    let owner, created;
    try {
      const meta = JSON.parse(await io.readFile(path.join(dir, 'metadata.json'), 'utf8'));
      if (typeof meta?.session_id === 'string') owner = sessionStateName(meta.session_id);
      if (Number.isFinite(meta?.created_ms)) created = meta.created_ms;
    } catch {}
    if (created === undefined) { try { created = (await io.lstat(dir)).mtimeMs; } catch { created = now; } }
    total += bytes;
    const key = owner ?? `orphan:${entry.name}`;
    if (!groups.has(key)) groups.set(key, { owner, entries: [] });
    groups.get(key).entries.push({ dir, bytes, created });
  }
  // Fable r32 #3: re-check activity right before evicting (a session may have resumed since the scan);
  // remove the state file first so a resumed session never keeps pointers to deleted originals.
  const stillIdle = async (group, idleMs) => {
    if (!group.owner) return true;
    try { const mtime = (await io.lstat(path.join(stateDir, group.owner))).mtimeMs; return mtime === states.get(group.owner) && now - mtime >= idleMs; }
    catch (error) { return error?.code === 'ENOENT'; }
  };
  const evict = async (key, group, reason) => {
    if (group.owner) { try { await io.rm(path.join(stateDir, group.owner), { force: true }); } catch { return; } }
    for (const item of group.entries) {
      try { await io.rm(item.dir, { recursive: true, force: true }); result.originals++; result.freedBytes += item.bytes; total -= item.bytes; } catch {}
    }
    if (group.owner) states.delete(group.owner);
    if (group.owner || !group.entries.length) result.sessions++;
    groups.delete(key); count(reason);
  };
  // Last activity of a group: its state mtime, else its newest original.
  const activity = group => group.owner && states.has(group.owner) ? states.get(group.owner) : Math.max(...group.entries.map(e => e.created));
  for (const [key, group] of [...groups]) {
    const last = activity(group);
    if (now - last > l.maxIdleMs && await stillIdle(group, l.maxIdleMs)) await evict(key, group, group.owner && states.has(group.owner) ? 'idle' : 'orphan');
  }
  // Idle state files whose originals are already gone.
  for (const [name, mtime] of states) {
    if (now - mtime > l.maxIdleMs && ![...groups.values()].some(g => g.owner === name)) {
      try { await io.rm(path.join(stateDir, name), { force: true }); result.sessions++; count('idle_state'); } catch {}
    }
  }
  if (total > l.highWaterBytes) {
    const candidates = [...groups].map(([key, group]) => ({ key, group, last: activity(group) }))
      .filter(c => now - c.last >= l.minIdleMs).sort((a, b) => a.last - b.last);
    for (const c of candidates) { if (total <= l.lowWaterBytes) break; if (await stillIdle(c.group, l.minIdleMs)) await evict(c.key, c.group, 'size'); }
  }
  result.remainingBytes = Math.max(0, total);
  return result;
}

export function createStateStore(directory = statePath('observation-masking'), io = fs) {
  const file = sessionID => path.join(directory, sessionStateName(sessionID));
  return {
    directory,
    // Keeps an in-use session from looking idle to the pruner.
    async touch(sessionID) { const at = new Date(); await io.utimes(file(sessionID), at, at); },
    async load(sessionID) {
      let masked;
      try {
        const value = JSON.parse(await io.readFile(file(sessionID), 'utf8'));
        masked = value?.version === 1 && value.masked && typeof value.masked === 'object' ? new Map(Object.entries(value.masked).filter(([, v]) => typeof v === 'string')) : new Map();
      } catch { return new Map(); }
      // Fable r32 #3: a mask whose original was pruned is dropped (the result shows verbatim again).
      for (const [id, placeholder] of masked) {
        const original = placeholder.match(/Original: native read (\S+) offset=1 limit=3;/)?.[1];
        if (!original) continue;
        try { await io.lstat(original); } catch (error) { if (error?.code === 'ENOENT') masked.delete(id); }
      }
      return masked;
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

// Process-wide prune schedule shared by every plugin instance (one per location).
let lastPruneAt = 0, pruning, pruneGeneration = 0; // generation: bumps when a prune evicted sessions
export function resetMaskPruneSchedule() { lastPruneAt = 0; pruning = undefined; }

export async function installObservationMasking(ctx, { loadConfig = loadTokenSavingConfig, log = logTokenSaving, once = logOnce, saveOriginal = createMaskStore(),
  state = createStateStore(), onBatch = () => {}, storeRoot = statePath('tool-output-store'), prune = pruneMaskStore,
  pruneOptions = {}, now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  if (typeof ctx?.session?.hook !== 'function') return () => {};
  const sessions = new Map(); // sessionID -> Map(id -> placeholder)
  const touched = new Map(); // sessionID -> last state touch
  let stopped = false, generation = pruneGeneration;
  // r32: prune at most once per interval per process; a full store asks for an early prune.
  const runPrune = (trigger, { force = false } = {}) => {
    if (stopped || typeof prune !== 'function') return Promise.resolve();
    // Only prune the directories this instance actually writes (an injected store has none).
    if (prune === pruneMaskStore && !(saveOriginal.directory && state.directory)) return Promise.resolve();
    const interval = pruneOptions.limits?.intervalMs ?? PRUNE_DEFAULTS.intervalMs;
    if (pruning || (!force && now() - lastPruneAt < interval) || (force && now() - lastPruneAt < 10 * 60_000)) return pruning ?? Promise.resolve();
    lastPruneAt = now();
    pruning = (async () => {
      try {
        const result = await prune({ ...(state.directory ? { stateDir: state.directory } : {}), ...(saveOriginal.directory ? { maskDir: saveOriginal.directory } : {}), ...pruneOptions, now: now() });
        if (result && (result.sessions || result.originals || result.pending)) {
          saveOriginal.resetUsage?.();
          if (result.sessions || result.originals) pruneGeneration++; // every instance reloads its mask sets from disk
          log({ event: 'observation_mask_pruned', trigger, sessions: result.sessions, originals: result.originals, pending: result.pending,
            freedBytes: result.freedBytes, remainingBytes: result.remainingBytes, reasons: result.reasons });
        }
      } catch (error) {
        try { log({ event: 'observation_mask_prune_error', trigger, error: String(error?.message ?? error).slice(0, 200) }); } catch {}
      } finally { pruning = undefined; }
    })();
    return pruning;
  };
  const pruneTimer = setTimer(() => { void runPrune('interval'); }, Math.max(60_000, Math.floor((pruneOptions.limits?.intervalMs ?? PRUNE_DEFAULTS.intervalMs) / 4)));
  pruneTimer?.unref?.();
  const startup = runPrune('startup');
  const masksFor = async sessionID => {
    if (generation !== pruneGeneration) { generation = pruneGeneration; sessions.clear(); }
    let masked = sessions.get(sessionID);
    if (!masked) {
      masked = await state.load(sessionID);
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
      sessions.set(sessionID, masked);
    }
    return masked;
  };
  const stoppedOnce = (sessionID, agent, reason, detail = {}) => once(`mask-stop:${reason}:${sessionID}`,
    { event: 'observation_mask_stopped', session: sessionID, agent, reason, ...detail });
  await ctx.session.hook('context', async event => {
    if (stopped || !Array.isArray(event?.messages) || typeof event.sessionID !== 'string' || isNativeAgent(event.agent)) return;
    try {
      const config = loadConfig().observationMasking;
      if (!config.enabled) return;
      const masked = await masksFor(event.sessionID);
      applyMasks(event.messages, masked); // keep earlier batches byte-identical
      if (masked.size && now() - (touched.get(event.sessionID) ?? 0) > TOUCH_INTERVAL_MS) {
        if (touched.size >= 512) touched.delete(touched.keys().next().value);
        touched.set(event.sessionID, now());
        try { await state.touch?.(event.sessionID); } catch { /* best effort */ }
      }
      const tokens = estimateTokens(event);
      if (tokens < config.triggerTokens) return;
      if (masked.size >= MAX_MASKED_PER_SESSION) {
        stoppedOnce(event.sessionID, event.agent, 'id_cap', { maskedTotal: masked.size, cap: MAX_MASKED_PER_SESSION, tokensBefore: tokens });
        return;
      }
      const candidates = planBatch(event.messages, masked, config);
      const estimate = candidates.reduce((sum, c) => sum + Math.max(0, c.text.length - 320), 0) / CHARS_PER_TOKEN;
      if (estimate < config.minBatchTokens) return;
      const batch = new Map();
      let savedChars = 0, storeFull = false;
      for (const candidate of candidates) {
        if (masked.size + batch.size >= MAX_MASKED_PER_SESSION) break;
        let chunksPath = trustedExistingOriginal(candidate.text, storeRoot);
        if (!chunksPath) {
          try { chunksPath = await saveOriginal({ sessionID: event.sessionID, id: candidate.id, text: candidate.text }); }
          catch (error) { chunksPath = undefined; if (error?.code === 'MASK_STORE_FULL') storeFull = true; }
        }
        if (!chunksPath) continue; // unrecoverable: keep verbatim
        const placeholder = placeholderText({ name: candidate.name, input: candidate.input, chars: candidate.text.length, chunksPath });
        if (placeholder.length >= candidate.text.length) continue;
        batch.set(candidate.id, placeholder);
        savedChars += candidate.text.length - placeholder.length;
      }
      if (storeFull) {
        stoppedOnce(event.sessionID, event.agent, 'store_cap', { cap: MAX_STORE_BYTES, tokensBefore: tokens, partialResults: batch.size });
        void runPrune('store_full', { force: true });
      }
      // Re-check after saving: a partial batch below the minimum is not worth a cache reset.
      if (!batch.size || savedChars / CHARS_PER_TOKEN < config.minBatchTokens) return;
      for (const [id, placeholder] of batch) masked.set(id, placeholder);
      applyMasks(event.messages, masked);
      try { await state.save(event.sessionID, masked); touched.set(event.sessionID, now()); } catch { /* in-memory set still applies */ }
      try { onBatch(event.sessionID); } catch {}
      const tokensRemoved = Math.round(savedChars / CHARS_PER_TOKEN);
      log({ event: 'observation_mask_batch', session: event.sessionID, agent: event.agent, results: batch.size,
        charsRemoved: savedChars, tokensRemoved, tokensCleared: tokensRemoved, tokensBefore: tokens,
        triggerTokens: config.triggerTokens, minBatchTokens: config.minBatchTokens, keepRecentTurns: config.keepRecentTurns,
        maskedTotal: masked.size });
      if (masked.size >= MAX_MASKED_PER_SESSION) stoppedOnce(event.sessionID, event.agent, 'id_cap', { maskedTotal: masked.size, cap: MAX_MASKED_PER_SESSION, tokensBefore: tokens });
    } catch (error) {
      try { log({ event: 'observation_mask_error', session: event.sessionID, error: String(error?.message ?? error).slice(0, 200) }); } catch {}
    }
  });
  // Fable r30 #2: the native compaction request must see the same masked prefix (apply only, no new batch).
  await ctx.session.hook('compaction', async event => {
    if (stopped || !Array.isArray(event?.messages) || typeof event.sessionID !== 'string' || isNativeAgent(event.agent)) return;
    try { if (loadConfig().observationMasking.enabled) applyMasks(event.messages, await masksFor(event.sessionID)); } catch { /* never block compaction */ }
  });
  const stop = () => { stopped = true; sessions.clear(); touched.clear(); try { clearTimer(pruneTimer); } catch {} };
  stop.startup = startup; // for tests
  return stop;
}
