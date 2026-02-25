import { z } from 'zod';
import * as ni from '../services/neural-interface.js';

// ── browser_snapshot ──

export const browserSnapshotSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserSnapshotDescription =
  'Get an accessibility tree snapshot of the current page. Returns a structured text representation of all visible elements with their ARIA roles, names, and values. This is the primary and most token-efficient way to "see" the page — prefer this over screenshots.';

function formatSnapshotNode(node: Record<string, unknown>, indent = 0): string {
  if (!node) return '';
  const prefix = '  '.repeat(indent);
  const role = node.role || 'generic';
  const name = node.name ? ` "${node.name}"` : '';
  const value = node.value ? ` value="${node.value}"` : '';
  const desc = node.description ? ` (${node.description})` : '';
  const checked = node.checked !== undefined ? ` [${node.checked ? 'checked' : 'unchecked'}]` : '';
  const selected = node.selected !== undefined ? ` [${node.selected ? 'selected' : ''}]` : '';
  const expanded = node.expanded !== undefined ? ` [${node.expanded ? 'expanded' : 'collapsed'}]` : '';
  const disabled = node.disabled ? ' [disabled]' : '';
  const focused = node.focused ? ' [focused]' : '';

  let line = `${prefix}${role}${name}${value}${desc}${checked}${selected}${expanded}${disabled}${focused}`;

  const children = node.children as Record<string, unknown>[] | undefined;
  if (children && children.length > 0) {
    const childLines = children.map(c => formatSnapshotNode(c, indent + 1)).join('\n');
    line += '\n' + childLines;
  }

  return line;
}

export async function handleBrowserSnapshot(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.snapshot(resolved.sessionId);
  if (result.error) return { content: [{ type: 'text' as const, text: `Snapshot failed: ${result.error}` }] };

  const tree = result.snapshot as Record<string, unknown> | null;
  const formatted = tree ? formatSnapshotNode(tree) : '(empty page)';

  let text = `Page: ${result.url}\nTitle: "${result.title}"\n\n`;
  text += formatted;

  // Truncate if very long
  if (text.length > 30000) {
    text = text.slice(0, 30000) + '\n... (truncated — use browser_content for full text or narrow your search)';
  }

  return { content: [{ type: 'text' as const, text }] };
}

// ── browser_content ──

export const browserContentSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserContentDescription =
  'Get the text content of the current page along with its URL and title. Returns the visible text from the page body (up to 50K characters). Use this when you need raw text rather than the structured accessibility tree.';

export async function handleBrowserContent(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.getContent(resolved.sessionId);
  if (result.error) return { content: [{ type: 'text' as const, text: `Content failed: ${result.error}` }] };

  let text = `URL: ${result.url}\nTitle: "${result.title}"\n\n`;
  text += (result.text as string) || '(empty page)';

  return { content: [{ type: 'text' as const, text }] };
}

// ── browser_screenshot ──

export const browserScreenshotSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserScreenshotDescription =
  'Take a screenshot of the current page. Returns a base64-encoded JPEG image. Use sparingly — prefer browser_snapshot for most tasks as it is far more token-efficient.';

export async function handleBrowserScreenshot(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.screenshot(resolved.sessionId);
  if (result.error) return { content: [{ type: 'text' as const, text: `Screenshot failed: ${result.error}` }] };

  return {
    content: [
      { type: 'text' as const, text: `Screenshot of ${result.url} — "${result.title}"` },
      { type: 'image' as const, data: result.data as string, mimeType: 'image/jpeg' },
    ],
  };
}
