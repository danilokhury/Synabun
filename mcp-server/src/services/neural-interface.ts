/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */

import {
  type CallerIdentity,
  getIdentity,
  effectivePins,
  terminalIdFor,
  setReleaseHook,
  peekStdioIdentity,
  isHttpMode,
} from './identity.js';

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
  interactiveOwned?: boolean;
  agentOwned?: boolean;
  persistent?: boolean;
  activeTabId?: string | null;
  tabs?: Array<{ id: string; url?: string; title?: string; active?: boolean }>;
  /** ownerKey → tabId for every automation that owns a tab in this session.
   *  Used to tell a pristine (manual) session apart from one another automation
   *  already drives, so we never adopt-and-collide with its tab. */
  tabOwners?: Record<string, string>;
}

interface NiResponse {
  ok?: boolean;
  error?: string;
  tabRecovered?: boolean;
  sessionInvalidated?: boolean;
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Per-caller routing identity: the server maps this to the caller's owned
    // tab (_tabOwners) so tab-less browser calls never land on another
    // automation's tab. Derived per-request over HTTP, per-process for stdio.
    headers['X-Synabun-Terminal'] = terminalIdFor(getIdentity());
    const opts: RequestInit = {
      method,
      headers,
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
 * Best-effort reconciliation for an MCP process that changed its own tool
 * profile. Only sidepanel/automation children carry an explicit terminal id;
 * standalone CLI processes stay process-local without contacting Neural
 * Interface. The server derives the owning runtime from X-Synabun-Terminal.
 */
export type RuntimeMcpProfileReport = {
  reported: boolean;
  hostRefresh: 'scheduled' | 'notification' | 'not-needed' | 'unavailable';
  runtimeKind?: 'opencode' | 'codex' | 'loop';
  correlationId?: string;
  error?: string;
};

export async function reportRuntimeMcpProfile(
  profile: string,
  options: { catalogMode?: 'profiled' | 'deferred' } = {}
): Promise<RuntimeMcpProfileReport> {
  if (!String(process.env.SYNABUN_TERMINAL_SESSION || '').trim()) {
    return { reported: false, hostRefresh: 'notification' };
  }
  const result = await request('POST', '/api/mcp/runtime-profile', {
    profile,
    catalogMode: options.catalogMode || 'profiled',
  }, 2_000);
  if (result.ok) {
    const hostRefresh = result.hostRefresh === 'scheduled'
      || result.hostRefresh === 'notification'
      || result.hostRefresh === 'not-needed'
      ? result.hostRefresh
      : 'unavailable';
    const runtimeKind = result.runtimeKind === 'opencode' || result.runtimeKind === 'codex' || result.runtimeKind === 'loop'
      ? result.runtimeKind
      : undefined;
    return {
      reported: true,
      hostRefresh,
      runtimeKind,
      correlationId: typeof result.correlationId === 'string' ? result.correlationId : undefined,
    };
  }
  return {
    reported: false,
    hostRefresh: 'unavailable',
    error: typeof result.error === 'string' ? result.error : 'Runtime profile report failed',
  };
}

// All per-caller identity state (recovery cache, session affinity, interactive
// tab cache, ancestor-PID pins) lives on the CallerIdentity object resolved by
// getIdentity() — per HTTP caller over the HTTP transport, a per-process
// singleton for stdio. Module-level versions of this state were the root cause
// of cross-automation tab collisions: every HTTP caller shared them.

// Join the ONE shared browser with a dedicated, owned tab (instead of launching a
// second browser on a persistent profile, which fails with "profile is locked").
async function acquireInteractive(id: CallerIdentity, url?: string): Promise<{ sessionId: string; tabId?: string } | { error: string }> {
  const resp = await request('POST', '/api/browser/acquire', {
    clientId: id.clientId,
    url: url || 'about:blank',
  }, SESSION_CREATE_TIMEOUT);
  if (resp.error || !resp.sessionId) {
    return { error: `Failed to acquire a shared browser tab: ${resp.error || 'no session returned'}` };
  }
  id.state.interactiveSessionId = resp.sessionId as string;
  id.state.interactiveTabId = (resp.tabId as string) || null;
  id.state.affinitySessionId = id.state.interactiveSessionId;
  return { sessionId: id.state.interactiveSessionId, tabId: id.state.interactiveTabId || undefined };
}

// Best-effort release of an identity's owned tab, so the shared browser can be
// grace-reaped once no owners remain. Fire-and-forget — never blocks shutdown.
// Also registered as the identity-eviction hook (HTTP DELETE / idle TTL).
function releaseTabFor(id: CallerIdentity): void {
  if (!id.state.interactiveSessionId) return;
  try {
    void fetch(`${BASE_URL}/api/browser/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: id.clientId }),
    }).catch(() => {});
  } catch { /* best-effort */ }
}
setReleaseHook(releaseTabFor);

// Process exit hooks only matter for stdio (one process per caller). In HTTP
// mode the NI server hosts many identities — their tabs are released by MCP
// session DELETE or idle eviction, and an NI shutdown takes the browser with it.
function releaseOnExit(): void {
  if (isHttpMode()) return;
  const stdio = peekStdioIdentity();
  if (stdio) releaseTabFor(stdio);
}
process.once('exit', releaseOnExit);
process.once('SIGTERM', () => { releaseOnExit(); process.exit(0); });
process.once('SIGINT', () => { releaseOnExit(); process.exit(0); });

// Ancestor-PID fallback (Layer B). Walks the process tree once and caches the
// resolved loop pins on the identity. Used when codex/opencode strip
// SYNABUN_BROWSER_* env on MCP child spawn — we map our PID chain up to a known
// PTY and pull the loop's session/tab IDs from that loop's state file.
// Bounded retry instead of a permanent single-shot latch: a fast codex/opencode
// exec spawn can call MCP before its PTY is registered server-side, so the first
// ancestor lookup misses. Retry a few times until matched, then give up.
const ANCESTOR_MAX_ATTEMPTS = 4;

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

async function resolveFromAncestors(id: CallerIdentity): Promise<void> {
  // Over HTTP this code runs in the Neural Interface's own process — walking
  // OUR pid chain would resolve the NI server, not the caller. HTTP callers
  // carry their identity in headers/Mcp-Session-Id instead.
  if (id.source !== 'stdio') return;
  if (id.state.ancestorPinnedSession) return;            // already resolved
  if (id.state.ancestorAttempts >= ANCESTOR_MAX_ATTEMPTS) return; // give up after N misses
  id.state.ancestorAttempts++;
  try {
    const pids = await getAncestorPids();
    if (pids.length === 0) return;
    const resp = await request('POST', '/api/loop/resolve-from-ancestors', { pids }, 2000);
    // Capture the owning terminalSessionId whenever a PTY matched (even if its
    // loop file lacked browser pins) — it's needed for the X-Synabun-Terminal header.
    if (resp.terminalSessionId) id.state.ancestorPinnedTerminal = resp.terminalSessionId as string;
    if (resp.matched) {
      id.state.ancestorPinnedSession = (resp.browserSessionId as string) || null;
      id.state.ancestorPinnedTab = (resp.browserTabId as string) || null;
      console.error(`[MCP] ancestor lookup matched: session=${id.state.ancestorPinnedSession} tab=${id.state.ancestorPinnedTab} terminal=${id.state.ancestorPinnedTerminal}`);
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
  // Per-caller identity: pins come from launch headers (HTTP) or live env
  // (stdio); all caches below live on the identity, never module-level.
  const id = getIdentity();
  const pins = effectivePins(id);

  // Resolve tab ID from explicit param or pin.
  // When a tab is pinned (loop/agent context), the pin wins even if the caller
  // passes a different tabId — prevents tab-leak across loops.
  // If pins are missing (codex/opencode env-strip case), try ancestor-PID
  // lookup (stdio only) and use whatever the Neural Interface reports for our PTY.
  if (!pins.browserSessionId && !pins.browserTabId && !sessionId) {
    await resolveFromAncestors(id);
  }
  const pinnedTab = pins.browserTabId || id.state.ancestorPinnedTab || undefined;
  const resolvedTabId = pinnedTab || tabId || undefined;
  if (pinnedTab && tabId && tabId !== pinnedTab) {
    console.error(`[MCP] tabId override ignored: pinned=${pinnedTab} requested=${tabId}`);
  }

  // Agent/loop-scoped browser session — set by the orchestrator to pin
  // this caller to a specific browser session (multi-session isolation).
  // If pinned session died, check recovery cache first, then auto-create.
  const pinnedSession = pins.browserSessionId || id.state.ancestorPinnedSession || undefined;
  // Loop prompts intentionally pass their injected sessionId/tabId on every
  // call. Treat an explicit session that matches the pin as pinned traffic too;
  // otherwise the old fast path skipped liveness checks and returned a stale
  // tab forever after a renderer/page closed.
  if (pinnedSession && (!sessionId || sessionId === pinnedSession)) {
    // Check recovery cache first — avoids re-creating on every call after recovery.
    // Return the RECOVERED tab, never the stale pinned tab (which 404s).
    if (id.state.recoveredSessionId) {
      const recheck = await request('GET', '/api/browser/sessions');
      const alive = ((recheck.sessions || []) as BrowserSessionInfo[]).find(s => s.id === id.state.recoveredSessionId);
      if (alive) return { sessionId: id.state.recoveredSessionId, tabId: id.state.recoveredTabId || undefined };
      id.state.recoveredSessionId = null; // recovered session also died — try fresh recovery
      id.state.recoveredTabId = null;
    }

    const check = await request('GET', '/api/browser/sessions');
    const active = ((check.sessions || []) as BrowserSessionInfo[]).find(s => s.id === pinnedSession);
    if (active) {
      // Also verify the resolved tab still exists in the session; if not, recover.
      const tabList = active.tabs;
      const tabAlive = !resolvedTabId || !tabList || tabList.some(t => t.id === resolvedTabId);
      if (tabAlive) return { sessionId: pinnedSession, tabId: resolvedTabId };
      console.error(`[MCP] Pinned tab ${resolvedTabId} not found in active session ${pinnedSession} — recovering`);
      const terminalSessionId = pins.terminalSessionId || undefined;
      const recovered = await request(
        'POST',
        '/api/loop/recover-browser',
        terminalSessionId ? { terminalSessionId } : {},
        SESSION_CREATE_TIMEOUT
      );
      if (!recovered.error && recovered.sessionId) {
        id.state.recoveredSessionId = recovered.sessionId as string;
        id.state.recoveredTabId = (recovered.tabId as string) || null;
        return { sessionId: id.state.recoveredSessionId, tabId: id.state.recoveredTabId || undefined };
      }
      return { sessionId: pinnedSession, tabId: resolvedTabId }; // fall through to old tab (will fail gracefully)
    }

    // Pinned session is gone — rejoin the SHARED loop browser with a fresh owned
    // tab (not an isolated new browser), and adopt the NEW tabId. Forwarding the
    // stale pinned tab into a different session would 404 every subsequent call.
    console.error(`[MCP] Pinned browser session ${pinnedSession} is gone — recovering via shared loop browser`);
    const terminalSessionId = pins.terminalSessionId || undefined;
    const recovered = await request(
      'POST',
      '/api/loop/recover-browser',
      terminalSessionId ? { terminalSessionId } : {},
      SESSION_CREATE_TIMEOUT
    );
    if (recovered.error || !recovered.sessionId) {
      return { error: `Pinned browser session ${pinnedSession} is no longer available and recovery failed: ${recovered.error || 'no session returned'}` };
    }
    id.state.recoveredSessionId = recovered.sessionId as string;
    id.state.recoveredTabId = (recovered.tabId as string) || null;
    return { sessionId: id.state.recoveredSessionId, tabId: id.state.recoveredTabId || undefined };
  }

  if (sessionId) {
    // Trust the server — it will 404 if the session doesn't exist.
    // Skipping the extra GET /api/browser/sessions verification call saves a full round-trip.
    id.state.affinitySessionId = sessionId;
    return { sessionId, tabId: resolvedTabId };
  }

  // Reuse the dedicated tab THIS caller already acquired in the shared
  // browser (set by a prior acquireInteractive). The X-Synabun-Terminal header routes
  // tab-less calls to it, but returning the tabId keeps routing robust if the header
  // is ever dropped. Re-acquired below if the underlying session has since died.
  if (!sessionId && id.state.interactiveSessionId) {
    if (isBrowserFastMode()) {
      // Fast mode trusts the cache without a verify round-trip.
      return { sessionId: id.state.interactiveSessionId, tabId: resolvedTabId || id.state.interactiveTabId || undefined };
    }
    const check = await request('GET', '/api/browser/sessions');
    const alive = ((check.sessions || []) as BrowserSessionInfo[]).find(s => s.id === id.state.interactiveSessionId);
    if (alive) return { sessionId: id.state.interactiveSessionId, tabId: resolvedTabId || id.state.interactiveTabId || undefined };
    id.state.interactiveSessionId = null;
    id.state.interactiveTabId = null; // session gone — fall through to re-acquire
  }

  // Codex fast mode favors one direct create call on first navigate. This avoids
  // the list-sessions round trip that dominates short browser flows. If the profile
  // is persistent, a second launchPersistentContext fails with "profile is locked" —
  // fall back to acquiring a dedicated tab in the shared browser instead.
  if (autoCreate && isBrowserFastMode()) {
    const created = await request('POST', '/api/browser/sessions', {
      url: autoCreate.url || 'about:blank',
    }, SESSION_CREATE_TIMEOUT);
    if (created.error) {
      if (/lock/i.test(created.error)) return acquireInteractive(id, autoCreate.url);
      return { error: `Failed to auto-create session: ${created.error}` };
    }
    id.state.affinitySessionId = created.sessionId as string;
    return { sessionId: id.state.affinitySessionId, tabId: resolvedTabId };
  }

  // List sessions (single GET used for both affinity check and auto-selection)
  const data = await request('GET', '/api/browser/sessions');
  if (data.error) return { error: data.error };
  const allSessions = (data.sessions || []) as BrowserSessionInfo[];

  // Check affinity — reuse session this caller previously used/created
  if (id.state.affinitySessionId) {
    const affinityAlive = allSessions.find(s => s.id === id.state.affinitySessionId);
    if (affinityAlive) return { sessionId: id.state.affinitySessionId, tabId: resolvedTabId };
    id.state.affinitySessionId = null; // session gone, clear affinity
  }

  // Interactive sessions (no pinned env var) must not grab loop/agent/interactive-owned
  // sessions. Pinned sessions already returned above; explicit sessionId trusted above.
  const sessions = allSessions.filter(s => !s.loopOwned && !s.agentOwned && !s.interactiveOwned);

  // Under a persistent profile, a second launchPersistentContext fails with "profile is
  // locked", and any owned session means a shared persistent browser is already running.
  // In those cases, don't try to spawn a separate browser — join the ONE shared browser
  // with a dedicated, owned tab. For a clean profile with no owners, keep the historical
  // separate-browser behavior (no lock, no regression).
  const lockRisk = allSessions.some(s => s.persistent || s.loopOwned || s.agentOwned || s.interactiveOwned);
  const autoCreateSession = async (): Promise<{ sessionId: string; tabId?: string } | { error: string }> => {
    if (lockRisk) return acquireInteractive(id, autoCreate?.url);
    const created = await request('POST', '/api/browser/sessions', {
      url: autoCreate?.url || 'about:blank',
    }, SESSION_CREATE_TIMEOUT);
    if (created.error) {
      if (/lock/i.test(created.error)) return acquireInteractive(id, autoCreate?.url);
      return { error: `Failed to auto-create session: ${created.error}` };
    }
    id.state.affinitySessionId = created.sessionId as string;
    return { sessionId: id.state.affinitySessionId, tabId: resolvedTabId };
  };

  // If autoCreate is available (browser_navigate) and unowned sessions exist but none
  // are ours (no affinity), create/acquire our own instead of hijacking another caller's.
  // This prevents sidepanel from grabbing the CLI's session and vice versa.
  if (sessions.length > 0 && autoCreate) {
    return autoCreateSession();
  }

  if (sessions.length === 1) {
    // No autoCreate — caller wants to interact with an existing page (click, snapshot, etc.).
    // Adopting is ONLY safe for a pristine, unowned session (e.g. a page the user opened
    // manually in the NI UI). If ANOTHER automation already owns a tab here (it plain-created
    // the session or acquired a tab — see _tabOwners), adopting makes us a tab-less freeloader
    // that FAILS CLOSED (404) the moment the session goes multi-tab — the sidepanel-vs-CLI
    // collision. In that case acquire our OWN dedicated tab in the shared browser instead.
    const myTerminalId = terminalIdFor(id);
    const loneOwners = sessions[0].tabOwners || {};
    const ownedByOther = Object.keys(loneOwners).some(k => k !== id.clientId && k !== myTerminalId);
    if (ownedByOther) {
      return acquireInteractive(id, autoCreate?.url);
    }
    id.state.affinitySessionId = sessions[0].id;
    return { sessionId: sessions[0].id, tabId: resolvedTabId };
  }

  if (sessions.length === 0) {
    if (autoCreate) {
      return autoCreateSession();
    }
    const ownedCount = allSessions.length - sessions.length;
    if (ownedCount > 0) {
      // Active automations hold the shared browser and there is no unowned session for
      // us. Don't grab their tab and don't error — acquire our OWN dedicated tab so even
      // a tab-less first tool (snapshot/click) is isolated. about:blank is fine; a later
      // navigate reuses this same owned tab via the X-Synabun-Terminal routing.
      return acquireInteractive(id, undefined);
    }
    return { error: 'No browser sessions open. Use browser_session to create one first, or use browser_navigate with a URL to auto-create.' };
  }

  // Multiple available sessions — require explicit ID
  const list = sessions.map(s => `  ${s.id} — ${s.title || s.url}`).join('\n');
  return { error: `Multiple browser sessions open. Specify sessionId:\n${list}` };
}

// ── Cache invalidation ──

export async function invalidateCache(reason: string, id?: string): Promise<void> {
  try {
    // Passing the changed memory id lets the NI patch its link cache
    // incrementally instead of recomputing all pairwise links.
    await request('POST', '/api/cache/invalidate', { reason, id });
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
  returnSnapshot?: { mode?: string; selector?: string; viewport?: boolean },
  snapshot?: 'diff' | 'full' | 'none'
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/navigate`, {
    url,
    ...(isBrowserCompactMode() && { compact: true }),
    ...(snapshot && { snapshot }),
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

// ── Interaction (ref- or selector-based) ──

export async function click(
  sessionId: string,
  selector: string | undefined,
  nthMatch?: number,
  tabId?: string,
  textHint?: string,
  returnSnapshot?: { mode?: string; selector?: string; viewport?: boolean },
  ref?: string,
  snapshot?: 'diff' | 'full' | 'none'
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/click`, {
    ...(selector && { selector }),
    ...(ref && { ref }),
    ...(nthMatch !== undefined && { nthMatch }),
    ...(textHint && { textHint }),
    ...(isBrowserCompactMode() && { compact: true }),
    ...(snapshot && { snapshot }),
    ...(returnSnapshot && { returnSnapshot }),
    ...(tabId && { tabId }),
  });
}

export async function fill(sessionId: string, selector: string | undefined, value: string, nthMatch?: number, tabId?: string, textHint?: string, ref?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/fill`, { ...(selector && { selector }), ...(ref && { ref }), value, ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function type(sessionId: string, selector: string | null, text: string, nthMatch?: number, tabId?: string, textHint?: string, mode?: 'sequential' | 'insert' | 'paragraphs', ref?: string): Promise<NiResponse> {
  // An explicit mode (including 'paragraphs') is always honored; only the unset case falls back to fast-mode insert.
  const resolvedMode = mode || (isBrowserFastMode() ? 'insert' : 'sequential');
  return request('POST', `/api/browser/sessions/${sessionId}/type`, { selector, ...(ref && { ref }), text, mode: resolvedMode, ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function hover(sessionId: string, selector: string | undefined, nthMatch?: number, tabId?: string, textHint?: string, ref?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/hover`, { ...(selector && { selector }), ...(ref && { ref }), ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function selectOption(sessionId: string, selector: string | undefined, value: string, nthMatch?: number, tabId?: string, ref?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/select`, { ...(selector && { selector }), ...(ref && { ref }), value, ...(nthMatch !== undefined && { nthMatch }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function pressKey(sessionId: string, key: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/press`, { key, ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function scroll(
  sessionId: string,
  opts: { direction: string; distance?: number; selector?: string; ref?: string; snapshot?: 'diff' | 'full' | 'none'; returnSnapshot?: { mode?: string; selector?: string; viewport?: boolean } },
  tabId?: string
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/scroll`, { ...opts, ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) } as Record<string, unknown>);
}

export async function upload(
  sessionId: string,
  selector: string | undefined,
  filePaths: string[],
  nthMatch?: number,
  tabId?: string,
  ref?: string
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/upload`, { ...(selector && { selector }), ...(ref && { ref }), filePaths, ...(nthMatch !== undefined && { nthMatch }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

// ── Observation ──

export async function snapshot(
  sessionId: string,
  selector?: string,
  tabId?: string,
  opts?: { mode?: string; viewport?: boolean; depth?: number; diff?: boolean; force?: boolean; maxChars?: number }
): Promise<NiResponse> {
  const hasOpts = !!(opts && (opts.mode || opts.viewport || opts.depth || opts.diff || opts.force || opts.maxChars));
  // Always POST when selector OR opts present (POST supports a body); GET only for bare defaults.
  if (selector || hasOpts) {
    return request('POST', `/api/browser/sessions/${sessionId}/snapshot`, {
      ...(selector && { selector }),
      ...(opts?.mode && { mode: opts.mode }),
      ...(opts?.viewport && { viewport: true }),
      ...(opts?.depth && { depth: opts.depth }),
      ...(opts?.diff && { diff: true }),
      ...(opts?.force && { force: true }),
      ...(opts?.maxChars && { maxChars: opts.maxChars }),
      ...(tabId && { tabId }),
    }, LONG_TIMEOUT);
  }
  const qs = tabId ? `?tabId=${tabId}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/snapshot${qs}`);
}

export async function getContent(sessionId: string, tabId?: string, opts?: { maxChars?: number; offset?: number }): Promise<NiResponse> {
  const params = new URLSearchParams();
  if (tabId) params.set('tabId', tabId);
  if (opts?.maxChars) params.set('maxChars', String(opts.maxChars));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const qs = params.size ? `?${params}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/content${qs}`);
}

export async function getMarkdown(sessionId: string, tabId?: string, opts?: { maxChars?: number; offset?: number }): Promise<NiResponse> {
  const params = new URLSearchParams();
  if (tabId) params.set('tabId', tabId);
  if (opts?.maxChars) params.set('maxChars', String(opts.maxChars));
  if (opts?.offset) params.set('offset', String(opts.offset));
  const qs = params.size ? `?${params}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/markdown${qs}`, undefined, LONG_TIMEOUT);
}

export async function fetchMarkdown(url: string, timeout?: number): Promise<NiResponse> {
  return request('POST', '/api/fetch-markdown', { url, timeout }, LONG_TIMEOUT);
}

export async function screenshot(sessionId: string, tabId?: string, opts?: { maxWidth?: number; quality?: number }): Promise<NiResponse> {
  const params = new URLSearchParams();
  if (tabId) params.set('tabId', tabId);
  if (opts?.maxWidth !== undefined) params.set('maxWidth', String(opts.maxWidth));
  if (opts?.quality !== undefined) params.set('quality', String(opts.quality));
  const qs = params.size ? `?${params}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/screenshot-base64${qs}`);
}

// ── Advanced ──

export async function evaluate(sessionId: string, script: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/evaluate`, { script, ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

// Read-only structured state of the X/Twitter composer (quote card, submit button, modal,
// stale draft). The detection script lives server-side so the loop publish gate shares it.
export async function xComposeState(sessionId: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/x-compose-state`, { ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

// Upload a local image file to BlueSky as a blob, using the page's own session
// token. The Neural Interface reads the file from disk (the MCP page context
// can't), pulls accessJwt/pdsUrl from the bsky.app tab, and POSTs the bytes to
// com.atproto.repo.uploadBlob. Returns { ok, blob } (the AT Protocol blob ref).
export async function uploadBlueskyBlob(sessionId: string, filePath: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/bluesky/upload-blob`, { filePath, ...(tabId && { tabId }) }, LONG_TIMEOUT);
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

// ── Style Guide ──

export async function getStyleGuide(projectPath: string): Promise<NiResponse> {
  return request('GET', `/api/style-guide?projectPath=${encodeURIComponent(projectPath)}`);
}

export async function listProjects(): Promise<NiResponse> {
  return request('GET', '/api/projects');
}

// ── Image store ──

export async function listImages(): Promise<NiResponse> {
  return request('GET', '/api/images');
}

export async function deleteImage(filename: string): Promise<NiResponse> {
  return request('DELETE', `/api/images/${encodeURIComponent(filename)}`);
}

// ── YouTube trailer pipeline (sourcing + download + API) ──
// These delegate to the Neural Interface server, which holds the IGDB/Twitch
// token, the Steam proxy, the yt-dlp binary, and the YouTube OAuth credentials.

const DOWNLOAD_TIMEOUT = 600_000; // trailer downloads can be large/slow

/**
 * Discover candidate trailers. `source` selects the discovery backend:
 *   'igdb'  — query IGDB for games + Steam appid + YouTube trailer ids
 *   'steam' — resolve Steam appdetails movies[] for explicit appids/query
 *   'youtube' — search YouTube directly for recently published trailer videos
 *   'auto'  — IGDB discovery enriched with Steam mp4 URLs (default)
 */
export async function youtubeDiscover(body: {
  source?: 'igdb' | 'steam' | 'youtube' | 'auto';
  query?: string;
  appids?: number[];
  limit?: number;
  filters?: Record<string, unknown>;
}): Promise<NiResponse> {
  return request('POST', '/api/sources/discover', body as Record<string, unknown>, LONG_TIMEOUT);
}

/**
 * Download a trailer to disk. Prefers a direct Steam mp4 URL; falls back to
 * yt-dlp on a YouTube id/url. Returns `{ filePath, bytes, source }`.
 */
export async function youtubeDownload(body: {
  steamMp4Url?: string;
  ytId?: string;
  url?: string;
  appid?: number;
  outputDir?: string;
  filename?: string;
  quality?: string;
  useCookies?: boolean;
}): Promise<NiResponse> {
  return request('POST', '/api/youtube/download', body as Record<string, unknown>, DOWNLOAD_TIMEOUT);
}

export async function youtubeGetConfig(): Promise<NiResponse> {
  return request('GET', '/api/youtube/config');
}

export async function youtubeSetConfig(config: Record<string, unknown>): Promise<NiResponse> {
  return request('PUT', '/api/youtube/config', config);
}

/** Test configured credentials. `target`: 'youtube' | 'igdb' | 'steam' | 'all'. */
export async function youtubeTest(target?: string): Promise<NiResponse> {
  return request('POST', '/api/youtube/test', target ? { target } : {}, LONG_TIMEOUT);
}

/** Read-only analytics via the YouTube Data/Analytics API (OAuth). */
export async function youtubeAnalytics(body: {
  videoId?: string;
  channelId?: string;
  metrics?: string[];
  startDate?: string;
  endDate?: string;
}): Promise<NiResponse> {
  return request('POST', '/api/youtube/analytics', body as Record<string, unknown>, LONG_TIMEOUT);
}

// ── MoreLogin (anti-detect browser) — proxied to the Neural Interface ──

export async function moreloginStatus(): Promise<NiResponse> {
  return request('GET', '/api/morelogin/status', undefined, LONG_TIMEOUT);
}

export async function moreloginProfiles(): Promise<NiResponse> {
  return request('GET', '/api/morelogin/profiles', undefined, LONG_TIMEOUT);
}

export async function moreloginCreate(name?: string): Promise<NiResponse> {
  return request('POST', '/api/morelogin/profiles', name ? { name } : {}, LONG_TIMEOUT);
}

export async function moreloginStart(envId: string): Promise<NiResponse> {
  return request('POST', '/api/morelogin/start', { envId }, SESSION_CREATE_TIMEOUT);
}

export async function moreloginStop(envId: string): Promise<NiResponse> {
  return request('POST', '/api/morelogin/stop', { envId }, LONG_TIMEOUT);
}

export async function moreloginUseDefault(envId: string | null): Promise<NiResponse> {
  return request('POST', '/api/morelogin/use-default', envId ? { envId } : { clear: true });
}
