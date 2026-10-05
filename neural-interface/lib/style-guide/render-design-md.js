// ═══════════════════════════════════════════
// SynaBun — DESIGN.md renderer (Stitch-shaped)
// ═══════════════════════════════════════════
//
// DESIGN.md is the file agents read for "how this project should look" (AGENTS.md
// says how to build). The shape is the one Google Stitch and the community
// collection use: YAML frontmatter with the exact tokens, then prose sections with
// the intent. Pure and deterministic: the same config gives the same bytes, so the
// file only changes in git when the guide does. No Node import here or in what this
// file imports (schema, color, tokens), so the editor can load the same code.
//
// Frontmatter names (the importer reads them back):
//   colors      <palette>-<step> · <theme>-<role> · <status>
//   typography  <style id> { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing }
//   rounded     <radius name>      spacing  <spacing name>
//   components  <id> { backgroundColor, textColor, typography, rounded, padding, … } with {colors.x} aliases

import { contrastReport } from './color.js';
import { STYLE_GUIDE_OUT_DIR, isAlias, normalizeStyleGuide, resolveAlias, resolveColor, resolveText } from './schema.js';
import { fontOf, fontStack, px, roleName, semanticEntries, themesOf, tidy } from './tokens.js';

const yaml = (value) => JSON.stringify(String(value ?? ''));
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const code = (value) => `\`${String(value ?? '').replace(/`/g, '')}\``;
const bullets = (items) => items.map((item) => `- ${String(item).replace(/\s*\n\s*/g, ' ')}`);
const title = (text) => String(text).replace(/(^|[-_ ])([a-z])/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase());

/** The name the guide goes by: the brand's, else the project folder's. (No node:path: this module also loads in a browser.) */
export function guideName(config) {
  const folder = String(config.projectPath || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return config.brand?.name?.trim() || folder || 'Project';
}

// How a component token is called in the frontmatter (the community files' property names).
const COMPONENT_PROPS = Object.freeze({ background: 'backgroundColor', text: 'textColor', radius: 'rounded' });

/** A component token's value in frontmatter grammar: "{semantic.primary}" → "{colors.light-primary}". */
export function frontmatterAlias(config, value, theme) {
  if (!isAlias(value)) return resolveText(config, value, { theme }).text;
  const hit = resolveAlias(config, value, { theme });
  if (!hit.ok) return String(value);
  switch (hit.group) {
    case 'semantic': return `{colors.${theme}-${roleName(hit.key)}}`;
    case 'status': return `{colors.${hit.key}}`;
    case 'typography': return `{typography.${hit.key}}`;
    case 'radius': return `{rounded.${hit.key}}`;
    case 'radiusRoles': return `{rounded.${hit.via}}`;
    case 'spacing': return `{spacing.${hit.key}}`;
    case 'elevation': case 'easing': return String(hit.value);
    case 'duration': return `${hit.value}ms`;
    default: return `{colors.${hit.group}-${hit.key}}`;
  }
}

function frontmatter(config, themes) {
  const out = ['---', 'version: 2', `name: ${yaml(guideName(config))}`];
  const description = config.brand.description || config.brand.tagline || config.brand.vibe;
  out.push(`description: ${yaml(description.replace(/\s+/g, ' ').slice(0, 300))}`);
  out.push('colors:');
  for (const [key, palette] of Object.entries(config.colors.palettes)) {
    for (const [step, hex] of Object.entries(palette.steps)) out.push(`  ${key}-${step}: ${yaml(hex)}`);
  }
  for (const theme of themes) {
    for (const entry of semanticEntries(config, theme)) if (entry.value) out.push(`  ${theme}-${entry.name}: ${yaml(entry.value)}`);
  }
  for (const [key, hex] of Object.entries(config.colors.status)) out.push(`  ${key}: ${yaml(hex)}`);
  out.push('typography:');
  for (const [id, style] of Object.entries(config.typography.styles)) {
    out.push(`  ${id}:`);
    out.push(`    fontFamily: ${yaml(fontOf(config, style).family)}`);
    out.push(`    fontSize: ${style.size}px`);
    out.push(`    fontWeight: ${style.weight}`);
    out.push(`    lineHeight: ${style.lineHeight}`);
    out.push(`    letterSpacing: ${style.letterSpacing}em`);
    const features = fontOf(config, style).features;
    if (features) out.push(`    fontFeature: ${yaml(features)}`);
  }
  out.push('rounded:');
  for (const [key, value] of Object.entries(config.shape.radius)) out.push(`  ${key}: ${value}px`);
  out.push('spacing:');
  for (const [key, value] of Object.entries(config.layout.spacing.scale)) out.push(`  ${key}: ${value}px`);
  if (config.components.some((component) => Object.values(component.tokens).some((value) => String(value).trim()))) {
    out.push('components:');
    const theme = themes[0];
    for (const component of config.components) {
      const props = Object.entries(component.tokens).filter(([, value]) => String(value).trim());
      if (!props.length) continue;
      out.push(`  ${component.id}:`);
      for (const [key, value] of props) out.push(`    ${COMPONENT_PROPS[key] || key}: ${yaml(frontmatterAlias(config, value, theme))}`);
    }
  } else out.push('components: {}');
  out.push('---');
  return out;
}

function shown(config, raw, theme) {
  const hex = resolveColor(config, raw, { theme });
  if (isAlias(raw)) return hex ? `${code(raw)} → ${code(hex)}` : `${code(raw)} (unknown)`;
  return code(hex || raw);
}

function contrastNotes(config, themes) {
  const pairs = [['text', 'background'], ['textMuted', 'background'], ['text', 'surface'], ['link', 'background'], ['onPrimary', 'primary'], ['onSecondary', 'secondary'], ['onAccent', 'accent']];
  const min = config.accessibility.minContrastText;
  const lines = [];
  for (const theme of themes) {
    const colors = config.colors.semantic[theme];
    const notes = [];
    for (const [fg, bg] of pairs) {
      if (!(fg in colors) || !(bg in colors)) continue;
      const report = contrastReport(resolveColor(config, colors[fg], { theme }), resolveColor(config, colors[bg], { theme }));
      if (report) notes.push(`${roleName(fg)} on ${roleName(bg)} ${report.ratio}:1${report.ratio >= min ? '' : ` (below ${min}:1)`}`);
    }
    if (notes.length) lines.push(`- **${title(theme)}:** ${notes.join(' · ')}`);
  }
  return lines;
}

function writtenFiles(config) {
  const dir = config.exports.outDir || STYLE_GUIDE_OUT_DIR;
  const files = [];
  if (config.exports.cssVars) files.push([`${dir}/tokens.css`, 'CSS custom properties (light and dark)']);
  if (config.exports.tokensJson) files.push([`${dir}/tokens.json`, 'W3C design tokens (DTCG 2025.10)']);
  if (config.exports.tailwind === 'v4') files.push([`${dir}/tailwind.css`, 'Tailwind v4 `@theme`']);
  if (config.exports.tailwind === 'v3') files.push([`${dir}/tailwind.tokens.cjs`, 'Tailwind v3 `theme.extend`']);
  return files;
}

/**
 * The project's DESIGN.md. Any config is accepted (it is normalized first, so a v1 file renders too).
 */
export function renderDesignMd(input) {
  const config = normalizeStyleGuide(input);
  const themes = themesOf(config);
  const { brand, colors, typography, layout, shape, motion, iconography, logo, imagery, accessibility, rules } = config;
  const name = guideName(config);
  const out = [...frontmatter(config, themes), '', `# ${name} — Design System`, ''];
  const section = (heading) => { out.push(`## ${heading}`, ''); };
  const sub = (heading) => { out.push(`### ${heading}`, ''); };
  const para = (...lines) => { out.push(...lines, ''); };

  // ── Overview ──
  section('Overview');
  if (brand.tagline) para(`**${brand.tagline}**`);
  if (brand.description) para(brand.description);
  if (brand.vibe) para(brand.vibe);
  if (!brand.tagline && !brand.description && !brand.vibe) para(`The visual identity of ${name}: its colors, type, spacing, shape, motion and the rules for using them.`);
  if (brand.audience) para(`**Audience:** ${brand.audience}`);
  if (brand.personality.length) para(`**Personality:** ${brand.personality.join(', ')}`);
  if (brand.keyCharacteristics.length) { sub('Key Characteristics'); para(...bullets(brand.keyCharacteristics)); }
  if (brand.voice.tone || brand.voice.dos.length || brand.voice.donts.length) {
    sub('Voice');
    if (brand.voice.tone) para(brand.voice.tone);
    if (brand.voice.dos.length) para(...bullets(brand.voice.dos.map((item) => `Do: ${item}`)));
    if (brand.voice.donts.length) para(...bullets(brand.voice.donts.map((item) => `Don't: ${item}`)));
  }

  // ── Colors ──
  section('Colors');
  sub('Palettes');
  for (const [key, palette] of Object.entries(colors.palettes)) {
    para(`**${palette.label || title(key)}** (${code(key)})${palette.usage ? ` — ${palette.usage}` : ''}`,
      Object.entries(palette.steps).map(([step, hex]) => `${step} ${code(hex)}`).join(' · '));
  }
  sub('Semantic roles');
  const roles = [...new Set(themes.flatMap((theme) => Object.keys(colors.semantic[theme])))];
  out.push(`| Role | ${themes.map(title).join(' | ')} |`, `|---|${themes.map(() => '---').join('|')}|`);
  for (const role of roles) out.push(`| ${code(roleName(role))} | ${themes.map((theme) => (role in colors.semantic[theme] ? shown(config, colors.semantic[theme][role], theme) : '')).join(' | ')} |`);
  out.push('');
  para(`Default theme: **${themes[0]}**${themes.length > 1 ? `; also ships **${themes.slice(1).join(', ')}**` : ''}. Build with the roles, not the raw palette steps, so both themes work.`);
  sub('Status');
  para(...Object.entries(colors.status).map(([key, hex]) => `- **${key}** ${code(hex)}`));
  if (colors.gradients.length) {
    sub('Gradients');
    para(...colors.gradients.map((g) => `- **${g.name}** ${code(resolveText(config, g.css, { theme: themes[0] }).text)}${g.usage ? ` — ${g.usage}` : ''}`));
  }
  const notes = contrastNotes(config, themes);
  if (notes.length) { sub('Contrast notes'); para(`WCAG ${accessibility.level}: text needs ${accessibility.minContrastText}:1, large text and UI ${accessibility.minContrastLarge}:1.`, ...notes); }

  // ── Typography ──
  section('Typography');
  sub('Font families');
  for (const [key, font] of Object.entries(typography.fonts)) {
    if (!font) continue;
    out.push(`- **${title(key)}:** ${code(fontStack(font))} · ${font.source} · weights ${font.weights.join(', ')}${font.features ? ` · features ${code(font.features)}` : ''}`);
  }
  out.push('');
  sub('Hierarchy');
  out.push('| Style | Font | Size | Weight | Line height | Letter spacing | Use |', '|---|---|---|---|---|---|---|');
  for (const [id, style] of Object.entries(typography.styles)) {
    const size = style.mobileSize && style.mobileSize !== style.size ? `${style.size}px (${style.mobileSize}px mobile)` : `${style.size}px`;
    const transform = style.transform !== 'none' ? `, ${style.transform}` : '';
    out.push(`| ${code(id)} | ${cell(fontOf(config, style).family)} | ${size} | ${style.weight} | ${style.lineHeight} | ${style.letterSpacing}em${transform} | ${cell(style.usage)} |`);
  }
  out.push('');
  para(`Scale: base ${typography.scale.base}px, ratio ${typography.scale.ratio} (${typography.scale.preset}).`);
  if (typography.principles.length) { sub('Principles'); para(...bullets(typography.principles)); }

  // ── Layout ──
  section('Layout');
  sub('Spacing system');
  para(`Base unit ${layout.spacing.base}px. ${Object.entries(layout.spacing.scale).map(([key, value]) => `${code(key)} ${px(value)}`).join(' · ')}`);
  sub('Grid & container');
  para(`${layout.grid.columns} columns, ${px(layout.grid.gutter)} gutter. Container max width ${px(layout.container.maxWidth)}, side padding ${px(layout.container.padding)}.`);
  sub('Breakpoints');
  para(Object.entries(layout.breakpoints).map(([key, value]) => `${code(key)} ${px(value)}`).join(' · '));
  sub('Z-index');
  para(Object.entries(layout.zIndex).map(([key, value]) => `${code(key)} ${value}`).join(' · '));
  if (layout.principles.length) { sub('Whitespace philosophy'); para(...bullets(layout.principles)); }

  // ── Elevation & Depth ──
  section('Elevation & Depth');
  para(...Object.entries(shape.elevation).map(([key, level]) => `- **${key}** ${code(level.shadow)}${level.usage ? ` — ${level.usage}` : ''}`));

  // ── Shapes ──
  section('Shapes');
  para(`**Radius scale:** ${Object.entries(shape.radius).map(([key, value]) => `${code(key)} ${px(value)}`).join(' · ')}`);
  para(`**Radius roles:** ${Object.entries(shape.radiusRoles).map(([role, key]) => `${role} → ${code(key)} (${px(shape.radius[key])})`).join(' · ')}`);
  para(`**Borders:** ${Object.entries(shape.borders).map(([key, value]) => `${code(key)} ${px(value)}`).join(' · ')}`);

  // ── Motion ──
  section('Motion');
  para(`**Durations:** ${Object.entries(motion.durations).map(([key, value]) => `${code(key)} ${value}ms`).join(' · ')}`);
  para(`**Easings:** ${Object.entries(motion.easings).map(([key, value]) => `${code(key)} ${code(value)}`).join(' · ')}`);
  para(motion.reducedMotion === 'respect' ? 'Honour `prefers-reduced-motion`: drop non-essential animation when the user asks for less motion.' : 'Reduced motion is not handled by the tokens: handle it per component.');
  if (motion.principles.length) para(...bullets(motion.principles));

  // ── Iconography ──
  section('Iconography');
  para(`Library **${iconography.library}**, ${iconography.style} style, stroke ${tidy(iconography.strokeWidth)}px, sizes ${iconography.sizes.map((s) => `${s}px`).join(' / ')}.`);
  if (iconography.notes) para(iconography.notes);

  // ── Logo & Imagery ──
  section('Logo & Imagery');
  if (logo.variants.length) {
    sub('Logo variants');
    para(...logo.variants.map((v) => `- **${v.name}** (${v.kind}, on ${v.bg})${v.file ? ` — ${code(`${STYLE_GUIDE_OUT_DIR}/${v.file}`)}` : ''}`));
  } else {
    para('No logo files uploaded yet.');
  }
  const logoRules = [];
  if (logo.clearSpace) logoRules.push(`Clear space: ${logo.clearSpace}`);
  logoRules.push(`Minimum size: ${px(logo.minSize.px)}`);
  if (logo.favicon) logoRules.push(`Favicon: ${code(`${STYLE_GUIDE_OUT_DIR}/${logo.favicon}`)}`);
  para(...bullets(logoRules));
  if (logo.donts.length) para(...bullets(logo.donts.map((item) => `Don't: ${item}`)));
  sub('Imagery');
  para(`Style: **${imagery.style}**${imagery.mood ? ` — ${imagery.mood}` : ''}.`);
  if (imagery.notes) para(imagery.notes);
  if (imagery.dos.length) para(...bullets(imagery.dos.map((item) => `Do: ${item}`)));
  if (imagery.donts.length) para(...bullets(imagery.donts.map((item) => `Don't: ${item}`)));
  const generation = [];
  if (imagery.generation.promptPrefix) generation.push(`Prompt prefix: ${imagery.generation.promptPrefix}`);
  if (imagery.generation.negativePrompt) generation.push(`Negative prompt: ${imagery.generation.negativePrompt}`);
  if (imagery.generation.aspectRatios.length) generation.push(`Aspect ratios: ${imagery.generation.aspectRatios.join(', ')}`);
  if (imagery.generation.styleReferences.length) generation.push(`Style references: ${imagery.generation.styleReferences.join('; ')}`);
  if (generation.length) { sub('Image generation'); para(...bullets(generation)); }

  // ── Components ──
  section('Components');
  if (!config.components.length) para('No component specs yet: build from the tokens above.');
  for (const component of config.components) {
    sub(`${component.name} (${code(component.id)}, ${component.category})`);
    const tokens = Object.entries(component.tokens).filter(([, value]) => String(value).trim());
    if (tokens.length) para(...tokens.map(([key, value]) => `- ${key}: ${code(value)}`));
    const states = Object.entries(component.states).filter(([, value]) => String(value).trim());
    if (states.length) para(`States — ${states.map(([key, value]) => `${key}: ${value}`).join('; ')}.`);
    if (component.notes) para(component.notes);
  }

  // ── Accessibility ──
  section('Accessibility');
  para(...bullets([
    `Target: WCAG 2.2 ${accessibility.level}.`,
    `Contrast: at least ${accessibility.minContrastText}:1 for text, ${accessibility.minContrastLarge}:1 for large text, UI components and focus indicators.`,
    `Touch targets: at least ${accessibility.minTouchTarget}px.`,
    `Focus ring: ${resolveText(config, accessibility.focusRing, { theme: themes[0] }).text} (${code(accessibility.focusRing)}).`,
    ...accessibility.notes,
  ]));

  // ── Do's and Don'ts ──
  section("Do's and Don'ts");
  sub('Do');
  para(...bullets(rules.dos.length ? rules.dos : ['Use the semantic color roles and the type styles above.', 'Keep spacing on the scale.']));
  sub("Don't");
  para(...bullets(rules.donts.length ? rules.donts : ['Invent colors, fonts or radii the guide does not define.', 'Convey meaning with color alone.']));

  // ── Responsive Behavior ──
  section('Responsive Behavior');
  para(...bullets([
    `Breakpoints: ${Object.entries(layout.breakpoints).map(([key, value]) => `${key} ${px(value)}`).join(', ')}. Design mobile-first.`,
    `Touch targets stay at least ${accessibility.minTouchTarget}px on every breakpoint.`,
    'Text styles with a mobile size switch to it below the `md` breakpoint.',
    ...config.responsive.notes,
  ]));

  section('Iteration Guide');
  para('1. Start from the tokens in the frontmatter and the generated token files.', '2. Change one variable at a time and verify both themes and responsive sizes.', config.agents.allowProposals ? '3. Propose design-system changes with `style_guide` action `propose` for user review.' : '3. Report design-system gaps to the user; proposals are turned off.');

  if (rules.custom.trim()) { section('Project Rules'); para(rules.custom.trim()); }

  // ── Agent Instructions ──
  section('Agent Instructions');
  const files = writtenFiles(config);
  const lines = [
    'This file is the source of truth for how this project looks. Read it before UI, design, copy, marketing or image work.',
    ...(files.length ? [`Token files: ${files.map(([path, what]) => `${code(path)} (${what})`).join(', ')}.`] : []),
    'Use the tokens (the CSS variables or the Tailwind theme) instead of literal colors, fonts, radii or shadows. Never invent a value the guide already defines.',
    'Do not edit this file or the token files by hand: they are regenerated on every save.',
    ...(config.agents.allowProposals
      ? ['A gap or a better token? Call the SynaBun `style_guide` tool with action `propose` (a JSON merge patch in `changes` plus a `reason`); the user reviews proposals in the Style Guide panel.']
      : ['Proposals are turned off for this project: report a gap to the user instead of changing the guide.']),
  ];
  para(...bullets(lines));
  if (config.agents.instructions.trim()) para(config.agents.instructions.trim());

  out.push('---', '', `_Generated by SynaBun Style Guide rev ${config.revision} — edit in Neural Interface → Style Guide, not by hand._`);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
