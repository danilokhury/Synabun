/**
 * The splash: the small window SynaBun shows while it starts, while it installs
 * an update and while it closes, the way Discord's updater does (pages/splash.*).
 * Pure (tested in packaging/tests/desktop-splash.test.mjs): main.mjs says which
 * stage SynaBun is in and how far along it is; this says what the splash draws.
 * The page only draws it, and shows the mascot's lines in turn.
 *
 *   stage     checking · downloading · preparing · browser · stopping ·
 *             confirming · protecting · verifying · installing · restarting ·
 *             starting · loading · ready · failed · quitting. The snapshot is
 *             three of them, so the splash never says more than happens:
 *             confirming (the copy made ahead is compared with the data),
 *             protecting (a new copy is written and read back), verifying (the
 *             copy's integrity check, still running when the archive is done)
 *   mascot    the CSS mascot of neural-interface/public/offline.html, copied
 *             into pages/splash.css (a file: page cannot load the server's
 *             files): asleep · waking · working · ready · failed
 *   status    one short plain line: what SynaBun does now
 *   lines     what the mascot says (i18n.mjs SPLASH_LINES): playful, and never
 *             a step that is not happening
 *   progress  real progress when the stage has some (a download, the snapshot);
 *             otherwise the bar travels
 */

import { SPLASH_LINES, translate } from './i18n.mjs';

export const SPLASH_STAGES = Object.freeze([
  'checking', 'downloading', 'preparing', 'browser', 'stopping', 'confirming', 'protecting', 'verifying', 'installing', 'restarting', 'starting',
  'loading', 'ready', 'failed', 'quitting',
]);

/** The mascot's state for each stage (offline.html's six states, minus `stalled`, which a start never needs). */
export const SPLASH_MASCOT = Object.freeze({
  checking: 'waking',
  downloading: 'working',
  preparing: 'working',
  browser: 'working',
  stopping: 'working',
  confirming: 'working',
  protecting: 'working',
  verifying: 'working',
  installing: 'working',
  restarting: 'waking',
  starting: 'working',
  loading: 'waking',
  ready: 'ready',
  failed: 'failed',
  quitting: 'asleep',
});

const STATUS_KEYS = Object.freeze({
  checking: 'splashChecking',
  downloading: 'splashDownloading',
  preparing: 'splashPreparing',
  browser: 'splashBrowser',
  stopping: 'splashStopping',
  confirming: 'splashConfirming',
  protecting: 'splashProtecting',
  verifying: 'splashVerifying',
  installing: 'splashInstalling',
  restarting: 'splashRestarting',
  starting: 'splashStarting',
  loading: 'splashLoading',
  ready: 'splashReady',
  failed: 'splashFailed',
  quitting: 'splashQuitting',
});

/** The window, in DIP: compact, like Discord's updater (300 × 350), with room for a two-line speech bubble. */
export const SPLASH_SIZE = Object.freeze({ width: 340, height: 400 });

/** How long one of the mascot's lines stays before the next. */
export const SPLASH_LINE_MS = 4200;

const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

/** "812 MB", "3.6 GB": megabytes whole, gigabytes with one decimal, in the language's own number format. */
export function formatBytes(bytes, locale = 'en') {
  const value = Math.max(0, Number(bytes) || 0);
  const format = (number, digits) => {
    try { return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number); } catch { return number.toFixed(digits); }
  };
  if (value >= 1024 ** 3) return `${format(value / 1024 ** 3, 1)} GB`;
  return `${format(Math.max(value / 1024 ** 2, value ? 0.1 : 0), value < 1024 ** 2 && value ? 1 : 0)} MB`;
}

/**
 * The bar and the words under it: { percent (a whole 0-100, or null: the bar
 * travels), label }. `progress` is { done, total } (bytes when `bytes` is true:
 * "1.2 of 3.7 GB"; else a percentage) or { percent }.
 */
export function splashProgress(progress, { locale = 'en' } = {}) {
  if (!progress || typeof progress !== 'object') return { percent: null, label: '' };
  const t = (key, params) => translate(locale, key, params);
  const done = Number(progress.done);
  const total = Number(progress.total);
  let percent = null;
  if (Number.isFinite(done) && Number.isFinite(total) && total > 0) percent = (Math.max(0, done) / total) * 100;
  else if (progress.percent !== null && progress.percent !== undefined && progress.percent !== '' && Number.isFinite(Number(progress.percent))) percent = Number(progress.percent);
  if (percent === null) return { percent: null, label: '' };
  // Never 100 before it is.
  percent = Math.max(0, Math.min(percent >= 100 ? 100 : 99, Math.floor(percent)));
  const label = progress.bytes && Number.isFinite(done) && total > 0
    ? t('splashProgress', { done: formatBytes(Math.min(done, total), locale), total: formatBytes(total, locale) })
    : t('splashPercent', { percent });
  return { percent, label };
}

/**
 * What the splash draws for `state` in `locale`:
 *   state   { stage, version (the update's), progress, update (a failure is the update's) }
 *   →       { lang, stage, mascot, status, lines, progress: { percent, label }, details }
 * A stage it does not know is `checking`; a line that needs a version it was not given is left out.
 */
export function splashView(state = {}, { locale = 'en' } = {}) {
  const lang = locale === 'pt-BR' ? 'pt-BR' : 'en';
  const t = (key, params) => translate(lang, key, params);
  const stage = SPLASH_STAGES.includes(state?.stage) ? state.stage : 'checking';
  const version = typeof state?.version === 'string' && VERSION.test(state.version) ? state.version : '';
  const fill = (text) => String(text).replace(/\{version\}/g, version);
  const lines = (SPLASH_LINES[lang]?.[stage] || SPLASH_LINES.en[stage] || [])
    .filter(line => version || !line.includes('{version}'))
    .map(fill);
  let statusKey = stage === 'failed' && state?.update ? 'splashUpdateFailed' : STATUS_KEYS[stage];
  // A status that names the version, without one: the same words for "the update".
  if (!version && ['splashDownloading', 'splashPreparing', 'splashInstalling'].includes(statusKey)) statusKey = `${statusKey}Any`;
  const status = t(statusKey, { version });
  return {
    lang,
    stage,
    mascot: SPLASH_MASCOT[stage],
    status,
    lines,
    progress: splashProgress(state?.progress, { locale: lang }),
    details: t('splashDetails'),
  };
}

/**
 * The stage of a start, from what setup.js says it is doing (the supervisor
 * record's phase and its detail, through `<entry> app-backend --json`): its
 * checks are `checking`, the automation browser's download is `browser`, the
 * snapshot is what splashOfSnapshot says, the server is `starting`.
 */
export function stageOfSupervisorPhase(phase, detail = null) {
  if (phase === 'browser') return 'browser';
  if (phase === 'snapshot') return splashOfSnapshot(detail).stage;
  if (phase === 'server' || phase === 'listening') return 'starting';
  return 'checking';
}

/**
 * The snapshot's progress as one bar: it is written (archive) and read back
 * (verify), each over all of its bytes, so the bar is half each.
 */
export function snapshotProgress(detail) {
  const step = detail?.step || detail?.phase;
  const done = Number(detail?.done);
  const total = Number(detail?.total);
  if (!(total > 0) || !Number.isFinite(done)) return null;
  if (step === 'archive') return { done: Math.min(done, total), total: total * 2 };
  if (step === 'verify') return { done: total + Math.min(done, total), total: total * 2 };
  return null;
}

/**
 * What the splash says for one step of the snapshot (lib/update-snapshot.js's
 * events at an install, setup.js's at a first start): { stage, progress }. The
 * copy made ahead being compared with the data is `confirming` (nothing is
 * copied then); a new copy is `protecting`, with its bar; the integrity check
 * that still runs once the archive is written is `verifying` (no bar: SQLite
 * says nothing until it is done).
 */
export function splashOfSnapshot(detail) {
  const step = detail?.step || detail?.phase;
  if (step === 'check' || step === 'reuse') return { stage: 'confirming', progress: null };
  if (step === 'integrity') return { stage: 'verifying', progress: null };
  return { stage: 'protecting', progress: snapshotProgress(detail) };
}
