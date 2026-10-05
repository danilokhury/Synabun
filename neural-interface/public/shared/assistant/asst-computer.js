// ═══════════════════════════════════════════
// SynaBun Assistant — computer use (macOS desktop control) UI
// ═══════════════════════════════════════════
// Pure helpers (node:test covers them): tool-name detection, action verbs,
// result-line parsing, click-marker placement and the setup state machine.
// DOM: the composer's "Computer" switch, the setup tray + live activity bar in
// `.asst-computer-host`, and the body-level frame lightbox. Nothing touches
// `document` at import time.
//
// Wire contract (server side): GET /api/desktop/status → DesktopStatus;
// POST /api/desktop/setup { step, pane? }; POST /api/desktop/stop { scope };
// POST /api/desktop/resume; frames at /api/desktop/frames/<id>.jpg and
// /api/desktop/frames/<id>/thumb.jpg; `assistant:desktop` activity events.

import { desktopSetup, getDesktopStatus, resumeDesktop, stopDesktop } from './asst-api.js';

// ── Pure helpers ────────────────────────────────────────────────────────────

export const COMPUTER_TOOLS = Object.freeze(['computer', 'computer_apps', 'computer_ax', 'computer_status']);
const COMPUTER_TOOL_SET = new Set(COMPUTER_TOOLS);

function str(v) { return v == null ? '' : String(v).trim(); }
function num(v) { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; }
function firstStr(...values) { for (const v of values) { const s = str(v); if (s) return s; } return ''; }
function clip(text, max) { const s = str(text).replace(/\s+/g, ' '); return s.length > max ? `${s.slice(0, max - 1)}…` : s; }

/** Base computer tool name ('computer', 'computer_apps', …) or null. Accepts SynaBun prefixes. */
export function computerToolName(name) {
  const base = str(name).replace(/^mcp__synabun__/i, '').replace(/^synabun_/i, '');
  return COMPUTER_TOOL_SET.has(base) ? base : null;
}

/** computer / computer_apps / computer_ax / computer_status, bare or SynaBun-prefixed. */
export function isComputerTool(name) {
  return computerToolName(name) != null;
}

/**
 * A WhatsApp conversation's computer use, as the session meta carries it
 * (`computerRemote`: what lib/remote-policy.js remoteComputerUse says, plus
 * `approved` while the running task was approved). null for a desktop
 * conversation, and for anything that is not that shape.
 */
export function normalizeComputerRemote(value) {
  if (!value || typeof value !== 'object') return null;
  const state = ['off', 'ask', 'allowed'].includes(value.state) ? value.state : null;
  if (!state) return null;
  return { state, reason: str(value.reason) || null, approved: value.approved === true };
}

// [i18n key, English]: why the Computer switch of a WhatsApp conversation is what it is.
const COMPUTER_REMOTE_TIPS = Object.freeze({
  switch_off: ['assistant.computer.remote.switchOff', 'Off for WhatsApp. Turn it on in Settings → Messages → WhatsApp → Safety'],
  paused: ['assistant.computer.remote.paused', 'Off: WhatsApp is paused'],
  read_only: ['assistant.computer.remote.readOnly', 'Off at the Read-only level (Settings → Messages → WhatsApp → Safety)'],
  brain: ['assistant.computer.remote.brain', 'Off: this WhatsApp conversation does not run on Claude'],
  setup: ['assistant.computer.remote.setup', 'Off: computer use is not set up on this Mac yet'],
  unsupported: ['assistant.computer.remote.unsupported', 'Computer use needs macOS'],
  autonomous: ['assistant.computer.remote.autonomous', 'On while Autonomous is active'],
  ask: ['assistant.computer.remote.ask', 'Asks on your phone once per task'],
  autonomous_expired: ['assistant.computer.remote.autonomousExpired', 'Autonomous ended: asks on your phone once per task'],
  untrusted: ['assistant.computer.remote.untrusted', 'Asks on your phone once: this task was not started by a plain message from your phone'],
  approved: ['assistant.computer.remote.approved', 'On for this task: you approved it'],
  off: ['assistant.computer.remote.off', 'Off for this WhatsApp conversation'],
});

/**
 * The Computer switch of a WhatsApp conversation: { on, tip, key, reason }.
 * It shows what is in effect and why; it is not a per-conversation switch
 * (the owner's setting and the level decide). null for a desktop conversation.
 */
export function computerRemoteView(remote, t) {
  const r = normalizeComputerRemote(remote);
  if (!r) return null;
  const which = r.state !== 'off' && r.approved ? 'approved' : (COMPUTER_REMOTE_TIPS[r.reason] ? r.reason : (r.state === 'off' ? 'off' : r.state === 'allowed' ? 'autonomous' : 'ask'));
  const [key, english] = COMPUTER_REMOTE_TIPS[which];
  const said = typeof t === 'function' ? t(key) : null;
  return { on: r.state !== 'off', state: r.state, reason: which, key, tip: typeof said === 'string' && said && said !== key ? said : english };
}

export const COMPUTER_ACTION_VERBS = Object.freeze({
  screenshot: 'Screenshot',
  left_click: 'Click',
  right_click: 'Right-click',
  middle_click: 'Middle-click',
  double_click: 'Double-click',
  triple_click: 'Triple-click',
  mouse_move: 'Move pointer',
  left_click_drag: 'Drag',
  left_mouse_down: 'Mouse down',
  left_mouse_up: 'Mouse up',
  type: 'Type',
  key: 'Press',
  hold_key: 'Hold',
  scroll: 'Scroll',
  wait: 'Wait',
  zoom: 'Zoom',
  cursor_position: 'Pointer position',
});

function toPoint(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const x = num(value[0]); const y = num(value[1]);
    return x == null || y == null ? null : [x, y];
  }
  if (value && typeof value === 'object') {
    const x = num(value.x); const y = num(value.y);
    return x == null || y == null ? null : [x, y];
  }
  return null;
}

function fmtPoint(value) {
  const p = toPoint(value);
  return p ? `(${Math.round(p[0])}, ${Math.round(p[1])})` : '';
}

function fmtRegion(region) {
  if (!Array.isArray(region) || region.length < 4) return '';
  const [x1, y1, x2, y2] = region.map(Number);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return '';
  return `(${Math.round(x1)}, ${Math.round(y1)})–(${Math.round(x2)}, ${Math.round(y2)})`;
}

function humanize(action) {
  const s = str(action).replace(/[_-]+/g, ' ');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** One-line description of a computer tool call: "Click (640, 412)", "Type “hello”", … */
export function describeComputerAction(input = {}, toolName = 'computer') {
  const base = computerToolName(toolName) || 'computer';
  const i = input && typeof input === 'object' ? input : {};
  const action = str(i.action);
  if (base === 'computer_status') return 'Status';
  if (base === 'computer_apps') {
    const target = firstStr(i.name, i.app, i.appName, i.bundleId, i.bundle_id);
    return [humanize(action || 'list') + (action ? '' : ' apps'), target].filter(Boolean).join(' ');
  }
  if (base === 'computer_ax') {
    // intent first: "Press “go back”" for a press by intent, "Snapshot “…”" for a ranked list.
    const target = firstStr(i.intent, i.query, i.title, i.role, i.label, i.app);
    return [humanize(action || 'inspect'), target ? `“${clip(target, 40)}”` : ''].filter(Boolean).join(' ');
  }
  const verb = COMPUTER_ACTION_VERBS[action] || humanize(action) || 'Computer';
  const at = fmtPoint(i.coordinate);
  switch (action) {
    case 'left_click_drag': {
      const from = fmtPoint(i.start_coordinate);
      return [verb, from && at ? `${from} → ${at}` : (from || at)].filter(Boolean).join(' ');
    }
    case 'type': return `${verb} “${clip(i.text, 40)}”`;
    case 'key': return [verb, str(i.text || i.key)].filter(Boolean).join(' ');
    case 'hold_key': {
      const secs = num(i.duration);
      return [verb, str(i.text || i.key), secs != null ? `for ${secs}s` : ''].filter(Boolean).join(' ');
    }
    case 'scroll': {
      const amount = num(i.scroll_amount);
      return [verb, str(i.scroll_direction), amount != null ? `×${amount}` : '', at ? `at ${at}` : ''].filter(Boolean).join(' ');
    }
    case 'wait': return `${verb} ${num(i.duration) ?? 1}s`;
    case 'zoom': return [verb, fmtRegion(i.region)].filter(Boolean).join(' ');
    case 'screenshot':
    case 'cursor_position':
      return verb;
    default:
      return at ? `${verb} ${at}` : verb;
  }
}

/**
 * Parse the first line of a computer tool result:
 *   "ok · left_click (640,412) · TextEdit · frame=f_ab12cd size=1280x800 screenshot_id=s_…"
 *   "error CODE: message"
 * frame / size / screenshot_id are looked up anywhere in the text.
 */
export function parseComputerResult(text) {
  const raw = typeof text === 'string' ? text : '';
  const first = (raw.split('\n').find(line => line.trim()) || '').trim();
  const out = { ok: null, code: null, message: '', summary: '', action: '', app: '', frameId: null, width: null, height: null, screenshotId: null };
  // `error PRESS_REFUSED(target_changed:title): …` carries its reason in parentheses.
  const coded = first.match(/^error\s+([A-Za-z0-9_.-]+)(?:\(([^)]*)\))?\s*:\s*(.*)$/i);
  const err = coded || first.match(/^error\s*:?\s*(.*)$/i);
  if (err) {
    out.ok = false;
    if (coded) { out.code = coded[1]; out.message = [coded[2] ? coded[2].trim() : '', coded[3].trim()].filter(Boolean).join(' — '); }
    else out.message = (err[1] || '').trim();
  } else if (/^ok\b/i.test(first)) {
    out.ok = true;
    const segments = first.split(/\s+·\s+/).map(s => s.trim()).filter(Boolean).slice(1);
    const plain = segments.filter(s => !/\b[a-z_]+=/.test(s));
    out.summary = plain.join(' · ');
    out.action = (plain[0] || '').split(/\s+/)[0] || '';
    out.app = plain[1] || '';
  }
  const frame = raw.match(/\bframe=([A-Za-z0-9_-]+)/);
  if (frame) out.frameId = frame[1];
  const size = raw.match(/\bsize=(\d+)x(\d+)/);
  if (size) { out.width = Number(size[1]); out.height = Number(size[2]); }
  const shot = raw.match(/\bscreenshot_id=([A-Za-z0-9_.:-]+)/);
  if (shot) out.screenshotId = shot[1];
  return out;
}

function toSize(size) {
  if (Array.isArray(size) && size.length >= 2) {
    const w = num(size[0]); const h = num(size[1]);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (typeof size === 'string') {
    const m = size.match(/^(\d+)x(\d+)$/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }
  if (size && typeof size === 'object') {
    const w = num(size.width ?? size.w); const h = num(size.height ?? size.h);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  return null;
}

/** Click-marker position as percentages of the screenshot, clamped to 0..100. */
export function markerPercent(coordinate, size) {
  const p = toPoint(coordinate);
  const s = toSize(size);
  if (!p || !s) return null;
  const clamp = v => Math.max(0, Math.min(100, Math.round(v * 100) / 100));
  return { x: clamp((p[0] / s.width) * 100), y: clamp((p[1] / s.height) * 100) };
}

export const COMPUTER_SETUP_STATES = Object.freeze([
  'loading', 'unsupported', 'disabled', 'not_started', 'needs_toolchain', 'compiling',
  'compile_failed', 'starting', 'needs_permissions', 'needs_relaunch', 'ready',
]);
const KNOWN_SETUP = new Set(COMPUTER_SETUP_STATES);

/** Reduce a DesktopStatus into what the setup tray renders. */
export function computerSetupState(status) {
  const base = {
    state: 'loading', ready: false, supported: true, needsSetup: true, busy: true,
    screen: { granted: false, deepLink: null }, accessibility: { granted: false, deepLink: null },
    appName: '', logTail: '', error: '', platform: '',
  };
  if (!status || typeof status !== 'object') return base;
  const setup = status.setup && typeof status.setup === 'object' ? status.setup : {};
  const perms = status.permissions && typeof status.permissions === 'object' ? status.permissions : {};
  const screen = { granted: perms.screenRecording?.granted === true, deepLink: perms.screenRecording?.deepLink || null };
  const accessibility = { granted: perms.accessibility?.granted === true, deepLink: perms.accessibility?.deepLink || null };
  let state = str(setup.state) || 'not_started';
  if (status.supported === false || state === 'unsupported_platform' || state === 'unsupported') state = 'unsupported';
  else if (state === 'ready' && (perms.screenRecording?.granted === false || perms.accessibility?.granted === false)) state = 'needs_permissions';
  else if (perms.needsRelaunch === true && state !== 'ready' && state !== 'disabled') state = 'needs_relaunch';
  if (!KNOWN_SETUP.has(state)) state = 'not_started';
  return {
    ...base,
    state,
    ready: state === 'ready',
    supported: state !== 'unsupported',
    needsSetup: !['ready', 'unsupported', 'disabled'].includes(state),
    busy: state === 'compiling' || state === 'starting',
    screen,
    accessibility,
    appName: str(perms.responsibleApp?.name),
    logTail: str(setup.build?.logTail),
    error: str(setup.helper?.lastError),
    platform: str(status.platform),
  };
}

/** Frame URLs for an id from a result line. */
export function frameUrls(frameId) {
  const id = encodeURIComponent(String(frameId || ''));
  return { thumb: `/api/desktop/frames/${id}/thumb.jpg`, full: `/api/desktop/frames/${id}.jpg` };
}

// ── Stop requests (deduplicated across every mounted assistant tab) ─────────

let _lastStopAt = 0;

/** POST /api/desktop/stop once, even when several tabs react to the same Esc. */
export function requestDesktopStop(body = { scope: 'all' }) {
  const now = Date.now();
  if (now - _lastStopAt < 600) return Promise.resolve({ ok: true, deduped: true });
  _lastStopAt = now;
  return stopDesktop(body).catch((error) => ({ ok: false, error: error?.message || String(error) }));
}

// ── DOM ─────────────────────────────────────────────────────────────────────

const ICON_COMPUTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const POLL_MS = 3000;
const THUMB_MIN_INTERVAL_MS = 500; // ≤ 2 live-thumbnail updates per second

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function tf(t) {
  return (key, fallback, params) => {
    const v = typeof t === 'function' ? t(key, params) : undefined;
    if (v && v !== key && typeof v === 'string') return v;
    return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
  };
}

/** Swap `img` to `src` only once the new bitmap is decoded (no blank flash). */
export async function swapImage(img, src) {
  if (!img || !src) return false;
  if (img.dataset.src === src) return true;
  const next = new Image();
  next.decoding = 'async';
  next.src = src;
  try { await next.decode(); } catch { return false; }
  if (!img.isConnected && !img.parentNode) return false;
  img.src = src;
  img.dataset.src = src;
  img.hidden = false;
  return true;
}

/**
 * The composer "Computer" switch. hooks: { t, onToggle(nextEnabled) }
 * set({ visible, enabled, supported, setupState, active })
 */
export function createComputerToggle(hostEl, hooks = {}) {
  const t = tf(hooks.t);
  const btn = el('button', 'asst-tb-btn asst-computer-toggle');
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', 'false');
  // The state dot and the screen are one glyph half (one centred pair, glyph only too).
  btn.innerHTML = `<span class="asst-icon" aria-hidden="true"><span class="asst-computer-dot"></span>${ICON_COMPUTER}</span><span class="asst-tb-label">${t('assistant.computer.toggle', 'Computer')}</span>`;
  btn.hidden = true;
  hostEl.appendChild(btn);
  // `remote`: a WhatsApp conversation's computer use (normalizeComputerRemote), null for a desktop one.
  const state = { visible: false, enabled: false, supported: true, setupState: 'loading', active: false, remote: null };

  function render() {
    btn.hidden = !state.visible;
    btn.disabled = !state.supported;
    // A WhatsApp conversation: the switch shows what is in effect and says why. It is not a
    // per-conversation switch, so a click never changes it (and it never bounces).
    const remote = state.supported ? computerRemoteView(state.remote, t) : null;
    if (remote) {
      btn.setAttribute('aria-checked', remote.on ? 'true' : 'false');
      btn.setAttribute('aria-readonly', 'true');
      btn.dataset.state = state.active ? 'active' : remote.on ? 'ready' : 'off';
      btn.dataset.remote = remote.state;
      btn.setAttribute('data-tooltip', remote.tip);
      btn.setAttribute('aria-label', `${t('assistant.computer.toggle', 'Computer')} — ${remote.tip}`);
      return;
    }
    btn.removeAttribute('aria-readonly');
    delete btn.dataset.remote;
    btn.setAttribute('aria-checked', state.enabled && state.supported ? 'true' : 'false');
    const view = !state.supported ? 'unsupported'
      : state.active ? 'active'
        : !state.enabled ? 'off'
          : state.setupState === 'ready' ? 'ready' : 'setup';
    btn.dataset.state = view;
    const tip = {
      unsupported: t('assistant.computer.tipUnsupported', 'Computer use needs macOS'),
      active: t('assistant.computer.tipActive', 'Controlling your computer — Esc stops'),
      off: t('assistant.computer.tipOff', 'Let the assistant use your Mac'),
      ready: t('assistant.computer.tipReady', 'Computer use is on'),
      setup: t('assistant.computer.tipSetup', 'Computer use is on — finish setup'),
    }[view];
    btn.setAttribute('data-tooltip', tip);
    btn.setAttribute('aria-label', `${t('assistant.computer.toggle', 'Computer')} — ${tip}`);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.supported) return;
    // A WhatsApp conversation: say why instead of toggling.
    const remote = computerRemoteView(state.remote, t);
    if (remote) { hooks.onRemoteInfo?.(remote); return; }
    hooks.onToggle?.(!state.enabled);
  });
  render();
  return {
    el: btn,
    set(patch = {}) { Object.assign(state, patch); render(); },
    get: () => ({ ...state }),
    destroy() { btn.remove(); },
  };
}

/**
 * Setup tray + live activity bar inside `.asst-computer-host`.
 * hooks: { t, sessionId, isEnabled() → bool, onStatus(status, setupInfo), onActivity(active),
 *          onOpenFrame({ src, marker, caption, returnFocus }) }
 */
export function createComputerPanel(hostEl, hooks = {}) {
  const t = tf(hooks.t);
  const root = el('div', 'asst-computer');
  hostEl.appendChild(root);
  const state = {
    status: null,
    info: computerSetupState(null),
    desktop: null,
    busyStep: '',
    error: '',
    pollTimer: null,
    destroyed: false,
    thumbAt: 0,
    thumbTimer: null,
    thumbPending: null,
    view: '',
  };

  function isEnabled() { try { return !!hooks.isEnabled?.(); } catch { return false; } }

  function desktopActive() {
    const d = state.desktop;
    if (!d || d.state === 'stopped') return false;
    // `active` = a session owns control (also between actions); acting/paused imply it.
    return d.active === true || d.state === 'acting' || d.state === 'paused_user';
  }

  function latched() {
    return state.desktop?.state === 'stopped' || state.status?.control?.stopped?.latched === true;
  }

  function wantedView() {
    if (desktopActive()) return 'activity';
    if (latched() && (isEnabled() || state.desktop)) return 'stopped';
    if (isEnabled() && !state.info.ready && state.info.state !== 'disabled') return 'tray';
    return '';
  }

  function render() {
    if (state.destroyed) return;
    const view = wantedView();
    root.hidden = !view;
    root.dataset.view = view;
    root.dataset.busy = state.busyStep || '';
    if (view === 'activity') renderActivity();
    else if (view === 'stopped') renderStopped();
    else if (view === 'tray') renderTray();
    else root.innerHTML = '';
    state.view = view;
    syncPolling();
    try { hooks.onActivity?.(desktopActive()); } catch { /* listener error */ }
  }

  // ── Activity bar ──
  function renderActivity() {
    const d = state.desktop || {};
    let bar = root.querySelector('.asst-computer-activity');
    if (!bar || bar.dataset.mode !== 'live') {
      root.innerHTML = '';
      bar = el('div', 'asst-computer-activity');
      bar.dataset.mode = 'live';
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-live', 'polite');
      bar.innerHTML = `
        <span class="asst-live-dot" aria-hidden="true"></span>
        <button type="button" class="asst-computer-thumb" aria-label="${escAttr(t('assistant.computer.openFrame', 'Open the latest screenshot'))}"><img alt="" hidden></button>
        <span class="asst-computer-activity-text"><span class="asst-computer-activity-title"></span><span class="asst-computer-activity-sub"></span></span>
        <button type="button" class="asst-btn asst-btn-danger asst-computer-stop">${escHtml(t('assistant.computer.stopEsc', 'Stop · Esc'))}</button>`;
      bar.querySelector('.asst-computer-stop').addEventListener('click', () => stop('ui'));
      bar.querySelector('.asst-computer-thumb').addEventListener('click', (e) => {
        const url = state.desktop?.thumbnail?.frameId ? frameUrls(state.desktop.thumbnail.frameId).full : state.desktop?.thumbnail?.url;
        if (!url) return;
        hooks.onOpenFrame?.({ src: url, marker: cursorMarker(), caption: activitySubtitle(), returnFocus: e.currentTarget });
      });
      root.appendChild(bar);
    }
    bar.dataset.state = d.state || 'acting';
    const ownerLabel = str(d.owner?.label);
    const mine = !d.owner?.assistantSessionId || d.owner.assistantSessionId === hooks.sessionId;
    const title = d.state === 'paused_user'
      ? t('assistant.computer.paused', 'Paused — you are using the computer')
      : (mine || !ownerLabel
        ? t('assistant.computer.controlling', 'Controlling your computer')
        : t('assistant.computer.controllingOther', '{owner} is controlling your computer', { owner: ownerLabel }));
    bar.querySelector('.asst-computer-activity-title').textContent = title;
    bar.querySelector('.asst-computer-activity-sub').textContent = activitySubtitle();
    const stopBtn = bar.querySelector('.asst-computer-stop');
    stopBtn.hidden = d.stoppable === false;
    const thumb = d.thumbnail;
    const thumbUrl = thumb?.url || (thumb?.frameId ? frameUrls(thumb.frameId).thumb : '');
    if (thumbUrl) queueThumb(thumbUrl);
  }

  function activitySubtitle() {
    const d = state.desktop || {};
    const bits = [];
    if (d.app?.name) bits.push(d.app.name);
    const last = d.lastAction;
    if (last) bits.push(str(last.summary) || describeComputerAction({ action: last.action }, 'computer'));
    return bits.join(' · ');
  }

  function cursorMarker() {
    const d = state.desktop || {};
    const size = d.thumbnail ? { width: d.thumbnail.width, height: d.thumbnail.height } : null;
    const c = d.cursor;
    if (!c || !size) return null;
    return markerPercent(Array.isArray(c) ? c : [c.x, c.y], size);
  }

  function queueThumb(url) {
    const now = Date.now();
    const wait = THUMB_MIN_INTERVAL_MS - (now - state.thumbAt);
    state.thumbPending = url;
    if (wait > 0) {
      if (!state.thumbTimer) state.thumbTimer = setTimeout(() => { state.thumbTimer = null; flushThumb(); }, wait);
      return;
    }
    flushThumb();
  }

  function flushThumb() {
    const url = state.thumbPending;
    state.thumbPending = null;
    if (!url || state.destroyed) return;
    state.thumbAt = Date.now();
    const img = root.querySelector('.asst-computer-thumb img');
    if (img) swapImage(img, url).catch(() => {});
  }

  function renderStopped() {
    root.innerHTML = '';
    const bar = el('div', 'asst-computer-activity');
    bar.dataset.mode = 'stopped';
    bar.dataset.state = 'stopped';
    bar.setAttribute('role', 'status');
    const reason = str(state.desktop?.lastAction?.code) || str(state.status?.control?.stopped?.reason);
    bar.innerHTML = `
      <span class="asst-computer-stopped-dot" aria-hidden="true"></span>
      <span class="asst-computer-activity-text"><span class="asst-computer-activity-title">${escHtml(t('assistant.computer.stopped', 'Stopped'))}</span><span class="asst-computer-activity-sub">${escHtml(reason ? t('assistant.computer.stoppedReason', 'Computer control stopped ({reason})', { reason }) : t('assistant.computer.stoppedHint', 'Computer control is paused until you resume it'))}</span></span>
      <button type="button" class="asst-btn asst-btn-secondary asst-computer-resume">${escHtml(t('assistant.computer.resume', 'Resume'))}</button>`;
    bar.querySelector('.asst-computer-resume').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await resumeDesktop();
        if (state.desktop) state.desktop = { ...state.desktop, state: 'idle', active: false };
        if (state.status?.control?.stopped) state.status.control.stopped.latched = false;
      } catch (err) { state.error = err?.message || String(err); }
      render();
    });
    root.appendChild(bar);
  }

  // ── Setup tray ──
  function renderTray() {
    const info = state.info;
    root.innerHTML = '';
    const tray = el('div', 'asst-computer-tray');
    tray.dataset.state = info.state;
    tray.setAttribute('role', 'region');
    tray.setAttribute('aria-label', t('assistant.computer.setupTitle', 'Computer use setup'));
    const head = el('div', 'asst-computer-tray-head');
    head.innerHTML = `<span class="asst-icon" aria-hidden="true">${ICON_COMPUTER}</span><span class="asst-computer-tray-title"></span>`;
    const title = head.querySelector('.asst-computer-tray-title');
    tray.appendChild(head);
    const body = el('div', 'asst-computer-tray-body');
    tray.appendChild(body);
    const actions = el('div', 'asst-computer-tray-actions');
    const button = (label, tone, onClick, step) => {
      const b = el('button', `asst-btn asst-btn-${tone}`, label);
      b.type = 'button';
      if (step) b.dataset.step = step;
      if (state.busyStep && state.busyStep === step) b.disabled = true;
      b.addEventListener('click', onClick);
      actions.appendChild(b);
      return b;
    };
    const note = (text) => body.appendChild(el('div', 'asst-computer-tray-note', text));
    const spinner = () => head.insertBefore(el('span', 'asst-spinner'), head.firstChild);

    switch (info.state) {
      case 'loading':
        spinner();
        title.textContent = t('assistant.computer.checking', 'Checking computer use…');
        break;
      case 'unsupported':
        title.textContent = t('assistant.computer.unsupported', 'Computer use needs macOS');
        note(t('assistant.computer.unsupportedBody', 'SynaBun controls the desktop through a small native helper that only runs on a Mac.'));
        break;
      case 'not_started':
        title.textContent = t('assistant.computer.setupStart', 'Set up computer use');
        note(t('assistant.computer.setupStartBody', 'SynaBun builds a small helper that takes screenshots and moves the pointer. It needs Screen Recording and Accessibility access.'));
        button(t('assistant.computer.setupStartBtn', 'Set up'), 'primary', () => runStep('start'), 'start');
        break;
      case 'needs_toolchain':
        title.textContent = t('assistant.computer.needsToolchain', 'Install the Xcode command line tools');
        note(t('assistant.computer.needsToolchainBody', 'The helper is compiled with swiftc. macOS will ask to install the command line tools.'));
        button(t('assistant.computer.install', 'Install'), 'primary', () => runStep('install_toolchain'), 'install_toolchain');
        button(t('assistant.computer.checkAgain', 'Check again'), 'secondary', () => runStep('recheck'), 'recheck');
        break;
      case 'compiling':
        spinner();
        title.textContent = t('assistant.computer.compiling', 'Building the SynaBun helper…');
        note(t('assistant.computer.compilingBody', 'This takes about a minute the first time.'));
        break;
      case 'starting':
        spinner();
        title.textContent = t('assistant.computer.starting', 'Starting the helper…');
        break;
      case 'compile_failed': {
        title.textContent = t('assistant.computer.compileFailed', 'The helper failed to build');
        if (info.logTail) { const pre = el('pre', 'asst-computer-log', info.logTail); pre.tabIndex = 0; body.appendChild(pre); }
        button(t('assistant.computer.retry', 'Retry'), 'primary', () => runStep('start'), 'start');
        break;
      }
      case 'needs_permissions': {
        title.textContent = t('assistant.computer.needsPermissions', 'Allow SynaBun to see and control the screen');
        const rows = el('div', 'asst-computer-perms');
        const perm = (key, label, granted, pane, requestStep) => {
          const row = el('div', 'asst-computer-perm');
          row.dataset.perm = key;
          row.dataset.granted = granted ? '1' : '0';
          row.innerHTML = `<span class="asst-computer-perm-state" aria-hidden="true"></span><span class="asst-computer-perm-label">${escHtml(label)}</span><span class="asst-computer-perm-status">${escHtml(granted ? t('assistant.computer.granted', 'Allowed') : t('assistant.computer.missing', 'Not allowed'))}</span>`;
          if (!granted) {
            const open = el('button', 'asst-btn asst-btn-secondary asst-computer-open-settings', t('assistant.computer.openSettings', 'Open Settings'));
            open.type = 'button';
            open.dataset.pane = pane;
            open.addEventListener('click', () => runStep('open_settings', { pane }));
            const req = el('button', 'asst-btn asst-btn-secondary asst-computer-request', t('assistant.computer.request', 'Request'));
            req.type = 'button';
            req.dataset.step = requestStep;
            req.addEventListener('click', () => runStep(requestStep));
            row.append(req, open);
          }
          rows.appendChild(row);
        };
        perm('screen', t('assistant.computer.screenRecording', 'Screen Recording'), info.screen.granted, 'screen', 'request_screen');
        perm('accessibility', t('assistant.computer.accessibility', 'Accessibility'), info.accessibility.granted, 'accessibility', 'request_accessibility');
        body.appendChild(rows);
        if (info.appName) note(t('assistant.computer.permissionsFor', 'Grant access to {app} in System Settings → Privacy & Security.', { app: info.appName }));
        button(t('assistant.computer.checkAgain', 'Check again'), 'secondary', () => runStep('recheck'), 'recheck');
        break;
      }
      case 'needs_relaunch':
        title.textContent = t('assistant.computer.needsRelaunch', 'Restart needed');
        note(t('assistant.computer.needsRelaunchBody', 'Quit and reopen {app}, then restart SynaBun.', { app: info.appName || t('assistant.computer.theApp', 'the app that runs SynaBun') }));
        button(t('assistant.computer.checkAgain', 'Check again'), 'secondary', () => runStep('recheck'), 'recheck');
        break;
      default:
        title.textContent = t('assistant.computer.setupStart', 'Set up computer use');
        button(t('assistant.computer.setupStartBtn', 'Set up'), 'primary', () => runStep('start'), 'start');
    }
    if (state.error || info.error) body.appendChild(el('div', 'asst-computer-tray-error', state.error || info.error));
    if (actions.children.length) tray.appendChild(actions);
    root.appendChild(tray);
  }

  async function runStep(step, extra = {}) {
    if (state.busyStep) return;
    state.busyStep = step;
    state.error = '';
    render();
    try {
      const next = await desktopSetup(step, extra);
      if (next && typeof next === 'object' && (next.setup || next.permissions || 'supported' in next)) applyStatus(next);
    } catch (err) {
      state.error = err?.message || String(err);
    } finally {
      state.busyStep = '';
      render();
    }
  }

  function applyStatus(status) {
    if (!status || typeof status !== 'object') return;
    state.status = status;
    state.info = computerSetupState(status);
    if (status.control && typeof status.control === 'object') {
      const c = status.control;
      if (c.stopped?.latched) state.desktop = { ...(state.desktop || {}), state: 'stopped', active: false };
      else if (c.active && !state.desktop) state.desktop = { state: 'acting', active: true, owner: c.owner || null };
      else if (!c.active && state.desktop?.active) state.desktop = { ...state.desktop, state: 'idle', active: false };
    }
    try { hooks.onStatus?.(status, state.info); } catch { /* listener error */ }
    render();
  }

  async function refresh() {
    try {
      const status = await getDesktopStatus();
      if (!state.destroyed) applyStatus(status);
      return status;
    } catch (err) {
      if (!state.destroyed) { state.error = ''; render(); }
      throw err;
    }
  }

  function syncPolling() {
    const need = state.view === 'tray' && !state.destroyed;
    if (need && !state.pollTimer) {
      state.pollTimer = setInterval(() => {
        if (document.hidden) return;
        refresh().catch(() => {});
      }, POLL_MS);
    } else if (!need && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function applyDesktop(ev) {
    if (!ev || typeof ev !== 'object') return;
    state.desktop = { ...(state.desktop || {}), ...ev };
    if (ev.state === 'stopped' && state.status?.control?.stopped) state.status.control.stopped.latched = true;
    render();
  }

  function applySetup(ev) {
    if (!ev || typeof ev !== 'object') return;
    const merged = { ...(state.status || {}), setup: ev.setup || state.status?.setup, permissions: ev.permissions || state.status?.permissions };
    if ('supported' in ev) merged.supported = ev.supported;
    applyStatus(merged);
  }

  function stop(reason = 'ui') {
    return requestDesktopStop({ scope: 'all', reason });
  }

  render();
  return {
    el: root,
    refresh,
    applyStatus,
    applyDesktop,
    applySetup,
    render,
    stop,
    isActive: desktopActive,
    status: () => state.status,
    info: () => state.info,
    destroy() {
      state.destroyed = true;
      if (state.pollTimer) clearInterval(state.pollTimer);
      if (state.thumbTimer) clearTimeout(state.thumbTimer);
      root.remove();
    },
  };
}

// ── Frame lightbox (body level) ─────────────────────────────────────────────

let _lightbox = null;

export function closeFrameLightbox() {
  if (!_lightbox) return;
  const { overlay, onKey, returnFocus } = _lightbox;
  _lightbox = null;
  document.removeEventListener('keydown', onKey, true);
  overlay.remove();
  if (returnFocus?.isConnected) { try { returnFocus.focus({ preventScroll: true }); } catch { /* ignore */ } }
}

/** Show a screenshot at up to 92vw × 86vh with the click marker. Esc / outside / close dismiss. */
export function openFrameLightbox({ src, marker = null, caption = '', t, returnFocus = null } = {}) {
  if (!src) return null;
  closeFrameLightbox();
  const tr = tf(t);
  const overlay = el('div', 'asst-lightbox');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', caption || tr('assistant.computer.frame', 'Screenshot'));
  overlay.innerHTML = `
    <figure class="asst-lightbox-figure">
      <div class="asst-lightbox-frame"><img class="asst-lightbox-img" alt="${escAttr(caption || tr('assistant.computer.frame', 'Screenshot'))}"><span class="asst-frame-marker" hidden></span></div>
      ${caption ? `<figcaption class="asst-lightbox-caption">${escHtml(caption)}</figcaption>` : ''}
    </figure>
    <button type="button" class="asst-iconbtn asst-lightbox-close" aria-label="${escAttr(tr('common.close', 'Close'))}">${ICON_X}</button>`;
  const img = overlay.querySelector('.asst-lightbox-img');
  img.src = src;
  const mark = overlay.querySelector('.asst-frame-marker');
  if (marker && Number.isFinite(marker.x) && Number.isFinite(marker.y)) {
    mark.style.left = `${marker.x}%`;
    mark.style.top = `${marker.y}%`;
    mark.hidden = false;
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFrameLightbox(); return; }
    if (e.key === 'Tab') { e.preventDefault(); overlay.querySelector('.asst-lightbox-close')?.focus(); return; }
    e.stopPropagation();
  };
  overlay.addEventListener('mousedown', (e) => { if (!e.target.closest('.asst-lightbox-frame') && !e.target.closest('.asst-lightbox-close')) closeFrameLightbox(); });
  overlay.querySelector('.asst-lightbox-close').addEventListener('click', () => closeFrameLightbox());
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  _lightbox = { overlay, onKey, returnFocus };
  try { overlay.querySelector('.asst-lightbox-close').focus({ preventScroll: true }); } catch { /* ignore */ }
  return { el: overlay, close: closeFrameLightbox };
}

function escHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(value) {
  return escHtml(value).replace(/"/g, '&quot;');
}
