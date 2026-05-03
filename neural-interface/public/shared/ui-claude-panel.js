// ═══════════════════════════════════════════
// SynaBun — Claude Code Panel (Main Area)
// Stream-JSON renderer embedded in the Neural Interface viewport
// ═══════════════════════════════════════════

import { storage } from './storage.js';
import { state, emit, on } from './state.js';
import { fetchClaudeSessions, fetchBrowserSessions, searchSessions } from './api.js';
import { createFrameRenderer } from './utils.js';
import { notify, NOTIF_TYPE } from './ui-notifications.js';
import { reserveRightPanelLayout, clearRightPanelLayout } from './ui-sidepanel-layout.js';
import { subscribeCliStatus, recheckCliStatus, getCliDocUrl, getCliInstallCommand, getCliLabel } from './cli-status.js';

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

const SYNABUN_LOGO_ICON = '<img src="logoHD.png" alt="" style="width:14px;height:14px;object-fit:contain;">';

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

// ── CLI-installed status (claude binary detection) ──
let _cliInstalled = null;   // null = unknown / missing, version string = installed
let _cliUnsub = null;

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
  defaultModel: 'synabun-claude-panel-default-model', // user's preferred default model
  sessionSnapshots: 'synabun-claude-panel-session-snapshots', // global, per-sessionId rendered HTML cache
};

// ── Session HTML snapshot cache ──
// Global per-sessionId cache of rendered transcript HTML so resume on a fresh
// browser load mirrors the exact render that was produced during the live run.
// Falls back to upstream JSONL rebuild when no snapshot exists or it is stale.
const MAX_SESSION_SNAPSHOTS = 24;
const MAX_SESSION_SNAPSHOT_CHARS = 2_500_000;
let _sessionSnapshots = (() => {
  try {
    const raw = storage.getItem(STOR.sessionSnapshots);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; }
})();

const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max'];
const EFFORT_LABELS = { off: 'Think', low: 'lo', medium: 'med', high: 'hi', max: 'max' };
const EFFORT_TITLES = {
  off: 'Thinking off',
  low: 'Thinking: low',
  medium: 'Thinking: medium',
  high: 'Thinking: high',
  max: 'Thinking: max',
};
const PANEL_OWNER = 'claude-sidepanel';

// ── Built-in slash command registry (client-handled, Claude Code CLI parity) ──
// Each entry: { name, desc, kind, run(ctx) }. kind is purely informational.
// ctx = { tab, input, args, panel, appendStatus, appendInfoCard, autoResize, send }
const SLASH_COMMANDS = [
  { name: 'help', desc: 'Show available commands and keybinds', kind: 'info' },
  { name: 'clear', desc: 'Clear all messages (keeps session)', kind: 'action' },
  { name: 'compact', desc: 'Compress context — summarize and reload', kind: 'action' },
  { name: 'model', desc: 'Open the model picker', kind: 'action' },
  { name: 'resume', desc: 'Open the session history picker', kind: 'action' },
  { name: 'rename', desc: 'Rename current session', kind: 'action' },
  { name: 'agents', desc: 'Show subagents available in this session', kind: 'info' },
  { name: 'mcp', desc: 'Show MCP server status', kind: 'info' },
  { name: 'memory', desc: 'Open the memory editor', kind: 'action' },
  { name: 'init', desc: 'Create or refresh CLAUDE.md for this project', kind: 'prompt' },
  { name: 'doctor', desc: 'Diagnose session health', kind: 'info' },
  { name: 'context', desc: 'Show context-window breakdown', kind: 'info' },
  { name: 'config', desc: 'Open settings', kind: 'action' },
  { name: 'permissions', desc: 'Show current tool permissions', kind: 'info' },
  { name: 'add-dir', desc: 'Add a directory to allowed file access', kind: 'action' },
  { name: 'theme', desc: 'Open the theme picker', kind: 'action' },
  { name: 'plugin', desc: 'List active plugins and skills', kind: 'info' },
  { name: 'status', desc: 'Show session status summary', kind: 'info' },
  { name: 'cost', desc: 'Toggle the cost widget', kind: 'action' },
  { name: 'login', desc: 'Open Claude account login', kind: 'action' },
  { name: 'logout', desc: 'Open Claude account sign-out', kind: 'action' },
  { name: 'plan', desc: 'Toggle plan mode', kind: 'action' },
  { name: 'btw', desc: 'Add context while Claude is processing (Shift+Enter)', kind: 'info' },
];

// ── View modes (normal | transcript | focus) — Ctrl+O cycles ──
const VIEW_MODES = ['normal', 'transcript', 'focus'];
const VIEW_MODE_LABELS = { normal: 'Normal', transcript: 'Transcript', focus: 'Focus' };

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
        <div class="cp-ctx-fill" id="cp-ctx-fill"></div>
        <span class="cp-gauge-label" id="cp-gauge-label">context pending</span>
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
      <div class="cp-queue-tray" id="cp-queue-tray" hidden>
        <div class="cp-queue-header">
          <button class="cp-queue-expand" title="Expand queue">
            <svg viewBox="0 0 16 16" width="10" height="10"><polyline points="4 6 8 10 12 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
          <span class="cp-queue-title">Queue</span>
          <span class="cp-queue-count">0</span>
          <div class="cp-queue-actions">
            <button class="cp-queue-pause" title="Pause queue processing">
              <svg viewBox="0 0 16 16" width="10" height="10"><rect x="3" y="3" width="3" height="10" fill="currentColor"/><rect x="10" y="3" width="3" height="10" fill="currentColor"/></svg>
            </button>
            <button class="cp-queue-clear" title="Clear all queued">
              <svg viewBox="0 0 16 16" width="10" height="10"><line x1="4" y1="4" x2="12" y2="12" stroke="currentColor" stroke-width="2"/><line x1="12" y1="4" x2="4" y2="12" stroke="currentColor" stroke-width="2"/></svg>
            </button>
          </div>
        </div>
        <div class="cp-queue-items"></div>
      </div>
      <div class="cp-project-bar">
        <div class="cp-dropdown" id="cp-project" data-placeholder="project..." data-tooltip="Project"><span class="cp-dd-label">project...</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
        <div class="cp-dropdown cp-dropdown-sm" id="cp-branch" data-placeholder="branch" data-tooltip="Branch"><span class="cp-dd-label">branch</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
        <div class="cp-dropdown cp-dropdown-sm" id="cp-recall" data-placeholder="recall" data-tooltip="Recall profile"><span class="cp-dd-label">recall</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
        <div class="cp-dropdown cp-dropdown-sm" id="cp-view" data-placeholder="view" data-tooltip="View mode (Ctrl+O)"><span class="cp-dd-label">view</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
        <div class="cp-bar-actions">
          <button class="cp-bar-action" id="cp-action-changelog" data-tooltip="Generate changelog"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h8.5v13H4a1.5 1.5 0 01-1.5-1.5V3A1.5 1.5 0 014 1.5z"/><path d="M5.5 5h5M5.5 7.5h3M5.5 10h4"/></svg></button>
        </div>
      </div>
      <div class="cp-input-area">
        <div class="cp-input-wrap">
          <div class="cp-image-preview" id="cp-image-preview"></div>
          <div class="cp-input-inner">
            <textarea class="cp-input" id="cp-input" placeholder="Message SynaBun..." rows="1" autocomplete="off" spellcheck="false"></textarea>
            <div class="cp-slash-hints" id="cp-slash-hints"></div>
            <button class="cp-mic" id="cp-mic" title="Hold to speak"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></button>
            <button class="cp-send" id="cp-send" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
          </div>
        </div>
      </div>
      <div class="cp-toolbar">
        <div class="cp-toolbar-left">
          <svg class="cp-brand" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>
          <button class="cp-attach" id="cp-attach" data-tooltip="Attach file">
            <svg viewBox="0 0 24 24" width="13" height="13"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.49" fill="none" stroke="currentColor" stroke-width="2"/></svg>
            <span class="cp-attach-badge" hidden></span>
          </button>
        </div>
        <div class="cp-toolbar-right">
          <button class="cp-think-toggle" id="cp-think-toggle" data-effort="off" data-tooltip="Thinking off"><span class="cp-think-icon"><svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5L4 9h4l-1 5.5L12 7H8l1-5.5z"/></svg></span><span class="cp-think-label">Think</span><span class="cp-think-dots"></span></button>
          <button class="cp-plan-toggle" id="cp-plan-toggle" data-tooltip="Plan mode"><svg class="cp-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12M2 7h8M2 11h10M2 15h6"/></svg><span>Plan</span></button>
          <button class="cp-auto-toggle" id="cp-auto-toggle" data-tooltip="Auto-approve"><svg class="cp-toggle-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.5 3.5 6.5-7"/></svg><span>Auto</span></button>
          <div class="cp-dropdown cp-dropdown-sm" id="cp-model" data-placeholder="model" data-tooltip="Model"><span class="cp-dd-label">model</span><span class="cp-dd-arrow">&#x25BE;</span><div class="cp-dd-menu"></div></div>
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
      top: calc(var(--navbar-height, 48px) + 20px); right: 20px;
      width: 22%; min-width: 320px; max-width: 700px;
      bottom: 20px;
      z-index: 200;
      display: flex;
      flex-direction: column;
      background: rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(60px) saturate(1.5);
      -webkit-backdrop-filter: blur(60px) saturate(1.5);
      border: 0.5px solid rgba(255,255,255,0.06);
      border-radius: 16px;
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.3),
        0 1px 2px rgba(0,0,0,0.15),
        0 4px 8px rgba(0,0,0,0.12),
        0 12px 24px rgba(0,0,0,0.14),
        0 32px 64px rgba(0,0,0,0.18);
      overflow: visible;
      transform: translateX(calc(100% + 20px));
      transition: transform 0.32s cubic-bezier(0.16, 1, 0.3, 1),
                  opacity 0.28s ease;
      opacity: 0;
    }
    .claude-panel.open {
      transform: translateX(0);
      opacity: 1;
      overflow: visible;
    }
    /* Raise panel above floating terminal windows while a dropdown is open
       so project/branch/recall menus aren't clipped behind them. */
    .claude-panel:has(.cp-dropdown.open) { z-index: 99999; }

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

    /* ── Empty state (blank panel — no messages yet) ── */
    .cp-empty {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; gap: 8px; padding: 40px 20px; text-align: center; pointer-events: none;
    }
    .cp-empty-logo { display: flex; align-items: center; justify-content: center; }
    .cp-empty-logo svg { width: 32px; height: 32px; opacity: 0.25; fill: currentColor; }
    .cp-empty-name { font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.35); letter-spacing: 0.02em; }
    .cp-empty-hint { font-size: 11px; color: rgba(255,255,255,0.2); }
    .cp-messages:has(.msg) .cp-empty,
    .cp-messages:has(.msg-status) .cp-empty { display: none; }

    /* ── CLI-not-installed banner (sticky top of messages container) ── */
    .cp-cli-banner {
      flex-shrink: 0;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 10px;
      align-items: center;
      margin: 6px 8px 0;
      padding: 10px 12px;
      border: 1px solid rgba(255,180,80,0.45);
      border-radius: 8px;
      background: rgba(255,180,80,0.08);
      color: rgba(255,235,200,0.92);
      font-size: 11px;
      line-height: 1.4;
      pointer-events: auto;
      position: relative;
      z-index: 5;
    }
    .cp-cli-banner-icon {
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 50%;
      background: rgba(255,180,80,0.25);
      color: rgba(255,210,140,1);
      font-weight: 700;
    }
    .cp-cli-banner-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .cp-cli-banner-title {
      font-size: 12px; font-weight: 600;
      color: rgba(255,210,140,0.95);
    }
    .cp-cli-banner-body {
      font-size: 11px;
      color: rgba(255,255,255,0.7);
      word-break: break-word;
    }
    .cp-cli-banner-body code {
      padding: 1px 5px;
      background: rgba(0,0,0,0.35);
      border-radius: 3px;
      font-size: 10.5px;
      color: rgba(255,255,255,0.85);
    }
    .cp-cli-banner-actions { display: flex; gap: 6px; }
    .cp-cli-banner-link, .cp-cli-banner-recheck {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05);
      color: rgba(255,255,255,0.9);
      text-decoration: none;
      cursor: pointer;
      user-select: none;
      font-family: inherit;
    }
    .cp-cli-banner-link:hover, .cp-cli-banner-recheck:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.4);
    }
    .cp-cli-banner-recheck:disabled { opacity: 0.5; cursor: default; }
    .claude-panel.cp-cli-blocked .cp-send { opacity: 0.4 !important; cursor: not-allowed !important; }
    .claude-panel.cp-cli-blocked .cp-input { opacity: 0.7; }

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
      position: relative;
    }
    .cp-messages .msg-body pre code {
      font-family: 'JetBrains Mono', monospace; font-size: 11px;
      color: var(--t-primary); background: none; border: none; padding: 0;
    }
    .cp-copy-btn {
      position: absolute; top: 6px; right: 8px;
      background: none; border: none; cursor: pointer;
      font-family: 'JetBrains Mono', monospace; font-size: 9px;
      color: var(--t-faint); text-transform: uppercase; letter-spacing: 0.04em;
      padding: 2px 6px; border-radius: 4px; opacity: 0.6;
      transition: opacity 0.15s, color 0.15s, background 0.15s;
    }
    .cp-copy-btn:hover { opacity: 1; color: var(--t-bright); background: rgba(255,255,255,0.06); }
    .cp-copy-btn.copied { color: #6ec96e; opacity: 1; }
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
      margin: 8px 0; overflow: hidden; font-size: 11px;
      background: var(--s-subtle); transition: border-color 0.2s;
    }
    .cp-messages .msg-content > *:first-child { margin-top: 0; }
    .cp-messages .msg-content > *:last-child { margin-bottom: 0; }
    .cp-messages .msg-body + .tool-card,
    .cp-messages .msg-body + .msg-thinking,
    .cp-messages .msg-body + .plan-card,
    .cp-messages .msg-body + .ask-card,
    .cp-messages .msg-body + .post-plan-card,
    .cp-messages .msg-body + .perm-card { margin-top: 12px; }
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
      background: rgba(255,255,255,0.02);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 10px;
      padding: 14px 16px 16px;
      margin-top: 10px;
      box-sizing: border-box;
    }
    .ask-card + .ask-card { margin-top: 22px; }
    .ask-header {
      font-size: 10px; font-weight: 600; color: rgba(255,255,255,0.5);
      letter-spacing: 0.5px; margin-bottom: 10px;
      text-transform: uppercase;
      font-family: 'JetBrains Mono', monospace;
      display: flex; align-items: center; gap: 6px;
    }
    .ask-question {
      font-size: 12px; color: rgba(255,255,255,0.78);
      margin-bottom: 12px;
      line-height: 1.5;
    }
    .ask-options { display: flex; flex-direction: column; gap: 6px; }
    .ask-option {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 9px 12px; border-radius: 7px; cursor: pointer;
      background: transparent;
      border: 1px solid rgba(255,255,255,0.06);
      text-align: left; transition: background 0.12s, border-color 0.12s;
      width: 100%; box-sizing: border-box;
    }
    .ask-option::before {
      content: '';
      width: 13px; height: 13px; flex-shrink: 0; margin-top: 2px;
      border: 1.5px solid rgba(255,255,255,0.14); border-radius: 50%;
      transition: border-color 0.12s, background 0.12s;
    }
    .ask-option:hover:not(:disabled) {
      background: rgba(255,255,255,0.04);
      border-color: rgba(255,255,255,0.11);
    }
    .ask-option:hover:not(:disabled)::before {
      border-color: rgba(255,255,255,0.3);
    }
    .ask-option.selected {
      background: rgba(255,255,255,0.05);
      border-color: rgba(255,255,255,0.14);
    }
    .ask-option.selected::before {
      border-color: rgba(255,255,255,0.6);
      background: rgba(255,255,255,0.6);
      box-shadow: inset 0 0 0 2px rgba(14,14,18,0.9);
    }
    /* Multi-select: square checkbox instead of circle radio */
    .ask-options.multi .ask-option::before { border-radius: 3px; }
    .ask-options.multi .ask-option.selected::before { border-radius: 3px; }
    .ask-multi-hint {
      font-size: 9px; color: rgba(255,255,255,0.3);
      font-family: 'JetBrains Mono', monospace;
      font-style: italic; margin-bottom: 8px;
    }
    .ask-option:disabled:not(.selected) { opacity: 0.3; cursor: default; }
    .ask-option-wrap { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
    .ask-option-label {
      font-size: 11.5px; font-weight: 500; color: rgba(255,255,255,0.82);
      line-height: 1.35;
    }
    .ask-option-desc {
      font-size: 10px; color: rgba(255,255,255,0.38); line-height: 1.4;
    }
    .ask-hint {
      font-size: 10px; color: rgba(255,255,255,0.25);
      font-family: 'JetBrains Mono', monospace; font-style: italic;
    }
    /* ── Batched submit bar ── */
    .ask-submit-bar {
      display: flex; justify-content: flex-end; align-items: center;
      margin-top: 14px; padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.05);
    }
    .ask-submit {
      font-size: 10px; font-weight: 600; font-family: 'JetBrains Mono', monospace;
      padding: 7px 16px; border-radius: 6px; cursor: pointer;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.35);
      transition: all 0.12s; letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .ask-submit:disabled { opacity: 0.35; cursor: default; }
    .ask-submit:not(:disabled) { color: rgba(255,255,255,0.85); }
    .ask-submit:not(:disabled):hover {
      background: rgba(255,255,255,0.10);
      border-color: rgba(255,255,255,0.20);
    }
    .ask-text-input {
      width: 100%; padding: 8px 10px; border-radius: 6px;
      background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.85); font-size: 11px;
      font-family: 'JetBrains Mono', monospace; outline: none;
      transition: border-color 0.12s, background 0.12s;
      box-sizing: border-box;
    }
    .ask-text-input:focus {
      border-color: rgba(255,255,255,0.22);
      background: rgba(255,255,255,0.04);
    }
    .ask-text-input::placeholder { color: rgba(255,255,255,0.22); }
    .ask-text-input:disabled { opacity: 0.4; cursor: default; }
    .ask-or-type {
      font-size: 9px; color: rgba(255,255,255,0.3);
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.6px; text-transform: uppercase;
      margin: 14px 0 8px; padding-top: 10px;
      border-top: 1px dashed rgba(255,255,255,0.06);
      text-align: center;
    }
    /* Separate consecutive questions inside a single ask-card:
       the previous question's custom-answer input sits directly above
       the next question's header/text — push it down with a divider. */
    .ask-text-input + .ask-header,
    .ask-text-input + .ask-question {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid rgba(255,255,255,0.08);
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
      transition: opacity 0.4s ease,
                  transform 0.4s ease;
      pointer-events: none;
      z-index: 0;
    }
    .synabun-ask-bg-logo img {
      width: 100%;
      height: auto;
      opacity: 0.05;
    }
    .synabun-ask:hover .synabun-ask-bg-logo {
      opacity: 1;
      transform: scale(1);
    }

    /* ── Plan cards (inline rendered markdown) ── */
    .cp-messages .plan-card {
      border: 1px solid rgba(255,255,255,0.07); border-radius: 8px;
      margin: 8px 0; overflow: hidden; font-size: 11px;
      background: rgba(255,255,255,0.02);
    }
    .cp-messages .plan-card[open] { border-color: rgba(255,255,255,0.12); }
    .cp-messages .plan-card > summary {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 10px; cursor: pointer; user-select: none;
      list-style: none; transition: background 0.12s;
    }
    .cp-messages .plan-card > summary::-webkit-details-marker { display: none; }
    .cp-messages .plan-card > summary:hover { background: rgba(255,255,255,0.04); }
    .cp-messages .plan-card .plan-icon {
      width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
      font-size: 9px; font-weight: 700; color: rgba(130,200,140,0.8);
      background: rgba(130,200,140,0.08); border-radius: 5px;
      font-family: 'JetBrains Mono', monospace;
    }
    .cp-messages .plan-card .plan-label {
      font-family: 'JetBrains Mono', monospace; color: rgba(255,255,255,0.55);
      font-weight: 600; font-size: 10.5px;
    }
    .cp-messages .plan-card .plan-file {
      font-family: 'JetBrains Mono', monospace; color: var(--t-faint);
      font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cp-messages .plan-card .plan-chevron {
      color: var(--t-faint); font-size: 13px; transition: transform 0.2s;
    }
    .cp-messages .plan-card[open] .plan-chevron { transform: rotate(90deg); color: rgba(255,255,255,0.4); }
    .cp-messages .plan-card .plan-body {
      border-top: 1px solid rgba(255,255,255,0.05); padding: 8px 12px;
    }

    /* ── Post-plan action card ── */
    .post-plan-card {
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 8px; padding: 8px 10px;
      margin-top: 8px; position: relative;
      background: rgba(255,255,255,0.02);
      transition: opacity 0.3s, border-color 0.12s;
    }
    .post-plan-card:hover { border-color: rgba(255,255,255,0.12); }
    .post-plan-header {
      font-size: 8.5px; font-weight: 700; color: rgba(255,255,255,0.4);
      letter-spacing: 0.6px; margin-bottom: 6px;
      font-family: 'JetBrains Mono', monospace; text-transform: uppercase;
    }
    .post-plan-actions {
      display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    }
    .post-plan-action {
      padding: 4px 10px; border-radius: 5px; font-size: 10px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent; transition: all 0.12s;
      font-family: 'JetBrains Mono', monospace;
    }
    .post-plan-action.pp-primary {
      background: rgba(130,200,140,0.08); color: rgba(160,210,165,0.8);
      border-color: rgba(130,200,140,0.12);
    }
    .post-plan-action.pp-primary:hover {
      background: rgba(130,200,140,0.14); color: rgba(170,220,175,0.95);
      border-color: rgba(130,200,140,0.22);
    }
    .post-plan-action.pp-secondary {
      background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.35);
      border-color: rgba(255,255,255,0.06);
    }
    .post-plan-action.pp-secondary:hover {
      background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.6);
      border-color: rgba(255,255,255,0.12);
    }

    /* ── Permission prompt cards ── */
    .perm-card {
      background: var(--s-subtle);
      border: 1px solid var(--b-subtle);
      border-radius: 8px; padding: 8px 10px;
      margin-top: 8px; transition: opacity 0.3s, border-color 0.2s, box-shadow 0.3s;
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
    .perm-btn-always { background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.45); border-color: rgba(255,255,255,0.08); }
    .perm-btn-always:hover:not(:disabled) { background: rgba(245,180,60,0.12); color: rgba(245,195,90,0.85); border-color: rgba(245,180,60,0.2); }
    .perm-status {
      font-size: 9px; font-weight: 600; font-family: 'JetBrains Mono', monospace;
      color: var(--t-faint); letter-spacing: 0.3px; margin-left: auto;
    }
    .perm-card.resolved { opacity: 0.45; box-shadow: none; animation: none; background: var(--s-subtle); border-color: var(--b-subtle); }
    .perm-card.resolved .perm-btn { pointer-events: none; }
    .perm-card.resolved .perm-btn-allow, .perm-card.resolved .perm-btn-always { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.4); border-color: rgba(255,255,255,0.08); }
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
      margin: 8px 0; overflow: hidden;
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
      box-shadow: var(--shadow-sm), 0 0 0 1px rgba(255,255,255,0.06);
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
      min-width: 0;
    }
    .cp-input-wrap::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 14px;
      padding: 1px;
      pointer-events: none;
      background: conic-gradient(
        from var(--cp-border-angle, 0deg),
        rgba(212,162,127,0.0) 0%,
        rgba(212,162,127,0.35) 25%,
        rgba(212,162,127,0.10) 50%,
        rgba(212,162,127,0.35) 75%,
        rgba(212,162,127,0.0) 100%
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
      background: rgba(212,162,127,0.03);
      box-shadow: 0 0 20px rgba(212,162,127,0.04), 0 0 60px rgba(212,162,127,0.015);
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
    .cp-input::selection { background: rgba(212,162,127,0.3); color: inherit; }
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
      background: linear-gradient(135deg, rgba(212,162,127,0.14), rgba(212,162,127,0.04));
      border-radius: 7px;
      transform: scaleX(0);
      transform-origin: left;
      transition: transform 0.3s cubic-bezier(0.22, 0.68, 0, 1.2);
    }
    .cp-send:not(:disabled)::before {
      transform: scaleX(1);
    }
    .cp-send:not(:disabled) {
      color: rgba(235,210,190,0.9);
      border-color: rgba(212,162,127,0.2);
    }
    .cp-send:hover:not(:disabled) {
      border-color: rgba(212,162,127,0.35);
      color: rgba(245,225,210,0.98);
      box-shadow: 0 0 12px rgba(212,162,127,0.1);
      transform: translateY(-1px);
    }
    .cp-send:hover:not(:disabled)::before {
      background: linear-gradient(135deg, rgba(212,162,127,0.24), rgba(212,162,127,0.08));
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

    /* ── Mic button — push-to-talk, matches send button style ── */
    .cp-mic {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      color: rgba(255,255,255,0.25);
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.22, 0.68, 0, 1.2);
      position: sticky; bottom: 3px; align-self: flex-end;
      overflow: hidden;
    }
    .cp-mic:hover {
      color: rgba(255,255,255,0.6);
      border-color: rgba(255,255,255,0.15);
      box-shadow: 0 0 8px rgba(255,255,255,0.04);
      transform: translateY(-1px);
    }
    .cp-mic:active {
      transform: translateY(0px) scale(0.95);
      transition-duration: 0.08s;
    }
    .cp-mic svg { width: 13px; height: 13px; position: relative; z-index: 1; }
    .cp-mic.recording {
      color: rgba(255,160,60,0.95);
      border-color: rgba(255,140,40,0.35);
      box-shadow: 0 0 12px rgba(255,140,40,0.15);
      animation: cp-mic-pulse 1.5s ease-in-out infinite;
    }
    .cp-mic.recording:hover {
      color: #ffaa44;
      border-color: rgba(255,140,40,0.5);
      box-shadow: 0 0 16px rgba(255,140,40,0.2);
    }
    @keyframes cp-mic-pulse {
      0%, 100% { box-shadow: 0 0 8px rgba(255,140,40,0.1); }
      50% { box-shadow: 0 0 16px rgba(255,140,40,0.25); }
    }
    .cp-mic.unsupported { display: none; }

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
      color: #D4A27F;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .cp-brand:hover { opacity: 1; }

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
      position: absolute; bottom: calc(100% + 4px);
      left: auto; right: 0;
      min-width: 200px; max-width: 320px;
      max-height: 260px;
      overflow-y: auto; overflow-x: hidden;
      background: rgba(22,22,26,0.98);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 4px;
      z-index: 300;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .cp-dropdown.open .cp-dd-menu { display: block; }
    .cp-dd-item {
      padding: 6px 10px;
      font-size: 11px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.65);
      border-radius: 5px; cursor: pointer;
      overflow: hidden;
      display: flex; align-items: center;
      transition: background 0.1s;
    }
    .cp-dd-item:hover { background: rgba(255,255,255,0.07); }
    .cp-dd-item.selected { color: rgba(232,224,220,0.95); background: rgba(232,224,220,0.08); }
    .cp-dd-model-item { display: flex; align-items: center; gap: 6px; }
    .cp-dd-model-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .cp-dd-model-star {
      flex-shrink: 0; font-size: 9px; color: rgba(255,255,255,0.12);
      cursor: pointer; transition: color 0.15s, transform 0.15s;
      line-height: 1;
    }
    .cp-dd-model-star:hover { color: rgba(255,200,60,0.6); transform: scale(1.3); }
    .cp-dd-model-star.is-default { color: rgba(255,200,60,0.85); }
    .cp-dd-model-star.is-default:hover { color: rgba(255,200,60,1); }

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
      display: flex; flex-wrap: nowrap; gap: 6px; padding: 8px 12px 6px;
      overflow-x: auto; flex-shrink: 0;
      background: rgba(12,12,16,0.9);
      border-radius: 13px 13px 0 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.1) transparent;
    }
    .cp-image-preview::-webkit-scrollbar { height: 4px; }
    .cp-image-preview::-webkit-scrollbar-track { background: transparent; }
    .cp-image-preview::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
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
      z-index: 310; max-height: 320px; overflow-y: auto;
      overscroll-behavior: contain;
      box-shadow: var(--shadow-lg);
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

    /* ── Info cards (slash command output, diagnostics, hook feedback) ── */
    .cp-messages .msg-info-card {
      padding: 4px 14px;
    }
    .cp-messages .cp-info-body {
      background: rgba(20,20,24,0.65);
      border: 1px solid rgba(255,255,255,0.06);
      border-left: 3px solid rgba(140,160,200,0.45);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 11px;
      color: var(--t-primary);
    }
    .cp-messages .msg-info-card.cp-info-help .cp-info-body { border-left-color: rgba(255,195,0,0.5); }
    .cp-messages .msg-info-card.cp-info-doctor .cp-info-body { border-left-color: rgba(100,220,140,0.5); }
    .cp-messages .msg-info-card.cp-info-warn .cp-info-body { border-left-color: rgba(255,120,80,0.5); }
    .cp-messages .cp-info-title {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em;
      color: var(--t-bright); text-transform: uppercase;
      margin-bottom: 6px; font-family: 'JetBrains Mono', monospace;
    }
    .cp-messages .cp-info-content { white-space: pre-wrap; font-family: 'Inter', -apple-system, sans-serif; }
    .cp-messages .cp-info-row {
      display: flex; align-items: baseline; gap: 10px;
      padding: 2px 0; font-size: 11px; color: var(--t-primary);
      border-bottom: 1px dashed rgba(255,255,255,0.04);
    }
    .cp-messages .cp-info-row:last-child { border-bottom: none; }
    .cp-messages .cp-info-row.muted { color: var(--t-faint); font-size: 10.5px; }
    .cp-messages .cp-info-row code { background: rgba(255,255,255,0.05); padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
    .cp-messages .cp-doctor-k { color: var(--t-secondary); min-width: 120px; font-family: 'JetBrains Mono', monospace; font-size: 10px; }
    .cp-messages .cp-doctor-v { color: var(--t-bright); font-family: 'JetBrains Mono', monospace; font-size: 10px; }
    .cp-messages .cp-info-ok { color: rgba(100,220,140,0.9); }
    .cp-messages .cp-info-warn { color: rgba(255,180,80,0.9); }
    .cp-messages .cp-help-section-label {
      font-size: 9px; color: var(--t-faint); text-transform: uppercase; letter-spacing: 0.12em;
      font-family: 'JetBrains Mono', monospace; font-weight: 700;
      margin: 8px 0 2px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.04);
    }
    .cp-messages .cp-help-row {
      display: flex; align-items: baseline; gap: 10px; padding: 2px 0;
      font-size: 10.5px;
    }
    .cp-messages .cp-help-cmd {
      font-family: 'JetBrains Mono', monospace; color: rgba(255,210,100,0.85);
      min-width: 100px; font-size: 10px;
    }
    .cp-messages .cp-help-desc { color: var(--t-secondary); flex: 1; font-size: 10.5px; }

    /* ── Reverse-search modal ── */
    .cp-rsearch {
      position: absolute; inset: 0; z-index: 500;
      background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
    }
    .cp-rsearch-inner {
      width: 100%; max-width: 520px;
      background: rgba(16,16,18,0.98);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 8px;
      box-shadow: 0 24px 48px rgba(0,0,0,0.5);
    }
    .cp-rsearch-header {
      font-size: 9.5px; color: var(--t-faint); text-transform: uppercase;
      letter-spacing: 0.1em; padding: 4px 6px 6px; font-family: 'JetBrains Mono', monospace;
    }
    .cp-rsearch-input {
      width: 100%; background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
      color: var(--t-bright); padding: 6px 10px; font-size: 12px;
      font-family: 'JetBrains Mono', monospace; outline: none;
    }
    .cp-rsearch-input:focus { border-color: rgba(255,195,0,0.4); }
    .cp-rsearch-results { margin-top: 6px; max-height: 260px; overflow-y: auto; }
    .cp-rsearch-row {
      padding: 5px 8px; border-radius: 5px; font-size: 11px;
      font-family: 'JetBrains Mono', monospace; color: var(--t-primary);
      cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .cp-rsearch-row.active, .cp-rsearch-row:hover { background: rgba(255,255,255,0.07); color: var(--t-bright); }
    .cp-rsearch-empty { padding: 12px; text-align: center; color: var(--t-faint); font-size: 11px; }

    /* ── TODO slide-out dock (sibling surface, matches panel glass aesthetic) ── */
    .cp-todo-dock {
      position: absolute; bottom: 0; right: calc(100% + 6px);
      display: flex; flex-direction: row-reverse; align-items: flex-end;
      z-index: 20; pointer-events: none;
      max-height: 100%;
    }
    .cp-todo-tag {
      pointer-events: auto;
      display: flex; flex-direction: column; align-items: center; gap: 5px;
      padding: 9px 6px;
      background: rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(60px) saturate(1.5);
      -webkit-backdrop-filter: blur(60px) saturate(1.5);
      border: 0.5px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      color: rgba(255,210,60,0.78);
      cursor: pointer; font-family: 'JetBrains Mono', monospace;
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.3),
        0 1px 2px rgba(0,0,0,0.15),
        0 4px 8px rgba(0,0,0,0.12),
        0 12px 24px rgba(0,0,0,0.14);
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .cp-todo-tag:hover { background: rgba(28, 26, 22, 0.94); border-color: rgba(255,195,0,0.22); color: rgba(255,210,60,0.95); }
    .cp-todo-tag-ic { font-size: 13px; line-height: 1; }
    .cp-todo-tag-count { font-size: 9.5px; writing-mode: vertical-rl; transform: rotate(180deg); letter-spacing: 0.04em; opacity: 0.85; }
    .cp-todo-tag-pulse {
      width: 5px; height: 5px; border-radius: 50%;
      background: rgba(100,160,255,0.95);
      box-shadow: 0 0 6px rgba(100,160,255,0.7);
      animation: cp-todo-pulse 1.4s ease-in-out infinite;
    }
    @keyframes cp-todo-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

    .cp-todo-drawer {
      pointer-events: auto;
      width: 0; opacity: 0; overflow: hidden;
      background: rgba(18, 18, 20, 0.92);
      backdrop-filter: blur(60px) saturate(1.5);
      -webkit-backdrop-filter: blur(60px) saturate(1.5);
      border: 0.5px solid rgba(255,255,255,0.06);
      border-radius: 14px;
      box-shadow:
        0 0 0 0.5px rgba(0,0,0,0.3),
        0 1px 2px rgba(0,0,0,0.15),
        0 4px 8px rgba(0,0,0,0.12),
        0 12px 24px rgba(0,0,0,0.14),
        0 32px 64px rgba(0,0,0,0.18);
      display: flex; flex-direction: column;
      transition: width 0.22s cubic-bezier(0.2,0,0.2,1), opacity 0.18s;
      max-height: 100%;
    }
    .cp-todo-dock.is-open .cp-todo-drawer { width: 260px; opacity: 1; }
    .cp-todo-dock.is-open .cp-todo-tag { display: none; }

    .cp-todo-drawer .cp-todo-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px 8px;
      background: transparent;
      border-bottom: 0.5px solid rgba(255,255,255,0.04);
    }
    .cp-todo-drawer .cp-todo-title { font-size: 10px; font-weight: 600; color: rgba(255,210,60,0.78); letter-spacing: 0.12em; text-transform: uppercase; }
    .cp-todo-drawer .cp-todo-count { font-size: 10px; color: var(--t-faint); font-family: 'JetBrains Mono', monospace; opacity: 0.7; }
    .cp-todo-drawer .cp-todo-hide {
      margin-left: auto; background: none; border: none;
      color: var(--t-faint); cursor: pointer;
      font-size: 15px; line-height: 1; padding: 2px 5px;
      border-radius: 4px;
      transition: background 0.12s, color 0.12s;
    }
    .cp-todo-drawer .cp-todo-hide:hover { color: var(--t-bright); background: rgba(255,255,255,0.06); }
    .cp-todo-drawer .cp-todo-list { padding: 6px 4px; overflow-y: auto; max-height: 260px; }
    .cp-todo-drawer .cp-todo-item {
      display: flex; gap: 8px; padding: 5px 10px; font-size: 11.5px;
      align-items: baseline; border-radius: 6px;
    }
    .cp-todo-drawer .cp-todo-ic { width: 12px; flex-shrink: 0; font-family: 'JetBrains Mono', monospace; }
    .cp-todo-drawer .cp-todo-txt { flex: 1; line-height: 1.45; }
    .cp-todo-drawer .cp-todo-pend .cp-todo-ic { color: var(--t-faint); }
    .cp-todo-drawer .cp-todo-pend .cp-todo-txt { color: var(--t-secondary); }
    .cp-todo-drawer .cp-todo-prog { background: rgba(100,160,255,0.06); }
    .cp-todo-drawer .cp-todo-prog .cp-todo-ic { color: rgba(100,160,255,0.9); }
    .cp-todo-drawer .cp-todo-prog .cp-todo-txt { color: var(--t-bright); font-weight: 500; }
    .cp-todo-drawer .cp-todo-done .cp-todo-ic { color: rgba(100,220,140,0.75); }
    .cp-todo-drawer .cp-todo-done .cp-todo-txt { color: var(--t-faint); text-decoration: line-through; text-decoration-color: rgba(255,255,255,0.2); }
    .cp-todo-drawer .cp-todo-foot {
      padding: 8px 12px; font-size: 10px;
      background: rgba(255,255,255,0.02);
      color: var(--t-secondary);
      border-top: 0.5px solid rgba(255,255,255,0.04);
      font-family: 'JetBrains Mono', monospace;
      border-radius: 0 0 14px 14px;
    }

    /* ── Hook event activity strip ── */
    .cp-hook-strip {
      flex-shrink: 0; padding: 4px 10px; gap: 8px;
      display: flex; align-items: center; overflow-x: auto;
      background: rgba(0,0,0,0.25); border-top: 1px solid rgba(255,255,255,0.04);
      font-family: 'JetBrains Mono', monospace;
      scrollbar-width: thin;
    }
    .cp-hook-strip-title {
      font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--t-faint); flex-shrink: 0;
    }
    .cp-hook-ev {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 6px; border-radius: 4px;
      background: rgba(255,255,255,0.04); font-size: 9.5px;
      color: var(--t-secondary); white-space: nowrap; flex-shrink: 0;
    }
    .cp-hook-dot { width: 5px; height: 5px; border-radius: 50%; background: rgba(100,180,255,0.7); }
    .cp-hook-name { color: var(--t-bright); font-weight: 600; }
    .cp-hook-detail { color: var(--t-faint); font-size: 9px; }

    /* ── Diff rendering (highlight +/- lines inside <pre><code class="language-diff">) ── */
    .cp-messages pre code.language-diff,
    .cp-messages pre code.lang-diff,
    .cp-messages pre code[class*="diff"] {
      display: block; white-space: pre;
    }
    .cp-messages pre:has(code[class*="diff"]) {
      background: rgba(0,0,0,0.4);
      border-color: rgba(140,160,200,0.15);
    }
    /* Highlight lines by first character using :has selector */
    .cp-messages pre code[class*="diff"] { counter-reset: line; }
    .cp-messages .cp-diff-add { display: inline-block; width: 100%; background: rgba(100,220,140,0.10); color: rgba(180,240,190,0.95); padding: 0 2px; border-left: 2px solid rgba(100,220,140,0.5); }
    .cp-messages .cp-diff-del { display: inline-block; width: 100%; background: rgba(255,100,80,0.08); color: rgba(255,180,160,0.95); padding: 0 2px; border-left: 2px solid rgba(255,100,80,0.5); }
    .cp-messages .cp-diff-hunk { color: rgba(100,180,255,0.8); font-weight: 600; }
    .cp-messages .cp-diff-file { color: rgba(255,210,60,0.85); font-weight: 600; }

    /* ── Cache-hit badge (in gauge label) ── */
    .cp-gauge-label .cp-cache-hit {
      display: inline-flex; align-items: center; gap: 2px;
      margin-left: 8px;
      color: rgba(150,200,220,0.55);
      font-family: 'JetBrains Mono', monospace;
      font-weight: 500;
      letter-spacing: 0.02em;
    }
    .cp-gauge-label .cp-cache-hit svg {
      width: 7px; height: 9px; flex-shrink: 0;
      opacity: 0.85;
    }
    /* Slightly brighter when the cache hit ratio is high — signal value without shouting */
    .cp-gauge-label .cp-cache-hit[data-ratio="high"] { color: rgba(170,215,230,0.75); }

    /* ── MCP collapse markers ── */
    .tool-mcp-badge {
      margin-left: 6px; padding: 1px 6px; border-radius: 4px;
      background: rgba(255,195,0,0.14); color: rgba(255,210,60,0.9);
      font-size: 9px; font-family: 'JetBrains Mono', monospace; font-weight: 600;
    }
    .tool-card.cp-mcp-collapsed { display: none; }

    /* ── View modes (Ctrl+O) ── */
    .cp-messages.cp-view-transcript .msg-body { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; }
    .cp-messages.cp-view-focus .msg { display: none; }
    .cp-messages.cp-view-focus .msg:nth-last-child(-n+3) { display: flex; }
    .cp-messages.cp-view-focus .msg-info-card { display: block; }

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
      box-shadow: var(--shadow-sm), 0 0 0 1px rgba(255,255,255,0.06);
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
      cursor: pointer; padding: 5px 10px; border-radius: 8px 0 0 8px;
      transition: background 0.15s, color 0.15s;
      max-width: 100%; overflow: hidden;
    }
    .cp-session-btn:hover { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.75); }
    .cp-session-btn .cp-session-label {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cp-session-btn .cp-dd-arrow {
      font-size: 9px; padding: 4px 6px; margin: -4px -6px -4px 0;
      border-radius: 0 6px 6px 0; cursor: pointer;
      transition: background 0.15s, color 0.2s, transform 0.2s;
    }
    .cp-session-btn .cp-dd-arrow:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.5); }
    .cp-header-rename-btn {
      display: flex; align-items: center; justify-content: center;
      width: 24px; align-self: stretch; border-radius: 0 8px 8px 0;
      border: none; border-left: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      color: rgba(255,255,255,0.4); cursor: pointer;
      transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1); position: relative;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
      flex-shrink: 0;
    }
    .cp-header-rename-btn:hover { color: rgba(100,160,255,0.95); background: rgba(100,160,255,0.14); }
    .cp-header-rename-btn:active { transform: scale(0.92); transition-duration: 0.06s; }
    .cp-header-rename-btn svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
    .cp-project-bar {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 10px 0;
      flex-shrink: 0;
    }
    .cp-bar-actions {
      display: flex; align-items: center; gap: 2px;
      margin-left: auto;
    }
    .cp-bar-action {
      display: flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      background: none; border: none; border-radius: 5px;
      color: rgba(255,255,255,0.3);
      cursor: pointer; transition: all 0.15s ease;
      padding: 0;
    }
    .cp-bar-action:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.06); }
    .cp-bar-action:active { transform: scale(0.9); transition-duration: 0.06s; }
    .cp-session-menu {
      display: none; position: absolute;
      top: calc(100% + 2px); left: 8px; right: 8px;
      background: rgba(12, 12, 14, 0.98);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px; padding: 4px;
      z-index: 310; max-height: 360px; overflow-y: auto;
      box-shadow: var(--shadow-lg);
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
    .cp-dna-btn {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 4px; color: rgba(255,255,255,0.4);
      font-size: 10px; font-family: 'JetBrains Mono', monospace;
      padding: 2px 6px; margin-left: 6px; cursor: pointer;
      transition: color 0.15s, background 0.15s;
      white-space: nowrap;
    }
    .cp-dna-btn:hover { color: rgba(255,180,80,0.9); background: rgba(255,180,80,0.08); border-color: rgba(255,180,80,0.3); }
    /* ── Name session modal ── */
    .cp-name-modal-overlay {
      position: absolute; inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
      display: flex; align-items: center; justify-content: center;
      z-index: 300; border-radius: 16px;
      animation: cp-name-fade 0.16s ease-out;
    }
    @keyframes cp-name-fade { from { opacity: 0; } to { opacity: 1; } }
    .cp-name-modal {
      background: rgba(24,26,30,0.98);
      border: 0.5px solid rgba(255,255,255,0.12);
      border-radius: 12px; padding: 18px 18px 14px;
      width: calc(100% - 48px); max-width: 380px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      display: flex; flex-direction: column; gap: 12px;
    }
    .cp-name-modal-row {
      display: flex; flex-direction: column; gap: 4px;
    }
    .cp-name-modal-label {
      font-size: 10px; opacity: 0.55;
      color: rgba(255,255,255,0.7);
      text-transform: uppercase; letter-spacing: 0.04em;
      font-family: 'JetBrains Mono', monospace;
    }
    .cp-name-modal-select {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; padding: 8px 10px;
      color: rgba(255,255,255,0.92);
      font: inherit; font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
      appearance: none; -webkit-appearance: none;
    }
    .cp-name-modal-select:focus {
      border-color: rgba(100,160,255,0.5);
      background: rgba(255,255,255,0.08);
    }
    .cp-name-modal-select:disabled {
      opacity: 0.5; cursor: not-allowed;
    }
    .cp-name-modal-title {
      color: rgba(255,255,255,0.9); font-size: 13px; font-weight: 500;
    }
    .cp-name-modal-input {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px; padding: 8px 10px;
      color: rgba(255,255,255,0.92);
      font: inherit; font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
    }
    .cp-name-modal-input:focus {
      border-color: rgba(100,160,255,0.5);
      background: rgba(255,255,255,0.08);
    }
    .cp-name-modal-actions {
      display: flex; justify-content: flex-end; gap: 8px;
    }
    .cp-name-modal-btn {
      padding: 6px 14px; border-radius: 6px;
      font: inherit; font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
      border: 1px solid transparent;
    }
    .cp-name-modal-btn.skip {
      background: transparent;
      color: rgba(255,255,255,0.5);
      border-color: rgba(255,255,255,0.1);
    }
    .cp-name-modal-btn.skip:hover {
      color: rgba(255,255,255,0.85);
      background: rgba(255,255,255,0.04);
    }
    .cp-name-modal-btn.save {
      background: rgba(100,160,255,0.18);
      border-color: rgba(100,160,255,0.35);
      color: rgba(160,200,255,0.95);
    }
    .cp-name-modal-btn.save:hover {
      background: rgba(100,160,255,0.28);
    }
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

    /* ── Session menu search & filters ── */
    .cp-sess-search {
      position: sticky; top: 0; z-index: 2;
      background: rgba(12, 12, 14, 0.98);
      padding: 6px 6px 0; display: flex; flex-direction: column; gap: 4px;
    }
    .cp-sess-search-row {
      display: flex; align-items: center; gap: 4px;
    }
    .cp-sess-search-input {
      flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px; color: rgba(255,255,255,0.8); font-size: 10px;
      font-family: 'JetBrains Mono', monospace; padding: 5px 8px 5px 26px;
      outline: none; transition: border-color 0.15s;
    }
    .cp-sess-search-input::placeholder { color: rgba(255,255,255,0.2); }
    .cp-sess-search-input:focus { border-color: rgba(100,160,255,0.35); }
    .cp-sess-search-icon {
      position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
      width: 12px; height: 12px; color: rgba(255,255,255,0.2); pointer-events: none;
    }
    .cp-sess-search-wrap { position: relative; flex: 1; display: flex; align-items: center; }
    .cp-sess-refresh-btn {
      background: none; border: none; cursor: pointer; padding: 4px;
      color: rgba(255,255,255,0.2); transition: color 0.15s, transform 0.3s;
      display: flex; align-items: center; justify-content: center;
    }
    .cp-sess-refresh-btn:hover { color: rgba(255,255,255,0.5); }
    .cp-sess-refresh-btn.spinning { animation: cp-sess-spin 0.6s linear; }
    @keyframes cp-sess-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .cp-sess-filters {
      display: flex; align-items: center; gap: 4px; padding: 0 2px 4px;
      flex-wrap: wrap;
    }
    .cp-sess-filter-pill {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px; color: rgba(255,255,255,0.3); font-size: 9px;
      font-family: 'JetBrains Mono', monospace; padding: 2px 6px;
      cursor: pointer; transition: all 0.12s; user-select: none;
      white-space: nowrap;
    }
    .cp-sess-filter-pill:hover { color: rgba(255,255,255,0.5); border-color: rgba(255,255,255,0.1); }
    .cp-sess-filter-pill.active {
      background: rgba(100,160,255,0.12); border-color: rgba(100,160,255,0.25);
      color: rgba(100,160,255,0.8);
    }
    .cp-sess-branch-select {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px; color: rgba(255,255,255,0.3); font-size: 9px;
      font-family: 'JetBrains Mono', monospace; padding: 2px 4px;
      cursor: pointer; outline: none; max-width: 120px;
    }
    .cp-sess-branch-select:focus { border-color: rgba(100,160,255,0.3); }
    .cp-sess-branch-select option { background: #1a1a1e; color: rgba(255,255,255,0.7); }

    /* ── Archive button on session items ── */
    .cp-sess-archive-btn {
      display: none; position: absolute; right: 24px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(255,255,255,0.15); font-size: 10px; transition: color 0.15s;
    }
    .cp-sess-item:hover .cp-sess-archive-btn { display: block; }
    .cp-sess-archive-btn:hover { color: rgba(255,180,50,0.7); }
    .cp-sess-item--archived {
      opacity: 0.35;
    }
    .cp-sess-item--archived .cp-sess-prompt { font-style: italic; }
    .cp-sess-unarchive-btn {
      display: none; position: absolute; right: 24px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; padding: 2px 4px;
      color: rgba(100,200,120,0.4); font-size: 10px; transition: color 0.15s;
    }
    .cp-sess-item--archived:hover .cp-sess-unarchive-btn { display: block; }
    .cp-sess-unarchive-btn:hover { color: rgba(100,200,120,0.8); }

    /* ── Infinite scroll sentinel ── */
    .cp-sess-sentinel {
      display: flex; align-items: center; justify-content: center;
      padding: 8px; min-height: 24px;
    }
    .cp-sess-sentinel-spinner {
      width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.06);
      border-top-color: rgba(100,160,255,0.4); border-radius: 50%;
      animation: cp-sess-spin 0.6s linear infinite;
    }
    .cp-sess-no-more {
      font-size: 9px; color: rgba(255,255,255,0.12);
      font-family: 'JetBrains Mono', monospace;
      text-align: center; padding: 6px;
    }

    /* ── Claude session pills in shared tray ── */
    @property --cp-pill-angle {
      syntax: '<angle>';
      initial-value: 0deg;
      inherits: false;
    }
    .cp-session-pill {
      position: relative;
      overflow: hidden;
      border-color: transparent;
    }
    .cp-session-pill::before {
      content: '';
      position: absolute; inset: 0;
      border-radius: 8px;
      padding: 1px;
      pointer-events: none;
      background: conic-gradient(
        from var(--cp-pill-angle, 0deg),
        rgba(212,162,127,0.0) 0%,
        rgba(212,162,127,0.30) 25%,
        rgba(212,162,127,0.06) 50%,
        rgba(212,162,127,0.30) 75%,
        rgba(212,162,127,0.0) 100%
      );
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask-composite: exclude;
      animation: cp-pill-border-spin 3s linear infinite;
    }
    @keyframes cp-pill-border-spin {
      to { --cp-pill-angle: 360deg; }
    }
    .cp-session-pill:hover { border-color: transparent; }
    .cp-session-pill:hover::before {
      background: conic-gradient(
        from var(--cp-pill-angle, 0deg),
        rgba(212,162,127,0.0) 0%,
        rgba(212,162,127,0.45) 25%,
        rgba(212,162,127,0.10) 50%,
        rgba(212,162,127,0.45) 75%,
        rgba(212,162,127,0.0) 100%
      );
    }
    .cp-session-pill .term-minimized-pill-icon { color: rgba(212, 162, 127, 0.7); }
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
      border-radius: 50%; background: rgba(212, 162, 127, 0.95);
      box-shadow: 0 0 10px rgba(212, 162, 127, 0.55);
      margin-right: 5px; vertical-align: middle;
      animation: cp-pill-pulse 1.5s ease-in-out infinite;
    }
    @keyframes cp-pill-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }

    /* ── Context gauge bar ── */
    .cp-context-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px; flex-shrink: 0;
      margin: 6px 8px 0;
      background: rgba(22, 22, 26, 0.95);
      border-radius: 10px;
      z-index: 2;
      box-shadow: var(--shadow-sm), 0 0 0 1px rgba(255,255,255,0.06);
    }
    .cp-gauge {
      flex: 1; min-width: 0; height: 16px; border-radius: 6px;
      background: rgba(255,255,255,0.03);
      position: relative; overflow: hidden; cursor: default;
    }
    .cp-ctx-fill {
      position: absolute; left: 0; top: 0; bottom: 0;
      border-radius: 6px; width: 0%;
      background: rgba(232,224,220,0.18);
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1), background 0.5s;
    }
    .cp-gauge-label {
      position: absolute; left: 6px; right: 6px; top: 50%; transform: translateY(-50%);
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      color: rgba(255,255,255,0.35); white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      pointer-events: none;
    }
    .cp-compact-btn {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px; color: rgba(255,255,255,0.35); cursor: pointer;
      font-size: 9px; font-family: 'JetBrains Mono', monospace;
      letter-spacing: 0.05em; text-transform: uppercase;
      padding: 2px 8px; height: 22px;
      flex-shrink: 0; position: relative; overflow: hidden;
      transition: all 0.15s;
    }
    .cp-compact-btn:hover:not(:disabled) {
      color: rgba(255,255,255,0.65);
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.14);
      transform: scale(1.03);
    }
    .cp-compact-btn:active:not(:disabled) { transform: scale(0.96); }
    .cp-compact-btn:disabled { opacity: 0.4; cursor: not-allowed; }
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
    .cp-gauge.compacting { opacity: 0.6; }
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

    /* ── Queue tray ── */
    .cp-queue-tray {
      margin: 0 8px 4px;
      border-radius: 10px;
      background: rgba(255,255,255,0.03);
      border: 0.5px solid rgba(255,255,255,0.06);
      overflow: hidden;
    }
    .cp-queue-tray[hidden] { display: none; }
    .cp-queue-header {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 8px;
      cursor: pointer;
      user-select: none;
    }
    .cp-queue-title {
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.5px;
      color: rgba(255,255,255,0.5);
      flex: 1;
    }
    .cp-queue-count {
      font-size: 10px; font-weight: 700;
      color: rgba(120,180,255,0.9);
      background: rgba(120,180,255,0.12);
      padding: 1px 6px; border-radius: 8px;
      min-width: 16px; text-align: center;
      transition: color 0.2s, background 0.2s;
    }
    .cp-queue-count.pulse {
      animation: cp-queue-pulse 0.4s ease;
    }
    @keyframes cp-queue-pulse {
      0% { transform: scale(1); }
      50% { transform: scale(1.3); }
      100% { transform: scale(1); }
    }
    .cp-queue-tray.paused .cp-queue-count {
      color: rgba(255,180,60,0.9);
      background: rgba(255,180,60,0.12);
    }
    .cp-queue-actions { display: flex; gap: 2px; }
    .cp-queue-actions button {
      background: none; border: none; color: rgba(255,255,255,0.4);
      cursor: pointer; padding: 2px 4px; border-radius: 4px;
      transition: color 0.15s, background 0.15s;
    }
    .cp-queue-actions button:hover {
      color: rgba(255,255,255,0.8);
      background: rgba(255,255,255,0.06);
    }
    .cp-queue-expand {
      background: none; border: none; color: rgba(255,255,255,0.3);
      cursor: pointer; padding: 2px; transition: transform 0.2s;
    }
    .cp-queue-tray.expanded .cp-queue-expand { transform: rotate(180deg); }
    .cp-queue-pause.paused { color: rgba(255,180,60,0.9) !important; }

    /* Queue items container */
    .cp-queue-items {
      max-height: 0; overflow: hidden;
      transition: max-height 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      padding: 0 6px;
    }
    .cp-queue-tray.expanded .cp-queue-items {
      max-height: 200px; overflow-y: auto;
      padding-bottom: 6px;
    }

    /* Individual queue item */
    .cp-queue-item {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 6px;
      margin-top: 3px;
      background: rgba(255,255,255,0.03);
      border: 0.5px solid rgba(255,255,255,0.05);
      border-radius: 6px;
      font-size: 11px; color: rgba(255,255,255,0.7);
      cursor: grab;
      transition: background 0.15s, border-color 0.15s;
    }
    .cp-queue-item:hover {
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.1);
    }
    .cp-queue-item.dragging { opacity: 0.4; background: rgba(120,180,255,0.08); }
    .cp-queue-item.drag-over { border-color: rgba(120,180,255,0.4); border-style: dashed; }
    .cp-queue-item.sending {
      border-color: rgba(120,180,255,0.5);
      background: rgba(120,180,255,0.08);
    }
    .cp-queue-drag {
      color: rgba(255,255,255,0.2); cursor: grab;
      font-size: 10px; user-select: none; flex-shrink: 0;
    }
    .cp-queue-text {
      flex: 1; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; min-width: 0;
    }
    .cp-queue-text input {
      width: 100%; background: rgba(0,0,0,0.3);
      border: 1px solid rgba(120,180,255,0.3);
      border-radius: 4px; color: #fff; font-size: 11px;
      padding: 2px 4px; outline: none;
    }
    .cp-queue-edit, .cp-queue-remove {
      background: none; border: none;
      color: rgba(255,255,255,0.3); cursor: pointer;
      padding: 1px 3px; border-radius: 3px; flex-shrink: 0;
      font-size: 10px; transition: color 0.15s;
    }
    .cp-queue-edit:hover, .cp-queue-remove:hover { color: rgba(255,255,255,0.8); }
    .cp-queue-remove:hover { color: rgba(255,100,100,0.9) !important; }
    .cp-queue-attach-badge {
      font-size: 9px; color: rgba(120,180,255,0.7); flex-shrink: 0;
    }

    /* Queue send icon */
    .cp-send.queue-mode { }
    .cp-send.queue-mode svg { opacity: 0.9; }
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

// ── Model dropdown with default-model support ──
function ddPopulateModels(dd, items, selectedValue) {
  const menu = dd.querySelector('.cp-dd-menu');
  menu.innerHTML = '';
  const defModel = _getDefaultModel();
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'cp-dd-item cp-dd-model-item' + (item.value === selectedValue ? ' selected' : '');
    const label = document.createElement('span');
    label.className = 'cp-dd-model-label';
    label.textContent = item.label;
    el.appendChild(label);
    const star = document.createElement('span');
    star.className = 'cp-dd-model-star' + (item.value === defModel ? ' is-default' : '');
    star.innerHTML = '&#9733;';
    star.title = item.value === defModel ? 'Default model' : 'Set as default';
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      storage.setItem(STOR.defaultModel, item.value);
      // Update all stars in this menu
      menu.querySelectorAll('.cp-dd-model-star').forEach(s => {
        s.classList.remove('is-default');
        s.title = 'Set as default';
      });
      star.classList.add('is-default');
      star.title = 'Default model';
    });
    el.appendChild(star);
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

// ── Model helpers (composite value = "modelId:contextWindow") ──
// Claude Code CLI requires the `[1m]` suffix to switch to the 1M-token beta
// context window. Without it, the CLI silently defaults to 200K even when
// the selected model supports 1M — leaving the gauge denominator out of sync
// with the true window. We append the suffix here so every spawn site
// (WebSocket query, agent, loop, exec profile) gets a CLI-ready model id.
function _getModelId() {
  const $model = _panel?.querySelector('#cp-model');
  const raw = ddGetValue($model);
  const [id, cwRaw] = raw.split(':');
  if (!id) return '';
  const cw = cwRaw ? parseInt(cwRaw, 10) : 0;
  return cw > 200000 ? `${id}[1m]` : id;
}
function _getContextWindow() {
  const $model = _panel?.querySelector('#cp-model');
  const raw = ddGetValue($model);
  const parts = raw.split(':');
  return parts[1] ? parseInt(parts[1], 10) : 200000;
}

// ── Default model helper ──
function _getDefaultModel() {
  return storage.getItem(STOR.defaultModel) || '';
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
function createTab(sessionId = null, label = 'New chat', { autoSwitch = true, id = null } = {}) {
  if (_tabs.length >= MAX_TABS) return null;
  // Capture current dropdown state for the new tab's project/model/effort
  const _$proj = _panel?.querySelector('#cp-project');
  const _$mod = _panel?.querySelector('#cp-model');
  const _$think = _panel?.querySelector('#cp-think-toggle');
  const tab = {
    id: id || crypto.randomUUID(),
    sessionId,
    label,
    project: ddGetValue(_$proj) || '',       // per-tab project isolation
    model: _getDefaultModel(),                  // per-tab model — defaults to user's preferred model
    effort: _$think?.dataset.effort || 'off', // per-tab effort isolation
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
    pendingLabel: null,        // user-chosen label set before sessionId exists; applied when session starts
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0, // 0 = use dropdown fallback; set from result.modelUsage or session history
    compacting: false,
    turns: 0,
    thinkStartedAt: null,
    thinkTimerInterval: null,
    sendStartedAt: null,
    planMode: false,
    _permQueue: [],
    _activePerm: false,
    _msgBuffer: [],
    queue: [],
    queuePaused: false,
    queueExpanded: false,
    // ── CLI-parity additions ──
    promptHistory: [],        // string[] — prompts typed in this tab (Up/Down recall)
    promptHistoryIdx: -1,     // -1 means not navigating
    viewMode: 'normal',       // 'normal' | 'transcript' | 'focus' (Ctrl+O cycles)
    todos: [],                // current TodoWrite state for sticky widget
    todosVisible: false,
    hookEvents: [],           // recent synthetic hook events for activity strip
    hookStripVisible: false,  // Ctrl+Shift+H toggles
    lastEscAt: 0,             // for Esc+Esc undo detection
    _fileRefs: [],            // @file references captured in the current prompt
  };
  // Create messages div
  const container = _panel.querySelector('#cp-messages-container');
  const msgDiv = document.createElement('div');
  msgDiv.className = 'cp-messages';
  msgDiv.dataset.tabId = tab.id;
  msgDiv.style.display = 'none';
  msgDiv.innerHTML = `<div class="cp-empty"><div class="cp-empty-logo">${CLAUDE_ICON}</div><span class="cp-empty-name">Claude</span><span class="cp-empty-hint">Send a message to start</span></div>`;
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
    flushSessionSnapshotSave(prev);
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
      $send.classList.remove('abort'); $send.classList.remove('btw'); $send.classList.remove('queue-mode');
      $send.innerHTML = _ICON_SEND;
      $input.disabled = false;
      $send.disabled = !$input.value.trim() && !tab.attachedImages.length && !tab.attachedFiles.length;
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
  // Restore per-tab project/model/effort dropdowns (session isolation)
  const $project = _panel?.querySelector('#cp-project');
  const $model = _panel?.querySelector('#cp-model');
  const $think = _panel?.querySelector('#cp-think-toggle');
  if ($project && tab.project) {
    const items = _projects.map(p => ({ value: p.path, label: p.label || p.path.split(/[/\\]/).pop() }));
    ddPopulate($project, items, tab.project);
    loadBranches(tab.project);
  } else if ($project && !tab.project) {
    const items = _projects.map(p => ({ value: p.path, label: p.label || p.path.split(/[/\\]/).pop() }));
    ddPopulate($project, items, '');
  }
  if ($model) {
    const items = _models.map(m => ({ value: `${m.id}:${m.contextWindow || 200000}`, label: m.label }));
    const modelVal = tab.model || _getDefaultModel();
    ddPopulateModels($model, items, modelVal);
    if (modelVal && !tab.model) { tab.model = modelVal; saveTabs(); }
  }
  if ($think && tab.effort) _setEffort($think, tab.effort);
  // Sync plan toggle
  const $plan = _panel?.querySelector('#cp-plan-toggle');
  if ($plan) $plan.classList.toggle('active', tab.planMode);
  // Sync context gauge
  renderGauge(tab);
  renderPills();
  renderQueue(tab);
  renderTodoWidget(tab);
  renderHookStrip(tab);
  _applyViewMode(tab);
  _setCompactingUI(!!tab.compacting);
  populateViewDropdown(_panel?.querySelector('#cp-view'), tab);
  saveTabs();
}

function closeTab(idx) {
  if (idx < 0 || idx >= _tabs.length) return;
  const tab = _tabs[idx];
  flushSessionSnapshotSave(tab);
  recordHookEvent(tab, 'SessionEnd', tab.sessionId || '(new)');
  tab.closed = true;
  clearTimeout(tab.reconnectTimer);
  finishTab(tab, true);
  if (tab.ws) tab.ws.close();
  // Release session lock
  if (tab.sessionId) _releaseSessionLock(tab.sessionId);
  tab.messagesEl.remove();
  if (tab.pillEl) tab.pillEl.remove();
  _tabs.splice(idx, 1);
  if (_tabs.length === 0) {
    _activeTabIdx = -1;
    saveTabs();
    renderPills();
    toggleClaudePanel();
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

const _CP_ICON_SVG = CLAUDE_ICON;

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
      tabs: _tabs.map(t => ({ id: t.id, sessionId: t.sessionId, label: t.label, sessionCost: t.sessionCost || 0, running: t.running || false, project: t.project || '', model: t.model || '', effort: t.effort || 'off', planMode: t.planMode || false, planFilePath: t.planFilePath || '', queue: t.queue || [], queuePaused: t.queuePaused || false })),
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
    const reg = raw ? JSON.parse(raw) : {};
    const STALE_MS = 24 * 60 * 60 * 1000; // 24h
    const now = Date.now();
    for (const [wid, ts] of Object.entries(reg)) {
      if (wid === _windowId) continue;
      if (now - ts > STALE_MS) {
        storage.removeItem(`synabun-claude-panel-tabs-${wid}`);
        delete reg[wid];
      }
    }
    // Sweep unregistered tab keys (legacy entries from before the registry,
    // or windowIds that lost their registry entry somehow). These have no
    // timestamp and no in-flight client — safe to drop.
    for (const k of (storage.keys?.() || [])) {
      if (!k.startsWith('synabun-claude-panel-tabs-')) continue;
      const wid = k.slice('synabun-claude-panel-tabs-'.length);
      if (wid === _windowId) continue;
      if (!(wid in reg)) storage.removeItem(k);
    }
    storage.setItem(STOR.windowRegistry, JSON.stringify(reg));
  } catch {}
}

// Run GC + register current window at module load so stale keys get pruned
// even if the user never opens the Claude panel this session.
_cleanStaleWindows();
_updateWindowRegistry();

function restoreTabs() {
  _cleanStaleWindows();
  // Try window-scoped tabs first
  try {
    const raw = storage.getItem(STOR.tabs);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.tabs?.length) {
        for (const saved of data.tabs) {
          const t = createTab(saved.sessionId, saved.label, { autoSwitch: false, id: saved.id });
          if (t && saved.sessionCost) t.sessionCost = saved.sessionCost;
          if (t && saved.running) t._wasRunning = true; // trigger reattach on WS open
          if (t && saved.project) t.project = saved.project;
          if (t) t.model = saved.model || _getDefaultModel();
          if (t && saved.effort) t.effort = saved.effort;
          if (t && saved.planMode) t.planMode = true;
          if (t && saved.planFilePath) t.planFilePath = saved.planFilePath;
          if (t && saved.queue?.length) t.queue = saved.queue;
          if (t && saved.queuePaused) t.queuePaused = true;
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
          const t = createTab(saved.sessionId, saved.label, { autoSwitch: false, id: saved.id });
          if (t && saved.sessionCost) t.sessionCost = saved.sessionCost;
          if (t && saved.running) t._wasRunning = true;
          if (t && saved.project) t.project = saved.project;
          if (t) t.model = saved.model || _getDefaultModel();
          if (t && saved.effort) t.effort = saved.effort;
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
  flushAllSessionSnapshots();
  _stopHeartbeat();
  // Use sendBeacon for reliable delivery on close
  navigator.sendBeacon(
    '/api/claude-skin/session-lock',
    new Blob([JSON.stringify({ action: 'release', windowId: _windowId })], { type: 'application/json' })
  );
});

window.addEventListener('pagehide', flushAllSessionSnapshots);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushAllSessionSnapshots();
});

// Re-sync UI state when window regains focus (catches stale running states from background tabs)
window.addEventListener('focus', () => {
  if (!_panel) return;
  const tab = activeTab();
  if (!tab) return;
  // If tab says it's running but WS is dead, force finish
  if (tab.running && (!tab.ws || tab.ws.readyState > WebSocket.OPEN)) {
    console.warn('[claude-panel] Focus re-sync: tab running but WS dead — forcing finish');
    finishTab(tab, true);
    appendStatus(tab, 'Connection lost — session recovered.');
    notify('panel', NOTIF_TYPE.ERROR, tab.label || 'Claude Code', { tabId: tab.id });
  }
  // Re-sync input disabled state with current tab
  const $input = _panel?.querySelector('#cp-input');
  const $send = _panel?.querySelector('#cp-send');
  if ($input && $send) {
    $input.disabled = tab.running;
    if (!tab.running) {
      $send.classList.remove('abort');
      $send.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
      $send.disabled = !$input.value.trim() && !tab.attachedImages.length && !tab.attachedFiles.length;
    }
  }
});

// ── Session selector helpers ──
const LABEL_PREFIX = 'synabun-session-label:';
const ARCHIVE_PREFIX = 'synabun-session-archived:';
function getLabel(id) { try { return storage.getItem(LABEL_PREFIX + id) || ''; } catch { return ''; } }
function isArchived(id) { try { return storage.getItem(ARCHIVE_PREFIX + id) === '1'; } catch { return false; } }
function setArchived(id, val) { try { if (val) storage.setItem(ARCHIVE_PREFIX + id, '1'); else storage.removeItem(ARCHIVE_PREFIX + id); } catch {} }
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
function fmtDate(d) { if (!d) return ''; const dt = new Date(d); if (isNaN(dt)) return ''; return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' at ' + dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Session menu state ──
let _cpSessSearch = '';
let _cpSessDebounce = null;
let _cpSessOffset = 0;
let _cpSessSessions = [];   // accumulated sessions (flat, with projectPath)
let _cpSessTotal = 0;
let _cpSessLoading = false;
let _cpSessBranch = '';      // '' = all
let _cpSessHideEmpty = false;
let _cpSessShowArchived = false;
let _cpSessObserver = null;
let _cpSessProject = '';     // current project filter
const CP_SESS_PAGE = 20;

function cpSessApplyFilters(sessions) {
  return sessions.filter(s => {
    if (s.deleted) return false;
    if (!_cpSessShowArchived && isArchived(s.sessionId)) return false;
    if (_cpSessHideEmpty && s.messageCount === 0 && !getLabel(s.sessionId)) return false;
    if (_cpSessBranch && (s.gitBranch || '') !== _cpSessBranch) return false;
    // Client-side label search (server already filtered firstPrompt/branch/sessionId)
    if (_cpSessSearch) {
      const q = _cpSessSearch.toLowerCase();
      const label = getLabel(s.sessionId).toLowerCase();
      if (label && label.includes(q)) return true;
      // Server already matched on firstPrompt/branch/sessionId, so keep it
    }
    return true;
  });
}

function cpSessCollectBranches(sessions) {
  const set = new Set();
  for (const s of sessions) { if (s.gitBranch) set.add(s.gitBranch); }
  return [...set].sort();
}

function cpSessRenderItem(s, projectPath, menu) {
  const label = getLabel(s.sessionId) || cleanPrompt(s.firstPrompt) || 'Empty session';
  const active = s.sessionId === activeTab()?.sessionId ? ' active' : '';
  const archived = isArchived(s.sessionId);
  const archivedClass = archived ? ' cp-sess-item--archived' : '';

  const item = document.createElement('div');
  item.className = `cp-sess-item${active}${archivedClass}`;
  item.dataset.sid = s.sessionId;
  item.dataset.cwd = projectPath;

  // Tooltip: full title + date, positioned left of the dropdown
  if (label && label !== 'Empty session') {
    const dateStr = fmtDate(s.modified || s.created);
    item.setAttribute('data-tooltip', dateStr ? label + '\n' + dateStr : label);
    item.setAttribute('data-tooltip-pos', 'left');
  }

  let metaHtml = `<span>${relDate(s.modified || s.created)}</span>`;
  if (s.gitBranch) metaHtml += `<span class="cp-sess-branch">${escH(s.gitBranch)}</span>`;
  if (s.messageCount) metaHtml += `<span>${s.messageCount} msgs</span>`;

  const archiveBtn = archived
    ? `<button class="cp-sess-unarchive-btn" data-sid="${escH(s.sessionId)}" title="Unarchive">&#x21A9;</button>`
    : `<button class="cp-sess-archive-btn" data-sid="${escH(s.sessionId)}" title="Archive">&#x2716;</button>`;

  item.innerHTML = `
    <div class="cp-sess-prompt">${escH(trunc(label, 60))}</div>
    ${archiveBtn}
    <button class="cp-sess-rename" data-sid="${escH(s.sessionId)}" title="Rename">&#x270E;</button>
    <div class="cp-sess-meta">${metaHtml}</div>
  `;

  // Click to resume
  item.addEventListener('click', () => {
    if (item.querySelector('.cp-rename-input')) return;
    if (s.deleted) return;
    const sid = item.dataset.sid;
    const clickLabel = item.querySelector('.cp-sess-prompt')?.textContent || 'Resumed';
    selectSession(sid, clickLabel);
    const $project = _panel?.querySelector('#cp-project');
    if ($project && item.dataset.cwd) {
      ddPopulate($project, _projects.map(p => ({ value: p.path, label: p.label || p.path.split(/[/\\]/).pop() })), item.dataset.cwd);
      storage.setItem(STOR.project, item.dataset.cwd);
      const tab = activeTab();
      if (tab) { tab.project = item.dataset.cwd; saveTabs(); }
    }
    menu.classList.remove('open');
  });

  // Archive / unarchive
  const archBtn = item.querySelector('.cp-sess-archive-btn, .cp-sess-unarchive-btn');
  archBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setArchived(s.sessionId, !archived);
    item.remove();
  });

  // Rename
  const renBtn = item.querySelector('.cp-sess-rename');
  renBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const sid = renBtn.dataset.sid;
    const promptEl = item.querySelector('.cp-sess-prompt');
    if (!promptEl) return;
    const currentName = getLabel(sid) || promptEl.textContent;
    const input = document.createElement('input');
    input.type = 'text'; input.value = currentName;
    input.className = 'cp-rename-input';
    input.placeholder = 'Session name...';
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    promptEl.textContent = '';
    promptEl.appendChild(input);
    renBtn.style.display = 'none';
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
      renBtn.style.display = '';
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

  return item;
}

function cpSessRenderItems(sessions, listEl, menu) {
  let lastGroup = '';
  for (const s of sessions) {
    const group = timeGroup(s.modified || s.created);
    if (group !== lastGroup) {
      lastGroup = group;
      const groupEl = document.createElement('div');
      groupEl.className = 'cp-sess-group';
      groupEl.textContent = group;
      listEl.appendChild(groupEl);
    }
    listEl.appendChild(cpSessRenderItem(s, s._projectPath, menu));
  }
}

async function cpSessLoadBatch(menu, listEl, refresh = false) {
  if (_cpSessLoading) return;
  _cpSessLoading = true;
  const sentinel = menu.querySelector('.cp-sess-sentinel');
  if (sentinel) sentinel.innerHTML = '<div class="cp-sess-sentinel-spinner"></div>';

  try {
    const opts = { limit: CP_SESS_PAGE, offset: _cpSessOffset, project: _cpSessProject || undefined };
    if (_cpSessSearch) opts.search = _cpSessSearch;
    if (refresh) opts.refresh = true;
    // Full-body hybrid (FTS5 + semantic) search when user types a query —
    // falls back to fetchClaudeSessions for the plain paginated list.
    let data;
    if (_cpSessSearch && _cpSessSearch.trim().length >= 2 && _cpSessOffset === 0) {
      data = await searchSessions({
        q: _cpSessSearch,
        provider: 'claude-code',
        project: _cpSessProject || undefined,
        limit: 100,
      });
    } else {
      data = await fetchClaudeSessions(opts);
    }
    const proj = data?.projects?.[0];
    if (!proj) {
      if (_cpSessOffset === 0 && listEl) listEl.innerHTML = '<div class="cp-sess-loading">no sessions found</div>';
      if (sentinel) sentinel.remove();
      _cpSessLoading = false;
      return;
    }

    _cpSessTotal = proj.total || 0;
    const newSessions = (proj.sessions || []).map(s => ({ ...s, _projectPath: proj.path }));
    _cpSessSessions.push(...newSessions);
    _cpSessOffset += newSessions.length;

    // Collect branches for filter (from all loaded sessions)
    const branches = cpSessCollectBranches(_cpSessSessions);
    const branchSelect = menu.querySelector('.cp-sess-branch-select');
    if (branchSelect) {
      const prevVal = branchSelect.value;
      branchSelect.innerHTML = '<option value="">All branches</option>';
      for (const b of branches) {
        branchSelect.innerHTML += `<option value="${escH(b)}">${escH(b)}</option>`;
      }
      branchSelect.value = prevVal;
      branchSelect.style.display = branches.length ? '' : 'none';
    }

    const filtered = cpSessApplyFilters(newSessions);
    cpSessRenderItems(filtered, listEl, menu);

    // Update sentinel
    if (_cpSessOffset >= _cpSessTotal) {
      if (sentinel) sentinel.innerHTML = _cpSessSessions.length > CP_SESS_PAGE
        ? '<div class="cp-sess-no-more">all sessions loaded</div>' : '';
    } else if (sentinel) {
      sentinel.innerHTML = '';
    }
  } catch (err) {
    console.error('[cp-sess] Load failed:', err);
    if (sentinel) sentinel.innerHTML = '<div class="cp-sess-no-more">failed to load</div>';
  }
  _cpSessLoading = false;
}

async function renderSessionMenu() {
  const menu = _panel?.querySelector('#cp-session-menu');
  if (!menu) return;

  // Determine current project
  const $project = _panel?.querySelector('#cp-project');
  _cpSessProject = ddGetValue($project) || '';

  // Reset pagination state
  _cpSessOffset = 0;
  _cpSessSessions = [];
  _cpSessTotal = 0;

  // Disconnect old observer
  if (_cpSessObserver) { _cpSessObserver.disconnect(); _cpSessObserver = null; }

  // Build skeleton: search + filters + new chat + list + sentinel
  menu.innerHTML = '';

  // ── Search bar ──
  const searchEl = document.createElement('div');
  searchEl.className = 'cp-sess-search';
  searchEl.innerHTML = `
    <div class="cp-sess-search-row">
      <div class="cp-sess-search-wrap">
        <svg class="cp-sess-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" class="cp-sess-search-input" placeholder="Search sessions..." value="${escH(_cpSessSearch)}" autocomplete="off" spellcheck="false">
      </div>
      <button class="cp-sess-refresh-btn" title="Refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
      </button>
    </div>
    <div class="cp-sess-filters">
      <select class="cp-sess-branch-select" style="display:none"><option value="">All branches</option></select>
      <div class="cp-sess-filter-pill${_cpSessHideEmpty ? ' active' : ''}" data-filter="empty">Hide empty</div>
      <div class="cp-sess-filter-pill${_cpSessShowArchived ? ' active' : ''}" data-filter="archived">Archived</div>
    </div>
  `;
  menu.appendChild(searchEl);

  // ── New chat button ──
  const newBtn = document.createElement('div');
  newBtn.className = 'cp-sess-new';
  newBtn.textContent = '+ New chat';
  newBtn.addEventListener('click', () => { selectSession(null, 'New chat'); menu.classList.remove('open'); });
  menu.appendChild(newBtn);

  // ── Session list ──
  const listEl = document.createElement('div');
  listEl.className = 'cp-sess-list';
  menu.appendChild(listEl);

  // ── Sentinel for infinite scroll ──
  const sentinel = document.createElement('div');
  sentinel.className = 'cp-sess-sentinel';
  sentinel.innerHTML = '<div class="cp-sess-sentinel-spinner"></div>';
  menu.appendChild(sentinel);

  // ── Wire search ──
  const searchInput = searchEl.querySelector('.cp-sess-search-input');
  searchInput.addEventListener('input', () => {
    clearTimeout(_cpSessDebounce);
    _cpSessDebounce = setTimeout(() => {
      _cpSessSearch = searchInput.value.trim();
      _cpSessOffset = 0;
      _cpSessSessions = [];
      listEl.innerHTML = '';
      sentinel.innerHTML = '<div class="cp-sess-sentinel-spinner"></div>';
      cpSessLoadBatch(menu, listEl);
    }, 300);
  });
  searchInput.addEventListener('click', (e) => e.stopPropagation());
  searchInput.addEventListener('keydown', (e) => e.stopPropagation());
  requestAnimationFrame(() => searchInput.focus());

  // ── Wire refresh ──
  const refreshBtn = searchEl.querySelector('.cp-sess-refresh-btn');
  refreshBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    refreshBtn.classList.add('spinning');
    _cpSessOffset = 0;
    _cpSessSessions = [];
    listEl.innerHTML = '';
    sentinel.innerHTML = '<div class="cp-sess-sentinel-spinner"></div>';
    await cpSessLoadBatch(menu, listEl, true);
    refreshBtn.classList.remove('spinning');
  });

  // ── Wire filters ──
  const branchSelect = searchEl.querySelector('.cp-sess-branch-select');
  branchSelect.addEventListener('change', () => {
    _cpSessBranch = branchSelect.value;
    // Re-render from accumulated sessions (client-side filter)
    listEl.innerHTML = '';
    const filtered = cpSessApplyFilters(_cpSessSessions);
    cpSessRenderItems(filtered, listEl, menu);
  });
  branchSelect.addEventListener('click', (e) => e.stopPropagation());

  searchEl.querySelectorAll('.cp-sess-filter-pill').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const filter = pill.dataset.filter;
      if (filter === 'empty') {
        _cpSessHideEmpty = !_cpSessHideEmpty;
        pill.classList.toggle('active', _cpSessHideEmpty);
      } else if (filter === 'archived') {
        _cpSessShowArchived = !_cpSessShowArchived;
        pill.classList.toggle('active', _cpSessShowArchived);
      }
      // Re-render from accumulated sessions
      listEl.innerHTML = '';
      const filtered = cpSessApplyFilters(_cpSessSessions);
      cpSessRenderItems(filtered, listEl, menu);
    });
  });

  // ── Load first batch ──
  await cpSessLoadBatch(menu, listEl);

  // ── Setup IntersectionObserver for infinite scroll ──
  _cpSessObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !_cpSessLoading && _cpSessOffset < _cpSessTotal) {
        cpSessLoadBatch(menu, listEl);
      }
    }
  }, { root: menu, threshold: 0.1 });
  _cpSessObserver.observe(sentinel);
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
  tab.contextWindow = 0;
  tab.compacting = false;
  _setCompactingUI(false);
  tab.turns = 0;
  _updateCostLabel();
  renderGauge(tab);
  updatePillLabel(tab);
  const btn = _panel?.querySelector('.cp-session-label');
  if (btn) btn.textContent = tab.label;
  tab.messagesEl.innerHTML = `<div class="cp-empty"><div class="cp-empty-logo">${CLAUDE_ICON}</div><span class="cp-empty-name">Claude</span><span class="cp-empty-hint">Send a message to start</span></div>`;
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
  // Prevent clicks on input from bubbling to session button (which toggles menu)
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
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
    const tab = activeTab();
    const effectiveSid = sid || tab?.sessionId;
    if (val) {
      if (effectiveSid) storage.setItem(LABEL_PREFIX + effectiveSid, val);
      else if (tab) tab.pendingLabel = val;
      btn.textContent = val;
    } else {
      if (effectiveSid) storage.removeItem(LABEL_PREFIX + effectiveSid);
      else if (tab) tab.pendingLabel = null;
      btn.textContent = effectiveSid ? (getLabel(effectiveSid) || effectiveSid.slice(0, 8) + '...') : 'New chat';
    }
    if (tab) {
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

function promptNameNewSession() {
  if (!_panel) return;
  if (_panel.querySelector('.cp-name-modal-overlay')) return;
  const tab = activeTab();
  if (!tab) return;

  const projectOptions = (_projects || []).map(p => {
    const path = p?.path || p || '';
    const name = typeof path === 'string' ? (path.split(/[\\/]/).pop() || path) : '';
    return { path, name };
  }).filter(p => p.path);

  const overlay = document.createElement('div');
  overlay.className = 'cp-name-modal-overlay';
  overlay.innerHTML = `
    <div class="cp-name-modal" role="dialog" aria-modal="true">
      <div class="cp-name-modal-title">Name this session</div>
      <div class="cp-name-modal-row">
        <label class="cp-name-modal-label">Project</label>
        <select class="cp-name-modal-select" data-role="project">
          ${projectOptions.map(p => `<option value="${p.path.replace(/"/g, '&quot;')}">${p.name}</option>`).join('')}
        </select>
      </div>
      <div class="cp-name-modal-row">
        <label class="cp-name-modal-label">Branch</label>
        <select class="cp-name-modal-select" data-role="branch" disabled>
          <option value="">(loading...)</option>
        </select>
      </div>
      <input type="text" class="cp-name-modal-input" placeholder="Session name..." maxlength="120" />
      <div class="cp-name-modal-actions">
        <button type="button" class="cp-name-modal-btn skip">Skip</button>
        <button type="button" class="cp-name-modal-btn save">Save</button>
      </div>
    </div>
  `;
  _panel.appendChild(overlay);

  const input = overlay.querySelector('.cp-name-modal-input');
  const saveBtn = overlay.querySelector('.cp-name-modal-btn.save');
  const skipBtn = overlay.querySelector('.cp-name-modal-btn.skip');
  const projectSel = overlay.querySelector('select[data-role="project"]');
  const branchSel = overlay.querySelector('select[data-role="branch"]');
  const labelEl = _panel.querySelector('.cp-session-label');

  const initialProject = tab.project || storage.getItem(STOR.project) || '';
  if (projectSel && initialProject) projectSel.value = initialProject;

  let branchOriginal = null;
  async function fetchBranchesForModal(path) {
    if (!path) return { branches: [], current: null };
    try {
      const res = await fetch(`/api/terminal/branches?path=${encodeURIComponent(path)}`);
      return await res.json();
    } catch { return { branches: [], current: null }; }
  }
  async function refreshBranches(path) {
    branchSel.disabled = true;
    branchSel.innerHTML = '<option value="">(loading...)</option>';
    const data = await fetchBranchesForModal(path);
    branchOriginal = data.current || null;
    const branches = data.branches || [];
    if (!branches.length) {
      branchSel.innerHTML = '<option value="">(none)</option>';
      branchSel.disabled = true;
    } else {
      branchSel.innerHTML = branches.map(b => `<option value="${b.replace(/"/g, '&quot;')}">${b}</option>`).join('');
      if (branchOriginal) branchSel.value = branchOriginal;
      branchSel.disabled = false;
    }
  }
  refreshBranches(projectSel?.value || initialProject);

  projectSel?.addEventListener('change', () => refreshBranches(projectSel.value));

  setTimeout(() => { input.focus(); input.select(); }, 10);

  let done = false;
  const close = () => { if (!done) { done = true; overlay.remove(); } };

  const commit = async (cancel) => {
    if (done) return;
    const val = input.value.trim();
    const chosenProject = projectSel?.value || '';
    const chosenBranch = branchSel?.value || '';
    close();
    if (cancel) return;

    const t = activeTab();

    if (t && chosenProject && chosenProject !== (t.project || '')) {
      t.project = chosenProject;
      storage.setItem(STOR.project, chosenProject);
      saveTabs();
      const $project = _panel?.querySelector('#cp-project');
      if ($project) {
        const items = (_projects || []).map(p => ({ value: p.path || p, label: (p.label || (p.path || p).split(/[\\/]/).pop()) }));
        ddPopulate($project, items, chosenProject);
      }
      loadBranches(chosenProject);
    }

    if (chosenProject && chosenBranch && branchOriginal && chosenBranch !== branchOriginal) {
      try {
        await fetch('/api/terminal/checkout', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: chosenProject, branch: chosenBranch }),
        });
        loadBranches(chosenProject);
      } catch (err) {
        console.error('[claude-panel] checkout failed:', err);
      }
    }

    if (!val) return;
    const sid = t?.sessionId;
    if (sid) storage.setItem(LABEL_PREFIX + sid, val);
    else if (t) t.pendingLabel = val;
    if (labelEl) labelEl.textContent = val;
    if (t) { t.label = val; updatePillLabel(t); saveTabs(); }
  };

  saveBtn.addEventListener('click', () => commit(false));
  skipBtn.addEventListener('click', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(false); }
    if (e.key === 'Escape') { e.preventDefault(); commit(true); }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) commit(true);
  });
}

// ── Session HTML snapshot helpers ──
function _normalizeSnapshotEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const html = typeof entry.html === 'string' ? entry.html : '';
  if (!html) return null;
  return {
    html,
    updatedAt: Number(entry.updatedAt) || 0,
    label: typeof entry.label === 'string' ? entry.label : '',
    usage: (entry.usage && typeof entry.usage === 'object') ? entry.usage : null,
    contextWindow: Number(entry.contextWindow) || 0,
    turns: Number(entry.turns) || 0,
    sessionCost: Number(entry.sessionCost) || 0,
    itemCount: Number(entry.itemCount) || 0,
  };
}

function _persistSessionSnapshots() {
  try {
    const source = (_sessionSnapshots && typeof _sessionSnapshots === 'object' && !Array.isArray(_sessionSnapshots))
      ? _sessionSnapshots : {};
    const entries = Object.entries(source)
      .map(([sid, e]) => [sid, _normalizeSnapshotEntry(e)])
      .filter(([, e]) => !!e)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const next = {};
    let totalChars = 0;
    for (const [sid, entry] of entries) {
      const size = entry.html.length;
      if (Object.keys(next).length >= MAX_SESSION_SNAPSHOTS) break;
      if (totalChars + size > MAX_SESSION_SNAPSHOT_CHARS && Object.keys(next).length) continue;
      totalChars += size;
      next[sid] = entry;
    }
    _sessionSnapshots = next;
    storage.setItem(STOR.sessionSnapshots, JSON.stringify(next));
  } catch {}
}

function getSessionSnapshot(sid) {
  if (!sid) return null;
  return _normalizeSnapshotEntry(_sessionSnapshots?.[sid]);
}

function writeSessionSnapshot(tab) {
  const sid = tab?.sessionId || null;
  const $msgs = tab?.messagesEl || null;
  if (!sid || !$msgs) return;
  const html = $msgs.innerHTML || '';
  if (!html.trim()) return;
  // Skip snapshot if the transcript only contains the empty-state placeholder
  if ($msgs.children.length === 1 && $msgs.firstElementChild?.classList?.contains('cp-empty')) return;
  if (!_sessionSnapshots || typeof _sessionSnapshots !== 'object' || Array.isArray(_sessionSnapshots)) {
    _sessionSnapshots = {};
  }
  const itemCount = [...$msgs.children].filter(n =>
    !n.classList?.contains('cp-empty') && !n.classList?.contains('thinking')
  ).length;
  _sessionSnapshots[sid] = {
    html,
    updatedAt: Date.now(),
    label: tab.label || '',
    usage: tab.usage ? { ...tab.usage } : null,
    contextWindow: tab.contextWindow || 0,
    turns: tab.turns || 0,
    sessionCost: tab.sessionCost || 0,
    itemCount,
  };
  _persistSessionSnapshots();
}

function scheduleSessionSnapshotSave(tab, ms = 350) {
  if (!tab?.sessionId || !tab?.messagesEl) return;
  if (tab._snapshotTimer) clearTimeout(tab._snapshotTimer);
  tab._snapshotTimer = setTimeout(() => {
    tab._snapshotTimer = null;
    writeSessionSnapshot(tab);
  }, ms);
}

function flushSessionSnapshotSave(tab) {
  if (!tab) return;
  if (tab._snapshotTimer) { clearTimeout(tab._snapshotTimer); tab._snapshotTimer = null; }
  writeSessionSnapshot(tab);
}

function flushAllSessionSnapshots() {
  for (const tab of _tabs) flushSessionSnapshotSave(tab);
}

function renderStoredSession(snapshot, $msgs, tab) {
  const norm = _normalizeSnapshotEntry(snapshot);
  if (!norm || !$msgs) return false;
  $msgs.innerHTML = norm.html;
  // Disable interactive controls — restored DOM has no event handlers and
  // any pending state (permission prompts, plan cards, ask cards) is stale.
  $msgs.querySelectorAll('button, input, select, textarea').forEach(node => { node.disabled = true; });
  // Drop transient overlays that should never resurrect after a fresh load
  $msgs.querySelectorAll('.thinking, .msg-permission-prompt, .post-plan-card').forEach(n => n.remove());
  // Re-attach copy buttons + file path links — innerHTML wipes their listeners
  $msgs.querySelectorAll('pre .cp-copy-btn').forEach(btn => btn.remove());
  addCopyButtons($msgs);
  linkifyFilePaths($msgs);
  if (tab) {
    if (norm.usage) {
      tab.usage.inputTokens = norm.usage.inputTokens || 0;
      tab.usage.outputTokens = norm.usage.outputTokens || 0;
      tab.usage.cacheRead = norm.usage.cacheRead || 0;
      tab.usage.cacheWrite = norm.usage.cacheWrite || 0;
    }
    if (norm.contextWindow) tab.contextWindow = norm.contextWindow;
    if (norm.turns) tab.turns = norm.turns;
    if (norm.sessionCost) tab.sessionCost = norm.sessionCost;
    renderGauge(tab);
  }
  return true;
}

async function loadSessionHistory(sid, $msgs) {
  if (!$msgs) $msgs = activeTab()?.messagesEl;
  if (!$msgs) return;
  // Try local snapshot first — exact replay of the live render, lossless.
  const snap = getSessionSnapshot(sid);
  if (snap && snap.html) {
    const tab = _tabs.find(t => t.messagesEl === $msgs) || activeTab();
    if (renderStoredSession(snap, $msgs, tab)) {
      scrollEnd();
      // Background refresh: pull latest JSONL in case the session continued in
      // another window. If upstream has more turns than the snapshot, fall back
      // to the rebuild path below so the resumed view is current.
      try {
        const $project = _panel?.querySelector('#cp-project');
        const project = ddGetValue($project) || undefined;
        const params = new URLSearchParams({ limit: '1' });
        if (project) params.set('project', project);
        const probe = await fetch(`/api/claude-code/sessions/${encodeURIComponent(sid)}/messages?${params}`);
        const probeData = await probe.json();
        if ((probeData?.total || 0) > (snap.itemCount || 0) + 2) {
          // Upstream has materially more content — fall through to full rebuild
        } else {
          return;
        }
      } catch { return; }
    }
  }
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
        if (m.thinking) {
          const thinkEl = document.createElement('details');
          thinkEl.className = 'msg-thinking';
          thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">${THINKING_ICON}</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
          thinkEl.querySelector('.msg-thinking-content').textContent = m.thinking;
          wrap.appendChild(thinkEl);
        }
        if (m.text) {
          const body = document.createElement('div'); body.className = 'msg-body';
          body._rawMd = m.text;
          body.innerHTML = md(m.text);
          linkifyFilePaths(body);
          addCopyButtons(body);
          wrap.appendChild(body);
        }
        if (m.tools?.length) {
          for (const t of m.tools) {
            if (typeof t === 'object' && t.name) {
              wrap.appendChild(buildTool(t, activeTab()));
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
    pruneMessages($msgs);
    if (data.total > data.messages.length) {
      const note = document.createElement('div'); note.className = 'msg-status';
      note.textContent = `Showing last ${data.messages.length} of ${data.total} messages`;
      $msgs.prepend(note);
    }
    // Populate context gauge from session history usage
    const tab = _tabs.find(t => t.messagesEl === $msgs) || activeTab();
    if (tab && data.usage) {
      tab.usage.inputTokens = data.usage.input_tokens || 0;
      tab.usage.outputTokens = data.usage.output_tokens || 0;
      tab.usage.cacheRead = data.usage.cache_read_input_tokens || 0;
      tab.usage.cacheWrite = data.usage.cache_creation_input_tokens || 0;
      if (data.contextWindow) tab.contextWindow = data.contextWindow;
      tab.turns = data.turns || 0;
      renderGauge(tab);
    }
    scrollEnd();
    // Cache the rebuilt transcript so the next resume on a fresh browser hits
    // the snapshot path and avoids paying the JSONL → DOM cost again.
    if (tab && tab.sessionId === sid) writeSessionSnapshot(tab);
  } catch {
    $msgs.innerHTML = '<div class="msg-status">Failed to load history</div>';
  }
}

// ── Copy buttons on pre blocks ──
function addCopyButtons(el) {
  el.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.cp-copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'cp-copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const text = pre.querySelector('code')?.textContent || pre.textContent;
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      });
    });
    pre.appendChild(btn);
    // Colorize diff lines inline when the code block is a diff
    const code = pre.querySelector('code');
    if (code && /\bdiff\b/i.test(code.className) && !code.dataset.diffWrapped) {
      const raw = code.textContent || '';
      const lines = raw.split(/\r?\n/);
      const html = lines.map(line => {
        const c = line[0] || '';
        let cls = '';
        if (c === '+' && line[1] !== '+') cls = 'cp-diff-add';
        else if (c === '-' && line[1] !== '-') cls = 'cp-diff-del';
        else if (/^@@/.test(line)) cls = 'cp-diff-hunk';
        else if (/^(\+\+\+|---)/.test(line)) cls = 'cp-diff-file';
        return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
      }).join('\n');
      code.innerHTML = html;
      code.dataset.diffWrapped = '1';
    }
  });
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
  // Sync navbar cost label directly
  const navLabel = document.querySelector('#titlebar-cost-btn .bar-cost-label');
  if (navLabel) navLabel.textContent = '$' + sc.toFixed(2);
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
  const $fill = _panel?.querySelector('#cp-ctx-fill');
  const $label = _panel?.querySelector('#cp-gauge-label');
  if (!$fill) return;

  const u = tab.usage;
  const cacheRead = u.cacheRead || 0;
  const cacheWrite = u.cacheWrite || 0;
  const uncachedInput = u.inputTokens || 0;
  const total = uncachedInput + cacheRead + cacheWrite;
  const ctxWindow = tab.contextWindow || _getContextWindow();
  const fmt = (v) => {
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      return (Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1)) + 'M';
    }
    if (v >= 1000) return Math.round(v / 1000) + 'k';
    return String(v);
  };

  if (total === 0) {
    $fill.style.width = '0%';
    $fill.style.background = 'rgba(232,224,220,0.18)';
    if ($label) { $label.textContent = 'context pending'; $label.title = ''; }
    return;
  }

  const pct = Math.min(100, (total / ctxWindow) * 100);
  $fill.style.width = pct > 0 ? pct + '%' : '0%';
  $fill.style.background = pct > 80
    ? 'rgba(220,80,60,0.45)'
    : pct > 60
      ? 'rgba(220,150,50,0.38)'
      : 'rgba(232,224,220,0.18)';

  if ($label) {
    const cacheRatio = total > 0 ? Math.round((cacheRead / total) * 100) : 0;
    // Inline monochrome SVG (currentColor) keeps the badge on-theme with the
    // muted gauge label instead of an emoji's hard-coded color/size.
    const boltSvg = '<svg viewBox="0 0 7 9" aria-hidden="true"><path d="M4.2 0 0 5.3h2.1L1.5 9 7 3.5H4.8L5.6 0z" fill="currentColor"/></svg>';
    const ratioClass = cacheRatio >= 80 ? ' data-ratio="high"' : '';
    const cacheBadge = cacheRead > 0
      ? ` <span class="cp-cache-hit"${ratioClass} title="Cache hit ratio · ${fmt(cacheRead)} of ${fmt(total)} context tokens served from Anthropic prompt cache">${boltSvg}${cacheRatio}%</span>`
      : '';
    $label.innerHTML = `${fmt(total)} / ${fmt(ctxWindow)} ctx${cacheBadge}`;
    $label.title = `${Math.round(pct)}% context · ${fmt(u.outputTokens || 0)} output · cache read ${fmt(cacheRead)} / write ${fmt(cacheWrite)} · ${tab.turns} turn${tab.turns !== 1 ? 's' : ''}`;
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
  const fileCount = tab.attachedFiles.length;
  const header = fileCount === 1
    ? `The user attached a file (${tab.attachedFiles[0].path || tab.attachedFiles[0].name}). Its content is provided below.\n\n`
    : `The user attached ${fileCount} files. Their contents are provided below.\n\n`;
  let prompt = header;
  for (const f of tab.attachedFiles) {
    const pathAttr = f.path || f.name;
    prompt += `<file path="${pathAttr}">\n${f.content}\n</file>\n\n`;
  }
  prompt += userText;
  tab.attachedFiles = [];
  updateAttachBadge();
  _panel?.querySelectorAll('.cp-file-chip, .cp-path-chip').forEach(c => c.remove());
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
  // Buffer ALL messages while user is being prompted (permission card or AskUserQuestion).
  // Nothing appears until the user interacts — only control_request passes through
  // so new permission cards can still queue up.
  if ((tab._activePerm || tab.pendingAskRequestId) && msg.type !== 'control_request') {
    if (tab._msgBuffer.length < 500) tab._msgBuffer.push(msg);
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
        finishTab(tab, true);
        saveTabs();
      }
      break;
    case 'event':
      // Synthetic hook events tied to CLI lifecycle
      if (msg.event?.type === 'system' && msg.event?.subtype === 'init') {
        recordHookEvent(tab, 'SessionStart', msg.event.session_id || '');
        recordHookEvent(tab, 'InstructionsLoaded', 'CLAUDE.md + settings');
      }
      if (msg.event?.type === 'result') {
        recordHookEvent(tab, 'Stop', msg.event.subtype || 'turn end');
      }
      handleTabEvent(tab, msg.event); break;
    case 'control_request':
      if (msg.request?.subtype === 'permission_request' || msg.request?.subtype === 'can_use_tool') {
        recordHookEvent(tab, 'PermissionRequest', msg.request?.tool_name || '');
      }
      handleControlRequest(tab, msg); break;
    case 'stderr': if (msg.text?.trim()) appendStatus(tab, msg.text.trim()); break;
    case 'done':
      // Plan completion: check BEFORE finishTab clears flags (same pattern as result handler).
      if (tab._exitPlanPending && !tab._exitPlanHandled) {
        tab._exitPlanHandled = true;
        tab._exitPlanPending = false;
        renderPostPlanActions(tab);
      }
      finishTab(tab, !tab.running);
      if (tab.compacting) {
        recordHookEvent(tab, 'PostCompact', 'context compressed');
        tab.compacting = false;
        if (tab === activeTab()) _setCompactingUI(false);
      }
      // Queue: auto-advance to next message
      if (tab.queue.length > 0 && !tab.queuePaused) {
        setTimeout(() => advanceQueue(tab), 300);
      } else if (tab.queue.length === 0 && tab._queueWasActive) {
        tab._queueWasActive = false;
        appendStatus(tab, 'Queue complete');
      }
      break;
    case 'aborted':
      finishTab(tab, !!tab._btwPending);
      if (tab.compacting) { tab.compacting = false; if (tab === activeTab()) _setCompactingUI(false); }
      // /btw: if there's a pending message, send it immediately instead of showing "Aborted"
      if (tab._btwPending) {
        const btw = tab._btwPending;
        tab._btwPending = null;
        const $project = _panel?.querySelector('#cp-project');
        const $model = _panel?.querySelector('#cp-model');
        tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
        // Restore files from btw snapshot so buildPromptWithAttachments can process them
        if (btw.files) tab.attachedFiles = btw.files;
        let prompt = buildPromptWithAttachments(tab, btw.text);
        if (tab.planMode && prompt) prompt = `[PLAN MODE — think step by step, create a detailed plan, do NOT make code changes.]\n\nCRITICAL — When you have questions or need clarification during planning:\n1. First call ToolSearch with query "select:AskUserQuestion" to load the tool schema\n2. Then call AskUserQuestion to present your questions as interactive options (2-4 choices per question, max 4 questions)\n3. NEVER write questions as plain text — ALWAYS use the AskUserQuestion tool\n4. Use ExitPlanMode when the plan is ready for approval\n\nSTRICT ORDERING — ExitPlanMode MUST be your FINAL action in the turn: do ALL research (Grep, Read, Glob) and write the full plan text BEFORE calling ExitPlanMode. Never emit any text or tool call AFTER ExitPlanMode — anything after is dropped and the user only sees the PLAN COMPLETE approval card.\n\n${prompt}`;
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
        // Queue: advance after abort if no /btw pending
        if (tab.queue.length > 0 && !tab.queuePaused) {
          setTimeout(() => advanceQueue(tab), 300);
        }
      }
      break;
    case 'error':
      finishTab(tab, true);
      if (tab.compacting) { tab.compacting = false; if (tab === activeTab()) _setCompactingUI(false); }
      appendError(tab, msg.message);
      notify('panel', NOTIF_TYPE.ERROR, tab.label || 'Claude Code', { tabId: tab.id });
      if (typeof msg.message === 'string' && /Claude CLI not found|ENOENT/i.test(msg.message)) {
        flagClaudeCliInstallFailure();
      }
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
  if (ev.type === 'system' && ev.subtype === 'compact_detected') {
    // Auto-compact detected via token count drop — show status + clear compacting UI
    tab.compacting = false;
    if (tab === activeTab()) _setCompactingUI(false);
    const $msgs = tab.messagesEl;
    if ($msgs) {
      let el = $msgs.querySelector('.msg-compact-status');
      if (!el) {
        el = document.createElement('div');
        el.className = 'msg-status msg-compact-status';
        $msgs.appendChild(el);
      }
      el.textContent = ev.message || 'Context auto-compacted';
    }
    if (tab === activeTab()) scrollEnd();
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
      if (tab.pendingLabel) {
        storage.setItem(LABEL_PREFIX + ev.session_id, tab.pendingLabel);
        tab.label = tab.pendingLabel;
        tab.pendingLabel = null;
        updatePillLabel(tab);
      } else if (tab.label === 'New chat') {
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
    renderAssistant(tab, ev.message);
    // Reposition thinking indicator to bottom (stays visible while running)
    // appendChild on an existing child moves it atomically — no separate remove() needed
    if (tab.thinkingEl && tab.running && tab.thinkingEl !== tab.messagesEl.lastElementChild) {
      tab.messagesEl.appendChild(tab.thinkingEl);
      if (tab === activeTab()) scrollEnd();
    }
    return;
  }
  if (ev.type === 'tool_result') {
    updateToolResult(tab, ev);
    scheduleSessionSnapshotSave(tab);
    // Re-show thinking — Claude is processing the tool result
    if (tab.running && !tab.pendingAsk) showThinking(tab);
    return;
  }
  if (ev.type === 'result') {
    const isError = (ev.subtype === 'error_during_execution' || ev.subtype === 'error') && (ev.error || ev.result);
    // Display error for error_during_execution results
    if (isError) {
      appendError(tab, ev.error || ev.result);
    }
    // Plan completion: check BEFORE finishTab clears flags. --print mode emits result
    // event (not done message) as the terminal event, so this is the primary handler.
    if (tab._exitPlanPending && !tab._exitPlanHandled) {
      tab._exitPlanHandled = true;
      tab._exitPlanPending = false;
      renderPostPlanActions(tab);
    }
    finishTab(tab, true);
    if (isError) notify('panel', NOTIF_TYPE.ERROR, tab.label || 'Claude Code', { tabId: tab.id });
    else notify('panel', NOTIF_TYPE.DONE, tab.label || 'Claude Code', { tabId: tab.id });
    tab.turns++;
    // NOTE: result.usage is CUMULATIVE across all API calls in this CLI process,
    // not the current context window state. Do NOT update tab.usage from it —
    // the gauge already gets correct per-turn values from assistant/message_start events.
    if (ev.usage) {
      if (tab.compacting) {
        tab.compacting = false;
        if (tab === activeTab()) _setCompactingUI(false);
      }
    }
    // Extract actual context window from modelUsage (CLI reports the real value)
    if (ev.modelUsage) {
      const modelKey = Object.keys(ev.modelUsage)[0];
      if (modelKey) {
        const cw = ev.modelUsage[modelKey].contextWindow;
        if (cw && cw > 0) {
          tab.contextWindow = cw;
          if (tab === activeTab()) renderGauge(tab);
        }
      }
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
      emit('cost:updated', { amount: delta > 0 ? delta : 0, total: _totalCost, sessionCost: tab.sessionCost });
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
    // Extract usage from message_start for real-time gauge updates during streaming
    if (apiEvent.message?.usage) {
      const u = apiEvent.message.usage;
      tab.usage.inputTokens = u.input_tokens ?? tab.usage.inputTokens;
      tab.usage.outputTokens = u.output_tokens ?? tab.usage.outputTokens;
      tab.usage.cacheRead = u.cache_read_input_tokens ?? tab.usage.cacheRead;
      tab.usage.cacheWrite = u.cache_creation_input_tokens ?? tab.usage.cacheWrite;
      if (tab === activeTab()) renderGauge(tab);
    }
    return;
  }

  if (evType === 'message_delta') {
    // Extract cumulative output tokens from message_delta for real-time gauge
    if (apiEvent.usage?.output_tokens) {
      tab.usage.outputTokens = apiEvent.usage.output_tokens;
      if (tab === activeTab()) renderGauge(tab);
    }
    return;
  }

  if (evType === 'message_stop') {
    // Finalize: flush any pending markdown render
    if (tab._stream?.mdTimer) clearTimeout(tab._stream.mdTimer);
    if (tab._stream?.bodyEl && tab._stream.textBuf) {
      tab._stream.bodyEl._rawMd = tab._stream.textBuf;
      tab._stream.bodyEl.innerHTML = md(tab._stream.textBuf);
      linkifyFilePaths(tab._stream.bodyEl);
      addCopyButtons(tab._stream.bodyEl);
    }
    if (tab._stream?.el) {
      const removed = _cleanupEmptyAssistantRow(tab._stream.el);
      if (removed) {
        if (tab.currentMsgEl === tab._stream.el) { tab.currentMsgEl = null; tab.currentMsgId = null; }
        tab._stream.el = null;
      }
    }
    tab._stream = null;
    return;
  }

  if (evType === 'content_block_start') {
    if (!tab._stream) tab._stream = { el: null, textBuf: '', thinkBuf: '', bodyEl: null, thinkEl: null, blockIdx: -1, blockType: null, mdTimer: null };
    tab._stream.blockIdx = apiEvent.index ?? (tab._stream.blockIdx + 1);
    tab._stream.blockType = apiEvent.content_block?.type || null;

    // Only thinking blocks get a stream skeleton eagerly — they always have
    // content. tool_use and thinking-with-effort-off are handled by
    // renderAssistant. Text blocks defer row/body creation to content_block_delta
    // so a model that opens a text block and pivots to a tool call without
    // emitting visible text doesn't leave a blank avatar row behind.
    const isThinkingRenderable = tab._stream.blockType === 'thinking' && _getEffort();
    if (!isThinkingRenderable) return;

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
      pruneMessages($msgs);
      tab._stream.el = el;
      // Wire this as the current message so renderAssistant dedup finds it
      if (tab._stream.msgId) { tab.currentMsgId = tab._stream.msgId; tab.currentMsgEl = el; }
    }

    const wrap = tab._stream.el.querySelector('.msg-content');

    if (!tab._stream.thinkEl) {
      const thinkEl = document.createElement('details');
      thinkEl.className = 'msg-thinking';
      thinkEl.innerHTML = `<summary><span class="msg-thinking-icon">${THINKING_ICON}</span><span class="msg-thinking-label">Thinking</span><span class="msg-thinking-chevron">&#x203A;</span></summary><div class="msg-thinking-content"></div>`;
      wrap.insertBefore(thinkEl, wrap.firstChild);
      tab._stream.thinkEl = thinkEl;
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
      // Lazy-create row + body on first visible text. Keeps empty/whitespace-only
      // text blocks from leaving a blank row next to the avatar.
      if (!tab._stream.bodyEl && tab._stream.textBuf.trim()) {
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
          pruneMessages($msgs);
          tab._stream.el = el;
          if (tab._stream.msgId) { tab.currentMsgId = tab._stream.msgId; tab.currentMsgEl = el; }
        }
        const wrap = tab._stream.el.querySelector('.msg-content');
        const body = document.createElement('div');
        body.className = 'msg-body';
        wrap.appendChild(body);
        tab._stream.bodyEl = body;
      }
      // Throttle markdown re-rendering to ~30fps for smooth streaming
      if (tab._stream.bodyEl && !tab._stream.mdTimer) {
        tab._stream.mdTimer = setTimeout(() => {
          tab._stream.mdTimer = null;
          if (tab._stream?.bodyEl) {
            tab._stream.bodyEl.innerHTML = md(tab._stream.textBuf);
            linkifyFilePaths(tab._stream.bodyEl);
            if (tab === activeTab()) scrollEnd();
          }
        }, 32);
      }
    }
    // scrollEnd is handled inside the throttle callback above
    return;
  }

  if (evType === 'content_block_stop') {
    if (!tab._stream) return;
    // Flush pending markdown render immediately on block stop
    if (tab._stream.mdTimer) {
      clearTimeout(tab._stream.mdTimer);
      tab._stream.mdTimer = null;
    }
    if (tab._stream.bodyEl && tab._stream.textBuf.trim()) {
      tab._stream.bodyEl._rawMd = tab._stream.textBuf;
      tab._stream.bodyEl.innerHTML = md(tab._stream.textBuf);
      linkifyFilePaths(tab._stream.bodyEl);
      addCopyButtons(tab._stream.bodyEl);
    } else if (tab._stream.bodyEl) {
      // Body exists but textBuf has no visible content — drop it so the avatar
      // doesn't sit next to a blank bubble
      tab._stream.bodyEl.remove();
      tab._stream.bodyEl = null;
    }
    tab._stream.blockType = null;
    // If this row has no visible content, drop it (avatar-next-to-blank guard)
    if (tab._stream.el) {
      const removed = _cleanupEmptyAssistantRow(tab._stream.el);
      if (removed) {
        if (tab.currentMsgEl === tab._stream.el) { tab.currentMsgEl = null; tab.currentMsgId = null; }
        tab._stream.el = null;
        tab._stream.thinkEl = null;
      }
    }
    if (tab === activeTab()) scrollEnd();
    return;
  }
}

function renderPostPlanActions(tab, headerText) {
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
  hdr.textContent = headerText || 'PLAN COMPLETE';
  card.appendChild(hdr);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'post-plan-actions';

  const actions = [
    { label: 'Continue with implementation', prompt: 'Continue with the implementation based on the approved plan.', primary: true },
    { label: 'Continue planning', action: 'continue-planning' },
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
      if (a.action === 'continue-planning') {
        tab.showPostPlanActions = false;
        saveTabs();
        return;
      } else if (a.action === 'compact') {
        // Guard: cannot compact while running
        if (tab.running) { appendStatus(tab, 'Cannot compact while Claude is processing.'); card.style.opacity = '1'; card.style.pointerEvents = 'auto'; return; }
        if (tab.ws?.readyState === WebSocket.OPEN) {
          tab.compacting = true;
          if (tab === activeTab()) _setCompactingUI(true);
          tab.ws.send(JSON.stringify({ type: 'compact' }));
          appendStatus(tab, 'Compacting context...');
        } else {
          appendStatus(tab, 'Connection lost — cannot compact. Try refreshing.');
          card.style.opacity = '1'; card.style.pointerEvents = 'auto';
        }
      } else if (a.action === 'plan') {
        // Open plan file in SynaBun code editor for direct editing
        const openPlan = (path) => emit('open-plan-editor', { filePath: path, tabId: tab.id, source: 'claude' });
        const noFile = (reason) => {
          if (reason) console.warn('[claude-panel] Edit plan fallback:', reason);
          if (!card._noFileShown) {
            card._noFileShown = true;
            appendStatus(tab, 'Plan text was empty — ask Claude to re-output the plan, or click Continue with implementation to proceed.');
          }
          card.style.opacity = '1'; card.style.pointerEvents = 'auto';
        };
        const materialize = (planText) => {
          fetch('/api/create-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: planText }),
          }).then(r => r.json()).then(result => {
            if (result.ok) {
              tab.planFilePath = result.path;
              saveTabs();
              openPlan(result.path);
            } else { noFile(result.error || 'create-plan returned non-ok'); }
          }).catch(err => noFile(err?.message || 'create-plan request failed'));
        };
        const diskFallback = () => {
          fetch('/api/latest-plan').then(r => r.ok ? r.json() : null).then(result => {
            const p = result?.path;
            const mtime = result?.mtime ? new Date(result.mtime).getTime() : 0;
            const startedAt = tab._planModeStartedAt || 0;
            if (p && mtime && mtime >= startedAt) {
              tab.planFilePath = p;
              saveTabs();
              openPlan(p);
            } else {
              noFile('latest-plan not fresh (mtime < plan-mode start)');
            }
          }).catch(err => noFile(err?.message || 'latest-plan request failed'));
        };
        if (tab.planFilePath) {
          openPlan(tab.planFilePath);
        } else {
          const planText = tab._planContent || extractPlanText(tab);
          if (planText) { materialize(planText); return; }
          // Late-stream DOM race: retry once on the next frame to catch content that
          // was inserted just after the click fired.
          requestAnimationFrame(() => {
            const retry = tab._planContent || extractPlanText(tab);
            if (retry) materialize(retry);
            else diskFallback();
          });
          return;
        }
      } else if (a.prompt) {
        // Exit plan mode before sending implementation prompt
        tab.planMode = false;
        const $plan = _panel?.querySelector('#cp-plan-toggle');
        if ($plan) $plan.classList.remove('active');
        if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) {
          appendStatus(tab, 'Connection lost — cannot send. Try refreshing.');
          card.style.opacity = '1'; card.style.pointerEvents = 'auto';
          return;
        }
        // Include full edited plan content if user edited before implementing
        let finalPrompt = a.prompt;
        if (tab._editedPlanContent) {
          finalPrompt = `The user has reviewed and approved this updated plan:\n\n${tab._editedPlanContent}\n\nProceed with implementation.`;
          delete tab._editedPlanContent;
        }
        const $input = _panel?.querySelector('#cp-input');
        if ($input) { $input.value = finalPrompt; send(); }
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

// Remove whitespace-only msg-body elements and the entire assistant row if its
// msg-content ends up with nothing visible. Happens when a text block opens but
// the model pivots to a tool call after emitting only whitespace — without this
// the avatar sits next to a blank bubble.
function _cleanupEmptyAssistantRow(el) {
  if (!el || !el.isConnected) return false;
  const wrap = el.querySelector('.msg-content');
  if (!wrap) return false;
  wrap.querySelectorAll('.msg-body').forEach(b => {
    const raw = b._rawMd != null ? String(b._rawMd) : '';
    const hasRaw = raw.trim().length > 0;
    const hasRichChild = b.querySelector('img, video, canvas, svg, pre, code, table');
    const hasText = (b.textContent || '').trim().length > 0;
    if (!hasRaw && !hasRichChild && !hasText) b.remove();
  });
  const visible = wrap.querySelector('.msg-body, .msg-thinking, .tool-card, .plan-card, .ask-card, .post-plan-card, .perm-card');
  if (!visible) { el.remove(); return true; }
  return false;
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

  // Skip render if only content is AskUserQuestion tools already rendered via control_request
  // — prevents an empty AI avatar appearing below the interactive question card
  const msgId = msg.id || null;
  if (!texts.length && !thinks.length && !regularTools.length && tab.askRenderedViaControl) {
    if (msgId && tab.currentMsgId === msgId && tab.currentMsgEl) {
      tab.currentMsgEl.remove();
      tab.currentMsgId = null;
      tab.currentMsgEl = null;
    }
    return;
  }

  // EnterPlanMode detection: record message boundary so extractPlanText() only
  // searches messages rendered DURING plan mode, not pre-plan preamble.
  if (tools.some(t => t.name === 'EnterPlanMode')) {
    tab.planMode = true;
    tab._planContent = null;
    tab._planContentCaptured = false;
    tab.planFilePath = '';
    tab._editedPlanContent = null;
    tab._planModeStartedAt = Date.now();
    tab._planModeStartMsgIndex = tab.messagesEl?.querySelectorAll('.msg.msg-assistant').length || 0;
    const $plan = _panel?.querySelector('#cp-plan-toggle');
    if ($plan) $plan.classList.add('active');
    saveTabs();
  }

  // ExitPlanMode detection: render post-plan actions IMMEDIATELY when detected in the
  // stream, before Claude streams any further implementation text. --print mode doesn't
  // emit tool_result events for built-in tools, so updateToolResult() is only a fallback.
  // Detect regardless of current planMode state — it may have been toggled off mid-stream
  // (tab switch, reconnect, race). Track whether it WAS active.
  if (tools.some(t => t.name === 'ExitPlanMode') && !tab._exitPlanHandled) {
    tab._exitPlanWasPlanMode = tab._exitPlanWasPlanMode || tab.planMode;
    tab._exitPlanPending = true;
    tab.planMode = false;
    const $plan = _panel?.querySelector('#cp-plan-toggle');
    if ($plan) $plan.classList.remove('active');
    // Capture plan content immediately before post-plan messages pollute the DOM.
    // Prefer ExitPlanMode.input.plan (authoritative), then msg text, then DOM walk.
    if (!tab._planContentCaptured) {
      const exitBlock = tools.find(t => t.name === 'ExitPlanMode');
      const direct = (exitBlock?.input?.plan || '').trim();
      const captured = direct;
      if (captured) {
        tab._planContentCaptured = true;
        tab._planContent = captured;
        tab._exitPlanPending = false;
        fetch('/api/create-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: captured }) })
          .then(r => r.json()).then(result => { if (result.ok && !tab.planFilePath) { tab.planFilePath = result.path; saveTabs(); } })
          .catch(err => console.warn('[claude-panel] create-plan failed:', err));
      }
    }
    // Render post-plan actions IMMEDIATELY — don't wait for result/updateToolResult
    tab._exitPlanHandled = true;
    renderPostPlanActions(tab);
    saveTabs();
  }

  // Partial message dedup
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
        const rawMd = texts.map(b => b.text).join('\n');
        // Skip whitespace-only text — prevents a blank bubble next to the avatar
        // when the model opens a text block but pivots to a tool call.
        if (rawMd.trim()) {
          const html = md(rawMd);
          if (existingBody) {
            existingBody._rawMd = rawMd;
            existingBody.innerHTML = html;
            linkifyFilePaths(existingBody);
            addCopyButtons(existingBody);
          } else {
            const body = document.createElement('div');
            body.className = 'msg-body';
            body._rawMd = rawMd;
            body.innerHTML = html;
            linkifyFilePaths(body);
            addCopyButtons(body);
            const afterThink = wrap.querySelector('.msg-thinking');
            if (afterThink) afterThink.after(body);
            else wrap.insertBefore(body, wrap.firstChild);
          }
        } else if (existingBody) {
          // Existing body became whitespace-only — drop it
          existingBody.remove();
        }
      }
      const existingToolIds = new Set([...wrap.querySelectorAll('.tool-card, .plan-card')].map(c => c.dataset.toolId));
      for (const t of regularTools) {
        if (!existingToolIds.has(t.id || '')) wrap.appendChild(buildTool(t, tab));
      }
      const existingAskIds = new Set([...wrap.querySelectorAll('.ask-card')].map(c => c.dataset.toolId));
      for (const t of askTools) {
        if (!existingAskIds.has(t.id || '')) {
          wrap.appendChild(buildAskFromToolUse(tab, t));
        }
      }
    }
    // Eager capture plan content in dedup path — streaming creates the element via
    // handleStreamDelta, so renderAssistant always takes this dedup branch.
    if (tab._exitPlanPending && !tab._planContentCaptured) {
      const exitBlock = tools.find(t => t.name === 'ExitPlanMode');
      const direct = (exitBlock?.input?.plan || '').trim();
      const captured = direct;
      if (captured) {
        tab._planContentCaptured = true;
        tab._planContent = captured;
        tab._exitPlanPending = false;
        fetch('/api/create-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: captured }) })
          .then(r => r.json()).then(result => { if (result.ok && !tab.planFilePath) { tab.planFilePath = result.path; saveTabs(); } })
          .catch(err => console.warn('[claude-panel] create-plan failed:', err));
      }
    }
    // Ensure post-plan card stays at the bottom of the messages
    const postPlanMsgD = $msgs.querySelector('.post-plan-card')?.closest('.msg');
    if (postPlanMsgD && postPlanMsgD !== $msgs.lastElementChild) {
      $msgs.appendChild(postPlanMsgD);
    }
    // Drop the row if the dedup update left it with nothing visible
    if (_cleanupEmptyAssistantRow(tab.currentMsgEl)) {
      tab.currentMsgEl = null;
      tab.currentMsgId = null;
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
    const rawMd = texts.map(b => b.text).join('\n');
    // Skip whitespace-only text — prevents a blank bubble next to the avatar.
    if (rawMd.trim()) {
      const body = document.createElement('div');
      body.className = 'msg-body';
      body._rawMd = rawMd;
      body.innerHTML = md(rawMd);
      linkifyFilePaths(body);
      addCopyButtons(body);
      wrap.appendChild(body);
    }
  }
  for (const t of regularTools) wrap.appendChild(buildTool(t, tab));
  for (const t of askTools) wrap.appendChild(buildAskFromToolUse(tab, t));
  el.appendChild(wrap);
  $msgs.appendChild(el);
  pruneMessages($msgs);

  // Drop the row if it ended up with nothing visible (all text blocks were whitespace
  // and no tools/thinking content was produced)
  if (_cleanupEmptyAssistantRow(el)) {
    if (msgId) { tab.currentMsgId = null; tab.currentMsgEl = null; }
    return;
  }

  if (msgId) { tab.currentMsgId = msgId; tab.currentMsgEl = el; }

  // Eagerly capture plan content the moment ExitPlanMode is detected.
  if (tab._exitPlanPending && !tab._planContentCaptured) {
    const exitBlock = tools.find(t => t.name === 'ExitPlanMode');
    const direct = (exitBlock?.input?.plan || '').trim();
    const captured = direct;
    if (captured) {
      tab._planContentCaptured = true;
      tab._planContent = captured;
      tab._exitPlanPending = false;
      fetch('/api/create-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: captured }) })
        .then(r => r.json()).then(result => { if (result.ok && !tab.planFilePath) { tab.planFilePath = result.path; saveTabs(); } })
        .catch(err => console.warn('[claude-panel] create-plan failed:', err));
    }
  }

  // Ensure post-plan card stays at the bottom of the messages
  const postPlanMsg = $msgs.querySelector('.post-plan-card')?.closest('.msg');
  if (postPlanMsg && postPlanMsg !== $msgs.lastElementChild) {
    $msgs.appendChild(postPlanMsg);
  }
  if (tab === activeTab()) scrollEnd();
  scheduleSessionSnapshotSave(tab);
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
  const allQuestions = input.questions || questions;
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

  // Batched answer collection
  const pendingAnswers = {};
  const totalQuestions = questions.length;
  const submitBar = document.createElement('div');
  submitBar.className = 'ask-submit-bar';
  const submitBtn = document.createElement('button');
  submitBtn.className = 'ask-submit';
  submitBtn.disabled = true;
  submitBtn.textContent = `Submit (0/${totalQuestions})`;
  submitBar.appendChild(submitBtn);

  function updateSubmitState() {
    const answered = Object.keys(pendingAnswers).length;
    submitBtn.textContent = `Submit (${answered}/${totalQuestions})`;
    submitBtn.disabled = answered < totalQuestions;
  }

  let qIndex = -1;
  for (const q of questions) {
    qIndex++;
    const questionText = q.question || q.text || q.header || '';
    const isMultiSelect = q.multiSelect === true;

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

    if (isMultiSelect) {
      const hint = document.createElement('div');
      hint.className = 'ask-multi-hint';
      hint.textContent = 'Select all that apply';
      container.appendChild(hint);
    }

    if (q.options?.length) {
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      if (isMultiSelect) opts.classList.add('multi');
      // Detect changelog ask — has both "Save as-is" and "Edit first" options
      const optLabels = q.options.map(o => typeof o === 'string' ? o : (o.label || o.value || ''));
      const isChangelogAsk = optLabels.some(l => /save as.is/i.test(l)) && optLabels.some(l => /edit first/i.test(l));
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
          // Changelog "Edit first" — bypass batch, trigger editor directly
          if (isChangelogAsk && /edit first/i.test(optLabel)) {
            opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
            btn.classList.add('selected');
            tab._changelogAsk = { questions: allQuestions, questionText };
            const changelogText = extractPlanText(tab);
            if (!changelogText) {
              appendStatus(tab, 'No changelog content found to edit.');
              opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = false; });
              btn.classList.remove('selected');
              return;
            }
            fetch('/api/create-plan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: changelogText }),
            }).then(r => r.json()).then(result => {
              if (result.ok) {
                emit('open-changelog-editor', { filePath: result.path, tabId: tab.id });
              } else {
                appendStatus(tab, 'Failed to create changelog draft.');
                opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = false; });
                btn.classList.remove('selected');
              }
            }).catch(() => {
              appendStatus(tab, 'Failed to create changelog draft.');
              opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = false; });
              btn.classList.remove('selected');
            });
            return;
          }
          // Batched selection — toggle freely, don't send yet
          // Clicking an option clears any custom typed answer on this question
          const qInput = container.querySelector(`.ask-text-input[data-qidx="${qIndex}"]`);
          if (qInput) qInput.value = '';
          if (isMultiSelect) {
            btn.classList.toggle('selected');
            const selected = [];
            opts.querySelectorAll('.ask-option.selected').forEach(b => {
              selected.push(b.querySelector('.ask-option-label').textContent);
            });
            if (selected.length > 0) pendingAnswers[questionText] = selected.join(', ');
            else delete pendingAnswers[questionText];
          } else {
            opts.querySelectorAll('.ask-option').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            pendingAnswers[questionText] = optLabel;
          }
          updateSubmitState();
        });
        opts.appendChild(btn);
      }
      opts.dataset.qidx = String(qIndex);
      container.appendChild(opts);
    }
    // Text input — always present. When options also exist, acts as "write your own" override.
    const hasOptions = !!q.options?.length;
    if (hasOptions) {
      const divider = document.createElement('div');
      divider.className = 'ask-or-type';
      divider.textContent = 'Or type your own answer';
      container.appendChild(divider);
    }
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'ask-text-input';
    textInput.placeholder = hasOptions ? 'Custom answer\u2026' : 'Type your answer...';
    textInput.dataset.qidx = String(qIndex);
    textInput.addEventListener('input', () => {
      const value = textInput.value.trim();
      const optsEl = container.querySelector(`.ask-options[data-qidx="${qIndex}"]`);
      if (value) {
        if (optsEl) optsEl.querySelectorAll('.ask-option.selected').forEach(b => b.classList.remove('selected'));
        pendingAnswers[questionText] = value;
      } else {
        const selectedLbl = optsEl?.querySelector('.ask-option.selected .ask-option-label');
        if (selectedLbl) pendingAnswers[questionText] = selectedLbl.textContent;
        else delete pendingAnswers[questionText];
      }
      updateSubmitState();
    });
    container.appendChild(textInput);
  }

  // Submit button — sends all answers as a batch
  submitBtn.addEventListener('click', () => {
    container.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
    container.querySelectorAll('.ask-text-input').forEach(i => { i.disabled = true; });
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitted';
    sendAskAnswer(tab, allQuestions, pendingAnswers);
  });
  container.appendChild(submitBar);

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
    // No request_id yet — buffer the answer for when control_request arrives.
    // In --print mode, AskUserQuestion appears as a permission_denial in the result event.
    // The server sends a control_request shortly after. Buffer and flush on arrival.
    console.log('[claude-panel] Buffering ask answer (control_request pending):', answerText);
    tab.pendingAskBufferedAnswer = { questions, answers };
    // Fallback: if control_request doesn't arrive within 3s, send as follow-up query
    setTimeout(() => {
      if (!tab.pendingAskBufferedAnswer) return; // already flushed
      console.log('[claude-panel] Fallback: control_request not received, sending as query');
      const buffered = tab.pendingAskBufferedAnswer;
      tab.pendingAskBufferedAnswer = null;
      const fallbackText = Object.values(buffered.answers).join(', ');
      const $project = _panel?.querySelector('#cp-project');
      tab.ws.send(JSON.stringify({
        type: 'query',
        prompt: `The user answered your question: "${fallbackText}"\nContinue based on their selection.`,
        sessionId: tab.sessionId || undefined,
        model: _getModelId() || undefined,
        cwd: ddGetValue($project) || undefined,
        effort: _getEffort() || undefined,
      }));
    }, 3000);
  }

  tab.pendingAskRequestId = null;
  tab.pendingAskToolUseId = null;
  tab.pendingAskBufferedAnswer = null;
  // Flush BEFORE clearing askRenderedViaControl — buffered assistant events
  // must see the flag so buildAskFromToolUse returns a hidden placeholder
  // instead of rendering a duplicate card.
  if (!tab._activePerm) _flushMsgBuffer(tab);
  tab.askRenderedViaControl = false;
  showThinking(tab);
  setRunning(tab, true);
}

function isPlanFile(filePath) {
  return filePath && (/[/\\]data[/\\]plans[/\\]/.test(filePath) || /[/\\]\.claude[/\\]plans[/\\]/.test(filePath) || /(?:^|[/\\])PLAN\.md$/.test(filePath));
}

/** Extract plan text from assistant messages rendered DURING plan mode.
 *  Uses _planModeStartMsgIndex as a lower bound so pre-plan preamble is never captured. */
function extractPlanText(tab) {
  if (!tab.messagesEl) return '';
  const msgs = tab.messagesEl.querySelectorAll('.msg.msg-assistant');
  const startIdx = tab._planModeStartMsgIndex || 0;
  for (let i = msgs.length - 1; i >= startIdx; i--) {
    const body = msgs[i].querySelector('.msg-body, .plan-body');
    if (!body) continue;
    const text = (body._rawMd || body.innerText)?.trim();
    if (text && text.length > 100) return text;
  }
  return '';
}

function extractPlanTextFromMessage(msg) {
  if (!msg || !Array.isArray(msg.content)) return '';
  const exitTool = msg.content.find(b => b && b.type === 'tool_use' && b.name === 'ExitPlanMode');
  const planInput = (exitTool?.input?.plan || '').trim();
  if (planInput) return planInput;
  const texts = msg.content.filter(b => b && b.type === 'text');
  const joined = texts.map(b => b.text || '').join('\n').trim();
  if (joined && joined.length > 100) return joined;
  return '';
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
  addCopyButtons(body);
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
  icon.innerHTML = SYNABUN_LOGO_ICON;
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

function buildTool(block, tab) {
  // TodoWrite: update the sticky todo widget and keep the tool card
  if (block.name === 'TodoWrite' && tab) {
    try {
      const todos = block.input?.todos || [];
      if (Array.isArray(todos) && todos.length) {
        tab.todos = todos.map(t => ({ content: t.content || '', activeForm: t.activeForm || '', status: t.status || 'pending' }));
        if (typeof tab.todosVisible !== 'boolean') tab.todosVisible = false;
        renderTodoWidget(tab);
      }
    } catch {}
  }
  // Fire synthetic hook events for the activity strip (PreToolUse + specialized)
  if (tab) {
    recordHookEvent(tab, 'PreToolUse', block.name || '');
    if (block.name === 'Agent') recordHookEvent(tab, 'SubagentStart', block.input?.subagent_type || block.input?.description || '');
    else if (['Edit', 'Write', 'NotebookEdit'].includes(block.name)) recordHookEvent(tab, 'FileChanged', (block.input?.file_path || '').split(/[/\\]/).pop() || '');
  }
  // Plan files get a special rendered card — track path on tab for editor access
  if (block.name === 'Write' && isPlanFile(block.input?.file_path)) {
    if (tab) tab.planFilePath = block.input.file_path;
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
  card.dataset.toolName = block.name;
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
  // Synthetic PostToolUse hook event + SubagentStop
  const toolNm = card.dataset.toolName || '';
  recordHookEvent(tab, ev.is_error ? 'PostToolUseFailure' : 'PostToolUse', toolNm);
  if (toolNm === 'Agent') recordHookEvent(tab, 'SubagentStop', ev.is_error ? 'error' : 'ok');
  // Collapse adjacent repeated MCP tool calls (post-insert) — cheap, DOM-local
  try { collapseAdjacentMcpTools($msgs); } catch {}
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
  // ExitPlanMode — clear plan mode and mark handled so done handler doesn't double-render.
  // Sidepanel plan mode is SIMULATED (prompt prefix, not native EnterPlanMode), so ExitPlanMode
  // always errors with "You are not in plan mode" in --print mode. Render post-plan actions if
  // either: ExitPlanMode succeeded (native) OR we were in simulated plan mode (error is expected).
  const toolName = card.dataset.toolName || '';
  if (toolName === 'ExitPlanMode') {
    // Already handled at ExitPlanMode detection time in renderAssistant — skip to avoid double-render.
    // This path is a fallback for native (non-simulated) plan mode where tool_result fires first.
    if (tab._exitPlanHandled) return;
    const wasPlanMode = tab._exitPlanWasPlanMode || tab.planMode;
    tab.planMode = false;
    tab._exitPlanHandled = true;
    tab._exitPlanPending = false;
    const $plan = _panel?.querySelector('#cp-plan-toggle');
    if ($plan) $plan.classList.remove('active');
    saveTabs();
    if (!ev.is_error || wasPlanMode) renderPostPlanActions(tab);
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
    // Also check askRenderedViaControl to prevent duplicate cards from denial control_requests
    if (!tab.pendingAskToolUseId && !tab.askRenderedViaControl) {
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
  notify('panel', NOTIF_TYPE.ACTION, tab.label || 'Claude Code', { tabId: tab.id });
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
  // DOM-level dedup: if an active (non-submitted) ask card already exists, skip
  const existing = $msgs.querySelector('.ask-card .ask-submit:not([disabled])');
  if (existing) return;
  hideThinking(tab);
  tab.askRenderedViaControl = true;
  notify('panel', NOTIF_TYPE.ASK, tab.label || 'Claude Code', { tabId: tab.id });

  // Normalize: accept questions array, single question object, or flat input
  const questions = Array.isArray(input?.questions) ? input.questions
    : (input?.question || input?.text || input?.options) ? [input]
    : input ? [input] : [];
  const allQuestions = input.questions || questions;
  const el = document.createElement('div');
  el.className = 'msg msg-assistant';

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.innerHTML = CLAUDE_ICON;
  el.appendChild(avatar);

  const wrap = document.createElement('div');
  wrap.className = 'msg-content';

  // Batched answer collection
  const pendingAnswers = {};
  const totalQuestions = questions.length;
  const submitBar = document.createElement('div');
  submitBar.className = 'ask-submit-bar';
  const submitBtn = document.createElement('button');
  submitBtn.className = 'ask-submit';
  submitBtn.disabled = true;
  submitBtn.textContent = `Submit (0/${totalQuestions})`;
  submitBar.appendChild(submitBtn);

  function updateSubmitState() {
    const answered = Object.keys(pendingAnswers).length;
    submitBtn.textContent = `Submit (${answered}/${totalQuestions})`;
    submitBtn.disabled = answered < totalQuestions;
  }

  for (const q of questions) {
    const questionText = q.question || q.text || q.header || '';
    const isMultiSelect = q.multiSelect === true;
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

    if (isMultiSelect) {
      const hint = document.createElement('div');
      hint.className = 'ask-multi-hint';
      hint.textContent = 'Select all that apply';
      card.appendChild(hint);
    }

    if (q.options?.length) {
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      if (isMultiSelect) opts.classList.add('multi');
      // Detect changelog ask — has both "Save as-is" and "Edit first" options
      const optLabels = q.options.map(o => typeof o === 'string' ? o : (o.label || o.value || ''));
      const isChangelogAsk = optLabels.some(l => /save as.is/i.test(l)) && optLabels.some(l => /edit first/i.test(l));
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
          // Changelog "Edit first" — bypass batch, trigger editor directly
          if (isChangelogAsk && /edit first/i.test(optLabel)) {
            opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
            btn.classList.add('selected');
            tab._changelogAsk = { questions: allQuestions, questionText };
            const changelogText = extractPlanText(tab);
            if (!changelogText) {
              appendStatus(tab, 'No changelog content found to edit.');
              opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = false; });
              btn.classList.remove('selected');
              return;
            }
            fetch('/api/create-plan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: changelogText }),
            }).then(r => r.json()).then(result => {
              if (result.ok) {
                emit('open-changelog-editor', { filePath: result.path, tabId: tab.id });
              } else {
                appendStatus(tab, 'Failed to create changelog draft.');
                opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = false; });
                btn.classList.remove('selected');
              }
            }).catch(() => {
              appendStatus(tab, 'Failed to create changelog draft.');
              opts.querySelectorAll('.ask-option').forEach(b => { b.disabled = false; });
              btn.classList.remove('selected');
            });
            return;
          }
          // Batched selection — toggle freely, don't send yet
          // Clicking an option clears any custom typed answer
          const cardTextInput = card.querySelector('.ask-text-input');
          if (cardTextInput) cardTextInput.value = '';
          if (isMultiSelect) {
            btn.classList.toggle('selected');
            const selected = [];
            opts.querySelectorAll('.ask-option.selected').forEach(b => {
              selected.push(b.querySelector('.ask-option-label').textContent);
            });
            if (selected.length > 0) pendingAnswers[questionText] = selected.join(', ');
            else delete pendingAnswers[questionText];
          } else {
            opts.querySelectorAll('.ask-option').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            pendingAnswers[questionText] = optLabel;
          }
          updateSubmitState();
        });
        opts.appendChild(btn);
      }
      card.appendChild(opts);
    }
    // Text input — always present. When options also exist, acts as "write your own" override.
    const hasOptions = !!q.options?.length;
    if (hasOptions) {
      const divider = document.createElement('div');
      divider.className = 'ask-or-type';
      divider.textContent = 'Or type your own answer';
      card.appendChild(divider);
    }
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'ask-text-input';
    textInput.placeholder = hasOptions ? 'Custom answer\u2026' : 'Type your answer...';
    textInput.addEventListener('input', () => {
      const value = textInput.value.trim();
      if (value) {
        // Typing overrides any option selection
        const optsEl = card.querySelector('.ask-options');
        if (optsEl) optsEl.querySelectorAll('.ask-option.selected').forEach(b => b.classList.remove('selected'));
        pendingAnswers[questionText] = value;
      } else {
        // Empty input — fall back to selected option if any
        const selectedLbl = card.querySelector('.ask-options .ask-option.selected .ask-option-label');
        if (selectedLbl) pendingAnswers[questionText] = selectedLbl.textContent;
        else delete pendingAnswers[questionText];
      }
      updateSubmitState();
    });
    card.appendChild(textInput);
    wrap.appendChild(card);
  }

  // Submit button — sends all answers as a batch
  submitBtn.addEventListener('click', () => {
    wrap.querySelectorAll('.ask-option').forEach(b => { b.disabled = true; });
    wrap.querySelectorAll('.ask-text-input').forEach(i => { i.disabled = true; });
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitted';
    sendAskAnswer(tab, allQuestions, pendingAnswers);
  });
  wrap.appendChild(submitBar);

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

  const alwaysBtn = document.createElement('button');
  alwaysBtn.className = 'perm-btn perm-btn-always';
  alwaysBtn.innerHTML = '<span class="perm-btn-icon">' + ICON_CHECK + '</span>Always';

  const allowBtn = document.createElement('button');
  allowBtn.className = 'perm-btn perm-btn-allow';
  allowBtn.innerHTML = '<span class="perm-btn-icon">' + ICON_CHECK + '</span>Allow';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'perm-btn perm-btn-deny';
  denyBtn.innerHTML = '<span class="perm-btn-icon">' + ICON_X + '</span>Deny';

  // Status badge for resolved state
  const statusBadge = document.createElement('span');
  statusBadge.className = 'perm-status';
  statusBadge.hidden = true;

  const resolve = (behavior, always = false) => {
    if (always) _autoAllowTools.add(toolName);
    card.classList.remove('active-perm');
    card.classList.add('resolved', behavior === 'allow' ? 'resolved-allow' : 'resolved-deny');
    allowBtn.disabled = true;
    alwaysBtn.disabled = true;
    denyBtn.disabled = true;
    statusBadge.textContent = always ? 'Always' : (behavior === 'allow' ? 'Allowed' : 'Denied');
    statusBadge.hidden = false;
    sendPermissionResponse(tab, requestId, behavior, always);
    recordHookEvent(tab, behavior === 'deny' ? 'PermissionDenied' : 'PermissionRequest', (behavior === 'deny' ? 'denied' : (always ? 'always' : 'allowed')));
    // On deny: clear queued permissions and buffered messages — process is being killed
    if (behavior === 'deny') {
      tab._permQueue.length = 0;
      tab._msgBuffer.length = 0;
    }
    tab._activePerm = false;
    _showNextPerm(tab);
  };

  alwaysBtn.addEventListener('click', () => resolve('allow', true));
  allowBtn.addEventListener('click', () => resolve('allow'));
  denyBtn.addEventListener('click', () => resolve('deny'));

  actions.append(alwaysBtn, allowBtn, denyBtn, statusBadge);
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
function appendUser(tab, text, images, files) {
  const $msgs = tab.messagesEl;
  if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg msg-user';
  const bubble = document.createElement('div'); bubble.className = 'msg-bubble';
  if (files?.length) {
    for (const f of files) {
      const chip = document.createElement('div');
      chip.className = 'msg-file-chip';
      chip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:middle;margin-right:4px;opacity:0.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      chip.appendChild(document.createTextNode(f.name || f.path?.split(/[/\\]/).pop() || 'file'));
      chip.style.cssText = 'display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;background:rgba(255,255,255,0.08);font-size:12px;margin-bottom:4px;opacity:0.85;';
      bubble.appendChild(chip);
    }
  }
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
  scheduleSessionSnapshotSave(tab);
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
  $msgs.appendChild(el); pruneMessages($msgs); if (tab === activeTab()) scrollEnd();
  scheduleSessionSnapshotSave(tab);
}
function appendError(tab, text) {
  const $msgs = tab.messagesEl; if (!$msgs) return;
  const el = document.createElement('div'); el.className = 'msg-error'; el.textContent = text;
  $msgs.appendChild(el); pruneMessages($msgs); if (tab === activeTab()) scrollEnd();
  scheduleSessionSnapshotSave(tab);
}

function scrollEnd() {
  const tab = activeTab();
  const $msgs = tab?.messagesEl;
  if ($msgs) requestAnimationFrame(() => requestAnimationFrame(() => { $msgs.scrollTop = $msgs.scrollHeight; }));
}

// ── DOM pruning ──
// Prevent unbounded DOM growth by removing oldest messages when threshold exceeded.
const MAX_MSG_CHILDREN = 600;
const PRUNE_BATCH = 150;

function pruneMessages($msgs) {
  if (!$msgs || $msgs.childElementCount <= MAX_MSG_CHILDREN) return;
  const removeCount = Math.min(PRUNE_BATCH, $msgs.childElementCount - (MAX_MSG_CHILDREN - PRUNE_BATCH));
  for (let i = 0; i < removeCount; i++) {
    const child = $msgs.firstElementChild;
    if (!child) break;
    child.remove();
  }
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
        finishTab(tab, true);
        appendStatus(tab, 'Session timed out — no response received.');
        notify('panel', NOTIF_TYPE.ERROR, tab.label || 'Claude Code', { tabId: tab.id });
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
    $send.classList.remove('abort'); $send.classList.remove('btw'); $send.classList.remove('queue-mode'); $send.innerHTML = _ICON_SEND; $input.disabled = false; $input.focus();
  }
}

// Dynamic send icon: while running, show queue icon if text present (default), stop icon if empty
const _ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const _ICON_SEND = '<svg viewBox="0 0 24 24"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M12 5l7 7-7 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
const _ICON_QUEUE_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="7" x2="18" y2="7"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="17" x2="18" y2="17"/></svg>';
function _updateSendIcon($send, $input, forceShift) {
  if (!$send || !$input) return;
  const tab = activeTab();
  if (!tab?.running) return;
  const hasText = $input.value.trim().length > 0;
  $send.disabled = false;
  if (hasText) {
    $send.classList.remove('abort');
    if (forceShift) {
      // Shift held: show /btw send arrow
      $send.classList.add('btw'); $send.classList.remove('queue-mode');
      $send.innerHTML = _ICON_SEND;
    } else {
      // Default: show queue icon
      $send.classList.remove('btw'); $send.classList.add('queue-mode');
      $send.innerHTML = _ICON_QUEUE_SEND;
    }
  } else {
    $send.classList.add('abort'); $send.classList.remove('btw'); $send.classList.remove('queue-mode');
    $send.innerHTML = _ICON_STOP;
  }
}

function finishTab(tab, skipNotif) {
  const wasRunning = tab.running;
  hideThinking(tab); setRunning(tab, false); tab._wasRunning = false; tab.currentMsgEl = null; tab.currentMsgId = null; tab.pendingAskToolUseId = null; tab.pendingAskRequestId = null; tab.pendingAskBufferedAnswer = null; tab.askRenderedViaControl = false; tab.sendStartedAt = null; tab._exitPlanMsgId = null; tab._exitPlanPending = false; tab._exitPlanHandled = false; tab._exitPlanWasPlanMode = false; tab._planContentCaptured = false; if (tab._stream?.mdTimer) clearTimeout(tab._stream.mdTimer); tab._stream = null;
  if (tab.compacting) { tab.compacting = false; if (tab === activeTab()) _setCompactingUI(false); }
  saveTabs();
  if (wasRunning && !skipNotif) notify('panel', NOTIF_TYPE.DONE, tab.label || 'Claude Code', { tabId: tab.id });
}

// ── Info card renderer — for slash command output, hook events, and diagnostics ──
function appendInfoCard(tab, { title = '', kind = 'info', body = '', html = null } = {}) {
  const $msgs = tab?.messagesEl;
  if (!$msgs) return null;
  const el = document.createElement('div');
  el.className = 'msg msg-info-card cp-info-' + esc(kind);
  const inner = document.createElement('div');
  inner.className = 'cp-info-body';
  if (title) {
    const h = document.createElement('div');
    h.className = 'cp-info-title';
    h.textContent = title;
    inner.appendChild(h);
  }
  const content = document.createElement('div');
  content.className = 'cp-info-content';
  if (html) content.innerHTML = html;
  else content.textContent = body;
  inner.appendChild(content);
  el.appendChild(inner);
  $msgs.appendChild(el);
  if (tab === activeTab()) scrollEnd();
  return el;
}

// ── Slash command router ──
// Returns true if handled (caller should short-circuit and not send to Claude).
function runSlashCommand(tab, raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return false;
  const space = trimmed.indexOf(' ');
  const cmd = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
  const spec = SLASH_COMMANDS.find(c => c.name === cmd);
  if (!spec) return false;
  const $input = _panel?.querySelector('#cp-input');

  const clearInput = () => { if ($input) { $input.value = ''; autoResize(); } };

  switch (cmd) {
    case 'help': {
      clearInput();
      const rows = SLASH_COMMANDS
        .map(c => `<div class="cp-help-row"><span class="cp-help-cmd">/${esc(c.name)}</span><span class="cp-help-desc">${esc(c.desc)}</span></div>`)
        .join('');
      const keys = [
        ['Enter', 'Send message'],
        ['Shift+Enter', 'New line (while idle) — /btw interrupt (while running)'],
        ['Shift+Tab', 'Toggle plan mode'],
        ['Esc', 'Abort current response'],
        ['Esc Esc', 'Undo last exchange (visual)'],
        ['Ctrl+L', 'Clear messages'],
        ['Ctrl+O', 'Cycle view: normal → transcript → focus'],
        ['Ctrl+T', 'Toggle TODO panel'],
        ['Ctrl+R', 'Reverse-search prompt history'],
        ['Up / Down', 'Navigate prompt history (empty input)'],
        ['Tab', 'Accept slash-hint / autocomplete'],
        ['@file', 'Reference a file from project'],
        ['!cmd', 'Run command in Bash and include output'],
      ].map(([k, d]) => `<div class="cp-help-row"><span class="cp-help-cmd">${esc(k)}</span><span class="cp-help-desc">${esc(d)}</span></div>`).join('');
      appendInfoCard(tab, { title: 'Commands & Keybinds', kind: 'help', html: `<div class="cp-help-section-label">Slash commands</div>${rows}<div class="cp-help-section-label">Keybinds</div>${keys}` });
      return true;
    }
    case 'clear': { clearInput(); if (tab.messagesEl) tab.messagesEl.innerHTML = ''; return true; }
    case 'compact': {
      clearInput();
      if (tab.running) { appendStatus(tab, 'Cannot compact while Claude is processing.'); return true; }
      if (tab.ws?.readyState === WebSocket.OPEN) {
        tab.compacting = true;
        _setCompactingUI(true);
        tab.ws.send(JSON.stringify({ type: 'compact' }));
        appendStatus(tab, 'Compacting context...');
      }
      return true;
    }
    case 'model': {
      clearInput();
      const $model = _panel?.querySelector('#cp-model');
      if ($model) { $model.click(); $model.querySelector('.cp-dd-menu')?.classList.add('open'); }
      return true;
    }
    case 'resume': {
      clearInput();
      const $sessBtn = _panel?.querySelector('#cp-session-btn');
      const $sessMenu = _panel?.querySelector('#cp-session-menu');
      if ($sessMenu) { $sessMenu.classList.add('open'); renderSessionMenu(); }
      else if ($sessBtn) $sessBtn.click();
      return true;
    }
    case 'rename': {
      clearInput();
      const $sessLabel = _panel?.querySelector('.cp-session-label');
      renameSession(tab.sessionId || null, $sessLabel?.textContent || tab.label || '');
      return true;
    }
    case 'agents': {
      clearInput();
      const html = `
        <div class="cp-info-row"><b>Built-in Agent tool</b> — Claude can spawn isolated subagents via the <code>Agent</code> tool. Each has its own context window, custom system prompt, and tool restrictions.</div>
        <div class="cp-info-row"><b>Available via the Agent tool:</b><ul>
          <li><code>general-purpose</code> — multi-step research and tasks</li>
          <li><code>Explore</code> — fast codebase search</li>
          <li><code>Plan</code> — architecture planning</li>
          <li><code>claude-code-guide</code> — Claude Code / SDK / API docs</li>
          <li><code>statusline-setup</code> — configure status line</li>
        </ul></div>
        <div class="cp-info-row muted">Define custom agents in <code>.claude/agents/</code> or <code>~/.claude/agents/</code>.</div>`;
      appendInfoCard(tab, { title: 'Subagents', kind: 'info', html });
      return true;
    }
    case 'mcp': {
      clearInput();
      fetch('/api/claude-code/mcp').then(r => r.json()).then(d => {
        const installed = d?.installed ? '<span class="cp-info-ok">installed</span>' : '<span class="cp-info-warn">not installed</span>';
        appendInfoCard(tab, { title: 'MCP — SynaBun', kind: 'info', html: `<div class="cp-info-row">Status: ${installed}</div><div class="cp-info-row muted">Tool naming: <code>mcp__SynaBun__&lt;tool&gt;</code></div>` });
      }).catch(() => appendInfoCard(tab, { title: 'MCP', kind: 'info', body: 'Could not reach MCP status endpoint.' }));
      return true;
    }
    case 'memory': {
      clearInput();
      emit('memory:open');
      appendStatus(tab, 'Opening memory editor…');
      return true;
    }
    case 'init': {
      clearInput();
      if ($input) $input.value = 'Please analyze this codebase and create a CLAUDE.md file with the architecture, key patterns, and build/test commands. Keep it concise (≤200 lines).';
      send();
      return true;
    }
    case 'doctor': {
      clearInput();
      const wsOk = tab.ws && tab.ws.readyState === WebSocket.OPEN;
      const proj = tab.project || '(none)';
      const model = _getModelId() || '(default)';
      const effort = _getEffort() || 'off';
      const ctxw = _getContextWindow() || 0;
      const rows = [
        ['WebSocket', wsOk ? 'connected' : 'disconnected', wsOk ? 'ok' : 'warn'],
        ['Project', proj, proj === '(none)' ? 'warn' : 'ok'],
        ['Model', model, 'ok'],
        ['Thinking effort', effort, 'ok'],
        ['Context window', ctxw ? `${(ctxw/1000).toFixed(0)}K tokens` : '(auto)', 'ok'],
        ['Plan mode', tab.planMode ? 'on' : 'off', 'ok'],
        ['Queue', String(tab.queue?.length || 0), 'ok'],
        ['Running', tab.running ? 'yes' : 'no', 'ok'],
      ];
      const html = rows.map(([k, v, s]) => `<div class="cp-info-row"><span class="cp-doctor-k">${esc(k)}</span><span class="cp-doctor-v cp-info-${esc(s)}">${esc(v)}</span></div>`).join('');
      appendInfoCard(tab, { title: 'Doctor', kind: 'doctor', html });
      return true;
    }
    case 'context': {
      clearInput();
      const u = tab.usage || {};
      // Context window consumption = uncached input + cached prefixes.
      // Output tokens are generated, not part of the input context.
      const total = (u.inputTokens || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      const cw = tab.contextWindow || _getContextWindow() || 200000;
      const pct = Math.min(100, Math.round((total / cw) * 100));
      const html = `
        <div class="cp-info-row"><b>${total.toLocaleString()}</b> / ${cw.toLocaleString()} tokens used (${pct}%)</div>
        <div class="cp-info-row"><span class="cp-doctor-k">Input</span><span class="cp-doctor-v">${(u.inputTokens||0).toLocaleString()}</span></div>
        <div class="cp-info-row"><span class="cp-doctor-k">Output</span><span class="cp-doctor-v">${(u.outputTokens||0).toLocaleString()}</span></div>
        <div class="cp-info-row"><span class="cp-doctor-k">Cache read</span><span class="cp-doctor-v">${(u.cacheRead||0).toLocaleString()}</span></div>
        <div class="cp-info-row"><span class="cp-doctor-k">Cache write</span><span class="cp-doctor-v">${(u.cacheWrite||0).toLocaleString()}</span></div>`;
      appendInfoCard(tab, { title: 'Context', kind: 'info', html });
      return true;
    }
    case 'config': { clearInput(); emit('settings:open'); appendStatus(tab, 'Opening settings…'); return true; }
    case 'permissions': {
      clearInput();
      fetch('/api/claude-code/tool-permissions').then(r => r.json()).then(d => {
        const auto = _autoAcceptAll ? 'on (all tools auto-approve)' : 'off (prompt per tool)';
        const allow = d?.permissions?.allow || d?.allow || [];
        const html = `<div class="cp-info-row"><b>Auto-approve:</b> ${esc(auto)}</div>
          <div class="cp-info-row muted">${allow.length ? `${allow.length} tool rule(s) allowed` : 'No pre-approved tools.'}</div>
          <div class="cp-info-row"><em>Edit rules in <code>~/.claude/settings.json</code> under <code>permissions.allow</code>.</em></div>`;
        appendInfoCard(tab, { title: 'Permissions', kind: 'info', html });
      }).catch(() => appendInfoCard(tab, { title: 'Permissions', kind: 'info', body: 'Could not read permission settings.' }));
      return true;
    }
    case 'add-dir': {
      clearInput();
      const dir = args || prompt('Enter directory path to add to allowed file access:');
      if (!dir) return true;
      appendStatus(tab, `Added directory: ${dir} (applies to next session spawn)`);
      tab._addedDirs = tab._addedDirs || [];
      tab._addedDirs.push(dir);
      return true;
    }
    case 'theme': { clearInput(); emit('settings:open', { section: 'theme' }); return true; }
    case 'plugin': {
      clearInput();
      (async () => {
        try {
          const res = await fetch('/api/claude-code/skills').then(r => r.json());
          const skills = res.skills || [];
          const html = skills.length
            ? `<div class="cp-info-row"><b>${skills.length}</b> skills loaded</div>` + skills.slice(0, 20).map(s => `<div class="cp-info-row"><code>/${esc(s.name||s.dirName)}</code> — ${esc((s.description||'').slice(0,80))}</div>`).join('')
            : '<div class="cp-info-row muted">No skills installed.</div>';
          appendInfoCard(tab, { title: 'Plugins & Skills', kind: 'info', html });
        } catch { appendInfoCard(tab, { title: 'Plugins', kind: 'info', body: 'Could not list plugins.' }); }
      })();
      return true;
    }
    case 'status': {
      clearInput();
      const lines = [
        `Session: ${tab.sessionId || '(new)'} — "${tab.label}"`,
        `Model: ${_getModelId() || '(default)'}  ·  Effort: ${_getEffort()}`,
        `Plan mode: ${tab.planMode ? 'ON' : 'off'}  ·  Auto-approve: ${_autoAcceptAll ? 'ON' : 'off'}`,
        `Queue: ${tab.queue?.length || 0}  ·  Turns: ${tab.turns || 0}  ·  Cost: $${(tab.sessionCost || 0).toFixed(4)}`,
      ].join('\n');
      appendInfoCard(tab, { title: 'Status', kind: 'info', body: lines });
      return true;
    }
    case 'cost': { clearInput(); emit('cost:toggle'); return true; }
    case 'login': { clearInput(); window.open('https://claude.ai/login', '_blank'); return true; }
    case 'logout': { clearInput(); window.open('https://claude.ai/logout', '_blank'); return true; }
    case 'plan': {
      clearInput();
      tab.planMode = !tab.planMode;
      if (tab.planMode) { tab._planContent = null; tab._planContentCaptured = false; tab.planFilePath = ''; tab._editedPlanContent = null; tab._planModeStartedAt = Date.now(); tab._planModeStartMsgIndex = tab.messagesEl?.querySelectorAll('.msg.msg-assistant').length || 0; }
      const $plan = _panel?.querySelector('#cp-plan-toggle');
      if ($plan) $plan.classList.toggle('active', tab.planMode);
      appendStatus(tab, tab.planMode ? 'Plan mode ON — Claude will plan without making changes' : 'Plan mode OFF');
      return true;
    }
    case 'btw': {
      // /btw is a Shift+Enter interrupt; treat typed form as a no-op nudge here.
      clearInput();
      appendStatus(tab, '/btw — press Shift+Enter while Claude is processing to add context mid-turn.');
      return true;
    }
  }
  return false;
}

function send({ shift = false } = {}) {
  if (_cliInstalled === null || _cliInstallFailureForced) {
    notify({ type: NOTIF_TYPE.WARN, title: 'Claude CLI not installed', body: 'Install the Claude Code CLI before sending a message.' });
    return;
  }
  const tab = activeTab();
  if (!tab) return;
  const $input = _panel?.querySelector('#cp-input');
  const $project = _panel?.querySelector('#cp-project');
  const $model = _panel?.querySelector('#cp-model');
  if (!$input) return;
  const text = $input.value.trim();
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
  if (tab.running) {
    if (!text && !tab.attachedImages.length && !tab.attachedFiles.length) {
      // Empty send while running = abort (stop)
      tab.ws.send(JSON.stringify({ type: 'abort' })); return;
    }
    if (shift) {
      // Shift+Enter: /btw — interrupt and continue with new context
      tab.ws.send(JSON.stringify({ type: 'abort' }));
      tab._btwPending = { text, images: tab.attachedImages.length ? [...tab.attachedImages] : null, files: tab.attachedFiles.length ? [...tab.attachedFiles] : null };
      $input.value = ''; autoResize();
      appendUser(tab, text, tab._btwPending.images);
      hideSlashHints();
      return;
    }
    // Enter (default): add to queue
    const images = tab.attachedImages.length ? [...tab.attachedImages] : null;
    const files = tab.attachedFiles.length ? [...tab.attachedFiles] : null;
    $input.value = ''; autoResize();
    if (images) { tab.attachedImages = []; updateAttachBadge(); const preview = _panel?.querySelector('#cp-image-preview'); if (preview) preview.innerHTML = ''; }
    if (files) { tab.attachedFiles = []; updateAttachBadge(); }
    addToQueue(tab, text, images, files);
    hideSlashHints();
    // Pulse the count badge
    const $count = _panel?.querySelector('.cp-queue-count');
    if ($count) { $count.classList.remove('pulse'); void $count.offsetWidth; $count.classList.add('pulse'); }
    return;
  }
  if (!text && !tab.attachedImages.length && !tab.attachedFiles.length) return;

  // Clear post-plan action cards and stale exit-plan flags on new message
  tab.messagesEl?.querySelectorAll('.post-plan-card').forEach(el => { const msg = el.closest('.msg'); if (msg) msg.remove(); else el.remove(); });
  tab._exitPlanPending = false;
  tab._exitPlanHandled = false;
  tab._exitPlanWasPlanMode = false;

  // ── Client-side slash command router (CLI parity) ──
  if (text.startsWith('/')) {
    hideSlashHints();
    if (runSlashCommand(tab, text)) {
      _pushPromptHistory(tab, text);
      return;
    }
    // Unknown slash command — fall through to send as prompt.
  }

  // ── !bash shortcut — prefix a Bash-tool hint so Claude executes the command ──
  if (text.startsWith('!') && text.length > 1) {
    const cmd = text.slice(1).trim();
    $input.value = '';
    autoResize();
    _pushPromptHistory(tab, text);
    appendUser(tab, text, null); tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
    const bashPrompt = `Run this shell command in Bash and report the result. Do not explain, do not modify, just execute:\n\n\`\`\`bash\n${cmd}\n\`\`\``;
    const msg = {
      type: 'query', prompt: bashPrompt,
      cwd: ddGetValue($project) || undefined,
      sessionId: tab.sessionId || undefined,
      model: _getModelId() || undefined,
      effort: _getEffort() || undefined,
      windowId: _windowId,
    };
    hideSlashHints();
    tab.ws.send(JSON.stringify(msg));
    return;
  }

  if (tab.pendingAsk && text) {
    $input.value = ''; autoResize();
    const askImages = tab.attachedImages.length ? [...tab.attachedImages] : null;
    appendUser(tab, text, askImages); tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
    const answers = {};
    if (askImages) {
      answers[tab.pendingAsk.questionText] = text + `\n[${askImages.length} inspiration image(s) attached — visible in chat above]`;
      tab.attachedImages = [];
      updateAttachBadge();
      const preview = _panel?.querySelector('#cp-image-preview');
      if (preview) preview.innerHTML = '';
    } else {
      answers[tab.pendingAsk.questionText] = text;
    }
    sendAskAnswer(tab, tab.pendingAsk.questions, answers);
    tab.pendingAsk = null;
    return;
  }

  $input.value = ''; autoResize();
  const pendingImages = tab.attachedImages.length ? [...tab.attachedImages] : null;
  const pendingFiles = tab.attachedFiles.length ? [...tab.attachedFiles] : null;
  appendUser(tab, text, pendingImages, pendingFiles); tab.sendStartedAt = Date.now(); showThinking(tab); setRunning(tab, true);
  let prompt = buildPromptWithAttachments(tab, text);
  if (tab.planMode && prompt) {
    prompt = `[PLAN MODE — think step by step, create a detailed plan, do NOT make code changes.]\n\nCRITICAL — When you have questions or need clarification during planning:\n1. First call ToolSearch with query "select:AskUserQuestion" to load the tool schema\n2. Then call AskUserQuestion to present your questions as interactive options (2-4 choices per question, max 4 questions)\n3. NEVER write questions as plain text — ALWAYS use the AskUserQuestion tool\n4. Use ExitPlanMode when the plan is ready for approval\n\nSTRICT ORDERING — ExitPlanMode MUST be your FINAL action in the turn: do ALL research (Grep, Read, Glob) and write the full plan text BEFORE calling ExitPlanMode. Never emit any text or tool call AFTER ExitPlanMode — anything after is dropped and the user only sees the PLAN COMPLETE approval card.\n\n${prompt}`;
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
  _pushPromptHistory(tab, text);
  // Synthetic UserPromptSubmit hook event
  recordHookEvent(tab, 'UserPromptSubmit', text.slice(0, 50));
  tab.ws.send(JSON.stringify(msg));
}

// ── Message Queue System ──

const _ICON_QUEUE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="7" x2="18" y2="7"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="17" x2="18" y2="17"/></svg>';
const _ICON_PLAY = '<svg viewBox="0 0 16 16" width="10" height="10"><polygon points="4,2 14,8 4,14" fill="currentColor"/></svg>';
const _ICON_PAUSE = '<svg viewBox="0 0 16 16" width="10" height="10"><rect x="3" y="3" width="3" height="10" fill="currentColor"/><rect x="10" y="3" width="3" height="10" fill="currentColor"/></svg>';

function addToQueue(tab, text, images, files) {
  tab.queue.push({
    id: crypto.randomUUID(),
    text,
    images: images?.length ? [...images] : null,
    files: files?.length ? [...files] : null,
  });
  tab._queueWasActive = true;
  renderQueue(tab);
  saveTabs();
  // If Claude is idle and queue was just started and not paused, auto-advance
  if (tab.queue.length === 1 && !tab.running && !tab.queuePaused && !tab._activePerm && !tab.pendingAsk) {
    setTimeout(() => advanceQueue(tab), 300);
  }
}

function renderQueue(tab) {
  if (tab !== activeTab()) return;
  const $tray = _panel?.querySelector('#cp-queue-tray');
  const $items = $tray?.querySelector('.cp-queue-items');
  const $count = $tray?.querySelector('.cp-queue-count');
  if (!$tray || !$items || !$count) return;

  if (tab.queue.length === 0) {
    $tray.hidden = true;
    $tray.classList.remove('expanded');
    return;
  }

  $tray.hidden = false;
  $count.textContent = tab.queue.length;
  $tray.classList.toggle('paused', tab.queuePaused);
  if (tab.queueExpanded) $tray.classList.add('expanded');

  // Update pause button icon
  const $pause = $tray.querySelector('.cp-queue-pause');
  if ($pause) {
    $pause.classList.toggle('paused', tab.queuePaused);
    $pause.innerHTML = tab.queuePaused ? _ICON_PLAY : _ICON_PAUSE;
    $pause.title = tab.queuePaused ? 'Resume queue processing' : 'Pause queue processing';
  }

  $items.innerHTML = '';
  tab.queue.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'cp-queue-item';
    el.draggable = true;
    el.dataset.idx = idx;
    el.dataset.id = item.id;

    const drag = document.createElement('span');
    drag.className = 'cp-queue-drag';
    drag.textContent = '⠿';

    const textSpan = document.createElement('span');
    textSpan.className = 'cp-queue-text';
    textSpan.textContent = item.text.length > 60 ? item.text.slice(0, 60) + '…' : item.text;
    textSpan.title = item.text;

    const attachBadge = document.createElement('span');
    attachBadge.className = 'cp-queue-attach-badge';
    const parts = [];
    if (item.images?.length) parts.push(`${item.images.length}img`);
    if (item.files?.length) parts.push(`${item.files.length}file`);
    if (parts.length) attachBadge.textContent = parts.join('+');

    const editBtn = document.createElement('button');
    editBtn.className = 'cp-queue-edit';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9.5 2.5l4 4L5 15H1v-4z"/></svg>';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); editQueueItem(tab, item.id); });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'cp-queue-remove';
    removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>';
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeFromQueue(tab, item.id); });

    el.appendChild(drag);
    el.appendChild(textSpan);
    if (parts.length) el.appendChild(attachBadge);
    el.appendChild(editBtn);
    el.appendChild(removeBtn);

    // Drag-to-reorder handlers
    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      $items.querySelectorAll('.cp-queue-item').forEach(i => i.classList.remove('drag-over'));
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      const toIdx = parseInt(el.dataset.idx, 10);
      if (fromIdx === toIdx || isNaN(fromIdx) || isNaN(toIdx)) return;
      const [moved] = tab.queue.splice(fromIdx, 1);
      tab.queue.splice(toIdx, 0, moved);
      renderQueue(tab);
      saveTabs();
    });

    $items.appendChild(el);
  });
}

function advanceQueue(tab) {
  if (!tab.queue.length || tab.queuePaused || tab.running || tab._activePerm || tab.pendingAsk) return;
  const item = tab.queue.shift();
  // Brief highlight before sending
  const $tray = _panel?.querySelector('#cp-queue-tray');
  const firstItem = $tray?.querySelector('.cp-queue-item');
  if (firstItem) firstItem.classList.add('sending');
  setTimeout(() => {
    _sendQueued(tab, item);
    renderQueue(tab);
    saveTabs();
    // Queue complete notification
    if (tab.queue.length === 0 && !tab.queuePaused) {
      // Will fire after this message completes via done handler
    }
  }, 200);
}

function _sendQueued(tab, item) {
  if (!tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
  // Clear stale exit-plan flags before starting queued turn
  tab._exitPlanPending = false;
  tab._exitPlanHandled = false;
  tab._exitPlanWasPlanMode = false;
  const $project = _panel?.querySelector('#cp-project');
  appendUser(tab, item.text, item.images, item.files);
  tab.sendStartedAt = Date.now();
  showThinking(tab);
  setRunning(tab, true);

  // Restore attachments for buildPromptWithAttachments
  if (item.files) tab.attachedFiles = item.files;
  let prompt = buildPromptWithAttachments(tab, item.text);
  if (tab.planMode && prompt) {
    prompt = `[PLAN MODE — think step by step, create a detailed plan, do NOT make code changes.]\n\nCRITICAL — When you have questions or need clarification during planning:\n1. First call ToolSearch with query "select:AskUserQuestion" to load the tool schema\n2. Then call AskUserQuestion to present your questions as interactive options (2-4 choices per question, max 4 questions)\n3. NEVER write questions as plain text — ALWAYS use the AskUserQuestion tool\n4. Use ExitPlanMode when the plan is ready for approval\n\nSTRICT ORDERING — ExitPlanMode MUST be your FINAL action in the turn: do ALL research (Grep, Read, Glob) and write the full plan text BEFORE calling ExitPlanMode. Never emit any text or tool call AFTER ExitPlanMode — anything after is dropped and the user only sees the PLAN COMPLETE approval card.\n\n${prompt}`;
  }

  // Update pill label if first message
  if (tab.label === 'New chat' && item.text) {
    tab.label = trunc(item.text, 20);
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
  if (item.images) {
    msg.images = item.images.map(i => ({ base64: i.base64, mediaType: i.mediaType }));
    tab.attachedImages = [];
    updateAttachBadge();
    const preview = _panel?.querySelector('#cp-image-preview');
    if (preview) preview.innerHTML = '';
  }
  tab.ws.send(JSON.stringify(msg));
}

function pauseQueue(tab) {
  tab.queuePaused = !tab.queuePaused;
  renderQueue(tab);
  saveTabs();
  if (!tab.queuePaused && !tab.running && tab.queue.length) {
    setTimeout(() => advanceQueue(tab), 300);
  }
}

function removeFromQueue(tab, id) {
  tab.queue = tab.queue.filter(i => i.id !== id);
  renderQueue(tab);
  saveTabs();
}

function editQueueItem(tab, id) {
  const $tray = _panel?.querySelector('#cp-queue-tray');
  if (!$tray) return;
  const idx = tab.queue.findIndex(i => i.id === id);
  if (idx === -1) return;
  const item = tab.queue[idx];
  const $item = $tray.querySelector(`.cp-queue-item[data-id="${id}"]`);
  const $text = $item?.querySelector('.cp-queue-text');
  if (!$text) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = item.text;
  $text.textContent = '';
  $text.appendChild(input);
  input.focus();
  input.select();

  const commit = () => {
    const val = input.value.trim();
    if (val) {
      tab.queue[idx].text = val;
      saveTabs();
    }
    renderQueue(tab);
  };
  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); renderQueue(tab); }
  });
}

function clearQueue(tab) {
  tab.queue = [];
  tab.queuePaused = false;
  renderQueue(tab);
  saveTabs();
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
  ws.binaryType = 'blob';

  const frameRenderer = createFrameRenderer(canvas, ctx);
  _browserEmbed = { sessionId, ws, canvas, ctx, urlBar, container, frameRenderer };
  _browserEmbedVisible = true;

  ws.onmessage = (e) => {
    if (e.data instanceof Blob) {
      frameRenderer.render(e.data.slice(1));
      return;
    }
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'navigated' || msg.type === 'loaded' || msg.type === 'init') {
        if (msg.url) urlBar.value = msg.url;
      } else if (msg.type === 'error') {
        console.warn('[claude-panel] Browser embed error:', msg.message);
      }
    } catch {}
  };

  let _cpWsReconnAttempted = false;
  ws.onclose = () => {
    if (_browserEmbed?.sessionId === sessionId) {
      if (!_cpWsReconnAttempted) {
        _cpWsReconnAttempted = true;
        console.log('[claude-panel] Browser WS closed, retrying once for', sessionId);
        setTimeout(() => {
          if (_browserEmbed?.sessionId !== sessionId) return;
          const proto2 = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws2 = new WebSocket(`${proto2}//${location.host}/ws/browser/${sessionId}`);
          ws2.binaryType = 'blob';
          ws2.onmessage = ws.onmessage;
          ws2.onclose = () => { if (_browserEmbed?.sessionId === sessionId) hideBrowserEmbed(); };
          ws2.onerror = () => {};
          _browserEmbed.ws = ws2;
        }, 1500);
        return;
      }
      hideBrowserEmbed();
    }
  };

  // Show with animation
  container.classList.add('active', 'cp-browser-enter');
  container.addEventListener('animationend', () => {
    container.classList.remove('cp-browser-enter');
  }, { once: true });

  // Wire nav buttons
  _wireBrowserEmbedEvents();

  // No ResizeObserver needed — .cp-browser-canvas-wrap uses aspect-ratio: 16/10
  // and .cp-browser-canvas uses width: 100%; height: 100% via CSS.
  // Frames scale via canvas buffer dimensions + CSS layout automatically.
}

function hideBrowserEmbed() {
  if (!_browserEmbed) return;
  const { ws, container, ro, frameRenderer } = _browserEmbed;
  if (frameRenderer) frameRenderer.destroy();
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

  // Browser sessions are always rendered as floating windows — no side panel embed.
  // sync:browser:created, claude-panel:show-browser, and claude-panel:ensure-open
  // are intentionally NOT handled here.
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
      // Apply user's default model preference (per-tab model restored later by switchTab())
      const defModel = _getDefaultModel();
      ddPopulateModels($model, items, defModel);
      // Clean up stale global key (model now lives per-tab only)
      storage.removeItem(STOR.model);
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

// ── Recall Profile ──

const RECALL_PROFILES_META = [
  { value: 'quick',    label: 'Quick',    hint: '3 results' },
  { value: 'balanced', label: 'Balanced', hint: '5 results' },
  { value: 'deep',     label: 'Deep',     hint: '10 results' },
  { value: 'custom',   label: 'Custom',   hint: 'custom' },
];
const RECALL_PROFILE_DEFAULTS = {
  quick:    { limit: 3,  minImportance: 5, minScore: 0.45, maxChars: 300,  includeSessions: 'never',  recencyBoost: false },
  balanced: { limit: 5,  minImportance: 0, minScore: 0.30, maxChars: 0,    includeSessions: 'auto',   recencyBoost: false },
  deep:    { limit: 10, minImportance: 0, minScore: 0.20, maxChars: 0,    includeSessions: 'always', recencyBoost: false },
};

let _recallProfile = 'balanced';

async function loadRecallProfile() {
  const $recall = _panel?.querySelector('#cp-recall');
  if (!$recall) return;
  try {
    const data = await fetch('/api/display-settings').then(r => r.json());
    if (data.profile) _recallProfile = data.profile;
  } catch {}
  populateRecallDropdown($recall);
}

function populateRecallDropdown($dd) {
  const menu = $dd.querySelector('.cp-dd-menu');
  const label = $dd.querySelector('.cp-dd-label');
  if (!menu || !label) return;
  menu.innerHTML = '';
  const matched = RECALL_PROFILES_META.find(p => p.value === _recallProfile);
  label.textContent = matched ? matched.label : _recallProfile;
  $dd.classList.add('has-value');
  $dd._value = _recallProfile;
  for (const p of RECALL_PROFILES_META) {
    const el = document.createElement('div');
    el.className = 'cp-dd-item' + (p.value === _recallProfile ? ' selected' : '');
    el.dataset.value = p.value;
    el.innerHTML = `<span>${p.label}</span><span style="opacity:0.35;margin-left:auto;font-size:9px">${p.hint}</span>`;
    el.style.display = 'flex'; el.style.gap = '6px';
    el.addEventListener('click', () => {
      if (p.value === _recallProfile) { $dd.classList.remove('open'); return; }
      _recallProfile = p.value;
      $dd._value = p.value;
      label.textContent = p.label;
      $dd.classList.remove('open');
      menu.querySelectorAll('.cp-dd-item').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      saveRecallProfile(p.value);
    });
    menu.appendChild(el);
  }
}

async function saveRecallProfile(profile) {
  try {
    const current = await fetch('/api/display-settings').then(r => r.json());
    const defaults = RECALL_PROFILE_DEFAULTS[profile] || current.recallDefaults || RECALL_PROFILE_DEFAULTS.balanced;
    await fetch('/api/display-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...current, profile, recallDefaults: profile !== 'custom' ? defaults : current.recallDefaults }),
    });
  } catch (e) {
    console.error('Failed to save recall profile:', e);
  }
}

function syncReservedWidth() {
  if (_visible && _panel) {
    reserveRightPanelLayout(PANEL_OWNER, _panel, 20);
    document.querySelector('.fe-editor-panel')?.classList.add('panel-adjacent');
  } else if (clearRightPanelLayout(PANEL_OWNER)) {
    document.querySelector('.fe-editor-panel')?.classList.remove('panel-adjacent');
  }
}

// ── CLI installation status (banner + send-block) ──
let _cliInstallFailureForced = false;

function _ensureCliBannerEl() {
  if (!_panel) return null;
  const container = _panel.querySelector('#cp-messages-container');
  if (!container || !container.parentNode) return null;
  let banner = container.parentNode.querySelector(':scope > .cp-cli-banner');
  if (banner) return banner;
  const label = getCliLabel('claude-code');
  const cmd = getCliInstallCommand('claude-code');
  const url = getCliDocUrl('claude-code');
  banner = document.createElement('div');
  banner.className = 'cp-cli-banner';
  banner.innerHTML = `
    <div class="cp-cli-banner-icon">!</div>
    <div class="cp-cli-banner-text">
      <div class="cp-cli-banner-title">${label} CLI not installed</div>
      <div class="cp-cli-banner-body">Run <code>${cmd}</code> or follow the install guide.</div>
    </div>
    <div class="cp-cli-banner-actions">
      <a class="cp-cli-banner-link" href="${url}" target="_blank" rel="noopener noreferrer">Install guide</a>
      <button class="cp-cli-banner-recheck" type="button">Re-check</button>
    </div>
  `;
  container.parentNode.insertBefore(banner, container);
  const btn = banner.querySelector('.cp-cli-banner-recheck');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try { await recheckCliStatus('claude-code'); }
    finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = 'Re-check';
      }
    }
  });
  return banner;
}

function _removeCliBannerEl() {
  if (!_panel) return;
  const banner = _panel.querySelector(':scope > .cp-cli-banner');
  banner?.remove();
}

function _refreshCliBanners() {
  if (!_panel) return;
  const missing = _cliInstalled === null || _cliInstallFailureForced;
  _panel.classList.toggle('cp-cli-blocked', missing);
  if (missing) _ensureCliBannerEl();
  else _removeCliBannerEl();
  const $send = _panel.querySelector('#cp-send');
  if ($send && missing) $send.disabled = true;
}

export function flagClaudeCliInstallFailure() {
  _cliInstallFailureForced = true;
  _refreshCliBanners();
  recheckCliStatus('claude-code').catch(() => {});
}

function _ensureCliSubscription() {
  if (_cliUnsub) return;
  _cliUnsub = subscribeCliStatus('claude-code', (info) => {
    _cliInstalled = info?.installed || null;
    if (_cliInstalled) _cliInstallFailureForced = false;
    _refreshCliBanners();
  });
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
    window.dispatchEvent(new CustomEvent('sidepanel-tray:provider-loaded', { detail: { provider: 'claude' } }));
    _ensureCliSubscription();
  }
  _visible = !_visible;
  if (_visible) {
    if (_tabs.length === 0) createTab(null, 'New chat');
    state.lastActivePanel = 'claude';
    _panel.classList.add('open');
    syncReservedWidth();
    _panel.querySelector('#cp-input')?.focus();
    _refreshCliBanners();
  } else {
    const tab = activeTab();
    const $input = _panel?.querySelector('#cp-input');
    if (tab && $input) tab.draft = $input.value;
    _panel.classList.remove('open');
    syncReservedWidth();
  }
  renderPills(); // Sync pill visibility with panel open/close state
  window.dispatchEvent(new Event('resize'));
}

export function isClaudePanelOpen() { return _visible; }

/** Open the panel (if closed) and pre-fill the input with text, placing cursor at the end.
 *  If opts.asFile is true or text looks like a file path, attach as a file chip instead. */
export async function sendToPanel(text, opts = {}) {
  if (!_visible) await toggleClaudePanel();

  // Create a fresh tab if requested
  if (opts.newTab) {
    createTab(null, opts.tabLabel || 'New chat');
  }

  const tab = activeTab();
  if (!tab) return;

  // Detect file paths — attach as file chip instead of text (skip for autoSubmit — those are commands, not paths)
  const looksLikePath = !opts.autoSubmit && (opts.asFile || /^[A-Za-z]:[/\\]/.test(text) || (text.startsWith('/') && text.includes('/') && !text.includes(' ')));
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

  // Auto-submit: wait for WebSocket to be ready, then click send
  if (opts.autoSubmit) {
    $input.dispatchEvent(new Event('input', { bubbles: true }));
    const trySubmit = () => {
      const t = activeTab();
      if (t?.ws?.readyState === WebSocket.OPEN) {
        const $send = _panel?.querySelector('#cp-send');
        if ($send) { $send.disabled = false; $send.click(); }
      } else {
        setTimeout(trySubmit, 150);
      }
    };
    setTimeout(trySubmit, 150);
  }
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
    const seen = new Set(_skillsCache.map(s => s.name));
    // Merge every built-in slash command from the CLI-parity registry
    for (const b of SLASH_COMMANDS) {
      if (!seen.has(b.name)) { _skillsCache.push({ name: b.name, description: b.desc }); seen.add(b.name); }
    }
    // Extras beyond the SLASH_COMMANDS registry (skills that still appear as `/foo`)
    const extras = [
      { name: 'commit', description: 'Stage and commit changes' },
      { name: 'review-pr', description: 'Review a pull request' },
      { name: 'simplify', description: 'Review changed code for quality and efficiency' },
      { name: 'loop', description: 'Run a command on a recurring interval' },
    ];
    for (const b of extras) { if (!seen.has(b.name)) { _skillsCache.push(b); seen.add(b.name); } }
    try {
      const pc = await fetch('/api/claude-code/plugin-commands').then(r => r.json());
      for (const c of (pc?.commands || [])) {
        if (!c?.name || seen.has(c.name)) continue;
        const label = c.plugin ? `${c.description || ''}${c.description ? ' · ' : ''}(plugin: ${c.plugin})` : (c.description || '');
        _skillsCache.push({ name: c.name, description: label });
        seen.add(c.name);
      }
    } catch {}
    _skillsCache.sort((a, b) => a.name.localeCompare(b.name));
  } catch { _skillsCache = SLASH_COMMANDS.map(c => ({ name: c.name, description: c.desc })); }
  return _skillsCache;
}
async function showSlashHints(filter) {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  if (!$hints) return;
  if (!_skillsCache) await loadSkills();
  if (!_skillsCache) return;
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

// ── Prompt history (per-tab, Up/Down recall + Ctrl+R reverse search) ──
function _pushPromptHistory(tab, text) {
  if (!tab || !text) return;
  const t = text.trim();
  if (!t) return;
  if (tab.promptHistory[tab.promptHistory.length - 1] === t) return; // dedup consecutive
  tab.promptHistory.push(t);
  if (tab.promptHistory.length > 200) tab.promptHistory.shift();
  tab.promptHistoryIdx = -1;
}
function _navigatePromptHistory(tab, dir, $input) {
  if (!tab?.promptHistory?.length || !$input) return false;
  if (tab.promptHistoryIdx === -1 && dir < 0) {
    tab.promptHistoryIdx = tab.promptHistory.length - 1;
  } else {
    tab.promptHistoryIdx = Math.min(tab.promptHistory.length - 1, Math.max(-1, tab.promptHistoryIdx + dir));
  }
  if (tab.promptHistoryIdx === -1) { $input.value = ''; }
  else { $input.value = tab.promptHistory[tab.promptHistoryIdx] || ''; }
  autoResize();
  return true;
}

// ── Ctrl+R reverse-search modal ──
function _openReverseSearch() {
  const tab = activeTab(); if (!tab) return;
  if (_panel.querySelector('.cp-rsearch')) return;
  const $input = _panel.querySelector('#cp-input');
  const modal = document.createElement('div');
  modal.className = 'cp-rsearch';
  modal.innerHTML = `
    <div class="cp-rsearch-inner">
      <div class="cp-rsearch-header">↑↓ navigate · Enter accept · Esc cancel</div>
      <input class="cp-rsearch-input" placeholder="Reverse-i-search: type to search history" autofocus>
      <div class="cp-rsearch-results"></div>
    </div>`;
  _panel.appendChild(modal);
  const $q = modal.querySelector('.cp-rsearch-input');
  const $list = modal.querySelector('.cp-rsearch-results');
  let selected = 0;
  const hist = tab.promptHistory.slice().reverse();
  const render = (query) => {
    const q = query.toLowerCase();
    const matches = q ? hist.filter(h => h.toLowerCase().includes(q)) : hist;
    $list.innerHTML = matches.slice(0, 30).map((h, i) => `<div class="cp-rsearch-row${i===selected?' active':''}" data-idx="${i}">${esc(h.slice(0,200))}</div>`).join('') || '<div class="cp-rsearch-empty">No matches</div>';
    return matches;
  };
  let matches = render('');
  $q.addEventListener('input', () => { selected = 0; matches = render($q.value); });
  $q.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { modal.remove(); $input?.focus(); }
    else if (e.key === 'Enter') { if (matches[selected]) { $input.value = matches[selected]; autoResize(); } modal.remove(); $input?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(matches.length - 1, selected + 1); render($q.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(0, selected - 1); render($q.value); }
  });
  $list.addEventListener('click', (e) => {
    const row = e.target.closest('.cp-rsearch-row');
    if (!row) return;
    const i = +row.dataset.idx;
    if (matches[i]) { $input.value = matches[i]; autoResize(); }
    modal.remove(); $input?.focus();
  });
}

// ── @file autocomplete (uses /api/project-files with recursive search) ──
let _fileSuggestReq = 0;
async function _fetchFileSuggest(projectPath, query) {
  if (!projectPath) return [];
  const q = (query || '').trim();
  try {
    const url = '/api/project-files?' + new URLSearchParams({ path: projectPath, search: q || 'a' });
    const res = await fetch(url).then(r => r.ok ? r.json() : null);
    if (!res?.items) return [];
    return res.items
      .filter(it => it.type === 'file')
      .map(it => (it.path || it.name || '').replace(/^\//, ''))
      .slice(0, 20);
  } catch { return []; }
}
async function _showFileHints(query) {
  const $hints = _panel?.querySelector('#cp-slash-hints');
  const tab = activeTab();
  if (!$hints || !tab?.project) { hideSlashHints(); return; }
  const reqId = ++_fileSuggestReq;
  const matches = await _fetchFileSuggest(tab.project, query);
  if (reqId !== _fileSuggestReq) return; // stale
  if (!matches.length) { hideSlashHints(); return; }
  $hints.innerHTML = matches.map((p, i) => `<div class="cp-slash-item${i===0?' active':''}" data-file="${esc(p)}"><div class="cp-slash-name">@${esc(p.split('/').pop())}</div><div class="cp-slash-desc">${esc(p)}</div></div>`).join('');
  $hints.querySelectorAll('.cp-slash-item').forEach(el => el.addEventListener('click', () => {
    const $input = _panel?.querySelector('#cp-input');
    if (!$input) return;
    const val = $input.value;
    const at = val.lastIndexOf('@');
    if (at >= 0) $input.value = val.slice(0, at) + '@' + el.dataset.file + ' ';
    $input.focus(); hideSlashHints(); autoResize();
  }));
  _slashHintIdx = 0;
  $hints.classList.add('open');
  $hints.dataset.mode = 'file';
}

// ── Todo slide-out dock (TodoWrite tool visualization) ──
function renderTodoWidget(tab) {
  if (!tab?.messagesEl || !_panel) return;
  let dock = _panel.querySelector('.cp-todo-dock');

  if (!tab.todos?.length) { dock?.remove(); return; }

  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'cp-todo-dock cp-todo-dock--left';
    _panel.appendChild(dock);
  }

  const doneN  = tab.todos.filter(t => t.status === 'completed').length;
  const totalN = tab.todos.length;
  const inProg = tab.todos.find(t => t.status === 'in_progress');
  const isOpen = !!tab.todosVisible;
  dock.classList.toggle('is-open', isOpen);

  dock.innerHTML = `
    <button class="cp-todo-tag" title="${isOpen ? 'Hide' : 'Show'} TODOs (Ctrl+T)">
      <span class="cp-todo-tag-ic">${inProg ? '◐' : '✓'}</span>
      <span class="cp-todo-tag-count">${doneN}/${totalN}</span>
      ${inProg ? '<span class="cp-todo-tag-pulse"></span>' : ''}
    </button>
    <div class="cp-todo-drawer">
      <div class="cp-todo-head">
        <span class="cp-todo-title">TODOs</span>
        <span class="cp-todo-count">${doneN}/${totalN}</span>
        <button class="cp-todo-hide" title="Collapse (Ctrl+T)">×</button>
      </div>
      <div class="cp-todo-list">
        ${tab.todos.map(t => {
          const ic = t.status === 'completed' ? '✓' : (t.status === 'in_progress' ? '◐' : '○');
          const cls = t.status === 'completed' ? 'done' : (t.status === 'in_progress' ? 'prog' : 'pend');
          const label = t.status === 'in_progress' ? (t.activeForm || t.content) : t.content;
          return `<div class="cp-todo-item cp-todo-${cls}"><span class="cp-todo-ic">${ic}</span><span class="cp-todo-txt">${esc(label || '')}</span></div>`;
        }).join('')}
      </div>
      ${inProg ? `<div class="cp-todo-foot">Active: ${esc(inProg.activeForm || inProg.content)}</div>` : ''}
    </div>`;

  dock.querySelector('.cp-todo-tag')?.addEventListener('click', () => {
    tab.todosVisible = !tab.todosVisible;
    renderTodoWidget(tab);
  });
  dock.querySelector('.cp-todo-hide')?.addEventListener('click', (e) => {
    e.stopPropagation();
    tab.todosVisible = false;
    renderTodoWidget(tab);
  });
}

// ── View mode cycling (normal / transcript / focus) ──
function _applyViewMode(tab) {
  if (!tab?.messagesEl) return;
  const $msgs = tab.messagesEl;
  $msgs.classList.remove('cp-view-transcript', 'cp-view-focus');
  if (tab.viewMode === 'transcript') $msgs.classList.add('cp-view-transcript');
  else if (tab.viewMode === 'focus') $msgs.classList.add('cp-view-focus');
}

function populateViewDropdown($dd, tab) {
  if (!$dd || !tab) return;
  const menu = $dd.querySelector('.cp-dd-menu');
  const label = $dd.querySelector('.cp-dd-label');
  if (!menu || !label) return;
  const mode = tab.viewMode || 'normal';
  menu.innerHTML = '';
  label.textContent = VIEW_MODE_LABELS[mode] || mode;
  $dd.classList.add('has-value');
  $dd._value = mode;
  for (const v of VIEW_MODES) {
    const el = document.createElement('div');
    el.className = 'cp-dd-item' + (v === mode ? ' selected' : '');
    el.dataset.value = v;
    el.textContent = VIEW_MODE_LABELS[v] || v;
    el.addEventListener('click', () => {
      const t = activeTab();
      if (!t) return;
      if (v === t.viewMode) { $dd.classList.remove('open'); return; }
      t.viewMode = v;
      _applyViewMode(t);
      populateViewDropdown($dd, t);
      $dd.classList.remove('open');
    });
    menu.appendChild(el);
  }
}

// ── Hook event activity strip (synthetic hook events from stream) ──
function recordHookEvent(tab, event, detail = '') {
  if (!tab) return;
  tab.hookEvents = tab.hookEvents || [];
  tab.hookEvents.push({ event, detail, at: Date.now() });
  if (tab.hookEvents.length > 30) tab.hookEvents.shift();
  renderHookStrip(tab);
}
function renderHookStrip(tab) {
  if (!tab?.messagesEl) return;
  const parent = tab.messagesEl.parentElement?.parentElement;
  if (!parent) return;
  let strip = parent.querySelector('.cp-hook-strip');
  if (!tab.hookStripVisible) { strip?.remove(); return; }
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'cp-hook-strip';
    tab.messagesEl.parentElement.after(strip);
  }
  const recent = tab.hookEvents.slice(-6);
  strip.innerHTML = `<div class="cp-hook-strip-title">Hook events</div>` + recent.map(h =>
    `<div class="cp-hook-ev" title="${esc(h.detail)}"><span class="cp-hook-dot"></span><span class="cp-hook-name">${esc(h.event)}</span>${h.detail ? `<span class="cp-hook-detail">${esc(h.detail.slice(0,60))}</span>` : ''}</div>`
  ).join('');
}

// ── MCP call collapse (group adjacent same-name MCP tool cards) ──
function collapseAdjacentMcpTools($msgs) {
  if (!$msgs) return;
  const cards = $msgs.querySelectorAll('.tool-card[data-tool-name^="mcp__"]');
  if (cards.length < 2) return;
  let group = [];
  const flush = () => {
    if (group.length < 2) { group = []; return; }
    const first = group[0];
    const name = first.dataset.toolName;
    const existing = first.querySelector('.tool-mcp-badge');
    if (!existing) {
      const badge = document.createElement('span');
      badge.className = 'tool-mcp-badge';
      badge.textContent = `×${group.length}`;
      first.querySelector('.tool-hdr')?.appendChild(badge);
    } else {
      existing.textContent = `×${group.length}`;
    }
    for (let i = 1; i < group.length; i++) group[i].classList.add('cp-mcp-collapsed');
    group = [];
  };
  let prevName = null;
  for (const c of cards) {
    const n = c.dataset.toolName;
    if (n === prevName) { group.push(c); }
    else { flush(); group = [c]; prevName = n; }
  }
  flush();
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

  const $brand = _panel.querySelector('.cp-brand');
  if ($brand) $brand.addEventListener('click', () => window.open('https://claude.ai/settings/usage', '_blank'));

  $input.addEventListener('input', async () => {
    autoResize();
    const tab = activeTab();
    if (tab?.running) {
      _updateSendIcon($send, $input);
    } else {
      $send.disabled = !$input.value.trim() && !tab?.attachedImages.length && !tab?.attachedFiles.length;
    }
    // Reset history navigation when user types
    if (tab) tab.promptHistoryIdx = -1;
    // Slash command hints
    const text = $input.value;
    if (text.startsWith('/') && !text.includes('\n')) {
      const cmd = text.slice(1).split(/\s/)[0];
      if (!text.includes(' ')) { showSlashHints(cmd); } else { hideSlashHints(); }
      return;
    }
    // @file autocomplete — trigger when caret is after an @token without space
    const caret = $input.selectionStart ?? text.length;
    const head = text.slice(0, caret);
    const atMatch = head.match(/(^|\s)@([^\s]*)$/);
    if (atMatch) {
      _showFileHints(atMatch[2]);
      return;
    }
    hideSlashHints();
  });
  $input.addEventListener('keydown', (e) => {
    const tab = activeTab();
    // Slash hint navigation
    const $hints = _panel?.querySelector('#cp-slash-hints');
    if ($hints?.classList.contains('open')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateSlashHints(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateSlashHints(-1); return; }
      if (e.key === 'Tab') { e.preventDefault(); acceptSlashHint(); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashHints(); return; }
      if (e.key === 'Enter') {
        // Accept hint on Enter when a slash match is visible and input is only "/cmd..."
        const text = $input.value;
        if (text.startsWith('/') && !text.includes(' ') && acceptSlashHint()) { e.preventDefault(); return; }
      }
    }
    // Up/Down prompt history (only when input is empty or already navigating)
    if (tab && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const navigating = tab.promptHistoryIdx !== -1;
      const emptyOrAtBoundary = !$input.value.trim() || navigating;
      if (emptyOrAtBoundary) {
        if (_navigatePromptHistory(tab, e.key === 'ArrowUp' ? -1 : 1, $input)) {
          e.preventDefault();
          return;
        }
      }
    }
    // Ctrl+R reverse search — disabled (conflicts with browser reload)
    // if (e.key === 'r' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); _openReverseSearch(); return; }
    // Ctrl+O cycle view mode
    if (e.key === 'o' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!tab) return;
      const i = VIEW_MODES.indexOf(tab.viewMode || 'normal');
      tab.viewMode = VIEW_MODES[(i + 1) % VIEW_MODES.length];
      _applyViewMode(tab);
      populateViewDropdown(_panel?.querySelector('#cp-view'), tab);
      return;
    }
    // Ctrl+T toggle todo widget
    if (e.key === 't' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      if (!tab) return;
      tab.todosVisible = !tab.todosVisible;
      renderTodoWidget(tab);
      return;
    }
    // Ctrl+Shift+H toggle hook activity strip
    if ((e.key === 'h' || e.key === 'H') && (e.ctrlKey || e.metaKey) && e.shiftKey) {
      e.preventDefault();
      if (!tab) return;
      tab.hookStripVisible = !tab.hookStripVisible;
      renderHookStrip(tab);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); hideSlashHints(); send(); }
    // Shift+Enter while running = /btw interrupt (otherwise default newline behavior)
    if (e.key === 'Enter' && e.shiftKey && tab?.running && $input.value.trim()) { e.preventDefault(); hideSlashHints(); send({ shift: true }); return; }
    // Shift+Tab to toggle plan mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (!tab) return;
      tab.planMode = !tab.planMode;
      if (tab.planMode) { tab._planContent = null; tab._planContentCaptured = false; tab.planFilePath = ''; tab._editedPlanContent = null; tab._planModeStartedAt = Date.now(); tab._planModeStartMsgIndex = tab.messagesEl?.querySelectorAll('.msg.msg-assistant').length || 0; }
      const $plan = _panel?.querySelector('#cp-plan-toggle');
      if ($plan) $plan.classList.toggle('active', tab.planMode);
      appendStatus(tab, tab.planMode ? 'Plan mode ON — Claude will plan without making changes' : 'Plan mode OFF');
      return;
    }
    // Ctrl+L to clear
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (tab?.messagesEl) tab.messagesEl.innerHTML = ''; }
    // Escape — double-tap to undo last exchange; single-tap to abort (when running)
    if (e.key === 'Escape') {
      if (tab?.running && !$input.value.trim()) { tab.ws?.send(JSON.stringify({ type: 'abort' })); return; }
      const now = Date.now();
      if (tab && now - (tab.lastEscAt || 0) < 600) {
        // Undo visually: remove trailing user + assistant pair from messages
        const $msgs = tab.messagesEl;
        if ($msgs) {
          const kids = [...$msgs.children];
          let removed = 0;
          for (let i = kids.length - 1; i >= 0 && removed < 2; i--) {
            const n = kids[i];
            if (n.classList.contains('msg-user') || n.classList.contains('msg-assistant')) { n.remove(); removed++; }
            else if (removed === 0) n.remove();
          }
          if (removed) appendStatus(tab, 'Undid last exchange (visual only — session memory unchanged).');
        }
        tab.lastEscAt = 0;
      } else if (tab) {
        tab.lastEscAt = now;
      }
    }
  });
  // Shift key visual hint: swap queue icon ↔ /btw arrow while shift held
  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && activeTab()?.running) _updateSendIcon($send, $input, true);
  });
  $input.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' && activeTab()?.running) _updateSendIcon($send, $input, false);
  });
  $send.addEventListener('click', send);

  // Queue tray event wiring
  const $queueTray = _panel.querySelector('#cp-queue-tray');
  if ($queueTray) {
    $queueTray.querySelector('.cp-queue-header').addEventListener('click', (e) => {
      // Don't toggle expand when clicking action buttons
      if (e.target.closest('.cp-queue-actions')) return;
      const tab = activeTab();
      if (!tab) return;
      tab.queueExpanded = !tab.queueExpanded;
      $queueTray.classList.toggle('expanded', tab.queueExpanded);
    });
    $queueTray.querySelector('.cp-queue-pause').addEventListener('click', (e) => {
      e.stopPropagation();
      const tab = activeTab();
      if (tab) pauseQueue(tab);
    });
    $queueTray.querySelector('.cp-queue-clear').addEventListener('click', (e) => {
      e.stopPropagation();
      const tab = activeTab();
      if (tab) clearQueue(tab);
    });
  }

  $close.addEventListener('click', () => closeTab(_activeTabIdx));
  $slide.addEventListener('click', () => toggleClaudePanel());
  $minimize.addEventListener('click', () => {
    if (_visible) toggleClaudePanel();
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
    fileInput.accept = 'image/*,text/*,.js,.ts,.jsx,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.json,.yaml,.yml,.toml,.md,.sh,.sql,.xml,.csv';
    document.body.appendChild(fileInput);
    $attach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const tab = activeTab();
      if (!tab) return;
      for (const file of fileInput.files) {
        // Images → attach as image (base64), same as paste/drop
        if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.split(',')[1];
            const mediaType = file.type;
            tab.attachedImages.push({ base64, mediaType });
            updateAttachBadge();
            addImagePreview(dataUrl, tab.attachedImages.length - 1);
            $send.disabled = false;
          };
          reader.readAsDataURL(file);
          continue;
        }
        // Text/code files
        if (!_isTextFile(file.name)) {
          appendStatus(tab, `Skipped "${file.name}" — only text/code or image files supported`);
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
    if (_tabs.length >= MAX_TABS) { appendStatus(activeTab(), 'Max sessions reached — close one first.'); return; }
    createTab(null, 'New chat');
    promptNameNewSession();
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
      const tab = activeTab();
      if (tab) { tab.effort = next; saveTabs(); }
    });
  }

  // Plan mode toggle
  const $plan = _panel.querySelector('#cp-plan-toggle');
  if ($plan) {
    $plan.addEventListener('click', () => {
      const tab = activeTab();
      if (!tab) return;
      tab.planMode = !tab.planMode;
      if (tab.planMode) { tab._planContent = null; tab._planContentCaptured = false; tab.planFilePath = ''; tab._editedPlanContent = null; tab._planModeStartedAt = Date.now(); tab._planModeStartMsgIndex = tab.messagesEl?.querySelectorAll('.msg.msg-assistant').length || 0; }
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

  // ── Voice input (push-to-talk via Web Speech API) ──
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const $mic = _panel.querySelector('#cp-mic');
  if (!SpeechRecognition || !$mic) {
    if ($mic) $mic.classList.add('unsupported');
  } else {
    let _recognition = null;
    let _voicePrefix = '';

    function startVoice() {
      if (_recognition) return;
      _voicePrefix = $input.value;
      _recognition = new SpeechRecognition();
      _recognition.continuous = true;
      _recognition.interimResults = true;
      _recognition.lang = 'en-US';
      _recognition.onresult = (ev) => {
        let transcript = '';
        for (let i = 0; i < ev.results.length; i++) {
          transcript += ev.results[i][0].transcript;
        }
        $input.value = _voicePrefix + (_voicePrefix && transcript ? ' ' : '') + transcript;
        autoResize();
        $input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      _recognition.onerror = (ev) => {
        $mic.classList.remove('recording');
        if (ev.error === 'not-allowed') {
          const tab = activeTab();
          if (tab) appendStatus(tab, 'Microphone permission denied — allow it in browser settings.');
        }
        _recognition = null;
      };
      _recognition.onend = () => {
        $mic.classList.remove('recording');
        _recognition = null;
      };
      _recognition.start();
      $mic.classList.add('recording');
    }

    function stopVoice() {
      if (!_recognition) return;
      try { _recognition.stop(); } catch {}
      $mic.classList.remove('recording');
      _recognition = null;
    }

    $mic.addEventListener('mousedown', (e) => { e.preventDefault(); startVoice(); });
    $mic.addEventListener('mouseup', stopVoice);
    $mic.addEventListener('mouseleave', stopVoice);
    $mic.addEventListener('touchstart', (e) => { e.preventDefault(); startVoice(); });
    $mic.addEventListener('touchend', (e) => { e.preventDefault(); stopVoice(); });

    // Cleanup on tab deactivate or panel hide
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopVoice(); });
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
      recordHookEvent(tab, 'PreCompact', 'starting compaction');
      tab.ws.send(JSON.stringify({ type: 'compact' }));
      appendStatus(tab, 'Compacting context...');
    });
  }

  // Bar action buttons (quick skills)
  _panel.querySelector('#cp-action-changelog')?.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || !tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;
    if (tab.running) return;
    const $input = _panel?.querySelector('#cp-input');
    if (!$input) return;
    $input.value = '/synabun changelog';
    autoResize();
    send();
  });

  // Session selector
  const $sessBtn = _panel.querySelector('#cp-session-btn');
  const $sessMenu = _panel.querySelector('#cp-session-menu');
  const $sessLabel = _panel.querySelector('.cp-session-label');
  let _sessClickTimer = null;

  $sessBtn.addEventListener('click', (e) => {
    // Block menu toggle while rename input is active
    if ($sessLabel?.querySelector('.cp-rename-input')) return;
    // If the click landed on the label text, don't open the menu (label click triggers rename)
    if (e.target === $sessLabel || e.target.closest('.cp-session-label')) return;
    // Delay single-click to allow dblclick to cancel it
    if (_sessClickTimer) { clearTimeout(_sessClickTimer); _sessClickTimer = null; }
    _sessClickTimer = setTimeout(() => {
      _sessClickTimer = null;
      const isOpen = $sessMenu.classList.toggle('open');
      if (isOpen) renderSessionMenu();
    }, 220);
  });

  // Single-click on session label to rename directly
  $sessLabel?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_sessClickTimer) { clearTimeout(_sessClickTimer); _sessClickTimer = null; }
    $sessMenu.classList.remove('open');
    const tab = activeTab();
    renameSession(tab?.sessionId || null, $sessLabel.textContent);
  });
  // Prevent mousedown on label from triggering button focus shift while rename is active
  $sessLabel?.addEventListener('mousedown', (e) => {
    if ($sessLabel.querySelector('.cp-rename-input')) e.stopPropagation();
  });

  // Rename button (explicit pencil icon next to session label)
  const $renameBtn = _panel.querySelector('#cp-header-rename');
  // Prevent mousedown from blurring an active rename input before click fires
  $renameBtn?.addEventListener('mousedown', (e) => {
    if ($sessLabel?.querySelector('.cp-rename-input')) e.preventDefault();
  });
  $renameBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_sessClickTimer) { clearTimeout(_sessClickTimer); _sessClickTimer = null; }
    $sessMenu.classList.remove('open');
    const tab = activeTab();
    renameSession(tab?.sessionId || null, $sessLabel.textContent);
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

  const $recall = _panel.querySelector('#cp-recall');
  const $view = _panel.querySelector('#cp-view');
  ddSetup($project); ddSetup($model); ddSetup($branch); ddSetup($recall); ddSetup($view);
  loadRecallProfile();
  populateViewDropdown($view, activeTab());
  $project.addEventListener('change', () => {
    const val = ddGetValue($project);
    storage.setItem(STOR.project, val);
    const tab = activeTab();
    if (tab) {
      if (tab.project && tab.project !== val) recordHookEvent(tab, 'CwdChanged', val || '(none)');
      tab.project = val;
      saveTabs();
    }
    loadBranches(val);
    // Reset session when switching projects
    selectSession(null, 'New chat');
  });
  $model.addEventListener('change', () => {
    const val = ddGetValue($model);
    if (val) storage.setItem(STOR.defaultModel, val);
    else storage.removeItem(STOR.defaultModel);
    const tab = activeTab();
    if (tab) { tab.model = val; renderGauge(tab); saveTabs(); }
    // Opus 4.7 xhigh preset — auto-bump thinking to max when user picks this model
    // and hasn't already set an effort. "xhigh" here maps to CLI --effort max.
    const modelId = val.split(':')[0];
    if (modelId === 'claude-opus-4-7') {
      const $think = _panel?.querySelector('#cp-think-toggle');
      if ($think && ($think.dataset.effort === 'off' || !$think.dataset.effort)) {
        _setEffort($think, 'max');
        if (tab) { tab.effort = 'max'; saveTabs(); }
      }
    }
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
      const w = Math.min(700, Math.max(320, window.innerWidth - e.clientX - 20));
      _panel.style.width = w + 'px';
      syncReservedWidth();
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

  window.addEventListener('resize', syncReservedWidth);

  // ── Whiteboard "Send to Panel" — receive image via event bus ──
  on('wb:send-to-panel', ({ dataUrl }) => {
    if (!dataUrl) return;
    if (!_visible && state.lastActivePanel !== 'claude') return;
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

  // ── Plan editor — receive edited plan, show updated plan + re-prompt with action buttons ──
  on('plan-saved', ({ filePath, content, source, tabId } = {}) => {
    if (source && source !== 'claude') return;
    const tab = activeTab();
    if (!tab || (tabId && tab.id !== tabId)) return;
    const $msgs = tab.messagesEl;
    if (!$msgs) return;

    // Remove old post-plan action cards
    $msgs.querySelectorAll('.post-plan-card').forEach(el => {
      const msg = el.closest('.msg'); if (msg) msg.remove(); else el.remove();
    });

    // Store edited content for when user clicks "Continue with implementation"
    tab._editedPlanContent = content;
    tab._planContent = content;
    if (filePath) tab.planFilePath = filePath;

    // Render synthetic assistant message showing the updated plan
    const el = document.createElement('div');
    el.className = 'msg msg-assistant';
    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.innerHTML = CLAUDE_ICON;
    el.appendChild(avatar);
    const wrap = document.createElement('div');
    wrap.className = 'msg-content';
    const body = document.createElement('div');
    body.className = 'msg-body';
    body._rawMd = content;
    body.innerHTML = md(content);
    wrap.appendChild(body);
    el.appendChild(wrap);
    $msgs.appendChild(el);

    // Re-render post-plan card with 3 buttons (Implement / Compact / Edit)
    renderPostPlanActions(tab, 'PLAN UPDATED');
    scrollEnd();
  });

  on('changelog-saved', ({ content }) => {
    const tab = activeTab();
    if (!tab || !tab.ws || tab.ws.readyState !== WebSocket.OPEN) return;

    // Send edited changelog content back as the AskUserQuestion answer
    if (tab._changelogAsk) {
      const { questions, questionText } = tab._changelogAsk;
      tab._changelogAsk = null;
      const answers = {};
      answers[questionText] = `Edit first — here are the edited entries:\n\n${content}`;
      sendAskAnswer(tab, questions, answers);
    } else {
      // Fallback: send as a regular message if ask context was lost
      const $input = _panel?.querySelector('#cp-input');
      if ($input) {
        $input.value = `The user has edited the changelog entries. Here are the updated entries:\n\n${content}\n\nWrite these entries to CHANGELOG.md.`;
        send();
      }
    }
  });

  // ── Edit cancelled — re-enable options when editor closed without saving ──
  on('plan-edit-cancelled', ({ source, tabId } = {}) => {
    if (source && source !== 'claude') return;
    const tab = activeTab();
    if (!tab || (tabId && tab.id !== tabId)) return;
    renderPostPlanActions(tab, tab._editedPlanContent ? 'PLAN UPDATED' : 'PLAN COMPLETE');
  });

  on('changelog-edit-cancelled', () => {
    const tab = activeTab();
    if (!tab) return;
    tab._changelogAsk = null;
    // Re-enable all ask option buttons in the last ask card
    const askCards = tab.messagesEl?.querySelectorAll('.ask-options');
    if (askCards?.length) {
      const lastAsk = askCards[askCards.length - 1];
      lastAsk.querySelectorAll('.ask-option').forEach(b => {
        b.disabled = false;
        b.classList.remove('selected');
      });
    }
  });
}

// Side panel browser launch removed — all automations use floating browsers only.

// Show panel without toggling it closed (used by notification click-through)
on('claude-panel:show', (data) => {
  if (!_visible) toggleClaudePanel();
  if (data?.tabId) {
    const idx = _tabs.findIndex(t => t.id === data.tabId);
    if (idx >= 0) switchTab(idx);
  }
});

export function initClaudePanel() {
  // Placeholder — panel is lazy-initialized on first toggleClaudePanel().
  // Event listeners that must work before first toggle are registered at module level above.
}
