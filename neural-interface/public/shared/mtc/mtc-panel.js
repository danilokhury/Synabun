// ═══════════════════════════════════════════
// SynaBun — Maritaca side panel
// ═══════════════════════════════════════════
//
// Maritaca AI's Sabiá models in a side panel, on par with the Claude Code, Codex, OpenCode and Antigravity panels:
// tabs (one conversation each), streamed replies with their reasoning, usage and cost in BRL, a model and a reasoning
// picker, the conversation list (open, rename, delete), Copy and Retry, plan mode with the plan review card, the
// Effort toggle (S5 family), the header cog's Context settings popover (the context window used, the conversation, the
// connection) and the settings dialog (the API key with a connection test, the default model, reasoning level, system
// prompt and temperature). Maritaca is a chat API, not a coding agent: no tools run from here and the Assistant never
// dispatches to it (docs/maritaca-sidepanel.md).
// The server end is /ws/maritaca (lib/maritaca/panel-bridge.js) and /api/maritaca (lib/maritaca/api.js).
//
// What decides lives in DOM-free modules (mtc-logic.js, mtc-client.js) and the HTML in mtc-render.js; this file
// wires. Every string is mtcText() (mtc-copy.js), every dropdown the app's .cc-dropdown.

import { MTC_COPY, mtcText, setMaritacaTranslator } from './mtc-copy.js';
import { injectMaritacaStyles } from './mtc-styles.js';
import { createMaritacaClient } from './mtc-client.js';
import {
  applyDelta, applyLoadedSession, applyReasoning, canUse, contextMenuModel, contextReading, createTranscript, effortControl, effortEntries, effortForServer,
  endTurn, filterSessions, findModelRow, keyStatusLine, lastAnswer, conversationCost, formatBrl, formatShare, MAX_TABS, MAX_DRAFT_CHARS, modelEntries, newTab, normalizeEffort,
  planKey, planReview, restoreTabs, branchEntries, branchSwitchPlan, serializeTabs, settingsPatch, startTurn, tabLabel, turnErrorText,
} from './mtc-logic.js';
import { attachmentsHtml, contextPopHtml, effortMenuHtml, emptyHtml, esc, ICONS, planCardHtml, rowHtml, sessionsHtml, settingsHtml } from './mtc-render.js';
import { attachmentProblem, attachmentRequest, ATTACH_LIMITS, COMMANDS, commandFor, commandHints, composerState } from './mtc-compose.js';
import { t } from '../i18n.js';
import { storage } from '../storage.js';
import { state, emit, on } from '../state.js';
import { registerSidepanel, setSidepanelVisible, focusSidepanel, getSidepanelPresentation, openAnotherSidepanelSession } from '../ui-sidepanel-windows.js';
import { hostedSidepanelId } from '../ui-sidepanel-runtime.js';
import { dropdownHTML, dropdownOf, setDropdownDisabled, setDropdownItems, wireDropdowns, closeDropdowns } from '../cc-dropdown.js';
import { renderMarkdown } from '../cp/cp-markdown.js';
import { fetchProjects } from '../api.js';
import { createStickyScrollController } from '../ui-scroll-follow.js';

export const PANEL_OWNER = 'maritaca-sidepanel';
const ICON = ICONS.mark;
const SVG = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
};

export const windowId = hostedSidepanelId || sessionStorage.getItem('mtc-window-id') || (() => {
  const id = globalThis.crypto?.randomUUID?.() || `mtc-${Date.now()}`;
  sessionStorage.setItem('mtc-window-id', id);
  return id;
})();
// No 'last used model' key: a new tab follows the saved default model (Settings → Default model) until it picks its own.
const STOR = { tabs: `synabun-maritaca-panel-tabs-${windowId}`, active: `synabun-maritaca-panel-active-${windowId}`, project: 'synabun-maritaca-panel-project' };

let _panel = null;
let _visible = false;
let _client = null;
let _tabs = [];
let _activeIdx = 0;
let _projects = [];
let _models = [];
let _hello = null;
let _status = null;       // GET /api/maritaca/settings
let _pop = null;          // { el, kind, cleanup }: the conversations list or the Context settings popover
let _settings = null;     // { el, cleanup }: the settings dialog, inside the panel
let _effortMenuOpen = false;
let _ctxCopiedUntil = 0;
let _ctxSig = '';
let _renderQueued = false;
let _workingTimer = null;
let _workingTurn = null;
let _blocked = null;
let _scroll = null;
let _hintIndex = 0;
let _lastRenderedTab = null;
let _bannerTimer = null;
const _runtime = new Map();
const _mdCache = new Map();
const T = mtcText;
const $ = (selector) => _panel?.querySelector(selector) || null;
const activeTab = () => _tabs[_activeIdx] || null;
const tabBySession = (sessionId) => _tabs.find((tab) => tab.sessionId === sessionId) || null;

function runtimeOf(tab) {
  if (!tab) return null;
  if (!_runtime.has(tab.id)) _runtime.set(tab.id, { transcript: createTranscript(), loading: null, scrolledUp: false, scrollTop: 0 });
  return _runtime.get(tab.id);
}

let _marked = null;
function ensureMarked() {
  if (_marked || typeof window === 'undefined') return;
  import('/vendor/marked/marked-14.1.4.esm.js')
    .then((mod) => { _marked = mod?.marked || mod?.default || null; _marked?.setOptions?.({ breaks: true, gfm: true }); _mdCache.clear(); scheduleRender(); })
    .catch(() => { /* plain text until it loads */ });
}
function md(text) {
  if (!text) return '';
  if (_mdCache.has(text)) return _mdCache.get(text);
  let html = '';
  try { html = renderMarkdown(text, { parse: _marked ? (src) => _marked.parse(src) : null }); } catch { html = `<p>${esc(text)}</p>`; }
  if (_mdCache.size > 400) _mdCache.clear();
  _mdCache.set(text, html);
  return html;
}

function saveTabs() { try { storage.setItem(STOR.tabs, JSON.stringify(serializeTabs(_tabs))); storage.setItem(STOR.active, activeTab()?.id || ''); } catch { /* storage full */ } }
function loadTabs() {
  let saved = null;
  try { saved = JSON.parse(storage.getItem(STOR.tabs) || 'null'); } catch { saved = null; }
  _tabs = restoreTabs(saved);
  _activeIdx = Math.max(0, _tabs.findIndex((tab) => tab.id === storage.getItem(STOR.active)));
}

function acceptTurn(tab, msg) {
  if (!tab || !_tabs.includes(tab) || !msg.turnId) return;
  const rt = runtimeOf(tab);
  if (rt.transcript.rows.some((row) => row.turnId === msg.turnId)) return;
  if (msg.session) { applyLoadedSession(rt.transcript, msg.session); tab.title = msg.session.title || ''; tab.project = msg.session.project || ''; }
  startTurn(rt.transcript, { turnId: msg.turnId, text: msg.text || tab.draft, model: msg.model, appendUser: !msg.session, startedAt: msg.startedAt, mode: msg.mode });
  tab.running = true; tab.turnId = msg.turnId;
  tab.model = msg.model || tab.model;
}

function client() {
  if (_client) return _client;
  _client = createMaritacaClient();
  _client.on('connected', (hello) => { _hello = hello; _blocked = null; applyStatus(hello); if (!_models.length && Array.isArray(hello.models)) _models = hello.models; for (const tab of _tabs) if (tab.sessionId) loadSession(tab).catch(() => {}); loadModels(); scheduleRender(); });
  _client.on('disconnected', () => { for (const tab of _tabs) if (tab.running) { tab.running = false; tab.turnId = null; const rt = runtimeOf(tab); const row = endTurn(rt.transcript, { turnId: rt.transcript.turn?.turnId, finishReason: 'error', error: T('errorDisconnected'), code: 'DISCONNECTED' }); if (row) row.error = T('errorDisconnected'); } saveTabs(); scheduleRender(); });
  _client.on('blocked', (info) => { _blocked = info; scheduleRender(); });
  _client.on('retrying', () => scheduleRender());
  for (const type of ['turn:start', 'turn:delta', 'turn:reasoning', 'turn:end']) _client.on(type, (msg) => {
    const tab = tabBySession(msg.sessionId);
    if (!tab) return;
    const rt = runtimeOf(tab);
    if (rt.loading) { (rt.buffer ||= []).push({ ...msg, type }); return; }
    handleTurnEvent(tab, { ...msg, type });
  });
  _client.on('session:renamed', (msg) => { for (const tab of _tabs) if (tab.sessionId === msg.sessionId) tab.title = msg.title; saveTabs(); scheduleRender(); });
  _client.on('session:deleted', (msg) => { for (const tab of _tabs) if (tab.sessionId === msg.sessionId) { tab.sessionId = null; tab.title = ''; tab.running = false; tab.turnId = null; applyLoadedSession(runtimeOf(tab).transcript, { messages: [] }); } saveTabs(); scheduleRender(); });
  _client.on('settings:changed', (msg) => { applyStatus(msg.status); loadModels(); scheduleRender(); });
  return _client;
}

function handleTurnEvent(tab, msg) {
  if (!_tabs.includes(tab) || msg.sessionId !== tab.sessionId) return;
  const rt = runtimeOf(tab);
  if (msg.type === 'turn:start') acceptTurn(tab, msg);
  else if (msg.type === 'turn:delta') applyDelta(rt.transcript, msg);
  else if (msg.type === 'turn:reasoning') applyReasoning(rt.transcript, msg);
  else if (msg.type === 'turn:end') {
    const row = endTurn(rt.transcript, { ...msg, error: msg.error ? turnErrorText(msg.code, msg.error, T) : null });
    if (!row && !rt.transcript.rows.some((r) => r.turnId === msg.turnId)) loadSession(tab).catch(() => {});
    tab.running = false; tab.turnId = null;
    if (!tab.title) refreshTitle(tab).catch(() => {});
  }
  saveTabs(); scheduleRender();
}

function applyStatus(status) {
  if (!status || typeof status !== 'object') return;
  _status = { configured: !!status.configured, source: status.source || null, masked: status.masked || null, settings: status.settings || _status?.settings || {} };
}

async function fetchJson(path, options = {}) {
  const res = await fetch(path, { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, cache: 'no-store', ...options });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { code: body?.code || `HTTP_${res.status}`, status: res.status });
  return body;
}

async function loadStatus() {
  try { applyStatus(await fetchJson('/api/maritaca/settings')); } catch { /* the hello carries it too */ }
  scheduleRender();
}

let _modelsPromise = null;
async function loadModels() {
  if (_modelsPromise) return _modelsPromise;
  _modelsPromise = (async () => {
    try {
      const data = canUse(_hello, 'models') ? await client().request('models') : await fetchJson('/api/maritaca/models');
      if (Array.isArray(data?.models) && data.models.length) _models = data.models;
    } catch { /* the table from the hello stands */ }
    scheduleRender();
  })().finally(() => { _modelsPromise = null; });
  return _modelsPromise;
}

let _projectsPromise = null;
async function ensureProjects() {
  if (_projects.length) return;
  if (_projectsPromise) return _projectsPromise;
  _projectsPromise = (async () => {
    try { const data = await fetchProjects(); _projects = Array.isArray(data?.projects) ? data.projects.filter((p) => p && typeof p.path === 'string') : []; } catch { _projects = []; }
    for (const tab of _tabs) if (!tab.project && _projects[0]) tab.project = storage.getItem(STOR.project) || _projects[0].path;
    scheduleRender();
  })().finally(() => { _projectsPromise = null; });
  return _projectsPromise;
}

// ── Tabs ──
function createTab(opts = {}) {
  if (_tabs.length >= MAX_TABS) return null;
  // model null: the tab follows the saved default (Settings → Default model) until a pick in the footer.
  const tab = newTab({ project: opts.project ?? (activeTab()?.project || storage.getItem(STOR.project) || _projects[0]?.path || ''), model: opts.model ?? null });
  _tabs.push(tab);
  _activeIdx = _tabs.length - 1;
  if ($('.mtc-input')) $('.mtc-input').value = '';
  saveTabs(); renderAll();
  $('.mtc-input')?.focus();
  return tab;
}
function switchTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const current = activeTab();
  if (current) { current.draft = $('.mtc-input')?.value || ''; runtimeOf(current).scrollTop = $('.mtc-transcript')?.scrollTop || 0; }
  _activeIdx = idx;
  if ($('.mtc-input')) $('.mtc-input').value = activeTab()?.draft || '';
  saveTabs(); renderAll();
  const tab = activeTab();
  if (tab?.sessionId && !runtimeOf(tab).transcript.loaded) loadSession(tab).catch(() => {});
}
function closeTab(idx) {
  const tab = _tabs[idx];
  if (!tab) return;
  if (tab.submitting || tab.pendingAttachments) return;
  if (tab.running && tab.sessionId) client().request('cancel', { sessionId: tab.sessionId }).catch(() => {});
  tab.pillEl?.remove();
  _runtime.delete(tab.id);
  _tabs.splice(idx, 1);
  if (!_tabs.length) _tabs.push(newTab({ project: tab.project, model: tab.model }));
  if (idx < _activeIdx) _activeIdx--;
  _activeIdx = Math.min(_activeIdx, _tabs.length - 1);
  if ($('.mtc-input')) $('.mtc-input').value = activeTab()?.draft || '';
  saveTabs(); renderAll();
}

async function ensureSession(tab) {
  if (tab.sessionId) return tab.sessionId;
  const data = await client().request('session:new', { project: tab.project || null, model: tab.model || null });
  tab.sessionId = data.session.id;
  runtimeOf(tab).transcript.loaded = true;
  saveTabs();
  return tab.sessionId;
}

async function loadSession(tab) {
  if (!tab?.sessionId) return;
  const rt = runtimeOf(tab);
  if (rt.loading) return rt.loading;
  const sessionId = tab.sessionId;
  rt.loading = (async () => {
    try {
      const data = await client().request('session:load', { sessionId });
      if (!_tabs.includes(tab) || tab.sessionId !== sessionId) return;
      applyLoadedSession(rt.transcript, data.session);
      tab.title = data.session.title || tab.title;
      if (data.session.model) tab.model = data.session.model;
      tab.project = data.session.project || '';
      tab.running = false; tab.turnId = null;
      if (data.running) {
        const row = startTurn(rt.transcript, { turnId: data.running, model: data.partial?.model || tab.model, appendUser: false, startedAt: data.partial?.startedAt, mode: data.partial?.mode });
        row.text = data.partial?.text || ''; row.reasoning = data.partial?.reasoning || '';
        tab.running = true; tab.turnId = data.running;
      }
    } catch (error) {
      if (error?.code === 'SESSION_UNKNOWN' || error?.code === 'SESSION_INVALID') { tab.sessionId = null; tab.title = ''; applyLoadedSession(rt.transcript, { messages: [] }); }
      else showBanner(T('sessionsFailed', { error: error.message }), 'error');
    } finally { rt.loading = null; for (const event of rt.buffer || []) handleTurnEvent(tab, event); rt.buffer = []; saveTabs(); scheduleRender(); }
  })();
  return rt.loading;
}

async function refreshTitle(tab) {
  if (!tab?.sessionId) return;
  const data = await client().request('session:load', { sessionId: tab.sessionId });
  if (data?.session?.title) { tab.title = data.session.title; saveTabs(); scheduleRender(); }
}

// ── Sending ──
/** The model row a tab's next reply uses: its own pick, else the saved default. */
function tabModel(tab) { return findModelRow(_models, tab?.model || _status?.settings?.model) || null; }
/** The mode a turn is sent in, when the server knows plan mode (capability 'plan-mode'); an older one is sent none. */
function modeField(mode) { return canUse(_hello, 'plan-mode') ? { mode } : {}; }

/**
 * One prompt of a tab: the composer's draft (fromDraft) or a plan action's text. Locks the tab before the first await,
 * so a second Enter or click while the session is being made sends nothing. → true when the turn was accepted.
 */
async function submitPrompt(tab, { text = '', files = [], fromDraft = false, mode = null } = {}) {
  if (!tab || tab.submitting || tab.running) return false;
  const turnMode = mode || (tab.planMode ? 'plan' : 'chat');
  tab.submitting = true; renderComposer();
  try {
    await ensureSession(tab);
    if (!_tabs.includes(tab)) return false;
    const data = await client().request('prompt', { sessionId: tab.sessionId, text, attachments: attachmentRequest(files), model: tab.model || _status?.settings?.model || undefined, reasoningEffort: effortForServer(tab.effort, tabModel(tab)), ...modeField(turnMode) });
    acceptTurn(tab, { ...data, text, mode: data?.mode || turnMode });
    tab.model = data.model || tab.model;
    if (fromDraft) {
      tab.draft = ''; tab.attachments = [];
      const input = $('.mtc-input');
      if (activeTab() === tab && input) { input.value = ''; autosize(); }
    }
    runtimeOf(tab).scrolledUp = false;
    if (activeTab() === tab) _scroll?.scrollToBottom({ force: true });
    saveTabs();
    return true;
  } catch (error) {
    showBanner(turnErrorText(error?.code, error?.message, T), 'error');
    if (error?.code === 'NO_KEY') openSettings();
    return false;
  } finally { tab.submitting = false; renderAll(); }
}

async function send() {
  const tab = activeTab();
  const input = $('.mtc-input');
  if (!tab) return;
  tab.draft = input?.value || '';
  if (!tab.attachments?.length && commandFor(tab.draft) && !tab.running && !tab.submitting) { await runCommand(commandFor(tab.draft)); return; }
  const mode = composerState(tab, { blocked: !!_blocked });
  if (!mode.canSend) return;
  if (!_status?.configured) { openSettings(); return; }
  if (tab.editingIndex != null) { await regenerate(tab, { messageIndex: tab.editingIndex, text: tab.draft.trim() }); return; }
  await submitPrompt(tab, { text: tab.draft.trim(), files: [...(tab.attachments || [])], fromDraft: true });
}
async function stop() {
  const tab = activeTab();
  if (!tab?.sessionId || !tab.running) return;
  try { await client().request('cancel', { sessionId: tab.sessionId }); }
  catch (error) { showBanner(turnErrorText(error.code, error.message, T), 'error'); }
}
async function regenerate(tab, { messageIndex, text } = {}) {
  if (!tab?.sessionId || tab.running || tab.submitting || !canUse(_hello, 'regenerate')) return;
  tab.submitting = true; renderComposer();
  try {
    // A retry keeps the mode of the prompt it reruns (the server reads it); an edit is sent in the tab's mode.
    const data = await client().request('regenerate', { sessionId: tab.sessionId, model: tab.model || _status?.settings?.model || undefined, reasoningEffort: effortForServer(tab.effort, tabModel(tab)), ...(messageIndex !== undefined ? { messageIndex, text, ...modeField(tab.planMode ? 'plan' : 'chat') } : {}) });
    acceptTurn(tab, data);
    if (messageIndex !== undefined) { tab.draft = tab.beforeEdit || ''; tab.attachments = tab.beforeEditAttachments || []; tab.editingIndex = null; tab.beforeEdit = ''; tab.beforeEditAttachments = []; tab.editingAttachments = []; if (activeTab() === tab) $('.mtc-input').value = tab.draft; }
    runtimeOf(tab).scrolledUp = false;
    if (activeTab() === tab) _scroll?.scrollToBottom({ force: true });
    saveTabs();
  } catch (error) { showBanner(turnErrorText(error.code, error.message, T), 'error'); }
  finally { tab.submitting = false; renderAll(); }
}

async function stageFiles(files) {
  const tab = activeTab();
  if (!tab || !composerState(tab, { blocked: !!_blocked, supported: canUse(_hello, 'attachments') }).canAttach || tab.editingIndex != null) return;
  tab.pendingAttachments = true; renderComposer();
  try {
    for (const file of files) {
      const problem = await attachmentProblem(file, tab.attachments || [], findModelRow(_models, tab.model || _status?.settings?.model), _hello?.limits?.attachments || ATTACH_LIMITS);
      if (problem) { showBanner(T(problem.key, problem.params), 'error'); continue; }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error(T('attachmentDamaged')));
        reader.readAsDataURL(file);
      });
      if (!_tabs.includes(tab)) break;
      (tab.attachments ||= []).push({ name: file.name, mimeType: file.type || 'text/plain', size: file.size, dataUrl });
    }
    saveTabs();
  } catch (error) { showBanner(T('attachmentFailed', { name: '', error: error.message }), 'error'); }
  finally { tab.pendingAttachments = false; renderComposer(); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); showBanner(T('copied'), 'ok'); }
  catch { showBanner(T('copyFailed'), 'error'); }
}
function cancelEdit() {
  const tab = activeTab();
  if (!tab || tab.submitting) return;
  tab.editingIndex = null; tab.draft = tab.beforeEdit || ''; tab.attachments = tab.beforeEditAttachments || []; tab.beforeEdit = ''; tab.beforeEditAttachments = []; tab.editingAttachments = [];
  $('.mtc-input').value = tab.draft; saveTabs(); renderComposer();
}
/**
 * The plan review card's actions. Continue: the next turn is a chat turn that carries the plan out (plan mode goes off,
 * as approving a plan leaves it in the sibling panels). Suggest changes: another plan turn with the typed changes.
 */
async function runPlanAction(action) {
  const tab = activeTab();
  const plan = tab ? planReview(runtimeOf(tab).transcript, tab) : null;
  if (!tab || !plan) return;
  if (action === 'copy') { await copyText(plan.text); return; }
  if (action === 'dismiss') { tab.planDismissed = planKey(plan); saveTabs(); renderTranscript(); return; }
  if (tab.running || tab.submitting) return;
  if (!_status?.configured) { openSettings(); return; }
  if (action === 'continue') {
    tab.planMode = false;
    if (await submitPrompt(tab, { text: T('planContinuePrompt'), mode: 'chat' })) tab.planDismissed = planKey(plan);
    saveTabs(); renderComposer();
    return;
  }
  if (action === 'feedback') {
    const changes = String(tab.planFeedback || '').trim();
    if (!changes) { $('.mtc-plan-feedback')?.focus(); return; }
    tab.planMode = true;
    if (await submitPrompt(tab, { text: T('planRevisePrompt', { changes }), mode: 'plan' })) tab.planFeedback = '';
    saveTabs(); renderComposer();
  }
}

async function runCommand(command) {
  const tab = activeTab();
  if (!tab) return;
  tab.draft = ''; $('.mtc-input').value = ''; renderComposer();
  switch (command.name) {
    case 'new': createTab(); break;
    case 'sessions': await openSessions(); break;
    case 'rename': startRename(command.args); break;
    case 'retry': await regenerate(tab); break;
    case 'copy': await copyText(lastAnswer(runtimeOf(tab).transcript)?.text || ''); break;
    case 'model': $('#mtc-model-trigger')?.click(); break;
    case 'plan': togglePlanMode(tab, /^(on|off)$/i.test(command.args || '') ? /^on$/i.test(command.args) : null); break;
    case 'effort': {
      // A model without levels: say why instead of doing nothing.
      const control = effortControl(tabModel(tab), tab.effort, _status?.settings?.reasoningEffort, T);
      if (!control.supported) { showBanner(control.title); break; }
      if (command.args && normalizeEffort(command.args)) pickEffort(normalizeEffort(command.args));
      else if (/^(default|auto)$/i.test(command.args || '')) pickEffort('');
      else openEffortMenu();
      break;
    }
    case 'context': await openContextPop(); break;
    case 'settings': await openSettings(); break;
    case 'help': showBanner(COMMANDS.map((name) => `/${name} — ${T(`cmd_${name}`)}`).join('\n') + '\n\n' + T('shortcuts')); break;
  }
  saveTabs();
}

// ── Rendering ──
function scheduleRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; renderAll(); });
}
function renderAll() {
  if (!_panel) return;
  renderTabs(); renderHeader(); renderTranscript(); renderComposer(); renderProjectBar(); renderPills(); renderBanner(); renderContextPop();
}
function renderHeader() {
  const tab = activeTab();
  const label = $('.mtc-session-label');
  if (label && !label.querySelector('input')) label.textContent = tabLabel(tab, T);
  const rename = $('.mtc-header-rename');
  if (rename) rename.disabled = !tab?.sessionId || !!tab?.submitting;
  // The cog's one decoration, as in the sibling panels: a dot from 80% of the context window (stronger from 90%), and
  // the warning dot while no key is set (the popover's Connection section says so).
  const cog = $('.mtc-cog');
  if (cog && tab) {
    const reading = contextReading(runtimeOf(tab).transcript, tabModel(tab));
    const dot = cog.querySelector('.mtc-cog-dot');
    const kind = !_status?.configured ? 'nokey' : reading.pressure;
    dot.className = `mtc-cog-dot${kind ? ` mtc-cog-dot-${kind}` : ''}`;
    dot.hidden = !kind;
    const label = reading.pressure ? T('contextSettingsPressure', { share: formatShare(reading.pct) }) : T('contextSettings');
    if (cog.getAttribute('aria-label') !== label) { cog.setAttribute('aria-label', label); cog.dataset.tooltip = label; }
  }
  if ($('.mtc-new')) $('.mtc-new').disabled = _tabs.length >= MAX_TABS;
  if ($('.mtc-close-tab')) $('.mtc-close-tab').disabled = !!tab?.submitting;
}
function renderTabs() {
  const strip = $('.mtc-tabs');
  if (!strip) return;
  if (_tabs.length < 2) { strip.innerHTML = ''; return; }
  const html = _tabs.map((tab, idx) => `<button type="button" role="tab" class="mtc-tab${tab.running ? ' running' : ''}" aria-selected="${idx === _activeIdx}" tabindex="${idx === _activeIdx ? 0 : -1}" data-idx="${idx}" title="${esc(tabLabel(tab, T))}"><i class="mtc-dot" aria-hidden="true"></i><span class="mtc-tab-label">${esc(tabLabel(tab, T))}</span><span class="mtc-tab-close" data-close="${idx}" aria-label="${esc(T('closeTab'))}">&times;</span></button>`).join('');
  if (strip.innerHTML !== html) strip.innerHTML = html;
}
function renderTranscript() {
  const el = $('.mtc-transcript');
  const tab = activeTab();
  if (!el || !tab) return;
  const rt = runtimeOf(tab);
  const rows = rt.transcript.rows;
  const changedTab = _lastRenderedTab !== tab.id;
  if (changedTab) { _scroll?.setFollowing(!rt.scrolledUp); el.replaceChildren(); _lastRenderedTab = tab.id; }
  const top = changedTab ? rt.scrollTop : el.scrollTop;
  const stick = _scroll?.isFollowing() ?? !rt.scrolledUp;
  rt.scrolledUp = !stick;
  if (!rows.length) {
    el.innerHTML = emptyHtml({ T, configured: !!_status?.configured, blocked: _blocked });
  } else {
    el.querySelector('.mtc-empty')?.remove();
    const existing = new Map([...el.querySelectorAll('.mtc-msg')].map((node) => [node.dataset.row, node]));
    const last = lastAnswer(rt.transcript);
    for (const row of rows) {
      const html = rowHtml(row, { T, md, last: row === last && canUse(_hello, 'regenerate'), disabled: !!tab.running || !!tab.submitting, editable: canUse(_hello, 'edit-resend') });
      let node = existing.get(row.id);
      existing.delete(row.id);
      if (node?._mtcHtml !== html) {
        const open = node?.querySelector('details')?.open;
        const template = document.createElement('template'); template.innerHTML = html;
        const next = template.content.firstElementChild;
        if (open !== undefined && next.querySelector('details')) next.querySelector('details').open = open;
        next._mtcHtml = html;
        if (node) node.replaceWith(next); else el.appendChild(next);
        node = next;
      }
    }
    for (const node of existing.values()) node.remove();
  }
  renderPlanCard(el, tab, rt);
  const jump = $('.mtc-jump');
  if (jump) jump.hidden = stick || !rows.length;
  if (stick) _scroll?.scrollToBottom({ force: true, immediate: true });
  else el.scrollTop = top;
  updateScrollEdges();
  updateWorkingTimer(tab);
}
/**
 * The plan review card after a finished plan reply (planReview in mtc-logic.js). It is made once per plan and then only
 * kept in step (disabled while a reply streams), so a re-render never takes the typed feedback or its focus.
 */
function renderPlanCard(el, tab, rt) {
  const plan = planReview(rt.transcript, tab);
  let node = el.querySelector(':scope > .mtc-plan-msg');
  if (!plan) { node?.remove(); return; }
  const busy = !!tab.running || !!tab.submitting;
  if (!node || node.dataset.planRow !== plan.id) {
    node?.remove();
    const template = document.createElement('template');
    template.innerHTML = planCardHtml({ T, row: plan, feedback: tab.planFeedback || '', disabled: busy });
    node = template.content.firstElementChild;
  }
  if (node !== el.lastElementChild) el.appendChild(node);
  const card = node.querySelector('.mtc-plan-card');
  card?.classList.toggle('is-busy', busy);
  card?.setAttribute('aria-busy', String(busy));
  for (const control of node.querySelectorAll('[data-plan-action="continue"], [data-plan-action="dismiss"], .mtc-plan-feedback')) control.disabled = busy;
  const update = node.querySelector('[data-plan-action="feedback"]');
  if (update) update.disabled = busy || !String(tab.planFeedback || '').trim();
}

function updateWorkingTimer(tab) {
  const line = $('.mtc-status-line');
  if (!line) return;
  if (!tab?.running) { if (_workingTimer) clearInterval(_workingTimer); _workingTimer = null; line.textContent = _blocked ? T(`connBlocked_${_blocked.reason}`, { message: _blocked.message || '' }) : ''; return; }
  if (_workingTimer && _workingTurn === tab.turnId) return;
  clearInterval(_workingTimer); _workingTurn = tab.turnId;
  const started = runtimeOf(tab).transcript.turn?.startedAt || Date.now();
  const tick = () => { line.textContent = T('workingFor', { seconds: Math.max(0, Math.round((Date.now() - started) / 1000)) }); };
  tick();
  _workingTimer = setInterval(tick, 1000);
}
function renderComposer() {
  const tab = activeTab();
  if (!tab) return;
  const mode = composerState(tab, { blocked: !!_blocked, supported: canUse(_hello, 'attachments') });
  _panel?.classList.toggle('mtc-streaming', !!tab?.running);
  const input = $('.mtc-input');
  const sendBtn = $('.mtc-send');
  if (input) {
    if (document.activeElement !== input) input.value = tab?.draft || '';
    input.placeholder = !_status?.configured ? T('placeholderNoKey') : tab?.planMode ? T('planPlaceholder') : T('placeholder');
    input.disabled = !!_blocked || !!tab?.submitting;
    autosize();
  }
  if (sendBtn) {
    const running = !!tab?.running;
    sendBtn.dataset.mode = running ? 'stop' : 'send';
    sendBtn.innerHTML = running ? SVG.stop : SVG.send;
    sendBtn.setAttribute('aria-label', running ? T('stop') : T('send'));
    sendBtn.disabled = !running && !mode.canSend;
    sendBtn.title = running ? T('stop') : mode.busy ? T(tab?.pendingAttachments ? 'uploading' : 'sending') : T('send');
  }
  const modelInput = $('#mtc-model');
  if (modelInput) {
    setDropdownItems(modelInput, modelEntries(_models, tab?.model || _status?.settings?.model || null, T));
    setDropdownDisabled(modelInput, !!tab?.running || mode.busy);
  }
  renderEffortToggle(tab, mode);
  renderPlanToggle(tab);
  const attach = $('.mtc-attach');
  if (attach) { attach.disabled = !mode.canAttach || tab?.editingIndex != null; attach.hidden = !canUse(_hello, 'attachments'); }
  const staged = $('.mtc-staged');
  if (staged) { const files = tab?.editingIndex != null ? tab.editingAttachments : tab?.attachments; const html = attachmentsHtml(files, T, tab?.editingIndex == null); if (staged.innerHTML !== html) staged.innerHTML = html; staged.hidden = !files?.length; }
  const edit = $('.mtc-edit-notice');
  if (edit) edit.hidden = tab?.editingIndex == null;
  if (tab?.pendingAttachments || tab?.submitting) { const line = $('.mtc-status-line'); if (line) line.textContent = tab.pendingAttachments ? T('uploading') : T('sending'); }
  const total = $('.mtc-conversation-cost');
  if (total) { total.textContent = T('conversationCost', { value: formatBrl(conversationCost(runtimeOf(tab).transcript)) }); total.hidden = !runtimeOf(tab).transcript.rows.length; }
  renderHints();
}
/** The Effort toggle (the Codex / Claude panels' control): the level as lit dots, a menu of levels; off for a model without levels. */
function renderEffortToggle(tab, mode) {
  const toggle = $('#mtc-effort-toggle');
  if (!toggle) return;
  const control = effortControl(tabModel(tab), tab?.effort, _status?.settings?.reasoningEffort, T);
  toggle.dataset.effort = control.supported ? control.level : 'unsupported';
  toggle.dataset.picked = tab?.effort && control.supported ? 'true' : 'false';
  toggle.disabled = !control.supported || !!tab?.running || !!mode?.busy;
  toggle.setAttribute('aria-label', control.title);
  toggle.dataset.tooltip = control.title;
  toggle.querySelectorAll('.mtc-effort-dots i').forEach((dot, i) => dot.classList.toggle('lit', i < control.dots));
  if (toggle.disabled && _effortMenuOpen) closeEffortMenu();
  const menu = $('#mtc-effort-menu');
  if (menu && _effortMenuOpen) {
    const html = effortMenuHtml(control.items, T);
    if (menu.innerHTML !== html) menu.innerHTML = html;
  }
}

/** The Plan toggle: on is bright text plus the underline; a server without plan mode shows it off and says why. */
function renderPlanToggle(tab) {
  const toggle = $('#mtc-plan-toggle');
  if (!toggle) return;
  const known = !_hello || canUse(_hello, 'plan-mode');
  const on = !!tab?.planMode && known;
  toggle.classList.toggle('active', on);
  toggle.setAttribute('aria-pressed', String(on));
  toggle.disabled = !known;
  const title = !known ? T('planUnavailable') : on ? T('planToggleOn') : T('planToggleOff');
  toggle.setAttribute('aria-label', title);
  toggle.dataset.tooltip = title;
  _panel?.classList.toggle('mtc-plan-mode', on);
}


function togglePlanMode(tab = activeTab(), force = null) {
  if (!tab || (_hello && !canUse(_hello, 'plan-mode'))) return;
  tab.planMode = force === null ? !tab.planMode : !!force;
  saveTabs(); renderComposer(); renderContextPop();
}

function openEffortMenu() {
  const toggle = $('#mtc-effort-toggle');
  const menu = $('#mtc-effort-menu');
  if (!toggle || !menu || toggle.disabled) return;
  closePop(); closeDropdowns(_panel);
  _effortMenuOpen = true;
  const control = effortControl(tabModel(activeTab()), activeTab()?.effort, _status?.settings?.reasoningEffort, T);
  menu.innerHTML = effortMenuHtml(control.items, T);
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  (menu.querySelector('.mtc-effort-menu-item.selected') || menu.querySelector('.mtc-effort-menu-item'))?.focus();
}
function closeEffortMenu({ focus = false } = {}) {
  if (!_effortMenuOpen) return;
  _effortMenuOpen = false;
  const menu = $('#mtc-effort-menu');
  if (menu) menu.hidden = true;
  const toggle = $('#mtc-effort-toggle');
  toggle?.setAttribute('aria-expanded', 'false');
  if (focus) toggle?.focus();
}
function pickEffort(value) {
  const tab = activeTab();
  if (!tab) return;
  tab.effort = normalizeEffort(value);
  closeEffortMenu({ focus: true });
  saveTabs(); renderComposer(); renderContextPop();
}

function renderHints() {
  const el = $('.mtc-hints');
  if (!el) return;
  const hints = activeTab()?.running ? [] : commandHints(activeTab()?.draft);
  _hintIndex = Math.min(_hintIndex, Math.max(0, hints.length - 1));
  const html = hints.map((name, i) => `<button type="button" role="option" aria-selected="${i === _hintIndex}" id="mtc-hint-${i}" class="mtc-hint${i === _hintIndex ? ' active' : ''}" data-command="${name}"><span>/${name}</span><span>${esc(T(`cmd_${name}`))}</span></button>`).join('');
  if (el.innerHTML !== html) el.innerHTML = html;
  el.hidden = !hints.length;
  const input = $('.mtc-input');
  input?.setAttribute('aria-expanded', String(!!hints.length));
  if (hints.length) input?.setAttribute('aria-activedescendant', `mtc-hint-${_hintIndex}`); else input?.removeAttribute('aria-activedescendant');
}
function updateScrollEdges() {
  const el = $('.mtc-transcript');
  const wrap = $('.mtc-messages-container');
  if (!el || !wrap) return;
  wrap.classList.toggle('mtc-scroll-top', el.scrollTop > 4);
  wrap.classList.toggle('mtc-scroll-bottom', el.scrollHeight - el.scrollTop - el.clientHeight > 4);
}
function renderProjectBar() {
  const input = $('#mtc-project');
  const tab = activeTab();
  if (!input) return;
  const entries = _projects.map((project) => ({ value: project.path, label: project.label || project.path.split(/[\\/]/).pop(), selected: project.path === tab?.project }));
  if (tab?.project && !entries.some((e) => e.value === tab.project)) entries.unshift({ value: tab.project, label: tab.project.split(/[\\/]/).pop() || tab.project, selected: true });
  entries.push({ value: '', label: T('noProjectLabel'), selected: !tab?.project });
  setDropdownItems(input, entries);
  setDropdownDisabled(input, !!tab?.running || !!tab?.submitting);
  renderBranchBar();
}
// The git branch of the tab's project (the Codex panel's #cxp-branch: /api/terminal/branches, /api/terminal/checkout).
let _branchFor = null; let _branchSeq = 0; let _branchBusy = false;
function branchWrap(input) { return dropdownOf(input); }
function renderBranchBar() {
  const input = $('#mtc-branch');
  if (!input) return;
  const project = activeTab()?.project || '';
  if (project !== _branchFor) { _branchFor = project; loadBranches(project); return; }
  setDropdownDisabled(input, _branchBusy || !!activeTab()?.running || !!activeTab()?.submitting || input.dataset.usable !== 'true');
}
async function loadBranches(project) {
  const input = $('#mtc-branch');
  if (!input) return;
  const seq = ++_branchSeq;
  let res = null;
  if (project) { try { const r = await fetch(`/api/terminal/branches?path=${encodeURIComponent(project)}`); res = r.ok ? await r.json() : null; } catch { res = null; } }
  if (seq !== _branchSeq || (activeTab()?.project || '') !== project) return;
  const view = branchEntries(res, T);
  input.dataset.current = view.current;
  input.dataset.usable = view.usable ? 'true' : 'false';
  setDropdownItems(input, view.entries);
  const wrap = branchWrap(input);
  if (wrap) wrap.hidden = !view.usable;
  setDropdownDisabled(input, _branchBusy || !view.usable || !!activeTab()?.running || !!activeTab()?.submitting);
}
async function switchBranch(branch) {
  const tab = activeTab(); const input = $('#mtc-branch');
  const project = tab?.project || ''; const previous = input?.dataset.current || '';
  let plan = branchSwitchPlan({ project, branch, previous, running: !!tab?.running || !!tab?.submitting, status: { ok: true, isGit: true } });
  if (plan.action === 'skip') return;
  if (plan.action === 'busy') { showBanner(T('branchStopFirst'), 'error'); await loadBranches(project); return; }
  _branchBusy = true; renderBranchBar();
  try {
    let status = null;
    try { const r = await fetch(`/api/git/status?path=${encodeURIComponent(project)}`); status = r.ok ? await r.json() : null; } catch { status = null; }
    plan = branchSwitchPlan({ project, branch, previous, running: false, status });
    if (plan.action === 'incomplete') throw new Error(plan.error || T('branchStatusIncomplete'));
    if (plan.action === 'confirm' && !window.confirm(T('branchConfirm', { from: previous || T('branchCurrentFallback'), to: branch, count: plan.count }))) return;
    const response = await fetch('/api/terminal/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: project, branch }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || response.statusText || 'checkout');
    showBanner(T('branchSwitched', { branch: result.branch || branch }));
  } catch (error) {
    showBanner(T('branchFailed', { error: error.message }), 'error');
  } finally {
    _branchBusy = false;
    await loadBranches(project);
  }
}
function renderPills() {
  const tray = document.getElementById('term-minimized-tray');
  for (const tab of _tabs) {
    if (!tab.pillEl?.isConnected) {
      if (!tray) continue;
      const pill = document.createElement('div');
      pill.className = 'term-minimized-pill mtc-session-pill';
      pill.dataset.tabId = tab.id;
      pill.tabIndex = 0;
      pill.setAttribute('role', 'button');
      pill.innerHTML = `<span class="mtc-pill-ring" aria-hidden="true"><i></i></span><span class="term-minimized-pill-icon mtc-mark">${ICON}</span><span class="term-minimized-pill-label"></span><button class="term-minimized-pill-close" data-tooltip="${esc(T('closeTab'))}" aria-label="${esc(T('closeTab'))}">&times;</button>`;
      const openIt = () => { const idx = _tabs.indexOf(tab); if (idx < 0) return; if (!_visible) setVisible(true); switchTab(idx); try { focusSidepanel(PANEL_OWNER); } catch {} };
      pill.addEventListener('click', openIt);
      pill.addEventListener('keydown', (event) => { if (event.target !== pill) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openIt(); } });
      pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', (event) => { event.stopPropagation(); const idx = _tabs.indexOf(tab); if (idx >= 0) closeTab(idx); });
      pill.style.display = 'none';
      tray.appendChild(pill);
      tab.pillEl = pill;
    }
    const label = tab.pillEl.querySelector('.term-minimized-pill-label');
    if (label) label.textContent = tabLabel(tab, T);
    tab.pillEl.classList.toggle('mtc-pill-running', !!tab.running);
    const meaningful = !!(tab.sessionId || tab.running || tab.draft || tab.attachments?.length);
    tab.pillEl.style.display = meaningful && (!_visible || tab !== activeTab()) ? '' : 'none';
  }
}
let _banner = null;
function showBanner(text, tone = '') {
  _banner = { text, tone }; renderBanner(); clearTimeout(_bannerTimer);
  if (tone !== 'error') _bannerTimer = setTimeout(() => { _banner = null; renderBanner(); }, 8000);
}
function renderBanner() {
  const el = $('.mtc-banner');
  if (!el) return;
  const notice = _banner || (_blocked ? { text: T(`connBlocked_${_blocked.reason}`, { message: _blocked.message || '' }), tone: 'error' } : null);
  el.hidden = !notice;
  if (!notice) return;
  el.className = `mtc-banner ${notice.tone}`;
  el.setAttribute('role', notice.tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(notice.text)}</span><button type="button" data-dismiss-banner aria-label="${esc(T('dismiss'))}">&times;</button>`;
}
function autosize() {
  const input = $('.mtc-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, input.scrollHeight)}px`;
}

// ── Popovers ──
function closePop() {
  if (!_pop) return;
  _pop.cleanup?.();
  _pop.el.remove();
  _pop = null;
  _ctxSig = '';
}
/** A popover under `anchor` (a child of <body>, fixed): the conversations list or the Context settings. */
function openPop(kind, anchor, html, { className = '', label = '', id = '' } = {}) {
  closePop(); closeEffortMenu();
  const el = document.createElement('div');
  el.className = `mtc-pop${className ? ` ${className}` : ''}`;
  el.dataset.kind = kind;
  if (id) el.id = id;
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', label || T('sessions'));
  el.innerHTML = html;
  document.body.appendChild(el);
  _pop = { el, kind, anchor, cleanup: null };
  placePop();
  const abort = new AbortController();
  const onDown = (event) => { if (!el.contains(event.target) && !anchor?.contains?.(event.target) && !event.target.closest('.cc-dropdown-menu')) closePop(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePop(); anchor?.focus?.(); } };
  document.addEventListener('pointerdown', onDown, { capture: true, signal: abort.signal });
  window.addEventListener('keydown', onKey, { capture: true, signal: abort.signal });
  window.addEventListener('resize', () => placePop(), { signal: abort.signal });
  wireDropdowns(el, { signal: abort.signal });
  _pop.cleanup = () => abort.abort();
  return el;
}
/** Below its anchor, right edges aligned; above it when there is more room there; always inside the window. */
function placePop() {
  if (!_pop) return;
  const { el, anchor } = _pop;
  const rect = anchor?.getBoundingClientRect?.() || { top: 80, left: window.innerWidth - 380, bottom: 80, right: window.innerWidth - 20 };
  const width = Math.min(el.offsetWidth || 320, window.innerWidth - 24);
  const below = window.innerHeight - rect.bottom - 18;
  const above = rect.top - 18;
  const up = below < 220 && above > below;
  el.style.maxHeight = `${Math.max(140, Math.min(up ? above : below, 620))}px`;
  const height = el.offsetHeight || 300;
  el.style.left = `${Math.round(Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)))}px`;
  el.style.top = `${Math.round(up ? Math.max(12, rect.top - 6 - height) : Math.max(12, Math.min(window.innerHeight - height - 12, rect.bottom + 6)))}px`;
}

/** The header cog's Context settings: the context window used, the conversation, the connection; Settings opens the dialog. */
async function openContextPop(anchor = $('.mtc-cog')) {
  if (_pop?.kind === 'context') { closePop(); return; }
  const tab = activeTab();
  if (!tab) return;
  const el = openPop('context', anchor, contextPopHtml(contextData(tab), { T }), { className: 'mtc-ctxpop', label: T('contextSettings'), id: 'mtc-context-popover' });
  _ctxSig = el.innerHTML;
  anchor?.setAttribute('aria-expanded', 'true');
  const cog = $('.mtc-cog');
  const prev = _pop.cleanup;
  _pop.cleanup = () => { prev?.(); anchor?.setAttribute('aria-expanded', 'false'); cog?.setAttribute('aria-expanded', 'false'); };
  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-act]');
    if (!button || button.disabled) return;
    if (button.dataset.act === 'settings') { closePop(); openSettings(); return; }
    if (button.dataset.act === 'copy-id') {
      const id = button.dataset.value || '';
      navigator.clipboard?.writeText(id).then(() => { _ctxCopiedUntil = Date.now() + 1400; renderContextPop(); setTimeout(renderContextPop, 1450); }).catch(() => showBanner(T('copyFailed'), 'error'));
    }
  });
  el.focus({ preventScroll: true });
}
function contextData(tab) {
  return contextMenuModel({ tab, transcript: runtimeOf(tab).transcript, model: tabModel(tab), status: _status, hello: _hello, T });
}
/** The popover follows the tab on screen while it is open; an unchanged model touches nothing (and keeps the focus). */
function renderContextPop() {
  if (_pop?.kind !== 'context' || !activeTab()) return;
  const html = contextPopHtml(contextData(activeTab()), { T, copied: Date.now() < _ctxCopiedUntil });
  if (html === _ctxSig) return;
  const focused = _pop.el.contains(document.activeElement) ? document.activeElement.dataset?.act || '' : null;
  _ctxSig = html;
  _pop.el.innerHTML = html;
  if (focused) (_pop.el.querySelector(`[data-act="${focused}"]`) || _pop.el).focus({ preventScroll: true });
  placePop();
}

// ── Settings (a dialog inside the panel, the Codex panel's settings overlay) ──
function closeSettings({ focus = true } = {}) {
  if (!_settings) return;
  const { el, cleanup, returnTo } = _settings;
  _settings = null;
  cleanup?.();
  el.remove();
  if (focus && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
}

async function openSettings() {
  if (_settings) { _settings.el.querySelector('.mtc-key-input')?.focus(); return; }
  if (!_panel) return;
  const returnTo = document.activeElement;
  closePop(); closeEffortMenu();
  // The model rows come with the hello: wait for it once, so the pickers are whole on the first open (a refused socket
  // still opens the dialog: the key can be saved and tested over REST).
  if (!_models.length && !_blocked) { try { await client().open(); } catch { /* drawn with what there is */ } }
  if (!_models.length && Array.isArray(_hello?.models)) _models = _hello.models;
  if (_settings) return;
  const status = _status || { configured: false, source: null, masked: null, settings: {} };
  const settings = status.settings || {};
  // The default reasoning level is the S5 family's (the models with levels), whatever the default model is.
  const reasoner = findModelRow(_models, 'S5') || _models.find((m) => Array.isArray(m.efforts) && m.efforts.length) || null;
  const efforts = effortEntries(reasoner, settings.reasoningEffort, T);
  const overlay = document.createElement('div');
  overlay.className = 'mtc-settings-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'mtc-settings-panel';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'mtc-settings-title');
  dialog.innerHTML = settingsHtml({
    T, status, keyLine: keyStatusLine(status, T).text, systemMax: _hello?.limits?.systemPrompt || 8000,
    modelDropdown: dropdownHTML('mtc-settings-model', modelEntries(_models, settings.model || null, T), { labelledBy: 'mtc-settings-model-label' }),
    effortDropdown: efforts.length ? dropdownHTML('mtc-settings-effort', efforts, { labelledBy: 'mtc-settings-effort-label' }) : '',
  });
  overlay.appendChild(dialog);
  _panel.appendChild(overlay);
  const abort = new AbortController();
  // The dialog is inside the panel, whose dropdowns are wired once (wire()): wiring them here too would open and close
  // each one on the same click.
  _settings = { el: overlay, returnTo, cleanup: () => abort.abort() };

  const q = (selector) => dialog.querySelector(selector);
  const keyInput = q('.mtc-key-input');
  const notice = (text, tone = '') => { const n = q('.mtc-settings-notice'); if (n) { n.textContent = text; n.dataset.tone = tone; } };
  const result = (text, tone = '') => { const n = q('.mtc-settings-result'); if (n) { n.textContent = text; n.dataset.tone = tone; } };
  const readForm = () => settingsPatch({
    model: q('#mtc-settings-model')?.value || '', reasoningEffort: q('#mtc-settings-effort')?.value || '',
    systemPrompt: q('.mtc-system-input')?.value || '', temperature: q('.mtc-temp-input')?.value ?? '',
  });
  const saved = () => settingsPatch({ model: _status?.settings?.model || '', reasoningEffort: _status?.settings?.reasoningEffort || '', systemPrompt: _status?.settings?.systemPrompt || '', temperature: _status?.settings?.temperature ?? '' });
  const dirty = () => JSON.stringify(readForm()) !== JSON.stringify(saved());
  const syncDirty = () => { const changed = dirty(); q('[data-save-settings]').disabled = !changed; if (changed) result(T('settingsUnsaved')); else if (q('.mtc-settings-result')?.dataset.tone !== 'ok') result(''); };
  const syncKey = () => {
    const line = q('.mtc-key-status'); if (line) line.textContent = keyStatusLine(_status, T).text;
    const dot = q('.mtc-key-dot'); if (dot) dot.className = `mtc-ctxpop-dot mtc-ctxpop-dot-${_status?.configured ? 'ok' : 'err'} mtc-key-dot`;
    q('[data-forget-key]')?.toggleAttribute('hidden', _status?.source !== 'file');
  };
  const put = async (body) => {
    const data = await fetchJson('/api/maritaca/settings', { method: 'PUT', body: JSON.stringify(body) });
    applyStatus(data);
    syncKey();
    renderAll();
    return data;
  };
  const busy = (button, on) => { if (button) button.disabled = on; };
  // The button is taken before the first await: an event's currentTarget is gone once the handler yields.
  q('[data-save-key]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const key = (keyInput?.value || '').trim();
    if (!key) { notice(T('settingsKeyNone'), 'error'); keyInput?.focus(); return; }
    busy(button, true);
    try { await put({ key }); if (keyInput) keyInput.value = ''; notice(T('settingsKeyStored'), 'ok'); loadModels(); }
    catch (error) { notice(T('settingsFailed', { error: error.message }), 'error'); }
    finally { busy(button, false); }
  }, { signal: abort.signal });
  keyInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); q('[data-save-key]')?.click(); } }, { signal: abort.signal });
  q('[data-test-key]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    busy(button, true); notice(T('settingsKeyTesting'));
    try {
      const key = (keyInput?.value || '').trim();
      await fetchJson('/api/maritaca/test', { method: 'POST', body: JSON.stringify(key ? { key } : {}) });
      notice(T('settingsKeyOk'), 'ok');
    } catch (error) { notice(T('settingsKeyFailed', { error: error.message }), 'error'); }
    finally { busy(button, false); }
  }, { signal: abort.signal });
  q('[data-forget-key]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    busy(button, true);
    try { const data = await fetchJson('/api/maritaca/settings/key', { method: 'DELETE' }); applyStatus(data); syncKey(); notice(T('settingsKeyForgotten'), 'ok'); renderAll(); }
    catch (error) { notice(T('settingsFailed', { error: error.message }), 'error'); }
    finally { busy(button, false); }
  }, { signal: abort.signal });
  q('[data-save-settings]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    busy(button, true); result(T('settingsSaving'));
    try {
      const body = readForm();
      const data = await put(body);
      // Never report success from what was typed: the server's normalized settings are what is now in force.
      const now = data?.settings || {};
      const off = Object.keys(body).filter((k) => JSON.stringify(body[k] ?? null) !== JSON.stringify(now[k] ?? null));
      if (off.length) result(T('settingsNotApplied', { fields: off.join(', ') }), 'error');
      else result(T('settingsSaved'), 'ok');
      fillForm(now);
    } catch (error) { result(T('settingsFailed', { error: error.message }), 'error'); }
    finally {
      syncDirty();
      // Saved, the button turns off and would drop the focus to the page: it stays in the dialog.
      if (button.disabled && (document.activeElement === button || !dialog.contains(document.activeElement))) q('.mtc-settings-close')?.focus({ preventScroll: true });
    }
  }, { signal: abort.signal });
  const fillForm = (now) => {
    const sys = q('.mtc-system-input'); if (sys && sys.value !== (now.systemPrompt || '')) sys.value = now.systemPrompt || '';
    const temp = q('.mtc-temp-input'); if (temp) temp.value = now.temperature === null || now.temperature === undefined ? '' : String(now.temperature);
    updateCount();
  };
  const updateCount = () => { const n = q('.mtc-system-count'); const sys = q('.mtc-system-input'); if (n && sys) n.textContent = T('settingsSystemCount', { count: sys.value.length, max: sys.maxLength > 0 ? sys.maxLength : 8000 }); };
  q('.mtc-system-input')?.addEventListener('input', () => { updateCount(); syncDirty(); }, { signal: abort.signal });
  q('.mtc-temp-input')?.addEventListener('input', syncDirty, { signal: abort.signal });
  for (const id of ['#mtc-settings-model', '#mtc-settings-effort']) q(id)?.addEventListener('change', syncDirty, { signal: abort.signal });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close-settings]')) closeSettings();
  }, { signal: abort.signal });
  // Escape is taken at the window while the dialog is open (the focus may be on the page after a click outside a field):
  // an open dropdown of the dialog closes first, then the dialog.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !_settings || _settings.el !== overlay) return;
    event.preventDefault(); event.stopPropagation();
    if (closeDropdowns(overlay, { focus: true, cancel: true })) return;
    closeSettings();
  }, { capture: true, signal: abort.signal });
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button, input:not([type="hidden"]), textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled && n.getClientRects().length);
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  }, { signal: abort.signal });
  syncDirty();
  (status.configured ? q('.mtc-settings-close') : keyInput)?.focus();
}

async function openSessions() {
  const anchor = $('.mtc-session-btn');
  const tab = activeTab();
  let sessions = [];
  let deletePending = null;
  const el = openPop('sessions', anchor, sessionsHtml({ T, sessions, loading: true, activeId: tab?.sessionId }) + `<label class="mtc-session-filter"><input type="checkbox" class="mtc-session-project">${esc(T('sessionsProject'))}</label>`);
  const list = () => el.querySelector('.mtc-session-list');
  const draw = (query = el.querySelector('.mtc-session-search')?.value || '') => {
    const l = list(); if (!l) return;
    const filtered = filterSessions(sessions, query).filter((s) => !el.querySelector('.mtc-session-project')?.checked || (s.project || '') === (tab?.project || ''));
    const template = document.createElement('template'); template.innerHTML = sessionsHtml({ T, sessions: filtered, activeId: tab?.sessionId, deletePending });
    l.replaceWith(template.content.querySelector('.mtc-session-list'));
  };
  try { sessions = (await client().request('session:list', {})).sessions || []; draw(); }
  catch (error) { const l = list(); if (l) l.innerHTML = `<div class="mtc-pop-note error">${esc(T('sessionsFailed', { error: error.message }))}</div>`; }
  if (_pop?.el !== el) return;
  el.querySelector('.mtc-session-search')?.addEventListener('input', (event) => draw(event.target.value));
  el.querySelector('.mtc-session-project')?.addEventListener('change', () => draw());
  el.addEventListener('click', async (event) => {
    if (event.target.closest('[data-cancel-delete]')) { deletePending = null; draw(); return; }
    const del = event.target.closest('[data-delete-session]');
    if (del) { deletePending = del.dataset.deleteSession; draw(); return; }
    const confirmDelete = event.target.closest('[data-confirm-delete]');
    if (confirmDelete) {
      event.stopPropagation();
      const id = confirmDelete.dataset.confirmDelete;
      confirmDelete.disabled = true;
      try { await client().request('session:delete', { sessionId: id }); } catch (error) { confirmDelete.disabled = false; showBanner(T('deleteFailed', { error: error.message }), 'error'); return; }
      deletePending = null;
      sessions = sessions.filter((x) => x.id !== id);
      for (const t2 of _tabs) if (t2.sessionId === id) { t2.sessionId = null; t2.title = ''; t2.running = false; applyLoadedSession(runtimeOf(t2).transcript, { messages: [] }); }
      saveTabs(); draw(el.querySelector('.mtc-session-search')?.value || ''); renderAll();
      return;
    }
    const row = event.target.closest('[data-session]');
    if (!row) return;
    openSession(row.dataset.session);
    closePop();
  });
  el.addEventListener('keydown', (event) => { const row = event.target.closest('[data-session]'); if (row && event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openSession(row.dataset.session); closePop(); } });
  anchor?.setAttribute('aria-expanded', 'true');
  const cleanup = _pop?.cleanup;
  if (_pop?.el === el) _pop.cleanup = () => { cleanup?.(); anchor?.setAttribute('aria-expanded', 'false'); };
  el.querySelector('.mtc-session-search')?.focus();
}
function openSession(sessionId) {
  const existing = _tabs.findIndex((tab) => tab.sessionId === sessionId);
  if (existing >= 0) { switchTab(existing); return; }
  const current = activeTab();
  const target = current && !current.sessionId && !current.draft && !current.attachments?.length && !runtimeOf(current).transcript.rows.length ? current : createTab();
  if (!target) return;
  target.sessionId = sessionId; target.title = '';
  applyLoadedSession(runtimeOf(target).transcript, { messages: [] });
  runtimeOf(target).transcript.loaded = false;
  saveTabs(); renderAll();
  loadSession(target).catch(() => {});
}
function startRename(proposed = '') {
  const tab = activeTab();
  const label = $('.mtc-session-label');
  if (!tab?.sessionId || !label || label.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text'; input.value = typeof proposed === 'string' && proposed ? proposed : tab.title || ''; input.maxLength = 120; input.setAttribute('aria-label', T('rename'));
  label.textContent = ''; label.appendChild(input); input.focus(); input.select();
  let finished = false;
  const finish = async (commit) => {
    if (finished) return; finished = true;
    const value = input.value.trim();
    label.textContent = tabLabel(tab, T);
    if (!commit || value === (tab.title || '')) return;
    try { const data = await client().request('session:rename', { sessionId: tab.sessionId, title: value }); tab.title = data.session.title; } catch (error) { showBanner(T('renameFailed', { error: error.message }), 'error'); }
    saveTabs(); renderAll();
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); finish(true); } else if (event.key === 'Escape') { event.preventDefault(); finish(false); } });
  input.addEventListener('blur', () => finish(true), { once: true });
}

// ── Wiring ──
function wire() {
  wireDropdowns(_panel);
  $('.mtc-new')?.addEventListener('click', () => { if (!openAnotherSidepanelSession(PANEL_OWNER, 'maritaca', { project: activeTab()?.project || '' })) createTab(); });
  $('.mtc-minimize')?.addEventListener('click', () => setVisible(false));
  $('.mtc-close-tab')?.addEventListener('click', () => closeTab(_activeIdx));
  $('.mtc-cog')?.addEventListener('click', () => openContextPop($('.mtc-cog')));
  $('#mtc-plan-toggle')?.addEventListener('click', () => togglePlanMode());
  $('#mtc-effort-toggle')?.addEventListener('click', () => (_effortMenuOpen ? closeEffortMenu({ focus: true }) : openEffortMenu()));
  const effortMenu = $('#mtc-effort-menu');
  effortMenu?.addEventListener('click', (event) => { const item = event.target.closest('[data-effort-value]'); if (item) pickEffort(item.dataset.effortValue); });
  effortMenu?.addEventListener('keydown', (event) => {
    const items = [...effortMenu.querySelectorAll('.mtc-effort-menu-item')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); (event.key === 'Home' ? items[0] : items.at(-1))?.focus(); }
    else if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); } closeEffortMenu({ focus: event.key === 'Escape' }); }
  });
  document.addEventListener('pointerdown', (event) => { if (_effortMenuOpen && !event.target.closest?.('.mtc-effort-wrap')) closeEffortMenu(); }, { capture: true });
  $('.mtc-session-btn')?.addEventListener('click', () => (_pop?.kind === 'sessions' ? closePop() : openSessions()));
  $('.mtc-header-rename')?.addEventListener('click', () => startRename());
  $('.mtc-tabs')?.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close]');
    if (close) { event.stopPropagation(); closeTab(Number(close.dataset.close)); return; }
    const tab = event.target.closest('[data-idx]');
    if (tab) switchTab(Number(tab.dataset.idx));
  });
  $('.mtc-tabs')?.addEventListener('dblclick', (event) => { const tab = event.target.closest('[data-idx]'); if (tab && !event.target.closest('[data-close]')) { switchTab(Number(tab.dataset.idx)); startRename(); } });
  $('.mtc-tabs')?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); switchTab((_activeIdx + (event.key === 'ArrowLeft' ? -1 : 1) + _tabs.length) % _tabs.length); $('.mtc-tab[aria-selected="true"]')?.focus(); }
    if (event.key === 'Delete') { event.preventDefault(); closeTab(_activeIdx); }
  });
  const transcript = $('.mtc-transcript');
  _scroll = createStickyScrollController(transcript);
  transcript?.addEventListener('scroll', () => { const rt = runtimeOf(activeTab()); if (!rt) return; rt.scrolledUp = !_scroll.isFollowing(); rt.scrollTop = transcript.scrollTop; const jump = $('.mtc-jump'); if (jump) jump.hidden = !rt.scrolledUp; updateScrollEdges(); });
  transcript?.addEventListener('click', async (event) => {
    if (event.target.closest('[data-open-settings]')) { openSettings(); return; }
    const copy = event.target.closest('[data-copy-row]');
    if (copy) {
      const row = runtimeOf(activeTab())?.transcript.rows.find((r) => r.id === copy.dataset.copyRow);
      if (row?.text) await copyText(row.text);
      return;
    }
    const edit = event.target.closest('[data-edit-row]');
    if (edit) {
      const tab = activeTab();
      if (tab.running || tab.submitting) return;
      const row = runtimeOf(tab).transcript.rows.find((r) => r.id === edit.dataset.editRow);
      if (!row) return;
      if (tab.editingIndex == null) { tab.beforeEdit = tab.draft; tab.beforeEditAttachments = tab.attachments || []; }
      tab.attachments = []; tab.editingAttachments = row.attachments || []; tab.editingIndex = row.messageIndex; tab.draft = row.text;
      $('.mtc-input').value = row.text; renderComposer(); $('.mtc-input').focus();
    }
    if (event.target.closest('[data-retry-row]')) regenerate(activeTab());
    const planAction = event.target.closest('[data-plan-action]');
    if (planAction && !planAction.disabled) await runPlanAction(planAction.dataset.planAction);
  });
  transcript?.addEventListener('input', (event) => {
    if (!event.target.matches?.('.mtc-plan-feedback')) return;
    const tab = activeTab(); if (!tab) return;
    tab.planFeedback = event.target.value;
    const update = event.target.closest('.mtc-plan-msg')?.querySelector('[data-plan-action="feedback"]');
    if (update) update.disabled = !!tab.running || !!tab.submitting || !tab.planFeedback.trim();
    event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 132)}px`;
    saveTabs();
  });
  transcript?.addEventListener('keydown', (event) => {
    if (event.target.matches?.('.mtc-plan-feedback') && event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); runPlanAction('feedback'); }
  });
  $('.mtc-jump')?.addEventListener('click', () => { const rt = runtimeOf(activeTab()); if (rt) rt.scrolledUp = false; if (transcript) transcript.scrollTop = transcript.scrollHeight; renderTranscript(); });
  const form = $('.mtc-composer');
  const input = $('.mtc-input');
  form?.addEventListener('submit', (event) => { event.preventDefault(); if (activeTab()?.running) stop(); else send(); });
  input?.addEventListener('input', () => { const tab = activeTab(); if (tab) tab.draft = input.value; _hintIndex = 0; renderComposer(); renderPills(); renderContextPop(); });
  input?.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const hints = commandHints(input.value);
    if (hints.length && !$('.mtc-hints')?.hidden) {
      if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); _hintIndex = (_hintIndex + (event.key === 'ArrowUp' ? -1 : 1) + hints.length) % hints.length; renderHints(); return; }
      if (event.key === 'Tab') { event.preventDefault(); input.value = `/${hints[_hintIndex]} `; activeTab().draft = input.value; renderComposer(); return; }
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); runCommand({ name: hints[_hintIndex], args: '' }); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $('.mtc-hints').hidden = true; return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!activeTab()?.running) send(); }
    // Shift+Tab switches plan mode, as it cycles the permission modes in the Claude panel.
    if (event.key === 'Tab' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && (!_hello || canUse(_hello, 'plan-mode'))) { event.preventDefault(); togglePlanMode(); }
  });
  input?.addEventListener('blur', () => saveTabs());
  $('#mtc-branch')?.addEventListener('change', (event) => { switchBranch(event.target.value || ''); });
  $('#mtc-project')?.addEventListener('change', async (event) => { const tab = activeTab(); if (!tab) return; const previous = tab.project; tab.project = event.target.value || ''; if (tab.project) storage.setItem(STOR.project, tab.project); if (tab.sessionId && canUse(_hello, 'session-project')) { try { await client().request('session:project', { sessionId: tab.sessionId, project: tab.project }); } catch (error) { tab.project = previous; showBanner(error.message, 'error'); } } saveTabs(); renderProjectBar(); });
  // A model of the footer is this tab's alone; its reasoning pick starts over (another model may have other levels).
  $('#mtc-model')?.addEventListener('change', (event) => { const tab = activeTab(); if (!tab) return; tab.model = event.target.value || null; tab.effort = null; saveTabs(); renderComposer(); renderHeader(); renderContextPop(); });
  $('.mtc-attach')?.addEventListener('click', () => $('.mtc-file-input')?.click());
  $('.mtc-file-input')?.addEventListener('change', (event) => { stageFiles([...event.target.files]); event.target.value = ''; });
  $('.mtc-staged')?.addEventListener('click', (event) => { const remove = event.target.closest('[data-remove-attachment]'); const tab = activeTab(); if (!remove || tab?.submitting) return; tab.attachments.splice(Number(remove.dataset.removeAttachment), 1); saveTabs(); renderComposer(); });
  input?.addEventListener('paste', (event) => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); stageFiles(files); } });
  let dragDepth = 0;
  _panel.addEventListener('dragenter', (event) => { if (![...(event.dataTransfer?.types || [])].includes('Files')) return; event.preventDefault(); dragDepth++; _panel.classList.add('mtc-dragging'); });
  _panel.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
  _panel.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) _panel.classList.remove('mtc-dragging'); });
  _panel.addEventListener('drop', (event) => { const files = [...(event.dataTransfer?.files || [])]; if (files.length) { event.preventDefault(); stageFiles(files); } dragDepth = 0; _panel.classList.remove('mtc-dragging'); });
  $('.mtc-hints')?.addEventListener('click', (event) => { const hint = event.target.closest('[data-command]'); if (hint) runCommand({ name: hint.dataset.command, args: '' }); });
  $('.mtc-cancel-edit')?.addEventListener('click', cancelEdit);
  $('.mtc-banner')?.addEventListener('click', (event) => { if (event.target.closest('[data-dismiss-banner]')) { _banner = null; renderBanner(); } });
  _panel.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.altKey) {
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); createTab(); return; }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); switchTab((_activeIdx + (event.key === 'ArrowLeft' ? -1 : 1) + _tabs.length) % _tabs.length); return; }
    }
    if (event.key === 'Escape') {
      if (_settings) { closeSettings(); return; }
      if (_effortMenuOpen) { closeEffortMenu({ focus: true }); return; }
      if (_pop) { closePop(); return; }
      if (closeDropdowns(_panel, { focus: true, cancel: true })) return;
      const tab = activeTab();
      if (tab?.running) { event.preventDefault(); stop(); }
      else if (tab?.editingIndex != null) cancelEdit();
    }
  });
}

function buildPanel() {
  const panel = document.createElement('aside');
  panel.className = 'mtc-panel';
  panel.setAttribute('aria-label', T('title'));
  panel.innerHTML = `
    <div class="mtc-resize-handle" aria-hidden="true"></div>
    <header class="mtc-header">
      <button type="button" class="mtc-session-btn" aria-haspopup="dialog" aria-expanded="false"><span class="mtc-mark">${ICON}</span><span class="mtc-session-label">${esc(T('newSession'))}</span><span class="mtc-dd-arrow" aria-hidden="true">&#9662;</span></button>
      <button type="button" class="mtc-header-rename" data-tooltip="${esc(T('rename'))}" data-tooltip-pos="bottom" aria-label="${esc(T('rename'))}">${SVG.edit}</button>
      <div class="mtc-actions">
        <button type="button" class="mtc-btn mtc-new" aria-label="${esc(T('newTab'))}" data-tooltip="${esc(T('newTab'))}" data-tooltip-pos="bottom">${SVG.plus}</button>
        <button type="button" class="mtc-btn mtc-cog" id="mtc-context-cog" aria-haspopup="dialog" aria-expanded="false" aria-controls="mtc-context-popover" aria-label="${esc(T('contextSettings'))}" data-tooltip="${esc(T('contextSettings'))}" data-tooltip-pos="bottom">${ICONS.cog}<i class="mtc-cog-dot" hidden></i></button>
        <button type="button" class="mtc-btn mtc-minimize" aria-label="${esc(T('minimize'))}" data-tooltip="${esc(T('minimize'))}" data-tooltip-pos="bottom">${SVG.minus}</button>
        <button type="button" class="mtc-btn mtc-btn-danger mtc-close-tab" aria-label="${esc(T('closeTab'))}" data-tooltip="${esc(T('closeTab'))}" data-tooltip-pos="bottom">${SVG.close}</button>
      </div>
    </header>
    <div class="mtc-tabs" role="tablist" aria-label="${esc(T('sessions'))}"></div>
    <div class="mtc-messages-container">
      <div class="mtc-transcript" role="log" aria-live="polite" aria-label="${esc(T('transcript'))}"></div>
      <button type="button" class="mtc-jump" hidden>&darr; ${esc(T('jumpLatest'))}</button>
    </div>
    <div class="mtc-bottom">
      <div class="mtc-banner" role="status" hidden></div>
      <div class="mtc-projectbar">${dropdownHTML('mtc-project', [{ value: '', label: T('chooseProject'), selected: true }], { label: T('project') })}${dropdownHTML('mtc-branch', [{ value: '', label: T('noBranch'), selected: true }], { label: T('branch'), classes: 'mtc-branch-dd', attrs: 'hidden', disabled: true })}</div>
      <div class="mtc-edit-notice" hidden><span>${esc(T('editNotice'))}</span><button type="button" class="mtc-action mtc-cancel-edit">${esc(T('cancelEdit'))}</button></div>
      <div class="mtc-staged" hidden aria-label="${esc(T('attach'))}"></div>
      <div class="mtc-hints" id="mtc-hints" role="listbox" aria-label="${esc(T('commandMenu'))}" hidden></div>
      <form class="mtc-composer" autocomplete="off">
        <div class="mtc-input-wrap" data-drop-label="${esc(T('dropFiles'))}"><span class="mtc-composer-ring" aria-hidden="true"><i></i></span><div class="mtc-input-shell">
          <textarea class="mtc-input" rows="1" maxlength="${MAX_DRAFT_CHARS}" placeholder="${esc(T('placeholder'))}" aria-label="${esc(T('placeholder'))}" aria-controls="mtc-hints" aria-expanded="false" spellcheck="true"></textarea>
          <button type="submit" class="mtc-send" aria-label="${esc(T('send'))}" data-mode="send" disabled>${SVG.send}</button>
        </div></div>
        <input type="file" class="mtc-file-input" multiple hidden aria-label="${esc(T('attach'))}">
      </form>
      <div class="mtc-footer">
        <div class="mtc-footer-left">
          <a class="mtc-brand-link" href="https://docs.maritaca.ai" target="_blank" rel="noopener noreferrer" title="${esc(T('settingsDocs'))}" aria-label="${esc(T('settingsDocs'))}">${ICON}</a>
          <button type="button" class="mtc-icon-btn mtc-attach" title="${esc(T('attach'))}" aria-label="${esc(T('attach'))}">${ICONS.attach}</button>
          <span class="mtc-status-line" aria-live="polite"></span>
        </div>
        <div class="mtc-footer-right">
          <div class="mtc-effort-wrap">
            <button type="button" class="mtc-toolbar-toggle mtc-effort-toggle" id="mtc-effort-toggle" data-effort="off" aria-haspopup="menu" aria-expanded="false" aria-controls="mtc-effort-menu" aria-label="${esc(T('effortMenu'))}" data-tooltip="${esc(T('effortMenu'))}">${ICONS.brain}<span class="mtc-btn-label">${esc(T('effortLabel'))}</span><span class="mtc-effort-dots" aria-hidden="true"><i></i><i></i><i></i></span></button>
            <div class="mtc-effort-menu" id="mtc-effort-menu" role="menu" aria-label="${esc(T('effortMenu'))}" hidden></div>
          </div>
          <button type="button" class="mtc-toolbar-toggle mtc-plan-toggle" id="mtc-plan-toggle" aria-pressed="false" aria-label="${esc(T('planToggleOff'))}" data-tooltip="${esc(T('planToggleOff'))}">${ICONS.plan}<span class="mtc-btn-label">${esc(T('plan'))}</span></button>
          ${dropdownHTML('mtc-model', [{ value: '', label: T('modelDefault'), selected: true }], { label: T('model'), classes: 'mtc-model-dd' })}
        </div>
      </div>
      <div class="mtc-composer-meta"><span class="mtc-cost-pill mtc-conversation-cost" hidden></span></div>
    </div>`;
  return panel;
}

function setVisible(next) { setSidepanelVisible(PANEL_OWNER, next); }
function applyVisibility(next) {
  if (!_panel) return;
  _visible = !!next;
  _panel.classList.toggle('open', _visible);
  _scroll?.setActive(_visible);
  if (!_visible) { closePop(); closeSettings({ focus: false }); closeEffortMenu(); }
  renderPills();
  emit('maritaca-panel:visibility', _visible);
  if (_visible) {
    state.lastActivePanel = 'maritaca';
    if (!_tabs.length) createTab();
    renderAll();
    client().open().catch(() => {});
    loadStatus();
    const tab = activeTab();
    if (tab?.sessionId && !runtimeOf(tab).transcript.loaded) loadSession(tab).catch(() => {});
    $('.mtc-input')?.focus();
  }
  window.dispatchEvent(new Event('resize'));
}

function ensurePanel() {
  if (_panel) return;
  setMaritacaTranslator((key, params) => { try { return t(key, params); } catch { return key; } });
  injectMaritacaStyles();
  ensureMarked();
  _panel = buildPanel();
  document.body.appendChild(_panel);
  registerSidepanel({ owner: PANEL_OWNER, provider: 'maritaca', element: _panel, header: $('.mtc-header'), actions: $('.mtc-actions'), buttonClass: 'mtc-btn', dockHandle: $('.mtc-resize-handle'), applyVisibility });
  loadTabs();
  wire();
  renderAll();
  on('maritaca-panel:show', ({ tabId } = {}) => {
    const idx = _tabs.findIndex((tab) => tab.id === tabId);
    if (!_visible) setVisible(true);
    if (idx >= 0) switchTab(idx);
  });
  window.dispatchEvent(new CustomEvent('sidepanel-tray:provider-loaded', { detail: { provider: 'maritaca' } }));
  ensureProjects();
  if (_tabs.some((tab) => tab.sessionId)) client().open().catch(() => {});
}

// ── Public API ──
export function isMaritacaPanelOpen() { return _visible; }
export function bootMaritacaPanel() { ensurePanel(); }
export async function toggleMaritacaPanel() {
  ensurePanel();
  if (_visible) { setVisible(false); return; }
  setVisible(true);
  await ensureProjects();
}
/** Opens the panel with text in the composer; `newTab` in a tab of its own; `send` sends it at once. → false when no tab could be made. */
export async function openMaritacaWithPrompt(text = '', { newTab: wantNew = false, send: sendNow = false, model = null } = {}) {
  ensurePanel();
  await ensureProjects();
  if (!_visible) setVisible(true);
  if (wantNew) {
    const busy = activeTab();
    const reuse = busy && !busy.sessionId && !busy.running && !runtimeOf(busy).transcript.rows.length && !$('.mtc-input')?.value;
    if (!reuse && !createTab()) return false;
  }
  const input = $('.mtc-input');
  if (input && text) { input.value = text; activeTab().draft = text; autosize(); }
  if (model) { activeTab().model = String(model); }
  renderComposer();
  if (sendNow && text) await send();
  return true;
}
export function maritacaPanelDefaults() { return { project: activeTab()?.project || '' }; }
export function endHostedMaritacaSessions() {
  // closeTab intentionally leaves a fresh tab; teardown must consume a fixed snapshot.
  for (const tab of [..._tabs]) {
    if (tab.sessionId) client().request('cancel', { sessionId: tab.sessionId }).catch(() => {});
    tab.pillEl?.remove();
  }
  _tabs = []; _runtime.clear(); _client?.close(); _scroll?.destroy();
  clearInterval(_workingTimer); clearTimeout(_bannerTimer); closePop(); closeSettings({ focus: false }); closeEffortMenu(); saveTabs();
}
export function maritacaPanelPresentation() { try { return getSidepanelPresentation(PANEL_OWNER)?.layout?.mode || 'docked'; } catch { return 'docked'; } }
export const _copyKeys = Object.keys(MTC_COPY);
/** What the panel holds (tests and support): the key status as told, the tabs as saved, the models it knows. Never a key. */
export function maritacaPanelDebug() { return { status: _status, tabs: serializeTabs(_tabs), models: _models.map((m) => m.id), blocked: _blocked, hello: !!_hello }; }
