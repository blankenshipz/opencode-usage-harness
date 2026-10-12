import test from 'node:test';
import assert from 'node:assert/strict';
import {previewDiff} from '../plugins/v2/diff-preview.mjs';
import {compactToolText} from '../plugins/v2/result-compactor.mjs';
const hunk=(file,n=100)=>`diff --git a/${file} b/${file}\nindex 123..456 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,${n+1} +1,${n+1} @@ symbol\n`+Array.from({length:n/2},(_,i)=>' unchanged long source context before '+i+'\n').join('')+'-old crucial security logic\n+new crucial security logic\n'+Array.from({length:n/2},(_,i)=>' unchanged long source context after '+i+'\n').join('');
test('preview preserves every file/hunk/change and identifies omitted context',()=>{
 const input=hunk('one')+hunk('two');const result=compactToolText(input,'diff');
 assert.equal(result.lossless,false);assert.equal(result.strategy,'diff-context-preview');assert.ok(result.omittedContextLines>0);
 for(const prefix of ['diff --git','@@','+','-','index '])assert.deepEqual(result.text.split('\n').filter(x=>x.startsWith(prefix)),input.split('\n').filter(x=>x.startsWith(prefix)));
 assert.match(result.text,/NOT an applyable patch/);
});
test('small context is untouched and malformed/combined/binary diffs fail open',()=>{
 assert.equal(previewDiff(hunk('small',4)),undefined);
 for(const input of [hunk('bad').replace('@@ -1,101','@@ -1,102'),hunk('bad').replace('@@ -','@@@ -'),hunk('bad')+'GIT binary patch\n',hunk('bad')+'Binary files a and b differ\n']) assert.equal(previewDiff(input),undefined);
});
test('EOF markers retained and additions/deletions in content are never mistaken for headers',()=>{
 const input=hunk('one').replace('-old crucial security logic','--- text that resembles header').replace('+new crucial security logic','+++ another header')+'\\ No newline at end of file\n';
 const result=previewDiff(input);assert.ok(result);assert.ok(result.text.includes('--- text that resembles header'));assert.ok(result.text.includes('+++ another header'));assert.ok(result.text.includes('\\ No newline at end of file'));
});
test('non-diff tools never trigger diff previews',()=>{
 assert.equal(compactToolText(hunk('one'),'json'),undefined);
 assert.equal(compactToolText(hunk('one'),'read'),undefined);
});
test('real Git unified diff preserves the full changed-line sequence',async t=>{
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path'),{execFileSync}=await import('node:child_process');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'harness-diff-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const lines=Array.from({length:150},(_,i)=>`source context ${i} with enough detail to be worth trimming`);
 await fs.writeFile(path.join(dir,'before.txt'),lines.join('\n')+'\n');lines[70]='changed security check';await fs.writeFile(path.join(dir,'after.txt'),lines.join('\n')+'\n');
 let diff;try{diff=execFileSync('git',['diff','--no-index','--unified=40','before.txt','after.txt'],{cwd:dir,encoding:'utf8'});}catch(e){assert.equal(e.status,1);diff=e.stdout;}
 const preview=previewDiff(diff);assert.ok(preview);
 assert.deepEqual(preview.text.split('\n').filter(x=>/^[+-]/.test(x)),diff.split('\n').filter(x=>/^[+-]/.test(x)));
});
