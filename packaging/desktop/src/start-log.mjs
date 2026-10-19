/**
 * The start's live log, for the Details area of the app's status page: every
 * step as it happens, in plain lines. Plain Node, no Electron (tested in
 * packaging/tests/desktop-start-log.test.mjs).
 *
 *   the app's own steps   the events of `<entry> app-backend --json`
 *                         (backend.mjs), in the app's words
 *   the server's steps    what SynaBun's supervisor writes to
 *                         DATA_HOME/data/launcher.log while it starts in the
 *                         background: setup.js's checks and installs (npm
 *                         dependencies, the automation browser's download and
 *                         its progress, the MCP build, the snapshot, the
 *                         registrations), then the server's own lines
 *
 * Only what was written after this start began is read, colour codes and
 * progress redraws are cleaned out, secrets are taken out (log-redact.mjs:
 * tokens, API keys, auth headers, npm auth lines, passwords in URLs, secret
 * variables) before a line is cut or kept, and a few hundred lines are kept.
 * Nothing here is written anywhere: the lines live in the window's memory.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { redactSecrets } from './log-redact.mjs';

export const START_LOG_KEEP = 400;
const LINE_MAX = 600;
const READ_MAX = 256 * 1024;

// CSI (colours, cursor moves) and OSC (titles, links) sequences, and the other escapes a terminal program writes.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Text a program wrote → the lines a person reads: escape sequences out, a
 * line redrawn with carriage returns (a progress bar) as it ended up, other
 * control characters out, secrets out, blank lines dropped, very long lines cut.
 */
export function cleanLogText(text) {
  const out = [];
  for (const raw of redactSecrets(String(text ?? '').replace(ESCAPES, '').replace(/\r\n/g, '\n')).split('\n')) {
    const shown = raw.split('\r').map(part => part.trimEnd()).filter(Boolean).pop() || '';
    const line = redactSecrets(shown.replace(CONTROL, '')).trimEnd();
    if (!line.trim()) continue;
    out.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line);
  }
  return out;
}

/** One event of `<entry> app-backend --json` as a sentence (`t` is the app's translate for its locale), or null. */
export function helperEventLine(event, t) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'plan':
      return event.alternativePort
        ? t('logPlanOtherPort', { preferred: event.preferredPort, port: event.port })
        : t('logPlan', { port: event.port, dataHome: event.dataHome || '?' });
    case 'existing':
      return event.kind === 'ours'
        ? t('logExistingOurs', { port: event.port, version: event.version || '?' })
        : t('logExistingOther', { port: event.port, kind: event.kind || '?' });
    case 'step':
      return t('logStep', { step: event.id || '?' });
    case 'supervisor': {
      const detail = event.detail || {};
      const sized = event.phase === 'snapshot' && Number.isFinite(detail.files) && Number.isFinite(detail.bytes);
      const sentence = sized ? t('snapshotSized', { files: detail.files, megabytes: Math.round(detail.bytes / 1048576) }) : t(event.phase || 'checking');
      return t('logSupervisor', { phase: event.phase || '?', sentence });
    }
    case 'ready':
      return event.started ? t('logReadyStarted', { port: event.port }) : t('logReadyReused', { port: event.port });
    case 'conflict':
      return t('logConflict', { place: event.projectDir || event.install || '?', port: event.port });
    case 'failed':
      return t('logFailed', { message: event.message || event.code || '?' });
    default:
      return null;
  }
}

/**
 * The log itself: lines kept in order (the last `keep`), each with the time it
 * was added, and the listeners that show them as they come.
 */
export function createStartLog({ keep = START_LOG_KEEP, now = () => new Date() } = {}) {
  let lines = [];
  const listeners = new Set();
  const stamp = () => {
    const at = now();
    return [at.getHours(), at.getMinutes(), at.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
  };
  return {
    /** Lines from `source` ('app' for the app's own, 'server' for the supervisor's output). */
    add(source, added) {
      const list = (Array.isArray(added) ? added : [added]).map(line => redactSecrets(String(line ?? ''))).filter(line => line.trim());
      if (!list.length) return [];
      const time = stamp();
      const entries = list.map(text => (source === 'app' ? `${time}  ${text}` : text));
      lines = [...lines, ...entries].slice(-keep);
      for (const listener of listeners) { try { listener({ reset: false, lines: entries }); } catch {} }
      return entries;
    },
    lines: () => lines.slice(),
    clear() {
      lines = [];
      for (const listener of listeners) { try { listener({ reset: true, lines: [] }); } catch {} }
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

/** The size of a file now, or 0 when there is none. */
export function fileSize(path, { stat = statSync } = {}) {
  try { return stat(path).size; } catch { return 0; }
}

/**
 * Follow a log file from byte `from` on: each poll() returns the complete
 * lines written since the last one (cleaned). A file that got shorter was
 * rotated or emptied, and is read again from its start; a line still being
 * written waits for its end.
 */
export function createFileTail({ path, from = 0, fs = { openSync, readSync, closeSync, statSync } } = {}) {
  let offset = Math.max(0, Number(from) || 0);
  let pending = '';
  const decoder = new TextDecoder('utf-8');
  return {
    poll() {
      let size;
      try { size = fs.statSync(path).size; } catch { return []; }
      if (size < offset) { offset = 0; pending = ''; }
      if (size === offset) return [];
      const length = Math.min(size - offset, READ_MAX);
      const buffer = Buffer.alloc(length);
      let read = 0;
      let fd = null;
      try {
        fd = fs.openSync(path, 'r');
        read = fs.readSync(fd, buffer, 0, length, offset);
      } catch {
        return [];
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      }
      offset += read;
      pending += decoder.decode(buffer.subarray(0, read), { stream: true });
      const end = pending.lastIndexOf('\n');
      if (end < 0) {
        if (pending.length > 64 * 1024) { const all = pending; pending = ''; return cleanLogText(all); }
        return [];
      }
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      return cleanLogText(complete);
    },
    /** Whatever is left of a line that never ended (the writer stopped). */
    flush() { const rest = pending; pending = ''; return cleanLogText(rest); },
    get offset() { return offset; },
  };
}

/** The last `count` lines of a log file (cleaned), for a server that stopped: what it said last. */
export function lastLinesOf(path, count = 60, { fs = { openSync, readSync, closeSync, statSync } } = {}) {
  let size;
  try { size = fs.statSync(path).size; } catch { return []; }
  const length = Math.min(size, READ_MAX);
  const buffer = Buffer.alloc(length);
  let fd = null;
  try {
    fd = fs.openSync(path, 'r');
    fs.readSync(fd, buffer, 0, length, size - length);
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  let text = buffer.toString('utf8');
  if (length < size) text = text.slice(text.indexOf('\n') + 1);
  return cleanLogText(text).slice(-count);
}
