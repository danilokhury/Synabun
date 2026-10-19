// ═══════════════════════════════════════════
// SynaBun Neural Interface — the desktop app's updates: what the page shows
// ═══════════════════════════════════════════
//
// Inside the SynaBun desktop app the updater is the app's own (packaging/desktop):
// it reads the release feed, downloads at once, and installs by itself when
// SynaBun is idle, after a one-minute notice the user can postpone. The page
// only shows what the updater reports through window.synabunDesktop.updates
// (desktop-bridge.js): the top-right badge, the Notifications drawer, the toast
// of Apps > Check for updates, the update dialog and the notice (countdown,
// "updated", a failed install) in ui-update.js. One reading of a report for all
// of them, so they never disagree.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/desktop-update-view.test.mjs). DESKTOP_COPY is the English of every
// sentence; `desktop` in i18n/en.json must equal it and i18n/pt-BR.json must
// have the same keys with the same {values} (the test checks both). The
// offline page, which can load nothing, writes DESKTOP_COPY.offline.hint as it
// is.

export const DESKTOP_COPY = Object.freeze({
  update: Object.freeze({
    source: 'SynaBun app',
    tooltip: 'SynaBun update available: v{current} → v{latest}',
    tooltipDownloading: 'Downloading SynaBun v{latest}',
    tooltipReady: 'SynaBun v{latest} is ready: it installs when SynaBun is idle',
    titleAvailable: 'Update available',
    titleDownloading: 'Downloading the update',
    titleDownloaded: 'Update ready',
    titleInstalling: 'Installing the update',
    titleMove: 'Move SynaBun to Applications',
    titleManual: 'Install the update yourself',
    titleError: 'The update did not finish',
    notesLabel: 'What\'s new',
    notesEmpty: 'This release has no notes.',
    snapshot: 'Before v{version} starts for the first time, SynaBun takes a verified snapshot of your data.',
    backup: 'Download full backup',
    backupWorking: 'Creating backup...',
    backupDone: '{file} ({size} MB)',
    backupFailed: 'Backup failed: {reason}',
    later: 'Later',
    download: 'Download update',
    downloadStarting: 'Starting the download.',
    progress: '{transferred} of {total} MB',
    progressUnknown: '{transferred} MB downloaded',
    hide: 'Hide',
    hideHint: 'The download continues while this is hidden. SynaBun installs the update by itself when nothing is running.',
    readyBody: 'SynaBun v{version} is downloaded. It installs by itself once nothing is running: SynaBun shows a one-minute notice, then restarts into it. It also installs when you quit SynaBun.',
    waitingBody: 'Waiting for: {list}.',
    countdownBody: 'SynaBun restarts into v{version} in {seconds} s.',
    postponedBody: 'Postponed until {time}. It also installs when you quit SynaBun.',
    nowBody: 'SynaBun restarts into v{version} as soon as nothing is running.',
    installNow: 'Install now',
    installingBody: 'SynaBun is stopping its server and installing v{version}. It closes and opens again by itself.',
    moveBody: 'macOS is running SynaBun from a disk image or a temporary location, where it cannot update itself. Move it to the Applications folder; SynaBun opens again from there and can update.',
    move: 'Move to Applications',
    manualBody: 'SynaBun cannot replace itself in its current folder. Download the disk image of v{version}, open it and drag SynaBun to the Applications folder.',
    manualReady: 'The disk image of v{version} is downloaded. Open it and drag SynaBun to the Applications folder to replace the old copy.',
    manualFile: 'File: {path}',
    manualDownload: 'Download disk image',
    showFile: 'Show disk image',
    errorFallback: 'SynaBun could not check for updates. Check the connection and try again.',
    errorNext: 'SynaBun keeps the version it runs and tries again at its next check. You can try now, or download the new version yourself.',
    manualLink: 'Download it yourself',
    close: 'Close',
    retry: 'Try again',
    testFeed: 'test feed',
    metaAvailable: 'From the SynaBun app',
    metaDownloading: 'Downloading: {percent}%',
    metaDownloaded: 'Ready: installs when SynaBun is idle',
    metaCountdown: 'Restarting to install it',
    metaPostponed: 'Postponed: installs on quit or later',
  }),
  // What an update waits for (the app's server names it, GET /api/system/activity).
  busy: Object.freeze({
    assistant: 'an Assistant run or dispatched agent',
    'claude-panel': 'a Claude Code panel reply',
    'codex-panel': 'a Codex panel reply',
    'opencode-panel': 'an OpenCode panel reply',
    'claude-cli': 'a Claude Code session in use',
    loop: 'a loop',
    schedule: 'a schedule',
    backup: 'a backup',
    maintenance: 'indexing or an install',
    unknown: 'work SynaBun cannot see the end of',
    test: 'the test switch',
  }),
  // The notice at the bottom right: the countdown before the restart, "updated", a failed install.
  notice: Object.freeze({
    countdownTitle: 'Updating to v{version}',
    countdownLine: 'SynaBun restarts in {seconds} s.',
    later: 'Later',
    postponed: 'SynaBun asks again in an hour, or installs the update when you quit it.',
    updatedTitle: 'SynaBun is updated',
    updatedLine: 'Now v{version}, updated from v{previous}.',
    updatedLineShort: 'Now v{version}.',
    failedTitle: 'The update did not finish',
    details: 'Details',
    close: 'Close',
  }),
  menu: Object.freeze({
    quit: 'Quit SynaBun',
  }),
  offline: Object.freeze({
    hint: 'The SynaBun app restarts its server by itself. If it stays offline, quit SynaBun and open it again.',
    stalled: 'The server has not come back. Quit SynaBun and open it again.',
    failedHint: 'Quit SynaBun and open it again. If the start fails, the start screen says why.',
  }),
  // The window's title bar (desktop-titlebar.js): Windows and Linux open the app's menu from a button in it.
  titleBar: Object.freeze({
    appMenu: 'SynaBun menu',
  }),
});

/** Where SynaBun is downloaded by hand, when the app names nothing better. */
export const DESKTOP_RELEASES_URL = 'https://github.com/danilokhury/Synabun/releases/latest';

/** A DESKTOP_COPY sentence (`update.download`, `offline.hint`) with its `{params}` filled in: the translator when the page gives none. */
export function fillDesktopCopy(key, params = {}) {
  const value = String(key ?? '').split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), DESKTOP_COPY);
  if (typeof value !== 'string') return String(key ?? '');
  return value.replace(/\{(\w+)\}/g, (all, name) => (params && params[name] != null ? String(params[name]) : all));
}

const STATUSES = new Set(['idle', 'checking', 'not-available', 'available', 'downloading', 'downloaded', 'installing', 'error']);
const INSTALL_MODES = new Set(['restart', 'move-to-applications', 'manual-download']);
const PHASES = new Set(['waiting', 'countdown', 'postponed']);
const BUSY_KINDS = Object.keys(DESKTOP_COPY.busy);
// The statuses in which a version is on offer, between the check that found it and the install.
const OFFERED = new Set(['available', 'downloading', 'downloaded', 'installing']);

const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const amount = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};
const instant = (value) => (typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null);

function readProgress(value) {
  if (!value || typeof value !== 'object') return null;
  const total = amount(value.total);
  const transferred = total > 0 ? Math.min(amount(value.transferred), total) : amount(value.transferred);
  const given = value.percent === null || value.percent === undefined || value.percent === '' ? NaN : Number(value.percent);
  const percent = Number.isFinite(given) ? given : total > 0 ? (transferred / total) * 100 : 0;
  return { percent: Math.max(0, Math.min(100, percent)), transferred, total, bytesPerSecond: amount(value.bytesPerSecond) };
}

/** The automatic install's moment: what it waits for, when it restarts, until when it is postponed. */
function readAuto(value) {
  if (!value || typeof value !== 'object' || !PHASES.has(value.phase)) return null;
  const busy = (Array.isArray(value.busy) ? value.busy : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ kind: BUSY_KINDS.includes(item.kind) ? item.kind : 'unknown', count: Math.max(1, Math.floor(Number(item.count)) || 1) }))
    .slice(0, 12);
  return {
    phase: value.phase,
    busy,
    installAt: value.phase === 'countdown' ? instant(value.installAt) : null,
    postponedUntil: value.phase === 'postponed' ? instant(value.postponedUntil) : null,
    now: value.now === true,
  };
}

function readUpdated(value) {
  if (!value || typeof value !== 'object') return null;
  const version = text(value.version, 64);
  return version ? { version, previous: text(value.previous, 64) } : null;
}

/** Only SynaBun's own releases page: a report cannot point the page anywhere else. */
function readReleasesUrl(value) {
  return typeof value === 'string' && /^https:\/\/github\.com\/danilokhury\/Synabun\/releases(?:\/[\w./-]*)?$/.test(value) ? value : DESKTOP_RELEASES_URL;
}

/**
 * One report of the app's updater, checked field by field: whatever is missing
 * or of the wrong kind reads as nothing (an unknown status is 'idle', an
 * unknown install mode is 'restart'), so a page never draws a half answer.
 */
export function readDesktopUpdateState(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    supported: s.supported === true,
    status: STATUSES.has(s.status) ? s.status : 'idle',
    current: text(s.current, 64) || '',
    latest: text(s.latest, 64),
    notes: text(s.notes, 20000),
    releaseDate: text(s.releaseDate, 64),
    progress: readProgress(s.progress),
    error: text(s.error, 1000),
    checkedAt: text(s.checkedAt, 64),
    install: INSTALL_MODES.has(s.install) ? s.install : 'restart',
    manualFile: text(s.manualFile, 4096),
    testFeed: s.testFeed === true,
    auto: readAuto(s.auto),
    updated: readUpdated(s.updated),
    releasesUrl: readReleasesUrl(s.releasesUrl),
  };
}

/** True when the report offers a version: it is supported, says which one, and is between the check and the install. */
function offers(s) {
  return s.supported && OFFERED.has(s.status) && !!s.latest;
}

/** Whole seconds until `at` (an ISO time), never below 0. */
export function secondsUntil(at, now = Date.now()) {
  const target = Date.parse(at);
  return Number.isFinite(target) ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
}

/**
 * What the rest of the page reads as `_versionData` (ui-update.js), in the
 * shape the npm / Git check gives it: `updateAvailable`, `current`, `latest`,
 * `source`. `desktop: true` says where it came from; the report's own fields
 * ride along for the dialog.
 */
export function versionDataFromDesktop(state) {
  const s = readDesktopUpdateState(state);
  const offered = offers(s);
  return {
    desktop: true,
    supported: s.supported,
    updateAvailable: offered,
    current: s.current,
    latest: offered ? s.latest : null,
    source: 'app',
    installedChannel: 'stable',
    installPlan: null,
    status: s.status,
    progress: s.progress,
    error: s.error,
    notes: s.notes,
    install: s.install,
    manualFile: s.manualFile,
    testFeed: s.testFeed,
    checkedAt: s.checkedAt,
    auto: s.auto,
  };
}

/**
 * Which page of the dialog a report is: 'available', 'downloading',
 * 'downloaded', 'installing', 'move' (macOS runs this copy where it cannot be
 * replaced: move it to Applications first), 'manual' (a folder SynaBun cannot
 * write: the disk image, by hand), 'error', or 'none' (nothing to show: no
 * update, a check under way, an unsupported run).
 */
export function desktopUpdateStep(state) {
  const s = readDesktopUpdateState(state);
  if (!s.supported) return 'none';
  if (s.status === 'error') return 'error';
  if (!offers(s)) return 'none';
  if (s.status === 'downloading') return 'downloading';
  if (s.status === 'installing') return 'installing';
  if (s.install === 'move-to-applications') return 'move';
  if (s.install === 'manual-download') return 'manual';
  return s.status === 'downloaded' ? 'downloaded' : 'available';
}

/** The bar and its words: whole percent (never 100 before it is), megabytes with one decimal. */
function progressOf(progress, say, number) {
  if (!progress || (!progress.total && !progress.transferred)) return { percent: 0, text: say('downloadStarting') };
  const megabytes = (bytes) => number(bytes / 1048576, 1);
  if (progress.total > 0) {
    return { percent: Math.floor(progress.percent), text: say('progress', { transferred: megabytes(progress.transferred), total: megabytes(progress.total) }) };
  }
  return { percent: null, text: say('progressUnknown', { transferred: megabytes(progress.transferred) }) };
}

/** What an update waits for, as words: "a loop, a Codex panel reply". */
export function desktopBusyList(busy = [], { t = fillDesktopCopy } = {}) {
  return (Array.isArray(busy) ? busy : []).map((item) => t(`busy.${BUSY_KINDS.includes(item?.kind) ? item.kind : 'unknown'}`)).join(', ');
}

/**
 * Everything the update dialog draws for one report, as data:
 *   step       desktopUpdateStep()
 *   dot        1 (offered) · 2 (downloading) · 3 (ready, installing) · 0 (no dots)
 *   title      the heading
 *   body       sentences, in order
 *   notesLabel, notes   the release notes (plain text: drawn as text, line breaks kept)
 *   progress   { percent (whole, or null when the size is not known), text } while downloading
 *   file       where the disk image was saved (manual, once it is downloaded)
 *   link       { href, label }: SynaBun's releases page, after an update that did not finish
 *   backup     { id: 'backup', label } next to the offer: a full backup, if the user wants one first
 *   actions    [{ id, kind: 'ghost' | 'primary', label }] in the order they are drawn
 *              ids: later, download, hide, install-now, move, manual-download, show-file, close, retry
 *   retry      what Try again does after an error: 'download' (a version was on offer) or 'check'
 *   busy       the step is the app working (downloading, installing)
 *   ticking    a sentence counts down: the page draws it again every second
 * `t` translates `update.<key>` (and `busy.<kind>`) with its params; DESKTOP_COPY
 * is the default. `now` is the time the countdown counts from; `time` writes an
 * ISO time the way the page's language writes a time of day.
 */
export function desktopUpdateView(state, {
  t = fillDesktopCopy, number = (value, digits) => value.toFixed(digits), now = Date.now(),
  time = (iso) => new Date(iso).toISOString().slice(11, 16),
} = {}) {
  const s = readDesktopUpdateState(state);
  const step = desktopUpdateStep(s);
  const say = (key, params) => t(`update.${key}`, params);
  const version = s.latest || '';
  const action = (id, kind, key) => ({ id, kind, label: say(key) });
  const view = {
    step, dot: 0, title: '', body: [], notesLabel: '', notes: null, progress: null, file: null, link: null,
    backup: null, actions: [], retry: null, busy: false, ticking: false,
    current: s.current, latest: s.latest, testFeed: s.testFeed,
  };
  switch (step) {
    case 'available':
      view.dot = 1;
      view.title = say('titleAvailable');
      view.body = [say('snapshot', { version })];
      view.notesLabel = say('notesLabel');
      view.notes = s.notes || say('notesEmpty');
      view.backup = { id: 'backup', label: say('backup') };
      view.actions = [action('later', 'ghost', 'later'), action('download', 'primary', 'download')];
      break;
    case 'downloading':
      view.dot = 2;
      view.title = say('titleDownloading');
      view.progress = progressOf(s.progress, say, number);
      view.body = [say('hideHint')];
      view.actions = [action('hide', 'ghost', 'hide')];
      view.busy = true;
      break;
    case 'downloaded': {
      view.dot = 3;
      view.title = say('titleDownloaded');
      view.body = [say('readyBody', { version })];
      const auto = s.auto;
      if (auto?.phase === 'countdown' && auto.installAt) {
        view.body.push(say('countdownBody', { version, seconds: secondsUntil(auto.installAt, now) }));
        view.ticking = true;
      } else if (auto?.phase === 'postponed' && auto.postponedUntil) {
        view.body.push(say('postponedBody', { time: time(auto.postponedUntil) }));
      } else if (auto?.now) {
        view.body.push(say('nowBody', { version }));
      }
      if (auto?.phase === 'waiting' && auto.busy.length) view.body.push(say('waitingBody', { list: desktopBusyList(auto.busy, { t }) }));
      view.actions = [
        auto?.phase === 'countdown' ? action('later', 'ghost', 'later') : action('close', 'ghost', 'close'),
        action('install-now', 'primary', 'installNow'),
      ];
      break;
    }
    case 'installing':
      view.dot = 3;
      view.title = say('titleInstalling');
      view.body = [say('installingBody', { version })];
      view.busy = true;
      break;
    case 'move':
      view.dot = 1;
      view.title = say('titleMove');
      view.body = [say('moveBody')];
      view.actions = [action('later', 'ghost', 'later'), action('move', 'primary', 'move')];
      break;
    case 'manual':
      view.title = say('titleManual');
      if (s.status === 'downloaded') {
        view.dot = 3;
        view.body = [say('manualReady', { version })];
        view.file = s.manualFile ? say('manualFile', { path: s.manualFile }) : null;
        view.actions = [action('close', 'ghost', 'close'), action('show-file', 'primary', 'showFile')];
      } else {
        view.dot = 1;
        view.body = [say('manualBody', { version })];
        view.actions = [action('later', 'ghost', 'later'), action('manual-download', 'primary', 'manualDownload')];
      }
      break;
    case 'error':
      view.title = say('titleError');
      view.body = [s.error || say('errorFallback')];
      view.retry = s.latest ? 'download' : 'check';
      if (s.latest) {
        // A version was on offer and did not arrive or install: the app keeps the old one, and a person can fetch the new one.
        view.body.push(say('errorNext'));
        view.link = { href: s.releasesUrl, label: say('manualLink') };
      }
      view.actions = [action('close', 'ghost', 'close'), action('retry', 'primary', 'retry')];
      break;
    default:
      break;
  }
  return view;
}

/** The line under the SynaBun item of Notifications > Updates, or '' when there is nothing on offer. */
export function desktopUpdateMeta(state, { t = fillDesktopCopy } = {}) {
  const s = readDesktopUpdateState(state);
  switch (desktopUpdateStep(s)) {
    case 'downloading': return t('update.metaDownloading', { percent: Math.floor(s.progress?.percent || 0) });
    case 'downloaded':
      if (s.auto?.phase === 'countdown') return t('update.metaCountdown');
      if (s.auto?.phase === 'postponed') return t('update.metaPostponed');
      return t('update.metaDownloaded');
    case 'installing': return t('update.titleInstalling');
    case 'available': case 'move': case 'manual': return t('update.metaAvailable');
    default: return '';
  }
}

/** The badge's tooltip: what the update is doing, never only that one exists. */
export function desktopUpdateTooltip(state, { t = fillDesktopCopy } = {}) {
  const s = readDesktopUpdateState(state);
  const params = { current: s.current, latest: s.latest || '' };
  const step = desktopUpdateStep(s);
  if (step === 'downloading') return t('update.tooltipDownloading', params);
  if (step === 'downloaded') return t('update.tooltipReady', params);
  return t('update.tooltip', params);
}

/**
 * The notice at the bottom right, or null:
 *   countdown  SynaBun is idle and restarts into the update: the seconds left, and Later
 *   updated    this copy runs after an update (once: the page acknowledges it)
 *   failed     a version was on offer and did not download or install: why, and the releases page
 * `key` changes only when the notice is another one (a countdown that restarts is another one).
 */
export function desktopUpdateNotice(state, { t = fillDesktopCopy, now = Date.now() } = {}) {
  const s = readDesktopUpdateState(state);
  if (!s.supported) return null;
  if (s.status === 'downloaded' && s.latest && s.auto?.phase === 'countdown' && s.auto.installAt) {
    const seconds = secondsUntil(s.auto.installAt, now);
    return {
      kind: 'countdown', key: `countdown:${s.latest}:${s.auto.installAt}`, tone: 'up', seconds,
      title: t('notice.countdownTitle', { version: s.latest }), line: t('notice.countdownLine', { seconds }),
      actions: [{ id: 'later', label: t('notice.later') }], link: null, ticking: true,
    };
  }
  if (s.updated) {
    return {
      kind: 'updated', key: `updated:${s.updated.version}`, tone: 'ok', seconds: null,
      title: t('notice.updatedTitle'),
      line: s.updated.previous ? t('notice.updatedLine', { version: s.updated.version, previous: s.updated.previous }) : t('notice.updatedLineShort', { version: s.updated.version }),
      actions: [{ id: 'dismiss', label: t('notice.close') }], link: null, ticking: false,
    };
  }
  if (s.status === 'error' && s.latest && s.error) {
    return {
      kind: 'failed', key: `failed:${s.latest}:${s.error}`, tone: 'err', seconds: null,
      title: t('notice.failedTitle'), line: s.error,
      actions: [{ id: 'details', label: t('notice.details') }], link: { href: s.releasesUrl, label: t('update.manualLink') }, ticking: false,
    };
  }
  return null;
}

/**
 * What a finished check ends in, for whoever asked for it (the native menu, the
 * tray, Apps > Check for updates): 'offer' (open the dialog), 'up-to-date',
 * 'error', or 'none' (an unsupported run, or a check still under way).
 */
export function desktopCheckOutcome(state) {
  const s = readDesktopUpdateState(state);
  if (!s.supported || s.status === 'checking') return 'none';
  if (offers(s)) return 'offer';
  if (s.status === 'error') return 'error';
  return 'up-to-date';
}
