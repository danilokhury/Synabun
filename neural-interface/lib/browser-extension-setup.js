// The one-button setup of the everyday-browser extension (Settings → Browser → "Connect your browser";
// docs/browser-extension-bridge.md → One-button setup). The owner presses the button; SynaBun finds the default
// browser, prepares the extension folder, opens its own "Connect your browser" page (SETUP_PAGE_PATH) in that browser and
// shows the folder in Finder, Explorer or the file manager. The owner does the three steps no app may do for them
// (the extensions page, Developer mode, Load unpacked); the extension then pairs by itself with a one-time token.
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
import { SETUP_PAGE_PATH } from './browser-extension-folder.js';
import { randomBytes } from 'node:crypto';

export const SETUP_STATES = Object.freeze(['idle', 'waiting-for-extension', 'pairing', 'connected', 'unsupported', 'error']);
export const SETUP_WINDOW_MS = 15 * 60 * 1000;
export const TICKET_MS = 2 * 60 * 1000;
export const MAX_TICKETS = 5;
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };

/**
 * `bridge` (createExtensionBridge), `detect()` → { browser, installedBrowsers } (browser-default.js detectBrowsers with
 * the system's runners), `prepare()` → { folder, version, changed } (browser-extension-folder.js), `exec(cmd, args)`
 * starts a program (never a shell), `appOrigin()` is this server's own origin on loopback (http://127.0.0.1:<port>),
 * `platform` the OS, `folderVersion()` the version the folder holds.
 */
export function createExtensionSetup({ bridge, detect, prepare, exec, appOrigin, platform = process.platform, now = Date.now,
  windowMs = SETUP_WINDOW_MS, ticketMs = TICKET_MS, maxTickets = MAX_TICKETS, folderVersion = () => null } = {}) {
  let setup = null;
  const pageUrl = () => `${appOrigin()}${SETUP_PAGE_PATH}`;
  const describe = browser => browser ? { id: browser.id, name: browser.name, supported: browser.supported === true, extensionsUrl: browser.extensionsUrl || null } : null;
  function state() {
    if (!setup) return 'idle';
    if (setup.error) return 'error';
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
    const version = folderVersion();
    return {
      state: current,
      ...(setup ? { setupId: setup.id, browser: describe(setup.browser), defaultBrowser: describe(setup.defaultBrowser), installedBrowsers: setup.installed.map(describe),
        folder: setup.folder, extensionsUrl: setup.browser?.extensionsUrl || null, opened: setup.opened, revealed: setup.revealed, expiresAt: setup.until } : {}),
      ...(setup?.error ? { code: setup.error.code } : {}),
      connected: bridgeStatus.connected, paired: bridgeStatus.paired, bridgePort: bridgeStatus.port,
      extensionVersion: bridgeStatus.extensionVersion || null, folderVersion: version,
      // The browser runs an older copy than the folder holds (or an extension from before versions were reported).
      reloadNeeded: !!(bridgeStatus.connected && version && bridgeStatus.extensionVersion !== version),
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
      if (setup) bridge.endSetupPairing();
      let detected;
      try { detected = await detect(); } catch { detected = { browser: null, installedBrowsers: [] }; }
      const installed = Array.isArray(detected?.installedBrowsers) ? detected.installedBrowsers.filter(b => b?.supported) : [];
      const defaultBrowser = detected?.browser || { id: 'unknown', name: 'Unknown browser', supported: false, extensionsUrl: null };
      let browser = defaultBrowser;
      if (browserId) {
        browser = installed.find(b => b.id === browserId);
        if (!browser) fail('BROWSER_NOT_INSTALLED');
      }
      setup = { id: randomBytes(12).toString('hex'), startedAt: now(), until: now() + windowMs, browser, defaultBrowser, installed,
        folder: null, opened: false, revealed: false, tickets: 0, pairedBefore: bridge.status().pairedAt || 0, error: null };
      try { setup.folder = (await prepare()).folder; }
      catch { setup.error = { code: 'EXTENSION_FOLDER_FAILED' }; return view(); }
      if (browser.supported) {
        setup.opened = await open(browser);
        setup.revealed = (await reveal()).ok === true;
        if (!setup.opened) setup.error = { code: 'OPEN_FAILED' };
      }
      return view();
    },
    status: view,
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
      const until = Math.min(setup.until, now() + ticketMs);
      const made = await bridge.beginSetupPairing({ until });
      return { token: made.token, bridgePort: made.port, expiresAt: made.expiresAt };
    },
    cancel() { if (setup) bridge.endSetupPairing(); setup = null; return view(); },
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
  OPEN_FAILED: 'SynaBun could not open the setup page in the browser. Open it yourself from Settings → Browser.',
  REVEAL_FAILED: 'SynaBun could not show the folder. Copy its path from the setup page.',
  INVALID_MESSAGE: 'Invalid setup request.',
});
export function setupError(error) {
  const code = Object.hasOwn(SETUP_ERROR_TEXT, error?.code) ? error.code : null;
  return code ? { ok: false, code, error: `${code}: ${SETUP_ERROR_TEXT[code]}` } : null;
}
