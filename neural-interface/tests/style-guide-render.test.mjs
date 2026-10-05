// DESIGN.md renderer (lib/style-guide/render-design-md.js): the Stitch shape (frontmatter + sections in the
// spec's order), what each section carries, and byte-for-byte determinism.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter } from '../lib/style-guide/import.js';
import { frontmatterAlias, guideName, renderDesignMd } from '../lib/style-guide/render-design-md.js';
import { applyMergePatch, defaultStyleGuide, normalizeStyleGuide } from '../lib/style-guide/schema.js';

const base = defaultStyleGuide('/work/acme');
const rich = normalizeStyleGuide(applyMergePatch(base, {
  revision: 7,
  brand: { name: 'Acme', tagline: 'Tools that stay out of the way', description: 'Acme makes calm software for busy teams.', audience: 'Operations teams', personality: ['precise', 'warm'], vibe: 'Quiet and exact.', keyCharacteristics: ['One accent per screen', 'Hairline borders'], voice: { tone: 'Plain and direct.', dos: ['Say what happens next'], donts: ['Use jargon'] } },
  colors: { gradients: [{ name: 'hero', css: 'linear-gradient(135deg, {primary.500}, {secondary.500})', usage: 'Hero' }] },
  typography: { principles: ['Lines run 45 to 75 characters'] },
  layout: { principles: ['Whitespace groups, borders separate'] },
  motion: { principles: ['Motion explains a change'] },
  logo: { variants: [{ id: 'logo-main', name: 'Main', kind: 'primary', file: 'logo-main.svg', bg: 'white' }], clearSpace: 'The height of the mark on every side', minSize: { px: 32 }, donts: ['Stretch the mark'], favicon: 'favicon.svg' },
  imagery: { style: 'illustration', mood: 'Soft, geometric', notes: 'Flat color, no gradients.', dos: ['Use the brand blue'], donts: ['Use stock photos'], generation: { promptPrefix: 'Flat geometric illustration, soft blue', negativePrompt: 'photorealism', aspectRatios: ['16:9'], styleReferences: ['.synabun/style-guide/ref-1.png'] } },
  accessibility: { notes: ['Never color alone'] },
  rules: { dos: ['Use real copy'], donts: ['Put text on gradients'], custom: 'Marketing pages may use the hero gradient once.' },
  responsive: { notes: ['The sidebar collapses below lg'] },
  agents: { instructions: 'Ask before adding a new palette.' },
}));

test('the frontmatter is the Stitch shape: version, name, description, then colors, typography, rounded, spacing, components', () => {
  const md = renderDesignMd(rich);
  assert.ok(md.startsWith('---\nversion: 2\nname: "Acme"\ndescription: "Acme makes calm software for busy teams."\ncolors:\n'));
  const { data, hasFrontmatter } = splitFrontmatter(md);
  assert.equal(hasFrontmatter, true);
  assert.deepEqual(Object.keys(data), ['version', 'name', 'description', 'colors', 'typography', 'rounded', 'spacing', 'components']);
  // colors: every palette step, every semantic role per theme, every status.
  for (const [key, palette] of Object.entries(rich.colors.palettes)) for (const [step, hex] of Object.entries(palette.steps)) assert.equal(data.colors[`${key}-${step}`], hex);
  assert.equal(data.colors['light-background'], '#ffffff');
  assert.equal(data.colors['light-surface-raised'], '#ffffff');
  assert.equal(data.colors['light-on-primary'], '#ffffff');
  assert.equal(data.colors['dark-background'], rich.colors.palettes.neutral.steps['950'], 'an alias is written resolved');
  assert.equal(data.colors['dark-text-muted'], rich.colors.palettes.neutral.steps['400']);
  for (const [key, hex] of Object.entries(rich.colors.status)) assert.equal(data.colors[key], hex);
  assert.equal(Object.keys(data.colors).length, 4 * 11 + 14 * 2 + 4);
  // typography: every style.
  assert.deepEqual(Object.keys(data.typography), Object.keys(rich.typography.styles));
  assert.deepEqual(data.typography.display, { fontFamily: 'Space Grotesk', fontSize: '56px', fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.02em' });
  assert.deepEqual(data.typography.code.fontFamily, 'JetBrains Mono');
  assert.deepEqual(data.rounded, { none: '0px', sm: '4px', md: '8px', lg: '12px', xl: '16px', pill: '9999px' });
  assert.deepEqual(data.spacing, { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px', '2xl': '32px', '3xl': '48px', '4xl': '64px' });
  // components: the community property names and {colors.x} aliases.
  assert.deepEqual(data.components['button-primary'], { backgroundColor: '{colors.light-primary}', textColor: '{colors.light-on-primary}', typography: '{typography.button}', rounded: '{rounded.md}', padding: '8px 16px', shadow: 'none' });
  assert.equal(data.components.card.padding, '{spacing.xl}');
  assert.equal(data.components.card.border, `1px solid ${rich.colors.palettes.neutral.steps['200']}`);
});

test('the sections come in the spec\'s order, each with what it promises', () => {
  const md = renderDesignMd(rich);
  const headings = md.split('\n').filter((line) => /^## /.test(line));
  assert.deepEqual(headings, ['## Overview', '## Colors', '## Typography', '## Layout', '## Elevation & Depth', '## Shapes', '## Motion', '## Iconography', '## Logo & Imagery', '## Components', '## Accessibility', "## Do's and Don'ts", '## Responsive Behavior', '## Iteration Guide', '## Project Rules', '## Agent Instructions']);
  assert.match(md, /\n# Acme — Design System\n/);
  // Overview: vibe, key characteristics, personality, voice.
  for (const text of ['**Tools that stay out of the way**', 'Quiet and exact.', '**Personality:** precise, warm', '### Key Characteristics\n\n- One accent per screen\n- Hairline borders', '### Voice\n\nPlain and direct.', '- Do: Say what happens next', "- Don't: Use jargon"]) assert.ok(md.includes(text), text);
  // Colors: palettes with usage, the roles table for both themes, status, gradients, contrast notes.
  assert.ok(md.includes('**Primary** (`primary`) — CTAs, links, focus\n50 `'));
  assert.ok(md.includes('### Semantic roles\n\n| Role | Light | Dark |\n|---|---|---|\n| `background` | `#ffffff` | `{neutral.950}` → `'));
  assert.ok(md.includes('- **danger** `#ef4444`'));
  assert.ok(md.includes('- **hero** `linear-gradient(135deg, #3b82f6, #8b5cf6)` — Hero'));
  assert.match(md, /### Contrast notes\n\nWCAG AA: text needs 4\.5:1, large text and UI 3:1\.\n- \*\*Light:\*\* text on background [\d.]+:1/);
  assert.match(md, /on-primary on primary 3\.68:1 \(below 4\.5:1\)/, 'a pair under the bar says so');
  // Typography.
  assert.ok(md.includes('- **Heading:** `"Space Grotesk", system-ui, sans-serif` · google · weights 600, 700'));
  assert.ok(md.includes('| `display` | Space Grotesk | 56px (36px mobile) | 700 | 1.05 | -0.02em | Hero headline |'));
  assert.ok(md.includes('| `overline` | Inter | 12px | 600 | 1.3 | 0.08em, uppercase |'));
  assert.ok(md.includes('### Principles\n\n- Lines run 45 to 75 characters'));
  // Layout, elevation, shapes, motion, icons.
  for (const text of ['### Spacing system\n\nBase unit 4px. `xs` 4px', '### Grid & container\n\n12 columns, 24px gutter. Container max width 1200px, side padding 24px.', '### Breakpoints\n\n`sm` 640px', '### Z-index\n\n`dropdown` 1000', '### Whitespace philosophy\n\n- Whitespace groups, borders separate', '- **md** `0 4px 12px rgba(0,0,0,.10)` — Dropdowns, popovers', '**Radius roles:** button → `md` (8px)', '**Borders:** `thin` 1px · `thick` 2px', '**Durations:** `fast` 150ms', 'Honour `prefers-reduced-motion`', '- Motion explains a change', 'Library **lucide**, outline style, stroke 1.5px, sizes 16px / 20px / 24px.']) assert.ok(md.includes(text), text);
  // Logo and imagery: repo paths, clear space, minimum size, don'ts, direction, the generation prefix.
  for (const text of ['- **Main** (primary, on white) — `.synabun/style-guide/logo-main.svg`', '- Clear space: The height of the mark on every side', '- Minimum size: 32px', '- Favicon: `.synabun/style-guide/favicon.svg`', "- Don't: Stretch the mark", 'Style: **illustration** — Soft, geometric.', '### Image generation\n\n- Prompt prefix: Flat geometric illustration, soft blue\n- Negative prompt: photorealism\n- Aspect ratios: 16:9']) assert.ok(md.includes(text), text);
  // Components, accessibility, rules, responsive, custom, agents, footer.
  assert.ok(md.includes('### Primary button (`button-primary`, button)\n\n- background: `{semantic.primary}`'));
  assert.ok(md.includes('- Target: WCAG 2.2 AA.'));
  assert.ok(md.includes('- Focus ring: 2px solid #3b82f6, offset 2px (`2px solid {semantic.focus}, offset 2px`).'));
  assert.ok(md.includes("## Do's and Don'ts\n\n### Do\n\n- Use real copy\n\n### Don't\n\n- Put text on gradients"));
  assert.ok(md.includes('- The sidebar collapses below lg'));
  assert.ok(md.includes('## Project Rules\n\nMarketing pages may use the hero gradient once.'));
  assert.ok(md.includes('Token files: `.synabun/style-guide/tokens.css` (CSS custom properties (light and dark)), `.synabun/style-guide/tokens.json` (W3C design tokens (DTCG 2025.10)), `.synabun/style-guide/tailwind.css` (Tailwind v4 `@theme`).'));
  assert.ok(md.includes('Call the SynaBun `style_guide` tool with action `propose`'));
  assert.ok(md.includes('Ask before adding a new palette.'));
  assert.ok(md.endsWith('---\n\n_Generated by SynaBun Style Guide rev 7 — edit in Neural Interface → Style Guide, not by hand._\n'));
});

test('the same config gives the same bytes; the default guide stays around 10–14 KB; a v1 file renders too', () => {
  assert.equal(renderDesignMd(rich), renderDesignMd(JSON.parse(JSON.stringify(rich))));
  assert.equal(renderDesignMd(base), renderDesignMd(defaultStyleGuide('/work/acme')));
  const size = Buffer.byteLength(renderDesignMd(base));
  assert.ok(size >= 10 * 1024 && size <= 14 * 1024, `${size} bytes`);
  assert.doesNotMatch(renderDesignMd(base), /\n{3,}/);
  assert.doesNotMatch(renderDesignMd(base), /\d{4}-\d{2}-\d{2}T/, 'no timestamp: the file only changes when the guide does');
  const v1 = renderDesignMd({ projectPath: '/work/old', colors: { primary: { 500: '#ff0000' } }, typography: { heading: { family: 'Sora' } } });
  assert.match(v1, /primary-500: "#ff0000"/);
  assert.match(v1, /fontFamily: "Sora"/);
  assert.match(v1, /\n# old — Design System\n/, 'without a brand name the project folder names the guide');
});

test('what the settings change: one theme, exports turned off, proposals off, a missing logo', () => {
  const lightOnly = renderDesignMd(applyMergePatch(base, { colors: { themes: { default: 'light', supports: ['light'] } } }));
  assert.match(lightOnly, /\| Role \| Light \|\n\|---\|---\|/);
  assert.doesNotMatch(lightOnly, /dark-background/);
  const darkFirst = renderDesignMd(applyMergePatch(base, { colors: { themes: { default: 'dark', supports: ['light', 'dark'] } } }));
  assert.match(darkFirst, /\| Role \| Dark \| Light \|/);
  assert.match(darkFirst, /backgroundColor: "\{colors\.dark-primary\}"/, 'components alias the default theme');
  const quiet = renderDesignMd(applyMergePatch(base, { exports: { tokensJson: false, cssVars: false, tailwind: 'v3', outDir: 'design/tokens' }, agents: { allowProposals: false } }));
  assert.ok(quiet.includes('Token files: `design/tokens/tailwind.tokens.cjs` (Tailwind v3 `theme.extend`).'));
  assert.ok(quiet.includes('Proposals are turned off for this project'));
  assert.ok(!quiet.includes('action `propose`'));
  assert.ok(renderDesignMd(base).includes('No logo files uploaded yet.'));
  assert.equal(guideName({ brand: { name: ' ' }, projectPath: '/a/b/' }), 'b');
  assert.equal(frontmatterAlias(base, '{radiusRoles.card}', 'light'), '{rounded.lg}');
  assert.equal(frontmatterAlias(base, '{status.danger}', 'light'), '{colors.danger}');
  assert.equal(frontmatterAlias(base, '{nope.1}', 'light'), '{nope.1}');
});
