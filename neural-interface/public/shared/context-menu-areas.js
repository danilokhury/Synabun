// ═══════════════════════════════════════════
// SynaBun Neural Interface — The app's context menu: the areas registry
// What a part of the app adds to the app's right-click menu for an element
// in it (a memory, the memory map, the focus-mode whiteboard). No imports,
// so a module as low as the whiteboard can register its area without
// pulling in the menu's actions; ui-context-menu.js reads it at every open.
// ═══════════════════════════════════════════

const _areas = [];

/**
 * Add what a part of the app contributes to the menu. `match(element)` returns the area the element is in
 * (`{ kind: 'memory' | 'map' | 'focus', …, act? }`, see context-menu-model.js) or null. The first area that
 * matches wins, in the order they were registered. Returns a function that removes it again.
 * @param {{ id?: string, match: (el: Element) => object | null }} area
 */
export function registerContextMenuArea(area) {
  _areas.push(area);
  return () => { const i = _areas.indexOf(area); if (i >= 0) _areas.splice(i, 1); };
}

/** The area an element is in, or null. An area whose `match` throws is skipped (and named in the console). */
export function areaAt(el) {
  if (!el) return null;
  for (const area of _areas) {
    try {
      const found = area.match(el);
      if (found) return found;
    } catch (err) {
      console.warn(`[context-menu] area ${area.id || '?'} failed:`, err);
    }
  }
  return null;
}
