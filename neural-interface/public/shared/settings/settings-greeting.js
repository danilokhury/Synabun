// ═══════════════════════════════════════════
// SETTINGS — the greeting, in words
// ═══════════════════════════════════════════
//
// What `GET /api/greeting` and `POST /api/greeting/preview` (lib/greeting/api.js, the engine in
// lib/greeting/engine.js) say about Settings → Automations → Greeting: whether the one switch can be
// used at all, what it is set to, what stands in the way, and what a new session would be greeted
// with right now. Pure: no DOM (it imports only the greeting's own DOM-free view), so node runs it
// (tests/settings-greeting-view.test.mjs).
//
//   readGreetingStatus({ status, body, error })     what the server answered → a reading
//   describeGreeting(reading, preview, { tx, t })   the section as ui-settings.js draws it
//   describeGreetingSaveFailure(input, { tx })      the sentence for a switch that could not be saved
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the
// kit's `tx`); `t` is the app's translator, for the elapsed time the greeting card also formats.
//
// The section never shows a healthy-looking control for something that is not happening: a server
// without the engine gets a disabled switch and says why, and the preview says in so many words
// whether a session opened now would actually be greeted.

import { formatAway } from '../greeting/greeting-view.js';

const K = 'settings.redesign.hooks.greet';

const clean = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * What the server answered.
 *
 *   ready        the engine is there: `payload` is { settings, enabled, killed, writer, spend, gapMs, last }
 *   old-server   404: the running server was started before the engine existed (public/ reloads at any
 *                time, lib/ only on a restart)
 *   failed       503 GREETING_UNAVAILABLE: the engine did not start; `reason` is the error
 *   unreadable   anything else (no answer, a refusal, a body that is not the payload); `reason` says what
 *
 * @param {{ status?: number, body?: object|null, error?: string|null }} response
 * @returns {{ state: 'ready'|'old-server'|'failed'|'unreadable', payload: object|null, reason: string|null }}
 */
export function readGreetingStatus({ status = 0, body = null, error = null } = {}) {
  if (status === 200 && body?.ok === true && body.settings && typeof body.settings === 'object') return { state: 'ready', payload: body, reason: null };
  if (status === 404) return { state: 'old-server', payload: null, reason: null };
  if (status === 503 && body?.code === 'GREETING_UNAVAILABLE') return { state: 'failed', payload: null, reason: clean(body.reason) || null };
  return { state: 'unreadable', payload: null, reason: clean(body?.error || error) || (status ? `HTTP ${status}` : null) };
}

/** "$0.0006" · "<$0.0001" · '' */
function usd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '';
  if (amount < 0.0001) return '<$0.0001';
  return `$${amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

/**
 * The section as it is drawn.
 * `preview`: null (not asked yet) | { loading: true } | { failed } (the request itself failed) | the engine's
 * preview payload (whose own `error` only says why no model wrote the sentence: 'not-prepared', 'no-writer' …).
 * → { state, ready, on, disabled, note, notes[], preview: { shown, state, project, lead, greeting, empty, spend, canWrite } }
 *   preview.state: 'hidden' | 'loading' | 'greeting' | 'empty' | 'error'
 *   preview.greeting: what the shared card draws (public/shared/greeting/greeting-card.js), or null
 */
export function describeGreeting(reading, preview, { tx, t = null, now = Date.now() } = {}) {
  const state = reading?.state || 'unreadable';
  const ready = state === 'ready';
  const payload = ready ? reading.payload : null;
  const on = ready && payload.settings.enabled !== false;
  const killed = ready && payload.killed === true;
  let note = null;
  if (state === 'old-server') note = { tone: 'info', text: tx(`${K}.state.oldServer`) };
  else if (state === 'failed') note = { tone: 'warn', text: reading.reason ? tx(`${K}.state.failed`, { reason: reading.reason }) : tx(`${K}.state.failedUnknown`) };
  else if (state === 'unreadable') note = { tone: 'warn', text: reading?.reason ? tx(`${K}.state.unreadable`, { reason: reading.reason }) : tx(`${K}.state.unreadableUnknown`) };
  else if (killed) note = { tone: 'warn', text: tx(`${K}.state.killed`) };

  const notes = [];
  if (ready && on && !killed && payload.writer === false) notes.push({ tone: 'info', text: tx(`${K}.note.noWriter`) });

  const view = { shown: ready, state: 'hidden', project: '', lead: '', greeting: null, empty: '', spend: '', canWrite: false };
  if (ready) {
    if (!preview || preview.loading) { view.state = 'loading'; view.lead = tx(`${K}.preview.loading`); }
    else if (preview.failed || preview.reason === 'error' || preview.reason === 'unavailable') {
      view.state = 'error';
      view.project = clean(preview.label || preview.project || '', 60);
      view.empty = tx(`${K}.preview.error`, { reason: clean(preview.failed || preview.reason || '', 120) || '?' });
    } else {
      const project = clean(preview.label || preview.project || '', 60);
      view.project = project;
      const text = typeof preview.text === 'string' ? preview.text.trim() : '';
      const since = Date.parse(preview.lastHereAt ?? '');
      const away = Number.isFinite(since) ? formatAway(Math.max(0, now - since), t) : '';
      if (!text) {
        view.state = 'empty';
        view.empty = tx(preview.reason === 'first-session' || !Number.isFinite(since) ? `${K}.preview.firstSession` : `${K}.preview.nothingToSay`, { project });
      } else {
        view.state = 'greeting';
        const reason = !on || killed ? 'off' : preview.reason;
        if (reason === 'off') view.lead = tx(`${K}.preview.off`, { project });
        else if (reason === 'recent') view.lead = tx(`${K}.preview.recent`, { project, time: away || tx(`${K}.preview.moment`), gap: formatAway(Number(preview.gapMs) || 3_600_000, t) });
        else if (reason === 'nothing-new') view.lead = tx(`${K}.preview.nothingNew`, { project });
        else view.lead = tx(`${K}.preview.now`, { project });
        view.greeting = {
          id: null, text, source: preview.source === 'writer' ? 'writer' : 'fallback', error: preview.error || null, model: preview.model || null,
          tokens: preview.tokens || null, costUsd: preview.costUsd ?? null, preparedAt: preview.preparedAt || null,
          basis: Array.isArray(preview.basis) ? preview.basis : [], awaySince: null,
        };
      }
      const spend = preview.spend || payload.spend || null;
      if (spend) {
        const calls = Math.max(0, Math.round(Number(spend.calls) || 0));
        view.spend = calls > 0
          ? tx(`${K}.preview.spend`, { calls, cap: Math.round(Number(spend.cap) || 0), cost: usd(spend.costUsd) || '$0' })
          : tx(`${K}.preview.spendNone`);
      }
      view.canWrite = payload.writer !== false && view.state !== 'empty';
    }
  }
  return { state, ready, on, disabled: !ready || killed, note, notes, preview: view };
}

/**
 * Why a switch could not be saved, as one sentence. `status` / `body`: what the server answered;
 * `error`: the fetch failure when there was no answer.
 */
export function describeGreetingSaveFailure({ status = 0, body = null, error = null } = {}, { tx }) {
  if (status === 404) return tx(`${K}.save.oldServer`);
  if (status === 503) return tx(`${K}.save.failed`, { reason: clean(body?.reason || body?.error) || 'HTTP 503' });
  if (status === 403) return tx(`${K}.save.forbidden`);
  const reason = clean(body?.error || error) || (status ? `HTTP ${status}` : '');
  return reason ? tx(`${K}.save.failed`, { reason }) : tx(`${K}.save.noAnswer`);
}
