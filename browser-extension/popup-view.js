// What the popup and the toolbar badge show, decided without a DOM (node --test loads this; popup.js and
// service-worker.js render it). docs/design/browser-extension is the approved design; docs/browser-extension-bridge.md
// is the behaviour, which nothing here changes: these functions only read what the service worker already reports.

/** The popup's states (data-state on #popup). */
export const POPUP_STATES = Object.freeze(['loading', 'connected', 'connecting', 'reconnecting', 'disconnected', 'unpaired', 'error']);

/**
 * The popup's state from the service worker's `status` answer.
 * `result`: the answer ({ status, connected, ... }), null when the extension did not answer, undefined before it was asked.
 * `paired`: whether a pairing credential is stored (the popup reads only its size, never its value); null when unknown.
 * The worker's status words are its own (service-worker.js): 'Connecting', 'Connected', 'Paused', 'Disconnected',
 * 'Disconnected — reconnecting', 'Not connected — …', 'Connection refused — …'.
 */
export function popupState(result, paired = null) {
  if (result === undefined) return 'loading';
  if (!result || typeof result !== 'object') return 'error';
  const status = typeof result.status === 'string' ? result.status : '';
  if (result.connected === true) return 'connected';
  if (status === 'Connecting') return 'connecting';
  const known = typeof paired === 'boolean' ? paired : status !== 'Disconnected';
  if (!known) return 'unpaired';
  if (status === 'Paused') return 'disconnected';
  // Paired and away: the worker retries by itself (its backoff); a plain 'Disconnected' is a worker about to connect.
  if (status === 'Disconnected') return 'connecting';
  return 'reconnecting';
}

/** Tone of each state: the status symbol's colour, never the only cue (a word and a symbol go with it). */
export function stateTone(state) {
  return { connected: 'good', disconnected: 'warn', reconnecting: 'warn', error: 'bad', unpaired: '', connecting: '', loading: '' }[state] ?? '';
}

/**
 * An address as the owner sees it: host and path only. The query and fragment (where sign-in challenges and tokens
 * ride) are never shown, in text, tooltip or accessible name. Non-web pages show their scheme only.
 */
export function displayUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return ''; }
  if (u.href === 'about:blank') return 'about:blank';
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`;
  }
  return `${u.protocol}//`;
}

/** A short, stable label for an agent the extension knows only by its opaque owner id. */
export function agentId(owner) {
  return String(owner || '').replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || '?';
}

/**
 * The tabs agents hold, grouped by agent (first appearance order, which is the inventory's order), each tab with
 * its shown title and address. `t` is the popup's translator.
 */
export function agentGroups(tabs = [], t = key => key) {
  const groups = new Map();
  for (const tab of tabs) {
    if (!tab?.owner) continue;
    const id = agentId(tab.owner);
    if (!groups.has(tab.owner)) groups.set(tab.owner, { owner: tab.owner, id, label: t('unknownAgent', { id }), mark: id.slice(0, 2), tabs: [] });
    groups.get(tab.owner).tabs.push({ handle: tab.handle, title: String(tab.title || '').trim() || t('untitledTab'), address: displayUrl(tab.url) });
  }
  return [...groups.values()];
}

/** "1 agent · 1 tab", "1 agent · 3 tabs", "2 agents · 5 tabs". */
export function activitySummary(groups, t = key => key) {
  const tabs = groups.reduce((sum, g) => sum + g.tabs.length, 0);
  if (!tabs) return '';
  if (tabs === 1) return t('oneTab');
  return groups.length === 1 ? t('oneAgent', { tabs }) : t('agentCount', { agents: groups.length, tabs });
}

/**
 * The popup's view of one status answer: which state, which sections, which actions.
 * `paired` as in popupState; `t` the translator.
 */
export function popupView(result, { paired = null, t = key => key } = {}) {
  const state = popupState(result, paired);
  const ok = !!result && typeof result === 'object';
  const full = ok ? result.fullControl !== false : true;
  const tabs = ok && Array.isArray(result.tabs) ? result.tabs : [];
  const groups = agentGroups(tabs, t);
  const live = state === 'connected';
  // The last tabs the worker knew stay listed while it is away, marked out of date, with their controls off.
  const stale = ['connecting', 'reconnecting', 'disconnected'].includes(state);
  const isPaired = !['unpaired', 'error', 'loading'].includes(state);
  const primary = { disconnected: 'resume', unpaired: 'connect', error: 'retry', reconnecting: 'open-app' }[state] || null;
  return {
    state, tone: stateTone(state), full, live, stale, paired: isPaired,
    title: t(state === 'loading' ? 'connecting' : state), help: t(`${state === 'loading' ? 'connecting' : state}Help`),
    primary,
    // The mode is the owner's and is switched here only while connected (the worker then tells the server).
    showMode: ok && state === 'connected',
    showActivity: ok && (live || (stale && groups.length > 0)),
    groups, summary: activitySummary(groups, t),
    // Restricted mode: what the owner shares. Full control shows none of it.
    showShared: ok && live && !full,
    sites: ok && Array.isArray(result.sites) ? result.sites.slice() : [],
    waiting: tabs.filter(tab => tab && !tab.owner).map(tab => ({ handle: tab.handle, title: String(tab.title || '').trim() || t('untitledTab'), address: displayUrl(tab.url) })),
    options: { allowNewTabs: ok && result.allowNewTabs === true, uploads: ok && result.uploads === true, downloads: ok && result.downloads === true },
    port: ok && Number.isInteger(result.port) ? result.port : 3345,
    // Disconnect (pause) while paired and not already paused; Reconnect is the status action when paused.
    canDisconnect: isPaired && state !== 'disconnected',
    canRevoke: isPaired,
    // The typed code: a fallback under a disclosure, only while not connected (docs/browser-extension-bridge.md: it stays).
    showPairCode: ['unpaired', 'reconnecting', 'disconnected', 'error'].includes(state),
    showFiles: isPaired,
  };
}

// ── The toolbar icon (service-worker.js) ──
/**
 * The status dot drawn into the toolbar icon's bottom-right corner (no badge text): the style guide's status tokens
 * (tokens.css): `--color-success` on, `--color-danger` off, ringed with `--color-background` so it reads on light
 * and dark toolbars. The PNGs in icons/ are pre-rendered with these colours; the contract test reads them back.
 */
export const STATUS_DOT = Object.freeze({ on: '#86efac', off: '#fca5a5', ring: '#050505' });
/** The toolbar icon per dot, for chrome.action.setIcon({ path }). The manifest's action.default_icon is `off`. */
export const STATUS_ICONS = Object.freeze({
  on: Object.freeze({ 16: 'icons/status-on-16.png', 32: 'icons/status-on-32.png', 48: 'icons/status-on-48.png' }),
  off: Object.freeze({ 16: 'icons/status-off-16.png', 32: 'icons/status-off-32.png', 48: 'icons/status-off-48.png' }),
});

/**
 * The toolbar icon for the worker's state. `connected` (an authenticated channel), `paired` (a credential), `paused`
 * (the owner's Disconnect), `connecting` (a socket opening), `refused` (handshakes the server refused in a row),
 * `controlled` (tabs agents hold, acknowledged in the inventory). Attention wins over the count.
 * The dot is green (`on`) only while connected to SynaBun, agents holding tabs or not; every other state, connecting
 * and reconnecting included, is red (`off`). The badge text is always empty; the exact state and the number of agent
 * tabs are said in words by `title`, the tooltip (the icon's accessible name in the toolbar).
 * Returns { state, dot, icon, text, title }.
 */
export function badgeFor({ connected = false, paired = false, paused = false, connecting = false, refused = 0, controlled = 0 } = {}, t = key => key) {
  const pick = (state, key, params) => {
    const dot = state === 'active' || state === 'idle' ? 'on' : 'off';
    return { state, dot, icon: STATUS_ICONS[dot], text: '', title: `SynaBun · ${t(key, params)}` };
  };
  if (connected) {
    if (controlled > 0) return pick('active', controlled === 1 ? 'badgeActiveOne' : 'badgeActive', { count: controlled });
    return pick('idle', 'badgeIdle');
  }
  if (connecting && !refused) return pick('connecting', paired ? 'badgeReconnecting' : 'badgeConnecting');
  if (!paired) return pick('unpaired', 'badgeUnpaired');
  if (paused) return pick('paused', 'badgeOff');
  if (refused >= 2) return pick('error', 'badgeError');
  return pick('reconnecting', 'badgeReconnecting');
}
