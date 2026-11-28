// The "Connect your browser" page's decisions (public/extension-setup.html; docs/browser-extension-bridge.md →
// One-button setup). DOM-free and import-free: node --test loads it. The page (es-page.js) renders what this returns.
//
// Page states (data-state on <main>): the server's setup state (idle, downloading, waiting-for-extension, pairing,
// connected, unsupported, error), with one page-only refinement: `extension-found` while the server still waits but the
// extension's content script has announced itself on this page (it then gets the one-time token and pairs).

/** The server's setup states, and the page's own. */
export const SETUP_STATES = Object.freeze(['idle', 'downloading', 'waiting-for-extension', 'pairing', 'connected', 'unsupported', 'error']);
export const PAGE_STATES = Object.freeze([...SETUP_STATES, 'extension-found']);
/** What the extension's service worker may answer the content script (setup-content.js writes it to data-synabun-pair). */
export const PAIR_ANSWERS = Object.freeze(['sent', 'started', 'ALREADY_CONNECTED', 'ALREADY_PAIRED', 'PAUSED', 'BUSY', 'NOT_OWNED', 'INVALID_MESSAGE', 'REFUSED', 'EXTENSION_UNAVAILABLE']);
/** Error codes the page has a sentence for (browserExtension.setup.error<CODE>); any other is `error`. */
export const SETUP_ERRORS = Object.freeze(['SETUP_EXPIRED', 'EXTENSION_FOLDER_FAILED', 'EXTENSION_FOLDER_UNSAFE','EXTENSION_DOWNLOAD_OFFLINE', 'EXTENSION_DOWNLOAD_UNAVAILABLE', 'EXTENSION_VERIFY_FAILED', 'OPEN_FAILED', 'SETUP_NOT_ACTIVE', 'SETUP_TICKETS_USED', 'PAGE_SECRET_REQUIRED', 'PEER_UNAVAILABLE']);
/** The errors of the extension's download (the package was not fetched or did not verify): the page offers to try again. */
export const DOWNLOAD_ERRORS = Object.freeze(['EXTENSION_DOWNLOAD_OFFLINE', 'EXTENSION_DOWNLOAD_UNAVAILABLE', 'EXTENSION_VERIFY_FAILED']);
/** Answers after which the page asks for a fresh ticket (a new token) once its wait has passed. */
const RETRY_AFTER = Object.freeze({ ALREADY_PAIRED: 8000, BUSY: 2500, REFUSED: 5000, EXTENSION_UNAVAILABLE: 5000, started: 20000 });

/**
 * The page's view of a status (GET /api/browser/extension/setup/status) and what the page saw of the extension:
 * `extensionVersion` (data-synabun-extension, '' when absent) and `pairAnswer` (data-synabun-pair).
 * Returns { state, title, lead, steps, browser, extensionsUrl, folder, alternatives, live, tone, reloadNeeded, reloadRepaired, updateNeeded,
 * progress, restart, restartLabel, companion, restartBody, focus }. `companion`: the status says `guided` (the steps are in
 * SynaBun Settings); `restartBody`: what "Start again" sends to …/setup/start. `focus`: the page was opened by the
 * guide's "Copy address & open" (?focus=1) only to bring the browser forward for the paste that replaces it: it shows
 * where to paste, never pairs (no token, no "Extension found") and starts nothing.
 * Strings are i18n keys under browserExtension.setup (the page translates them); `params` fill their {placeholders}.
 */
export function setupView(status = {}, { extensionVersion = '', pairAnswer = '', focus = false } = {}) {
  const server = SETUP_STATES.includes(status.state) ? status.state : 'error';
  const found = !!extensionVersion;
  const state = server === 'waiting-for-extension' && found && !focus ? 'extension-found' : server;
  const browser = status.browser || null;
  const name = browser?.name || '';
  const extensionsUrl = browser?.supported ? browser.extensionsUrl || null : null;
  // The three steps no app may do for the owner, then the pairing SynaBun does.
  const installed = found || ['pairing', 'connected'].includes(server);
  // Developer mode sits in a different place per browser (docs/design/browser-extension → Browser-specific installation).
  const developer = { edge: 'stepDeveloperEdge', opera: 'stepDeveloperOpera', arc: 'stepDeveloperOther', vivaldi: 'stepDeveloperOther' }[browser?.id] || 'stepDeveloper';
  const steps = [
    { key: 'stepOpen', title: 'stepOpenTitle', params: { url: extensionsUrl || '' }, done: installed },
    { key: developer, title: 'stepDeveloperTitle', params: {}, done: installed },
    { key: 'stepLoad', title: 'stepLoadTitle', params: {}, done: installed },
    { key: 'stepPair', title: 'stepPairTitle', params: {}, done: server === 'connected' },
  ];
  // "Open in X instead": the installed supported browsers other than the one this setup uses.
  const alternatives = (status.installedBrowsers || []).filter(b => b?.supported && b.id !== browser?.id).map(b => ({ id: b.id, name: b.name }));
  const live = {
    idle: 'liveIdle', downloading: 'liveDownloading', 'waiting-for-extension': 'liveWaiting', 'extension-found': PAIR_ANSWERS.includes(pairAnswer) && pairAnswer !== 'sent' && pairAnswer !== 'started' ? `answer${pairAnswer}` : 'liveFound',
    pairing: 'livePairing', connected: 'liveConnected', unsupported: 'liveUnsupported', error: `error${SETUP_ERRORS.includes(status.code) ? status.code : ''}`,
  }[state];
  const tone = state === 'connected' ? 'ok' : state === 'error' || state === 'unsupported' ? 'err' : state === 'idle' ? '' : 'warn';
  // No steps while the extension is on its way: there is no folder to load yet.
  const showSteps = !['unsupported', 'idle', 'downloading'].includes(state) && !(state === 'error' && !status.folder);
  const downloadFailed = state === 'error' && DOWNLOAD_ERRORS.includes(status.code);
  // The bytes so far, in whole KB (the page shows them beside the status; never in the live region, which would be read out at every poll).
  const kb = n => Math.max(0, Math.round((Number(n) || 0) / 1024));
  const progress = state === 'downloading' && status.download && Number(status.download.total) > 0 ? { received: kb(Math.min(status.download.received, status.download.total)), total: kb(status.download.total) } : null;
  // The guide (the steps beside the status) while the owner installs; one result card once there is nothing to do there.
  const layout = showSteps && state !== 'connected' ? 'guide' : 'result';
  const statusTitle = { downloading: 'downloadingTitle', 'waiting-for-extension': 'waitingTitle', 'extension-found': 'foundTitle', pairing: 'pairingTitle', connected: 'titleConnected',
    unsupported: 'titleUnsupported', idle: 'idleTitle', error: downloadFailed ? 'downloadErrorTitle' : 'errorTitle' }[state];
  // The Settings guide's companion (a setup started with `present: 'none'`, status `guided`): the steps are in SynaBun
  // Settings, so this page is one card with the live status only (no steps, folder or other browsers), and it stays
  // open to pair the extension by itself. "Start again" here starts the guide's kind of setup for the same browser,
  // which opens nothing.
  const companion = status.guided === true || focus;
  const installedIds = (status.installedBrowsers || []).filter(b => b?.supported).map(b => b.id);
  const restartBody = companion ? { present: 'none', ...(browser?.supported && installedIds.includes(browser.id) ? { browser: browser.id } : {}) } : {};
  return {
    companion, restartBody, focus,
    layout: companion ? 'result' : layout, statusTitle, eyebrow: name ? 'eyebrow' : '',
    help: state === 'connected' ? 'connectedHelp' : state === 'downloading' ? 'downloadingHelp' : '',
    progress,
    state, title: focus ? 'focusTitle' : companion ? 'companionTitle' : state === 'connected' ? 'titleConnected' : state === 'unsupported' ? 'titleUnsupported' : 'title',
    lead: focus ? 'focusLead' : companion ? 'companionLead' : state === 'unsupported' ? 'leadUnsupported' : 'lead', steps, browser: name, extensionsUrl,
    folder: !companion && typeof status.folder === 'string' ? status.folder : '', alternatives: companion ? [] : alternatives, live, liveParams: { browser: name }, tone,
    reloadNeeded: status.reloadNeeded === true,
    // SynaBun replaced files that were not its extension: the same Reload, in the words of a repair.
    reloadRepaired: status.reloadNeeded === true && status.reloadRepaired === true,
    // The folder holds an older extension than this release's: SynaBun downloads the new one; a Reload comes after.
    updateNeeded: status.updateNeeded === true && status.reloadNeeded !== true,
    showSteps: showSteps && !companion,
    // What the page offers: start again (idle, error), back to SynaBun and the pin tip (connected).
    restart: !focus && ['error', 'idle'].includes(state), back: state === 'connected', pinTip: state === 'connected',
    // A download that failed is tried again by the same button, under its own words.
    restartLabel: downloadFailed ? 'retryDownload' : 'restart',
    // "Open in X instead" while there is still something to install here; never once pairing began, never beside the guide.
    showAlternatives: !companion && alternatives.length > 0 && !['pairing', 'connected'].includes(state),
  };
}
/** The words for "show the folder" on this computer: Finder, Explorer or the file manager. */
export function revealKey(platform = '') {
  const p = String(platform || '').toLowerCase();
  return /mac|darwin|iphone|ipad/.test(p) ? 'showFolderMac' : /win/.test(p) ? 'showFolderWindows' : /linux|x11|cros|bsd/.test(p) ? 'showFolderLinux' : 'showFolder';
}
/**
 * Whether the page should ask for a (new) ticket now: the server waits for the extension, the extension is on the
 * page, and either no token was offered yet or the extension's answer calls for another try after its wait.
 * `offeredAt`: when the current token was put on the page (0: never). `now`: the clock.
 */
export function wantsTicket(status = {}, { extensionVersion = '', pairAnswer = '', offeredAt = 0, now = Date.now(), tickets = 0, maxTickets = 5 } = {}) {
  if (status.state !== 'waiting-for-extension' || !extensionVersion || tickets >= maxTickets) return false;
  if (!offeredAt) return true;
  const wait = RETRY_AFTER[pairAnswer];
  return wait !== undefined && now - offeredAt >= wait;
}

/** How long a newer pairing page keeps its turn without being heard from (it speaks at every poll, 1.5 s). */
export const PEER_SILENT_MS = 5000;
/**
 * Which of SynaBun's pairing pages asks for tokens (es-page.js). The pairing page may be open more than once (the
 * guide's companion, then Pair in <Browser>): each would ask for its own token, and each token replaces the last, so
 * they would undo each other's pairing and spend the setup's five tokens. The pages that see the extension say so on
 * `channel` (a BroadcastChannel of this origin; null: the page is alone) and only the newest of them asks. `here()`:
 * this page sees the extension (at every poll); `gone()`: it is leaving; `mine()`: no newer page was heard from in the
 * last `silentMs`. A message that is not one of these two shapes is ignored.
 */
export function pageTurns({ id, born, channel = null, now = Date.now, silentMs = PEER_SILENT_MS }) {
  const newer = new Map();
  channel?.addEventListener?.('message', ({ data } = {}) => {
    if (!data || typeof data !== 'object' || typeof data.id !== 'string' || data.id === id) return;
    if (data.type === 'gone') newer.delete(data.id);
    else if (data.type === 'here' && Number.isFinite(data.born) && (data.born > born || (data.born === born && data.id > id))) newer.set(data.id, now());
  });
  const say = message => { try { channel?.postMessage?.(message); } catch { /* a closed channel: alone */ } };
  return {
    here: () => say({ type: 'here', id, born }),
    gone: () => say({ type: 'gone', id }),
    mine() {
      const at = now();
      for (const [peer, heard] of newer) if (at - heard > silentMs) newer.delete(peer);
      return newer.size === 0;
    },
  };
}

/**
 * The page's translator: the active locale's strings with English behind them, key by key, `{name}` filled from
 * params. The page loads the two JSON files itself (es-page.js), never the app's i18n module: that one brings the
 * app's server-synced storage, which this page must not read or write.
 */
export function pageLocale(languages = []) {
  return (Array.isArray(languages) ? languages : [languages]).some(l => /^pt\b/i.test(String(l))) ? 'pt-BR' : 'en';
}
export function makeTranslator(messages = {}, fallback = {}) {
  const find = (tree, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree);
  return (key, params) => {
    let value = find(messages, key);
    if (typeof value !== 'string') value = find(fallback, key);
    if (typeof value !== 'string') return key;
    return params ? value.replace(/\{(\w+)\}/g, (all, name) => (params[name] != null ? String(params[name]) : all)) : value;
  };
}
