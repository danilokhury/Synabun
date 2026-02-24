// ═══════════════════════════════════════════
// SynaBun Neural Interface — CLI Terminal
// xterm.js + WebSocket + node-pty integration
// ═══════════════════════════════════════════
//
// Provides a docked bottom terminal panel with tabbed sessions.
// Profiles: Claude Code, Codex CLI, Gemini CLI, Shell.

import { state, emit, on } from './state.js';
import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { createTerminalSession, deleteTerminalSession, fetchTerminalSessions } from './api.js';
import { registerAction } from './ui-keybinds.js';

const $ = (id) => document.getElementById(id);
const CLI_PROFILES = new Set(['claude-code', 'codex', 'gemini']);

// ── Profiles ──

const SVG_CLAUDE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
const SVG_OPENAI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>';
const SVG_GEMINI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg>';
const SVG_SHELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';

const PROFILES = [
  { id: 'claude-code', label: 'Claude Code', svg: SVG_CLAUDE, color: '#D4A27F' },
  { id: 'codex',       label: 'Codex CLI',   svg: SVG_OPENAI, color: '#74c7a5' },
  { id: 'gemini',      label: 'Gemini CLI',  svg: SVG_GEMINI, color: '#669DF6' },
  { id: 'shell',       label: 'Shell',       svg: SVG_SHELL,  color: '#aaaaaa' },
];

// ── xterm.js theme (matches Neural Interface dark glassmorphism) ──

const XTERM_THEME = {
  background: '#0a0a0c',
  foreground: '#d0d0d0',
  cursor: '#6eb5ff',
  cursorAccent: '#0a0a0c',
  selectionBackground: 'rgba(110,181,255,0.3)',
  selectionForeground: '#ffffff',
  black: '#1a1a1c',
  red: '#ff5252',
  green: '#6dd58c',
  yellow: '#ffb74d',
  blue: '#6eb5ff',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#ff6b6b',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#81a4f1',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#e0e0e0',
};

// ── Module state ──

let _panel = null;
let _sessions = [];    // [{ id, profile, term, fitAddon, ws, viewport, ro, dead }]
let _activeIdx = -1;
let _flyoutOpen = false;
let _xtermCSS = false; // track if xterm CSS has been loaded
let _Terminal = null;   // xterm Terminal class (lazy loaded)
let _FitAddon = null;   // xterm FitAddon class (lazy loaded)
let _WebLinksAddon = null;
let _SearchAddon = null;
let _WebglAddon = null;
let _CanvasAddon = null;
let _Unicode11Addon = null;

let _searchBarVisible = false;
let _contextMenu = null;
let _cachedProjects = null; // [{ path, label }]
let _panelPinned = false;   // whether the main panel is pinned (prevent close/hide)
let _detached = false;
let _floatDrag = null; // { startX, startY, startL, startT }
let _detachedTabs = new Map(); // sessionId → { el, drag, resize }
let _floatZCounter = 10000;    // z-index counter for floating tab focus-to-front
let _peekDock = null;          // bottom peek dock element (shown when panel hidden)

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;

// ── Session registry (persists across page refresh) ──

function saveSessionRegistry() {
  const registry = _sessions.map(s => ({
    id: s.id,
    profile: s.profile,
    label: s.label,
    pinned: s.pinned,
  }));
  storage.setItem(KEYS.TERMINAL_SESSIONS, JSON.stringify(registry));
}

function loadSessionRegistry() {
  try {
    return JSON.parse(storage.getItem(KEYS.TERMINAL_SESSIONS) || '[]');
  } catch {
    return [];
  }
}

function clearSessionRegistry() {
  storage.removeItem(KEYS.TERMINAL_SESSIONS);
}

/** Persist current terminal layout for page-refresh restore */
function saveTerminalLayout() {
  try {
    const snap = getTerminalSnapshot();
    storage.setItem(KEYS.TERMINAL_SESSIONS + '-layout', JSON.stringify(snap));
  } catch {}
}

// ── Project picker for CLI sessions ──

async function fetchProjects() {
  if (_cachedProjects) return _cachedProjects;
  try {
    const res = await fetch('/api/terminal/profiles');
    const data = await res.json();
    _cachedProjects = data.projects || [];
  } catch { _cachedProjects = []; }
  return _cachedProjects;
}

/** Show project picker, resolve with chosen cwd (or null for home dir) */
function pickProject(profile) {
  return new Promise(async (resolve) => {
    const projects = await fetchProjects();
    const profileDef = PROFILES.find(p => p.id === profile);
    const label = profileDef?.label || profile;

    // If no projects registered, skip picker
    if (!projects.length) return resolve(null);

    const overlay = document.createElement('div');
    overlay.className = 'term-picker-overlay';

    const modal = document.createElement('div');
    modal.className = 'term-picker-modal glass';

    const title = document.createElement('div');
    title.className = 'term-picker-title';
    title.innerHTML = `<span class="term-picker-icon">${profileDef?.svg || SVG_SHELL}</span>Open ${label} in...`;

    const list = document.createElement('div');
    list.className = 'term-picker-list';

    // Home directory option
    const homeItem = document.createElement('button');
    homeItem.className = 'term-picker-item';
    homeItem.innerHTML = `<span class="term-picker-item-icon"><svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></span><span class="term-picker-item-label">Home directory</span><span class="term-picker-item-path">default</span>`;
    homeItem.addEventListener('click', () => { overlay.remove(); resolve(null); });
    list.appendChild(homeItem);

    // Project items
    projects.forEach(p => {
      const item = document.createElement('button');
      item.className = 'term-picker-item';
      const folder = p.path.split(/[\\/]/).pop();
      item.innerHTML = `<span class="term-picker-item-icon"><svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span><span class="term-picker-item-label">${p.label || folder}</span><span class="term-picker-item-path">${p.path}</span>`;
      item.addEventListener('click', () => { overlay.remove(); resolve(p.path); });
      list.appendChild(item);
    });

    modal.appendChild(title);
    modal.appendChild(list);
    overlay.appendChild(modal);

    // Cancel on outside click or Escape
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(undefined); } });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); resolve(undefined); }
    });

    document.body.appendChild(overlay);
  });
}

/** Open a CLI or shell session, showing project picker for CLI profiles */
async function openSessionWithPicker(profile) {
  if (CLI_PROFILES.has(profile)) {
    const cwd = await pickProject(profile);
    if (cwd === undefined) return; // cancelled
    openSession(profile, cwd);
  } else {
    openSession(profile);
  }
}

// ── Lazy-load xterm.js from CDN ──

async function loadXterm() {
  if (_Terminal) return;

  // Load CSS if not already done
  if (!_xtermCSS) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://esm.sh/@xterm/xterm@5.5.0/css/xterm.css';
    document.head.appendChild(link);
    _xtermCSS = true;
  }

  // Dynamic ESM imports from CDN
  try {
    const [xtermMod, fitMod, linksMod, searchMod, webglMod, canvasMod, unicodeMod] = await Promise.all([
      import('https://esm.sh/@xterm/xterm@5.5.0'),
      import('https://esm.sh/@xterm/addon-fit@0.10.0'),
      import('https://esm.sh/@xterm/addon-web-links@0.11.0'),
      import('https://esm.sh/@xterm/addon-search@0.15.0'),
      import('https://esm.sh/@xterm/addon-webgl@0.18.0').catch(() => null),
      import('https://esm.sh/@xterm/addon-canvas@0.7.0').catch(() => null),
      import('https://esm.sh/@xterm/addon-unicode11@0.8.0'),
    ]);
    _Terminal = xtermMod.Terminal;
    _FitAddon = fitMod.FitAddon;
    _WebLinksAddon = linksMod.WebLinksAddon;
    _SearchAddon = searchMod.SearchAddon;
    _WebglAddon = webglMod?.WebglAddon || null;
    _CanvasAddon = canvasMod?.CanvasAddon || null;
    _Unicode11Addon = unicodeMod.Unicode11Addon;
  } catch (err) {
    // Show error in terminal container if it exists, or throw
    const container = $('term-container');
    if (container) {
      const msg = err?.message || 'Failed to load terminal (CDN unavailable)';
      const errorEl = document.createElement('div');
      errorEl.style.cssText = 'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #ff5252; font-size: 14px; text-align: center; padding: 20px;';
      errorEl.textContent = `⚠ ${msg}\n\nCheck your internet connection or try again.`;
      container.appendChild(errorEl);
    }
    throw err;
  }
}

// ── Panel creation ──

function ensurePanel() {
  if (_panel) return;

  const html = `
    <div id="terminal-resize-handle"></div>
    <div class="term-header">
      <div class="term-tab-bar" id="term-tab-bar"></div>
      <div class="term-actions">
        <button class="term-action-btn" id="term-new-btn" data-tooltip="New terminal">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="term-action-btn" id="term-close-btn" data-tooltip="Close terminal panel">
          <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    <div class="term-search-bar" id="term-search-bar">
      <input type="text" class="term-search-input" id="term-search-input" placeholder="Find..." spellcheck="false" autocomplete="off">
      <span class="term-search-count" id="term-search-count"></span>
      <button class="term-search-nav" id="term-search-prev" title="Previous match">&#9650;</button>
      <button class="term-search-nav" id="term-search-next" title="Next match">&#9660;</button>
      <button class="term-search-nav" id="term-search-close" title="Close">&times;</button>
    </div>
    <div class="term-container" id="term-container"></div>
    <div class="term-profile-flyout" id="term-profile-flyout"></div>
  `;

  const panel = document.createElement('div');
  panel.id = 'terminal-panel';
  panel.className = 'hidden';
  panel.innerHTML = html;
  document.body.appendChild(panel);
  _panel = panel;

  // Build profile flyout
  const flyout = $('term-profile-flyout');
  PROFILES.forEach(p => {
    const item = document.createElement('div');
    item.className = 'term-profile-item';
    item.dataset.profile = p.id;
    item.innerHTML = `<span class="term-profile-icon">${p.svg}</span>${p.label}`;
    item.addEventListener('click', () => {
      closeFlyout();
      openSessionWithPicker(p.id);
    });
    flyout.appendChild(item);
  });

  // Wire resize handle (docked only — panel detach removed, only tabs float)
  initResizeHandle();

  // Wire close button
  $('term-close-btn').addEventListener('click', () => hidePanel());

  // Wire new button — spawns a new shell session
  $('term-new-btn').addEventListener('click', () => {
    openSession('shell');
  });

  // Close flyout on outside click
  document.addEventListener('click', (e) => {
    if (_flyoutOpen && !e.target.closest('#term-profile-flyout') && !e.target.closest('#term-new-btn')) {
      closeFlyout();
    }
  });

  // Wire tab bar clicks via delegation
  const tabBar = $('term-tab-bar');
  tabBar.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.term-tab-close');
    if (closeBtn) {
      const idx = parseInt(closeBtn.dataset.idx, 10);
      closeSession(idx);
      return;
    }
    const detachBtn = e.target.closest('.term-tab-detach');
    if (detachBtn) {
      const idx = parseInt(detachBtn.dataset.idx, 10);
      detachTab(idx);
      return;
    }
    const dockBtn = e.target.closest('.term-tab-dock');
    if (dockBtn) {
      const idx = parseInt(dockBtn.dataset.idx, 10);
      const session = _sessions[idx];
      if (session) attachTab(session.id);
      return;
    }
    const tab = e.target.closest('.term-tab');
    if (tab) {
      const idx = parseInt(tab.dataset.idx, 10);
      const session = _sessions[idx];
      // If tab is detached, focus its floating window instead
      if (session && _detachedTabs.has(session.id)) {
        bringTabToFront(session.id);
        session.term.focus();
        return;
      }
      switchToSession(idx);
    }
  });

  // Double-click tab label to rename
  tabBar.addEventListener('dblclick', (e) => {
    const label = e.target.closest('.term-tab-label');
    if (!label) return;
    const tab = label.closest('.term-tab');
    if (!tab) return;
    const idx = parseInt(tab.dataset.idx, 10);
    const session = _sessions[idx];
    if (!session) return;

    const rect = label.getBoundingClientRect();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'term-tab-rename';
    input.value = session.label;
    input.style.width = Math.max(rect.width, 60) + 'px';

    label.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = input.value.trim();
      if (val) session.label = val;
      renderTabBar();
      saveSessionRegistry();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.value = session.label; input.blur(); }
    });
  });

  // Drop memory onto a tab — switch to that tab and send content
  tabBar.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-synabun-memory')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const tab = e.target.closest('.term-tab');
    if (tab) {
      const idx = parseInt(tab.dataset.idx, 10);
      if (idx !== _activeIdx) switchToSession(idx);
    }
  });
  tabBar.addEventListener('drop', (e) => {
    const memoryId = e.dataTransfer.getData('application/x-synabun-memory');
    if (!memoryId) return;
    e.preventDefault();
    const node = state.allNodes?.find(n => n.id === memoryId);
    const session = _sessions[_activeIdx];
    if (!node || !session || session.dead || session.ws.readyState !== WebSocket.OPEN) return;
    sendMemoryDrop(node, session.ws);
    session.term.focus();
  });

  // Wire search bar
  const searchInput = $('term-search-input');
  const searchBar = $('term-search-bar');

  searchInput.addEventListener('input', () => {
    const session = _sessions[_activeIdx];
    if (!session?.searchAddon) return;
    const query = searchInput.value;
    if (query) {
      session.searchAddon.findNext(query, { incremental: true });
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      toggleSearchBar(false);
      e.stopPropagation();
    } else if (e.key === 'Enter') {
      const session = _sessions[_activeIdx];
      if (!session?.searchAddon) return;
      if (e.shiftKey) {
        session.searchAddon.findPrevious(searchInput.value);
      } else {
        session.searchAddon.findNext(searchInput.value);
      }
      e.preventDefault();
    }
  });

  $('term-search-prev').addEventListener('click', () => {
    const session = _sessions[_activeIdx];
    if (session?.searchAddon) session.searchAddon.findPrevious(searchInput.value);
  });

  $('term-search-next').addEventListener('click', () => {
    const session = _sessions[_activeIdx];
    if (session?.searchAddon) session.searchAddon.findNext(searchInput.value);
  });

  $('term-search-close').addEventListener('click', () => toggleSearchBar(false));
}

function toggleFlyout() {
  const flyout = $('term-profile-flyout');
  if (!flyout) return;
  _flyoutOpen = !_flyoutOpen;
  flyout.classList.toggle('open', _flyoutOpen);
}

function closeFlyout() {
  const flyout = $('term-profile-flyout');
  if (flyout) flyout.classList.remove('open');
  _flyoutOpen = false;
}

// ── Search bar ──

function toggleSearchBar(show) {
  const bar = $('term-search-bar');
  if (!bar) return;

  if (show === undefined) show = !_searchBarVisible;
  _searchBarVisible = show;
  bar.classList.toggle('open', show);

  // Refit terminal after search bar changes the available height.
  // Double rAF ensures the browser has completed flex layout recalculation
  // before xterm measures its container for the new row count.
  const session = _sessions[_activeIdx];
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (session?.fitAddon) {
      try { session.fitAddon.fit(); } catch {}
    }
    if (session?.term) session.term.scrollToBottom();
  }));

  if (show) {
    const input = $('term-search-input');
    if (input) {
      input.focus();
      input.select();
    }
  } else {
    // Clear highlights and refocus terminal
    if (session?.searchAddon) session.searchAddon.clearDecorations();
    if (session?.term) session.term.focus();
  }
}

// ── Show / hide panel ──

function showPanel() {
  ensurePanel();
  hidePeekDock();

  _panel.classList.remove('hidden');

  const saved = parseInt(storage.getItem(KEYS.TERMINAL_HEIGHT), 10);
  const h = (saved > MIN_HEIGHT) ? saved : DEFAULT_HEIGHT;
  _panel.style.height = h + 'px';
  document.documentElement.style.setProperty('--terminal-height', h + 'px');

  storage.setItem(KEYS.TERMINAL_OPEN, '1');

  // Sync menu toggle
  const toggle = $('menu-terminal-toggle');
  if (toggle) toggle.classList.add('active');

  // Refit all terminals after layout shift
  requestAnimationFrame(() => {
    _sessions.forEach(s => { try { s.fitAddon?.fit(); } catch {} });
  });
}

function hidePanel() {
  if (!_panel || _panelPinned) return;
  _panel.classList.add('hidden');
  document.documentElement.style.setProperty('--terminal-height', '0px');
  storage.setItem(KEYS.TERMINAL_OPEN, '0');

  const toggle = $('menu-terminal-toggle');
  if (toggle) toggle.classList.remove('active');

  // Show peek dock if sessions exist
  if (_sessions.length > 0) showPeekDock();
}

function togglePanel() {
  if (!_panel || _panel.classList.contains('hidden')) {
    if (_sessions.length === 0) {
      // Open with a default shell session
      openSession('shell');
    } else {
      showPanel();
    }
  } else {
    hidePanel();
  }
}

// ── Detach / Attach (floating terminal) ──

function detachPanel() {
  if (!_panel || _detached) return;
  _detached = true;

  // Save docked height before switching
  const dockedH = _panel.getBoundingClientRect().height;

  // Load saved float position or compute default (centered, 60% width)
  let pos;
  try { pos = JSON.parse(storage.getItem(KEYS.TERMINAL_FLOAT_POS)); } catch {}
  if (!pos) {
    const w = Math.min(800, window.innerWidth * 0.6);
    const h = Math.min(500, dockedH);
    pos = {
      left: (window.innerWidth - w) / 2,
      top: (window.innerHeight - h) / 2,
      width: w, height: h,
    };
  }

  _panel.classList.add('detached');
  _panel.style.left = pos.left + 'px';
  _panel.style.top = pos.top + 'px';
  _panel.style.width = pos.width + 'px';
  _panel.style.height = pos.height + 'px';

  // Remove docked terminal height from graph layout
  document.documentElement.style.setProperty('--terminal-height', '0px');

  // Update detach button icon to "dock" arrows
  const btn = $('term-detach-btn');
  if (btn) {
    btn.title = 'Dock terminal';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';
  }

  storage.setItem(KEYS.TERMINAL_DETACHED, '1');
  saveFloatPos();
  saveTerminalLayout();

  // Refit terminals
  requestAnimationFrame(() => _sessions.forEach(s => { try { s.fitAddon?.fit(); } catch {} }));
}

function attachPanel() {
  if (!_panel || !_detached) return;
  _detached = false;

  _panel.classList.remove('detached');
  _panel.style.left = '';
  _panel.style.top = '';
  _panel.style.width = '';
  // Restore docked height
  const saved = parseInt(storage.getItem(KEYS.TERMINAL_HEIGHT), 10);
  const h = (saved > MIN_HEIGHT) ? saved : DEFAULT_HEIGHT;
  _panel.style.height = h + 'px';
  document.documentElement.style.setProperty('--terminal-height', h + 'px');

  const btn = $('term-detach-btn');
  if (btn) {
    btn.title = 'Detach terminal';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>';
  }

  storage.setItem(KEYS.TERMINAL_DETACHED, '0');
  saveTerminalLayout();

  requestAnimationFrame(() => _sessions.forEach(s => { try { s.fitAddon?.fit(); } catch {} }));
}

function saveFloatPos() {
  if (!_panel || !_detached) return;
  const r = _panel.getBoundingClientRect();
  storage.setItem(KEYS.TERMINAL_FLOAT_POS, JSON.stringify({
    left: r.left, top: r.top, width: r.width, height: r.height,
  }));
  saveTerminalLayout();
}

function initFloatDrag() {
  // Header drag for floating mode
  document.addEventListener('mousedown', (e) => {
    if (!_detached || !_panel) return;
    if (_panelPinned) return;
    const header = e.target.closest('.term-header');
    if (!header || !_panel.contains(header)) return;
    // Don't drag if clicking a button, tab close, input, flyout
    if (e.target.closest('button, input, .term-tab-close, .term-profile-flyout')) return;
    e.preventDefault();

    const rect = _panel.getBoundingClientRect();
    _floatDrag = { startX: e.clientX, startY: e.clientY, startL: rect.left, startT: rect.top };
    _panel.classList.add('float-dragging');
    document.body.style.cursor = 'move';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!_floatDrag) return;
    const dx = e.clientX - _floatDrag.startX;
    const dy = e.clientY - _floatDrag.startY;
    let finalL = _floatDrag.startL + dx;
    let finalT = _floatDrag.startT + dy;
    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      finalL = Math.round(finalL / gs) * gs;
      finalT = Math.round(finalT / gs) * gs;
    }
    _panel.style.left = finalL + 'px';
    _panel.style.top = finalT + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!_floatDrag) return;
    _floatDrag = null;
    if (_panel) _panel.classList.remove('float-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveFloatPos();
  });

  // Edge resize for floating mode (all 4 edges + 4 corners)
  initFloatResize();
}

function initFloatResize() {
  const EDGE = 10; // px edge hit zone
  let resizing = null;

  function getEdge(e) {
    if (!_detached || !_panel) return null;
    const r = _panel.getBoundingClientRect();
    const x = e.clientX, y = e.clientY;
    if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return null;

    let dir = '';
    if (y - r.top < EDGE) dir += 'n';
    else if (r.bottom - y < EDGE) dir += 's';
    if (x - r.left < EDGE) dir += 'w';
    else if (r.right - x < EDGE) dir += 'e';
    return dir || null;
  }

  const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize' };

  document.addEventListener('mousemove', (e) => {
    if (_floatDrag || resizing) return;
    const dir = getEdge(e);
    if (dir) { _panel.style.cursor = CURSORS[dir]; } else if (_panel) { _panel.style.cursor = ''; }
  });

  document.addEventListener('mousedown', (e) => {
    if (!_detached || !_panel || _floatDrag) return;
    if (_panelPinned) return;
    const dir = getEdge(e);
    if (!dir) return;
    e.preventDefault();
    const r = _panel.getBoundingClientRect();
    resizing = { dir, startX: e.clientX, startY: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
    document.body.style.cursor = CURSORS[dir];
    document.body.style.userSelect = 'none';
  });

  const MIN_W = 300, MIN_H = 160;

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const { dir, startX, startY, l, t, w, h } = resizing;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    let nw = w, nh = h, nl = l, nt = t;

    if (dir.includes('e')) nw = Math.max(MIN_W, w + dx);
    if (dir.includes('w')) { nw = Math.max(MIN_W, w - dx); nl = l + w - nw; }
    if (dir.includes('s')) nh = Math.max(MIN_H, h + dy);
    if (dir.includes('n')) { nh = Math.max(MIN_H, h - dy); nt = t + h - nh; }

    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      nl = Math.round(nl / gs) * gs;
      nt = Math.round(nt / gs) * gs;
      nw = Math.round(nw / gs) * gs;
      nh = Math.round(nh / gs) * gs;
    }

    _panel.style.left = nl + 'px';
    _panel.style.top = nt + 'px';
    _panel.style.width = nw + 'px';
    _panel.style.height = nh + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveFloatPos();
    _sessions.forEach(s => { try { s.fitAddon?.fit(); } catch {} });
  });
}

// ── Resize handle (docked mode) ──

function initResizeHandle() {
  const handle = $('terminal-resize-handle');
  if (!handle) return;

  let startY, startH;

  handle.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startH = _panel.getBoundingClientRect().height;
    e.preventDefault();
    handle.classList.add('active');

    const onMove = (e) => {
      const dy = startY - e.clientY;
      const maxH = window.innerHeight * 0.8;
      const newH = Math.max(MIN_HEIGHT, Math.min(maxH, startH + dy));
      _panel.style.height = newH + 'px';
      document.documentElement.style.setProperty('--terminal-height', newH + 'px');
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('active');
      const h = parseInt(_panel.style.height, 10);
      storage.setItem(KEYS.TERMINAL_HEIGHT, String(h));
      // Refit all terminals
      _sessions.forEach(s => { try { s.fitAddon?.fit(); } catch {} });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Session lifecycle ──

async function openSession(profile, cwd) {
  await loadXterm();
  ensurePanel();

  // Create server-side PTY session
  const { sessionId } = await createTerminalSession(profile, 120, 30, cwd);

  // Create xterm instance
  const term = new _Terminal({
    theme: XTERM_THEME,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    fontSize: 13,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    smoothScrollDuration: 0,
    overviewRuler: false,
    allowProposedApi: true,
  });

  const fitAddon = new _FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new _WebLinksAddon());

  // Create viewport element
  const viewport = document.createElement('div');
  viewport.className = 'term-viewport';
  viewport.dataset.sessionId = sessionId;
  $('term-container').appendChild(viewport);

  term.open(viewport);

  // Block xterm's built-in paste handler. xterm.js adds an irremovable paste
  // listener on its internal textarea during open(). We intercept it in the
  // capture phase with stopImmediatePropagation to prevent the double-paste bug.
  // Our handlePaste() uses the Clipboard API instead, so we don't need xterm's paste.
  const xtermTextarea = viewport.querySelector('.xterm-helper-textarea');
  if (xtermTextarea) {
    xtermTextarea.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  // Load SearchAddon (stored on session for Ctrl+F)
  const searchAddon = new _SearchAddon();
  term.loadAddon(searchAddon);

  // Unicode 11 support (emoji, CJK)
  if (_Unicode11Addon) {
    term.loadAddon(new _Unicode11Addon());
    term.unicode.activeVersion = '11';
  }

  // GPU-accelerated renderer with fallback
  let renderer = null;
  if (_WebglAddon) {
    try {
      const webgl = new _WebglAddon();
      webgl.onContextLoss(() => { webgl.dispose(); });
      term.loadAddon(webgl);
      renderer = 'webgl';
    } catch {
      // WebGL failed, try Canvas
      if (_CanvasAddon) {
        try { term.loadAddon(new _CanvasAddon()); renderer = 'canvas'; } catch {}
      }
    }
  } else if (_CanvasAddon) {
    try { term.loadAddon(new _CanvasAddon()); renderer = 'canvas'; } catch {}
  }

  // Connect WebSocket
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${sessionId}`);

  // ── Keyboard shortcuts (after ws is declared) ──
  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+C → copy if text selected, otherwise pass through as SIGINT
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection();
      if (sel) {
        if (e.type === 'keydown') navigator.clipboard.writeText(sel).catch(() => {});
        return false; // block — copied text
      }
      return true; // no selection — let xterm send \x03 (SIGINT)
    }
    // Ctrl+Shift+C → copy selection (block all event types)
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (e.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      }
      return false;
    }
    // Ctrl+V or Ctrl+Shift+V → paste from clipboard (images + text)
    // Block ALL event types (keydown, keyup, keypress) to prevent xterm's own paste
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      if (e.type === 'keydown') handlePaste(ws, term);
      return false;
    }
    // Ctrl+F → open search bar
    if (e.ctrlKey && !e.shiftKey && e.key === 'f' && e.type === 'keydown') {
      toggleSearchBar(true);
      return false;
    }
    // Ctrl+Shift+F → close search bar
    if (e.ctrlKey && e.shiftKey && e.key === 'F' && e.type === 'keydown') {
      toggleSearchBar(false);
      return false;
    }
    // Escape → blur terminal (give focus back to page)
    if (e.key === 'Escape' && e.type === 'keydown') {
      term.blur();
      const textarea = viewport.querySelector('.xterm-helper-textarea');
      if (textarea) textarea.blur();
      document.activeElement?.blur();
      return false;
    }
    return true; // let xterm handle everything else
  });

  // ── Copy-on-select ──
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).catch(() => {});
    }
  });

  ws.onopen = () => {
    fitAddon.fit();
    // Send initial resize
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'replay') term.write(msg.data);
      if (msg.type === 'exit') markSessionDead(sessionId);
      if (msg.type === 'error') {
        term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      }
      if (msg.type === 'image_saved' && msg.path) {
        // Copy path to clipboard — don't insert into PTY (corrupts TUI apps)
        navigator.clipboard.writeText(msg.path).catch(() => {});
        showTermToast(`Image saved — path copied to clipboard`);
      }
      if (msg.type === 'memory_saved' && msg.path) {
        // Write file path into PTY so CLI picks it up as a file reference
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Memory dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
    } catch {}
  };

  ws.onclose = () => {
    // Mark dead if not already cleaned up
    const session = _sessions.find(s => s.id === sessionId);
    if (session && !session.dead) markSessionDead(sessionId);
  };

  // Forward terminal input to PTY
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Auto-resize on viewport size change
  const ro = new ResizeObserver(() => {
    try {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {}
  });
  ro.observe(viewport);

  // Wire image paste on viewport
  initImagePaste(viewport, ws, term);

  // Wire right-click context menu on viewport
  initContextMenu(viewport, term, ws);

  // Wire memory drag-drop from explorer → terminal
  initMemoryDrop(viewport, ws, term);

  // Register session
  const profileDef = PROFILES.find(p => p.id === profile);
  const cwdLabel = cwd ? cwd.split(/[\\/]/).pop() : '';
  const session = {
    id: sessionId,
    profile,
    label: cwdLabel ? `${profileDef?.label || profile} · ${cwdLabel}` : (profileDef?.label || profile),
    term, fitAddon, searchAddon, ws, viewport, ro,
    renderer,
    dead: false,
    pinned: false,
  };
  _sessions.push(session);
  _activeIdx = _sessions.length - 1;

  showPanel();
  renderTabBar();
  switchToSession(_activeIdx);
  saveSessionRegistry();
}

/** Reconnect to an existing server-side PTY session (no new PTY created) */
async function reconnectSession(sessionId, profile, options = {}) {
  await loadXterm();
  ensurePanel();

  const term = new _Terminal({
    theme: XTERM_THEME,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    fontSize: 13,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: 'bar',
    scrollback: 5000,
    smoothScrollDuration: 0,
    overviewRuler: false,
    allowProposedApi: true,
  });

  const fitAddon = new _FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new _WebLinksAddon());

  const viewport = document.createElement('div');
  viewport.className = 'term-viewport';
  viewport.dataset.sessionId = sessionId;
  $('term-container').appendChild(viewport);

  term.open(viewport);

  // Block xterm's built-in paste handler (same double-paste fix)
  const xtermTextarea = viewport.querySelector('.xterm-helper-textarea');
  if (xtermTextarea) {
    xtermTextarea.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  const searchAddon = new _SearchAddon();
  term.loadAddon(searchAddon);

  if (_Unicode11Addon) {
    term.loadAddon(new _Unicode11Addon());
    term.unicode.activeVersion = '11';
  }

  let renderer = null;
  if (_WebglAddon) {
    try {
      const webgl = new _WebglAddon();
      webgl.onContextLoss(() => { webgl.dispose(); });
      term.loadAddon(webgl);
      renderer = 'webgl';
    } catch {
      if (_CanvasAddon) {
        try { term.loadAddon(new _CanvasAddon()); renderer = 'canvas'; } catch {}
      }
    }
  } else if (_CanvasAddon) {
    try { term.loadAddon(new _CanvasAddon()); renderer = 'canvas'; } catch {}
  }

  // Connect WebSocket to EXISTING session — server replays buffered output
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${sessionId}`);

  term.attachCustomKeyEventHandler((e) => {
    // Ctrl+C → copy if text selected, otherwise pass through as SIGINT
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection();
      if (sel) {
        if (e.type === 'keydown') navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      return true;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (e.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      }
      return false;
    }
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      if (e.type === 'keydown') handlePaste(ws, term);
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && e.key === 'f' && e.type === 'keydown') {
      toggleSearchBar(true);
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'F' && e.type === 'keydown') {
      toggleSearchBar(false);
      return false;
    }
    if (e.key === 'Escape' && e.type === 'keydown') {
      term.blur();
      const textarea = viewport.querySelector('.xterm-helper-textarea');
      if (textarea) textarea.blur();
      document.activeElement?.blur();
      return false;
    }
    return true;
  });

  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
  });

  ws.onopen = () => {
    fitAddon.fit();
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'replay') term.write(msg.data);
      if (msg.type === 'exit') markSessionDead(sessionId);
      if (msg.type === 'error') {
        if (msg.message === 'Session not found') {
          markSessionDead(sessionId);
          return;
        }
        term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      }
      if (msg.type === 'image_saved' && msg.path) {
        navigator.clipboard.writeText(msg.path).catch(() => {});
        showTermToast(`Image saved — path copied to clipboard`);
      }
      if (msg.type === 'memory_saved' && msg.path) {
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Memory dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
    } catch {}
  };

  ws.onclose = () => {
    const s = _sessions.find(s => s.id === sessionId);
    if (s && !s.dead) markSessionDead(sessionId);
  };

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  const ro = new ResizeObserver(() => {
    try {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    } catch {}
  });
  ro.observe(viewport);

  initImagePaste(viewport, ws, term);
  initContextMenu(viewport, term, ws);
  initMemoryDrop(viewport, ws, term);

  const profileDef = PROFILES.find(p => p.id === profile);
  const session = {
    id: sessionId,
    profile,
    label: options.label || (profileDef?.label || profile),
    term, fitAddon, searchAddon, ws, viewport, ro,
    renderer,
    dead: false,
    pinned: options.pinned || false,
  };
  _sessions.push(session);
  _activeIdx = _sessions.length - 1;

  showPanel();
  renderTabBar();
  switchToSession(_activeIdx);
  saveSessionRegistry();
}

function switchToSession(idx) {
  if (idx < 0 || idx >= _sessions.length) return;
  _activeIdx = idx;

  _sessions.forEach((s, i) => {
    // Don't touch viewports of detached tabs — they live in floating windows
    if (_detachedTabs.has(s.id)) return;
    s.viewport.style.display = i === idx ? '' : 'none';
    if (i === idx) {
      requestAnimationFrame(() => {
        try { s.fitAddon.fit(); } catch {}
        s.term.focus();
      });
    }
  });

  renderTabBar();
}

async function closeSession(idx) {
  if (idx < 0 || idx >= _sessions.length) return;
  const session = _sessions[idx];

  // Clean up detached tab window if any
  const tabState = _detachedTabs.get(session.id);
  if (tabState) {
    tabState.el.remove();
    _detachedTabs.delete(session.id);
  }

  // Cleanup
  session.ro.disconnect();
  session.ws.close();
  session.term.dispose();
  session.viewport.remove();

  // Kill server-side PTY
  try { await deleteTerminalSession(session.id); } catch {}

  _sessions.splice(idx, 1);

  // Count docked sessions (not detached)
  const dockedSessions = _sessions.filter(s => !_detachedTabs.has(s.id));

  if (_sessions.length === 0) {
    // Truly no sessions left at all
    _activeIdx = -1;
    hidePanel();
  } else if (dockedSessions.length === 0) {
    // No docked sessions but detached tabs still alive — hide main panel, keep detached alive
    _activeIdx = -1;
    hidePanel();
  } else {
    _activeIdx = Math.min(idx, _sessions.length - 1);
    const nextDocked = _sessions.findIndex((s, i) => i >= _activeIdx && !_detachedTabs.has(s.id));
    if (nextDocked >= 0) {
      switchToSession(nextDocked);
    } else {
      const anyDocked = _sessions.findIndex(s => !_detachedTabs.has(s.id));
      if (anyDocked >= 0) switchToSession(anyDocked);
      else _activeIdx = -1;
    }
  }

  renderTabBar();
  saveSessionRegistry();
}

/** Disconnect all sessions client-side WITHOUT killing server PTY.
 *  Used before workspace switch or before reconnecting to a different set. */
export function disconnectAllSessions() {
  // Remove all detached tab floating windows
  for (const [, tabState] of _detachedTabs) {
    tabState.el.remove();
  }
  _detachedTabs.clear();

  // Dispose all sessions — WS close triggers server grace timer, PTY stays alive
  for (const session of _sessions) {
    session.ro.disconnect();
    session.ws.close();
    session.term.dispose();
    session.viewport.remove();
  }
  _sessions = [];
  _activeIdx = -1;

  // Hide panel and peek dock
  if (_panel && !_panel.classList.contains('hidden')) {
    _panel.classList.add('hidden');
    document.documentElement.style.setProperty('--terminal-height', '0px');
  }
  hidePeekDock();
}

function markSessionDead(sessionId) {
  const session = _sessions.find(s => s.id === sessionId);
  if (session) {
    session.dead = true;
    renderTabBar();
  }
}

// ── Right-click context menu ──

function ensureContextMenu() {
  if (_contextMenu) return _contextMenu;

  const menu = document.createElement('div');
  menu.id = 'term-context-menu';
  menu.className = 'glass';
  menu.innerHTML = `
    <div class="term-ctx-item" data-action="copy">Copy</div>
    <div class="term-ctx-item" data-action="paste">Paste</div>
    <div class="term-ctx-sep"></div>
    <div class="term-ctx-item" data-action="select-all">Select All</div>
    <div class="term-ctx-item" data-action="clear">Clear</div>
    <div class="term-ctx-sep"></div>
    <div class="term-ctx-item" data-action="find">Find</div>
  `;
  document.body.appendChild(menu);
  _contextMenu = menu;

  // Close on outside click
  document.addEventListener('click', () => {
    menu.classList.remove('open');
  });

  return menu;
}

function initContextMenu(viewport, term, ws) {
  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const menu = ensureContextMenu();

    // Position at cursor
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('open');

    // Unbind previous handler to avoid stacking
    const handler = (evt) => {
      const item = evt.target.closest('.term-ctx-item');
      if (!item) return;
      const action = item.dataset.action;

      switch (action) {
        case 'copy': {
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          break;
        }
        case 'paste':
          navigator.clipboard.readText().then(text => {
            if (text && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input', data: text }));
            }
          }).catch(() => {});
          break;
        case 'select-all':
          term.selectAll();
          break;
        case 'clear':
          term.clear();
          break;
        case 'find':
          toggleSearchBar(true);
          break;
      }

      menu.classList.remove('open');
      menu.removeEventListener('click', handler);
    };

    menu.addEventListener('click', handler);
  });
}

// ── Toast notification (shown outside the terminal stream) ──

function showTermToast(message) {
  const container = $('term-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'term-toast';
  toast.textContent = message;
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Clipboard paste (images + text) ──

async function handlePaste(ws, term) {
  if (ws.readyState !== WebSocket.OPEN) return;

  try {
    // Use clipboard.read() to check for images first
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find(t => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          ws.send(JSON.stringify({
            type: 'image_paste',
            data: base64,
            mimeType: imageType,
          }));
          // Don't term.write() — it corrupts TUI apps like Claude Code
        };
        reader.readAsDataURL(blob);
        return;
      }
    }

    // No image found — fall back to text paste
    const text = await navigator.clipboard.readText();
    if (text) {
      ws.send(JSON.stringify({ type: 'input', data: text }));
    }
  } catch {
    // Fallback if clipboard.read() is denied (requires secure context)
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        ws.send(JSON.stringify({ type: 'input', data: text }));
      }
    } catch {}
  }
}

function initImagePaste(viewport, ws, term) {
  // Handle native paste events for images (e.g. right-click → Paste in browser).
  // Text paste is already blocked on xterm's textarea (see xtermTextarea listener
  // in openSession) and handled by our handlePaste() via the Clipboard API.
  viewport.addEventListener('paste', (e) => {
    if (!e.clipboardData || !e.clipboardData.items) return;

    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        e.stopPropagation();

        const blob = item.getAsFile();
        if (!blob) return;

        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'image_paste',
              data: base64,
              mimeType: item.type,
            }));
          }
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  });
}

// ── Memory drag-drop (explorer → terminal) ──

function initMemoryDrop(viewport, ws, term) {
  viewport.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-synabun-memory')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    viewport.classList.add('term-drop-active');
  });

  viewport.addEventListener('dragleave', (e) => {
    // Only remove if leaving the viewport entirely (not entering a child)
    if (!viewport.contains(e.relatedTarget)) {
      viewport.classList.remove('term-drop-active');
    }
  });

  viewport.addEventListener('drop', (e) => {
    viewport.classList.remove('term-drop-active');
    const memoryId = e.dataTransfer.getData('application/x-synabun-memory');
    if (!memoryId) return;
    e.preventDefault();

    const node = state.allNodes?.find(n => n.id === memoryId);
    if (!node || ws.readyState !== WebSocket.OPEN) return;

    sendMemoryDrop(node, ws);
    term.focus();
  });
}

function sendMemoryDrop(node, ws) {
  const content = formatMemoryForCLI(node);
  const p = node.payload;
  const title = (p.content || '').split('\n')[0].replace(/^#+\s*/, '').slice(0, 40) || p.category || 'memory';
  ws.send(JSON.stringify({ type: 'memory_drop', content, title }));
}

function formatMemoryForCLI(node) {
  const p = node.payload;
  const parts = [];

  // Header
  parts.push(`Here is a memory from SynaBun for context:\n`);

  // Category & metadata
  const meta = [];
  if (p.category) meta.push(`Category: ${p.category}`);
  if (p.subcategory) meta.push(`Subcategory: ${p.subcategory}`);
  if (p.project) meta.push(`Project: ${p.project}`);
  if (p.importance) meta.push(`Importance: ${p.importance}/10`);
  if (p.tags?.length) meta.push(`Tags: ${p.tags.join(', ')}`);
  if (meta.length) parts.push(meta.join(' | '));

  // Content
  if (p.content) parts.push(`\n${p.content}`);

  // Related files
  if (p.related_files?.length) {
    parts.push(`\nRelated files: ${p.related_files.join(', ')}`);
  }

  return parts.join('\n') + '\n';
}

// ── Per-tab detach (floating tab windows) ──

function bringTabToFront(sessionId) {
  const tabState = _detachedTabs.get(sessionId);
  if (!tabState) return;
  const session = _sessions.find(s => s.id === sessionId);
  // Pinned tabs stay at 10002
  if (session?.pinned) return;
  _floatZCounter++;
  tabState.el.style.zIndex = _floatZCounter;
}

function detachTab(idx) {
  const session = _sessions[idx];
  if (!session || _detachedTabs.has(session.id)) return;

  // Create floating window
  const win = document.createElement('div');
  win.className = 'term-float-tab glass';
  win.dataset.sessionId = session.id;

  const prof = PROFILES.find(p => p.id === session.profile);

  win.innerHTML = `
    <div class="term-float-tab-header">
      <span class="term-float-tab-icon">${prof?.svg || SVG_SHELL}</span>
      <span class="term-float-tab-title">${session.label}</span>
      <div class="term-float-tab-actions">
        <button class="term-float-tab-btn rename-btn" data-tooltip="Rename">
          <svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
        <button class="term-float-tab-btn pin-btn" data-tooltip="Pin on top">
          <svg viewBox="0 0 24 24"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h1V3H7v3h1a1 1 0 0 1 1 1z"/></svg>
        </button>
        <button class="term-float-tab-btn minimize-btn" data-tooltip="Minimize">
          <svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="term-float-tab-btn dock-btn" data-tooltip="Dock to panel">
          <svg viewBox="0 0 24 24"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>
        </button>
        <button class="term-float-tab-btn close-btn" data-tooltip="Close session">
          <svg viewBox="0 0 24 24"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
    <div class="term-float-tab-body"></div>
  `;

  // Default position: offset from center based on how many are already detached
  const offset = _detachedTabs.size * 30;
  const w = Math.min(700, window.innerWidth * 0.5);
  const h = Math.min(420, window.innerHeight * 0.5);
  win.style.left = ((window.innerWidth - w) / 2 + offset) + 'px';
  win.style.top = ((window.innerHeight - h) / 2 + offset) + 'px';
  win.style.width = w + 'px';
  win.style.height = h + 'px';

  document.body.appendChild(win);

  // Move viewport from main panel into this floating window
  const body = win.querySelector('.term-float-tab-body');
  body.appendChild(session.viewport);
  session.viewport.style.display = '';

  // Wire dock-back button
  win.querySelector('.dock-btn').addEventListener('click', (e) => { e.stopPropagation(); attachTab(session.id); });

  // Wire minimize button
  win.querySelector('.minimize-btn').addEventListener('click', (e) => { e.stopPropagation(); minimizeTab(session.id); });

  // Wire close button
  win.querySelector('.close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    attachTab(session.id);
    const newIdx = _sessions.indexOf(session);
    if (newIdx >= 0) closeSession(newIdx);
  });

  // Wire pin button — toggle pinned + always-on-top
  const pinBtnEl = win.querySelector('.pin-btn');
  pinBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    session.pinned = !session.pinned;
    win.classList.toggle('pinned', session.pinned);
    pinBtnEl.setAttribute('data-tooltip', session.pinned ? 'Unpin' : 'Pin on top');
    if (session.pinned) {
      win.style.zIndex = '10002';
    } else {
      win.style.zIndex = '';
    }
    saveSessionRegistry();
  });

  // Wire rename button — inline edit on title
  win.querySelector('.rename-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const titleEl = win.querySelector('.term-float-tab-title');
    if (!titleEl || titleEl.contentEditable === 'true') return;
    titleEl.contentEditable = 'true';
    titleEl.classList.add('editing');
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const commit = () => {
      titleEl.contentEditable = 'false';
      titleEl.classList.remove('editing');
      const val = titleEl.textContent.trim();
      if (val) { session.label = val; renderTabBar(); saveSessionRegistry(); }
      else { titleEl.textContent = session.label; }
    };
    titleEl.addEventListener('blur', commit, { once: true });
    titleEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); titleEl.blur(); }
      if (ev.key === 'Escape') { titleEl.textContent = session.label; titleEl.blur(); }
    });
  });

  // Store in map
  const tabState = { el: win };
  _detachedTabs.set(session.id, tabState);

  // Click anywhere on floating window → bring to front
  win.addEventListener('mousedown', () => bringTabToFront(session.id));

  // Header drag
  initTabFloatDrag(win, session.id);
  // Edge resize
  initTabFloatResize(win, session.id);

  // If this was the active tab in main panel, switch to another
  if (idx === _activeIdx) {
    const nextDocked = _sessions.findIndex((s, i) => i !== idx && !_detachedTabs.has(s.id));
    if (nextDocked >= 0) {
      switchToSession(nextDocked);
    } else {
      _activeIdx = -1;
    }
  }

  renderTabBar();
  saveTerminalLayout();

  // Refit terminal in new container
  requestAnimationFrame(() => { try { session.fitAddon?.fit(); } catch {} });
}

function attachTab(sessionId) {
  const tabState = _detachedTabs.get(sessionId);
  if (!tabState) return;

  // Clean up minimize pill if minimized
  if (tabState.minimized && tabState.pill) {
    tabState.pill.remove();
    tabState.pill = null;
    tabState.minimized = false;
  }
  tabState.el.style.display = '';

  const session = _sessions.find(s => s.id === sessionId);
  if (!session) { tabState.el.remove(); _detachedTabs.delete(sessionId); return; }

  // Move viewport back to main panel container
  const container = $('term-container');
  if (container) container.appendChild(session.viewport);

  // Remove floating window
  tabState.el.remove();
  _detachedTabs.delete(sessionId);

  // Show panel if hidden
  if (_panel?.classList.contains('hidden')) showPanel();

  // Switch to this tab
  const idx = _sessions.indexOf(session);
  if (idx >= 0) switchToSession(idx);

  renderTabBar();
  saveTerminalLayout();
  requestAnimationFrame(() => { try { session.fitAddon?.fit(); } catch {} });
}

// ── Minimize / Restore floating tabs ──

function minimizeTab(sessionId) {
  const tabState = _detachedTabs.get(sessionId);
  if (!tabState || tabState.minimized) return;
  const session = _sessions.find(s => s.id === sessionId);
  if (!session) return;

  // Save position before animating
  const r = tabState.el.getBoundingClientRect();
  tabState.savedRect = { left: r.left, top: r.top, width: r.width, height: r.height };
  tabState.minimized = true;

  // Create pill in tray first (need its position for animation target)
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) { tabState.el.style.display = 'none'; return; }
  const prof = PROFILES.find(p => p.id === session.profile);
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill';
  pill.setAttribute('data-session-id', sessionId);
  pill.innerHTML = `
    <span class="term-minimized-pill-icon">${prof?.svg || SVG_SHELL}</span>
    <span class="term-minimized-pill-label">${session.label}</span>
    <button class="term-minimized-pill-close" data-tooltip="Close">&times;</button>
  `;
  pill.querySelector('.term-minimized-pill-close').addEventListener('click', (e) => {
    e.stopPropagation();
    restoreTab(sessionId);
    attachTab(sessionId);
    const idx = _sessions.indexOf(session);
    if (idx >= 0) closeSession(idx);
  });
  pill.addEventListener('click', () => restoreTab(sessionId));
  pill.style.opacity = '0';
  tray.appendChild(pill);
  tabState.pill = pill;

  // Genie minimize animation — shrink toward pill position
  const el = tabState.el;
  const pillRect = pill.getBoundingClientRect();
  const targetX = pillRect.left + pillRect.width / 2;
  const targetY = pillRect.top + pillRect.height / 2;
  const srcCX = r.left + r.width / 2;
  const srcCY = r.top + r.height / 2;
  const dx = targetX - srcCX;
  const dy = targetY - srcCY;

  el.style.transition = 'none';
  el.style.transformOrigin = 'center center';
  el.style.overflow = 'hidden';

  requestAnimationFrame(() => {
    el.style.transition = 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(0.05)`;
    el.style.opacity = '0';
  });

  const onEnd = () => {
    el.removeEventListener('transitionend', onEnd);
    el.style.display = 'none';
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
    pill.style.opacity = '';
    pill.style.animation = 'pill-pop-in 0.2s ease-out';
  };
  el.addEventListener('transitionend', onEnd, { once: true });
  // Fallback in case transitionend doesn't fire
  setTimeout(() => {
    if (el.style.display !== 'none') onEnd();
  }, 450);

  saveTerminalLayout();
}

function restoreTab(sessionId) {
  const tabState = _detachedTabs.get(sessionId);
  if (!tabState || !tabState.minimized) return;

  tabState.minimized = false;
  const el = tabState.el;
  const saved = tabState.savedRect;

  // Get pill position for animation start point
  let startDX = 0, startDY = 0;
  if (tabState.pill && saved) {
    const pillRect = tabState.pill.getBoundingClientRect();
    const pillCX = pillRect.left + pillRect.width / 2;
    const pillCY = pillRect.top + pillRect.height / 2;
    const savedCX = saved.left + saved.width / 2;
    const savedCY = saved.top + saved.height / 2;
    startDX = pillCX - savedCX;
    startDY = pillCY - savedCY;
  }

  // Remove pill
  if (tabState.pill) {
    tabState.pill.remove();
    tabState.pill = null;
  }

  // Restore saved position
  if (saved) {
    el.style.left = saved.left + 'px';
    el.style.top = saved.top + 'px';
    el.style.width = saved.width + 'px';
    el.style.height = saved.height + 'px';
  }

  // Genie restore animation — expand from pill position
  el.style.transition = 'none';
  el.style.transformOrigin = 'center center';
  el.style.transform = `translate(${startDX}px, ${startDY}px) scale(0.05)`;
  el.style.opacity = '0';
  el.style.display = '';

  requestAnimationFrame(() => {
    el.style.transition = 'transform 0.35s cubic-bezier(0.2, 0, 0.2, 1), opacity 0.2s ease';
    el.style.transform = 'translate(0,0) scale(1)';
    el.style.opacity = '1';
  });

  const onEnd = () => {
    el.removeEventListener('transitionend', onEnd);
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
    // Refit terminal after animation
    const session = _sessions.find(s => s.id === sessionId);
    if (session) requestAnimationFrame(() => { try { session.fitAddon?.fit(); } catch {} });
  };
  el.addEventListener('transitionend', onEnd, { once: true });
  setTimeout(() => {
    if (el.style.transform) onEnd();
  }, 450);

  saveTerminalLayout();
}

const DRAG_CURSOR_ACTIVE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'%3E%3Cpath d='M11 2l3 3.5h-2v4.5h4.5V8L20 11l-3.5 3v-2H12v4.5h2L11 20l-3-3.5h2v-4.5H5.5V14L2 11l3.5-3v2H10V5.5H8z' fill='%234FC3F7' stroke='rgba(0,0,0,0.35)' stroke-width='0.6'/%3E%3C/svg%3E") 11 11, move`;

function initTabFloatDrag(win, sessionId) {
  let drag = null;

  win.addEventListener('mousedown', (e) => {
    const header = e.target.closest('.term-float-tab-header');
    if (!header || e.target.closest('button')) return;
    const session = _sessions.find(s => s.id === sessionId);
    if (session?.pinned) return;
    e.preventDefault();
    e.stopPropagation(); // prevent resize document handler from also firing
    const r = win.getBoundingClientRect();
    drag = { startX: e.clientX, startY: e.clientY, startL: r.left, startT: r.top };
    win.classList.add('float-dragging');
    document.body.style.cursor = DRAG_CURSOR_ACTIVE;
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    let finalL = drag.startL + e.clientX - drag.startX;
    let finalT = drag.startT + e.clientY - drag.startY;
    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      finalL = Math.round(finalL / gs) * gs;
      finalT = Math.round(finalT / gs) * gs;
    }
    win.style.left = finalL + 'px';
    win.style.top = finalT + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    win.classList.remove('float-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function initTabFloatResize(win, sessionId) {
  const EDGE = 6;
  let resizing = null;

  function getEdge(e) {
    const r = win.getBoundingClientRect();
    const x = e.clientX, y = e.clientY;
    if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return null;
    // Narrower top edge (3px) so it doesn't fight with header drag
    const TOP_EDGE = 3;
    let dir = '';
    if (y - r.top < TOP_EDGE) dir += 'n';
    else if (r.bottom - y < EDGE) dir += 's';
    if (x - r.left < EDGE) dir += 'w';
    else if (r.right - x < EDGE) dir += 'e';
    return dir || null;
  }

  const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize' };

  const MIN_W = 280, MIN_H = 160;

  document.addEventListener('mousemove', (e) => {
    if (resizing) return;
    const dir = getEdge(e);
    if (dir) win.style.cursor = CURSORS[dir]; else win.style.cursor = '';
  });

  document.addEventListener('mousedown', (e) => {
    const dir = getEdge(e);
    if (!dir) return;
    const session = _sessions.find(s => s.id === sessionId);
    if (session?.pinned) return;
    e.preventDefault();
    const r = win.getBoundingClientRect();
    resizing = { dir, startX: e.clientX, startY: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
    document.body.style.cursor = CURSORS[dir];
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const { dir, startX, startY, l, t, w, h } = resizing;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    let nw = w, nh = h, nl = l, nt = t;
    if (dir.includes('e')) nw = Math.max(MIN_W, w + dx);
    if (dir.includes('w')) { nw = Math.max(MIN_W, w - dx); nl = l + w - nw; }
    if (dir.includes('s')) nh = Math.max(MIN_H, h + dy);
    if (dir.includes('n')) { nh = Math.max(MIN_H, h - dy); nt = t + h - nh; }
    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      nl = Math.round(nl / gs) * gs;
      nt = Math.round(nt / gs) * gs;
      nw = Math.round(nw / gs) * gs;
      nh = Math.round(nh / gs) * gs;
    }
    win.style.left = nl + 'px';
    win.style.top = nt + 'px';
    win.style.width = nw + 'px';
    win.style.height = nh + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Refit terminal in resized container
    const session = _sessions.find(s => s.id === sessionId);
    if (session) requestAnimationFrame(() => { try { session.fitAddon?.fit(); } catch {} });
  });
}

// ── Peek dock (bottom indicator when panel hidden) ──

function ensurePeekDock() {
  if (_peekDock) return;
  const dock = document.createElement('div');
  dock.id = 'term-peek-dock';
  dock.innerHTML = `
    <span class="peek-pull"><svg viewBox="0 0 16 16" fill="none"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <div class="peek-tabs"></div>
    <span class="peek-count"></span>
  `;
  dock.addEventListener('click', () => {
    if (_sessions.length > 0) showPanel();
  });
  document.body.appendChild(dock);
  _peekDock = dock;
}

function renderPeekDock() {
  if (!_peekDock) return;
  const tabs = _peekDock.querySelector('.peek-tabs');
  const count = _peekDock.querySelector('.peek-count');

  tabs.innerHTML = _sessions.map((s, i) => {
    const prof = PROFILES.find(p => p.id === s.profile);
    const active = i === _activeIdx;
    return `<span class="peek-tab${active ? ' active' : ''}">
      <span class="peek-tab-icon">${prof?.svg || SVG_SHELL}</span>
      <span class="peek-tab-label">${s.label}</span>
    </span>`;
  }).join('');

  count.textContent = _sessions.length > 0 ? `${_sessions.length} session${_sessions.length > 1 ? 's' : ''}` : '';
}

function showPeekDock() {
  if (_sessions.length === 0) { hidePeekDock(); return; }
  ensurePeekDock();
  renderPeekDock();
  // Force reflow before adding visible class for transition
  void _peekDock.offsetHeight;
  _peekDock.classList.add('visible');
  document.documentElement.style.setProperty('--peek-dock-height', '28px');
}

function hidePeekDock() {
  if (!_peekDock) return;
  _peekDock.classList.remove('visible');
  document.documentElement.style.setProperty('--peek-dock-height', '0px');
}

// ── Tab bar rendering ──

function renderTabBar() {
  const bar = $('term-tab-bar');
  if (!bar) return;

  bar.innerHTML = _sessions.map((s, i) => {
    const prof = PROFILES.find(p => p.id === s.profile);
    const active = i === _activeIdx;
    const dead = s.dead;
    const isDetached = _detachedTabs.has(s.id);
    return `<button class="term-tab${active ? ' active' : ''}${dead ? ' dead' : ''}${isDetached ? ' detached' : ''}" data-idx="${i}">
      <span class="term-tab-icon">${prof?.svg || SVG_SHELL}</span>
      <span class="term-tab-label">${s.label}${dead ? ' (exited)' : ''}</span>
      ${!isDetached && !dead ? `<span class="term-tab-detach" data-idx="${i}" data-tooltip="Detach tab"><svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M21 3l-7 7"/><rect x="3" y="11" width="10" height="10" rx="1"/></svg></span>` : ''}
      ${isDetached ? `<span class="term-tab-dock" data-idx="${i}" title="Dock back"><svg viewBox="0 0 24 24"><path d="M4 14h6v6"/><path d="M3 21l7-7"/></svg></span>` : ''}
      <span class="term-tab-close" data-idx="${i}">&times;</span>
    </button>`;
  }).join('');

  // Keep peek dock in sync if it's showing
  if (_peekDock?.classList.contains('visible')) renderPeekDock();
}

// ── Public API ──

export async function initTerminal() {
  on('terminal:open', (data) => {
    const profile = data?.profile || 'shell';
    openSessionWithPicker(profile);
  });

  on('terminal:toggle', () => togglePanel());

  on('terminal:close', () => hidePanel());

  // Register CLI launch keybind actions (open as detached floating tab)
  registerAction('launch-claude', () => launchDetached('claude-code'));
  registerAction('launch-codex',  () => launchDetached('codex'));
  registerAction('launch-gemini', () => launchDetached('gemini'));

  // ── Auto-reconnect to surviving sessions on page load ──
  const registry = loadSessionRegistry();
  if (registry.length > 0) {
    let liveSessions = [];
    try {
      const data = await fetchTerminalSessions();
      liveSessions = data.sessions || [];
    } catch {}
    const liveIds = new Set(liveSessions.map(s => s.id));

    // Reconnect to sessions that are still alive on server
    const toReconnect = registry.filter(r => liveIds.has(r.id));
    if (toReconnect.length > 0) {
      for (const saved of toReconnect) {
        await reconnectSession(saved.id, saved.profile, {
          label: saved.label,
          pinned: saved.pinned,
        });
      }

      // Restore layout from last saved terminal layout
      try {
        const layoutJson = storage.getItem(KEYS.TERMINAL_SESSIONS + '-layout');
        if (layoutJson) {
          applyTerminalLayout(JSON.parse(layoutJson));
        }
      } catch {}
    }

    // Clean up dead sessions from registry
    if (toReconnect.length !== registry.length) {
      saveSessionRegistry();
    }
  }

  // Show peek dock if sessions exist but panel is hidden
  if (_sessions.length > 0 && (!_panel || _panel.classList.contains('hidden'))) {
    showPeekDock();
  }
}

export function openTerminalPanel(profile) {
  emit('terminal:open', { profile });
}

/** Open a CLI session and immediately detach it as a floating window */
async function launchDetached(profile) {
  const cwd = await pickProject(profile);
  if (cwd === undefined) return; // cancelled
  await openSession(profile, cwd);
  // Detach the session we just created (it's always the last one)
  const idx = _sessions.length - 1;
  if (idx >= 0) detachTab(idx);
}

/** Snapshot terminal state for workspace save */
export function getTerminalSnapshot() {
  return {
    detached: false,
    floatPos: null,
    dockedHeight: parseInt(storage.getItem(KEYS.TERMINAL_HEIGHT), 10) || DEFAULT_HEIGHT,
    visible: _panel ? !_panel.classList.contains('hidden') : false,
    // Session metadata for reconnection on workspace load
    sessions: _sessions.map(s => ({
      id: s.id,
      profile: s.profile,
      label: s.label,
      pinned: s.pinned,
      isDetached: _detachedTabs.has(s.id),
    })),
    detachedTabs: [..._detachedTabs.entries()].map(([sid, dt]) => {
      const r = dt.minimized && dt.savedRect ? dt.savedRect : dt.el.getBoundingClientRect();
      const session = _sessions.find(s => s.id === sid);
      return {
        sessionId: sid,
        sessionIdx: _sessions.findIndex(s => s.id === sid),
        left: r.left, top: r.top, width: r.width, height: r.height,
        pinned: session?.pinned || false,
        label: session?.label || '',
        minimized: dt.minimized || false,
      };
    }),
  };
}

/** Apply only layout (detach/dock, positions) without reconnection */
function applyTerminalLayout(snap) {
  if (!snap) return;

  // Panel detach removed — only individual tabs can float.
  // If an old snapshot says detached, force-dock it.
  if (_detached) attachPanel();

  if (snap.dockedHeight) {
    storage.setItem(KEYS.TERMINAL_HEIGHT, String(snap.dockedHeight));
    if (_panel && !_panel.classList.contains('hidden')) {
      _panel.style.height = snap.dockedHeight + 'px';
      document.documentElement.style.setProperty('--terminal-height', snap.dockedHeight + 'px');
    }
  }

  if (snap.detachedTabs) {
    for (const dt of snap.detachedTabs) {
      let session;
      if (dt.sessionId) {
        session = _sessions.find(s => s.id === dt.sessionId);
      } else if (dt.sessionIdx >= 0 && dt.sessionIdx < _sessions.length) {
        session = _sessions[dt.sessionIdx];
      }
      if (!session) continue;

      const idx = _sessions.indexOf(session);
      if (!_detachedTabs.has(session.id)) {
        detachTab(idx);
      }
      const tabState = _detachedTabs.get(session.id);
      if (tabState) {
        tabState.el.style.left = dt.left + 'px';
        tabState.el.style.top = dt.top + 'px';
        tabState.el.style.width = dt.width + 'px';
        tabState.el.style.height = dt.height + 'px';

        if (dt.pinned) {
          session.pinned = true;
          tabState.el.classList.add('pinned');
          tabState.el.style.zIndex = '10002';
          const closeEl = tabState.el.querySelector('.close-btn');
          if (closeEl) closeEl.style.display = 'none';
          const pinEl = tabState.el.querySelector('.pin-btn');
          if (pinEl) pinEl.title = 'Unpin';
        }

        if (dt.label) {
          session.label = dt.label;
          const titleEl = tabState.el.querySelector('.term-float-tab-title');
          if (titleEl) titleEl.textContent = dt.label;
        }

        if (dt.minimized) {
          minimizeTab(session.id);
        }
      }
    }
  }

  requestAnimationFrame(() => _sessions.forEach(s => { try { s.fitAddon?.fit(); } catch {} }));
}

/** Restore terminal state from workspace — reconnects to live sessions */
export async function restoreTerminalSnapshot(snap) {
  if (!snap) return;

  // New format: snap.sessions contains session IDs for reconnection
  if (snap.sessions && snap.sessions.length > 0) {
    let liveSessions = [];
    try {
      const data = await fetchTerminalSessions();
      liveSessions = data.sessions || [];
    } catch {}
    const liveIds = new Set(liveSessions.map(s => s.id));

    // Disconnect current sessions without killing server PTY
    disconnectAllSessions();

    // Reconnect to each saved session that's still alive on server
    for (const saved of snap.sessions) {
      if (liveIds.has(saved.id)) {
        await reconnectSession(saved.id, saved.profile, {
          label: saved.label,
          pinned: saved.pinned,
        });
      }
    }
  }

  // Apply layout (detach/dock, positions, pin state)
  applyTerminalLayout(snap);
}
