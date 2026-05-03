// ═══════════════════════════════════════════
// SynaBun — Notifications Drawer
// Centralised notification window: pending updates (SynaBun core, CLI tools,
// CLAUDE.md / AGENTS.md ruleset versions), active sessions, agents, loops,
// and leak detection. Proper draggable/resizable window with tabbed sections.
//
// Note: CSS classes, DOM IDs, and event names use the legacy `session-monitor`
// / `sm-*` prefix for backward compat with the rest of the app.
// ═══════════════════════════════════════════

import { emit, on } from './state.js';
import { getSynabunUpdateData, openSynabunUpdateModal, forceCheckSynabunUpdate } from './ui-update.js';
import { getToolUpdateData, runToolUpdate, TOOL_LABELS } from './ui-tool-updates.js';
import { openSettingsModal } from './ui-settings.js';
import { getProviderMeta } from './provider-icons.js';

// ── State ──
let ws = null;
let reconnectTimer = null;
let sessions = [];
let leaks = [];
let agents = [];
let loops = [];
let staleLoopCount = 0;
let _panel = null;
let _backdrop = null;
let _activeTab = 'updates'; // 'updates' | 'sessions' | 'agents' | 'loops' | 'leaks'
let isVisible = false;
let _stalledTickerTimer = null;

// ── Notifications state ──
const NOTIF_ACK_KEY = 'synabun:notifications:acked-v1';
const RULESET_FORMATS = ['claude', 'codex', 'cursor', 'generic', 'gemini'];
const RULESET_LABELS = {
  claude:  { title: 'CLAUDE.md ruleset',           target: 'CLAUDE.md',  section: 'setup-claude'   },
  codex:   { title: 'AGENTS.md ruleset (Codex)',   target: 'AGENTS.md',  section: 'setup-codex'    },
  generic: { title: 'AGENTS.md ruleset (OpenCode)', target: 'AGENTS.md',  section: 'setup-opencode' },
  cursor:  { title: 'Cursor ruleset',              target: '.cursorrules', section: 'setup-claude' },
  gemini:  { title: 'GEMINI.md ruleset',           target: 'GEMINI.md',  section: 'setup-claude'   },
};
const RULESET_PROVIDER = {
  claude:  'claude-code',
  codex:   'codex',
  generic: 'opencode',
  cursor:  'claude-code',
  gemini:  'gemini',
};
let _rulesetVersions = null;       // server payload — { formats: { claude: {fingerprint, ...}, ... } }
let _acked = _loadAcked();         // { rulesets: {fmt: fingerprint}, synabun: latest, tools: {key: latest} }
let _ackedSeeded = false;          // becomes true after first-run seed of ruleset fingerprints

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
const ICON_LOOP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5a5.5 5.5 0 00-10 0v3M2 11a5.5 5.5 0 0010 0V8"/><path d="M12 5l2 0 0-2M4 11l-2 0 0 2"/></svg>';
const ICON_BELL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h10l-1.2-1.5a3 3 0 01-.6-1.8V7a3.2 3.2 0 00-6.4 0v2.7a3 3 0 01-.6 1.8L3 13z"/><path d="M6.5 13.5a1.5 1.5 0 003 0"/></svg>';
const ICON_RULESET = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2.5h7l3 3V13a.5.5 0 01-.5.5h-9A.5.5 0 013 13V3a.5.5 0 010-.5z"/><path d="M9.5 2.5V6h3"/><path d="M5.5 8.5h5M5.5 10.5h5M5.5 12h3"/></svg>';
const ICON_PACKAGE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5L8 1.5l6 3v7L8 14.5 2 11.5v-7z"/><path d="M2 4.5L8 7.5l6-3M8 7.5v7"/></svg>';
const ICON_UP_ARROW = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M4 7l4-4 4 4"/></svg>';

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
      loops = msg.loops || [];
      staleLoopCount = msg.staleCount || 0;
      emitLoopsUpdate();
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
    case 'session:loops':
      loops = msg.loops || [];
      staleLoopCount = msg.staleCount || 0;
      emitLoopsUpdate();
      render();
      break;
  }
}

function emitLoopsUpdate() {
  emit('loops:updated', { staleCount: staleLoopCount, total: loops.length });
}

// ── Panel HTML ──

function buildPanelHTML() {
  const critCount = leaks.filter(l => l.severity === 'critical').length;
  const warnCount = leaks.filter(l => l.severity === 'warning').length;
  const infoCount = leaks.filter(l => l.severity === 'info').length;
  const leakTotal = critCount + warnCount + infoCount;
  const runningAgents = agents.filter(a => a.status === 'running').length;
  const updateCount = computeUpdates().length;
  const updatesBadge = updateCount > 0
    ? `<span class="sm-tab-count sm-tab-count-warning">${updateCount}</span>`
    : `<span class="sm-tab-count">0</span>`;

  const tabActive = (name) => _activeTab === name ? ' active' : '';
  const headerCls = 'sm-header drag-handle';

  return `
    <div class="resize-handle resize-handle-t" data-resize="t"></div>
    <div class="resize-handle resize-handle-r" data-resize="r"></div>
    <div class="resize-handle resize-handle-b" data-resize="b"></div>
    <div class="resize-handle resize-handle-l" data-resize="l"></div>
    <div class="resize-handle resize-handle-tl" data-resize="tl"></div>
    <div class="resize-handle resize-handle-tr" data-resize="tr"></div>
    <div class="resize-handle resize-handle-bl" data-resize="bl"></div>
    <div class="resize-handle resize-handle-br" data-resize="br"></div>

    <div class="${headerCls}" data-drag="session-monitor-panel">
      <div class="sm-header-left">
        <div class="sm-header-icon" aria-hidden="true">
          ${ICON_BELL}
        </div>
        <div class="sm-header-titlewrap">
          <h3>Notifications</h3>
        </div>
      </div>
      <div class="sm-header-actions">
        <button class="sm-header-btn" id="sm-refresh" title="Refresh">${ICON_REFRESH}</button>
        <button class="backdrop-toggle-btn" id="sm-backdrop-toggle" data-tooltip="Toggle backdrop">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="sm-close" id="sm-close" title="Close">&times;</button>
      </div>
    </div>

    <div class="sm-tabs" id="sm-tabs" role="tablist">
      <button class="sm-tab${tabActive('updates')}" data-tab="updates" role="tab">
        ${ICON_BELL}
        <span>Updates</span>
        ${updatesBadge}
      </button>
      <button class="sm-tab${tabActive('sessions')}" data-tab="sessions" role="tab">
        ${ICON_SESSIONS}
        <span>Sessions</span>
        <span class="sm-tab-count">${sessions.length}</span>
      </button>
      <button class="sm-tab${tabActive('agents')}" data-tab="agents" role="tab">
        ${ICON_AGENT}
        <span>Agents</span>
        ${runningAgents > 0 ? `<span class="sm-tab-count sm-tab-count-active">${runningAgents}</span>` : `<span class="sm-tab-count">${agents.length}</span>`}
      </button>
      <button class="sm-tab${tabActive('loops')}" data-tab="loops" role="tab">
        ${ICON_LOOP}
        <span>Loops</span>
        ${staleLoopCount > 0 ? `<span class="sm-tab-count sm-tab-count-warning">${loops.length}</span>` : `<span class="sm-tab-count">${loops.length}</span>`}
      </button>
      <button class="sm-tab${tabActive('leaks')}" data-tab="leaks" role="tab">
        ${ICON_LEAKS}
        <span>Health</span>
        ${critCount > 0 ? `<span class="sm-tab-count sm-tab-count-critical">${leakTotal}</span>` : warnCount > 0 ? `<span class="sm-tab-count sm-tab-count-warning">${leakTotal}</span>` : `<span class="sm-tab-count">${leakTotal}</span>`}
      </button>
    </div>

    <div class="sm-body" id="sm-body"></div>
  `;
}

// Acknowledge every pending update in one shot. Used by the "Dismiss all"
// action in the Updates tab.
function markAllUpdatesRead() {
  const items = computeUpdates();
  for (const it of items) {
    if (it.kind === 'ruleset') ackRulesetUpdate(it.key);
  }
  if (_panel) render();
}

// ── Notifications engine ──

function _loadAcked() {
  try {
    const raw = localStorage.getItem(NOTIF_ACK_KEY);
    if (!raw) return { rulesets: {}, synabun: '', tools: {} };
    const parsed = JSON.parse(raw);
    return {
      rulesets: parsed.rulesets || {},
      synabun: parsed.synabun || '',
      tools: parsed.tools || {},
    };
  } catch {
    return { rulesets: {}, synabun: '', tools: {} };
  }
}

function _saveAcked() {
  try { localStorage.setItem(NOTIF_ACK_KEY, JSON.stringify(_acked)); } catch {}
}

// Build the notification list from current ruleset versions, SynaBun core
// update data, and CLI tool update data. Each item is shown in the Updates tab
// SynaBun and CLI updates show whenever available (not dismissable). Rulesets use acked fingerprint.
function computeUpdates() {
  const items = [];

  // SynaBun core
  const synabun = getSynabunUpdateData();
  if (synabun?.updateAvailable) {
    items.push({
      kind: 'synabun',
      key: 'synabun',
      title: 'SynaBun',
      subtitle: `v${synabun.current} → v${synabun.latest}`,
      meta: synabun.source ? `Source: ${synabun.source}` : '',
      action: 'Open updater',
      severity: 'normal',
    });
  }

  // CLI tools
  const toolsData = getToolUpdateData();
  if (toolsData?.tools) {
    for (const [key, info] of Object.entries(toolsData.tools)) {
      if (!info?.updateAvailable) continue;
      items.push({
        kind: 'tool',
        key,
        title: TOOL_LABELS[key] || key,
        subtitle: `v${info.installed} → v${info.latest}`,
        meta: info.canUpdate ? '' : `Update via ${info.installSource || 'your installer'}`,
        action: info.canUpdate ? 'Run update' : 'How to update',
        severity: 'normal',
      });
    }
  }

  // Rulesets
  if (_rulesetVersions?.formats && _ackedSeeded) {
    for (const fmt of RULESET_FORMATS) {
      const cur = _rulesetVersions.formats[fmt];
      if (!cur) continue;
      const acked = _acked.rulesets[fmt];
      if (acked === cur.fingerprint) continue;
      const meta = RULESET_LABELS[fmt] || { title: fmt, target: '', section: 'setup-claude' };
      items.push({
        kind: 'ruleset',
        key: fmt,
        title: meta.title,
        subtitle: cur.source === 'manifest' && cur.version
          ? `New version ${cur.version}`
          : 'Updated content available',
        meta: cur.summary || (cur.source === 'manifest' && cur.updatedAt ? `Updated ${cur.updatedAt}` : ''),
        target: meta.target,
        section: meta.section,
        fingerprint: cur.fingerprint,
        action: 'Open & copy',
        severity: 'normal',
      });
    }
  }

  return items;
}

function emitNotificationsUpdate() {
  emit('notifications:updated', { unreadCount: computeUpdates().length });
}

async function refreshRulesetVersions() {
  try {
    const res = await fetch('/api/claude-code/ruleset/versions');
    if (!res.ok) return;
    const data = await res.json();
    _rulesetVersions = data;

    // First-run seed: if the user has never acked any ruleset, seed acks to
    // current fingerprints so existing users don't get a flood of "new" alerts.
    if (!_ackedSeeded) {
      const hasAny = Object.keys(_acked.rulesets || {}).length > 0;
      if (!hasAny && data?.formats) {
        for (const fmt of RULESET_FORMATS) {
          const cur = data.formats[fmt];
          if (cur?.fingerprint) _acked.rulesets[fmt] = cur.fingerprint;
        }
        _saveAcked();
      }
      _ackedSeeded = true;
    }

    emitNotificationsUpdate();
  } catch {}
}

function ackRulesetUpdate(fmt) {
  const cur = _rulesetVersions?.formats?.[fmt];
  if (!cur?.fingerprint) return;
  _acked.rulesets[fmt] = cur.fingerprint;
  _saveAcked();
  emitNotificationsUpdate();
}

function ackSynabunUpdate() {
  const data = getSynabunUpdateData();
  if (!data?.latest) return;
  _acked.synabun = data.latest;
  _saveAcked();
  emitNotificationsUpdate();
}

function ackToolUpdate(key) {
  const data = getToolUpdateData();
  const info = data?.tools?.[key];
  if (!info?.latest) return;
  _acked.tools[key] = info.latest;
  _saveAcked();
  emitNotificationsUpdate();
}

function handleUpdateAction(item) {
  if (!item) return;
  if (item.kind === 'synabun') {
    if (_panel) closePanel();
    openSynabunUpdateModal();
    return;
  }
  if (item.kind === 'tool') {
    runToolUpdate(item.key);
    if (_panel) render();
    return;
  }
  if (item.kind === 'ruleset') {
    ackRulesetUpdate(item.key);
    if (_panel) closePanel();
    openSettingsModal({
      tab: 'connections',
      expand: [item.section],
      highlight: [item.section],
    });
  }
}

function handleUpdateAck(item) {
  if (!item) return;
  if (item.kind === 'ruleset') ackRulesetUpdate(item.key);
  else handleUpdateAction(item);
  if (_panel) render();
}

function renderUpdatesTab() {
  const items = computeUpdates();
  if (items.length === 0) {
    return `<div class="sm-empty-state">
      <div class="sm-empty-icon sm-empty-ok">${ICON_BELL}</div>
      <div class="sm-empty-title">All caught up</div>
      <div class="sm-empty-desc">No new updates. We'll let you know when SynaBun, CLI tools, or the CLAUDE.md / AGENTS.md rulesets change.</div>
    </div>`;
  }

  // Group by kind for cleaner sections
  const groups = [
    { id: 'synabun', label: 'SynaBun', items: items.filter(i => i.kind === 'synabun') },
    { id: 'tool',    label: 'CLI tools', items: items.filter(i => i.kind === 'tool') },
    { id: 'ruleset', label: 'Rulesets', items: items.filter(i => i.kind === 'ruleset') },
  ];

  let html = '';
  // Only show Dismiss all when there are dismissable (ruleset) updates
  const hasDismissable = items.some(i => i.kind === 'ruleset');
  if (hasDismissable) {
    html += `<div class="sm-actionbar">
      <span class="sm-actionbar-label">${items.filter(i => i.kind === 'ruleset').length} ruleset update${items.filter(i => i.kind === 'ruleset').length === 1 ? '' : 's'} to dismiss</span>
      <button class="sm-btn sm-btn-ghost" id="sm-updates-mark-all">Dismiss all</button>
    </div>`;
  }
  for (const g of groups) {
    if (g.items.length === 0) continue;
    html += `<div class="sm-section-label">${esc(g.label)} <span class="sm-section-count">${g.items.length}</span></div>`;
    html += '<div class="sm-list">';
    for (let i = 0; i < g.items.length; i++) {
      html += renderUpdateCard(g.items[i], `${g.id}-${i}`);
    }
    html += '</div>';
  }
  return html;
}

function renderUpdateCard(item, idx) {
  let icon;
  let providerColor;
  if (item.kind === 'synabun') {
    const meta = getProviderMeta('synabun');
    icon = meta.icon;
    providerColor = meta.color;
  } else if (item.kind === 'tool') {
    const meta = getProviderMeta(item.key);
    icon = meta.icon;
    providerColor = meta.color;
  } else {
    const providerId = RULESET_PROVIDER[item.key] || 'claude-code';
    const meta = getProviderMeta(providerId);
    icon = meta.icon;
    providerColor = meta.color;
  }
  const kindLabel = item.kind === 'synabun' ? 'SynaBun'
                 : item.kind === 'tool'    ? 'CLI tool'
                 : 'Ruleset';
  let html = `<div class="sm-card sm-card-update" data-update-idx="${esc(idx)}">`;
  html += `<div class="sm-update-row">`;
  html += `<div class="sm-update-icon" aria-hidden="true" style="color:${providerColor}">${icon}</div>`;
  html += `<div class="sm-update-content">`;
  html += `<div class="sm-update-kicker">${esc(kindLabel)}</div>`;
  html += `<div class="sm-update-line">`;
  html += `<span class="sm-update-title">${esc(item.title)}</span>`;
  html += `<span class="sm-update-version">${esc(item.subtitle)}</span>`;
  html += `</div>`;
  if (item.meta) {
    html += `<div class="sm-update-meta">${esc(item.meta)}</div>`;
  }
  if (item.kind === 'ruleset' && item.target) {
    html += `<div class="sm-update-meta sm-update-meta-target"><span class="sm-update-meta-key">Paste into</span><span class="sm-update-meta-val mono">${esc(item.target)}</span></div>`;
  }
  html += `</div>`;
  html += `<div class="sm-update-actions">`;
  if (item.kind === 'ruleset') { html += `<button class="sm-btn sm-btn-ghost" data-update-ack="${esc(idx)}" title="Dismiss update">Dismiss</button>`; }
  html += `<button class="sm-btn sm-btn-primary" data-update-action="${esc(idx)}">${esc(item.action)}</button>`;
  html += `</div>`;
  html += `</div>`;
  html += `</div>`;
  return html;
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
      html += `<div class="sm-card-note-warning">Has associated leaks</div>`;
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
  const cleanableLeaks = leaks.filter(l => l.type === 'orphaned-state' || l.type === 'stale-precompact');

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
  }

  if (cleanableLeaks.length > 0) {
    html += `<div class="sm-cleanup-bar">
      <span>${cleanableLeaks.length} stale flag${cleanableLeaks.length > 1 ? 's' : ''} can be cleaned up</span>
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

function renderLoopsTab() {
  if (loops.length === 0) {
    return `<div class="sm-empty-state">
      <div class="sm-empty-icon">${ICON_LOOP}</div>
      <div class="sm-empty-title">No loops</div>
      <div class="sm-empty-desc">Active and recent loop runs will appear here.</div>
    </div>`;
  }

  const totalCount = loops.length;
  const stale = loops.filter(l => l.state === 'stale-inactive').length;

  let html = '<div class="sm-list">';
  for (const l of loops) html += renderLoopCard(l);
  html += '</div>';

  html += `<div class="sm-loops-actionbar">
    <span class="sm-loops-summary">${totalCount} loop${totalCount === 1 ? '' : 's'} · ${stale} stale</span>
    <span class="sm-loops-actions">
      <button class="sm-btn sm-btn-cleanup" id="sm-loops-clear-stale" ${stale === 0 ? 'disabled' : ''}>${ICON_CLEANUP} Clear stale</button>
      <button class="sm-btn sm-btn-stop" id="sm-loops-clear-all">${ICON_STOP} Clear all</button>
    </span>
  </div>`;
  return html;
}

function loopStateLabel(state) {
  switch (state) {
    case 'active': return 'Running';
    case 'finished': return 'Finished';
    case 'orphaned-pty': return 'Orphaned';
    case 'stale-inactive': return 'Stale';
    default: return state;
  }
}

function loopStateClass(state) {
  switch (state) {
    case 'active': return 'sm-loop-running';
    case 'finished': return 'sm-loop-finished';
    case 'orphaned-pty': return 'sm-loop-orphan';
    case 'stale-inactive': return 'sm-loop-stale';
    default: return '';
  }
}

function formatStalled(stalledMs) {
  if (!stalledMs || stalledMs < 1000) return '0s';
  const s = Math.floor(stalledMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderLoopCard(l) {
  const stateCls = loopStateClass(l.state);
  const stateLabel = loopStateLabel(l.state);
  const showStalled = l.state === 'active';
  // Live-tick adjustment: WS may be a few seconds old, so add elapsed since fetch
  const stalledMs = (l.stalledMs || 0) + (Date.now() - (l._fetchedAt || Date.now()));
  const stalledHot = showStalled && stalledMs >= 5 * 60 * 1000;
  const iter = `${l.currentIteration || 0}/${l.totalIterations || 0}`;
  const taskPreview = l.task ? (l.task.length > 80 ? l.task.slice(0, 80) + '…' : l.task) : '';
  const startedAge = l.startedAt ? formatAge(new Date(l.startedAt).getTime()) : '?';
  const tsidShort = l.terminalSessionId ? l.terminalSessionId.slice(0, 8) : '—';

  let html = `<div class="sm-card ${stateCls}">`;
  html += `<div class="sm-card-header">`;
  html += `<span class="sm-loop-badge ${stateCls}">${esc(stateLabel)}</span>`;
  html += `<span class="sm-loop-iter">${iter}</span>`;
  html += `<span class="sm-card-spacer"></span>`;
  if (l.state === 'active' || l.state === 'orphaned-pty' || l.state === 'finished') {
    html += `<button class="sm-btn sm-btn-stop" data-loop-stop="${esc(l.terminalSessionId || '')}" data-session="${esc(l.sessionId)}" title="Stop loop">${ICON_STOP} Stop</button>`;
  }
  html += `</div>`;
  html += `<div class="sm-card-details">`;
  if (showStalled) {
    html += `<div class="sm-card-row"><span class="sm-card-key">Stalled</span><span class="sm-card-val sm-loop-stalled${stalledHot ? ' sm-loop-stalled-hot' : ''}" data-stalled-ms="${l.stalledMs || 0}" data-fetched-at="${l._fetchedAt || Date.now()}">${formatStalled(stalledMs)}</span></div>`;
  }
  if (taskPreview) html += `<div class="sm-card-row"><span class="sm-card-key">Task</span><span class="sm-card-val" title="${esc(l.task)}">${esc(taskPreview)}</span></div>`;
  html += `<div class="sm-card-row"><span class="sm-card-key">Started</span><span class="sm-card-val">${startedAge} ago</span></div>`;
  html += `<div class="sm-card-row"><span class="sm-card-key">Terminal</span><span class="sm-card-val mono">${esc(tsidShort)} <span class="sm-pulse-${l.terminalAlive ? 'active' : 'dead'}"></span></span></div>`;
  html += `<div class="sm-card-row"><span class="sm-card-key">Session</span><span class="sm-card-val mono">${esc(l.sessionId.slice(0, 8))}</span></div>`;
  html += `</div>`;
  html += `</div>`;
  return html;
}

// ── Master render ──

function render() {
  if (!_panel || !isVisible) return;
  const body = _panel.querySelector('#sm-body');
  if (!body) return;

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
    } else if (tabName === 'loops') {
      countEl.textContent = loops.length;
      countEl.className = `sm-tab-count${staleLoopCount > 0 ? ' sm-tab-count-warning' : ''}`;
    } else if (tabName === 'leaks') {
      countEl.textContent = leakTotal;
      countEl.className = `sm-tab-count${critCount > 0 ? ' sm-tab-count-critical' : warnCount > 0 ? ' sm-tab-count-warning' : ''}`;
    }
  });

  // Update tabs that depend on Updates count too
  const updatesTab = _panel.querySelector('.sm-tab[data-tab="updates"]');
  if (updatesTab) {
    const c = updatesTab.querySelector('.sm-tab-count');
    if (c) {
      const updateCount = computeUpdates().length;
      c.textContent = updateCount;
      c.className = `sm-tab-count${updateCount > 0 ? ' sm-tab-count-warning' : ''}`;
    }
  }

  // Render active tab content
  let html = '';
  switch (_activeTab) {
    case 'updates': html = renderUpdatesTab(); break;
    case 'sessions': html = renderSessionsTab(); break;
    case 'agents': html = renderAgentsTab(); break;
    case 'loops': html = renderLoopsTab(); break;
    case 'leaks': html = renderLeaksTab(); break;
  }
  body.innerHTML = html;

  // Wire updates-tab actions (cache items so action/ack handlers stay in sync
  // with what was rendered, even if computeUpdates() shifts mid-tick)
  if (_activeTab === 'updates') {
    const renderedItems = computeUpdates();
    const findItem = (idx) => {
      const [groupId, n] = String(idx || '').split('-');
      const filtered = renderedItems.filter(it => it.kind === groupId);
      return filtered[Number(n)];
    };
    body.querySelectorAll('[data-update-action]').forEach(btn => {
      btn.addEventListener('click', () => handleUpdateAction(findItem(btn.dataset.updateAction)));
    });
    body.querySelectorAll('[data-update-ack]').forEach(btn => {
      btn.addEventListener('click', () => handleUpdateAck(findItem(btn.dataset.updateAck)));
    });
    const markAllBtn = body.querySelector('#sm-updates-mark-all');
    if (markAllBtn) markAllBtn.addEventListener('click', markAllUpdatesRead);
  }

  // Wire event listeners
  body.querySelectorAll('[data-agent-stop]').forEach(btn => {
    btn.addEventListener('click', () => stopAgent(btn.dataset.agentStop));
  });
  body.querySelectorAll('[data-agent-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeAgent(btn.dataset.agentRemove));
  });
  const cleanupBtn = body.querySelector('#sm-cleanup-btn');
  if (cleanupBtn) cleanupBtn.addEventListener('click', cleanupOrphans);

  // Wire loops-tab actions
  body.querySelectorAll('[data-loop-stop]').forEach(btn => {
    btn.addEventListener('click', () => stopLoop(btn.dataset.loopStop, btn.dataset.session));
  });
  const loopsClearStaleBtn = body.querySelector('#sm-loops-clear-stale');
  if (loopsClearStaleBtn) loopsClearStaleBtn.addEventListener('click', clearStaleLoops);
  const loopsClearAllBtn = body.querySelector('#sm-loops-clear-all');
  if (loopsClearAllBtn) loopsClearAllBtn.addEventListener('click', clearAllLoops);

  // Stalled timer ticker — only active while the Loops tab is visible
  if (_activeTab === 'loops') startStalledTicker();
  else stopStalledTicker();
}

function startStalledTicker() {
  if (_stalledTickerTimer) return;
  _stalledTickerTimer = setInterval(() => {
    if (!_panel || _activeTab !== 'loops') { stopStalledTicker(); return; }
    const cells = _panel.querySelectorAll('.sm-loop-stalled');
    const now = Date.now();
    cells.forEach(cell => {
      const baseMs = parseInt(cell.dataset.stalledMs || '0', 10);
      const fetchedAt = parseInt(cell.dataset.fetchedAt || `${now}`, 10);
      const ms = baseMs + (now - fetchedAt);
      cell.textContent = formatStalled(ms);
      cell.classList.toggle('sm-loop-stalled-hot', ms >= 5 * 60 * 1000);
    });
  }, 1000);
}

function stopStalledTicker() {
  if (_stalledTickerTimer) {
    clearInterval(_stalledTickerTimer);
    _stalledTickerTimer = null;
  }
}

// ── Actions ──

async function refreshSessions() {
  try {
    const [sessRes, leakRes, agentRes, loopRes] = await Promise.all([
      fetch('/api/sessions/active').then(r => r.json()),
      fetch('/api/sessions/leaks').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()).catch(() => ({ agents: [] })),
      fetch('/api/loop/list').then(r => r.json()).catch(() => ({ loops: [], staleCount: 0 })),
    ]);
    sessions = sessRes.sessions || [];
    leaks = leakRes.leaks || [];
    agents = agentRes.agents || [];
    const fetchedAt = Date.now();
    loops = (loopRes.loops || []).map(l => ({ ...l, _fetchedAt: fetchedAt }));
    staleLoopCount = loopRes.staleCount || 0;
    emitLoopsUpdate();
    // Refresh notification feed alongside session/loop data
    refreshRulesetVersions().catch(() => {});
    forceCheckSynabunUpdate().then(() => render()).catch(() => {});
    render();
  } catch {}
}

async function stopLoop(terminalSessionId, sessionId) {
  try {
    if (!terminalSessionId) {
      // Loop file with no terminal — just delete it via cleanup endpoint flow:
      // mark inactive on the server side by hitting cleanup after the fact is
      // not possible (cleanup needs active=false). For orphan-pty without a
      // terminal id, fall through to /api/loop/stop with no body would kill all
      // — so instead just refresh; the stale broadcast will catch it.
      await refreshSessions();
      return;
    }
    await fetch('/api/loop/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalSessionId }),
    });
    await refreshSessions();
  } catch {}
}

async function clearStaleLoops() {
  try {
    const res = await fetch('/api/loop/cleanup', { method: 'POST' }).then(r => r.json());
    if (res?.ok) await refreshSessions();
  } catch {}
}

async function clearAllLoops() {
  if (!confirm('Stop and delete ALL loops, including running ones? This will kill their PTY sessions and close their browser tabs.')) return;
  try {
    await fetch('/api/loop/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await refreshSessions();
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

  // Default to Updates tab when there's something to act on, otherwise
  // Sessions (the historical default).
  _activeTab = computeUpdates().length > 0 ? 'updates' : 'sessions';

  _panel = document.createElement('div');
  _panel.className = 'session-monitor-panel glass resizable';
  _panel.id = 'session-monitor-panel';
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);

  // Center at default size
  _panel.style.left = Math.max(20, (window.innerWidth - 680) / 2) + 'px';
  _panel.style.top = Math.max(48, (window.innerHeight - 520) / 2) + 'px';

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
  stopStalledTicker();
  if (_backdrop) { _backdrop.remove(); _backdrop = null; }
  _panel.remove();
  _panel = null;
  isVisible = false;
  _activeTab = 'updates';
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

// Open the Notifications drawer and switch directly to the Loops tab. Used by the
// titlebar stale-loops alert button.
export function openLoopsTab() {
  if (!_panel) openPanel();
  _activeTab = 'loops';
  if (_panel) {
    _panel.querySelectorAll('.sm-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'loops'));
    render();
  }
}

// Bootstrap fetch: populate badge state without opening the Notifications
// drawer. Called from ui-navbar.js on init so the alert dot can show on app
// load.
export async function fetchLoopsForBadge() {
  try {
    const res = await fetch('/api/loop/list').then(r => r.json());
    loops = res.loops || [];
    staleLoopCount = res.staleCount || 0;
    emitLoopsUpdate();
  } catch {}
}

// Bootstrap fetch for Updates badge — pulls ruleset versions and emits the
// notifications:updated event so the navbar can show its count without the
// drawer ever being opened.
export async function fetchNotificationsForBadge() {
  await refreshRulesetVersions();
  // Also re-emit on next tick so ui-update / ui-tool-updates have a chance to
  // populate their cached state before the count is computed for the badge.
  setTimeout(() => emitNotificationsUpdate(), 1500);
}

// Open the Notifications drawer directly to the Updates tab.
export function openUpdatesTab() {
  if (!_panel) openPanel();
  _activeTab = 'updates';
  if (_panel) {
    _panel.querySelectorAll('.sm-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'updates'));
    render();
  }
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
