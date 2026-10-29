// ═══════════════════════════════════════════
// SynaBun Neural Interface — the CLI banner of the side panels: what it says
// ═══════════════════════════════════════════
//
// What the Claude Code, Codex and OpenCode panels show above their transcript
// for one CLI: nothing while it is installed, "not installed" with a one-click
// Install (the vendor's own installer, run by the server: POST
// /api/cli/install/:tool) and the command to run by hand, the progress of an
// install, why an install failed, and "failed to start" with the error the CLI
// gave. One reading for all three panels, so they never disagree; the page
// side is ui-cli-banner.js, the data cli-status.js.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/cli-install-view.test.mjs). CLI_INSTALL_COPY is the English of every
// sentence; `cliInstall.*` in i18n/en.json must equal it and i18n/pt-BR.json
// must have the same keys (the test checks both).
//
// A server from before the three states answers only `installed` (a version or
// null): null reads as "not installed", and no Install button is offered,
// because such a server has no install route.

export const CLI_INSTALL_COPY = Object.freeze({
  titleMissing: '{label} is not installed',
  titleBroken: '{label} failed to start',
  titleInstalling: 'Installing {label}…',
  titleFailed: '{label} could not be installed',
  titleDone: '{label} is installed',
  titlePath: 'Run {label} in your other terminals',
  bodyPath: 'SynaBun terminals are ready. Add {dir} to your PATH for other terminals.',
  addPath: 'Add to PATH',
  addingPath: 'Adding…',
  pathFailed: 'PATH could not be updated: {error}',
  copyPathDiagnostics: 'Copy PATH diagnostics',
  stepPath: 'Adding the CLI folder to your PATH…',
  stepPathAdded: 'Added {dir} to your PATH',
  bodyMissing: 'Install it with one click from {vendor}\'s official installer, or run:',
  bodyMissingManual: 'Install it with this command, then re-check:',
  bodyBroken: '{label} was found at {path}, but it could not be started:',
  bodyBrokenVersion: '{label} {version} was found at {path}, but it could not be started:',
  bodyBrokenLatched: '{label} is installed, but it could not be started:',
  bodyBrokenHint: 'Check the CLI path in Settings, then re-check.',
  configuredFailed: 'The path set in Settings did not work: {error}',
  bodyFailedManual: 'Run it yourself:',
  doneNotOnPath: 'It is in {dir}. SynaBun finds it there; add that folder to your PATH to run it in a terminal.',
  doneAddedToPath: 'Added {dir} to your PATH. New terminal windows and tabs pick it up.',
  stepStart: 'Starting the official installer…',
  stepDownload: 'Downloading…',
  stepDownloadProgress: 'Downloading: {received} of {total} MB',
  stepDownloadReceived: 'Downloading: {received} MB',
  stepVerify: 'Checking the download…',
  stepRun: 'Running the official installer…',
  stepCheck: 'Checking that it starts…',
  errorOffline: 'The download server could not be reached. Check the connection and try again.',
  errorHttp: 'The download server answered with an error. Try again in a moment.',
  errorChecksum: 'The download did not match its published checksum, so it was removed and never run.',
  errorInterrupted: 'The download stopped before it was complete. Nothing was kept. Try again.',
  errorTimeout: 'The installer took too long and was stopped.',
  errorInstallerFailed: 'The official installer stopped with an error.',
  errorNotFound: 'The installer finished, but SynaBun does not find {label} afterwards.',
  errorDisk: 'The files could not be written. Check free space and permissions, then try again.',
  errorCancelled: 'The installation was stopped.',
  errorUnsupported: 'There is no one-click install for this system. Use the command below or the install guide.',
  errorRefused: 'SynaBun refused the request. Install from SynaBun on this computer.',
  errorConnection: 'The connection to SynaBun closed before the installation finished.',
  errorUnknown: 'The installation did not finish.',
  install: 'Install',
  installing: 'Installing…',
  retry: 'Try again',
  guide: 'Install guide',
  recheck: 'Re-check',
  checking: 'Checking…',
  copy: 'Copy',
  copied: 'Copied',
  dismiss: 'Dismiss',
  logLabel: 'Installer output',
});

/** Who publishes each CLI: the {vendor} of "from {vendor}'s official installer". Names, not translated. */
export const CLI_VENDORS = Object.freeze({
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  opencode: 'OpenCode',
  gemini: 'Google',
});

/** The CLIs a server can install with one click (POST /api/cli/install/:tool). */
export const INSTALLABLE_CLIS = Object.freeze(['claude-code', 'codex', 'opencode']);

/** The steps an install reports (`{ type: 'step' }`), in the order they can come. */
export const INSTALL_STEPS = Object.freeze(['start', 'download', 'verify', 'run', 'check', 'path']);

const STEP_COPY = Object.freeze({
  start: 'stepStart', download: 'stepDownload', verify: 'stepVerify', run: 'stepRun',
  check: 'stepCheck', path: 'stepPath',
});

const ERROR_COPY = Object.freeze({
  offline: 'errorOffline', http: 'errorHttp', checksum: 'errorChecksum', interrupted: 'errorInterrupted',
  timeout: 'errorTimeout', 'installer-failed': 'errorInstallerFailed', 'not-found-after-install': 'errorNotFound',
  disk: 'errorDisk', cancelled: 'errorCancelled', unsupported: 'errorUnsupported',
  refused: 'errorRefused', connection: 'errorConnection',
});

/** How many installer lines the banner keeps, and shows. */
export const INSTALL_LOG_KEEP = 200;
export const INSTALL_LOG_SHOWN = 6;

/** A CLI_INSTALL_COPY sentence with its `{params}` filled in: the translator when the page gives none. */
export function fillCliInstallCopy(key, params = {}) {
  return String(CLI_INSTALL_COPY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? params[name] : whole));
}

let _translate = null;

/**
 * The page's translator: `(key, params) => t('cliInstall.' + key, params)`. An answer that is empty, or the
 * key itself (i18n's word for "no such string"), falls back to the English.
 */
export function setCliInstallTranslator(fn) {
  _translate = typeof fn === 'function' ? fn : null;
}

/** A sentence in the page's language (the translator set above, else the English). */
export function cliInstallText(key, params = {}) {
  if (_translate) {
    try {
      const text = _translate(key, params);
      if (typeof text === 'string' && text && text !== key && text !== `cliInstall.${key}`) return text;
    } catch { /* the English below */ }
  }
  return fillCliInstallCopy(key, params);
}

/**
 * The state of one CLI in an answer of GET /api/system/tool-versions:
 *   'installed'  found, and it answered --version
 *   'missing'    nowhere to be found
 *   'broken'     found, but it would not start (info.error says why)
 *   'unknown'    no answer yet, or an answer that says nothing about this CLI
 * An older server sends no `state`: its `installed` (a version or null) decides.
 */
export function cliStateOf(info) {
  if (!info || typeof info !== 'object') return 'unknown';
  if (info.state === 'installed' || info.state === 'missing' || info.state === 'broken' || info.state === 'unknown') return info.state;
  return info.installed ? 'installed' : 'missing';
}

/** The one-click install the server offers for this CLI on its system, or null. */
export function cliInstallOffer(info) {
  const install = info && typeof info === 'object' && info.install && typeof info.install === 'object' ? info.install : null;
  return install && install.available === true ? install : null;
}

const line = (value, max = 400) => {
  const text = String(value ?? '').replace(/\s+$/g, '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const words = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

/**
 * One install as the page saw it, after one more event of the stream (or of the job list, when another window
 * started it). Pure: a new object every time.
 *
 * @param {object | null} job the job so far (null: a new one)
 * @param {object} event `{ type: 'start' | 'step' | 'progress' | 'log' | 'done', … }` as POST /api/cli/install/:tool sends
 * @returns {{ phase: 'running' | 'failed' | 'done', step: string, received: number, total: number, log: string[],
 *   code: string | null, error: string | null, manualCommand: string | null, guideUrl: string | null,
 *   status: object | null, path: object | null, method: string | null, source: string | null }}
 */
export function reduceInstallJob(job, event) {
  const next = job && typeof job === 'object'
    ? { ...job, log: Array.isArray(job.log) ? [...job.log] : [] }
    : { phase: 'running', step: 'start', received: 0, total: 0, log: [], code: null, error: null, manualCommand: null, guideUrl: null, status: null, path: null, method: null, source: null };
  const e = event && typeof event === 'object' ? event : {};
  const push = (text) => {
    for (const piece of String(text ?? '').split(/\r?\n/)) {
      const kept = line(piece, 300);
      if (kept.trim()) next.log.push(kept);
    }
    if (next.log.length > INSTALL_LOG_KEEP) next.log.splice(0, next.log.length - INSTALL_LOG_KEEP);
  };
  switch (e.type) {
    case 'start':
      next.phase = 'running';
      next.step = 'start';
      next.method = typeof e.method === 'string' ? e.method : next.method;
      next.source = typeof e.source === 'string' ? e.source : next.source;
      break;
    case 'step':
      if (INSTALL_STEPS.includes(e.step)) {
        if (e.step !== next.step) { next.received = 0; next.total = 0; }
        next.step = e.step;
      }
      break;
    case 'progress':
      next.received = Math.max(0, Number(e.received) || 0);
      next.total = Math.max(0, Number(e.total) || 0);
      break;
    case 'log':
      push(e.line);
      break;
    case 'path':
      if (e.added && words(e.dir)) push(cliInstallText('stepPathAdded', { dir: e.dir }));
      break;
    case 'done':
      if (e.ok === true) {
        next.phase = 'done';
        next.status = e.status && typeof e.status === 'object' ? e.status : null;
        next.path = e.path && typeof e.path === 'object' ? e.path : null;
        next.code = null;
        next.error = null;
      } else {
        next.phase = 'failed';
        next.code = typeof e.code === 'string' && e.code ? e.code : 'internal';
        next.error = words(e.error) || null;
        next.manualCommand = words(e.manualCommand) || null;
        next.guideUrl = words(e.guideUrl) || null;
        if (Array.isArray(e.log) && !next.log.length) for (const entry of e.log) push(entry);
      }
      break;
    default:
      break;
  }
  return next;
}

const megabytes = (bytes) => (Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toFixed(1);

/** The sentence for where an install is, and how far a download got (null when unknown). */
export function installStepView(job, { t = cliInstallText } = {}) {
  const step = job?.step && STEP_COPY[job.step] ? job.step : 'start';
  if (step === 'download') {
    const total = Number(job?.total) || 0;
    const received = Number(job?.received) || 0;
    if (total > 0) {
      const percent = Math.max(0, Math.min(100, Math.floor((Math.min(received, total) / total) * 100)));
      return { step, text: t('stepDownloadProgress', { received: megabytes(Math.min(received, total)), total: megabytes(total) }), percent };
    }
    if (received > 0) return { step, text: t('stepDownloadReceived', { received: megabytes(received) }), percent: null };
  }
  return { step, text: t(STEP_COPY[step]), percent: null };
}

/** Why an install failed, as a sentence; the server's own words go in `detail` when they add something. */
export function installErrorView(job, { label = '', t = cliInstallText } = {}) {
  const code = job?.code || 'internal';
  const key = ERROR_COPY[code];
  const raw = words(job?.error);
  if (key) return { text: t(key, { label }), detail: raw || null };
  return { text: t('errorUnknown'), detail: raw || null };
}

/** The guide to link: the server's (an https address only), else the page's own. */
function safeUrl(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(value.trim())) return value.trim();
  }
  return null;
}

/**
 * What the banner of one panel shows.
 *
 * @param {object} o
 * @param {string} o.toolKey 'claude-code' | 'codex' | 'opencode'
 * @param {string} [o.label] the CLI's name ("Claude Code")
 * @param {object | null} [o.info] this CLI in the latest GET /api/system/tool-versions (null: no answer yet)
 * @param {{ reason: string | null } | null} [o.forced] a start of the CLI failed in a session, before the
 *   server was asked again (the panels' latch): shown as "failed to start" until an answer says otherwise
 * @param {object | null} [o.job] the install under way or just ended (reduceInstallJob)
 * @param {string | null} [o.guideUrl] the page's install guide for this CLI
 * @param {string} [o.installCommand] the command to install it by hand (cli-status getCliInstallCommand)
 * @param {object} [options]
 * @param {(key: string, params?: object) => string} [options.t] a key of CLI_INSTALL_COPY → its sentence
 * @returns {{
 *   show: boolean, blocked: boolean,
 *   kind: 'hidden' | 'missing' | 'broken' | 'installing' | 'failed' | 'done',
 *   tone: 'warn' | 'err' | 'busy' | 'ok' | null, icon: string, live: 'polite' | 'assertive',
 *   title: string, text: string, command: string, error: string, note: string,
 *   progress: { step: string, text: string, percent: number | null } | null, log: string[],
 *   install: { label: string, disabled: boolean } | null, guide: string | null,
 *   recheck: boolean, dismiss: boolean,
 * }}
 *   `blocked`: sending stays off (missing, broken, installing, failed). `install`: the Install button, when the
 *   server offers one for this system and the CLI really is missing.
 */
export function cliBannerView({ toolKey, label = '', info = null, forced = null, job = null, guideUrl = null, installCommand = '', addingPath = false, pathError = '' } = {}, { t = cliInstallText } = {}) {
  const name = words(label) || String(toolKey || '');
  const state = cliStateOf(info);
  const guide = safeUrl(job?.guideUrl, info?.guideUrl, guideUrl);
  const command = words(job?.manualCommand) || words(info?.installCommand) || words(installCommand);
  const offer = cliInstallOffer(info);
  const view = {
    show: false, blocked: false, kind: 'hidden', tone: null, icon: '', live: 'polite',
    title: '', text: '', command: '', error: '', note: '',
    progress: null, log: [], install: null, guide, recheck: false, dismiss: false, addPath: null,
  };
  const lastLines = (log) => (Array.isArray(log) ? log.slice(-INSTALL_LOG_SHOWN) : []);

  // An install under way: the banner stays, sending stays off, the steps and the installer's last lines show.
  if (job?.phase === 'running') {
    return Object.assign(view, {
      show: true, blocked: true, kind: 'installing', tone: 'busy', icon: '…',
      title: t('titleInstalling', { label: name }),
      progress: installStepView(job, { t }),
      log: lastLines(job.log),
      install: { label: t('installing'), disabled: true },
      recheck: false,
    });
  }

  // Installed: nothing to show, except, for a moment, where an install that just ended put it.
  if (state === 'installed' && !forced) {
    const where = job?.phase === 'done' && job.path && typeof job.path === 'object' ? job.path : null;
    const dir = words(where?.dir);
    const pathStatus = info?.pathStatus || where;
    const missingPath = INSTALLABLE_CLIS.includes(toolKey) && pathStatus?.onPath === false && (pathStatus.canAdd !== false);
    const addPath = missingPath ? { label: t(addingPath ? 'addingPath' : 'addPath'), disabled: addingPath } : null;
    if (missingPath) return Object.assign(view, {
      show: true, blocked: false, kind: 'path', tone: 'warn', icon: '!',
      title: t('titlePath', { label: name }), text: t('bodyPath', { dir: pathStatus.dir }),
      error: pathError ? t('pathFailed', { error: pathError }) : '',
      addPath, recheck: true, guide: null,
    });
    if (where && dir && (where.onPath === false || where.added === true)) {
      return Object.assign(view, {
        show: true, blocked: false, kind: 'done', tone: 'ok', icon: '✓',
        title: t('titleDone', { label: name }),
        text: where.onPath === false ? t('doneNotOnPath', { label: name, dir }) : t('doneAddedToPath', { label: name, dir }),
        note: words(where.warning), guide: null, dismiss: true,
      });
    }
    return view;
  }

  // Found, but it would not start: the error it gave, never an Install button (it is there already).
  if (state === 'broken' || (forced && state !== 'missing')) {
    const fromServer = state === 'broken';
    const path = words(info?.binPath) || words(info?.realPath);
    const version = words(info?.version) || words(info?.installed);
    const error = fromServer ? words(info?.error) || words(forced?.reason) : words(forced?.reason) || words(info?.error);
    let text;
    if (path && version) text = t('bodyBrokenVersion', { label: name, version, path });
    else if (path) text = t('bodyBroken', { label: name, path });
    else text = t('bodyBrokenLatched', { label: name });
    const configured = info?.configured && typeof info.configured === 'object' && info.configured.ok === false && words(info.configured.error)
      ? t('configuredFailed', { error: words(info.configured.error) })
      : '';
    return Object.assign(view, {
      show: true, blocked: true, kind: 'broken', tone: 'err', icon: '!', live: 'assertive',
      title: t('titleBroken', { label: name }),
      text, error: line(error, 600),
      note: configured || (error ? '' : t('bodyBrokenHint')),
      recheck: true,
    });
  }

  if (state === 'missing') {
    // The last install failed: why, what the installer said last, and the command to run by hand.
    if (job?.phase === 'failed') {
      const why = installErrorView(job, { label: name, t });
      return Object.assign(view, {
        show: true, blocked: true, kind: 'failed', tone: 'err', icon: '!', live: 'assertive',
        title: t('titleFailed', { label: name }),
        text: why.text,
        error: why.detail ? line(why.detail, 600) : '',
        note: command ? t('bodyFailedManual') : '',
        command,
        log: lastLines(job.log),
        install: offer && job.code !== 'unsupported' ? { label: t('retry'), disabled: false } : null,
        recheck: true,
      });
    }
    const text = offer
      ? t('bodyMissing', { vendor: CLI_VENDORS[toolKey] || name, label: name })
      : t('bodyMissingManual');
    return Object.assign(view, {
      show: true, blocked: true, kind: 'missing', tone: 'warn', icon: '!',
      title: t('titleMissing', { label: name }),
      text, command,
      install: offer ? { label: t('install'), disabled: false } : null,
      recheck: true,
    });
  }

  // No answer yet: nothing to say, and nothing is held back (a start that fails says so itself).
  return view;
}
