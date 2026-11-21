#!/usr/bin/env node
// r32: per-day totals of the token-saving telemetry (state/telemetry/token-saving.jsonl
// plus its rotated .1 file): observation-masking savings, mask stops and prunes,
// 1h parent-cache-TTL events (applied, unsupported, breaker trips, fallbacks) and
// Claude auth recovery events. Counts and sizes only; no session content.
//
// Usage: harness-token-saving-report.mjs [--state DIR] [--date YYYY-MM-DD] [--days N] [--json]
// Days are local calendar days (same as harness-daily-rollup). Without --date the
// last N (default 7) days that have events are shown.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const localDate = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function readTokenSavingRecords(state) {
  const base = path.join(state, 'telemetry', 'token-saving.jsonl');
  const out = [];
  for (const file of [`${base}.1`, base]) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* skip */ } }
  }
  return out;
}

const num = v => (Number.isFinite(v) ? v : 0);
// Reason/outcome strings come from a file: only short snake_case keys are kept as-is.
const label = v => (typeof v === 'string' && /^[a-z0-9_.-]{1,48}$/i.test(v) ? v : 'other');
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
function emptyDay() {
  return {
    masking: { batches: 0, results: 0, charsRemoved: 0, estTokensRemoved: 0, sessions: 0, stopped: {}, prunes: 0, prunedSessions: 0, prunedOriginals: 0, prunedBytes: 0, errors: 0 },
    parentTtl: { applied: 0, sessions: 0, unsupported: {}, breakerTrips: 0, fallbacks: 0 },
    auth: { recoveries: {} },
  };
}

// records -> { 'YYYY-MM-DD': summary } (only days with events)
export function summarizeTokenSaving(records) {
  const days = {}, maskSessions = {}, ttlSessions = {};
  for (const r of records) {
    const t = Date.parse(r?.at);
    if (!Number.isFinite(t) || typeof r.event !== 'string') continue;
    const key = localDate(t);
    const d = days[key] ??= emptyDay();
    const m = d.masking, p = d.parentTtl;
    switch (r.event) {
      case 'observation_mask_batch': {
        m.batches++; m.results += num(r.results);
        // 0.3.0 events have only tokensCleared; chars are then estimated from it.
        const tokens = num(r.tokensRemoved ?? r.tokensCleared);
        m.estTokensRemoved += tokens; m.charsRemoved += Number.isFinite(r.charsRemoved) ? r.charsRemoved : tokens * 4;
        if (typeof r.session === 'string') (maskSessions[key] ??= new Set()).add(r.session);
        break;
      }
      case 'observation_mask_stopped': bump(m.stopped, label(r.reason)); break;
      case 'observation_mask_pruned': m.prunes++; m.prunedSessions += num(r.sessions); m.prunedOriginals += num(r.originals); m.prunedBytes += num(r.freedBytes); break;
      case 'observation_mask_error': case 'observation_mask_prune_error': m.errors++; break;
      case 'parent_cache_ttl_applied': p.applied++; if (typeof r.session === 'string') (ttlSessions[key] ??= new Set()).add(r.session); break;
      case 'parent_cache_ttl_unsupported': bump(p.unsupported, label(r.reason)); break;
      case 'parent_cache_ttl_disabled': p.breakerTrips++; break;
      case 'parent_cache_ttl_fallback': p.fallbacks++; break;
      case 'claude_auth_recovery': bump(d.auth.recoveries, label(r.outcome)); break;
      default: break;
    }
  }
  for (const [key, set] of Object.entries(maskSessions)) days[key].masking.sessions = set.size;
  for (const [key, set] of Object.entries(ttlSessions)) days[key].parentTtl.sessions = set.size;
  return Object.fromEntries(Object.entries(days).sort(([a], [b]) => a.localeCompare(b)));
}

export function formatTokenSaving(summary) {
  const lines = [];
  for (const [day, d] of Object.entries(summary)) {
    const m = d.masking, p = d.parentTtl;
    const stops = Object.entries(m.stopped).map(([k, v]) => `${k}=${v}`).join(',') || '-';
    const unsupported = Object.entries(p.unsupported).map(([k, v]) => `${k}=${v}`).join(',') || '-';
    const auth = Object.entries(d.auth.recoveries).map(([k, v]) => `${k}=${v}`).join(',') || '-';
    lines.push(`${day}  masking: ${m.batches} batches, ${m.results} results, ~${m.estTokensRemoved} tokens (${m.charsRemoved} chars) removed, ${m.sessions} sessions; stops ${stops}; prunes ${m.prunes} (${m.prunedSessions} sessions, ${m.prunedBytes} bytes)${m.errors ? `; errors ${m.errors}` : ''}`);
    lines.push(`${' '.repeat(day.length)}  1h ttl:  applied ${p.applied} (${p.sessions} sessions); breaker trips ${p.breakerTrips}; fallbacks ${p.fallbacks}; unsupported ${unsupported}; auth recovery ${auth}`);
  }
  return lines.length ? lines.join('\n') : 'no token-saving events';
}

if (process.argv[1]?.endsWith('harness-token-saving-report.mjs')) {
  const argv = process.argv.slice(2);
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const state = arg('--state') ?? process.env.HARNESS_STATE_DIR ?? path.join(os.homedir(), '.local/state/opencode-usage-harness');
  const date = arg('--date');
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('harness-token-saving-report: --date must be YYYY-MM-DD'); process.exit(2); }
  const daysArg = Number(arg('--days') ?? 7);
  let summary = summarizeTokenSaving(readTokenSavingRecords(state));
  if (date) summary = summary[date] ? { [date]: summary[date] } : {};
  else summary = Object.fromEntries(Object.entries(summary).slice(-Math.max(1, Number.isFinite(daysArg) ? daysArg : 7)));
  console.log(argv.includes('--json') ? JSON.stringify(summary, null, 2) : formatTokenSaving(summary));
}
