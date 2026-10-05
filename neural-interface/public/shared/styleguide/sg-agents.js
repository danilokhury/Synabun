import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
import { fetchStyleGuideSummary, setStyleGuidePointers, fetchStyleGuide } from '../api.js';
export async function render(host, s) {
    let disposed = false, seq = 0;
    const summary = el('pre', 'sg-code'), estimate = el('p', 'sg-hint');
    const refresh = async () => { await s.flush(); const at = ++seq, data = await fetchStyleGuideSummary(s.projectPath); if (disposed || at !== seq)
        return; summary.textContent = data.summary; estimate.textContent = t('styleguide.tokensEstimate', { count: data.tokensEstimate }); };
    const pointers = el('label', 'sg-toggle'), switcher = el('input');
    switcher.type = 'checkbox';
    switcher.checked = s.config.exports.projectPointers;
    pointers.append(switcher, el('span', '', t('styleguide.pointers')));
    switcher.addEventListener('change', async () => { const enabled = switcher.checked; switcher.disabled = true; try {
        await s.flush({ force: !s.meta.saved });
        await s.action(async (path) => { await setStyleGuidePointers(path, enabled); return fetchStyleGuide(path); });
    }
    catch (e) {
        switcher.checked = !enabled;
        const n = host.closest('.styleguide-panel')?.querySelector('.sg-error');
        if (n) {
            n.hidden = false;
            n.textContent = e.message;
        }
    }
    finally {
        switcher.disabled = false;
        if (switcher.isConnected && (!document.activeElement || document.activeElement === document.body))
            switcher.focus({ preventScroll: true });
    } });
    host.append(card('inject', grid(...Object.keys(s.config.agents.inject).map(key => toggle(s, `agents.inject.${key}`, label(key))))), card('instructions', textarea(s, 'agents.instructions'), toggle(s, 'agents.allowProposals')), card('summary', estimate, summary, button(t('styleguide.refresh'), refresh)), card('pointers', pointers, el('p', 'sg-hint', t('styleguide.pointersHelp')), el('pre', 'sg-code', t('styleguide.pointerBlock'))));
    // Reading the summary must not save an untouched default guide.
    const data = await fetchStyleGuideSummary(s.projectPath);
    if (!disposed) {
        summary.textContent = data.summary;
        estimate.textContent = t('styleguide.tokensEstimate', { count: data.tokensEstimate });
    }
    const unsubscribe = s.subscribe(type => { if (type === 'saved' && !disposed)
        fetchStyleGuideSummary(s.projectPath).then(data => { if (!disposed) {
            summary.textContent = data.summary;
            estimate.textContent = t('styleguide.tokensEstimate', { count: data.tokensEstimate });
        } }).catch(() => { }); });
    return () => { disposed = true; unsubscribe(); };
}
