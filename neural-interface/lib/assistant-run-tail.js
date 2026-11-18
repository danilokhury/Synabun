// ═══════════════════════════════════════════
// SynaBun — Run transcripts on disk (agent_read after the run)
// ═══════════════════════════════════════════
//
// A dispatched run's transcript tail lived in its live state only: once the worker ended, or the server restarted,
// agent_read format "tail" had nothing, and format "text" had the first 20,000 characters of the last message with
// no way to read the rest. This keeps, per run, in <dataDir>/run-tails/:
//
//   <run>.tail.json   the last transcript lines (the dispatcher's ring, bounded by lines and characters), written
//                     at most once a second while the run works and once more when it ends
//   <run>.text.json   the whole text of the run's last turn (bounded), written when the turn ends
//
// Both are plain files beside the registry, written whole through a temporary file and a rename. They are read
// only when asked (agent_read), never at start. A crash can cost the last second of tail lines, nothing else.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUN_TAIL_LIMITS = Object.freeze({
  flushMs: 1000,
  // The last turn's text that is kept (a worker's report of several hundred thousand characters is still read whole, in pages).
  textChars: 1_000_000,
  // One answer of agent_read carries at most this much text; the rest is read with `offset`.
  pageChars: 20_000,
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
/** A run id as a file name: itself when it is a plain name, else its digest (a test's id may hold anything). */
export function runFileName(runId) {
  const id = String(runId || '');
  return SAFE_ID.test(id) && !id.includes('..') ? id : `x${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

/**
 * One page of a text.
 * Without `offset` the answer is the END of the text, at most `maxChars` (what agent_read always returned); `offset`
 * then says where that page starts, so the part before it can be asked for. With `offset` the page starts there and
 * `nextOffset` is where the following one starts (null at the end).
 * @returns {{ text: string, truncated: boolean, totalChars: number, offset: number, nextOffset: number|null }}
 */
export function pageText(value, { offset = null, maxChars = 4000 } = {}) {
  const text = String(value ?? '');
  const total = text.length;
  const cap = Math.max(1, Math.floor(Number(maxChars)) || 4000);
  if (offset === null || offset === undefined || offset === '') {
    const start = Math.max(0, total - cap);
    return { text: text.slice(start), truncated: start > 0, totalChars: total, offset: start, nextOffset: null };
  }
  const start = Math.max(0, Math.min(total, Math.floor(Number(offset)) || 0));
  const page = text.slice(start, start + cap);
  const end = start + page.length;
  return { text: page, truncated: end < total, totalChars: total, offset: start, nextOffset: end < total ? end : null };
}

/**
 * @param {object} options
 * @param {string} options.dir            <dataDir>/run-tails
 * @param {object} [options.limits]       overrides of RUN_TAIL_LIMITS
 * @param {(tag: string, detail: any) => void} [options.log]
 */
export function createRunTailStore({ dir, limits: limitOverrides = {}, log = () => {} } = {}) {
  if (!dir) throw new Error('createRunTailStore requires dir');
  const limits = { ...RUN_TAIL_LIMITS, ...limitOverrides };
  const dirty = new Map(); // runId → () => string[] (the run's ring now)
  let timer = null;
  let ready = false;

  const tailPath = (runId) => join(dir, `${runFileName(runId)}.tail.json`);
  const textPath = (runId) => join(dir, `${runFileName(runId)}.text.json`);
  function ensureDir() {
    if (ready) return;
    mkdirSync(dir, { recursive: true });
    ready = true;
  }
  function writeWhole(path, value) {
    ensureDir();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, path);
  }
  function readWhole(path) {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
  }
  function writeTail(runId, lines) {
    try { writeWhole(tailPath(runId), { runId: String(runId), updatedAt: new Date().toISOString(), lines: Array.isArray(lines) ? lines : [] }); }
    catch (error) { try { log('assistant:run-tail-error', error?.message || String(error)); } catch { /* nothing to tell */ } }
  }

  /** The run's ring changed: its lines are written soon (once a second at most, however many lines arrive). */
  function touch(runId, lines) {
    if (!runId || typeof lines !== 'function') return;
    dirty.set(String(runId), lines);
    if (timer) return;
    timer = setTimeout(() => { timer = null; flushAll(); }, limits.flushMs);
    timer.unref?.();
  }
  /** Write one run's lines now (it ended, or the server goes down). `lines`: its ring, when the caller has it. */
  function flush(runId, lines = null) {
    const id = String(runId || '');
    const read = dirty.get(id);
    dirty.delete(id);
    const value = Array.isArray(lines) ? lines : (read ? read() : null);
    if (Array.isArray(value)) writeTail(id, value);
  }
  function flushAll() {
    if (timer) { clearTimeout(timer); timer = null; }
    for (const id of [...dirty.keys()]) flush(id);
  }
  /** The lines kept for a run that no longer lives in memory, oldest first ([] when nothing was kept). */
  function readTail(runId) {
    const row = readWhole(tailPath(runId));
    return Array.isArray(row?.lines) ? row.lines.filter((line) => typeof line === 'string') : [];
  }
  /** Keep the whole text of a run's turn (bounded): what agent_read format "text" pages through. */
  function saveText(runId, { turn = null, text = '' } = {}) {
    const whole = String(text ?? '');
    try {
      writeWhole(textPath(runId), {
        runId: String(runId), turn: Number.isFinite(Number(turn)) ? Number(turn) : null, updatedAt: new Date().toISOString(),
        chars: whole.length, cut: whole.length > limits.textChars, text: whole.slice(0, limits.textChars),
      });
    } catch (error) { try { log('assistant:run-tail-error', error?.message || String(error)); } catch { /* nothing to tell */ } }
  }
  /** → { turn, text, chars, cut } or null when no text was kept. */
  function readText(runId) {
    const row = readWhole(textPath(runId));
    return row && typeof row.text === 'string' ? { turn: row.turn ?? null, text: row.text, chars: Number(row.chars) || row.text.length, cut: row.cut === true } : null;
  }
  /** The run left the registry: its files go. */
  function remove(runId) {
    dirty.delete(String(runId || ''));
    for (const path of [tailPath(runId), textPath(runId)]) { try { rmSync(path, { force: true }); } catch { /* gone already */ } }
  }
  /** Files of runs the registry no longer has go (called once at start, with the runs it loaded). */
  function sweep(keep) {
    const names = new Set([...keep].map((runId) => runFileName(runId)));
    let files = [];
    try { files = readdirSync(dir); } catch { return 0; }
    let removed = 0;
    for (const file of files) {
      const match = /^(.+)\.(tail|text)\.json$/.exec(file);
      // A temporary file a crash left behind goes too.
      if (match ? !names.has(match[1]) : /\.tmp$/.test(file)) { try { rmSync(join(dir, file), { force: true }); removed += 1; } catch { /* next start */ } }
    }
    return removed;
  }
  function close() { flushAll(); }

  return { dir, limits, touch, flush, flushAll, readTail, saveText, readText, remove, sweep, close };
}
