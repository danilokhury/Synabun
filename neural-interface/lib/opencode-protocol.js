// ─────────────────────────────────────────────────────────────────────────────
// Which OpenCode SynaBun talks to, and how to know it is really there.
//
// SynaBun drives OpenCode 2 and nothing else (OpenCode 1 support was removed
// on 2026-10-24). OpenCode 2 (`opencode --version` → "opencode v2.1.4") serves
// its API under /api/*, behind HTTP Basic auth (user `opencode`) with a
// password set per launch. Production serves generate it privately on stdout
// (serveSpecFor passwordFrom 'stdout'); an environment password would remain
// readable in the process and its shell's programs. The low-level 'env' mode
// remains for explicit callers/fixtures. Every other path is its web app, an HTML page with
// status 200. SynaBun reads the version of the binary it is about to start
// (the CLI resolver's cached `--version`, keyed by the file, so an upgrade in
// place is read again), refuses an OpenCode it does not drive with one
// sentence that says what was found and how to get OpenCode 2, and calls a
// serve healthy only when OpenCode 2's API answers JSON: an HTML page never
// passes.
//
// OPENCODE_MIN_VERSION is the oldest OpenCode 2 SynaBun's OpenCode layer was
// built and checked against (the recorded events of tests/fixtures/
// opencode2-events.json, the plugin hook of the route gate and the browser
// policy, the live smoke test). npm's `opencode-ai` package is still OpenCode
// 1; OpenCode 2 comes from its own installer (https://opencode.ai/v2/install),
// Homebrew (anomalyco/tap/opencode-v2) or WinGet (Anomaly.OpenCode).
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

export const OPENCODE_MIN_VERSION = '2.0.32';
export const OPENCODE_USERNAME = 'opencode';

/** "2.1.4", "opencode v2.1.4", "v1.19.3" → { major, minor, patch }; null when no version can be read. */
export function opencodeVersionOf(version) {
  const match = String(version ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return [major, minor, patch].every(Number.isFinite) ? { major, minor, patch } : null;
}

const MINIMUM = opencodeVersionOf(OPENCODE_MIN_VERSION);

function olderThanMinimum(v) {
  if (v.major !== MINIMUM.major) return v.major < MINIMUM.major;
  if (v.minor !== MINIMUM.minor) return v.minor < MINIMUM.minor;
  return v.patch < MINIMUM.patch;
}

/**
 * The commands that install OpenCode 2 on a system, the first one first: OpenCode's own installer
 * (https://opencode.ai/v2/install, the one `opencode upgrade` runs), its Homebrew tap, WinGet on Windows.
 */
export function opencodeInstallCommands(platform = process.platform) {
  if (platform === 'win32') return ['winget install --id Anomaly.OpenCode --exact'];
  if (platform === 'darwin') return ['brew install anomalyco/tap/opencode-v2', 'curl -fsSL https://opencode.ai/v2/install | bash'];
  return ['curl -fsSL https://opencode.ai/v2/install | bash'];
}

/** How to get OpenCode 2 on a system, as words of a sentence ("run: …, or: …"). */
export function opencodeInstallRoute(platform = process.platform) {
  return opencodeInstallCommands(platform).map((command, index) => `${index ? 'or: ' : 'run: '}${command}`).join(', ');
}

/**
 * Whether SynaBun drives the OpenCode of a version string: `{ supported,
 * version, major, reason, code }`. `reason` is the one sentence a person reads
 * when it does not: what was found (`path`, when known) and how to get OpenCode
 * 2; `code` says which case it is ('unreadable' | 'opencode1' | 'newer' |
 * 'outdated'), for a page that words it in its own language.
 */
export function opencodeSupportFor(version, { path = null, platform = process.platform } = {}) {
  const text = version ? String(version).trim() : '';
  const parsed = opencodeVersionOf(text);
  const where = path ? ` (${path})` : '';
  // What every refusal but an outdated OpenCode 2's ends with: how to get OpenCode 2, or where to pick one.
  const getOpencode2 = `install OpenCode 2 (${opencodeInstallRoute(platform)}), or choose an OpenCode 2 under Settings → Executable paths`;
  if (!parsed) {
    const found = text ? `SynaBun cannot read the OpenCode version "${text}"${where}` : `SynaBun could not read the version of the OpenCode it found${where}`;
    return { supported: false, version: text || null, major: null, code: 'unreadable', reason: `${found}, and it needs OpenCode 2 (${OPENCODE_MIN_VERSION} or newer): ${getOpencode2}.` };
  }
  const { major } = parsed;
  // The version as OpenCode prints it, without its name ("opencode v2.1.4" → "2.1.4", a prerelease kept whole).
  const shown = text.replace(/^opencode\s+/i, '').replace(/^v(?=\d)/i, '') || `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  if (major <= 1) {
    return { supported: false, version: text, major, code: 'opencode1', reason: `SynaBun works with OpenCode 2 only, and the OpenCode it found${where} is version ${shown}: install OpenCode 2 (${opencodeInstallRoute(platform)}; npm's opencode-ai package is still OpenCode 1), or choose an OpenCode 2 under Settings → Executable paths.` };
  }
  if (major >= 3) {
    return { supported: false, version: text, major, code: 'newer', reason: `OpenCode ${shown}${where} is newer than SynaBun supports: SynaBun works with OpenCode 2 only, so ${getOpencode2}.` };
  }
  if (olderThanMinimum(parsed)) {
    return { supported: false, version: text, major, code: 'outdated', reason: `SynaBun needs OpenCode ${OPENCODE_MIN_VERSION} or newer, and the OpenCode it found${where} is version ${shown}: update it (run: opencode upgrade).` };
  }
  return { supported: true, version: text, major, code: null, reason: null };
}

/** A fresh password for one serve launch. */
export function newServePassword() {
  return randomBytes(24).toString('base64url');
}

/** The Authorization header for a serve. */
export function basicAuthHeader(password, username = OPENCODE_USERNAME) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** The environment variables OpenCode 2 takes its serve password from (OPENCODE_PASSWORD first). */
export const SERVE_PASSWORD_ENV = Object.freeze(['OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD']);

/**
 * The arguments and environment of `opencode serve` on `port`: its loopback
 * host name and the launch's password. `passwordFrom`:
 *   'env'     (default) the password is OPENCODE_PASSWORD (any
 *             OPENCODE_SERVER_PASSWORD the environment carries is dropped, so
 *             the password SynaBun holds is the one the serve checks). OpenCode
 *             2 keeps it in its own environment, so every program its shell
 *             starts inherits it, and a process of the same user can read it
 *             in the serve's start-up environment (ps eww).
 *   'stdout'  no password variable at all: OpenCode 2 makes one up and prints
 *             it once on its standard output ("server password <it>", after
 *             "server listening on …"), which SynaBun reads
 *             (servePasswordReader) and keeps out of its logs
 *             (redactServeOutput). The password is in no environment: not the
 *             serve's, not its shell's. `password` is null until it is read.
 *             A launch through a login shell removes both variables after the
 *             profile ran (`unset`, serveUnsetCommand), so a profile that
 *             exports one cannot put it back.
 */
export function serveSpecFor(port, { env = process.env, password = null, passwordFrom = 'env' } = {}) {
  const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
  const next = { ...env };
  for (const key of SERVE_PASSWORD_ENV) delete next[key];
  if (passwordFrom === 'stdout') return { args, env: next, password: null, passwordFrom: 'stdout' };
  const pass = password || newServePassword();
  next.OPENCODE_PASSWORD = pass;
  return { args, env: next, password: pass, passwordFrom: 'env' };
}

/** What a POSIX shell runs before `exec opencode serve` of a 'stdout' launch: the password variables gone. */
export function serveUnsetCommand() {
  return `unset ${SERVE_PASSWORD_ENV.join(' ')}`;
}

const SERVE_PASSWORD_LINE = /(?:^|\n)server password (\S+)[ \t]*\r?\n/;

/**
 * A reader of a 'stdout' serve's output: feed it each chunk of standard output; it answers the password once its
 * line is complete ("server password <it>" and a line end), else null. Chunks may split the line anywhere.
 */
export function servePasswordReader() {
  let buffered = '';
  let found = null;
  return (chunk) => {
    if (found) return found;
    buffered = `${buffered}${String(chunk ?? '')}`.slice(-4096);
    const m = SERVE_PASSWORD_LINE.exec(buffered);
    if (m) found = m[1];
    return found;
  };
}

/** Serve output with its password line taken out (what a log may hold). */
export function redactServeOutput(text) {
  return String(text ?? '').replace(/server password \S+/g, 'server password <hidden>');
}

/**
 * A line-buffering redactor for either of a serve's output streams. redactServeOutput runs on whole lines only: a chunk of a
 * stream may split the "server password <x>" line anywhere (the token across two reads), and redacting each chunk on
 * its own would let a fragment of the password through to the log. Feed every chunk to `push`; it assembles complete
 * lines, redacts each and hands it to `emit` (the trailing newline kept). Call `flush` once the stream ends to emit a
 * last line that never got its newline. A partial line that grows past `maxLine` without a newline is redacted and
 * emitted so the buffer cannot grow without bound (the password line is short and newline-terminated, so this cap is
 * never reached mid-password).
 */
export function createServeLogRedactor(emit, { maxLine = 65536 } = {}) {
  let buf = '';
  const drain = (final) => {
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl + 1);
      buf = buf.slice(nl + 1);
      emit(redactServeOutput(line));
    }
    if ((final || buf.length > maxLine) && buf) { emit(redactServeOutput(buf)); buf = ''; }
  };
  return {
    push: (chunk) => { buf += String(chunk ?? ''); drain(false); },
    flush: () => drain(true),
  };
}

/**
 * A serve's environment with a run's own settings on top: a string value is set, null (or undefined) removes the
 * variable, anything else is ignored. `GIT_*: null` clears every inherited git variable BEFORE the explicit
 * settings are applied, so SynaBun's own git safety settings survive. The marker never reaches the child.
 * A new object; `env` is not changed. Also used for evaluation runtimes, whose whole process tree needs this policy.
 */
export function withServeEnv(env, extra) {
  const next = { ...(env || {}) };
  if (extra && typeof extra === 'object') {
    if (extra['GIT_*'] === null) for (const key of Object.keys(next)) if (key.startsWith('GIT_')) delete next[key];
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'GIT_*') continue;
      if (typeof value === 'string') next[key] = value;
      else if (value === null || value === undefined) delete next[key];
    }
  }
  return next;
}

function isJsonResponse(res) {
  return /\bapplication\/json\b/i.test(String(res?.headers?.get?.('content-type') || ''));
}

async function readJson(res) {
  if (!isJsonResponse(res)) return { json: null, html: /text\/html/i.test(String(res?.headers?.get?.('content-type') || '')) };
  try { return { json: await res.json(), html: false }; } catch { return { json: null, html: false }; }
}

/**
 * Is OpenCode 2's API answering on `port`? Asks /api/info with `password`.
 * Resolves `{ ok, version, state, error }`, where `state` is
 *   'healthy'     OpenCode 2's API answered JSON, from a version SynaBun drives
 *   'unsupported' OpenCode's API answered, from a version SynaBun does not drive
 *                 (`error` is opencodeSupportFor's sentence)
 *   'locked'      an OpenCode 2 serve whose password SynaBun does not hold
 *   'html'        a web page — never healthy
 *   'down'        nothing answered
 *   'error'       something answered, but not OpenCode 2's API
 * Never throws.
 */
export async function checkOpencodeServer({ port, password = null, fetchImpl = globalThis.fetch, timeoutMs = 2000, host = '127.0.0.1' } = {}) {
  let res;
  try {
    res = await fetchImpl(`http://${host}:${port}/api/info`, {
      headers: { accept: 'application/json', ...(password ? { authorization: basicAuthHeader(password) } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, version: null, state: 'down', error: String(error?.message || error) };
  }
  const { json, html } = await readJson(res);
  if (res.ok && json && typeof json.version === 'string' && Array.isArray(json.urls)) {
    const support = opencodeSupportFor(json.version);
    if (!support.supported) return { ok: false, version: json.version, state: 'unsupported', error: support.reason };
    return { ok: true, version: json.version, state: 'healthy', error: null };
  }
  if (res.status === 401 && json && /unauthori[sz]ed/i.test(String(json._tag || json.name || ''))) {
    return { ok: false, version: null, state: 'locked', error: password ? 'the OpenCode serve refused SynaBun\'s password' : 'an OpenCode serve SynaBun did not start (it needs that serve\'s password)' };
  }
  return { ok: false, version: null, state: html ? 'html' : 'error', error: html ? 'answered with a web page, not the OpenCode 2 API' : `GET /api/info answered ${res.status}` };
}

// An upgrade must be rejected before PTY/resource lookup, even for an Origin
// that OpenCode permits. Never place a real credential in a URL or this probe.
export function probeUnauthenticatedUpgrade({ port, timeoutMs = 2000 } = {}) {
  return new Promise(resolve => {
    const req = httpRequest({ hostname: '127.0.0.1', port,
      path: '/api/pty/synabun-auth-probe/connect',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'), origin: 'http://localhost:1' },
    });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Readiness for private serves: valid client + denied anonymous HTTP AND WS.
 * An unmanaged, passwordless API is never adopted. Errors contain no secrets.
 */
export async function checkPrivateOpencodeServer(options = {}) {
  const check = await checkOpencodeServer(options);
  if (!check.ok) return check;
  const refused = () => ({ ok: false, version: check.version, state: 'unsecured',
    error: 'OpenCode did not prove private HTTP and WebSocket authentication; it will not be used.' });
  if (!options.password) return refused();
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(`http://127.0.0.1:${options.port}/api/info`, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs || 2000), redirect: 'error',
    });
    await response.body?.cancel();
    if (response.status !== 401 || await probeUnauthenticatedUpgrade(options) !== 401) return refused();
  } catch { return refused(); }
  return check;
}

/**
 * The sentence a person reads when OpenCode cannot be used: what was found and
 * what to do. `check` is a checkOpencodeServer answer, `detected` an
 * opencodeSupportFor answer.
 */
export function opencodeProblemText({ check = null, detected = null, port = null } = {}) {
  if (detected && !detected.supported) return detected.reason;
  if (!check || check.ok) return '';
  const where = port ? ` on port ${port}` : '';
  switch (check.state) {
    case 'unsupported':
      return check.error || `The OpenCode server${where} is a version SynaBun does not drive.`;
    case 'locked':
      return `An OpenCode server SynaBun did not start is already running${where}, and SynaBun does not have its password. Stop that server (or free the port) and start OpenCode again from SynaBun.`;
    case 'html':
      return `Something${where} answers with a web page instead of the OpenCode 2 API (${check.error}).`;
    case 'down':
      return `OpenCode is not answering${where}.`;
    default:
      return `OpenCode${where} did not answer as OpenCode 2: ${check.error || 'unknown error'}.`;
  }
}
