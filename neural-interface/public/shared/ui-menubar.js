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
import { armPwaInstallHandoff, initPwaInstall, installGuideUrl, isStandalone, requestPwaInstall } from './pwa-install.js';
import { registerAction } from './ui-keybinds.js';
import { isGuest, hasPermission } from './ui-sync.js';
import { forceCheckToolUpdates, showUpdateToast, TOOL_LABELS } from './ui-tool-updates.js';
import { forceCheckSynabunUpdate, openSynabunUpdateModal, synabunUpdateSourceLabel } from './ui-update.js';
import { requestServerRestart } from './ui-loading.js';
import { desktopBridge, isDesktopApp } from './desktop-bridge.js';
import { t } from './i18n.js';
import { frameRect } from './app-frame.js';

const $ = (id) => document.getElementById(id);

let openMenu = null;   // currently open data-menu value, or null
let hoverMode = false;  // after first click, hovering over labels opens them
const SUBMENUS = new Map(); // submenu row (.menu-submenu-parent) → its panel (.menubar-submenu)
let openSub = null;     // { parent, panel } of the submenu showing, or null
let subTimer = 0;       // a pending hover open, switch or close of a submenu
let subPending = null;  // the row that pending change is for

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

  // Escape closes an open submenu (back to its row), then the menu
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) {
      if (openSub) closeSubmenu({ focusParent: true });
      else closeAll();
      e.stopPropagation();
    }
  });

  // Keyboard navigation within open menu
  document.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    const dropdown = document.querySelector('.menubar-item.open .menubar-dropdown');
    if (!dropdown) return;
    // The keyboard is in an open submenu: its keys stay there.
    if (submenuKey(e)) return;

    const allItems = [...dropdown.querySelectorAll('.menu-item:not(.disabled):not([hidden])')];
    if (allItems.length === 0) return;

    const focused = dropdown.querySelector('.menu-item.focused');
    let idx = allItems.indexOf(focused);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (focused) focused.classList.remove('focused');
      idx = (idx + 1) % allItems.length;
      allItems[idx].classList.add('focused');
      allItems[idx].scrollIntoView({ block: 'nearest' });
      if (openSub && openSub.parent !== allItems[idx]) closeSubmenu();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (focused) focused.classList.remove('focused');
      idx = (idx - 1 + allItems.length) % allItems.length;
      allItems[idx].classList.add('focused');
      allItems[idx].scrollIntoView({ block: 'nearest' });
      if (openSub && openSub.parent !== allItems[idx]) closeSubmenu();
    } else if (SUBMENUS.has(focused) && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight')) {
      e.preventDefault();
      openSubmenu(focused, { focusFirst: true });
    } else if (e.key === 'ArrowRight' && !focused && openSub) {
      // Opened by hover: ArrowRight goes into it
      e.preventDefault();
      openSubmenu(openSub.parent, { focusFirst: true });
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
  wireSchedulesButton();
  wireTerminalMenu();
  injectVariantMenuItems();
  populateLinkTypes();
  wireSubmenus();

  // ── Guest permission visual feedback on menu items ──
  const MENU_PERM_MAP = {
    'menu-open-skills-studio': 'skills',
    'menu-skills-new': 'skills',
    'menu-skills-import': 'skills',
    'menu-open-styleguide': 'styleGuide',
    'menu-open-automation-studio': 'automations',
    'menubar-schedules-btn': 'automations',
    'menu-automations-new': 'automations',
    'menu-automations-import': 'automations',
    'menu-terminal-assistant': 'terminal',
    'menu-terminal-claude': 'terminal',
    'menu-terminal-codex': 'terminal',
    'menu-terminal-gemini': 'terminal',
    'menu-terminal-opencode': 'terminal',
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
  closeSubmenu();

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
    fitDropdown(target);
  }
}

// A menu taller than the room under the bar scrolls inside itself (Apps holds the Map and
// Games sections). Measured from the label, not the dropdown, which is still sliding in.
function fitDropdown(item) {
  const dropdown = item.querySelector(':scope > .menubar-dropdown');
  if (!dropdown || dropdown.classList.contains('menubar-dropdown--resume')) return;
  dropdown.style.maxHeight = '';
  dropdown.classList.remove('menubar-dropdown--scroll');
  const top = item.getBoundingClientRect().bottom + 14;
  const room = Math.floor(frameRect().bottom - top - 12); // down to the app frame's bottom edge
  if (room > 120 && dropdown.scrollHeight > room) {
    dropdown.style.maxHeight = room + 'px';
    dropdown.classList.add('menubar-dropdown--scroll');
  }
}

function closeAll() {
  const menubar = document.querySelector('.menubar');
  if (!menubar) return;
  closeSubmenu();
  menubar.querySelectorAll('.menubar-item').forEach(item => {
    item.classList.remove('open');
    const focused = item.querySelector('.menu-item.focused');
    if (focused) focused.classList.remove('focused');
  });
  openMenu = null;
  hoverMode = false;
}

// ── Submenus ──
// A dropdown row with data-submenu (Apps › Browser apps, Map, Games) opens the .menubar-submenu of
// that name beside the dropdown: on hover after a short intent delay, on click, and on Enter, Space
// or ArrowRight with its first entry focused. Hovering another row of the dropdown closes it after
// a grace delay, so the pointer can cross rows on its way in. One is open at a time.

const SUBMENU_OPEN_DELAY = 120;
const SUBMENU_GRACE = 300;
const SUBMENU_GAP = 2;       // between the dropdown and the panel
const VIEWPORT_MARGIN = 8;

function wireSubmenus() {
  document.querySelectorAll('.menubar-item').forEach(host => {
    const dropdown = host.querySelector(':scope > .menubar-dropdown');
    const rows = dropdown ? [...dropdown.querySelectorAll(':scope > .menu-submenu-parent')] : [];
    if (!rows.length) return;
    for (const row of rows) {
      const panel = dropdown.querySelector(`:scope > .menubar-submenu[data-submenu-for="${row.dataset.submenu}"]`);
      if (!panel) { row.hidden = true; continue; }
      // Out of the dropdown, whose scroll box (fitDropdown) would clip it.
      host.appendChild(panel);
      SUBMENUS.set(row, panel);
      row.addEventListener('click', () => openSubmenu(row));
      panel.addEventListener('mouseenter', cancelSubmenuTimer);
    }
    dropdown.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.menu-item');
      if (row && row.parentElement === dropdown) hoverRow(row);
    });
    dropdown.addEventListener('mouseleave', cancelSubmenuTimer);
    dropdown.addEventListener('scroll', () => { if (openSub) placeSubmenu(openSub.parent, openSub.panel); }, { passive: true });
    // The rows follow their entries ([hidden], display:none, a guest's blocked items), and the separators the rows.
    const sync = () => syncSubmenuRows(dropdown);
    new MutationObserver(sync).observe(host, { subtree: true, attributes: true, attributeFilter: ['hidden', 'style'] });
    sync();
  });
  window.addEventListener('resize', () => { if (openSub) placeSubmenu(openSub.parent, openSub.panel); });
}

function openSubmenu(row, { focusFirst = false } = {}) {
  cancelSubmenuTimer();
  const panel = SUBMENUS.get(row);
  if (!panel || row.hidden) return;
  if (openSub?.parent !== row) {
    closeSubmenu();
    openSub = { parent: row, panel };
    row.classList.add('submenu-open');
    row.setAttribute('aria-expanded', 'true');
    panel.classList.add('open');
    placeSubmenu(row, panel);
  }
  if (focusFirst) {
    panel.querySelectorAll('.menu-item.focused').forEach(el => el.classList.remove('focused'));
    submenuEntries(panel)[0]?.classList.add('focused');
  }
}

function closeSubmenu({ focusParent = false } = {}) {
  cancelSubmenuTimer();
  if (!openSub) return;
  const { parent, panel } = openSub;
  openSub = null;
  parent.classList.remove('submenu-open');
  parent.setAttribute('aria-expanded', 'false');
  panel.classList.remove('open');
  panel.querySelectorAll('.menu-item.focused').forEach(el => el.classList.remove('focused'));
  if (focusParent) {
    parent.parentElement.querySelectorAll(':scope > .menu-item.focused').forEach(el => el.classList.remove('focused'));
    parent.classList.add('focused');
  }
}

function hoverRow(row) {
  if (row === subPending) return; // still on the row the pending change is for: let it run
  const opens = SUBMENUS.has(row) && !row.hidden;
  if (openSub) {
    if (row === openSub.parent) { cancelSubmenuTimer(); return; }
    // The pointer may only be crossing this row on its way into the open submenu.
    scheduleSubmenu(row, () => (opens ? openSubmenu(row) : closeSubmenu()), SUBMENU_GRACE);
  } else if (opens) {
    scheduleSubmenu(row, () => openSubmenu(row), SUBMENU_OPEN_DELAY);
  } else {
    cancelSubmenuTimer();
  }
}

function scheduleSubmenu(row, fn, ms) {
  clearTimeout(subTimer);
  subPending = row;
  subTimer = setTimeout(() => { subTimer = 0; subPending = null; fn(); }, ms);
}

function cancelSubmenuTimer() {
  clearTimeout(subTimer);
  subTimer = 0;
  subPending = null;
}

// Keys for an open submenu the keyboard is in (one of its entries is focused). True when the key was its.
function submenuKey(e) {
  const focused = openSub?.panel.querySelector('.menu-item.focused');
  if (!focused) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const entries = submenuEntries(openSub.panel);
    focused.classList.remove('focused');
    if (!entries.length) return true;
    const idx = entries.indexOf(focused), dir = e.key === 'ArrowDown' ? 1 : -1;
    const next = idx < 0 ? (dir > 0 ? 0 : entries.length - 1) : (idx + dir + entries.length) % entries.length;
    entries[next].classList.add('focused');
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    focused.click();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    closeSubmenu({ focusParent: true });
  } else if (e.key === 'ArrowRight') {
    e.preventDefault(); // no level below this one, and the menubar stays on this menu
  } else {
    return false;
  }
  return true;
}

// The entries the keyboard reaches: not [hidden], disabled or display:none (a guest's Rebuild map).
function submenuEntries(panel) {
  return [...panel.querySelectorAll('.menu-item')]
    .filter(el => !el.hidden && !el.classList.contains('disabled') && getComputedStyle(el).display !== 'none');
}

// Right of the dropdown with its first entry level with the row; on the left when the app frame has no room
// on the right, and kept inside its right and bottom edges (the menu hangs from the bar, which is outside the
// frame, so its left stays the window's). The dropdown's laid-out place (offsetTop/Left) is what its
// drop-in animation does not move, so a submenu opened together with the menu (the tour) lines up too.
function placeSubmenu(row, panel) {
  const dropdown = row.parentElement, host = panel.parentElement;
  const hostBox = host.getBoundingClientRect(), panelBox = panel.getBoundingClientRect();
  const first = submenuEntries(panel)[0];
  const lead = first ? first.getBoundingClientRect().top - panelBox.top : 0;
  const top = dropdown.offsetTop + row.getBoundingClientRect().top - dropdown.getBoundingClientRect().top - lead;
  const f = frameRect();
  let left = dropdown.offsetLeft + dropdown.offsetWidth + SUBMENU_GAP;
  if (hostBox.left + left + panelBox.width > f.right - VIEWPORT_MARGIN) left = dropdown.offsetLeft - SUBMENU_GAP - panelBox.width;
  const maxTop = f.bottom - VIEWPORT_MARGIN - panelBox.height - hostBox.top;
  panel.style.left = `${Math.max(VIEWPORT_MARGIN - hostBox.left, left)}px`;
  panel.style.top = `${Math.max(VIEWPORT_MARGIN - hostBox.top, Math.min(top, maxTop))}px`;
}

// A row whose entries are all hidden or blocked for a guest is hidden. Then each separator shows only
// between two groups with something on screen, so none is doubled or left at an end.
function syncSubmenuRows(dropdown) {
  for (const row of dropdown.querySelectorAll(':scope > .menu-submenu-parent')) {
    const panel = SUBMENUS.get(row);
    const empty = !panel || !submenuEntries(panel).some(el => el.style.pointerEvents !== 'none');
    if (row.hidden !== empty) row.hidden = empty;
    if (empty && openSub?.parent === row) closeSubmenu();
  }
  const seps = new Map();
  let shown = false, waiting = null;
  for (const el of dropdown.children) {
    if (el.classList.contains('menu-sep')) {
      seps.set(el, false);
      if (shown) { waiting = el; shown = false; }
    } else if (el.matches('.menu-item, .menu-group-label') && getComputedStyle(el).display !== 'none') {
      if (waiting) { seps.set(waiting, true); waiting = null; }
      shown = true;
    }
  }
  for (const [sep, show] of seps) if (sep.hidden === show) sep.hidden = !show;
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

// ── Schedules (a menubar button: one click opens the window, the next closes it) ──

function wireSchedulesButton() {
  const btn = $('menubar-schedules-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    closeAll();
    emit('schedules:toggle');
  });
  // ui-schedules-studio.js reports the window opening and closing, whoever opened it.
  on('schedules:window', ({ open } = {}) => {
    btn.classList.toggle('active', !!open);
    btn.setAttribute('aria-expanded', String(!!open));
  });
}

// ── Apps Menu (formerly Terminal) ──

function wireTerminalMenu() {
  let disarmInstallHandoff = () => {};
  const items = {
    'menu-terminal-assistant': () => emit('assistant:open'),
    'menu-terminal-claude':  () => emit('terminal:open', { profile: 'claude-code' }),
    'menu-terminal-codex':   () => emit('terminal:open', { profile: 'codex' }),
    'menu-terminal-gemini':   () => emit('terminal:open', { profile: 'gemini' }),
    'menu-terminal-opencode': () => emit('terminal:open', { profile: 'opencode' }),
    'menu-check-cli-updates': async () => {
      const [tools, syn] = await Promise.all([
        forceCheckToolUpdates(),
        forceCheckSynabunUpdate(),
      ]);

      const updates = [];
      for (const [key, info] of Object.entries(tools?.tools || {})) {
        if (info?.updateAvailable) {
          const label = `${TOOL_LABELS[key] || key} v${info.installed} → v${info.latest}`;
          updates.push({ label });
        }
      }
      if (syn?.updateAvailable) {
        updates.push({ label: `SynaBun v${syn.current} → v${syn.latest}`, source: synabunUpdateSourceLabel(syn) });
      }

      const errors = [];
      if (!tools) errors.push('CLI versions');
      if (!syn)   errors.push('SynaBun version');

      showUpdateToast({
        updates,
        errors,
        onClick: syn?.updateAvailable ? () => openSynabunUpdateModal() : null,
      });
    },
    'menu-terminal-shell':   () => emit('terminal:open', { profile: 'shell' }),
    'menu-terminal-browser': () => emit('browser:open'),
    'menu-terminal-youtube': () => emit('browser:open', { url: 'https://www.youtube.com' }),
    'menu-terminal-discord': () => emit('browser:open', { url: 'https://discord.com/app' }),
    'menu-terminal-x':       () => emit('browser:open', { url: 'https://x.com' }),
    'menu-terminal-whatsapp': () => emit('browser:open', { url: 'https://web.whatsapp.com' }),
    'menu-open-styleguide':  () => emit('styleguide:open'),
    'menu-command-runner':   () => emit('command-runner:open'),
    'menu-terminal-link':    () => emit('link:toggle'),
    'menu-terminal-toggle':  () => emit('terminal:toggle'),
    'menu-install-app': async () => {
      disarmInstallHandoff(); // asked for here: this click opens the dialog, no later one does
      const result = await requestPwaInstall();
      if (result === 'instructions') location.assign(installGuideUrl());
    },
    // The restart screen is drawn in this click, before anything is asked of
    // the network; from there it follows the restart and loads the page again
    // when the server is back (ui-loading.js requestServerRestart).
    'menu-restart-server':   () => { requestServerRestart(); },
    'menu-stop-server':      async () => {
      // Inside the desktop app the server is the app's: stopping it is quitting SynaBun.
      const desktop = desktopBridge();
      if (desktop) { await desktop.quit(); return; }
      const previousTitle = document.title;
      try {
        document.title = 'Stopping...';
        const response = await fetch('/api/server/shutdown', { method: 'POST' });
        if (!response.ok) throw new Error(`Server stop failed (${response.status})`);
        document.title = 'SynaBun Stopped';
      } catch {
        document.title = previousTitle;
      }
    },
  };
  Object.entries(items).forEach(([id, handler]) => {
    const el = $(id);
    if (el) el.addEventListener('click', () => { closeAll(); handler(); });
  });

  // Keyboard shortcuts: toggle terminal (via central keybinds)
  registerAction('toggle-terminal', () => emit('terminal:toggle'));
  registerAction('toggle-terminal-alt', () => emit('terminal:toggle'));

  // The desktop app is SynaBun's own window: no browser installs it, and Stop Server is Quit SynaBun there.
  if (isDesktopApp()) {
    const quitLabel = [...($('menu-stop-server')?.querySelector('.menu-text')?.childNodes || [])].filter(node => node.nodeType === 3).pop();
    if (quitLabel) quitLabel.textContent = ` ${t('desktop.menu.quit')}`;
    return;
  }
  initPwaInstall({ changed: value => {
    const el = $('menu-install-app');
    if (el) el.style.display = value === 'installed' ? 'none' : '';
  } });
  const installItem = $('menu-install-app');
  if (installItem && !isStandalone()) installItem.style.display = '';
  // Sent on by the launcher's guide page: the browser's install dialog opens from the first click or key press,
  // for this one page load. The event it uses is spent, so the menu item goes to the guide page after that.
  disarmInstallHandoff = armPwaInstallHandoff({ leave: event => !!installItem?.contains(event.target) });

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
