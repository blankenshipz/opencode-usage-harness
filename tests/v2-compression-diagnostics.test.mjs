import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCompressionDiagnostics} from '../plugins/v2/compression-diagnostics.mjs';
test('serialized diagnostics queue is bounded, private, and omits raw input',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'compression-diagnostics-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'records.jsonl'),sink=createCompressionDiagnostics(file,{maxPending:2});
 for(let i=0;i<10;i++)sink.record({type:'candidate',sessionID:'session',reason:'below_minimum',processingMs:1,input:'never-log-me',output:'also-private'});
 await sink.flush();const text=await fs.readFile(file,'utf8');assert.equal(text.trim().split('\n').length,2);assert.ok(!text.includes('never-log-me'));assert.ok(!text.includes('also-private'));assert.equal((await fs.stat(file)).mode & 0o777,0o600);
});
test('rotation retains one prior segment and storage failure never rejects',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'compression-diagnostics-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'records.jsonl'),sink=createCompressionDiagnostics(file,{maxBytes:1});
 for(const reason of ['one','two','three']){sink.record({type:'candidate',sessionID:'s',reason});await sink.flush();}
 assert.equal(JSON.parse((await fs.readFile(file,'utf8')).trim()).reason,'three');assert.equal(JSON.parse((await fs.readFile(file+'.1','utf8')).trim()).reason,'two');
 const failed=createCompressionDiagnostics(file,{io:{mkdir:async()=>{throw Error('offline');}}});failed.record({type:'candidate',sessionID:'s'});await assert.doesNotReject(failed.flush());
});
