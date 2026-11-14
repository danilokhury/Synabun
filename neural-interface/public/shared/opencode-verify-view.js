// ═══════════════════════════════════════════
// SynaBun Neural Interface — Verify OpenCode: what Settings says
// ═══════════════════════════════════════════
//
// Settings → AI connections → Executable paths has a row for the runtime authentication check of the OpenCode serves
// SynaBun runs (the server's lib/opencode-serve-probe.js through lib/opencode-native-boundary.js,
// GET /api/cli/opencode-serves): a native browser profile (MoreLogin) opens only while every serve listens on this
// computer only, refuses API calls and WebSockets without its password and accepts SynaBun's. This module reads an
// answer of the server into what the row shows; ui-opencode-verify.js draws it.
//
// No imports and no DOM: `node --test` loads this file as it is (tests/opencode-verify-view.test.mjs).
// OPENCODE_VERIFY_COPY is the English of every sentence; `opencodeVerify.*` in i18n/en.json must equal it and
// i18n/pt-BR.json must have the same keys. A server from before this has no such route: the row stays hidden.

export const OPENCODE_VERIFY_COPY = Object.freeze({
  label: 'Verify OpenCode',
  help: "A native browser profile (MoreLogin) opens only when every OpenCode serve on this computer passes its password check. Each new build (binary path and version) is checked once in a temporary serve, with no profile attached; after an update, starts may wait until the profile closes. Builds that passed may start with a profile attached; unchecked builds cannot. Every new serve is checked again right after starting; if it fails, SynaBun stops it and closes the attached browser pages.",
  badgeVerified: 'Verified',
  badgeRefused: 'Refused',
  badgeChecking: 'Checking',
  badgeIdle: 'No serve running',
  noServes: 'No OpenCode serve is running. The next one is checked when it starts.',
  scanFailed: 'SynaBun could not list the OpenCode serves of this computer, so a native browser profile does not open: {detail}',
  serveLine: 'pid {pid}, port {port}, OpenCode {version}: {state}',
  foreignLine: 'Not started by SynaBun: pid {pid}, port {port}: {state}',
  pathLine: 'Runs {path}',
  stateVerified: 'verified',
  stateVerifying: 'being checked',
  stateStarting: 'starting',
  stateFailed: 'refused, check "{check}" failed: {detail}',
  stateRefused: 'refused before any check: {reason}',
  stateStopping: 'refused, check "{check}" failed: {detail}. SynaBun is stopping it',
  stateStuck: 'refused, check "{check}" failed: {detail}. SynaBun could not confirm it stopped: end pid {pid} yourself',
  stateForeignFailed: 'refused, check "{check}" failed: {detail}. SynaBun never stops a serve it did not start',
  reasonCommandLine: 'started from the command line in Settings, whose binary SynaBun cannot check',
  reasonPassword: 'started without a private password',
  reasonVersionOld: 'OpenCode older than {minimum} was never checked',
  reasonVersionUnreadable: 'its version cannot be read',
  reasonUnknown: 'not admitted',
  checkLoopback: 'listens on this computer only',
  checkHttpAnonymous: 'API refuses calls without the password',
  checkHttpWrongPassword: 'API refuses a wrong password',
  checkWsAnonymous: 'WebSockets refuse upgrades without the password',
  checkCredentials: 'SynaBun\'s password is accepted',
  checkSurface: 'its API routes are known',
  checkWsWrongPassword: 'WebSockets refuse a wrong password or ticket',
  checkRouting: 'the password is asked before any route',
  checkWeakPassword: 'no guessable password opens it',
  checkProcess: 'the process is the OpenCode SynaBun started',
  checkVersion: 'its version is {minimum} or newer',
  checkPassed: '{name}: passed',
  checkFailed: '{name}: failed ({detail})',
  checkSkipped: '{name}: not asked',
  exeLine: 'SynaBun starts OpenCode {version} ({path}): {state}',
  exePassed: 'this build passed its check',
  exeFailed: 'this build failed its check "{check}": {detail}',
  exeKnownGood: 'a version checked by hand; checked again when it starts',
  exeNew: 'not checked yet; checked when it starts',
  exeOld: 'older than {minimum}, never admitted',
  exeUnreadable: 'its version cannot be read, never admitted',
  exeCommandLine: 'SynaBun starts the command line set above; its binary cannot be checked, so a native browser profile does not open while it runs.',
  exeMissing: 'OpenCode is not installed.',
  fix: 'To fix a refused serve: stop it (close the OpenCode panel), choose another OpenCode in the field above, or report the incompatibility.',
  fixForeign: 'To fix an OpenCode SynaBun did not start: stop it yourself, or start it again so that it needs a password (never a guessable one) and listens on 127.0.0.1 only.',
  verify: 'Verify again',
  checking: 'Checking…',
  errorRequest: 'SynaBun did not answer: {message}',
});

const CHECK_NAMES = Object.freeze({
  loopback: 'checkLoopback', 'http-anonymous': 'checkHttpAnonymous', 'http-wrong-password': 'checkHttpWrongPassword',
  'ws-anonymous': 'checkWsAnonymous', credentials: 'checkCredentials', surface: 'checkSurface', 'ws-wrong-password': 'checkWsWrongPassword',
  routing: 'checkRouting', 'weak-password': 'checkWeakPassword', process: 'checkProcess', version: 'checkVersion',
});

const REASONS = Object.freeze({
  'command-line': 'reasonCommandLine', password: 'reasonPassword', 'version-old': 'reasonVersionOld', 'version-unreadable': 'reasonVersionUnreadable',
});

/** An OPENCODE_VERIFY_COPY sentence with its `{params}` filled in: the translator when the page gives none. */
export function fillOpencodeVerifyCopy(key, params = {}) {
  return String(OPENCODE_VERIFY_COPY[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? params[name] : whole));
}

let _translate = null;

/** The page's translator: `(key, params) => t('opencodeVerify.' + key, params)`; an empty answer or the key itself falls back to the English. */
export function setOpencodeVerifyTranslator(fn) {
  _translate = typeof fn === 'function' ? fn : null;
}

/** A sentence in the page's language. */
export function opencodeVerifyText(key, params = {}) {
  if (_translate) {
    try {
      const text = _translate(key, params);
      if (typeof text === 'string' && text && text !== key && text !== `opencodeVerify.${key}`) return text;
    } catch { /* the English below */ }
  }
  return fillOpencodeVerifyCopy(key, params);
}

let _minimum = '2.1.0';
const checkName = (id) => (CHECK_NAMES[id] ? opencodeVerifyText(CHECK_NAMES[id], { minimum: _minimum }) : String(id || '?'));

function serveState(serve, minimum) {
  const failed = { check: checkName(serve.failed), detail: serve.detail || '', pid: serve.pid ?? '?' };
  switch (serve.state) {
    case 'verified': return opencodeVerifyText('stateVerified');
    case 'verifying': return opencodeVerifyText('stateVerifying');
    case 'starting': return opencodeVerifyText('stateStarting');
    case 'failed':
      if (serve.own === false) return opencodeVerifyText('stateForeignFailed', failed);
      if (serve.stuck) return opencodeVerifyText('stateStuck', failed);
      if (serve.stopping) return opencodeVerifyText('stateStopping', failed);
      return opencodeVerifyText('stateFailed', failed);
    case 'refused': return opencodeVerifyText('stateRefused', { reason: opencodeVerifyText(REASONS[serve.reason] || 'reasonUnknown', { minimum }) });
    default: return String(serve.state || '');
  }
}

function exeLine(exe, minimum) {
  if (!exe || typeof exe !== 'object') return null;
  if (exe.commandLine) return opencodeVerifyText('exeCommandLine');
  if (!exe.path) return opencodeVerifyText('exeMissing');
  let state;
  if (exe.policy === 'version-old') state = opencodeVerifyText('exeOld', { minimum });
  else if (exe.policy === 'version-unreadable') state = opencodeVerifyText('exeUnreadable');
  else if (exe.verdict && exe.verdict.ok) state = opencodeVerifyText('exePassed');
  else if (exe.verdict) state = opencodeVerifyText('exeFailed', { check: checkName(exe.verdict.failed), detail: exe.verdict.detail || '' });
  else state = opencodeVerifyText(exe.knownGood ? 'exeKnownGood' : 'exeNew');
  return opencodeVerifyText('exeLine', { version: exe.version || '?', path: exe.path, state });
}

// 'ok' (verified), 'refused' (failed or refused) or 'checking' (starting, being checked): what the row colours a serve
// by, next to the words that say the same.
const toneOf = (state) => (state === 'verified' ? 'ok' : state === 'failed' || state === 'refused' ? 'refused' : 'checking');

/**
 * The row for one answer of GET /api/cli/opencode-serves: SynaBun's serves, then the OpenCode serves SynaBun did not
 * start (`foreign`), each with its state, the file it runs and its checks.
 * @returns {{ visible: boolean, badge: { text: string, tone: 'detected' | 'not-found' | 'custom' } | null, line: string,
 *   serves: Array<{ text: string, ok: boolean, tone: 'ok' | 'refused' | 'checking', own: boolean, path: string | null, checks: string[] }>,
 *   executable: string | null, fix: boolean, fixForeign: boolean, busy: boolean }}
 */
export function opencodeVerifyView(status) {
  const hidden = { visible: false, badge: null, line: '', serves: [], executable: null, fix: false, fixForeign: false, busy: false };
  if (!status || typeof status !== 'object' || status.ok !== true || !Array.isArray(status.serves)) return hidden;
  const minimum = status.minimum || '2.1.0';
  _minimum = minimum;
  const all = [...status.serves.map((s) => ({ ...s, own: s.own !== false })), ...(Array.isArray(status.foreign) ? status.foreign.map((s) => ({ ...s, own: false })) : [])];
  const serves = all.map((serve) => ({
    ok: serve.state === 'verified',
    tone: toneOf(serve.state),
    own: serve.own,
    path: serve.path ? opencodeVerifyText('pathLine', { path: serve.path }) : null,
    text: opencodeVerifyText(serve.own ? 'serveLine' : 'foreignLine', { pid: serve.pid ?? '?', port: serve.port ?? '?', version: serve.version || '?', state: serveState(serve, minimum) }),
    checks: (Array.isArray(serve.checks) ? serve.checks : []).map((c) => (c.skipped ? opencodeVerifyText('checkSkipped', { name: checkName(c.id) })
      : c.ok ? opencodeVerifyText('checkPassed', { name: checkName(c.id) }) : opencodeVerifyText('checkFailed', { name: checkName(c.id), detail: c.detail || '' }))),
  }));
  const scanFailed = !!status.scan && status.scan.ok === false;
  const states = all.map((s) => s.state);
  const refused = scanFailed || states.some((s) => s === 'failed' || s === 'refused');
  const busy = states.some((s) => s === 'verifying' || s === 'starting');
  const exe = exeLine(status.executable, minimum);
  const exeRefused = !!status.executable && (status.executable.verdict?.ok === false || ['version-old', 'version-unreadable'].includes(status.executable.policy));
  const badge = refused ? { text: opencodeVerifyText('badgeRefused'), tone: 'not-found' }
    : busy ? { text: opencodeVerifyText('badgeChecking'), tone: 'custom' }
      : serves.length ? { text: opencodeVerifyText('badgeVerified'), tone: 'detected' }
        : { text: opencodeVerifyText('badgeIdle'), tone: 'custom' };
  const line = scanFailed ? opencodeVerifyText('scanFailed', { detail: status.scan.detail || '' }) : serves.length ? '' : opencodeVerifyText('noServes');
  return { visible: true, badge, line, serves, executable: exe,
    fix: all.some((s) => s.own && (s.state === 'failed' || s.state === 'refused')) || exeRefused,
    fixForeign: all.some((s) => !s.own && s.state === 'failed'), busy };
}
