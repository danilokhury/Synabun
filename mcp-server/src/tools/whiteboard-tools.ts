import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text, image } from './response.js';
import { SHAPE_TYPES, SECTION_TYPE_NAMES, ELEMENT_TYPES, DEFAULT_VIEWPORT, type WbElement, type WbViewport } from '../services/whiteboard-geometry.js';
import {
  formatReadText,
  formatReadJson,
  formatAddResult,
  formatOpResults,
  formatScreenshotMeta,
  scopedWarnings,
  type WbReadData,
  type WbAddedSummary,
  type WbOpResult,
} from './whiteboard-format.js';

// ═══════════════════════════════════════════
// Shared schema pieces
// ═══════════════════════════════════════════

const shapeEnum = z.enum(SHAPE_TYPES);
const sectionTypeEnum = z.enum(SECTION_TYPE_NAMES);
const pointSchema = z.array(z.number()).length(2);
const coordModeSchema = z.enum(['px', 'pct']).optional().describe(
  '"px" (default): absolute canvas pixels — NOT offset; the usable area starts at the origin whiteboard_read reports and values are clamped into it. '
  + '"pct": 0-100 of the usable area (or of the parent section when parent is set); offsets applied; also converts arrow/pen points.',
);

const COLOR_HELP = 'CSS color. Default rgba(255,255,255,0.85). Palette: #ef4444 red, #f97316 orange, #eab308 yellow, #22c55e green, #3b82f6 blue, #a855f7 purple, #ec4899 pink, #06b6d4 cyan';

/** After a mutation, re-read the board (no image payloads) for scoped warnings. */
async function warningsFor(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  try {
    const data = await ni.getWhiteboard({ images: false });
    if (data.error || !Array.isArray(data.elements)) return [];
    const vp = (data.viewport as WbViewport | undefined) || DEFAULT_VIEWPORT;
    return scopedWarnings(data.elements as WbElement[], vp, ids);
  } catch {
    return [];
  }
}

function warningsBlock(label: string, warnings: string[]): string {
  if (!warnings.length) return '';
  return `\n${label}:\n${warnings.map(w => `  - ${w}`).join('\n')}`;
}

// ═══════════════════════════════════════════
// whiteboard_read
// ═══════════════════════════════════════════

export const whiteboardReadSchema = {
  format: z.enum(['text', 'json']).optional().describe('"text" (default): annotated element list + layout analysis. "json": {viewport, connection, elements, analysis} as JSON.'),
  verbose: z.boolean().optional().describe('Text mode only: print full text content (default truncates at 300 chars) and every list item (default 20).'),
};

export const whiteboardReadDescription =
  'Read the whiteboard. Returns viewport truth (usable canvas size, origin offset, whether a browser is connected and in Focus mode), '
  + 'every element with its final box x,y,w,h (text/list sizes are browser-measured; ~ marks server estimates not yet measured), z-order, rotation, '
  + 'resolved arrow endpoints and anchors, then a layout analysis: content bounds, elements overflowing the usable area, overlapping pairs, '
  + 'section containment (with spill-outs), z-order and dangling-anchor notes. Call it before placing or moving elements and after edits to verify. '
  + "format:'json' returns the same as structured JSON; verbose:true prints full text.";

export async function handleWhiteboardRead(args: { format?: string; verbose?: boolean } = {}) {
  const result = await ni.getWhiteboard({ images: false });
  if (result.error) {
    return text(`Failed to read whiteboard: ${result.error}`);
  }
  const data = result as unknown as WbReadData;
  if (args.format === 'json') return text(formatReadJson(data));
  return text(formatReadText(data, { verbose: !!args.verbose }));
}

// ═══════════════════════════════════════════
// whiteboard_add
// ═══════════════════════════════════════════

const addElementSchema = z.object({
  type: z.enum(ELEMENT_TYPES).describe('Element type'),
  id: z.string().optional().describe('Optional ID. Must be unique; a taken ID is regenerated and reported (requestedId).'),
  parent: z.string().optional().describe('Section ID. x/y (px or pct) become relative to that section box and the element is clamped inside it. Not stored — a moved section does not move its children.'),
  x: z.number().optional().describe('X in canvas px (or % of the frame with coordMode pct). Required unless layout is set.'),
  y: z.number().optional().describe('Y in canvas px (or %).'),
  width: z.number().optional().describe('Width (shape/image/section). Ignored for text/list — they auto-size.'),
  height: z.number().optional().describe('Height (shape/image/section). Ignored for text/list.'),
  content: z.string().optional().describe('Text content (text). \\n = line break. Text does not wrap: long single lines get wide.'),
  items: z.array(z.string()).optional().describe('List items (list). One string per bullet.'),
  ordered: z.boolean().optional().describe('Numbered list instead of bullets (list). Default false.'),
  fontSize: z.number().optional().describe('Font size px. Defaults: text 22, list 18.'),
  color: z.string().optional().describe(COLOR_HELP),
  bold: z.boolean().optional().describe('Bold (text).'),
  italic: z.boolean().optional().describe('Italic (text).'),
  shape: shapeEnum.optional().describe('Shape subtype (shape). Default rect.'),
  points: z.array(pointSchema).min(2).optional().describe('[[x,y],...] waypoints for arrow/pen (2+). Converted with pct too.'),
  startAnchor: z.string().optional().describe('Element ID the arrow start snaps to (edge intersection). Unknown IDs are dropped with a warning.'),
  endAnchor: z.string().optional().describe('Element ID the arrow end snaps to.'),
  strokeWidth: z.number().optional().describe('Pen stroke width (default 3).'),
  rotation: z.number().optional().describe('Rotation in degrees.'),
  url: z.string().optional().describe('Image path served by the Neural Interface (e.g. "/games/TicTacToe/Cross.svg"); must resolve inside public/ or games/. Server embeds it as a dataUrl.'),
  sectionType: sectionTypeEnum.optional().describe('Section semantics (section); sets default size/color/label. Default content.'),
  label: z.string().optional().describe('Section label (section). Defaults to the section type name.'),
});

export const whiteboardAddSchema = {
  coordMode: coordModeSchema,
  layout: z.enum(['row', 'column', 'grid', 'center']).optional().describe('Auto-layout using real element sizes; overrides x/y. Runs inside the parent section when parent is set.'),
  elements: z.array(addElementSchema).min(1).max(100).describe('Elements to add (1-100).'),
};

export const whiteboardAddDescription =
  'Add elements. Coordinates: px (default) are absolute canvas pixels and are NOT offset — start at the origin reported by whiteboard_read (values are clamped into the usable area). '
  + 'pct = 0-100 of the usable area (offsets applied; also converts arrow/pen points). parent:<sectionId> makes x/y relative to that section and clamps inside it. '
  + 'layout row/column/grid/center overrides x/y using real sizes. Sizes: text/list auto-size (do not pass width/height); shapes default 160x100 (rect, pill, circle, triangle, drawn-circle); '
  + 'sections default per sectionType; images need width/height. Arrows: 2+ points plus optional startAnchor/endAnchor (unknown IDs dropped with a warning; anchored ends snap to the target edge). '
  + 'Returns the FINAL geometry per element after defaults/pct/layout/clamping with the adjustments made, then overflow/overlap warnings for the new elements. '
  + 'Guidance: keep content within ~70-80% of the usable width, centered, fit vertically, ~20px margins.';

export async function handleWhiteboardAdd(args: { elements: Record<string, unknown>[]; coordMode?: string; layout?: string }) {
  const result = await ni.addWhiteboardElements(args.elements, args.coordMode, args.layout);
  if (result.error) {
    const errors = Array.isArray(result.errors) ? (result.errors as { index: number; type?: string; error: string }[]) : [];
    const detail = errors.length ? '\n' + errors.map(e => `  #${e.index + 1} ${e.type || '?'} — ${e.error}`).join('\n') : '';
    return text(`Failed to add elements: ${result.error}${detail}`);
  }

  const added = (result.added || []) as WbAddedSummary[];
  let out = formatAddResult(result as Parameters<typeof formatAddResult>[0], args.elements.length);
  const warnings = await warningsFor(added.map(a => a.id));
  out += warningsBlock('Warnings for the new elements', warnings);
  return text(out);
}

// ═══════════════════════════════════════════
// whiteboard_update
// ═══════════════════════════════════════════

const updateFieldsSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional().describe('Ignored for text/list (auto-sized).'),
  height: z.number().optional().describe('Ignored for text/list (auto-sized).'),
  content: z.string().optional().describe('New text content (text). \\n = line break.'),
  items: z.array(z.string()).optional().describe('New list items (list).'),
  ordered: z.boolean().optional(),
  fontSize: z.number().optional(),
  color: z.string().optional().describe(COLOR_HELP),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  shape: shapeEnum.optional(),
  points: z.array(pointSchema).min(2).optional().describe('New waypoints (arrow/pen).'),
  startAnchor: z.string().nullable().optional().describe('New start anchor ID (null to detach).'),
  endAnchor: z.string().nullable().optional().describe('New end anchor ID (null to detach).'),
  rotation: z.number().optional(),
  strokeWidth: z.number().optional(),
  sectionType: sectionTypeEnum.optional(),
  label: z.string().optional(),
}).describe('Only listed fields change. width/height are ignored for text/list (auto-sized).');

export const whiteboardUpdateSchema = {
  coordMode: coordModeSchema,
  id: z.string().optional().describe('Single form: element ID (use together with updates).'),
  updates: updateFieldsSchema.optional().describe('Single form: fields to change.'),
  parent: z.string().optional().describe('Single form: interpret x/y (px or pct) relative to this section and clamp inside it.'),
  items: z.array(z.object({
    id: z.string(),
    updates: updateFieldsSchema,
    parent: z.string().optional(),
  })).min(1).max(100).optional().describe('Batch form: many updates in one save / one render / one undo step. Per-item results; a missing ID fails only that item. (List bullet text goes in updates.items, not here.)'),
};

export const whiteboardUpdateDescription =
  'Update one element ({id, updates}) or many atomically ({items:[{id, updates}]}: one save, one render, one undo step in the browser). '
  + 'Only listed fields change; changing content/items/fontSize re-estimates a text/list size until the browser re-measures it. '
  + 'coordMode pct and parent:<sectionId> work as in whiteboard_add. Positions are clamped into the usable area; unknown anchor IDs are dropped with a warning. '
  + 'Per-item results include the final geometry; a missing ID fails only that item.';

interface UpdateItem { id: string; updates: Record<string, unknown>; parent?: string }

export async function handleWhiteboardUpdate(args: { id?: string; updates?: Record<string, unknown>; parent?: string; items?: unknown; coordMode?: string }) {
  const hasSingle = typeof args.id === 'string' && args.id.length > 0;
  const hasBatch = Array.isArray(args.items) && args.items.length > 0;
  if (hasBatch && (args.items as unknown[]).every(i => typeof i === 'string')) {
    return text('items must be an array of {id, updates} objects. To set a list\'s bullet text use the single form: {id, updates: {items: [...]}}.');
  }
  if (hasSingle === hasBatch) {
    return text('Provide exactly one form: {id, updates} for one element, or {items: [{id, updates}, ...]} for a batch.');
  }

  const items: UpdateItem[] = hasSingle
    ? [{ id: args.id as string, updates: args.updates || {}, parent: args.parent }]
    : (args.items as UpdateItem[]);
  if (hasSingle && !Object.keys(items[0].updates).length) {
    return text('updates is empty — nothing to change.');
  }

  const ops = items.map(it => ({ op: 'update', id: it.id, updates: it.updates, ...(it.parent ? { parent: it.parent } : {}) }));
  const result = await ni.batchWhiteboardOps(ops, args.coordMode);
  if (result.error) {
    return text(`Failed to update: ${result.error}`);
  }

  const results = (result.results || []) as WbOpResult[];
  const okCount = results.filter(r => r.ok).length;
  const lines = [`Updated ${okCount} of ${items.length} element${items.length === 1 ? '' : 's'}:`, ...formatOpResults(results)];
  const warnings = await warningsFor(results.filter(r => r.ok).map(r => r.id));
  return text(lines.join('\n') + warningsBlock('Warnings for the updated elements', warnings));
}

// ═══════════════════════════════════════════
// whiteboard_remove
// ═══════════════════════════════════════════

export const whiteboardRemoveSchema = {
  id: z.string().optional().describe('Element ID to remove.'),
  ids: z.array(z.string()).min(1).max(200).optional().describe('Several element IDs removed atomically (one save, one undo step).'),
};

export const whiteboardRemoveDescription =
  'Remove one element ({id}) or several atomically ({ids}). Arrows anchored to a removed element are detached and their endpoint moved to its centre (reported as cascade updates). '
  + 'Omit both to clear the whole board (undoable in the browser with Ctrl+Z).';

export async function handleWhiteboardRemove(args: { id?: string; ids?: string[] } = {}) {
  const ids = Array.isArray(args.ids) && args.ids.length ? args.ids : (args.id ? [args.id] : []);
  if (!ids.length) {
    const result = await ni.clearWhiteboard();
    if (result.error) {
      return text(`Failed to clear whiteboard: ${result.error}`);
    }
    return text('Whiteboard cleared (undoable in the browser with Ctrl+Z).');
  }

  const result = await ni.batchWhiteboardOps(ids.map(id => ({ op: 'remove', id })));
  if (result.error) {
    return text(`Failed to remove: ${result.error}`);
  }
  const results = (result.results || []) as WbOpResult[];
  const okCount = results.filter(r => r.ok).length;
  const lines = [`Removed ${okCount} of ${ids.length} element${ids.length === 1 ? '' : 's'}:`, ...formatOpResults(results)];
  return text(lines.join('\n'));
}

// ═══════════════════════════════════════════
// whiteboard_screenshot
// ═══════════════════════════════════════════

export const whiteboardScreenshotSchema = {
  crop: z.enum(['full', 'usable']).optional().describe('"full" (default): the whole canvas, so image px ÷ scale = canvas px. "usable": cropped to the usable viewport (origin offset reported in the text block).'),
};

export const whiteboardScreenshotDescription =
  'Capture the live whiteboard from the primary connected browser window as a JPEG, preceded by a text block with the coordinate mapping '
  + '(canvas size, image scale: image px ÷ scale = canvas px, usable viewport origin, element count). Fails with a clear message when no browser is connected. '
  + 'Use whiteboard_read for exact numbers; use this to judge visual overlap, legibility and how the board actually looks.';

export async function handleWhiteboardScreenshot(args: { crop?: string } = {}) {
  const result = await ni.whiteboardScreenshot({ crop: args.crop });
  if (result.error) {
    return text(`Screenshot failed: ${result.error}`);
  }

  return {
    content: [
      ...text(formatScreenshotMeta(result)).content,
      ...image(result.data as string, 'image/jpeg').content,
    ],
  };
}
