// ═══════════════════════════════════════════
// SynaBun Neural Interface — CLI Tool Update Badges
// Checks /api/system/tool-versions and shows green badges
// on toolbar buttons + Apps menu items when updates exist.
// Clicking the button/menu item (not just the tiny badge)
// runs the update command in a shell tab when an update exists.
// ═══════════════════════════════════════════

import { emit } from './state.js';

const $ = (id) => document.getElementById(id);

const UPDATE_COMMANDS = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code@latest',
  'codex':       'npm install -g @openai/codex@latest',
  'gemini':      'npm install -g @google/gemini-cli@latest',
  'opencode':    'opencode upgrade',
};

const TOOL_ELEMENTS = {
  'claude-code': { toolbar: 'claude-update-badge',   menu: 'claude-menu-update-badge' },
  'codex':       { toolbar: 'codex-update-badge',    menu: 'codex-menu-update-badge' },
  'opencode':    { toolbar: 'opencode-update-badge', menu: 'opencode-menu-update-badge' },
  'gemini':      { toolbar: null,                    menu: 'gemini-menu-update-badge' },
};

// Parent elements whose clicks get intercepted when an update badge is visible
const PARENT_ELEMENTS = {
  'claude-code': { toolbar: 'topright-claude-panel-btn', menu: 'menu-terminal-claude' },
  'codex':       { toolbar: 'topright-codex-panel-btn',  menu: 'menu-terminal-codex' },
  'opencode':    { toolbar: 'topright-opencode-panel-btn', menu: 'menu-terminal-opencode' },
  'gemini':      { toolbar: null,                         menu: 'menu-terminal-gemini' },
};

function runUpdate(key, badge) {
  const cmd = UPDATE_COMMANDS[key];
  if (!cmd) return;
  emit('terminal:run-command', { command: cmd, label: `Update ${key}` });
  // Optimistically clear the badge and restore parent tooltip
  if (badge) {
    badge.textContent = '';
    const parents = PARENT_ELEMENTS[key];
    if (parents?.toolbar) {
      const btn = $(parents.toolbar);
      if (btn?.dataset.tooltipOriginal) btn.dataset.tooltip = btn.dataset.tooltipOriginal;
    }
  }
  // Poll for the new installed version after the install completes.
  // npm-global installs typically take 5–45s; opencode upgrade similar.
  // Re-check a few times, bail once the badge is cleared or retries run out.
  const delays = [20000, 45000, 90000];
  for (const ms of delays) {
    setTimeout(() => { forceCheckToolUpdates(); }, ms);
  }
}

function wireParentIntercept(parentId, badgeId, key) {
  const parent = $(parentId);
  const badge = $(badgeId);
  if (!parent || !badge) return;
  // Capture phase fires before normal click handlers — intercept when badge is visible
  parent.addEventListener('click', (e) => {
    if (badge.textContent) {
      e.stopPropagation();
      e.preventDefault();
      runUpdate(key, badge);
    }
  }, true);
}

function applyBadges(data) {
  if (!data.tools) return;

  for (const [key, ids] of Object.entries(TOOL_ELEMENTS)) {
    const info = data.tools[key];
    const has = info && info.updateAvailable;
    const tip = has ? `v${info.installed} → v${info.latest} — click to update` : '';
    const parents = PARENT_ELEMENTS[key];

    if (ids.toolbar) {
      const badge = $(ids.toolbar);
      if (badge) { badge.textContent = has ? '↑' : ''; badge.title = tip; }
      // Update parent button tooltip when update is available
      const parentBtn = parents?.toolbar && $(parents.toolbar);
      if (parentBtn) {
        if (!parentBtn.dataset.tooltipOriginal) parentBtn.dataset.tooltipOriginal = parentBtn.dataset.tooltip || '';
        parentBtn.dataset.tooltip = has ? `Update available: ${tip}` : parentBtn.dataset.tooltipOriginal;
      }
    }
    if (ids.menu) {
      const badge = $(ids.menu);
      if (badge) { badge.textContent = has ? '↑' : ''; badge.title = tip; }
    }
  }
}

let _wired = false;

export async function initToolUpdates() {
  try {
    const res = await fetch('/api/system/tool-versions');
    if (!res.ok) return;
    applyBadges(await res.json());

    if (!_wired) {
      _wired = true;
      for (const [key, ids] of Object.entries(TOOL_ELEMENTS)) {
        const parents = PARENT_ELEMENTS[key];
        // Wire parent button/menu item intercepts (capture phase)
        if (ids.toolbar && parents?.toolbar) wireParentIntercept(parents.toolbar, ids.toolbar, key);
        if (ids.menu && parents?.menu) wireParentIntercept(parents.menu, ids.menu, key);
      }
    }
  } catch { /* silent */ }
}

export async function forceCheckToolUpdates() {
  try {
    const res = await fetch('/api/system/tool-versions?force=1');
    if (!res.ok) return;
    applyBadges(await res.json());
  } catch { /* silent */ }
}
