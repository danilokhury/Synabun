// ═══════════════════════════════════════════
// SynaBun — Antigravity panel: getting from "not installed" to a session (no DOM)
// ═══════════════════════════════════════════
//
// One card stands where the transcript starts while Antigravity cannot be used
// yet: the CLI is missing (Install runs Homebrew's cask or Google's installer on
// the server, lib/cli-install.js), being installed, failed to install, found but
// failed to start, or installed but signed out. While an install this page
// started goes on, the card shows four steps — checking, installing, verifying,
// sign in — and keeps them until the first session is up. What it says comes
// from the CLI's state (cli-install-controller.js view), the panel's socket
// (`hello`: whether `agy acp` runs, its sign-in methods) and the tab's sign-in.

export const SETUP_STEPS = Object.freeze(['check', 'install', 'verify', 'signin']);

// cli-install-view.js INSTALL_STEPS → the card's steps.
const STEP_OF = Object.freeze({ start: 'check', download: 'install', verify: 'install', run: 'install', check: 'verify', path: 'verify' });

function steps(active, { failed = null, done = [] } = {}) {
  const at = SETUP_STEPS.indexOf(active);
  return SETUP_STEPS.map((id, i) => {
    let state = 'todo';
    if (done.includes(id) || (at >= 0 && i < at)) state = 'done';
    if (id === active) state = failed === id ? 'failed' : 'active';
    if (failed === id) state = 'failed';
    return { id, state };
  });
}

/**
 * The card, or { show: false }.
 *
 * @param {object} o
 * @param {object | null} o.cli the controller's view (cliBannerView + checking): kind hidden | missing | installing |
 *   failed | broken | done | path, and its command, error, note, log, progress, install, guide, recheck, addPath
 * @param {object | null} o.hello the socket's hello: { running, cliMissing, error, authMethods }
 * @param {object | null} o.auth the active tab's sign-in: { state: 'needed' | 'waiting' | 'failed', error }
 * @param {boolean} o.installed the CLI is known to be installed (tool-versions said so, or the socket runs it)
 * @param {boolean} o.ran an install was started from this page and the card has not been dismissed since
 * @param {boolean} o.connecting the panel is (re)starting `agy acp` after an install
 * @returns {{ show: boolean, stage?: string, tone?: string, steps?: object[] | null, titleKey?: string,
 *   bodyKey?: string, params?: object, command?: string, error?: string, note?: string, log?: string[],
 *   progress?: object | null, install?: object | null, retry?: boolean, recheck?: boolean, checking?: boolean,
 *   guide?: string | null, signIn?: object[] | null, terminal?: boolean, addPath?: object | null, dismiss?: boolean,
 *   live?: 'polite' | 'assertive' }}
 */
export function setupView({ cli = null, hello = null, auth = null, installed = false, ran = false, connecting = false } = {}) {
  const kind = cli?.kind || 'hidden';
  const base = {
    show: true, tone: 'warn', steps: null, params: {}, command: '', error: '', note: '', log: [], progress: null,
    install: null, retry: false, recheck: false, checking: !!cli?.checking, guide: cli?.guide || null,
    signIn: null, terminal: false, addPath: null, dismiss: false, live: 'polite',
  };

  if (kind === 'installing') {
    const job = cli.job || null;
    const active = STEP_OF[job?.step] || 'check';
    // Through Homebrew the steps are Homebrew's (cli-install-view.js words them for an installer script).
    const brew = job?.method === 'brew' || cli.info?.install?.method === 'brew';
    return {
      ...base, stage: 'installing', tone: 'busy', titleKey: 'setupInstallingTitle', bodyKey: `setupStep_${active}`,
      steps: steps(active), progress: cli.progress || null, progressKey: brew && active === 'install' ? 'setupBrewRunning' : null,
      log: cli.log || [], guide: null,
    };
  }

  if (kind === 'failed') {
    const job = cli.job || null;
    const failedStep = STEP_OF[job?.step] || 'install';
    return {
      ...base, stage: 'failed', tone: 'err', live: 'assertive', titleKey: 'setupFailedTitle', bodyKey: null,
      text: cli.text || '', error: cli.error || '', note: cli.note || '', command: cli.command || '', log: cli.log || [],
      steps: steps(failedStep, { failed: failedStep }), retry: !!cli.install, recheck: true,
    };
  }

  if (kind === 'missing') {
    // The server says how one click installs it here: Homebrew's cask, or Google's installer script.
    const method = cli.info?.install?.method;
    const body = cli.install ? (method === 'brew' ? 'setupMissingBodyBrew' : 'setupMissingBody') : (cli.command ? 'setupMissingManual' : 'setupMissingGuide');
    return {
      ...base, stage: 'missing', titleKey: 'setupMissingTitle', bodyKey: body,
      command: cli.command || '', install: cli.install ? { disabled: !!cli.install.disabled } : null, recheck: true,
    };
  }

  if (kind === 'broken') {
    return {
      ...base, stage: 'broken', tone: 'err', live: 'assertive', titleKey: 'setupBrokenTitle', bodyKey: null,
      text: cli.text || '', error: cli.error || '', note: cli.note || '', recheck: true,
    };
  }

  // Installed (or the socket runs it). After an install from here, the card stays through sign-in.
  const runningOk = hello?.running === true;
  const methods = Array.isArray(hello?.authMethods) ? hello.authMethods.filter((m) => m && typeof m.id === 'string') : [];
  const pathNotice = kind === 'path' || kind === 'done' ? { addPath: cli.addPath || null, note: cli.text || '', dismiss: !!cli.dismiss } : null;

  if (auth && (auth.state === 'needed' || auth.state === 'waiting' || auth.state === 'failed')) {
    return {
      ...base, stage: 'signin', tone: auth.state === 'failed' ? 'err' : 'warn', titleKey: 'signInTitle',
      bodyKey: auth.state === 'failed' ? 'signInFailed' : auth.state === 'waiting' ? 'signInWaiting' : auth.terminal ? 'signInTerminalBody' : 'signInBody',
      params: auth.state === 'failed' ? { error: String(auth.error || '') } : {},
      checkSignIn: !!auth.terminal,
      steps: ran ? steps('signin', { failed: auth.state === 'failed' ? 'signin' : null }) : null,
      signIn: methods.map((m) => ({ id: m.id, name: String(m.name || m.id), description: String(m.description || ''), terminal: m.type === 'terminal' })),
      terminal: true, waiting: auth.state === 'waiting', guide: null,
      ...(pathNotice || {}),
    };
  }

  // The CLI is there but `agy acp` did not start: what it said stays on the card (the server already redacted
  // it), and an agy without the ACP server (1.4.6) is told to update rather than shown as a crash.
  if (!connecting && hello?.running === false && !hello.cliMissing && hello.error?.message) {
    const update = !!hello.acpUnsupported;
    return {
      ...base, stage: 'broken', tone: 'err', live: 'assertive', titleKey: update ? 'setupUpdateTitle' : 'setupBrokenTitle',
      bodyKey: update ? 'setupUpdateBody' : null, command: update ? 'agy update' : '',
      error: update ? String(hello.error.stderr || '') : String(hello.error.message), recheck: true, guide: null,
    };
  }

  if (ran) {
    if (connecting || (!runningOk && (installed || kind === 'done' || kind === 'path'))) {
      return { ...base, stage: 'connecting', tone: 'busy', titleKey: 'setupConnectingTitle', bodyKey: 'setupConnectingBody', steps: steps('signin', { done: ['check', 'install', 'verify'] }), guide: null, ...(pathNotice || {}) };
    }
    if (runningOk) {
      return { ...base, stage: 'ready', tone: 'ok', titleKey: 'setupReadyTitle', bodyKey: 'setupReadyBody', steps: steps(null, { done: SETUP_STEPS }), dismiss: true, guide: null, ...(pathNotice ? { addPath: pathNotice.addPath, note: pathNotice.note } : {}) };
    }
  }

  // A PATH note after an install (the CLI works; other terminals do not see it yet).
  if (kind === 'path' || kind === 'done') {
    return { ...base, stage: 'path', tone: kind === 'done' ? 'ok' : 'warn', titleKey: kind === 'done' ? 'setupReadyTitle' : 'setupPathTitle', bodyKey: null, text: cli.text || '', error: cli.error || '', addPath: cli.addPath || null, recheck: !!cli.recheck, dismiss: !!cli.dismiss, guide: null, compact: true };
  }

  return { show: false };
}

/** The tray/composer word for what blocks sending, from the card: a copy key, or '' when nothing does. */
export function blockedReasonKey(view) {
  if (!view?.show) return '';
  if (view.stage === 'installing') return 'blockedInstalling';
  if (view.stage === 'missing' || view.stage === 'failed') return 'blockedMissing';
  if (view.stage === 'broken') return 'blockedBroken';
  if (view.stage === 'signin') return 'blockedSignIn';
  if (view.stage === 'connecting') return 'blockedConnecting';
  return '';
}
