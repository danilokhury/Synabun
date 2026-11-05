// ── The browser routes an automation may call (DOM-free, no imports) ──
//
// SynaBun's browser API (/api/browser) serves two callers: the owner's page (the browser panel, Settings → Browser)
// and the automations that drive the browser through SynaBun's MCP tools (loops, dispatched workers, agents, the side
// panels, a CLI window). The MCP tools call a fixed set of routes (mcp-server/src/services/neural-interface.ts: the
// session list, create and close, acquire and release, and the page actions on a session); everything else under
// /api/browser is the owner's: the browser settings (PUT /config: attach to the user's real Chrome, pick a MoreLogin
// profile), the money guard's lift (paid-surfaces), the raw CDP endpoints (cdp, claude-connect), tab management
// outside a run's own tab (tabs: list, open, activate, close), the folder picker and the profile and browser
// detection. Until 2026-11-05 a run that proved its id reached all of them, and the worker-only MCP channel forwarded
// every /browser/* path with the run's token, so a sandboxed worker could switch the default browser to the user's
// real Chrome profile or lift the money guard (review 972afb74, finding 1).
//
// This list is the one answer to "may an automation call this": the worker channel forwards nothing else
// (lib/worker-mcp-channel.js), and server.js browserTerminalGate answers every other route the owner's page only (its
// page secret, or an invite guest the guest rules let in), whatever agent headers the request carries. A route a new
// MCP tool calls is added here, with its test (tests/browser-automation-routes.test.mjs checks the list against the
// paths the MCP server's source calls).

/** One path segment of a session or tab id SynaBun mints (hex today; base64url and uuid shapes allowed). */
const ID = '[A-Za-z0-9_-]{1,128}';
/** Page actions on a session the MCP tools post (navigate, click, …). */
const POST_ACTIONS = Object.freeze([
  'navigate', 'back', 'forward', 'reload', 'click', 'fill', 'type', 'hover', 'select', 'press', 'scroll', 'upload',
  'snapshot', 'evaluate', 'extract', 'x-compose-state', 'semantic-context', 'wait', 'bluesky/upload-blob',
]);
/** Reads of a session the MCP tools get. */
const GET_READS = Object.freeze(['snapshot', 'content', 'markdown', 'screenshot-base64', 'console']);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** [method, path pattern relative to /api/browser] for every route an automation may call. */
export const AUTOMATION_BROWSER_ROUTES = Object.freeze([
  ['GET', '/sessions'],
  ['POST', '/sessions'],
  ['POST', '/acquire'],
  ['POST', '/release'],
  ['DELETE', '/sessions/:id'],
  ...POST_ACTIONS.map((action) => ['POST', `/sessions/:id/${action}`]),
  ...GET_READS.map((read) => ['GET', `/sessions/:id/${read}`]),
].map((route) => Object.freeze(route)));

const MATCHERS = AUTOMATION_BROWSER_ROUTES.map(([method, path]) => ({
  method,
  re: new RegExp(`^${path.split('/').map((part) => (part === ':id' ? ID : escape(part))).join('/')}/?$`),
}));

/**
 * Whether an automation may call `method` `path`. `path` is relative to /api/browser (`/sessions/abc/navigate`), as
 * Express's req.path is under that mount; a query string is ignored. Anything that is not exactly one of the listed
 * routes is the owner's: another method, another path, an encoded or dot segment, a doubled slash.
 */
export function isAutomationBrowserRoute(method, path) {
  const verb = String(method || '').toUpperCase() === 'HEAD' ? 'GET' : String(method || '').toUpperCase();
  const bare = String(path || '').split('?')[0];
  if (!bare.startsWith('/') || bare.includes('//')) return false;
  return MATCHERS.some((m) => m.method === verb && m.re.test(bare));
}

/**
 * The fields of a session create that pick which browser or profile it starts (POST /api/browser/sessions): the
 * owner's choice (Settings → Browser), never an automation's. An automation's create opens the default browser.
 */
export const OWNER_ONLY_CREATE_FIELDS = Object.freeze(['connectMode', 'moreloginEnvId']);

/**
 * Every field that names a browser, a MoreLogin profile or a browser setting (PUT /api/browser/config's fields and
 * the names an agent reaches for: profile, config, a profile folder, a CDP endpoint). The owner's choice, never an
 * automation's: an automation's session create naming one is refused (403 OWNER_ONLY_FIELDS), and SynaBun's browser
 * MCP tools refuse a call that names one instead of dropping it (mcp-server/src/services/browser-route-flow.ts
 * OWNER_ONLY_FIELDS mirrors this list; tests/browser-automation-routes.test.mjs keeps the two equal). Until
 * 2026-11-05 the tools' schemas dropped them silently, so `profile: "other"` looked accepted.
 */
export const OWNER_ONLY_BROWSER_FIELDS = Object.freeze([
  ...OWNER_ONLY_CREATE_FIELDS, 'attachSeed', 'openTabsInBackground',
  'config', 'profile', 'profileDir', 'profilePath', 'userDataDir', 'executablePath',
  'moreloginProfile', 'moreloginEnv', 'moreloginEnvironment', 'cdpUrl', 'wsEndpoint',
]);

/** The owner-only fields a create body names (an empty list when none). */
export function ownerOnlyCreateFields(body) {
  if (!body || typeof body !== 'object') return [];
  return OWNER_ONLY_BROWSER_FIELDS.filter((field) => body[field] !== undefined && body[field] !== null && body[field] !== '');
}
