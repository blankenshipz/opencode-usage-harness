// Execute with Bun, HARNESS_NATIVE_SOURCE pointing at the patched managed source.
// Service boundaries are fake; the result/observer/completion code is the actual
// staged TypeScript. No provider, shell, DB, or live session is invoked.
import { test, expect, mock } from 'bun:test';
import path from 'node:path';
const root = process.env.HARNESS_NATIVE_SOURCE;
if (!root) throw new Error('HARNESS_NATIVE_SOURCE is required');
const {Context, Effect} = await import(process.env.HARNESS_EFFECT_MODULE || 'effect');
class Sessions extends Context.Service()('fixture/Sessions') {}
class Jobs extends Context.Service()('fixture/Jobs') {}
const core = path.join(root, 'packages/core/src');
mock.module(path.join(core,'session.js'),()=>({Session:{Service:Sessions}}));
mock.module(path.join(core,'job.js'),()=>({Job:{Service:Jobs}}));
const native = await import(path.join(core,'session/subagent-job.ts'));
const completion = await import(path.join(core,'session/subagent-completion.ts'));
const recovery = {kind:'subagent',parentSessionID:'parent-A',childSessionID:'child',agent:'builder',description:'fixture'};
const assistant = (id,text) => ({id,type:'assistant',time:{completed:1},content:[{type:'text',text}]});
const boundary = {id:'admitted-prompt',type:'user',time:{created:1}};
const old = assistant('old-answer','STALE ANSWER');
async function run(sessions,jobs,body) {
 return Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const runner=yield* native.make;return yield* body(runner);
 })).pipe(Effect.provideService(Sessions,sessions),Effect.provideService(Jobs,jobs)));
}
for (const [label,fresh,expected] of [
 ['compaction-only',[],completion.NO_TEXT],
 ['tool-only',[{id:'tool-only',type:'assistant',time:{completed:1},content:[]}],completion.NO_TEXT],
 ['failed assistant',[{...assistant('failed','BAD'),error:{type:'failed'}}],completion.NO_TEXT],
 ['fresh answer',[assistant('new-answer','FRESH')],'FRESH'],
]) test(`actual staged result boundary: ${label}`,async()=>{
 const queries=[];let resumed=0;
 const sessions={messages:input=>Effect.sync(()=>{queries.push(input);return input.cursor?[...fresh]:input.limit===1?[boundary]:[old,...fresh];}),resume:()=>Effect.sync(()=>{resumed++;})};
 const jobs={start:input=>Effect.map(input.run,output=>({output}))};
 const result=await run(sessions,jobs,runner=>runner.start(recovery));
 expect(result.output).toBe(expected);expect(result.output).not.toContain('STALE');expect(resumed).toBe(1);
 expect(queries[1].cursor).toEqual({id:boundary.id,direction:'next'});
});
test('actual cancelled execution cannot return a previous successful answer',async()=>{
 const sessions={messages:()=>Effect.succeed([boundary]),resume:()=>Effect.fail(new Error('cancelled fixture'))};
 const jobs={start:input=>input.run};
 await expect(run(sessions,jobs,runner=>runner.start(recovery))).rejects.toThrow('cancelled fixture');
});
function deliveryFixture() {
 const pending=[{id:'child',notificationID:'notice-A',status:'completed',output:'RESULT A',recovery},
  {id:'child',notificationID:'notice-B',status:'running',recovery:{...recovery,parentSessionID:'parent-B'}}];
 const visible=new Map();const acknowledgements=[];let waits=0;let attempts=0;let reject=false;
 const sessions={synthetic:input=>Effect.gen(function*(){
  attempts++;if(reject)return yield* Effect.fail(new Error('notification admission fixture'));
  visible.set(input.id,input);
 })};
 const jobs={pendingBackground:Effect.sync(()=>pending),wait:()=>Effect.sync(()=>{waits++;return {info:{id:'child',notificationID:'notice-B',started_at:7,status:'running'}};}),completeBackground:id=>Effect.sync(()=>{acknowledgements.push(id);const index=pending.findIndex(r=>r.notificationID===id);if(index>=0)pending.splice(index,1);})};
 const notify=(id='notice-A',owner=recovery)=>run(sessions,jobs,runner=>Effect.gen(function*(){
  yield* runner.notify(owner,7,id);yield* Effect.sleep('20 millis');
 }));
 return {pending,visible,acknowledgements,notify,get waits(){return waits;},get attempts(){return attempts;},set reject(value){reject=value;}};
}
test('terminal generation A delivers while same-child B is still running, including observer restart',async()=>{
 const f=deliveryFixture();await f.notify();
 expect(f.waits).toBe(0);expect(f.visible.size).toBe(1);expect(f.acknowledgements).toEqual(['notice-A']);
 const message=f.visible.get('notice-A');expect(message.sessionID).toBe('parent-A');expect(message.text).toContain('RESULT A');
 expect(f.pending.map(p=>p.notificationID)).toEqual(['notice-B']);
 // A new make/scope simulates process-local observer loss with durable records retained.
 await f.notify();expect(f.visible.size).toBe(1);expect(f.acknowledgements).toEqual(['notice-A']);
 expect(f.pending[0].status).toBe('running');
 f.pending[0].status='completed';f.pending[0].output='RESULT B';
 await f.notify('notice-B',f.pending[0].recovery);
 expect(f.visible.size).toBe(2);expect(f.visible.get('notice-B').sessionID).toBe('parent-B');
 expect(f.visible.get('notice-B').text).toContain('RESULT B');
 expect(f.acknowledgements).toEqual(['notice-A','notice-B']);
});
test('notification admission failure remains pending and restart retries the same receipt once',async()=>{
 const f=deliveryFixture();f.reject=true;await f.notify();
 expect(f.visible.size).toBe(0);expect(f.acknowledgements.length).toBe(0);expect(f.pending[0].notificationID).toBe('notice-A');
 f.reject=false;await f.notify();expect(f.visible.size).toBe(1);expect(f.acknowledgements).toEqual(['notice-A']);
 await f.notify();expect(f.visible.size).toBe(1);expect(f.pending[0].notificationID).toBe('notice-B');
});
test('A completes between pending read and wait: exact generation wait never blocks on B',async()=>{
 let scans=0;let waits=0;const visible=[];const ack=[];
 const original={id:'child',notificationID:'notice-A',status:'completed',output:'RESULT A',recovery};
 const jobs={pendingBackground:Effect.sync(()=>{scans++;return [{...original,status:scans===1?'running':'completed'}];}),
  wait:input=>{expect(input.notificationID).toBe('notice-A');waits++;return input.notificationID?Effect.succeed({timedOut:false}):Effect.never;},
  completeBackground:id=>Effect.sync(()=>ack.push(id))};
 const sessions={synthetic:input=>Effect.sync(()=>visible.push(input))};
 await run(sessions,jobs,runner=>Effect.gen(function*(){yield* runner.notify(recovery,7,'notice-A');yield* Effect.sleep('20 millis');}));
 expect(waits).toBe(1);expect(scans).toBe(2);expect(visible.length).toBe(1);
 expect(visible[0].sessionID).toBe('parent-A');expect(visible[0].text).toContain('RESULT A');expect(ack).toEqual(['notice-A']);
});
