// SynaBun — the five agent side panels (Claude Code, Codex, OpenCode, Antigravity, Maritaca), loaded on first use
// instead of at boot (lazy-module.js says how). Everything outside a panel reaches it through its facade:
// claude-panel-lazy.js, ui-codex-panel.js, ui-opencode-panel-v2.js, ui-antigravity-panel.js, ui-maritaca-panel.js.
// A detached session window (ui-sidepanel-session-entry.js) still imports the implementations by address.
//
// Module-level listeners kept working before the load (forwardEvents): the Claude panel's `claude-panel:show`
// (a notification's click-through) and OpenCode's `opencode-panel:show` / `request-show` / `request-new-session`.
// Codex, Antigravity and Maritaca register their show listeners when their panel is built, as before.
//
// Each panel is also a launch step (launch-prefetch.js: after the first paint, in idle time, one step at a time),
// so its module-level work (forking a duplicated window's tabs, pruning closed windows' keys) still runs in every
// session, as it did when the boot loaded it, and the first open does not wait for the download.

import { on, emit } from './state.js';
import { registerLaunchPrefetch } from './launch-prefetch.js';
import { createLazyModule, forwardEvents } from './lazy-module.js';

export const claudePanelModule = createLazyModule(() => import('./ui-claude-panel.js'), { name: 'Claude panel' });
export const codexPanelModule = createLazyModule(() => import('./cdx/cdx-panel.js'), { name: 'Codex panel' });
// cdx-panel.js imports cdx-tabs.js: one load brings both.
export const codexTabsModule = createLazyModule(() => codexPanelModule.load().then(() => import('./cdx/cdx-tabs.js')), { name: 'Codex tabs' });
export const opencodePanelModule = createLazyModule(() => import('./ocp-v2/ocp-v2-panel.js'), { name: 'OpenCode panel' });
export const antigravityPanelModule = createLazyModule(() => import('./agy/agy-panel.js'), { name: 'Antigravity panel' });
export const maritacaPanelModule = createLazyModule(() => import('./mtc/mtc-panel.js'), { name: 'Maritaca panel' });

const bus = { on, emit };
forwardEvents(claudePanelModule, ['claude-panel:show'], bus);
forwardEvents(opencodePanelModule, ['opencode-panel:show', 'opencode-panel:request-show', 'opencode-panel:request-new-session'], bus);

/** The launch steps, in the order the boot used to evaluate the panels (after Settings and the studios). */
export const SIDEPANEL_LAUNCH_STEPS = [
  ['sidepanel-module:claude', claudePanelModule],
  ['sidepanel-module:codex', codexPanelModule],
  ['sidepanel-module:opencode', opencodePanelModule],
  ['sidepanel-module:antigravity', antigravityPanelModule],
  ['sidepanel-module:maritaca', maritacaPanelModule],
];
SIDEPANEL_LAUNCH_STEPS.forEach(([name, lazy], index) => {
  registerLaunchPrefetch(name, () => lazy.load(), { order: 80 + index });
});
