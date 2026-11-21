// r30: shared configuration and telemetry for the four token-saving strategies.
//
//   K cacheKeep           never switch the model of a warm or running child mid-task
//   B parentCacheTtl      1h prompt-cache TTL for router/coordinator requests
//   A observationMasking  batched clearing of old tool results with recoverable originals
//   C effort              reasoning effort from routing complexity (no model change)
//
// Configuration: optional <state>/config/token-saving.json (hot-reloaded by
// mtime/size) merged over the defaults below. Environment kill switches (read
// at call time): HARNESS_TOKEN_SAVING=off disables all four;
// HARNESS_CACHE_KEEP, HARNESS_PARENT_CACHE_TTL, HARNESS_OBSERVATION_MASKING and
// HARNESS_EFFORT_MAP =off disable one. An invalid file is ignored (defaults
// apply) and reported once in telemetry; it never blocks a model step.
import fs from 'node:fs';
import path from 'node:path';
import { managedConfigRoot, statePath } from './paths.mjs';

export const TOKEN_SAVING_DEFAULTS = Object.freeze({
  cacheKeep: Object.freeze({ enabled: true, warmMs: 5 * 60_000, parentWarmMs: 60 * 60_000, rerouteAfterCompaction: true }),
  parentCacheTtl: Object.freeze({ enabled: true, ttlSeconds: 3600, roles: Object.freeze(['router', 'coordinator']) }),
  observationMasking: Object.freeze({ enabled: true, triggerTokens: 80_000, minBatchTokens: 30_000, keepRecentTurns: 8, minResultChars: 1200 }),
  effort: Object.freeze({
    enabled: true,
    roles: Object.freeze({ scout: 'low', 'quick-builder': 'low' }),
    tiers: Object.freeze({ STRONG: 'high', MAXIMUM: 'high' }),
    // `standard` is unmapped by default: it keeps the role's configured effort.
    complexity: Object.freeze({ routine: 'low', complex: 'high' }),
  }),
});
const SECTIONS = Object.keys(TOKEN_SAVING_DEFAULTS);
const ENV = { cacheKeep: 'HARNESS_CACHE_KEEP', parentCacheTtl: 'HARNESS_PARENT_CACHE_TTL', observationMasking: 'HARNESS_OBSERVATION_MASKING', effort: 'HARNESS_EFFORT_MAP' };
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const off = v => ['off', '0', 'false', 'no'].includes(String(v ?? '').trim().toLowerCase());
const posInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

function effortMap(value, keys) {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([k, v]) => (!keys || keys.includes(k)) && EFFORTS.has(v));
}
// Strict per-field validation; one bad section falls back to its defaults.
function validSection(name, value) {
  if (!isRecord(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return false;
  switch (name) {
    case 'cacheKeep':
      return (value.warmMs === undefined || posInt(value.warmMs, 0, 24 * 3600_000))
        && (value.parentWarmMs === undefined || posInt(value.parentWarmMs, 0, 24 * 3600_000))
        && (value.rerouteAfterCompaction === undefined || typeof value.rerouteAfterCompaction === 'boolean');
    case 'parentCacheTtl':
      return (value.ttlSeconds === undefined || [300, 3600].includes(value.ttlSeconds))
        && (value.roles === undefined || (Array.isArray(value.roles) && value.roles.every(r => typeof r === 'string' && r.length <= 64)));
    case 'observationMasking':
      return (value.triggerTokens === undefined || posInt(value.triggerTokens, 10_000, 2_000_000))
        && (value.minBatchTokens === undefined || posInt(value.minBatchTokens, 1_000, 1_000_000))
        && (value.keepRecentTurns === undefined || posInt(value.keepRecentTurns, 1, 500))
        && (value.minResultChars === undefined || posInt(value.minResultChars, 400, 1_000_000));
    case 'effort':
      return (value.roles === undefined || effortMap(value.roles))
        && (value.tiers === undefined || effortMap(value.tiers, ['FAST', 'BALANCED', 'STRONG', 'MAXIMUM']))
        && (value.complexity === undefined || effortMap(value.complexity, ['routine', 'standard', 'complex']));
  }
  return false;
}

export function mergeTokenSavingConfig(raw, env = process.env) {
  const out = {}, invalid = [];
  const all = off(env?.HARNESS_TOKEN_SAVING);
  for (const name of SECTIONS) {
    const base = TOKEN_SAVING_DEFAULTS[name];
    let section = { ...base };
    const given = isRecord(raw) ? raw[name] : undefined;
    if (given !== undefined) {
      if (validSection(name, given)) section = name === 'effort'
        ? { ...base, ...given, roles: { ...base.roles, ...(given.roles ?? {}) }, tiers: { ...base.tiers, ...(given.tiers ?? {}) }, complexity: { ...base.complexity, ...(given.complexity ?? {}) } }
        : { ...base, ...given };
      else invalid.push(name);
    }
    if (all || off(env?.[ENV[name]])) section.enabled = false;
    out[name] = section;
  }
  if (raw !== undefined && !isRecord(raw)) invalid.push('root');
  return { ...out, invalid };
}

let cache;
export function loadTokenSavingConfig({ file = path.join(managedConfigRoot, 'token-saving.json'), env = process.env, stat = fs.statSync, readFile = fs.readFileSync } = {}) {
  let key = `${file}:absent`, raw;
  try { const info = stat(file); key = `${file}:${info.mtimeMs}:${info.size}`; } catch { /* absent: defaults */ }
  if (cache?.key !== key) {
    if (!key.endsWith(':absent')) {
      try { raw = JSON.parse(readFile(file, 'utf8')); } catch { raw = null; }
    }
    cache = { key, raw };
  }
  const config = mergeTokenSavingConfig(cache.raw === null ? {} : cache.raw, env);
  if (cache.raw === null) config.invalid.push('unreadable');
  if (config.invalid.length) logOnce(`config-invalid:${key}`, { event: 'config_invalid', sections: config.invalid });
  return config;
}

// Bounded, best-effort JSONL. Never throws, never blocks a model step for long.
const TELEMETRY_MAX_BYTES = 8 * 1024 * 1024;
let sink = record => {
  try {
    const file = statePath('telemetry', 'token-saving.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let size = 0; try { size = fs.statSync(file).size; } catch {}
    if (size >= TELEMETRY_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch { /* telemetry is optional */ }
};
export function setTokenSavingSink(fn) { const previous = sink; sink = fn; return previous; }
export function logTokenSaving(record) {
  try { sink({ version: 1, at: new Date().toISOString(), ...record }); } catch {}
}
const once = new Set();
export function logOnce(key, record) {
  if (once.has(key)) return false;
  if (once.size > 4096) once.clear();
  once.add(key);
  logTokenSaving(record);
  return true;
}
export function resetTokenSavingState() { cache = undefined; once.clear(); }

// r32 item 2: the 1h parent-TTL circuit breaker, shared by every plugin instance in
// the process (parent-cache-ttl trips it; dispatch-routing's 1h warm window reads it)
// and persisted for `holdMs`, so a restart or hot reload does not send another
// request the provider already rejected. While tripped, parents use the default
// 5m TTL and the 5m warm window; the fallback is logged once per trip.
// Reset by deleting <state>/token-saving/ttl-breaker.json (it also expires).
export const TTL_BREAKER_HOLD_MS = 24 * 3600_000;
export function createTtlBreaker({ file = statePath('token-saving', 'ttl-breaker.json'), holdMs = TTL_BREAKER_HOLD_MS, now = Date.now,
  log = logTokenSaving, io = fs } = {}) {
  let tripped, persisted = false, cacheKey, cacheValue, logged = false;
  const read = () => {
    let key = 'absent';
    try { const info = io.statSync(file); key = `${info.mtimeMs}:${info.size}`; } catch {}
    if (key !== cacheKey) {
      cacheKey = key; cacheValue = undefined;
      if (key !== 'absent') {
        try {
          const value = JSON.parse(io.readFileSync(file, 'utf8'));
          if (Number.isFinite(value?.at) && typeof value.reason === 'string') cacheValue = { at: value.at, reason: value.reason.slice(0, 64) };
        } catch { /* unreadable: ignore */ }
      }
    }
    return cacheValue;
  };
  const fallback = state => {
    if (logged) return;
    logged = true;
    try { log({ event: 'parent_cache_ttl_fallback', reason: state.reason, ttl: '5m', warmMs: TOKEN_SAVING_DEFAULTS.cacheKeep.warmMs, until: new Date(state.at + holdMs).toISOString() }); } catch {}
  };
  return {
    // The current trip, or undefined. Expired trips are ignored.
    state() {
      const onDisk = read();
      // Fable r32 #4: a persisted trip whose file was deleted is reset (operator reset).
      if (tripped && persisted && !onDisk) { tripped = undefined; persisted = false; logged = false; }
      const current = tripped ?? onDisk;
      if (!current || now() - current.at >= holdMs) { if (tripped && now() - tripped.at >= holdMs) { tripped = undefined; logged = false; } return undefined; }
      fallback(current); // a persisted trip seen by a new process also logs the fallback once
      return current;
    },
    trip(reason) {
      if (this.state()) return false;
      tripped = { at: now(), reason: String(reason).slice(0, 64) };
      logged = false; persisted = false;
      try {
        io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        io.writeFileSync(temporary, JSON.stringify({ version: 1, ...tripped }), { mode: 0o600 });
        io.renameSync(temporary, file);
        persisted = true;
      } catch { /* in-process trip still applies */ }
      fallback(tripped);
      return true;
    },
  };
}
let sharedBreaker;
export function parentTtlBreaker() { return (sharedBreaker ??= createTtlBreaker()); }
export function setParentTtlBreaker(value) { const previous = sharedBreaker; sharedBreaker = value; return previous; }
