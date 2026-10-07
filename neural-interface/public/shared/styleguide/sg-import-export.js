import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
import { field, diffView } from './sg-kit.js';
import { importStyleGuide, fetchStyleGuidePresets, applyStyleGuidePreset, writeStyleGuideExports, fetchStyleGuideExport } from '../api.js';
export async function render(host, s) {
    let disposed = false, kind = 'design-md', merge = 'merge', content = '', slug = '', preview = null, seq = 0;
    const diff = el('div', 'sg-import-diff'), warnings = el('div', 'sg-hint'), written = el('div', 'sg-written');
    const apply = button(t('styleguide.apply'), async () => { if (!preview)
        return; const expected = preview; await s.apply(expected.config, `import:${expected.kind}`); preview = null; });
    apply.disabled = true;
    const invalidate = () => { seq++; preview = null; apply.disabled = true; diff.replaceChildren(); warnings.textContent = ''; };
    const format = field(t('styleguide.importKind'), kind, v => { kind = v; invalidate(); }, { type: 'select', options: [['design-md', 'DESIGN.md'], ['dtcg', 'tokens.json'], ['css', 'CSS'], ['tailwind-json', 'Tailwind JSON'], ['codebase', t('styleguide.scan')], ['community', t('styleguide.slug')]] });
    const strategy = field(t('styleguide.importMode'), merge, v => { merge = v; invalidate(); }, { type: 'select', options: ['merge', 'replace'] });
    const paste = field(t('styleguide.importText'), content, v => { content = v; invalidate(); }, { type: 'textarea' });
    const community = field(t('styleguide.slug'), slug, v => { slug = v; invalidate(); });
    const upload = field(t('styleguide.importFile'), '', () => { }, { type: 'file' });
    upload.querySelector('input').accept = '.md,.json,.css,text/plain,text/markdown,application/json,text/css';
    upload.querySelector('input').addEventListener('change', async (e) => { const file = e.target.files[0]; if (!file)
        return; content = await file.text(); kind = file.name.endsWith('.css') ? 'css' : file.name.endsWith('.json') ? 'dtcg' : 'design-md'; format.querySelector('select').value = kind; paste.querySelector('textarea').value = content; invalidate(); });
    const makePreview = async () => { await s.flush(); const at = ++seq; const data = await importStyleGuide(s.projectPath, { kind, text: content, slug, merge, mode: 'preview' }); if (disposed || at !== seq)
        return; preview = { ...data, kind }; diff.replaceChildren(diffView(data.diff)); warnings.replaceChildren(...(data.warnings || []).map(w => el('p', '', w))); apply.disabled = false; };
    const gallery = el('div', 'sg-grid');
    host.append(card('import', row(format, strategy), upload, paste, community, el('p', 'sg-hint', t('styleguide.attribution')), row(button(t('styleguide.scan'), () => { kind = 'codebase'; format.querySelector('select').value = kind; invalidate(); return makePreview(); }), button(t('styleguide.previewDiff'), makePreview), apply), warnings, diff));
    const presetCard = el('section', 'sg-card'), presetBody = el('div', 'sg-card-body');
    presetBody.append(gallery);
    presetCard.append(el('h3', '', t('styleguide.presets')), el('p', 'sg-purpose', t('styleguide.presetsHelp')), presetBody);
    host.append(presetCard);
    const exports = card('exports', grid(toggle(s, 'exports.designMd'), toggle(s, 'exports.tokensJson'), toggle(s, 'exports.cssVars'), select(s, 'exports.tailwind', ['v4', 'v3', 'none']), select(s, 'exports.darkMode', ['attribute', 'media', 'class']), text(s, 'exports.cssSelector'), text(s, 'exports.outDir')), button(t('styleguide.writeNow'), async () => { await s.flush({ force: !s.meta.saved }); const data = await s.action(path => writeStyleGuideExports(path)); drawWritten(data.written); }), written);
    host.append(exports);
    const copies = row();
    for (const [format, name] of [['design-md', 'DESIGN.md'], ['dtcg', 'tokens.json'], ['css', 'tokens.css'], ['tailwind-v4', 'Tailwind v4'], ['tailwind-v3', 'Tailwind v3'], ['summary', t('styleguide.summary')], ['json', 'JSON']])
        copies.append(button(`${t('styleguide.copy')} · ${name}`, async () => { await s.flush(); await navigator.clipboard.writeText(await fetchStyleGuideExport(s.projectPath, format)); }));
    exports.querySelector('.sg-card-body').append(copies);
    function drawWritten(files) { written.replaceChildren(el('h4', '', t('styleguide.written'))); if (!files?.length)
        written.append(el('p', 'sg-hint', t('styleguide.writeEmpty'))); for (const f of files || [])
        written.append(row(el('code', '', f.path), button(t('styleguide.copy'), () => navigator.clipboard.writeText(f.path)))); }
    drawWritten(s.meta.written);
    const presets = await fetchStyleGuidePresets();
    if (!disposed)
        for (const preset of presets) {
            const tile = el('div', 'sg-preset');
            const swatches = row(...preset.swatches.map(hex => { const n = el('span', 'sg-preset-swatch'); n.style.background = hex; n.title = hex; return n; }));
            tile.append(el('h4', '', preset.name), el('p', 'sg-purpose', preset.description), swatches, el('p', '', `${preset.fonts.heading} / ${preset.fonts.body}`), button(t('styleguide.apply'), () => s.action(path => applyStyleGuidePreset(path, preset.id, merge))));
            gallery.append(tile);
        }
    const unsubscribe = s.subscribe(type => { if (type === 'edit')
        invalidate(); });
    return () => { disposed = true; seq++; unsubscribe(); };
}
