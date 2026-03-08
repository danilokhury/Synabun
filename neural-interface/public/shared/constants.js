// ═══════════════════════════════════════════
// CONSTANTS — shared between 3D and 2D variants
// ═══════════════════════════════════════════

export const DEFAULT_COLOR = '#888888';

export const COLOR_PALETTE = [
  '#4FC3F7', '#66BB6A', '#FFC107', '#FF7043', '#29B6F6',
  '#BDBDBD', '#42A5F5', '#EF5350', '#FFCA28', '#AB47BC',
  '#26A69A', '#FF8A65', '#7E57C2', '#26C6DA', '#D4E157',
  '#FF7043', '#26A69A', '#CE93D8', '#FFB300', '#00ACC1',
  '#9CCC65', '#00BCD4', '#7986CB', '#EF5350', '#E53935',
  '#00BFA5', '#5C6BC0', '#EC407A',
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
  TERMINAL_SPLIT_RATIO: 'neural-terminal-split-ratio',
  TERMINAL_NOTIFICATIONS: 'neural-terminal-notifications',
  OPEN_CARDS:          'neural-open-cards',
  WORKSPACES:          'neural-workspaces',
  ACTIVE_WORKSPACE:    'neural-active-workspace',  // sessionStorage
  GRID_SNAP:           'neural-grid-snap',
  CATEGORIES_VISIBLE:  'neural-categories-visible',
  WHITEBOARD:          'neural-whiteboard',
  TUTORIAL_COMPLETED:  'neural-tutorial-completed',
  TUTORIAL_SKIPPED:    'neural-tutorial-skipped',
  TUTORIAL_STEP:       'neural-tutorial-step',
  TUTORIAL_STARTED:    'neural-tutorial-started',
  ONBOARDING_EXPLORE:  'neural-onboarding-explore',
  ONBOARDING_CLI:      'neural-onboarding-cli',
  ONBOARDING_MODEL:    'neural-onboarding-model',
  ONBOARDING_PROJECT:  'neural-onboarding-project',
  LINK_PANEL_POS:      'neural-link-panel-pos',
  LINK_PANEL_SIZE:     'neural-link-panel-size',
  ACTIVE_LINKS:        'neural-active-links',
  COMMAND_RUNNER:      'neural-command-runner',
  FILE_EXPLORER_VISIBLE:  'neural-file-explorer-visible',
  FILE_EXPLORER_WIDTH:    'neural-file-explorer-width',
  FILE_EXPLORER_COLLAPSED:'neural-file-explorer-collapsed',
  FILE_EXPLORER_SORT:     'neural-file-explorer-sort',
  FILE_EXPLORER_PROJECT:  'neural-file-explorer-project',
  ACTIVE_SKIN:            'neural-active-skin',
};

/** Default keybind mappings — action ID → combo string.
 *  Combo format: {Ctrl+}{Alt+}{Shift+}{Meta+}{key}
 *  key is KeyboardEvent.key (lowercase for printable chars). */
export const DEFAULT_KEYBINDS = {
  'toggle-categories':   'c',
  'open-skills':         'k',
  'open-automations':    'z',
  'toggle-terminal':     't',
  'toggle-terminal-alt': 'Ctrl+`',
  'focus-search':        '/',
  'toggle-help':         '?',
  'toggle-explorer':     'f',
  'toggle-focus-mode':   'v',
  'toggle-minimap':      'm',
  'open-keybinds':       'n',
  'launch-claude':       '1',
  'launch-codex':        '2',
  'launch-gemini':       '3',
  'launch-browser':      'b',
  'launch-youtube':      'y',
  'toggle-file-explorer': 'e',
  'open-settings':       's',
};

/** Display metadata for each rebindable action. */
export const KEYBIND_META = {
  'toggle-categories':   { label: 'Toggle Categories',     group: 'Navigation' },
  'open-skills':         { label: 'Open Skills Studio',    group: 'Navigation' },
  'open-automations':    { label: 'Open Automation Studio', group: 'Navigation' },
  'toggle-terminal':     { label: 'Toggle Terminal',       group: 'Navigation' },
  'toggle-terminal-alt': { label: 'Toggle Terminal (alt)', group: 'Navigation' },
  'focus-search':        { label: 'Focus Search',          group: 'Navigation' },
  'toggle-help':         { label: 'Toggle Help',           group: 'Navigation' },
  'toggle-explorer':     { label: 'Toggle Explorer',       group: 'Navigation' },
  'toggle-focus-mode':   { label: 'Toggle Focus Mode',     group: 'Navigation' },
  'toggle-minimap':      { label: 'Toggle Minimap',        group: 'View' },
  'open-settings':       { label: 'Open Settings',          group: 'Settings' },
  'open-keybinds':       { label: 'Open Keybinds',         group: 'Settings' },
  'launch-claude':       { label: 'Claude Code',           group: 'Launch App', icon: 'claude' },
  'launch-codex':        { label: 'Codex CLI',             group: 'Launch App', icon: 'codex' },
  'launch-gemini':       { label: 'Gemini CLI',            group: 'Launch App', icon: 'gemini' },
  'launch-browser':      { label: 'Browser',               group: 'Launch App', icon: 'browser' },
  'launch-youtube':      { label: 'YouTube',               group: 'Launch App', icon: 'youtube' },
  'toggle-file-explorer': { label: 'Toggle File Explorer', group: 'Navigation' },
};
