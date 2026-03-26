/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */

const BASE_URL = process.env.NEURAL_INTERFACE_URL
  || `http://localhost:${process.env.NEURAL_PORT || '3344'}`;
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
 * - If sessionId provided, return it immediately (server returns 404 if invalid).
 * - If 1 session exists, auto-select it.
 * - If 0 sessions exist and autoCreate is true, create one.
 * - If multiple sessions and no ID, return error listing them.
 */
export async function resolveSession(
  sessionId?: string,
  autoCreate?: { url?: string }
): Promise<{ sessionId: string } | { error: string }> {
  // Agent-scoped browser session — set by the agent orchestrator to pin
  // this MCP instance to a specific browser session (multi-agent isolation).
  const pinnedSession = process.env.SYNABUN_BROWSER_SESSION;
  if (pinnedSession && !sessionId) {
    return { sessionId: pinnedSession };
  }

  if (sessionId) {
    // Trust the server — it will 404 if the session doesn't exist.
    // Skipping the extra GET /api/browser/sessions verification call saves a full round-trip.
    return { sessionId };
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

// ── Cache invalidation ──

export async function invalidateCache(reason: string): Promise<void> {
  try {
    await request('POST', '/api/cache/invalidate', { reason });
  } catch {
    // Fire-and-forget — don't block MCP tools if Neural Interface is down
  }
}

// ── Session management ──

export async function listSessions(): Promise<NiResponse> {
  return request('GET', '/api/browser/sessions');
}

export async function createSession(url?: string): Promise<NiResponse> {
  return request('POST', '/api/browser/sessions', {
    url: url || 'about:blank',
  });
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

export async function reload(sessionId: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/reload`, undefined, LONG_TIMEOUT);
}

// ── Interaction (selector-based) ──

export async function click(sessionId: string, selector: string, nthMatch?: number): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/click`, { selector, ...(nthMatch !== undefined && { nthMatch }) });
}

export async function fill(sessionId: string, selector: string, value: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/fill`, { selector, value });
}

export async function type(sessionId: string, selector: string | null, text: string): Promise<NiResponse> {
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

export async function scroll(
  sessionId: string,
  opts: { direction: string; distance?: number; selector?: string }
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/scroll`, opts as Record<string, unknown>);
}

export async function upload(
  sessionId: string,
  selector: string,
  filePaths: string[]
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/upload`, { selector, filePaths }, LONG_TIMEOUT);
}

// ── Observation ──

export async function snapshot(sessionId: string, selector?: string): Promise<NiResponse> {
  if (selector) return request('POST', `/api/browser/sessions/${sessionId}/snapshot`, { selector });
  return request('GET', `/api/browser/sessions/${sessionId}/snapshot`);
}

export async function getContent(sessionId: string): Promise<NiResponse> {
  return request('GET', `/api/browser/sessions/${sessionId}/content`);
}

export async function getMarkdown(sessionId: string): Promise<NiResponse> {
  return request('GET', `/api/browser/sessions/${sessionId}/markdown`, undefined, LONG_TIMEOUT);
}

export async function fetchMarkdown(url: string, timeout?: number): Promise<NiResponse> {
  return request('POST', '/api/fetch-markdown', { url, timeout }, LONG_TIMEOUT);
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
  opts: { selector?: string; state?: string; loadState?: string; timeout?: number }
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/wait`, opts, LONG_TIMEOUT);
}

// ── Whiteboard ──

export async function getWhiteboard(): Promise<NiResponse> {
  return request('GET', '/api/whiteboard');
}

export async function addWhiteboardElements(
  elements: Record<string, unknown>[],
  coordMode?: string,
  layout?: string
): Promise<NiResponse> {
  return request('POST', '/api/whiteboard/elements', { elements, coordMode, layout } as Record<string, unknown>);
}

export async function updateWhiteboardElement(
  id: string,
  updates: Record<string, unknown>,
  coordMode?: string
): Promise<NiResponse> {
  return request('PUT', `/api/whiteboard/elements/${id}`, { updates, coordMode } as Record<string, unknown>);
}

export async function removeWhiteboardElement(id: string): Promise<NiResponse> {
  return request('DELETE', `/api/whiteboard/elements/${id}`);
}

export async function clearWhiteboard(): Promise<NiResponse> {
  return request('POST', '/api/whiteboard/clear');
}

export async function whiteboardScreenshot(): Promise<NiResponse> {
  return request('GET', '/api/whiteboard/screenshot', undefined, 15_000);
}

// ── Cards (Memory Card MCP integration) ──

export async function getCards(): Promise<NiResponse> {
  return request('GET', '/api/cards');
}

export async function openCard(
  memoryId: string,
  opts?: { left?: number; top?: number; compact?: boolean; coordMode?: string }
): Promise<NiResponse> {
  return request('POST', '/api/cards/open', { memoryId, ...opts } as Record<string, unknown>);
}

export async function closeCard(memoryId?: string): Promise<NiResponse> {
  return request('POST', '/api/cards/close', memoryId ? { memoryId } : {} as Record<string, unknown>);
}

export async function updateCard(
  memoryId: string,
  updates: Record<string, unknown>,
  coordMode?: string
): Promise<NiResponse> {
  return request('PUT', `/api/cards/${memoryId}`, { ...updates, coordMode } as Record<string, unknown>);
}

export async function cardsScreenshot(): Promise<NiResponse> {
  return request('GET', '/api/cards/screenshot', undefined, 15_000);
}

// ── TicTacToe ──

export async function tictactoeStart(piece?: string): Promise<NiResponse> {
  return request('POST', '/api/games/tictactoe/start', { piece } as Record<string, unknown>);
}

export async function tictactoeMove(cell: number): Promise<NiResponse> {
  return request('POST', '/api/games/tictactoe/move', { cell } as Record<string, unknown>);
}

export async function tictactoeState(): Promise<NiResponse> {
  return request('GET', '/api/games/tictactoe/state');
}

export async function tictactoeEnd(): Promise<NiResponse> {
  return request('POST', '/api/games/tictactoe/end');
}

// ── Git ──

export async function gitStatus(path: string): Promise<NiResponse> {
  return request('GET', `/api/git/status?path=${encodeURIComponent(path)}`);
}

export async function gitDiff(path: string, maxLines?: number): Promise<NiResponse> {
  const qs = `path=${encodeURIComponent(path)}${maxLines ? `&maxLines=${maxLines}` : ''}`;
  return request('GET', `/api/git/diff?${qs}`, undefined, LONG_TIMEOUT);
}

export async function gitCommit(path: string, message: string, files?: string[]): Promise<NiResponse> {
  return request('POST', '/api/git/commit', { path, message, files } as Record<string, unknown>);
}

export async function gitLog(path: string, count?: number): Promise<NiResponse> {
  return request('GET', `/api/git/log?path=${encodeURIComponent(path)}&count=${count || 10}`);
}

export async function gitBranches(path: string): Promise<NiResponse> {
  return request('GET', `/api/terminal/branches?path=${encodeURIComponent(path)}`);
}
