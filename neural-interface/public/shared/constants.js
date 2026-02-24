// ═══════════════════════════════════════════
// CONSTANTS — shared between 3D and 2D variants
// ═══════════════════════════════════════════

export const DEFAULT_COLOR = '#888888';

export const COLOR_PALETTE = [
  '#7BA3C4', '#8AAF7A', '#C4A84E', '#C08050', '#6BAABE',
  '#9A9A9A', '#6B8AC4', '#C47A8E', '#C4AA5E', '#A870B8',
  '#5EA898', '#C47A5E', '#7E6AAE', '#5EB0B8', '#B0B85E',
  '#B06A4E', '#6AB898', '#B090C0', '#C4A060', '#60A0B8',
  '#90B060', '#50A8B8', '#9080B0', '#C06868', '#A05050',
  '#60B8A8', '#6A80B8', '#C06080',
];

/** All storage key names used across both variants.
 *  Most keys are persisted to data/ui-state.json via shared/storage.js.
 *  Keys marked "sessionStorage" remain browser-only (ephemeral). */
export const KEYS = {
  BOOKMARKS:           'neural-bookmarks',
  CATEGORY_COLORS:     'neural-category-colors',
  CATEGORY_ORDER:      'neural-category-order',
  SELECTED_NODE:       'neural-selected-node',
  SELECTED_SWITCH:     'neural-selected-node-switch',   // sessionStorage — preserve selection across variant switch
  UI_SCALE:            'neural-ui-scale',
  GFX_CONFIG_3D:       'neural-gfx-config',
  GFX_CONFIG_2D:       'neural-gfx-config-2d',
  GFX_PRESET:          'neural-gfx-preset',
  LAYOUT_PRESETS_3D:   'neural-layout-presets',
  LAYOUT_PRESETS_2D:   'neural-user-presets-2d',
  PANEL_PREFIX:        'neural-panel-',
  NODE_POS_3D:         'synabun-node-positions',
  NODE_POS_2D:         'synabun-node-positions-2d',
  CAM_HUD_PINNED:      'neural-cam-hud-pinned',
  CAM_HUD_POS:         'neural-cam-hud-pos',
  LAYOUT_VERSION:      'synabun-layout-version',
  INTERFACE_CONFIG:    'neural-interface-config',
  EXPLORER_CAT_ORDER:  'neural-explorer-cat-order',
  EXPLORER_COLLAPSED:  'neural-explorer-collapsed',
  EXPLORER_SORT:       'neural-explorer-sort',
  EXPLORER_VISIBLE:    'neural-explorer-visible',
  EXPLORER_WIDTH:      'neural-explorer-width',
  TERMINAL_HEIGHT:     'neural-terminal-height',
  TERMINAL_OPEN:       'neural-terminal-open',
  TERMINAL_DETACHED:   'neural-terminal-detached',
  TERMINAL_FLOAT_POS:  'neural-terminal-float-pos',
  TERMINAL_SESSIONS:   'neural-terminal-active-sessions',
  OPEN_CARDS:          'neural-open-cards',
  WORKSPACES:          'neural-workspaces',
  ACTIVE_WORKSPACE:    'neural-active-workspace',  // sessionStorage
  GRID_SNAP:           'neural-grid-snap',
  CATEGORIES_VISIBLE:  'neural-categories-visible',
};

/** Default keybind mappings — action ID → combo string.
 *  Combo format: {Ctrl+}{Alt+}{Shift+}{Meta+}{key}
 *  key is KeyboardEvent.key (lowercase for printable chars). */
export const DEFAULT_KEYBINDS = {
  'toggle-categories':   'c',
  'open-skills':         'k',
  'toggle-terminal':     't',
  'toggle-terminal-alt': 'Ctrl+`',
  'focus-search':        '/',
  'toggle-help':         '?',
  'toggle-explorer':     'f',
  'toggle-focus-mode':   'v',
  'toggle-minimap':      'm',
  'open-keybinds':       null,
  'launch-claude':       '1',
  'launch-codex':        '2',
  'launch-gemini':       '3',
};

/** Display metadata for each rebindable action. */
export const KEYBIND_META = {
  'toggle-categories':   { label: 'Toggle Categories',     group: 'Navigation' },
  'open-skills':         { label: 'Open Skills Studio',    group: 'Navigation' },
  'toggle-terminal':     { label: 'Toggle Terminal',       group: 'Navigation' },
  'toggle-terminal-alt': { label: 'Toggle Terminal (alt)', group: 'Navigation' },
  'focus-search':        { label: 'Focus Search',          group: 'Navigation' },
  'toggle-help':         { label: 'Toggle Help',           group: 'Navigation' },
  'toggle-explorer':     { label: 'Toggle Explorer',       group: 'Navigation' },
  'toggle-focus-mode':   { label: 'Toggle Focus Mode',     group: 'Navigation' },
  'toggle-minimap':      { label: 'Toggle Minimap',        group: 'View' },
  'open-keybinds':       { label: 'Open Keybinds',         group: 'Settings' },
  'launch-claude':       { label: 'Claude Code',           group: 'Launch CLI', icon: 'claude' },
  'launch-codex':        { label: 'Codex CLI',             group: 'Launch CLI', icon: 'codex' },
  'launch-gemini':       { label: 'Gemini CLI',            group: 'Launch CLI', icon: 'gemini' },
};
