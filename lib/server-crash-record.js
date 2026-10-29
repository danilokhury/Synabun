/**
 * SynaBun — the record of a crash the supervisor recovered from
 *
 * When the server crashes after it was up, its supervisor (lib/server-supervisor.js)
 * starts it again and leaves this record for the server it starts:
 * DATA_HOME/data/server-crash.json. That server shows it to the owner's pages
 * (GET /api/system/crash-notice, neural-interface/lib/crash-notice-api.js) until
 * it is dismissed; a dismissal removes it, so it stays gone in every tab and
 * window, and the next crash writes a new one, with a new id, which shows again.
 *
 * One writer at a time: the supervisor writes the record only while no server
 * runs (between a crash and the next start) and removes it when it ends without
 * a running server after all (the crash-loop guard gave up, the server it
 * started again never came up: the app's stopped page says what happened then);
 * the server removes it, while it runs, when the owner dismisses it. Nothing is
 * written for a stop, a restart, an update or a start that failed.
 *
 * Never throws. `fs` can be handed in (tests).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CRASH_RECORD_NAME = 'server-crash.json';
export const CRASH_RECORD_VERSION = 1;

const NODE_FS = Object.freeze({ mkdirSync, readFileSync, renameSync, rmSync, writeFileSync });
const ID = /^[0-9a-f]{16}$/;
const HEX = /^0x[0-9A-F]{8}$/;
const SIGNAL = /^SIG[A-Z0-9]{1,10}$/;
const KIND = /^[a-z][a-z-]{0,23}$/;

/** Where the record is: beside the supervisor record and the server's logs. */
export function crashRecordPath(dataHome) {
  return join(dataHome, 'data', CRASH_RECORD_NAME);
}

/** A record, checked field by field (what a page is shown comes from here only); null when it is not one. */
export function normalizeCrashRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.v !== CRASH_RECORD_VERSION || typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const firstAt = Number(raw.firstAt);
  const exit = raw.exit && typeof raw.exit === 'object' && !Array.isArray(raw.exit) ? raw.exit : {};
  const uptimeMs = Number(raw.uptimeMs);
  return {
    v: CRASH_RECORD_VERSION,
    id: raw.id,
    at,
    firstAt: Number.isFinite(firstAt) && firstAt > 0 && firstAt <= at ? firstAt : at,
    count: Number.isInteger(raw.count) && raw.count > 0 ? Math.min(raw.count, 999) : 1,
    exit: {
      ...(Number.isInteger(exit.code) ? { code: exit.code } : {}),
      ...(typeof exit.hex === 'string' && HEX.test(exit.hex) ? { hex: exit.hex } : {}),
      ...(typeof exit.signal === 'string' && SIGNAL.test(exit.signal) ? { signal: exit.signal } : {}),
      kind: typeof exit.kind === 'string' && KIND.test(exit.kind) ? exit.kind : 'exit',
    },
    ...(raw.uptimeMs !== undefined && raw.uptimeMs !== null && Number.isFinite(uptimeMs) && uptimeMs >= 0 ? { uptimeMs: Math.round(uptimeMs) } : {}),
  };
}

/** The record in the data home, or null. */
export function readCrashRecord(dataHome, { fs = NODE_FS } = {}) {
  try {
    return normalizeCrashRecord(JSON.parse(fs.readFileSync(crashRecordPath(dataHome), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * The supervisor's side: the server crashed after it was up and is being started
 * again. `exit` is lib/server-exit.js describeExit's answer. A record the owner
 * has not dismissed yet is counted on (`count` + 1, its `firstAt` kept); the id
 * is always new. Written whole (a temporary file renamed over it). Returns the
 * record written, or null.
 */
export function writeCrashRecord(dataHome, { exit = {}, at = Date.now(), uptimeMs = null, pid = process.pid } = {}, {
  fs = NODE_FS, newId = () => randomBytes(8).toString('hex'),
} = {}) {
  const path = crashRecordPath(dataHome);
  const before = readCrashRecord(dataHome, { fs });
  const record = normalizeCrashRecord({
    v: CRASH_RECORD_VERSION,
    id: newId(),
    at,
    firstAt: before ? before.firstAt : at,
    count: before ? before.count + 1 : 1,
    exit: { code: exit?.code, hex: exit?.hex, signal: exit?.signal, kind: exit?.kind },
    uptimeMs,
  });
  if (!record) return null;
  const temp = `${path}.${pid}.tmp`;
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record)}\n`);
    fs.renameSync(temp, path);
    return record;
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch {}
    return null;
  }
}

/**
 * Remove the record: only the one named `id` when an id is given (a page that
 * dismisses an older crash leaves a newer one in place), else whatever is there.
 * Returns true when no record of that id is left.
 */
export function clearCrashRecord(dataHome, { id = null, fs = NODE_FS } = {}) {
  if (id !== null) {
    const current = readCrashRecord(dataHome, { fs });
    if (!current || current.id !== id) return !current;
  }
  try {
    fs.rmSync(crashRecordPath(dataHome), { force: true });
    return true;
  } catch {
    return false;
  }
}
