import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch, refreshSwatches } from './sg-kit.js';
import { field } from './sg-kit.js';
export const COMPONENT_TEMPLATES = ['button-primary', 'button-secondary', 'button-ghost', 'button-danger', 'input', 'card', 'badge', 'alert', 'modal', 'nav-bar', 'table'];
export function componentTemplate(id) {
    const category = id.startsWith('button') ? 'button' : id === 'nav-bar' ? 'navigation' : id === 'badge' || id === 'alert' ? 'feedback' : id === 'modal' ? 'overlay' : id === 'table' ? 'data' : id;
    return { id, name: label(id), category, tokens: { background: id === 'button-danger' ? '{status.danger}' : id === 'button-primary' ? '{semantic.primary}' : id === 'button-ghost' ? 'transparent' : '{semantic.surface}', text: id === 'button-primary' ? '{semantic.onPrimary}' : '{semantic.text}', typography: '{typography.button}', radius: id.startsWith('button') ? '{radiusRoles.button}' : '{radiusRoles.card}', padding: '{spacing.md}', shadow: '{elevation.none}', border: '1px solid {semantic.border}' }, states: { hover: '', active: '', focus: '', disabled: '' }, notes: '' };
}
export function render(host, s) {
    let template = 'button-primary', cleanup;
    const picker = field(t('styleguide.template'), template, v => template = v, { type: 'select', options: COMPONENT_TEMPLATES });
    const components = el('div', 'sg-stack');
    const draw = () => {
        components.replaceChildren();
        for (const [i, c] of s.config.components.entries()) {
            const tile = el('div', 'sg-component-card');
            tile.append(grid(text(s, `components.${i}.name`), text(s, `components.${i}.id`), select(s, `components.${i}.category`, ['button', 'input', 'card', 'navigation', 'feedback', 'data', 'overlay', 'other'])));
            const tokens = grid(...Object.keys(c.tokens).map(key => aliasPicker(s, `components.${i}.tokens.${key}`, label(key), key === 'background' || key === 'text')));
            const states = grid(...Object.keys(c.states).map(key => text(s, `components.${i}.states.${key}`, label(key))));
            tile.append(tokens, states, textarea(s, `components.${i}.notes`));
            const move = dir => { const next = [...s.config.components]; [next[i], next[i + dir]] = [next[i + dir], next[i]]; s.set('components', next); draw(); };
            const up = button(t('styleguide.up'), () => move(-1));
            up.disabled = i === 0;
            const down = button(t('styleguide.down'), () => move(1));
            down.disabled = i === s.config.components.length - 1;
            tile.append(row(up, down, button(t('styleguide.remove'), () => { s.set('components', s.config.components.filter((_, j) => j !== i)); draw(); })));
            components.append(tile);
        }
        refreshSwatches(components, s, 'light');
    };
    draw();
    host.append(card('specs', row(picker, button(t('styleguide.addComponent'), () => { if (s.config.components.length >= 60)
        throw new Error(t('styleguide.limit')); const c = componentTemplate(template); let suffix = 2; while (s.config.components.some(x => x.id === c.id))
        c.id = template + '-' + suffix++; s.set('components', [...s.config.components, c]); draw(); })), el('p', 'sg-hint', t('styleguide.alias')), components));
    return watch(s, () => refreshSwatches(components, s, 'light'));
}
