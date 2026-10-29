// ═══════════════════════════════════════════
// SETTINGS — Protect workers, in words
// ═══════════════════════════════════════════
//
// What `GET /api/assistant/worker-guard` (lib/assistant-api.js; the setting in lib/worker-guard-setting.js, what
// it means in lib/worker-confinement.js) says about Settings → Automations → Automation behavior → Protect
// workers: the mode in effect (enforce, warn, off), whether it can be changed, and what stands in the way. Pure:
// no DOM and no import, so node runs it (tests/settings-worker-guard-view.test.mjs).
//
//   readWorkerGuardResponse({ status, body, error })   what the server answered → a reading
//   describeWorkerGuard(reading, { tx })                the row as ui-settings.js draws it
//   describeWorkerGuardSaveFailure(input, { tx })       the sentence for a choice that could not be saved
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the kit's `tx`).
// The row never shows a healthy-looking control for something that is not happening: a server started before
// the setting existed shows the default, disabled, and says a restart is missing.

const K = 'settings.redesign.hooks.workerGuard';

export const WORKER_GUARD_MODES = Object.freeze(['enforce', 'warn', 'off']);
export const WORKER_GUARD_DEFAULT = 'enforce';

const clean = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * What the server answered.
 *
 *   ready        the setting is there: `mode` is in effect, `modes` the choices
 *   old-server   404: the running server was started before the setting existed
 *   failed       503 WORKER_GUARD_UNAVAILABLE: the setting did not start; `reason` is the error
 *   unreadable   anything else (no answer, a refusal, a body that is not the payload)
 */
export function readWorkerGuardResponse({ status = 0, body = null, error = null } = {}) {
  const code = Number(status) || 0;
  if (code === 404) return { state: 'old-server', mode: WORKER_GUARD_DEFAULT, modes: [...WORKER_GUARD_MODES], reason: null };
  if (code === 503) return { state: 'failed', mode: WORKER_GUARD_DEFAULT, modes: [...WORKER_GUARD_MODES], reason: clean(body?.reason || body?.error) || null };
  if (code >= 200 && code < 300 && body && typeof body === 'object' && body.ok !== false && WORKER_GUARD_MODES.includes(body.mode)) {
    const modes = Array.isArray(body.modes) && body.modes.every((m) => WORKER_GUARD_MODES.includes(m)) && body.modes.length ? body.modes : [...WORKER_GUARD_MODES];
    return { state: 'ready', mode: body.mode, modes, reason: null };
  }
  return { state: 'unreadable', mode: WORKER_GUARD_DEFAULT, modes: [...WORKER_GUARD_MODES], reason: clean(error || body?.error || (code ? `HTTP ${code}` : '')) || null };
}

/** The row: { ready, disabled, mode, options: [{ value, label, help }], note: { text, tone } | null, applies }. */
export function describeWorkerGuard(reading, { tx }) {
  const r = reading || readWorkerGuardResponse({ status: 0 });
  const options = (r.modes || WORKER_GUARD_MODES).map((value) => ({ value, label: tx(`${K}.mode.${value}`), help: tx(`${K}.modeHelp.${value}`) }));
  let note = null;
  if (r.state === 'old-server') note = { text: tx(`${K}.restart`), tone: 'warn' };
  else if (r.state === 'failed') note = { text: r.reason ? tx(`${K}.failed`, { reason: r.reason }) : tx(`${K}.failedNoReason`), tone: 'warn' };
  else if (r.state === 'unreadable') note = { text: r.reason ? tx(`${K}.unreadable`, { reason: r.reason }) : tx(`${K}.unreadableNoReason`), tone: 'warn' };
  return {
    ready: r.state === 'ready',
    disabled: r.state !== 'ready',
    mode: r.mode || WORKER_GUARD_DEFAULT,
    options,
    note,
    applies: tx(`${K}.applies`),
  };
}

/** The sentence under the row when a choice could not be saved: { status, body, error, mode }. */
export function describeWorkerGuardSaveFailure({ status = 0, body = null, error = null, mode = '' } = {}, { tx }) {
  const code = Number(status) || 0;
  const name = tx(`${K}.mode.${WORKER_GUARD_MODES.includes(mode) ? mode : WORKER_GUARD_DEFAULT}`);
  if (code === 404) return tx(`${K}.save.oldServer`, { mode: name });
  if (!code) return tx(`${K}.save.noAnswer`, { mode: name, reason: clean(error) || '' });
  return tx(`${K}.save.failed`, { mode: name, reason: clean(body?.error || error) || `HTTP ${code}` });
}
