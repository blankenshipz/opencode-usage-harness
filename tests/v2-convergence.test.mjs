import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeAdmission,userActions} from '../plugins/v2/convergence.mjs';
test('binding and artifact changes reset advisory; receipt wording does not',()=>{
 const r={},s={intentEvidence:{'["root","t"]':{revision:1,checks:{a:{status:'passed',artifact:{subject:'app',revision:'a',generation:1}}}}}},i={taskId:'t',intentRevision:1,operation:'implement',checkIds:['a']};
 for(let n=0;n<3;n++)observeAdmission(r,s,i,'root');
 assert.equal(r.convergence.admissions,3);
 s.intentEvidence['["root","t"]'].checks.a.artifact.revision='b';observeAdmission(r,s,i,'root');assert.equal(r.convergence.admissions,1);
 observeAdmission(r,s,{...i,intentRevision:2},'root');assert.equal(r.convergence.admissions,1);
 assert.deepEqual(userActions([{intentRevision:2,attention:{intentRevision:1,progressState:'needs_user_action'}}],2),[]);
});
