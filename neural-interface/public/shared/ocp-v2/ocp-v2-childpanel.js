// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Child sub-agent sidepanel
// A peer of the primary OCP v2 panel, bound to a sub-agent session. Behaves
// EXACTLY like the primary:
//   • Spawns minimized (pill in tray, panel hidden)
//   • Mutually exclusive with the primary panel — only one visible at a time
//   • Same right-edge slot, same width/resize behavior
//   • Header has minimize / close / slide / rename buttons
//   • A NEW sub-agent of the same parent REPLACES this panel (the previous
//     child is destroyed by the manager before spawning the new one)
// ─────────────────────────────────────────────────────────────────────────────

import { state, emit, on } from '../state.js';
import { injectStyles } from './ocp-v2-styles.js';
import { mountRenderer } from './ocp-v2-render.js';
import { mountCompose } from './ocp-v2-send.js';
import { mountContextGauge } from './ocp-v2-context-gauge.js';
import { mountCompactButton } from './ocp-v2-compact-button.js';
import {
  reserveRightPanelLayout, clearRightPanelLayout,
} from '../ui-sidepanel-layout.js';
import { api } from './ocp-v2-ws.js';
import { isClaudePanelOpen, toggleClaudePanel } from '../ui-claude-panel.js';
import { isCodexPanelOpen, toggleCodexPanel } from '../ui-codex-panel.js';

const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 700;
const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_MINIMIZE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12"/></svg>';
const ICON_SLIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const OPENCODE_ICON = '<svg viewBox="0 0 24 30" fill="currentColor"><path d="M18 6H6V24H18V6ZM24 30H0V0H24V30Z"/></svg>';

export function createChildPanel({
  panelId, sessionId, store, parentPanelId, parentSessionId = '', parentTitle = 'parent', taskInfo = null, onClose, onShow,
}) {
  injectStyles();

  const PANEL_OWNER = panelId;
  let _visible = false;
  let _trayPill = null;
  let _statusEl = null;
  let _titleEl = null;
  let _renameBtn = null;
  let _renderer = null;
  let _composer = null;
  let _contextGauge = null;
  let _compactButton = null;
  let _unsubHeader = null;
  let _unsubMainVisibility = null;
  let _unsubClaudeShow = null;
  let _unsubCodexVisibility = null;
  let _destroyed = false;
  let _taskInfo = taskInfo && (taskInfo.subagentType || taskInfo.summary) ? { ...taskInfo } : null;

  // ── DOM ──────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = panelId;
  panel.className = 'ocpv2-panel ocpv2-panel-child';
  // Same right slot as the primary panel — they mutually exclude visibility,
  // so we don't need an offset variable.

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'ocpv2-resize-handle';
  panel.appendChild(resizeHandle);
  wireResize(panel, resizeHandle, PANEL_OWNER);

  const header = document.createElement('div');
  header.className = 'ocpv2-header';

  // Parent breadcrumb (replaces the session-menu dropdown — child has only
  // one session). Click → request main panel show.
  const parentBreadcrumb = document.createElement('button');
  parentBreadcrumb.type = 'button';
  parentBreadcrumb.className = 'ocpv2-child-parent-link';
  parentBreadcrumb.setAttribute('data-tooltip', `Back to ${parentTitle}`);
  parentBreadcrumb.innerHTML = `<span class="ocpv2-child-parent-arrow">↳</span><span class="ocpv2-child-parent-label">${escapeHtml(parentTitle)}</span>`;
  parentBreadcrumb.addEventListener('click', () => {
    setVisible(false);
    emit('opencode-panel:request-show');
  });
  header.appendChild(parentBreadcrumb);

  const titleLabel = document.createElement('span');
  titleLabel.className = 'ocpv2-session-label ocpv2-child-title';
  titleLabel.textContent = sessionTitleFor(store);
  header.appendChild(titleLabel);
  _titleEl = titleLabel;

  const renameBtn = document.createElement('button');
  renameBtn.className = 'ocpv2-header-rename';
  renameBtn.type = 'button';
  renameBtn.title = 'Rename';
  renameBtn.setAttribute('data-tooltip', 'Rename');
  renameBtn.innerHTML = ICON_EDIT;
  renameBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    beginRenameSession();
  });
  header.appendChild(renameBtn);
  _renameBtn = renameBtn;

  const status = document.createElement('div');
  status.className = 'ocpv2-header-status';
  status.textContent = '…';
  _statusEl = status;
  header.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'ocpv2-actions';

  // "New session" → opens the primary panel with a fresh top-level session.
  const newBtn = document.createElement('button');
  newBtn.className = 'ocpv2-btn';
  newBtn.type = 'button';
  newBtn.title = 'New session in main panel';
  newBtn.setAttribute('data-tooltip', 'New session in main panel');
  newBtn.innerHTML = ICON_PLUS;
  newBtn.addEventListener('click', () => {
    setVisible(false);
    emit('opencode-panel:request-show');
    emit('opencode-panel:request-new-session');
  });
  actions.appendChild(newBtn);

  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'ocpv2-btn';
  minimizeBtn.type = 'button';
  minimizeBtn.title = 'Minimize';
  minimizeBtn.setAttribute('data-tooltip', 'Minimize');
  minimizeBtn.innerHTML = ICON_MINIMIZE;
  minimizeBtn.addEventListener('click', () => setVisible(false));
  actions.appendChild(minimizeBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ocpv2-btn ocpv2-btn-danger';
  closeBtn.type = 'button';
  closeBtn.title = 'Close sub-agent panel';
  closeBtn.setAttribute('data-tooltip', 'Close sub-agent panel');
  closeBtn.innerHTML = ICON_X;
  closeBtn.addEventListener('click', () => destroy());
  actions.appendChild(closeBtn);

  const slideBtn = document.createElement('button');
  slideBtn.className = 'ocpv2-btn ocpv2-btn-slide';
  slideBtn.type = 'button';
  slideBtn.title = 'Slide';
  slideBtn.setAttribute('data-tooltip', 'Slide');
  slideBtn.innerHTML = ICON_SLIDE;
  slideBtn.addEventListener('click', () => setVisible(false));
  actions.appendChild(slideBtn);

  header.appendChild(actions);
  panel.appendChild(header);

  const contextBar = document.createElement('div');
  contextBar.className = 'ocpv2-contextbar';
  _contextGauge = mountContextGauge(contextBar, store);
  _compactButton = mountCompactButton(contextBar, store);
  panel.appendChild(contextBar);

  const messagesContainer = document.createElement('div');
  messagesContainer.className = 'ocpv2-messages-container';
  const messages = document.createElement('div');
  messages.className = 'ocpv2-messages';
  messagesContainer.appendChild(messages);
  panel.appendChild(messagesContainer);

  const compose = document.createElement('div');
  compose.className = 'ocpv2-compose';
  panel.appendChild(compose);

  document.body.appendChild(panel);

  _renderer = mountRenderer(messages, store);
  _composer = mountCompose(compose, store);

  _unsubHeader = store.subscribe(handleStoreEvent);
  syncHeader();

  _trayPill = createTrayPill();

  // Mutual exclusion: when the primary panel becomes visible, hide us.
  _unsubMainVisibility = on('opencode-panel:visibility', (isVisible) => {
    if (isVisible && _visible) setVisible(false);
  });
  // Also yield to Claude / Codex panels (they share the same right-edge slot).
  _unsubClaudeShow = on('claude-panel:show', () => {
    if (_visible) setVisible(false);
  });
  _unsubCodexVisibility = on('codex-panel:visibility', (visible) => {
    if (visible && _visible) setVisible(false);
  });

  function handleStoreEvent(event, s) {
    if (event?.type === 'server:status' && s?.serverStatus === 'ready' && hasRecoverableChildErrors(s)) {
      store.clearErrors?.();
      return;
    }
    syncHeader();
  }

  async function minimizeForegroundAgentPanels() {
    if (isClaudePanelOpen()) {
      try { await toggleClaudePanel(); } catch (err) {
        console.warn('[ocp-v2-childpanel] Failed to minimize Claude panel:', err);
      }
    }
    if (isCodexPanelOpen()) {
      try { await toggleCodexPanel(); } catch (err) {
        console.warn('[ocp-v2-childpanel] Failed to minimize Codex panel:', err);
      }
    }
  }

  async function showPanel() {
    if (_destroyed) return;
    if (_visible) {
      renderPill();
      return;
    }
    await minimizeForegroundAgentPanels();
    setVisible(true);
  }

  function setVisible(next) {
    if (_destroyed) return;
    next = !!next;
    if (next === _visible) {
      renderPill();
      return;
    }
    _visible = next;
    panel.classList.toggle('ocpv2-open', _visible);
    if (_visible) {
      // Ask the primary panel + sibling agents to hide.
      emit('opencode-child:show', { panelId, sessionId });
      reserveRightPanelLayout(PANEL_OWNER, panel, 20);
      state.lastActivePanel = 'opencode';
      if (typeof onShow === 'function') {
        try { onShow({ panelId, sessionId }); } catch {}
      }
    } else {
      clearRightPanelLayout(PANEL_OWNER);
    }
    renderPill();
    emit('opencode-child:visibility', { panelId, sessionId, visible: _visible });
    window.dispatchEvent(new Event('resize'));
  }

  function syncHeader() {
    if (_destroyed) return;
    const s = store.getState();
    if (_statusEl) {
      _statusEl.className = 'ocpv2-header-status';
      const taskLabel = currentTaskLabel(s);
      if (s.healing) {
        _statusEl.classList.add('ocpv2-status-healing');
        _statusEl.textContent = 'healing';
        _statusEl.removeAttribute('data-tooltip');
      } else if (s.running) {
        _statusEl.classList.add('ocpv2-status-running');
        _statusEl.textContent = taskLabel || 'running';
        if (taskLabel) _statusEl.setAttribute('data-tooltip', taskLabel);
        else _statusEl.removeAttribute('data-tooltip');
      } else if (s.serverStatus === 'reconnecting') {
        _statusEl.classList.add('ocpv2-status-reconnecting');
        _statusEl.textContent = 'reconnecting';
        _statusEl.removeAttribute('data-tooltip');
      } else if (s.errors.length || s.serverStatus === 'error') {
        _statusEl.classList.add('ocpv2-status-error');
        _statusEl.textContent = 'error';
        _statusEl.removeAttribute('data-tooltip');
      } else if (taskLabel) {
        // Idle but we know the agent's brief — keep it visible so the user
        // can tell at a glance what this sub-agent is for.
        _statusEl.classList.add('ocpv2-status-ready');
        _statusEl.textContent = taskLabel;
        _statusEl.setAttribute('data-tooltip', taskLabel);
      } else {
        _statusEl.classList.add('ocpv2-status-ready');
        _statusEl.textContent = 'idle';
        _statusEl.removeAttribute('data-tooltip');
      }
    }
    if (_titleEl && !_titleEl.querySelector('.ocpv2-rename-input')) {
      _titleEl.textContent = sessionTitleFor(store);
    }
    if (_renameBtn) _renameBtn.disabled = !s.sessionId;
    renderPill();
  }

  // Build the label shown in the header status badge. Priority:
  //   1. Currently-running tool name (most informative when active)
  //   2. Sub-agent brief from parent's tool input (subagent_type · summary)
  //   3. Session title fallback handled by the "idle" branch in syncHeader.
  function currentTaskLabel(s) {
    const tool = currentRunningToolName(s);
    if (tool) {
      const prefix = _taskInfo?.subagentType ? `${_taskInfo.subagentType} · ` : '';
      return truncate(`${prefix}${tool}`, 60);
    }
    if (_taskInfo?.subagentType && _taskInfo?.summary) {
      return truncate(`${_taskInfo.subagentType} · ${_taskInfo.summary}`, 60);
    }
    if (_taskInfo?.summary) return truncate(_taskInfo.summary, 60);
    if (_taskInfo?.subagentType) return _taskInfo.subagentType;
    return '';
  }

  function currentRunningToolName(s) {
    // Walk newest-first; find the most recent tool part still running.
    const order = s.messageOrder || [];
    for (let i = order.length - 1; i >= 0; i--) {
      const msg = s.messages?.get?.(order[i]);
      if (!msg?.parts) continue;
      let latest = null;
      for (const part of msg.parts.values()) {
        if (part?.type !== 'tool') continue;
        const status = part.state?.status || part.status;
        if (status !== 'running' && status !== 'pending') continue;
        const ts = part.state?.time?.start || part.time?.start || 0;
        if (!latest || ts >= (latest.state?.time?.start || latest.time?.start || 0)) latest = part;
      }
      if (latest) return String(latest.tool || latest.name || 'tool');
    }
    return '';
  }

  function truncate(value, max) {
    const text = String(value || '');
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function hasRecoverableChildErrors(s) {
    return (s?.errors || []).some((err) => {
      const msg = String(err?.message || err?.error || err || '').trim();
      if (!msg) return true;
      if (/rename failed/i.test(msg)) return false;
      return /websocket|closed|disconnect|offline|reconnect|request timeout|timeout|network|failed|server|session|opencode|send|boot|no session|not connected/i.test(msg);
    });
  }

  function buildPillElement() {
    const pill = document.createElement('div');
    pill.className = 'term-minimized-pill ocpv2-session-pill ocpv2-session-pill-child ocpv2-pill-spawning';
    pill.dataset.owner = PANEL_OWNER;
    pill.dataset.sessionId = sessionId;
    if (parentSessionId) pill.dataset.parentSessionId = parentSessionId;
    pill.setAttribute('data-tooltip', `Sub-agent of ${parentTitle}`);
    // Tray is right-anchored — above tooltips get clipped at the page edge for
    // the child pill which always sits adjacent to the active session pill.
    // Pop the tooltip to the LEFT instead.
    pill.setAttribute('data-tooltip-pos', 'left');
    pill.innerHTML = `
      <span class="term-minimized-pill-icon">${OPENCODE_ICON}</span>
      <span class="term-minimized-pill-label">↳ ${escapeHtml(sessionTitleFor(store))}</span>
      <span class="ocpv2-pill-badge" data-kind=""></span>
      <button class="term-minimized-pill-close" data-tooltip="Close" data-tooltip-pos="left">&times;</button>
    `;
    pill.addEventListener('click', (event) => {
      if (event.target.closest('.term-minimized-pill-close')) return;
      showPanel();
    });
    pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', (event) => {
      event.stopPropagation();
      destroy();
    });
    // Drop the spawn glow after the entrance animation finishes so subsequent
    // hover states aren't overridden.
    setTimeout(() => { if (pill.isConnected) pill.classList.remove('ocpv2-pill-spawning'); }, 1600);
    return pill;
  }

  function attachPillToTray(pill) {
    const tray = document.getElementById('term-minimized-tray');
    if (!tray) return false;
    const parentPill = parentSessionId
      ? tray.querySelector(`.ocpv2-session-pill[data-session-id="${cssEscape(parentSessionId)}"]:not(.ocpv2-session-pill-child)`)
      : null;
    if (parentPill && parentPill.parentElement === tray) {
      parentPill.insertAdjacentElement('afterend', pill);
    } else {
      tray.appendChild(pill);
    }
    syncDockedClasses();
    return true;
  }

  // Docking styles (squared corner, -5px overlap, no right margin) only make
  // sense when the child pill is physically below its parent. When the parent
  // panel is open (parent not in the tray) the child stands alone and must
  // render as a normal pill — otherwise the squared-off top-right corner and
  // negative margin produce a broken half-rectangle floating into the tray's
  // edge. Toggle both `.ocpv2-pill-docked` (child) and `.ocpv2-pill-parent-
  // docked` (parent) based on actual adjacency.
  function syncDockedClasses() {
    if (!_trayPill) return;
    const tray = _trayPill.parentElement;
    let parentPill = null;
    if (tray && parentSessionId) {
      parentPill = tray.querySelector(
        `.ocpv2-session-pill[data-session-id="${cssEscape(parentSessionId)}"]:not(.ocpv2-session-pill-child)`
      );
    }
    const docked = !!parentPill && parentPill.nextElementSibling === _trayPill;
    _trayPill.classList.toggle('ocpv2-pill-docked', docked);
    if (parentPill) {
      parentPill.classList.toggle('ocpv2-pill-parent-docked', docked);
      // If the parent pill appeared in the tray after the child (panel
      // minimized later), the manager's one-shot markParentPillChildAttached
      // wouldn't have fired. Stamp the has-child class here so the ↳ marker
      // and the squared corner stay in lockstep.
      parentPill.classList.add('ocpv2-pill-has-child');
    }
  }

  function createTrayPill() {
    if (_destroyed) return null;
    const pill = buildPillElement();
    if (attachPillToTray(pill)) return pill;
    // Tray not in the DOM yet (panel never opened). Retry briefly so the pill
    // appears the moment the tray is built. Without this, a sub-agent that
    // spawns before the user first opens the OpenCode panel produces no pill.
    let tries = 0;
    const timer = setInterval(() => {
      if (_destroyed || pill.isConnected) { clearInterval(timer); return; }
      if (attachPillToTray(pill) || ++tries > 60) clearInterval(timer);
    }, 250);
    return pill;
  }

  function cssEscape(value) {
    return String(value).replace(/(["\\])/g, '\\$1');
  }

  // Keep the child pill positioned immediately after its parent pill so the
  // parent/child relationship reads at a glance — even if other tab pills get
  // appended to the tray later.
  function ensureAdjacentToParent() {
    if (!_trayPill || !parentSessionId) return;
    const tray = _trayPill.parentElement;
    if (!tray) {
      syncDockedClasses();
      return;
    }
    const parentPill = tray.querySelector(
      `.ocpv2-session-pill[data-session-id="${cssEscape(parentSessionId)}"]:not(.ocpv2-session-pill-child)`
    );
    if (parentPill && parentPill.parentElement === tray && parentPill.nextElementSibling !== _trayPill) {
      parentPill.insertAdjacentElement('afterend', _trayPill);
    }
    syncDockedClasses();
  }

  function renderPill() {
    if (!_trayPill) return;
    const s = store.getState();
    const labelEl = _trayPill.querySelector('.term-minimized-pill-label');
    if (labelEl) labelEl.textContent = `↳ ${sessionTitleFor(store)}`;
    _trayPill.classList.toggle('ocpv2-pill-running', !!s.running);
    ensureAdjacentToParent();

    // Surface attention signals: pending question / permission / error / done.
    // Without these, a minimized child agent waiting for input is invisible.
    const badge = _trayPill.querySelector('.ocpv2-pill-badge');
    if (badge) {
      const qCount = (s.pendingQuestions || []).length;
      const permPending = !!s.pendingPermission;
      const errCount = (s.errors || []).length;
      const taskLabel = currentTaskLabel(s);
      const taskSuffix = taskLabel ? ` — ${taskLabel}` : '';
      let kind = '';
      let text = '';
      let tooltip = `Sub-agent of ${parentTitle}${taskSuffix}`;
      if (permPending) {
        kind = 'permission'; text = '!'; tooltip = `Sub-agent: permission required${taskSuffix}`;
      } else if (qCount > 0) {
        kind = 'question'; text = qCount > 1 ? String(qCount) : '?';
        tooltip = qCount > 1 ? `Sub-agent: ${qCount} questions${taskSuffix}` : `Sub-agent: question waiting${taskSuffix}`;
      } else if (errCount > 0) {
        kind = 'error'; text = '!'; tooltip = `Sub-agent: error — open to review${taskSuffix}`;
      } else if (!s.running && (s.messageOrder || []).length > 0) {
        kind = 'done'; text = '✓'; tooltip = `Sub-agent finished — open to review${taskSuffix}`;
      }
      badge.textContent = text;
      badge.dataset.kind = kind;
      badge.style.display = kind ? '' : 'none';
      _trayPill.setAttribute('data-tooltip', tooltip);
    }

    // Pill visible only when panel is hidden (mirrors primary panel behavior).
    _trayPill.style.display = _visible ? 'none' : '';
  }

  function beginRenameSession() {
    const s = store.getState();
    if (!s.sessionId || !_titleEl) return;
    if (_titleEl.querySelector('.ocpv2-rename-input')) {
      _titleEl.querySelector('.ocpv2-rename-input').focus();
      return;
    }
    const currentTitle = sessionTitleFor(store);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ocpv2-rename-input';
    input.value = currentTitle === 'sub-agent' ? '' : currentTitle;
    input.placeholder = 'Sub-agent name…';
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    _titleEl.textContent = '';
    _titleEl.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const restoreLabel = () => {
      if (_titleEl.contains(input)) _titleEl.textContent = sessionTitleFor(store);
    };
    const finish = async (cancel = false) => {
      if (finished) return;
      finished = true;
      const next = input.value.trim();
      if (cancel || !next || next === currentTitle) { restoreLabel(); return; }
      try {
        await api.sessionUpdate(s.sessionId, { title: next });
        const updated = { ...(s.sessionInfo || {}), id: s.sessionId, title: next };
        store.setSession(s.sessionId, updated);
      } catch (err) {
        console.warn('[ocp-v2-childpanel] rename failed', err);
        store.pushError({ message: err?.message || 'Rename failed' });
        restoreLabel();
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(false); }
      if (event.key === 'Escape') { event.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', () => finish(false));
  }

  function destroy() {
    if (_destroyed) return;
    _destroyed = true;
    try { _unsubHeader?.(); } catch {}
    try { _unsubMainVisibility?.(); } catch {}
    try { _unsubClaudeShow?.(); } catch {}
    try { _unsubCodexVisibility?.(); } catch {}
    try { _renderer?.unmount?.(); } catch {}
    try { _composer?.unmount?.(); } catch {}
    try { _contextGauge?.destroy?.(); } catch {}
    try { _compactButton?.destroy?.(); } catch {}
    if (_trayPill?.isConnected) {
      // Clear parent's docked corner-squaring before removing the child so the
      // parent pill snaps back to a fully-rounded standalone pill.
      const tray = _trayPill.parentElement;
      if (tray && parentSessionId) {
        const parentPill = tray.querySelector(
          `.ocpv2-session-pill[data-session-id="${cssEscape(parentSessionId)}"]:not(.ocpv2-session-pill-child)`
        );
        parentPill?.classList.remove('ocpv2-pill-parent-docked');
      }
      _trayPill.remove();
    }
    clearRightPanelLayout(PANEL_OWNER);
    panel.remove();
    if (typeof onClose === 'function') {
      try { onClose(panelId); } catch {}
    }
  }

  function setTaskInfo(next) {
    if (!next) return;
    const merged = {
      subagentType: String(next.subagentType || _taskInfo?.subagentType || '').trim(),
      summary: String(next.summary || _taskInfo?.summary || '').trim(),
    };
    if (!merged.subagentType && !merged.summary) return;
    _taskInfo = merged;
    syncHeader();
  }

  return {
    panelId,
    sessionId,
    panel,
    store,
    isVisible: () => _visible,
    show: showPanel,
    hide: () => setVisible(false),
    setTaskInfo,
    unmount: destroy,
  };
}

function sessionTitleFor(store) {
  const s = store.getState();
  const info = s.sessionInfo || {};
  return String(info.title || info.slug || (s.sessionId ? s.sessionId.slice(0, 8) : 'sub-agent')).trim() || 'sub-agent';
}

function wireResize(panel, handle, owner) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.offsetWidth;
    let pendingW = startW;
    let rafId = 0;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const applyWidth = () => {
      rafId = 0;
      pendingW = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, pendingW));
      panel.style.width = pendingW + 'px';
      if (panel.classList.contains('ocpv2-open')) {
        reserveRightPanelLayout(owner, panel, 20);
      }
    };
    const onMove = (ev) => {
      const diff = startX - ev.clientX;
      pendingW = startW + diff;
      if (!rafId) rafId = requestAnimationFrame(applyWidth);
    };
    const onUp = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      applyWidth();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = '';
      window.dispatchEvent(new Event('resize'));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
