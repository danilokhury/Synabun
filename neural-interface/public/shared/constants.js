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

/** All localStorage / sessionStorage key names used across both variants */
export const KEYS = {
  BOOKMARKS:         'neural-bookmarks',
  CATEGORY_COLORS:   'neural-category-colors',
  CATEGORY_ORDER:    'neural-category-order',
  SELECTED_NODE:     'neural-selected-node',
  SELECTED_SWITCH:   'neural-selected-node-switch',   // sessionStorage — preserve selection across variant switch
  UI_SCALE:          'neural-ui-scale',
  GFX_CONFIG_3D:     'neural-gfx-config',
  GFX_CONFIG_2D:     'neural-gfx-config-2d',
  GFX_PRESET:        'neural-gfx-preset',
  LAYOUT_PRESETS_3D: 'neural-layout-presets',
  LAYOUT_PRESETS_2D: 'neural-user-presets-2d',
  PANEL_PREFIX:      'neural-panel-',
  NODE_POS_3D:       'synabun-node-positions',
  NODE_POS_2D:       'synabun-node-positions-2d',
  CAM_HUD_PINNED:    'neural-cam-hud-pinned',
  CAM_HUD_POS:       'neural-cam-hud-pos',
  LAYOUT_VERSION:    'synabun-layout-version',
  INTERFACE_CONFIG:   'neural-interface-config',
  EXPLORER_CAT_ORDER: 'neural-explorer-cat-order',
  TERMINAL_HEIGHT:     'neural-terminal-height',
  TERMINAL_OPEN:       'neural-terminal-open',
  TERMINAL_DETACHED:   'neural-terminal-detached',
  TERMINAL_FLOAT_POS:  'neural-terminal-float-pos',
  OPEN_CARDS:          'neural-open-cards',
  WORKSPACES:          'neural-workspaces',
  ACTIVE_WORKSPACE:    'neural-active-workspace',  // sessionStorage
  GRID_SNAP:           'neural-grid-snap',
};
