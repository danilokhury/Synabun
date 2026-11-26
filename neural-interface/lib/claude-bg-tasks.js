// ─────────────────────────────────────────────────────────────────────────────
// Claude Code background tasks, from the session's own transcript
//
// The Background tasks view of a panel that runs Claude Code (the Claude Code
// side panel, the Assistant) asks two things here:
//   list(found)            the session's background shells and watches, rebuilt from its transcript with the
//                          same registry and adapter the page folds live messages with
//                          (public/shared/bg-tasks/), so a reload or a server restart starts from what the
//                          session recorded, never from page memory;
//   output(found, q)       a page of what one of them printed.
// `found` is a transcript the caller located and confined (lib/path-confine.js findSessionTranscript).
//
// An output file is read only when the session itself reported it for that task (the result text of its tool
// call, or its task-notification), and only where Claude Code writes them: `claude-<uid>/<project>/<session>/tasks/`
// under the temporary folder, or `<config dir>/projects/<project>/<session>/tool-results|tasks/`. The request
// names a task id, never a path; the real path (every link resolved) must be inside one of those folders, its
// session folder must be the session's, and the file is opened without following a link (lib/confined-fs.js).
// What is read is scrubbed of SynaBun's run secrets with what lies on both sides of the page
// (lib/opencode-shell-read.js readSafeShellOutputPage), exactly as the OpenCode panel's shell output is. It goes
// to the owner's page only: never into a model's context, a transcript or a meter.
// ─────────────────────────────────────────────────────────────────────────────

import { statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readConfinedRange } from './confined-fs.js';
import { isInside, PathConfineError } from './path-confine.js';
import { readSafeShellOutputPage, SHELL_OUTPUT_PAGE_BYTES } from './opencode-shell-read.js';
import { applyBgFact, createBgRegistry, isBgRunning, serializeBgRegistry } from '../public/shared/bg-tasks/bg-tasks-model.js';
import { claudeFactsFromTranscriptLine } from '../public/shared/bg-tasks/bg-tasks-claude.js';

/** The most of a transcript read in one step while it is folded. */
const TRANSCRIPT_CHUNK = 4 * 1024 * 1024;
/** How many transcripts keep their folded registry. */
const CACHE_SIZE = 12;
// Only lines that can carry a fact are parsed (a transcript reaches tens of MB).
const MARKERS = ['"Bash"', '"Monitor"', '"TaskStop"', '"KillShell"', '"KillBash"', 'backgroundTaskId', '"taskId"', 'queue-operation'];

const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };

/**
 * The folders Claude Code writes task output under, for this user: `<tmp>/claude-<uid>` for every temporary
 * folder it may use (`CLAUDE_CODE_TMPDIR`, `/tmp`, the OS one) and `<configDir>/projects`.
 */
export function claudeOutputRoots({ configDirs = [], env = process.env, uid = typeof process.getuid === 'function' ? process.getuid() : null, platform = process.platform, tmp = tmpdir() } = {}) {
  const temps = [env?.CLAUDE_CODE_TMPDIR, platform === 'win32' ? null : '/tmp', tmp].filter(Boolean);
  const names = uid == null ? ['claude'] : [`claude-${uid}`];
  const roots = [];
  for (const t of temps) for (const n of names) roots.push(join(t, n));
  for (const c of configDirs) if (c) roots.push(join(c, 'projects'));
  return [...new Set(roots)];
}

/**
 * Whether `file` is an output file of task `taskId` of session `sessionId` under one of `roots`, every link
 * resolved. → `{ root, real }` (the real root and the real file) or null.
 */
export function confineTaskOutput(file, { sessionId, taskId, roots = [] } = {}) {
  if (typeof file !== 'string' || !file || !TASK_ID.test(String(taskId || '')) || !SESSION_ID.test(String(sessionId || ''))) return null;
  // The name the session reported must already be the task's: `<taskId>.output` (or `<taskId>.<ext>` in tool-results).
  const name = basename(file);
  if (!(name === `${taskId}.output` || name.startsWith(`${taskId}.`))) return null;
  const real = realOrNull(file);
  if (!real) return null;
  // The real file still is the task's, directly in the session's tasks or tool-results folder.
  if (basename(real) !== name) return null;
  const folder = basename(dirname(real));
  if (folder !== 'tasks' && folder !== 'tool-results') return null;
  if (basename(dirname(dirname(real))) !== sessionId) return null;
  for (const root of roots) {
    const realRoot = realOrNull(root);
    if (realRoot && isInside(realRoot, real)) return { root: realRoot, real };
  }
  return null;
}

/** A raw page of a file, cut at UTF-8 character boundaries: `{ status, data: { output, cursor, size } }`. */
export function readFilePage(root, real, { cursor = 0, limit = SHELL_OUTPUT_PAGE_BYTES } = {}) {
  let from = Math.max(0, Math.floor(Number(cursor) || 0));
  const want = Math.max(1, Math.min(SHELL_OUTPUT_PAGE_BYTES, Math.floor(Number(limit) || SHELL_OUTPUT_PAGE_BYTES)));
  let { bytes, size } = readConfinedRange(root, real, { start: from, length: want });
  // A page that starts inside a character starts at the next one.
  let skip = 0;
  while (skip < bytes.length && skip < 3 && (bytes[skip] & 0xc0) === 0x80) skip += 1;
  if (skip) { bytes = bytes.subarray(skip); from += skip; }
  // A page that ends inside a character ends before it (the next page starts there).
  // (Never down to nothing at the end of the file: a file that really ends inside a character is read as it is,
  // or the reader would ask for the same byte forever.)
  let end = bytes.length;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 3 && (bytes[i] & 0xc0) === 0x80) { i -= 1; back += 1; }
  if (i >= 0) {
    const lead = bytes[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > 1 && end - i < need && !(i === 0 && from + bytes.length >= size)) end = i;
  }
  const output = bytes.subarray(0, end).toString('utf8');
  return { status: 200, data: { output, cursor: from + end, size } };
}

/**
 * createClaudeBgTasks({ roots }) — `roots(found)` → the folders output may be read from for that transcript
 * (claudeOutputRoots with the account's config dir).
 */
export function createClaudeBgTasks({ roots = () => claudeOutputRoots(), cacheSize = CACHE_SIZE } = {}) {
  const cache = new Map(); // realPath → { ino, offset, rest, reg }

  function fold(entry, text) {
    const lines = (entry.rest + text).split('\n');
    entry.rest = lines.pop() || '';
    for (const line of lines) {
      if (!line || !MARKERS.some(m => line.includes(m))) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      for (const fact of claudeFactsFromTranscriptLine(obj)) applyBgFact(entry.reg, fact);
    }
  }

  /** The registry of a transcript, folded from where the last read stopped (a file that grew is read on). */
  function registryFor(found) {
    if (!found?.realPath || !found?.realFolder) throw new PathConfineError(404, 'Transcript not found.');
    let st;
    try { st = statSync(found.realPath); } catch { throw new PathConfineError(404, 'Transcript not found.'); }
    let entry = cache.get(found.realPath);
    if (!entry || entry.ino !== st.ino || st.size < entry.offset) {
      entry = { ino: st.ino, offset: 0, rest: '', reg: createBgRegistry() };
    }
    cache.delete(found.realPath);
    cache.set(found.realPath, entry);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    while (entry.offset < st.size) {
      const { bytes } = readConfinedRange(found.realFolder, found.realPath, { start: entry.offset, length: Math.min(TRANSCRIPT_CHUNK, st.size - entry.offset) });
      if (!bytes.length) break;
      // Whole lines only: a line cut by the chunk (or still being written) waits in `rest`.
      entry.offset += bytes.length;
      fold(entry, bytes.toString('utf8'));
    }
    return entry.reg;
  }

  return {
    registryFor,
    /** → { tasks } (serializeBgRegistry). */
    list(found) {
      return serializeBgRegistry(registryFor(found));
    },
    /**
     * A page of one task's output: `{ status, data: { output, cursor, size, from } }`, or `{ ok: false, status, code, error }`.
     * `sessionId` is the transcript's session; `running` says the task may still write (from the caller's live view).
     */
    async output(found, { sessionId, taskId, cursor, tail, limit, running = null } = {}) {
      if (!TASK_ID.test(String(taskId || ''))) return { ok: false, status: 400, code: 'TASK_ID_INVALID', error: 'That is not a background task of this conversation.' };
      const reg = registryFor(found);
      const task = reg.tasks.get(taskId);
      if (!task) return { ok: false, status: 404, code: 'TASK_UNKNOWN', error: 'That is not a background task of this conversation.' };
      if (!task.outputFile) return { ok: false, status: 404, code: 'OUTPUT_NOT_REPORTED', error: 'The session has not said where this task writes yet.' };
      const place = confineTaskOutput(task.outputFile, { sessionId, taskId, roots: roots(found) });
      if (!place) {
        // Gone (the temporary folder was cleaned), or a path that is not one of Claude Code's own output files.
        let exists = false;
        try { statSync(task.outputFile); exists = true; } catch { exists = false; }
        return exists
          ? { ok: false, status: 403, code: 'OUTPUT_NOT_ALLOWED', error: 'That file is not where Claude Code keeps this session\'s task output.' }
          : { ok: false, status: 404, code: 'OUTPUT_GONE', error: 'The output file of that task is no longer there.' };
      }
      const read = (q) => {
        try { return readFilePage(place.root, place.real, q); }
        catch (err) { return { ok: false, status: Number(err?.status) || 500, error: err?.message || 'The output could not be read.' }; }
      };
      const stillRunning = typeof running === 'boolean' ? running : isBgRunning(task);
      const page = await readSafeShellOutputPage(read, { cursor, tail, limit, running: stillRunning });
      if (!page || page.ok === false || !(Number(page.status) < 400)) {
        return { ok: false, status: Number(page?.status) >= 400 ? Number(page.status) : 502, code: 'OUTPUT_FAILED', error: page?.error || 'The output could not be read.' };
      }
      return { status: 200, data: page.data };
    },
    forget(realPath) { cache.delete(realPath); },
  };
}
