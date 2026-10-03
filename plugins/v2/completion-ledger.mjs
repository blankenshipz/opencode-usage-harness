import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// SQLite is the completion source of truth.  A unique key is necessary here
// because the event stream is process-global and more than one loaded plugin
// can observe the same ended step.
const writer = String.raw`
import json, os, sqlite3, sys
os.umask(0o077)
database = sys.argv[1]
record = json.load(sys.stdin)
connection = sqlite3.connect(database)
try:
    connection.execute('PRAGMA busy_timeout=5000')
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('CREATE TABLE IF NOT EXISTS completions (session_id TEXT NOT NULL, message_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY (session_id, message_id))')
    cursor = connection.execute('INSERT OR IGNORE INTO completions (session_id, message_id, record_json) VALUES (?, ?, ?)', (record['session_id'], record['message_id'], json.dumps(record, separators=(',', ':'))))
    connection.commit()
    os.chmod(database, 0o600)
    print(json.dumps({'inserted': cursor.rowcount == 1}))
finally:
    connection.close()
`;

const cleanEnvironment = env => Object.fromEntries(['HOME', 'PATH', 'LANG'].flatMap(name =>
  env[name] === undefined ? [] : [[name, env[name]]]));

function runPython({ python, database, input, timeout = 8000, maxOutput = 4096, env = process.env, launch = spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = launch(python, ['-c', writer, database], { env: cleanEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new Error('completion telemetry ledger write failed')); return; }
    let stdout = '', stderr = '', settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(stdout); };
    const collect = target => chunk => {
      target.value += chunk;
      if (target.value.length > maxOutput) { child.kill(); finish(new Error('completion telemetry ledger write failed')); }
    };
    const out = { value: stdout }, err = { value: stderr };
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
    child.once('error', () => finish(new Error('completion telemetry ledger write failed')));
    child.once('close', status => { stdout = out.value; stderr = err.value; finish(status === 0 ? null : new Error('completion telemetry ledger write failed')); });
    const timer = setTimeout(() => { child.kill(); finish(new Error('completion telemetry ledger write failed')); }, timeout);
    child.stdin.once('error', () => finish(new Error('completion telemetry ledger write failed')));
    child.stdin.end(input);
  });
}

export async function recordCompletion({ database, value, python = 'python3', timeout, env, run = runPython }) {
  if (!value || typeof value.session_id !== 'string' || !value.session_id ||
      typeof value.message_id !== 'string' || !value.message_id)
    throw new Error('completion telemetry requires non-empty session_id and message_id');
  mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
  let stdout;
  try { stdout = await run({ python, database, input: JSON.stringify(value), timeout, env }); }
  catch { throw new Error('completion telemetry ledger write failed'); }
  try {
    const output = JSON.parse(stdout);
    if (typeof output.inserted !== 'boolean') throw new Error('invalid result');
    return output.inserted;
  } catch { throw new Error('completion telemetry ledger write failed'); }
}

export function deduplicateCompletionRecords(records) {
  const unique = new Map();
  let malformed = 0;
  for (const record of records) {
    if (!record || typeof record.session_id !== 'string' || !record.session_id || typeof record.message_id !== 'string' || !record.message_id) {
      malformed++;
      continue;
    }
    unique.set(JSON.stringify([record.session_id, record.message_id]), record);
  }
  return { records: [...unique.values()], duplicateCount: records.length - malformed - unique.size, malformedCount: malformed };
}

export function readCompletionLedger({ database, python = 'python3', spawn = spawnSync, pageSize = 1000 }) {
  const reader = "import json,os,sqlite3,sys,urllib.parse; uri='file:'+urllib.parse.quote(os.path.abspath(sys.argv[1]))+'?mode=ro'; c=sqlite3.connect(uri,uri=True); rows=list(c.execute('SELECT rowid,record_json FROM completions WHERE rowid>? ORDER BY rowid LIMIT ?', (int(sys.argv[2]),int(sys.argv[3])))); print(json.dumps([[row[0],json.loads(row[1])] for row in rows])); c.close()";
  const records = [];
  let cursor = 0;
  while (true) {
    const result = spawn(python, ['-c', reader, database, String(cursor), String(pageSize)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnvironment(process.env), timeout: 8000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error('completion telemetry ledger read failed');
    let page;
    try { page = JSON.parse(result.stdout); }
    catch { throw new Error('completion telemetry ledger read failed'); }
    if (!Array.isArray(page) || page.some(row => !Array.isArray(row) || !Number.isInteger(row[0])))
      throw new Error('completion telemetry ledger read failed');
    records.push(...page.map(row => row[1]));
    if (page.length < pageSize) return records;
    cursor = page.at(-1)[0];
  }
}
