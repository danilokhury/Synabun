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
import { createTerminalSession, deleteTerminalSession, fetchTerminalSessions, fetchTerminalFiles, fetchTerminalBranches, checkoutTerminalBranch, createBrowserSession, deleteBrowserSession, fetchBrowserSessions, detectClaudeSession, fetchLastSession, dismissLastSession } from './api.js';
import { registerAction } from './ui-keybinds.js';
import { isGuest, hasPermission } from './ui-sync.js';
import { getWhiteboardElementById } from './ui-whiteboard.js';
import { createFrameRenderer } from './utils.js';

const $ = (id) => document.getElementById(id);
const CLI_PROFILES = new Set(['claude-code', 'codex', 'gemini']);

/** Cross-browser clipboard write with fallback for non-secure contexts. */
function _clipCopy(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => _clipFallback(text));
  } else {
    _clipFallback(text);
  }
}
function _clipFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

// ── Profiles ──

const SVG_CLAUDE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>';
const SVG_OPENAI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>';
const SVG_GEMINI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"/></svg>';
const SVG_SHELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>';
const SVG_GIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

const SVG_BROWSER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

const PROFILES = [
  { id: 'claude-code', label: 'Claude Code', svg: SVG_CLAUDE,  color: '#D4A27F' },
  { id: 'codex',       label: 'Codex CLI',   svg: SVG_OPENAI,  color: '#74c7a5' },
  { id: 'gemini',      label: 'Gemini CLI',  svg: SVG_GEMINI,  color: '#669DF6' },
  { id: 'shell',       label: 'Shell',       svg: SVG_SHELL,   color: '#aaaaaa' },
  { id: 'browser',     label: 'Browser',     svg: SVG_BROWSER, color: '#4fc3f7' },
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
const _pendingSessionIds = new Set(); // IDs being created — blocks sync:terminal:created duplicates
let _contextMenu = null;
let _ctxMenuHandler = null; // current context menu click handler (prevents stacking)
let _cachedProjects = null; // [{ path, label }]
let _panelPinned = false;   // whether the main panel is pinned (prevent close/hide)
let _detached = false;
let _floatDrag = null; // { startX, startY, startL, startT }
let _detachedTabs = new Map(); // sessionId → { el, drag, resize }
const FLOAT_COLORS = [
  { id: 'blue',      h: 215, s: 60 },
  { id: 'indigo',    h: 235, s: 55 },
  { id: 'purple',    h: 270, s: 55 },
  { id: 'pink',      h: 330, s: 55 },
  { id: 'red',       h: 0,   s: 60 },
  { id: 'orange',    h: 25,  s: 70 },
  { id: 'amber',     h: 40,  s: 70 },
  { id: 'yellow',    h: 50,  s: 65 },
  { id: 'lime',      h: 80,  s: 55 },
  { id: 'green',     h: 145, s: 55 },
  { id: 'teal',      h: 170, s: 55 },
  { id: 'cyan',      h: 185, s: 60 },
  { id: 'sky',       h: 200, s: 60 },
  { id: 'slate',     h: 215, s: 20 },
  { id: 'warm',      h: 20,  s: 15 },
  { id: 'none',      h: 0,   s: 0  },
];
let _floatZCounter = 10000;    // z-index counter for floating tab focus-to-front
let _peekDock = null;          // bottom peek dock element (shown when panel hidden)
let _closingIds = new Set();   // session IDs currently being closed (prevents re-entry)
let _opening = false;          // true while openSession/openBrowserSession is in progress
let _openingAt = 0;            // timestamp when _opening was set true (auto-reset after 15s)
let _restoringLayout = false;  // true during reconnect+layout restore (suppresses layout saves)
let _windowResizeTimer = null; // debounce handle for window resize clamping

// ── Split pane state ──
let _splitMode = false;           // true when 2-pane split is active
let _focusedPane = 0;             // 0=left, 1=right — which pane has keyboard focus
let _paneAssignments = new Map(); // sessionId → 0|1 (which pane a session belongs to)
let _activePaneIdx = [-1, -1];    // per-pane active session index (into _sessions)
let _splitRatio = 0.5;            // left pane width fraction (0.3–0.7)

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 120;

// ── Resume label sync ──
const RESUME_LABEL_PREFIX = 'synabun-session-label:';
function syncResumeLabel(session) {
  if (!session._claudeSessionId) return;
  try {
    if (session.label && session._userRenamed) {
      storage.setItem(RESUME_LABEL_PREFIX + session._claudeSessionId, session.label);
    }
  } catch { /* storage error */ }
}

// ── CLI Status Indicator (per-window) ──
// Detects Claude Code / CLI session state: idle, working, action needed.
// Shown as a badge on each CLI terminal tab and floating window header.

const CLI_STATUS = { OFF: 'off', IDLE: 'idle', WORKING: 'working', ACTION: 'action', DONE: 'done' };
const _cliSessionStatus = new Map(); // sessionId → { status, lastOutput, timer }

const _CLI_STATUS_HTML = '<span class="cli-status-badge" data-status="idle"><span class="cli-status-dot"></span><span class="cli-status-label">Idle</span></span>';
const _CLI_LABELS = { idle: 'Idle', working: 'Working', action: 'Action', done: 'Done' };

// ── Notification engine ──
let _audioCtx = null;
const _prevStatus = new Map(); // sessionId → previous status

function _getNotifEnabled() {
  return storage.getItem(KEYS.TERMINAL_NOTIFICATIONS) !== 'off';
}

function _playTone(freq, duration = 0.15, vol = 0.3) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(vol, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + duration);
    osc.start();
    osc.stop(_audioCtx.currentTime + duration);
  } catch {}
}

function _notifyStatusChange(sessionId, newStatus) {
  if (!_getNotifEnabled()) { _prevStatus.set(sessionId, newStatus); return; }
  const prev = _prevStatus.get(sessionId);
  _prevStatus.set(sessionId, newStatus);
  if (!prev || prev !== CLI_STATUS.WORKING) return; // only notify on Working → X
  if (newStatus === CLI_STATUS.WORKING) return;

  // Sound: action = urgent double beep, idle/done = gentle single tone
  if (newStatus === CLI_STATUS.ACTION) {
    _playTone(880, 0.12, 0.35);
    setTimeout(() => _playTone(880, 0.12, 0.35), 180);
  } else {
    _playTone(660, 0.18, 0.25);
  }

  // Browser notification (only if tab not focused)
  if (document.hidden && Notification.permission === 'granted') {
    const session = _sessions.find(s => s.id === sessionId);
    const title = newStatus === CLI_STATUS.ACTION ? 'Action Required' : 'Task Complete';
    const body = session?.label || 'Claude Code';
    const n = new Notification(title, { body, tag: `synabun-cli-${sessionId}`, silent: true });
    n.onclick = () => { window.focus(); n.close(); };
  }
}

function _getBufferText(buffer, row) {
  const rowData = buffer.getRow(row);
  if (!rowData) return '';
  let line = '';
  for (let c = 0; c < buffer.cols; c++) line += rowData[c]?.char || ' ';
  return line.trimEnd();
}

function _detectSessionStatus(session) {
  if (!session?._htmlTerm?.buffer || session.dead) return CLI_STATUS.OFF;
  const buf = session._htmlTerm.buffer;
  const cursorY = buf.cursorY;

  // Read full visible buffer for context (TUI apps use entire screen)
  const lines = [];
  for (let r = 0; r < buf.rows; r++) {
    lines.push(_getBufferText(buf, r));
  }
  const recent = lines.join('\n');

  // Action: permission prompts / approval needed
  if (/\bAllow\b/i.test(recent) && /\b(Yes|No|Always)\b/.test(recent)) {
    return CLI_STATUS.ACTION;
  }
  if (/\(y\/n\)/i.test(recent) || /\bDo you want to proceed\b/i.test(recent)) {
    return CLI_STATUS.ACTION;
  }

  // TUI idle: prompt char between box-drawing vertical borders (Claude Code input box)
  // e.g. "│ >  │" or "│  ❯  │"
  for (let r = cursorY; r >= Math.max(0, cursorY - 3); r--) {
    const line = _getBufferText(buf, r);
    if (/[\u2502\u2503\u2551]\s*[❯>\u276F]\s*[\u2502\u2503\u2551]/.test(line)) {
      let gapEmpty = true;
      for (let g = r + 1; g <= cursorY; g++) {
        const gl = _getBufferText(buf, g).trim();
        if (gl.length > 0 && !/^[\u2500-\u257F\s]+$/.test(gl)) { gapEmpty = false; break; }
      }
      if (gapEmpty) return CLI_STATUS.IDLE;
    }
  }

  // Shell idle: check cursor line AND a few lines above for prompt characters
  for (let r = cursorY; r >= Math.max(0, cursorY - 3); r--) {
    const line = _getBufferText(buf, r);
    if (/[❯>\u276F$%]\s*$/.test(line) && line.trim().length < 80) {
      // If prompt found above cursor, verify lines between are empty
      let gapEmpty = true;
      for (let g = r + 1; g <= cursorY; g++) {
        if (_getBufferText(buf, g).trim().length > 0) { gapEmpty = false; break; }
      }
      if (gapEmpty) return CLI_STATUS.IDLE;
    }
  }

  return CLI_STATUS.WORKING;
}

/** Update all DOM badges for a single session */
function _ensureBadge(container) {
  let badge = container.querySelector('.cli-status-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'cli-status-badge';
    badge.dataset.status = 'idle';
    badge.innerHTML = '<span class="cli-status-dot"></span><span class="cli-status-label">Idle</span>';
    // Insert after the title/label element
    const title = container.querySelector('.term-float-tab-title') || container.querySelector('.term-tab-label') || container.querySelector('.term-minimized-pill-label');
    if (title) title.after(badge);
    else container.appendChild(badge);
  }
  return badge;
}

function _updateSessionBadges(sessionId, status) {
  _notifyStatusChange(sessionId, status);
  // Docked tab badge
  const tab = document.querySelector(`.term-tab[data-session-id="${sessionId}"]`);
  if (tab) {
    const badge = _ensureBadge(tab);
    badge.dataset.status = status;
    const lbl = badge.querySelector('.cli-status-label');
    if (lbl) lbl.textContent = _CLI_LABELS[status] || '';
  }
  // Floating window header badge
  const floatHeader = document.querySelector(`.term-float-tab[data-session-id="${sessionId}"] .term-float-tab-header`);
  if (floatHeader) {
    const badge = _ensureBadge(floatHeader);
    badge.dataset.status = status;
    const lbl = badge.querySelector('.cli-status-label');
    if (lbl) lbl.textContent = _CLI_LABELS[status] || '';
  }
  // Minimized pill badge
  const pill = document.querySelector(`.term-minimized-pill[data-session-id="${sessionId}"]`);
  if (pill) {
    const badge = _ensureBadge(pill);
    badge.dataset.status = status;
    const lbl = badge.querySelector('.cli-status-label');
    if (lbl) lbl.textContent = _CLI_LABELS[status] || '';
  }
}

function _scheduleCliStatusCheck(sessionId) {
  const tracked = _cliSessionStatus.get(sessionId);
  if (!tracked) return;
  tracked.lastOutput = Date.now();

  // Immediately mark as working while output is flowing
  if (tracked.status !== CLI_STATUS.WORKING) {
    tracked.status = CLI_STATUS.WORKING;
    _updateSessionBadges(sessionId, CLI_STATUS.WORKING);
  }

  // Debounced buffer analysis after output settles
  if (tracked.timer) clearTimeout(tracked.timer);
  tracked.timer = setTimeout(() => {
    const session = _sessions.find(s => s.id === sessionId);
    if (!session) return;
    let st = _detectSessionStatus(session);
    // Safety net: no output for 5s but detection says WORKING -> assume IDLE
    if (st === CLI_STATUS.WORKING && tracked.lastOutput > 0 && Date.now() - tracked.lastOutput > 5000) {
      st = CLI_STATUS.IDLE;
    }
    tracked.status = st;
    _updateSessionBadges(sessionId, st);
  }, 600);
}

function _trackCliSession(sessionId) {
  _cliSessionStatus.set(sessionId, {
    status: CLI_STATUS.IDLE, lastOutput: 0, timer: null,
    pollInterval: setInterval(() => {
      const session = _sessions.find(s => s.id === sessionId);
      if (!session) return;
      const tracked = _cliSessionStatus.get(sessionId);
      if (!tracked || tracked.status === CLI_STATUS.DONE) return;
      if (Date.now() - tracked.lastOutput > 1000) {
        let newStatus = _detectSessionStatus(session);
        // Safety net: no output for 5s but detection says WORKING -> assume IDLE
        if (newStatus === CLI_STATUS.WORKING && tracked.lastOutput > 0 && Date.now() - tracked.lastOutput > 5000) {
          newStatus = CLI_STATUS.IDLE;
        }
        if (newStatus !== tracked.status) {
          tracked.status = newStatus;
          _updateSessionBadges(sessionId, newStatus);
        }
      }
    }, 2000),
  });
  _prevStatus.set(sessionId, CLI_STATUS.IDLE);
}

function _untrackCliSession(sessionId) {
  const tracked = _cliSessionStatus.get(sessionId);
  if (tracked?.timer) clearTimeout(tracked.timer);
  if (tracked?.pollInterval) clearInterval(tracked.pollInterval);
  _cliSessionStatus.delete(sessionId);
  _prevStatus.delete(sessionId);
}

/** Returns badge HTML for a session if it's a tracked CLI, or empty string */
function _cliBadgeHtml(sessionId) {
  return _cliSessionStatus.has(sessionId)
    ? `<span class="cli-status-badge" data-status="${_cliSessionStatus.get(sessionId).status}"><span class="cli-status-dot"></span><span class="cli-status-label">${_CLI_LABELS[_cliSessionStatus.get(sessionId).status] || ''}</span></span>`
    : '';
}

// ── rAF-throttled fit + debounced PTY resize ──
//
// Key insight from xterm.js issues (#3873, #4113, #5320):
//   fitAddon.fit() MUST be followed by pty.resize() or TUI apps (Claude Code,
//   vim, tmux) will render for the wrong dimensions → garbled output.
//   But flooding resize messages during drag causes full TUI redraws per frame.
//
// Solution: always call fit() visually, but DEBOUNCE the PTY resize to ~150ms
// during drag so TUI apps get periodic size updates without per-frame floods.
// Also validate dimensions to guard against NaN/zero from FitAddon (#4338, #5320).

const _fitPending = new Map();        // sessionId → rAF handle
const _resizeTimers = new Map();      // sessionId → debounce timer for PTY resize
let _draggingResize = false;          // true during edge-drag resize
const DRAG_RESIZE_DEBOUNCE_MS = 150;  // ms between PTY resizes during drag

// Touch → mouse coordinate helper for drag/resize
function _touchXY(e) {
  const t = e.touches?.[0] || e.changedTouches?.[0];
  return t ? { clientX: t.clientX, clientY: t.clientY } : null;
}

function _scheduleFit(session, _retries) {
  if (!session?.fitAddon || session.dead || session._isBrowser || session._isHtmlTerm) return;
  if (_fitPending.has(session.id)) return;
  const handle = requestAnimationFrame(() => {
    _fitPending.delete(session.id);
    try {
      // Validate dimensions BEFORE fitting — proposeDimensions can return NaN or
      // cols=1 when the container is hidden, transitioning, or zero-sized (#4338, #5320)
      const dims = session.fitAddon.proposeDimensions();
      if (!dims || !dims.cols || !dims.rows || dims.cols < 2 || dims.rows < 2 ||
          !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) {
        // Container not laid out yet — retry up to 3 times (each rAF ≈ 16ms)
        const attempt = (_retries || 0) + 1;
        if (attempt <= 3) requestAnimationFrame(() => _scheduleFit(session, attempt));
        return;
      }

      session._fitInProgress = true;
      session.fitAddon.fit();
      session._fitInProgress = false;

      const cols = session.term.cols;
      const rows = session.term.rows;
      if (!cols || !rows || cols < 2 || rows < 2) return; // post-fit sanity check

      if (session.ws?.readyState !== WebSocket.OPEN) return;

      if (_draggingResize) {
        // During drag: debounce PTY resize to prevent per-frame floods,
        // but still send periodically so TUI apps stay in sync.
        if (!_resizeTimers.has(session.id)) {
          _resizeTimers.set(session.id, setTimeout(() => {
            _resizeTimers.delete(session.id);
            if (session.ws?.readyState === WebSocket.OPEN) {
              session.ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
            }
          }, DRAG_RESIZE_DEBOUNCE_MS));
        }
      } else {
        // Not dragging — send immediately
        session.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    } catch { session._fitInProgress = false; }
  });
  _fitPending.set(session.id, handle);
}

// Send a final resize to the PTY (used on drag end). Clears any pending debounce.
function _sendResize(session) {
  if (!session?.term || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;
  // Clear pending debounce timer — we're sending the final size now
  const timer = _resizeTimers.get(session.id);
  if (timer) { clearTimeout(timer); _resizeTimers.delete(session.id); }
  try {
    // Validate before fitting (same guard as _scheduleFit)
    const dims = session.fitAddon?.proposeDimensions();
    if (!dims || dims.cols < 2 || dims.rows < 2 ||
        !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    session.fitAddon.fit();
    const cols = session.term.cols;
    const rows = session.term.rows;
    if (cols >= 2 && rows >= 2) {
      session.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  } catch {}
}


// ── Session registry (persists across page refresh) ──

function saveSessionRegistry() {
  // Deduplicate by session ID (last entry wins, merge claudeSessionId)
  const seen = new Map();
  for (const s of _sessions) {
    if (s._gitOutput) continue;
    const prev = seen.get(s.id);
    seen.set(s.id, {
      id: s.id,
      profile: s.profile,
      label: s.label,
      pinned: s.pinned,
      userRenamed: s._userRenamed || false,
      claudeSessionId: s._claudeSessionId || prev?.claudeSessionId || null,
      floatColor: s._floatColor || null,
    });
  }
  storage.setItem(KEYS.TERMINAL_SESSIONS, JSON.stringify([...seen.values()]));
}

function loadSessionRegistry() {
  try {
    return JSON.parse(storage.getItem(KEYS.TERMINAL_SESSIONS) || '[]');
  } catch {
    return [];
  }
}

/** Push session to _sessions, replacing any existing entry with the same ID */
function _pushSession(session) {
  const existingIdx = _sessions.findIndex(s => s.id === session.id);
  if (existingIdx >= 0) {
    // Merge claudeSessionId from old session if new one doesn't have it
    if (!session._claudeSessionId && _sessions[existingIdx]._claudeSessionId) {
      session._claudeSessionId = _sessions[existingIdx]._claudeSessionId;
    }
    _sessions[existingIdx] = session;
  } else {
    _sessions.push(session);
  }
  // Attach touch toolbar for terminal sessions on touch devices
  if (!session._isBrowser && session.viewport) _createTouchToolbar(session);
}

function clearSessionRegistry() {
  storage.removeItem(KEYS.TERMINAL_SESSIONS);
}

/** Persist current terminal layout for page-refresh restore */
function saveTerminalLayout() {
  if (_restoringLayout) return; // don't overwrite saved layout during reconnect
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

    // Custom path option with inline text input
    const customItem = document.createElement('div');
    customItem.className = 'term-picker-item term-picker-custom';
    customItem.innerHTML = `<span class="term-picker-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></span><input class="term-picker-custom-input" type="text" placeholder="Type a directory path..." spellcheck="false" />`;
    const customInput = customItem.querySelector('input');
    customInput.addEventListener('keydown', (ev) => {
      ev.stopPropagation(); // don't let Escape close modal while typing
      if (ev.key === 'Enter') {
        const val = customInput.value.trim();
        if (val) { overlay.remove(); resolve(val); }
      }
      if (ev.key === 'Escape') { customInput.value = ''; customInput.blur(); }
    });
    list.appendChild(customItem);

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
  // Permission guard for guests
  if (isGuest()) {
    const perm = profile === 'browser' ? 'browser' : 'terminal';
    if (!hasPermission(perm)) return;
  }
  if (profile === 'browser') {
    openBrowserSession();
    return;
  }
  if (CLI_PROFILES.has(profile)) {
    const cwd = await pickProject(profile);
    if (cwd === undefined) return; // cancelled
    openHtmlTermSession(profile, cwd);
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
      <button class="term-action-btn term-minimize-btn" id="term-minimize-btn" data-tooltip="Minimize terminal">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="term-tab-bar" id="term-tab-bar"></div>
      <div class="term-actions">
        <button class="term-action-btn" id="term-files-btn" data-tooltip="Toggle file tree">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="term-action-btn" id="term-split-btn" data-tooltip="Split terminal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/></svg>
        </button>
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
    <div class="term-body-row">
      <div class="term-file-sidebar" id="term-file-sidebar"></div>
      <div class="term-container" id="term-container"></div>
    </div>
  `;

  const panel = document.createElement('div');
  panel.id = 'terminal-panel';
  panel.className = 'hidden';
  panel.innerHTML = html;
  document.body.appendChild(panel);
  _panel = panel;

  // Build profile flyout — appended to document.body to escape
  // terminal panel's contain:paint + overflow:hidden clipping
  const flyout = document.createElement('div');
  flyout.id = 'term-profile-flyout';
  flyout.className = 'term-profile-flyout';
  document.body.appendChild(flyout);
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

  // Click on docked panel → bring above any floating TUI windows
  panel.addEventListener('mousedown', () => {
    panel.style.zIndex = ++_floatZCounter;
  });

  // Wire resize handle (docked only — panel detach removed, only tabs float)
  initResizeHandle();

  // Wire file tree toggle
  $('term-files-btn').addEventListener('click', () => toggleDockedFileTree());

  // Wire split button
  $('term-split-btn').addEventListener('click', () => {
    if (_splitMode) deactivateSplit();
    else activateSplit();
  });

  // Wire close button
  $('term-close-btn').addEventListener('click', () => hidePanel());

  // Wire minimize button (chevron down)
  $('term-minimize-btn').addEventListener('click', () => hidePanel());

  // Wire new button — toggle profile picker flyout
  $('term-new-btn').addEventListener('click', () => {
    if (isGuest() && !hasPermission('terminal')) return;
    toggleFlyout();
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
        if (session._isBrowser) session._browserCanvas?.focus();
        else session.term?.focus();
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
      if (val) { session.label = val; session._userRenamed = true; }
      renderTabBar();
      saveSessionRegistry();
      saveTerminalLayout();
      syncResumeLabel(session);
      // Retry detection if Claude session ID not yet known
      if (!session._claudeSessionId && CLI_PROFILES.has(session.profile)) {
        detectClaudeSession(session.id).then(r => {
          if (r?.claudeSessionId && !session._claudeSessionId) {
            session._claudeSessionId = r.claudeSessionId;
            saveSessionRegistry();
            syncResumeLabel(session);
          }
        }).catch(() => {});
      }
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.value = session.label; input.blur(); }
    });
  });

  // Drop memory or whiteboard image onto a tab — switch to that tab and send content
  tabBar.addEventListener('dragover', (e) => {
    if (!SYNABUN_DRAG_TYPES.some(t => e.dataTransfer.types.includes(t))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const tab = e.target.closest('.term-tab');
    if (tab) {
      const idx = parseInt(tab.dataset.idx, 10);
      if (idx !== _activeIdx) switchToSession(idx);
    }
  });
  tabBar.addEventListener('drop', (e) => {
    const session = _sessions[_activeIdx];
    if (!session || session.dead || session.ws.readyState !== WebSocket.OPEN) return;

    const memoryId = e.dataTransfer.getData('application/x-synabun-memory');
    if (memoryId) {
      e.preventDefault();
      const node = state.allNodes?.find(n => n.id === memoryId);
      if (!node) return;
      sendMemoryDrop(node, session.ws);
      session.term?.focus();
      return;
    }

    const wbImageId = e.dataTransfer.getData('application/x-synabun-wb-image');
    if (wbImageId) {
      e.preventDefault();
      sendWhiteboardImageDrop(wbImageId, session.ws);
      session.term?.focus();
      return;
    }
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
  // Position flyout above the "+" button (fixed positioning, avoids overflow clip)
  if (_flyoutOpen) {
    const btn = $('term-new-btn');
    if (btn) {
      const r = btn.getBoundingClientRect();
      flyout.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      flyout.style.right = (window.innerWidth - r.right) + 'px';
    }
  }
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
  // First rAF waits for flex layout recalculation, then _scheduleFit
  // queues a second rAF for the actual measurement.
  const session = _sessions[_activeIdx];
  requestAnimationFrame(() => {
    if (session) _scheduleFit(session);
    if (session?.term) session.term.scrollToBottom();
  });

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

  // Only restore docked height when not floating — detached panels keep their own size
  if (!_detached) {
    const saved = parseInt(storage.getItem(KEYS.TERMINAL_HEIGHT), 10);
    const h = (saved > MIN_HEIGHT) ? saved : DEFAULT_HEIGHT;
    _panel.style.height = h + 'px';
    document.documentElement.style.setProperty('--terminal-height', h + 'px');
  }

  // Bring docked panel above any floating TUI windows
  _panel.style.zIndex = ++_floatZCounter;

  // Remove hidden class to trigger morph-open transition
  _panel.classList.remove('hidden');

  storage.setItem(KEYS.TERMINAL_OPEN, '1');

  // Sync menu toggle
  const toggle = $('menu-terminal-toggle');
  if (toggle) toggle.classList.add('active');

  // Refit terminals after morph transition completes (500ms)
  setTimeout(() => _sessions.forEach(s => {
    if (s._isHtmlTerm) s._htmlTerm?.fit();
    else _scheduleFit(s);
  }), 520);
}

function hidePanel() {
  if (!_panel || _panelPinned) return;
  closeFlyout();

  // Morph closed — clip-path collapses to button shape
  _panel.classList.add('hidden');
  document.documentElement.style.setProperty('--terminal-height', '0px');
  storage.setItem(KEYS.TERMINAL_OPEN, '0');

  const toggle = $('menu-terminal-toggle');
  if (toggle) toggle.classList.remove('active');

  // Show peek dock after morph-close completes (only for docked mode)
  if (!_detached) setTimeout(() => showPeekDock(), 520);
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
      top: Math.max(48, (window.innerHeight - h) / 2),
      width: w, height: h,
    };
  }

  _panel.classList.add('detached');
  _panel.style.left = pos.left + 'px';
  _panel.style.top = Math.max(48, pos.top) + 'px';
  _panel.style.width = pos.width + 'px';
  _panel.style.height = pos.height + 'px';

  // Add resize handles for floating mode
  if (!_panel.querySelector('.float-resize')) {
    const dirs = ['e','w','s','n','se','sw','ne','nw'];
    const suffixes = ['r','l','b','t','br','bl','tr','tl'];
    dirs.forEach((d, i) => {
      const h = document.createElement('div');
      h.className = `float-resize float-resize-${suffixes[i]}`;
      h.dataset.resize = d;
      _panel.appendChild(h);
    });
  }

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
  requestAnimationFrame(() => _sessions.forEach(s => _scheduleFit(s)));
}

function attachPanel() {
  if (!_panel || !_detached) return;
  _detached = false;

  _panel.classList.remove('detached');
  _panel.querySelectorAll('.float-resize').forEach(h => h.remove());
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

  requestAnimationFrame(() => _sessions.forEach(s => _scheduleFit(s)));
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
  function _startPanelDrag(x, y) {
    const rect = _panel.getBoundingClientRect();
    _floatDrag = { startX: x, startY: y, startL: rect.left, startT: rect.top };
    _panel.classList.add('float-dragging');
    document.body.style.cursor = 'move';
    document.body.style.userSelect = 'none';
  }
  function _movePanelDrag(x, y) {
    if (!_floatDrag) return;
    let finalL = _floatDrag.startL + x - _floatDrag.startX;
    let finalT = _floatDrag.startT + y - _floatDrag.startY;
    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      finalL = Math.round(finalL / gs) * gs;
      finalT = Math.round(finalT / gs) * gs;
    }
    finalT = Math.max(48, finalT);
    _panel.style.left = finalL + 'px';
    _panel.style.top = finalT + 'px';
  }
  function _endPanelDrag() {
    if (!_floatDrag) return;
    _floatDrag = null;
    if (_panel) _panel.classList.remove('float-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveFloatPos();
  }

  function _checkPanelHeader(target) {
    if (!_detached || !_panel || _panelPinned) return false;
    const header = target.closest('.term-header');
    if (!header || !_panel.contains(header)) return false;
    if (target.closest('button, input, .term-tab-close, .term-profile-flyout')) return false;
    return true;
  }

  document.addEventListener('mousedown', (e) => {
    if (!_checkPanelHeader(e.target)) return;
    e.preventDefault();
    _startPanelDrag(e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => _movePanelDrag(e.clientX, e.clientY));
  document.addEventListener('mouseup', _endPanelDrag);

  // Touch equivalents
  document.addEventListener('touchstart', (e) => {
    const pt = _touchXY(e);
    if (!pt || !_checkPanelHeader(e.target)) return;
    e.preventDefault();
    _startPanelDrag(pt.clientX, pt.clientY);
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    const pt = _touchXY(e);
    if (!pt || !_floatDrag) return;
    e.preventDefault();
    _movePanelDrag(pt.clientX, pt.clientY);
  }, { passive: false });
  document.addEventListener('touchend', _endPanelDrag);
  document.addEventListener('touchcancel', _endPanelDrag);

  // Edge resize for floating mode (all 4 edges + 4 corners)
  initFloatResize();
}

function initFloatResize() {
  let resizing = null;

  const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize' };

  const MIN_W = 300, MIN_H = 160;

  function _startPanelResize(handle, x, y) {
    if (!_panel || _floatDrag || _panelPinned) return false;
    const dir = handle.dataset.resize;
    const r = _panel.getBoundingClientRect();
    resizing = { dir, startX: x, startY: y, l: r.left, t: r.top, w: r.width, h: r.height };
    _draggingResize = true;
    document.body.style.cursor = CURSORS[dir];
    document.body.style.userSelect = 'none';
    return true;
  }
  function _movePanelResize(x, y) {
    if (!resizing) return;
    const { dir, startX, startY, l, t, w, h } = resizing;
    const dx = x - startX, dy = y - startY;
    let nw = w, nh = h, nl = l, nt = t;
    if (dir.includes('e')) nw = Math.max(MIN_W, w + dx);
    if (dir.includes('w')) { nw = Math.max(MIN_W, w - dx); nl = l + w - nw; }
    if (dir.includes('s')) nh = Math.max(MIN_H, h + dy);
    if (dir.includes('n')) { nh = Math.max(MIN_H, h - dy); nt = t + h - nh; }
    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      nl = Math.round(nl / gs) * gs; nt = Math.round(nt / gs) * gs;
      nw = Math.round(nw / gs) * gs; nh = Math.round(nh / gs) * gs;
    }
    nt = Math.max(48, nt);
    _panel.style.left = nl + 'px';
    _panel.style.top = nt + 'px';
    _panel.style.width = nw + 'px';
    _panel.style.height = nh + 'px';
    _sessions.forEach(s => _scheduleFit(s));
  }
  function _endPanelResize() {
    if (!resizing) return;
    resizing = null;
    _draggingResize = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveFloatPos();
    _sessions.forEach(s => _sendResize(s));
  }

  // Mouse
  document.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('#terminal-panel.detached > .float-resize');
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    _startPanelResize(handle, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => _movePanelResize(e.clientX, e.clientY));
  document.addEventListener('mouseup', _endPanelResize);

  // Touch
  document.addEventListener('touchstart', (e) => {
    const handle = e.target.closest('#terminal-panel.detached > .float-resize');
    const pt = _touchXY(e);
    if (!handle || !pt) return;
    e.preventDefault();
    e.stopPropagation();
    _startPanelResize(handle, pt.clientX, pt.clientY);
  }, { passive: false });
  document.addEventListener('touchmove', (e) => {
    const pt = _touchXY(e);
    if (!pt || !resizing) return;
    e.preventDefault();
    _movePanelResize(pt.clientX, pt.clientY);
  }, { passive: false });
  document.addEventListener('touchend', _endPanelResize);
  document.addEventListener('touchcancel', _endPanelResize);
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
    _draggingResize = true;

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
      _draggingResize = false;
      const h = parseInt(_panel.style.height, 10);
      storage.setItem(KEYS.TERMINAL_HEIGHT, String(h));
      // Send final resize to PTY at settled dimensions
      _sessions.forEach(s => _sendResize(s));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Session lifecycle ──

async function openSession(profile, cwd, existingSessionId) {
  if (_opening) return;
  _opening = true;
  try {
  await loadXterm();
  ensurePanel();

  // Use pre-created session or create a new one
  const sessionId = existingSessionId || (await createTerminalSession(profile, 120, 30, cwd)).sessionId;
  _pendingSessionIds.add(sessionId);

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
    scrollOnUserInput: true,
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

  // Route viewport to correct pane (or container root)
  if (_splitMode) {
    const targetPane = _focusedPane;
    _paneAssignments.set(sessionId, targetPane);
    const paneBody = _panel?.querySelector(`.term-pane[data-pane="${targetPane}"] .term-pane-body`);
    if (paneBody) paneBody.appendChild(viewport);
    else $('term-container').appendChild(viewport);
  } else {
    $('term-container').appendChild(viewport);
  }

  // Wait for fonts before opening — xterm measures char cell width on open().
  // If JetBrains Mono hasn't loaded yet, measurements use fallback monospace
  // and TUI layouts (box-drawing, spinners) are permanently misaligned.
  if (document.fonts?.ready) await document.fonts.ready;
  term.open(viewport);

  // Find xterm's internal textarea (used for paste handler below, after ws is created)
  const xtermTextarea = viewport.querySelector('.xterm-helper-textarea');

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
      webgl.onContextLoss(() => {
        webgl.dispose();
        // Fall back to Canvas renderer instead of DOM
        if (_CanvasAddon) {
          try { term.loadAddon(new _CanvasAddon()); } catch {}
        }
      });
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
    // Shift+Enter → insert literal newline (multi-line command editing)
    // Sends Ctrl-V (\x16) + LF (\n) — readline inserts LF literally instead of executing
    if (e.shiftKey && e.key === 'Enter') {
      if (e.type === 'keydown' && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: '\x16\n' }));
      }
      return false;
    }
    // Ctrl+C → copy if text selected, otherwise pass through as SIGINT
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection();
      if (sel) {
        if (e.type === 'keydown') _clipCopy(sel);
        return false; // block — copied text
      }
      return true; // no selection — let xterm send \x03 (SIGINT)
    }
    // Ctrl+Shift+C → copy selection (block all event types)
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (e.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) _clipCopy(sel);
      }
      return false;
    }
    // Ctrl+V — block xterm from sending \x16 (lnext) to PTY.
    // Browser paste event still fires → xterm's built-in paste handler processes it.
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      return false;
    }
    // Ctrl+F → open search bar
    if (e.ctrlKey && !e.shiftKey && e.key === 'f' && e.type === 'keydown') {
      const sess = _sessions.find(s => s.viewport === viewport);
      if (sess && _detachedTabs.has(sess.id)) toggleFloatSearchBar(sess);
      else toggleSearchBar(true);
      return false;
    }
    // Ctrl+Shift+F → close search bar
    if (e.ctrlKey && e.shiftKey && e.key === 'F' && e.type === 'keydown') {
      const sess = _sessions.find(s => s.viewport === viewport);
      if (sess && _detachedTabs.has(sess.id)) toggleFloatSearchBar(sess);
      else toggleSearchBar(false);
      return false;
    }
    // ESC is handled by the global window capture listener in initTerminal()
    return true; // let xterm handle everything else
  });

  // ── Paste event on textarea (capture) — intercept IMAGE paste only ──
  // Text paste falls through to xterm's built-in paste handler (bubble phase)
  // which handles normalization (\r?\n → \r) and bracketed paste wrapping.
  if (xtermTextarea) {
    xtermTextarea.addEventListener('paste', (e) => {
      if (!e.clipboardData || ws.readyState !== WebSocket.OPEN) return;
      // Only intercept image paste — text falls through to xterm's built-in handler
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const blob = item.getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'image_paste', data: base64, mimeType: item.type }));
            }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
      // Text: do nothing — xterm's built-in paste handler fires next
    }, true);
  }

  // ── Copy-on-select (debounced to avoid focus churn during drag) ──
  let _selTimer = null;
  term.onSelectionChange(() => {
    if (_selTimer) clearTimeout(_selTimer);
    _selTimer = setTimeout(() => {
      _selTimer = null;
      const sel = term.getSelection();
      if (sel) _clipCopy(sel);
    }, 150);
  });

  ws.onopen = () => {
    // Correct PTY from default 120×30 to actual container size.
    // Guard: if the viewport is in a hidden/zero-height container (e.g. launchDetached
    // creates the session in the hidden docked panel before detaching), skip the fit.
    // The correct resize will happen when _scheduleFit runs after the viewport moves
    // to a visible container. Sending garbage dimensions (cols=1) here would cause
    // the CLI to render garbled output into the buffer permanently.
    const dims = fitAddon.proposeDimensions();
    if (dims && dims.cols >= 2 && dims.rows >= 2 &&
        Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
    // else: PTY stays at safe 120×30 default until _scheduleFit sends the real size
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'replay') {
        term.write(msg.data);
      }
      if (msg.type === 'exit') {
        const _s = _sessions.find(s => s.id === sessionId);
        if (_s) _s._exitReceived = true;
        markSessionDead(sessionId);
      }
      if (msg.type === 'error') {
        if (msg.message === 'Session not found') { markSessionDead(sessionId); return; }
        term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      }
      if (msg.type === 'image_saved' && msg.path) {
        _clipCopy(msg.path);
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image pasted — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'image_dropped' && msg.path) {
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'memory_saved' && msg.path) {
        // Write file path into PTY so CLI picks it up as a file reference
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Memory dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
    } catch {}
  };

  ws.onclose = () => {
    const session = _sessions.find(s => s.id === sessionId);
    if (session && !session.dead && !session._exitReceived) _reconnectTerminalWs(session);
  };

  // Forward terminal input to PTY (use session.ws lookup so reconnected WS is used)
  term.onData((data) => {
    const s = _sessions.find(s => s.id === sessionId);
    if (s?.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Auto-resize on viewport size change (rAF-throttled)
  const ro = new ResizeObserver(() => {
    const s = _sessions.find(s => s.id === sessionId);
    if (s) _scheduleFit(s);
  });
  ro.observe(viewport);

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
    cwd: cwd || null,
    label: cwdLabel ? `${profileDef?.label || profile} · ${cwdLabel}` : (profileDef?.label || profile),
    term, fitAddon, searchAddon, ws, viewport, ro,
    renderer,
    dead: false,
    pinned: false,
    _fitInProgress: false,
  };
  _pushSession(session);
  _pendingSessionIds.delete(sessionId);
  _activeIdx = _sessions.indexOf(session);

  // Slide panel up so user sees the session immediately
  ensurePanel();
  showPanel();
  if (_splitMode) renderSplitTabBars();
  renderTabBar();
  switchToSession(_activeIdx);
  saveSessionRegistry();
  } finally { _opening = false; }
}

// ═══════════════════════════════════════════
// HTML TERM — Custom renderer for CLI profiles
// ═══════════════════════════════════════════

let _HtmlTermRenderer = null;

async function loadHtmlTermRenderer() {
  if (_HtmlTermRenderer) return;
  const mod = await import('./html-term-renderer.js');
  _HtmlTermRenderer = mod.HtmlTermRenderer;
}

/**
 * Open a CLI tool session using the custom HTML terminal renderer
 * instead of xterm.js. Mirrors openSession() but lighter.
 */
async function openHtmlTermSession(profile, cwd, existingSessionId, options = {}) {
  if (_opening) return;
  _opening = true;
  try {
    await loadHtmlTermRenderer();
    ensurePanel();

    // Use pre-created session (e.g. from resume) or create a new one
    const sessionId = existingSessionId || (await createTerminalSession(profile, 120, 30, cwd)).sessionId;
    _pendingSessionIds.add(sessionId);

    // Create viewport element
    const viewport = document.createElement('div');
    viewport.className = 'term-viewport';
    viewport.dataset.sessionId = sessionId;

    // Route viewport to correct pane (or container root)
    if (_splitMode) {
      const targetPane = _focusedPane;
      _paneAssignments.set(sessionId, targetPane);
      const paneBody = _panel?.querySelector(`.term-pane[data-pane="${targetPane}"] .term-pane-body`);
      if (paneBody) paneBody.appendChild(viewport);
      else $('term-container').appendChild(viewport);
    } else {
      $('term-container').appendChild(viewport);
    }

    // Wait for fonts
    if (document.fonts?.ready) await document.fonts.ready;

    // Connect WebSocket
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${sessionId}`);

    // Create HTML renderer (deferred WS — set on open)
    const profileDef = PROFILES.find(p => p.id === profile);
    const cwdLabel = cwd ? cwd.split(/[\\/]/).pop() : '';

    // PTY resize debounce — prevents Claude Code/Ink from re-rendering
    // its TUI multiple times during a resize drag (250ms coalescing)
    let _ptyResizeTimer = null;
    const PTY_RESIZE_DEBOUNCE = 250;

    const htmlTerm = new _HtmlTermRenderer(viewport, null, {
      onTitle: (title) => {
        const sess = _sessions.find(s => s.id === sessionId);
        if (sess && title && !sess._userRenamed) {
          sess.label = title;
          renderTabBar();
        }
      },
      onResize: (cols, rows) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (_ptyResizeTimer) clearTimeout(_ptyResizeTimer);
        _ptyResizeTimer = setTimeout(() => {
          _ptyResizeTimer = null;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        }, PTY_RESIZE_DEBOUNCE);
      },
    });

    ws.onopen = () => {
      htmlTerm.setWebSocket(ws);
      // Send correct size to PTY (immediate — not debounced for initial connect)
      htmlTerm.fit();
      if (htmlTerm.cols >= 2 && htmlTerm.rows >= 2) {
        ws.send(JSON.stringify({ type: 'resize', cols: htmlTerm.cols, rows: htmlTerm.rows }));
      }
    };

    // Track CLI status for Claude Code / Codex / Gemini sessions
    if (CLI_PROFILES.has(profile)) _trackCliSession(sessionId);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output' || msg.type === 'replay') {
          htmlTerm.write(msg.data);
          if (CLI_PROFILES.has(profile)) _scheduleCliStatusCheck(sessionId);
        }
        if (msg.type === 'exit') {
          const _s = _sessions.find(s => s.id === sessionId);
          if (_s) _s._exitReceived = true;
          markSessionDead(sessionId);
        }
        if (msg.type === 'error') {
          if (msg.message === 'Session not found') { markSessionDead(sessionId); return; }
          htmlTerm.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        }
        if (msg.type === 'image_saved' && msg.path) {
          _clipCopy(msg.path);
          ws.send(JSON.stringify({ type: 'input', data: msg.path }));
          showTermToast(`Image pasted — ${msg.path.split(/[\\/]/).pop()}`);
        }
        if (msg.type === 'image_dropped' && msg.path) {
          ws.send(JSON.stringify({ type: 'input', data: msg.path }));
          showTermToast(`Image dropped — ${msg.path.split(/[\\/]/).pop()}`);
        }
        if (msg.type === 'memory_saved' && msg.path) {
          ws.send(JSON.stringify({ type: 'input', data: msg.path }));
          showTermToast(`Memory dropped — ${msg.path.split(/[\\/]/).pop()}`);
        }
      } catch {}
    };

    ws.onclose = () => {
      const session = _sessions.find(s => s.id === sessionId);
      if (session && !session.dead && !session._exitReceived) _reconnectTerminalWs(session);
    };

    // Register session
    const session = {
      id: sessionId,
      profile,
      cwd: cwd || null,
      label: options.label || (cwdLabel ? `${profileDef?.label || profile} · ${cwdLabel}` : (profileDef?.label || profile)),
      term: null,
      fitAddon: null,
      searchAddon: null,
      ws,
      viewport,
      ro: null, // ResizeObserver is inside HtmlTermRenderer
      renderer: 'html',
      dead: false,
      pinned: false,
      _userRenamed: !!options.label,
      _claudeSessionId: options.claudeSessionId || null,
      _isHtmlTerm: true,
      _htmlTerm: htmlTerm,
      _fitInProgress: false,
    };
    _pushSession(session);
    _pendingSessionIds.delete(sessionId);
    _activeIdx = _sessions.indexOf(session);

    // Right-click context menu (term=null for HTML term — handler uses session)
    initContextMenu(viewport, null, ws);

    // Slide panel up so user sees the session immediately
    ensurePanel();
    showPanel();
    if (_splitMode) renderSplitTabBars();
    renderTabBar();
    switchToSession(_activeIdx);
    saveSessionRegistry();

    // Auto-detect Claude session UUID for fresh CLI sessions (enables resume label sync)
    if (CLI_PROFILES.has(profile) && !options.claudeSessionId) {
      setTimeout(async () => {
        try {
          const r = await detectClaudeSession(sessionId);
          if (r?.claudeSessionId) {
            const sess = _sessions.find(s => s.id === sessionId);
            if (sess && !sess._claudeSessionId) {
              sess._claudeSessionId = r.claudeSessionId;
              saveSessionRegistry();
              if (sess._userRenamed && sess.label) syncResumeLabel(sess);
            }
          }
        } catch {}
      }, 4000);
    }
  } finally { _opening = false; }
}

/**
 * Reconnect to an existing CLI tool session using the HTML renderer.
 * Mirrors reconnectSession() but creates HtmlTermRenderer instead of xterm.
 */
async function reconnectHtmlTermSession(sessionId, profile, options = {}) {
  await loadHtmlTermRenderer();
  ensurePanel();

  const viewport = document.createElement('div');
  viewport.className = 'term-viewport';
  viewport.dataset.sessionId = sessionId;
  $('term-container').appendChild(viewport);
  if (_restoringLayout) viewport.style.display = 'none';

  if (document.fonts?.ready) await document.fonts.ready;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${sessionId}`);

  // PTY resize debounce (reconnect path)
  let _ptyResizeTimer2 = null;

  const htmlTerm = new _HtmlTermRenderer(viewport, null, {
    onTitle: (title) => {
      const sess = _sessions.find(s => s.id === sessionId);
      if (sess && title && !sess._userRenamed) {
        sess.label = title;
        renderTabBar();
      }
    },
    onResize: (cols, rows) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (_ptyResizeTimer2) clearTimeout(_ptyResizeTimer2);
      _ptyResizeTimer2 = setTimeout(() => {
        _ptyResizeTimer2 = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      }, 250);
    },
  });

  ws.onopen = () => {
    htmlTerm.setWebSocket(ws);
    htmlTerm.fit();
    if (htmlTerm.cols >= 2 && htmlTerm.rows >= 2) {
      ws.send(JSON.stringify({ type: 'resize', cols: htmlTerm.cols, rows: htmlTerm.rows }));
    }
  };

  // Track CLI status on reconnect
  if (CLI_PROFILES.has(profile)) _trackCliSession(sessionId);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'replay') {
        htmlTerm.write(msg.data);
        if (CLI_PROFILES.has(profile)) _scheduleCliStatusCheck(sessionId);
      }
      if (msg.type === 'exit') {
        const _s = _sessions.find(s => s.id === sessionId);
        if (_s) _s._exitReceived = true;
        markSessionDead(sessionId);
      }
      if (msg.type === 'error') {
        if (msg.message === 'Session not found') {
          markSessionDead(sessionId);
          return;
        }
        htmlTerm.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      }
      if (msg.type === 'image_saved' && msg.path) {
        _clipCopy(msg.path);
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image pasted — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'image_dropped' && msg.path) {
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'memory_saved' && msg.path) {
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Memory dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
    } catch {}
  };

  ws.onclose = () => {
    const s = _sessions.find(s => s.id === sessionId);
    if (s && !s.dead && !s._exitReceived) _reconnectTerminalWs(s);
  };

  const profileDef = PROFILES.find(p => p.id === profile);
  const session = {
    id: sessionId,
    profile,
    cwd: options.cwd || null,
    label: options.label || (profileDef?.label || profile),
    term: null,
    fitAddon: null,
    searchAddon: null,
    ws,
    viewport,
    ro: null,
    renderer: 'html',
    dead: false,
    pinned: options.pinned || false,
    _userRenamed: options.userRenamed || false,
    _claudeSessionId: options.claudeSessionId || null,
    _floatColor: options.floatColor || null,
    _isHtmlTerm: true,
    _htmlTerm: htmlTerm,
    _fitInProgress: false,
  };
  _pushSession(session);
  _activeIdx = _sessions.indexOf(session);

  // Right-click context menu (term=null for HTML term — handler uses session)
  initContextMenu(viewport, null, ws);

  ensurePanel();
  if (_panel.classList.contains('hidden')) {
    showPeekDock();
  }
  renderTabBar();
  if (!_restoringLayout) switchToSession(_activeIdx);
  saveSessionRegistry();
}

// ═══════════════════════════════════════════
// BROWSER TAB — CDP screencast in a tab
// ═══════════════════════════════════════════

/**
 * Open a browser tab. Creates a server-side Playwright browser session,
 * connects via WebSocket for CDP screencast frames, and renders them
 * onto a canvas with an address bar overlay.
 */
async function openBrowserSession(url, fresh, _unused, force) {
  if (isGuest() && !hasPermission('browser')) return;
  // Auto-unstick _opening if it's been true for over 15 seconds (previous attempt crashed/hung)
  if (_opening && _openingAt && (Date.now() - _openingAt > 15000)) {
    console.warn('[browser] _opening guard stuck for >15s, resetting');
    _opening = false;
  }
  // fresh or force bypass the _opening guard
  if (_opening && !fresh && !force) return;

  // If a browser tab already exists and not requesting fresh/force, just switch to it
  const existingBrowserTab = document.querySelector('.term-tab[data-profile="browser"]');
  if (existingBrowserTab && !url && !fresh && !force) {
    existingBrowserTab.click();
    return;
  }

  _opening = true;
  _openingAt = Date.now();
  try {
  ensurePanel();

  // fresh=true: close ALL existing browser sessions so MCP tools auto-select ours
  if (fresh) {
    try {
      const existing = await fetchBrowserSessions();
      const sessions = existing?.sessions || [];
      for (const s of sessions) {
        await deleteBrowserSession(s.id).catch(() => {});
      }
      // Also close any existing browser tabs in the UI
      document.querySelectorAll('.term-tab[data-profile="browser"]').forEach(tab => {
        const idx = Array.from(document.querySelectorAll('.term-tab')).indexOf(tab);
        if (idx >= 0 && _sessions[idx]) closeTab(idx);
      });
    } catch (e) { /* ignore cleanup errors */ }
  }

  const startUrl = url || 'https://www.google.com';
  // Collect the real browser's fingerprint to clone into the automated instance
  const fingerprint = {
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    deviceScaleFactor: window.devicePixelRatio || 1,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const browserOpts = {};
  const { sessionId, profileMode, profileSource } = await createBrowserSession(startUrl, null, null, fingerprint, browserOpts);

  // Build browser viewport: address bar + canvas
  const viewport = document.createElement('div');
  viewport.className = 'term-viewport browser-viewport';
  viewport.dataset.sessionId = sessionId;

  const navbar = document.createElement('div');
  navbar.className = 'browser-navbar';

  navbar.innerHTML = `
    <button class="browser-nav-btn browser-back-btn" data-tooltip="Back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <button class="browser-nav-btn browser-fwd-btn" data-tooltip="Forward">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
    <button class="browser-nav-btn browser-reload-btn" data-tooltip="Reload">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </button>
    <div class="browser-url-bar">
      <input type="text" class="browser-url-input" value="${startUrl.replace(/"/g, '&quot;')}" spellcheck="false" autocomplete="off">
    </div>
    <span class="browser-title-label"></span>
  `;
  viewport.appendChild(navbar);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'browser-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'browser-canvas';
  canvas.width = 1280;
  canvas.height = 800;
  canvasWrap.appendChild(canvas);
  viewport.appendChild(canvasWrap);

  $('term-container').appendChild(viewport);

  const ctx = canvas.getContext('2d');
  const frameRenderer = createFrameRenderer(canvas, ctx);

  // Connect WebSocket for screencast
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/browser/${sessionId}`);

  const urlInput = navbar.querySelector('.browser-url-input');
  const titleLabel = navbar.querySelector('.browser-title-label');

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'frame' && msg.data) {
        frameRenderer.render(msg.data);
      } else if (msg.type === 'navigated' || msg.type === 'loaded' || msg.type === 'init') {
        if (msg.url) {
          urlInput.value = msg.url;
          // Update session metadata
          const sess = _sessions.find(s => s.id === sessionId);
          if (sess) sess._browserUrl = msg.url;
        }
        if (msg.title) {
          titleLabel.textContent = msg.title;
          const sess = _sessions.find(s => s.id === sessionId);
          if (sess) {
            sess._browserTitle = msg.title;
            if (!sess._userRenamed) {
              sess.label = msg.title.length > 30 ? msg.title.slice(0, 30) + '…' : msg.title;
              renderTabBar();
            }
            // Update floating tab title if detached
            const dt = _detachedTabs.get(sessionId);
            if (dt) {
              const titleEl = dt.el.querySelector('.term-float-tab-title');
              if (titleEl) titleEl.textContent = sess.label;
            }
          }
        }
      } else if (msg.type === 'error') {
        console.warn('Browser session error:', msg.message);
      }
    } catch {}
  };

  ws.onclose = () => {
    const sess = _sessions.find(s => s.id === sessionId);
    if (sess && !sess.dead) {
      // Browser sessions can't be recovered — auto-close instead of leaving dead tab
      const idx = _sessions.indexOf(sess);
      if (idx >= 0) closeSession(idx);
    }
  };

  // ── Nav button handlers ──
  navbar.querySelector('.browser-back-btn').addEventListener('click', () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'back' }));
  });
  navbar.querySelector('.browser-fwd-btn').addEventListener('click', () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'forward' }));
  });
  navbar.querySelector('.browser-reload-btn').addEventListener('click', () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reload' }));
  });

  // Navigate on Enter in URL bar
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      let navUrl = urlInput.value.trim();
      if (navUrl && !navUrl.match(/^https?:\/\//)) navUrl = 'https://' + navUrl;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'navigate', url: navUrl }));
      }
    }
  });

  // ── Forward mouse events from canvas to browser ──
  function canvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  canvas.addEventListener('click', (e) => {
    const { x, y } = canvasCoords(e);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'click', x, y }));
  });
  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = canvasCoords(e);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'dblclick', x, y }));
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY }));
    }
  }, { passive: false });

  // Forward keyboard events when canvas is focused
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (ws.readyState === WebSocket.OPEN) {
      // For printable single characters, use keypress (type text)
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        ws.send(JSON.stringify({ type: 'keypress', text: e.key }));
      } else {
        ws.send(JSON.stringify({ type: 'keydown', key: e.key }));
      }
    }
  });
  canvas.addEventListener('keyup', (e) => {
    e.preventDefault();
    if (e.key.length > 1 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'keyup', key: e.key }));
    }
  });

  // ── Resize observer → resize browser viewport to match container ──
  // Track last good dimensions to avoid sending tiny sizes on minimize
  let _lastGoodWidth = 1280, _lastGoodHeight = 800;
  let _resizeTimer = null;

  function sendBrowserResize() {
    const rect = canvasWrap.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    // Skip tiny dimensions (window minimized or hidden)
    if (w < 100 || h < 100) return;
    // Skip if dimensions haven't actually changed
    if (w === _lastGoodWidth && h === _lastGoodHeight) return;
    _lastGoodWidth = w;
    _lastGoodHeight = h;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', width: w, height: h }));
    }
  }

  const ro = new ResizeObserver(() => { clearTimeout(_resizeTimer); _resizeTimer = setTimeout(sendBrowserResize, 200); });
  ro.observe(canvasWrap);

  // Re-send proper dimensions when window is restored from minimize
  const _visibilityHandler = () => {
    if (!document.hidden) {
      // Small delay to let the layout settle after restore
      setTimeout(() => sendBrowserResize(), 150);
    }
  };
  document.addEventListener('visibilitychange', _visibilityHandler);

  // Build tab label with profile info
  let tabLabel = 'Browser';
  if (profileMode === 'mirror' && profileSource) {
    tabLabel = `Browser (${profileSource})`;
    showTermToast(`Synced copy of ${profileSource} — Chrome is running`);
  } else if (profileMode === 'direct' && profileSource) {
    tabLabel = `Browser (${profileSource})`;
  }

  // Register session
  const session = {
    id: sessionId,
    profile: 'browser',
    cwd: null,
    label: tabLabel,
    term: null,         // no xterm for browser tabs
    fitAddon: null,
    searchAddon: null,
    ws,
    viewport,
    ro,
    renderer: null,
    dead: false,
    pinned: false,
    _isBrowser: true,   // flag for tab-type-specific logic
    _browserUrl: startUrl,
    _browserTitle: '',
    _browserCanvas: canvas,
    _browserCtx: ctx,
    _frameRenderer: frameRenderer,
    _visibilityHandler,
  };
  _pushSession(session);
  _activeIdx = _sessions.indexOf(session);

  ensurePanel();
  if (_panel.classList.contains('hidden')) {
    showPeekDock();
  }
  renderTabBar();
  switchToSession(_activeIdx);

  // Auto-detach browser tabs into floating windows
  detachTab(_activeIdx);

  saveSessionRegistry();
  } finally { _opening = false; }
}

/** Reconnect to an existing server-side browser session (no new browser launched) */
async function reconnectBrowserSession(sessionId, liveData, saved) {
  ensurePanel();

  const viewport = document.createElement('div');
  viewport.className = 'term-viewport browser-viewport';
  viewport.dataset.sessionId = sessionId;

  const currentUrl = liveData?.url || saved?.label || 'about:blank';

  const navbar = document.createElement('div');
  navbar.className = 'browser-navbar';
  navbar.innerHTML = `
    <button class="browser-nav-btn browser-back-btn" data-tooltip="Back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <button class="browser-nav-btn browser-fwd-btn" data-tooltip="Forward">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
    <button class="browser-nav-btn browser-reload-btn" data-tooltip="Reload">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
    </button>
    <div class="browser-url-bar">
      <input type="text" class="browser-url-input" value="${currentUrl.replace(/"/g, '&quot;')}" spellcheck="false" autocomplete="off">
    </div>
    <span class="browser-title-label">${liveData?.title || ''}</span>
  `;
  viewport.appendChild(navbar);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'browser-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'browser-canvas';
  canvas.width = 1280;
  canvas.height = 800;
  canvasWrap.appendChild(canvas);
  viewport.appendChild(canvasWrap);

  $('term-container').appendChild(viewport);

  const ctx = canvas.getContext('2d');
  const frameRenderer = createFrameRenderer(canvas, ctx);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/browser/${sessionId}`);

  const urlInput = navbar.querySelector('.browser-url-input');
  const titleLabel = navbar.querySelector('.browser-title-label');

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'frame' && msg.data) {
        frameRenderer.render(msg.data);
      } else if (msg.type === 'navigated' || msg.type === 'loaded' || msg.type === 'init') {
        if (msg.url) { urlInput.value = msg.url; const sess = _sessions.find(s => s.id === sessionId); if (sess) sess._browserUrl = msg.url; }
        if (msg.title) {
          titleLabel.textContent = msg.title;
          const sess = _sessions.find(s => s.id === sessionId);
          if (sess) { sess._browserTitle = msg.title; if (!sess._userRenamed) { sess.label = msg.title.length > 30 ? msg.title.slice(0, 30) + '…' : msg.title; renderTabBar(); } }
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    const sess = _sessions.find(s => s.id === sessionId);
    if (sess && !sess.dead) {
      const idx = _sessions.indexOf(sess);
      if (idx >= 0) closeSession(idx);
    }
  };

  // Nav buttons
  navbar.querySelector('.browser-back-btn').addEventListener('click', () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'back' })); });
  navbar.querySelector('.browser-fwd-btn').addEventListener('click', () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'forward' })); });
  navbar.querySelector('.browser-reload-btn').addEventListener('click', () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'reload' })); });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      let navUrl = urlInput.value.trim();
      if (navUrl && !navUrl.match(/^https?:\/\//)) navUrl = 'https://' + navUrl;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'navigate', url: navUrl }));
    }
  });

  // Mouse/keyboard forwarding
  function canvasCoords(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; }
  canvas.addEventListener('click', (e) => { const c = canvasCoords(e); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'click', ...c })); });
  canvas.addEventListener('dblclick', (e) => { const c = canvasCoords(e); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'dblclick', ...c })); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY })); }, { passive: false });
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', (e) => { e.preventDefault(); if (ws.readyState === WebSocket.OPEN) { if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) ws.send(JSON.stringify({ type: 'keypress', text: e.key })); else ws.send(JSON.stringify({ type: 'keydown', key: e.key })); } });
  canvas.addEventListener('keyup', (e) => { e.preventDefault(); if (e.key.length > 1 && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'keyup', key: e.key })); });

  let _lastGoodW2 = 1280, _lastGoodH2 = 800;
  let _resizeTimer2 = null;
  function sendReconnResize() {
    const rect = canvasWrap.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 100 || h < 100) return;
    if (w === _lastGoodW2 && h === _lastGoodH2) return;
    _lastGoodW2 = w; _lastGoodH2 = h;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', width: w, height: h }));
    }
  }
  const ro = new ResizeObserver(() => { clearTimeout(_resizeTimer2); _resizeTimer2 = setTimeout(sendReconnResize, 200); });
  ro.observe(canvasWrap);
  const _visibilityHandler = () => { if (!document.hidden) setTimeout(() => sendReconnResize(), 150); };
  document.addEventListener('visibilitychange', _visibilityHandler);

  const session = {
    id: sessionId, profile: 'browser', cwd: null,
    label: saved?.label || liveData?.title || 'Browser',
    term: null, fitAddon: null, searchAddon: null,
    ws, viewport, ro, renderer: null,
    dead: false, pinned: saved?.pinned || false,
    _userRenamed: saved?.userRenamed || false,
    _isBrowser: true, _browserUrl: currentUrl, _browserTitle: liveData?.title || '',
    _browserCanvas: canvas, _browserCtx: ctx, _frameRenderer: frameRenderer, _visibilityHandler,
  };
  _pushSession(session);
  _activeIdx = _sessions.indexOf(session);

  ensurePanel();
  if (_panel.classList.contains('hidden')) {
    showPeekDock();
  }
  renderTabBar();
  switchToSession(_activeIdx);

  // Auto-detach browser tabs into floating windows
  detachTab(_activeIdx);
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
    scrollOnUserInput: true,
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
  if (_restoringLayout) viewport.style.display = 'none';

  // Wait for fonts before opening (same FOUT fix as openSession)
  if (document.fonts?.ready) await document.fonts.ready;
  term.open(viewport);

  // Find xterm's internal textarea (used for paste handler below, after ws is created)
  const xtermTextarea = viewport.querySelector('.xterm-helper-textarea');

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
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (_CanvasAddon) {
          try { term.loadAddon(new _CanvasAddon()); } catch {}
        }
      });
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
    // Shift+Enter → insert literal newline (multi-line command editing)
    if (e.shiftKey && e.key === 'Enter') {
      if (e.type === 'keydown' && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: '\x16\n' }));
      }
      return false;
    }
    // Ctrl+C → copy if text selected, otherwise pass through as SIGINT
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = term.getSelection();
      if (sel) {
        if (e.type === 'keydown') _clipCopy(sel);
        return false;
      }
      return true;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      if (e.type === 'keydown') {
        const sel = term.getSelection();
        if (sel) _clipCopy(sel);
      }
      return false;
    }
    // Ctrl+V — block xterm from sending \x16 (lnext) to PTY.
    // Browser paste event still fires → xterm's built-in paste handler processes it.
    if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
      return false;
    }
    if (e.ctrlKey && !e.shiftKey && e.key === 'f' && e.type === 'keydown') {
      const sess = _sessions.find(s => s.viewport === viewport);
      if (sess && _detachedTabs.has(sess.id)) toggleFloatSearchBar(sess);
      else toggleSearchBar(true);
      return false;
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'F' && e.type === 'keydown') {
      const sess = _sessions.find(s => s.viewport === viewport);
      if (sess && _detachedTabs.has(sess.id)) toggleFloatSearchBar(sess);
      else toggleSearchBar(false);
      return false;
    }
    // ESC is handled by the global window capture listener in initTerminal()
    return true; // let xterm handle everything else
  });

  // ── Paste event on textarea (capture) — intercept IMAGE paste only ──
  // Text paste falls through to xterm's built-in paste handler.
  if (xtermTextarea) {
    xtermTextarea.addEventListener('paste', (e) => {
      if (!e.clipboardData || ws.readyState !== WebSocket.OPEN) return;
      // Only intercept image paste — text falls through to xterm's built-in handler
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const blob = item.getAsFile();
          if (!blob) return;
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'image_paste', data: base64, mimeType: item.type }));
            }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
      // Text: do nothing — xterm's built-in paste handler fires next
    }, true);
  }

  // Copy-on-select (debounced to avoid focus churn during drag)
  let _selTimer = null;
  term.onSelectionChange(() => {
    if (_selTimer) clearTimeout(_selTimer);
    _selTimer = setTimeout(() => {
      _selTimer = null;
      const sel = term.getSelection();
      if (sel) _clipCopy(sel);
    }, 150);
  });

  ws.onopen = () => {
    // Same guard as openSession: skip fit if viewport is in a hidden container.
    // The correct resize will come from _scheduleFit when the viewport is visible.
    const dims = fitAddon.proposeDimensions();
    if (dims && dims.cols >= 2 && dims.rows >= 2 &&
        Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
      fitAddon.fit();
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'replay') {
        term.write(msg.data);
      }
      if (msg.type === 'exit') {
        const _s = _sessions.find(s => s.id === sessionId);
        if (_s) _s._exitReceived = true;
        markSessionDead(sessionId);
      }
      if (msg.type === 'error') {
        if (msg.message === 'Session not found') {
          markSessionDead(sessionId);
          return;
        }
        term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      }
      if (msg.type === 'image_saved' && msg.path) {
        _clipCopy(msg.path);
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image pasted — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'image_dropped' && msg.path) {
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'memory_saved' && msg.path) {
        ws.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Memory dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
    } catch {}
  };

  ws.onclose = () => {
    const s = _sessions.find(s => s.id === sessionId);
    if (s && !s.dead && !s._exitReceived) _reconnectTerminalWs(s);
  };

  // Forward terminal input to PTY (use session.ws lookup so reconnected WS is used)
  term.onData((data) => {
    const s = _sessions.find(s => s.id === sessionId);
    if (s?.ws?.readyState === WebSocket.OPEN) {
      s.ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  const ro = new ResizeObserver(() => {
    const s = _sessions.find(s => s.id === sessionId);
    if (s) _scheduleFit(s);
  });
  ro.observe(viewport);

  initContextMenu(viewport, term, ws);
  initMemoryDrop(viewport, ws, term);

  const profileDef = PROFILES.find(p => p.id === profile);
  const session = {
    id: sessionId,
    profile,
    cwd: options.cwd || null,
    label: options.label || (profileDef?.label || profile),
    term, fitAddon, searchAddon, ws, viewport, ro,
    renderer,
    dead: false,
    pinned: options.pinned || false,
    _userRenamed: options.userRenamed || false,
    _claudeSessionId: options.claudeSessionId || null,
    _floatColor: options.floatColor || null,
    _fitInProgress: false,
  };
  _pushSession(session);
  _activeIdx = _sessions.indexOf(session);

  ensurePanel();
  if (_panel.classList.contains('hidden')) {
    showPeekDock();
  }
  renderTabBar();
  if (!_restoringLayout) switchToSession(_activeIdx);
  saveSessionRegistry();
}

function switchToSession(idx) {
  if (idx < 0 || idx >= _sessions.length) return;

  // In split mode, delegate to pane-aware switching
  if (_splitMode) {
    const pane = _paneAssignments.get(_sessions[idx].id) ?? 0;
    _focusedPane = pane;
    updatePaneFocusRing();
    switchToSessionInPane(idx, pane);
    return;
  }

  _activeIdx = idx;

  // Close docked file tree on tab switch
  const sidebar = $('term-file-sidebar');
  if (sidebar?.classList.contains('open')) {
    sidebar.classList.remove('open');
    sidebar.innerHTML = '';
  }

  _sessions.forEach((s, i) => {
    // Don't touch viewports of detached tabs — they live in floating windows
    if (_detachedTabs.has(s.id)) return;
    s.viewport.style.display = i === idx ? '' : 'none';
    if (i === idx) {
      requestAnimationFrame(() => {
        if (s._isBrowser) {
          // Focus canvas for keyboard input
          s._browserCanvas?.focus();
        } else if (s._isHtmlTerm) {
          s._htmlTerm.fit();
          s._htmlTerm.focus();
        } else {
          _scheduleFit(s);
          s.term.focus();
        }
      });
    }
  });

  renderTabBar();
}

async function closeSession(idx) {
  if (idx < 0 || idx >= _sessions.length) return;
  const session = _sessions[idx];

  // Guard: prevent re-entry (ws.onclose fires when we call ws.close() below)
  if (_closingIds.has(session.id)) return;
  _closingIds.add(session.id);

  // Clean up detached tab window + minimized pill if any
  const tabState = _detachedTabs.get(session.id);
  if (tabState) {
    if (tabState.cleanup) tabState.cleanup();
    tabState.el.remove();
    if (tabState.pill) tabState.pill.remove();
    _detachedTabs.delete(session.id);
    _updateSnappedEdges();
  }

  // Cleanup — mark dead first to prevent ws.onclose from re-entering
  session.dead = true;
  _untrackCliSession(session.id);
  if (session.ro) session.ro.disconnect();
  if (session._frameRenderer) session._frameRenderer.destroy();
  if (session.ws) session.ws.close();
  if (session._isHtmlTerm && session._htmlTerm) session._htmlTerm.dispose();
  if (session.term) session.term.dispose();
  if (session._visibilityHandler) document.removeEventListener('visibilitychange', session._visibilityHandler);
  session.viewport.remove();

  // Remove from sessions array BEFORE async server delete —
  // prevents dead tab from flashing in the tab bar during the await gap
  const currentIdx = _sessions.indexOf(session);
  if (currentIdx < 0) { _closingIds.delete(session.id); return; }

  // Capture pane assignment before removing
  const closedPane = _paneAssignments.get(session.id) ?? 0;
  _paneAssignments.delete(session.id);

  _sessions.splice(currentIdx, 1);

  // Kill server-side session (fire-and-forget after UI cleanup)
  if (session._isBrowser) {
    if (!session._skipServerDelete) deleteBrowserSession(session.id).catch(() => {});
  } else if (!session._gitOutput) {
    deleteTerminalSession(session.id).catch(() => {});
  }

  // Handle split-mode pane emptiness
  if (_splitMode) {
    const paneHasSessions = (p) => _sessions.some(s =>
      _paneAssignments.get(s.id) === p && !_detachedTabs.has(s.id));
    if (!paneHasSessions(0) || !paneHasSessions(1)) {
      deactivateSplit();
      // After unsplit, fix active index for remaining sessions
      if (_sessions.length > 0) {
        const anyDocked = _sessions.findIndex(s => !_detachedTabs.has(s.id));
        if (anyDocked >= 0) switchToSession(anyDocked);
      }
      renderTabBar();
      saveSessionRegistry();
      _closingIds.delete(session.id);
      return;
    }
    // Update active in affected pane
    if (_activePaneIdx[closedPane] === currentIdx || _activePaneIdx[closedPane] >= _sessions.length) {
      const next = _sessions.findIndex((s) =>
        _paneAssignments.get(s.id) === closedPane && !_detachedTabs.has(s.id));
      _activePaneIdx[closedPane] = next;
      if (next >= 0) switchToSessionInPane(next, closedPane);
    }
    // Fix stale indices in _activePaneIdx (session array shifted)
    for (let p = 0; p < 2; p++) {
      if (_activePaneIdx[p] >= currentIdx && _activePaneIdx[p] > 0) {
        // Don't decrement if it's the closed index itself (already handled above)
        if (_activePaneIdx[p] > currentIdx) _activePaneIdx[p]--;
      }
    }
    renderSplitTabBars();
    saveSessionRegistry();
    _closingIds.delete(session.id);
    return;
  }

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
    _activeIdx = Math.min(currentIdx, _sessions.length - 1);
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
  _closingIds.delete(session.id);
}

/** Disconnect all sessions client-side WITHOUT killing server PTY.
 *  Used before workspace switch or before reconnecting to a different set. */
export function disconnectAllSessions() {
  // Remove all detached tab floating windows
  for (const [, tabState] of _detachedTabs) {
    if (tabState.cleanup) tabState.cleanup();
    tabState.el.remove();
  }
  _detachedTabs.clear();

  // Dispose all sessions — WS close triggers server grace timer, PTY stays alive
  // Mark dead first to prevent ws.onclose handlers from re-entering closeSession
  for (const session of _sessions) {
    session.dead = true;
    if (session.ro) session.ro.disconnect();
    session.ws.close();
    if (session._isHtmlTerm && session._htmlTerm) session._htmlTerm.dispose();
    if (session.term) session.term.dispose();
    session.viewport.remove();
  }
  _sessions = [];
  _activeIdx = -1;

  // Clean up split state
  if (_splitMode) {
    _splitMode = false;
    _paneAssignments.clear();
    _activePaneIdx = [-1, -1];
    _focusedPane = 0;
    const container = $('term-container');
    if (container) {
      container.querySelectorAll('.term-pane, .term-split-divider').forEach(el => el.remove());
      container.classList.remove('split-active');
      container.style.display = '';
      container.style.flexDirection = '';
      container.style.alignItems = '';
    }
    const btn = $('term-split-btn');
    if (btn) {
      btn.dataset.tooltip = 'Split terminal';
      btn.classList.remove('split-active');
    }
    const mainBar = $('term-tab-bar');
    if (mainBar) mainBar.style.display = '';
  }

  // Hide panel, keep peek dock visible
  if (_panel && !_panel.classList.contains('hidden')) {
    _panel.classList.add('hidden');
    document.documentElement.style.setProperty('--terminal-height', '0px');
  }
  showPeekDock();
}

function _reconnectTerminalWs(session, attempt = 0) {
  if (session.dead || session._exitReceived) return;
  // Guard: prevent multiple simultaneous reconnect attempts (visibilitychange + ws.onclose race)
  if (attempt === 0 && session._reconnecting) return;
  session._reconnecting = true;
  const maxAttempts = 3;
  const delay = 2000;

  // Close any stale WS still in CONNECTING/OPEN state to prevent duplicate server connections
  if (session.ws && session.ws.readyState <= WebSocket.OPEN) {
    try { session.ws.close(); } catch {}
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${session.id}`);

  ws.onopen = () => {
    session._reconnecting = false;
    session.ws = ws;
    if (session._isHtmlTerm && session._htmlTerm) {
      session._htmlTerm.setWebSocket(ws);
      session._htmlTerm.fit();
      if (session._htmlTerm.cols >= 2 && session._htmlTerm.rows >= 2) {
        ws.send(JSON.stringify({ type: 'resize', cols: session._htmlTerm.cols, rows: session._htmlTerm.rows }));
      }
    } else if (session.term) {
      const dims = session.fitAddon?.proposeDimensions();
      if (dims?.cols >= 2 && dims?.rows >= 2) {
        session.fitAddon.fit();
        ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
      }
    }
  };

  ws.onmessage = (e) => {
    // Ignore messages from superseded WS connections
    if (session.ws !== ws) return;
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'replay') {
        if (session._isHtmlTerm) {
          session._htmlTerm?.write(msg.data);
          if (CLI_PROFILES.has(session.profile)) _scheduleCliStatusCheck(session.id);
        } else if (session.term) {
          session.term.write(msg.data);
        }
      }
      if (msg.type === 'exit') {
        session._exitReceived = true;
        markSessionDead(session.id);
      }
      if (msg.type === 'error') {
        if (msg.message === 'Session not found') { markSessionDead(session.id); return; }
        if (session._isHtmlTerm) session._htmlTerm?.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
        else if (session.term) session.term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
      }
      if (msg.type === 'image_saved' && msg.path) {
        _clipCopy(msg.path);
        session.ws?.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image pasted — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'image_dropped' && msg.path) {
        session.ws?.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Image dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
      if (msg.type === 'memory_saved' && msg.path) {
        session.ws?.send(JSON.stringify({ type: 'input', data: msg.path }));
        showTermToast(`Memory dropped — ${msg.path.split(/[\\/]/).pop()}`);
      }
    } catch {}
  };

  ws.onclose = () => {
    if (session.dead || session._exitReceived) return;
    if (attempt < maxAttempts - 1) {
      setTimeout(() => _reconnectTerminalWs(session, attempt + 1), delay);
    } else {
      session._reconnecting = false;
      markSessionDead(session.id);
    }
  };
}

function markSessionDead(sessionId) {
  const session = _sessions.find(s => s.id === sessionId);
  if (session) {
    session.dead = true;
    renderTabBar();
    // Set badge to "Done" instead of removing it
    const tracked = _cliSessionStatus.get(sessionId);
    if (tracked) {
      tracked.status = CLI_STATUS.DONE;
      if (tracked.timer) { clearTimeout(tracked.timer); tracked.timer = null; }
      if (tracked.pollInterval) { clearInterval(tracked.pollInterval); tracked.pollInterval = null; }
      _updateSessionBadges(sessionId, CLI_STATUS.DONE);
    }
  }
}

// ── Touch toolbar (mobile/tablet arrow keys + modifiers) ──

const _isTouchDevice = matchMedia('(pointer: coarse)').matches;

function _createTouchToolbar(session) {
  if (!_isTouchDevice) return null;

  const bar = document.createElement('div');
  bar.className = 'term-touch-toolbar';

  // Key definitions: label, sequence to send (or special action)
  const keys = [
    { label: 'Esc', seq: '\x1b' },
    { label: 'Tab', seq: '\t' },
    { label: '↑', seq: '\x1b[A' },
    { label: '↓', seq: '\x1b[B' },
    { label: '←', seq: '\x1b[D' },
    { label: '→', seq: '\x1b[C' },
    { label: 'Ctrl', action: 'ctrl' },
    { label: '^C', seq: '\x03' },
    { label: 'y', seq: 'y' },
    { label: 'n', seq: 'n' },
  ];

  let ctrlActive = false;

  function sendToSession(data) {
    if (session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: 'input', data }));
    }
  }

  for (const key of keys) {
    const btn = document.createElement('button');
    btn.className = 'term-touch-key';
    btn.textContent = key.label;
    btn.setAttribute('tabindex', '-1');

    if (key.action === 'ctrl') {
      btn.classList.add('term-touch-mod');
      btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        ctrlActive = !ctrlActive;
        btn.classList.toggle('active', ctrlActive);
      }, { passive: false });
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        ctrlActive = !ctrlActive;
        btn.classList.toggle('active', ctrlActive);
      });
    } else {
      const handler = (e) => {
        e.preventDefault();
        if (ctrlActive && key.seq.length === 1) {
          // Ctrl+letter → control code
          const code = key.seq.toUpperCase().charCodeAt(0);
          if (code >= 65 && code <= 90) sendToSession(String.fromCharCode(code - 64));
          else sendToSession(key.seq);
          // Auto-release Ctrl
          ctrlActive = false;
          bar.querySelector('.term-touch-mod')?.classList.remove('active');
        } else {
          sendToSession(key.seq);
        }
        // Refocus terminal input
        if (session._isHtmlTerm) session._htmlTerm?.focus();
        else session.term?.focus();
      };
      btn.addEventListener('touchstart', handler, { passive: false });
      btn.addEventListener('mousedown', handler);
    }

    bar.appendChild(btn);
  }

  session.viewport.appendChild(bar);
  return bar;
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

  // Close on outside click and clean up stale handler
  document.addEventListener('click', () => {
    menu.classList.remove('open');
    if (_ctxMenuHandler) {
      menu.removeEventListener('click', _ctxMenuHandler);
      _ctxMenuHandler = null;
    }
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

    // Find session for this viewport
    const session = _sessions.find(s => s.viewport === viewport);

    // Remove previous handler to avoid stacking (multiple right-clicks without clicking an item)
    if (_ctxMenuHandler) menu.removeEventListener('click', _ctxMenuHandler);

    const handler = (evt) => {
      const item = evt.target.closest('.term-ctx-item');
      if (!item) return;
      const action = item.dataset.action;

      switch (action) {
        case 'copy': {
          const sel = session?._isHtmlTerm
            ? session._htmlTerm?.getSelection()
            : term?.getSelection();
          if (sel) _clipCopy(sel);
          break;
        }
        case 'paste':
          navigator.clipboard.read().then(items => {
            for (const ci of items) {
              const imgType = ci.types.find(t => t.startsWith('image/'));
              if (imgType) {
                ci.getType(imgType).then(blob => {
                  const reader = new FileReader();
                  reader.onload = () => {
                    const base64 = reader.result.split(',')[1];
                    if (ws && ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: 'image_paste', data: base64, mimeType: imgType }));
                    }
                  };
                  reader.readAsDataURL(blob);
                });
                return;
              }
            }
            // No image — text paste
            navigator.clipboard.readText().then(text => {
              if (text) {
                if (session?._isHtmlTerm) session._htmlTerm?.paste(text);
                else if (session?.term) session.term.paste(text);
              }
            }).catch(() => {});
          }).catch(() => {
            // Fallback if clipboard.read() not available
            navigator.clipboard.readText().then(text => {
              if (text) {
                if (session?._isHtmlTerm) session._htmlTerm?.paste(text);
                else if (session?.term) session.term.paste(text);
              }
            }).catch(() => {});
          });
          break;
        case 'select-all':
          if (session?._isHtmlTerm) { /* HtmlTermRenderer doesn't support selectAll */ }
          else if (term) term.selectAll();
          break;
        case 'clear':
          if (session?._isHtmlTerm) session._htmlTerm?.clear?.();
          else if (term) term.clear();
          break;
        case 'find':
          if (session && _detachedTabs.has(session.id)) {
            toggleFloatSearchBar(session);
          } else {
            toggleSearchBar(true);
          }
          break;
      }

      menu.classList.remove('open');
      menu.removeEventListener('click', handler);
      _ctxMenuHandler = null;
    };

    _ctxMenuHandler = handler;
    menu.addEventListener('click', handler);
  });
}

/** Toggle an inline search bar inside a floating terminal window */
function toggleFloatSearchBar(session) {
  if (!session?.searchAddon) return;
  const tabState = _detachedTabs.get(session.id);
  if (!tabState) return;

  const win = tabState.el;
  let bar = win.querySelector('.float-search-bar');

  if (bar) {
    // Toggle off
    bar.remove();
    session.searchAddon.clearDecorations();
    session.term?.focus();
    return;
  }

  // Create search bar
  bar = document.createElement('div');
  bar.className = 'float-search-bar';
  bar.innerHTML = `
    <input type="text" class="float-search-input" placeholder="Find..." spellcheck="false" autocomplete="off">
    <span class="float-search-count"></span>
    <button class="float-search-nav" title="Previous">&#9650;</button>
    <button class="float-search-nav" title="Next">&#9660;</button>
    <button class="float-search-nav float-search-close" title="Close">&times;</button>
  `;

  // Insert after header, before body
  const header = win.querySelector('.term-float-tab-header');
  header.after(bar);

  const input = bar.querySelector('.float-search-input');
  const btns = bar.querySelectorAll('.float-search-nav');

  input.addEventListener('input', () => {
    if (input.value) session.searchAddon.findNext(input.value, { incremental: true });
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) session.searchAddon.findPrevious(input.value);
      else session.searchAddon.findNext(input.value);
    }
    if (e.key === 'Escape') {
      bar.remove();
      session.searchAddon.clearDecorations();
      session.term?.focus();
    }
  });

  // Prev button
  btns[0].addEventListener('click', (e) => { e.stopPropagation(); session.searchAddon.findPrevious(input.value); });
  // Next button
  btns[1].addEventListener('click', (e) => { e.stopPropagation(); session.searchAddon.findNext(input.value); });
  // Close button
  btns[2].addEventListener('click', (e) => {
    e.stopPropagation();
    bar.remove();
    session.searchAddon.clearDecorations();
    session.term?.focus();
  });

  input.focus();
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

// ── Memory & whiteboard image drag-drop (explorer/whiteboard → terminal) ──

const SYNABUN_DRAG_TYPES = ['application/x-synabun-memory', 'application/x-synabun-wb-image'];

function initMemoryDrop(viewport, ws, term) {
  viewport.addEventListener('dragover', (e) => {
    if (!SYNABUN_DRAG_TYPES.some(t => e.dataTransfer.types.includes(t))) return;
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

    // Memory drop
    const memoryId = e.dataTransfer.getData('application/x-synabun-memory');
    if (memoryId) {
      e.preventDefault();
      const node = state.allNodes?.find(n => n.id === memoryId);
      if (!node || ws.readyState !== WebSocket.OPEN) return;
      sendMemoryDrop(node, ws);
      term.focus();
      return;
    }

    // Whiteboard image drop
    const wbImageId = e.dataTransfer.getData('application/x-synabun-wb-image');
    if (wbImageId) {
      e.preventDefault();
      if (ws.readyState !== WebSocket.OPEN) return;
      sendWhiteboardImageDrop(wbImageId, ws);
      term.focus();
      return;
    }
  });
}

function sendWhiteboardImageDrop(elementId, ws) {
  const el = getWhiteboardElementById(elementId);
  if (!el || el.type !== 'image' || !el.dataUrl) return;
  // dataUrl is "data:image/jpeg;base64,..." — extract the base64 and mimeType
  const match = el.dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return;
  const mimeType = match[1];
  const data = match[2];
  ws.send(JSON.stringify({ type: 'image_drop', data, mimeType }));
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
  if (session?.pinned) {
    // Focus the terminal for keyboard input — skip if already focused (preserves selection)
    if (session._isHtmlTerm) {
      requestAnimationFrame(() => session._htmlTerm?.focus());
    } else if (session.term && !session._isBrowser) {
      const ta = session.viewport?.querySelector('.xterm-helper-textarea');
      if (document.activeElement !== ta) {
        requestAnimationFrame(() => session.term.focus());
      }
    }
    return;
  }
  _floatZCounter++;
  tabState.el.style.zIndex = _floatZCounter;
  // Focus the terminal for immediate keyboard input — skip if already focused (preserves selection)
  if (session?._isHtmlTerm) {
    requestAnimationFrame(() => session._htmlTerm?.focus());
  } else if (session?.term && !session._isBrowser) {
    const ta = session.viewport?.querySelector('.xterm-helper-textarea');
    if (document.activeElement !== ta) {
      requestAnimationFrame(() => session.term.focus());
    }
  }
}

function _applyFloatColor(win, colorId) {
  const c = FLOAT_COLORS.find(f => f.id === colorId) || FLOAT_COLORS[0];
  if (c.s === 0) {
    win.style.setProperty('--fh', '0');
    win.style.setProperty('--fs', '0%');
  } else {
    win.style.setProperty('--fh', String(c.h));
    win.style.setProperty('--fs', c.s + '%');
  }
  // Update color strip
  const strip = win.querySelector('.term-float-color-strip');
  if (strip) {
    strip.style.background = c.s === 0 ? 'rgba(255,255,255,0.15)' : `hsl(${c.h}, ${Math.round(c.s * 0.5)}%, 30%)`;
  }
}

/** Update snapped-edge classes on all floating tabs based on adjacency */
function _updateSnappedEdges() {
  const TOLERANCE = 2;
  const rects = new Map();
  for (const [sid, dt] of _detachedTabs) {
    if (!dt.el || dt.minimized) continue;
    rects.set(sid, dt.el.getBoundingClientRect());
  }

  // Compute viewport / panel boundaries
  const cs = getComputedStyle(document.documentElement);
  const explorerW = parseFloat(cs.getPropertyValue('--explorer-width')) || 0;
  const fileExplorerW = parseFloat(cs.getPropertyValue('--file-explorer-width')) || 0;
  const leftPanelEdge = explorerW + fileExplorerW;
  const claudeW = parseFloat(cs.getPropertyValue('--claude-panel-width')) || 0;
  const rightPanelEdge = window.innerWidth - claudeW;
  const topEdge = 48; // navbar height
  const bottomEdge = window.innerHeight;

  for (const [sid, dt] of _detachedTabs) {
    if (!dt.el || dt.minimized) continue;
    const me = rects.get(sid);
    let edges = { left: false, right: false, top: false, bottom: false };

    // Check adjacency to other floating tabs
    for (const [oid, oRect] of rects) {
      if (oid === sid) continue;
      const vOverlap = me.top < oRect.bottom - TOLERANCE && me.bottom > oRect.top + TOLERANCE;
      const hOverlap = me.left < oRect.right - TOLERANCE && me.right > oRect.left + TOLERANCE;
      if (vOverlap && Math.abs(me.right - oRect.left) < TOLERANCE) edges.right = true;
      if (vOverlap && Math.abs(me.left - oRect.right) < TOLERANCE) edges.left = true;
      if (hOverlap && Math.abs(me.bottom - oRect.top) < TOLERANCE) edges.bottom = true;
      if (hOverlap && Math.abs(me.top - oRect.bottom) < TOLERANCE) edges.top = true;
    }

    // Check adjacency to viewport / panel edges
    if (Math.abs(me.left - leftPanelEdge) < TOLERANCE || Math.abs(me.left) < TOLERANCE) edges.left = true;
    if (Math.abs(me.right - rightPanelEdge) < TOLERANCE || Math.abs(me.right - window.innerWidth) < TOLERANCE) edges.right = true;
    if (Math.abs(me.top - topEdge) < TOLERANCE) edges.top = true;
    if (Math.abs(me.bottom - bottomEdge) < TOLERANCE) edges.bottom = true;

    dt.el.classList.toggle('snapped-r', edges.right);
    dt.el.classList.toggle('snapped-l', edges.left);
    dt.el.classList.toggle('snapped-t', edges.top);
    dt.el.classList.toggle('snapped-b', edges.bottom);
  }
}

/** Tile all floating (non-minimized) terminals across the viewport */
export function tileFloatingTerminals() {
  const entries = [];
  for (const [sid, dt] of _detachedTabs) {
    if (!dt.el || dt.minimized) continue;
    entries.push({ sid, dt });
  }
  // Also detach all docked sessions so everything tiles
  const dockedSessions = _sessions.filter(s => !_detachedTabs.has(s.id) && !s._gitOutput);
  for (const s of dockedSessions) {
    const idx = _sessions.indexOf(s);
    if (idx >= 0) detachTab(idx);
  }
  // Re-collect after detaching
  entries.length = 0;
  for (const [sid, dt] of _detachedTabs) {
    if (!dt.el || dt.minimized) continue;
    entries.push({ sid, dt });
  }
  if (entries.length === 0) return;

  // Compute available whiteboard area (respect open panels)
  const cs = getComputedStyle(document.documentElement);
  const explorerW = parseFloat(cs.getPropertyValue('--explorer-width')) || 0;
  const fileExplorerW = parseFloat(cs.getPropertyValue('--file-explorer-width')) || 0;
  const sidebarW = explorerW + fileExplorerW;
  const claudeW = parseFloat(cs.getPropertyValue('--claude-panel-width')) || 0;
  const termPanel = document.getElementById('terminal-panel');
  const termH = (termPanel && !termPanel.classList.contains('hidden') && !termPanel.classList.contains('detached'))
    ? termPanel.getBoundingClientRect().height : 0;
  const TOP_PAD = 48; // navbar height
  const areaL = sidebarW;
  const areaT = TOP_PAD;
  const areaW = window.innerWidth - sidebarW - claudeW;
  const areaH = window.innerHeight - TOP_PAD - termH;

  // Calculate grid: find best cols/rows to fill the space
  const n = entries.length;
  let bestCols = 1, bestRows = n;
  let bestRatio = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = areaW / cols;
    const cellH = areaH / rows;
    const ratio = Math.abs((cellW / cellH) - 16 / 9);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestCols = cols;
      bestRows = rows;
    }
  }

  const cellW = areaW / bestCols;
  const cellH = areaH / bestRows;

  entries.forEach(({ dt }, i) => {
    const col = i % bestCols;
    const row = Math.floor(i / bestCols);
    dt.el.style.left = (areaL + col * cellW) + 'px';
    dt.el.style.top = (areaT + row * cellH) + 'px';
    dt.el.style.width = cellW + 'px';
    dt.el.style.height = cellH + 'px';
  });

  // Refit all terminals after layout
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const { sid } of entries) {
        const session = _sessions.find(s => s.id === sid);
        if (!session) continue;
        if (session._isHtmlTerm) session._htmlTerm?.fit();
        else _scheduleFit(session);
      }
      _updateSnappedEdges();
      saveTerminalLayout();
    });
  });
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
      <button class="term-float-color-strip" data-tooltip="Change color"></button>
      <span class="term-float-tab-title">${session.label}</span>${_cliBadgeHtml(session.id)}
      <div class="term-float-tab-actions">
        <button class="term-float-tab-btn files-btn" data-tooltip="Toggle file tree">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="term-float-tab-btn rename-btn" data-tooltip="Rename">
          <svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
        </button>
        ${CLI_PROFILES.has(session.profile) ? `<button class="term-float-tab-btn changelog-btn" data-tooltip="Generate changelog">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
        </button>` : ''}
        <button class="term-float-tab-btn pin-btn" data-tooltip="Pin on top">
          <svg viewBox="0 0 24 24"><path d="M9 4v6l-2 4h5v6" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 14h5l-2-4V4" stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="7" y1="14" x2="17" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="9" y1="4" x2="15" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
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
    <div class="term-float-tab-body">
      <div class="term-file-sidebar"></div>
    </div>
    <div class="float-resize float-resize-r"  data-resize="e"></div>
    <div class="float-resize float-resize-l"  data-resize="w"></div>
    <div class="float-resize float-resize-b"  data-resize="s"></div>
    <div class="float-resize float-resize-t"  data-resize="n"></div>
    <div class="float-resize float-resize-br" data-resize="se"></div>
    <div class="float-resize float-resize-bl" data-resize="sw"></div>
    <div class="float-resize float-resize-tr" data-resize="ne"></div>
    <div class="float-resize float-resize-tl" data-resize="nw"></div>
  `;

  // Default position: offset from center based on how many are already detached
  const offset = _detachedTabs.size * 30;
  const w = Math.min(700, window.innerWidth * 0.5);
  const h = Math.min(420, window.innerHeight * 0.5);
  win.style.left = ((window.innerWidth - w) / 2 + offset) + 'px';
  win.style.top = Math.max(48, (window.innerHeight - h) / 2 + offset) + 'px';
  win.style.width = w + 'px';
  win.style.height = h + 'px';

  document.body.appendChild(win);

  // Move viewport into a wrapper div that provides position:relative context.
  // This lets .term-viewport use position:absolute;inset:0 for deterministic sizing,
  // matching the docked panel's layout and giving FitAddon stable measurements.
  const body = win.querySelector('.term-float-tab-body');
  const wrap = document.createElement('div');
  wrap.className = 'term-float-viewport-wrap';
  body.appendChild(wrap);
  wrap.appendChild(session.viewport);
  session.viewport.style.display = '';

  // Apply saved color or assign random
  if (!session._floatColor) {
    session._floatColor = FLOAT_COLORS[Math.floor(Math.random() * FLOAT_COLORS.length)].id;
  }
  _applyFloatColor(win, session._floatColor);

  // Wire color picker popup
  const colorBtn = win.querySelector('.term-float-color-strip');
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any existing picker
    const existing = document.querySelector('.float-color-picker');
    if (existing) { existing.remove(); return; }
    const picker = document.createElement('div');
    picker.className = 'float-color-picker';
    // Position above the color strip button
    const btnRect = colorBtn.getBoundingClientRect();
    picker.style.left = btnRect.left + 'px';
    picker.style.bottom = (window.innerHeight - btnRect.top + 6) + 'px';
    picker.style.top = 'auto';
    FLOAT_COLORS.forEach(c => {
      const swatch = document.createElement('button');
      swatch.className = 'float-color-swatch';
      if (c.id === (session._floatColor || 'blue')) swatch.classList.add('active');
      swatch.style.background = c.s === 0 ? 'rgba(255,255,255,0.15)' : `hsl(${c.h}, ${Math.round(c.s * 0.5)}%, 25%)`;
      swatch.addEventListener('click', (ev) => {
        ev.stopPropagation();
        session._floatColor = c.id;
        _applyFloatColor(win, c.id);
        saveSessionRegistry();
        saveTerminalLayout();
        picker.remove();
      });
      picker.appendChild(swatch);
    });
    document.body.appendChild(picker);
    // Close on outside click
    const close = (ev) => {
      if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('mousedown', close); }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  });

  // Wire file tree toggle
  win.querySelector('.files-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const sidebar = win.querySelector('.term-file-sidebar');
    toggleFileTree(sidebar, session);
  });

  // Wire dock-back button
  win.querySelector('.dock-btn').addEventListener('click', (e) => { e.stopPropagation(); attachTab(session.id); });

  // Wire minimize button
  win.querySelector('.minimize-btn').addEventListener('click', (e) => { e.stopPropagation(); minimizeTab(session.id); });

  // Wire close button — close directly without docking back (closeSession handles detached cleanup)
  win.querySelector('.close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = _sessions.indexOf(session);
    if (idx >= 0) closeSession(idx);
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
      if (val) {
        // Re-find session from _sessions to avoid stale closure after reconnection
        const live = _sessions.find(s => s.id === session.id) || session;
        live.label = val; live._userRenamed = true;
        if (live !== session) { session.label = val; session._userRenamed = true; }
        renderTabBar(); saveSessionRegistry(); saveTerminalLayout(); syncResumeLabel(live);
        // Retry detection if Claude session ID not yet known
        if (!live._claudeSessionId && CLI_PROFILES.has(live.profile)) {
          detectClaudeSession(live.id).then(r => {
            if (r?.claudeSessionId && !live._claudeSessionId) {
              live._claudeSessionId = r.claudeSessionId;
              saveSessionRegistry();
              syncResumeLabel(live);
            }
          }).catch(() => {});
        }
      }
      else { titleEl.textContent = session.label; }
    };
    titleEl.addEventListener('blur', commit, { once: true });
    titleEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); titleEl.blur(); }
      if (ev.key === 'Escape') { titleEl.textContent = session.label; titleEl.blur(); }
    });
  });

  // Wire changelog button (CLI profiles only)
  const changelogBtn = win.querySelector('.changelog-btn');
  if (changelogBtn) {
    changelogBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (session.ws?.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'input', data: '/synabun changelog\r' }));
      }
    });
  }

  // Store in map
  const tabState = { el: win, cleanup: null };
  _detachedTabs.set(session.id, tabState);

  // Ctrl+C fallback for floating window — covers cases where xterm textarea loses focus
  win.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      const sel = session._isHtmlTerm
        ? session._htmlTerm?.getSelection()
        : session.term?.getSelection();
      if (sel) {
        _clipCopy(sel);
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  // Click anywhere on floating window → bring to front + focus terminal
  win.addEventListener('mousedown', (e) => {
    bringTabToFront(session.id);
    // Re-focus terminal unless user clicked a button/input
    if (!e.target.closest('button, input, [contenteditable]')) {
      if (session._isHtmlTerm) session._htmlTerm?.focus();
      else if (session.term) session.term?.focus();
    }
  });

  // Header drag + edge resize — store cleanup to remove document listeners on close/dock
  const dragCleanup = initTabFloatDrag(win, session.id);
  const resizeCleanup = initTabFloatResize(win, session.id);
  tabState.cleanup = () => { dragCleanup(); resizeCleanup(); };

  // If this was the active tab in main panel, switch to another docked tab
  if (idx === _activeIdx) {
    const nextDocked = _sessions.findIndex((s, i) => i !== idx && !_detachedTabs.has(s.id));
    if (nextDocked >= 0) {
      switchToSession(nextDocked);
    } else {
      // No docked sessions remain — clear container and hide main panel
      _activeIdx = -1;
      const container = document.getElementById('term-container');
      if (container) container.innerHTML = '';
      if (_panel && !_panel.classList.contains('hidden')) hidePanel();
    }
  }

  renderTabBar();
  saveTerminalLayout();

  // Refit terminal in new container — double-rAF so browser completes layout
  // of the newly-appended floating window before measuring dimensions
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (session._isHtmlTerm) session._htmlTerm?.fit();
    else _scheduleFit(session);
  }));
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
  if (!session) { if (tabState.cleanup) tabState.cleanup(); tabState.el.remove(); _detachedTabs.delete(sessionId); return; }

  // Move viewport back to main panel container
  const container = $('term-container');
  if (container) container.appendChild(session.viewport);

  // Remove floating window — clean up document event listeners first
  if (tabState.cleanup) { tabState.cleanup(); tabState.cleanup = null; }
  tabState.el.remove();
  _detachedTabs.delete(sessionId);

  // Show panel if hidden
  if (_panel?.classList.contains('hidden')) showPanel();

  // Switch to this tab
  const idx = _sessions.indexOf(session);
  if (idx >= 0) switchToSession(idx);

  renderTabBar();
  saveTerminalLayout();
  _updateSnappedEdges(); // neighbors may no longer be snapped
  requestAnimationFrame(() => {
    if (session._isHtmlTerm) session._htmlTerm?.fit();
    else _scheduleFit(session);
  });
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
    const idx = _sessions.indexOf(session);
    if (idx >= 0) closeSession(idx);
  });
  pill.addEventListener('click', () => restoreTab(sessionId));
  pill.style.opacity = '0';
  tray.appendChild(pill);
  tabState.pill = pill;

  // Set initial CLI status badge on pill
  const tracked = _cliSessionStatus.get(sessionId);
  if (tracked) {
    const badge = _ensureBadge(pill);
    badge.dataset.status = tracked.status;
    const lbl = badge.querySelector('.cli-status-label');
    if (lbl) lbl.textContent = _CLI_LABELS[tracked.status] || '';
  }

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

  // Bring restored window above all other floating terminals
  bringTabToFront(sessionId);

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
    if (session) requestAnimationFrame(() => {
      if (session._isHtmlTerm) session._htmlTerm?.fit();
      else _scheduleFit(session);
    });
  };
  el.addEventListener('transitionend', onEnd, { once: true });
  setTimeout(() => {
    if (el.style.transform) onEnd();
  }, 450);

  saveTerminalLayout();
}

const DRAG_CURSOR_ACTIVE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 22 22'%3E%3Cpath d='M11 2l3 3.5h-2v4.5h4.5V8L20 11l-3.5 3v-2H12v4.5h2L11 20l-3-3.5h2v-4.5H5.5V14L2 11l3.5-3v2H10V5.5H8z' fill='%234FC3F7' stroke='rgba(0,0,0,0.35)' stroke-width='0.6'/%3E%3C/svg%3E") 11 11, move`;

function initTabFloatDrag(win, sessionId) {
  const ac = new AbortController();
  const { signal } = ac;
  let drag = null;

  function _checkHeader(target) {
    const header = target.closest('.term-float-tab-header');
    if (!header || target.closest('button')) return false;
    const session = _sessions.find(s => s.id === sessionId);
    return !session?.pinned;
  }
  function _startDrag(x, y) {
    const r = win.getBoundingClientRect();
    drag = { startX: x, startY: y, startL: r.left, startT: r.top, startW: r.width };
    win.classList.add('float-dragging');
    document.body.style.cursor = DRAG_CURSOR_ACTIVE;
    document.body.style.userSelect = 'none';
  }
  function _moveDrag(x, y) {
    if (!drag) return;
    let finalL = drag.startL + x - drag.startX;
    let finalT = drag.startT + y - drag.startY;
    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      finalL = Math.round(finalL / gs) * gs;
      finalT = Math.round(finalT / gs) * gs;
    }
    const KEEP = 80;
    const w = drag.startW || parseFloat(win.style.width) || 700;
    const h = parseFloat(win.style.height) || 420;
    finalL = Math.max(KEEP - w, Math.min(finalL, window.innerWidth - KEEP));
    finalT = Math.max(48, Math.min(finalT, window.innerHeight - KEEP));

    // Snap to other floating windows
    const SNAP_DIST = 12;
    let snapped = false;
    const myR = finalL + w, myB = finalT + h;
    for (const [sid, dt] of _detachedTabs) {
      if (sid === sessionId || !dt.el) continue;
      const or = dt.el.getBoundingClientRect();
      // Only snap if vertically or horizontally overlapping (close enough to be neighbors)
      const vOverlap = finalT < or.bottom + SNAP_DIST && myB > or.top - SNAP_DIST;
      const hOverlap = finalL < or.right + SNAP_DIST && myR > or.left - SNAP_DIST;
      if (vOverlap) {
        // Snap my right edge to their left edge
        if (Math.abs(myR - or.left) < SNAP_DIST) { finalL = or.left - w; snapped = true; }
        // Snap my left edge to their right edge
        else if (Math.abs(finalL - or.right) < SNAP_DIST) { finalL = or.right; snapped = true; }
        // Align left edges
        if (Math.abs(finalL - or.left) < SNAP_DIST) { finalL = or.left; snapped = true; }
        // Align right edges
        else if (Math.abs(myR - or.right) < SNAP_DIST) { finalL = or.right - w; snapped = true; }
      }
      if (hOverlap) {
        // Snap my bottom to their top
        if (Math.abs(myB - or.top) < SNAP_DIST) { finalT = or.top - h; snapped = true; }
        // Snap my top to their bottom
        else if (Math.abs(finalT - or.bottom) < SNAP_DIST) { finalT = or.bottom; snapped = true; }
        // Align top edges
        if (Math.abs(finalT - or.top) < SNAP_DIST) { finalT = or.top; snapped = true; }
        // Align bottom edges
        else if (Math.abs(myB - or.bottom) < SNAP_DIST) { finalT = or.bottom - h; snapped = true; }
      }
    }
    // Also snap to viewport edges
    if (Math.abs(finalL) < SNAP_DIST) { finalL = 0; snapped = true; }
    if (Math.abs(finalT - 48) < SNAP_DIST) { finalT = 48; snapped = true; }
    if (Math.abs(myR - window.innerWidth) < SNAP_DIST) { finalL = window.innerWidth - w; snapped = true; }
    if (Math.abs(myB - window.innerHeight) < SNAP_DIST) { finalT = window.innerHeight - h; snapped = true; }

    win.classList.toggle('float-snapping', snapped);
    win.style.left = finalL + 'px';
    win.style.top = finalT + 'px';
    _updateSnappedEdges();
  }
  function _endDrag() {
    if (!drag) return;
    drag = null;
    win.classList.remove('float-dragging');
    win.classList.remove('float-snapping');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    _updateSnappedEdges();
  }

  // Mouse
  win.addEventListener('mousedown', (e) => {
    if (!_checkHeader(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    _startDrag(e.clientX, e.clientY);
  }, { signal });
  document.addEventListener('mousemove', (e) => _moveDrag(e.clientX, e.clientY), { signal });
  document.addEventListener('mouseup', _endDrag, { signal });

  // Touch
  win.addEventListener('touchstart', (e) => {
    const pt = _touchXY(e);
    if (!pt || !_checkHeader(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    _startDrag(pt.clientX, pt.clientY);
  }, { signal, passive: false });
  document.addEventListener('touchmove', (e) => {
    const pt = _touchXY(e);
    if (!pt || !drag) return;
    e.preventDefault();
    _moveDrag(pt.clientX, pt.clientY);
  }, { signal, passive: false });
  document.addEventListener('touchend', _endDrag, { signal });
  document.addEventListener('touchcancel', _endDrag, { signal });

  return () => ac.abort();
}

function initTabFloatResize(win, sessionId) {
  const ac = new AbortController();
  const { signal } = ac;
  let resizing = null;

  const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
    nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize' };

  const MIN_W = 280, MIN_H = 160;

  function _startResize(handle, x, y) {
    const session = _sessions.find(s => s.id === sessionId);
    if (session?.pinned) return false;
    const dir = handle.dataset.resize;
    const r = win.getBoundingClientRect();
    resizing = { dir, startX: x, startY: y, l: r.left, t: r.top, w: r.width, h: r.height };
    _draggingResize = true;
    document.body.style.cursor = CURSORS[dir];
    document.body.style.userSelect = 'none';
    return true;
  }
  function _moveResize(x, y) {
    if (!resizing) return;
    const { dir, startX, startY, l, t, w, h } = resizing;
    const dx = x - startX, dy = y - startY;
    let nw = w, nh = h, nl = l, nt = t;
    if (dir.includes('e')) nw = Math.max(MIN_W, w + dx);
    if (dir.includes('w')) { nw = Math.max(MIN_W, w - dx); nl = l + w - nw; }
    if (dir.includes('s')) nh = Math.max(MIN_H, h + dy);
    if (dir.includes('n')) { nh = Math.max(MIN_H, h - dy); nt = t + h - nh; }
    if (state.gridSnap) {
      const gs = state.gridSize || 20;
      nl = Math.round(nl / gs) * gs; nt = Math.round(nt / gs) * gs;
      nw = Math.round(nw / gs) * gs; nh = Math.round(nh / gs) * gs;
    }
    nt = Math.max(48, nt);
    win.style.left = nl + 'px';
    win.style.top = nt + 'px';
    win.style.width = nw + 'px';
    win.style.height = nh + 'px';
    const session = _sessions.find(s => s.id === sessionId);
    if (session) _scheduleFit(session);
  }
  function _endResize() {
    if (!resizing) return;
    resizing = null;
    _draggingResize = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const session = _sessions.find(s => s.id === sessionId);
    if (session) _sendResize(session);
    _updateSnappedEdges();
  }

  // Mouse
  win.querySelectorAll('.float-resize').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      _startResize(handle, e.clientX, e.clientY);
    }, { signal });
    // Touch
    handle.addEventListener('touchstart', (e) => {
      const pt = _touchXY(e);
      if (!pt) return;
      e.preventDefault();
      e.stopPropagation();
      _startResize(handle, pt.clientX, pt.clientY);
    }, { signal, passive: false });
  });

  document.addEventListener('mousemove', (e) => _moveResize(e.clientX, e.clientY), { signal });
  document.addEventListener('mouseup', _endResize, { signal });

  document.addEventListener('touchmove', (e) => {
    const pt = _touchXY(e);
    if (!pt || !resizing) return;
    e.preventDefault();
    _moveResize(pt.clientX, pt.clientY);
  }, { signal, passive: false });
  document.addEventListener('touchend', _endResize, { signal });
  document.addEventListener('touchcancel', _endResize, { signal });

  return () => ac.abort();
}

// ── Peek dock (bottom indicator when panel hidden) ──

function ensurePeekDock() {
  if (_peekDock) return;
  const dock = document.createElement('div');
  dock.id = 'term-peek-dock';
  dock.innerHTML = `
    <span class="peek-pull"><svg viewBox="0 0 16 16" fill="none"><path d="M3 5l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
    <div class="peek-tabs"></div>
    <span class="peek-count"></span>
  `;
  dock.addEventListener('click', async () => {
    if (_sessions.length > 0) {
      showPanel();
    } else {
      await openSession('shell');
      showPanel();
    }
  });
  document.body.appendChild(dock);
  _peekDock = dock;
}

function renderPeekDock() {
  if (!_peekDock) return;
  const tabs = _peekDock.querySelector('.peek-tabs');
  const count = _peekDock.querySelector('.peek-count');

  tabs.innerHTML = _sessions.map((s, i) => {
    if (_detachedTabs.has(s.id)) return ''; // detached tabs are in floating windows
    const prof = PROFILES.find(p => p.id === s.profile);
    const active = i === _activeIdx;
    return `<span class="peek-tab${active ? ' active' : ''}">
      <span class="peek-tab-icon">${prof?.svg || SVG_SHELL}</span>
      <span class="peek-tab-label">${s.label}</span>
    </span>`;
  }).join('');

  const dockedCount = _sessions.filter(s => !_detachedTabs.has(s.id)).length;
  count.textContent = dockedCount > 0 ? `${dockedCount} session${dockedCount > 1 ? 's' : ''}` : '';
}

function showPeekDock() {
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

  if (_splitMode) {
    bar.innerHTML = '';
    renderSplitTabBars();
    return;
  }

  bar.innerHTML = _sessions.map((s, i) => {
    if (_detachedTabs.has(s.id)) return ''; // detached tabs live in their floating windows
    const prof = PROFILES.find(p => p.id === s.profile);
    const active = i === _activeIdx;
    const dead = s.dead;
    const isLinked = state.linkedSessionIds.has(s.id);
    return `<button class="term-tab${active ? ' active' : ''}${dead ? ' dead' : ''}" data-idx="${i}" data-profile="${s.profile}" data-session-id="${s.id}">
      <span class="term-tab-icon">${s._gitOutput ? SVG_GIT : (prof?.svg || SVG_SHELL)}</span>
      <span class="term-tab-label">${s.label}${dead ? ' (exited)' : ''}</span>${_cliBadgeHtml(s.id)}
      ${isLinked ? '<span class="term-tab-link-badge" title="Linked"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>' : ''}
      ${!dead && !s._gitOutput ? `<span class="term-tab-detach" data-idx="${i}" data-tooltip="Detach tab"><svg viewBox="0 0 24 24"><path d="M15 3h6v6"/><path d="M21 3l-7 7"/><rect x="3" y="11" width="10" height="10" rx="1"/></svg></span>` : ''}
      <span class="term-tab-close" data-idx="${i}">&times;</span>
    </button>`;
  }).join('');

  // Sync minimized pill labels with current session labels
  for (const [sessionId, tabState] of _detachedTabs) {
    if (tabState.minimized && tabState.pill) {
      const session = _sessions.find(s => s.id === sessionId);
      if (session) {
        const pillLabel = tabState.pill.querySelector('.term-minimized-pill-label');
        if (pillLabel && pillLabel.textContent !== session.label) pillLabel.textContent = session.label;
      }
    }
  }

  // Keep peek dock in sync if it's showing
  if (_peekDock?.classList.contains('visible')) renderPeekDock();
}

// ── Resume last session prompt ──

async function checkResumePrompt() {
  // Don't show if there's already a resume overlay
  if (document.querySelector('.resume-prompt-overlay')) {
    console.log('[resume] Overlay already exists, skipping');
    return;
  }
  console.log('[resume] Checking for last session... (sessions:', _sessions.length, 'dead:', _sessions.filter(s => s.dead).length, ')');
  try {
    const lastSession = await fetchLastSession();
    console.log('[resume] fetchLastSession result:', lastSession);
    if (lastSession?.sessions?.length > 0) {
      console.log('[resume] Showing resume prompt with', lastSession.sessions.length, 'sessions');
      showResumePrompt(lastSession);
    } else {
      console.log('[resume] No sessions to resume');
    }
  } catch (err) {
    console.warn('[resume] Failed to check last session:', err);
  }
}

function showResumePrompt(data) {
  const count = data.sessions.length;
  const ago = _relativeTime(data.timestamp);

  // Build session list items
  const items = data.sessions.map(s => {
    const name = s.label || s.cwd.split(/[\\/]/).filter(Boolean).pop() || 'unknown';
    return `<div class="resume-prompt-item">${_escHtml(name)}</div>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'resume-prompt-overlay';
  overlay.innerHTML = `
    <div class="resume-prompt-card glass">
      <div class="resume-prompt-title">Resume last session?</div>
      <div class="resume-prompt-count">${count} Claude Code session${count > 1 ? 's' : ''}</div>
      <div class="resume-prompt-list">${items}</div>
      <div class="resume-prompt-actions">
        <button class="resume-prompt-yes">Resume All</button>
        <button class="resume-prompt-no">Dismiss</button>
      </div>
      <div class="resume-prompt-time">Server closed ${ago}</div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Animate in
  requestAnimationFrame(() => overlay.classList.add('visible'));

  const cleanup = () => {
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 200);
  };

  overlay.querySelector('.resume-prompt-yes').addEventListener('click', async () => {
    cleanup();
    for (const s of data.sessions) {
      emit('terminal:open-resume', {
        profile: 'claude-code',
        cwd: s.cwd,
        resume: s.claudeSessionId,
        label: s.label || '',
      });
      // Stagger launches to avoid PTY overload
      await new Promise(r => setTimeout(r, 300));
    }
    try { await dismissLastSession(); } catch {}
  });

  overlay.querySelector('.resume-prompt-no').addEventListener('click', async () => {
    cleanup();
    try { await dismissLastSession(); } catch {}
  });

  // Auto-dismiss after 60s
  setTimeout(() => {
    if (overlay.parentNode) {
      cleanup();
      dismissLastSession().catch(() => {});
    }
  }, 60000);
}

function _relativeTime(ts) {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function _escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Public API ──

export async function initTerminal() {
  // ── Global ESC handler (window capture phase) ──
  // xterm.js captures all key events on its internal textarea and calls
  // stopImmediatePropagation, preventing element-level listeners from firing.
  // A window-level capture listener fires BEFORE any element-level handler.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Only act when a terminal textarea has focus
    const ta = document.activeElement;
    const isXterm = ta?.classList.contains('xterm-helper-textarea');
    const isHtmlTerm = ta?.classList.contains('html-term-input');
    if (!isXterm && !isHtmlTerm) return;
    const vp = ta.closest('.term-viewport') || ta.closest('.html-term')?.closest('.term-viewport');
    if (!vp) return;
    const sid = vp.dataset.sessionId;
    const session = _sessions.find(s => s.id === sid);
    if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) return;

    session.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
    if (session._isHtmlTerm) session._htmlTerm?.blur();
    else session.term?.blur();
    ta.blur();
  }, true); // capture phase — fires before xterm's handlers

  // ── Click-outside-terminal blurs all terminals ──
  // When user clicks anywhere that isn't inside a terminal viewport or float,
  // blur the active xterm so keyboard focus returns to the page.
  document.addEventListener('mousedown', (e) => {
    const inTerminal = e.target.closest('.term-viewport') ||
                       e.target.closest('.term-float-tab') ||
                       e.target.closest('#terminal-panel') ||
                       e.target.closest('.term-tab-bar');
    if (inTerminal) return;
    // Blur any focused element inside a terminal panel or floating tab
    const active = document.activeElement;
    if (active && active !== document.body &&
        (active.closest('#terminal-panel') || active.closest('.term-float-tab'))) {
      active.blur();
    }
  });

  // ── Window resize — clamp floating tabs on screen, refit all terminals ──
  window.addEventListener('resize', () => {
    if (_windowResizeTimer) clearTimeout(_windowResizeTimer);
    _windowResizeTimer = setTimeout(() => {
      _windowResizeTimer = null;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const KEEP = 80; // min px of tab that must remain visible

      for (const [, tabState] of _detachedTabs) {
        if (tabState.minimized) continue;
        const el = tabState.el;
        let l = parseFloat(el.style.left) || 0;
        let t = parseFloat(el.style.top) || 0;
        let w = parseFloat(el.style.width) || 700;
        let h = parseFloat(el.style.height) || 420;

        // Clamp dimensions to viewport
        w = Math.min(w, vw);
        h = Math.min(h, vh);

        // Clamp position so header stays reachable and below title bar
        l = Math.max(KEEP - w, Math.min(l, vw - KEEP));
        t = Math.max(48, Math.min(t, vh - KEEP));

        el.style.left = l + 'px';
        el.style.top = t + 'px';
        el.style.width = w + 'px';
        el.style.height = h + 'px';
      }

      // Refit all terminals to new dimensions
      _sessions.forEach(s => _scheduleFit(s));
    }, 150);
  });

  // ── Visibility change — reconnect WSes + re-focus after screen sleep/wake ──
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Reconnect any dropped terminal WebSockets (PTYs survive 30min on server)
    for (const s of _sessions) {
      if (s.dead || s._isBrowser) continue;
      if (!s.ws || s.ws.readyState !== WebSocket.OPEN) {
        _reconnectTerminalWs(s);
      }
    }
    // Re-focus active terminal after screen wake
    const session = _sessions[_activeIdx];
    if (session && !session.dead) {
      requestAnimationFrame(() => {
        if (session._isBrowser) {
          session._browserCanvas?.focus();
        } else if (session._isHtmlTerm) {
          session._htmlTerm?.focus();
        } else if (session.term) {
          session.term.focus();
        }
      });
    }
    // Also re-focus any floating windows
    for (const [id] of _detachedTabs) {
      const s = _sessions.find(s => s.id === id);
      if (!s || s.dead) continue;
      if (s._isHtmlTerm) s._htmlTerm?.focus();
      else if (s.term) s.term.focus();
    }
  });

  on('terminal:open', (data) => {
    const profile = data?.profile || 'shell';
    openSessionWithPicker(profile);
  });

  on('terminal:open-resume', async (data) => {
    const { profile, cwd, resume, label } = data || {};
    if (!profile || !resume) return;
    if (isGuest() && !hasPermission('terminal')) return;
    try {
      const { sessionId } = await createTerminalSession(profile, 120, 30, cwd, { resume });
      await openHtmlTermSession(profile, cwd, sessionId, {
        label: label || '',
        claudeSessionId: resume,
      });
    } catch (err) {
      console.error('[resume] Failed to launch resume session:', err);
    }
  });

  on('terminal:toggle', () => togglePanel());

  on('terminal:close', () => hidePanel());

  on('terminal:launch-floating', (data) => {
    const profile = data?.profile || 'shell';
    launchDetached(profile, data?.initialMessage, data?.autoSubmit);
  });

  // Attach to a pre-created terminal session (e.g. from /api/loop/launch)
  on('terminal:attach-floating', (data) => {
    if (!data?.terminalSessionId) return;
    attachDetached(data.terminalSessionId, data.profile || 'claude-code', data.initialMessage, data.autoSubmit)
      .catch(err => console.error('[SynaBun] terminal:attach-floating error:', err));
  });

  on('terminal:run-command', (data) => {
    if (!data?.command) return;
    runCommandInNewTab(data).catch(err => console.error('[SynaBun] terminal:run-command error:', err));
  });

  on('browser:open', (data) => openBrowserSession(data?.url, data?.fresh, undefined, data?.force));

  // Reconnect to existing browser session (e.g. detached from Claude panel embed)
  on('browser:reconnect', async (data) => {
    if (!data?.sessionId) return;
    if (_sessions.find(s => s.id === data.sessionId)) return;
    await reconnectBrowserSession(data.sessionId, { url: data.url || '', title: data.title || '' }, null);
  });

  // Register CLI launch keybind actions (open as detached floating tab)
  registerAction('launch-claude', () => launchDetached('claude-code'));
  registerAction('launch-codex',  () => launchDetached('codex'));
  registerAction('launch-gemini', () => launchDetached('gemini'));
  registerAction('launch-browser', () => openBrowserSession());
  registerAction('launch-youtube', () => openBrowserSession('https://www.youtube.com'));

  // ── Guest permission visual feedback ──
  function updateTermPermVisual() {
    const btn = $('term-new-btn');
    if (!btn) return;
    const blocked = isGuest() && !hasPermission('terminal');
    btn.style.opacity = blocked ? '0.35' : '';
    btn.style.pointerEvents = blocked ? 'none' : '';
    btn.title = blocked ? 'Terminal access disabled by host' : '';
  }
  on('session:info', updateTermPermVisual);
  on('permissions:changed', updateTermPermVisual);

  // ── Terminal session sync from other clients ──
  on('sync:terminal:created', async (msg) => {
    // Another client created a terminal session — reconnect to it.
    // Skip if this client is currently creating a session (_opening) or has it
    // pending (_pendingSessionIds) — the broadcast came from our own POST.
    if (_opening || _pendingSessionIds.has(msg.sessionId)) return;
    if (msg.sessionId && !_sessions.find(s => s.id === msg.sessionId)) {
      const p = msg.profile || 'shell';
      if (CLI_PROFILES.has(p)) {
        await reconnectHtmlTermSession(msg.sessionId, p);
      } else {
        await reconnectSession(msg.sessionId, p);
      }
    }
  });

  on('sync:terminal:deleted', (msg) => {
    // Another client deleted a terminal session — mark as dead before closing
    // to prevent closeSession from re-calling DELETE on the server
    const idx = _sessions.findIndex(s => s.id === msg.sessionId);
    if (idx >= 0) {
      _sessions[idx]._gitOutput = true; // trick: _gitOutput skips server DELETE
      closeSession(idx);
    }
  });

  // ── Browser session sync from server (MCP agent created/destroyed a session) ──
  on('sync:browser:created', async (msg) => {
    if (_opening) return;
    if (!msg.sessionId) return;
    if (_sessions.find(s => s.id === msg.sessionId)) return;
    if (document.querySelector(`.browser-viewport[data-session-id="${msg.sessionId}"]`)) return;
    // If Claude panel is open, let it handle the browser embed instead
    if (document.querySelector('.claude-panel.open')) return;
    await reconnectBrowserSession(msg.sessionId, { url: msg.url, title: '' }, null);
  });

  on('sync:browser:deleted', (msg) => {
    if (!msg.sessionId) return;
    const idx = _sessions.findIndex(s => s.id === msg.sessionId);
    if (idx >= 0) {
      _sessions[idx]._skipServerDelete = true;
      closeSession(idx);
    }
  });

  // ── Re-render tab bar when link state changes ──
  on('terminal:tabs-changed', () => renderTabBar());

  // ── Auto-reconnect to surviving sessions on page load ──
  const registry = loadSessionRegistry();
  if (registry.length > 0) {
    // Fetch live terminal sessions
    let liveSessions = [];
    try {
      const data = await fetchTerminalSessions();
      liveSessions = data.sessions || [];
    } catch {}
    const liveMap = new Map(liveSessions.map(s => [s.id, s]));

    // Fetch live browser sessions
    let liveBrowserSessions = [];
    try {
      const data = await fetchBrowserSessions();
      liveBrowserSessions = data.sessions || [];
    } catch {}
    const liveBrowserMap = new Map(liveBrowserSessions.map(s => [s.id, s]));

    const liveIds = new Set([...liveMap.keys(), ...liveBrowserMap.keys()]);

    // Reconnect to sessions that are still alive on server
    const toReconnect = registry.filter(r => liveIds.has(r.id));
    if (toReconnect.length > 0) {
      // Suppress layout saves during reconnect — reconnectBrowserSession auto-detaches
      // which would overwrite saved layout with default sizes
      _restoringLayout = true;
      for (const saved of toReconnect) {
        if (saved.profile === 'browser' && liveBrowserMap.has(saved.id)) {
          // Reconnect browser session — re-create client-side viewport
          await reconnectBrowserSession(saved.id, liveBrowserMap.get(saved.id), saved);
        } else if (CLI_PROFILES.has(saved.profile)) {
          const live = liveMap.get(saved.id);
          await reconnectHtmlTermSession(saved.id, saved.profile, {
            label: saved.label,
            pinned: saved.pinned,
            cwd: live?.cwd || null,
            userRenamed: saved.userRenamed,
            claudeSessionId: saved.claudeSessionId,
            floatColor: saved.floatColor,
          });
        } else {
          const live = liveMap.get(saved.id);
          await reconnectSession(saved.id, saved.profile, {
            label: saved.label,
            pinned: saved.pinned,
            cwd: live?.cwd || null,
            userRenamed: saved.userRenamed,
            claudeSessionId: saved.claudeSessionId,
            floatColor: saved.floatColor,
          });
        }
      }

      // Restore layout from last saved terminal layout
      try {
        const layoutJson = storage.getItem(KEYS.TERMINAL_SESSIONS + '-layout');
        if (layoutJson) {
          applyTerminalLayout(JSON.parse(layoutJson));
        }
      } catch {}
      _restoringLayout = false;

      // Unhide all viewports that were hidden during restore
      for (const s of _sessions) {
        if (s.viewport) s.viewport.style.display = '';
      }

      // Activate first docked session, or hide panel if all are floating
      const firstDocked = _sessions.findIndex(s => !_detachedTabs.has(s.id));
      if (firstDocked >= 0) switchToSession(firstDocked);
      else if (_panel && !_panel.classList.contains('hidden')) hidePanel();
    }

    // Clean up dead sessions from registry
    if (toReconnect.length !== registry.length) {
      saveSessionRegistry();
    }
  }

  // ── Resume prompt: offer to restore sessions from last server shutdown ──
  checkResumePrompt();

  // ── Re-check on sync reconnect (server restarted while page was open) ──
  on('session:info', () => {
    // session:info fires on every sync WS connect (including reconnects).
    // If all sessions are dead (server died and restarted), offer resume.
    const allDead = _sessions.length > 0 && _sessions.every(s => s.dead);
    const noSessions = _sessions.length === 0;
    if (allDead || noSessions) checkResumePrompt();
  });

  // Always show peek dock when panel is not open
  if (!_panel || _panel.classList.contains('hidden')) {
    showPeekDock();
  }

  // ── Whiteboard "Send to Terminal" — receive image via event bus ──
  on('wb:send-to-terminal', ({ dataUrl }) => {
    if (!dataUrl) return;
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return;
    // Find active session with open WS — try pane indices first, then fall back to any open session
    let session = null;
    const activeIdx = _activePaneIdx[0] >= 0 ? _activePaneIdx[0] : _activePaneIdx[1];
    if (activeIdx >= 0) session = _sessions[activeIdx];
    if (!session?.ws || session.ws.readyState !== WebSocket.OPEN) {
      // Fallback: find any session with an open WebSocket
      session = _sessions.find(s => s.ws && s.ws.readyState === WebSocket.OPEN) || null;
    }
    if (!session) {
      showTermToast('No active terminal session');
      return;
    }
    session.ws.send(JSON.stringify({ type: 'image_drop', data: match[2], mimeType: match[1] }));
    showTermToast('Image sent to terminal');
  });
}

export function openTerminalPanel(profile) {
  emit('terminal:open', { profile });
}

/** Open a CLI session and immediately detach it as a floating window */
async function launchDetached(profile, initialMessage, autoSubmit) {
  const cwd = await pickProject(profile);
  if (cwd === undefined) return; // cancelled
  await openSession(profile, cwd);
  // Detach the session we just created (it's always the last one)
  const idx = _sessions.length - 1;
  if (idx >= 0) detachTab(idx);

  // Send initial message once the CLI is ready
  if (initialMessage && idx >= 0) {
    _sendOnceReady(_sessions[idx], initialMessage, autoSubmit);
  }
}

/** Open a shell session and run a command (used by Command Runner panel).
 *  Spawns a new shell tab, optionally in a specific cwd, renames the tab,
 *  and sends the command once the shell prompt is detected. */
async function runCommandInNewTab({ command, cwd, label }) {
  if (!command) return;
  await openSession('shell', cwd || null);
  const idx = _sessions.length - 1;
  if (idx >= 0 && label) {
    _sessions[idx].label = label;
    renderTabBar();
  }
  if (idx >= 0) _sendOnceReady(_sessions[idx], command, false);
  showPanel();
}

/** Attach to a pre-created terminal session and detach as floating window */
async function attachDetached(terminalSessionId, profile, initialMessage, autoSubmit) {
  const p = profile || 'claude-code';
  // Guard against the sync:terminal:created handler creating a duplicate session
  // for the same ID while we're setting up our own connection.
  _pendingSessionIds.add(terminalSessionId);
  try {
    // CLI profiles (claude-code, codex, gemini) use the HTML term renderer,
    // not xterm.js. Route through reconnectHtmlTermSession to match the
    // renderer used by normal CLI opens and reconnects.
    if (CLI_PROFILES.has(p)) {
      await reconnectHtmlTermSession(terminalSessionId, p);
    } else {
      await openSession(p, null, terminalSessionId);
    }
    _pendingSessionIds.delete(terminalSessionId);
    const idx = _sessions.length - 1;
    if (idx >= 0) detachTab(idx);

    if (initialMessage && idx >= 0) {
      console.log('[SynaBun] attachDetached: calling _sendOnceReady, session.id =', _sessions[idx]?.id, ', hasWs =', !!_sessions[idx]?.ws);
      _sendOnceReady(_sessions[idx], initialMessage, !!autoSubmit);
    }
  } catch (err) {
    _pendingSessionIds.delete(terminalSessionId);
    console.error('[SynaBun] attachDetached failed:', err);
    showTermToast(`Failed to attach terminal: ${err.message || 'unknown error'}`);
  }
}

/** Send a message to a session once the WebSocket is ready and CLI has booted.
 *  Watches terminal output for the CLI's input prompt (e.g. Claude Code's ">" or ❯)
 *  instead of using a blind timeout — prevents input from being swallowed by the
 *  shell (cmd.exe) before the CLI is ready. Falls back to 15s timeout. */
function _sendOnceReady(session, message, autoSubmit) {
  if (!session?.ws) {
    console.warn('[SynaBun] _sendOnceReady: no session.ws — aborting');
    return;
  }

  console.log('[SynaBun] _sendOnceReady: starting, ws.readyState =', session.ws.readyState, ', msg length =', message?.length);

  // Strip ANSI escape sequences so color codes around prompts don't block matching.
  // ConPTY on Windows sends private-mode CSI like \x1b[?25h (show cursor) after prompts.
  // The [\x20-\x3f]* range covers ?, !, >, = (ECMA-48 parameter bytes) plus digits/semicolons.
  const ANSI_RE = /\x1b\[[\x20-\x3f]*[\x40-\x7e]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g;

  // Patterns that indicate a CLI is ready for input (matched against ANSI-stripped output)
  // Claude Code: ">" at start of line or "❯", Codex/Gemini: similar prompts
  const READY_PATTERNS = [
    /^>\s*$/m,        // Claude Code prompt: ">" on its own line
    /\n>\s*$/,        // ">" after newline at end of output
    />\s*$/,          // ">" at end of buffer (catch partial lines)
    /\u276F/,         // ❯ (some CLI prompts)
    /\$ $/,           // Shell prompt fallback
  ];
  const MAX_WAIT = 15000;
  let _outputBuf = '';
  let _sent = false;
  let _listener = null;
  let _fallbackTimer = null;

  function doSend() {
    if (_sent) return;
    _sent = true;
    // Clean up listener and timer
    if (_listener && session.ws) session.ws.removeEventListener('message', _listener);
    if (_fallbackTimer) clearTimeout(_fallbackTimer);
    console.log('[SynaBun] _sendOnceReady: doSend triggered, ws.readyState =', session.ws?.readyState);
    // Small delay after detecting ready — let the CLI fully settle
    setTimeout(() => {
      if (session.ws?.readyState !== WebSocket.OPEN) {
        console.warn('[SynaBun] _sendOnceReady: WS not OPEN at send time, readyState =', session.ws?.readyState);
        return;
      }
      // Chunk the input to avoid ConPTY input buffer overflow on Windows.
      // Writing 1000+ chars in a single pty.write() can silently drop data.
      const full = message + '\r';
      const CHUNK = 256;
      const DELAY = 30; // ms between chunks
      console.log('[SynaBun] _sendOnceReady: sending prompt in chunks (' + message.length + ' chars, ' + Math.ceil(full.length / CHUNK) + ' chunks)');
      for (let i = 0; i < full.length; i += CHUNK) {
        const chunk = full.slice(i, i + CHUNK);
        const delay = (i / CHUNK) * DELAY;
        setTimeout(() => {
          if (session.ws?.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'input', data: chunk }));
          }
        }, delay);
      }
      if (autoSubmit) {
        // Send a second Enter after all chunks + extra delay to auto-confirm Claude Code's prompt
        const totalChunkTime = Math.ceil(full.length / CHUNK) * DELAY;
        setTimeout(() => {
          if (session.ws?.readyState === WebSocket.OPEN) {
            console.log('[SynaBun] _sendOnceReady: sending auto-submit Enter');
            session.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
          }
        }, totalChunkTime + 4000);
      }
    }, 500);
  }

  function onMessage(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'replay') {
        _outputBuf += msg.data;
        // Strip ANSI codes before matching — CLI prompts are colorized
        const clean = _outputBuf.replace(ANSI_RE, '');
        if (READY_PATTERNS.some(p => p.test(clean))) {
          console.log('[SynaBun] _sendOnceReady: ready pattern matched');
          doSend();
        }
      }
    } catch {}
  }

  function attach() {
    console.log('[SynaBun] _sendOnceReady: attach() — adding message listener');
    _listener = onMessage;
    session.ws.addEventListener('message', _listener);
    // Fallback: if no prompt detected within MAX_WAIT, send anyway
    _fallbackTimer = setTimeout(() => {
      console.warn('[SynaBun] _sendOnceReady: CLI prompt not detected, sending after timeout');
      doSend();
    }, MAX_WAIT);
  }

  if (session.ws.readyState === WebSocket.OPEN) attach();
  else {
    session.ws.addEventListener('open', attach, { once: true });
    // Safety net: if the WS never opens, force-send after MAX_WAIT to avoid silent failure
    setTimeout(() => {
      if (!_sent) {
        console.warn('[SynaBun] _sendOnceReady: WS never opened — forcing send attempt');
        doSend();
      }
    }, MAX_WAIT + 2000);
  }
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
      userRenamed: s._userRenamed || false,
      claudeSessionId: s._claudeSessionId || null,
    })),
    // Split pane state
    splitMode: _splitMode,
    splitRatio: _splitRatio,
    focusedPane: _focusedPane,
    paneAssignments: Object.fromEntries(_paneAssignments),
    activePaneIdx: [..._activePaneIdx],
    detachedTabs: [..._detachedTabs.entries()].map(([sid, dt]) => {
      const r = dt.minimized && dt.savedRect ? dt.savedRect : dt.el.getBoundingClientRect();
      const session = _sessions.find(s => s.id === sid);
      // Skip saving if dimensions are invalid (element hidden/transitioning)
      const w = r.width > 50 ? r.width : 700;
      const h = r.height > 50 ? r.height : 420;
      return {
        sessionId: sid,
        sessionIdx: _sessions.findIndex(s => s.id === sid),
        left: r.left, top: r.top, width: w, height: h,
        pinned: session?.pinned || false,
        label: session?.label || '',
        userRenamed: session?._userRenamed || false,
        claudeSessionId: session?._claudeSessionId || null,
        minimized: dt.minimized || false,
        floatColor: session?._floatColor || null,
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
        // Validate saved dimensions — enforce minimums and keep on screen
        const minW = 280, minH = 160;
        const w = Math.max(minW, dt.width || minW);
        const h = Math.max(minH, dt.height || minH);
        const maxL = window.innerWidth - 80;
        const maxT = window.innerHeight - 40;
        const l = Math.max(0, Math.min(dt.left || 0, maxL));
        const t = Math.max(48, Math.min(dt.top || 0, maxT));

        tabState.el.style.left = l + 'px';
        tabState.el.style.top = t + 'px';
        tabState.el.style.width = w + 'px';
        tabState.el.style.height = h + 'px';

        if (dt.pinned) {
          session.pinned = true;
          tabState.el.classList.add('pinned');
          tabState.el.style.zIndex = '10002';
          const closeEl = tabState.el.querySelector('.close-btn');
          if (closeEl) closeEl.style.display = 'none';
          const pinEl = tabState.el.querySelector('.pin-btn');
          if (pinEl) pinEl.title = 'Unpin';
        }

        if (dt.claudeSessionId && !session._claudeSessionId) {
          session._claudeSessionId = dt.claudeSessionId;
        }

        if (dt.label) {
          // Don't overwrite a user-renamed label already set during reconnection
          if (!session._userRenamed) {
            session.label = dt.label;
            session._userRenamed = dt.userRenamed || false;
          }
          const titleEl = tabState.el.querySelector('.term-float-tab-title');
          if (titleEl) titleEl.textContent = session.label;
        }

        if (dt.minimized) {
          minimizeTab(session.id);
        }
      }
    }
  }

  // Restore split pane state
  if (snap.splitMode && snap.paneAssignments) {
    _splitRatio = snap.splitRatio ?? 0.5;
    _splitMode = true;
    activateSplitDOM();
    initSplitDivider();

    // Restore pane assignments
    for (const [sid, pane] of Object.entries(snap.paneAssignments)) {
      _paneAssignments.set(sid, pane);
      const session = _sessions.find(s => s.id === sid);
      if (session && !_detachedTabs.has(sid)) {
        const paneBody = _panel?.querySelector(`.term-pane[data-pane="${pane}"] .term-pane-body`);
        if (paneBody) paneBody.appendChild(session.viewport);
      }
    }
    _activePaneIdx = snap.activePaneIdx || [-1, -1];
    _focusedPane = snap.focusedPane ?? 0;

    // Update split button state
    const btn = $('term-split-btn');
    if (btn) {
      btn.dataset.tooltip = 'Unsplit terminal';
      btn.classList.add('split-active');
    }
    const mainBar = $('term-tab-bar');
    if (mainBar) mainBar.style.display = 'none';

    updatePaneFocusRing();
    renderSplitTabBars();

    // Show active session in each pane
    for (let p = 0; p < 2; p++) {
      if (_activePaneIdx[p] >= 0) switchToSessionInPane(_activePaneIdx[p], p);
    }
  }

  // First rAF waits for DOM layout to settle, then _scheduleFit queues the actual fit
  requestAnimationFrame(() => _sessions.forEach(s => _scheduleFit(s)));
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
    const liveMap = new Map(liveSessions.map(s => [s.id, s]));
    const liveIds = new Set(liveMap.keys());

    // Disconnect current sessions without killing server PTY
    disconnectAllSessions();

    // Reconnect to each saved session that's still alive on server
    for (const saved of snap.sessions) {
      if (liveIds.has(saved.id)) {
        const live = liveMap.get(saved.id);
        const opts = { label: saved.label, pinned: saved.pinned, cwd: live?.cwd || null, userRenamed: saved.userRenamed, claudeSessionId: saved.claudeSessionId };
        if (CLI_PROFILES.has(saved.profile)) {
          await reconnectHtmlTermSession(saved.id, saved.profile, opts);
        } else {
          await reconnectSession(saved.id, saved.profile, opts);
        }
      }
    }
  }

  // Apply layout (detach/dock, positions, pin state)
  applyTerminalLayout(snap);
}

// ══════════════════════════════════════════
// File Tree Sidebar
// ══════════════════════════════════════════

const SVG_DIR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const SVG_DIR_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';
const SVG_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';
const SVG_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

/** Toggle file tree for the docked terminal panel */
function toggleDockedFileTree() {
  const sidebar = $('term-file-sidebar');
  if (!sidebar) return;
  const session = _sessions[_activeIdx];
  toggleFileTree(sidebar, session);
}

/** Toggle file tree visibility and load contents */
async function toggleFileTree(sidebar, session) {
  if (!sidebar) return;

  const isOpen = sidebar.classList.contains('open');
  if (isOpen) {
    sidebar.classList.remove('open');
    sidebar.innerHTML = '';
    refitActiveSession(session);
    return;
  }

  if (!session?.cwd) {
    sidebar.classList.add('open');
    sidebar.innerHTML = '';
    initSidebarResize(sidebar, session);

    const inner = document.createElement('div');
    inner.className = 'ft-inner';
    const nocwd = document.createElement('div');
    nocwd.className = 'ft-no-cwd';
    nocwd.innerHTML = `
      <div class="ft-no-cwd-label">Set working directory</div>
      <div class="ft-no-cwd-input-row">
        <input class="ft-path-input" type="text" placeholder="Enter path…" spellcheck="false">
        <button class="ft-no-cwd-browse" title="Browse folders">${SVG_DIR}</button>
      </div>
      <div class="ft-no-cwd-section-label">Registered projects</div>
      <div class="ft-no-cwd-projects"><div class="ft-loading">Loading…</div></div>
    `;
    inner.appendChild(nocwd);
    sidebar.appendChild(inner);

    const input = nocwd.querySelector('.ft-path-input');
    const browseBtn = nocwd.querySelector('.ft-no-cwd-browse');
    const projectsEl = nocwd.querySelector('.ft-no-cwd-projects');
    requestAnimationFrame(() => input.focus());

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const val = input.value.trim();
        if (val) switchSidebarCwd(sidebar, session, val);
      } else if (e.key === 'Escape') {
        sidebar.classList.remove('open');
        sidebar.innerHTML = '';
        refitActiveSession(session);
      }
    });

    browseBtn.addEventListener('click', async () => {
      const result = await openDirPickerModal(input.value.trim());
      if (result) switchSidebarCwd(sidebar, session, result);
    });

    fetchProjects().then(projects => {
      projectsEl.innerHTML = '';
      if (!projects.length) {
        projectsEl.innerHTML = '<div class="ft-no-cwd-empty">No registered projects</div>';
        return;
      }
      for (const p of projects) {
        const folder = p.path.split(/[\\/]/).pop();
        const btn = document.createElement('button');
        btn.className = 'ft-no-cwd-project';
        btn.textContent = p.label || folder;
        btn.title = p.path;
        btn.addEventListener('click', () => switchSidebarCwd(sidebar, session, p.path));
        projectsEl.appendChild(btn);
      }
    }).catch(() => {
      projectsEl.innerHTML = '<div class="ft-no-cwd-empty">Failed to load projects</div>';
    });

    refitActiveSession(session);
    return;
  }

  sidebar.classList.add('open');
  sidebar.innerHTML = '<div class="ft-inner"><div class="ft-loading">Loading...</div></div>';
  initSidebarResize(sidebar, session);
  refitActiveSession(session);

  try {
    const data = await fetchTerminalFiles(session.cwd);
    sidebar.innerHTML = '';

    const inner = document.createElement('div');
    inner.className = 'ft-inner';

    // Header
    const header = document.createElement('div');
    header.className = 'ft-header';
    const dirName = session.cwd.split(/[\\/]/).pop() || session.cwd;

    // Branch (clickable if git)
    const branchHtml = data.branch
      ? `<button class="ft-branch" data-tooltip="Switch branch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg><span class="ft-branch-name">${data.branch}</span></button>`
      : '';
    header.innerHTML = `<span class="ft-header-label" data-tooltip="Click to change path" title="${session.cwd}">${dirName}</span>${branchHtml}`;

    // Wire header label click → inline path editor
    header.querySelector('.ft-header-label').addEventListener('click', (e) => {
      e.stopPropagation();
      openPathEditor(sidebar, session, header);
    });

    // Wire branch picker
    const branchBtn = header.querySelector('.ft-branch');
    if (branchBtn) {
      branchBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openBranchPicker(sidebar, session, branchBtn);
      });
    }

    inner.appendChild(header);

    // Search filter
    const search = document.createElement('div');
    search.className = 'ft-search';
    search.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input class="ft-search-input" type="text" placeholder="Filter files..." spellcheck="false" />`;
    inner.appendChild(search);

    // Tree container
    const tree = document.createElement('div');
    tree.className = 'ft-tree';
    inner.appendChild(tree);

    sidebar.appendChild(inner);

    // Store original items for restoring after search
    const originalItems = data.items;

    const searchInput = search.querySelector('.ft-search-input');
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (!q) {
        // Restore original tree
        tree.innerHTML = '';
        renderFileItems(tree, originalItems, session.cwd, 0, session);
        return;
      }
      searchTimer = setTimeout(async () => {
        tree.innerHTML = '<div class="ft-row ft-loading-row">Searching...</div>';
        try {
          const results = await fetchTerminalFiles(session.cwd, q);
          tree.innerHTML = '';
          if (!results.items.length) {
            tree.innerHTML = '<div class="ft-row ft-empty-row">No matches</div>';
            return;
          }
          renderSearchResults(tree, results.items, session);
        } catch {
          tree.innerHTML = '<div class="ft-row ft-empty-row">Search failed</div>';
        }
      }, 200);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        tree.innerHTML = '';
        renderFileItems(tree, originalItems, session.cwd, 0, session);
        searchInput.blur();
      }
      e.stopPropagation();
    });

    renderFileItems(tree, originalItems, session.cwd, 0, session);
  } catch (err) {
    sidebar.innerHTML = `<div class="ft-empty">Error: ${err.message}</div>`;
  }
}

const GIT_STATUS_LABEL = {
  modified: 'M', staged: 'S', added: 'A', deleted: 'D',
  renamed: 'R', untracked: 'U', conflict: '!', mixed: 'M',
};

/** Render file items into a container */
function renderFileItems(container, items, parentPath, depth, session) {
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `ft-row${item.type === 'dir' ? ' ft-dir' : ' ft-file'}`;
    if (item.git) row.classList.add(`ft-git-${item.git}`);
    row.style.paddingLeft = (8 + depth * 14) + 'px';

    const fullPath = parentPath.replace(/[\\/]$/, '') + '/' + item.name;
    const gitBadge = item.git ? `<span class="ft-git-badge" data-tooltip="${item.git}">${GIT_STATUS_LABEL[item.git] || '?'}</span>` : '';

    if (item.type === 'dir') {
      row.innerHTML = `<span class="ft-chevron">${SVG_CHEVRON}</span><span class="ft-icon">${SVG_DIR}</span><span class="ft-name">${item.name}</span>${gitBadge}`;
      row.dataset.path = fullPath;
      row.dataset.expanded = 'false';

      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        const expanded = row.dataset.expanded === 'true';

        if (expanded) {
          // Collapse — remove child container
          row.dataset.expanded = 'false';
          row.classList.remove('expanded');
          row.querySelector('.ft-icon').innerHTML = SVG_DIR;
          const children = row.nextElementSibling;
          if (children?.classList.contains('ft-children')) children.remove();
        } else {
          // Expand — fetch and render children
          row.dataset.expanded = 'true';
          row.classList.add('expanded');
          row.querySelector('.ft-icon').innerHTML = SVG_DIR_OPEN;

          let childContainer = row.nextElementSibling;
          if (!childContainer?.classList.contains('ft-children')) {
            childContainer = document.createElement('div');
            childContainer.className = 'ft-children';
            row.after(childContainer);
          }

          childContainer.innerHTML = '<div class="ft-row ft-loading-row" style="padding-left:' + (8 + (depth + 1) * 14) + 'px">...</div>';

          try {
            const data = await fetchTerminalFiles(fullPath);
            childContainer.innerHTML = '';
            if (data.items.length === 0) {
              childContainer.innerHTML = '<div class="ft-row ft-empty-row" style="padding-left:' + (8 + (depth + 1) * 14) + 'px">(empty)</div>';
            } else {
              renderFileItems(childContainer, data.items, fullPath, depth + 1, session);
            }
          } catch {
            childContainer.innerHTML = '<div class="ft-row ft-empty-row" style="padding-left:' + (8 + (depth + 1) * 14) + 'px">Error</div>';
          }
        }
      });
    } else {
      row.innerHTML = `<span class="ft-chevron-spacer"></span><span class="ft-icon">${SVG_FILE}</span><span class="ft-name">${item.name}</span>${gitBadge}`;
      row.dataset.path = fullPath;

      // Click file → type path into terminal
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        // Find the session's websocket and send the file path
        const ws = session?.ws;
        if (ws?.readyState === WebSocket.OPEN) {
          // Quote path if it has spaces
          const pathStr = fullPath.includes(' ') ? `"${fullPath}"` : fullPath;
          ws.send(JSON.stringify({ type: 'input', data: pathStr }));
        }
      });
    }

    container.appendChild(row);
  }
}

/** Render flat search results (relative paths from server recursive search) */
function renderSearchResults(container, items, session) {
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `ft-row ft-search-result${item.type === 'dir' ? ' ft-dir' : ' ft-file'}`;
    row.style.paddingLeft = '8px';

    const icon = item.type === 'dir' ? SVG_DIR : SVG_FILE;
    // Show relative path — highlight the filename part
    const parts = item.name.split('/');
    const fileName = parts.pop();
    const dirPath = parts.length ? `<span class="ft-search-path">${parts.join('/')}/</span>` : '';

    row.innerHTML = `<span class="ft-icon">${icon}</span>${dirPath}<span class="ft-name">${fileName}</span>`;

    const fullPath = session.cwd.replace(/[\\/]$/, '') + '/' + item.name;
    row.dataset.path = fullPath;

    if (item.type !== 'dir') {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const ws = session?.ws;
        if (ws?.readyState === WebSocket.OPEN) {
          const pathStr = fullPath.includes(' ') ? `"${fullPath}"` : fullPath;
          ws.send(JSON.stringify({ type: 'input', data: pathStr }));
        }
      });
    }

    container.appendChild(row);
  }
}

/** Open a folder browser modal; resolves with the chosen path or null */
function openDirPickerModal(initialPath) {
  return new Promise((resolve) => {
    let currentPath = initialPath || '';

    const overlay = document.createElement('div');
    overlay.className = 'term-picker-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);

    function close(result) { overlay.remove(); resolve(result); }

    async function renderDir(dirPath) {
      overlay.innerHTML = '';

      const modal = document.createElement('div');
      modal.className = 'term-picker-modal glass';

      const title = document.createElement('div');
      title.className = 'term-picker-title';
      title.innerHTML = `<span class="term-picker-icon">${SVG_DIR}</span><span>Choose folder</span>`;

      const breadcrumb = document.createElement('div');
      breadcrumb.className = 'term-dir-picker-path';
      breadcrumb.textContent = dirPath || '…';

      const list = document.createElement('div');
      list.className = 'term-picker-list';
      list.innerHTML = '<div style="padding:12px 4px;color:rgba(255,255,255,0.3);font-size:12px">Loading…</div>';

      const footer = document.createElement('div');
      footer.className = 'term-dir-picker-footer';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'term-dir-picker-cancel';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => close(null));

      const selectBtn = document.createElement('button');
      selectBtn.className = 'term-dir-picker-select';
      selectBtn.textContent = 'Select folder';
      selectBtn.addEventListener('click', () => close(currentPath));

      footer.appendChild(cancelBtn);
      footer.appendChild(selectBtn);
      modal.appendChild(title);
      modal.appendChild(breadcrumb);
      modal.appendChild(list);
      modal.appendChild(footer);
      overlay.appendChild(modal);

      try {
        const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
        const res = await fetch(`/api/browse-directory${qs}`);
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Failed');

        currentPath = data.current;
        breadcrumb.textContent = data.current;
        const folderName = data.current.split(/[\\/]/).filter(Boolean).pop() || data.current;
        selectBtn.textContent = `Select "${folderName}"`;

        list.innerHTML = '';

        if (data.parent) {
          const item = document.createElement('button');
          item.className = 'term-picker-item';
          item.innerHTML = `<span class="term-picker-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></span>`;
          const lbl = document.createElement('span');
          lbl.className = 'term-picker-item-label';
          lbl.textContent = '.. parent directory';
          item.appendChild(lbl);
          item.addEventListener('click', () => renderDir(data.parent));
          list.appendChild(item);
        }

        for (const d of data.directories) {
          const fullPath = data.current.replace(/[\\/]+$/, '') + '/' + d;
          const item = document.createElement('button');
          item.className = 'term-picker-item';
          item.innerHTML = `<span class="term-picker-item-icon">${SVG_DIR}</span>`;
          const lbl = document.createElement('span');
          lbl.className = 'term-picker-item-label';
          lbl.textContent = d;
          item.appendChild(lbl);
          item.addEventListener('click', () => renderDir(fullPath));
          list.appendChild(item);
        }

        if (!data.parent && !data.directories.length) {
          list.innerHTML = '<div style="padding:12px 4px;color:rgba(255,255,255,0.3);font-size:12px">No subdirectories</div>';
        }
      } catch (err) {
        list.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.style.cssText = 'padding:12px 4px;color:#ff5252;font-size:12px';
        errEl.textContent = 'Error: ' + (err.message || 'Failed to load');
        list.appendChild(errEl);
      }
    }

    renderDir(currentPath);
  });
}

/** Open branch picker dropdown below the branch button */
async function openBranchPicker(sidebar, session, anchorEl) {
  // Remove existing dropdown if any
  sidebar.querySelector('.ft-branch-dropdown')?.remove();

  const dropdown = document.createElement('div');
  dropdown.className = 'ft-branch-dropdown glass';
  dropdown.innerHTML = '<div class="ft-branch-loading">Loading branches...</div>';

  // Position below the header (floating overlay, absolute)
  const header = sidebar.querySelector('.ft-header');
  if (header) {
    header.after(dropdown);
    dropdown.style.top = (header.offsetTop + header.offsetHeight) + 'px';
  } else {
    sidebar.prepend(dropdown);
  }

  try {
    const data = await fetchTerminalBranches(session.cwd);
    dropdown.innerHTML = '';

    if (!data.branches.length) {
      dropdown.innerHTML = '<div class="ft-branch-loading">No branches found</div>';
      return;
    }

    for (const branch of data.branches) {
      const item = document.createElement('button');
      item.className = `ft-branch-item${branch === data.current ? ' current' : ''}`;
      item.innerHTML = `<span class="ft-branch-item-name">${branch}</span>${branch === data.current ? '<span class="ft-branch-item-check">&#10003;</span>' : ''}`;

      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (branch === data.current) {
          dropdown.remove();
          return;
        }

        // Show loading state
        item.classList.add('switching');
        item.innerHTML = `<span class="ft-branch-item-name">${branch}</span><span class="ft-branch-item-check">...</span>`;

        try {
          const result = await checkoutTerminalBranch(session.cwd, branch);

          // Update branch display
          const branchNameEl = sidebar.querySelector('.ft-branch-name');
          if (branchNameEl) branchNameEl.textContent = result.branch || branch;

          dropdown.remove();
          writeGitOutput('success', result.output || `Switched to branch '${branch}'`);

          // Refresh file tree to show new branch's status
          const tree = sidebar.querySelector('.ft-tree');
          if (tree) {
            tree.innerHTML = '<div class="ft-loading">Refreshing...</div>';
            try {
              const freshData = await fetchTerminalFiles(session.cwd);
              tree.innerHTML = '';
              renderFileItems(tree, freshData.items, session.cwd, 0, session);
            } catch {}
          }
        } catch (err) {
          item.classList.remove('switching');
          item.innerHTML = `<span class="ft-branch-item-name">${branch}</span><span class="ft-branch-item-check" style="color:#ff5252">!</span>`;
          writeGitOutput('error', err.message || 'Checkout failed');
        }
      });

      dropdown.appendChild(item);
    }
  } catch {
    dropdown.innerHTML = '<div class="ft-branch-loading">Failed to load branches</div>';
  }

  // Close on outside click
  const closeHandler = (e) => {
    if (!dropdown.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
      dropdown.remove();
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

/** Refit terminal after sidebar toggle */
/** Switch the sidebar to a new working directory */
async function switchSidebarCwd(sidebar, session, newCwd) {
  if (!newCwd) return;
  // Normalize comparison (case-insensitive on Windows, trim trailing slashes)
  const norm = p => p.replace(/[\\/]+$/, '').toLowerCase();
  if (norm(newCwd) === norm(session.cwd || '')) return;

  // cd in terminal
  if (session.ws?.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: 'input', data: `cd "${newCwd}"\r` }));
  }
  // Update session
  session.cwd = newCwd;
  const cwdLabel = newCwd.split(/[\\/]/).pop() || '';
  const profileDef = PROFILES.find(p => p.id === session.profile);
  if (!session._userRenamed) {
    session.label = cwdLabel ? `${profileDef?.label || session.profile} · ${cwdLabel}` : session.label;
  }
  renderTabBar();
  saveSessionRegistry();

  // Close and reopen to rebuild with new cwd
  sidebar.classList.remove('open');
  sidebar.innerHTML = '';
  await toggleFileTree(sidebar, session);
}

/** Open inline path editor replacing the header label */
function openPathEditor(sidebar, session, header) {
  // Don't open if already editing
  if (header.querySelector('.ft-path-input')) return;

  const label = header.querySelector('.ft-header-label');
  const originalText = label.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ft-path-input';
  input.value = session.cwd || '';
  input.placeholder = 'Enter directory path...';
  input.spellcheck = false;

  label.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const val = input.value.trim();
    if (val && val !== session.cwd) {
      // Restore label first with new name
      const newLabel = document.createElement('span');
      newLabel.className = 'ft-header-label';
      newLabel.dataset.tooltip = 'Click to change path';
      newLabel.title = val;
      newLabel.textContent = val.split(/[\\/]/).pop() || val;
      input.replaceWith(newLabel);

      // Wire click again on the new label
      newLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        openPathEditor(sidebar, session, header);
      });

      await switchSidebarCwd(sidebar, session, val);
    } else {
      // Restore original label
      const newLabel = document.createElement('span');
      newLabel.className = 'ft-header-label';
      newLabel.dataset.tooltip = 'Click to change path';
      newLabel.title = session.cwd || '';
      newLabel.textContent = originalText;
      input.replaceWith(newLabel);
      newLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        openPathEditor(sidebar, session, header);
      });
    }
  };

  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    if (ev.key === 'Escape') { input.value = session.cwd || ''; input.blur(); }
  });
}

/** Get or create a local-only "Git" terminal tab for git output */
function getGitOutputTab() {
  // Reuse existing git output tab
  const existing = _sessions.find(s => s._gitOutput);
  if (existing) return existing;

  // Create a local-only xterm (no PTY, no WebSocket)
  const term = new _Terminal({
    theme: XTERM_THEME,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
    fontSize: 13,
    lineHeight: 1.3,
    cursorBlink: false,
    cursorStyle: 'bar',
    scrollback: 2000,
    disableStdin: true,
  });

  const fitAddon = new _FitAddon();
  term.loadAddon(fitAddon);

  const viewport = document.createElement('div');
  viewport.className = 'term-viewport';
  viewport.dataset.sessionId = 'git-output';
  $('term-container').appendChild(viewport);

  // Wait for fonts then open (fonts are usually already loaded by now)
  const doOpen = () => { term.open(viewport); fitAddon.fit(); };
  if (document.fonts?.ready) document.fonts.ready.then(doOpen);
  else doOpen();

  const session = {
    id: 'git-output',
    profile: 'shell',
    cwd: null,
    label: 'Git',
    term, fitAddon, searchAddon: null, ws: null, viewport, ro: null,
    renderer: null,
    dead: false,
    pinned: false,
    _gitOutput: true,
  };
  _pushSession(session);
  renderTabBar();
  return session;
}

/** Write git output to a dedicated Git tab in the parent terminal */
function writeGitOutput(type, message) {
  const gitTab = getGitOutputTab();
  if (!gitTab?.term) return;

  const color = type === 'error' ? '\x1b[31m' : '\x1b[32m';
  const prefix = type === 'error' ? 'git error' : 'git';
  const ts = new Date().toLocaleTimeString();
  gitTab.term.write(`\x1b[2m${ts}\x1b[0m ${color}[${prefix}]\x1b[0m ${message.replace(/\n/g, '\r\n')}\r\n`);

  // Switch to the git tab
  const idx = _sessions.indexOf(gitTab);
  if (idx >= 0) switchToSession(idx);
}

/** Add a draggable resize handle to the sidebar's right edge */
function initSidebarResize(sidebar, session) {
  // Don't double-add
  if (sidebar.querySelector('.ft-resize-handle')) return;

  const handle = document.createElement('div');
  handle.className = 'ft-resize-handle';
  sidebar.appendChild(handle);

  let startX = 0;
  let startW = 0;

  const onMove = (e) => {
    const dx = e.clientX - startX;
    const newW = Math.max(140, Math.min(500, startW + dx));
    sidebar.style.width = newW + 'px';
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    sidebar.classList.remove('resizing');
    // Refit terminal to account for new sidebar width
    refitActiveSession(session);
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    sidebar.classList.add('resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function refitActiveSession(session) {
  if (session) _scheduleFit(session);
}

// ── Split pane functions ──

function refitAllDockedSessions() {
  _sessions.forEach(s => {
    if (_detachedTabs.has(s.id) || s.dead || s._isBrowser) return;
    if (s._isHtmlTerm) {
      s._htmlTerm?.fit();
    } else {
      _scheduleFit(s);
    }
  });
}

function applySplitRatio() {
  const panes = _panel?.querySelectorAll('.term-pane');
  if (!panes || panes.length !== 2) return;
  panes[0].style.flex = `0 0 calc(${_splitRatio * 100}% - 3px)`;
  panes[1].style.flex = '1 1 0';
}

function updatePaneFocusRing() {
  if (!_panel) return;
  _panel.querySelectorAll('.term-pane').forEach(p => {
    p.classList.toggle('focused', parseInt(p.dataset.pane, 10) === _focusedPane);
  });
}

function activateSplitDOM() {
  const container = $('term-container');
  if (!container) return;

  // Force flex row layout via both class and inline styles (belt-and-suspenders)
  container.classList.add('split-active');
  container.style.display = 'flex';
  container.style.flexDirection = 'row';
  container.style.alignItems = 'stretch';

  // Collect existing viewports before any DOM mutations
  const viewports = [...container.querySelectorAll(':scope > .term-viewport')];

  // Build pane structure
  const leftPane = document.createElement('div');
  leftPane.className = 'term-pane focused';
  leftPane.dataset.pane = '0';

  const leftTabs = document.createElement('div');
  leftTabs.className = 'term-pane-tabs';
  const leftBody = document.createElement('div');
  leftBody.className = 'term-pane-body';
  leftPane.appendChild(leftTabs);
  leftPane.appendChild(leftBody);

  const divider = document.createElement('div');
  divider.className = 'term-split-divider';

  const rightPane = document.createElement('div');
  rightPane.className = 'term-pane';
  rightPane.dataset.pane = '1';

  const rightTabs = document.createElement('div');
  rightTabs.className = 'term-pane-tabs';
  const rightBody = document.createElement('div');
  rightBody.className = 'term-pane-body';
  rightPane.appendChild(rightTabs);
  rightPane.appendChild(rightBody);

  // Append pane structure to container first
  container.appendChild(leftPane);
  container.appendChild(divider);
  container.appendChild(rightPane);

  // Now move existing viewports into left pane body
  viewports.forEach(vp => leftBody.appendChild(vp));

  // Assign all existing sessions to pane 0
  _sessions.forEach(s => {
    if (!_detachedTabs.has(s.id)) _paneAssignments.set(s.id, 0);
  });
  _activePaneIdx[0] = _activeIdx;

  applySplitRatio();

  // Show only the active viewport in left pane, hide rest
  viewports.forEach(vp => {
    const sid = vp.dataset.sessionId;
    const sIdx = _sessions.findIndex(s => s.id === sid);
    vp.style.display = sIdx === _activeIdx ? '' : 'none';
  });

  // Refit active session after DOM restructure — double-rAF for layout
  if (_activeIdx >= 0 && _sessions[_activeIdx]) {
    requestAnimationFrame(() => requestAnimationFrame(() => _scheduleFit(_sessions[_activeIdx])));
  }

  // Focus tracking on pane click
  [leftPane, rightPane].forEach(paneEl => {
    paneEl.addEventListener('mousedown', () => {
      _focusedPane = parseInt(paneEl.dataset.pane, 10);
      updatePaneFocusRing();
    });
  });
}

function deactivateSplitDOM() {
  const container = $('term-container');
  if (!container) return;

  // Extract viewports from pane bodies BEFORE removing panes
  const viewports = [...container.querySelectorAll('.term-pane-body .term-viewport')];
  viewports.forEach(vp => container.appendChild(vp)); // move to container root

  // Remove pane wrappers and divider
  container.querySelectorAll('.term-pane, .term-split-divider').forEach(el => el.remove());

  // Reset container styles
  container.classList.remove('split-active');
  container.style.display = '';
  container.style.flexDirection = '';
  container.style.alignItems = '';
}

function initSplitDivider() {
  const divider = _panel?.querySelector('.term-split-divider');
  if (!divider) return;
  const container = $('term-container');

  const onMove = (e) => {
    const containerRect = container.getBoundingClientRect();
    const newRatio = Math.max(0.3, Math.min(0.7,
      (e.clientX - containerRect.left) / containerRect.width));
    _splitRatio = newRatio;
    applySplitRatio();
    refitAllDockedSessions();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    divider.classList.remove('dragging');
    storage.setItem(KEYS.TERMINAL_SPLIT_RATIO, String(_splitRatio));
    refitAllDockedSessions();
  };

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    divider.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function switchToSessionInPane(idx, pane) {
  if (idx < 0 || idx >= _sessions.length) return;
  _activePaneIdx[pane] = idx;

  // Show/hide viewports within this pane only
  const paneBody = _panel?.querySelector(`.term-pane[data-pane="${pane}"] .term-pane-body`);
  if (!paneBody) return;

  paneBody.querySelectorAll('.term-viewport').forEach(vp => {
    const sid = vp.dataset.sessionId;
    const sIdx = _sessions.findIndex(s => s.id === sid);
    vp.style.display = sIdx === idx ? '' : 'none';
  });

  const session = _sessions[idx];
  requestAnimationFrame(() => {
    if (session._isBrowser) {
      session._browserCanvas?.focus();
    } else if (session._isHtmlTerm) {
      session._htmlTerm?.fit();
      session._htmlTerm?.focus();
    } else {
      _scheduleFit(session);
      session.term?.focus();
    }
  });

  renderSplitTabBars();
}

function renderSplitTabBars() {
  if (!_splitMode || !_panel) return;
  for (let pane = 0; pane < 2; pane++) {
    const tabBar = _panel.querySelector(`.term-pane[data-pane="${pane}"] .term-pane-tabs`);
    if (!tabBar) continue;

    const paneSessions = _sessions
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !_detachedTabs.has(s.id) && _paneAssignments.get(s.id) === pane);

    tabBar.innerHTML = paneSessions.map(({ s, i }) => {
      const prof = PROFILES.find(p => p.id === s.profile);
      const active = i === _activePaneIdx[pane];
      const dead = s.dead;
      return `<button class="term-tab${active ? ' active' : ''}${dead ? ' dead' : ''}"
        data-idx="${i}" data-pane="${pane}" draggable="true" data-profile="${s.profile}" data-session-id="${s.id}">
        <span class="term-tab-icon">${s._gitOutput ? SVG_GIT : (prof?.svg || SVG_SHELL)}</span>
        <span class="term-tab-label">${s.label}${dead ? ' (exited)' : ''}</span>${_cliBadgeHtml(s.id)}
        <span class="term-tab-close" data-idx="${i}">&times;</span>
      </button>`;
    }).join('');

    // Tab click handler — switch to clicked tab within its pane
    tabBar.querySelectorAll('.term-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.term-tab-close')) return; // let close handler handle it
        const idx = parseInt(tab.dataset.idx, 10);
        const p = parseInt(tab.dataset.pane, 10);
        if (!isNaN(idx) && !isNaN(p)) {
          _focusedPane = p;
          updatePaneFocusRing();
          switchToSessionInPane(idx, p);
        }
      });

      // Close button
      const closeBtn = tab.querySelector('.term-tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(closeBtn.dataset.idx, 10);
          if (!isNaN(idx)) closeSession(idx);
        });
      }
    });

    // Drag-drop: make tabs draggable between panes
    tabBar.querySelectorAll('.term-tab[draggable]').forEach(tab => {
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', tab.dataset.idx);
        e.dataTransfer.effectAllowed = 'move';
        tab.classList.add('dragging');
      });
      tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
    });

    // Drop zone
    tabBar.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tabBar.classList.add('drag-over');
    });
    tabBar.addEventListener('dragleave', () => tabBar.classList.remove('drag-over'));
    tabBar.addEventListener('drop', (e) => {
      e.preventDefault();
      tabBar.classList.remove('drag-over');
      const idx = parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (isNaN(idx)) return;
      const targetPane = parseInt(tabBar.closest('.term-pane').dataset.pane, 10);
      moveSessionToPane(idx, targetPane);
    });
  }
}

function moveSessionToPane(sessionIdx, targetPane) {
  const session = _sessions[sessionIdx];
  if (!session || _detachedTabs.has(session.id)) return;
  const currentPane = _paneAssignments.get(session.id) ?? 0;
  if (currentPane === targetPane) return;

  // Move viewport DOM element
  const paneBody = _panel?.querySelector(`.term-pane[data-pane="${targetPane}"] .term-pane-body`);
  if (paneBody) paneBody.appendChild(session.viewport);

  _paneAssignments.set(session.id, targetPane);

  // If source pane active was this session, pick next in source
  if (_activePaneIdx[currentPane] === sessionIdx) {
    const remaining = _sessions.findIndex((s) =>
      _paneAssignments.get(s.id) === currentPane && !_detachedTabs.has(s.id));
    _activePaneIdx[currentPane] = remaining >= 0 ? remaining : -1;
    if (remaining >= 0) switchToSessionInPane(remaining, currentPane);
  }

  // If source pane is now empty, auto-unsplit
  const sourceHasSessions = _sessions.some((s) =>
    _paneAssignments.get(s.id) === currentPane && !_detachedTabs.has(s.id));
  if (!sourceHasSessions) {
    deactivateSplit();
    return;
  }

  // Activate moved session in target pane
  _activePaneIdx[targetPane] = sessionIdx;
  _focusedPane = targetPane;
  updatePaneFocusRing();
  renderSplitTabBars();
  switchToSessionInPane(sessionIdx, targetPane);
  refitAllDockedSessions();
}

function activateSplit() {
  if (_splitMode || _sessions.length === 0) return;
  _splitMode = true;

  // Load persisted split ratio
  const saved = parseFloat(storage.getItem(KEYS.TERMINAL_SPLIT_RATIO));
  if (saved >= 0.3 && saved <= 0.7) _splitRatio = saved;

  activateSplitDOM();
  initSplitDivider();

  // Update split button
  const btn = $('term-split-btn');
  if (btn) {
    btn.dataset.tooltip = 'Unsplit terminal';
    btn.classList.add('split-active');
  }

  // Hide main tab bar — pane tab bars take over
  const mainBar = $('term-tab-bar');
  if (mainBar) mainBar.style.display = 'none';

  renderSplitTabBars();

  // Auto-spawn shell in right pane — always a shell, not a clone of the current profile
  _focusedPane = 1;
  openSession('shell').then(() => {
    const newIdx = _sessions.length - 1;
    _activePaneIdx[1] = newIdx;
    updatePaneFocusRing();
    renderSplitTabBars();
    switchToSessionInPane(newIdx, 1);
    // Refit all after layout settles
    requestAnimationFrame(() => requestAnimationFrame(() => refitAllDockedSessions()));
  });
}

function deactivateSplit() {
  if (!_splitMode) return;
  _splitMode = false;

  deactivateSplitDOM();

  // Determine which session to keep active
  const focusIdx = _activePaneIdx[_focusedPane];
  _activeIdx = focusIdx >= 0 && focusIdx < _sessions.length ? focusIdx : 0;
  _focusedPane = 0;
  _paneAssignments.clear();
  _activePaneIdx = [-1, -1];

  // Reset split button
  const btn = $('term-split-btn');
  if (btn) {
    btn.dataset.tooltip = 'Split terminal';
    btn.classList.remove('split-active');
  }

  // Restore main tab bar
  const mainBar = $('term-tab-bar');
  if (mainBar) mainBar.style.display = '';

  renderTabBar();
  switchToSession(_activeIdx);
}
