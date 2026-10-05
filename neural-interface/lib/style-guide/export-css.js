// ═══════════════════════════════════════════
// SynaBun — Style Guide → CSS custom properties
// ═══════════════════════════════════════════
//
// tokens.css: every token as a custom property under the configured selector
// (`:root`), the other theme's semantic colors under `[data-theme="dark"]`, `.dark`
// or `@media (prefers-color-scheme: dark)`, and a reduced-motion block. Semantic
// colors point at palette steps with var(), so one override re-themes the page.
// Pure and deterministic.

import { normalizeStyleGuide, resolveText } from './schema.js';
import { fontKeyOf, fontStack, px, rem, roleName, semanticEntries, themesOf } from './tokens.js';

/** The custom property a semantic or component alias points at, when it names a palette step or a status. */
function colorVar(entry) {
  if (!entry.alias || !entry.value) return entry.value;
  if (entry.alias.group === 'status') return `var(--color-${entry.alias.key})`;
  if (entry.alias.group === 'semantic') return `var(--color-${roleName(entry.alias.key)})`;
  return `var(--color-${entry.alias.group}-${entry.alias.key})`;
}

/** [name, value] pairs for one theme's semantic roles. */
export function semanticDeclarations(config, theme, { vars = true } = {}) {
  return semanticEntries(config, theme).filter((entry) => entry.value).map((entry) => [`--color-${entry.name}`, vars ? colorVar(entry) : entry.value]);
}

/** [name, value] pairs for everything that does not change with the theme. */
export function baseDeclarations(config, theme) {
  const out = [];
  for (const [key, palette] of Object.entries(config.colors.palettes)) {
    for (const [step, hex] of Object.entries(palette.steps)) out.push([`--color-${key}-${step}`, hex]);
  }
  for (const [key, hex] of Object.entries(config.colors.status)) out.push([`--color-${key}`, hex]);
  for (const gradient of config.colors.gradients) out.push([`--gradient-${gradient.name}`, resolveText(config, gradient.css, { theme }).text]);
  for (const [key, font] of Object.entries(config.typography.fonts)) if (font) out.push([`--font-${key}`, fontStack(font)]);
  for (const [id, style] of Object.entries(config.typography.styles)) {
    out.push([`--text-${id}-size`, rem(style.size)]);
    if (style.mobileSize && style.mobileSize !== style.size) out.push([`--text-${id}-size-mobile`, rem(style.mobileSize)]);
    out.push([`--text-${id}-weight`, String(style.weight)]);
    out.push([`--text-${id}-line-height`, String(style.lineHeight)]);
    out.push([`--text-${id}-letter-spacing`, style.letterSpacing === 0 ? '0' : `${style.letterSpacing}em`]);
    out.push([`--text-${id}-font`, `var(--font-${fontKeyOf(config, style)})`]);
  }
  for (const [key, value] of Object.entries(config.layout.spacing.scale)) out.push([`--space-${key}`, px(value)]);
  for (const [key, value] of Object.entries(config.shape.radius)) out.push([`--radius-${key}`, px(value)]);
  for (const [role, key] of Object.entries(config.shape.radiusRoles)) if (!(role in config.shape.radius)) out.push([`--radius-${role}`, `var(--radius-${key})`]);
  for (const [key, value] of Object.entries(config.shape.borders)) out.push([`--border-${key}`, px(value)]);
  for (const [key, level] of Object.entries(config.shape.elevation)) out.push([`--shadow-${key}`, level.shadow]);
  for (const [key, value] of Object.entries(config.motion.durations)) out.push([`--duration-${key}`, `${value}ms`]);
  for (const [key, value] of Object.entries(config.motion.easings)) out.push([`--ease-${key}`, value]);
  for (const [key, value] of Object.entries(config.layout.breakpoints)) out.push([`--breakpoint-${key}`, px(value)]);
  for (const [key, value] of Object.entries(config.layout.zIndex)) out.push([`--z-${key}`, String(value)]);
  out.push(['--container-max', px(config.layout.container.maxWidth)], ['--container-padding', px(config.layout.container.padding)]);
  out.push(['--grid-columns', String(config.layout.grid.columns)], ['--grid-gutter', px(config.layout.grid.gutter)]);
  return out;
}

function block(selector, declarations, indent = '') {
  return [`${indent}${selector} {`, ...declarations.map(([name, value]) => `${indent}  ${name}: ${value};`), `${indent}}`];
}

/** Where the non-default theme's colors go: { selector } or { media, selector }. */
export function themeScope(config, theme) {
  const root = config.exports.cssSelector || ':root';
  if (config.exports.darkMode === 'media') return { media: `(prefers-color-scheme: ${theme})`, selector: root };
  const selector = config.exports.darkMode === 'class' ? `.${theme}` : `[data-theme="${theme}"]`;
  // A custom root (especially #app) outranks a bare theme selector. Cover a theme
  // on the root itself and on an ancestor, with enough specificity to override it.
  return { selector: root === ':root' ? selector : `${root}${selector}, ${selector} ${root}` };
}

/**
 * tokens.css. `theme` (light | dark) flattens the output to that one theme: no second block,
 * semantic colors as literal hexes. Without it both themes are written.
 */
export function exportCss(input, { theme = null } = {}) {
  const config = normalizeStyleGuide(input);
  const themes = themesOf(config);
  const root = config.exports.cssSelector || ':root';
  const single = themes.includes(theme) ? theme : null;
  const first = single || themes[0];
  const lines = [
    `/* SynaBun Style Guide rev ${config.revision}: design tokens. Generated, do not edit by hand. */`,
    ...block(root, [['color-scheme', first], ...baseDeclarations(config, first), ...semanticDeclarations(config, first, { vars: !single })]),
  ];
  if (!single) {
    for (const other of themes.slice(1)) {
      const scope = themeScope(config, other);
      const declarations = [['color-scheme', other], ...semanticDeclarations(config, other)];
      lines.push('');
      if (scope.media) lines.push(`@media ${scope.media} {`, ...block(scope.selector, declarations, '  '), '}');
      else lines.push(...block(scope.selector, declarations));
    }
  }
  if (config.motion.reducedMotion === 'respect') {
    lines.push('', '@media (prefers-reduced-motion: reduce) {', ...block(root, Object.keys(config.motion.durations).map((key) => [`--duration-${key}`, '0ms']), '  '), '}');
  }
  return `${lines.join('\n')}\n`;
}
