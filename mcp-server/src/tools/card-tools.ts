import { z } from 'zod';
import * as ni from '../services/neural-interface.js';

// ═══════════════════════════════════════════
// card_list
// ═══════════════════════════════════════════

export const cardListSchema = {};

export const cardListDescription =
  'List all currently open memory cards in the Neural Interface. Returns each card\'s memory UUID, position, size, compact/pin state, content preview, and the current viewport dimensions (width x height). Use this before placing cards to know the available screen size.';

interface CardInfo {
  memoryId: string;
  panelId: string;
  left: string;
  top: string;
  width: string;
  height: string;
  isCompact: boolean;
  isPinned: boolean;
  category?: string;
  contentPreview?: string;
}

function describeCard(card: CardInfo, index: number): string {
  const pos = `at (${card.left || '?'}, ${card.top || '?'})`;
  const size = card.width ? `${card.width} x ${card.height || 'auto'}` : 'default';
  const flags = [
    card.isCompact && 'COMPACT',
    card.isPinned && 'PINNED',
  ].filter(Boolean).join(', ');
  const flagStr = flags ? ` [${flags}]` : '';
  const cat = card.category ? ` (${card.category})` : '';
  const preview = card.contentPreview
    ? `\n   "${card.contentPreview.length > 80 ? card.contentPreview.slice(0, 80) + '...' : card.contentPreview}"`
    : '';

  return `${index + 1}. [${card.memoryId}] ${pos} ${size}${flagStr}${cat}${preview}`;
}

export async function handleCardList() {
  const result = await ni.getCards();
  if (result.error) {
    return { content: [{ type: 'text' as const, text: `Failed to read cards: ${result.error}` }] };
  }

  const cards = (result.cards || []) as CardInfo[];
  const viewport = result.viewport as { width: number; height: number } | null;

  if (cards.length === 0) {
    let emptyText = 'No memory cards are currently open.';
    if (viewport) emptyText += `\nViewport: ${viewport.width}x${viewport.height}`;
    return { content: [{ type: 'text' as const, text: emptyText }] };
  }

  let text = `Open cards: ${cards.length}`;
  if (viewport) text += ` | Viewport: ${viewport.width}x${viewport.height}`;
  text += '\n\n';
  text += cards.map((c, i) => describeCard(c, i)).join('\n');

  return { content: [{ type: 'text' as const, text }] };
}


// ═══════════════════════════════════════════
// card_open
// ═══════════════════════════════════════════

export const cardOpenSchema = {
  memoryId: z.string().describe('UUID of the memory to open as a floating card'),
  coordMode: z.enum(['px', 'pct']).optional().describe('Coordinate mode. "px" (default) = absolute pixels. "pct" = percentage of viewport (0-100). left:50 top:50 = center of screen.'),
  left: z.number().optional().describe('X position from left edge. Omit for auto-cascade.'),
  top: z.number().optional().describe('Y position from top edge. Omit for auto-cascade.'),
  compact: z.boolean().optional().describe('Open in compact mode (220x120px mini-card). Default: false.'),
};

export const cardOpenDescription =
  'Open a memory as a floating card in the Neural Interface. Use card_list first to see viewport size.\n\nCoordinate modes (coordMode): "px" (default) = absolute pixels. "pct" = percentage of viewport (0-100), e.g. left:50 top:50 = center of screen.\n\nIf the card is already open, it is brought to the front. Omit left/top for auto-cascade positioning.';

export async function handleCardOpen(args: { memoryId: string; coordMode?: string; left?: number; top?: number; compact?: boolean }) {
  const result = await ni.openCard(args.memoryId, {
    left: args.left,
    top: args.top,
    compact: args.compact,
    coordMode: args.coordMode,
  });
  if (result.error) {
    return { content: [{ type: 'text' as const, text: `Failed to open card: ${result.error}` }] };
  }

  const r = result.result as Record<string, unknown> | undefined;
  const alreadyOpen = r?.alreadyOpen ? ' (was already open, brought to front)' : '';
  const pos = r ? `at (${r.left}, ${r.top})` : '';
  return { content: [{ type: 'text' as const, text: `Card opened${alreadyOpen}: ${args.memoryId} ${pos}` }] };
}


// ═══════════════════════════════════════════
// card_close
// ═══════════════════════════════════════════

export const cardCloseSchema = {
  memoryId: z.string().optional().describe('UUID of the card to close. Omit to close ALL open cards.'),
};

export const cardCloseDescription =
  'Close a memory card by its UUID, or close all open cards if no memoryId is provided. Use card_list first to see which cards are open.';

export async function handleCardClose(args: { memoryId?: string }) {
  const result = await ni.closeCard(args.memoryId);
  if (result.error) {
    return { content: [{ type: 'text' as const, text: `Failed to close card: ${result.error}` }] };
  }

  if (!args.memoryId) {
    return { content: [{ type: 'text' as const, text: 'All cards closed.' }] };
  }
  return { content: [{ type: 'text' as const, text: `Card closed: ${args.memoryId}` }] };
}


// ═══════════════════════════════════════════
// card_update
// ═══════════════════════════════════════════

export const cardUpdateSchema = {
  memoryId: z.string().describe('UUID of the card to update (must be currently open)'),
  coordMode: z.enum(['px', 'pct']).optional().describe('Coordinate mode for position/size values. "pct" = percentage of viewport.'),
  left: z.number().optional().describe('New X position'),
  top: z.number().optional().describe('New Y position'),
  width: z.number().optional().describe('New width (ignored in compact mode)'),
  height: z.number().optional().describe('New height (ignored in compact mode)'),
  compact: z.boolean().optional().describe('true = switch to compact mode (220x120px), false = expand to full size'),
  pinned: z.boolean().optional().describe('true = pin card (locked position, dimmed, z-index 180), false = unpin'),
};

export const cardUpdateDescription =
  'Update an open memory card\'s position, size, compact/expand state, or pin state. Set coordMode to "pct" to use percentage-based positioning. Only specified fields are changed; others remain untouched. Changes appear in real-time.';

export async function handleCardUpdate(args: {
  memoryId: string;
  coordMode?: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  compact?: boolean;
  pinned?: boolean;
}) {
  const { memoryId, coordMode, ...updates } = args;

  // Check at least one update field provided
  const hasUpdate = Object.values(updates).some(v => v !== undefined);
  if (!hasUpdate) {
    return { content: [{ type: 'text' as const, text: 'No update fields provided. Specify at least one of: left, top, width, height, compact, pinned.' }] };
  }

  const result = await ni.updateCard(memoryId, updates, coordMode);
  if (result.error) {
    return { content: [{ type: 'text' as const, text: `Failed to update card: ${result.error}` }] };
  }

  const r = result.result as Record<string, unknown> | undefined;
  const parts: string[] = [];
  if (r) {
    if (r.left !== undefined) parts.push(`pos: (${r.left}, ${r.top})`);
    if (r.isCompact !== undefined) parts.push(r.isCompact ? 'compact' : 'expanded');
    if (r.isPinned !== undefined) parts.push(r.isPinned ? 'pinned' : 'unpinned');
    if (r.width) parts.push(`size: ${r.width} x ${r.height || 'auto'}`);
  }
  return { content: [{ type: 'text' as const, text: `Card updated: ${memoryId}${parts.length ? ' — ' + parts.join(', ') : ''}` }] };
}


// ═══════════════════════════════════════════
// card_screenshot
// ═══════════════════════════════════════════

export const cardScreenshotSchema = {};

export const cardScreenshotDescription =
  'Take a visual screenshot of the Neural Interface showing all open memory cards in their current positions. Returns a JPEG image. Requires the Neural Interface to be open in a browser.';

export async function handleCardScreenshot() {
  const result = await ni.cardsScreenshot();
  if (result.error) {
    return { content: [{ type: 'text' as const, text: `Screenshot failed: ${result.error}` }] };
  }

  return {
    content: [
      { type: 'image' as const, data: result.data as string, mimeType: 'image/jpeg' },
    ],
  };
}
