// ═══════════════════════════════════════════
// SynaBun — Antigravity side panel
// ═══════════════════════════════════════════
//
// Google Antigravity (`agy`) in a side panel, on par with the Claude Code, Codex and OpenCode panels: tabs (one ACP
// session each, in a project folder and any extra folders), streamed replies and thoughts, tool calls with their
// output, live terminal output and diffs, the agent's plan, permission and question cards, model / thinking / mode
// pickers and every other option the session offers (Session settings), the agent's own slash commands beside the
// panel's, @ files, attachments (paste, drop, pick, voice), a queue while a turn runs, Copy and Retry, the session
// list (resume, rename, fork and delete where the agent supports them), three output detail levels, notifications,
// and the tab a dispatched run of the Assistant shows itself in. When the CLI is missing the panel installs it
// (Homebrew's cask or Google's installer, through /api/cli/install), walks through sign-in and connects.
// The server end is /ws/antigravity (lib/antigravity/panel-bridge.js).
//
// What decides lives in DOM-free modules (agy-events.js, agy-options.js, agy-tabs-logic.js, agy-commands.js,
// agy-setup.js, agy-diff.js, agy-client.js) and the HTML in agy-render.js; this file wires. Every string is
// agyText() (agy-copy.js), every dropdown the app's .cc-dropdown.

import { AGY_COPY, agyText, setAntigravityTranslator } from './agy-copy.js';
import { injectAntigravityStyles } from './agy-styles.js';
import { createAntigravityClient } from './agy-client.js';
import {
  addUserMessage, answerOfTurn, applyTerminalOutput, applyUpdate, contextGauge, createTranscript, endTurn, lastPrompt,
  settleOpenTools, turnFooters,
} from './agy-events.js';
import {
  dropdownEntries, elicitationContent, elicitationFields, modeEntries, optionByCategory, permissionCard, quickOption,
  secondaryOptions, toggledValue, withValue,
} from './agy-options.js';
import {
  attachmentProblem, attachmentType, automationEvent, MAX_TABS, newTab, openSessionRequest, promptRequest, restoreTabs, runGeminiDir, serializeTabs, sessionLoadNotice, stagedPicture, tabLabel,
} from './agy-tabs-logic.js';
import { applyMention, DETAIL_LEVELS, joinProjectPath, mentionAt, PANEL_COMMANDS, relativeToProject, resolveSlash, slashInsert, slashMenu } from './agy-commands.js';
import { blockedReasonKey, setupView } from './agy-setup.js';
import { diffView } from './agy-diff.js';
import { autoAnswerRow, bypassControl, pickPermission } from './agy-bypass.js';
import {
  contextWords, elicitationHtml, emptyHtml, esc, ICONS, permissionHtml, rowHtml, setupHtml, turnFooterHtml,
} from './agy-render.js';
import { t } from '../i18n.js';
import { storage } from '../storage.js';
import { state, emit, on } from '../state.js';
import { registerSidepanel, setSidepanelVisible, sidepanelAcceptsKeyboard, focusSidepanel, openAnotherSidepanelSession, getSidepanelPresentation, isHostedSessionFocused } from '../ui-sidepanel-windows.js';
import { hostedSidepanelId } from '../ui-sidepanel-runtime.js';
import { dropdownHTML, setDropdownDisabled, setDropdownItems, wireDropdowns, closeDropdowns } from '../cc-dropdown.js';
import { renderMarkdown } from '../cp/cp-markdown.js';
import { fetchProjects } from '../api.js';
import { createCliInstallController } from '../cli-install-controller.js';
import { setCliInstallTranslator } from '../cli-install-view.js';
import { workerRestart } from '../worker-restart.js';
import { endWorkerRunOnClose, forgetWorkerEnd, trackWorkerEnd } from '../ui-worker-end.js';
import { nativeLoopWindowId } from '../ui-native-window-id.js';
import { runAwaitsAnswer } from '../sidepanel-session-status.js';
import { wireFileLinks } from '../ui-file-links.js';
import { notify, NOTIF_TYPE } from '../ui-notifications.js';
import { forgetGreeting, mountGreeting } from '../greeting/greeting-card.js';

export const PANEL_OWNER = 'antigravity-sidepanel';
const ICON = ICONS.mark;
const SVG = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  queue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h9"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
};

// ── Window identity and storage ──
export const windowId = hostedSidepanelId || sessionStorage.getItem('agy-window-id') || (() => {
  const id = globalThis.crypto?.randomUUID?.() || `agy-${Date.now()}`;
  sessionStorage.setItem('agy-window-id', id);
  return id;
})();
const STOR = {
  tabs: `synabun-antigravity-panel-tabs-${windowId}`,
  project: 'synabun-antigravity-panel-project',
  prefs: 'synabun-antigravity-panel-prefs',
  names: 'synabun-antigravity-session-names',
};
const MAX_QUEUE = 20;
const MAX_FOLDERS = 8;

let _panel = null;
let _visible = false;
let _client = null;
let _tabs = [];
let _activeIdx = 0;
let _projects = [];
let _marked = null;
let _pop = null;            // { el, kind, anchor, cleanup }
let _renderQueued = false;
let _hints = null;          // { kind: 'slash' | 'mention', items, active, mention }
let _mentionSeq = 0;
let _recorder = null;
let _workingTimer = null;
const _mdCache = new Map();
const _runtime = new Map(); // tab id → see runtimeOf
const _setup = { controller: null, view: null, ran: false, connecting: false, dismissed: false, nudge: false, logOpen: false };
const _conn = { phase: 'idle', reason: null, message: '', waitMs: 0, opened: false };

const readJson = (key, fallback) => { try { const value = JSON.parse(storage.getItem(key) || 'null'); return value ?? fallback; } catch { return fallback; } };
let _prefs = { detail: 'standard', clientFs: false, clientTerminal: false, ...readJson(STOR.prefs, {}) };
if (!DETAIL_LEVELS.includes(_prefs.detail)) _prefs.detail = 'standard';
let _names = readJson(STOR.names, {});
if (!_names || typeof _names !== 'object' || Array.isArray(_names)) _names = {};

const $ = (selector) => _panel?.querySelector(selector) || null;
const activeTab = () => _tabs[_activeIdx] || null;
const tabBySession = (sessionId) => _tabs.find((tab) => tab.sessionId === sessionId) || null;
const T = agyText;

function runtimeOf(tab) {
  if (!tab) return null;
  if (!_runtime.has(tab.id)) {
    _runtime.set(tab.id, {
      transcript: createTranscript(), configOptions: [], modes: null, models: null, permissions: new Map(), elicitations: new Map(),
      staged: [], loaded: false, openedInPanel: false, loading: null, creating: null, auth: null, notice: null, scrolledUp: false,
      opened: new Set(), closed: new Set(), fullDiffs: new Set(), folds: new Map(), queue: [], queuePaused: false, elicitDrafts: {},
      additionalDirectories: null,
      // The greeting (offerGreeting): `fresh` a session this page started (it has no history of its own),
      // `greeting` the one on screen until the first prompt carries its id.
      fresh: false, greeting: null,
    });
  }
  return _runtime.get(tab.id);
}

function savePrefs() { try { storage.setItem(STOR.prefs, JSON.stringify(_prefs)); } catch { /* the choice stays for this page */ } }
function saveNames() { try { storage.setItem(STOR.names, JSON.stringify(_names)); } catch { /* storage full */ } }

/** The tab's title: a name given here, the session's own title, else a short id. */
function titleOf(tab) {
  const named = tab?.sessionId ? _names[tab.sessionId] : '';
  return tabLabel({ ...tab, title: tab?.titleByUser || named || tab?.title || null }, { newSession: T('newSession'), run: T('automation') });
}

// What the agent can do, from the hello (the bridge's sanitized agentCapabilities, or the older raw fields).
function agentCaps() {
  const hello = _client?.hello || {};
  const caps = hello.agentCapabilities || {};
  const session = caps.sessionCapabilities || hello.sessionCapabilities || {};
  const has = (key) => !!session && session[key] !== undefined && session[key] !== null && session[key] !== false;
  const supports = (capability) => !!_client?.supports(capability);
  return {
    resume: has('resume') && supports('session-resume'),
    fork: has('fork') && supports('session-fork'),
    remove: has('delete') && supports('session-delete'),
    list: has('list') || supports('session-list'),
    folders: has('additionalDirectories') && supports('additional-directories'),
    logout: !!(caps.auth?.logout ?? hello.agentCapabilities?.auth?.logout) || supports('logout') || supports('auth'),
    audio: !!(caps.promptCapabilities?.audio ?? hello.promptCapabilities?.audio) && supports('audio'),
    image: !!(caps.promptCapabilities?.image ?? hello.promptCapabilities?.image),
    restart: supports('agent-restart'),
    clientFs: supports('client-fs'),
    clientTerminal: supports('client-terminal'),
    elicitation: supports('elicitation'),
    bypass: supports('bypass'),
  };
}
const capAvailable = (need) => (need === 'fork' ? agentCaps().fork : need === 'logout' ? agentCaps().logout : true);

// ── Markdown (the vendored marked, as the other panels load it) ──
function ensureMarked() {
  if (_marked || typeof window === 'undefined') return;
  import('/vendor/marked/marked-14.1.4.esm.js')
    .then((mod) => {
      _marked = mod?.marked || mod?.default || null;
      _marked?.setOptions?.({ breaks: true, gfm: true });
      _mdCache.clear();
      scheduleRender();
    })
    .catch(() => {});
}
function md(text) {
  const key = String(text ?? '');
  const hit = _mdCache.get(key);
  if (hit !== undefined) return hit;
  const html = renderMarkdown(key, { parse: _marked ? (src) => _marked.parse(src) : null });
  _mdCache.set(key, html);
  if (_mdCache.size > 400) _mdCache.delete(_mdCache.keys().next().value);
  return html;
}

// ── Saving ──
function saveTabs() {
  try { storage.setItem(STOR.tabs, JSON.stringify(serializeTabs(_tabs, _activeIdx))); } catch { /* storage full: the tabs stay in this page */ }
  renderPills();
}
function loadTabs() {
  const { tabs, activeIdx } = restoreTabs(storage.getItem(STOR.tabs));
  _tabs = tabs;
  _activeIdx = activeIdx;
}

// ── The socket ──
function helloPayload() {
  return { clientCapabilities: { fs: !!_prefs.clientFs, terminal: !!_prefs.clientTerminal } };
}

function client() {
  if (_client) return _client;
  _client = createAntigravityClient({ helloPayload });
  _client.on('session:update', ({ sessionId, update, replay }) => {
    const tab = tabBySession(sessionId);
    if (!tab) return;
    const rt = runtimeOf(tab);
    const changed = applyUpdate(rt.transcript, update, { replay });
    if (update?.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) { rt.configOptions = update.configOptions; renderPickers(); }
    if (update?.sessionUpdate === 'current_mode_update' && rt.modes) { rt.modes = { ...rt.modes, currentModeId: update.currentModeId }; renderPickers(); }
    if (update?.sessionUpdate === 'session_info_update' && rt.transcript.title && rt.transcript.title !== tab.title) { tab.title = rt.transcript.title; saveTabs(); renderTabs(); renderHeader(); }
    if (update?.sessionUpdate === 'usage_update') renderCog();
    if (changed) scheduleRender(tab);
  });
  _client.on('permission:request', (message) => {
    const tab = tabBySession(message.sessionId);
    if (!tab) return;
    const rt = runtimeOf(tab);
    rt.permissions.set(message.requestId, { ...message, card: permissionCard(message), state: 'open' });
    tab.needsYou = true;
    saveTabs();
    renderTabs();
    scheduleRender(tab, { follow: true });
    notifyAsk(tab);
  });
  // Bypass answered a request itself (lib/antigravity/bypass.js): a line in the transcript says what and why.
  _client.on('permission:auto', (message) => {
    const tab = tabBySession(message.sessionId);
    if (!tab) return;
    const row = autoAnswerRow(message, T);
    runtimeOf(tab).transcript.rows.push({ id: `b${message.requestId || Date.now()}`, kind: 'notice', text: row.text, severity: row.severity });
    scheduleRender(tab, { follow: true });
  });
  _client.on('permission:resolved', ({ requestId, sessionId, outcome }) => {
    const tab = tabBySession(sessionId);
    if (!tab) return;
    const rt = runtimeOf(tab);
    const entry = rt.permissions.get(requestId);
    if (entry && (entry.state === 'open' || entry.state === 'answering')) entry.state = outcome?.outcome === 'cancelled' ? 'cancelled' : 'answered';
    refreshNeedsYou(tab);
    scheduleRender(tab);
  });
  _client.on('elicitation:request', (message) => {
    // A question tied to no session (one asked during sign-in) is shown in the active tab.
    const tab = message.sessionId ? tabBySession(message.sessionId) : activeTab();
    if (!tab) return;
    runtimeOf(tab).elicitations.set(message.requestId, { ...message, state: 'open', errors: {} });
    tab.needsYou = true;
    saveTabs();
    renderTabs();
    scheduleRender(tab, { follow: true });
    notifyAsk(tab);
  });
  _client.on('elicitation:resolved', ({ requestId, sessionId, action }) => {
    const tab = tabBySession(sessionId) || _tabs.find((entry) => runtimeOf(entry).elicitations.has(requestId));
    if (!tab) return;
    const entry = runtimeOf(tab).elicitations.get(requestId);
    if (entry && entry.state !== 'answered' && entry.state !== 'declined') entry.state = action === 'accept' || action === 'complete' ? 'answered' : action === 'decline' ? 'declined' : 'cancelled';
    refreshNeedsYou(tab);
    scheduleRender(tab);
  });
  _client.on('terminal:output', (message) => {
    const tab = tabBySession(message.sessionId);
    if (!tab) return;
    if (applyTerminalOutput(runtimeOf(tab).transcript, message)) scheduleRender(tab);
  });
  _client.on('turn:end', ({ sessionId, stopReason, usage, error }) => {
    const tab = tabBySession(sessionId);
    if (!tab) return;
    const rt = runtimeOf(tab);
    if (!rt.transcript.running && !tab.running) return;
    endTurn(rt.transcript, { stopReason, usage, error });
    settleOpenTools(rt.transcript);
    tab.running = false;
    // The turn is over: its answered requests go (the tool cards say what happened); one still open was cancelled.
    for (const [id, entry] of rt.permissions) if (entry.state !== 'open') rt.permissions.delete(id); else entry.state = 'cancelled';
    for (const [id, entry] of rt.elicitations) if (entry.state !== 'open') rt.elicitations.delete(id); else entry.state = 'cancelled';
    refreshNeedsYou(tab);
    scheduleRender(tab);
    notifyOutcome(tab, stopReason === 'error' ? NOTIF_TYPE.ERROR : NOTIF_TYPE.DONE);
    drainQueue(tab);
  });
  _client.on('agent:exit', ({ error, signal, code, geminiDir = null }) => {
    for (const tab of _tabs) {
      if (geminiDir ? tab.geminiDir !== geminiDir : !!tab.geminiDir) continue;
      const rt = runtimeOf(tab);
      rt.loaded = false;
      if (tab.running && !tab.automationRunId) {
        endTurn(rt.transcript, { stopReason: 'error', error: { message: T('agentStopped', { detail: error ? `: ${error}` : signal ? ` (${signal})` : code ? ` (exit ${code})` : '' }) } });
        settleOpenTools(rt.transcript);
        tab.running = false;
      }
      for (const entry of rt.permissions.values()) if (entry.state === 'open') entry.state = 'cancelled';
      for (const entry of rt.elicitations.values()) if (entry.state === 'open') entry.state = 'cancelled';
      tab.needsYou = false;
    }
    saveTabs();
    renderTabs();
    scheduleRender();
  });
  _client.on('disconnected', ({ opened } = {}) => {
    for (const tab of _tabs) runtimeOf(tab).loaded = false;
    if (opened) _conn.phase = 'retrying';
    else if (_conn.phase !== 'blocked') _conn.phase = _conn.opened ? 'retrying' : 'connecting';
    renderBanner();
    renderComposer();
  });
  _client.on('retrying', ({ waitMs }) => { if (_conn.phase !== 'blocked') { _conn.phase = 'retrying'; _conn.waitMs = waitMs; renderBanner(); } });
  _client.on('offline', () => { _conn.phase = 'offline'; renderBanner(); });
  _client.on('blocked', ({ reason, message }) => {
    _conn.phase = 'blocked';
    _conn.reason = reason;
    _conn.message = message || '';
    renderBanner();
    renderComposer();
  });
  _client.on('connected', (hello) => {
    _conn.phase = 'connected';
    _conn.opened = true;
    _conn.reason = null;
    onHello(hello);
  });
  return _client;
}

// The hello says whether `agy acp` runs. A missing CLI is the setup card's (tool-versions says so too); any other
// failure to start is "failed to start" with its words. Never a second notice in the transcript.
function onHello(hello) {
  const ctl = setupController();
  if (hello?.running === false && hello?.cliMissing) {
    if (ctl && ctl.view().kind === 'hidden') ctl.recheck();
  } else if (hello?.running === false && hello?.error?.message) {
    ctl?.flagFailure(hello.error.message);
  }
  if (hello?.running) _setup.connecting = false;
  renderBanner();
  renderAll();
  // A session that was open before the socket dropped (or before an install) comes back.
  const tab = activeTab();
  if (hello?.running && tab && !tab.automationRunId && (tab.sessionId ? !runtimeOf(tab).loaded : _setup.ran)) {
    ensureSession(tab).catch(() => {});
  }
}

function refreshNeedsYou(tab) {
  const rt = runtimeOf(tab);
  tab.needsYou = [...rt.permissions.values()].some((p) => p.state === 'open') || [...rt.elicitations.values()].some((e) => e.state === 'open');
  saveTabs();
  renderTabs();
}

// ── Notifications (Settings → Notifications decides which reach the user) ──
function seenNow(tab) {
  return _visible && tab === activeTab() && !document.hidden;
}
function notifyOutcome(tab, type) {
  if (tab.automationRunId || seenNow(tab)) return;
  try { notify('panel', type, titleOf(tab), { panel: 'antigravity', provider: 'antigravity', tabId: tab.id }); } catch { /* notifications are optional */ }
}
function notifyAsk(tab) {
  if (tab.automationRunId || seenNow(tab)) return;
  try { notify('panel', NOTIF_TYPE.ASK, titleOf(tab), { panel: 'antigravity', provider: 'antigravity', tabId: tab.id }); } catch { /* optional */ }
}

// ── The CLI and sign-in (the setup card) ──
function setupController() {
  if (_setup.controller || typeof window === 'undefined') return _setup.controller;
  setCliInstallTranslator((key, params) => { try { return t(`cliInstall.${key}`, params); } catch { return key; } });
  try {
    _setup.controller = createCliInstallController({
      toolKey: 'antigravity',
      onChange: (view) => {
        const before = _setup.view?.kind;
        _setup.view = view;
        // The CLI became usable after it was missing or broken: start the agent and go on to sign-in.
        if (view.kind === 'hidden' || view.kind === 'done' || view.kind === 'path') {
          if (before && ['missing', 'installing', 'failed', 'broken'].includes(before)) connectAfterInstall();
        }
        scheduleRender();
        renderComposer();
      },
    });
  } catch { _setup.controller = null; }
  return _setup.controller;
}

function currentSetup() {
  if (_setup.dismissed && !(_setup.view?.blocked)) return { show: false };
  const tab = activeTab();
  const rt = runtimeOf(tab);
  return setupView({
    cli: _setup.view,
    hello: _client?.hello || null,
    auth: rt?.auth || null,
    installed: !!(_client?.hello?.running),
    ran: _setup.ran,
    connecting: _setup.connecting,
  });
}

async function connectAfterInstall() {
  _setup.connecting = true;
  // A restarted agent has none of this socket's sessions open: every tab opens its own again.
  for (const tab of _tabs) runtimeOf(tab).loaded = false;
  scheduleRender();
  try {
    if (agentCaps().restart) await client().refreshHello('agent:restart', helloPayload());
    else await client().refreshHello('hello', helloPayload());
  } catch { /* the hello's own result says what happened */ }
  finally {
    _setup.connecting = false;
    scheduleRender();
  }
}

async function runSetupAction(action) {
  const ctl = setupController();
  if (!ctl) return;
  if (action === 'install') {
    _setup.ran = true;
    _setup.dismissed = false;
    const final = await ctl.install();
    if (final?.ok) await connectAfterInstall();
    return;
  }
  if (action === 'recheck') { await ctl.recheck(); if (_client?.hello && !_client.hello.running) connectAfterInstall(); return; }
  if (action === 'path') { await ctl.addPath(); return; }
  if (action === 'dismiss') { _setup.dismissed = true; _setup.ran = false; ctl.clearDone(); scheduleRender(); return; }
  if (action === 'copy') {
    const command = currentSetup().command;
    if (command) { try { await navigator.clipboard.writeText(command); flashCopied($('.agy-command-copy span')); } catch { /* no clipboard */ } }
    return;
  }
  if (action === 'signin-check') {
    const tab = activeTab();
    const rt = runtimeOf(tab);
    if (rt) rt.auth = null;
    scheduleRender();
    try { await ensureSession(tab); } catch { /* ensureSession set rt.auth again when it is still needed */ }
  }
}

function flashCopied(el) {
  if (!el) return;
  const before = el.textContent;
  el.textContent = T('copied');
  setTimeout(() => { if (el.isConnected) el.textContent = before; }, 1400);
}

// ── Sessions ──
async function ensureSession(tab, { load = true } = {}) {
  if (!tab || tab.automationRunId) return null;
  const rt = runtimeOf(tab);
  if (tab.sessionId && rt.loaded) return tab.sessionId;
  const folders = foldersOf(tab);
  if (tab.sessionId && load) {
    if (!rt.loading) {
      rt.loading = (async () => {
        // A transcript already on screen that this panel opened (the socket dropped, the agent restarted):
        // resume it without a replay where the agent can; a finished dispatched run's first takeover loads from its store.
        const resume = rt.openedInPanel && rt.transcript.rows.length > 0 && agentCaps().resume;
        const previousTranscript = rt.transcript;
        if (!resume) rt.transcript = createTranscript();
        rt.notice = resume ? null : { text: T('loadingHistory'), severity: 'info' };
        scheduleRender(tab);
        try {
          if (!tab.geminiDir && tab.releasedRunId && typeof fetch === 'function') {
            try {
              const res = await fetch(`/api/sidepanel-runs/${encodeURIComponent(tab.releasedRunId)}`);
              if (res.ok) {
                const home = runGeminiDir((await res.json())?.run);
                if (home) { tab.geminiDir = home; saveTabs(); }
              }
            } catch { /* best effort */ }
          }
          const req = openSessionRequest(tab, { resume, folders });
          const answer = await client().request(req.type, req.payload);
          rt.configOptions = answer.configOptions || [];
          rt.modes = answer.modes || null;
          rt.models = answer.models || null;
          rt.loaded = true;
          rt.openedInPanel = true;
          rt.notice = null;
          rt.auth = null;
        } catch (error) {
          if (!resume && previousTranscript.rows.length) rt.transcript = previousTranscript;
          rt.notice = sessionLoadNotice(error, T);
          if (error.authRequired) rt.auth = { state: 'needed' };
          throw error;
        } finally {
          rt.loading = null;
          scheduleRender(tab);
          renderPickers();
        }
      })();
    }
    await rt.loading;
    return tab.sessionId;
  }
  if (!tab.project) throw Object.assign(new Error(T('noProject')), { code: 'NO_PROJECT' });
  if (!rt.creating) {
    rt.creating = (async () => {
      try {
        const answer = await client().request('session:new', { cwd: tab.project, tabId: tab.id, ...bypassParam(tab), ...(folders.length ? { additionalDirectories: folders } : {}) });
        tab.sessionId = answer.sessionId;
        tab.geminiDir = null;
        tab.releasedRunId = null;
        rt.fresh = true;
        if (tab.titleByUser) { _names[answer.sessionId] = tab.titleByUser; saveNames(); }
        rt.configOptions = answer.configOptions || [];
        rt.modes = answer.modes || null;
        rt.models = answer.models || null;
        rt.loaded = true;
        rt.openedInPanel = true;
        rt.auth = null;
        if (_setup.ran) { _setup.ran = false; }
        saveTabs();
        renderPickers();
        renderHeader();
        scheduleRender(tab);
        return answer.sessionId;
      } catch (error) {
        if (error.authRequired) { rt.auth = { state: 'needed' }; scheduleRender(tab); }
        throw error;
      } finally {
        rt.creating = null;
      }
    })();
  }
  return rt.creating;
}

function foldersOf(tab) {
  return (Array.isArray(tab?.additionalDirectories) ? tab.additionalDirectories : []).filter((p) => typeof p === 'string' && p && p !== tab.project).slice(0, MAX_FOLDERS);
}

function blockedNow() {
  const setup = currentSetup();
  if (setup.show && ['missing', 'installing', 'failed', 'broken', 'connecting'].includes(setup.stage)) return blockedReasonKey(setup) || 'blockedMissing';
  if (_conn.phase === 'blocked') return 'blockedConnection';
  return '';
}

async function send({ text: given = null, staged: givenStaged = null, fromQueue = false } = {}) {
  const tab = activeTab();
  if (!tab || tab.automationActive) return;
  const input = $('.agy-input');
  const text = given ?? (input?.value || '');
  const rt = runtimeOf(tab);
  const staged = givenStaged ?? rt.staged;
  if (!text.trim() && !staged.length) return;

  // The panel's own commands run here.
  if (!fromQueue && givenStaged === null) {
    const resolved = resolveSlash(text, { agentCommands: rt.transcript.commands, available: capAvailable });
    if (resolved.kind === 'panel' && !staged.length) {
      if (input) { input.value = ''; autosize(); }
      tab.draft = '';
      hideHints();
      await runPanelCommand(resolved.name, resolved.args);
      renderComposer();
      return;
    }
  }

  const blocked = blockedNow();
  if (blocked) { nudgeSetup(); return; }

  // While a turn runs (or a send is still starting its session), a message waits its turn in the queue.
  if ((tab.running || rt.sending) && !fromQueue) {
    if (rt.queue.length >= MAX_QUEUE) { rt.notice = { text: T('queueFull', { count: MAX_QUEUE }), severity: 'warning' }; scheduleRender(tab); return; }
    rt.queue.push({ text, staged: staged.splice(0) });
    if (input) { input.value = ''; autosize(); }
    tab.draft = '';
    hideHints();
    renderQueue();
    renderAttachments();
    renderComposer();
    return;
  }

  // A dispatched run's tab after its run ended: the conversation goes on here, in this window's own Antigravity
  // (its history is Antigravity's, so session/load brings it back), and the run is let go.
  let releasedRunId = null;
  if (tab.automationRunId) {
    releasedRunId = tab.automationRunId;
    tab.releasedRunId = releasedRunId;
    tab.automationRunId = null;
    tab.automationAwaits = false;
    rt.loaded = false;
    rt.openedInPanel = false;
    saveTabs();
    window.dispatchEvent(new CustomEvent('native-loop:dismissed', { detail: { runId: releasedRunId } }));
  }
  // The message is taken now, before the first await: starting a session after a reload spawns agy and takes
  // seconds, and an Enter pressed again meanwhile must not send it a second time (agy folds both into one turn).
  const files = givenStaged ? staged : rt.staged.splice(0);
  const clearedInput = !fromQueue && given === null && !!input;
  if (clearedInput) { input.value = ''; autosize(); }
  if (!fromQueue) tab.draft = '';
  rt.sending = true;
  renderAttachments();
  try {
    if (releasedRunId) {
      try { await endWorkerRunOnClose(releasedRunId, () => {}, { busy: false }); } catch { /* best effort */ }
      forgetWorkerEnd(releasedRunId);
    }
    await ensureSession(tab);
  } catch (error) {
    rt.sending = false;
    if (!error.authRequired) rt.notice = error?.code === 'HOME_PRUNED' ? sessionLoadNotice(error, T) : { text: T('errorPrefix', { message: error.message }), severity: 'error' };
    if (fromQueue) rt.queue.unshift({ text, staged: files });
    else {
      // Nothing was sent: the words and files go back where they were.
      if (!givenStaged) rt.staged.unshift(...files);
      if (clearedInput && !input.value) { input.value = text; tab.draft = text; autosize(); }
      renderAttachments();
    }
    renderComposer();
    scheduleRender(tab);
    return;
  }
  rt.sending = false;
  addUserMessage(rt.transcript, text, files.map((file) => ({ kind: file.mimeType?.startsWith('image/') ? 'image' : 'file', name: file.name, mimeType: file.mimeType, preview: file.mimeType?.startsWith('image/') ? file.dataUrl : '' })));
  rt.transcript.running = true;
  rt.notice = null;
  tab.running = true;
  tab.startedAt = Date.now();
  hideHints();
  saveTabs();
  renderTabs();
  renderAttachments();
  scheduleRender(tab, { follow: true });
  startWorkingClock();
  try {
    const greetingId = takeGreetingId(tab);
    await client().request('prompt', { ...promptRequest(tab, text, files), ...(greetingId ? { greetingId } : {}) });
  } catch (error) {
    if (tab.running) {
      endTurn(rt.transcript, { stopReason: 'error', error: { message: error.message } });
      settleOpenTools(rt.transcript);
      tab.running = false;
      if (error.authRequired) rt.auth = { state: 'needed' };
      saveTabs();
      renderTabs();
      scheduleRender(tab);
    }
  }
}

function drainQueue(tab) {
  const rt = runtimeOf(tab);
  if (!rt.queue.length || rt.queuePaused || tab.running) { renderQueue(); return; }
  const next = rt.queue.shift();
  renderQueue();
  if (tab === activeTab()) send({ text: next.text, staged: next.staged, fromQueue: true });
  else rt.queue.unshift(next);
}

async function stop() {
  const tab = activeTab();
  if (!tab?.sessionId || !tab.running) return;
  try { await client().request('cancel', { sessionId: tab.sessionId }); } catch { /* the turn ends either way */ }
}

async function answerPermission(tab, requestId, optionId) {
  const rt = runtimeOf(tab);
  const entry = rt.permissions.get(requestId);
  if (!entry || entry.state !== 'open') return;
  entry.state = 'answering';
  scheduleRender(tab);
  try {
    await client().request('permission:answer', { requestId, optionId });
  } catch (error) {
    entry.state = 'open';
    rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
  }
  refreshNeedsYou(tab);
  scheduleRender(tab);
}

async function answerElicitation(tab, requestId, action, content = undefined) {
  const rt = runtimeOf(tab);
  const entry = rt.elicitations.get(requestId);
  if (!entry || entry.state !== 'open') return;
  try {
    await client().request('elicitation:answer', { requestId, action, ...(content ? { content } : {}) });
    entry.state = action === 'accept' ? 'answered' : action === 'decline' ? 'declined' : 'cancelled';
    delete rt.elicitDrafts[requestId];
  } catch (error) {
    rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
  }
  refreshNeedsYou(tab);
  scheduleRender(tab);
}

function submitElicitation(tab, form) {
  const requestId = form.dataset.elicitForm;
  const rt = runtimeOf(tab);
  const entry = rt.elicitations.get(requestId);
  if (!entry) return;
  const fields = elicitationFields(entry.requestedSchema);
  const values = readFormValues(form, fields);
  const { content, errors } = elicitationContent(fields, values);
  entry.errors = errors;
  if (Object.keys(errors).length) { scheduleRender(tab); return; }
  answerElicitation(tab, requestId, 'accept', content);
}

function readFormValues(form, fields) {
  const values = {};
  for (const field of fields) {
    const inputs = [...form.querySelectorAll(`[data-field="${CSS.escape(field.name)}"]`)];
    if (field.type === 'boolean') values[field.name] = !!inputs[0]?.checked;
    else if (field.choices.length && field.multiple) values[field.name] = inputs.filter((i) => i.checked).map((i) => i.value);
    else if (field.choices.length) values[field.name] = inputs.find((i) => i.checked)?.value || '';
    else values[field.name] = inputs[0]?.value ?? '';
  }
  return values;
}

async function signIn(tab, methodId) {
  const rt = runtimeOf(tab);
  rt.auth = { state: 'waiting' };
  scheduleRender(tab);
  try {
    await client().request('auth:start', { methodId });
    rt.auth = null;
    rt.notice = null;
    scheduleRender(tab);
    await ensureSession(tab);
  } catch (error) {
    if (!rt.auth || rt.auth.state === 'waiting') rt.auth = { state: 'failed', error: error.message };
    scheduleRender(tab);
  }
}

function openSignInTerminal(tab) {
  emit('terminal:open', { profile: 'antigravity' });
  const rt = runtimeOf(tab);
  if (rt) rt.auth = { state: 'needed', terminal: true };
  scheduleRender(tab);
}

async function signOut() {
  try {
    await client().request('auth:logout', {});
    for (const tab of _tabs) { const rt = runtimeOf(tab); rt.loaded = false; rt.auth = { state: 'needed' }; }
  } catch (error) {
    const rt = runtimeOf(activeTab());
    if (rt) rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
  }
  closePop();
  scheduleRender();
}

async function setConfig(tab, configId, value) {
  const rt = runtimeOf(tab);
  try {
    await ensureSession(tab);
    rt.configOptions = withValue(rt.configOptions, configId, value);
    renderPickers();
    const answer = await client().request('config:set', { sessionId: tab.sessionId, configId, value });
    if (Array.isArray(answer.configOptions) && answer.configOptions.length) rt.configOptions = answer.configOptions;
  } catch (error) {
    if (!error.authRequired) rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
    scheduleRender(tab);
  }
  renderPickers();
  refreshPop();
}
async function setMode(tab, modeId) {
  const rt = runtimeOf(tab);
  try {
    await ensureSession(tab);
    await client().request('mode:set', { sessionId: tab.sessionId, modeId });
    if (rt.modes) rt.modes = { ...rt.modes, currentModeId: modeId };
  } catch (error) {
    if (!error.authRequired) rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
    scheduleRender(tab);
  }
  renderPickers();
  refreshPop();
}
async function setModel(tab, modelId) {
  const rt = runtimeOf(tab);
  try {
    await ensureSession(tab);
    await client().request('model:set', { sessionId: tab.sessionId, modelId });
    if (rt.models) rt.models = { ...rt.models, currentModelId: modelId };
  } catch (error) {
    if (!error.authRequired) rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
    scheduleRender(tab);
  }
  renderPickers();
}

async function forkSession(tab) {
  if (!tab?.sessionId || !agentCaps().fork) return;
  const rt = runtimeOf(tab);
  try {
    const answer = await client().request('session:fork', { sessionId: tab.sessionId, cwd: tab.project, tabId: tab.id, ...(tab.geminiDir ? { geminiDir: tab.geminiDir } : {}) });
    const fork = createTab({ project: tab.project, sessionId: answer.sessionId, title: T('forkTitle', { title: titleOf(tab) }), geminiDir: tab.geminiDir || null });
    if (!fork) return;
    const frt = runtimeOf(fork);
    frt.transcript = structuredCloneTranscript(rt.transcript);
    frt.configOptions = answer.configOptions || [];
    frt.modes = answer.modes || null;
    frt.models = answer.models || null;
    frt.loaded = true;
    frt.openedInPanel = true;
    fork.additionalDirectories = foldersOf(tab);
    saveTabs();
    renderAll();
  } catch (error) {
    rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
    scheduleRender(tab);
  }
}

function structuredCloneTranscript(source) {
  const next = createTranscript();
  for (const row of source.rows) {
    const copy = { ...row, closed: true, attachments: row.attachments ? [...row.attachments] : row.attachments, content: row.content ? [...row.content] : row.content };
    next.rows.push(copy);
    if (copy.kind === 'tool') next.tools.set(copy.toolCallId, copy);
  }
  next.turns = source.turns.map((turn) => ({ ...turn }));
  next.seq = source.seq;
  next.commands = source.commands;
  next.title = source.title;
  next.context = source.context;
  return next;
}

async function deleteSession(sessionId) {
  if (!sessionId || !agentCaps().remove) return false;
  const tabWithHome = _tabs.find((entry) => entry.sessionId === sessionId && entry.geminiDir);
  await client().request('session:delete', { sessionId, ...(tabWithHome?.geminiDir ? { geminiDir: tabWithHome.geminiDir } : {}) });
  delete _names[sessionId];
  saveNames();
  for (let i = _tabs.length - 1; i >= 0; i -= 1) {
    if (_tabs[i].sessionId === sessionId && !_tabs[i].automationRunId) closeTab(i, { closeSession: false });
  }
  return true;
}

function renameTab(tab, name) {
  const value = String(name || '').trim().slice(0, 120);
  tab.titleByUser = value || null;
  if (tab.sessionId) {
    if (value) _names[tab.sessionId] = value; else delete _names[tab.sessionId];
    saveNames();
  }
  saveTabs();
  renderTabs();
  renderHeader();
}

function startRename(tab = activeTab()) {
  if (!tab) return;
  const label = $('.agy-session-label');
  if (!label || label.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = tab.titleByUser || (tab.sessionId && _names[tab.sessionId]) || tab.title || '';
  input.setAttribute('aria-label', T('rename'));
  input.maxLength = 120;
  label.textContent = '';
  label.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) renameTab(tab, input.value); else renderHeader();
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (event) => event.stopPropagation());
}

// ── Panel commands ──
async function runPanelCommand(name, args) {
  const tab = activeTab();
  const rt = runtimeOf(tab);
  switch (name) {
    case 'new': newSessionTab(); break;
    case 'sessions': openSessionsMenu($('.agy-session-btn')); break;
    case 'rename': if (args) renameTab(tab, args); else startRename(tab); break;
    case 'fork': await forkSession(tab); break;
    case 'retry': retryLast(tab); break;
    case 'copy': copyLastAnswer(tab); break;
    case 'model': openPicker('#agy-model'); break;
    case 'mode': openPicker('#agy-mode'); break;
    case 'thinking': openPicker('#agy-thinking'); break;
    case 'detail': {
      const level = DETAIL_LEVELS.includes(args) ? args : DETAIL_LEVELS[(DETAIL_LEVELS.indexOf(_prefs.detail) + 1) % DETAIL_LEVELS.length];
      setDetail(level);
      break;
    }
    case 'settings': openSettingsPop($('.agy-cog')); break;
    case 'login': if (rt) { rt.auth = { state: 'needed' }; scheduleRender(tab); } break;
    case 'logout': await signOut(); break;
    case 'help': if (rt) { rt.notice = { text: helpText(), severity: 'info' }; scheduleRender(tab); } break;
    default: break;
  }
}

function helpText() {
  const panel = PANEL_COMMANDS.filter((c) => !c.needs || capAvailable(c.needs)).map((c) => `/${c.name} — ${T(c.key)}`);
  const agent = (runtimeOf(activeTab())?.transcript.commands || []).map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ''}`);
  return [T('helpPanel'), ...panel, ...(agent.length ? ['', T('helpAgent'), ...agent] : []), '', T('helpKeys')].join('\n');
}

function openPicker(selector) {
  const trigger = $(`${selector}-trigger`);
  if (trigger && !trigger.disabled) { trigger.focus(); trigger.click(); }
}

function setDetail(level) {
  if (!DETAIL_LEVELS.includes(level)) return;
  _prefs.detail = level;
  savePrefs();
  scheduleRender();
  refreshPop();
}

function retryLast(tab) {
  const rt = runtimeOf(tab);
  const last = lastPrompt(rt?.transcript || createTranscript());
  if (!last || tab.running) return;
  send({ text: last.text, staged: [] });
}

async function copyText(text, flashEl = null) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); if (flashEl) flashEl.classList.add('copied'); } catch { /* no clipboard */ }
  if (flashEl) setTimeout(() => flashEl.classList.remove('copied'), 1200);
}

function copyLastAnswer(tab) {
  const rt = runtimeOf(tab);
  const turns = rt?.transcript.turns || [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const answer = answerOfTurn(rt.transcript, turns[i].id);
    if (answer) { copyText(answer); return; }
  }
}

// ── Tabs ──
function createTab({ project = storage.getItem(STOR.project) || _projects[0]?.path || '', sessionId = null, title = null, geminiDir = null, activate = true } = {}) {
  if (_tabs.length >= MAX_TABS) {
    const idle = _tabs.findIndex((tab) => !tab.running && !tab.sessionId && !tab.automationRunId && tab !== activeTab());
    if (idle >= 0) _tabs.splice(idle, 1); else return null;
  }
  const tab = newTab({ project, sessionId, title, geminiDir });
  _tabs.push(tab);
  if (activate) _activeIdx = _tabs.length - 1;
  saveTabs();
  renderAll();
  return tab;
}

function newSessionTab() {
  const current = activeTab();
  if (openAnotherSidepanelSession(PANEL_OWNER, 'antigravity', { project: current?.project || '' })) return;
  // An empty tab is reused rather than stacked.
  if (current && !current.sessionId && !current.running && !current.automationRunId && !runtimeOf(current).transcript.rows.length) {
    current.geminiDir = null;
    current.releasedRunId = null;
    runtimeOf(current).openedInPanel = false;
    $('.agy-input')?.focus();
    return;
  }
  createTab({ project: current?.project || '' });
  $('.agy-input')?.focus();
}

function switchTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const current = activeTab();
  const input = $('.agy-input');
  if (current && input) current.draft = input.value;
  _activeIdx = idx;
  const tab = activeTab();
  if (input) { input.value = tab.draft || ''; autosize(); }
  hideHints();
  saveTabs();
  renderAll();
  if (tab.sessionId && !runtimeOf(tab).loaded && !tab.automationRunId) ensureSession(tab).catch(() => {});
}

function closeTab(idx, { closeSession = true } = {}) {
  const tab = _tabs[idx];
  if (!tab) return;
  if (tab.running && tab.sessionId && !tab.automationRunId) client().request('cancel', { sessionId: tab.sessionId }).catch(() => {});
  if (closeSession && tab.sessionId && !tab.automationRunId) client().request('session:close', { sessionId: tab.sessionId }).catch(() => {});
  if (tab.automationRunId) {
    const runId = tab.automationRunId;
    window.dispatchEvent(new CustomEvent('native-loop:dismissed', { detail: { runId } }));
    endWorkerRunOnClose(runId, () => fetch('/api/loop/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }).catch(() => {}), { busy: !!tab.running });
    forgetWorkerEnd(runId);
  }
  tab.pillEl?.remove();
  _runtime.delete(tab.id);
  _tabs.splice(idx, 1);
  if (_activeIdx >= _tabs.length) _activeIdx = Math.max(0, _tabs.length - 1);
  if (!_tabs.length) {
    saveTabs();
    setVisible(false);
    return;
  }
  saveTabs();
  renderAll();
}

// ── Rendering ──
function scheduleRender(tab = null, { follow = false } = {}) {
  if (tab && tab !== activeTab()) { renderPills(); return; }
  if (follow) { const rt = runtimeOf(activeTab()); if (rt) rt.scrolledUp = false; }
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => {
    _renderQueued = false;
    renderTranscript();
    renderComposer();
    renderCog();
    renderQueue();
  });
}

function renderAll() {
  if (!_panel) return;
  renderHeader();
  renderTabs();
  renderProjectBar();
  renderPickers();
  renderAttachments();
  renderTranscript();
  renderComposer();
  renderBanner();
  renderQueue();
  renderCog();
}

function renderHeader() {
  const label = $('.agy-session-label');
  if (label && !label.querySelector('input')) label.textContent = activeTab() ? titleOf(activeTab()) : T('newSession');
  const btn = $('.agy-session-btn');
  if (btn) btn.title = `${T('sessions')} — ${label?.textContent || ''}`;
  const rename = $('.agy-header-rename');
  if (rename) rename.disabled = !activeTab() || !!activeTab()?.automationRunId;
}

function renderTabs() {
  const strip = $('.agy-tabs');
  if (!strip) return;
  if (_tabs.length < 2) { strip.innerHTML = ''; renderPills(); renderHeader(); return; }
  strip.innerHTML = _tabs.map((tab, idx) => `
    <button type="button" role="tab" class="agy-tab${tab.running ? ' running' : ''}${tab.bypass === true ? ' bypass' : ''}${tab.needsYou || tab.automationAwaits ? ' needs-you' : ''}" aria-selected="${idx === _activeIdx}" data-idx="${idx}" title="${esc(titleOf(tab))}">
      <i class="agy-dot" aria-hidden="true"></i><span class="agy-tab-label">${esc(titleOf(tab))}</span>
      <span class="agy-tab-close" role="button" tabindex="-1" data-close="${idx}" aria-label="${esc(T('closeTab'))}">&times;</span>
    </button>`).join('');
  renderHeader();
  renderPills();
}

function renderProjectBar() {
  const input = $('#agy-project');
  const tab = activeTab();
  if (input) {
    const entries = _projects.map((project) => ({ value: project.path, label: project.label || project.path.split(/[\\/]/).pop(), selected: project.path === tab?.project }));
    if (tab?.project && !entries.some((entry) => entry.value === tab.project)) entries.unshift({ value: tab.project, label: tab.project.split(/[\\/]/).pop() || tab.project, selected: true });
    setDropdownItems(input, entries.length ? entries : [{ value: '', label: T('chooseProject'), selected: true }]);
    setDropdownDisabled(input, !!tab?.automationRunId || !!tab?.running);
  }
  loadBranches(tab?.project || '');
  const chips = $('.agy-folders');
  if (chips) {
    const folders = foldersOf(tab);
    chips.innerHTML = folders.map((path) => `<span class="agy-folder-chip" title="${esc(path)}"><span>${esc(path.split(/[\\/]/).pop() || path)}</span><button type="button" data-folder-remove="${esc(path)}" aria-label="${esc(T('folderRemove', { name: path.split(/[\\/]/).pop() || path }))}">&times;</button></span>`).join('');
  }
  const add = $('.agy-add-folder');
  if (add) {
    add.disabled = !tab || !!tab.automationRunId || foldersOf(tab).length >= MAX_FOLDERS;
    add.hidden = !!_client?.hello && !agentCaps().folders;
  }
}

// The project's git branch, as the Codex panel shows it (GET /api/terminal/branches); a folder that is not a git
// repository hides the picker. Switching runs POST /api/terminal/checkout, never while a turn runs.
let _branchSeq = 0;
async function loadBranches(project) {
  const input = $('#agy-branch');
  if (!input) return;
  const dd = input.nextElementSibling;
  const seq = ++_branchSeq;
  if (!project) { dd?.toggleAttribute('hidden', true); return; }
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(project)}`);
    const data = res.ok ? await res.json() : null;
    if (seq !== _branchSeq) return;
    const branches = Array.isArray(data?.branches) ? data.branches.filter((b) => typeof b === 'string' && b) : [];
    input.dataset.current = data?.current || '';
    dd?.toggleAttribute('hidden', !branches.length);
    if (!branches.length) return;
    setDropdownItems(input, branches.map((b) => ({ value: b, label: b, selected: b === data.current })));
    setDropdownDisabled(input, !!activeTab()?.automationRunId);
  } catch {
    if (seq === _branchSeq) dd?.toggleAttribute('hidden', true);
  }
}

async function switchBranch(branch) {
  const tab = activeTab();
  const input = $('#agy-branch');
  const project = tab?.project || '';
  const previous = input?.dataset.current || '';
  if (!tab || !project || !branch || branch === previous) return;
  const rt = runtimeOf(tab);
  const say = (text, severity = 'info') => { rt.notice = { text, severity }; scheduleRender(tab); };
  if (_tabs.some((entry) => entry.running && entry.project === project)) { say(T('branchStopFirst'), 'warning'); loadBranches(project); return; }
  try {
    const status = await fetch(`/api/git/status?path=${encodeURIComponent(project)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const changes = Array.isArray(status?.changes) ? status.changes.length : 0;
    if (changes && !window.confirm(T('branchConfirm', { from: previous || '—', to: branch, count: changes }))) { loadBranches(project); return; }
    const res = await fetch('/api/terminal/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: project, branch }) });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.ok) throw new Error(result.error || `HTTP ${res.status}`);
    say(T('branchSwitched', { branch: result.branch || branch }));
  } catch (error) {
    say(T('branchFailed', { error: error.message }), 'error');
  }
  loadBranches(project);
}

function renderPickers() {
  renderBypass();
  const tab = activeTab();
  const rt = runtimeOf(tab);
  const model = optionByCategory(rt?.configOptions, 'model');
  const thinking = optionByCategory(rt?.configOptions, 'thought_level');
  const modeOption = optionByCategory(rt?.configOptions, 'mode');
  const modelInput = $('#agy-model');
  const thinkingInput = $('#agy-thinking');
  const modeInput = $('#agy-mode');
  const locked = !tab || !!tab.automationRunId;
  if (modelInput) {
    let entries;
    if (model) entries = dropdownEntries(model);
    else if (Array.isArray(rt?.models?.availableModels) && rt.models.availableModels.length) {
      entries = rt.models.availableModels.filter((m) => m?.modelId).map((m) => ({ value: m.modelId, label: m.name || m.modelId, selected: m.modelId === rt.models.currentModelId, title: m.description || '' }));
    } else entries = [{ value: '', label: T('modelDefault'), selected: true }];
    setDropdownItems(modelInput, entries);
    setDropdownDisabled(modelInput, locked || entries.length < 2);
    modelInput.dataset.configId = model?.id || '';
  }
  if (thinkingInput) {
    const entries = thinking ? dropdownEntries(thinking) : [{ value: '', label: T('thinking'), selected: true }];
    setDropdownItems(thinkingInput, entries);
    setDropdownDisabled(thinkingInput, locked || !thinking);
    thinkingInput.dataset.configId = thinking?.id || '';
    thinkingInput.nextElementSibling?.toggleAttribute('hidden', !thinking);
  }
  if (modeInput) {
    // A mode the agent offers as a config option (category `mode`) wins over the older session modes.
    const entries = modeOption ? dropdownEntries(modeOption) : modeEntries(rt?.modes);
    setDropdownItems(modeInput, entries.length ? entries : [{ value: '', label: T('mode'), selected: true }]);
    setDropdownDisabled(modeInput, locked || !entries.length);
    modeInput.dataset.configId = modeOption?.id || '';
    modeInput.nextElementSibling?.toggleAttribute('hidden', !entries.length);
  }
}

// ── Bypass: the tab's permissions picker, its warning strip and its confirm (agy-bypass.js) ──
// Always stated (the request is built before the socket's hello is known; a server without `bypass` ignores it).
const bypassParam = (tab) => ({ bypass: tab?.bypass === true });
let _bypassConfirmFor = null; // the tab id whose Bypass waits for its confirm
function renderBypass() {
  const tab = activeTab();
  const input = $('#agy-perm');
  const supported = agentCaps().bypass;
  const view = bypassControl({ bypass: tab?.bypass === true, supported }, T);
  if (input) {
    setDropdownItems(input, view.entries);
    setDropdownDisabled(input, !tab || !!tab.automationRunId);
    const dd = input.nextElementSibling;
    if (dd) { dd.dataset.state = view.state; dd.title = view.title; }
  }
  const strip = $('.agy-bypass-strip');
  if (strip) {
    strip.hidden = view.state !== 'bypass';
    strip.textContent = view.waiting ? T('permBypassWaiting') : T('permBypassStrip');
  }
  _panel?.toggleAttribute('data-bypass', view.state === 'bypass');
  const badge = $('.agy-bypass-badge');
  if (badge) { badge.hidden = view.state !== 'bypass'; badge.title = view.title; }
  const confirm = $('.agy-bypass-confirm');
  if (confirm) {
    if (_bypassConfirmFor && _bypassConfirmFor !== tab?.id) _bypassConfirmFor = null;
    confirm.hidden = !_bypassConfirmFor;
  }
}
async function setBypass(tab, on) {
  if (!tab) return;
  const previous = tab.bypass === true;
  tab.bypass = on;
  saveTabs();
  renderTabs();
  renderBypass();
  if (!tab.sessionId || !runtimeOf(tab).loaded || !agentCaps().bypass) return;
  try {
    await client().request('session:bypass', { sessionId: tab.sessionId, on });
  } catch (error) {
    tab.bypass = previous;
    saveTabs();
    const rt = runtimeOf(tab);
    rt.transcript.rows.push({ id: `b${Date.now()}`, kind: 'notice', text: T('permBypassFailed', { error: error.message }), severity: 'error' });
    scheduleRender(tab);
    renderTabs();
    renderBypass();
  }
}

function renderAttachments() {
  const box = $('.agy-staged');
  const rt = runtimeOf(activeTab());
  if (!box) return;
  const staged = rt?.staged || [];
  box.hidden = !staged.length;
  box.innerHTML = staged.map((file, idx) => `<span class="agy-chip" title="${esc(file.path || file.name)}">${file.mimeType?.startsWith('image/') && file.dataUrl ? `<img src="${esc(file.dataUrl)}" alt="">` : ''}<span>${esc(file.name)}</span><button type="button" data-unstage="${idx}" aria-label="${esc(T('attachmentRemove', { name: file.name }))}">&times;</button></span>`).join('');
}

function renderQueue() {
  const box = $('.agy-queue');
  const rt = runtimeOf(activeTab());
  if (!box) return;
  const queue = rt?.queue || [];
  box.hidden = !queue.length;
  if (!queue.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="agy-queue-head"><span>${esc(T('queueTitle'))}<span class="agy-queue-badge">${queue.length}</span></span><span class="agy-queue-actions">`
    + `<button type="button" class="agy-icon-btn" data-queue="pause" aria-pressed="${rt.queuePaused}" title="${esc(T(rt.queuePaused ? 'queueResume' : 'queuePause'))}" aria-label="${esc(T(rt.queuePaused ? 'queueResume' : 'queuePause'))}">${rt.queuePaused ? '&#9654;' : '&#10074;&#10074;'}</button>`
    + `<button type="button" class="agy-icon-btn" data-queue="clear" title="${esc(T('queueClear'))}" aria-label="${esc(T('queueClear'))}">&times;</button></span></div>`
    + queue.map((item, idx) => `<div class="agy-queue-item"><span class="agy-queue-text" title="${esc(item.text)}">${esc(item.text || item.staged.map((f) => f.name).join(', '))}</span><button type="button" class="agy-icon-btn" data-queue-edit="${idx}" title="${esc(T('queueEdit'))}" aria-label="${esc(T('queueEdit'))}">${SVG.edit}</button><button type="button" class="agy-icon-btn" data-queue-remove="${idx}" title="${esc(T('queueRemove'))}" aria-label="${esc(T('queueRemove'))}">&times;</button></div>`).join('');
}

/** innerHTML, keeping the focused field, its selection and what was typed into question forms. */
function replaceKeepingFocus(box, html, rt) {
  const active = document.activeElement;
  const keep = active && box.contains(active) && active.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
  box.innerHTML = html;
  for (const [requestId, values] of Object.entries(rt?.elicitDrafts || {})) {
    const form = box.querySelector(`[data-elicit-form="${CSS.escape(requestId)}"]`);
    if (!form) continue;
    for (const [name, value] of Object.entries(values)) {
      for (const input of form.querySelectorAll(`[data-field="${CSS.escape(name)}"]`)) {
        if (input.type === 'checkbox' || input.type === 'radio') input.checked = Array.isArray(value) ? value.includes(input.value) : input.type === 'checkbox' && !input.name ? !!value : value === input.value;
        else input.value = value;
      }
    }
  }
  if (keep) {
    const again = box.querySelector(`#${CSS.escape(keep.id)}`);
    if (again) { again.focus(); try { if (keep.start !== null && keep.start !== undefined) again.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ } }
  }
}

function renderTranscript() {
  const box = $('.agy-transcript');
  if (!box) return;
  const tab = activeTab();
  const rt = runtimeOf(tab);
  if (!tab || !rt) { box.innerHTML = ''; return; }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const setup = currentSetup();
  const rows = rt.transcript.rows;
  const ctx = {
    T, md, cwd: tab.project, detail: _prefs.detail, running: !!tab.running,
    opened: rt.opened, closed: rt.closed, terminals: rt.transcript.terminals, fullDiffs: rt.fullDiffs, folds: rt.folds,
  };
  const footers = turnFooters(rt.transcript);
  const lastTurnId = rt.transcript.turns.length ? rt.transcript.turns[rt.transcript.turns.length - 1].id : null;
  const parts = [];
  for (const row of rows) {
    parts.push(rowHtml(row, ctx));
    const turn = footers.get(row.id);
    if (turn && !(tab.running && turn.id === lastTurnId)) parts.push(turnFooterHtml(turn, { T, last: turn.id === lastTurnId && !tab.running && !tab.automationRunId, answer: answerOfTurn(rt.transcript, turn.id) }));
  }
  for (const [requestId, entry] of rt.permissions) if (entry.state !== 'gone') parts.push(permissionHtml(requestId, entry, { T, cwd: tab.project }));
  for (const [requestId, entry] of rt.elicitations) parts.push(elicitationHtml(requestId, entry, { T }));
  if (tab.running && _prefs.detail === 'compact' && !rows.some((row) => row.kind === 'thought' && !row.closed)) parts.push(`<div class="agy-system working">${esc(T('working'))}</div>`);
  if (rt.notice) parts.push(`<div class="agy-system${rt.notice.severity === 'error' ? ' error' : rt.notice.severity === 'warning' ? ' warning' : ''}">${esc(rt.notice.text)}</div>`);
  const body = parts.filter(Boolean).join('');
  const setupBlock = setup.show ? setupHtml({ ...setup, logOpen: _setup.logOpen }, { T, centered: !body }) : '';
  if (!body && !setupBlock) {
    // Drawn again only when it changes: the greeting card mounted in it stays (and keeps its disclosure).
    const empty = emptyHtml({ T, project: tab.project });
    const key = `${tab.id}\n${empty}`;
    if (box._agyEmpty !== key || !box.querySelector(':scope > .agy-empty')) { box.innerHTML = empty; box._agyEmpty = key; }
    offerGreeting(tab, box.querySelector(':scope > .agy-empty'));
    return;
  }
  box._agyEmpty = null;
  replaceKeepingFocus(box, setupBlock + body, rt);
  if (_setup.nudge) { box.querySelector('.agy-setup')?.classList.add('agy-nudge'); }
  if (nearBottom || !rt.scrolledUp) box.scrollTop = box.scrollHeight;
  const jump = $('.agy-jump');
  if (jump) jump.hidden = !rt.scrolledUp;
}

function workingSeconds(tab) {
  return tab?.startedAt ? Math.max(0, Math.round((Date.now() - tab.startedAt) / 1000)) : 0;
}

function startWorkingClock() {
  if (_workingTimer) return;
  _workingTimer = setInterval(() => {
    if (!_tabs.some((tab) => tab.running)) { clearInterval(_workingTimer); _workingTimer = null; }
    renderComposer();
  }, 1000);
}

function renderComposer() {
  const tab = activeTab();
  const input = $('.agy-input');
  const sendBtn = $('.agy-send');
  const status = $('.agy-status-line');
  const rt = runtimeOf(tab);
  const running = !!tab?.running;
  const locked = !!tab?.automationActive;
  const blocked = blockedNow();
  _panel?.classList.toggle('agy-blocked', !!blocked);
  if (input) {
    input.disabled = locked;
    input.placeholder = locked ? T('placeholderAutomation') : running ? T('placeholderQueue') : T('placeholder');
  }
  const hasText = !!(input?.value.trim() || rt?.staged.length);
  if (sendBtn) {
    const mode = running && !hasText ? 'stop' : running ? 'queue' : 'send';
    sendBtn.innerHTML = mode === 'stop' ? SVG.stop : mode === 'queue' ? SVG.queue : SVG.send;
    sendBtn.dataset.mode = mode;
    const label = mode === 'stop' ? T('stop') : mode === 'queue' ? T('queueAdd') : blocked ? T(blocked) : T('send');
    sendBtn.setAttribute('aria-label', label);
    sendBtn.title = label;
    sendBtn.disabled = locked || (mode === 'send' && !hasText);
  }
  if (status) {
    const awaits = tab?.needsYou || tab?.automationAwaits;
    let text = '';
    if (locked) text = T('automation');
    else if (awaits) text = T('needsYou');
    else if (running) text = T('workingFor', { seconds: workingSeconds(tab) });
    else if (blocked) text = T(blocked);
    status.textContent = text;
    status.classList.toggle('working', running && !awaits);
    status.classList.toggle('attention', !!awaits);
  }
  const attach = $('.agy-attach');
  if (attach) attach.disabled = locked;
  const mic = $('.agy-mic');
  if (mic) mic.hidden = !agentCaps().audio || typeof MediaRecorder === 'undefined';
}

function renderBanner() {
  const banner = $('.agy-banner');
  if (!banner) return;
  const tab = activeTab();
  let html = '';
  let tone = '';
  if (_conn.phase === 'blocked') {
    const key = { automation: 'connAutomation', guest: 'connGuest', restart: 'connRestart' }[_conn.reason] || 'connRefused';
    tone = 'err';
    html = `<span class="agy-banner-text">${esc(T(key))}${_conn.message && _conn.reason === 'refused' ? ` <span class="agy-visually-hidden">${esc(_conn.message)}</span>` : ''}</span><button type="button" class="agy-action" data-conn="retry">${esc(T('connRetry'))}</button>`;
  } else if (_conn.phase === 'retrying' || _conn.phase === 'offline') {
    tone = 'warn';
    html = `<span class="agy-banner-text">${esc(T(_conn.phase === 'offline' ? 'connOffline' : 'disconnected'))}</span><button type="button" class="agy-action" data-conn="retry">${esc(T('connRetryNow'))}</button>`;
  } else if (tab?.automationRunId) {
    tone = '';
    html = `<span class="agy-banner-text">${esc(tab.automationActive ? T('automationBanner') : T('automationEnded'))}</span>`;
  }
  banner.hidden = !html;
  banner.dataset.tone = tone;
  banner.innerHTML = html;
}

function renderCog() {
  const dot = $('.agy-cog-dot');
  const g = contextGauge(runtimeOf(activeTab())?.transcript);
  if (dot) {
    dot.hidden = !g || g.percent < 80;
    dot.classList.toggle('critical', !!g && g.percent >= 90);
  }
  const cog = $('.agy-cog');
  if (cog) cog.title = g ? `${T('settingsTitle')} — ${T('context', { label: contextWords(g, T) })}` : T('settingsTitle');
  if (_pop?.kind === 'settings') refreshPop();
}

function autosize() {
  const input = $('.agy-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(180, Math.max(24, input.scrollHeight))}px`;
}

function nudgeSetup() {
  _setup.nudge = true;
  scheduleRender();
  setTimeout(() => { _setup.nudge = false; }, 600);
  $('.agy-banner:not([hidden])')?.classList.add('agy-nudge');
}

// ── Hints: slash commands and @ files ──
function hideHints() {
  _hints = null;
  const box = $('.agy-hints');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  $('.agy-input')?.removeAttribute('aria-activedescendant');
}

function drawHints() {
  const box = $('.agy-hints');
  if (!box || !_hints) return;
  if (!_hints.items.length) {
    if (_hints.kind === 'mention' && _hints.loading) { box.hidden = false; box.innerHTML = `<div class="agy-hint-empty">${esc(T('mentionLoading'))}</div>`; return; }
    hideHints();
    return;
  }
  box.hidden = false;
  let lastGroup = '';
  box.innerHTML = _hints.items.map((item, idx) => {
    const group = _hints.kind === 'slash' ? (item.source === 'agent' ? T('hintsAgent') : T('hintsPanel')) : '';
    const head = group && group !== lastGroup ? `<div class="agy-hint-group">${esc(group)}</div>` : '';
    lastGroup = group || lastGroup;
    if (_hints.kind === 'slash') {
      const desc = item.source === 'agent' ? item.description : T(item.key);
      return `${head}<div class="agy-hint${idx === _hints.active ? ' active' : ''}" role="option" id="agy-hint-${idx}" aria-selected="${idx === _hints.active}" data-hint="${idx}"><span class="agy-hint-name">/${esc(item.name)}</span>${item.hint ? `<span class="agy-hint-arg">${esc(item.hint)}</span>` : ''}<span class="agy-hint-desc">${esc(desc || '')}</span></div>`;
    }
    return `<div class="agy-hint${idx === _hints.active ? ' active' : ''}" role="option" id="agy-hint-${idx}" aria-selected="${idx === _hints.active}" data-hint="${idx}"><span class="agy-hint-name">@${esc(item.name)}</span><span class="agy-hint-desc">${esc(item.path)}</span></div>`;
  }).join('');
  $('.agy-input')?.setAttribute('aria-activedescendant', `agy-hint-${_hints.active}`);
  box.querySelector('.agy-hint.active')?.scrollIntoView?.({ block: 'nearest' });
}

function updateHints() {
  const input = $('.agy-input');
  const tab = activeTab();
  const rt = runtimeOf(tab);
  if (!input || !tab) { hideHints(); return; }
  const slash = slashMenu(input.value, { agentCommands: rt.transcript.commands, available: capAvailable });
  if (slash) {
    _hints = { kind: 'slash', items: slash.items, active: 0 };
    drawHints();
    return;
  }
  const mention = mentionAt(input.value, input.selectionStart);
  if (mention && tab.project) {
    const seq = ++_mentionSeq;
    _hints = { kind: 'mention', items: [], active: 0, mention, loading: true };
    drawHints();
    fetchFiles(tab.project, mention.query).then((items) => {
      if (seq !== _mentionSeq || _hints?.kind !== 'mention') return;
      _hints = { kind: 'mention', items, active: 0, mention, loading: false };
      drawHints();
    });
    return;
  }
  hideHints();
}

async function fetchFiles(project, query) {
  try {
    const url = `/api/project-files?${new URLSearchParams({ path: project, search: query || '', recursive: query ? '0' : '1', filesOnly: '1' })}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data?.items) ? data.items : []).filter((item) => item.type === 'file')
      .map((item) => {
        const path = String(item.relativePath || item.path || item.name || '').replace(/^[\\/]+/, '');
        return { name: path.split('/').pop() || path, path };
      }).filter((item) => item.path).slice(0, 20);
  } catch { return []; }
}

function chooseHint(idx) {
  const input = $('.agy-input');
  const tab = activeTab();
  if (!_hints || !input || !tab) return;
  const item = _hints.items[idx];
  if (!item) return;
  if (_hints.kind === 'slash') {
    input.value = slashInsert(item);
    hideHints();
    // A panel command without an argument runs at once.
    if (item.source === 'panel' && !item.hint) { send(); return; }
  } else {
    const next = applyMention(input.value, _hints.mention, item.path);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    const abs = joinProjectPath(tab.project, item.path);
    const rt = runtimeOf(tab);
    if (abs && !rt.staged.some((file) => file.path === abs)) rt.staged.push({ name: item.path, path: abs, mimeType: '' });
    hideHints();
    renderAttachments();
  }
  tab.draft = input.value;
  input.focus();
  autosize();
  renderComposer();
}

// ── Tray pills (shown for tabs with something in them while the panel is closed, or not the active tab) ──
function renderPills() {
  const tray = document.getElementById('term-minimized-tray');
  for (const tab of _tabs) {
    if (!tab.pillEl?.isConnected) {
      if (!tray) continue;
      const pill = document.createElement('div');
      pill.className = 'term-minimized-pill agy-session-pill';
      pill.dataset.tabId = tab.id;
      pill.tabIndex = 0;
      pill.innerHTML = `<span class="term-minimized-pill-icon agy-mark">${ICON}</span><span class="term-minimized-pill-label"></span><button class="term-minimized-pill-close" data-tooltip="${esc(T('closeTab'))}" data-tooltip-pos="top">&times;</button>`;
      const openIt = () => {
        const idx = _tabs.indexOf(tab);
        if (idx < 0) return;
        if (!_visible) setVisible(true);
        switchTab(idx);
        try { focusSidepanel(PANEL_OWNER); } catch { /* not hosted */ }
      };
      pill.addEventListener('click', openIt);
      pill.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openIt(); } });
      pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', (event) => {
        event.stopPropagation();
        const idx = _tabs.indexOf(tab);
        if (idx >= 0) closeTab(idx);
      });
      pill.style.display = 'none';
      tray.appendChild(pill);
      tab.pillEl = pill;
    }
    const label = tab.pillEl.querySelector('.term-minimized-pill-label');
    if (label) label.textContent = titleOf(tab);
    const needsYou = !!(tab.needsYou || tab.automationAwaits);
    tab.pillEl.classList.toggle('agy-pill-attention', needsYou);
    tab.pillEl.classList.toggle('agy-pill-running', !needsYou && !!tab.running);
    const meaningful = !!(tab.sessionId || tab.running || tab.draft || tab.automationRunId || tab.needsYou);
    tab.pillEl.style.display = meaningful && (!_visible || tab !== activeTab()) ? '' : 'none';
  }
}

// ── Popovers (children of <body>, placed from their anchor) ──
function closePop() {
  if (!_pop) return;
  _pop.cleanup?.();
  _pop.el.remove();
  const anchor = _pop.anchor;
  _pop = null;
  anchor?.setAttribute?.('aria-expanded', 'false');
}

function openPop(anchor, kind, html, { wide = false, onClick = null, onInput = null, onChange = null, align = 'left' } = {}) {
  closePop();
  const el = document.createElement('div');
  el.className = `agy-pop${wide ? ' agy-pop-wide' : ''}`;
  el.setAttribute('role', kind === 'settings' ? 'dialog' : 'menu');
  el.setAttribute('aria-label', kind === 'settings' ? T('settingsTitle') : kind === 'sessions' ? T('sessions') : T('folderAdd'));
  el.innerHTML = html;
  document.body.appendChild(el);
  wireDropdowns(el);
  const place = () => {
    const rect = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = align === 'right' ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };
  place();
  const away = (event) => { if (!el.contains(event.target) && !anchor.contains(event.target) && !event.target.closest?.('.cc-dropdown-menu')) closePop(); };
  const keys = (event) => {
    if (event.key === 'Escape') {
      if (closeDropdowns(el, { focus: true, cancel: true })) { event.stopPropagation(); return; }
      event.stopPropagation(); event.preventDefault(); closePop(); anchor.focus?.();
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  window.addEventListener('keydown', keys, true);
  window.addEventListener('resize', place);
  if (onClick) el.addEventListener('click', onClick);
  if (onInput) el.addEventListener('input', onInput);
  if (onChange) el.addEventListener('change', onChange);
  anchor.setAttribute?.('aria-expanded', 'true');
  _pop = {
    el, kind, anchor, place,
    cleanup: () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', keys, true); window.removeEventListener('resize', place); },
  };
  return el;
}

// The session menu: a new session, then Antigravity's conversations in this project (search, rename, delete).
async function openSessionsMenu(anchor) {
  if (!anchor) return;
  if (_pop?.kind === 'sessions') { closePop(); return; }
  const tab = activeTab();
  const listState = { sessions: [], cursor: null, filter: '', confirm: null };
  const draw = () => {
    if (_pop?.kind !== 'sessions') return;
    const list = _pop.el.querySelector('.agy-sess-list');
    const q = listState.filter.toLowerCase();
    const shown = listState.sessions.filter((s) => !q || `${_names[s.sessionId] || ''} ${s.title || ''} ${s.sessionId}`.toLowerCase().includes(q));
    const caps = agentCaps();
    list.innerHTML = shown.length ? shown.map((s) => {
      const name = _names[s.sessionId] || s.title || s.sessionId;
      const when = s.updatedAt ? relativeTime(s.updatedAt) : '';
      const active = s.sessionId === tab?.sessionId;
      if (listState.confirm === s.sessionId) {
        return `<div class="agy-pop-confirm"><span>${esc(T('deleteConfirm', { title: name }))}</span><button type="button" class="agy-action agy-btn-deny" data-sess-delete-yes="${esc(s.sessionId)}">${esc(T('delete'))}</button><button type="button" class="agy-action" data-sess-delete-no="1">${esc(T('cancel'))}</button></div>`;
      }
      return `<div class="agy-pop-row${active ? ' active' : ''}"><button type="button" class="agy-pop-item" role="menuitem" data-sess-open="${esc(s.sessionId)}" data-title="${esc(s.title || '')}"><span class="agy-pop-item-main"><span class="agy-pop-item-title">${esc(name)}</span><span class="agy-pop-item-meta">${esc([when, s.cwd && s.cwd !== tab?.project ? relativeToProject('', s.cwd).split(/[\\/]/).pop() : ''].filter(Boolean).join(' · '))}</span></span></button>`
        + `<span class="agy-pop-row-actions"><button type="button" class="agy-icon-btn" data-sess-rename="${esc(s.sessionId)}" title="${esc(T('rename'))}" aria-label="${esc(T('rename'))}">${SVG.edit}</button>`
        + `${caps.remove ? `<button type="button" class="agy-icon-btn" data-sess-delete="${esc(s.sessionId)}" title="${esc(T('delete'))}" aria-label="${esc(T('delete'))}">${SVG.trash}</button>` : ''}</span></div>`;
    }).join('') : `<div class="agy-pop-note">${esc(listState.loading ? T('sessionsLoading') : listState.error || (tab?.project ? T('sessionsEmpty') : T('noProject')))}</div>`;
    const more = _pop.el.querySelector('.agy-sess-more');
    if (more) more.hidden = !listState.cursor;
  };
  const load = async (cursor = null) => {
    if (!tab?.project) { listState.loading = false; draw(); return; }
    listState.loading = true;
    draw();
    try {
      const answer = await client().request('session:list', { cwd: tab.project, ...(cursor ? { cursor } : {}) });
      listState.sessions = cursor ? [...listState.sessions, ...answer.sessions] : answer.sessions;
      listState.cursor = answer.nextCursor || null;
      listState.error = '';
    } catch (error) {
      listState.error = error.authRequired ? T('signInBody') : T('sessionsFailed', { error: error.message });
    }
    listState.loading = false;
    draw();
  };
  const el = openPop(anchor, 'sessions', `<button type="button" class="agy-pop-item" role="menuitem" data-sess-new="1"><span class="agy-pop-item-main"><span class="agy-pop-item-title">+ ${esc(T('newSession'))}</span></span></button><div class="agy-pop-sep"></div><input type="search" class="agy-pop-search" data-sess-search="1" placeholder="${esc(T('sessionsSearch'))}" aria-label="${esc(T('sessionsSearch'))}"><div class="agy-sess-list" role="group"></div><button type="button" class="agy-pop-item agy-sess-more" hidden><span class="agy-pop-item-main"><span class="agy-pop-item-meta">${esc(T('sessionsMore'))}</span></span></button>`, {
    wide: true,
    onInput: (event) => { if (event.target.matches('[data-sess-search]')) { listState.filter = event.target.value; draw(); } },
    onClick: async (event) => {
      const target = event.target;
      if (target.closest('[data-sess-new]')) { closePop(); newSessionTab(); return; }
      if (target.closest('.agy-sess-more')) { load(listState.cursor); return; }
      const rename = target.closest('[data-sess-rename]');
      if (rename) {
        const id = rename.dataset.sessRename;
        const current = _names[id] || listState.sessions.find((s) => s.sessionId === id)?.title || '';
        const row = rename.closest('.agy-pop-row');
        row.innerHTML = `<input type="text" class="agy-pop-search agy-pop-rename" value="${esc(current)}" maxlength="120" aria-label="${esc(T('rename'))}">`;
        const input = row.querySelector('input');
        input.focus(); input.select();
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            const value = input.value.trim();
            if (value) _names[id] = value; else delete _names[id];
            saveNames();
            for (const t of _tabs) if (t.sessionId === id) t.titleByUser = value || null;
            saveTabs(); renderTabs(); renderHeader(); draw();
          } else if (e.key === 'Escape') { e.preventDefault(); draw(); }
        });
        return;
      }
      const del = target.closest('[data-sess-delete]');
      if (del) { listState.confirm = del.dataset.sessDelete; draw(); return; }
      if (target.closest('[data-sess-delete-no]')) { listState.confirm = null; draw(); return; }
      const yes = target.closest('[data-sess-delete-yes]');
      if (yes) {
        const id = yes.dataset.sessDeleteYes;
        try { await deleteSession(id); listState.sessions = listState.sessions.filter((s) => s.sessionId !== id); listState.error = ''; }
        catch (error) { listState.error = T('errorPrefix', { message: error.message }); }
        listState.confirm = null;
        draw();
        return;
      }
      const open = target.closest('[data-sess-open]');
      if (open) { closePop(); openSession(open.dataset.sessOpen, open.dataset.title || null); }
    },
  });
  el.querySelector('.agy-pop-search')?.focus();
  load();
}

function relativeTime(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.round((at - Date.now()) / 1000);
  const lang = document.documentElement.lang || undefined;
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    const abs = Math.abs(seconds);
    if (abs < 60) return rtf.format(seconds, 'second');
    if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), 'day');
  } catch { /* fall through */ }
  return new Date(at).toLocaleDateString(lang);
}

function openSession(sessionId, title) {
  const current = activeTab();
  const existing = _tabs.findIndex((tab) => tab.sessionId === sessionId);
  if (existing >= 0) { switchTab(existing); return; }
  const reuse = current && !current.sessionId && !current.running && !current.automationRunId && !runtimeOf(current).transcript.rows.length;
  const tab = reuse ? current : createTab({ project: current?.project || '' });
  if (!tab) return;
  tab.sessionId = sessionId;
  tab.title = title || null;
  tab.geminiDir = null;
  tab.releasedRunId = null;
  runtimeOf(tab).loaded = false;
  runtimeOf(tab).openedInPanel = false;
  runtimeOf(tab).transcript = createTranscript();
  saveTabs();
  renderAll();
  ensureSession(tab).catch(() => {});
}

// Session settings: the context window, the session, every option the agent offers, the panel's own settings,
// the account and the versions. Read again each time something it shows changes.
function settingsHtml() {
  const tab = activeTab();
  const rt = runtimeOf(tab);
  const hello = _client?.hello || {};
  const caps = agentCaps();
  const g = contextGauge(rt?.transcript);
  const kv = (label, value, { muted = false, mono = false, raw = false } = {}) => `<div class="agy-kv"><span class="agy-kv-label">${esc(label)}</span><span class="agy-kv-value${muted ? ' muted' : ''}${mono ? ' mono' : ''}">${raw ? value : esc(value)}</span></div>`;
  const hasCompact = (rt?.transcript.commands || []).some((c) => c.name === 'compact');
  const context = `<section class="agy-sec"><div class="agy-sec-head"><span class="agy-sec-title">${esc(T('settingsContext'))}</span>${hasCompact ? `<button type="button" class="agy-action" data-pop="compact"${tab?.running ? ' disabled' : ''}>${esc(T('compact'))}</button>` : ''}</div>`
    + (g ? `<div class="agy-ctx-bar${g.percent >= 90 ? ' critical' : g.percent >= 80 ? ' high' : ''}"><span style="width:${g.percent}%"></span></div>${kv(T('settingsTokens'), contextWords(g, T))}` : kv(T('settingsTokens'), T('contextUnknown'), { muted: true }))
    + '</section>';
  const options = rt?.configOptions || [];
  const optionRows = options.filter((o) => o && (o.type === 'select' || o.type === 'boolean')).map((option) => {
    if (option.type === 'boolean') return `<div class="agy-kv"><span class="agy-kv-label">${esc(option.name || option.id)}</span><button type="button" class="agy-switch" role="switch" aria-checked="${option.currentValue === true}" aria-label="${esc(option.name || option.id)}" data-pop-bool="${esc(option.id)}"${!tab || tab.automationRunId ? ' disabled' : ''}></button></div>${option.description ? `<div class="agy-kv-help">${esc(option.description)}</div>` : ''}`;
    return `<div class="agy-kv"><span class="agy-kv-label">${esc(option.name || option.id)}</span>${dropdownHTML(`agy-opt-${option.id.replace(/[^A-Za-z0-9_-]/g, '_')}`, dropdownEntries(option), { label: option.name || option.id, inputAttrs: `data-pop-select="${esc(option.id)}"`, disabled: !tab || !!tab.automationRunId })}</div>${option.description ? `<div class="agy-kv-help">${esc(option.description)}</div>` : ''}`;
  }).join('');
  const modeRow = !optionByCategory(options, 'mode') && Array.isArray(rt?.modes?.availableModes) && rt.modes.availableModes.length
    ? `<div class="agy-kv"><span class="agy-kv-label">${esc(T('mode'))}</span>${dropdownHTML('agy-opt-mode', modeEntries(rt.modes), { label: T('mode'), inputAttrs: 'data-pop-mode="1"', disabled: !tab || !!tab.automationRunId })}</div>` : '';
  const sessionOptions = `<section class="agy-sec"><div class="agy-sec-head"><span class="agy-sec-title">${esc(T('settingsOptions'))}</span></div>${optionRows || modeRow ? optionRows + modeRow : `<div class="agy-kv-help">${esc(tab?.sessionId ? T('settingsNoOptions') : T('settingsStartSession'))}</div>`}${secondaryOptions(options).length ? '' : ''}</section>`;
  const session = `<section class="agy-sec"><div class="agy-sec-head"><span class="agy-sec-title">${esc(T('settingsSession'))}</span>${tab?.sessionId && caps.fork ? `<button type="button" class="agy-action" data-pop="fork">${esc(T('fork'))}</button>` : ''}</div>`
    + kv(T('settingsSessionId'), tab?.sessionId ? `<button type="button" data-pop="copy-id" title="${esc(T('copy'))}">${esc(tab.sessionId)}</button>` : esc(T('settingsNoSession')), { mono: !!tab?.sessionId, muted: !tab?.sessionId, raw: true })
    + kv(T('project'), tab?.project ? relativeToProject('', tab.project) : T('chooseProject'), { mono: !!tab?.project, muted: !tab?.project })
    + (foldersOf(tab).length ? kv(T('settingsFolders'), foldersOf(tab).map((p) => p.split(/[\\/]/).pop()).join(', ')) : '')
    + kv(T('settingsTurns'), String((rt?.transcript.turns || []).length))
    + '</section>';
  const detailSeg = `<div class="agy-seg" role="group" aria-label="${esc(T('settingsDetail'))}">${DETAIL_LEVELS.map((level) => `<button type="button" data-pop-detail="${level}" aria-pressed="${_prefs.detail === level}">${esc(T(`detail_${level}`))}</button>`).join('')}</div>`;
  const running = _tabs.some((entry) => entry.running);
  const panel = `<section class="agy-sec"><div class="agy-sec-head"><span class="agy-sec-title">${esc(T('settingsPanel'))}</span></div>`
    + `<div class="agy-kv"><span class="agy-kv-label">${esc(T('settingsDetail'))}</span>${detailSeg}</div><div class="agy-kv-help">${esc(T(`detailHelp_${_prefs.detail}`))}</div>`
    + `<div class="agy-kv"><span class="agy-kv-label">${esc(T('settingsClientFs'))}</span><button type="button" class="agy-switch" role="switch" aria-checked="${!!_prefs.clientFs}" aria-label="${esc(T('settingsClientFs'))}" data-pop-cap="clientFs"${!caps.clientFs || running ? ' disabled' : ''}></button></div><div class="agy-kv-help">${esc(T(caps.clientFs ? 'settingsClientFsHelp' : 'settingsNeedsRestart'))}</div>`
    + `<div class="agy-kv"><span class="agy-kv-label">${esc(T('settingsClientTerminal'))}</span><button type="button" class="agy-switch" role="switch" aria-checked="${!!_prefs.clientTerminal}" aria-label="${esc(T('settingsClientTerminal'))}" data-pop-cap="clientTerminal"${!caps.clientTerminal || running ? ' disabled' : ''}></button></div><div class="agy-kv-help">${esc(T(caps.clientTerminal ? 'settingsClientTerminalHelp' : 'settingsNeedsRestart'))}</div>`
    + '</section>';
  const signedIn = hello.running && !(rt?.auth);
  const account = `<section class="agy-sec"><div class="agy-sec-head"><span class="agy-sec-title">${esc(T('settingsAccount'))}</span>${hello.running ? (signedIn && caps.logout ? `<button type="button" class="agy-action" data-pop="logout">${esc(T('signOut'))}</button>` : `<button type="button" class="agy-action" data-pop="login">${esc(T('signIn'))}</button>`) : ''}</div>`
    + kv(T('settingsSignIn'), hello.running ? (rt?.auth ? T('settingsSignedOut') : T('settingsSignedIn')) : T('settingsAgentOff'), { muted: !hello.running })
    + kv(T('settingsMethods'), (hello.authMethods || []).map((m) => m?.name || m?.id).filter(Boolean).join(', ') || '—', { muted: !(hello.authMethods || []).length })
    + '</section>';
  const about = `<section class="agy-sec"><div class="agy-sec-head"><span class="agy-sec-title">${esc(T('settingsAbout'))}</span></div>`
    + kv(T('settingsAgent'), hello.agent ? `${hello.agent.title || hello.agent.name || 'Antigravity'} ${hello.agent.version || ''}`.trim() : '—', { muted: !hello.agent })
    + kv(T('settingsProtocol'), 'ACP', { mono: true })
    + `<div class="agy-kv"><span class="agy-kv-label">${esc(T('settingsLinks'))}</span><span class="agy-kv-value"><a class="agy-setup-guide" href="https://antigravity.google/docs/cli/reference" target="_blank" rel="noopener noreferrer">${esc(T('cliReference'))}</a></span></div>`
    + '</section>';
  return context + session + sessionOptions + panel + account + about;
}

function refreshPop() {
  if (_pop?.kind !== 'settings') return;
  if (_pop.el.querySelector('.cc-dropdown.open')) return; // never redraw under an open menu
  const scroll = _pop.el.scrollTop;
  _pop.el.innerHTML = settingsHtml();
  _pop.el.scrollTop = scroll;
  _pop.place?.();
}

function openSettingsPop(anchor) {
  if (!anchor) return;
  if (_pop?.kind === 'settings') { closePop(); return; }
  openPop(anchor, 'settings', settingsHtml(), {
    wide: true,
    align: 'right',
    onClick: async (event) => {
      const tab = activeTab();
      const action = event.target.closest('[data-pop]')?.dataset.pop;
      if (action === 'compact' && tab && !tab.running) { closePop(); send({ text: '/compact', staged: [] }); return; }
      if (action === 'fork') { closePop(); forkSession(tab); return; }
      if (action === 'copy-id' && tab?.sessionId) { copyText(tab.sessionId); return; }
      if (action === 'logout') { signOut(); return; }
      if (action === 'login') { const rt = runtimeOf(tab); if (rt) rt.auth = { state: 'needed' }; closePop(); scheduleRender(tab); return; }
      const bool = event.target.closest('[data-pop-bool]');
      if (bool && tab && !bool.disabled) {
        const option = (runtimeOf(tab).configOptions || []).find((o) => o.id === bool.dataset.popBool);
        if (option) setConfig(tab, option.id, toggledValue(option));
        return;
      }
      const detail = event.target.closest('[data-pop-detail]');
      if (detail) { setDetail(detail.dataset.popDetail); return; }
      const cap = event.target.closest('[data-pop-cap]');
      if (cap && !cap.disabled) {
        const key = cap.dataset.popCap;
        _prefs[key] = !_prefs[key];
        savePrefs();
        refreshPop();
        try { await client().refreshHello('agent:restart', helloPayload()); } catch (error) {
          const rt = runtimeOf(tab);
          if (rt) { rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' }; scheduleRender(tab); }
        }
        for (const entry of _tabs) runtimeOf(entry).loaded = false;
        if (tab?.sessionId) ensureSession(tab).catch(() => {});
        refreshPop();
      }
    },
    onChange: (event) => {
      const tab = activeTab();
      const target = event.target;
      if (!tab || !target.value) return;
      if (target.dataset.popSelect) setConfig(tab, target.dataset.popSelect, target.value);
      else if (target.dataset.popMode) setMode(tab, target.value);
    },
  });
}

function openFolderMenu(anchor) {
  const tab = activeTab();
  if (!tab || !anchor) return;
  if (_pop?.kind === 'folders') { closePop(); return; }
  const taken = new Set([tab.project, ...foldersOf(tab)]);
  const choices = _projects.filter((p) => !taken.has(p.path));
  openPop(anchor, 'folders', `<div class="agy-pop-note">${esc(T('folderHelp'))}</div>${choices.length ? choices.map((p) => `<button type="button" class="agy-pop-item" role="menuitem" data-folder-add="${esc(p.path)}"><span class="agy-pop-item-main"><span class="agy-pop-item-title">${esc(p.label || p.path.split(/[\\/]/).pop())}</span><span class="agy-pop-item-meta">${esc(p.path)}</span></span></button>`).join('') : `<div class="agy-pop-note">${esc(T('folderNone'))}</div>`}`, {
    onClick: (event) => {
      const add = event.target.closest('[data-folder-add]');
      if (!add) return;
      closePop();
      setFolders(tab, [...foldersOf(tab), add.dataset.folderAdd]);
    },
  });
}

async function setFolders(tab, folders) {
  tab.additionalDirectories = [...new Set(folders)].filter((p) => p && p !== tab.project).slice(0, MAX_FOLDERS);
  saveTabs();
  renderProjectBar();
  const rt = runtimeOf(tab);
  // A session that is open takes the new folders now where the agent can resume with them; otherwise the next one.
  if (tab.sessionId && rt.loaded && agentCaps().resume && !tab.running) {
    rt.loaded = false;
    try { await ensureSession(tab); rt.notice = { text: T('foldersApplied'), severity: 'info' }; }
    catch (error) { rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' }; }
  } else if (tab.sessionId) {
    rt.notice = { text: T('foldersNext'), severity: 'info' };
  }
  scheduleRender(tab);
}

// ── Greeting (shared/greeting/, lib/greeting/) ──
// What SynaBun says when a person comes back and opens a new conversation: one or two sentences in the empty
// state, written by SynaBun ahead of time (the conversation's model never greets). Only for a conversation this page
// started (no history of its own) and never a dispatched run's. Its id goes with the first prompt (`greetingId`,
// while the bridge lists 'greeting'), so the model is told once what was said.
const GREETING_SURFACE = 'antigravity-panel';
function offerGreeting(tab, host) {
  if (!tab || !host || !tab.project || tab.automationRunId || tab.automationActive || tab.releasedRunId) return;
  const rt = runtimeOf(tab);
  if ((tab.sessionId && !rt.fresh) || rt.transcript.rows.length) return;
  const session = tab.id;
  if (host.dataset.greetingFor === session) return;
  host.dataset.greetingFor = session;
  mountGreeting(host, {
    surface: GREETING_SURFACE, session, cwd: tab.project,
    onOpenMemory: (id) => { if (id) emit('memory:open', { id }); },
    isCurrent: () => tab === activeTab() && host.isConnected && !runtimeOf(tab).transcript.rows.length,
  }).then((greeting) => {
    const now = runtimeOf(tab);
    if (now && !now.transcript.rows.length) now.greeting = greeting ? { id: greeting.id, session } : null;
  }).catch(() => { /* a conversation always opens */ });
}
/** The greeting's id for a tab's first prompt, once ('' when it opened with none, or the bridge cannot tell it). */
function takeGreetingId(tab) {
  const rt = runtimeOf(tab);
  const held = rt?.greeting;
  if (!held) return '';
  rt.greeting = null;
  forgetGreeting(GREETING_SURFACE, held.session);
  return _client?.supports('greeting') ? held.id : '';
}

// ── Attachments ──
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
async function stageFiles(files) {
  const tab = activeTab();
  const rt = runtimeOf(tab);
  if (!rt || tab.automationActive) return;
  for (const file of files) {
    const problem = attachmentProblem(file, rt.staged);
    if (problem) { rt.notice = { text: T(problem.key, problem.params), severity: 'warning' }; scheduleRender(tab); continue; }
    try {
      const dataUrl = await readAsDataUrl(file);
      rt.staged.push({ name: file.name || 'pasted', mimeType: attachmentType(file), dataUrl });
    } catch (error) {
      rt.notice = { text: T('errorPrefix', { message: error.message }), severity: 'error' };
    }
  }
  renderAttachments();
  renderComposer();
  scheduleRender(tab);
}

/** A picture from elsewhere in the app (a data URL): staged on the active tab, the panel shown. */
function stagePicture(dataUrl) {
  if (!stagedPicture(dataUrl)) return false;  // not a picture: the panel stays as it is
  if (!_visible) setVisible(true);
  const tab = activeTab() || createTab();
  const rt = runtimeOf(tab);
  if (!rt || tab.automationActive) return false;
  const checked = stagedPicture(dataUrl, rt.staged);
  if (checked.problem) { rt.notice = { text: T(checked.problem.key, checked.problem.params), severity: 'warning' }; scheduleRender(tab); return false; }
  rt.staged.push(checked.file);
  renderAttachments();
  renderComposer();
  scheduleRender(tab);
  $('.agy-input')?.focus();
  return true;
}

// Voice: a recording becomes an audio attachment (only when the agent takes audio).
async function toggleRecording() {
  const mic = $('.agy-mic');
  if (_recorder) { _recorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      _recorder = null;
      mic?.classList.remove('recording');
      mic?.setAttribute('aria-pressed', 'false');
      const type = (recorder.mimeType || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type });
      if (blob.size) await stageFiles([new File([blob], `voice-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${type.split('/')[1] || 'webm'}`, { type })]);
    };
    recorder.start();
    _recorder = recorder;
    mic?.classList.add('recording');
    mic?.setAttribute('aria-pressed', 'true');
  } catch (error) {
    const rt = runtimeOf(activeTab());
    if (rt) { rt.notice = { text: T('micFailed', { error: error.message }), severity: 'warning' }; scheduleRender(); }
  }
}

// ── Building and wiring ──
function buildPanel() {
  const panel = document.createElement('aside');
  panel.className = 'agy-panel';
  panel.setAttribute('aria-label', T('title'));
  panel.innerHTML = `
    <div class="agy-resize-handle" aria-hidden="true"></div>
    <header class="agy-header">
      <button type="button" class="agy-session-btn" aria-haspopup="menu" aria-expanded="false"><span class="agy-mark">${ICON}</span><span class="agy-session-label">${esc(T('newSession'))}</span><span class="agy-bypass-badge" hidden>${esc(T('permBypass'))}</span><span class="agy-dd-arrow" aria-hidden="true">&#x25BE;</span></button>
      <button type="button" class="agy-header-rename" title="${esc(T('rename'))}" aria-label="${esc(T('rename'))}">${SVG.edit}</button>
      <div class="agy-actions">
        <button type="button" class="agy-btn agy-cog" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(T('settingsTitle'))}" title="${esc(T('settingsTitle'))}">${SVG.cog}<i class="agy-cog-dot" hidden></i></button>
        <button type="button" class="agy-btn agy-new" aria-label="${esc(T('newTab'))}" title="${esc(T('newTab'))}">${SVG.plus}</button>
        <button type="button" class="agy-btn agy-minimize" aria-label="${esc(T('minimize'))}" title="${esc(T('minimize'))}">${SVG.minus}</button>
        <button type="button" class="agy-btn agy-btn-danger agy-close-tab" aria-label="${esc(T('closeTab'))}" title="${esc(T('closeTab'))}">${SVG.close}</button>
      </div>
    </header>
    <div class="agy-tabs" role="tablist" aria-label="${esc(T('sessions'))}"></div>
    <div class="agy-messages-container">
      <div class="agy-transcript" role="log" aria-live="polite" aria-label="${esc(T('transcript'))}"></div>
      <button type="button" class="agy-jump" hidden>&darr; ${esc(T('jumpLatest'))}</button>
    </div>
    <div class="agy-bottom">
      <div class="agy-banner" role="status" hidden></div>
      <div class="agy-queue" hidden></div>
      <div class="agy-projectbar">
        ${dropdownHTML('agy-project', [{ value: '', label: T('chooseProject'), selected: true }], { label: T('project') })}
        ${dropdownHTML('agy-branch', [{ value: '', label: T('branch'), selected: true }], { label: T('branch'), disabled: true })}
        <span class="agy-folders"></span>
        <button type="button" class="agy-bar-action agy-add-folder" aria-label="${esc(T('folderAdd'))}" title="${esc(T('folderAdd'))}">${SVG.folder}</button>
      </div>
      <div class="agy-staged" hidden></div>
      <div class="agy-bypass-confirm" role="alertdialog" aria-label="${esc(T('permBypassConfirmTitle'))}" hidden>
        <div class="agy-bypass-confirm-text"><strong>${esc(T('permBypassConfirmTitle'))}</strong><span>${esc(T('permBypassConfirmBody'))}</span></div>
        <div class="agy-bypass-confirm-actions"><button type="button" class="agy-action" data-bypass-no="1">${esc(T('cancel'))}</button><button type="button" class="agy-action agy-btn-deny" data-bypass-yes="1">${esc(T('permBypassConfirmYes'))}</button></div>
      </div>
      <div class="agy-bypass-strip" role="status" hidden></div>
      <form class="agy-composer" autocomplete="off">
        <div class="agy-input-wrap"><div class="agy-input-shell">
          <textarea class="agy-input" rows="1" placeholder="${esc(T('placeholder'))}" aria-label="${esc(T('placeholder'))}" aria-autocomplete="list" aria-controls="agy-hints" spellcheck="false"></textarea>
          <button type="button" class="agy-mic" aria-pressed="false" aria-label="${esc(T('mic'))}" title="${esc(T('mic'))}" hidden>${SVG.mic}</button>
          <button type="submit" class="agy-send" aria-label="${esc(T('send'))}" data-mode="send" disabled>${SVG.send}</button>
        </div></div>
      </form>
      <div class="agy-hints" id="agy-hints" role="listbox" aria-label="${esc(T('commands'))}" hidden></div>
      <div class="agy-footer">
        <div class="agy-footer-left">
          <a class="agy-brand-link" href="https://antigravity.google/docs/cli/reference" target="_blank" rel="noopener noreferrer" title="${esc(T('cliReference'))}" aria-label="${esc(T('cliReference'))}">${ICON}</a>
          <button type="button" class="agy-attach" aria-label="${esc(T('attach'))}" title="${esc(T('attach'))}">${SVG.clip}</button>
          <input type="file" class="agy-file" multiple hidden>
          <span class="agy-status-line" aria-live="polite"></span>
        </div>
        <div class="agy-footer-right">
          ${dropdownHTML('agy-perm', bypassControl({}, T).entries, { label: T('permissions'), classes: 'agy-perm-dd' })}
          ${dropdownHTML('agy-mode', [{ value: '', label: T('mode'), selected: true }], { label: T('mode'), disabled: true })}
          ${dropdownHTML('agy-thinking', [{ value: '', label: T('thinking'), selected: true }], { label: T('thinking'), disabled: true })}
          ${dropdownHTML('agy-model', [{ value: '', label: T('modelDefault'), selected: true }], { label: T('model'), disabled: true })}
        </div>
      </div>
    </div>`;
  return panel;
}

function toggleCard(head) {
  const card = head.closest('.agy-card');
  if (!card) return;
  const collapsed = card.classList.toggle('agy-collapsed');
  head.setAttribute('aria-expanded', String(!collapsed));
  const id = card.dataset.tool;
  const rt = runtimeOf(activeTab());
  if (id && rt) {
    if (collapsed) { rt.opened.delete(id); rt.closed.add(id); } else { rt.closed.delete(id); rt.opened.add(id); }
  }
}

function patchText(rt, path) {
  for (const row of rt.transcript.rows) {
    if (row.kind !== 'tool') continue;
    const item = row.content.find((c) => c.type === 'diff' && c.path === path);
    if (!item) continue;
    const view = diffView(item);
    const lines = [`--- ${item.oldText === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`];
    for (const r of view.rows) {
      if (r.kind === 'hunk') lines.push(r.text);
      else if (r.kind === 'add') lines.push(`+${r.text}`);
      else if (r.kind === 'delete') lines.push(`-${r.text}`);
      else if (r.kind === 'context') lines.push(` ${r.text}`);
    }
    return lines.join('\n');
  }
  return '';
}

function wire() {
  wireDropdowns(_panel);
  $('.agy-minimize').addEventListener('click', () => setVisible(false));
  $('.agy-close-tab').addEventListener('click', () => closeTab(_activeIdx));
  $('.agy-new').addEventListener('click', () => newSessionTab());
  $('.agy-session-btn').addEventListener('click', (event) => openSessionsMenu(event.currentTarget));
  $('.agy-header-rename').addEventListener('click', () => startRename());
  $('.agy-cog').addEventListener('click', (event) => openSettingsPop(event.currentTarget));
  $('.agy-add-folder').addEventListener('click', (event) => openFolderMenu(event.currentTarget));
  $('.agy-folders').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-folder-remove]');
    const tab = activeTab();
    if (remove && tab) setFolders(tab, foldersOf(tab).filter((p) => p !== remove.dataset.folderRemove));
  });
  $('.agy-tabs').addEventListener('click', (event) => {
    const close = event.target.closest('[data-close]');
    if (close) { event.stopPropagation(); closeTab(Number(close.dataset.close)); return; }
    const tabEl = event.target.closest('.agy-tab');
    if (tabEl) switchTab(Number(tabEl.dataset.idx));
  });
  $('.agy-tabs').addEventListener('dblclick', (event) => {
    const tabEl = event.target.closest('.agy-tab');
    if (!tabEl) return;
    switchTab(Number(tabEl.dataset.idx));
    startRename();
  });
  $('.agy-tabs').addEventListener('auxclick', (event) => {
    const tabEl = event.target.closest('.agy-tab');
    if (tabEl && event.button === 1) closeTab(Number(tabEl.dataset.idx));
  });
  $('#agy-project').addEventListener('change', (event) => {
    const value = event.target.value;
    const tab = activeTab();
    if (!value) return;
    storage.setItem(STOR.project, value);
    if (tab && !tab.sessionId && !tab.running && !tab.automationRunId) { tab.project = value; tab.additionalDirectories = foldersOf(tab).filter((p) => p !== value); saveTabs(); renderAll(); return; }
    createTab({ project: value });
  });
  $('#agy-branch').addEventListener('change', (event) => { if (event.target.value) switchBranch(event.target.value); });
  $('#agy-model').addEventListener('change', (event) => {
    const tab = activeTab();
    if (!tab || !event.target.value) return;
    if (event.target.dataset.configId) setConfig(tab, event.target.dataset.configId, event.target.value);
    else setModel(tab, event.target.value);
  });
  $('#agy-thinking').addEventListener('change', (event) => {
    const tab = activeTab();
    if (tab && event.target.dataset.configId && event.target.value) setConfig(tab, event.target.dataset.configId, event.target.value);
  });
  $('#agy-perm').addEventListener('change', (event) => {
    const tab = activeTab();
    if (!tab) return;
    const action = pickPermission(event.target.value, { bypass: tab.bypass === true, supported: agentCaps().bypass });
    if (action?.confirm) { _bypassConfirmFor = tab.id; renderBypass(); $('[data-bypass-yes]')?.focus(); return; }
    _bypassConfirmFor = null;
    if (action) setBypass(tab, action.set); else renderBypass();
  });
  $('.agy-bypass-confirm').addEventListener('click', (event) => {
    const tab = activeTab();
    if (event.target.closest('[data-bypass-yes]')) { _bypassConfirmFor = null; if (tab) setBypass(tab, true); return; }
    if (event.target.closest('[data-bypass-no]')) { _bypassConfirmFor = null; renderBypass(); $('.agy-input')?.focus(); }
  });
  $('.agy-bypass-confirm').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); _bypassConfirmFor = null; renderBypass(); $('.agy-input')?.focus(); }
  });
  $('#agy-mode').addEventListener('change', (event) => {
    const tab = activeTab();
    if (!tab || !event.target.value) return;
    if (event.target.dataset.configId) setConfig(tab, event.target.dataset.configId, event.target.value);
    else setMode(tab, event.target.value);
  });
  // A picker or the composer on a tab without a session yet: the session starts, so the pickers show its choices.
  const warm = () => { const tab = activeTab(); if (tab?.project && !tab.sessionId && !tab.automationRunId && !blockedNow()) ensureSession(tab).catch(() => {}); };
  $('.agy-footer-right').addEventListener('pointerdown', (event) => { if (event.target.closest('.cc-dropdown')) warm(); });
  const input = $('.agy-input');
  input.addEventListener('focus', warm);
  input.addEventListener('input', () => { autosize(); renderComposer(); updateHints(); const tab = activeTab(); if (tab) { tab.draft = input.value; } });
  input.addEventListener('click', () => updateHints());
  input.addEventListener('blur', () => setTimeout(() => { if (!$('.agy-hints')?.matches(':hover')) hideHints(); }, 150));
  $('.agy-hints').addEventListener('mousedown', (event) => event.preventDefault());
  $('.agy-hints').addEventListener('click', (event) => {
    const item = event.target.closest('[data-hint]');
    if (item) chooseHint(Number(item.dataset.hint));
  });
  input.addEventListener('keydown', (event) => {
    if (_hints?.items.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        _hints.active = (_hints.active + step + _hints.items.length) % _hints.items.length;
        drawHints();
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing)) { event.preventDefault(); chooseHint(_hints.active); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hideHints(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); return; }
    if (event.key === 'ArrowUp' && !input.value) {
      const last = lastPrompt(runtimeOf(activeTab())?.transcript || createTranscript());
      if (last) { event.preventDefault(); input.value = last.text; autosize(); renderComposer(); }
    }
  });
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); stageFiles(files); }
  });
  const form = $('.agy-composer');
  form.addEventListener('submit', (event) => { event.preventDefault(); if ($('.agy-send').dataset.mode === 'stop') stop(); else send(); });
  _panel.addEventListener('dragover', (event) => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); _panel.classList.add('agy-dragging'); } });
  _panel.addEventListener('dragleave', (event) => { if (!_panel.contains(event.relatedTarget)) _panel.classList.remove('agy-dragging'); });
  _panel.addEventListener('drop', (event) => { _panel.classList.remove('agy-dragging'); const files = [...(event.dataTransfer?.files || [])]; if (files.length) { event.preventDefault(); stageFiles(files); } });
  $('.agy-attach').addEventListener('click', () => $('.agy-file').click());
  $('.agy-file').addEventListener('change', (event) => { stageFiles([...event.target.files]); event.target.value = ''; });
  $('.agy-mic').addEventListener('click', () => toggleRecording());
  $('.agy-staged').addEventListener('click', (event) => {
    const button = event.target.closest('[data-unstage]');
    if (!button) return;
    runtimeOf(activeTab())?.staged.splice(Number(button.dataset.unstage), 1);
    renderAttachments();
    renderComposer();
  });
  $('.agy-queue').addEventListener('click', (event) => {
    const tab = activeTab();
    const rt = runtimeOf(tab);
    if (!rt) return;
    const action = event.target.closest('[data-queue]')?.dataset.queue;
    if (action === 'pause') { rt.queuePaused = !rt.queuePaused; renderQueue(); if (!rt.queuePaused) drainQueue(tab); return; }
    if (action === 'clear') { rt.queue = []; renderQueue(); return; }
    const edit = event.target.closest('[data-queue-edit]');
    if (edit) {
      const [item] = rt.queue.splice(Number(edit.dataset.queueEdit), 1);
      if (item) { $('.agy-input').value = item.text; rt.staged.push(...item.staged); autosize(); renderAttachments(); renderComposer(); $('.agy-input').focus(); }
      renderQueue();
      return;
    }
    const remove = event.target.closest('[data-queue-remove]');
    if (remove) { rt.queue.splice(Number(remove.dataset.queueRemove), 1); renderQueue(); }
  });
  $('.agy-banner').addEventListener('click', (event) => {
    if (!event.target.closest('[data-conn="retry"]')) return;
    _conn.phase = 'connecting';
    renderBanner();
    client().reconnectNow().catch(() => {});
  });
  $('.agy-jump').addEventListener('click', () => {
    const rt = runtimeOf(activeTab());
    if (rt) rt.scrolledUp = false;
    const box = $('.agy-transcript');
    if (box) box.scrollTop = box.scrollHeight;
    $('.agy-jump').hidden = true;
  });
  const transcript = $('.agy-transcript');
  wireFileLinks(transcript, { cwd: () => activeTab()?.project || '' });
  transcript.addEventListener('scroll', () => {
    const rt = runtimeOf(activeTab());
    if (!rt) return;
    rt.scrolledUp = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 60;
    const jump = $('.agy-jump');
    if (jump) jump.hidden = !rt.scrolledUp;
  });
  // A fold the user opens or closes (a thought, the installer's output) stays that way through every redraw. Read
  // from the click on its summary, before the browser flips it: a fold drawn open by the detail level is not a choice.
  transcript.addEventListener('click', (event) => {
    const summary = event.target.closest?.('summary');
    const fold = summary?.parentElement;
    if (!fold) return;
    if (fold.matches('.agy-thought') && fold.dataset.row) runtimeOf(activeTab())?.folds.set(fold.dataset.row, !fold.open);
    else if (fold.matches('.agy-setup-log')) _setup.logOpen = !fold.open;
  }, true);
  transcript.addEventListener('input', (event) => {
    const form = event.target.closest('[data-elicit-form]');
    if (!form) return;
    const rt = runtimeOf(activeTab());
    const entry = rt?.elicitations.get(form.dataset.elicitForm);
    if (!entry) return;
    rt.elicitDrafts[form.dataset.elicitForm] = readFormValues(form, elicitationFields(entry.requestedSchema));
  });
  transcript.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-elicit-form]');
    if (!form) return;
    event.preventDefault();
    const tab = activeTab();
    if (tab) submitElicitation(tab, form);
  });
  transcript.addEventListener('keydown', (event) => {
    const head = event.target.closest?.('.agy-card-head[role="button"]');
    if (head && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleCard(head); }
  });
  transcript.addEventListener('click', async (event) => {
    const tab = activeTab();
    if (!tab) return;
    const rt = runtimeOf(tab);
    const target = event.target;
    const permission = target.closest('[data-permission]');
    if (permission) { answerPermission(tab, permission.dataset.permission, permission.dataset.option || null); return; }
    const elicit = target.closest('[data-elicit]');
    if (elicit) { answerElicitation(tab, elicit.dataset.elicit, elicit.dataset.action); return; }
    const auth = target.closest('[data-auth]');
    if (auth) { if (auth.dataset.authKind === 'terminal') openSignInTerminal(tab); else signIn(tab, auth.dataset.auth); return; }
    if (target.closest('[data-auth-terminal]')) { openSignInTerminal(tab); return; }
    const setup = target.closest('[data-setup]');
    if (setup) { runSetupAction(setup.dataset.setup); return; }
    const copyTurn = target.closest('[data-copy-turn]');
    if (copyTurn) { copyText(answerOfTurn(rt.transcript, copyTurn.dataset.copyTurn), copyTurn); return; }
    const retry = target.closest('[data-retry]');
    if (retry) { retryLast(tab); return; }
    const copyPre = target.closest('[data-copy-pre]');
    if (copyPre) { copyText(copyPre.parentElement?.querySelector('pre')?.textContent || '', copyPre); return; }
    const copyDiff = target.closest('[data-copy-diff]');
    if (copyDiff) { event.preventDefault(); copyText(patchText(rt, copyDiff.dataset.copyDiff), copyDiff); return; }
    const full = target.closest('[data-diff-full]');
    if (full) { rt.fullDiffs.add(full.dataset.diffFull); scheduleRender(tab); return; }
    const head = target.closest('.agy-card-head[role="button"]');
    if (head && !target.closest('a, button, input, label')) toggleCard(head);
  });
  // Keyboard inside the panel: Escape stops a running turn (or denies an open permission), Enter allows it once.
  _panel.addEventListener('keydown', (event) => {
    if (!sidepanelAcceptsKeyboard('antigravity', event)) return;
    if (event.target.closest('.agy-session-label input')) return;
    const tab = activeTab();
    const rt = runtimeOf(tab);
    const open = rt && [...rt.permissions.entries()].find(([, entry]) => entry.state === 'open');
    const inField = event.target.closest('textarea, input, select, [contenteditable="true"]');
    if (event.key === 'Escape') {
      if (_hints) { hideHints(); event.preventDefault(); return; }
      if (open && !inField) { event.preventDefault(); answerPermission(tab, open[0], quickOption(open[1].card, 'deny')); return; }
      if (tab?.running && !tab.automationRunId) { event.preventDefault(); stop(); }
      return;
    }
    if (event.key === 'Enter' && open && !inField && !event.target.closest('button, a')) {
      const option = quickOption(open[1].card, 'allow');
      if (option) { event.preventDefault(); answerPermission(tab, open[0], option); }
    }
  });
}

function setVisible(next) {
  setSidepanelVisible(PANEL_OWNER, next);
}

function applyVisibility(next) {
  if (!_panel) return;
  _visible = !!next;
  _panel.classList.toggle('open', _visible);
  if (!_visible) { closePop(); hideHints(); }
  renderPills();
  emit('antigravity-panel:visibility', _visible);
  if (_visible) {
    state.lastActivePanel = 'antigravity';
    if (!_tabs.length) createTab();
    renderAll();
    setupController()?.refresh();
    if (_conn.phase !== 'blocked') client().open().catch(() => {});
    const tab = activeTab();
    if (tab?.sessionId && !runtimeOf(tab).loaded && !tab.automationRunId) ensureSession(tab).catch(() => {});
    $('.agy-input')?.focus();
  }
  window.dispatchEvent(new Event('resize'));
}

async function ensureProjects() {
  if (_projects.length) return;
  try {
    const data = await fetchProjects();
    _projects = Array.isArray(data?.projects) ? data.projects.filter((p) => p && typeof p.path === 'string') : [];
  } catch { _projects = []; }
  for (const tab of _tabs) if (!tab.project && _projects[0]) tab.project = storage.getItem(STOR.project) || _projects[0].path;
  renderProjectBar();
  scheduleRender();
}

function ensurePanel() {
  if (_panel) return;
  setAntigravityTranslator((key, params) => {
    try { return t(key, params); } catch { return key; }
  });
  injectAntigravityStyles();
  ensureMarked();
  _panel = buildPanel();
  document.body.appendChild(_panel);
  registerSidepanel({
    owner: PANEL_OWNER, provider: 'antigravity', element: _panel,
    header: $('.agy-header'), actions: $('.agy-actions'), buttonClass: 'agy-btn', dockHandle: $('.agy-resize-handle'), applyVisibility,
  });
  loadTabs();
  wire();
  setupController();
  renderAll();
  on('antigravity-panel:show', ({ tabId } = {}) => {
    const idx = _tabs.findIndex((tab) => tab.id === tabId);
    if (!_visible) setVisible(true);
    if (idx >= 0) switchTab(idx);
  });
  // The whiteboard's Send to Panel (and a detached window's image): staged like a pasted picture, by the panel used
  // last only (the other panels gate it the same way, so exactly one takes it).
  on('wb:send-to-panel', ({ dataUrl } = {}) => {
    if (state.lastActivePanel !== 'antigravity' || isHostedSessionFocused()) return;
    stagePicture(dataUrl);
  });
  window.dispatchEvent(new CustomEvent('sidepanel-tray:provider-loaded', { detail: { provider: 'antigravity' } }));
  ensureProjects();
}

// ── Public API ──
export function isAntigravityPanelOpen() { return _visible; }
export function bootAntigravityPanel() { ensurePanel(); }
export async function toggleAntigravityPanel() {
  ensurePanel();
  if (_visible) { setVisible(false); return; }
  await ensureProjects();
  setVisible(true);
}
/**
 * Opens the panel with text in the composer (and a file path attached, when given). `newTab`: in a tab of its own;
 * `send`: sent at once, as if the person pressed Enter (Run Pending Remembers, the Schedules window's prompt);
 * `model`: the tab's session runs on that model when it offers it (a model it does not offer is left alone).
 * → false when there was no room for a new tab.
 */
export async function openAntigravityWithPrompt(text = '', { path = null, newTab = false, send: sendNow = false, model = null } = {}) {
  ensurePanel();
  await ensureProjects();
  if (!_visible) setVisible(true);
  if (newTab) {
    const busy = activeTab();
    // An empty tab (a session this page warmed counts as empty) is reused rather than stacked.
    const reuse = busy && (!busy.sessionId || runtimeOf(busy).fresh) && !busy.running && !busy.automationRunId && !runtimeOf(busy).transcript.rows.length && !$('.agy-input')?.value;
    if (!reuse && !createTab({ project: busy?.project || undefined })) return false;
  }
  const input = $('.agy-input');
  if (input && text) { input.value = text; activeTab().draft = text; autosize(); }
  if (path) attachPathToAntigravity(path);
  renderComposer();
  if (model) await chooseModel(activeTab(), String(model));
  if (sendNow && text) await send();
  return true;
}
/** A tab's model, when its session offers it (its session starts here when it has none yet). */
async function chooseModel(tab, model) {
  if (!tab || !model || tab.automationRunId || blockedNow()) return;
  try { await ensureSession(tab); } catch { return; }
  const option = optionByCategory(runtimeOf(tab).configOptions, 'model');
  const offered = (option?.options || []).flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry])).some((entry) => String(entry?.value) === model);
  if (option && offered && String(option.currentValue) !== model) await setConfig(tab, option.id, model);
}
/**
 * Attaches a file by its absolute path (the File Explorer's Send to, a detached window's path): the agent reads it
 * itself. `false` when nothing was attached (a dispatched run holds the tab, or no path), so the sender does not say
 * it was sent; `true` otherwise (a path already attached counts as taken).
 */
export function attachPathToAntigravity(path) {
  ensurePanel();
  const tab = activeTab() || createTab();
  const rt = runtimeOf(tab);
  if (!rt || typeof path !== 'string' || !path || tab.automationActive) return false;
  if (!rt.staged.some((file) => file.path === path)) rt.staged.push({ name: path.split(/[\\/]/).pop() || path, path, mimeType: '' });
  renderAttachments();
  renderComposer();
  return true;
}
/** What a new detached window of this panel starts with (ui-sidepanel-session-entry.js): the active tab's project. */
export function antigravityPanelDefaults() {
  return { project: activeTab()?.project || storage.getItem(STOR.project) || '' };
}
/** A detached window closes: its tabs end (running turns cancelled, sessions closed). */
export function endHostedAntigravitySessions() {
  while (_tabs.length) closeTab(_tabs.length - 1);
}
/** Whether the panel is docked or floating (for tests and the window controller's callers). */
export function antigravityPanelPresentation() {
  try { return getSidepanelPresentation(PANEL_OWNER)?.layout?.mode || 'docked'; } catch { return 'docked'; }
}

// ── Dispatched runs (ui-native-loop-router.js) ──
export async function attachAntigravityAutomation(run, { focus = !!run?.focus, isCancelled = () => false, bufferedEvents = [] } = {}) {
  if (!run?.runId || !run.providerSessionId) return { ok: false, reason: 'identity_pending' };
  ensurePanel();
  await ensureProjects();
  if (isCancelled()) return { ok: false, reason: 'dismissed' };
  const running = run.status === 'starting' || run.status === 'running';
  const geminiDir = runGeminiDir(run);
  const own = _tabs.find((tab) => !tab.automationRunId && tab.releasedRunId === run.runId);
  if (own && !running) {
    if (geminiDir && !own.geminiDir) { own.geminiDir = geminiDir; saveTabs(); }
    window.dispatchEvent(new CustomEvent('native-loop:dismissed', { detail: { runId: run.runId } }));
    if (focus) { setVisible(true); switchTab(_tabs.indexOf(own)); }
    return { ok: true, released: true };
  }
  let tab = _tabs.find((entry) => entry.automationRunId === run.runId);
  if (!tab) {
    tab = createTab({ project: run.cwd || run.project || '', geminiDir, activate: !!focus });
    if (!tab) return { ok: false, reason: 'tab_limit' };
    tab.automationRunId = run.runId;
    tab.sessionId = run.providerSessionId;
    tab.title = run.title || null;
    runtimeOf(tab).loaded = true; // its events are the transcript: never loaded into this window's own agent process
    for (const payload of bufferedEvents || []) applyAutomationEvent(tab, payload);
  } else {
    if (run.providerSessionId && tab.sessionId !== run.providerSessionId) tab.sessionId = run.providerSessionId;
    if (geminiDir) tab.geminiDir = geminiDir;
  }
  const restart = workerRestart(run);
  tab.automationActive = !!restart?.active || running;
  tab.automationOwnerId = nativeLoopWindowId;
  tab.automationAwaits = runAwaitsAnswer(run);
  tab.running = running && run.turnState !== 'idle';
  try {
    trackWorkerEnd(run, {
      apply: (view) => {
        if (view) { tab.automationActive = false; tab.running = false; const rt = runtimeOf(tab); rt.notice = { text: T('automationEnded'), severity: 'info' }; scheduleRender(tab); renderTabs(); renderBanner(); renderComposer(); }
      },
    });
  } catch { /* the end card is optional */ }
  saveTabs();
  if (focus) { setVisible(true); switchTab(_tabs.indexOf(tab)); }
  scheduleRender(tab);
  renderBanner();
  return { ok: true, tabId: tab.id };
}

function applyAutomationEvent(tab, payload) {
  const rt = runtimeOf(tab);
  const action = automationEvent(payload);
  if (!action) return;
  if (action.kind === 'user') {
    const last = rt.transcript.rows[rt.transcript.rows.length - 1];
    if (!(last?.kind === 'user' && last.text === action.text)) addUserMessage(rt.transcript, action.text);
    tab.running = true;
  } else if (action.kind === 'update') {
    applyUpdate(rt.transcript, action.update);
    if (action.update.sessionUpdate === 'session_info_update' && rt.transcript.title) tab.title = rt.transcript.title;
  } else if (action.kind === 'notice') {
    rt.transcript.rows.push({ id: `n${Date.now()}`, kind: 'notice', text: action.text, severity: action.severity });
  }
}

export function handleAntigravityAutomationEvent(runId, payload) {
  const tab = _tabs.find((entry) => entry.automationRunId === runId);
  if (!tab) return false;
  applyAutomationEvent(tab, payload);
  scheduleRender(tab);
  return true;
}

export function detachAntigravityAutomation(runId) {
  const idx = _tabs.findIndex((tab) => tab.automationRunId === runId);
  if (idx < 0) return;
  const tab = _tabs[idx];
  tab.pillEl?.remove();
  _runtime.delete(tab.id);
  _tabs.splice(idx, 1);
  if (_activeIdx >= _tabs.length) _activeIdx = Math.max(0, _tabs.length - 1);
  saveTabs();
  if (_panel) renderAll();
}

// For tests: the copy keys this file uses are all in AGY_COPY.
export const _copyKeys = Object.keys(AGY_COPY);
