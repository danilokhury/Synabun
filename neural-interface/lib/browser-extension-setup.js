// The one-button setup of the everyday-browser extension (Settings → Browser → "Connect your browser";
// docs/browser-extension-bridge.md → One-button setup). The owner presses the button; SynaBun finds the default
// browser, prepares the extension folder, opens its own "Connect your browser" page (SETUP_PAGE_PATH) in that browser and
// shows the folder in Finder, Explorer or the file manager. The owner does the three steps no app may do for them
// (the extensions page, Developer mode, Load unpacked); the extension then pairs by itself with a one-time token.
//
// The folder's files are the one package this release pins, downloaded from synabun.ai and verified
// (lib/browser-extension-package.js). A folder that is already there is used as it is, in the same request as before.
// One that is not there yet, or is older than the pin, is fetched first: the setup is then `downloading` (with the
// bytes so far), and the browser and the folder are opened only once the verified files are in place. A download that
// fails ends the setup with its code (offline, unavailable, verification failed) and Start again tries once more;
// nothing is ever installed that did not verify.
//
// Every route that reaches this is the owner's (server.js mounts them behind the same guard as pairing and the mode:
// ownerRouteGuard, this boot's page secret, no automation caller). Nothing here starts a program by itself: `exec` is
// injected (server.js: execFile, no shell, detached) and gets a plan from lib/browser-default.js.
//
// The token: made by ticket(), only while a setup is active and still waiting for the extension, at most
// MAX_TICKETS times per setup (each one replaces the last), each valid TICKET_MS (and never past the setup's end). The
// bridge accepts it once, in its pairing handshake, and forgets it (lib/browser-extension-bridge.js
// beginSetupPairing). It is never logged, never in a status and never in a URL.
import { launchPlan, revealPlan, SUPPORTED_BROWSER_IDS } from './browser-default.js';
import { compareVersions, SETUP_PAGE_PATH } from './browser-extension-folder.js';
import { randomBytes } from 'node:crypto';

export const SETUP_STATES = Object.freeze(['idle', 'downloading', 'waiting-for-extension', 'pairing', 'connected', 'unsupported', 'error']);
/** The codes a download of the extension package can end a setup with (lib/browser-extension-package.js). */
export const DOWNLOAD_ERRORS = Object.freeze(['EXTENSION_DOWNLOAD_OFFLINE', 'EXTENSION_DOWNLOAD_UNAVAILABLE', 'EXTENSION_VERIFY_FAILED']);
export const SETUP_WINDOW_MS = 15 * 60 * 1000;
export const TICKET_MS = 2 * 60 * 1000;
export const MAX_TICKETS = 5;
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };

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
 * never clears a repair's Reload).
 */
export function createExtensionSetup({ bridge, detect, prepare, exec, appOrigin, platform = process.platform, now = Date.now,
  windowMs = SETUP_WINDOW_MS, ticketMs = TICKET_MS, maxTickets = MAX_TICKETS, folderVersion = () => null, packageStatus = () => ({}), confirmReload = () => false, updateStatus } = {}) {
  let setup = null;
  // The latest start, from its first step: a cancel or a later start ends it before it prepares or opens anything.
  let attempt = null;
  const pageUrl = () => `${appOrigin()}${SETUP_PAGE_PATH}`;
  const describe = browser => browser ? { id: browser.id, name: browser.name, supported: browser.supported === true, extensionsUrl: browser.extensionsUrl || null } : null;
  function state() {
    if (!setup) return 'idle';
    if (setup.error) return 'error';
    if (setup.preparing) return 'downloading';
    const bridgeStatus = bridge.status();
    // Paired by this setup: a pairing made after it began (its token, or the typed code as a fallback). Connected once
    // the extension's first inventory arrived; "Pairing…" from the token's handshake until then.
    if (bridgeStatus.paired && bridgeStatus.pairedAt !== setup.pairedBefore) return bridgeStatus.connected ? 'connected' : 'pairing';
    if (bridge.setupPairing().attempted) return 'pairing';
    if (now() >= setup.until) { expire(); return 'error'; }
    if (!setup.browser?.supported) return 'unsupported';
    return 'waiting-for-extension';
  }
  function expire() {
    if (!setup || setup.error) return;
    bridge.endSetupPairing(); setup.error = { code: 'SETUP_EXPIRED' };
  }
  async function open(browser) {
    try { const plan = launchPlan(platform, browser, pageUrl()); await exec(plan.cmd, plan.args); return true; } catch { return false; }
  }
  async function reveal() {
    if (!setup?.folder) fail('SETUP_NOT_ACTIVE');
    try { const plan = revealPlan(platform, setup.folder); await exec(plan.cmd, plan.args); return { ok: true, folder: setup.folder }; }
    catch { return { ok: false, code: 'REVEAL_FAILED', folder: setup.folder }; }
  }
  function view() {
    const current = state(), bridgeStatus = bridge.status();
    const pkg = packageStatus() || {};
    const version = Object.hasOwn(pkg, 'folderVersion') ? pkg.folderVersion : folderVersion();
    const pinnedVersion = typeof pkg.pinnedVersion === 'string' ? pkg.pinnedVersion : null;
    return {
      state: current,
      ...(updateStatus ? { update: updateStatus(bridgeStatus, pkg) } : {}),
      ...(setup ? { setupId: setup.id, browser: describe(setup.browser), defaultBrowser: describe(setup.defaultBrowser), installedBrowsers: setup.installed.map(describe),
        folder: setup.folder, extensionsUrl: setup.browser?.extensionsUrl || null, opened: setup.opened, revealed: setup.revealed, expiresAt: setup.until } : {}),
      ...(setup?.error ? { code: setup.error.code } : {}),
      connected: bridgeStatus.connected, paired: bridgeStatus.paired, bridgePort: bridgeStatus.port,
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
     * `unsupported` with the installed browsers to choose from).
     */
    async start({ browserId } = {}) {
      if (browserId !== undefined && browserId !== null && !SUPPORTED_BROWSER_IDS.includes(browserId)) fail('INVALID_MESSAGE');
      if (setup) { bridge.endSetupPairing(); setup.stop?.abort(); }
      // This start is the current one before its first wait: a cancel during the browser detection, or a later start
      // whose detection ends first, leaves this one nothing to do when its own detection ends.
      attempt?.stop.abort();
      const own = { stop: new AbortController() };
      attempt = own;
      const superseded = () => attempt !== own || own.stop.signal.aborted;
      let detected;
      try { detected = await detect(); } catch { detected = { browser: null, installedBrowsers: [] }; }
      if (superseded()) return view();
      const installed = Array.isArray(detected?.installedBrowsers) ? detected.installedBrowsers.filter(b => b?.supported) : [];
      const defaultBrowser = detected?.browser || { id: 'unknown', name: 'Unknown browser', supported: false, extensionsUrl: null };
      let browser = defaultBrowser;
      if (browserId) {
        browser = installed.find(b => b.id === browserId);
        if (!browser) fail('BROWSER_NOT_INSTALLED');
      }
      setup = { id: randomBytes(12).toString('hex'), startedAt: now(), until: now() + windowMs, browser, defaultBrowser, installed,
        folder: null, opened: false, revealed: false, tickets: 0, pairedBefore: bridge.status().pairedAt || 0, error: null };
      const mine = setup;
      mine.stop = own.stop;
      // A browser that cannot run the extension gets no download: the page offers the installed ones, and choosing one
      // starts the setup again.
      if (!browser.supported && (packageStatus() || {}).needs) return view();
      // Once the folder is ready: the page in the browser, the folder in the file manager (never for a start that was
      // cancelled or replaced meanwhile).
      const present = async () => {
        if (!browser.supported || setup !== mine || superseded()) return;
        mine.opened = await open(browser);
        if (setup !== mine) return;
        mine.revealed = (await reveal()).ok === true;
        if (!mine.opened) mine.error = { code: 'OPEN_FAILED' };
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
        mine.settled = ready.then(async () => { mine.preparing = false; if (setup === mine && !mine.error) await present(); }).catch(() => { mine.preparing = false; });
        return view();
      }
      await ready;
      if (setup !== mine || mine.error) return view();
      await present();
      return view();
    },
    status: view, state,
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
    async reopen() { if (!setup?.browser?.supported) fail('SETUP_NOT_ACTIVE'); setup.opened = await open(setup.browser); return view(); },
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
  OPEN_FAILED: 'SynaBun could not open the setup page in the browser. Open it yourself from Settings → Browser.',
  REVEAL_FAILED: 'SynaBun could not show the folder. Copy its path from the setup page.',
  INVALID_MESSAGE: 'Invalid setup request.',
});
export function setupError(error) {
  const code = Object.hasOwn(SETUP_ERROR_TEXT, error?.code) ? error.code : null;
  return code ? { ok: false, code, error: `${code}: ${SETUP_ERROR_TEXT[code]}` } : null;
}
