// The "MoreLogin profile" field of everything that starts a browser run: a schedule, a schedule group, a quick timer
// and a manual launch (Schedules window, Automation Studio). One list (GET /api/browser/morelogin-envs, the one
// Settings → Browser reads), one field, drawn in the look of the form it sits in.
//
//   1. Markup: moreLoginFieldHTML({ id, value, savedName, context, variant, ... }) where the form's rows are built.
//   2. Wiring: wireMoreLoginFields(root, { signal }) once per window (the Refresh button; cc-dropdown.js wires the popup).
//   3. Reading: readMoreLoginField(id) → { moreloginEnvId, moreloginEnvName } (null while the field is not on screen).
//
// The field shows where MoreLogin is in use (it is the default browser, or installed) and for a record that has a
// profile saved; until then it is an empty hidden element that fills in when the list arrives. A saved profile
// MoreLogin no longer lists stays selected and is said as such: it is never dropped quietly. The first choice is
// always "Browser settings default" (or what the record inherits): an empty value, which is what every record without
// the field means. When the list arrives or is refreshed, each field on screen is redrawn in place with the choice it
// shows, so the form around it keeps its focus, its scroll and what was typed.
//
// SynaBun drives a MoreLogin profile over the Chrome DevTools protocol, so only a Chrome-type profile can be chosen.
// The list says each profile's browser (`browser`: 'chromium' | 'firefox' | null = not known): a Firefox-type one is
// listed, said as such and cannot be picked; one a record already holds stays its selection with a warning, as a
// profile MoreLogin no longer lists does. A browser that is not known is offered (the run's start still checks). The
// server looks the browsers up profile by profile, so a first answer may leave some out (`browsersPending`): the
// list is then asked again quietly, a few times, and a field is redrawn only when something it shows changed.
// What is decided (how an answer reads, the choices, the line under the popup) is morelogin-profile-choices.js.

import { dropdownHTML } from './cc-dropdown.js';
import { t } from './i18n.js';
import { moreLoginChoices, readMoreLoginProfiles, sameMoreLoginProfiles } from './morelogin-profile-choices.js';

const REFRESH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13.2 2.3v3.2H10"/></svg>';
const MAX_AGE = 30_000;
const PENDING_RETRY_MS = 2500; // between the quiet asks while the server still looks browsers up
const PENDING_RETRIES = 8;

let _profiles = null;   // { loading, installed, running, listed, isDefault, envs: [{ id, name, status, browser }], error }
let _loadedAt = 0;
let _request = 0;
let _pendingTimer = null;
let _pendingTries = 0;
const _fields = new Map(); // the popup's input id → what the field was drawn with

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const te = (key, params) => esc(t(key, params));

/**
 * Ask MoreLogin's profiles again. A list already shown stays while the new one is on its way.
 * `quiet`: the ask that follows an answer with browsers still looked up; it shows no loading state, and the fields
 * are redrawn only when the answer differs from what they show.
 */
export async function loadMoreLoginProfiles({ quiet = false } = {}) {
  const request = ++_request;
  clearTimeout(_pendingTimer);
  _pendingTimer = null;
  if (!quiet) {
    _pendingTries = 0;
    _profiles = { installed: false, running: false, listed: false, isDefault: false, envs: [], error: '', ...(_profiles || {}), loading: true };
    redrawMoreLoginFields(); // Refresh off until the answer
  }
  let next;
  try {
    const res = await fetch('/api/browser/morelogin-envs');
    next = readMoreLoginProfiles(await res.json(), res.ok, res.status);
  } catch (err) {
    next = { loading: false, installed: false, running: false, isDefault: false, listed: false, envs: [], localListed: false, localCount: 0, pending: 0, error: err?.message || String(err) };
  }
  if (request !== _request) return;
  const changed = !quiet || !sameMoreLoginProfiles(next, _profiles);
  _profiles = next;
  _loadedAt = Date.now();
  if (changed) redrawMoreLoginFields();
  if (next.pending > 0 && _pendingTries < PENDING_RETRIES && typeof document !== 'undefined') {
    _pendingTries += 1;
    _pendingTimer = setTimeout(() => {
      _pendingTimer = null;
      // Only while a field is on screen to show the answer; the next form that opens asks by itself.
      if ([..._fields.keys()].some(id => document.querySelector(`[data-ml-field="${CSS.escape(id)}"]`))) loadMoreLoginProfiles({ quiet: true });
    }, PENDING_RETRY_MS);
  }
}

/** The list for a form that opens: asked when it was never asked, or when the answer is older than `maxAge`. */
export function ensureMoreLoginProfiles(maxAge = MAX_AGE) {
  if (_profiles?.loading) return;
  if (!_profiles || Date.now() - _loadedAt > maxAge) loadMoreLoginProfiles();
}

/** The name a profile id shows under: MoreLogin's when it lists the profile, else the one saved with the record. */
export function moreLoginProfileName(id, savedName = null) {
  if (!id) return null;
  const listed = _profiles?.envs?.find(e => e.id === String(id));
  return listed?.name || savedName || null;
}

/**
 * The field's markup, and its registration for the redraws.
 *   id            the popup's hidden input (the value to read)
 *   value         the chosen profile id ('' / null = the default); undefined keeps what the field on screen shows
 *   savedName     the name saved with `value` (shown when MoreLogin does not list the profile)
 *   context       'schedule' | 'group' | 'run' (a quick timer, a manual launch): which explanation shows
 *   variant       'sched' (the Schedules window's form rows) | 'as' (Automation Studio's labelled blocks)
 *   wrapClass     'as' only: the block's own class (as-launch-section, as-qt-group)
 *   dropdownClasses  extra classes of the popup
 *   inheritLabel  the first choice's label when an empty value is not the Browser settings default (a group's profile)
 */
export function moreLoginFieldHTML(options) {
  const previous = _fields.get(options.id);
  let { value, savedName } = options;
  if (value === undefined) {
    const input = document.getElementById(options.id);
    value = input ? input.value : (previous?.value ?? '');
    const previousSaved = previous && String(previous.savedId || '') === String(value || '');
    if (savedName === undefined) savedName = previousSaved ? previous.savedName : null;
  }
  const field = { ...options, value: value ? String(value) : '', savedId: value ? String(value) : '', savedName: savedName || null };
  _fields.set(options.id, field);
  return fieldHTML(field);
}

/** The field's choice, or null while it is not on screen (the caller then keeps what it holds). */
export function readMoreLoginField(id) {
  const input = document.getElementById(id);
  if (!input) return null;
  const field = _fields.get(id);
  const envId = input.value || null;
  const savedName = field && envId && field.savedId === envId ? field.savedName : null;
  return { moreloginEnvId: envId, moreloginEnvName: envId ? moreLoginProfileName(envId, savedName) : null };
}

/** The Refresh button of every field under `root`. */
export function wireMoreLoginFields(root, { signal } = {}) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-ml-refresh]');
    if (!button || !root.contains(button) || button.disabled) return;
    loadMoreLoginProfiles();
  }, { signal });
}

function redrawMoreLoginFields() {
  if (typeof document === 'undefined') return;
  for (const [id, field] of _fields) {
    const el = document.querySelector(`[data-ml-field="${CSS.escape(id)}"]`);
    if (!el) continue; // its form is not on screen (the ids are a fixed few: nothing to forget)
    const input = document.getElementById(id);
    if (input) field.value = input.value || '';
    const refocus = el.contains(document.activeElement) && document.activeElement?.hasAttribute('data-ml-refresh');
    el.outerHTML = fieldHTML(field);
    if (refocus) document.getElementById(`${id}-refresh`)?.focus({ preventScroll: true });
  }
}

function fieldHTML(field) {
  const { id, variant = 'sched', context = 'schedule' } = field;
  const ml = _profiles || { loading: true, envs: [] };
  const chosenId = field.value || '';
  const fieldAttrs = `id="${esc(id)}-field" data-ml-field="${esc(id)}"`;
  // Shown where MoreLogin is in use, where SynaBun has local profiles of its own, and for a record that holds one.
  if (!chosenId && !ml.installed && !ml.isDefault && !(ml.localCount > 0)) {
    return variant === 'sched' ? `<div class="sched-form-row" ${fieldAttrs} hidden></div>` : `<div ${fieldAttrs} hidden></div>`;
  }
  const chosenName = moreLoginProfileName(chosenId, field.savedId === chosenId ? field.savedName : null) || chosenId;
  const { entries, helpKey, helpParams, warn } = moreLoginChoices({ ml, chosenId, chosenName, context, inheritLabel: field.inheritLabel, say: t });
  const help = te(helpKey, helpParams);

  const refreshLabel = te('schedules.form.moreloginRefresh');
  const refresh = (cls) => `<button type="button" class="${cls}" id="${esc(id)}-refresh" data-ml-refresh aria-label="${refreshLabel}" data-tooltip="${refreshLabel}"${ml.loading ? ' disabled' : ''}>${REFRESH_ICON}</button>`;
  const popup = dropdownHTML(id, entries, { labelledBy: `${id}-label`, classes: field.dropdownClasses || '' });
  const status = warn ? ' role="status"' : '';

  if (variant === 'as') {
    return `<div class="${esc(field.wrapClass || 'as-qt-group')} as-ml-field" ${fieldAttrs}>
      <span class="as-launch-label" id="${esc(id)}-label">${te('schedules.form.moreloginProfile')}</span>
      <div class="as-ml-control">${popup}${refresh('as-ml-refresh')}</div>
      <p class="as-ml-help${warn ? ' as-ml-help--warn' : ''}" id="${esc(id)}-help"${status}>${help}</p>
    </div>`;
  }
  return `<div class="sched-form-row sched-form-row--top" ${fieldAttrs}>
    <label class="sched-form-label" id="${esc(id)}-label">${te('schedules.form.moreloginProfile')}</label>
    <div class="sched-form-stack">
      <div class="sched-form-control">
        ${popup}
        ${refresh('sched-icon-btn')}
      </div>
      <p class="sched-help${warn ? ' sched-help--warn' : ''}" id="${esc(id)}-help"${status}>${help}</p>
    </div>
  </div>`;
}
