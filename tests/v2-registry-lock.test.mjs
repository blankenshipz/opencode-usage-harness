import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRegistry } from '../plugins/v2/dispatch-registry.mjs';
const moduleURL = new URL('../plugins/v2/dispatch-registry.mjs', import.meta.url).href;
const workspace = '/synthetic-registry';
const name = crypto.createHash('sha256').update(workspace).digest('hex');
async function fixture(t) {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'registry-crash-'));
 t.after(() => fs.rm(dir, {recursive:true,force:true})); return dir;
}
function owner(dir, delay) {
 return spawn(process.execPath, ['--input-type=module', '-e', `
  import {createRegistry} from ${JSON.stringify(moduleURL)};
  await createRegistry(${JSON.stringify(dir)})(${JSON.stringify(workspace)},async(state,save)=>{
   state.count=(state.count??0)+1;await save();process.stdout.write('held\\n');
   await new Promise(resolve=>setTimeout(resolve,${delay}));
  });`], {stdio:['ignore','pipe','pipe']});
}
test('kernel retains parent ownership after helper exits and releases after normal return',async t=>{
 const dir=await fixture(t), child=owner(dir,350);t.after(()=>child.kill('SIGKILL'));
 await once(child.stdout,'data');const exited=once(child,'close');
 await createRegistry(dir)(workspace,async(state,save)=>{assert.equal(child.exitCode,0);assert.equal(state.count,1);state.count++;await save();});
 await exited;await createRegistry(dir)(workspace,async state=>assert.equal(state.count,2));
});
test('SIGKILL of registry owner releases lock without removing inode or committed state',async t=>{
 const dir=await fixture(t), child=owner(dir,60000);t.after(()=>child.kill('SIGKILL'));
 await once(child.stdout,'data');const before=await fs.stat(path.join(dir,`${name}.flock`));
 const exited=once(child,'close');child.kill('SIGKILL');await exited;
 await createRegistry(dir)(workspace,async(state,save)=>{assert.equal(state.count,1);state.recovered=true;await save();});
 const after=await fs.stat(path.join(dir,`${name}.flock`));assert.equal(after.ino,before.ino);
 await createRegistry(dir)(workspace,async state=>assert.equal(state.recovered,true));
});
test('empty persistent lock file has no publication window; callback failure releases ownership',async t=>{
 const dir=await fixture(t);await fs.writeFile(path.join(dir,`${name}.flock`),'');
 await assert.rejects(createRegistry(dir)(workspace,async()=>{throw Error('fixture failure');}),/fixture failure/);
 await createRegistry(dir)(workspace,async state=>assert.deepEqual(state,{records:[]}));
});
test('legacy lock and reaper markers fail closed without deleting them or entering callback',async t=>{
 const dir=await fixture(t);let entered=false;
 for(const suffix of ['.lock','.lock.recovery']) {
  const marker=path.join(dir,name+suffix);await fs.writeFile(marker,'');
  await assert.rejects(createRegistry(dir)(workspace,async()=>{entered=true;}),/operator reconciliation/);
  assert.equal(await fs.readFile(marker,'utf8'),'');await fs.unlink(marker);
 }
 assert.equal(entered,false);await createRegistry(dir)(workspace,async()=>{entered=true;});assert.equal(entered,true);
});
