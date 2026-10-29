/**
 * Why SynaBun's server stopped, as its supervisor recorded it: a sentence for
 * the status page's "server stopped" state and a line for its Details.
 *
 * setup.js keeps DATA_HOME/data/supervisor.json (lib/start-launcher.js
 * openSupervisorRecord). A server that crashes after it was up is started
 * again by the supervisor (lib/server-exit.js), so this page shows only when it
 * gave up: the server kept crashing (RESTART_LOOP), or it ended again before
 * it was listening (SERVER_EXITED). Then the record's `error` names the exit:
 * `exitHex` or `exitSignal` or `exitCode`, and its `exitKind`. A stop someone
 * asked for leaves no error, and the page says what it always said.
 *
 * Plain Node, no Electron: tested in packaging/tests/desktop-server-exit.test.mjs.
 */

import { readFileSync } from 'node:fs';

/** The app's word for each kind lib/server-exit.js names (i18n.mjs); a kind without one shows the status alone. */
export const EXIT_KIND_KEYS = Object.freeze({
  'native-crash': 'exitKindNativeCrash',
  'out-of-memory': 'exitKindOutOfMemory',
  'node-fatal': 'exitKindNodeFatal',
  error: 'exitKindError',
  killed: 'exitKindKilled',
  interrupted: 'exitKindInterrupted',
});

/** DATA_HOME/data/supervisor.json, or null. */
export function readSupervisorRecord(path, { read = readFileSync } = {}) {
  try {
    const record = JSON.parse(read(path, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

/** A record error's exit in the reader's words ("0xC0000409, falha nativa"), or '' when it names none. */
export function exitWords(error, t) {
  if (!error || typeof error !== 'object') return '';
  const hex = typeof error.exitHex === 'string' && /^0x[0-9a-f]{8}$/i.test(error.exitHex) ? `0x${error.exitHex.slice(2).toUpperCase()}` : '';
  const signal = typeof error.exitSignal === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(error.exitSignal) ? error.exitSignal : '';
  const code = Number.isInteger(error.exitCode) ? error.exitCode : null;
  const status = hex || signal || (code !== null ? t('exitCode', { code }) : '');
  if (!status) return '';
  const key = EXIT_KIND_KEYS[error.exitKind];
  return key ? t('exitText', { status, kind: t(key) }) : status;
}

/**
 * True when the record says that the supervisor this window used (its pid,
 * when the app knows it) gave up after `since`: the crash-loop guard stopped
 * it, or the server it started never came up. Its server will not come back,
 * though the process may still take a moment to write its logs (what Windows
 * recorded about a crash, lib/server-supervisor.js), so the app shows the
 * stopped page, and stops waiting for it when it quits, without waiting for it.
 */
export function supervisorGaveUp(record, { supervisorPid = null, since = 0 } = {}) {
  if (!record || typeof record !== 'object' || record.phase !== 'failed') return false;
  if (!Number.isFinite(Number(record.endedAt)) || Number(record.endedAt) < Number(since || 0)) return false;
  if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) return false;
  return record.pid === supervisorPid;
}

/**
 * What the stopped page adds, { hint, log, exit }, or null: only for the
 * record of the supervisor this window used (its pid, when the app knows it),
 * ended no earlier than `since`, with an error that names an exit.
 */
export function stoppedExplanation(record, { supervisorPid = null, since = 0, t }) {
  if (!record || typeof record !== 'object' || !record.error || typeof record.error !== 'object') return null;
  if (!Number.isFinite(Number(record.endedAt)) || Number(record.endedAt) < Number(since || 0)) return null;
  if (Number.isInteger(supervisorPid) && supervisorPid > 0 && record.pid !== supervisorPid) return null;
  const exit = exitWords(record.error, t);
  if (!exit) return null;
  return {
    exit,
    hint: t(record.error.code === 'RESTART_LOOP' ? 'stoppedCrashLoop' : 'stoppedCrashed', { exit }),
    log: t('logServerExit', { exit }),
  };
}
