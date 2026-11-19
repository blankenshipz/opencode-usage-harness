// Independent implementation inspired by Headroom's conservative compression and
// recoverable originals. See NOTICE for pinned upstream references. No inference.
import { previewDiff } from './diff-preview.mjs';
const MAX_BYTES = 1024 * 1024;
const useful = (before, after) => before.length - after.length >= 512 && after.length <= before.length * 0.85;
// Lossy previews of native search results start at 16 KiB.
const SEARCH_PREVIEW_MIN_CHARS = 16 * 1024;
// Structured kinds (status-like JSON, grouped grep/rg text, git summaries and
// native grep) may be projected from the global 4 KiB minimum. Below
// SEARCH_PREVIEW_MIN_CHARS a lossy projection is a fallback: it is chosen only
// when no lossless candidate passes useful().
export const STRUCTURED_PREVIEW_MIN_CHARS = 4 * 1024;
// Status JSON: arrays longer than KEEP + SLACK keep their first KEEP entries
// plus every error entry; non-error strings are cut to STATUS_STRING_MAX.
const STATUS_ARRAY_KEEP = 5;
const STATUS_ARRAY_SLACK = 3;
const STATUS_STRING_MAX = 240;
// Grep/rg text: matches shown per file scale down to GREP_MATCHES_PER_FILE as
// the file count grows; at most GREP_MAX_FILES files show match text and
// GREP_MAX_LISTED_FILES are listed at all. Long match lines are cut.
const GREP_MATCHES_PER_FILE = 3;
const GREP_MAX_SHOWN = 60;
const GREP_MAX_FILES = 40;
const GREP_MAX_LISTED_FILES = 200;
const GREP_LINE_MAX = 400;
// Git summaries: list runs keep their first GIT_RUN_KEEP entries; long-form
// logs keep GIT_COMMITS_FULL whole commits, then GIT_COMMITS_BRIEF one-liners.
const GIT_RUN_KEEP = 10;
const GIT_COMMITS_FULL = 5;
const GIT_COMMITS_BRIEF = 15;
// Lines and entries matching these are failures the agent needs verbatim.
const ERROR_TEXT = /\b(?:errors?|fail(?:s|ed|ure|ures|ing)?|fatal|exception|traceback|panic(?:ked)?|denied|conflicts?|abort(?:ed)?|crash(?:ed)?|timed[ _-]?out|timeout|rejected|invalid)\b/i;
const SEARCH_PREVIEW_MAX_CHARS = 12 * 1024;
const SEARCH_PREVIEW_MAX_FILES = 24;
const SEARCH_PREVIEW_MAX_MATCHES_PER_FILE = 3;
const SEARCH_PREVIEW_MAX_MATCHES = 64;

// Retain token spellings: JSON.parse/stringify would round large integers and
// discard duplicate keys. Parse only to validate, then remove lexical whitespace.
function jsonMinify(text) {
  try { JSON.parse(text); } catch { return undefined; }
  let quoted = false, escaped = false, out = '';
  for (const char of text) {
    if (quoted || !/\s/.test(char)) out += char;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
  }
  return out;
}

// Values are slices of validated JSON, never converted to JavaScript numbers.
function valueEnd(s, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (!depth) return i; depth--; }
    else if (c === ',' && !depth) return i;
  }
  return s.length;
}
function rectangularTable(s) {
  if (!s.startsWith('[{') || !s.endsWith('}]')) return undefined;
  let i = 1, columns, decodedColumns, rows = [];
  while (i < s.length - 1 && rows.length < 10000) {
    if (s[i++] !== '{') return undefined;
    const keys = [], decoded = [], values = [];
    while (s[i] !== '}') {
      if (s[i] !== '"') return undefined;
      let j = i + 1, escaped = false;
      for (; j < s.length; j++) { if (escaped) escaped = false; else if (s[j] === '\\') escaped = true; else if (s[j] === '"') break; }
      const key = s.slice(i, j + 1), name = JSON.parse(key);
      if (decoded.includes(name) || s[j + 1] !== ':') return undefined;
      keys.push(key); decoded.push(name); i = j + 2;
      const end = valueEnd(s, i); values.push(s.slice(i, end)); i = end;
      if (s[i] === ',') i++; else if (s[i] !== '}') return undefined;
    }
    if (!columns) { columns = keys; decodedColumns = decoded; }
    if (!keys.length || JSON.stringify(decoded) !== JSON.stringify(decodedColumns)) return undefined;
    rows.push(`[${values.join(',')}]`); i++;
    if (s[i] === ',') i++; else if (s[i] !== ']') return undefined;
  }
  if (i !== s.length - 1 || rows.length < 3) return undefined;
  return `{"format":"harness-table-v1 (each row maps positionally to columns; all rows retained)","columns":[${columns.join(',')}],"rows":[${rows.join(',')}]}`;
}
function repeatLines(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (lines.length > 20000) return undefined;
  const out = [];
  for (let i = 0; i < lines.length;) {
    let j = i + 1; while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]);
    if (j - i >= 3) out.push(`[harness: original lines ${i + 2}-${j} repeat line ${i + 1} exactly; ${j - i - 1} repetitions]\n`);
    else out.push(...lines.slice(i + 1, j));
    i = j;
  }
  return out.join('');
}
function pathPrefix(text) {
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines.length < 5 || lines.length > 10000) return undefined;
  const isPath = x => /^(?:\/?[\w.@+-]+\/)+[^\r\n]+$/.test(x);
  const allPaths = lines.every(isPath);
  const nativeGrep = /^Found \d+ matches$/.test(lines[0]);
  const pathLine = x => isPath(x) && (!nativeGrep || x.endsWith(':'));
  if (!allPaths && !lines.every((x,i) => pathLine(x) || x === '' ||
      (nativeGrep && (i === 0 || /^  Line \d+: /.test(x))) ||
      /^\(Results are truncated: showing first \d+ results\. Consider using a more specific path or pattern\.\)$/.test(x))) return undefined;
  const paths = lines.filter(pathLine); if (paths.length < 5) return undefined;
  let prefix = paths[0];
  for (const line of paths) { let i = 0; while (i < prefix.length && prefix[i] === line[i]) i++; prefix = prefix.slice(0, i); }
  prefix = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  if (prefix.length < 16) return undefined;
  if (allPaths) return JSON.stringify({ format: 'harness-paths-v1 (each original line = prefix + suffix; all entries retained)', prefix, suffixes: lines.map(x => x.slice(prefix.length)) });
  return JSON.stringify({ format: 'harness-search-v1 (string lines unchanged; [suffix] lines = prefix + suffix; all lines retained)', prefix,
    lines: lines.map(x => pathLine(x) ? [x.slice(prefix.length)] : x) });
}

// These formats are emitted by the native grep/glob tools. Keep the grammar
// deliberately narrow: an unrecognized result must remain native output.
function nativePath(line) {
  return /^(?:\/?[\w.@+-]+\/)+[^\r\n]+$/.test(line);
}
function globPreview(text) {
  const paths = text.split('\n');
  if (paths.at(-1) === '') paths.pop();
  if (paths.length <= SEARCH_PREVIEW_MAX_FILES || !paths.every(nativePath)) return undefined;
  const shown = [];
  for (const entry of paths) {
    if (shown.length >= SEARCH_PREVIEW_MAX_FILES || previewLength(shown, entry) > SEARCH_PREVIEW_MAX_CHARS) break;
    shown.push(entry);
  }
  if (!shown.length) return undefined;
  return `[harness search-preview; native glob returned ${paths.length} files; showing ${shown.length}; omitted ${paths.length - shown.length} files. Narrow with a more specific path or pattern. Exact results are available from the saved snapshot.]\n${shown.join('\n')}`;
}
function previewLength(lines, next) {
  return lines.reduce((size, line) => size + line.length + 1, 0) + next.length + 1;
}
function grepPreview(text, lowBand = false) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const heading = /^Found (\d+) matches$/.exec(lines[0] ?? '');
  if (!heading) return undefined;
  const groups = [];
  for (let i = 1; i < lines.length;) {
    // This is native tool truncation, not a form we reinterpret.
    if (/^\(Results are truncated: showing first \d+ results\. Consider using a more specific path or pattern\.\)$/.test(lines[i])) {
      if (++i !== lines.length) return undefined;
      break;
    }
    const file = lines[i];
    if (!file?.endsWith(':') || !nativePath(file.slice(0, -1))) return undefined;
    i++;
    const matches = [];
    while (i < lines.length && /^  Line \d+: /.test(lines[i])) matches.push(lines[i++]);
    if (!matches.length) return undefined;
    groups.push({ file, matches });
    if (i === lines.length) break; // Native output may omit its final separator.
    if (lines[i] !== '') return undefined;
    i++;
  }
  const totalMatches = groups.reduce((count, group) => count + group.matches.length, 0);
  if (!lowBand && totalMatches <= SEARCH_PREVIEW_MAX_MATCHES && groups.length <= SEARCH_PREVIEW_MAX_FILES) return undefined;
  const shown = [], usedFiles = new Set(); let shownMatches = 0;
  for (const group of groups) {
    if (usedFiles.size >= SEARCH_PREVIEW_MAX_FILES || shownMatches >= SEARCH_PREVIEW_MAX_MATCHES) break;
    const entries = group.matches.slice(0, Math.min(SEARCH_PREVIEW_MAX_MATCHES_PER_FILE, SEARCH_PREVIEW_MAX_MATCHES - shownMatches));
    const candidate = [group.file, ...entries, ''];
    if (previewLength(shown, candidate.join('\n')) > SEARCH_PREVIEW_MAX_CHARS) break;
    shown.push(...candidate); usedFiles.add(group.file); shownMatches += entries.length;
  }
  if (!shownMatches || (lowBand && shownMatches === totalMatches)) return undefined;
  return `[harness search-preview; native grep reported ${heading[1]} matches; this result listed ${totalMatches} matching lines in ${groups.length} files; showing ${shownMatches} matching lines in ${usedFiles.size} files; omitted ${totalMatches - shownMatches} matching lines and ${groups.length - usedFiles.size} files from this preview. Narrow with a more specific path or pattern. Exact results are available from the saved snapshot.]\nFound ${heading[1]} matches\n${shown.join('\n')}`;
}
function searchPreview(text, kind) {
  // Native grep may be previewed from the structured floor; below 16 KiB the
  // file/match count guard is dropped but something must still be omitted.
  if (kind === 'grep' && text.length >= STRUCTURED_PREVIEW_MIN_CHARS) return grepPreview(text, text.length < SEARCH_PREVIEW_MIN_CHARS);
  if (text.length < SEARCH_PREVIEW_MIN_CHARS) return undefined;
  return kind === 'glob' ? globPreview(text) : undefined;
}

const clip = (text, max) => text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text;
const countList = counts => [...counts].map(([name, count]) => `${name}=${count}`).join(', ');

// ---- Status-like JSON -------------------------------------------------------
// Parse keeps each number's source spelling (large ids must not round).
const STATUS_KEY = /^(?:status|state|outcome|phase|health|conclusion)$/i;
const ERROR_KEY = /error|fail|exception|stderr|traceback|diagnostic/i;
function parseExact(text) {
  if (typeof JSON.rawJSON !== 'function') return undefined;
  try {
    return JSON.parse(text, (_key, value, context) => typeof value === 'number' && typeof context?.source === 'string' && String(value) !== context.source ? JSON.rawJSON(context.source) : value);
  } catch { return undefined; }
}
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !JSON.isRawJSON(value);
const present = value => !(value === null || value === undefined || value === false || value === '' || (Array.isArray(value) && !value.length) || (isPlainObject(value) && !Object.keys(value).length));
function statusLike(value, depth = 0) {
  if (depth > 3) return false;
  if (Array.isArray(value)) return value.slice(0, 50).some(item => statusLike(item, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => (STATUS_KEY.test(key) && typeof item === 'string') || statusLike(item, depth + 1));
}
// An entry the agent needs verbatim: a populated error field or a failed state.
function errorEntry(value) {
  if (typeof value === 'string') return ERROR_TEXT.test(value);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, item]) => (ERROR_KEY.test(key) && present(item)) || (STATUS_KEY.test(key) && typeof item === 'string' && ERROR_TEXT.test(item)));
}
function statusOf(value) {
  if (!isPlainObject(value)) return undefined;
  const entry = Object.entries(value).find(([key, item]) => STATUS_KEY.test(key) && typeof item === 'string');
  return entry?.[1];
}
function projectStatus(value, key, stats) {
  if (typeof value === 'string') {
    if (ERROR_KEY.test(key) || value.length <= STATUS_STRING_MAX) return value;
    stats.strings++; return clip(value, STATUS_STRING_MAX);
  }
  if (Array.isArray(value)) {
    if (ERROR_KEY.test(key)) return value;
    // Consecutive identical entries collapse to one entry and a repeat count.
    const runs = [];
    for (const item of value) {
      const serial = JSON.stringify(item);
      if (runs.at(-1)?.serial === serial) runs.at(-1).count++;
      else runs.push({ item, serial, count: 1 });
    }
    const out = []; let omitted = 0;
    runs.forEach((run, index) => {
      const keep = runs.length <= STATUS_ARRAY_KEEP + STATUS_ARRAY_SLACK || index < STATUS_ARRAY_KEEP;
      if (errorEntry(run.item)) out.push(run.item);
      else if (keep) out.push(projectStatus(run.item, '', stats));
      else { omitted += run.count; return; }
      if (run.count > 1) { out.push(`[harness: previous entry repeated ${run.count - 1} more times]`); stats.repeats += run.count - 1; }
    });
    if (omitted) {
      const counts = new Map();
      for (const item of value) { const status = statusOf(item); if (status !== undefined) counts.set(status, (counts.get(status) ?? 0) + 1); }
      out.push(`[harness: omitted ${omitted} of ${value.length} entries; error entries retained${counts.size ? `; status counts over all ${value.length}: ${countList(counts)}` : ''}]`);
      stats.arrays++; stats.items += omitted;
    }
    return out;
  }
  if (isPlainObject(value)) {
    if (errorEntry(value) && key !== '') return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, projectStatus(item, name, stats)]));
  }
  return value;
}
function statusJsonProjection(text) {
  const value = parseExact(text);
  if (value === undefined || !statusLike(value)) return undefined;
  const stats = { arrays: 0, items: 0, strings: 0, repeats: 0 };
  const projected = projectStatus(value, '', stats);
  if (!stats.items && !stats.strings && !stats.repeats) return undefined;
  return `[harness status-json; ids, status/state/outcome fields, counts and error entries retained; ${stats.arrays} long arrays collapsed (${stats.items} entries omitted, counted by status), ${stats.repeats} repeated entries folded, ${stats.strings} long strings truncated]\n${JSON.stringify(projected)}`;
}

// ---- Grep/rg text output ----------------------------------------------------
const looksLikePath = value => /^[\w.@+\-/]+$/.test(value) && (value.includes('/') || /\.\w+$/.test(value));
function grepGroupsProjection(text) {
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines.length > 20000) return undefined;
  const groups = new Map(), notes = []; let unknown = 0, separators = 0, context = 0, total = 0;
  const add = (file, entry) => { if (!groups.has(file)) groups.set(file, []); groups.get(file).push(entry); total++; };
  for (const line of lines) {
    let match;
    if (line === '--') { separators++; continue; }
    if ((match = /^([^:\n]+):(\d+):(.*)$/.exec(line)) && looksLikePath(match[1])) add(match[1], `${match[2]}: ${clip(match[3], GREP_LINE_MAX)}`);
    else if ((match = /^(\d+):(.*)$/.exec(line))) add('(single file)', `${match[1]}: ${clip(match[2], GREP_LINE_MAX)}`);
    else if ((match = /^([^:\n]+):(.*)$/.exec(line)) && looksLikePath(match[1]) && !/^(?:rg|grep)$/.test(match[1])) add(match[1], clip(match[2], GREP_LINE_MAX));
    else if ([...groups.keys()].some(file => line.startsWith(`${file}-`) && /^\d+-/.test(line.slice(file.length + 1))) || /^\d+-/.test(line)) context++;
    else if (/^(?:rg|grep|git):\s/.test(line) || ERROR_TEXT.test(line)) notes.push(line);
    else unknown++;
  }
  // Not recognizably grep output: retain it untouched.
  if (!total || unknown > lines.length * 0.1) return undefined;
  const perFile = Math.max(GREP_MATCHES_PER_FILE, Math.floor(GREP_MAX_SHOWN / Math.min(groups.size, GREP_MAX_FILES)));
  const out = []; let shown = 0, index = 0;
  for (const [file, entries] of groups) {
    if (index++ >= GREP_MAX_LISTED_FILES) break;
    if (index > GREP_MAX_FILES) { out.push(`${file} (${entries.length} matches)`); continue; }
    const visible = entries.slice(0, perFile); shown += visible.length;
    out.push(`${file}: (${entries.length} matches)`, ...visible.map(entry => `  ${entry}`));
    if (entries.length > visible.length) out.push(`  [+${entries.length - visible.length} more matches in this file]`);
  }
  const unlisted = groups.size - Math.min(groups.size, GREP_MAX_LISTED_FILES);
  if (unlisted) out.push(`[+${unlisted} more files not listed]`);
  if (shown === total && !context && !separators) return undefined;
  return [`[harness grep-groups; ${total} matching lines in ${groups.size} files${context ? ` plus ${context} context lines (omitted)` : ''}; showing ${shown} matching lines; omitted ${total - shown}. Matches are grouped by file as "line: text". Narrow with a more specific path or pattern.]`,
    ...notes, ...out].join('\n');
}

// ---- Compound git summary output -------------------------------------------
const GIT_KEEP_LINE = /^(?:fatal|error|warning):|CONFLICT|\bboth (?:modified|added|deleted)\b|\bunmerged\b/i;
function gitLineClass(line) {
  if (GIT_KEEP_LINE.test(line)) return { kind: 'keep' };
  let match;
  if (/^ \S.*? +\| +(?:\d+ ?[+-]*|Bin .*)$/.test(line)) return { kind: 'stat', label: 'diffstat' };
  if ((match = /^\t(?:(new file|modified|deleted|renamed|copied|typechange):\s+)?\S/.exec(line))) return { kind: 'status', label: match[1] ?? 'untracked' };
  if ((match = /^([ MADRCT?!][ MADRCT?!]) \S/.exec(line))) return { kind: 'status', label: match[1].trim() || '?' };
  if ((match = /^([AMDRCT])\d*\t\S/.exec(line))) return { kind: 'status', label: match[1] };
  if (/^(?:[*|\\/ ]+ )?[0-9a-f]{7,40} \S/.test(line)) return { kind: 'log', label: 'commit' };
  if (looksLikePath(line)) return { kind: 'path', label: 'path' };
  return { kind: 'keep' };
}
const COMMIT_BODY = /^(?:(?:Author|AuthorDate|Commit|CommitDate|Date|Merge):|    |$| \S.*\|| \d+ files? changed)/;
function gitSummaryProjection(text) {
  const lines = text.split('\n'); const trailing = lines.at(-1) === ''; if (trailing) lines.pop();
  const out = []; let runs = 0, omitted = 0;
  for (let i = 0; i < lines.length;) {
    // Long-form log: whole commit blocks.
    if (/^commit [0-9a-f]{40}\b/.test(lines[i])) {
      const blocks = [];
      while (i < lines.length && /^commit [0-9a-f]{40}\b/.test(lines[i])) {
        const start = i++; while (i < lines.length && COMMIT_BODY.test(lines[i])) i++;
        blocks.push(lines.slice(start, i));
      }
      blocks.forEach((block, index) => {
        if (index < GIT_COMMITS_FULL || block.some(line => GIT_KEEP_LINE.test(line))) out.push(...block);
        else if (index < GIT_COMMITS_FULL + GIT_COMMITS_BRIEF) out.push(`${block[0].slice(7, 19)} ${(block.find(line => line.startsWith('    ')) ?? '').trim()}`);
      });
      const hidden = Math.max(0, blocks.length - GIT_COMMITS_FULL - GIT_COMMITS_BRIEF);
      if (blocks.length > GIT_COMMITS_FULL) { runs++; omitted += blocks.length - GIT_COMMITS_FULL; }
      if (hidden) out.push(`[harness: +${hidden} older commits omitted]`);
      continue;
    }
    const first = gitLineClass(lines[i]);
    if (first.kind === 'keep') { out.push(lines[i++]); continue; }
    const run = [];
    while (i < lines.length) { const item = gitLineClass(lines[i]); if (item.kind !== first.kind) break; run.push({ line: lines[i++], label: item.label }); }
    if (run.length <= GIT_RUN_KEEP + 2) { out.push(...run.map(x => x.line)); continue; }
    out.push(...run.slice(0, GIT_RUN_KEEP).map(x => x.line));
    const counts = new Map();
    for (const item of run.slice(GIT_RUN_KEEP)) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    out.push(`[harness: +${run.length - GIT_RUN_KEEP} more ${first.kind === 'log' ? 'commit' : first.kind === 'stat' ? 'diffstat' : first.kind === 'path' ? 'path' : 'status'} lines omitted (of ${run.length}${first.kind === 'status' ? `; ${countList(counts)}` : ''})]`);
    runs++; omitted += run.length - GIT_RUN_KEEP;
  }
  if (!omitted) return undefined;
  return `[harness git-summary; summary, branch and error lines retained verbatim; ${runs} long lists collapsed (${omitted} entries omitted, counted)]\n${out.join('\n')}${trailing ? '\n' : ''}`;
}

export function compactToolText(text, kind) {
  if (typeof text !== 'string' || text.length < 4096 || Buffer.from(text, 'utf8').toString('utf8') !== text || Buffer.byteLength(text) > MAX_BYTES || !['shell', 'grep', 'glob', 'json', 'diff', 'search', 'git'].includes(kind)) return undefined;
  const candidates = [];
  if (kind === 'diff') { const preview = previewDiff(text); if (preview) candidates.push(preview); }
  const minified = jsonMinify(text);
  if (minified !== undefined) {
    candidates.push({ text: minified, strategy: 'json-whitespace' });
    const table = rectangularTable(minified); if (table) candidates.push({ text: table, strategy: 'json-table' });
    candidates.push({ text: statusJsonProjection(text), strategy: 'status-json', lossless: false,
      preservation: 'this status projection collapses long arrays and truncates long strings; ids, status fields, counts and error entries are retained; the exact original is saved for retrieval.' });
  }
  // JSON strings must never be rewritten as line logs or path lists.
  if (minified === undefined && kind === 'shell') candidates.push({ text: repeatLines(text), strategy: 'exact-repeat-lines' });
  if (minified === undefined && ['grep', 'glob'].includes(kind)) {
    candidates.push({ text: searchPreview(text, kind), strategy: 'search-preview', lossless: false,
      preservation: 'this search preview omits results; the exact native original is saved for retrieval.' });
    candidates.push({ text: pathPrefix(text), strategy: 'path-prefix' });
  }
  if (minified === undefined && kind === 'search') {
    candidates.push({ text: grepGroupsProjection(text), strategy: 'grep-groups', lossless: false,
      preservation: 'this grouped search preview omits matches (counted per file); error lines are retained; the exact original is saved for retrieval.' });
    candidates.push({ text: pathPrefix(text), strategy: 'path-prefix' });
  }
  if (minified === undefined && kind === 'git') candidates.push({ text: gitSummaryProjection(text), strategy: 'git-summary', lossless: false,
    preservation: 'this git summary collapses long file and commit lists (counted); summary and error lines are retained; the exact original is saved for retrieval.' });
  const viable = candidates.filter(x => typeof x.text === 'string' && useful(text, x.text));
  // Below the 16 KiB preview floor, prefer any useful lossless projection.
  const lossless = viable.filter(x => x.lossless !== false);
  const pool = text.length < SEARCH_PREVIEW_MIN_CHARS && lossless.length ? lossless : viable;
  const best = pool.sort((a,b) => a.text.length-b.text.length)[0];
  return best ? { ...best, originalChars: text.length, compactedChars: best.text.length } : undefined;
}
