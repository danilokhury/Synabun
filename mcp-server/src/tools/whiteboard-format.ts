/**
 * Text formatting for the whiteboard MCP tools (whiteboard_read / _add /
 * _update / _remove / _screenshot). Pure string building on top of the shared
 * geometry module — no I/O.
 */

import {
  DEFAULT_VIEWPORT,
  analyzeWhiteboard,
  elementBox,
  resolveArrowPoints,
  formatBox,
  type WbAnalysis,
  type WbElement,
  type WbPoint,
  type WbRect,
  type WbSideAmounts,
  type WbViewport,
} from '../services/whiteboard-geometry.js';

/** Browser connection summary as returned by GET /api/whiteboard. */
export interface WbConnection {
  clients: number;
  focusActive: boolean;
  primaryClientId: string | null;
  source: 'browser' | 'default';
}

/** Payload of GET /api/whiteboard (images may be stripped to dataUrlBytes). */
export interface WbReadData {
  elements?: WbElement[];
  viewport?: WbViewport;
  connection?: WbConnection;
  nextZIndex?: number;
}

/** One entry of POST /api/whiteboard/elements → `added`. */
export interface WbAddedSummary {
  id: string;
  type: string;
  zIndex?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  estimated?: boolean;
  points?: WbPoint[];
  requestedId?: string;
  adjusted?: string[];
  warnings?: string[];
}

/** One entry of POST /api/whiteboard/elements/batch → `results`. */
export interface WbOpResult {
  op: string;
  id: string;
  ok: boolean;
  error?: string;
  type?: string;
  element?: WbAddedSummary;
  adjusted?: string[];
  warnings?: string[];
  cascade?: { id: string; updates: Record<string, unknown> }[];
}

const TEXT_PREVIEW_CHARS = 300;
const LIST_PREVIEW_ITEMS = 20;
const ARROW_INLINE_POINTS = 6;

function r(n: number | undefined | null): number {
  return Math.round(typeof n === 'number' && Number.isFinite(n) ? n : 0);
}

function pt(p: WbPoint): string {
  return `(${r(p[0])},${r(p[1])})`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Map of id → element for anchor resolution. */
export function byIdMap(elements: WbElement[]): Map<string, WbElement> {
  return new Map(elements.map(e => [e.id, e]));
}

/** `SECTION:hero`, `SHAPE:pill`, `TEXT`, … */
export function typeLabel(el: WbElement | undefined | null): string {
  if (!el) return '?';
  if (el.type === 'section') return `SECTION:${el.sectionType || 'content'}`;
  if (el.type === 'shape') return `SHAPE:${el.shape || 'rect'}`;
  return String(el.type || '?').toUpperCase();
}

function sides(by: WbSideAmounts): string {
  return (Object.entries(by) as [string, number | undefined][])
    .filter(([, v]) => typeof v === 'number' && v > 0)
    .map(([k, v]) => `${k} ${r(v)}px`)
    .join(', ');
}

function isEstimated(el: WbElement): boolean {
  if (el.estimated) return true;
  return (el.type === 'text' || el.type === 'list') && !el.measured;
}

/** `usable viewport WxH px, origin (x,y) → x a..b, y c..d` */
export function viewportRange(vp: WbViewport): string {
  const ox = vp.xOffset || 0;
  const oy = vp.yOffset || 0;
  return `usable viewport ${r(vp.width)}x${r(vp.height)} px, origin (${ox},${oy}) → x ${ox}..${ox + r(vp.width)}, y ${oy}..${oy + r(vp.height)}`;
}

/** Browser connection state in one clause. */
export function connectionLine(conn: WbConnection | undefined, vp: WbViewport): string {
  if (!conn || conn.source !== 'browser') {
    return `browser: none connected — viewport is the built-in default ${r(vp.width)}x${r(vp.height)} (origin ${vp.xOffset || 0},${vp.yOffset || 0}); positions cannot be verified; screenshot unavailable`;
  }
  const focus = conn.focusActive ? 'focus mode on' : 'focus mode off (the user is not looking at the board)';
  return `browser: ${plural(conn.clients, 'client')}, ${focus}, primary ${conn.primaryClientId ?? '?'} | screenshot available`;
}

function indentLines(lines: string[]): string[] {
  return lines.map(l => `    ${l}`);
}

function contentLines(content: string, verbose: boolean | undefined): string[] {
  if (!content) return ['    (empty)'];
  if (verbose || content.length <= TEXT_PREVIEW_CHARS) return indentLines(content.split('\n'));
  const cut = content.slice(0, TEXT_PREVIEW_CHARS);
  const lines = cut.split('\n');
  lines[lines.length - 1] += `… (+${content.length - TEXT_PREVIEW_CHARS} chars)`;
  return indentLines(lines);
}

/** One element → one headline (+ indented content lines for text/list). */
export function formatElement(el: WbElement, byId: Map<string, WbElement>, opts: { verbose?: boolean } = {}): string {
  const box = elementBox(el, byId);
  const est = isEstimated(el);
  const z = ` z=${el.zIndex ?? 0}`;
  const rot = el.rotation ? ` rot=${el.rotation}` : '';
  const color = el.color ? ` color:${el.color}` : '';
  const lines: string[] = [];

  switch (el.type) {
    case 'text': {
      const style = [`${el.fontSize || 22}px`, el.bold && 'bold', el.italic && 'italic'].filter(Boolean).join(' ');
      lines.push(`[${el.id}] TEXT ${formatBox(box, est)}${z}${rot} ${style}${color}`);
      lines.push(...contentLines(el.content || '', opts.verbose));
      break;
    }
    case 'list': {
      const items = Array.isArray(el.items) ? el.items : [];
      lines.push(`[${el.id}] LIST ${formatBox(box, est)}${z}${rot} ${el.fontSize || 18}px ${el.ordered ? 'numbered' : 'bulleted'} ${plural(items.length, 'item')}${color}`);
      const shown = opts.verbose ? items : items.slice(0, LIST_PREVIEW_ITEMS);
      shown.forEach((item, i) => lines.push(`    ${el.ordered ? `${i + 1}.` : '•'} ${item}`));
      if (shown.length < items.length) lines.push(`    … +${items.length - shown.length} more`);
      if (!items.length) lines.push('    (empty)');
      break;
    }
    case 'shape':
      lines.push(`[${el.id}] ${typeLabel(el)} ${formatBox(box, false)}${z}${rot}${color}`);
      break;
    case 'arrow': {
      const raw = Array.isArray(el.points) ? el.points : [];
      const pts = resolveArrowPoints(el, byId);
      let path: string;
      if (pts.length < 2) path = '(no points)';
      else if (pts.length <= ARROW_INLINE_POINTS || opts.verbose) path = pts.map(pt).join('→');
      else path = `${pt(pts[0])}→…→${pt(pts[pts.length - 1])} (${pts.length} points)`;
      const anchors: string[] = [];
      if (el.startAnchor) anchors.push(`start:${el.startAnchor}`);
      if (el.endAnchor) anchors.push(`end:${el.endAnchor}`);
      let line = `[${el.id}] ARROW${z} ${path}`;
      if (anchors.length) {
        line += ` anchored ${anchors.join(' ')}`;
        if (raw.length >= 2) line += ` (raw ${pt(raw[0])}→${pt(raw[raw.length - 1])})`;
      }
      if (box) line += ` bbox=(${r(box.x)},${r(box.y)},${r(box.width)},${r(box.height)})`;
      lines.push(line + color);
      break;
    }
    case 'pen':
      lines.push(`[${el.id}] PEN ${formatBox(box, false)}${z} ${plural((el.points || []).length, 'point')} stroke:${el.strokeWidth || 3}${color}`);
      break;
    case 'image': {
      const bytes = typeof el.dataUrlBytes === 'number' ? el.dataUrlBytes : (typeof el.dataUrl === 'string' ? el.dataUrl.length : 0);
      const size = bytes ? ` ${Math.max(1, Math.round(bytes / 1024))} KB` : ' (no image data)';
      lines.push(`[${el.id}] IMAGE ${formatBox(box, false)}${z}${rot}${size}`);
      break;
    }
    case 'section':
      lines.push(`[${el.id}] ${typeLabel(el)} ${formatBox(box, false)}${z}${rot} label="${el.label || el.sectionType || 'Content'}"${color}`);
      break;
    default:
      lines.push(`[${el.id}] ${typeLabel(el)} ${formatBox(box, est)}${z}${rot}`);
  }
  return lines.join('\n');
}

/** The "Layout analysis" block. */
export function formatAnalysis(a: WbAnalysis, byId: Map<string, WbElement>): string {
  const out: string[] = ['Layout analysis'];

  if (a.bounds) {
    out.push(`- Content bounds: x ${r(a.bounds.x)}..${r(a.bounds.x + a.bounds.width)}, y ${r(a.bounds.y)}..${r(a.bounds.y + a.bounds.height)} (${r(a.bounds.width)}x${r(a.bounds.height)}) = ${a.bounds.pctWidth}% of usable width, ${a.bounds.pctHeight}% of usable height`);
  } else {
    out.push('- Content bounds: none');
  }

  if (!a.overflow.length) {
    out.push('- Overflow: none');
  } else {
    out.push(`- Overflow (${a.overflowTotal}):`);
    for (const o of a.overflow) {
      out.push(`  ${o.id} ${typeLabel(byId.get(o.id))} ${o.severity === 'outside' ? 'entirely outside the usable area' : `partial: ${sides(o.by)}`}`);
    }
    if (a.overflowTotal > a.overflow.length) out.push(`  (showing ${a.overflow.length} of ${a.overflowTotal})`);
  }

  if (!a.overlaps.length) {
    out.push('- Overlaps: none');
  } else {
    out.push(`- Overlaps (${a.overlapsTotal}):`);
    for (const o of a.overlaps) {
      out.push(`  ${o.a} ${o.aType.toUpperCase()} × ${o.b} ${o.bType.toUpperCase()} ${r(o.intersection.width)}x${r(o.intersection.height)} px (${o.pctOfSmaller}% of the smaller)`);
    }
    if (a.overlapsTruncated) out.push(`  (showing ${a.overlaps.length} of ${a.overlapsTotal})`);
  }

  if (a.containment.length) {
    out.push('- Containment:');
    for (const c of a.containment) {
      const spills = new Map(c.spills.map(s => [s.id, s.by]));
      const kids = c.children
        .map(id => (spills.has(id) ? `${id} (spills ${sides(spills.get(id) || {})})` : id))
        .join(', ');
      out.push(`  ${c.section} ${typeLabel(byId.get(c.section))} "${c.label}" → ${kids}`);
    }
  }
  if (a.unparented.length) out.push(`- Not inside any section: ${a.unparented.join(', ')}`);

  if (a.notes.length) {
    out.push('- Notes:');
    for (const n of a.notes) out.push(`  ${n}`);
  } else {
    out.push('- Z-order and anchors: OK');
  }
  return out.join('\n');
}

/** Full text output of whiteboard_read. */
export function formatReadText(data: WbReadData, opts: { verbose?: boolean } = {}): string {
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const vp: WbViewport = data.viewport || DEFAULT_VIEWPORT;
  const byId = byIdMap(elements);
  const head = `Whiteboard: ${plural(elements.length, 'element')} | ${viewportRange(vp)} | ${connectionLine(data.connection, vp)}`;
  const legend = 'Coordinates are absolute canvas px (x right, y down from the canvas top-left; place inside the usable range). ~ = size estimated by the server (browser has not measured it yet).';

  if (!elements.length) {
    return `${head}\n${legend}\n\nNo elements.\nGuidance: keep content within ~70-80% of the usable width, centered; fit vertically with ~20px margins; text/list cards auto-size (do not pass width/height).`;
  }

  const body = elements.map(el => formatElement(el, byId, opts)).join('\n');
  const analysis = analyzeWhiteboard(elements, vp);
  return `${head}\n${legend}\n\n${body}\n\n${formatAnalysis(analysis, byId)}`;
}

/** JSON output of whiteboard_read. */
export function formatReadJson(data: WbReadData): string {
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const vp: WbViewport = data.viewport || DEFAULT_VIEWPORT;
  const byId = byIdMap(elements);
  const enriched = elements.map(el => {
    const box = elementBox(el, byId);
    const out: Record<string, unknown> = { ...el };
    if (typeof out.dataUrl === 'string') {
      out.dataUrlBytes = (out.dataUrl as string).length;
      delete out.dataUrl;
    }
    if (box) out.box = { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) };
    if (el.type === 'arrow') out.resolvedPoints = resolveArrowPoints(el, byId);
    out.sizeEstimated = isEstimated(el);
    return out;
  });
  return JSON.stringify({
    viewport: vp,
    connection: data.connection ?? { clients: 0, focusActive: false, primaryClientId: null, source: 'default' },
    elements: enriched,
    analysis: analyzeWhiteboard(elements, vp),
  }, null, 2);
}

/** Scoped warnings (overflow / overlap / spill) involving the given ids. */
export function scopedWarnings(elements: WbElement[], vp: WbViewport, focusIds: string[]): string[] {
  if (!focusIds.length) return [];
  const byId = byIdMap(elements);
  const a = analyzeWhiteboard(elements, vp, { focusIds });
  const lines: string[] = [];
  for (const o of a.overflow) {
    lines.push(`${o.id} ${typeLabel(byId.get(o.id))} ${o.severity === 'outside' ? 'is entirely outside the usable area' : `overflows the usable area: ${sides(o.by)}`}`);
  }
  for (const o of a.overlaps) {
    lines.push(`${o.a} ${o.aType.toUpperCase()} overlaps ${o.b} ${o.bType.toUpperCase()} by ${r(o.intersection.width)}x${r(o.intersection.height)} px (${o.pctOfSmaller}% of the smaller)`);
  }
  for (const c of a.containment) {
    for (const s of c.spills) lines.push(`${s.id} spills out of ${c.section} "${c.label}": ${sides(s.by)}`);
  }
  return lines;
}

function summaryBox(s: WbAddedSummary): string {
  const hasBox = typeof s.x === 'number' && typeof s.width === 'number';
  const box: WbRect | null = hasBox ? { x: s.x as number, y: s.y as number, width: s.width as number, height: s.height as number } : null;
  return formatBox(box, !!s.estimated);
}

function summaryLine(s: WbAddedSummary): string {
  let line = `${s.id} ${s.type.toUpperCase()} ${summaryBox(s)} z=${s.zIndex ?? '?'}`;
  if ((s.type === 'arrow' || s.type === 'pen') && Array.isArray(s.points) && s.points.length >= 2) {
    line += ` ${pt(s.points[0])}→${pt(s.points[s.points.length - 1])}`;
  }
  if (s.adjusted && s.adjusted.length) line += ` [${s.adjusted.join(', ')}]`;
  if (s.requestedId) line += ` (requested id "${s.requestedId}" was taken)`;
  return line;
}

/** Output of whiteboard_add (before the scoped warnings). */
export function formatAddResult(
  result: { added?: WbAddedSummary[]; errors?: { index: number; type?: string; error: string }[]; viewport?: WbViewport; connection?: WbConnection },
  requested: number,
): string {
  const added = result.added || [];
  const errors = result.errors || [];
  const out: string[] = [`Added ${added.length} of ${requested} element${requested === 1 ? '' : 's'}:`];
  for (const s of added) out.push(`  ${summaryLine(s)}`);
  for (const e of errors) out.push(`Skipped: #${e.index + 1} ${e.type || '?'} — ${e.error}`);
  if (result.viewport) {
    out.push(`Viewport ${r(result.viewport.width)}x${r(result.viewport.height)} origin (${result.viewport.xOffset || 0},${result.viewport.yOffset || 0}) (${result.connection?.source === 'browser' ? 'browser' : 'default — no browser connected'})`);
  }
  return out.join('\n');
}

function cascadeLines(cascade: { id: string; updates: Record<string, unknown> }[] | undefined): string[] {
  if (!cascade || !cascade.length) return [];
  return cascade.map(c => {
    const pts = Array.isArray(c.updates.points) ? (c.updates.points as WbPoint[]) : [];
    const which: string[] = [];
    if ('startAnchor' in c.updates) which.push(`start → ${pts.length ? pt(pts[0]) : '?'}`);
    if ('endAnchor' in c.updates) which.push(`end → ${pts.length ? pt(pts[pts.length - 1]) : '?'}`);
    return `    ↳ arrow ${c.id} detached (${which.join(', ')})`;
  });
}

/** Per-op lines for whiteboard_update / whiteboard_remove. */
export function formatOpResults(results: WbOpResult[]): string[] {
  const out: string[] = [];
  for (const res of results) {
    if (!res.ok) {
      out.push(`  ${res.id || '?'} FAILED: ${res.error || 'unknown error'}`);
      continue;
    }
    if (res.op === 'update' && res.element) {
      out.push(`  ${summaryLine({ ...res.element, adjusted: res.adjusted })}`);
      continue;
    }
    if (res.op === 'remove') {
      out.push(`  ${res.id} ${(res.type || 'element').toUpperCase()} removed`);
      out.push(...cascadeLines(res.cascade));
      continue;
    }
    out.push(`  ${res.id} ${res.op} ok`);
  }
  return out;
}

/** Coordinate-mapping text block returned with a screenshot. */
export function formatScreenshotMeta(res: Record<string, unknown>): string {
  const width = r(res.width as number);
  const height = r(res.height as number);
  const scale = typeof res.scale === 'number' && res.scale > 0 ? res.scale : 1;
  const xOffset = r(res.xOffset as number);
  const yOffset = r(res.yOffset as number);
  const vp = (res.viewport as WbViewport | undefined) || DEFAULT_VIEWPORT;
  const crop = res.crop === 'usable' ? 'usable' : 'full';
  const scaleTxt = Number.isInteger(scale) ? String(scale) : scale.toFixed(3);
  const mapping = crop === 'usable'
    ? `canvas px = image px ÷ ${scaleTxt} + (${xOffset},${yOffset}) — the image is cropped to the usable viewport`
    : `canvas px = image px ÷ ${scaleTxt} — the image covers the whole canvas`;
  const src = res.metadataSource === 'derived'
    ? ` (metadata derived from the viewport; reload the browser to get exact values)`
    : '';
  return `Screenshot ${width}x${height} canvas px at scale ${scaleTxt} (image is ${r(width * scale)}x${r(height * scale)} px); ${mapping}. Usable viewport ${r(vp.width)}x${r(vp.height)} at origin (${vp.xOffset || 0},${vp.yOffset || 0}). Elements: ${res.elements ?? '?'}. Source: client ${res.clientId || '?'}${src}.`;
}
