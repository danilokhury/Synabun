// ═══════════════════════════════════════════
// SynaBun Neural Interface — The app's context menu: what is in it
// DOM-free. buildAppMenu(ctx, env) turns what was right-clicked into menu
// items. ui-context-menu.js supplies `env`: the strings (t), the keys as the
// central keybind registry has them now, what the page can do at this moment
// and the actions, which are the app's own functions (registered keybind
// actions, the event bus, the panels' buttons, the whiteboard's toolbar).
// Nothing here runs an action itself, so tests/context-menu-model.test.mjs
// can check every context.
// ═══════════════════════════════════════════

import { joinSections, quoteSelection } from './context-menu-logic.js';

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// The stroke icons of the menubar's dropdowns (same viewBox, stroke and caps).
export const ICONS = {
  back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  forward: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
  reload: svg('<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>'),
  exitFullscreen: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>'),
  send: svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>'),
  memory: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
  // The memory card's Linked (focus) button
  linked: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m-7.07-14.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83"/>'),
  hash: svg('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
  select: svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  // Apps › Map
  map: svg('<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>'),
  target: svg('<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>'),
  frame: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>'),
  sliders: svg('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>'),
  clear: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  // Apps › Browser apps
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  keyboard: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  page: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'),
  panel: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>'),
  terminal: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
  folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  list: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
  tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
  star: svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'),
  zap: svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  play: svg('<polygon points="6 3 20 12 6 21 6 3"/>'),
  bell: svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  // The focus-mode whiteboard's toolbar (html-shell.js #wb-toolbar)
  undo: svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  redo: svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  pointer: svg('<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>'),
  // The navbar's focus-mode button (#titlebar-viz-toggle)
  exitFocus: svg('<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>'),
};

/**
 * The whiteboard's tools, in the order of its toolbar (`data-tool` of #wb-toolbar). The whiteboard has no rebindable
 * keys for them; its own fixed keys (ui-whiteboard.js onKeyDown) are WHITEBOARD_KEYS.
 */
export const WHITEBOARD_TOOLS = ['select', 'text', 'list', 'arrow', 'shape', 'pen', 'section'];

/** The whiteboard's fixed keys, written as the keybind registry writes a key (Ctrl stands for Cmd on a Mac too). */
export const WHITEBOARD_KEYS = { multi: 'M', undo: 'Ctrl + Z', redo: 'Ctrl + Shift + Z', selectAll: 'Ctrl + A' };

/** The memory map's switches in Map options ›, per page: the 3D map's (Apps › Map) and the 2D graph's (View). */
export const MAP_OPTIONS = { '3d': ['neighbors', 'recency', 'grid'], '2d': ['minimap', 'regionGlow'] };
// A switch with a registered key shows it.
const MAP_OPTION_ACTIONS = { minimap: 'toggle-minimap' };

/**
 * The Open › submenu: the app's panels, windows and tools, each through the path its own button or key uses.
 * `action`: a registered keybind action (its key is shown); `press`: the button that opens it; `event`: the bus
 * event the menubar emits. `perm`: what a guest needs (the menubar's MENU_PERM_MAP). `active`: the element whose
 * `.active` says it is open now (a `!` in front: open while that element is NOT active). `appIcon`: the Apps
 * menu row whose icon it shows. `null` is a separator.
 */
export const OPEN_ENTRIES = [
  { id: 'open-assistant', key: 'assistant', action: 'launch-assistant', appIcon: 'menu-terminal-assistant', icon: 'panel' },
  { id: 'open-claude-panel', key: 'claudePanel', action: 'toggle-claude-panel', active: 'topright-claude-panel-btn', appIcon: 'menu-terminal-claude', icon: 'panel' },
  { id: 'open-codex-panel', key: 'codexPanel', press: 'topright-codex-panel-btn', active: 'topright-codex-panel-btn', appIcon: 'menu-terminal-codex', icon: 'panel' },
  { id: 'open-opencode-panel', key: 'opencodePanel', press: 'topright-opencode-panel-btn', active: 'topright-opencode-panel-btn', appIcon: 'menu-terminal-opencode', icon: 'panel' },
  null,
  { id: 'open-terminal', key: 'terminal', event: ['terminal:open', { profile: 'shell' }], perm: 'terminal', appIcon: 'menu-terminal-shell', icon: 'terminal' },
  { id: 'open-claude-terminal', key: 'claudeTerminal', action: 'launch-claude', perm: 'terminal', icon: 'terminal' },
  { id: 'open-browser', key: 'browser', action: 'launch-browser', perm: 'browser', appIcon: 'menu-terminal-browser', icon: 'page' },
  null,
  { id: 'open-file-explorer', key: 'fileExplorer', action: 'toggle-file-explorer', active: 'menu-toggle-file-explorer', icon: 'folder' },
  { id: 'open-memory-explorer', key: 'memoryExplorer', action: 'toggle-explorer', active: 'menu-toggle-explorer', icon: 'list' },
  { id: 'open-categories', key: 'categories', action: 'toggle-categories', active: 'menu-toggle-categories', icon: 'tag' },
  { id: 'open-focus-mode', key: 'focusMode', action: 'toggle-focus-mode', active: '!titlebar-viz-toggle', perm: 'whiteboard', icon: 'pen' },
  null,
  { id: 'open-skills', key: 'skills', action: 'open-skills', perm: 'skills', icon: 'star' },
  { id: 'open-automations', key: 'automations', action: 'open-automations', perm: 'automations', icon: 'zap' },
  { id: 'open-schedules', key: 'schedules', event: ['schedules:toggle'], active: 'menubar-schedules-btn', perm: 'automations', icon: 'clock' },
  { id: 'open-style-guide', key: 'styleGuide', event: ['styleguide:open'], perm: 'styleGuide', appIcon: 'menu-open-styleguide', icon: 'grid' },
  { id: 'open-command-runner', key: 'commandRunner', event: ['command-runner:open'], appIcon: 'menu-command-runner', icon: 'play' },
  { id: 'open-image-gallery', key: 'imageGallery', action: 'toggle-image-gallery', active: 'titlebar-gallery-btn', icon: 'image' },
  { id: 'open-notifications', key: 'notifications', action: 'toggle-session-monitor', active: 'titlebar-sessions-btn', icon: 'bell' },
  { id: 'open-help', key: 'help', action: 'toggle-help', icon: 'help' },
];

/**
 * @typedef {object} MenuEnv
 * @property {(key: string, params?: object) => string} t
 * @property {(actionId: string) => string} shortcut   the key as menus show it, '' while unbound
 * @property {(actionId: string) => boolean} hasAction  a registered keybind action
 * @property {(id: string) => boolean} hasElement       a button on this page
 * @property {(id: string) => boolean} isActive         that element has `.active`
 * @property {(perm: string) => boolean} allowed        false for a guest without that permission
 * @property {(id: string) => string} [appIcon]         the icon markup an Apps menu row shows, '' when none
 * @property {{ url: string, canGoBack: boolean, canGoForward: boolean, fullscreen: boolean, fullscreenEnabled: boolean }} page
 * @property {Record<string, Function>} act             the actions (see ui-context-menu.js)
 */

/**
 * What a right-click is on.
 * @typedef {object} MenuContext
 * @property {string} [selection]  the selected text it is over ('' or missing: none)
 * @property {string | null} [link] an http(s) link under it
 * @property {{ src: string, canOpen: boolean } | null} [image]
 * @property {{ kind: 'memory', memory: MemoryTarget, act?: object } | { kind: 'map', map: MapTarget, act?: object }
 *   | { kind: 'focus', focus: FocusTarget, act?: object } | null} [area]
 */

/**
 * @typedef {object} MemoryTarget
 * @property {string} id
 * @property {boolean} [card]     a memory card: it is open already, so Close card instead of Open
 * @property {boolean} [onMap]    a point on the memory map: it can join the multi-selection and fly to its island
 * @property {boolean} [selected] in the multi-selection now
 * @property {string} [island]    its category (the island it is on)
 */

/**
 * @typedef {object} MapTarget
 * @property {Record<string, boolean>} [options] the switches of MAP_OPTIONS[variant], as they are now
 * @property {boolean} [searching]  a search is dimming the map
 * @property {boolean} [selected]   a memory is selected on it (3D) or memories are in the multi-selection (2D)
 * @property {{ name: string, type: string } | null} [label] an island or continent name under the pointer
 * @property {'2d' | '3d'} [variant]
 */

/**
 * The focus-mode screen (the whiteboard), as it is now.
 * @typedef {object} FocusTarget
 * @property {string} [tool]        the whiteboard's active tool (WHITEBOARD_TOOLS)
 * @property {boolean} [multi]      multi-select mode is on
 * @property {boolean} [canUndo]
 * @property {boolean} [canRedo]
 * @property {boolean} [hasElements] something is on the board (Select all)
 * @property {boolean} [canEdit]    false for a guest without the whiteboard permission: only Select is left
 */

/** The top level stays short: about 12 rows at most (tests check every context against it). */
export const MAX_TOP_LEVEL = 12;

/**
 * The menu for a right-click.
 * @param {MenuContext} ctx
 * @param {MenuEnv} env
 */
export function buildAppMenu(ctx = {}, env) {
  const act = { ...env.act, ...(ctx.area?.act || {}) };
  const selection = ctx.selection || '';
  const targeted = !!(selection || ctx.link || ctx.image || ctx.area);
  const sections = [];
  if (!targeted) sections.push(pageNavigation(env, act), pageTools(env, act, { withCopy: true }));
  if (selection) sections.push(selectionItems(selection, env, act));
  if (ctx.link) sections.push(linkItems(ctx.link, env, act));
  if (ctx.image) sections.push(imageItems(ctx.image, env, act));
  if (ctx.area?.kind === 'memory') sections.push(memoryItems(ctx.area.memory, env, act));
  if (ctx.area?.kind === 'map') sections.push(mapItems(ctx.area.map, env, act));
  if (ctx.area?.kind === 'focus') sections.push(focusItems(ctx.area.focus, env, act));
  sections.push(appItems(env, act, { search: !selection }));
  if (targeted) sections.push([pageSubmenu(env, act)]);
  return joinSections(sections);
}

// ── Page ──

function pageNavigation({ t, page }, act) {
  return [
    { id: 'back', label: t('contextMenu.page.back'), icon: ICONS.back, disabled: !page.canGoBack, run: () => act.back() },
    { id: 'forward', label: t('contextMenu.page.forward'), icon: ICONS.forward, disabled: !page.canGoForward, run: () => act.forward() },
    { id: 'reload', label: t('contextMenu.page.reload'), icon: ICONS.reload, run: () => act.reload() },
  ];
}

function pageTools({ t, page }, act, { withCopy = false } = {}) {
  return [
    // Nothing is selected where the menu opened: Copy is there, and off.
    withCopy && { id: 'copy', label: t('contextMenu.selection.copy'), icon: ICONS.copy, disabled: true },
    { id: 'copy-url', label: t('contextMenu.page.copyUrl'), icon: ICONS.link, run: () => act.copyText(page.url) },
    {
      id: 'fullscreen',
      label: t(page.fullscreen ? 'contextMenu.page.exitFullscreen' : 'contextMenu.page.fullscreen'),
      icon: page.fullscreen ? ICONS.exitFullscreen : ICONS.fullscreen,
      disabled: !page.fullscreenEnabled,
      run: () => act.toggleFullscreen(),
    },
  ];
}

function pageSubmenu(env, act) {
  return {
    id: 'page',
    label: env.t('contextMenu.page.submenu'),
    icon: ICONS.page,
    submenu: [...pageNavigation(env, act), { separator: true }, ...pageTools(env, act)],
  };
}

// ── Selection, link, image ──

function selectionItems(text, { t }, act) {
  return [
    { id: 'copy', label: t('contextMenu.selection.copy'), icon: ICONS.copy, run: () => act.copyText(text) },
    { id: 'search-selection', label: t('contextMenu.selection.search', { text: quoteSelection(text) }), icon: ICONS.search, run: () => act.searchMemories(text) },
    { id: 'send-selection', label: t('contextMenu.selection.sendToAi'), icon: ICONS.send, run: () => act.sendText(text) },
  ];
}

function linkItems(href, { t }, act) {
  return [
    { id: 'open-link', label: t('contextMenu.link.open'), icon: ICONS.external, run: () => act.openInNewTab(href) },
    { id: 'copy-link', label: t('contextMenu.link.copy'), icon: ICONS.link, run: () => act.copyText(href) },
  ];
}

function imageItems(image, { t }, act) {
  return [
    { id: 'open-image', label: t('contextMenu.image.open'), icon: ICONS.image, disabled: !image.canOpen, run: () => act.openInNewTab(image.src) },
    { id: 'copy-image', label: t('contextMenu.image.copy'), icon: ICONS.copy, run: () => act.copyText(image.src) },
  ];
}

// ── A memory (a point on the map, an Explorer row, a memory card) ──

function memoryItems(memory, { t }, act) {
  const { id } = memory;
  return [
    !memory.card && { id: 'memory-open', label: t('contextMenu.memory.open'), icon: ICONS.memory, run: () => act.openMemory(id) },
    { id: 'memory-linked', label: t('contextMenu.memory.linked'), icon: ICONS.linked, run: () => act.showLinked(id) },
    { id: 'memory-copy-id', label: t('contextMenu.memory.copyId'), icon: ICONS.hash, run: () => act.copyText(id) },
    { id: 'memory-send', label: t('contextMenu.memory.sendToAi'), icon: ICONS.send, run: () => act.sendMemory(id) },
    memory.onMap && {
      id: 'memory-select',
      label: t(memory.selected ? 'contextMenu.memory.deselect' : 'contextMenu.memory.select'),
      icon: ICONS.select,
      run: () => act.toggleSelect(id),
    },
    memory.onMap && memory.island && {
      id: 'memory-island',
      label: t('contextMenu.memory.goToIsland', { name: memory.island }),
      icon: ICONS.target,
      run: () => act.flyToIsland(memory.island),
    },
    memory.card && { id: 'memory-close-card', label: t('contextMenu.memory.closeCard'), icon: ICONS.clear, run: () => act.closeCard(id) },
  ];
}

// ── The memory map's empty space or a name on it ──

function mapItems(map, { t, shortcut }, act) {
  const options = map.options || {};
  const variant = map.variant === '2d' ? '2d' : '3d';
  const toggle = (key) => ({
    id: `map-${key}`,
    label: t(`contextMenu.map.${key}`),
    checked: !!options[key],
    shortcut: MAP_OPTION_ACTIONS[key] ? shortcut(MAP_OPTION_ACTIONS[key]) : '',
    run: () => act.toggleOption(key),
  });
  return [
    map.label && { id: 'map-go-to', label: t('contextMenu.map.goTo', { name: map.label.name }), icon: ICONS.target, run: () => act.flyToLabel() },
    { id: 'map-frame-all', label: t('contextMenu.map.frameAll'), icon: ICONS.frame, shortcut: shortcut('map-frame-all'), run: () => act.frameAll() },
    { id: 'map-options', label: t('contextMenu.map.options'), icon: ICONS.sliders, submenu: MAP_OPTIONS[variant].map(toggle) },
    map.searching && { id: 'map-clear-search', label: t('contextMenu.map.clearSearch'), icon: ICONS.clear, run: () => act.clearSearch() },
    map.selected && { id: 'map-clear-selection', label: t('contextMenu.map.clearSelection'), icon: ICONS.clear, run: () => act.clearSelection() },
    {
      id: 'map-switch-view',
      label: t(variant === '2d' ? 'contextMenu.map.switchTo3d' : 'contextMenu.map.switchTo2d'),
      icon: ICONS.layers,
      run: () => act.switchView(),
    },
  ];
}

// ── The focus-mode screen: the whiteboard's own tools, and the way out ──

function focusItems(focus, { t, shortcut }, act) {
  const tool = focus.tool || 'select';
  const canEdit = focus.canEdit !== false;
  const tools = WHITEBOARD_TOOLS.map((key) => ({
    id: `focus-tool-${key}`,
    label: t(`contextMenu.focus.tools.${key}`),
    checked: !focus.multi && tool === key,
    disabled: !canEdit && key !== 'select',
    run: () => act.setTool(key),
  }));
  return [
    {
      id: 'focus-tool',
      label: t('contextMenu.focus.tool'),
      icon: ICONS.pointer,
      submenu: [
        ...tools,
        { separator: true },
        { id: 'focus-multi', label: t('contextMenu.focus.multiSelect'), checked: !!focus.multi, disabled: !canEdit, shortcut: WHITEBOARD_KEYS.multi, run: () => act.toggleMulti() },
      ],
    },
    { id: 'focus-undo', label: t('contextMenu.focus.undo'), icon: ICONS.undo, shortcut: WHITEBOARD_KEYS.undo, disabled: !canEdit || !focus.canUndo, run: () => act.undo() },
    { id: 'focus-redo', label: t('contextMenu.focus.redo'), icon: ICONS.redo, shortcut: WHITEBOARD_KEYS.redo, disabled: !canEdit || !focus.canRedo, run: () => act.redo() },
    { id: 'focus-select-all', label: t('contextMenu.focus.selectAll'), icon: ICONS.select, shortcut: WHITEBOARD_KEYS.selectAll, disabled: !focus.hasElements, run: () => act.selectAll() },
    { id: 'focus-exit', label: t('contextMenu.focus.exit'), icon: ICONS.exitFocus, shortcut: shortcut('toggle-focus-mode'), run: () => act.exitFocus() },
  ];
}

// ── The app ──

function openItems(env, act) {
  const { t, shortcut, hasAction, hasElement, isActive, allowed } = env;
  return OPEN_ENTRIES.map((entry) => {
    if (!entry) return { separator: true };
    const item = {
      id: entry.id,
      label: t(`contextMenu.open.${entry.key}`),
      icon: env.appIcon?.(entry.appIcon) || ICONS[entry.icon] || '',
      disabled: entry.perm ? !allowed(entry.perm) : false,
    };
    if (entry.action) {
      item.hidden = !hasAction(entry.action);
      item.shortcut = shortcut(entry.action);
      item.run = () => act.runAction(entry.action);
    } else if (entry.press) {
      item.hidden = !hasElement(entry.press);
      item.run = () => act.press(entry.press);
    } else {
      item.run = () => act.emit(...entry.event);
    }
    if (entry.active) {
      const negate = entry.active.startsWith('!');
      const id = negate ? entry.active.slice(1) : entry.active;
      if (hasElement(id)) item.checked = negate ? !isActive(id) : isActive(id);
    }
    return item;
  });
}

function appItems(env, act, { search = true } = {}) {
  const { t, shortcut, hasAction } = env;
  const registered = (id, actionId, key, icon) => ({
    id, label: t(key), icon, shortcut: shortcut(actionId), hidden: !hasAction(actionId), run: () => act.runAction(actionId),
  });
  return [
    { id: 'open', label: t('contextMenu.app.open'), icon: ICONS.grid, submenu: openItems(env, act) },
    search && registered('search', 'focus-search', 'contextMenu.app.search', ICONS.search),
    registered('shortcuts', 'open-keybinds', 'contextMenu.app.shortcuts', ICONS.keyboard),
    registered('settings', 'open-settings', 'contextMenu.app.settings', ICONS.settings),
  ];
}
