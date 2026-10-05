// Style Guide exporters: W3C design tokens (DTCG 2025.10), CSS custom properties, Tailwind v4 and v3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportCss } from '../lib/style-guide/export-css.js';
import { DTCG_MIME, dtcgColor, dtcgName, exportDtcg, exportDtcgText, walkDtcg } from '../lib/style-guide/export-dtcg.js';
import { exportTailwindV3, exportTailwindV4, tailwindV3Theme } from '../lib/style-guide/export-tailwind.js';
import { applyMergePatch, defaultStyleGuide, normalizeStyleGuide } from '../lib/style-guide/schema.js';
import { fontList, fontStack, parseEasing, parseShadow, resolvedTokens, roleFromName, roleName, themesOf } from '../lib/style-guide/tokens.js';

const base = defaultStyleGuide('/work/acme');
const TYPES = new Set(['color', 'dimension', 'fontFamily', 'fontWeight', 'duration', 'cubicBezier', 'number', 'shadow', 'typography']);

test('DTCG: every token has a $value and a type it can be resolved to, names are legal, aliases resolve', () => {
  const doc = exportDtcg(base, { generatedAt: '2026-10-02T00:00:00.000Z' });
  const { tokens, problems } = walkDtcg(doc);
  assert.deepEqual(problems, []);
  assert.ok(tokens.length > 120, `${tokens.length} tokens`);
  for (const token of tokens) {
    assert.ok(token.value !== undefined && token.value !== null, token.path.join('.'));
    assert.ok(TYPES.has(token.type), `${token.path.join('.')}: ${token.type}`);
    for (const part of token.path) assert.doesNotMatch(part, /[{}.]|^\$/, token.path.join('.'));
  }
  // The groups the spec names, each typed at the group.
  assert.deepEqual(Object.keys(doc), ['$description', '$extensions', 'color', 'fontFamily', 'typography', 'lineHeight', 'spacing', 'radius', 'radiusRole', 'breakpoint', 'border', 'shadow', 'duration', 'cubicBezier', 'zIndex']);
  for (const [group, type] of Object.entries({ color: 'color', fontFamily: 'fontFamily', typography: 'typography', lineHeight: 'number', spacing: 'dimension', radius: 'dimension', radiusRole: 'dimension', breakpoint: 'dimension', border: 'dimension', shadow: 'shadow', duration: 'duration', cubicBezier: 'cubicBezier', zIndex: 'number' })) assert.equal(doc[group].$type, type, group);
  assert.deepEqual(doc.$extensions['dev.synabun'], { revision: 0, generatedAt: '2026-10-02T00:00:00.000Z', projectPath: '/work/acme', skipped: [] });
  assert.equal(DTCG_MIME, 'application/design-tokens+json');
});

test('DTCG: the 2025.10 value shapes', () => {
  const doc = exportDtcg(base);
  assert.deepEqual(doc.color.primary['500'].$value, { colorSpace: 'srgb', components: [0.2314, 0.5098, 0.9647], alpha: 1, hex: '#3b82f6' });
  assert.equal(doc.color.primary.$description, 'CTAs, links, focus', 'usage rides on $description');
  assert.equal(doc.color.semantic.light.background.$value.hex, '#ffffff');
  assert.equal(doc.color.semantic.light.surface.$value, '{color.neutral.50}', 'an alias stays an alias');
  assert.equal(doc.color.semantic.dark.primary.$value, '{color.primary.400}');
  assert.equal(doc.color.status.danger.$value.hex, '#ef4444');
  assert.deepEqual(doc.fontFamily.heading.$value, ['Space Grotesk', 'system-ui', 'sans-serif']);
  assert.deepEqual(doc.typography.h1.$value, { fontFamily: '{fontFamily.heading}', fontSize: { value: 40, unit: 'px' }, fontWeight: 700, letterSpacing: { value: -0.8, unit: 'px' }, lineHeight: 1.1 });
  assert.equal(doc.typography.h1.$description, 'Page title');
  assert.deepEqual(doc.typography.h1.$extensions['dev.synabun'], { mobileSize: 32 });
  assert.deepEqual(doc.spacing.md.$value, { value: 12, unit: 'px' });
  assert.deepEqual(doc.radius.pill.$value, { value: 9999, unit: 'px' });
  assert.equal(doc.radiusRole.button.$value, '{radius.md}');
  assert.deepEqual(doc.breakpoint.md.$value, { value: 768, unit: 'px' });
  assert.deepEqual(doc.shadow.md.$value, { color: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.1, hex: '#000000' }, offsetX: { value: 0, unit: 'px' }, offsetY: { value: 4, unit: 'px' }, blur: { value: 12, unit: 'px' }, spread: { value: 0, unit: 'px' } });
  assert.equal(doc.shadow.none.$value.color.alpha, 0);
  assert.deepEqual(doc.duration.fast.$value, { value: 150, unit: 'ms' });
  assert.deepEqual(doc.cubicBezier.standard.$value, [0.2, 0, 0, 1]);
  assert.deepEqual([doc.zIndex.modal.$value, doc.lineHeight.body.$value], [1300, 1.5]);
  assert.equal(exportDtcgText(base), exportDtcgText(defaultStyleGuide('/work/acme')), 'deterministic');
  assert.ok(exportDtcgText(base).endsWith('}\n'));
});

test('DTCG: what cannot be expressed is skipped and listed, never written wrong', () => {
  const odd = normalizeStyleGuide(applyMergePatch(base, { shape: { elevation: { glow: { shadow: '0 0 12px 2px rgba(59,130,246,.4), inset 0 1px 0 #ffffff', usage: 'Focus' }, weird: { shadow: 'drop it like this', usage: '' } } }, motion: { easings: { steps: 'steps(4, end)', soft: 'ease-in-out' } }, colors: { palettes: { 'brand-mint': { base: '#3dd68c' } } } }));
  const doc = exportDtcg(odd);
  assert.deepEqual(doc.$extensions['dev.synabun'].skipped, ['shadow.weird', 'cubicBezier.steps']);
  assert.equal('weird' in doc.shadow, false);
  assert.equal(Array.isArray(doc.shadow.glow.$value) && doc.shadow.glow.$value.length, 2);
  assert.equal(doc.shadow.glow.$value[1].inset, true);
  assert.deepEqual(doc.cubicBezier.soft.$value, [0.42, 0, 0.58, 1]);
  assert.equal(doc.color['brand-mint']['500'].$value.hex, '#3dd68c');
  assert.deepEqual(walkDtcg(doc).problems, []);
  assert.deepEqual([dtcgName('a.b{c}'), dtcgName('$x')], ['a-b-c-', 'x']);
  assert.equal(dtcgColor('nope'), null);
  assert.deepEqual(dtcgColor('rgba(255,0,0,.5)'), { colorSpace: 'srgb', components: [1, 0, 0], alpha: 0.5, hex: '#ff0000' });
  assert.deepEqual(walkDtcg({ a: { $value: '{b.c}' }, 'x.y': { $value: 1, $type: 'number' }, z: { $value: 2 } }).problems, ['x.y: a name may not contain "{", "}" or "."', 'a: alias {b.c} names no token', 'a: no $type', 'z: no $type']);
});

test('CSS: every token under :root, the dark block under the configured selector, the reduced-motion block', () => {
  const css = exportCss(base);
  assert.ok(css.startsWith('/* SynaBun Style Guide rev 0: design tokens. Generated, do not edit by hand. */\n:root {\n  color-scheme: light;\n  --color-primary-50: '));
  for (const line of [
    '  --color-primary-500: #3b82f6;', '  --color-danger: #ef4444;', '  --color-background: #ffffff;', '  --color-surface: var(--color-neutral-50);', '  --color-on-primary: #ffffff;', '  --color-text-muted: var(--color-neutral-500);',
    '  --gradient-hero: linear-gradient(135deg, #3b82f6, #8b5cf6);',
    '  --font-heading: "Space Grotesk", system-ui, sans-serif;', '  --font-body: Inter, system-ui, sans-serif;',
    '  --text-h1-size: 2.5rem;', '  --text-h1-size-mobile: 2rem;', '  --text-h1-weight: 700;', '  --text-h1-line-height: 1.1;', '  --text-h1-letter-spacing: -0.02em;', '  --text-h1-font: var(--font-heading);', '  --text-body-letter-spacing: 0;',
    '  --space-md: 12px;', '  --radius-md: 8px;', '  --radius-none: 0;', '  --radius-button: var(--radius-md);', '  --border-thin: 1px;', '  --shadow-md: 0 4px 12px rgba(0,0,0,.10);',
    '  --duration-fast: 150ms;', '  --ease-standard: cubic-bezier(0.2, 0, 0, 1);', '  --breakpoint-md: 768px;', '  --z-modal: 1300;', '  --container-max: 1200px;', '  --grid-columns: 12;',
  ]) assert.ok(css.includes(`\n${line}\n`), line);
  const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
  assert.ok(dark.startsWith('[data-theme="dark"] {\n  color-scheme: dark;\n  --color-background: var(--color-neutral-950);\n'));
  assert.ok(!dark.slice(0, dark.indexOf('}')).includes('--space-'), 'the dark block only re-declares the semantic colors');
  assert.ok(css.endsWith('\n@media (prefers-reduced-motion: reduce) {\n  :root {\n    --duration-fast: 0ms;\n    --duration-normal: 0ms;\n    --duration-slow: 0ms;\n  }\n}\n'));
  assert.equal(css, exportCss(defaultStyleGuide('/work/acme')), 'deterministic');
});

test('CSS: the dark-mode selector, a custom root, a dark default, one theme and no reduced-motion block', () => {
  const media = exportCss(applyMergePatch(base, { exports: { darkMode: 'media' } }));
  assert.ok(media.includes('\n@media (prefers-color-scheme: dark) {\n  :root {\n    color-scheme: dark;\n    --color-background: var(--color-neutral-950);'));
  const klass = exportCss(applyMergePatch(base, { exports: { darkMode: 'class', cssSelector: '.app' } }));
  assert.ok(klass.includes('\n.app {\n  color-scheme: light;'));
  assert.ok(klass.includes('\n.app.dark, .dark .app {\n  color-scheme: dark;'));
  const darkFirst = exportCss(applyMergePatch(base, { colors: { themes: { default: 'dark' } } }));
  assert.ok(darkFirst.includes(':root {\n  color-scheme: dark;'));
  assert.ok(darkFirst.includes('\n[data-theme="light"] {\n  color-scheme: light;\n  --color-background: #ffffff;'));
  const single = exportCss(applyMergePatch(base, { colors: { themes: { default: 'light', supports: ['light'] } }, motion: { reducedMotion: 'ignore' } }));
  assert.ok(!single.includes('data-theme') && !single.includes('prefers-reduced-motion'));
  // `theme` flattens: literal colors, no second block.
  const flat = exportCss(base, { theme: 'dark' });
  assert.ok(flat.includes(`  --color-background: ${base.colors.palettes.neutral.steps['950']};`));
  assert.ok(!flat.includes('data-theme'));
});

test('Tailwind v4: an @theme block with the namespaces Tailwind reads, and the other theme in a base layer', () => {
  const css = exportTailwindV4(base);
  assert.ok(css.startsWith('/* SynaBun Style Guide rev 0: Tailwind v4 theme. Generated, do not edit by hand. */\n@theme {\n  --color-primary-50: '));
  for (const line of ['  --color-primary-500: #3b82f6;', '  --color-background: #ffffff;', '  --color-surface: var(--color-neutral-50);', '  --font-heading: "Space Grotesk", system-ui, sans-serif;', '  --text-h1: 2.5rem;', '  --text-h1--line-height: 1.1;', '  --text-h1--font-weight: 700;', '  --text-h1--letter-spacing: -0.02em;', '  --spacing: 0.25rem;', '  --radius-md: 8px;', '  --radius-button: 8px;', '  --shadow-md: 0 4px 12px rgba(0,0,0,.10);', '  --shadow-none: 0 0 #0000;', '  --breakpoint-md: 48rem;', '  --ease-standard: cubic-bezier(0.2, 0, 0, 1);']) assert.ok(css.includes(`\n${line}\n`), line);
  assert.ok(css.includes('\n@layer base {\n  [data-theme="dark"] {\n    --color-background: var(--color-neutral-950);'));
  assert.ok(exportTailwindV4(applyMergePatch(base, { exports: { darkMode: 'media' } })).includes('  @media (prefers-color-scheme: dark) {\n    :root {\n      --color-background: var(--color-neutral-950);'));
  assert.ok(!exportTailwindV4(base, { theme: 'light' }).includes('@layer'));
  assert.equal(css, exportTailwindV4(defaultStyleGuide('/work/acme')));
});

test('Tailwind v3: a CommonJS module whose theme.extend has the keys the spec lists', () => {
  const source = exportTailwindV3(base);
  const module_ = { exports: null };
  new Function('module', source)(module_);
  const extend = module_.exports.theme.extend;
  assert.deepEqual(extend, tailwindV3Theme(base));
  assert.deepEqual(Object.keys(extend), ['colors', 'fontFamily', 'fontSize', 'spacing', 'borderRadius', 'borderWidth', 'boxShadow', 'screens', 'zIndex', 'transitionTimingFunction', 'transitionDuration']);
  assert.equal(extend.colors.primary['500'], '#3b82f6');
  assert.equal(extend.colors.primary.DEFAULT, 'var(--color-primary, #3b82f6)', 'the role of the same name is the palette\'s DEFAULT');
  assert.equal(extend.colors.background, 'var(--color-background, #ffffff)');
  assert.equal(extend.colors['on-primary'], 'var(--color-on-primary, #ffffff)');
  assert.equal(extend.colors.danger, '#ef4444');
  assert.deepEqual(extend.fontFamily.heading, ['Space Grotesk', 'system-ui', 'sans-serif']);
  assert.deepEqual(extend.fontSize.h1, ['2.5rem', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '700' }]);
  assert.deepEqual([extend.borderRadius.md, extend.borderRadius.button, extend.boxShadow.none, extend.screens.md, extend.transitionDuration.fast, extend.transitionTimingFunction.standard, extend.zIndex.modal, extend.spacing.md], ['8px', '8px', 'none', '768px', '150ms', 'cubic-bezier(0.2, 0, 0, 1)', '1300', '12px']);
});

test('the shared token helpers', () => {
  assert.deepEqual([roleName('onPrimary'), roleName('surfaceRaised'), roleFromName('text-muted'), roleFromName('background')], ['on-primary', 'surface-raised', 'textMuted', 'background']);
  assert.deepEqual(themesOf(base), ['light', 'dark']);
  assert.deepEqual(themesOf(normalizeStyleGuide(applyMergePatch(base, { colors: { themes: { default: 'dark' } } }))), ['dark', 'light']);
  assert.equal(fontStack({ family: 'Inter', fallback: '' }), 'Inter');
  assert.equal(fontStack({ family: 'A "B" C', fallback: 'serif' }), '"A B C", serif');
  assert.deepEqual(fontList({ family: 'IBM Plex Sans', fallback: '"Helvetica Neue", sans-serif' }), ['IBM Plex Sans', 'Helvetica Neue', 'sans-serif']);
  assert.deepEqual(parseShadow('none'), []);
  assert.deepEqual(parseShadow('0 1px 2px rgba(0,0,0,.06)'), [{ inset: false, offsetX: 0, offsetY: 1, blur: 2, spread: 0, color: 'rgba(0,0,0,.06)' }]);
  assert.deepEqual(parseShadow('inset 1px 2px #000'), [{ inset: true, offsetX: 1, offsetY: 2, blur: 0, spread: 0, color: '#000' }]);
  assert.equal(parseShadow('1px'), null);
  assert.equal(parseShadow('1px 2px nonsense'), null);
  assert.deepEqual([parseEasing('ease'), parseEasing('cubic-bezier(0.1, 0.2, 0.3, 0.4)'), parseEasing('steps(2)')], [[0.25, 0.1, 0.25, 1], [0.1, 0.2, 0.3, 0.4], null]);
  const light = resolvedTokens(base);
  const dark = resolvedTokens(base, 'dark');
  assert.deepEqual([light.theme, dark.theme, light.themes], ['light', 'dark', ['light', 'dark']]);
  assert.deepEqual([light.colors.background, dark.colors.background, light.radiusRoles.button, light.gradients.hero], ['#ffffff', base.colors.palettes.neutral.steps['950'], 8, 'linear-gradient(135deg, #3b82f6, #8b5cf6)']);
  assert.equal(light.text.h1.fontFamily, '"Space Grotesk", system-ui, sans-serif');
  assert.ok(!JSON.stringify(light).includes('{'.concat('neutral')), 'no alias is left');
});
