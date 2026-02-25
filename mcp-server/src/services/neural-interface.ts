/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */

const BASE_URL = process.env.NEURAL_INTERFACE_URL || 'http://localhost:3344';
const DEFAULT_TIMEOUT = 10_000;
const LONG_TIMEOUT = 30_000;

export interface BrowserSessionInfo {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  clients: number;
}

interface NiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT
): Promise<NiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const opts: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE_URL}${path}`, opts);
    const data = await res.json() as NiResponse;
    if (!res.ok && !data.error) {
      data.error = `HTTP ${res.status}`;
    }
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      return { error: `Request timed out after ${timeout}ms` };
    }
    return { error: `Neural Interface unreachable: ${msg}. Is the Neural Interface server running?` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve which session ID to use.
 * - If sessionId provided, use it (verify it exists).
 * - If 1 session exists, auto-select it.
 * - If 0 sessions exist and autoCreate is true, create one.
 * - If multiple sessions and no ID, return error listing them.
 */
export async function resolveSession(
  sessionId?: string,
  autoCreate?: { url?: string }
): Promise<{ sessionId: string } | { error: string }> {
  if (sessionId) {
    // Verify session exists
    const data = await request('GET', '/api/browser/sessions');
    if (data.error) return { error: data.error };
    const sessions = (data.sessions || []) as BrowserSessionInfo[];
    if (sessions.find(s => s.id === sessionId)) {
      return { sessionId };
    }
    return { error: `Session ${sessionId} not found. Available: ${sessions.map(s => s.id).join(', ') || 'none'}` };
  }

  // List sessions
  const data = await request('GET', '/api/browser/sessions');
  if (data.error) return { error: data.error };
  const sessions = (data.sessions || []) as BrowserSessionInfo[];

  if (sessions.length === 1) {
    return { sessionId: sessions[0].id };
  }

  if (sessions.length === 0) {
    if (autoCreate) {
      const created = await request('POST', '/api/browser/sessions', {
        url: autoCreate.url || 'about:blank',
      });
      if (created.error) return { error: `Failed to auto-create session: ${created.error}` };
      return { sessionId: created.sessionId as string };
    }
    return { error: 'No browser sessions open. Use browser_session to create one first, or use browser_navigate with a URL to auto-create.' };
  }

  // Multiple sessions — require explicit ID
  const list = sessions.map(s => `  ${s.id} — ${s.title || s.url}`).join('\n');
  return { error: `Multiple browser sessions open. Specify sessionId:\n${list}` };
}

// ── Session management ──

export async function listSessions(): Promise<NiResponse> {
  return request('GET', '/api/browser/sessions');
}

export async function createSession(url?: string): Promise<NiResponse> {
  return request('POST', '/api/browser/sessions', { url: url || 'about:blank' });
}

export async function closeSession(sessionId: string): Promise<NiResponse> {
  return request('DELETE', `/api/browser/sessions/${sessionId}`);
}

// ── Navigation ──

export async function navigate(sessionId: string, url: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/navigate`, { url }, LONG_TIMEOUT);
}

export async function goBack(sessionId: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/back`);
}

export async function goForward(sessionId: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/forward`);
}

// ── Interaction (selector-based) ──

export async function click(sessionId: string, selector: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/click`, { selector });
}

export async function fill(sessionId: string, selector: string, value: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/fill`, { selector, value });
}

export async function type(sessionId: string, selector: string, text: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/type`, { selector, text });
}

export async function hover(sessionId: string, selector: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/hover`, { selector });
}

export async function selectOption(sessionId: string, selector: string, value: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/select`, { selector, value });
}

export async function pressKey(sessionId: string, key: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/press`, { key });
}

// ── Observation ──

export async function snapshot(sessionId: string): Promise<NiResponse> {
  return request('GET', `/api/browser/sessions/${sessionId}/snapshot`);
}

export async function getContent(sessionId: string): Promise<NiResponse> {
  return request('GET', `/api/browser/sessions/${sessionId}/content`);
}

export async function screenshot(sessionId: string): Promise<NiResponse> {
  return request('GET', `/api/browser/sessions/${sessionId}/screenshot-base64`);
}

// ── Advanced ──

export async function evaluate(sessionId: string, script: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/evaluate`, { script }, LONG_TIMEOUT);
}

export async function waitFor(
  sessionId: string,
  opts: { selector?: string; state?: string; timeout?: number }
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/wait`, opts, LONG_TIMEOUT);
}
