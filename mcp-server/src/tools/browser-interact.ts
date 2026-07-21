import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
import { formatInlineSnapshot, formatAiSnapshotBody } from './browser-observe.js';

const returnSnapshotField = z.object({
  mode: z.enum(['full', 'interactive', 'landmarks']).optional(),
  selector: z.string().optional(),
  viewport: z.boolean().optional(),
  maxChars: z.number().int().positive().optional(),
  format: z.enum(['text', 'json']).optional(),
}).optional().describe('Legacy inline snapshot (tree modes). Prefer the "snapshot" param, which returns ref-based AI snapshots.');

const tabIdField = z.string().optional().describe('Target a specific tab within the session. Auto-resolved from environment if omitted.');

const refField = z.string().optional().describe('Element ref from browser_snapshot, e.g. "e12". Preferred over selector — exact match, no guessing.');

const selectorField = (what: string) => z.string().optional().describe(
  `Playwright selector for ${what} (CSS, text="...", :has-text("..."), role=..., [data-testid="..."]). Fallback when you have no ref. NEVER use :contains().`
);

// Auto inline AI snapshots after click/navigate can be disabled globally for
// legacy loop automations that expect terse action responses.
export function autosnapshotEnabled(): boolean {
  return process.env.SYNABUN_BROWSER_AUTOSNAPSHOT !== '0';
}

const CLICK_SNAPSHOT_MAX_CHARS = 6000;

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
  msg += '\n\nRetry with one of the selectors above, or browser_snapshot for fresh refs.';
  return msg;
}

function locationSuffix(result: Record<string, unknown>): string {
  if (ni.isBrowserCompactMode()) return '';
  return result.url ? ` — ${result.url} "${result.title}"` : '';
}

function describeTarget(ref?: string, selector?: string): string {
  return ref ? `ref "${ref}"` : `"${selector}"`;
}

// Appends the inline snapshot section for the new-style snapshot param ('diff'|'full').
function appendAiSnapshot(msg: string, result: Record<string, unknown>): string {
  return msg + `\n\n--- Snapshot ---\n${formatAiSnapshotBody(result, CLICK_SNAPSHOT_MAX_CHARS)}`;
}

// ── browser_click ──

export const browserClickSchema = {
  ref: refField,
  selector: selectorField('the element to click'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, target the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Auto-heal: if the selector matches 0 elements, server retries with role=*[name~="<textHint>"].'),
  snapshot: z.enum(['diff', 'full', 'none']).optional().describe('Inline AI snapshot after the click. Default "diff" = only the changed region vs your last snapshot. "none" = terse response.'),
  returnSnapshot: returnSnapshotField,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserClickDescription =
  'Click an element. Pass ref (e.g. "e12") from browser_snapshot — exact, no guessing. Selector is the fallback (CSS, text="...", :has-text(...), role=...; never :contains()). By default the response includes an AI snapshot diff of what changed, so you usually do NOT need a follow-up browser_snapshot.';

export async function handleBrowserClick(args: {
  ref?: string;
  selector?: string;
  nthMatch?: number;
  textHint?: string;
  snapshot?: 'diff' | 'full' | 'none';
  returnSnapshot?: { mode?: 'full' | 'interactive' | 'landmarks'; selector?: string; viewport?: boolean; maxChars?: number; format?: 'text' | 'json' };
  sessionId?: string;
  tabId?: string;
}) {
  if (!args.ref && !args.selector) return text('Provide ref (from browser_snapshot) or selector.');
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const rs = args.returnSnapshot ? {
    mode: args.returnSnapshot.mode,
    selector: args.returnSnapshot.selector,
    viewport: args.returnSnapshot.viewport,
  } : undefined;
  // New-style inline AI snapshot: default 'diff' unless legacy returnSnapshot was
  // passed or auto-snapshot is globally disabled.
  const snapshot = args.snapshot ?? (rs || !autosnapshotEnabled() ? undefined : 'diff');
  const result = await ni.click(resolved.sessionId, args.selector, args.nthMatch, resolved.tabId, args.textHint, rs, args.ref, snapshot);
  if (result.error) return text(`Click failed: ${result.error}${formatClickHints(result)}`);

  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  let msg = `Clicked ${describeTarget(args.ref, args.selector)}${healed}${locationSuffix(result)}`;
  if (snapshot && snapshot !== 'none') {
    msg = appendAiSnapshot(msg, result);
  } else if (args.returnSnapshot) {
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
  ref: refField,
  selector: selectorField('the input/textarea to fill'),
  value: z.string().describe('The text value to fill. Clears existing content first.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, fill the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Auto-heal: if the selector matches 0 elements, server retries with role=*[name~="<textHint>"].'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserFillDescription =
  'Clear an input/textarea and fill it with new text. Pass ref from browser_snapshot (preferred) or a selector. For contenteditable editors prefer browser_type.';

export async function handleBrowserFill(args: { ref?: string; selector?: string; value: string; nthMatch?: number; textHint?: string; sessionId?: string; tabId?: string }) {
  if (!args.ref && !args.selector) return text('Provide ref (from browser_snapshot) or selector.');
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.fill(resolved.sessionId, args.selector, args.value, args.nthMatch, resolved.tabId, args.textHint, args.ref);
  if (result.error) return text(`Fill failed: ${result.error}${formatClickHints(result)}`);

  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  return text(`Filled ${describeTarget(args.ref, args.selector)}${healed} with "${args.value.slice(0, 100)}"${locationSuffix(result)}`);
}

// ── browser_type ──

export const browserTypeSchema = {
  ref: refField,
  selector: z.string().optional().describe('Playwright selector for the element to type into. If both ref and selector are omitted, types into the focused element.'),
  text: z.string().describe('The text to type character by character (appends to existing content).'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, type into the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Auto-heal: if the selector matches 0 elements, server retries with role=*[name~="<textHint>"].'),
  mode: z.enum(['sequential', 'insert', 'paragraphs']).optional().describe('"sequential" = per-key events. "insert" = bulk insertText, fast, safe for modal composers. "paragraphs" = Escape+Enter between paragraphs (never on modals — Escape closes them). See browser_cheatsheet for platform guidance.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserTypeDescription =
  'Type text (simulates keystrokes; appends). Target by ref from browser_snapshot (preferred), selector, or omit both to type into the focused element. Prefer over browser_fill for contenteditable/rich-text editors.';

export async function handleBrowserType(args: { ref?: string; selector?: string; text: string; nthMatch?: number; textHint?: string; mode?: 'sequential' | 'insert' | 'paragraphs'; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.type(resolved.sessionId, args.selector ?? null, args.text, args.nthMatch, resolved.tabId, args.textHint, args.mode, args.ref);
  if (result.error) return text(`Type failed: ${result.error}${formatClickHints(result)}`);

  const target = args.ref ? `ref "${args.ref}"` : args.selector ? `"${args.selector}"` : 'focused element';
  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  return text(`Typed "${args.text.slice(0, 100)}" into ${target}${healed}${locationSuffix(result)}`);
}

// ── browser_hover ──

export const browserHoverSchema = {
  ref: refField,
  selector: selectorField('the element to hover over'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, hover over the Nth (0-indexed).'),
  textHint: z.string().optional().describe('Auto-heal: if the selector matches 0 elements, server retries with role=*[name~="<textHint>"].'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserHoverDescription =
  'Hover over an element (reveals dropdowns, tooltips, hover-triggered content). Pass ref from browser_snapshot (preferred) or a selector.';

export async function handleBrowserHover(args: { ref?: string; selector?: string; nthMatch?: number; textHint?: string; sessionId?: string; tabId?: string }) {
  if (!args.ref && !args.selector) return text('Provide ref (from browser_snapshot) or selector.');
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.hover(resolved.sessionId, args.selector, args.nthMatch, resolved.tabId, args.textHint, args.ref);
  if (result.error) return text(`Hover failed: ${result.error}${formatClickHints(result)}`);

  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  return text(`Hovered over ${describeTarget(args.ref, args.selector)}${healed}${locationSuffix(result)}`);
}

// ── browser_select ──

export const browserSelectSchema = {
  ref: refField,
  selector: selectorField('the <select> element'),
  value: z.string().describe('The option value to select.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, select from the Nth one (0-indexed).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserSelectDescription =
  'Select an option from a <select> dropdown by ref or selector, and option value.';

export async function handleBrowserSelect(args: { ref?: string; selector?: string; value: string; nthMatch?: number; sessionId?: string; tabId?: string }) {
  if (!args.ref && !args.selector) return text('Provide ref (from browser_snapshot) or selector.');
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.selectOption(resolved.sessionId, args.selector, args.value, args.nthMatch, resolved.tabId, args.ref);
  if (result.error) return text(`Select failed: ${result.error}${formatClickHints(result)}`);

  return text(`Selected "${args.value}" in ${describeTarget(args.ref, args.selector)}${locationSuffix(result)}`);
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

  return text(`Pressed "${args.key}"${locationSuffix(result)}`);
}

// ── browser_scroll ──

export const browserScrollSchema = {
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to scroll.'),
  distance: z.coerce.number().optional().describe('Pixels to scroll (default: 500).'),
  ref: z.string().optional().describe('Scroll within the container with this ref from browser_snapshot.'),
  selector: z.string().optional().describe('Scroll within a specific scrollable element instead of the window.'),
  snapshot: z.enum(['diff', 'full', 'none']).optional().describe('Optionally include an AI snapshot after scrolling ("diff" = only what changed).'),
  returnSnapshot: returnSnapshotField,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserScrollDescription =
  'Scroll the page or a scrollable container (by ref or selector). Essential for infinite-scroll feeds — but for harvesting feed data, prefer the browser_extract_* tools with their scrolls param, which scroll+extract+dedupe in one call.';

export async function handleBrowserScroll(args: {
  direction: string;
  distance?: number;
  ref?: string;
  selector?: string;
  snapshot?: 'diff' | 'full' | 'none';
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
    ref: args.ref,
    snapshot: args.snapshot,
    returnSnapshot: rs,
  }, resolved.tabId);
  if (result.error) return text(`Scroll failed: ${result.error}`);

  const target = args.ref ? `ref "${args.ref}"` : args.selector ? `"${args.selector}"` : 'page';
  let msg = `Scrolled ${args.direction} ${args.distance ?? 500}px in ${target}${locationSuffix(result)}`;
  if (args.snapshot && args.snapshot !== 'none') {
    msg = appendAiSnapshot(msg, result);
  } else if (args.returnSnapshot) {
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
  ref: refField,
  selector: selectorField('the file input element'),
  filePaths: z.array(z.string()).describe('Absolute file paths to upload.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple file inputs, upload to the Nth (0-indexed).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserUploadDescription =
  'Upload files via a file input element (by ref or selector). For hidden/gated inputs, click the visible upload button first to reveal the input. See browser_cheatsheet for per-platform upload flows.';

export async function handleBrowserUpload(args: { ref?: string; selector?: string; filePaths: string[]; nthMatch?: number; sessionId?: string; tabId?: string }) {
  if (!args.ref && !args.selector) return text('Provide ref (from browser_snapshot) or selector.');
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.upload(resolved.sessionId, args.selector, args.filePaths, args.nthMatch, resolved.tabId, args.ref);
  if (result.error) return text(`Upload failed: ${result.error}${formatClickHints(result)}`);

  return text(`Uploaded ${args.filePaths.length} file(s) via ${describeTarget(args.ref, args.selector)}${locationSuffix(result)}`);
}
