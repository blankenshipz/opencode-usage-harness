import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOutputStore, installContextCompression, compressionKind } from '../plugins/v2/context-compression.mjs';
import { compactToolText } from '../plugins/v2/result-compactor.mjs';
const source = JSON.stringify(Array.from({length: 100}, (_, i) => ({very_long_name_for_identifier:i,very_long_name_for_status:'ready'})), null, 2);
const base = {sessionID:'session',messageID:'message',id:'call',tool:'execute',input:{}};
const quietDiagnostics={record:()=>{}};
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'harness-compression-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const hooks={}; await installContextCompression({tool:{hook:async(name,fn)=>{hooks[name]=fn;}}}, {save:createOutputStore(directory, options),diagnostics:quietDiagnostics});
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
test('built-in native agents bypass optional output compression',async t=>{
 const f=await fixture(t),e={...base,agent:'explore',status:'completed',result:{content:source}};
 await f.before(e);await f.after(e);assert.equal(e.result.content,source);
});
test('storage failure and capacity pressure preserve originals without fallback',async t=>{
 const f=await fixture(t,{maxRecords:0}); const e={...base,status:'completed',result:{content:source}};await f.before(e);await f.after(e);assert.equal(e.result.content,source);
 await installContextCompression({tool:{hook:async(n,fn)=>{f.hooks[n]=fn;}}},{save:async()=>{throw Error('disk unavailable');},diagnostics:quietDiagnostics});
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
 assert.equal(compressionKind({...base,tool:'shell',input:{command:'git diff --cached src/app.ts'}}),'diff');
 for(const command of ['git diff; cat secret', 'git diff | less', 'git diff > patch']) assert.equal(compressionKind({...base,tool:'shell',input:{command}}),'json');
});
test('native MCP namespace registrations receive JSON-only projection',async()=>{
 const hooks={}; await installContextCompression({mcp:{transform:async fn=>fn({list:()=>[['example-server',{}]]})},tool:{list:async()=>[{name:'list_records',options:{namespace:'example-server'}}],hook:async(n,fn)=>{hooks[n]=fn;}}},{save:async(_e,_i,_o,c)=>c.text,diagnostics:quietDiagnostics});
 const e={...base,tool:'example-server_list_records',status:'completed',result:{content:source,output:{unchanged:true}}};
 await hooks['execute.before'](e);await hooks['execute.after'](e);assert.notEqual(e.result.content,source);assert.deepEqual(e.result.output,{unchanged:true});
});
test('terminal events release interrupted or declined root tracking',async()=>{
 const hooks={}; let send;
 const ctx={tool:{hook:async(n,fn)=>{hooks[n]=fn;}},event:{subscribe:async function*(){yield await new Promise(resolve=>{send=resolve;});}}};
 const stop=await installContextCompression(ctx,{save:async(_e,_i,_o,c)=>c.text,diagnostics:quietDiagnostics});
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
test('late MCP registration is discovered and catalog errors leave results intact',async()=>{
 const hooks={};let catalog=[];
 await installContextCompression({mcp:{transform:async fn=>fn({list:()=>[['late',{}]]})},tool:{list:async()=>{if(!catalog)throw Error('reload');return catalog;},hook:async(n,fn)=>{hooks[n]=fn;}}},{save:async(_e,_i,_o,c)=>c.text,diagnostics:quietDiagnostics});
 catalog=[{name:'query',options:{namespace:'late'}}];
 const run=async()=>{const e={...base,tool:'late_query',status:'completed',result:{content:source}};await hooks['execute.before'](e);await hooks['execute.after'](e);return e.result.content;};
 assert.notEqual(await run(),source);catalog=null;assert.equal(await run(),source);
});
test('compression is independent of model family, provider metadata and inference APIs',async()=>{
 // Synthetic routes verify the shared hook contract, not live provider support.
 const hooks={},ctx={tool:{hook:async(n,fn)=>{hooks[n]=fn;}}};
 for(const name of ['aisdk','provider','auth']) Object.defineProperty(ctx,name,{get(){throw Error('compression must not access inference or authentication');}});
 const stop=await installContextCompression(ctx,{save:async(_e,_i,_o,c)=>c.text,diagnostics:quietDiagnostics});
 const projections=[];
 for(const family of ['codex','claude','gemini','local-model','future-family']) {
  const output={original:source},metadata={exit:0};
  const e={...base,id:family,agent:`${family}-worker`,status:'completed',result:{content:source,output,metadata}};
  // Native tool hooks don't require model/provider fields. Future additions must
  // not turn this shared optimization into a provider-specific admission path.
  for(const name of ['model','provider','reasoningEffort']) Object.defineProperty(e,name,{get(){throw Error('compression must not depend on routing metadata');}});
  await hooks['execute.before'](e);await hooks['execute.after'](e);
  assert.notEqual(e.result.content,source);assert.equal(e.result.output,output);assert.equal(e.result.metadata,metadata);
  projections.push(e.result.content);
 }
 assert.equal(new Set(projections).size,1);stop();
});
test('diagnostics classify skips and publication without retaining tool text',async()=>{
 const hooks={}, events=[];
 await installContextCompression({tool:{hook:async(n,fn)=>{hooks[n]=fn;}}},{save:async(_e,_i,_o,c)=>c.text,diagnostics:{record:event=>events.push(event)}});
 const prepared={...base,status:'completed',result:{content:source}};
 await hooks['execute.before'](prepared);await hooks['execute.after'](prepared);
 const unsupported={...base,id:'read',tool:'read',status:'completed',result:{content:source}};
 await hooks['execute.before'](unsupported);await hooks['execute.after'](unsupported);
 const short={...base,id:'short',status:'completed',result:{content:'small'}};
 await hooks['execute.before'](short);await hooks['execute.after'](short);
 assert.deepEqual(events.map(x=>x.reason),['prepared','protected_tool','below_minimum']);
 assert.equal(events[1].originalChars,source.length);
 assert.equal(unsupported.result.content,source);
 const receipt={...base,id:'collection',tool:'task_dispatch_collect',status:'completed',result:{content:source}};
 await hooks['execute.before'](receipt);await hooks['execute.after'](receipt);
 assert.equal(receipt.result.content,source);assert.equal(events.at(-1).reason,'protected_tool');
 assert.ok(events.every(x=>Number.isInteger(x.processingMs) && !Object.values(x).includes(source)));
});
test('observer and diagnostics failures preserve native output',async()=>{
 const hooks={}, e={...base,status:'completed',result:{content:source}};
 await installContextCompression({event:{subscribe:async function*(){throw Error('observer unavailable');}},tool:{hook:async(n,fn)=>{hooks[n]=fn;}}},{save:async(_e,_i,_o,c)=>c.text,diagnostics:{record:()=>{throw Error('telemetry unavailable');}}});
 await hooks['execute.before'](e);await hooks['execute.after'](e);
 assert.notEqual(e.result.content,source);
});
test('native snapshot retrieval is counted without persisting requested paths',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'harness-compression-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const hooks={}, events=[];
 const ctx={tool:{hook:async(n,fn)=>{hooks[n]=fn;}}};
 await installContextCompression(ctx,{save:createOutputStore(directory),snapshotDirectory:directory,diagnostics:{record:event=>events.push(event)}});
 const e={...base,status:'completed',result:{content:source}};await hooks['execute.before'](e);await hooks['execute.after'](e);
 const [record]=await fs.readdir(directory);const chunks=path.join(directory,record,'chunks.jsonl');
 const read={...base,id:'read',tool:'read',input:{path:chunks},status:'completed',result:{content:'native read result'}};
 await hooks['execute.before'](read);await hooks['execute.after'](read);
 assert.equal(events.filter(x=>x.type==='native_original_retrieval').length,1);
 assert.ok(events.every(x=>!JSON.stringify(x).includes(chunks)));
});
test('diff preview marker is honest and the saved snapshot remains exact',async t=>{
 const f=await fixture(t);
 const hunk=file=>`diff --git a/${file} b/${file}\nindex 123..456 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,101 +1,101 @@\n`+Array.from({length:50},(_,i)=>` unchanged context ${i} that is long enough to omit\n`).join('')+'-old required line\n+new required line\n'+Array.from({length:50},(_,i)=>` unchanged trailing context ${i} that is long enough to omit\n`).join('');
 const original=hunk('one.txt')+hunk('two.txt');
 const e={...base,tool:'shell',input:{command:'git diff --cached'},status:'completed',result:{content:original}};
 await f.before(e);await f.after(e);
 assert.match(e.result.content,/diff-context-preview; unchanged context omitted; every file, hunk, and changed line retained; this preview is not an applyable patch/);
 assert.match(e.result.content,/-old required line/);assert.match(e.result.content,/\+new required line/);
 const [record]=(await fs.readdir(f.directory)).filter(x=>!x.startsWith('.'));
 assert.equal(await fs.readFile(path.join(f.directory,record,'original.txt'),'utf8'),original);
});
test('large native grep receives a bounded, recoverable preview with exact omission counts',async t=>{
 const f=await fixture(t);
 const lines=['Found 2100 matches'];
 for(let i=0;i<700;i++) lines.push(`/workspace/src/feature-${i}.ts:`,`  Line ${i * 3 + 1}: match ${i}-a with enough text to make this result large`, `  Line ${i * 3 + 2}: match ${i}-b with enough text to make this result large`, `  Line ${i * 3 + 3}: match ${i}-c with enough text to make this result large`,'');
 const original=lines.join('\n');
 const e={...base,tool:'grep',input:{pattern:'private-token-value'},status:'completed',result:{content:original}};
 await f.before(e);await f.after(e);
 assert.ok(original.length > 150 * 1024);
 assert.match(e.result.content,/harness search-preview; native grep reported 2100 matches/);
 assert.match(e.result.content,/showing 64 matching lines in 22 files; omitted 2036 matching lines and 678 files/);
 assert.match(e.result.content,/Narrow with a more specific path or pattern/);
 assert.match(e.result.content,/this search preview omits results; the exact native original is saved for retrieval/);
 assert.doesNotMatch(e.result.content,/all values\/entries retained|every file, hunk, and changed line retained/);
 assert.ok(e.result.content.length < 16 * 1024);
 const [record]=(await fs.readdir(f.directory)).filter(x=>!x.startsWith('.'));
 assert.equal(await fs.readFile(path.join(f.directory,record,'original.txt'),'utf8'),original);
 const metadata=await fs.readFile(path.join(f.directory,record,'metadata.json'),'utf8');
 assert.ok(!metadata.includes('private-token-value'));
});
test('narrow and unrecognized grep/glob results retain native output',async t=>{
 const f=await fixture(t);
 const narrow=['Found 2 matches','/workspace/src/a.ts:','  Line 3: alpha','','/workspace/src/b.ts:','  Line 9: beta',''].join('\n');
 const unrecognized=Array.from({length:500},(_,i)=>`result ${i}: arbitrary non-native output`).join('\n');
 for(const [tool,content] of [['grep',narrow],['grep',unrecognized],['glob',unrecognized]]) {
  const e={...base,id:`${tool}-${content.length}`,tool,status:'completed',result:{content}};
  await f.before(e);await f.after(e);assert.equal(e.result.content,content);
 }
});
test('large native glob receives a bounded file preview',async t=>{
 const f=await fixture(t);
 const original=Array.from({length:600},(_,i)=>`/shard-${i}/generated-file-${i}.ts`).join('\n');
 const e={...base,tool:'glob',status:'completed',result:{content:original}};
 await f.before(e);await f.after(e);
 assert.match(e.result.content,/native glob returned 600 files; showing 24; omitted 576 files/);
 assert.match(e.result.content,/Narrow with a more specific path or pattern/);
 assert.match(e.result.content,/this search preview omits results; the exact native original is saved for retrieval/);
 assert.doesNotMatch(e.result.content,/all values\/entries retained|every file, hunk, and changed line retained/);
 assert.ok(e.result.content.length < 16 * 1024);
 const [record]=(await fs.readdir(f.directory)).filter(x=>!x.startsWith('.'));
 assert.equal(await fs.readFile(path.join(f.directory,record,'original.txt'),'utf8'),original);
});
test('diagnostics distinguish capacity from unprofitable projections',async t=>{
 const f=await fixture(t),reasons=[];
 const original=source,c=compactToolText(source,'json');
 assert.equal(await createOutputStore(f.directory,{maxRecords:0})(base,0,original,c,r=>reasons.push(r)),undefined);
 assert.equal(reasons.at(-1),'store_record_limit');
 assert.equal(await createOutputStore(f.directory)(base,0,original,{...c,text:original},r=>reasons.push(r)),undefined);
 assert.equal(reasons.at(-1),'no_net_saving');
});
