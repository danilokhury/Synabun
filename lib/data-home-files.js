import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Sorted depth-first traversal, with no open directory handles or recursive
// calls. A caller can stop after the first file. Never descend through a link.
export function* walkDataHomeTree(root) {
  const pending = [{ directory: resolve(root), names: [''].values() }];
  while (pending.length) {
    const { directory, names } = pending.at(-1);
    const next = names.next();
    if (next.done) {
      pending.pop();
      continue;
    }
    const path = join(directory, next.value);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    yield { path, stat };
    if (stat.isDirectory()) {
      try {
        pending.push({ directory: path, names: readdirSync(path).sort().values() });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

// Hashes run synchronously on this thread. Reuse the scratch space across
// small files and read large databases without allocating their size.
const hashBuffer = Buffer.allocUnsafe(64 * 1024);
export function hashFileSync(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    let bytes;
    while ((bytes = readSync(fd, hashBuffer, 0, hashBuffer.length, null)) > 0) {
      hash.update(hashBuffer.subarray(0, bytes));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}
