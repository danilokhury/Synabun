import { z } from 'zod';
import * as ni from '../services/neural-interface.js';

// ── browser_click ──

export const browserClickSchema = {
  selector: z.string().describe('Playwright selector for the element to click. Use CSS selectors (e.g. "button.submit", "#login"), text selectors (e.g. \'text="Sign in"\'), or Playwright extensions like \'button:has-text("Retry")\'. NEVER use :contains() — use :has-text() instead.'),
  nthMatch: z.number().int().min(0).optional().describe('If the selector matches multiple elements, click the Nth one (0-indexed). Facebook: composer trigger appears in sidebar + main — use nthMatch: 0 to click the first match.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserClickDescription =
  'Click an element on the page. Accepts Playwright selectors: CSS selectors, text="...", :has-text("..."), role=button[name="..."], or [data-testid="..."]. Use browser_snapshot first to identify interactive elements. ' +
  'Twitter/X stable selectors: [data-testid="tweetButton"] (post), [data-testid="like"], [data-testid="retweet"], [data-testid="reply"], [data-testid="SideNav_NewTweet_Button"] (compose FAB). ' +
  'Facebook: [role="button"][aria-label="Curtir"] (PT like), [role="button"][aria-label="Like"] (EN), [role="button"][aria-label="Beğen"] (TR), [role="button"][aria-label*="Compartilhar"] (PT share), [role="button"][aria-label*="Share"] (EN share). ' +
  'Facebook composer trigger: scope to [role="main"] div[role="button"]:has-text("Escreva algo") (PT) / :has-text("Write something") (EN) / :has-text("Bir şeyler yaz") (TR), or pass nthMatch: 0 on the unscoped selector. ' +
  'Facebook post submit: [role="dialog"] [role="button"]:has-text("Publicar") (PT) / :has-text("Post") (EN) / :has-text("Paylaş") (TR).';

export async function handleBrowserClick(args: { selector: string; nthMatch?: number; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.click(resolved.sessionId, args.selector, args.nthMatch);
  if (result.error) return { content: [{ type: 'text' as const, text: `Click failed: ${result.error}` }] };

  return {
    content: [{ type: 'text' as const, text: `Clicked "${args.selector}" — now at ${result.url} "${result.title}"` }],
  };
}

// ── browser_fill ──

export const browserFillSchema = {
  selector: z.string().describe('Playwright selector for the input/textarea to fill (e.g. "input[name=\'email\']", "#search-box", \'input:has-text("Search")\').'),
  value: z.string().describe('The text value to fill into the element. Clears existing content first.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserFillDescription =
  'Clear an input field and fill it with new text. Accepts Playwright selectors: CSS, text="...", :has-text("..."), [data-testid="..."]. Twitter/X: compose box is [data-testid="tweetTextarea_0"], search is [data-testid="SearchBox_Search_Input"].';

export async function handleBrowserFill(args: { selector: string; value: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.fill(resolved.sessionId, args.selector, args.value);
  if (result.error) return { content: [{ type: 'text' as const, text: `Fill failed: ${result.error}` }] };

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Filled "${args.selector}" with "${args.value.slice(0, 100)}"${location}` }],
  };
}

// ── browser_type ──

export const browserTypeSchema = {
  selector: z.string().optional().describe('Playwright selector for the element to type into. If omitted, types into the currently focused element using keyboard events.'),
  text: z.string().describe('The text to type character by character (appends to existing content).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserTypeDescription =
  'Type text character by character (simulates real keystrokes, appends to existing content). Provide a selector to target an element, or omit to type into whatever is currently focused. ' +
  'Prefer browser_type over browser_fill for contenteditable editors — both Twitter/X ([data-testid="tweetTextarea_0"]) and Facebook use them. ' +
  'Facebook post composer (after opening dialog): [role="dialog"] [role="textbox"]. ' +
  'Facebook comment boxes: [contenteditable][aria-label*="Comente como"] (PT), [contenteditable][aria-label*="Comment as"] (EN), [contenteditable][aria-label*="Yorum yap"] (TR).';

export async function handleBrowserType(args: { selector?: string; text: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.type(resolved.sessionId, args.selector ?? null, args.text);
  if (result.error) return { content: [{ type: 'text' as const, text: `Type failed: ${result.error}` }] };

  const target = args.selector ? `"${args.selector}"` : 'focused element';
  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Typed "${args.text.slice(0, 100)}" into ${target}${location}` }],
  };
}

// ── browser_hover ──

export const browserHoverSchema = {
  selector: z.string().describe('Playwright selector for the element to hover over (CSS, text="...", :has-text("...")).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserHoverDescription =
  'Hover over an element. Useful for revealing dropdowns, tooltips, or hover-triggered content. Accepts Playwright selectors.';

export async function handleBrowserHover(args: { selector: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.hover(resolved.sessionId, args.selector);
  if (result.error) return { content: [{ type: 'text' as const, text: `Hover failed: ${result.error}` }] };

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Hovered over "${args.selector}"${location}` }],
  };
}

// ── browser_select ──

export const browserSelectSchema = {
  selector: z.string().describe('Playwright selector for the <select> element.'),
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

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Selected "${args.value}" in "${args.selector}"${location}` }],
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

  const location = result.url ? ` — ${result.url} "${result.title}"` : '';
  return {
    content: [{ type: 'text' as const, text: `Pressed "${args.key}"${location}` }],
  };
}

// ── browser_scroll ──

export const browserScrollSchema = {
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Direction to scroll.'),
  distance: z.coerce.number().optional().describe('Pixels to scroll (default: 500).'),
  selector: z.string().optional().describe('Scroll within a specific element instead of the page. Twitter: [data-testid="primaryColumn"] for main feed. Facebook: [role="feed"] for group/page post feed.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserScrollDescription =
  'Scroll the page or a specific element. Essential for infinite scroll feeds. Twitter/X: direction "down" with distance 800–1500 to load more tweets. Facebook: use selector "[role=\\"feed\\"]" to scroll within the post feed.';

export async function handleBrowserScroll(args: { direction: string; distance?: number; selector?: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.scroll(resolved.sessionId, { direction: args.direction, distance: args.distance, selector: args.selector });
  if (result.error) return { content: [{ type: 'text' as const, text: `Scroll failed: ${result.error}` }] };

  const target = args.selector ? `"${args.selector}"` : 'page';
  return { content: [{ type: 'text' as const, text: `Scrolled ${args.direction} ${args.distance ?? 500}px in ${target} — now at ${result.url} "${result.title}"` }] };
}

// ── browser_upload ──

export const browserUploadSchema = {
  selector: z.string().describe('Playwright selector for the file input element. Twitter: \'input[data-testid="fileInput"]\'.'),
  filePaths: z.array(z.string()).describe('Absolute file paths to upload. Twitter supports up to 4 images or 1 video per tweet.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserUploadDescription =
  'Upload one or more files via a file input element. For Twitter/X: click the media button first to reveal the hidden file input, then use selector \'input[data-testid="fileInput"]\'.';

export async function handleBrowserUpload(args: { selector: string; filePaths: string[]; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.upload(resolved.sessionId, args.selector, args.filePaths);
  if (result.error) return { content: [{ type: 'text' as const, text: `Upload failed: ${result.error}` }] };

  return { content: [{ type: 'text' as const, text: `Uploaded ${args.filePaths.length} file(s) via "${args.selector}" — now at ${result.url} "${result.title}"` }] };
}
