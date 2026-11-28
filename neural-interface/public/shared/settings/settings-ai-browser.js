// The AI browser: the browser SynaBun's own web tasks run in. It is SynaBun's local browser (Settings → Browser), or a
// MoreLogin / SynaBun local profile chosen in Settings → Connected tools → MoreLogin → Default AI browser. The saved
// browser config holds it as it always has: `connectMode: 'morelogin'` + `moreloginEnvId` (lib routes unchanged:
// POST /api/morelogin/use-default writes it, PUT /api/browser/config carries it back whole).
//
// Who decides what:
//   - the MoreLogin tab's card is the only place that turns a profile on or off as the AI browser (and its per-row
//     "Use as default" button, which is the same request);
//   - the Browser tab never turns it on or off and never changes or clears the profile: a save there carries back
//     what the server holds at that moment (browserSaveFields), whatever its own Connection field shows.
//
// DOM-free and without imports: node --test and the page load the same file.

/** The modes offered in the Browser tab's Connection dropdown. */
export const LOCAL_CONNECT_OPTIONS = Object.freeze(['attach', 'extension']);

/** Deprecated in the menu. Still supported for saved configs and as the server's local default. */
export const LOCAL_DEFAULT_MODE = 'mirror';

/**
 * The Browser tab's Connection mode menu, in reading order: my browser through the extension, the local browser, and
 * a MoreLogin / SynaBun profile. The last one is a view only: it shows where a profile is chosen (Connected tools) and
 * is never saved from here (browserSaveFields keeps the local mode the server holds).
 */
export const CONNECT_MENU_OPTIONS = Object.freeze(['extension', 'attach', 'morelogin']);

/**
 * Which parts of the Browser tab a Connection mode shows. A profile that is the AI browser wins over the form: the menu
 * then shows the profile choice, disabled, with the banner that names it.
 * @returns {{ mode: string, extension: boolean, local: boolean, profile: boolean, active: boolean }}
 */
export function connectionParts(formMode, current) {
  const active = !!(current && typeof current === 'object' && current.moreLogin === true);
  const mode = active ? 'morelogin' : (CONNECT_MENU_OPTIONS.includes(formMode) || formMode === LOCAL_DEFAULT_MODE ? formMode : LOCAL_DEFAULT_MODE);
  return { mode, extension: mode === 'extension', local: mode === 'attach' || mode === LOCAL_DEFAULT_MODE, profile: mode === 'morelogin' && !active, active };
}

const idOf = (value) => (value === undefined || value === null || value === '' ? null : String(value));

/**
 * The AI browser a browser config (GET /api/browser/config `config`) or a use-default answer describes.
 * @returns {{ moreLogin: boolean, envId: string|null }}
 */
export function aiBrowserOf(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return { moreLogin: c.connectMode === 'morelogin', envId: idOf(c.moreloginEnvId) };
}

/**
 * The AI browser GET /api/morelogin/status describes (`isDefault`, `defaultEnvId`).
 * @returns {{ moreLogin: boolean, envId: string|null }}
 */
export function aiBrowserOfStatus(status) {
  const s = status && typeof status === 'object' ? status : {};
  return { moreLogin: s.isDefault === true, envId: idOf(s.defaultEnvId) };
}

/** The Connection dropdown's value for a loaded config: a local mode, never 'morelogin' (it has no such option). */
export function localConnectModeOf(cfg) {
  const mode = cfg && typeof cfg === 'object' ? cfg.connectMode : null;
  return LOCAL_CONNECT_OPTIONS.includes(mode) ? mode : LOCAL_DEFAULT_MODE;
}

/**
 * The connection fields of a Browser tab save. `formMode`: its Connection dropdown. `current`: the AI browser as the
 * server holds it now (aiBrowserOf of a fresh read; the last one known when that read failed). A MoreLogin AI browser
 * stays exactly as it is, profile included; otherwise the local mode is the form's and the remembered profile id is
 * kept (never cleared from here). `savedLocal`: the local mode the last read held, kept when the form only shows the
 * profile choice (that choice is never saved from the Browser tab: a profile is turned on in Connected tools).
 * @returns {{ connectMode: string, moreloginEnvId: string|null }}
 */
export function browserSaveFields(formMode, current, savedLocal = LOCAL_DEFAULT_MODE) {
  const now = current && typeof current === 'object' ? current : {};
  const envId = idOf(now.envId);
  if (now.moreLogin === true) return { connectMode: 'morelogin', moreloginEnvId: envId };
  const kept = LOCAL_CONNECT_OPTIONS.includes(savedLocal) ? savedLocal : LOCAL_DEFAULT_MODE;
  return { connectMode: LOCAL_CONNECT_OPTIONS.includes(formMode) ? formMode : formMode === 'morelogin' ? kept : LOCAL_DEFAULT_MODE, moreloginEnvId: envId };
}

/**
 * What the card's on/off switch asks of POST /api/morelogin/use-default.
 * `chosen`: the picker's profile id; `firefox`: that profile is known to be Firefox-type (cannot be driven).
 * @returns {{ body: Object } | { refuse: 'pickFirst' | 'firefox' }}
 */
export function switchRequest({ on, chosen, firefox = false } = {}) {
  if (!on) return { body: { clear: true } };
  const envId = idOf(chosen);
  if (!envId) return { refuse: 'pickFirst' };
  if (firefox) return { refuse: 'firefox' };
  return { body: { envId } };
}

/**
 * What a new choice in the card's picker asks: saved at once while the switch is on, only remembered while it is
 * off (the switch then uses it). Nothing when it is already the AI browser, or cannot be one.
 * @returns {{ body: Object } | null}
 */
export function pickRequest({ on, chosen, current, firefox = false } = {}) {
  const envId = idOf(chosen);
  if (!on || !envId || firefox) return null;
  const now = current && typeof current === 'object' ? current : {};
  if (now.moreLogin === true && idOf(now.envId) === envId) return null;
  return { body: { envId } };
}

/**
 * The line that says what the AI browser is: one key of `settings.redesign.morelogin.aiBrowser.line.*` (the card) or
 * `settings.redesign.browser.aiBrowser.*` (the Browser tab) and its params. `profile`: { name, kind } of the profile
 * when it was listed (kind 'local' for SynaBun's own); its id stands in for a name the list did not give.
 * @returns {{ key: 'off' | 'moreLogin' | 'local', params: { name?: string } }}
 */
export function aiBrowserLine(state, profile = null) {
  const s = state && typeof state === 'object' ? state : {};
  if (s.moreLogin !== true) return { key: 'off', params: {} };
  const name = (profile && profile.name != null && String(profile.name).trim()) || idOf(s.envId) || '?';
  return { key: profile && profile.kind === 'local' ? 'local' : 'moreLogin', params: { name: String(name) } };
}

/** The listed profile with this id, or null. `envs`: rows of GET /api/browser/morelogin-envs or /api/morelogin/profiles. */
export function profileOf(envs, envId) {
  const id = idOf(envId);
  if (!id || !Array.isArray(envs)) return null;
  const row = envs.find((e) => e && idOf(e.id) === id);
  return row ? { name: row.name ?? null, kind: row.kind === 'local' ? 'local' : 'morelogin', browser: row.browser ?? null } : null;
}

/** The event the MoreLogin tab sends on the Settings overlay whenever it learns the AI browser (detail: aiBrowserDetail). */
export const AI_BROWSER_EVENT = 'stg-ai-browser';

/** The event's detail: the state and, when known, the profile's name and kind. */
export function aiBrowserDetail(state, profile = null) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    moreLogin: s.moreLogin === true,
    envId: idOf(s.envId),
    name: profile && profile.name != null ? String(profile.name) : null,
    kind: profile && profile.kind === 'local' ? 'local' : (profile ? 'morelogin' : null),
  };
}
