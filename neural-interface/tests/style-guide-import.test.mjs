// Style Guide importers (lib/style-guide/import.js): the YAML subset, DESIGN.md (ours and a community-style
// one), W3C design tokens, CSS custom properties, a Tailwind theme, the codebase scan, the community fetch,
// and merge vs replace. Nothing here touches the network: fetch is a stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaleFromBase } from '../lib/style-guide/color.js';
import { exportCss } from '../lib/style-guide/export-css.js';
import { exportDtcgText } from '../lib/style-guide/export-dtcg.js';
import { exportTailwindV4, tailwindV3Theme } from '../lib/style-guide/export-tailwind.js';
import {
  COMMUNITY_BASE_URL, COMMUNITY_SLUG_RE, IMPORT_KINDS, ImportError, buildImport, fetchCommunityDesignMd, importCssVars, importDesignMd,
  importDtcg, importTailwindTheme, markdownSections, parseCssVars, parseYamlSubset, runImport, scanCodebase, splitFontStack,
  splitFrontmatter, tailwindConfigTheme, toPx,
} from '../lib/style-guide/import.js';
import { renderDesignMd } from '../lib/style-guide/render-design-md.js';
import { applyMergePatch, defaultStyleGuide, diffConfigs, findUnknownAliases, normalizeStyleGuide } from '../lib/style-guide/schema.js';

const COMMUNITY = readFileSync(new URL('./fixtures/style-guide/community-DESIGN.md', import.meta.url), 'utf8');
const base = defaultStyleGuide('/work/acme');
const GOOGLE = new Set(['inter', 'sora', 'space grotesk', 'jetbrains mono']);
const mine = normalizeStyleGuide(applyMergePatch(base, {
  revision: 4,
  brand: { name: 'Acme', description: 'Calm software for busy teams.' },
  colors: { palettes: { primary: { base: '#e11d48', steps: scaleFromBase('#e11d48') }, 'brand-mint': { base: '#3dd68c' } }, semantic: { light: { link: '{primary.700}' } }, status: { danger: '#dc2626' } },
  typography: { fonts: { heading: { family: 'Sora' } }, styles: { h1: { size: 44 } } },
  shape: { radius: { md: 10 } },
  rules: { dos: ['Use real copy'], donts: ['Put text on gradients'], custom: '## Extra\n\nBe kind.' },
}));
const paths = (diff) => diff.map((row) => row.path);

test('the YAML subset: maps, nested maps, lists, flow collections, quoted and plain scalars, block text, comments', () => {
  const data = parseYamlSubset([
    '# a comment',
    'version: 2',
    'name: "Quoted: with a colon # and a hash"',
    "single: 'it''s'",
    'plain: some words here   # trailing comment',
    'hex: #3b82f6',
    'quotedHex: "#fff"',
    'ratio: 1.25',
    'negative: -0.02',
    'size: 16px',
    'yes: true',
    'nothing: null',
    'empty:',
    'url: https://example.com/a#b',
    'colors:',
    '  primary-500: "#3b82f6"',
    '  nested:',
    '    deep: 1',
    '    2xl: 32px',
    'list:',
    '  - a',
    '  - "b c"',
    '  - 3',
    'maps:',
    '  - name: one',
    '    value: 1',
    '  - name: two',
    'flow: [a, "b, c", 3]',
    'inline: { k: v, n: 2 }',
    'text: |',
    '  line one',
    '    indented',
    'folded: >',
    '  one',
    '  two',
    '"quoted key": ok',
    '\ttabbed: no',
  ].join('\n').replace('\ttabbed: no', 'last: end'));
  assert.deepEqual(data, {
    version: 2, name: 'Quoted: with a colon # and a hash', single: "it's", plain: 'some words here', hex: '#3b82f6', quotedHex: '#fff', ratio: 1.25,
    negative: -0.02, size: '16px', yes: true, nothing: null, empty: null, url: 'https://example.com/a#b',
    colors: { 'primary-500': '#3b82f6', nested: { deep: 1, '2xl': '32px' } },
    list: ['a', 'b c', 3], maps: [{ name: 'one', value: 1 }, { name: 'two' }], flow: ['a', 'b, c', 3], inline: { k: 'v', n: 2 },
    text: 'line one\n  indented', folded: 'one two', 'quoted key': 'ok', last: 'end',
  });
  assert.deepEqual(parseYamlSubset(''), {});
  assert.deepEqual(parseYamlSubset('a: 1\r\nb:\r\n  c: 2\r\n'), { a: 1, b: { c: 2 } }, 'CRLF');
  assert.deepEqual(parseYamlSubset('__proto__:\n  x: 1\nok: 1'), { ok: 1 });
  assert.throws(() => parseYamlSubset('a: 1\n    b: 2\n  c: 3'), (error) => error instanceof ImportError && error.code === 'BAD_YAML');
  assert.throws(() => parseYamlSubset('just some words'), /Cannot read line 1/);
  const split = splitFrontmatter('---\nname: X\n---\n# Body\n');
  assert.deepEqual([split.hasFrontmatter, split.data, split.body], [true, { name: 'X' }, '# Body\n']);
  assert.deepEqual(splitFrontmatter('# No frontmatter\n---\nx\n').hasFrontmatter, false);
});

test('a community-style DESIGN.md: the frontmatter tokens land in the guide, the prose lands beside them', async () => {
  const { config, warnings, diff } = await runImport({ kind: 'design-md', text: COMMUNITY, base, merge: 'replace', deps: { googleFonts: GOOGLE } });
  assert.deepEqual(warnings, []);
  assert.ok(diff.length > 20);
  assert.deepEqual([config.brand.name, config.brand.description], ['Nimbus', 'A calm, dense dashboard for cloud operators.']);
  // colors: flat names → palette bases, semantic roles of the theme the background implies, statuses, an extra palette.
  assert.deepEqual(Object.keys(config.colors.palettes), ['primary', 'secondary', 'accent', 'neutral', 'brand-mint']);
  assert.deepEqual([config.colors.palettes.primary.base, config.colors.palettes.secondary.base, config.colors.palettes['brand-mint'].base], ['#5b5bd6', '#00a2c7', '#3dd68c']);
  assert.deepEqual(config.colors.palettes.primary.steps, scaleFromBase('#5b5bd6'));
  assert.deepEqual(config.colors.themes, { default: 'dark', supports: ['dark'] }, 'a dark background makes it a dark-only guide');
  const dark = config.colors.semantic.dark;
  assert.deepEqual([dark.background, dark.surface, dark.text, dark.textMuted, dark.border, dark.onPrimary, dark.primary], ['#0b0d12', '#151821', '#e6e8ee', '#9aa3b2', '#2a2f3a', '#ffffff', '{primary.500}']);
  assert.deepEqual([config.colors.status.danger, config.colors.status.success], ['#e5484d', '#3dd68c']);
  // typography: sizes in px whatever the unit, line height unitless, letter spacing in em, fonts by role.
  const styles = config.typography.styles;
  assert.deepEqual(Object.keys(styles), ['display-lg', 'headline-md', 'body-md', 'label-sm', 'code-sm', 'body']);
  assert.deepEqual(styles['display-lg'], { font: 'heading', size: 56, mobileSize: 56, weight: 600, lineHeight: 1.1, letterSpacing: -0.02, transform: 'none', usage: '' });
  assert.deepEqual([styles['headline-md'].lineHeight, styles['headline-md'].letterSpacing], [1.286, -0.01]);
  assert.deepEqual([styles['body-md'].lineHeight, styles['label-sm'].weight, styles['label-sm'].letterSpacing, styles['code-sm'].font], [1.5, 500, 0.04, 'mono']);
  const fonts = config.typography.fonts;
  assert.deepEqual([fonts.heading.family, fonts.body.family, fonts.mono.family, fonts.display], ['Geist', 'Inter', 'Geist Mono', null]);
  assert.deepEqual([fonts.heading.source, fonts.body.source, fonts.body.fallback, fonts.heading.weights, fonts.mono.features], ['other', 'google', 'system-ui, sans-serif', [600], '"zero" 1']);
  // rounded, spacing.
  assert.deepEqual(config.shape.radius, { sm: 4, md: 8, lg: 12, pill: 9999 });
  assert.deepEqual(config.shape.radiusRoles, { button: 'md', card: 'lg', input: 'sm', badge: 'pill', modal: 'lg' });
  assert.deepEqual(config.layout.spacing.scale, { xs: 4, sm: 8, md: 16, lg: 24 });
  // components: property names and aliases translated to ours, a nested state kept as text.
  assert.deepEqual(config.components.map((c) => [c.id, c.category]), [['button-primary', 'button'], ['card-metric', 'card'], ['tag-status', 'feedback']]);
  assert.deepEqual(config.components[0].tokens, { background: '{semantic.primary}', text: '{semantic.onPrimary}', typography: '{typography.label-sm}', radius: '{radius.pill}', padding: '12px 20px' });
  assert.equal(config.components[0].states.hover, 'background {semantic.secondary}');
  assert.deepEqual(config.components[1].tokens, { background: '{semantic.surface}', text: '{semantic.text}', radius: '{radius.lg}', padding: '{spacing.md}' });
  assert.equal(config.components[2].tokens.background, '{brand-mint.500}');
  assert.deepEqual(findUnknownAliases(config), [], 'every imported alias resolves');
  // prose.
  assert.equal(config.brand.vibe, 'A calm, dense dashboard for cloud operators. Dark first, with hairline borders and one violet accent.\n\nIt should feel like an instrument panel, not a marketing site.');
  assert.deepEqual(config.brand.keyCharacteristics, ['Dark surfaces one step apart in lightness', 'Hairline borders instead of shadows', 'Violet for action, mint for healthy state']);
  assert.deepEqual(config.typography.principles, ['Numbers are tabular', 'Headlines are set tight']);
  assert.deepEqual(config.layout.principles, ['Density over decoration: 8px rhythm, no empty hero areas.']);
  assert.deepEqual(config.rules.dos, ['Keep density high', 'Use mint only for healthy state']);
  assert.deepEqual(config.rules.donts, ['Use drop shadows', 'Mix more than two accents on a screen']);
  assert.deepEqual(config.responsive.notes, ['Breakpoints: 640px: single column', 'Breakpoints: 1024px: sidebar appears']);
  assert.equal(config.rules.custom, '## Iteration Guide\n\n1. Start from the tokens in the frontmatter.\n2. Change one variable at a time.');
  // What an import never touches.
  assert.deepEqual([config.projectPath, config.agents, config.exports], [base.projectPath, base.agents, base.exports]);
  // The imported guide renders, and what it renders imports back to itself.
  const again = await runImport({ kind: 'design-md', text: renderDesignMd(config), base: config, merge: 'merge', deps: { googleFonts: GOOGLE } });
  assert.deepEqual(again.diff, []);
});

test('DESIGN.md imports only defined font roles; merge keeps missing roles and replace defaults them', async () => {
  const stored = normalizeStyleGuide(applyMergePatch(base, {
    typography: { fonts: { heading: { family: 'Manrope' }, body: { family: 'Inter' } } },
  }));
  const document = (styles) => `---\ntypography:\n${styles}\n---\n`;
  const text = document('  body-md:\n    fontFamily: Source Sans 3\n    fontSize: 16px');
  const patch = importDesignMd(text).patch;
  assert.deepEqual(Object.keys(patch.typography.fonts), ['body'], 'the importer must not synthesize a heading role');
  const merged = await runImport({ kind: 'design-md', text, base: stored, merge: 'merge' });
  assert.deepEqual(merged.config.typography.fonts.heading, stored.typography.fonts.heading);
  assert.equal(merged.config.typography.fonts.body.family, 'Source Sans 3');
  assert.ok(!paths(merged.diff).some((path) => path.startsWith('typography.fonts.heading')));
  const replaced = await runImport({ kind: 'design-md', text, base: stored, merge: 'replace' });
  assert.deepEqual(replaced.config.typography.fonts.heading, defaultStyleGuide(stored.projectPath).typography.fonts.heading);
  assert.equal(replaced.config.typography.fonts.body.family, 'Source Sans 3');
  // The converse also stays partial, while an explicitly shared family defines both roles.
  const headingOnly = await runImport({ kind: 'design-md', text: document('  h1:\n    fontFamily: Source Sans 3\n    fontSize: 40px'), base: stored, merge: 'merge' });
  assert.deepEqual(headingOnly.config.typography.fonts.body, stored.typography.fonts.body);
  assert.equal(headingOnly.config.typography.fonts.heading.family, 'Source Sans 3');
  const shared = await runImport({ kind: 'design-md', text: document('  h1:\n    fontFamily: Source Sans 3\n    fontSize: 40px\n  body:\n    fontFamily: Source Sans 3\n    fontSize: 16px'), base: stored, merge: 'merge' });
  assert.deepEqual([shared.config.typography.fonts.heading.family, shared.config.typography.fonts.body.family], ['Source Sans 3', 'Source Sans 3']);
  assert.deepEqual([shared.config.typography.styles.h1.font, shared.config.typography.styles.body.font], ['heading', 'body']);
});

test('our own DESIGN.md round-trips its tokens: replace over the defaults gives the guide back, merge onto itself is a no-op', async () => {
  const text = renderDesignMd(mine);
  const replaced = await runImport({ kind: 'design-md', text, base, merge: 'replace', deps: { googleFonts: GOOGLE } });
  assert.deepEqual(replaced.warnings, []);
  const out = replaced.config;
  assert.deepEqual(out.colors, mine.colors, 'palettes, semantic roles (aliases restored), statuses, gradients, themes');
  assert.deepEqual(out.shape.radius, mine.shape.radius);
  assert.deepEqual(out.layout.spacing.scale, mine.layout.spacing.scale);
  assert.deepEqual(out.brand, mine.brand);
  assert.deepEqual(out.rules, mine.rules, 'the custom section keeps its own headings');
  for (const [id, style] of Object.entries(mine.typography.styles)) {
    const { mobileSize: _a, usage: _u, ...want } = style;
    const { mobileSize: _b, usage: _v, ...got } = out.typography.styles[id];
    assert.deepEqual(got, want, id);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(out.typography.fonts).map(([k, f]) => [k, f && f.family])), { heading: 'Sora', body: 'Inter', mono: 'JetBrains Mono', display: null });
  assert.deepEqual(out.components.map((c) => c.id), mine.components.map((c) => c.id));
  // The frontmatter carries no mobile size, weights list or component states: those are what a replace loses.
  assert.ok(paths(diffConfigs(mine, out)).every((path) => /^(typography\.(fonts\.\w+\.weights|styles\.[\w-]+\.(mobileSize|usage))|components|revision)/.test(path)), paths(diffConfigs(mine, out)).join(', '));
  const merged = await runImport({ kind: 'design-md', text, base: mine, merge: 'merge', deps: { googleFonts: GOOGLE } });
  assert.deepEqual(merged.diff, []);
});

test('DTCG: our tokens.json round-trips exactly (aliases, shadows as written, mobile sizes); a plain file imports too', async () => {
  const text = exportDtcgText(mine);
  const merged = await runImport({ kind: 'dtcg', text, base: mine, merge: 'merge', deps: { googleFonts: GOOGLE } });
  assert.deepEqual([merged.diff, merged.warnings], [[], []]);
  const replaced = await runImport({ kind: 'dtcg', text, base, merge: 'replace', deps: { googleFonts: GOOGLE } });
  assert.deepEqual(paths(diffConfigs(mine, replaced.config)), ['brand.name', 'brand.description', 'rules.dos', 'rules.donts', 'rules.custom'], 'everything a tokens file can carry came back');
  assert.equal(replaced.config.colors.semantic.light.link, '{primary.700}');
  assert.equal(replaced.config.typography.styles.h1.mobileSize, mine.typography.styles.h1.mobileSize);
  // Somebody else's file: group-inherited types, rem dimensions, hex strings, an alias chain.
  const foreign = importDtcg({
    color: { $type: 'color', brand: { 500: { $value: '#ff5500' }, 600: { $value: { colorSpace: 'srgb', components: [0.8, 0.2, 0], alpha: 1 } } }, primary: { $value: '{color.brand.500}' }, danger: { $value: '#aa0000' } },
    spacing: { $type: 'dimension', sm: { $value: { value: 0.5, unit: 'rem' } }, md: { $value: '16px' } },
    radius: { card: { $type: 'dimension', $value: { value: 12, unit: 'px' } } },
    shadow: { soft: { $type: 'shadow', $value: { color: '#00000033', offsetX: { value: 0, unit: 'px' }, offsetY: { value: 2, unit: 'px' }, blur: { value: 8, unit: 'px' }, spread: { value: 0, unit: 'px' } }, $description: 'Cards' } },
    duration: { quick: { $type: 'duration', $value: { value: 0.1, unit: 's' } } },
    cubicBezier: { snap: { $type: 'cubicBezier', $value: [0.1, 0.9, 0.2, 1] } },
    fontFamily: { $type: 'fontFamily', mono: { $value: ['Fira Code', 'monospace'] } },
    broken: { $type: 'color', $value: '{nowhere.x}' },
  });
  assert.deepEqual(foreign.warnings, ['broken: alias {nowhere.x} names no token']);
  assert.deepEqual([foreign.patch.colors.palettes.brand.base, foreign.patch.colors.palettes.brand.steps['600'], foreign.patch.colors.palettes.primary.base, foreign.patch.colors.status.danger], ['#ff5500', '#cc3300', '#ff5500', '#aa0000']);
  assert.deepEqual(foreign.patch.layout.spacing.scale, { sm: 8, md: 16 });
  assert.deepEqual(foreign.patch.shape, { radius: { card: 12 }, elevation: { soft: { shadow: '0 2px 8px 0 #00000033', usage: 'Cards' } } });
  assert.deepEqual(foreign.patch.motion, { durations: { quick: 100 }, easings: { snap: 'cubic-bezier(0.1, 0.9, 0.2, 1)' } });
  assert.equal(foreign.patch.typography.fonts.mono.family, 'Fira Code');
  assert.throws(() => importDtcg('{nope'), (error) => error.code === 'BAD_JSON');
  assert.throws(() => importDtcg('[1]'), (error) => error.code === 'BAD_JSON');
  assert.deepEqual(importDtcg({}).warnings, ['No tokens found: a token is an object with a $value.']);
});

test('CSS custom properties: our tokens.css and our Tailwind v4 theme round-trip; shadcn-style variables map to roles', async () => {
  for (const text of [exportCss(mine), exportTailwindV4(mine)]) {
    const merged = await runImport({ kind: 'css', text, base: mine, merge: 'merge', deps: { googleFonts: GOOGLE } });
    assert.deepEqual([merged.diff, merged.warnings], [[], []]);
  }
  const replaced = await runImport({ kind: 'css', text: exportCss(mine), base, merge: 'replace', deps: { googleFonts: GOOGLE } });
  assert.deepEqual(replaced.config.colors.palettes, mine.colors.palettes);
  assert.deepEqual(replaced.config.colors.semantic, mine.colors.semantic, 'var() references come back as aliases, the dark block as the dark theme');
  assert.deepEqual(replaced.config.typography, mine.typography);
  assert.deepEqual([replaced.config.layout, replaced.config.motion, replaced.config.shape.radius, replaced.config.shape.radiusRoles], [mine.layout, mine.motion, mine.shape.radius, mine.shape.radiusRoles]);
  assert.equal(replaced.config.motion.durations.fast, 150, 'the reduced-motion block does not zero the token');
  // shadcn: bare HSL triples under :root and .dark.
  const shadcn = importCssVars(':root{--background: 0 0% 100%; --foreground: 222.2 84% 4.9%; --primary: 221 83% 53%; --primary-foreground: 210 40% 98%; --muted: 210 40% 96%; --muted-foreground: 215 16% 47%; --border: 214 32% 91%; --ring: 221 83% 53%; --destructive: 0 84% 60%; --radius: 0.5rem; --font-sans: "Geist", system-ui;}\n.dark{--background: 222 84% 5%; --foreground: 210 40% 98%; --primary: 217 91% 60%;}\n/* --ignored: red; */');
  assert.deepEqual(shadcn.warnings, []);
  assert.equal(shadcn.patch.colors.palettes.primary.base, '#2463eb');
  assert.deepEqual(shadcn.patch.colors.semantic.light, { background: '#ffffff', text: '#020817', onPrimary: '#f8fafc', surface: '#f1f5f9', textMuted: '#65758b', border: '#e1e7ef', focus: '#2463eb' });
  assert.deepEqual(shadcn.patch.colors.semantic.dark, { background: '#020817', text: '#f8fafc', primary: '#3c83f6' });
  assert.equal(shadcn.patch.colors.status.danger, '#ef4343');
  assert.deepEqual(shadcn.patch.shape.radius, { md: 8 });
  assert.deepEqual(shadcn.patch.typography.fonts.body, { family: 'Geist', fallback: 'system-ui' });
  // A root that declares itself dark is the dark theme.
  const darkRoot = importCssVars(':root { color-scheme: dark; --color-background: #0b0d12; --color-text: #e6e8ee; }');
  assert.deepEqual(darkRoot.patch.colors, { semantic: { dark: { background: '#0b0d12', text: '#e6e8ee' } }, themes: { default: 'dark', supports: ['dark'] } });
  assert.deepEqual(parseCssVars('@media (prefers-color-scheme: dark) { :root { --a: 1; } } [data-theme="light"] { --b: 2 } :root { --c: 3; $d: 4; }').map((v) => [v.name, v.value, v.scope]), [['--a', '1', 'dark'], ['--b', '2', 'light'], ['--c', '3', 'root'], ['--d', '4', 'root']]);
  assert.deepEqual(importCssVars('body { color: red }').warnings, ['No CSS custom properties found.']);
});

test('Tailwind theme JSON: our v3 theme round-trips; a hand-written theme maps colors, fonts, sizes, radii and shadows', async () => {
  const text = JSON.stringify({ theme: { extend: tailwindV3Theme(mine) } });
  const merged = await runImport({ kind: 'tailwind-json', text, base: mine, merge: 'merge', deps: { googleFonts: GOOGLE } });
  assert.deepEqual([merged.diff, merged.warnings], [[], []]);
  const hand = importTailwindTheme({ theme: { colors: { brand: { 100: '#ffe4e6', 500: '#f43f5e', 900: '#881337' }, ink: '#111827', background: '#fafafa', primary: { DEFAULT: '#0ea5e9' } }, extend: { fontFamily: { sans: ['Inter', 'system-ui'], display: 'Fraunces, serif', mono: ['Fira Code'] }, fontSize: { lg: ['18px', '28px'], hero: ['4rem', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '800' }] }, borderRadius: { DEFAULT: '6px', lg: '0.75rem', button: '0.75rem' }, boxShadow: { card: '0 1px 3px rgba(0,0,0,.1)' }, screens: { tablet: '768px' }, transitionDuration: { 200: '200ms', slow: '0.5s' } } } });
  assert.deepEqual(hand.warnings, []);
  assert.deepEqual(Object.keys(hand.patch.colors.palettes), ['brand', 'primary'], '`brand` stays its own palette when the file has a `primary` too');
  assert.deepEqual([hand.patch.colors.palettes.brand.base, hand.patch.colors.palettes.brand.steps['100'], hand.patch.colors.palettes.primary.base], ['#f43f5e', '#ffe4e6', '#0ea5e9']);
  assert.deepEqual(hand.patch.colors.semantic.light, { text: '#111827', background: '#fafafa' }, '`ink` is a name for the text color');
  assert.equal(importTailwindTheme({ colors: { brand: '#f43f5e', gray: { 500: '#737373' } } }).patch.colors.palettes.primary.base, '#f43f5e', 'alone, `brand` is the primary and `gray` the neutral');
  assert.deepEqual(Object.fromEntries(Object.entries(hand.patch.typography.fonts).map(([k, f]) => [k, f.family])), { body: 'Inter', display: 'Fraunces', mono: 'Fira Code' });
  assert.deepEqual([hand.patch.typography.styles.lg.size, hand.patch.typography.styles.lg.lineHeight, hand.patch.typography.styles.hero], [18, 1.556, { size: 64, weight: 800, lineHeight: 1, letterSpacing: -0.03, font: 'heading' }]);
  assert.deepEqual([hand.patch.shape.radius, hand.patch.shape.radiusRoles], [{ lg: 12 }, { button: 'lg' }]);
  assert.deepEqual([hand.patch.shape.elevation, hand.patch.layout.breakpoints, hand.patch.motion.durations], [{ card: { shadow: '0 1px 3px rgba(0,0,0,.1)' } }, { tablet: 768 }, { d200: 200, slow: 500 }]);
  assert.throws(() => importTailwindTheme('nope'), (error) => error.code === 'BAD_JSON');
  assert.match(importTailwindTheme({}).warnings[0], /No theme values found/);
});

test('merge keeps what the import does not mention; replace starts from the defaults but keeps the project\'s own settings', () => {
  const current = normalizeStyleGuide(applyMergePatch(base, {
    revision: 9, brand: { name: 'Acme', tagline: 'Keep me' }, rules: { dos: ['Keep me too'] },
    logo: { variants: [{ id: 'logo-a', name: 'A', kind: 'primary', file: 'logo-a.svg', bg: 'white' }] },
    agents: { instructions: 'Ask first.', inject: { review: true } }, exports: { tailwind: 'v3', projectPointers: true },
    typography: { styles: { quote: { size: 22 } } }, shape: { radius: { huge: 40 } },
  }));
  const patch = { brand: { name: 'Nimbus' }, shape: { radius: { sm: 2, md: 6 } }, typography: { styles: { hero: { size: 80 } } }, components: [{ id: 'chip', name: 'Chip', tokens: { radius: '{radius.sm}' } }, { id: 'card', tokens: { padding: '{spacing.lg}' } }] };
  const merged = buildImport(current, patch, { merge: 'merge' });
  assert.deepEqual([merged.config.brand.name, merged.config.brand.tagline, merged.config.rules.dos], ['Nimbus', 'Keep me', ['Keep me too']]);
  assert.deepEqual(merged.config.shape.radius, { ...current.shape.radius, sm: 2, md: 6 }, 'a map merges key by key');
  assert.ok('quote' in merged.config.typography.styles && 'hero' in merged.config.typography.styles && 'h1' in merged.config.typography.styles);
  assert.deepEqual(merged.config.components.map((c) => c.id), ['button-primary', 'button-secondary', 'input-text', 'card', 'chip'], 'components merge by id');
  assert.equal(merged.config.components[3].tokens.padding, '{spacing.lg}');
  assert.equal(merged.config.components[3].states.focus, current.components[3].states.focus, 'the states of a component the import names are kept');
  assert.deepEqual(paths(merged.diff).filter((path) => !/^(brand\.name|shape\.radius\.(sm|md)|typography\.styles\.hero|components)/.test(path)), []);

  const replaced = buildImport(current, patch, { merge: 'replace' });
  assert.deepEqual([replaced.config.brand.name, replaced.config.brand.tagline, replaced.config.rules.dos], ['Nimbus', '', []]);
  assert.deepEqual(replaced.config.shape.radius, { sm: 2, md: 6 }, 'an imported map replaces the defaults\' map');
  assert.deepEqual(Object.keys(replaced.config.typography.styles), ['hero', 'body']);
  assert.deepEqual(replaced.config.components.map((c) => c.id), ['chip', 'card']);
  assert.deepEqual(replaced.config.layout.spacing.scale, base.layout.spacing.scale, 'a map the import does not carry is the default one');
  assert.deepEqual([replaced.config.revision, replaced.config.logo, replaced.config.agents, replaced.config.exports, replaced.config.projectPath], [9, current.logo, current.agents, current.exports, current.projectPath]);
  // An empty import changes nothing in merge mode.
  assert.deepEqual(buildImport(current, {}, { merge: 'merge' }).diff, []);
});

test('the codebase scan reads stylesheets, a Tailwind config and a hand-written DESIGN.md, and skips what it must', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-sg-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  write('src/styles/tokens.css', ':root { --color-primary-500: #7c3aed; --color-background: #fafafa; --radius-md: 10px; --font-heading: "Sora", sans-serif; }\n.dark { --color-background: #0a0a0a; }');
  write('src/styles/_vars.scss', '$danger: #b91c1c;\n$spacing-md: 16px;\n.btn { color: $danger; }');
  write('tailwind.config.js', "/** @type {import('tailwindcss').Config} */\nmodule.exports = {\n  content: ['./src/**/*.tsx'],\n  theme: {\n    extend: {\n      colors: {\n        accent: { 500: '#f59e0b' }, // amber\n        ocean: '#0ea5e9',\n      },\n      fontFamily: { mono: ['Fira Code', 'monospace'] },\n      borderRadius: { xl: '1rem' },\n    },\n  },\n};\n");
  write('DESIGN.md', '---\nname: Handmade\ncolors:\n  secondary: "#16a34a"\n---\n# Handmade\n\n## Do\'s and Don\'ts\n\n### Do\n\n- Be plain\n');
  write('node_modules/pkg/styles.css', ':root { --color-primary-500: #000000; }');
  write('dist/app.css', ':root { --color-primary-500: #111111; }');
  write('build/app.css', ':root { --color-primary-500: #222222; }');
  write('.git/x.css', ':root { --color-primary-500: #333333; }');
  write('.synabun/style-guide/tokens.css', ':root { --color-primary-500: #444444; }');
  write('public/vendor.min.css', ':root{--color-primary-500:#555555}');
  write('docs/DESIGN.md', '---\ncolors:\n  primary: "#666666"\n---\n');
  write('src/plain.css', 'body { margin: 0 }');
  const scan = scanCodebase(root, { googleFonts: GOOGLE });
  assert.deepEqual(scan.files, ['DESIGN.md', 'tailwind.config.js', 'src/styles/_vars.scss', 'src/styles/tokens.css']);
  assert.deepEqual(scan.warnings, []);
  assert.equal(scan.patch.brand.name, 'Handmade');
  assert.deepEqual(scan.patch.rules.dos, ['Be plain']);
  const palettes = scan.patch.colors.palettes;
  assert.deepEqual([palettes.primary.base, palettes.secondary.base, palettes.accent.base, palettes.ocean.base], ['#7c3aed', '#16a34a', '#f59e0b', '#0ea5e9']);
  assert.deepEqual([scan.patch.colors.semantic.light.background, scan.patch.colors.semantic.dark.background, scan.patch.colors.status.danger], ['#fafafa', '#0a0a0a', '#b91c1c']);
  assert.deepEqual([scan.patch.shape.radius, scan.patch.layout.spacing.scale], [{ xl: 16, md: 10 }, { md: 16 }]);
  assert.deepEqual([scan.patch.typography.fonts.heading.family, scan.patch.typography.fonts.heading.source, scan.patch.typography.fonts.mono.family], ['Sora', 'google', 'Fira Code']);
  // Our own generated DESIGN.md is not a source, and the cap is reported.
  write('DESIGN.md', renderDesignMd(base));
  assert.ok(!scanCodebase(root).files.includes('DESIGN.md'));
  const capped = scanCodebase(root, { maxFiles: 2 });
  assert.match(capped.warnings[0], /^Stopped after 2 files/);
  assert.equal(capped.scanned, 2);
  const empty = mkdtempSync(join(tmpdir(), 'synabun-sg-empty-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.match(scanCodebase(empty).warnings[0], /^No design tokens found/);
  assert.deepEqual(tailwindConfigTheme("export default { theme: { colors: { a: '#fff', 'b-c': \"#000\", }, screens: { md: '768px' } } }"), { colors: { a: '#fff', 'b-c': '#000' }, screens: { md: '768px' } });
});

test('the community fetch: the slug whitelist, the URL, the timeout, and what the server answers', async () => {
  for (const ok of ['linear.app', 'stripe', 'a-b.c', 'x'.repeat(40)]) assert.ok(COMMUNITY_SLUG_RE.test(ok), ok);
  let calls = 0;
  const fetchImpl = async (url, options) => { calls++; return { ok: true, status: 200, text: async () => `${url}|${options.redirect}|${!!options.signal}` }; };
  for (const bad of ['', '../etc', 'a/b', 'x'.repeat(41), 'a b', 'a%2f', '.hidden', 'trailing.', 'a..b', 'https://evil', 'a\nb', 'a_b']) {
    await assert.rejects(fetchCommunityDesignMd(bad, { fetchImpl }), (error) => error instanceof ImportError && error.code === 'BAD_SLUG' && error.status === 400, bad);
  }
  assert.equal(calls, 0, 'a refused slug never reaches the network');
  const got = await fetchCommunityDesignMd(' Linear.App ', { fetchImpl });
  assert.deepEqual(got, { text: `${COMMUNITY_BASE_URL}/linear.app/DESIGN.md|error|true`, url: 'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/linear.app/DESIGN.md', slug: 'linear.app' });
  await assert.rejects(fetchCommunityDesignMd('nope', { fetchImpl: async () => ({ ok: false, status: 404 }) }), (error) => error.code === 'NOT_FOUND' && error.status === 404);
  await assert.rejects(fetchCommunityDesignMd('nope', { fetchImpl: async () => ({ ok: false, status: 500 }) }), (error) => error.code === 'FETCH_FAILED' && error.status === 502);
  await assert.rejects(fetchCommunityDesignMd('nope', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }), (error) => error.code === 'FETCH_FAILED');
  await assert.rejects(fetchCommunityDesignMd('big', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(64) }), maxBytes: 32 }), (error) => error.code === 'TOO_LARGE');
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(fetchCommunityDesignMd('slow', { fetchImpl: hang, timeoutMs: 20 }), (error) => error.code === 'TIMEOUT' && error.status === 504);
  // Through runImport: the attribution leads the warnings and the source is named.
  const result = await runImport({ kind: 'community', slug: 'nimbus', base, merge: 'replace', deps: { fetchImpl: async () => ({ ok: true, status: 200, text: async () => COMMUNITY }) } });
  assert.match(result.warnings[0], /community collection github\.com\/VoltAgent\/awesome-design-md/);
  assert.equal(result.source, `${COMMUNITY_BASE_URL}/nimbus/DESIGN.md`);
  assert.equal(result.config.brand.name, 'Nimbus');
});

test('runImport refuses what it cannot do, and the small readers read what they should', async () => {
  assert.deepEqual([...IMPORT_KINDS], ['design-md', 'dtcg', 'css', 'tailwind-json', 'codebase', 'community']);
  await assert.rejects(runImport({ kind: 'figma', text: 'x', base }), (error) => error.code === 'BAD_KIND');
  await assert.rejects(runImport({ kind: 'css', text: 'x', base, merge: 'overwrite' }), (error) => error.code === 'BAD_MERGE');
  await assert.rejects(runImport({ kind: 'css', text: '   ', base }), (error) => error.code === 'NO_TEXT');
  await assert.rejects(runImport({ kind: 'codebase', base }), (error) => error.code === 'NO_PROJECT');
  await assert.rejects(runImport({ kind: 'css', text: 'x'.repeat(2 * 1024 * 1024 + 1), base }), (error) => error.code === 'TOO_LARGE' && error.status === 413);
  const noFrontmatter = importDesignMd('# Just prose\n\n## Do\'s and Don\'ts\n\n- Do: be clear\n- Don\'t: be vague\n');
  assert.deepEqual(noFrontmatter, { patch: { rules: { dos: ['be clear'], donts: ['be vague'] } }, warnings: ['No YAML frontmatter: tokens were not imported, only the prose.'] });
  const badYaml = importDesignMd('---\ncolors:\n      bad\n  worse: 1\n---\n## Overview\n\nStill read.\n');
  assert.match(badYaml.warnings[0], /^The frontmatter could not be read/);
  assert.equal(badYaml.patch.brand.vibe, 'Still read.');
  assert.deepEqual([toPx('24px'), toPx('1.5rem'), toPx(12), toPx('full'), toPx('50%'), toPx('12pt')], [24, 24, 12, 9999, null, 16]);
  assert.deepEqual(splitFontStack('"Space Grotesk", system-ui, sans-serif'), { family: 'Space Grotesk', fallback: 'system-ui, sans-serif' });
  assert.deepEqual(markdownSections('## A\none\n### B\ntwo\n```\n## not a heading\n```\n## C\n').map((s) => [s.title, s.subs.map((x) => x.title)]), [['A', ['B']], ['C', []]]);
});
