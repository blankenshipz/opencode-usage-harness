// Independent implementation inspired by Headroom's conservative compression and
// recoverable originals. See NOTICE for pinned upstream references. No inference.
import { previewDiff } from './diff-preview.mjs';
const MAX_BYTES = 1024 * 1024;
const useful = (before, after) => before.length - after.length >= 512 && after.length <= before.length * 0.85;
const SEARCH_PREVIEW_MIN_CHARS = 16 * 1024;
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
function grepPreview(text) {
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
  if (totalMatches <= SEARCH_PREVIEW_MAX_MATCHES && groups.length <= SEARCH_PREVIEW_MAX_FILES) return undefined;
  const shown = [], usedFiles = new Set(); let shownMatches = 0;
  for (const group of groups) {
    if (usedFiles.size >= SEARCH_PREVIEW_MAX_FILES || shownMatches >= SEARCH_PREVIEW_MAX_MATCHES) break;
    const entries = group.matches.slice(0, Math.min(SEARCH_PREVIEW_MAX_MATCHES_PER_FILE, SEARCH_PREVIEW_MAX_MATCHES - shownMatches));
    const candidate = [group.file, ...entries, ''];
    if (previewLength(shown, candidate.join('\n')) > SEARCH_PREVIEW_MAX_CHARS) break;
    shown.push(...candidate); usedFiles.add(group.file); shownMatches += entries.length;
  }
  if (!shownMatches) return undefined;
  return `[harness search-preview; native grep reported ${heading[1]} matches; this result listed ${totalMatches} matching lines in ${groups.length} files; showing ${shownMatches} matching lines in ${usedFiles.size} files; omitted ${totalMatches - shownMatches} matching lines and ${groups.length - usedFiles.size} files from this preview. Narrow with a more specific path or pattern. Exact results are available from the saved snapshot.]\nFound ${heading[1]} matches\n${shown.join('\n')}`;
}
function searchPreview(text, kind) {
  if (text.length < SEARCH_PREVIEW_MIN_CHARS) return undefined;
  return kind === 'glob' ? globPreview(text) : kind === 'grep' ? grepPreview(text) : undefined;
}

export function compactToolText(text, kind) {
  if (typeof text !== 'string' || text.length < 4096 || Buffer.from(text, 'utf8').toString('utf8') !== text || Buffer.byteLength(text) > MAX_BYTES || !['shell', 'grep', 'glob', 'json', 'diff'].includes(kind)) return undefined;
  const candidates = [];
  if (kind === 'diff') { const preview = previewDiff(text); if (preview) candidates.push(preview); }
  const minified = jsonMinify(text);
  if (minified !== undefined) {
    candidates.push({ text: minified, strategy: 'json-whitespace' });
    const table = rectangularTable(minified); if (table) candidates.push({ text: table, strategy: 'json-table' });
  }
  // JSON strings must never be rewritten as line logs or path lists.
  if (minified === undefined && kind === 'shell') candidates.push({ text: repeatLines(text), strategy: 'exact-repeat-lines' });
  if (minified === undefined && ['grep', 'glob'].includes(kind)) {
    candidates.push({ text: searchPreview(text, kind), strategy: 'search-preview', lossless: false,
      preservation: 'this search preview omits results; the exact native original is saved for retrieval.' });
    candidates.push({ text: pathPrefix(text), strategy: 'path-prefix' });
  }
  const best = candidates.filter(x => typeof x.text === 'string' && useful(text, x.text)).sort((a,b) => a.text.length-b.text.length)[0];
  return best ? { ...best, originalChars: text.length, compactedChars: best.text.length } : undefined;
}
