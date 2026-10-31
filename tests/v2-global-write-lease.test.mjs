import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writerPathsOverlap, pruneWriterLeases, reserveWriterLease, finishWriterLease } from '../plugins/v2/global-write-lease.mjs';

const lease=(token,key,paths,extra={})=>({token,key,workspace:'/workspace',paths,...extra});
test('global leases reject ancestor and child path collisions but retain disjoint writers',()=>{
 const state={leases:[]};reserveWriterLease(state,lease('a','a',['/dst/source']),{sessions:[]});
 assert.throws(()=>reserveWriterLease(state,lease('b','b',['/dst/source/file']),{sessions:[]}),error=>/overlapping/.test(error.message)&&error.message.includes('owned by a')&&error.message.includes('requested paths: /dst/source/file')&&error.message.includes('conflicting paths: /dst/source'));
 reserveWriterLease(state,lease('c','c',['/dst/other']),{sessions:[]});assert.equal(state.leases.length,2);
 assert.equal(writerPathsOverlap(['/dst/source'],['/dst/source/file']),true);
});
test('a lease persists across pending native admission and active descendants, then releases when idle',()=>{
 const state={leases:[]};reserveWriterLease(state,lease('a','a',['/dst'],{childID:'child'}),{sessions:[]});
 assert.equal(pruneWriterLeases(state,{sessions:[],isPidLive:()=>true}),false);
 finishWriterLease(state,'a',{childID:'child'});
 assert.equal(pruneWriterLeases(state,{sessions:[{id:'child',active:false},{id:'leaf',parentID:'child',active:true}]}),false);
 assert.equal(pruneWriterLeases(state,{sessions:[{id:'child',active:false},{id:'leaf',parentID:'child',active:false}]}),true);
});
test('same workspace/key continuation and declared ancestor delegation do not self-conflict',()=>{
 const state={leases:[]};reserveWriterLease(state,lease('a','same',['/dst'],{childID:'child'}),{sessions:[]});
 reserveWriterLease(state,lease('b','same',['/dst/file']),{sessions:[]});
 reserveWriterLease(state,lease('c','other',['/dst/file']),{sessions:[],delegatedOwner:()=>true});
 assert.equal(state.leases.length,3);
});
test('active children and unknown provisional identities fail closed even when an admitting pid is dead',()=>{
 const active={leases:[lease('a','a',['/dst'],{inFlight:true,ownerPid:99,childID:'child'})]};
 assert.equal(pruneWriterLeases(active,{sessions:[{id:'child',active:true}],isPidLive:()=>false}),false);
 const unknown={leases:[lease('b','b',['/dst'],{inFlight:true,ownerPid:99})]};
 assert.equal(pruneWriterLeases(unknown,{sessions:[],isPidLive:()=>false}),false);
 assert.equal(writerPathsOverlap(['/'],['/any/path']),true);
 assert.throws(()=>pruneWriterLeases({leases:[null]}),/invalid/);
});
