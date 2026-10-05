// SynaBun Style Guide v2 — entry point. Shared panel handlers own drag and resize.
import { on } from './state.js';
import { initI18n, isReady, t } from './i18n.js';
import { isGuest, hasPermission, showGuestToast } from './ui-sync.js';
import { createPanel } from './styleguide/sg-panel.js';
let current = null, opening = false;
export function initStyleGuide() { on('styleguide:open', options => openPanel(options)); }
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
        const backdrop = document.createElement('div');
        backdrop.className = 'studio-backdrop open';
        document.body.append(backdrop);
        current = createPanel({ projectPath: options?.projectPath, onClosed: () => { backdrop.remove(); current = null; } });
        document.body.append(current.panel);
        current.panel.style.left = Math.max(8, (window.innerWidth - Math.min(1180, window.innerWidth - 16)) / 2) + 'px';
        current.panel.style.top = Math.max(8, (window.innerHeight - Math.min(720, window.innerHeight - 32)) / 2) + 'px';
        await current.ready;
    }
    finally {
        opening = false;
    }
}
