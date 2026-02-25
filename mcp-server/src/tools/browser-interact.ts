import { z } from 'zod';
import * as ni from '../services/neural-interface.js';

// ── browser_click ──

export const browserClickSchema = {
  selector: z.string().describe('CSS selector of the element to click (e.g. "button.submit", "#login", "a[href=\'/about\']").'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserClickDescription =
  'Click an element on the page by CSS selector. Use browser_snapshot first to identify interactive elements.';

export async function handleBrowserClick(args: { selector: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.click(resolved.sessionId, args.selector);
  if (result.error) return { content: [{ type: 'text' as const, text: `Click failed: ${result.error}` }] };

  return {
    content: [{ type: 'text' as const, text: `Clicked "${args.selector}" — now at ${result.url} "${result.title}"` }],
  };
}

// ── browser_fill ──

export const browserFillSchema = {
  selector: z.string().describe('CSS selector of the input/textarea to fill (e.g. "input[name=\'email\']", "#search-box").'),
  value: z.string().describe('The text value to fill into the element. Clears existing content first.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserFillDescription =
  'Clear an input field and fill it with new text. Targets the element by CSS selector.';

export async function handleBrowserFill(args: { selector: string; value: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.fill(resolved.sessionId, args.selector, args.value);
  if (result.error) return { content: [{ type: 'text' as const, text: `Fill failed: ${result.error}` }] };

  return {
    content: [{ type: 'text' as const, text: `Filled "${args.selector}" with "${args.value.slice(0, 100)}"` }],
  };
}

// ── browser_type ──

export const browserTypeSchema = {
  selector: z.string().describe('CSS selector of the element to type into.'),
  text: z.string().describe('The text to type character by character (appends to existing content).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserTypeDescription =
  'Type text into an element character by character (simulates real keystrokes). Unlike fill, this appends to existing content and triggers input events for each character.';

export async function handleBrowserType(args: { selector: string; text: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.type(resolved.sessionId, args.selector, args.text);
  if (result.error) return { content: [{ type: 'text' as const, text: `Type failed: ${result.error}` }] };

  return {
    content: [{ type: 'text' as const, text: `Typed "${args.text.slice(0, 100)}" into "${args.selector}"` }],
  };
}

// ── browser_hover ──

export const browserHoverSchema = {
  selector: z.string().describe('CSS selector of the element to hover over.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserHoverDescription =
  'Hover over an element by CSS selector. Useful for revealing dropdowns, tooltips, or hover-triggered content.';

export async function handleBrowserHover(args: { selector: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.hover(resolved.sessionId, args.selector);
  if (result.error) return { content: [{ type: 'text' as const, text: `Hover failed: ${result.error}` }] };

  return {
    content: [{ type: 'text' as const, text: `Hovered over "${args.selector}"` }],
  };
}

// ── browser_select ──

export const browserSelectSchema = {
  selector: z.string().describe('CSS selector of the <select> element.'),
  value: z.string().describe('The option value to select.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserSelectDescription =
  'Select an option from a <select> dropdown by CSS selector and option value.';

export async function handleBrowserSelect(args: { selector: string; value: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.selectOption(resolved.sessionId, args.selector, args.value);
  if (result.error) return { content: [{ type: 'text' as const, text: `Select failed: ${result.error}` }] };

  return {
    content: [{ type: 'text' as const, text: `Selected "${args.value}" in "${args.selector}"` }],
  };
}

// ── browser_press ──

export const browserPressSchema = {
  key: z.string().describe('Key or key combo to press (e.g. "Enter", "Tab", "Control+A", "Escape", "ArrowDown").'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserPressDescription =
  'Press a keyboard key or key combination. Supports modifiers like Control+A, Shift+Enter, etc.';

export async function handleBrowserPress(args: { key: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.pressKey(resolved.sessionId, args.key);
  if (result.error) return { content: [{ type: 'text' as const, text: `Press failed: ${result.error}` }] };

  return {
    content: [{ type: 'text' as const, text: `Pressed "${args.key}"` }],
  };
}
