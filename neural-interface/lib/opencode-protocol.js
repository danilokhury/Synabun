// ─────────────────────────────────────────────────────────────────────────────
// Which OpenCode SynaBun talks to, and how to know it is really there.
//
// OpenCode 1 and OpenCode 2 are different servers behind the same
// `opencode serve`:
//   • OpenCode 1 (`opencode --version` → "1.18.34"): its API at the root
//     (/global/health, /session, /global/event, …), no password.
//   • OpenCode 2 (→ "opencode v2.0.32"): its API under /api/*, HTTP Basic auth
//     (user `opencode`) with a password set per launch (OPENCODE_PASSWORD,
//     which OpenCode keeps out of its children's environment); every other
//     path is its web app, an HTML page with status 200.
// SynaBun reads the major version of the binary it is about to start (the CLI
// resolver's cached `--version`, keyed by the file, so an upgrade in place is
// read again), starts it the way that version wants, and calls a serve healthy
// only when the right API answers JSON: an HTML page never passes.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';

/** Protocols SynaBun speaks, by the OpenCode major version that serves them. */
export const OPENCODE_PROTOCOLS = Object.freeze({ 1: 'opencode1', 2: 'opencode2' });
export const OPENCODE2_USERNAME = 'opencode';

/** "1.18.34", "opencode v2.0.32", "v1.19.3" → 1 / 2; null when no version can be read. */
export function opencodeMajorOf(version) {
  const match = String(version ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

/**
 * The protocol for a version string: `{ protocol: 1 | 2 | null, major,
 * version, supported, reason }`. OpenCode 0.x is the 1.x API's predecessor and
 * speaks it; a major SynaBun does not know is refused with a sentence, never
 * guessed at.
 */
export function protocolForVersion(version) {
  const major = opencodeMajorOf(version);
  const text = version ? String(version).trim() : '';
  if (major == null) {
    return { protocol: null, major: null, version: text || null, supported: false, reason: text ? `SynaBun cannot read the OpenCode version "${text}".` : 'SynaBun could not read the OpenCode version.' };
  }
  if (major <= 1) return { protocol: 1, major, version: text, supported: true, reason: null };
  if (major === 2) return { protocol: 2, major, version: text, supported: true, reason: null };
  return { protocol: null, major, version: text, supported: false, reason: `OpenCode ${major} (${text}) is newer than SynaBun supports: SynaBun works with OpenCode 1 and OpenCode 2.` };
}

/** A fresh password for one OpenCode 2 launch. */
export function newServePassword() {
  return randomBytes(24).toString('base64url');
}

/** The Authorization header for an OpenCode 2 serve. */
export function basicAuthHeader(password, username = OPENCODE2_USERNAME) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * The arguments and environment of `opencode serve` on `port` for a protocol.
 * OpenCode 1 keeps exactly what SynaBun always ran (`serve --port N`); OpenCode
 * 2 also gets its loopback host name and the launch's password (OPENCODE_PASSWORD;
 * any OPENCODE_SERVER_PASSWORD the environment carries is dropped, so the
 * password SynaBun holds is the one the serve checks). A version SynaBun could
 * not read (`protocol` null: a command line in Settings) starts like OpenCode
 * 2: OpenCode 1 ignores OPENCODE_PASSWORD and takes --hostname too, and the
 * health check then says which one answered.
 */
export function serveSpecFor(protocol, port, { env = process.env, password = null } = {}) {
  const args = ['serve', '--port', String(port)];
  if (protocol === 1) return { args, env, password: null };
  const pass = password || newServePassword();
  const next = { ...env, OPENCODE_PASSWORD: pass };
  delete next.OPENCODE_SERVER_PASSWORD;
  return { args: [...args, '--hostname', '127.0.0.1'], env: next, password: pass };
}

function isJsonResponse(res) {
  return /\bapplication\/json\b/i.test(String(res?.headers?.get?.('content-type') || ''));
}

async function readJson(res) {
  if (!isJsonResponse(res)) return { json: null, html: /text\/html/i.test(String(res?.headers?.get?.('content-type') || '')) };
  try { return { json: await res.json(), html: false }; } catch { return { json: null, html: false }; }
}

/**
 * Is a real OpenCode API answering on `port`? `protocol` 1 asks
 * /global/health, 2 asks /api/info with `password`; `protocol` null asks both
 * (an unknown serve: which one is it?). Resolves
 * `{ ok, protocol, version, state, error }`, where `state` is
 *   'healthy'  the protocol's API answered JSON
 *   'locked'   an OpenCode 2 serve whose password SynaBun does not hold
 *   'mismatch' an OpenCode of the other major answered
 *   'html'     a web page (OpenCode 2's app, or anything else) — never healthy
 *   'down'     nothing answered
 *   'error'    something answered, but not an OpenCode API
 * Never throws.
 */
export async function checkOpencodeServer({ port, protocol = null, password = null, fetchImpl = globalThis.fetch, timeoutMs = 2000, host = '127.0.0.1' } = {}) {
  const base = `http://${host}:${port}`;
  const get = async (path, headers = {}) => {
    try {
      return await fetchImpl(`${base}${path}`, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { failed: true, error };
    }
  };
  const asV1 = async () => {
    const res = await get('/global/health');
    if (res.failed) return { ok: false, protocol: 1, version: null, state: 'down', error: String(res.error?.message || res.error) };
    const { json, html } = await readJson(res);
    if (res.ok && json && (json.healthy === true || typeof json.version === 'string')) {
      return { ok: true, protocol: 1, version: typeof json.version === 'string' ? json.version : null, state: 'healthy', error: null };
    }
    return { ok: false, protocol: 1, version: null, state: html ? 'html' : 'error', error: html ? 'answered with a web page, not the OpenCode 1 API' : `GET /global/health answered ${res.status}` };
  };
  const asV2 = async () => {
    const res = await get('/api/info', password ? { authorization: basicAuthHeader(password) } : {});
    if (res.failed) return { ok: false, protocol: 2, version: null, state: 'down', error: String(res.error?.message || res.error) };
    const { json, html } = await readJson(res);
    if (res.ok && json && typeof json.version === 'string' && Array.isArray(json.urls)) {
      return { ok: true, protocol: 2, version: json.version, state: 'healthy', error: null };
    }
    if (res.status === 401 && json && /unauthori[sz]ed/i.test(String(json._tag || json.name || ''))) {
      return { ok: false, protocol: 2, version: null, state: 'locked', error: password ? 'the OpenCode 2 serve refused SynaBun\'s password' : 'an OpenCode 2 serve SynaBun did not start (it needs that serve\'s password)' };
    }
    return { ok: false, protocol: 2, version: null, state: html ? 'html' : 'error', error: html ? 'answered with a web page, not the OpenCode 2 API' : `GET /api/info answered ${res.status}` };
  };

  if (protocol === 1) {
    const v1 = await asV1();
    if (v1.ok || v1.state === 'down') return v1;
    // A web page where OpenCode 1 was expected: is it an OpenCode 2?
    const v2 = await asV2();
    if (v2.ok || v2.state === 'locked') return { ...v2, ok: false, state: 'mismatch', error: 'an OpenCode 2 serve answered where SynaBun expected OpenCode 1' };
    return v1;
  }
  if (protocol === 2) {
    const v2 = await asV2();
    if (v2.ok || v2.state === 'down' || v2.state === 'locked') return v2;
    const v1 = await asV1();
    if (v1.ok) return { ...v1, ok: false, state: 'mismatch', error: 'an OpenCode 1 serve answered where SynaBun expected OpenCode 2' };
    return v2;
  }
  const v1 = await asV1();
  if (v1.ok || v1.state === 'down') return v1;
  const v2 = await asV2();
  return v2.ok || v2.state === 'locked' ? v2 : v1;
}

/**
 * The sentence a person reads when OpenCode cannot be used: what was found and
 * what to do. `check` is a checkOpencodeServer answer, `detected` a
 * protocolForVersion answer.
 */
export function opencodeProblemText({ check = null, detected = null, port = null } = {}) {
  if (detected && !detected.supported) return detected.reason;
  if (!check || check.ok) return '';
  const where = port ? ` on port ${port}` : '';
  switch (check.state) {
    case 'locked':
      return `An OpenCode 2 server SynaBun did not start is already running${where}, and SynaBun does not have its password. Stop that server (or free the port) and start OpenCode again from SynaBun.`;
    case 'mismatch':
      return `The OpenCode server${where} is not the version SynaBun found on this computer (${check.error}). Stop it and start OpenCode again from SynaBun.`;
    case 'html':
      return `Something${where} answers with a web page instead of the OpenCode API (${check.error}).`;
    case 'down':
      return `OpenCode is not answering${where}.`;
    default:
      return `OpenCode${where} did not answer as expected: ${check.error || 'unknown error'}.`;
  }
}
