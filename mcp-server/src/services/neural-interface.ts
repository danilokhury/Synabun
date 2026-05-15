/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */

const BASE_URL = process.env.NEURAL_INTERFACE_URL
  || `http://localhost:${process.env.NEURAL_PORT || '3344'}`;
const DEFAULT_TIMEOUT = 10_000;
const LONG_TIMEOUT = 30_000;
const SESSION_CREATE_TIMEOUT = 70_000;

export function isBrowserFastMode(): boolean {
  return process.env.SYNABUN_BROWSER_FAST === '1';
}

export function isBrowserCompactMode(): boolean {
  return process.env.SYNABUN_BROWSER_COMPACT === '1' || isBrowserFastMode();
}

export interface BrowserSessionInfo {
  id: string;
  url: string;
  title: string;
  createdAt: number;
  clients: number;
  loopOwned?: boolean;
  agentOwned?: boolean;
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

// Recovery cache: when a pinned session dies, auto-create a replacement and cache its ID
// so subsequent tool calls in the same MCP process reuse the recovered session.
let _recoveredSessionId: string | null = null;

// Session affinity: once this MCP process uses or creates a browser session, remember it.
// Prevents a second Claude Code instance (e.g. sidepanel) from grabbing the CLI's session
// when both are running without explicit sessionId or SYNABUN_BROWSER_SESSION pinning.
let _affinitySessionId: string | null = null;

// Ancestor-PID fallback (Layer B). Walks the process tree once and caches the
// resolved loop pins. Used when codex/opencode strip SYNABUN_BROWSER_* env on
// MCP child spawn — we map our PID chain up to a known PTY and pull the loop's
// session/tab IDs from that loop's state file.
let _ancestorLookupTried = false;
let _ancestorPinnedSession: string | null = null;
let _ancestorPinnedTab: string | null = null;

async function getAncestorPids(): Promise<number[]> {
  const ppid = typeof process.ppid === 'number' ? process.ppid : 0;
  if (!ppid) return [];
  const pids: number[] = [ppid];
  const isWin = process.platform === 'win32';
  const { exec } = await import('node:child_process');
  const runCmd = (cmd: string): Promise<string> => new Promise((resolve) => {
    exec(cmd, { timeout: 1500, windowsHide: true }, (_err: unknown, stdout: string) => resolve(stdout || ''));
  });
  let current = ppid;
  for (let i = 0; i < 6; i++) {
    let parent = 0;
    try {
      if (isWin) {
        const out = await runCmd(`wmic process where ProcessId=${current} get ParentProcessId /value`);
        const m = /ParentProcessId=(\d+)/i.exec(out);
        parent = m ? Number(m[1]) : 0;
      } else {
        const out = await runCmd(`ps -o ppid= -p ${current}`);
        parent = Number(out.trim().split(/\s+/)[0]) || 0;
      }
    } catch { parent = 0; }
    if (!parent || parent === 1 || parent === current) break;
    pids.push(parent);
    current = parent;
  }
  return pids;
}

async function resolveFromAncestors(): Promise<void> {
  if (_ancestorLookupTried) return;
  _ancestorLookupTried = true;
  try {
    const pids = await getAncestorPids();
    if (pids.length === 0) return;
    const resp = await request('POST', '/api/loop/resolve-from-ancestors', { pids }, 2000);
    if (resp.matched) {
      _ancestorPinnedSession = (resp.browserSessionId as string) || null;
      _ancestorPinnedTab = (resp.browserTabId as string) || null;
      console.error(`[MCP] ancestor lookup matched: session=${_ancestorPinnedSession} tab=${_ancestorPinnedTab}`);
    }
  } catch { /* best-effort */ }
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
  autoCreate?: { url?: string },
  tabId?: string
): Promise<{ sessionId: string; tabId?: string } | { error: string }> {
  // Resolve tab ID from explicit param or environment variable.
  // When SYNABUN_BROWSER_TAB is pinned (loop/agent context), the env value wins
  // even if caller passes a different tabId — prevents tab-leak across loops.
  // If env pins are missing (codex/opencode env-strip case), try ancestor-PID
  // lookup once and use whatever the Neural Interface reports for our PTY.
  if (!process.env.SYNABUN_BROWSER_SESSION && !process.env.SYNABUN_BROWSER_TAB && !sessionId) {
    await resolveFromAncestors();
  }
  const pinnedTab = process.env.SYNABUN_BROWSER_TAB || _ancestorPinnedTab || undefined;
  const resolvedTabId = pinnedTab || tabId || undefined;
  if (pinnedTab && tabId && tabId !== pinnedTab) {
    console.error(`[MCP] tabId override ignored: pinned=${pinnedTab} requested=${tabId}`);
  }

  // Agent/loop-scoped browser session — set by the orchestrator to pin
  // this MCP instance to a specific browser session (multi-session isolation).
  // If pinned session died, check recovery cache first, then auto-create.
  const pinnedSession = process.env.SYNABUN_BROWSER_SESSION || _ancestorPinnedSession || undefined;
  if (pinnedSession && !sessionId) {
    // Check recovery cache first — avoids re-creating on every call after recovery
    if (_recoveredSessionId) {
      const recheck = await request('GET', '/api/browser/sessions');
      const alive = ((recheck.sessions || []) as BrowserSessionInfo[]).find(s => s.id === _recoveredSessionId);
      if (alive) return { sessionId: _recoveredSessionId, tabId: resolvedTabId };
      _recoveredSessionId = null; // recovered session also died — try fresh recovery
    }

    const check = await request('GET', '/api/browser/sessions');
    const active = ((check.sessions || []) as BrowserSessionInfo[]).find(s => s.id === pinnedSession);
    if (active) return { sessionId: pinnedSession, tabId: resolvedTabId };

    // Pinned session is gone — auto-recover by creating a new one
    console.error(`[MCP] Pinned browser session ${pinnedSession} is gone — recovering with new session`);
    const recovered = await request('POST', '/api/browser/sessions', {
      url: 'about:blank',
    }, SESSION_CREATE_TIMEOUT);
    if (recovered.error) {
      return { error: `Pinned browser session ${pinnedSession} is no longer available and recovery failed: ${recovered.error}` };
    }
    _recoveredSessionId = recovered.sessionId as string;
    return { sessionId: _recoveredSessionId, tabId: resolvedTabId };
  }

  if (sessionId) {
    // Trust the server — it will 404 if the session doesn't exist.
    // Skipping the extra GET /api/browser/sessions verification call saves a full round-trip.
    _affinitySessionId = sessionId;
    return { sessionId, tabId: resolvedTabId };
  }

  // Codex fast mode favors one direct create call on first navigate. This avoids
  // the list-sessions round trip that dominates short browser flows.
  if (autoCreate && isBrowserFastMode()) {
    const created = await request('POST', '/api/browser/sessions', {
      url: autoCreate.url || 'about:blank',
    }, SESSION_CREATE_TIMEOUT);
    if (created.error) return { error: `Failed to auto-create session: ${created.error}` };
    _affinitySessionId = created.sessionId as string;
    return { sessionId: _affinitySessionId, tabId: resolvedTabId };
  }

  // List sessions (single GET used for both affinity check and auto-selection)
  const data = await request('GET', '/api/browser/sessions');
  if (data.error) return { error: data.error };
  const allSessions = (data.sessions || []) as BrowserSessionInfo[];

  // Check affinity — reuse session this MCP process previously used/created
  if (_affinitySessionId) {
    const affinityAlive = allSessions.find(s => s.id === _affinitySessionId);
    if (affinityAlive) return { sessionId: _affinitySessionId, tabId: resolvedTabId };
    _affinitySessionId = null; // session gone, clear affinity
  }

  // Interactive sessions (no pinned env var) must not grab loop/agent-owned sessions.
  // Pinned sessions already returned above; explicit sessionId trusted above.
  const sessions = allSessions.filter(s => !s.loopOwned && !s.agentOwned);

  // If autoCreate is available (browser_navigate) and unowned sessions exist but none
  // are ours (no affinity), create a new session instead of hijacking another caller's.
  // This prevents sidepanel from grabbing the CLI's session and vice versa.
  if (sessions.length > 0 && autoCreate) {
    const created = await request('POST', '/api/browser/sessions', {
      url: autoCreate.url || 'about:blank',
    }, SESSION_CREATE_TIMEOUT);
    if (created.error) return { error: `Failed to auto-create session: ${created.error}` };
    _affinitySessionId = created.sessionId as string;
    return { sessionId: _affinitySessionId, tabId: resolvedTabId };
  }

  if (sessions.length === 1) {
    // No autoCreate — caller wants to interact with the existing session (click, snapshot, etc.)
    _affinitySessionId = sessions[0].id;
    return { sessionId: sessions[0].id, tabId: resolvedTabId };
  }

  if (sessions.length === 0) {
    if (autoCreate) {
      const created = await request('POST', '/api/browser/sessions', {
        url: autoCreate.url || 'about:blank',
      }, SESSION_CREATE_TIMEOUT);
      if (created.error) return { error: `Failed to auto-create session: ${created.error}` };
      _affinitySessionId = created.sessionId as string;
      return { sessionId: _affinitySessionId, tabId: resolvedTabId };
    }
    const ownedCount = allSessions.length - sessions.length;
    if (ownedCount > 0) {
      return { error: `${ownedCount} browser session(s) exist but are owned by active automations. Use browser_navigate with a URL to open your own session.` };
    }
    return { error: 'No browser sessions open. Use browser_session to create one first, or use browser_navigate with a URL to auto-create.' };
  }

  // Multiple available sessions — require explicit ID
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
  }, SESSION_CREATE_TIMEOUT);
}

export async function closeSession(sessionId: string): Promise<NiResponse> {
  return request('DELETE', `/api/browser/sessions/${sessionId}`);
}

// ── Navigation ──

export async function navigate(
  sessionId: string,
  url: string,
  tabId?: string,
  returnSnapshot?: { mode?: string; selector?: string; viewport?: boolean }
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/navigate`, {
    url,
    ...(isBrowserCompactMode() && { compact: true }),
    ...(returnSnapshot && { returnSnapshot }),
    ...(tabId && { tabId }),
  }, LONG_TIMEOUT);
}

export async function goBack(sessionId: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/back`, { ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function goForward(sessionId: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/forward`, { ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function reload(sessionId: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/reload`, { ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

// ── Interaction (selector-based) ──

export async function click(
  sessionId: string,
  selector: string,
  nthMatch?: number,
  tabId?: string,
  textHint?: string,
  returnSnapshot?: { mode?: string; selector?: string; viewport?: boolean }
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/click`, {
    selector,
    ...(nthMatch !== undefined && { nthMatch }),
    ...(textHint && { textHint }),
    ...(isBrowserCompactMode() && { compact: true }),
    ...(returnSnapshot && { returnSnapshot }),
    ...(tabId && { tabId }),
  });
}

export async function fill(sessionId: string, selector: string, value: string, nthMatch?: number, tabId?: string, textHint?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/fill`, { selector, value, ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function type(sessionId: string, selector: string | null, text: string, nthMatch?: number, tabId?: string, textHint?: string, mode?: 'sequential' | 'insert'): Promise<NiResponse> {
  const resolvedMode = mode || (isBrowserFastMode() ? 'insert' : 'sequential');
  return request('POST', `/api/browser/sessions/${sessionId}/type`, { selector, text, mode: resolvedMode, ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function hover(sessionId: string, selector: string, nthMatch?: number, tabId?: string, textHint?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/hover`, { selector, ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function selectOption(sessionId: string, selector: string, value: string, nthMatch?: number, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/select`, { selector, value, ...(nthMatch !== undefined && { nthMatch }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function pressKey(sessionId: string, key: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/press`, { key, ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function scroll(
  sessionId: string,
  opts: { direction: string; distance?: number; selector?: string; returnSnapshot?: { mode?: string; selector?: string; viewport?: boolean } },
  tabId?: string
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/scroll`, { ...opts, ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) } as Record<string, unknown>);
}

export async function upload(
  sessionId: string,
  selector: string,
  filePaths: string[],
  nthMatch?: number,
  tabId?: string
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/upload`, { selector, filePaths, ...(nthMatch !== undefined && { nthMatch }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

// ── Observation ──

export async function snapshot(
  sessionId: string,
  selector?: string,
  tabId?: string,
  opts?: { mode?: string; viewport?: boolean }
): Promise<NiResponse> {
  const hasOpts = !!(opts && (opts.mode || opts.viewport));
  // Always POST when selector OR opts present (POST supports a body); GET only for bare defaults.
  if (selector || hasOpts) {
    return request('POST', `/api/browser/sessions/${sessionId}/snapshot`, {
      ...(selector && { selector }),
      ...(opts?.mode && { mode: opts.mode }),
      ...(opts?.viewport && { viewport: true }),
      ...(tabId && { tabId }),
    });
  }
  const qs = tabId ? `?tabId=${tabId}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/snapshot${qs}`);
}

export async function getContent(sessionId: string, tabId?: string): Promise<NiResponse> {
  const qs = tabId ? `?tabId=${tabId}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/content${qs}`);
}

export async function getMarkdown(sessionId: string, tabId?: string): Promise<NiResponse> {
  const qs = tabId ? `?tabId=${tabId}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/markdown${qs}`, undefined, LONG_TIMEOUT);
}

export async function fetchMarkdown(url: string, timeout?: number): Promise<NiResponse> {
  return request('POST', '/api/fetch-markdown', { url, timeout }, LONG_TIMEOUT);
}

export async function screenshot(sessionId: string, tabId?: string): Promise<NiResponse> {
  const qs = tabId ? `?tabId=${tabId}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/screenshot-base64${qs}`);
}

// ── Advanced ──

export async function evaluate(sessionId: string, script: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/evaluate`, { script, ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

export async function waitFor(
  sessionId: string,
  opts: { selector?: string; state?: string; loadState?: string; timeout?: number },
  tabId?: string
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/wait`, { ...opts, ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) }, LONG_TIMEOUT);
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

// ── Image store ──

export async function listImages(): Promise<NiResponse> {
  return request('GET', '/api/images');
}

export async function deleteImage(filename: string): Promise<NiResponse> {
  return request('DELETE', `/api/images/${encodeURIComponent(filename)}`);
}
