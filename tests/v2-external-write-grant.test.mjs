import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeExternalWrites, canonicalExternalPath } from '../plugins/v2/external-write-grant.mjs';

const binding = { workspace:'WORKSPACE', rootID:'root', parentID:'root', childID:'child', taskId:'release', workKey:'migration', intentRevision:2, checkIds:['one','two'], agent:'builder', operation:'implement' };
async function fixture(t, change = {}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'grant-test-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const config=path.join(dir,'config'), workspace=path.join(dir,'workspace'), external=path.join(dir,'external');
  await Promise.all([fs.mkdir(config),fs.mkdir(workspace),fs.mkdir(external)]);
  const grant={version:1,grantID:'grant-1',...binding,workspace:await canonicalExternalPath(workspace),externalRoot:await canonicalExternalPath(external),expiresAt:'2099-01-01T00:00:00.000Z',revoked:false,...change};
  const file=path.join(config,'external-write-grants.json'); await fs.writeFile(file,JSON.stringify({version:1,grants:[grant]}),{mode:0o600}); await fs.chmod(file,0o600);
  return {dir,config,workspace,external,file,grant};
}
test('external grant requires exact existing-child binding, safe operator file, and root containment',async t=>{
 const f=await fixture(t); const request={...binding,workspace:f.workspace,grantID:'grant-1',destinations:[path.join(f.external,'new','target')],grantPath:f.file,configRoot:f.config};
 const granted=await authorizeExternalWrites(request); assert.equal(granted.grantID,'grant-1');assert.equal(granted.destinations[0],path.join(f.grant.externalRoot,'new','target'));
 await assert.rejects(authorizeExternalWrites({...request,childID:'other'}),/does not match/);
 await assert.rejects(authorizeExternalWrites({...request,destinations:[path.join(f.dir,'elsewhere')]}),/does not cover/);
 await fs.chmod(f.file,0o644); await assert.rejects(authorizeExternalWrites(request),/0600/);
});
test('canonical external destination rejects symlink components and permits a missing suffix',async t=>{
 const f=await fixture(t); const outside=path.join(f.dir,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.external,'linked'));
 await assert.rejects(canonicalExternalPath(path.join(f.external,'linked','new')),/unsafe symlink/);
 assert.equal(await canonicalExternalPath(path.join(f.external,'missing','leaf')),path.join(await canonicalExternalPath(f.external),'missing','leaf'));
});
