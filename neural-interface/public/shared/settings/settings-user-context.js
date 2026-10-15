// ═══════════════════════════════════════════
// SETTINGS — the Assistant's user context, in words
// ═══════════════════════════════════════════
//
// What `GET /api/assistant/user-context` (lib/assistant-api.js, the engine in lib/assistant-user-context.js)
// says about Settings → Automations → Automation behavior: whether the three switches can be used at all,
// what each one is set to, what stands in the way of a layer, and whether the digest is in use. Pure: no DOM
// and no import, so node runs it (tests/settings-user-context-view.test.mjs).
//
//   readUserContextResponse({ status, body, error })   what the server answered → a reading
//   describeUserContext(reading, { tx })                the section as ui-settings.js draws it
//   describeUserContextSaveFailure(input, { tx })       the sentence for a switch that could not be saved
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the kit's `tx`).
//
// The section never shows a healthy-looking control for something that is not happening: a server without
// the engine gets disabled rows and says why, a switched-off layer says what stops, and the digest is shown
// as told to a new conversation only while "Knowledge of you" is on (the engine's preview is built either way).

const K = 'settings.redesign.hooks.uc';

/** The three layers, in the order the section lists them. */
export const USER_CONTEXT_LAYERS = Object.freeze(['knowledge', 'nudges', 'trace']);

const clean = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * What the server answered.
 *
 *   ready        the engine is there: `payload` is { settings, capabilities, preview }
 *   old-server   404: the running server was started before the engine existed (public/ reloads at any
 *                time, lib/ only on a restart)
 *   failed       503 USER_CONTEXT_UNAVAILABLE: the engine did not start at boot; `reason` is the error
 *   unreadable   anything else (no answer, a refusal, a body that is not the payload); `reason` says what
 *
 * @param {{ status?: number, body?: object|null, error?: string|null }} response
 * @returns {{ state: 'ready'|'old-server'|'failed'|'unreadable', payload: object|null, reason: string|null }}
 */
export function readUserContextResponse({ status = 0, body = null, error = null } = {}) {
  if (status === 200 && body?.ok === true && body.settings && typeof body.settings === 'object') return { state: 'ready', payload: body, reason: null };
  if (status === 404) return { state: 'old-server', payload: null, reason: null };
  if (status === 503 && body?.code === 'USER_CONTEXT_UNAVAILABLE') return { state: 'failed', payload: null, reason: clean(body.reason) || null };
  return { state: 'unreadable', payload: null, reason: clean(body?.error || error) || (status ? `HTTP ${status}` : null) };
}

/** The settings as booleans, the way the engine reads them: anything that is not exactly `false` is on. */
const layersOf = (settings) => Object.fromEntries(USER_CONTEXT_LAYERS.map((key) => [key, settings?.[key] !== false]));

// Why learning cannot run → the sentence, and whether Settings → AI decisions is where to fix it.
const LEARNING_REASONS = {
  'kill-switch': { key: 'learn.killSwitch', link: false },
  'master-off': { key: 'learn.masterOff', link: 'jv-sec-master' },
  'no-key': { key: 'learn.noKey', link: 'jv-sec-connection' },
  'surface-off': { key: 'learn.surfaceOff', link: 'jv-sec-surfaces' },
  waiting: { key: 'learn.waiting', link: false },
};

/**
 * The section as it is drawn.
 *
 * `note`: one line above the switches when they cannot be used (and why), else null.
 * `layers[key]`: `on` (the stored value; false while it cannot be read), `disabled`, and `notes`: what stands
 * in the way of that layer right now, each `{ text, tone: 'warn'|'info', link }` where `link` is
 * `{ label, target }` (a Settings deep link) or null.
 * `applies`: the line that says when a change takes effect, or ''.
 * `digest`: `shown` (false without the engine), `state` 'in-use' | 'empty' | 'off', the `count` text, the `rows`
 * to list (none while off), the `message` shown in place of rows (or ''), and the `omitted` line (or '').
 *
 * @param {{ state: string, payload: object|null, reason: string|null }} reading
 * @param {{ tx: (key: string, params?: object) => string }} deps
 */
export function describeUserContext(reading, { tx }) {
  const state = reading?.state || 'unreadable';
  const ready = state === 'ready';
  const page = tx('settings.redesign.page.ai_decisions.title');
  const view = {
    state, ready, note: null, applies: ready ? tx(`${K}.applies`) : '',
    layers: Object.fromEntries(USER_CONTEXT_LAYERS.map((key) => [key, { on: false, disabled: !ready, notes: [] }])),
    digest: { shown: false, state: 'off', count: '', rows: [], message: '', omitted: '' },
  };

  if (!ready) {
    const reason = clean(reading?.reason);
    if (state === 'old-server') view.note = { text: tx(`${K}.restart`), tone: 'warn' };
    else if (state === 'failed') view.note = { text: reason ? tx(`${K}.failed`, { reason }) : tx(`${K}.failedNoReason`), tone: 'warn' };
    else view.note = { text: reason ? tx(`${K}.unreadable`, { reason }) : tx(`${K}.unreadableNoReason`), tone: 'warn' };
    return view;
  }

  const { settings, capabilities, preview } = reading.payload;
  const on = layersOf(settings);
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  for (const key of USER_CONTEXT_LAYERS) view.layers[key].on = on[key];

  // Without the memory store nothing is read, learned or recorded: both layers that live in it say so.
  const noStore = caps.store === false;
  if (noStore) {
    if (on.knowledge) view.layers.knowledge.notes.push({ text: tx(`${K}.noStore`), tone: 'warn', link: null });
    if (on.nudges) view.layers.nudges.notes.push({ text: tx(`${K}.noStore`), tone: 'warn', link: null });
  }
  // Learning needs Jev on the `user-learning` surface; the digest does not.
  if (on.knowledge && !noStore && caps.jev === false) {
    const known = LEARNING_REASONS[caps.jevReason] || { key: 'learn.unavailable', link: false };
    view.layers.knowledge.notes.push({
      text: tx(`${K}.${known.key}`, { page }), tone: 'warn',
      link: known.link ? { label: tx(`${K}.openPage`, { page }), target: { tab: 'ai-decisions', scrollTo: known.link } } : null,
    });
  }
  // The statement writer: without it (or when its last one-shot failed) a statement stays in the user's own words.
  if (on.knowledge && !noStore && caps.jev !== false) {
    if (caps.writer === false) view.layers.knowledge.notes.push({ text: tx(`${K}.writer.missing`), tone: 'info', link: null });
    else if (caps.writerLast && caps.writerLast.ok === false) {
      const reason = clean(caps.writerLast.reason, 120);
      view.layers.knowledge.notes.push({ text: reason ? tx(`${K}.writer.failed`, { reason }) : tx(`${K}.writer.failedNoReason`), tone: 'info', link: null });
    }
  }
  // The trace is a line about the two layers: with both off the engine emits nothing.
  if (on.trace && !on.knowledge && !on.nudges) view.layers.trace.notes.push({ text: tx(`${K}.trace.nothing`), tone: 'info', link: null });

  // The digest: what a new conversation is told, which is nothing while the layer is off.
  const rows = Array.isArray(preview?.rows) ? preview.rows.filter((row) => row && row.id && row.statement) : [];
  const omitted = Number(preview?.omitted) > 0 ? Math.round(Number(preview.omitted)) : 0;
  view.digest.shown = true;
  if (!on.knowledge) {
    view.digest.state = 'off';
    view.digest.count = tx('settings.redesign.common.off');
    view.digest.message = tx(`${K}.off.note`);
  } else {
    view.digest.state = rows.length ? 'in-use' : 'empty';
    view.digest.count = tx(`${K}.tokens`, { tokens: Math.max(0, Math.round(Number(preview?.tokens) || 0)), max: Math.round(Number(preview?.maxTokens) || 300) });
    view.digest.rows = rows.map((row) => ({ id: String(row.id), statement: String(row.statement), facet: String(row.facet || ''), seed: row.seed === true }));
    view.digest.message = rows.length ? '' : tx(`${K}.empty`);
    view.digest.omitted = omitted > 0 ? tx(`${K}.omitted`, { n: omitted }) : '';
  }
  return view;
}

/**
 * A switch that could not be saved: it goes back to where it was, and this is the sentence that says so.
 *
 * @param {{ name: string, wanted: boolean, status?: number, body?: object|null, error?: string|null }} input
 *        `name` is the switch's label, `wanted` what the click asked for
 * @returns {string}
 */
export function describeUserContextSaveFailure({ name, wanted, status = 0, body = null, error = null } = {}, { tx }) {
  let reason = clean(body?.error || body?.message, 160);
  if (!reason && status === 404) reason = tx(`${K}.save.oldServer`);
  if (!reason && status) reason = `HTTP ${status}`;
  if (!reason) reason = clean(error, 160) || tx(`${K}.save.noAnswer`);
  return tx(`${K}.save.${wanted ? 'on' : 'off'}`, { name, reason });
}
