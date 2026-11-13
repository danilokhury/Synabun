/**
 * What a browser tool does when its tab goes away in the middle of the call.
 *
 * request() (services/neural-interface.ts) moves a step whose session or tab is gone to the run's replacement tab
 * (`rerouted`), and the server resets a wedged tab to about:blank under the same id (`tabRecovered`) or drops it
 * (`wedgedTabRetired`). For a single navigation that is the right answer. For a tool that read or prepared a page, every
 * later step would run on a blank tab: an extractor reports "nothing found", a poll times out, a click finds no
 * element, and the agent is told something about its page that is not true. The MoreLogin browser closing all its
 * pages (about 40 times between 2026-10-21 and 2026-11-04) made that the common case.
 *
 * A tool call runs inside a route flow with a policy (routeFlowPolicy):
 * - `follow`: steps may run on the replacement tab (browser_navigate); the answer says where it went.
 * - `rerun`: a read that prepares its own page (gsc_*_report, youtube_channel list, ...): once the page is lost,
 *   nothing more runs on the blank tab; the whole call runs once more from the start on the replacement route.
 * - `halt`: everything else (extractors, composer probes, clicks, writes): nothing more runs, and the answer says
 *   the tab was lost, what replaced it, and that steps before it may have taken effect. Never repeated by itself.
 *
 * Bluesky (bluesky.ts) recovers by itself and is not wrapped; browser_session and browser_batch have no flow.
 *
 * Every tool registered through withRouteFlows (flow or not) also gets runBrowserTool around it: a notice at the top
 * of its answer for each replacement route that served it (noteRouteReplaced), and the check of its raw arguments
 * (an owner-only field is refused, OWNER_ONLY_FIELDS; another unknown one is noted at the end).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type RouteFlowPolicy = 'follow' | 'rerun' | 'halt';

export interface RouteRef { sessionId: string; tabId: string | null }

export interface RouteLoss {
  /** gone: the session or tab no longer existed; reset: the server replaced the wedged page with about:blank;
   *  retired: the server closed the wedged tab, or the whole session. */
  reason: 'gone' | 'reset' | 'retired';
  /** The browser operation that found it (navigate, evaluate, click, ...). */
  step: string;
  from: RouteRef;
  /** The replacement route request() prepared, when there is one. */
  to?: RouteRef;
  /** SynaBun tried to open a replacement and could not (`error`), or the browser is still starting (`starting`). */
  recovery?: { error: string; starting?: boolean };
}

export interface RouteFlow {
  tool: string;
  policy: RouteFlowPolicy;
  loss: RouteLoss | null;
  /** follow: where request() sent a step. */
  rerouted: RouteRef | null;
}

/** Thrown by request() inside a rerun / halt flow once the page is lost: no later step runs on a blank tab. */
export class BrowserRouteLost extends Error {
  readonly loss: RouteLoss;
  constructor(loss: RouteLoss) {
    super(`The browser tab of this call was lost at ${loss.step}`);
    this.name = 'BrowserRouteLost';
    this.loss = loss;
  }
}

const flows = new AsyncLocalStorage<RouteFlow>();

export function currentRouteFlow(): RouteFlow | undefined {
  return flows.getStore();
}

// ── Policy ──────────────────────────────────────────────────────

/** Not wrapped: they recover by themselves (Bluesky), or do not depend on a page (session management, batches). */
const UNWRAPPED = new Set(['browser_session', 'browser_batch', 'browser_cheatsheet']);

const FOLLOW = new Set(['browser_navigate']);

/** Reads that open their own page first: running them again from the start is safe. */
const RERUN = new Set([
  'gsc_navigate', 'gsc_inspect_url', 'gsc_inspect_view_crawled',
  'gsc_performance_query', 'gsc_performance_export', 'gsc_performance_chart_screenshot',
  'gsc_pages_report', 'gsc_videos_report', 'gsc_cwv_report', 'gsc_https_report', 'gsc_enhancements',
  'gsc_links_report', 'gsc_links_export', 'gsc_crawl_stats', 'gsc_shopping',
  'youtube_navigate',
]);

/** Tools with an action: a rerun only for the read actions (an absent action is the tool's default, a read). */
const READ_ACTIONS: Readonly<Record<string, ReadonlySet<string | undefined>>> = {
  gsc_property: new Set(['list', 'current']),
  gsc_sitemap: new Set(['list', 'view_errors']),
  gsc_removals: new Set(['list_temporary', 'list_outdated', 'list_safesearch']),
  gsc_security_issues: new Set([undefined, 'list']),
  gsc_manual_actions: new Set([undefined, 'list']),
  gsc_settings: new Set([undefined, 'get']),
  gsc_users: new Set(['list']),
  gsc_associations: new Set(['list']),
  gsc_disavow: new Set(['download']),
  youtube_playlist: new Set(['list']),
  youtube_channel: new Set(['info', 'list']),
};

/** The flow a tool call runs in; null = not wrapped. */
export function routeFlowPolicy(tool: string, args: unknown): RouteFlowPolicy | null {
  if (UNWRAPPED.has(tool)) return null;
  if (FOLLOW.has(tool)) return 'follow';
  if (RERUN.has(tool)) return 'rerun';
  const reads = READ_ACTIONS[tool];
  if (reads) {
    const action = args && typeof args === 'object' ? (args as { action?: unknown }).action : undefined;
    return reads.has(typeof action === 'string' ? action : undefined) ? 'rerun' : 'halt';
  }
  return 'halt';
}

// ── Running a call ──────────────────────────────────────────────

type ToolResult = { content: Array<{ type: string; text?: string; [key: string]: unknown }>; isError?: boolean; [key: string]: unknown };

const describeRoute = (route: RouteRef) => `session ${route.sessionId}${route.tabId ? `, tab ${route.tabId}` : ''}`;

function lossCause(loss: RouteLoss): string {
  if (loss.reason === 'reset') return 'stopped answering, and SynaBun reset it to a blank page';
  if (loss.reason === 'retired') return 'stopped answering, and SynaBun closed it';
  return 'was closed (the browser closed its pages, or another automation closed it)';
}

/** What the agent does next: the tab that replaced it, the start still running, or a create of its own. */
function lossNext(loss: RouteLoss): string {
  // A replacement is open already: a create now would only replace it again (and close it), so the agent is told
  // plainly not to (browserSessionLossRule says the same).
  if (loss.to) return `A new tab replaced it: ${describeRoute(loss.to)}. Your next browser calls use it${loss.to.tabId ? ` (keep using tabId ${loss.to.tabId})` : ''}; do not call browser_session create.`;
  if (loss.recovery?.starting) return `SynaBun is opening a new tab for it, and the browser is still starting: call the tool again in a moment (the tab is kept for you). ${loss.recovery.error}`.trim();
  if (loss.recovery) return `SynaBun could not open a replacement tab (${loss.recovery.error}). Call browser_session with action "create" and continue in the tab it returns; only if that fails too, stop and report it. Never switch to another browser or tool.`;
  return 'The next browser call gets a new tab. If it answers that the session or tab is gone, call browser_session with action "create" and continue in the tab it returns; only if that fails too, stop and report it.';
}

/** The answer of a call whose page was lost and that is not repeated. */
export function routeLossMessage(tool: string, loss: RouteLoss): string {
  const lines = [
    `${tool} stopped: the browser tab it was working in (${describeRoute(loss.from)}) ${lossCause(loss)} during the call, at the ${loss.step} step. Nothing ran on a blank page and nothing was read from it.`,
    lossNext(loss),
    'Steps before that point may have taken effect: look at the page before you repeat a change. Then open the page again (browser_navigate or the tool\'s own navigation) and call the tool again.',
  ];
  return lines.join('\n');
}

function withNote(result: unknown, note: string): unknown {
  const r = result as ToolResult | null;
  if (!r || !Array.isArray(r.content)) return result;
  return { ...r, content: [...r.content, { type: 'text', text: note }] };
}

/**
 * The arguments of a rerun: a session or tab the call named that is now gone is left out, so the call resolves its
 * route again (a pinned run gets its recovered tab; a pin would override a tab named here anyway).
 */
function rerunArgs<A>(args: A, loss: RouteLoss): A {
  if (!args || typeof args !== 'object') return args;
  const a = { ...(args as Record<string, unknown>) };
  const namedLost = a.sessionId === loss.from.sessionId || (!!loss.from.tabId && a.tabId === loss.from.tabId);
  if (!namedLost) return args;
  delete a.sessionId;
  delete a.tabId;
  return a as A;
}

async function runOnce<A>(tool: string, policy: RouteFlowPolicy, args: A, handler: (args: A, extra?: unknown) => unknown, extra: unknown) {
  const flow: RouteFlow = { tool, policy, loss: null, rerouted: null };
  try {
    const value = await flows.run(flow, () => handler(args, extra));
    return { flow, value, thrown: null as unknown };
  } catch (error) {
    if (error instanceof BrowserRouteLost || flow.loss) return { flow, value: undefined, thrown: error };
    throw error;
  }
}

/**
 * Run one tool call in its route flow. A page lost during a `rerun` call runs it once more (never twice); during a
 * `halt` call it answers routeLossMessage instead of whatever the tool made of the blank tab.
 */
export async function runInRouteFlow<A>(
  tool: string,
  args: A,
  handler: (args: A, extra?: unknown) => unknown,
  extra?: unknown,
): Promise<unknown> {
  const policy = routeFlowPolicy(tool, args);
  if (!policy) return handler(args, extra);
  const first = await runOnce(tool, policy, args, handler, extra);
  if (!first.flow.loss) {
    // A step request() moved to the replacement route: the call ran there (the notice at the top of the answer says
    // so, withRouteNotices; resolution raises it too, and the same replacement is announced once).
    if (first.flow.rerouted) noteRouteReplaced({ kind: 'lost', from: null, to: first.flow.rerouted });
    return first.value;
  }
  const loss = first.flow.loss;
  if (policy !== 'rerun') return { content: [{ type: 'text', text: routeLossMessage(tool, loss) }], isError: true };
  // Once more from the start, on the replacement route; a second loss is answered, not repeated again.
  const second = await runOnce(tool, 'halt', rerunArgs(args, loss), handler, extra);
  if (second.flow.loss) return { content: [{ type: 'text', text: routeLossMessage(tool, second.flow.loss) }], isError: true };
  return withNote(second.value, `(The browser tab was lost during the first attempt (${describeRoute(loss.from)}, at the ${loss.step} step); the call ran again from the start${loss.to ? ` in ${describeRoute(loss.to)}` : ''}.)`);
}

// ── Replacement notices ─────────────────────────────────────────

/**
 * A call served by a replacement route: SynaBun opened a new tab for a lost one (a run's recovery, a caller's own
 * tab acquired again after its tab was closed), handed back the route the run had already moved to (another MCP
 * process of the run recovered first, the server's yourRoute), or a step request() moved there. Before 2026-11-05
 * none of this was said: the call answered for a blank tab, the model could not tell, and some called
 * browser_session create and opened one more tab (live runs 5b3f80b7, bc0d8c5e, eb68b6d5, d7a28e09).
 */
export interface RouteNotice {
  /** lost: the tab the call meant is gone; moved: the run's route is elsewhere (its old tab may still be open). */
  kind: 'lost' | 'moved';
  /** The route that was lost, when known. */
  from: RouteRef | null;
  /** Where this call ran. */
  to: RouteRef;
}

const noticeScopes = new AsyncLocalStorage<{ notices: RouteNotice[] }>();

const sameRoute = (a: RouteRef | null | undefined, b: RouteRef | null | undefined) =>
  !!a && !!b && a.sessionId === b.sessionId && (a.tabId || null) === (b.tabId || null);

/**
 * Note that this tool call is served by a replacement route. Said once at the top of the call's answer (one notice
 * per replacement: a second note of the same route keeps the first's lost route). Returns false outside a tool call
 * (nobody to tell: Bluesky recovers and reports by itself).
 */
export function noteRouteReplaced(notice: RouteNotice): boolean {
  const scope = noticeScopes.getStore();
  if (!scope) return false;
  const known = scope.notices.find(n => sameRoute(n.to, notice.to));
  if (known) {
    if (!known.from && notice.from) known.from = notice.from;
    if (notice.kind === 'lost') known.kind = 'lost';
    return true;
  }
  scope.notices.push({ ...notice, from: notice.from ? { ...notice.from } : null, to: { ...notice.to } });
  return true;
}

/** The notice's text: the first thing the agent reads in the answer. */
export function routeNoticeText(notice: RouteNotice): string {
  const { to, from } = notice;
  const where = to.tabId ? `a replacement tab ${to.tabId} is open in session ${to.sessionId}` : `a replacement is open in session ${to.sessionId}`;
  const keep = to.tabId ? `Keep using tabId ${to.tabId}${from && from.sessionId !== to.sessionId ? ` (sessionId ${to.sessionId})` : ''}` : `Keep using sessionId ${to.sessionId}`;
  if (notice.kind === 'moved') {
    const was = from?.tabId ? ` (not tab ${from.tabId})` : '';
    return `Your browser now works in tab ${to.tabId || '(the session\'s own)'} of session ${to.sessionId}${was}: SynaBun moved your route there earlier, and this call ran there. ${keep}. Do not call browser_session create.`;
  }
  const lost = from?.tabId ? `Your tab ${from.tabId} was lost` : from ? `Your browser session ${from.sessionId} was lost` : 'Your browser tab was lost';
  return `${lost}; ${where} and this call ran there. ${keep}. Do not call browser_session create.`;
}

function prependNotices(result: unknown, notices: RouteNotice[]): unknown {
  const r = result as ToolResult | null;
  if (!notices.length || !r || !Array.isArray(r.content)) return result;
  // The notice is its own content block, but some clients (Codex) join text blocks with no separator, so it ends with
  // a blank line: without it the answer read "…Do not call browser_session create.Page: about:blank".
  const text = `${notices.map(routeNoticeText).join('\n')}\n\n`;
  return { ...r, content: [{ type: 'text', text }, ...r.content] };
}

// ── Fields a browser tool does not take ─────────────────────────

/**
 * Which browser SynaBun drives is the owner's choice (Settings → Browser), and a session picks a MoreLogin profile for
 * itself only through the `morelogin` tool's "use" action (or browser_session create's own moreloginProfile), never
 * through an argument of a page tool. A tool argument naming one is refused, not silently dropped: before 2026-11-05 zod stripped unknown keys, so
 * `browser_navigate({ profile: "other" })` ran in the default browser and the model believed it had switched profile.
 * Mirrors OWNER_ONLY_BROWSER_FIELDS in neural-interface/lib/browser-automation-routes.js (the server refuses the same
 * names on a session create; neural-interface/tests/browser-automation-routes.test.mjs keeps the two lists equal).
 */
export const OWNER_ONLY_FIELDS: readonly string[] = Object.freeze([
  'connectMode', 'moreloginEnvId', 'attachSeed', 'openTabsInBackground',
  'config', 'profile', 'profileDir', 'profilePath', 'userDataDir', 'executablePath',
  'moreloginProfile', 'moreloginEnv', 'moreloginEnvironment', 'cdpUrl', 'wsEndpoint',
]);
const OWNER_ONLY = new Set(OWNER_ONLY_FIELDS);

/** Unknown keys of one call, attached by the validation step and read (and removed) by the tool's wrapper. */
const UNKNOWN_FIELDS = Symbol('synabun.unknownFields');

export class OwnerOnlyFieldsError extends Error {
  readonly code = 'OWNER_ONLY_FIELDS';
  readonly fields: string[];
  constructor(tool: string, fields: string[]) {
    const names = fields.map(f => `"${f}"`).join(', ');
    super(`OWNER_ONLY_FIELDS: ${tool} does not take ${names}. A browser tool works in the browser of the session that calls it and takes no such argument; the browser settings are the owner's (Settings → Browser). To work in another MoreLogin profile, call morelogin with action "use" (envId or name) first: your browser tools then drive that profile (only a profile the owner allowed agents to choose). Leave ${fields.length === 1 ? 'it' : 'them'} out and call ${tool} again. Nothing ran.`);
    this.name = 'OwnerOnlyFieldsError';
    this.fields = fields;
  }
}

/**
 * The keys of a call's raw arguments: owner-only ones refused (OwnerOnlyFieldsError), other unknown ones returned
 * (the call runs and its answer ends with a note). `known`: the tool's parameters.
 */
export function checkToolFields(tool: string, raw: unknown, known: ReadonlySet<string>): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const unknown = Object.keys(raw).filter(k => !known.has(k));
  const owner = unknown.filter(k => OWNER_ONLY.has(k));
  if (owner.length) throw new OwnerOnlyFieldsError(tool, owner);
  return unknown;
}

export function unknownFieldsNote(tool: string, fields: string[]): string {
  const names = fields.map(f => `"${f}"`).join(', ');
  return `(Note: ${tool} has no parameter ${names}; ${fields.length === 1 ? 'it was' : 'they were'} ignored.)`;
}

/** The parameter names of a raw zod shape (`{ url: z.string(), ... }`), or null for anything else. */
function shapeKeys(value: unknown): Set<string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if ('_def' in v || '_zod' in v) return null; // a schema, not a raw shape
  const values = Object.values(v);
  if (values.length && !values.every(x => !!x && typeof x === 'object' && ('_def' in (x as object) || '_zod' in (x as object)))) return null;
  return new Set(Object.keys(v));
}

type ValidatingServer = { validateToolInput?: (tool: unknown, args: unknown, toolName: string) => Promise<unknown> };
/** Per server: the tools registered through withRouteFlows and their parameter names. */
const checkedTools = new WeakMap<object, Map<string, Set<string>>>();

/**
 * The SDK validates a call's arguments before the handler sees them, and its zod objects drop unknown keys: the
 * handler can never tell. One wrapper per server, around its validation, reads the raw arguments of the browser
 * tools first (MCP SDK 1.29 McpServer.validateToolInput; tests/browser-tool-fields.test.ts runs it through a real
 * client, so an SDK that renames it fails there, not in production).
 */
function guardValidation(server: object): Map<string, Set<string>> {
  let tools = checkedTools.get(server);
  if (tools) return tools;
  tools = new Map();
  checkedTools.set(server, tools);
  const s = server as ValidatingServer;
  const original = s.validateToolInput;
  if (typeof original !== 'function') return tools;
  const known = tools;
  s.validateToolInput = async function (this: unknown, tool: unknown, args: unknown, toolName: string) {
    const params = known.get(toolName);
    const unknown = params ? checkToolFields(toolName, args, params) : [];
    const data = await original.call(this, tool, args, toolName);
    if (unknown.length && data && typeof data === 'object') {
      Object.defineProperty(data, UNKNOWN_FIELDS, { value: unknown, enumerable: false, configurable: true });
    }
    return data;
  };
  return tools;
}

/**
 * One browser tool call: in its route flow (a tool runRouteFlow wraps), with the notices of every replacement that
 * served it at the top of its answer, and a note at the end for parameters it does not have.
 */
export async function runBrowserTool<A>(
  tool: string,
  args: A,
  handler: (args: A, extra?: unknown) => unknown,
  extra?: unknown,
): Promise<unknown> {
  const unknown = args && typeof args === 'object' ? (args as Record<PropertyKey, unknown>)[UNKNOWN_FIELDS] as string[] | undefined : undefined;
  const scope = { notices: [] as RouteNotice[] };
  const value = await noticeScopes.run(scope, async () => {
    // browser_session, browser_batch and browser_cheatsheet have no route flow (runInRouteFlow calls them as they are).
    return runInRouteFlow(tool, args, handler, extra);
  });
  // A loss message that names its replacement already says it: the notice for that route would say it twice.
  const text = ((value as ToolResult | null)?.content || []).map(c => (typeof c.text === 'string' ? c.text : '')).join('\n');
  const notices = scope.notices.filter(n => !(n.to.tabId && text.includes(`A new tab replaced it: ${describeRoute(n.to)}`)));
  const noted = prependNotices(value, notices);
  return unknown?.length ? withNote(noted, unknownFieldsNote(tool, unknown)) : noted;
}

/**
 * The server a browser group registers its tools on: every handler runs through runBrowserTool (its route flow when
 * the tool has one, the replacement notices, the field check). Everything else about the server is the real one.
 */
export function withRouteFlows<S extends object>(server: S): S {
  const fields = guardValidation(server);
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'tool') {
        const tool = (target as { tool: (...a: unknown[]) => unknown }).tool;
        return (...a: unknown[]) => {
          const name = a[0];
          const last = a.length - 1;
          if (typeof name === 'string' && typeof a[last] === 'function') {
            const handler = a[last] as (args: unknown, extra?: unknown) => unknown;
            a[last] = (args: unknown, extra?: unknown) => runBrowserTool(name, args, handler, extra);
            const keys = a.slice(1, last).map(shapeKeys).find((k): k is Set<string> => !!k);
            if (keys) fields.set(name, keys);
          }
          return tool.apply(target, a);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
