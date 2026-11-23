import { z } from 'zod/v3';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
import { useAnswer } from './morelogin.js';
import { extensionSetupMessage } from './browser-extension-setup.js';

const tabIdField = z.string().optional().describe('Target a specific tab within the session. Auto-resolved from environment if omitted.');

// ── browser_evaluate ──

export const browserEvaluateSchema = {
  script: z.string().optional().describe('JavaScript code to execute in the browser page context. The return value will be serialized to JSON.'),
  expression: z.string().optional().describe('Alias for "script" — accepted for compatibility with Playwright conventions.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserEvaluateDescription =
  'Execute JavaScript in the browser page context and return the result. Useful for reading DOM state, extracting data, or performing actions not covered by other tools. Write one expression; wrap statements in a function, (() => { …; return value; })(), which works in every SynaBun browser (the owner\'s everyday browser takes nothing else).';

export async function handleBrowserEvaluate(args: { script?: string; expression?: string; sessionId?: string; tabId?: string }) {
  const code = args.script || args.expression;
  if (!code) return text('Either "script" or "expression" is required.');

  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, code, resolved.tabId);
  // The owner's everyday browser needs a one-time setup before it runs page JavaScript: say that, not a bare code.
  if (result.error) return text(`Evaluate failed: ${extensionSetupMessage(result) || result.error}`);

  let msg: string;
  try {
    // Guard against undefined — JSON.stringify(undefined) returns undefined (not a string)
    const val = result.result ?? null;
    msg = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
  } catch {
    msg = String(result.result ?? 'undefined');
  }
  // The extension backend cuts a result longer than its cap: what came back is the beginning of its JSON text.
  if (result.truncated === true) {
    const whole = typeof result.valueLength === 'number' ? ` of ${result.valueLength}` : '';
    msg += `\n[truncated: the first ${msg.length}${whole} characters of the result's JSON text. Return less, or read it in parts.]`;
  }

  return text(msg);
}

// ── browser_wait ──

export const browserWaitSchema = {
  selector: z.string().optional().describe('CSS selector to wait for. If omitted and loadState also omitted, waits for timeout.'),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().describe('Element state to wait for (default: "visible"). Only used with selector.'),
  loadState: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe(
    'Page load state to wait for. Use "networkidle" after posting a tweet to confirm XHR requests settled. Takes priority over selector when provided.'
  ),
  timeout: z.coerce.number().optional().describe('Timeout in ms (default: 10000 for element waits, 15000 for loadState).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserWaitDescription =
  'Wait for an element to reach a certain state, a page load state, or a fixed timeout. Useful after navigation or clicks that trigger async content loading. Use loadState="networkidle" after posting on Twitter/X or after navigation to ensure all async requests have settled.';

export async function handleBrowserWait(args: {
  selector?: string;
  state?: string;
  loadState?: string;
  timeout?: number;
  sessionId?: string;
  tabId?: string;
}) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.waitFor(resolved.sessionId, {
    selector: args.selector,
    state: args.state,
    loadState: args.loadState,
    timeout: args.timeout,
  }, resolved.tabId);
  if (result.error) return text(`Wait failed: ${extensionSetupMessage(result) || result.error}`);

  if (args.loadState) {
    if (ni.isBrowserCompactMode()) return text(`Page reached "${args.loadState}"`);
    return text(`Page reached "${args.loadState}" — now at ${result.url} "${result.title}"`);
  }
  if (args.selector) {
    return text(`"${args.selector}" is now ${result.state}`);
  }
  if (ni.isBrowserCompactMode()) return text(`Waited ${args.timeout || 1000}ms`);
  return text(`Waited ${args.timeout || 1000}ms — now at ${result.url} "${result.title}"`);
}

// ── browser_session ──

export const browserSessionSchema = {
  action: z.enum(['list', 'status', 'create', 'close']).describe('"list" = the open sessions with your own tabs (id, address, title; your current tab marked), and in the owner\'s everyday browser with full control also the owner\'s open tabs you can take over, "status" = the session and tab your browser calls use now, with its address and whether SynaBun replaced a lost tab, "create" = open a new browser tab of your own (starting the browser if needed) and continue there, "close" = close a session.'),
  url: z.string().optional().describe('Starting URL for "create" action (default: about:blank).'),
  sessionId: z.string().optional().describe('Session ID for "close" action. Required for close when multiple sessions exist (or pass your tabId).'),
  tabId: z.string().optional().describe('Your tab id, as the other browser tools take it. "status" / "list": says whether it is still your current tab (a lost tab names the tab that replaced it). "close": closes only this tab of yours; a tab that is not yours is refused and nothing is closed. "create": in the owner\'s everyday browser with full control, the id of one of the owner\'s open tabs that "list" shows: you take that tab over (it becomes yours until you close it, and closing it leaves it open for the owner) instead of opening a new one. Otherwise "create" ignores it and opens a new tab of your own.'),
  moreloginProfile: z.string().optional().describe('"create" only: the MoreLogin profile (its id or its name, as the morelogin tool\'s "list" shows it) to work in from now on. The new tab opens in that profile and your later browser calls stay there; the default browser and other sessions are not touched. "default" goes back to the default profile. The same as calling morelogin with action "use" first, with the same rule: only a profile the owner allowed agents to choose (morelogin "list" says which); a refusal for a profile not on that list means tell the user to switch it on in SynaBun\'s Settings, never another profile. Omit it to stay in the profile you work in.'),
};

export const browserSessionDescription =
  'Manage browser sessions — list open sessions and your tabs in them, see which tab you work in ("status"), create a new one, or close one (pass your tabId to close only that tab of yours). Use "status" to find your current tab id. When a browser tool\'s answer starts with "Your tab … was lost; a replacement tab … is open", continue in that tab (no create). Use "create" when your browser session or tab was lost (closed, disconnected, "Session not found", "Tab … not found"): it opens a new tab of your own in the SynaBun browser, starting the browser when it is not running, and in a loop or a dispatched run your next browser calls go to it. Only if create fails too, stop and report it; never switch to another browser. To work in a MoreLogin profile other than the default (a second account, while other automations use the default one), pass moreloginProfile to "create" or call morelogin with action "use": your browser tools then drive that profile in a tab of your own and nobody else is moved (only a profile the owner allowed agents to choose; when it is refused as not on the owner\'s list, tell the user to switch it on in SynaBun\'s Settings and stop). Closing a session other automations still use closes only your own tab in it; the session stays open for them. In the owner\'s everyday browser (the extension, full control) "list" also shows the owner\'s open tabs; "create" with one of their ids as tabId takes that tab over.';

export async function handleBrowserSession(args: {
  action: string;
  url?: string;
  sessionId?: string;
  tabId?: string;
  moreloginProfile?: string;
}) {
  if (args.moreloginProfile && args.action !== 'create') {
    return text('moreloginProfile goes with action "create" (or call morelogin with action "use"). Nothing ran.');
  }
  if (args.action === 'list' || args.action === 'status') {
    const status = await ni.browserRouteStatus();
    if (status.error) return text(`${args.action === 'list' ? 'List' : 'Status'} failed: ${status.error}`);
    const body = args.action === 'list' ? formatSessionList(status) : formatRouteStatus(status);
    const note = args.tabId ? namedTabLine(status, args.tabId) : null;
    return text(note ? `${body}\n${note}` : body);
  }

  // Taking over one of the owner's tabs in the everyday browser (the extension bridge in full control): only when the
  // server lists owner tabs. Everywhere else create ignores tabId, as it always did, and opens a tab of the caller's own.
  const takeOver = args.action === 'create' && args.tabId && !args.moreloginProfile ? await ni.browserRouteStatus() : null;
  const listed = takeOver && !takeOver.error ? takeOver.ownerTabs : undefined;
  const target = listed?.find(t => t.id === args.tabId && !t.owner);
  if (listed && !target && !takeOver!.sessions.some(s => s.tabs.some(t => t.id === args.tabId))) {
    return text(`Create refused: tab ${args.tabId} is not one of the owner's open tabs you can take over (browser_session list marks available tabs and their owners). Nothing changed. Call create without tabId to open a new tab of your own.`);
  }
  if (target && args.tabId) {
    const result = await ni.createSession(args.url, args.tabId);
    if (ni.isBrowserStarting(result)) return text(String(result.error || 'The browser is still starting. Call browser_session with action "create" again in a moment.'));
    if (result.error) return text(`Take-over failed: ${result.error}\nNothing of yours changed if the tab was refused. Never switch to another browser or tool.`);
    const sessionId = String(result.sessionId);
    const tabId = typeof result.tabId === 'string' ? result.tabId : args.tabId;
    const at = typeof result.url === 'string' && result.url !== 'about:blank' ? result.url : target.url;
    const lines = [`Took over the owner's tab ${tabId} (session ${sessionId}) at ${at || 'about:blank'}${target.title ? ` "${target.title}"` : ''}. It is yours until you close it; closing it leaves it open for the owner.`];
    lines.push(result.repinned === true
      ? `This run's browser now works there: your next browser calls go to it with or without ids (pass sessionId "${sessionId}" and tabId "${tabId}" if you pass ids; never the old ones).`
      : `Continue there: pass sessionId "${sessionId}" and tabId "${tabId}" to your next browser calls.`);
    if (typeof result.navigateError === 'string') lines.push(`Opening ${args.url} in it failed: ${result.navigateError}. Open it with browser_navigate.`);
    return text(lines.join('\n'));
  }

  if (args.action === 'create') {
    let profileLine: string | null = null;
    if (args.moreloginProfile) {
      const wanted = args.moreloginProfile.trim();
      const chosen = await ni.useSessionProfile(wanted.toLowerCase() === 'default' ? { default: true } : { profile: wanted });
      if (chosen.error) return text(`Create failed: the MoreLogin profile "${wanted}" could not be chosen: ${chosen.error}\nNothing changed: you still work where you did. Never fall back to another profile or browser by yourself.`);
      profileLine = useAnswer(chosen).split('\n')[0];
    }
    const result = await ni.createSession(args.url);
    // A cold browser start still running: nothing failed, and the next create returns that same start.
    if (ni.isBrowserStarting(result)) return text([profileLine, String(result.error || 'The browser is still starting. Call browser_session with action "create" again in a moment.')].filter(Boolean).join('\n'));
    if (result.error) return text(`${profileLine ? `${profileLine}\n` : ''}Create failed: ${result.error}\nThe SynaBun browser could not open a new session: stop and report this. Never switch to another browser or tool.`);
    const sessionId = String(result.sessionId);
    const tabId = typeof result.tabId === 'string' ? result.tabId : null;
    const ids = `sessionId "${sessionId}"${tabId ? ` and tabId "${tabId}"` : ''}`;
    const lines = [...(profileLine ? [profileLine] : []), `Created session ${sessionId}${tabId ? `, tab ${tabId}` : ''} at ${typeof result.url === 'string' ? result.url : args.url || 'about:blank'}.`];
    lines.push(result.repinned === true
      ? `This run's browser now works there: your next browser calls go to it with or without ids (pass ${ids} if you pass ids; never the old ones).`
      : `Continue there: pass ${ids} to your next browser calls.`);
    // Created, but MoreLogin refused the start URL (e.g. a localhost port missing from Port scan protection).
    if (result.moreLoginBlocked === true && typeof result.notice === 'string') lines.push(result.notice);
    if (typeof result.navigateError === 'string') lines.push(`Opening ${args.url} in it failed: ${result.navigateError}. Open it with browser_navigate.`);
    return text(lines.join('\n'));
  }

  if (args.action === 'close') {
    let named = args.sessionId;
    if (args.tabId) {
      // A tab named: only one of the caller's own (browserRouteStatus lists nobody else's), and it picks the session.
      const status = await ni.browserRouteStatus();
      if (status.error) return text(`Close failed: ${status.error}`);
      const owner = status.sessions.find(s => s.tabs.some(t => t.id === args.tabId));
      if (!owner) {
        if (isGoneTab(status, args.tabId)) return text(`Tab ${args.tabId} is already gone; nothing was closed.${status.current?.open && status.current.tabId ? ` Your current tab is ${status.current.tabId}.` : ''}`);
        return text(`Close refused: tab ${args.tabId} is not one of your tabs. You can close only your own tab; nothing was closed. Call browser_session with action "status" to see your tab id.`);
      }
      if (named && named !== owner.id) return text(`Close refused: your tab ${args.tabId} is in session ${owner.id}, not ${named}; nothing was closed.`);
      named = owner.id;
    }
    const resolved = await ni.resolveSession(named);
    if ('error' in resolved) return text(resolved.error);

    const result = await ni.closeSession(resolved.sessionId, args.tabId);
    if (result.error) return text(`Close failed: ${result.error}`);
    if (result.profileMode === 'extension') {
      const count = Array.isArray(result.releasedTabIds) ? result.releasedTabIds.length : result.releasedTabId ? 1 : 0;
      return text(`Released ${count} of your tabs from session ${resolved.sessionId}${args.tabId ? ` (tab ${args.tabId})` : ''}. Agent-opened tabs were closed; taken-over tabs stay open for the owner. Other agents' tabs stay open.`);
    }
    if (result.sessionKept === true) {
      // Other automations (scheduled runs) work in tabs of this browser: the server closed only this caller's tab.
      const others = Number(result.otherOwners) || 0;
      const released = typeof result.releasedTabId === 'string' ? `Only your tab ${result.releasedTabId} was closed` : 'You had no tab of your own in it, so nothing was closed';
      return text(`Session ${resolved.sessionId} stays open: ${others} other automation${others === 1 ? '' : 's'} still use${others === 1 ? 's' : ''} tabs in it. ${released}. Do not close it again. Your next browser call opens a new tab of your own, and its answer starts with that tab's id ("a replacement tab … is open"): continue there, without browser_session create.`);
    }
    return text(`Closed session ${resolved.sessionId}`);
  }

  return text(`Unknown action "${args.action}". Use "list", "status", "create", or "close".`);
}

/** Lost tabs of the caller's that the route status knows about. */
function isGoneTab(status: ni.BrowserRouteStatus, tabId: string): boolean {
  return status.replacedTabs.includes(tabId)
    || status.lost?.tabId === tabId
    || status.movedFrom?.tabId === tabId
    || (!!status.current && !status.current.open && status.current.tabId === tabId);
}

/** What a tabId passed to list / status means for the caller: only its own tabs are ever described. */
export function namedTabLine(status: ni.BrowserRouteStatus, tabId: string): string | null {
  const current = status.current;
  if (current?.open && current.tabId === tabId) return null;
  if (isGoneTab(status, tabId)) {
    return current?.open && current.tabId
      ? `Tab ${tabId} you passed is gone; tab ${current.tabId} (session ${current.sessionId}) replaced it. Use tabId ${current.tabId}.`
      : `Tab ${tabId} you passed is gone. Your next browser call opens a new tab of your own and names it.`;
  }
  if (status.sessions.some(s => s.tabs.some(t => t.id === tabId))) {
    return `Tab ${tabId} you passed is one of your tabs, but not the current one${current?.open && current.tabId ? ` (${current.tabId})` : ''}.`;
  }
  return `Tab ${tabId} you passed is not one of your tabs; it was ignored.`;
}

const quoteTitle = (title: string | undefined) => (title ? ` "${title}"` : '');
/**
 * A tab's address as browser_session list shows it: origin and path, never the query string or fragment, which carry
 * sign-in and challenge tokens (`?jsc_token=…`, `?__cf_chl_rt_tk=…`). Navigate, snapshot and content keep the full URL
 * of the caller's own page; only the listing is cut. Anything that is not an http(s) address shows as itself when it is
 * about:blank, else as nothing.
 */
export function listedAddress(url: string | undefined): string {
  if (!url) return 'about:blank';
  if (url === 'about:blank') return url;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.origin}${u.pathname}` : u.protocol === 'about:' ? `about:${u.pathname}` : `${u.protocol}…`;
  } catch { return '(address withheld)'; }
}
const otherTabsText = (n: number) => `${n} tab${n === 1 ? '' : 's'} of other automations or the owner`;

/** browser_session list: every session the caller can see, with its own tabs only. */
export function formatSessionList(status: ni.BrowserRouteStatus): string {
  const owners = ownerTabLines(status);
  if (status.sessions.length === 0) return ['No browser sessions open. browser_navigate opens one by itself.', ...owners].join('\n');
  const lines = [`${status.sessions.length} session(s); only your own tabs are listed:`];
  for (const session of status.sessions) {
    lines.push(`  ${session.id}${session.servesDefault ? '' : ` — not ${status.profile ? 'the profile you work in' : 'the default browser'} (${session.profile}); SynaBun's browser tools do not use it`}`);
    for (const tab of session.tabs) {
      const isCurrent = status.current?.open && status.current.sessionId === session.id && status.current.tabId === tab.id;
      lines.push(`    tab ${tab.id} — ${listedAddress(tab.url)}${quoteTitle(tab.title)}${isCurrent ? '  ← your current tab' : ''}`);
    }
    if (!session.tabs.length) lines.push(`    no tab of yours${session.otherTabs ? ` (+${otherTabsText(session.otherTabs)})` : ''}`);
    else if (session.otherTabs) lines.push(`    +${otherTabsText(session.otherTabs)}`);
  }
  if (status.current && !status.current.open) lines.push(lostTabLine(status.current));
  else if (!status.current) lines.push('You have no tab of your own yet: browser_navigate opens one.');
  if (status.profile) lines.push(profileLineOf(status.profile));
  lines.push(...owners);
  return lines.join('\n');
}

/** The owner's open tabs in the everyday browser (full control), which create with that tabId takes over. */
const OWNER_TABS_SHOWN = 200;
function ownerTabLines(status: ni.BrowserRouteStatus): string[] {
  if (!status.ownerTabs) return [];
  if (!status.ownerTabs.length) return ['The owner\'s everyday browser (full control) has no other open tab you can take over.'];
  const lines = [`The owner's open tabs in the everyday browser (full control); create with an available tabId takes it over:`];
  for (const tab of status.ownerTabs.slice(0, OWNER_TABS_SHOWN)) lines.push(`    tab ${tab.id} — ${listedAddress(tab.url)}${quoteTitle(tab.title)} — ${tab.owner === 'you' ? 'yours' : tab.owner ? `held by ${tab.owner}` : 'owner; available'}`);
  if (status.ownerTabs.length > OWNER_TABS_SHOWN) lines.push(`    +${status.ownerTabs.length - OWNER_TABS_SHOWN} more`);
  return lines;
}

/** The profile a caller works in when it is not the default. */
function profileLineOf(profile: NonNullable<ni.BrowserRouteStatus['profile']>): string {
  return `Profile: you work in MoreLogin profile ${profile.name ? `"${profile.name}" (env ${profile.envId})` : `env ${profile.envId}`}, not the default one (morelogin "use" changes it; envId "default" goes back).`;
}

function lostTabLine(current: NonNullable<ni.BrowserRouteStatus['current']>): string {
  return `Your tab ${current.tabId || '(none)'} of session ${current.sessionId} is gone. Your next browser call opens a new tab of your own, and its answer starts with that tab's id: continue there. Call browser_session create only if a browser call fails because the tab is gone and announces no replacement.`;
}

/** browser_session status: the route the caller's next browser call uses, its page, and what replaced what. */
export function formatRouteStatus(status: ni.BrowserRouteStatus): string {
  const current = status.current;
  const withProfile = (line: string) => (status.profile ? `${line}\n${profileLineOf(status.profile)}` : line);
  if (!current) {
    if (status.lost) return withProfile(`Your tab ${status.lost.tabId || '(none)'} of session ${status.lost.sessionId} is gone and no tab replaced it yet. Your next browser call opens a new tab of your own, and its answer starts with that tab's id.`);
    return withProfile('You have no browser tab yet: browser_navigate opens one (no browser_session create needed).');
  }
  if (!current.open) return withProfile(lostTabLine(current));
  const lines = [
    `Current session: ${current.sessionId}`,
    `Current tab: ${current.tabId}`,
    `Page: ${current.url || 'about:blank'}${quoteTitle(current.title)}`,
  ];
  if (status.replacedTabs.length) {
    lines.push(`Replaced: yes. This tab replaced your lost tab${status.replacedTabs.length === 1 ? '' : 's'} ${status.replacedTabs.join(', ')}; keep using tabId ${current.tabId}.`);
  } else if (status.movedFromPin) {
    // Only a move from a tab the run knew: the route the server recorded for a fresh run is its launch route, not one.
    const from = status.movedFrom?.tabId && status.movedFrom.tabId !== current.tabId ? ` from tab ${status.movedFrom.tabId}` : '';
    lines.push(`Replaced: yes. SynaBun moved your run's browser to this tab${from} (a recovery or your own create); keep using tabId ${current.tabId}.`);
  } else {
    lines.push('Replaced: no.');
  }
  if (status.lost && !(status.lost.sessionId === current.sessionId && status.lost.tabId === current.tabId)) {
    lines.push(`Your tab ${status.lost.tabId || '(none)'} of session ${status.lost.sessionId} went away; your next browser call may open a new tab and will say so.`);
  }
  if (status.profile) lines.push(profileLineOf(status.profile));
  return lines.join('\n');
}
