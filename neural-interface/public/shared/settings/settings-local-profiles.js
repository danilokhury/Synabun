// What Settings → Connected tools → MoreLogin decides about local profiles, without the page.
// No imports: `node --test` loads it (tests/settings-local-profiles.test.mjs).
//
// A local profile is a Chrome SynaBun runs itself on this computer (lib/local-profiles.js). It is listed with the
// MoreLogin profiles (`kind: 'local'` in GET /api/morelogin/profiles) and has an editor of its own, fed by
// GET /api/morelogin/local-profiles. The page draws; this module says what a row shows, where a new profile is
// created by default, and what the editor's fields mean as a request body.

export const PROXY_TYPES = Object.freeze(['none', 'http', 'https', 'socks5']);
export const DEFAULT_WINDOW = Object.freeze({ width: 1280, height: 800 });

/** Whether a listed profile is one of SynaBun's own. */
export function isLocalProfile(env) {
  return !!env && env.kind === 'local';
}

/** A local row's proxy in a few words: '' for none, else `SOCKS5 host:port`. `login`: the word for "with a login". */
export function proxySummary(env, login = '') {
  const proxy = env && env.proxy;
  if (!proxy || !proxy.type || proxy.type === 'none') return '';
  const where = [proxy.host, proxy.port].filter(Boolean).join(':');
  return [String(proxy.type).toUpperCase(), where, env.proxyUsername && login ? login : ''].filter(Boolean).join(' ');
}

/**
 * Where "Create" makes a profile when the owner has not chosen: 'local' while MoreLogin cannot make one (not
 * installed, closed, its API refusing) or after it refused one for its plan's limit, else 'morelogin'.
 * @param {{ installed?: boolean, running?: boolean, apiError?: string|null }|null} status  GET /api/morelogin/status
 */
export function defaultCreateWhere(status, { limitHit = false } = {}) {
  if (limitHit) return 'local';
  if (!status || !status.installed || !status.running || status.apiError) return 'local';
  return 'morelogin';
}

/**
 * What the Create button does: 'local' (a local profile), 'morelogin' (a MoreLogin profile, which takes one of the
 * plan's slots) or 'restart' (nothing is created: Local was asked of a server that is older than local profiles, and
 * the owner is told to restart SynaBun). A create asked as Local never becomes a MoreLogin one.
 * @param {{ where?: string, localKnown?: boolean }} o  `where`: the "Where" dropdown's value
 */
export function createAction({ where, localKnown } = {}) {
  if (where === 'local') return localKnown ? 'local' : 'restart';
  return 'morelogin';
}

/** The "Where" options. Local cannot be chosen while the running server does not know local profiles. */
export function whereOptions({ localKnown, selected = 'morelogin' } = {}) {
  const chosen = !localKnown && selected === 'local' ? 'morelogin' : selected;
  return [
    { value: 'local', disabled: !localKnown, selected: chosen === 'local' },
    { value: 'morelogin', disabled: false, selected: chosen !== 'local' },
  ];
}

/**
 * Whether the editor has to ask for the proxy password again: the profile has a saved one, none was typed, and the
 * proxy's type, host, port or username is no longer the saved one. The server drops the saved password then (it was
 * typed for another server or another account), so a save or a proxy check without it would go out with no password.
 * @param values  the editor's fields as typed
 * @param profile the row of GET /api/morelogin/local-profiles the editor was opened on
 */
export function passwordNeededAgain(values, profile) {
  const v = values || {};
  if (!profile || !profile.hasPassword || v.passwordTouched) return false;
  const type = PROXY_TYPES.includes(v.proxyType) ? v.proxyType : 'none';
  if (type === 'none' || !String(v.username ?? '').trim()) return false;
  const saved = formOfProfile(profile);
  return type !== saved.proxyType
    || String(v.host ?? '').trim() !== saved.host
    || String(Number(String(v.port ?? '').trim())) !== String(Number(saved.port))
    || String(v.username ?? '').trim() !== saved.username;
}

/** Whether a failed create is MoreLogin's plan limit (the server's code). */
export function isPlanLimit(answer) {
  return !!answer && answer.ok === false && answer.code === 'MORELOGIN_PLAN_LIMIT';
}

/** Whether Intl knows a timezone name (an IANA name such as America/Sao_Paulo). */
export function validTimezone(name) {
  const value = String(name ?? '').trim();
  if (!value) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

/** Whether a text is a language tag (pt-BR, en-US, de). */
export function validLanguage(tag) {
  const value = String(tag ?? '').trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) return false;
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
}

/** The editor's fields for one profile of GET /api/morelogin/local-profiles. The password is never among them. */
export function formOfProfile(profile) {
  const p = profile || {};
  const proxy = p.proxy || null;
  return {
    name: String(p.name ?? ''),
    proxyType: proxy && PROXY_TYPES.includes(proxy.type) ? proxy.type : 'none',
    host: proxy ? String(proxy.host ?? '') : '',
    port: proxy && proxy.port != null ? String(proxy.port) : '',
    username: String(p.proxyUsername ?? ''),
    password: '',
    hasPassword: !!p.hasPassword,
    language: String(p.language ?? ''),
    timezone: String(p.timezone ?? ''),
    width: String(p.window?.width ?? DEFAULT_WINDOW.width),
    height: String(p.window?.height ?? DEFAULT_WINDOW.height),
    notes: String(p.notes ?? ''),
  };
}

/**
 * The editor's fields as the body of PUT /api/morelogin/local-profiles/:id.
 * → { ok: true, body } or { ok: false, errors: { field: reason } } with reasons 'name' | 'host' | 'port' | 'language'
 * | 'timezone' | 'window' (the page says each in its own words).
 * The password travels only when the owner typed one (`passwordTouched`): an untouched field keeps the saved one,
 * which the server never sends back.
 */
export function readLocalProfileForm(values) {
  const v = values || {};
  const errors = {};
  const name = String(v.name ?? '').trim();
  if (!name || name.length > 80) errors.name = 'name';
  const type = PROXY_TYPES.includes(v.proxyType) ? v.proxyType : 'none';
  const proxy = { type };
  if (type !== 'none') {
    const host = String(v.host ?? '').trim();
    if (!host || /[\s/@?#]/.test(host)) errors.host = 'host';
    const port = Number(String(v.port ?? '').trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'port';
    proxy.host = host;
    proxy.port = port;
    proxy.username = String(v.username ?? '').trim();
    if (v.passwordTouched) proxy.password = String(v.password ?? '');
  }
  const language = String(v.language ?? '').trim();
  if (language && !validLanguage(language)) errors.language = 'language';
  const timezone = String(v.timezone ?? '').trim();
  if (timezone && !validTimezone(timezone)) errors.timezone = 'timezone';
  const width = Number(String(v.width ?? '').trim() || DEFAULT_WINDOW.width);
  const height = Number(String(v.height ?? '').trim() || DEFAULT_WINDOW.height);
  if (!Number.isInteger(width) || width < 400 || width > 7680 || !Number.isInteger(height) || height < 300 || height > 4320) errors.window = 'window';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, body: { name, proxy, language, timezone, window: { width, height }, notes: String(v.notes ?? '').slice(0, 2000) } };
}

/** The proxy of the editor's fields as "check proxy" takes it (the unsaved values), or null when they are not usable. */
export function proxyOfForm(values) {
  const read = readLocalProfileForm({ ...values, name: values?.name || 'x', language: '', timezone: '', width: '', height: '' });
  return read.ok ? read.body.proxy : null;
}
