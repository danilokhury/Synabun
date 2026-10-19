// ═══════════════════════════════════════════
// SynaBun Neural Interface — the desktop app's title bar: what it decides
// ═══════════════════════════════════════════
//
// Inside the SynaBun desktop app (packaging/desktop) the window has no native
// title bar: the page's own top bar (#title-bar) is it, with the system's
// caption buttons (Windows, Linux) or traffic lights (macOS) drawn over one of
// its ends. desktop-titlebar.js does the page's part; this file decides, from
// plain values: the colours the caption buttons get, whether the bar makes room
// for them now, where they are when the page has no Window Controls Overlay API,
// and whether something drawn over the bar has to get its clicks.
//
// No imports and no DOM: `node --test` loads this file as it is
// (tests/desktop-titlebar-view.test.mjs).

/** 'rgb(r, g, b)', 'rgba(r, g, b, a)', 'rgb(r g b / a)', '#rgb', '#rrggbb', '#rrggbbaa' or 'transparent' → { r, g, b, a }, or null. */
export function parseCssColor(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = digits.split('').map(ch => ch + ch).join('');
    const byte = (at) => parseInt(digits.slice(at, at + 2), 16);
    return { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(value);
  if (!fn) return null;
  const parts = fn[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (part) => (part.endsWith('%') ? (parseFloat(part) / 100) * 255 : parseFloat(part));
  const [r, g, b] = parts.slice(0, 3).map(channel);
  let a = 1;
  if (parts[3] !== undefined) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if (![r, g, b, a].every(Number.isFinite)) return null;
  const clamp = (n, max) => Math.max(0, Math.min(max, n));
  return { r: clamp(r, 255), g: clamp(g, 255), b: clamp(b, 255), a: clamp(a, 1) };
}

/** An { r, g, b } colour as #rrggbb. */
export function toHex({ r, g, b }) {
  return `#${[r, g, b].map(part => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Colours stacked on top of each other (`layers`, top first, any alpha) over an
 * opaque `base`: the one opaque colour the eye sees. Layers that cannot be read
 * are skipped; so is everything under the first opaque one.
 */
export function flatten(layers, base) {
  const stack = [];
  for (const layer of layers || []) {
    const color = typeof layer === 'string' ? parseCssColor(layer) : layer;
    if (!color) continue;
    stack.push(color);
    if (color.a >= 1) break;
  }
  let out = (typeof base === 'string' ? parseCssColor(base) : base) || { r: 5, g: 5, b: 5, a: 1 };
  for (const color of stack.reverse()) {
    out = { r: color.r * color.a + out.r * (1 - color.a), g: color.g * color.a + out.g * (1 - color.a), b: color.b * color.a + out.b * (1 - color.a), a: 1 };
  }
  return out;
}

/**
 * The caption buttons' colours (Windows, Linux) for the bar as it is drawn now:
 * `bar` the bar's own background, `under` the backgrounds below it where the
 * buttons are (top first), `base` the page's background, `text` the bar's text
 * tone (DESIGN.md nav-bar: text-primary). Two opaque #rrggbb colours: the
 * buttons are drawn over the page, so a see-through colour would show what is
 * under them through Windows' hover fill.
 */
export function overlayColorsFor({ bar, under = [], base = '#050505', text = 'rgba(255, 255, 255, 0.7)' } = {}) {
  const background = flatten([bar, ...under], base);
  const symbol = flatten([text], background);
  return { color: toHex(background), symbolColor: toHex(symbol) };
}

/**
 * Whether the bar makes room for the window's own controls now: while the
 * overlay is shown (Electron's WCO API says so; without that API, while the
 * app says it has one) and the window is not full screen, where the system
 * hides its buttons and the bar takes its usual layout.
 */
export function titleBarActive({ overlayVisible = null, hasOverlayApi = true, fullScreen = false } = {}) {
  if (fullScreen) return false;
  return hasOverlayApi ? overlayVisible === true : true;
}

/**
 * Where the window's controls are, for a page without the WCO API (its CSS
 * variables then never resolve): the title bar area the page may use, as the
 * page's CSS variables --titlebar-area-x / -width / -height. Windows' and
 * Linux's caption buttons are about 46 px each, three of them; macOS's traffic
 * lights end about 70 px in, plus the same inset after them.
 */
export function fallbackTitlebarArea(facts, viewportWidth) {
  const width = Math.max(0, Number(viewportWidth) || 0);
  const height = Number(facts?.height) || 48;
  if (facts?.controls === 'left') {
    const x = 86;
    return { x, width: Math.max(0, width - x), height };
  }
  const buttons = 138;
  return { x: 0, width: Math.max(0, width - buttons), height };
}

/**
 * Whether something is drawn over the bar that has to get its clicks (a
 * dialog, the tour, a menu's catch-all layer): the bar's empty parts drag the
 * window, and the system takes a drag region's clicks before the page sees
 * them, whatever is painted there. `samples` are what is topmost at points along
 * the bar: { inBar } for the bar or anything in it, { page: true } for the page's
 * own root (nothing there), anything else is something over the bar.
 */
export function barCovered(samples) {
  return (samples || []).some(sample => sample && !sample.inBar && !sample.page);
}

/** A stable key for a pair of colours: unchanged colours are never sent twice. */
export const colorsKey = (colors) => (colors ? `${colors.color}/${colors.symbolColor}` : '');
