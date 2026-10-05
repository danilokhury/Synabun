import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch, refreshSwatches } from './sg-kit.js';
import { PALETTE_STEPS, scaleFromBase, contrastReport, wcagContrast, resolveColor, paletteFromImage } from './sg-color-client.js';
import { styleGuideDarkSemantic, styleGuideAssetUrl } from '../api.js';
import { field } from './sg-kit.js';
export function render(host, s) {
    const swatches = new Map(), contrasts = [];
    const palettes = el('div', 'sg-stack');
    for (const [key, p] of Object.entries(s.config.colors.palettes)) {
        const tile = el('div', 'sg-palette');
        tile.dataset.palette = key;
        let hueShift = 0, chroma = 1;
        const generate = base => { if (s.get(`colors.palettes.${key}.locked`))
            return; const steps = scaleFromBase(base, { hueShift, chroma }); if (steps)
            s.set(`colors.palettes.${key}.steps`, steps); };
        tile.append(row(el('h4', '', p.label), toggle(s, `colors.palettes.${key}.locked`, t('styleguide.locked')), button(t('styleguide.auto'), () => generate(s.get(`colors.palettes.${key}.base`)))));
        tile.append(grid(text(s, `colors.palettes.${key}.label`), text(s, `colors.palettes.${key}.usage`)), row(colorField(s, `colors.palettes.${key}.base`, t('styleguide.base'), generate), field(t('styleguide.hueShift'), 0, v => hueShift = v, { type: 'number', unit: '°', min: -180, max: 180 }), field(t('styleguide.chroma'), 1, v => chroma = v, { type: 'number', min: 0, max: 3, step: .05 })));
        const strip = el('div', 'sg-scale');
        for (const step of PALETTE_STEPS) {
            const field = colorField(s, `colors.palettes.${key}.steps.${step}`, step, undefined, { eyedropper: false });
            strip.append(field);
            swatches.set(`${key}.${step}`, field);
        }
        tile.append(strip);
        if (!['primary', 'secondary', 'accent', 'neutral'].includes(key))
            tile.append(button(t('styleguide.remove'), () => { const next = { ...s.config.colors.palettes }; delete next[key]; s.set('colors.palettes', next); renderAgain(); }));
        palettes.append(tile);
    }
    function renderAgain() { cleanup(); host.replaceChildren(); cleanup = render(host, s) || (() => { }); }
    const name = field(t('styleguide.paletteName'), '', () => { });
    const add = button(t('styleguide.addPalette'), () => { const key = name.querySelector('input').value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); if (!key || key in s.config.colors.palettes || ['__proto__', 'constructor', 'prototype', 'status', 'semantic', 'typography', 'spacing', 'radius', 'radiusroles', 'elevation', 'duration', 'easing', 'light', 'dark'].includes(key))
        return; if (Object.keys(s.config.colors.palettes).length >= 24)
        throw new Error(t('styleguide.limit')); s.set('colors.palettes', { ...s.config.colors.palettes, [key]: { label: key, usage: '', base: s.config.colors.palettes.primary.base, locked: false, steps: scaleFromBase(s.config.colors.palettes.primary.base) } }); renderAgain(); });
    const fromLogo = button(t('styleguide.paletteFromLogo'), async () => { const v = s.config.logo.variants.find(v => v.kind === 'primary') || s.config.logo.variants[0]; if (!v)
        throw new Error(t('styleguide.logoMissing')); const bases = await paletteFromImage(styleGuideAssetUrl(s.meta.assetsHash, v.file)); bases.forEach((base, i) => { const key = ['primary', 'secondary', 'accent', 'neutral'][i]; if (!s.config.colors.palettes[key].locked) {
        s.set(`colors.palettes.${key}.base`, base);
        s.set(`colors.palettes.${key}.steps`, scaleFromBase(base));
    } }); renderAgain(); });
    host.append(card('palettes', palettes, row(name, add, fromLogo)));
    const semantic = el('div', 'sg-table-wrap');
    semantic.tabIndex = 0;
    semantic.setAttribute('aria-label', label('semantic'));
    const table = el('table', 'sg-table');
    const head = el('tr');
    head.append(el('th', '', label('usage')), el('th', '', t('styleguide.light')), el('th', '', t('styleguide.dark')));
    table.append(head);
    const backgrounds = { text: 'background', textMuted: 'surface', link: 'background', onPrimary: 'primary', onSecondary: 'secondary', onAccent: 'accent' };
    for (const role of Object.keys(s.config.colors.semantic.light)) {
        const tr = el('tr');
        tr.append(el('th', '', label(role)));
        for (const theme of ['light', 'dark']) {
            const td = el('td');
            td.append(aliasPicker(s, `colors.semantic.${theme}.${role}`, `${label(role)} · ${t(`styleguide.${theme}`)}`, true));
            if (backgrounds[role]) {
                const badge = el('span', 'sg-contrast-badge');
                td.append(badge);
                contrasts.push({ node: badge, theme, fg: role, bg: backgrounds[role] });
            }
            tr.append(td);
        }
        table.append(tr);
    }
    semantic.append(table);
    host.append(card('semantic', el('p', 'sg-hint', t('styleguide.alias')), semantic, button(t('styleguide.deriveDark'), async () => { const data = await styleGuideDarkSemantic(s.config.colors.semantic.light); s.set('colors.semantic.dark', data.dark); renderAgain(); })));
    host.append(card('status', grid(...Object.keys(s.config.colors.status).map(k => colorField(s, `colors.status.${k}`, label(k))))));
    const gradients = el('div', 'sg-stack');
    for (const [i, g] of s.config.colors.gradients.entries())
    {
        const sample = el('span', 'sg-gradient-sample');
        sample.dataset.gradient = i;
        sample.setAttribute('aria-hidden', 'true');
        gradients.append(row(grid(text(s, `colors.gradients.${i}.name`), text(s, `colors.gradients.${i}.css`), text(s, `colors.gradients.${i}.usage`)), sample, button(t('styleguide.remove'), () => { s.set('colors.gradients', s.config.colors.gradients.filter((_, j) => j !== i)); renderAgain(); })));
    }
    host.append(card('gradients', gradients, button(t('styleguide.addGradient'), () => { if (s.config.colors.gradients.length >= 12)
        throw new Error(t('styleguide.limit')); s.set('colors.gradients', [...s.config.colors.gradients, { name: 'gradient-' + (s.config.colors.gradients.length + 1), css: 'linear-gradient(135deg, {primary.500}, {secondary.500})', usage: '' }]); renderAgain(); })), card('themes', select(s, 'colors.themes.default', ['light', 'dark']), themeSupport()));
    function themeSupport() {
        const box = el('fieldset', 'sg-inline-set');
        box.append(el('legend', 'sg-label', label('supports')));
        for (const theme of ['light', 'dark']) {
            const wrap = el('label', 'sg-toggle'), input = el('input');
            input.type = 'checkbox';
            input.checked = s.config.colors.themes.supports.includes(theme);
            input.addEventListener('change', () => { const next = ['light', 'dark'].filter(k => k === theme ? input.checked : s.config.colors.themes.supports.includes(k)); s.set('colors.themes.supports', next.length ? next : [s.config.colors.themes.default]); box.querySelectorAll('input').forEach((n, j) => { n.checked = s.config.colors.themes.supports.includes(['light', 'dark'][j]); }); });
            wrap.append(input, el('span', '', t(`styleguide.${theme}`)));
            box.append(wrap);
        }
        return box;
    }
    const matrix = el('section', 'sg-card');
    matrix.append(el('h3', '', t('styleguide.contrast')), el('p', 'sg-purpose', t('styleguide.contrastHelp')));
    for (const theme of ['light', 'dark']) {
        const wrap = el('div', 'sg-table-wrap');
        wrap.tabIndex = 0;
        wrap.setAttribute('aria-label', `${t('styleguide.contrast')} · ${t(`styleguide.${theme}`)}`);
        const tab = el('table', 'sg-table sg-contrast-matrix');
        tab.dataset.theme = theme;
        const header = el('tr');
        header.append(el('th', '', t(`styleguide.${theme}`)));
        const bgRoles = ['background', 'surface', 'surfaceRaised', 'primary', 'secondary', 'accent'];
        bgRoles.forEach(k => header.append(el('th', '', label(k))));
        tab.append(header);
        for (const fg of ['text', 'textMuted', 'link', 'onPrimary', 'onSecondary', 'onAccent']) {
            const tr = el('tr');
            tr.append(el('th', '', label(fg)));
            for (const bg of bgRoles) {
                const td = el('td');
                td.setAttribute('aria-label', `${label(fg)} / ${label(bg)}`);
                contrasts.push({ node: td, theme, fg, bg });
                tr.append(td);
            }
            tab.append(tr);
        }
        wrap.append(tab);
        matrix.append(wrap);
    }
    host.append(matrix);
    const update = () => {
        refreshSwatches(host, s);
        for (const n of host.querySelectorAll('[data-gradient]')) {
            const g = s.config.colors.gradients[n.dataset.gradient];
            n.style.background = g ? g.css.replace(/\{[A-Za-z0-9-]+\.[A-Za-z0-9-]+\}/g, ref => resolveColor(s.config, ref) || 'transparent') : 'none';
        }
        for (const [key, node] of swatches) {
            const [palette, step] = key.split('.'), hex = s.config.colors.palettes[palette]?.steps[step];
            if (hex) {
                node.querySelector('input[type=color]').value = hex.slice(0, 7);
                const input = node.querySelector('input[type=text]');
                if (document.activeElement !== input)
                    input.value = hex;
            }
        }
        for (const { node, theme, fg, bg } of contrasts) {
            const c = s.config, report = contrastReport(resolveColor(c, c.colors.semantic[theme][fg], theme), resolveColor(c, c.colors.semantic[theme][bg], theme));
            node.replaceChildren();
            if (!report) {
                node.textContent = t('styleguide.contrastUnavailable');
                continue;
            }
            const target = c.accessibility.level === 'AAA' ? Math.max(7, c.accessibility.minContrastText) : c.accessibility.level === 'AA' ? Math.max(4.5, c.accessibility.minContrastText) : c.accessibility.minContrastText;
            node.dataset.pass = String(wcagContrast(resolveColor(c, c.colors.semantic[theme][fg], theme), resolveColor(c, c.colors.semantic[theme][bg], theme)) >= target);
            node.append(el('div', 'sg-ratio', t('styleguide.ratio', report)), el('span', 'sg-chip', report.aa ? t('styleguide.aa') : t('styleguide.fail')));
            if (report.aaa)
                node.append(el('span', 'sg-chip', t('styleguide.aaa')));
        }
    };
    update();
    let cleanup = watch(s, update);
    return () => cleanup();
}
