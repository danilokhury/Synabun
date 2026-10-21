// SynaBun Neural Interface — the Schedules window.
// A rail of views (Up next, All, Needs attention, Paused, Timers, Activity) and of groups, one
// list of schedules with their details on demand, and the editors in place of the list. What a
// view lists and how a schedule's state reads is decided in schedules-view.js (DOM-free).

import { emit, on } from './state.js';
import { storage } from './storage.js';
import { KEYS } from './constants.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
import { registerLaunchPrefetch } from './launch-prefetch.js';
import { sendToPanel } from './ui-claude-panel.js';
import { getProviderMeta } from './provider-icons.js';
import {
  getNativeLoopRouterClaimToken,
  getNativeLoopRouterWindowId,
} from './ui-native-loop-router.js';
import {
  CLI_PROFILES,
  ensureModelsForProfile,
  fetchMcpProfilePresets,
  fetchCodexAccounts,
  getCachedCodexAccounts,
  getCachedMcpProfilePresets,
  getEffortLevelsForProfile,
  getModelsForProfile,
  formatModelOptionLabel,
  isDynamicModelProfile,
  modelSelectorValue,
  modelMatchesSelector,
  normalizeEffortForProfile,
  profileSupportsEffort,
} from './agent-runtime-options.js';
import {
  automationContextOptions,
  automationModelOptions,
  normalizeAutomationSelection,
} from './automation-context.js';
import {
  fetchLoopTemplates,
  fetchSchedules,
  fetchSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  testSchedule,
  startScheduleTimer,
  cancelScheduleTimer,
  fetchScheduleTimers,
  fetchScheduleGroups,
  createScheduleGroup,
  updateScheduleGroup,
  deleteScheduleGroup,
  reorderScheduleGroups,
  createQuickTimer,
  fetchQuickTimers,
  cancelQuickTimer,
  triggerQuickTimerNow,
} from './api.js';
import {
  LIST_SCOPES,
  SORTS,
  VIEW_SCOPES,
  dayLabel,
  describeCron,
  formatAgo,
  formatCountdown,
  groupIdOf,
  groupSummary,
  inScope,
  lastRunState,
  launchFacts,
  listJoin,
  matchesQuery,
  oneLine,
  scopeCounts,
  shortWhen,
  sortSchedules,
  whenLabel,
} from './schedules-view.js';
import {
  closeDropdowns,
  controlOf,
  dropdownHTML,
  setDropdownItems,
  setDropdownValue,
  wireDropdowns,
} from './cc-dropdown.js';

const $ = (id) => document.getElementById(id);
const PANEL_ID = 'schedules-studio-panel';
const POLL_INTERVAL = 1000;
const LAYOUT_KEY = KEYS.PANEL_PREFIX + 'schedules-window';
const SCOPE_KEY = 'sched-view-scope';
const SORT_KEY = 'sched-view-sort';
const COLLAPSED_KEY = 'sched-collapsed-groups';
const DEFAULT_GROUP_COLOR = '#4fc3f7';

let _panel = null;
let _backdrop = null;
let _abort = null;            // the window's document/window listeners
let _opener = null;           // focus goes back here when the window closes
let _templates = [];
let _schedules = [];
let _groups = [];
let _scheduleTimerData = {};
let _quickTimers = [];
let _loading = false;         // the window waits for a load (opening it, Try again)
let _pendingAction = null;    // an editor asked for before the data is there opens once it is
let _loadError = null;        // what the latest load could not fetch, as a sentence
let _loadSeq = 0;
const _loaded = { schedules: false, templates: false, groups: false }; // each list arrived once
let _timersSeq = 0;
let _timersLoaded = false;
let _timersError = null;
let _cliReport = null;        // what a group's change of CLI did to its schedules (resetSchedulesForCli)
let _frame = null;            // what the main area is built for: list, timers, activity, editor
let _scope = 'all';
let _sort = 'next';
let _query = '';
const _expanded = new Set();
const _collapsed = new Set();
let _scheduleEditor = null;   // the draft while the schedule editor is open
let _groupEditorId = null;    // the group being edited; null with a draft = a new group
let _groupEditorDraft = null;
let _confirm = null;          // { kind: 'schedule' | 'group', id, opener }
let _draggingScheduleId = null;
let _pollTimer = null;
let _refreshTimer = null;
let _lastAutoRefresh = 0;
let _selectedQtMinutes = null;
let _qtUsesBrowser = null;
let _syncReady = false;
let _promptModal = null;
let _promptBackdrop = null;
let _promptKeyHandler = null;
const _modelLoadRequests = new Set();

let _launchProfile = storage.getItem('as-launch-profile') || 'claude-code';
const _storedLaunchSelection = normalizeAutomationSelection(
  _launchProfile, storage.getItem('as-launch-model'), storage.getItem('as-launch-context-mode'),
);
let _launchModel = _storedLaunchSelection.model;
let _launchContextMode = _storedLaunchSelection.contextMode || 'default';
storage.setItem('as-launch-model', _launchModel || '');
storage.setItem('as-launch-context-mode', _launchContextMode);
let _launchEffort = storage.getItem('as-launch-effort') || 'off';
let _launchMcpProfile = storage.getItem('as-launch-mcp-profile') || 'full';
let _launchAccount = storage.getItem('as-launch-account') || 'default'; // Codex ChatGPT account (CODEX_HOME)
let _codexAccountsRequested = false; // lazy-fetch guard for account selects

const _s = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const ICONS = {
  clock: _s('<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 2.5"/>'),
  next: _s('<path d="M2.5 8h7.5"/><path d="M7 4.5 10.5 8 7 11.5"/><path d="M13.5 3.5v9"/>'),
  plus: _s('<path d="M8 3v10M3 8h10"/>'),
  bolt: _s('<path d="M9 2L4 9h4l-1 5 5-7H8l1-5z"/>'),
  edit: _s('<path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z"/>'),
  script: _s('<path d="M3.5 2h6.5l3 3v8.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"/><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3"/>'),
  close: _s('<path d="M4 4l8 8M12 4l-8 8"/>'),
  pause: _s('<path d="M5.5 3.5v9M10.5 3.5v9"/>'),
  play: _s('<path d="M5 3l8 5-8 5V3z"/>'),
  back: _s('<path d="M10 3L5 8l5 5"/>'),
  chevron: _s('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  up: _s('<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>'),
  down: _s('<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>'),
  folder: _s('<path d="M2.5 5h4l1 1.5h6v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/>'),
  list: _s('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>'),
  alert: _s('<path d="M8 2.3 14.2 13H1.8L8 2.3z"/><path d="M8 6.5v3"/><path d="M8 11.4h.01"/>'),
  timer: _s('<circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.6 1"/><path d="M6.5 2h3"/>'),
  activity: _s('<path d="M1.5 8h3l2-4.5 3 9 2-4.5h3"/>'),
  search: _s('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>'),
  trash: _s('<path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9"/>'),
  move: _s('<path d="M8 2v12M2 8h12"/><path d="M6 4 8 2l2 2M6 12l2 2 2-2M4 6 2 8l2 2M12 6l2 2-2 2"/>'),
  eye: _s('<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z"/><circle cx="8" cy="8" r="2"/>'),
  sparkle: _s('<path d="M8 2L9.2 6.8L14 8L9.2 9.2L8 14L6.8 9.2L2 8L6.8 6.8L8 2z"/>'),
  lock: _s('<rect x="4" y="7" width="8" height="7" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  ok: _s('<circle cx="8" cy="8" r="6"/><path d="M5.5 8.2 7.2 9.9 10.6 6.3"/>'),
  failed: _s('<circle cx="8" cy="8" r="6"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"/>'),
  started: _s('<circle cx="8" cy="8" r="6"/><path d="M6.9 5.7 10.3 8l-3.4 2.3z"/>'),
  stopped: _s('<circle cx="8" cy="8" r="6"/><rect x="6" y="6" width="4" height="4" rx=".5"/>'),
  never: _s('<circle cx="8" cy="8" r="6" stroke-dasharray="2.2 2.2"/>'),
};
const RESULT_ICON = { ok: ICONS.ok, failed: ICONS.failed, started: ICONS.started, stopped: ICONS.stopped, interrupted: ICONS.alert, never: ICONS.never, other: ICONS.never };

const VIEWS = {
  upcoming: { label: 'Up next', icon: ICONS.next },
  all: { label: 'All schedules', icon: ICONS.list },
  attention: { label: 'Needs attention', icon: ICONS.alert },
  paused: { label: 'Paused', icon: ICONS.pause },
  timers: { label: 'Timers', icon: ICONS.timer },
  activity: { label: 'Activity', icon: ICONS.activity },
};

const CRON_PRESET_GROUPS = [
  { group: 'Frequency', presets: [
    { label: 'Every 15 min', cron: '*/15 * * * *' },
    { label: 'Every 30 min', cron: '*/30 * * * *' },
    { label: 'Every hour', cron: '0 * * * *' },
    { label: 'Every 2 hours', cron: '0 */2 * * *' },
    { label: 'Every 6 hours', cron: '0 */6 * * *' },
  ] },
  { group: 'Daily', presets: [
    { label: '09:00', cron: '0 9 * * *' },
    { label: '12:00', cron: '0 12 * * *' },
    { label: '18:00', cron: '0 18 * * *' },
    { label: 'Twice a day', cron: '0 10,18 * * *' },
    { label: 'Three times a day', cron: '0 9,14,19 * * *' },
  ] },
  { group: 'Weekly', presets: [
    { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
    { label: 'Weekdays twice', cron: '0 10,18 * * 1-5' },
    { label: 'Weekends 10:00', cron: '0 10 * * 0,6' },
    { label: 'Mon, Wed, Fri', cron: '0 9 * * 1,3,5' },
    { label: 'Tue, Thu', cron: '0 9 * * 2,4' },
  ] },
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function readJson(key, fallback) {
  try { const value = JSON.parse(storage.getItem(key) || 'null'); return value ?? fallback; } catch { return fallback; }
}

function readScope() {
  const saved = storage.getItem(SCOPE_KEY);
  return saved && (VIEW_SCOPES.includes(saved) || saved === 'ungrouped' || saved.startsWith('group:')) ? saved : 'all';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const domId = (value) => String(value ?? '').replace(/[^\w-]/g, '_');
// A choice of a popup (cc-dropdown.js). The one shown is the last marked `selected`, else the
// first, as in a <select>: a saved value a list lacks is added as a choice of its own, marked.
const opt = (value, label, selected = false) => ({ value: value ?? '', label: String(label ?? ''), selected: !!selected });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cssColor = (value) => (value && CSS.supports('color', String(value)) ? String(value) : 'var(--stg-off)');

function showToast(msg) {
  const existing = document.querySelector('.as-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'as-toast';
  toast.setAttribute('role', 'status');
  toast.textContent = msg;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 180);
  }, 2500);
}

function getTemplate(id) {
  return _templates.find(t => t.id === id) || null;
}

function getGroup(id) {
  return _groups.find(g => g.id === id) || null;
}

function orderedGroups() {
  return _groups.map((group, index) => ({ group, index }))
    .sort((a, b) => ((a.group.order ?? a.index) - (b.group.order ?? b.index)) || (a.index - b.index))
    .map(entry => entry.group);
}

const groupIds = () => new Set(_groups.map(g => g.id));
const editorOpen = () => !!_scheduleEditor || !!_groupEditorDraft;
// Until the schedules, the automations and the groups have each loaded once, the list cannot say
// what is where and an editor could only offer less than was saved: neither is shown.
const dataIncomplete = () => !_loaded.schedules || !_loaded.templates || !_loaded.groups;
const editorsWait = () => _loading || dataIncomplete();
const countsKnown = () => !_loading && !dataIncomplete();
const listScope = () => LIST_SCOPES.includes(_scope) || _scope === 'ungrouped' || !!groupIdOf(_scope);

function formatTimerCountdown(firesAtISO) {
  const diff = new Date(firesAtISO) - Date.now();
  if (diff <= 0) return 'firing';
  const mins = Math.ceil(diff / 60_000);
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${mins}m`;
}

// ── Opening and closing ──

export function initSchedulesStudio() {
  // Launch: the lists are read once the page has painted (launch-prefetch.js), so the first open paints from them.
  registerLaunchPrefetch('schedules', () => (isGuest() && !hasPermission('automations') ? undefined : loadData()), { order: 74 });
  on('automations:open-schedules', (opts) => openPanel(opts || {}));
  on('schedules:open', (opts) => openPanel(opts || {}));
  on('schedules:toggle', () => (_panel ? closePanel() : openPanel({})));
  setupSync();
}

async function openPanel(opts = {}) {
  if (isGuest() && !hasPermission('automations')) {
    showGuestToast('Schedules are disabled by the host');
    return;
  }
  if (_panel) {
    // Rebuilt only when the request changes what shows: an open editor keeps what is typed in it.
    if (applyOpenOptions(opts)) render({ frame: true });
    focusInitial();
    return;
  }

  _opener = document.activeElement;
  // The view, order and folded groups the user left (UI state, synced like the rest).
  _scope = readScope();
  _sort = SORTS.includes(storage.getItem(SORT_KEY)) ? storage.getItem(SORT_KEY) : 'next';
  _collapsed.clear();
  for (const key of readJson(COLLAPSED_KEY, [])) if (typeof key === 'string') _collapsed.add(key);
  _backdrop = document.createElement('div');
  _backdrop.className = 'studio-backdrop sched-backdrop';
  document.body.appendChild(_backdrop);

  _panel = document.createElement('section');
  _panel.className = 'schedules-studio-panel glass resizable';
  _panel.id = PANEL_ID;
  _panel.setAttribute('role', 'region');
  _panel.setAttribute('aria-labelledby', 'sched-title');
  _panel.innerHTML = buildPanelHTML();
  document.body.appendChild(_panel);
  document.body.classList.add('schedules-window-open');
  placePanel();

  wirePanel();
  // Before the options: an editor asked for waits for the data (applyOpenOptions). Lists that arrived once (an
  // earlier open, the launch read; sync keeps them while closed) paint at once, and the load below brings them
  // up to date in place (loadFinished → refresh); only a first open shows "Loading schedules…".
  _loading = dataIncomplete();
  applyOpenOptions(opts);
  render({ frame: true });
  if (!_loading) revealExpanded(); // what loadFinished does after a first load
  emit('schedules:window', { open: true });
  startPolling();
  const panel = _panel;
  requestAnimationFrame(() => {
    if (_panel !== panel) return;
    _backdrop?.classList.add('open');
    panel.classList.add('open');
    focusInitial();
  });
  await loadData(); // loadFinished() takes it from there
}

/** Applies what an open request asks for; true when that changes what the window shows. */
function applyOpenOptions(opts = {}) {
  const before = `${_scope}|${!!_scheduleEditor}|${!!_groupEditorDraft}`;
  const fromTab = { cron: listScope() ? _scope : 'all', timers: 'timers', groups: 'all', activity: 'activity' };
  if (opts.tab && fromTab[opts.tab]) setScope(fromTab[opts.tab], { keepEditors: true });
  if (opts.scope) setScope(opts.scope, { keepEditors: true });
  if (opts.groupId) setScope(`group:${opts.groupId}`, { keepEditors: true });
  if ((opts.action === 'new-schedule' || opts.action === 'new-group') && editorsWait()) {
    // An editor is built from the automations and groups: it opens once they have loaded.
    _pendingAction = opts.action;
  } else if (opts.action === 'new-schedule') {
    closeEditors();
    _scheduleEditor = { groupId: groupIdOf(_scope) };
  } else if (opts.action === 'new-group') {
    closeEditors();
    openGroupEditor(null);
  } else if (opts.action === 'quick-timer') {
    closeEditors();
    setScope('timers');
  }
  return before !== `${_scope}|${!!_scheduleEditor}|${!!_groupEditorDraft}` || !!opts.action;
}

function placePanel() {
  const navH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--navbar-height')) || 48;
  const saved = readJson(LAYOUT_KEY, null);
  if (saved && saved.w > 0 && saved.h > 0) {
    _panel.style.width = saved.w + 'px';
    _panel.style.height = saved.h + 'px';
  }
  const width = _panel.offsetWidth;
  const height = _panel.offsetHeight;
  const left = saved && Number.isFinite(saved.x) ? saved.x : (window.innerWidth - width) / 2;
  const top = saved && Number.isFinite(saved.y) ? saved.y : navH + Math.max(8, (window.innerHeight - navH - height) / 2);
  _panel.style.left = Math.round(Math.max(8, Math.min(left, window.innerWidth - width - 8))) + 'px';
  _panel.style.top = Math.round(Math.max(navH + 8, Math.min(top, window.innerHeight - height - 8))) + 'px';
}

function saveLayout() {
  if (!_panel) return;
  const rect = _panel.getBoundingClientRect();
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify({
      x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height),
    }));
  } catch { /* the default layout is used next time */ }
}

function closePanel() {
  if (!_panel) return;
  saveLayout();
  stopPolling();
  clearTimeout(_refreshTimer);
  closePromptScheduleModal();
  _abort?.abort();
  _abort = null;
  _backdrop?.remove();
  _backdrop = null;
  _panel.remove();
  _panel = null;
  _frame = null;
  _confirm = null;
  _loading = false;
  _pendingAction = null;
  _scheduleEditor = null;
  _groupEditorId = null;
  _groupEditorDraft = null;
  _draggingScheduleId = null;
  document.body.classList.remove('schedules-window-open');
  emit('schedules:window', { open: false });
  const opener = _opener;
  _opener = null;
  if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
}

function focusInitial() {
  if (!_panel) return;
  const failed = _loadError && dataIncomplete() ? _panel.querySelector('#sched-list [data-action="retry-load"]') : null;
  const target = (_scheduleEditor && $('sched-ed-name')) || (_groupEditorDraft && $('sched-ge-name')) || failed
    || $('sched-search') || $('sched-load-note')?.querySelector('button') || $('sched-qt-template');
  controlOf(target)?.focus({ preventScroll: true });
}

function buildPanelHTML() {
  return `
    ${['t', 'r', 'b', 'l', 'tl', 'tr', 'bl', 'br'].map(edge => `<div aria-hidden="true" class="resize-handle resize-handle-${edge}" data-resize="${edge}"></div>`).join('')}
    <header class="sched-header drag-handle" data-drag="${PANEL_ID}">
      <div class="sched-header-left">
        <span class="sched-header-icon">${ICONS.clock}</span>
        <h3 id="sched-title">Schedules</h3>
        <span class="sched-count" id="sched-total-count"></span>
      </div>
      <button type="button" class="backdrop-toggle-btn" id="sched-backdrop-toggle" aria-pressed="false" aria-label="Hide the backdrop" data-tooltip="Hide the backdrop">${ICONS.eye}</button>
      <button type="button" class="sched-close" id="sched-close" aria-label="Close Schedules" data-tooltip="Close (Esc)">${ICONS.close}</button>
    </header>
    <div class="sched-body">
      <nav class="sched-rail" id="sched-rail" aria-label="Schedule views and groups"></nav>
      <section class="sched-main" aria-labelledby="sched-view-title">
        <!-- A window too narrow for the rail: its views and groups as a popup, and New group. Outside
             the frame below, which each view and editor replaces, so it is there in every one. -->
        <div class="sched-narrow-nav" id="sched-narrow-nav">
          <span class="sched-sr" id="sched-scope-label">View</span>
          ${dropdownHTML('sched-scope-select', [], { classes: 'sched-scope-select', labelledBy: 'sched-scope-label', inputAttrs: 'data-change="scope"' })}
          <button type="button" class="sched-btn" data-action="group-new" id="sched-narrow-new-group">${ICONS.plus}<span>New group</span></button>
        </div>
        <div class="sched-frame" id="sched-main"></div>
      </section>
    </div>
    <div class="sched-dialog-layer" id="sched-dialog-layer" hidden></div>
  `;
}

function wirePanel() {
  _abort = new AbortController();
  const { signal } = _abort;
  $('sched-close')?.addEventListener('click', closePanel, { signal });
  $('sched-backdrop-toggle')?.addEventListener('click', () => {
    const hidden = !!_backdrop?.classList.toggle('backdrop-hidden');
    const btn = $('sched-backdrop-toggle');
    if (!btn) return;
    btn.classList.toggle('active', hidden);
    btn.setAttribute('aria-pressed', String(hidden));
    const label = hidden ? 'Show the backdrop' : 'Hide the backdrop';
    btn.setAttribute('aria-label', label);
    btn.dataset.tooltip = label;
  }, { signal });

  _panel.addEventListener('click', handleClick, { signal });
  _panel.addEventListener('change', handleChange, { signal });
  _panel.addEventListener('input', handleInput, { signal });
  _panel.addEventListener('dragstart', handleDragStart, { signal });
  _panel.addEventListener('dragend', handleDragEnd, { signal });
  _panel.addEventListener('dragover', handleDragOver, { signal });
  _panel.addEventListener('dragleave', handleDragLeave, { signal });
  _panel.addEventListener('drop', handleDrop, { signal });
  _panel.addEventListener('keydown', handlePanelKeydown, { signal });
  // The popups (cc-dropdown.js): one set of listeners for every one the window draws.
  wireDropdowns(_panel, { signal });
  // Capture: the menubar's own Escape (it closes an open menu) has run by the time a bubbling
  // listener hears the key, so a menu that was open is seen here first.
  window.addEventListener('keydown', handleEscape, { capture: true, signal });
}

// ── Data ──
// The list and the editors are built from three lists, the schedules, the automations and the
// groups, fetched together with a deadline each. A list that fails keeps what an earlier load
// brought (sync updates keep it current), so an open editor never loses a saved choice to it.
// The timers are fetched apart: a slow answer there holds the Timers view, nothing else.

const LOAD_DEADLINE = 15_000;

/** The request, or a failure (marked `timeout`) once it has had LOAD_DEADLINE to answer. */
function withDeadline(request) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`no answer within ${LOAD_DEADLINE / 1000} seconds`);
      err.timeout = true;
      reject(err);
    }, LOAD_DEADLINE);
  });
  return Promise.race([request, late]).finally(() => clearTimeout(timer));
}

const failureReason = (result) => String(result.reason?.message || 'an unexpected answer').replace(/\.$/, '');

async function loadData() {
  const seq = ++_loadSeq;
  loadTimers();
  const [schedules, templates, groups] = await Promise.allSettled([
    withDeadline(fetchSchedules()), withDeadline(fetchLoopTemplates()), withDeadline(fetchScheduleGroups()),
  ]);
  if (seq !== _loadSeq) return; // a newer load is under way: it finishes for both
  const failed = [];
  if (schedules.status === 'fulfilled' && Array.isArray(schedules.value)) {
    _schedules = schedules.value;
    _loaded.schedules = true;
  } else failed.push(['schedules', failureReason(schedules)]);
  if (templates.status === 'fulfilled' && Array.isArray(templates.value)) {
    _templates = templates.value;
    _loaded.templates = true;
  } else failed.push(['automations', failureReason(templates)]);
  if (groups.status === 'fulfilled' && Array.isArray(groups.value)) {
    _groups = groups.value;
    _loaded.groups = true;
    if (groupIdOf(_scope) && !getGroup(groupIdOf(_scope))) setScope('all', { keepEditors: true });
  } else failed.push(['groups', failureReason(groups)]);
  _loadError = failed.length
    ? `The ${listJoin(failed.map(([what]) => what))} did not load: ${[...new Set(failed.map(([, why]) => why))].join('; ')}.`
    : null;
  loadFinished();
}

/** The one end of every load: opening the window, Try again and a live refresh all finish here. */
function loadFinished() {
  if (!_panel) return;
  const gated = _loading;
  _loading = false;
  let opened = false;
  if (_pendingAction && !dataIncomplete()) {
    const action = _pendingAction;
    _pendingAction = null;
    applyOpenOptions({ action });
    opened = true;
  }
  if (!gated && !opened) { refresh(); return; }
  const focusWasHere = document.activeElement === document.body || _panel.contains(document.activeElement)
    || document.activeElement?.id === 'menubar-schedules-btn';
  render({ frame: true });
  if (gated) revealExpanded();
  if (opened || (focusWasHere && !_panel.contains(document.activeElement))) focusInitial();
}

/** The timers waiting to fire: only the Timers view and its count read them. */
async function loadTimers() {
  const seq = ++_timersSeq;
  const [timers, quick] = await Promise.allSettled([withDeadline(fetchScheduleTimers()), withDeadline(fetchQuickTimers())]);
  if (seq !== _timersSeq) return;
  const failed = [];
  if (timers.status === 'fulfilled' && timers.value && typeof timers.value === 'object') _scheduleTimerData = timers.value;
  else failed.push(failureReason(timers));
  if (quick.status === 'fulfilled' && Array.isArray(quick.value)) _quickTimers = quick.value;
  else failed.push(failureReason(quick));
  _timersLoaded = true;
  _timersError = failed.length ? `The timers did not load: ${[...new Set(failed)].join('; ')}.` : null;
  if (!_panel) return;
  renderRail();
  renderActiveTimersInto();
}

/** Fetch again, soon (several sync events tend to arrive together). */
function scheduleRefresh(delay = 400) {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => { loadData(); }, delay);
}

function startPolling() {
  stopPolling();
  _pollTimer = setInterval(() => {
    if (!_panel) { stopPolling(); return; }
    if (document.hidden) return; // no point ticking countdowns in a hidden tab
    updateTimerCountdowns();
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = null;
}

// ── Rendering ──

function setScope(scope, { keepEditors = false } = {}) {
  _scope = scope;
  if (!keepEditors) closeEditors();
  try { storage.setItem(SCOPE_KEY, scope); } catch { /* not remembered */ }
}

function closeEditors() {
  _scheduleEditor = null;
  _groupEditorId = null;
  _groupEditorDraft = null;
}

/** Everything the window shows. `frame` rebuilds the main area's skeleton as well as its content. */
function render({ frame = false } = {}) {
  if (!_panel) return;
  const count = $('sched-total-count');
  if (count) count.textContent = countsKnown() ? String(_schedules.length) : '';
  renderRail();
  renderMain(frame);
}

/** A sync update: the editors keep what is being typed; everything else follows the data. */
function refresh() {
  if (!_panel) return;
  if (editorOpen()) {
    const count = $('sched-total-count');
    if (count) count.textContent = countsKnown() ? String(_schedules.length) : '';
    renderRail();
    return;
  }
  render();
}

function renderRail() {
  const rail = $('sched-rail');
  if (!rail) return;
  const now = Date.now();
  const counts = scopeCounts(_schedules, now);
  const timers = _quickTimers.length + Object.keys(_scheduleTimerData).length;
  const ids = groupIds();
  const view = (scope, count, { alert = false } = {}) => {
    const { label, icon } = VIEWS[scope];
    const current = _scope === scope;
    const countHTML = count == null || !countsKnown() ? '' : `<span class="sched-nav-count${alert && count ? ' sched-nav-count--alert' : ''}">${count}</span>`;
    return `<button type="button" class="sched-nav-item" data-action="set-scope" data-scope="${scope}"${current ? ' aria-current="page"' : ''}>
      <span class="sched-nav-icon">${icon}</span><span class="sched-nav-label">${label}</span>${countHTML}</button>`;
  };
  const groupRows = orderedGroups().map(group => {
    const members = _schedules.filter(s => s.groupId === group.id);
    const summary = groupSummary(members, now);
    const scope = `group:${group.id}`;
    const name = `${group.name}: ${plural(summary.total, 'schedule')}${summary.attention ? `, ${summary.attention} need attention` : ''}${group.mutualExclusion ? ', one at a time' : ''}`;
    return `<button type="button" class="sched-nav-item" data-action="set-scope" data-scope="${esc(scope)}" data-drop-group="${esc(group.id)}" aria-label="${esc(name)}"${_scope === scope ? ' aria-current="page"' : ''}>
      <span class="sched-nav-icon"><span class="sched-dot" style="--dot:${esc(cssColor(group.color))}"></span></span>
      <span class="sched-nav-label">${esc(group.name)}</span>
      ${group.mutualExclusion ? `<span class="sched-nav-flag" data-tooltip="One at a time">${ICONS.lock}</span>` : ''}
      ${summary.attention ? `<span class="sched-nav-flag sched-nav-flag--alert" data-tooltip="${esc(plural(summary.attention, 'schedule'))} need attention">${ICONS.alert}${summary.attention}</span>` : ''}
      <span class="sched-nav-count">${summary.total}</span>
    </button>`;
  }).join('');
  const ungrouped = _schedules.filter(s => !s.groupId || !ids.has(s.groupId)).length;

  // Redrawn on every live update: the focused item and the scroll position stay.
  const active = document.activeElement;
  const focusKey = active && rail.contains(active)
    ? (active.dataset.scope ? `[data-scope="${CSS.escape(active.dataset.scope)}"]` : active.dataset.action ? `[data-action="${active.dataset.action}"]` : null)
    : null;
  const scroll = rail.scrollTop;
  rail.innerHTML = `
    ${view('upcoming', counts.upcoming)}
    ${view('all', counts.all)}
    ${view('attention', counts.attention, { alert: true })}
    ${view('paused', counts.paused)}
    <div class="sched-rail-sep" role="presentation"></div>
    ${view('timers', timers || null)}
    ${view('activity', null)}
    <div class="sched-rail-head"><span id="sched-rail-groups">Groups</span><button type="button" class="sched-icon-btn" data-action="group-new" aria-label="New group" data-tooltip="New group"${editorsWait() ? ' disabled' : ''}>${ICONS.plus}</button></div>
    <div role="group" aria-labelledby="sched-rail-groups">
      ${groupRows || (countsKnown() ? '<div class="sched-rail-empty">No groups yet.</div>' : '')}
      <button type="button" class="sched-nav-item" data-action="set-scope" data-scope="ungrouped" data-drop-group="" aria-label="Ungrouped${countsKnown() ? `: ${esc(plural(ungrouped, 'schedule'))}` : ''}"${_scope === 'ungrouped' ? ' aria-current="page"' : ''}>
        <span class="sched-nav-icon">${ICONS.folder}</span><span class="sched-nav-label">Ungrouped</span><span class="sched-nav-count">${countsKnown() ? ungrouped : ''}</span>
      </button>
    </div>
  `;
  rail.scrollTop = scroll;
  if (focusKey) rail.querySelector(focusKey)?.focus({ preventScroll: true });
  renderNarrowNav();
}

function renderMain(rebuild = false) {
  const main = $('sched-main');
  if (!main) return;
  // An editor that is on screen gives its typed values to the draft before it is drawn again.
  if (_groupEditorDraft) {
    if (rebuild || _frame !== 'group-editor') {
      if (_frame === 'group-editor') collectGroupEditorDraft();
      renderGroupEditor(_groupEditorId ? getGroup(_groupEditorId) : null);
    }
    return;
  }
  if (_scheduleEditor) {
    if (rebuild || _frame !== 'schedule-editor') {
      if (_frame === 'schedule-editor') collectScheduleEditorDraft();
      renderScheduleEditor();
    }
    return;
  }
  if (_scope === 'timers') {
    if (rebuild || _frame !== 'timers') renderTimersView();
    else { renderNote(); renderActiveTimersInto(); }
    return;
  }
  const frame = _scope === 'activity' ? 'activity' : 'list';
  if (rebuild || _frame !== frame) buildListFrame(frame);
  renderViewHead();
  if (frame === 'activity') renderActivityList();
  else renderList();
}

function buildListFrame(frame) {
  const main = $('sched-main');
  _frame = frame;
  const activity = frame === 'activity';
  // A rebuild (the data arriving, a view switch) must not drop a search being typed.
  const search = document.activeElement?.id === 'sched-search' ? document.activeElement : null;
  const caret = search ? [search.selectionStart, search.selectionEnd] : null;
  main.innerHTML = `
    <div class="sched-view-head" id="sched-view-head"></div>
    <div class="sched-toolbar">
      <div class="sched-search">
        ${ICONS.search}
        <label class="sched-sr" for="sched-search">${activity ? 'Search runs' : 'Search schedules'}</label>
        <input id="sched-search" type="search" autocomplete="off" spellcheck="false"
          placeholder="${activity ? 'Search runs by schedule or automation…' : 'Search by name, automation, group or time…'}" value="${esc(_query)}">
        <button type="button" class="sched-icon-btn" data-action="clear-search" aria-label="Clear search"${_query ? '' : ' hidden'}>${ICONS.close}</button>
        <kbd aria-hidden="true">/</kbd>
      </div>
      ${activity ? '' : `<span class="sched-sort" id="sched-sort-wrap"><span class="sched-sr" id="sched-sort-label">Order</span>
      ${dropdownHTML('sched-sort', [
        opt('next', 'Next run first', _sort === 'next'),
        opt('name', 'Name', _sort === 'name'),
        opt('last', 'Last run first', _sort === 'last'),
      ], { labelledBy: 'sched-sort-label', inputAttrs: 'data-change="sort"' })}</span>`}
    </div>
    <div class="sched-load-note" id="sched-load-note" role="status"></div>
    <div class="sched-list" id="sched-list" tabindex="-1"></div>
    <footer class="sched-footer">
      <span id="sched-status" role="status" aria-live="polite" aria-atomic="true"></span>
      ${activity ? '' : `<span class="sched-footer-hint">${ICONS.move}Drag a schedule onto a group in the sidebar to move it</span>`}
    </footer>
  `;
  if (caret) {
    const input = $('sched-search');
    input?.focus({ preventScroll: true });
    try { input?.setSelectionRange(caret[0], caret[1]); } catch { /* type=search keeps its caret */ }
  }
}

function headActions({ group = null } = {}) {
  // An editor needs the automations and groups: nothing opens one before they have loaded.
  const wait = editorsWait() ? ' disabled' : '';
  return `<div class="sched-view-actions">
    ${group ? `<button type="button" class="sched-btn" data-action="group-edit" data-id="${esc(group.id)}"${wait}>${ICONS.edit}<span>Edit group</span></button>` : ''}
    <button type="button" class="sched-btn sched-btn--text" data-action="schedule-prompt" data-tooltip="Describe the schedule to Claude Code in a side panel">${ICONS.sparkle}<span>Prompt a schedule</span></button>
    <button type="button" class="sched-btn sched-btn--primary" data-action="schedule-new"${wait}>${ICONS.plus}<span>New schedule</span></button>
  </div>`;
}

function groupOverridesText(group) {
  const parts = [];
  if (group.profile) parts.push(CLI_PROFILES.find(c => c.id === group.profile)?.label || group.profile);
  if (group.model) parts.push(group.model);
  if (group.contextMode && group.contextMode !== 'default') parts.push(`context ${group.contextMode}`);
  if (group.effort) parts.push(`thinking ${group.effort}`);
  if (group.mcpProfile) parts.push(`MCP ${group.mcpProfile}`);
  if (group.usesBrowser === true) parts.push('browser on');
  else if (group.usesBrowser === false) parts.push('browser off');
  return parts.join(' · ');
}

function renderViewHead() {
  const head = $('sched-view-head');
  if (!head) return;
  const now = Date.now();
  const counts = scopeCounts(_schedules, now);
  let title = VIEWS[_scope]?.label || 'Schedules';
  let dot = '';
  let sub = '';
  let meta = '';
  let group = null;
  if (_scope === 'all') {
    sub = `${plural(counts.all, 'schedule')} · ${counts.active} active · ${counts.paused} paused${counts.attention ? ` · ${counts.attention} need attention` : ''}`;
  } else if (_scope === 'upcoming') {
    // One row per schedule, at its next run (a schedule that runs three times today is listed once).
    sub = counts.upcoming
      ? `${counts.upcoming === 1 ? '1 schedule runs' : `${counts.upcoming} schedules run`} in the next 24 hours, each at its next run, soonest first.`
      : 'Nothing runs in the next 24 hours.';
  } else if (_scope === 'attention') {
    sub = 'Active schedules whose last run failed or that are late. Open one to see why.';
  } else if (_scope === 'paused') {
    sub = 'Paused schedules keep their settings. Turn one on to put it back on its timetable.';
  } else if (_scope === 'activity') {
    sub = 'The latest run of each schedule, newest first. Open one to see its schedule.';
  } else if (_scope === 'ungrouped') {
    title = 'Ungrouped';
    sub = 'Schedules in no group. Drag one onto a group in the sidebar to file it.';
  } else if (groupIdOf(_scope)) {
    group = getGroup(groupIdOf(_scope));
    if (group) {
      title = group.name;
      dot = `<span class="sched-dot" style="--dot:${esc(cssColor(group.color))}" aria-hidden="true"></span>`;
      const summary = groupSummary(_schedules.filter(s => s.groupId === group.id), now);
      sub = `${plural(summary.total, 'schedule')} · ${summary.active} active · ${summary.paused} paused${summary.attention ? ` · ${summary.attention} need attention` : ''}${group.mutualExclusion ? ' · One at a time' : ''}`;
      const overrides = groupOverridesText(group);
      if (overrides) meta = `<p class="sched-view-meta sched-group-overrides">Group launch settings: ${esc(overrides)}</p>`;
    }
  }
  if (_loading) sub = 'Loading schedules…';
  else if (dataIncomplete()) sub = '';
  // A live update changes counts, not the head's controls: keep them (and the focus on them).
  const key = `${_scope}|${title}|${dot}|${meta}|${editorsWait()}`;
  if (head.dataset.key === key) {
    const subEl = head.querySelector('.sched-view-sub');
    if (subEl && subEl.textContent !== sub) subEl.textContent = sub;
  } else {
    head.dataset.key = key;
    head.innerHTML = `
      <div class="sched-view-titles">
        <h2 id="sched-view-title">${dot}${esc(title)}</h2>
        <p class="sched-view-sub">${esc(sub)}</p>
        ${meta}
      </div>
      ${headActions({ group })}
    `;
  }
}

/** The rail as a popup with its counts, and New group, for a window too narrow to show the rail. */
function renderNarrowNav() {
  const scope = $('sched-scope-select');
  if (scope) {
    const counts = scopeCounts(_schedules, Date.now());
    const timers = _quickTimers.length + Object.keys(_scheduleTimerData).length;
    const n = (value) => (!countsKnown() || !value && value !== 0 ? '' : ` (${value})`);
    const views = [['upcoming', counts.upcoming], ['all', counts.all], ['attention', counts.attention], ['paused', counts.paused], ['timers', timers || null], ['activity', null]]
      .map(([id, count]) => opt(id, `${VIEWS[id].label}${n(count)}`));
    const groups = orderedGroups().map(g => opt(`group:${g.id}`, `${g.name}${n(_schedules.filter(s => s.groupId === g.id).length)}`));
    const entries = [{ group: 'Views', options: views }, { group: 'Groups', options: [...groups, opt('ungrouped', 'Ungrouped')] }];
    // Redrawn only when it changes (an open popup stays open, its highlighted choice too).
    const key = JSON.stringify(entries);
    if (scope._key !== key) { setDropdownItems(scope, entries); scope._key = key; }
    setDropdownValue(scope, _scope);
  }
  const newGroup = $('sched-narrow-new-group');
  if (newGroup) newGroup.disabled = editorsWait();
}

function setStatus(text) {
  const status = $('sched-status');
  if (status) status.textContent = text;
}

/**
 * The line above the list. A load that failed: without every list, the list views show the
 * failure in place of the list; with an earlier copy of each, this line says so above the copy
 * (and in Timers, which has none). Otherwise, on a group's page, what its change of CLI did to
 * its schedules, until dismissed.
 */
function renderNote() {
  const note = $('sched-load-note');
  if (!note) return;
  const listView = _frame === 'list' || _frame === 'activity';
  const failed = _loading || !_loadError || (listView && dataIncomplete()) ? ''
    : dataIncomplete() ? _loadError : `${_loadError} Showing what loaded before.`;
  const report = !failed && _frame === 'list' ? cliReportNote() : null;
  const kind = failed ? 'load' : report?.kind || '';
  const text = failed || report?.text || '';
  const key = `${kind}|${text}`;
  if (note.dataset.key === key) return; // unchanged: a live update does not announce it again
  note.dataset.key = key;
  note.classList.toggle('sched-load-note--ok', kind === 'ok');
  note.classList.toggle('sched-load-note--busy', kind === 'busy');
  const icon = kind === 'ok' ? ICONS.ok : kind === 'busy' ? ICONS.clock : ICONS.alert;
  const action = kind === 'load' ? '<button type="button" class="sched-btn" data-action="retry-load">Try again</button>'
    : kind === 'busy' ? '' : '<button type="button" class="sched-btn" data-action="dismiss-report">Dismiss</button>';
  note.innerHTML = text ? `${icon}<span>${esc(text)}</span>${action}` : '';
}

/** What the last change of a group's CLI did to its schedules, for that group's page. */
function cliReportNote() {
  const r = _cliReport;
  if (!r || _scope !== `group:${r.groupId}`) return null;
  if (r.pending) return { kind: 'busy', text: "Clearing the old CLI's settings from the group's schedules…" };
  const cli = r.profile ? CLI_PROFILES.find(p => p.id === r.profile)?.label || r.profile : null;
  const kept = r.changed.length + r.failed.length;
  const its = (list) => (list.length === 1 ? 'its' : 'their');
  const parts = [cli ? `The group now runs ${cli}.` : 'The group no longer sets a CLI.'];
  if (r.reset.length) parts.push(`Cleared the old CLI's settings on ${listJoin(r.reset)}.`);
  else if (!kept) parts.push('None of its schedules had settings of the old CLI left.');
  if (r.changed.length) parts.push(`${listJoin(r.changed)} changed meanwhile and kept ${its(r.changed)} settings.`);
  if (r.failed.length) parts.push(`${listJoin(r.failed)} could not be checked or updated and kept ${its(r.failed)} settings.`);
  if (kept) parts.push(`Open ${kept === 1 ? 'it' : 'them'} to choose ${kept === 1 ? 'its' : 'their'} settings.`);
  return { kind: kept ? 'warn' : 'ok', text: parts.join(' ') };
}

function loadFailedHTML() {
  const waiting = _pendingAction ? ` The ${_pendingAction === 'new-group' ? 'new group' : 'new schedule'} opens once they load.` : '';
  return emptyState(ICONS.alert, 'Schedules could not be loaded', `${_loadError || 'Not everything loaded.'}${waiting}`,
    '<button type="button" class="sched-btn" data-action="retry-load">Try again</button>');
}

/** Keep the place: scroll position and the focused control survive a re-render of the list. */
function captureListState(list) {
  const active = document.activeElement;
  const inside = active && list.contains(active);
  return {
    scroll: list.scrollTop,
    focus: inside ? {
      id: active.id || null,
      scheduleId: active.closest('[data-schedule-id]')?.dataset.scheduleId || null,
      groupId: active.closest('[data-group-section]')?.dataset.groupSection || null,
      action: active.dataset.action || active.dataset.change || null,
    } : null,
  };
}

function restoreListState(list, saved) {
  list.scrollTop = saved.scroll;
  const f = saved.focus;
  if (!f) return;
  let target = f.id ? document.getElementById(f.id) : null;
  if (!target && f.scheduleId) {
    const row = [...list.querySelectorAll('[data-schedule-id]')].find(el => el.dataset.scheduleId === f.scheduleId);
    target = row && f.action ? controlOf(row.querySelector(`[data-action="${f.action}"], [data-change="${f.action}"]`)) : row?.querySelector('.sched-row-toggle');
  }
  if (!target && f.groupId) {
    const section = [...list.querySelectorAll('[data-group-section]')].find(el => el.dataset.groupSection === f.groupId);
    target = section?.querySelector(`[data-action="${f.action}"]`) || section?.querySelector('.sched-group-toggle');
  }
  target?.focus({ preventScroll: true });
}

function scheduleExtras(s) {
  return [getTemplate(s.templateId)?.name, getGroup(s.groupId)?.name];
}

function visibleSchedules() {
  const now = Date.now();
  const ids = groupIds();
  return _schedules.filter(s => inScope(s, _scope, { now, groupIds: ids }) && matchesQuery(s, _query, scheduleExtras(s)));
}

function renderList() {
  const list = $('sched-list');
  if (!list) return;
  const saved = captureListState(list);
  const clear = _panel?.querySelector('[data-action="clear-search"]');
  if (clear) clear.hidden = !_query;
  // Up next is in time order by definition: no order to choose there.
  const sortWrap = $('sched-sort-wrap');
  if (sortWrap) sortWrap.hidden = _scope === 'upcoming';
  renderNote();

  if (_loading) {
    list.innerHTML = emptyState(ICONS.clock, 'Loading schedules…', '');
    setStatus('Loading…');
    return;
  }
  if (dataIncomplete()) {
    list.innerHTML = loadFailedHTML();
    setStatus('Not loaded');
    return;
  }

  const now = Date.now();
  const shown = visibleSchedules();
  const scopeTotal = _schedules.filter(s => inScope(s, _scope, { now, groupIds: groupIds() })).length;
  if (!_schedules.length) {
    list.innerHTML = emptyState(ICONS.clock, 'No schedules yet', 'A schedule launches one of your automations on a timetable.',
      `<button type="button" class="sched-btn sched-btn--primary" data-action="schedule-new">${ICONS.plus}<span>New schedule</span></button>
       <button type="button" class="sched-btn" data-action="schedule-prompt">${ICONS.sparkle}<span>Prompt a schedule</span></button>`);
  } else if (!shown.length && _query.trim()) {
    const elsewhere = _scope !== 'all' && _schedules.some(s => matchesQuery(s, _query, scheduleExtras(s)));
    list.innerHTML = emptyState(ICONS.search, `No schedules match “${_query.trim()}”`,
      elsewhere ? 'Some do in other views.' : 'Try another word, or clear the search.',
      `<button type="button" class="sched-btn" data-action="clear-search">Clear search</button>
       ${elsewhere ? '<button type="button" class="sched-btn" data-action="search-all">Search all schedules</button>' : ''}`);
  } else if (!shown.length) {
    list.innerHTML = scopeEmptyState();
  } else if (_scope === 'all') {
    list.innerHTML = renderGroupedList(shown, now);
  } else if (_scope === 'upcoming') {
    list.innerHTML = renderUpcomingList(shown, now);
  } else {
    const rows = sortSchedules(shown, _sort).map(s => rowHTML(s, { now, showGroup: !groupIdOf(_scope) })).join('');
    list.innerHTML = `<div class="sched-box"><ul class="sched-rows" aria-label="${esc(VIEWS[_scope]?.label || 'Schedules')}">${rows}</ul></div>`;
  }
  setStatus(_query.trim() ? `${plural(shown.length, 'schedule')} match “${_query.trim()}”` : `Showing ${shown.length} of ${plural(scopeTotal, 'schedule')}`);
  restoreListState(list, saved);
}

function emptyState(icon, title, text, actions = '') {
  return `<div class="sched-empty">
    <div class="sched-empty-icon">${icon}</div>
    <h3>${esc(title)}</h3>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${actions ? `<div class="sched-empty-actions">${actions}</div>` : ''}
  </div>`;
}

function scopeEmptyState() {
  if (_scope === 'attention') return emptyState(ICONS.ok, 'Nothing needs attention', 'The last run of every active schedule worked, and none is late.');
  if (_scope === 'paused') return emptyState(ICONS.pause, 'No paused schedules', 'Every schedule is on its timetable.');
  if (_scope === 'upcoming') return emptyState(ICONS.next, 'Nothing runs in the next 24 hours', 'Active schedules show here once their next run is less than a day away.');
  if (_scope === 'ungrouped') return emptyState(ICONS.folder, 'Every schedule is in a group', '');
  return emptyState(ICONS.folder, 'No schedules in this group yet', 'Drag one onto the group in the sidebar, or create one here.',
    `<button type="button" class="sched-btn sched-btn--primary" data-action="schedule-new">${ICONS.plus}<span>New schedule</span></button>`);
}

/** All schedules: one box per group, in the groups' order, then the ungrouped ones. */
function renderGroupedList(shown, now) {
  const ids = groupIds();
  const sections = orderedGroups().map(group => ({ group, items: shown.filter(s => s.groupId === group.id) }));
  sections.push({ group: null, items: shown.filter(s => !s.groupId || !ids.has(s.groupId)) });
  return sections.filter(section => section.items.length).map(({ group, items }) => {
    const key = group ? group.id : '__ungrouped';
    const collapsed = !_query.trim() && _collapsed.has(key);
    const listId = `sched-rows-${domId(key)}`;
    const all = group ? _schedules.filter(s => s.groupId === group.id) : items;
    const summary = groupSummary(all, now);
    const meta = [
      summary.attention ? `<span class="is-alert">${ICONS.alert} ${summary.attention} need attention</span>` : '',
      summary.paused ? `<span>${summary.paused} paused</span>` : '',
      group?.mutualExclusion ? `<span>${ICONS.lock} One at a time</span>` : '',
    ].filter(Boolean).join('<span aria-hidden="true">·</span>');
    const name = group ? group.name : 'Ungrouped';
    return `<section class="sched-box${collapsed ? ' is-collapsed' : ''}" data-group-section="${esc(key)}">
      <div class="sched-group-head" data-drop-group="${group ? esc(group.id) : ''}">
        <button type="button" class="sched-group-toggle" data-action="group-collapse" data-key="${esc(key)}" aria-expanded="${!collapsed}" aria-controls="${listId}">
          <span class="sched-group-chevron">${ICONS.chevron}</span>
          ${group ? `<span class="sched-dot" style="--dot:${esc(cssColor(group.color))}" aria-hidden="true"></span>` : `<span class="sched-nav-icon">${ICONS.folder}</span>`}
          <span class="sched-group-name">${esc(name)}</span>
          <span class="sched-group-count">${items.length === all.length ? items.length : `${items.length} of ${all.length}`}</span>
        </button>
        ${meta ? `<span class="sched-group-meta">${meta}</span>` : ''}
        ${group ? `<button type="button" class="sched-icon-btn" data-action="group-edit" data-id="${esc(group.id)}" aria-label="Edit group ${esc(name)}" data-tooltip="Edit group">${ICONS.edit}</button>` : ''}
      </div>
      <ul class="sched-rows" id="${listId}" aria-label="${esc(name)}"${collapsed ? ' hidden' : ''}>
        ${sortSchedules(items, _sort).map(s => rowHTML(s, { now, showGroup: false })).join('')}
      </ul>
    </section>`;
  }).join('');
}

/** Up next: the runs of the coming day in time order, under Today / Tomorrow. */
function renderUpcomingList(shown, now) {
  const ordered = sortSchedules(shown, 'next');
  const days = new Map();
  for (const s of ordered) {
    const label = dayLabel(s.nextRun, now) || 'Later';
    if (!days.has(label)) days.set(label, []);
    days.get(label).push(s);
  }
  return [...days.entries()].map(([label, items], i) => `
    <section class="sched-section" aria-labelledby="sched-day-${i}">
      <h3 class="sched-section-title" id="sched-day-${i}">${esc(label)}<span>${plural(items.length, 'schedule')}</span></h3>
      <div class="sched-box"><ul class="sched-rows">${items.map(s => rowHTML(s, { now, showGroup: true })).join('')}</ul></div>
    </section>`).join('');
}

function nextRunHTML(s, now) {
  if (!s.enabled) return '<span class="sched-next" data-state="paused"><span class="sched-next-rel">Paused</span></span>';
  const countdown = formatCountdown(s.nextRun, now);
  const when = s.nextRun ? whenLabel(s.nextRun, now) : '';
  return `<span class="sched-next" data-state="${countdown.state}" data-countdown="${esc(s.nextRun || '')}"${when ? ` title="${esc(when)}"` : ''}>
    <span class="sched-next-rel">${esc(countdown.text)}</span>${s.nextRun ? `<span class="sched-next-abs">${esc(shortWhen(s.nextRun, now))}</span>` : ''}</span>`;
}

function lastRunHTML(s, now, run = lastRunState(s), { ago: withAgo = true } = {}) {
  const ago = withAgo && s.lastRun ? formatAgo(s.lastRun, now) : '';
  const title = s.lastRun ? new Date(s.lastRun).toLocaleString() : '';
  return `<span class="sched-last" data-kind="${run.kind}"${title ? ` title="${esc(title)}"` : ''}>
    <span class="sched-last-word">${RESULT_ICON[run.kind] || ICONS.never}<span>${esc(run.label)}</span></span>${ago ? `<span class="sched-last-ago">${esc(ago)}</span>` : ''}</span>`;
}

function rowHTML(s, { now = Date.now(), showGroup = false } = {}) {
  const run = lastRunState(s);
  const failing = run.kind === 'failed';
  const open = _expanded.has(s.id);
  const group = getGroup(s.groupId);
  const detailId = `sched-detail-${domId(s.id)}`;
  const groupBit = showGroup && group
    ? `<span class="sched-row-group"><span class="sched-dot" style="--dot:${esc(cssColor(group.color))}" aria-hidden="true"></span>${esc(group.name)}</span>`
    : '';
  // The summary line drags (onto a group); the details stay selectable, an error message copyable.
  return `<li class="sched-row${s.enabled ? '' : ' is-paused'}${failing ? ' is-failing' : ''}${open ? ' is-open' : ''}" data-schedule-id="${esc(s.id)}">
    <div class="sched-row-line" data-action="schedule-expand" data-id="${esc(s.id)}" draggable="true">
      <span class="sched-switch-cell">
        <button type="button" class="sched-switch" role="switch" aria-checked="${!!s.enabled}" data-action="schedule-toggle" data-id="${esc(s.id)}"
          aria-label="Run ${esc(s.name)} on schedule" data-tooltip="${s.enabled ? 'Pause' : 'Resume'}"></button>
      </span>
      <button type="button" class="sched-row-toggle" data-action="schedule-expand" data-id="${esc(s.id)}" aria-expanded="${open}"${open ? ` aria-controls="${detailId}"` : ''}>
        <span class="sched-row-name">${esc(s.name)}</span>
        <span class="sched-row-sub">${groupBit}${groupBit ? '<span aria-hidden="true">·</span>' : ''}<span>${esc(describeCron(s.cron))}</span></span>
        ${failing ? `<span class="sched-row-reason">${esc(oneLine(run.reason))}</span>` : ''}
      </button>
      ${nextRunHTML(s, now)}
      ${lastRunHTML(s, now, run)}
      <span class="sched-row-chevron" aria-hidden="true">${ICONS.chevron}</span>
    </div>
    ${open ? `<div class="sched-detail" id="${detailId}">${detailHTML(s, now, run)}</div>` : ''}
  </li>`;
}

function detailHTML(s, now, run) {
  const template = getTemplate(s.templateId);
  const group = getGroup(s.groupId);
  const presets = getCachedMcpProfilePresets();
  const mcpLabels = Object.fromEntries(Object.entries(presets).map(([id, p]) => [id, p.label || id]));
  const facts = launchFacts(s, { group, template, profiles: CLI_PROFILES, mcpLabels });
  const sourceNote = (source) => (source === 'group' ? ' <span class="sched-source">(group)</span>'
    : source === 'automation' ? ' <span class="sched-source">(automation)</span>'
      : source === 'default' ? ' <span class="sched-source">(default)</span>' : '');
  const next = s.enabled
    ? (s.nextRun ? `${esc(whenLabel(s.nextRun, now))} · <span data-countdown="${esc(s.nextRun)}">${esc(formatCountdown(s.nextRun, now).text)}</span>` : 'Not scheduled')
    : 'Paused';
  const last = run.kind === 'never' ? 'Not run yet'
    : `<span class="${run.kind === 'failed' ? 'is-failed' : ''}">${esc(run.label)}</span>${s.lastRun ? ` · ${esc(whenLabel(s.lastRun, now))}` : ''}`;
  // Any entry counts: with day themes, the server runs a schedule only on the days that have one.
  const themes = [1, 2, 3, 4, 5, 6, 0].filter(d => s.dayThemes?.[String(d)]).map(d => DAY_NAMES[d]);
  const groupOptions = [
    opt('', 'Ungrouped', !s.groupId),
    ...orderedGroups().map(g => opt(g.id, g.name, s.groupId === g.id)),
  ];
  const fact = (label, value, cls = '') => `<div class="sched-fact"><dt>${esc(label)}</dt><dd${cls ? ` class="${cls}"` : ''}>${value}</dd></div>`;
  return `
    <div class="sched-detail-grid">
      <section class="sched-facts-block">
      <h4 class="sched-facts-title">Runs</h4>
      <dl class="sched-facts">
        ${fact('Automation', template ? esc(template.name) : '<span class="is-failed">Missing automation</span>')}
        ${fact('Timetable', `${esc(describeCron(s.cron))} <span class="sched-source">(${esc(s.cron || '')})</span>`)}
        ${fact('Next run', next)}
        ${fact('Last run', last)}
        ${run.reason ? fact(run.kind === 'failed' ? 'Error' : 'Detail', esc(oneLine(run.reason))) : ''}
        ${fact('Runs so far', esc(String(s.runCount || 0)))}
        ${fact('Time zone', esc(s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone))}
        ${themes.length ? fact('Day themes', `${esc(themes.join(', '))} <span class="sched-source">(runs on these days only)</span>`) : ''}
      </dl>
      </section>
      <section class="sched-facts-block">
      <h4 class="sched-facts-title">Launch settings</h4>
      <dl class="sched-facts">
        ${facts.map(f => fact(f.label, `${esc(f.value)}${sourceNote(f.source)}`, f.mono ? 'sched-mono' : '')).join('')}
      </dl>
      </section>
    </div>
    <div class="sched-detail-bar">
      <div class="sched-detail-group"><span aria-hidden="true">Group</span>
        ${dropdownHTML(`sched-move-${domId(s.id)}`, groupOptions, { label: `Group of ${s.name}`, inputAttrs: `data-change="move-group" data-id="${esc(s.id)}"` })}
      </div>
      <span class="sched-detail-spacer"></span>
      <button type="button" class="sched-btn" data-action="schedule-test" data-id="${esc(s.id)}" data-tooltip="Start one run now; the timetable is unchanged">${ICONS.bolt}<span>Run now</span></button>
      <button type="button" class="sched-btn" data-action="schedule-edit-prompt" data-id="${esc(s.id)}" data-template-id="${esc(s.templateId || '')}" data-tooltip="Open its automation in Automation Studio">${ICONS.script}<span>Edit prompt</span></button>
      <button type="button" class="sched-btn" data-action="schedule-edit" data-id="${esc(s.id)}">${ICONS.edit}<span>Edit schedule</span></button>
      <button type="button" class="sched-btn sched-btn--danger" data-action="schedule-delete" data-id="${esc(s.id)}">${ICONS.trash}<span>Delete…</span></button>
    </div>`;
}

function renderActivityList() {
  const list = $('sched-list');
  if (!list) return;
  const saved = captureListState(list);
  const clear = _panel?.querySelector('[data-action="clear-search"]');
  if (clear) clear.hidden = !_query;
  renderNote();
  if (_loading || dataIncomplete()) {
    list.innerHTML = _loading ? emptyState(ICONS.clock, 'Loading schedules…', '') : loadFailedHTML();
    return;
  }
  const now = Date.now();
  const ran = _schedules.filter(s => s.lastRun);
  const shown = sortSchedules(ran.filter(s => matchesQuery(s, _query, scheduleExtras(s))), 'last');
  if (!shown.length) {
    list.innerHTML = _query.trim()
      ? emptyState(ICONS.search, `No runs match “${_query.trim()}”`, 'Try another word, or clear the search.', '<button type="button" class="sched-btn" data-action="clear-search">Clear search</button>')
      : emptyState(ICONS.activity, 'No runs yet', 'Each schedule\'s latest run shows here once it has run.');
    setStatus(_query.trim() ? 'No matches' : 'No runs yet');
    restoreListState(list, saved);
    return;
  }
  list.innerHTML = `<div class="sched-box"><ul class="sched-rows sched-rows--activity" aria-label="Latest runs">${shown.map(s => {
    const run = lastRunState(s);
    const template = getTemplate(s.templateId);
    const sub = run.kind === 'failed' && run.reason ? oneLine(run.reason) : template?.name || 'Missing automation';
    const next = s.enabled ? formatCountdown(s.nextRun, now).text : 'Paused';
    return `<li class="sched-row" data-schedule-id="${esc(s.id)}">
      <button type="button" class="sched-activity-btn" data-action="reveal-schedule" data-id="${esc(s.id)}" aria-label="${esc(`${s.name}: ${run.label} ${formatAgo(s.lastRun, now)}. Show it in All schedules`)}">
        ${lastRunHTML(s, now, run, { ago: false })}
        <span class="sched-activity-main"><span class="sched-row-name">${esc(s.name)}</span><span class="sched-row-sub"><span>${esc(sub)}</span></span></span>
        <span class="sched-activity-when"><span>${esc(formatAgo(s.lastRun, now))}</span><span>${esc(whenLabel(s.lastRun, now))}</span></span>
        <span class="sched-activity-when sched-activity-next"><span>${s.enabled ? 'Next' : ''}</span><span>${esc(next)}</span></span>
        <span class="sched-row-chevron" aria-hidden="true">${ICONS.chevron}</span>
      </button>
    </li>`;
  }).join('')}</ul></div>`;
  setStatus(`${plural(shown.length, 'run')}${_query.trim() ? ` match “${_query.trim()}”` : ''}`);
  restoreListState(list, saved);
}

/** After a reopen, the schedule that was open shows again. */
function revealExpanded() {
  const id = [..._expanded].at(-1);
  if (!id) return;
  const row = [..._panel.querySelectorAll('.sched-row')].find(el => el.dataset.scheduleId === id);
  row?.scrollIntoView({ block: 'nearest' });
}

function revealSchedule(id) {
  const schedule = _schedules.find(s => s.id === id);
  if (!schedule) return;
  _query = '';
  setScope('all');
  if (schedule.groupId) _collapsed.delete(schedule.groupId);
  _expanded.add(id);
  render({ frame: true });
  const row = [..._panel.querySelectorAll('.sched-row')].find(el => el.dataset.scheduleId === id);
  row?.scrollIntoView({ block: 'center' });
  row?.querySelector('.sched-row-toggle')?.focus({ preventScroll: true });
}

// ── Timers ──

function renderTimersView() {
  const main = $('sched-main');
  if (!main) return;
  _frame = 'timers';
  const selectedTemplate = $('sched-qt-template')?.value || '';
  const customMinutes = $('sched-qt-custom-min')?.value || '';
  const selectedSchedule = $('sched-existing-timer-schedule')?.value || '';
  const scheduleMinutes = $('sched-existing-timer-min')?.value || '';
  const templateOptions = [opt('', 'Choose an automation…'), ..._templates.map(t => opt(t.id, t.name, selectedTemplate === t.id))];
  const scheduleOptions = [opt('', 'Choose a schedule…'), ...sortSchedules(_schedules, 'name').map(s => opt(s.id, s.name, selectedSchedule === s.id))];
  const profileOptions = CLI_PROFILES.map(p => opt(p.id, p.label, p.id === _launchProfile));
  const modelOptions = renderModelOptions(_launchProfile, _launchModel, { accountId: _launchAccount });
  const contextOptions = renderContextOptions(_launchProfile, _launchModel, _launchContextMode, { accountId: _launchAccount });
  const effortOptions = renderEffortOptions(_launchProfile, _launchEffort);
  const mcpOptions = renderMcpOptions(_launchMcpProfile);
  const accountOptions = renderAccountOptions(_launchAccount, false);
  const showEffort = profileSupportsEffort(_launchProfile);
  const showMcp = _launchProfile !== 'claude-code';
  const showAccount = _launchProfile === 'codex';
  const usesBrowser = _qtUsesBrowser !== null ? _qtUsesBrowser : !!getTemplate(selectedTemplate)?.usesBrowser;
  const qtPresetButtons = [5, 15, 30, 60, 120, 240]
    .map(min => `<button type="button" class="sched-chip" data-action="qt-select" data-minutes="${min}" aria-pressed="${_selectedQtMinutes === min}">${min >= 60 ? `${min / 60} h` : `${min} min`}</button>`)
    .join('');

  const modelLoadKey = `${_launchProfile}:${_launchAccount}`;
  if (isDynamicModelProfile(_launchProfile) && !_modelLoadRequests.has(modelLoadKey)) {
    _modelLoadRequests.add(modelLoadKey);
    ensureModelsForProfile(_launchProfile, false, _launchAccount).then(() => { if (_panel && _frame === 'timers') renderTimersView(); });
  }
  if (showAccount) ensureCodexAccountsLoaded(() => { if (_panel && _frame === 'timers') renderTimersView(); });
  if (showMcp && !Object.keys(getCachedMcpProfilePresets()).length) {
    fetchMcpProfilePresets().then(() => { if (_panel && _frame === 'timers') renderTimersView(); });
  }

  main.innerHTML = `
    <div class="sched-view-head">
      <div class="sched-view-titles">
        <h2 id="sched-view-title">Timers</h2>
        <p class="sched-view-sub">Run an automation, or a saved schedule, once after a delay.</p>
      </div>
    </div>
    <div class="sched-load-note" id="sched-load-note" role="status"></div>
    <div class="sched-editor-body">
      <div class="sched-form">
        <section class="sched-form-section" aria-labelledby="sched-timers-active-title">
          <h3 class="sched-form-title" id="sched-timers-active-title">Waiting to run</h3>
          <div id="sched-active-timers"></div>
        </section>
        <section class="sched-form-section" aria-labelledby="sched-qt-title">
          <h3 class="sched-form-title" id="sched-qt-title">Run an automation once</h3>
          <div class="sched-form-group">
            ${dropdownRow('sched-qt-template', 'Automation', templateOptions)}
            ${dropdownRow('sched-qt-profile', 'CLI', profileOptions)}
            ${dropdownRow('sched-qt-model', 'Model', modelOptions)}
            ${dropdownRow('sched-qt-context', 'Context', contextOptions)}
            ${dropdownRow('sched-qt-effort', 'Thinking', effortOptions, { hidden: !showEffort })}
            ${dropdownRow('sched-qt-mcp', 'MCP tools', mcpOptions, { hidden: !showMcp })}
            ${dropdownRow('sched-qt-account', 'OpenAI account', accountOptions, { hidden: !showAccount, rowId: 'sched-qt-account-field' })}
            ${formRow('sched-qt-browser', 'Uses the browser', toggleHTML('sched-qt-browser', usesBrowser), { toggle: true })}
            ${formRow('sched-qt-custom-min', 'Start in', `<span class="sched-chip-list" role="group" aria-label="Delay">${qtPresetButtons}</span>
              <input class="sched-input" id="sched-qt-custom-min" type="number" min="1" max="1440" value="${esc(customMinutes)}" placeholder="min" aria-label="Minutes from now">`, { top: true })}
          </div>
          <div class="sched-form-actions">
            <button type="button" class="sched-btn" data-action="qt-now">${ICONS.bolt}<span>Run now</span></button>
            <button type="button" class="sched-btn sched-btn--primary" data-action="qt-go">${ICONS.timer}<span>Start timer</span></button>
          </div>
        </section>
        <section class="sched-form-section" aria-labelledby="sched-st-title">
          <h3 class="sched-form-title" id="sched-st-title">Fire a saved schedule once</h3>
          <p class="sched-form-intro">Runs it with its own settings; its timetable is unchanged.</p>
          <div class="sched-form-group">
            ${dropdownRow('sched-existing-timer-schedule', 'Schedule', scheduleOptions)}
            ${formRow('sched-existing-timer-min', 'Minutes from now', `<input class="sched-input" id="sched-existing-timer-min" type="number" min="1" max="1440" value="${esc(scheduleMinutes)}" placeholder="15">`)}
          </div>
          <div class="sched-form-actions">
            <button type="button" class="sched-btn sched-btn--primary" data-action="schedule-timer-create">Set timer</button>
          </div>
        </section>
      </div>
    </div>
  `;
  renderNote();
  renderActiveTimersInto();

  const qtProfile = $('sched-qt-profile');
  qtProfile?.addEventListener('change', () => {
    _launchProfile = qtProfile.value;
    storage.setItem('as-launch-profile', _launchProfile);
    const models = automationModelOptions(_launchProfile, getModelsForProfile(_launchProfile, _launchAccount));
    _launchModel = (models.find(m => m.tier === 'default') || models[0])?.id || '';
    storage.setItem('as-launch-model', _launchModel);
    _launchContextMode = 'default';
    storage.setItem('as-launch-context-mode', _launchContextMode);
    _launchEffort = 'off';
    storage.setItem('as-launch-effort', _launchEffort);
    renderTimersView();
  });
  $('sched-qt-model')?.addEventListener('change', (e) => {
    _launchModel = e.target.value || null;
    storage.setItem('as-launch-model', _launchModel);
    _launchContextMode = 'default';
    storage.setItem('as-launch-context-mode', _launchContextMode);
    const contextPopup = $('sched-qt-context');
    if (contextPopup) setDropdownItems(contextPopup, renderContextOptions(_launchProfile, _launchModel, _launchContextMode, { accountId: _launchAccount }));
  });
  $('sched-qt-context')?.addEventListener('change', (e) => {
    _launchContextMode = e.target.value || 'default';
    storage.setItem('as-launch-context-mode', _launchContextMode);
  });
  $('sched-qt-effort')?.addEventListener('change', (e) => {
    _launchEffort = e.target.value || 'off';
    storage.setItem('as-launch-effort', _launchEffort);
  });
  $('sched-qt-mcp')?.addEventListener('change', (e) => {
    _launchMcpProfile = e.target.value || 'full';
    storage.setItem('as-launch-mcp-profile', _launchMcpProfile);
  });
  $('sched-qt-account')?.addEventListener('change', (e) => {
    _launchAccount = e.target.value || 'default';
    storage.setItem('as-launch-account', _launchAccount);
    _launchContextMode = 'default';
    storage.setItem('as-launch-context-mode', _launchContextMode);
    ensureModelsForProfile('codex', false, _launchAccount).then(() => {
      const models = automationModelOptions('codex', getModelsForProfile('codex', _launchAccount));
      if (!models.some((model) => model.id === _launchModel)) _launchModel = (models.find((model) => model.isDefault) || models[0])?.id || null;
      storage.setItem('as-launch-model', _launchModel || '');
      const modelPopup = $('sched-qt-model');
      if (modelPopup) setDropdownItems(modelPopup, renderModelOptions('codex', _launchModel, { accountId: _launchAccount }));
      const contextPopup = $('sched-qt-context');
      if (contextPopup) setDropdownItems(contextPopup, renderContextOptions('codex', _launchModel, _launchContextMode, { accountId: _launchAccount }));
    });
  });
  $('sched-qt-browser')?.addEventListener('change', (e) => { _qtUsesBrowser = e.target.checked; });
  $('sched-qt-template')?.addEventListener('change', (e) => {
    const template = getTemplate(e.target.value);
    const browser = $('sched-qt-browser');
    if (browser && template) {
      browser.checked = !!template.usesBrowser;
      _qtUsesBrowser = null;
    }
  });
}

// The choices of each launch popup (cc-dropdown.js entries, `opt`).
function renderModelOptions(profile, selected, { showService = false, accountId = 'default' } = {}) {
  const models = automationModelOptions(profile, getModelsForProfile(profile, accountId));
  selected = normalizeAutomationSelection(profile, selected).model || '';
  if (!models.length) {
    // List not loaded yet — preserve any stored selection so saving the form cannot
    // blank it (a blank popup makes save send model:null, which DELETES the override).
    if (selected) return [opt('', 'Template/default'), opt(selected, selected, true)];
    return [opt('', 'Default', true)];
  }
  const known = !!selected && models.some(m => modelMatchesSelector(m, selected));
  const current = selected || '';
  const opts = [
    opt('', 'Template/default', !current),
    ...models.map(m => opt(modelSelectorValue(m), formatModelOptionLabel(m, {
      includeService: showService && profile === 'opencode',
    }), modelMatchesSelector(m, current))),
  ];
  // Preserve a stored model that isn't in the (still-loading or curated) list so the
  // dropdown never silently blanks it and a save can't wipe the persisted override.
  if (selected && !known) opts.push(opt(selected, `${selected} (saved)`, true));
  return opts;
}

function renderContextOptions(profile, model, selected, { accountId = 'default', inherit = false } = {}) {
  const models = getModelsForProfile(profile, accountId);
  const choices = automationContextOptions(profile, model, models);
  const current = selected || (inherit ? '' : 'default');
  const options = inherit ? [opt('', 'No override', !current)] : [];
  for (const choice of choices) options.push(opt(choice.id, choice.label, current === choice.id));
  if (current && !choices.some((choice) => choice.id === current)) {
    options.push(opt(current, `${current} (unavailable — choose another)`, true));
  }
  return options;
}

function contextChoiceAvailable(profile, model, contextMode, accountId = 'default') {
  return !contextMode || automationContextOptions(profile, model, getModelsForProfile(profile, accountId))
    .some((choice) => choice.id === contextMode);
}

function modelChoiceAvailable(profile, model, accountId = 'default') {
  if (profile !== 'codex' || !model) return true;
  const models = getModelsForProfile('codex', accountId);
  return !models.length || models.some((entry) => entry.id === model);
}

// `inheritLabel` adds the "no override" choice ('') of the editors, apart from an explicit 'off'
// (Claude Code: no thinking), which is a value of its own: a run takes it over the group's level.
function renderEffortOptions(profile, selected, { inheritLabel = null } = {}) {
  const levels = getEffortLevelsForProfile(profile);
  const value = selected || '';
  if (!inheritLabel && !levels.length) return [opt('off', 'Default', true)];
  const known = !!value && levels.some(e => e.id === value);
  const opts = inheritLabel ? [opt('', inheritLabel, !value)] : [];
  for (const e of levels) opts.push(opt(e.id, `${e.label}${e.desc ? ' - ' + e.desc : ''}`, e.id === value));
  // A saved level this CLI does not list (set for another CLI, or by hand) stays selected,
  // so saving the form cannot drop it (the model, MCP and account popups do the same).
  if (value && !known) opts.push(opt(value, `${value} (saved)`, true));
  return opts;
}

function renderMcpOptions(selected) {
  const presets = getCachedMcpProfilePresets();
  const entries = Object.entries(presets);
  if (!entries.length) {
    if (!selected) return [opt('', 'Loading...')];
    return [opt(selected, `${selected} (loading...)`, true)];
  }
  const known = !!selected && !!presets[selected];
  const options = entries.map(([id, p]) => {
    const label = p.label || id;
    const tools = p.tools != null ? ` - ${p.tools} tools` : '';
    return opt(id, `${label}${tools}`, known && id === selected);
  });
  // A saved tool list that is not a preset ("browser,browser_twitter") stays selected, so saving
  // the form cannot quietly replace it with another preset (the model popup does the same).
  if (selected && !known) options.push(opt(selected, `${selected} (saved)`, true));
  return options;
}

// The choices of the Codex account popup. `allowInherit` adds a
// "Template/group default" option (used by schedule/group forms); the timers
// tab passes false so it always resolves to a concrete account.
function renderAccountOptions(selected, allowInherit = false) {
  const accounts = getCachedCodexAccounts();
  const known = !!selected && accounts.some(a => a.id === selected);
  // A saved account the list does not show (the list has not loaded yet, or the account is gone)
  // stays selected: the editors collect the popup before they redraw, and a blank one would clear it.
  const keep = allowInherit && !!selected && !known;
  const current = known || keep ? selected : (allowInherit ? '' : 'default');
  const opts = accounts.map(a => {
    const label = a.label || a.email || (a.isDefault ? 'Default' : a.id);
    const plan = a.planType ? ` (${a.planType})` : '';
    return opt(a.id, `${label}${plan}`, a.id === current);
  });
  if (allowInherit) opts.unshift(opt('', 'Template/group default', !current));
  if (keep) opts.push(opt(selected, `${selected} (saved)`, true));
  return opts;
}

// Kick off a one-time fetch of accounts; re-render the active view when ready.
function ensureCodexAccountsLoaded(rerender) {
  if (_codexAccountsRequested) return;
  _codexAccountsRequested = true;
  fetchCodexAccounts().then(() => { if (_panel) rerender?.(); }).catch(() => {});
}

function renderActiveTimersInto() {
  const box = $('sched-active-timers');
  if (!box) return;
  const scheduleTimers = Object.entries(_scheduleTimerData).map(([scheduleId, timer]) => {
    const schedule = _schedules.find(s => s.id === scheduleId);
    const name = schedule?.name || 'Schedule';
    return `
      <div class="sched-timer-row" data-timer-id="${esc(scheduleId)}" data-timer-kind="schedule">
        <span class="sched-timer-name">${esc(name)}<span class="sched-timer-meta">Saved schedule, once</span></span>
        <strong class="sched-timer-count" data-fires-at="${esc(timer.firesAt)}">${formatTimerCountdown(timer.firesAt)}</strong>
        <button type="button" class="sched-btn" data-action="schedule-timer-cancel" data-id="${esc(scheduleId)}" aria-label="Cancel the timer for ${esc(name)}">Cancel</button>
      </div>`;
  }).join('');

  const quickTimers = _quickTimers.map(timer => {
    const meta = [
      timer.profile ? CLI_PROFILES.find(p => p.id === timer.profile)?.label || timer.profile : '',
      timer.model,
      timer.contextMode && timer.contextMode !== 'default' ? `context ${timer.contextMode}` : '',
      timer.effort ? `thinking ${timer.effort}` : '',
      timer.mcpProfile ? `MCP ${timer.mcpProfile}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="sched-timer-row" data-timer-id="${esc(timer.id)}" data-timer-kind="quick">
        <span class="sched-timer-name">${esc(timer.templateName)}<span class="sched-timer-meta">${esc(meta || 'Automation, once')}</span></span>
        <strong class="sched-timer-count" data-fires-at="${esc(timer.firesAt)}">${formatTimerCountdown(timer.firesAt)}</strong>
        <button type="button" class="sched-btn" data-action="qt-cancel" data-id="${esc(timer.id)}" aria-label="Cancel the timer for ${esc(timer.templateName)}">Cancel</button>
      </div>`;
  }).join('');

  // The timers load on their own: until they answer (or when they could not), say so here.
  const note = _timersError
    ? `<div class="sched-load-note">${ICONS.alert}<span>${esc(_timersError)}</span><button type="button" class="sched-btn" data-action="retry-timers">Try again</button></div>`
    : '';
  const empty = _timersError ? '' : `<p class="sched-form-intro">${_timersLoaded ? 'No timers are waiting.' : 'Loading timers…'}</p>`;
  box.innerHTML = note + (scheduleTimers || quickTimers ? `<div class="sched-form-group">${quickTimers}${scheduleTimers}</div>` : empty);
}

// ── Form pieces (Settings grouped rows) ──

function formRow(id, label, control, { help = '', hidden = false, top = false, rowId = '', toggle = false, labelId = '' } = {}) {
  // A switch sits at the end of its row, its explanation under the label (as in Settings).
  if (toggle) {
    return `<div class="sched-form-row sched-form-row--switch"${rowId ? ` id="${rowId}"` : ''}${hidden ? ' hidden' : ''}>
      <div class="sched-form-stack">
        <label class="sched-form-label" for="${id}">${esc(label)}</label>
        ${help ? `<p class="sched-help" id="${id}-help">${help}</p>` : ''}
      </div>
      <div class="sched-form-control">${control}</div>
    </div>`;
  }
  // A popup is named by its label (aria-labelledby): its value lives in a hidden input no label can point at.
  const labelAttrs = labelId ? `id="${labelId}"` : `for="${id}"`;
  return `<div class="sched-form-row${top || help ? ' sched-form-row--top' : ''}"${rowId ? ` id="${rowId}"` : ''}${hidden ? ' hidden' : ''}>
    <label class="sched-form-label" ${labelAttrs}>${esc(label)}</label>
    <div class="sched-form-stack">
      <div class="sched-form-control">${control}</div>
      ${help ? `<p class="sched-help" id="${id}-help">${help}</p>` : ''}
    </div>
  </div>`;
}

/** A row with a popup (cc-dropdown.js): its value is the hidden input `id`, its choices `entries`. */
function dropdownRow(id, label, entries, rowOpts = {}) {
  return formRow(id, label, dropdownHTML(id, entries, { labelledBy: `${id}-label` }), { ...rowOpts, labelId: `${id}-label` });
}

function toggleHTML(id, checked, describedBy = '') {
  return `<label class="sched-toggle"><input type="checkbox" id="${id}" role="switch"${checked ? ' checked' : ''}${describedBy ? ` aria-describedby="${describedBy}"` : ''}><span class="sched-toggle-track" aria-hidden="true"></span></label>`;
}

// An editor is drawn again when a list it needs arrives (models, MCP presets, accounts), which
// can be while the user types: the focused field (and its caret), the scroll position and an
// opened Day themes section are put back as they were.
function redrawEditor(main, html) {
  const active = document.activeElement;
  const focusId = active && main.contains(active) ? active.id : '';
  const caret = focusId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = main.querySelector('.sched-editor-body')?.scrollTop ?? 0;
  const opened = main.querySelector('details.sched-form-section')?.open;
  main.innerHTML = html;
  const body = main.querySelector('.sched-editor-body');
  if (body) body.scrollTop = scroll;
  const details = main.querySelector('details.sched-form-section');
  if (details && opened) details.open = true;
  const field = focusId ? document.getElementById(focusId) : null;
  if (field) {
    field.focus({ preventScroll: true });
    if (caret) try { field.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
  }
}

function editorHead({ back, title, sub, titleId }) {
  return `<header class="sched-editor-head">
    <button type="button" class="sched-icon-btn" data-action="${back}" aria-label="Back to the list" data-tooltip="Back (Esc)">${ICONS.back}</button>
    <div class="sched-editor-titles"><h2 id="${titleId}">${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
  </header>`;
}

// ── Group editor ──

function openGroupEditor(id) {
  _scheduleEditor = null;
  const group = id ? getGroup(id) : null;
  _groupEditorId = group ? group.id : null;
  // `_original` is the group as it was when the editor opened: a save sends only what the user
  // changed from it, so a change made elsewhere meanwhile (a sync update) is never undone.
  _groupEditorDraft = group
    ? { name: group.name, color: group.color, mutualExclusion: !!group.mutualExclusion, profile: group.profile || null, model: group.model || null, contextMode: group.contextMode || null, effort: group.effort || null, mcpProfile: group.mcpProfile || null, codexAccountId: group.codexAccountId || null, usesBrowser: group.usesBrowser, _original: JSON.parse(JSON.stringify(group)) }
    : { name: '', color: DEFAULT_GROUP_COLOR, mutualExclusion: false, profile: null, model: null, contextMode: null, effort: null, mcpProfile: null, codexAccountId: null, usesBrowser: undefined };
  ensureModelsForProfile(_groupEditorDraft.profile || 'claude-code', false, _groupEditorDraft.codexAccountId || 'default').then(() => {
    if (_panel && _groupEditorDraft) {
      collectGroupEditorDraft();
      renderGroupEditor(_groupEditorId ? getGroup(_groupEditorId) : null);
    }
  });
}

function collectGroupEditorDraft() {
  if (!_groupEditorDraft || !$('sched-ge-name')) return;
  const browserRaw = $('sched-ge-browser')?.value || '';
  Object.assign(_groupEditorDraft, {
    name: $('sched-ge-name')?.value ?? _groupEditorDraft.name,
    color: $('sched-ge-color')?.value || _groupEditorDraft.color,
    mutualExclusion: $('sched-ge-mutex')?.checked ?? _groupEditorDraft.mutualExclusion,
    profile: $('sched-ge-profile')?.value || null,
    model: $('sched-ge-model')?.value || null,
    contextMode: $('sched-ge-context')?.value || null,
    effort: $('sched-ge-effort')?.value || null,
    mcpProfile: $('sched-ge-mcp')?.value || null,
    codexAccountId: $('sched-ge-account')?.value || null,
    usesBrowser: browserRaw === '' ? undefined : browserRaw === 'true',
  });
}

function renderGroupEditor(group) {
  const main = $('sched-main');
  if (!main || !_groupEditorDraft) return;
  _frame = 'group-editor';
  // A group deleted elsewhere while it is edited is still this group (a save then says it is gone).
  const creating = !_groupEditorId;
  const d = _groupEditorDraft;
  const profileForModels = d.profile || 'claude-code';
  const accountId = d.codexAccountId || 'default';
  const profileOptions = [
    opt('', 'No override', !d.profile),
    ...CLI_PROFILES.map(p => opt(p.id, p.label, d.profile === p.id)),
  ];
  const modelOptions = renderModelOptions(profileForModels, d.model || '', { showService: true, accountId });
  const contextOptions = renderContextOptions(profileForModels, d.model, d.contextMode, { accountId, inherit: true });
  const effortOptions = renderEffortOptions(profileForModels, d.effort || '', { inheritLabel: 'No override' });
  const mcpOptions = renderMcpOptions(d.mcpProfile || '');
  const accountOptions = renderAccountOptions(d.codexAccountId || '', true);
  const showEffort = profileSupportsEffort(profileForModels);
  const showMcp = profileForModels !== 'claude-code';
  const showAccount = profileForModels === 'codex';
  const rerender = () => { if (_panel && _groupEditorDraft) { collectGroupEditorDraft(); renderGroupEditor(_groupEditorId ? getGroup(_groupEditorId) : null); } };
  if (showAccount) ensureCodexAccountsLoaded(rerender);
  if (showMcp && !Object.keys(getCachedMcpProfilePresets()).length) fetchMcpProfilePresets().then(rerender);
  const browserValue = d.usesBrowser === true ? 'true' : d.usesBrowser === false ? 'false' : '';
  const ordered = orderedGroups();
  const position = group ? ordered.findIndex(g => g.id === group.id) : -1;
  const members = group ? _schedules.filter(s => s.groupId === group.id).length : 0;

  redrawEditor(main, `
    <div class="sched-editor">
      ${editorHead({ back: 'group-editor-cancel', title: creating ? 'New group' : 'Edit group', sub: creating ? 'Groups keep related schedules together, and can share launch settings.' : (group || d._original)?.name, titleId: 'sched-view-title' })}
      <div class="sched-editor-body">
        <div class="sched-form">
          <section class="sched-form-section" aria-labelledby="sched-ge-sec-group">
            <h3 class="sched-form-title" id="sched-ge-sec-group">Group</h3>
            <div class="sched-form-group">
              ${formRow('sched-ge-name', 'Name', `<input class="sched-input" id="sched-ge-name" type="text" value="${esc(d.name || '')}" placeholder="Twitter cadence" autocomplete="off">`)}
              ${formRow('sched-ge-color', 'Colour', `<input class="sched-input" id="sched-ge-color" type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color : DEFAULT_GROUP_COLOR)}">`)}
              ${formRow('sched-ge-mutex', 'One at a time', toggleHTML('sched-ge-mutex', !!d.mutualExclusion, 'sched-ge-mutex-help'),
                { help: 'Schedules in every group set to one at a time take turns: while one runs, the others wait.', toggle: true })}
            </div>
          </section>
          <section class="sched-form-section" aria-labelledby="sched-ge-sec-launch">
            <h3 class="sched-form-title" id="sched-ge-sec-launch">Launch overrides</h3>
            <p class="sched-form-intro">Apply to every schedule in this group. A schedule's own setting wins.</p>
            <div class="sched-form-group">
              ${dropdownRow('sched-ge-profile', 'CLI', profileOptions)}
              ${dropdownRow('sched-ge-model', 'Model', modelOptions)}
              ${dropdownRow('sched-ge-context', 'Context', contextOptions)}
              ${dropdownRow('sched-ge-effort', 'Thinking', effortOptions, { hidden: !showEffort })}
              ${dropdownRow('sched-ge-mcp', 'MCP tools', [opt('', 'No override', !d.mcpProfile), ...mcpOptions], { hidden: !showMcp })}
              ${dropdownRow('sched-ge-account', 'OpenAI account', accountOptions, { hidden: !showAccount, rowId: 'sched-ge-account-field' })}
              ${dropdownRow('sched-ge-browser', 'Browser', [
                opt('', 'No override', browserValue === ''),
                opt('true', 'Always on', browserValue === 'true'),
                opt('false', 'Always off', browserValue === 'false'),
              ])}
            </div>
          </section>
          ${!group ? '' : `
          <section class="sched-form-section" aria-labelledby="sched-ge-sec-order">
            <h3 class="sched-form-title" id="sched-ge-sec-order">Order</h3>
            <div class="sched-form-group">
              <div class="sched-form-row">
                <span class="sched-form-label">Position ${position + 1} of ${ordered.length}</span>
                <div class="sched-form-control">
                  <button type="button" class="sched-btn" data-action="group-up" data-id="${esc(group.id)}"${position <= 0 ? ' disabled' : ''}>${ICONS.up}<span>Move up</span></button>
                  <button type="button" class="sched-btn" data-action="group-down" data-id="${esc(group.id)}"${position >= ordered.length - 1 ? ' disabled' : ''}>${ICONS.down}<span>Move down</span></button>
                </div>
              </div>
            </div>
          </section>
          <section class="sched-form-section" aria-labelledby="sched-ge-sec-delete">
            <h3 class="sched-form-title" id="sched-ge-sec-delete">Delete</h3>
            <div class="sched-form-group">
              <div class="sched-form-row">
                <span class="sched-form-label">${members ? `Its ${plural(members, 'schedule')} move to Ungrouped and keep running.` : 'The group is empty.'}</span>
                <div class="sched-form-control">
                  <button type="button" class="sched-btn sched-btn--danger" data-action="group-delete" data-id="${esc(group.id)}">${ICONS.trash}<span>Delete group…</span></button>
                </div>
              </div>
            </div>
          </section>`}
        </div>
      </div>
      <footer class="sched-editor-actions">
        <button type="button" class="sched-btn" data-action="group-editor-cancel">Cancel</button>
        <button type="button" class="sched-btn sched-btn--primary" data-action="group-editor-save" data-id="${esc(_groupEditorId || '')}">${creating ? 'Create group' : 'Save changes'}</button>
      </footer>
    </div>`);
  wireGroupEditor();
}

function wireGroupEditor() {
  const profileSelect = $('sched-ge-profile');
  profileSelect?.addEventListener('change', () => {
    collectGroupEditorDraft();
    _groupEditorDraft.profile = profileSelect.value || null;
    _groupEditorDraft.model = null;
    _groupEditorDraft.contextMode = _groupEditorDraft.profile ? 'default' : null;
    _groupEditorDraft.effort = null;
    _groupEditorDraft.mcpProfile = null;
    _groupEditorDraft.codexAccountId = null;
    const rerender = () => { if (_panel && _groupEditorDraft) renderGroupEditor(_groupEditorId ? getGroup(_groupEditorId) : null); };
    ensureModelsForProfile(_groupEditorDraft.profile || 'claude-code', false, 'default').then(() => { collectGroupEditorDraft(); rerender(); });
    rerender();
  });
  $('sched-ge-model')?.addEventListener('change', (e) => {
    _groupEditorDraft.model = e.target.value || null;
    _groupEditorDraft.contextMode = _groupEditorDraft.model ? 'default' : null;
    const contextPopup = $('sched-ge-context');
    if (contextPopup) setDropdownItems(contextPopup, renderContextOptions(_groupEditorDraft.profile || 'claude-code', _groupEditorDraft.model, _groupEditorDraft.contextMode, { accountId: _groupEditorDraft.codexAccountId || 'default', inherit: true }));
  });
  $('sched-ge-context')?.addEventListener('change', (e) => { _groupEditorDraft.contextMode = e.target.value || null; });
  $('sched-ge-account')?.addEventListener('change', (e) => {
    _groupEditorDraft.codexAccountId = e.target.value || null;
    _groupEditorDraft.contextMode = 'default';
    ensureModelsForProfile('codex', false, _groupEditorDraft.codexAccountId || 'default').then(() => {
      if (!_groupEditorDraft) return;
      const account = _groupEditorDraft.codexAccountId || 'default';
      const modelPopup = $('sched-ge-model');
      if (modelPopup) setDropdownItems(modelPopup, renderModelOptions('codex', _groupEditorDraft.model, { accountId: account }));
      const contextPopup = $('sched-ge-context');
      if (contextPopup) setDropdownItems(contextPopup, renderContextOptions('codex', _groupEditorDraft.model, _groupEditorDraft.contextMode, { accountId: account, inherit: true }));
    });
  });
}

// ── Schedule editor ──

function renderScheduleEditor() {
  const main = $('sched-main');
  if (!main) return;
  _frame = 'schedule-editor';
  const s = _scheduleEditor || {};
  const isEdit = !!s.id;
  // A saved automation or group the lists do not show (deleted elsewhere, or not in what loaded)
  // stays selected: a popup without it would show the first choice, and a save would move it.
  const templateOptions = [
    opt('', 'Choose an automation…'),
    ..._templates.map(t => opt(t.id, `${t.name} (${t.category || 'custom'})`, s.templateId === t.id)),
    ...(s.templateId && !getTemplate(s.templateId) ? [opt(s.templateId, `${s.templateId} (saved)`, true)] : []),
  ];
  const groupOptions = [
    opt('', 'Ungrouped', !s.groupId),
    ...orderedGroups().map(g => opt(g.id, g.name, s.groupId === g.id)),
    ...(s.groupId && !getGroup(s.groupId) ? [opt(s.groupId, `${s.groupId} (saved)`, true)] : []),
  ];
  const tz = s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const profileOptions = [
    opt('', 'Template default', !s.profile),
    ...CLI_PROFILES.map(p => opt(p.id, p.label, s.profile === p.id)),
  ];
  const template = getTemplate(s.templateId);
  const group = s.groupId ? getGroup(s.groupId) : null;
  const profileForModels = s.profile || group?.profile || template?.profile || 'claude-code';
  const accountId = s.codexAccountId || group?.codexAccountId || template?.codexAccountId || 'default';
  const effectiveModel = s.model || group?.model || template?.model || null;
  const modelOptions = renderModelOptions(profileForModels, s.model || '', { showService: true, accountId });
  const contextOptions = renderContextOptions(profileForModels, effectiveModel, s.contextMode, { accountId, inherit: true });
  const effortOptions = renderEffortOptions(profileForModels, s.effort || '', { inheritLabel: 'Template/default' });
  const mcpOptions = renderMcpOptions(s.mcpProfile || '');
  const accountOptions = renderAccountOptions(s.codexAccountId || '', true);
  const showEffort = profileSupportsEffort(profileForModels);
  const showMcp = profileForModels !== 'claude-code';
  const showAccount = profileForModels === 'codex';
  if (showAccount) ensureCodexAccountsLoaded(() => { if (_panel && _scheduleEditor) { collectScheduleEditorDraft(); renderScheduleEditor(); } });
  const browserValue = s.usesBrowser === true ? 'true' : s.usesBrowser === false ? 'false' : '';
  const cron = s.cron || '0 9 * * *';
  const presetsHTML = CRON_PRESET_GROUPS.map(group => `
    <div class="sched-preset-group" role="group" aria-label="${esc(group.group)} presets">
      <span>${esc(group.group)}</span>
      <div class="sched-chip-list">${group.presets.map(p => `<button type="button" class="sched-chip" data-action="cron-preset" data-cron="${esc(p.cron)}" aria-pressed="${p.cron === cron}" data-tooltip="${esc(describeCron(p.cron))}">${esc(p.label)}</button>`).join('')}</div>
    </div>`).join('');
  const dayOrder = [1, 2, 3, 4, 5, 6, 0];
  const hasThemes = dayOrder.some(idx => s.dayThemes?.[String(idx)]);
  // A textarea, not an input: a theme can span lines, and an input would drop its line breaks.
  // Clearing the text keeps the day's entry (and its label: the day still runs); Remove takes the
  // whole entry away.
  const dayThemes = dayOrder.map(idx => {
    const entry = s.dayThemes?.[String(idx)];
    const help = entry?.label ? `Theme: ${esc(entry.label)}` : '';
    // A day without an entry keeps the button's room, so the fields line up.
    const remove = entry
      ? `<button type="button" class="sched-icon-btn sched-icon-btn--danger sched-day-remove" data-action="day-theme-remove" data-day="${idx}" aria-label="Remove the ${DAY_LONG[idx]} theme" data-tooltip="Remove this day's theme">${ICONS.trash}</button>`
      : '<span class="sched-icon-btn sched-day-remove sched-day-remove--room" aria-hidden="true"></span>';
    return formRow(`sched-ed-day-${idx}`, DAY_LONG[idx],
      `<textarea class="sched-input sched-textarea" id="sched-ed-day-${idx}" data-day="${idx}" rows="2" spellcheck="false" placeholder="Extra context for ${DAY_LONG[idx]} runs (optional)"${help ? ` aria-describedby="sched-ed-day-${idx}-help"` : ''}>${esc(entry?.contextOverride || '')}</textarea>${remove}`,
      { help });
  }).join('');

  const modelLoadKey = `${profileForModels}:${accountId}`;
  if (isDynamicModelProfile(profileForModels) && !_modelLoadRequests.has(modelLoadKey)) {
    _modelLoadRequests.add(modelLoadKey);
    ensureModelsForProfile(profileForModels, false, accountId).then(() => {
      if (_panel && _scheduleEditor) { collectScheduleEditorDraft(); renderScheduleEditor(); }
    });
  }
  if (showMcp && !Object.keys(getCachedMcpProfilePresets()).length) {
    fetchMcpProfilePresets().then(() => { if (_panel && _scheduleEditor) { collectScheduleEditorDraft(); renderScheduleEditor(); } });
  }

  redrawEditor(main, `
    <div class="sched-editor">
      ${editorHead({ back: 'schedule-editor-close', title: isEdit ? 'Edit schedule' : 'New schedule', sub: isEdit ? s.name : 'Launches one of your automations on a timetable.', titleId: 'sched-view-title' })}
      <div class="sched-editor-body">
        <div class="sched-form">
          <section class="sched-form-section" aria-labelledby="sched-ed-sec-basics">
            <h3 class="sched-form-title" id="sched-ed-sec-basics">Schedule</h3>
            <div class="sched-form-group">
              ${formRow('sched-ed-name', 'Name', `<input class="sched-input" id="sched-ed-name" type="text" value="${esc(s.name || '')}" placeholder="Morning post" autocomplete="off">`)}
              ${dropdownRow('sched-ed-template', 'Automation', templateOptions)}
              ${dropdownRow('sched-ed-group', 'Group', groupOptions)}
              ${formRow('sched-ed-enabled', 'Active', toggleHTML('sched-ed-enabled', s.enabled !== false, 'sched-ed-enabled-help'),
                { help: 'Turn it off to pause the schedule without deleting it.', toggle: true })}
            </div>
          </section>

          <section class="sched-form-section" aria-labelledby="sched-ed-sec-when">
            <h3 class="sched-form-title" id="sched-ed-sec-when">When it runs</h3>
            <div class="sched-form-group">
              <div class="sched-form-row sched-form-row--top">
                <label class="sched-form-label" for="sched-ed-cron">Cron expression</label>
                <div class="sched-form-stack">
                  <div class="sched-form-control"><input class="sched-input sched-mono" id="sched-ed-cron" type="text" value="${esc(cron)}" placeholder="0 9 * * *" spellcheck="false" autocomplete="off" aria-describedby="sched-ed-cron-desc"></div>
                  <p class="sched-help" id="sched-ed-cron-desc" aria-live="polite">${esc(describeCron(cron))}</p>
                </div>
              </div>
              <div class="sched-form-row sched-form-row--top">
                <span class="sched-form-label">Presets</span>
                <div class="sched-presets">${presetsHTML}</div>
              </div>
              ${formRow('sched-ed-tz', 'Time zone', `<input class="sched-input" id="sched-ed-tz" type="text" value="${esc(tz)}" spellcheck="false" autocomplete="off">`)}
            </div>
          </section>

          <section class="sched-form-section" aria-labelledby="sched-ed-sec-launch">
            <h3 class="sched-form-title" id="sched-ed-sec-launch">Launch overrides</h3>
            <p class="sched-form-intro">Leave a setting on its default to use the group's, then the automation's.</p>
            <div class="sched-form-group">
              ${dropdownRow('sched-ed-profile', 'CLI', profileOptions)}
              ${dropdownRow('sched-ed-model', 'Model', modelOptions)}
              ${dropdownRow('sched-ed-context', 'Context', contextOptions)}
              ${dropdownRow('sched-ed-effort', 'Thinking', effortOptions, { hidden: !showEffort })}
              ${dropdownRow('sched-ed-mcp', 'MCP tools', [opt('', 'Template/default', !s.mcpProfile), ...mcpOptions], { hidden: !showMcp })}
              ${dropdownRow('sched-ed-account', 'OpenAI account', accountOptions, { hidden: !showAccount, rowId: 'sched-ed-account-field' })}
              ${dropdownRow('sched-ed-browser', 'Browser', [
                opt('', 'Template default', browserValue === ''),
                opt('true', 'Always on', browserValue === 'true'),
                opt('false', 'Always off', browserValue === 'false'),
              ])}
            </div>
          </section>

          <details class="sched-form-section"${hasThemes ? ' open' : ''}>
            <summary class="sched-form-title">Day themes <small>optional</small></summary>
            <p class="sched-form-intro">Extra context added to the run on that weekday, such as a topic for Mondays. Once any day has a theme, the schedule runs only on the days that have one.</p>
            <div class="sched-form-group" id="sched-ed-daythemes">${dayThemes}</div>
          </details>
        </div>
      </div>
      <footer class="sched-editor-actions">
        <button type="button" class="sched-btn" data-action="schedule-editor-close">Cancel</button>
        <button type="button" class="sched-btn sched-btn--primary" data-action="schedule-editor-save">${isEdit ? 'Save changes' : 'Create schedule'}</button>
      </footer>
    </div>
  `);

  $('sched-ed-cron')?.addEventListener('input', updateCronDesc);
  $('sched-ed-template')?.addEventListener('change', (e) => {
    collectScheduleEditorDraft();
    _scheduleEditor.templateId = e.target.value || null;
    _scheduleEditor.model = null;
    _scheduleEditor.contextMode = null;
    _scheduleEditor.effort = null;
    _scheduleEditor.mcpProfile = null;
    _scheduleEditor.codexAccountId = null;
    renderScheduleEditor();
  });
  $('sched-ed-group')?.addEventListener('change', (e) => {
    collectScheduleEditorDraft();
    _scheduleEditor.groupId = e.target.value || null;
    renderScheduleEditor();
  });
  $('sched-ed-profile')?.addEventListener('change', (e) => {
    collectScheduleEditorDraft();
    _scheduleEditor.profile = e.target.value || null;
    _scheduleEditor.model = null;
    _scheduleEditor.contextMode = _scheduleEditor.profile ? 'default' : null;
    _scheduleEditor.effort = null;
    _scheduleEditor.mcpProfile = null;
    _scheduleEditor.codexAccountId = null;
    renderScheduleEditor();
  });
  $('sched-ed-model')?.addEventListener('change', (e) => {
    _scheduleEditor.model = e.target.value || null;
    _scheduleEditor.contextMode = _scheduleEditor.model ? 'default' : null;
    const contextPopup = $('sched-ed-context');
    if (contextPopup) setDropdownItems(contextPopup, renderContextOptions(profileForModels, _scheduleEditor.model || group?.model || template?.model, _scheduleEditor.contextMode, { accountId, inherit: true }));
  });
  $('sched-ed-context')?.addEventListener('change', (e) => { _scheduleEditor.contextMode = e.target.value || null; });
  $('sched-ed-account')?.addEventListener('change', (e) => {
    _scheduleEditor.codexAccountId = e.target.value || null;
    _scheduleEditor.contextMode = 'default';
    const nextAccount = _scheduleEditor.codexAccountId || 'default';
    ensureModelsForProfile('codex', false, nextAccount).then(() => {
      if (!_scheduleEditor) return;
      const modelPopup = $('sched-ed-model');
      if (modelPopup) setDropdownItems(modelPopup, renderModelOptions('codex', _scheduleEditor.model, { accountId: nextAccount, showService: true }));
      const contextPopup = $('sched-ed-context');
      if (contextPopup) setDropdownItems(contextPopup, renderContextOptions('codex', _scheduleEditor.model || effectiveModel, _scheduleEditor.contextMode, { accountId: nextAccount, inherit: true }));
    });
  });
}

function updateCronDesc() {
  const input = $('sched-ed-cron');
  const desc = $('sched-ed-cron-desc');
  if (!input) return;
  const value = input.value.trim();
  const valid = value.split(/\s+/).length === 5;
  if (!valid && value) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  if (desc) desc.textContent = valid ? describeCron(value) : 'A cron expression has five fields: minute, hour, day of month, month, day of week.';
  _panel?.querySelectorAll('[data-action="cron-preset"]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.cron === value)));
}

// ── Saving what was saved before: only what the user changed ──
// The server reads a launch field as: absent = keep, null or '' = clear, a value = set (and a
// group pushes every changed launch field onto its schedules). So an edit sends a field only when
// the form's value differs from the saved one: a popup that cannot show a saved value yet, or a
// save of an untouched form, never clears anything.
const LAUNCH_FIELDS = ['profile', 'model', 'contextMode', 'effort', 'mcpProfile', 'codexAccountId', 'usesBrowser'];
// What a CLI's choice decides: a model, context, thinking level, tool list or account of one CLI
// means nothing to another, so a change of CLI resets them (the editors' CLI popups do the same).
const CLI_DEPENDENT = ['model', 'contextMode', 'effort', 'mcpProfile', 'codexAccountId'];
const blankToNull = (value) => (value === undefined || value === null || value === '' ? null : value);
const sameValue = (a, b) => blankToNull(a) === blankToNull(b);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

// The day themes as the form shows them, over the draft's. An entry the user did not touch is
// kept exactly (its label too); an edited one keeps its other fields. A day's entry is what lets a
// themed schedule run that day (server.js skips a day without one), so an entry goes only once
// nothing is left in it, or when its Remove button takes it out of the draft.
function collectDayThemes(saved) {
  const out = saved && typeof saved === 'object' ? JSON.parse(JSON.stringify(saved)) : {};
  _panel?.querySelectorAll('#sched-ed-daythemes textarea[data-day]').forEach(field => {
    const day = field.dataset.day;
    const value = field.value.trim();
    const before = out[day] && typeof out[day] === 'object' ? out[day] : null;
    if (value === String(before?.contextOverride ?? '').trim()) return;
    if (value) { out[day] = { ...(before || {}), contextOverride: value }; return; }
    if (!before) return;
    const { contextOverride, ...rest } = before;
    if (Object.keys(rest).length) out[day] = rest;
    else delete out[day];
  });
  return out;
}

function collectScheduleEditorDraft() {
  // Only from a form on screen: an absent popup would read as "no value" and wipe the draft.
  if (!_scheduleEditor || !$('sched-ed-name')) return;
  const dayThemes = collectDayThemes(_scheduleEditor.dayThemes);
  const browserRaw = $('sched-ed-browser')?.value || '';
  Object.assign(_scheduleEditor, {
    name: $('sched-ed-name')?.value ?? _scheduleEditor.name,
    templateId: $('sched-ed-template')?.value || _scheduleEditor.templateId,
    groupId: $('sched-ed-group')?.value || null,
    timezone: $('sched-ed-tz')?.value || _scheduleEditor.timezone,
    cron: $('sched-ed-cron')?.value || _scheduleEditor.cron,
    profile: $('sched-ed-profile')?.value || null,
    model: $('sched-ed-model')?.value || null,
    contextMode: $('sched-ed-context')?.value || null,
    effort: $('sched-ed-effort')?.value || null,
    mcpProfile: $('sched-ed-mcp')?.value || null,
    codexAccountId: $('sched-ed-account')?.value || null,
    usesBrowser: browserRaw === '' ? undefined : browserRaw === 'true',
    enabled: $('sched-ed-enabled')?.checked ?? _scheduleEditor.enabled,
    dayThemes,
  });
}

function markInvalid(id, message) {
  const field = controlOf($(id)); // a popup's trigger, not its hidden input
  field?.setAttribute('aria-invalid', 'true');
  field?.focus();
  showToast(message);
}

async function saveScheduleFromEditor() {
  if (editorsWait()) { showToast('The schedules have not loaded yet: save once they have'); return; }
  const original = _scheduleEditor?._original || null;
  const name = $('sched-ed-name')?.value?.trim();
  const templateId = $('sched-ed-template')?.value;
  const cron = $('sched-ed-cron')?.value?.trim();
  const timezone = $('sched-ed-tz')?.value?.trim();
  const groupId = $('sched-ed-group')?.value || null;
  const enabled = $('sched-ed-enabled')?.checked ?? true;
  const browserRaw = $('sched-ed-browser')?.value || '';
  const launch = {
    profile: $('sched-ed-profile')?.value || null,
    model: $('sched-ed-model')?.value || null,
    contextMode: $('sched-ed-context')?.value || null,
    // 'off' is a choice of its own (no thinking), never the same as "no override".
    effort: $('sched-ed-effort')?.value || null,
    mcpProfile: $('sched-ed-mcp')?.value || null,
    // Read whatever the CLI: a saved account is kept while its row is hidden, never cleared by it.
    codexAccountId: $('sched-ed-account')?.value || null,
    usesBrowser: browserRaw === '' ? null : browserRaw === 'true',
  };

  if (!name) { markInvalid('sched-ed-name', 'Give the schedule a name'); return; }
  if (!templateId) { markInvalid('sched-ed-template', 'Choose the automation it launches'); return; }
  if (!cron || cron.split(/\s+/).length !== 5) { markInvalid('sched-ed-cron', 'Enter a cron expression with five fields'); return; }

  const template = getTemplate(templateId);
  const group = groupId ? getGroup(groupId) : null;
  // What the run would use is checked when the choice that decides it changed (or for a new schedule).
  const choiceChanged = !original || !sameValue(templateId, original.templateId) || !sameValue(groupId, original.groupId)
    || ['profile', 'model', 'contextMode', 'codexAccountId'].some(k => !sameValue(launch[k], original[k]));
  if (choiceChanged) {
    const effectiveProfile = launch.profile || group?.profile || template?.profile || 'claude-code';
    const effectiveModel = launch.model || group?.model || template?.model || null;
    const effectiveAccount = launch.codexAccountId || group?.codexAccountId || template?.codexAccountId || 'default';
    if (!modelChoiceAvailable(effectiveProfile, effectiveModel, effectiveAccount)) {
      showToast('This model is unavailable for the selected account'); return;
    }
    if (!contextChoiceAvailable(effectiveProfile, effectiveModel, launch.contextMode, effectiveAccount)) {
      showToast('This context window is unavailable for the selected model and account'); return;
    }
  }

  collectScheduleEditorDraft(); // the day themes as shown, without the ones removed
  const dayThemes = _scheduleEditor?.dayThemes || {};
  let payload;
  if (original) {
    payload = {};
    for (const [key, value] of Object.entries({ name, templateId, cron, groupId, enabled })) {
      if (!sameValue(value, original[key])) payload[key] = value;
    }
    // A schedule without a zone shows the browser's; leaving that as shown keeps it without one.
    const shownZone = original.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone !== shownZone) payload.timezone = timezone;
    if (stableJson(dayThemes) !== stableJson(original.dayThemes || {})) payload.dayThemes = dayThemes;
    for (const key of LAUNCH_FIELDS) if (!sameValue(launch[key], original[key])) payload[key] = launch[key];
    if (!Object.keys(payload).length) {
      _scheduleEditor = null;
      render({ frame: true });
      focusRow(original.id);
      showToast('No changes to save');
      return;
    }
  } else {
    payload = { name, templateId, cron, timezone, groupId, enabled, dayThemes };
    for (const key of LAUNCH_FIELDS) if (launch[key] !== null) payload[key] = launch[key];
  }

  // The save belongs to this editor: once answered, it closes only this one (an editor or a view
  // opened while the save was on its way stays as it is).
  const draft = _scheduleEditor;
  const panel = _panel;
  try {
    let saved;
    if (draft?.id) {
      saved = await updateSchedule(draft.id, payload);
      const idx = _schedules.findIndex(s => s.id === saved.id);
      if (idx >= 0) _schedules[idx] = saved;
      showToast('Schedule updated');
    } else {
      saved = await createSchedule(payload);
      if (!_schedules.some(s => s.id === saved.id)) _schedules.push(saved);
      showToast('Schedule created');
    }
    if (_panel !== panel || _scheduleEditor !== draft) { refresh(); return; }
    _scheduleEditor = null;
    if (saved?.id) _expanded.add(saved.id);
    render({ frame: true });
    if (saved?.id) {
      const row = [..._panel.querySelectorAll('.sched-row')].find(el => el.dataset.scheduleId === saved.id);
      row?.scrollIntoView({ block: 'nearest' });
      row?.querySelector('.sched-row-toggle')?.focus({ preventScroll: true });
    }
  } catch (err) {
    showToast('Save failed: ' + err.message);
  }
}

// ── Events ──

async function handleClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !_panel?.contains(el) || el.disabled) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'set-scope':
      _query = _scope === el.dataset.scope ? _query : '';
      setScope(el.dataset.scope || 'all');
      render({ frame: true });
      break;
    case 'schedule-expand':
      toggleExpanded(id, el);
      break;
    case 'group-collapse': {
      const key = el.dataset.key;
      if (!key) break;
      if (_collapsed.has(key)) _collapsed.delete(key); else _collapsed.add(key);
      try { storage.setItem(COLLAPSED_KEY, JSON.stringify([..._collapsed])); } catch { /* not remembered */ }
      renderList();
      break;
    }
    case 'clear-search':
      _query = '';
      { const input = $('sched-search'); if (input) input.value = ''; }
      renderMain();
      $('sched-search')?.focus();
      break;
    case 'search-all':
      setScope('all');
      render({ frame: true });
      $('sched-search')?.focus();
      break;
    case 'retry-load':
      _loading = true;
      render({ frame: true });
      await loadData(); // loadFinished() redraws, and opens an editor asked for meanwhile
      break;
    case 'retry-timers':
      _timersError = null;
      _timersLoaded = false;
      renderActiveTimersInto();
      await loadTimers();
      break;
    case 'dismiss-report':
      _cliReport = null;
      renderNote();
      $('sched-search')?.focus();
      break;
    case 'reveal-schedule':
      revealSchedule(id);
      break;
    case 'schedule-new':
      applyOpenOptions({ action: 'new-schedule' });
      render({ frame: true });
      $('sched-ed-name')?.focus();
      break;
    case 'schedule-edit': {
      const schedule = editorsWait() ? null : _schedules.find(s => s.id === id);
      if (schedule) {
        _groupEditorId = null;
        _groupEditorDraft = null;
        // `_original` is the schedule as saved: a save sends only what differs from it.
        _scheduleEditor = { ...JSON.parse(JSON.stringify(schedule)), _original: JSON.parse(JSON.stringify(schedule)) };
        render({ frame: true });
        $('sched-ed-name')?.focus();
      }
      break;
    }
    case 'schedule-edit-prompt': {
      const templateId = el.dataset.templateId;
      if (!templateId) { showToast('No automation linked to this schedule'); break; }
      closePanel();
      emit('automations:open', { templateId });
      break;
    }
    case 'schedule-editor-close': {
      const editedId = _scheduleEditor?.id;
      _scheduleEditor = null;
      render({ frame: true });
      focusRow(editedId);
      break;
    }
    case 'schedule-editor-save':
      // One save at a time: a second click while one is on its way would send it again.
      el.disabled = true;
      try { await saveScheduleFromEditor(); } finally { if (el.isConnected) el.disabled = false; }
      break;
    case 'cron-preset': {
      const cronInput = $('sched-ed-cron');
      if (cronInput) {
        cronInput.value = el.dataset.cron || cronInput.value;
        updateCronDesc();
      }
      break;
    }
    case 'schedule-toggle':
      await toggleSchedule(id, el);
      break;
    case 'schedule-test':
      await fireSchedule(id, el);
      break;
    case 'schedule-delete':
      openConfirm({ kind: 'schedule', id, opener: el });
      break;
    case 'confirm-cancel':
      closeConfirm();
      break;
    case 'confirm-accept':
      await acceptConfirm(el);
      break;
    case 'group-new':
      applyOpenOptions({ action: 'new-group' });
      render({ frame: true });
      $('sched-ge-name')?.focus();
      break;
    case 'schedule-prompt':
      openPromptScheduleModal();
      break;
    case 'prompt-modal-close':
      closePromptScheduleModal();
      break;
    case 'prompt-modal-pick':
      handlePromptPick(el.dataset.runtime);
      break;
    case 'group-edit':
      if (editorsWait() || !getGroup(id)) break;
      openGroupEditor(id);
      render({ frame: true });
      $('sched-ge-name')?.focus();
      break;
    case 'day-theme-remove': {
      // The whole entry goes, label too: an entry, even an empty one, is what makes the day run.
      if (!_scheduleEditor) break;
      collectScheduleEditorDraft();
      const day = el.dataset.day;
      const themes = { ...(_scheduleEditor.dayThemes || {}) };
      delete themes[day];
      _scheduleEditor.dayThemes = themes;
      renderScheduleEditor();
      $(`sched-ed-day-${day}`)?.focus();
      showToast(`${DAY_LONG[Number(day)] || 'Day'} theme removed`);
      break;
    }
    case 'group-editor-save':
      el.disabled = true;
      try { await saveGroupFromEditor(id || null); } finally { if (el.isConnected) el.disabled = false; }
      break;
    case 'group-editor-cancel': {
      const editedId = _groupEditorId;
      _groupEditorId = null;
      _groupEditorDraft = null;
      render({ frame: true });
      if (editedId) _panel?.querySelector(`.sched-nav-item[data-scope="group:${CSS.escape(editedId)}"]`)?.focus();
      break;
    }
    case 'group-delete':
      openConfirm({ kind: 'group', id, opener: el });
      break;
    case 'group-up':
      await moveGroup(id, -1);
      break;
    case 'group-down':
      await moveGroup(id, 1);
      break;
    case 'qt-select': {
      const minutes = Number(el.dataset.minutes);
      _selectedQtMinutes = _selectedQtMinutes === minutes ? null : minutes;
      _panel.querySelectorAll('[data-action="qt-select"]').forEach(chip => chip.setAttribute('aria-pressed', String(Number(chip.dataset.minutes) === _selectedQtMinutes)));
      const custom = $('sched-qt-custom-min');
      if (custom && _selectedQtMinutes) custom.value = '';
      break;
    }
    case 'qt-go':
      await createQuickTimerFromForm(false);
      break;
    case 'qt-now':
      await createQuickTimerFromForm(true);
      break;
    case 'qt-cancel':
      await cancelQuickTimerById(id);
      break;
    case 'schedule-timer-create':
      await createExistingScheduleTimer();
      break;
    case 'schedule-timer-cancel':
      await cancelExistingScheduleTimer(id);
      break;
  }
}

function toggleExpanded(id, el) {
  if (!id) return;
  if (_expanded.has(id)) _expanded.delete(id); else _expanded.add(id);
  const row = el.closest('.sched-row');
  if (!row) { renderList(); return; }
  // Redraw only this row, so the list keeps its place and the focus stays on the row.
  const schedule = _schedules.find(s => s.id === id);
  if (!schedule) return;
  const showGroup = !!row.querySelector('.sched-row-group');
  const template = document.createElement('template');
  template.innerHTML = rowHTML(schedule, { now: Date.now(), showGroup }).trim();
  const next = template.content.firstElementChild;
  row.replaceWith(next);
  next.querySelector('.sched-row-toggle')?.focus({ preventScroll: true });
  if (_expanded.has(id)) next.querySelector('.sched-detail')?.scrollIntoView({ block: 'nearest' });
}

function focusRow(id) {
  if (!id || !_panel) { $('sched-search')?.focus(); return; }
  const row = [..._panel.querySelectorAll('.sched-row')].find(el => el.dataset.scheduleId === id);
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
    row.querySelector('.sched-row-toggle')?.focus({ preventScroll: true });
  } else {
    $('sched-search')?.focus();
  }
}

async function handleChange(e) {
  const el = e.target;
  const kind = el.dataset?.change;
  if (kind === 'sort') {
    _sort = SORTS.includes(el.value) ? el.value : 'next';
    try { storage.setItem(SORT_KEY, _sort); } catch { /* not remembered */ }
    renderList();
  } else if (kind === 'scope') {
    _query = '';
    setScope(el.value || 'all');
    render({ frame: true });
    controlOf($('sched-scope-select'))?.focus();
  } else if (kind === 'move-group') {
    await moveScheduleToGroup(el.dataset.id, el.value || null);
  }
}

function handleInput(e) {
  if (e.target.id === 'sched-search') {
    _query = e.target.value;
    if (_scope === 'activity') renderActivityList(); else renderList();
  } else {
    // A popup's choice arrives on its hidden input; the mark is on its trigger.
    const field = controlOf(e.target);
    if (field.getAttribute('aria-invalid') === 'true' && field.id !== 'sched-ed-cron') field.removeAttribute('aria-invalid');
  }
}

function handlePanelKeydown(e) {
  if (_confirm && e.key === 'Tab') {
    // Keep the focus inside the dialog.
    const layer = $('sched-dialog-layer');
    const focusable = [...(layer?.querySelectorAll('button:not(:disabled)') || [])];
    if (!focusable.length) return;
    const index = focusable.indexOf(document.activeElement);
    const next = index < 0 ? 0 : (index + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
    e.preventDefault();
    focusable[next].focus();
    return;
  }
  const typing = e.target.closest('input, textarea, select, [contenteditable], [role="combobox"]');
  const find = (!typing && e.key === '/') || ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f');
  if (find && !editorOpen() && !_confirm && $('sched-search') && _scope !== 'timers') {
    e.preventDefault();
    e.stopPropagation();
    $('sched-search').focus();
    $('sched-search').select();
  }
}

function handleEscape(e) {
  if (e.key !== 'Escape' || !_panel || _promptModal) return;
  if (document.querySelector('.menubar-item.open')) return; // the menubar closes its menu first
  const target = e.target;
  // Escape in another window belongs to that window.
  if (target && target !== document.body && !_panel.contains(target) && !target.closest?.('#title-bar')) return;
  e.preventDefault();
  e.stopPropagation();
  // An open popup closes first, and the focus goes back to it (this runs before its own key handler).
  if (closeDropdowns(_panel, { focus: true })) return;
  if (_confirm) { closeConfirm(); return; }
  if (_scheduleEditor) {
    const editedId = _scheduleEditor.id;
    _scheduleEditor = null;
    render({ frame: true });
    focusRow(editedId);
    return;
  }
  if (_groupEditorDraft) {
    _groupEditorId = null;
    _groupEditorDraft = null;
    render({ frame: true });
    $('sched-search')?.focus();
    return;
  }
  if (_query && target?.id === 'sched-search') {
    _query = '';
    target.value = '';
    renderMain();
    return;
  }
  closePanel();
}

// ── Drag a schedule onto a group ──

function handleDragStart(e) {
  const row = e.target.closest?.('.sched-row-line[draggable="true"]')?.closest('.sched-row');
  if (!row) return;
  _draggingScheduleId = row.dataset.scheduleId;
  row.classList.add('is-dragging');
  try { e.dataTransfer.setData('text/plain', _draggingScheduleId); } catch {}
  e.dataTransfer.effectAllowed = 'move';
}

function clearDropTargets() {
  _panel?.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
}

function handleDragEnd() {
  _draggingScheduleId = null;
  _panel?.querySelectorAll('.sched-row.is-dragging').forEach(el => el.classList.remove('is-dragging'));
  clearDropTargets();
}

function handleDragOver(e) {
  if (!_draggingScheduleId) return;
  const target = e.target.closest('[data-drop-group]');
  if (!target) { clearDropTargets(); return; }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!target.classList.contains('drop-target')) {
    clearDropTargets();
    target.classList.add('drop-target');
  }
}

function handleDragLeave(e) {
  const target = e.target.closest?.('[data-drop-group]');
  if (target && !target.contains(e.relatedTarget)) target.classList.remove('drop-target');
}

async function handleDrop(e) {
  if (!_draggingScheduleId) return;
  const target = e.target.closest('[data-drop-group]');
  if (!target) return;
  e.preventDefault();
  const id = _draggingScheduleId;
  handleDragEnd();
  await moveScheduleToGroup(id, target.dataset.dropGroup || null);
}

// ── Writes ──

function replaceSchedule(updated) {
  const idx = _schedules.findIndex(s => s.id === updated.id);
  if (idx >= 0) _schedules[idx] = updated;
  else _schedules.push(updated);
}

async function moveScheduleToGroup(id, groupId) {
  const schedule = _schedules.find(s => s.id === id);
  if (!schedule || (schedule.groupId || null) === (groupId || null)) return;
  try {
    replaceSchedule(await updateSchedule(id, { groupId }));
    showToast(groupId ? `Moved to ${getGroup(groupId)?.name || 'group'}` : 'Moved to Ungrouped');
    refresh();
  } catch (err) {
    showToast('Move failed: ' + err.message);
    refresh();
  }
}

async function toggleSchedule(id, el = null) {
  const schedule = _schedules.find(s => s.id === id);
  if (!schedule) return;
  el?.setAttribute('aria-busy', 'true');
  try {
    replaceSchedule(await updateSchedule(id, { enabled: !schedule.enabled }));
    const updated = _schedules.find(s => s.id === id);
    showToast(updated?.enabled ? `${schedule.name} is back on its timetable` : `${schedule.name} is paused`);
    refresh();
  } catch (err) {
    el?.removeAttribute('aria-busy');
    showToast('Toggle failed: ' + err.message);
  }
}

async function fireSchedule(id, el = null) {
  if (el) el.disabled = true;
  try {
    await testSchedule(id, {
      sidepanelWindowId: getNativeLoopRouterWindowId(),
      sidepanelClaimToken: getNativeLoopRouterClaimToken(),
    });
    showToast('Launching schedule…');
  } catch (err) {
    showToast('Run failed: ' + err.message);
  } finally {
    if (el?.isConnected) el.disabled = false;
  }
}

// ── Confirmation (destructive actions) ──

function openConfirm({ kind, id, opener }) {
  const layer = $('sched-dialog-layer');
  if (!layer) return;
  let title, name, text, accept;
  if (kind === 'schedule') {
    const schedule = _schedules.find(s => s.id === id);
    if (!schedule) return;
    title = 'Delete this schedule?';
    name = schedule.name;
    text = 'It stops running and cannot be restored. The automation it launches stays in Automation Studio.';
    accept = 'Delete schedule';
  } else {
    const group = getGroup(id);
    if (!group) return;
    const count = _schedules.filter(s => s.groupId === id).length;
    title = 'Delete this group?';
    name = group.name;
    text = count ? `Its ${plural(count, 'schedule')} move to Ungrouped and keep running.` : 'The group is empty.';
    accept = 'Delete group';
  }
  _confirm = { kind, id, opener };
  layer.innerHTML = `<div class="sched-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sched-dialog-title" aria-describedby="sched-dialog-text">
    <h4 id="sched-dialog-title">${esc(title)}</h4>
    <div class="sched-dialog-body">
      <p class="sched-dialog-name">${esc(name)}</p>
      <p class="sched-help" id="sched-dialog-text">${esc(text)}</p>
    </div>
    <div class="sched-dialog-actions">
      <button type="button" class="sched-btn" data-action="confirm-cancel">Cancel</button>
      <button type="button" class="sched-btn sched-btn--danger" data-action="confirm-accept">${ICONS.trash}<span>${esc(accept)}</span></button>
    </div>
  </div>`;
  layer.hidden = false;
  for (const part of _panel.querySelectorAll(':scope > .sched-header, :scope > .sched-body')) part.inert = true;
  layer.querySelector('[data-action="confirm-cancel"]')?.focus();
}

function closeConfirm() {
  const layer = $('sched-dialog-layer');
  if (layer) { layer.hidden = true; layer.innerHTML = ''; }
  for (const part of _panel?.querySelectorAll(':scope > .sched-header, :scope > .sched-body') || []) part.inert = false;
  const opener = _confirm?.opener;
  _confirm = null;
  if (opener?.isConnected) opener.focus();
}

async function acceptConfirm(button) {
  if (!_confirm) return;
  const { kind, id } = _confirm;
  button.disabled = true;
  try {
    if (kind === 'schedule') {
      await deleteSchedule(id);
      _schedules = _schedules.filter(s => s.id !== id);
      _expanded.delete(id);
      showToast('Schedule deleted');
    } else {
      await deleteScheduleGroup(id);
      _groups = _groups.filter(g => g.id !== id);
      for (const schedule of _schedules) if (schedule.groupId === id) schedule.groupId = null;
      if (_scope === `group:${id}`) setScope('ungrouped', { keepEditors: true });
      if (_groupEditorId === id) { _groupEditorId = null; _groupEditorDraft = null; }
      showToast('Group deleted');
    }
    _confirm.opener = null;
    closeConfirm();
    render({ frame: true });
    $('sched-search')?.focus();
  } catch (err) {
    button.disabled = false;
    showToast(`${kind === 'schedule' ? 'Delete' : 'Group delete'} failed: ${err.message}`);
  }
}

// ── Groups ──

async function saveGroupFromEditor(id) {
  if (editorsWait()) { showToast('The schedules have not loaded yet: save once they have'); return; }
  collectGroupEditorDraft();
  const name = $('sched-ge-name')?.value?.trim();
  if (!name) { markInvalid('sched-ge-name', 'Group name is required'); return; }
  const color = $('sched-ge-color')?.value || null;
  const mutualExclusion = !!$('sched-ge-mutex')?.checked;
  const browserRaw = $('sched-ge-browser')?.value || '';
  const launch = {
    profile: $('sched-ge-profile')?.value || null,
    model: $('sched-ge-model')?.value || null,
    contextMode: $('sched-ge-context')?.value || null,
    effort: $('sched-ge-effort')?.value || null, // 'off' stays explicit
    mcpProfile: $('sched-ge-mcp')?.value || null,
    codexAccountId: $('sched-ge-account')?.value || null, // read whatever the CLI: hidden is not cleared
    usesBrowser: browserRaw === '' ? null : browserRaw === 'true',
  };
  // The group as it was when the editor opened, not as a sync update has made it since.
  const existing = id ? _groupEditorDraft?._original || getGroup(id) || {} : null;
  if (!existing || ['profile', 'model', 'contextMode', 'codexAccountId'].some(k => !sameValue(launch[k], existing[k]))) {
    const effectiveProfile = launch.profile || 'claude-code';
    if (!modelChoiceAvailable(effectiveProfile, launch.model, launch.codexAccountId || 'default')) {
      showToast('This model is unavailable for the selected account'); return;
    }
    if (!contextChoiceAvailable(effectiveProfile, launch.model, launch.contextMode, launch.codexAccountId || 'default')) {
      showToast('This context window is unavailable for the selected model and account'); return;
    }
  }

  // The save belongs to this editor: once it is answered, the window goes to the group only while
  // this editor is still the one open. One opened meanwhile (or a closed window) is left as it is.
  const draft = _groupEditorDraft;
  const panel = _panel;
  const stillHere = () => !!draft && _panel === panel && _groupEditorDraft === draft;

  if (!id) {
    try {
      const payload = { name, color, mutualExclusion };
      for (const key of LAUNCH_FIELDS) if (launch[key] !== null) payload[key] = launch[key];
      const group = await createScheduleGroup(payload);
      if (!_groups.some(g => g.id === group.id)) _groups.push(group);
      showToast('Group created');
      if (!stillHere()) { refresh(); return; }
      _groupEditorId = null;
      _groupEditorDraft = null;
      _query = '';
      setScope(`group:${group.id}`);
      render({ frame: true });
      _panel?.querySelector(`.sched-nav-item[data-scope="group:${CSS.escape(group.id)}"]`)?.focus();
    } catch (err) {
      showToast('Group failed: ' + err.message);
    }
    return;
  }

  // Send only what the user changed. The server pushes a changed group launch field onto every
  // schedule in the group, so an unchanged one sent anyway would overwrite their own choices.
  // The colour counts as changed when it differs from what showed (an unset one shows the default).
  const payload = {};
  if (name !== String(existing.name ?? '').trim()) payload.name = name;
  const shownColor = /^#[0-9a-f]{6}$/i.test(existing.color || '') ? existing.color.toLowerCase() : DEFAULT_GROUP_COLOR;
  if (color && color.toLowerCase() !== shownColor) payload.color = color;
  if (mutualExclusion !== !!existing.mutualExclusion) payload.mutualExclusion = mutualExclusion;
  for (const key of LAUNCH_FIELDS) if (!sameValue(launch[key], existing[key])) payload[key] = launch[key];
  // A new CLI: what the old one decided goes, explicitly (also what the group never set itself).
  const cliChanged = !sameValue(launch.profile, existing.profile);
  if (cliChanged) for (const key of CLI_DEPENDENT) payload[key] = launch[key];
  if (!Object.keys(payload).length) {
    _groupEditorId = null;
    _groupEditorDraft = null;
    render({ frame: true });
    _panel?.querySelector(`.sched-nav-item[data-scope="group:${CSS.escape(id)}"]`)?.focus();
    showToast('No changes to save');
    return;
  }
  // What each schedule of the group holds as the user saves: a reset afterwards writes only over
  // values that are still these.
  const members = cliChanged ? captureMembers(id, launch) : [];
  try {
    const updated = await updateScheduleGroup(id, payload);
    const idx = _groups.findIndex(g => g.id === id);
    if (idx >= 0) _groups[idx] = updated;
    if (stillHere()) {
      _groupEditorId = null;
      _groupEditorDraft = null;
      setScope(`group:${id}`);
      render({ frame: true });
      _panel?.querySelector(`.sched-nav-item[data-scope="group:${CSS.escape(id)}"]`)?.focus();
    }
    if (!cliChanged) {
      showToast('Group updated');
    } else {
      _cliReport = { groupId: id, profile: launch.profile, pending: true };
      renderNote();
      const result = await resetSchedulesForCli(id, launch, members);
      _cliReport = { groupId: id, profile: launch.profile, ...result };
      renderNote();
      const kept = result.changed.length + result.failed.length;
      showToast(kept
        ? `Group updated. ${plural(kept, 'schedule')} kept the old CLI's settings: the group's page names ${kept === 1 ? 'it' : 'them'}`
        : 'Group updated');
    }
    // The schedules show what the save pushed onto them. From here on nothing is navigated:
    // the user may have opened something else meanwhile, and it stays as it is.
    await loadData();
  } catch (err) {
    showToast('Group update failed: ' + err.message);
  }
}

const RESET_KEYS = ['profile', ...CLI_DEPENDENT];

/** The schedules of a group that hold a value of their own the group's new launch values replace. */
function captureMembers(groupId, launch) {
  return _schedules.filter(s => s.groupId === groupId)
    .map(s => ({ id: s.id, name: s.name || s.id, values: Object.fromEntries(RESET_KEYS.map(k => [k, blankToNull(s[k])])) }))
    .filter(m => RESET_KEYS.some(k => m.values[k] !== null && m.values[k] !== blankToNull(launch[k])));
}

// server.js pushes a group field onto the group's schedules only when the group's own value
// changed. A schedule's own model, context, thinking, tools or account under a group that had
// none of its own would survive a change of CLI and launch the new CLI with the old one's model.
// So after the group is saved, each schedule that was in it when the user saved is read again
// right before its write, and gets the group's new values only while it is still in the group and
// each of those values is still what it was at the save (or what the save itself pushed onto it).
// One that moved or took a newer value meanwhile is left alone; one that cannot be read is not
// written, and when a read gets no answer at all the rest are not tried. Never from a cached list.
async function resetSchedulesForCli(groupId, launch, members) {
  const report = { reset: [], changed: [], failed: [] };
  const target = (key) => blankToNull(launch[key]);
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    let fresh;
    try {
      fresh = await withDeadline(fetchSchedule(member.id));
    } catch (err) {
      if (err?.timeout) { report.failed.push(...members.slice(i).map(m => m.name)); break; }
      report.failed.push(member.name);
      continue;
    }
    const name = fresh?.name || member.name;
    const moved = !fresh || fresh.groupId !== groupId;
    const changed = moved || RESET_KEYS.some(key => {
      const now = blankToNull(fresh[key]);
      return now !== member.values[key] && now !== target(key);
    });
    if (changed) { report.changed.push(name); continue; }
    const reset = {};
    for (const key of RESET_KEYS) if (blankToNull(fresh[key]) !== null && blankToNull(fresh[key]) !== target(key)) reset[key] = launch[key];
    if (!Object.keys(reset).length) continue; // the save's own push already did it
    try {
      const saved = await updateSchedule(member.id, reset);
      const idx = _schedules.findIndex(s => s.id === saved?.id);
      if (idx >= 0) _schedules[idx] = saved;
      report.reset.push(name);
    } catch {
      report.failed.push(name);
    }
  }
  return report;
}

async function moveGroup(id, direction) {
  const ordered = orderedGroups();
  const idx = ordered.findIndex(g => g.id === id);
  const next = idx + direction;
  if (idx < 0 || next < 0 || next >= ordered.length) return;
  const copy = [...ordered];
  const [moved] = copy.splice(idx, 1);
  copy.splice(next, 0, moved);
  try {
    collectGroupEditorDraft();
    await reorderScheduleGroups(copy.map(g => g.id));
    _groups = copy.map((g, i) => ({ ...g, order: i }));
    renderRail();
    if (_groupEditorDraft) renderGroupEditor(getGroup(id));
    else renderMain(true);
    // Keep the focus on the button that was pressed, or on the other one once it reached an end.
    const pressed = _panel?.querySelector(`[data-action="${direction < 0 ? 'group-up' : 'group-down'}"]`);
    (pressed && !pressed.disabled ? pressed : _panel?.querySelector(`[data-action="${direction < 0 ? 'group-down' : 'group-up'}"]`))?.focus();
  } catch (err) {
    showToast('Reorder failed: ' + err.message);
  }
}

// ── Prompt a Schedule ──

function openPromptScheduleModal() {
  if (_promptModal) return;

  _promptBackdrop = document.createElement('div');
  _promptBackdrop.className = 'sched-prompt-backdrop';
  _promptBackdrop.addEventListener('click', closePromptScheduleModal);
  document.body.appendChild(_promptBackdrop);

  const claudeMeta = getProviderMeta('claude-code');
  const opencodeMeta = getProviderMeta('opencode');
  const codexMeta = getProviderMeta('codex');
  _promptModal = document.createElement('div');
  _promptModal.className = 'sched-prompt-modal glass';
  _promptModal.setAttribute('role', 'dialog');
  _promptModal.setAttribute('aria-modal', 'true');
  _promptModal.setAttribute('aria-labelledby', 'sched-prompt-title');
  _promptModal.innerHTML = `
    <header class="sched-prompt-head">
      <div class="sched-prompt-head-text">
        <span class="sched-prompt-icon">${ICONS.sparkle}</span>
        <div>
          <h3 id="sched-prompt-title">Prompt a Schedule</h3>
          <p>Start the schedule draft in a sidepanel.</p>
        </div>
      </div>
      <button class="sched-prompt-close" data-action="prompt-modal-close" aria-label="Close">${ICONS.close}</button>
    </header>
    <div class="sched-prompt-tiles">
      <button class="sched-prompt-tile" style="--provider-color:${claudeMeta.color};" data-action="prompt-modal-pick" data-runtime="claude-code">
        <span class="sched-prompt-tile-logo" aria-hidden="true">${claudeMeta.icon}</span>
        <span class="sched-prompt-tile-body">
          <span class="sched-prompt-tile-title">${claudeMeta.label}</span>
          <span class="sched-prompt-tile-sub">Anthropic</span>
        </span>
        <span class="sched-prompt-pill sched-prompt-pill--active">Ready</span>
      </button>
      <button class="sched-prompt-tile disabled" style="--provider-color:${opencodeMeta.color};" disabled aria-disabled="true">
        <span class="sched-prompt-tile-logo" aria-hidden="true">${opencodeMeta.icon}</span>
        <span class="sched-prompt-tile-body">
          <span class="sched-prompt-tile-title">${opencodeMeta.label}</span>
          <span class="sched-prompt-tile-sub">Multi-provider</span>
        </span>
        <span class="sched-prompt-pill">Planned</span>
      </button>
      <button class="sched-prompt-tile disabled" style="--provider-color:${codexMeta.color};" disabled aria-disabled="true">
        <span class="sched-prompt-tile-logo" aria-hidden="true">${codexMeta.icon}</span>
        <span class="sched-prompt-tile-body">
          <span class="sched-prompt-tile-title">Codex CLI</span>
          <span class="sched-prompt-tile-sub">OpenAI</span>
        </span>
        <span class="sched-prompt-pill">Planned</span>
      </button>
    </div>
  `;
  _promptModal.addEventListener('click', handlePromptModalClick);
  document.body.appendChild(_promptModal);

  _promptKeyHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePromptScheduleModal(); } };
  document.addEventListener('keydown', _promptKeyHandler);

  requestAnimationFrame(() => {
    _promptBackdrop?.classList.add('open');
    _promptModal?.classList.add('open');
    _promptModal?.querySelector('.sched-prompt-tile:not(.disabled)')?.focus();
  });
}

function handlePromptModalClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !_promptModal?.contains(el)) return;
  const action = el.dataset.action;
  if (action === 'prompt-modal-close') {
    closePromptScheduleModal();
  } else if (action === 'prompt-modal-pick') {
    handlePromptPick(el.dataset.runtime, el);
  }
}

function closePromptScheduleModal() {
  if (_promptKeyHandler) {
    document.removeEventListener('keydown', _promptKeyHandler);
    _promptKeyHandler = null;
  }
  const hadModal = !!_promptModal;
  _promptBackdrop?.remove();
  _promptModal?.remove();
  _promptBackdrop = null;
  _promptModal = null;
  if (hadModal && _panel) _panel.querySelector('[data-action="schedule-prompt"]')?.focus();
}

async function handlePromptPick(runtime, triggerEl = null) {
  if (runtime !== 'claude-code') {
    showToast('Coming soon — Claude Code only for now');
    return;
  }
  if (triggerEl) {
    triggerEl.disabled = true;
    triggerEl.setAttribute('aria-busy', 'true');
  }
  try {
    await sendToPanel('/synabun schedule', { newTab: true, tabLabel: 'Schedule Wizard', autoSubmit: true });
  } catch (err) {
    showToast('Failed to open Claude panel: ' + err.message);
  } finally {
    closePromptScheduleModal();
  }
}

// ── Timers: writes ──

async function createQuickTimerFromForm(runNow) {
  const templateId = $('sched-qt-template')?.value;
  if (!templateId) { markInvalid('sched-qt-template', 'Choose an automation first'); return; }
  const customVal = Number($('sched-qt-custom-min')?.value);
  const minutes = customVal >= 1 ? customVal : _selectedQtMinutes;
  if (!runNow && !minutes) { showToast('Choose a delay or enter minutes'); return; }
  const template = getTemplate(templateId);
  const profile = $('sched-qt-profile')?.value || 'claude-code';
  const model = $('sched-qt-model')?.value || null;
  const contextMode = $('sched-qt-context')?.value || 'default';
  if (!modelChoiceAvailable(profile, model, _launchAccount)) {
    showToast('This model is unavailable for the selected account'); return;
  }
  if (!contextChoiceAvailable(profile, model, contextMode, _launchAccount)) {
    showToast('This context window is unavailable for the selected model and account'); return;
  }
  const effortRaw = $('sched-qt-effort')?.value || null;
  const effort = normalizeEffortForProfile(profile, effortRaw);
  const mcpProfile = profile !== 'claude-code' ? ($('sched-qt-mcp')?.value || _launchMcpProfile || null) : null;
  const codexAccountId = profile === 'codex' ? ($('sched-qt-account')?.value || _launchAccount || 'default') : undefined;
  const usesBrowser = _qtUsesBrowser !== null ? _qtUsesBrowser : !!template?.usesBrowser;
  try {
    if (runNow) {
      const result = await triggerQuickTimerNow(templateId, {
        profile, model, contextMode, effort, mcpProfile, usesBrowser, codexAccountId,
        sidepanelWindowId: getNativeLoopRouterWindowId(),
        sidepanelClaimToken: getNativeLoopRouterClaimToken(),
      });
      showToast(`Running now: ${result.templateName}`);
    } else {
      const result = await createQuickTimer(templateId, minutes, { profile, model, contextMode, effort, mcpProfile, usesBrowser, codexAccountId });
      if (!_quickTimers.some(t => t.id === result.timerId)) {
        _quickTimers.push({ id: result.timerId, templateId, templateName: result.templateName, firesAt: result.firesAt, minutes: result.minutes, profile: result.profile, model: result.model, contextMode: result.contextMode, effort: result.effort, mcpProfile: result.mcpProfile, usesBrowser: result.usesBrowser });
      }
      _selectedQtMinutes = null;
      _panel?.querySelectorAll('[data-action="qt-select"]').forEach(chip => chip.setAttribute('aria-pressed', 'false'));
      showToast(`Timer set: ${result.templateName}`);
    }
    renderActiveTimersInto();
    renderRail();
  } catch (err) {
    showToast((runNow ? 'Run now' : 'Timer') + ' failed: ' + err.message);
  }
}

async function cancelQuickTimerById(id) {
  try {
    await cancelQuickTimer(id);
    _quickTimers = _quickTimers.filter(t => t.id !== id);
    renderActiveTimersInto();
    renderRail();
    showToast('Timer cancelled');
  } catch (err) {
    showToast('Cancel failed: ' + err.message);
  }
}

async function createExistingScheduleTimer() {
  const scheduleId = $('sched-existing-timer-schedule')?.value;
  const minutes = Number($('sched-existing-timer-min')?.value);
  if (!scheduleId) { markInvalid('sched-existing-timer-schedule', 'Choose a schedule'); return; }
  if (!minutes || minutes < 1) { markInvalid('sched-existing-timer-min', 'Enter the minutes from now'); return; }
  try {
    const result = await startScheduleTimer(scheduleId, minutes);
    _scheduleTimerData[scheduleId] = { firesAt: result.firesAt, minutes: result.minutes };
    renderActiveTimersInto();
    renderRail();
    showToast('Schedule timer set');
  } catch (err) {
    showToast('Timer failed: ' + err.message);
  }
}

async function cancelExistingScheduleTimer(id) {
  try {
    await cancelScheduleTimer(id);
    delete _scheduleTimerData[id];
    renderActiveTimersInto();
    renderRail();
    showToast('Timer cancelled');
  } catch (err) {
    showToast('Cancel failed: ' + err.message);
  }
}

// ── Every second: countdowns ──

function updateTimerCountdowns() {
  if (!_panel) return;
  const now = Date.now();
  _panel.querySelectorAll('.sched-timer-count[data-fires-at]').forEach(el => {
    el.textContent = formatTimerCountdown(el.dataset.firesAt);
  });
  let stale = false;
  _panel.querySelectorAll('[data-countdown]').forEach(el => {
    const iso = el.dataset.countdown;
    if (!iso) return;
    const countdown = formatCountdown(iso, now);
    const rel = el.querySelector('.sched-next-rel') || el;
    if (rel.textContent !== countdown.text) rel.textContent = countdown.text;
    if (el.classList.contains('sched-next')) el.dataset.state = countdown.state;
    if (Date.parse(iso) < now - 90_000) stale = true;
  });
  // A run's time has passed and no update came: ask the server, at most once a minute.
  if (stale && now - _lastAutoRefresh > 60_000 && !editorOpen()) {
    _lastAutoRefresh = now;
    scheduleRefresh(0);
  }
}

// ── Live updates over the sync socket ──

function setupSync() {
  if (_syncReady) return;
  _syncReady = true;

  on('sync:schedule:created', (data) => {
    if (!data?.schedule) return;
    if (!_schedules.some(s => s.id === data.schedule.id)) _schedules.push(data.schedule);
    refresh();
  });
  on('sync:schedule:updated', (data) => {
    if (!data?.schedule) return;
    replaceSchedule(data.schedule);
    refresh();
  });
  on('sync:schedule:deleted', (data) => {
    if (!data?.scheduleId) return;
    _schedules = _schedules.filter(s => s.id !== data.scheduleId);
    _expanded.delete(data.scheduleId);
    refresh();
  });
  on('sync:schedule:fired', (data) => {
    if (data?.scheduleName) showToast(`Schedule fired: ${data.scheduleName}`);
    if (_panel) scheduleRefresh();
  });
  on('sync:schedule:completed', (data) => {
    if (_panel) scheduleRefresh();
    if (data?.terminalSessionId && data.surface !== 'sidepanel') {
      emit('terminal:attach-floating', {
        terminalSessionId: data.terminalSessionId,
        profile: data.profile || 'claude-code',
        snapToPanel: false,
      });
    }
  });
  on('sync:schedule:failed', (data) => {
    if (data?.reason) showToast(`Schedule failed: ${data.reason}`);
    if (_panel) scheduleRefresh();
  });
  on('sync:schedule:timer-set', (data) => {
    if (data?.scheduleId && data?.firesAt) {
      _scheduleTimerData[data.scheduleId] = { firesAt: data.firesAt, minutes: data.minutes };
      if (_panel) { renderRail(); renderActiveTimersInto(); }
    }
  });
  on('sync:schedule:timer-fired', (data) => {
    if (data?.scheduleName) showToast(`Timer fired: ${data.scheduleName}`);
    if (data?.scheduleId) delete _scheduleTimerData[data.scheduleId];
    if (_panel) { renderRail(); renderActiveTimersInto(); }
  });
  on('sync:schedule:timer-cancelled', (data) => {
    if (data?.scheduleId) delete _scheduleTimerData[data.scheduleId];
    if (_panel) { renderRail(); renderActiveTimersInto(); }
  });
  on('sync:schedule-group:created', (data) => {
    if (data?.group && !_groups.some(g => g.id === data.group.id)) _groups.push(data.group);
    refresh();
  });
  on('sync:schedule-group:updated', (data) => {
    if (!data?.group) return;
    const idx = _groups.findIndex(g => g.id === data.group.id);
    if (idx >= 0) _groups[idx] = data.group;
    else _groups.push(data.group);
    refresh();
  });
  on('sync:schedule-group:deleted', (data) => {
    if (!data?.groupId) return;
    _groups = _groups.filter(g => g.id !== data.groupId);
    for (const schedule of _schedules) if (schedule.groupId === data.groupId) schedule.groupId = null;
    if (_scope === `group:${data.groupId}`) setScope('ungrouped', { keepEditors: true });
    refresh();
  });
  on('sync:schedule-group:reordered', (data) => {
    if (Array.isArray(data?.groups)) _groups = data.groups;
    refresh();
  });
  on('sync:quick-timer:set', (data) => {
    if (data?.timerId && !_quickTimers.some(t => t.id === data.timerId)) {
      _quickTimers.push({ id: data.timerId, templateName: data.templateName, firesAt: data.firesAt, minutes: data.minutes, profile: data.profile, model: data.model, contextMode: data.contextMode, effort: data.effort, mcpProfile: data.mcpProfile, usesBrowser: data.usesBrowser });
      if (_panel) { renderRail(); renderActiveTimersInto(); }
    }
  });
  on('sync:quick-timer:fired', (data) => {
    if (data?.templateName) showToast(`Timer fired: ${data.templateName}`);
    if (data?.timerId) _quickTimers = _quickTimers.filter(t => t.id !== data.timerId);
    if (_panel) { renderRail(); renderActiveTimersInto(); }
  });
  on('sync:quick-timer:fired-now', (data) => {
    if (data?.templateName) showToast(`Running now: ${data.templateName}`);
  });
  on('sync:quick-timer:cancelled', (data) => {
    if (data?.timerId) _quickTimers = _quickTimers.filter(t => t.id !== data.timerId);
    if (_panel) { renderRail(); renderActiveTimersInto(); }
  });
  on('sync:quick-timer:failed', (data) => {
    if (data?.reason) showToast(`Timer failed: ${data.reason}`);
  });
}

