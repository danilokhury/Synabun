/**
 * Per-loop file logger keyed by terminalSessionId.
 *
 * Writes to data/logs/loop-{terminalSessionId}.log.
 * Format: ISO timestamp | tag | message | JSON metadata
 * Mirrors to console with [loop:{tag}] prefix so existing console workflow still works.
 *
 * Auto-rotates: keeps newest 50 logfiles, deletes older.
 */

import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PACKAGE_ROOT = resolve(new URL('..', import.meta.url).pathname, '..');
const DATA_HOME = process.env.SYNABUN_DATA_HOME || PACKAGE_ROOT;
const LOG_DIR = resolve(DATA_HOME, 'data', 'logs');
const MAX_LOG_FILES = 50;

let _ensuredDir = false;
let _rotated = false;

function ensureDir() {
  if (_ensuredDir) return;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    _ensuredDir = true;
  } catch (err) {
    console.warn('[loop-logger] mkdir failed:', err.message);
  }
}

function rotateOnce() {
  if (_rotated) return;
  _rotated = true;
  try {
    if (!existsSync(LOG_DIR)) return;
    const files = readdirSync(LOG_DIR)
      .filter(f => f.startsWith('loop-') && f.endsWith('.log'))
      .map(f => {
        const fp = join(LOG_DIR, f);
        let mtime = 0;
        try { mtime = statSync(fp).mtimeMs; } catch { /* ok */ }
        return { f, fp, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length <= MAX_LOG_FILES) return;
    for (const entry of files.slice(MAX_LOG_FILES)) {
      try { unlinkSync(entry.fp); } catch { /* ok */ }
    }
  } catch (err) {
    console.warn('[loop-logger] rotate failed:', err.message);
  }
}

export function loopLogPath(terminalSessionId) {
  if (!terminalSessionId) return null;
  return resolve(LOG_DIR, `loop-${terminalSessionId}.log`);
}

/**
 * Append one structured log entry to the per-loop file AND mirror to console.
 * @param {string|null} terminalSessionId — if null, only logs to console
 * @param {string} tag — short identifier (launch, driver, pty, hook, ui, etc.)
 * @param {string} msg — human-readable message
 * @param {object} [meta] — additional structured data (will be JSON-stringified)
 */
export function loopLog(terminalSessionId, tag, msg, meta = undefined) {
  const ts = new Date().toISOString();
  const safeMeta = (meta && Object.keys(meta).length > 0) ? safeJson(meta) : '';
  const line = `${ts} | ${tag} | ${msg}${safeMeta ? ' | ' + safeMeta : ''}\n`;

  // Console mirror
  console.log(`[loop:${tag}] ${msg}${safeMeta ? ' ' + safeMeta : ''}`);

  if (!terminalSessionId) return;

  ensureDir();
  rotateOnce();
  try {
    appendFileSync(loopLogPath(terminalSessionId), line);
  } catch (err) {
    console.warn(`[loop-logger] append failed for ${terminalSessionId}:`, err.message);
  }
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj, (_k, v) => {
      if (typeof v === 'string' && v.length > 800) return v.slice(0, 800) + `…(+${v.length - 800})`;
      return v;
    });
  } catch {
    return '<unserializable>';
  }
}

/**
 * Convenience wrapper for hooks that may not know terminalSessionId yet.
 * Reads SYNABUN_TERMINAL_SESSION env var.
 */
export function loopLogFromEnv(tag, msg, meta) {
  loopLog(process.env.SYNABUN_TERMINAL_SESSION || null, tag, msg, meta);
}
