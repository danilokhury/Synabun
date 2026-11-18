// SynaBun Style Guide v2 — entry point. Shared panel handlers own drag and resize.
import { on } from './state.js';
import { initI18n, isReady, t } from './i18n.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
import { centeredInFrame } from './app-frame.js';
import { registerLaunchPrefetch } from './launch-prefetch.js';
// The window (styleguide/, about twenty modules) loads when it is opened, or in idle time after the page is shown
// (a launch step), not before the first frame. Nothing in it runs at load: it only defines the window.
const loadPanel = () => import('./styleguide/sg-panel.js');
let current = null, opening = false;
export function initStyleGuide() {
    on('styleguide:open', options => openPanel(options));
    registerLaunchPrefetch('style-guide-module', () => loadPanel(), { order: 78 });
}
async function openPanel(options = {}) {
    if (opening)
        return;
    if (current) {
        current.panel.focus();
        return;
    }
    opening = true;
    try {
        if (!isReady())
            await initI18n();
        if (isGuest() && !hasPermission('styleGuide')) {
            showGuestToast(t('styleguide.permissionDenied'));
            return;
        }
        // Before the backdrop: the backdrop and the window still appear together.
        const { createPanel } = await loadPanel();
        const backdrop = document.createElement('div');
        backdrop.className = 'studio-backdrop open';
        document.body.append(backdrop);
        current = createPanel({ projectPath: options?.projectPath, onClosed: () => { backdrop.remove(); current = null; } });
        document.body.append(current.panel);
        // Centred in the app frame (its CSS size: 1180 × 720 at most, the window less 16 / 32px)
        const at = centeredInFrame(Math.min(1180, window.innerWidth - 16), Math.min(720, window.innerHeight - 32));
        current.panel.style.left = at.left + 'px';
        current.panel.style.top = at.top + 'px';
        await current.ready;
    }
    finally {
        opening = false;
    }
}
