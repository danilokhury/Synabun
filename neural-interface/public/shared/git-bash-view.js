// ═══════════════════════════════════════════
// SynaBun Neural Interface — Git Bash for Claude Code: what Settings says
// ═══════════════════════════════════════════
//
// Settings → AI connections → Executable paths has a row for the Git Bash
// that every Claude Code started by SynaBun gets on Windows (the server's
// lib/git-bash/, GET /api/cli/git-bash): the one on the PC, SynaBun's own copy
// of Git for Windows (installed with the app, or downloaded on an npm
// install), its download while it runs, why it failed, and the button that
// tries again. This module reads an answer of the server into what the row
// shows; ui-git-bash.js draws it.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/git-bash-view.test.mjs). GIT_BASH_COPY is the English of every
// sentence; `gitBash.*` in i18n/en.json must equal it and i18n/pt-BR.json must
// have the same keys.
//
// macOS and Linux have nothing to show (Claude Code runs the system's shell
// there): the row stays hidden, as it does for a server from before this,
// which has no such route.

export const GIT_BASH_COPY = Object.freeze({
  label: 'Git Bash for Claude Code (Windows)',
  help: 'Claude Code on Windows runs its Bash tool and its hooks in Git Bash. SynaBun uses the Git for Windows of this PC, or its own copy when the PC has none.',
  badgeSystem: 'On this PC',
  badgeReady: 'SynaBun\'s copy',
  badgeMissing: 'Not found',
  badgeDownloading: 'Downloading',
  badgeFailed: 'Not installed',
  badgeOff: 'Off',
  sourceEnv: 'CLAUDE_CODE_GIT_BASH_PATH names {path}.',
  sourceSettings: 'Your Claude Code settings name {path}.',
  sourceSystem: 'Git for Windows on this PC: {path}',
  sourceSystemPassed: 'Git for Windows on this PC: {path}. Claude Code would not find it by itself, so SynaBun names it.',
  sourceBundled: 'Git for Windows {version}, installed with SynaBun: {path}',
  sourceDownloaded: 'Git for Windows {version}, downloaded by SynaBun: {path}',
  missing: 'No Git Bash on this PC. SynaBun downloads its own copy of Git for Windows {version} ({size} MB) and checks it against its published SHA-256.',
  stepDownload: 'Downloading Git for Windows {version}: {done} of {total} MB',
  stepExtract: 'Unpacking Git for Windows {version}: {percent}%',
  stepVerify: 'Checking every file against the pinned release…',
  stepPlace: 'Putting it in place…',
  failed: 'Git for Windows could not be put in place. {reason}',
  off: 'Turned off: SYNABUN_GIT_BASH=off is set, so SynaBun downloads nothing and names no Git Bash.',
  unsupported: 'No Git for Windows release is pinned for this processor. Install Git for Windows from git-scm.com.',
  settingsNamed: 'A claude you start in another terminal uses it too: your Claude Code settings name it.',
  settingsKept: 'Your Claude Code settings name a Git Bash that is not there ({value}). SynaBun left that value as it is.',
  settingsError: 'Your Claude Code settings could not be updated: {message}',
  download: 'Download',
  retry: 'Try again',
  recheck: 'Re-check',
  checking: 'Checking…',
  errorOffline: 'The download server could not be reached. Check the connection and try again.',
  errorHttp: 'The download server answered with an error. Try again in a moment.',
  errorInterrupted: 'The download stopped before it was complete. Nothing was kept.',
  errorTimeout: 'Nothing arrived from the download server for too long.',
  errorChecksum: 'What arrived is not the published release, so it was removed and never run.',
  errorUnpack: 'The download could not be unpacked, so it was removed.',
  errorDisk: 'The files could not be written. Check free space (about 550 MB) and permissions.',
  errorCancelled: 'The download was stopped.',
  errorUnknown: 'The download did not finish.',
  errorRequest: 'SynaBun did not answer: {message}',
});

const ERROR_COPY = Object.freeze({
  offline: 'errorOffline', http: 'errorHttp', interrupted: 'errorInterrupted', timeout: 'errorTimeout',
  checksum: 'errorChecksum', unpack: 'errorUnpack', disk: 'errorDisk', cancelled: 'errorCancelled',
});

const STEP_COPY = Object.freeze({ download: 'stepDownload', extract: 'stepExtract', verify: 'stepVerify', place: 'stepPlace' });

/** A GIT_BASH_COPY sentence with its `{params}` filled in: the translator when the page gives none. */
export function fillGitBashCopy(key, params = {}) {
  return String(GIT_BASH_COPY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? params[name] : whole));
}

let _translate = null;

/** The page's translator: `(key, params) => t('gitBash.' + key, params)`; an empty answer or the key itself falls back to the English. */
export function setGitBashTranslator(fn) {
  _translate = typeof fn === 'function' ? fn : null;
}

/** A sentence in the page's language. */
export function gitBashText(key, params = {}) {
  if (_translate) {
    try {
      const text = _translate(key, params);
      if (typeof text === 'string' && text && text !== key && text !== `gitBash.${key}`) return text;
    } catch { /* the English below */ }
  }
  return fillGitBashCopy(key, params);
}

/** Whole megabytes (the release file is about a hundred of them). */
const mb = (bytes) => String(Number(bytes) > 0 ? Math.round(Number(bytes) / 1024 / 1024) : 0);

/** What the user's settings note adds to a row that shows SynaBun's copy in use, or null. */
function settingsNote(status) {
  const result = status.settings;
  if (!result || typeof result !== 'object') return null;
  if (status.state === 'ready' && (result.state === 'written' || result.state === 'unchanged') && result.value === status.path) return gitBashText('settingsNamed');
  if (result.state === 'kept-user-value' && result.value) return gitBashText('settingsKept', { value: result.value });
  if (result.state === 'error') return gitBashText('settingsError', { message: result.message || '' });
  return null;
}

/**
 * The row for one answer of GET /api/cli/git-bash.
 * @returns {{ visible: boolean, badge: { text: string, tone: 'detected' | 'not-found' | 'custom' | null } | null,
 *   line: string, note: string | null, action: 'download' | 'retry' | null, busy: boolean, recheck: boolean }}
 */
export function gitBashView(status) {
  const hidden = { visible: false, badge: null, line: '', note: null, action: null, busy: false, recheck: false };
  if (!status || typeof status !== 'object' || status.supported !== true) return hidden;
  const version = status.pinned?.version || '';
  const path = status.path || '';
  const row = (badge, tone, line, extra = {}) => ({ ...hidden, visible: true, badge: { text: gitBashText(badge), tone }, line, recheck: true, ...extra });
  switch (status.state) {
    case 'off':
      return row('badgeOff', null, gitBashText('off'), { recheck: false });
    case 'unsupported':
      return row('badgeMissing', 'not-found', gitBashText('unsupported'));
    case 'system': {
      const key = status.source === 'env' ? 'sourceEnv' : status.source === 'settings' ? 'sourceSettings' : status.passToClaude ? 'sourceSystemPassed' : 'sourceSystem';
      return row('badgeSystem', 'detected', gitBashText(key, { path }), { note: settingsNote(status) });
    }
    case 'ready':
      return row('badgeReady', 'detected', gitBashText(status.source === 'bundled' ? 'sourceBundled' : 'sourceDownloaded', { version, path }), { note: settingsNote(status) });
    case 'missing':
      return row('badgeMissing', 'not-found', gitBashText('missing', { version, size: mb(status.pinned?.size) }), { action: 'download' });
    case 'downloading': {
      const step = STEP_COPY[status.step] || 'stepDownload';
      const progress = status.progress || {};
      const params = { version, done: mb(progress.done), total: mb(progress.total || status.pinned?.size), percent: Number(progress.percent) || 0 };
      return row('badgeDownloading', 'custom', gitBashText(step, params), { busy: true, recheck: false });
    }
    case 'failed': {
      const code = status.error?.code;
      const reason = ERROR_COPY[code] ? gitBashText(ERROR_COPY[code]) : (status.error?.message || gitBashText('errorUnknown'));
      return row('badgeFailed', 'not-found', gitBashText('failed', { reason }), { action: 'retry', note: settingsNote(status) });
    }
    default:
      return hidden;
  }
}
