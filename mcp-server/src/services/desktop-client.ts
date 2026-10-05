/**
 * Desktop (computer use) client — thin HTTP proxy to /api/desktop/* on the
 * Neural Interface, which owns the native helper, grants, lease and guards.
 *
 * Separate from neural-interface.ts on purpose: every call must carry the
 * caller's desktop grant, and the helpers there are browser-oriented. Never
 * throws — transport failures come back as { ok:false, code } data.
 */

import { randomUUID } from 'node:crypto';
import { callerDesktopGrant, callerRole, getIdentity, terminalIdFor } from './identity.js';

const BASE_URL = process.env.NEURAL_INTERFACE_URL
  || `http://localhost:${process.env.NEURAL_PORT || '3344'}`;
const ACTION_TIMEOUT = 45_000;

export interface DesktopResponse {
  ok?: boolean;
  code?: string;
  error?: string;
  forbidden?: boolean;
  [key: string]: unknown;
}

/**
 * `signal` is the caller's cancellation (the MCP request's `extra.signal`). It
 * joins the timeout, never replaces it; an aborted call comes back as
 * CANCELLED. Cancelling after the request left does not undo it: the Neural
 * Interface may still finish the action.
 */
async function post(path: string, body: Record<string, unknown>, timeoutMs = ACTION_TIMEOUT, signal?: AbortSignal): Promise<DesktopResponse> {
  const grant = callerDesktopGrant();
  if (!grant) return { ok: false, code: 'FORBIDDEN', error: 'Computer use is only available to the SynaBun assistant (and workers it dispatched with uses_computer).' };
  if (signal?.aborted) return { ok: false, code: 'CANCELLED', error: 'The call was cancelled before anything was sent.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Synabun-Terminal': terminalIdFor(getIdentity()),
      'X-Synabun-Desktop-Grant': grant,
      'X-Synabun-Request-Id': randomUUID(),
      'X-Synabun-Deadline': String(Date.now() + timeoutMs),
    };
    const role = callerRole();
    if (role) headers['X-Synabun-Role'] = role;
    const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
    const textBody = await res.text();
    let data: DesktopResponse;
    try { data = JSON.parse(textBody) as DesktopResponse; } catch { data = { ok: false, code: 'BAD_RESPONSE', error: textBody.slice(0, 300) }; }
    if (!res.ok && data.ok !== false) data.ok = false;
    if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (signal?.aborted) return { ok: false, code: 'CANCELLED', error: 'The call was cancelled; the desktop may still finish what it was doing — take a screenshot before retrying.' };
    if (controller.signal.aborted || /abort/i.test(msg)) return { ok: false, code: 'TIMEOUT', error: `The desktop action timed out after ${timeoutMs} ms; take a screenshot before retrying.` };
    return { ok: false, code: 'TRANSPORT_ERROR', error: `Neural Interface unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export function desktopAct(body: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<DesktopResponse> {
  return post('/api/desktop/act', body, timeoutMs ?? ACTION_TIMEOUT, signal);
}
export function desktopApps(body: Record<string, unknown>, signal?: AbortSignal): Promise<DesktopResponse> {
  return post('/api/desktop/apps', body, ACTION_TIMEOUT, signal);
}
export function desktopAx(body: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DesktopResponse> {
  return post('/api/desktop/ax', body, options.timeoutMs ?? ACTION_TIMEOUT, options.signal);
}
export function desktopStatus(body: Record<string, unknown>, signal?: AbortSignal): Promise<DesktopResponse> {
  return post('/api/desktop/agent-status', body, 15_000, signal);
}
