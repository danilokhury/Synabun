// ═══════════════════════════════════════════
// SynaBun — Style Guide → Tailwind theme
// ═══════════════════════════════════════════
//
// v4: a CSS file with `@theme { --color-*, --font-*, --text-*, --radius-*, --shadow-*,
// --breakpoint-*, --ease-*, --spacing }` (import it after `@import "tailwindcss"`), plus
// the other theme's semantic colors in a base layer. v3: a CommonJS module with
// `theme.extend` (spread it into tailwind.config). Pure and deterministic.

import { normalizeStyleGuide } from './schema.js';
import { semanticDeclarations, themeScope } from './export-css.js';
import { fontList, fontStack, px, rem, semanticEntries, themesOf } from './tokens.js';

/** tailwind.css for Tailwind v4. `theme` flattens to one theme, as in exportCss. */
export function exportTailwindV4(input, { theme = null } = {}) {
  const config = normalizeStyleGuide(input);
  const themes = themesOf(config);
  const single = themes.includes(theme) ? theme : null;
  const first = single || themes[0];
  const vars = [];
  for (const [key, palette] of Object.entries(config.colors.palettes)) {
    for (const [step, hex] of Object.entries(palette.steps)) vars.push([`--color-${key}-${step}`, hex]);
  }
  for (const [key, hex] of Object.entries(config.colors.status)) vars.push([`--color-${key}`, hex]);
  vars.push(...semanticDeclarations(config, first, { vars: !single }));
  for (const [key, font] of Object.entries(config.typography.fonts)) if (font) vars.push([`--font-${key}`, fontStack(font)]);
  for (const [id, style] of Object.entries(config.typography.styles)) {
    vars.push([`--text-${id}`, rem(style.size)], [`--text-${id}--line-height`, String(style.lineHeight)], [`--text-${id}--font-weight`, String(style.weight)]);
    if (style.letterSpacing !== 0) vars.push([`--text-${id}--letter-spacing`, `${style.letterSpacing}em`]);
  }
  vars.push(['--spacing', rem(config.layout.spacing.base)]);
  for (const [key, value] of Object.entries(config.shape.radius)) vars.push([`--radius-${key}`, px(value)]);
  for (const [role, key] of Object.entries(config.shape.radiusRoles)) if (!(role in config.shape.radius)) vars.push([`--radius-${role}`, px(config.shape.radius[key])]);
  for (const [key, level] of Object.entries(config.shape.elevation)) vars.push([`--shadow-${key}`, level.shadow === 'none' ? '0 0 #0000' : level.shadow]);
  for (const [key, value] of Object.entries(config.layout.breakpoints)) vars.push([`--breakpoint-${key}`, rem(value)]);
  for (const [key, value] of Object.entries(config.motion.easings)) vars.push([`--ease-${key}`, value]);
  const lines = [
    `/* SynaBun Style Guide rev ${config.revision}: Tailwind v4 theme. Generated, do not edit by hand. */`,
    '@theme {',
    ...vars.map(([name, value]) => `  ${name}: ${value};`),
    '}',
  ];
  if (!single) {
    for (const other of themes.slice(1)) {
      const scope = themeScope(config, other);
      const declarations = semanticDeclarations(config, other).map(([name, value]) => `${name}: ${value};`);
      lines.push('', '@layer base {');
      if (scope.media) lines.push(`  @media ${scope.media} {`, `    ${scope.selector} {`, ...declarations.map((d) => `      ${d}`), '    }', '  }');
      else lines.push(`  ${scope.selector} {`, ...declarations.map((d) => `    ${d}`), '  }');
      lines.push('}');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The `theme.extend` object for Tailwind v3. Semantic colors read tokens.css, so the dark theme follows it. */
export function tailwindV3Theme(input) {
  const config = normalizeStyleGuide(input);
  const theme = themesOf(config)[0];
  const colors = {};
  for (const [key, palette] of Object.entries(config.colors.palettes)) colors[key] = { ...palette.steps, DEFAULT: palette.steps['500'] };
  for (const [key, hex] of Object.entries(config.colors.status)) colors[key] = hex;
  for (const entry of semanticEntries(config, theme)) {
    if (!entry.value) continue;
    // `primary` is both a palette and a role: the role becomes the palette's DEFAULT.
    if (colors[entry.name] && typeof colors[entry.name] === 'object') colors[entry.name].DEFAULT = `var(--color-${entry.name}, ${entry.value})`;
    else colors[entry.name] = `var(--color-${entry.name}, ${entry.value})`;
  }
  const fontFamily = {};
  for (const [key, font] of Object.entries(config.typography.fonts)) if (font) fontFamily[key] = fontList(font);
  const fontSize = {};
  for (const [id, style] of Object.entries(config.typography.styles)) {
    fontSize[id] = [rem(style.size), { lineHeight: String(style.lineHeight), letterSpacing: style.letterSpacing === 0 ? '0' : `${style.letterSpacing}em`, fontWeight: String(style.weight) }];
  }
  const mapPx = (map) => Object.fromEntries(Object.entries(map).map(([key, value]) => [key, px(value)]));
  const borderRadius = mapPx(config.shape.radius);
  for (const [role, key] of Object.entries(config.shape.radiusRoles)) if (!(role in borderRadius)) borderRadius[role] = px(config.shape.radius[key]);
  return {
    colors,
    fontFamily,
    fontSize,
    spacing: mapPx(config.layout.spacing.scale),
    borderRadius,
    borderWidth: mapPx(config.shape.borders),
    boxShadow: Object.fromEntries(Object.entries(config.shape.elevation).map(([key, level]) => [key, level.shadow])),
    screens: mapPx(config.layout.breakpoints),
    zIndex: Object.fromEntries(Object.entries(config.layout.zIndex).map(([key, value]) => [key, String(value)])),
    transitionTimingFunction: { ...config.motion.easings },
    transitionDuration: Object.fromEntries(Object.entries(config.motion.durations).map(([key, value]) => [key, `${value}ms`])),
  };
}

/** tailwind.tokens.cjs for Tailwind v3. */
export function exportTailwindV3(input) {
  const config = normalizeStyleGuide(input);
  return [
    `/* SynaBun Style Guide rev ${config.revision}: Tailwind v3 theme. Generated, do not edit by hand. */`,
    '/* tailwind.config.js: const tokens = require("./.synabun/style-guide/tailwind.tokens.cjs"); module.exports = { theme: { extend: tokens.theme.extend } } */',
    `module.exports = ${JSON.stringify({ theme: { extend: tailwindV3Theme(config) } }, null, 2)};`,
    '',
  ].join('\n');
}
