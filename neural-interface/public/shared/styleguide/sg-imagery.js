import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
export function render(host, s) {
    host.append(card('direction', select(s, 'imagery.style', ['photography', 'illustration', '3d', 'abstract', 'mixed']), textarea(s, 'imagery.mood'), textarea(s, 'imagery.notes'), grid(listEditor(s, 'imagery.dos'), listEditor(s, 'imagery.donts'))), card('generation', textarea(s, 'imagery.generation.promptPrefix'), textarea(s, 'imagery.generation.negativePrompt'), grid(listEditor(s, 'imagery.generation.aspectRatios', label('aspectRatios'), { max: 8, chips: true }), listEditor(s, 'imagery.generation.styleReferences', label('styleReferences'), { max: 12 }))));
}
