#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deduplicateCompletionRecords, readCompletionLedger } from '../plugins/v2/completion-ledger.mjs';

const file = process.argv[2];
if (!file) throw new Error('usage: completion-telemetry-report.mjs <completions.jsonl>');
let malformedLines = 0;
const rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').flatMap(line => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line)]; } catch { malformedLines++; return []; }
}) : [];
const database = process.argv[3] ?? path.join(path.dirname(file), 'completions.sqlite3');
const ledgerRows = existsSync(database) ? readCompletionLedger({ database }) : [];
const report = deduplicateCompletionRecords([...rows, ...ledgerRows]);
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const tokenTotals = report.records.reduce((totals, record) => {
  const tokens = record.tokens && typeof record.tokens === 'object' ? record.tokens : {};
  totals.input += numeric(tokens.uncached_input ?? tokens.input ?? tokens.input_tokens);
  totals.output += numeric(tokens.output ?? tokens.output_tokens);
  totals.reasoning += numeric(tokens.reasoning ?? tokens.reasoning_tokens);
  totals.cache_read += numeric(tokens.cache_read ?? tokens.cacheRead ?? tokens.cache?.read ?? tokens.cache);
  totals.cache_write += numeric(tokens.cache_write ?? tokens.cacheWrite ?? tokens.cache?.write);
  return totals;
}, { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 });
process.stdout.write(JSON.stringify({ source: file, ledger: existsSync(database) ? database : null,
  rows: rows.length, ledgerRows: ledgerRows.length, unique: report.records.length,
  duplicates: report.duplicateCount, malformed: malformedLines + report.malformedCount, tokens: tokenTotals }) + '\n');
