// ── Saving over the version that was opened ──
// A Skills Studio save names the revision the editor opened (lib/skills/digest.js revisionOf): when the file on
// disk is not that revision any more (another editor, a pull, an agent changed it), nothing is written and the
// answer says so (409, `revision_conflict`, with the revision that is there now). Otherwise the new bytes go to
// a temporary file in the same folder and are renamed over the old one, so an interrupted save leaves the old
// file whole; the file keeps its permissions, and a link to it inside the skill stays a link.

import { lstatSync } from 'node:fs';
import { PathConfineError } from '../path-confine.js';
import { canonicalInside, readConfinedFile, replaceFileAtomic, writeConfinedFile, MAX_FILE_BYTES } from '../confined-fs.js';
import { revisionOf } from './digest.js';
import { isEditableText } from '../../public/shared/skills/ss-doc.js';

export class RevisionConflictError extends PathConfineError {
  constructor(currentRevision) {
    super(409, currentRevision
      ? 'This file was changed since it was opened. Nothing was written.'
      : 'This file was removed since it was opened. Nothing was written.');
    this.code = 'revision_conflict';
    this.currentRevision = currentRevision;
  }
}

/** A revision as a request may carry it: `sha256:<64 hex>`, or `absent` (the file must not exist yet). */
export const isRevision = (value) => value === 'absent' || (typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value));

/**
 * Read one regular file inside `base`, with its revision.
 * @returns {{ bytes: Buffer, binary: boolean, text: string | null, revision: string, size: number }}
 */
export function readRevisioned(base, path, { maxBytes = MAX_FILE_BYTES } = {}) {
  const bytes = readConfinedFile(base, path, { maxBytes });
  const binary = !isEditableText(bytes);
  return { bytes, binary, text: binary ? null : bytes.toString('utf-8'), revision: revisionOf(bytes), size: bytes.length };
}

/**
 * Write one file inside `base` over the revision it was opened at.
 * @param {string} base the folder the file must really be in
 * @param {string} path
 * @param {Buffer|string} data
 * @param {object} [o]
 * @param {string|null} [o.expectedRevision] what the file must hold now (`absent`: it must not exist). Without one
 *   (a page from before revisions) the file is written as before, but atomically.
 * @param {number} [o.maxBytes] the most the new content may be (413 over it)
 * @param {boolean} [o.refuseBinary] a file that is not text is not replaced (415)
 * @param {boolean} [o.create] a file that does not exist may be created (exclusively)
 * @returns {{ revision: string, created: boolean, path: string }}
 */
export function writeRevisioned(base, path, data, { expectedRevision = null, maxBytes = MAX_FILE_BYTES, refuseBinary = false, create = true } = {}) {
  if (expectedRevision !== null && expectedRevision !== undefined && !isRevision(expectedRevision)) throw new PathConfineError(400, 'Not a revision.');
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf-8');
  if (buf.length > maxBytes) throw new PathConfineError(413, `That is larger than ${Math.max(1, Math.round(maxBytes / (1024 * 1024)))} MB; it was not written.`);
  const real = canonicalInside(base, path);
  let st = null;
  try { st = lstatSync(real); } catch { st = null; }
  if (!st) {
    if (expectedRevision && expectedRevision !== 'absent') throw new RevisionConflictError(null);
    if (!create) throw new PathConfineError(404, 'File not found.');
    writeConfinedFile(base, real, buf, { exclusive: true });
    return { revision: revisionOf(buf), created: true, path: real };
  }
  if (!st.isFile()) throw new PathConfineError(400, 'Not a regular file.');
  const current = readConfinedFile(base, real, { maxBytes: Math.max(maxBytes, MAX_FILE_BYTES) });
  const currentRevision = revisionOf(current);
  // "Create it again" while something made the file meanwhile: what is there is named, never replaced.
  if (expectedRevision === 'absent') throw new RevisionConflictError(currentRevision);
  if (expectedRevision && expectedRevision !== currentRevision) throw new RevisionConflictError(currentRevision);
  if (refuseBinary && !isEditableText(current)) {
    const err = new PathConfineError(415, 'This file is not text: it is not replaced by text. Nothing was written.');
    err.code = 'binary_file';
    throw err;
  }
  replaceFileAtomic(real, buf, {
    mode: st.mode & 0o7777,
    exactMode: true,
    expect: { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size },
  });
  return { revision: revisionOf(buf), created: false, path: real };
}
