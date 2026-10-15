// ═══════════════════════════════════════════
// SETTINGS — the code editor's page, in words
// ═══════════════════════════════════════════
//
// What `GET /api/editor/config`, `GET /api/editor/capabilities` and the routes under `/api/editor/complete`
// (lib/editor-config.js, lib/editor-completion.js) say about Settings → Code editor: for "Editing", which
// preferences there are and what each is set to; for "AI autocomplete", whether the section can be used at all,
// what is stored, which models there are, and what a test found. Pure: no DOM and no import, so node runs it
// (tests/settings-code-editor-view.test.mjs).
//
//   EDITING_FIELDS                                                the editing preferences, each with its control
//   readEditorEditingResponse({ status, body, error })            what the server answered → a reading
//   describeEditorEditing(reading, { tx })                        the "Editing" section as the pane draws it
//   editingOptionLabel(key, value, { tx }) / editingChange(key, raw)
//   readEditorAiResponse({ status, body, error, capabilities })   what the server answered → a reading
//   describeEditorAi(reading, { tx })                             the section as settings-code-editor-pane.js draws it
//   describeEditorModels(answer, selected, { tx })                the model list
//   describeEditorTest(result, { tx }) / describeEditorFastest(body, { tx })
//   describeEditorUsage(today, { tx })
//   describeEditorSaveFailure(input, { tx })                      the sentence for a change that could not be saved
//   parseExcludeList(text) / excludeListText(list) / isEndpointUrl(text)
//
// `tx(key, params)` is the caller's translate function over the settings.redesign.* strings (the kit's `tx`).
//
// The section never shows a healthy-looking control for something that is not happening: a server without the
// feature gets disabled controls and says why, and the key is only ever "set" or "not set".

const K = 'settings.redesign.code_editor';

const clean = (value, max = 200) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// ── Editing ──

/**
 * The `editing` preferences (public/shared/editor/editor-prefs.js keeps their defaults and their limits), in the
 * order the section shows them: the text, what is drawn around it, indentation, and what a save does.
 * `id`: the control's inventory id; `kind`: a switch, or one choice among `values`.
 */
export const EDITING_FIELDS = Object.freeze([
  { key: 'fontSize', id: 'EDT014', kind: 'choice', values: Object.freeze([10, 11, 12, 13, 14, 15, 16, 17, 18]) },
  { key: 'ligatures', id: 'EDT015', kind: 'toggle' },
  { key: 'wordWrap', id: 'EDT016', kind: 'toggle' },
  { key: 'minimap', id: 'EDT017', kind: 'toggle' },
  { key: 'indentGuides', id: 'EDT018', kind: 'toggle' },
  { key: 'renderWhitespace', id: 'EDT019', kind: 'choice', values: Object.freeze(['none', 'selection', 'all']) },
  { key: 'indentWith', id: 'EDT020', kind: 'choice', values: Object.freeze(['auto', 'spaces', 'tabs']) },
  { key: 'tabSize', id: 'EDT021', kind: 'choice', values: Object.freeze(['auto', 2, 4, 8]) },
  { key: 'trimTrailingWhitespace', id: 'EDT022', kind: 'toggle' },
  { key: 'insertFinalNewline', id: 'EDT023', kind: 'toggle' },
]);

/**
 * What GET /api/editor/config answered about the editing preferences.
 *
 *   ready        the preferences are there
 *   old-server   404: the running server was started before the editor kept its preferences
 *   unreadable   anything else; `reason` says what
 *
 * @param {{ status?: number, body?: object|null, error?: string|null }} response
 * @returns {{ state: 'ready'|'old-server'|'unreadable', editing: object|null, reason: string|null }}
 */
export function readEditorEditingResponse({ status = 0, body = null, error = null } = {}) {
  if (status === 404) return { state: 'old-server', editing: null, reason: null };
  if (status === 200 && body?.ok === true && body.config?.editing && typeof body.config.editing === 'object' && !Array.isArray(body.config.editing)) {
    return { state: 'ready', editing: body.config.editing, reason: null };
  }
  return { state: 'unreadable', editing: null, reason: clean(body?.error || error) || (status ? `HTTP ${status}` : null) };
}

/** What a choice is called in its list: "12 px", "Detect", "Spaces", "In the selection"… */
export function editingOptionLabel(key, value, { tx }) {
  if (key === 'fontSize') return tx(`${K}.editing.fontSize`, { size: value });
  if (key === 'renderWhitespace') return tx(`${K}.editing.whitespace.${value}`);
  if (value === 'auto') return tx(`${K}.editing.detect`);
  if (key === 'indentWith') return tx(`${K}.editing.${value}`);
  return String(value);
}

/**
 * The "Editing" section as it is drawn.
 * → { state, ready, note, values: { [key]: value } }
 *   `reading`: what readEditorEditingResponse() returned, or null while the server has not answered yet.
 *   `values`: for each field what its control shows: a boolean for a switch, one of the field's values (as text)
 *   for a choice. Before the preferences are known, a switch is off and a choice shows its first value.
 *   `note`: one line above the controls when they cannot be used (and why), else null.
 */
export function describeEditorEditing(reading, { tx }) {
  const state = reading ? reading.state || 'unreadable' : 'loading';
  const ready = state === 'ready';
  const stored = ready && reading.editing ? reading.editing : {};
  const values = {};
  for (const field of EDITING_FIELDS) {
    if (field.kind === 'toggle') values[field.key] = stored[field.key] === true;
    else {
      const found = field.values.find((value) => String(value) === String(stored[field.key]));
      values[field.key] = String(found !== undefined ? found : field.values[0]);
    }
  }
  let note = null;
  // Until the preferences arrive the controls show first choices and switches that are off: say that they are
  // being read, so those are not taken for what is stored.
  if (state === 'loading') note = { text: tx('settings.redesign.common.checking'), tone: 'neutral' };
  else if (state === 'old-server') note = { text: tx(`${K}.editing.oldServer`), tone: 'warn' };
  else if (state === 'unreadable') {
    const reason = clean(reading?.reason);
    note = { text: reason ? tx(`${K}.state.unreadable`, { reason }) : tx(`${K}.state.unreadableNoReason`), tone: 'warn' };
  }
  return { state, ready, note, values };
}

/**
 * What a control's new value changes in the stored preferences.
 * @param {string} key a field's key
 * @param {boolean | string} raw a switch's `checked`, or a list's `value`
 * @returns {{ editing: object } | null} what is sent to PUT /api/editor/config; null for a value the field does not have
 */
export function editingChange(key, raw) {
  const field = EDITING_FIELDS.find((entry) => entry.key === key);
  if (!field) return null;
  if (field.kind === 'toggle') return typeof raw === 'boolean' ? { editing: { [key]: raw } } : null;
  const value = field.values.find((entry) => String(entry) === String(raw));
  return value === undefined ? null : { editing: { [key]: value } };
}

// ── AI autocomplete ──

/**
 * What the server answered.
 *
 *   ready        the preferences are there and the server has the `complete` capability
 *   old-server   404, or preferences without the capability: the running server was started before AI
 *                autocomplete existed (public/ reloads at any time, lib/ only on a restart)
 *   unreadable   anything else (no answer, a refusal, a body that is not the preferences); `reason` says what
 *
 * @param {{ status?: number, body?: object|null, error?: string|null, capabilities?: string[]|null }} response
 *   `status` and `body` of GET /api/editor/config; `capabilities` of GET /api/editor/capabilities (null: not answered)
 * @returns {{ state: 'ready'|'old-server'|'unreadable', config: object|null, hasEndpointKey: boolean, reason: string|null }}
 */
export function readEditorAiResponse({ status = 0, body = null, error = null, capabilities = null } = {}) {
  const out = (state, reason = null) => ({ state, config: null, hasEndpointKey: false, reason });
  if (status === 404) return out('old-server');
  if (status === 200 && body?.ok === true && body.config?.ai && typeof body.config.ai === 'object') {
    if (!Array.isArray(capabilities) || !capabilities.includes('complete')) return out('old-server');
    return { state: 'ready', config: body.config, hasEndpointKey: body.hasEndpointKey === true, reason: null };
  }
  return out('unreadable', clean(body?.error || error) || (status ? `HTTP ${status}` : null));
}

/**
 * The section as it is drawn.
 * → { state, ready, note, pill: { text, state }, enabled, engine, model, endpoint: { kind, url, model, shape },
 *     hasKey, keyState, keyPlaceholder, urlPlaceholder, exclude (text), excludeCount }
 *   `reading`: what readEditorAiResponse() returned, or null while the server has not answered yet (the controls
 *   are then switched off without a word about why: nothing is known to be wrong).
 *   `note`: one line above the controls when they cannot be used (and why), else null.
 *   `pill.state`: 'ok' on and able to ask · 'warn' on but with nothing to ask yet · 'off'. An empty `pill.text`
 *   is not shown.
 */
export function describeEditorAi(reading, { tx }) {
  const state = reading ? reading.state || 'unreadable' : 'loading';
  const ready = state === 'ready';
  const view = {
    state, ready, note: null, pill: { text: state === 'loading' ? '' : tx(`${K}.pill.unavailable`), state: 'off' },
    enabled: false, engine: 'opencode', model: null, endpoint: { kind: 'ollama', url: '', model: '', shape: 'fim' },
    hasKey: false, keyState: '', keyPlaceholder: tx(`${K}.key.placeholder`), urlPlaceholder: tx(`${K}.url.placeholderOllama`),
    exclude: '', excludeCount: '',
  };
  if (state === 'loading') {
    view.note = { text: tx('settings.redesign.common.checking'), tone: 'neutral' };
    return view;
  }
  if (!ready) {
    const reason = clean(reading?.reason);
    if (state === 'old-server') view.note = { text: tx(`${K}.state.oldServer`), tone: 'warn' };
    else view.note = { text: reason ? tx(`${K}.state.unreadable`, { reason }) : tx(`${K}.state.unreadableNoReason`), tone: 'warn' };
    return view;
  }
  const ai = reading.config.ai;
  const endpoint = ai.endpoint && typeof ai.endpoint === 'object' ? ai.endpoint : {};
  view.enabled = ai.enabled === true;
  view.engine = ai.engine === 'endpoint' ? 'endpoint' : 'opencode';
  view.model = typeof ai.model === 'string' && ai.model ? ai.model : null;
  view.endpoint = {
    kind: endpoint.kind === 'openai' ? 'openai' : 'ollama', url: String(endpoint.url || ''), model: String(endpoint.model || ''),
    shape: endpoint.shape === 'chat' ? 'chat' : 'fim',
  };
  view.hasKey = reading.hasEndpointKey === true;
  view.keyState = tx(view.hasKey ? `${K}.key.set` : `${K}.key.notSet`);
  view.keyPlaceholder = tx(view.hasKey ? `${K}.key.placeholderReplace` : `${K}.key.placeholder`);
  view.urlPlaceholder = tx(view.endpoint.kind === 'openai' ? `${K}.url.placeholderOpenai` : `${K}.url.placeholderOllama`);
  const list = Array.isArray(ai.exclude) ? ai.exclude.filter((glob) => typeof glob === 'string') : [];
  view.exclude = excludeListText(list);
  view.excludeCount = list.length ? tx(`${K}.exclude.count`, { n: list.length }) : tx(`${K}.exclude.empty`);
  const able = view.engine === 'endpoint' ? !!(view.endpoint.url && view.endpoint.model) : !!view.model;
  if (!view.enabled) view.pill = { text: tx(`${K}.pill.off`), state: 'off' };
  else if (!able) view.pill = { text: tx(`${K}.pill.setup`), state: 'warn' };
  else view.pill = { text: tx(`${K}.pill.on`), state: 'ok' };
  return view;
}

/** A price per million tokens the way a model row writes it: 0.15, 0.60, 2.00, 0.003. */
export function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  return n > 0 && n < 0.01 ? n.toFixed(3) : n.toFixed(2);
}

/** A duration: 640 ms, 1.2 s. */
export function formatDuration(value) {
  const ms = Math.max(0, Math.round(Number(value) || 0));
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A count: 950, 1.2k, 3.4M. */
export function formatAmount(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * The model list.
 * @param {{ status?: number, body?: object|null } | null} answer what GET /api/editor/complete/models answered;
 *   null while it is being asked
 * @param {string|null} selected `ai.model`
 * @param {{ tx: Function, providersPage?: string }} deps `providersPage`: the name of the Settings page where a
 *   provider is signed in to
 * @returns {{ state: 'loading'|'list'|'empty'|'unavailable', message: string, canStart: boolean,
 *   rows: { id: string, label: string, provider: string, meta: string, fast: boolean, selected: boolean, listed: boolean }[] }}
 *   `canStart`: the list could not be read because OpenCode is not running, and starting it would give one.
 */
export function describeEditorModels(answer, selected, { tx, providersPage = '' }) {
  const view = { state: 'loading', message: tx(`${K}.models.loading`), canStart: false, rows: [] };
  const missing = () => (selected ? [{ id: selected, label: selected, provider: selected.split('/')[0], meta: tx(`${K}.models.notListed`), fast: false, selected: true, listed: false }] : []);
  if (!answer) return view;
  const body = answer.body;
  if (answer.status !== 200 || body?.ok !== true || !Array.isArray(body.models)) {
    return { state: 'unavailable', message: clean(body?.message || body?.error) || tx(`${K}.models.unavailable`), canStart: false, rows: missing() };
  }
  if (body.available === false) {
    return { state: 'unavailable', message: clean(body.message) || tx(`${K}.models.unavailable`), canStart: true, rows: missing() };
  }
  const rows = body.models.filter((model) => model && typeof model.id === 'string').map((model) => {
    const parts = [];
    if (model.fast) parts.push(tx(`${K}.models.fast`));
    if (model.free) parts.push(tx(`${K}.models.free`));
    else if (model.price) parts.push(tx(`${K}.models.price`, { input: formatPrice(model.price.input), output: formatPrice(model.price.output) }));
    else parts.push(tx(`${K}.models.noPrice`));
    return { id: model.id, label: String(model.label || model.id), provider: String(model.provider || model.id.split('/')[0]), meta: parts.join(' · '), fast: model.fast === true, selected: model.id === selected, listed: true };
  });
  if (selected && !rows.some((row) => row.selected)) rows.unshift(...missing());
  if (!rows.length) return { state: 'empty', message: tx(`${K}.models.none`, { page: providersPage }), canStart: false, rows };
  return { state: 'list', message: '', canStart: false, rows };
}

/**
 * One test's result as a sentence.
 * @param {{ ok?: boolean, ms?: number, tokens?: { input: number, output: number }|null, sample?: string, error?: string }|null} result
 *   a row of POST /api/editor/complete/test; null when the request itself got no answer
 * @returns {{ tone: 'ok'|'warn'|'err', text: string }}
 */
export function describeEditorTest(result, { tx }) {
  if (!result) return { tone: 'err', text: tx(`${K}.test.failed`, { reason: tx(`${K}.test.noAnswer`) }) };
  if (!result.ok) return { tone: 'err', text: tx(`${K}.test.failed`, { reason: clean(result.error, 160) || '?' }) };
  const time = formatDuration(result.ms);
  const sample = clean(result.sample, 80);
  if (!sample) return { tone: 'warn', text: tx(`${K}.test.empty`, { time }) };
  if (result.tokens) return { tone: 'ok', text: tx(`${K}.test.ok`, { time, input: formatAmount(result.tokens.input), output: formatAmount(result.tokens.output), sample }) };
  return { tone: 'ok', text: tx(`${K}.test.okNoTokens`, { time, sample }) };
}

/**
 * What "Find fastest" found.
 * @param {object|null} body the answer of POST /api/editor/complete/test { fastest: true }; null: no answer
 * @returns {{ tone: 'ok'|'warn'|'err', text: string, model: string|null }} `model`: the one to select, or null
 */
export function describeEditorFastest(body, { tx }) {
  if (!body || body.ok !== true || !Array.isArray(body.results)) {
    return { tone: 'err', text: tx(`${K}.test.failed`, { reason: clean(body?.error || body?.message, 160) || tx(`${K}.test.noAnswer`) }), model: null };
  }
  const best = body.fastest ? body.results.find((row) => row.model === body.fastest && row.ok) : null;
  if (best) return { tone: 'ok', text: tx(`${K}.fastest.found`, { model: best.model, time: formatDuration(best.ms) }), model: best.model };
  if (!body.results.length) return { tone: 'warn', text: clean(body.message, 160) || tx(`${K}.fastest.noCandidates`), model: null };
  return { tone: 'warn', text: tx(`${K}.fastest.none`), model: null };
}

/** Today's use as one line. `today`: the `today` of GET /api/editor/complete/usage, or null. */
export function describeEditorUsage(today, { tx }) {
  const n = (value) => Math.max(0, Math.round(Number(value) || 0));
  if (!today || n(today.requests) === 0) return tx(`${K}.usage.none`);
  return tx(`${K}.usage.today`, { requests: formatAmount(today.requests), input: formatAmount(today.tokensIn), output: formatAmount(today.tokensOut), accepted: n(today.accepted), shown: n(today.shown) });
}

/**
 * The patterns a text holds: one per line (or between commas), no empty ones, none twice, no folders.
 * The server normalises the same way (editor-prefs.js); this is what the page sends.
 */
export function parseExcludeList(text) {
  const out = [];
  for (const piece of String(text ?? '').split(/[\n,]/)) {
    const glob = piece.trim().slice(0, 200);
    if (glob && !glob.includes('/') && !glob.includes('\\') && !out.includes(glob)) out.push(glob);
    if (out.length >= 200) break;
  }
  return out;
}

/** A list of patterns as the text field shows it. */
export const excludeListText = (list) => (Array.isArray(list) ? list.join('\n') : '');

/** Whether a text is an address a request can be sent to. Empty is not an address, and not an error either. */
export const isEndpointUrl = (text) => /^https?:\/\/\S+$/i.test(String(text ?? '').trim());

/**
 * A change that could not be saved: the control goes back to where it was, and this is the sentence that says so.
 * @param {{ status?: number, body?: object|null, error?: string|null }} input
 */
export function describeEditorSaveFailure({ status = 0, body = null, error = null } = {}, { tx }) {
  let reason = clean(body?.error || body?.message, 160);
  if (!reason && status === 404) reason = tx(`${K}.save.oldServer`);
  if (!reason && status) reason = `HTTP ${status}`;
  if (!reason) reason = clean(error, 160) || tx(`${K}.save.noAnswer`);
  return tx(`${K}.save.failed`, { reason });
}
