import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareCheck, installCheckTools } from '../plugins/v2/check-tools.mjs';

test('check preparation only emits literal argv, including shell metacharacters', () => {
  const args = ['echo', "a'b", '$(touch NEVER)', '`touch NEVER`', '$HOME', 'a\nb'];
  const prepared = prepareCheck({ label: 'test', argv: args }, '/tmp/harness');
  assert.equal(prepared.executed, false);
  const command = prepared.command.replace(/^'[^']*' '\/tmp\/harness\/src\/check_receipt.py'/, "python3 -c 'import sys,json;print(json.dumps(sys.argv[1:]))'");
  const decoded = JSON.parse(execFileSync('/bin/sh', ['-c', command], {encoding:'utf8'}));
  assert.deepEqual(decoded, ['--label', 'test', '--', ...args]);
  assert.throws(() => prepareCheck({ label: '../bad', argv: ['echo'] }));
  assert.throws(() => prepareCheck({ label: 'ok', argv: ['x\0y'] }));
});
test('tools only run fixed read-only helpers; status cannot escape receipt root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'check-tools-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const receipts=path.join(root,'receipts'), dir=path.join(receipts,'one');await fs.mkdir(dir,{recursive:true});
  const receipt=path.join(dir,'receipt.json');await fs.writeFile(receipt,'{}');
  const outside=path.join(root,'receipt.json');await fs.writeFile(outside,'{}');await fs.symlink(outside,path.join(dir,'outside.json'));
  const tools=new Map(),calls=[];
  await installCheckTools({tool:{transform:async fn=>fn({add:t=>tools.set(t.name,t)})}}, {receiptRoot:receipts,run:async(...args)=>{calls.push(args);return {stdout:'{"status":"unknown"}'};}});
  await tools.get('check_prepare').execute({label:'ok',argv:['touch','not-created']});assert.equal(calls.length,0);
  await tools.get('check_status').execute({receipt});assert.equal(calls.length,1);
  await assert.rejects(tools.get('check_status').execute({receipt:outside}));
  await assert.rejects(tools.get('check_status').execute({receipt:path.join(dir,'outside.json')}));
  await tools.get('harness_health').execute({sessionID:'ses_child'},{sessionID:'ses_parent'});
  assert.deepEqual(calls.at(-1)[1].slice(1),['--session','ses_child','--caller','ses_parent']);
  assert.equal(calls.length,2);
});
