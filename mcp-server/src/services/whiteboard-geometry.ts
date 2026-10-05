/**
 * Pure whiteboard geometry shared by the MCP whiteboard tools and the Neural
 * Interface server (`server.js` imports the compiled
 * `dist/services/whiteboard-geometry.js`).
 *
 * Everything here mirrors client-side math in
 * `neural-interface/public/shared/ui-whiteboard.js`:
 *   - `anchorPoint`        <- `getAnchorPoint`
 *   - `resolveArrowPoints` <- the anchor block at the top of `renderArrows`
 *   - `SECTION_DEFAULTS`   <- `SECTION_TYPES`
 *   - `ANCHOR_FALLBACK`    <- the `el.width || 100` / `el.height || 60` fallbacks
 * Keep both sides in sync: a change on either side moves where arrows land.
 *
 * Constraints: no imports, no I/O, no Node APIs, no module side effects.
 */

// ── Types ──

/** `[x, y]` in whiteboard pixel space. */
export type WbPoint = [number, number];

/** Browser-reported drawing area. Offsets are the navbar/toolbar insets. */
export interface WbViewport { width: number; height: number; xOffset?: number; yOffset?: number }

/** Axis-aligned box in whiteboard pixel space. */
export interface WbRect { x: number; y: number; width: number; height: number }

/** Persisted whiteboard element — the union of every element type's fields. */
export interface WbElement {
  id: string; type: string; x?: number; y?: number; width?: number; height?: number;
  content?: string; items?: string[]; ordered?: boolean; fontSize?: number; color?: string;
  bold?: boolean; italic?: boolean; shape?: string; points?: WbPoint[]; pathD?: string;
  startAnchor?: string | null; endAnchor?: string | null; strokeWidth?: number; rotation?: number;
  zIndex?: number; dataUrl?: string; dataUrlBytes?: number; url?: string; sectionType?: string; label?: string;
  measured?: boolean; estimated?: boolean; [key: string]: unknown;
}

/** Per-section-type defaults; identical to the client `SECTION_TYPES` table. */
export interface WbSectionDefault { w: number; h: number; color: string; label: string; icon: string }

/** Element lookup used to resolve arrow anchors: a Map or a lookup function. */
export type WbElementLookup = Map<string, WbElement> | ((id: string) => WbElement | undefined);

/** Positive pixel amounts by which a box exceeds a rect, per side (only sides that overflow). */
export interface WbSideAmounts { left?: number; right?: number; top?: number; bottom?: number }

/** Options for `analyzeWhiteboard`. */
export interface WbAnalyzeOptions { focusIds?: string[]; maxOverlaps?: number; maxOverflow?: number }

/** Result of `analyzeWhiteboard`. */
export interface WbAnalysis {
  usable: WbRect;
  /** Union of all element boxes; pct of usable. */
  bounds: (WbRect & { pctWidth: number; pctHeight: number }) | null;
  overflow: { id: string; type: string; severity: 'partial' | 'outside'; by: WbSideAmounts }[];
  overflowTotal: number;
  overlaps: { a: string; b: string; aType: string; bType: string; intersection: { width: number; height: number; area: number }; pctOfSmaller: number }[];
  overlapsTotal: number;
  overlapsTruncated: boolean;
  containment: { section: string; label: string; children: string[]; spills: { id: string; by: WbSideAmounts }[] }[];
  unparented: string[];
  estimatedCount: number;
  notes: string[];
}

// ── Constants ──

/** Viewport assumed until the browser reports one (server.js default). */
export const DEFAULT_VIEWPORT: Readonly<Required<WbViewport>> = Object.freeze({ width: 1920, height: 937, xOffset: 0, yOffset: 0 });

/** Size given to a shape that arrives without one. */
export const SHAPE_DEFAULT: Readonly<{ width: number; height: number }> = Object.freeze({ width: 160, height: 100 });

/** Size the client assumes for anchor targets without a (truthy) width/height. */
export const ANCHOR_FALLBACK: Readonly<{ width: number; height: number }> = Object.freeze({ width: 100, height: 60 });

/** Shape variants accepted by `shape` elements. */
export const SHAPE_TYPES = ['rect', 'pill', 'circle', 'triangle', 'drawn-circle'] as const;

/** The 12 section types, in the client's menu order. */
export const SECTION_TYPE_NAMES = [
  'navbar', 'hero', 'sidebar', 'content', 'footer', 'card',
  'form', 'image-placeholder', 'button', 'text-block', 'grid', 'modal',
] as const;

/** One of `SECTION_TYPE_NAMES`. */
export type WbSectionTypeName = typeof SECTION_TYPE_NAMES[number];

/** Every persisted element type. */
export const ELEMENT_TYPES = ['text', 'list', 'shape', 'arrow', 'pen', 'image', 'section'] as const;

const SECTION_TABLE = {
  navbar:              { w: 960, h: 56,  color: '#64748b', label: 'Navbar',     icon: '≡' },
  hero:                { w: 960, h: 340, color: '#6366f1', label: 'Hero',       icon: '☆' },
  sidebar:             { w: 260, h: 400, color: '#475569', label: 'Sidebar',    icon: '⊞' },
  content:             { w: 640, h: 360, color: '#737373', label: 'Content',    icon: '¶' },
  footer:              { w: 960, h: 100, color: '#6b7280', label: 'Footer',     icon: '─' },
  card:                { w: 260, h: 180, color: '#14b8a6', label: 'Card',       icon: '□' },
  form:                { w: 380, h: 280, color: '#f59e0b', label: 'Form',       icon: '☐' },
  'image-placeholder': { w: 280, h: 180, color: '#a855f7', label: 'Image',      icon: '⊞' },
  button:              { w: 140, h: 42,  color: '#22c55e', label: 'Button',     icon: '▸' },
  'text-block':        { w: 380, h: 90,  color: '#e2e8f0', label: 'Text Block', icon: 'T' },
  grid:                { w: 640, h: 320, color: '#06b6d4', label: 'Grid',       icon: '⊞⊞' },
  modal:               { w: 440, h: 300, color: '#f43f5e', label: 'Modal',      icon: '◻' },
} satisfies Record<WbSectionTypeName, WbSectionDefault>;

/** Section defaults keyed by section type — same 12 entries and values as the client. */
export const SECTION_DEFAULTS: Record<string, WbSectionDefault> = SECTION_TABLE;

/** Element types that occupy a box and take part in overlap/containment checks. */
const SOLID_TYPES: ReadonlySet<string> = new Set(['text', 'list', 'shape', 'image', 'section']);

// ── Internal helpers ──

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A stored dimension counts only when it is a positive finite number (0 falls back, like the client's `||`). */
function positiveDim(v: unknown): number | undefined {
  return isFiniteNumber(v) && v > 0 ? v : undefined;
}

function codePointLength(s: string): number {
  return Array.from(s).length;
}

function limitOr(v: unknown, fallback: number): number {
  return isFiniteNumber(v) && v >= 0 ? Math.floor(v) : fallback;
}

function toLookup(byId: WbElementLookup | undefined): (id: string) => WbElement | undefined {
  if (!byId) return () => undefined;
  if (typeof byId === 'function') return byId;
  return (id) => byId.get(id);
}

/** Own-property lookup so `sectionType: 'constructor'` cannot leak Object.prototype. */
function sectionDefault(type: unknown): WbSectionDefault | undefined {
  return typeof type === 'string' && Object.hasOwn(SECTION_DEFAULTS, type) ? SECTION_DEFAULTS[type] : undefined;
}

function contentString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  return v == null ? undefined : String(v);
}

function itemStrings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.map(item => (typeof item === 'string' ? item : String(item ?? ''))) : undefined;
}

/** Stored size, or the type's fallback when a dimension is missing (see `elementBox`). */
function storedOrDefaultSize(el: WbElement): { width: number; height: number } {
  const w = positiveDim(el.width);
  const h = positiveDim(el.height);
  if (w !== undefined && h !== undefined) return { width: w, height: h };
  switch (el.type) {
    case 'text': {
      const est = estimateTextSize(contentString(el.content), positiveDim(el.fontSize) ?? 22);
      return { width: w ?? est.width, height: h ?? est.height };
    }
    case 'list': {
      const est = estimateListSize(itemStrings(el.items), positiveDim(el.fontSize) ?? 18);
      return { width: w ?? est.width, height: h ?? est.height };
    }
    case 'shape':
      return { width: w ?? SHAPE_DEFAULT.width, height: h ?? SHAPE_DEFAULT.height };
    case 'section': {
      const def = sectionDefault(el.sectionType) ?? SECTION_DEFAULTS.content;
      return { width: w ?? def.w, height: h ?? def.h };
    }
    default:
      return { width: w ?? 0, height: h ?? 0 };
  }
}

/** Rounded, positive per-side amounts by which `box` sticks out of `rect`; sub-pixel (< 0.5px) overflow is ignored. */
function sideAmounts(box: WbRect, rect: WbRect): WbSideAmounts {
  const by: WbSideAmounts = {};
  const left = Math.round(rect.x - box.x);
  const top = Math.round(rect.y - box.y);
  const right = Math.round(box.x + box.width - (rect.x + rect.width));
  const bottom = Math.round(box.y + box.height - (rect.y + rect.height));
  if (left > 0) by.left = left;
  if (right > 0) by.right = right;
  if (top > 0) by.top = top;
  if (bottom > 0) by.bottom = bottom;
  return by;
}

function hasSides(by: WbSideAmounts): boolean {
  return by.left !== undefined || by.right !== undefined || by.top !== undefined || by.bottom !== undefined;
}

function sumSides(by: WbSideAmounts): number {
  return (by.left ?? 0) + (by.right ?? 0) + (by.top ?? 0) + (by.bottom ?? 0);
}

/** Minimal shift along one axis so a span of `size` starting at `start` fits in `[rectStart, rectStart + rectSize]`. */
function fitShift(start: number, size: number, rectStart: number, rectSize: number): number {
  if (size > rectSize || start < rectStart) return rectStart - start;
  const end = start + size;
  const rectEnd = rectStart + rectSize;
  return end > rectEnd ? rectEnd - end : 0;
}

// ── Viewport ──

/**
 * The drawable area as a rect: `{ x: xOffset||0, y: yOffset||0, width, height }`.
 * Missing/invalid dimensions fall back to `DEFAULT_VIEWPORT`.
 */
export function usableRect(vp: WbViewport | null | undefined): WbRect {
  const v = vp ?? DEFAULT_VIEWPORT;
  return {
    x: v.xOffset || 0,
    y: v.yOffset || 0,
    width: isFiniteNumber(v.width) ? v.width : DEFAULT_VIEWPORT.width,
    height: isFiniteNumber(v.height) ? v.height : DEFAULT_VIEWPORT.height,
  };
}

// ── Size estimation ──

/**
 * Estimate the rendered size of a text element before the browser measures it.
 * JetBrains Mono advance is ~0.6em; `.wb-text` has 10px/14px padding, a 1px
 * border and line-height 1.35. Empty content is sized like the 12-character
 * "Type here..." placeholder. Characters are counted as code points.
 */
export function estimateTextSize(content: string | undefined, fontSize = 22): { width: number; height: number } {
  const text = content ?? '';
  const lines = text.split('\n');
  const maxChars = text === '' ? 12 : Math.max(...lines.map(codePointLength));
  return {
    width: Math.max(60, Math.round(maxChars * fontSize * 0.6 + 30)),
    height: Math.max(30, Math.round(lines.length * fontSize * 1.35 + 22)),
  };
}

/**
 * Estimate the rendered size of a list element before the browser measures it.
 * Same font metrics as text, plus the 1.4em bullet indent; line-height 1.5.
 */
export function estimateListSize(items: string[] | undefined, fontSize = 18): { width: number; height: number } {
  const list = items ?? [];
  const rows = Math.max(1, list.length);
  const maxChars = list.length ? Math.max(...list.map(codePointLength)) : 0;
  return {
    width: Math.max(120, Math.round(maxChars * fontSize * 0.6 + 1.4 * fontSize + 30)),
    height: Math.max(30, Math.round(rows * fontSize * 1.5 + 22)),
  };
}

/**
 * Fill in missing geometry on an element in place and return the reasons applied.
 *
 * - text/list: re-estimated (`estimated: true`, `measured` removed) when forced,
 *   not yet measured by the browser, or missing a dimension -> 'size:estimated'.
 *   Browser-measured elements (`measured: true`) are left alone unless `force`.
 * - shape: missing/non-positive width/height -> `SHAPE_DEFAULT` -> 'size:shape-default'.
 * - section: unknown/missing `sectionType` -> 'content' -> 'section:type-default';
 *   missing width/height/color/label filled from `SECTION_DEFAULTS`
 *   -> 'size:section-default' when a dimension was filled.
 * - image: missing width/height -> 'image:no-size' (nothing changed).
 * - arrow/pen: untouched.
 */
export function ensureElementGeometry(el: WbElement, opts: { force?: boolean } = {}): string[] {
  const reasons: string[] = [];
  if (!el || typeof el !== 'object') return reasons;
  const force = opts.force === true;

  switch (el.type) {
    case 'text':
    case 'list': {
      const missing = positiveDim(el.width) === undefined || positiveDim(el.height) === undefined;
      if (force || el.measured !== true || missing) {
        const size = el.type === 'text'
          ? estimateTextSize(contentString(el.content), positiveDim(el.fontSize) ?? 22)
          : estimateListSize(itemStrings(el.items), positiveDim(el.fontSize) ?? 18);
        el.width = size.width;
        el.height = size.height;
        el.estimated = true;
        delete el.measured;
        reasons.push('size:estimated');
      }
      break;
    }
    case 'shape': {
      let filled = false;
      if (positiveDim(el.width) === undefined) { el.width = SHAPE_DEFAULT.width; filled = true; }
      if (positiveDim(el.height) === undefined) { el.height = SHAPE_DEFAULT.height; filled = true; }
      if (filled) reasons.push('size:shape-default');
      break;
    }
    case 'section': {
      if (!sectionDefault(el.sectionType)) {
        el.sectionType = 'content';
        reasons.push('section:type-default');
      }
      const def = SECTION_DEFAULTS[el.sectionType as string];
      let filled = false;
      if (positiveDim(el.width) === undefined) { el.width = def.w; filled = true; }
      if (positiveDim(el.height) === undefined) { el.height = def.h; filled = true; }
      if (!el.color) el.color = def.color;
      if (!el.label) el.label = def.label;
      if (filled) reasons.push('size:section-default');
      break;
    }
    case 'image': {
      if (positiveDim(el.width) === undefined || positiveDim(el.height) === undefined) reasons.push('image:no-size');
      break;
    }
    default:
      break;
  }
  return reasons;
}

// ── Arrows and anchors ──

/**
 * Exact port of the client `getAnchorPoint`: the point where a ray from the
 * target's centre towards `(fromX, fromY)` leaves the target's box. Uses the
 * client's `width || 100` / `height || 60` fallbacks (so 0 falls back too).
 * Returns null for a missing target, an arrow target, or (unlike the client,
 * which would yield NaN) non-finite coordinates.
 */
export function anchorPoint(target: WbElement | undefined | null, fromX: number, fromY: number): { x: number; y: number } | null {
  if (!target || target.type === 'arrow') return null;
  if (!isFiniteNumber(target.x) || !isFiniteNumber(target.y) || !isFiniteNumber(fromX) || !isFiniteNumber(fromY)) return null;
  const w = target.width || ANCHOR_FALLBACK.width;
  const h = target.height || ANCHOR_FALLBACK.height;
  const cx = target.x + w / 2;
  const cy = target.y + h / 2;
  const hw = w / 2;
  const hh = h / 2;

  const dx = fromX - cx;
  const dy = fromY - cy;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return { x: cx, y: cy - hh };

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const scale = absDx / hw > absDy / hh ? hw / absDx : hh / absDy;
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * Copy of `arrow.points` with anchored endpoints snapped to their targets,
 * in the same order as the client `renderArrows`: the start endpoint is
 * resolved first from `pts[1]`, then the end endpoint from `pts[len - 2]`.
 * With 3+ points both neighbours are raw; with exactly 2 points the end is
 * resolved from the already-resolved start, exactly as the client draws it.
 * Unresolvable anchors (missing target, arrow target) keep the raw point.
 * The input array is never mutated.
 */
export function resolveArrowPoints(arrow: WbElement, byId?: WbElementLookup): WbPoint[] {
  const raw = Array.isArray(arrow?.points) ? arrow.points : [];
  const pts: WbPoint[] = raw.map(p => [p[0], p[1]]);
  if (pts.length < 2) return pts;

  const lookup = toLookup(byId);
  if (arrow.startAnchor) {
    const pt = anchorPoint(lookup(arrow.startAnchor), pts[1][0], pts[1][1]);
    if (pt) pts[0] = [pt.x, pt.y];
  }
  if (arrow.endAnchor) {
    const from = pts[pts.length - 2];
    const pt = anchorPoint(lookup(arrow.endAnchor), from[0], from[1]);
    if (pt) pts[pts.length - 1] = [pt.x, pt.y];
  }
  return pts;
}

// ── Boxes ──

/** Bounding box of a point list (non-finite points ignored); null when there is nothing to bound. */
export function pointsBounds(points: WbPoint[] | undefined | null): WbRect | null {
  if (!Array.isArray(points)) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Array.isArray(p) || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) continue;
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Axis-aligned box of an element. Rotation is ignored.
 * - text/list: stored size, estimated when missing.
 * - shape: stored size or `SHAPE_DEFAULT`.
 * - section: stored size or the `SECTION_DEFAULTS` entry for its type ('content' when unknown).
 * - image: stored size or 0x0.
 * - arrow: bounds of `resolveArrowPoints` (anchors resolved through `byId` when given).
 * - pen: bounds of its points.
 * Returns null when x/y are not finite (boxed types), when there are no points
 * (arrow/pen), or for an unknown type.
 */
export function elementBox(el: WbElement, byId?: WbElementLookup): WbRect | null {
  if (!el || typeof el !== 'object') return null;
  switch (el.type) {
    case 'arrow':
      return pointsBounds(resolveArrowPoints(el, byId));
    case 'pen':
      return pointsBounds(el.points);
    case 'text':
    case 'list':
    case 'shape':
    case 'image':
    case 'section': {
      if (!isFiniteNumber(el.x) || !isFiniteNumber(el.y)) return null;
      const size = storedOrDefaultSize(el);
      return { x: el.x, y: el.y, width: size.width, height: size.height };
    }
    default:
      return null;
  }
}

/** Centre of `elementBox`, or null when the element has no box. */
export function elementCenter(el: WbElement, byId?: WbElementLookup): { x: number; y: number } | null {
  const box = elementBox(el, byId);
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

// ── Clamping and conversion ──

/**
 * Keep a box inside `rect` (same math as the server's add-element clamp):
 * pull back from the right/bottom edges first, then off the left/top edges.
 * A box larger than the rect ends up aligned to the rect's left/top.
 */
export function clampBoxToRect(box: WbRect, rect: WbRect): { x: number; y: number; reasons: string[] } {
  let x = box.x;
  let y = box.y;
  if (x + box.width > rect.x + rect.width) x = Math.max(rect.x, rect.x + rect.width - box.width);
  if (y + box.height > rect.y + rect.height) y = Math.max(rect.y, rect.y + rect.height - box.height);
  if (x < rect.x) x = rect.x;
  if (y < rect.y) y = rect.y;
  const reasons: string[] = [];
  if (x !== box.x) reasons.push('clamp:x');
  if (y !== box.y) reasons.push('clamp:y');
  return { x, y, reasons };
}

/**
 * Translate a point list so the bbox of the points NOT in `skipIdx` (typically
 * anchored endpoints, which get re-snapped anyway) fits inside `rect`. When
 * every index is skipped the bbox covers all points. A bbox wider/taller than
 * the rect is aligned to the rect's left/top. The shift is applied to ALL
 * points; a new array is returned and `dx`/`dy` are 0 when nothing moved.
 */
export function clampPointsToRect(points: WbPoint[], rect: WbRect, skipIdx: number[] = []): { points: WbPoint[]; dx: number; dy: number } {
  const all = Array.isArray(points) ? points : [];
  const skip = new Set(skipIdx);
  let considered = all.filter((_, i) => !skip.has(i));
  if (!considered.length) considered = all;
  const bbox = pointsBounds(considered);
  if (!bbox) return { points: all.map(p => [p[0], p[1]]), dx: 0, dy: 0 };
  const dx = fitShift(bbox.x, bbox.width, rect.x, rect.width);
  const dy = fitShift(bbox.y, bbox.height, rect.y, rect.height);
  return { points: all.map(p => [p[0] + dx, p[1] + dy]), dx, dy };
}

/**
 * Convert percentage coordinates (0-100 of `frame`) to pixels, in place.
 * x/y become `round(frame.x|y + v% of frame.width|height)`, width/height
 * become `round(v% of frame.width|height)`, and (unless `pointsToo` is false)
 * each point is converted like x/y. Fields that are not finite numbers are skipped.
 */
export function convertPctInPlace(
  target: { x?: number; y?: number; width?: number; height?: number; points?: WbPoint[] },
  frame: WbRect,
  opts: { pointsToo?: boolean } = { pointsToo: true },
): void {
  if (isFiniteNumber(target.x)) target.x = Math.round(frame.x + (target.x * frame.width) / 100);
  if (isFiniteNumber(target.y)) target.y = Math.round(frame.y + (target.y * frame.height) / 100);
  if (isFiniteNumber(target.width)) target.width = Math.round((target.width * frame.width) / 100);
  if (isFiniteNumber(target.height)) target.height = Math.round((target.height * frame.height) / 100);
  if (opts.pointsToo !== false && Array.isArray(target.points)) {
    for (const p of target.points) {
      if (!Array.isArray(p) || !isFiniteNumber(p[0]) || !isFiniteNumber(p[1])) continue;
      p[0] = Math.round(frame.x + (p[0] * frame.width) / 100);
      p[1] = Math.round(frame.y + (p[1] * frame.height) / 100);
    }
  }
}

// ── Rect predicates ──

/** Intersection of two rects, or null when they do not overlap with positive area (touching edges do not count). */
export function rectsIntersect(a: WbRect, b: WbRect): { width: number; height: number; area: number } | null {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return null;
  return { width, height, area: width * height };
}

/** True when the point lies inside `r` (edges inclusive). */
export function rectContainsPoint(r: WbRect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/** True when `inner` lies fully inside `outer` (edges inclusive). */
export function rectContainsRect(outer: WbRect, inner: WbRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

// ── Analysis ──

interface Boxed { el: WbElement; box: WbRect; area: number }

/** True when `holder` is a section whose box contains the centre of `item`. */
function isContainerOf(holder: Boxed, item: Boxed): boolean {
  return holder.el.type === 'section'
    && rectContainsPoint(holder.box, item.box.x + item.box.width / 2, item.box.y + item.box.height / 2);
}

/** Text/list elements whose reported box is an estimate rather than a browser measurement. */
function hasEstimatedSize(el: WbElement): boolean {
  if (el.estimated === true) return true;
  if (el.type !== 'text' && el.type !== 'list') return false;
  return el.measured !== true && (positiveDim(el.width) === undefined || positiveDim(el.height) === undefined);
}

function sectionLabel(el: WbElement): string {
  if (typeof el.label === 'string' && el.label) return el.label;
  return (sectionDefault(el.sectionType) ?? SECTION_DEFAULTS.content).label;
}

/**
 * Layout report for a whiteboard: bounds, viewport overflow, overlapping
 * elements, section containment/spills, unparented elements and notes.
 *
 * - Boxes come from `elementBox` with a lookup over ALL elements (anchors resolve).
 * - `focusIds` restricts overflow/overlap/containment/unparented entries to
 *   those involving at least one focus id; bounds, counts of estimates and
 *   notes stay global.
 * - Overflow: 'outside' when the box does not intersect the usable rect,
 *   otherwise 'partial' with rounded per-side amounts. Sorted by total amount,
 *   capped at `maxOverflow` (default 30); `overflowTotal` is the uncapped count.
 * - Overlaps: pairs among text/list/shape/image/section with a positive-area
 *   intersection, skipping pairs where one is a section containing the other's
 *   centre (that is containment, nested sections included). Sorted by area,
 *   capped at `maxOverlaps` (default 30).
 * - Containment: each non-section solid element belongs to the smallest section
 *   whose box contains its centre; a section belongs to the smallest LARGER
 *   section containing its centre. Only sections with children are listed;
 *   `spills` are children whose box is not fully inside the section.
 * - Notes: estimated-size count, children drawn below their section (zIndex),
 *   and arrow anchors that reference unknown ids.
 */
export function analyzeWhiteboard(elements: WbElement[], viewport: WbViewport, opts: WbAnalyzeOptions = {}): WbAnalysis {
  const usable = usableRect(viewport);
  const maxOverlaps = limitOr(opts.maxOverlaps, 30);
  const maxOverflow = limitOr(opts.maxOverflow, 30);
  const focus = Array.isArray(opts.focusIds) && opts.focusIds.length > 0 ? new Set(opts.focusIds) : null;
  const involves = (...ids: string[]): boolean => !focus || ids.some(id => focus.has(id));

  const list = (Array.isArray(elements) ? elements : [])
    .filter((el): el is WbElement => !!el && typeof el === 'object' && typeof el.id === 'string');
  const byId = new Map<string, WbElement>();
  for (const el of list) byId.set(el.id, el);

  const boxed: Boxed[] = [];
  for (const el of list) {
    const box = elementBox(el, byId);
    if (box) boxed.push({ el, box, area: box.width * box.height });
  }

  // Bounds: union of every box, as pixels and as a share of the usable area.
  let bounds: WbAnalysis['bounds'] = null;
  if (boxed.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const { box } of boxed) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    const width = maxX - minX;
    const height = maxY - minY;
    bounds = {
      x: minX, y: minY, width, height,
      pctWidth: usable.width > 0 ? Math.round((100 * width) / usable.width) : 0,
      pctHeight: usable.height > 0 ? Math.round((100 * height) / usable.height) : 0,
    };
  }

  // Overflow against the usable rect.
  const overflowAll: WbAnalysis['overflow'] = [];
  for (const { el, box } of boxed) {
    const by = sideAmounts(box, usable);
    if (!hasSides(by) || !involves(el.id)) continue;
    overflowAll.push({ id: el.id, type: el.type, severity: rectsIntersect(box, usable) ? 'partial' : 'outside', by });
  }
  overflowAll.sort((a, b) => sumSides(b.by) - sumSides(a.by));

  // Overlaps between solid elements (containment is not overlap).
  const solids = boxed.filter(b => SOLID_TYPES.has(b.el.type));
  const overlapsAll: (WbAnalysis['overlaps'][number] & { exactArea: number })[] = [];
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i];
      const b = solids[j];
      const inter = rectsIntersect(a.box, b.box);
      if (!inter) continue;
      if (isContainerOf(a, b) || isContainerOf(b, a)) continue;
      if (!involves(a.el.id, b.el.id)) continue;
      const smaller = Math.min(a.area, b.area);
      overlapsAll.push({
        a: a.el.id, b: b.el.id, aType: a.el.type, bType: b.el.type,
        intersection: { width: Math.round(inter.width), height: Math.round(inter.height), area: Math.round(inter.area) },
        pctOfSmaller: smaller > 0 ? Math.round((100 * inter.area) / smaller) : 0,
        exactArea: inter.area,
      });
    }
  }
  overlapsAll.sort((p, q) => q.exactArea - p.exactArea);
  const overlaps = overlapsAll.slice(0, maxOverlaps).map(({ exactArea: _exact, ...entry }) => entry);

  // Containment: parent = smallest section whose box contains the element centre.
  const sections = solids.filter(b => b.el.type === 'section');
  const childrenOf = new Map<string, Boxed[]>();
  const unparentedAll: string[] = [];
  for (const item of solids) {
    let parent: Boxed | null = null;
    for (const s of sections) {
      if (s === item) continue;
      if (item.el.type === 'section' && s.area <= item.area) continue;
      if (!isContainerOf(s, item)) continue;
      if (!parent || s.area < parent.area) parent = s;
    }
    if (parent) {
      const kids = childrenOf.get(parent.el.id) ?? [];
      kids.push(item);
      childrenOf.set(parent.el.id, kids);
    } else if (item.el.type !== 'section') {
      unparentedAll.push(item.el.id);
    }
  }

  const containmentAll: WbAnalysis['containment'] = [];
  const zNotes: string[] = [];
  for (const s of sections) {
    const kids = childrenOf.get(s.el.id);
    if (!kids?.length) continue;
    const spills: { id: string; by: WbSideAmounts }[] = [];
    for (const kid of kids) {
      const by = sideAmounts(kid.box, s.box);
      if (hasSides(by)) spills.push({ id: kid.el.id, by });
      if (isFiniteNumber(kid.el.zIndex) && isFiniteNumber(s.el.zIndex) && kid.el.zIndex < s.el.zIndex) {
        zNotes.push(`z-order: ${kid.el.id} (z=${kid.el.zIndex}) is below its section ${s.el.id} (z=${s.el.zIndex})`);
      }
    }
    containmentAll.push({ section: s.el.id, label: sectionLabel(s.el), children: kids.map(k => k.el.id), spills });
  }

  // Notes.
  let estimatedCount = 0;
  for (const el of list) if (hasEstimatedSize(el)) estimatedCount++;
  const notes: string[] = [];
  if (estimatedCount > 0) notes.push(`${estimatedCount} element(s) have estimated sizes (browser has not measured them yet)`);
  notes.push(...zNotes);
  for (const el of list) {
    if (el.type !== 'arrow') continue;
    for (const side of ['startAnchor', 'endAnchor'] as const) {
      const ref = el[side];
      if (typeof ref === 'string' && ref && !byId.has(ref)) notes.push(`anchor: arrow ${el.id} ${side} "${ref}" not found`);
    }
  }

  return {
    usable,
    bounds,
    overflow: overflowAll.slice(0, maxOverflow),
    overflowTotal: overflowAll.length,
    overlaps,
    overlapsTotal: overlapsAll.length,
    overlapsTruncated: overlapsAll.length > maxOverlaps,
    containment: containmentAll.filter(c => involves(c.section, ...c.children)),
    unparented: unparentedAll.filter(id => involves(id)),
    estimatedCount,
    notes,
  };
}

// ── Formatting ──

/**
 * Compact box label for tool output: `box=(x,y,w,h)`, with `~` before w and h
 * when the size is an estimate, or `box=(?)` when there is no box.
 */
export function formatBox(box: WbRect | null | undefined, estimated = false): string {
  if (!box) return 'box=(?)';
  const t = estimated ? '~' : '';
  return `box=(${Math.round(box.x)},${Math.round(box.y)},${t}${Math.round(box.width)},${t}${Math.round(box.height)})`;
}
