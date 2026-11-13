/**
 * HTTP client for communicating with the Neural Interface Express server.
 * The MCP server delegates all browser operations to the Neural Interface
 * which manages Playwright sessions, CDP screencast, stealth, etc.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { BrowserRouteLost, currentRouteFlow, noteRouteReplaced, type RouteLoss, type RouteRef } from './browser-route-flow.js';

import {
  type CallerIdentity,
  getIdentity,
  effectivePins,
  terminalIdFor,
  terminalHeaders,
  callerBrainCredential,
  callerRole,
  setReleaseHook,
  peekStdioIdentity,
  isHttpMode,
} from './identity.js';

const BASE_URL = process.env.NEURAL_INTERFACE_URL
  || `http://localhost:${process.env.NEURAL_PORT || '3344'}`;
const DEFAULT_TIMEOUT = 10_000;
const LONG_TIMEOUT = 30_000;
// A browser start (create, acquire, a run's recovery) is answered by the server within its request budget
// (neural-interface/lib/browser-execution.js BROWSER_REQUEST_MAX_MS, 120 s): the session, or BROWSER_STARTING while a
// cold MoreLogin start is still running (it can wait two minutes for the app), with the start kept for this caller's
// next request (lib/browser-start-handoff.js). This waits longer than that budget, so the answer read is the server's,
// never a timeout of its own that left the start running unseen (70 s before 2026-11-04).
const SESSION_CREATE_TIMEOUT = 150_000;

/**
 * What an agent does when its browser session or tab is gone and no replacement was made for it: the rule of the
 * browser policy (neural-interface/lib/browser-tool-policy.js browserSessionLossRule), in the answer itself.
 */
export const LOST_ROUTE_HINT = 'Call browser_session with action "create" to open a new browser tab and continue there (pass its sessionId and tabId from then on, if you pass ids); only if that fails too, stop and report it. Never switch to another browser or tool.';

/** The server answered that the browser is still starting (lib/browser-start-handoff.js): nothing failed. */
export function isBrowserStarting(result: NiResponse | null | undefined): boolean {
  return !!result && (result.starting === true || result.code === 'BROWSER_STARTING');
}

/**
 * browser_navigate's own session (auto-create) while the browser is still starting: nothing failed, and the server keeps
 * that start for this caller, so the next call gets it (never a second browser). Before 2026-11-04 this read
 * "Failed to auto-create session: …" and agents gave up or reached for another browser.
 */
export const AUTO_CREATE_STARTING = 'The browser is still starting (a cold MoreLogin start can take about two minutes); nothing failed. Call browser_navigate again in a moment: it opens the page in that browser as soon as it is ready and never starts a second one.';

/** A route, or why there is none (`starting`: the browser is still starting, not a failure). */
type RouteOrError = { sessionId: string; tabId?: string } | { error: string; starting?: boolean };
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
  /** The server closed this wedged tab (and kept its session, which other runs use): the next call gets a new tab. */
  wedgedTabRetired?: boolean;
  /** The session or tab the request named was gone, and request() sent it to this replacement route instead.
   *  A caller that holds a session id across several requests must use this route from now on. */
  rerouted?: { sessionId: string; tabId: string | null };
  [key: string]: unknown;
}

async function requestOnce(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
  extraHeaders: Record<string, string> = {},
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
    // A run's pin travels with its terminal token (X-Synabun-Terminal-Token),
    // without which the browser routes refuse to act as that run.
    Object.assign(headers, terminalHeaders(getIdentity()));
    // Assistant runtimes forward their role so /api/assistant/* can tell an
    // orchestrator apart from a worker run (workers must never dispatch).
    const role = callerRole();
    if (role) headers['X-Synabun-Role'] = role;
    // A brain whose pin no session resolves (the Codex brain's MCP child, codex-sp-<uuid>) is known to
    // /api/assistant/* by its launch credential: the role header alone names nobody there. Sent with the
    // assistant role on those routes only; a worker has no role and no credential (its environment is stripped).
    if (role === 'assistant' && path.startsWith('/api/assistant/')) {
      const credential = callerBrainCredential();
      if (credential) headers['X-Synabun-Brain-Token'] = credential;
    }
    headers['X-Synabun-Request-Id'] = requestId;
    headers['X-Synabun-Deadline'] = String(deadline);
    // Lets the server refuse advisory payloads and auto-heal for a batch step on its own authority.
    if (batchContext.getStore()) headers['X-Synabun-Batch'] = '1';
    // One request's own headers (whatsappSendFile's brain credential, the skills requests'): sent on that request only.
    for (const [name, value] of Object.entries(extraHeaders)) if (value) headers[name] = value;
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
    // The system's own code for it (fetch puts it on `cause`): ECONNREFUSED means the request never left.
    const cause = (err as { cause?: { code?: unknown }; code?: unknown } | null)?.cause?.code ?? (err as { code?: unknown } | null)?.code ?? /\b(E[A-Z_]{3,})\b/.exec(msg)?.[1];
    return { error: `Neural Interface unreachable: ${msg}. Is the Neural Interface server running?`, code: 'TRANSPORT_ERROR', outcome: 'uncertain', ...(typeof cause === 'string' ? { transportCode: cause } : {}) };
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

/** A browser request the server refused before starting anything, because its session or tab is gone. */
export function isMissingRoute(result: NiResponse | null | undefined): boolean {
  return !!result && result.actionStarted === false
    && (result.code === 'SESSION_NOT_FOUND' || result.code === 'TAB_NOT_FOUND');
}

/**
 * `recover: false` — a missing session or tab is answered as it is, never sent on to a replacement route: for a
 * caller that must prepare a page before it runs something there (a Bluesky script needs a bsky.app document, a
 * replacement tab is about:blank) and recovers by itself (refreshSession).
 */
async function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
  opts: { recover?: boolean } = {},
): Promise<NiResponse> {
  const match = /^\/api\/browser\/sessions\/([^/?]+)\/(.+)$/.exec(path);
  // A tool call whose page was lost runs nothing more on a tab (browser-route-flow.ts): a later step would run on
  // the blank replacement and answer for a page that is not there.
  const flow = currentRouteFlow();
  const guarded = !!flow && flow.policy !== 'follow' && !!match;
  if (guarded && flow!.loss) throw new BrowserRouteLost(flow!.loss);
  const result = await requestOnce(method, path, body, timeout);
  const context = batchContext.getStore();
  const missingRoute = isMissingRoute(result);
  const routeOf = (): RouteLoss['from'] => {
    const tabId = typeof body?.tabId === 'string' ? body.tabId : new URL(path, BASE_URL).searchParams.get('tabId');
    return { sessionId: match![1], tabId: tabId || null };
  };
  const stepOf = () => match![2].split('?')[0];
  if (guarded && !context && result.error
    && (result.tabRecovered === true || result.wedgedTabRetired === true || result.sessionInvalidated === true)) {
    // The step failed and the server reset the wedged page to about:blank under the same tab id, or closed the tab
    // or the session: the page is gone. (A screenshot that worked can retire its tab too: it keeps its answer, and
    // the next step finds the tab gone.)
    flow!.loss = { reason: result.tabRecovered === true ? 'reset' : 'retired', step: stepOf(), from: routeOf() };
    throw new BrowserRouteLost(flow!.loss);
  }
  if (isBrowserV2Enabled() && missingRoute && match && opts.recover !== false) {
    const id = getIdentity();
    const cached = resolvedRoutes.get(id);
    resolvedRoutes.delete(id);
    // Batches are pinned to their original tab and never recover midway.
    const pinnedSession = effectivePins(id).browserSessionId || id.state.ancestorPinnedSession;
    // The run's pinned session, or the one its route moved to (a recovery, its own browser_session create), named by
    // hand: both are the run's own route, recovered the same way.
    if (!context && cached?.route.sessionId === match[1]
      && (!cached.sessionId || cached.sessionId === pinnedSession
        || (!!pinnedSession && cached.sessionId === id.state.recoveredSessionId))) {
      // The route that failed: the replacement's notice names it (announceReplacement).
      id.state.lostRoute = routeOf();
      // Clear unpinned fast-mode state too: a force-refresh must not reuse it.
      if (id.state.interactiveSessionId === match[1]) {
        id.state.interactiveSessionId = null;
        id.state.interactiveTabId = null;
      }
      if (id.state.affinitySessionId === match[1]) id.state.affinitySessionId = null;
      const refreshed = await resolutionRefresh.run(true, () => resolveSession(
        cached.sessionId, cached.autoCreate, cached.tabId, { platform: cached.platform === true },
      ));
      if (!('error' in refreshed) && guarded) {
        // The replacement tab is ready for the next call; this call stops here (or runs again from the start).
        const from = routeOf();
        const replaced = refreshed.sessionId !== from.sessionId || (refreshed.tabId || null) !== from.tabId;
        flow!.loss = { reason: 'gone', step: stepOf(), from, ...(replaced && { to: { sessionId: refreshed.sessionId, tabId: refreshed.tabId || null } }) };
        throw new BrowserRouteLost(flow!.loss);
      }
      if (!('error' in refreshed)) {
        const nextPath = path.replace(`/sessions/${match[1]}/`, `/sessions/${refreshed.sessionId}/`);
        const nextBody = body ? { ...body, tabId: refreshed.tabId } : undefined;
        const url = new URL(nextPath, BASE_URL);
        if (refreshed.tabId) url.searchParams.set('tabId', refreshed.tabId);
        else url.searchParams.delete('tabId');
        const retried = await requestOnce(method, `${url.pathname}${url.search}`, nextBody, timeout);
        // Say where it went: a tool that keeps the old session id for its next request would get "Session not
        // found" there (bluesky.ts probed the replacement tab, then navigated the closed session, 2026-11-04).
        const rerouted = { sessionId: refreshed.sessionId, tabId: refreshed.tabId || null };
        if (flow) flow.rerouted = rerouted;
        // The call ran on the replacement: its answer starts with a notice (once; resolution may have raised it).
        announceReplacement(id, rerouted, routeOf());
        return { ...retried, rerouted };
      }
      // Recovery failed: report why (e.g. "MoreLogin connect failed: …"), not the
      // bare "Session not found" that triggered it. Nothing was started.
      const starting = (refreshed as { starting?: boolean }).starting === true;
      if (guarded) {
        // Every later step of this tool would find the same dead route: the call stops here and says what happened
        // (routeLossMessage: still starting, or create a tab of your own).
        // The loss message says what to do; the hint the recovery's error carries would say it twice.
        const why = refreshed.error.replace(`\n${LOST_ROUTE_HINT}`, '').trim();
        flow!.loss = { reason: 'gone', step: stepOf(), from: routeOf(), recovery: { error: why, ...(starting && { starting: true }) } };
        throw new BrowserRouteLost(flow!.loss);
      }
      return { ...result, error: refreshed.error, recoveryFailed: true, ...(starting && { starting: true }) };
    }
  }
  if (guarded && !context && missingRoute && opts.recover !== false) {
    // Gone, and not a route this caller resolved (a session id named by hand, v2 off): no replacement here; the
    // call stops instead of polling a tab that does not exist until its own timeout.
    flow!.loss = { reason: 'gone', step: stepOf(), from: routeOf() };
    throw new BrowserRouteLost(flow!.loss);
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
  // Gone, and nothing replaced it here (a batch, a session named by hand, v2 off): the answer says what to do, so the
  // agent opens a new tab instead of giving up or reaching for another browser. A caller that recovers by itself
  // (recover: false) gets the refusal as it is.
  const answered = missingRoute && opts.recover !== false
    ? { ...result, error: `${result.error || 'The browser session or tab is gone'}. ${LOST_ROUTE_HINT}` }
    : result;
  if (context && answered.error) context.errors.push(answered);
  else if (context && typeof answered.snapshotError === 'string') {
    context.errors.push({ error: answered.snapshotError, code: 'SNAPSHOT_FAILED' });
  }
  return answered;
}

/**
 * Best-effort reconciliation for an MCP runtime that changed its own tools
 * (tool_groups). Only runtimes SynaBun launched carry a terminal pin (the
 * stdio child's SYNABUN_TERMINAL_SESSION, an HTTP session's X-Synabun-Terminal);
 * any other runtime stays local without contacting the Neural Interface, which
 * derives the owning runtime from that pin and never from the body.
 */
export type RuntimeToolsReport = {
  reported: boolean;
  hostRefresh: 'scheduled' | 'notification' | 'not-needed' | 'unavailable';
  runtimeKind?: 'opencode' | 'codex' | 'loop' | 'channel';
  correlationId?: string;
  /** The route that took it: runtime-profile is a Neural Interface from before tool lists. */
  route?: 'runtime-tools' | 'runtime-profile';
  error?: string;
};

const RUNTIME_REPORT_TIMEOUT = 2_000;

/** One report: its status and its JSON body, or null for a body that is not JSON (a route the server does not have). */
async function postRuntimeReport(path: string, body: Record<string, unknown>): Promise<{ status: number; json: NiResponse | null; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNTIME_REPORT_TIMEOUT);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...terminalHeaders(getIdentity()) };
    const role = callerRole();
    if (role) headers['X-Synabun-Role'] = role;
    const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    const text = await res.text();
    let json: NiResponse | null = null;
    try {
      const parsed = JSON.parse(text);
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as NiResponse : null;
    } catch { /* not JSON */ }
    return { status: res.status, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 0, json: null, error: controller.signal.aborted ? `Runtime tools report timed out after ${RUNTIME_REPORT_TIMEOUT}ms` : `Neural Interface unreachable: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function reportRuntimeTools(
  groups: readonly string[],
  options: { mode: 'strict' | 'focus'; legacyProfile: string; refresh?: 'in-band' },
): Promise<RuntimeToolsReport> {
  if (!effectivePins(getIdentity()).terminalSessionId) {
    return { reported: false, hostRefresh: 'notification' };
  }
  let route: 'runtime-tools' | 'runtime-profile' = 'runtime-tools';
  let answer = await postRuntimeReport('/api/mcp/runtime-tools', { tools: [...groups], mode: options.mode, ...(options.refresh ? { refresh: options.refresh } : {}) });
  // A Neural Interface from before tool lists has no such route (its 404 is not JSON); its own route takes the
  // old shape. Its runtime-profile 404 for a runtime that is gone is JSON, so it is never retried.
  if (answer.status === 404 && !answer.json) {
    route = 'runtime-profile';
    answer = await postRuntimeReport('/api/mcp/runtime-profile', {
      profile: options.legacyProfile,
      catalogMode: options.mode === 'focus' ? 'deferred' : 'profiled',
    });
  }
  const result = answer.json;
  if (result?.ok && answer.status >= 200 && answer.status < 300) {
    const hostRefresh = result.hostRefresh === 'scheduled'
      || result.hostRefresh === 'notification'
      || result.hostRefresh === 'not-needed'
      ? result.hostRefresh
      : 'unavailable';
    const runtimeKind = result.runtimeKind === 'opencode' || result.runtimeKind === 'codex' || result.runtimeKind === 'loop' || result.runtimeKind === 'channel'
      ? result.runtimeKind
      : undefined;
    return {
      reported: true,
      hostRefresh,
      runtimeKind,
      correlationId: typeof result.correlationId === 'string' ? result.correlationId : undefined,
      route,
    };
  }
  return {
    reported: false,
    hostRefresh: 'unavailable',
    route,
    error: typeof result?.error === 'string' ? result.error : (answer.error || `Runtime tools report failed (HTTP ${answer.status})`),
  };
}

// All per-caller identity state (recovery cache, session affinity, interactive
// tab cache, ancestor-PID pins) lives on the CallerIdentity object resolved by
// getIdentity() — per HTTP caller over the HTTP transport, a per-process
// singleton for stdio. Module-level versions of this state were the root cause
// of cross-automation tab collisions: every HTTP caller shared them.

// Join the ONE shared browser with a dedicated, owned tab (instead of launching a
// second browser on a persistent profile, which fails with "profile is locked").
async function acquireInteractive(id: CallerIdentity, url?: string): Promise<RouteOrError> {
  // The tab is owned by the id this caller routes as (X-Synabun-Terminal): the server checks an explicit tab against
  // that header, so a tab filed under the process's client id was refused to a run with a terminal pin and no browser
  // pin (a native run without a browser, a brain's MCP child) as "another owner's".
  const resp = await request('POST', '/api/browser/acquire', {
    clientId: terminalIdFor(id),
    url: url || 'about:blank',
  }, SESSION_CREATE_TIMEOUT);
  // Still starting (a cold MoreLogin start): nothing failed, and the tab is kept for this caller's next request.
  if (isBrowserStarting(resp)) return { error: String(resp.error || 'The browser is still starting. Call the browser tool again in a moment.'), starting: true };
  if (resp.error || !resp.sessionId) {
    return { error: `Failed to acquire a shared browser tab: ${resp.error || 'no session returned'}` };
  }
  id.state.interactiveSessionId = resp.sessionId as string;
  id.state.interactiveTabId = (resp.tabId as string) || null;
  id.state.affinitySessionId = id.state.interactiveSessionId;
  // A tab of its own again, after the one it had went away: the call says so.
  if (id.state.lostRoute) announceReplacement(id, { sessionId: id.state.interactiveSessionId, tabId: id.state.interactiveTabId });
  return { sessionId: id.state.interactiveSessionId, tabId: id.state.interactiveTabId || undefined };
}

function adoptCreatedSession(id: CallerIdentity, created: NiResponse, tabId?: string): { sessionId: string; tabId?: string } {
  const sessionId = created.sessionId as string;
  id.state.affinitySessionId = sessionId;
  // A tab of its own in a shared browser (a caller with a MoreLogin profile of its own): released when it leaves.
  if (created.shared === true && typeof created.tabId === 'string') {
    id.state.interactiveSessionId = sessionId;
    id.state.interactiveTabId = created.tabId;
    tabId = tabId || created.tabId;
  }
  if (id.state.lostRoute) {
    announceReplacement(id, { sessionId, tabId: tabId || (typeof created.tabId === 'string' ? created.tabId : null) });
  }
  return { sessionId, tabId };
}

/** Old tab ids this caller still names after they were replaced: kept small (the latest ones). */
const REPLACED_TABS_MAX = 16;

/**
 * This call is served by a replacement route (`to`) for one that went away (`from`, else the caller's lostRoute):
 * its answer starts with a notice that names both (browser-route-flow.ts noteRouteReplaced), once per replacement,
 * and a later call that still names the old tab goes to the new one. A replacement that is the lost route itself (a
 * recovery that handed the same tab back) is not one.
 */
function announceReplacement(
  id: CallerIdentity,
  to: { sessionId: string; tabId?: string | null },
  from?: RouteRef | null,
  kind: 'lost' | 'moved' = 'lost',
): void {
  const lost = from || id.state.lostRoute;
  id.state.lostRoute = null;
  const next = { sessionId: to.sessionId, tabId: to.tabId || null };
  if (lost && lost.sessionId === next.sessionId && (lost.tabId || null) === next.tabId) return;
  // A tab that is still open (`moved`) was not lost: status reports the move (routeMoved), not a lost tab.
  if (kind === 'lost' && lost?.tabId && next.tabId) {
    id.state.replacedTabs.delete(lost.tabId);
    id.state.replacedTabs.set(lost.tabId, next);
    while (id.state.replacedTabs.size > REPLACED_TABS_MAX) id.state.replacedTabs.delete(id.state.replacedTabs.keys().next().value as string);
  }
  noteRouteReplaced({ kind, from: lost ? { sessionId: lost.sessionId, tabId: lost.tabId || null } : null, to: next });
}

/**
 * The route this caller knew before a repin: the one it moved to earlier, else the one it last served a call on, else
 * its launch pin. A route without a tab id is known by its session only.
 */
function knownRoute(id: CallerIdentity): { sessionId: string; tabId: string | null } | null {
  if (id.state.recoveredSessionId) return { sessionId: id.state.recoveredSessionId, tabId: id.state.recoveredTabId };
  if (id.state.servedRoute) return id.state.servedRoute;
  const pins = effectivePins(id);
  const session = pins.browserSessionId || id.state.ancestorPinnedSession;
  return session ? { sessionId: session, tabId: pins.browserTabId || id.state.ancestorPinnedTab || null } : null;
}

/**
 * Whether `to` is a different route than `from`: another session, or another tab when both tab ids are known. A
 * route it learns where it knew only the session (a pin without a tab) is the same route, not a move.
 */
function isOtherRoute(from: { sessionId: string; tabId: string | null } | null, to: { sessionId: string; tabId: string | null }): boolean {
  if (!from) return false;
  return from.sessionId !== to.sessionId || (!!from.tabId && !!to.tabId && from.tabId !== to.tabId);
}

/** A pinned caller's route moves here (a recovery, its own browser_session create, a session of its own named by id). */
function repin(id: CallerIdentity, sessionId: string, tabId?: string | null): void {
  const to = { sessionId, tabId: tabId || null };
  const from = knownRoute(id);
  // A move from a tab it knew (status says Replaced while it is current); adopting the route it was launched with, or
  // the first one it learns, is not one.
  if (from && isOtherRoute(from, to)) id.state.routeMoved = { from, to };
  id.state.recoveredSessionId = sessionId;
  id.state.recoveredTabId = tabId || null;
  resolvedRoutes.delete(id);
}

/**
 * The open tab this caller owns in `sessionId` (the server's tabOwners, under its routing id or its client id): the
 * tab it named when that is one of its own and open, else its first open one (a tab it named that closed, or that is
 * another owner's, is never returned). null for a session it has no open tab in, or one that is not the default browser.
 */
function ownedTabIn(listing: NiResponse, sessionId: string, id: CallerIdentity, tabId?: string): string | null {
  const session = ((listing.sessions || []) as BrowserSessionInfo[]).find(s => s.id === sessionId);
  if (!session || !servesDefault(session)) return null;
  const owners = session.tabOwners || {};
  const mine = [owners[terminalIdFor(id)], owners[id.clientId]].filter((t): t is string => typeof t === 'string' && t.length > 0);
  const open = (t: string) => !session.tabs || session.tabs.some(x => x.id === t);
  if (tabId && mine.includes(tabId) && open(tabId)) return tabId;
  return mine.find(open) || null;
}

/**
 * A pinned run moved by itself to a tab it owns (ids of a session of its own, named by hand): the server records it
 * as the run's route (POST /api/loop/recover-browser `adopt`), so a later MCP process of the run (a Codex turn, a
 * restarted stdio child) follows it through yourRoute instead of the route the server knew before. Only a server
 * that says it records it (`adoptRoute` in its session list): an older one would read the request as a recovery and
 * open one more tab. Best-effort: the move holds in this process either way.
 */
async function recordOwnRoute(id: CallerIdentity, listing: NiResponse, sessionId: string, tabId: string): Promise<void> {
  if (listing.adoptRoute !== true) return;
  const terminalSessionId = effectivePins(id).terminalSessionId || id.state.ancestorPinnedTerminal || undefined;
  if (!terminalSessionId) return;
  const recorded = await request('POST', '/api/loop/recover-browser', { terminalSessionId, adopt: { sessionId, tabId } });
  if (recorded.error) console.error(`[MCP] the run's move to session ${sessionId} tab ${tabId} was not recorded: ${recorded.error}`);
}

/**
 * A pinned run gets a new tab of its own in SynaBun's shared browser (POST /api/loop/recover-browser), started when
 * none runs. `lost`: the route it found gone (the server hands back the run's current route when that one is still
 * open, e.g. after another MCP process of the run recovered first). `reason: 'create'`: the run's own
 * browser_session create, always a new tab. The server records the move on the run (state file, run record).
 */
async function recoverRunBrowser(
  id: CallerIdentity,
  lost: { sessionId?: string; tabId?: string } | null,
  reason?: 'create',
): Promise<NiResponse> {
  const pins = effectivePins(id);
  const terminalSessionId = pins.terminalSessionId || id.state.ancestorPinnedTerminal || undefined;
  const body: Record<string, unknown> = {};
  if (terminalSessionId) body.terminalSessionId = terminalSessionId;
  if (reason) body.reason = reason;
  if (lost?.sessionId) body.lost = { sessionId: lost.sessionId, tabId: lost.tabId || null };
  const recovered = await request('POST', '/api/loop/recover-browser', body, SESSION_CREATE_TIMEOUT);
  if (!recovered.error && typeof recovered.sessionId === 'string' && !isBrowserStarting(recovered)) {
    const tabId = typeof recovered.tabId === 'string' ? recovered.tabId : null;
    repin(id, recovered.sessionId, tabId);
    // A recovery (a new tab, or the route another process of the run moved to: `current`) serves this call; the
    // run's own create is not a replacement it has to be told about.
    if (reason === 'create') id.state.lostRoute = null;
    else announceReplacement(id, { sessionId: recovered.sessionId, tabId },
      id.state.lostRoute || (lost?.sessionId ? { sessionId: lost.sessionId, tabId: lost.tabId || null } : null));
  }
  return recovered;
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
  // The id the tab was acquired under (acquireInteractive), as the caller it is: the server releases a caller's own
  // tabs only, and a run's only with its terminal token (a stdio child's own; an HTTP identity evicted outside any
  // request has none, and the run's end releases its tabs on the server anyway).
  const owner = terminalIdFor(id);
  try {
    void fetch(`${BASE_URL}/api/browser/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...terminalHeaders(id) },
      body: JSON.stringify({ clientId: owner }),
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
): Promise<RouteOrError> {
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
  let namedListing: NiResponse | null = null;
  if (sessionId && sessionId !== (pins.browserSessionId || id.state.ancestorPinnedSession)) {
    const listed = await request('GET', '/api/browser/sessions');
    namedListing = listed;
    const named = ((listed.sessions || []) as BrowserSessionInfo[]).find(s => s.id === sessionId);
    if (named && !servesDefault(named)) {
      // Ids of the browser this caller left when it chose another MoreLogin profile (useSessionProfile): the call
      // goes to its own tab in the profile it works in now, and its answer names that tab.
      const replaced = tabId ? id.state.replacedTabs.get(tabId) : undefined;
      const left = id.state.lostRoute?.sessionId === sessionId || !!replaced;
      if (!wantsDefaultBrowser && !left) {
        const own = listed.yourProfile ? 'this session\'s browser' : 'the default browser';
        return { error: `Browser session ${sessionId} is not ${own} (${describeSession(named)}; ${listed.yourProfile ? 'this session works in' : 'the default is'} ${describeDefault(listed)}), so SynaBun's browser tools do not act on it. Leave sessionId out: browser_navigate opens the page in ${own}.${named.profileMode === 'morelogin' ? ' To work in another MoreLogin profile, call morelogin with action "use" first.' : ''}` };
      }
      console.error(`[MCP] not using session ${sessionId} (${describeSession(named)}) — resolving ${describeDefault(listed)}`);
      sessionId = undefined;
      // A tab that was replaced keeps its name: the call goes to its replacement (below).
      if (!replaced) tabId = undefined;
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
  let resolvedTabId = pinnedTab || tabId || undefined;
  if (pinnedTab && tabId && tabId !== pinnedTab) {
    console.error(`[MCP] tabId override ignored: pinned=${pinnedTab} requested=${tabId}`);
  }

  // Agent/loop-scoped browser session — set by the orchestrator to pin
  // this caller to a specific browser session (multi-session isolation).
  // If pinned session died, check recovery cache first, then auto-create.
  const pinnedSession = pins.browserSessionId || id.state.ancestorPinnedSession || undefined;
  // A pinned run that names a session of its own by hand (the one its browser_session create returned, or one it
  // recovered into in an earlier process): that session and its own open tab there, never the dead pinned tab paired
  // with it. The run's route moves there, here and on the server (recordOwnRoute). A session that is not the run's
  // (another run's, or one that is gone) is ignored like a tab the pin overrides: the run works in its own route.
  // Before 2026-11-04 it was paired with the pinned tab, a pair that exists nowhere (the server refused it, and the
  // call reported the run's tab lost).
  if (pinnedSession && sessionId && sessionId !== pinnedSession && sessionId !== id.state.recoveredSessionId) {
    const listed = namedListing || await request('GET', '/api/browser/sessions');
    const owned = ownedTabIn(listed, sessionId, id, tabId);
    if (owned) {
      repin(id, sessionId, owned);
      await recordOwnRoute(id, listed, sessionId, owned);
      return { sessionId, tabId: owned };
    }
    console.error(`[MCP] session ${sessionId} is not one of this run's: ignored, the run's own route is used`);
    sessionId = undefined;
    tabId = undefined;
    resolvedTabId = pinnedTab;
  }
  // Loop prompts intentionally pass their injected sessionId/tabId on every
  // call. Treat an explicit session that matches the pin as pinned traffic too;
  // otherwise the old fast path skipped liveness checks and returned a stale
  // tab forever after a renderer/page closed. The session the run moved to (a
  // recovery, its own browser_session create) is the run's pinned traffic now.
  if (pinnedSession && (!sessionId || sessionId === pinnedSession || sessionId === id.state.recoveredSessionId)) {
    // Check recovery cache first — avoids re-creating on every call after recovery.
    // Return the RECOVERED tab, never the stale pinned tab (which 404s).
    if (id.state.recoveredSessionId) {
      const recheck = await request('GET', '/api/browser/sessions');
      const alive = ((recheck.sessions || []) as BrowserSessionInfo[]).find(s => s.id === id.state.recoveredSessionId);
      // The recovered TAB must still be there too: one closed while its session lives was returned forever
      // ("Tab … not found in session" on every call, 2026-10-04).
      const recoveredTab = id.state.recoveredTabId;
      const tabAlive = !!alive && (!recoveredTab || !alive.tabs || alive.tabs.some(t => t.id === recoveredTab));
      if (alive && tabAlive) return { sessionId: id.state.recoveredSessionId, tabId: recoveredTab || undefined };
      id.state.recoveredSessionId = null; // recovered session or tab also died — try fresh recovery
      id.state.recoveredTabId = null;
    }

    const check = await request('GET', '/api/browser/sessions');
    const listed = (check.sessions || []) as BrowserSessionInfo[];
    // The route the server recorded for this run (yourRoute): where a recovery or the run's own browser_session
    // create moved it, also when that happened in an earlier MCP process of the run (a Codex turn, a restarted
    // stdio child) that this one never heard of. Used while its tab is open; the pin otherwise.
    const yours = check.yourRoute as { sessionId?: unknown; tabId?: unknown } | undefined;
    if (yours && typeof yours.sessionId === 'string' && typeof yours.tabId === 'string'
      && (yours.sessionId !== pinnedSession || yours.tabId !== resolvedTabId)) {
      const moved = listed.find(s => s.id === yours.sessionId);
      if (moved && servesDefault(moved) && (!moved.tabs || moved.tabs.some(t => t.id === yours.tabId))) {
        // A route this process already served calls on: a recorded route that differs from it is a move it is told
        // about. The pin alone is not (the launch route, or a route that moved before this process started: status
        // reports that one, from the pin, without a notice).
        const served = id.state.servedRoute;
        const servedElsewhere = !!served?.tabId && isOtherRoute(served, { sessionId: yours.sessionId, tabId: yours.tabId });
        repin(id, yours.sessionId, yours.tabId);
        // The server moved this run's route earlier (a recovery or a create in another MCP process of the run). A call
        // that still names other ids, or that worked in another tab before, is told where it ran; one that names none
        // in a process that never worked elsewhere just works there.
        const namedTab = tabId || null;
        if (id.state.lostRoute || servedElsewhere || (namedTab && namedTab !== yours.tabId) || (sessionId && sessionId !== yours.sessionId)) {
          const pinnedListed = listed.find(s => s.id === pinnedSession);
          const formerTab = namedTab || (servedElsewhere ? served!.tabId : null) || resolvedTabId || null;
          const formerOpen = !!pinnedListed && !!formerTab && (!pinnedListed.tabs || pinnedListed.tabs.some(t => t.id === formerTab));
          announceReplacement(id, { sessionId: yours.sessionId, tabId: yours.tabId },
            id.state.lostRoute || { sessionId: sessionId || pinnedSession, tabId: formerTab }, formerOpen ? 'moved' : 'lost');
        }
        return { sessionId: yours.sessionId, tabId: yours.tabId };
      }
    }
    const active = listed.find(s => s.id === pinnedSession);
    // A run's pinned browser must be the default one. Hard-fail rather than work
    // in the wrong browser.
    if (active && !servesDefault(active) && check.profileChosen === true) {
      // The run chose another MoreLogin profile for itself (morelogin "use"): its launch tab is in the browser it
      // left. It gets a tab of its own in the profile it works in now, and the server records that as its route.
      const recovered = await recoverRunBrowser(id, { sessionId: pinnedSession, tabId: resolvedTabId });
      if (isBrowserStarting(recovered)) return { error: String(recovered.error), starting: true };
      if (!recovered.error && recovered.sessionId) {
        return { sessionId: recovered.sessionId as string, tabId: (recovered.tabId as string) || undefined };
      }
      return { error: `No browser tab in ${describeDefault(check)}, the profile this run chose: ${recovered.error || 'no tab returned'}\nThe run was not moved to another profile or browser. Pick a profile that can start (morelogin "use"), or go back with morelogin "use" and envId "default".` };
    }
    if (active && !servesDefault(active)) {
      return { error: `Pinned browser session ${pinnedSession} is not the default browser (${describeSession(active)}; the default is ${describeDefault(check)}), so this run will not use it. Start the run again so it acquires the default browser.` };
    }
    if (active) {
      // Also verify the resolved tab still exists in the session; if not, recover.
      const tabList = active.tabs;
      const tabAlive = !resolvedTabId || !tabList || tabList.some(t => t.id === resolvedTabId);
      if (tabAlive) return { sessionId: pinnedSession, tabId: resolvedTabId };
      console.error(`[MCP] Pinned tab ${resolvedTabId} not found in active session ${pinnedSession} — recovering`);
      const recovered = await recoverRunBrowser(id, { sessionId: pinnedSession, tabId: resolvedTabId });
      if (isBrowserStarting(recovered)) return { error: String(recovered.error), starting: true };
      if (!recovered.error && recovered.sessionId) {
        return { sessionId: recovered.sessionId as string, tabId: (recovered.tabId as string) || undefined };
      }
      // Never hand back the dead tab: every call would answer "Tab … not found" and none would recover. An
      // error is not cached, so the next call tries the recovery again.
      return { error: `Browser tab ${resolvedTabId} of session ${pinnedSession} is gone and recovery failed: ${recovered.error || 'no tab returned'}\n${LOST_ROUTE_HINT}` };
    }

    // Pinned session is gone — rejoin the SHARED loop browser with a fresh owned
    // tab (not an isolated new browser), and adopt the NEW tabId. Forwarding the
    // stale pinned tab into a different session would 404 every subsequent call.
    console.error(`[MCP] Pinned browser session ${pinnedSession} is gone — recovering via shared loop browser`);
    const recovered = await recoverRunBrowser(id, { sessionId: pinnedSession, tabId: resolvedTabId });
    if (isBrowserStarting(recovered)) return { error: String(recovered.error), starting: true };
    if (recovered.error || !recovered.sessionId) {
      return { error: `Pinned browser session ${pinnedSession} is no longer available and recovery failed: ${recovered.error || 'no session returned'}\n${LOST_ROUTE_HINT}` };
    }
    return { sessionId: recovered.sessionId as string, tabId: (recovered.tabId as string) || undefined };
  }

  // Ids of a tab of this caller's that went away. One SynaBun already replaced: the call goes to its replacement (the
  // notice was given with the replacement). The one just lost (its own close, say): the call resolves its route as if
  // it named none, which opens a tab of its own and says so, instead of failing on the old ids until it creates one.
  if (tabId && !pinnedSession) {
    const replaced = id.state.replacedTabs.get(tabId);
    if (replaced) return { sessionId: replaced.sessionId, tabId: replaced.tabId || undefined };
    const lost = id.state.lostRoute;
    if (lost && lost.tabId === tabId && (!sessionId || lost.sessionId === sessionId)) {
      sessionId = undefined;
      tabId = undefined;
      resolvedTabId = undefined;
    }
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
    id.state.lostRoute = { sessionId: id.state.interactiveSessionId, tabId: id.state.interactiveTabId };
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
    // Still starting: not a failure (the server keeps the start for this caller's next call).
    if (isBrowserStarting(created)) return { error: AUTO_CREATE_STARTING, starting: true };
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
  const autoCreateSession = async (): Promise<RouteOrError> => {
    if (lockRisk) return acquireInteractive(id, autoCreate?.url);
    const created = await request('POST', '/api/browser/sessions', {
      url: autoCreate?.url || 'about:blank',
    }, SESSION_CREATE_TIMEOUT);
    // Still starting: not a failure (the server keeps the start for this caller's next call).
    if (isBrowserStarting(created)) return { error: AUTO_CREATE_STARTING, starting: true };
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

  if (sessions.length > 0 && !resolvedTabId) {
    // No autoCreate — the caller wants to interact with a page (click, snapshot, etc.). The server hands an automation
    // only a tab it owns (server.js getTargetPage, since 2026-11-05): a page the user opened by hand in SynaBun's
    // browser panel, or another automation's tab, is never adopted. A tab of its own there (a session it created, which
    // this process forgot) is used; else acquire our OWN dedicated tab in the shared browser (it starts at about:blank:
    // navigate it where the work is).
    const myTerminalId = terminalIdFor(id);
    for (const s of sessions) {
      const owners = s.tabOwners || {};
      const mine = owners[myTerminalId] || owners[id.clientId];
      if (mine && (s.tabs || []).some(t => t.id === mine)) {
        id.state.affinitySessionId = s.id;
        return { sessionId: s.id, tabId: mine };
      }
    }
    return acquireInteractive(id, undefined);
  }

  if (sessions.length === 1) {
    // An explicit tab with no session: the server checks that the tab is this caller's own.
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
    return { error: 'No browser sessions open. Call browser_session with action "create" to open one, or browser_navigate with a URL, which opens one by itself.' };
  }

  // Multiple available sessions — require explicit ID
  const list = sessions.map(s => `  ${s.id}${s.title || s.url ? ` — ${s.title || s.url}` : ''}`).join('\n');
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
): Promise<BrowserRoute | { error: string; starting?: boolean }> {
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
  if (!('error' in result)) {
    resolvedRoutes.set(id, { key: routeKey(id, sessionId, tabId, platform || !!autoCreate), route: { ...result }, sessionId, tabId, autoCreate, platform });
    id.state.servedRoute = { sessionId: result.sessionId, tabId: result.tabId || null };
  }
  browserMetric({ phase: 'session-resolution', cached: false, durationMs: performance.now() - startedAt });
  return result;
}

/**
 * resolveSession without the route cache: for a caller whose request found its session or tab gone (isMissingRoute)
 * and that recovers by itself. A pinned run gets its session again or a replacement tab (POST /api/loop/recover-browser),
 * and the next resolveSession reuses what this found. Batches stay on their route and never recover midway.
 */
export async function refreshSession(
  sessionId?: string,
  autoCreate?: { url?: string },
  tabId?: string,
  opts: { platform?: boolean } = {},
): Promise<BrowserRoute | { error: string; starting?: boolean }> {
  const context = batchContext.getStore();
  if (context) return context.route;
  resolvedRoutes.delete(getIdentity());
  return resolutionRefresh.run(true, () => resolveSession(sessionId, autoCreate, tabId, opts));
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

export interface OwnBrowserTab { id: string; url: string; title: string }
export interface OwnBrowserSession {
  id: string;
  /** This caller's own open tabs there (never another automation's or the owner's). */
  tabs: OwnBrowserTab[];
  /** How many other tabs the session has (other automations', the owner's). */
  otherTabs: number;
  servesDefault: boolean;
  profile: string;
}
export interface BrowserRouteStatus {
  error?: string;
  sessions: OwnBrowserSession[];
  /** The route this caller's next browser call uses, as far as it is known without opening anything. */
  current: { sessionId: string; tabId: string | null; open: boolean; url?: string; title?: string; source: 'current' | 'recovered' | 'recorded' | 'pinned' | 'own' } | null;
  /** Tabs of this caller's that were lost and replaced by `current`. */
  replacedTabs: string[];
  /** A route of this caller's that went away and that no replacement was opened for yet. */
  lost: { sessionId: string; tabId: string | null } | null;
  /** The run's route moved away from a tab it knew: the tab it was launched with (its pin), or one this process
   *  worked in (a recovery or its own create). Never for the launch route itself or the first route a run learns. */
  movedFromPin: boolean;
  /** The tab it moved from, when known. */
  movedFrom?: { sessionId: string; tabId: string | null } | null;
  /** The MoreLogin profile this caller works in when it is not the default (its launch's, or its own choice). */
  profile?: { envId: string; name: string | null } | null;
}

/**
 * What browser_session list / status show: the sessions this caller can see, each with the caller's own tabs only
 * (the server lists an automation nothing else, ownTabsOnly; an older server's other tabs are left out here by their
 * owner), and the route its next call uses. Reads only: never opens, recovers or moves a tab.
 */
export async function browserRouteStatus(): Promise<BrowserRouteStatus> {
  const id = getIdentity();
  const pins = effectivePins(id);
  if (!pins.browserSessionId && !pins.browserTabId) await resolveFromAncestors(id);
  const listing = await request('GET', '/api/browser/sessions');
  const empty: BrowserRouteStatus = { sessions: [], current: null, replacedTabs: [], lost: id.state.lostRoute, movedFromPin: false };
  if (listing.error) return { ...empty, error: listing.error };
  const raw = (listing.sessions || []) as Array<BrowserSessionInfo & { otherTabs?: number }>;
  const keys = [terminalIdFor(id), id.clientId];
  const sessions: OwnBrowserSession[] = raw.map((s) => {
    const owners = s.tabOwners || {};
    const mine = new Set(keys.map(k => owners[k]).filter((t): t is string => typeof t === 'string' && t.length > 0));
    const all = s.tabs || [];
    const tabs = all.filter(t => mine.has(t.id)).map(t => ({ id: t.id, url: t.url || '', title: t.title || '' }));
    const otherTabs = typeof s.otherTabs === 'number' ? s.otherTabs : all.length - tabs.length;
    return { id: s.id, tabs, otherTabs, servesDefault: servesDefault(s), profile: describeSession(s) };
  });
  const openTab = (sessionId: string, tabId: string | null | undefined) => {
    const session = sessions.find(x => x.id === sessionId);
    if (!session) return null;
    if (!tabId) return session.tabs[0] || null;
    return session.tabs.find(t => t.id === tabId) || null;
  };
  const pinnedSession = pins.browserSessionId || id.state.ancestorPinnedSession || null;
  const pinnedTab = pins.browserTabId || id.state.ancestorPinnedTab || null;
  const yours = listing.yourRoute as { sessionId?: unknown; tabId?: unknown } | undefined;
  const cached = resolvedRoutes.get(id)?.route;
  type Source = NonNullable<BrowserRouteStatus['current']>['source'];
  const candidates: Array<{ sessionId: string; tabId: string | null; source: Source }> = [];
  if (cached) candidates.push({ sessionId: cached.sessionId, tabId: cached.tabId || null, source: 'current' });
  if (id.state.recoveredSessionId) candidates.push({ sessionId: id.state.recoveredSessionId, tabId: id.state.recoveredTabId, source: 'recovered' });
  if (yours && typeof yours.sessionId === 'string' && typeof yours.tabId === 'string') candidates.push({ sessionId: yours.sessionId, tabId: yours.tabId, source: 'recorded' });
  if (pinnedSession) candidates.push({ sessionId: pinnedSession, tabId: pinnedTab, source: 'pinned' });
  if (id.state.interactiveSessionId) candidates.push({ sessionId: id.state.interactiveSessionId, tabId: id.state.interactiveTabId, source: 'own' });
  if (id.state.affinitySessionId) candidates.push({ sessionId: id.state.affinitySessionId, tabId: null, source: 'own' });
  for (const s of sessions) if (s.tabs[0]) candidates.push({ sessionId: s.id, tabId: s.tabs[0].id, source: 'own' });
  let current: BrowserRouteStatus['current'] = null;
  for (const c of candidates) {
    const tab = openTab(c.sessionId, c.tabId);
    if (tab) { current = { sessionId: c.sessionId, tabId: tab.id, open: true, url: tab.url, title: tab.title, source: c.source }; break; }
  }
  // Nothing open: the route it had (pinned or last used), reported as gone.
  if (!current && candidates[0] && candidates[0].source !== 'own') current = { ...candidates[0], open: false };
  const replacedTabs = current?.open
    ? [...id.state.replacedTabs].filter(([, to]) => to.sessionId === current!.sessionId && to.tabId === current!.tabId).map(([from]) => from)
    : [];
  // Moved: the current route is not the launch pin, or it is where this process moved from a tab it knew. The route
  // the server recorded is not a move by itself: on a fresh run it is the launch route (live runs 188b4ed7, 2ed620e8
  // said "Replaced: yes" on their first call). A fresh process of a run that another process moved knows the move
  // from its launch pin only; with no tab pinned it cannot tell, and says no.
  const here = current?.open ? { sessionId: current.sessionId, tabId: current.tabId } : null;
  const fromPin = !!here && !!pinnedSession && isOtherRoute({ sessionId: pinnedSession, tabId: pinnedTab }, here);
  const moved = id.state.routeMoved;
  const fromHere = !!here && !!moved && moved.to.sessionId === here.sessionId && (!moved.to.tabId || moved.to.tabId === here.tabId);
  const movedFromPin = fromPin || fromHere;
  const movedFrom = fromHere ? moved!.from : fromPin ? { sessionId: pinnedSession!, tabId: pinnedTab } : null;
  const yourProfile = listing.yourProfile as { envId?: unknown; name?: unknown } | undefined;
  const profile = yourProfile && typeof yourProfile.envId === 'string'
    ? { envId: yourProfile.envId, name: typeof yourProfile.name === 'string' ? yourProfile.name : null } : null;
  return { sessions, current, replacedTabs, lost: id.state.lostRoute, movedFromPin, movedFrom, profile };
}

/**
 * browser_session create: a new browser tab of this caller's own, where it continues.
 * - A pinned run (a loop, a dispatched worker): a new tab in SynaBun's shared browser (started when none runs). The
 *   run's route moves there (repinned): its next calls go to it with or without ids, and the server records it on the
 *   run (state file, run record, agent_status).
 * - Any other caller: what browser_navigate's auto-create gives it. Its own tab in the shared browser when that runs
 *   on a persistent profile or other automations hold it (a second browser on that profile fails, or ends the shared
 *   one); else a new browser, which becomes its session.
 * A url other than about:blank is opened in the new tab. A start the server is still running answers
 * BROWSER_STARTING (isBrowserStarting): the next create gets that same start, never a second browser.
 */
export async function createSession(url?: string): Promise<NiResponse> {
  const id = getIdentity();
  const pins = effectivePins(id);
  const target = url || 'about:blank';
  // The caller's own create is where it continues: nothing to announce about a tab it lost before.
  id.state.lostRoute = null;
  if (!pins.browserSessionId && !pins.browserTabId) await resolveFromAncestors(id);
  const pinned = pins.browserSessionId || id.state.ancestorPinnedSession;
  let created: NiResponse;
  let opened = false; // the new tab is already at `target`
  if (pinned) {
    created = await recoverRunBrowser(id, null, 'create');
    if (created.error || isBrowserStarting(created) || typeof created.sessionId !== 'string') return created;
    created = { ...created, repinned: true };
  } else {
    const listed = await request('GET', '/api/browser/sessions');
    if (listed.error) return listed;
    const all = (listed.sessions || []) as BrowserSessionInfo[];
    const lockRisk = all.some(s => s.persistent || s.loopOwned || s.agentOwned || s.interactiveOwned);
    let shared = lockRisk;
    created = {};
    if (!lockRisk) {
      created = await request('POST', '/api/browser/sessions', { url: target }, SESSION_CREATE_TIMEOUT);
      if (isBrowserStarting(created)) return created;
      if (created.error && /lock/i.test(created.error)) shared = true;
      else if (created.error || typeof created.sessionId !== 'string') return created;
      else {
        id.state.affinitySessionId = created.sessionId as string;
        if (created.shared === true && typeof created.tabId === 'string') {
          id.state.interactiveSessionId = created.sessionId as string;
          id.state.interactiveTabId = created.tabId;
        }
        resolvedRoutes.delete(id);
        // A start handed over from an earlier create may not be at this URL yet.
        opened = !created.handedOver;
      }
    }
    if (shared) {
      const acquired = await acquireInteractive(id, target);
      if ('error' in acquired) return { error: acquired.error, ...(acquired.starting && { starting: true, code: 'BROWSER_STARTING' }) };
      resolvedRoutes.delete(id);
      created = { ok: true, sessionId: acquired.sessionId, tabId: acquired.tabId || null, shared: true };
    }
  }
  const sessionId = created.sessionId as string;
  const tabId = typeof created.tabId === 'string' ? created.tabId : undefined;
  if (!opened && target !== 'about:blank') {
    const went = await navigate(sessionId, target, tabId, undefined, 'none');
    if (went.error) return { ...created, url: 'about:blank', navigateError: went.error };
    return { ...created, url: typeof went.url === 'string' ? went.url : target };
  }
  return { ...created, url: typeof created.url === 'string' ? created.url : target };
}

/**
 * Close a session. One that other automations still have tabs in is kept by the server, which closes only this
 * caller's own tab there (`sessionKept`). Either way this caller's cached route to it is forgotten: the next call
 * resolves again (a pinned run gets a tab back through its recovery).
 */
export async function closeSession(sessionId: string): Promise<NiResponse> {
  const result = await request('DELETE', `/api/browser/sessions/${sessionId}`);
  if (!result.error) {
    const id = getIdentity();
    // The tab that went (the server's releasedTabId, else the one this caller routed to there): the next call that
    // opens a tab for this caller says it replaced this one.
    const cachedRoute = resolvedRoutes.get(id)?.route;
    const closedTab = typeof result.releasedTabId === 'string' ? result.releasedTabId
      : cachedRoute?.sessionId === sessionId ? cachedRoute.tabId || null
        : id.state.recoveredSessionId === sessionId ? id.state.recoveredTabId
          : id.state.interactiveSessionId === sessionId ? id.state.interactiveTabId : null;
    if (result.sessionKept !== true || closedTab) id.state.lostRoute = { sessionId, tabId: closedTab };
    if (resolvedRoutes.get(id)?.route.sessionId === sessionId) resolvedRoutes.delete(id);
    if (id.state.interactiveSessionId === sessionId) { id.state.interactiveSessionId = null; id.state.interactiveTabId = null; }
    if (id.state.affinitySessionId === sessionId) id.state.affinitySessionId = null;
    if (id.state.recoveredSessionId === sessionId) { id.state.recoveredSessionId = null; id.state.recoveredTabId = null; }
  }
  return result;
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

/** A social write a page script makes (Bluesky): the platform whose gap the Neural Interface spaces it by, and the
 *  longest this call may wait for it (neural-interface/lib/social-write-pacing.js). */
export interface SocialWritePace {
  platform: 'bluesky';
  maxWaitMs: number;
}

/** `recover: false`: a missing session or tab is reported, never retried on a replacement tab (see request()). */
export async function evaluate(sessionId: string, script: string, tabId?: string, opts?: { pace?: SocialWritePace; recover?: boolean }): Promise<NiResponse> {
  const pace = opts?.pace ? { platform: opts.pace.platform, maxWaitMs: Math.max(0, Math.floor(opts.pace.maxWaitMs || 0)) } : null;
  return request('POST', `/api/browser/sessions/${sessionId}/evaluate`, { script, ...(tabId && { tabId }), ...(pace && { pace }) }, LONG_TIMEOUT + (pace?.maxWaitMs || 0), { recover: opts?.recover });
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

/**
 * This caller works in a MoreLogin profile of its own from now on (POST /api/morelogin/use): `envId`, `name` or
 * `profile` (either) of a profile MoreLogin lists, or `default: true` for the default of Settings → Browser. Only this
 * caller moves: the default AI browser and every other session stay where they are. The server releases what the
 * caller owned in the browser it leaves; here every route this process knew is forgotten, so its next browser call
 * resolves again and gets a tab of its own in the new profile (started then). The route it left is kept as its lost
 * route: a call that still names those ids goes to the new tab and says so.
 */
export async function useSessionProfile(ref: { envId?: string; name?: string; profile?: string; default?: boolean }): Promise<NiResponse> {
  const id = getIdentity();
  const pins = effectivePins(id);
  if (!pins.browserSessionId && !pins.browserTabId) await resolveFromAncestors(id);
  const result = await request('POST', '/api/morelogin/use', { ...ref }, LONG_TIMEOUT);
  // A Neural Interface from before per-session profiles has no such route and answers it as the owner's.
  if (result.code === 'OWNER_ROUTE') {
    return { ...result, error: 'This SynaBun server is older than per-session MoreLogin profiles (it was started before the update): it needs a restart before a session can pick a profile of its own.' };
  }
  if (result.error || result.ok !== true || result.changed !== true) return result;
  const left = knownRoute(id) || (id.state.interactiveSessionId
    ? { sessionId: id.state.interactiveSessionId, tabId: id.state.interactiveTabId }
    : null);
  id.state.interactiveSessionId = null;
  id.state.interactiveTabId = null;
  id.state.affinitySessionId = null;
  id.state.recoveredSessionId = null;
  id.state.recoveredTabId = null;
  id.state.servedRoute = null;
  id.state.routeMoved = null;
  id.state.replacedTabs.clear();
  // Only a route the server released is a lost one (a profile that is the default too keeps its tab). The server
  // names the tab it closed; this process may have known its route by the session alone (a tab-less route).
  const released = (Array.isArray(result.released) ? result.released : []) as Array<{ sessionId?: unknown; tabId?: unknown }>;
  const gone = released.find(r => r && r.sessionId === left?.sessionId) || released[0];
  id.state.lostRoute = gone && typeof gone.sessionId === 'string'
    ? { sessionId: gone.sessionId, tabId: typeof gone.tabId === 'string' ? gone.tabId : left?.sessionId === gone.sessionId ? left.tabId : null }
    : null;
  resolvedRoutes.delete(id);
  return result;
}

export async function moreloginUseDefault(envId: string | null): Promise<NiResponse> {
  return request('POST', '/api/morelogin/use-default', envId ? { envId } : { clear: true });
}

// ── Skills (the role-gated `skills` tool group) ──
// One thin call over /api/skills-studio/v2 (neural-interface/lib/skills/api-v2.js, creation-api.js), which owns every
// rule: an agent reads, drafts, checks and submits for review; installing and approving are the owner's, from the
// app's own page, and the routes refuse them to a request that carries the agent headers requestOnce sends. The
// caller's brain credential (identity.ts callerBrainCredential: its own request's over HTTP, SYNABUN_BRAIN_TOKEN for a
// stdio child) rides along: the server knows the Assistant by it (AI drafting needs it), never by X-Synabun-Role.

export async function skillsV2(method: 'GET' | 'POST' | 'PATCH', path: string, body?: Record<string, unknown>, timeout = LONG_TIMEOUT): Promise<NiResponse> {
  const credential = callerBrainCredential();
  return requestOnce(method, `/api/skills-studio/v2${path}`, body, timeout, credential ? { 'X-Synabun-Brain-Token': credential } : {});
}

// ── SynaBun assistant orchestration (role-gated `agents` tool group) ──
// Thin proxies over /api/assistant/* (neural-interface/lib/assistant-api.js),
// which owns dispatch state, rails and authorization. requestOnce already
// sends X-Synabun-Terminal (the assistant pin) and X-Synabun-Role.

/** A worker provider (each one can be the Assistant's brain too; 'antigravity' runs both over ACP). */
export type AssistantProvider = 'claude-code' | 'codex' | 'opencode' | 'antigravity';

export type AssistantDispatchBody = {
  /** Optional when routeId names an approved route (the server applies it). */
  provider?: AssistantProvider;
  task: string;
  cwd: string;
  assistantSessionId: string;
  model?: string;
  effort?: string;
  tools?: string[];
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
  /** The MoreLogin profile (id or name) of the worker's browser tab; none = the default browser. */
  moreloginProfile?: string;
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

// whatsapp_send_file: the server's own deadline for the send is 120 s (lib/whatsapp/manager.js); this
// one outlives it so a server timeout is reported as the server's.
const WHATSAPP_SEND_FILE_TIMEOUT = 130_000;
export const WHATSAPP_SEND_FILE_UNCERTAIN = 'SynaBun did not answer in time: the file may or may not have arrived. Do not send it again unless the user asks.';
export const WHATSAPP_SEND_FILE_LOST = 'SynaBun\'s answer was lost: the file may or may not have arrived. Do not send it again unless the user asks.';
// The request never reached SynaBun (nothing listens, no route to it): nothing was sent, for certain.
const WHATSAPP_SEND_FILE_NEVER_LEFT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

/**
 * whatsapp_send_file → POST /api/assistant/whatsapp/send-file: exactly one request (requestOnce, no
 * retry of any kind), because a timeout may come after WhatsApp took the file. `credential` (the
 * WhatsApp brain's own, identity.ts callerBrainCredential) rides on this request alone; without it
 * the server refuses (403).
 */
export async function whatsappSendFile(body: { path: string; caption?: string; as?: string }, credential: string | null): Promise<NiResponse> {
  const result = await requestOnce('POST', '/api/assistant/whatsapp/send-file', body as Record<string, unknown>, WHATSAPP_SEND_FILE_TIMEOUT,
    credential ? { 'X-Synabun-Brain-Token': credential } : {});
  if (result.code === 'REQUEST_TIMEOUT') return { ok: false, code: 'TIMEOUT', uncertain: true, error: WHATSAPP_SEND_FILE_UNCERTAIN };
  // Any other failure of the transport after the request left (a reset socket, an answer that is not JSON) may
  // come after WhatsApp took the file: as uncertain as a timeout, never "is the server running?".
  if (result.code === 'TRANSPORT_ERROR') {
    if (WHATSAPP_SEND_FILE_NEVER_LEFT.has(String(result.transportCode))) return { ok: false, code: 'UNREACHABLE', error: 'SynaBun is not reachable (is it running?): nothing was sent.' };
    return { ok: false, code: 'TRANSPORT_ERROR', uncertain: true, error: WHATSAPP_SEND_FILE_LOST };
  }
  return result;
}
