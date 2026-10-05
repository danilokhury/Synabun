// ═══════════════════════════════════════════
// SynaBun — Style Guide token helpers
// ═══════════════════════════════════════════
//
// What the DESIGN.md renderer and the three exporters share, so one token has one
// name everywhere: `primary-500`, `on-primary`, `--color-on-primary`. Pure, no I/O.

import { parseColor } from './color.js';
import { THEMES, isAlias, parseAlias, resolveAlias, resolveColor, resolveText } from './schema.js';

/** onPrimary → on-primary, surfaceRaised → surface-raised. */
export function roleName(role) {
  return String(role).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** on-primary → onPrimary (the importer's way back). */
export function roleFromName(name) {
  return String(name).replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** The themes a guide ships, default first. */
export function themesOf(config) {
  const supports = (config.colors?.themes?.supports || ['light']).filter((theme) => THEMES.includes(theme));
  const first = supports.includes(config.colors?.themes?.default) ? config.colors.themes.default : supports[0] || 'light';
  return [first, ...supports.filter((theme) => theme !== first)];
}

/** A font-family value: `"Space Grotesk", system-ui, sans-serif`. */
export function fontStack(font) {
  if (!font) return '';
  const family = String(font.family || '').trim();
  const quoted = /^[a-zA-Z][a-zA-Z0-9-]*$/.test(family) ? family : `"${family.replace(/["\\]/g, '')}"`;
  const fallback = String(font.fallback || '').trim();
  return fallback ? `${quoted}, ${fallback}` : quoted;
}

/** The same stack as a list (DTCG fontFamily). */
export function fontList(font) {
  if (!font) return [];
  return [String(font.family || '').trim(), ...String(font.fallback || '').split(',').map((part) => part.trim().replace(/^["']|["']$/g, ''))].filter(Boolean);
}

/** The font a text style uses (a style naming a missing `display` falls back to heading, then body). */
export function fontOf(config, style) {
  const fonts = config.typography.fonts;
  return fonts[style.font] || (style.font === 'display' ? fonts.heading : null) || fonts.body;
}

/** The key of that font in `typography.fonts` (heading | body | mono | display). */
export function fontKeyOf(config, style) {
  if (config.typography.fonts[style.font]) return style.font;
  return style.font === 'display' ? 'heading' : 'body';
}

/** [{ role, name, raw, value (hex or null), alias ({group, key} or null) }] for one theme. */
export function semanticEntries(config, theme) {
  return Object.entries(config.colors.semantic[theme] || {}).map(([role, raw]) => ({
    role, name: roleName(role), raw, value: resolveColor(config, raw, { theme }), alias: isAlias(raw) ? parseAlias(raw) : null,
  }));
}

/** px → rem at 16px, trimmed: 24 → "1.5rem". */
export function rem(px) {
  return `${Math.round((Number(px) / 16) * 10000) / 10000}rem`;
}

export function px(value) {
  return Number(value) === 0 ? '0' : `${value}px`;
}

/** A number without float noise. */
export function tidy(value, digits = 4) {
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}

/**
 * A CSS box-shadow value → [{ inset, offsetX, offsetY, blur, spread, color }] (px numbers, any CSS color),
 * [] for "none", null when it cannot be read.
 */
export function parseShadow(css) {
  const text = String(css ?? '').trim();
  if (!text || text === 'none') return [];
  const layers = [];
  let depth = 0; let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === ',' && depth === 0) || i === text.length) { layers.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const out = [];
  for (const layer of layers) {
    if (!layer) continue;
    let rest = layer;
    let color = null;
    const fn = /(rgba?|hsla?|oklch)\([^)]*\)/i.exec(rest);
    if (fn) { color = fn[0]; rest = rest.replace(fn[0], ' '); }
    const parts = rest.split(/\s+/).filter(Boolean);
    let inset = false;
    const lengths = [];
    for (const part of parts) {
      if (part === 'inset') { inset = true; continue; }
      if (/^-?(\d+\.?\d*|\.\d+)(px)?$/.test(part)) { lengths.push(parseFloat(part)); continue; }
      if (!color && parseColor(part)) { color = part; continue; }
      return null;
    }
    if (lengths.length < 2 || lengths.length > 4 || (lengths[2] ?? 0) < 0 || (color && !parseColor(color))) return null;
    out.push({ inset, offsetX: lengths[0], offsetY: lengths[1], blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, color: color || '#000000' });
  }
  return out;
}

const EASING_KEYWORDS = Object.freeze({
  linear: [0, 0, 1, 1], ease: [0.25, 0.1, 0.25, 1], 'ease-in': [0.42, 0, 1, 1], 'ease-out': [0, 0, 0.58, 1], 'ease-in-out': [0.42, 0, 0.58, 1],
});

/** A CSS easing → [x1, y1, x2, y2], or null (steps(), linear(), anything else). */
export function parseEasing(css) {
  const text = String(css ?? '').trim().toLowerCase();
  if (EASING_KEYWORDS[text]) return [...EASING_KEYWORDS[text]];
  const match = /^cubic-bezier\(([^)]+)\)$/.exec(text);
  if (!match) return null;
  const values = match[1].split(',').map((part) => Number(part.trim()));
  return values.length === 4 && values.every(Number.isFinite) && values[0] >= 0 && values[0] <= 1 && values[2] >= 0 && values[2] <= 1 ? values : null;
}

/** Where a component token's alias points, for readers that want the name and the value. */
export function describeAlias(config, value, { theme = null } = {}) {
  if (!isAlias(value)) return null;
  const hit = resolveAlias(config, value, { theme });
  return hit.ok ? hit : null;
}

/**
 * Every token of one theme with its final value, no aliases left: what an agent or a script reads when it
 * wants numbers, not a file format. { theme, colors (roles), palettes, status, gradients, fonts, text,
 * spacing, radius, radiusRoles, borders, shadows, durations, easings, breakpoints, zIndex, container, grid }
 */
export function resolvedTokens(config, theme = null) {
  const themes = themesOf(config);
  const name = themes.includes(theme) ? theme : themes[0];
  const colors = {};
  for (const entry of semanticEntries(config, name)) colors[entry.role] = entry.value;
  const text = {};
  for (const [id, style] of Object.entries(config.typography.styles)) {
    text[id] = { fontFamily: fontStack(fontOf(config, style)), size: style.size, mobileSize: style.mobileSize, weight: style.weight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, transform: style.transform };
  }
  return {
    theme: name,
    themes,
    colors,
    palettes: Object.fromEntries(Object.entries(config.colors.palettes).map(([key, palette]) => [key, { ...palette.steps }])),
    status: { ...config.colors.status },
    gradients: Object.fromEntries(config.colors.gradients.map((gradient) => [gradient.name, resolveText(config, gradient.css, { theme: name }).text])),
    fonts: Object.fromEntries(Object.entries(config.typography.fonts).filter(([, font]) => font).map(([key, font]) => [key, fontStack(font)])),
    text,
    spacing: { ...config.layout.spacing.scale },
    radius: { ...config.shape.radius },
    radiusRoles: Object.fromEntries(Object.entries(config.shape.radiusRoles).map(([role, key]) => [role, config.shape.radius[key]])),
    borders: { ...config.shape.borders },
    shadows: Object.fromEntries(Object.entries(config.shape.elevation).map(([key, level]) => [key, level.shadow])),
    durations: { ...config.motion.durations },
    easings: { ...config.motion.easings },
    breakpoints: { ...config.layout.breakpoints },
    zIndex: { ...config.layout.zIndex },
    container: { ...config.layout.container },
    grid: { ...config.layout.grid },
  };
}
