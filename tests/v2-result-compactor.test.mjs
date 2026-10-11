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
