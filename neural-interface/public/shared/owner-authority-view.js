// ═══════════════════════════════════════════
// SynaBun Neural Interface — the banner of a degraded owner authority: what it says
// ═══════════════════════════════════════════
//
// On macOS the server tells the owner's own page from every other local program by the process at the other end of
// the connection (lib/peer-identity.js). When it cannot look that process up (netstat or ps missing, denied because
// the server was started inside a sandbox, slow past its cap), it proves nothing about who is asking and pauses the
// owner's actions: no page secret, and the owner's writes, reads and sockets answer 503 PEER_UNAVAILABLE. GET
// /api/health says so (`ownerAuthority: { state: 'degraded', reason, retryable, since }`), and so does every 503
// PEER_UNAVAILABLE a request of the page gets (public/shared/page-session.js turns it into the
// `synabun:peer-unavailable` event). This module decides the words of the banner; ui-owner-authority.js asks the
// server, listens and draws them. `unsupported` (Windows, Linux) and `off` (SYNABUN_PEER_IDENTITY=off) show nothing:
// there the rules from before apply and nothing is paused.
//
// No imports and no DOM: `node --test` loads this file as it is (tests/owner-authority-notice.test.mjs).
// OWNER_AUTHORITY_NOTICE_COPY is the English of every sentence; `ownerAuthorityNotice.*` in i18n/en.json must equal
// it and i18n/pt-BR.json must have the same keys.

export const OWNER_AUTHORITY_NOTICE_COPY = Object.freeze({
  label: 'Owner actions paused',
  title: 'SynaBun can\'t verify which program is calling it, so the owner\'s actions are paused.',
  body: 'Settings, files, terminals, the agent panels and dispatching are refused until the check works again. Pages and memories still load.',
  reason: 'Reason: {reason}',
  hint: 'If this persists, start SynaBun outside any sandbox, or add SYNABUN_PEER_IDENTITY=off to ~/.synabun/.env and restart SynaBun (this turns the check off).',
  reload: 'Reload to retry',
  dismiss: 'Dismiss',
});

/** The states GET /api/health can name (lib/peer-identity.js authorityState). */
export const OWNER_AUTHORITY_STATES = Object.freeze(['ok', 'degraded', 'unsupported', 'off']);
/** The longest reason the banner shows (the server's reasons are short; a longer one is cut). */
export const REASON_MAX = 200;

/** A sentence of OWNER_AUTHORITY_NOTICE_COPY in English with its {values} filled; an unknown key is itself. */
export function ownerAuthorityText(key, params = {}) {
  const template = OWNER_AUTHORITY_NOTICE_COPY[key];
  if (typeof template !== 'string') return key;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] != null ? String(params[name]) : whole));
}

const cleanReason = (value) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
};

/**
 * The owner authority a GET /api/health answer reports, or null (an older server says nothing, a body that is not
 * one): { state, reason, retryable, since }.
 */
export function readOwnerAuthority(health) {
  const raw = health && typeof health === 'object' ? health.ownerAuthority : null;
  if (!raw || typeof raw !== 'object' || !OWNER_AUTHORITY_STATES.includes(raw.state)) return null;
  return {
    state: raw.state,
    reason: cleanReason(raw.reason) || null,
    retryable: raw.retryable === true,
    since: typeof raw.since === 'string' ? raw.since : null,
  };
}

/** The state a 503 PEER_UNAVAILABLE answer stands for (the event's detail, or the answer's body). */
export function unavailableAuthority(detail) {
  return { state: 'degraded', reason: cleanReason(detail?.reason) || null, retryable: detail?.retryable === true, since: null };
}

/**
 * What the banner shows for a state, or null when it shows nothing (ok, unsupported, off, nothing known).
 * `t(key, params)` is the page's translator for `ownerAuthorityNotice.*` (English by default).
 * → { key, label, title, body, reason, hint, actions: [{ id: 'reload'|'dismiss', label }] }. `key` is what a
 * dismissal is remembered by: the same outage stays dismissed, a new reason shows again.
 */
export function ownerAuthorityNoticeView(authority, { t = ownerAuthorityText } = {}) {
  if (!authority || authority.state !== 'degraded') return null;
  // (a translator that does not know a key answers the key itself, short or as its whole path: English then)
  const say = (key, params) => {
    try {
      const text = t(key, params);
      return typeof text === 'string' && text && text !== key && !text.endsWith(`.${key}`) ? text : ownerAuthorityText(key, params);
    } catch { return ownerAuthorityText(key, params); }
  };
  const reason = cleanReason(authority.reason);
  return {
    key: `degraded:${reason || 'unknown'}`,
    label: say('label'),
    title: say('title'),
    body: say('body'),
    reason: reason ? say('reason', { reason }) : '',
    // A failure that may pass by itself (a timeout) is what a reload cures; one that does not needs the way out.
    hint: authority.retryable ? '' : say('hint'),
    actions: [{ id: 'reload', label: say('reload') }, { id: 'dismiss', label: say('dismiss') }],
  };
}
