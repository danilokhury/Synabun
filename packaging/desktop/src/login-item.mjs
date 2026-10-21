/**
 * Open at login: the system's own login entry for this app, read back from the
 * system every time (never only from the settings file), and how a start at
 * login is told from a start by the user: the entry says so itself, always.
 * Pure: Electron's app, the file calls and the programs it runs are handed in
 * (packaging/tests/desktop-app-controls.test.mjs).
 *
 *   macOS    a LaunchAgent (~/Library/LaunchAgents/ai.synabun.app.login.plist,
 *            listed under System Settings > General > Login Items > Allow in
 *            the Background) that runs `open -g -a <the app> --env
 *            SYNABUN_DESKTOP_LOGIN=1`. SMAppService gives a login item neither
 *            an argument nor an environment, and macOS 13 no longer says which
 *            start was the login item's; `open --env` does. When SynaBun is
 *            already running, `open` only brings it forward (the window shows).
 *   Windows  app.setLoginItemSettings: HKCU\...\Run under Electron's own value
 *            name (the app's AppUserModelId, WIN_RUN_NAME: the only name its
 *            getLoginItemSettings reads), the window's executable, quoted by
 *            Electron, with LOGIN_FLAG. The packaged executable hands
 *            arguments to the command line entry only when they name a mode
 *            (cli.mjs CLI_MODES), so the flag always opens the window.
 *            Startup apps' switch is read from the registry (StartupApproved).
 *   Linux    an XDG autostart entry (~/.config/autostart/synabun-app.desktop)
 *            that runs the AppImage file itself ($APPIMAGE, never the mount it
 *            runs from) with LOGIN_ENV in its environment. The AppImage's entry
 *            opens the window only when it is given no argument, so the signal
 *            is the environment, not a flag.
 *
 * The entry starts the data folder and the port this copy runs with when they
 * are not the usual ones (SYNABUN_DATA_HOME, NEURAL_PORT: loginCarry): in the
 * environment on macOS and Linux, in LOGIN_DATA_FLAG / LOGIN_PORT_FLAG on
 * Windows (the folder base64url-encoded, so no quoting can split it), which
 * applyLoginArguments() turns back into the environment before anything reads it.
 *
 * Kept in place on every start while it is wanted (heal): the app moved, a
 * newer AppImage of another name runs. An entry the user turned off in the
 * system (Allow in the Background on macOS, Startup apps on Windows, the
 * desktop's startup applications on Linux) or removed stays off, and the
 * setting follows the system.
 *
 * An npm install of SynaBun on the same data folder has a login entry of its
 * own (neural-interface/lib/login-start.js: NPM_LOGIN and DESKTOP_LOGIN name
 * both the same way; a test keeps the two files equal). Both at login would
 * start two servers on one data folder: turning this one on removes that one,
 * and the npm install reads this one to refuse its own.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';

/** Windows: the argument the login item starts the window with. */
export const LOGIN_FLAG = '--synabun-login';
/** Windows: the data folder (base64url) and the port a start at login runs with, when they are not the usual ones. */
export const LOGIN_DATA_FLAG = '--synabun-data-home=';
export const LOGIN_PORT_FLAG = '--synabun-port=';
/** macOS and Linux: the environment variable the login entry starts the app with. */
export const LOGIN_ENV = 'SYNABUN_DESKTOP_LOGIN';
export const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WIN_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
/** Electron names the Run value after the AppUserModelId (main.mjs setAppUserModelId) and reads only that name. */
export const WIN_RUN_NAME = 'ai.synabun.app';
export const MAC_LOGIN_LABEL = 'ai.synabun.app.login';
export const LINUX_AUTOSTART_FILE = 'synabun-app.desktop';
/** The marker line of the app's autostart entry. */
export const LINUX_MARKER = 'X-SynaBun-Login=app';
/** System Settings > General > Login Items (macOS 13 and later), where Allow in the Background is. */
export const MAC_LOGIN_ITEMS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

/** This app's login entries, as the npm install reads them (neural-interface/lib/login-start.js DESKTOP_LOGIN must be equal). */
export const DESKTOP_LOGIN = Object.freeze({
  macLabel: MAC_LOGIN_LABEL,
  winName: WIN_RUN_NAME,
  linuxFile: LINUX_AUTOSTART_FILE,
  env: LOGIN_ENV,
  flag: LOGIN_FLAG,
  dataFlag: LOGIN_DATA_FLAG,
  portFlag: LOGIN_PORT_FLAG,
});

/** The npm install's login entries (neural-interface/lib/login-start.js NPM_LOGIN must be equal). */
export const NPM_LOGIN = Object.freeze({
  macLabel: 'ai.synabun.server',
  winName: 'SynaBun Server',
  linuxFile: 'synabun-server.desktop',
});

function defaultRun(file, args, { timeout = 5000 } = {}) {
  return execFileSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

const DEFAULT_FS = { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync };

function failure(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// ── Where a login item can be ──

/**
 * Can this copy have a login item? `{ supported, reason }`; reason is one of
 * 'unpackaged' (run from source), 'move-to-applications' (macOS runs it from a
 * disk image or a temporary place) or 'no-appimage' (Linux, not an AppImage).
 */
export function loginSupport({ platform = process.platform, packaged = true, env = process.env, temporary = false } = {}) {
  if (!packaged) return { supported: false, reason: 'unpackaged' };
  if (platform === 'darwin' && temporary) return { supported: false, reason: 'move-to-applications' };
  if (platform === 'linux' && !String(env.APPIMAGE || '').startsWith('/')) return { supported: false, reason: 'no-appimage' };
  if (!['darwin', 'win32', 'linux'].includes(platform)) return { supported: false, reason: 'unsupported' };
  return { supported: true, reason: null };
}

/** The program a login item starts: the .app on macOS, the AppImage file on Linux, the executable on Windows. */
export function loginTarget({ platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  if (platform === 'linux') return String(env.APPIMAGE || '') || null;
  if (platform === 'darwin') {
    const contents = posix.dirname(posix.dirname(execPath));
    const bundle = posix.dirname(contents);
    return /\.app$/i.test(bundle) && /\/Contents$/.test(contents) ? bundle : execPath;
  }
  return execPath;
}

// ── Linux: the XDG autostart entry ──

export function autostartDir({ env = process.env, home = homedir() } = {}) {
  const config = String(env.XDG_CONFIG_HOME || '');
  return posix.join(config.startsWith('/') ? config : posix.join(home, '.config'), 'autostart');
}

/** One argument of a .desktop Exec line (lib/start-launcher.js desktopExecArg: a test keeps the two equal). */
export function desktopExecArg(value) {
  const quoted = `"${String(value).replace(/(["`$\\])/g, '\\$1')}"`;
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

export function linuxAutostartEntry(image, carry = {}) {
  const vars = [`${LOGIN_ENV}=1`,
    ...(carry.dataHome ? [desktopExecArg(`SYNABUN_DATA_HOME=${carry.dataHome}`)] : []),
    ...(carry.port ? [`NEURAL_PORT=${carry.port}`] : [])];
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=SynaBun',
    'Comment=Opens SynaBun when you log in',
    // The environment says "at login": the AppImage's entry opens the window only without an argument.
    `Exec=env ${vars.join(' ')} ${desktopExecArg(image)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    LINUX_MARKER,
    '',
  ].join('\n');
}

/** The [Desktop Entry] group of a .desktop file, key by key (the first value of a key counts). */
export function parseDesktopEntry(text) {
  const out = {};
  let inGroup = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inGroup = line === '[Desktop Entry]'; continue; }
    if (!inGroup) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!(key in out)) out[key] = line.slice(at + 1).trim();
  }
  return out;
}

/** An autostart entry the user (or the desktop) switched off: Hidden=true, or GNOME's own switch. */
export function desktopEntryDisabled(entry) {
  return /^true$/i.test(entry.Hidden || '') || /^false$/i.test(entry['X-GNOME-Autostart-enabled'] || 'true');
}

/** The words of a .desktop Exec value (quoting and escapes undone; field codes dropped). */
export function splitDesktopExec(value) {
  const unescaped = String(value || '').replace(/\\\\/g, '\\').replace(/%%/g, '\u0000');
  const words = [];
  let word = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < unescaped.length; i++) {
    const ch = unescaped[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < unescaped.length) { word += unescaped[++i]; continue; }
      if (ch === '"') { quoted = false; continue; }
      word += ch;
    } else if (ch === '"') { quoted = true; any = true; } else if (/\s/.test(ch)) {
      if (word || any) words.push(word);
      word = ''; any = false;
    } else word += ch;
  }
  if (word || any) words.push(word);
  return words.filter(w => !/^%[a-zA-Z]$/.test(w)).map(w => w.replace(/\u0000/g, '%'));
}

// ── Windows: the registry ──

/**
 * One REG_SZ value of a `reg export` file (UTF-16, as reg.exe writes it), or null. `reg query` prints in the console's
 * code page, which turns a non-ASCII folder name (C:\Users\João) into other characters; the export keeps it.
 */
export function parseRegExport(text, name) {
  const quoted = `"${String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"=`;
  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.toLowerCase().startsWith(quoted.toLowerCase())) continue;
    const rest = line.slice(quoted.length);
    if (!rest.startsWith('"') || !rest.endsWith('"')) return null;
    return rest.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return null;
}

/** The text of a file reg.exe wrote: UTF-16 LE with its mark, else UTF-8. */
export function decodeRegFile(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8');
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
}

/** One value of HKCU\...\Run, read through `reg export` (Unicode-safe), or null. */
export function readRunValue(name, { run = defaultRun, fs = DEFAULT_FS, env = process.env, tmp = tmpdir() } = {}) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
  const file = join(tmp, `synabun-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.reg`);
  try {
    run(root ? win32.join(root, 'System32', 'reg.exe') : 'reg', ['export', WIN_RUN_KEY, file, '/y']);
    return parseRegExport(decodeRegFile(fs.readFileSync(file)), name);
  } catch {
    return null;
  } finally {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

/** The data of one value in `reg query` output, or null. */
export function parseRegQuery(output, name) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line) || /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)\s*$/.exec(line);
    if (match && match[1].toLowerCase() === String(name).toLowerCase()) return (match[3] ?? '').trim();
  }
  return null;
}

/** Windows' Startup apps switch, from its REG_BINARY: an odd first byte is "disabled". null when unknown. */
export function startupApproved(hex) {
  const first = /^[0-9a-f]{2}/i.exec(String(hex || '').trim());
  if (!first) return null;
  return (parseInt(first[0], 16) & 1) === 0;
}

/** The words of a Windows command line (CommandLineToArgvW's quoting). */
export function splitWindowsCommand(line) {
  const text = String(line || '');
  const words = [];
  let word = '';
  let quoted = false;
  let any = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      let slashes = 0;
      while (text[i] === '\\') { slashes++; i++; }
      if (text[i] === '"') {
        // 2n backslashes and a quote: n backslashes, and the quote opens or closes; 2n+1: n and a literal quote.
        word += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) { word += '"'; any = true; i++; }
      } else {
        word += '\\'.repeat(slashes);
      }
      continue;
    }
    i++;
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (word || any) words.push(word);
      word = '';
      any = false;
      continue;
    }
    word += ch;
  }
  if (word || any) words.push(word);
  return words;
}

// ── What a login entry carries ──

const PORT_RE = /^[1-9]\d{0,4}$/;
const toBase64Url = (text) => Buffer.from(String(text), 'utf8').toString('base64url');
const fromBase64Url = (text) => { try { return Buffer.from(String(text), 'base64url').toString('utf8'); } catch { return ''; } };

/** What a start at login has to be told: the data folder and the port, when this copy runs with ones of its own. */
export function loginCarry({ env = process.env, dataHome } = {}) {
  const port = String(env.NEURAL_PORT || '').trim();
  return {
    dataHome: env.SYNABUN_DATA_HOME && dataHome ? dataHome : null,
    port: PORT_RE.test(port) && Number(port) <= 65535 ? port : null,
  };
}

/** Windows: the login item's arguments for what it carries. */
export function windowsLoginArgs(carry = {}) {
  return [
    LOGIN_FLAG,
    ...(carry.dataHome ? [`${LOGIN_DATA_FLAG}${toBase64Url(carry.dataHome)}`] : []),
    ...(carry.port ? [`${LOGIN_PORT_FLAG}${carry.port}`] : []),
  ];
}

/**
 * Windows: a start at login carries its data folder and port as arguments; they become the environment here, before
 * anything reads it (main.mjs, first thing). Only beside LOGIN_FLAG. Returns what it applied.
 */
export function applyLoginArguments({ argv = process.argv, env = process.env } = {}) {
  if (!argv.includes(LOGIN_FLAG)) return {};
  const applied = {};
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith(LOGIN_DATA_FLAG)) {
      const folder = fromBase64Url(arg.slice(LOGIN_DATA_FLAG.length));
      if (folder && !folder.includes('\0')) { env.SYNABUN_DATA_HOME = folder; applied.dataHome = folder; }
    } else if (arg.startsWith(LOGIN_PORT_FLAG)) {
      const port = arg.slice(LOGIN_PORT_FLAG.length);
      if (PORT_RE.test(port) && Number(port) <= 65535) { env.NEURAL_PORT = port; applied.port = port; }
    }
  }
  return applied;
}

/** The data folder and port a Windows login value names (the npm install reads it), from its words. */
export function windowsLoginCarry(words = []) {
  const out = { dataHome: null, port: null };
  for (const word of words) {
    if (word.startsWith(LOGIN_DATA_FLAG)) out.dataHome = fromBase64Url(word.slice(LOGIN_DATA_FLAG.length)) || null;
    else if (word.startsWith(LOGIN_PORT_FLAG)) out.port = word.slice(LOGIN_PORT_FLAG.length);
  }
  return out;
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Does this Mac's `open` take --env? Its usage (`open -h`, which exits 1) names the option when it does. */
export function macOpenTakesEnv({ run = defaultRun } = {}) {
  let text = '';
  try { text = String(run('/usr/bin/open', ['-h']) || ''); } catch (error) { text = `${error?.stdout || ''}${error?.stderr || ''}`; }
  return /(^|\s)--env\b/.test(text);
}

/**
 * macOS: the LaunchAgent that opens the app at login, by the app's absolute path (never by name: a Safari web app
 * or another copy may be called SynaBun too), with the login variable and what it carries. Where `open` has no
 * --env (`openEnv` false) a start at login cannot say it is one: the agent opens SynaBun all the same, without the
 * variable, so its window shows; with a data folder or port to carry, it runs the app's own program with them in
 * its environment (launchd must leave what the app starts alone when it quits: AbandonProcessGroup).
 */
export function macLaunchAgent(bundle, carry = {}, { home = homedir(), openEnv = true } = {}) {
  if (!posix.isAbsolute(String(bundle || ''))) throw failure('not-absolute', `the app's path is not absolute: ${bundle}`);
  const carried = [
    ...(carry.dataHome ? [['SYNABUN_DATA_HOME', carry.dataHome]] : []),
    ...(carry.port ? [['NEURAL_PORT', carry.port]] : []),
  ];
  // -g: a start at login does not take the focus from what the user opened first.
  const words = openEnv
    ? ['/usr/bin/open', '-g', '-a', bundle, '--env', `${LOGIN_ENV}=1`, ...carried.flatMap(([key, value]) => ['--env', `${key}=${value}`])]
    : carried.length ? [posix.join(bundle, 'Contents', 'MacOS', 'SynaBun')] : ['/usr/bin/open', '-a', bundle];
  const environment = !openEnv && carried.length
    ? ['  <key>EnvironmentVariables</key>', '  <dict>', ...carried.map(([key, value]) => `    <key>${key}</key><string>${xmlEscape(value)}</string>`), '  </dict>',
      '  <key>AbandonProcessGroup</key><true/>']
    : [];
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${MAC_LOGIN_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...words.map(word => `    <string>${xmlEscape(word)}</string>`),
    '  </array>',
    ...environment,
    '  <key>RunAtLoad</key><true/>',
    // System Settings names the item after the app.
    '  <key>AssociatedBundleIdentifiers</key><array><string>ai.synabun.app</string></array>',
    '  <key>LimitLoadToSessionType</key><string>Aqua</string>',
    '  <key>ProcessType</key><string>Interactive</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return { path: posix.join(home, 'Library', 'LaunchAgents', `${MAC_LOGIN_LABEL}.plist`), content, words };
}

// ── The login item ──

/**
 * The login item of this copy. `app` is Electron's (Windows: getLoginItemSettings,
 * setLoginItemSettings); `target` is what the item starts (loginTarget); `carry`
 * the data folder and port it starts with (loginCarry).
 *
 *   read()          { enabled, status }: status 'on', 'off' or 'disabled' (turned
 *                   off in the system)
 *   set(enabled)    turn it on or off; resolves to read(). Throws { code } when
 *                   the system refused ('refused', 'write-failed')
 *   heal()          on a start while it is wanted: puts it back in place when it
 *                   went stale (the app moved, another AppImage name, other
 *                   pins); { status, keep, changed } where keep is false when the
 *                   user turned it off or removed it in the system (the setting
 *                   follows)
 */
export function createLoginItem({
  platform = process.platform, app, execPath = process.execPath, env = process.env, home = homedir(),
  fs = DEFAULT_FS, run = defaultRun, log = () => {}, carry = {},
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const target = loginTarget({ platform, execPath, env });
  // No `path`: Electron then names its own executable, quoted. No `name`: its reads look only at its own name.
  const winOptions = { args: windowsLoginArgs(carry) };
  const autostartFile = posix.join(autostartDir({ env, home }), LINUX_AUTOSTART_FILE);
  // macOS: what this Mac's `open` can do decides the agent (asked once, when the entry is first needed).
  let agentPlan = null;
  const macAgent = () => agentPlan || (agentPlan = macLaunchAgent(target, carry, { home, openEnv: macOpenTakesEnv({ run }) }));
  const regExe = () => {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
    return root ? win32.join(root, 'System32', 'reg.exe') : 'reg';
  };
  const regValue = (key, name) => {
    try { return parseRegQuery(run(regExe(), ['query', key, '/v', name]), name); } catch { return null; }
  };

  function writeFile(path, content) {
    try {
      fs.mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(temp, content, { mode: 0o644 });
      fs.renameSync(temp, path);
    } catch (error) {
      throw failure('write-failed', `${path}: ${error.code || error.message}`);
    }
  }
  function removeFile(path) {
    try { fs.rmSync(path, { force: true }); } catch (error) { throw failure('write-failed', `${path}: ${error.code || error.message}`); }
  }

  // The file names are the app's own: whatever is in them is this app's entry, as the user or the system left it.
  function readLinux() {
    let text = null;
    try { text = fs.readFileSync(autostartFile, 'utf8'); } catch { return { enabled: false, status: 'off', stale: false }; }
    if (desktopEntryDisabled(parseDesktopEntry(text))) return { enabled: false, status: 'disabled', stale: false };
    return { enabled: true, status: 'on', stale: text !== linuxAutostartEntry(target, carry) };
  }

  function macDisabled() {
    if (uid == null) return false;
    try {
      const out = run('/bin/launchctl', ['print-disabled', `gui/${uid}`]);
      return new RegExp(`"${MAC_LOGIN_LABEL.replace(/\./g, '\\.')}"\\s*=>\\s*(?:true|disabled)`).test(String(out));
    } catch { return false; }
  }

  function readMac() {
    const agent = macAgent();
    let text = null;
    try { text = fs.readFileSync(agent.path, 'utf8'); } catch { return { enabled: false, status: 'off', stale: false }; }
    // Login Items > Allow in the Background, switched off: launchd lists the job as disabled.
    if (macDisabled()) return { enabled: false, status: 'disabled', stale: false };
    return { enabled: true, status: 'on', stale: text !== agent.content };
  }

  function readWindows() {
    let settings = {};
    try { settings = app.getLoginItemSettings(winOptions) || {}; } catch {}
    // Electron says whether its value starts this executable with these arguments; whether a value of that name is
    // there at all (this copy's, from where it was before: moved, reinstalled, other pins) only needs it to exist.
    const current = settings.openAtLogin === true;
    const exists = current || regValue(WIN_RUN_KEY, WIN_RUN_NAME) != null;
    if (!exists) return { enabled: false, status: 'off', stale: false };
    // Startup apps' switch (an odd first byte is off). Electron's own executableWillLaunchAtLogin is not that.
    if (startupApproved(regValue(WIN_APPROVED_KEY, WIN_RUN_NAME)) === false) return { enabled: false, status: 'disabled', stale: false };
    return { enabled: true, status: 'on', stale: !current };
  }

  const readState = () => (platform === 'linux' ? readLinux() : platform === 'darwin' ? readMac() : readWindows());

  function read() {
    const state = readState();
    return { enabled: state.enabled, status: state.status };
  }

  /** Put this copy's entry in place. `enable`: the user asked, so a switch the system holds for it is turned on too. */
  function write({ enable = false } = {}) {
    if (platform === 'linux') return writeFile(autostartFile, linuxAutostartEntry(target, carry));
    if (platform === 'darwin') {
      const agent = macAgent();
      writeFile(agent.path, agent.content);
      // Not loaded now: it runs at the next login (now it would only bring SynaBun forward).
      if (enable && uid != null) { try { run('/bin/launchctl', ['enable', `gui/${uid}/${MAC_LOGIN_LABEL}`]); } catch {} }
      return undefined;
    }
    // `enabled` also sets Startup apps' switch.
    app.setLoginItemSettings({ ...winOptions, openAtLogin: true, enabled: true });
    return undefined;
  }

  async function set(enabled) {
    const on = enabled === true;
    if (on) write({ enable: true });
    else if (platform === 'linux') removeFile(autostartFile);
    else if (platform === 'darwin') {
      if (uid != null) { try { run('/bin/launchctl', ['bootout', `gui/${uid}/${MAC_LOGIN_LABEL}`]); } catch {} }
      removeFile(macAgent().path);
    } else app.setLoginItemSettings({ ...winOptions, openAtLogin: false });
    const after = read();
    log(`login item ${on ? 'on' : 'off'}: the system says ${after.status}`);
    if (on && !after.enabled) throw failure('refused', after.status);
    if (!on && after.enabled) throw failure('refused', after.status);
    return after;
  }

  async function heal() {
    const state = readState();
    if (!state.enabled) return { status: state.status, keep: false, changed: false };
    if (!state.stale) return { status: 'on', keep: true, changed: false };
    write();
    log(`login item: put back in place for ${target}`);
    return { status: read().status, keep: true, changed: true };
  }

  return { target, read, set, heal, autostartFile, agentFile: platform === 'darwin' ? posix.join(home, 'Library', 'LaunchAgents', `${MAC_LOGIN_LABEL}.plist`) : null };
}

// ── A start at login ──

/** Was this start the login entry's? Windows: the flag. macOS and Linux: the environment the entry sets. */
export function openedAtLogin({ platform = process.platform, argv = process.argv, env = process.env } = {}) {
  if (platform === 'win32') return argv.includes(LOGIN_FLAG);
  if (platform === 'darwin' || platform === 'linux') return env[LOGIN_ENV] === '1';
  return false;
}

// ── The npm install's login entry (one per data folder) ──

const samePath = (a, b, platform) => {
  if (!a || !b) return false;
  const norm = (p) => (platform === 'win32' ? win32.resolve(p) : resolve(p)).replace(/[\\/]+$/, '');
  return platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
};

/** The data folder an npm login entry's words name: --data-home, else the platform's own. */
function dataHomeOfWords(words, { platform, home, env }) {
  const at = words.indexOf('--data-home');
  if (at >= 0 && words[at + 1]) return words[at + 1];
  if (platform === 'win32') return env.APPDATA ? win32.resolve(env.APPDATA, 'synabun') : null;
  return posix.join(home, '.synabun');
}

/** The strings of a plist's ProgramArguments array. */
export function plistProgramArguments(text) {
  const block = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(String(text || ''));
  if (!block) return [];
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => unxml(m[1]));
}

/**
 * The npm install's login entry when it starts a server on `dataHome`, or null:
 * { kind: 'launch-agent' | 'run-value' | 'autostart', where, dataHome }.
 */
export function findNpmLoginEntry({ platform = process.platform, home = homedir(), env = process.env, dataHome, fs = DEFAULT_FS, run = defaultRun } = {}) {
  try {
    if (platform === 'darwin') {
      const where = posix.join(home, 'Library', 'LaunchAgents', `${NPM_LOGIN.macLabel}.plist`);
      if (!fs.existsSync(where)) return null;
      const words = plistProgramArguments(fs.readFileSync(where, 'utf8'));
      const theirs = dataHomeOfWords(words, { platform, home, env });
      return samePath(theirs, dataHome, platform) ? { kind: 'launch-agent', where, dataHome: theirs } : null;
    }
    if (platform === 'win32') {
      const value = readRunValue(NPM_LOGIN.winName, { run, fs, env });
      if (value == null) return null;
      const theirs = dataHomeOfWords(splitWindowsCommand(value), { platform, home, env });
      return samePath(theirs, dataHome, platform) ? { kind: 'run-value', where: `${WIN_RUN_KEY}\\${NPM_LOGIN.winName}`, dataHome: theirs } : null;
    }
    const where = posix.join(autostartDir({ env, home }), NPM_LOGIN.linuxFile);
    if (!fs.existsSync(where)) return null;
    const words = splitDesktopExec(parseDesktopEntry(fs.readFileSync(where, 'utf8')).Exec);
    const theirs = dataHomeOfWords(words, { platform, home, env });
    return samePath(theirs, dataHome, platform) ? { kind: 'autostart', where, dataHome: theirs } : null;
  } catch {
    return null;
  }
}

/** Remove the npm install's login entry this app replaces. Throws when it stays. */
export function removeNpmLoginEntry(entry, { platform = process.platform, env = process.env, fs = DEFAULT_FS, run = defaultRun, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  if (!entry) return false;
  if (entry.kind === 'run-value') {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
    run(root ? win32.join(root, 'System32', 'reg.exe') : 'reg', ['delete', WIN_RUN_KEY, '/v', NPM_LOGIN.winName, '/f']);
    return true;
  }
  if (entry.kind === 'launch-agent' && platform === 'darwin' && uid != null) {
    // Loaded since the last login: unload it too (it is not running; it only ran once at login).
    try { run('/bin/launchctl', ['bootout', `gui/${uid}/${NPM_LOGIN.macLabel}`]); } catch {}
  }
  fs.rmSync(entry.where, { force: true });
  return true;
}
