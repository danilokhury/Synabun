// SynaBun sidepanel tray placeholders.
// Renders minimized pills for persisted sidepanel tabs before a panel is booted.

import { storage } from './storage.js';
import { emit } from './state.js';
import { getProviderMeta } from './provider-icons.js';
import { toggleClaudePanel, isClaudePanelOpen } from './ui-claude-panel.js';
import { toggleCodexPanel, isCodexPanelOpen } from './ui-codex-panel.js';
import { toggleOpencodePanel, isOpencodePanelOpen } from './ui-opencode-panel.js';

const PLACEHOLDER_CLASS = 'sidepanel-tray-placeholder';

const PROVIDERS = {
  claude: {
    providerId: 'claude-code',
    windowKey: 'cp-window-id',
    tabsKeyPrefix: 'synabun-claude-panel-tabs',
    pillClass: 'cp-session-pill',
    eventName: 'claude-panel:show',
  },
  codex: {
    providerId: 'codex',
    windowKey: 'cxp-window-id',
    tabsKeyPrefix: 'synabun-codex-panel-tabs',
    pillClass: 'cxp-session-pill',
    eventName: 'codex-panel:show',
  },
  opencode: {
    providerId: 'opencode',
    windowKey: 'ocp-window-id',
    tabsKeyPrefix: 'synabun-ocp-tabs',
    pillClass: 'ocp-session-pill',
    eventName: 'opencode-panel:show',
  },
};

const _loadedProviders = new Set();
let _initialized = false;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseJson(raw, fallback = null) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function ensureWindowId(key) {
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

function scopedTabsKey(meta) {
  return `${meta.tabsKeyPrefix}-${ensureWindowId(meta.windowKey)}`;
}

function normalizeLabel(value) {
  return String(value || '').trim();
}

function isDefaultLabel(label, defaults) {
  const normalized = normalizeLabel(label).toLowerCase();
  return !normalized || defaults.includes(normalized);
}

function hasClaudeState(tab) {
  const label = normalizeLabel(tab.label);
  return !!(
    tab.sessionId
    || tab.running
    || tab.sessionCost
    || tab.planFilePath
    || tab.queue?.length
    || !isDefaultLabel(label, ['new chat', 'new session', 'claude'])
  );
}

function hasCodexState(tab) {
  const label = normalizeLabel(tab.pendingSessionLabel || tab.title || tab.sessionLabel);
  const draft = normalizeLabel(tab.draft);
  return !!(
    tab.threadId
    || tab.running
    || tab.startingThread
    || draft
    || tab.planContent
    || tab.editedPlanContent
    || tab.showPostPlanActions
    || tab.planApprovalPending
    || tab.showPostCompactionPrompt
    || tab.postCompactionPending
    || tab.queue?.length
    || !isDefaultLabel(label, ['new session', 'saved session', 'untitled session', 'codex'])
  );
}

function hasOpenCodeState(tab) {
  const label = normalizeLabel(tab.sessionTitle);
  const draft = normalizeLabel(tab.draft);
  return !!(
    tab.sessionId
    || tab.running
    || draft
    || tab.planContent
    || tab.editedPlanContent
    || tab.showPostPlanActions
    || tab.threadTokenUsage
    || !isDefaultLabel(label, ['new session', 'opencode'])
  );
}

function tabLabel(provider, tab) {
  if (provider === 'claude') return normalizeLabel(tab.label) || 'New chat';
  if (provider === 'codex') return normalizeLabel(tab.pendingSessionLabel || tab.title || tab.sessionLabel) || 'New session';
  return normalizeLabel(tab.sessionTitle || tab.title) || 'New session';
}

function tabId(provider, tab, index) {
  if (tab.id) return String(tab.id);
  if (provider === 'claude' && tab.sessionId) return String(tab.sessionId);
  if (provider === 'codex' && tab.threadId) return String(tab.threadId);
  if (provider === 'opencode' && tab.sessionId) return String(tab.sessionId);
  return `${provider}-${index}`;
}

function isRunning(tab) {
  return !!(tab.running || tab.startingThread);
}

function readPayload(key) {
  const data = parseJson(storage.getItem(key), null);
  if (Array.isArray(data?.tabs) && data.tabs.length) {
    return { key, activeIdx: Number(data.activeIdx) || 0, tabs: data.tabs };
  }
  return null;
}

// Resolve the payloads we'll source pills from. Priority:
//   1. Current windowId's tab key (if present, this is the only payload).
//   2. Otherwise, the single most-recent non-empty windowId for this provider
//      with at least one meaningful tab (so users on a fresh browser tab still
//      see pills for sessions they minimized in a prior tab).
// Plus any legacy single-session keys (kept for back-compat).
function providerPayloads(provider) {
  const meta = PROVIDERS[provider];
  if (!meta) return [];

  const payloads = [];
  const currentKey = scopedTabsKey(meta);
  const predicate = statePredicate(provider);

  const currentPayload = readPayload(currentKey);
  const currentHasMeaningful = currentPayload?.tabs.some(predicate);
  if (currentPayload) payloads.push(currentPayload);
  if (!currentHasMeaningful) {
    const fallback = pickMostRecentMeaningfulPayload(provider, currentKey);
    if (fallback) payloads.push(fallback);
  }

  if (provider === 'claude') {
    const legacy = parseJson(storage.getItem('synabun-claude-panel-tabs'), null);
    if (Array.isArray(legacy?.tabs) && legacy.tabs.length && !payloads.some((p) => p.key === 'synabun-claude-panel-tabs')) {
      payloads.push({ key: 'synabun-claude-panel-tabs', activeIdx: Number(legacy.activeIdx) || 0, tabs: legacy.tabs });
    }
    const sessionId = storage.getItem('synabun-claude-panel-session');
    if (sessionId) {
      const label = storage.getItem(`synabun-session-label:${sessionId}`) || `${sessionId.slice(0, 8)}...`;
      payloads.push({
        key: 'synabun-claude-panel-session',
        activeIdx: 0,
        tabs: [{ sessionId, label }],
        legacySingle: true,
      });
    }
  }

  if (provider === 'codex') {
    const threadId = storage.getItem('synabun-codex-panel-thread');
    const title = storage.getItem('synabun-codex-panel-title') || '';
    if (threadId || title) {
      payloads.push({
        key: 'synabun-codex-panel-thread',
        activeIdx: 0,
        tabs: [{
          id: 'legacy-codex-thread',
          threadId,
          title,
          project: storage.getItem('synabun-codex-panel-project') || '',
        }],
        legacySingle: true,
      });
    }
  }

  return payloads;
}

// Storage keys are insertion-ordered in the cache (server hydrates in JSON
// order, panels then setItem on top). The most recently written matching key
// is therefore last — iterate in reverse to find the freshest payload that
// actually has meaningful tabs.
function pickMostRecentMeaningfulPayload(provider, currentKey) {
  const meta = PROVIDERS[provider];
  if (!meta) return null;
  const prefix = `${meta.tabsKeyPrefix}-`;
  const predicate = statePredicate(provider);
  const keys = storage.keys();
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    if (k === currentKey) continue;
    if (!k.startsWith(prefix)) continue;
    const payload = readPayload(k);
    if (payload && payload.tabs.some(predicate)) return payload;
  }
  return null;
}

function statePredicate(provider) {
  if (provider === 'claude') return hasClaudeState;
  if (provider === 'codex') return hasCodexState;
  return hasOpenCodeState;
}

function dedupeKeyForTab(provider, tab) {
  if (provider === 'claude') return tab.sessionId ? `cp:${tab.sessionId}` : null;
  if (provider === 'codex') return tab.threadId ? `cxp:${tab.threadId}` : null;
  return tab.sessionId ? `ocp:${tab.sessionId}` : null;
}

// Flatten every payload's tabs into one list of meaningful pills, deduped by
// session/thread id so the same session in multiple windowIds renders once.
function meaningfulPills(provider) {
  const predicate = statePredicate(provider);
  const seen = new Set();
  const pills = [];
  for (const payload of providerPayloads(provider)) {
    payload.tabs.forEach((tab, index) => {
      if (!predicate(tab)) return;
      const key = dedupeKeyForTab(provider, tab);
      if (key) {
        if (seen.has(key)) return;
        seen.add(key);
      }
      pills.push({ payload, tab, index });
    });
  }
  return pills;
}

function removePlaceholders(provider = '') {
  const selector = provider
    ? `.${PLACEHOLDER_CLASS}[data-sidepanel-provider="${provider}"]`
    : `.${PLACEHOLDER_CLASS}`;
  document.querySelectorAll(selector).forEach((node) => node.remove());
}

function writeProviderPayload(provider, payload, removeIndex) {
  if (!payload || removeIndex < 0) return;
  if (payload.legacySingle) {
    if (provider === 'claude') storage.removeItem('synabun-claude-panel-session');
    if (provider === 'codex') {
      storage.removeItem('synabun-codex-panel-thread');
      storage.removeItem('synabun-codex-panel-title');
    }
    return;
  }

  const tabs = payload.tabs.filter((_, index) => index !== removeIndex);
  if (!tabs.length) {
    storage.removeItem(payload.key);
    return;
  }
  const activeIdx = Math.min(
    Math.max((Number(payload.activeIdx) || 0) - (removeIndex < payload.activeIdx ? 1 : 0), 0),
    tabs.length - 1,
  );
  storage.setItem(payload.key, JSON.stringify({ activeIdx, tabs }));
}

// Pull the windowId out of a `synabun-{provider}-tabs-{windowId}` key so we
// can target the right orphan when force-killing on pill close.
function windowIdFromKey(meta, key) {
  if (!meta || !key) return '';
  const prefix = `${meta.tabsKeyPrefix}-`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : '';
}

// Force-kill the backend session associated with a tab. Best-effort — if the
// orphan grace already expired or the OpenCode SDK already cleaned up, the
// server returns ok with killed:false and we still drop the storage entry.
async function killBackendSession(provider, tab, sourceKey) {
  const meta = PROVIDERS[provider];
  if (!meta) return;
  const windowId = windowIdFromKey(meta, sourceKey);
  const sessionId = tab?.sessionId || tab?.id || null;
  const threadId = tab?.threadId || null;
  if (!sessionId && !threadId && !windowId) return;
  try {
    await fetch('/api/sidepanel/kill-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, windowId, sessionId, threadId }),
    });
  } catch {
    // Network/server unavailable — storage delete is the user-visible part.
  }
}

// Pulls the source-key tab data into the current windowId's key so that the
// panel's own restoreTabs() (which is window-scoped) finds it. Legacy
// single-session keys are skipped — only proper tab payloads migrate.
function migrateSourceToCurrentWindow(provider, sourceKey) {
  const meta = PROVIDERS[provider];
  if (!meta || !sourceKey) return;
  const currentKey = scopedTabsKey(meta);
  if (sourceKey === currentKey) return;
  if (!sourceKey.startsWith(`${meta.tabsKeyPrefix}-`)) return;

  const sourceData = parseJson(storage.getItem(sourceKey), null);
  if (!Array.isArray(sourceData?.tabs) || !sourceData.tabs.length) return;

  const predicate = statePredicate(provider);
  const sourceMeaningful = sourceData.tabs.filter(predicate);
  if (!sourceMeaningful.length) return;

  const currentData = parseJson(storage.getItem(currentKey), null);
  const currentTabs = Array.isArray(currentData?.tabs) ? currentData.tabs : [];
  const currentMeaningful = currentTabs.filter(predicate);

  let nextTabs;
  let nextActiveIdx;
  if (!currentMeaningful.length) {
    // Current window has no real sessions — adopt source wholesale.
    nextTabs = sourceData.tabs;
    nextActiveIdx = Number(sourceData.activeIdx) || 0;
  } else {
    // Append source's meaningful tabs onto current — dedupe by session/thread id.
    const seen = new Set();
    for (const t of currentTabs) {
      const k = dedupeKeyForTab(provider, t);
      if (k) seen.add(k);
    }
    const additions = sourceMeaningful.filter((t) => {
      const k = dedupeKeyForTab(provider, t);
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!additions.length) {
      storage.removeItem(sourceKey);
      return;
    }
    nextTabs = [...currentTabs, ...additions];
    nextActiveIdx = Number(currentData?.activeIdx) || 0;
  }

  storage.setItem(currentKey, JSON.stringify({ activeIdx: nextActiveIdx, tabs: nextTabs }));
  storage.removeItem(sourceKey);
}

async function openProvider(provider, tabIdValue, sourceKey) {
  migrateSourceToCurrentWindow(provider, sourceKey);
  if (provider === 'claude') {
    if (!isClaudePanelOpen()) await toggleClaudePanel();
  } else if (provider === 'codex') {
    if (!isCodexPanelOpen()) await toggleCodexPanel();
  } else if (provider === 'opencode') {
    if (!isOpencodePanelOpen()) await toggleOpencodePanel();
  }
  emit(PROVIDERS[provider]?.eventName, { tabId: tabIdValue });
}

function createPlaceholder(provider, payload, tab, index) {
  const tray = document.getElementById('term-minimized-tray');
  const meta = PROVIDERS[provider];
  if (!tray || !meta) return null;
  const providerMeta = getProviderMeta(meta.providerId);
  const id = tabId(provider, tab, index);
  const pill = document.createElement('div');
  pill.className = `term-minimized-pill ${meta.pillClass} ${PLACEHOLDER_CLASS}`;
  pill.dataset.sidepanelProvider = provider;
  pill.dataset.tabId = id;
  pill.innerHTML = `
    <span class="term-minimized-pill-icon" style="color:${providerMeta.color}">${providerMeta.icon}</span>
    <span class="term-minimized-pill-label">${esc(tabLabel(provider, tab))}</span>
    <button class="term-minimized-pill-close" data-tooltip="Close">&times;</button>
  `;
  pill.classList.toggle(`${meta.pillClass.replace('-session-pill', '')}-pill-running`, isRunning(tab));
  pill.dataset.sourceKey = payload.key || '';
  pill.addEventListener('click', () => openProvider(provider, id, payload.key));
  pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', (event) => {
    event.stopPropagation();
    killBackendSession(provider, tab, payload.key);
    writeProviderPayload(provider, payload, index);
    pill.remove();
    renderSidepanelTrayPlaceholders();
  });
  tray.appendChild(pill);
  return pill;
}

export function renderSidepanelTrayPlaceholders() {
  for (const provider of Object.keys(PROVIDERS)) {
    if (_loadedProviders.has(provider)) {
      removePlaceholders(provider);
      continue;
    }
    removePlaceholders(provider);
    for (const { payload, tab, index } of meaningfulPills(provider)) {
      createPlaceholder(provider, payload, tab, index);
    }
  }
}

export function markSidepanelTrayProviderLoaded(provider) {
  if (!PROVIDERS[provider]) return;
  _loadedProviders.add(provider);
  removePlaceholders(provider);
}

export function initSidepanelTrayPlaceholders() {
  if (_initialized) return;
  _initialized = true;
  window.addEventListener('sidepanel-tray:provider-loaded', (event) => {
    markSidepanelTrayProviderLoaded(event.detail?.provider);
  });
  window.addEventListener('sidepanel-tray:refresh', renderSidepanelTrayPlaceholders);
  renderSidepanelTrayPlaceholders();
}
