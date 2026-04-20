import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
import { formatInlineSnapshot } from './browser-observe.js';

const returnSnapshotField = z.object({
  mode: z.enum(['full', 'interactive', 'landmarks']).optional(),
  selector: z.string().optional(),
  viewport: z.boolean().optional(),
  maxChars: z.number().int().positive().optional(),
  format: z.enum(['text', 'json']).optional(),
}).optional().describe('If set, the server also captures a snapshot after the action and returns it in the same response — one round-trip instead of two. Matches browser_snapshot params.');

const tabIdField = z.string().optional().describe('Target a specific tab within the session. Auto-resolved from environment if omitted.');

function formatClickHints(result: Record<string, unknown>): string {
  const hints = result.hints as Array<{ role: string; text: string; ariaLabel: string; placeholder: string; selector?: string; nth?: number }> | undefined;
  if (!hints?.length) return '';
  const heading = result.hintsLabel as string | undefined;
  let msg = `\n\n${heading || 'Visible interactive elements on page'}:`;
  for (const h of hints) {
    const label = h.ariaLabel || h.text || h.placeholder || '(unnamed)';
    const sel = h.selector ? ` → ${h.selector}${h.nth !== undefined ? ` [nth:${h.nth}]` : ''}` : '';
    msg += `\n- ${h.role}: "${label.substring(0, 60)}"${sel}`;
  }
  msg += '\n\nRetry browser_click/fill with one of the selectors above, or use browser_snapshot with mode="interactive".';
  return msg;
}

// ── browser_click ──

export const browserClickSchema = {
  selector: z.string().describe('Playwright selector (CSS, text="...", :has-text("..."), role=..., [data-testid="..."]). NEVER use :contains().'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, target the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Optional auto-heal hint. If the primary selector matches 0 elements, server retries once with role=*[name~="<textHint>"] before failing.'),
  returnSnapshot: returnSnapshotField,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserClickDescription =
  'Click an element on the page. Accepts Playwright selectors: CSS, text="...", :has-text("..."), role=button[name="..."], [data-testid="..."]. NEVER use :contains() — use :has-text(). Run browser_snapshot first (or mode="interactive") to find the element. Call browser_cheatsheet for per-platform stable selectors.';

export async function handleBrowserClick(args: {
  selector: string;
  nthMatch?: number;
  textHint?: string;
  returnSnapshot?: { mode?: 'full' | 'interactive' | 'landmarks'; selector?: string; viewport?: boolean; maxChars?: number; format?: 'text' | 'json' };
  sessionId?: string;
  tabId?: string;
}) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const rs = args.returnSnapshot ? {
    mode: args.returnSnapshot.mode,
    selector: args.returnSnapshot.selector,
    viewport: args.returnSnapshot.viewport,
  } : undefined;
  const result = await ni.click(resolved.sessionId, args.selector, args.nthMatch, resolved.tabId, args.textHint, rs);
  if (result.error) return text(`Click failed: ${result.error}${formatClickHints(result)}`);

  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  let msg = `Clicked "${args.selector}"${healed} — now at ${result.url} "${result.title}"`;
  if (args.returnSnapshot) {
    const snap = formatInlineSnapshot(result, {
      mode: args.returnSnapshot.mode,
      format: args.returnSnapshot.format,
      maxChars: args.returnSnapshot.maxChars,
    });
    msg += `\n\n--- Snapshot (${args.returnSnapshot.mode || 'full'}) ---\n${snap}`;
  }
  return text(msg);
}

// ── browser_fill ──

export const browserFillSchema = {
  selector: z.string().describe('Playwright selector for the input/textarea to fill.'),
  value: z.string().describe('The text value to fill. Clears existing content first.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, fill the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Optional auto-heal hint. If the primary selector matches 0 elements, server retries once with role=*[name~="<textHint>"] before failing.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserFillDescription =
  'Clear an input/textarea and fill it with new text. Accepts Playwright selectors: CSS, text="...", :has-text("..."), [data-testid="..."]. For contenteditable editors prefer browser_type. Call browser_cheatsheet for per-platform input selectors.';

export async function handleBrowserFill(args: { selector: string; value: string; nthMatch?: number; textHint?: string; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.fill(resolved.sessionId, args.selector, args.value, args.nthMatch, resolved.tabId, args.textHint);
  if (result.error) return text(`Fill failed: ${result.error}${formatClickHints(result)}`);

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  return text(`Filled "${args.selector}"${healed} with "${args.value.slice(0, 100)}"${location}`);
}

// ── browser_type ──

export const browserTypeSchema = {
  selector: z.string().optional().describe('Playwright selector for the element to type into. If omitted, types into the currently focused element using keyboard events.'),
  text: z.string().describe('The text to type character by character (appends to existing content).'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, type into the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Optional auto-heal hint. If the primary selector matches 0 elements, server retries once with role=*[name~="<textHint>"] before failing.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserTypeDescription =
  'Type text character-by-character (simulates real keystrokes; appends). Provide a selector to target, or omit to type into the focused element. Prefer over browser_fill for contenteditable/rich-text editors. Call browser_cheatsheet for per-platform compose selectors.';

export async function handleBrowserType(args: { selector?: string; text: string; nthMatch?: number; textHint?: string; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.type(resolved.sessionId, args.selector ?? null, args.text, args.nthMatch, resolved.tabId, args.textHint);
  if (result.error) return text(`Type failed: ${result.error}${formatClickHints(result)}`);

  const target = args.selector ? `"${args.selector}"` : 'focused element';
  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  return text(`Typed "${args.text.slice(0, 100)}" into ${target}${healed}${location}`);
}

// ── browser_hover ──

export const browserHoverSchema = {
  selector: z.string().describe('Playwright selector for the element to hover over.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, hover over the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Optional auto-heal hint. If the primary selector matches 0 elements, server retries once with role=*[name~="<textHint>"] before failing.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserHoverDescription =
  'Hover over an element. Useful for revealing dropdowns, tooltips, or hover-triggered content. Accepts Playwright selectors.';

export async function handleBrowserHover(args: { selector: string; nthMatch?: number; textHint?: string; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.hover(resolved.sessionId, args.selector, args.nthMatch, resolved.tabId, args.textHint);
  if (result.error) return text(`Hover failed: ${result.error}${formatClickHints(result)}`);

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  return text(`Hovered over "${args.selector}"${healed}${location}`);
}

// ── browser_select ──

export const browserSelectSchema = {
  selector: z.string().describe('Playwright selector for the <select> element.'),
  value: z.string().describe('The option value to select.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, select from the Nth one (0-indexed).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserSelectDescription =
  'Select an option from a <select> dropdown by CSS selector and option value.';

export async function handleBrowserSelect(args: { selector: string; value: string; nthMatch?: number; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.selectOption(resolved.sessionId, args.selector, args.value, args.nthMatch, resolved.tabId);
  if (result.error) return text(`Select failed: ${result.error}${formatClickHints(result)}`);

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return text(`Selected "${args.value}" in "${args.selector}"${location}`);
}

// ── browser_press ──

export const browserPressSchema = {
  key: z.string().describe('Key or key combo to press (e.g. "Enter", "Tab", "Control+A", "Escape", "ArrowDown").'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserPressDescription =
  'Press a keyboard key or key combination. Supports modifiers like Control+A, Shift+Enter, etc.';

export async function handleBrowserPress(args: { key: string; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.pressKey(resolved.sessionId, args.key, resolved.tabId);
  if (result.error) return text(`Press failed: ${result.error}`);

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return text(`Pressed "${args.key}"${location}`);
}

// ── browser_scroll ──

export const browserScrollSchema = {
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to scroll.'),
  distance: z.coerce.number().optional().describe('Pixels to scroll (default: 500).'),
  selector: z.string().optional().describe('Scroll within a specific scrollable element instead of the window. Call browser_cheatsheet for per-platform scroll containers.'),
  returnSnapshot: returnSnapshotField,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserScrollDescription =
  'Scroll the page or a specific scrollable element. Essential for infinite-scroll feeds. Pass a selector to scroll within a container (e.g. a feed or chat list). Default distance is 500px. Call browser_cheatsheet for per-platform scroll containers and recommended distances.';

export async function handleBrowserScroll(args: {
  direction: string;
  distance?: number;
  selector?: string;
  returnSnapshot?: { mode?: 'full' | 'interactive' | 'landmarks'; selector?: string; viewport?: boolean; maxChars?: number; format?: 'text' | 'json' };
  sessionId?: string;
  tabId?: string;
}) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const rs = args.returnSnapshot ? {
    mode: args.returnSnapshot.mode,
    selector: args.returnSnapshot.selector,
    viewport: args.returnSnapshot.viewport,
  } : undefined;
  const result = await ni.scroll(resolved.sessionId, {
    direction: args.direction,
    distance: args.distance,
    selector: args.selector,
    returnSnapshot: rs,
  }, resolved.tabId);
  if (result.error) return text(`Scroll failed: ${result.error}`);

  const target = args.selector ? `"${args.selector}"` : 'page';
  let msg = `Scrolled ${args.direction} ${args.distance ?? 500}px in ${target} — now at ${result.url} "${result.title}"`;
  if (args.returnSnapshot) {
    const snap = formatInlineSnapshot(result, {
      mode: args.returnSnapshot.mode,
      format: args.returnSnapshot.format,
      maxChars: args.returnSnapshot.maxChars,
    });
    msg += `\n\n--- Snapshot (${args.returnSnapshot.mode || 'full'}) ---\n${snap}`;
  }
  return text(msg);
}

// ── browser_upload ──

export const browserUploadSchema = {
  selector: z.string().describe('Playwright selector for the file input element. Call browser_cheatsheet for per-platform file-input selectors.'),
  filePaths: z.array(z.string()).describe('Absolute file paths to upload.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple file inputs, upload to the Nth (0-indexed).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserUploadDescription =
  'Upload one or more files via a file input element. For platforms with hidden/gated inputs, click the visible upload/media button first to reveal the input, then pass its selector. Call browser_cheatsheet for per-platform upload flows.';

export async function handleBrowserUpload(args: { selector: string; filePaths: string[]; nthMatch?: number; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.upload(resolved.sessionId, args.selector, args.filePaths, args.nthMatch, resolved.tabId);
  if (result.error) return text(`Upload failed: ${result.error}${formatClickHints(result)}`);

  return text(`Uploaded ${args.filePaths.length} file(s) via "${args.selector}" — now at ${result.url} "${result.title}"`);
}
