// Settings → Browser → My browser · use the extension: what the card and its six-step guide decide, without the DOM
// (node --test loads this file; settings-browser-extension.js renders what it returns). No imports.
//
// The finish line is not "a socket is open". It is: the expected extension, in the browser the owner chose, on a live
// bridge, running the folder's current copy, and reporting that the browser lets it use user scripts (the extension's
// own probe, browser-extension/service-worker.js: it calls chrome.userScripts.getScripts() and looks for `execute`,
// and never runs a script in a tab). Anything short of that is said as the step it still needs.
//
// Evidence comes from two reads: GET /api/browser/extension (`connected`, `paired`, `extensionVersion`, `reloadNeeded`,
// `capabilities`: the current peer's last report or null) and GET …/setup/status (`state`, `code`, `browser`,
// `pairedThrough`: the browser whose setup made the pairing). An extension from before the report (1.5.0) sends no
// `capabilities`: its scripts access is unknown, never assumed. A server from before the report (one not restarted
// after an update) has no `capabilities` key at all: its connection is only "connected", never a legacy peer.
//
// A setup's download error belongs to that setup (the guide's Step 4, Advanced): a live bridge is never shown as
// "Offline" or "Package unavailable" because a Repair or a Set up after it could not download.

/** The guide's pages, in order. Page 7 is Ready. */
export const GUIDE_STEPS = Object.freeze(['open', 'developer', 'load', 'folder', 'details', 'scripts']);
export const READY_STEP = GUIDE_STEPS.length + 1;
/** The first extension version that reports its scripts capability. */
export const CAPABILITY_VERSION = '1.6.0';
/** The setup's download errors, each with its own stage. */
const DOWNLOAD_STAGES = Object.freeze({ EXTENSION_DOWNLOAD_OFFLINE: 'offline', EXTENSION_DOWNLOAD_UNAVAILABLE: 'package-unavailable', EXTENSION_VERIFY_FAILED: 'verification-failed' });
/**
 * Every stage the card can be in. The ladder is not-set-up → detected → allow-scripts → ready; the rest say why the
 * ladder stopped. `rung`: how far up the ladder the stage is (the status symbol); `step`: the guide page that resolves it.
 */
export const STAGES = Object.freeze({
  loading: { rung: 0, tone: '', step: 1 },
  'not-set-up': { rung: 0, tone: '', step: 1 },
  downloading: { rung: 0, tone: 'sync', step: 4 },
  offline: { rung: 0, tone: 'err', step: 4 },
  'package-unavailable': { rung: 0, tone: 'err', step: 4 },
  'verification-failed': { rung: 0, tone: 'err', step: 4 },
  pairing: { rung: 0, tone: 'sync', step: 4 },
  disconnected: { rung: 0, tone: 'warn', step: 1 },
  'other-browser': { rung: 0, tone: 'warn', step: 1 },
  detected: { rung: 1, tone: 'sync', step: 5 },
  'allow-scripts': { rung: 2, tone: 'warn', step: 6 },
  'reload-required': { rung: 1, tone: 'warn', step: 6 },
  'browser-update': { rung: 1, tone: 'err', step: 6 },
  'legacy-peer': { rung: 1, tone: 'warn', step: 6 },
  // Connected, through a server that cannot report what the extension may do (it predates the report): no action.
  connected: { rung: 1, tone: 'ok', step: READY_STEP },
  ready: { rung: 3, tone: 'ok', step: READY_STEP },
  error: { rung: 0, tone: 'err', step: 1 },
});

/** a.b.c version compare: negative, 0 or positive (missing parts are 0). */
export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => Number.parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

// Which installed-browser ids a reported brand can be. A Chromium build that names only "Chromium" may be Chromium,
// Arc or Vivaldi (both hide their own name from the brand list), so it rules out only the browsers that do name themselves.
const BRAND_IDS = Object.freeze([
  [/^brave$/i, ['brave']], [/^microsoft edge$/i, ['edge']], [/^opera( gx)?$/i, ['opera']], [/^vivaldi$/i, ['vivaldi']],
  [/^arc$/i, ['arc']], [/^google chrome$/i, ['chrome']],
]);
const GENERIC = ['chromium', 'arc', 'vivaldi'];
/** The browser ids the peer's reported brands allow, or null when it reported none. */
export function brandCandidates(capabilities) {
  const brands = Array.isArray(capabilities?.browser?.brands) ? capabilities.browser.brands.map(String) : [];
  if (!brands.length) return null;
  for (const [pattern, ids] of BRAND_IDS) if (brands.some(b => pattern.test(b.trim()))) return ids;
  return brands.some(b => /^chromium$/i.test(b.trim())) ? GENERIC : null;
}
/**
 * Whether the connected peer is in the browser the owner chose: 'match', 'mismatch' or 'unknown'. A bridge paired from
 * one browser never counts for another: a brand that names another browser, or a pairing a setup made for another
 * browser that the brand does not overrule, is a mismatch. A brand that only says "Chromium" names the target only
 * when the setup that paired says so, or when the target is the one installed browser it could be (`installed`: the
 * ids of the installed browsers, when known).
 */
export function peerIdentity(target, capabilities, pairedThrough, installed = null) {
  if (!target) return 'unknown';
  let brands = brandCandidates(capabilities);
  const through = pairedThrough?.id || null;
  if (brands && !brands.includes(target)) return 'mismatch';
  if (brands && brands.length > 1 && Array.isArray(installed) && installed.length) brands = brands.filter(id => installed.includes(id));
  const single = !!brands && brands.length === 1 && brands[0] === target;
  if (through && through !== target && !single) return 'mismatch';
  if (single || through === target) return 'match';
  return 'unknown';
}

/**
 * The card's stage. `data`: GET /api/browser/extension (null when the read failed); `setup`: the setup status (null
 * when none ran); `target`: the installed browser the owner chose; `failed`: the last read failed.
 */
export function extensionStage({ data = null, setup = null, target = null, failed = false, installed = null } = {}) {
  if (!data) return failed ? 'error' : 'loading';
  const running = setup?.state || data.setup || 'idle';
  const forTarget = !target || !setup?.browser?.id || setup.browser.id === target;
  if (!data.connected) {
    // Only while nothing is connected: a failed download never hides a live bridge (it stays in Step 4 and Advanced).
    if (running === 'error' && forTarget && DOWNLOAD_STAGES[setup?.code]) return DOWNLOAD_STAGES[setup.code];
    if (running === 'downloading' && forTarget) return 'downloading';
    if (running === 'pairing' && forTarget) return 'pairing';
    if (failed) return 'error';
    return data.paired ? 'disconnected' : 'not-set-up';
  }
  if (peerIdentity(target, data.capabilities, setup?.pairedThrough, installed) === 'mismatch') return 'other-browser';
  if (data.reloadNeeded === true) return 'reload-required';
  // No `capabilities` key: a server from before the report, not a peer from before it (a current server sends null).
  if (!Object.hasOwn(data, 'capabilities')) return 'connected';
  const caps = data.capabilities;
  if (!caps || !caps.userScripts) {
    // An extension older than the report never sends one; a current one sends it right after it connects.
    return data.extensionVersion && compareVersions(data.extensionVersion, CAPABILITY_VERSION) >= 0 ? 'detected' : 'legacy-peer';
  }
  const state = caps.userScripts.state;
  if (state === 'unsupported') return 'browser-update';
  if (state === 'ready') return peerIdentity(target, caps, setup?.pairedThrough, installed) === 'match' ? 'ready' : 'detected';
  return 'allow-scripts';
}

/** The verification list of the Ready page: each check and whether the evidence holds it. */
export function readyChecks({ data = null, setup = null, target = null, installed = null } = {}) {
  const caps = data?.capabilities;
  return [
    { key: 'peer', ok: !!data?.connected && peerIdentity(target, caps, setup?.pairedThrough, installed) === 'match' },
    { key: 'live', ok: !!data?.connected },
    { key: 'reload', ok: !!data?.connected && data.reloadNeeded !== true },
    { key: 'scripts', ok: caps?.userScripts?.state === 'ready' },
  ];
}

/**
 * The page the guide moves to when the evidence changes (never backwards: the owner's Back stays where they put it).
 * `step`: the page shown; `stage`: the new stage; `previous`: the stage the last move was decided on.
 */
export function branchStep(step, stage, previous = null) {
  if (stage === previous) return step;
  if (stage === 'ready') return READY_STEP;
  const wanted = STAGES[stage]?.step || 1;
  // Evidence that the extension is in the browser moves an install still under way to its Details step.
  if (['detected', 'allow-scripts', 'reload-required', 'browser-update', 'legacy-peer'].includes(stage) && step <= 4) return 5;
  // A lapse after Ready (the extension asks for scripts again, a reload, an update) goes to the page that fixes it; a
  // browser that is only away keeps the Ready page, whose checklist then names what is missing.
  if (step === READY_STEP && wanted >= 4 && wanted < READY_STEP) return wanted;
  return step;
}
/** The page the guide opens on for a stage (Resume setup, Review setup, Allow user scripts …). */
export function entryStep(stage, saved = 0) {
  if (stage === 'ready') return READY_STEP;
  const wanted = STAGES[stage]?.step || 1;
  if (wanted >= 5) return wanted;
  return saved >= 1 && saved < READY_STEP ? saved : wanted;
}

/** The status word, help, symbol and main action for a stage. Keys are under browserExtension.card. */
export function stageView(stage, { savedStep = 0, legacyServer = false } = {}) {
  const meta = STAGES[stage] || STAGES.error;
  const status = {
    loading: 'stageLoading', 'not-set-up': 'stageNotSetUp', downloading: 'stageDownloading', offline: 'stageOffline',
    'package-unavailable': 'stagePackageUnavailable', 'verification-failed': 'stageVerifyFailed', pairing: 'stagePairing',
    disconnected: 'stageDisconnected', 'other-browser': 'stageOtherBrowser', detected: 'stageDetected', 'allow-scripts': 'stageAllowScripts',
    'reload-required': 'stageReload', 'browser-update': 'stageBrowserUpdate', 'legacy-peer': 'stageLegacy', connected: 'stageConnected', ready: 'stageReady', error: 'stageError',
  }[stage] || 'stageError';
  // The chosen browser's extension is connected (rung 1 and up): never offered the older server's "Connect your
  // browser", which opens the setup page and the folder again; nor any action while the server cannot check it.
  const cta = stage === 'connected' ? null
    : legacyServer ? (stage === 'disconnected' ? 'ctaReconnect' : stage === 'error' ? 'retry' : meta.rung >= 1 ? null : 'ctaConnect')
    : stage === 'ready' ? 'ctaReview'
      : stage === 'disconnected' ? 'ctaReconnect'
        : stage === 'allow-scripts' ? 'ctaAllowScripts'
          : stage === 'detected' ? 'ctaDetails'
            : ['offline', 'package-unavailable', 'verification-failed', 'error'].includes(stage) ? 'retry'
              : ['reload-required', 'browser-update', 'legacy-peer', 'pairing', 'downloading'].includes(stage) ? 'ctaResume'
                : savedStep > 1 ? 'ctaResume' : 'ctaSetUp';
  return { status, help: `${status}Help`, tone: meta.tone, rung: meta.rung, cta };
}

/** The keys to paste an address with, on this computer. */
export function pasteKeys(platform = '') {
  return /mac|darwin|iphone|ipad/i.test(String(platform)) ? ['⌘L', '⌘V', 'Return'] : ['Ctrl+L', 'Ctrl+V', 'Enter'];
}
/** 'mac', 'windows' or 'linux' for a platform word (the server's inventory or the page's navigator). */
export function osOf(platform = '') {
  const p = String(platform || '').toLowerCase();
  return /mac|darwin|iphone|ipad/.test(p) ? 'mac' : /win/.test(p) ? 'windows' : 'linux';
}
/** Where Developer mode is on a browser's Extensions page: verified layouts only; anything else names the switch only. */
export function developerLayout(browserId) {
  if (browserId === 'edge') return 'sidebar';
  return ['chrome', 'brave', 'arc', 'vivaldi', 'chromium'].includes(browserId) ? 'header' : 'unverified';
}

/** The browser the card offers first: the saved choice while installed, else the server's suggestion, else the first. */
export function pickTarget(inventory, saved = null) {
  const list = Array.isArray(inventory?.installedBrowsers) ? inventory.installedBrowsers.filter(b => b?.id) : [];
  if (saved && list.some(b => b.id === saved)) return saved;
  if (inventory?.suggested && list.some(b => b.id === inventory.suggested)) return inventory.suggested;
  return list[0]?.id || null;
}
/** The short name the guide uses ("Brave", "Chrome", "Edge"): the catalog's names carry the vendor. */
export function shortName(browser) {
  const name = String(browser?.name || '').trim();
  return { 'Google Chrome': 'Chrome', 'Microsoft Edge': 'Edge' }[name] || name;
}

// ── what the guide remembers between openings (the chosen browser and how far each browser got) ──
export const GUIDE_STORE_KEY = 'synabun.browserBridgeGuide';
/** Progress older than this is not resumed (the browser is still remembered). */
export const GUIDE_STORE_MS = 6 * 60 * 60 * 1000;
export function readGuideStore(raw, now = Date.now()) {
  let value; try { value = JSON.parse(raw || 'null'); } catch { value = null; }
  if (!value || typeof value !== 'object') return { target: null, open: false, progress: {} };
  const fresh = Number(value.at) > 0 && now - Number(value.at) < GUIDE_STORE_MS;
  const progress = {};
  if (fresh && value.progress && typeof value.progress === 'object') {
    for (const [id, step] of Object.entries(value.progress)) if (/^[a-z]{2,12}$/.test(id) && Number.isInteger(step) && step >= 1 && step <= READY_STEP) progress[id] = step;
  }
  return { target: typeof value.target === 'string' && /^[a-z]{2,12}$/.test(value.target) ? value.target : null, open: fresh && value.open === true, progress };
}
export function writeGuideStore({ target, open, progress }, now = Date.now()) {
  return JSON.stringify({ target: target || null, open: !!open, progress: progress || {}, at: now });
}
