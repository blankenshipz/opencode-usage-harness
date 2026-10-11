import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOutputStore, installContextCompression, compressionKind } from '../plugins/v2/context-compression.mjs';
import { compactToolText } from '../plugins/v2/result-compactor.mjs';
const source = JSON.stringify(Array.from({length: 100}, (_, i) => ({very_long_name_for_identifier:i,very_long_name_for_status:'ready'})), null, 2);
const base = {sessionID:'session',messageID:'message',id:'call',tool:'execute',input:{}};
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'harness-compression-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const hooks={}; await installContextCompression({tool:{hook:async(name,fn)=>{hooks[name]=fn;}}}, {save:createOutputStore(directory, options)});
  return {directory,hooks,before:e=>hooks['execute.before'](e),after:e=>hooks['execute.after'](e)};
}
test('root projection is persisted only after originals exist; output and metadata unchanged',async t=>{
  const f=await fixture(t), output={rows:source}, metadata={exit:0,truncated:false};
  const e={...base,status:'completed',result:{content:source,output,metadata}};
  await f.before(e);await f.after(e);
  assert.match(e.result.content,/harness compacted/);assert.equal(e.result.output,output);assert.equal(e.result.metadata,metadata);
  const [dir]=(await fs.readdir(f.directory)).filter(x=>!x.startsWith('.'));
  assert.equal(await fs.readFile(path.join(f.directory,dir,'original.txt'),'utf8'),source);
  const chunks=await fs.readFile(path.join(f.directory,dir,'chunks.jsonl'),'utf8');
  assert.equal(chunks.trimEnd().split('\n').map(JSON.parse).join(''),source);
  assert.equal((await fs.stat(path.join(f.directory,dir,'original.txt'))).mode & 0o777,0o600);
  const save=createOutputStore(f.directory); assert.equal(await save(e,0,source,compactToolText(source,'json')),e.result.content);
  assert.equal((await fs.readdir(f.directory)).length,1); // Restart/idempotent store.
});
test('CodeMode nesting and concurrent leaves retain fallback text until outer completion',async t=>{
 const f=await fixture(t), root={...base,status:'completed',result:{content:[{type:'text',text:source},{type:'file',uri:'example',mime:'image/png'}]}};
 const a={...base,tool:'grep',status:'completed',result:{content:source}}, b={...a,tool:'glob',result:{content:source}};
 await f.before(root);await f.before(a);await f.before(b);await f.after(b);await f.after(a);
 assert.equal(a.result.content,source);assert.equal(b.result.content,source);await f.after(root);
 assert.match(root.result.content[0].text,/harness compacted/);assert.equal(root.result.content[1].uri,'example');
});
test('errors, protected tools, unknown tools and missing before stay unchanged',async t=>{
 const f=await fixture(t);
 for(const tool of ['read','patch','task_dispatch','external_tool']) {
  const e={...base,tool,status:'completed',result:{content:source}}; await f.before(e);await f.after(e);assert.equal(e.result.content,source);
 }
 const error=new Error('permission denied'), e={...base,status:'error',error};await f.before(e);await f.after(e);assert.equal(e.error,error);
 const bare={...base,status:'completed',result:{content:source}};await f.after(bare);assert.equal(bare.result.content,source);
 assert.deepEqual(await fs.readdir(f.directory),[]);
});
test('storage failure and capacity pressure preserve originals without fallback',async t=>{
 const f=await fixture(t,{maxRecords:0}); const e={...base,status:'completed',result:{content:source}};await f.before(e);await f.after(e);assert.equal(e.result.content,source);
 await installContextCompression({tool:{hook:async(n,fn)=>{f.hooks[n]=fn;}}},{save:async()=>{throw Error('disk unavailable');}});
 await f.before(e);await f.after(e);assert.equal(e.result.content,source);
});
test('serialized chunk lines survive native read line clamps and Unicode boundaries',async t=>{
 const f=await fixture(t), original=('"\\\t\r\u0001😀 words '.repeat(20)+'\n').repeat(80);
 const projected=await createOutputStore(f.directory)(base,0,original,compactToolText(original,'shell'));
 assert.ok(projected);
 const [dir]=await fs.readdir(f.directory), lines=(await fs.readFile(path.join(f.directory,dir,'chunks.jsonl'),'utf8')).trimEnd().split('\n');
 assert.ok(lines.every(x=>x.length<=1800));assert.equal(lines.map(JSON.parse).join(''),original);
});
test('only uncomplicated test/build commands get log deduplication',()=>{
 assert.equal(compressionKind({...base,tool:'shell',input:{command:'npm test -- foo'}}),'shell');
 for(const command of ['cat source.ts','npm test; cat file','npm test | cat','npm test > file']) assert.equal(compressionKind({...base,tool:'shell',input:{command}}),'json');
});
test('native MCP namespace registrations receive JSON-only projection',async()=>{
 const hooks={}; await installContextCompression({mcp:{transform:async fn=>fn({list:()=>[['example-server',{}]]})},tool:{transform:async fn=>fn({list:()=>[{name:'list_records',options:{namespace:'example-server'}}]}),hook:async(n,fn)=>{hooks[n]=fn;}}},{save:async(_e,_i,_o,c)=>c.text});
 const e={...base,tool:'example-server_list_records',status:'completed',result:{content:source,output:{unchanged:true}}};
 await hooks['execute.before'](e);await hooks['execute.after'](e);assert.notEqual(e.result.content,source);assert.deepEqual(e.result.output,{unchanged:true});
});
test('terminal events release interrupted or declined root tracking',async()=>{
 const hooks={}; let send;
 const ctx={tool:{hook:async(n,fn)=>{hooks[n]=fn;}},event:{subscribe:async function*(){yield await new Promise(resolve=>{send=resolve;});}}};
 const stop=await installContextCompression(ctx,{save:async(_e,_i,_o,c)=>c.text});
 await hooks['execute.before'](base);await hooks['execute.before']({...base,tool:'read'});
 send({type:'session.tool.failed',data:{sessionID:base.sessionID,assistantMessageID:base.messageID,id:base.id,executed:false}});
 await new Promise(resolve=>setImmediate(resolve));
 const e={...base,status:'completed',result:{content:source}};await hooks['execute.before'](e);await hooks['execute.after'](e);assert.notEqual(e.result.content,source);stop();
});
test('native rendered chunk lines reconstruct original after stripping read decorations',async t=>{
 const f=await fixture(t);await createOutputStore(f.directory)(base,0,source,compactToolText(source,'json'));
 const [dir]=await fs.readdir(f.directory),lines=(await fs.readFile(path.join(f.directory,dir,'chunks.jsonl'),'utf8')).trimEnd().split('\n');
 // Mirrors native read toModelContent: header, numbered lines, optional footer.
 const rendered=['Read file chunks.jsonl, lines 1-'+lines.length,...lines.map((x,i)=>`${i+1}: ${x}`)].join('\n');
 assert.equal(rendered.split('\n').filter(x=>/^\d+: /.test(x)).map(x=>JSON.parse(x.replace(/^\d+: /,''))).join(''),source);
});
test('directory sync failure never publishes a retrieval marker',async t=>{
 const io={...fs,open:async(file,flags,...args)=>{
  const handle=await fs.open(file,flags,...args);if(flags==='r')return {sync:async()=>{throw Error('fsync unavailable');},close:()=>handle.close()};return handle;
 }};
 const f=await fixture(t,{io}),e={...base,status:'completed',result:{content:source}};
 await f.before(e);await f.after(e);assert.equal(e.result.content,source);assert.equal((await fs.readdir(f.directory)).length,0);
});
