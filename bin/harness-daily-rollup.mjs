#!/usr/bin/env node
// Daily rollup of harness telemetry: task outcomes, review verdicts, commits and quota points.
// Usage: harness-daily-rollup.mjs [--date YYYY-MM-DD] [--repo DIR]... [--state DIR]
// Writes $HARNESS_STATE_DIR/telemetry/daily-rollup-<date>.json (0600) and prints its path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SECRET = /header_value|hmac|token|secret|authorization|api_?key/i;

function parseArgs(argv) {
  const out = { repos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--repo') out.repos.push(argv[++i]);
    else if (a === '--state') out.state = argv[++i];
  }
  return out;
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function dayBounds(date) {
  const [y, m, d] = date.split('-').map(Number);
  return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').flatMap(l => { try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; } });
  } catch { return []; }
}

const tsOf = r => {
  for (const k of ['at', 'ts', 'timestamp', 'time', 'recorded_at', 'checked_at', 'created_at', 'ended_at']) {
    const v = r?.[k];
    const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
};

function count(list, key) {
  const out = {};
  for (const r of list) { const k = String(key(r) ?? 'unknown'); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

// Strip secret-looking keys anywhere in a value.
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, scrub(x)]));
  return v;
}

function quotaFiles(state) {
  const files = [];
  for (const dir of ['quota-cache', 'quota'].map(d => path.join(state, d))) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const e of entries) if (/\.jsonl?$/.test(e)) files.push(path.join(dir, e));
  }
  return files;
}

// Collect {t, provider, used} points from quota cache snapshots (pools[...].windows or windows).
function quotaPoints(state, start, end) {
  const pts = [];
  const visit = (snap, fallbackT) => {
    const t = tsOf(snap) ?? fallbackT;
    if (!Number.isFinite(t) || t < start || t >= end) return;
    const pools = snap?.pools ?? (snap?.windows ? { [snap.provider ?? 'default']: snap } : {});
    for (const [provider, pool] of Object.entries(pools)) {
      const pt = tsOf(pool) ?? t;
      if (pt < start || pt >= end) continue;
      for (const w of pool?.windows ?? []) {
        if (!Number.isFinite(w?.used_percent)) continue;
        if (Number.isFinite(w.duration_minutes) && w.duration_minutes < 10080) continue;
        pts.push({ t: pt, key: `${provider}/${w.scope ?? 'account'}`, used: w.used_percent });
      }
    }
  };
  for (const f of quotaFiles(state)) {
    let mtime; try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    if (f.endsWith('.jsonl')) for (const r of readJsonl(f)) visit(r, mtime);
    else { try { visit(JSON.parse(fs.readFileSync(f, 'utf8')), mtime); } catch { /* ignore */ } }
  }
  const out = {};
  for (const p of pts.sort((a, b) => a.t - b.t)) {
    const o = out[p.key] ??= { start: p.used, end: p.used, startAt: new Date(p.t).toISOString() };
    o.end = p.used; o.endAt = new Date(p.t).toISOString(); o.delta = +(o.end - o.start).toFixed(2);
  }
  return out;
}

function defaultRepos() {
  const root = path.join(os.homedir(), 'work');
  try { return fs.readdirSync(root).map(d => path.join(root, d)).filter(d => fs.existsSync(path.join(d, '.git'))); } catch { return []; }
}

function commits(repos, start, end) {
  const out = {};
  for (const repo of repos) {
    try {
      const log = execFileSync('git', ['-C', repo, 'log', '--all', `--since=${new Date(start).toISOString()}`, `--until=${new Date(end).toISOString()}`, '--format=%H%x09%an%x09%s'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      out[path.basename(path.resolve(repo))] = new Set(log.split('\n').filter(Boolean).map(l => l.split('\t')[0])).size;
    } catch { out[path.basename(path.resolve(repo))] = null; }
  }
  return out;
}

export function rollup({ state, date, repos }) {
  const [start, end] = dayBounds(date);
  const tel = path.join(state, 'telemetry');
  const inDay = r => { const t = tsOf(r); return t !== undefined && t >= start && t < end; };
  const tasks = readJsonl(path.join(tel, 'task-outcomes.jsonl')).filter(inDay);
  const verdicts = [path.join(tel, 'review-verdicts.jsonl'), path.join(state, 'review-verdicts.jsonl')].flatMap(readJsonl).filter(inDay);
  return scrub({
    date,
    tasks: { total: tasks.length, byStatus: count(tasks, r => r.status ?? r.outcome), bySource: count(tasks, r => r.source) },
    verdicts: { total: verdicts.length, byVerdict: count(verdicts, r => r.verdict ?? r.status ?? r.outcome) },
    commits: commits(repos, start, end),
    quotaPoints: quotaPoints(state, start, end),
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('harness-daily-rollup.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  const state = args.state ?? process.env.HARNESS_STATE_DIR ?? path.join(os.homedir(), 'work', 'ocharness', 'state');
  const date = args.date ?? localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('harness-daily-rollup: --date must be YYYY-MM-DD'); process.exit(2); }
  const summary = rollup({ state, date, repos: args.repos.length ? args.repos : defaultRepos() });
  const dir = path.join(state, 'telemetry');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = path.join(dir, `daily-rollup-${date}.json`);
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(out, 0o600);
  console.log(out);
}
