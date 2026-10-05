import { describe, expect, it } from 'vitest';

import {
  ANCHOR_FALLBACK,
  DEFAULT_VIEWPORT,
  ELEMENT_TYPES,
  SECTION_DEFAULTS,
  SECTION_TYPE_NAMES,
  SHAPE_DEFAULT,
  SHAPE_TYPES,
  analyzeWhiteboard,
  anchorPoint,
  clampBoxToRect,
  clampPointsToRect,
  convertPctInPlace,
  elementBox,
  elementCenter,
  ensureElementGeometry,
  estimateListSize,
  estimateTextSize,
  formatBox,
  pointsBounds,
  rectContainsPoint,
  rectContainsRect,
  rectsIntersect,
  resolveArrowPoints,
  usableRect,
  type WbElement,
  type WbPoint,
} from '../src/services/whiteboard-geometry.js';

const VP = { width: 1920, height: 937, xOffset: 0, yOffset: 0 };
const USABLE = { x: 0, y: 0, width: 1920, height: 937 };

function el(fields: Partial<WbElement> & { id: string; type: string }): WbElement {
  return { ...fields };
}

function byId(...elements: WbElement[]): Map<string, WbElement> {
  return new Map(elements.map(e => [e.id, e]));
}

describe('whiteboard-geometry constants', () => {
  it('exposes the client defaults', () => {
    expect(DEFAULT_VIEWPORT).toEqual({ width: 1920, height: 937, xOffset: 0, yOffset: 0 });
    expect(SHAPE_DEFAULT).toEqual({ width: 160, height: 100 });
    expect(ANCHOR_FALLBACK).toEqual({ width: 100, height: 60 });
    expect(SHAPE_TYPES).toEqual(['rect', 'pill', 'circle', 'triangle', 'drawn-circle']);
    expect(ELEMENT_TYPES).toEqual(['text', 'list', 'shape', 'arrow', 'pen', 'image', 'section']);
  });

  it('mirrors the 12 client SECTION_TYPES entries', () => {
    expect(SECTION_TYPE_NAMES).toHaveLength(12);
    expect(Object.keys(SECTION_DEFAULTS)).toEqual([...SECTION_TYPE_NAMES]);
    expect(SECTION_DEFAULTS.navbar).toEqual({ w: 960, h: 56, color: '#64748b', label: 'Navbar', icon: '≡' });
    expect(SECTION_DEFAULTS.hero).toEqual({ w: 960, h: 340, color: '#6366f1', label: 'Hero', icon: '☆' });
    expect(SECTION_DEFAULTS['image-placeholder']).toEqual({ w: 280, h: 180, color: '#a855f7', label: 'Image', icon: '⊞' });
    expect(SECTION_DEFAULTS['text-block']).toEqual({ w: 380, h: 90, color: '#e2e8f0', label: 'Text Block', icon: 'T' });
    expect(SECTION_DEFAULTS.grid).toEqual({ w: 640, h: 320, color: '#06b6d4', label: 'Grid', icon: '⊞⊞' });
    expect(SECTION_DEFAULTS.modal).toEqual({ w: 440, h: 300, color: '#f43f5e', label: 'Modal', icon: '◻' });
  });

  it('usableRect applies the toolbar/navbar offsets', () => {
    expect(usableRect(DEFAULT_VIEWPORT)).toEqual(USABLE);
    expect(usableRect({ width: 1800, height: 900, xOffset: 60, yOffset: 48 })).toEqual({ x: 60, y: 48, width: 1800, height: 900 });
    expect(usableRect(undefined)).toEqual(USABLE);
  });
});

describe('size estimation', () => {
  it('estimates text from the longest line and the line count', () => {
    expect(estimateTextSize('Hello', 22)).toEqual({ width: 96, height: 52 });
    // round(2 * 22 * 1.35 + 22) = round(81.4) = 81
    expect(estimateTextSize('Hello\nWorld', 22)).toEqual({ width: 96, height: 81 });
    expect(estimateTextSize('Hi\nA much longer line', 22)).toEqual({ width: Math.round(18 * 22 * 0.6 + 30), height: 81 });
    expect(estimateTextSize('Hello')).toEqual(estimateTextSize('Hello', 22));
  });

  it('sizes empty content like the 12-character placeholder', () => {
    expect(estimateTextSize('', 22)).toEqual({ width: 188, height: 52 });
    expect(estimateTextSize(undefined, 22)).toEqual({ width: 188, height: 52 });
  });

  it('counts code points, not UTF-16 units, and applies the floors', () => {
    expect(estimateTextSize('\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}', 22)).toEqual(estimateTextSize('Hello', 22));
    expect(estimateTextSize('a', 4)).toEqual({ width: 60, height: 30 });
  });

  it('estimates lists from the longest item and the row count', () => {
    expect(estimateListSize(['First', 'Second', 'Third'], 18)).toEqual({ width: 120, height: 103 });
    expect(estimateListSize([], 18)).toEqual({ width: 120, height: 49 });
    expect(estimateListSize(undefined)).toEqual({ width: 120, height: 49 });
    expect(estimateListSize(['A much longer list item here'], 18)).toEqual({ width: 358, height: 49 });
  });
});

describe('ensureElementGeometry', () => {
  it('estimates unmeasured text and marks it as estimated', () => {
    const text = el({ id: 't', type: 'text', content: 'Hello' });
    expect(ensureElementGeometry(text)).toEqual(['size:estimated']);
    expect(text).toMatchObject({ width: 96, height: 52, estimated: true });
    expect('measured' in text).toBe(false);
  });

  it('leaves browser-measured text alone unless forced', () => {
    const text = el({ id: 't', type: 'text', content: 'Hello', width: 300, height: 80, measured: true });
    expect(ensureElementGeometry(text)).toEqual([]);
    expect(text).toMatchObject({ width: 300, height: 80, measured: true });
    expect(ensureElementGeometry(text, { force: true })).toEqual(['size:estimated']);
    expect(text).toMatchObject({ width: 96, height: 52, estimated: true });
    expect(text.measured).toBeUndefined();
  });

  it('estimates lists with the list font size', () => {
    const list = el({ id: 'l', type: 'list', items: ['First', 'Second', 'Third'] });
    expect(ensureElementGeometry(list)).toEqual(['size:estimated']);
    expect(list).toMatchObject({ width: 120, height: 103, estimated: true });
  });

  it('fills shape defaults for missing or non-positive dimensions', () => {
    const shape = el({ id: 's', type: 'shape', shape: 'rect', width: 0 });
    expect(ensureElementGeometry(shape)).toEqual(['size:shape-default']);
    expect(shape).toMatchObject({ width: 160, height: 100 });
    expect(ensureElementGeometry(el({ id: 's2', type: 'shape', width: 50, height: 40 }))).toEqual([]);
  });

  it('defaults sections to content and fills size/color/label from the table', () => {
    const section = el({ id: 'sec', type: 'section' });
    expect(ensureElementGeometry(section)).toEqual(['section:type-default', 'size:section-default']);
    expect(section).toMatchObject({ sectionType: 'content', width: 640, height: 360, color: '#737373', label: 'Content' });

    const hero = el({ id: 'hero', type: 'section', sectionType: 'hero', width: 800, color: '#fff' });
    expect(ensureElementGeometry(hero)).toEqual(['size:section-default']);
    expect(hero).toMatchObject({ sectionType: 'hero', width: 800, height: 340, color: '#fff', label: 'Hero' });

    const bogus = el({ id: 'b', type: 'section', sectionType: 'constructor', width: 10, height: 10, color: '#000', label: 'X' });
    expect(ensureElementGeometry(bogus)).toEqual(['section:type-default']);
    expect(bogus.sectionType).toBe('content');
  });

  it('reports images without a size and ignores arrows/pen', () => {
    const image = el({ id: 'i', type: 'image', url: 'x.png' });
    expect(ensureElementGeometry(image)).toEqual(['image:no-size']);
    expect(image.width).toBeUndefined();
    expect(ensureElementGeometry(el({ id: 'i2', type: 'image', width: 10, height: 10 }))).toEqual([]);
    expect(ensureElementGeometry(el({ id: 'a', type: 'arrow', points: [[0, 0], [1, 1]] }))).toEqual([]);
    expect(ensureElementGeometry(el({ id: 'p', type: 'pen', points: [[0, 0], [1, 1]] }))).toEqual([]);
  });
});

describe('anchorPoint (client getAnchorPoint parity)', () => {
  const target = el({ id: 'box', type: 'shape', x: 100, y: 100, width: 200, height: 100 });

  it('returns the edge intersection towards the from point', () => {
    expect(anchorPoint(target, 500, 150)).toEqual({ x: 300, y: 150 }); // right edge
    expect(anchorPoint(target, 200, 500)).toEqual({ x: 200, y: 200 }); // bottom middle
    expect(anchorPoint(target, -100, 150)).toEqual({ x: 100, y: 150 }); // left edge
  });

  it('returns the top-middle when the from point is the centre', () => {
    expect(anchorPoint(target, 200, 150)).toEqual({ x: 200, y: 100 });
  });

  it('falls back to 100x60 when width/height are 0 or missing', () => {
    const text = el({ id: 't', type: 'text', x: 0, y: 0, width: 0, height: 0 });
    expect(anchorPoint(text, 500, 30)).toEqual({ x: 100, y: 30 });
    expect(anchorPoint(el({ id: 't2', type: 'text', x: 0, y: 0 }), 50, 500)).toEqual({ x: 50, y: 60 });
  });

  it('returns null for missing targets, arrows and non-finite coordinates', () => {
    expect(anchorPoint(undefined, 0, 0)).toBeNull();
    expect(anchorPoint(null, 0, 0)).toBeNull();
    expect(anchorPoint(el({ id: 'a', type: 'arrow', points: [[0, 0], [1, 1]] }), 0, 0)).toBeNull();
    expect(anchorPoint(el({ id: 'nx', type: 'shape', y: 0, width: 10, height: 10 }), 0, 0)).toBeNull();
    expect(anchorPoint(target, Number.NaN, 0)).toBeNull();
  });
});

describe('resolveArrowPoints', () => {
  const a = el({ id: 'A', type: 'shape', x: 0, y: 0, width: 100, height: 100 });     // centre (50, 50)
  const b = el({ id: 'B', type: 'shape', x: 400, y: 0, width: 100, height: 100 });   // centre (450, 50)

  it('resolves both endpoints of a 3-point arrow from the raw middle point', () => {
    const arrow = el({ id: 'arr', type: 'arrow', points: [[50, 50], [250, 200], [450, 50]], startAnchor: 'A', endAnchor: 'B' });
    const pts = resolveArrowPoints(arrow, byId(a, b));
    expect(pts).toEqual([[100, 87.5], [250, 200], [400, 87.5]]);
    expect(arrow.points).toEqual([[50, 50], [250, 200], [450, 50]]); // input untouched
    expect(pts[1]).not.toBe(arrow.points![1]);                          // deep copy
  });

  it('resolves a 2-point arrow progressively: the end is computed from the resolved start', () => {
    const lower = el({ id: 'B2', type: 'shape', x: 400, y: 100, width: 100, height: 100 }); // centre (450, 150)
    const arrow = el({ id: 'arr', type: 'arrow', points: [[20, 80], [450, 150]], startAnchor: 'A', endAnchor: 'B2' });
    const pts = resolveArrowPoints(arrow, byId(a, lower));
    // start: from A's centre towards raw pts[1] (450,150) -> right edge of A at (100, 62.5)
    expect(pts[0][0]).toBeCloseTo(100, 6);
    expect(pts[0][1]).toBeCloseTo(62.5, 6);
    // end: from B2's centre towards the RESOLVED pts[0] (100, 62.5) -> (400, 137.5)
    // (from the raw start (20, 80) it would be y ~= 141.86 instead)
    expect(pts[1][0]).toBeCloseTo(400, 6);
    expect(pts[1][1]).toBeCloseTo(137.5, 6);
  });

  it('accepts a lookup function and keeps raw points for unresolvable anchors', () => {
    const arrow = el({ id: 'arr', type: 'arrow', points: [[50, 50], [250, 200], [450, 50]], startAnchor: 'A', endAnchor: 'ghost' });
    const lookup = (id: string) => (id === 'A' ? a : undefined);
    expect(resolveArrowPoints(arrow, lookup)).toEqual([[100, 87.5], [250, 200], [450, 50]]);
    expect(resolveArrowPoints(arrow)).toEqual(arrow.points);
  });

  it('copies short or missing point lists without resolving', () => {
    expect(resolveArrowPoints(el({ id: 'x', type: 'arrow', points: [[1, 2]], startAnchor: 'A' }), byId(a))).toEqual([[1, 2]]);
    expect(resolveArrowPoints(el({ id: 'y', type: 'arrow' }), byId(a))).toEqual([]);
  });
});

describe('boxes', () => {
  it('pointsBounds covers finite points only', () => {
    expect(pointsBounds([[10, 20], [30, 5], [15, 40]])).toEqual({ x: 10, y: 5, width: 20, height: 35 });
    expect(pointsBounds([[10, 20], [Number.NaN, 0] as WbPoint])).toEqual({ x: 10, y: 20, width: 0, height: 0 });
    expect(pointsBounds([])).toBeNull();
    expect(pointsBounds(undefined)).toBeNull();
  });

  it('elementBox uses stored sizes with per-type defaults', () => {
    expect(elementBox(el({ id: 't', type: 'text', x: 10, y: 20, content: 'Hello' }))).toEqual({ x: 10, y: 20, width: 96, height: 52 });
    expect(elementBox(el({ id: 't2', type: 'text', x: 10, y: 20, width: 300, height: 80, rotation: 45 }))).toEqual({ x: 10, y: 20, width: 300, height: 80 });
    expect(elementBox(el({ id: 'l', type: 'list', x: 0, y: 0, items: ['First', 'Second', 'Third'] }))).toEqual({ x: 0, y: 0, width: 120, height: 103 });
    expect(elementBox(el({ id: 's', type: 'shape', x: 5, y: 5 }))).toEqual({ x: 5, y: 5, width: 160, height: 100 });
    expect(elementBox(el({ id: 'h', type: 'section', x: 0, y: 0, sectionType: 'hero' }))).toEqual({ x: 0, y: 0, width: 960, height: 340 });
    expect(elementBox(el({ id: 'u', type: 'section', x: 0, y: 0, sectionType: 'nope' }))).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(elementBox(el({ id: 'i', type: 'image', x: 1, y: 2 }))).toEqual({ x: 1, y: 2, width: 0, height: 0 });
    expect(elementBox(el({ id: 'nx', type: 'text', y: 2 }))).toBeNull();
    expect(elementBox(el({ id: '?', type: 'sticker', x: 0, y: 0, width: 1, height: 1 }))).toBeNull();
  });

  it('elementBox bounds arrows through resolved anchors and pen through raw points', () => {
    const a = el({ id: 'A', type: 'shape', x: 0, y: 0, width: 100, height: 100 });
    const b = el({ id: 'B', type: 'shape', x: 400, y: 0, width: 100, height: 100 });
    const arrow = el({ id: 'arr', type: 'arrow', points: [[50, 50], [250, 200], [450, 50]], startAnchor: 'A', endAnchor: 'B' });
    expect(elementBox(arrow, byId(a, b, arrow))).toEqual({ x: 100, y: 87.5, width: 300, height: 112.5 });
    expect(elementBox(arrow)).toEqual({ x: 50, y: 50, width: 400, height: 150 });
    expect(elementBox(el({ id: 'p', type: 'pen', points: [[5, 5], [25, 45]] }))).toEqual({ x: 5, y: 5, width: 20, height: 40 });
    expect(elementBox(el({ id: 'p2', type: 'pen' }))).toBeNull();
  });

  it('elementCenter is the centre of the box', () => {
    expect(elementCenter(el({ id: 's', type: 'shape', x: 0, y: 0 }))).toEqual({ x: 80, y: 50 });
    expect(elementCenter(el({ id: 'nx', type: 'shape' }))).toBeNull();
  });
});

describe('clamping and conversion', () => {
  it('clampBoxToRect pulls boxes back inside with reasons', () => {
    expect(clampBoxToRect({ x: 1900, y: 0, width: 100, height: 50 }, USABLE)).toEqual({ x: 1820, y: 0, reasons: ['clamp:x'] });
    expect(clampBoxToRect({ x: 0, y: 900, width: 100, height: 50 }, USABLE)).toEqual({ x: 0, y: 887, reasons: ['clamp:y'] });
    expect(clampBoxToRect({ x: -10, y: -5, width: 100, height: 50 }, USABLE)).toEqual({ x: 0, y: 0, reasons: ['clamp:x', 'clamp:y'] });
    expect(clampBoxToRect({ x: 100, y: 100, width: 3000, height: 50 }, USABLE)).toEqual({ x: 0, y: 100, reasons: ['clamp:x'] });
    expect(clampBoxToRect({ x: 100, y: 100, width: 100, height: 50 }, USABLE)).toEqual({ x: 100, y: 100, reasons: [] });
    const offset = { x: 60, y: 48, width: 1800, height: 900 };
    expect(clampBoxToRect({ x: 0, y: 0, width: 100, height: 50 }, offset)).toEqual({ x: 60, y: 48, reasons: ['clamp:x', 'clamp:y'] });
  });

  it('clampPointsToRect translates every point using the bbox of the non-skipped ones', () => {
    const rect = { x: 0, y: 0, width: 300, height: 300 };
    const points: WbPoint[] = [[10, 10], [250, 50], [350, 80]];
    expect(clampPointsToRect(points, rect, [0])).toEqual({ points: [[-40, 10], [200, 50], [300, 80]], dx: -50, dy: 0 });
    expect(points).toEqual([[10, 10], [250, 50], [350, 80]]); // input untouched
    expect(clampPointsToRect([[-20, -10], [50, 50]], rect)).toEqual({ points: [[0, 0], [70, 60]], dx: 20, dy: 10 });
    // all indexes skipped -> bbox over all points
    expect(clampPointsToRect([[-20, -10], [50, 50]], rect, [0, 1])).toEqual({ points: [[0, 0], [70, 60]], dx: 20, dy: 10 });
    // wider than the rect -> align the left edge
    expect(clampPointsToRect([[100, 10], [500, 10]], rect)).toEqual({ points: [[0, 10], [400, 10]], dx: -100, dy: 0 });
    const fits = clampPointsToRect([[10, 10], [20, 20]], rect);
    expect(fits).toEqual({ points: [[10, 10], [20, 20]], dx: 0, dy: 0 });
  });

  it('convertPctInPlace converts x/y/width/height and points against the frame', () => {
    const frame = { x: 0, y: 100, width: 1920, height: 937 };
    const target = { x: 50, y: 50, width: 25, height: 10, points: [[0, 0], [100, 100]] as WbPoint[] };
    convertPctInPlace(target, frame);
    expect(target).toEqual({ x: 960, y: 569, width: 480, height: 94, points: [[0, 100], [1920, 1037]] });

    const noPoints = { x: 10, points: [[50, 50]] as WbPoint[] };
    convertPctInPlace(noPoints, frame, { pointsToo: false });
    expect(noPoints).toEqual({ x: 192, points: [[50, 50]] });
  });

  it('rect predicates', () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 })).toEqual({ width: 50, height: 50, area: 2500 });
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 })).toBeNull();
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 500, y: 0, width: 10, height: 10 })).toBeNull();
    expect(rectContainsPoint(USABLE, 0, 0)).toBe(true);
    expect(rectContainsPoint(USABLE, 1920, 937)).toBe(true);
    expect(rectContainsPoint(USABLE, 1921, 10)).toBe(false);
    expect(rectContainsRect(USABLE, { x: 10, y: 10, width: 100, height: 100 })).toBe(true);
    expect(rectContainsRect(USABLE, { x: 1900, y: 10, width: 100, height: 100 })).toBe(false);
  });
});

describe('analyzeWhiteboard', () => {
  it('reports an overlap between a text and a list with pctOfSmaller', () => {
    const text = el({ id: 't', type: 'text', x: 100, y: 100, width: 200, height: 100, measured: true });
    const list = el({ id: 'l', type: 'list', x: 200, y: 150, width: 200, height: 100, measured: true });
    const r = analyzeWhiteboard([text, list], VP);
    expect(r.usable).toEqual(USABLE);
    expect(r.overlaps).toEqual([{
      a: 't', b: 'l', aType: 'text', bType: 'list',
      intersection: { width: 100, height: 50, area: 5000 }, pctOfSmaller: 25,
    }]);
    expect(r.overlapsTotal).toBe(1);
    expect(r.overlapsTruncated).toBe(false);
    expect(r.overflow).toEqual([]);
    expect(r.containment).toEqual([]);
    expect(r.unparented).toEqual(['t', 'l']);
    expect(r.bounds).toEqual({ x: 100, y: 100, width: 300, height: 150, pctWidth: 16, pctHeight: 16 });
    expect(r.estimatedCount).toBe(0);
    expect(r.notes).toEqual([]);
  });

  it('treats a text inside a section as containment, not overlap', () => {
    const section = el({ id: 's', type: 'section', sectionType: 'content', x: 0, y: 0, width: 640, height: 360, zIndex: 1 });
    const text = el({ id: 't', type: 'text', x: 20, y: 20, width: 100, height: 50, measured: true, zIndex: 2 });
    const r = analyzeWhiteboard([section, text], VP);
    expect(r.overlaps).toEqual([]);
    expect(r.containment).toEqual([{ section: 's', label: 'Content', children: ['t'], spills: [] }]);
    expect(r.unparented).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it('reports children that spill out of their section', () => {
    const section = el({ id: 's', type: 'section', sectionType: 'card', label: 'Pricing', x: 0, y: 0, width: 640, height: 360 });
    const text = el({ id: 't', type: 'text', x: 600, y: 20, width: 60, height: 50, measured: true });
    const r = analyzeWhiteboard([section, text], VP);
    expect(r.containment).toEqual([{ section: 's', label: 'Pricing', children: ['t'], spills: [{ id: 't', by: { right: 20 } }] }]);
    expect(r.overlaps).toEqual([]);
  });

  it('nests sections inside larger sections and never lists sections as unparented', () => {
    const big = el({ id: 'big', type: 'section', sectionType: 'hero', x: 0, y: 0, width: 960, height: 340 });
    const small = el({ id: 'small', type: 'section', sectionType: 'card', x: 20, y: 20, width: 260, height: 180 });
    const lonely = el({ id: 'lonely', type: 'section', sectionType: 'footer', x: 0, y: 800, width: 960, height: 100 });
    const r = analyzeWhiteboard([big, small, lonely], VP);
    expect(r.overlaps).toEqual([]);
    expect(r.containment).toEqual([{ section: 'big', label: 'Hero', children: ['small'], spills: [] }]);
    expect(r.unparented).toEqual([]);
  });

  it('assigns each element to the smallest containing section', () => {
    const big = el({ id: 'big', type: 'section', sectionType: 'hero', x: 0, y: 0, width: 960, height: 340 });
    const small = el({ id: 'small', type: 'section', sectionType: 'card', x: 20, y: 20, width: 260, height: 180 });
    const text = el({ id: 't', type: 'text', x: 40, y: 40, width: 100, height: 50, measured: true });
    const r = analyzeWhiteboard([big, small, text], VP);
    expect(r.containment).toEqual([
      { section: 'big', label: 'Hero', children: ['small'], spills: [] },
      { section: 'small', label: 'Card', children: ['t'], spills: [] },
    ]);
  });

  it('flags partial and outside overflow with per-side amounts', () => {
    const half = el({ id: 'half', type: 'text', x: 1870, y: 100, width: 100, height: 50, measured: true });
    const gone = el({ id: 'gone', type: 'text', x: 2000, y: 100, width: 100, height: 50, measured: true });
    const corner = el({ id: 'corner', type: 'text', x: -30, y: -20, width: 100, height: 50, measured: true });
    const r = analyzeWhiteboard([half, gone, corner], VP);
    expect(r.overflowTotal).toBe(3);
    expect(r.overflow.find(o => o.id === 'half')).toEqual({ id: 'half', type: 'text', severity: 'partial', by: { right: 50 } });
    expect(r.overflow.find(o => o.id === 'gone')).toEqual({ id: 'gone', type: 'text', severity: 'outside', by: { right: 180 } });
    expect(r.overflow.find(o => o.id === 'corner')).toEqual({ id: 'corner', type: 'text', severity: 'partial', by: { left: 30, top: 20 } });
    expect(r.overflow[0].id).toBe('gone'); // largest overflow first
  });

  it('measures overflow against the offset usable rect', () => {
    const text = el({ id: 't', type: 'text', x: 100, y: 10, width: 100, height: 50, measured: true });
    const r = analyzeWhiteboard([text], { width: 1800, height: 900, xOffset: 60, yOffset: 48 });
    expect(r.usable).toEqual({ x: 60, y: 48, width: 1800, height: 900 });
    expect(r.overflow).toEqual([{ id: 't', type: 'text', severity: 'partial', by: { top: 38 } }]);
  });

  it('restricts overflow/overlaps/unparented to focusIds while keeping bounds global', () => {
    const t1 = el({ id: 't1', type: 'text', x: 0, y: 0, width: 100, height: 100, measured: true });
    const t2 = el({ id: 't2', type: 'text', x: 50, y: 0, width: 100, height: 100, measured: true });
    const t3 = el({ id: 't3', type: 'text', x: 300, y: 0, width: 100, height: 100, measured: true });
    const t4 = el({ id: 't4', type: 'text', x: 350, y: 0, width: 100, height: 100, measured: true });
    const far = el({ id: 'far', type: 'text', x: 3000, y: 0, width: 100, height: 100, measured: true });
    const all = analyzeWhiteboard([t1, t2, t3, t4, far], VP);
    expect(all.overlaps.map(o => [o.a, o.b])).toEqual([['t1', 't2'], ['t3', 't4']]);
    expect(all.overflow.map(o => o.id)).toEqual(['far']);

    const focused = analyzeWhiteboard([t1, t2, t3, t4, far], VP, { focusIds: ['t1'] });
    expect(focused.overlaps.map(o => [o.a, o.b])).toEqual([['t1', 't2']]);
    expect(focused.overlapsTotal).toBe(1);
    expect(focused.overflow).toEqual([]);
    expect(focused.unparented).toEqual(['t1']);
    expect(focused.bounds).toEqual(all.bounds);
    expect(focused.bounds?.width).toBe(3100);
  });

  it('caps overlaps at maxOverlaps sorted by area and flags truncation', () => {
    const a = el({ id: 'a', type: 'shape', x: 0, y: 0, width: 100, height: 100 });
    const b = el({ id: 'b', type: 'shape', x: 10, y: 10, width: 100, height: 100 });
    const c = el({ id: 'c', type: 'shape', x: 80, y: 80, width: 100, height: 100 });
    const r = analyzeWhiteboard([a, b, c], VP, { maxOverlaps: 1 });
    expect(r.overlaps).toHaveLength(1);
    expect(r.overlaps[0]).toMatchObject({ a: 'a', b: 'b', intersection: { width: 90, height: 90, area: 8100 }, pctOfSmaller: 81 });
    expect(r.overlapsTotal).toBe(3);
    expect(r.overlapsTruncated).toBe(true);
  });

  it('excludes arrows and pen strokes from overlaps and containment but not from bounds', () => {
    const shape = el({ id: 's', type: 'shape', x: 0, y: 0, width: 100, height: 100 });
    const arrow = el({ id: 'arr', type: 'arrow', points: [[10, 10], [900, 900]] });
    const pen = el({ id: 'pen', type: 'pen', points: [[20, 20], [60, 60]] });
    const r = analyzeWhiteboard([shape, arrow, pen], VP);
    expect(r.overlaps).toEqual([]);
    expect(r.unparented).toEqual(['s']);
    expect(r.bounds).toMatchObject({ x: 0, y: 0, width: 900, height: 900 });
  });

  it('counts estimated sizes and explains them in the notes', () => {
    const flagged = el({ id: 'e1', type: 'text', x: 0, y: 0, width: 96, height: 52, estimated: true });
    const unsized = el({ id: 'e2', type: 'list', x: 0, y: 300, items: ['a'] });
    const measured = el({ id: 'm', type: 'text', x: 0, y: 600, width: 96, height: 52, measured: true });
    const r = analyzeWhiteboard([flagged, unsized, measured], VP);
    expect(r.estimatedCount).toBe(2);
    expect(r.notes).toEqual(['2 element(s) have estimated sizes (browser has not measured them yet)']);
  });

  it('notes children drawn below their section and dangling arrow anchors', () => {
    const section = el({ id: 's', type: 'section', sectionType: 'content', x: 0, y: 0, width: 640, height: 360, zIndex: 5 });
    const text = el({ id: 't', type: 'text', x: 20, y: 20, width: 100, height: 50, measured: true, zIndex: 2 });
    const arrow = el({ id: 'arr', type: 'arrow', points: [[0, 0], [10, 10]], startAnchor: 'ghost', endAnchor: 't' });
    const arrow2 = el({ id: 'arr2', type: 'arrow', points: [[0, 0], [10, 10]], endAnchor: 'nope' });
    const r = analyzeWhiteboard([section, text, arrow, arrow2], VP);
    expect(r.notes).toEqual([
      'z-order: t (z=2) is below its section s (z=5)',
      'anchor: arrow arr startAnchor "ghost" not found',
      'anchor: arrow arr2 endAnchor "nope" not found',
    ]);
  });

  it('returns an empty analysis for an empty whiteboard', () => {
    const r = analyzeWhiteboard([], VP);
    expect(r.bounds).toBeNull();
    expect(r.overflow).toEqual([]);
    expect(r.overlaps).toEqual([]);
    expect(r.containment).toEqual([]);
    expect(r.unparented).toEqual([]);
    expect(r.notes).toEqual([]);
  });
});

describe('formatBox', () => {
  it('formats rounded boxes with tildes for estimates', () => {
    expect(formatBox({ x: 320, y: 100, width: 412.4, height: 51.6 }, true)).toBe('box=(320,100,~412,~52)');
    expect(formatBox({ x: 320, y: 100, width: 412, height: 52 })).toBe('box=(320,100,412,52)');
    expect(formatBox(null)).toBe('box=(?)');
    expect(formatBox(undefined, true)).toBe('box=(?)');
  });
});
