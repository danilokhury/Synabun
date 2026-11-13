/**
 * Per-loop file logger keyed by terminalSessionId.
 *
 * Writes to data/logs/loop-{terminalSessionId}.log.
 * Format: ISO timestamp | tag | message | JSON metadata
 * Mirrors to console with [loop:{tag}] prefix so existing console workflow still works.
 *
 * Auto-rotates: keeps newest 50 logfiles, deletes older.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { getDataHome } from '../../lib/paths.js';
import { redactTerminalSecrets, scrubTokenText } from './terminal-token-redaction.js';

const DATA_HOME = getDataHome();
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

/** The shape of an id the MCP transport mints for a session (a random UUID): a bearer for that MCP session. */
const MCP_SESSION_ID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The part of the log file's name that stands for `id` (finding 5 of the re-review of 2026-11-11). A run's id names
 * its file as it is (it is nothing without its token, and the log is searched by it). An MCP session's id
 * (`mcpSession`, or an id of its shape) is a bearer, so its file is `mcp-<first 8 characters>-<24 hex of a SHA-256 of
 * the whole id>`: the 8 characters are what the log lines show (sessionLogId / logOwnerId), the digest keeps two
 * sessions whose ids share those 8 characters in two files with two append queues, and cannot be turned back into
 * the id. Before, the file was `loop-mcp-<8 characters>.log`, so two such sessions wrote one file.
 */
export function loopLogFileKey(id, { mcpSession = false } = {}) {
  const text = String(id ?? '');
  if (!text) return '';
  if (!(mcpSession === true || MCP_SESSION_ID_SHAPE_RE.test(text))) return text;
  const digest = createHash('sha256').update(`synabun-loop-log\0${text}`).digest('hex').slice(0, 24);
  return `mcp-${text.slice(0, 8)}-${digest}`;
}

export function loopLogPath(terminalSessionId, options = {}) {
  if (!terminalSessionId) return null;
  return resolve(LOG_DIR, `loop-${loopLogFileKey(terminalSessionId, options)}.log`);
}

/**
 * Append one structured log entry to the per-loop file AND mirror to console.
 * @param {string|null} terminalSessionId — if null, only logs to console
 * @param {string} tag — short identifier (launch, driver, pty, hook, ui, etc.)
 * @param {string} msg — human-readable message
 * @param {object} [meta] — additional structured data (will be JSON-stringified)
 */
// Per-file ordered async append chains. Synchronous appendFileSync used to run
// on the PTY hot path (boot capture, driver ticks) and could stall the event
// loop on slow disks; chaining promises per path keeps line order without
// blocking. Chain entry is removed once its tail settles.
const _appendChains = new Map(); // path → Promise

function _appendOrdered(path, line, terminalSessionId) {
  const prev = _appendChains.get(path) || Promise.resolve();
  const next = prev
    .then(() => appendFile(path, line))
    .catch(err => {
      console.warn(`[loop-logger] append failed for ${terminalSessionId}:`, err.message);
    });
  _appendChains.set(path, next);
  next.finally(() => {
    if (_appendChains.get(path) === next) _appendChains.delete(path);
  });
}

export function loopLog(terminalSessionId, tag, msg, meta = undefined, { mcpSession = false } = {}) {
  const ts = new Date().toISOString();
  // A run's secrets never reach a log line, the file under data/logs or the console (lib/terminal-token-redaction.js):
  // a message or its data may quote what an agent printed or a provider threw, a token included (review 972afb74,
  // finding 5). The JSON is scrubbed again as text, for a value it holds in a form the object walk does not open.
  const safeMeta = (meta && Object.keys(meta).length > 0) ? scrubTokenText(safeJson(redactTerminalSecrets(meta))) : '';
  msg = scrubTokenText(typeof msg === 'string' ? msg : String(msg ?? ''));
  const line = `${ts} | ${tag} | ${msg}${safeMeta ? ' | ' + safeMeta : ''}\n`;

  // Console mirror
  console.log(`[loop:${tag}] ${msg}${safeMeta ? ' ' + safeMeta : ''}`);

  if (!terminalSessionId) return;

  ensureDir();
  rotateOnce();
  const fileKey = loopLogFileKey(terminalSessionId, { mcpSession });
  _appendOrdered(loopLogPath(fileKey), line, fileKey);
}

/**
 * Best-effort drain of queued async appends — await before process exit so
 * in-flight lines (pty:exit forensics especially) reach disk.
 */
export function flushLoopLogs() {
  return Promise.allSettled([..._appendChains.values()]);
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
