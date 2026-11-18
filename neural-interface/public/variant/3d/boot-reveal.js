// SynaBun — when the 3D page shows itself, and what a map toggle does while the memory list is still being read
// (variant/3d/app.js boot). No imports, no DOM: tests/boot-reveal.test.mjs runs it under node.
//
// The page reads every memory before the views that need them are filled (sidebar counts, explorer, search, cards,
// the map's titles): 14 pages, 34 MB for 34,000 memories, 5 to 13 s. The overlay does not wait for that:
//  - map on: it hides once the map is drawn from /api/map, which needs no memory;
//  - Focus Mode (visualizationEnabled false): it hides once the whiteboard, Focus Mode's first view, has its saved
//    board. Focus Mode hides the stats bar, the category sidebar, the controls and the search, so nothing the user
//    sees there reads the memory list.
// The list still arrives whole, in one step, or not at all (shared/memory-list.js): no view is ever given a part of it.

/** The longest the overlay waits for the saved board in Focus Mode; a board that takes longer draws itself after. */
export const FOCUS_BOARD_WAIT_MS = 3000;

/**
 * Resolves when `promise` settles or after `ms`, whichever is first. Never rejects.
 * @param {Promise<unknown> | null | undefined} promise
 * @param {number} ms
 * @param {{ setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (id: unknown) => void }} [timers]
 * @returns {Promise<'settled' | 'timeout'>}
 */
export function settleWithin(promise, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (how) => {
      if (timer !== null) { clearTimer(timer); timer = null; }
      resolve(how);
    };
    timer = setTimer(() => { timer = null; resolve('timeout'); }, Math.max(0, ms));
    Promise.resolve(promise).then(() => finish('settled'), () => finish('settled'));
  });
}

/**
 * What the map does when the visualisation is switched on or off.
 *  - 'wait':  boot has not decided yet whether it draws the map; it reads the setting itself when it gets there;
 *  - 'start': the map was never made (the page booted in Focus Mode): make it and draw /api/map. Its titles and
 *             stats come from the memory list only once that is whole (`hydrate` waits for it);
 *  - 'apply': the map exists: render it or pause it.
 * @param {{ decided: boolean, enabled: boolean, hasMap: boolean }} state
 * @returns {'wait' | 'start' | 'apply'}
 */
export function mapToggleAction({ decided, enabled, hasMap }) {
  if (!decided) return 'wait';
  if (enabled && !hasMap) return 'start';
  return 'apply';
}
