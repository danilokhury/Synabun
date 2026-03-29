// ═══════════════════════════════════════════
// SynaBun Neural Interface — Notification Engine
// Shared notification system for CLI terminal + Claude Panel
// ═══════════════════════════════════════════

import { KEYS } from './constants.js';
import { storage } from './storage.js';
import { emit } from './state.js';

// ── Sound presets ──
// Each preset defines tones for 'action' and 'done' events
const SOUND_PRESETS = {
  beep: {
    action: [{ freq: 880, dur: 0.12, volMul: 0.35 }, { freq: 880, dur: 0.12, volMul: 0.35, delay: 180 }],
    done:   [{ freq: 660, dur: 0.18, volMul: 0.25 }],
    ask:    [{ freq: 600, dur: 0.15, volMul: 0.30 }, { freq: 750, dur: 0.15, volMul: 0.30, delay: 200 }],
    error:  [{ freq: 300, dur: 0.25, volMul: 0.35 }, { freq: 250, dur: 0.30, volMul: 0.35, delay: 300 }],
  },
  chime: {
    action: [{ freq: 784, dur: 0.15, volMul: 0.30 }, { freq: 1047, dur: 0.20, volMul: 0.25, delay: 160 }],
    done:   [{ freq: 523, dur: 0.12, volMul: 0.20 }, { freq: 659, dur: 0.12, volMul: 0.20, delay: 140 }, { freq: 784, dur: 0.18, volMul: 0.18, delay: 280 }],
    ask:    [{ freq: 659, dur: 0.15, volMul: 0.25 }, { freq: 784, dur: 0.18, volMul: 0.22, delay: 180 }],
    error:  [{ freq: 392, dur: 0.20, volMul: 0.30 }, { freq: 330, dur: 0.25, volMul: 0.30, delay: 250 }],
  },
  ping: {
    action: [{ freq: 1200, dur: 0.08, volMul: 0.25 }, { freq: 1200, dur: 0.08, volMul: 0.25, delay: 120 }],
    done:   [{ freq: 1000, dur: 0.10, volMul: 0.20 }],
    ask:    [{ freq: 900, dur: 0.10, volMul: 0.22 }, { freq: 1100, dur: 0.10, volMul: 0.22, delay: 150 }],
    error:  [{ freq: 400, dur: 0.15, volMul: 0.28 }, { freq: 350, dur: 0.18, volMul: 0.28, delay: 200 }],
  },
  subtle: {
    action: [{ freq: 600, dur: 0.10, volMul: 0.15 }],
    done:   [{ freq: 500, dur: 0.12, volMul: 0.12 }],
    ask:    [{ freq: 550, dur: 0.10, volMul: 0.13 }],
    error:  [{ freq: 350, dur: 0.15, volMul: 0.15 }],
  },
};

// ── Notification types ──
export const NOTIF_TYPE = {
  DONE:   'done',
  ACTION: 'action',
  ASK:    'ask',
  ERROR:  'error',
};

// ── Audio context (lazy-init) ──
let _audioCtx = null;

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

// ── Settings readers ──

export function getNotifSettings() {
  return {
    enabled:       storage.getItem(KEYS.TERMINAL_NOTIFICATIONS) !== 'off',
    sound:         storage.getItem(KEYS.NOTIF_SOUND) !== 'off',
    volume:        parseInt(storage.getItem(KEYS.NOTIF_SOUND_VOLUME) || '50', 10) / 100,
    soundType:     storage.getItem(KEYS.NOTIF_SOUND_TYPE) || 'beep',
    banner:        storage.getItem(KEYS.NOTIF_BANNER) !== 'off',
    bannerFocused: storage.getItem(KEYS.NOTIF_BANNER_FOCUSED) === 'on',
    sourceCli:     storage.getItem(KEYS.NOTIF_SOURCE_CLI) !== 'off',
    sourcePanel:   storage.getItem(KEYS.NOTIF_SOURCE_PANEL) !== 'off',
    triggerDone:   storage.getItem(KEYS.NOTIF_TRIGGER_DONE) !== 'off',
    triggerAction: storage.getItem(KEYS.NOTIF_TRIGGER_ACTION) !== 'off',
    triggerAsk:    storage.getItem(KEYS.NOTIF_TRIGGER_ASK) !== 'off',
    triggerError:  storage.getItem(KEYS.NOTIF_TRIGGER_ERROR) !== 'off',
    toast:         storage.getItem(KEYS.NOTIF_TOAST) !== 'off',
    toastDuration: parseInt(storage.getItem(KEYS.NOTIF_TOAST_DURATION) || '5', 10),
    toastPosition: storage.getItem(KEYS.NOTIF_TOAST_POSITION) || 'top-right',
    // Legacy compat
    actionOnly:    storage.getItem(KEYS.NOTIF_ACTION_ONLY) === 'on',
  };
}

// ── Sound playback ──

export function playNotifSound(type = NOTIF_TYPE.DONE) {
  const s = getNotifSettings();
  if (!s.enabled || !s.sound) return;
  const preset = SOUND_PRESETS[s.soundType] || SOUND_PRESETS.beep;
  const tones = preset[type] || preset.done;
  for (const t of tones) {
    const vol = s.volume * t.volMul;
    if (t.delay) {
      setTimeout(() => _playTone(t.freq, t.dur, vol), t.delay);
    } else {
      _playTone(t.freq, t.dur, vol);
    }
  }
}

/** Play a specific preset+type for the test buttons in settings */
export function playTestSound(presetName, type = NOTIF_TYPE.ACTION) {
  const vol = parseInt(storage.getItem(KEYS.NOTIF_SOUND_VOLUME) || '50', 10) / 100;
  const preset = SOUND_PRESETS[presetName] || SOUND_PRESETS.beep;
  const tones = preset[type] || preset.action;
  for (const t of tones) {
    const v = vol * t.volMul;
    if (t.delay) {
      setTimeout(() => _playTone(t.freq, t.dur, v), t.delay);
    } else {
      _playTone(t.freq, t.dur, v);
    }
  }
}

// ── Banner (OS) notifications via service worker ──

function _sendBanner(title, body, tag, routing) {
  const sw = navigator.serviceWorker?.controller;
  if (sw) {
    sw.postMessage({ type: 'SHOW_NOTIFICATION', title, body, tag, routing });
  } else if (navigator.serviceWorker?.ready) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(title, { body, tag, silent: true, data: routing });
    });
  }
}

// ── In-app toast notifications ──

const _TOAST_ICONS = {
  done:   '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8.5l2 2 3.5-4"/></svg>',
  action: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5"/><circle cx="8" cy="11" r="0.5" fill="currentColor"/></svg>',
  ask:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M6.5 6.5a1.5 1.5 0 013 0c0 1-1.5 1.2-1.5 2.5"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor"/></svg>',
  error:  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M10 6L6 10M6 6l4 4"/></svg>',
};

const _TOAST_ACCENTS = {
  done:   'rgba(255,255,255,0.18)',
  action: 'rgba(220,180,100,0.50)',
  ask:    'rgba(140,170,220,0.45)',
  error:  'rgba(200,120,120,0.50)',
};

const _TOAST_TITLES = {
  done:   'Task Complete',
  action: 'Action Required',
  ask:    'Question',
  error:  'Error',
};

let _toastContainer = null;
const MAX_TOASTS = 3;

function _ensureToastContainer(position) {
  if (_toastContainer && document.body.contains(_toastContainer)) {
    // Update position class if changed
    const posClass = `pos-${position || 'top-right'}`;
    if (!_toastContainer.classList.contains(posClass)) {
      _toastContainer.className = '';
      _toastContainer.id = 'notif-toast-container';
      _toastContainer.classList.add(posClass);
    }
    return _toastContainer;
  }
  _toastContainer = document.createElement('div');
  _toastContainer.id = 'notif-toast-container';
  _toastContainer.classList.add(`pos-${position || 'top-right'}`);
  document.body.appendChild(_toastContainer);
  return _toastContainer;
}

function _showToast(type, title, body, source, opts) {
  const s = getNotifSettings();
  if (!s.toast) return;
  const container = _ensureToastContainer(s.toastPosition);
  const accent = _TOAST_ACCENTS[type] || _TOAST_ACCENTS.done;
  const icon = _TOAST_ICONS[type] || _TOAST_ICONS.done;

  const toast = document.createElement('div');
  toast.className = 'notif-toast';
  toast.style.setProperty('--notif-accent', accent);
  toast.innerHTML = `
    <div class="notif-toast-accent"></div>
    <div class="notif-toast-icon">${icon}</div>
    <div class="notif-toast-body">
      <div class="notif-toast-title">${title}</div>
      <div class="notif-toast-msg">${body}</div>
      <div class="notif-toast-source">${source === 'panel' ? 'Side Panel' : 'CLI Terminal'}</div>
    </div>
    <button class="notif-toast-close">&times;</button>
  `;

  // Click toast body → show the source panel/terminal (with session/tab specificity)
  toast.addEventListener('click', (e) => {
    if (e.target.closest('.notif-toast-close')) return;
    const event = source === 'panel' ? 'claude-panel:show' : 'terminal:show';
    emit(event, { sessionId: opts?.sessionId, tabId: opts?.tabId });
    _dismissToast(toast);
  });

  // Dismiss on close button
  toast.querySelector('.notif-toast-close').addEventListener('click', () => _dismissToast(toast));

  // Add to container
  container.appendChild(toast);
  // Trigger animation
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));

  // Auto-dismiss
  const dur = s.toastDuration * 1000;
  toast._timeout = setTimeout(() => _dismissToast(toast), dur);

  // Enforce max toasts
  const toasts = container.querySelectorAll('.notif-toast');
  if (toasts.length > MAX_TOASTS) {
    _dismissToast(toasts[0]);
  }
}

function _dismissToast(toast) {
  if (toast._dismissed) return;
  toast._dismissed = true;
  if (toast._timeout) clearTimeout(toast._timeout);
  toast.classList.remove('visible');
  toast.classList.add('dismissing');
  setTimeout(() => toast.remove(), 300);
}

// ── Main notification dispatcher ──
// source: 'cli' | 'panel'
// type: NOTIF_TYPE value
// label: session label for the notification body

export function notify(source, type, label, opts) {
  const s = getNotifSettings();
  if (!s.enabled) return;

  // Source filter
  if (source === 'cli' && !s.sourceCli) return;
  if (source === 'panel' && !s.sourcePanel) return;

  // Trigger filter
  if (type === NOTIF_TYPE.DONE && !s.triggerDone) return;
  if (type === NOTIF_TYPE.ACTION && !s.triggerAction) return;
  if (type === NOTIF_TYPE.ASK && !s.triggerAsk) return;
  if (type === NOTIF_TYPE.ERROR && !s.triggerError) return;

  // Legacy: if actionOnly is enabled, only notify on ACTION (overrides granular triggers)
  if (s.actionOnly && type !== NOTIF_TYPE.ACTION) return;

  const title = _TOAST_TITLES[type] || 'Notification';
  const body = label || 'Claude Code';

  // Sound
  if (s.sound) playNotifSound(type);

  // In-app toast
  _showToast(type, title, body, source, opts);

  // OS banner (only when tab hidden, unless bannerFocused)
  if (s.banner && Notification.permission === 'granted') {
    if (document.hidden || s.bannerFocused) {
      _sendBanner(title, body, `synabun-${source}-${Date.now()}`, { source, ...opts });
    }
  }
}

// ── OS banner click routing (service worker → client) ──

if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'NOTIFICATION_CLICK') return;
    const { source, sessionId, tabId } = e.data;
    const event = source === 'panel' ? 'claude-panel:show' : 'terminal:show';
    emit(event, { sessionId, tabId });
  });
}

// ── Exports for settings test buttons ──
export { _sendBanner as sendTestBanner, SOUND_PRESETS };
