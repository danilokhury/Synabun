// ═══════════════════════════════════════════
// SETTINGS — Code editor (the pane)
// ═══════════════════════════════════════════
//
// Two sections. "Editing": one control for each `editing` preference (text size, wrapping, the minimap,
// indentation, what a save does); the editor's own View menu changes the same preferences, and each follows the
// other. "AI autocomplete": the switch, where suggestions come from, the model list with its Test buttons and
// "Find fastest", the endpoint (kind, address, model, request shape, key set or not), the files that are never
// sent, and today's use. settings-code-editor.js reads the server's answers and decides what is true; this asks
// and draws. Every change is saved as it is made (PUT /api/editor/config with only what changed) and the
// section then shows what the server stored: a change that could not be saved goes back to where it was.
//
// The endpoint's key is write-only here: the field is always empty, and the page only ever learns whether a key
// is set.

import { on } from '../state.js';
import * as kit from './settings-kit.js';
import { getSettingsPage, pageKeys } from './settings-ia.js';
import { AI_EXCLUDE_DEFAULTS } from '../editor/editor-prefs.js';
import {
  EDITING_FIELDS, describeEditorAi, describeEditorEditing, describeEditorFastest, describeEditorModels, describeEditorSaveFailure, describeEditorTest,
  describeEditorUsage, editingChange, editingOptionLabel, isEndpointUrl, parseExcludeList, readEditorAiResponse, readEditorEditingResponse,
} from './settings-code-editor.js';

const K = 'settings.redesign.code_editor';
const CONFIG_URL = '/api/editor/config';
const COMPLETE_URL = '/api/editor/complete';
const c = (key, params) => kit.te(`${K}.${key}`, params);
/** The id of the control of an editing preference. */
const editingId = (key) => `edt-ed-${key}`;

// One row for each editing preference: a switch, or a list of its choices. Switched off until the server answered.
function editingRow(field) {
  const id = editingId(field.key);
  if (field.kind === 'toggle') return kit.toggleField(field.id, kit.switchInput(id, { attrs: 'disabled' }), { forId: id });
  const options = field.values.map((value) => `<option value="${value}">${kit.esc(editingOptionLabel(field.key, value, { tx: kit.tx }))}</option>`).join('');
  return kit.field(field.id, `
            <select class="stg-input" id="${id}" aria-describedby="${id}-help" disabled>${options}</select>`, { forId: id });
}

export function buildCodeEditorTab() {
  const view = describeEditorAi(null, { tx: kit.tx });
  const option = (value, key) => `<option value="${value}">${c(key)}</option>`;
  return `
      <div class="stg-pane" data-stg-pane="editor">
        ${kit.card({
          id: 'stg-sec-editor-editing', section: 'code_editor.editing',
          body: `
          <div class="stg-help edt-note" id="edt-ed-note" role="status" data-stg-data hidden></div>
          ${EDITING_FIELDS.map(editingRow).join('')}
          <div class="stg-help edt-save-status" id="edt-ed-save-status" role="alert" data-stg-data hidden></div>`,
        })}
        ${kit.card({
          id: 'stg-sec-editor-ai', section: 'code_editor.ai_autocomplete',
          // empty until the server has answered: the stylesheet hides an empty status word
          status: kit.pill(kit.esc(view.pill.text), { state: view.pill.state, id: 'edt-ai-pill' }),
          body: `
          <div class="stg-help edt-note" id="edt-ai-note" role="status" data-stg-data hidden></div>
          ${kit.toggleField('EDT001', kit.switchInput('edt-ai-enabled', { attrs: 'disabled' }), { forId: 'edt-ai-enabled' })}
          ${kit.field('EDT002', `
            <select class="stg-input" id="edt-ai-engine" aria-describedby="edt-ai-engine-help" disabled>
              ${option('opencode', 'engine.opencode')}${option('endpoint', 'engine.endpoint')}
            </select>`, { forId: 'edt-ai-engine' })}

          <div class="edt-engine" id="edt-ai-opencode">
            <div class="stg-field edt-models-field" ${kit.inv('EDT003')}>
              <div class="edt-models-head">
                <label id="edt-ai-models-title">${kit.L('EDT003')}</label>
                <button type="button" class="stg-action-btn" id="edt-ai-fastest" ${kit.inv('EDT004')} title="${kit.H('EDT004')}" disabled>${kit.L('EDT004')}</button>
              </div>
              <div class="stg-help" id="edt-ai-models-help">${kit.H('EDT003')}</div>
              <div class="stg-help edt-result" id="edt-ai-fastest-result" role="status" aria-live="polite" data-stg-data hidden></div>
              <div class="edt-models" id="edt-ai-models" role="radiogroup" aria-labelledby="edt-ai-models-title" aria-describedby="edt-ai-models-help" data-stg-data data-stg-search="off"></div>
            </div>
          </div>

          <div class="edt-engine" id="edt-ai-endpoint" hidden>
            ${kit.field('EDT005', `
              <select class="stg-input" id="edt-ai-kind" aria-describedby="edt-ai-kind-help" disabled>
                ${option('ollama', 'kind.ollama')}${option('openai', 'kind.openai')}
              </select>`, { forId: 'edt-ai-kind' })}
            ${kit.field('EDT006', `
              <div class="settings-key-row">
                <input id="edt-ai-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" aria-describedby="edt-ai-url-help" disabled>
              </div>`, { forId: 'edt-ai-url' })}
            ${kit.field('EDT007', `
              <div class="settings-key-row">
                <input id="edt-ai-endpoint-model" type="text" autocomplete="off" spellcheck="false" aria-describedby="edt-ai-endpoint-model-help" disabled>
              </div>`, { forId: 'edt-ai-endpoint-model' })}
            ${kit.field('EDT008', `
              <select class="stg-input" id="edt-ai-shape" aria-describedby="edt-ai-shape-help" disabled>
                ${option('fim', 'shape.fim')}${option('chat', 'shape.chat')}
              </select>`, { forId: 'edt-ai-shape' })}
            ${kit.field('EDT009', `
              <div class="settings-key-row edt-key-row">
                <input id="edt-ai-key" type="password" autocomplete="off" spellcheck="false" aria-describedby="edt-ai-key-help edt-ai-key-state" disabled>
                <button type="button" class="stg-action-btn" id="edt-ai-key-save" disabled>${c('key.save')}</button>
                <button type="button" class="cc-copy-btn stg-text-btn" id="edt-ai-key-remove" hidden>${c('key.remove')}</button>
              </div>
              <div class="stg-help edt-key-state" id="edt-ai-key-state" role="status" data-stg-data></div>`, { forId: 'edt-ai-key' })}
            <div class="stg-field" ${kit.inv('EDT010')}>
              <div class="stg-action-row" style="align-items:center">
                <button type="button" class="stg-action-btn" id="edt-ai-endpoint-test" aria-describedby="edt-ai-endpoint-test-help" disabled>${kit.L('EDT010')}</button>
                <span class="stg-help edt-result" id="edt-ai-endpoint-result" role="status" aria-live="polite" data-stg-data style="margin:0"></span>
              </div>
              ${kit.help('EDT010', { forId: 'edt-ai-endpoint-test' })}
            </div>
          </div>

          <div class="stg-field edt-exclude-field" ${kit.inv('EDT011')}>
            <label for="edt-ai-exclude">${kit.L('EDT011')}</label>
            <div class="stg-help" id="edt-ai-exclude-help">${kit.H('EDT011')}</div>
            <textarea class="edt-exclude" id="edt-ai-exclude" rows="6" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="edt-ai-exclude-help edt-ai-exclude-count" data-stg-search="off" disabled></textarea>
            <div class="stg-action-row" style="align-items:center">
              <button type="button" class="cc-copy-btn stg-text-btn" id="edt-ai-exclude-reset" ${kit.inv('EDT012')} title="${kit.H('EDT012')}" disabled>${kit.L('EDT012')}</button>
              <span class="stg-help" id="edt-ai-exclude-count" data-stg-data style="margin:0"></span>
            </div>
          </div>

          <div class="stg-field edt-usage-field" ${kit.inv('EDT013')}>
            <label id="edt-ai-usage-label">${kit.L('EDT013')}</label>
            <div class="stg-help" id="edt-ai-usage" aria-labelledby="edt-ai-usage-label" title="${kit.H('EDT013')}" data-stg-data></div>
          </div>
          <div class="stg-help edt-save-status" id="edt-ai-save-status" role="alert" data-stg-data hidden></div>`,
        })}
      </div>`;
}

/**
 * Load the section and wire its controls. Called once per opened Settings panel.
 * @param {HTMLElement} overlay the Settings panel
 * @param {{ fetchImpl?: typeof fetch }} [o]
 */
export function wireCodeEditorTab(overlay, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const pane = kit.paneOf(overlay, 'editor');
  if (!pane) return;
  const $ = (id) => pane.querySelector(`#${id}`);
  const tx = kit.tx;
  const alive = () => document.body.contains(overlay);
  const providersPage = (() => { const page = getSettingsPage('ai-connections'); return page ? tx(pageKeys(page).title) : ''; })();

  let editing = null;           // what the server answered about the editing preferences, or null until it has
  let reading = null;           // what the server answered (readEditorAiResponse), or null until it has
  let view = describeEditorAi(reading, { tx });
  let models = null;            // what GET …/models answered, or null while it is asked
  let busy = false;             // a test or "Find fastest" is running: one at a time
  const results = new Map();    // model id → the result of its last test, for this panel

  const request = async (method, url, body) => {
    try {
      const res = await fetchImpl(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (error) {
      return { status: 0, body: null, error: error?.message || '' };
    }
  };

  const say = (node, text, tone = '') => {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
    if (tone) node.dataset.edtTone = tone; else delete node.dataset.edtTone;
  };

  // ── Editing ──

  function drawEditing() {
    const shown = describeEditorEditing(editing, { tx });
    say($('edt-ed-note'), shown.note?.text || '', shown.note?.tone === 'neutral' ? 'neutral' : '');
    for (const field of EDITING_FIELDS) {
      const node = $(editingId(field.key));
      if (!node) continue;
      if (field.kind === 'toggle') node.checked = shown.values[field.key];
      else node.value = shown.values[field.key];
      node.disabled = !shown.ready;
    }
  }

  /** Save one editing preference; the section then shows what the server holds, whichever way it went. */
  async function saveEditing(field, node) {
    const change = editingChange(field.key, field.kind === 'toggle' ? node.checked : node.value);
    if (!change) { drawEditing(); return; }
    const answer = await request('PUT', CONFIG_URL, change);
    if (!alive()) return;
    const stored = readEditorEditingResponse(answer);
    const ok = stored.state === 'ready';
    if (ok) {
      editing = stored;
      if (reading?.state === 'ready' && answer.body.config.ai) reading = { ...reading, config: answer.body.config };
    }
    say($('edt-ed-save-status'), ok ? '' : describeEditorSaveFailure(answer, { tx }));
    drawEditing();
  }

  for (const field of EDITING_FIELDS) {
    const node = $(editingId(field.key));
    node?.addEventListener('change', () => { saveEditing(field, node); });
  }

  // ── Drawing ──

  function draw() {
    view = describeEditorAi(reading, { tx });
    const off = !view.ready;
    say($('edt-ai-note'), view.note?.text || '', view.note?.tone === 'neutral' ? 'neutral' : '');
    const pill = $('edt-ai-pill');
    if (pill) { pill.textContent = view.pill.text; pill.dataset.state = view.pill.state; }
    const set = (id, change) => { const node = $(id); if (node) change(node); };
    set('edt-ai-enabled', (node) => { node.checked = view.enabled; node.disabled = off; });
    set('edt-ai-engine', (node) => { node.value = view.engine; node.disabled = off; });
    $('edt-ai-opencode').hidden = view.engine !== 'opencode';
    $('edt-ai-endpoint').hidden = view.engine !== 'endpoint';
    set('edt-ai-kind', (node) => { node.value = view.endpoint.kind; node.disabled = off; });
    set('edt-ai-shape', (node) => { node.value = view.endpoint.shape; node.disabled = off; });
    // A field that holds the keyboard keeps what is being typed into it.
    const typing = (node) => node === document.activeElement;
    set('edt-ai-url', (node) => { if (!typing(node)) node.value = view.endpoint.url; node.placeholder = view.urlPlaceholder; node.disabled = off; });
    set('edt-ai-endpoint-model', (node) => { if (!typing(node)) node.value = view.endpoint.model; node.disabled = off; });
    set('edt-ai-key', (node) => { node.placeholder = view.keyPlaceholder; node.disabled = off; });
    set('edt-ai-key-save', (node) => { node.disabled = off || !$('edt-ai-key').value.trim(); });
    set('edt-ai-key-remove', (node) => { node.hidden = off || !view.hasKey; });
    set('edt-ai-key-state', (node) => { if (!node.dataset.edtTone) node.textContent = view.keyState; node.dataset.edtKey = view.hasKey ? 'set' : 'none'; });
    set('edt-ai-endpoint-test', (node) => { node.disabled = off || busy || !(view.endpoint.url && view.endpoint.model); });
    set('edt-ai-exclude', (node) => { if (!typing(node)) node.value = view.exclude; node.disabled = off; });
    set('edt-ai-exclude-reset', (node) => { node.disabled = off; });
    set('edt-ai-exclude-count', (node) => { node.textContent = view.excludeCount; });
    drawModels();
  }

  function drawModels() {
    const box = $('edt-ai-models');
    if (!box) return;
    const list = view.ready ? describeEditorModels(models, view.model, { tx, providersPage }) : { state: 'unavailable', message: '', canStart: false, rows: [] };
    box.dataset.edtModels = list.state;
    const fastest = $('edt-ai-fastest');
    if (fastest) fastest.disabled = !view.ready || busy;
    const row = (model) => {
      const id = kit.esc(model.id);
      const result = results.get(model.id);
      return `
        <div class="edt-model${model.selected ? ' selected' : ''}" data-edt-model="${id}">
          <label class="edt-model-pick">
            <input type="radio" name="edt-ai-model" value="${id}"${model.selected ? ' checked' : ''} aria-label="${c('models.pick', { model: model.label })}">
            <span class="edt-model-name">${kit.esc(model.label)}</span>
            <span class="edt-model-meta">${kit.esc(model.listed ? `${model.provider} · ${model.meta}` : model.meta)}</span>
          </label>
          <button type="button" class="cc-copy-btn stg-text-btn edt-model-test" data-edt-test="${id}" aria-label="${c('models.testNamed', { model: model.label })}"${busy ? ' disabled' : ''}>${c('models.test')}</button>
          <div class="stg-help edt-model-result" role="status" aria-live="polite"${result ? ` data-edt-tone="${result.tone}"` : ' hidden'}>${result ? kit.esc(result.text) : ''}</div>
        </div>`;
    };
    const message = list.message
      ? `<div class="stg-help edt-models-message">${kit.esc(list.message)}${list.canStart ? ` <button type="button" class="cc-copy-btn stg-text-btn" id="edt-ai-models-start">${c('models.start')}</button>` : ''}</div>`
      : '';
    box.innerHTML = list.rows.map(row).join('') + message;
  }

  // ── Loading ──

  async function loadModels({ start = false } = {}) {
    if (view.engine !== 'opencode' && !start) return;
    models = null;
    drawModels();
    const answer = await request('GET', `${COMPLETE_URL}/models${start ? '?start=1' : ''}`);
    if (!alive()) return;
    models = answer;
    drawModels();
  }

  async function loadUsage() {
    const answer = await request('GET', `${COMPLETE_URL}/usage`);
    if (!alive()) return;
    const usage = $('edt-ai-usage');
    if (usage) usage.textContent = describeEditorUsage(answer.status === 200 ? answer.body?.today : null, { tx });
  }

  async function load() {
    const [config, caps] = await Promise.all([request('GET', CONFIG_URL), request('GET', '/api/editor/capabilities')]);
    if (!alive()) return;
    editing = readEditorEditingResponse(config);
    drawEditing();
    reading = readEditorAiResponse({ ...config, capabilities: Array.isArray(caps.body?.capabilities) ? caps.body.capabilities : null });
    draw();
    if (reading.state !== 'ready') return;
    loadModels();
    loadUsage();
  }

  // ── Saving ──

  /** Save a partial change; the section then shows what the server holds, whichever way it went. */
  async function save(partial) {
    const answer = await request('PUT', CONFIG_URL, partial);
    if (!alive()) return false;
    const ok = answer.status === 200 && answer.body?.ok === true && !!answer.body.config?.ai;
    if (ok) reading = { state: 'ready', config: answer.body.config, hasEndpointKey: answer.body.hasEndpointKey === true, reason: null };
    if (ok && editing?.state === 'ready' && answer.body.config.editing) editing = { ...editing, editing: answer.body.config.editing };
    say($('edt-ai-save-status'), ok ? '' : describeEditorSaveFailure(answer, { tx }));
    draw();
    return ok;
  }

  const enabled = $('edt-ai-enabled');
  enabled?.addEventListener('change', () => { save({ ai: { enabled: enabled.checked } }); });
  $('edt-ai-engine')?.addEventListener('change', async (event) => {
    if (await save({ ai: { engine: event.target.value } }) && view.engine === 'opencode' && !models) loadModels();
  });
  $('edt-ai-kind')?.addEventListener('change', (event) => { save({ ai: { endpoint: { kind: event.target.value } } }); });
  $('edt-ai-shape')?.addEventListener('change', (event) => { save({ ai: { endpoint: { shape: event.target.value } } }); });
  $('edt-ai-url')?.addEventListener('change', (event) => {
    const url = event.target.value.trim();
    // Not an address: nothing is sent, and the field says why instead of silently emptying itself.
    if (url && !isEndpointUrl(url)) { say($('edt-ai-save-status'), tx(`${K}.url.invalid`)); return; }
    save({ ai: { endpoint: { url } } });
  });
  $('edt-ai-endpoint-model')?.addEventListener('change', (event) => { save({ ai: { endpoint: { model: event.target.value.trim() } } }); });
  $('edt-ai-exclude')?.addEventListener('change', (event) => { save({ ai: { exclude: parseExcludeList(event.target.value) } }); });
  $('edt-ai-exclude-reset')?.addEventListener('click', () => { save({ ai: { exclude: [...AI_EXCLUDE_DEFAULTS] } }); });

  // The key: written, never read back.
  const keyInput = $('edt-ai-key');
  const keyState = $('edt-ai-key-state');
  keyInput?.addEventListener('input', () => { $('edt-ai-key-save').disabled = !view.ready || !keyInput.value.trim(); });
  async function saveKey(value) {
    const answer = await request('PUT', CONFIG_URL, { endpointKey: value });
    if (!alive()) return;
    const ok = answer.status === 200 && answer.body?.ok === true;
    if (ok) {
      reading = { state: 'ready', config: answer.body.config, hasEndpointKey: answer.body.hasEndpointKey === true, reason: null };
      keyInput.value = '';
      say(keyState, tx(value ? `${K}.key.saved` : `${K}.key.removed`), 'ok');
    } else {
      say(keyState, describeEditorSaveFailure(answer, { tx }), 'err');
    }
    draw();
    // The line goes back to saying whether a key is set.
    setTimeout(() => { if (alive()) { delete keyState.dataset.edtTone; keyState.textContent = view.keyState; } }, 4000);
  }
  $('edt-ai-key-save')?.addEventListener('click', () => { const value = keyInput.value.trim(); if (value) saveKey(value); });
  keyInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter' && keyInput.value.trim()) { event.preventDefault(); saveKey(keyInput.value.trim()); } });
  $('edt-ai-key-remove')?.addEventListener('click', () => saveKey(''));

  // ── Tests ──

  async function runTest(body) {
    busy = true;
    draw();
    const answer = await request('POST', `${COMPLETE_URL}/test`, body);
    busy = false;
    return answer;
  }

  $('edt-ai-models')?.addEventListener('change', (event) => {
    const radio = event.target.closest?.('input[name="edt-ai-model"]');
    if (radio?.checked) save({ ai: { model: radio.value } });
  });
  $('edt-ai-models')?.addEventListener('click', async (event) => {
    if (event.target.closest?.('#edt-ai-models-start')) { loadModels({ start: true }); return; }
    const button = event.target.closest?.('[data-edt-test]');
    if (!button || busy) return;
    const model = button.dataset.edtTest;
    results.set(model, { tone: '', text: tx(`${K}.test.running`) });
    const answer = await runTest({ engine: 'opencode', model });
    if (!alive()) return;
    results.set(model, describeEditorTest(answer.status === 200 ? answer.body?.results?.[0] : null, { tx }));
    draw();
    loadUsage();
  });
  $('edt-ai-fastest')?.addEventListener('click', async () => {
    if (busy) return;
    const line = $('edt-ai-fastest-result');
    say(line, tx(`${K}.fastest.running`));
    const answer = await runTest({ fastest: true });
    if (!alive()) return;
    const body = answer.status === 200 ? answer.body : null;
    for (const result of Array.isArray(body?.results) ? body.results : []) results.set(result.model, describeEditorTest(result, { tx }));
    const found = describeEditorFastest(body, { tx });
    say(line, found.text, found.tone);
    if (found.model) await save({ ai: { model: found.model } });
    else draw();
    // the list may have come from a serve that was just started for this
    if (!models || models.body?.available === false) loadModels();
    loadUsage();
  });
  $('edt-ai-endpoint-test')?.addEventListener('click', async () => {
    if (busy) return;
    const line = $('edt-ai-endpoint-result');
    say(line, tx(`${K}.test.running`));
    const answer = await runTest({ engine: 'endpoint' });
    if (!alive()) return;
    const result = describeEditorTest(answer.status === 200 ? answer.body?.results?.[0] : null, { tx });
    say(line, result.text, result.tone);
    draw();
    loadUsage();
  });

  // The editor's View menu, its AI popover, or another window, changed the preferences.
  const off = on('sync:editor:config-changed', (message) => {
    if (!alive() || !message?.config) return;
    if (editing?.state === 'ready' && message.config.editing) {
      editing = { ...editing, editing: message.config.editing };
      drawEditing();
    }
    if (reading?.state !== 'ready' || !message.config.ai) return;
    reading = { ...reading, config: message.config, hasEndpointKey: typeof message.hasEndpointKey === 'boolean' ? message.hasEndpointKey : reading.hasEndpointKey };
    draw();
  });
  overlay.addEventListener('settings-close', off, { once: true });

  drawEditing();
  draw();
  load();
}
