// ═══════════════════════════════════════════
// SynaBun — Assistant attachments (POST /api/assistant/attachments)
// ═══════════════════════════════════════════
//
// The composer's paperclip takes any file. Images the brains can see and small
// text files still ride inline in the turn; everything else is streamed to the
// route in assistant-api.js and saved here, under
// DATA_HOME/data/attachments/<session>/<upload id>/<name>. The prompt carries
// the absolute path and the brain reads the file with its own tools, so a PDF
// reaches Claude, Codex and OpenCode the same way and a worker can be handed
// the path. Binary bytes never enter a prompt (a raw binary inlined in 2026-03
// corrupted the Claude NDJSON stream). Files are written, never opened or run.

import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The upload cap. The composer checks the same number before it sends. */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
// Most file systems cap a name at 255 bytes; this leaves room for the ones that count differently.
const NAME_MAX_BYTES = 180;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;
// Control characters, characters Windows refuses, the backtick (it would break
// the prompt's code span) and the invisible direction marks that disguise an extension.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f<>:"|?*`\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function attachmentError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

/** "The file is larger than 100 MB" — the refusal both the store and the route give. */
export function tooLargeMessage(maxBytes) {
  const mb = maxBytes / (1024 * 1024);
  return `The file is larger than ${Number.isInteger(mb) ? `${mb} MB` : `${maxBytes} bytes`}`;
}

function clipBytes(text, max) {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > max) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * A name safe to create inside the attachments folder: the last path segment
 * only, no control or reserved characters, no leading dots ("..", hidden
 * files), at most 180 bytes with the extension kept. Never empty.
 */
export function sanitizeAttachmentName(name) {
  let base = String(name ?? '').normalize('NFC').split(/[\\/]/).pop() || '';
  base = base.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  if (Buffer.byteLength(base) > NAME_MAX_BYTES) {
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 && base.length - dot <= 16 ? base.slice(dot) : '';
    base = `${clipBytes(base.slice(0, base.length - ext.length), NAME_MAX_BYTES - Buffer.byteLength(ext)).trimEnd()}${ext}`;
  }
  return base || 'attachment';
}

/** The per-session folder: the assistant session id when it is a plain id, else "unsorted". */
export function attachmentSessionFolder(sessionId) {
  const id = String(sessionId ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) ? id : 'unsorted';
}

/** A MIME type as the browser reported it, or application/octet-stream. */
export function normalizeAttachmentMime(value) {
  const mime = String(value ?? '').trim().toLowerCase();
  return mime.length <= 127 && /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function uploadFolder(ms) {
  const stamp = new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return `${stamp}-${randomBytes(4).toString('hex')}`;
}

/**
 * createAttachmentStore({ root }) → { root, maxBytes, save(source, meta) }.
 * save() streams `source` (the request) to <root>/<session>/<upload id>/<name>
 * and resolves { path, name, size, mime } with the absolute path. Past
 * `maxBytes` it stops, removes what it wrote and rejects with
 * ATTACHMENT_TOO_LARGE (413); an aborted upload is removed the same way.
 */
export function createAttachmentStore({ root, maxBytes = ATTACHMENT_MAX_BYTES, now = Date.now } = {}) {
  if (!root) throw new Error('createAttachmentStore requires a root');
  const base = resolve(root);

  async function save(source, { name, sessionId = null, mime = '' } = {}) {
    const fileName = sanitizeAttachmentName(name);
    const dir = join(base, attachmentSessionFolder(sessionId), uploadFolder(now()));
    const path = join(dir, fileName);
    // The name and the folders are sanitized above; this is the backstop.
    if (!path.startsWith(`${base}${sep}`)) throw attachmentError('ATTACHMENT_INVALID_NAME', 'Invalid attachment name', 400);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let size = 0;
    const cap = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > maxBytes) done(attachmentError('ATTACHMENT_TOO_LARGE', tooLargeMessage(maxBytes), 413));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(source, cap, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return { path, name: fileName, size, mime: normalizeAttachmentMime(mime) };
  }

  return { root: base, maxBytes, save };
}
