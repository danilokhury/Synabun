// ═══════════════════════════════════════════
// SynaBun Neural Interface — the notice after an automatic restart: what it says
// ═══════════════════════════════════════════
//
// When SynaBun's server crashes after it was up, its supervisor starts it again
// and leaves the new server a record of the crash (lib/server-crash-record.js,
// GET /api/system/crash-notice). The owner's pages say so until it is dismissed:
// that the server stopped unexpectedly and was restarted, when and how it ended,
// and what the restart ended. This module decides the words; ui-crash-notice.js
// asks the server and draws them.
//
// What the restart ends is what the code does when the server process dies and
// a new one starts, nothing more:
//   - terminals: the pty host ends with the server and kills its shells
//     (lib/pty-host/host.js on 'disconnect'); a new host has none of them
//   - runs: dispatched worker runs and native loops that were running are marked
//     interrupted at boot (lib/assistant-dispatch.js, lib/native-loop-runtime.js);
//     Quick Timers, schedule timers set for later and the schedule queue live in
//     memory; saved schedules keep firing. The program a run had started is not
//     always ended with the server: on macOS and Linux a CLI whose input is not
//     the server's (`claude -p`, `codex exec`) ends at its next write to the
//     server, and on Windows one started through a shell is not in the server's
//     job: hence "a step already under way may still finish"
//   - replies: a Claude Code, Codex or Assistant turn in progress is gone, the
//     conversation stays and the next message resumes it (an OpenCode serve that
//     outlived the server may be adopted and go on: hence "may have been")
//   - browser: the sessions SynaBun drove live in memory; their profiles stay
//   - public address: cloudflared is not started again, a new start gets a new
//     one. Windows ends it with the server (its job); on macOS and Linux it
//     outlives a crash, and the new server ends it by its record at start
//     (server.js sweepLeftoverTunnels). One it could not end is `tunnel:
//     'unknown'` in the notice, and the notice says the address may still be open
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/crash-notice-view.test.mjs). CRASH_NOTICE_COPY is the English of every
// sentence; `crashNotice.*` in i18n/en.json must equal it and i18n/pt-BR.json
// must have the same keys.

export const CRASH_NOTICE_COPY = Object.freeze({
  title: 'SynaBun\'s server stopped unexpectedly and was restarted automatically.',
  whenToday: 'It happened at {time}.',
  whenEarlier: 'It happened on {date} at {time}.',
  whenManyToday: 'It happened {count} times, the last at {time}.',
  whenManyEarlier: 'It happened {count} times, the last on {date} at {time}.',
  how: 'How it ended: {exit}.',
  lostTitle: 'What the restart ended',
  lostTerminals: 'Open terminals were closed.',
  lostRuns: 'Agent runs and loops that were running were interrupted, though a step already under way may still finish on its own. Timers and queued runs were cleared. Saved schedules keep running.',
  lostReplies: 'Replies being written in the side panels or the Assistant may have been cut off. The conversations are kept: send again what did not finish.',
  lostBrowser: 'Browser sessions SynaBun was driving ended. Their saved sign-ins are kept.',
  lostTunnel: 'The public address, if it was on, is off. Turning it on again gives a new address.',
  lostTunnelUnknown: 'The public address, if it was on, may still be open: SynaBun could not end the cloudflared that served it. Ending that process, or restarting the computer, closes it.',
  openLogs: 'Open logs',
  openLogsFailed: 'The logs folder could not be opened.',
  dismiss: 'Dismiss',
  label: 'Server restarted after a crash',
  exitCode: 'exit code {code}',
  exitText: '{status}, {kind}',
  kindNativeCrash: 'native crash',
  kindOutOfMemory: 'out of memory',
  kindNodeFatal: 'Node.js fatal error',
  kindError: 'stopped by an error',
  kindKilled: 'ended by force',
  kindInterrupted: 'interrupted',
});

/** The order the notice lists what the restart ended (the last: lostTunnelUnknown for a notice whose `tunnel` is 'unknown'). */
export const CRASH_NOTICE_LOST = Object.freeze(['lostTerminals', 'lostRuns', 'lostReplies', 'lostBrowser', 'lostTunnel']);

/** The word for each kind lib/server-exit.js names; a kind without one shows the status alone. */
export const CRASH_KIND_KEYS = Object.freeze({
  'native-crash': 'kindNativeCrash',
  'out-of-memory': 'kindOutOfMemory',
  'node-fatal': 'kindNodeFatal',
  error: 'kindError',
  killed: 'kindKilled',
  interrupted: 'kindInterrupted',
});

/** A sentence of CRASH_NOTICE_COPY in English with its {values} filled; an unknown key is itself. */
export function fillCrashNoticeCopy(key, params = {}) {
  const text = Object.prototype.hasOwnProperty.call(CRASH_NOTICE_COPY, key) ? CRASH_NOTICE_COPY[key] : key;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? String(params[name]) : whole));
}

const ID = /^[0-9a-f]{16}$/;

/**
 * The notice in an answer of GET /api/system/crash-notice (or a `crash-notice:changed`
 * message: both carry `notice`), checked field by field; null when there is none.
 * `tunnel: 'unknown'` is there only when the server could not end the crashed
 * server's cloudflared.
 */
export function readCrashNotice(answer) {
  const notice = answer && typeof answer === 'object' ? answer.notice : null;
  if (!notice || typeof notice !== 'object' || Array.isArray(notice)) return null;
  if (typeof notice.id !== 'string' || !ID.test(notice.id)) return null;
  const at = Number(notice.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const exit = notice.exit && typeof notice.exit === 'object' && !Array.isArray(notice.exit) ? notice.exit : {};
  return {
    id: notice.id,
    at,
    count: Number.isInteger(notice.count) && notice.count > 0 ? Math.min(notice.count, 999) : 1,
    exit: {
      hex: typeof exit.hex === 'string' && /^0x[0-9a-f]{8}$/i.test(exit.hex) ? `0x${exit.hex.slice(2).toUpperCase()}` : '',
      signal: typeof exit.signal === 'string' && /^SIG[A-Z0-9]{1,10}$/.test(exit.signal) ? exit.signal : '',
      code: Number.isInteger(exit.code) ? exit.code : null,
      kind: typeof exit.kind === 'string' && /^[a-z][a-z-]{0,23}$/.test(exit.kind) ? exit.kind : '',
    },
    ...(notice.tunnel === 'unknown' ? { tunnel: 'unknown' } : {}),
  };
}

/** How it ended in the reader's words ("0xC0000409, native crash"), or '' when the record names nothing. */
export function crashExitWords(exit, t = fillCrashNoticeCopy) {
  if (!exit || typeof exit !== 'object') return '';
  const status = exit.hex || exit.signal || (Number.isInteger(exit.code) ? t('exitCode', { code: exit.code }) : '');
  if (!status) return '';
  const key = CRASH_KIND_KEYS[exit.kind];
  return key ? t('exitText', { status, kind: t(key) }) : status;
}

/** When it happened, in the reader's locale: { today, date, time } (the date is for another day). */
export function crashTimeParts(at, { now = Date.now(), locale = undefined } = {}) {
  const when = new Date(at);
  if (!Number.isFinite(when.getTime())) return null;
  const day = new Date(now);
  const today = when.getFullYear() === day.getFullYear() && when.getMonth() === day.getMonth() && when.getDate() === day.getDate();
  const format = (fn, options, fallback) => { try { return fn.call(when, locale, options); } catch { return fallback; } };
  return {
    today,
    date: format(Date.prototype.toLocaleDateString, { dateStyle: 'medium' }, when.toISOString().slice(0, 10)),
    time: format(Date.prototype.toLocaleTimeString, { hour: '2-digit', minute: '2-digit' }, when.toISOString().slice(11, 16)),
  };
}

/**
 * What the notice shows, or null: { id, label, title, when, how, lostTitle, lost[], actions[] }.
 * `t(key, params)` is a sentence of CRASH_NOTICE_COPY in the page's language; `canOpenLogs`
 * says whether this page can open the logs folder (the desktop app, or a page on this computer).
 */
export function crashNoticeView(notice, { t = fillCrashNoticeCopy, now = Date.now(), locale = undefined, canOpenLogs = false } = {}) {
  if (!notice || typeof notice !== 'object' || !notice.id) return null;
  const parts = crashTimeParts(notice.at, { now, locale }) || { today: true, date: '', time: '' };
  const many = notice.count > 1;
  const whenKey = `${many ? 'whenMany' : 'when'}${parts.today ? 'Today' : 'Earlier'}`;
  const exit = crashExitWords(notice.exit, t);
  return {
    id: notice.id,
    label: t('label'),
    title: t('title'),
    when: t(whenKey, { count: notice.count, date: parts.date, time: parts.time }),
    how: exit ? t('how', { exit }) : '',
    lostTitle: t('lostTitle'),
    lost: CRASH_NOTICE_LOST.map((key) => t(key === 'lostTunnel' && notice.tunnel === 'unknown' ? 'lostTunnelUnknown' : key)),
    actions: [
      ...(canOpenLogs ? [{ id: 'logs', label: t('openLogs') }] : []),
      { id: 'dismiss', label: t('dismiss') },
    ],
  };
}

/** True for a page served from this computer's loopback address: the only one the logs folder opens for. */
export function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}
