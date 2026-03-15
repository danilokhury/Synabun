// ═══════════════════════════════════════════
// SynaBun Neural Interface — Terminal Linking (Relay/Mediator)
// ═══════════════════════════════════════════
//
// Floating Link Panel that mediates turn-based conversations
// between AI agents (Claude Code, Codex, Gemini, etc.) via linked
// terminal sessions. Users can inject messages, control auto-relay,
// and watch agents collaborate in real-time.

import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';
import {
  fetchTerminalSessions, fetchTerminalLinks, fetchTerminalLink,
  createTerminalLink, deleteTerminalLink, updateTerminalLink,
  sendLinkMessage, pauseLink, resumeLink, nudgeLink,
} from './api.js';

// ── SVG Icons ──
const SVG_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
const SVG_UNLINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-3 3"/><path d="M5.16 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l3-3"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
const SVG_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const SVG_SKIP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const SVG_MIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const SVG_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

// Profile metadata (mirror of ui-terminal.js PROFILES)
const PROFILE_META = {
  'claude-code': { label: 'Claude Code', color: '#D4A27F' },
  'codex':       { label: 'Codex CLI',   color: '#74c7a5' },
  'gemini':      { label: 'Gemini CLI',  color: '#669DF6' },
  'shell':       { label: 'Shell',       color: '#aaaaaa' },
  'browser':     { label: 'Browser',     color: '#4fc3f7' },
};

// ── Module State ──
let _panel = null;          // floating panel DOM element
let _activeLink = null;     // current link ID
let _history = [];          // local copy of conversation history
let _minimized = false;
let _visible = false;

// Drag state
let _dragState = null;
// Resize state
let _resizeState = null;

/**
 * Open the Link Panel. If no link exists, shows setup view.
 */
export async function openLinkPanel() {
  console.log('[link-panel] openLinkPanel called, _panel=', !!_panel, '_visible=', _visible);
  if (_panel) {
    _panel.style.display = '';
    _visible = true;
    return;
  }
  _buildPanel();
  _visible = true;

  // Check for existing links
  try {
    const data = await fetchTerminalLinks();
    const links = data?.links || [];
    console.log('[link-panel] existing links:', links.length);
    if (links.length > 0) {
      _activeLink = links[0].id;
      await _loadLink(_activeLink);
    } else {
      await _showSetupView();
    }
  } catch (err) {
    console.error('[link-panel] Error checking links:', err);
    await _showSetupView();
  }
}

/**
 * Toggle the Link Panel visibility.
 */
export function toggleLinkPanel() {
  if (_visible) {
    closeLinkPanel();
  } else {
    openLinkPanel();
  }
}

/**
 * Close (hide) the Link Panel without destroying the link.
 */
export function closeLinkPanel() {
  if (_panel) {
    _panel.style.display = 'none';
    _visible = false;
  }
}

// ── Panel Construction ──

function _buildPanel() {
  _panel = document.createElement('div');
  _panel.className = 'link-panel';

  // Restore saved position/size
  let savedPos = null, savedSize = null;
  try { savedPos = JSON.parse(storage.getItem(KEYS.LINK_PANEL_POS)); } catch {}
  try { savedSize = JSON.parse(storage.getItem(KEYS.LINK_PANEL_SIZE)); } catch {}

  _panel.style.left = savedPos?.x ? `${savedPos.x}px` : '50%';
  _panel.style.top = savedPos?.y ? `${Math.max(48, savedPos.y)}px` : '50%';
  if (!savedPos) _panel.style.transform = 'translate(-50%, -50%)';
  _panel.style.width = savedSize?.w ? `${savedSize.w}px` : '480px';
  _panel.style.height = savedSize?.h ? `${savedSize.h}px` : '560px';

  _panel.innerHTML = `
    <div class="link-panel-header">
      <span class="link-panel-icon">${SVG_LINK}</span>
      <span class="link-panel-title">Terminal Link</span>
      <div class="link-panel-actions">
        <button class="link-panel-btn" data-action="minimize" title="Minimize">${SVG_MIN}</button>
        <button class="link-panel-btn" data-action="close" title="Close">${SVG_CLOSE}</button>
      </div>
    </div>
    <div class="link-panel-agents"></div>
    <div class="link-panel-controls"></div>
    <div class="link-panel-body">
      <div class="link-panel-messages"></div>
    </div>
    <div class="link-panel-input-area">
      <div class="link-panel-target"></div>
      <div class="link-panel-input-row">
        <textarea class="link-panel-input" placeholder="Type a message to send..." rows="1"></textarea>
        <button class="link-panel-send" title="Send">${SVG_SEND}</button>
      </div>
    </div>
  `;

  document.body.appendChild(_panel);

  // ── Wire header actions ──
  _panel.querySelector('[data-action="close"]').onclick = () => closeLinkPanel();
  _panel.querySelector('[data-action="minimize"]').onclick = () => _minimize();

  // ── Wire drag ──
  const header = _panel.querySelector('.link-panel-header');
  header.addEventListener('mousedown', _onDragStart);

  // ── Wire resize (edge-based) ──
  _panel.addEventListener('mousemove', _onResizeHover);
  _panel.addEventListener('mousedown', _onResizeStart);

  // ── Wire input ──
  const textarea = _panel.querySelector('.link-panel-input');
  const sendBtn = _panel.querySelector('.link-panel-send');
  sendBtn.onclick = () => _handleSend();
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      _handleSend();
    }
    // Auto-resize textarea
    requestAnimationFrame(() => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });
  });
}

// ── Setup View (no active link — pick terminals to link) ──

async function _showSetupView() {
  console.log('[link-panel] _showSetupView called');
  const agentsEl = _panel.querySelector('.link-panel-agents');
  const controlsEl = _panel.querySelector('.link-panel-controls');
  const bodyEl = _panel.querySelector('.link-panel-body');
  const inputArea = _panel.querySelector('.link-panel-input-area');

  controlsEl.innerHTML = '';
  inputArea.style.display = 'none';

  // Fetch active terminal sessions
  let sessions = [];
  try {
    const data = await fetchTerminalSessions();
    sessions = data.sessions || [];
    console.log('[link-panel] found', sessions.length, 'terminal sessions');
  } catch (err) {
    console.error('[link-panel] Error fetching sessions:', err);
  }

  if (sessions.length < 2) {
    agentsEl.innerHTML = '';
    bodyEl.innerHTML = `
      <div class="link-panel-empty">
        <div class="link-panel-empty-icon">${SVG_UNLINK}</div>
        <p>Open at least 2 terminal sessions to create a link.</p>
        <p style="opacity:0.5;font-size:12px;">Use the terminal panel to launch Claude Code, Codex, or Gemini.</p>
      </div>
    `;
    return;
  }

  // Show session picker
  agentsEl.innerHTML = '';
  bodyEl.innerHTML = `
    <div class="link-setup">
      <div class="link-setup-title">Select terminals to link</div>
      <div class="link-setup-sessions">${sessions.map(s => {
        const meta = PROFILE_META[s.profile] || { label: s.profile, color: '#888' };
        return `
          <label class="link-setup-session" data-id="${s.id}">
            <input type="checkbox" value="${s.id}" />
            <span class="link-setup-dot" style="background:${meta.color}"></span>
            <span class="link-setup-label">${meta.label}</span>
            <span class="link-setup-cwd">${s.cwd ? s.cwd.split(/[/\\]/).pop() : ''}</span>
          </label>
        `;
      }).join('')}</div>
      <div class="link-setup-options">
        <label class="link-setup-option">
          <input type="checkbox" id="link-auto-continue" checked />
          <span>Auto-continue (agents relay automatically)</span>
        </label>
        <div class="link-setup-mode">
          <span class="link-setup-mode-label">Mode:</span>
          <div class="link-setup-mode-toggle">
            <button class="link-mode-btn selected" data-mode="sidecar" title="Headless relay — clean text, terminals untouched">Sidecar</button>
            <button class="link-mode-btn" data-mode="live" title="Live — messages injected into actual TUI terminals">Live</button>
          </div>
        </div>
      </div>
      <button class="link-setup-create">Create Link</button>
    </div>
  `;

  // Wire mode toggle buttons
  bodyEl.querySelectorAll('.link-mode-btn').forEach(btn => {
    btn.onclick = () => {
      bodyEl.querySelectorAll('.link-mode-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
  });

  const createBtn = bodyEl.querySelector('.link-setup-create');
  createBtn.onclick = async () => {
    const checked = [...bodyEl.querySelectorAll('.link-setup-sessions input:checked')].map(el => el.value);
    if (checked.length < 2) return;
    const autoContinue = bodyEl.querySelector('#link-auto-continue').checked;
    const mode = bodyEl.querySelector('.link-mode-btn.selected')?.dataset.mode || 'sidecar';

    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    try {
      const { linkId } = await createTerminalLink(checked, { autoContinue, mode });
      _activeLink = linkId;
      await _loadLink(linkId);
    } catch (err) {
      createBtn.disabled = false;
      createBtn.textContent = 'Create Link';
      console.error('[link] Create failed:', err);
    }
  };
}

// ── Load & Render Active Link ──

async function _loadLink(linkId) {
  try {
    const link = await fetchTerminalLink(linkId);
    _history = link.history || [];

    // Update shared state for tab badges
    state.linkedSessionIds.clear();
    link.sessions.forEach(s => state.linkedSessionIds.add(s.id));
    emit('terminal:tabs-changed');

    // Restore conversation DOM if the setup view replaced it
    const body = _panel.querySelector('.link-panel-body');
    if (!body.querySelector('.link-panel-messages')) {
      body.innerHTML = '<div class="link-panel-messages"></div>';
    }

    _renderAgents(link);
    _renderControls(link);
    _renderMessages();
    _panel.querySelector('.link-panel-input-area').style.display = '';
    _renderTargetSelector(link);
  } catch (err) {
    console.error('[link] Load failed:', err);
    _showSetupView();
  }
}

function _renderAgents(link) {
  const el = _panel.querySelector('.link-panel-agents');
  el.innerHTML = link.sessions.map((s, i) => {
    const meta = PROFILE_META[s.profile] || { label: s.profile, color: '#888' };
    const active = i === link.activeAgent && link.status === 'running';
    return `
      <div class="link-agent ${active ? 'active' : ''}" data-idx="${i}">
        <span class="link-agent-dot" style="background:${meta.color}"></span>
        <span class="link-agent-name">${meta.label}</span>
        ${active ? '<span class="link-agent-typing">typing...</span>' : ''}
      </div>
    `;
  }).join('<span class="link-agent-arrow">⇄</span>')
    + `<span class="link-mode-badge ${link.mode || 'sidecar'}">${(link.mode || 'sidecar').toUpperCase()}</span>`;
}

function _renderControls(link) {
  const el = _panel.querySelector('.link-panel-controls');
  const isRunning = link.status === 'running';
  const autoContinue = link.config?.autoContinue;

  el.innerHTML = `
    <div class="link-controls">
      <button class="link-ctrl-btn ${autoContinue ? 'active' : ''}" data-action="toggle-auto" title="${autoContinue ? 'Auto-relay ON' : 'Auto-relay OFF'}">
        <span class="link-ctrl-dot ${autoContinue ? 'on' : 'off'}"></span>
        Auto
      </button>
      <button class="link-ctrl-btn" data-action="nudge" title="Force relay to next agent">${SVG_SKIP}</button>
      ${isRunning
        ? `<button class="link-ctrl-btn" data-action="pause" title="Pause">${SVG_PAUSE}</button>`
        : `<button class="link-ctrl-btn" data-action="resume" title="Resume">${SVG_PLAY}</button>`
      }
      <button class="link-ctrl-btn" data-action="copy" title="Copy conversation">${SVG_COPY}</button>
      <button class="link-ctrl-btn danger" data-action="destroy" title="Destroy link">${SVG_UNLINK}</button>
    </div>
  `;

  // Wire control actions
  el.querySelector('[data-action="toggle-auto"]').onclick = async () => {
    try {
      await updateTerminalLink(link.id, { autoContinue: !autoContinue });
      await _loadLink(link.id);
    } catch (err) { console.error('[link]', err); }
  };

  el.querySelector('[data-action="nudge"]').onclick = async () => {
    try { await nudgeLink(link.id); } catch (err) { console.error('[link]', err); }
  };

  const pauseResumeBtn = el.querySelector('[data-action="pause"]') || el.querySelector('[data-action="resume"]');
  if (pauseResumeBtn) {
    pauseResumeBtn.onclick = async () => {
      try {
        if (isRunning) await pauseLink(link.id);
        else await resumeLink(link.id);
        await _loadLink(link.id);
      } catch (err) { console.error('[link]', err); }
    };
  }

  el.querySelector('[data-action="copy"]').onclick = () => _copyConversation();

  el.querySelector('[data-action="destroy"]').onclick = async () => {
    try {
      await deleteTerminalLink(link.id);
      _activeLink = null;
      _history = [];
      state.linkedSessionIds.clear();
      emit('terminal:tabs-changed');
      _showSetupView();
    } catch (err) { console.error('[link]', err); }
  };
}

function _renderTargetSelector(link) {
  const el = _panel.querySelector('.link-panel-target');
  el.innerHTML = `<span class="link-target-label">Send to:</span>` +
    link.sessions.map((s, i) => {
      const meta = PROFILE_META[s.profile] || { label: s.profile, color: '#888' };
      return `<button class="link-target-btn ${i === 0 ? 'selected' : ''}" data-idx="${i}" style="--agent-color:${meta.color}">${meta.label}</button>`;
    }).join('');

  el.querySelectorAll('.link-target-btn').forEach(btn => {
    btn.onclick = () => {
      el.querySelectorAll('.link-target-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
  });
}

function _renderMessages() {
  const container = _panel.querySelector('.link-panel-messages');
  if (!_history.length) {
    container.innerHTML = `
      <div class="link-panel-empty">
        <p style="opacity:0.5;">Link established. Send a message to start the conversation.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = _history.map(msg => {
    const isUser = msg.role === 'user';
    const meta = isUser ? { label: 'You', color: '#4fc3f7' } : (PROFILE_META[msg.role] || { label: msg.role, color: '#888' });
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="link-msg ${isUser ? 'link-msg-user' : 'link-msg-agent'}">
        <div class="link-msg-header">
          <span class="link-msg-dot" style="background:${meta.color}"></span>
          <span class="link-msg-name">${meta.label}</span>
          <span class="link-msg-time">${time}</span>
        </div>
        <div class="link-msg-content">${_escapeHtml(msg.content)}</div>
      </div>
    `;
  }).join('');

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

// ── Message Sending ──

async function _handleSend() {
  if (!_activeLink) return;
  const textarea = _panel.querySelector('.link-panel-input');
  const message = textarea.value.trim();
  if (!message) return;

  const targetBtn = _panel.querySelector('.link-target-btn.selected');
  const targetIdx = targetBtn ? parseInt(targetBtn.dataset.idx, 10) : undefined;

  textarea.value = '';
  textarea.style.height = 'auto';

  try {
    await sendLinkMessage(_activeLink, message, targetIdx);
  } catch (err) {
    console.error('[link] Send failed:', err);
  }
}

// ── Sync Event Handlers ──

function _onSyncChunk(msg) {
  if (!_activeLink || msg.linkId !== _activeLink) return;
  const container = _panel?.querySelector('.link-panel-messages');
  if (!container) return;

  // Find or create the streaming element for this agent
  let streamEl = container.querySelector('.link-msg-streaming');
  if (!streamEl) {
    // Remove "empty" placeholder if present
    const empty = container.querySelector('.link-panel-empty');
    if (empty) empty.remove();

    const meta = PROFILE_META[msg.profile] || { label: msg.profile, color: '#888' };
    streamEl = document.createElement('div');
    streamEl.className = 'link-msg link-msg-agent link-msg-streaming';
    streamEl.innerHTML = `
      <div class="link-msg-header">
        <span class="link-msg-dot" style="background:${meta.color}"></span>
        <span class="link-msg-name">${meta.label}</span>
        <span class="link-msg-time">streaming...</span>
      </div>
      <div class="link-msg-content"></div>
    `;
    container.appendChild(streamEl);
  }

  // Append chunk text
  const contentEl = streamEl.querySelector('.link-msg-content');
  contentEl.innerHTML += _escapeHtml(msg.content);

  // Auto-scroll
  container.scrollTop = container.scrollHeight;
}

function _onSyncMessage(msg) {
  if (!_activeLink || msg.linkId !== _activeLink) return;

  // Remove streaming element — the final message replaces it
  _panel?.querySelector('.link-msg-streaming')?.remove();

  _history.push({ role: msg.role, sessionId: msg.sessionId, content: msg.content, timestamp: msg.timestamp });
  _renderMessages();
}

function _onSyncError(msg) {
  if (!_activeLink || msg.linkId !== _activeLink) return;
  const container = _panel?.querySelector('.link-panel-messages');
  if (!container) return;

  // Remove streaming element
  container.querySelector('.link-msg-streaming')?.remove();

  // Show error inline
  const errorEl = document.createElement('div');
  errorEl.className = 'link-msg link-msg-error';
  errorEl.innerHTML = `
    <div class="link-msg-header">
      <span class="link-msg-dot" style="background:#f44336"></span>
      <span class="link-msg-name">Error</span>
    </div>
    <div class="link-msg-content" style="color:#f44336">${_escapeHtml(msg.error || 'Unknown error')}</div>
  `;
  container.appendChild(errorEl);
  container.scrollTop = container.scrollHeight;
}

function _onSyncAgentStarted(msg) {
  if (!_activeLink || msg.linkId !== _activeLink) return;
  // Update agent indicators
  const agents = _panel?.querySelectorAll('.link-agent');
  if (!agents) return;
  agents.forEach(el => {
    const idx = parseInt(el.dataset.idx, 10);
    const session = el.querySelector('.link-agent-name')?.textContent;
    if (PROFILE_META[msg.profile]?.label === session || idx === msg.activeAgent) {
      el.classList.add('active');
      if (!el.querySelector('.link-agent-typing')) {
        el.insertAdjacentHTML('beforeend', '<span class="link-agent-typing">typing...</span>');
      }
    }
  });
}

function _onSyncAgentFinished(msg) {
  if (!_activeLink || msg.linkId !== _activeLink) return;
  // Remove typing indicators
  _panel?.querySelectorAll('.link-agent').forEach(el => {
    el.classList.remove('active');
    el.querySelector('.link-agent-typing')?.remove();
  });
}

function _onSyncLinkCreated(msg) {
  // Update linked session IDs for tab badges
  if (msg.sessions) {
    msg.sessions.forEach(sid => state.linkedSessionIds.add(sid));
    emit('terminal:tabs-changed');
  }
  // Update panel if open
  if (_visible && !_activeLink) {
    _activeLink = msg.linkId;
    _loadLink(msg.linkId);
  }
}

function _onSyncLinkDeleted(msg) {
  // Clear linked session IDs for tab badges
  if (msg.sessions) {
    msg.sessions.forEach(sid => state.linkedSessionIds.delete(sid));
  } else {
    // If no session list provided, clear all (we can refresh from server)
    state.linkedSessionIds.clear();
  }
  emit('terminal:tabs-changed');

  if (_activeLink === msg.linkId) {
    _activeLink = null;
    _history = [];
    if (_visible) _showSetupView();
  }
}

function _onSyncPaused() {
  if (_activeLink && _visible) _loadLink(_activeLink);
}

function _onSyncResumed() {
  if (_activeLink && _visible) _loadLink(_activeLink);
}

// ── Drag & Resize ──

function _onDragStart(e) {
  if (e.target.closest('.link-panel-btn')) return;
  e.preventDefault();
  const rect = _panel.getBoundingClientRect();
  _panel.style.transform = 'none';
  _dragState = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
  _panel.classList.add('dragging');
  document.addEventListener('mousemove', _onDragMove);
  document.addEventListener('mouseup', _onDragEnd);
}

function _onDragMove(e) {
  if (!_dragState) return;
  const dx = e.clientX - _dragState.startX;
  const dy = e.clientY - _dragState.startY;
  _panel.style.left = (_dragState.startLeft + dx) + 'px';
  _panel.style.top = (_dragState.startTop + dy) + 'px';
}

function _onDragEnd() {
  _dragState = null;
  _panel.classList.remove('dragging');
  document.removeEventListener('mousemove', _onDragMove);
  document.removeEventListener('mouseup', _onDragEnd);
  _savePosition();
}

function _onResizeHover(e) {
  if (_resizeState) return;
  const rect = _panel.getBoundingClientRect();
  const edge = 6;
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const onLeft = x < edge, onRight = x > rect.width - edge;
  const onTop = y < edge, onBottom = y > rect.height - edge;

  if ((onLeft && onTop) || (onRight && onBottom)) _panel.style.cursor = 'nwse-resize';
  else if ((onRight && onTop) || (onLeft && onBottom)) _panel.style.cursor = 'nesw-resize';
  else if (onLeft || onRight) _panel.style.cursor = 'ew-resize';
  else if (onTop || onBottom) _panel.style.cursor = 'ns-resize';
  else _panel.style.cursor = '';
}

function _onResizeStart(e) {
  if (e.target.closest('.link-panel-header') || e.target.closest('.link-panel-body') || e.target.closest('.link-panel-input-area')) return;
  const rect = _panel.getBoundingClientRect();
  const edge = 6;
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const dirs = {
    left: x < edge, right: x > rect.width - edge,
    top: y < edge, bottom: y > rect.height - edge,
  };
  if (!dirs.left && !dirs.right && !dirs.top && !dirs.bottom) return;
  e.preventDefault();
  _resizeState = { dirs, startX: e.clientX, startY: e.clientY, startRect: rect };
  document.addEventListener('mousemove', _onResizeMove);
  document.addEventListener('mouseup', _onResizeEnd);
}

function _onResizeMove(e) {
  if (!_resizeState) return;
  const { dirs, startX, startY, startRect } = _resizeState;
  const dx = e.clientX - startX, dy = e.clientY - startY;
  const minW = 320, minH = 300;
  if (dirs.right) _panel.style.width = Math.max(minW, startRect.width + dx) + 'px';
  if (dirs.bottom) _panel.style.height = Math.max(minH, startRect.height + dy) + 'px';
  if (dirs.left) {
    const newW = Math.max(minW, startRect.width - dx);
    _panel.style.width = newW + 'px';
    _panel.style.left = (startRect.left + startRect.width - newW) + 'px';
  }
  if (dirs.top) {
    const newH = Math.max(minH, startRect.height - dy);
    _panel.style.height = newH + 'px';
    _panel.style.top = (startRect.top + startRect.height - newH) + 'px';
  }
}

function _onResizeEnd() {
  _resizeState = null;
  document.removeEventListener('mousemove', _onResizeMove);
  document.removeEventListener('mouseup', _onResizeEnd);
  _savePosition();
}

function _minimize() {
  _minimized = !_minimized;
  if (_minimized) {
    _panel.classList.add('minimized');
  } else {
    _panel.classList.remove('minimized');
  }
}

function _savePosition() {
  if (!_panel) return;
  const rect = _panel.getBoundingClientRect();
  storage.setItem(KEYS.LINK_PANEL_POS, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
  storage.setItem(KEYS.LINK_PANEL_SIZE, JSON.stringify({ w: Math.round(rect.width), h: Math.round(rect.height) }));
}

// ── Utilities ──

function _escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/\n/g, '<br>');
}

function _copyConversation() {
  if (!_history.length) return;
  const text = _history.map(msg => {
    const label = msg.role === 'user' ? 'You' : (PROFILE_META[msg.role]?.label || msg.role);
    return `[${label}]\n${msg.content}`;
  }).join('\n\n---\n\n');

  navigator.clipboard.writeText(text).then(() => {
    const btn = _panel.querySelector('[data-action="copy"]');
    if (btn) {
      btn.style.color = '#74c7a5';
      setTimeout(() => { btn.style.color = ''; }, 1500);
    }
  });
}

// ── Init ──

export async function initLink() {
  console.log('[link-panel] initLink called');

  // Listen for sync events
  on('sync:link:message', _onSyncMessage);
  on('sync:link:chunk', _onSyncChunk);
  on('sync:link:agent-started', _onSyncAgentStarted);
  on('sync:link:agent-finished', _onSyncAgentFinished);
  on('sync:link:created', _onSyncLinkCreated);
  on('sync:link:deleted', _onSyncLinkDeleted);
  on('sync:link:paused', _onSyncPaused);
  on('sync:link:resumed', _onSyncResumed);
  on('sync:link:error', _onSyncError);

  // Expose for external triggers (menubar, keybind, etc.)
  on('link:open', () => { console.log('[link-panel] link:open event'); openLinkPanel(); });
  on('link:toggle', () => { console.log('[link-panel] link:toggle event'); toggleLinkPanel(); });

  // Load existing links on startup to populate tab badges
  try {
    const { links } = await fetchTerminalLinks();
    if (links.length > 0) {
      for (const link of links) {
        link.sessions.forEach(s => state.linkedSessionIds.add(s.id));
      }
      emit('terminal:tabs-changed');
    }
  } catch { /* server may not be ready yet */ }
}
