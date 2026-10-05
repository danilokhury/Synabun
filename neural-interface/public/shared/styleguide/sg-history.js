import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
import { field, diffView } from './sg-kit.js';
import { fetchStyleGuideHistory, restoreStyleGuideRevision, fetchStyleGuideProposals, acceptStyleGuideProposal, rejectStyleGuideProposal } from '../api.js';
export async function render(host, s, { proposals = false } = {}) {
    let disposed = false, status = 'pending', seq = 0;
    const revisions = el('div', 'sg-stack'), suggestions = el('div', 'sg-stack');
    const refresh = async () => {
        const at = ++seq;
        const history = await fetchStyleGuideHistory(s.projectPath);
        if (disposed || at !== seq)
            return;
        revisions.replaceChildren();
        if (!history.length)
            revisions.append(el('p', 'sg-hint', t('styleguide.historyEmpty')));
        for (const r of history)
            revisions.append(row(el('span', '', t('styleguide.revisionRow', { revision: r.revision, at: new Date(r.at).toLocaleString(), source: r.label || r.source })), button(t('styleguide.restore'), async () => { if (!window.confirm(t('styleguide.restoreConfirm', { revision: r.revision })))
                return; await s.action(path => restoreStyleGuideRevision(path, r.revision)); })));
        const list = await fetchStyleGuideProposals(s.projectPath, status === 'all' ? undefined : status);
        if (disposed || at !== seq)
            return;
        suggestions.replaceChildren();
        if (!list.length)
            suggestions.append(el('p', 'sg-hint', t('styleguide.proposalsEmpty')));
        for (const p of list) {
            const tile = el('article', 'sg-proposal');
            tile.dataset.proposal = p.id;
            tile.append(row(el('strong', '', p.reason), el('span', 'sg-chip', label(p.status))), el('p', 'sg-hint', [p.provider, p.model, p.runId, new Date(p.at).toLocaleString()].filter(Boolean).join(' · ')), diffView(p.diff));
            if (p.status === 'pending')
                tile.append(row(button(t('styleguide.accept'), () => s.action(path => acceptStyleGuideProposal(path, p.id))), button(t('styleguide.reject'), async () => { await s.action(path => rejectStyleGuideProposal(path, p.id)); await refresh(); })));
            suggestions.append(tile);
        }
    };
    const filter = field(label('status'), status, v => { status = v; refresh().catch(() => { }); }, { type: 'select', options: ['all', 'pending', 'accepted', 'rejected'] });
    const proposalCard = card('proposals', row(filter, button(t('styleguide.refresh'), refresh)), suggestions);
    proposalCard.id = 'sg-proposals-card';
    host.append(card('history', revisions), proposalCard);
    await refresh();
    if (proposals)
        proposalCard.scrollIntoView({ block: 'start' });
    return () => { disposed = true; seq++; };
}
