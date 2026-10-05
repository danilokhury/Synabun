import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
export function render(host, s) {
    const previews = new Map();
    const radii = mapEditor(s, 'shape.radius', { unit: 'px', render: (key, value) => { const sample = el('span', 'sg-radius-sample'); sample.style.borderRadius = value + 'px'; previews.set(key, sample); if (!(value <= 64))
        return sample; const slider = text(s, `shape.radius.${key}`, key, { type: 'range', min: 0, max: 64, step: 1 }); slider.classList.add('sg-hide-label'); return row(slider, sample); } });
    const roles = grid(...Object.keys(s.config.shape.radiusRoles).map(key => select(s, `shape.radiusRoles.${key}`, Object.keys(s.config.shape.radius).map(k => [k, k]), label(key))));
    const elevations = el('div', 'sg-stack');
    const draw = () => {
        elevations.replaceChildren();
        for (const key of Object.keys(s.config.shape.elevation)) {
            const sample = el('div', 'sg-shadow-sample', key);
            sample.style.boxShadow = s.get(`shape.elevation.${key}.shadow`);
            elevations.append(row(grid(text(s, `shape.elevation.${key}.shadow`, key), text(s, `shape.elevation.${key}.usage`)), sample, button(t('styleguide.remove'), () => { const next = { ...s.config.shape.elevation }; delete next[key]; s.set('shape.elevation', next); draw(); })));
        }
        const name = textBox();
        elevations.append(row(name, button(t('styleguide.addElevation'), () => { const key = name.querySelector('input').value.trim().replace(/[{}.\s]+/g, '-'); if (!key || ['__proto__', 'constructor', 'prototype'].includes(key))
            return; s.set('shape.elevation', { ...s.config.shape.elevation, [key]: { shadow: 'none', usage: '' } }); draw(); })));
    };
    function textBox() { const n = el('label', 'sg-field', t('styleguide.tokenName')); const i = el('input', 'sg-input'); n.append(i); return n; }
    draw();
    host.append(card('radius', radii, roles), card('borders', mapEditor(s, 'shape.borders', { unit: 'px' })), card('elevation', elevations));
    return watch(s, () => { for (const [key, node] of previews)
        node.style.borderRadius = s.get(`shape.radius.${key}`) + 'px'; });
}
