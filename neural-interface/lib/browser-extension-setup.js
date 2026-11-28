// The setup of the everyday-browser extension (Settings → Browser → "Connect your browser";
// docs/browser-extension-bridge.md → One-button setup). SynaBun finds the browsers, prepares the extension folder and
// keeps a pairing session open; the owner does the steps no app may do for them (the extensions page, Developer mode,
// Load unpacked, Allow user scripts); the extension then pairs by itself with a one-time token on SynaBun's own
// loopback page (SETUP_PAGE_PATH), which its content script recognises.
//
// Two ways in. The Settings guide (start with `present: 'none'`) shows the steps in Settings itself: the start prepares
// the folder and opens the pairing session but opens and shows nothing; the guide then asks, one click each, for the
// browser's extensions page (openExtensions: the companion page first, once, so the extension finds it when it loads),
// the browser brought forward for a paste (focus: that same companion page once, then a page that never pairs), the
// pairing page again (reopen: Pair in <Browser>) and the folder (reveal). The status says `guided`, and the companion page then
// draws only its pairing status. The older way (start without `present`: the extension popup, older pages) opens the
// page with its own four steps in the browser. Neither shows the folder by itself: only the owner's click (reveal).
//
// The folder's files are the one package this release pins, downloaded from synabun.ai and verified
// (lib/browser-extension-package.js). A folder that is already there is used as it is, in the same request as before.
// One that is not there yet, or is older than the pin, is fetched first: the setup is then `downloading` (with the
// bytes so far), and the older way opens its page only once the verified files are in place. A download that
// fails ends the setup with its code (offline, unavailable, verification failed) and Start again tries once more;
// nothing is ever installed that did not verify.
//
// Every route that reaches this is the owner's (server.js mounts them behind the same guard as pairing and the mode:
// ownerRouteGuard, this boot's page secret, no automation caller; the guide's open-extensions, focus and capabilities
// check also need Settings' own same-origin request with X-SynaBun-UI). Nothing here starts a program by itself: `exec`
// is injected (server.js: spawn with an argument array, no shell, detached) and gets a plan from lib/browser-default.js.
// A request names a browser by its id only; the program comes from the detected install, the address from the catalog.
//
// The token: made by ticket(), only while a setup is active and still waiting for the extension, at most
// MAX_TICKETS times per setup (each one replaces the last), each valid TICKET_MS (and never past the setup's end). The
// bridge accepts it once, in its pairing handshake, and forgets it (lib/browser-extension-bridge.js
// beginSetupPairing). It is never logged, never in a status and never in a URL.
import { BROWSERS, extensionsPagePlan, launchPlan, revealPlan, SUPPORTED_BROWSER_IDS } from './browser-default.js';
import { compareVersions, SETUP_PAGE_PATH } from './browser-extension-folder.js';
import { randomBytes } from 'node:crypto';

export const SETUP_STATES = Object.freeze(['idle', 'downloading', 'waiting-for-extension', 'pairing', 'connected', 'unsupported', 'error']);
/** The codes a download of the extension package can end a setup with (lib/browser-extension-package.js). */
export const DOWNLOAD_ERRORS = Object.freeze(['EXTENSION_DOWNLOAD_OFFLINE', 'EXTENSION_DOWNLOAD_UNAVAILABLE', 'EXTENSION_VERIFY_FAILED']);
/** What a start may be told to show: nothing (the Settings guide). Without it, the older way opens its page. */
export const PRESENT_MODES = Object.freeze(['none']);
export const SETUP_WINDOW_MS = 15 * 60 * 1000;
export const TICKET_MS = 2 * 60 * 1000;
export const MAX_TICKETS = 5;
/** How long a look at the installed browsers is reused: the guide polls, and each look starts plutil or reg. */
export const DETECT_CACHE_MS = 30 * 1000;
/**
 * The wait between the companion page and the extensions page when both are opened by one click. Each launch only
 * starts a program that hands the address to the browser and returns at once, so two started together may arrive in
 * either order; the extensions page should be the tab the owner sees.
 */
export const COMPANION_GAP_MS = 800;
/** How long the capabilities check waits for the extension (lib/browser-extension-bridge.js probe). */
export const PROBE_TIMEOUT_MS = 4000;
/** The query of the setup page opened only to bring a browser forward (focus): that page never pairs. */
export const FOCUS_QUERY = 'focus=1';
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const PLATFORM_NAMES = Object.freeze({ darwin: 'mac', win32: 'windows' });
const UNKNOWN_BROWSER = Object.freeze({ id: 'unknown', name: 'Unknown browser', supported: false });
/**
 * The browser a request names: a body of exactly `{ browser: <supported id> }`. Any other key, a value that is not
 * one of SUPPORTED_BROWSER_IDS (an address, a path, a program, an argument) is INVALID_MESSAGE: nothing of the request
 * ever becomes a program, an argument or an address; those come from the detected install and the catalog.
 */
function requestedBrowser(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_MESSAGE');
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'browser' || typeof body.browser !== 'string' || !SUPPORTED_BROWSER_IDS.includes(body.browser)) fail('INVALID_MESSAGE');
  return body.browser;
}
/** A browser by its id, named from the catalog only (never a raw bundle id, ProgId or desktop file). */
const named = browser => {
  const known = browser && typeof browser.id === 'string' && Object.hasOwn(BROWSERS, browser.id) ? BROWSERS[browser.id] : null;
  return known ? { id: known.id, name: known.name } : { id: UNKNOWN_BROWSER.id, name: UNKNOWN_BROWSER.name };
};

/**
 * Whether the browser should be told to reload the extension: it is connected, the folder holds what this release
 * wants (the pinned version, or a newer one a later release left there) and the browser runs something else. While
 * the folder itself is older than the pin a Reload changes nothing: that is `updateNeeded`, which SynaBun settles by
 * downloading the pinned package. `reloadPending`: the folder's marker asks for a Reload until the setup page saw the
 * extension running again; `reloadReason` says why. 'version': a verified upgrade awaits the new peer. 'port': the setup port changed while the version stayed, and the
 * browser still runs the old manifest (asked only while the extension is connected). 'repair': files that were not
 * the pinned extension were replaced, and the browser may still run them at the same version, connected or not (the
 * changed code may not connect at all): asked until the owner confirms the Reload in Settings, and said in its own
 * words (`reloadRepaired`).
 */
export function extensionVersions({ connected, extensionVersion, folderVersion, pinnedVersion, reloadPending = false, reloadReason = null }) {
  const current = !!folderVersion && (!pinnedVersion || compareVersions(folderVersion, pinnedVersion) >= 0);
  const repaired = current && reloadPending === true && reloadReason === 'repair';
  const reloadNeeded = repaired || (current && reloadPending === true && reloadReason === 'version') || !!(connected && current && (extensionVersion !== folderVersion || reloadPending === true));
  return {
    reloadNeeded,
    updateNeeded: !!(folderVersion && pinnedVersion && compareVersions(folderVersion, pinnedVersion) < 0),
    ...(repaired ? { reloadRepaired: true } : {}),
  };
}

/**
 * `bridge` (createExtensionBridge), `detect()` → { browser, installedBrowsers } (browser-default.js detectBrowsers with
 * the system's runners), `prepare({ signal })` → { folder, version, changed } once the folder is ready to load
 * (browser-extension-package.js ensure: it may download), `exec(cmd, args)` starts a program (never a shell),
 * `appOrigin()` is this server's own origin on loopback (http://127.0.0.1:<port>), `platform` the OS,
 * `folderVersion()` the version the folder holds, `packageStatus()` → { pinnedVersion, needs, phase, received, total,
 * code, reloadPending } (browser-extension-package.js status; `needs` says that `prepare` will download),
 * `confirmReload()` the setup page saw the extension's content script on this port (browser-extension-package.js; it
 * never clears a repair's Reload). `detectMs`: how long a look at the browsers is reused (DETECT_CACHE_MS);
 * `pause(ms)` waits between two launches of one click (tests pass one that does not wait).
 */
export function createExtensionSetup({ bridge, detect, prepare, exec, appOrigin, platform = process.platform, now = Date.now,
  windowMs = SETUP_WINDOW_MS, ticketMs = TICKET_MS, maxTickets = MAX_TICKETS, folderVersion = () => null, packageStatus = () => ({}), confirmReload = () => false, updateStatus,
  detectMs = DETECT_CACHE_MS, companionGapMs = COMPANION_GAP_MS, probeTimeoutMs = PROBE_TIMEOUT_MS, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let setup = null;
  // The latest start, from its first step: a cancel or a later start ends it before it prepares or opens anything.
  let attempt = null;
  // The last look at the browsers ({ at, value }) and the one under way. The Settings guide asks for the list while it
  // is open; a look starts plutil or reg, so one is reused for `detectMs` (a start, and ?refresh=1, always look again).
  let detection = null, detecting = null;
  // The browser whose setup made the bridge's current pairing ({ browser: { id, name }, pairedAt }), remembered when
  // state() first sees that pairing and reported while the bridge still holds it. In memory only: after a restart a
  // pairing has no setup to name, and the guide then asks the owner rather than calling an earlier browser ready.
  let pairedThrough = null;
  const pageUrl = () => `${appOrigin()}${SETUP_PAGE_PATH}`;
  // The same page opened only to bring the browser forward (focus): it never asks for a token (es-page.js FOCUS_ONLY).
  const focusUrl = () => `${pageUrl()}?${FOCUS_QUERY}`;
  const describe = browser => browser ? { id: browser.id, name: browser.name, supported: browser.supported === true, extensionsUrl: browser.extensionsUrl || null } : null;
  // The supported browsers a look found, once each; the default as it was found (it may be unsupported or unknown).
  const normalize = found => {
    const installed = [];
    for (const browser of Array.isArray(found?.installedBrowsers) ? found.installedBrowsers : []) {
      if (browser?.supported && SUPPORTED_BROWSER_IDS.includes(browser.id) && !installed.some(b => b.id === browser.id)) installed.push(browser);
    }
    return { browser: found?.browser && typeof found.browser === 'object' ? found.browser : null, installedBrowsers: installed };
  };
  // A look that fails is no browser and none installed, never an error: the guide then says what it could not find.
  function look() {
    const run = Promise.resolve().then(() => detect()).then(normalize, () => normalize(null));
    detecting = run;
    void run.then(value => { if (detecting === run) { detecting = null; detection = { at: now(), value }; } });
    return run;
  }
  function browsers({ refresh = false } = {}) {
    const at = now();
    if (!refresh && detection && at >= detection.at && at - detection.at < detectMs) return Promise.resolve(detection.value);
    if (!refresh && detecting) return detecting;
    return look();
  }
  // An installed supported browser by its id, with its `launch` (never shown): only what a look found is started.
  async function installedBrowser(id) {
    const browser = (await browsers()).installedBrowsers.find(b => b.id === id);
    if (!browser) fail('BROWSER_NOT_INSTALLED');
    return browser;
  }
  function state() {
    if (!setup) return 'idle';
    if (setup.error) return 'error';
    if (setup.preparing) return 'downloading';
    const bridgeStatus = bridge.status();
    // Paired by this setup: a pairing made after it began (its token, or the typed code as a fallback). Connected once
    // the extension's first inventory arrived; "Pairing…" from the token's handshake until then.
    if (bridgeStatus.paired && bridgeStatus.pairedAt !== setup.pairedBefore) {
      if (pairedThrough?.pairedAt !== bridgeStatus.pairedAt) pairedThrough = setup.browser?.supported ? { browser: named(setup.browser), pairedAt: bridgeStatus.pairedAt } : null;
      return bridgeStatus.connected ? 'connected' : 'pairing';
    }
    if (bridge.setupPairing().attempted) return 'pairing';
    if (now() >= setup.until) { expire(); return 'error'; }
    if (!setup.browser?.supported) return 'unsupported';
    return 'waiting-for-extension';
  }
  // The browser that made the bridge's current pairing through a setup, or null once that pairing is gone or replaced.
  function pairedNow(bridgeStatus) {
    if (pairedThrough && (!bridgeStatus.paired || bridgeStatus.pairedAt !== pairedThrough.pairedAt)) pairedThrough = null;
    return pairedThrough ? { ...pairedThrough.browser } : null;
  }
  function expire() {
    if (!setup || setup.error) return;
    bridge.endSetupPairing(); setup.error = { code: 'SETUP_EXPIRED' };
  }
  async function open(browser, url = pageUrl()) {
    try { const plan = launchPlan(platform, browser, url); await exec(plan.cmd, plan.args); return true; } catch { return false; }
  }
  // Only on the owner's click (POST …/setup/reveal): no start shows the folder by itself.
  async function reveal() {
    if (!setup?.folder) fail('SETUP_NOT_ACTIVE');
    const mine = setup;
    try { const plan = revealPlan(platform, mine.folder); await exec(plan.cmd, plan.args); mine.revealed = true; return { ok: true, folder: mine.folder }; }
    catch { return { ok: false, code: 'REVEAL_FAILED', folder: mine.folder }; }
  }
  // The companion page, before the extensions page of the same click: once per setup, only in the setup's own browser
  // and only while the setup still waits for the extension (or downloads it), so the extension finds the page and pairs
  // by itself once it is loaded. True when it was opened now.
  async function openCompanion(browser) {
    const mine = setup;
    if (!mine || mine.opened || mine.companionOpening || mine.browser?.id !== browser.id || !['downloading', 'waiting-for-extension'].includes(state())) return false;
    mine.companionOpening = true;
    try { const opened = await open(browser); if (opened) mine.opened = true; return opened; }
    finally { mine.companionOpening = false; }
  }
  function view() {
    const current = state(), bridgeStatus = bridge.status();
    const pkg = packageStatus() || {};
    const version = Object.hasOwn(pkg, 'folderVersion') ? pkg.folderVersion : folderVersion();
    const pinnedVersion = typeof pkg.pinnedVersion === 'string' ? pkg.pinnedVersion : null;
    return {
      state: current,
      ...(updateStatus ? { update: updateStatus(bridgeStatus, pkg) } : {}),
      ...(setup ? { setupId: setup.id, guided: setup.guided === true, browser: describe(setup.browser), defaultBrowser: describe(setup.defaultBrowser), installedBrowsers: setup.installed.map(describe),
        folder: setup.folder, extensionsUrl: setup.browser?.extensionsUrl || null, opened: setup.opened, revealed: setup.revealed, expiresAt: setup.until } : {}),
      ...(setup?.error ? { code: setup.error.code } : {}),
      connected: bridgeStatus.connected, paired: bridgeStatus.paired, bridgePort: bridgeStatus.port,
      // Which browser's setup made the current pairing: the guide calls a bridge "ready" for the browser it set up only.
      pairedThrough: pairedNow(bridgeStatus),
      extensionVersion: bridgeStatus.extensionVersion || null, folderVersion: version, pinnedVersion,
      // The bytes so far while the pinned package is on its way (the setup's own download, or an update's).
      ...(pkg.phase === 'downloading' ? { download: { received: Number(pkg.received) || 0, total: Number(pkg.total) || 0 } } : {}),
      // The browser runs another copy than the folder holds (or an extension from before versions were reported);
      // or the folder itself is older than this release's extension, which a download settles, never a Reload.
      ...extensionVersions({ connected: bridgeStatus.connected, extensionVersion: bridgeStatus.extensionVersion, folderVersion: version, pinnedVersion, reloadPending: pkg.reloadPending === true, reloadReason: pkg.reloadReason ?? null }),
    };
  }
  return {
    /**
     * Starts (or restarts) a setup. `browserId`: one of the installed supported browsers, for "open in X instead";
     * without it the default browser, which may be unsupported (then the page is not opened and the state is
     * `unsupported` with the installed browsers to choose from). `present: 'none'` (the Settings guide): the folder
     * and the pairing session only, nothing opened (`guided` in the status); without it the page opens in the browser
     * once the folder is ready. Neither shows the folder: that is reveal(), on the owner's click.
     */
    async start({ browserId, present } = {}) {
      if (browserId !== undefined && browserId !== null && !SUPPORTED_BROWSER_IDS.includes(browserId)) fail('INVALID_MESSAGE');
      if (present !== undefined && present !== null && !PRESENT_MODES.includes(present)) fail('INVALID_MESSAGE');
      const guided = present === 'none';
      if (setup) { bridge.endSetupPairing(); setup.stop?.abort(); }
      // This start is the current one before its first wait: a cancel during the browser detection, or a later start
      // whose detection ends first, leaves this one nothing to do when its own detection ends.
      attempt?.stop.abort();
      const own = { stop: new AbortController() };
      attempt = own;
      const superseded = () => attempt !== own || own.stop.signal.aborted;
      // Always a fresh look: the owner may have installed a browser since the guide last asked.
      const detected = await look();
      if (superseded()) return view();
      const installed = detected.installedBrowsers;
      const defaultBrowser = detected.browser || { ...UNKNOWN_BROWSER, extensionsUrl: null };
      let browser = defaultBrowser;
      if (browserId) {
        browser = installed.find(b => b.id === browserId);
        if (!browser) fail('BROWSER_NOT_INSTALLED');
      }
      setup = { id: randomBytes(12).toString('hex'), startedAt: now(), until: now() + windowMs, browser, defaultBrowser, installed, guided,
        folder: null, opened: false, revealed: false, tickets: 0, pairedBefore: bridge.status().pairedAt || 0, error: null };
      const mine = setup;
      mine.stop = own.stop;
      // A browser that cannot run the extension gets no download: the page offers the installed ones, and choosing one
      // starts the setup again.
      if (!browser.supported && (packageStatus() || {}).needs) return view();
      // Once the folder is ready, the older way opens the page in the browser (never for a start that was cancelled or
      // replaced meanwhile). The guide opens nothing: each of its steps is the owner's click.
      const presentPage = async () => {
        if (guided || !browser.supported || setup !== mine || superseded()) return;
        mine.opened = await open(browser);
        if (setup === mine && !mine.opened) mine.error = { code: 'OPEN_FAILED' };
      };
      // Started in this step, so the answer below already carries a download's progress.
      let preparing;
      try { preparing = Promise.resolve(prepare({ signal: mine.stop.signal })); } catch (error) { preparing = Promise.reject(error); }
      const ready = preparing.then(
        prepared => { mine.folder = prepared.folder; },
        error => { mine.error = { code: DOWNLOAD_ERRORS.includes(error?.code) || error?.code === 'EXTENSION_FOLDER_UNSAFE' ? error.code : 'EXTENSION_FOLDER_FAILED' }; });
      // A folder that needs no download answers in this request, as it always did. A download runs on: the setup is
      // `downloading` until its files are verified and in place, and this request returns at once so its progress shows.
      const needed = packageStatus() || {};
      if (needed.needs || needed.phase === 'downloading') {
        mine.preparing = true;
        mine.settled = ready.then(async () => { mine.preparing = false; if (setup === mine && !mine.error) await presentPage(); }).catch(() => { mine.preparing = false; });
        return view();
      }
      await ready;
      if (setup !== mine || mine.error) return view();
      await presentPage();
      return view();
    },
    status: view, state,
    /**
     * The browsers for the Settings guide (GET …/setup/browsers): { platform, defaultBrowser: { id, name, supported },
     * installedBrowsers: [{ id, name, extensionsUrl }], suggested }. Names and addresses come from the catalog
     * (browser-default.js BROWSERS); no program, bundle id, path or desktop file is ever in it. `suggested`: the default
     * when it is supported and installed, else the first installed one, else null. `refresh`: look again now.
     */
    async browsers({ refresh = false } = {}) {
      const found = await browsers({ refresh });
      const known = found.browser && typeof found.browser.id === 'string' && Object.hasOwn(BROWSERS, found.browser.id) ? BROWSERS[found.browser.id] : null;
      const defaultBrowser = known ? { id: known.id, name: known.name, supported: known.supported } : { ...UNKNOWN_BROWSER };
      const installedBrowsers = found.installedBrowsers.map(b => ({ id: b.id, name: BROWSERS[b.id].name, extensionsUrl: BROWSERS[b.id].extensionsUrl }));
      const suggested = defaultBrowser.supported && installedBrowsers.some(b => b.id === defaultBrowser.id) ? defaultBrowser.id : installedBrowsers[0]?.id ?? null;
      return { platform: PLATFORM_NAMES[platform] || 'linux', defaultBrowser, installedBrowsers, suggested };
    },
    /**
     * Opens an installed browser's own extensions page (POST …/setup/open-extensions, body exactly `{ browser }`). The
     * address is the catalog's for that browser and the program the one its detected install names
     * (browser-default.js extensionsPagePlan). When a setup for that browser has not opened its companion page yet, that
     * page opens first. Answers { ok, code?, browser: { id, name }, extensionsUrl, companion }: `companion` says the
     * companion page was opened by this click. `ok: false, code: 'OPEN_FAILED'` when the program could not be started.
     */
    async openExtensions(body) {
      const browser = await installedBrowser(requestedBrowser(body));
      const shown = named(browser), extensionsUrl = BROWSERS[browser.id].extensionsUrl;
      const companion = await openCompanion(browser);
      if (companion) await pause(companionGapMs);
      // `ok` means the program that hands the address to the browser started, never that the page appeared: a launch
      // cannot see the browser's window, and a browser may refuse an address of its own scheme given from outside. The
      // guide keeps its "Page didn't open?" way (copy the address) for that.
      try { const plan = extensionsPagePlan(platform, browser); await exec(plan.cmd, plan.args); return { ok: true, browser: shown, extensionsUrl, companion }; }
      catch { return { ok: false, code: 'OPEN_FAILED', browser: shown, extensionsUrl, companion }; }
    },
    /**
     * Brings an installed browser forward for "Copy address & open <Browser>" (POST …/setup/focus, body exactly
     * `{ browser }`): the owner pastes the copied extensions address into the tab this opens, which replaces it. So that
     * tab is the focus-only page (SETUP_PAGE_PATH?focus=1), which never asks for a token: the paste takes no pairing with
     * it. As with openExtensions, an active setup of that browser that has not opened its companion page yet opens it
     * first, once, behind the focus page; nothing else counts as the companion. Answers { ok, code?, browser: { id, name },
     * extensionsUrl, companion } (`ok` says the launch started, not that the window came forward).
     */
    async focus(body) {
      const browser = await installedBrowser(requestedBrowser(body));
      const shown = named(browser), extensionsUrl = BROWSERS[browser.id].extensionsUrl;
      const companion = await openCompanion(browser);
      if (companion) await pause(companionGapMs);
      const opened = await open(browser, focusUrl());
      return opened ? { ok: true, browser: shown, extensionsUrl, companion } : { ok: false, code: 'OPEN_FAILED', browser: shown, extensionsUrl, companion };
    },
    /**
     * What the paired extension can do now (POST …/capabilities/check, body `{}`): the bridge's probe, which asks the
     * connected extension and never throws ({ ok, code?, capabilities, legacy }). A bridge without a probe is an older
     * one: { ok: true, capabilities: null, legacy: true }.
     */
    async capabilities(body) {
      if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) fail('INVALID_MESSAGE');
      if (typeof bridge.probe !== 'function') return { ok: true, capabilities: null, legacy: true };
      let result = null;
      try { result = await bridge.probe({ timeoutMs: probeTimeoutMs }); } catch {}
      if (!result || typeof result !== 'object') return { ok: false, code: 'CAPABILITIES_CHECK_FAILED', capabilities: null, legacy: false };
      // The probe's own fields only, so nothing else the bridge may carry reaches the page.
      return { ok: result.ok === true, ...(typeof result.code === 'string' ? { code: result.code } : {}), capabilities: result.capabilities ?? null, legacy: result.legacy === true };
    },
    /**
     * The setup page saw the extension's content script on this server's port (POST …/setup/seen): the browser runs
     * the folder's manifest for this port, so the Reload a port change asked for is done. A repair's Reload is not: the
     * copy the browser still runs answers the page just the same, so only the owner's confirmation in Settings clears it
     * (POST …/reload/confirm, browser-extension-package.js confirmRepairReload).
     */
    seen() { confirmReload(); return view(); },
    /**
     * The one-time token for the setup page (POST …/setup/ticket): only while the setup waits for the extension.
     * Returns { token, bridgePort, expiresAt }.
     */
    async ticket() {
      const current = state();
      if (!setup || current === 'idle') fail('SETUP_NOT_ACTIVE');
      if (current !== 'waiting-for-extension') fail(current === 'error' ? setup.error?.code || 'SETUP_NOT_ACTIVE' : 'SETUP_NOT_WAITING');
      if (setup.tickets >= maxTickets) fail('SETUP_TICKETS_USED');
      setup.tickets++;
      // A ticket clears no pending Reload: the page sends `seen` for that (it does before it asks for a ticket).
      const until = Math.min(setup.until, now() + ticketMs);
      const made = await bridge.beginSetupPairing({ until });
      return { token: made.token, bridgePort: made.port, expiresAt: made.expiresAt };
    },
    cancel() { attempt?.stop.abort(); attempt = null; if (setup) { bridge.endSetupPairing(); setup.stop?.abort(); } setup = null; return view(); },
    /** Resolves when a download this setup waits for has ended, either way (tests). */
    settled: () => setup?.settled || Promise.resolve(),
    reveal,
    /** Opens the setup page again (in the setup's browser). */
    // (The pairing page, never the focus-only one: the guide's Pair in <Browser> asks for this. `opened` is this launch's.)
    async reopen() { const mine = setup; if (!mine?.browser?.supported) fail('SETUP_NOT_ACTIVE'); const opened = await open(mine.browser); if (setup === mine && opened) mine.opened = true; return { ...view(), opened }; },
  };
}

/** Fixed sentences for the setup's own codes (never a path, a token or a program's output). */
export const SETUP_ERROR_TEXT = Object.freeze({
  SETUP_NOT_ACTIVE: 'No browser setup is running. Press "Connect your browser" in SynaBun Settings → Browser.',
  SETUP_NOT_WAITING: 'This setup is no longer waiting for the extension (it is pairing or connected).',
  SETUP_TICKETS_USED: 'This setup handed out its pairing tokens. Start "Connect your browser" again, or pair with a code.',
  SETUP_EXPIRED: 'This setup ran out of time (15 minutes). Start "Connect your browser" again.',
  BROWSER_NOT_INSTALLED: 'That browser was not found on this computer.',
  EXTENSION_FOLDER_FAILED: 'SynaBun could not prepare the extension folder in its data folder.',
  EXTENSION_FOLDER_UNSAFE: 'SynaBun did not use the extension folder in its data folder (browser-extension): it is a link, belongs to another user, or others can write to it (on Linux, a group that is not your own private group counts as others). Nothing was changed. Fix or remove that folder, then start "Connect your browser" again.',
  EXTENSION_DOWNLOAD_OFFLINE: 'SynaBun could not reach synabun.ai to download the extension. Check the internet connection, then start "Connect your browser" again.',
  EXTENSION_DOWNLOAD_UNAVAILABLE: 'synabun.ai did not have the extension this SynaBun version needs. Try again later, or update SynaBun.',
  EXTENSION_VERIFY_FAILED: 'The downloaded extension was not the file this SynaBun version expects, so it was not installed. Try again; if it keeps failing, update SynaBun.',
  OPEN_FAILED: 'SynaBun could not open the page in the browser. Copy its address from Settings → Browser and open it yourself.',
  REVEAL_FAILED: 'SynaBun could not show the folder. Copy its path from Settings → Browser.',
  CAPABILITIES_CHECK_FAILED: 'SynaBun could not ask the extension what it can do. Try again.',
  INVALID_MESSAGE: 'Invalid setup request.',
});
export function setupError(error) {
  const code = Object.hasOwn(SETUP_ERROR_TEXT, error?.code) ? error.code : null;
  return code ? { ok: false, code, error: `${code}: ${SETUP_ERROR_TEXT[code]}` } : null;
}
