// The Style Guide summary agents get (lib/style-guide/summary.js): what it says, in what order for an image
// run, and that it never passes the token budget. Plus the eight presets (lib/style-guide/presets.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { wcagContrast } from '../lib/style-guide/color.js';
import { PRESETS, applyPreset, getPreset, listPresets } from '../lib/style-guide/presets.js';
import { applyMergePatch, defaultStyleGuide, findUnknownAliases, normalizeStyleGuide, resolveColor } from '../lib/style-guide/schema.js';
import { SUMMARY_MAX_TOKENS, estimateTokens, styleGuideSummary, styleGuideSummaryForClass } from '../lib/style-guide/summary.js';

const base = defaultStyleGuide('/work/acme');
const full = normalizeStyleGuide(applyMergePatch(base, {
  brand: { name: 'Acme', tagline: 'Tools that stay out of the way', audience: 'Operations teams', personality: ['precise', 'warm'], voice: { tone: 'Plain and direct.' } },
  logo: { variants: [{ id: 'logo-main', name: 'Main', kind: 'primary', file: 'logo-main.svg', bg: 'white' }], clearSpace: 'One mark height' },
  imagery: { style: 'illustration', mood: 'Soft, geometric', notes: 'Flat color.', dos: ['Use the brand blue'], donts: ['Use stock photos'], generation: { promptPrefix: 'Flat geometric illustration, soft blue', negativePrompt: 'photorealism', aspectRatios: ['16:9', '1:1'], styleReferences: ['ref-1.png'] } },
  rules: { dos: ['Use real copy', 'One primary action per view'], donts: ['Put text on gradients'] },
  agents: { instructions: 'Ask before adding a palette.' },
}));

test('the summary names the brand, both themes\' key colors, fonts and text styles, spacing, radius, motion, icons, logo, imagery and rules', () => {
  const text = styleGuideSummary(full);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Brand: Acme — Tools that stay out of the way');
  assert.equal(lines[1], 'Personality: precise, warm. Voice: Plain and direct.');
  for (const line of [
    'Audience: Operations teams',
    'Colors (light + dark, default light): primary #3b82f6, secondary #8b5cf6, accent #eab308, neutral #64748b',
    `- light: background #ffffff, surface ${base.colors.palettes.neutral.steps['50']}, text ${base.colors.palettes.neutral.steps['900']}, muted #64748b, border ${base.colors.palettes.neutral.steps['200']}, primary #3b82f6 (text on it #ffffff), link ${base.colors.palettes.primary.steps['600']}`,
    '- status: success #22c55e, warning #f59e0b, danger #ef4444, info #0ea5e9',
    'Fonts: headings Space Grotesk (600/700), body Inter (400/500), mono JetBrains Mono',
    'Text styles (px/line-height/weight): display 56/1.05/700, h1 40/1.1/700, h2 32/1.15/700, h3 24/1.25/600, body 16/1.5/400, body-sm 14/1.5/400, caption 12/1.4/400, button 14/1.2/500',
    'Spacing (base 4px): xs 4, sm 8, md 12, lg 16, xl 24, 2xl 32, 3xl 48, 4xl 64',
    'Radius: button 8px, card 12px, input 4px, badge 9999px, modal 16px',
    'Motion: fast 150ms, normal 250ms, slow 400ms; easing cubic-bezier(0.2, 0, 0, 1); honour prefers-reduced-motion',
    'Icons: lucide, outline, 1.5px stroke',
    'Logo: primary .synabun/style-guide/logo-main.svg (on white); minimum 24px; clear space One mark height',
    'Imagery: illustration — Soft, geometric. Flat color.',
    'Image-generation prefix: "Flat geometric illustration, soft blue"',
    'Do: Use real copy; One primary action per view',
    "Don't: Put text on gradients",
    'Project instructions: Ask before adding a palette.',
  ]) assert.ok(lines.includes(line), line);
  assert.ok(lines.some((line) => line.startsWith('- dark: background ')));
  assert.equal(text, styleGuideSummary(JSON.parse(JSON.stringify(full))), 'deterministic');
  assert.ok(!/\{[a-z]+\.[a-z0-9]+\}/i.test(text), 'colors are resolved, never aliases');
});

test('an image or video run reads the imagery first and is spared the layout details', () => {
  for (const taskClass of ['image_gen', 'video_gen']) {
    const lines = styleGuideSummaryForClass(full, taskClass).split('\n');
    assert.deepEqual(lines.slice(0, 5), [
      'Imagery: illustration — Soft, geometric. Flat color.',
      'Image-generation prefix: "Flat geometric illustration, soft blue"',
      'Avoid in images: photorealism',
      'Aspect ratios: 16:9, 1:1',
      'Style references: ref-1.png',
    ], taskClass);
    assert.equal(lines[5], "Do: Use the brand blue Don't: Use stock photos");
    assert.equal(lines[6], 'Brand: Acme — Tools that stay out of the way');
    assert.ok(lines.some((line) => line.startsWith('Colors (')) && lines.some((line) => line.startsWith('Logo: ')) && lines.some((line) => line.startsWith('Fonts: ')));
    assert.ok(!lines.some((line) => /^(Text styles|Spacing|Radius|Motion|Icons)/.test(line)), 'no layout tokens for a picture');
  }
  assert.equal(styleGuideSummaryForClass(full, 'code'), styleGuideSummary(full));
  assert.ok(styleGuideSummaryForClass(full, 'design').startsWith('Brand: Acme'));
});

test('the token estimate never passes the budget, however much the guide holds', () => {
  assert.equal(SUMMARY_MAX_TOKENS, 600);
  assert.deepEqual([estimateTokens(''), estimateTokens('abcd'), estimateTokens('abcde')], [0, 1, 2]);
  const defaults = estimateTokens(styleGuideSummary(base));
  assert.ok(defaults >= 200 && defaults <= 500, `${defaults} tokens for the default guide`);
  const long = 'A very long sentence that goes on and on about the brand and its many virtues. '.repeat(40);
  const stuffed = normalizeStyleGuide(applyMergePatch(full, {
    brand: { tagline: long, description: long, audience: long, personality: Array.from({ length: 12 }, (_, i) => `adjective-${i}`), voice: { tone: long } },
    colors: { palettes: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`extra-${i}`, { base: '#123456' }])) },
    imagery: { mood: long, notes: long, generation: { promptPrefix: long, negativePrompt: long, styleReferences: [long, long, long] }, dos: [long, long, long], donts: [long, long, long] },
    logo: { clearSpace: long, variants: Array.from({ length: 8 }, (_, i) => ({ id: `logo-${i}`, name: `L${i}`, kind: 'primary', file: `logo-${i}.svg`, bg: 'white' })) },
    rules: { dos: [long, long, long, long, long], donts: [long, long, long, long, long] },
    agents: { instructions: long },
    typography: { styles: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`style-${i}`, { size: 10 + i }])) },
    layout: { spacing: { scale: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, i * 4])) } },
  }));
  for (const taskClass of [null, 'code', 'complex', 'design', 'image_gen', 'video_gen']) {
    const text = styleGuideSummaryForClass(stuffed, taskClass);
    assert.ok(estimateTokens(text) <= 600, `${taskClass}: ${estimateTokens(text)} tokens`);
    assert.ok(text.includes(taskClass === 'image_gen' || taskClass === 'video_gen' ? 'Image-generation prefix:' : 'Colors ('), String(taskClass));
  }
  assert.ok(estimateTokens(styleGuideSummary(stuffed, { maxTokens: 120 })) <= 120, 'a tighter budget is honoured too');
  assert.ok(styleGuideSummary(stuffed, { maxTokens: 120 }).startsWith('Brand: '), 'the brand line is the last to go');
});

test('eight complete presets: each one a full, valid guide with its own values', () => {
  const list = listPresets();
  assert.deepEqual(list.map((p) => p.id), ['synabun-default', 'minimal-saas', 'dark-developer', 'editorial', 'playful', 'enterprise', 'fintech-precision', 'warm-organic']);
  assert.deepEqual(list.map((p) => p.name), ['SynaBun Default', 'Minimal SaaS', 'Dark Developer', 'Editorial', 'Playful', 'Enterprise', 'Fintech Precision', 'Warm Organic']);
  assert.equal(new Set(list.map((p) => p.swatches[0])).size, 8, 'no two presets share a primary');
  for (const preset of list) {
    assert.deepEqual(Object.keys(preset), ['id', 'name', 'description', 'swatches', 'fonts', 'theme']);
    assert.ok(preset.description.length > 30, preset.id);
    assert.equal(preset.swatches.length, 4);
    for (const hex of preset.swatches) assert.match(hex, /^#[0-9a-f]{6}$/);
    assert.ok(preset.fonts.heading && preset.fonts.body, preset.id);
    const { config, diff } = applyPreset(base, preset.id);
    assert.deepEqual(normalizeStyleGuide(config), config, `${preset.id} is already normal`);
    assert.deepEqual(findUnknownAliases(config), [], preset.id);
    // Complete: a brand voice, twelve text styles, radii with roles, motion, imagery with a generation prefix, rules.
    assert.ok(config.brand.vibe && config.brand.personality.length >= 3 && config.brand.keyCharacteristics.length >= 3 && config.brand.voice.tone, preset.id);
    assert.equal(Object.keys(config.typography.styles).length, 12, preset.id);
    assert.ok(config.imagery.generation.promptPrefix && config.imagery.generation.negativePrompt && config.imagery.mood, preset.id);
    assert.ok(config.rules.dos.length >= 2 && config.rules.donts.length >= 2, preset.id);
    for (const palette of Object.values(config.colors.palettes)) assert.equal(Object.keys(palette.steps).length, 11);
    // Readable in both themes: body text on its background clears AA.
    for (const theme of config.colors.themes.supports) {
      const ratio = wcagContrast(resolveColor(config, config.colors.semantic[theme].text, { theme }), resolveColor(config, config.colors.semantic[theme].background, { theme }));
      assert.ok(ratio >= 7, `${preset.id} ${theme}: text on background ${ratio.toFixed(2)}:1`);
    }
    assert.ok(estimateTokens(styleGuideSummaryForClass(config, 'code')) <= 600 && estimateTokens(styleGuideSummaryForClass(config, 'image_gen')) <= 600, preset.id);
    assert.ok(preset.id === 'synabun-default' ? diff.length > 0 : diff.length > 30, `${preset.id}: ${diff.length} changes`);
  }
  assert.equal(getPreset('dark-developer').name, 'Dark Developer');
  assert.equal(applyPreset(base, 'dark-developer').config.colors.themes.default, 'dark');
  assert.deepEqual([getPreset('nope'), applyPreset(base, 'nope')], [null, null]);
  assert.ok(Object.isFrozen(PRESETS));
});

test('a preset replaces the design and keeps the project\'s own settings; merge lays it over the current guide', () => {
  const current = normalizeStyleGuide(applyMergePatch(base, {
    revision: 5, brand: { name: 'Acme', tagline: 'Mine' }, logo: { variants: [{ id: 'logo-a', name: 'A', kind: 'primary', file: 'logo-a.svg', bg: 'white' }] },
    agents: { instructions: 'Ask first.' }, exports: { tailwind: 'v3' }, colors: { palettes: { 'brand-mint': { base: '#3dd68c' } } },
  }));
  const replaced = applyPreset(current, 'editorial').config;
  assert.deepEqual([replaced.revision, replaced.logo, replaced.agents, replaced.exports, replaced.projectPath], [5, current.logo, current.agents, current.exports, current.projectPath]);
  assert.deepEqual([replaced.brand.name, replaced.brand.tagline, 'brand-mint' in replaced.colors.palettes, replaced.typography.fonts.heading.family], ['', '', false, 'Playfair Display']);
  const merged = applyPreset(current, 'editorial', { merge: 'merge' }).config;
  assert.deepEqual([merged.brand.name, merged.brand.tagline, 'brand-mint' in merged.colors.palettes, merged.typography.fonts.heading.family], ['Acme', 'Mine', true, 'Playfair Display']);
});
