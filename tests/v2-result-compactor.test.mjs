import test from 'node:test';
import assert from 'node:assert/strict';
import { compactToolText } from '../plugins/v2/result-compactor.mjs';
test('tables retain every row and raw numeric tokens', () => {
 const rows=Array.from({length:90},(_,i)=>`{"very_long_identifier_column":${i},"very_long_numeric_column":900719925474099312345,"another_long_column":-0}`);
 const source=`[${rows.join(',')}]`, c=compactToolText(source,'json');
 assert.equal(c.strategy,'json-table');assert.equal(JSON.parse(c.text).rows.length,90);
 assert.equal((c.text.match(/900719925474099312345/g)||[]).length,90);
 assert.equal((c.text.match(/-0/g)||[]).length,90);
});
test('minification preserves duplicate keys and quoted whitespace/escapes',()=>{
 const source='[\n'+Array.from({length:90},()=>`    { "key": 1, "key": 2, "s": " keep  spaces \\\" x " }`).join(',\n')+'\n]';
 const c=compactToolText(source,'json'); assert.equal(c.strategy,'json-whitespace');
 assert.equal((c.text.match(/"key":1,"key":2/g)||[]).length,90);assert.ok(c.text.includes(' keep  spaces '));
});
test('exact repeats preserve distinct errors and nonconsecutive repeats',()=>{
 const a='verbose diagnostic line with original path /a/42 and error 9001\n';
 const source=a.repeat(90)+'ERROR 41 /a\nERROR 42 /b\n'+a;
 const c=compactToolText(source,'shell');assert.equal(c.strategy,'exact-repeat-lines');assert.ok(c.text.includes('ERROR 41 /a\nERROR 42 /b\n'));assert.ok(c.text.endsWith(a));assert.match(c.text,/89 repetitions/);
});
test('prefix factoring reconstructs all search entries',()=>{
 const lines=Array.from({length:150},(_,i)=>`/very/long/repository/path/to/source/file${i}.ts:${i}:match`);
 const c=compactToolText(lines.join('\n'),'grep'),data=JSON.parse(c.text);
 assert.deepEqual(data.suffixes.map(x=>data.prefix+x),lines);
});
test('ineligible, source-like, small and huge results pass through',()=>{
 assert.equal(compactToolText('small','json'),undefined);
 assert.equal(compactToolText('x'.repeat(1100000),'shell'),undefined);
 assert.equal(compactToolText('code\n'.repeat(2000),'read'),undefined);
 assert.equal(compactToolText('function name() {\n return 1;\n}\n'.repeat(200),'grep'),undefined);
});
test('native grouped grep retains match text, line numbers and truncation notice',()=>{
 const lines=['Found 100 matches'];for(let i=0;i<100;i++) lines.push(`/very/long/repository/path/to/source/file${i}.ts:`,`  Line ${i}: important different match ${i}`,'');
 lines.push('(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)');
 const c=compactToolText(lines.join('\n'),'grep'),data=JSON.parse(c.text);
 assert.deepEqual(data.lines.map(x=>typeof x==='string'?x:data.prefix+x[0]),lines);
});

// ---- Structured projections below the 16 KiB search-preview floor ----------
const taskRows = (n, failedAt) => Array.from({length:n},(_,i)=>`{"id":"task_${String(i).padStart(4,'0')}_9f8e7d6c","state":"${i===failedAt?'failed':i%3?'completed':'running'}","agent":"harness-builder","model":"anthropic/claude-sonnet-5-5","started_ms":${1763500000000+i},"outcome":"${i===failedAt?'error':'ok'}"${i===failedAt?',"error":"ENOENT: no such file or directory, open /workspace/src/missing.ts"':''},"workKey":"work-${i}"}`);
const statusJson = `{"status":"ok","generation":12345678901234567890,"counts":{"total":30,"running":10,"failed":1},"tasks":[${taskRows(30,17).join(',')}]}`;
test('compact status JSON keeps ids, states, counts, raw numbers and error entries',()=>{
 assert.ok(statusJson.length>4096 && statusJson.length<16*1024);
 assert.equal(JSON.stringify(JSON.parse(statusJson)).length,statusJson.length,'already minified: whitespace removal cannot help');
 const c=compactToolText(statusJson,'json'); assert.equal(c.strategy,'status-json'); assert.equal(c.lossless,false);
 assert.ok(statusJson.length-c.text.length>=512 && c.text.length<=statusJson.length*0.85);
 const [header,body]=c.text.split('\n'); const data=JSON.parse(body);
 assert.match(header,/24 entries omitted, counted by status/);
 assert.match(body,/"generation":12345678901234567890/);
 assert.deepEqual(data.counts,{total:30,running:10,failed:1});
 assert.deepEqual(data.tasks.slice(0,5).map(t=>t.id),[0,1,2,3,4].map(i=>`task_000${i}_9f8e7d6c`));
 assert.ok(body.includes(taskRows(30,17)[17]),'failed entry is retained verbatim');
 assert.match(data.tasks.at(-1),/omitted 24 of 30 entries; error entries retained; status counts over all 30: running=10, completed=19, failed=1/);
 assert.equal(compactToolText(statusJson,'json').text,c.text,'deterministic');
});
test('status projection folds repeats, truncates long non-error strings and leaves non-status JSON alone',()=>{
 const repeated=`{"state":"idle","pools":[${Array(40).fill('{"provider":"anthropic","remaining_percent":100,"window":"5h"}').join(',')}],"log":"${'x'.repeat(2000)}","stderr":"${'warning line '.repeat(150)}"}`;
 const c=compactToolText(repeated,'json'); assert.equal(c.strategy,'status-json');
 const data=JSON.parse(c.text.split('\n')[1]);
 assert.deepEqual(data.pools,[{provider:'anthropic',remaining_percent:100,window:'5h'},'[harness: previous entry repeated 39 more times]']);
 assert.match(data.log,/^x{240}…\[\+1760 chars\]$/); assert.equal(data.stderr,'warning line '.repeat(150));
 const plain=`[${Array.from({length:60},(_,i)=>`{"name":"item-${i}","description":"plain record without any lifecycle field ${i}"}`).join(',')}]`;
 assert.notEqual(compactToolText(plain,'json')?.strategy,'status-json');
});
test('pretty status JSON under 16 KiB prefers the lossless whitespace projection',()=>{
 const pretty=JSON.stringify(JSON.parse(statusJson.replace('12345678901234567890','1')),null,2);
 assert.ok(pretty.length<16*1024); assert.equal(compactToolText(pretty,'json').strategy,'json-whitespace');
});
const rgOutput=()=>{const lines=[];for(let f=0;f<12;f++)for(let m=0;m<9;m++)lines.push(`src/module-${f}/index.ts:${m*10+1}:  const value${m} = computeSomething(input, options); // TODO`);lines.splice(3,0,'rg: ./private: Permission denied (os error 13)');return lines.join('\n')+'\n';};
test('rg/grep text groups matches by file with counts and keeps error lines',()=>{
 const original=rgOutput(); assert.ok(original.length<16*1024);
 assert.equal(compactToolText(original,'json'),undefined,'the old shell classification had no useful projection');
 const c=compactToolText(original,'search'); assert.equal(c.strategy,'grep-groups');
 assert.match(c.text,/^\[harness grep-groups; 108 matching lines in 12 files; showing 60 matching lines; omitted 48\./);
 assert.match(c.text,/\nrg: \.\/private: Permission denied \(os error 13\)\n/);
 assert.match(c.text,/\nsrc\/module-0\/index\.ts: \(9 matches\)\n  1:   const value0 = computeSomething\(input, options\); \/\/ TODO\n/);
 assert.match(c.text,/  \[\+4 more matches in this file\]/);
 const single=Array.from({length:120},(_,i)=>`${i*4+1}:    expect(result.value).toEqual(expectedValue${i}); // assertion`).join('\n');
 const s=compactToolText(single,'search'); assert.equal(s.strategy,'grep-groups'); assert.match(s.text,/120 matching lines in 1 files; showing 60/);
 assert.equal(compactToolText('free-form log text that is not grep output\n'.repeat(200),'search'),undefined);
});
const gitOutput=()=>{const g=['On branch main',"Your branch is ahead of 'origin/main' by 3 commits.",'','Unmerged paths:','\tboth modified:   src/conflicted.ts','','Changes not staged for commit:'];
 for(let i=0;i<40;i++)g.push(`\tmodified:   plugins/v2/generated/module-${i}.mjs`);
 g.push('','Untracked files:');for(let i=0;i<30;i++)g.push(`\ttmp/scratch-output-${i}.json`);
 g.push('---');for(let i=0;i<40;i++)g.push(` plugins/v2/generated/module-${i}.mjs | ${i+3} +++++-----`);
 g.push(' 40 files changed, 400 insertions(+), 380 deletions(-)','---','warning: refname HEAD is ambiguous.');
 for(let i=0;i<25;i++)g.push(`${(0xabc1234+i).toString(16)} Fix generated module ${i} handling of edge cases`);return g.join('\n')+'\n';};
test('compound git status/diff --stat/log output keeps summaries and errors and counts collapsed lists',()=>{
 const original=gitOutput(); assert.ok(original.length<16*1024);
 assert.equal(compactToolText(original,'json'),undefined,'the old shell classification had no useful projection');
 const c=compactToolText(original,'git'); assert.equal(c.strategy,'git-summary');
 for(const line of ['On branch main',"Your branch is ahead of 'origin/main' by 3 commits.",'\tboth modified:   src/conflicted.ts',' 40 files changed, 400 insertions(+), 380 deletions(-)','warning: refname HEAD is ambiguous.','\tmodified:   plugins/v2/generated/module-9.mjs','abc123d Fix generated module 9 handling of edge cases'])
  assert.ok(c.text.includes(`\n${line}\n`),line);
 assert.match(c.text,/\[harness: \+30 more status lines omitted \(of 40; modified=30\)\]/);
 assert.match(c.text,/\[harness: \+20 more status lines omitted \(of 30; untracked=20\)\]/);
 assert.match(c.text,/\[harness: \+30 more diffstat lines omitted \(of 40\)\]/);
 assert.match(c.text,/\[harness: \+15 more commit lines omitted \(of 25\)\]/);
 assert.doesNotMatch(c.text,/module-39\.mjs/);
 const log=Array.from({length:30},(_,i)=>`commit ${String(i).padStart(2,'0')}${'a'.repeat(38)}\nAuthor: Dev <dev@example.invalid>\nDate:   Tue Nov 18 10:00:${String(i).padStart(2,'0')} 2026 +0000\n\n    Subject line for change ${i}\n\n    Body paragraph explaining change ${i} in some detail.\n`).join('\n');
 const l=compactToolText(log,'git'); assert.equal(l.strategy,'git-summary');
 assert.match(l.text,/Body paragraph explaining change 4 /); assert.doesNotMatch(l.text,/Body paragraph explaining change 5 /);
 assert.match(l.text,/\n05aaaaaaaaaa Subject line for change 5\n/); assert.match(l.text,/\[harness: \+10 older commits omitted\]/);
});
test('native grep between 4 and 16 KiB gets a grouped preview when no lossless form helps',()=>{
 const lines=['Found 80 matches'];for(let f=0;f<10;f++){lines.push(`/w/s${f}/x.ts:`);for(let m=0;m<8;m++)lines.push(`  Line ${m+1}: const generatedValue${m} = computeTheThing(alpha, beta, gamma);`);lines.push('');}
 const original=lines.join('\n'); assert.ok(original.length>4096&&original.length<16*1024);
 const c=compactToolText(original,'grep'); assert.equal(c.strategy,'search-preview');
 assert.match(c.text,/listed 80 matching lines in 10 files; showing 30 matching lines in 10 files; omitted 50/);
});
