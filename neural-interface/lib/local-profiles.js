/**
 * Local browser profiles: profiles SynaBun creates and runs itself on this computer.
 *
 * A local profile is a Chrome that SynaBun starts with a data folder of its own (`--user-data-dir`). It stands next to
 * the MoreLogin profiles and is used through the same rails (lib/browser-profiles.js routes by id): the default AI
 * browser, the owner's list of profiles agents may choose, a run's or a session's own profile, the pickers, the
 * `morelogin` tool's list / use / start / stop. Starting one answers a DevTools port, as MoreLogin's start does.
 *
 * What it is NOT: it is not a MoreLogin profile. Nothing here reads or writes MoreLogin's app data, its browser, its
 * account or its API, and the MoreLogin app does not list these profiles. It does no fingerprint spoofing either (no
 * canvas, WebGL or user-agent faking): the browser is the Chrome installed on this computer, unmodified. What a
 * profile keeps to itself is its storage (cookies, logins, cache, extensions), its proxy, its language, its timezone,
 * its window size, and WebRTC kept on the proxy.
 *
 * Store: `<root>/profiles.json` (mode 0600; a proxy password is kept there as typed) and one folder per profile,
 * `<root>/<id>/`, which is its `--user-data-dir`. `root` is DATA_HOME/data/local-profiles in the server.
 *
 * Everything that starts or stops a process works on `<root>/<id>` only (assertLocalProfileRoot): a process is stopped
 * only when its command line holds that exact `--user-data-dir`.
 *
 * Built-ins only. ESM, Node >= 22.
 */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { withOnDeviceModelBlocked } from './chromium-on-device-model.js';
import { PROXY_TYPES, checkProxy, createProxyRelay, directProxyServer, proxyNeedsRelay } from './local-profile-proxy.js';

export const LOCAL_PROFILE_ID_RE = /^lp-[0-9a-f]{12}$/;
export const LOCAL_PROFILES_MAX = 200;
export const DEFAULT_WINDOW = Object.freeze({ width: 1280, height: 800 });
const RELAY_FILE = 'synabun-relay.json';
const LAUNCH_FILE = 'synabun-launch.json';
const STOP_GRACE_MS = 5000;
/**
 * The loopback ports SynaBun keeps for its local profiles: every proxy relay and every DevTools port of a profile it
 * starts is inside this range and nowhere else, so a guarded worker's sandbox denies the range as a whole (server.js
 * workerBrowserControlPorts) and a port opened after the worker started is covered too. 400 ports: a relay and a
 * DevTools port for each of the 200 profiles. Below every system's range of ports handed out by themselves (Linux
 * from 32768, macOS and Windows from 49152), and clear of what SynaBun uses elsewhere (3344 / 3345, 13344, 4096-4400,
 * 9222, MoreLogin's 40000 and 15523).
 */
export const LOCAL_PROFILE_PORT_RANGE = Object.freeze({ from: 26200, to: 26599 });
/** Whether a port is one of the ports kept for local profiles. */
export function isLocalProfilePort(port, range = LOCAL_PROFILE_PORT_RANGE) {
  const p = Number(port);
  return Number.isInteger(p) && p >= range.from && p <= range.to;
}

/** Whether an id is a local profile's (by its shape alone: `lp-` and 12 hex characters). */
export function isLocalProfileId(id) {
  return typeof id === 'string' && LOCAL_PROFILE_ID_RE.test(id);
}

function refusal(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

const clean = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

/** An IANA timezone name as Intl spells it, or null when Intl does not know it. */
export function canonicalTimezone(value) {
  const name = clean(value, 80);
  if (!name) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone || null; } catch { return null; }
}

/** A language tag as Intl spells it (pt-br → pt-BR), or null when it is not one. */
export function canonicalLanguage(value) {
  const tag = clean(value, 35);
  if (!tag || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag)) return null;
  try { return Intl.getCanonicalLocales(tag)[0] || null; } catch { return null; }
}

/** What Chrome sends as Accept-Language for a profile language: the tag, its base language, then English. */
export function acceptLanguagesFor(language) {
  if (!language) return '';
  const out = [language];
  const base = language.split('-')[0];
  if (base && base !== language) out.push(base);
  for (const extra of ['en-US', 'en']) if (!out.includes(extra)) out.push(extra);
  return out.join(',');
}

function normalizeProxy(input, saved = null) {
  const before = saved || { type: 'none', host: '', port: null, username: '', password: '' };
  if (input === undefined) return { ...before };
  if (input === null) return { type: 'none', host: '', port: null, username: '', password: '' };
  if (typeof input !== 'object') throw refusal(400, 'LOCAL_PROFILE_PROXY', 'proxy must be an object: { type, host, port, username, password }.', { field: 'proxy' });
  const type = input.type === undefined ? before.type : String(input.type || 'none').toLowerCase();
  if (!PROXY_TYPES.includes(type)) throw refusal(400, 'LOCAL_PROFILE_PROXY', `The proxy type is one of: ${PROXY_TYPES.join(', ')}.`, { field: 'proxy.type' });
  if (type === 'none') return { type: 'none', host: '', port: null, username: '', password: '' };
  const host = input.host === undefined ? before.host : clean(input.host, 253);
  if (!host || /[\s/@?#]/.test(host)) throw refusal(400, 'LOCAL_PROFILE_PROXY', 'The proxy host is a host name or an IP address, without a scheme, a path or a login.', { field: 'proxy.host' });
  const port = input.port === undefined ? before.port : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw refusal(400, 'LOCAL_PROFILE_PROXY', 'The proxy port is a number from 1 to 65535.', { field: 'proxy.port' });
  const username = input.username === undefined ? before.username : clean(input.username, 255);
  // The password is kept as typed. Not sent: the saved one stays (it is never returned, so a form cannot send it
  // back), but only for the very proxy and login it was typed for. With another type, host, port or username the
  // saved password is dropped (it would be sent to another server, or as another account) and has to be typed again.
  // A proxy without a username has no password.
  const sameLogin = type === before.type && host === before.host && port === before.port && username === before.username;
  let password = input.password === undefined || input.password === null ? (sameLogin ? before.password : '') : String(input.password).slice(0, 255);
  if (!username) password = '';
  if (/[\u0000-\u001f]/.test(password)) throw refusal(400, 'LOCAL_PROFILE_PROXY', 'The proxy password holds a control character.', { field: 'proxy.password' });
  return { type, host, port, username, password };
}

function normalizeWindow(input, saved = null) {
  const before = saved || { ...DEFAULT_WINDOW };
  if (input === undefined || input === null) return { ...before };
  const width = input.width === undefined ? before.width : Number(input.width);
  const height = input.height === undefined ? before.height : Number(input.height);
  if (!Number.isInteger(width) || width < 400 || width > 7680 || !Number.isInteger(height) || height < 300 || height > 4320) {
    throw refusal(400, 'LOCAL_PROFILE_WINDOW', 'The window size is a width from 400 to 7680 and a height from 300 to 4320, in pixels.', { field: 'window' });
  }
  return { width, height };
}

/** A stored profile from a request body, over the saved one for an update. Throws 400 with `field`. */
export function normalizeLocalProfile(input, saved = null) {
  const body = input && typeof input === 'object' ? input : {};
  const name = body.name === undefined ? (saved?.name || '') : clean(body.name, 80);
  if (!name) throw refusal(400, 'LOCAL_PROFILE_NAME', 'A local profile needs a name (at most 80 characters).', { field: 'name' });
  let language = saved?.language || '';
  if (body.language !== undefined) {
    language = clean(body.language, 35) ? canonicalLanguage(body.language) : '';
    if (language === null) throw refusal(400, 'LOCAL_PROFILE_LANGUAGE', 'The language is a tag such as pt-BR or en-US (or empty for Chrome\'s own).', { field: 'language' });
  }
  let timezone = saved?.timezone || '';
  if (body.timezone !== undefined) {
    timezone = clean(body.timezone, 80) ? canonicalTimezone(body.timezone) : '';
    if (timezone === null) throw refusal(400, 'LOCAL_PROFILE_TIMEZONE', 'The timezone is an IANA name such as America/Sao_Paulo (or empty for this computer\'s).', { field: 'timezone' });
  }
  return {
    name,
    proxy: normalizeProxy(body.proxy, saved?.proxy || null),
    language,
    timezone,
    window: normalizeWindow(body.window, saved?.window || null),
    notes: body.notes === undefined ? (saved?.notes || '') : String(body.notes ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 2000),
  };
}

/** How many leading fields of a launch signature are the proxy's. */
const SIGNATURE_PROXY_FIELDS = 6;
/** The proxy part of a launch signature (as launchSignature wrote it), or null when it cannot be read. */
function proxyPartOf(signature) {
  try {
    const fields = JSON.parse(signature);
    return Array.isArray(fields) && fields.length >= SIGNATURE_PROXY_FIELDS ? JSON.stringify(fields.slice(0, SIGNATURE_PROXY_FIELDS)) : null;
  } catch { return null; }
}

/**
 * Chrome's `--host-resolver-rules` for a profile with a proxy: no name is resolved on this computer (a name Chrome
 * would look up by itself, as its prefetcher or a component does, gets "not found"), except the proxy's own host,
 * which Chrome has to find, and this computer's loopback names (the relay, a local dev server). Names of pages are
 * resolved by the proxy.
 */
export function hostResolverRules(proxyHost) {
  const excluded = [];
  const add = (host) => { const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase(); if (h && !/[\s,"']/.test(h) && !excluded.includes(h)) excluded.push(h); };
  add(proxyHost);
  add('127.0.0.1');
  add('localhost');
  add('*.localhost');
  return ['MAP * ~NOTFOUND', ...excluded.map((host) => `EXCLUDE ${host}`)].join(' , ');
}

/** What a start depends on, as one string: a running profile whose launch record differs needs a restart. */
function launchSignature(profile) {
  const { proxy, language, timezone, window } = profile;
  return JSON.stringify([proxy.type, proxy.host, proxy.port, proxy.username, proxy.password ? 1 : 0, proxy.password ? simpleHash(proxy.password) : 0, language, timezone, window.width, window.height]);
}
function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * The Chrome arguments and environment of one start. `relayPort`: the profile's relay, when its proxy has a login.
 * `debugPort`: the DevTools port Chrome is told to listen on. A start names a free one (startLocalProfile): with
 * `--remote-debugging-port=0` Chrome marks every page as automated (`navigator.webdriver`), which a Chrome started
 * with a port of its own, as attach mode's is, does not. 0 (Chrome picks) is the default for callers that name none.
 */
export function localProfileLaunch(profile, userDataDir, { relayPort = null, debugPort = 0, env = process.env } = {}) {
  const proxyServer = proxyNeedsRelay(profile.proxy)
    ? (relayPort ? `http://127.0.0.1:${relayPort}` : null)
    : directProxyServer(profile.proxy);
  if (proxyNeedsRelay(profile.proxy) && !proxyServer) throw refusal(500, 'LOCAL_PROFILE_RELAY', 'The profile\'s proxy has a login and its relay is not running: nothing was started (never without the proxy).');
  const args = withOnDeviceModelBlocked([
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${profile.window.width},${profile.window.height}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ]);
  args.push(`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536 ? debugPort : 0}`);
  if (profile.language) args.push(`--lang=${profile.language}`, `--accept-lang=${acceptLanguagesFor(profile.language)}`);
  if (proxyServer) {
    // Chrome keeps localhost off the proxy by itself, so a local dev server still opens. WebRTC is kept on the proxy:
    // without this its UDP goes out directly and shows the computer's own address.
    args.push(`--proxy-server=${proxyServer}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    // Names are resolved by the proxy, never here: without this rule a part of Chrome that looks a name up by itself
    // (the prefetcher, a component) asks this computer's DNS, which shows where the profile really is. A Chrome
    // argument is passed as it is (no shell), so the rule's spaces need no quotes.
    args.push(`--host-resolver-rules=${hostResolverRules(proxyNeedsRelay(profile.proxy) ? '127.0.0.1' : profile.proxy.host)}`);
  }
  const launchEnv = { ...env };
  if (profile.timezone) launchEnv.TZ = profile.timezone; else delete launchEnv.TZ;
  return { args, env: launchEnv, proxyServer };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJsonAtomic(file, data, mode = 0o600) {
  const temp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  renameSync(temp, file);
  try { chmodSync(file, mode); } catch { /* a file system without modes */ }
}

/** Chrome's own files in the profile folder, set before a start (never while it runs). */
export function seedLocalProfileFiles(profile, userDataDir) {
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });
  const prefsFile = join(userDataDir, 'Default', 'Preferences');
  const prefs = (existsSync(prefsFile) && readJson(prefsFile)) || {};
  prefs.profile = { ...(prefs.profile || {}), exit_type: 'Normal', exited_cleanly: true, name: profile.name };
  if (profile.language) prefs.intl = { ...(prefs.intl || {}), accept_languages: acceptLanguagesFor(profile.language), selected_languages: acceptLanguagesFor(profile.language) };
  if (profile.proxy.type !== 'none') prefs.webrtc = { ...(prefs.webrtc || {}), ip_handling_policy: 'disable_non_proxied_udp' };
  else if (prefs.webrtc) delete prefs.webrtc.ip_handling_policy;
  writeFileSync(prefsFile, JSON.stringify(prefs));
  const stateFile = join(userDataDir, 'Local State');
  const state = (existsSync(stateFile) && readJson(stateFile)) || {};
  state.profile = { ...(state.profile || {}) };
  state.profile.info_cache = { ...(state.profile.info_cache || {}) };
  state.profile.info_cache.Default = { ...(state.profile.info_cache.Default || {}), name: profile.name, is_using_default_name: false };
  writeFileSync(stateFile, JSON.stringify(state));
}

/**
 * The pids of the processes whose command line holds `--user-data-dir=<dir>` exactly. `mainOnly`: the browser
 * process alone (the one that is not a helper: no `--type=`), which is the one to ask for a clean end.
 */
function defaultFindProcesses(userDataDir, { mainOnly = false } = {}) {
  const needle = `--user-data-dir=${userDataDir}`;
  if (process.platform === 'win32') {
    const script = '$root = $env:SYNABUN_LOCAL_PROFILE_ROOT; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains("--user-data-dir=$root") } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }';
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      input: script, encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, SYNABUN_LOCAL_PROFILE_ROOT: userDataDir },
    });
    return parseProcessList(out, needle, { mainOnly });
  }
  const ps = ['/bin/ps', '/usr/bin/ps'].find((p) => existsSync(p)) || 'ps';
  const out = execFileSync(ps, ['-Aww', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
  return parseProcessList(out, needle, { mainOnly });
}

/**
 * `pid args` lines → the pids whose arguments hold `needle` as a whole argument (never a longer folder name).
 * `mainOnly`: without Chrome's helpers (renderer, GPU, network service: their command line names a `--type=`).
 */
export function parseProcessList(text, needle, { mainOnly = false } = {}) {
  const pids = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[2];
    let at = args.indexOf(needle);
    let hit = false;
    while (at !== -1 && !hit) {
      const next = args[at + needle.length];
      hit = next === undefined || /[\s"']/.test(next);
      at = args.indexOf(needle, at + 1);
    }
    const pid = Number(m[1]);
    if (hit && mainOnly && /(?:^|\s)--type=/.test(args)) continue;
    if (hit && pid > 0 && pid !== process.pid) pids.push(pid);
  }
  return pids;
}

/**
 * Asks a process to end by itself; the kill comes after the grace period. Sent to Chrome's browser process alone,
 * which then ends its helpers itself. This is the last resort before the kill, for a Chrome that takes no
 * Browser.close: Chrome treats the signal as the end of the session (settings and session saved), and does not
 * wait for the cookie store's next write (checked live: a cookie set seconds before is lost; Browser.close keeps it).
 */
function defaultTerminateProcess(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', timeout: 5000, windowsHide: true }); } catch { /* gone, or it takes no such request */ }
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
}

function defaultKillProcess(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000, windowsHide: true }); } catch { /* gone */ }
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

async function defaultProbe(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } return null; }
    const body = await res.json();
    return body && typeof body === 'object' && (body.webSocketDebuggerUrl || body.Browser) ? body : null;
  } catch { return null; }
}

/** Ask a browser to close itself over its DevTools socket (`Browser.close`), so it writes its cookies first. */
async function defaultCloseBrowser(wsUrl, timeoutMs = 3000) {
  if (!wsUrl || typeof WebSocket !== 'function') return false;
  return new Promise((done) => {
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); try { socket.close(); } catch { /* gone */ } done(value); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    let socket;
    try { socket = new WebSocket(wsUrl); } catch { clearTimeout(timer); return done(false); }
    socket.addEventListener('open', () => { try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch { finish(false); } });
    socket.addEventListener('message', () => finish(true));
    socket.addEventListener('close', () => finish(true));
    socket.addEventListener('error', () => finish(false));
  });
}

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Whether nothing listens on a loopback port right now (it is taken and released). */
function defaultPortFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.unref();
    server.once('error', () => done(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => done(true)));
  });
}

/** The ports of a range, each once, from a random one on (so two starts seldom try the same port first). */
export function portsOfRange(range = LOCAL_PROFILE_PORT_RANGE, random = Math.random) {
  const size = range.to - range.from + 1;
  const first = Math.floor(random() * size) % size;
  return Array.from({ length: size }, (_, i) => range.from + ((first + i) % size));
}

/**
 * The local profiles of one data home.
 * @param {object} o
 * @param {string} o.root                 the folder that holds profiles.json and one folder per profile
 * @param {(o: { chromeBin, chromeArgs, userDataDir, timeoutMs, allowPreferredPortProbe, env }) => Promise<{ httpEndpoint }>} o.launchChrome
 *        starts Chrome detached and waits for its DevTools endpoint (server.js _launchChromeAndWaitForCdp)
 * @param {() => string|null} o.resolveChromeBin  the Chrome to start (attach mode's resolution)
 * Everything else is for tests: findProcesses, killProcess, probe, closeBrowser, relayFactory, checkProxy, log, now.
 */
export function createLocalProfiles({
  root,
  launchChrome = null,
  resolveChromeBin = () => null,
  findProcesses = defaultFindProcesses,
  killProcess = defaultKillProcess,
  probe = defaultProbe,
  closeBrowser = defaultCloseBrowser,
  terminateProcess = undefined,
  findBrowserProcesses = undefined,
  portFree = defaultPortFree,
  portRange = LOCAL_PROFILE_PORT_RANGE,
  random = Math.random,
  probeRetries = 4,
  probeRetryMs = 750,
  exitWaitMs = 3000,
  relayFactory = createProxyRelay,
  checkProxyImpl = checkProxy,
  log = () => {},
  now = Date.now,
  launchTimeoutMs = 30000,
  stopGraceMs = STOP_GRACE_MS,
} = {}) {
  if (!root || typeof root !== 'string') throw new Error('createLocalProfiles needs its root folder');
  if (!portRange || !Number.isInteger(portRange.from) || !Number.isInteger(portRange.to) || portRange.from < 1 || portRange.to > 65535 || portRange.to < portRange.from) {
    throw new Error('createLocalProfiles needs a port range { from, to }');
  }
  // A graceful end is asked of real processes only: a caller that brings its own kill (a test) and no terminate of
  // its own never has a signal sent to a pid by this module.
  const terminate = terminateProcess !== undefined ? terminateProcess : (killProcess === defaultKillProcess ? defaultTerminateProcess : null);
  // Whom to ask: the browser process alone where the list can tell it from its helpers (the real one can).
  const findMain = findBrowserProcesses !== undefined ? findBrowserProcesses
    : (findProcesses === defaultFindProcesses ? (dir) => defaultFindProcesses(dir, { mainOnly: true }) : findProcesses);
  const inRange = (port) => isLocalProfilePort(port, portRange);
  /** DevTools ports this instance handed to a start that is still coming up (id → port). */
  const pendingPorts = new Map();
  const rootDir = resolve(root);
  const storeFile = join(rootDir, 'profiles.json');
  /** id → the relay that listens for it. */
  const relays = new Map();
  /** id → the start or stop under way (one at a time per profile). */
  const busy = new Map();

  // ── Store ──
  function readAll() {
    if (!existsSync(storeFile)) return [];
    const data = readJson(storeFile);
    if (data === null) throw refusal(500, 'LOCAL_PROFILES_UNREADABLE', `${storeFile} cannot be read as JSON; nothing was changed. Fix or remove the file.`);
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.profiles) ? data.profiles : []);
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || !isLocalProfileId(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      try {
        out.push({ id: row.id, createdAt: Number(row.createdAt) || 0, ...normalizeLocalProfile(row) });
      } catch { /* a row that no longer passes the checks is left out, never rewritten by a read */ }
    }
    return out;
  }
  function writeAll(rows) {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    try { chmodSync(rootDir, 0o700); } catch { /* a file system without modes */ }
    writeJsonAtomic(storeFile, rows.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, proxy: p.proxy, language: p.language, timezone: p.timezone, window: p.window, notes: p.notes })));
  }
  /** The stored profile, or a 404. */
  function stored(id) {
    const found = isLocalProfileId(id) ? readAll().find((p) => p.id === id) : null;
    if (!found) throw refusal(404, 'LOCAL_PROFILE_NOT_FOUND', `There is no local profile with id ${String(id).slice(0, 64)}.`);
    return found;
  }

  // ── Folder guard ──
  /**
   * The folder of a local profile, or a throw: `dir` must be exactly `<root>/<id>` for a local profile id, and not a
   * link. Called before anything is started in, stopped on or removed from a folder.
   */
  function assertLocalProfileRoot(dir) {
    const abs = resolve(String(dir || ''));
    const id = abs.slice(rootDir.length + 1);
    if (!abs.startsWith(rootDir + sep) || !isLocalProfileId(id) || abs !== join(rootDir, id)) {
      throw refusal(500, 'LOCAL_PROFILE_ROOT', `Refusing to work on a folder that is not a local profile's: ${dir}`);
    }
    let info = null;
    try { info = lstatSync(abs); } catch { /* not there yet */ }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw refusal(500, 'LOCAL_PROFILE_ROOT', `Refusing to work on ${dir}: it is not a plain folder`);
    if (info) {
      let real = abs;
      let realRoot = rootDir;
      try { real = realpathSync(abs); realRoot = realpathSync(rootDir); } catch { /* compared as written */ }
      if (real !== join(realRoot, id)) throw refusal(500, 'LOCAL_PROFILE_ROOT', `Refusing to work on ${dir}: it resolves outside the local profiles folder`);
    }
    return abs;
  }
  const folderOf = (id) => assertLocalProfileRoot(join(rootDir, id));

  // ── What runs ──
  /**
   * The live DevTools endpoint of a profile folder: { port, wsUrl } or null. Where it is read from: the record of
   * SynaBun's own start (LAUNCH_FILE: the port, and the browser's id as /json/version said it then), else Chrome's
   * DevToolsActivePort (which Chrome writes only when it picked the port itself). The port must answer as that very
   * browser (its id), so a port another program took since is never adopted as this profile.
   */
  async function liveEndpoint(dir) {
    const candidates = [];
    const launched = readJson(join(dir, LAUNCH_FILE));
    // Our own record counts only with the browser's id: a port alone proves nothing after a restart.
    if (launched && typeof launched.browser === 'string' && launched.browser) candidates.push({ port: Number(launched.debugPort), browser: launched.browser });
    try {
      const lines = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      candidates.push({ port: Number.parseInt(lines[0], 10), browser: lines[1] || null });
    } catch { /* no such file */ }
    for (const { port, browser } of candidates) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const version = await probe(port);
      if (!version) continue;
      const wsUrl = typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : null;
      if (browser && (!wsUrl || !wsUrl.endsWith(browser))) continue;
      return { port, wsUrl };
    }
    return null;
  }
  /**
   * The pids that run on a profile folder. Throws LOCAL_PROFILE_BUSY when the processes could not be listed (ps timed
   * out, PowerShell failed): "could not look" is never "none", so nothing is cleared, started or removed on a folder
   * a Chrome may still be using.
   */
  function processesOf(dir) {
    const folder = assertLocalProfileRoot(dir);
    let pids;
    try { pids = findProcesses(folder); } catch (err) { pids = err instanceof Error ? err : new Error(String(err)); }
    if (!Array.isArray(pids)) {
      const why = pids instanceof Error ? pids.message : 'the process list gave no answer';
      log(`processes of ${dir} could not be listed: ${why}`);
      throw refusal(500, 'LOCAL_PROFILE_BUSY', `SynaBun could not check whether a browser is still running on this local profile's folder (${String(why).slice(0, 200)}). Nothing was started, stopped or deleted: try again.`);
    }
    return pids;
  }
  /** Kills what runs on the folder and waits for it to be gone. → true when nothing runs there any more. */
  async function killAndWait(dir) {
    let pids = processesOf(dir);
    if (!pids.length) return true;
    for (const pid of pids) killProcess(pid);
    const deadline = now() + exitWaitMs;
    for (;;) {
      pids = processesOf(dir);
      if (!pids.length) return true;
      if (now() >= deadline) return false;
      await sleep(Math.min(100, Math.max(1, exitWaitMs)));
    }
  }
  function clearRunFiles(dir) {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name === 'DevToolsActivePort' || name === LAUNCH_FILE || name.startsWith('Singleton')) {
        try { unlinkSync(join(dir, name)); } catch { /* gone */ }
      }
    }
  }

  // ── Relay ──
  const relayFile = (dir) => join(dir, RELAY_FILE);
  async function stopRelay(id, { forget = false } = {}) {
    const relay = relays.get(id);
    relays.delete(id);
    if (relay) { try { await relay.close(); } catch { /* closed */ } }
    if (forget) { try { unlinkSync(relayFile(join(rootDir, id))); } catch { /* none */ } }
  }
  /** The ports of the range other profiles of this instance hold or are being started on. */
  function portsInUse() {
    const used = new Set([...pendingPorts.values()]);
    for (const relay of relays.values()) if (relay.port) used.add(relay.port);
    return used;
  }
  /** A free DevTools port inside the range for a start of `id`. Throws when the whole range is taken. */
  async function pickDebugPort(id, skip = new Set()) {
    const used = portsInUse();
    for (const port of portsOfRange(portRange, random)) {
      if (used.has(port) || skip.has(port)) continue;
      if (await portFree(port)) { pendingPorts.set(id, port); return port; }
    }
    throw refusal(500, 'LOCAL_PROFILE_PORTS', `No free port is left in the ports SynaBun keeps for local profiles (${portRange.from}-${portRange.to}): stop a local profile, or close what else listens there.`);
  }
  /**
   * The relay of a profile, listening: on `port` (its saved one, which must be inside the range) or, for 0, on a free
   * port of the range (the next one is tried when a port is taken). → the port. Throws when it cannot.
   */
  async function openRelay(profile, dir, port = 0) {
    await stopRelay(profile.id);
    if (port && !inRange(port)) throw Object.assign(new Error(`port ${port} is outside the ports kept for local profiles (${portRange.from}-${portRange.to})`), { code: 'LOCAL_PROFILE_PORT_RANGE' });
    const relay = relayFactory({ upstream: { ...profile.proxy }, log: (line) => log(`${profile.id} ${line}`) });
    let listening = null;
    if (port) listening = await relay.listen(port);
    else {
      const used = portsInUse();
      let failure = null;
      for (const candidate of portsOfRange(portRange, random)) {
        if (used.has(candidate)) continue;
        try { listening = await relay.listen(candidate); break; } catch (err) {
          failure = err;
          if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') throw err;
        }
      }
      if (!listening) throw refusal(500, 'LOCAL_PROFILE_PORTS', `No free port is left in the ports SynaBun keeps for local profiles (${portRange.from}-${portRange.to}) for the proxy relay${failure?.code ? ` (${failure.code})` : ''}.`);
    }
    if (!inRange(listening)) {
      try { await relay.close(); } catch { /* closed */ }
      throw refusal(500, 'LOCAL_PROFILE_PORTS', `The proxy relay opened on port ${listening}, outside the ports kept for local profiles (${portRange.from}-${portRange.to}); it was closed.`);
    }
    relays.set(profile.id, relay);
    writeJsonAtomic(relayFile(dir), { port: listening, at: now() });
    return listening;
  }
  const savedRelayPort = (dir) => {
    const port = Number(readJson(relayFile(dir))?.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  };

  /**
   * Why a running profile has to be started again before it is used, or null:
   *   'proxy'    — it runs with another proxy than the saved one (or what it was started with is not known), so its
   *                traffic would not leave where the owner now says;
   *   'relay'    — its proxy has a login and the relay is not listening;
   *   'ports'    — its DevTools port is outside the ports kept for local profiles (a guarded worker could reach it);
   *   'settings' — language, timezone or window size changed (harmless to a run; shown as "restart to apply").
   */
  function restartReason(profile, dir, live = null) {
    const launched = readJson(join(dir, LAUNCH_FILE));
    const signature = typeof launched?.signature === 'string' ? launched.signature : null;
    const wanted = launchSignature(profile);
    if (!signature || proxyPartOf(signature) !== proxyPartOf(wanted)) return 'proxy';
    if (proxyNeedsRelay(profile.proxy) && !relays.get(profile.id)?.port) return 'relay';
    const port = live ? live.port : Number(launched?.debugPort);
    if (Number.isInteger(port) && port > 0 && !inRange(port)) return 'ports';
    if (signature !== wanted) return 'settings';
    return null;
  }
  /** Whether a running profile runs with other settings than the saved ones, or without the relay it needs. */
  function restartNeededFor(profile, dir) {
    return restartReason(profile, dir) !== null;
  }

  /** One start or stop at a time per profile; the second caller of the same kind gets the first one's answer. */
  function serialized(id, kind, work) {
    const current = busy.get(id);
    if (current && current.kind === kind) return current.promise;
    const run = async () => {
      if (current) { try { await current.promise; } catch { /* its own caller was told */ } }
      return work();
    };
    const promise = run().finally(() => { if (busy.get(id)?.promise === promise) busy.delete(id); });
    busy.set(id, { kind, promise });
    return promise;
  }

  const RESTART_WHY = {
    proxy: 'its proxy settings changed since it was started (or what it was started with is not known), so it would not go out through the proxy that is saved now',
    relay: 'the relay of its proxy is not running',
    ports: 'it listens on a port outside the ports SynaBun keeps for local profiles',
  };

  /**
   * @param {string} id
   * @param {{ owner?: boolean }} [o] owner: the owner's own Start (Settings). Only the owner's start may end a
   *   running Chrome (to start it again with the saved settings, or because it no longer answers); every other caller
   *   (an automation's start, a browser session opening in the profile) is refused by name and gets no browser.
   */
  async function startNow(id, { owner = false } = {}) {
    const profile = stored(id);
    const dir = folderOf(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let live = await liveEndpoint(dir);
    if (!live) {
      // No answer on its DevTools port. That is "not running" only when no process runs on the folder: a busy Chrome
      // can miss one probe, so it is asked again a few times before anything else is decided.
      let pids = processesOf(dir);
      for (let attempt = 0; attempt < probeRetries && pids.length && !live; attempt += 1) {
        await sleep(probeRetryMs);
        live = await liveEndpoint(dir);
        if (!live) pids = processesOf(dir);
      }
      if (!live && pids.length) {
        if (!owner) {
          throw refusal(409, 'LOCAL_PROFILE_BUSY', `Local profile "${profile.name}" (${id}) has a browser running that does not answer on its DevTools port. Nothing was started or stopped, and no other profile or browser was used in its place. The owner can stop and start it in SynaBun → Settings → Connected tools → MoreLogin.`);
        }
        log(`${id} "${profile.name}": a browser runs on its folder without answering; the owner's start stops it first`);
        await stopNow(id);
      }
    }
    if (live) {
      // Already running (it outlives a SynaBun restart, as a MoreLogin profile does): adopted as it is, unless it has
      // to be started again first (restartReason). A relay that is only missing is put back on its saved port.
      let reason = restartReason(profile, dir, live);
      if (reason === 'relay') {
        const port = savedRelayPort(dir);
        try { if (!port) throw new Error('no saved port'); await openRelay(profile, dir, port); reason = restartReason(profile, dir, live); }
        catch (err) { log(`${id}: its relay could not be reopened (${err?.code || err?.message || err})`); }
      }
      if (!reason || (reason === 'settings' && !owner)) return { debugPort: live.port, kernel: 'chromium', webdriver: null, reused: true };
      if (!owner) {
        throw refusal(409, 'LOCAL_PROFILE_RESTART_NEEDED', `Local profile "${profile.name}" (${id}) is running, but ${RESTART_WHY[reason]}. It was not handed out, and no other profile or browser was used in its place. The owner restarts it in SynaBun → Settings → Connected tools → MoreLogin (Stop, then Start); starting it again closes the tabs open in it.`, { reason });
      }
      log(`${id} "${profile.name}": started again by the owner (${reason})`);
      await stopNow(id);
    }
    if (typeof launchChrome !== 'function') throw refusal(500, 'LOCAL_PROFILE_LAUNCHER', 'Local profiles cannot be started here: no launcher was given.');
    const chromeBin = resolveChromeBin();
    if (!chromeBin || !existsSync(chromeBin)) {
      throw refusal(500, 'LOCAL_PROFILE_NO_CHROME', 'No Chrome, Edge or Chromium was found to start the local profile with. Install Google Chrome, or set the browser path in Settings → Browser.');
    }
    // SynaBun's own profiles run on the Chrome of this computer, never on MoreLogin's browser.
    if (/morelogin/i.test(chromeBin)) throw refusal(500, 'LOCAL_PROFILE_NO_CHROME', `The browser path in Settings → Browser points into MoreLogin (${chromeBin}). A local profile runs on Chrome, Edge or Chromium: choose one of those.`);
    // Nothing runs on the folder by now (it was never running, or stopNow saw it gone). Asked once more, and never
    // assumed: Chrome's lock files are cleared and its preferences written only on a folder no process uses.
    if (processesOf(dir).length) throw refusal(409, 'LOCAL_PROFILE_BUSY', `Local profile "${profile.name}" (${id}) still has a browser running on its folder; nothing was started.`);
    clearRunFiles(dir);
    seedLocalProfileFiles(profile, dir);
    let relayPort = null;
    if (proxyNeedsRelay(profile.proxy)) relayPort = await openRelay(profile, dir, 0);
    else await stopRelay(id, { forget: true });
    // A DevTools port of the profile's own, free right now, inside the ports kept for local profiles. Should another
    // program take it before Chrome does, the start fails and is tried again on another port of the range.
    let ready = null;
    let failure = null;
    const tried = new Set();
    try {
    for (let attempt = 0; attempt < 3 && !ready; attempt += 1) {
      let debugPort;
      try { debugPort = await pickDebugPort(id, tried); } catch (err) { failure = err; break; }
      tried.add(debugPort);
      const { args, env } = localProfileLaunch(profile, dir, { relayPort, debugPort });
      try {
        ready = await launchChrome({ chromeBin, chromeArgs: args, userDataDir: dir, timeoutMs: launchTimeoutMs, allowPreferredPortProbe: false, env });
      } catch (err) {
        failure = err;
        // What the failed start left behind is ended, and its lock files cleared only once it is gone.
        let gone = false;
        try { gone = await killAndWait(dir); } catch { gone = false; }
        if (!gone) break;
        clearRunFiles(dir);
      }
    }
    } finally { pendingPorts.delete(id); }
    if (!ready) {
      await stopRelay(id);
      if (failure?.code === 'LOCAL_PROFILE_PORTS' || failure?.code === 'LOCAL_PROFILE_BUSY') throw failure;
      throw refusal(500, 'LOCAL_PROFILE_START', `Local profile "${profile.name}" did not start: ${failure?.message || failure}`);
    }
    let port = null;
    try { port = Number(new URL(ready.httpEndpoint).port); } catch { port = null; }
    if (!port) throw refusal(500, 'LOCAL_PROFILE_START', `Local profile "${profile.name}" started but named no DevTools port`);
    if (!inRange(port)) {
      // Never handed out: a DevTools port outside the range is one a guarded worker's sandbox does not deny.
      try { if (await killAndWait(dir)) clearRunFiles(dir); } catch { /* reported below */ }
      await stopRelay(id);
      throw refusal(500, 'LOCAL_PROFILE_START', `Local profile "${profile.name}" came up on DevTools port ${port}, outside the ports SynaBun keeps for local profiles (${portRange.from}-${portRange.to}); it was stopped.`);
    }
    // The start's record: what it was started with (a later change means "restart needed"), its DevTools port and
    // the browser's own id there, by which a later start or a new SynaBun knows this Chrome again.
    let browserId = null;
    try { browserId = new URL((await probe(port))?.webSocketDebuggerUrl || ready.wsEndpoint || '').pathname || null; } catch { browserId = null; }
    writeJsonAtomic(join(dir, LAUNCH_FILE), { signature: launchSignature(profile), at: now(), debugPort: port, browser: browserId });
    log(`${id} "${profile.name}" started on DevTools port ${port}${relayPort ? ` (proxy relay on ${relayPort})` : ''}`);
    return { debugPort: port, kernel: 'chromium', webdriver: null, reused: false };
  }

  async function stopNow(id) {
    const dir = folderOf(id);
    const live = existsSync(dir) ? await liveEndpoint(dir) : null;
    let asked = false;
    if (live?.wsUrl) asked = await closeBrowser(live.wsUrl);
    if (existsSync(dir)) {
      // A Chrome that missed the probe (busy) may still take Browser.close on the socket of its own start record:
      // the address holds the browser's id, so nothing but this very browser answers there. Browser.close is the
      // one way Chrome writes the cookies of the last seconds before it ends.
      if (!asked && processesOf(dir).length) {
        const launched = readJson(join(dir, LAUNCH_FILE));
        const port = Number(launched?.debugPort);
        if (Number.isInteger(port) && port > 0 && port < 65536 && typeof launched?.browser === 'string' && launched.browser.startsWith('/devtools/browser/')) {
          try { asked = await closeBrowser(`ws://127.0.0.1:${port}${launched.browser}`); } catch { asked = false; }
        }
      }
      // One that cannot be asked over DevTools at all is asked to end as a process (it saves its settings and its
      // session; cookies of the last half minute may be lost, as with any Chrome that is ended from outside); what is
      // left after the grace period is killed.
      if (!asked && terminate && processesOf(dir).length) {
        let mains = [];
        try { mains = findMain(assertLocalProfileRoot(dir)); } catch { mains = []; }
        for (const pid of Array.isArray(mains) ? mains : []) terminate(pid);
        asked = Array.isArray(mains) && mains.length > 0;
      }
      const deadline = now() + (asked ? stopGraceMs : 0);
      while (processesOf(dir).length && now() < deadline) await sleep(Math.min(200, Math.max(1, stopGraceMs)));
      // The lock files and the launch record go only once nothing runs on the folder any more.
      if (!(await killAndWait(dir))) {
        throw refusal(409, 'LOCAL_PROFILE_BUSY', `The browser of this local profile (${id}) is still running and could not be stopped; its folder was left as it is.`);
      }
      clearRunFiles(dir);
      try { unlinkSync(join(dir, LAUNCH_FILE)); } catch { /* none */ }
    }
    await stopRelay(id, { forget: true });
    return { stopped: !!live || asked };
  }

  const publicRow = (profile, running, dir) => ({
    id: profile.id,
    name: profile.name,
    status: running ? 'running' : 'stopped',
    groupId: null,
    proxyId: null,
    proxy: profile.proxy.type === 'none' ? null : { type: profile.proxy.type, host: profile.proxy.host, port: String(profile.proxy.port), country: null },
    kind: 'local',
    browser: 'chromium',
    hasPassword: !!profile.proxy.password,
    ...(running && restartNeededFor(profile, dir) ? { restartNeeded: true } : {}),
  });

  return {
    root: rootDir,
    isLocalProfileId,
    assertLocalProfileRoot,

    /** How many local profiles there are (no process is asked). */
    count() { try { return readAll().length; } catch { return 0; } },
    /** A profile's name, or null (no process is asked). */
    nameOf(id) { try { return isLocalProfileId(id) ? (readAll().find((p) => p.id === id)?.name || null) : null; } catch { return null; } },
    /** What a session in the profile is told to emulate: { timezone, language } ('' = not set), or null. */
    settingsOf(id) { try { const p = isLocalProfileId(id) ? readAll().find((row) => row.id === id) : null; return p ? { name: p.name, timezone: p.timezone, language: p.language } : null; } catch { return null; } },

    /** Rows in the shape of MoreLogin's list, plus kind 'local'. Never the proxy's login. */
    async listLocalProfiles() {
      const rows = readAll();
      return Promise.all(rows.map(async (profile) => {
        const dir = join(rootDir, profile.id);
        const live = existsSync(dir) ? await liveEndpoint(dir) : null;
        return publicRow(profile, !!live, dir);
      }));
    },

    /** The rows of the owner's editor: the list's, plus what the form shows. The password is never returned. */
    async localProfileDetails() {
      const rows = readAll();
      return Promise.all(rows.map(async (profile) => {
        const dir = join(rootDir, profile.id);
        const live = existsSync(dir) ? await liveEndpoint(dir) : null;
        return {
          ...publicRow(profile, !!live, dir),
          createdAt: profile.createdAt,
          proxyUsername: profile.proxy.username || '',
          language: profile.language,
          timezone: profile.timezone,
          window: { ...profile.window },
          notes: profile.notes,
          relay: proxyNeedsRelay(profile.proxy) ? (relays.get(profile.id)?.port ? 'running' : (live ? 'missing' : 'stopped')) : null,
        };
      }));
    },

    async createLocalProfile(input) {
      const rows = readAll();
      if (rows.length >= LOCAL_PROFILES_MAX) throw refusal(409, 'LOCAL_PROFILES_FULL', `There are ${LOCAL_PROFILES_MAX} local profiles, the most SynaBun keeps: delete one first.`);
      const settings = normalizeLocalProfile(input);
      let id;
      do { id = `lp-${randomBytes(6).toString('hex')}`; } while (rows.some((p) => p.id === id));
      const profile = { id, createdAt: now(), ...settings };
      const dir = folderOf(id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeAll([...rows, profile]);
      return publicRow(profile, false, dir);
    },

    /** Saves new settings. They hold from the profile's next start: a running one answers `restartNeeded`. */
    async updateLocalProfile(id, input) {
      const rows = readAll();
      const at = rows.findIndex((p) => p.id === id);
      if (at === -1) throw refusal(404, 'LOCAL_PROFILE_NOT_FOUND', `There is no local profile with id ${String(id).slice(0, 64)}.`);
      const profile = { ...rows[at], ...normalizeLocalProfile(input, rows[at]) };
      rows[at] = profile;
      writeAll(rows);
      const dir = join(rootDir, id);
      const live = existsSync(dir) ? await liveEndpoint(dir) : null;
      return publicRow(profile, !!live, dir);
    },

    /** Stops the profile, then removes its folder and its entry. */
    async deleteLocalProfile(id) {
      const profile = stored(id);
      const dir = folderOf(id);
      await serialized(id, 'stop', () => stopNow(id));
      if (processesOf(dir).length) throw refusal(409, 'LOCAL_PROFILE_BUSY', `Local profile "${profile.name}" is still running and could not be stopped; nothing was deleted.`);
      rmSync(assertLocalProfileRoot(dir), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      writeAll(readAll().filter((p) => p.id !== id));
      return { id, name: profile.name };
    },

    /**
     * → { debugPort, kernel: 'chromium', webdriver: null }. A profile that is running is reused, unless it has to be
     * started again first: then the owner's start does that, and every other caller gets LOCAL_PROFILE_RESTART_NEEDED
     * (or LOCAL_PROFILE_BUSY for a Chrome that does not answer) and no browser.
     */
    async startLocalProfile(id, { owner = false } = {}) {
      stored(id);
      // The owner's start and anybody else's are not the same work (only the owner's may end a running Chrome), so
      // one never rides on the other's answer.
      return serialized(id, owner ? 'start-owner' : 'start', () => startNow(id, { owner: owner === true }));
    },

    /** Asks the profile's Chrome to close, stops what is left on its folder after the grace period, and its relay. */
    async stopLocalProfile(id) {
      stored(id);
      return serialized(id, 'stop', () => stopNow(id));
    },

    /** → { status: 'running' | 'stopped', debugPort } */
    async localProfileStatus(id) {
      stored(id);
      const dir = join(rootDir, id);
      const live = existsSync(dir) ? await liveEndpoint(dir) : null;
      return { status: live ? 'running' : 'stopped', debugPort: live ? live.port : null, localStatus: live ? 'running' : 'stopped' };
    },

    /** The exit address through a profile's proxy (or through `override`, the editor's unsaved values). */
    async checkLocalProfileProxy(id, override = null) {
      const profile = stored(id);
      let proxy = profile.proxy;
      if (override && typeof override === 'object') proxy = normalizeProxy(override, profile.proxy);
      return checkProxyImpl(proxy);
    },

    /**
     * After a SynaBun start: the relay of every profile whose Chrome is still running is put back on its saved port.
     * → [{ id, name, debugPort, relay: 'reopened' | 'restart-needed' | null }] for the profiles found running.
     */
    async adoptRunning() {
      const out = [];
      let rows = [];
      try { rows = readAll(); } catch (err) { log(`local profiles not read at start: ${err?.message || err}`); return out; }
      for (const profile of rows) {
        const dir = join(rootDir, profile.id);
        let live = null;
        try { live = existsSync(dir) ? await liveEndpoint(assertLocalProfileRoot(dir)) : null; } catch { live = null; }
        if (!live) continue;
        let relay = null;
        if (proxyNeedsRelay(profile.proxy) && !relays.get(profile.id)?.port) {
          const port = savedRelayPort(dir);
          try { if (!port) throw new Error('no saved port'); await openRelay(profile, dir, port); relay = 'reopened'; }
          catch (err) { relay = 'restart-needed'; log(`${profile.id} "${profile.name}": its proxy relay could not be reopened on port ${port || '?'} (${err?.code || err?.message || err}); pages fail there until the profile is started again`); }
        }
        out.push({ id: profile.id, name: profile.name, debugPort: live.port, relay });
      }
      return out;
    },

    /** The ports kept for the relays and the DevTools ports: { from, to }. */
    portRange: Object.freeze({ from: portRange.from, to: portRange.to }),
    /** The ports the relays listen on now (all inside portRange, which a guarded worker's sandbox denies whole). */
    relayPorts() { return [...relays.values()].map((relay) => relay.port).filter((port) => port > 0); },

    /** Stops every relay (the server is going down, or a test is over). The profiles' Chromes are left as they are. */
    async closeRelays() { for (const id of [...relays.keys()]) await stopRelay(id); },
  };
}
