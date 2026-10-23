// ═══════════════════════════════════════════
// SynaBun Neural Interface — Skills Studio 2.0: where the window is, and where a link takes it
// ═══════════════════════════════════════════
//
// The window opens where it was left (the shared panel system saves a moved or resized window, ui-panels.js), at
// min(1180px, 94% of the width) × min(760px, 86% of the height) the first time, and is kept inside the viewport
// below the menu bar. It can be docked: then it fills the work area beside the side panels (like the code editor)
// and leaves them usable. Its own width decides the layout (CSS container queries at 900 / 760 / 560 px):
// the rail folds to icons, the editor shows one pane at a time, the Library's rows become cards.
// A link into the Studio (`skills:open` with a detail) names a place, a skill, a review, a tab, a file and a line,
// or an AI drafting (a creation) to follow in Create.
// No DOM and no imports.

export const DEFAULT_SIZE = Object.freeze({ width: 1180, height: 760, widthShare: 0.94, heightShare: 0.86 });
export const MIN_SIZE = Object.freeze({ width: 380, height: 320 });
export const LAYOUTS = Object.freeze([{ name: 'compact', max: 560 }, { name: 'narrow', max: 760 }, { name: 'medium', max: 900 }]);
export const PLACES = Object.freeze(['library', 'review', 'create']);
export const TABS = Object.freeze(['edit', 'test', 'versions', 'publish']);

const px = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : null; };

/**
 * The window's first rectangle: what was saved (kept inside the viewport), else the default size, centred.
 * @param {{ vw: number, vh: number, navbar?: number, saved?: { left?, top?, width?, height? } | null }} o
 */
export function initialRect({ vw, vh, navbar = 48, saved = null }) {
  const room = { width: Math.max(MIN_SIZE.width, vw - 20), height: Math.max(MIN_SIZE.height, vh - navbar - 10) };
  let width = px(saved?.width) ?? Math.min(DEFAULT_SIZE.width, Math.round(vw * DEFAULT_SIZE.widthShare));
  let height = px(saved?.height) ?? Math.min(DEFAULT_SIZE.height, Math.round(vh * DEFAULT_SIZE.heightShare));
  width = Math.round(Math.max(MIN_SIZE.width, Math.min(width, room.width)));
  height = Math.round(Math.max(MIN_SIZE.height, Math.min(height, room.height)));
  let left = px(saved?.left);
  let top = px(saved?.top);
  if (left === null) left = Math.round((vw - width) / 2);
  if (top === null) top = Math.round(navbar + Math.max(0, (vh - navbar - height) / 2));
  left = Math.round(Math.max(0, Math.min(left, vw - width)));
  top = Math.round(Math.max(navbar, Math.min(top, vh - height)));
  return { left, top, width, height };
}

/** The layout a width of the window gets (the same thresholds as the CSS container queries). */
export function layoutOf(width) {
  for (const l of LAYOUTS) if (width <= l.max) return l.name;
  return 'wide';
}

/**
 * A link into the Studio, normalised: unknown values fall back, ids are kept only when they have their shape.
 * @param {object} detail what `skills:open` carried
 * @returns {{ place: string, tab: string|null, skillId: string|null, artifactId: string|null, reviewId: string|null,
 *   name: string|null, file: string|null, line: number|null, create: string|null, creationId: string|null }}
 */
export function parseOpen(detail) {
  const d = detail && typeof detail === 'object' ? detail : {};
  const shaped = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
  const out = {
    place: PLACES.includes(d.place) ? d.place : null,
    tab: TABS.includes(d.tab) ? d.tab : null,
    skillId: shaped(d.skillId, /^skl_[0-9a-f]{20}$/),
    artifactId: shaped(d.artifactId, /^art_[0-9a-f]{20}$/),
    reviewId: shaped(d.reviewId, /^rvw_[0-9a-f]{20}$/),
    name: typeof d.name === 'string' && d.name.length <= 128 && !/[\\/]/.test(d.name) ? d.name : null,
    file: typeof d.file === 'string' && d.file.length <= 512 && !d.file.split('/').includes('..') && !d.file.startsWith('/') ? d.file : null,
    line: Number.isInteger(d.line) && d.line > 0 ? d.line : null,
    create: d.create === 'blank' || d.create === 'import' ? d.create : null,
    creationId: shaped(d.creationId, /^crt_[0-9a-f]{20}$/),
  };
  if (!out.place) out.place = out.reviewId ? 'review' : (out.create || out.creationId) ? 'create' : 'library';
  return out;
}

/** The keys of the Studio (also the help it shows): ⌘/Ctrl on a Mac or not. */
export function shortcutLabel(key, mac) {
  return key.replace(/Mod/g, mac ? '⌘' : 'Ctrl').replace(/Alt/g, mac ? '⌥' : 'Alt').replace(/Shift/g, mac ? '⇧' : 'Shift').replace(/Enter/g, mac ? '↵' : 'Enter').replace(/\+/g, mac ? '' : '+');
}
