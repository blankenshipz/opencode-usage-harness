import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createStructuredJSONRead } from '../plugins/v2/structured-json-read.mjs';

async function fixture(t, content, name = 'data.json') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'structured-json-read-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name); await fs.writeFile(file, content);
  const calls = [];
  const nativeRead = async (input, context) => { calls.push({ input, context }); return { output: { type: 'text-page', content: '{', offset: 1, truncated: false } }; };
  return { directory, file, calls, nativeRead };
}
const decode = result => JSON.parse(result.content);

test('pages exact long one-line JSON text without parsing it into a new representation', async t => {
  const json = `{"n":123456789012345678901234567890,"n":2,"escaped":"\\uD83D\\uDE00","text":"${'x'.repeat(5000)}"}`;
  const h = await fixture(t, json); const tool = createStructuredJSONRead(h);
  let offset = 0; let combined = ''; let hash;
  do {
    const page = decode(await tool.execute({ path: 'data.json', offset, limit: 997, ...(hash ? { expectedSha256: hash } : {}) }, { sessionID: 's' }));
    assert.equal(page.representation, 'verbatim-json-text'); assert.equal(page.offset, offset);
    hash ??= page.sourceSha256; assert.equal(page.sourceSha256, hash); combined += page.content;
    offset = page.next; if (page.complete) break;
  } while (true);
  assert.equal(combined, json); assert.equal(h.calls.length, 2 * Math.ceil(json.length / 997));
});

test('does not split a surrogate pair at a page boundary', async t => {
  const json = `{"x":"${'a'.repeat(10)}😀${'b'.repeat(10)}"}`;
  const h = await fixture(t, json); const tool = createStructuredJSONRead(h);
  const index = json.indexOf('😀') + 1;
  const page = decode(await tool.execute({ path: 'data.json', limit: index }, {}));
  assert.equal(page.next, index - 1); assert.ok(!page.content.endsWith('😀'));
  const tail = decode(await tool.execute({ path: 'data.json', offset: page.next, expectedSha256: page.sourceSha256 }, {}));
  assert.equal(page.content + tail.content, json);
  assert.match((await tool.execute({ path: 'data.json', offset: index, expectedSha256: page.sourceSha256 }, {})).content, /splits a surrogate pair/);
});

test('native permission denials stop before filesystem open for original and canonical paths', async t => {
  const h = await fixture(t, '{"ok":true}'); let opens = 0;
  const fsSpy = { ...fs, open: async (...args) => { opens++; return fs.open(...args); } };
  const originalDenied = createStructuredJSONRead({ directory: h.directory, fs: fsSpy, nativeRead: async () => { throw new Error('denied-original'); } });
  await assert.rejects(originalDenied.execute({ path: 'data.json' }, {}), /denied-original/); assert.equal(opens, 0);
  const canonicalDenied = createStructuredJSONRead({ directory: h.directory, fs: fsSpy, nativeRead: async ({ path: nativePath }) => {
    if (nativePath === 'data.json') return { output: { type: 'text-page' } };
    throw new Error('denied-canonical');
  } });
  await assert.rejects(canonicalDenied.execute({ path: 'data.json' }, {}), /denied-canonical/); assert.equal(opens, 0);
});

test('rejects oversized, malformed, invalid UTF-8, nonregular, and stale hash inputs without echoing source', async t => {
  const h = await fixture(t, '{"password":"secret"}'); const tool = createStructuredJSONRead(h);
  let result = await tool.execute({ path: 'data.json', expectedSha256: '0'.repeat(64) }, {});
  assert.match(result.content, /expected hash/); assert.doesNotMatch(result.content, /secret/);
  await fs.writeFile(h.file, '{bad'); result = await tool.execute({ path: 'data.json' }, {}); assert.match(result.content, /not valid JSON/); assert.doesNotMatch(result.content, /bad/);
  await fs.writeFile(h.file, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x7d])); result = await tool.execute({ path: 'data.json' }, {}); assert.match(result.content, /could not be read safely/);
  await fs.mkdir(path.join(h.directory, 'dir')); result = await tool.execute({ path: 'dir' }, {}); assert.match(result.content, /not a supported/);
  await fs.writeFile(h.file, `{"x":"${'a'.repeat(1024 * 1024)}"}`); result = await tool.execute({ path: 'data.json' }, {}); assert.match(result.content, /not a supported/);
});

test('rejects mutation after opening and symlink retargets', async t => {
  const h = await fixture(t, '{"a":1}');
  const base = await fs.open(h.file, 'r');
  await base.close();
  let mutate = true;
  const fsMutation = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args); const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { if (mutate) { mutate = false; await fs.writeFile(h.file, '{"a":2}'); } return read(...readArgs); };
    return handle;
  } };
  const tool = createStructuredJSONRead({ directory: h.directory, fs: fsMutation, nativeRead: h.nativeRead });
  assert.match((await tool.execute({ path: 'data.json' }, {})).content, /changed while reading/);
  const target = path.join(h.directory, 'target.json'); const link = path.join(h.directory, 'link.json');
  await fs.writeFile(target, '{"v":1}'); await fs.symlink(target, link);
  const linkTool = createStructuredJSONRead({ directory: h.directory, nativeRead: h.nativeRead });
  const ok = decode(await linkTool.execute({ path: 'link.json' }, {})); assert.equal(ok.content, '{"v":1}');
  await fs.unlink(link); await fs.writeFile(link, '{"v":2}');
  assert.equal(decode(await linkTool.execute({ path: 'link.json' }, {})).content, '{"v":2}');
});

test('validates limits and literal paths before native reads', async () => {
  let calls = 0; const tool = createStructuredJSONRead({ directory: '/tmp', nativeRead: async () => { calls++; return { output: { type: 'text-page' } }; } });
  for (const input of [{ path: '~/.x' }, { path: 'x', limit: 12001 }, { path: 'x', offset: -1 }, { path: 'x', offset: 1 }]) assert.match((await tool.execute(input, {})).content, /invalid input/);
  assert.equal(calls, 0);
});

test('rejects a symlink retarget during authorization without returning either source', async t => {
  const h = await fixture(t, '{"original":true}');
  const other = path.join(h.directory, 'other.json');
  const link = path.join(h.directory, 'link.json');
  const canonical = await fs.realpath(h.file);
  await fs.writeFile(other, '{"unapproved":true}');
  await fs.symlink(h.file, link);
  let reads = 0;
  const tool = createStructuredJSONRead({ directory: h.directory,
    nativeRead: async ({ path: requested }) => {
      if (requested === canonical) {
        await fs.unlink(link); await fs.symlink(other, link);
      }
      return { output: { type: 'text-page' } };
    },
    fs: { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      const read = handle.read.bind(handle);
      handle.read = (...args) => { reads++; return read(...args); };
      return handle;
    } },
  });
  const result = await tool.execute({ path: 'link.json' }, {});
  assert.match(result.content, /changed while opening/);
  assert.doesNotMatch(result.content, /original|unapproved/);
  assert.equal(reads, 0);
});

test('preserves whitespace and rejects a BOM rather than silently changing source bytes', async t => {
  const json = ' \r\n{ "n": 9007199254740993, "n": 0 }\t\n';
  const h = await fixture(t, json); const tool = createStructuredJSONRead(h);
  assert.equal(decode(await tool.execute({ path: 'data.json' }, {})).content, json);
  await fs.writeFile(h.file, '\uFEFF' + json);
  assert.match((await tool.execute({ path: 'data.json' }, {})).content, /not valid JSON/);
});

test('a regular file replaced by a FIFO cannot block the verified-handle check', { skip: process.platform === 'win32' }, async t => {
  const h = await fixture(t, '{"ok":true}'); let seenFlags = 0;
  const tool = createStructuredJSONRead({ directory: h.directory, nativeRead: h.nativeRead,
    fs: { ...fs, open: async (file, flags) => {
      seenFlags = flags;
      // Assert before real open so a regression fails without hanging the test.
      assert.notEqual(flags & fsConstants.O_NONBLOCK, 0);
      await fs.unlink(file);
      execFileSync('mkfifo', [file]);
      return fs.open(file, flags);
    } },
  });
  const result = await tool.execute({ path: 'data.json' }, {});
  assert.notEqual(seenFlags & fsConstants.O_NONBLOCK, 0);
  assert.match(result.content, /changed while opening/);
  assert.doesNotMatch(result.content, /sourceSha256|"ok"/);
});
