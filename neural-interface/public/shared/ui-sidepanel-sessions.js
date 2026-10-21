import { storage } from './storage.js';
import { state, emit } from './state.js';
import { hostedSidepanelId } from './ui-sidepanel-runtime.js';
import { registerSidepanel, setSidepanelVisible, focusSidepanel, detachSidepanel, getSidepanelPresentation, sendToFocusedSession } from './ui-sidepanel-windows.js';
import { getProviderMeta } from './provider-icons.js';
import { normalizeSessionWindowStatus } from './sidepanel-session-status.js';
import { savedTabsStatus } from './ui-sidepanel-tray.js';

let manifestKey;
const PROVIDERS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
// provider-icons.js ids: the window's pill wears its provider's icon and colour.
const PROVIDER_IDS = { claude: 'claude-code', codex: 'codex', opencode: 'opencode' };
const STATUS_WORDS = { working: 'working', action: 'needs you' };
const entries = new Map();
const editorOwners = new Map();
let initialized = false;

function save() {
  storage.setItem(manifestKey, JSON.stringify([...entries.values()].map(({ id, provider, title, defaults }) => ({ id, provider, title, defaults }))));
}

function storageFor(id) {
  // Session lists/registries share one live cache. Unscoped defaults and legacy
  // session pointers belong to the individual document, never another session.
  const scoped = key => /^(synabun-(claude|codex)-panel-(session|thread|title|project|model|effort|autoaccept|default-model|permission-mode)|opencode-v2-project)$/.test(key);
  const keyFor = key => scoped(key) ? `synabun-session-pref-${id}:${key}` : key;
  return {
    getItem(key) {
      const value = storage.getItem(keyFor(key));
      if (value != null || !scoped(key)) return value;
      if (/-(session|thread|title)$/.test(key)) return null;
      return storage.getItem(key);
    },
    setItem: (key, value) => storage.setItem(keyFor(key), value),
    removeItem: key => storage.removeItem(keyFor(key)),
    keys: () => storage.keys(),
  };
}

function pillFor(entry) {
  if (entry.pill) return entry.pill;
  const tray = document.getElementById('term-minimized-tray');
  if (!tray) return null;
  const pill = document.createElement('div');
  pill.className = 'term-minimized-pill sp-session-pill';
  pill.dataset.sessionWindow = entry.id;
  const meta = getProviderMeta(PROVIDER_IDS[entry.provider]);
  pill.style.setProperty('--sp-pill-color', meta.color);
  const icon = document.createElement('span');
  icon.className = 'term-minimized-pill-icon';
  icon.innerHTML = meta.icon; // provider-icons.js's own SVG
  const label = document.createElement('span');
  label.className = 'term-minimized-pill-label';
  const close = document.createElement('button');
  close.className = 'term-minimized-pill-close';
  close.textContent = '×';
  close.title = 'End detached session';
  close.addEventListener('click', event => { event.stopPropagation(); end(entry).catch(showError.bind(null, entry)); });
  pill.append(icon, label, close);
  pill.addEventListener('click', () => show(entry));
  tray.append(pill);
  entry.pill = pill;
  return pill;
}

function renderPill(entry) {
  const pill = pillFor(entry);
  if (!pill) return;
  const name = entry.title || `${PROVIDERS[entry.provider]} session`;
  pill.querySelector('.term-minimized-pill-label').textContent = name;
  // Visible session pills also act as a window switcher when windows overlap.
  pill.classList.toggle('active', !!getSidepanelPresentation(entry.id)?.visible);
  // What its sessions do, as the window's own tray pills say it (ui-sidepanel-session-entry.js): working
  // like a tray pill, or needing you (a session in it waits on an answer).
  const status = normalizeSessionWindowStatus(entry.status);
  pill.classList.toggle('sp-pill-running', status === 'working');
  pill.classList.toggle('sp-pill-attention', status === 'action');
  pill.dataset.status = status;
  pill.title = STATUS_WORDS[status] ? `${name} · ${STATUS_WORDS[status]}` : name;
}

function showError(entry, error) {
  if (entry.loading) entry.loading.textContent = `Could not open session: ${error?.message || error}`;
}

/** The window and its session's frame, made once. Whether it shows is setSidepanelVisible's: show(). */
function mount(entry) {
  if (!entry.element) {
    const element = document.createElement('section');
    element.className = 'sp-session-window';
    element.id = entry.id;
    const header = document.createElement('div');
    header.className = 'sp-session-header';
    const label = document.createElement('span');
    label.className = 'sp-session-title';
    label.textContent = entry.title || `${PROVIDERS[entry.provider]} session`;
    const actions = document.createElement('div');
    actions.className = 'sp-session-actions';
    for (const [text, title, action] of [
      ['+', 'New detached session', () => open(entry.provider, entry.api?.defaults() || entry.defaults)],
      ['−', 'Minimize session', () => setSidepanelVisible(entry.id, false)],
      ['×', 'End session', () => end(entry).catch(showError.bind(null, entry))],
    ]) {
      const button = document.createElement('button');
      button.className = 'sp-session-button';
      button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
      button.textContent = text; button.addEventListener('click', action); actions.append(button);
    }
    header.append(label, actions);
    const loading = document.createElement('div');
    loading.className = 'sp-session-loading'; loading.textContent = 'Opening session…';
    const frame = document.createElement('iframe');
    frame.dataset.sidepanelSession = entry.id;
    frame.title = `${PROVIDERS[entry.provider]} session`;
    frame.allow = 'clipboard-read; clipboard-write; microphone';
    element.append(header, loading, frame);
    document.body.append(element);
    Object.assign(entry, { element, label, loading, frame });
    entry.unregister = registerSidepanel({ owner: entry.id, layoutKey: entry.id, provider: entry.provider,
      element, header, actions, buttonClass: 'sp-session-button', applyVisibility: () => renderPill(entry) });
    if (!storage.getItem(`synabun-sidepanel-layout-${entry.id}`)) detachSidepanel(entry.id);
    // A language the page address forces (?lang=, showcase captures) holds in the session's frame too.
    const lang = new URLSearchParams(window.location.search).get('lang');
    frame.src = `/sidepanel-session.html?provider=${entry.provider}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`;
  }
}

function show(entry) {
  mount(entry);
  setSidepanelVisible(entry.id, true);
}

function open(provider, defaults = {}) {
  if (!PROVIDERS[provider]) return;
  const id = `session-${crypto.randomUUID()}`;
  const entry = { id, provider, title: `${PROVIDERS[provider]} session`, defaults: { project: String(defaults.project || '') } };
  entries.set(id, entry);
  const seed = { activeIdx: 0, tabs: [{ id: `${id}-tab`, project: entry.defaults.project, label: 'New chat', title: 'New session' }] };
  if (provider === 'opencode') storage.setItem(`opencode-v2-tabs-${id}`, '[]');
  else storage.setItem(`synabun-${provider}-panel-tabs-${id}`, JSON.stringify(seed));
  const scoped = storageFor(id);
  scoped.setItem(provider === 'opencode' ? 'opencode-v2-project' : `synabun-${provider}-panel-project`, entry.defaults.project);
  save();
  show(entry);
  return id;
}

async function end(entry) {
  if (entry.ending) return;
  entry.ending = true;
  try {
    if (entry.api) await entry.api.end();
    else if (!entry.element) {
      // A restored, unopened window may still own a server-side turn.
      const raw = storage.getItem(`synabun-${entry.provider}-panel-tabs-${entry.id}`);
      const sessions = entry.provider === 'opencode'
        ? JSON.parse(storage.getItem(`opencode-v2-tabs-${entry.id}`) || '[]').map(sessionId => ({ sessionId }))
        : JSON.parse(raw || '{"tabs":[]}').tabs;
      for (const session of sessions) {
        await fetch('/api/sidepanel/kill-session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: entry.provider, windowId: entry.id,
            sessionId: session.sessionId || session.id, threadId: session.threadId }) });
      }
    }
    entry.unregister?.(); entry.element?.remove(); entry.pill?.remove();
    entries.delete(entry.id);
    for (const key of storage.keys()) {
      if (key.endsWith(`-${entry.id}`) || key.startsWith(`synabun-session-pref-${entry.id}:`)) storage.removeItem(key);
    }
    save();
  } finally { entry.ending = false; }
}

export function initDetachedAgentSessions() {
  if (initialized || hostedSidepanelId) return;
  initialized = true;
  let windowId = sessionStorage.getItem('synabun-session-panels-window');
  if (!windowId) { windowId = crypto.randomUUID(); sessionStorage.setItem('synabun-session-panels-window', windowId); }
  manifestKey = `synabun-detached-sessions-${windowId}`;
  const style = document.createElement('style');
  style.textContent = `
    .sp-session-window { position:fixed; top:68px; right:20px; bottom:20px; width:460px;
      display:flex; flex-direction:column; background:#121214; border:1px solid #ffffff18;
      border-radius:16px; box-shadow:0 12px 40px #0008; }
    .sp-session-header { display:flex; align-items:center; gap:6px; padding:8px; flex-shrink:0;
      cursor:grab; touch-action:none; color:#cbd5e1; font:11px 'JetBrains Mono',monospace; }
    .sp-session-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sp-session-actions { display:flex; gap:3px; }
    .sp-session-button { display:inline-flex; justify-content:center; align-items:center; width:25px;
      height:25px; padding:0; border:0; border-radius:8px; background:#ffffff08; color:#a1a1aa; cursor:pointer; }
    .sp-session-button:hover { color:white; background:#ffffff18; }
    .sp-session-window iframe { border:0; width:100%; flex:1; min-height:0; border-radius:0 0 15px 15px; }
    .sp-session-loading { padding:12px; font:12px sans-serif; color:#cbd5e1; }
    .sp-session-pill .term-minimized-pill-icon { color: color-mix(in srgb, var(--sp-pill-color, #fff) 45%, transparent); transition: color .2s; }
    .sp-session-pill.sp-pill-running { border-color: color-mix(in srgb, var(--sp-pill-color, #fff) 42%, transparent); }
    .sp-session-pill.sp-pill-running .term-minimized-pill-icon { color: var(--sp-pill-color, #fff); }
    .sp-session-pill.sp-pill-running .term-minimized-pill-label::before { content: ''; display: inline-block; width: 6px;
      height: 6px; margin-right: 6px; border-radius: 50%; background: var(--sp-pill-color, #fff); vertical-align: middle;
      animation: sp-pill-pulse 1.2s ease-in-out infinite; }
    .sp-session-pill.sp-pill-attention { border-color: color-mix(in srgb, var(--accent-orange, #FFB74D) 42%, transparent); }
    .sp-session-pill.sp-pill-attention .term-minimized-pill-icon { color: var(--accent-orange, #FFB74D); }
    @keyframes sp-pill-pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
    .sp-session-pill.active { border-color:#3b82f680; }
  `;
  document.head.append(style);
  window.__synabunSessionPanels = {
    storage, storageFor, open, has: id => entries.has(id),
    focus: id => focusSidepanel(id), hide: id => setSidepanelVisible(id, false),
    ready(id, api) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.api = api; entry.loading.hidden = true;
      for (const [kind, data] of entry.pendingInputs || []) api.receive(kind, data);
      entry.pendingInputs = [];
      if (getSidepanelPresentation(id)?.visible && state.lastActiveSidepanel === id) api.focus();
    },
    title(id, title) {
      const entry = entries.get(id);
      if (!entry) return;
      const next = `${PROVIDERS[entry.provider]} · ${title || 'New session'}`;
      if (entry.title === next) return;
      entry.title = next; if (entry.label) entry.label.textContent = next; renderPill(entry); save();
    },
    fail: (id, error) => { const entry = entries.get(id); if (entry) showError(entry, error); },
    // What the window's sessions do, sent by the window when it changes (sidepanel-session-status.js).
    status(id, status) {
      const entry = entries.get(id);
      if (!entry) return;
      const next = normalizeSessionWindowStatus(status);
      if (entry.status === next) return;
      entry.status = next;
      renderPill(entry);
    },
    send(id, kind, data) {
      const entry = entries.get(id);
      if (!entry) return;
      if (entry.api) entry.api.receive(kind, data);
      else (entry.pendingInputs ||= []).push([kind, data]);
    },
    emitFromSession: (id, event, data) => emit(event, { ...data, sidepanelWindowId: id }),
    routeEvent(event, data) {
      if (event === 'wb:send-to-panel') return sendToFocusedSession('image', data);
      const type = event.includes('changelog') ? 'changelog' : 'plan';
      if (event === 'open-plan-editor' || event === 'open-changelog-editor') editorOwners.set(type, data?.sidepanelWindowId || null);
      if (['plan-saved', 'plan-edit-cancelled', 'plan-editor-state', 'changelog-saved', 'changelog-edit-cancelled'].includes(event)) {
        // A new editor can open before the old one emits cancel. Explicit
        // ownership keeps that cancel and dirty/save events in the old session.
        const owner = Object.hasOwn(data || {}, 'sidepanelWindowId')
          ? data.sidepanelWindowId : editorOwners.get(type);
        if (owner) {
          entries.get(owner)?.api?.receive(event, data);
          if (event !== 'plan-editor-state' && editorOwners.get(type) === owner) editorOwners.delete(type);
          return true;
        }
      }
      return false;
    },
  };
  try {
    for (const record of JSON.parse(storage.getItem(manifestKey) || '[]')) {
      if (!/^session-[a-f0-9-]+$/.test(record.id) || !PROVIDERS[record.provider]) continue;
      entries.set(record.id, record);
      // A window whose session was working, or waiting on the user, when the page went away (its saved tabs say
      // so, read as the tray's placeholders read them) says it at once, and its panel loads, hidden, to say what
      // the session does now.
      const saved = savedTabsStatus(record.provider, record.id);
      if (saved !== 'idle') {
        record.status = saved;
        try { mount(record); } catch (error) { console.warn('[sidepanel-sessions] could not load a working window', error); }
      }
      renderPill(record);
    }
  } catch { /* Missing or invalid saved manifest starts with no extra windows. */ }
}
