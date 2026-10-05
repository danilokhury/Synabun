// ═══════════════════════════════════════════
// SynaBun — Style Guide importers
// ═══════════════════════════════════════════
//
// Everything a guide can be filled from: a DESIGN.md (ours, Stitch's or one of the
// community collection's: YAML frontmatter read by the small parser below, no
// dependency), a W3C design-tokens file, CSS custom properties, a Tailwind theme as
// JSON, the project's own files, or a community DESIGN.md fetched by slug.
//
// Each importer is pure and returns { patch, warnings }: `patch` is a partial v2
// config, applied as a JSON merge patch by buildImport (`merge`) or over the
// defaults (`replace`). The two functions that touch the outside take it injected:
// scanCodebase(root, { fs }) and fetchCommunityDesignMd(slug, { fetchImpl }).

import * as nodeFs from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { PALETTE_STEPS, relativeLuminance, rgbToHex, scaleFromBase, toHex } from './color.js';
import { walkDtcg } from './export-dtcg.js';
import {
  CORE_PALETTES, SEMANTIC_ROLES, STATUS_KEYS, THEMES,
  applyMergePatch, defaultStyleGuide, diffConfigs, isAlias, isPlainObject, kebab, normalizeStyleGuide, resolveAlias, resolveText, tokenKey,
} from './schema.js';
import { roleFromName } from './tokens.js';
import { containedPath } from './security.js';

export const IMPORT_KINDS = Object.freeze(['design-md', 'dtcg', 'css', 'tailwind-json', 'codebase', 'community']);
export const COMMUNITY_SLUG_RE = /^[a-z0-9.-]{1,40}$/;
export const COMMUNITY_BASE_URL = 'https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md';
export const COMMUNITY_ATTRIBUTION = 'From the community collection github.com/VoltAgent/awesome-design-md: a description of a public design, not an official brand asset.';
export const SCAN_MAX_FILES = 400;
const SCAN_MAX_BYTES = 1024 * 1024;
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.synabun', '.next', '.nuxt', '.cache', '.turbo', 'coverage', 'vendor', 'out', 'target', '.venv', '__pycache__']);
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_EXTRA_PALETTES = 8;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']);
const MAX_DEPTH = 64;

function checkText(text) {
  if (Buffer.byteLength(String(text ?? '')) > MAX_IMPORT_BYTES) throw new ImportError('TOO_LARGE', 'That file is too large to import.', 413);
}
function checkTree(value) {
  const pending = [[value, 0]];
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (depth > MAX_DEPTH || ++count > 100000) throw new ImportError('BAD_JSON', 'Import nesting or node count exceeds the limit.');
    if (node && typeof node === 'object') for (const [key, item] of Object.entries(node)) {
      if (UNSAFE_KEYS.has(key)) throw new ImportError('BAD_JSON', `Unsafe import key: ${key}`);
      pending.push([item, depth + 1]);
    }
  }
}

export class ImportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.status = status;
  }
}

// ── YAML subset ─────────────────────────────────────────────────────────────

/** Cut a trailing comment: a `#` at the start or after whitespace, outside quotes. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      // `color: #fff` is a hex color far more often than an empty value with a comment.
      if (/:\s*$/.test(line.slice(0, i)) && /^#[0-9a-fA-F]{3,8}\s*(#.*)?$/.test(line.slice(i))) { i += line.slice(i).search(/\s|$/) - 1; continue; }
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw, depth = 0) {
  if (depth > MAX_DEPTH) throw new ImportError('BAD_YAML', 'YAML nesting exceeds 64 levels');
  const text = String(raw).trim();
  if (text === '') return null;
  if (text[0] === '"' && text.endsWith('"') && text.length >= 2) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1).replace(/\\(["\\])/g, '$1'); }
  }
  if (text[0] === "'" && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  if (text[0] === '[' && text.endsWith(']')) return splitFlow(text.slice(1, -1)).map((part) => parseScalar(part, depth + 1));
  if (text === '{}') return {};
  if (text[0] === '{' && text.endsWith('}') && /:/.test(text)) {
    const out = {};
    for (const part of splitFlow(text.slice(1, -1))) {
      const at = splitKey(part);
      if (at && !UNSAFE_KEYS.has(at.key)) out[at.key] = parseScalar(at.rest, depth + 1);
    }
    return out;
  }
  if (/^(true|yes)$/i.test(text)) return true;
  if (/^(false|no)$/i.test(text)) return false;
  if (/^(null|~)$/i.test(text)) return null;
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return Number(text);
  return text;
}

/** Split "a, b, c" on commas outside quotes and brackets. */
function splitFlow(text) {
  const out = [];
  let depth = 0; let quote = null; let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim()).filter((part) => part !== '');
}

/** "key: rest" → { key, rest }, or null when the line is not a mapping entry. */
function splitKey(text) {
  const line = text.trim();
  let match = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s+(.*))?$/.exec(line) || /^'((?:[^']|'')*)'\s*:(?:\s+(.*))?$/.exec(line);
  if (match) return { key: match[1], rest: match[2] ?? '' };
  match = /^([^\s:#\-[{"'][^:]*?)\s*:(?:\s+(.*))?$/.exec(line);
  if (!match) return null;
  // A URL or a time is a scalar, not a key.
  if (/^[a-z]+$/i.test(match[1]) && /^\/\//.test(match[2] ?? '')) return null;
  return { key: match[1].trim(), rest: match[2] ?? '' };
}

/**
 * A small YAML subset, enough for a DESIGN.md frontmatter: maps, nested maps, block lists (of scalars
 * or of maps), flow lists and maps on one line, quoted and plain scalars, `|` and `>` block text,
 * comments. Anchors, tags and multi-document streams are not read. Throws ImportError('BAD_YAML').
 */
export function parseYamlSubset(text) {
  checkText(text);
  const lines = [];
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const expanded = raw.replace(/^\t+/, (tabs) => '  '.repeat(tabs.length));
    const content = stripComment(expanded).replace(/\s+$/, '');
    lines.push({ indent: content.length - content.trimStart().length, text: content.trim(), raw: expanded });
  }
  let index = 0;
  let nesting = 0;
  const skipBlank = () => { while (index < lines.length && lines[index].text === '') index++; };
  const blockText = (parentIndent, folded) => {
    const collected = [];
    let base = null;
    while (index < lines.length) {
      const line = lines[index];
      if (line.raw.trim() === '') { collected.push(''); index++; continue; }
      const indent = line.raw.length - line.raw.trimStart().length;
      if (indent <= parentIndent) break;
      if (base === null) base = indent;
      collected.push(line.raw.slice(Math.min(base, indent)).replace(/\s+$/, ''));
      index++;
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    return folded ? collected.join(' ').replace(/\s+/g, ' ').trim() : collected.join('\n');
  };
  const valueAfter = (rest, indent) => {
    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') return blockText(indent, rest[0] === '>');
    if (rest !== '') return parseScalar(rest);
    skipBlank();
    if (index < lines.length && (lines[index].indent > indent || (lines[index].indent === indent && lines[index].text.startsWith('- ')))) return parseNode(lines[index].indent);
    return null;
  };
  function parseNode(indent) {
    if (++nesting > MAX_DEPTH) throw new ImportError('BAD_YAML', 'YAML nesting exceeds 64 levels');
    try { return parseNodeInner(indent); } finally { nesting--; }
  }
  function parseNodeInner(indent) {
    skipBlank();
    if (index >= lines.length) return null;
    if (lines[index].text === '-' || lines[index].text.startsWith('- ')) {
      const list = [];
      while (index < lines.length) {
        skipBlank();
        if (index >= lines.length || lines[index].indent !== indent || !(lines[index].text === '-' || lines[index].text.startsWith('- '))) break;
        const body = lines[index].text.slice(1).trim();
        const entry = body ? splitKey(body) : null;
        if (body === '') { index++; list.push(valueAfter('', indent)); continue; }
        if (!entry) { index++; list.push(parseScalar(body)); continue; }
        // "- key: value" opens a map whose other keys sit two columns in.
        const item = {};
        const itemIndent = indent + 2;
        index++;
        const first = valueAfter(entry.rest, itemIndent);
        if (!UNSAFE_KEYS.has(entry.key)) item[entry.key] = first;
        skipBlank();
        if (index < lines.length && lines[index].indent === itemIndent && !lines[index].text.startsWith('- ')) Object.assign(item, parseNode(itemIndent));
        list.push(item);
      }
      return list;
    }
    const map = {};
    while (index < lines.length) {
      skipBlank();
      if (index >= lines.length || lines[index].indent < indent) break;
      if (lines[index].indent > indent) throw new ImportError('BAD_YAML', `Unexpected indentation on line ${index + 1}`);
      const entry = splitKey(lines[index].text);
      if (!entry) throw new ImportError('BAD_YAML', `Cannot read line ${index + 1}: "${lines[index].text.slice(0, 60)}"`);
      index++;
      if (UNSAFE_KEYS.has(entry.key)) { valueAfter(entry.rest, indent); continue; }
      map[entry.key] = valueAfter(entry.rest, indent);
    }
    return map;
  }
  skipBlank();
  if (index >= lines.length) return {};
  const value = parseNode(lines[index].indent);
  skipBlank();
  if (index < lines.length) throw new ImportError('BAD_YAML', `Cannot read line ${index + 1}: "${lines[index].text.slice(0, 60)}"`);
  return value;
}

/** A Markdown file → { data (frontmatter object or null), body, hasFrontmatter }. */
export function splitFrontmatter(markdown) {
  checkText(markdown);
  const text = String(markdown ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { data: null, body: text, hasFrontmatter: false };
  return { data: parseYamlSubset(match[1]), body: text.slice(match[0].length), hasFrontmatter: true };
}

// ── shared readers ──────────────────────────────────────────────────────────

/** "24px" | "1.5rem" | 24 → 24 (px), or null. */
export function toPx(value, { base = 16 } = {}) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'full') return 9999;
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt)?$/.exec(text);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (match[2] === 'rem' || match[2] === 'em') return Math.round(n * base * 1000) / 1000;
  if (match[2] === 'pt') return Math.round(n * (4 / 3) * 1000) / 1000;
  return n;
}

const WEIGHT_NAMES = Object.freeze({ thin: 100, extralight: 200, light: 300, normal: 400, regular: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, black: 900, heavy: 900 });
function toWeight(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s-]/g, '');
  if (WEIGHT_NAMES[text]) return WEIGHT_NAMES[text];
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : null;
}
function toLineHeight(value, size) {
  if (typeof value === 'number') return value > 4 && size ? Math.round((value / size) * 1000) / 1000 : value;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'normal') return 1.5;
  if (text.endsWith('%')) return Math.round(parseFloat(text)) / 100;
  const px = /px|rem|pt/.test(text) ? toPx(text) : null;
  if (px !== null && size) return Math.round((px / size) * 1000) / 1000;
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : null;
}
function toLetterSpacing(value, size) {
  if (typeof value === 'number') return Math.abs(value) < 1 ? value : (size ? Math.round((value / size) * 10000) / 10000 : 0);
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'normal' || text === '0') return 0;
  if (text.endsWith('em') && !text.endsWith('rem')) return parseFloat(text);
  if (text.endsWith('%')) return parseFloat(text) / 100;
  const px = toPx(text);
  if (px !== null && size) return Math.round((px / size) * 10000) / 10000;
  return null;
}
function toMs(value) {
  if (typeof value === 'number') return value;
  const text = String(value ?? '').trim().toLowerCase();
  const n = parseFloat(text);
  if (!Number.isFinite(n)) return null;
  return text.endsWith('ms') ? n : text.endsWith('s') ? n * 1000 : n;
}

/** `"Space Grotesk", system-ui, sans-serif` → { family, fallback }. */
export function splitFontStack(value) {
  const parts = (Array.isArray(value) ? value.map(String) : splitFlow(String(value ?? ''))).map((part) => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  if (!parts.length) return null;
  return { family: parts[0], fallback: parts.slice(1).join(', ') };
}
function fontCategory(family, id = '') {
  if (/mono|code|courier|consol|menlo/i.test(family) || /(^|-)(code|mono)(-|$)/.test(id)) return 'mono';
  if (/serif|georgia|times|garamond|playfair|merriweather|lora|fraunces/i.test(family) && !/sans/i.test(family)) return 'serif';
  return 'sans';
}
const FALLBACKS = Object.freeze({ mono: 'ui-monospace, monospace', serif: 'Georgia, serif', sans: 'system-ui, sans-serif' });

function makeFont(family, fallback, { googleFonts = null, weights = null } = {}) {
  const system = /^(system-ui|sans-serif|serif|monospace|ui-monospace|ui-sans-serif|ui-serif|-apple-system|arial|helvetica|georgia|times new roman|courier new|verdana|tahoma|segoe ui)$/i.test(family);
  const font = { family, fallback: fallback || FALLBACKS[fontCategory(family)] };
  // Without the list of Google families the source is not known: the guide's own value stays.
  if (system) font.source = 'system';
  else if (googleFonts) font.source = googleFonts.has(family.toLowerCase()) ? 'google' : 'other';
  if (weights?.length) font.weights = [...new Set(weights)].sort((a, b) => a - b);
  return font;
}

const STATUS_SYNONYMS = Object.freeze({ error: 'danger', destructive: 'danger', negative: 'danger', critical: 'danger', warn: 'warning', caution: 'warning', positive: 'success', information: 'info', informative: 'info' });
const PALETTE_SYNONYMS = Object.freeze({ brand: 'primary', tertiary: 'accent', gray: 'neutral', grey: 'neutral' });
const ROLE_SYNONYMS = Object.freeze({
  background: 'background', bg: 'background', canvas: 'background', page: 'background',
  surface: 'surface', card: 'surface', panel: 'surface', 'surface-container': 'surface',
  'surface-raised': 'surfaceRaised', 'surface-elevated': 'surfaceRaised', elevated: 'surfaceRaised', popover: 'surfaceRaised',
  text: 'text', foreground: 'text', fg: 'text', ink: 'text', 'on-background': 'text', 'on-surface': 'text', 'text-primary': 'text', 'text-default': 'text',
  'text-muted': 'textMuted', 'muted-foreground': 'textMuted', 'text-secondary': 'textMuted', 'on-surface-variant': 'textMuted', 'text-subtle': 'textMuted', subtle: 'textMuted',
  border: 'border', outline: 'border', divider: 'border', hairline: 'border', input: 'border',
  'on-primary': 'onPrimary', 'primary-foreground': 'onPrimary',
  'on-secondary': 'onSecondary', 'secondary-foreground': 'onSecondary',
  'on-accent': 'onAccent', 'accent-foreground': 'onAccent',
  link: 'link', focus: 'focus', ring: 'focus', 'focus-ring': 'focus',
});

/**
 * Sort named colors into the config. `entries` is [[name, value, theme?]]: a value is any CSS color or
 * one of our aliases; `theme` says a flat name belongs to that theme (a `.dark` block). Names:
 *   <palette>-<step> · <theme>-<role> · a status · primary | secondary | accent | neutral (a base)
 *   background, surface, text, border, on-primary, … (flat semantic names) · anything else (a new palette)
 * Returns { colors, extraPalettes } and pushes to `warnings`.
 */
function sortColors(entries, warnings, { realias = false } = {}) {
  const palettes = {};
  const semantic = { light: {}, dark: {} };
  const status = {};
  const flat = [];
  const extraPalettes = new Set();
  const colorOf = (value) => (typeof value === 'string' && /^\{[a-z0-9-]+\.[a-z0-9-]+\}$/i.test(value.trim()) ? value.trim() : toHex(value));
  const palette = (key) => (palettes[key] ||= { explicit: {}, base: null });
  // `brand` stands for `primary` (and `gray` for `neutral`) only in a file that has no palette of that name itself.
  const named = new Set(entries.map(([rawName]) => kebab(rawName).replace(/-(50|100|200|300|400|500|600|700|800|900|950)$/, '')));
  const core = (name) => (CORE_PALETTES.includes(name) ? name : (PALETTE_SYNONYMS[name] && !named.has(PALETTE_SYNONYMS[name]) ? PALETTE_SYNONYMS[name] : null));
  for (const [rawName, rawValue, theme = null] of entries) {
    const name = kebab(rawName);
    const value = colorOf(rawValue);
    if (!name || !value) { if (name && rawValue !== null && rawValue !== undefined && rawValue !== '') warnings.push(`Not a color: ${rawName}: ${String(rawValue).slice(0, 40)}`); continue; }
    const themed = /^(light|dark)-(.+)$/.exec(name);
    if (themed && !PALETTE_STEPS.includes(themed[2])) { semantic[themed[1]][roleFromName(themed[2])] = value; continue; }
    const stepped = /^(.+)-(50|100|200|300|400|500|600|700|800|900|950)$/.exec(name);
    if (stepped && !theme) {
      const key = core(stepped[1]) || stepped[1];
      if (value.startsWith('#')) palette(key).explicit[stepped[2]] = value.slice(0, 7);
      continue;
    }
    const statusKey = STATUS_KEYS.includes(name) ? name : STATUS_SYNONYMS[name];
    if (statusKey && value.startsWith('#')) { if (!theme) status[statusKey] = value; continue; }
    flat.push([name, value, theme]);
  }
  // Flat names describe one theme: the one the block says, else the one the background's lightness says.
  const background = flat.find(([name, , theme]) => !theme && ROLE_SYNONYMS[name] === 'background');
  const flatTheme = background && background[1].startsWith('#') && relativeLuminance(background[1]) < 0.2 ? 'dark' : 'light';
  let sawFlatRole = false;
  for (const [name, value, theme] of flat) {
    const target = theme || flatTheme;
    const key = core(name);
    if (key) {
      if (theme) semantic[theme][key === 'neutral' ? 'textMuted' : key] = value;
      else if (value.startsWith('#')) { palette(key).base = value.slice(0, 7); if (target === 'dark' && key !== 'neutral') semantic.dark[key] = `{${key}.500}`; }
      continue;
    }
    // shadcn's `muted` is a quiet surface, `accent` a hover surface: only the first is useful here.
    const role = ROLE_SYNONYMS[name] || (name === 'muted' ? 'surface' : null) || (SEMANTIC_ROLES.includes(roleFromName(name)) ? roleFromName(name) : null);
    if (role) {
      if (name === 'muted' && semantic[target].surface) continue;
      semantic[target][role] = value;
      if (!theme) sawFlatRole = true;
      continue;
    }
    if (theme) continue;
    if (!value.startsWith('#')) continue;
    if (extraPalettes.size >= MAX_EXTRA_PALETTES && !palettes[name]) { warnings.push(`Color "${name}" was not imported: more than ${MAX_EXTRA_PALETTES} extra palettes`); continue; }
    palette(name).base = value.slice(0, 7);
    extraPalettes.add(name);
  }
  const colors = {};
  for (const [key, entry] of Object.entries(palettes)) {
    const steps = Object.keys(entry.explicit);
    const base = entry.explicit['500'] || entry.base || entry.explicit[steps[Math.floor(steps.length / 2)]];
    if (!base) continue;
    if (!CORE_PALETTES.includes(key)) extraPalettes.add(key);
    (colors.palettes ||= {})[key] = { base, steps: { ...scaleFromBase(base), ...entry.explicit } };
  }
  if (realias && colors.palettes) {
    // A format that only carries resolved colors: a role whose color is exactly a palette step points at it again.
    const steps = new Map();
    for (const [key, entry] of Object.entries(colors.palettes)) for (const [step, hex] of Object.entries(entry.steps)) if (!steps.has(hex)) steps.set(hex, `{${key}.${step}}`);
    for (const theme of THEMES) for (const [role, value] of Object.entries(semantic[theme])) if (steps.has(value)) semantic[theme][role] = steps.get(value);
  }
  for (const theme of THEMES) if (Object.keys(semantic[theme]).length) (colors.semantic ||= {})[theme] = semantic[theme];
  if (Object.keys(status).length) colors.status = status;
  // Flat names on a dark background describe a dark-only design; anything else leaves the themes alone.
  const themedBoth = Object.keys(semantic.light).length && Object.keys(semantic.dark).length;
  if (sawFlatRole && !themedBoth && flatTheme === 'dark') colors.themes = { default: 'dark', supports: ['dark'] };
  else if (themedBoth) colors.themes = { supports: ['light', 'dark'] };
  return { colors, extraPalettes };
}

/** A token name in someone's frontmatter ("{colors.x}") → our alias, or null. */
function colorAliasFor(name, known) {
  const key = kebab(name);
  const themed = /^(light|dark)-(.+)$/.exec(key);
  if (themed && !PALETTE_STEPS.includes(themed[2])) return `{semantic.${roleFromName(themed[2])}}`;
  const stepped = /^(.+)-(50|100|200|300|400|500|600|700|800|900|950)$/.exec(key);
  if (stepped) return `{${PALETTE_SYNONYMS[stepped[1]] || stepped[1]}.${stepped[2]}}`;
  if (STATUS_KEYS.includes(key) || STATUS_SYNONYMS[key]) return `{status.${STATUS_SYNONYMS[key] || key}}`;
  if (CORE_PALETTES.includes(key) || PALETTE_SYNONYMS[key]) return `{semantic.${PALETTE_SYNONYMS[key] || key}}`.replace('{semantic.neutral}', '{neutral.500}');
  const role = ROLE_SYNONYMS[key] || (SEMANTIC_ROLES.includes(roleFromName(key)) ? roleFromName(key) : null);
  if (role) return `{semantic.${role}}`;
  return known.has(key) ? `{${key}.500}` : null;
}

/** Text styles + fonts from a map of { id: { fontFamily, fontSize, fontWeight, lineHeight, letterSpacing } }. */
function sortTypography(styleMap, { googleFonts = null } = {}, warnings = []) {
  const styles = {};
  const families = new Map(); // family → { ids, fallback, weights }
  for (const [rawId, raw] of Object.entries(styleMap || {})) {
    const id = kebab(rawId);
    if (!id || !isPlainObject(raw)) continue;
    const size = toPx(raw.fontSize ?? raw.size);
    if (size === null) { warnings.push(`Text style "${rawId}" has no readable font size`); continue; }
    const stack = raw.fontFamily ? splitFontStack(raw.fontFamily) : null;
    const style = { size };
    const weight = toWeight(raw.fontWeight ?? raw.weight);
    if (weight !== null) style.weight = weight;
    const lineHeight = toLineHeight(raw.lineHeight, size);
    if (lineHeight !== null) style.lineHeight = lineHeight;
    const letterSpacing = raw.letterSpacing === undefined || raw.letterSpacing === null ? null : toLetterSpacing(raw.letterSpacing, size);
    if (letterSpacing !== null) style.letterSpacing = letterSpacing;
    const transform = String(raw.textTransform ?? raw.transform ?? '').toLowerCase();
    if (['uppercase', 'lowercase', 'capitalize', 'none'].includes(transform)) style.transform = transform;
    if (toPx(raw.mobileSize) !== null) style.mobileSize = toPx(raw.mobileSize);
    if (typeof raw.usage === 'string') style.usage = raw.usage;
    styles[id] = style;
    if (stack) {
      const entry = families.get(stack.family) || { ids: [], fallback: stack.fallback, weights: [], features: '' };
      entry.ids.push(id);
      if (weight !== null) entry.weights.push(weight);
      if (typeof raw.fontFeature === 'string') entry.features = raw.fontFeature;
      families.set(stack.family, entry);
      style._family = stack.family;
    }
  }
  if (!Object.keys(styles).length) return null;
  const fonts = {};
  const score = (ids, re) => ids.filter((id) => re.test(id)).length;
  const pick = (re, taken) => [...families.entries()].filter(([family]) => !taken.includes(family)).sort((a, b) => score(b[1].ids, re) - score(a[1].ids, re))[0];
  const make = (family) => ({ ...makeFont(family, families.get(family).fallback, { googleFonts, weights: families.get(family).weights }), ...(families.get(family).features ? { features: families.get(family).features } : {}) });
  const taken = [];
  const mono = [...families.keys()].find((family) => fontCategory(family, families.get(family).ids.join('-')) === 'mono');
  if (mono) { fonts.mono = make(mono); taken.push(mono); }
  const HEADING_RE = /display|headline|heading|title|hero|^h[1-6]$/;
  const BODY_RE = /body|paragraph|text|label|caption|button|overline|small/;
  const heading = pick(HEADING_RE, taken);
  const body = [...families.entries()].filter(([family]) => !taken.includes(family)).sort((a, b) => score(b[1].ids, BODY_RE) - score(a[1].ids, BODY_RE))[0];
  if (body && score(body[1].ids, BODY_RE) > 0) { fonts.body = make(body[0]); taken.push(body[0]); }
  if (heading && score(heading[1].ids, HEADING_RE) > 0) { fonts.heading = make(heading[0]); taken.push(heading[0]); }
  const rest = [...families.keys()].filter((family) => !taken.includes(family));
  if (!fonts.body && rest.length) { fonts.body = make(rest[0]); taken.push(rest.shift()); }
  // Keep the patch partial: a body family alone does not define the heading role.
  if (!fonts.heading && rest.length) fonts.heading = make(rest.shift());
  if (rest.length) fonts.display = make(rest.shift());
  if (rest.length) warnings.push(`More than four font families: ${rest.join(', ')} mapped to the body font`);
  const keyOf = (family) => Object.entries(fonts).find(([, font]) => font?.family === family)?.[0];
  for (const [id, style] of Object.entries(styles)) {
    const family = style._family;
    delete style._family;
    const role = HEADING_RE.test(id) ? 'heading' : /code|mono/.test(id) ? 'mono' : 'body';
    style.font = (family && (fonts[role]?.family === family ? role : keyOf(family))) || role;
  }
  const typography = { styles };
  if (Object.values(fonts).some(Boolean)) typography.fonts = Object.fromEntries(Object.entries(fonts).filter(([, font]) => font));
  return typography;
}

function dimensionMap(map, warnings, label) {
  const out = {};
  for (const [rawKey, value] of Object.entries(map || {})) {
    const key = tokenKey(rawKey);
    const n = toPx(value);
    if (!key) continue;
    if (n === null) { warnings.push(`${label} "${rawKey}" is not a length: ${String(value).slice(0, 30)}`); continue; }
    out[key] = n;
  }
  return Object.keys(out).length ? out : null;
}

const RADIUS_ROLE_NAMES = Object.freeze(['button', 'card', 'input', 'badge', 'modal']);
/**
 * `rounded-button` and friends are roles, not steps: each one that has the size of a step of the scale is taken
 * out of `radius` (mutated) and returned as { role: step }.
 */
function splitRadiusRoles(radius) {
  const roles = {};
  for (const role of RADIUS_ROLE_NAMES) {
    if (!(role in radius)) continue;
    const step = Object.keys(radius).find((key) => !RADIUS_ROLE_NAMES.includes(key) && radius[key] === radius[role]);
    if (step) { roles[role] = step; delete radius[role]; }
  }
  return roles;
}

const COMPONENT_PROPS = Object.freeze({ backgroundColor: 'background', background: 'background', textColor: 'text', color: 'text', rounded: 'radius', borderRadius: 'radius', boxShadow: 'shadow' });
function componentCategory(id) {
  if (/button|btn|cta/.test(id)) return 'button';
  if (/input|field|select|textarea|checkbox|radio|switch|search|form/.test(id)) return 'input';
  if (/modal|dialog|drawer|popover|sheet|overlay/.test(id)) return 'overlay';
  if (/card|tile|panel/.test(id)) return 'card';
  if (/nav|menu|tab|header|footer|sidebar|breadcrumb/.test(id)) return 'navigation';
  if (/alert|toast|banner|badge|tag|pill|chip|tooltip|progress/.test(id)) return 'feedback';
  if (/table|list|chart|stat|avatar/.test(id)) return 'data';
  return 'other';
}

// ── DESIGN.md ───────────────────────────────────────────────────────────────

/** "## Heading" sections of a Markdown body: [{ title, text, subs: [{ title, text }] }]. */
export function markdownSections(body) {
  const sections = [];
  let current = null; let sub = null; let fence = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h2 = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    const h3 = !fence && /^###\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2) { current = { title: h2[1].trim(), lines: [], subs: [] }; sections.push(current); sub = null; continue; }
    if (h3 && current) { sub = { title: h3[1].trim(), lines: [] }; current.subs.push(sub); continue; }
    (sub || current)?.lines.push(line);
  }
  const text = (lines) => lines.join('\n').trim();
  return sections.map((s) => ({ title: s.title, text: text(s.lines), subs: s.subs.map((x) => ({ title: x.title, text: text(x.lines) })) }));
}
const bulletsOf = (text) => String(text ?? '').split('\n').map((line) => /^\s*[-*•]\s+(.*)$/.exec(line)?.[1]?.trim()).filter(Boolean).map((item) => item.replace(/\*\*/g, ''));
const proseOf = (text) => String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !/^[-*•|>#]/.test(p) && !/^\*\*[^*]+:\*\*/.test(p)).map((p) => p.replace(/\s*\n\s*/g, ' ').replace(/\*\*/g, ''));
const sectionNamed = (sections, re) => sections.find((s) => re.test(s.title.replace(/^\d+[.)]\s*/, '')));

const OUR_DEFAULT_RULES = new Set([
  'Use the semantic color roles and the type styles above.', 'Keep spacing on the scale.',
  'Invent colors, fonts or radii the guide does not define.', 'Convey meaning with color alone.',
]);

function frontmatterToPatch(data, patch, warnings, options) {
  if (typeof data.name === 'string' && data.name.trim()) (patch.brand ||= {}).name = data.name.trim();
  if (typeof data.description === 'string' && data.description.trim()) (patch.brand ||= {}).description = data.description.trim();
  const known = new Set();
  if (isPlainObject(data.colors)) {
    const entries = [];
    const flatten = (map, prefix) => {
      for (const [key, value] of Object.entries(map)) {
        if (isPlainObject(value)) flatten(value, `${prefix}${key}-`);
        else entries.push([`${prefix}${key}`, value]);
      }
    };
    flatten(data.colors, '');
    const sorted = sortColors(entries, warnings, { realias: true });
    if (Object.keys(sorted.colors).length) patch.colors = sorted.colors;
    for (const key of sorted.extraPalettes) known.add(key);
  }
  if (isPlainObject(data.typography)) {
    const typography = sortTypography(data.typography, options, warnings);
    if (typography) patch.typography = typography;
  }
  const radius = dimensionMap(data.rounded ?? data.radius, warnings, 'Radius');
  if (radius) (patch.shape ||= {}).radius = radius;
  const spacing = dimensionMap(data.spacing, warnings, 'Spacing');
  if (spacing) ((patch.layout ||= {}).spacing ||= {}).scale = spacing;
  if (isPlainObject(data.components)) {
    const components = [];
    const translate = (value) => String(value).replace(/\{([a-zA-Z]+)\.([^{}]+)\}/g, (match, group, name) => {
      if (group === 'colors' || group === 'color') return colorAliasFor(name, known) || match;
      if (group === 'rounded' || group === 'radius') return `{radius.${tokenKey(name)}}`;
      if (group === 'typography') return `{typography.${kebab(name)}}`;
      if (group === 'spacing') return `{spacing.${tokenKey(name)}}`;
      return match;
    });
    for (const [rawId, props] of Object.entries(data.components)) {
      const id = kebab(rawId);
      if (!id || !isPlainObject(props)) continue;
      const tokens = {};
      const states = {};
      for (const [key, value] of Object.entries(props)) {
        if (isPlainObject(value)) { states[tokenKey(key)] = Object.entries(value).map(([k, v]) => `${COMPONENT_PROPS[k] || k} ${translate(v)}`).join(', '); continue; }
        if (value === null || value === undefined || value === '') continue;
        tokens[COMPONENT_PROPS[key] || tokenKey(key)] = translate(value);
      }
      components.push({ id, name: rawId.replace(/[-_]+/g, ' ').replace(/^./, (ch) => ch.toUpperCase()), category: componentCategory(id), tokens, states, notes: '' });
    }
    if (components.length) patch.components = components;
  }
}

function bodyToPatch(body, patch, { ours = false } = {}) {
  const sections = markdownSections(body);
  const rules = sectionNamed(sections, /^do['’]?s?\s+(and|&)\s+don['’]?ts?/i);
  if (rules) {
    const dos = []; const donts = [];
    for (const sub of rules.subs) (/don['’]?t|avoid|never/i.test(sub.title) ? donts : dos).push(...bulletsOf(sub.text));
    for (const item of bulletsOf(rules.text)) {
      const dont = /^(don['’]?t|avoid|never|❌)[:\s]+(.*)$/i.exec(item);
      const doIt = /^(do|✅)[:\s]+(.*)$/i.exec(item);
      if (dont) donts.push(dont[2]); else if (doIt) dos.push(doIt[2]); else dos.push(item);
    }
    const keep = (items) => items.filter((item) => !OUR_DEFAULT_RULES.has(item));
    if (keep(dos).length) (patch.rules ||= {}).dos = keep(dos);
    if (keep(donts).length) (patch.rules ||= {}).donts = keep(donts);
  }
  // Our own file holds the user's free Markdown between these two headings, headings of its own included.
  const own = ours ? /(?:^|\n)## Project Rules\n([\s\S]*?)\n## Agent Instructions(?:\n|$)/.exec(String(body ?? '')) : null;
  const custom = own ? null : (sectionNamed(sections, /^project rules$/i) || (!ours && sectionNamed(sections, /^iteration guide$/i)));
  if (own && own[1].trim()) (patch.rules ||= {}).custom = own[1].trim();
  if (custom && (custom.text || custom.subs.length)) {
    const text = [custom.text, ...custom.subs.map((s) => `### ${s.title}\n\n${s.text}`)].filter(Boolean).join('\n\n');
    (patch.rules ||= {}).custom = /^project rules$/i.test(custom.title) ? text : `## ${custom.title}\n\n${text}`;
  }
  // The rest of our own file is rendered from fields the frontmatter already carries.
  if (ours) return;
  const overview = sectionNamed(sections, /^(overview|visual theme)/i);
  if (overview) {
    const prose = proseOf(overview.text);
    if (prose.length) (patch.brand ||= {}).vibe = prose.join('\n\n').slice(0, 1200);
    const key = overview.subs.find((s) => /key characteristics/i.test(s.title));
    if (key && bulletsOf(key.text).length) (patch.brand ||= {}).keyCharacteristics = bulletsOf(key.text).slice(0, 12);
  }
  const typography = sectionNamed(sections, /^typography/i);
  const principles = typography?.subs.find((s) => /principles/i.test(s.title));
  if (principles && bulletsOf(principles.text).length) (patch.typography ||= {}).principles = bulletsOf(principles.text).slice(0, 20);
  const layout = sectionNamed(sections, /^layout/i);
  const whitespace = layout?.subs.find((s) => /whitespace/i.test(s.title));
  if (whitespace) {
    const items = bulletsOf(whitespace.text).length ? bulletsOf(whitespace.text) : proseOf(whitespace.text);
    if (items.length) (patch.layout ||= {}).principles = items.slice(0, 20);
  }
  const responsive = sectionNamed(sections, /^responsive/i);
  if (responsive) {
    const items = [...bulletsOf(responsive.text), ...responsive.subs.flatMap((s) => bulletsOf(s.text).map((item) => `${s.title}: ${item}`))];
    if (items.length) patch.responsive = { notes: items.slice(0, 20) };
  }
}

/** A DESIGN.md (ours, Stitch's or a community one) → { patch, warnings }. */
export function importDesignMd(text, options = {}) {
  const warnings = [];
  const patch = {};
  let parts;
  try { parts = splitFrontmatter(text); } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    warnings.push(`The frontmatter could not be read (${error.message}); only the prose was imported.`);
    parts = { data: null, body: String(text ?? '').replace(/^---[\s\S]*?\n---[ \t]*\n/, ''), hasFrontmatter: false };
  }
  if (isPlainObject(parts.data)) frontmatterToPatch(parts.data, patch, warnings, options);
  else if (!warnings.length) warnings.push('No YAML frontmatter: tokens were not imported, only the prose.');
  bodyToPatch(parts.body, patch, { ours: /Generated by SynaBun Style Guide/.test(parts.body) });
  return { patch, warnings };
}

// ── DTCG ────────────────────────────────────────────────────────────────────

function dtcgColorValue(value) {
  if (typeof value === 'string') return toHex(value);
  if (!isPlainObject(value)) return null;
  if (typeof value.hex === 'string' && toHex(value.hex)) {
    const hex = toHex(value.hex).slice(0, 7);
    return Number.isFinite(value.alpha) && value.alpha < 1 ? `${hex}${Math.round(value.alpha * 255).toString(16).padStart(2, '0')}` : hex;
  }
  if (Array.isArray(value.components) && value.components.length >= 3 && (!value.colorSpace || value.colorSpace === 'srgb')) {
    const [r, g, b] = value.components.map((c) => Number(c) * 255);
    return rgbToHex({ r, g, b, a: Number.isFinite(value.alpha) ? value.alpha : 1 });
  }
  return null;
}
function dtcgPx(value) {
  if (isPlainObject(value) && Number.isFinite(Number(value.value))) return value.unit === 'rem' ? Number(value.value) * 16 : Number(value.value);
  return toPx(value);
}
function dtcgShadowCss(value) {
  const layers = (Array.isArray(value) ? value : [value]).filter(isPlainObject);
  if (!layers.length) return null;
  return layers.map((layer) => {
    const color = dtcgColorValue(layer.color) || '#000000';
    const n = (v) => { const p = dtcgPx(v) ?? 0; return p === 0 ? '0' : `${p}px`; };
    return `${layer.inset ? 'inset ' : ''}${n(layer.offsetX)} ${n(layer.offsetY)} ${n(layer.blur)} ${n(layer.spread)} ${color}`;
  }).join(', ');
}

/** A fontFamily token → a font, with the source, weights and features our own files record in $extensions. */
function namedFont(stack, options) {
  const font = makeFont(stack.family, stack.fallback, options);
  if (typeof stack.source === 'string') font.source = stack.source;
  if (Array.isArray(stack.weights) && stack.weights.length) font.weights = stack.weights;
  if (typeof stack.features === 'string') font.features = stack.features;
  return font;
}

/** A W3C design-tokens document (text or object) → { patch, warnings }. */
export function importDtcg(input, options = {}) {
  const warnings = [];
  let doc = input;
  if (typeof input === 'string') {
    checkText(input);
    try { doc = JSON.parse(input); } catch (error) { throw new ImportError('BAD_JSON', `Not valid JSON: ${error.message}`); }
  }
  checkTree(doc);
  if (!isPlainObject(doc)) throw new ImportError('BAD_JSON', 'A design-tokens file is a JSON object');
  const { tokens } = walkDtcg(doc);
  const byPath = new Map(tokens.map((entry) => [entry.path.join('.'), entry]));
  const deref = (entry, depth = 0) => (entry?.alias && depth < 8 ? deref(byPath.get(entry.alias), depth + 1) : entry);
  const patch = {};
  const colorEntries = [];
  const styleMap = {};
  const fontFamilies = {};
  const ourAlias = (alias) => {
    const parts = alias.split('.');
    if (parts[0] !== 'color') return null;
    if (parts[1] === 'semantic' && parts.length === 4) return `{semantic.${parts[3]}}`;
    if (parts[1] === 'status' && parts.length === 3) return `{status.${parts[2]}}`;
    return parts.length === 3 ? `{${kebab(parts[1])}.${parts[2]}}` : null;
  };
  for (const entry of tokens) {
    const [head, ...rest] = entry.path;
    const leaf = rest[rest.length - 1];
    const target = deref(entry);
    if (!target) { warnings.push(`${entry.path.join('.')}: alias {${entry.alias}} names no token`); continue; }
    const value = target.value;
    if (entry.type === 'color') {
      const parts = head === 'color' || head === 'colors' ? rest : entry.path;
      if (parts[0] === 'semantic' && THEMES.includes(parts[1]) && parts.length === 3) {
        colorEntries.push([`${parts[1]}-${kebab(parts[2])}`, (entry.alias && ourAlias(entry.alias)) || dtcgColorValue(value)]);
      } else if (parts[0] === 'status' && parts.length === 2) colorEntries.push([parts[1], dtcgColorValue(value)]);
      else colorEntries.push([parts.join('-'), dtcgColorValue(value)]);
    } else if (entry.type === 'fontFamily') {
      const stack = splitFontStack(value);
      if (stack && leaf) fontFamilies[leaf] = { ...stack, source: entry.extension?.source, weights: entry.extension?.weights, features: entry.extension?.features };
    } else if (entry.type === 'typography' && isPlainObject(value)) {
      const family = typeof value.fontFamily === 'string' && /^\{[^{}]+\}$/.test(value.fontFamily) ? deref(byPath.get(value.fontFamily.slice(1, -1)))?.value : value.fontFamily;
      const size = dtcgPx(value.fontSize);
      const spacing = dtcgPx(value.letterSpacing);
      styleMap[leaf] = {
        fontFamily: family, fontSize: size, fontWeight: value.fontWeight, lineHeight: isPlainObject(value.lineHeight) ? `${dtcgPx(value.lineHeight)}px` : value.lineHeight,
        letterSpacing: spacing !== null && size ? `${Math.round((spacing / size) * 10000) / 10000}em` : 0, usage: entry.description,
        mobileSize: entry.extension?.mobileSize, transform: entry.extension?.transform,
      };
    } else if (entry.type === 'dimension') {
      const n = dtcgPx(value);
      const key = tokenKey(leaf);
      if (n === null || !key) continue;
      if (/^(spacing|space)$/i.test(head)) (((patch.layout ||= {}).spacing ||= {}).scale ||= {})[key] = n;
      else if (/^radius ?role/i.test(head)) { if (entry.alias?.startsWith('radius.')) ((patch.shape ||= {}).radiusRoles ||= {})[key] = entry.alias.slice(7); }
      else if (/^(radius|rounded|borderradius)$/i.test(head)) ((patch.shape ||= {}).radius ||= {})[key] = n;
      else if (/^(breakpoint|breakpoints|screens)$/i.test(head)) ((patch.layout ||= {}).breakpoints ||= {})[key] = n;
      else if (/^(border|borderwidth)$/i.test(head)) ((patch.shape ||= {}).borders ||= {})[key] = n;
    } else if (entry.type === 'shadow') {
      // Our own files keep the CSS as it was written beside the structured value.
      const css = typeof entry.extension?.css === 'string' ? entry.extension.css : dtcgShadowCss(value);
      const none = isPlainObject(value) && dtcgColorValue(value.color)?.endsWith('00') && !dtcgPx(value.blur) && !dtcgPx(value.offsetY);
      if (css) ((patch.shape ||= {}).elevation ||= {})[tokenKey(leaf)] = { shadow: none ? 'none' : css, usage: entry.description || '' };
    } else if (entry.type === 'duration') {
      const ms = isPlainObject(value) ? (value.unit === 's' ? Number(value.value) * 1000 : Number(value.value)) : toMs(value);
      if (Number.isFinite(ms)) ((patch.motion ||= {}).durations ||= {})[tokenKey(leaf)] = ms;
    } else if (entry.type === 'cubicBezier' && Array.isArray(value) && value.length === 4) {
      ((patch.motion ||= {}).easings ||= {})[tokenKey(leaf)] = `cubic-bezier(${value.join(', ')})`;
    } else if (entry.type === 'number' && /^z-?index$/i.test(head) && Number.isFinite(Number(value))) {
      ((patch.layout ||= {}).zIndex ||= {})[tokenKey(leaf)] = Number(value);
    }
  }
  const sorted = sortColors(colorEntries, warnings);
  if (Object.keys(sorted.colors).length) patch.colors = sorted.colors;
  const typography = sortTypography(styleMap, options, warnings);
  if (typography) {
    patch.typography = typography;
    // Our own files name the families: keep those names instead of guessing from the style ids.
    const named = Object.entries(fontFamilies).filter(([key]) => ['heading', 'body', 'mono', 'display'].includes(key));
    if (named.length) {
      typography.fonts = Object.fromEntries(named.map(([key, stack]) => [key, namedFont(stack, options)]));
      for (const [id, style] of Object.entries(typography.styles)) {
        const family = splitFontStack(styleMap[id]?.fontFamily)?.family;
        style.font = named.find(([, stack]) => stack.family === family)?.[0] || style.font;
      }
    }
  } else if (Object.keys(fontFamilies).length) {
    const fonts = {};
    for (const [key, stack] of Object.entries(fontFamilies)) {
      const slot = ['heading', 'body', 'mono', 'display'].includes(key) ? key : /mono|code/.test(key) ? 'mono' : /head|display|title/.test(key) ? 'heading' : 'body';
      fonts[slot] ||= namedFont(stack, options);
    }
    patch.typography = { fonts };
  }
  if (!tokens.length) warnings.push('No tokens found: a token is an object with a $value.');
  return { patch, warnings };
}

// ── CSS custom properties ───────────────────────────────────────────────────

/** Every custom property in a stylesheet: [{ name, value, scope: 'root' | 'light' | 'dark' }] (comments removed). */
export function parseCssVars(css) {
  const text = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let buffer = '';
  const scope = () => {
    const context = stack.join(' ').toLowerCase();
    if (/prefers-color-scheme:\s*dark|\.dark\b|theme=["']?dark|\bdark\b/.test(context)) return 'dark';
    if (/prefers-color-scheme:\s*light|\.light\b|theme=["']?light/.test(context)) return 'light';
    return 'root';
  };
  const declaration = (chunk) => {
    const match = /^\s*(--[A-Za-z0-9_-]+|\$[A-Za-z0-9_-]+|color-scheme)\s*:\s*([\s\S]+?)\s*(?:!default\s*)?$/.exec(chunk);
    if (match) out.push({ name: match[1].startsWith('$') ? `--${match[1].slice(1)}` : match[1], value: match[2].trim(), scope: scope() });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { stack.push(buffer.trim()); buffer = ''; }
    else if (ch === '}') { declaration(buffer); buffer = ''; stack.pop(); }
    else if (ch === ';') { declaration(buffer); buffer = ''; }
    else buffer += ch;
  }
  declaration(buffer);
  return out;
}

const VAR_RE = /^var\(\s*--([A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/;

/** CSS custom properties (any stylesheet, a Tailwind v4 `@theme` included) → { patch, warnings }. */
export function importCssVars(css, options = {}) {
  checkText(css);
  const warnings = [];
  const vars = parseCssVars(css);
  const patch = {};
  const colorEntries = [];
  const styleMap = {};
  const fonts = {};
  const rootScheme = vars.find((v) => v.name === 'color-scheme' && v.scope === 'root')?.value;
  const themeOf = (v) => (v.scope === 'root' ? null : v.scope);
  const colorAlias = (name) => {
    const key = name.replace(/^color-/, '');
    const stepped = /^(.+)-(50|100|200|300|400|500|600|700|800|900|950)$/.exec(key);
    if (stepped) return `{${stepped[1]}.${stepped[2]}}`;
    if (STATUS_KEYS.includes(key)) return `{status.${key}}`;
    return null;
  };
  const style = (id) => (styleMap[id] ||= {});
  for (const v of vars) {
    if (v.name === 'color-scheme') continue;
    const name = v.name.slice(2).toLowerCase();
    const ref = VAR_RE.exec(v.value);
    const value = ref ? (colorAlias(ref[1]) ? null : ref[2]?.trim() ?? null) : v.value;
    let m;
    if ((m = /^font-(heading|body|mono|display|sans|serif)$/.exec(name))) {
      const stack = splitFontStack(v.value);
      const slot = m[1] === 'sans' || m[1] === 'serif' ? 'body' : m[1];
      if (stack && !(slot === 'body' && fonts.body && m[1] !== 'body')) fonts[slot] = makeFont(stack.family, stack.fallback, options);
    } else if ((m = /^text-([a-z0-9-]+?)--(line-height|font-weight|letter-spacing)$/.exec(name)) || (m = /^text-([a-z0-9]+(?:-[a-z0-9]+)*?)-(size-mobile|size|weight|line-height|letter-spacing)$/.exec(name))) {
      const field = { size: 'fontSize', 'size-mobile': 'mobileSize', weight: 'fontWeight', 'font-weight': 'fontWeight', 'line-height': 'lineHeight', 'letter-spacing': 'letterSpacing' }[m[2]];
      style(m[1])[field] = v.value;
    } else if ((m = /^text-([a-z0-9]+(?:-[a-z0-9]+)*?)-font$/.exec(name))) {
      const font = /^var\(--font-(heading|body|mono|display)\)$/.exec(v.value);
      if (font) style(m[1])._font = font[1];
    } else if ((m = /^text-([a-z0-9-]+)$/.exec(name)) && toPx(v.value) !== null) {
      style(m[1]).fontSize = v.value;
    } else if (name === 'spacing' && toPx(v.value) !== null) {
      ((patch.layout ||= {}).spacing ||= {}).base = toPx(v.value);
    } else if ((m = /^(?:space|spacing)-([a-z0-9-]+)$/.exec(name)) && toPx(v.value) !== null) {
      (((patch.layout ||= {}).spacing ||= {}).scale ||= {})[m[1]] = toPx(v.value);
    } else if ((m = /^radius(?:-([a-z0-9-]+))?$/.exec(name))) {
      const target = /^var\(--radius-([a-z0-9-]+)\)$/.exec(v.value);
      if (target && m[1]) ((patch.shape ||= {}).radiusRoles ||= {})[m[1]] = target[1];
      else if (toPx(v.value) !== null) ((patch.shape ||= {}).radius ||= {})[m[1] || 'md'] = toPx(v.value);
    } else if ((m = /^border-([a-z0-9-]+)$/.exec(name)) && toPx(v.value) !== null) {
      ((patch.shape ||= {}).borders ||= {})[m[1]] = toPx(v.value);
    } else if ((m = /^shadow-([a-z0-9-]+)$/.exec(name))) {
      ((patch.shape ||= {}).elevation ||= {})[m[1]] = { shadow: v.value === '0 0 #0000' ? 'none' : v.value };
    } else if ((m = /^duration-([a-z0-9-]+)$/.exec(name))) {
      // The reduced-motion block zeroes the durations: that is not the token's value.
      if (toMs(v.value) !== null && !(patch.motion?.durations && m[1] in patch.motion.durations)) ((patch.motion ||= {}).durations ||= {})[m[1]] = toMs(v.value);
    } else if ((m = /^ease-([a-z0-9-]+)$/.exec(name))) {
      ((patch.motion ||= {}).easings ||= {})[m[1]] = v.value;
    } else if ((m = /^breakpoint-([a-z0-9-]+)$/.exec(name)) && toPx(v.value) !== null) {
      ((patch.layout ||= {}).breakpoints ||= {})[m[1]] = toPx(v.value);
    } else if ((m = /^z-([a-z0-9-]+)$/.exec(name)) && Number.isFinite(Number(v.value))) {
      ((patch.layout ||= {}).zIndex ||= {})[m[1]] = Number(v.value);
    } else if (name === 'container-max' && toPx(v.value) !== null) ((patch.layout ||= {}).container ||= {}).maxWidth = toPx(v.value);
    else if (name === 'container-padding' && toPx(v.value) !== null) ((patch.layout ||= {}).container ||= {}).padding = toPx(v.value);
    else if (name === 'grid-columns' && Number.isFinite(Number(v.value))) ((patch.layout ||= {}).grid ||= {}).columns = Number(v.value);
    else if (name === 'grid-gutter' && toPx(v.value) !== null) ((patch.layout ||= {}).grid ||= {}).gutter = toPx(v.value);
    else if ((m = /^gradient-([a-z0-9-]+)$/.exec(name))) {
      ((patch.colors ||= {}).gradients ||= []).push({ name: m[1], css: v.value, usage: '' });
    } else {
      const key = name.replace(/^color-/, '');
      const alias = ref ? colorAlias(ref[1]) : null;
      const color = alias || (value ? toHex(value) : null);
      if (color) colorEntries.push([key, color, themeOf(v)]);
    }
  }
  if (patch.shape?.radius) {
    const roles = splitRadiusRoles(patch.shape.radius);
    if (Object.keys(roles).length) patch.shape.radiusRoles = { ...roles, ...(patch.shape.radiusRoles || {}) };
    if (!Object.keys(patch.shape.radius).length) delete patch.shape.radius;
  }
  // A root block that declares itself dark holds the dark theme's flat names.
  const entries = rootScheme === 'dark' ? colorEntries.map(([key, color, theme]) => [key, color, theme || (ROLE_SYNONYMS[key] || SEMANTIC_ROLES.includes(roleFromName(key)) ? 'dark' : null)]) : colorEntries;
  const sorted = sortColors(entries, warnings);
  const gradients = patch.colors?.gradients;
  if (Object.keys(sorted.colors).length) patch.colors = { ...sorted.colors, ...(gradients ? { gradients } : {}) };
  if (rootScheme === 'dark' && patch.colors?.semantic?.dark && !patch.colors.semantic.light) patch.colors.themes = { default: 'dark', supports: ['dark'] };
  const preset = Object.fromEntries(Object.entries(styleMap).map(([id, raw]) => [id, raw._font]));
  for (const raw of Object.values(styleMap)) delete raw._font;
  const typography = sortTypography(styleMap, options, warnings);
  if (typography) {
    for (const [id, s] of Object.entries(typography.styles)) if (preset[id]) s.font = preset[id];
    delete typography.fonts;
    patch.typography = typography;
  }
  if (Object.keys(fonts).length) (patch.typography ||= {}).fonts = fonts;
  if (!vars.length) warnings.push('No CSS custom properties found.');
  return { patch, warnings };
}

// ── Tailwind theme (JSON) ───────────────────────────────────────────────────

/** A Tailwind theme as JSON ({ theme: { extend } }, { theme }, { extend } or the theme itself) → { patch, warnings }. */
export function importTailwindTheme(input, options = {}) {
  const warnings = [];
  let doc = input;
  if (typeof input === 'string') {
    checkText(input);
    try { doc = JSON.parse(input); } catch (error) { throw new ImportError('BAD_JSON', `Not valid JSON: ${error.message}`); }
  }
  checkTree(doc);
  if (!isPlainObject(doc)) throw new ImportError('BAD_JSON', 'A Tailwind theme is a JSON object');
  const base = isPlainObject(doc.theme) ? doc.theme : doc;
  const theme = { ...base, ...(isPlainObject(base.extend) ? base.extend : {}) };
  const patch = {};
  if (isPlainObject(theme.colors)) {
    const entries = [];
    const literal = (value) => { const ref = typeof value === 'string' ? VAR_RE.exec(value.trim()) : null; return ref ? ref[2]?.trim() : value; };
    for (const [name, value] of Object.entries(theme.colors)) {
      if (isPlainObject(value)) {
        for (const [step, color] of Object.entries(value)) {
          if (step === 'DEFAULT') { if (!value['500']) entries.push([name, literal(color)]); } else entries.push([`${name}-${step}`, literal(color)]);
        }
      } else entries.push([name, literal(value)]);
    }
    const sorted = sortColors(entries.filter(([, value]) => typeof value === 'string' && toHex(value)), warnings, { realias: true });
    if (Object.keys(sorted.colors).length) patch.colors = sorted.colors;
  }
  if (isPlainObject(theme.fontFamily)) {
    const fonts = {};
    for (const [key, value] of Object.entries(theme.fontFamily)) {
      const stack = splitFontStack(value);
      if (!stack) continue;
      const slot = ['heading', 'body', 'mono', 'display'].includes(key) ? key : key === 'sans' || key === 'serif' ? 'body' : /mono|code/.test(key) ? 'mono' : /head|title/.test(key) ? 'heading' : null;
      if (slot && !(fonts[slot] && (key === 'sans' || key === 'serif'))) fonts[slot] = makeFont(stack.family, stack.fallback, options);
    }
    if (Object.keys(fonts).length) patch.typography = { fonts };
  }
  if (isPlainObject(theme.fontSize)) {
    const styleMap = {};
    for (const [id, value] of Object.entries(theme.fontSize)) {
      const [size, extra] = Array.isArray(value) ? value : [value, {}];
      const more = isPlainObject(extra) ? extra : { lineHeight: extra };
      styleMap[id] = { fontSize: size, lineHeight: more.lineHeight, letterSpacing: more.letterSpacing ?? 0, fontWeight: more.fontWeight };
    }
    const typography = sortTypography(styleMap, options, warnings);
    if (typography) patch.typography = { ...(patch.typography || {}), styles: typography.styles };
  }
  const dims = (map, label) => dimensionMap(Object.fromEntries(Object.entries(map || {}).filter(([key]) => key !== 'DEFAULT')), warnings, label);
  const spacing = isPlainObject(theme.spacing) ? dims(theme.spacing, 'Spacing') : null;
  if (spacing) ((patch.layout ||= {}).spacing ||= {}).scale = Object.fromEntries(Object.entries(spacing).slice(0, 24));
  const radius = isPlainObject(theme.borderRadius) ? dims(theme.borderRadius, 'Radius') : null;
  if (radius) {
    const roles = splitRadiusRoles(radius);
    if (Object.keys(radius).length) (patch.shape ||= {}).radius = radius;
    if (Object.keys(roles).length) (patch.shape ||= {}).radiusRoles = roles;
  }
  const borders = isPlainObject(theme.borderWidth) ? dims(theme.borderWidth, 'Border') : null;
  if (borders) (patch.shape ||= {}).borders = borders;
  const screens = isPlainObject(theme.screens) ? dims(theme.screens, 'Breakpoint') : null;
  if (screens) (patch.layout ||= {}).breakpoints = screens;
  if (isPlainObject(theme.boxShadow)) {
    const elevation = {};
    for (const [key, value] of Object.entries(theme.boxShadow)) if (typeof value === 'string' && tokenKey(key) && key !== 'DEFAULT') elevation[tokenKey(key)] = { shadow: value };
    if (Object.keys(elevation).length) (patch.shape ||= {}).elevation = elevation;
  }
  if (isPlainObject(theme.zIndex)) {
    const zIndex = Object.fromEntries(Object.entries(theme.zIndex).filter(([key, value]) => tokenKey(key) && Number.isFinite(Number(value))).map(([key, value]) => [tokenKey(key), Number(value)]));
    if (Object.keys(zIndex).length) (patch.layout ||= {}).zIndex = zIndex;
  }
  if (isPlainObject(theme.transitionTimingFunction)) {
    const easings = Object.fromEntries(Object.entries(theme.transitionTimingFunction).filter(([key, value]) => key !== 'DEFAULT' && typeof value === 'string').map(([key, value]) => [tokenKey(key), value]));
    if (Object.keys(easings).length) (patch.motion ||= {}).easings = easings;
  }
  if (isPlainObject(theme.transitionDuration)) {
    const durations = Object.fromEntries(Object.entries(theme.transitionDuration).filter(([key, value]) => key !== 'DEFAULT' && toMs(value) !== null).map(([key, value]) => [/^\d/.test(key) ? `d${key}` : tokenKey(key), toMs(value)]));
    if (Object.keys(durations).length) (patch.motion ||= {}).durations = durations;
  }
  if (!Object.keys(patch).length) warnings.push('No theme values found: expected colors, fontFamily, fontSize, spacing, borderRadius, boxShadow or screens.');
  return { patch, warnings };
}

// ── codebase scan ───────────────────────────────────────────────────────────

/** The object literal after `key:` in JS source, as text (braces matched, strings skipped), or null. */
function objectLiteralAfter(source, key) {
  const match = new RegExp(`(?:^|[\\s,{])["']?${key}["']?\\s*:\\s*\\{`).exec(source);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0; let quote = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

/** A JS object literal of plain values → an object, or null: quotes the keys, drops comments and trailing commas. */
function looseObject(literal) {
  if (!literal) return null;
  const json = literal
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, body) => JSON.stringify(body.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*|\d+)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(json); } catch { return null; }
}

/** What a tailwind.config.* file says about the theme, read as text (the file is never executed). */
export function tailwindConfigTheme(source) {
  const theme = {};
  for (const key of ['colors', 'fontFamily', 'fontSize', 'borderRadius', 'boxShadow', 'screens', 'spacing']) {
    const value = looseObject(objectLiteralAfter(String(source ?? ''), key));
    if (isPlainObject(value)) theme[key] = value;
  }
  return theme;
}

/**
 * Read the project's own styling: `*.css`, `*.scss`, `tailwind.config.*` and a hand-written DESIGN.md,
 * skipping node_modules, dist, build, .git and SynaBun's own output, at most `maxFiles` files of
 * 1 MB each. Later sources win: DESIGN.md, then the Tailwind config, then the stylesheets.
 * `fs` needs readdirSync (withFileTypes), readFileSync and statSync. → { patch, warnings, files }.
 */
export function scanCodebase(root, { fs = nodeFs, maxFiles = SCAN_MAX_FILES, googleFonts = null } = {}) {
  maxFiles = Math.min(SCAN_MAX_FILES, Math.max(1, Math.floor(Number(maxFiles) || SCAN_MAX_FILES)));
  const warnings = [];
  const found = [];
  const queue = [root];
  let capped = false;
  let dirs = 0;
  while (queue.length && !capped) {
    const dir = queue.shift();
    if (++dirs > 4000) { warnings.push('Stopped after 4000 directories.'); break; }
    if (fs === nodeFs && !containedPath(root, dir, { noSymlinks: true })) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink?.()) continue;
      if (entry.isDirectory()) { if (!SCAN_SKIP_DIRS.has(entry.name)) queue.push(path); continue; }
      if (!entry.isFile()) continue;
      const kind = /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(entry.name) ? 'tailwind' : /\.(css|scss)$/i.test(entry.name) && !/\.min\.css$/i.test(entry.name) ? 'css' : (entry.name === 'DESIGN.md' && dir === root) ? 'design-md' : null;
      if (!kind) continue;
      if (found.length >= maxFiles) { capped = true; break; }
      found.push({ path, kind });
    }
  }
  if (capped) warnings.push(`Stopped after ${maxFiles} files: the rest of the project was not read.`);
  const read = (path) => {
    try {
      if (fs === nodeFs && !containedPath(root, path, { noSymlinks: true })) return null;
      if (fs.statSync(path).size > SCAN_MAX_BYTES) return null;
      const text = fs.readFileSync(path, 'utf8');
      return Buffer.byteLength(text) <= SCAN_MAX_BYTES ? text : null;
    } catch { return null; }
  };
  const options = { googleFonts };
  let patch = {};
  const files = [];
  const add = (file, result) => {
    for (const warning of result.warnings) if (!/^No (CSS custom properties|theme values|YAML frontmatter)/.test(warning)) warnings.push(`${file}: ${warning}`);
    if (!Object.keys(result.patch).length) return;
    patch = applyMergePatch(patch, result.patch);
    files.push(file);
  };
  const rel = (path) => relative(root, path).split(sep).join('/');
  for (const kind of ['design-md', 'tailwind', 'css']) {
    for (const file of found.filter((entry) => entry.kind === kind)) {
      const text = read(file.path);
      if (text === null) continue;
      try {
        if (kind === 'design-md') { if (!/Generated by SynaBun Style Guide/.test(text)) add(rel(file.path), importDesignMd(text, options)); }
        else if (kind === 'tailwind') add(rel(file.path), importTailwindTheme(tailwindConfigTheme(text), options));
        else if (/--[A-Za-z]|\$[A-Za-z][\w-]*\s*:/.test(text)) add(rel(file.path), importCssVars(text, options));
      } catch (error) { warnings.push(`${rel(file.path)}: ${error.message}`); }
    }
  }
  if (!files.length) warnings.push('No design tokens found in this project (looked for CSS custom properties, a Tailwind config and a DESIGN.md).');
  return { patch, warnings, files, scanned: found.length };
}

// ── community ───────────────────────────────────────────────────────────────

/**
 * Fetch `design-md/<slug>/DESIGN.md` from the community collection. The slug is checked against
 * COMMUNITY_SLUG_RE before any request; the request stops after `timeoutMs`. Throws ImportError.
 */
export async function fetchCommunityDesignMd(slug, { fetchImpl = globalThis.fetch, timeoutMs = 10000, maxBytes = MAX_IMPORT_BYTES } = {}) {
  const name = String(slug ?? '').trim().toLowerCase();
  if (!COMMUNITY_SLUG_RE.test(name) || name.includes('..') || name.startsWith('.') || name.endsWith('.')) throw new ImportError('BAD_SLUG', 'A community slug is 1 to 40 characters: a-z, 0-9, "." and "-".');
  if (typeof fetchImpl !== 'function') throw new ImportError('FETCH_UNAVAILABLE', 'No fetch available', 500);
  const url = `${COMMUNITY_BASE_URL}/${name}/DESIGN.md`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'text/plain' } });
    if (response.status === 404) throw new ImportError('NOT_FOUND', `No community DESIGN.md named "${name}".`, 404);
    if (!response.ok) throw new ImportError('FETCH_FAILED', `The community collection answered HTTP ${response.status}.`, 502);
    if (response.redirected || (response.url && response.url !== url)) throw new ImportError('FETCH_FAILED', 'Community redirects are not allowed.', 502);
    if (Number(response.headers?.get('content-length')) > maxBytes) {
      controller.abort();
      throw new ImportError('TOO_LARGE', 'That DESIGN.md is too large to import.', 413);
    }
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            controller.abort();
            await reader.cancel().catch(() => {});
            throw new ImportError('TOO_LARGE', 'That DESIGN.md is too large to import.', 413);
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        text = chunks.join('') + decoder.decode();
      } finally { reader.releaseLock(); }
    } else text = await response.text(); // Injected test adapters without a response stream.
    if (Buffer.byteLength(text) > maxBytes) throw new ImportError('TOO_LARGE', 'That DESIGN.md is too large to import.', 413);
    return { text, url, slug: name };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (controller.signal.aborted) throw new ImportError('TIMEOUT', `The community collection did not answer within ${Math.round(timeoutMs / 1000)} s.`, 504);
    throw new ImportError('FETCH_FAILED', `Could not reach the community collection: ${error?.message || error}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

// ── applying an import ──────────────────────────────────────────────────────

// Maps an import replaces whole in `replace` mode (otherwise the defaults' entries would stay beside the imported ones).
const REPLACED_MAPS = Object.freeze([
  ['typography', 'styles'], ['layout', 'spacing', 'scale'], ['layout', 'breakpoints'], ['layout', 'zIndex'],
  ['shape', 'radius'], ['shape', 'elevation'], ['shape', 'borders'], ['motion', 'durations'], ['motion', 'easings'],
]);
const at = (object, path) => path.reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), object);

/**
 * The config an import produces. `merge`: the patch over the current guide. `replace`: the patch over
 * the defaults, keeping what is not a design decision (the project, the revision, the logo files, the
 * agent and export settings). Missing font roles keep their stored values in merge and use the
 * schema defaults in replace (including the default heading family). → { config, diff (against `base`) }.
 */
export function buildImport(base, patch, { merge = 'merge' } = {}) {
  const current = normalizeStyleGuide(base);
  let start = current;
  if (merge === 'replace') {
    start = defaultStyleGuide(current.projectPath);
    Object.assign(start, { revision: current.revision, updatedAt: current.updatedAt, logo: current.logo, agents: current.agents, exports: current.exports });
    for (const path of REPLACED_MAPS) {
      if (isPlainObject(at(patch, path))) at(start, path.slice(0, -1))[path[path.length - 1]] = {};
    }
    if (isPlainObject(patch?.colors?.semantic)) for (const theme of THEMES) if (patch.colors.semantic[theme]) start.colors.semantic[theme] = {};
  }
  const { components, ...rest } = isPlainObject(patch) ? patch : {};
  // A guide without a brand name is rendered under its folder's name: reading that back is not a brand name.
  if (!current.brand.name && rest.brand?.name && rest.brand.name === basename(current.projectPath.replace(/[\\/]+$/, ''))) {
    const { name: _folder, ...brand } = rest.brand;
    rest.brand = brand;
  }
  const gradients = rest.colors?.gradients;
  const body = gradients ? { ...rest, colors: { ...rest.colors } } : { ...rest };
  if (gradients) delete body.colors.gradients;
  if (merge === 'merge' && isPlainObject(body.typography?.fonts)) {
    // The same family keeps the weights the guide lists: an import only knows the ones its text styles use.
    body.typography = { ...body.typography, fonts: Object.fromEntries(Object.entries(body.typography.fonts).map(([key, font]) => {
      if (!isPlainObject(font) || font.family !== current.typography.fonts[key]?.family) return [key, font];
      const { weights: _weights, fallback: _fallback, ...kept } = font;
      return [key, kept];
    })) };
  }
  const merged = applyMergePatch(start, body);
  // Arrays are replaced whole by a merge patch; components and gradients merge by id / name instead.
  const same = (a, b) => resolveText(current, a).text.replace(/\s+/g, '') === resolveText(current, b).text.replace(/\s+/g, '')
    || (isAlias(a) && isAlias(b) && resolveAlias(current, a).ok && JSON.stringify(resolveAlias(current, a).value) === JSON.stringify(resolveAlias(current, b).value));
  if (Array.isArray(components)) {
    if (merge === 'replace') merged.components = components;
    else {
      const list = merged.components.map((component) => ({ ...component, tokens: { ...component.tokens }, states: { ...component.states } }));
      for (const incoming of components) {
        const existing = list.find((component) => component.id === incoming.id);
        if (!existing) { list.push(incoming); continue; }
        for (const [key, value] of Object.entries(incoming.tokens || {})) if (!(key in existing.tokens) || !same(existing.tokens[key], value)) existing.tokens[key] = value;
        for (const [key, value] of Object.entries(incoming.states || {})) if (value) existing.states[key] = value;
      }
      merged.components = list;
    }
  }
  if (Array.isArray(gradients)) {
    if (merge === 'replace') merged.colors.gradients = gradients;
    else {
      const list = merged.colors.gradients.map((gradient) => ({ ...gradient }));
      for (const incoming of gradients) {
        const existing = list.find((gradient) => gradient.name === incoming.name);
        if (!existing) list.push(incoming);
        else if (!same(existing.css, incoming.css)) existing.css = incoming.css;
      }
      merged.colors.gradients = list;
    }
  }
  const config = normalizeStyleGuide(merged, { projectPath: current.projectPath });
  return { config, diff: diffConfigs(current, config) };
}

/**
 * One import, start to finish. `deps`: { fs, fetchImpl, googleFonts, projectRoot }.
 * → { config, diff, warnings, patch, files?, source? }. Throws ImportError for a bad request.
 */
export async function runImport({ kind, text = '', slug = '', base, merge = 'merge', deps = {} } = {}) {
  if (!IMPORT_KINDS.includes(kind)) throw new ImportError('BAD_KIND', `kind must be one of: ${IMPORT_KINDS.join(', ')}`);
  if (!['merge', 'replace'].includes(merge)) throw new ImportError('BAD_MERGE', 'merge must be "merge" or "replace"');
  if (typeof text === 'string' && Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new ImportError('TOO_LARGE', 'That file is too large to import.', 413);
  const options = { googleFonts: deps.googleFonts || null };
  let result;
  const extra = {};
  if (kind === 'codebase') {
    if (!deps.projectRoot) throw new ImportError('NO_PROJECT', 'A codebase scan needs the project root.');
    result = scanCodebase(deps.projectRoot, { fs: deps.fs || nodeFs, googleFonts: options.googleFonts });
    extra.files = result.files;
  } else if (kind === 'community') {
    const fetched = await fetchCommunityDesignMd(slug, { fetchImpl: deps.fetchImpl || globalThis.fetch, timeoutMs: deps.timeoutMs || 10000 });
    result = importDesignMd(fetched.text, options);
    result.warnings.unshift(COMMUNITY_ATTRIBUTION);
    extra.source = fetched.url;
  } else {
    if (typeof text !== 'string' || !text.trim()) throw new ImportError('NO_TEXT', 'text is required for this kind of import.');
    if (kind === 'design-md') result = importDesignMd(text, options);
    else if (kind === 'dtcg') result = importDtcg(text, options);
    else if (kind === 'css') result = importCssVars(text, options);
    else result = importTailwindTheme(text, options);
  }
  const built = buildImport(base, result.patch, { merge });
  return { ...built, warnings: result.warnings, patch: result.patch, ...extra };
}
