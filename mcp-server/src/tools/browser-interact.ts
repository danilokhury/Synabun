import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
import { formatInlineSnapshot, formatAiSnapshotBody } from './browser-observe.js';
import * as assist from '../services/browser-assist.js';

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

/**
 * Hints, then — when the server stamped this as a pre-action resolution failure and attached
 * `assist` — Jev's ranking of the candidates against what the caller was aiming at. Shadow by
 * default: the hint list is reordered and annotated, and nothing else happens.
 */
async function describeFailure(result: Record<string, unknown>, request: { action: string; selector?: string; textHint?: string; asked: boolean }): Promise<{ text: string; recovery: assist.Recovery }> {
  // Only when this handler asked for it: an `assist` block that arrives unrequested (a batch step, Jev off) is ignored, not judged.
  const recovery = request.asked && result.assist ? await assist.recoverFailedTarget(result, request) : { annotation: '' };
  return { text: `${formatClickHints(recovery.hints ? { ...result, hints: recovery.hints } : result)}${recovery.annotation}`, recovery };
}

/** Ask for candidates only for selector targets: a stale ref has no hint list to rank, and a fresh snapshot is the fix. */
const wantsTargetAssist = (args: { ref?: string; selector?: string | null }) => Boolean(args.selector) && !args.ref && assist.assistAvailable('browser-target');

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
  textHint: z.string().optional().describe('What you meant to click, in words (e.g. "Account settings"). If the selector matches nothing the server first tries an exact role+name match; failing that, the visible candidates are ranked against this phrase and the best one is named in the error. Advisory unless safe auto-heal is switched on.'),
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
  const asked = wantsTargetAssist(args);
  let result = await ni.click(resolved.sessionId, args.selector, args.nthMatch, resolved.tabId, args.textHint, rs, args.ref, snapshot, undefined, asked);
  let healedBy = '';
  if (result.error) {
    const failure = await describeFailure(result, { action: 'click', selector: args.selector, textHint: args.textHint, asked });
    // Safe auto-heal: off unless a recorded benchmark vouches for the running configuration, and then
    // exactly one retry, of a plain navigation link, through a context the server minted for this
    // failure. attemptAutoHeal is a direct transport call; this handler is never re-entered.
    const outcome = failure.recovery.heal
      ? await assist.attemptAutoHeal(failure.recovery.heal, { sessionId: resolved.sessionId, tabId: resolved.tabId, snapshot })
      : null;
    if (outcome?.status === 'uncertain') {
      return text(`Click failed: ${result.error}\n\nJev auto-heal was then attempted once and its outcome is uncertain: ${outcome.error}\nInspect the page before doing anything else; nothing is retried.`);
    }
    if (outcome?.status !== 'healed') return text(`Click failed: ${result.error}${failure.text}${outcome?.note ?? ''}`);
    healedBy = ` (auto-healed via Jev to "${outcome.label}": ${outcome.verdict}; ${describeTarget(args.ref, args.selector)} matched nothing)`;
    result = outcome.result;
  }

  const healed = healedBy || (result.healed ? ' (auto-healed via textHint)' : '');
  let msg = `Clicked ${describeTarget(args.ref, args.selector)}${healed}${locationSuffix(result)}`;
  if (snapshot && snapshot !== 'none') {
    msg = appendAiSnapshot(msg, result);
  } else if (args.returnSnapshot && !healedBy) {
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

  const asked = wantsTargetAssist(args);
  const result = await ni.fill(resolved.sessionId, args.selector, args.value, args.nthMatch, resolved.tabId, args.textHint, args.ref, asked);
  // The value being filled is never part of what is judged: only the target phrase and the page's candidates are.
  if (result.error) return text(`Fill failed: ${result.error}${(await describeFailure(result, { action: 'fill', selector: args.selector, textHint: args.textHint, asked })).text}`);

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

  const asked = wantsTargetAssist(args);
  const result = await ni.type(resolved.sessionId, args.selector ?? null, args.text, args.nthMatch, resolved.tabId, args.textHint, args.mode, args.ref, asked);
  if (result.error) return text(`Type failed: ${result.error}${(await describeFailure(result, { action: 'type', selector: args.selector, textHint: args.textHint, asked })).text}`);

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

  const asked = wantsTargetAssist(args);
  const result = await ni.hover(resolved.sessionId, args.selector, args.nthMatch, resolved.tabId, args.textHint, args.ref, asked);
  if (result.error) return text(`Hover failed: ${result.error}${(await describeFailure(result, { action: 'hover', selector: args.selector, textHint: args.textHint, asked })).text}`);

  const healed = result.healed ? ' (auto-healed via textHint)' : '';
  return text(`Hovered over ${describeTarget(args.ref, args.selector)}${healed}${locationSuffix(result)}`);
}

// ── browser_select ──

export const browserSelectSchema = {
  ref: refField,
  selector: selectorField('the <select> element'),
  value: z.string().describe('The option value to select.'),
  nthMatch: z.coerce.number().int().min(0).optional().describe('If the selector matches multiple elements, select from the Nth one (0-indexed).'),
  textHint: z.string().optional().describe('What the dropdown is for, in words (e.g. "Country"). If the selector matches nothing, the server tries an exact role+name match and the visible candidates are ranked against this phrase. Advisory.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserSelectDescription =
  'Select an option from a <select> dropdown by ref or selector, and option value.';

export async function handleBrowserSelect(args: { ref?: string; selector?: string; value: string; nthMatch?: number; textHint?: string; sessionId?: string; tabId?: string }) {
  if (!args.ref && !args.selector) return text('Provide ref (from browser_snapshot) or selector.');
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const asked = wantsTargetAssist(args);
  const result = await ni.selectOption(resolved.sessionId, args.selector, args.value, args.nthMatch, resolved.tabId, args.ref, args.textHint, asked);
  if (result.error) return text(`Select failed: ${result.error}${(await describeFailure(result, { action: 'select', selector: args.selector, textHint: args.textHint, asked })).text}`);

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
  textHint: z.string().optional().describe('What the upload control is, in words (e.g. "Add photo"). If the file input is not found, the visible controls are ranked against this phrase — usually the button that reveals the hidden input. Advisory.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserUploadDescription =
  'Upload files via a file input element (by ref or selector). For hidden/gated inputs, click the visible upload button first to reveal the input. See browser_cheatsheet for per-platform upload flows.';

export async function handleBrowserUpload(args: { ref?: string; selector?: string; filePaths: string[]; nthMatch?: number; textHint?: string; sessionId?: string; tabId?: string }) {
  if (!args.ref && !args.selector) return text('Provide ref (from browser_snapshot) or selector.');
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const asked = wantsTargetAssist(args);
  const result = await ni.upload(resolved.sessionId, args.selector, args.filePaths, args.nthMatch, resolved.tabId, args.ref, args.textHint, asked);
  if (result.error) return text(`Upload failed: ${result.error}${(await describeFailure(result, { action: 'upload', selector: args.selector, textHint: args.textHint, asked })).text}`);

  return text(`Uploaded ${args.filePaths.length} file(s) via ${describeTarget(args.ref, args.selector)}${locationSuffix(result)}`);
}
