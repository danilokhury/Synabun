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

function providerPayload(provider) {
  const meta = PROVIDERS[provider];
  if (!meta) return null;
  const key = scopedTabsKey(meta);
  const data = parseJson(storage.getItem(key), null);
  if (Array.isArray(data?.tabs) && data.tabs.length) {
    return { key, activeIdx: Number(data.activeIdx) || 0, tabs: data.tabs };
  }

  if (provider === 'claude') {
    const legacy = parseJson(storage.getItem('synabun-claude-panel-tabs'), null);
    if (Array.isArray(legacy?.tabs) && legacy.tabs.length) {
      return { key: 'synabun-claude-panel-tabs', activeIdx: Number(legacy.activeIdx) || 0, tabs: legacy.tabs };
    }
    const sessionId = storage.getItem('synabun-claude-panel-session');
    if (sessionId) {
      const label = storage.getItem(`synabun-session-label:${sessionId}`) || `${sessionId.slice(0, 8)}...`;
      return { key: 'synabun-claude-panel-session', activeIdx: 0, tabs: [{ sessionId, label }], legacySingle: true };
    }
  }

  if (provider === 'codex') {
    const threadId = storage.getItem('synabun-codex-panel-thread');
    const title = storage.getItem('synabun-codex-panel-title') || '';
    if (threadId || title) {
      return {
        key: 'synabun-codex-panel-thread',
        activeIdx: 0,
        tabs: [{
          id: 'legacy-codex-thread',
          threadId,
          title,
          project: storage.getItem('synabun-codex-panel-project') || '',
        }],
        legacySingle: true,
      };
    }
  }

  return null;
}

function meaningfulTabs(provider, payload) {
  const predicate = provider === 'claude'
    ? hasClaudeState
    : provider === 'codex'
      ? hasCodexState
      : hasOpenCodeState;
  return (payload?.tabs || [])
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => predicate(tab));
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

async function openProvider(provider, tabIdValue) {
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
  pill.addEventListener('click', () => openProvider(provider, id));
  pill.querySelector('.term-minimized-pill-close')?.addEventListener('click', (event) => {
    event.stopPropagation();
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
    const payload = providerPayload(provider);
    for (const { tab, index } of meaningfulTabs(provider, payload)) {
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
