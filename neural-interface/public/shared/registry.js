// ═══════════════════════════════════════════
// REGISTRY — feature registry for variant capabilities
// ═══════════════════════════════════════════
//
// Each variant (3D / 2D) registers its identity, capabilities, and UI
// extensions on boot. Shared UI reads the registry to decide what to render.

const _registry = {
  variant: null,            // '3d' | '2d' | future variants
  capabilities: new Set(),  // e.g. 'camera-hud', 'minimap', 'hulls', 'lasso', 'controls-panel'
  navbarButtons: [],        // { zone, order, html, init }  (legacy, kept for compat)
  menuItems: [],            // { menu, order, type, id, label, shortcut?, init }
  helpSections: [],         // { order, html }
  settingsTabs: [],         // { id, label, icon, builder, afterRender }
  keyboardShortcuts: [],    // { key, description, handler }
};

// ── Registration API ──

/**
 * Register the active variant and its capabilities.
 * Called once at variant boot time.
 * @param {{ variant: string, capabilities?: string[] }} config
 */
export function registerVariant(config) {
  _registry.variant = config.variant;
  _registry.capabilities = new Set(config.capabilities || []);
}

/**
 * Register an extra button for the top navbar.
 * @param {{ zone: string, order: number, html: string, init: Function }} spec
 */
export function registerNavbarButton(spec) {
  _registry.navbarButtons.push(spec);
  _registry.navbarButtons.sort((a, b) => a.order - b.order);
}

/**
 * Register a menu item for the OS-style menubar.
 * @param {{ menu: string, order: number, type: string, id: string, label: string, shortcut?: string, init?: Function }} spec
 */
export function registerMenuItem(spec) {
  _registry.menuItems.push(spec);
  _registry.menuItems.sort((a, b) => a.order - b.order);
}

/**
 * Register an extra section for the help modal.
 * @param {{ order: number, html: string }} spec
 */
export function registerHelpSection(spec) {
  _registry.helpSections.push(spec);
  _registry.helpSections.sort((a, b) => a.order - b.order);
}

/**
 * Register an extra tab for the settings panel.
 * @param {{ id: string, label: string, icon: string, builder: Function, afterRender?: Function }} spec
 */
export function registerSettingsTab(spec) {
  _registry.settingsTabs.push(spec);
}

/**
 * Register a keyboard shortcut (for help display and central handler).
 * @param {{ key: string, description: string, handler: Function }} spec
 */
export function registerKeyboardShortcut(spec) {
  _registry.keyboardShortcuts.push(spec);
}

// ── Query API ──

export function getVariant() { return _registry.variant; }
export function hasCapability(name) { return _registry.capabilities.has(name); }
export function getNavbarButtons() { return _registry.navbarButtons; }
export function getMenuItems() { return _registry.menuItems; }
export function getHelpSections() { return _registry.helpSections; }
export function getSettingsTabs() { return _registry.settingsTabs; }
export function getKeyboardShortcuts() { return _registry.keyboardShortcuts; }
export function getRegistry() { return _registry; }
