// Style Guide schema v2 (lib/style-guide/schema.js): defaults, normalizeStyleGuide with the v1 migration
// and the old editor's mirror, the alias resolver, RFC 7396 merge patches and the leaf diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE_STEPS, scaleFromBase } from '../lib/style-guide/color.js';
import {
  CORE_PALETTES, DEFAULTS, INJECT_DEFAULTS, SCHEMA_VERSION, SEMANTIC_ROLES, STYLE_GUIDE_OUT_DIR,
  applyMergePatch, defaultStyleGuide, diffConfigs, findUnknownAliases, hasLegacyKeys, isAlias, kebab, normalizeStyleGuide,
  parseAlias, resolveAlias, resolveColor, resolveText, safeOutDir, toV1View, tokenKey, typeScale, withV1Mirror,
} from '../lib/style-guide/schema.js';
import { defaultStyleGuide as shimDefault, renderDesignMd as shimRender, STYLE_GUIDE_LOGO_DIR } from '../lib/design-md.js';

const V1 = {
  projectPath: '/work/acme',
  updatedAt: '2026-05-17T00:00:00.000Z',
  colors: {
    primary: { 50: '#eff6ff', 100: '#dbeafe', 300: '#93c5fd', 500: '#2563eb', 900: '#1e3a8a' },
    secondary: { 50: '#f5f3ff', 100: '#ede9fe', 300: '#c4b5fd', 500: '#8b5cf6', 900: '#4c1d95' },
    accent: { 50: '#fefce8', 100: '#fef9c3', 300: '#fde047', 500: '#eab308', 900: '#713f12' },
    neutral: { 50: '#f8fafc', 100: '#f1f5f9', 300: '#cbd5e1', 500: '#64748b', 900: '#0f172a' },
    status: { success: '#16a34a', warning: '#f59e0b', danger: '#ef4444', info: '#0ea5e9' },
  },
  typography: {
    heading: { family: 'Sora', weights: [600, 700], scale: { h1: 48, h2: 36, h3: 28, h4: 22 } },
    body: { family: 'Inter', weights: [400, 500], size: 17, lineHeight: 1.6 },
    mono: { family: 'Fira Code', weights: [400] },
  },
  shape: { radius: { pill: 20, button: 10, card: 8, small: 6 }, spacing: [4, 8, 12, 16, 24, 32, 48, 64, 96], shadows: { sm: '0 1px 2px rgba(0,0,0,0.06)', md: '0 4px 12px rgba(0,0,0,0.10)', lg: '0 12px 32px rgba(0,0,0,0.18)' } },
  logo: { variants: [{ id: 'logo-a', name: 'Primary', file: 'logo-a.svg', bg: 'dark' }], iconLibrary: 'phosphor', imageryNotes: 'Warm and candid.' },
};

test('the defaults are a complete v2 guide: every section, 11 steps a palette, both themes, every inject class', () => {
  const d = defaultStyleGuide('/work/acme');
  assert.equal(d.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual(Object.keys(d), ['schemaVersion', 'projectPath', 'updatedAt', 'revision', 'brand', 'colors', 'typography', 'layout', 'shape', 'motion', 'iconography', 'logo', 'imagery', 'components', 'accessibility', 'rules', 'responsive', 'agents', 'exports']);
  assert.deepEqual(Object.keys(d.colors.palettes), [...CORE_PALETTES]);
  for (const palette of Object.values(d.colors.palettes)) {
    assert.deepEqual(Object.keys(palette.steps), [...PALETTE_STEPS]);
    assert.equal(palette.steps['500'], palette.base);
    assert.deepEqual(palette.steps, scaleFromBase(palette.base));
  }
  for (const theme of ['light', 'dark']) assert.deepEqual(Object.keys(d.colors.semantic[theme]), [...SEMANTIC_ROLES]);
  assert.deepEqual(d.colors.semantic.light.surface, '{neutral.50}');
  assert.deepEqual(d.colors.semantic.dark.background, '{neutral.950}');
  assert.deepEqual(d.colors.themes, { default: 'light', supports: ['light', 'dark'] });
  assert.deepEqual(Object.keys(d.typography.styles), ['display', 'h1', 'h2', 'h3', 'h4', 'body-lg', 'body', 'body-sm', 'caption', 'overline', 'button', 'code']);
  assert.deepEqual(d.typography.styles.display, { font: 'heading', size: 56, mobileSize: 36, weight: 700, lineHeight: 1.05, letterSpacing: -0.02, transform: 'none', usage: 'Hero headline' });
  assert.equal(d.typography.fonts.display, null);
  assert.deepEqual(d.layout.spacing.scale, { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, '3xl': 48, '4xl': 64 });
  assert.deepEqual(d.shape.radiusRoles, { button: 'md', card: 'lg', input: 'sm', badge: 'pill', modal: 'xl' });
  assert.deepEqual(d.agents, { inject: { ...INJECT_DEFAULTS }, instructions: '', allowProposals: true });
  assert.deepEqual([d.agents.inject.code, d.agents.inject.complex, d.agents.inject.design, d.agents.inject.image_gen, d.agents.inject.video_gen], [true, true, true, true, true]);
  assert.deepEqual([d.agents.inject.quick, d.agents.inject.review, d.agents.inject.research, d.agents.inject.browser, d.agents.inject.computer, d.agents.inject.automation, d.agents.inject.chat], [false, false, false, false, false, false, false]);
  assert.deepEqual(d.exports, { designMd: true, tokensJson: true, cssVars: true, tailwind: 'v4', outDir: '.synabun/style-guide', cssSelector: ':root', darkMode: 'attribute', projectPointers: false });
  assert.ok(d.components.length >= 1 && d.components[0].id === 'button-primary');
  assert.deepEqual(findUnknownAliases(d), [], 'every alias in the defaults resolves');
  assert.ok(Object.isFrozen(DEFAULTS) && DEFAULTS.schemaVersion === 2);
  assert.deepEqual(defaultStyleGuide('/a'), defaultStyleGuide('/a'), 'deterministic');
});

test('normalize: the defaults are a fixed point, a partial config is filled, garbage never throws', () => {
  const d = defaultStyleGuide('/work/acme');
  assert.deepEqual(normalizeStyleGuide(d), d);
  assert.deepEqual(normalizeStyleGuide({}, { projectPath: '/work/acme' }), d);
  for (const junk of [null, undefined, 'x', 42, [], { colors: 'red', typography: [], shape: 7, components: 'no', agents: null, exports: { tailwind: 'v9', darkMode: 'x', outDir: '../../etc' } }]) {
    const out = normalizeStyleGuide(junk, { projectPath: '/work/acme' });
    assert.deepEqual(out, d, JSON.stringify(junk));
  }
  const partial = normalizeStyleGuide({ schemaVersion: 2, brand: { name: 'Acme', personality: ['precise', '', 7, 'warm'] }, colors: { palettes: { primary: { base: 'rgb(225 29 72)' }, 'Brand Mint': { base: '#3dd68c' }, status: { base: '#111111' } }, semantic: { light: { link: '{primary.700}', extraRole: '#123456', bad: 'nope' } }, status: { danger: 'hsl(0 84% 60%)', notice: '#aabbcc' } }, typography: { styles: { h1: { size: '44' }, 'Lead Text': { size: 20 } } }, shape: { radius: { md: '10px' }, radiusRoles: { button: 'md', chip: 'nope' } } }, { projectPath: '/work/acme' });
  assert.equal(partial.brand.name, 'Acme');
  assert.deepEqual(partial.brand.personality, ['precise', 'warm']);
  assert.equal(partial.colors.palettes.primary.base, '#e11d48');
  assert.deepEqual(partial.colors.palettes.primary.steps, scaleFromBase('#e11d48'), 'a new base gets its own scale, not the default blue one');
  assert.deepEqual(Object.keys(partial.colors.palettes), ['primary', 'brand-mint', 'secondary', 'accent', 'neutral', 'status-palette'], 'kebab keys, a reserved name renamed, the core four always there');
  assert.equal(partial.colors.palettes['brand-mint'].label, 'Brand Mint');
  assert.equal(partial.colors.semantic.light.link, '{primary.700}');
  assert.equal(partial.colors.semantic.light.extraRole, '#123456');
  assert.equal('bad' in partial.colors.semantic.light, false);
  assert.equal(partial.colors.semantic.light.background, '#ffffff', 'missing roles take the default');
  assert.deepEqual([partial.colors.status.danger, partial.colors.status.notice, partial.colors.status.success], ['#ef4343', '#aabbcc', '#22c55e']);
  assert.deepEqual(Object.keys(partial.typography.styles), ['h1', 'lead-text', 'body'], 'a given styles map is kept as given, plus body');
  assert.equal(partial.typography.styles.h1.size, 44);
  assert.equal(partial.typography.styles.h1.weight, 700, 'a known id keeps its default fields');
  assert.deepEqual(partial.shape.radius, { md: 10 });
  assert.deepEqual(partial.shape.radiusRoles, { button: 'md', card: 'md', input: 'md', badge: 'md', modal: 'md', chip: 'md' }, 'a role always names a step that exists');
  assert.equal(normalizeStyleGuide(partial).projectPath, '/work/acme');
  assert.deepEqual(normalizeStyleGuide(partial), partial, 'normalizing twice changes nothing');
  assert.equal(normalizeStyleGuide({ projectPath: '/old' }, { projectPath: '/new' }).projectPath, '/new', 'the caller\'s path wins');
});

test('normalize: an exports.outDir stays inside the project, a strange selector falls back', () => {
  assert.equal(safeOutDir('design/tokens'), 'design/tokens');
  assert.equal(safeOutDir('./src/styles/'), 'src/styles');
  for (const bad of ['../x', '/etc', 'a/../../b', 'C:\\x', '', 'a//b', '.git/hooks', 'x;rm']) assert.equal(safeOutDir(bad), STYLE_GUIDE_OUT_DIR, bad);
  assert.equal(normalizeStyleGuide({ exports: { cssSelector: ':root, .app' } }).exports.cssSelector, ':root');
  assert.equal(normalizeStyleGuide({ exports: { cssSelector: '.theme-root' } }).exports.cssSelector, '.theme-root');
  assert.equal(normalizeStyleGuide({ exports: { cssSelector: 'body{}*' } }).exports.cssSelector, ':root');
});

test('a v1 file loads as v2: its values are kept, every other field takes its default', () => {
  const v2 = normalizeStyleGuide(V1);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v2.projectPath, '/work/acme');
  assert.equal(v2.updatedAt, '2026-05-17T00:00:00.000Z');
  // Colors: the five v1 shades are the user's, the six v1 never had follow the base.
  const primary = v2.colors.palettes.primary;
  assert.equal(primary.base, '#2563eb');
  for (const [shade, hex] of Object.entries(V1.colors.primary)) assert.equal(primary.steps[shade], hex, shade);
  const generated = scaleFromBase('#2563eb');
  for (const step of ['200', '400', '600', '700', '800', '950']) assert.equal(primary.steps[step], generated[step], step);
  assert.equal(v2.colors.palettes.neutral.steps['900'], '#0f172a');
  assert.equal(v2.colors.status.success, '#16a34a');
  // Typography.
  assert.deepEqual([v2.typography.fonts.heading.family, v2.typography.fonts.heading.weights, v2.typography.fonts.mono.family], ['Sora', [600, 700], 'Fira Code']);
  assert.deepEqual(['h1', 'h2', 'h3', 'h4'].map((id) => v2.typography.styles[id].size), [48, 36, 28, 22]);
  assert.deepEqual([v2.typography.styles.body.size, v2.typography.styles.body.lineHeight, v2.typography.scale.base], [17, 1.6, 17]);
  // Shape: the role-keyed radii stay as steps, and each role points at its own.
  assert.deepEqual(v2.shape.radius, { none: 0, pill: 20, button: 10, card: 8, small: 6 });
  assert.deepEqual(v2.shape.radiusRoles, { button: 'button', card: 'card', input: 'small', badge: 'pill', modal: 'card' });
  assert.deepEqual(Object.values(v2.layout.spacing.scale), V1.shape.spacing);
  assert.deepEqual(Object.keys(v2.layout.spacing.scale), ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl']);
  assert.equal(v2.shape.elevation.md.shadow, '0 4px 12px rgba(0,0,0,0.10)');
  // Logo and imagery.
  assert.deepEqual(v2.logo.variants, [{ id: 'logo-a', name: 'Primary', kind: 'primary', file: 'logo-a.svg', bg: 'dark' }]);
  assert.deepEqual([v2.iconography.library, v2.imagery.notes], ['phosphor', 'Warm and candid.']);
  // Everything v1 never had.
  const d = defaultStyleGuide('/work/acme');
  for (const key of ['brand', 'motion', 'accessibility', 'rules', 'responsive', 'agents', 'exports', 'components']) assert.deepEqual(v2[key], d[key], key);
  assert.deepEqual(v2.colors.semantic, d.colors.semantic);
  assert.equal(hasLegacyKeys(V1), true);
  assert.equal(hasLegacyKeys(v2), false, 'no v1 key is left');
  assert.deepEqual(normalizeStyleGuide(v2), v2);
});

test('the v1 view and mirror: the old editor reads its own shape, and only what it changed comes back', () => {
  const guide = normalizeStyleGuide(V1);
  const view = toV1View(guide);
  assert.deepEqual(view.colors.primary, V1.colors.primary);
  assert.deepEqual(view.typography.heading, V1.typography.heading);
  assert.deepEqual(view.typography.body, V1.typography.body);
  assert.deepEqual(view.shape.spacing, V1.shape.spacing);
  assert.deepEqual(view.shape.shadows, V1.shape.shadows);
  assert.deepEqual([view.logo.iconLibrary, view.logo.imageryNotes], ['phosphor', 'Warm and candid.']);
  const mirror = withV1Mirror(guide);
  assert.equal(mirror.schemaVersion, 2);
  assert.deepEqual(mirror.colors.palettes, guide.colors.palettes, 'the v2 keys are still there');
  assert.deepEqual(normalizeStyleGuide(mirror), guide, 'an untouched mirror changes nothing');
  // What the old editor does: mutate the v1 keys in place and PUT the whole object.
  mirror.colors.secondary['300'] = '#123456';
  mirror.colors.accent = { 50: '#fff7ed', 100: '#ffedd5', 300: '#fdba74', 500: '#f97316', 900: '#7c2d12' }; // its "Auto" button
  mirror.colors.status.info = '#0284c7';
  mirror.typography.body.family = 'Roboto';
  mirror.typography.heading.scale.h1 = 60;
  mirror.shape.radius.card = 14;
  mirror.shape.spacing.push(128);
  mirror.shape.shadows.md = '0 6px 16px rgba(0,0,0,0.12)';
  mirror.logo.iconLibrary = 'heroicons';
  mirror.logo.imageryNotes = 'Bright.';
  const saved = normalizeStyleGuide(mirror);
  const changed = diffConfigs(guide, saved).map((row) => row.path);
  assert.equal(saved.colors.palettes.secondary.steps['300'], '#123456');
  assert.equal(saved.colors.palettes.secondary.base, '#8b5cf6', 'another shade does not move the base');
  assert.equal(saved.colors.palettes.accent.base, '#f97316');
  assert.equal(saved.colors.palettes.accent.steps['900'], '#7c2d12');
  assert.equal(saved.colors.palettes.accent.steps['600'], scaleFromBase('#f97316')['600'], 'the steps v1 never showed follow the new base');
  assert.equal(saved.colors.status.info, '#0284c7');
  assert.equal(saved.typography.fonts.body.family, 'Roboto');
  assert.equal(saved.typography.styles.h1.size, 60);
  assert.equal(saved.shape.radius.card, 14);
  assert.equal(saved.layout.spacing.scale['6xl'], 128);
  assert.equal(saved.shape.elevation.md.shadow, '0 6px 16px rgba(0,0,0,0.12)');
  assert.deepEqual([saved.iconography.library, saved.imagery.notes], ['heroicons', 'Bright.']);
  assert.ok(changed.every((path) => /^(colors\.palettes\.(secondary|accent)|colors\.status\.info|typography\.(fonts\.body\.family|styles\.h1)|shape\.(radius\.card|elevation\.md)|layout\.spacing\.scale\.6xl|iconography\.library|imagery\.notes)/.test(path)), changed.join(', '));
  // A stale mirror never reverts a v2 edit: v1 keys equal to the view of the config they travel with are ignored.
  const edited = withV1Mirror(saved);
  edited.brand.name = 'Acme';
  edited.colors.semantic.light.link = '{primary.700}';
  const again = normalizeStyleGuide(edited);
  assert.deepEqual(diffConfigs(saved, again).map((row) => row.path), ['brand.name', 'colors.semantic.light.link']);
});

test('design-md.js is a shim over the new modules', () => {
  assert.equal(STYLE_GUIDE_LOGO_DIR, '.synabun/style-guide');
  assert.deepEqual(shimDefault('/x'), defaultStyleGuide('/x'));
  assert.match(shimRender(V1), /^---\nversion: 2\n/);
});

test('the alias resolver: every group, the theme for semantic roles, roles through their step, unknown left alone', () => {
  const config = defaultStyleGuide('/work/acme');
  assert.deepEqual(resolveAlias(config, '{primary.500}'), { ok: true, kind: 'color', value: '#3b82f6', group: 'primary', key: '500' });
  assert.equal(resolveAlias(config, 'primary.500').value, '#3b82f6', 'braces are optional');
  assert.equal(resolveAlias(config, '{status.danger}').value, '#ef4444');
  assert.deepEqual(resolveAlias(config, '{semantic.surface}'), { ok: true, kind: 'color', value: config.colors.palettes.neutral.steps['50'], group: 'semantic', key: 'surface', via: '{neutral.50}' });
  assert.equal(resolveAlias(config, '{semantic.surface}', { theme: 'dark' }).value, config.colors.palettes.neutral.steps['900']);
  assert.equal(resolveAlias(config, '{semantic.background}').value, '#ffffff');
  assert.equal(resolveAlias(config, '{typography.h1}').value.size, 40);
  assert.deepEqual([resolveAlias(config, '{spacing.md}').value, resolveAlias(config, '{radius.lg}').value], [12, 12]);
  assert.deepEqual(resolveAlias(config, '{radiusRoles.button}'), { ok: true, kind: 'dimension', value: 8, group: 'radiusRoles', key: 'button', via: 'md' });
  assert.deepEqual([resolveAlias(config, '{elevation.md}').kind, resolveAlias(config, '{elevation.md}').value], ['shadow', '0 4px 12px rgba(0,0,0,.10)']);
  assert.deepEqual([resolveAlias(config, '{duration.fast}').value, resolveAlias(config, '{easing.standard}').value], [150, 'cubic-bezier(0.2, 0, 0, 1)']);
  for (const unknown of ['{nope.500}', '{primary.555}', '{semantic.nope}', '{status.}', 'plain', '', null, '{constructor.name}', '{spacing.__proto__}']) assert.deepEqual(resolveAlias(config, unknown), { ok: false }, String(unknown));
  assert.deepEqual([isAlias('{a.b}'), isAlias('a.b'), isAlias('{a.b} x')], [true, false, false]);
  assert.deepEqual(parseAlias('{primary.500}'), { group: 'primary', key: '500' });
  assert.deepEqual([resolveColor(config, '{semantic.primary}'), resolveColor(config, 'rgb(0 0 0)'), resolveColor(config, '{spacing.md}'), resolveColor(config, 'nope')], ['#3b82f6', '#000000', null, null]);
  assert.deepEqual(resolveText(config, 'linear-gradient(135deg, {primary.500}, {zzz.1}) {spacing.md} {duration.fast} {radius.none}'), { text: 'linear-gradient(135deg, #3b82f6, {zzz.1}) 12px 150ms 0', warnings: ['{zzz.1}'] });
  // A semantic role that points at another role resolves through it; a loop does not hang.
  const chained = normalizeStyleGuide({ ...config, colors: { ...config.colors, semantic: { ...config.colors.semantic, light: { ...config.colors.semantic.light, link: '{semantic.primary}', focus: '{semantic.focus}' } } } });
  assert.equal(resolveAlias(chained, '{semantic.link}').value, '#3b82f6');
  assert.deepEqual(resolveAlias(chained, '{semantic.focus}'), { ok: false });
  assert.deepEqual(findUnknownAliases(chained).map((row) => row.path), ['colors.semantic.light.focus', 'components.0.states.focus', 'components.1.states.focus', 'components.2.states.focus', 'components.3.states.focus', 'accessibility.focusRing']);
});

test('applyMergePatch follows RFC 7396: objects merge, null deletes, arrays and scalars replace, the target is untouched', () => {
  const target = { a: 'b', c: { d: 'e', f: 'g' }, list: [1, 2] };
  assert.deepEqual(applyMergePatch(target, { a: 'z', c: { f: null } }), { a: 'z', c: { d: 'e' }, list: [1, 2] });
  assert.deepEqual(target, { a: 'b', c: { d: 'e', f: 'g' }, list: [1, 2] });
  // The RFC's own examples.
  assert.deepEqual(applyMergePatch({ a: 'b' }, { a: 'c' }), { a: 'c' });
  assert.deepEqual(applyMergePatch({ a: 'b' }, { b: 'c' }), { a: 'b', b: 'c' });
  assert.deepEqual(applyMergePatch({ a: 'b' }, { a: null }), {});
  assert.deepEqual(applyMergePatch({ a: 'b', b: 'c' }, { a: null }), { b: 'c' });
  assert.deepEqual(applyMergePatch({ a: ['b'] }, { a: 'c' }), { a: 'c' });
  assert.deepEqual(applyMergePatch({ a: 'c' }, { a: ['b'] }), { a: ['b'] });
  assert.deepEqual(applyMergePatch({ a: { b: 'c' } }, { a: { b: 'd', c: null } }), { a: { b: 'd' } });
  assert.deepEqual(applyMergePatch({ a: [{ b: 'c' }] }, { a: [1] }), { a: [1] });
  assert.deepEqual(applyMergePatch(['a', 'b'], ['c', 'd']), ['c', 'd']);
  assert.deepEqual(applyMergePatch({ a: 'b' }, ['c']), ['c']);
  assert.deepEqual(applyMergePatch({ a: 'foo' }, null), null);
  assert.deepEqual(applyMergePatch({ a: 'foo' }, 'bar'), 'bar');
  assert.deepEqual(applyMergePatch({ e: null }, { a: 1 }), { e: null, a: 1 });
  assert.deepEqual(applyMergePatch([1, 2], { a: 'b', c: null }), { a: 'b' });
  assert.deepEqual(applyMergePatch({}, { a: { bb: { ccc: null } } }), { a: { bb: {} } });
  // Never a way to the prototype.
  const polluted = applyMergePatch({}, JSON.parse('{"__proto__":{"evil":true},"constructor":{"x":1},"ok":1}'));
  assert.deepEqual(polluted, { ok: 1 });
  assert.equal({}.evil, undefined);
});

test('diffConfigs lists leaf changes with dotted paths and ignores the bookkeeping fields', () => {
  const a = defaultStyleGuide('/work/acme');
  const b = normalizeStyleGuide(applyMergePatch(a, { brand: { name: 'Acme', personality: ['warm'] }, colors: { status: { danger: '#dc2626', notice: '#aabbcc' }, palettes: { 'brand-mint': { base: '#3dd68c' } } }, shape: { radius: { xl: null } }, revision: 9, updatedAt: 'now' }));
  const diff = diffConfigs(a, b);
  const byPath = Object.fromEntries(diff.map((row) => [row.path, row]));
  assert.deepEqual(byPath['brand.name'], { path: 'brand.name', from: '', to: 'Acme' });
  assert.deepEqual(byPath['brand.personality'], { path: 'brand.personality', from: [], to: ['warm'] }, 'an array is one leaf');
  assert.deepEqual(byPath['colors.status.danger'], { path: 'colors.status.danger', from: '#ef4444', to: '#dc2626' });
  assert.deepEqual(byPath['colors.status.notice'], { path: 'colors.status.notice', from: null, to: '#aabbcc' });
  assert.deepEqual(byPath['shape.radius.xl'], { path: 'shape.radius.xl', from: 16, to: null });
  assert.equal(byPath['colors.palettes.brand-mint.base'].to, '#3dd68c', 'a new map is listed leaf by leaf');
  assert.ok(!diff.some((row) => row.path === 'revision' || row.path === 'updatedAt'));
  assert.deepEqual(diffConfigs(a, a), []);
  assert.equal(diffConfigs(a, b, { limit: 3 }).length, 3);
});

test('small helpers: token names, kebab ids and the type scale', () => {
  assert.deepEqual([tokenKey('a.b {c}'), tokenKey(' 2xl '), tokenKey('__proto__'), tokenKey('')], ['a-b-c', '2xl', '', '']);
  assert.deepEqual([kebab('Brand Mint'), kebab('onPrimary'), kebab('  --x__y  ')], ['brand-mint', 'on-primary', 'x-y']);
  assert.deepEqual(typeScale(16, 1.25), { caption: 12, 'body-sm': 14, body: 16, 'body-lg': 18, h4: 20, h3: 25, h2: 31, h1: 39, display: 49 });
});
