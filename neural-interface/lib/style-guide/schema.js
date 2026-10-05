// ═══════════════════════════════════════════
// SynaBun — Style Guide schema v2
// ═══════════════════════════════════════════
//
// One JSON per project (docs/style-guide.md, docs/design/style-guide-v2/SPEC.md §3).
// Pure module, no I/O: the defaults, normalizeStyleGuide (fills every missing field
// and migrates the v1 shape), the one alias resolver every renderer and exporter
// uses, RFC 7396 merge patches (what an agent proposal carries) and a leaf diff.
//
// The v1 shape (colors.{primary,…}{50,100,300,500,900}, typography.{heading,body,mono},
// shape.{radius,spacing[],shadows}, logo.{iconLibrary,imageryNotes}) is still what the
// old editor reads and writes. toV1View / withV1Mirror give it that view of a v2
// config; normalizeStyleGuide folds v1 keys back in, but only the values that differ
// from the view, so a stale mirror never reverts a v2 edit.

import { PALETTE_STEPS, scaleFromBase, toHex } from './color.js';

export const SCHEMA_VERSION = 2;
export const STYLE_GUIDE_OUT_DIR = '.synabun/style-guide';
export const CORE_PALETTES = Object.freeze(['primary', 'secondary', 'accent', 'neutral']);
export const SEMANTIC_ROLES = Object.freeze(['background', 'surface', 'surfaceRaised', 'text', 'textMuted', 'border', 'primary', 'onPrimary', 'secondary', 'onSecondary', 'accent', 'onAccent', 'link', 'focus']);
export const STATUS_KEYS = Object.freeze(['success', 'warning', 'danger', 'info']);
export const THEMES = Object.freeze(['light', 'dark']);
export const FONT_KEYS = Object.freeze(['heading', 'body', 'mono', 'display']);
export const FONT_SOURCES = Object.freeze(['google', 'system', 'self-hosted', 'adobe', 'other']);
export const LOGO_KINDS = Object.freeze(['primary', 'mono', 'inverted', 'icon', 'wordmark']);
export const LOGO_BACKGROUNDS = Object.freeze(['primary', 'white', 'dark']);
export const IMAGERY_STYLES = Object.freeze(['photography', 'illustration', '3d', 'abstract', 'mixed']);
export const COMPONENT_CATEGORIES = Object.freeze(['button', 'input', 'card', 'navigation', 'feedback', 'data', 'overlay', 'other']);
export const TAILWIND_TARGETS = Object.freeze(['v4', 'v3', 'none']);
export const DARK_MODES = Object.freeze(['attribute', 'media', 'class']);
/** Task classes whose dispatched worker gets the STYLE GUIDE block by default (SPEC §7). */
export const INJECT_DEFAULTS = Object.freeze({
  code: true, complex: true, design: true, image_gen: true, video_gen: true,
  chat: false, quick: false, review: false, research: false, browser: false, computer: false, automation: false,
});
/** Alias groups that are not palettes; a palette may not take one of these names. */
export const ALIAS_GROUPS = Object.freeze(['status', 'semantic', 'typography', 'spacing', 'radius', 'radiusRoles', 'elevation', 'duration', 'easing']);

const V1_SHADES = Object.freeze(['50', '100', '300', '500', '900']);
const V1_FONTS = Object.freeze(['heading', 'body', 'mono']);
const SPACING_NAMES = Object.freeze(['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']);

// ── small helpers ───────────────────────────────────────────────────────────

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function clone(value, depth = 0, budget = { nodes: 100000 }) {
  if (depth > 64 || --budget.nodes < 0) return undefined;
  if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1, budget));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !UNSAFE_KEYS.has(key)).map(([key, item]) => [key, clone(item, depth + 1, budget)]));
  return typeof value === 'string' ? value.slice(0, 2 * 1024 * 1024) : value;
}
function str(value, max = 2000, fallback = '') {
  if (typeof value === 'string') return value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}
function num(value, fallback, { min = -1e9, max = 1e9 } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
function list(value, fallback = [], { max = 60, len = 600 } = {}) {
  if (!Array.isArray(value)) return [...fallback];
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, len)).slice(0, max);
}
/** A token name: no braces, dots or spaces (DTCG forbids them), at most 40 characters. */
export function tokenKey(value) {
  const key = String(value ?? '').trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return key && !UNSAFE_KEYS.has(key) ? key : '';
}
/** A palette or component id: lower-case kebab. */
export function kebab(value) {
  if (UNSAFE_KEYS.has(String(value ?? '').trim())) return '';
  return String(value ?? '').trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function numMap(value, fallback, range) {
  if (!isPlainObject(value)) return { ...fallback };
  const out = {};
  for (const [rawKey, raw] of Object.entries(value)) {
    const key = tokenKey(rawKey);
    const n = num(typeof raw === 'string' ? raw.replace(/px$/i, '') : raw, null, range);
    if (key && n !== null) out[key] = n;
  }
  return Object.keys(out).length ? out : { ...fallback };
}
function strMap(value, fallback, max = 400) {
  if (!isPlainObject(value)) return { ...fallback };
  const out = {};
  for (const [rawKey, raw] of Object.entries(value)) {
    const key = tokenKey(rawKey);
    if (key && (typeof raw === 'string' || typeof raw === 'number')) out[key] = String(raw).slice(0, max);
  }
  return out;
}
function weights(value, fallback = [400]) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [...new Set(value.map((w) => Math.round(Number(w))).filter((w) => Number.isFinite(w) && w >= 1 && w <= 1000))].sort((a, b) => a - b);
  return out.length ? out : [...fallback];
}

// ── defaults ────────────────────────────────────────────────────────────────

const DEFAULT_PALETTES = Object.freeze({
  primary: { label: 'Primary', usage: 'CTAs, links, focus', base: '#3b82f6' },
  secondary: { label: 'Secondary', usage: 'Supporting actions and highlights', base: '#8b5cf6' },
  accent: { label: 'Accent', usage: 'Emphasis, badges, sparing decoration', base: '#eab308' },
  neutral: { label: 'Neutral', usage: 'Text, surfaces, borders', base: '#64748b' },
});

const DEFAULT_SEMANTIC = Object.freeze({
  light: {
    background: '#ffffff', surface: '{neutral.50}', surfaceRaised: '#ffffff', text: '{neutral.900}', textMuted: '{neutral.500}',
    border: '{neutral.200}', primary: '{primary.500}', onPrimary: '#ffffff', secondary: '{secondary.500}', onSecondary: '#ffffff',
    accent: '{accent.500}', onAccent: '{neutral.900}', link: '{primary.600}', focus: '{primary.500}',
  },
  dark: {
    background: '{neutral.950}', surface: '{neutral.900}', surfaceRaised: '{neutral.800}', text: '{neutral.50}', textMuted: '{neutral.400}',
    border: '{neutral.800}', primary: '{primary.400}', onPrimary: '{neutral.950}', secondary: '{secondary.400}', onSecondary: '{neutral.950}',
    accent: '{accent.400}', onAccent: '{neutral.950}', link: '{primary.300}', focus: '{primary.400}',
  },
});

const DEFAULT_STYLES = Object.freeze({
  display: { font: 'heading', size: 56, mobileSize: 36, weight: 700, lineHeight: 1.05, letterSpacing: -0.02, transform: 'none', usage: 'Hero headline' },
  h1: { font: 'heading', size: 40, mobileSize: 32, weight: 700, lineHeight: 1.1, letterSpacing: -0.02, transform: 'none', usage: 'Page title' },
  h2: { font: 'heading', size: 32, mobileSize: 26, weight: 700, lineHeight: 1.15, letterSpacing: -0.01, transform: 'none', usage: 'Section heading' },
  h3: { font: 'heading', size: 24, mobileSize: 22, weight: 600, lineHeight: 1.25, letterSpacing: -0.01, transform: 'none', usage: 'Subsection heading' },
  h4: { font: 'heading', size: 20, mobileSize: 18, weight: 600, lineHeight: 1.3, letterSpacing: 0, transform: 'none', usage: 'Card and group titles' },
  'body-lg': { font: 'body', size: 18, mobileSize: 18, weight: 400, lineHeight: 1.6, letterSpacing: 0, transform: 'none', usage: 'Lead paragraphs' },
  body: { font: 'body', size: 16, mobileSize: 16, weight: 400, lineHeight: 1.5, letterSpacing: 0, transform: 'none', usage: 'Default text' },
  'body-sm': { font: 'body', size: 14, mobileSize: 14, weight: 400, lineHeight: 1.5, letterSpacing: 0, transform: 'none', usage: 'Secondary text, table cells' },
  caption: { font: 'body', size: 12, mobileSize: 12, weight: 400, lineHeight: 1.4, letterSpacing: 0.01, transform: 'none', usage: 'Captions and helper text' },
  overline: { font: 'body', size: 12, mobileSize: 12, weight: 600, lineHeight: 1.3, letterSpacing: 0.08, transform: 'uppercase', usage: 'Eyebrows and labels above headings' },
  button: { font: 'body', size: 14, mobileSize: 14, weight: 500, lineHeight: 1.2, letterSpacing: 0.01, transform: 'none', usage: 'Buttons and controls' },
  code: { font: 'mono', size: 14, mobileSize: 14, weight: 400, lineHeight: 1.5, letterSpacing: 0, transform: 'none', usage: 'Code and data' },
});

const DEFAULT_COMPONENTS = Object.freeze([
  {
    id: 'button-primary', name: 'Primary button', category: 'button',
    tokens: { background: '{semantic.primary}', text: '{semantic.onPrimary}', typography: '{typography.button}', radius: '{radiusRoles.button}', padding: '8px 16px', shadow: '{elevation.none}', border: '' },
    states: { hover: 'background {primary.600}', active: 'background {primary.700}', focus: '2px solid {semantic.focus}, offset 2px', disabled: 'opacity 0.5, no pointer events' },
    notes: 'One primary action per view.',
  },
  {
    id: 'button-secondary', name: 'Secondary button', category: 'button',
    tokens: { background: '{semantic.surface}', text: '{semantic.text}', typography: '{typography.button}', radius: '{radiusRoles.button}', padding: '8px 16px', shadow: '{elevation.none}', border: '1px solid {semantic.border}' },
    states: { hover: 'background {neutral.100}', active: 'background {neutral.200}', focus: '2px solid {semantic.focus}, offset 2px', disabled: 'opacity 0.5, no pointer events' },
    notes: '',
  },
  {
    id: 'input-text', name: 'Text input', category: 'input',
    tokens: { background: '{semantic.surfaceRaised}', text: '{semantic.text}', typography: '{typography.body}', radius: '{radiusRoles.input}', padding: '8px 12px', shadow: '{elevation.none}', border: '1px solid {semantic.border}' },
    states: { hover: 'border {neutral.300}', active: '', focus: 'border {semantic.focus}, 2px ring {semantic.focus}', disabled: 'background {semantic.surface}, text {semantic.textMuted}' },
    notes: 'Always paired with a visible label.',
  },
  {
    id: 'card', name: 'Card', category: 'card',
    tokens: { background: '{semantic.surface}', text: '{semantic.text}', typography: '{typography.body}', radius: '{radiusRoles.card}', padding: '{spacing.xl}', shadow: '{elevation.sm}', border: '1px solid {semantic.border}' },
    states: { hover: 'shadow {elevation.md} when the whole card is a link', active: '', focus: '2px solid {semantic.focus}, offset 2px', disabled: '' },
    notes: '',
  },
]);

function defaultPalettes() {
  const out = {};
  for (const [key, palette] of Object.entries(DEFAULT_PALETTES)) {
    out[key] = { label: palette.label, usage: palette.usage, base: palette.base, locked: false, steps: scaleFromBase(palette.base) };
  }
  return out;
}

/** The complete v2 config a project starts from. Deterministic except `updatedAt`, which the caller may pass. */
export function defaultStyleGuide(projectPath = '', { updatedAt = null } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectPath: String(projectPath || ''),
    updatedAt: updatedAt || null,
    revision: 0,
    brand: { name: '', tagline: '', description: '', audience: '', personality: [], vibe: '', keyCharacteristics: [], voice: { tone: '', dos: [], donts: [] } },
    colors: {
      palettes: defaultPalettes(),
      semantic: clone(DEFAULT_SEMANTIC),
      status: { success: '#22c55e', warning: '#f59e0b', danger: '#ef4444', info: '#0ea5e9' },
      gradients: [{ name: 'hero', css: 'linear-gradient(135deg, {primary.500}, {secondary.500})', usage: 'Hero and marketing backgrounds' }],
      themes: { default: 'light', supports: ['light', 'dark'] },
    },
    typography: {
      fonts: {
        heading: { family: 'Space Grotesk', fallback: 'system-ui, sans-serif', source: 'google', weights: [600, 700], features: '' },
        body: { family: 'Inter', fallback: 'system-ui, sans-serif', source: 'google', weights: [400, 500], features: '' },
        mono: { family: 'JetBrains Mono', fallback: 'ui-monospace, monospace', source: 'google', weights: [400], features: '' },
        display: null,
      },
      scale: { base: 16, ratio: 1.25, preset: 'major-third' },
      styles: clone(DEFAULT_STYLES),
      principles: [],
    },
    layout: {
      spacing: { base: 4, scale: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32, '3xl': 48, '4xl': 64 } },
      breakpoints: { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 },
      container: { maxWidth: 1200, padding: 24 },
      grid: { columns: 12, gutter: 24 },
      zIndex: { dropdown: 1000, sticky: 1100, overlay: 1200, modal: 1300, popover: 1400, toast: 1500 },
      principles: [],
    },
    shape: {
      radius: { none: 0, sm: 4, md: 8, lg: 12, xl: 16, pill: 9999 },
      radiusRoles: { button: 'md', card: 'lg', input: 'sm', badge: 'pill', modal: 'xl' },
      borders: { thin: 1, thick: 2 },
      elevation: {
        none: { shadow: 'none', usage: 'Flat surfaces' },
        sm: { shadow: '0 1px 2px rgba(0,0,0,.06)', usage: 'Cards' },
        md: { shadow: '0 4px 12px rgba(0,0,0,.10)', usage: 'Dropdowns, popovers' },
        lg: { shadow: '0 12px 32px rgba(0,0,0,.18)', usage: 'Modals' },
      },
    },
    motion: {
      durations: { fast: 150, normal: 250, slow: 400 },
      easings: { standard: 'cubic-bezier(0.2, 0, 0, 1)', enter: 'cubic-bezier(0, 0, 0.2, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' },
      reducedMotion: 'respect',
      principles: [],
    },
    iconography: { library: 'lucide', style: 'outline', strokeWidth: 1.5, sizes: [16, 20, 24], notes: '' },
    logo: { variants: [], clearSpace: '', minSize: { px: 24 }, donts: [], favicon: null },
    imagery: {
      style: 'photography', mood: '', notes: '', dos: [], donts: [],
      generation: { promptPrefix: '', negativePrompt: '', aspectRatios: ['16:9', '1:1'], styleReferences: [] },
    },
    components: clone(DEFAULT_COMPONENTS),
    accessibility: { level: 'AA', minContrastText: 4.5, minContrastLarge: 3, minTouchTarget: 44, focusRing: '2px solid {semantic.focus}, offset 2px', notes: [] },
    rules: { dos: [], donts: [], custom: '' },
    responsive: { notes: [] },
    agents: { inject: { ...INJECT_DEFAULTS }, instructions: '', allowProposals: true },
    exports: { designMd: true, tokensJson: true, cssVars: true, tailwind: 'v4', outDir: STYLE_GUIDE_OUT_DIR, cssSelector: ':root', darkMode: 'attribute', projectPointers: false },
  };
}

/** Frozen defaults for readers that only need to look (the UI's reset buttons, tests). */
export const DEFAULTS = Object.freeze(defaultStyleGuide(''));

/** Sizes for the main text styles from a base size and a modular ratio (the editor's scale generator). */
export function typeScale(base = 16, ratio = 1.25) {
  const b = num(base, 16, { min: 8, max: 40 });
  const r = num(ratio, 1.25, { min: 1.05, max: 2 });
  const at = (power) => Math.round(b * r ** power);
  return { caption: Math.round(b * 0.75), 'body-sm': Math.round(b * 0.875), body: b, 'body-lg': Math.round(b * 1.125), h4: at(1), h3: at(2), h2: at(3), h1: at(4), display: at(5) };
}

// ── normalize ───────────────────────────────────────────────────────────────

function normColor(value, fallback) {
  // Schema color fields are strings. Reject hostile objects before color.js can coerce them.
  const hex = typeof value === 'string' ? toHex(value) : null;
  return hex && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(hex) ? hex : fallback;
}
/** A semantic / gradient value: an alias is kept as written, a color becomes hex. */
function normColorRef(value, fallback) {
  if (typeof value === 'string' && /^\{[a-z0-9-]+\.[a-z0-9-]+\}$/i.test(value.trim())) return value.trim();
  return normColor(value, fallback);
}

function normPalette(value, fallback) {
  const src = isPlainObject(value) ? value : {};
  const rawSteps = isPlainObject(src.steps) ? src.steps : {};
  const base = normColor(src.base, null) || normColor(rawSteps['500'], null) || fallback?.base || '#64748b';
  const generated = scaleFromBase(base) || {};
  const steps = {};
  for (const step of PALETTE_STEPS) steps[step] = normColor(rawSteps[step], null) || fallback?.steps?.[step] || generated[step];
  // The fallback's steps belong to the fallback's base: a new base gets its own scale.
  if (fallback && base !== fallback.base) for (const step of PALETTE_STEPS) steps[step] = normColor(rawSteps[step], null) || generated[step];
  steps['500'] = base.slice(0, 7);
  return {
    label: str(src.label, 60) || fallback?.label || '',
    usage: str(src.usage, 300, fallback?.usage || ''),
    base: base.slice(0, 7),
    locked: bool(src.locked, false),
    steps,
  };
}

function normFont(value, fallback) {
  const src = isPlainObject(value) ? value : {};
  return {
    family: str(src.family, 120).trim() || fallback.family,
    fallback: str(src.fallback, 200, fallback.fallback),
    source: oneOf(src.source, FONT_SOURCES, fallback.source),
    weights: weights(src.weights, fallback.weights),
    features: str(src.features, 200, fallback.features || ''),
  };
}

function normStyle(value, fallback, fonts) {
  const src = isPlainObject(value) ? value : {};
  const size = num(src.size, fallback.size, { min: 4, max: 400 });
  const font = FONT_KEYS.includes(src.font) && fonts[src.font] ? src.font : (fonts[fallback.font] ? fallback.font : 'body');
  return {
    font,
    size,
    // Without a mobile size of its own: a known style keeps its default one (never above the size), any other the size itself.
    mobileSize: num(src.mobileSize, fallback === GENERIC_STYLE ? size : (src.size === undefined ? fallback.mobileSize : Math.min(size, fallback.mobileSize)), { min: 4, max: 400 }),
    weight: num(src.weight, fallback.weight, { min: 1, max: 1000 }),
    lineHeight: num(src.lineHeight, fallback.lineHeight, { min: 0.5, max: 4 }),
    letterSpacing: num(src.letterSpacing, fallback.letterSpacing, { min: -0.5, max: 2 }),
    transform: oneOf(src.transform, ['none', 'uppercase', 'lowercase', 'capitalize'], fallback.transform),
    usage: str(src.usage, 300, fallback.usage),
  };
}

const GENERIC_STYLE = Object.freeze({ font: 'body', size: 16, mobileSize: 16, weight: 400, lineHeight: 1.5, letterSpacing: 0, transform: 'none', usage: '' });

function normComponent(value) {
  const src = isPlainObject(value) ? value : {};
  const id = kebab(src.id || src.name);
  if (!id) return null;
  const states = { hover: '', active: '', focus: '', disabled: '', ...strMap(src.states, {}, 300) };
  return {
    id,
    name: str(src.name, 80) || id,
    category: oneOf(src.category, COMPONENT_CATEGORIES, 'other'),
    tokens: strMap(src.tokens, {}, 300),
    states,
    notes: str(src.notes, 1000),
  };
}

function normVariant(value) {
  const src = isPlainObject(value) ? value : {};
  const id = String(src.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  if (!id) return null;
  const file = /^[A-Za-z0-9._-]{1,120}$/.test(String(src.file || '')) && !String(src.file).includes('..') ? String(src.file) : '';
  return { id, name: str(src.name, 80) || 'Variant', kind: oneOf(src.kind, LOGO_KINDS, 'primary'), file, bg: oneOf(src.bg, LOGO_BACKGROUNDS, 'primary') };
}

/** A project-relative folder for the token files: no absolute path, no `..`, forward slashes. */
export function safeOutDir(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!text || text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.split('/').some((part) => part === '..' || part === '' || part === '.git')) return STYLE_GUIDE_OUT_DIR;
  return /^[A-Za-z0-9._\-/ ]{1,120}$/.test(text) ? text : STYLE_GUIDE_OUT_DIR;
}

/** The v1 keys of a config, cut out of it (the config is mutated). */
function takeLegacy(src) {
  const legacy = {};
  if (isPlainObject(src.colors)) {
    for (const role of CORE_PALETTES) {
      if (isPlainObject(src.colors[role])) { (legacy.colors ||= {})[role] = src.colors[role]; delete src.colors[role]; }
    }
  }
  if (isPlainObject(src.typography)) {
    for (const key of V1_FONTS) {
      if (isPlainObject(src.typography[key])) { (legacy.typography ||= {})[key] = src.typography[key]; delete src.typography[key]; }
    }
  }
  if (isPlainObject(src.shape)) {
    if (Array.isArray(src.shape.spacing)) { (legacy.shape ||= {}).spacing = src.shape.spacing; delete src.shape.spacing; }
    if (isPlainObject(src.shape.shadows)) { (legacy.shape ||= {}).shadows = src.shape.shadows; delete src.shape.shadows; }
  }
  if (isPlainObject(src.logo)) {
    if (typeof src.logo.iconLibrary === 'string') { (legacy.logo ||= {}).iconLibrary = src.logo.iconLibrary; delete src.logo.iconLibrary; }
    if (typeof src.logo.imageryNotes === 'string') { (legacy.logo ||= {}).imageryNotes = src.logo.imageryNotes; delete src.logo.imageryNotes; }
  }
  return legacy;
}

/** The v1 editor's view of a normalized v2 config. */
export function toV1View(config) {
  const colors = { status: { ...config.colors.status } };
  for (const role of CORE_PALETTES) {
    colors[role] = Object.fromEntries(V1_SHADES.map((shade) => [shade, config.colors.palettes[role].steps[shade]]));
  }
  const fonts = config.typography.fonts;
  const styles = config.typography.styles;
  const shadows = {};
  for (const [key, level] of Object.entries(config.shape.elevation)) if (level.shadow && level.shadow !== 'none') shadows[key] = level.shadow;
  return {
    colors,
    typography: {
      heading: { family: fonts.heading.family, weights: [...fonts.heading.weights], scale: Object.fromEntries(['h1', 'h2', 'h3', 'h4'].filter((id) => styles[id]).map((id) => [id, styles[id].size])) },
      body: { family: fonts.body.family, weights: [...fonts.body.weights], size: styles.body.size, lineHeight: styles.body.lineHeight },
      mono: { family: fonts.mono.family, weights: [...fonts.mono.weights] },
    },
    shape: { radius: { ...config.shape.radius }, spacing: Object.values(config.layout.spacing.scale), shadows },
    logo: { variants: clone(config.logo.variants), iconLibrary: config.iconography.library, imageryNotes: config.imagery.notes },
  };
}

/** A v2 config with the v1 keys added beside the v2 ones: what the old editor is given (`compat=v1`). */
export function withV1Mirror(config) {
  const out = clone(config);
  const view = toV1View(config);
  for (const role of CORE_PALETTES) out.colors[role] = view.colors[role];
  for (const key of V1_FONTS) out.typography[key] = view.typography[key];
  out.shape.spacing = view.shape.spacing;
  out.shape.shadows = view.shape.shadows;
  out.logo.iconLibrary = view.logo.iconLibrary;
  out.logo.imageryNotes = view.logo.imageryNotes;
  return out;
}

/** True when the config carries any v1 key (a v1 file, or the old editor's save of a mirrored config). */
export function hasLegacyKeys(config) {
  if (!isPlainObject(config)) return false;
  return CORE_PALETTES.some((role) => isPlainObject(config.colors?.[role]))
    || V1_FONTS.some((key) => isPlainObject(config.typography?.[key]))
    || Array.isArray(config.shape?.spacing) || isPlainObject(config.shape?.shadows)
    || typeof config.logo?.iconLibrary === 'string' || typeof config.logo?.imageryNotes === 'string';
}

/** Fold v1 values into a normalized v2 config: only the ones that differ from its own v1 view. */
function applyLegacy(config, legacy) {
  const view = toV1View(config);
  for (const role of CORE_PALETTES) {
    const incoming = legacy.colors?.[role];
    if (!isPlainObject(incoming)) continue;
    const palette = config.colors.palettes[role];
    const changed = {};
    for (const [shade, value] of Object.entries(incoming)) {
      const hex = normColor(value, null);
      if (hex && PALETTE_STEPS.includes(shade) && hex !== view.colors[role][shade]) changed[shade] = hex;
    }
    if (changed['500']) {
      palette.base = changed['500'].slice(0, 7);
      // The steps v1 never held follow the new base; the five it held are the editor's to set.
      const generated = scaleFromBase(palette.base);
      for (const step of PALETTE_STEPS) if (!V1_SHADES.includes(step)) palette.steps[step] = generated[step];
    }
    Object.assign(palette.steps, changed);
  }
  const typo = config.typography;
  for (const key of V1_FONTS) {
    const incoming = legacy.typography?.[key];
    if (!isPlainObject(incoming)) continue;
    const family = str(incoming.family, 120).trim();
    if (family && family !== view.typography[key].family) typo.fonts[key].family = family;
    if (Array.isArray(incoming.weights)) {
      const next = weights(incoming.weights, typo.fonts[key].weights);
      if (JSON.stringify(next) !== JSON.stringify(view.typography[key].weights)) typo.fonts[key].weights = next;
    }
  }
  const headingScale = legacy.typography?.heading?.scale;
  if (isPlainObject(headingScale)) {
    for (const id of ['h1', 'h2', 'h3', 'h4']) {
      const size = num(headingScale[id], null, { min: 4, max: 400 });
      if (size === null || size === view.typography.heading.scale[id]) continue;
      typo.styles[id] = { ...(typo.styles[id] || DEFAULT_STYLES[id]), size, mobileSize: Math.min(size, typo.styles[id]?.mobileSize ?? size) };
    }
  }
  const body = legacy.typography?.body;
  if (isPlainObject(body)) {
    const size = num(body.size, null, { min: 4, max: 400 });
    if (size !== null && size !== view.typography.body.size) { typo.styles.body.size = size; typo.styles.body.mobileSize = size; typo.scale.base = size; }
    const lineHeight = num(body.lineHeight, null, { min: 0.5, max: 4 });
    if (lineHeight !== null && lineHeight !== view.typography.body.lineHeight) typo.styles.body.lineHeight = lineHeight;
  }
  if (Array.isArray(legacy.shape?.spacing)) {
    const values = legacy.shape.spacing.map((v) => num(v, null, { min: 0, max: 4000 })).filter((v) => v !== null).slice(0, 24);
    if (values.length && JSON.stringify(values) !== JSON.stringify(view.shape.spacing)) {
      const names = Object.keys(config.layout.spacing.scale);
      const scale = {};
      values.forEach((value, index) => {
        let name = names[index] || SPACING_NAMES[index] || `s${index + 1}`;
        while (name in scale) name = `${name}-${index + 1}`;
        scale[name] = value;
      });
      config.layout.spacing.scale = scale;
    }
  }
  if (isPlainObject(legacy.shape?.shadows)) {
    for (const [rawKey, value] of Object.entries(legacy.shape.shadows)) {
      const key = tokenKey(rawKey);
      if (!key || typeof value !== 'string' || !value.trim() || value === view.shape.shadows[key]) continue;
      config.shape.elevation[key] = { shadow: value.trim().slice(0, 400), usage: config.shape.elevation[key]?.usage || '' };
    }
  }
  if (typeof legacy.logo?.iconLibrary === 'string' && legacy.logo.iconLibrary.trim() && legacy.logo.iconLibrary !== view.logo.iconLibrary) {
    config.iconography.library = legacy.logo.iconLibrary.trim().slice(0, 80);
  }
  if (typeof legacy.logo?.imageryNotes === 'string' && legacy.logo.imageryNotes !== view.logo.imageryNotes) {
    config.imagery.notes = legacy.logo.imageryNotes.slice(0, 4000);
  }
}

/**
 * Any config → a complete, valid v2 config. Never throws: a missing or malformed field takes its
 * default, unknown keys are dropped, and a v1 file (or the old editor's save) is migrated.
 * `projectPath` wins over the one in the file.
 */
export function normalizeStyleGuide(input, { projectPath = null } = {}) {
  const src = isPlainObject(input) ? clone(input) : {};
  const wasV2 = Number(src.schemaVersion) >= SCHEMA_VERSION;
  const legacy = takeLegacy(src);
  const d = defaultStyleGuide(projectPath ?? (typeof src.projectPath === 'string' ? src.projectPath : ''));
  const out = { schemaVersion: SCHEMA_VERSION, projectPath: d.projectPath };
  out.updatedAt = typeof src.updatedAt === 'string' && src.updatedAt ? src.updatedAt.slice(0, 40) : null;
  out.revision = Math.max(0, Math.floor(num(src.revision, 0)));

  const brand = isPlainObject(src.brand) ? src.brand : {};
  const voice = isPlainObject(brand.voice) ? brand.voice : {};
  out.brand = {
    name: str(brand.name, 120), tagline: str(brand.tagline, 200), description: str(brand.description, 1200), audience: str(brand.audience, 600),
    personality: list(brand.personality, [], { max: 12, len: 40 }), vibe: str(brand.vibe, 1200),
    keyCharacteristics: list(brand.keyCharacteristics, [], { max: 12, len: 240 }),
    voice: { tone: str(voice.tone, 400), dos: list(voice.dos, [], { max: 20 }), donts: list(voice.donts, [], { max: 20 }) },
  };

  // ── colors ──
  const colors = isPlainObject(src.colors) ? src.colors : {};
  const palettes = {};
  const rawPalettes = isPlainObject(colors.palettes) ? colors.palettes : {};
  for (const key of CORE_PALETTES) palettes[key] = normPalette(rawPalettes[key], d.colors.palettes[key]);
  for (const [rawKey, value] of Object.entries(rawPalettes)) {
    let key = kebab(rawKey);
    if (!key || CORE_PALETTES.includes(key)) continue;
    if (ALIAS_GROUPS.some((group) => group.toLowerCase() === key) || THEMES.includes(key)) key = `${key}-palette`.slice(0, 40);
    if (Object.keys(palettes).length >= 24) break;
    palettes[key] = normPalette(value, null);
    if (!palettes[key].label) palettes[key].label = key.replace(/(^|-)([a-z])/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase());
  }
  // Core palettes keep the order they had in the file (ordered map), then the defaults' order.
  const ordered = {};
  for (const rawKey of Object.keys(rawPalettes)) { const key = kebab(rawKey); if (palettes[key] && !(key in ordered)) ordered[key] = palettes[key]; }
  for (const key of Object.keys(palettes)) if (!(key in ordered)) ordered[key] = palettes[key];
  const semantic = {};
  for (const theme of THEMES) {
    const raw = isPlainObject(colors.semantic?.[theme]) ? colors.semantic[theme] : {};
    semantic[theme] = {};
    for (const role of SEMANTIC_ROLES) semantic[theme][role] = normColorRef(raw[role], d.colors.semantic[theme][role]);
    for (const [rawKey, value] of Object.entries(raw)) {
      const role = tokenKey(rawKey);
      if (!role || role in semantic[theme] || Object.keys(semantic[theme]).length >= 40) continue;
      const ref = normColorRef(value, null);
      if (ref) semantic[theme][role] = ref;
    }
  }
  const status = {};
  const rawStatus = isPlainObject(colors.status) ? colors.status : {};
  for (const key of STATUS_KEYS) status[key] = normColor(rawStatus[key], d.colors.status[key]);
  for (const [rawKey, value] of Object.entries(rawStatus)) {
    const key = tokenKey(rawKey);
    const hex = normColor(value, null);
    if (key && !(key in status) && hex && Object.keys(status).length < 16) status[key] = hex;
  }
  const gradients = Array.isArray(colors.gradients)
    ? colors.gradients.filter(isPlainObject).map((g) => ({ name: tokenKey(g.name) || 'gradient', css: str(g.css, 600), usage: str(g.usage, 300) })).filter((g) => g.css).slice(0, 12)
    : clone(d.colors.gradients);
  const rawThemes = isPlainObject(colors.themes) ? colors.themes : {};
  let supports = Array.isArray(rawThemes.supports) ? THEMES.filter((theme) => rawThemes.supports.includes(theme)) : [...d.colors.themes.supports];
  if (!supports.length) supports = [...d.colors.themes.supports];
  const defaultTheme = supports.includes(rawThemes.default) ? rawThemes.default : supports[0];
  out.colors = { palettes: ordered, semantic, status, gradients, themes: { default: defaultTheme, supports } };

  // ── typography ──
  const typo = isPlainObject(src.typography) ? src.typography : {};
  const rawFonts = isPlainObject(typo.fonts) ? typo.fonts : {};
  const fonts = {
    heading: normFont(rawFonts.heading, d.typography.fonts.heading),
    body: normFont(rawFonts.body, d.typography.fonts.body),
    mono: normFont(rawFonts.mono, d.typography.fonts.mono),
    display: isPlainObject(rawFonts.display) && str(rawFonts.display.family).trim() ? normFont(rawFonts.display, d.typography.fonts.heading) : null,
  };
  const rawScale = isPlainObject(typo.scale) ? typo.scale : {};
  const styles = {};
  const rawStyles = isPlainObject(typo.styles) && Object.keys(typo.styles).length ? typo.styles : DEFAULT_STYLES;
  for (const [rawKey, value] of Object.entries(rawStyles)) {
    const id = kebab(rawKey);
    if (!id || id in styles || Object.keys(styles).length >= 40) continue;
    styles[id] = normStyle(value, DEFAULT_STYLES[id] || GENERIC_STYLE, fonts);
  }
  if (!styles.body) styles.body = normStyle({}, DEFAULT_STYLES.body, fonts);
  out.typography = {
    fonts,
    scale: { base: num(rawScale.base, 16, { min: 8, max: 40 }), ratio: num(rawScale.ratio, 1.25, { min: 1, max: 2 }), preset: str(rawScale.preset, 40, 'major-third') || 'custom' },
    styles,
    principles: list(typo.principles, [], { max: 20 }),
  };

  // ── layout ──
  const layout = isPlainObject(src.layout) ? src.layout : {};
  const rawSpacing = isPlainObject(layout.spacing) ? layout.spacing : {};
  out.layout = {
    spacing: { base: num(rawSpacing.base, 4, { min: 1, max: 64 }), scale: numMap(rawSpacing.scale, d.layout.spacing.scale, { min: 0, max: 4000 }) },
    breakpoints: numMap(layout.breakpoints, d.layout.breakpoints, { min: 0, max: 10000 }),
    container: { maxWidth: num(layout.container?.maxWidth, 1200, { min: 200, max: 10000 }), padding: num(layout.container?.padding, 24, { min: 0, max: 400 }) },
    grid: { columns: Math.round(num(layout.grid?.columns, 12, { min: 1, max: 24 })), gutter: num(layout.grid?.gutter, 24, { min: 0, max: 400 }) },
    zIndex: numMap(layout.zIndex, d.layout.zIndex, { min: -10, max: 2147483647 }),
    principles: list(layout.principles, [], { max: 20 }),
  };

  // ── shape ──
  const shape = isPlainObject(src.shape) ? src.shape : {};
  let radius = numMap(shape.radius, d.shape.radius, { min: 0, max: 9999 });
  // A v1 file's radius is keyed by role (pill, button, card, small): keep the values and add the flat zero.
  if (!wasV2 && isPlainObject(shape.radius) && !('none' in radius)) radius = { none: 0, ...radius };
  const rawRoles = isPlainObject(shape.radiusRoles) ? shape.radiusRoles : {};
  // A role names a step of the radius scale. One that names nothing takes the step called like the role
  // (v1 scales were keyed by role), then the v1 name for it, then the step closest to the default size.
  const roleFallback = { input: 'small', modal: 'card' };
  const closest = (px) => Object.keys(radius).reduce((best, name) => (Math.abs(radius[name] - px) < Math.abs(radius[best] - px) ? name : best), Object.keys(radius)[0]);
  const radiusRoles = {};
  for (const role of [...new Set([...Object.keys(d.shape.radiusRoles), ...Object.keys(rawRoles).map(tokenKey).filter(Boolean)])].slice(0, 24)) {
    const wanted = [rawRoles[role], role, roleFallback[role], d.shape.radiusRoles[role]].find((name) => typeof name === 'string' && name in radius);
    radiusRoles[role] = wanted || closest(d.shape.radius[d.shape.radiusRoles[role]] ?? 8);
  }
  const elevation = {};
  const rawElevation = isPlainObject(shape.elevation) && Object.keys(shape.elevation).length ? shape.elevation : d.shape.elevation;
  for (const [rawKey, value] of Object.entries(rawElevation)) {
    const key = tokenKey(rawKey);
    if (!key || Object.keys(elevation).length >= 16) continue;
    if (typeof value === 'string') elevation[key] = { shadow: value.slice(0, 400), usage: '' };
    else if (isPlainObject(value)) elevation[key] = { shadow: str(value.shadow, 400, 'none') || 'none', usage: str(value.usage, 300) };
  }
  out.shape = { radius, radiusRoles, borders: numMap(shape.borders, d.shape.borders, { min: 0, max: 64 }), elevation };

  // ── motion, icons, logo, imagery ──
  const motion = isPlainObject(src.motion) ? src.motion : {};
  const easings = strMap(motion.easings, d.motion.easings, 120);
  out.motion = {
    durations: numMap(motion.durations, d.motion.durations, { min: 0, max: 60000 }),
    easings: Object.keys(easings).length ? easings : { ...d.motion.easings },
    reducedMotion: oneOf(motion.reducedMotion, ['respect', 'ignore'], 'respect'),
    principles: list(motion.principles, [], { max: 20 }),
  };
  const icons = isPlainObject(src.iconography) ? src.iconography : {};
  out.iconography = {
    library: str(icons.library, 80).trim() || d.iconography.library,
    style: str(icons.style, 40).trim() || d.iconography.style,
    strokeWidth: num(icons.strokeWidth, 1.5, { min: 0, max: 8 }),
    sizes: Array.isArray(icons.sizes) && icons.sizes.length ? icons.sizes.map((s) => num(s, null, { min: 4, max: 512 })).filter((s) => s !== null).slice(0, 12) : [...d.iconography.sizes],
    notes: str(icons.notes, 2000),
  };
  if (!out.iconography.sizes.length) out.iconography.sizes = [...d.iconography.sizes];
  const logo = isPlainObject(src.logo) ? src.logo : {};
  out.logo = {
    variants: (Array.isArray(logo.variants) ? logo.variants : []).map(normVariant).filter(Boolean).slice(0, 24),
    clearSpace: str(logo.clearSpace, 400),
    minSize: { px: num(logo.minSize?.px, 24, { min: 1, max: 2000 }) },
    donts: list(logo.donts, [], { max: 20 }),
    favicon: typeof logo.favicon === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(logo.favicon) ? logo.favicon : null,
  };
  const imagery = isPlainObject(src.imagery) ? src.imagery : {};
  const generation = isPlainObject(imagery.generation) ? imagery.generation : {};
  out.imagery = {
    style: oneOf(imagery.style, IMAGERY_STYLES, 'photography'), mood: str(imagery.mood, 600), notes: str(imagery.notes, 4000),
    dos: list(imagery.dos, [], { max: 20 }), donts: list(imagery.donts, [], { max: 20 }),
    generation: {
      promptPrefix: str(generation.promptPrefix, 1200), negativePrompt: str(generation.negativePrompt, 1200),
      aspectRatios: Array.isArray(generation.aspectRatios) ? list(generation.aspectRatios, [], { max: 8, len: 12 }) : [...d.imagery.generation.aspectRatios],
      styleReferences: list(generation.styleReferences, [], { max: 12, len: 400 }),
    },
  };

  // ── components, accessibility, rules ──
  const seen = new Set();
  out.components = (Array.isArray(src.components) ? src.components : DEFAULT_COMPONENTS).map(normComponent)
    .filter((c) => c && !seen.has(c.id) && seen.add(c.id)).slice(0, 60);
  const a11y = isPlainObject(src.accessibility) ? src.accessibility : {};
  out.accessibility = {
    level: oneOf(a11y.level, ['A', 'AA', 'AAA'], 'AA'),
    minContrastText: num(a11y.minContrastText, 4.5, { min: 1, max: 21 }),
    minContrastLarge: num(a11y.minContrastLarge, 3, { min: 1, max: 21 }),
    minTouchTarget: num(a11y.minTouchTarget, 44, { min: 16, max: 96 }),
    focusRing: str(a11y.focusRing, 300, d.accessibility.focusRing),
    notes: list(a11y.notes, [], { max: 20 }),
  };
  const rules = isPlainObject(src.rules) ? src.rules : {};
  out.rules = { dos: list(rules.dos, [], { max: 40 }), donts: list(rules.donts, [], { max: 40 }), custom: str(rules.custom, 20000) };
  out.responsive = { notes: list(src.responsive?.notes, [], { max: 20 }) };

  // ── agents, exports ──
  const agents = isPlainObject(src.agents) ? src.agents : {};
  const inject = {};
  for (const [key, fallback] of Object.entries(INJECT_DEFAULTS)) inject[key] = bool(agents.inject?.[key], fallback);
  out.agents = { inject, instructions: str(agents.instructions, 2000), allowProposals: bool(agents.allowProposals, true) };
  const exports_ = isPlainObject(src.exports) ? src.exports : {};
  const selector = str(exports_.cssSelector, 80).trim();
  out.exports = {
    designMd: bool(exports_.designMd, true), tokensJson: bool(exports_.tokensJson, true), cssVars: bool(exports_.cssVars, true),
    tailwind: oneOf(exports_.tailwind, TAILWIND_TARGETS, 'v4'),
    outDir: safeOutDir(exports_.outDir ?? STYLE_GUIDE_OUT_DIR),
    cssSelector: /^[:.#\[\]="'a-zA-Z0-9_\- ]{1,80}$/.test(selector) ? selector : ':root',
    darkMode: oneOf(exports_.darkMode, DARK_MODES, 'attribute'),
    projectPointers: bool(exports_.projectPointers, false),
  };

  if (Object.keys(legacy).length) applyLegacy(out, legacy);
  return out;
}

// ── aliases ─────────────────────────────────────────────────────────────────

const ALIAS_ONLY_RE = /^\{([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)\}$/;
const ALIAS_ANY_RE = /\{([A-Za-z0-9-]+)\.([A-Za-z0-9-]+)\}/g;

export function isAlias(value) {
  return typeof value === 'string' && ALIAS_ONLY_RE.test(value.trim());
}
/** "{group.key}" → { group, key }, or null. */
export function parseAlias(value) {
  const match = typeof value === 'string' ? ALIAS_ONLY_RE.exec(value.trim()) : null;
  return match ? { group: match[1], key: match[2] } : null;
}

/**
 * The one alias resolver (SPEC §3). "{primary.500}" → { ok, kind, value, group, key }:
 *   color      a hex            ({palette.step}, {status.x}, {semantic.role} for `theme`)
 *   typography a text style     ({typography.id})
 *   dimension  a number in px   ({spacing.x}, {radius.x}, {radiusRoles.x})
 *   shadow     a CSS box-shadow ({elevation.x})
 *   duration   a number in ms   ({duration.x})
 *   easing     a CSS easing     ({easing.x})
 * `via` names the scale token a role points at ({radiusRoles.button} → via "md"). Unknown → { ok: false }.
 */
export function resolveAlias(config, ref, { theme = null, depth = 0 } = {}) {
  const alias = parseAlias(typeof ref === 'string' && !ref.trim().startsWith('{') ? `{${ref.trim()}}` : ref);
  if (!alias || !isPlainObject(config) || depth > 6) return { ok: false };
  const { group, key } = alias;
  const hit = (kind, value, extra = {}) => (value === undefined || value === null ? { ok: false } : { ok: true, kind, value, group, key, ...extra });
  const own = (map) => (isPlainObject(map) && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined);
  switch (group) {
    case 'status': return hit('color', own(config.colors?.status));
    case 'semantic': {
      const name = THEMES.includes(theme) ? theme : (config.colors?.themes?.default || 'light');
      const value = own(config.colors?.semantic?.[name]);
      if (value === undefined) return { ok: false };
      if (isAlias(value)) {
        const inner = resolveAlias(config, value, { theme: name, depth: depth + 1 });
        return inner.ok && inner.kind === 'color' ? { ...inner, group, key, via: value } : { ok: false };
      }
      return hit('color', normColor(value, null));
    }
    case 'typography': return hit('typography', own(config.typography?.styles));
    case 'spacing': return hit('dimension', own(config.layout?.spacing?.scale));
    case 'radius': return hit('dimension', own(config.shape?.radius));
    case 'radiusRoles': {
      const name = own(config.shape?.radiusRoles);
      const value = name !== undefined && isPlainObject(config.shape?.radius) ? config.shape.radius[name] : undefined;
      return hit('dimension', value, { via: name });
    }
    case 'elevation': return hit('shadow', own(config.shape?.elevation)?.shadow);
    case 'duration': return hit('duration', own(config.motion?.durations));
    case 'easing': return hit('easing', own(config.motion?.easings));
    default: {
      const palette = config.colors?.palettes?.[group];
      return hit('color', isPlainObject(palette?.steps) && Object.prototype.hasOwnProperty.call(palette.steps, key) ? palette.steps[key] : undefined);
    }
  }
}

/** A color field (a hex, any CSS color, or an alias) → hex, or null. */
export function resolveColor(config, value, { theme = null } = {}) {
  if (isAlias(value)) {
    const hit = resolveAlias(config, value, { theme });
    return hit.ok && hit.kind === 'color' ? hit.value : null;
  }
  return normColor(value, null);
}

/** How a resolved alias is written in CSS text. */
export function aliasToCss(hit) {
  if (!hit?.ok) return null;
  if (hit.kind === 'dimension') return hit.value === 0 ? '0' : `${hit.value}px`;
  if (hit.kind === 'duration') return `${hit.value}ms`;
  if (hit.kind === 'typography') return null;
  return String(hit.value);
}

/**
 * Replace every "{group.key}" inside a text with its CSS value. An alias nothing resolves is left
 * as text and reported: { text, warnings: ["{x.y}"] }.
 */
export function resolveText(config, text, { theme = null } = {}) {
  const warnings = [];
  const out = String(text ?? '').replace(ALIAS_ANY_RE, (match) => {
    const css = aliasToCss(resolveAlias(config, match, { theme }));
    if (css === null) { if (!warnings.includes(match)) warnings.push(match); return match; }
    return css;
  });
  return { text: out, warnings };
}

/** Every alias in the config that resolves to nothing: [{ path, alias }]. */
export function findUnknownAliases(config) {
  const out = [];
  const check = (path, value, theme = null) => {
    if (typeof value !== 'string' || !value.includes('{')) return;
    for (const match of new Set(value.match(ALIAS_ANY_RE) || [])) {
      if (!resolveAlias(config, match, { theme }).ok) out.push({ path, alias: match });
    }
  };
  for (const theme of THEMES) for (const [role, value] of Object.entries(config.colors?.semantic?.[theme] || {})) check(`colors.semantic.${theme}.${role}`, value, theme);
  (config.colors?.gradients || []).forEach((g, i) => check(`colors.gradients.${i}.css`, g.css));
  (config.components || []).forEach((c, i) => {
    for (const [key, value] of Object.entries(c.tokens || {})) check(`components.${i}.tokens.${key}`, value);
    for (const [key, value] of Object.entries(c.states || {})) check(`components.${i}.states.${key}`, value);
  });
  check('accessibility.focusRing', config.accessibility?.focusRing);
  return out;
}

// ── merge patch and diff ────────────────────────────────────────────────────

/** RFC 7396 JSON merge patch: objects merge, `null` deletes, everything else replaces. Returns a new value. */
export function applyMergePatch(target, patch, depth = 0) {
  if (depth > 64) throw new RangeError('Merge patch nesting exceeds 64 levels');
  if (!isPlainObject(patch)) return clone(patch);
  const out = isPlainObject(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (value === null) delete out[key];
    else out[key] = applyMergePatch(Object.hasOwn(out, key) ? out[key] : undefined, value, depth + 1);
  }
  return out;
}

const DIFF_IGNORED = new Set(['updatedAt', 'revision']);

/** Leaf differences between two configs: [{ path, from, to }] (dotted paths; an array is one leaf). */
export function diffConfigs(before, after, { limit = 400 } = {}) {
  const out = [];
  const walk = (a, b, path) => {
    if (out.length >= limit) return;
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
        if (!path && DIFF_IGNORED.has(key)) continue;
        walk(a[key], b[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    // A map that appears or disappears is reported leaf by leaf.
    if (isPlainObject(a) && b === undefined) { for (const key of Object.keys(a)) walk(a[key], undefined, `${path}.${key}`); return; }
    if (a === undefined && isPlainObject(b)) { for (const key of Object.keys(b)) walk(undefined, b[key], `${path}.${key}`); return; }
    out.push({ path, from: a === undefined ? null : a, to: b === undefined ? null : b });
  };
  walk(before || {}, after || {}, '');
  return out;
}
