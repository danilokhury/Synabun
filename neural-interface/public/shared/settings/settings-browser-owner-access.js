// ═══════════════════════════════════════════
// SETTINGS — Let the automation browser act as owner, in words
// ═══════════════════════════════════════════
//
// What `GET /api/assistant/automation-browser-owner-access` (lib/assistant-api.js; the setting in
// lib/automation-browser-owner-access.js, enforced by lib/page-session.js and lib/owner-authority.js) says about
// Settings → Browser → Automation browser access: whether the switch is on, whether it can be changed, and what
// stands in the way. Pure: no DOM and no import, so node runs it (tests/settings-browser-owner-access-view.test.mjs).
//
//   readOwnerAccessResponse({ status, body, error })   what the server answered → a reading
//   describeOwnerAccess(reading, { tx })                the row as ui-settings.js draws it
//   describeOwnerAccessSaveFailure(input, { tx })       the sentence for a change that could not be saved
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the kit's `tx`).
// The row never shows a healthy-looking switch for something that is not happening: a server started before the
// setting existed shows it off, disabled, and says a restart is missing.

const K = 'settings.redesign.browser.ownerAccess';

export const OWNER_ACCESS_DEFAULT = false;

const clean = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * What the server answered.
 *
 *   ready        the setting is there: `enabled` is in effect
 *   old-server   404: the running server was started before the setting existed
 *   failed       503 OWNER_ACCESS_UNAVAILABLE: the setting did not start; `reason` is the error
 *   unreadable   anything else (no answer, a refusal, a body that is not the payload)
 */
export function readOwnerAccessResponse({ status = 0, body = null, error = null } = {}) {
  const code = Number(status) || 0;
  if (code === 404) return { state: 'old-server', enabled: OWNER_ACCESS_DEFAULT, reason: null };
  if (code === 503) return { state: 'failed', enabled: OWNER_ACCESS_DEFAULT, reason: clean(body?.reason || body?.error) || null };
  if (code >= 200 && code < 300 && body && typeof body === 'object' && body.ok !== false && typeof body.enabled === 'boolean') {
    return { state: 'ready', enabled: body.enabled, reason: null };
  }
  return { state: 'unreadable', enabled: OWNER_ACCESS_DEFAULT, reason: clean(error || body?.error || (code ? `HTTP ${code}` : '')) || null };
}

/** The row: { ready, disabled, on, note: { text, tone } | null, warning: string | null, applies }. */
export function describeOwnerAccess(reading, { tx }) {
  const r = reading || readOwnerAccessResponse({ status: 0 });
  let note = null;
  if (r.state === 'old-server') note = { text: tx(`${K}.restart`), tone: 'warn' };
  else if (r.state === 'failed') note = { text: r.reason ? tx(`${K}.failed`, { reason: r.reason }) : tx(`${K}.failedNoReason`), tone: 'warn' };
  else if (r.state === 'unreadable') note = { text: r.reason ? tx(`${K}.unreadable`, { reason: r.reason }) : tx(`${K}.unreadableNoReason`), tone: 'warn' };
  const on = r.state === 'ready' && r.enabled === true;
  return {
    ready: r.state === 'ready',
    disabled: r.state !== 'ready',
    on,
    note,
    // While on, the row says what that means right under the switch, in the warning tone.
    warning: on ? tx(`${K}.onWarning`) : null,
    applies: tx(`${K}.applies`),
  };
}

/** The sentence under the row when a change could not be saved: { status, body, error, enabled }. */
export function describeOwnerAccessSaveFailure({ status = 0, body = null, error = null, enabled = false } = {}, { tx }) {
  const code = Number(status) || 0;
  const state = tx(`${K}.${enabled ? 'stateOn' : 'stateOff'}`);
  if (code === 404) return tx(`${K}.save.oldServer`, { state });
  if (code === 403 && body?.code === 'WORKER_BROWSER') return tx(`${K}.save.automationBrowser`, { state });
  if (!code) return tx(`${K}.save.noAnswer`, { state, reason: clean(error) || '' });
  return tx(`${K}.save.failed`, { state, reason: clean(body?.error || error) || `HTTP ${code}` });
}
