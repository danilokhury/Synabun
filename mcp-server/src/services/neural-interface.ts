/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  type CallerIdentity,
  getIdentity,
  effectivePins,
  terminalIdFor,
  callerRole,
  setReleaseHook,
  peekStdioIdentity,
  isHttpMode,
} from './identity.js';

const BASE_URL = process.env.NEURAL_INTERFACE_URL
  || `http://localhost:${process.env.NEURAL_PORT || '3344'}`;
const DEFAULT_TIMEOUT = 10_000;
const LONG_TIMEOUT = 30_000;
const SESSION_CREATE_TIMEOUT = 70_000;
// Existing engagement spacing can consume 90 seconds before the click begins.
const CLICK_TIMEOUT = 120_000;

export function isBrowserV2Enabled(): boolean {
  return process.env.SYNABUN_BROWSER_V2 !== '0';
}

type BrowserRoute = { sessionId: string; tabId?: string };
const resolvedRoutes = new WeakMap<CallerIdentity, { key: string; route: BrowserRoute; sessionId?: string; tabId?: string; autoCreate?: { url?: string }; platform?: boolean }>();
const resolutionRefresh = new AsyncLocalStorage<boolean>();
export interface BrowserBatchContext {
  route: BrowserRoute;
  errors: NiResponse[];
}
const browserCancellation = new AsyncLocalStorage<{ signal: AbortSignal; scope: 'browser' | 'batch' }>();
export function runWithBrowserCancellation<T>(signal: AbortSignal | undefined, run: () => T, scope: 'browser' | 'batch' = 'browser'): T {
  return signal ? browserCancellation.run({ signal, scope }, run) : run();
}
const batchContext = new AsyncLocalStorage<BrowserBatchContext>();
export function runBrowserBatchContext<T>(context: BrowserBatchContext, run: () => T): T {
  return batchContext.run(context, run);
}
/** Inside a browser_batch step. Browser assistance is off there: a batch is a known sequence. */
export function inBrowserBatch(): boolean {
  return batchContext.getStore() !== undefined;
}
/** The MCP caller's cancellation signal, so an advisory judgment ends with the tool call that asked for it. */
export function currentBrowserSignal(): AbortSignal | undefined {
  return browserCancellation.getStore()?.signal;
}

function browserMetric(record: Record<string, unknown>): void {
  if (process.env.SYNABUN_BROWSER_METRICS === '1') {
    console.error(JSON.stringify({ source: 'browser-client', ...record }));
  }
}

// Platform tools (BlueSky, X, Facebook, YouTube, …) always act on normal pages, so
// inside this scope resolution requires the default browser: an explicit session
// the server says does not serve it is dropped for the default one.
const platformRoute = new AsyncLocalStorage<boolean>();
export function withPlatformRoute<T>(run: () => T): T {
  return platformRoute.run(true, run);
}
function inPlatformRoute(): boolean {
  return platformRoute.getStore() === true;
}

// The default browser as the Neural Interface last described it (its
// X-Synabun-Browser-Default header on every /api/browser response: connect mode
// and MoreLogin env). Part of every route key, so a change of browser settings
// drops every cached route of this process; the server in-process calls
// noteBrowserDefault when the settings are saved.
let browserDefault = '';
export function noteBrowserDefault(signature: string | null | undefined): void {
  if (typeof signature === 'string' && signature !== browserDefault) browserDefault = signature;
}

function routeKey(id: CallerIdentity, sessionId?: string, tabId?: string, wantsDefaultBrowser = false): string {
  const pins = effectivePins(id);
  // Only an explicit id resolves differently for page-opening and platform calls
  // (resolveSessionUncached may drop it), so only then do they get their own slot.
  return JSON.stringify([sessionId, tabId, pins.browserSessionId, pins.browserTabId,
    id.state.ancestorPinnedSession, id.state.ancestorPinnedTab, sessionId ? wantsDefaultBrowser : null, browserDefault]);
}

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
  profileMode?: string;
  moreloginEnvId?: string | null;
  /** Server's verdict (sessionServesMoreLoginDefault): may this session carry normal
   *  pages? False only while MoreLogin is the default; absent on older servers. */
  servesDefault?: boolean;
}

export interface NiResponse {
  ok?: boolean;
  error?: string;
  tabRecovered?: boolean;
  sessionInvalidated?: boolean;
  [key: string]: unknown;
}

async function requestOnce(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT
): Promise<NiResponse> {
  const cancellation = browserCancellation.getStore();
  const callerSignal = cancellation?.signal;
  const cancellationCode = cancellation?.scope === 'batch' ? 'BATCH_CANCELLED' : 'BROWSER_CANCELLED';
  const cancellationLabel = cancellation?.scope === 'batch' ? 'Browser batch' : 'Browser request';
  if (callerSignal?.aborted) return { error: `${cancellationLabel} cancelled before the request started.`, code: cancellationCode, actionStarted: false };
  const requestId = randomUUID();
  const startedAt = performance.now();
  const deadline = Date.now() + timeout;
  let responseBytes = 0;
  let estimatedTextTokens = 0;
  let status: number | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) cancel();
  let sent = false;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Per-caller routing identity: the server maps this to the caller's owned
    // tab (_tabOwners) so tab-less browser calls never land on another
    // automation's tab. Derived per-request over HTTP, per-process for stdio.
    headers['X-Synabun-Terminal'] = terminalIdFor(getIdentity());
    // Assistant runtimes forward their role so /api/assistant/* can tell an
    // orchestrator apart from a worker run (workers must never dispatch).
    const role = callerRole();
    if (role) headers['X-Synabun-Role'] = role;
    headers['X-Synabun-Request-Id'] = requestId;
    headers['X-Synabun-Deadline'] = String(deadline);
    // Lets the server refuse advisory payloads and auto-heal for a batch step on its own authority.
    if (batchContext.getStore()) headers['X-Synabun-Batch'] = '1';
    const opts: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    if (callerSignal?.aborted) return { error: `${cancellationLabel} cancelled before the request started.`, code: cancellationCode, actionStarted: false };
    sent = true;
    const res = await fetch(`${BASE_URL}${path}`, opts);
    status = res.status;
    noteBrowserDefault(res.headers?.get?.('X-Synabun-Browser-Default'));
    const responseText = await res.text();
    const data = JSON.parse(responseText) as NiResponse;
    if (process.env.SYNABUN_BROWSER_METRICS === '1') {
      responseBytes = Buffer.byteLength(responseText, 'utf8');
      // Approximation, not provider-billed usage; exclude base64 image fields.
      const { image: _image, screenshot: _screenshot, data: _data, ...textFields } = data;
      estimatedTextTokens = Math.ceil(JSON.stringify(textFields).length / 4);
    }
    if (!res.ok && !data.error) {
      data.error = `HTTP ${res.status}`;
    }
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (callerSignal?.aborted) {
      return { error: `${cancellationLabel} cancelled; inspect the page before retrying.`, code: cancellationCode, ...(sent ? { outcome: 'uncertain' } : { actionStarted: false }) };
    }
    if (controller.signal.aborted || /abort/i.test(msg)) {
      return { error: `Request timed out after ${timeout}ms; outcome may be uncertain. Inspect the page before retrying.`, code: 'REQUEST_TIMEOUT', outcome: 'uncertain' };
    }
    return { error: `Neural Interface unreachable: ${msg}. Is the Neural Interface server running?`, code: 'TRANSPORT_ERROR', outcome: 'uncertain' };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
    if (path.startsWith('/api/browser/')) {
      browserMetric({ requestId, phase: 'http', method,
        operation: path.split('?')[0].replace(/\/sessions\/[^/]+/, '/sessions/:id'),
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status, responseBytes, estimatedTextTokens });
    }
  }
}

async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NiResponse> {
  const result = await requestOnce(method, path, body, timeout);
  const context = batchContext.getStore();
  const missingRoute = result.actionStarted === false
    && (result.code === 'SESSION_NOT_FOUND' || result.code === 'TAB_NOT_FOUND');
  const match = /^\/api\/browser\/sessions\/([^/?]+)\/(.+)$/.exec(path);
  if (isBrowserV2Enabled() && missingRoute && match) {
    const id = getIdentity();
    const cached = resolvedRoutes.get(id);
    resolvedRoutes.delete(id);
    // Batches are pinned to their original tab and never recover midway.
    const pinnedSession = effectivePins(id).browserSessionId || id.state.ancestorPinnedSession;
    if (!context && cached?.route.sessionId === match[1]
      && (!cached.sessionId || cached.sessionId === pinnedSession)) {
      // Clear unpinned fast-mode state too: a force-refresh must not reuse it.
      if (id.state.interactiveSessionId === match[1]) {
        id.state.interactiveSessionId = null;
        id.state.interactiveTabId = null;
      }
      if (id.state.affinitySessionId === match[1]) id.state.affinitySessionId = null;
      const refreshed = await resolutionRefresh.run(true, () => resolveSession(
        cached.sessionId, cached.autoCreate, cached.tabId, { platform: cached.platform === true },
      ));
      if (!('error' in refreshed)) {
        const nextPath = path.replace(`/sessions/${match[1]}/`, `/sessions/${refreshed.sessionId}/`);
        const nextBody = body ? { ...body, tabId: refreshed.tabId } : undefined;
        const url = new URL(nextPath, BASE_URL);
        if (refreshed.tabId) url.searchParams.set('tabId', refreshed.tabId);
        else url.searchParams.delete('tabId');
        return requestOnce(method, `${url.pathname}${url.search}`, nextBody, timeout);
      }
      // Recovery failed: report why (e.g. "MoreLogin connect failed: …"), not the
      // bare "Session not found" that triggered it. Nothing was started.
      return { ...result, error: refreshed.error, recoveryFailed: true };
    }
  }
  // The server refused a session that does not serve the default browser (the
  // settings changed under a cached route): forget it, so the next call resolves
  // the default browser. Not retried here: the page the call meant is in the other browser.
  if (result.code === 'NOT_DEFAULT_BROWSER' && match) {
    const id = getIdentity();
    resolvedRoutes.delete(id);
    if (id.state.interactiveSessionId === match[1]) {
      id.state.interactiveSessionId = null;
      id.state.interactiveTabId = null;
    }
    if (id.state.affinitySessionId === match[1]) id.state.affinitySessionId = null;
  }
  if (context && result.error) context.errors.push(result);
  else if (context && typeof result.snapshotError === 'string') {
    context.errors.push({ error: result.snapshotError, code: 'SNAPSHOT_FAILED' });
  }
  return result;
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

function adoptCreatedSession(id: CallerIdentity, created: NiResponse, tabId?: string): { sessionId: string; tabId?: string } {
  const sessionId = created.sessionId as string;
  id.state.affinitySessionId = sessionId;
  return { sessionId, tabId };
}

// Pages (localhost included) only run where the server says the default browser
// is. Absent servesDefault (older server, or a managed / real-Chrome setup) keeps
// the previous behavior.
function servesDefault(s: BrowserSessionInfo): boolean {
  return s.servesDefault !== false;
}
function describeSession(s: BrowserSessionInfo): string {
  return `${s.profileMode || 'unknown'} mode${s.moreloginEnvId ? `, MoreLogin env ${s.moreloginEnvId}` : ''}`;
}
function describeDefault(list: NiResponse): string {
  const def = list.defaultBrowser as { connectMode?: string | null; moreloginEnvId?: string | null } | undefined;
  if (def?.connectMode === 'morelogin') return `MoreLogin${def.moreloginEnvId ? ` env ${def.moreloginEnvId}` : ''}`;
  return 'the configured browser';
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

// SIGTERM / SIGINT end a stdio server here: release its tab, exit 0. Served
// over HTTP, the process belongs to its host. The Neural Interface runs
// mcp-server/dist in process and owns these signals (server.js
// gracefulShutdown: WhatsApp Link, terminal host, then the database); this
// listener is registered before its listeners, so exiting here would preempt
// all of them. The mode is read when the signal arrives, not at import:
// server.js loads this module through its static imports, long before
// createMcpRoutes() calls markHttpMode(). A host with no listener of its own
// (the standalone dist/http.js) still exits here, because registering this
// listener already took Node's default exit on the signal away from it.
function exitOnSignal(signal: 'SIGTERM' | 'SIGINT'): () => void {
  const onSignal = (): void => {
    if (isHttpMode() && process.listeners(signal).some((listener) => listener !== onSignal)) return;
    releaseOnExit();
    process.exit(0);
  };
  return onSignal;
}
process.once('SIGTERM', exitOnSignal('SIGTERM'));
process.once('SIGINT', exitOnSignal('SIGINT'));

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
async function resolveSessionUncached(
  sessionId?: string,
  autoCreate?: { url?: string },
  tabId?: string,
  platform = false,
): Promise<{ sessionId: string; tabId?: string } | { error: string }> {
  // Per-caller identity: pins come from launch headers (HTTP) or live env
  // (stdio); all caches below live on the identity, never module-level.
  const id = getIdentity();
  const pins = effectivePins(id);
  // Every page tool runs in the default browser only. An explicit id the server
  // says does not serve it (managed Chrome, or another MoreLogin env while
  // MoreLogin is the default) is dropped for a navigation (localhost included)
  // or a platform tool, and the default browser resolved instead; any other page
  // tool is refused, since the page it names is in the other browser. The
  // server refuses them too (NOT_DEFAULT_BROWSER).
  const wantsDefaultBrowser = platform || !!autoCreate;
  if (sessionId && sessionId !== (pins.browserSessionId || id.state.ancestorPinnedSession)) {
    const listed = await request('GET', '/api/browser/sessions');
    const named = ((listed.sessions || []) as BrowserSessionInfo[]).find(s => s.id === sessionId);
    if (named && !servesDefault(named)) {
      if (!wantsDefaultBrowser) {
        return { error: `Browser session ${sessionId} is not the default browser (${describeSession(named)}; the default is ${describeDefault(listed)}), so SynaBun's browser tools do not act on it. Leave sessionId out: browser_navigate opens the page in the default browser.` };
      }
      console.error(`[MCP] not using session ${sessionId} (${describeSession(named)}) — resolving ${describeDefault(listed)}`);
      sessionId = undefined;
      tabId = undefined;
    }
  }

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
    // A run's pinned browser must be the default one. Hard-fail rather than work
    // in the wrong browser.
    if (active && !servesDefault(active)) {
      return { error: `Pinned browser session ${pinnedSession} is not the default browser (${describeSession(active)}; the default is ${describeDefault(check)}), so this run will not use it. Start the run again so it acquires the default browser.` };
    }
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
    // Checked above against the default browser; the server 404s a session that
    // does not exist. The route cache spares the check on the next calls.
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
    if (alive && servesDefault(alive)) return { sessionId: id.state.interactiveSessionId, tabId: resolvedTabId || id.state.interactiveTabId || undefined };
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
    return adoptCreatedSession(id, created, resolvedTabId);
  }

  // List sessions (single GET used for both affinity check and auto-selection)
  const data = await request('GET', '/api/browser/sessions');
  if (data.error) return { error: data.error };
  const allSessions = (data.sessions || []) as BrowserSessionInfo[];

  // Check affinity — reuse session this caller previously used/created
  if (id.state.affinitySessionId) {
    const affinityAlive = allSessions.find(s => s.id === id.state.affinitySessionId);
    if (affinityAlive && servesDefault(affinityAlive)) {
      return { sessionId: id.state.affinitySessionId, tabId: resolvedTabId };
    }
    id.state.affinitySessionId = null; // session gone (or not the default browser), clear affinity
  }

  // Interactive sessions (no pinned env var) must not grab loop/agent/interactive-owned
  // sessions. Pinned sessions already returned above; explicit sessionId trusted above.
  // Never adopt or auto-select a browser that is not the default one for normal pages.
  const sessions = allSessions.filter(s => !s.loopOwned && !s.agentOwned && !s.interactiveOwned && servesDefault(s));

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
    return adoptCreatedSession(id, created, resolvedTabId);
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

/**
 * Per-caller route cache. Only the server can declare an action safe to retry.
 * `platform` (or a withPlatformRoute scope) marks a platform tool call: like a
 * navigation, it only runs in the default browser.
 */
export async function resolveSession(
  sessionId?: string,
  autoCreate?: { url?: string },
  tabId?: string,
  opts: { platform?: boolean } = {},
): Promise<BrowserRoute | { error: string }> {
  const context = batchContext.getStore();
  if (context) return context.route;
  const startedAt = performance.now();
  const id = getIdentity();
  const platform = opts.platform === true || inPlatformRoute();
  const key = routeKey(id, sessionId, tabId, platform || !!autoCreate);
  const cached = resolvedRoutes.get(id);
  if (isBrowserV2Enabled() && !resolutionRefresh.getStore() && cached?.key === key) {
    browserMetric({ phase: 'session-resolution', cached: true, durationMs: performance.now() - startedAt });
    return { ...cached.route };
  }
  const result = await resolveSessionUncached(sessionId, autoCreate, tabId, platform);
  if (!('error' in result)) resolvedRoutes.set(id, { key: routeKey(id, sessionId, tabId, platform || !!autoCreate), route: { ...result }, sessionId, tabId, autoCreate, platform });
  browserMetric({ phase: 'session-resolution', cached: false, durationMs: performance.now() - startedAt });
  return result;
}

/** Batches require a concrete tab owned by this caller, verified once up front. */
export async function resolveBatchRoute(sessionId?: string, tabId?: string): Promise<BrowserRoute | { error: string }> {
  const resolved = await resolveSession(sessionId, undefined, tabId);
  if ('error' in resolved) return resolved;
  const result = await listSessions();
  if (result.error) return { error: result.error };
  const session = (result.sessions as BrowserSessionInfo[] | undefined)?.find(s => s.id === resolved.sessionId);
  const id = getIdentity();
  const ownedTabs = [session?.tabOwners?.[terminalIdFor(id)], session?.tabOwners?.[id.clientId]].filter(Boolean);
  const ownedTab = resolved.tabId || ownedTabs[0];
  if (!ownedTab || !ownedTabs.includes(ownedTab)) {
    return { error: 'browser_batch requires a tab owned by this caller. Use browser_navigate to acquire a tab first.' };
  }
  return { sessionId: resolved.sessionId, tabId: ownedTab };
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
  snapshot?: 'diff' | 'full' | 'none',
  snapshotOptions?: { baselineId?: string; snapshotMaxChars?: number },
  assist?: { semanticContext?: boolean },
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/navigate`, {
    url,
    ...(isBrowserCompactMode() && { compact: true }),
    ...(snapshot && { snapshot }),
    ...(isBrowserV2Enabled() && { snapshotMaxChars: 12000 }),
    ...snapshotOptions,
    ...(returnSnapshot && { returnSnapshot }),
    ...(assist?.semanticContext && { semanticContext: true }),
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
  snapshot?: 'diff' | 'full' | 'none',
  snapshotOptions?: { baselineId?: string; snapshotMaxChars?: number },
  assist?: boolean,
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/click`, {
    ...(selector && { selector }),
    ...(ref && { ref }),
    ...(nthMatch !== undefined && { nthMatch }),
    ...(textHint && { textHint }),
    ...(assist && { assist: true }),
    ...(isBrowserCompactMode() && { compact: true }),
    ...(snapshot && { snapshot }),
    ...(isBrowserV2Enabled() && { snapshotMaxChars: 6000 }),
    ...snapshotOptions,
    ...(returnSnapshot && { returnSnapshot }),
    ...(tabId && { tabId }),
  }, CLICK_TIMEOUT);
}

export async function fill(sessionId: string, selector: string | undefined, value: string, nthMatch?: number, tabId?: string, textHint?: string, ref?: string, assist?: boolean): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/fill`, { ...(selector && { selector }), ...(ref && { ref }), value, ...(assist && { assist: true }), ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function type(sessionId: string, selector: string | null, text: string, nthMatch?: number, tabId?: string, textHint?: string, mode?: 'sequential' | 'insert' | 'paragraphs', ref?: string, assist?: boolean): Promise<NiResponse> {
  // An explicit mode (including 'paragraphs') is always honored; only the unset case falls back to fast-mode insert.
  const resolvedMode = mode || (isBrowserFastMode() ? 'insert' : 'sequential');
  return request('POST', `/api/browser/sessions/${sessionId}/type`, { selector, ...(ref && { ref }), text, mode: resolvedMode, ...(assist && { assist: true }), ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function hover(sessionId: string, selector: string | undefined, nthMatch?: number, tabId?: string, textHint?: string, ref?: string, assist?: boolean): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/hover`, { ...(selector && { selector }), ...(ref && { ref }), ...(assist && { assist: true }), ...(nthMatch !== undefined && { nthMatch }), ...(textHint && { textHint }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function selectOption(sessionId: string, selector: string | undefined, value: string, nthMatch?: number, tabId?: string, ref?: string, textHint?: string, assist?: boolean): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/select`, { ...(selector && { selector }), ...(ref && { ref }), value, ...(textHint && { textHint }), ...(assist && { assist: true }), ...(nthMatch !== undefined && { nthMatch }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function pressKey(sessionId: string, key: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/press`, { key, ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) });
}

export async function scroll(
  sessionId: string,
  opts: { direction: string; distance?: number; selector?: string; ref?: string; snapshot?: 'diff' | 'full' | 'none'; baselineId?: string; snapshotMaxChars?: number; returnSnapshot?: { mode?: string; selector?: string; viewport?: boolean } },
  tabId?: string
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/scroll`, { ...(isBrowserV2Enabled() && { snapshotMaxChars: 12000 }), ...opts, ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) } as Record<string, unknown>, LONG_TIMEOUT);
}

export async function upload(
  sessionId: string,
  selector: string | undefined,
  filePaths: string[],
  nthMatch?: number,
  tabId?: string,
  ref?: string,
  textHint?: string,
  assist?: boolean,
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/upload`, { ...(selector && { selector }), ...(ref && { ref }), filePaths, ...(textHint && { textHint }), ...(assist && { assist: true }), ...(nthMatch !== undefined && { nthMatch }), ...(isBrowserCompactMode() && { compact: true }), ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

// ── Observation ──

export async function snapshot(
  sessionId: string,
  selector?: string,
  tabId?: string,
  opts?: { mode?: string; viewport?: boolean; depth?: number; diff?: boolean; force?: boolean; maxChars?: number; baselineId?: string; includeFullText?: boolean }
): Promise<NiResponse> {
  const hasOpts = !!(opts && (opts.mode || opts.viewport || opts.depth || opts.diff || opts.force || opts.maxChars || opts.baselineId || opts.includeFullText));
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
      ...(opts?.baselineId && { baselineId: opts.baselineId }),
      // Intent ranking parses every ref of this capture even when only a diff is shown; never a second capture.
      ...(opts?.includeFullText && { includeFullText: true }),
      ...(tabId && { tabId }),
    }, LONG_TIMEOUT);
  }
  const qs = tabId ? `?tabId=${tabId}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/snapshot${qs}`);
}

export async function getContent(sessionId: string, tabId?: string, opts?: { maxChars?: number; offset?: number; selector?: string }): Promise<NiResponse> {
  const params = new URLSearchParams();
  if (tabId) params.set('tabId', tabId);
  if (opts?.maxChars) params.set('maxChars', String(opts.maxChars));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.selector) params.set('selector', opts.selector);
  const qs = params.size ? `?${params}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/content${qs}`);
}

export async function getMarkdown(sessionId: string, tabId?: string, opts?: { maxChars?: number; offset?: number; selector?: string }): Promise<NiResponse> {
  const params = new URLSearchParams();
  if (tabId) params.set('tabId', tabId);
  if (opts?.maxChars) params.set('maxChars', String(opts.maxChars));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.selector) params.set('selector', opts.selector);
  const qs = params.size ? `?${params}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/markdown${qs}`, undefined, LONG_TIMEOUT);
}

export async function fetchMarkdown(url: string, timeout?: number): Promise<NiResponse> {
  return request('POST', '/api/fetch-markdown', { url, timeout }, LONG_TIMEOUT);
}

export interface ScreenshotOptions {
  maxWidth?: number;
  quality?: number;
  /** Viewport size for this capture only (CDP device metrics, cleared right after). */
  width?: number;
  height?: number;
  fullPage?: boolean;
  format?: 'png' | 'jpeg';
  save?: boolean;
  path?: string;
}

export async function screenshot(sessionId: string, tabId?: string, opts?: ScreenshotOptions): Promise<NiResponse> {
  const params = new URLSearchParams();
  if (tabId) params.set('tabId', tabId);
  if (opts?.maxWidth !== undefined) params.set('maxWidth', String(opts.maxWidth));
  if (opts?.quality !== undefined) params.set('quality', String(opts.quality));
  if (opts?.width !== undefined) params.set('width', String(opts.width));
  if (opts?.height !== undefined) params.set('height', String(opts.height));
  if (opts?.fullPage) params.set('fullPage', '1');
  if (opts?.format) params.set('format', opts.format);
  if (opts?.save) params.set('save', '1');
  if (opts?.path) params.set('path', opts.path);
  const qs = params.size ? `?${params}` : '';
  // A resized or full-page capture (and a saved file) takes longer than a plain one.
  return request('GET', `/api/browser/sessions/${sessionId}/screenshot-base64${qs}`, undefined, LONG_TIMEOUT);
}

/** The tab's buffered console messages and page errors (browser_console). */
export async function consoleMessages(
  sessionId: string,
  tabId?: string,
  opts?: { level?: string; since?: string; limit?: number; clear?: boolean },
): Promise<NiResponse> {
  const params = new URLSearchParams();
  if (tabId) params.set('tabId', tabId);
  if (opts?.level) params.set('level', opts.level);
  if (opts?.since) params.set('since', opts.since);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts?.clear) params.set('clear', '1');
  const qs = params.size ? `?${params}` : '';
  return request('GET', `/api/browser/sessions/${sessionId}/console${qs}`);
}

// ── Advanced ──

export async function evaluate(sessionId: string, script: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/evaluate`, { script, ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

export interface BrowserExtractOptions {
  scrolls?: number;
  minItems?: number;
  maxItems?: number;
  dedupeKeys: string[];
  scrollTarget?: string;
  scrollDistance?: number;
  scrollDirection?: 1 | -1;
  settleMs?: number;
  scrollIfEmpty?: boolean;
  fields?: string[];
  maxChars?: number;
  timeoutMs?: number;
}

export async function extract(sessionId: string, script: string, tabId: string | undefined, opts: BrowserExtractOptions): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/extract`, {
    script, ...opts, ...(tabId && { tabId }),
  }, Math.min(30_000, opts.timeoutMs || 15_000) + 2_000);
}

// Read-only structured state of the X/Twitter composer (quote card, submit button, modal,
// stale draft). The detection script lives server-side so the loop publish gate shares it.
export async function xComposeState(sessionId: string, tabId?: string): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/x-compose-state`, { ...(tabId && { tabId }) }, LONG_TIMEOUT);
}

// ── Browser assistance (read-only context; the judgments run in this process, never in the Neural Interface) ──

/** Bounded, value-free description of the current page. Read-only: safe to call after any outcome. */
export async function semanticContext(
  sessionId: string,
  tabId?: string,
  opts?: { purpose?: 'page-state' | 'empty-extractor' | 'social' | 'batch'; scope?: string; social?: boolean },
): Promise<NiResponse> {
  return request('POST', `/api/browser/sessions/${sessionId}/semantic-context`, {
    ...(opts?.purpose && { purpose: opts.purpose }),
    ...(opts?.scope && { scope: opts.scope }),
    ...(opts?.social && { social: true }),
    ...(tabId && { tabId }),
  }, 6000);
}

/**
 * The one auto-heal click. It names a candidate inside a context the server
 * minted after a click it confirmed never started; the selector and the
 * fingerprint stay on the server. Deliberately `requestOnce`: route recovery
 * could re-issue this on another tab, and a heal is never sent twice.
 */
export async function clickAutoHeal(
  sessionId: string,
  tabId: string | undefined,
  pick: { contextId: string; candidateId: string },
  snapshot?: 'diff' | 'full' | 'none',
): Promise<NiResponse> {
  return requestOnce('POST', `/api/browser/sessions/${sessionId}/click`, {
    autoHeal: { contextId: pick.contextId, candidateId: pick.candidateId },
    ...(isBrowserCompactMode() && { compact: true }),
    ...(snapshot && { snapshot }),
    ...(isBrowserV2Enabled() && { snapshotMaxChars: 6000 }),
    ...(tabId && { tabId }),
  }, 15_000);
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

/** Read the board. `images: false` asks the server to replace image dataUrls
 *  with their byte size (the tools never need the base64 payload). */
export async function getWhiteboard(opts: { images?: boolean } = {}): Promise<NiResponse> {
  return request('GET', opts.images === false ? '/api/whiteboard?images=0' : '/api/whiteboard');
}

export async function addWhiteboardElements(
  elements: Record<string, unknown>[],
  coordMode?: string,
  layout?: string
): Promise<NiResponse> {
  return request('POST', '/api/whiteboard/elements', { elements, coordMode, layout } as Record<string, unknown>);
}

/** Atomic update/remove ops (one save, one broadcast, per-op results). */
export async function batchWhiteboardOps(
  ops: Record<string, unknown>[],
  coordMode?: string
): Promise<NiResponse> {
  return request('POST', '/api/whiteboard/elements/batch', { ops, coordMode } as Record<string, unknown>);
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

export async function whiteboardScreenshot(opts: { crop?: string } = {}): Promise<NiResponse> {
  const query = opts.crop === 'usable' ? '?crop=usable' : '';
  return request('GET', `/api/whiteboard/screenshot${query}`, undefined, 15_000);
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

// `projectPath` is any path inside a registered project; the server resolves it to the project root.
function styleGuideQuery(params: Record<string, string | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, value);
  return query.toString();
}

export async function getStyleGuide(projectPath: string): Promise<NiResponse> {
  return request('GET', `/api/style-guide?${styleGuideQuery({ projectPath })}`);
}

/** The compact text agents get: { summary, tokensEstimate, saved, revision, projectPath }. */
export async function getStyleGuideSummary(projectPath: string, taskClass?: string): Promise<NiResponse> {
  return request('GET', `/api/style-guide/summary?${styleGuideQuery({ projectPath, taskClass })}`);
}

/** One export format as text: { format, contentType, filename, text, revision }. */
export async function getStyleGuideExport(projectPath: string, format: string, theme?: string): Promise<NiResponse> {
  return request('GET', `/api/style-guide/export?${styleGuideQuery({ projectPath, format, theme, as: 'json' })}`);
}

/** Write the project's artifacts now: { written: [{ format, path, changed }] }. */
export async function writeStyleGuideExports(projectPath: string, formats?: string[]): Promise<NiResponse> {
  return request('POST', '/api/style-guide/export', { projectPath, ...(formats?.length ? { formats } : {}) });
}

/** WCAG ratio + APCA for two colors (or aliases, with a project): { ratio, aa, aaa, aaLarge, apca, fg, bg }. */
export async function styleGuideContrast(body: { fg: string; bg: string; size?: string; projectPath?: string; theme?: string }): Promise<NiResponse> {
  return request('POST', '/api/style-guide/contrast', body);
}

/** An agent's only write to a guide: a merge patch the user accepts or rejects. { id, pending, ignored, diff } */
export async function proposeStyleGuideChange(body: { projectPath: string; changes: Record<string, unknown>; reason: string; runId?: string; provider?: string; model?: string }): Promise<NiResponse> {
  const identity = getIdentity();
  const runId = effectivePins(identity).terminalSessionId || identity.state.ancestorPinnedTerminal;
  return request('POST', '/api/style-guide/proposals', { ...(!body.runId && runId ? { runId } : {}), ...body });
}

/** The project's proposals (a bare array on success). */
export async function listStyleGuideProposals(projectPath: string, status?: string): Promise<NiResponse> {
  return request('GET', `/api/style-guide/proposals?${styleGuideQuery({ projectPath, status })}`);
}

/** Registered projects with their guide's status (a bare array on success). */
export async function listStyleGuideProjects(): Promise<NiResponse> {
  return request('GET', '/api/style-guide/projects');
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

// ── SynaBun assistant orchestration (role-gated `agents` tool group) ──
// Thin proxies over /api/assistant/* (neural-interface/lib/assistant-api.js),
// which owns dispatch state, rails and authorization. requestOnce already
// sends X-Synabun-Terminal (the assistant pin) and X-Synabun-Role.

export type AssistantProvider = 'claude-code' | 'codex' | 'opencode';

export type AssistantDispatchBody = {
  /** Optional when routeId names an approved route (the server applies it). */
  provider?: AssistantProvider;
  task: string;
  cwd: string;
  assistantSessionId: string;
  model?: string;
  effort?: string;
  mcpProfile?: string;
  routeId?: string;
  taskClass?: string;
  confidence?: number;
  usesComputer?: boolean;
  agent?: string;
  accountId?: string;
  codexAccountId?: string;
  claudeAccountId?: string;
  permissionPolicy?: 'auto' | 'ask' | 'restricted';
  capability?: 'read-only' | 'workspace' | 'full';
  maxMinutes?: number;
  budgetUsd?: number;
  usesBrowser?: boolean;
  focus?: boolean;
  title?: string;
  context?: string;
  tags?: string[];
  workflowId?: string;
  parentRunId?: string;
  outputSchema?: Record<string, unknown>;
  idempotencyKey?: string;
  briefId?: string;
  independent?: boolean;
};

// A dispatch may acquire a browser tab before the run is accepted.
const ASSISTANT_DISPATCH_TIMEOUT = 90_000;
// Long-poll waits block server-side for up to timeoutMs; the HTTP deadline
// must always outlive them so a timed-out wait is reported by the server.
const ASSISTANT_WAIT_MARGIN_MS = 15_000;

function assistantRunPath(runId: string, suffix = ''): string {
  return `/api/assistant/runs/${encodeURIComponent(runId)}${suffix}`;
}

function queryString(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const rendered = qs.toString();
  return rendered ? `?${rendered}` : '';
}

export async function assistantCatalog(opts: { provider?: string; search?: string } = {}): Promise<NiResponse> {
  return request('GET', `/api/assistant/catalog${queryString({ view: 'brain', provider: opts.provider, q: opts.search })}`, undefined, LONG_TIMEOUT);
}

// agent_route may show the user a route card and wait for the answer; the
// server caps its own wait below this deadline (X-Synabun-Deadline).
const ASSISTANT_ROUTE_TIMEOUT = 115_000;

export async function assistantRoute(body: {
  assistantSessionId: string;
  task_class: string;
  summary: string;
  confidence: number;
  needs_vision?: boolean;
  proposals: Array<{ kind: 'direct' | 'dispatch'; provider?: string; model?: string; effort?: string; reason?: string }>;
  independent?: boolean;
}): Promise<NiResponse> {
  return request('POST', '/api/assistant/route', body as unknown as Record<string, unknown>, ASSISTANT_ROUTE_TIMEOUT);
}

// agent_clarify shows the user a question card and waits briefly for the
// answers; like agent_route, the server caps its wait below this deadline.
export async function assistantClarify(body: {
  assistantSessionId: string;
  summary: string;
  questions: Array<{ id?: string; header?: string; question: string; options: Array<{ label: string; description?: string }>; multi_select?: boolean }>;
  constraints?: string[];
  assumptions?: string[];
}): Promise<NiResponse> {
  return request('POST', '/api/assistant/clarify', body as unknown as Record<string, unknown>, ASSISTANT_ROUTE_TIMEOUT);
}

export async function assistantListRuns(opts: { activeOnly?: boolean; assistantSessionId?: string; workflowId?: string } = {}): Promise<NiResponse> {
  return request('GET', `/api/assistant/runs${queryString({
    active: opts.activeOnly ? 1 : undefined,
    assistantSessionId: opts.assistantSessionId,
    workflowId: opts.workflowId,
  })}`);
}

/** Usage of one task ("current", an id) or the session ("all"); `runId` with "all" adds that run's totals over its tasks. */
export async function assistantUsage(assistantSessionId: string, task = 'current', runId?: string): Promise<NiResponse> {
  return request('GET', `/api/assistant/sessions/${encodeURIComponent(assistantSessionId)}/usage${queryString({ task, run: runId })}`);
}

export async function assistantDispatch(body: AssistantDispatchBody): Promise<NiResponse> {
  return request('POST', '/api/assistant/dispatch', body, ASSISTANT_DISPATCH_TIMEOUT);
}

export async function assistantRun(runId: string): Promise<NiResponse> {
  return request('GET', assistantRunPath(runId));
}

export async function assistantResult(runId: string): Promise<NiResponse> {
  return request('GET', assistantRunPath(runId, '/result'));
}

export async function assistantTranscript(runId: string, opts: { format?: string; tail?: number; maxChars?: number } = {}): Promise<NiResponse> {
  return request('GET', assistantRunPath(runId, `/transcript${queryString({ format: opts.format, tail: opts.tail, maxChars: opts.maxChars })}`), undefined, LONG_TIMEOUT);
}

export async function assistantSend(runId: string, body: { text: string; queue?: boolean }): Promise<NiResponse> {
  return request('POST', assistantRunPath(runId, '/send'), body, LONG_TIMEOUT);
}

export async function assistantPermission(runId: string, body: { requestId: string; behavior: 'allow' | 'deny'; answers?: Record<string, unknown>; message?: string }): Promise<NiResponse> {
  return request('POST', assistantRunPath(runId, '/permission'), body, LONG_TIMEOUT);
}

export async function assistantWaitRun(runId: string, opts: { until?: string; timeoutMs: number }): Promise<NiResponse> {
  return request('GET', assistantRunPath(runId, `/wait${queryString({ until: opts.until, timeout: opts.timeoutMs })}`), undefined, opts.timeoutMs + ASSISTANT_WAIT_MARGIN_MS);
}

export async function assistantWaitMany(body: { runIds?: string[]; workflowId?: string; mode?: string; until?: string; timeoutMs: number }): Promise<NiResponse> {
  return request('POST', '/api/assistant/wait', body, body.timeoutMs + ASSISTANT_WAIT_MARGIN_MS);
}

export async function assistantStop(runId: string, reason?: string): Promise<NiResponse> {
  return request('POST', assistantRunPath(runId, '/stop'), reason ? { reason } : {}, LONG_TIMEOUT);
}

export async function assistantKillAll(body: { assistantSessionId?: string; workflowId?: string; reason?: string } = {}): Promise<NiResponse> {
  return request('POST', '/api/assistant/kill-all', body, LONG_TIMEOUT);
}

export async function assistantFocus(runId: string, focus: boolean): Promise<NiResponse> {
  return request('POST', assistantRunPath(runId, '/focus'), { focus });
}
