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
      ? spawn('open', [path], { detached: true, stdio: 'ignore' })
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
export async function ensureMoreLoginRunning(opts = {}) {
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

/**
 * Start (launch) a profile and return { debugPort, webdriver, raw }.
 * Recovers the debugPort via status when the env is already running.
 */
export async function startProfile(envId, opts = {}) {
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
    const stData = Array.isArray(st?.dataList) ? st.dataList[0] : (Array.isArray(st) ? st[0] : st);
    port = extractDebugPort(stData);
    webdriver = webdriver || (stData && stData.webdriver);
  }
  if (!port) throw new Error(`MoreLogin started env ${envId} but returned no debugPort`);
  return { debugPort: port, webdriver: webdriver || null, raw: data };
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

/** Create a quick profile. Shape varies by version; pass `opts.body` to override. */
export async function createProfile(opts = {}) {
  const body = {
    quantity: 1,
    browserTypeId: opts.browserTypeId || 1,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.body || {}),
  };
  const data = await request('/api/env/create/quick', body, opts);
  // Returns { envIds:[...] } or { id } depending on version.
  const ids = data && (data.envIds || (data.id != null ? [data.id] : []));
  return { ids: (ids || []).map(String), raw: data };
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
