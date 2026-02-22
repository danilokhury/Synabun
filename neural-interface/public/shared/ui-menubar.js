// ═══════════════════════════════════════════
// SynaBun Neural Interface — OS-Style Menubar
// Handles open/close, mutual exclusivity, hover-to-switch,
// keyboard nav, and wiring for View / Graph menus.
// ═══════════════════════════════════════════

import { state, emit, on } from './state.js';
import { getMenuItems } from './registry.js';
import { openHelp } from './ui-help.js';

const $ = (id) => document.getElementById(id);

let openMenu = null;   // currently open data-menu value, or null
let hoverMode = false;  // after first click, hovering over labels opens them

// ── Public API ──

export function initMenubar() {
  const menubar = document.querySelector('.menubar');
  if (!menubar) return;

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
  wireTerminalMenu();
  injectVariantMenuItems();
  populateLinkTypes();
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

  // Keyboard shortcut: C to toggle categories
  document.addEventListener('keydown', (e) => {
    if (e.key === 'c' || e.key === 'C') {
      const active = document.activeElement?.tagName;
      if (active === 'INPUT' || active === 'TEXTAREA') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      if (catItem) catItem.click();
    }
  });

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

  // Keyboard shortcut: K to open Skills Studio
  document.addEventListener('keydown', (e) => {
    if (e.key === 'k' || e.key === 'K') {
      const active = document.activeElement?.tagName;
      if (active === 'INPUT' || active === 'TEXTAREA') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      emit('skills:open');
    }
  });
}

// ── Terminal Menu ──

function wireTerminalMenu() {
  const items = {
    'menu-terminal-claude':  () => emit('terminal:open', { profile: 'claude-code' }),
    'menu-terminal-codex':   () => emit('terminal:open', { profile: 'codex' }),
    'menu-terminal-gemini':  () => emit('terminal:open', { profile: 'gemini' }),
    'menu-terminal-shell':   () => emit('terminal:open', { profile: 'shell' }),
    'menu-terminal-toggle':  () => emit('terminal:toggle'),
  };
  Object.entries(items).forEach(([id, handler]) => {
    const el = $(id);
    if (el) el.addEventListener('click', () => { closeAll(); handler(); });
  });

  // Keyboard shortcut: T to toggle terminal
  document.addEventListener('keydown', (e) => {
    if (e.key === 't' || e.key === 'T') {
      const active = document.activeElement?.tagName;
      if (active === 'INPUT' || active === 'TEXTAREA') return;
      // Don't trigger when typing in xterm.js
      if (document.activeElement?.closest('.term-viewport')) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      emit('terminal:toggle');
    }
  });

  // Ctrl+` shortcut (VS Code convention)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === '`') {
      e.preventDefault();
      emit('terminal:toggle');
    }
  });
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
