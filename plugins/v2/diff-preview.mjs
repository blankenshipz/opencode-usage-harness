// Independent conservative adaptation of Headroom's diff-context idea (NOTICE).
// A preview, never an applyable patch: retain every file, hunk and changed line.
export function previewDiff(text, context = 3) {
  if (typeof text !== 'string' || !text.startsWith('diff --git ') || text.includes('\r') || !Number.isInteger(context) || context < 1) return;
  const lines = text.split('\n'), output = []; let omitted = 0, hunks = 0, files = 0;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) files++;
    if (line.startsWith('@@@') || line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) return;
    if (!line.startsWith('@@')) { output.push(line); i++; continue; }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (!header || !files) return;
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    if (![oldCount,newCount].every(Number.isSafeInteger)) return;
    let old = 0, added = 0; const body = []; i++;
    while (i < lines.length && (old < oldCount || added < newCount || lines[i] === '\\ No newline at end of file')) {
      const value = lines[i];
      if (value === '\\ No newline at end of file') { if (!body.length) return; body.push(value); i++; continue; }
      if (value.startsWith(' ')) { old++; added++; }
      else if (value.startsWith('-')) old++;
      else if (value.startsWith('+')) added++;
      else return;
      if (old > oldCount || added > newCount) return;
      body.push(value); i++;
    }
    if (old !== oldCount || added !== newCount) return;
    // Reject malformed extra hunk lines instead of silently interpreting them.
    if (i < lines.length && /^[ +\\-]/.test(lines[i]) && lines[i] !== '') return;
    hunks++; output.push(line);
    const keep = new Set();
    body.forEach((value,index) => {
      if (!value.startsWith(' ')) for (let j=Math.max(0,index-context);j<=Math.min(body.length-1,index+context);j++) keep.add(j);
    });
    // Keep each hunk's boundary context too, even in unusual no-change hunks.
    for (let j=0;j<Math.min(context,body.length);j++) {keep.add(j);keep.add(body.length-j-1);}
    for (let j=0;j<body.length;) {
      if (keep.has(j)) { output.push(body[j++]); continue; }
      const start=j;while(j<body.length&&!keep.has(j))j++;
      omitted+=j-start;output.push(`[harness: ${j-start} unchanged context lines omitted; original hunk coordinates retained]`);
    }
  }
  if (!hunks || !omitted) return;
  return { text:'[harness diff preview: NOT an applyable patch; all files, hunks and changed lines retained]\n'+output.join('\n'),
    strategy:'diff-context-preview',lossless:false,omittedContextLines:omitted };
}
