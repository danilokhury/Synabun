import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
export function render(host, s) {
    host.append(card('identity', grid(text(s, 'brand.name'), text(s, 'brand.tagline')), grid(textarea(s, 'brand.description'), textarea(s, 'brand.audience')), textarea(s, 'brand.vibe'), listEditor(s, 'brand.personality', label('personality'), { chips: true, max: 12 }), listEditor(s, 'brand.keyCharacteristics', label('keyCharacteristics'), { max: 12 })), card('voice', textarea(s, 'brand.voice.tone'), grid(listEditor(s, 'brand.voice.dos'), listEditor(s, 'brand.voice.donts'))));
}
