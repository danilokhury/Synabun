// ═══════════════════════════════════════════
// SynaBun Neural Interface — The app's right-click menu
// A right-click anywhere that has no menu of its own opens the app's menu
// instead of the browser's: page actions, then what fits what was clicked
// (selected text, a link, an image, a memory, the memory map, the 2D graph,
// the focus-mode whiteboard), then the app's panels and tools. The
// ContextMenu key and Shift+F10 open it at the focused element.
//
// The rule: the app's menu opens unless the element under the pointer shows
// a menu of its own for that very click. Such an element takes the event
// (preventDefault) only when it opens its menu: the terminal's viewport, a
// File Explorer row or its empty tree, an editor tab, a 2D graph card, an
// Automation Studio item or folder, the map's canvas (OrbitControls takes
// every right-click there for right-drag pan; the map opens this menu itself
// when the right button comes up where it went down). An area that only
// suppressed the browser's menu would leave the user with nothing, so none
// does. NATIVE_CONTEXTMENU_SELECTORS names exact elements, never a whole
// screen or panel. Fields keep the browser's menu (spelling, paste), and so
// does any right-click with Shift held.
//
// The items are context-menu-model.js; the component is context-menu.js;
// the areas registry is context-menu-areas.js. Every action is a function the
// app already has: a registered keybind action, a bus event the menubar
// emits, a panel's button, sendToPanel, the memory card's functions.
// ═══════════════════════════════════════════

import { openContextMenu, isContextMenuOpen } from './context-menu.js';
import { isEditableTarget, isMenuKey, nativeMenuReason, selectionPayload, usableImage, usableLink } from './context-menu-logic.js';
import { buildAppMenu } from './context-menu-model.js';
import { areaAt, registerContextMenuArea } from './context-menu-areas.js';
import { t } from './i18n.js';
import { state, emit } from './state.js';
import { actionForKey, getShortcutLabel, hasAction, runAction } from './ui-keybinds.js';
import { isGuest, hasPermission } from './ui-sync.js';
import { sendToPanel } from './ui-claude-panel.js';
import { closeMemoryCard, focusLinkedMemories, getOpenCardsSnapshot } from './ui-detail.js';
import { formatMemoryForCLI } from './ui-terminal.js';
import { fetchMemory } from './api.js';

/**
 * Where the browser's menu stays: the exact elements with a menu of their own (also for a click their handler did
 * not take, such as Shift+F10 on them or a moment before they are wired), the other menus themselves, code editors,
 * and what is not SynaBun's page or sits above the menu. Never a whole screen or panel: the rest of a panel gets the
 * app's menu. Add `data-native-contextmenu` to an element to keep the browser's menu there.
 */
export const NATIVE_CONTEXTMENU_SELECTORS = [
  '[data-native-contextmenu]',
  '.term-viewport', '.xterm', '#term-context-menu',             // terminals (docked and floating) and their menu
  '#fe-tree', '.fe-ctx-flyout',                                 // the File Explorer's tree (rows and its empty space) and its menus
  '.cm-editor', '.fe-editor-menu',                              // a code editor anywhere; the editor's menus and palette
  '#context-menu',                                              // the 2D graph's card menu
  '.explorer-ctx-menu', '.as-context-menu',                     // the Explorer's and the Automation Studio's menus
  '.browser-canvas',                                            // the SynaBun browser's view of another site (Back / Reload here would act on SynaBun)
  '#loading-overlay',                                           // the loading / restart screen, above the menu
];
const OPT_OUT = NATIVE_CONTEXTMENU_SELECTORS.join(', ');
const SEARCH_MAX = 500;   // a search for the selection takes its first 500 characters
const KEY_ECHO_MS = 800;  // the contextmenu event a menu key sends after its keydown already opened the menu

let _installed = false;
let _keyboardOpenedAt = -Infinity;

// ═══════════════════════════════════════════
// AREAS (context-menu-areas.js; re-exported here for the pages that already import this module)
// ═══════════════════════════════════════════

export { registerContextMenuArea };

// A row of the memory Explorer.
const explorerArea = {
  id: 'memory-explorer',
  match(el) {
    const row = el?.closest?.('.explorer-memory[data-id]');
    return row ? { kind: 'memory', memory: { id: row.dataset.id } } : null;
  },
};

// A memory card (ui-detail.js names its element after the memory's first 8 characters).
const cardArea = {
  id: 'memory-card',
  match(el) {
    const card = el?.closest?.('.detail-card');
    if (!card?.id) return null;
    const open = getOpenCardsSnapshot().find((c) => card.id === `detail-card-${String(c.memoryId).slice(0, 8)}`);
    return open ? { kind: 'memory', memory: { id: open.memoryId, card: true } } : null;
  },
};

// ═══════════════════════════════════════════
// WHAT WAS CLICKED
// ═══════════════════════════════════════════

const elementOf = (node) => (node && node.nodeType !== 1 ? node.parentElement : node) || null;

// The selected text, when the right-click is on it (or the keyboard opened the menu while something is selected).
function selectionAt(el) {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const text = selectionPayload(sel.toString());
  if (!text) return '';
  if (!el || el === document.body || el === document.documentElement) return text;
  for (let i = 0; i < sel.rangeCount; i++) {
    try { if (sel.getRangeAt(i).intersectsNode(el)) return text; } catch { /* a node from another document */ }
  }
  return '';
}

function linkAt(el) {
  const a = el?.closest?.('a[href]');
  if (!a) return null;
  const raw = a.getAttribute('href');
  let resolved = null;
  try { resolved = new URL(raw, document.baseURI).href; } catch { /* not an address */ }
  return usableLink(raw, resolved);
}

function imageAt(el) {
  const img = el?.closest?.('img');
  return img ? usableImage(img.currentSrc || img.src) : null;
}

/** What the menu is about for an element (null: the page itself). */
export function contextAt(el) {
  return { selection: selectionAt(el), link: linkAt(el), image: imageAt(el), area: areaAt(el) };
}

// ═══════════════════════════════════════════
// WHAT THE MENU CAN DO (the app's own functions)
// ═══════════════════════════════════════════

async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); return true; }
  } catch { /* not allowed here (an address that is not secure): the fallback below */ }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* nothing more to try */ }
  area.remove();
  return ok;
}

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen?.();
  return document.documentElement.requestFullscreen?.();
}

// The search bar's own path: its input event shows "Searching…", waits its debounce and searches.
function searchMemories(text) {
  const query = selectionPayload(text, SEARCH_MAX);
  const input = document.getElementById('search-input');
  if (!input || !query) return;
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const findNode = (id) => state.allNodes?.find((n) => n.id === id) || null;

// A memory the page has (the slim graph copy is enough to open it), else the one the server has.
async function withMemory(id, fn) {
  const node = findNode(id);
  if (node) return fn(node);
  const full = await fetchMemory(id).catch(() => null);
  if (full?.payload) return fn({ id, payload: full.payload });
  return undefined;
}

// The AI panel gets the whole memory (the graph's copy of its content is cut at 500 characters).
async function sendMemory(id) {
  const full = await fetchMemory(id).catch(() => null);
  const node = full?.payload ? { id, payload: full.payload } : findNode(id);
  if (node) await sendToPanel(formatMemoryForCLI(node));
}

export const ACTIONS = {
  back: () => history.back(),
  forward: () => history.forward(),
  reload: () => location.reload(),
  copyText,
  toggleFullscreen,
  openInNewTab: (href) => { window.open(href, '_blank', 'noopener,noreferrer'); },
  searchMemories,
  sendText: (text) => sendToPanel(text),
  runAction: (actionId) => runAction(actionId),
  press: (id) => document.getElementById(id)?.click(),
  emit: (name, payload) => emit(name, payload),
  openMemory: (id) => withMemory(id, (node) => emit('node-selected', node)),
  showLinked: (id) => withMemory(id, (node) => { emit('node-selected', node); focusLinkedMemories(node.id); }),
  sendMemory,
  closeCard: (id) => closeMemoryCard(id),
};

function canGoBack() {
  const nav = window.navigation;
  return typeof nav?.canGoBack === 'boolean' ? nav.canGoBack : history.length > 1;
}

function canGoForward() {
  const nav = window.navigation;
  return typeof nav?.canGoForward === 'boolean' ? nav.canGoForward : true; // unknown without the Navigation API
}

/** The menu model's environment as the page is now (labels, keys and states are read at every open). */
export function menuEnv() {
  return {
    t,
    shortcut: (actionId) => getShortcutLabel(actionId),
    hasAction,
    hasElement: (id) => !!document.getElementById(id),
    isActive: (id) => !!document.getElementById(id)?.classList.contains('active'),
    allowed: (perm) => !isGuest() || hasPermission(perm),
    appIcon: (id) => (id && document.getElementById(id)?.querySelector('.menu-icon')?.innerHTML) || '',
    page: {
      url: location.href,
      canGoBack: canGoBack(),
      canGoForward: canGoForward(),
      fullscreen: !!document.fullscreenElement,
      fullscreenEnabled: document.fullscreenEnabled !== false && typeof document.documentElement.requestFullscreen === 'function',
    },
    act: ACTIONS,
  };
}

// ═══════════════════════════════════════════
// OPENING
// ═══════════════════════════════════════════

// One menu at a time: the menubar, the dropdowns that listen for it, and the menus that only close on a click.
function closeOtherMenus() {
  emit('panel:close-all-dropdowns');
  document.getElementById('term-context-menu')?.classList.remove('open');
  document.getElementById('context-menu')?.classList.remove('open');
  document.querySelectorAll('.as-context-menu, .explorer-ctx-menu').forEach((el) => el.remove());
}

function open(ctx, placement) {
  const items = buildAppMenu(ctx, menuEnv());
  closeOtherMenus();
  return openContextMenu({ items, label: t('contextMenu.label'), ...placement });
}

/**
 * Open the app's menu from an area that detects its own right-click (the memory map, where a right-drag pans):
 * what is at `target`, with `area` in place of what the registered areas would say.
 * @param {{ x?: number, y?: number, target?: Element | null, area?: object | null, keyboard?: boolean,
 *   anchorRect?: DOMRect | null, returnFocus?: Element | null }} o
 */
export function openAppContextMenu({ x, y, target = null, area = null, keyboard = false, anchorRect = null, returnFocus } = {}) {
  const el = elementOf(target);
  const ctx = contextAt(el);
  if (area) ctx.area = area;
  return open(ctx, { x, y, anchorRect, keyboard, returnFocus: returnFocus === undefined ? document.activeElement : returnFocus });
}

function onContextMenu(event) {
  // The menu key's own contextmenu event, after its keydown opened the menu.
  if (isContextMenuOpen() && performance.now() - _keyboardOpenedAt < KEY_ECHO_MS) { event.preventDefault(); return; }
  const el = elementOf(event.target);
  const reason = nativeMenuReason(event, {
    inOwnMenu: !!el?.closest?.('.app-ctx-menu'),
    editable: isEditableTarget(el),
    optedOut: !!el?.closest?.(OPT_OUT),
  });
  if (reason === 'own-menu') { event.preventDefault(); return; }
  if (reason) return;
  event.preventDefault();
  open(contextAt(el), { x: event.clientX, y: event.clientY, keyboard: false, returnFocus: document.activeElement });
}

function onKeyDown(event) {
  if (event.defaultPrevented || !isMenuKey(event) || isContextMenuOpen() || actionForKey(event)) return;
  const active = document.activeElement;
  const el = active && active !== document.body && active !== document.documentElement ? active : null;
  if (el && (isEditableTarget(el) || el.closest(OPT_OUT) || el.closest('.app-ctx-menu'))) return;
  event.preventDefault();
  _keyboardOpenedAt = performance.now();
  open(contextAt(el), { anchorRect: el?.getBoundingClientRect() || null, keyboard: true, returnFocus: el });
}

/** Install the app's right-click menu (once per page). */
export function initAppContextMenu() {
  if (_installed) return;
  _installed = true;
  registerContextMenuArea(explorerArea);
  registerContextMenuArea(cardArea);
  // Bubble phase at the window: every handler of the page has had the event first.
  window.addEventListener('contextmenu', onContextMenu);
  // A menu key the user bound to an action stays that action (actionForKey), whichever listener runs first.
  document.addEventListener('keydown', onKeyDown);
}
