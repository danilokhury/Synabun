// ═══════════════════════════════════════════
// SynaBun — Style Guide color math
// ═══════════════════════════════════════════
//
// Pure functions, no I/O: parse any CSS color the editor is likely to be handed
// (hex, rgb(), hsl(), oklch(), a few names) into hex, convert sRGB ↔ OKLCH,
// build the 11-step scale a palette holds, and measure contrast (WCAG 2.x ratio
// and APCA Lc). Every exporter, the renderer and the contrast route read these.

export const PALETTE_STEPS = Object.freeze(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950']);

const NAMED = Object.freeze({
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  navy: '#000080', teal: '#008080', maroon: '#800000', olive: '#808000', lime: '#00ff00', aqua: '#00ffff',
  cyan: '#00ffff', fuchsia: '#ff00ff', magenta: '#ff00ff', transparent: '#00000000',
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 0) => { const f = 10 ** digits; return Math.round(value * f) / f; };

// Match the entire CSS number, rather than accepting a numeric prefix ("12oops").
const CSS_NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const CHANNEL_RE = new RegExp(`^(${CSS_NUMBER})(%?)$`);
const HUE_RE = new RegExp(`^(${CSS_NUMBER})(deg|rad|grad|turn)?$`);

function numberOf(text, percentScale = 1) {
  const match = CHANNEL_RE.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  return match[2] ? (n / 100) * percentScale : n;
}

function channel(text, scale = 255) {
  const n = numberOf(text, scale);
  return n === null ? null : clamp(n, 0, scale);
}

function alphaOf(text) {
  if (text === undefined) return 1;
  const n = numberOf(text);
  return n === null ? null : clamp(n, 0, 1);
}

/** "a, b, c / d" or "a b c d" → the arguments of a color function. */
function splitArgs(body) {
  const parts = body.trim().split('/');
  if (parts.length > 2) return null;
  const args = parts[0].includes(',') ? parts[0].split(',').map((arg) => arg.trim()) : parts[0].trim().split(/\s+/);
  if (parts.length === 2) {
    if (args.length !== 3 || !parts[1].trim()) return null;
    args.push(parts[1].trim());
  }
  return args.length >= 3 && args.length <= 4 && args.every(Boolean) ? args : null;
}

function hueOf(text) {
  const match = HUE_RE.exec(text);
  if (!match) return null;
  const factor = { deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 }[match[2] || 'deg'];
  const deg = Number(match[1]) * factor;
  if (!Number.isFinite(deg)) return null;
  return ((deg % 360) + 360) % 360;
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

/**
 * Any supported CSS color → { r, g, b, a } (r/g/b 0..255, a 0..1), or null.
 * Supported: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla(), oklch(), basic names,
 * and a bare "H S% L%" triple (the shadcn custom-property form).
 */
export function parseColor(input) {
  if (input && typeof input === 'object') {
    if (![input.r, input.g, input.b].every(Number.isFinite) || (input.a !== undefined && !Number.isFinite(input.a))) return null;
    return { r: clamp(input.r, 0, 255), g: clamp(input.g, 0, 255), b: clamp(input.b, 0, 255), a: input.a === undefined ? 1 : clamp(input.a, 0, 1) };
  }
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (NAMED[text]) return parseColor(NAMED[text]);
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? round(parseInt(h.slice(6, 8), 16) / 255, 3) : 1,
    };
  }
  const fn = /^([a-z]+)\(([^()]*)\)$/.exec(text);
  if (fn) {
    const args = splitArgs(fn[2]);
    if (!args) return null;
    const a = alphaOf(args[3]);
    if (a === null) return null;
    if (fn[1] === 'rgb' || fn[1] === 'rgba') {
      const [r, g, b] = args.slice(0, 3).map((arg) => channel(arg));
      return [r, g, b].includes(null) ? null : { r, g, b, a };
    }
    if (fn[1] === 'hsl' || fn[1] === 'hsla') {
      // Saturation and lightness are percentages; the modern syntax also allows bare numbers 0..100.
      const unit = (arg) => { const n = numberOf(arg); return n === null ? null : clamp(!arg.endsWith('%') && n > 1 ? n / 100 : n, 0, 1); };
      const h = hueOf(args[0]), s = unit(args[1]), l = unit(args[2]);
      return [h, s, l].includes(null) ? null : { ...hslToRgb(h, s, l), a };
    }
    if (fn[1] === 'oklch') {
      const l = numberOf(args[0]), c = numberOf(args[1], 0.4), h = hueOf(args[2]);
      if ([l, c, h].includes(null)) return null;
      const rgb = oklchToSrgb({ l: clamp(l, 0, 1), c: Math.max(0, c), h });
      return { ...rgb, a };
    }
    return null;
  }
  // "222.2 84% 4.9%": an HSL triple without the function (shadcn / Tailwind v3 custom properties).
  const triple = /^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:\s*\/\s*([\d.]+%?))?$/.exec(text);
  if (triple) {
    return parseColor(`hsl(${triple[1]} ${triple[2]}% ${triple[3]}%${triple[4] === undefined ? '' : ` / ${triple[4]}`})`);
  }
  return null;
}

const hex2 = (value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');

/** { r, g, b, a? } → "#rrggbb" (or "#rrggbbaa" when translucent). */
export function rgbToHex(rgb) {
  const base = `#${hex2(rgb.r)}${hex2(rgb.g)}${hex2(rgb.b)}`;
  return Number.isFinite(rgb.a) && rgb.a < 1 ? `${base}${hex2(rgb.a * 255)}` : base;
}

/** Any supported CSS color → lower-case hex, or null when it is not a color. */
export function toHex(input) {
  const rgb = parseColor(input);
  return rgb ? rgbToHex(rgb) : null;
}

export function isColor(input) {
  return parseColor(input) !== null;
}

// ── sRGB ↔ OKLCH (Björn Ottosson's OKLab) ───────────────────────────────────

const toLinear = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const fromLinear = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * (Math.max(v, 0) ** (1 / 2.4)) - 0.055) * 255;

/** { r, g, b } (0..255) → { l (0..1), c (≈0..0.4), h (0..360) }. */
export function srgbToOklch(rgb) {
  const r = toLinear(rgb.r); const g = toLinear(rgb.g); const b = toLinear(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.sqrt(A * A + B * B);
  const h = c < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function oklchToLinear({ l, c, h }) {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (linear) => linear.every((v) => v >= -0.0005 && v <= 1.0005);

/** { l, c, h } → { r, g, b } (0..255). Out-of-gamut colors lose chroma until they fit (hue and lightness kept). */
export function oklchToSrgb(lch) {
  const l = clamp(lch.l, 0, 1);
  let c = Math.max(0, lch.c);
  let linear = oklchToLinear({ l, c, h: lch.h });
  if (!inGamut(linear)) {
    let lo = 0; let hi = c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h: lch.h }))) lo = mid; else hi = mid;
    }
    c = lo;
    linear = oklchToLinear({ l, c, h: lch.h });
  }
  return { r: clamp(fromLinear(linear[0]), 0, 255), g: clamp(fromLinear(linear[1]), 0, 255), b: clamp(fromLinear(linear[2]), 0, 255) };
}

export function hexToOklch(input) {
  const rgb = parseColor(input);
  return rgb ? srgbToOklch(rgb) : null;
}

export function oklchToHex(lch) {
  return rgbToHex(oklchToSrgb(lch));
}

// ── Scales ──────────────────────────────────────────────────────────────────

// How far each step travels from the base toward the light end (50…400) or the dark end (600…950),
// and how much of the base's chroma it keeps.
const LIGHT_T = { 50: 0.95, 100: 0.87, 200: 0.72, 300: 0.52, 400: 0.27 };
const DARK_T = { 600: 0.18, 700: 0.37, 800: 0.56, 900: 0.73, 950: 0.88 };
const CHROMA_T = { 50: 0.14, 100: 0.28, 200: 0.48, 300: 0.7, 400: 0.9, 600: 0.96, 700: 0.86, 800: 0.72, 900: 0.6, 950: 0.46 };

/**
 * An 11-step scale (50…950) around `base`, built in OKLCH so the steps are evenly spaced to the eye.
 * The base is step 500, byte for byte. `hueShift` (degrees) drifts the hue toward the light end
 * (negative half) and the dark end (positive half); `chroma` scales every generated step's saturation.
 * Returns null when `base` is not a color.
 */
export function scaleFromBase(base, { hueShift = 0, chroma = 1 } = {}) {
  const rgb = parseColor(base);
  if (!rgb) return null;
  const baseHex = rgbToHex({ r: rgb.r, g: rgb.g, b: rgb.b });
  const lch = srgbToOklch(rgb);
  const top = lch.l >= 0.985 ? lch.l + (1 - lch.l) * 0.9 : 0.985;
  const bottom = Math.min(0.14, lch.l * 0.6);
  const shift = Number.isFinite(Number(hueShift)) ? Number(hueShift) : 0;
  const factor = Number.isFinite(Number(chroma)) ? Math.max(0, Number(chroma)) : 1;
  const out = {};
  for (const step of PALETTE_STEPS) {
    if (step === '500') { out[step] = baseHex; continue; }
    const light = LIGHT_T[step];
    const t = light ?? DARK_T[step];
    const l = light !== undefined ? lch.l + (top - lch.l) * t : lch.l - (lch.l - bottom) * t;
    const h = (lch.h + (light !== undefined ? -shift * t : shift * t) + 360) % 360;
    out[step] = oklchToHex({ l, c: lch.c * CHROMA_T[step] * factor, h });
  }
  return out;
}

// ── Contrast ────────────────────────────────────────────────────────────────

/** A translucent foreground painted over an opaque background. */
function flatten(fg, bg) {
  if (!(fg.a < 1)) return fg;
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
}

export function relativeLuminance(input) {
  const rgb = parseColor(input);
  if (!rgb) return null;
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG 2.x contrast ratio (1…21), or null when either side is not a color. */
export function wcagContrast(fg, bg) {
  const back = parseColor(bg);
  const front = parseColor(fg);
  if (!back || !front) return null;
  const a = relativeLuminance(flatten(front, back));
  const b = relativeLuminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * APCA lightness contrast Lc (APCA-W3 0.1.9): positive for dark text on a light background,
 * negative for light text on a dark one, 0 below the noise floor. Advisory only.
 */
export function apcaContrast(text, background) {
  const back = parseColor(background);
  const front = parseColor(text);
  if (!back || !front) return null;
  const y = (rgb) => {
    const value = 0.2126729 * (rgb.r / 255) ** 2.4 + 0.7151522 * (rgb.g / 255) ** 2.4 + 0.072175 * (rgb.b / 255) ** 2.4;
    return value > 0.022 ? value : value + (0.022 - value) ** 1.414;
  };
  const yText = y(flatten(front, back));
  const yBg = y(back);
  if (Math.abs(yBg - yText) < 0.0005) return 0;
  if (yBg > yText) {
    const sapc = (yBg ** 0.56 - yText ** 0.57) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (yBg ** 0.65 - yText ** 0.62) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}

/** What the contrast route and the tool return: { ratio, aa, aaa, aaLarge, aaaLarge, apca }. */
export function contrastReport(fg, bg, { size = 'normal' } = {}) {
  const ratio = wcagContrast(fg, bg);
  if (ratio === null) return null;
  const large = String(size) === 'large';
  return {
    ratio: round(ratio, 2),
    aa: ratio >= (large ? 3 : 4.5),
    aaa: ratio >= (large ? 4.5 : 7),
    aaLarge: ratio >= 3,
    aaaLarge: ratio >= 4.5,
    apca: round(apcaContrast(fg, bg), 1),
  };
}

// ── Harmony and dark theme ──────────────────────────────────────────────────

/** Hue rotations of `base` in OKLCH: { complementary: [hex], analogous: [hex, hex], triadic: [hex, hex], splitComplementary: [hex, hex] }. */
export function harmony(base) {
  const lch = hexToOklch(base);
  if (!lch) return null;
  const turn = (deg) => oklchToHex({ l: lch.l, c: lch.c, h: (lch.h + deg + 360) % 360 });
  return {
    complementary: [turn(180)],
    analogous: [turn(-30), turn(30)],
    triadic: [turn(120), turn(240)],
    splitComplementary: [turn(150), turn(210)],
  };
}

const MIRROR = Object.freeze({ 50: '950', 100: '900', 200: '800', 300: '700', 400: '600', 500: '500', 600: '400', 700: '300', 800: '200', 900: '100', 950: '50' });
// A brand color on a dark surface wants to be lighter, never darker.
const BRAND_DARK = Object.freeze({ 50: '900', 100: '800', 200: '700', 300: '600', 400: '500', 500: '400', 600: '300', 700: '300', 800: '200', 900: '200', 950: '100' });
const ALIAS_RE = /^\{([a-z0-9-]+)\.([a-z0-9-]+)\}$/i;

/**
 * A dark semantic map derived from a light one. Aliases to a palette step are mirrored
 * ({neutral.50} → {neutral.950}; brand palettes step lighter: {primary.500} → {primary.400});
 * literal colors get their OKLCH lightness inverted. `neutral` names the palette that mirrors exactly.
 */
export function deriveDarkSemantic(light = {}, { neutral = 'neutral' } = {}) {
  const dark = {};
  for (const [role, value] of Object.entries(light || {})) {
    const text = String(value ?? '');
    const alias = ALIAS_RE.exec(text);
    if (alias && PALETTE_STEPS.includes(alias[2])) {
      const onColor = /^on[A-Z]/.test(role);
      const table = alias[1] === neutral || onColor ? MIRROR : BRAND_DARK;
      dark[role] = `{${alias[1]}.${table[alias[2]]}}`;
      continue;
    }
    const lch = hexToOklch(text);
    if (lch) {
      // White surfaces become the darkest neutral, white-on-color text the darkest neutral too.
      if (lch.c < 0.02 && lch.l > 0.97) { dark[role] = `{${neutral}.950}`; continue; }
      if (lch.c < 0.02 && lch.l < 0.2) { dark[role] = `{${neutral}.50}`; continue; }
      dark[role] = oklchToHex({ l: clamp(1 - lch.l, 0.12, 0.96), c: lch.c * 0.9, h: lch.h });
      continue;
    }
    dark[role] = text;
  }
  return dark;
}
