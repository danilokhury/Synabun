// ═══════════════════════════════════════════
// SynaBun Assistant — panel (mount / lifecycle)
// ═══════════════════════════════════════════
// mountAssistant(viewport, { sessionId, brain, host }) builds the assistant
// UI inside a viewport owned by a host and returns the controller the host
// talks to. Two hosts mount this same component — the terminal tab
// (ui-terminal.js, `.term-viewport.assistant-viewport`) and the sidepanel
// (asst-sidepanel.js, `.asp-viewport`) — so every feature exists in both.
// Never branch on which host this is: `host.id` only rides along on the
// assistant:new / assistant:resume / assistant:focused events so New and
// History open in the same host (ui-assistant.js routes them), and
// `host.notifySource` picks the Settings → Notifications source.
// Layout: a flush toolbar (route mode · context · computer | agents · cost ·
// history · new · "⋯") · banners · transcript (role=log, not a live region:
// each rack speaks through its own status/alert, and the turn's answer and
// errors through one panel status) · bottom card
// (computer tray, agents tray, composer: input · attach · model · effort ·
// permission mode / send). `host.toolbarSlot` is placement only: a host that
// has its own header (the sidepanel) passes an element and the same toolbar,
// with the same wiring, lives there instead of at the top of the root. The tab is
// always called SynaBun unless the user renames it; the session's own title
// (first prompt) only names it in the history menu and in notifications.
// Notifies through ui-notifications when hidden. The mascot on screen (the
// empty state's hero, the live rack's stage) wears the panel's state through
// asst-mascot.js: watching you type, blocked on a card, offline, asleep, and a
// success or error when a turn that did real work ends.

import { emit, on, state as appState } from '../state.js';
import { storage } from '../storage.js';
import { KEYS } from '../constants.js';
import { t } from '../i18n.js';
import { notify, NOTIF_TYPE } from '../ui-notifications.js';
import { getProviderMeta } from '../provider-icons.js';
import { isGuest, hasPermission } from '../ui-sync.js';
import { getWhiteboardElementById } from '../ui-whiteboard.js';
import { focusNativeLoopRun } from '../ui-native-loop-router.js';
import { injectAssistantStyles } from './asst-styles.js';
import { createAssistantSocket } from './asst-ws.js';
import { createRenderer, ICON_ASSISTANT, mdInto } from './asst-render.js';
import { createMascotDirector, MASCOT_TIMING, turnEndPose } from './asst-mascot.js';
import { lastInputAt, onKey, onPointer } from '../synabun-ticker.js';
import { buildControlResponse, closedControlState, normalizeControlRequest, renderControlCard } from './asst-control.js';
import { buildPromptText, createComposer } from './asst-composer.js';
import { buildDispatchSpec, parseSlashCommand, slashHelpMarkdown } from './asst-slash.js';
import { createBrainPicker } from './asst-brain-picker.js';
import { createRovingToolbar } from './asst-roving.js';
import { openAccountsManager } from './asst-accounts.js';
import { createAgentsDock } from './asst-agents-dock.js';
import { createUsageGauge } from './asst-usage.js';
import { closeMenu, isMenuOpen, openMenu } from './asst-menu.js';
import { createRouteModeControl, openModelsManager, openRoutesEditor, refreshModelsManager, renderRouteCard, routeModeLabel } from './asst-route.js';
import { budgetChipText, budgetTone, openBudgetEditor } from './asst-budget.js';
import { computerRemoteView, createComputerPanel, createComputerToggle, normalizeComputerRemote, openFrameLightbox, closeFrameLightbox, requestDesktopStop } from './asst-computer.js';
import {
  applyLimit, applyLimitPacket, applyUsagePacket, brainLabel, createTabState, DEFAULT_ROUTE_MODE, deserializeTabState, fmtCost, fmtRunLine, limitExpiresIn, limitNoticeText, modelShortName,
  brainModePatch, normalizeBrain, normalizeComputerMode, permissionModeLabel, normalizeRouteMode, providerShortLabel, readStoredBrain, runFromPayload,
  serializeTabState, tabStorageKey,
} from './asst-state.js';
import {
  closeAssistantSession, dispatchAssistantRun, escalateAssistantRun, focusAssistantRun, getAssistantRun,
  fetchManageCatalog, getAssistantRunResult, getAssistantSession, getAssistantSessionUsage, getDesktopStatus, getRouting, killAllAssistantRuns, removeAssistantRun, clearFinishedAssistantRuns,
  listAssistantSessions, patchAssistantSession, patchHiddenModels, stopAssistantRun, uploadAssistantAttachment,
} from './asst-api.js';

const ICON_SESSIONS = '<svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h12"/></svg>';
const ICON_AGENTS = '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19a6 6 0 0 1 12 0M14.5 19a4.5 4.5 0 0 1 7-3.7"/></svg>';
const ICON_NEW = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_COG = '<svg viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
const ICON_ROUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h13l-3-3M20 17H7l3 3"/></svg>';
const ICON_COMPUTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const REPLAY_WAIT_MS = 1500; // a replay that stops short of its count is drawn after this long

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tt(key, fallback, params) {
  const v = t(key, params);
  if (v && v !== key && typeof v === 'string') return v;
  return params ? String(fallback).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`)) : fallback;
}

function num(value) {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) ? n : null;
}

function basename(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '');
}

function relativeTime(value) {
  const ms = new Date(value || 0).getTime();
  if (!ms) return '';
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return tt('assistant.time.justNow', 'just now');
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function clipCopy(text) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
}

/**
 * mountAssistant(viewport, { sessionId, brain, host, session })
 * host: { id: 'terminal'|'sidepanel', notifySource: 'cli'|'panel',
 *         setLabel(text), setStatus('idle'|'working'|'action'|'done'), setBrain(brain),
 *         isVisible() → bool, toolbarSlot?: Element (where the toolbar goes; default the root),
 *         takeHeroOrigin?() → DOMRect | null (a character the host showed while starting: the empty state's flies in from it) }
 * The hooks may fire during mount, before this returns.
 * The tab label is always "SynaBun"; a user rename arrives via controller.setTitle.
 */
export function mountAssistant(viewport, { sessionId, brain, host = {}, session = null } = {}) {
  injectAssistantStyles();
  const saved = deserializeTabState(storage.getItem(tabStorageKey(sessionId)));
  const st = createTabState(sessionId, brain || session?.brain || saved?.brain || readStoredBrain(storage), {
    title: tt('assistant.defaultTitle', 'SynaBun'),
    // The agents tray starts collapsed; it only expands on request.
    dockOpen: saved ? saved.dockOpen : storage.getItem(KEYS.ASSISTANT_DOCK_OPEN) === '1',
    dockShowAll: saved ? saved.dockShowAll : storage.getItem(KEYS.ASSISTANT_DOCK_SHOW_ALL) === '1',
    draft: saved?.draft || '',
    costUsd: Number(session?.costUsd) || saved?.costUsd || 0,
    providerSessionId: session?.providerSessionId || null,
    routeMode: saved?.routeMode ?? null,
    computerUse: saved?.computerUse ?? null,
    usageView: saved?.usageView || null,
  });
  Object.assign(st, {
    status: 'idle',
    dispatchUsd: 0,
    serverCost: false,
    engine: '',
    sdkVersion: '',
    routing: null,                                 // server view { mode, effectiveMode, defaultMode, askBelow }
    features: { routing: null, computer: null },   // null = unknown yet
    brainCapabilities: null,
    computerEffective: st.computerUse === true,
    desktopSupported: null,
    setupInfo: null,
    desktopActive: false,
    desktopProbe: false,
    routingProbe: false,
    sessionTitle: String(session?.title || ''),  // the server's name (first prompt): history + notifications, never the tab
  });
  const controls = new Map(); // requestId → { card, origin, kind }
  // Cards answered here (requestId → card): one the server closed before the answer
  // arrived (control_cancelled after it) says so instead of keeping "Allowed".
  const answeredCards = new Map();
  const routeCards = new Map(); // routeId → route card entry
  const clarifyCards = new Set(); // requestIds of clarify cards shown here (the card records their outcome)
  // Prompts this panel sent (request_id → { payload, row }): one the server refuses comes back to the composer.
  const sentQueries = new Map();
  let querySeq = 0;
  // A reattach's buffered replay: the packets that went out while this panel was away. They are
  // collected (reattach_result says how many), filtered against what is on screen (renderer.planReplay:
  // the journal snapshot drew most of them) and drawn like the journal; the reattach_result, not a
  // replayed `done`, `aborted` or `turn_started`, says whether a turn runs now.
  let replay = null; // { left, packets, timer }
  let replaying = false;
  const unsubs = [];
  let destroyed = false;
  let persistTimer = null;
  let helpModal = null;
  let director = null; // the mascot on screen (asst-mascot.js), made once the renderer and the composer exist

  // ── DOM ──
  const root = el('div', 'asst-root');
  root.dataset.status = 'idle';
  root.innerHTML = `
    <div class="asst-bar" role="toolbar" aria-label="${esc(tt('assistant.toolbar.label', 'Assistant controls'))}">
      <div class="asst-bar-left">
        <div class="asst-bar-group" data-group="route"></div>
        <div class="asst-bar-group" data-group="context"></div>
        <div class="asst-bar-group" data-group="computer"></div>
      </div>
      <div class="asst-bar-right">
        <button type="button" class="asst-iconbtn asst-act-agents" hidden aria-pressed="false" data-tooltip="${esc(tt('assistant.topbar.agents', 'Dispatched agents'))}" aria-label="${esc(tt('assistant.topbar.agents', 'Dispatched agents'))}">${ICON_AGENTS}<span class="asst-count">0</span></button>
        <button type="button" class="asst-cost" hidden aria-label="${esc(tt('assistant.budget.title', 'Budget'))}"></button>
        <button type="button" class="asst-iconbtn asst-act-sessions" data-tooltip="${esc(tt('assistant.topbar.sessions', 'Sessions'))}" aria-label="${esc(tt('assistant.topbar.sessions', 'Sessions'))}" aria-haspopup="menu" aria-expanded="false">${ICON_SESSIONS}</button>
        <button type="button" class="asst-iconbtn asst-act-new" data-tooltip="${esc(tt('assistant.topbar.new', 'New assistant session'))}" aria-label="${esc(tt('assistant.topbar.new', 'New assistant session'))}">${ICON_NEW}</button>
        <button type="button" class="asst-iconbtn asst-act-more" data-tooltip="${esc(tt('assistant.toolbar.more', 'More options'))}" aria-label="${esc(tt('assistant.toolbar.more', 'More options'))}" aria-haspopup="menu" aria-expanded="false">${ICON_COG}</button>
      </div>
    </div>
    <div class="asst-banners" aria-live="polite"></div>
    <div class="asst-transcript" role="log" aria-live="off" tabindex="0" aria-label="${esc(tt('assistant.transcript', 'Conversation'))}"></div>
    <div class="asst-announce" role="status" aria-live="polite" aria-atomic="true"></div>
    <div class="asst-bottom">
      <div class="asst-computer-host"></div>
      <div class="asst-dock-host"></div>
      <div class="asst-usage-host" hidden></div>
      <div class="asst-composer-host"></div>
    </div>
  `;
  viewport.appendChild(root);

  const barEl = root.querySelector('.asst-bar');
  const barGroups = Object.fromEntries([...barEl.querySelectorAll('.asst-bar-group')].map((g) => [g.dataset.group, g]));
  const costEl = root.querySelector('.asst-cost');
  const bannersEl = root.querySelector('.asst-banners');
  const transcriptEl = root.querySelector('.asst-transcript');
  const announcer = root.querySelector('.asst-announce');
  const agentsBtn = root.querySelector('.asst-act-agents');
  const agentsCount = agentsBtn.querySelector('.asst-count');
  const sessionsBtn = root.querySelector('.asst-act-sessions');
  const newBtn = root.querySelector('.asst-act-new');
  const moreBtn = root.querySelector('.asst-act-more');
  // Every bar element is held above: from here on the bar may live outside the root.
  if (host.toolbarSlot) host.toolbarSlot.appendChild(barEl);

  // ── Helpers ──
  const providerIcon = (p) => getProviderMeta(p).icon;
  const providerColor = (p) => getProviderMeta(p).color;
  const visible = () => { try { return host.isVisible ? !!host.isVisible() : true; } catch { return true; } };
  const hostId = host.id || null; // routing only (assistant:new / resume / focused) — never a feature switch

  function persist() {
    if (destroyed) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        storage.setItem(tabStorageKey(sessionId), JSON.stringify(serializeTabState(st)));
        storage.setItem(KEYS.ASSISTANT_BRAIN, JSON.stringify(st.brain));
        storage.setItem(KEYS.ASSISTANT_DOCK_OPEN, st.dockOpen ? '1' : '0');
        storage.setItem(KEYS.ASSISTANT_DOCK_SHOW_ALL, st.dockShowAll ? '1' : '0');
      } catch { /* storage unavailable */ }
    }, 300);
  }

  /** The tab's name: "SynaBun", or what the user renamed it to (controller.setTitle). */
  function setTitle(text) {
    const next = String(text || '').trim();
    if (!next) return;
    st.title = next;
    syncTabLabel();
    persist();
  }

  /** Push the name to the tab; the host ignores it for renamed tabs and unchanged labels. */
  function syncTabLabel() {
    try { host.setLabel?.(st.title); } catch { /* ignore */ }
  }

  /** Notifications say which conversation: the rename, else the session's first-prompt title. */
  function notifyLabel() {
    return st.userRenamed ? st.title : (st.sessionTitle || st.title);
  }

  /** Through the host's Settings source ('cli' terminal / 'panel' sidepanel); a click routes to assistant:show. */
  function notifyUser(type) {
    notify(host.notifySource || 'cli', type, notifyLabel(), { sessionId, provider: 'assistant', panel: 'assistant' });
  }

  /** root[data-status] and data-computer drive status styling (the live dot, the Computer switch). */
  function renderStatus() {
    root.dataset.status = st.status || 'idle';
    if (st.desktopActive) root.dataset.computer = 'active';
    else delete root.dataset.computer;
  }

  function setStatus(status) {
    st.status = status || 'idle';
    renderStatus();
    syncBlocked();
    try { host.setStatus?.(st.status); } catch { /* ignore */ }
  }

  /**
   * The newest card waiting on the user (permission, question, plan, clarify, route): the mascot's eyes
   * go to it, and the rack whose call it holds says "Waiting for you" (clock stopped, no gold).
   */
  function syncBlocked() {
    if (!director) return; // mounting: the renderer and the director come first
    let card = null;
    let own = null; // the newest card of this session's own brain (a worker's relayed card holds no call here)
    for (const entry of controls.values()) {
      if (!entry.card?.el?.isConnected) continue;
      card = entry.card.el;
      if (!entry.origin?.runId) own = entry;
    }
    renderer.setWaiting(!!own, own?.toolUseId || null);
    director.setBlocked(card ? () => card.getBoundingClientRect() : null);
  }

  /** The call a control card holds, when its packet names it (Claude tool_use_id, Codex item, OpenCode call). */
  function controlToolUseId(normalized) {
    const req = normalized?.raw?.request || normalized?.raw || {};
    const native = req.brain_native || {};
    const id = req.tool_use_id ?? req.toolUseId ?? req.toolUseID ?? req.callID ?? native.toolCallId ?? native.params?.itemId ?? req.input?.tool_use_id ?? null;
    return id != null && id !== '' ? String(id) : null;
  }

  let announceTimer = 0;
  /** One polite line for screen readers (the transcript itself is not a live region). */
  function announce(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    if (!line) return;
    clearTimeout(announceTimer);
    announcer.textContent = '';
    announceTimer = setTimeout(() => { if (!destroyed) announcer.textContent = line.length > 220 ? `${line.slice(0, 219).replace(/\s+\S*$/, '')}…` : line; }, 60);
  }

  function totalCost() {
    return (Number(st.costUsd) || 0) + (Number(st.dispatchUsd) || 0);
  }

  function renderCost() {
    // The server's budget view (brain + agents, the caps) when it sends one.
    const budget = st.budget && Number.isFinite(Number(st.budget.totalUsd)) ? st.budget : null;
    const total = budget ? Number(budget.totalUsd) : totalCost();
    costEl.textContent = fmtCost(total);
    costEl.hidden = !(total > 0);
    const tone = budgetTone(budget);
    if (tone && tone !== 'ok') costEl.dataset.tone = tone;
    else delete costEl.dataset.tone;
    const tip = budget
      ? budgetChipText(budget, { t, brainMetered: st.brainMetered !== false })
      : Number(st.dispatchUsd) > 0
        ? tt('assistant.topbar.costSplit', 'Session {session} · agents {agents}', { session: fmtCost(st.costUsd || 0), agents: fmtCost(st.dispatchUsd) })
        : tt('assistant.topbar.cost', 'Session cost');
    costEl.setAttribute('data-tooltip', tip);
  }

  function brainModelLabel() {
    return st.brainCapabilities?.label || picker?.modelLabel?.() || modelShortName(st.brain.model) || providerShortLabel(st.brain.provider);
  }

  function setRunning(running, { label } = {}) {
    const was = st.running;
    st.running = !!running;
    if (st.running) st.turnStartedAt = st.turnStartedAt || Date.now();
    else st.turnStartedAt = 0;
    composer.setRunning(st.running);
    if (st.running) { renderer.showWorking(label); setStatus('working'); if (!was) director?.turnStarted(); }
    else { renderer.hideWorking(); }
  }

  function banner(id, text, { tone = '', action = null } = {}) {
    let node = bannersEl.querySelector(`[data-banner="${id}"]`);
    if (!text) { node?.remove(); return; }
    if (!node) { node = el('div', 'asst-banner'); node.dataset.banner = id; bannersEl.appendChild(node); }
    node.className = `asst-banner${tone ? ` ${tone}` : ''}`;
    node.innerHTML = `<span class="asst-banner-text">${esc(text)}</span>`;
    if (action) {
      const btn = el('button', 'asst-btn asst-btn-secondary', action.label);
      btn.type = 'button';
      btn.addEventListener('click', () => action.onClick?.());
      node.appendChild(btn);
    }
  }

  function toast(text) {
    if (!text) return;
    renderer.appendStatus(text, 'info');
  }

  function guestBlocked() {
    return isGuest() && !hasPermission('terminal');
  }

  function computerAvailable() {
    return st.features.computer === true && st.desktopSupported !== false;
  }

  function routingAvailable() {
    return st.features.routing === true;
  }

  // ── Renderer ──
  const renderer = createRenderer(transcriptEl, {
    t,
    providerIcon,
    providerColor,
    copy: clipCopy,
    onFocusRun: (runId) => focusRun(runId),
    onStopRun: (runId) => stopRun(runId),
    onReadRun: (runId) => readRun(runId),
    onEscalateRun: (runId, target) => escalateRun(runId, target),
    onMemoryClick: (id) => { if (id) emit('memory:open', { id }); },
    brainLabel: () => brainModelLabel(),
    onChangeRoutes: () => openRoutes(),
    onRouteEvent: (ev) => handleRouteCardEvent(ev),
    emptySuggestions: () => emptySuggestions(),
    onSuggestion: (template) => composer.fillTemplate(template),
    heroOrigin: () => { try { return host.takeHeroOrigin?.() || null; } catch { return null; } },
    onMascotChange: () => director?.retarget(),
    onInit: (ev) => {
      if (ev.session_id) st.providerSessionId = ev.session_id;
      if (ev.model && !st.brain.model) { st.brain = { ...st.brain, model: ev.model }; picker.render(); }
      if (ev.permissionMode) { const patch = brainModePatch(st.brain, ev.permissionMode); if (Object.entries(patch).some(([k, v]) => st.brain[k] !== v)) { st.brain = { ...st.brain, ...patch }; picker.render(); } }
    },
    onResult: (ev) => {
      // A replayed result belongs to a turn the reattach_result already accounted for.
      if (replaying) return;
      // The runtime's assistant:cost packet is authoritative; this only covers older servers.
      if (!st.serverCost && Number.isFinite(Number(ev.total_cost_usd))) { st.costUsd = (Number(st.costUsd) || 0) + Number(ev.total_cost_usd); renderCost(); persist(); }
      if (ev.session_id) st.providerSessionId = ev.session_id;
      finishTurn({ aborted: false });
    },
    onStatus: (status) => { if (st.running) renderer.showWorking(status === 'compacting' ? tt('assistant.compacting', 'compacting…') : undefined); },
    // An older server forwards the provider's limit report with every response: same notice, same upsert.
    onLimit: (info) => { if (applyLimit(st, info)) renderLimit(); },
    onModeChanged: (mode, planMode) => {
      // 'plan' is the plan flag; leaving it (a Claude plan approved) keeps the approval mode.
      const patch = brainModePatch(st.brain, mode, planMode);
      if (!Object.entries(patch).some(([k, v]) => st.brain[k] !== v)) return;
      st.brain = { ...st.brain, ...patch };
      picker.render();
      renderer.appendStatus(tt('assistant.status.mode', 'Permission mode: {mode}', { mode: permissionModeLabel(st.brain, (id, fallback) => tt(`assistant.brain.modes.${id}`, fallback)) }));
      persist();
    },
  });

  function emptySuggestions() {
    const project = st.brain.project ? basename(st.brain.project) : tt('assistant.empty.thisProject', 'this project');
    const list = [];
    if (computerAvailable()) list.push({ id: 'computer', label: tt('assistant.empty.suggestComputer', 'Use my Mac to…'), template: tt('assistant.empty.templateComputer', 'Use my Mac to {caret}') });
    list.push({ id: 'web', label: tt('assistant.empty.suggestWeb', 'Look up … on the web'), template: tt('assistant.empty.templateWeb', 'Look up {caret} on the web') });
    list.push({ id: 'fix', label: tt('assistant.empty.suggestFix', 'Fix … in {project}', { project }), template: tt('assistant.empty.templateFix', 'Fix {caret} in {project}', { project }) });
    list.push({ id: 'schedule', label: tt('assistant.empty.suggestSchedule', 'Schedule …'), template: tt('assistant.empty.templateSchedule', 'Schedule {caret}') });
    list.push({ id: 'remember', label: tt('assistant.empty.suggestRemember', 'Remember …'), template: tt('assistant.empty.templateRemember', 'Remember {caret}') });
    return list;
  }

  // ── Composer ──
  const composer = createComposer(root.querySelector('.asst-composer-host'), {
    t,
    describeSlash: (cmd) => tt(cmd.descKey, cmd.desc),
    resolveMemory: (id) => appState.allNodes?.find(n => n.id === id) || null,
    resolveWhiteboardImage: (id) => { const wb = getWhiteboardElementById(id); return wb?.type === 'image' && wb.dataUrl ? { dataUrl: wb.dataUrl } : null; },
    onDraftChange: (text) => { st.draft = text; persist(); director?.type(!!String(text || '').trim()); },
    onFocusChange: (focused) => { if (focused) director?.touch(); else director?.stopTyping(); },
    onAbort: () => abort(),
    onToast: toast,
    onRemoveQueued: (idx) => { if (idx >= 0) { st.queue.splice(idx, 1); composer.setQueue(st.queue); } },
    onSubmit: (payload) => submit(payload),
    // Files that do not go inline: saved on the server, the prompt carries the path.
    uploadFile: (file, opts) => uploadAssistantAttachment(file, { ...opts, sessionId }),
  });
  if (st.draft) composer.setText(st.draft);

  // ── The mascot on screen wears the panel's state (asst-mascot.js) ──
  director = createMascotDirector({
    getTarget: () => renderer.mascot(),
    caret: () => composer.caretPoint(),
    setEnabled: (on) => renderer.setRigsEnabled(on),
    isVisible: () => visible(),
    env: {
      input: (fn) => { const offPointer = onPointer(fn); const offKey = onKey(fn); return () => { offPointer(); offKey(); }; },
      lastInputAt,
    },
  });

  // ── Toolbar (flush under the tabs): brain · route · context · computer ──
  const routeChip = createRouteModeControl(barGroups.route, {
    t,
    getMode: () => routeModeView(),
    brainName: () => brainModelLabel(),
    onChange: (mode) => setRouteMode(mode),
    onOpenModels: () => openModels(),
    onOpenEditor: () => openRoutes(),
    menuPlacement: 'below',
    // Pending routes the server counts but no open card shows: one click replays them.
    getWaiting: () => Math.max(0, (Number(st.pendingRoutes) || 0) - [...routeCards.values()].filter((card) => !card.collapsed).length),
    onShowWaiting: () => sock.send({ type: 'reattach' }),
  });

  const accountHooks = () => ({ t, onChanged: () => picker.refresh(true), onSelect: (id) => applyBrain({ ...st.brain, accountId: id }, { requiresSwitch: true, field: 'account' }) });
  // Model · effort · permission mode · account sit in the composer row next to attach; project and MCP in the toolbar.
  const picker = createBrainPicker({ brain: composer.el.querySelector('.asst-composer-brain'), context: barGroups.context }, {
    t,
    getBrain: () => st.brain,
    onChange: (next, meta) => applyBrain(next, meta),
    onAddAccount: (provider) => openAccountsManager({ provider, ...accountHooks() }).openAdd(),
    onManageAccounts: (provider) => openAccountsManager({ provider, ...accountHooks() }),
    onToast: toast,
    onManageModels: () => openModels(),
    getMenuAnchor: () => moreBtn,
    // Composer fields open upward, toolbar fields downward.
    menuPlacement: 'auto',
  });

  const computerToggle = createComputerToggle(barGroups.computer, {
    t,
    onToggle: (enabled) => setComputerUse(enabled),
    onRemoteInfo: () => explainRemoteComputer(),
  });
  // The composer row's fields lead the toolbar's arrow order (model first, "⋯" last).
  const roving = createRovingToolbar(barEl, { lead: composer.el.querySelector('.asst-composer-brain') });

  // ── Computer use (setup tray + live activity) ──
  const computerPanel = createComputerPanel(root.querySelector('.asst-computer-host'), {
    t,
    sessionId,
    isEnabled: () => st.computerEffective && computerAvailable(),
    onStatus: (status, info) => {
      st.setupInfo = info;
      if (status && typeof status === 'object' && 'supported' in status) st.desktopSupported = status.supported === true;
      if (st.features.computer == null && status?.supported === true) st.features.computer = true;
      applyFeatures();
    },
    onActivity: (active) => {
      if (st.desktopActive === active) return;
      st.desktopActive = active;
      renderStatus();
      computerToggle.set({ active });
    },
    onOpenFrame: ({ src, marker, caption, returnFocus }) => openFrameLightbox({ src, marker, caption, t, returnFocus }),
  });

  // ── Agents tray ──
  const dock = createAgentsDock(root.querySelector('.asst-dock-host'), {
    t,
    sessionId,
    open: st.dockOpen,
    showAll: st.dockShowAll,
    onFocus: (runId) => focusRun(runId),
    onStop: (runId) => stopRun(runId),
    onRead: (runId) => readRun(runId),
    onEscalate: (runId, target) => escalateRun(runId, target),
    onStopAll: () => stopAll(),
    onRemove: (runId) => removeRun(runId),
    onClearFinished: () => clearFinished(),
    onToggle: (open) => { st.dockOpen = open; agentsBtn.setAttribute('aria-pressed', open ? 'true' : 'false'); persist(); },
    onShowAllChange: (showAll) => { st.dockShowAll = showAll; persist(); },
    onCountChange: ({ total, active, attention, visible: shown }) => {
      agentsCount.textContent = String(active || total);
      agentsCount.classList.toggle('attention', attention > 0);
      agentsBtn.hidden = !shown;
      agentsBtn.classList.toggle('attention', attention > 0);
    },
  });
  agentsBtn.setAttribute('aria-pressed', st.dockOpen ? 'true' : 'false');

  const usage = createUsageGauge(root.querySelector('.asst-usage-host'), { t, sessionId });
  if (st.usageView) { usage.apply({ type: 'assistant:usage', ...st.usageView }); usage.setConnection('reconnecting'); }
  let usageFetchSeq = 0;
  let usageSocketOpened = false;
  let usageWarned = false;
  function fetchUsage() {
    const seq = ++usageFetchSeq;
    getAssistantSessionUsage(sessionId).then((data) => {
      if (!destroyed && seq === usageFetchSeq && data?.ok && data.usage) applyUsage(data.usage);
    }).catch(() => { /* older servers do not expose usage */ });
  }
  function applyUsage(packet) {
    if (packet?.sessionId === sessionId && (!packet.task?.id || !Number.isSafeInteger(packet.task?.tokens?.total) || packet.task.tokens.total < 0)) {
      if (!usageWarned) { console.warn('[assistant] invalid usage packet'); usageWarned = true; }
      return;
    }
    const was = st.usageView;
    if (!applyUsagePacket(st, packet)) return;
    if (!usage.apply(st.usageView)) { st.usageView = was; return; }
    for (const agent of st.usageView.task.agents || []) {
      if (agent.scope !== 'run' || !agent.runId) continue;
      const tokens = agent.tokens || null;
      const fidelity = agent.fidelity || st.usageView.task.fidelity;
      dock.patchUsageRun(agent.runId, tokens, fidelity);
      renderer.patchRunUsage(agent.runId, tokens, fidelity);
    }
    persist();
  }

  // The provider's usage limit: one line under the usage gauge, replaced in place (st.limit is
  // one notice or null). It is never a transcript row, and it goes when the provider says the
  // limit is no longer near or its reset time passes.
  const limitEl = el('div', 'asst-limit');
  limitEl.hidden = true;
  limitEl.setAttribute('role', 'status');
  limitEl.setAttribute('aria-live', 'polite');
  root.querySelector('.asst-usage-host').after(limitEl);
  let limitTimer = null;
  function renderLimit() {
    clearTimeout(limitTimer);
    limitTimer = null;
    const limit = st.limit;
    limitEl.hidden = !limit;
    limitEl.dataset.status = limit?.status || '';
    const text = limitNoticeText(limit, tt);
    if (limitEl.textContent !== text) limitEl.textContent = text;
    const wait = limitExpiresIn(limit);
    if (wait == null) return;
    limitTimer = setTimeout(() => {
      if (destroyed) return;
      if (limitExpiresIn(st.limit) > 0) { renderLimit(); return; } // a wait longer than one timer can hold
      st.limit = null;
      renderLimit();
    }, Math.min(wait + 250, 2 ** 31 - 1));
  }

  // ── Socket ──
  const sock = createAssistantSocket(sessionId, {
    onPacket: (packet) => handlePacket(packet),
    onStatus: (status, extra) => {
      st.connected = status === 'open';
      usage.setConnection(status);
      if (status === 'open') { if (usageSocketOpened) fetchUsage(); usageSocketOpened = true; }
      if (status === 'open') { banner('conn', ''); st.attachedElsewhere = false; banner('elsewhere', ''); director.setOffline(false); }
      else if (status === 'reconnecting') { banner('conn', tt('assistant.banner.reconnecting', 'Reconnecting to the assistant…'), { tone: 'info' }); director.setOffline(true); }
      else if (status === 'attached-elsewhere') {
        st.attachedElsewhere = true;
        banner('elsewhere', tt('assistant.banner.attachedElsewhere', 'This session is open in another window.'), {
          action: { label: tt('assistant.banner.takeOver', 'Take over'), onClick: () => { sock.takeOver(); banner('elsewhere', ''); } },
        });
      }
      if (extra?.message && status === 'attached-elsewhere') { /* message already shown by the error handler */ }
    },
  });

  // ── Packet handling ──
  /** A reattach replays `count` buffered packets next: collect them, then draw what is not on screen yet. */
  function startReplay(count) {
    if (replay) flushReplay();
    if (!(count > 0)) { renderer.planReplay([]); return; } // nothing buffered: the snapshot has no replay to meet
    replay = { left: count, packets: [], timer: setTimeout(() => flushReplay(), REPLAY_WAIT_MS) };
  }

  function flushReplay() {
    const batch = replay;
    replay = null;
    if (!batch || destroyed) return;
    clearTimeout(batch.timer);
    const packets = renderer.planReplay(batch.packets);
    replaying = true;
    try { for (const packet of packets) handlePacket(packet); }
    finally { replaying = false; }
  }

  function handlePacket(packet) {
    if (destroyed || !packet?.type) return;
    if (replay && packet.type !== 'reattach_result') {
      replay.packets.push(packet);
      if ((replay.left -= 1) <= 0) flushReplay();
      return;
    }
    // Replayed history: the reattach_result already said whether a turn runs now.
    if (replaying && (packet.type === 'done' || packet.type === 'aborted' || packet.type === 'turn_started')) return;
    if (replaying && packet.type === 'error') { if (!packet.request_id) renderer.appendError(packet.message || tt('assistant.errorGeneric', 'Something went wrong')); return; }
    switch (packet.type) {
      case 'engine':
        st.engine = packet.engine || '';
        st.sdkVersion = packet.sdkVersion || '';
        return;
      case 'event':
        handleEvent(packet.event);
        return;
      case 'control_request':
        showControl(packet, null);
        return;
      case 'control_cancelled': {
        // A plan card a newer message replaced, or that timed out, reads Expired. A card answered
        // here whose request closed before the answer arrived says so too: that answer did nothing.
        const id = String(packet.request_id);
        const answered = controls.has(id) ? null : answeredCards.get(id);
        const kind = controls.get(id)?.kind || answered?.el?.dataset?.kind;
        const label = closedControlState(packet.reason, kind) === 'expired' ? tt('assistant.control.state.expired', 'Expired') : tt('assistant.control.state.cancelled', 'Cancelled');
        if (answered) { answered.expire(label); answeredCards.delete(id); return; }
        lockControl(packet.request_id, label);
        return;
      }
      case 'control_resolved':
        // Answered somewhere else (WhatsApp, another window): this card is done.
        lockControl(packet.request_id, resolvedLabel(packet.origin, tt('assistant.control.state.answered', 'Answered')));
        return;
      case 'reattach_result':
        if (packet.ok) {
          if (packet.sessionId) st.providerSessionId = packet.sessionId;
          if (packet.resynced) rehydrate({ force: true });
          if (packet.running) setRunning(true);
          else if (st.running) finishTurn({ aborted: false, silent: true });
          startReplay(Number(packet.replayed) || 0);
        } else if (st.running) {
          finishTurn({ aborted: false, silent: true });
        }
        return;
      case 'rewind_result':
        renderer.appendStatus(packet.ok ? tt('assistant.status.rewound', 'Files rewound to checkpoint') : `${tt('assistant.status.rewindFailed', 'Rewind failed')}: ${packet.error || ''}`);
        return;
      case 'stderr':
        if (packet.text?.trim()) renderer.appendStatus(packet.text.trim());
        return;
      case 'turn_started':
        // The CLI began a turn on its own (a background agent finished, a
        // scheduled wakeup fired); its `done` finishes it.
        if (!st.running) setRunning(true);
        return;
      case 'done':
        finishTurn({ aborted: false });
        return;
      case 'aborted':
        finishTurn({ aborted: true });
        return;
      case 'error': {
        // A rejected route answer keeps its card open with the message.
        const routeCard = packet.request_id ? routeCardByRequest(packet.request_id) : null;
        if (routeCard) { routeCard.fail(packet.message); return; }
        if (packet.code === 'ROUTE_INVALID') { renderer.appendError(packet.message || tt('assistant.routes.invalid', 'That route is not available. Pick another option.')); return; }
        // A prompt of this panel that did not run (the approved plan goes first, the brain is mid-turn…):
        // its text goes back into the composer, and the reattach_result after it says what runs now.
        const refused = packet.request_id ? sentQueries.get(String(packet.request_id)) : null;
        if (refused) {
          sentQueries.delete(String(packet.request_id));
          refused.row?.remove?.();
          composer.restore(refused.payload);
          renderer.appendError(`${packet.message || tt('assistant.errorGeneric', 'Something went wrong')} ${tt('assistant.status.notSent', 'Your message is back in the input box.')}`);
          return;
        }
        renderer.appendError(packet.message || tt('assistant.errorGeneric', 'Something went wrong'));
        announce(tt('assistant.announce.error', 'Error: {text}', { text: packet.message || tt('assistant.errorGeneric', 'Something went wrong') }));
        if (st.running) finishTurn({ aborted: true, silent: true, errored: true });
        notifyUser(NOTIF_TYPE.ERROR);
        return;
      }
      case 'mode_changed':
        handleEvent({ type: 'mode_changed', mode: packet.mode, planMode: packet.planMode });
        return;
      case 'assistant:session':
        applySessionMeta(packet.session || packet);
        return;
      case 'assistant:dispatch': {
        const run = runFromPayload(packet);
        if (run) { dock.upsertRun(run); renderer.upsertRunCard(dock.getRun(run.runId) || run); }
        return;
      }
      case 'assistant:permission-request':
        showControl({ request_id: packet.request_id || packet.requestId || packet.request?.requestId, request: packet.request, provider: packet.provider, runId: packet.runId }, { runId: packet.runId, provider: packet.provider || dock.getRun(packet.runId)?.provider });
        return;
      case 'assistant:mailbox':
        renderer.appendMailbox(packet.items || packet.events || packet.mailbox || []);
        return;
      case 'assistant:cost':
        applyCost(packet);
        return;
      case 'assistant:usage':
        ++usageFetchSeq;
        applyUsage(packet);
        return;
      case 'assistant:limit':
        if (applyLimitPacket(st, packet)) renderLimit();
        return;
      case 'assistant:sessions':
        showSessionsMenu(packet.sessions || []);
        return;
      case 'assistant:desktop':
        computerPanel.applyDesktop(packet);
        return;
      case 'assistant:desktop-setup':
        computerPanel.applySetup(packet);
        return;
      default:
        return;
    }
  }

  function handleEvent(ev) {
    if (!ev?.type) return;
    // One registry for what is on screen (the renderer's): the journal snapshot registers there too.
    if (!renderer.claimEvent(ev)) return;
    const draw = (event) => renderer.handleEvent(event, replaying ? { replay: true } : undefined);
    switch (ev.type) {
      case 'synabun.dispatch': {
        const run = runFromPayload(ev);
        if (run) { dock.upsertRun(run); renderer.upsertRunCard(dock.getRun(run.runId) || run); }
        return;
      }
      case 'synabun.dispatch_result': {
        const run = runFromPayload(ev);
        if (run) { dock.upsertRun(run); renderer.upsertRunCard(dock.getRun(run.runId) || run, { result: ev.result ?? null }); }
        return;
      }
      case 'synabun.dispatch_control_request':
        showControl({ request_id: ev.request_id || ev.request?.requestId, request: ev.request, provider: ev.provider, runId: ev.runId }, { runId: ev.runId, provider: ev.provider || dock.getRun(ev.runId)?.provider });
        return;
      case 'synabun.user_prompt':
        // A prompt from WhatsApp started a turn this panel did not send (a replayed one is history).
        if (!replaying && ev.origin && ev.origin !== 'ui' && !st.running) setRunning(true);
        draw(ev);
        return;
      case 'synabun.dispatch_control_resolved':
        lockControl(ev.request_id, resolvedLabel(ev.resolvedBy));
        if (ev.runId) dock.patchRun(ev.runId, { turnState: 'running' });
        return;
      case 'synabun.mailbox':
        renderer.appendMailbox(ev.items || ev.events || []);
        return;
      case 'synabun.clarify':
        if (settleClarifyCard(ev)) return;
        draw(ev);
        return;
      case 'synabun.cost':
        applyCost(ev);
        return;
      default:
        draw(ev);
    }
  }

  function applyCost(packet) {
    const session = num(packet?.sessionUsd ?? packet?.sessionCostUsd ?? packet?.totalUsd);
    if (session != null) st.costUsd = session;
    else if (!packet?.runId && num(packet?.costUsd) != null) st.costUsd = num(packet.costUsd);
    if (num(packet?.dispatchUsd) != null) st.dispatchUsd = num(packet.dispatchUsd);
    if (packet?.budget && typeof packet.budget === 'object') st.budget = packet.budget;
    if (typeof packet?.brainMetered === 'boolean') st.brainMetered = packet.brainMetered;
    if (packet?.runId && num(packet.costUsd) != null) dock.patchRun(packet.runId, { costUsd: num(packet.costUsd) });
    if (session != null) st.serverCost = true;
    renderCost();
    persist();
  }

  function applySessionMeta(meta) {
    if (!meta || typeof meta !== 'object') return;
    if (meta.id && meta.id !== sessionId) return;
    // The server's title names the conversation (history, notifications), never the tab.
    if (meta.title) st.sessionTitle = String(meta.title);
    if (meta.brain && typeof meta.brain === 'object') {
      const next = normalizeBrain({ ...st.brain, ...meta.brain, provider: meta.brain.provider || meta.brain.brain || st.brain.provider });
      if (JSON.stringify(next) !== JSON.stringify(st.brain)) { st.brain = next; picker.render(); host.setBrain?.(next); persist(); }
    } else if (typeof meta.brain === 'string') {
      const next = normalizeBrain({ ...st.brain, provider: meta.brain, model: meta.model ?? st.brain.model, effort: meta.effort ?? st.brain.effort, accountId: meta.accountId ?? st.brain.accountId, mcpProfile: meta.mcpProfile ?? st.brain.mcpProfile, project: meta.cwd ?? st.brain.project });
      if (JSON.stringify(next) !== JSON.stringify(st.brain)) { st.brain = next; picker.render(); host.setBrain?.(next); persist(); }
    }
    if (meta.budget && typeof meta.budget === 'object') st.budget = meta.budget;
    if (Number.isFinite(Number(meta.costUsd))) { st.costUsd = Number(meta.costUsd); renderCost(); }
    if (meta.providerSessionId) st.providerSessionId = meta.providerSessionId;
    if (meta.routing && typeof meta.routing === 'object') {
      st.routing = {
        mode: normalizeRouteMode(meta.routing.mode, null),
        effectiveMode: normalizeRouteMode(meta.routing.effectiveMode, null),
        defaultMode: normalizeRouteMode(meta.routing.defaultMode, null),
        askBelow: meta.routing.askBelow ?? null,
      };
      st.routeMode = st.routing.mode;
    }
    if (meta.features && typeof meta.features === 'object') {
      if (typeof meta.features.routing === 'boolean') st.features.routing = meta.features.routing;
      if (typeof meta.features.computer === 'boolean') st.features.computer = meta.features.computer;
    }
    if (typeof meta.computerUse === 'boolean') st.computerEffective = meta.computerUse;
    if ('computerUseExplicit' in meta) st.computerUse = normalizeComputerMode(meta.computerUseExplicit, null);
    // A WhatsApp conversation: what is in effect and why (not a per-conversation switch). null on the desktop.
    if ('computerRemote' in meta) st.computerRemote = normalizeComputerRemote(meta.computerRemote);
    if (meta.brainCapabilities && typeof meta.brainCapabilities === 'object') st.brainCapabilities = meta.brainCapabilities;
    if (Array.isArray(meta.pendingRoutes)) {
      for (const pending of meta.pendingRoutes) {
        if (pending && typeof pending === 'object' && pending.request && (pending.request_id || pending.requestId)) showControl(pending, null);
      }
    } else if (typeof meta.pendingRoutes === 'number') {
      // The session view carries a count; the route chip shows any the panel is missing.
      st.pendingRoutes = Math.max(0, meta.pendingRoutes);
      routeChip.render();
    }
    applyFeatures();
    // Every attach sends meta: this also heals a restored float whose saved label came back.
    syncTabLabel();
    persist();
  }

  function applyFeatures() {
    if (destroyed) return;
    routeChip.setVisible(routingAvailable());
    routeChip.render();
    const showComputer = st.features.computer === true || st.desktopSupported === true;
    computerToggle.set({
      visible: showComputer,
      enabled: st.computerEffective,
      supported: st.desktopSupported !== false,
      setupState: st.setupInfo?.state || 'loading',
      active: st.desktopActive,
      remote: st.computerRemote || null,
    });
    if (showComputer && !st.desktopProbe) {
      st.desktopProbe = true;
      computerPanel.refresh().catch(() => {});
    }
    computerPanel.render();
    renderer.refreshEmpty();
    roving.sync();
  }

  /** Features unknown after the first meta (older server)? Probe the endpoints once. */
  function probeFeatures() {
    if (st.features.routing == null && !st.routingProbe) {
      st.routingProbe = true;
      getRouting()
        .then((data) => {
          st.features.routing = true;
          if (!st.routing) {
            const def = normalizeRouteMode(data?.routing?.defaultMode, DEFAULT_ROUTE_MODE);
            st.routing = { mode: st.routeMode, effectiveMode: st.routeMode || def, defaultMode: def, askBelow: data?.routing?.askBelow ?? null };
          }
          applyFeatures();
        })
        .catch(() => { st.features.routing = false; applyFeatures(); });
    }
    if (st.features.computer == null && !st.desktopProbe) {
      st.desktopProbe = true;
      getDesktopStatus()
        .then((status) => {
          st.desktopSupported = status?.supported === true;
          st.features.computer = status?.supported === true;
          computerPanel.applyStatus(status);
          applyFeatures();
        })
        .catch(() => { st.features.computer = false; applyFeatures(); });
    }
  }

  function routeModeView() {
    const r = st.routing || {};
    return { mode: normalizeRouteMode(st.routeMode, null) || r.mode || null, effectiveMode: r.effectiveMode, defaultMode: r.defaultMode };
  }

  function setRouteMode(mode, { quiet = false } = {}) {
    const next = normalizeRouteMode(mode, null);
    st.routeMode = next;
    const def = st.routing?.defaultMode || DEFAULT_ROUTE_MODE;
    st.routing = { ...(st.routing || {}), mode: next, effectiveMode: next || def, defaultMode: def };
    routeChip.render();
    persist();
    sock.send({ type: 'set_route_mode', mode: next });
    try { if (next) storage.setItem(KEYS.ASSISTANT_ROUTE_MODE, next); } catch { /* storage unavailable */ }
    if (!quiet) renderer.appendStatus(tt('assistant.status.routeMode', 'Model routing: {mode}', { mode: routeModeLabel(next || def, t) }));
  }

  /** Fresh tabs inherit the last-used route mode (like the brain). */
  function applyLastUsedRouteMode() {
    if (saved || !routingAvailable() || !st.routing || st.routing.mode != null) return;
    let last = null;
    try { last = normalizeRouteMode(storage.getItem(KEYS.ASSISTANT_ROUTE_MODE), null); } catch { last = null; }
    if (last && last !== st.routing.effectiveMode) setRouteMode(last, { quiet: true });
  }

  /** A WhatsApp conversation's Computer switch says why it is what it is (the status line of the transcript). */
  function explainRemoteComputer() {
    const view = computerRemoteView(st.computerRemote, t);
    if (!view) return false;
    renderer.appendStatus(tt('assistant.status.computerRemote', 'Computer use in this WhatsApp conversation: {why}.', { why: view.tip }));
    return true;
  }

  function setComputerUse(enabled) {
    // Not a per-conversation switch in a WhatsApp conversation: nothing is sent, nothing bounces.
    if (st.computerRemote) { explainRemoteComputer(); return; }
    const next = enabled === true;
    const wasActive = st.desktopActive;
    st.computerUse = next;
    st.computerEffective = next;
    persist();
    sock.send({ type: 'set_computer_use', enabled: next });
    if (!next && wasActive) {
      sock.send({ type: 'desktop_stop' });
      if (!sock.isOpen()) requestDesktopStop({ scope: 'session', assistantSessionId: sessionId });
    }
    // Permissions can be revoked while the toggle was off: re-read the status.
    if (next) computerPanel.refresh().catch(() => {});
    applyFeatures();
  }

  function finishTurn({ aborted, silent = false, errored = false } = {}) {
    const wasRunning = st.running;
    // Once per turn (a result and its `done` both land here): success after real work, error when it failed.
    const stats = renderer.turnStats();
    const pose = wasRunning ? turnEndPose({
      aborted: aborted && !errored,
      errored: errored || stats.errored,
      lastFailed: stats.lastFailed,
      calls: stats.calls,
      elapsedMs: st.turnStartedAt ? Date.now() - st.turnStartedAt : 0,
    }) : null;
    const answer = wasRunning && !aborted ? renderer.turnAnswer() : '';
    renderer.finishTurn({ holdMs: pose ? MASCOT_TIMING.oneShotMs[pose] : 0 });
    if (wasRunning) director.turnEnded(pose);
    if (answer && !silent) announce(tt('assistant.announce.replied', 'SynaBun replied: {text}', { text: answer }));
    st.running = false;
    st.turnStartedAt = 0;
    composer.setRunning(false);
    if (aborted) {
      if (!silent) renderer.appendStatus(tt('assistant.status.aborted', 'Aborted.'));
      setStatus('idle');
    } else if (wasRunning) {
      setStatus('done');
      if (!visible() && !silent) notifyUser(NOTIF_TYPE.DONE);
    } else {
      setStatus('idle');
    }
    if (controls.size) setStatus('action');
    if (st.queue.length) {
      const next = st.queue.shift();
      composer.setQueue(st.queue);
      setTimeout(() => { if (!destroyed && !st.running) sendQuery(next); }, 250);
    }
  }

  // ── Controls ──
  function routeCardByRequest(requestId) {
    for (const card of routeCards.values()) if (card.requestId === String(requestId)) return card;
    return null;
  }

  function showControl(packet, origin) {
    const normalized = normalizeControlRequest({ ...packet, provider: packet.provider || (origin ? origin.provider : st.brain.provider) }, { origin });
    if (!normalized) return;
    if (controls.has(normalized.requestId)) return;
    renderer.hideWorking();
    const entry = renderControlCard(null, normalized, {
      t,
      md: renderer.md,
      providerIcon,
      scrollEnd: () => renderer.scrollEnd(),
      onRespond: (n, decision) => respondControl(n, decision),
      renderRoute: (_container, n) => mountRouteCard(n),
    });
    if (!entry) return;
    if (normalized.kind !== 'route') renderer.appendNode(entry.el);
    controls.set(normalized.requestId, { card: entry, origin, kind: normalized.kind, toolUseId: origin?.runId ? null : controlToolUseId(normalized) });
    if (normalized.kind === 'clarify') clarifyCards.add(normalized.requestId);
    setStatus('action');
    if (origin?.runId) dock.patchRun(origin.runId, { turnState: 'awaiting_permission' });
    if (!visible()) notifyUser(NOTIF_TYPE.ASK);
    renderer.scrollEnd(true);
    syncBlocked();
  }

  function mountRouteCard(n) {
    const card = renderRouteCard(null, n, {
      t,
      providerIcon,
      brainLabel: () => brainModelLabel(),
      getBrain: () => st.brain,
      shouldFocus: () => visible() && !composer.hasContent() && !isMenuOpen(),
      onRespond: (response) => {
        sock.send({ type: 'control_response', request_id: card.requestId, response });
        if (st.running) renderer.showWorking();
      },
      onCancel: (packet) => sock.send(packet),
      onCollapse: (routeId, line) => {
        renderer.registerRouteLine(routeId, line);
        controls.delete(card.requestId);
        if (!controls.size) setStatus(st.running ? 'working' : 'idle');
        routeChip.render();
      },
      onDone: () => composer.focus(),
      onToast: toast,
      onChangeRoutes: () => openRoutes(),
      scrollEnd: () => renderer.scrollEnd(),
    });
    if (!card) return null;
    renderer.removeRouteLine(card.routeId);
    renderer.appendNode(card.el);
    routeCards.set(card.routeId, card);
    routeChip.render();
    requestAnimationFrame(() => { if (!destroyed && !card.collapsed) card.focusIfIdle(); });
    return card;
  }

  /** `synabun.route` for a route that has a card: the card represents it until it settles. */
  function handleRouteCardEvent(ev) {
    const routeId = ev?.route?.routeId;
    const card = routeId ? routeCards.get(routeId) : null;
    if (!card) return false;
    const phase = ev.phase || 'decided';
    if (phase === 'card' || phase === 'pending') return true;
    card.settle(phase, ev.route);
    card.destroy();
    routeCards.delete(routeId);
    controls.delete(card.requestId);
    routeChip.render();
    if (!controls.size) setStatus(st.running ? 'working' : 'idle');
    return true;
  }

  /**
   * `synabun.clarify` for a clarify card this window showed: the card is the
   * record (locked with the outcome when it was answered elsewhere or in chat),
   * so no second line. Without a card (another window, a reload) the renderer
   * draws the outcome line.
   */
  function settleClarifyCard(ev) {
    const phase = ev?.phase || '';
    if (phase === 'card') return true;
    const requestId = ev?.brief?.round?.requestId ? String(ev.brief.round.requestId) : '';
    if (!requestId || !clarifyCards.has(requestId)) return false;
    const label = phase === 'chat' ? tt('assistant.control.state.answeredInChat', 'Answered in chat')
      : phase === 'answered' ? tt('assistant.control.state.answered', 'Answered')
        : phase === 'declined' ? tt('assistant.control.state.skipped', 'Skipped')
          : tt('assistant.control.state.cancelled', 'Cancelled');
    lockControl(requestId, label);
    return true;
  }

  function respondControl(n, decision) {
    const response = buildControlResponse(n, decision);
    if (n.kind === 'clarify') {
      // The server's clarifier owns it: a brain waiting in agent_clarify continues; an idle one gets a mailbox turn.
      sock.send({ type: 'control_response', request_id: n.requestId, response });
      if (st.running) renderer.showWorking();
      controls.delete(n.requestId);
      if (!controls.size) setStatus(st.running ? 'working' : 'idle');
      return;
    }
    if (n.origin?.runId) {
      sock.send({ type: 'dispatch_control_response', runId: n.origin.runId, request_id: n.requestId, response });
      dock.patchRun(n.origin.runId, { turnState: 'running' });
    } else {
      sock.send({ type: 'control_response', request_id: n.requestId, response });
      if (!st.running) setRunning(true);
      else renderer.showWorking();
      const card = controls.get(n.requestId)?.card;
      if (card?.expire) answeredCards.set(n.requestId, card);
      while (answeredCards.size > 20) answeredCards.delete(answeredCards.keys().next().value);
    }
    controls.delete(n.requestId);
    if (!controls.size) setStatus(st.running ? 'working' : 'idle');
    syncBlocked();
  }

  /** The locked-card label for who answered: WhatsApp by name, the panel as `fallback`. */
  function resolvedLabel(who, fallback = null) {
    if (who === 'whatsapp') return tt('assistant.control.state.answeredOnWhatsApp', 'Answered on WhatsApp');
    if (who && who !== 'ui') return tt('assistant.control.state.resolvedBy', 'Resolved by {who}', { who });
    return fallback || tt('assistant.control.state.resolved', 'Resolved');
  }

  function lockControl(requestId, label) {
    const entry = controls.get(String(requestId));
    const routeCard = routeCardByRequest(requestId);
    if (routeCard) {
      routeCard.lock(label);
      routeCard.destroy();
      routeCards.delete(routeCard.routeId);
      routeChip.render();
    } else if (entry) {
      entry.card.lock(label);
    }
    if (!entry && !routeCard) return;
    controls.delete(String(requestId));
    if (!controls.size) setStatus(st.running ? 'working' : 'idle');
    syncBlocked();
  }

  // ── Sending ──
  function sendQuery(payload) {
    if (guestBlocked()) return false;
    const prompt = buildPromptText(payload);
    if (!prompt && !payload.images?.length) return false;
    const b = st.brain;
    const msg = {
      type: 'query',
      prompt,
      cwd: b.project || undefined,
      model: b.model || undefined,
      effort: b.effort || undefined,
      permissionMode: b.permissionMode || 'default',
      planMode: b.planMode === true,
      brain: { ...b },
      // A refusal carries it back to this panel alone (the 'error' case restores the text).
      request_id: `q-${Date.now().toString(36)}-${(querySeq += 1)}`,
    };
    if (payload.images?.length) msg.images = payload.images.map(i => ({ base64: i.base64, mediaType: i.mediaType }));
    const row = renderer.appendUser(payload.display ?? payload.text, { images: payload.images, files: [...(payload.files || []), ...(payload.uploads || [])], memories: payload.memories });
    director.sent();
    sentQueries.set(msg.request_id, { payload, row });
    while (sentQueries.size > 20) sentQueries.delete(sentQueries.keys().next().value);
    st.turnStartedAt = Date.now();
    setRunning(true);
    sock.send(msg);
    // Name the conversation like the server will (its first prompt) — not the tab.
    if (!st.sessionTitle || /^(?:SynaBun|Assistant(?: \d+)?)$/.test(st.sessionTitle)) {
      const guess = String(payload.text || '').split('\n')[0].trim().slice(0, 60);
      if (guess) st.sessionTitle = guess;
    }
    return true;
  }

  async function submit(payload) {
    if (guestBlocked()) return false;
    const parsed = parseSlashCommand(payload.text);
    if (parsed && !parsed.passthrough) {
      const handled = await runSlash(parsed, payload);
      return handled === false ? false : 'sent';
    }
    if (st.running) {
      st.queue.push(payload);
      composer.setQueue(st.queue);
      return 'queued';
    }
    return sendQuery(payload) ? 'sent' : false;
  }

  function clearTranscript() {
    renderer.clear(); // what was on screen is forgotten with it
    renderer.showEmpty();
  }

  async function runSlash(parsed, payload) {
    switch (parsed.name) {
      case 'help':
        renderer.appendUser(payload.text);
        renderer.appendAssistantMarkdown(slashHelpMarkdown((c) => tt(c.descKey, c.desc)));
        return true;
      case 'clear':
        clearTranscript();
        return true;
      case 'compact':
        compact();
        return true;
      case 'new':
        newSession(parsed.provider || null);
        return true;
      case 'resume':
        if (parsed.sessionId) resume(parsed.sessionId);
        else sock.send({ type: 'list_sessions' });
        return true;
      case 'stop':
        if (parsed.all) await stopAll();
        else if (parsed.target) await stopRun(parsed.target);
        else abort();
        return true;
      case 'agents': {
        const runs = dock.getRuns();
        const lines = runs.length ? runs.map((r, i) => `- ${fmtRunLine(r, { index: i + 1 })}`) : [`_${tt('assistant.dock.emptyShort', 'No dispatched agents yet.')}_`];
        renderer.appendUser(payload.text);
        renderer.appendAssistantMarkdown(`**${tt('assistant.dock.title', 'Agents')}**\n\n${lines.join('\n')}`);
        if (!parsed.all && runs.length) dock.setOpen(true);
        return true;
      }
      case 'recall':
        if (parsed.error) { toast(tt('assistant.slash.needsQuery', 'Usage: /recall <query>')); return false; }
        return queueOrSend({ ...payload, display: payload.text, text: tt('assistant.prompts.recall', 'Use the SynaBun recall tool to search memory for: "{query}". Summarize the most relevant results with their IDs.', { query: parsed.query }) });
      case 'remember':
        if (parsed.error) { toast(tt('assistant.slash.needsText', 'Usage: /remember <text>')); return false; }
        return queueOrSend({ ...payload, display: payload.text, text: tt('assistant.prompts.remember', 'Store this in SynaBun memory with the remember tool (pick a fitting category, project, tags and importance): {text}', { text: parsed.text }) });
      case 'model': {
        if (!parsed.model && !parsed.provider) { picker.openField('model'); return true; }
        const next = { ...st.brain };
        let requiresSwitch = false;
        if (parsed.provider && parsed.provider !== st.brain.provider) { next.provider = parsed.provider; next.model = ''; next.effort = null; next.agent = null; next.accountId = null; requiresSwitch = true; }
        if (parsed.model) next.model = parsed.model;
        if (parsed.effort) next.effort = parsed.effort === 'off' ? null : parsed.effort;
        applyBrain(normalizeBrain(next), { requiresSwitch, field: 'model' });
        picker.refresh().catch(() => {});
        return true;
      }
      case 'project':
        if (!parsed.path) { picker.openField('project'); return true; }
        applyBrain({ ...st.brain, project: parsed.path === 'none' ? null : parsed.path }, { requiresSwitch: false, field: 'project' });
        return true;
      case 'models':
        if (parsed.error) { toast(tt('assistant.slash.modelsUsage', 'Usage: /models [list | hide <id…> | show <id…>]')); return false; }
        if (parsed.action === 'open') { openModels(parsed.tab); return true; }
        return runModelsSlash(parsed, payload);
      case 'budget':
        openBudget();
        return true;
      case 'routes':
        if (parsed.error) { toast(tt('assistant.slash.routesUsage', 'Usage: /routes [always|unsure|never]')); return false; }
        if (!routingAvailable()) { toast(tt('assistant.slash.routesUnavailable', 'Model routing is not available on this server.')); return true; }
        if (parsed.mode) setRouteMode(parsed.mode);
        else openRoutes();
        return true;
      case 'computer':
        if (parsed.error) { toast(tt('assistant.slash.computerUsage', 'Usage: /computer [on|off]')); return false; }
        if (!computerAvailable()) { toast(tt('assistant.slash.computerUnavailable', 'Computer use is not available here.')); return true; }
        // A WhatsApp conversation: the command answers with what is in effect and why.
        if (st.computerRemote) { explainRemoteComputer(); return true; }
        setComputerUse(parsed.mode ? parsed.mode === 'on' : !st.computerEffective);
        renderer.appendStatus(st.computerEffective ? tt('assistant.status.computerOn', 'Computer use is on.') : tt('assistant.status.computerOff', 'Computer use is off.'));
        return true;
      case 'dispatch': {
        if (parsed.error) {
          toast(dispatchErrorText(parsed));
          return false;
        }
        await dispatch(parsed, payload);
        return true;
      }
      default:
        return queueOrSend(payload);
    }
  }

  function dispatchErrorText(parsed) {
    switch (parsed.error) {
      case 'missing_provider': return tt('assistant.slash.dispatchProvider', 'Usage: /dispatch <claude|codex|opencode> [flags] <task>');
      case 'invalid_provider': return tt('assistant.slash.dispatchInvalidProvider', 'Unknown provider "{provider}". Use claude, codex or opencode.', { provider: parsed.provider });
      case 'unknown_flag': return tt('assistant.slash.dispatchUnknownFlag', 'Unknown flag --{flag}', { flag: parsed.flag });
      case 'missing_flag_value': return tt('assistant.slash.dispatchFlagValue', 'Flag --{flag} needs a value', { flag: parsed.flag });
      case 'missing_task': return tt('assistant.slash.dispatchTask', 'Add the task text after the flags');
      default: return tt('assistant.slash.dispatchBad', 'Could not parse /dispatch');
    }
  }

  function queueOrSend(payload) {
    if (st.running) { st.queue.push(payload); composer.setQueue(st.queue); return true; }
    return sendQuery(payload);
  }

  async function dispatch(parsed, payload) {
    const spec = buildDispatchSpec(parsed, st.brain, { assistantSessionId: sessionId });
    renderer.appendUser(payload.text);
    try {
      const res = await dispatchAssistantRun(spec);
      const run = runFromPayload(res) || res?.run;
      if (run) {
        dock.upsertRun(run);
        renderer.upsertRunCard(dock.getRun(run.runId) || run);
        if (res.queued) renderer.appendStatus(tt('assistant.status.queued', 'Queued at position {position} (concurrency limit).', { position: res.position ?? '?' }));
      } else {
        renderer.appendStatus(tt('assistant.status.dispatched', 'Dispatched.'));
      }
    } catch (err) {
      renderer.appendError(`${tt('assistant.status.dispatchFailed', 'Dispatch failed')}: ${err?.message || err}`);
    }
  }

  function abort() {
    if (!st.running && !controls.size) return;
    sock.send({ type: 'abort' });
    renderer.appendStatus(tt('assistant.status.aborting', 'Aborting…'));
  }

  function compact() {
    sock.send({ type: 'compact' });
    renderer.appendDivider(tt('assistant.compacting', 'compacting…'));
    if (!st.running) setRunning(true, { label: tt('assistant.compacting', 'compacting…') });
  }

  function newSession(provider) {
    const b = provider ? normalizeBrain({ ...st.brain, provider, model: '', effort: null, agent: null, accountId: null }) : st.brain;
    emit('assistant:new', { brain: b, host: hostId });
  }

  function resume(id) {
    if (!id) return;
    if (String(id).startsWith('assistant-')) { emit('assistant:resume', { sessionId: id, host: hostId }); return; }
    sock.send({ type: 'resume', providerSessionId: id });
    renderer.appendDivider(tt('assistant.status.resuming', 'resuming {id}', { id: String(id).slice(0, 8) }));
  }

  function applyBrain(next, meta = {}) {
    const before = st.brain;
    st.brain = normalizeBrain(next);
    const applied = st.brain;
    picker.render();
    host.setBrain?.(st.brain);
    persist();
    if (meta.silent) return;
    if (meta.requiresSwitch) {
      const b = st.brain;
      sock.send({ type: 'switch_brain', brain: b.provider, model: b.model || undefined, effort: b.effort || undefined, accountId: b.accountId || undefined, mcpProfile: b.mcpProfile || undefined, cwd: b.project || undefined, agent: b.agent || undefined, permissionMode: b.permissionMode, planMode: b.planMode === true });
      renderer.appendDivider(`${tt('assistant.status.brain', 'brain')} → ${brainLabel(b)}`);
      renderer.forgetSeen(); // the new brain's ids start over
    } else if (before.permissionMode !== st.brain.permissionMode || !!before.planMode !== !!st.brain.planMode) {
      sock.send({ type: 'set_permission_mode', mode: st.brain.permissionMode, planMode: st.brain.planMode === true });
    }
    if (before.project !== st.brain.project) renderer.refreshEmpty();
    patchAssistantSession(sessionId, { brain: st.brain }).catch((err) => {
      // Refused (a model disabled in Assistant → Models): undo, so the refused
      // brain is neither shown nor saved as the last used one — the next start
      // would ask for it again. A brain switch already got the error on the socket.
      if (err?.code !== 'MODEL_DISABLED' || destroyed || st.brain !== applied) return;
      st.brain = before;
      picker.render();
      host.setBrain?.(before);
      persist();
      if (!meta.requiresSwitch) renderer.appendError(err.message || String(err));
    });
  }

  // ── Runs ──
  async function focusRun(runId) {
    if (!runId) return;
    focusAssistantRun(runId).catch(() => {});
    try { await focusNativeLoopRun(runId); } catch { /* router not ready */ }
  }

  async function stopRun(runId) {
    if (!runId) return;
    try { await stopAssistantRun(runId); toast(tt('assistant.status.stopRequested', 'Stop requested for {id}', { id: String(runId).slice(0, 8) })); }
    catch (err) { renderer.appendError(`${tt('assistant.status.stopFailed', 'Stop failed')}: ${err?.message || err}`); }
  }

  async function removeRun(runId) {
    if (!runId) return;
    try {
      const res = await removeAssistantRun(runId, sessionId);
      dock.dropRuns(res?.removed?.length ? res.removed : [runId]);
    } catch (err) {
      renderer.appendError(`${tt('assistant.run.removeFailed', 'Could not remove the run')}: ${err?.message || err}`);
    }
  }

  async function clearFinished() {
    try {
      const res = await clearFinishedAssistantRuns(sessionId);
      dock.dropRuns(res?.removed || []);
    } catch (err) {
      renderer.appendError(`${tt('assistant.run.removeFailed', 'Could not remove the run')}: ${err?.message || err}`);
    }
  }

  async function stopAll() {
    try { await killAllAssistantRuns(sessionId); toast(tt('assistant.status.stopAllRequested', 'Stopping all dispatched agents…')); }
    catch (err) { renderer.appendError(`${tt('assistant.status.stopFailed', 'Stop failed')}: ${err?.message || err}`); }
  }

  async function escalateRun(runId, target) {
    if (!runId) return;
    try {
      const res = await escalateAssistantRun(runId, target || undefined);
      const run = runFromPayload(res) || res?.run;
      if (run) { dock.upsertRun(run); renderer.upsertRunCard(dock.getRun(run.runId) || run); }
      renderer.appendStatus(tt('assistant.status.escalated', 'Escalated {id}.', { id: String(runId).slice(0, 8) }));
      const current = dock.getRun(runId);
      if (current?.escalation) {
        const patched = dock.patchRun(runId, { escalation: { ...current.escalation, started: true } });
        if (patched) renderer.upsertRunCard(patched);
      }
    } catch (err) {
      renderer.appendError(`${tt('assistant.status.escalateFailed', 'Escalation failed')}: ${err?.message || err}`);
    }
  }

  async function readRun(runId) {
    if (!runId) return;
    try {
      let result = null;
      try { result = await getAssistantRunResult(runId); } catch { /* not finished yet */ }
      const payload = result?.result ?? result;
      const run = dock.getRun(runId) || runFromPayload(await getAssistantRun(runId).catch(() => null));
      const head = `**${tt('assistant.run.resultOf', 'Result of')} ${run?.title || String(runId).slice(0, 8)}**`;
      let body = '';
      if (payload && typeof payload === 'object') {
        const bits = [];
        if (payload.status) bits.push(`_${payload.status}_`);
        if (payload.summary) bits.push(payload.summary);
        if (Array.isArray(payload.files) && payload.files.length) bits.push(`${tt('assistant.run.files', 'Files')}: ${payload.files.map(f => `\`${f}\``).join(', ')}`);
        // Image / video creation: each generated file, images shown inline, with its path.
        const media = (Array.isArray(payload.media) ? payload.media : []).filter(m => m?.url && /^\/api\/assistant\/runs\//.test(String(m.url)));
        if (media.length) bits.push(media.map(m => (m.kind === 'image' ? `![](${m.url})\n\`${m.path}\`` : `[${tt('assistant.run.mediaVideoLink', 'Video')}](${m.url}) · \`${m.path}\``)).join('\n\n'));
        if (Array.isArray(payload.follow_ups) && payload.follow_ups.length) bits.push(`${tt('assistant.run.followUps', 'Follow-ups')}:\n${payload.follow_ups.map(f => `- ${f}`).join('\n')}`);
        if (payload.question) bits.push(`**${tt('assistant.run.question', 'Question')}:** ${payload.question}`);
        if (!bits.length && payload.raw) bits.push(String(payload.raw).slice(0, 4000));
        if (!bits.length && payload.text) bits.push(String(payload.text).slice(0, 4000));
        body = bits.join('\n\n');
      } else if (typeof payload === 'string') body = payload.slice(0, 4000);
      if (!body) body = `_${tt('assistant.run.noResult', 'No result yet')}_ · ${run ? fmtRunLine(run) : runId}`;
      renderer.appendAssistantMarkdown(`${head}\n\n${body}`);
      if (run) renderer.upsertRunCard(run, { result: payload && typeof payload === 'object' ? payload : null });
    } catch (err) {
      renderer.appendError(`${tt('assistant.run.readFailed', 'Could not read result')}: ${err?.message || err}`);
    }
  }

  // ── Menus ──
  function showSessionsMenu(list) {
    const sessions = (Array.isArray(list) ? list : []).filter(s => s?.id);
    const items = [
      { id: 'new', label: tt('assistant.topbar.new', 'New assistant session'), desc: brainLabel(st.brain), icon: ICON_NEW, onSelect: () => newSession(null) },
      { kind: 'separator' },
    ];
    if (!sessions.length) items.push({ kind: 'info', label: tt('assistant.sessions.empty', 'No other sessions') });
    else items.push({ kind: 'header', label: tt('assistant.sessions.recent', 'Recent') });
    for (const s of sessions.slice(0, 30)) {
      const isCurrent = s.id === sessionId;
      const b = s.brain && typeof s.brain === 'object' ? s.brain : { provider: s.brain, model: s.model, effort: s.effort };
      items.push({
        kind: 'radio',
        id: s.id,
        label: s.title || s.label || s.id,
        desc: [brainLabel(b), relativeTime(s.updatedAt || s.createdAt), s.status].filter(Boolean).join(' · '),
        selected: isCurrent,
        onSelect: () => { if (!isCurrent) emit('assistant:resume', { sessionId: s.id, host: hostId }); },
      });
    }
    openMenu(sessionsBtn, {
      title: tt('assistant.topbar.sessions', 'Sessions'),
      items,
      role: 'menu',
      placement: 'below',
      width: 300,
      filter: sessions.length > 8,
      filterPlaceholder: tt('assistant.sessions.filter', 'Filter sessions…'),
    });
  }

  function engineText() {
    if (!st.engine) return '';
    return `${st.engine}${st.sdkVersion ? ` ${st.sdkVersion}` : ''}`;
  }

  /** Shown in the bar right now (container queries hide controls without touching attributes). */
  function isRendered(node) {
    return !!node && !node.hidden && node.isConnected && node.getClientRects().length > 0;
  }

  /** The toolbar "⋯": whatever the bar cannot show at this width, then conversation actions. */
  function openMore() {
    const fields = picker.fieldSummary().filter((f) => !f.hidden && !isRendered(picker.buttons[f.field]));
    const routeHidden = routeChip.isVisible() && !isRendered(routeChip.el);
    const computerHidden = !computerToggle.el.hidden && !isRendered(computerToggle.el);
    const agentsHidden = !agentsBtn.hidden && !isRendered(agentsBtn);
    const items = [];
    if (fields.length || routeHidden || computerHidden || agentsHidden) {
      items.push({ kind: 'header', label: tt('assistant.toolbar.conversation', 'This conversation') });
      for (const f of fields) {
        items.push({ id: `field-${f.field}`, label: f.label, desc: f.value, icon: f.icon, color: f.color, onSelect: () => picker.openField(f.field, moreBtn) });
      }
      if (routeHidden) {
        items.push({ id: 'route-mode', label: tt('assistant.routes.title', 'Model routing'), desc: routeModeLabel(routeChip.mode(), t), icon: ICON_ROUTE, onSelect: () => routeChip.open(moreBtn) });
      }
      if (computerHidden) {
        items.push({
          kind: 'check',
          id: 'computer',
          label: tt('assistant.computer.use', 'Computer use'),
          // A WhatsApp conversation: the item shows what is in effect and why; picking it explains, never toggles.
          ...(st.computerRemote ? { desc: computerRemoteView(st.computerRemote, t)?.tip || '' } : {}),
          icon: ICON_COMPUTER,
          checked: st.computerRemote ? computerRemoteView(st.computerRemote, t)?.on === true : st.computerEffective,
          disabled: st.desktopSupported === false,
          onSelect: () => setComputerUse(!st.computerEffective),
        });
      }
      if (agentsHidden) {
        items.push({ kind: 'check', id: 'agents', label: tt('assistant.topbar.agents', 'Dispatched agents'), desc: agentsCount.textContent, icon: ICON_AGENTS, checked: dock.isOpen(), onSelect: () => toggleDock() });
      }
      items.push({ kind: 'separator' });
    }
    items.push({ id: 'attach', label: tt('assistant.composer.attach', 'Attach files'), onSelect: () => composer.openFilePicker() });
    items.push({ id: 'compact', label: tt('assistant.topbar.compact', 'Compact context'), onSelect: () => compact() });
    if (routingAvailable()) items.push({ id: 'routes', label: tt('assistant.routes.editor', 'Model routes…'), icon: ICON_ROUTE, onSelect: () => openRoutes() });
    items.push({ id: 'models', label: tt('assistant.models.menu', 'Models…'), onSelect: () => openModels() });
    items.push({ id: 'budget', label: tt('assistant.budget.menu', 'Budget…'), desc: st.budget ? `${fmtCost(st.budget.totalUsd) || '$0.00'} / ${fmtCost(st.budget.hardUsd)}` : '', onSelect: () => openBudget() });
    items.push({ id: 'clear', label: tt('assistant.topbar.clear', 'Clear transcript'), onSelect: () => clearTranscript() });
    items.push({ id: 'help', label: tt('assistant.topbar.helpShortcuts', 'Help & shortcuts'), onSelect: () => openHelp() });
    items.push({ kind: 'separator' });
    if (engineText()) items.push({ kind: 'info', label: tt('assistant.topbar.engine', 'Engine'), value: engineText() });
    items.push({ kind: 'info', label: tt('assistant.topbar.cost', 'Session cost'), value: fmtCost(totalCost()) || '$0.00' });
    if (Number(st.dispatchUsd) > 0) items.push({ kind: 'info', label: tt('assistant.topbar.agentsCost', 'Agents'), value: fmtCost(st.dispatchUsd) });
    openMenu(moreBtn, { label: tt('assistant.toolbar.more', 'More options'), items, role: 'menu', placement: 'below', width: 280 });
  }

  // Assistant → Models: switch models off (hidden from routing, dispatch and every model menu).
  function openModels(tab = 'available') {
    openModelsManager({
      t,
      tab,
      providerIcon,
      getBrain: () => st.brain,
      onToast: toast,
      onChanged: () => picker.refresh(true).catch(() => {}),
    }).catch(() => {});
  }

  /** /models list|hide|show: one PATCH, then a short report (the server resolves ids and providers). */
  async function runModelsSlash(parsed, payload) {
    renderer.appendUser(payload.text);
    try {
      if (parsed.action === 'list') {
        // Per provider: how many are on, then every archived id (context variants
        // are their own ids; "not listed" = no provider lists it any more).
        const data = await fetchManageCatalog();
        const lines = Object.entries(data?.models || {}).map(([provider, rows]) => {
          const list = Array.isArray(rows) ? rows : [];
          const archived = Array.isArray(data?.archived?.[provider]) ? data.archived[provider] : [];
          const ids = archived.slice(0, 60).map((a) => `\`${a.id}\`${a.listed ? '' : ` (${tt('assistant.models.notListed', 'not listed')})`}`);
          if (archived.length > ids.length) ids.push(tt('assistant.models.moreArchived', '+{count} more — /models archived', { count: String(archived.length - ids.length) }));
          const on = tt('assistant.models.countOn', '{on} of {total} on', { on: String(list.filter((r) => !r.hidden).length), total: String(list.length) });
          return `- **${provider}** — ${on}; ${tt('assistant.models.tabArchived', 'Archived')}: ${ids.length ? ids.join(', ') : tt('assistant.models.noneHidden', 'none off')}`;
        });
        renderer.appendAssistantMarkdown(`**${tt('assistant.models.title', 'Models')}**\n\n${lines.join('\n')}`);
        return true;
      }
      const res = await patchHiddenModels({ [parsed.action]: parsed.ids });
      const done = (res?.applied || []).map((a) => `\`${a.provider}/${a.id}\``).join(', ');
      renderer.appendStatus(parsed.action === 'hide'
        ? tt('assistant.models.hiddenNow', 'Switched off: {models}', { models: done })
        : tt('assistant.models.shownNow', 'Switched on: {models}', { models: done }));
      picker.refresh(true).catch(() => {});
      return true;
    } catch (err) {
      renderer.appendError(`${tt('assistant.models.saveFailed', 'Could not update the model')}: ${err?.message || err}`);
      return true;
    }
  }

  // Assistant → Budget: the money caps (applied live by the server).
  function openBudget() {
    openBudgetEditor({
      t,
      sessionId,
      brainMetered: st.brainMetered !== false && st.brain?.provider !== 'codex',
      onToast: toast,
      onSaved: (res) => { if (res?.session) { st.budget = res.session; renderCost(); } },
    }).catch(() => {});
  }

  function openRoutes() {
    openRoutesEditor({
      t,
      providerIcon,
      getBrain: () => st.brain,
      brainName: () => brainModelLabel(),
      onToast: toast,
      onSaved: (routing) => {
        if (routing?.defaultMode) {
          const def = normalizeRouteMode(routing.defaultMode, DEFAULT_ROUTE_MODE);
          st.routing = { ...(st.routing || {}), defaultMode: def, effectiveMode: st.routeMode || def };
          routeChip.render();
        }
        toast(tt('assistant.routes.saved', 'Model routes saved.'));
      },
    }).catch(() => {});
  }

  // ── Help ──
  function openHelp() {
    if (helpModal) { helpModal.remove(); helpModal = null; return; }
    const overlay = el('div', 'asst-modal-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', tt('assistant.help.title', 'Assistant help'));
    const modal = el('div', 'asst-modal');
    modal.innerHTML = `<div class="asst-modal-head"><span class="asst-icon">${ICON_ASSISTANT}</span><span>${esc(tt('assistant.help.title', 'Assistant help'))}</span><button type="button" class="asst-iconbtn asst-modal-close" aria-label="${esc(tt('common.close', 'Close'))}">${ICON_CLOSE}</button></div><div class="asst-modal-body asst-md"></div>`;
    const body = modal.querySelector('.asst-modal-body');
    const keys = [
      `- \`Enter\` — ${tt('assistant.help.keySend', 'send')} · \`Shift+Enter\` — ${tt('assistant.help.keyNewline', 'new line')} · \`Esc\` — ${tt('assistant.help.keyAbort', 'abort the running turn')}`,
      `- ${tt('assistant.help.keyRoute', 'Route card: `1`–`4` choose · `↑`/`↓` move · `Enter` runs · `Esc` cancels')}`,
      `- ${tt('assistant.help.keyComputer', '`Esc` anywhere stops computer control immediately')}`,
      `- ${tt('assistant.help.keyToolbar', 'Toolbar: `←`/`→` move between controls · `Home`/`End` jump to the ends')}`,
      `- ${tt('assistant.help.keyDrop', 'Drop files, memories from the graph or images from the whiteboard onto the composer to attach them.')}`,
    ];
    mdInto(body, `${tt('assistant.help.intro', 'The assistant thinks with the selected brain (Claude, Codex or OpenCode), recalls memories on every turn and can dispatch work to the sidepanel agents.')}\n\n${slashHelpMarkdown((c) => tt(c.descKey, c.desc))}\n\n**${tt('assistant.help.keys', 'Keys')}**\n\n${keys.join('\n')}`);
    overlay.appendChild(modal);
    const returnTo = document.activeElement;
    const close = () => {
      overlay.remove();
      helpModal = null;
      document.removeEventListener('keydown', onKey, true);
      if (returnTo?.isConnected) { try { returnTo.focus({ preventScroll: true }); } catch { /* ignore */ } }
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } else e.stopPropagation(); };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    modal.querySelector('.asst-modal-close').addEventListener('click', close);
    document.body.appendChild(overlay);
    helpModal = overlay;
    modal.querySelector('.asst-modal-close').focus();
  }

  // ── Toolbar wiring (right group) ──
  sessionsBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (isMenuOpen(sessionsBtn)) { closeMenu(); return; }
    let list = [];
    try { list = await listAssistantSessions(); } catch { /* server not ready */ }
    if (!destroyed) showSessionsMenu(list);
  });
  function toggleDock() {
    dock.setOpen(!dock.isOpen());
    agentsBtn.setAttribute('aria-pressed', dock.isOpen() ? 'true' : 'false');
  }
  agentsBtn.addEventListener('click', () => toggleDock());
  newBtn.addEventListener('click', () => newSession(null));
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMenuOpen(moreBtn)) { closeMenu(); return; }
    openMore();
  });
  // The spend chip opens the Budget tab.
  costEl.addEventListener('click', () => openBudget());

  // Esc stops computer control from anywhere, before any other handler runs.
  const onEscCapture = (e) => {
    if (e.key !== 'Escape' || destroyed) return;
    if (computerPanel.isActive()) computerPanel.stop('esc');
  };
  document.addEventListener('keydown', onEscCapture, true);

  // Esc inside the assistant aborts a running turn — after route cards, menus,
  // the slash list and the composer had their turn (they preventDefault), so
  // the same key cancels a card instead of the turn. Both hosts rely on this.
  const onRootKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || destroyed || !st.running) return;
    e.preventDefault();
    e.stopPropagation();
    abort();
  };
  // A toolbar placed in the host's header is still part of the assistant.
  const surfaces = root.contains(barEl) ? [root] : [root, barEl];
  surfaces.forEach((node) => node.addEventListener('keydown', onRootKey));

  // Last-used tracking for Apps → Assistant / `a` / Ctrl+A (ui-assistant.js).
  const onFocusIn = () => { if (!destroyed) { emit('assistant:focused', { sessionId, host: hostId }); director.touch(); } };
  surfaces.forEach((node) => node.addEventListener('focusin', onFocusIn));

  // ── Bus ──
  unsubs.push(on('sync:assistant:session-updated', (msg) => { const s = msg?.session || msg; if (s?.id === sessionId) applySessionMeta(s); }));
  unsubs.push(on('sync:assistant:cost', (msg) => { if (!msg?.assistantSessionId || msg.assistantSessionId === sessionId) applyCost(msg); }));
  unsubs.push(on('sync:assistant:mailbox', (msg) => { if (msg?.assistantSessionId === sessionId) renderer.appendMailbox(msg.items || msg.events || []); }));
  unsubs.push(on('sync:assistant:permission-request', (msg) => {
    const run = runFromPayload(msg);
    const runId = msg?.runId || run?.runId || null;
    const owned = (msg?.assistantSessionId || run?.assistantSessionId) === sessionId || (runId && dock.getRun(runId));
    if (!owned) return;
    const requestId = msg.request_id || msg.requestId || msg.request?.requestId;
    if (!requestId || controls.has(String(requestId))) return;
    const provider = msg.provider || dock.getRun(runId)?.provider || null;
    showControl({ request_id: requestId, request: msg.request, provider, runId }, { runId, provider });
  }));
  unsubs.push(on('sync:assistant:permission-resolved', (msg) => {
    const requestId = msg?.request_id || msg?.requestId;
    if (requestId) lockControl(requestId, resolvedLabel(msg.resolvedBy));
  }));
  unsubs.push(on('sync:assistant:desktop', (msg) => computerPanel.applyDesktop(msg)));
  unsubs.push(on('sync:assistant:desktop-setup', (msg) => computerPanel.applySetup(msg)));
  // Models switched on/off elsewhere: the open Models manager reloads (the menus drop their cache on their own).
  unsubs.push(on('sync:assistant:hidden-models-changed', () => refreshModelsManager()));
  unsubs.push(on('sync:opencode:hidden-models-changed', () => refreshModelsManager()));
  unsubs.push(on('sync:assistant:routing-changed', (msg) => {
    const routing = msg?.routing || msg;
    const def = normalizeRouteMode(routing?.defaultMode, null);
    if (!def) return;
    st.routing = { ...(st.routing || {}), defaultMode: def, effectiveMode: st.routeMode || def };
    routeChip.render();
  }));
  unsubs.push(on('session:info', () => updateGuest()));
  unsubs.push(on('permissions:changed', () => updateGuest()));

  function updateGuest() {
    composer.setDisabled(guestBlocked(), tt('assistant.composer.guestBlocked', 'Assistant access is disabled by the host'));
  }

  // ── Rehydration ──
  async function rehydrate({ force = false } = {}) {
    try {
      const data = await getAssistantSession(sessionId);
      const meta = data?.session || data;
      applySessionMeta(meta);
      const transcript = data?.transcript || data?.messages || meta?.transcript || [];
      if (force) renderer.clear();
      if (Array.isArray(transcript) && transcript.length) renderer.renderTranscript(transcript);
      renderer.showEmpty(); // no-op once the transcript has rows
      for (const run of (Array.isArray(data?.runs) ? data.runs : [])) dock.upsertRun(run);
    } catch (err) {
      console.warn('[assistant] could not restore the conversation', err);
      renderer.showEmpty();
    }
  }

  // ── Boot ──
  syncTabLabel(); // legacy "Assistant 11" / first-prompt tab labels become "SynaBun"
  renderCost();
  renderStatus();
  updateGuest();
  host.setBrain?.(st.brain);
  if (session && typeof session === 'object') applySessionMeta(session);
  else applyFeatures();
  rehydrate().finally(() => {
    if (destroyed) return;
    probeFeatures();
    applyLastUsedRouteMode();
    sock.connect();
  });
  fetchUsage();

  const controller = {
    sessionId,
    el: root,
    getBrain: () => st.brain,
    setBrain: (b, meta) => applyBrain(b, meta || { requiresSwitch: false, field: 'external' }),
    getTitle: () => st.title,
    setTitle: (text) => { st.userRenamed = true; setTitle(text); },
    isRunning: () => st.running,
    isConnected: () => st.connected,
    send: (text, extra = {}) => submit({ text: String(text ?? ''), images: extra.images || [], files: extra.files || [], uploads: extra.uploads || [], memories: extra.memories || [] }),
    abort,
    compact,
    newSession,
    resume,
    setRouteMode: (mode) => setRouteMode(mode),
    setComputerUse: (enabled) => setComputerUse(enabled),
    attachMemory: (node) => composer.addMemory(node),
    attachImageDataUrl: (dataUrl, name) => composer.addImageDataUrl(dataUrl, name),
    insertText: (text) => composer.insertText(text),
    /** A file path from the explorer ("send to panel") → the composer, as inline code. */
    attachPath: (path) => { if (path) { composer.insertText(`\`${path}\` `); composer.focus(); } },
    /** The server's name for the conversation (first prompt) — tooltips, never the tab label. */
    getConversationTitle: () => st.sessionTitle || '',
    getStatus: () => st.status || 'idle',
    focus: () => composer.focus(),
    onShown: () => { syncTabLabel(); renderer.scrollEnd(true); if (visible()) composer.focus(); director.touch(); director.visibilityChanged(); },
    onHidden: () => { closeMenu(); picker.close(); director.stopTyping(); director.visibilityChanged(); },
    counts: () => dock.counts(),
    destroy: ({ closeServer = false } = {}) => {
      if (destroyed) return;
      destroyed = true;
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      clearTimeout(announceTimer);
      if (replay) { clearTimeout(replay.timer); replay = null; }
      director.destroy();
      usage.destroy();
      clearTimeout(limitTimer);
      try { storage.setItem(tabStorageKey(sessionId), JSON.stringify(serializeTabState(st))); } catch { /* ignore */ }
      unsubs.forEach(off => { try { off(); } catch { /* ignore */ } });
      document.removeEventListener('keydown', onEscCapture, true);
      surfaces.forEach((node) => { node.removeEventListener('keydown', onRootKey); node.removeEventListener('focusin', onFocusIn); });
      closeMenu();
      closeFrameLightbox();
      if (helpModal) { helpModal.remove(); helpModal = null; }
      for (const card of routeCards.values()) card.destroy();
      routeCards.clear();
      sock.close();
      roving.destroy();
      picker.destroy();
      routeChip.destroy();
      computerToggle.destroy();
      computerPanel.destroy();
      dock.destroy();
      composer.destroy();
      renderer.destroy();
      barEl.remove(); // it may live in the host's header
      root.remove();
      if (closeServer) {
        closeAssistantSession(sessionId).catch(() => {});
        try { storage.removeItem(tabStorageKey(sessionId)); } catch { /* ignore */ }
      }
    },
  };
  return controller;
}
