import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
import { markdownPreview } from './sg-kit.js';
export function render(host, s) {
    const preview = el('div');
    preview.append(markdownPreview(s.config.rules.custom));
    preview.setAttribute('aria-label', t('styleguide.renderedMarkdown'));
    host.append(card('accessibility', select(s, 'accessibility.level', ['A', 'AA', 'AAA']), grid(number(s, 'accessibility.minContrastText', ':1', { min: 1, max: 21 }), number(s, 'accessibility.minContrastLarge', ':1', { min: 1, max: 21 }), number(s, 'accessibility.minTouchTarget', 'px', { min: 16, max: 96 })), aliasPicker(s, 'accessibility.focusRing'), el('p', 'sg-hint', t('styleguide.alias')), listEditor(s, 'accessibility.notes')), card('rules', grid(listEditor(s, 'rules.dos'), listEditor(s, 'rules.donts')), textarea(s, 'rules.custom'), preview));
    return watch(s, () => preview.replaceChildren(markdownPreview(s.config.rules.custom)));
}
