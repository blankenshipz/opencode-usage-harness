import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForCompactionIdle} from '../plugins/v2/compaction-wait.mjs';
test('native idle wait only observes the exact child and closes its signal',async()=>{
 let seen,signal;const session={wait:async(input,options)=>{seen=input;signal=options.signal;}};
 assert.equal(await waitForCompactionIdle(session,'child'),'idle');assert.deepEqual(seen,{sessionID:'child'});assert.equal(signal.aborted,true);
});
test('unavailable native wait preserves pending state rather than implying success',async()=>{
 assert.equal(await waitForCompactionIdle({},'child'),'unavailable');
 assert.equal(await waitForCompactionIdle({wait:async()=>{throw new Error('SECRET');}},'child'),'unavailable');
});
test('timeout aborts only the read-only wait, never interrupts or resumes a session',async()=>{
 let signal;const session={wait:async(_,options)=>{signal=options.signal;await new Promise(()=>{});},interrupt:()=>assert.fail('interrupt'),prompt:()=>assert.fail('prompt')};
 assert.equal(await waitForCompactionIdle(session,'child',{timeoutMs:5}),'timeout');assert.equal(signal.aborted,true);
});
