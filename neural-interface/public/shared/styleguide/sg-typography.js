import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
import { fetchStyleGuideFonts } from '../api.js';
import { field } from './sg-kit.js';
const loaded = new Set();
export function loadGoogleFont(font) {
    if (!font || font.source !== 'google')
        return;
    const weights = [...new Set(font.weights)].sort((a, b) => a - b).filter(n => Number.isInteger(n) && n > 0 && n <= 1000);
    const key = font.family + ':' + weights.join(';');
    if (loaded.has(key))
        return;
    loaded.add(key);
    const link = el('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family)}:wght@${weights.join(';') || 400}&display=swap`;
    document.head.append(link);
}
export const FONT_PAIRINGS = [['Space Grotesk', 'Inter'], ['Manrope', 'DM Sans'], ['Playfair Display', 'Source Sans 3'], ['Poppins', 'Nunito'], ['IBM Plex Sans', 'IBM Plex Sans'], ['Montserrat', 'Open Sans'], ['Lora', 'Lato'], ['Outfit', 'Work Sans']];
export function generateTypeScale(base, ratio) {
    const b = Math.min(40, Math.max(8, Number(base) || 16)), r = Math.min(2, Math.max(1.05, Number(ratio) || 1.25)), at = p => Math.round(b * r ** p);
    return { caption: Math.round(b * .75), 'body-sm': Math.round(b * .875), body: b, 'body-lg': Math.round(b * 1.125), h4: at(1), h3: at(2), h2: at(3), h1: at(4), display: at(5) };
}
export async function render(host, s) {
    let disposed = false, searchSeq = 0, fontTimer = null;
    const specimens = [];
    const fonts = el('div', 'sg-grid');
    for (const key of ['heading', 'body', 'mono', 'display']) {
        const font = s.config.typography.fonts[key], tile = el('div', 'sg-font-card');
        tile.append(el('h4', '', label(key)));
        if (!font) {
            tile.append(button(t('styleguide.add'), () => { s.set(`typography.fonts.${key}`, structuredClone(s.config.typography.fonts.heading)); rerender(); }));
            fonts.append(tile);
            continue;
        }
        const list = el('datalist');
        list.id = `sg-font-list-${key}`;
        const family = text(s, `typography.fonts.${key}.family`, label('family'), { list: list.id }), input = family.querySelector('input');
        input.setAttribute('aria-label', `${label(key)} · ${t('styleguide.fontSearch')}`);
        input.addEventListener('input', async () => { const seq = ++searchSeq; try {
            const data = await fetchStyleGuideFonts(input.value);
            if (disposed || seq !== searchSeq)
                return;
            list.replaceChildren(...data.map(f => { const o = el('option'); o.value = f.family; return o; }));
        }
        catch (e) {
            if (!disposed)
                shellError(e);
        } });
        const specimen = el('p', 'sg-font-specimen', t('styleguide.specimen'));
        specimens.push({ node: specimen, key });
        tile.append(family, list, select(s, `typography.fonts.${key}.source`, [['google', t('styleguide.fontGoogle')], ['system', t('styleguide.fontSystem')], ['self-hosted', t('styleguide.fontSelf')], ['adobe', t('styleguide.fontAdobe')], ['other', t('styleguide.fontOther')]]), text(s, `typography.fonts.${key}.fallback`), listEditor(s, `typography.fonts.${key}.weights`, label('weights'), { numeric: true, chips: true, max: 10 }), text(s, `typography.fonts.${key}.features`), specimen);
        if (key === 'display')
            tile.append(button(t('styleguide.remove'), () => { s.set('typography.fonts.display', null); rerender(); }));
        fonts.append(tile);
    }
    const pairings = grid(...FONT_PAIRINGS.map(([heading, body]) => button(`${heading} / ${body}`, () => { s.set('typography.fonts.heading', { ...s.config.typography.fonts.heading, family: heading, source: 'google' }); s.set('typography.fonts.body', { ...s.config.typography.fonts.body, family: body, source: 'google' }); rerender(); })));
    const ratios = [['minor-second', 1.067], ['major-second', 1.125], ['minor-third', 1.2], ['major-third', 1.25], ['perfect-fourth', 1.333], ['perfect-fifth', 1.5], ['golden-ratio', 1.618]];
    const ratio = field(label('preset'), s.config.typography.scale.preset, v => { const found = ratios.find(([key]) => key === v); s.set('typography.scale', { ...s.config.typography.scale, preset: v, ratio: found[1] }); rerender(); }, { type: 'select', options: ratios.map(([id, n]) => [id, `${label(id)} · ${n}`]) });
    const styles = el('div', 'sg-table-wrap');
    styles.tabIndex = 0;
    styles.setAttribute('aria-label', label('style'));
    const table = el('table', 'sg-table sg-type-table'), head = el('tr');
    for (const k of ['id', 'font', 'size', 'mobileSize', 'weight', 'lineHeight', 'letterSpacing', 'transform', 'usage'])
        head.append(el('th', '', label(k)));
    table.append(head);
    for (const [id, style] of Object.entries(s.config.typography.styles)) {
        const tr = el('tr');
        tr.append(el('th', '', id));
        const fields = [select(s, `typography.styles.${id}.font`, Object.keys(s.config.typography.fonts).filter(k => s.config.typography.fonts[k])), ...['size', 'mobileSize', 'weight', 'lineHeight', 'letterSpacing'].map(k => number(s, `typography.styles.${id}.${k}`, k === 'letterSpacing' ? 'em' : k === 'size' || k === 'mobileSize' ? 'px' : '', { min: k === 'letterSpacing' ? -.5 : k === 'lineHeight' ? .5 : 1, max: k === 'weight' ? 1000 : k === 'letterSpacing' ? 2 : k === 'lineHeight' ? 4 : 400 })), select(s, `typography.styles.${id}.transform`, ['none', 'uppercase', 'lowercase', 'capitalize']), text(s, `typography.styles.${id}.usage`)];
        for (const field of fields) {
            const td = el('td');
            td.append(field);
            tr.append(td);
        }
        table.append(tr);
        const specimen = el('div', 'sg-style-specimen', t('styleguide.specimen')), sr = el('tr'), td = el('td');
        td.colSpan = 9;
        td.append(specimen, button(t('styleguide.remove'), () => { if (id === 'body')
            return; const next = { ...s.config.typography.styles }; delete next[id]; s.set('typography.styles', next); rerender(); }));
        sr.append(td);
        table.append(sr);
        specimens.push({ node: specimen, id });
    }
    styles.append(table);
    const styleName = field(t('styleguide.styleName'), '', () => { });
    const addStyle = button(t('styleguide.addStyle'), () => { const id = styleName.querySelector('input').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-'); if (!id || id in s.config.typography.styles || ['__proto__', 'constructor', 'prototype'].includes(id))
        return; if (Object.keys(s.config.typography.styles).length >= 40)
        throw new Error(t('styleguide.limit')); s.set('typography.styles', { ...s.config.typography.styles, [id]: { ...s.config.typography.styles.body, usage: '' } }); rerender(); });
    host.append(card('fonts', fonts, el('p', 'sg-hint', t('styleguide.googleHelp'))), card('pairings', pairings), card('typeScale', row(number(s, 'typography.scale.base', 'px', { min: 8, max: 40 }), number(s, 'typography.scale.ratio', '', { min: 1.05, max: 2 }), ratio, button(t('styleguide.generateScale'), () => { const sizes = generateTypeScale(s.config.typography.scale.base, s.config.typography.scale.ratio), next = structuredClone(s.config.typography.styles); for (const [id, size] of Object.entries(sizes))
        if (next[id]) {
            next[id].size = size;
            next[id].mobileSize = Math.min(next[id].mobileSize, size);
        } s.set('typography.styles', next); rerender(); }))), card('textStyles', styles, row(styleName, addStyle)), card('principles', listEditor(s, 'typography.principles')));
    const update = () => { clearTimeout(fontTimer); fontTimer = setTimeout(() => { if (!disposed)
        Object.values(s.config.typography.fonts).forEach(loadGoogleFont); }, 300); for (const { node, key, id } of specimens) {
        const style = id ? s.config.typography.styles[id] : null, font = s.config.typography.fonts[key || style?.font];
        if (!font)
            continue;
        node.style.fontFamily = `"${font.family.replace(/["\\]/g, '')}", ${font.fallback}`;
        if (style) {
            node.style.fontSize = Math.max(12, style.size) + 'px';
            node.style.fontWeight = style.weight;
            node.style.lineHeight = style.lineHeight;
            node.style.letterSpacing = style.letterSpacing + 'em';
            node.style.textTransform = style.transform;
        }
    } };
    function shellError(e) { const n = host.closest('.styleguide-panel')?.querySelector('.sg-error'); if (n) {
        n.hidden = false;
        n.textContent = e.message;
    } }
    let unwatch = watch(s, update);
    update();
    function rerender() { unwatch(); disposed = true; host.replaceChildren(); render(host, s).then(fn => unwatch = fn); }
    try {
        const data = await fetchStyleGuideFonts();
        if (!disposed)
            host.querySelectorAll('datalist').forEach(list => list.replaceChildren(...data.map(f => { const o = el('option'); o.value = f.family; return o; })));
    }
    catch (e) {
        shellError(e);
    }
    return () => { disposed = true; clearTimeout(fontTimer); unwatch?.(); };
}
