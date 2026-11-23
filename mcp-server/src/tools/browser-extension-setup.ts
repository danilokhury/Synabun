// What an agent is told when the owner's everyday browser (the SynaBun Browser Bridge extension) cannot run page
// JavaScript or watch the network yet. Each of these is a one-time owner setup in the browser, not a failure of the
// page or of the call: the answer says what the owner does and what the agent can use meanwhile, so nobody retries,
// reaches for another browser or reports the tool as broken. The codes are the extension contract's
// (browser-extension/protocol.js ERROR_TEXT); a result with any other code is not one of these.

const EXTENSIONS_PAGE = 'chrome://extensions (edge://extensions in Edge)';
const NAME = '"SynaBun Browser Bridge"';
const ALLOW = `choose Details on ${NAME} and turn on "Allow User Scripts" (Chrome or Edge 138 and later; on an older version turn on Developer mode at the top of that page instead), then press Reload on the extension`;
const MEANWHILE_READ = 'Until then read the page with browser_snapshot or browser_content.';

const SETUP: Record<string, string> = {
  USER_SCRIPTS_DISABLED:
    `Running page JavaScript is switched off for the SynaBun extension in the owner's browser, so nothing was run. This is a one-time owner setup: tell the user to open ${EXTENSIONS_PAGE}, ${ALLOW}. ${MEANWHILE_READ}`,
  USER_SCRIPTS_UNSUPPORTED:
    `The owner's browser cannot run page JavaScript for an extension (that needs Chrome or Edge 135 or later), so nothing was run. Tell the user to update the browser, then open ${EXTENSIONS_PAGE}, ${ALLOW}. ${MEANWHILE_READ}`,
  EXTENSION_RELOAD_REQUIRED:
    `The owner's browser still runs an older SynaBun Browser Bridge than this needs (1.4.0 or later), so nothing was done. Tell the user to open ${EXTENSIONS_PAGE} and press Reload on ${NAME}; for browser_evaluate, then ${ALLOW} once more. Until then read the page with browser_snapshot or browser_content, and wait with a selector or a fixed timeout.`,
  NETWORK_IDLE_UNAVAILABLE:
    `The SynaBun extension cannot watch this browser's network requests yet (its webRequest permission is not in effect), so it cannot tell when the network is idle. Tell the user to open ${EXTENSIONS_PAGE} and press Reload on ${NAME}. Until then wait with loadState "load", a selector or a fixed timeout.`,
};

/** The owner-setup message for a refused browser call, or null when the refusal is not one of the setup codes. */
export function extensionSetupMessage(result: Record<string, unknown> | null | undefined): string | null {
  const code = typeof result?.code === 'string' ? result.code : '';
  return Object.prototype.hasOwnProperty.call(SETUP, code) ? SETUP[code] : null;
}

/** The setup codes, for tests. */
export const EXTENSION_SETUP_CODES = Object.freeze(Object.keys(SETUP));
