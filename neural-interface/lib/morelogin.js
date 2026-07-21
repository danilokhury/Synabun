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

export const DEFAULT_MORELOGIN_PORT = 40000;

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
    if (LOCALAPPDATA) candidates.push(`${LOCALAPPDATA}\\Programs\\MoreLogin\\MoreLogin.exe`, `${LOCALAPPDATA}\\MoreLogin\\MoreLogin.exe`);
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
 * Throws with a `.code` of MORELOGIN_UNREACHABLE | MORELOGIN_HTTP | MORELOGIN_API.
 */
async function request(path, body, opts = {}) {
  const port = opts.port || getMoreLoginPort(opts.savedCfg);
  const url = `http://127.0.0.1:${port}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(opts),
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(opts.timeout || 15000),
    });
  } catch (err) {
    const e = new Error(`MoreLogin API unreachable on :${port} (${err?.message || err})`);
    e.code = 'MORELOGIN_UNREACHABLE';
    throw e;
  }
  let json = null;
  try { json = await res.json(); }
  catch { try { await res.body?.cancel(); } catch { /* ignore */ } }
  if (!res.ok) {
    const e = new Error(`MoreLogin API ${path} → HTTP ${res.status}`);
    e.code = 'MORELOGIN_HTTP';
    e.status = res.status;
    throw e;
  }
  if (json && json.code !== undefined && json.code !== 0) {
    const e = new Error(`MoreLogin API ${path}: ${json.msg || `code ${json.code}`}`);
    e.code = 'MORELOGIN_API';
    e.apiCode = json.code;
    throw e;
  }
  return json ? json.data : null;
}

function normalizeProfile(e = {}) {
  return {
    id: e.id != null ? String(e.id) : null,
    name: e.envName || e.name || (e.id != null ? `env-${e.id}` : 'env'),
    status: e.localStatus || e.status || null,
    groupId: e.groupId != null ? String(e.groupId) : null,
    proxyId: e.proxyId != null ? String(e.proxyId) : null,
  };
}

/** List browser profiles (environments). Returns normalized rows. */
export async function listProfiles(opts = {}) {
  const data = await request('/api/env/page', { pageNo: opts.pageNo || 1, pageSize: opts.pageSize || 100 }, opts);
  const list = (data && (data.dataList || data.list)) || [];
  return list.map(normalizeProfile).filter(p => p.id);
}

/** Lightweight reachability probe. Never throws — returns {running, count}. */
export async function probeMoreLoginApi(opts = {}) {
  try {
    const data = await request('/api/env/page', { pageNo: 1, pageSize: 1 }, { ...opts, timeout: opts.timeout || 4000 });
    const total = data && data.total != null ? Number(data.total)
      : (data && (data.dataList || data.list) ? (data.dataList || data.list).length : 0);
    return { running: true, count: Number.isFinite(total) ? total : 0 };
  } catch (err) {
    return { running: false, count: 0, error: err?.message || String(err), errCode: err?.code || null };
  }
}

/**
 * Ensure MoreLogin's local API is reachable, auto-launching the desktop app
 * and waiting for it to come up if it isn't already running. Bounded by
 * timeoutMs (default 25s — MoreLogin is a heavier multi-process Electron app
 * than a plain browser relaunch). Never throws — mirrors probeMoreLoginApi's
 * always-resolve contract so callers can fall back to Chrome unconditionally.
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
    installed: inst.installed,
    appPath: inst.path,
    port,
    running: probe.running,
    profileCount: probe.count || 0,
    signed: !!((opts.appId || process.env.MORELOGIN_API_ID) && (opts.secretKey || process.env.MORELOGIN_SECRET)),
    error: probe.error || null,
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
    if (err?.code === 'MORELOGIN_UNREACHABLE' || err?.code === 'MORELOGIN_HTTP') throw err;
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
