// Run in its own Bun process: these mocks isolate the real patched Job service.
import {test,expect,mock} from 'bun:test';
import path from 'node:path';
const root=process.env.HARNESS_NATIVE_SOURCE;
if(!root)throw new Error('HARNESS_NATIVE_SOURCE is required');
const {Context,Effect,Schema}=await import(process.env.HARNESS_EFFECT_MODULE || 'effect');
class KVService extends Context.Service()('fixture/KV'){}
const core=path.join(root,'packages/core/src');
let next=0;
const ID=Schema.String;
ID.create=()=>`msg_fixture_${++next}`;
mock.module('@opencode/util/effect/app-node',()=>({makeGlobalNode:input=>input}));
mock.module(path.join(core,'kv.js'),()=>({KV:{Service:KVService,node:{}}}));
mock.module(path.join(core,'id/id.js'),()=>({Identifier:{ascending:()=>`fixture_${++next}`}}));
mock.module(path.join(core,'session/message.js'),()=>({SessionMessage:{ID}}));
mock.module(path.join(core,'session/schema.js'),()=>({SessionSchema:{ID:Schema.String}}));
const {make}=await import(path.join(core,'job.ts'));
test('actual Job wait refuses a later generation without waiting and retains both durable receipts',async()=>{
 const records=new Map();const kv={set:(key,value)=>Effect.sync(()=>records.set(key,value)),remove:key=>Effect.sync(()=>records.delete(key)),scan:()=>Effect.sync(()=>({entries:[...records].map(([key,value])=>({key,value}))}))};
 await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const jobs=yield* make;
  const recovery={kind:'subagent',parentSessionID:'parent-A',childSessionID:'child',agent:'builder',description:'fixture'};
  yield* jobs.start({id:'child',type:'subagent',recovery,notificationID:'notice-A',run:Effect.succeed('RESULT A')});
  yield* jobs.wait({id:'child'});yield* jobs.background('child');
  yield* jobs.start({id:'child',type:'subagent',recovery:{...recovery,parentSessionID:'parent-B'},notificationID:'notice-B',run:Effect.never});
  yield* jobs.background('child');
  const result=yield* jobs.wait({id:'child',notificationID:'notice-A'}).pipe(Effect.timeout('100 millis'));
  expect(result.info).toBeUndefined();expect(result.timedOut).toBe(false);
  const pending=yield* jobs.pendingBackground;
  expect(pending.find(p=>p.notificationID==='notice-A')?.output).toBe('RESULT A');
  expect(pending.find(p=>p.notificationID==='notice-B')?.status).toBe('running');
  yield* jobs.completeBackground('notice-A');
  expect((yield* jobs.pendingBackground).map(p=>p.notificationID)).toEqual(['notice-B']);
  expect((yield* jobs.get('child')).status).toBe('running');
 })).pipe(Effect.provideService(KVService,kv)));
});
