// Small bounded, atomic records inside the Skills Service's private data directory.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalInside, readConfinedFile, replaceFileAtomic } from '../confined-fs.js';

export function localRecord(dir, name, initial, maxBytes = 16 * 1024 * 1024) {
  const path = join(dir, `${name}.json`);
  return {
    read() {
      try { return JSON.parse(readConfinedFile(dir, path, { encoding: 'utf-8', maxBytes })); }
      catch (e) { if (e.code === 'ENOENT' || e.status === 404) return structuredClone(initial); throw e; }
    },
    write(value) {
      const text = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('Skills record exceeds its storage limit.'), { status: 413, code: 'storage_limit' });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      replaceFileAtomic(canonicalInside(dir, path), text, { mode: 0o600 });
      return value;
    },
  };
}
