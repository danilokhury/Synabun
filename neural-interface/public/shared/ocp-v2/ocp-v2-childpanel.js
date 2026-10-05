// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — Child sub-agent sidepanel
// A peer of the primary OCP v2 panel, bound to one sub-agent session. Every
// sub-agent session has one of its own (ocp-v2-manager.js keeps the set):
//   • Spawns minimized (pill in tray, panel hidden); nothing opens by itself
//   • Stays live while it is off screen: its store follows its session
//   • Its own store, composer, queue, cards, confirmations, binding and turns
//   • One OpenCode panel is on screen at a time: it shows and hides itself
//     only by asking the manager (decideVisibility in ocp-v2-subagents-logic.js)
//   • Shares the primary's docked/floating mode, position, and size
//   • Header has the chain of parents, minimize / close / slide / rename
//   • Minimize hides the panel and keeps the pill. Close removes the panel
//     and the pill (asked first while something unsent is in its compose
//     box). Neither deletes nor stops the sub-agent session.
// The panel's DOM (transcript, compose box) is built the first time it is
// shown: a session with many sub-agents costs a store and a pill each.
// ─────────────────────────────────────────────────────────────────────────────

import { state, emit } from '../state.js';
import { injectStyles } from './ocp-v2-styles.js';
import { mountRenderer } from './ocp-v2-render.js';
import { mountCompose } from './ocp-v2-send.js';
import { trackContextGauge } from './ocp-v2-context-gauge.js';
import { mountContextMenu } from './ocp-v2-context-menu.js';
import { createCompactControl } from './ocp-v2-compact-button.js';
import { registerSidepanel, setSidepanelVisible, syncSidepanelLayout, focusSidepanel } from '../ui-sidepanel-windows.js';
import { api } from './ocp-v2-ws.js';
import { captureBinding } from './ocp-v2-binding.js';
import { renameSession, renameBox } from './ocp-v2-session-actions.js';
import { createConfirmations } from './ocp-v2-confirm-logic.js';
import { syncConfirmRow } from './ocp-v2-confirm.js';
import { samePrompts } from './ocp-v2-composer-logic.js';
import { pillState, closeSubagentConfirm } from './ocp-v2-subagents-logic.js';

const ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_MINIMIZE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>';
const ICON_SLIDE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
const OPENCODE_ICON = '<svg viewBox="0 0 24 30" fill="currentColor"><path d="M18 6H6V24H18V6ZM24 30H0V0H24V30Z"/></svg>';

// What the manager hands in besides the session:
//   getChain()            the parents, from the session in the main panel down
//                         to the direct parent: [{ sessionId, title }]
//   depth                 0 for a sub-agent of that session, 1 for one of its sub-agents, …
//   announce              a sub-agent that just started (the pill's entrance), not a rebuilt one
//   onRequestView(req)    show / hide through the one visibility decision
//   onVisibility(visible) the shared controller put the panel on or off screen
//   onOpenAncestor(id)    a crumb of a parent that is a sub-agent itself
//   onOpenChild(id)       "Open sub-agent" on a task card of this transcript
//   onStateChange()       what the pill says changed
//   onClose(panelId, { byUser, waiting, label })
//   started               the sub-agent ran before this page knew it (a pill rebuilt after a reload)
//   onUndelivered(item, { error })
//                         a prompt that was on its way when this panel went, and whose send then failed
//   takeUnsent()          such prompts, kept for this sub-agent since: back into the compose box
// Without a manager (onRequestView) the panel talks to the shared controller itself.
export function createChildPanel({
  panelId, sessionId, store, parentPanelId, parentSessionId = '', rootSessionId = parentSessionId, parentTitle = 'parent',
  getChain = null, depth = 0, taskInfo = null, announce = true,
  onClose, onShow, onRequestView, onVisibility, onOpenAncestor, onOpenChild, onStateChange,
  started = false, onUndelivered, takeUnsent,
}) {
  injectStyles();

  const PANEL_OWNER = panelId;
  let _visible = false;
  let _built = false;
  let _trayPill = null;
  let _pillLabel = null;
  let _pillBadge = null;
  let _statusEl = null;
  let _titleEl = null;
  let _renameBtn = null;
  let _crumbsEl = null;
  let _confirmSlotEl = null;
  let _renderer = null;
  let _composer = null;
  let _contextGauge = null;
  let _compactControl = null;
  let _contextMenu = null;
  let _unsubHeader = null;
  let _unregisterPresentation = null;
  let _destroyed = false;
  let _taskInfo = taskInfo && (taskInfo.subagentType || taskInfo.summary) ? { ...taskInfo } : null;
  // What this panel publishes or destroys is asked here, on this panel's own
  // store, in two steps (ocp-v2-confirm-logic.js): one question per panel, and
  // a question of one sub-agent's panel never answers for another's.
  const _confirms = createConfirmations({ store });
  _confirms.onChange(() => syncConfirmRow(_confirms, _confirmSlotEl, 'panel'));

  // The panel element exists from the start (its id is the shared controller's
  // owner); what is inside is built the first time it is shown.
  const panel = document.createElement('div');
  panel.id = panelId;
  panel.className = 'ocpv2-panel ocpv2-panel-child';

  _trayPill = buildPillElement();
  _unsubHeader = store.subscribe(handleStoreEvent);
  renderPill();

  // ── DOM ──────────────────────────────────────────────────────────────────
  function build() {
    if (_built || _destroyed) return;
    _built = true;
    // Same right slot as the primary panel — they mutually exclude visibility,
    // so we don't need an offset variable.

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'ocpv2-resize-handle';
    panel.appendChild(resizeHandle);

    const header = document.createElement('div');
    header.className = 'ocpv2-header';

    // The chain of parents (replaces the session-menu dropdown — a sub-agent
    // panel has only one session). The first crumb is the session in the main
    // panel; one after it is a sub-agent that has this one as its sub-agent.
    _crumbsEl = document.createElement('div');
    _crumbsEl.className = 'ocpv2-child-crumbs';
    header.appendChild(_crumbsEl);

    // The title sits in the main panel's session chip, joined to the rename
    // pencil. It is not a button: there is no menu behind it.
    const titleChip = document.createElement('div');
    titleChip.className = 'ocpv2-session-btn ocpv2-session-btn-static';
    const titleLabel = document.createElement('span');
    titleLabel.className = 'ocpv2-session-label ocpv2-child-title';
    titleLabel.textContent = sessionTitleFor(store);
    titleChip.appendChild(titleLabel);
    header.appendChild(titleChip);
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

    // The sub-agent's state. Not a header piece: it is mounted in the footer
    // toolbar below, once the composer has built that row.
    const status = document.createElement('div');
    status.className = 'ocpv2-footer-status';
    status.textContent = '…';
    _statusEl = status;

    const actions = document.createElement('div');
    actions.className = 'ocpv2-actions';

    // "New session" → opens the primary panel with a fresh top-level session.
    const newBtn = document.createElement('button');
    newBtn.className = 'ocpv2-btn ocpv2-btn-new';
    newBtn.type = 'button';
    newBtn.title = 'New session in main panel';
    newBtn.setAttribute('data-tooltip', 'New session in main panel');
    newBtn.innerHTML = ICON_PLUS;
    newBtn.addEventListener('click', () => {
      showMainPanel();
      emit('opencode-panel:request-new-session');
    });
    actions.appendChild(newBtn);

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'ocpv2-btn ocpv2-btn-minimize';
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
    closeBtn.addEventListener('click', () => { requestClose(); });
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

    // Context settings: the cog in the header and its popover, on this
    // sub-agent's own store. The gauge only keeps the store's reading current.
    _contextGauge = trackContextGauge(store);
    _compactControl = createCompactControl(store);
    _contextMenu = mountContextMenu(actions, panel, store, {
      compact: _compactControl,
      agent: () => _taskInfo?.subagentType || '',
    });

    const messagesContainer = document.createElement('div');
    messagesContainer.className = 'ocpv2-messages-container';
    const messages = document.createElement('div');
    messages.className = 'ocpv2-messages';
    messagesContainer.appendChild(messages);
    panel.appendChild(messagesContainer);

    // This panel's own questions (closing it with prompts waiting, deleting a
    // message) show above its compose box.
    _confirmSlotEl = document.createElement('div');
    _confirmSlotEl.className = 'ocpv2-confirm-slot';
    panel.appendChild(_confirmSlotEl);

    const compose = document.createElement('div');
    compose.className = 'ocpv2-compose';
    panel.appendChild(compose);

    document.body.appendChild(panel);
    _unregisterPresentation = registerSidepanel({
      owner: PANEL_OWNER, provider: 'opencode', element: panel,
      header, actions, buttonClass: 'ocpv2-btn', dockHandle: resizeHandle, applyVisibility,
    });

    _renderer = mountRenderer(messages, store, {
      // A task card of this transcript is a sub-agent of this sub-agent.
      onOpenChild: typeof onOpenChild === 'function' ? (childSessionId) => onOpenChild(childSessionId) : undefined,
      // Deleting a message is asked above this panel's compose box; the second click deletes.
      confirm: (question) => _confirms.ask({ surface: 'panel', ...question }),
    });
    // Opt out of the model/variant pickers: they are module-level singletons and
    // mounting them here would yank them out of the main panel's footer. The
    // child runs as a sub-agent of the parent session and inherits its model.
    _composer = mountCompose(compose, store, {
      pickers: false,
      onBeforeSend: () => _renderer?.scrollToBottom({ force: true }),
      // A prompt of this panel that was on its way when the panel went, and
      // then failed: the manager keeps it for this sub-agent.
      onUndelivered: (item, detail) => { if (typeof onUndelivered === 'function') onUndelivered(item, detail); },
    });
    // The state reads in the footer toolbar's left group, as in the main panel
    // (the compose card itself when that row is not there).
    (compose.querySelector('.ocpv2-footer-left') || compose).appendChild(status);
    restoreUnsent();

    syncHeader();
  }

  function handleStoreEvent(event, s) {
    if (event?.type === 'server:status' && s?.serverStatus === 'ready' && hasRecoverableChildErrors(s)) {
      store.clearErrors?.();
      return;
    }
    syncHeader();
    if (typeof onStateChange === 'function') {
      try { onStateChange(); } catch {}
    }
  }

  // Showing and hiding go through the manager: it asks the one function that
  // decides which OpenCode panels are on screen, and calls applyRequested().
  function setVisible(next) {
    if (_destroyed) return;
    if (typeof onRequestView === 'function') onRequestView(next ? { show: panelId } : { hide: panelId });
    else applyRequested(next);
  }

  function showPanel() {
    if (_destroyed) return;
    if (_visible) {
      focusSidepanel(PANEL_OWNER);
      renderPill();
      return;
    }
    setVisible(true);
  }

  // The decision, carried out: the shared controller shows or hides the panel
  // (and, shown, takes the slot from whatever other provider had it).
  function applyRequested(next) {
    if (_destroyed) return;
    next = !!next;
    if (next) build();
    if (!_built) return;
    setSidepanelVisible(PANEL_OWNER, next);
  }

  // The session in the main panel: the main panel takes the slot.
  function showMainPanel() {
    if (typeof onRequestView !== 'function') applyRequested(false);
    emit('opencode-panel:request-show');
  }

  function applyVisibility(next) {
    if (_destroyed) return;
    next = !!next;
    if (next === _visible) {
      renderPill();
      return;
    }
    _visible = next;
    panel.classList.toggle('ocpv2-open', _visible);
    // The popover is a child of <body>: it does not go with the panel by itself.
    if (!_visible) _contextMenu?.close();
    if (_visible) {
      // Presentation controller has already hidden the other OpenCode view.
      emit('opencode-child:show', { panelId, sessionId });
      state.lastActivePanel = 'opencode';
      if (typeof onShow === 'function') {
        try { onShow({ panelId, sessionId }); } catch {}
      }
    }
    syncSidepanelLayout(PANEL_OWNER);
    syncHeader();
    emit('opencode-child:visibility', { panelId, sessionId, visible: _visible });
    if (typeof onVisibility === 'function') {
      try { onVisibility(_visible); } catch {}
    }
    window.dispatchEvent(new Event('resize'));
  }

  function chain() {
    let list = null;
    if (typeof getChain === 'function') {
      try { list = getChain(); } catch { list = null; }
    }
    if (Array.isArray(list) && list.length) return list;
    return [{ sessionId: parentSessionId, title: parentTitle }];
  }

  // One crumb per parent. Rebuilt only when the chain or a title changed.
  let _crumbsKey = '';
  function renderCrumbs() {
    if (!_crumbsEl) return;
    const parents = chain();
    const key = JSON.stringify(parents.map((p) => [p.sessionId, p.title]));
    if (key === _crumbsKey) return;
    _crumbsKey = key;
    _crumbsEl.replaceChildren();
    parents.forEach((parent, index) => {
      if (index) {
        const sep = document.createElement('span');
        sep.className = 'ocpv2-child-crumb-sep';
        sep.textContent = '›';
        _crumbsEl.appendChild(sep);
      }
      const title = String(parent.title || 'parent');
      const crumb = document.createElement('button');
      crumb.type = 'button';
      // (The first crumb keeps the class the single parent link had.)
      crumb.className = index ? 'ocpv2-child-crumb' : 'ocpv2-child-crumb ocpv2-child-parent-link';
      crumb.dataset.sessionId = String(parent.sessionId || '');
      crumb.setAttribute('data-tooltip', index ? `Open sub-agent ${title}` : `Back to ${title}`);
      if (!index) {
        const arrow = document.createElement('span');
        arrow.className = 'ocpv2-child-parent-arrow';
        arrow.textContent = '↳';
        crumb.appendChild(arrow);
      }
      const label = document.createElement('span');
      label.className = 'ocpv2-child-parent-label';
      label.textContent = title;
      crumb.appendChild(label);
      crumb.addEventListener('click', () => {
        if (!index || typeof onOpenAncestor !== 'function') showMainPanel();
        else onOpenAncestor(parent.sessionId);
      });
      _crumbsEl.appendChild(crumb);
    });
  }

  function syncHeader() {
    if (_destroyed) return;
    const s = store.getState();
    if (_statusEl) {
      _statusEl.className = 'ocpv2-footer-status';
      const taskLabel = currentTaskLabel(s);
      if (s.healing) {
        _statusEl.classList.add('ocpv2-status-healing');
        _statusEl.textContent = 'healing';
        _statusEl.removeAttribute('data-tooltip');
      } else if ((s.pendingPermissions || []).length || (s.pendingQuestions || []).length) {
        _statusEl.classList.add('ocpv2-status-awaiting');
        _statusEl.textContent = (s.pendingPermissions || []).length ? 'awaiting permission' : 'awaiting answer';
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
    renderCrumbs();
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

  // The pill. The manager puts it into the tray (in the group of its parent
  // session, in the order the sub-agents were started) and takes it out while
  // the main panel is on another session; this panel says what it shows.
  function buildPillElement() {
    const pill = document.createElement('div');
    pill.classList.add('term-minimized-pill', 'ocpv2-session-pill', 'ocpv2-session-pill-child');
    if (announce) pill.classList.add('ocpv2-pill-spawning');
    pill.dataset.owner = PANEL_OWNER;
    pill.dataset.sessionId = sessionId;
    if (parentSessionId) pill.dataset.parentSessionId = parentSessionId;
    if (rootSessionId) pill.dataset.rootSessionId = rootSessionId;
    pill.dataset.depth = String(Math.max(0, Math.min(3, Number(depth) || 0)));
    // Tray is right-anchored — above tooltips get clipped at the page edge.
    // Pop the tooltip to the LEFT instead.
    pill.setAttribute('data-tooltip-pos', 'left');
    const icon = document.createElement('span');
    icon.className = 'term-minimized-pill-icon';
    icon.innerHTML = OPENCODE_ICON;
    _pillLabel = document.createElement('span');
    _pillLabel.className = 'term-minimized-pill-label';
    _pillBadge = document.createElement('span');
    _pillBadge.className = 'ocpv2-pill-badge';
    _pillBadge.dataset.kind = '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'term-minimized-pill-close';
    close.setAttribute('data-tooltip', 'Close');
    close.setAttribute('data-tooltip-pos', 'left');
    close.textContent = '×';
    pill.append(icon, _pillLabel, _pillBadge, close);
    // A click shows this sub-agent's panel; on the pill of the panel that is
    // on screen it minimizes it (as the main panel's pill does).
    pill.addEventListener('click', (event) => {
      if (event.target?.closest?.('.term-minimized-pill-close')) return;
      if (_visible) setVisible(false);
      else showPanel();
    });
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      requestClose();
    });
    if (announce) {
      // Drop the spawn glow after the entrance animation finishes so subsequent
      // hover states aren't overridden.
      setTimeout(() => { if (!_destroyed) pill.classList.remove('ocpv2-pill-spawning'); }, 1600);
    }
    return pill;
  }

  // What the pill says: running, waiting for an answer, done or failed, and
  // whether this sub-agent's panel is the one on screen (pillState).
  function renderPill() {
    if (!_trayPill || _destroyed) return;
    const s = store.getState();
    const said = pillState(s, { visible: _visible, started });
    const arrows = '↳'.repeat(Math.max(1, Math.min(3, (Number(depth) || 0) + 1)));
    _pillLabel.textContent = `${arrows} ${sessionTitleFor(store)}`;
    _trayPill.classList.toggle('ocpv2-pill-running', said.state === 'running');
    _trayPill.classList.toggle('ocpv2-pill-waiting', said.state === 'waiting');
    _trayPill.classList.toggle('ocpv2-pill-failed', said.state === 'failed');
    _trayPill.classList.toggle('ocpv2-pill-shown', said.shown);
    _trayPill.dataset.state = said.state;
    _trayPill.dataset.shown = said.shown ? '1' : '';
    _pillBadge.textContent = said.text;
    _pillBadge.dataset.kind = said.kind;

    const taskLabel = currentTaskLabel(s);
    const taskSuffix = taskLabel ? ` — ${taskLabel}` : '';
    const of = chain().map((p) => String(p.title || 'parent')).join(' › ');
    let tooltip = `Sub-agent of ${of}${taskSuffix}`;
    if (said.kind === 'permission') tooltip = `Sub-agent: permission required${taskSuffix}`;
    else if (said.kind === 'question') tooltip = (s.pendingQuestions || []).length > 1 ? `Sub-agent: ${s.pendingQuestions.length} questions${taskSuffix}` : `Sub-agent: question waiting${taskSuffix}`;
    else if (said.state === 'failed') tooltip = `Sub-agent: error — open to review${taskSuffix}`;
    else if (said.state === 'done') tooltip = `Sub-agent finished — open to review${taskSuffix}`;
    if (said.shown) tooltip = `${tooltip} (on screen: click to minimize)`;
    _trayPill.setAttribute('data-tooltip', tooltip);
  }

  function beginRenameSession() {
    const s = store.getState();
    if (!s.sessionId || !_titleEl) return;
    if (_titleEl.querySelector('.ocpv2-rename-input')) {
      _titleEl.querySelector('.ocpv2-rename-input').focus();
      return;
    }
    // A sub-agent panel stays on one session, but the rule is the same as
    // everywhere (ocp-v2-binding.js): the session being renamed is captured
    // when the box opens, not read from the live state when it closes.
    const target = captureBinding(store);
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

    const restoreLabel = () => {
      if (_titleEl.contains(input)) _titleEl.textContent = sessionTitleFor(store);
    };
    // The box goes once it is answered, also after a rename that worked
    // (renameBox): the next Rename opens a fresh one.
    const finish = renameBox({
      currentTitle,
      read: () => input.value,
      rename: (next) => renameSession(store, api, next, { binding: target }),
      after: (result) => {
        if (result.ok) return;
        console.warn('[ocp-v2-childpanel] rename failed', result.error);
        if (result.current) store.pushError({ message: result.error || 'Rename failed' });
      },
      restore: restoreLabel,
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(false); }
      if (event.key === 'Escape') { event.preventDefault(); finish(true); }
    });
    input.addEventListener('blur', () => finish(false));
  }

  // What this panel's compose box still holds unsent: its queue (and what is
  // parked for its session) and the draft in the box. Nothing is removed.
  function heldPrompts() {
    if (!_composer) return [];
    const waiting = [...(_composer.waitingFor?.(sessionId) || [])];
    const draft = _composer.draft?.();
    if (draft) waiting.push(draft);
    return waiting;
  }

  // ...and what is on its way. A prompt belongs to its panel until OpenCode
  // has accepted it: one that is being sent counts as unsent, so closing asks.
  function waitingPrompts() {
    if (!_composer) return [];
    return [...(_composer.sending?.() || []), ...heldPrompts()];
  }

  // Prompts that were kept for this sub-agent while it had no panel (each was
  // on its way when the panel went, and its send failed): back in the box,
  // with their attachments.
  function restoreUnsent() {
    if (!_composer || _destroyed || typeof takeUnsent !== 'function') return;
    let items = [];
    try { items = takeUnsent() || []; } catch { items = []; }
    for (const item of items) _composer.putBack?.(item);
  }

  // Close: the panel and its pill go; the sub-agent session is neither deleted
  // nor stopped. Closing discards what is unsent in this panel's compose box,
  // so the user is asked first, here, and shown which (never a native dialog).
  // The answer counts for what the question listed: when something else is
  // waiting by the time the button is clicked, it is asked again.
  async function mayClose() {
    for (;;) {
      const waiting = waitingPrompts();
      const text = closeSubagentConfirm({ items: waiting, label: sessionTitleFor(store) });
      if (!text) return true;
      // Asked from the pill while the panel is off screen: the question is shown.
      if (!_visible) showPanel();
      if (!(await _confirms.ask({ key: `subagent-close:${sessionId}`, surface: 'panel', text, confirmLabel: 'Close and discard' }))) return false;
      if (_destroyed) return false;
      // The answer counts for what the question said: the same prompts, and
      // the same ones on their way. A prompt whose send failed meanwhile is
      // unsent in this panel now, and closing would discard it: asked again.
      const now = waitingPrompts();
      const onTheirWay = (list) => list.filter((item) => item?.sending);
      if (samePrompts(now, waiting) && samePrompts(onTheirWay(now), onTheirWay(waiting))) return true;
    }
  }

  async function requestClose() {
    if (_destroyed) return false;
    if (!(await mayClose())) return false;
    destroy({ byUser: true });
    return true;
  }

  // `byUser`: the user closed the panel (and was asked, when something was
  // unsent). Without it the panel goes because its session, or its parent's,
  // went: nobody was asked, and what was waiting here is handed to onClose.
  function destroy({ byUser = false } = {}) {
    if (_destroyed) return;
    // (A prompt that is on its way is not among them: its send is still out.
    // If it fails, the composer hands it over then: onUndelivered.)
    const waiting = byUser ? [] : heldPrompts();
    const label = sessionTitleFor(store);
    try { _unregisterPresentation?.(); } catch {}
    _destroyed = true;
    _confirms.destroy();
    try { _unsubHeader?.(); } catch {}
    try { _renderer?.unmount?.(); } catch {}
    try { _composer?.unmount?.(); } catch {}
    try { _contextMenu?.destroy?.(); } catch {}
    try { _contextGauge?.destroy?.(); } catch {}
    try { _compactControl?.destroy?.(); } catch {}
    try { _trayPill?.remove(); } catch {}
    panel.remove();
    if (typeof onClose === 'function') {
      try { onClose(panelId, { byUser, waiting, label }); } catch {}
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
    parentSessionId,
    rootSessionId,
    panel,
    pill: _trayPill,
    store,
    isVisible: () => _visible,
    isBuilt: () => _built,
    title: () => sessionTitleFor(store),
    pillState: () => pillState(store.getState(), { visible: _visible, started }),
    focus: () => { focusSidepanel(PANEL_OWNER); _composer?.focus(); },
    appendPath: path => _composer?.appendPath(path) ?? false,
    show: showPanel,
    hide: () => setVisible(false),
    applyRequested,
    refresh: syncHeader,
    waiting: waitingPrompts,
    restoreUnsent,
    requestClose,
    setTaskInfo,
    unmount: destroy,
  };
}

function sessionTitleFor(store) {
  const s = store.getState();
  const info = s.sessionInfo || {};
  return String(info.title || info.slug || (s.sessionId ? s.sessionId.slice(0, 8) : 'sub-agent')).trim() || 'sub-agent';
}
