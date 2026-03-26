// ═══════════════════════════════════════════
// SynaBun — Session Monitor Window
// Real-time view of active Claude Code sessions, agents, loops, and leak detection.
// Proper draggable/resizable window with tabbed sections.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';

// ── State ──
let ws = null;
let reconnectTimer = null;
let sessions = [];
let leaks = [];
let agents = [];
let _panel = null;
let _backdrop = null;
let _activeTab = 'sessions'; // 'sessions' | 'agents' | 'leaks'
let isVisible = false;

// ── Icons ──
const ICON_TERMINAL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10h3"/></svg>';
const ICON_FLOATING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/><rect x="5" y="1" width="6" height="3" rx="1" fill="none"/></svg>';
const ICON_SIDEPANEL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="M10.5 2v12"/></svg>';
const ICON_EXTERNAL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4v4"/><path d="M14 2L7 9"/><path d="M12 9v4.5a1.5 1.5 0 01-1.5 1.5h-8A1.5 1.5 0 011 13.5v-8A1.5 1.5 0 012.5 4H7"/></svg>';
const ICON_WARNING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1L1 14h14L8 1z"/><path d="M8 6v4M8 12v.5"/></svg>';
const ICON_CRITICAL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/></svg>';
const ICON_CLEANUP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5 4V2.5h6V4M3.5 4v9.5a1 1 0 001 1h7a1 1 0 001-1V4"/></svg>';
const ICON_REFRESH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 019.2-4M13.5 8a5.5 5.5 0 01-9.2 4"/><path d="M11.5 2v2.5H14M4.5 14v-2.5H2"/></svg>';
const ICON_AGENT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>';
const ICON_SESSIONS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="13" height="10" rx="2"/><path d="M5.5 14h5M8 12v2"/></svg>';
const ICON_LEAKS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3M8 11v3"/><path d="M4 5l1.5 2M10.5 9L12 11"/><path d="M2 8h3M11 8h3"/><path d="M4 11l1.5-2M10.5 7L12 5"/></svg>';

const TYPE_ICONS = { terminal: ICON_TERMINAL, floating: ICON_FLOATING, sidepanel: ICON_SIDEPANEL, external: ICON_EXTERNAL };
const TYPE_LABELS = { terminal: 'Terminal', floating: 'Floating', sidepanel: 'Side Panel', external: 'External' };

// ── WebSocket ──

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws/sessions`);
  ws.addEventListener('open', () => clearTimeout(reconnectTimer));
  ws.addEventListener('message', (e) => { try { handleWsMessage(JSON.parse(e.data)); } catch {} });
  ws.addEventListener('close', () => { reconnectTimer = setTimeout(connectWs, 5000); });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'session:init':
      sessions = msg.sessions || [];
      leaks = msg.leaks || [];
      fetch('/api/agents').then(r => r.json()).then(r => { agents = r.agents || []; render(); }).catch(() => render());
      return;
    case 'session:registered': {
      const idx = sessions.findIndex(s => s.claudeSessionId === msg.session.claudeSessionId);
      if (idx >= 0) sessions[idx] = msg.session;
      else sessions.push(msg.session);
      render();
      break;
    }
    case 'session:unregistered':
      sessions = sessions.filter(s => s.claudeSessionId !== msg.claudeSessionId);
      render();
      break;
    case 'session:leaks':
      leaks = msg.leaks || [];
      render();
      break;
  }
}

// ── Panel HTML ──

function buildPanelHTML() {
  const critCount = leaks.filter(l => l.severity === 'critical').length;
  const warnCount = leaks.filter(l => l.severity === 'warning').length;
  const infoCount = leaks.filter(l => l.severity === 'info').length;
  const leakTotal = critCount + warnCount + infoCount;
  const runningAgents = agents.filter(a => a.status === 'running').length;

  return `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <div class="sm-header drag-handle" data-drag="session-monitor-panel">
      <div class="sm-header-left">
        <h3>Session Monitor</h3>
        <span class="sm-header-badge" id="sm-session-count">${sessions.length} sessions</span>
        ${critCount > 0 ? `<span class="sm-header-badge sm-badge-critical">${critCount} critical</span>` : ''}
      </div>
      <div class="sm-header-actions">
        <button class="sm-header-btn" id="sm-refresh" title="Refresh">${ICON_REFRESH}</button>
        <button class="backdrop-toggle-btn" id="sm-backdrop-toggle" data-tooltip="Toggle backdrop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="sm-close" id="sm-close">&times;</button>
      </div>
    </div>

    <div class="sm-tabs" id="sm-tabs">
      <button class="sm-tab active" data-tab="sessions">
        ${ICON_SESSIONS}
        <span>Sessions</span>
        <span class="sm-tab-count">${sessions.length}</span>
      </button>
      <button class="sm-tab" data-tab="agents">
        ${ICON_AGENT}
        <span>Agents</span>
        ${runningAgents > 0 ? `<span class="sm-tab-count sm-tab-count-active">${runningAgents}</span>` : `<span class="sm-tab-count">${agents.length}</span>`}
      </button>
      <button class="sm-tab" data-tab="leaks">
        ${ICON_LEAKS}
        <span>Health</span>
        ${critCount > 0 ? `<span class="sm-tab-count sm-tab-count-critical">${leakTotal}</span>` : warnCount > 0 ? `<span class="sm-tab-count sm-tab-count-warning">${leakTotal}</span>` : `<span class="sm-tab-count">${leakTotal}</span>`}
      </button>
    </div>

    <div class="sm-body" id="sm-body"></div>
  `;
}

// ── Tab renderers ──

function renderSessionsTab() {
  if (sessions.length === 0) {
    return `<div class="sm-empty-state">
      <div class="sm-empty-icon">${ICON_SESSIONS}</div>
      <div class="sm-empty-title">No active sessions</div>
      <div class="sm-empty-desc">Claude Code sessions will appear here when they connect.</div>
    </div>`;
  }

  let html = '<div class="sm-list">';
  for (const s of sessions) {
    const typeIcon = TYPE_ICONS[s.terminalType] || ICON_EXTERNAL;
    const typeLabel = TYPE_LABELS[s.terminalType] || s.terminalType || 'Unknown';
    const alive = s.isAlive !== false;
    const age = formatAge(s.connectedAt);
    const lastAct = formatAge(s.lastActivity);
    const projectName = s.project || shortPath(s.cwd) || 'unknown';
    const hasLeaks = leaks.some(l => l.sessions?.includes(s.claudeSessionId) || l.sessionId === s.claudeSessionId);

    html += `<div class="sm-card ${alive ? '' : 'sm-card-dead'} ${hasLeaks ? 'sm-card-leak' : ''}">`;
    html += `<div class="sm-card-header">`;
    html += `<span class="sm-card-type" title="${typeLabel}">${typeIcon}</span>`;
    html += `<span class="sm-card-project">${esc(projectName)}</span>`;
    html += `<span class="sm-card-type-label">${typeLabel}</span>`;
    html += `<span class="sm-card-pulse ${alive ? 'sm-pulse-active' : 'sm-pulse-dead'}"></span>`;
    html += `</div>`;
    html += `<div class="sm-card-details">`;
    html += `<div class="sm-card-row"><span class="sm-card-key">ID</span><span class="sm-card-val mono">${s.claudeSessionId.slice(0, 8)}</span></div>`;
    html += `<div class="sm-card-row"><span class="sm-card-key">Uptime</span><span class="sm-card-val">${age}</span></div>`;
    html += `<div class="sm-card-row"><span class="sm-card-key">Last active</span><span class="sm-card-val">${lastAct} ago</span></div>`;
    if (s.pid) html += `<div class="sm-card-row"><span class="sm-card-key">PID</span><span class="sm-card-val mono">${s.pid}</span></div>`;
    if (s.cwd) html += `<div class="sm-card-row"><span class="sm-card-key">CWD</span><span class="sm-card-val mono" title="${esc(s.cwd)}">${esc(shortPath(s.cwd))}</span></div>`;
    html += `</div>`;
    if (hasLeaks) {
      html += `<div class="sm-card-warning">Has associated leaks</div>`;
    }
    html += `</div>`;
  }
  html += '</div>';
  return html;
}

function renderAgentsTab() {
  const runningAgents = agents.filter(a => a.status === 'running');
  const finishedAgents = agents.filter(a => a.status !== 'running');

  if (agents.length === 0) {
    return `<div class="sm-empty-state">
      <div class="sm-empty-icon">${ICON_AGENT}</div>
      <div class="sm-empty-title">No agents</div>
      <div class="sm-empty-desc">Running and recent agents will appear here.</div>
    </div>`;
  }

  let html = '';

  if (runningAgents.length > 0) {
    html += `<div class="sm-section-label">Running <span class="sm-section-count">${runningAgents.length}</span></div>`;
    html += '<div class="sm-list">';
    for (const a of runningAgents) {
      html += renderAgentCard(a);
    }
    html += '</div>';
  }

  if (finishedAgents.length > 0) {
    html += `<div class="sm-section-label">Recent <span class="sm-section-count">${finishedAgents.length}</span></div>`;
    html += '<div class="sm-list">';
    for (const a of finishedAgents) {
      html += renderAgentCard(a);
    }
    html += '</div>';
  }

  return html;
}

function renderAgentCard(a) {
  const isRunning = a.status === 'running';
  const statusCls = isRunning ? 'sm-agent-running' : a.status === 'completed' ? 'sm-agent-done' : a.status === 'failed' ? 'sm-agent-fail' : 'sm-agent-stopped';
  const statusLabel = a.status.charAt(0).toUpperCase() + a.status.slice(1);
  const iterLabel = a.mode === 'loop' && a.totalIterations > 1 ? `${a.currentIteration}/${a.totalIterations}` : '';
  const duration = a.startedAt ? formatAge(a.startedAt) : '';

  let html = `<div class="sm-card ${statusCls}">`;
  html += `<div class="sm-card-header">`;
  html += `<span class="sm-agent-badge ${statusCls}">${statusLabel}</span>`;
  if (iterLabel) html += `<span class="sm-agent-iter">${iterLabel}</span>`;
  html += `<span class="sm-card-spacer"></span>`;
  if (isRunning) {
    html += `<button class="sm-btn sm-btn-stop" data-agent-stop="${a.id}" title="Stop agent">${ICON_STOP} Stop</button>`;
  } else {
    html += `<button class="sm-btn sm-btn-remove" data-agent-remove="${a.id}" title="Remove">&times;</button>`;
  }
  html += `</div>`;
  html += `<div class="sm-card-details">`;
  if (a.task) html += `<div class="sm-card-row"><span class="sm-card-key">Task</span><span class="sm-card-val">${esc(a.task)}</span></div>`;
  if (a.mode) html += `<div class="sm-card-row"><span class="sm-card-key">Mode</span><span class="sm-card-val">${a.mode}</span></div>`;
  if (duration) html += `<div class="sm-card-row"><span class="sm-card-key">${isRunning ? 'Running' : 'Ran'}</span><span class="sm-card-val">${duration}</span></div>`;
  if (a.costUsd != null) html += `<div class="sm-card-row"><span class="sm-card-key">Cost</span><span class="sm-card-val">$${a.costUsd.toFixed(4)}</span></div>`;
  html += `</div>`;
  html += `</div>`;
  return html;
}

function renderLeaksTab() {
  const criticalLeaks = leaks.filter(l => l.severity === 'critical');
  const warningLeaks = leaks.filter(l => l.severity === 'warning');
  const infoLeaks = leaks.filter(l => l.severity === 'info');

  if (leaks.length === 0) {
    return `<div class="sm-empty-state">
      <div class="sm-empty-icon sm-empty-ok">${ICON_LEAKS}</div>
      <div class="sm-empty-title">All clear</div>
      <div class="sm-empty-desc">No leaks or orphaned files detected.</div>
    </div>`;
  }

  let html = '';

  if (criticalLeaks.length > 0) {
    html += `<div class="sm-section-label sm-section-critical">Critical <span class="sm-section-count">${criticalLeaks.length}</span></div>`;
    html += '<div class="sm-list">';
    for (const l of criticalLeaks) html += renderLeakCard(l);
    html += '</div>';
  }

  if (warningLeaks.length > 0) {
    html += `<div class="sm-section-label sm-section-warning">Warnings <span class="sm-section-count">${warningLeaks.length}</span></div>`;
    html += '<div class="sm-list">';
    for (const l of warningLeaks) html += renderLeakCard(l);
    html += '</div>';
  }

  if (infoLeaks.length > 0) {
    html += `<div class="sm-section-label">Orphaned files <span class="sm-section-count">${infoLeaks.length}</span></div>`;
    html += '<div class="sm-list">';
    for (const l of infoLeaks) html += renderLeakCard(l);
    html += '</div>';
    html += `<div class="sm-cleanup-bar">
      <span>${infoLeaks.length} orphaned file${infoLeaks.length > 1 ? 's' : ''} can be cleaned up</span>
      <button class="sm-btn sm-btn-cleanup" id="sm-cleanup-btn">${ICON_CLEANUP} Clean All</button>
    </div>`;
  }

  return html;
}

function renderLeakCard(l) {
  const icon = l.severity === 'critical' ? ICON_CRITICAL : l.severity === 'warning' ? ICON_WARNING : ICON_CLEANUP;
  const cls = l.severity === 'critical' ? 'sm-card-critical' : l.severity === 'warning' ? 'sm-card-warning' : 'sm-card-info';
  const age = l.ageMs ? formatDuration(l.ageMs) : '';

  let html = `<div class="sm-card ${cls}">`;
  html += `<div class="sm-leak-header">`;
  html += `<span class="sm-leak-icon">${icon}</span>`;
  html += `<span class="sm-leak-desc">${esc(l.description)}</span>`;
  html += `</div>`;
  html += `<div class="sm-card-details">`;
  html += `<div class="sm-card-row"><span class="sm-card-key">Type</span><span class="sm-card-val">${esc(l.type)}</span></div>`;
  if (age) html += `<div class="sm-card-row"><span class="sm-card-key">Age</span><span class="sm-card-val">${age}</span></div>`;
  if (l.file) html += `<div class="sm-card-row"><span class="sm-card-key">File</span><span class="sm-card-val mono" title="${esc(l.file)}">${esc(shortPath(l.file))}</span></div>`;
  if (l.cwd) html += `<div class="sm-card-row"><span class="sm-card-key">CWD</span><span class="sm-card-val mono" title="${esc(l.cwd)}">${esc(shortPath(l.cwd))}</span></div>`;
  if (l.sessions) html += `<div class="sm-card-row"><span class="sm-card-key">Sessions</span><span class="sm-card-val mono">${l.sessions.map(s => s.slice(0, 8)).join(', ')}</span></div>`;
  if (l.loopData) {
    html += `<div class="sm-card-row"><span class="sm-card-key">Loop</span><span class="sm-card-val">${esc(l.loopData.template)} (${l.loopData.currentIteration}/${l.loopData.maxIterations})</span></div>`;
  }
  html += `</div>`;
  html += `</div>`;
  return html;
}

// ── Master render ──

function render() {
  if (!_panel || !isVisible) return;
  const body = _panel.querySelector('#sm-body');
  if (!body) return;

  // Update header badges
  const countBadge = _panel.querySelector('#sm-session-count');
  if (countBadge) countBadge.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

  // Update tab counts
  const critCount = leaks.filter(l => l.severity === 'critical').length;
  const warnCount = leaks.filter(l => l.severity === 'warning').length;
  const leakTotal = leaks.length;
  const runningAgents = agents.filter(a => a.status === 'running').length;

  const tabs = _panel.querySelectorAll('.sm-tab');
  tabs.forEach(tab => {
    const tabName = tab.dataset.tab;
    const countEl = tab.querySelector('.sm-tab-count');
    if (!countEl) return;
    if (tabName === 'sessions') {
      countEl.textContent = sessions.length;
    } else if (tabName === 'agents') {
      countEl.textContent = runningAgents > 0 ? runningAgents : agents.length;
      countEl.className = `sm-tab-count${runningAgents > 0 ? ' sm-tab-count-active' : ''}`;
    } else if (tabName === 'leaks') {
      countEl.textContent = leakTotal;
      countEl.className = `sm-tab-count${critCount > 0 ? ' sm-tab-count-critical' : warnCount > 0 ? ' sm-tab-count-warning' : ''}`;
    }
  });

  // Render active tab content
  let html = '';
  switch (_activeTab) {
    case 'sessions': html = renderSessionsTab(); break;
    case 'agents': html = renderAgentsTab(); break;
    case 'leaks': html = renderLeaksTab(); break;
  }
  body.innerHTML = html;

  // Wire event listeners
  body.querySelectorAll('[data-agent-stop]').forEach(btn => {
    btn.addEventListener('click', () => stopAgent(btn.dataset.agentStop));
  });
  body.querySelectorAll('[data-agent-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeAgent(btn.dataset.agentRemove));
  });
  const cleanupBtn = body.querySelector('#sm-cleanup-btn');
  if (cleanupBtn) cleanupBtn.addEventListener('click', cleanupOrphans);
}

// ── Actions ──

async function refreshSessions() {
  try {
    const [sessRes, leakRes, agentRes] = await Promise.all([
      fetch('/api/sessions/active').then(r => r.json()),
      fetch('/api/sessions/leaks').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()).catch(() => ({ agents: [] })),
    ]);
    sessions = sessRes.sessions || [];
    leaks = leakRes.leaks || [];
    agents = agentRes.agents || [];
    render();
  } catch {}
}

async function stopAgent(agentId) {
  try {
    await fetch(`/api/agents/${agentId}/stop`, { method: 'POST' });
    await refreshSessions();
  } catch {}
}

async function removeAgent(agentId) {
  try {
    await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
    await refreshSessions();
  } catch {}
}

async function cleanupOrphans() {
  try {
    const res = await fetch('/api/sessions/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: ['orphaned-state', 'stale-precompact'] }),
    }).then(r => r.json());
    if (res.ok) await refreshSessions();
  } catch {}
}

// ── Helpers ──

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function shortPath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.slice(-2).join('/');
}

function formatAge(ts) {
  if (!ts) return '?';
  const diff = Date.now() - ts;
  if (diff < 60000) return '<1m';
  if (diff < 3600000) return Math.round(diff / 60000) + 'm';
  if (diff < 86400000) return Math.round(diff / 3600000) + 'h';
  return Math.round(diff / 86400000) + 'd';
}

function formatDuration(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return Math.round(ms / 3600000) + 'h';
}

// ── Panel open/close ──

function openPanel() {
  if (_panel) { _panel.focus(); return; }

  _backdrop = document.createElement('div');
  _backdrop.className = 'sm-backdrop';
  // Backdrop click disabled — close only via ESC or close button
  document.body.appendChild(_backdrop);

  _panel = document.createElement('div');
  _panel.className = 'session-monitor-panel glass resizable';
  _panel.id = 'session-monitor-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  // Center at default size
  _panel.style.left = Math.max(20, (window.innerWidth - 640) / 2) + 'px';
  _panel.style.top = Math.max(48, (window.innerHeight - 480) / 2) + 'px';

  wirePanel();
  isVisible = true;
  connectWs();
  refreshSessions();

  // ESC key to close
  const onEsc = (e) => {
    if (e.key === 'Escape' && _panel) { closePanel(); document.removeEventListener('keydown', onEsc); }
  };
  document.addEventListener('keydown', onEsc);

  requestAnimationFrame(() => {
    _backdrop.classList.add('open');
    _panel.classList.add('open');
  });
}

function closePanel() {
  if (!_panel) return;
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
  _panel.remove();
  _panel = null;
  isVisible = false;
  _activeTab = 'sessions';
  emit('session-monitor:closed');
}

function wirePanel() {
  const closeBtn = _panel.querySelector('#sm-close');
  if (closeBtn) closeBtn.addEventListener('click', closePanel);

  const refreshBtn = _panel.querySelector('#sm-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshSessions);

  const bdToggle = _panel.querySelector('#sm-backdrop-toggle');
  if (bdToggle) {
    bdToggle.addEventListener('click', () => {
      if (_backdrop) {
        _backdrop.classList.toggle('backdrop-hidden');
        bdToggle.classList.toggle('active', _backdrop.classList.contains('backdrop-hidden'));
      }
    });
  }

  // Tab switching
  const tabBar = _panel.querySelector('#sm-tabs');
  if (tabBar) {
    tabBar.addEventListener('click', (e) => {
      const tab = e.target.closest('.sm-tab');
      if (!tab) return;
      const name = tab.dataset.tab;
      if (name === _activeTab) return;
      _activeTab = name;
      tabBar.querySelectorAll('.sm-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
      render();
    });
  }
}

// ── Exports ──

export function showSessionMonitor() { openPanel(); }
export function hideSessionMonitor() { closePanel(); }
export function toggleSessionMonitor() {
  if (_panel) closePanel();
  else openPanel();
}

// Widget mode for claude-chat skin
export function mountSessionWidget(container) {
  const widget = document.createElement('div');
  widget.className = 'session-widget';
  widget.innerHTML = `<div class="sm-body" id="sm-body"></div>`;
  container.appendChild(widget);
  _panel = widget;
  _activeTab = 'sessions';
  isVisible = true;
  connectWs();
  return widget;
}

// Kept for backwards compat
export function createSessionMonitorPanel() { return null; }

// Public state getters
export function getActiveSessions() { return sessions; }
export function getLeaks() { return leaks; }
export function getSessionCount() { return sessions.length; }
export function getCriticalLeakCount() { return leaks.filter(l => l.severity === 'critical').length; }
