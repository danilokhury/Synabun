// ═══════════════════════════════════════════
// SynaBun Neural Interface — OS-Style Menubar
// Handles open/close, mutual exclusivity, hover-to-switch,
// keyboard nav, and wiring for View / Graph menus.
// ═══════════════════════════════════════════

import { state, emit, on } from './state.js';
import { storage } from './storage.js';
import { KEYS } from './constants.js';
import { getMenuItems } from './registry.js';
import { openHelp } from './ui-help.js';
import { registerAction } from './ui-keybinds.js';
import { isGuest, hasPermission } from './ui-sync.js';
import { sendToPanel } from './ui-claude-panel.js';

const $ = (id) => document.getElementById(id);

let openMenu = null;   // currently open data-menu value, or null
let hoverMode = false;  // after first click, hovering over labels opens them

// ── Public API ──

export function initMenubar() {
  const menubar = document.querySelector('.menubar');
  if (!menubar) return;

  // ── Keep --navbar-height in sync with actual title bar height ──
  const titleBar = document.getElementById('title-bar');
  if (titleBar) {
    const updateNavbarHeight = () => {
      const h = titleBar.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--navbar-height', h + 'px');
    };
    updateNavbarHeight();
    new ResizeObserver(updateNavbarHeight).observe(titleBar);
  }

  const items = menubar.querySelectorAll('.menubar-item');

  // Click to open / close
  items.forEach(item => {
    const label = item.querySelector('.menubar-label');
    const menuId = item.dataset.menu;

    label.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu === menuId) {
        closeAll();
      } else {
        openMenuById(menuId);
        hoverMode = true;
      }
    });

    // Hover-to-switch when a menu is already open
    label.addEventListener('mouseenter', () => {
      if (hoverMode && openMenu && openMenu !== menuId) {
        openMenuById(menuId);
      }
    });
  });

  // Click outside closes menu
  document.addEventListener('click', (e) => {
    if (openMenu && !e.target.closest('.menubar-item')) {
      closeAll();
    }
  });

  // Escape closes menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) {
      closeAll();
      e.stopPropagation();
    }
  });

  // Keyboard navigation within open menu
  document.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    const dropdown = document.querySelector('.menubar-item.open .menubar-dropdown');
    if (!dropdown) return;

    const allItems = [...dropdown.querySelectorAll('.menu-item:not(.disabled)')];
    if (allItems.length === 0) return;

    const focused = dropdown.querySelector('.menu-item.focused');
    let idx = allItems.indexOf(focused);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (focused) focused.classList.remove('focused');
      idx = (idx + 1) % allItems.length;
      allItems[idx].classList.add('focused');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focused) focused.classList.remove('focused');
      idx = (idx - 1 + allItems.length) % allItems.length;
      allItems[idx].classList.add('focused');
    } else if (e.key === 'Enter' && focused) {
      e.preventDefault();
      focused.click();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const menuItems = [...document.querySelectorAll('.menubar-item')];
      const currentIdx = menuItems.findIndex(m => m.dataset.menu === openMenu);
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const nextIdx = (currentIdx + dir + menuItems.length) % menuItems.length;
      openMenuById(menuItems[nextIdx].dataset.menu);
    }
  });

  // Integrate with existing panel close system
  on('panel:close-all-dropdowns', () => closeAll());

  // Wire up menu item handlers
  wireViewMenu();
  wireGraphMenu();
  wireSkillsMenu();
  wireAutomationsMenu();
  wireTerminalMenu();
  injectVariantMenuItems();
  populateLinkTypes();

  // ── Guest permission visual feedback on menu items ──
  const MENU_PERM_MAP = {
    'menu-open-skills-studio': 'skills',
    'menu-skills-new': 'skills',
    'menu-skills-import': 'skills',
    'menu-open-automation-studio': 'automations',
    'menu-automations-new': 'automations',
    'menu-automations-import': 'automations',
    'menu-terminal-claude': 'terminal',
    'menu-terminal-codex': 'terminal',
    'menu-terminal-gemini': 'terminal',
    'menu-terminal-shell': 'terminal',
    'menu-terminal-browser': 'browser',
    'menu-terminal-youtube': 'browser',
    'menu-game-tictactoe': 'whiteboard',
  };
  function updateMenuPermVisuals() {
    const guest = isGuest();
    Object.entries(MENU_PERM_MAP).forEach(([id, perm]) => {
      const el = $(id);
      if (!el) return;
      const blocked = guest && !hasPermission(perm);
      el.style.opacity = blocked ? '0.35' : '';
      el.style.pointerEvents = blocked ? 'none' : '';
    });
  }
  on('session:info', updateMenuPermVisuals);
  on('permissions:changed', updateMenuPermVisuals);
}

export function closeMenubar() {
  closeAll();
}

// ── Internal ──

function openMenuById(menuId) {
  const menubar = document.querySelector('.menubar');
  if (!menubar) return;

  // Close all first
  menubar.querySelectorAll('.menubar-item').forEach(item => {
    item.classList.remove('open');
    // Clear keyboard focus
    const focused = item.querySelector('.menu-item.focused');
    if (focused) focused.classList.remove('focused');
  });

  const target = menubar.querySelector(`.menubar-item[data-menu="${menuId}"]`);
  if (target) {
    target.classList.add('open');
    openMenu = menuId;

    // Trigger content rendering for data-driven panels
    if (menuId === 'bookmarks') emit('bookmarks:render');
    if (menuId === 'layouts') emit('layouts:render');
    if (menuId === 'resume') emit('resume:render');
  }
}

function closeAll() {
  const menubar = document.querySelector('.menubar');
  if (!menubar) return;
  menubar.querySelectorAll('.menubar-item').forEach(item => {
    item.classList.remove('open');
    const focused = item.querySelector('.menu-item.focused');
    if (focused) focused.classList.remove('focused');
  });
  openMenu = null;
  hoverMode = false;
}

// ── View Menu ──

function wireViewMenu() {
  // Categories toggle
  const catItem = $('menu-toggle-categories');
  if (catItem) {
    // Sync initial state — sidebar starts visible
    catItem.classList.add('active');

    catItem.addEventListener('click', () => {
      const sidebar = $('category-sidebar');
      if (!sidebar) return;
      const visible = sidebar.style.display !== 'none';
      sidebar.style.display = visible ? 'none' : '';
      catItem.classList.toggle('active', !visible);
    });
  }

  // Sync when sidebar is closed via its own close button
  on('sidebar:closed', () => {
    const catItem = $('menu-toggle-categories');
    if (catItem) catItem.classList.remove('active');
  });

  // Keyboard shortcut: toggle categories (via central keybinds)
  registerAction('toggle-categories', () => { if (catItem) catItem.click(); });

  // Help
  const helpItem = $('menu-help');
  if (helpItem) {
    helpItem.addEventListener('click', () => {
      closeAll();
      openHelp();
    });
  }
}

// ── Graph Menu ──

function wireGraphMenu() {
  // Link mode radio group
  const linkRadios = document.querySelectorAll('.menu-radio[data-group="link-mode"]');
  linkRadios.forEach(item => {
    item.addEventListener('click', () => {
      const value = item.dataset.value;
      state.linkMode = value;
      // Update all radios in the group
      linkRadios.forEach(r => r.classList.toggle('active', r.dataset.value === value));
      emit('link-mode-changed', value);
      emit('graph:refresh');
    });
  });

  // Node limit radio group
  const limitRadios = document.querySelectorAll('.menu-radio[data-group="node-limit"]');
  if (limitRadios.length > 0) {
    // Restore saved selection on load
    const saved = storage.getItem(KEYS.NODE_LIMIT) || '0';
    limitRadios.forEach(r => r.classList.toggle('active', r.dataset.value === saved));

    limitRadios.forEach(item => {
      item.addEventListener('click', () => {
        const value = parseInt(item.dataset.value, 10) || 0;
        limitRadios.forEach(r => r.classList.toggle('active', r.dataset.value === item.dataset.value));
        emit('node-limit-changed', value);
      });
    });
  }

  // Reset Layout
  const resetItem = $('menu-reset-layout');
  if (resetItem) {
    resetItem.addEventListener('click', () => {
      closeAll();
      emit('layout:reset');
    });
  }
}

// ── Skills Menu ──

function wireSkillsMenu() {
  const openItem = $('menu-open-skills-studio');
  if (openItem) {
    openItem.addEventListener('click', () => {
      closeAll();
      emit('skills:open');
    });
  }
  const newItem = $('menu-skills-new');
  if (newItem) {
    newItem.addEventListener('click', () => {
      closeAll();
      emit('skills:open-wizard');
    });
  }
  const importItem = $('menu-skills-import');
  if (importItem) {
    importItem.addEventListener('click', () => {
      closeAll();
      emit('skills:import');
    });
  }

  // Keyboard shortcut: open Skills Studio (via central keybinds)
  registerAction('open-skills', () => emit('skills:open'));
}

// ── Automations Menu ──

function wireAutomationsMenu() {
  const openItem = $('menu-open-automation-studio');
  if (openItem) {
    openItem.addEventListener('click', () => {
      closeAll();
      emit('automations:open');
    });
  }
  const schedulesItem = $('menu-automations-schedules');
  if (schedulesItem) {
    schedulesItem.addEventListener('click', () => {
      closeAll();
      emit('automations:open-schedules');
    });
  }
  const newItem = $('menu-automations-new');
  if (newItem) {
    newItem.addEventListener('click', () => {
      closeAll();
      emit('automations:open-wizard');
    });
  }
  const importItem = $('menu-automations-import');
  if (importItem) {
    importItem.addEventListener('click', () => {
      closeAll();
      emit('automations:import');
    });
  }

  registerAction('open-automations', () => emit('automations:open'));
}

// ── Apps Menu (formerly Terminal) ──

function wireTerminalMenu() {
  const items = {
    'menu-terminal-claude':  () => emit('terminal:open', { profile: 'claude-code' }),
    'menu-terminal-codex':   () => emit('terminal:open', { profile: 'codex' }),
    'menu-terminal-gemini':  () => emit('terminal:open', { profile: 'gemini' }),
    'menu-terminal-shell':   () => emit('terminal:open', { profile: 'shell' }),
    'menu-terminal-browser': () => emit('browser:open'),
    'menu-terminal-youtube': () => emit('browser:open', { url: 'https://www.youtube.com' }),
    'menu-terminal-discord': () => emit('browser:open', { url: 'https://discord.com/app' }),
    'menu-terminal-x':       () => emit('browser:open', { url: 'https://x.com' }),
    'menu-terminal-whatsapp': () => emit('browser:open', { url: 'https://web.whatsapp.com' }),
    'menu-app-leonardo':     () => { emit('browser:open', { url: 'https://app.leonardo.ai' }); emit('leonardo:launch'); },
    'menu-command-runner':   () => emit('command-runner:open'),
    'menu-terminal-link':    () => emit('link:toggle'),
    'menu-terminal-toggle':  () => emit('terminal:toggle'),
    'menu-restart-server':   async () => {
      try {
        // Cache project path before server goes down
        try {
          const h = await fetch('/api/health');
          const hd = await h.json();
          if (hd.projectDir) localStorage.setItem('synabun-project-dir', hd.projectDir);
        } catch {}
        await fetch('/api/server/restart', { method: 'POST' });
        // Show brief message then attempt reconnect after delay
        document.title = 'Restarting...';
        setTimeout(() => location.reload(), 2000);
      } catch {}
    },
  };
  Object.entries(items).forEach(([id, handler]) => {
    const el = $(id);
    if (el) el.addEventListener('click', () => { closeAll(); handler(); });
  });

  // Leonardo.AI — open panel with /leonardo skill after browser launches
  on('leonardo:launch', () => {
    setTimeout(() => sendToPanel('/leonardo', { newTab: true, tabLabel: 'Leonardo.AI', autoSubmit: true }), 500);
  });

  // Keyboard shortcuts: toggle terminal (via central keybinds)
  registerAction('toggle-terminal', () => emit('terminal:toggle'));
  registerAction('toggle-terminal-alt', () => emit('terminal:toggle'));
}

// ── Variant menu items injection ──

function injectVariantMenuItems() {
  const slot = $('menu-variant-slot');
  const sep = $('menu-variant-sep');
  const items = getMenuItems();

  if (!slot || items.length === 0) {
    if (sep) sep.style.display = 'none';
    return;
  }

  items.forEach(spec => {
    const el = document.createElement('div');
    el.className = `menu-item${spec.type === 'toggle' ? ' menu-toggle' : ''}`;
    if (spec.id) el.id = spec.id;
    el.innerHTML = `
      <span class="menu-check">&#10003;</span>
      <span class="menu-text">${spec.label}</span>
      ${spec.shortcut ? `<span class="menu-shortcut">${spec.shortcut}</span>` : ''}
    `;
    slot.appendChild(el);
    if (spec.init) spec.init(el);
  });

  if (sep) sep.style.display = '';
}

// ── Dynamic link type population ──

function populateLinkTypes() {
  on('data-loaded', () => {
    const slot = $('menu-link-types-slot');
    if (!slot) return;
    slot.innerHTML = '';

    // Gather unique link types (links may have .type or .types array)
    const types = new Set();
    state.allLinks.forEach(l => {
      if (l.types && Array.isArray(l.types)) {
        l.types.forEach(t => types.add(t));
      } else if (l.type) {
        types.add(l.type);
      }
    });

    // "All Types" is already in the static HTML
    // Add discovered types below it
    const sortedTypes = [...types].sort();
    sortedTypes.forEach(type => {
      const item = document.createElement('div');
      item.className = 'menu-item menu-radio';
      item.dataset.group = 'link-type';
      item.dataset.value = type;
      item.innerHTML = `
        <span class="menu-check">&#10003;</span>
        <span class="menu-text">${type}</span>
      `;
      item.addEventListener('click', () => {
        state.linkTypeFilter = type;
        syncLinkTypeRadios();
        emit('link-type-changed', type);
        emit('graph:refresh');
      });
      slot.appendChild(item);
    });

    // Wire the static "All Types" radio too
    const allTypesItem = document.querySelector('.menu-radio[data-group="link-type"][data-value="all"]');
    if (allTypesItem) {
      allTypesItem.addEventListener('click', () => {
        state.linkTypeFilter = 'all';
        syncLinkTypeRadios();
        emit('link-type-changed', 'all');
        emit('graph:refresh');
      });
    }
  });
}

function syncLinkTypeRadios() {
  document.querySelectorAll('.menu-radio[data-group="link-type"]').forEach(r => {
    r.classList.toggle('active', r.dataset.value === state.linkTypeFilter);
  });
}
