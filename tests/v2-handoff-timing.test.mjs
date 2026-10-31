import {test} from 'node:test';
import assert from 'node:assert/strict';
import {beginHandoffTiming,acceptHandoffTiming,collectHandoffTiming,handoffTimingStatus} from '../plugins/v2/handoff-timing.mjs';
import {summarizeTaskDispatchStatus} from '../plugins/v2/task-dispatch-status-summary.mjs';

test('handoff timing separates exact completion, collection and accepted continuation across restart',()=>{
 let record={childID:'child'};
 beginHandoffTiming(record,1,100);acceptHandoffTiming(record,1,'child',110);
 collectHandoffTiming(record,{generation:1,completedAt:200},250);
 record=JSON.parse(JSON.stringify(record));
 beginHandoffTiming(record,2,400);
 assert.equal(handoffTimingStatus(record).generations[0].collectionToContinuationMs,null,'admission is not acceptance');
 acceptHandoffTiming(record,2,'child',420);
 const first=handoffTimingStatus(record).generations[0];
 assert.equal(first.completionToCollectionMs,50);assert.equal(first.collectionToContinuationMs,170);assert.equal(first.completionToContinuationMs,220);assert.equal(first.continuationGeneration,2);
 collectHandoffTiming(record,{generation:1,completedAt:999},999);assert.equal(record.handoffTimings[0].collectedAt,250);
});
test('unknown or invalid clocks and generations are never fabricated as zero',()=>{
 const legacy={childID:'child'};collectHandoffTiming(legacy,{generation:1,completedAt:200},250);
 assert.deepEqual(handoffTimingStatus(legacy).generations,[]);
 beginHandoffTiming(legacy,2,100);acceptHandoffTiming(legacy,2,'child',110);
 collectHandoffTiming(legacy,{generation:1,completedAt:200},250);
 assert.equal(handoffTimingStatus(legacy).generations[0].completionToCollectionMs,null);
 collectHandoffTiming(legacy,{generation:2,completedAt:300},250);
 assert.equal(handoffTimingStatus(legacy).generations[0].completionToCollectionMs,null,'backwards clocks are unknown');
});
test('different child and unaccepted dispatch never settle prior continuation, history and summary are bounded',()=>{
 const r={childID:'old'};beginHandoffTiming(r,1,1);acceptHandoffTiming(r,1,'old',2);
 beginHandoffTiming(r,2,3);assert.equal(r.handoffTimings[0].continuationAcceptedAt,undefined);
 acceptHandoffTiming(r,2,'new',4);assert.equal(r.handoffTimings[0].continuationAcceptedAt,undefined);
 for(let g=3;g<=30;g++){beginHandoffTiming(r,g,g*10);acceptHandoffTiming(r,g,'new',g*10+1);}
 assert.equal(r.handoffTimings.length,16);
 const timing=handoffTimingStatus(r);timing.generations[0].prompt='SECRET';
 const status=summarizeTaskDispatchStatus({owners:[{timing}]});
 assert.equal(status.owners[0].timing.generations.length,16);assert.equal(JSON.stringify(status).includes('SECRET'),false);
 const before=JSON.stringify(r);handoffTimingStatus(r);assert.equal(JSON.stringify(r),before);
});
