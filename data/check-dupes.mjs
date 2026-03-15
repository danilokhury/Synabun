import { readdirSync, openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';

const dir = 'C:/Users/danil/.claude/projects/J--Sites-Apps-Synabun';
const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
const sidMap = new Map();
let noUser = 0;

for (const f of files) {
  const fd = openSync(join(dir, f), 'r');
  const buf = Buffer.alloc(16384);
  const n = readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const lines = buf.toString('utf-8', 0, n).split('\n');
  let found = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && obj.message) {
        const sid = obj.sessionId || f.replace('.jsonl', '');
        if (!sidMap.has(sid)) sidMap.set(sid, []);
        sidMap.get(sid).push(f);
        found = true;
        break;
      }
    } catch {}
  }
  if (!found) noUser++;
}

const dupes = [...sidMap.entries()].filter(([, v]) => v.length > 1);
console.log('Unique sessionIds:', sidMap.size);
console.log('Files with user msg:', files.length - noUser);
console.log('Files without user msg:', noUser);
console.log('Duplicate sessionIds:', dupes.length, '(covering', dupes.reduce((a, [, v]) => a + v.length, 0), 'files)');
if (dupes.length > 0) {
  dupes.slice(0, 5).forEach(([sid, fs]) => console.log('  ', sid, '->', fs.length, 'files'));
}
