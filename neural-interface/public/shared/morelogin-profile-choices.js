// What the "MoreLogin profile" field (morelogin-profile-field.js) decides, without the page: how an answer of
// GET /api/browser/morelogin-envs reads, which choices the popup offers and what the line under it says.
// No imports: `node --test` loads it (tests/morelogin-profile-choices.test.mjs).
//
// SynaBun drives a MoreLogin profile over the Chrome DevTools protocol, so only a Chrome-type profile can be chosen.
// The list says each profile's browser (`browser`: 'chromium' | 'firefox' | null = not known): a Firefox-type one is
// listed, said as such and cannot be picked; one a record already holds stays its selection with a warning, as a
// profile MoreLogin no longer lists does. A browser that is not known is offered: the run's start still checks.

//
// Local profiles (2026-11-11): the same list holds SynaBun's own profiles (`kind: 'local'`: a Chrome SynaBun runs
// itself, lib/local-profiles.js). They are in every answer, also while MoreLogin is closed, not installed or
// refusing, and show as "Name · local". A chosen local profile is judged by the local list alone: MoreLogin being
// closed is no warning for it, and one that is no longer listed is missing whatever MoreLogin does.

// What the field says under the popup, by what the profile is chosen for.
const HELP_KEY = { schedule: 'schedules.form.moreloginHelp', group: 'schedules.form.moreloginHelpGroup', run: 'schedules.form.moreloginHelpRun' };
const MISSING_KEY = { schedule: 'schedules.form.moreloginMissing', group: 'schedules.form.moreloginMissingGroup', run: 'schedules.form.moreloginMissingRun' };
const FIREFOX_KEY = { schedule: 'schedules.form.moreloginFirefox', group: 'schedules.form.moreloginFirefoxGroup', run: 'schedules.form.moreloginFirefoxRun' };

const opt = (value, label, selected = false) => ({ value: value ?? '', label: String(label ?? ''), selected: !!selected });

/** The browser a listed profile runs, as the server said it: 'chromium', 'firefox' or null (not known). */
export function moreLoginBrowserOf(env) {
  return env?.browser === 'firefox' || env?.browser === 'chromium' ? env.browser : null;
}

/** Whether an id is a local profile's (lib/local-profiles.js: `lp-` and 12 hex characters). */
export function isLocalProfileId(id) {
  return typeof id === 'string' && /^lp-[0-9a-f]{12}$/.test(id);
}

const envRow = (e) => ({ id: String(e.id), name: String(e.name ?? ''), status: e.status ? String(e.status) : '', browser: moreLoginBrowserOf(e), ...(e.kind === 'local' ? { kind: 'local' } : {}) });

/**
 * What one answer of GET /api/browser/morelogin-envs means to the field.
 *   d       the answer's body (null when it could not be read)
 *   ok      whether the HTTP status was a success; `status` is shown when the body names no error
 * `pending`: profiles whose browser the server is still asking MoreLogin for (an older server says none).
 */
export function readMoreLoginProfiles(d, ok = true, status = 0) {
  const failed = !d || d.ok === false || !ok;
  return {
    loading: false,
    installed: !!d?.installed,
    running: !!d?.running,
    isDefault: d?.connectMode === 'morelogin',
    listed: !failed && !!d.running,
    // MoreLogin's profiles when its list was read; the local ones whenever the server sent them (a refused or closed
    // MoreLogin does not hide them).
    envs: Array.isArray(d?.envs)
      ? d.envs.filter(e => e && (!failed || e.kind === 'local')).map(envRow)
      : [],
    // `local`: the server knows local profiles ({ count }); an older one sends none and `localListed` stays false.
    localListed: !!d && typeof d.local === 'object' && d.local !== null && !d.local.error && Array.isArray(d.envs),
    localCount: Array.isArray(d?.envs) ? d.envs.filter(e => e && e.kind === 'local').length : 0,
    pending: !failed && Number(d.browsersPending) > 0 ? Number(d.browsersPending) : 0,
    error: failed ? String(d?.error || status) : '',
  };
}

/** Whether two readings show the same thing (the count still being looked up aside). */
export function sameMoreLoginProfiles(a, b) {
  return JSON.stringify({ ...a, pending: 0 }) === JSON.stringify({ ...b, pending: 0 });
}

/**
 * The popup's choices and the line under it.
 *   ml           the list as readMoreLoginProfiles gives it (or the loading placeholder)
 *   chosenId     the field's value ('' = the default); chosenName its display name
 *   context      'schedule' | 'group' | 'run'
 *   inheritLabel the first choice's label when an empty value is not the Browser settings default
 *   say          (key, params) → text
 * → { entries, helpKey, helpParams, warn, firefox, missing }; entries are cc-dropdown's ({ value, label, selected,
 *   disabled }). The chosen profile is always among them and selected, usable or not: it is never dropped quietly.
 */
export function moreLoginChoices({ ml, chosenId = '', chosenName = '', context = 'schedule', inheritLabel = '', say }) {
  const envs = Array.isArray(ml?.envs) ? ml.envs : [];
  const listed = envs.find(e => e.id === chosenId) || null;
  const known = !!listed;
  // A local profile is missing when the local list does not hold it; a MoreLogin one when MoreLogin's does not.
  const chosenLocal = isLocalProfileId(chosenId);
  const missing = !!chosenId && !known && (chosenLocal ? !!ml?.localListed : !!ml?.listed);
  const firefox = listed?.browser === 'firefox';
  const label = (e) => `${e.kind === 'local' ? say('schedules.form.moreloginLocalOption', { name: e.name || e.id }) : (e.name || e.id)}${e.status ? ` (${e.status})` : ''}`;
  // What MoreLogin named shows as it is (cc-dropdown escapes the labels).
  const entries = [
    opt('', inheritLabel || say('schedules.form.moreloginDefault'), !chosenId),
    ...envs.map(e => (e.browser === 'firefox'
      ? { ...opt(e.id, say('schedules.form.moreloginFirefoxOption', { name: e.name || e.id }), e.id === chosenId), disabled: true }
      : opt(e.id, label(e), e.id === chosenId))),
    ...(chosenId && !known
      ? [opt(chosenId, missing ? say('schedules.form.moreloginMissingOption', { name: chosenName }) : say('schedules.launch.saved', { value: chosenName }), true)]
      : []),
  ];
  let helpKey = HELP_KEY[context] || HELP_KEY.schedule;
  let helpParams;
  let warn = false;
  if (missing) { helpKey = MISSING_KEY[context] || MISSING_KEY.schedule; helpParams = { name: chosenName }; warn = true; }
  else if (firefox) { helpKey = FIREFOX_KEY[context] || FIREFOX_KEY.schedule; helpParams = { name: chosenName }; warn = true; }
  else if (ml?.loading && !ml?.listed) helpKey = 'schedules.form.moreloginLoading';
  // MoreLogin's own state is no news for a local profile that is listed, nor where there are only local profiles.
  else if (chosenLocal && known) { /* the context's own help */ }
  else if (ml?.error) { helpKey = 'schedules.form.moreloginError'; helpParams = { error: ml.error }; warn = true; }
  else if (!ml?.running && !(ml?.localCount > 0 && !ml?.installed)) { helpKey = 'schedules.form.moreloginNotRunning'; warn = !!chosenId; }
  return { entries, helpKey, helpParams, warn, firefox, missing };
}
