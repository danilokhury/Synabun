// ═══════════════════════════════════════════
// SynaBun Assistant — sidepanel host
// ═══════════════════════════════════════════
// The Assistant's right-edge sidepanel, beside the Claude Code / Codex /
// OpenCode panels. It mounts the SAME component as the terminal tab
// (asst-panel.js mountAssistant) — one tab per assistant session — so the
// two hosts never differ in features. What lives here is window chrome only:
// the one header row (mark · name ▾ · rename · status · the active tab's
// toolbar · detach/minimize/close — each tab's component toolbar is placed in
// the header through host.toolbarSlot, only the active tab's shows), one
// viewport per tab, gold tray pills, and — through registerSidepanel —
// float/dock, resize, width reservation and docked exclusivity with the
// other sidepanels. The rules both hosts share (create/resume, one session
// in one host, last used, guest gate) live in ../ui-assistant.js; this module
// is its 'sidepanel' adapter. Styles: asst-sidepanel-styles.js.

import { state, emit, on } from '../state.js';
import { storage } from '../storage.js';
import { KEYS } from '../constants.js';
import { t } from '../i18n.js';
import { getProviderMeta } from '../provider-icons.js';
import { showGuestToast } from '../ui-sync.js';
import { registerSidepanel, setSidepanelVisible, syncSidepanelLayout, focusSidepanel } from '../ui-sidepanel-windows.js';
import {
  assistantBlocked, assistantOwnerOf, fetchLiveAssistantSessions, noteAssistantFocus, openAssistant, registerAssistantHost,
} from '../ui-assistant.js';
import { mountAssistant } from './asst-panel.js';
import { openModelsManager } from './asst-route.js';
import { brainLabel, readStoredBrain } from './asst-state.js';
import { closeMenu, isMenuOpen, openMenu } from './asst-menu.js';
import { injectAssistantSidepanelStyles } from './asst-sidepanel-styles.js';
import { createMascot, mascotCameoSvg } from '../synabun-mascot.js';

const PANEL_OWNER = 'assistant-sidepanel';
const HOST_ID = 'sidepanel';

const ICON_MARK = getProviderMeta('assistant').icon;
const ICON_CARET = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
const ICON_MINIMIZE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_NEW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
// The running cameo: the mascot's two pill eyes, the one form every running pill uses (asst-styles.js animates them).
const CAMEO = mascotCameoSvg();

let _panel = null;
let _building = false;
let _visible = false;
let _initialized = false;
let _starting = false;
let _startError = ''; // the last message the host showed while starting (the failed state repeats it)
let _placeholderMascot = null; // the character while starting: the empty state's, same size; it flies to the empty state's spot
let _pendingPath = '';
let _toastTimer = null;
let _renaming = false;
const _tabs = [];   // { sessionId, viewport, toolbar, ctl, pill, label, userRenamed, status, brain }
let _activeIdx = -1;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tr(key, fallback, params) {
  const value = t(key, params);
  if (value && value !== key && typeof value === 'string') return value;
  return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const panelEl = (selector) => _panel?.querySelector(selector) || null;
const activeTab = () => _tabs[_activeIdx] || null;
const findTab = (sessionId) => (sessionId ? _tabs.find(tab => tab.sessionId === sessionId) || null : null);
const defaultLabel = () => tr('assistant.defaultTitle', 'SynaBun');

function statusLabel(status) {
  if (status === 'working') return tr('assistant.panel.status.working', 'Working');
  if (status === 'action') return tr('assistant.panel.status.action', 'Needs you');
  if (status === 'done') return tr('assistant.panel.status.done', 'Done');
  return tr('assistant.panel.status.idle', 'Idle');
}

function isTabVisible(tab) {
  return _visible && activeTab() === tab && document.visibilityState === 'visible';
}

function conversationOf(tab) {
  try { return tab?.ctl?.getConversationTitle?.() || ''; } catch { return ''; }
}

// ── Persistence (global like the terminal registry; per-tab UI state is the component's) ──

function saveTabs() {
  try {
    if (!_tabs.length) { storage.removeItem(KEYS.ASSISTANT_PANEL_TABS); return; }
    storage.setItem(KEYS.ASSISTANT_PANEL_TABS, JSON.stringify({
      v: 1,
      activeIdx: Math.max(0, _activeIdx),
      tabs: _tabs.map(tab => ({ sessionId: tab.sessionId, label: tab.userRenamed ? tab.label : '', userRenamed: !!tab.userRenamed })),
    }));
  } catch { /* storage unavailable */ }
}

function readSavedTabs() {
  try {
    const data = JSON.parse(storage.getItem(KEYS.ASSISTANT_PANEL_TABS) || 'null');
    if (data?.v !== 1 || !Array.isArray(data.tabs)) return null;
    const tabs = data.tabs.filter(entry => typeof entry?.sessionId === 'string' && entry.sessionId);
    return { activeIdx: Number(data.activeIdx) || 0, tabs };
  } catch { return null; }
}

// ── DOM ──────────────────────────────────────────────────────────────────────

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'assistant-panel';
  panel.className = 'assistant-panel';
  panel.innerHTML = `
    <div class="asp-resize-handle"></div>
    <div class="asp-header">
      <span class="asp-mark" aria-hidden="true">${ICON_MARK}</span>
      <button type="button" class="asp-tabs-btn" aria-haspopup="menu" aria-expanded="false" data-tooltip-pos="left">
        <span class="asp-tabs-mark" aria-hidden="true">${ICON_MARK}</span>
        <span class="asp-title">${esc(defaultLabel())}</span>
        <span class="asp-tabs-count" hidden></span>
        <span class="asp-caret" aria-hidden="true">${ICON_CARET}</span>
      </button>
      <button type="button" class="asp-btn asp-rename" data-tooltip="${esc(tr('assistant.panel.rename', 'Rename'))}" aria-label="${esc(tr('assistant.panel.rename', 'Rename'))}">${ICON_EDIT}</button>
      <span class="asp-status" data-status="idle" role="img" aria-label="${esc(statusLabel('idle'))}">${CAMEO}</span>
      <div class="asp-bar-slot"></div>
      <div class="asp-actions">
        <button type="button" class="asp-btn asp-minimize" data-tooltip="${esc(tr('assistant.panel.minimize', 'Minimize to pill'))}" aria-label="${esc(tr('assistant.panel.minimize', 'Minimize to pill'))}">${ICON_MINIMIZE}</button>
        <button type="button" class="asp-btn asp-close" data-tooltip="${esc(tr('assistant.panel.close', 'End this session'))}" aria-label="${esc(tr('assistant.panel.close', 'End this session'))}">${ICON_X}</button>
      </div>
    </div>
    <div class="asp-body"></div>
    <div class="asp-toast" role="status" aria-live="polite"></div>
  `;
  return panel;
}

function ensurePanel() {
  if (_panel || _building) return _panel;
  _building = true;
  try {
    injectAssistantSidepanelStyles();
    _panel = buildPanel();
    document.body.appendChild(_panel);
    registerSidepanel({
      owner: PANEL_OWNER,
      provider: 'assistant',
      element: _panel,
      header: panelEl('.asp-header'),
      actions: panelEl('.asp-actions'),
      buttonClass: 'asp-btn',
      dockHandle: panelEl('.asp-resize-handle'),
      applyVisibility,
    });
    wireHeader();
    renderHeader();
  } finally {
    _building = false;
  }
  return _panel;
}

function wireHeader() {
  panelEl('.asp-tabs-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (_renaming) return;
    openTabsMenu();
  });
  panelEl('.asp-rename').addEventListener('click', () => startRename());
  panelEl('.asp-minimize').addEventListener('click', () => setVisible(false));
  panelEl('.asp-close').addEventListener('click', () => { if (_activeIdx >= 0) closeTab(_activeIdx); });
}

function renderHeader() {
  if (!_panel) return;
  const tab = activeTab();
  if (!_renaming) {
    const title = panelEl('.asp-title');
    if (title) title.textContent = tab?.label || defaultLabel();
  }
  const count = panelEl('.asp-tabs-count');
  count.textContent = _tabs.length > 1 ? String(_tabs.length) : '';
  count.hidden = _tabs.length < 2;
  const convo = conversationOf(tab);
  const tabsBtn = panelEl('.asp-tabs-btn');
  const name = tab?.label || defaultLabel();
  // Under 300px the chip is only its mark: the tooltip carries the name.
  const tip = convo && convo !== name ? `${name} — ${convo}` : (convo || name);
  tabsBtn.setAttribute('data-tooltip', tip);
  tabsBtn.setAttribute('aria-label', `${tab?.label || defaultLabel()} — ${tr('assistant.panel.tabs', 'Open sessions')}`);
  const status = tab?.status || 'idle';
  const dot = panelEl('.asp-status');
  dot.dataset.status = status;
  dot.setAttribute('aria-label', statusLabel(status));
  dot.setAttribute('data-tooltip', statusLabel(status));
  panelEl('.asp-rename').disabled = !tab;
  panelEl('.asp-close').disabled = !tab;
}

function renderPlaceholder(kind) {
  const body = panelEl('.asp-body');
  if (!body) return;
  let node = body.querySelector('.asp-placeholder');
  _placeholderMascot?.destroy();
  _placeholderMascot = null;
  if (!kind || _tabs.length) { node?.remove(); return; }
  if (!node) { node = document.createElement('div'); node.className = 'asp-placeholder'; body.appendChild(node); }
  node.dataset.state = kind;
  if (kind === 'starting') {
    node.setAttribute('role', 'status');
    node.innerHTML = `<div class="asst-empty-mascot" aria-hidden="true"></div><span class="asp-placeholder-text">${esc(tr('assistant.panel.starting', 'Starting SynaBun…'))}</span><span class="asp-placeholder-track" aria-hidden="true"></span>`;
    try { _placeholderMascot = createMascot(node.querySelector('.asst-empty-mascot'), { width: 120, height: 60 }); } catch { _placeholderMascot = null; }
    return;
  }
  node.removeAttribute('role');
  node.innerHTML = `<span class="asp-mark" aria-hidden="true">${ICON_MARK}</span><span>${esc(tr('assistant.panel.failed', 'The Assistant could not start.'))}</span>`;
  if (kind === 'failed') {
    // The reason stays in place (the toast is gone in seconds), and Models… is
    // reachable here: a disabled model can be switched back on with no session running.
    if (_startError) {
      const reason = document.createElement('span');
      reason.className = 'asp-placeholder-reason';
      reason.textContent = _startError;
      node.appendChild(reason);
      panelEl('.asp-toast')?.classList.remove('visible');
    }
    const actions = document.createElement('div');
    actions.className = 'asp-placeholder-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'asst-btn asst-btn-secondary';
    retry.textContent = tr('assistant.panel.retry', 'Try again');
    retry.addEventListener('click', () => startSession());
    const models = document.createElement('button');
    models.type = 'button';
    models.className = 'asst-btn asst-btn-secondary';
    models.textContent = tr('assistant.models.menu', 'Models…');
    models.addEventListener('click', () => {
      openModelsManager({ t, getBrain: () => readStoredBrain(storage), onToast: showPanelToast }).catch(() => {});
    });
    actions.append(retry, models);
    node.appendChild(actions);
  }
}

function showPanelToast(text) {
  if (!text) return;
  if (!_panel || !_visible) { showGuestToast(text); return; }
  const node = panelEl('.asp-toast');
  node.textContent = text;
  node.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => node.classList.remove('visible'), 3500);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function mountTab({ sessionId, meta = null, brain = null, label = '', userRenamed = false, prompt = '', show = true } = {}) {
  if (!sessionId) return null;
  ensurePanel();
  const existing = findTab(sessionId);
  if (existing) {
    if (show) focusSession(sessionId, { prompt });
    return existing;
  }
  // The "Starting SynaBun…" character hands over: the tab's empty state flies in from where it stood.
  let handoff = _placeholderMascot?.el?.isConnected ? { rect: _placeholderMascot.el.getBoundingClientRect(), at: Date.now() } : null;
  renderPlaceholder(null);
  const viewport = document.createElement('div');
  viewport.className = 'asp-viewport';
  viewport.dataset.sessionId = sessionId;
  panelEl('.asp-body').appendChild(viewport);
  // The tab's toolbar lives in the header row (placement only: the component's own bar and wiring).
  const toolbar = document.createElement('div');
  toolbar.className = 'asp-tab-bar';
  toolbar.dataset.sessionId = sessionId;
  panelEl('.asp-bar-slot').appendChild(toolbar);
  const renamed = !!(userRenamed && label);
  // The record exists before mountAssistant: the host hooks fire during mount.
  const tab = { sessionId, viewport, toolbar, ctl: null, pill: null, label: renamed ? label : defaultLabel(), userRenamed: renamed, status: 'idle', brain: brain || meta?.brain || null };
  _tabs.push(tab);
  const host = {
    id: HOST_ID,
    notifySource: 'panel', // Settings → Notifications "Side Panel" source
    setLabel(text) {
      const next = String(text || '').trim();
      if (!next || tab.userRenamed || tab.label === next) return;
      tab.label = next;
      renderHeader();
      renderPills();
      saveTabs();
    },
    setStatus(status) {
      tab.status = status || 'idle';
      if (tab.status === 'done' && isTabVisible(tab)) tab.status = 'idle';
      if (tab === activeTab()) renderHeader();
      renderPills();
    },
    setBrain(next) { tab.brain = next || null; renderPills(); },
    isVisible: () => isTabVisible(tab),
    toolbarSlot: toolbar,
    takeHeroOrigin() {
      const h = handoff;
      handoff = null;
      return h && h.rect.width > 0 && Date.now() - h.at < 1500 ? h.rect : null;
    },
  };
  tab.ctl = mountAssistant(viewport, { sessionId, brain: tab.brain, host, session: meta });
  if (tab.userRenamed) tab.ctl.setTitle(tab.label);
  if (show) {
    switchTo(_tabs.length - 1);
    if (!_visible) setVisible(true);
    focusSidepanel(PANEL_OWNER);
  } else if (_activeIdx < 0) {
    _activeIdx = _tabs.length - 1;
    markActive();
  }
  renderHeader();
  renderPills();
  saveTabs();
  if (prompt) setTimeout(() => { if (findTab(sessionId)) tab.ctl?.send(prompt); }, 50);
  if (_pendingPath && tab === activeTab()) { const path = _pendingPath; _pendingPath = ''; tab.ctl.attachPath(path); }
  return tab;
}

/** Only the active tab's viewport and header toolbar show. */
function markActive() {
  _tabs.forEach((tab, idx) => {
    tab.viewport.classList.toggle('active', idx === _activeIdx);
    tab.toolbar.classList.toggle('active', idx === _activeIdx);
  });
}

function switchTo(idx) {
  const next = _tabs[idx];
  if (!next) return;
  const prev = activeTab();
  if (prev && prev !== next) {
    try { prev.ctl?.onHidden(); } catch { /* ignore */ }
  }
  _activeIdx = idx;
  markActive();
  if (next.status === 'done') next.status = 'idle';
  if (_visible) {
    try { next.ctl?.onShown(); } catch { /* ignore */ }
    noteAssistantFocus(next.sessionId, HOST_ID);
  }
  renderHeader();
  renderPills();
  saveTabs();
}

function closeTab(idx, { closeServer = true } = {}) {
  const tab = _tabs[idx];
  if (!tab) return;
  const wasActive = idx === _activeIdx;
  _tabs.splice(idx, 1);
  try { tab.ctl?.destroy({ closeServer }); } catch { /* ignore */ }
  tab.viewport.remove();
  tab.toolbar.remove();
  tab.pill?.remove();
  if (!_tabs.length) {
    _activeIdx = -1;
    saveTabs();
    renderHeader();
    if (_visible) setVisible(false);
    return;
  }
  if (wasActive) {
    _activeIdx = -1;
    switchTo(Math.min(idx, _tabs.length - 1));
    return;
  }
  if (idx < _activeIdx) _activeIdx -= 1;
  renderHeader();
  renderPills();
  saveTabs();
}

function focusSession(sessionId, { prompt = '' } = {}) {
  const idx = _tabs.findIndex(tab => tab.sessionId === sessionId);
  if (idx < 0) return;
  if (!_visible) setVisible(true);
  if (idx !== _activeIdx || !_tabs[idx].viewport.classList.contains('active')) switchTo(idx);
  else { try { _tabs[idx].ctl?.onShown(); } catch { /* ignore */ } }
  focusSidepanel(PANEL_OWNER);
  noteAssistantFocus(sessionId, HOST_ID);
  if (prompt) _tabs[idx].ctl?.send(prompt);
}

async function startSession() {
  if (_starting || _tabs.length) return;
  _starting = true;
  _startError = '';
  renderPlaceholder('starting');
  try {
    const res = await openAssistant({ host: HOST_ID });
    if (!_tabs.length) renderPlaceholder(res ? null : 'failed');
  } finally {
    _starting = false;
  }
}

// ── Tray pills ───────────────────────────────────────────────────────────────

function createPill(tab) {
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) return null;
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill asp-session-pill';
  pill.dataset.sessionId = tab.sessionId;
  // A button in its own right: a tab stop, Enter/Space open it (its ✕ stays a separate button).
  pill.setAttribute('role', 'button');
  pill.tabIndex = 0;
  pill.innerHTML = `
    <span class="term-minimized-pill-icon" aria-hidden="true">${ICON_MARK}${CAMEO}</span>
    <span class="term-minimized-pill-label"></span>
    <button type="button" class="term-minimized-pill-close" data-tooltip="${esc(tr('assistant.panel.endSession', 'End session'))}" data-tooltip-pos="top" aria-label="${esc(tr('assistant.panel.endSession', 'End session'))}">${ICON_X}</button>
  `;
  pill.addEventListener('click', () => focusSession(tab.sessionId));
  pill.addEventListener('keydown', (e) => {
    if (e.target !== pill || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    focusSession(tab.sessionId);
  });
  pill.querySelector('.term-minimized-pill-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) closeTab(idx);
  });
  pill.style.display = 'none';
  tray.appendChild(pill);
  return pill;
}

function renderPills() {
  const active = activeTab();
  for (const tab of _tabs) {
    if (!tab.pill?.isConnected) tab.pill = createPill(tab);
    if (!tab.pill) continue;
    tab.pill.querySelector('.term-minimized-pill-label').textContent = tab.label;
    const tip = [conversationOf(tab), tab.brain ? brainLabel(tab.brain) : '', statusLabel(tab.status)].filter(Boolean).join(' · ');
    tab.pill.setAttribute('data-tooltip', tip);
    tab.pill.setAttribute('aria-label', `${tab.label} — ${statusLabel(tab.status)}`);
    tab.pill.classList.toggle('asp-pill-running', tab.status === 'working');
    tab.pill.classList.toggle('asp-pill-attention', tab.status === 'action');
    tab.pill.classList.toggle('asp-pill-done', tab.status === 'done');
    tab.pill.style.display = (!_visible || tab !== active) ? '' : 'none';
  }
}

// ── Header: tab switcher + rename ────────────────────────────────────────────

function openTabsMenu() {
  const anchor = panelEl('.asp-tabs-btn');
  if (isMenuOpen(anchor)) { closeMenu(); return; }
  const items = [{ kind: 'header', label: tr('assistant.panel.openTabs', 'Open in this panel') }];
  _tabs.forEach((tab, idx) => {
    items.push({
      kind: 'radio',
      id: tab.sessionId,
      label: tab.label,
      desc: [conversationOf(tab), tab.brain ? brainLabel(tab.brain) : '', statusLabel(tab.status)].filter(Boolean).join(' · '),
      selected: idx === _activeIdx,
      onSelect: () => focusSession(tab.sessionId),
    });
  });
  items.push({ kind: 'separator' });
  // Also here because ✎ steps aside in a narrow header.
  if (activeTab()) items.push({ id: 'rename', label: tr('assistant.panel.renameEllipsis', 'Rename…'), onSelect: () => startRename() });
  items.push({
    label: tr('assistant.topbar.new', 'New assistant session'),
    icon: ICON_NEW,
    onSelect: () => {
      const tab = activeTab();
      if (tab?.ctl) tab.ctl.newSession(null);
      else openAssistant({ host: HOST_ID });
    },
  });
  openMenu(anchor, {
    title: tr('assistant.panel.tabs', 'Open sessions'),
    items,
    role: 'menu',
    placement: 'below',
    width: 300,
  });
}

function startRename() {
  const tab = activeTab();
  const title = panelEl('.asp-title');
  if (!tab || !title || _renaming) return;
  _renaming = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'asp-rename-input';
  input.value = tab.label;
  input.maxLength = 80;
  input.setAttribute('aria-label', tr('assistant.panel.rename', 'Rename'));
  input.placeholder = tr('assistant.panel.renamePlaceholder', 'Session name');
  title.textContent = '';
  title.appendChild(input);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    _renaming = false;
    const next = input.value.trim();
    if (commit && next && next !== tab.label) {
      tab.label = next;
      tab.userRenamed = true;
      tab.ctl?.setTitle(next);
      saveTabs();
    }
    renderHeader();
    renderPills();
    panelEl('.asp-tabs-btn')?.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // single-letter keybinds stay out of the field
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}

// ── Visibility ───────────────────────────────────────────────────────────────

function setVisible(visible) {
  ensurePanel();
  setSidepanelVisible(PANEL_OWNER, visible);
}

function applyVisibility(nextVisible) {
  if (!_panel) return;
  const wasVisible = _visible;
  _visible = !!nextVisible;
  _panel.classList.toggle('open', _visible);
  syncSidepanelLayout(PANEL_OWNER);
  const tab = activeTab();
  if (_visible) {
    state.lastActivePanel = 'assistant';
    if (!_tabs.length) startSession();
    else if (tab) {
      if (tab.status === 'done') tab.status = 'idle';
      try { tab.ctl?.onShown(); } catch { /* ignore */ }
      noteAssistantFocus(tab.sessionId, HOST_ID);
    }
  } else if (wasVisible) {
    if (isMenuOpen(panelEl('.asp-tabs-btn'))) closeMenu();
    try { tab?.ctl?.onHidden(); } catch { /* ignore */ }
  }
  renderHeader();
  renderPills();
  emit('assistant-panel:visibility', _visible);
  window.dispatchEvent(new Event('resize'));
}

// ── The 'sidepanel' adapter for ui-assistant.js ──────────────────────────────

const _adapter = {
  id: HOST_ID,
  has: (sessionId) => !!findTab(sessionId),
  sessions: () => {
    const active = activeTab();
    return [active, ..._tabs.filter(tab => tab !== active)].filter(Boolean).map(tab => tab.sessionId);
  },
  focus: (sessionId, opts) => focusSession(sessionId, opts),
  mount: ({ sessionId, meta, brain, label, prompt }) => mountTab({ sessionId, meta, brain, label, prompt, show: true }),
  close(sessionId, { closeServer = true } = {}) {
    const idx = _tabs.findIndex(tab => tab.sessionId === sessionId);
    if (idx >= 0) closeTab(idx, { closeServer });
  },
  toggle(sessionId) {
    const target = findTab(sessionId) || activeTab();
    if (_visible && (!target || target === activeTab())) { setVisible(false); return; }
    if (target) focusSession(target.sessionId);
    else setVisible(true);
  },
  toast: (text) => {
    if (_starting) _startError = String(text || '');
    showPanelToast(text);
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

export function isAssistantPanelOpen() {
  return _visible;
}

/** Showing the panel starts nothing: it has a session tab to show (with none, opening it starts a session). */
export function assistantPanelPeekable() {
  return !assistantBlocked() && _tabs.length > 0;
}

/** The top-right SynaBun button. */
export async function toggleAssistantPanel() {
  if (assistantBlocked()) {
    showGuestToast(tr('assistant.panel.blocked', 'The Assistant is disabled by the host'));
    return;
  }
  ensurePanel();
  setVisible(!_visible);
}

/**
 * Register the sidepanel host and restore the tabs it had (hidden, with their
 * pills). Idempotent. With no saved tabs nothing is built or fetched.
 */
export async function initAssistantPanel() {
  if (_initialized) return;
  _initialized = true;
  registerAssistantHost(_adapter);

  on('assistant-panel:show', (data) => {
    const sessionId = data?.sessionId || data?.tabId || null;
    if (sessionId && findTab(sessionId)) focusSession(sessionId);
    else if (!assistantBlocked()) setVisible(true);
  });
  // Whiteboard "Send to Panel" and the file explorer's "send path", when the
  // Assistant sidepanel was the last one focused.
  on('wb:send-to-panel', ({ dataUrl } = {}) => {
    if (!dataUrl || state.lastActivePanel !== 'assistant') return;
    const tab = activeTab();
    if (!tab) return;
    if (!_visible) setVisible(true);
    tab.ctl?.attachImageDataUrl(dataUrl, 'whiteboard');
  });
  on('assistant:attach-path', ({ path } = {}) => {
    if (!path || assistantBlocked()) return;
    const tab = activeTab();
    if (!_visible) setVisible(true);
    if (tab?.ctl) tab.ctl.attachPath(path);
    else _pendingPath = String(path);
  });
  // The server renamed a conversation (first prompt): refresh tooltips after the component applied it.
  on('sync:assistant:session-updated', (msg) => {
    const id = msg?.session?.id || msg?.id;
    if (!findTab(id)) return;
    setTimeout(() => { renderHeader(); renderPills(); }, 0);
  });

  const saved = readSavedTabs();
  if (!saved?.tabs.length) return;
  const live = await fetchLiveAssistantSessions();
  for (const entry of saved.tabs) {
    const meta = live.get(entry.sessionId);
    if (!meta) continue;
    const owner = assistantOwnerOf(entry.sessionId);
    if (owner && owner !== HOST_ID) continue; // open in the terminal: one session, one host
    mountTab({
      sessionId: entry.sessionId,
      meta,
      label: entry.label || '',
      userRenamed: !!entry.userRenamed,
      show: false,
    });
  }
  if (_tabs.length) {
    _activeIdx = Math.min(Math.max(0, saved.activeIdx), _tabs.length - 1);
    markActive();
    renderHeader();
    renderPills();
  }
  saveTabs();
}
