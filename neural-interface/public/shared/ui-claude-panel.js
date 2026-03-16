// ═══════════════════════════════════════════
// SynaBun — Claude Code Panel (Main Area)
// Stream-JSON renderer embedded in the Neural Interface viewport
// ═══════════════════════════════════════════

import { storage } from './storage.js';
import { emit, on } from './state.js';
import { fetchClaudeSessions, fetchBrowserSessions } from './api.js';

const CLAUDE_ICON = '<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';

// ── Tool SVG icons (16x16 viewBox, stroke-based) ──
const TOOL_ICONS = {
  Read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h8.5v13H4a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 014 1.5z"/><path d="M5.5 5h5M5.5 7.5h3"/></svg>',
  Edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5l4 4L5 15H1v-4z"/><path d="M8 4l4 4"/></svg>',
  Write: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4A1.5 1.5 0 002.5 3v10A1.5 1.5 0 004 14.5h8a1.5 1.5 0 001.5-1.5V6z"/><path d="M9 1.5V6h4.5"/></svg>',
  Bash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="13" height="12" rx="2"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10h3"/></svg>',
  Glob: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5h4l1.5 1.5H14v8.5H2z"/><circle cx="9" cy="9" r="2.5"/><path d="M11 11l2 2"/></svg>',
  Grep: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/><path d="M5 7h4"/></svg>',
  Agent: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1l2 3.5H6L8 1z"/><circle cx="8" cy="9" r="3.5"/><path d="M6 8.5l1.5 1.5L10 7.5"/></svg>',
  WebSearch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="3" ry="6"/><path d="M2 8h12M2.5 5h11M2.5 11h11"/></svg>',
  WebFetch: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v9M5 8l3 3 3-3"/><path d="M2.5 12v1.5h11V12"/></svg>',
  TodoWrite: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l1.5 1.5L7 3M3 8.5l1.5 1.5L7 7.5M3 13l1.5 1.5L7 12"/><path d="M9 4.5h4.5M9 9h4.5M9 13.5h4.5"/></svg>',
  Skill: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2l-3 12M11 2L8 14"/></svg>',
  NotebookEdit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="1.5" width="10" height="13" rx="1.5"/><path d="M1 4h2M1 8h2M1 12h2M6 5h4M6 8h2"/></svg>',
};
const TOOL_ICON_DEFAULT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>';
const TOOL_ICON_MCP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="8" r="2.5"/><circle cx="10.5" cy="8" r="2.5"/><path d="M8 8h0"/></svg>';
const THINKING_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 14c0-1.5 1-2 1-3.5a2.5 2.5 0 115 0c0 1.5 1 2 1 3.5"/><path d="M6.5 14h4M7 15h3"/><path d="M8.5 6V4M5.3 7.2L3.8 5.7M11.7 7.2l1.5-1.5M4 10H2m12 0h-2"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg>';
const ICON_X = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

// ── SynaBun MCP tool registry ──
const SYNABUN_PREFIX = 'mcp__SynaBun__';
function isSynaBunTool(name) { return name?.startsWith(SYNABUN_PREFIX); }
function synaBunToolKey(name) { return name?.replace(SYNABUN_PREFIX, '') || ''; }

const SB_ICON_RECALL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2C5.2 2 3 4.2 3 7c0 1.8 1 3.4 2.4 4.2V13h5.2v-1.8C12 10.4 13 8.8 13 7c0-2.8-2.2-5-5-5z"/><path d="M6 13.5h4M6.5 15h3"/><circle cx="11.5" cy="4" r="2.5"/><path d="M10.5 4h2M11.5 3v2"/></svg>';
const SB_ICON_REMEMBER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2C5.2 2 3 4.2 3 7c0 1.8 1 3.4 2.4 4.2V13h5.2v-1.8C12 10.4 13 8.8 13 7c0-2.8-2.2-5-5-5z"/><path d="M6 13.5h4M6.5 15h3"/><path d="M7 6.5h2M8 5.5v2"/></svg>';
const SB_ICON_REFLECT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2C5.2 2 3 4.2 3 7c0 1.8 1 3.4 2.4 4.2V13h5.2v-1.8C12 10.4 13 8.8 13 7c0-2.8-2.2-5-5-5z"/><path d="M6 13.5h4M6.5 15h3"/><path d="M6.5 6a2.5 2.5 0 013 0M9.5 8a2.5 2.5 0 01-3 0"/></svg>';
const SB_ICON_FORGET = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2C5.2 2 3 4.2 3 7c0 1.8 1 3.4 2.4 4.2V13h5.2v-1.8C12 10.4 13 8.8 13 7c0-2.8-2.2-5-5-5z"/><path d="M6 13.5h4M6.5 15h3"/><path d="M6.5 6l3 3M9.5 6l-3 3"/></svg>';
const SB_ICON_RESTORE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2C5.2 2 3 4.2 3 7c0 1.8 1 3.4 2.4 4.2V13h5.2v-1.8C12 10.4 13 8.8 13 7c0-2.8-2.2-5-5-5z"/><path d="M6 13.5h4M6.5 15h3"/><path d="M6 7.5l2-2 2 2"/></svg>';
const SB_ICON_MEMORIES = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2" width="10" height="4" rx="1"/><rect x="3" y="7" width="10" height="4" rx="1"/><path d="M5 13h6"/></svg>';
const SB_ICON_SYNC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 019.2-4M13.5 8a5.5 5.5 0 01-9.2 4"/><path d="M11.5 2v2.5H14M4.5 14v-2.5H2"/></svg>';
const SB_ICON_CATEGORY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 7.5h7M6 11h7M3 7.5h1M3 11h1"/></svg>';
const SB_ICON_BROWSER = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a10 10 0 013 6 10 10 0 01-3 6M8 2a10 10 0 00-3 6 10 10 0 003 6"/></svg>';
const SB_ICON_DISCORD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3C4 3.5 3 4.5 2.5 5.5c0 0-.5 2 0 4.5.8 1 2 1.8 3 2l.5-1.2M10.5 3c1.5.5 2.5 1.5 3 2.5 0 0 .5 2 0 4.5-.8 1-2 1.8-3 2l-.5-1.2"/><circle cx="6" cy="8.5" r="1"/><circle cx="10" cy="8.5" r="1"/></svg>';
const SB_ICON_WHITEBOARD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="12" height="10" rx="1.5"/><path d="M5 14h6M8 12v2"/><path d="M5 6l2 2-2 2"/><path d="M8.5 10h3"/></svg>';
const SB_ICON_CARD = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/><circle cx="4.5" cy="4.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="4.5" r="0.5" fill="currentColor"/></svg>';
const SB_ICON_GIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="12.5" r="1.5"/><path d="M8 5v3M8 8c0 2-3 2.5-3 3M8 8c0 2 3 2.5 3 3"/></svg>';
const SB_ICON_LOOP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8c0-2 1.5-3.5 3.5-3.5s3 1.5 3 3.5-1.5 3.5-3.5 3.5"/><path d="M14 8c0 2-1.5 3.5-3.5 3.5S7.5 10 7.5 8 9 4.5 11 4.5"/></svg>';
const SB_ICON_TICTACTOE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2v12M10.5 2v12M2 5.5h12M2 10.5h12"/><path d="M3.5 3.5l1.5 1.5M5 3.5L3.5 5"/><circle cx="8" cy="8" r="1.2"/></svg>';

const SYNABUN_TOOLS = {
  recall:    { label: 'Recall',    group: 'memory', icon: SB_ICON_RECALL,    detailFn: i => (i.query || '').slice(0, 50) },
  remember:  { label: 'Remember',  group: 'memory', icon: SB_ICON_REMEMBER,  detailFn: i => ((i.category ? i.category + ': ' : '') + (i.content || '')).slice(0, 50) },
  reflect:   { label: 'Reflect',   group: 'memory', icon: SB_ICON_REFLECT,   detailFn: i => 'Update ' + (i.memory_id || '').slice(0, 8) },
  forget:    { label: 'Forget',    group: 'memory', icon: SB_ICON_FORGET,    detailFn: i => (i.memory_id || '').slice(0, 8) },
  restore:   { label: 'Restore',   group: 'memory', icon: SB_ICON_RESTORE,   detailFn: i => (i.memory_id || '').slice(0, 8) },
  memories:  { label: 'Memories',  group: 'memory', icon: SB_ICON_MEMORIES,  detailFn: i => i.action || '' },
  sync:      { label: 'Sync',      group: 'memory', icon: SB_ICON_SYNC,      detailFn: () => 'Check stale' },
  category:  { label: 'Category',  group: 'memory', icon: SB_ICON_CATEGORY,  detailFn: i => (i.action || '') + (i.name ? ': ' + i.name : '') },
  git:       { label: 'Git',       group: 'dev',    icon: SB_ICON_GIT,       detailFn: i => i.action || '' },
  loop:      { label: 'Loop',      group: 'system', icon: SB_ICON_LOOP,      detailFn: i => i.action || '' },
  tictactoe: { label: 'Tic-Tac-Toe', group: 'fun',  icon: SB_ICON_TICTACTOE, detailFn: i => i.action || '' },
};
const SYNABUN_GROUPS = {
  browser:    { label: 'Browser',    group: 'browser',    icon: SB_ICON_BROWSER,    detailFn: i => i.url || i.selector || i.text || '' },
  discord:    { label: 'Discord',    group: 'discord',    icon: SB_ICON_DISCORD,    detailFn: i => i.action || i.channel_id || '' },
  whiteboard: { label: 'Whiteboard', group: 'whiteboard', icon: SB_ICON_WHITEBOARD, detailFn: i => i.id || '' },
  card:       { label: 'Card',       group: 'card',       icon: SB_ICON_CARD,       detailFn: i => i.card_id || '' },
  browser_extract: { label: 'Extract', group: 'browser', icon: SB_ICON_BROWSER, detailFn: i => i.url || i.selector || '' },
};

function getSynaBunMeta(name) {
  const key = synaBunToolKey(name);
  if (SYNABUN_TOOLS[key]) return SYNABUN_TOOLS[key];
  for (const [prefix, meta] of Object.entries(SYNABUN_GROUPS)) {
    if (key.startsWith(prefix + '_') || key === prefix) {
      const action = key.slice(prefix.length + 1) || '';
      const actionLabel = action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return { ...meta, label: actionLabel ? `${meta.label}: ${actionLabel}` : meta.label };
    }
  }
  return null;
}

function toolIconSvg(name) {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (isSynaBunTool(name)) {
    const meta = getSynaBunMeta(name);
    if (meta) return meta.icon;
  }
  if (name?.startsWith('mcp__')) return TOOL_ICON_MCP;
  return TOOL_ICON_DEFAULT;
}

let _panel = null;
let _visible = false;
let _totalCost = 0;
let _projects = [];
let _models = [];
let _skillsCache = null;    // cached skills list for slash command hints

// ── Window identity (per browser tab — sessionStorage is NOT shared across windows) ──
const _windowId = sessionStorage.getItem('cp-window-id') || (() => { const id = crypto.randomUUID(); sessionStorage.setItem('cp-window-id', id); return id; })();

// ── Multi-session tab system ──
let _tabs = [];           // TabState[]
let _activeTabIdx = -1;
const MAX_TABS = 10;
function activeTab() { return _tabs[_activeTabIdx] || null; }

// ── Browser embed state ──
let _browserEmbed = null;   // { sessionId, ws, canvas, ctx, urlBar, container }
let _browserEmbedVisible = false;

// Marked.js (lazy loaded)
let _marked = null;
(async () => {
  try {
    const m = await import('https://cdn.jsdelivr.net/npm/marked@14/lib/marked.esm.js').catch(() => null);
    if (m) {
      _marked = m.marked || m.default;
      if (_marked?.setOptions) _marked.setOptions({ breaks: true, gfm: true });
    }
  } catch {}
})();

function md(text) {
  if (!_marked) return esc(text).replace(/\n/g, '<br>');
  try { return _marked.parse(text); }
  catch { return esc(text).replace(/\n/g, '<br>'); }
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const STOR = {
  session: 'synabun-claude-panel-session',
  project: 'synabun-claude-panel-project',
  model: 'synabun-claude-panel-model',
  tabs: `synabun-claude-panel-tabs-${_windowId}`,  // window-scoped
  tabsLegacy: 'synabun-claude-panel-tabs',          // old global key (migration)
  effort: 'synabun-claude-panel-effort',
  autoAccept: 'synabun-claude-panel-autoaccept',
  windowRegistry: 'synabun-claude-panel-windows',   // JSON map of windowId → lastSeen timestamp
  bootId: 'synabun-claude-panel-boot-id',           // server boot ID — detect restarts
};

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
const EFFORT_LABELS = { off: 'Think', low: 'lo', medium: 'med', high: 'hi', max: 'max' };
const EFFORT_TITLES = {
  off: 'Extended thinking off — click to enable',
  low: 'Thinking: low — minimal extended reasoning',
  medium: 'Thinking: medium — balanced reasoning',
  high: 'Thinking: high — deep reasoning',
  max: 'Thinking: max — EXPERIMENTAL. Extended thinking can take 3-5 min with no visible output. May cause API timeouts.',
};

// ── Build panel DOM ──
function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'claude-panel';
  panel.className = 'claude-panel';
  panel.innerHTML = `
    <div class="cp-resize-handle"></div>
    <div class="cp-header">
      <button class="cp-session-btn" id="cp-session-btn">
        <span class="cp-session-label">New chat</span>
        <span class="cp-dd-arrow">&#x25BE;</span>
      </button>
      <button class="cp-header-rename-btn" id="cp-header-rename" title="Rename session">
        <svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
      </button>
      <div class="cp-header-actions">
        <button class="cp-header-btn cp-new-btn" data-tooltip="New session">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="cp-header-btn cp-minimize-btn" data-tooltip="Minimize to pill">
          <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="cp-header-btn cp-close-btn" data-tooltip="End session">
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <button class="cp-header-btn cp-slide-btn" data-tooltip="Slide panel">
          <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="cp-session-menu" id="cp-session-menu"></div>
    </div>
    <div class="cp-context-bar" id="cp-context-bar">
      <div class="cp-gauge" id="cp-gauge">
        <span class="cp-gauge-label" id="cp-gauge-label"></span>
      </div>
      <button class="cp-compact-btn" id="cp-compact-btn" title="Compress conversation context to free up space">compact</button>
    </div>
    <div class="cp-messages-container" id="cp-messages-container"></div>
    <div class="cp-browser-embed" id="cp-browser-embed">
      <div class="cp-browser-toolbar">
        <div class="cp-browser-nav">
          <button class="cp-browser-nav-btn cp-browser-back" title="Back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg></button>
          <button class="cp-browser-nav-btn cp-browser-fwd" title="Forward"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
          <button class="cp-browser-nav-btn cp-browser-reload" title="Reload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        </div>
        <div class="cp-browser-url-wrap"><input class="cp-browser-url" type="text" spellcheck="false" autocomplete="off" placeholder="URL"></div>
        <button class="cp-browser-detach" title="Detach to floating window"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></button>
        <button class="cp-browser-close-embed" title="Close browser view">&times;</button>
      </div>
      <div class="cp-browser-canvas-wrap"><canvas class="cp-browser-canvas" width="1280" height="800"></canvas></div>
    </div>
    <div class="cp-bottom">
      <div class="cp-project-bar">
        <div class="cp-dropdown" id="cp-project" data-placeholder="project..."><span class="cp-dd-label">project...</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
        <div class="cp-dropdown cp-dropdown-sm" id="cp-branch" data-placeholder="branch"><span class="cp-dd-label">branch</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
      </div>
      <div class="cp-input-area">
        <div class="cp-input-wrap">
          <div class="cp-image-preview" id="cp-image-preview"></div>
          <div class="cp-input-inner">
            <textarea class="cp-input" id="cp-input" placeholder="Message SynaBun..." rows="1" autocomplete="off" spellcheck="false"></textarea>
            <div class="cp-slash-hints" id="cp-slash-hints"></div>
            <button class="cp-send" id="cp-send" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
          </div>
        </div>
      </div>
      <div class="cp-toolbar">
        <div class="cp-toolbar-left">
          <img class="cp-brand" src="favicon-32x32.png" alt="S">
          <button class="cp-attach" id="cp-attach" title="Attach file">
            <svg viewBox="0 0 24 24" width="13" height="13"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.49" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            <span class="cp-attach-badge" hidden></span>
          </button>
        </div>
        <div class="cp-toolbar-right">
          <button class="cp-think-toggle" id="cp-think-toggle" data-effort="off" data-tooltip="Extended thinking off — click to enable"><span class="cp-think-icon"><svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5L4 9h4l-1 5.5L12 7H8l1-5.5z"/></svg></span><span class="cp-think-label">Think</span><span class="cp-think-dots"></span></button>
          <button class="cp-plan-toggle" id="cp-plan-toggle" data-tooltip="Toggle plan mode — think without acting"><svg class="cp-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12M2 7h8M2 11h10M2 15h6"/></svg><span>Plan</span></button>
          <button class="cp-auto-toggle" id="cp-auto-toggle" data-tooltip="Auto-accept all tool permissions"><svg class="cp-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg><span>Auto</span></button>
          <div class="cp-dropdown cp-dropdown-sm" id="cp-model" data-placeholder="model"><span class="cp-dd-label">model</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
          <span class="cp-cost" id="cp-cost">$0.00</span>
        </div>
      </div>
    </div>
  `;
  return panel;
}

// ── Inject styles ──
function injectStyles() {
  if (document.getElementById('claude-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'claude-panel-styles';
  style.textContent = `
    /* ── Panel shell — floating macOS-style container ── */
    .claude-panel {
      position: fixed;
      top: 64px; right: 16px;
      width: 22%; min-width: 320px; max-width: 700px;
      bottom: 16px;
      z-index: 200;
      display: flex;
      flex-direction: column;
      background: rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(60px) saturate(1.5);
      -webkit-backdrop-filter: blur(60px) saturate(1.5);
      border: 0.5px solid rgba(255,255,255,0.06);
      border-radius: 16px;
      box-shadow:
        0 16px 48px rgba(0,0,0,0.5),
        0 4px 16px rgba(0,0,0,0.3);
      overflow: hidden;
      transform: translateX(calc(100% + 20px));
      transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1),
                  opacity 0.28s ease;
      opacity: 0;
    }
    .claude-panel.open {
      transform: translateX(0);
      opacity: 1;
    }

    /* ── Resize handle (left edge) ── */
    .cp-resize-handle {
      position: absolute; top: 14px; left: 0; width: 6px; height: calc(100% - 28px);
      cursor: col-resize; z-index: 10; border-radius: 0 3px 3px 0;
    }
    .cp-resize-handle:hover, .cp-resize-handle:active {
      background: linear-gradient(180deg, rgba(255,255,255,0.06), transparent 50%, rgba(255,255,255,0.06));
    }

    /* ── Messages container (holds per-tab message divs) ── */
    .cp-messages-container {
      flex: 1; overflow: hidden; position: relative;
      margin: 6px 8px 6px;
      background: rgba(0,0,0,0.18);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.03);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);
    }
    .cp-messages {
      position: absolute; inset: 0;
      overflow-y: auto;
      padding: 12px 0 6px;
      display: flex; flex-direction: column; gap: 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.06) transparent;
      opacity: 1; transform: translateY(0);
    }
    .cp-messages.cp-tab-enter {
      animation: cp-tab-in 0.25s cubic-bezier(0.2, 0, 0.2, 1) forwards;
    }
    .cp-messages.cp-tab-exit {
      animation: cp-tab-out 0.18s cubic-bezier(0.4, 0, 1, 1) forwards;
      pointer-events: none;
    }
    @keyframes cp-tab-in {
      0% { opacity: 0; transform: translateY(8px); }
      100% { opacity: 1; transform: translateY(0); }
    }
    @keyframes cp-tab-out {
      0% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(-6px); }
    }
    .cp-messages::before {
      content: ''; margin-top: auto;
    }
    .cp-messages::-webkit-scrollbar { width: 3px; }
    .cp-messages::-webkit-scrollbar-track { background: transparent; }
    .cp-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
    .cp-messages::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

    /* ── Browser embed (live screencast inside panel) ── */
    .cp-browser-embed {
      display: none;
      flex-direction: column;
      margin: 6px 8px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      background: rgba(0,0,0,0.3);
      overflow: hidden;
    }
    .cp-browser-embed.active {
      display: flex;
      flex-shrink: 0;
    }
    .cp-browser-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      background: rgba(0,0,0,0.35);
      border-bottom: 1px solid rgba(255,255,255,0.04);
      border-radius: 10px 10px 0 0;
      flex-shrink: 0;
      height: 30px;
    }
    .cp-browser-nav {
      display: flex;
      gap: 1px;
    }
    .cp-browser-nav-btn {
      background: none; border: none; color: rgba(255,255,255,0.4);
      cursor: pointer; padding: 2px; width: 20px; height: 20px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 4px;
    }
    .cp-browser-nav-btn:hover { color: rgba(255,255,255,0.8); background: rgba(255,255,255,0.06); }
    .cp-browser-nav-btn svg { width: 12px; height: 12px; }
    .cp-browser-url-wrap {
      flex: 1; min-width: 0;
    }
    .cp-browser-url {
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px;
      color: rgba(255,255,255,0.6);
      font-size: 10px;
      font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px;
      height: 20px;
      outline: none;
    }
    .cp-browser-url:focus {
      border-color: rgba(255,255,255,0.15);
      color: rgba(255,255,255,0.8);
    }
    .cp-browser-detach, .cp-browser-close-embed {
      background: none; border: none; color: rgba(255,255,255,0.35);
      cursor: pointer; padding: 2px; width: 20px; height: 20px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 4px; font-size: 14px; line-height: 1;
    }
    .cp-browser-detach:hover, .cp-browser-close-embed:hover {
      color: rgba(255,255,255,0.8); background: rgba(255,255,255,0.06);
    }
    .cp-browser-detach svg { width: 12px; height: 12px; }
    .cp-browser-canvas-wrap {
      width: 100%;
      aspect-ratio: 16 / 10;
      overflow: hidden;
      position: relative;
      background: #0a0a0a;
    }
    .cp-browser-canvas {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      cursor: pointer;
    }
    .cp-browser-canvas:focus {
      outline: 1px solid rgba(255,255,255,0.1);
      outline-offset: -1px;
    }
    @keyframes cp-browser-slide-in {
      0% { opacity: 0; max-height: 0; }
      100% { opacity: 1; max-height: 50vh; }
    }
    .cp-browser-embed.cp-browser-enter {
      animation: cp-browser-slide-in 0.3s cubic-bezier(0.2, 0, 0.2, 1) forwards;
    }

    /* ── User messages ── */
    .cp-messages .msg { padding: 3px 14px; }
    .cp-messages .msg-user { display: flex; justify-content: flex-end; padding: 10px 14px 4px; }
    .cp-messages .msg-bubble {
      background: var(--s-light);
      border: 1px solid var(--b-light);
      border-radius: 16px 16px 4px 16px;
      padding: 8px 14px; max-width: 82%;
      font-size: 12px; color: var(--t-bright);
      white-space: pre-wrap; word-break: break-word; line-height: 1.55;
      font-family: 'Inter', -apple-system, sans-serif;
    }

    /* ── Assistant messages ── */
    .cp-messages .msg-assistant { display: flex; gap: 10px; align-items: flex-start; padding: 8px 14px; }
    .cp-messages .msg-avatar {
      width: 24px; height: 24px; border-radius: 7px;
      background: rgba(255,255,255,0.06);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 2px;
      color: rgba(255,255,255,0.5);
    }
    .cp-messages .msg-avatar svg { width: 14px; height: 14px; }
    .cp-messages .msg-content { flex: 1; min-width: 0; }
    .cp-messages .msg-body {
      font-size: 12px; color: var(--t-primary);
      line-height: 1.65; word-break: break-word;
      font-family: 'Inter', -apple-system, sans-serif;
    }
    .cp-messages .msg-body p { margin: 0 0 0.5em; }
    .cp-messages .msg-body p:last-child { margin-bottom: 0; }
    .cp-messages .msg-body h1,.cp-messages .msg-body h2,.cp-messages .msg-body h3 {
      color: var(--t-bright); margin: 0.7em 0 0.25em; font-weight: 600;
    }
    .cp-messages .msg-body h1 { font-size: 14px; }
    .cp-messages .msg-body h2 { font-size: 13px; }
    .cp-messages .msg-body h3 { font-size: 12px; }
    .cp-messages .msg-body code:not(pre code) {
      background: var(--s-subtle); border: 1px solid var(--b-subtle);
      border-radius: 4px; padding: 1px 5px; font-family: 'JetBrains Mono', monospace;
      font-size: 0.88em; color: var(--t-bright);
    }
    .cp-messages .msg-body pre {
      background: rgba(0,0,0,0.3); border: 1px solid var(--b-subtle);
      border-radius: 8px; padding: 10px; overflow-x: auto; margin: 0.5em 0;
    }
    .cp-messages .msg-body pre code {
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      color: var(--t-primary); background: none; border: none; padding: 0;
    }
    .cp-messages .msg-body a { color: var(--t-bright); text-decoration: none; }
    .cp-messages .msg-body a:hover { text-decoration: underline; }
    .cp-messages .msg-body strong { color: var(--t-bright); }
    .cp-messages .msg-body ul, .cp-messages .msg-body ol { padding-left: 1.3em; margin: 0.3em 0; }
    .cp-messages .msg-body ul { list-style: none; }
    .cp-messages .msg-body ul li { position: relative; }
    .cp-messages .msg-body ul li::before {
      content: ''; position: absolute; left: -1em; top: 0.6em;
      width: 4px; height: 4px; border-radius: 50%;
      background: rgba(255,255,255,0.2);
    }
    .cp-messages .msg-body ol li { color: var(--t-primary); }
    .cp-messages .msg-body ol li::marker { color: var(--t-faint); font-size: 11px; }
    .cp-messages .msg-body blockquote {
      margin: 0.5em 0; padding: 4px 0 4px 12px;
      border-left: 2px solid rgba(200,160,80,0.3);
      color: var(--t-secondary); font-style: italic;
    }
    .cp-messages .msg-body hr {
      border: none; height: 1px; margin: 0.8em 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent);
    }
    .cp-messages .msg-body table {
      width: 100%; border-collapse: collapse; margin: 0.5em 0; font-size: 11px;
    }
    .cp-messages .msg-body th {
      text-align: left; padding: 4px 8px; font-weight: 600; color: var(--t-bright);
      background: rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .cp-messages .msg-body td {
      padding: 3px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); color: var(--t-primary);
    }
    .cp-messages .msg-body tr:hover td { background: rgba(255,255,255,0.02); }

    /* ── Tool cards ── */
    .cp-messages .tool-card {
      border: 1px solid var(--b-subtle); border-radius: 8px;
      margin: 4px 0; overflow: hidden; font-size: 11px;
      background: var(--s-subtle); transition: border-color 0.2s;
    }
    .cp-messages .tool-card:hover { border-color: var(--b-light); }
    .cp-messages .tool-card.tool-ok { border-left: 3px solid rgba(100,200,120,0.5); }
    .cp-messages .tool-card.tool-error { border-left: 3px solid rgba(255,82,82,0.5); }
    .cp-messages .tool-hdr {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 10px; cursor: pointer; user-select: none; transition: background 0.15s;
    }
    .cp-messages .tool-hdr:hover { background: var(--s-hover); }
    .cp-messages .tool-icon {
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      color: var(--t-primary); background: var(--s-light); border-radius: 5px;
    }
    .cp-messages .tool-icon svg { width: 12px; height: 12px; }
    .cp-messages .tool-name { font-family: 'JetBrains Mono', monospace; color: var(--t-primary); font-weight: 600; font-size: 10.5px; }
    .cp-messages .tool-detail { font-family: 'JetBrains Mono', monospace; color: var(--t-faint); font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cp-messages .tool-chevron { color: var(--t-faint); font-size: 13px; transition: transform 0.2s; }
    .cp-messages .tool-card.open .tool-chevron { transform: rotate(90deg); color: var(--t-secondary); }
    .cp-messages .tool-body { display: none; border-top: 1px solid var(--b-subtle); }
    .cp-messages .tool-card.open .tool-body { display: block; }
    .cp-messages .tool-section-label { font-size: 8.5px; color: var(--t-faint); padding: 5px 10px 2px; font-family: 'JetBrains Mono', monospace; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; }
    .cp-messages .tool-section { padding: 4px 10px 6px; font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--t-muted); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; margin: 0; background: none; border: none; }

    /* ── SynaBun branded tool cards ── */
    .cp-messages .synabun-card { border-color: rgba(255,195,0,0.15); background: rgba(255,195,0,0.025); }
    .cp-messages .synabun-card:hover { border-color: rgba(255,195,0,0.25); }
    .cp-messages .synabun-card.tool-ok { border-left: 3px solid rgba(255,195,0,0.5); }
    .cp-messages .synabun-card.tool-error { border-left: 3px solid rgba(255,82,82,0.5); }
    .cp-messages .synabun-icon { background: rgba(255,195,0,0.10); color: rgba(255,210,60,0.85); }
    .cp-messages .synabun-name { color: rgba(255,210,60,0.85); }
    .cp-messages .synabun-section-label { color: rgba(255,195,0,0.45) !important; }
    .cp-messages .synabun-input { white-space: normal !important; word-break: normal !important; }
    .synabun-kv { padding: 2px 0; display: flex; gap: 6px; align-items: baseline; font-size: 10px; line-height: 1.4; font-family: 'JetBrains Mono', monospace; color: var(--t-muted); }
    .synabun-kv-key { color: rgba(255,210,60,0.55); font-weight: 600; flex-shrink: 0; min-width: 55px; }
    .synabun-kv-key::after { content: ':'; }
    .synabun-tag { display: inline-block; background: rgba(255,195,0,0.08); border: 1px solid rgba(255,195,0,0.15); border-radius: 3px; padding: 0 4px; font-size: 9px; color: rgba(255,210,60,0.7); margin-right: 3px; }
    .synabun-value { color: rgba(255,210,60,0.8); font-weight: 600; }
    .cp-messages .synabun-result { white-space: normal !important; word-break: normal !important; max-height: 400px !important; }
    .synabun-recall-results { display: flex; flex-direction: column; gap: 6px; }
    .synabun-recall-header { font-size: 9px; color: rgba(255,210,60,0.5); font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,195,0,0.08); font-family: 'JetBrains Mono', monospace; }
    .synabun-memory-card { background: rgba(255,195,0,0.03); border: 1px solid rgba(255,195,0,0.08); border-radius: 6px; padding: 6px 8px; transition: border-color 0.15s; }
    .synabun-memory-card:hover { border-color: rgba(255,195,0,0.2); }
    .synabun-mem-header { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .synabun-mem-score { background: rgba(255,195,0,0.12); color: rgba(255,210,60,0.9); font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; font-family: 'JetBrains Mono', monospace; flex-shrink: 0; }
    .synabun-mem-imp { font-size: 8px; color: rgba(255,195,0,0.4); font-family: 'JetBrains Mono', monospace; flex-shrink: 0; }
    .synabun-mem-cat { font-size: 9px; color: var(--t-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: 'JetBrains Mono', monospace; }
    .synabun-mem-age { font-size: 8.5px; color: var(--t-faint); flex-shrink: 0; font-family: 'JetBrains Mono', monospace; }
    .synabun-mem-tags { display: flex; gap: 3px; flex-wrap: wrap; margin: 3px 0; }
    .synabun-mem-content { font-size: 10px; color: var(--t-primary); line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 60px; overflow: hidden; mask-image: linear-gradient(to bottom, #fff 75%, transparent 100%); -webkit-mask-image: linear-gradient(to bottom, #fff 75%, transparent 100%); }
    .synabun-mem-id { font-size: 8px; color: var(--t-faint); font-family: 'JetBrains Mono', monospace; margin-top: 3px; opacity: 0.5; }
    .synabun-mem-files { font-size: 9px; color: var(--t-faint); margin-top: 2px; font-family: 'JetBrains Mono', monospace; }
    .synabun-confirmation { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; }
    .synabun-confirm-icon { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: rgba(255,195,0,0.10); color: rgba(255,210,60,0.8); }
    .synabun-confirm-icon svg { width: 11px; height: 11px; }
    .synabun-confirm-body { flex: 1; font-size: 10px; color: var(--t-primary); line-height: 1.5; font-family: 'JetBrains Mono', monospace; }
    .synabun-confirm-action { font-size: 9px; color: rgba(255,210,60,0.55); font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 2px; }
    .synabun-result-pre { margin: 0; background: none; border: none; white-space: pre-wrap; word-break: break-all; font-size: 10px; color: var(--t-muted); font-family: 'JetBrains Mono', monospace; }
    .synabun-stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 10px; font-family: 'JetBrains Mono', monospace; }
    .synabun-stats-label { color: var(--t-faint); }
    .synabun-stats-value { color: rgba(255,210,60,0.8); font-weight: 600; }
    .perm-card.synabun-perm.active-perm { border-color: rgba(255,195,0,0.3); background: rgba(255,195,0,0.04); }
    .synabun-perm .perm-header { color: rgba(255,210,60,0.7); }
    .synabun-perm .perm-tool-icon { background: rgba(255,195,0,0.10); color: rgba(255,210,60,0.85); }
    .synabun-summary { color: rgba(255,195,0,0.35) !important; }

    /* ── AskUserQuestion interactive cards ── */
    .ask-card {
      background: rgba(255,255,255,0.025);
      border: 1px solid rgba(100,160,255,0.12);
      border-radius: 10px; padding: 10px 12px;
      margin-top: 6px;
    }
    .ask-header {
      font-size: 9px; font-weight: 700; color: rgba(100,160,255,0.6);
      text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px;
      font-family: 'JetBrains Mono', monospace;
      display: flex; align-items: center; gap: 5px;
    }
    .ask-header::before {
      content: '';
      display: inline-block; width: 14px; height: 14px;
      background: url("data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='none' stroke='rgba(100,160,255,0.6)' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Ccircle cx='8' cy='8' r='6'/%3E%3Cpath d='M6 6.5a2 2 0 013.5 1.5c0 1-1.5 1.5-1.5 1.5'/%3E%3Cpath d='M8 11.5h0'/%3E%3C/svg%3E") no-repeat center;
      flex-shrink: 0;
    }
    .ask-question {
      font-size: 12px; color: rgba(255,255,255,0.8); margin-bottom: 8px; line-height: 1.45;
    }
    .ask-options { display: flex; flex-direction: column; gap: 4px; }
    .ask-option {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 7px 10px; border-radius: 8px; cursor: pointer;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      text-align: left; transition: all 0.15s;
    }
    .ask-option::before {
      content: '';
      width: 14px; height: 14px; flex-shrink: 0; margin-top: 1px;
      border: 1.5px solid rgba(255,255,255,0.15); border-radius: 50%;
      transition: all 0.15s;
    }
    .ask-option:hover:not(:disabled) {
      background: rgba(100,160,255,0.06);
      border-color: rgba(100,160,255,0.18);
    }
    .ask-option:hover:not(:disabled)::before {
      border-color: rgba(100,160,255,0.4);
    }
    .ask-option.selected {
      background: rgba(100,160,255,0.10);
      border-color: rgba(100,160,255,0.3);
    }
    .ask-option.selected::before {
      border-color: rgba(100,160,255,0.8);
      background: rgba(100,160,255,0.8);
      box-shadow: inset 0 0 0 2px rgba(14,14,18,0.85);
    }
    .ask-option:disabled:not(.selected) { opacity: 0.3; cursor: default; }
    .ask-option-wrap { display: flex; flex-direction: column; gap: 1px; }
    .ask-option-label {
      font-size: 11.5px; font-weight: 600; color: rgba(255,255,255,0.85);
    }
    .ask-option-desc {
      font-size: 10px; color: rgba(255,255,255,0.35); line-height: 1.3;
    }
    .ask-hint {
      font-size: 10px; color: rgba(100,160,255,0.45);
      font-family: 'JetBrains Mono', monospace; font-style: italic;
    }

    /* ── SynaBun-branded ask card ── */
    .ask-card.synabun-ask { position: relative; overflow: hidden; }
    .ask-card.synabun-ask .ask-header,
    .ask-card.synabun-ask .ask-question,
    .ask-card.synabun-ask .ask-options,
    .ask-card.synabun-ask .ask-hint { position: relative; z-index: 1; }
    .synabun-ask-bg-logo {
      position: absolute;
      right: 10px;
      top: 6px;
      transform: scale(0.85);
      width: 28px;
      opacity: 0;
      transition: opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1),
                  transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      z-index: 0;
    }
    .synabun-ask-bg-logo img {
      width: 100%;
      height: auto;
      opacity: 0.07;
    }
    .synabun-ask:hover .synabun-ask-bg-logo {
      opacity: 1;
      transform: scale(1);
    }

    /* ── Plan cards (inline rendered markdown) ── */
    .cp-messages .plan-card {
      border: 1px solid rgba(100,200,120,0.15); border-radius: 8px;
      margin: 4px 0; overflow: hidden; font-size: 11px;
      background: rgba(100,200,120,0.03);
    }
    .cp-messages .plan-card[open] { border-color: rgba(100,200,120,0.25); }
    .cp-messages .plan-card > summary {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 10px; cursor: pointer; user-select: none;
      list-style: none; transition: background 0.15s;
    }
    .cp-messages .plan-card > summary::-webkit-details-marker { display: none; }
    .cp-messages .plan-card > summary:hover { background: var(--s-hover); }
    .cp-messages .plan-card .plan-icon {
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      font-size: 9px; font-weight: 700; color: rgba(100,200,120,0.9);
      background: rgba(100,200,120,0.12); border-radius: 5px;
      font-family: 'JetBrains Mono', monospace;
    }
    .cp-messages .plan-card .plan-label {
      font-family: 'JetBrains Mono', monospace; color: rgba(100,200,120,0.9);
      font-weight: 600; font-size: 10.5px;
    }
    .cp-messages .plan-card .plan-file {
      font-family: 'JetBrains Mono', monospace; color: var(--t-faint);
      font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cp-messages .plan-card .plan-chevron {
      color: var(--t-faint); font-size: 13px; transition: transform 0.2s;
    }
    .cp-messages .plan-card[open] .plan-chevron { transform: rotate(90deg); color: rgba(100,200,120,0.6); }
    .cp-messages .plan-card .plan-body {
      border-top: 1px solid rgba(100,200,120,0.1); padding: 8px 12px;
    }

    /* ── Post-plan action card ── */
    .post-plan-card {
      background: var(--s-subtle);
      border: 1px solid rgba(100,200,120,0.25);
      border-radius: 8px; padding: 8px 10px;
      margin-top: 4px; position: relative;
      background: rgba(100,200,120,0.04);
      box-shadow: 0 0 16px rgba(100,200,120,0.06), 0 0 40px rgba(100,200,120,0.03);
      transition: opacity 0.3s, border-color 0.2s;
    }
    .post-plan-card:hover { border-color: rgba(100,200,120,0.35); }
    .post-plan-header {
      font-size: 8.5px; font-weight: 700; color: rgba(100,200,120,0.7);
      letter-spacing: 0.6px; margin-bottom: 6px;
      font-family: 'JetBrains Mono', monospace; text-transform: uppercase;
    }
    .post-plan-actions {
      display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    }
    .post-plan-action {
      padding: 4px 10px; border-radius: 5px; font-size: 10px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
      font-family: 'JetBrains Mono', monospace;
    }
    .post-plan-action.pp-primary {
      background: rgba(100,200,120,0.12); color: rgba(130,220,150,0.85);
      border-color: rgba(100,200,120,0.2);
    }
    .post-plan-action.pp-primary:hover {
      background: rgba(100,200,120,0.2); color: rgba(150,230,160,1);
      border-color: rgba(100,200,120,0.35);
    }
    .post-plan-action.pp-secondary {
      background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.35);
      border-color: rgba(255,255,255,0.06);
    }
    .post-plan-action.pp-secondary:hover {
      background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7);
      border-color: rgba(255,255,255,0.15);
    }

    /* ── Permission prompt cards ── */
    .perm-card {
      background: var(--s-subtle);
      border: 1px solid var(--b-subtle);
      border-radius: 8px; padding: 8px 10px;
      margin-top: 4px; transition: opacity 0.3s, border-color 0.2s, box-shadow 0.3s;
    }
    .perm-card { position: relative; }
    .perm-card::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 8px;
      padding: 1px;
      pointer-events: none;
      background: conic-gradient(
        from var(--cp-border-angle, 0deg),
        rgba(245,180,60,0.0) 0%,
        rgba(245,180,60,0.55) 25%,
        rgba(245,180,60,0.1) 50%,
        rgba(245,180,60,0.55) 75%,
        rgba(245,180,60,0.0) 100%
      );
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      opacity: 0;
      transition: opacity 0.4s;
    }
    .perm-card.active-perm {
      border-color: rgba(245,180,60,0.25);
      background: rgba(245,180,60,0.04);
      box-shadow: 0 0 16px rgba(245,180,60,0.08), 0 0 40px rgba(245,180,60,0.04);
      animation: cp-perm-glow 2.5s ease-in-out infinite;
    }
    .perm-card.active-perm::before {
      opacity: 1;
      animation: cp-border-spin 3s linear infinite;
    }
    .perm-card:hover { border-color: var(--b-light); }
    .perm-card.active-perm:hover { border-color: rgba(245,180,60,0.4); }
    .perm-header {
      font-size: 8.5px; font-weight: 700; color: rgba(245,180,60,0.7);
      letter-spacing: 0.6px; margin-bottom: 5px;
      font-family: 'JetBrains Mono', monospace; text-transform: uppercase;
    }
    .perm-tool-line {
      display: flex; align-items: center; gap: 7px; margin-bottom: 4px;
    }
    .perm-tool-icon {
      width: 20px; height: 20px; border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      background: var(--s-light); color: var(--t-primary);
    }
    .perm-tool-icon svg { width: 12px; height: 12px; }
    .perm-tool-name { font-size: 10.5px; font-weight: 600; font-family: 'JetBrains Mono', monospace; color: var(--t-primary); }
    .perm-detail {
      font-size: 10px; font-family: 'JetBrains Mono', monospace;
      color: var(--t-faint); word-break: break-all; margin-bottom: 6px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .perm-actions { display: flex; gap: 6px; align-items: center; }
    .perm-btn {
      padding: 4px 10px; border-radius: 5px; font-size: 10px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent; transition: all 0.15s;
      display: flex; align-items: center; gap: 3px;
      font-family: 'JetBrains Mono', monospace;
    }
    .perm-btn-icon { width: 10px; height: 10px; display: flex; align-items: center; }
    .perm-btn-icon svg { width: 9px; height: 9px; }
    .perm-btn-allow { background: rgba(245,180,60,0.12); color: rgba(245,195,90,0.85); border-color: rgba(245,180,60,0.2); }
    .perm-btn-allow:hover:not(:disabled) { background: rgba(245,180,60,0.2); color: rgba(245,200,100,1); border-color: rgba(245,180,60,0.35); }
    .perm-btn-deny { background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.35); border-color: rgba(255,255,255,0.06); }
    .perm-btn-deny:hover:not(:disabled) { background: rgba(255,80,80,0.08); color: rgba(255,120,120,0.7); border-color: rgba(255,80,80,0.15); }
    .perm-always {
      font-size: 9px; color: var(--t-faint); margin-left: auto;
      display: flex; align-items: center; gap: 3px; cursor: pointer;
      transition: color 0.15s; font-family: 'JetBrains Mono', monospace;
    }
    .perm-always:hover { color: var(--t-secondary); }
    .perm-always input { width: 10px; height: 10px; cursor: pointer; }
    .perm-status {
      font-size: 9px; font-weight: 600; font-family: 'JetBrains Mono', monospace;
      color: var(--t-faint); letter-spacing: 0.3px;
    }
    .perm-card.resolved { opacity: 0.45; box-shadow: none; animation: none; background: var(--s-subtle); border-color: var(--b-subtle); }
    .perm-card.resolved .perm-btn { pointer-events: none; }
    .perm-card.resolved .perm-btn-allow { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4); border-color: rgba(255,255,255,0.08); }
    .perm-card.resolved .perm-always { display: none; }
    .perm-card.resolved .perm-header { color: var(--t-faint); }

    /* ── Status / errors / thinking ── */
    .cp-messages .msg-status { padding: 2px 14px 2px 48px; font-size: 10px; color: var(--t-faint); font-family: 'JetBrains Mono', monospace; }
    .cp-messages .msg-error { padding: 4px 14px 4px 48px; font-size: 10.5px; color: #ff5252; font-family: 'JetBrains Mono', monospace; }
    .cp-messages .msg-tools-summary {
      font-size: 9.5px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2); padding: 3px 0; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cp-messages .thinking { display: flex; gap: 10px; align-items: center; padding: 10px 14px; }
    .cp-messages .think-avatar {
      width: 24px; height: 24px; border-radius: 7px;
      background: rgba(255,255,255,0.06);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; color: rgba(255,255,255,0.5);
    }
    .cp-messages .think-avatar svg { width: 14px; height: 14px; }
    .cp-messages .think-dots { display: flex; gap: 5px; align-items: center; }
    .cp-messages .think-dots span { width: 4px; height: 4px; border-radius: 50%; background: var(--t-secondary); animation: cp-pulse 1.4s ease-in-out infinite; }
    .cp-messages .think-dots span:nth-child(2) { animation-delay: 0.2s; }
    .cp-messages .think-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes cp-pulse { 0%,80%,100% { opacity: 0.15; transform: scale(0.6); } 40% { opacity: 1; transform: scale(1.1); } }

    /* ── Extended thinking blocks — matches tool-card design ── */
    .msg-thinking {
      border: 1px solid var(--b-subtle); border-radius: 8px;
      margin: 4px 0; overflow: hidden;
      background: var(--s-subtle); transition: border-color 0.2s;
    }
    .msg-thinking:hover { border-color: var(--b-light); }
    .msg-thinking summary {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 10px; cursor: pointer; user-select: none;
      transition: background 0.15s; list-style: none;
    }
    .msg-thinking summary::-webkit-details-marker { display: none; }
    .msg-thinking summary:hover { background: var(--s-hover); }
    .msg-thinking .msg-thinking-icon {
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      color: var(--t-primary); background: var(--s-light); border-radius: 5px;
    }
    .msg-thinking .msg-thinking-icon svg { width: 12px; height: 12px; }
    .msg-thinking .msg-thinking-label {
      font-family: 'JetBrains Mono', monospace; color: var(--t-primary);
      font-weight: 600; font-size: 10.5px;
    }
    .msg-thinking .msg-thinking-chevron {
      color: var(--t-faint); font-size: 13px; transition: transform 0.2s; margin-left: auto;
    }
    .msg-thinking[open] .msg-thinking-chevron { transform: rotate(90deg); color: var(--t-secondary); }
    .msg-thinking-content {
      display: none; border-top: 1px solid var(--b-subtle);
      padding: 6px 10px 8px; font-family: 'JetBrains Mono', monospace;
      font-size: 10px; color: var(--t-muted); white-space: pre-wrap;
      word-break: break-word; max-height: 300px; overflow-y: auto;
      line-height: 1.55; margin: 0; background: none;
    }
    .msg-thinking[open] .msg-thinking-content { display: block; }
    .msg-thinking-content::-webkit-scrollbar { width: 2px; }
    .msg-thinking-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

    .cp-messages .session-divider {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px; font-size: 9px; color: var(--t-faint);
      font-family: 'JetBrains Mono', monospace; letter-spacing: 0.05em;
    }
    .cp-messages .session-divider::before, .cp-messages .session-divider::after {
      content: ''; flex: 1; height: 1px; background: var(--b-subtle);
    }

    /* ── Bottom area (input + toolbar) ── */
    .cp-bottom {
      flex-shrink: 0;
      border-top: none;
      border-radius: 10px;
      margin: 0 8px 8px 8px;
      background: rgba(22, 22, 26, 0.95);
      padding-bottom: 4px;
      z-index: 2;
      box-shadow: 0 -2px 8px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06);
    }

    .cp-input-area {
      padding: 8px 8px 2px;
      display: flex; gap: 0; align-items: flex-end;
    }

    /* Animated border wrapper — conic gradient border on focus */
    .cp-input-wrap {
      flex: 1; position: relative;
      border-radius: 14px;
      padding: 1px;
      background: rgba(255,255,255,0.05);
      transition: background 0.4s;
    }
    .cp-input-wrap::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 14px;
      padding: 1px;
      pointer-events: none;
      background: conic-gradient(
        from var(--cp-border-angle, 0deg),
        rgba(255,255,255,0.0) 0%,
        rgba(255,255,255,0.22) 25%,
        rgba(255,255,255,0.06) 50%,
        rgba(255,255,255,0.22) 75%,
        rgba(255,255,255,0.0) 100%
      );
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      opacity: 0;
      transition: opacity 0.4s;
    }
    .cp-input-wrap:focus-within::before {
      opacity: 1;
      animation: cp-border-spin 3s linear infinite;
    }
    .cp-input-wrap:focus-within {
      background: rgba(255,255,255,0.03);
      box-shadow: 0 0 20px rgba(255,255,255,0.03), 0 0 60px rgba(255,255,255,0.01);
    }
    @keyframes cp-border-spin {
      to { --cp-border-angle: 360deg; }
    }
    @keyframes cp-perm-glow {
      0%, 100% { box-shadow: 0 0 16px rgba(245,180,60,0.08), 0 0 40px rgba(245,180,60,0.04); }
      50% { box-shadow: 0 0 20px rgba(245,180,60,0.14), 0 0 50px rgba(245,180,60,0.07); }
    }
    @property --cp-border-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }

    .cp-input-inner {
      display: flex; align-items: flex-end;
      background: rgba(12,12,16,0.9);
      border-radius: 13px;
      padding: 5px 5px 5px 14px;
      gap: 4px;
      position: relative;
    }
    .cp-input-wrap .cp-image-preview:not(:empty) + .cp-input-inner {
      border-radius: 0 0 13px 13px;
    }

    .cp-input {
      flex: 1; background: transparent; border: none;
      color: var(--t-bright); font-size: 13px;
      font-family: 'Inter', -apple-system, sans-serif; padding: 6px 0;
      resize: none; outline: none; line-height: 1.5;
      max-height: 180px;
      overflow-y: auto;
      overflow-wrap: break-word;
      word-break: break-word;
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
      transition: scrollbar-color 0.3s;
    }
    .cp-input:hover, .cp-input:focus {
      scrollbar-color: rgba(255,255,255,0.08) transparent;
    }
    .cp-input::-webkit-scrollbar { width: 4px; }
    .cp-input::-webkit-scrollbar-track { background: transparent; }
    .cp-input::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; }
    .cp-input:hover::-webkit-scrollbar-thumb, .cp-input:focus::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); }
    .cp-input::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
    .cp-input.scrollable {
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 6px, black calc(100% - 10px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0px, black 6px, black calc(100% - 10px), transparent 100%);
    }
    .cp-input::placeholder { color: rgba(255,255,255,0.16); transition: color 0.3s; }
    .cp-input:focus::placeholder { color: rgba(255,255,255,0.22); }

    /* ── Send button — flat square, sweep fill on enable ── */
    .cp-send {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      color: rgba(255,255,255,0.15); width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.22, 0.68, 0, 1.2);
      position: sticky; bottom: 3px; align-self: flex-end;
      overflow: hidden;
    }
    .cp-send::before {
      content: '';
      position: absolute; inset: 0;
      background: linear-gradient(135deg, rgba(255,255,255,0.12), rgba(255,255,255,0.04));
      border-radius: 7px;
      transform: scaleX(0);
      transform-origin: left;
      transition: transform 0.3s cubic-bezier(0.22, 0.68, 0, 1.2);
    }
    .cp-send:not(:disabled)::before {
      transform: scaleX(1);
    }
    .cp-send:not(:disabled) {
      color: rgba(255,255,255,0.7);
      border-color: rgba(255,255,255,0.1);
    }
    .cp-send:hover:not(:disabled) {
      border-color: rgba(255,255,255,0.2);
      color: rgba(255,255,255,0.95);
      box-shadow: 0 0 12px rgba(255,255,255,0.06);
      transform: translateY(-1px);
    }
    .cp-send:hover:not(:disabled)::before {
      background: linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.06));
    }
    .cp-send:active:not(:disabled) {
      transform: translateY(0px) scale(0.95);
      transition-duration: 0.08s;
    }
    .cp-send:disabled { opacity: 0.4; cursor: default; }
    .cp-send.abort {
      border-color: rgba(255,70,70,0.2);
      color: rgba(255,100,100,0.85);
    }
    .cp-send.abort::before {
      transform: scaleX(1);
      background: linear-gradient(135deg, rgba(255,70,70,0.15), rgba(255,50,50,0.05));
      animation: cp-abort-sweep 2s ease-in-out infinite;
    }
    .cp-send.abort:hover {
      color: #ff6666;
      border-color: rgba(255,70,70,0.35);
      box-shadow: 0 0 12px rgba(255,70,70,0.12);
      transform: translateY(-1px);
    }
    .cp-send.abort:active {
      transform: translateY(0px) scale(0.95);
    }
    @keyframes cp-abort-sweep {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }
    .cp-send svg { width: 12px; height: 12px; position: relative; z-index: 1; }
    .cp-send.btw {
      border-color: rgba(100,180,255,0.3);
      color: rgba(120,180,255,0.9);
    }
    .cp-send.btw::before {
      transform: scaleX(1);
      background: linear-gradient(135deg, rgba(100,180,255,0.15), rgba(80,140,255,0.05));
    }
    .cp-send.btw:hover {
      color: #78b4ff;
      border-color: rgba(100,180,255,0.45);
      box-shadow: 0 0 12px rgba(100,180,255,0.12);
    }

    /* ── Attach button ── */
    .cp-attach {
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(255,255,255,0.2); position: relative; display: flex; align-items: center;
      flex-shrink: 0; transition: color 0.2s, transform 0.25s;
    }
    .cp-attach:hover { color: rgba(255,255,255,0.55); transform: translateY(-1px); }
    .cp-attach:active { transform: translateY(0px) scale(0.92); }
    .cp-attach-badge {
      position: absolute; top: -2px; right: -4px;
      background: #c8a050; color: #000; border-radius: 50%;
      font-size: 8px; width: 12px; height: 12px;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700;
    }
    .cp-attach-badge[hidden] { display: none; }

    .file-link {
      color: #6ea8d8; text-decoration: none;
      border-bottom: 1px dotted rgba(110, 168, 216, 0.3);
      cursor: pointer;
    }
    .file-link:hover { text-decoration: underline; }

    /* ── Bottom toolbar — status bar style ── */
    .cp-toolbar {
      display: flex; align-items: center;
      flex-wrap: nowrap;
      gap: 0;
      padding: 4px 10px 2px;
      flex-shrink: 0;
    }
    .cp-toolbar-left { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
    .cp-toolbar-right { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }

    .cp-brand {
      height: 16px; width: auto; opacity: 0.6; flex-shrink: 0;
    }

    .cp-dropdown {
      position: relative;
      display: flex; align-items: center; gap: 2px;
      background: transparent;
      border: none;
      border-radius: 4px;
      padding: 3px 5px;
      cursor: pointer; user-select: none;
      max-width: 90px;
      flex-shrink: 1; min-width: 0;
      transition: background 0.15s;
    }
    .cp-dropdown:hover { background: rgba(255,255,255,0.04); }
    .cp-dropdown.open { background: rgba(255,255,255,0.06); }
    .cp-dropdown-sm { max-width: 72px; }
    .cp-dd-label {
      font-size: 9.5px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.3);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
    }
    .cp-dropdown.has-value .cp-dd-label { color: rgba(255,255,255,0.5); }
    .cp-dd-arrow {
      font-size: 7px; color: rgba(255,255,255,0.15); flex-shrink: 0;
      transition: transform 0.2s, color 0.2s;
    }
    .cp-dropdown:hover .cp-dd-arrow { color: rgba(255,255,255,0.3); }
    .cp-dropdown.open .cp-dd-arrow { transform: rotate(180deg); color: rgba(255,255,255,0.4); }
    .cp-dd-menu {
      display: none;
      position: absolute; bottom: calc(100% + 4px); left: 0;
      min-width: 100%; max-width: 200px;
      background: rgba(12, 12, 14, 0.98);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 4px;
      z-index: 300;
      box-shadow: 0 -8px 24px rgba(0,0,0,0.4);
      max-height: 200px; overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.06) transparent;
    }
    .cp-dropdown.open .cp-dd-menu { display: block; }
    .cp-dd-item {
      padding: 5px 8px;
      font-size: 10.5px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.55);
      border-radius: 5px; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background 0.1s, color 0.1s;
    }
    .cp-dd-item:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); }
    .cp-dd-item.selected { color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.08); }

    .cp-cost {
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.18); padding: 2px 6px;
      white-space: nowrap; flex-shrink: 0;
      transition: color 0.2s;
    }
    .cp-cost:hover { color: rgba(255,255,255,0.45); }
    .cp-cost.flash { color: rgba(255,255,255,0.7); }

    .cp-btn {
      background: none; border: 1px solid var(--b-subtle); color: var(--t-faint);
      cursor: pointer; font-size: 12px; font-weight: 700;
      width: 20px; height: 20px; border-radius: 5px;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s;
    }
    .cp-btn:hover { color: var(--t-primary); border-color: var(--b-hover); background: var(--s-hover); }

    /* Header button styles moved to .cp-header-btn */

    /* ── Image preview strip (inside input wrap) ── */
    .cp-image-preview {
      display: flex; gap: 6px; padding: 8px 12px 6px;
      overflow-x: auto; flex-shrink: 0;
      background: rgba(12,12,16,0.9);
      border-radius: 13px 13px 0 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .cp-image-preview:empty { display: none; border-bottom: none; }
    .cp-thumb {
      position: relative; flex-shrink: 0;
      border-radius: 8px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .cp-thumb img {
      height: 48px; width: auto; max-width: 80px;
      object-fit: cover; display: block;
    }
    .cp-thumb-x {
      position: absolute; top: 1px; right: 1px;
      background: rgba(0,0,0,0.7); border: none; color: rgba(255,255,255,0.7);
      width: 14px; height: 14px; border-radius: 50%;
      font-size: 10px; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transition: opacity 0.15s;
    }
    .cp-thumb:hover .cp-thumb-x { opacity: 1; }
    .cp-thumb-x:hover { background: rgba(255,60,60,0.8); color: #fff; }

    /* ── File attachment chips ── */
    .cp-file-chip {
      display: flex; align-items: center; gap: 4px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px; padding: 3px 6px 3px 8px;
      flex-shrink: 0;
      transition: background 0.15s, border-color 0.15s;
    }
    .cp-file-chip:hover {
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.1);
    }
    .cp-file-chip-name {
      font-size: 10px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.5); white-space: nowrap;
    }
    .cp-file-chip-x {
      background: none; border: none; color: rgba(255,255,255,0.2);
      cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px;
      transition: color 0.15s;
    }
    .cp-file-chip-x:hover { color: rgba(255,60,60,0.8); }

    /* ── Slash command hints ── */
    .cp-slash-hints {
      display: none;
      position: absolute; bottom: calc(100% + 4px); left: 0; right: 0;
      background: rgba(12,12,14,0.98);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 4px;
      z-index: 310; max-height: 200px; overflow-y: auto;
      box-shadow: 0 -8px 24px rgba(0,0,0,0.4);
    }
    .cp-slash-hints.open { display: block; }
    .cp-slash-item {
      padding: 6px 10px; border-radius: 6px; cursor: pointer;
      transition: background 0.12s;
    }
    .cp-slash-item:hover, .cp-slash-item.active { background: rgba(255,255,255,0.06); }
    .cp-slash-name {
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.7); font-weight: 600;
    }
    .cp-slash-desc {
      font-size: 9.5px; color: rgba(255,255,255,0.3);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* ── Drag-drop overlay ── */
    .cp-drop-overlay {
      position: absolute; inset: 0; z-index: 400;
      background: rgba(100,160,255,0.06);
      border: 2px dashed rgba(100,160,255,0.3);
      border-radius: inherit;
      display: flex; align-items: center; justify-content: center;
      color: rgba(100,160,255,0.5); font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      pointer-events: none;
    }

    /* ── Tool result images ── */
    .tool-result-content img {
      max-width: 100%; max-height: 300px;
      border-radius: 6px; margin: 4px 0; display: block;
    }

    /* ── Session selector header ── */
    .cp-header {
      position: relative;
      padding: 10px 10px 10px 14px;
      border-bottom: none;
      border-radius: 10px;
      margin: 8px 8px 0 8px;
      flex-shrink: 0;
      display: flex; align-items: center;
      background: rgba(22, 22, 26, 0.95);
      z-index: 3;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .cp-header-actions {
      display: flex; align-items: center; gap: 3px; margin-left: auto; flex-shrink: 0;
    }
    .cp-header-btn {
      display: flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border-radius: 7px;
      border: none; background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.4); cursor: pointer;
      transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1); position: relative;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .cp-header-btn:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.75); transform: scale(1.05); }
    .cp-header-btn:active { transform: scale(0.92); transition-duration: 0.06s; }
    .cp-header-btn svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .cp-header-btn.cp-new-btn:hover { color: rgba(110,181,255,0.95); background: rgba(110,181,255,0.14); }
    .cp-header-btn.cp-minimize-btn:hover { color: rgba(255,200,50,0.95); background: rgba(255,200,50,0.14); }
    .cp-header-btn.cp-close-btn:hover { color: rgba(255,82,82,0.95); background: rgba(255,82,82,0.14); }
    .cp-header-btn.cp-close-btn svg { stroke-width: 2.5; }
    .cp-header-btn.cp-slide-btn:hover { color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.08); }
    .cp-header-btn.cp-slide-btn svg { stroke-width: 2.5; }
    .cp-session-btn {
      background: rgba(255,255,255,0.03); border: none;
      display: flex; align-items: center; gap: 5px;
      color: rgba(255,255,255,0.55);
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      cursor: pointer; padding: 5px 10px; border-radius: 8px;
      transition: background 0.15s, color 0.15s;
      max-width: 100%; overflow: hidden;
    }
    .cp-session-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.75); }
    .cp-session-btn .cp-session-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cp-header-rename-btn {
      display: flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border-radius: 7px;
      border: none; background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.4); cursor: pointer;
      transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1); position: relative;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      flex-shrink: 0;
    }
    .cp-header-rename-btn:hover { color: rgba(100,160,255,0.95); background: rgba(100,160,255,0.14); transform: scale(1.05); }
    .cp-header-rename-btn:active { transform: scale(0.92); transition-duration: 0.06s; }
    .cp-header-rename-btn svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .cp-project-bar {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 10px 0;
      flex-shrink: 0;
    }
    .cp-session-menu {
      display: none; position: absolute;
      top: calc(100% + 2px); left: 8px; right: 8px;
      background: rgba(12, 12, 14, 0.98);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 4px;
      z-index: 310; max-height: 360px; overflow-y: auto;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.06) transparent;
    }
    .cp-session-menu.open { display: block; }
    .cp-session-menu::-webkit-scrollbar { width: 3px; }
    .cp-session-menu::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }
    .cp-sess-group {
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2); letter-spacing: 0.5px;
      text-transform: uppercase; padding: 6px 8px 2px;
    }
    .cp-sess-group:first-child { padding-top: 4px; }
    .cp-sess-item {
      padding: 5px 8px; cursor: pointer; border-radius: 6px;
      transition: background 0.12s; position: relative;
    }
    .cp-sess-item:hover { background: rgba(255,255,255,0.06); }
    .cp-sess-item.active { background: rgba(255,255,255,0.08); }
    .cp-sess-prompt {
      font-size: 11px; color: rgba(255,255,255,0.5);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      line-height: 1.4;
    }
    .cp-sess-item:hover .cp-sess-prompt { color: rgba(255,255,255,0.8); }
    .cp-sess-item.active .cp-sess-prompt { color: rgba(255,255,255,0.75); }
    .cp-sess-meta {
      display: flex; align-items: center; gap: 5px;
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.2); margin-top: 1px;
    }
    .cp-sess-branch {
      background: rgba(255,255,255,0.06);
      padding: 0 4px; border-radius: 3px;
    }
    .cp-rename-input {
      background: rgba(255,255,255,0.08); border: 1px solid rgba(100,160,255,0.3);
      border-radius: 4px; color: rgba(255,255,255,0.9);
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px; width: 100%; outline: none;
    }
    .cp-rename-input:focus { border-color: rgba(100,160,255,0.5); }
    .cp-sess-rename {
      display: none; position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(255,255,255,0.15); font-size: 10px;
      transition: color 0.15s;
    }
    .cp-sess-item:hover .cp-sess-rename { display: block; }
    .cp-sess-rename:hover { color: rgba(100,160,255,0.7); }
    .cp-sess-new {
      padding: 5px 8px; cursor: pointer; border-radius: 6px;
      font-size: 11px; color: rgba(255,255,255,0.35);
      font-family: 'JetBrains Mono', monospace;
      transition: background 0.12s, color 0.12s;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      margin-bottom: 2px;
    }
    .cp-sess-new:hover { background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.6); }
    .cp-sess-loading {
      padding: 12px 8px; text-align: center;
      font-size: 10px; color: rgba(255,255,255,0.2);
      font-family: 'JetBrains Mono', monospace;
    }

    /* ── Claude session pills in shared tray ── */
    .cp-session-pill .term-minimized-pill-icon { color: rgba(100, 160, 255, 0.6); }
    .cp-session-pill .term-minimized-pill-icon svg { width: 12px; height: 12px; }
    .cp-session-pill.cp-pill-enter {
      animation: cp-pill-pop-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
    }
    @keyframes cp-pill-pop-in {
      0% { opacity: 0; transform: scale(0.6) translateX(12px); }
      100% { opacity: 1; transform: scale(1) translateX(0); }
    }
    .cp-session-pill.cp-pill-running .term-minimized-pill-label::before {
      content: ''; display: inline-block; width: 6px; height: 6px;
      border-radius: 50%; background: rgba(100, 200, 120, 0.7);
      margin-right: 5px; vertical-align: middle;
      animation: cp-pill-pulse 1.5s ease-in-out infinite;
    }
    @keyframes cp-pill-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

    /* ── Context gauge bar ── */
    .cp-context-bar {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; flex-shrink: 0;
      margin: 6px 8px 0;
      background: rgba(22, 22, 26, 0.95);
      border-radius: 10px;
      z-index: 2;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .cp-gauge {
      flex: 1; height: 16px; border-radius: 6px;
      background: rgba(255,255,255,0.03);
      display: flex; overflow: hidden;
      position: relative; cursor: default;
      transition: background 0.5s, box-shadow 0.5s;
    }
    .cp-gauge[data-urgency="warn"] { background: rgba(200,180,50,0.06); box-shadow: 0 0 6px rgba(200,180,50,0.08); }
    .cp-gauge[data-urgency="high"] { background: rgba(220,130,50,0.08); box-shadow: 0 0 8px rgba(220,130,50,0.1); }
    .cp-gauge[data-urgency="critical"] { background: rgba(220,60,60,0.1); box-shadow: 0 0 10px rgba(220,60,60,0.12); }
    .cp-gauge-section {
      height: 100%; min-width: 1px;
      transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative; border-radius: 2px;
    }
    .cp-gauge-section[data-cat="cache-read"] { background: rgba(100,140,200,0.45); }
    .cp-gauge-section[data-cat="cache-write"] { background: rgba(150,100,200,0.45); }
    .cp-gauge-section[data-cat="input"] { background: rgba(100,200,150,0.45); }
    .cp-gauge-section[data-cat="output"] { background: rgba(220,170,80,0.45); }
    .cp-gauge-tip {
      position: absolute; bottom: calc(100% + 6px); left: 50%;
      transform: translateX(-50%);
      background: rgba(8,8,10,0.95); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 4px; padding: 2px 6px;
      font-size: 8.5px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.6);
      white-space: nowrap; pointer-events: none;
      opacity: 0; transition: opacity 0.15s;
      z-index: 10;
    }
    .cp-gauge-section:hover .cp-gauge-tip { opacity: 1; }
    .cp-gauge-label {
      position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.35); white-space: nowrap;
      z-index: 2; pointer-events: none; letter-spacing: 0.3px;
      transition: color 0.5s;
    }
    .cp-context-bar:has(.cp-gauge[data-urgency="warn"]) .cp-gauge-label { color: rgba(220,200,80,0.5); }
    .cp-context-bar:has(.cp-gauge[data-urgency="high"]) .cp-gauge-label { color: rgba(220,150,60,0.6); }
    .cp-context-bar:has(.cp-gauge[data-urgency="critical"]) .cp-gauge-label { color: rgba(220,80,60,0.7); }
    .cp-compact-btn {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.35); cursor: pointer;
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      padding: 2px 10px; border-radius: 10px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); flex-shrink: 0;
      text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600;
      position: relative; overflow: hidden;
    }
    .cp-compact-btn:hover {
      color: rgba(255,255,255,0.65);
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.14);
      transform: scale(1.03);
    }
    .cp-compact-btn:active { transform: scale(0.96); }
    .cp-compact-btn.compacting {
      color: rgba(140,130,220,0.7);
      border-color: rgba(140,130,220,0.2);
      background: rgba(140,130,220,0.06);
      pointer-events: none;
    }
    .cp-compact-btn.compacting::after {
      content: '';
      position: absolute; left: 0; bottom: 0;
      width: 100%; height: 2px;
      background: linear-gradient(90deg, transparent, rgba(140,130,220,0.6), transparent);
      animation: cp-compact-sweep 1.2s ease-in-out infinite;
    }
    @keyframes cp-compact-sweep {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    @keyframes cp-gauge-flow {
      0% { background-position: 100% 0; }
      100% { background-position: -100% 0; }
    }
    .cp-gauge.compacting .cp-gauge-section {
      background-image: linear-gradient(
        90deg,
        transparent 0%,
        rgba(140,130,220,0.2) 30%,
        rgba(140,130,220,0.35) 50%,
        rgba(140,130,220,0.2) 70%,
        transparent 100%
      );
      background-size: 200% 100%;
      animation: cp-gauge-flow 2s ease-in-out infinite;
    }
    .cp-gauge.compacting { opacity: 0.6; box-shadow: 0 0 8px rgba(140,130,220,0.08); }
    .cp-gauge-label.compacting { color: rgba(140,130,220,0.4) !important; }

    /* ── Think intensity toggle ── */
    /* ── Shared toggle base ── */
    .cp-toggle-icon { width: 10px; height: 10px; display: block; flex-shrink: 0; }

    /* ── Toggle buttons — flat text + underline indicator ── */
    .cp-think-toggle, .cp-plan-toggle, .cp-auto-toggle {
      background: transparent; border: none;
      color: rgba(255,255,255,0.22); cursor: pointer;
      font-size: 9px; font-family: 'JetBrains Mono', monospace; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.6px;
      padding: 4px 7px 6px;
      transition: color 0.2s, transform 0.2s;
      flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 3px;
      position: relative;
    }
    /* underline indicator — hidden by default */
    .cp-think-toggle::after, .cp-plan-toggle::after, .cp-auto-toggle::after {
      content: '';
      position: absolute; bottom: 0; left: 25%; right: 25%;
      height: 1.5px; border-radius: 1px;
      background: rgba(255,255,255,0.35);
      transform: scaleX(0);
      transition: transform 0.25s cubic-bezier(0.22, 0.68, 0, 1.2), background 0.2s;
    }
    .cp-think-toggle:hover, .cp-plan-toggle:hover, .cp-auto-toggle:hover {
      color: rgba(255,255,255,0.5);
      transform: translateY(-1px);
    }
    .cp-think-toggle:hover::after, .cp-plan-toggle:hover::after, .cp-auto-toggle:hover::after {
      transform: scaleX(1);
      background: rgba(255,255,255,0.2);
    }
    .cp-think-toggle:active, .cp-plan-toggle:active, .cp-auto-toggle:active {
      transform: translateY(0px) scale(0.96);
      transition-duration: 0.08s;
    }

    /* ── Think toggle specifics ── */
    .cp-think-icon { display: flex; align-items: center; transition: opacity 0.25s; opacity: 0.35; }
    .cp-think-icon svg { display: block; }
    .cp-think-label { transition: color 0.25s; }
    .cp-think-dots {
      display: flex; gap: 2px; align-items: center; margin-left: 2px;
    }
    .cp-think-dots i {
      display: block; width: 3px; height: 3px; border-radius: 50%;
      background: currentColor; opacity: 0.1; font-style: normal;
      transition: opacity 0.3s, background 0.3s, transform 0.3s;
    }
    .cp-think-dots i.lit { opacity: 1; transform: scale(1.2); }
    .cp-think-toggle[data-effort="off"] .cp-think-dots { display: none; }

    /* Think effort levels — progressive brightness + underline */
    .cp-think-toggle[data-effort="low"] {
      color: rgba(255,255,255,0.35);
    }
    .cp-think-toggle[data-effort="low"]::after { transform: scaleX(0.4); background: rgba(255,255,255,0.2); }
    .cp-think-toggle[data-effort="low"] .cp-think-icon { opacity: 0.45; }
    .cp-think-toggle[data-effort="low"] .cp-think-dots i.lit { background: rgba(255,255,255,0.35); }

    .cp-think-toggle[data-effort="medium"] {
      color: rgba(255,255,255,0.45);
    }
    .cp-think-toggle[data-effort="medium"]::after { transform: scaleX(0.6); background: rgba(255,255,255,0.3); }
    .cp-think-toggle[data-effort="medium"] .cp-think-icon { opacity: 0.55; }
    .cp-think-toggle[data-effort="medium"] .cp-think-dots i.lit { background: rgba(255,255,255,0.4); }

    .cp-think-toggle[data-effort="high"] {
      color: rgba(255,255,255,0.55);
    }
    .cp-think-toggle[data-effort="high"]::after { transform: scaleX(0.8); background: rgba(255,255,255,0.4); }
    .cp-think-toggle[data-effort="high"] .cp-think-icon { opacity: 0.65; }
    .cp-think-toggle[data-effort="high"] .cp-think-dots i.lit { background: rgba(255,255,255,0.5); }

    .cp-think-toggle[data-effort="max"] {
      color: rgba(255,255,255,0.7);
    }
    .cp-think-toggle[data-effort="max"]::after { transform: scaleX(1); background: rgba(255,255,255,0.5); }
    .cp-think-toggle[data-effort="max"] .cp-think-icon { opacity: 0.8; }
    .cp-think-toggle[data-effort="max"] .cp-think-dots i.lit { background: rgba(255,255,255,0.6); }

    /* ── Plan toggle active — underline + color ── */
    .cp-plan-toggle.active {
      color: rgba(130, 175, 255, 0.85);
    }
    .cp-plan-toggle.active::after {
      transform: scaleX(1);
      background: rgba(130, 175, 255, 0.6);
    }
    .cp-plan-toggle.active:hover {
      color: rgba(150, 190, 255, 1);
      transform: translateY(-1px);
    }

    /* ── Auto toggle active — underline + color ── */
    .cp-auto-toggle.active {
      color: rgba(100, 210, 140, 0.85);
    }
    .cp-auto-toggle.active::after {
      transform: scaleX(1);
      background: rgba(100, 210, 140, 0.6);
    }
    .cp-auto-toggle.active:hover {
      color: rgba(120, 230, 160, 1);
      transform: translateY(-1px);
    }

    /* ── Thinking timer ── */
    .cp-messages .think-timer {
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.12); margin-left: 4px;
    }

    /* ── Path attachment chips (for Send to AI) ── */
    .cp-path-chip {
      display: flex; align-items: center; gap: 5px;
      background: rgba(100,160,255,0.06);
      border: 1px solid rgba(100,160,255,0.12);
      border-radius: 6px; padding: 4px 6px 4px 8px;
      flex-shrink: 0;
    }
    .cp-path-chip-icon {
      color: rgba(100,160,255,0.4); flex-shrink: 0;
    }
    .cp-path-chip-icon svg { width: 12px; height: 12px; }
    .cp-path-chip-name {
      font-size: 10px; font-family: 'JetBrains Mono', monospace;
      color: rgba(100,160,255,0.6); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 140px;
    }
    .cp-path-chip-x {
      background: none; border: none; color: rgba(255,255,255,0.2);
      cursor: pointer; font-size: 12px; line-height: 1; padding: 0 1px;
      transition: color 0.15s;
    }
    .cp-path-chip-x:hover { color: rgba(255,60,60,0.8); }
  `;
  document.head.appendChild(style);
}

// ── Custom dropdown helpers ──
function ddSetup(dd) {
  dd._value = '';
  dd.addEventListener('click', (e) => {
    if (e.target.closest('.cp-dd-item')) return;
    // close all others
    _panel.querySelectorAll('.cp-dropdown.open').forEach(d => { if (d !== dd) d.classList.remove('open'); });
    dd.classList.toggle('open');
  });
}
function ddPopulate(dd, items, selectedValue) {
  const menu = dd.querySelector('.cp-dd-menu');
  menu.innerHTML = '';
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'cp-dd-item' + (item.value === selectedValue ? ' selected' : '');
    el.textContent = item.label;
    el.dataset.value = item.value;
    el.addEventListener('click', () => {
      dd._value = item.value;
      dd.querySelector('.cp-dd-label').textContent = item.label;
      dd.classList.add('has-value');
      dd.classList.remove('open');
      menu.querySelectorAll('.cp-dd-item').forEach(i => i.classList.remove('selected'));
      el.classList.add('selected');
      dd.dispatchEvent(new Event('change'));
    });
    menu.appendChild(el);
  }
  if (selectedValue) {
    const match = items.find(i => i.value === selectedValue);
    if (match) { dd.querySelector('.cp-dd-label').textContent = match.label; dd.classList.add('has-value'); dd._value = selectedValue; }
  }
}
function ddGetValue(dd) { return dd?._value || ''; }

// ── Model helpers (composite value = "modelId:contextWindow") ──
function _getModelId() {
  const $model = _panel?.querySelector('#cp-model');
  const raw = ddGetValue($model);
  return raw.split(':')[0] || '';
}
function _getContextWindow() {
  const $model = _panel?.querySelector('#cp-model');
  const raw = ddGetValue($model);
  const parts = raw.split(':');
  return parts[1] ? parseInt(parts[1], 10) : 200000;
}

// ── Think intensity helpers ──
function _setEffort(btn, level) {
  if (!btn) return;
  btn.dataset.effort = level;
  const label = btn.querySelector('.cp-think-label');
  if (label) label.textContent = EFFORT_LABELS[level] || 'Think';
  btn.setAttribute('data-tooltip', EFFORT_TITLES[level] || '');
  // Light up dots based on level
  const dots = btn.querySelectorAll('.cp-think-dots i');
  const count = { off: 0, low: 1, medium: 2, high: 3, max: 4 }[level] || 0;
  dots.forEach((d, i) => { d.classList.toggle('lit', i < count); });
}
function _getEffort() {
  const btn = _panel?.querySelector('#cp-think-toggle');
  const val = btn?.dataset.effort || 'off';
  return val === 'off' ? null : val;
}

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.cp-dropdown')) {
    document.querySelectorAll('.cp-dropdown.open').forEach(d => d.classList.remove('open'));
  }
});

// ── Tab lifecycle ──
function createTab(sessionId = null, label = 'New chat', { autoSwitch = true } = {}) {
  if (_tabs.length >= MAX_TABS) return null;
  const tab = {
    id: crypto.randomUUID(),
    sessionId,
    label,
    ws: null,
    reconnectTimer: null,
    running: false,
    sessionCost: 0,
    messagesEl: null,
    thinkingEl: null,
    currentMsgEl: null,
    currentMsgId: null,
    attachedFiles: [],
    attachedImages: [],
    pendingAsk: null,
    pendingAskToolUseId: null,
    pendingAskRequestId: null,
    pillEl: null,
    draft: '',
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    compacting: false,
    turns: 0,
    thinkStartedAt: null,
    thinkTimerInterval: null,
    sendStartedAt: null,
    planMode: false,
    _permQueue: [],
    _activePerm: false,
    _msgBuffer: [],
  };
  // Create messages div
  const container = _panel.querySelector('#cp-messages-container');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'cp-messages';
  msgDiv.dataset.tabId = tab.id;
  msgDiv.style.display = 'none';
  container.appendChild(msgDiv);
  tab.messagesEl = msgDiv;
  // Connect WebSocket
  connectTab(tab);
  // Create pill (rendered in shared tray, not inside panel)
  tab.pillEl = _createTrayPill(tab);
  _tabs.push(tab);
  if (autoSwitch) switchTab(_tabs.length - 1);
  if (sessionId) loadSessionHistory(sessionId, tab.messagesEl);
  renderPills();
  if (autoSwitch) saveTabs();
  return tab;
}

function connectTab(tab) {
  if (tab.closed) return;
  if (tab.ws && (tab.ws.readyState === WebSocket.OPEN || tab.ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  tab.ws = new WebSocket(`${proto}//${location.host}/ws/claude-skin`);
  tab.ws.addEventListener('open', () => {
    clearTimeout(tab.reconnectTimer);
    // If this tab was running before disconnect (page refresh), try to reattach
    if (tab._wasRunning && tab.sessionId) {
      console.log('[claude-panel] Attempting reattach for session', tab.sessionId);
      tab.ws.send(JSON.stringify({ type: 'reattach', windowId: _windowId, sessionId: tab.sessionId }));
    }
  });
  tab.ws.addEventListener('message', (e) => { try { handleTabMsg(tab, JSON.parse(e.data)); } catch (err) { console.error('[claude-panel] handleTabMsg error:', err, e.data?.slice?.(0, 200)); } });
  tab.ws.addEventListener('close', () => { if (!tab.closed) tab.reconnectTimer = setTimeout(() => connectTab(tab), 2000); });
  tab.ws.addEventListener('error', () => tab.ws.close());
}

function switchTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const prev = activeTab();
  if (prev && prev !== _tabs[idx]) {
    const $input = _panel?.querySelector('#cp-input');
    if ($input) prev.draft = $input.value;
    // Animate out
    prev.messagesEl.classList.remove('cp-tab-enter');
    prev.messagesEl.classList.add('cp-tab-exit');
    const prevEl = prev.messagesEl;
    prevEl.addEventListener('animationend', () => {
      prevEl.classList.remove('cp-tab-exit');
      prevEl.style.display = 'none';
    }, { once: true });
  }
  _activeTabIdx = idx;
  const tab = activeTab();
  tab.messagesEl.style.display = '';
  tab.messagesEl.classList.remove('cp-tab-exit');
  tab.messagesEl.classList.add('cp-tab-enter');
  tab.messagesEl.addEventListener('animationend', () => {
    tab.messagesEl.classList.remove('cp-tab-enter');
  }, { once: true });
  // Restore draft
  const $input = _panel?.querySelector('#cp-input');
  if ($input) { $input.value = tab.draft || ''; autoResize(); }
  // Update header
  const headerLabel = _panel?.querySelector('.cp-session-label');
  if (headerLabel) headerLabel.textContent = tab.label || 'New chat';
  _updateCostLabel();
  // Update send button state
  const $send = _panel?.querySelector('#cp-send');
  if ($send && $input) {
    if (tab.running) {
      $input.disabled = false;
      _updateSendIcon($send, $input);
    } else {
      $send.classList.remove('abort'); $send.classList.remove('btw');
      $send.innerHTML = _ICON_SEND;
      $input.disabled = false;
      $send.disabled = !$input.value.trim() && !tab.attachedImages.length;
    }
  }
  // Scroll
  requestAnimationFrame(() => { tab.messagesEl.scrollTop = tab.messagesEl.scrollHeight; });
  updateAttachBadge();
  // Rebuild image/file preview for this tab
  const preview = _panel?.querySelector('#cp-image-preview');
  if (preview) {
    preview.innerHTML = '';
    tab.attachedImages.forEach((img, i) => addImagePreview(`data:${img.mediaType};base64,${img.base64}`, i));
    tab.attachedFiles.forEach((f, i) => {
      if (f.path) _addPathChip(tab, f.name, f.path, i);
      else addFilePreview(f.name, i);
    });
  }
  // Sync plan toggle
  const $plan = _panel?.querySelector('#cp-plan-toggle');
  if ($plan) $plan.classList.toggle('active', tab.planMode);
  // Sync context gauge
  renderGauge(tab);
  renderPills();
  saveTabs();
}

function closeTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const tab = _tabs[idx];
  tab.closed = true;
  clearTimeout(tab.reconnectTimer);
  finishTab(tab);
  if (tab.ws) tab.ws.close();
  // Release session lock
  if (tab.sessionId) _releaseSessionLock(tab.sessionId);
  tab.messagesEl.remove();
  if (tab.pillEl) tab.pillEl.remove();
  _tabs.splice(idx, 1);
  if (_tabs.length === 0) {
    _activeTabIdx = -1;
    createTab(null, 'New chat');
    return;
  }
  if (_activeTabIdx === idx) {
    _activeTabIdx = Math.min(idx, _tabs.length - 1);
    switchTab(_activeTabIdx);
  } else if (_activeTabIdx > idx) {
    _activeTabIdx--;
  }
  renderPills();
  saveTabs();
}

const _CP_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function _createTrayPill(tab) {
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) return null;
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill cp-session-pill';
  pill.dataset.tabId = tab.id;
  pill.innerHTML = `
    <span class="term-minimized-pill-icon">${_CP_ICON_SVG}</span>
    <span class="term-minimized-pill-label">${escH(tab.label)}</span>
    <button class="term-minimized-pill-close" data-tooltip="Close">&times;</button>
  `;
  pill.addEventListener('click', () => {
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) {
      if (!_visible) toggleClaudePanel();
      switchTab(idx);
    }
  });
  pill.querySelector('.term-minimized-pill-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = _tabs.indexOf(tab);
    if (idx >= 0) closeTab(idx);
  });
  pill.style.display = 'none'; // Hidden by default; renderPills() controls visibility
  tray.appendChild(pill);
  return pill;
}

function renderPills() {
  const activeIdx = _activeTabIdx;
  const panelOpen = _visible;
  for (let i = 0; i < _tabs.length; i++) {
    const tab = _tabs[i];
    if (!tab.pillEl) tab.pillEl = _createTrayPill(tab);
    if (!tab.pillEl) continue;
    const isActive = i === activeIdx;
    const shouldShow = !isActive || !panelOpen;
    const wasHidden = tab.pillEl.style.display === 'none';
    tab.pillEl.style.display = shouldShow ? '' : 'none';
    // Animate pill appearing
    if (shouldShow && wasHidden) {
      tab.pillEl.classList.remove('cp-pill-enter');
      void tab.pillEl.offsetWidth; // force reflow
      tab.pillEl.classList.add('cp-pill-enter');
      tab.pillEl.addEventListener('animationend', () => {
        tab.pillEl.classList.remove('cp-pill-enter');
      }, { once: true });
    }
  }
}

function updatePillLabel(tab) {
  if (!tab.pillEl) return;
  const lbl = tab.pillEl.querySelector('.term-minimized-pill-label');
  if (lbl) lbl.textContent = tab.label;
}

function updatePillRunning(tab) {
  if (tab.pillEl) tab.pillEl.classList.toggle('cp-pill-running', tab.running);
}

function saveTabs() {
  try {
    storage.setItem(STOR.tabs, JSON.stringify({
      tabs: _tabs.map(t => ({ id: t.id, sessionId: t.sessionId, label: t.label, sessionCost: t.sessionCost || 0, running: t.running || false })),
      activeIdx: _activeTabIdx,
    }));
    _updateWindowRegistry();
  } catch {}
}

// ── Window registry: tracks active windows for stale-key cleanup ──
function _updateWindowRegistry() {
  try {
    const raw = storage.getItem(STOR.windowRegistry);
    const reg = raw ? JSON.parse(raw) : {};
    reg[_windowId] = Date.now();
    storage.setItem(STOR.windowRegistry, JSON.stringify(reg));
  } catch {}
}

function _cleanStaleWindows() {
  try {
    const raw = storage.getItem(STOR.windowRegistry);
    if (!raw) return;
    const reg = JSON.parse(raw);
    const STALE_MS = 24 * 60 * 60 * 1000; // 24h
    const now = Date.now();
    for (const [wid, ts] of Object.entries(reg)) {
      if (wid === _windowId) continue;
      if (now - ts > STALE_MS) {
        // Remove stale window's tab key
        storage.removeItem(`synabun-claude-panel-tabs-${wid}`);
        delete reg[wid];
      }
    }
    storage.setItem(STOR.windowRegistry, JSON.stringify(reg));
  } catch {}
}

function restoreTabs() {
  _cleanStaleWindows();
  // Try window-scoped tabs first
  try {
    const raw = storage.getItem(STOR.tabs);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.tabs?.length) {
        for (const saved of data.tabs) {
          const t = createTab(saved.sessionId, saved.label, { autoSwitch: false });
          if (t && saved.sessionCost) t.sessionCost = saved.sessionCost;
          if (t && saved.running) t._wasRunning = true; // trigger reattach on WS open
        }
        switchTab(Math.min(data.activeIdx || 0, _tabs.length - 1));
        return;
      }
    }
  } catch {}
  // Migration: check legacy global key (one-time, only if this window has no saved tabs)
  try {
    const legacyRaw = storage.getItem(STOR.tabsLegacy);
    if (legacyRaw) {
      const data = JSON.parse(legacyRaw);
      if (data.tabs?.length) {
        for (const saved of data.tabs) {
          const t = createTab(saved.sessionId, saved.label, { autoSwitch: false });
          if (t && saved.sessionCost) t.sessionCost = saved.sessionCost;
          if (t && saved.running) t._wasRunning = true;
        }
        switchTab(Math.min(data.activeIdx || 0, _tabs.length - 1));
        // Don't remove legacy key — other windows may still need it during rollout
        return;
      }
    }
  } catch {}
  // Backward compat: old single-session storage
  const oldSid = storage.getItem(STOR.session);
  if (oldSid) {
    const label = getLabel(oldSid) || oldSid.slice(0, 8) + '...';
    createTab(oldSid, label);
  } else {
    createTab(null, 'New chat');
  }
}

// ── Session lock helpers (client-side) ──
let _heartbeatInterval = null;

function _startHeartbeat() {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    for (const tab of _tabs) {
      if (tab.sessionId && tab.ws?.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({ type: 'heartbeat', sessionId: tab.sessionId, windowId: _windowId }));
      }
    }
  }, 15_000); // Every 15s
}

function _stopHeartbeat() {
  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
}

async function _checkSessionLock(sessionId) {
  if (!sessionId) return { ok: true };
  try {
    const res = await fetch('/api/claude-skin/session-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'acquire', sessionId, windowId: _windowId }),
    });
    return await res.json();
  } catch { return { ok: true }; } // If server unreachable, allow
}

async function _releaseSessionLock(sessionId) {
  if (!sessionId) return;
  try {
    await fetch('/api/claude-skin/session-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'release', sessionId, windowId: _windowId }),
    });
  } catch {}
}

async function _releaseAllSessionLocks() {
  try {
    await fetch('/api/claude-skin/session-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'release', windowId: _windowId }),
    });
  } catch {}
}

// Release locks when window closes
window.addEventListener('beforeunload', () => {
  _stopHeartbeat();
  // Use sendBeacon for reliable delivery on close
  navigator.sendBeacon(
    '/api/claude-skin/session-lock',
    new Blob([JSON.stringify({ action: 'release', windowId: _windowId })], { type: 'application/json' })
  );
});

// Re-sync UI state when window regains focus (catches stale running states from background tabs)
window.addEventListener('focus', () => {
  if (!_panel) return;
  const tab = activeTab();
  if (!tab) return;
  // If tab says it's running but WS is dead, force finish
  if (tab.running && (!tab.ws || tab.ws.readyState > WebSocket.OPEN)) {
    console.warn('[claude-panel] Focus re-sync: tab running but WS dead — forcing finish');
    finishTab(tab);
    appendStatus(tab, 'Connection lost — session recovered.');
  }
  // Re-sync input disabled state with current tab
  const $input = _panel?.querySelector('#cp-input');
  const $send = _panel?.querySelector('#cp-send');
  if ($input && $send) {
    $input.disabled = tab.running;
    if (!tab.running) {
      $send.classList.remove('abort');
      $send.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
      $send.disabled = !$input.value.trim() && !tab.attachedImages.length;
    }
  }
});

// ── Session selector helpers ──
const LABEL_PREFIX = 'synabun-session-label:';
function getLabel(id) { try { return storage.getItem(LABEL_PREFIX + id) || ''; } catch { return ''; } }
function cleanPrompt(raw) { return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
function relDate(d) {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000), h = Math.floor(ms / 3600000), dy = Math.floor(ms / 86400000);
  if (m < 1) return 'now'; if (m < 60) return m + 'm ago'; if (h < 24) return h + 'h ago'; if (dy < 30) return dy + 'd ago';
  return Math.floor(dy / 30) + 'mo ago';
}
function timeGroup(d) {
  const now = new Date(), dt = new Date(d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = today - new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  if (diff <= 0) return 'Today'; if (diff <= 86400000) return 'Yesterday';
  if (diff <= 604800000) return 'This Week'; return 'Older';
}
function trunc(s, n) { return s.length > n ? s.slice(0, n) + '...' : s; }
function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function renderSessionMenu() {
  const menu = _panel?.querySelector('#cp-session-menu');
  if (!menu) return;
  menu.innerHTML = '<div class="cp-sess-loading">loading sessions...</div>';
  try {
    const $project = _panel?.querySelector('#cp-project');
    const currentProject = ddGetValue($project) || undefined;
    const data = await fetchClaudeSessions({ limit: 30, project: currentProject });
    if (!data?.projects?.length) { menu.innerHTML = '<div class="cp-sess-loading">no sessions found</div>'; return; }
    let html = '<div class="cp-sess-new">+ New chat</div>';
    for (const proj of data.projects) {
      const groups = {};
      for (const s of (proj.sessions || [])) {
        if (s.deleted) continue;
        const g = timeGroup(s.modified || s.created);
        (groups[g] = groups[g] || []).push(s);
      }
      for (const g of ['Today', 'Yesterday', 'This Week', 'Older']) {
        if (!groups[g]?.length) continue;
        html += `<div class="cp-sess-group">${escH(g)}</div>`;
        for (const s of groups[g]) {
          const label = getLabel(s.sessionId) || cleanPrompt(s.firstPrompt) || 'Empty session';
          const active = s.sessionId === activeTab()?.sessionId ? ' active' : '';
          html += `<div class="cp-sess-item${active}" data-sid="${escH(s.sessionId)}" data-cwd="${escH(proj.path)}">`;
          html += `<div class="cp-sess-prompt">${escH(trunc(label, 60))}</div>`;
          html += `<button class="cp-sess-rename" data-sid="${escH(s.sessionId)}" title="Rename">&#x270E;</button>`;
          html += `<div class="cp-sess-meta"><span>${relDate(s.modified || s.created)}</span>`;
          if (s.gitBranch) html += `<span class="cp-sess-branch">${escH(s.gitBranch)}</span>`;
          if (s.messageCount) html += `<span>${s.messageCount} msgs</span>`;
          html += `</div></div>`;
        }
      }
    }
    menu.innerHTML = html;
    // Wire clicks
    menu.querySelector('.cp-sess-new')?.addEventListener('click', () => {
      selectSession(null, 'New chat');
      menu.classList.remove('open');
    });
    menu.querySelectorAll('.cp-sess-item').forEach(el => {
      el.addEventListener('click', () => {
        const sid = el.dataset.sid;
        const label = el.querySelector('.cp-sess-prompt')?.textContent || 'Resumed';
        selectSession(sid, label);
        // Update cwd to match the session's project
        const $project = _panel?.querySelector('#cp-project');
        if ($project && el.dataset.cwd) {
          ddPopulate($project, _projects.map(p => ({ value: p.path, label: p.label || p.path.split(/[/\\]/).pop() })), el.dataset.cwd);
          storage.setItem(STOR.project, el.dataset.cwd);
        }
        menu.classList.remove('open');
      });
    });
    // Wire rename buttons
    menu.querySelectorAll('.cp-sess-rename').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.sid;
        const item = btn.closest('.cp-sess-item');
        const promptEl = item?.querySelector('.cp-sess-prompt');
        if (!promptEl) return;
        const currentName = getLabel(sid) || promptEl.textContent;
        const input = document.createElement('input');
        input.type = 'text'; input.value = currentName;
        input.className = 'cp-rename-input';
        input.placeholder = 'Session name...';
        promptEl.textContent = '';
        promptEl.appendChild(input);
        btn.style.display = 'none';
        input.focus(); input.select();

        let committed = false;
        function commit() {
          if (committed) return;
          committed = true;
          const val = input.value.trim();
          input.remove();
          if (val) {
            storage.setItem(LABEL_PREFIX + sid, val);
            promptEl.textContent = trunc(val, 60);
          } else {
            storage.removeItem(LABEL_PREFIX + sid);
            promptEl.textContent = currentName;
          }
          btn.style.display = '';
          // Update header + pill if this is the active session
          const curTab = activeTab();
          if (curTab && sid === curTab.sessionId) {
            const headerLabel = _panel?.querySelector('.cp-session-label');
            if (headerLabel) headerLabel.textContent = val || currentName;
            curTab.label = val || currentName;
            updatePillLabel(curTab);
            saveTabs();
          }
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          if (e.key === 'Escape') { input.value = currentName; input.blur(); }
        });
      });
    });
  } catch (err) {
    menu.innerHTML = '<div class="cp-sess-loading">failed to load</div>';
  }
}

async function selectSession(sid, label) {
  const tab = activeTab();
  if (!tab) return;
  // If current tab is running, spawn a new tab instead of killing the running session
  if (tab.running) {
    if (_tabs.length >= MAX_TABS) {
      appendStatus(tab, 'Max tabs reached — close a tab first.');
      return;
    }
    createTab(sid, label || 'New chat');
    return;
  }
  // Check lock before selecting an existing session
  if (sid) {
    const lock = await _checkSessionLock(sid);
    if (!lock.ok) {
      appendStatus(tab, `Session is active in another window. Close it there first, or force-take.`);
      return;
    }
  }
  // Release previous session lock if switching
  if (tab.sessionId && tab.sessionId !== sid) _releaseSessionLock(tab.sessionId);
  tab.sessionId = sid;
  tab.sessionCost = 0;
  tab.currentMsgEl = null;
  tab.currentMsgId = null;
  tab.label = label || 'New chat';
  tab.usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  tab.compacting = false;
  _setCompactingUI(false);
  tab.turns = 0;
  _updateCostLabel();
  renderGauge(tab);
  updatePillLabel(tab);
  const btn = _panel?.querySelector('.cp-session-label');
  if (btn) btn.textContent = tab.label;
  tab.messagesEl.innerHTML = '';
  if (sid) {
    loadSessionHistory(sid, tab.messagesEl);
    // Restore session cost from server
    fetch(`/api/claude-skin/cost/session/${sid}`).then(r => r.json()).then(data => {
      if (typeof data.cost === 'number' && data.cost > 0) {
        tab.sessionCost = data.cost;
        if (tab === activeTab()) _updateCostLabel();
        saveTabs();
      }
    }).catch(() => {});
  }
  saveTabs();
}

function renameSession(sid, currentLabel) {
  if (!sid) return;
  const btn = _panel?.querySelector('.cp-session-label');
  if (!btn) return;

  // If already renaming, just refocus the existing input
  const existing = btn.querySelector('.cp-rename-input');
  if (existing) {
    existing.focus();
    existing.select();
    return;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentLabel || '';
  input.className = 'cp-rename-input';
  input.placeholder = 'Session name...';
  btn.textContent = '';
  btn.appendChild(input);
  input.focus();
  input.select();

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    input.remove();
    if (val) {
      storage.setItem(LABEL_PREFIX + sid, val);
      btn.textContent = val;
    } else {
      storage.removeItem(LABEL_PREFIX + sid);
      btn.textContent = getLabel(sid) || sid.slice(0, 8) + '...';
    }
    const tab = activeTab();
    if (tab && tab.sessionId === sid) {
      tab.label = btn.textContent;
      updatePillLabel(tab);
      saveTabs();
    }
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentLabel || ''; input.blur(); }
  });
}

async function loadSessionHistory(sid, $msgs) {
  if (!$msgs) $msgs = activeTab()?.messagesEl;
  if (!$msgs) return;
  const $project = _panel?.querySelector('#cp-project');
  const project = ddGetValue($project) || undefined;
  const params = new URLSearchParams({ limit: '500' });
  if (project) params.set('project', project);
  try {
    const res = await fetch(`/api/claude-code/sessions/${encodeURIComponent(sid)}/messages?${params}`);
    const data = await res.json();
    if (!data.messages?.length) {
      $msgs.innerHTML = '<div class="msg-status">No messages in this session</div>';
      return;
    }
    for (const m of data.messages) {
      if (m.role === 'user') {
        const el = document.createElement('div'); el.className = 'msg msg-user';
        const bubble = document.createElement('div'); bubble.className = 'msg-bubble'; bubble.textContent = m.text;
        el.appendChild(bubble); $msgs.appendChild(el);
      } else if (m.role === 'assistant') {
        const el = document.createElement('div'); el.className = 'msg msg-assistant';
        const avatar = document.createElement('div'); avatar.className = 'msg-avatar';
        avatar.innerHTML = CLAUDE_ICON; el.appendChild(avatar);
        const wrap = document.createElement('div'); wrap.className = 'msg-content';
        if (m.text) {
          const body = document.createElement('div'); body.className = 'msg-body';
          body.innerHTML = md(m.text);
          linkifyFilePaths(body);
          wrap.appendChild(body);
        }
        if (m.tools?.length) {
          for (const t of m.tools) {
            if (typeof t === 'object' && t.name) {
              wrap.appendChild(buildTool(t));
            } else {
              // Legacy: tool name string only
              const tName = String(t);
              const summary = document.createElement('div'); summary.className = 'msg-tools-summary';
              if (isSynaBunTool(tName)) {
                const sMeta = getSynaBunMeta(tName);
                summary.textContent = sMeta?.label || synaBunToolKey(tName);
                summary.classList.add('synabun-summary');
              } else {
                summary.textContent = tName;
              }
              wrap.appendChild(summary);
            }
          }
        }
        el.appendChild(wrap); $msgs.appendChild(el);
      } else if (m.role === 'tool_result' && m.toolUseId) {
        // Match result to its tool card
        const card = $msgs.querySelector(`.tool-card[data-tool-id="${CSS.escape(m.toolUseId)}"]`);
        if (card && card.classList.contains('synabun-card') && m.text) {
          updateSynaBunResult(card, { content: m.text, is_error: m.isError });
        } else if (card) {
          const rLbl = card.querySelector('.tool-result-label');
          const rSec = card.querySelector('.tool-result-content');
          if (rSec && m.text) {
            rSec.textContent = m.text.slice(0, 2000);
            rLbl.hidden = false; rSec.hidden = false;
            card.classList.add(m.isError ? 'tool-error' : 'tool-ok');
          }
        }
      }
    }
    if (data.total > data.messages.length) {
      const note = document.createElement('div'); note.className = 'msg-status';
      note.textContent = `Showing last ${data.messages.length} of ${data.total} messages`;
      $msgs.prepend(note);
    }
    // Populate context gauge from session history usage
    const tab = activeTab();
    if (tab && data.usage) {
      tab.usage.inputTokens = data.usage.input_tokens || 0;
      tab.usage.outputTokens = data.usage.output_tokens || 0;
      tab.usage.cacheRead = data.usage.cache_read_input_tokens || 0;
      tab.usage.cacheWrite = data.usage.cache_creation_input_tokens || 0;
      tab.turns = data.turns || 0;
      renderGauge(tab);
    }
    scrollEnd();
  } catch {
    $msgs.innerHTML = '<div class="msg-status">Failed to load history</div>';
  }
}

// ── File path linking ──
function linkifyFilePaths(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const pathRe = /(?:(?:[A-Za-z]:)?(?:[/\\][\w.@\-]+){2,}(?::(\d+))?)(?=\s|$|[)"',;])/g;
  for (const node of nodes) {
    if (node.parentElement?.closest('pre, code, a')) continue;
    const text = node.textContent;
    pathRe.lastIndex = 0;
    if (!pathRe.test(text)) continue;
    pathRe.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, match;
    while ((match = pathRe.exec(text))) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const a = document.createElement('a');
      a.className = 'file-link';
      a.href = '#';
      a.textContent = match[0];
      a.title = 'Click to copy path';
      const path = match[0].replace(/:\d+$/, '');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(path);
        a.style.opacity = '0.5';
        setTimeout(() => a.style.opacity = '', 300);
      });
      frag.appendChild(a);
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (last > 0) node.parentNode.replaceChild(frag, node);
  }
}

// ── Cost loading ──
async function loadMonthlyCost() {
  try {
    const res = await fetch('/api/claude-skin/cost').then(r => r.json());
    if (res.month) {
      _totalCost = res.month.totalUsd || 0;
    }
  } catch {}
  _updateCostLabel();
}

async function syncSessionCosts() {
  for (const tab of _tabs) {
    if (!tab.sessionId) continue;
    try {
      const res = await fetch(`/api/claude-skin/cost/session/${tab.sessionId}`);
      if (!res.ok) continue;
      const data = await res.json();
      if (typeof data.cost === 'number' && data.cost > 0) {
        tab.sessionCost = data.cost;
      }
    } catch {}
  }
  _updateCostLabel();
  saveTabs();
}

function _updateCostLabel() {
  const $cost = _panel?.querySelector('#cp-cost');
  if (!$cost) return;
  const sc = activeTab()?.sessionCost || 0;
  $cost.textContent = `$${sc.toFixed(2)}`;
  const monthLabel = new Date().toLocaleString('en', { month: 'short' });
  $cost.title = `Session cost · ${monthLabel} total: $${_totalCost.toFixed(2)}`;
}

// ── Context gauge ──

function _setCompactingUI(on) {
  const $gauge = _panel?.querySelector('#cp-gauge');
  const $label = _panel?.querySelector('#cp-gauge-label');
  const $btn = _panel?.querySelector('#cp-compact-btn');
  if (on) {
    $gauge?.classList.add('compacting');
    $label?.classList.add('compacting');
    if ($btn) { $btn.classList.add('compacting'); $btn.textContent = 'compacting'; }
  } else {
    $gauge?.classList.remove('compacting');
    $label?.classList.remove('compacting');
    if ($btn) { $btn.classList.remove('compacting'); $btn.textContent = 'compact'; }
  }
}

function renderGauge(tab) {
  const $gauge = _panel?.querySelector('#cp-gauge');
  const $label = _panel?.querySelector('#cp-gauge-label');
  if (!$gauge) return;

  const u = tab.usage;
  const cacheRead = u.cacheRead || 0;
  const cacheWrite = u.cacheWrite || 0;
  const uncachedInput = u.inputTokens || 0;
  const total = uncachedInput + cacheRead + cacheWrite;
  const ctxWindow = _getContextWindow();
  const fmt = (v) => v >= 1000000 ? (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'M' : v >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v);

  if (total === 0) {
    // Animate existing sections to 0 width before removing
    const existing = $gauge.querySelectorAll('.cp-gauge-section');
    if (existing.length) {
      existing.forEach(el => { el.style.width = '0%'; el.querySelector('.cp-gauge-tip')?.remove(); });
      setTimeout(() => { $gauge.innerHTML = ''; }, 450);
    }
    $gauge.dataset.urgency = '';
    if ($label) { $label.textContent = ''; $label.title = ''; }
    return;
  }

  const pct = (v) => Math.max(0, (v / ctxWindow) * 100).toFixed(2) + '%';
  const CATS = ['cache-read', 'cache-write', 'input'];
  const data = {
    'cache-read': { val: cacheRead, label: `Cached: ${fmt(cacheRead)} tokens` },
    'cache-write': { val: cacheWrite, label: `New cache: ${fmt(cacheWrite)} tokens` },
    'input': { val: uncachedInput, label: `Input: ${fmt(uncachedInput)} tokens` },
  };

  // Reuse existing section elements for smooth CSS transitions
  for (const cat of CATS) {
    const d = data[cat];
    let el = $gauge.querySelector(`.cp-gauge-section[data-cat="${cat}"]`);
    if (d.val > 0) {
      if (!el) {
        el = document.createElement('div');
        el.className = 'cp-gauge-section';
        el.dataset.cat = cat;
        el.innerHTML = `<div class="cp-gauge-tip"></div>`;
        // Insert in order: find the next sibling that should come after this cat
        const catIdx = CATS.indexOf(cat);
        let inserted = false;
        for (let i = catIdx + 1; i < CATS.length; i++) {
          const sibling = $gauge.querySelector(`.cp-gauge-section[data-cat="${CATS[i]}"]`);
          if (sibling) { $gauge.insertBefore(el, sibling); inserted = true; break; }
        }
        if (!inserted) $gauge.appendChild(el);
        // Force layout so initial width:0 is registered before transition
        el.style.width = '0%';
        el.offsetWidth; // force reflow
      }
      el.style.width = pct(d.val);
      const tip = el.querySelector('.cp-gauge-tip');
      if (tip) tip.textContent = d.label;
    } else if (el) {
      // Animate to 0 then remove
      el.style.width = '0%';
      el.addEventListener('transitionend', () => el.remove(), { once: true });
    }
  }

  const pctUsed = Math.round((total / ctxWindow) * 100);
  $gauge.dataset.urgency = pctUsed < 50 ? '' : pctUsed < 75 ? 'warn' : pctUsed < 90 ? 'high' : 'critical';

  if ($label) {
    $label.textContent = `${fmt(total)}/${fmt(ctxWindow)}`;
    $label.title = `${pctUsed}% context · ${fmt(u.outputTokens || 0)} output · ${tab.turns} turn${tab.turns !== 1 ? 's' : ''}`;
  }
}

// ── File attachment ──
const _TEXT_EXTENSIONS = new Set([
  'txt','md','js','ts','jsx','tsx','json','html','css','scss','less','xml','svg',
  'py','rb','go','rs','java','c','cpp','h','hpp','cs','php','sh','bash','zsh',
  'yml','yaml','toml','ini','cfg','conf','env','gitignore','dockerignore',
  'sql','graphql','proto','csv','tsv','log','diff','patch','vue','svelte',
  'mjs','cjs','mts','cts','astro','mdx','rst','tex','lua','r','swift','kt',
  'dockerfile','makefile','cmake','gradle','bat','ps1','fish',
]);
function _isTextFile(name) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return _TEXT_EXTENSIONS.has(ext) || !name.includes('.');
}

function buildPromptWithAttachments(tab, userText) {
  if (!tab.attachedFiles.length) return userText;
  let prompt = '';
  for (const f of tab.attachedFiles) {
    const pathAttr = f.path || f.name;
    prompt += `<file path="${pathAttr}">\n${f.content}\n</file>\n\n`;
  }
  prompt += userText;
  tab.attachedFiles = [];
  updateAttachBadge();
  _panel?.querySelectorAll('.cp-file-chip').forEach(c => c.remove());
  return prompt;
}

function updateAttachBadge() {
  const badge = _panel?.querySelector('.cp-attach-badge');
  if (badge) {
    const tab = activeTab();
    const count = (tab?.attachedFiles.length || 0) + (tab?.attachedImages.length || 0);
    badge.textContent = count || '';
    badge.hidden = !count;
  }
}

// ── WebSocket (per-tab) ──
function handleTabMsg(tab, msg) {
  // Track WS activity for running timeout safety net
  tab._lastWsActivity = Date.now();
  // Discard stale messages from a killed process until terminal signal arrives
  if (tab._discardingOldSession) {
    if (msg.type === 'aborted' || msg.type === 'done') {
      tab._discardingOldSession = false;
    }
    return;
  }
  if (msg.type === 'control_request') console.log('[claude-panel] Got control_request msg:', msg.type, msg.request_id, msg.request?.subtype, msg.request?.tool_name);
  // Buffer non-permission messages while a permission prompt is active
  if (tab._activePerm && msg.type !== 'control_request') {
    tab._msgBuffer.push(msg);
    return;
  }
  _processTabMsg(tab, msg);
}

function _flushMsgBuffer(tab) {
  while (tab._msgBuffer.length) {
    const msg = tab._msgBuffer.shift();
    _processTabMsg(tab, msg);
  }
}

function _processTabMsg(tab, msg) {
  switch (msg.type) {
    case 'reattach_result':
      tab._wasRunning = false;
      if (msg.ok) {
        console.log('[claude-panel] Reattached to running process, session:', msg.sessionId);
        if (msg.sessionId) tab.sessionId = msg.sessionId;
        if (msg.running) {
          tab.sendStartedAt = Date.now();
          showThinking(tab);
          setRunning(tab, true);
        }
        saveTabs();
      } else {
        // No orphan found — process died during refresh, clear running state
        console.log('[claude-panel] No orphan to reattach — session idle');
        finishTab(tab);
        saveTabs();
      }
      break;
    case 'event': handleTabEvent(tab, msg.event); break;
    case 'control_request': handleControlRequest(tab, msg); break;
    case 'stderr': if (msg.text?.trim()) appendStatus(tab, msg.text.trim()); break;
    case 'done':
      finishTab(tab);
      if (tab.compacting) { tab.compacting = false; if (tab === activeTab()) _setCompactingUI(false); }
      if (tab.planMode) renderPostPlanActions(tab);
      break;
    case 'aborted':
      finishTab(tab);
      if (tab.compacting) { tab.compacting = false; if (tab === activeTab()) _setCompactingUI(false); }
      // /btw: if there's a pending message, send it immediately instead of showing "Aborted"
      if (tab._btwPending) {
        const btw = tab._btwPending;
        tab._btwPending = null;
        const $project = _panel?.querySelector('#cp-project');
        const $model = _panel?.querySelector('#cp-model');
        tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
        let prompt = btw.text;
        if (tab.planMode && prompt) prompt = `[PLAN MODE — think step by step, create a detailed plan, do NOT make code changes]\n\n${prompt}`;
        const btwMsg = {
          type: 'query', prompt,
          cwd: ddGetValue($project) || undefined,
          sessionId: tab.sessionId || undefined,
          model: _getModelId() || undefined,
          effort: _getEffort() || undefined,
          windowId: _windowId,
        };
        if (btw.images) {
          btwMsg.images = btw.images.map(i => ({ base64: i.base64, mediaType: i.mediaType }));
          tab.attachedImages = [];
          updateAttachBadge();
          const preview = _panel?.querySelector('#cp-image-preview');
          if (preview) preview.innerHTML = '';
        }
        tab.ws.send(JSON.stringify(btwMsg));
      } else {
        appendStatus(tab, 'Aborted.');
      }
      break;
    case 'error':
      finishTab(tab);
      if (tab.compacting) { tab.compacting = false; if (tab === activeTab()) _setCompactingUI(false); }
      appendError(tab, msg.message);
      break;
  }
}

function handleTabEvent(tab, ev) {
  if (!ev?.type) return;

  if (ev.type === 'system' && (ev.subtype === 'compact' || ev.subtype === 'compact_started')) {
    tab.compacting = true;
    // Reuse a single compact status element to avoid duplicate lines
    const $msgs = tab.messagesEl;
    if ($msgs) {
      let el = $msgs.querySelector('.msg-compact-status');
      if (!el) {
        el = document.createElement('div');
        el.className = 'msg-status msg-compact-status';
        $msgs.appendChild(el);
      }
      el.textContent = 'Compacting context\u2026';
      if (tab === activeTab()) scrollEnd();
    }
    if (tab === activeTab()) _setCompactingUI(true);
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
    // Update existing compact status instead of appending a new line
    const el = tab.messagesEl?.querySelector('.msg-compact-status');
    if (el) el.textContent = 'Context compacted';
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'session_reset') {
    // Server auto-retried without --resume because the session was deleted
    tab.sessionId = null;
    tab.label = 'New chat';
    updatePillLabel(tab);
    if (tab === activeTab()) {
      const btn = _panel?.querySelector('.cp-session-label');
      if (btn) btn.textContent = tab.label;
    }
    saveTabs();
    appendStatus(tab, ev.message || 'Session reset — starting fresh.');
    return;
  }
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) {
      tab.sessionId = ev.session_id;
      if (tab.label === 'New chat') {
        const label = getLabel(ev.session_id);
        tab.label = label || ev.session_id.slice(0, 8) + '...';
        updatePillLabel(tab);
      }
      if (tab === activeTab()) {
        const btn = _panel?.querySelector('.cp-session-label');
        if (btn) btn.textContent = tab.label;
      }
      saveTabs();
    }
    return;
  }
  if (ev.type === 'stream_event' && ev.event) {
    handleStreamDelta(tab, ev.event);
    return;
  }
  if (ev.type === 'assistant' && ev.message) {
    if (ev.message.usage) {
      const u = ev.message.usage;
      tab.usage.inputTokens = u.input_tokens ?? 0;
      tab.usage.outputTokens = u.output_tokens ?? 0;
      tab.usage.cacheRead = u.cache_read_input_tokens ?? 0;
      tab.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;
      if (tab.compacting) {
        tab.compacting = false;
        if (tab === activeTab()) _setCompactingUI(false);
      }
      if (tab === activeTab()) renderGauge(tab);
    }
    renderAssistant(tab, ev.message);
    // Reposition thinking indicator to bottom (stays visible while running)
    if (tab.thinkingEl && tab.running) {
      tab.thinkingEl.remove();
      tab.messagesEl.appendChild(tab.thinkingEl);
      if (tab === activeTab()) scrollEnd();
    }
    return;
  }
  if (ev.type === 'tool_result') {
    updateToolResult(tab, ev);
    // Re-show thinking — Claude is processing the tool result
    if (tab.running && !tab.pendingAsk) showThinking(tab);
    return;
  }
  if (ev.type === 'result') {
    // Display error for error_during_execution results
    if ((ev.subtype === 'error_during_execution' || ev.subtype === 'error') && (ev.error || ev.result)) {
      appendError(tab, ev.error || ev.result);
    }
    finishTab(tab);
    tab.turns++;
    if (ev.usage) {
      const u = ev.usage;
      tab.usage.inputTokens = u.input_tokens ?? tab.usage.inputTokens;
      tab.usage.outputTokens = u.output_tokens ?? tab.usage.outputTokens;
      tab.usage.cacheRead = u.cache_read_input_tokens ?? tab.usage.cacheRead;
      tab.usage.cacheWrite = u.cache_creation_input_tokens ?? tab.usage.cacheWrite;
      if (tab.compacting) {
        tab.compacting = false;
        if (tab === activeTab()) _setCompactingUI(false);
      }
      if (tab === activeTab()) renderGauge(tab);
    }
    if (ev.total_cost_usd != null) {
      const prevCost = tab.sessionCost;
      tab.sessionCost = ev.total_cost_usd;
      const delta = ev.total_cost_usd - prevCost;
      if (delta > 0) _totalCost += delta;
      if (tab === activeTab()) {
        _updateCostLabel();
        const $cost = _panel?.querySelector('#cp-cost');
        if ($cost) { $cost.classList.add('flash'); setTimeout(() => $cost.classList.remove('flash'), 800); }
      }
      emit('cost:updated', { amount: delta > 0 ? delta : 0, total: _totalCost });
      saveTabs();
    }
    if (ev.session_id) { tab.sessionId = ev.session_id; saveTabs(); }
    // Post-plan actions shown only on 'done' (handleTabMsg), not mid-stream
  }
}

// ── Stream event handler — renders text as it arrives from the API ──
function handleStreamDelta(tab, apiEvent) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const evType = apiEvent.type;

  if (evType === 'message_start') {
    // Initialize stream state early — element created on first content_block_start
    const msgId = apiEvent.message?.id || null;
    tab._stream = { el: null, textBuf: '', thinkBuf: '', bodyEl: null, thinkEl: null, blockIdx: -1, blockType: null, mdTimer: null, msgId };
    hideThinking(tab);
    return;
  }

  if (evType === 'message_stop') {
    // Finalize: flush any pending markdown render
    if (tab._stream?.mdTimer) clearTimeout(tab._stream.mdTimer);
    if (tab._stream?.bodyEl && tab._stream.textBuf) {
      tab._stream.bodyEl.innerHTML = md(tab._stream.textBuf);
      linkifyFilePaths(tab._stream.bodyEl);
    }
    tab._stream = null;
    return;
  }

  if (evType === 'content_block_start') {
    if (!tab._stream) tab._stream = { el: null, textBuf: '', thinkBuf: '', bodyEl: null, thinkEl: null, blockIdx: -1, blockType: null, mdTimer: null };
    tab._stream.blockIdx = apiEvent.index ?? (tab._stream.blockIdx + 1);
    tab._stream.blockType = apiEvent.content_block?.type || null;

    // Create the message skeleton on first content block
    if (!tab._stream.el) {
      const el = document.createElement('div');
      el.className = 'msg msg-assistant';
      const avatar = document.createElement('div');
      avatar.className = 'msg-avatar';
      avatar.innerHTML = CLAUDE_ICON;
      el.appendChild(avatar);
      const wrap = document.createElement('div');
      wrap.className = 'msg-content';
      el.appendChild(wrap);
      $msgs.appendChild(el);
      tab._stream.el = el;
      // Wire this as the current message so renderAssistant dedup finds it
      if (tab._stream.msgId) { tab.currentMsgId = tab._stream.msgId; tab.currentMsgEl = el; }
    }

    const wrap = tab._stream.el.querySelector('.msg-content');

    if (tab._stream.blockType === 'thinking' && _getEffort()) {
      // Create thinking details block
      if (!tab._stream.thinkEl) {
        const thinkEl = document.createElement('details');
        thinkEl.className = 'msg-thinking';
        thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">${THINKING_ICON}</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
        wrap.insertBefore(thinkEl, wrap.firstChild);
        tab._stream.thinkEl = thinkEl;
      }
    } else if (tab._stream.blockType === 'text') {
      if (!tab._stream.bodyEl) {
        const body = document.createElement('div');
        body.className = 'msg-body';
        wrap.appendChild(body);
        tab._stream.bodyEl = body;
      }
    }
    return;
  }

  if (evType === 'content_block_delta') {
    if (!tab._stream) return;
    const delta = apiEvent.delta;
    if (!delta) return;

    if (delta.type === 'thinking_delta' && delta.thinking && tab._stream.thinkEl) {
      tab._stream.thinkBuf += delta.thinking;
      const contentEl = tab._stream.thinkEl.querySelector('.msg-thinking-content');
      if (contentEl) contentEl.textContent = tab._stream.thinkBuf;
    } else if (delta.type === 'text_delta' && delta.text != null) {
      tab._stream.textBuf += delta.text;
      // Throttle markdown re-rendering to every 100ms to avoid jank
      if (!tab._stream.mdTimer) {
        tab._stream.mdTimer = setTimeout(() => {
          tab._stream.mdTimer = null;
          if (tab._stream?.bodyEl) {
            tab._stream.bodyEl.innerHTML = md(tab._stream.textBuf);
            linkifyFilePaths(tab._stream.bodyEl);
            if (tab === activeTab()) scrollEnd();
          }
        }, 100);
      }
    }
    if (tab === activeTab()) scrollEnd();
    return;
  }

  if (evType === 'content_block_stop') {
    if (!tab._stream) return;
    // Flush pending markdown render immediately on block stop
    if (tab._stream.mdTimer) {
      clearTimeout(tab._stream.mdTimer);
      tab._stream.mdTimer = null;
    }
    if (tab._stream.bodyEl && tab._stream.textBuf) {
      tab._stream.bodyEl.innerHTML = md(tab._stream.textBuf);
      linkifyFilePaths(tab._stream.bodyEl);
    }
    tab._stream.blockType = null;
    if (tab === activeTab()) scrollEnd();
    return;
  }
}

function renderPostPlanActions(tab) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  // Remove any existing post-plan cards
  $msgs.querySelectorAll('.post-plan-card').forEach(el => el.remove());

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  const card = document.createElement('div');
  card.className = 'post-plan-card';

  const hdr = document.createElement('div');
  hdr.className = 'post-plan-header';
  hdr.textContent = 'PLAN COMPLETE';
  card.appendChild(hdr);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'post-plan-actions';

  const actions = [
    { label: 'Continue with implementation', prompt: 'Continue with the implementation based on the approved plan.', primary: true },
    { label: 'Compact context', action: 'compact' },
    { label: 'Edit plan', action: 'plan' },
  ];
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'post-plan-action ' + (a.primary ? 'pp-primary' : 'pp-secondary');
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      card.style.opacity = '0.45';
      card.style.pointerEvents = 'none';
      if (a.action === 'compact') {
        if (tab.ws?.readyState === WebSocket.OPEN) {
          tab.ws.send(JSON.stringify({ type: 'compact' }));
          appendStatus(tab, 'Compacting context...');
        }
      } else if (a.action === 'plan') {
        tab.planMode = true;
        const $plan = _panel?.querySelector('#cp-plan-toggle');
        if ($plan) $plan.classList.add('active');
        appendStatus(tab, 'Plan mode ON — Claude will plan without making changes');
      } else if (a.prompt) {
        // Exit plan mode before sending implementation prompt
        tab.planMode = false;
        const $plan = _panel?.querySelector('#cp-plan-toggle');
        if ($plan) $plan.classList.remove('active');
        const $input = _panel?.querySelector('#cp-input');
        if ($input) { $input.value = a.prompt; send(); }
      }
    });
    actionsRow.appendChild(btn);
  }
  card.appendChild(actionsRow);
  wrap.appendChild(card);
  el.appendChild(wrap);
  $msgs.appendChild(el);
  if (tab === activeTab()) scrollEnd();
}

function renderAssistant(tab, msg) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const content = msg.content || [];
  const thinks = content.filter(b => b.type === 'thinking');
  const texts = content.filter(b => b.type === 'text');
  const tools = content.filter(b => b.type === 'tool_use');
  // Suppress thinking display when Think toggle is off
  if (!_getEffort()) thinks.length = 0;
  if (!texts.length && !tools.length && !thinks.length) return;

  const askTools = tools.filter(t => t.name === 'AskUserQuestion');
  const regularTools = tools.filter(t => t.name !== 'AskUserQuestion');

  // Detect ExitPlanMode — auto-toggle plan mode off and show post-plan actions immediately
  if (tools.some(t => t.name === 'ExitPlanMode')) {
    tab.planMode = false;
    const $plan = _panel?.querySelector('#cp-plan-toggle');
    if ($plan) $plan.classList.remove('active');
    renderPostPlanActions(tab);
  }

  // Partial message dedup
  const msgId = msg.id || null;
  if (msgId && msgId === tab.currentMsgId && tab.currentMsgEl) {
    const wrap = tab.currentMsgEl.querySelector('.msg-content');
    if (wrap) {
      // Update thinking block
      if (thinks.length) {
        const thinkText = thinks.map(b => b.thinking || '').join('\n').trim();
        if (thinkText) {
          let thinkEl = wrap.querySelector('.msg-thinking');
          if (thinkEl) {
            thinkEl.querySelector('.msg-thinking-content').textContent = thinkText;
          } else {
            thinkEl = document.createElement('details');
            thinkEl.className = 'msg-thinking';
            thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">${THINKING_ICON}</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
            thinkEl.querySelector('.msg-thinking-content').textContent = thinkText;
            wrap.insertBefore(thinkEl, wrap.firstChild);
          }
        }
      }
      const existingBody = wrap.querySelector('.msg-body');
      if (texts.length) {
        const html = md(texts.map(b => b.text).join('\n'));
        if (existingBody) {
          existingBody.innerHTML = html;
          linkifyFilePaths(existingBody);
        } else {
          const body = document.createElement('div');
          body.className = 'msg-body';
          body.innerHTML = html;
          linkifyFilePaths(body);
          const afterThink = wrap.querySelector('.msg-thinking');
          if (afterThink) afterThink.after(body);
          else wrap.insertBefore(body, wrap.firstChild);
        }
      }
      const existingToolIds = new Set([...wrap.querySelectorAll('.tool-card, .plan-card')].map(c => c.dataset.toolId));
      for (const t of regularTools) {
        if (!existingToolIds.has(t.id || '')) wrap.appendChild(buildTool(t));
      }
      const existingAskIds = new Set([...wrap.querySelectorAll('.ask-card')].map(c => c.dataset.toolId));
      for (const t of askTools) {
        if (!existingAskIds.has(t.id || '')) {
          wrap.appendChild(buildAskFromToolUse(tab, t));
        }
      }
    }
    if (tab === activeTab()) scrollEnd();
    return;
  }

  // New assistant message
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);
  const wrap = document.createElement('div');
  wrap.className = 'msg-content';
  if (thinks.length) {
    const thinkText = thinks.map(b => b.thinking || '').join('\n').trim();
    if (thinkText) {
      const thinkEl = document.createElement('details');
      thinkEl.className = 'msg-thinking';
      thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">${THINKING_ICON}</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
      thinkEl.querySelector('.msg-thinking-content').textContent = thinkText;
      wrap.appendChild(thinkEl);
    }
  }
  if (texts.length) {
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = md(texts.map(b => b.text).join('\n'));
    linkifyFilePaths(body);
    wrap.appendChild(body);
  }
  for (const t of regularTools) wrap.appendChild(buildTool(t));
  for (const t of askTools) wrap.appendChild(buildAskFromToolUse(tab, t));
  el.appendChild(wrap);
  $msgs.appendChild(el);

  if (msgId) { tab.currentMsgId = msgId; tab.currentMsgEl = el; }
  if (tab === activeTab()) scrollEnd();
}

/** Build an interactive AskUserQuestion card from a tool_use block */
function buildAskFromToolUse(tab, block) {
  const input = block.input || {};
  const toolUseId = block.id || '';
  tab.pendingAskToolUseId = toolUseId;

  // If renderAskUserQuestion already rendered this ask via control_request, return hidden placeholder
  if (tab.askRenderedViaControl) {
    const placeholder = document.createElement('div');
    placeholder.className = 'ask-card';
    placeholder.dataset.toolId = toolUseId;
    placeholder.style.display = 'none';
    return placeholder;
  }

  // Normalize: accept questions array, single question object, or flat input
  const questions = Array.isArray(input.questions) ? input.questions
    : (input.question || input.text || input.options) ? [input]
    : [input];
  const container = document.createElement('div');
  container.className = 'ask-card';
  container.dataset.toolId = toolUseId;

  // SynaBun-branded card — detect by question/header text or known menu options
  if (_isSynaBunAsk(questions)) {
    container.classList.add('synabun-ask');
    const bgLogo = document.createElement('div');
    bgLogo.className = 'synabun-ask-bg-logo';
    bgLogo.innerHTML = '<img src="logoHD.png" alt="">';
    container.appendChild(bgLogo);
  }

  for (const q of questions) {
    const questionText = q.question || q.text || q.header || '';

    if (q.header) {
      const hdr = document.createElement('div');
      hdr.className = 'ask-header';
      hdr.textContent = q.header;
      container.appendChild(hdr);
    }
    if (questionText && questionText !== q.header) {
      const qEl = document.createElement('div');
      qEl.className = 'ask-question';
      qEl.textContent = questionText;
      container.appendChild(qEl);
    }

    if (q.options?.length) {
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      for (const opt of q.options) {
        const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
        const optDesc = typeof opt === 'string' ? '' : (opt.description || '');
        const btn = document.createElement('button');
        btn.className = 'ask-option';
        const optWrap = document.createElement('span');
        optWrap.className = 'ask-option-wrap';
        const lbl = document.createElement('span');
        lbl.className = 'ask-option-label';
        lbl.textContent = optLabel;
        optWrap.appendChild(lbl);
        if (optDesc) {
          const desc = document.createElement('span');
          desc.className = 'ask-option-desc';
          desc.textContent = optDesc;
          optWrap.appendChild(desc);
        }
        btn.appendChild(optWrap);
        btn.addEventListener('click', () => {
          opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
          btn.classList.add('selected');
          const answers = {};
          answers[questionText] = optLabel;
          sendAskAnswer(tab, input.questions || [q], answers);
        });
        opts.appendChild(btn);
      }
      container.appendChild(opts);
    } else {
      const hint = document.createElement('div');
      hint.className = 'ask-hint';
      hint.textContent = 'Type your answer below and press Enter';
      container.appendChild(hint);
      tab.pendingAsk = { requestId: null, toolUseId, questions: input.questions || [q], questionText };
      setRunning(tab, false);
    }
  }

  hideThinking(tab);
  setRunning(tab, false);
  return container;
}

function sendAskAnswer(tab, questions, answers) {
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;

  const requestId = tab.pendingAskRequestId;
  const answerText = Object.values(answers).join(', ');
  console.log('[claude-panel] sendAskAnswer request_id:', requestId, 'answer:', answerText);

  if (requestId) {
    // Control mode — send control_response with request_id at top level
    tab.ws.send(JSON.stringify({
      type: 'control_response',
      request_id: requestId,
      response: { behavior: 'allow', updatedInput: { questions, answers } },
    }));
  } else {
    // Pipe mode — CLI auto-executed AskUserQuestion, send selection as follow-up query
    const $project = _panel?.querySelector('#cp-project');
    console.log('[claude-panel] Sending ask answer as follow-up query:', answerText);
    tab.ws.send(JSON.stringify({
      type: 'query',
      prompt: answerText,
      sessionId: tab.sessionId || undefined,
      model: _getModelId() || undefined,
      cwd: ddGetValue($project) || undefined,
      effort: _getEffort() || undefined,
    }));
  }

  tab.pendingAskRequestId = null;
  tab.pendingAskToolUseId = null;
  tab.pendingAskBufferedAnswer = null;
  tab.askRenderedViaControl = false;
  showThinking(tab);
  setRunning(tab, true);
}

function isPlanFile(filePath) {
  return filePath && /[/\\]\.claude[/\\]plans[/\\]/.test(filePath);
}

function buildPlanCard(block) {
  const i = block.input || {};
  const fileName = (i.file_path || '').split(/[/\\]/).pop() || 'plan.md';
  const card = document.createElement('details');
  card.className = 'plan-card';
  card.dataset.toolId = block.id || '';
  card.open = true;
  card.innerHTML = `<summary>
    <span class="plan-icon">P</span>
    <span class="plan-label">Plan</span>
    <span class="plan-file">${fileName}</span>
    <span class="plan-chevron">&#x203A;</span>
  </summary>`;
  const body = document.createElement('div');
  body.className = 'plan-body msg-body';
  body.innerHTML = md(i.content || '');
  linkifyFilePaths(body);
  card.appendChild(body);
  return card;
}

// ── SynaBun branded tool card builder ──
function formatSynaBunInput(input) {
  const pairs = [];
  for (const [key, val] of Object.entries(input)) {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    let displayVal;
    if (typeof val === 'string') {
      displayVal = esc(val.length > 200 ? val.slice(0, 200) + '\u2026' : val);
    } else if (Array.isArray(val)) {
      displayVal = val.map(v => `<span class="synabun-tag">${esc(String(v))}</span>`).join(' ');
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      displayVal = `<span class="synabun-value">${val}</span>`;
    } else {
      displayVal = esc(JSON.stringify(val));
    }
    pairs.push(`<div class="synabun-kv"><span class="synabun-kv-key">${esc(label)}</span> ${displayVal}</div>`);
  }
  return pairs.join('');
}

function buildSynaBunTool(block) {
  const meta = getSynaBunMeta(block.name);
  if (!meta) return null;
  const card = document.createElement('div');
  card.className = 'tool-card synabun-card';
  card.dataset.toolId = block.id || '';
  card.dataset.toolName = block.name;

  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr synabun-hdr';
  const icon = document.createElement('span'); icon.className = 'tool-icon synabun-icon';
  icon.innerHTML = meta.icon;
  const name = document.createElement('span'); name.className = 'tool-name synabun-name';
  name.textContent = meta.label;
  const detail = document.createElement('span'); detail.className = 'tool-detail';
  detail.textContent = meta.detailFn ? meta.detailFn(block.input || {}) : '';
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron'; chevron.innerHTML = '&#x203A;';
  hdr.append(icon, name, detail, chevron);
  hdr.addEventListener('click', () => card.classList.toggle('open'));

  const body = document.createElement('div'); body.className = 'tool-body';
  if (block.input && Object.keys(block.input).length) {
    const lbl = document.createElement('div'); lbl.className = 'tool-section-label synabun-section-label'; lbl.textContent = 'INPUT';
    const sec = document.createElement('div'); sec.className = 'tool-section synabun-input';
    sec.innerHTML = formatSynaBunInput(block.input);
    body.append(lbl, sec);
  }
  const rLbl = document.createElement('div'); rLbl.className = 'tool-section-label tool-result-label synabun-section-label'; rLbl.textContent = 'RESULT'; rLbl.hidden = true;
  const rSec = document.createElement('div'); rSec.className = 'tool-section tool-result-content synabun-result'; rSec.hidden = true;
  body.append(rLbl, rSec);
  card.append(hdr, body);
  return card;
}

// ── SynaBun result formatters ──
function extractSBResultText(ev) {
  if (Array.isArray(ev.content)) return ev.content.filter(b => b.type !== 'image').map(b => b.text || b.data || '').join('\n');
  if (typeof ev.content === 'string') return ev.content;
  return '';
}

function formatRecallResult(text) {
  const container = document.createElement('div');
  container.className = 'synabun-recall-results';
  // Header line
  const headerMatch = text.match(/^(Found .+?):\s*\n/);
  if (headerMatch) {
    const h = document.createElement('div'); h.className = 'synabun-recall-header';
    h.textContent = headerMatch[1]; container.appendChild(h);
  }
  // Parse memory entries: N. [UUID] (SCORE% match, importance: IMP, AGE)
  const entryRegex = /(\d+)\.\s+\[([^\]]+)\]\s+\((\d+)%\s*match,\s*importance:\s*(\d+),\s*([^)]+)\)\n\s+([^\n]+)\n([\s\S]*?)(?=\n\n\d+\.\s+\[|--- Session Context ---|$)/g;
  let m;
  while ((m = entryRegex.exec(text)) !== null) {
    const [, , id, score, imp, age, catLine, rest] = m;
    const lines = rest.trim().split('\n').map(l => l.trim());
    let content = '', files = '', tags = '';
    // catLine may contain tags like [tag1, tag2]
    const tagMatch = catLine.match(/\[([^\]]+)\]\s*$/);
    const catClean = tagMatch ? catLine.slice(0, tagMatch.index).trim() : catLine;
    if (tagMatch) tags = tagMatch[1];
    // Separate content lines from Files: lines
    const contentLines = [], fileLines = [];
    for (const l of lines) {
      if (l.startsWith('Files:')) fileLines.push(l.slice(6).trim());
      else contentLines.push(l);
    }
    content = contentLines.join('\n');
    files = fileLines.join(', ');

    const card = document.createElement('div'); card.className = 'synabun-memory-card';
    let html = `<div class="synabun-mem-header">
      <span class="synabun-mem-score">${esc(score)}%</span>
      <span class="synabun-mem-imp">imp:${esc(imp)}</span>
      <span class="synabun-mem-cat">${esc(catClean)}</span>
      <span class="synabun-mem-age">${esc(age)}</span>
    </div>`;
    if (tags) {
      html += '<div class="synabun-mem-tags">' + tags.split(',').map(t => `<span class="synabun-tag">${esc(t.trim())}</span>`).join('') + '</div>';
    }
    if (content) html += `<div class="synabun-mem-content">${esc(content)}</div>`;
    if (files) html += `<div class="synabun-mem-files">Files: ${esc(files)}</div>`;
    html += `<div class="synabun-mem-id">${esc(id.slice(0, 8))}</div>`;
    card.innerHTML = html;
    container.appendChild(card);
  }
  // Session context section
  const sessIdx = text.indexOf('--- Session Context ---');
  if (sessIdx !== -1) {
    const sessText = text.slice(sessIdx);
    const sessRegex = /SESSION:\s+\[([^\]]+)\]\s+\((\d+)%\s*match,\s*([^)]+)\)\n([\s\S]*?)(?=\n\nSESSION:|$)/g;
    let sm;
    while ((sm = sessRegex.exec(sessText)) !== null) {
      const [, sid, sscore, sinfo, sbody] = sm;
      const sc = document.createElement('div'); sc.className = 'synabun-memory-card';
      sc.style.borderColor = 'rgba(100,160,255,0.12)';
      sc.innerHTML = `<div class="synabun-mem-header">
        <span class="synabun-mem-score" style="background:rgba(100,160,255,0.12);color:rgba(130,180,255,0.9)">${esc(sscore)}%</span>
        <span class="synabun-mem-cat">Session</span>
        <span class="synabun-mem-age">${esc(sinfo)}</span>
      </div><div class="synabun-mem-content">${esc(sbody.trim())}</div>
      <div class="synabun-mem-id">${esc(sid.slice(0, 8))}</div>`;
      container.appendChild(sc);
    }
  }
  // Fallback if no entries parsed
  if (container.children.length <= (headerMatch ? 1 : 0)) {
    const pre = document.createElement('pre'); pre.className = 'synabun-result-pre';
    pre.textContent = text.slice(0, 2000); container.appendChild(pre);
  }
  return container;
}

function formatRememberResult(text) {
  const container = document.createElement('div'); container.className = 'synabun-confirmation';
  const icon = document.createElement('div'); icon.className = 'synabun-confirm-icon';
  icon.innerHTML = ICON_CHECK;
  const body = document.createElement('div'); body.className = 'synabun-confirm-body';
  // Parse: Remembered [UUID] (cat/proj, importance: N): "content..."
  const m = text.match(/Remembered\s+\[([^\]]+)\]\s+\(([^)]+)\):\s*"?(.+?)"?\s*$/s);
  if (m) {
    body.innerHTML = `<div class="synabun-confirm-action">Remembered</div>
      <div style="margin-bottom:2px">${esc(m[3].slice(0, 150))}</div>
      <div style="font-size:9px;color:var(--t-faint)">${esc(m[2])} \u00B7 ${esc(m[1].slice(0, 8))}</div>`;
  } else {
    body.innerHTML = `<div class="synabun-confirm-action">Remembered</div><div>${esc(text.slice(0, 300))}</div>`;
  }
  container.append(icon, body);
  return container;
}

function formatMemoriesResult(text) {
  const container = document.createElement('div'); container.className = 'synabun-recall-results';
  // Check if it's stats output
  if (text.includes('Memory Statistics:')) {
    const pre = document.createElement('pre'); pre.className = 'synabun-result-pre';
    pre.textContent = text.slice(0, 2000); container.appendChild(pre);
    return container;
  }
  // Header
  const headerMatch = text.match(/^(.+?)\s*\((\d+)\):\s*\n/);
  if (headerMatch) {
    const h = document.createElement('div'); h.className = 'synabun-recall-header';
    h.textContent = `${headerMatch[1]} (${headerMatch[2]})`; container.appendChild(h);
  }
  // Parse: N. [UUID] CATEGORY | PROJECT | imp:IMP | AGE [TAGS]
  const entryRegex = /(\d+)\.\s+\[([^\]]+)\]\s+(.+?)(?:\s+\[([^\]]+)\])?\n\s+([\s\S]*?)(?=\n\n\d+\.\s+\[|$)/g;
  let m;
  while ((m = entryRegex.exec(text)) !== null) {
    const [, , id, meta, tags, content] = m;
    const card = document.createElement('div'); card.className = 'synabun-memory-card';
    let html = `<div class="synabun-mem-header"><span class="synabun-mem-cat">${esc(meta.trim())}</span></div>`;
    if (tags) html += '<div class="synabun-mem-tags">' + tags.split(',').map(t => `<span class="synabun-tag">${esc(t.trim())}</span>`).join('') + '</div>';
    html += `<div class="synabun-mem-content">${esc(content.trim())}</div>`;
    html += `<div class="synabun-mem-id">${esc(id.slice(0, 8))}</div>`;
    card.innerHTML = html; container.appendChild(card);
  }
  if (container.children.length <= (headerMatch ? 1 : 0)) {
    const pre = document.createElement('pre'); pre.className = 'synabun-result-pre';
    pre.textContent = text.slice(0, 2000); container.appendChild(pre);
  }
  return container;
}

function formatSBConfirmation(text, action) {
  const container = document.createElement('div'); container.className = 'synabun-confirmation';
  const icon = document.createElement('div'); icon.className = 'synabun-confirm-icon';
  icon.innerHTML = action === 'Forgot' ? ICON_X : ICON_CHECK;
  const body = document.createElement('div'); body.className = 'synabun-confirm-body';
  body.innerHTML = `<div class="synabun-confirm-action">${esc(action)}</div><div>${esc(text.slice(0, 400))}</div>`;
  container.append(icon, body);
  return container;
}

function updateSynaBunResult(card, ev) {
  const rLbl = card.querySelector('.tool-result-label');
  const rSec = card.querySelector('.tool-result-content');
  if (!rSec) return;
  rSec.innerHTML = '';

  const toolName = card.dataset.toolName || '';
  const key = synaBunToolKey(toolName);
  const rawText = extractSBResultText(ev);

  // Check for images first (browser screenshots)
  if (Array.isArray(ev.content)) {
    for (const b of ev.content) {
      if (b.type === 'image') {
        const data = b.source?.data || b.data || '';
        const mime = b.source?.media_type || b.media_type || 'image/png';
        if (data) { const img = document.createElement('img'); img.src = `data:${mime};base64,${data}`; img.style.cssText = 'max-width:100%;border-radius:4px;'; rSec.appendChild(img); }
      }
    }
  }

  if (key === 'recall') {
    rSec.appendChild(formatRecallResult(rawText));
  } else if (key === 'remember') {
    rSec.appendChild(formatRememberResult(rawText));
  } else if (key === 'memories') {
    rSec.appendChild(formatMemoriesResult(rawText));
  } else if (key === 'reflect') {
    rSec.appendChild(formatSBConfirmation(rawText, 'Updated'));
  } else if (key === 'forget') {
    rSec.appendChild(formatSBConfirmation(rawText, 'Forgot'));
  } else if (key === 'restore') {
    rSec.appendChild(formatSBConfirmation(rawText, 'Restored'));
  } else if (key === 'category') {
    rSec.appendChild(formatSBConfirmation(rawText, rawText.startsWith('Deleted') ? 'Deleted' : rawText.startsWith('Created') ? 'Created' : rawText.startsWith('Updated') ? 'Updated' : 'Categories'));
  } else if (key === 'sync') {
    rSec.appendChild(formatSBConfirmation(rawText, 'Synced'));
  } else {
    // Default: formatted pre
    const pre = document.createElement('pre'); pre.className = 'synabun-result-pre';
    pre.textContent = rawText.slice(0, 2000); rSec.appendChild(pre);
  }

  rLbl.hidden = false; rSec.hidden = false;
  card.classList.add(ev.is_error ? 'tool-error' : 'tool-ok');
}

function buildTool(block) {
  // Plan files get a special rendered card
  if (block.name === 'Write' && isPlanFile(block.input?.file_path)) {
    return buildPlanCard(block);
  }
  // SynaBun MCP tools get branded cards
  if (isSynaBunTool(block.name)) {
    const synCard = buildSynaBunTool(block);
    if (synCard) return synCard;
  }

  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = block.id || '';
  const hdr = document.createElement('div');
  hdr.className = 'tool-hdr';
  const icon = document.createElement('span'); icon.className = 'tool-icon';
  icon.innerHTML = toolIconSvg(block.name);
  const name = document.createElement('span'); name.className = 'tool-name'; name.textContent = block.name;
  const detail = document.createElement('span'); detail.className = 'tool-detail';
  const i = block.input || {};
  if (['Read','Edit','Write'].includes(block.name)) detail.textContent = (i.file_path || '').split(/[/\\]/).pop() || '';
  else if (block.name === 'Bash') detail.textContent = (i.command || '').slice(0, 40);
  else if (block.name === 'Glob' || block.name === 'Grep') detail.textContent = i.pattern || '';
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron'; chevron.innerHTML = '&#x203A;';
  hdr.append(icon, name, detail, chevron);
  hdr.addEventListener('click', () => card.classList.toggle('open'));

  const body = document.createElement('div'); body.className = 'tool-body';
  if (block.input && Object.keys(block.input).length) {
    const lbl = document.createElement('div'); lbl.className = 'tool-section-label'; lbl.textContent = 'INPUT';
    const sec = document.createElement('pre'); sec.className = 'tool-section'; sec.textContent = JSON.stringify(block.input, null, 2);
    body.append(lbl, sec);
  }
  const rLbl = document.createElement('div'); rLbl.className = 'tool-section-label tool-result-label'; rLbl.textContent = 'RESULT'; rLbl.hidden = true;
  const rSec = document.createElement('div'); rSec.className = 'tool-section tool-result-content'; rSec.hidden = true;
  body.append(rLbl, rSec);
  card.append(hdr, body);
  return card;
}

function updateToolResult(tab, ev) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const escapedId = CSS.escape(ev.tool_use_id);
  const card = $msgs.querySelector(`.tool-card[data-tool-id="${escapedId}"]`) || $msgs.querySelector(`.plan-card[data-tool-id="${escapedId}"]`);
  if (!card) return;
  // Plan cards don't have result sections — just mark success/error via border
  if (card.classList.contains('plan-card')) {
    card.style.borderColor = ev.is_error ? 'rgba(255,82,82,0.3)' : 'rgba(100,200,120,0.3)';
    return;
  }
  // SynaBun branded cards get rich result formatting
  if (card.classList.contains('synabun-card')) {
    updateSynaBunResult(card, ev);
    return;
  }
  const rLbl = card.querySelector('.tool-result-label');
  const rSec = card.querySelector('.tool-result-content');
  if (!rSec) return;
  rSec.innerHTML = '';
  if (Array.isArray(ev.content)) {
    for (const b of ev.content) {
      if (b.type === 'image') {
        // Image content block — render as <img>
        const data = b.source?.data || b.data || '';
        const mime = b.source?.media_type || b.media_type || 'image/png';
        if (data) {
          const img = document.createElement('img');
          img.src = `data:${mime};base64,${data}`;
          rSec.appendChild(img);
        }
      } else {
        // Text content block
        const text = b.text || b.data || '';
        if (text) {
          const pre = document.createElement('pre');
          pre.style.cssText = 'margin:0;background:none;border:none;white-space:pre-wrap;word-break:break-all;';
          pre.textContent = text.slice(0, 2000) + (text.length > 2000 ? '\n...' : '');
          rSec.appendChild(pre);
        }
      }
    }
  } else if (typeof ev.content === 'string') {
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;background:none;border:none;white-space:pre-wrap;word-break:break-all;';
    pre.textContent = ev.content.slice(0, 2000) + (ev.content.length > 2000 ? '\n...' : '');
    rSec.appendChild(pre);
  }
  rLbl.hidden = false; rSec.hidden = false;
  card.classList.add(ev.is_error ? 'tool-error' : 'tool-ok');
}

// ── Control requests (AskUserQuestion, permission prompts) ──
let _autoAcceptAll = false;
const _autoAllowTools = new Set([
  // Starts empty — permission prompts shown for every tool on first use.
  // User clicks "Always" checkbox to build up auto-allow set during session (mirrors terminal CLI behavior).
  // AskUserQuestion is always handled via the ask card flow, never auto-allowed.
]);

function handleControlRequest(tab, msg) {
  // Normalize: request may be nested or flat depending on CLI version
  const req = msg.request || msg;
  const requestId = msg.request_id || req.request_id;
  const toolName = req.tool_name;
  const subtype = req.subtype || (toolName ? 'can_use_tool' : undefined);
  console.log('[claude-panel] handleControlRequest:', subtype, toolName, 'request_id:', requestId, 'raw:', JSON.stringify(msg).slice(0, 300));
  if (!requestId) { console.warn('[claude-panel] control_request missing request_id, ignoring'); return; }

  if (toolName === 'AskUserQuestion') {
    // AskUserQuestion: save the request_id — answer is sent via control_response when user picks an option
    tab.pendingAskRequestId = requestId;
    // If tool_use block hasn't rendered the ask card yet, render from control_request input
    if (!tab.pendingAskToolUseId) {
      renderAskUserQuestion(tab, requestId, req.input);
    }
    // Flush buffered answer if user already clicked before control_request arrived
    if (tab.pendingAskBufferedAnswer) {
      const buffered = tab.pendingAskBufferedAnswer;
      tab.pendingAskBufferedAnswer = null;
      console.log('[claude-panel] Flushing buffered ask answer');
      sendAskAnswer(tab, buffered.questions, buffered.answers);
    }
    return;
  }

  if (toolName) {
    // Global auto-accept — skip all permission prompts (except AskUserQuestion, handled above)
    if (_autoAcceptAll) {
      sendPermissionResponse(tab, requestId, 'allow');
      return;
    }
    // Permission prompt — auto-allow only if user clicked "Always" for this tool
    if (_autoAllowTools.has(toolName)) {
      sendPermissionResponse(tab, requestId, 'allow');
      return;
    }
    tab._permQueue.push({ requestId, req });
    _showNextPerm(tab);
    return;
  }

  console.warn('[claude-panel] Unhandled control_request:', JSON.stringify(msg).slice(0, 500));
}

function _showNextPerm(tab) {
  if (tab._activePerm) return;
  const next = tab._permQueue.shift();
  if (!next) { _flushMsgBuffer(tab); return; }
  tab._activePerm = true;
  renderPermissionPrompt(tab, next.requestId, next.req);
}

/** Detect SynaBun skill ask cards by question/header text or known menu option labels */
function _isSynaBunAsk(questions) {
  const _SB_OPTS = /\b(Brainstorm Ideas|Audit Memories|Memorize Context|Memory Health|Search Memories|Auto Changelog)\b/;
  for (const q of questions) {
    const txt = q.question || q.text || q.header || '';
    if (/synabun/i.test(txt) || /synabun/i.test(q.header || '')) return true;
    const labels = (q.options || []).map(o => typeof o === 'string' ? o : (o.label || o.value || '')).join(' ');
    if (_SB_OPTS.test(labels)) return true;
  }
  return false;
}

function renderAskUserQuestion(tab, requestId, input) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  hideThinking(tab);
  tab.askRenderedViaControl = true;

  // Normalize: accept questions array, single question object, or flat input
  const questions = Array.isArray(input?.questions) ? input.questions
    : (input?.question || input?.text || input?.options) ? [input]
    : input ? [input] : [];
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  for (const q of questions) {
    const questionText = q.question || q.text || q.header || '';
    const card = document.createElement('div');
    card.className = 'ask-card';

    // SynaBun-branded card
    if (_isSynaBunAsk([q])) {
      card.classList.add('synabun-ask');
      const bgLogo = document.createElement('div');
      bgLogo.className = 'synabun-ask-bg-logo';
      bgLogo.innerHTML = '<img src="logoHD.png" alt="">';
      card.appendChild(bgLogo);
    }

    if (q.header) {
      const hdr = document.createElement('div');
      hdr.className = 'ask-header';
      hdr.textContent = q.header;
      card.appendChild(hdr);
    }
    if (questionText && questionText !== q.header) {
      const qEl = document.createElement('div');
      qEl.className = 'ask-question';
      qEl.textContent = questionText;
      card.appendChild(qEl);
    }

    if (q.options?.length) {
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      for (const opt of q.options) {
        const optLabel = typeof opt === 'string' ? opt : (opt.label || opt.value || String(opt));
        const optDesc = typeof opt === 'string' ? '' : (opt.description || '');
        const btn = document.createElement('button');
        btn.className = 'ask-option';
        const optWrap = document.createElement('span');
        optWrap.className = 'ask-option-wrap';
        const lbl = document.createElement('span');
        lbl.className = 'ask-option-label';
        lbl.textContent = optLabel;
        optWrap.appendChild(lbl);
        if (optDesc) {
          const desc = document.createElement('span');
          desc.className = 'ask-option-desc';
          desc.textContent = optDesc;
          optWrap.appendChild(desc);
        }
        btn.appendChild(optWrap);
        btn.addEventListener('click', () => {
          opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
          btn.classList.add('selected');
          const answers = {};
          answers[questionText] = optLabel;
          sendAskAnswer(tab, input.questions || [q], answers);
        });
        opts.appendChild(btn);
      }
      card.appendChild(opts);
    } else {
      const hint = document.createElement('div');
      hint.className = 'ask-hint';
      hint.textContent = 'Type your answer below and press Enter';
      card.appendChild(hint);
      tab.pendingAsk = { requestId: null, toolUseId: tab.pendingAskToolUseId, questions: input.questions || [q], questionText };
      setRunning(tab, false);
    }
    wrap.appendChild(card);
  }
  el.appendChild(wrap);
  $msgs.appendChild(el);
  setRunning(tab, false);
  if (tab === activeTab()) scrollEnd();
}

function renderPermissionPrompt(tab, requestId, req) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  hideThinking(tab);
  setRunning(tab, false);

  const toolName = req.tool_name || 'Unknown';
  const input = req.input || {};
  const isSynaBun = isSynaBunTool(toolName);
  const synMeta = isSynaBun ? getSynaBunMeta(toolName) : null;

  // Detail line
  let detail = '';
  if (isSynaBun && synMeta?.detailFn) detail = synMeta.detailFn(input);
  else if (['Read','Edit','Write'].includes(toolName)) detail = input.file_path || '';
  else if (toolName === 'Bash') detail = input.command || '';
  else if (toolName === 'Glob' || toolName === 'Grep') detail = input.pattern || '';
  else if (toolName === 'Agent') detail = input.description || input.prompt?.slice(0, 80) || '';
  else detail = Object.keys(input).length ? JSON.stringify(input).slice(0, 120) : '';

  const el = document.createElement('div');
  el.className = 'msg msg-assistant';
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  const card = document.createElement('div');
  card.className = 'perm-card active-perm' + (isSynaBun ? ' synabun-perm' : '');

  // Header label
  const hdr = document.createElement('div');
  hdr.className = 'perm-header';
  hdr.textContent = 'PERMISSION';
  card.appendChild(hdr);

  // Tool line
  const toolLine = document.createElement('div');
  toolLine.className = 'perm-tool-line';
  const icon = document.createElement('span');
  icon.className = 'perm-tool-icon';
  icon.innerHTML = toolIconSvg(toolName);
  const name = document.createElement('span');
  name.className = 'perm-tool-name';
  name.textContent = synMeta?.label || toolName;
  toolLine.append(icon, name);
  card.appendChild(toolLine);

  // Detail
  if (detail) {
    const detailEl = document.createElement('div');
    detailEl.className = 'perm-detail';
    detailEl.textContent = detail;
    card.appendChild(detailEl);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'perm-actions';

  const allowBtn = document.createElement('button');
  allowBtn.className = 'perm-btn perm-btn-allow';
  allowBtn.innerHTML = '<span class="perm-btn-icon">' + ICON_CHECK + '</span>Allow';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'perm-btn perm-btn-deny';
  denyBtn.innerHTML = '<span class="perm-btn-icon">' + ICON_X + '</span>Deny';

  const alwaysLbl = document.createElement('label');
  alwaysLbl.className = 'perm-always';
  const alwaysCb = document.createElement('input');
  alwaysCb.type = 'checkbox';
  const alwaysText = document.createElement('span');
  alwaysText.textContent = 'Always';
  alwaysLbl.append(alwaysCb, alwaysText);

  // Status badge for resolved state
  const statusBadge = document.createElement('span');
  statusBadge.className = 'perm-status';
  statusBadge.hidden = true;

  const resolve = (behavior) => {
    const always = alwaysCb.checked && behavior === 'allow';
    if (always) _autoAllowTools.add(toolName);
    card.classList.remove('active-perm');
    card.classList.add('resolved', behavior === 'allow' ? 'resolved-allow' : 'resolved-deny');
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    statusBadge.textContent = behavior === 'allow' ? 'Allowed' : 'Denied';
    statusBadge.hidden = false;
    sendPermissionResponse(tab, requestId, behavior, always);
    tab._activePerm = false;
    _showNextPerm(tab);
  };

  allowBtn.addEventListener('click', () => resolve('allow'));
  denyBtn.addEventListener('click', () => resolve('deny'));

  actions.append(allowBtn, denyBtn, alwaysLbl, statusBadge);
  card.appendChild(actions);
  wrap.appendChild(card);
  el.appendChild(wrap);
  $msgs.appendChild(el);
  if (tab === activeTab()) scrollEnd();
}

function sendPermissionResponse(tab, requestId, behavior, always = false) {
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
  console.log('[claude-panel] sendPermissionResponse:', behavior, 'request_id:', requestId, 'always:', always);
  tab.ws.send(JSON.stringify({
    type: 'control_response',
    request_id: requestId,
    response: { subtype: 'success', request_id: requestId, response: { behavior, always } },
  }));
  showThinking(tab);
  setRunning(tab, true);
}

// ── UI helpers (per-tab) ──
function appendUser(tab, text, images) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg msg-user';
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
  if (images?.length) {
    for (const img of images) {
      const imgEl = document.createElement('img');
      imgEl.src = `data:${img.mediaType};base64,${img.base64}`;
      imgEl.style.cssText = 'max-width:200px;max-height:150px;border-radius:6px;margin-bottom:4px;display:block;';
      bubble.appendChild(imgEl);
    }
  }
  if (text) { const txt = document.createTextNode(text); bubble.appendChild(txt); }
  el.appendChild(bubble); $msgs.appendChild(el);
  if (tab === activeTab()) scrollEnd();
}

function showThinking(tab) {
  hideThinking(tab);
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  // Use sendStartedAt for total elapsed since user pressed send (persists across repositions)
  if (!tab.sendStartedAt) tab.sendStartedAt = Date.now();
  tab.thinkStartedAt = tab.sendStartedAt;
  const el = document.createElement('div'); el.className = 'thinking';
  el.innerHTML = '<div class="think-avatar">' + CLAUDE_ICON + '</div><div class="think-dots"><span></span><span></span><span></span></div><span class="think-timer"></span>';
  $msgs.appendChild(el); tab.thinkingEl = el;
  tab.thinkTimerInterval = setInterval(() => {
    const sec = Math.round((Date.now() - tab.sendStartedAt) / 1000);
    const timer = el.querySelector('.think-timer');
    if (timer) timer.textContent = sec > 0 ? `${sec}s` : '';
  }, 1000);
  if (tab === activeTab()) scrollEnd();
}
function hideThinking(tab) {
  if (tab.thinkTimerInterval) { clearInterval(tab.thinkTimerInterval); tab.thinkTimerInterval = null; }
  tab.thinkStartedAt = null;
  if (tab.thinkingEl) { tab.thinkingEl.remove(); tab.thinkingEl = null; }
}

function appendStatus(tab, text) {
  const $msgs = tab.messagesEl; if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg-status'; el.textContent = text;
  $msgs.appendChild(el); if (tab === activeTab()) scrollEnd();
}
function appendError(tab, text) {
  const $msgs = tab.messagesEl; if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg-error'; el.textContent = text;
  $msgs.appendChild(el); if (tab === activeTab()) scrollEnd();
}

function scrollEnd() {
  const tab = activeTab();
  const $msgs = tab?.messagesEl;
  if ($msgs) requestAnimationFrame(() => requestAnimationFrame(() => { $msgs.scrollTop = $msgs.scrollHeight; }));
}

const RUNNING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — safety net for stuck running state

function setRunning(tab, r) {
  tab.running = r;
  // Clear any previous running timeout
  if (tab._runningTimeout) { clearTimeout(tab._runningTimeout); tab._runningTimeout = null; }
  if (r) {
    tab._lastWsActivity = Date.now();
    // Safety timeout: if running=true for too long with no WS activity, force finish
    tab._runningTimeout = setTimeout(() => {
      if (tab.running && (!tab._lastWsActivity || Date.now() - tab._lastWsActivity > RUNNING_TIMEOUT_MS - 5000)) {
        console.warn('[claude-panel] Running timeout for tab', tab.id, '— forcing finish');
        finishTab(tab);
        appendStatus(tab, 'Session timed out — no response received.');
      }
    }, RUNNING_TIMEOUT_MS);
  }
  updatePillRunning(tab);
  if (tab !== activeTab()) return;
  const $send = _panel?.querySelector('#cp-send');
  const $input = _panel?.querySelector('#cp-input');
  if (!$send || !$input) return;
  $send.disabled = false;
  if (r) {
    // Keep input enabled for /btw — user can type while Claude runs
    $input.disabled = false;
    _updateSendIcon($send, $input);
  } else {
    $send.classList.remove('abort'); $send.classList.remove('btw'); $send.innerHTML = _ICON_SEND; $input.disabled = false; $input.focus();
  }
}

// Dynamic send icon: while running, show send arrow if text present, stop icon if empty
const _ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const _ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
function _updateSendIcon($send, $input) {
  if (!$send || !$input) return;
  const tab = activeTab();
  if (!tab?.running) return;
  const hasText = $input.value.trim().length > 0;
  $send.disabled = false;
  if (hasText) {
    $send.classList.remove('abort'); $send.classList.add('btw');
    $send.innerHTML = _ICON_SEND;
  } else {
    $send.classList.add('abort'); $send.classList.remove('btw');
    $send.innerHTML = _ICON_STOP;
  }
}

function finishTab(tab) { hideThinking(tab); setRunning(tab, false); tab._wasRunning = false; tab.currentMsgEl = null; tab.currentMsgId = null; tab.pendingAskToolUseId = null; tab.pendingAskRequestId = null; tab.pendingAskBufferedAnswer = null; tab.sendStartedAt = null; if (tab._stream?.mdTimer) clearTimeout(tab._stream.mdTimer); tab._stream = null; saveTabs(); }

function send() {
  const tab = activeTab();
  if (!tab) return;
  const $input = _panel?.querySelector('#cp-input');
  const $project = _panel?.querySelector('#cp-project');
  const $model = _panel?.querySelector('#cp-model');
  if (!$input) return;
  const text = $input.value.trim();
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
  if (tab.running) {
    if (!text && !tab.attachedImages.length) {
      // Empty send while running = abort (stop)
      tab.ws.send(JSON.stringify({ type: 'abort' })); return;
    }
    // /btw: has text while running — interrupt and continue with new context
    tab.ws.send(JSON.stringify({ type: 'abort' }));
    tab._btwPending = { text, images: tab.attachedImages.length ? [...tab.attachedImages] : null };
    $input.value = ''; autoResize();
    appendUser(tab, text, tab._btwPending.images);
    hideSlashHints();
    return;
  }
  if (!text && !tab.attachedImages.length) return;

  // Clear post-plan action cards on new message
  tab.messagesEl?.querySelectorAll('.post-plan-card').forEach(el => { const msg = el.closest('.msg'); if (msg) msg.remove(); else el.remove(); });

  if (text === '/clear') { $input.value = ''; tab.messagesEl.innerHTML = ''; hideSlashHints(); return; }
  if (text === '/compact') {
    $input.value = ''; hideSlashHints();
    if (tab.running) { appendStatus(tab, 'Cannot compact while Claude is processing.'); return; }
    if (tab.ws?.readyState === WebSocket.OPEN) {
      tab.compacting = true;
      _setCompactingUI(true);
      tab.ws.send(JSON.stringify({ type: 'compact' }));
      appendStatus(tab, 'Compacting context...');
    }
    return;
  }
  if (text === '/plan') {
    $input.value = ''; hideSlashHints();
    tab.planMode = !tab.planMode;
    const $plan = _panel?.querySelector('#cp-plan-toggle');
    if ($plan) $plan.classList.toggle('active', tab.planMode);
    appendStatus(tab, tab.planMode ? 'Plan mode ON — Claude will plan without making changes' : 'Plan mode OFF');
    return;
  }

  if (tab.pendingAsk && text) {
    $input.value = ''; autoResize();
    appendUser(tab, text); tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
    const answers = {};
    answers[tab.pendingAsk.questionText] = text;
    sendAskAnswer(tab, tab.pendingAsk.questions, answers);
    tab.pendingAsk = null;
    return;
  }

  $input.value = ''; autoResize();
  const pendingImages = tab.attachedImages.length ? [...tab.attachedImages] : null;
  appendUser(tab, text, pendingImages); tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
  let prompt = buildPromptWithAttachments(tab, text);
  if (tab.planMode && prompt) {
    prompt = `[PLAN MODE — think step by step, create a detailed plan, do NOT make code changes]\n\n${prompt}`;
  }

  // Update pill label on first message
  if (tab.label === 'New chat' && text) {
    tab.label = trunc(text, 20);
    updatePillLabel(tab);
    const headerLabel = _panel?.querySelector('.cp-session-label');
    if (headerLabel) headerLabel.textContent = tab.label;
    saveTabs();
  }

  const msg = {
    type: 'query', prompt,
    cwd: ddGetValue($project) || undefined,
    sessionId: tab.sessionId || undefined,
    model: _getModelId() || undefined,
    effort: _getEffort() || undefined,
    windowId: _windowId,
  };
  if (pendingImages) {
    msg.images = pendingImages.map(i => ({ base64: i.base64, mediaType: i.mediaType }));
    tab.attachedImages = [];
    updateAttachBadge();
    const preview = _panel?.querySelector('#cp-image-preview');
    if (preview) preview.innerHTML = '';
  }
  hideSlashHints();
  tab.ws.send(JSON.stringify(msg));
}

// ── Browser embed: live screencast inside the panel ──

function showBrowserEmbed(sessionId, url) {
  if (_browserEmbed?.sessionId === sessionId) return; // already showing this session
  hideBrowserEmbed(); // clean up any previous

  const container = _panel?.querySelector('#cp-browser-embed');
  if (!container) return;

  const canvas = container.querySelector('.cp-browser-canvas');
  const ctx = canvas.getContext('2d');
  const urlBar = container.querySelector('.cp-browser-url');
  if (url) urlBar.value = url;

  // Connect screencast WebSocket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/browser/${sessionId}`);

  _browserEmbed = { sessionId, ws, canvas, ctx, urlBar, container };
  _browserEmbedVisible = true;

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'frame' && msg.data) {
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = 'data:image/jpeg;base64,' + msg.data;
      } else if (msg.type === 'navigated' || msg.type === 'loaded' || msg.type === 'init') {
        if (msg.url) urlBar.value = msg.url;
      } else if (msg.type === 'error') {
        console.warn('[claude-panel] Browser embed error:', msg.message);
      }
    } catch {}
  };

  ws.onclose = () => {
    if (_browserEmbed?.sessionId === sessionId) hideBrowserEmbed();
  };

  // Show with animation
  container.classList.add('active', 'cp-browser-enter');
  container.addEventListener('animationend', () => {
    container.classList.remove('cp-browser-enter');
  }, { once: true });

  // Wire nav buttons
  _wireBrowserEmbedEvents();

  // Resize observer — update canvas display size only (do NOT resize browser viewport)
  // The browser stays at its original viewport (e.g. 1280x800) and frames scale to fit.
  const canvasWrap = container.querySelector('.cp-browser-canvas-wrap');
  const ro = new ResizeObserver(() => {
    const rect = canvasWrap.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (w < 10 || h < 10) return;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  });
  ro.observe(canvasWrap);
  _browserEmbed.ro = ro;
}

function hideBrowserEmbed() {
  if (!_browserEmbed) return;
  const { ws, container, ro } = _browserEmbed;
  if (ro) ro.disconnect();
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  if (container) {
    container.classList.remove('active', 'cp-browser-enter');
  }
  _browserEmbed = null;
  _browserEmbedVisible = false;
}

function _browserSend(msg) {
  if (_browserEmbed?.ws?.readyState === WebSocket.OPEN) {
    _browserEmbed.ws.send(JSON.stringify(msg));
  }
}

function _wireBrowserEmbedEvents() {
  const container = _panel?.querySelector('#cp-browser-embed');
  if (!container || container._cpWired) return;
  container._cpWired = true;

  const canvas = container.querySelector('.cp-browser-canvas');
  const urlBar = container.querySelector('.cp-browser-url');

  // Nav buttons
  container.querySelector('.cp-browser-back')?.addEventListener('click', () => _browserSend({ type: 'back' }));
  container.querySelector('.cp-browser-fwd')?.addEventListener('click', () => _browserSend({ type: 'forward' }));
  container.querySelector('.cp-browser-reload')?.addEventListener('click', () => _browserSend({ type: 'reload' }));

  // URL bar enter to navigate
  urlBar?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      let navUrl = urlBar.value.trim();
      if (navUrl && !navUrl.match(/^https?:\/\//)) navUrl = 'https://' + navUrl;
      _browserSend({ type: 'navigate', url: navUrl });
    }
  });

  // Close embed button
  container.querySelector('.cp-browser-close-embed')?.addEventListener('click', () => hideBrowserEmbed());

  // Detach button — pop into floating window
  container.querySelector('.cp-browser-detach')?.addEventListener('click', () => detachBrowserEmbed());

  // ── Forward mouse/keyboard from canvas to browser ──
  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  canvas.addEventListener('click', (e) => {
    const { x, y } = canvasCoords(e);
    _browserSend({ type: 'click', x, y });
  });
  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = canvasCoords(e);
    _browserSend({ type: 'dblclick', x, y });
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    _browserSend({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });

  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      _browserSend({ type: 'keypress', text: e.key });
    } else {
      _browserSend({ type: 'keydown', key: e.key });
    }
  });
  canvas.addEventListener('keyup', (e) => {
    e.preventDefault();
    if (e.key.length > 1) _browserSend({ type: 'keyup', key: e.key });
  });
}

function detachBrowserEmbed() {
  if (!_browserEmbed) return;
  const { sessionId, urlBar } = _browserEmbed;
  const url = urlBar?.value || '';
  // Close the embedded view (WS disconnect) — server supports multiple WS clients,
  // so the floating window will connect its own WS to the same session
  hideBrowserEmbed();
  // Reconnect as a floating window via the terminal system
  emit('browser:reconnect', { sessionId, url });
}

// ── Browser embed sync listeners (wired once on init) ──
let _browserSyncWired = false;
function _wireBrowserSync() {
  if (_browserSyncWired) return;
  _browserSyncWired = true;

  // Auto-show browser embed ONLY when the panel's Claude process triggered it
  on('sync:browser:created', async (msg) => {
    if (!_panel || !_visible) return; // panel not open, let terminal handle it
    const tab = activeTab();
    if (!tab?.running) return; // Claude not actively processing — browser was opened externally
    if (!msg.sessionId) return;
    if (_browserEmbedVisible && _browserEmbed?.sessionId === msg.sessionId) return;
    showBrowserEmbed(msg.sessionId, msg.url);
  });

  // Auto-hide when browser session is destroyed
  on('sync:browser:deleted', (msg) => {
    if (_browserEmbed?.sessionId === msg.sessionId) {
      hideBrowserEmbed();
    }
  });
}

function autoResize() {
  const $input = _panel?.querySelector('#cp-input');
  if (!$input) return;
  $input.style.height = 'auto';
  const maxH = 180;
  const h = Math.min($input.scrollHeight, maxH);
  $input.style.height = h + 'px';
  // Add fade mask when content overflows
  if ($input.scrollHeight > $input.clientHeight + 2) {
    $input.classList.add('scrollable');
  } else {
    $input.classList.remove('scrollable');
  }
}

// ── Config loading ──
async function loadConfig() {
  try {
    const res = await fetch('/api/claude/config').then(r => r.json());
    if (!res.ok) return;
    _projects = res.projects || [];
    _models = res.models || [];

    // Detect server restart — clear stale tab state so fresh sessions start clean
    if (res.bootId) {
      const savedBoot = storage.getItem(STOR.bootId);
      if (savedBoot && savedBoot !== res.bootId) {
        // Server restarted since last visit — wipe saved tabs for this window
        storage.removeItem(STOR.tabs);
        storage.removeItem(STOR.tabsLegacy);
        storage.removeItem(STOR.session);
      }
      storage.setItem(STOR.bootId, res.bootId);
    }

    const $project = _panel?.querySelector('#cp-project');
    const $model = _panel?.querySelector('#cp-model');

    if ($project) {
      const items = _projects.map(p => ({ value: p.path, label: p.label || p.path.split(/[/\\]/).pop() }));
      const saved = storage.getItem(STOR.project);
      ddPopulate($project, items, saved || '');
      if (saved) loadBranches(saved);
    }

    if ($model) {
      // Composite value: "modelId:contextWindow" to differentiate models with same id but different context
      const items = _models.map(m => ({ value: `${m.id}:${m.contextWindow || 200000}`, label: m.label }));
      const saved = storage.getItem(STOR.model);
      ddPopulate($model, items, saved || '');
    }
  } catch {}
}

async function loadBranches(path) {
  const $branch = _panel?.querySelector('#cp-branch');
  if (!$branch) return;
  if (!path) { ddPopulate($branch, [], ''); return; }
  try {
    const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`).then(r => r.json());
    if (res.branches?.length) {
      const items = res.branches.map(b => ({ value: b, label: b }));
      ddPopulate($branch, items, res.current || '');
    }
  } catch {}
}

// ── Public API ──
export async function toggleClaudePanel() {
  if (!_panel) {
    injectStyles();
    _panel = buildPanel();
    document.body.appendChild(_panel);
    wireEvents();
    await loadConfig();   // must complete before restoreTabs — checks server boot ID
    loadSkills();
    restoreTabs();
    loadMonthlyCost();
    syncSessionCosts();
    _wireBrowserSync();
    _startHeartbeat();
  }
  _visible = !_visible;
  if (_visible) {
    _panel.classList.add('open');
    const pw = _panel.style.width || '22%';
    document.documentElement.style.setProperty('--claude-panel-width', pw.endsWith('px') ? (parseFloat(pw) + 16) + 'px' : 'calc(' + pw + ' + 16px)');
    _panel.querySelector('#cp-input')?.focus();
  } else {
    _panel.classList.remove('open');
    document.documentElement.style.setProperty('--claude-panel-width', '0px');
  }
  renderPills(); // Sync pill visibility with panel open/close state
  window.dispatchEvent(new Event('resize'));
}

export function isClaudePanelOpen() { return _visible; }

/** Open the panel (if closed) and pre-fill the input with text, placing cursor at the end.
 *  If opts.asFile is true or text looks like a file path, attach as a file chip instead. */
export function sendToPanel(text, opts = {}) {
  if (!_visible) toggleClaudePanel();
  const tab = activeTab();
  if (!tab) return;

  // Detect file paths — attach as file chip instead of text
  const looksLikePath = opts.asFile || /^[A-Za-z]:[/\\]/.test(text) || (text.startsWith('/') && text.includes('/') && !text.includes(' '));
  if (looksLikePath) {
    _attachPathToTab(tab, text);
    _panel?.querySelector('#cp-input')?.focus();
    return;
  }

  const $input = _panel?.querySelector('#cp-input');
  if (!$input) return;
  const existing = $input.value;
  if (existing && !existing.endsWith('\n') && !existing.endsWith(' ')) {
    $input.value = existing + ' ' + text;
  } else {
    $input.value = (existing || '') + text;
  }
  autoResize();
  $input.focus();
  $input.setSelectionRange($input.value.length, $input.value.length);
}

/** Attach a file path to the active tab — fetches content and shows chip */
async function _attachPathToTab(tab, fullPath) {
  const fileName = fullPath.split(/[/\\]/).pop() || fullPath;
  try {
    const res = await fetch(`/api/file-content?path=${encodeURIComponent(fullPath)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.content != null) {
        tab.attachedFiles.push({ name: fileName, path: fullPath, content: String(data.content).slice(0, 50000) });
      } else {
        // Binary or unreadable — still attach as path reference
        tab.attachedFiles.push({ name: fileName, path: fullPath, content: `[File: ${fullPath}]` });
      }
    } else {
      tab.attachedFiles.push({ name: fileName, path: fullPath, content: `[File: ${fullPath}]` });
    }
  } catch {
    tab.attachedFiles.push({ name: fileName, path: fullPath, content: `[File: ${fullPath}]` });
  }
  _addPathChip(tab, fileName, fullPath, tab.attachedFiles.length - 1);
  updateAttachBadge();
  const $send = _panel?.querySelector('#cp-send');
  if ($send) $send.disabled = false;
}

/** Add a path chip to the preview area */
function _addPathChip(tab, fileName, fullPath, idx) {
  const preview = _panel?.querySelector('#cp-image-preview');
  if (!preview) return;
  const chip = document.createElement('div');
  chip.className = 'cp-path-chip';
  chip.dataset.fileIdx = idx;
  chip.title = fullPath;
  chip.innerHTML = `
    <span class="cp-path-chip-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
    <span class="cp-path-chip-name">${escH(fileName)}</span>
  `;
  const x = document.createElement('button');
  x.className = 'cp-path-chip-x';
  x.textContent = '\u00d7';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = parseInt(chip.dataset.fileIdx, 10);
    tab.attachedFiles.splice(i, 1);
    chip.remove();
    preview.querySelectorAll('.cp-path-chip, .cp-file-chip').forEach((c, j) => { c.dataset.fileIdx = j; });
    updateAttachBadge();
    const $send = _panel?.querySelector('#cp-send');
    if ($send && !tab.attachedFiles.length && !tab.attachedImages.length && !_panel?.querySelector('#cp-input')?.value.trim()) $send.disabled = true;
  });
  chip.appendChild(x);
  preview.appendChild(chip);
}

// ── Slash command hints ──
let _slashHintIdx = -1;
async function loadSkills() {
  if (_skillsCache) return _skillsCache;
  try {
    const res = await fetch('/api/claude-code/skills').then(r => r.json());
    _skillsCache = (res.skills || []).map(s => ({ name: s.name || s.dirName, description: s.description || '' }));
    // Dedup by name (server may return both bundled + global)
    const seen = new Set(_skillsCache.map(s => s.name));
    // Add built-in client/Claude Code commands
    const builtins = [
      { name: 'btw', description: 'Add context while Claude is processing' },
      { name: 'clear', description: 'Clear all messages' },
      { name: 'compact', description: 'Compact context — reload session' },
      { name: 'commit', description: 'Stage and commit changes' },
      { name: 'plan', description: 'Toggle plan mode' },
      { name: 'review-pr', description: 'Review a pull request' },
      { name: 'simplify', description: 'Review changed code for quality and efficiency' },
      { name: 'loop', description: 'Run a command on a recurring interval' },
    ];
    for (const b of builtins) { if (!seen.has(b.name)) { _skillsCache.push(b); seen.add(b.name); } }
    _skillsCache.sort((a, b) => a.name.localeCompare(b.name));
  } catch { _skillsCache = [{ name: 'clear', description: 'Clear all messages' }]; }
  return _skillsCache;
}
function showSlashHints(filter) {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if (!$hints || !_skillsCache) return;
  const q = filter.toLowerCase();
  const matches = _skillsCache.filter(s => s.name.toLowerCase().startsWith(q));
  if (!matches.length || !filter) { hideSlashHints(); return; }
  $hints.innerHTML = '';
  matches.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'cp-slash-item' + (i === 0 ? ' active' : '');
    el.innerHTML = `<div class="cp-slash-name">/${esc(s.name)}</div><div class="cp-slash-desc">${esc(s.description)}</div>`;
    el.addEventListener('click', () => {
      const $input = _panel?.querySelector('#cp-input');
      if ($input) { $input.value = '/' + s.name + ' '; $input.focus(); }
      hideSlashHints();
    });
    $hints.appendChild(el);
  });
  _slashHintIdx = 0;
  $hints.classList.add('open');
}
function hideSlashHints() {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if ($hints) { $hints.classList.remove('open'); $hints.innerHTML = ''; }
  _slashHintIdx = -1;
}
function navigateSlashHints(dir) {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if (!$hints) return;
  const items = $hints.querySelectorAll('.cp-slash-item');
  if (!items.length) return;
  items[_slashHintIdx]?.classList.remove('active');
  _slashHintIdx = Math.max(0, Math.min(items.length - 1, _slashHintIdx + dir));
  items[_slashHintIdx]?.classList.add('active');
}
function acceptSlashHint() {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if (!$hints) return false;
  const active = $hints.querySelector('.cp-slash-item.active');
  if (!active) return false;
  active.click();
  return true;
}

// ── Image preview helpers ──
function addImagePreview(dataUrl, idx) {
  const preview = _panel?.querySelector('#cp-image-preview');
  if (!preview) return;
  const thumb = document.createElement('div');
  thumb.className = 'cp-thumb';
  thumb.dataset.idx = idx;
  const img = document.createElement('img');
  img.src = dataUrl;
  const x = document.createElement('button');
  x.className = 'cp-thumb-x';
  x.textContent = '\u00d7';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    const tab = activeTab();
    if (!tab) return;
    const i = parseInt(thumb.dataset.idx, 10);
    tab.attachedImages.splice(i, 1);
    thumb.remove();
    preview.querySelectorAll('.cp-thumb').forEach((t, j) => { t.dataset.idx = j; });
    updateAttachBadge();
    const $send = _panel?.querySelector('#cp-send');
    if ($send && !tab.attachedImages.length && !_panel?.querySelector('#cp-input')?.value.trim()) $send.disabled = true;
  });
  thumb.append(img, x);
  preview.appendChild(thumb);
}

function addFilePreview(name, idx) {
  const preview = _panel?.querySelector('#cp-image-preview');
  if (!preview) return;
  const chip = document.createElement('div');
  chip.className = 'cp-file-chip';
  chip.dataset.fileIdx = idx;
  const label = document.createElement('span');
  label.className = 'cp-file-chip-name';
  label.textContent = name.length > 18 ? name.slice(0, 15) + '...' : name;
  label.title = name;
  const x = document.createElement('button');
  x.className = 'cp-file-chip-x';
  x.textContent = '\u00d7';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    const tab = activeTab();
    if (!tab) return;
    const i = parseInt(chip.dataset.fileIdx, 10);
    tab.attachedFiles.splice(i, 1);
    chip.remove();
    preview.querySelectorAll('.cp-file-chip').forEach((c, j) => { c.dataset.fileIdx = j; });
    updateAttachBadge();
    const $send = _panel?.querySelector('#cp-send');
    if ($send && !tab.attachedFiles.length && !tab.attachedImages.length && !_panel?.querySelector('#cp-input')?.value.trim()) $send.disabled = true;
  });
  chip.append(label, x);
  preview.appendChild(chip);
}

function handleImageDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  _panel?.querySelector('.cp-drop-overlay')?.remove();
  const files = e.dataTransfer?.files;
  if (!files) return;
  const tab = activeTab();
  if (!tab) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      const mediaType = file.type;
      tab.attachedImages.push({ base64, mediaType });
      updateAttachBadge();
      addImagePreview(dataUrl, tab.attachedImages.length - 1);
      const $send = _panel?.querySelector('#cp-send');
      if ($send) $send.disabled = false;
    };
    reader.readAsDataURL(file);
  }
}

function wireEvents() {
  const $input = _panel.querySelector('#cp-input');
  const $send = _panel.querySelector('#cp-send');
  const $project = _panel.querySelector('#cp-project');
  const $model = _panel.querySelector('#cp-model');
  const $branch = _panel.querySelector('#cp-branch');
  const $close = _panel.querySelector('.cp-close-btn');
  const $minimize = _panel.querySelector('.cp-minimize-btn');
  const $slide = _panel.querySelector('.cp-slide-btn');
  const $new = _panel.querySelector('.cp-new-btn');

  $input.addEventListener('input', () => {
    autoResize();
    const tab = activeTab();
    if (tab?.running) {
      // While running, dynamically switch send icon based on text content
      _updateSendIcon($send, $input);
    } else {
      $send.disabled = !$input.value.trim() && !tab?.attachedImages.length;
    }
    // Slash command hints
    const text = $input.value;
    if (text.startsWith('/') && !text.includes('\n')) {
      const cmd = text.slice(1).split(/\s/)[0];
      if (!text.includes(' ')) { showSlashHints(cmd); } else { hideSlashHints(); }
    } else { hideSlashHints(); }
  });
  $input.addEventListener('keydown', (e) => {
    // Slash hint navigation
    const $hints = _panel?.querySelector('#cp-slash-hints');
    if ($hints?.classList.contains('open')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateSlashHints(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateSlashHints(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); acceptSlashHint(); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashHints(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); hideSlashHints(); send(); }
    // Ctrl+L to clear
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const tab = activeTab(); if (tab?.messagesEl) tab.messagesEl.innerHTML = ''; }
    // Escape to abort — only if no btw text typed
    if (e.key === 'Escape' && activeTab()?.running && !$input.value.trim()) { activeTab()?.ws?.send(JSON.stringify({ type: 'abort' })); }
  });
  $send.addEventListener('click', send);
  $close.addEventListener('click', () => closeTab(_activeTabIdx));
  $slide.addEventListener('click', () => toggleClaudePanel());
  $minimize.addEventListener('click', () => {
    // Always minimize to a fresh blank panel — never swap in an existing session
    if (_tabs.length >= MAX_TABS) { appendStatus(activeTab(), 'Max sessions reached — close one first.'); return; }
    createTab(null, 'New chat');
  });

  // Image paste — capture images from clipboard with thumbnail preview
  $input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const tab = activeTab();
        if (!tab) return;
        const dataUrl = reader.result;
        const base64 = dataUrl.split(',')[1];
        const mediaType = item.type;
        tab.attachedImages.push({ base64, mediaType });
        updateAttachBadge();
        addImagePreview(dataUrl, tab.attachedImages.length - 1);
        $send.disabled = false;
      };
      reader.readAsDataURL(blob);
    }
  });

  // Image drag-and-drop
  const $bottom = _panel.querySelector('.cp-bottom');
  let dragCounter = 0;
  $bottom.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
      const overlay = document.createElement('div');
      overlay.className = 'cp-drop-overlay';
      overlay.textContent = 'Drop images here';
      $bottom.style.position = 'relative';
      $bottom.appendChild(overlay);
    }
  });
  $bottom.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; $bottom.querySelector('.cp-drop-overlay')?.remove(); }
  });
  $bottom.addEventListener('dragover', (e) => e.preventDefault());
  $bottom.addEventListener('drop', (e) => { dragCounter = 0; handleImageDrop(e); });

  // File attachment
  const $attach = _panel.querySelector('#cp-attach');
  if ($attach) {
    const fileInput = document.createElement('input');
    fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    $attach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const tab = activeTab();
      if (!tab) return;
      for (const file of fileInput.files) {
        if (!_isTextFile(file.name)) {
          appendStatus(tab, `Skipped "${file.name}" — only text/code files supported`);
          continue;
        }
        if (file.size > 100000) {
          appendStatus(tab, `Skipped "${file.name}" — file too large (${Math.round(file.size/1024)}KB, max 100KB)`);
          continue;
        }
        const text = await file.text();
        tab.attachedFiles.push({ name: file.name, content: text.slice(0, 50000) });
        addFilePreview(file.name, tab.attachedFiles.length - 1);
      }
      updateAttachBadge();
      $send.disabled = false;
      fileInput.value = '';
    });
  }
  $new.addEventListener('click', () => {
    if (_tabs.length >= MAX_TABS) return;
    createTab(null, 'New chat');
  });

  // Think intensity toggle
  const $think = _panel.querySelector('#cp-think-toggle');
  if ($think) {
    // Build dot elements (4 dots for 4 levels)
    const dotsWrap = $think.querySelector('.cp-think-dots');
    dotsWrap.innerHTML = '<i></i><i></i><i></i><i></i>';
    // Restore from storage
    const savedEffort = storage.getItem(STOR.effort) || 'off';
    _setEffort($think, savedEffort);
    $think.addEventListener('click', () => {
      const cur = $think.dataset.effort || 'off';
      const idx = EFFORT_LEVELS.indexOf(cur);
      const next = EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length];
      _setEffort($think, next);
      storage.setItem(STOR.effort, next);
    });
  }

  // Plan mode toggle
  const $plan = _panel.querySelector('#cp-plan-toggle');
  if ($plan) {
    $plan.addEventListener('click', () => {
      const tab = activeTab();
      if (!tab) return;
      tab.planMode = !tab.planMode;
      $plan.classList.toggle('active', tab.planMode);
    });
  }

  // Auto-accept toggle
  const $auto = _panel.querySelector('#cp-auto-toggle');
  if ($auto) {
    _autoAcceptAll = storage.getItem(STOR.autoAccept) === 'true';
    $auto.classList.toggle('active', _autoAcceptAll);
    $auto.addEventListener('click', () => {
      _autoAcceptAll = !_autoAcceptAll;
      $auto.classList.toggle('active', _autoAcceptAll);
      storage.setItem(STOR.autoAccept, _autoAcceptAll);
    });
  }

  // Compact button
  const $compact = _panel.querySelector('#cp-compact-btn');
  if ($compact) {
    $compact.addEventListener('click', () => {
      const tab = activeTab();
      if (!tab || !tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
      if (tab.running) { appendStatus(tab, 'Cannot compact while Claude is processing.'); return; }
      tab.compacting = true;
      _setCompactingUI(true);
      tab.ws.send(JSON.stringify({ type: 'compact' }));
      appendStatus(tab, 'Compacting context...');
    });
  }

  // Session selector
  const $sessBtn = _panel.querySelector('#cp-session-btn');
  const $sessMenu = _panel.querySelector('#cp-session-menu');
  $sessBtn.addEventListener('click', () => {
    const isOpen = $sessMenu.classList.toggle('open');
    if (isOpen) renderSessionMenu();
  });
  // Double-click session label to rename
  const $sessLabel = _panel.querySelector('.cp-session-label');
  $sessLabel?.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    $sessMenu.classList.remove('open');
    const tab = activeTab();
    if (tab?.sessionId) renameSession(tab.sessionId, $sessLabel.textContent);
  });
  // Rename button (explicit pencil icon next to session label)
  const $renameBtn = _panel.querySelector('#cp-header-rename');
  // Prevent mousedown from blurring an active rename input before click fires
  $renameBtn?.addEventListener('mousedown', (e) => {
    if ($sessLabel?.querySelector('.cp-rename-input')) e.preventDefault();
  });
  $renameBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    $sessMenu.classList.remove('open');
    const tab = activeTab();
    if (tab?.sessionId) renameSession(tab.sessionId, $sessLabel.textContent);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cp-header')) $sessMenu?.classList.remove('open');
  });

  // Cost widget toggle
  const $cost = _panel.querySelector('#cp-cost');
  if ($cost) {
    $cost.style.cursor = 'pointer';
    $cost.addEventListener('click', () => emit('cost:toggle'));
  }

  ddSetup($project); ddSetup($model); ddSetup($branch);
  $project.addEventListener('change', () => {
    storage.setItem(STOR.project, ddGetValue($project));
    loadBranches(ddGetValue($project));
    // Reset session when switching projects
    selectSession(null, 'New chat');
  });
  $model.addEventListener('change', () => {
    storage.setItem(STOR.model, ddGetValue($model));
    const tab = activeTab();
    if (tab) renderGauge(tab);
  });
  $branch.addEventListener('change', async () => {
    if (!ddGetValue($branch) || !ddGetValue($project)) return;
    try {
      await fetch('/api/terminal/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ddGetValue($project), branch: ddGetValue($branch) }),
      });
    } catch {}
  });

  // ── Resize handle drag ──
  const $handle = _panel.querySelector('.cp-resize-handle');
  if ($handle) {
    let dragging = false;
    $handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      _panel.style.transition = 'none';
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.min(700, Math.max(320, window.innerWidth - e.clientX - 16));
      _panel.style.width = w + 'px';
      document.documentElement.style.setProperty('--claude-panel-width', (w + 16) + 'px');
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      _panel.style.transition = '';
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.dispatchEvent(new Event('resize'));
    });
  }

  // ── Whiteboard "Send to Panel" — receive image via event bus ──
  on('wb:send-to-panel', ({ dataUrl }) => {
    if (!dataUrl) return;
    if (!_visible) toggleClaudePanel();
    const tab = activeTab();
    if (!tab) return;
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return;
    const mediaType = match[1];
    const base64 = match[2];
    tab.attachedImages.push({ base64, mediaType });
    updateAttachBadge();
    addImagePreview(dataUrl, tab.attachedImages.length - 1);
    const $send = _panel?.querySelector('#cp-send');
    if ($send) $send.disabled = false;
  });
}

export function initClaudePanel() {
  // Will be initialized on first toggle
}
