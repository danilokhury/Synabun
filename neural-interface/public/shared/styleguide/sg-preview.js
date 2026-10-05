import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
import { esc, field } from './sg-kit.js';
import { fetchStyleGuideExport, fetchStyleGuidePreviewMd, styleGuideAssetUrl } from '../api.js';
import { resolveColor } from './sg-color-client.js';
// GET /export supplies the canonical stylesheet. A complete, escaped local override
// gives unsaved edits instant feedback; server tokens replace it on the next save.
export function previewTokens(c, theme) {
    const vars = {};
    const css = value => String(value).replace(/[<>{};]/g, '');
    for (const [key, p] of Object.entries(c.colors.palettes))
        for (const [step, hex] of Object.entries(p.steps))
            vars[`color-${key}-${step}`] = hex;
    for (const [key, hex] of Object.entries(c.colors.status))
        vars[`color-${key}`] = hex;
    for (const [role, ref] of Object.entries(c.colors.semantic[theme]))
        vars[`color-${role.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`] = resolveColor(c, ref, theme) || 'transparent';
    for (const [key, font] of Object.entries(c.typography.fonts))
        if (font)
            vars[`font-${key}`] = `"${font.family.replace(/["\\]/g, '')}", ${font.fallback}`;
    for (const [id, s] of Object.entries(c.typography.styles)) {
        vars[`text-${id}-font`] = `var(--font-${s.font})`;
        vars[`text-${id}-size`] = s.size / 16 + 'rem';
        vars[`text-${id}-size-mobile`] = s.mobileSize / 16 + 'rem';
        vars[`text-${id}-weight`] = s.weight;
        vars[`text-${id}-line-height`] = s.lineHeight;
        vars[`text-${id}-letter-spacing`] = s.letterSpacing + 'em';
    }
    for (const [key, n] of Object.entries(c.layout.spacing.scale))
        vars[`space-${key}`] = n / 16 + 'rem';
    for (const [key, n] of Object.entries(c.shape.radius))
        vars[`radius-${key}`] = n / 16 + 'rem';
    for (const [key, step] of Object.entries(c.shape.radiusRoles))
        if (!(key in c.shape.radius))
            vars[`radius-${key}`] = `var(--radius-${step})`;
    for (const [key, e] of Object.entries(c.shape.elevation))
        vars[`shadow-${key}`] = e.shadow;
    for (const [key, n] of Object.entries(c.shape.borders))
        vars[`border-${key}`] = n + 'px';
    for (const [key, n] of Object.entries(c.motion.durations))
        vars[`duration-${key}`] = n + 'ms';
    for (const [key, n] of Object.entries(c.motion.easings))
        vars[`ease-${key}`] = n;
    for (const [key, n] of Object.entries(c.layout.breakpoints))
        vars[`breakpoint-${key}`] = n + 'px';
    for (const [key, n] of Object.entries(c.layout.zIndex))
        vars[`z-${key}`] = n;
    vars['grid-columns'] = c.layout.grid.columns;
    vars['grid-gutter'] = c.layout.grid.gutter + 'px';
    vars['container-max'] = c.layout.container.maxWidth / 16 + 'rem';
    vars['container-padding'] = c.layout.container.padding / 16 + 'rem';
    for (const g of c.colors.gradients)
        vars[`gradient-${g.name}`] = g.css.replace(/\{([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)\}/g, ref => resolveColor(c, ref, theme) || 'transparent');
    return `:root{${Object.entries(vars).map(([key, value]) => `--${key}:${css(value)};`).join('')}color-scheme:${theme};}`;
}
function componentCss(c) {
    const resolve = value => String(value ?? '').replace(/\{([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)\}/g, (_, group, key) => {
        const prefix = { semantic: 'color', status: 'color', spacing: 'space', radius: 'radius', radiusRoles: 'radius', elevation: 'shadow', duration: 'duration', easing: 'ease' }[group];
        return prefix ? `var(--${prefix}-${key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()})` : group === 'typography' ? '' : `var(--color-${group}-${key})`;
    }).replace(/[<>{};]/g, '');
    const property = { background: 'background', text: 'color', radius: 'border-radius', padding: 'padding', shadow: 'box-shadow', border: 'border' };
    return c.components.map(spec => {
        const selector = `[data-component="${String(spec.id).replace(/[^a-z0-9-]/g, '')}"]`;
        let base = Object.entries(spec.tokens).filter(([key]) => property[key]).map(([key, value]) => `${property[key]}:${resolve(value)};`).join('');
        const typo = /^\{typography\.([a-z0-9-]+)\}$/.exec(spec.tokens.typography || '');
        if (typo)
            base += `font-family:var(--text-${typo[1]}-font);font-size:var(--text-${typo[1]}-size);font-weight:var(--text-${typo[1]}-weight);`;
        let states = '';
        for (const [state, raw] of Object.entries(spec.states)) {
            if (!['hover', 'active', 'focus', 'disabled'].includes(state))
                continue;
            const parsed = String(raw).split(/[,;]+/).map(part => /^\s*(background|color|opacity|border|box-shadow|transform)\s*:?\s+(.+)$/.exec(part)).filter(Boolean).map(m => `${m[1]}:${resolve(m[2])};`).join('');
            if (parsed)
                states += `${selector}[data-state="${state}"],${selector}:${state === 'disabled' ? 'disabled' : state}{${parsed}}`;
        }
        return `${selector}{${base}}${states}`;
    }).join('\n');
}
export function buildPreviewDocument(c, css, theme, assetsHash) {
    const tr = key => esc(t(`styleguide.${key}`));
    const variant = c.logo.variants.find(v => v.kind === 'primary') || c.logo.variants[0];
    const logo = variant ? `<img class="logo" alt="${esc(variant.name)}" src="${esc(styleGuideAssetUrl(assetsHash, variant.file))}">` : esc(c.brand.name || t('styleguide.title'));
    const buttons = () => ['primary', 'secondary', 'ghost', 'danger'].map(kind => `<button class="btn ${kind}" data-component="button-${kind}">${tr('button-' + kind)}</button>`).join('');
    const states = ['default', 'hover', 'active', 'focus', 'disabled'].map(state => `<div class="button-row"><span>${tr(state)}</span>${['primary', 'secondary', 'ghost', 'danger'].map(kind => `<button class="btn ${kind} ${state}" data-component="button-${kind}" data-state="${state}" ${state === 'disabled' ? 'disabled' : ''}>${tr('button-' + kind)}</button>`).join('')}</div>`).join('');
    const attr = c.exports.darkMode === 'class' ? `class="${theme}"` : `data-theme="${theme}"`;
    return `<!doctype html><html lang="${document.documentElement.lang || 'en'}" ${attr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
 <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'none'">
 ${Object.values(c.typography.fonts).filter(f => f?.source === 'google').map(f => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family)}:wght@${[...new Set(f.weights)].sort((a, b) => a - b).join(';')}&amp;display=swap">`).join('')}
 <style>${String(css).replace(/<\/style/gi, '&lt;/style')}
 ${previewTokens(c, theme)}
 *{box-sizing:border-box}body{margin:0;background:var(--color-background);color:var(--color-text);font-family:var(--font-body);font-size:max(12px,var(--text-body-size));line-height:var(--text-body-line-height)}
 nav,footer{padding:var(--space-xl);border-bottom:1px solid var(--color-border);display:flex;align-items:center;justify-content:space-between;gap:16px}.logo{max-width:160px;max-height:40px}main{max-width:var(--container-max);padding:var(--container-padding);margin:auto}section{margin-bottom:var(--space-3xl)}h1{font-family:var(--text-display-font);font-size:var(--text-display-size);line-height:var(--text-display-line-height);font-weight:var(--text-display-weight);letter-spacing:var(--text-display-letter-spacing);max-width:14ch}h2{font-family:var(--text-h2-font);font-size:var(--text-h2-size)}.lead{font-size:var(--text-body-lg-size);line-height:var(--text-body-lg-line-height);color:var(--color-text-muted)}.hero{padding-block:var(--space-3xl)}
 .btn{min-height:${c.accessibility.minTouchTarget}px;font-family:var(--text-button-font);font-size:max(12px,var(--text-button-size));font-weight:var(--text-button-weight);padding:var(--space-sm) var(--space-lg);border-radius:var(--radius-button);border:1px solid var(--color-border);cursor:pointer;transition:filter var(--duration-fast) var(--ease-standard)}.primary{background:var(--color-primary);color:var(--color-on-primary)}.secondary{background:var(--color-secondary);color:var(--color-on-secondary)}.ghost{background:transparent;color:var(--color-text)}.danger{background:var(--color-danger);color:var(--color-on-primary)}.hover{filter:brightness(.92)}.active{filter:brightness(.8);transform:translateY(1px)}.focus,:focus-visible{outline:2px solid var(--color-focus);outline-offset:2px}.btn:disabled{opacity:.45;cursor:default}
 .button-row,.actions{display:flex;flex-wrap:wrap;gap:var(--space-sm);align-items:center;margin-block:var(--space-md)}.button-row>span{width:80px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-xl)}label{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}input,select{padding:12px;border-radius:var(--radius-input);border:1px solid var(--color-border);background:var(--color-surface-raised);color:var(--color-text);font:inherit}.check{flex-direction:row;align-items:center}.error{border-color:var(--color-danger)}.error-text{color:var(--color-danger)}.card{background:var(--color-surface);padding:var(--space-xl);border-radius:var(--radius-card);border:1px solid var(--color-border)}.alert{padding:var(--space-lg);border-radius:var(--radius-md);border-inline-start:4px solid var(--status);background:var(--color-surface);margin-bottom:12px}.badge{display:inline-block;padding:4px 12px;border-radius:var(--radius-badge);background:var(--color-accent);color:var(--color-on-accent)}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:start;padding:12px;border-bottom:1px solid var(--color-border)}footer{color:var(--color-text-muted)}
 ${componentCss(c)}
 @media(max-width:600px){h1{font-size:var(--text-display-size-mobile)}.button-row>span{width:100%}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
 </style></head><body><nav data-component="nav-bar">${logo}<span>${tr('previewNav')}</span></nav><main>
 <section class="hero"><span class="badge">${esc(c.brand.tagline || t('styleguide.title'))}</span><h1>${esc(c.brand.name || t('styleguide.previewHero'))}</h1><p class="lead">${esc(c.brand.description || t('styleguide.previewLead'))}</p><div class="actions"><button class="btn primary" data-component="button-primary">${tr('previewAction')}</button><button class="btn secondary" data-component="button-secondary">${tr('previewSecondary')}</button></div></section>
 <section><h2>${tr('previewButtons')}</h2>${states}</section>
 <section><h2>${tr('previewForm')}</h2><div class="grid"><div><label>${tr('previewName')}<input data-component="input-text" value="${esc(c.brand.name)}"></label><label>${tr('previewSelect')}<select><option>${tr('previewSelect')}</option></select></label><label>${tr('previewName')}<input class="error" aria-invalid="true"></label><p class="error-text">${tr('previewError')}</p></div><div><label class="check"><input type="checkbox">${tr('previewCheckbox')}</label><label class="check"><input type="radio" name="plan">${tr('previewRadio')}</label><label class="check"><input type="checkbox" role="switch">${tr('previewSwitch')}</label></div></div></section>
 <section><h2>${tr('previewCards')}</h2><div class="grid">${['sm', 'md', 'lg'].map(level => `<article class="card" data-component="card" style="box-shadow:var(--shadow-${level})"><h3>${tr('card')} · ${level}</h3><p>${tr('previewLead')}</p></article>`).join('')}</div></section>
 <section><h2>${tr('previewAlerts')}</h2>${['success', 'warning', 'danger', 'info'].map(status => `<div class="alert" data-component="alert" style="--status:var(--color-${status})">${tr(status)} · ${tr('previewLead')}</div>`).join('')}</section>
 <section><h2>${tr('previewBadges')}</h2><span class="badge" data-component="badge">${tr('active')}</span></section>
 <section><h2>${tr('previewTable')}</h2><table data-component="table"><thead><tr><th>${tr('previewColumn')}</th><th>${tr('previewAmount')}</th></tr></thead><tbody>${[1, 2, 3].map(n => `<tr><td>${tr('previewColumn')} ${n}</td><td>${(n * 124.5).toFixed(2)}</td></tr>`).join('')}</tbody></table><div class="actions" aria-label="${tr('previewPagination')}"><button class="btn ghost">${tr('previewPrevious')}</button><button class="btn primary">1</button><button class="btn ghost">2</button><button class="btn ghost">${tr('previewNext')}</button></div></section>
 </main><footer>${tr('previewFooter')}</footer></body></html>`;
}
export async function render(host, s, { source = false } = {}) {
    let disposed = false, timer = null, seq = 0, theme = s.config.colors.themes.default, width = 768, css = '', view = source ? 'design-md' : 'sheet';
    const stage = el('div', 'sg-preview-stage'), iframe = el('iframe', 'sg-preview-frame');
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.title = t('styleguide.componentSheet');
    iframe.style.width = width + 'px';
    stage.append(iframe);
    const pre = el('pre', 'sg-code');
    pre.hidden = view !== 'design-md';
    stage.hidden = view !== 'sheet';
    const md = async () => { await s.flush(); const at = ++seq, value = await fetchStyleGuidePreviewMd(s.projectPath); if (!disposed && at === seq)
        pre.textContent = value; };
    const refresh = () => { if (disposed)
        return; iframe.srcdoc = buildPreviewDocument(s.config, css, theme, s.meta.assetsHash); };
    const themePicker = field(t('styleguide.theme'), theme, v => { theme = v; refresh(); }, { type: 'select', options: ['light', 'dark'] });
    themePicker.querySelector('select').id = 'sg-preview-theme';
    const widthPicker = field(t('styleguide.width'), width, v => { width = Number(v); iframe.style.width = width + 'px'; }, { type: 'select', options: [375, 768, 1440].map(n => [n, n + ' px']) });
    widthPicker.querySelector('select').id = 'sg-preview-width';
    host.append(row(button(t('styleguide.componentSheet'), () => { view = 'sheet'; stage.hidden = false; pre.hidden = true; refresh(); }), button(t('styleguide.designMd'), () => { view = 'design-md'; stage.hidden = true; pre.hidden = false; return md(); }), themePicker, widthPicker, button(t('styleguide.copy'), async () => { if (!pre.textContent)
        await md(); await navigator.clipboard.writeText(pre.textContent); })), stage, pre);
    css = await fetchStyleGuideExport(s.projectPath, 'css');
    if (disposed)
        return;
    refresh();
    if (source)
        await md();
    const unsub = s.subscribe(type => { if (type === 'edit' || type === 'saved') {
        clearTimeout(timer);
        timer = setTimeout(() => { refresh(); if (view === 'design-md')
            md().catch(() => { }); }, 250);
    } });
    return () => { disposed = true; seq++; clearTimeout(timer); unsub(); };
}
