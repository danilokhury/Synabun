import { t, label, el, card, row, grid, text, number, select, toggle, textarea, listEditor, mapEditor, aliasPicker, colorField, button, watch } from './sg-kit.js';
import { uploadStyleGuideLogo, deleteStyleGuideLogo, styleGuideAssetUrl } from '../api.js';
export function render(host, s) {
    const variants = el('div', 'sg-grid'), previews = [];
    for (const [i, v] of s.config.logo.variants.entries()) {
        const tile = el('div', 'sg-logo-tile'), preview = el('div', 'sg-logo-preview'), img = el('img');
        img.src = styleGuideAssetUrl(s.meta.assetsHash, v.file);
        img.alt = v.name;
        preview.style.background = v.bg === 'primary' ? s.config.colors.palettes.primary.base : v.bg === 'white' ? s.config.colors.semantic.light.background : s.config.colors.palettes.neutral.steps[950];
        preview.append(img);
        previews.push({ preview, i });
        tile.append(preview, text(s, `logo.variants.${i}.name`), select(s, `logo.variants.${i}.kind`, ['primary', 'mono', 'inverted', 'icon', 'wordmark']), select(s, `logo.variants.${i}.bg`, ['primary', 'white', 'dark']), button(t('styleguide.remove'), () => s.action(path => deleteStyleGuideLogo(path, v.id))));
        variants.append(tile);
    }
    if (!s.config.logo.variants.length)
        variants.append(el('p', 'sg-hint', t('styleguide.logoEmpty')));
    const upload = el('label', 'sg-field', t('styleguide.upload')), input = el('input', 'sg-input');
    input.type = 'file';
    input.accept = 'image/svg+xml,image/png,image/jpeg,image/webp';
    upload.append(input);
    input.addEventListener('change', async () => { const file = input.files[0]; if (!file)
        return; try {
        if (file.size > 4 * 1024 * 1024)
            throw new Error(t('styleguide.uploadHint'));
        await s.action(path => uploadStyleGuideLogo(path, file, { name: file.name.replace(/\.[^.]+$/, ''), kind: 'primary', bg: 'primary' }));
    }
    catch (e) {
        const n = host.closest('.styleguide-panel').querySelector('.sg-error');
        n.hidden = false;
        n.textContent = e.message;
    } });
    host.append(card('icons', grid(text(s, 'iconography.library'), select(s, 'iconography.style', ['outline', 'filled', 'duotone']), number(s, 'iconography.strokeWidth', 'px', { min: 0, max: 8 })), listEditor(s, 'iconography.sizes', label('sizes'), { numeric: true, max: 12, chips: true }), textarea(s, 'iconography.notes')), card('logos', variants, upload, el('p', 'sg-hint', t('styleguide.uploadHint'))), card('logoRules', text(s, 'logo.clearSpace'), number(s, 'logo.minSize.px', 'px', { name: label('minSize'), min: 1, max: 2000 }), select(s, 'logo.favicon', [['', t('styleguide.none')], ...s.config.logo.variants.map(v => [v.file, v.name])], t('styleguide.favicon')), listEditor(s, 'logo.donts')));
    return watch(s, () => { for (const { preview, i } of previews) {
        const v = s.config.logo.variants[i];
        if (v)
            preview.style.background = v.bg === 'primary' ? s.config.colors.palettes.primary.base : v.bg === 'white' ? s.config.colors.semantic.light.background : s.config.colors.palettes.neutral.steps[950];
    } });
}
