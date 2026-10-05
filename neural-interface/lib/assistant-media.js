// ═══════════════════════════════════════════
// SynaBun — Assistant media (Image creation / Video creation runs)
// ═══════════════════════════════════════════
//
// The files a worker generated, found by SynaBun itself rather than taken from
// the worker's word:
//   Codex     its built-in image tool saves each image under
//             <CODEX_HOME>/generated_images/<thread>/ and records it in the
//             thread's rollout (an `image_gen.generation` item with its
//             savedPath). `codex exec --json` does not stream that item (CLI
//             0.156.1, tests/fixtures/codex-exec-image-generation.jsonl), so a
//             turn reads its rollout, else the files new in that directory.
//   OpenCode  a model that outputs images or video reports `file` parts
//             (image/… or video/… mime; best effort until such a model is connected).
// The dispatcher copies every file into <dataDir>/media/<runId>/ and the API
// serves only those (GET /api/assistant/runs/:runId/media/:n).

import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCodexRollout } from './assistant-budget.js';

/** Served media types (no SVG: it could carry script on this origin). */
export const MEDIA_TYPES = Object.freeze({
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.m4v': { kind: 'video', mime: 'video/x-m4v' },
});
const MIME_EXT = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' });
export const MAX_MEDIA_PER_RUN = 24;
/** One copied file. */
export const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
/** Every file of one run, all turns together. */
export const MAX_RUN_MEDIA_BYTES = 1024 * 1024 * 1024;
/** One inline (data: URL) file: it is already in memory as base64, so it is capped lower and checked before decoding. */
export const MAX_INLINE_MEDIA_BYTES = 64 * 1024 * 1024;

/** { kind, mime } for a served file name, else null. */
export function mediaType(path) {
  return MEDIA_TYPES[extname(String(path || '')).toLowerCase()] || null;
}

/** The bytes a base64 string decodes to, without decoding it (whitespace counts, so it never undercounts). */
export function base64Bytes(text) {
  const s = String(text || '');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

// O_NOFOLLOW: a symlink swapped in after a check is refused at open (0 where the platform lacks it).
const OPEN_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);

/**
 * Open a checked real path to serve it, once: O_NOFOLLOW, a regular file, and
 * still the file at that very path (same device and inode, real path
 * unchanged), so nothing swapped in after the check is streamed. Returns
 * { handle, size } or null; the caller streams from the handle and closes it.
 */
export async function openServable(realPath) {
  let handle = null;
  try {
    handle = await open(realPath, OPEN_NOFOLLOW);
    const info = await handle.stat();
    const now = lstatSync(realPath);
    if (info.isFile() && now.isFile() && now.dev === info.dev && now.ino === info.ino && realpathSync(realPath) === realPath) return { handle, size: info.size };
  } catch { /* gone, a symlink, or unreadable */ }
  await handle?.close().catch(() => {});
  return null;
}

/**
 * Copy from an open handle into a new file `to`, at most `limit` bytes: past
 * it the copy stops and the partial file is deleted (a source that grew since
 * it was checked). Returns the bytes actually copied, or null.
 */
export async function copyOpenFile(handle, to, limit, { openTarget = (path) => open(path, 'wx') } = {}) {
  const out = await openTarget(to);
  let copied = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, copied);
      if (!bytesRead) break;
      if (copied + bytesRead > limit) throw new Error('over the byte cap');
      // A short write is finished, never skipped: `copied` counts bytes actually written.
      for (let done = 0; done < bytesRead;) {
        const { bytesWritten } = await out.write(buffer, done, bytesRead - done);
        if (!bytesWritten) throw new Error('nothing written');
        done += bytesWritten;
      }
      copied += bytesRead;
    }
    // The source must still be exactly what was written (it did not change while copying).
    if ((await handle.stat()).size !== copied) throw new Error('source changed while copying');
  } catch {
    await out.close().catch(() => {});
    await unlink(to).catch(() => {});
    return null;
  }
  await out.close();
  if (!copied) { await unlink(to).catch(() => {}); return null; }
  return copied;
}

/** The API path of a run's n-th file. */
export function mediaUrl(runId, n) {
  return `/api/assistant/runs/${encodeURIComponent(String(runId))}/media/${n}`;
}

/** A Codex exec stream item that carries a saved image (CLI 0.156.1 streams none; a later one may). */
export function codexStreamMedia(event) {
  if (event?.type !== 'item.completed') return null;
  const item = event.item || {};
  const path = item.saved_path || item.savedPath || null;
  if (!path || !/image/i.test(`${item.type || ''} ${item.kind || ''}`)) return null;
  return { path: String(path), kind: 'image', source: 'stream' };
}

/**
 * The images a Codex rollout recorded at or after `sinceMs`:
 * [{ path, kind: 'image', source: 'rollout', prompt }]. Only lines naming the
 * image tool are parsed (each carries the image as base64, ~1 MB). With
 * `threadId`, an item another thread recorded is not this turn's.
 */
export function codexRolloutMedia(text, { sinceMs = 0, threadId = null } = {}) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line || !line.includes('image_gen.generation')) continue;
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry?.payload;
    const item = payload?.item;
    if (payload?.type !== 'item_completed' || item?.type !== 'Extension' || item.kind !== 'image_gen.generation') continue;
    if ((item.status && item.status !== 'completed') || item.failure || !item.savedPath) continue;
    if (threadId && payload.thread_id && String(payload.thread_id) !== String(threadId)) continue;
    const at = Date.parse(entry.timestamp || '') || Number(payload.completed_at_ms) || 0;
    if (sinceMs && at && at < sinceMs) continue;
    out.push({ path: String(item.savedPath), kind: 'image', source: 'rollout', prompt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt.slice(0, 400) : null });
  }
  return out;
}

/** <CODEX_HOME>/generated_images/<threadId>, or null for a thread id that is not a plain name. */
function codexThreadImages(codexHome, threadId) {
  if (!codexHome || !threadId || /[\\/]|^\.+$/.test(String(threadId))) return null;
  return join(codexHome, 'generated_images', String(threadId));
}

/**
 * The thread's own image folder as a real path, else null: a real directory
 * (a symlinked thread folder points at another thread's images), whose real
 * path is exactly <real generated_images root>/<threadId>.
 */
function verifiedThreadDir(codexHome, threadId) {
  const dir = codexThreadImages(codexHome, threadId);
  if (!dir) return null;
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    const real = realpathSync(dir);
    return real === join(realpathSync(join(codexHome, 'generated_images')), String(threadId)) ? real : null;
  } catch { return null; }
}

/** Files Codex saved under generated_images/<threadId>/ at or after `sinceMs`, oldest first (regular files only, never a symlink). */
export function scanCodexGeneratedImages({ codexHome, threadId, sinceMs = 0 } = {}) {
  if (!verifiedThreadDir(codexHome, threadId)) return [];
  const dir = codexThreadImages(codexHome, threadId);
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const type = mediaType(name);
    if (!type) continue;
    const path = join(dir, name);
    let info = null;
    try { info = lstatSync(path); } catch { continue; }
    if (!info.isFile() || info.mtimeMs < sinceMs) continue;
    rows.push({ path, kind: type.kind, source: 'scan', at: info.mtimeMs });
  }
  return rows.sort((a, b) => a.at - b.at).map(({ at: _at, ...row }) => row);
}

/**
 * The images one Codex turn generated: the rollout's image_gen items of this
 * thread at or after `sinceMs`, else the files new in generated_images/<threadId>/.
 * Either way only a regular file whose real path lies inside that thread's own
 * generated_images/ folder counts. `threadStartedMs` finds the rollout (it
 * lives under the thread's first day).
 */
export async function collectCodexMedia({ codexHome = null, threadId, sinceMs = 0, threadStartedMs = sinceMs, nowMs = Date.now() } = {}) {
  const home = codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  if (!codexThreadImages(home, threadId)) return [];
  const rollout = findCodexRollout({ codexHome: home, threadId, sinceMs: threadStartedMs || sinceMs, nowMs });
  if (rollout) {
    let text = '';
    try { text = await readFile(rollout, 'utf8'); } catch { text = ''; }
    const found = ownCodexImages({ codexHome: home, threadId, items: codexRolloutMedia(text, { sinceMs, threadId }) });
    if (found.length) return found;
  }
  return ownCodexImages({ codexHome: home, threadId, items: scanCodexGeneratedImages({ codexHome: home, threadId, sinceMs }) });
}

/**
 * The items that are regular files whose real path lies inside the thread's
 * own, verified generated_images/<threadId>/ (see verifiedThreadDir).
 */
export function ownCodexImages({ codexHome = null, threadId, items = [] } = {}) {
  const home = codexHome || process.env.CODEX_HOME || join(homedir(), '.codex');
  const dir = verifiedThreadDir(home, threadId);
  if (!dir) return [];
  return items.filter((item) => {
    try { return !!item?.path && lstatSync(item.path).isFile() && realpathSync(item.path).startsWith(dir + sep); } catch { return false; }
  });
}

/**
 * A generated image / video in an OpenCode `file` part: { kind, mime, path }
 * or { kind, mime, data } (base64 from a data: URL), else null.
 */
export function openCodeMediaPart(part) {
  if (!part || part.type !== 'file') return null;
  const mime = String(part.mime || part.mediaType || '').toLowerCase().split(';')[0].trim();
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : null;
  if (!kind) return null;
  const url = String(part.url || '');
  const name = part.filename ? String(part.filename) : null;
  if (url.startsWith('data:')) {
    const match = /^data:[^;,]*(;base64)?,([\s\S]*)$/.exec(url);
    // Too big to keep: never retained, never decoded.
    if (!match?.[1] || !match[2] || base64Bytes(match[2]) > MAX_INLINE_MEDIA_BYTES) return null;
    return { kind, mime, data: match[2], name, source: 'opencode' };
  }
  let path = null;
  if (url.startsWith('file://')) { try { path = fileURLToPath(url); } catch { path = null; } }
  else if (typeof part.source?.path === 'string' && isAbsolute(part.source.path)) path = part.source.path;
  if (!path) return null;
  return { kind, mime, path, name: name || basename(path), source: 'opencode' };
}

function safeName(name, fallbackExt = '') {
  const base = basename(String(name || 'file')).replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-80) || 'file';
  return extname(base) ? base : `${base}${fallbackExt}`;
}

/**
 * Copy generated files into <root>/<runId>/, numbered from `start` so each
 * keeps its index for GET …/media/:n. Only served media types, only regular
 * non-empty files (never a symlink) of at most `maxBytes`, and together at
 * most `budgetBytes` (what the run has left); `sinceMs` refuses a file older
 * than the run (a path the worker named that it did not make). A data item is
 * sized from its base64 before it is decoded (at most `maxInlineBytes`).
 * Returns [{ kind, path, mime, bytes, source, original }].
 */
export async function copyRunMedia({
  root, runId, items = [], start = 0, max = MAX_MEDIA_PER_RUN, sinceMs = 0,
  maxBytes = MAX_MEDIA_BYTES, maxInlineBytes = MAX_INLINE_MEDIA_BYTES, budgetBytes = MAX_RUN_MEDIA_BYTES,
} = {}) {
  if (!root || !runId || /[\\/]|^\.+$/.test(String(runId))) return [];
  const dir = join(root, String(runId));
  const out = [];
  let budget = Math.max(0, Number(budgetBytes) || 0);
  for (const item of items) {
    const n = start + out.length;
    if (n >= max) break;
    try {
      if (item?.data) {
        const ext = MIME_EXT[item.mime];
        const encoded = typeof item.data === 'string' ? item.data : '';
        const size = base64Bytes(encoded);
        if (!ext || !size || size > Math.min(maxInlineBytes, maxBytes) || size > budget) continue;
        const bytes = Buffer.from(encoded, 'base64');
        if (!bytes.length || bytes.length > maxBytes || bytes.length > budget) continue;
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${n}-${safeName(item.name || `${item.kind || 'media'}${ext}`, ext)}`);
        await writeFile(path, bytes);
        budget -= bytes.length;
        out.push({ kind: MEDIA_TYPES[ext].kind, path, mime: MEDIA_TYPES[ext].mime, bytes: bytes.length, source: item.source || null, original: null });
        continue;
      }
      const from = resolve(String(item?.path || ''));
      const type = mediaType(from);
      if (!item?.path || !type) continue;
      // One open, O_NOFOLLOW (a symlink is never followed into the run's media); the checks
      // and the copy use that handle, and the cap holds while copying (a file that grew).
      let handle = null;
      try { handle = await open(from, OPEN_NOFOLLOW); } catch { continue; }
      try {
        const info = await handle.stat();
        if (!info.isFile() || !info.size || info.size > maxBytes || info.size > budget || (sinceMs && info.mtimeMs < sinceMs)) continue;
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${n}-${safeName(from)}`);
        const bytes = await copyOpenFile(handle, path, Math.min(maxBytes, budget));
        if (!bytes) continue;
        budget -= bytes;
        out.push({ kind: type.kind, path, mime: type.mime, bytes, source: item.source || null, original: from });
      } finally { await handle.close().catch(() => {}); }
    } catch { /* unreadable or gone: skipped */ }
  }
  return out;
}

/**
 * The real path the API may serve for a recorded file, else null: inside
 * <root>/<runId>/ by name, the run folder a real folder (not a symlink), the
 * file a regular file (not a symlink), and its real path inside the run
 * folder's real path. A symlink planted in place of a recorded file (or of the
 * run folder) is never followed.
 */
export function servableRunMedia(root, runId, path) {
  if (!insideRunMedia(root, runId, path)) return null;
  try {
    const dir = resolve(root, String(runId));
    if (!lstatSync(dir).isDirectory() || !lstatSync(path).isFile()) return null;
    const realDir = realpathSync(dir);
    if (realDir !== join(realpathSync(root), String(runId))) return null;
    const real = realpathSync(path);
    return real.startsWith(realDir + sep) ? real : null;
  } catch { return null; }
}

/** Is `path` a served media file inside <root>/<runId>/? (the API's guard) */
export function insideRunMedia(root, runId, path) {
  if (!root || !runId || !path || /[\\/]|^\.+$/.test(String(runId))) return false;
  const dir = resolve(root, String(runId));
  const full = resolve(String(path));
  return full.startsWith(dir + sep) && !!mediaType(full);
}
