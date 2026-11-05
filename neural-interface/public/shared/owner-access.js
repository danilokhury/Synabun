// ═══════════════════════════════════════════
// SynaBun Neural Interface — a page without the owner's access: what it is and what it says
// ═══════════════════════════════════════════
//
// SynaBun's automation browser (the one its browser tools drive) may open SynaBun's own page, by design: it reads it,
// clicks it and takes screenshots. It never gets the owner's page secret (GET /api/page-session answers 403
// WORKER_BROWSER), so every owner route refuses it (403 WORKER_BROWSER, PAGE_SECRET_REQUIRED, OWNER_ROUTE). That
// refusal is right and stays. What this module is for is the page's side of it: a refused read is not an empty list,
// a default value or an "Off" state, and the page says so in one way everywhere (ui-owner-access.js draws it: one
// banner, and a "No access" state in the panels whose data was refused, their Save and actions disabled).
//
// page-session.js (the page's fetch, wrapped once) tells every final refusal (`synabun:owner-access-refused`); the
// panels that read through their own paths ask `refusalOfError` / `refusalOfResponse` about what they got.
//
// No DOM: `node --test` loads this file (tests/owner-access.test.mjs). OWNER_ACCESS_COPY is the English of every
// sentence; `ownerAccess.*` in i18n/en.json must equal it and i18n/pt-BR.json must have the same keys.

import { OWNER_ACCESS_CODES } from './page-session.js';

export { OWNER_ACCESS_CODES };

export const OWNER_ACCESS_COPY = Object.freeze({
  label: 'No owner access',
  title: 'This page doesn\'t have owner access.',
  bodyAutomation: 'It was opened from SynaBun\'s automation browser, which can read SynaBun\'s pages but not your settings, files or actions. Open SynaBun in your own browser or the desktop app.',
  bodyOwner: 'SynaBun refused this page your settings and actions. Reload the page; if it persists, open SynaBun in your own browser or the desktop app.',
  reload: 'Reload',
  dismiss: 'Dismiss',
  panelTitle: 'No access',
  panelBody: 'This page doesn\'t have owner access, so this can\'t be shown or changed here. Open SynaBun in your own browser or the desktop app.',
  navStatus: 'No access',
  actionDisabled: 'Needs owner access',
});

/** Why a page has no owner access: SynaBun's automation browser, or a refusal the page could not cure. */
export const OWNER_ACCESS_REASONS = Object.freeze(['automation', 'owner']);

/** The English of a key with its {values} filled; an unknown key is itself. */
export function ownerAccessText(key, params = {}) {
  const template = OWNER_ACCESS_COPY[key];
  if (typeof template !== 'string') return key;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? String(params[name]) : whole));
}

const reasonOf = (code) => (code === 'WORKER_BROWSER' ? 'automation' : 'owner');

/** A refusal from an answer's status and body: { code, reason } when it is a final owner refusal, else null. */
export function readOwnerAccessRefusal(status, body) {
  if (Number(status) !== 403 || !body || typeof body !== 'object') return null;
  const code = typeof body.code === 'string' ? body.code : null;
  if (!code || !OWNER_ACCESS_CODES.includes(code)) return null;
  return { code, reason: reasonOf(code) };
}

/**
 * The refusal an error (or a read result) stands for: api.js / asst-api.js errors carry `status` and `code` (and
 * `body`), a pane's own reading `{ ok: false, status, code }` too. null for anything else (a network error, a 500…).
 */
export function refusalOfError(err) {
  if (!err || typeof err !== 'object') return null;
  const status = Number(err.status ?? err.statusCode);
  const code = typeof err.code === 'string' ? err.code : (typeof err.body?.code === 'string' ? err.body.code : null);
  return readOwnerAccessRefusal(status, { code });
}

/** The refusal a fetch Response stands for (its body read from a clone: the response is untouched). */
export async function refusalOfResponse(res) {
  if (!res || Number(res.status) !== 403 || typeof res.clone !== 'function') return null;
  try { return readOwnerAccessRefusal(res.status, await res.clone().json()); } catch { return null; }
}

/**
 * What the page knows about its own access: null (nothing refused, or restored since) or { code, reason, url, at }.
 * Once SynaBun's automation browser is named (WORKER_BROWSER) the reason stays `automation` whatever comes after: that
 * is the one that explains the rest. `subscribe(fn)` is told every change (fn(current)); returns the unsubscribe.
 */
export function createOwnerAccessState({ now = () => Date.now() } = {}) {
  let current = null;
  const listeners = new Set();
  const tell = () => { for (const fn of [...listeners]) { try { fn(current); } catch { /* a listener's own error */ } } };
  return {
    current: () => current,
    /** A refusal was seen (an event's detail or a refusal): true when what the page knows changed. */
    note(detail) {
      const code = typeof detail?.code === 'string' ? detail.code : null;
      if (!code || !OWNER_ACCESS_CODES.includes(code)) return false;
      const reason = current?.reason === 'automation' ? 'automation' : reasonOf(code);
      if (current && current.reason === reason) return false;
      current = { code, reason, url: typeof detail.url === 'string' ? detail.url : '', at: now() };
      tell();
      return true;
    },
    /** The page got this boot's page secret: it is the owner's again. */
    clear() {
      if (!current) return false;
      current = null;
      tell();
      return true;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** A translator over OWNER_ACCESS_COPY: a key the page's translator does not know is English. */
export function ownerAccessSayer(t) {
  return (key, params) => {
    if (typeof t !== 'function') return ownerAccessText(key, params);
    try {
      const text = t(key, params);
      return typeof text === 'string' && text && text !== key && !text.endsWith(`.${key}`) ? text : ownerAccessText(key, params);
    } catch { return ownerAccessText(key, params); }
  };
}

/**
 * What the banner shows for what the page knows, or null (nothing refused).
 * → { key, label, title, body, actions: [{ id: 'reload'|'dismiss', label }] }. `key` is what a dismissal is
 * remembered by: the same reason stays dismissed.
 */
export function ownerAccessNoticeView(refusal, { t = null } = {}) {
  if (!refusal || !OWNER_ACCESS_REASONS.includes(refusal.reason)) return null;
  const say = ownerAccessSayer(t);
  return {
    key: `owner-access:${refusal.reason}`,
    label: say('label'),
    title: say('title'),
    body: say(refusal.reason === 'automation' ? 'bodyAutomation' : 'bodyOwner'),
    actions: [{ id: 'reload', label: say('reload') }, { id: 'dismiss', label: say('dismiss') }],
  };
}
