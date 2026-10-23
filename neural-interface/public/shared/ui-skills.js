// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio
// ═══════════════════════════════════════════
//
// The window where every skill, agent and command the runtimes load is browsed, edited, versioned, published and
// reviewed: Skills Studio 2.0 (docs/skills-studio.md → Studio 2.0), in public/shared/skills/studio/ and loaded the
// first time it is opened. This file is what the 2D and 3D pages load: it answers the menu's events, warms the
// Library after the page painted, and passes on the changes other windows and agents make.

import { on } from './state.js';
import { isGuest, hasPermission } from './ui-sync.js';
import { registerLaunchPrefetch } from './launch-prefetch.js';

let _studio = null;
const studio = () => {
  if (!_studio) _studio = import('./skills/studio/sx-main.js').catch((err) => { _studio = null; throw err; });
  return _studio;
};

/** The file types the menu's "Import…" offers (sx-import.js BUNDLE_ACCEPT). */
const BUNDLE_ACCEPT = '.json,.skill.json,.command.json,.agent.json';

export function initSkillsStudio() {
  // Launch: the Library is read once the page has painted (launch-prefetch.js), so the first open paints at once.
  registerLaunchPrefetch('skills-library', prefetchSkillsLibrary, { order: 70 });
  on('skills:open', (detail) => { studio().then((m) => m.openStudio(detail && typeof detail === 'object' ? detail : {})).catch(failed); });
  on('skills:open-wizard', () => { studio().then((m) => m.openStudio({ place: 'create', create: 'blank' })).catch(failed); });
  // A file picker opens only in the click that asked for it: it is opened here, at once, and the Studio (loaded
  // while the file is chosen) imports what was picked.
  on('skills:import', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = BUNDLE_ACCEPT;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) studio().then((m) => m.openStudioWithImport(file)).catch(failed);
    });
    studio().catch(() => {});
    input.click();
  });
  on('sync:skills:changed', (msg) => { if (_studio) _studio.then((m) => m.onSkillsChanged(msg?.event || {})).catch(() => {}); });
}

/** Launch prefetch: the Library read once, so the first open paints at once (nothing is drawn here). */
export function prefetchSkillsLibrary() {
  if (isGuest() && !hasPermission('skills')) return Promise.resolve();
  return studio().then((m) => m.prefetchStudio()).catch(() => {});
}

function failed(err) {
  console.error('Skills Studio could not be loaded', err);
}
