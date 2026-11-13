/**
 * MoreLogin local-API client + detection.
 *
 * MoreLogin (https://www.morelogin.com) is an anti-detect / multi-account
 * browser. Its desktop client exposes a local HTTP API (default
 * http://127.0.0.1:40000) that can list / create / start / stop browser
 * "environments" (profiles). Starting a profile returns a Chrome DevTools
 * `debugPort`, which we connect to with Playwright's `connectOverCDP()` — the
 * exact same mechanism SynaBun already uses for its CDP "attach" mode.
 *
 * Auth: on localhost most builds accept UNSIGNED requests. The documented
 * signed scheme (MD5 of apiId+nonce+secret) is applied only when an API id +
 * secret are configured (MoreLogin → Settings → API & MCP → API), as optional
 * hardening for setups that enforce it.
 *
 * Verified live (v2.58.0): POST /api/env/page {pageNo,pageSize} →
 *   { code:0, data:{ total, current, pages, dataList:[{ id, envName, groupId, proxyId, proxy }] } }
 *
 * Built-ins only — no new dependency. ESM, Node >= 22 (global fetch + node:crypto).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { registerBrowserNetworkEndpoint } from './browser-network-guard.js';

export const DEFAULT_MORELOGIN_PORT = 40000;
// MoreLogin's documented local-API ports. 40000 is the HTTP API SynaBun drives; 15523 is the companion port its
// desktop app also listens on. A guarded worker's sandbox denies both (a worker with the API could start another
// profile with its own CDP). Fixed, so they are denied even when nothing is listening at profile-generation time.
export const MORELOGIN_FIXED_API_PORTS = Object.freeze([40000, 15523]);

/** Resolve the MoreLogin local-API port: env → saved config → default. */
export function getMoreLoginPort(savedCfg) {
  const fromEnv = parseInt(process.env.MORELOGIN_API_PORT || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const ml = savedCfg && (savedCfg.morelogin || savedCfg);
  const fromCfg = parseInt((ml && (ml.port ?? ml.moreloginPort)) ?? '', 10);
  if (Number.isFinite(fromCfg) && fromCfg > 0) return fromCfg;
  return DEFAULT_MORELOGIN_PORT;
}

/** Detect a MoreLogin desktop install per-OS. Returns { installed, path }. */
export function isMoreLoginInstalled() {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/MoreLogin.app');
  } else if (process.platform === 'win32') {
    const { LOCALAPPDATA, ProgramFiles } = process.env;
    const PF86 = process.env['ProgramFiles(x86)'];
    if (process.env.MORELOGIN_APP_PATH) candidates.push(process.env.MORELOGIN_APP_PATH);
    if (LOCALAPPDATA) candidates.push(`${LOCALAPPDATA}\\Programs\\MoreLogin\\MoreLogin.exe`, `${LOCALAPPDATA}\\Programs\\morelogin\\MoreLogin.exe`, `${LOCALAPPDATA}\\MoreLogin\\MoreLogin.exe`);
    if (ProgramFiles) candidates.push(`${ProgramFiles}\\MoreLogin\\MoreLogin.exe`);
    if (PF86) candidates.push(`${PF86}\\MoreLogin\\MoreLogin.exe`);
  } else {
    candidates.push('/opt/MoreLogin/morelogin', '/opt/morelogin/morelogin', '/usr/share/morelogin');
    if (process.env.HOME) candidates.push(`${process.env.HOME}/.local/share/MoreLogin`);
  }
  for (const p of candidates) {
    try { if (existsSync(p)) return { installed: true, path: p }; } catch { /* ignore */ }
  }
  return { installed: false, path: null };
}

/**
 * Launch the installed MoreLogin desktop app. Best-effort, never throws —
 * the app is long-running so this is fire-and-forget (detached + unref'd).
 * Returns { launched, path, error }.
 */
export function launchMoreLoginApp() {
  const { installed, path } = isMoreLoginInstalled();
  if (!installed) return { launched: false, path: null, error: 'MoreLogin is not installed' };
  try {
    const child = process.platform === 'darwin'
      ? spawn('open', ['-g', path], { detached: true, stdio: 'ignore' }) // -g: launch without bringing it forward
      : spawn(path, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { launched: true, path, error: null };
  } catch (err) {
    return { launched: false, path, error: err?.message || String(err) };
  }
}

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

/** Build request headers, signing only when credentials are present. */
function buildHeaders(opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const appId = opts.appId || process.env.MORELOGIN_API_ID || '';
  const secretKey = opts.secretKey || process.env.MORELOGIN_SECRET || '';
  if (appId && secretKey) {
    // X-Nonce-Id = "<timestamp>:<random>"; Authorization = md5(apiId + nonce + secret)
    const nonceId = `${Date.now()}:${Math.random().toString(36).slice(2, 14)}`;
    headers['X-Api-Id'] = String(appId);
    headers['X-Nonce-Id'] = nonceId;
    headers['Authorization'] = md5(String(appId) + nonceId + String(secretKey));
  }
  return headers;
}

/**
 * Low-level POST to the MoreLogin local API. Returns the `data` payload.
 * Throws with a `.code` of MORELOGIN_UNREACHABLE | MORELOGIN_HTTP | MORELOGIN_API | MORELOGIN_SHAPE
 * (answered 2xx with a body that is not JSON).
 */
// Loopback hosts to try, in order. MoreLogin's local server may listen on IPv6 only
// (an Electron server bound to "localhost" resolves to ::1 first on Windows), so a
// refused 127.0.0.1 is retried on [::1]. The host that answered is remembered.
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]'];
let _preferredHost = LOOPBACK_HOSTS[0];
let _lastAnswerAt = 0; // when the local API last answered anything (any status, any body)
export function _resetMoreLoginHostForTests() { _preferredHost = LOOPBACK_HOSTS[0]; _lastAnswerAt = 0; }
export function _preferredMoreLoginHostForTests() { return _preferredHost; }

/** Whether the local API answered within the last `withinMs` (no request is made). */
export function moreLoginApiAnsweredRecently(withinMs = 120000) {
  return _lastAnswerAt > 0 && Date.now() - _lastAnswerAt <= withinMs;
}

/**
 * Cheap, synchronous "is MoreLogin here": the exe is in a known folder (or
 * MORELOGIN_APP_PATH) or its local API answered recently. Callers that need a
 * fresh answer probe first (probeMoreLoginApi).
 */
export function isMoreLoginPresent(withinMs = 120000) {
  let exe = false;
  try { exe = isMoreLoginInstalled().installed; } catch { exe = false; }
  return exe || moreLoginApiAnsweredRecently(withinMs);
}

// Error codes that prove the connection never opened, so the request was never
// delivered and the other loopback host may be tried even for a call that changes
// state (create, start). Anything else (a reset after sending, a malformed answer)
// may have reached MoreLogin: it is thrown, never sent a second time.
const NEVER_CONNECTED_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENOTFOUND',
  'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CONNECT',
]);
export function _neverConnected(err) {
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) {
    if (NEVER_CONNECTED_CODES.has(e.code)) return true;
    if (Array.isArray(e.errors) && e.errors.some(x => NEVER_CONNECTED_CODES.has(x?.code))) return true;
  }
  return false;
}

/**
 * One deadline for the whole call (opts.timeout, default 15 s): each loopback host
 * gets what is left of it, so two hosts never double the budget. The other host is
 * tried while time remains when the first one provably never connected; a timeout
 * is tried on the other host only for a read (opts.idempotent), since a timed-out
 * write may have been received.
 */
async function request(path, body, opts = {}) {
  const port = opts.port || getMoreLoginPort(opts.savedCfg);
  const fetchImpl = opts.fetch || fetch;
  const idempotent = opts.idempotent ?? (path === '/api/env/page' || path === '/api/env/status');
  const budget = opts.timeout || 15000;
  const deadline = Date.now() + budget;
  const hosts = [_preferredHost, ...LOOPBACK_HOSTS.filter(h => h !== _preferredHost)];
  let res;
  let lastErr = null;
  for (const host of hosts) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      res = await fetchImpl(`http://${host}:${port}${path}`, {
        method: 'POST',
        headers: buildHeaders(opts),
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(left),
      });
      _preferredHost = host;
      _lastAnswerAt = Date.now();
      break;
    } catch (err) {
      lastErr = err;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const retry = _neverConnected(err) || (timedOut && idempotent);
      if (!retry) break;
    }
  }
  if (!res) {
    const err = lastErr;
    const reason = !err ? `no time left of ${budget} ms` : (err?.cause?.code || err?.code || err?.message || err);
    const e = new Error(`MoreLogin API unreachable on :${port} (${reason})`);
    e.code = 'MORELOGIN_UNREACHABLE';
    throw e;
  }
  let json = null;
  let unparsable = false;
  try { json = await res.json(); }
  catch { unparsable = true; try { await res.body?.cancel(); } catch { /* ignore */ } }
  if (!res.ok) {
    const detail = json && (json.msg || json.message);
    const e = new Error(`MoreLogin API ${path} → HTTP ${res.status}${detail ? ` (${detail})` : ''}${res.status === 401 || res.status === 403 ? ' (set the API ID and API Key from MoreLogin → Settings → API in SynaBun Settings → MoreLogin)' : ''}`);
    e.code = 'MORELOGIN_HTTP';
    e.status = res.status;
    throw e;
  }
  if (json && json.code !== undefined && json.code !== 0) {
    const msg = json.msg || json.message || `code ${json.code}`;
    const e = new Error(`MoreLogin API ${path}: ${msg}${looksLikeAuthError(json.code, msg) ? ' (set the API ID and API Key from MoreLogin → Settings → API in SynaBun Settings → MoreLogin)' : ''}`);
    e.code = 'MORELOGIN_API';
    e.apiCode = json.code;
    throw e;
  }
  if (unparsable || !json || typeof json !== 'object') {
    const type = res.headers?.get?.('content-type') || 'no content type';
    const e = new Error(`MoreLogin API ${path} answered HTTP ${res.status} with a body that is not JSON (${type}); is something else listening on port ${port}?`);
    e.code = 'MORELOGIN_SHAPE';
    throw e;
  }
  return json.data;
}

function looksLikeAuthError(code, msg) {
  return /auth|sign|api.?key|api.?id|nonce|unauthori[sz]ed|forbidden|permission|token/i.test(String(msg || ''))
    || code === 401 || code === 403;
}

const PROFILE_LIST_KEYS = ['dataList', 'list', 'records', 'rows'];

/** Profile rows across response shapes: data.dataList | data.list | data.records | data.rows | data (array). A non-empty array wins over an empty one. */
export function profileRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const arrays = PROFILE_LIST_KEYS.map(k => data[k]).filter(Array.isArray);
  return arrays.find(a => a.length) || arrays[0] || [];
}

/** Whether a profile-page answer has a shape SynaBun reads (an array, a known list key, or a total). */
export function hasProfileShape(data) {
  if (Array.isArray(data)) return true;
  if (!data || typeof data !== 'object') return false;
  return PROFILE_LIST_KEYS.some(k => Array.isArray(data[k])) || (data.total != null && Number.isFinite(Number(data.total)));
}

function shapeError(data) {
  const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 8).join(', ') : typeof data;
  const e = new Error(`MoreLogin API /api/env/page answered in a shape SynaBun does not read (data: ${keys || 'empty'}); a newer MoreLogin may have changed its API`);
  e.code = 'MORELOGIN_SHAPE';
  return e;
}

/**
 * Normalize the `proxy` blob MoreLogin attaches to an env row. Kept (rather than
 * dropped) because a profile's proxy is invisible from SynaBun otherwise — when a
 * page fails to load there is no way to tell whether traffic left the machine.
 * Shape varies by version; every field is best-effort.
 */
function normalizeProxy(p) {
  if (!p || typeof p !== 'object') return null;
  const host = p.proxyIp || p.host || p.ip || p.server || null;
  const port = p.proxyPort ?? p.port ?? null;
  const type = p.proxyType || p.type || p.protocol || null;
  const country = p.country || p.countryCode || p.ipCountry || null;
  if (!host && !type && !country) return null;
  return {
    type: type != null ? String(type) : null,
    host: host != null ? String(host) : null,
    port: port != null ? String(port) : null,
    country: country != null ? String(country) : null,
  };
}

function normalizeProfile(e = {}) {
  return {
    id: e.id != null ? String(e.id) : null,
    name: e.envName || e.name || (e.id != null ? `env-${e.id}` : 'env'),
    status: e.localStatus || e.status || null,
    groupId: e.groupId != null ? String(e.groupId) : null,
    proxyId: e.proxyId != null ? String(e.proxyId) : null,
    proxy: normalizeProxy(e.proxy),
  };
}

/** List browser profiles (environments). Returns normalized rows. */
export async function listProfiles(opts = {}) {
  const data = await request('/api/env/page', { pageNo: opts.pageNo || 1, pageSize: opts.pageSize || 100 }, opts);
  if (!hasProfileShape(data)) throw shapeError(data);
  return profileRows(data).map(normalizeProfile).filter(p => p.id);
}

/**
 * Lightweight reachability probe. Never throws — returns {running, count}.
 * `running` means the local API answered at all: an answer that is an HTTP or API
 * error (signature required, API disabled, ...) still proves MoreLogin is up, and its
 * reason is returned in `apiError` instead of being reported as "not running".
 */
export async function probeMoreLoginApi(opts = {}) {
  try {
    const data = await request('/api/env/page', { pageNo: 1, pageSize: 1 }, { ...opts, timeout: opts.timeout || 4000 });
    if (!hasProfileShape(data)) throw shapeError(data);
    const total = data && !Array.isArray(data) && data.total != null ? Number(data.total) : profileRows(data).length;
    return { running: true, count: Number.isFinite(total) ? total : 0 };
  } catch (err) {
    const answered = err?.code === 'MORELOGIN_HTTP' || err?.code === 'MORELOGIN_API' || err?.code === 'MORELOGIN_SHAPE';
    return {
      running: answered, count: 0,
      error: err?.message || String(err), errCode: err?.code || null,
      ...(answered ? { apiError: err?.message || String(err) } : {}),
    };
  }
}

/**
 * Ensure MoreLogin's local API is reachable, auto-launching the desktop app
 * and waiting for it to come up if it isn't already running. Bounded by
 * timeoutMs (default 25s — MoreLogin is a heavier multi-process Electron app
 * than a plain browser relaunch). Never throws — mirrors probeMoreLoginApi's
 * always-resolve contract. While MoreLogin is the default browser, a
 * `running: false` result FAILS the session in createBrowserSession(); nothing
 * falls back to Chrome.
 */
export function ensureMoreLoginRunning(opts = {}) {
  // One start for everybody who asks at once: browser sessions of different profiles start side by side, and each
  // would otherwise launch the app while it is not running yet. The first caller's wait is the one that counts.
  const key = String(opts.port ?? getMoreLoginPort(opts.savedCfg));
  let start = _appStarts.get(key);
  if (!start) {
    start = startMoreLoginAppIfNeeded(opts).finally(() => { if (_appStarts.get(key) === start) _appStarts.delete(key); });
    _appStarts.set(key, start);
  }
  return start;
}

const _appStarts = new Map(); // local API port → the start under way

async function startMoreLoginAppIfNeeded(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 25000;
  const intervalMs = opts.intervalMs ?? 1000;

  let probe = await probeMoreLoginApi(opts);
  if (probe.running) return { ...probe, launched: false };

  const launch = launchMoreLoginApp();
  if (!launch.launched) return { ...probe, launched: false, launchError: launch.error };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalMs));
    probe = await probeMoreLoginApi(opts);
    if (probe.running) return { ...probe, launched: true };
  }
  return { ...probe, launched: true, timedOut: true };
}

/** Combined install + running status, used by the UI/status endpoints. */
export async function getMoreLoginStatus(opts = {}) {
  const inst = isMoreLoginInstalled();
  const port = getMoreLoginPort(opts.savedCfg);
  const probe = await probeMoreLoginApi({ ...opts, port });
  return {
    // An answering local API is proof of an install, wherever it lives (a custom
    // install folder on Windows is not among the known paths).
    installed: inst.installed || probe.running,
    appPath: inst.path,
    port,
    running: probe.running,
    apiError: probe.apiError || null,
    profileCount: probe.count || 0,
    signed: !!((opts.appId || process.env.MORELOGIN_API_ID) && (opts.secretKey || process.env.MORELOGIN_SECRET)),
    // Transport failures only: an API that answered with an error is running, and says why in apiError.
    error: probe.running ? null : (probe.error || null),
  };
}

function extractDebugPort(data) {
  if (!data || typeof data !== 'object') return null;
  const raw = data.debugPort ?? data.debug_port ?? data.port;
  const port = parseInt(raw, 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** Query a single profile's status (best-effort across body shapes). */
export async function profileStatus(envId, opts = {}) {
  try {
    return await request('/api/env/status', { envId: String(envId) }, opts);
  } catch (err) {
    if (err?.code === 'MORELOGIN_UNREACHABLE') throw err;
    // Some builds expect an array — retry once with envIds.
    try { return await request('/api/env/status', { envIds: [String(envId)] }, opts); }
    catch { return null; }
  }
}

/** MoreLogin's `browserTypeId` (profile detail, create): 1 is its Chrome-based browser, 2 its Firefox-based one. */
const BROWSER_TYPE_KERNEL = { 1: 'chromium', 2: 'firefox' };

/**
 * Which browser a profile runs, from whatever MoreLogin said about it: 'chromium', 'firefox' or null (not said).
 * Read from the profile detail's `browserTypeId` (then its user agent), or from the `webdriver` path a start or a
 * status answers with (`…/Core/chrome_64_154.0/webdriver_154`, `…/Core/firefox_64_148.1/webdriver_148`).
 * SynaBun drives a profile over the Chrome DevTools protocol, which only the Chrome-based browser speaks: the
 * Firefox one opens `--remote-debugging-port` too, but as Firefox's own remote agent (WebDriver BiDi), which
 * answers 404 to `/json/version`.
 */
export function profileKernel(data) {
  if (!data || typeof data !== 'object') return null;
  const byType = BROWSER_TYPE_KERNEL[Number(data.browserTypeId)];
  if (byType) return byType;
  const path = typeof data.webdriver === 'string' ? data.webdriver : '';
  const core = /(?:^|[\\/])(firefox|chrome|chromium)[_-][^\\/]*[\\/]/i.exec(path);
  if (core) return core[1].toLowerCase() === 'firefox' ? 'firefox' : 'chromium';
  const ua = data.advancedSetting && typeof data.advancedSetting.ua === 'string' ? data.advancedSetting.ua : '';
  if (/\bFirefox\/\d/.test(ua)) return 'firefox';
  if (/\bChrome\/\d/.test(ua)) return 'chromium';
  return null;
}

/** The error of a profile SynaBun cannot drive. `started` says whether this start may have opened its browser. */
export function notChromiumError(envId, { started = false, evidence = '' } = {}) {
  const e = new Error(
    `MoreLogin profile ${envId} runs MoreLogin's Firefox browser, which has no Chrome DevTools (CDP) endpoint${evidence ? ` (${evidence})` : ''}. `
    + 'SynaBun drives a MoreLogin profile over CDP, so only a Chrome-type profile can be used: '
    + 'pick a Chrome-type profile, or create one in MoreLogin (New profile → Browser: Chrome)'
    + (started ? '. The profile\'s Firefox window was left open in MoreLogin' : ''),
  );
  e.code = 'MORELOGIN_NOT_CHROMIUM';
  e.kernel = 'firefox';
  e.started = !!started;
  return e;
}

/** One profile's full record (`/api/env/detail`). Large: it carries the profile's whole cookie jar. */
export async function profileDetail(envId, opts = {}) {
  return request('/api/env/detail', { envId: String(envId) }, { ...opts, idempotent: true });
}

// Profiles already seen to be Chrome-type. A profile's browser is chosen when it is created, and the detail call
// that says it is megabytes (the cookie jar), so a Chrome verdict is asked for once. A Firefox verdict is never
// kept: it is asked again each time, and a wrong Chrome one is caught by the start's own answer.
const _chromiumProfiles = new Set();
export function _resetMoreLoginKernelsForTests() { _chromiumProfiles.clear(); _listedKernels.clear(); _kernelLookups.clear(); }

function statusRow(st) {
  return Array.isArray(st?.dataList) ? st.dataList[0] : (Array.isArray(st) ? st[0] : st);
}

/**
 * Which browser a profile runs, asked without starting it: the status of a running profile says it (small), else
 * the profile's detail. Best effort: null when MoreLogin does not say; never throws.
 */
export async function profileKernelOf(envId, opts = {}) {
  const id = String(envId);
  if (_chromiumProfiles.has(id)) return 'chromium';
  let kernel = null;
  try { kernel = profileKernel(statusRow(await profileStatus(id, opts))); }
  catch { /* unreachable: the start says so itself */ }
  if (!kernel) {
    try { kernel = profileKernel(await profileDetail(id, opts)); } catch { /* a MoreLogin without the call */ }
  }
  if (kernel === 'chromium') _chromiumProfiles.add(id);
  return kernel;
}

// ── Which browser each listed profile runs (the profile pickers, and the routes that save a choice) ──
// MoreLogin's list call does not say a profile's browser; only the megabyte detail does. So the verdicts are kept
// per profile: a Chrome one for the life of the process (above), a Firefox one for ten minutes, "MoreLogin did not
// say" for half a minute (then asked again, never taken for an answer). One lookup per profile at a time, a few at
// once, and a list never waits for them longer than its budget: what is not known yet is `null` in that answer and
// arrives in a later one. null always means "not known", and a profile of unknown browser stays usable everywhere:
// the start of a run still refuses a Firefox one (startProfile, requireCdp).
const FIREFOX_VERDICT_MS = 10 * 60_000;
const UNKNOWN_VERDICT_MS = 30_000;
const MAX_LISTED_VERDICTS = 5000;
const _listedKernels = new Map(); // id → { kernel: 'firefox' | null, at }
const _kernelLookups = new Map(); // id → the lookup under way

/** The verdict already held for a profile: { known: true, kernel } or { known: false }. Never asks MoreLogin. */
export function heldProfileKernel(envId, now = Date.now()) {
  const id = String(envId);
  if (_chromiumProfiles.has(id)) return { known: true, kernel: 'chromium' };
  const held = _listedKernels.get(id);
  if (!held) return { known: false, kernel: null };
  if (now - held.at > (held.kernel === 'firefox' ? FIREFOX_VERDICT_MS : UNKNOWN_VERDICT_MS)) {
    _listedKernels.delete(id);
    return { known: false, kernel: null };
  }
  return { known: true, kernel: held.kernel };
}

/** A profile's browser, from what is held or one shared lookup: 'chromium', 'firefox' or null. Never throws. */
export function lookupProfileKernel(envId, opts = {}) {
  const id = String(envId);
  const held = heldProfileKernel(id);
  if (held.known) return Promise.resolve(held.kernel);
  let lookup = _kernelLookups.get(id);
  if (!lookup) {
    lookup = (opts.kernelOf || profileKernelOf)(id, opts)
      .then((kernel) => (kernel === 'chromium' || kernel === 'firefox' ? kernel : null), () => null)
      .then((kernel) => {
        if (kernel !== 'chromium') {
          _listedKernels.delete(id); // newest last
          _listedKernels.set(id, { kernel, at: Date.now() });
          while (_listedKernels.size > MAX_LISTED_VERDICTS) _listedKernels.delete(_listedKernels.keys().next().value);
        } else _chromiumProfiles.add(id);
        return kernel;
      })
      .finally(() => { if (_kernelLookups.get(id) === lookup) _kernelLookups.delete(id); });
    _kernelLookups.set(id, lookup);
  }
  return lookup;
}

/**
 * The browsers of many profiles: { kernels: { id: 'chromium' | 'firefox' | null }, pending }.
 * `concurrency` lookups at once (default 4); after `budgetMs` (default 2500) the answer is what is known by then,
 * `pending` counts the profiles still being asked (their lookups go on and fill the cache for the next call).
 * A lookup that fails is `null` for that profile and never the list's failure.
 */
export async function profileKernels(envIds, opts = {}) {
  const ids = [...new Set((envIds || []).map(String))];
  const concurrency = Math.max(1, opts.concurrency || 4);
  const budgetMs = opts.budgetMs ?? 2500;
  const queue = ids.filter(id => !heldProfileKernel(id).known);
  if (queue.length) {
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const id = queue[next++];
        try { await lookupProfileKernel(id, opts); } catch { /* null for this one */ }
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker)).catch(() => {});
    let timer = null;
    await Promise.race([all, new Promise((done) => { timer = setTimeout(done, Math.max(0, budgetMs)); timer.unref?.(); })]);
    clearTimeout(timer);
  }
  const kernels = {};
  let pending = 0;
  for (const id of ids) {
    const held = heldProfileKernel(id);
    kernels[id] = held.known ? held.kernel : null;
    if (!held.known) pending++;
  }
  return { kernels, pending };
}

/** The error of a choice SynaBun refuses to save: a profile known to run MoreLogin's Firefox browser. */
export function notChromiumChoiceError(envId, name = null) {
  const label = name ? `"${name}" (${envId})` : String(envId);
  const e = new Error(
    `MoreLogin profile ${label} is a Firefox-type profile. SynaBun drives a MoreLogin profile over the Chrome DevTools protocol, `
    + 'so only a Chrome-type profile can be chosen: pick a Chrome-type profile, or create one in MoreLogin (New profile → Browser: Chrome).',
  );
  e.code = 'MORELOGIN_NOT_CHROMIUM';
  e.status = 400;
  e.kernel = 'firefox';
  return e;
}

/**
 * What answers on a started profile's debug port, asked when `/json/version` did not answer as DevTools does:
 * { kind: 'devtools' | 'not-devtools' | 'closed', status, server }. `not-devtools` is an HTTP server that is not a
 * DevTools endpoint (Firefox's remote agent says `Server: httpd.js` and 404); `closed` is nothing listening (yet).
 * Never throws.
 */
export async function describeDebugEndpoint(port, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  let res;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(opts.timeout || 2000) });
  } catch (err) {
    return { kind: 'closed', status: null, server: null, error: String(err?.cause?.code || err?.code || err?.message || err) };
  }
  const server = res.headers?.get?.('server') || null;
  let body = null;
  try { body = await res.json(); } catch { try { await res.body?.cancel(); } catch { /* ignore */ } }
  if (res.ok && body && typeof body === 'object' && (body.webSocketDebuggerUrl || body.Browser)) {
    return { kind: 'devtools', status: res.status, server };
  }
  return { kind: 'not-devtools', status: res.status, server, firefox: /^httpd\.js/i.test(server || '') };
}

/** The error of a started profile whose debug port is some other HTTP server (see describeDebugEndpoint). */
export function notDevToolsError(envId, port, seen = {}) {
  if (seen.firefox) {
    return notChromiumError(envId, { started: true, evidence: `port ${port} answers as Firefox's remote agent, HTTP ${seen.status}` });
  }
  const e = new Error(
    `MoreLogin started profile ${envId} and named debug port ${port}, but what listens there is not a Chrome DevTools endpoint `
    + `(HTTP ${seen.status} for /json/version${seen.server ? `, server "${seen.server}"` : ''}). `
    + 'SynaBun drives a MoreLogin profile over CDP: use a Chrome-type profile, or close this profile in MoreLogin and start the run again if it is one',
  );
  e.code = 'MORELOGIN_NOT_DEVTOOLS';
  return e;
}

/**
 * Start (launch) a profile and return { debugPort, webdriver, kernel, raw }.
 * Recovers the debugPort via status when the env is already running.
 *
 * `opts.requireCdp` (a start SynaBun will drive, never the Settings Start button): a Firefox-type profile is
 * refused with MORELOGIN_NOT_CHROMIUM before it is started when MoreLogin says what it is up front, and right
 * after the start when only the start's answer says it. It is never closed here: it may be the user's own window.
 */
export async function startProfile(envId, opts = {}) {
  if (opts.requireCdp && await profileKernelOf(envId, opts) === 'firefox') {
    throw notChromiumError(envId, { evidence: 'MoreLogin lists it as a Firefox profile' });
  }
  let data = null;
  try {
    data = await request('/api/env/start', { envId: String(envId), ...(opts.startArgs || {}) }, opts);
  } catch (err) {
    if (err?.code === 'MORELOGIN_UNREACHABLE' || err?.code === 'MORELOGIN_HTTP' || err?.code === 'MORELOGIN_SHAPE') throw err;
    // MORELOGIN_API (e.g. "already running") → fall through to status recovery.
  }
  let port = extractDebugPort(data);
  let webdriver = data && data.webdriver;
  if (!port) {
    // Already-running or no port echoed — recover from status. A `status` object
    // may be keyed directly or under a list.
    const st = await profileStatus(envId, opts);
    const stData = statusRow(st);
    port = extractDebugPort(stData);
    webdriver = webdriver || (stData && stData.webdriver);
  }
  const kernel = profileKernel({ webdriver });
  if (opts.requireCdp && kernel === 'firefox') {
    throw notChromiumError(envId, { started: true, evidence: `its browser is ${webdriver}` });
  }
  if (!port) throw new Error(`MoreLogin started env ${envId} but returned no debugPort`);
  if (kernel === 'chromium') _chromiumProfiles.add(String(envId));
  return { debugPort: port, webdriver: webdriver || null, kernel, raw: data };
}

/**
 * Attach to the profile's existing context, preserving MoreLogin's identity.
 * A new Playwright context is incognito: it does not inherit the profile's
 * cookies/fingerprint, even though it belongs to the same Chromium process.
 * Never substitute one when the profile context is missing. On setup failure,
 * close only this connectOverCDP transport; MoreLogin owns the running browser.
 */
export async function attachProfileBrowser(chromium, endpoint, openPage) {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('MoreLogin did not expose its profile context over CDP; refusing to create an isolated context with different cookies and fingerprint settings');
    }
    const page = await openPage(browser, context);
    registerBrowserNetworkEndpoint(context, endpoint);
    return { browser, context, page };
  } catch (error) {
    // Browser.close on a connectOverCDP browser disconnects this client. Do not
    // call context.close or /api/env/close: either would close the user's profile.
    try { await browser.close(); } catch { /* retain the original setup error */ }
    throw error;
  }
}

/** Stop (close) a profile. */
export async function stopProfile(envId, opts = {}) {
  return request('/api/env/close', { envId: String(envId) }, opts);
}

/** MoreLogin's operating-system id for a profile made on this host (Local API quick create: 1 Windows, 2 macOS,
 *  3 Android, 4 iOS). macOS on a Mac, Windows everywhere else (MoreLogin has no Linux fingerprint). */
export function hostOperatorSystemId(platform = process.platform) {
  return platform === 'darwin' ? 2 : 1;
}

/** The body of `/api/env/create/quick`, per guide.morelogin.com (Browser → Local API → Profiles, checked 2026-11-11):
 *  `browserTypeId`, `operatorSystemId` and `quantity` are required; there is no name field. Chrome type (1) is the
 *  only kind SynaBun can drive. `opts.operatorSystemId`, then `opts.body`, override. */
export function quickCreateBody(opts = {}) {
  return {
    quantity: 1,
    browserTypeId: 1,
    operatorSystemId: opts.operatorSystemId || hostOperatorSystemId(opts.platform),
    ...(opts.body || {}),
  };
}

const CREATE_PREFIX = 'MoreLogin API /api/env/create/quick';
/** A refusal of quick create, in words a toast can show: "MoreLogin refused the new profile: <reason>". */
function refusedNewProfile(err) {
  if (!err || (err.code !== 'MORELOGIN_API' && err.code !== 'MORELOGIN_HTTP')) return err;
  let reason = String(err.message || '');
  if (reason.startsWith(CREATE_PREFIX)) reason = reason.slice(CREATE_PREFIX.length).replace(/^\s*(?::|→)\s*/, '');
  const e = new Error(`MoreLogin refused the new profile: ${reason}`);
  e.code = err.code;
  if (err.apiCode !== undefined) e.apiCode = err.apiCode;
  if (err.status !== undefined) e.status = err.status;
  e.reason = reason;
  return e;
}

/** Create one quick profile. Quick create takes no name, so a name is set right after through `/api/env/update`
 *  (`envId` + `envName`); the profile exists even when that rename fails (`nameError`). */
export async function createProfile(opts = {}) {
  let data;
  try { data = await request('/api/env/create/quick', quickCreateBody(opts), opts); }
  catch (err) { throw refusedNewProfile(err); }
  // Documented answer: `data` is an array of id strings. Older clients answered { envIds } or { id }.
  const ids = Array.isArray(data) ? data
    : (data && (data.envIds || (data.id != null ? [data.id] : []))) || [];
  const out = { ids: ids.map(String), raw: data };
  if (opts.name && out.ids.length) {
    try { await request('/api/env/update', { envId: out.ids[0], envName: String(opts.name) }, opts); }
    catch (err) { out.nameError = err.message; }
  }
  return out;
}

/** Return the first profile, creating a default "SynaBun" profile if none exist. */
export async function ensureDefaultProfile(opts = {}) {
  const list = await listProfiles(opts);
  if (list.length) return list[0];
  await createProfile({ ...opts, name: opts.defaultName || 'SynaBun' });
  const after = await listProfiles(opts);
  if (!after.length) throw new Error('MoreLogin: no profiles available and auto-create failed');
  return after[0];
}
