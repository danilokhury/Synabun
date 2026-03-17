import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text, image } from './response.js';

// ═══════════════════════════════════════════
// whiteboard_read
// ═══════════════════════════════════════════

export const whiteboardReadSchema = {};

export const whiteboardReadDescription =
  'Read the current whiteboard state. Returns element descriptions with IDs, positions, and properties, plus the usable viewport dimensions (width x height in pixels, excluding navbar and terminal). ALWAYS call this before placing elements — the viewport tells you the exact canvas boundaries. All elements must fit within these dimensions.';

interface WhiteboardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  content?: string;
  items?: string[];
  ordered?: boolean;
  shape?: string;
  color?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  points?: number[][];
  startAnchor?: string | null;
  endAnchor?: string | null;
  strokeWidth?: number;
  rotation?: number;
  zIndex?: number;
  dataUrl?: string;
  sectionType?: string;
  label?: string;
}

function describeElement(el: WhiteboardElement): string {
  const pos = `at (${Math.round(el.x)}, ${Math.round(el.y)})`;

  switch (el.type) {
    case 'text': {
      const style = [
        el.bold && 'bold',
        el.italic && 'italic',
        el.fontSize && `${el.fontSize}px`,
        el.color && `color:${el.color}`,
      ].filter(Boolean).join(', ');
      const content = el.content || '(empty)';
      const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
      return `[${el.id}] TEXT ${pos}: "${preview}"${style ? ` (${style})` : ''}`;
    }
    case 'shape': {
      const dims = `${Math.round(el.width || 160)}x${Math.round(el.height || 100)}`;
      return `[${el.id}] SHAPE:${el.shape || 'rect'} ${pos} ${dims}${el.color ? ` color:${el.color}` : ''}`;
    }
    case 'arrow': {
      const pts = (el.points || []).map(p => `(${Math.round(p[0])},${Math.round(p[1])})`).join(' → ');
      const anchors = [];
      if (el.startAnchor) anchors.push(`from:${el.startAnchor}`);
      if (el.endAnchor) anchors.push(`to:${el.endAnchor}`);
      return `[${el.id}] ARROW: ${pts}${anchors.length ? ` anchored ${anchors.join(', ')}` : ''}`;
    }
    case 'pen': {
      const ptCount = el.points?.length || 0;
      return `[${el.id}] PEN ${pos} (${ptCount} points, stroke:${el.strokeWidth || 3})${el.color ? ` color:${el.color}` : ''}`;
    }
    case 'list': {
      const items = el.items || [];
      const preview = items.slice(0, 5).map((it, i) => `  ${i + 1}. ${it}`).join('\n');
      const more = items.length > 5 ? `\n  ... +${items.length - 5} more` : '';
      return `[${el.id}] LIST ${pos} (${items.length} item${items.length !== 1 ? 's' : ''}):\n${preview}${more}`;
    }
    case 'image': {
      const dims = `${Math.round(el.width || 0)}x${Math.round(el.height || 0)}`;
      return `[${el.id}] IMAGE ${pos} ${dims}`;
    }
    case 'section': {
      const dims = `${Math.round(el.width || 0)}x${Math.round(el.height || 0)}`;
      const sType = el.sectionType || 'unknown';
      const label = el.label || sType;
      return `[${el.id}] SECTION:${sType} ${pos} ${dims} "${label}"`;
    }
    default:
      return `[${el.id}] ${el.type.toUpperCase()} ${pos}`;
  }
}

export async function handleWhiteboardRead() {
  const result = await ni.getWhiteboard();
  if (result.error) {
    return text(`Failed to read whiteboard: ${result.error}`);
  }

  const elements = (result.elements || []) as WhiteboardElement[];
  const viewport = result.viewport as { width: number; height: number; yOffset?: number; xOffset?: number } | null;

  if (elements.length === 0) {
    let emptyText = 'Whiteboard is empty. No elements present.';
    if (viewport) emptyText += `\nUsable viewport: ${viewport.width}x${viewport.height} (origin offset: x=${viewport.xOffset || 0}, y=${viewport.yOffset || 0})\n⚠️ Design compact layouts centered in the viewport. Do NOT fill the entire width — use ~70-80% of viewport width, centered. All sections must fit vertically within the viewport height. Scale section heights proportionally to fit.`;
    return text(emptyText);
  }

  let msg = `Whiteboard: ${elements.length} element(s)`;
  if (viewport) msg += ` | Usable viewport: ${viewport.width}x${viewport.height} (origin: x=${viewport.xOffset || 0}, y=${viewport.yOffset || 0})`;
  msg += '\n\n';
  msg += elements.map(describeElement).join('\n');

  // Spatial bounds summary
  const positioned = elements.filter(e => e.x != null && e.y != null);
  if (positioned.length > 0) {
    const xs = positioned.map(e => e.x);
    const ys = positioned.map(e => e.y);
    msg += `\n\nBounds: x=[${Math.round(Math.min(...xs))}, ${Math.round(Math.max(...xs))}], y=[${Math.round(Math.min(...ys))}, ${Math.round(Math.max(...ys))}]`;
  }

  return text(msg);
}


// ═══════════════════════════════════════════
// whiteboard_add
// ═══════════════════════════════════════════

export const whiteboardAddSchema = {
  coordMode: z.enum(['px', 'pct']).optional().describe('Coordinate mode. "px" (default) = absolute pixels. "pct" = percentage of viewport (0-100). x:50 y:50 = exact center.'),
  layout: z.enum(['row', 'column', 'grid', 'center']).optional().describe('Auto-layout (overrides x/y). "row" = horizontal centered. "column" = vertical centered. "grid" = auto columns. "center" = stacked center.'),
  elements: z.array(z.object({
    type: z.enum(['text', 'list', 'shape', 'arrow', 'pen', 'image', 'section']).describe('Element type'),
    x: z.number().optional().describe('X position (pixels from left). Required for text, list, shape.'),
    y: z.number().optional().describe('Y position (pixels from top). Required for text, list, shape.'),
    width: z.number().optional().describe('Width in pixels (shapes). Default: 160'),
    height: z.number().optional().describe('Height in pixels (shapes). Default: 100'),
    content: z.string().optional().describe('Text content (for text elements). Use \\n for line breaks.'),
    items: z.array(z.string()).optional().describe('List items array (for list elements). Each string is one bullet point.'),
    ordered: z.boolean().optional().describe('Use numbered list instead of bullets (list elements). Default: false'),
    fontSize: z.number().optional().describe('Font size in px (text: default 22, list: default 18)'),
    color: z.string().optional().describe('Color as CSS value. Default: rgba(255,255,255,0.85). Options: #ef4444 (red), #f97316 (orange), #eab308 (yellow), #22c55e (green), #3b82f6 (blue), #a855f7 (purple), #ec4899 (pink), #06b6d4 (cyan)'),
    bold: z.boolean().optional().describe('Bold text (text elements)'),
    italic: z.boolean().optional().describe('Italic text (text elements)'),
    shape: z.enum(['rect', 'pill', 'circle', 'drawn-circle']).optional().describe('Shape subtype (for shape elements). Default: rect'),
    points: z.array(z.array(z.number()).length(2)).optional().describe('Array of [x,y] waypoints (for arrow and pen elements). Arrows need 2+ points.'),
    startAnchor: z.string().optional().describe('Element ID to anchor arrow start to'),
    endAnchor: z.string().optional().describe('Element ID to anchor arrow end to'),
    strokeWidth: z.number().optional().describe('Stroke width for pen elements (default 3)'),
    rotation: z.number().optional().describe('Rotation in degrees'),
    url: z.string().optional().describe('URL path for image elements (e.g., "/games/TicTacToe/Cross.svg"). Server resolves to base64 dataUrl.'),
    sectionType: z.enum(['navbar', 'hero', 'sidebar', 'content', 'footer', 'card', 'form', 'image-placeholder', 'button', 'text-block', 'grid', 'modal']).optional().describe('Section type for wireframe elements (type=section). Determines default size, color, and semantic meaning.'),
    label: z.string().optional().describe('Display label for section elements. Defaults to section type name.'),
  })).describe('Array of elements to add to the whiteboard'),
};

export const whiteboardAddDescription =
  'Add elements to the whiteboard. ALWAYS call whiteboard_read first to get the usable viewport size.\n\n⚠️ LAYOUT RULES (MANDATORY):\n1. COMPACT DESIGN — Do NOT fill the entire viewport. Use ~70-80% of viewport width, centered horizontally. This creates a clean, contained wireframe.\n2. VERTICAL FIT — ALL elements MUST fit within the viewport height. Scale section heights proportionally if the total exceeds the available space. Leave ~20px padding from top and bottom edges.\n3. NO OVERFLOW — No element should extend beyond viewport edges. The viewport already excludes the navbar, toolbar, and terminal. Coordinates are auto-offset to the usable area.\n4. PROPORTIONAL SCALING — Section default sizes are for manual use. When building full-page wireframes via MCP, calculate heights as fractions of viewport height (e.g. navbar=6%, hero=30%, content=40%, footer=10%).\n\nCoordinate modes (coordMode): "px" (default) = absolute pixels. "pct" = percentage of usable viewport (0-100), e.g. x:10 y:5 = near top-left of usable area. Coordinates are automatically offset past the navbar and toolbar.\n\nAuto-layout (layout): overrides individual x/y. "row" = horizontal row centered vertically. "column" = vertical stack centered horizontally. "grid" = auto-grid (2-4 columns based on count). "center" = stacked in center. Layouts auto-fit within viewport.\n\nSupports: text (\\n for line breaks), list (items array), shape (rect/pill/circle/drawn-circle), arrow (points + optional anchoring), pen, image (server URL), section (wireframe blocks). Returns assigned IDs. Good defaults: text fontSize 22, list fontSize 18, shapes 160x100.\n\nWireframe sections (type "section"): Semantic website layout blocks. Set sectionType (navbar/hero/sidebar/content/footer/card/form/image-placeholder/button/text-block/grid/modal) and optional label. When using "pct" coordMode, set widths as % of viewport (e.g. 70 for 70%) and heights as % too. Center horizontally with x: 15 for a 70%-width element.';

export async function handleWhiteboardAdd(args: { elements: Record<string, unknown>[]; coordMode?: string; layout?: string }) {
  const result = await ni.addWhiteboardElements(args.elements, args.coordMode, args.layout);
  if (result.error) {
    return text(`Failed to add elements: ${result.error}`);
  }

  const added = result.added as { id: string; type: string; zIndex: number }[];
  const summary = added.map(a => `  ${a.id} (${a.type}, z:${a.zIndex})`).join('\n');
  return text(`Added ${added.length} element(s):\n${summary}`);
}


// ═══════════════════════════════════════════
// whiteboard_update
// ═══════════════════════════════════════════

export const whiteboardUpdateSchema = {
  coordMode: z.enum(['px', 'pct']).optional().describe('Coordinate mode for position/size values. "pct" = percentage of viewport.'),
  id: z.string().describe('The element ID to update (from whiteboard_read results)'),
  updates: z.object({
    x: z.number().optional().describe('New X position'),
    y: z.number().optional().describe('New Y position'),
    width: z.number().optional().describe('New width'),
    height: z.number().optional().describe('New height'),
    content: z.string().optional().describe('New text content (text elements). Use \\n for line breaks.'),
    items: z.array(z.string()).optional().describe('New list items array (list elements)'),
    ordered: z.boolean().optional().describe('Switch between bullet/numbered list (list elements)'),
    fontSize: z.number().optional().describe('New font size'),
    color: z.string().optional().describe('New color'),
    bold: z.boolean().optional().describe('Bold text'),
    italic: z.boolean().optional().describe('Italic text'),
    shape: z.enum(['rect', 'pill', 'circle', 'drawn-circle']).optional().describe('Change shape type'),
    points: z.array(z.array(z.number()).length(2)).optional().describe('New points array'),
    startAnchor: z.string().nullable().optional().describe('New start anchor ID (null to detach)'),
    endAnchor: z.string().nullable().optional().describe('New end anchor ID (null to detach)'),
    rotation: z.number().optional().describe('New rotation in degrees'),
    strokeWidth: z.number().optional().describe('New stroke width'),
    sectionType: z.enum(['navbar', 'hero', 'sidebar', 'content', 'footer', 'card', 'form', 'image-placeholder', 'button', 'text-block', 'grid', 'modal']).optional().describe('Change section type'),
    label: z.string().optional().describe('Change section label'),
  }).describe('Fields to update. Only specified fields are changed; others remain untouched.'),
};

export const whiteboardUpdateDescription =
  'Update properties of an existing whiteboard element. Use whiteboard_read first to get element IDs. Only the specified fields are changed; others remain untouched. Set coordMode to "pct" to use percentage-based positioning. Changes appear in real-time.';

export async function handleWhiteboardUpdate(args: { id: string; updates: Record<string, unknown>; coordMode?: string }) {
  const result = await ni.updateWhiteboardElement(args.id, args.updates, args.coordMode);
  if (result.error) {
    return text(`Failed to update element: ${result.error}`);
  }

  const el = result.element as WhiteboardElement;
  return text(`Updated: ${describeElement(el)}`);
}


// ═══════════════════════════════════════════
// whiteboard_remove
// ═══════════════════════════════════════════

export const whiteboardRemoveSchema = {
  id: z.string().optional().describe('Element ID to remove. Omit to clear the entire whiteboard.'),
};

export const whiteboardRemoveDescription =
  'Remove a specific element from the whiteboard by ID, or clear the entire whiteboard if no ID is provided. Use whiteboard_read first to see element IDs. Arrows anchored to a removed element will be detached.';

export async function handleWhiteboardRemove(args: { id?: string }) {
  if (!args.id) {
    const result = await ni.clearWhiteboard();
    if (result.error) {
      return text(`Failed to clear whiteboard: ${result.error}`);
    }
    return text('Whiteboard cleared.');
  }

  const result = await ni.removeWhiteboardElement(args.id);
  if (result.error) {
    return text(`Failed to remove element: ${result.error}`);
  }

  const removed = result.removed as { id: string; type: string };
  return text(`Removed ${removed.type} element ${removed.id}`);
}


// ═══════════════════════════════════════════
// whiteboard_screenshot
// ═══════════════════════════════════════════

export const whiteboardScreenshotSchema = {};

export const whiteboardScreenshotDescription =
  'Take a visual screenshot of the whiteboard. Returns a JPEG image showing all current elements. Requires the Neural Interface to be open in a browser with Focus mode active. After receiving the screenshot, spawn a Haiku Task agent to interpret the visual contents if needed.';

export async function handleWhiteboardScreenshot() {
  const result = await ni.whiteboardScreenshot();
  if (result.error) {
    return text(`Screenshot failed: ${result.error}`);
  }

  return image(result.data as string, 'image/jpeg');
}
