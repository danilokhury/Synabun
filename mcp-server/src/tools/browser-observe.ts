import { z } from 'zod';
import * as ni from '../services/neural-interface.js';
import { getMemory } from '../services/sqlite.js';
import { cleanName, parseSeedQueue, regionForSeed, resolveClassification } from '../services/fb-regions.js';
import { text, image } from './response.js';

const tabIdField = z.string().optional().describe('Target a specific tab within the session. Auto-resolved from environment if omitted.');

// ── browser_snapshot ──

export const browserSnapshotSchema = {
  selector: z.string().optional().describe('Scope snapshot to a specific element\'s subtree. Dramatically reduces output on complex pages.'),
  mode: z.enum(['ai', 'full', 'interactive', 'landmarks']).optional().describe('"ai" (default) = compact YAML with [ref=eN] element refs — pass ref to browser_click/fill/type to act on elements. "interactive" = flat list of clickable elements with selector hints. "full" = legacy accessibility tree. "landmarks" = structural overview.'),
  depth: z.coerce.number().int().positive().optional().describe('Limit tree depth (mode="ai" only). Use 10-14 on deep feed pages to shrink output.'),
  diff: z.coerce.boolean().optional().describe('Return only the changed region vs your previous snapshot of this tab (mode="ai" only).'),
  force: z.coerce.boolean().optional().describe('Return the full snapshot even if the page is unchanged since your last snapshot.'),
  viewport: z.coerce.boolean().optional().describe('Drop off-screen nodes (legacy modes only; ignored for mode="ai" — use depth/selector instead).'),
  maxChars: z.coerce.number().int().positive().optional().describe('Cap output length in characters (default 30000).'),
  format: z.enum(['text', 'json']).optional().describe('Only meaningful with mode="interactive": "json" = compact array.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserSnapshotDescription =
  'Token-efficient page "view". Default (mode="ai") returns a compact YAML tree where elements carry refs like [ref=e12] — act on them by passing ref:"e12" to browser_click/browser_fill/browser_type (exact, no selector guessing). Refs stay valid until the page changes or you re-snapshot. Identical repeat snapshots return "(unchanged)". Scope with selector or limit with depth on heavy pages.';

// Format the server's mode="ai" snapshot payload (snapshotText/unchanged/diff fields)
// into the message body. Shared by snapshot, navigate, click, scroll.
export function formatAiSnapshotBody(
  result: Record<string, unknown>,
  maxChars: number
): string {
  if (result.snapshotError) return `(snapshot failed: ${result.snapshotError})`;
  if (result.unchanged) return '(page unchanged since last snapshot — previous refs remain valid)';
  let body = (result.snapshotText as string) || '(empty page)';
  if (result.snapshotIsDiff) {
    const pre = result.diffPrefixLines as number | undefined;
    const suf = result.diffSuffixLines as number | undefined;
    const ctx = (pre || suf) ? ` (${pre ?? 0} unchanged lines before, ${suf ?? 0} after)` : '';
    body = `--- Snapshot diff: only the changed region${ctx}; previous refs outside it remain valid ---\n${body}`;
  }
  if (body.length > maxChars) {
    body = body.slice(0, maxChars) + '\n... (truncated — pass selector or depth to narrow, or raise maxChars)';
  }
  if (result.aiDepth) {
    body += `\n(depth-limited to ${result.aiDepth} levels to fit the size budget — pass selector to scope deeper, or depth/maxChars to override)`;
  }
  return body;
}

// Roles that are pure structural containers with no semantic value when unnamed
const NOISE_ROLES = new Set(['none', 'presentation', 'generic']);
const MAX_DEPTH = 20;

function formatSnapshotNode(node: Record<string, unknown>, indent = 0): string {
  if (!node || indent > MAX_DEPTH) return '';

  const role = (node.role as string) || 'generic';
  const children = node.children as Record<string, unknown>[] | undefined;
  const hasChildren = children && children.length > 0;

  // Skip pure noise nodes: unnamed container roles with no value and no children
  if (NOISE_ROLES.has(role) && !node.name && !node.value && !hasChildren) {
    return '';
  }

  const prefix = '  '.repeat(indent);
  const name = node.name ? ` "${node.name}"` : '';
  const value = node.value ? ` value="${node.value}"` : '';
  const desc = node.description ? ` (${node.description})` : '';
  const checked = node.checked !== undefined ? ` [${node.checked ? 'checked' : 'unchecked'}]` : '';
  const selected = node.selected ? ' [selected]' : '';
  const expanded = node.expanded !== undefined ? ` [${node.expanded ? 'expanded' : 'collapsed'}]` : '';
  const disabled = node.disabled ? ' [disabled]' : '';
  const focused = node.focused ? ' [focused]' : '';

  let line = `${prefix}${role}${name}${value}${desc}${checked}${selected}${expanded}${disabled}${focused}`;

  if (hasChildren) {
    const childLines = children
      .map(c => formatSnapshotNode(c, indent + 1))
      .filter(s => s.length > 0)
      .join('\n');
    if (childLines) line += '\n' + childLines;
  }

  return line;
}

type SnapshotMode = 'full' | 'interactive' | 'landmarks';
type SnapshotFormat = 'text' | 'json';

// Roles considered "interactive" for mode=interactive filtering.
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'combobox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'radio', 'slider', 'switch', 'searchbox', 'spinbutton', 'option',
]);

// Roles considered "landmarks" for mode=landmarks filtering.
const LANDMARK_ROLES = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form',
  'search', 'heading',
]);

function filterTree(
  node: Record<string, unknown>,
  mode: SnapshotMode,
  keep: (role: string) => boolean,
): Record<string, unknown> | null {
  if (!node) return null;
  const role = (node.role as string) || 'generic';
  const children = (node.children as Record<string, unknown>[] | undefined) || [];

  const keptChildren = children
    .map(c => filterTree(c, mode, keep))
    .filter((c): c is Record<string, unknown> => c !== null);

  if (keep(role)) return { ...node, children: keptChildren };
  // Hoist kept descendants through uninteresting parents
  if (keptChildren.length > 0) return { role: 'generic', name: '', children: keptChildren };
  return null;
}

// Exported so navigate/click/scroll can format an attached returnSnapshot consistently.
export function formatInlineSnapshot(
  result: Record<string, unknown>,
  opts: { mode?: SnapshotMode; format?: SnapshotFormat; maxChars?: number } = {}
): string {
  const mode: SnapshotMode = opts.mode || (result.mode as SnapshotMode) || 'full';
  const format: SnapshotFormat = opts.format || 'text';
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : 12000;

  if (mode === 'interactive') {
    const flat = (result.interactive as Array<Record<string, unknown>> | undefined) || [];
    if (format === 'json') {
      const body = JSON.stringify(flat);
      return body.length > maxChars ? body.slice(0, maxChars) + '\n... (truncated)' : body;
    }
    const lines = flat.map(h => {
      const role = h.role || 'generic';
      const label = h.ariaLabel || h.text || h.placeholder || '(unnamed)';
      const sel = h.selector ? ` → ${h.selector}${h.nth !== undefined ? ` [nth:${h.nth}]` : ''}` : '';
      return `- ${role}: "${String(label).slice(0, 60)}"${sel}`;
    });
    const body = lines.join('\n');
    return body.length > maxChars ? body.slice(0, maxChars) + '\n... (truncated)' : body;
  }

  const tree = result.snapshot as Record<string, unknown> | null | undefined;
  let working: Record<string, unknown> | null | undefined = tree;
  if (tree && mode === 'landmarks') {
    working = filterTree(tree, 'landmarks', r => LANDMARK_ROLES.has(r));
  }
  const formatted = working ? formatSnapshotNode(working) : '(empty page)';
  return formatted.length > maxChars ? formatted.slice(0, maxChars) + '\n... (truncated)' : formatted;
}

function flattenInteractive(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const role = (node.role as string) || '';
  if (INTERACTIVE_ROLES.has(role)) {
    const entry: Record<string, unknown> = { role, name: node.name || '' };
    if (node.value) entry.value = node.value;
    if (node.description) entry.description = node.description;
    if (node.checked !== undefined) entry.checked = node.checked;
    if (node.selected) entry.selected = true;
    if (node.disabled) entry.disabled = true;
    out.push(entry);
  }
  const children = (node.children as Record<string, unknown>[] | undefined) || [];
  for (const c of children) out.push(...flattenInteractive(c));
  return out;
}

export async function handleBrowserSnapshot(args: {
  selector?: string;
  mode?: 'ai' | SnapshotMode;
  depth?: number;
  diff?: boolean;
  force?: boolean;
  viewport?: boolean;
  maxChars?: number;
  format?: SnapshotFormat;
  sessionId?: string;
  tabId?: string;
}) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const mode = args.mode || 'ai';
  const format: SnapshotFormat = args.format || 'text';
  const maxChars = args.maxChars && args.maxChars > 0 ? args.maxChars : 30000;

  const result = await ni.snapshot(resolved.sessionId, args.selector, resolved.tabId, {
    mode,
    viewport: args.viewport,
    depth: args.depth,
    diff: args.diff,
    force: args.force,
    ...(mode === 'ai' && { maxChars }),
  });
  if (result.error) return text(`Snapshot failed: ${result.error}`);

  if (mode === 'ai') {
    let msg = `Page: ${result.url}\nTitle: "${result.title}"\n`;
    if (args.selector) msg += `Scope: ${args.selector}\n`;
    msg += '\n' + formatAiSnapshotBody(result, maxChars);
    return text(msg);
  }

  const tree = result.snapshot as Record<string, unknown> | null;

  // mode=interactive with format=json uses the server-provided flat list if present,
  // otherwise derives it from the tree.
  if (mode === 'interactive' && format === 'json') {
    const flat = (result.interactive as Array<Record<string, unknown>> | undefined)
      || (tree ? flattenInteractive(tree) : []);
    const body = JSON.stringify(flat);
    let msg = `Page: ${result.url}\nTitle: "${result.title}"\nMode: interactive (json)\nCount: ${flat.length}\n\n${body}`;
    if (msg.length > maxChars) msg = msg.slice(0, maxChars) + '\n... (truncated — lower maxChars or use selector)';
    return text(msg);
  }

  // mode=interactive with format=text: the server returns a flat `interactive` list
  // (snapshot tree is null) — render it as one line per element with selector hints.
  if (mode === 'interactive' && !tree && Array.isArray(result.interactive)) {
    const flat = result.interactive as Array<Record<string, unknown>>;
    const lines = flat.map(h => {
      const label = h.ariaLabel || h.text || h.placeholder || '(unnamed)';
      const sel = h.selector ? ` → ${h.selector}${h.nth !== undefined ? ` [nth:${h.nth}]` : ''}` : '';
      return `- ${h.role || 'generic'}: "${String(label).slice(0, 60)}"${sel}`;
    });
    let msg = `Page: ${result.url}\nTitle: "${result.title}"\nMode: interactive\nCount: ${flat.length}\n\n${lines.join('\n') || '(no interactive elements)'}`;
    if (msg.length > maxChars) msg = msg.slice(0, maxChars) + '\n... (truncated — lower maxChars or use selector)';
    return text(msg);
  }

  let working: Record<string, unknown> | null = tree;
  if (tree && mode === 'interactive') {
    working = filterTree(tree, 'interactive', r => INTERACTIVE_ROLES.has(r));
  } else if (tree && mode === 'landmarks') {
    working = filterTree(tree, 'landmarks', r => LANDMARK_ROLES.has(r));
  }

  const formatted = working ? formatSnapshotNode(working) : '(empty page)';

  let msg = `Page: ${result.url}\nTitle: "${result.title}"\n`;
  if (args.selector) msg += `Scope: ${args.selector}\n`;
  if (mode !== 'full') msg += `Mode: ${mode}\n`;
  if (args.viewport) msg += `Viewport-filtered\n`;
  msg += '\n' + formatted;

  if (msg.length > maxChars) {
    msg = msg.slice(0, maxChars) + '\n... (truncated — narrow scope, lower maxChars, or use mode="interactive")';
  }

  return text(msg);
}

// ── browser_content ──

export const browserContentSchema = {
  format: z.enum(['text', 'markdown']).optional().default('text').describe(
    'Output format. "text" = raw innerText. "markdown" = clean markdown (headings/links/lists, nav/footer/ads stripped) — better for LLM consumption.'
  ),
  maxChars: z.coerce.number().int().positive().optional().describe('Max characters returned (default 20000). Response notes total size when truncated.'),
  offset: z.coerce.number().int().nonnegative().optional().describe('Character offset to continue a previously truncated read.'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserContentDescription =
  'Get the content of the current page. Set format="markdown" for clean markdown with structure preserved — preferred for LLM consumption. Returns up to maxChars (default 20000); pass offset to page through long pages.';

const DEFAULT_CONTENT_MAX_CHARS = 20000;

export async function handleBrowserContent(args: { format?: string; maxChars?: number; offset?: number; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const pageOpts = {
    maxChars: args.maxChars && args.maxChars > 0 ? args.maxChars : DEFAULT_CONTENT_MAX_CHARS,
    offset: args.offset && args.offset > 0 ? args.offset : undefined,
  };

  if (args.format === 'markdown') {
    const result = await ni.getMarkdown(resolved.sessionId, resolved.tabId, pageOpts);
    if (result.error) return text(`Markdown extraction failed: ${result.error}`);

    let msg = `URL: ${result.url}\nTitle: "${result.title}"\nTokens: ~${result.tokens}\n\n`;
    msg += (result.markdown as string) || '(empty page)';
    return text(msg);
  }

  // Default: plain text
  const result = await ni.getContent(resolved.sessionId, resolved.tabId, pageOpts);
  if (result.error) return text(`Content failed: ${result.error}`);

  let msg = `URL: ${result.url}\nTitle: "${result.title}"\n\n`;
  msg += (result.text as string) || '(empty page)';

  return text(msg);
}

// ── browser_screenshot ──

export const browserScreenshotSchema = {
  maxWidth: z.coerce.number().int().positive().optional().describe('Downscale to this width in px (default 1024). Pass 0 for native resolution.'),
  quality: z.coerce.number().int().min(10).max(100).optional().describe('JPEG quality 10-100 (default 60).'),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserScreenshotDescription =
  'Take a screenshot of the current page (JPEG, downscaled to 1024px wide by default). Use sparingly — prefer browser_snapshot as it is far more token-efficient.';

export async function handleBrowserScreenshot(args: { maxWidth?: number; quality?: number; sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.screenshot(resolved.sessionId, resolved.tabId, {
    maxWidth: args.maxWidth,
    quality: args.quality,
  });
  if (result.error) return text(`Screenshot failed: ${result.error}`);

  return {
    content: [
      ...text(`Screenshot of ${result.url} — "${result.title}"`).content,
      ...image(result.data as string, 'image/jpeg').content,
    ],
  };
}

// ── Paged extraction (scroll → extract → merge → dedupe in ONE tool call) ──
// MCP↔NI round trips are localhost HTTP and cost zero tokens; what costs tokens is
// model round trips. These params collapse a manual scroll/extract loop into one call.

const pagedExtractorFields = {
  scrolls: z.coerce.number().int().min(0).max(10).optional().describe('Auto-scroll up to N times, extracting + deduping after each (default 0 = current view only). Stops early at minItems or end of feed.'),
  minItems: z.coerce.number().int().positive().optional().describe('Stop scrolling once this many unique items are collected.'),
  maxItems: z.coerce.number().int().positive().optional().describe('Cap on returned items (default 50).'),
};

interface PagedArgs { scrolls?: number; minItems?: number; maxItems?: number }

interface PagedOpts extends PagedArgs {
  dedupeKeys: string[];       // first non-null field is the item identity
  scrollTarget?: string;      // JS expression resolving the scroll container (default: window)
  scrollDistance?: number;    // default 1200
  scrollDirection?: 1 | -1;   // -1 scrolls up (e.g. WhatsApp message history)
  settleMs?: number;          // default 900
  scrollIfEmpty?: boolean;    // grant one scroll round when the first extraction is empty
}

interface PagedResult {
  items: Array<Record<string, unknown>>;
  raw: number;
  scrollsUsed: number;
  truncated: boolean;
}

async function runPagedExtractor(
  sessionId: string,
  tabId: string | undefined,
  script: string,
  opts: PagedOpts
): Promise<PagedResult | { error: string }> {
  const scrolls = Math.min(Math.max(opts.scrolls ?? 0, 0), 10);
  const maxItems = opts.maxItems && opts.maxItems > 0 ? opts.maxItems : 50;
  const distance = (opts.scrollDistance ?? 1200) * (opts.scrollDirection ?? 1);
  const settleMs = opts.settleMs ?? 900;

  const itemKey = (item: Record<string, unknown>): string => {
    for (const k of opts.dedupeKeys) {
      const v = item[k];
      if (v) return `${k}:${v}`;
    }
    return JSON.stringify(item);
  };

  const collected = new Map<string, Record<string, unknown>>();
  let raw = 0;
  let scrollsUsed = 0;
  let dryRounds = 0;
  let bonusRounds = 0;

  for (let round = 0; ; round++) {
    const result = await ni.evaluate(sessionId, script, tabId);
    if (result.error) {
      if (collected.size > 0) break; // keep what we already harvested
      return { error: result.error };
    }
    const items = Array.isArray(result.result) ? (result.result as Array<Record<string, unknown>>) : [];
    raw += items.length;
    const before = collected.size;
    for (const item of items) {
      const key = itemKey(item);
      if (!collected.has(key)) collected.set(key, item);
    }
    if (opts.minItems && collected.size >= opts.minItems) break;
    if (collected.size >= maxItems) break;
    // Some feeds (Facebook groups/Pages) virtualize content in only after a scroll, so
    // a fresh page can extract empty. Grant one bonus scroll round in that case.
    if (opts.scrollIfEmpty && round === 0 && collected.size === 0) bonusRounds = 1;
    if (round >= scrolls + bonusRounds) break;
    dryRounds = collected.size > before ? 0 : dryRounds + 1;
    if (dryRounds >= 2) break; // end of feed: two consecutive extractions added nothing
    const scrollExpr = opts.scrollTarget
      ? `(() => { const el = ${opts.scrollTarget}; if (el) el.scrollBy(0, ${distance}); return true; })()`
      : `window.scrollBy(0, ${distance}); true`;
    await ni.evaluate(sessionId, scrollExpr, tabId);
    scrollsUsed++;
    // Jitter the settle so the scroll cadence is not a fixed, fingerprintable
    // interval (~0.8x–1.5x of base). Floor keeps slow feeds readable.
    const jittered = Math.round(settleMs * (0.8 + Math.random() * 0.7));
    await new Promise(r => setTimeout(r, Math.max(250, jittered)));
  }

  const all = [...collected.values()];
  const truncated = all.length > maxItems;
  return { items: truncated ? all.slice(0, maxItems) : all, raw, scrollsUsed, truncated };
}

// Compact single-line JSON: pretty-printing buys a model nothing and costs ~25-35%.
function formatExtraction(noun: string, res: PagedResult): string {
  const extras: string[] = [];
  if (res.raw > res.items.length) extras.push(`deduped from ${res.raw} raw`);
  if (res.scrollsUsed > 0) extras.push(`${res.scrollsUsed} scroll(s)`);
  let msg = `${res.items.length} ${noun}(s)${extras.length ? ` (${extras.join(', ')})` : ''}:\n\n${JSON.stringify(res.items)}`;
  if (res.truncated) msg += '\n\n(capped at maxItems — re-run with scrolls to continue; the page keeps its scroll position)';
  return msg;
}

// Finds the nearest scrollable ancestor of a node — used for panes without stable
// container selectors (WhatsApp message history).
const SCROLLABLE_ANCESTOR = (innerSelector: string) =>
  `(() => { let el = document.querySelector('${innerSelector}'); while (el && el.scrollHeight <= el.clientHeight + 10) el = el.parentElement; return el; })()`;

// ── browser_extract_tweets ──

const TWEET_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[data-testid="tweet"]')).map(el => {
  const userNameEl = el.querySelector('[data-testid="User-Name"]');
  const lines = userNameEl ? userNameEl.innerText.split('\\n').filter(Boolean) : [];
  const statusLink = el.querySelector('a[href*="/status/"]');
  return {
    author:  lines[0] || null,
    handle:  lines.find(l => l.startsWith('@')) || null,
    text:    el.querySelector('[data-testid="tweetText"]')?.innerText || null,
    time:    el.querySelector('time')?.getAttribute('datetime') || null,
    url:     statusLink ? statusLink.href : null,
    replies: el.querySelector('[data-testid="reply"] span[data-testid="app-text-transition-container"]')?.innerText || null,
    reposts: el.querySelector('[data-testid="retweet"] span[data-testid="app-text-transition-container"]')?.innerText || null,
    likes:   el.querySelector('[data-testid="like"] span[data-testid="app-text-transition-container"]')?.innerText || null,
    views:   el.querySelector('a[href*="/analytics"] span')?.innerText || null,
  };
})
`.trim();

export const browserExtractTweetsSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractTweetsDescription =
  'Extract visible tweets as structured JSON (author, handle, text, time, url, replies, reposts, likes, views). Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call (e.g. scrolls:3 minItems:30). Much faster than browser_snapshot for data harvesting. Navigate to x.com/search?q=%23hashtag&f=live first for latest-first hashtag results.';

export async function handleBrowserExtractTweets(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, TWEET_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['url'],
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) return text('No tweets found. Try browser_scroll (or pass scrolls:2) then retry.');

  return text(formatExtraction('tweet', res));
}

// ── browser_x_compose_state ──
// Read-only structured read of the X composer so a loop branches on fields instead of
// eyeballing a screenshot. The detection script + the loop publish gate that shares it
// live server-side (neural-interface/server.js); this tool just forwards to that endpoint.

export const browserXComposeStateSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserXComposeStateDescription =
  'Inspect the X/Twitter compose surface in ONE call (read-only). Returns: composerOpen, composerText (read back from [data-testid="tweetTextarea_0"]), charCount, overLimit; ' +
  'quoteCard {present, type:"quote"|"link"|"none", author, handle, text, url} — type "quote" means a real embedded quoted-tweet card rendered (safe to post a quote), "link" means only a plain link-preview card (posting would publish a bare reply — do NOT post; fix the status URL or skip the target), "none" means nothing embedded; ' +
  'submitButton {testid:"tweetButtonInline"|"tweetButton", present, enabled, selector} (tweetButtonInline for inline replies, tweetButton for the compose dialog); ' +
  'isModal (the glitchy centered reply dialog is open — close it and retry inline), composerCount (>1 ⇒ pass nthMatch to disambiguate the two reply textareas), hasStaleDraft (duplicated/garbled leftover text — discard and reopen), warnings[]; and ' +
  'recommendedAction {submit|type|open-composer|fix-quote-url|trim-text|unknown} — the deterministic next step. ' +
  'QUOTE flow: navigate x.com/compose/tweet, browser_type the full status URL, call this probe, post via submitButton.selector ONLY if quoteCard.type==="quote". ' +
  'REPLY flow: click the reply icon, call this probe, if isModal close it and retry inline, type, post via submitButton.selector. ' +
  'After submitting, re-call this probe (composer should have cleared) and confirm with browser_extract_tweets on the author profile /with_replies (a NEW, higher status id = published). ' +
  'On loop tabs a server-side gate ALSO blocks a tweetButton click when a status URL is in the body but quoteCard.type!=="quote" (response carries quoteGuard) — so a quote can never silently misfire into a bare reply. Read-only — never types or clicks.';

export async function handleBrowserXComposeState(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.xComposeState(resolved.sessionId, resolved.tabId);
  if (result.error) return text(`X compose state probe failed: ${result.error}`);

  return text(JSON.stringify(result.result));
}

// ── browser_extract_fb_posts ──

const FB_POST_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[role="article"]')).map(el => {
  const h2Link = el.querySelector('h2 a, h3 a, h4 a, strong a');
  const timeLink = el.querySelector('a[href*="?__cft__"], a[href*="/posts/"], a[href*="/permalink/"]');
  const abbr = el.querySelector('abbr[title], abbr[data-utime]');
  const textEl = el.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"]');
  const reactEl = el.querySelector('[aria-label*="reaction"], [aria-label*="reação"], [aria-label*="tepki"]');
  return {
    author: h2Link ? h2Link.textContent.trim() : null,
    authorUrl: h2Link ? h2Link.href : null,
    text: textEl ? textEl.innerText.trim() : (el.querySelector('[dir="auto"]')?.innerText?.trim() || null),
    time: abbr ? (abbr.getAttribute('title') || abbr.textContent.trim()) : (timeLink ? timeLink.textContent.trim() : null),
    postUrl: timeLink ? timeLink.href : null,
    reactions: reactEl ? reactEl.getAttribute('aria-label') : null,
  };
}).filter(p => p.author || p.text)
`.trim();

export const browserExtractFbPostsSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractFbPostsDescription =
  'Extract visible Facebook posts as structured JSON (author, authorUrl, text, time, postUrl, reactions). ' +
  'Works on group feeds and Pages. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. ' +
  'Much faster than browser_snapshot for data harvesting from Facebook.';

export async function handleBrowserExtractFbPosts(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, FB_POST_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['postUrl'], scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No posts found even after an auto-scroll. The feed may still be loading — retry with scrolls:3.');
  }

  return text(formatExtraction('post', res));
}

// ── browser_fb_composer_state ──

// Single locale-tolerant probe that replaces the ad-hoc inline browser_evaluate recon
// every Facebook posting loop used to re-send each iteration. Returns modal state, the
// real (non-search/non-stale) composer candidates scoped to inline vs dialog, the submit
// button scoped to the active composer, and a coarse submission state for verification.
// Prefers role + aria + visibility over translated UI strings (account UI may be PT even
// inside EN/FR/ES groups). Read-only: it inspects, it never types or clicks.
const FB_COMPOSER_STATE_SCRIPT = `
(() => {
  // Submit-button labels. PT-BR group composer uses "Postar" (NOT "Publicar"); German
  // approval groups use "Senden"/"Veröffentlichen"/"Zur Genehmigung senden" — those gaps are
  // why the probe used to return submitButton:null and the agent stalled on the modal.
  const PUB = ['publicar','postar','post','paylaş','publier','posten','pubblica','opublikuj','publiceren','plaatsen','veröffentlichen','senden','an gruppe senden','zur genehmigung senden','zur bestätigung senden'];
  // Buttons that may CONTAIN a publish token but are NOT the submit action ("Add to your
  // post" / "Zu deinem Beitrag hinzufügen" / "Report post"). Used to guard substring matching.
  // Includes paid-promotion verbs (boost/turbinar/impulsionar/promote) so the submit
  // detection + footer-button heuristic can NEVER select Facebook's "Boost post" /
  // "Turbinar publicação" button as the post action. SynaBun posts organically only.
  const NOT_SUBMIT = ['add to','adicionar','zu deinem','hinzufügen','ajouter','añadir','your post','seu post','tu publicación','report','denunciar','signaler','melden','share','compartil','teilen','foto','photo','vídeo','video','emoji','gif','sticker','boost','turbinar','impulsionar','promote','promover','promocionar','promouvoir','anuncie','advertise','bewerben'];
  const PERSONAL = ["what's on your mind","no que você está pensando","qué estás pensando","à quoi pensez-vous","woran denkst du","a cosa stai pensando"];
  const COMMENT = ['comente como','comment as','yorum yap','commenter en tant','kommentieren als','comenta como','escreva um comentário','write a comment'];
  // Create-post trigger phrases (the div[role=button] you click to OPEN the composer dialog).
  const TRIGGER = ['escreva algo','write something','no que você está pensando',"what's on your mind",'bir şeyler yaz','exprime-toi','écrivez quelque chose','schreib etwas','escribe algo','crie um post','crie uma publicação','criar publicação','comece uma publicação','publique algo'];
  const PENDING = ['pending approval','will be reviewed','aguardando aprovação','será revisado','en attente d','zur überprüfung','pendiente de aprobación','in attesa di approvazione'];
  const FAILED = ['something went wrong','algo deu errado','tente novamente','try again','unable to post','não foi possível publicar','une erreur s','etwas ist sch'];
  const CREATE_HEADING = ['create post','criar publicação','criar post','créer une publication','beitrag erstellen','crear publicación','crea post'];
  const lc = s => (s || '').toLowerCase();
  // Visible = has real box AND not hidden. Guards against FB's permanent 0x0 hidden dialogs
  // (e.g. the always-present Notifications [role="dialog"]) faking modal.open.
  const visEl = el => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 8 && r.height > 8 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.getAttribute('aria-hidden') !== 'true'; };
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 20 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; };

  // Pick the POSTING dialog: visible only, prefer one that contains a composer or whose
  // heading is a create-post heading. Never select hidden/notifications/menu dialogs.
  const allDialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visEl);
  const scoreDialog = d => {
    const heading = lc(d.querySelector('h2, [role="heading"]')?.innerText || '');
    const hasComposer = !!d.querySelector('[role="textbox"], [contenteditable="true"]');
    const isCreate = CREATE_HEADING.some(h => heading.includes(h));
    return (hasComposer ? 2 : 0) + (isCreate ? 1 : 0);
  };
  const dialog = allDialogs.slice().sort((a, b) => scoreDialog(b) - scoreDialog(a)).find(d => scoreDialog(d) > 0) || null;
  const modal = {
    open: !!dialog,
    title: dialog ? lc(dialog.querySelector('h2, [role="heading"]')?.innerText || '').slice(0, 80) : null,
    closeSelector: dialog ? '[role="dialog"] [aria-label="Close"], [role="dialog"] [aria-label="Fechar"], [role="dialog"] [aria-label="Fermer"], [role="dialog"] [aria-label="Cerrar"], [role="dialog"] [aria-label="Schließen"]' : null,
    containsComposer: dialog ? !!dialog.querySelector('[role="textbox"], [contenteditable="true"]') : false
  };

  const boxes = [...document.querySelectorAll('[role="textbox"], div[contenteditable="true"]')];
  let composers = boxes.map((el, index) => {
    const r = el.getBoundingClientRect();
    const inDialog = !!el.closest('[role="dialog"], [aria-modal="true"]');
    const label = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '';
    const text = (el.innerText || '').slice(0, 120);
    const ctx = lc(label + ' ' + placeholder + ' ' + text);
    const isSearch = ctx.includes('search') || ctx.includes('pesquis') || ctx.includes('buscar') || ctx.includes('recherch');
    const isComment = COMMENT.some(p => ctx.includes(p));
    return {
      index, scope: inDialog ? 'dialog' : 'inline', inDialog,
      visible: vis(el),
      isSearch, isComment,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      text, ariaLabel: label, placeholder,
      isPersonalProfile: PERSONAL.some(p => ctx.includes(p)),
      // A comment box is NOT a post composer; never type a post into it.
      isPostComposer: !isSearch && !isComment && !PERSONAL.some(p => ctx.includes(p)),
      suggestedSelector: inDialog ? '[role="dialog"] [role="textbox"]' : '[role="main"] [role="textbox"]'
    };
  }).filter(c => !c.isSearch);

  // Create-post TRIGGER (the button to OPEN the composer). Reported so a loop on a bare
  // feed knows what to click first — the probe can only see textboxes that already exist.
  const triggerEl = [...document.querySelectorAll('[role="main"] [role="button"], [role="main"] div[role="button"]')]
    .find(b => { const t = lc(b.innerText); return TRIGGER.some(p => t.includes(p)) && vis(b) && !b.closest('[role="article"]'); });
  const trigger = triggerEl ? {
    found: true,
    text: (triggerEl.innerText || '').trim().slice(0, 60),
    suggestedSelector: '[role="main"] div[role="button"]:has-text("' + (TRIGGER.find(p => lc(triggerEl.innerText).includes(p)) || '') + '")'
  } : { found: false, text: null, suggestedSelector: null };

  // Submit button scoped to the chosen VISIBLE posting dialog (fall back to main feed composer).
  // Detection honors this script's design intent (role+aria+geometry over translated strings):
  // a locale/approval-tolerant label match first, then a conservative structural footer-button
  // fallback so an untranslated label can never strand the agent with submitButton:null again.
  const root = dialog || document.querySelector('[role="main"]') || document.body;
  const labelOf = b => (b.innerText || b.getAttribute('aria-label') || '').trim();
  const enabledOf = b => b.getAttribute('aria-disabled') !== 'true' && !b.disabled;
  const wc = s => s ? s.trim().split(/\\s+/).length : 0;
  const isSubmitLabel = raw => {
    const t = lc(raw).trim();
    if (!t || wc(t) > 5) return false;                 // submit labels are short
    if (NOT_SUBMIT.some(n => t.includes(n))) return false;
    return PUB.some(p => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
  };
  const btns = [...root.querySelectorAll('[role="button"], button')].filter(vis);
  let submitEl = btns.find(b => isSubmitLabel(labelOf(b)));
  let matchType = submitEl ? 'label' : null;
  // Structural fallback: only inside a real posting dialog (never the bare feed). FB's Post
  // button is a near-full-width control in the dialog footer; pick the last such candidate
  // that is not the Close button or a toolbar item. Flagged heuristic so callers can verify.
  if (!submitEl && dialog) {
    const dr = dialog.getBoundingClientRect();
    const cands = btns.filter(b => {
      const r = b.getBoundingClientRect();
      const t = lc(labelOf(b));
      return labelOf(b) && wc(t) <= 5 && !NOT_SUBMIT.some(n => t.includes(n))
        && !/close|fechar|fermer|cerrar|schließen|kapat|chiudi|sluiten/.test(t)
        && r.width >= dr.width * 0.5 && r.top >= dr.top + dr.height * 0.45;
    });
    if (cands.length) { submitEl = cands[cands.length - 1]; matchType = 'heuristic'; }
  }
  const submitButton = submitEl ? {
    label: labelOf(submitEl),
    scope: dialog ? 'dialog' : 'inline',
    matchType,
    selector: (dialog ? '[role="dialog"] ' : '[role="main"] ') + '[role="button"]:has-text("' + labelOf(submitEl) + '")',
    enabled: enabledOf(submitEl)
  } : null;

  const bodyText = lc(document.body.innerText).slice(0, 6000);
  let state = 'unknown', evidence = '';
  const pendingHit = PENDING.find(p => bodyText.includes(p));
  const failedHit = FAILED.find(p => bodyText.includes(p));
  if (pendingHit) { state = 'pending-approval'; evidence = pendingHit; }
  else if (failedHit) { state = 'posting-failed'; evidence = failedHit; }
  else if (modal.open && modal.containsComposer) { state = 'composer-open'; evidence = modal.title || 'dialog open'; }
  // No posting dialog, no composer focused, but a create-post trigger exists => idle feed,
  // safe to treat a subsequent successful submit (dialog gone, no error) as visible-post.
  else if (!modal.open && !composers.some(c => c.isPostComposer && c.visible)) {
    state = trigger.found ? 'visible-post' : 'unknown';
    evidence = trigger.found ? 'no composer open; create-post trigger present' : '';
  }

  // recommendedAction: a deterministic next step so a one-shot / resumed iteration knows what
  // to do without re-deriving it from prose (this drives the exec-loop RESUME CHECK preamble).
  const postBox = composers.find(c => c.isPostComposer && c.visible);
  let recommendedAction = 'unknown';
  if (state === 'pending-approval' || state === 'visible-post') recommendedAction = 'done';
  else if (state === 'posting-failed') recommendedAction = 'retry';
  else if (submitButton && submitButton.enabled && postBox && postBox.text.trim()) recommendedAction = 'submit';
  else if (postBox && !postBox.text.trim()) recommendedAction = 'type';
  else if (modal.open && submitButton && submitButton.enabled) recommendedAction = 'submit';
  else if (!modal.open && trigger.found) recommendedAction = 'open-composer';

  // Money-safety: detect Boost/Promote controls so the agent NEVER mistakes one for the
  // Post button. FB renders "Turbinar publicação" / "Boost post" beside Page posts (PT-BR
  // on this account) and a "Boost when published" toggle in the composer. SynaBun posts
  // organically only — surface these as a risk; they must never be clicked.
  const BOOST = ['boost','turbinar','impulsionar','promote','promover','promocionar','anuncie','advertise'];
  const boostEls = [...document.querySelectorAll('[role="button"], button, a[role="link"], a')]
    .filter(b => { const t = lc(b.innerText || b.getAttribute('aria-label') || ''); return t && BOOST.some(p => t.includes(p)) && visEl(b); });
  const boostToggle = [...document.querySelectorAll('[role="switch"], [role="checkbox"], input[type="checkbox"]')]
    .find(t => { const lab = lc((t.getAttribute('aria-label') || '') + ' ' + (t.closest('label')?.innerText || '') + ' ' + (t.parentElement?.innerText || '')); return BOOST.some(p => lab.includes(p)); });
  const boostRisk = {
    present: boostEls.length > 0 || !!boostToggle,
    controls: boostEls.slice(0, 4).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40)),
    boostWhenPublishedToggle: boostToggle ? { on: boostToggle.getAttribute('aria-checked') === 'true' || boostToggle.checked === true } : null,
    warning: (boostEls.length > 0 || !!boostToggle) ? 'PAID Boost/Promote control present — NEVER click it; submit ONLY via submitButton.selector. If a "Boost when published" toggle is ON, turn it OFF first. SynaBun posts organically only.' : null
  };

  return { modal, composers, trigger, submitButton, submission: { state, evidence }, recommendedAction, boostRisk };
})()
`.trim();

export const browserFbComposerStateSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserFbComposerStateDescription =
  'Inspect the Facebook posting surface in ONE call (read-only). Returns: modal {open,title,closeSelector,containsComposer} ' +
  '(modal.open is true ONLY for a visible posting dialog — FBs permanent hidden 0x0 Notifications dialog is ignored); ' +
  'trigger {found,text,suggestedSelector} — the Create-post button to CLICK first when no composer dialog is open yet (on a bare feed the probe can only see boxes that already exist, so use this to OPEN the composer; after opening, browser_type with NO selector into the auto-focused editor — selector-targeting the dialog editor is flaky); ' +
  'composers[] (search boxes filtered out) each with scope inline|dialog, inDialog, visible, rect, text, ariaLabel, placeholder, ' +
  'isPersonalProfile, isComment, isPostComposer (a comment box is flagged isComment and is NEVER a post composer — do not type a post into it), suggestedSelector; ' +
  'submitButton {label,scope,matchType,selector,enabled} scoped to the active visible dialog (matchType "label" = matched a publish/approval verb incl. German Senden/Veröffentlichen/Zur Genehmigung senden; "heuristic" = inferred as the dialog footer primary button when the label was untranslated, so verify via submission.state after clicking); ' +
  'submission {state: visible-post|pending-approval|posting-failed|composer-open|unknown, evidence}; and ' +
  'recommendedAction {submit|type|open-composer|done|retry|unknown} — the deterministic next step (submit = composer open with text AND an enabled submit button; use it to FINISH a half-typed post before starting anything new). ' +
  'Locale-tolerant (PT/EN/TR/FR/ES/DE incl. approval-flow groups). Flow: probe; if recommendedAction is "submit", click submitButton.selector and confirm FIRST; else if no composer dialog, click trigger.suggestedSelector; re-probe; type the full post into the auto-focused isPostComposer box with browser_type mode:"insert" (blank lines between paragraphs, link alone on the final line — insertText keeps the paragraphs and the isolated URL without firing Enter, so the typeahead cannot hijack it; do NOT use mode:"paragraphs" on the modal, its Escape closes the dialog); wait for submitButton.enabled; submit via submitButton.selector; confirm via submission.state. ' +
  'Modal-aware: the group Create-post dialog is a valid surface; reject only personal-profile/share dialogs. ' +
  'Also returns boostRisk {present, controls[], boostWhenPublishedToggle, warning}: if present, a PAID Boost/Promote/Turbinar control is on the page — NEVER click it and never submit via it (SynaBun posts organically only); submit ONLY via submitButton.selector and turn any "Boost when published" toggle OFF first.';

export async function handleBrowserFbComposerState(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, FB_COMPOSER_STATE_SCRIPT, resolved.tabId);
  if (result.error) return text(`Composer state probe failed: ${result.error}`);

  return text(JSON.stringify(result.result));
}

// ── browser_extract_fb_groups ──

// Scrape the JOINED-groups list from facebook.com/groups/joins/ so a posting/seeding loop
// gets a deterministic, region-sortable index in one call instead of eyeballing the rail.
// FB's joins page does NOT expose region, so the handler reconciles each group URL against
// the curated seed-queue memory (url | lang | currency) and falls back to a name lexicon.
const FB_GROUPS_EXTRACTOR_SCRIPT = `
(() => {
  const root = document.querySelector('[role="main"]') || document.body;
  const seen = new Set();
  const out = [];
  // /groups/<slug>/ links — exclude FB's own section routes (feed, joins, discover, ...).
  const SKIP = new Set(['feed','joins','discover','create','category','search','your_groups','requests','notifications']);
  const norm = h => { try { const u = new URL(h, location.origin); return (u.origin + u.pathname.replace(/\\/+$/, '') + '/'); } catch { return null; } };
  for (const a of root.querySelectorAll('a[href*="/groups/"]')) {
    const m = (a.getAttribute('href') || '').match(/\\/groups\\/([^/?#]+)\\/?/);
    if (!m) continue;
    const slug = m[1];
    if (SKIP.has(slug)) continue;
    const url = norm(a.href);
    if (!url || seen.has(url)) continue;
    // Name: prefer aria-label, then a strong/heading child, then link text (first line only).
    let name = (a.getAttribute('aria-label') || '').trim();
    if (!name) name = (a.querySelector('strong, span[dir="auto"], h2, h3')?.innerText || '').trim();
    if (!name) name = (a.innerText || '').trim().split('\\n')[0];
    if (!name) continue;
    // Subtitle (last-active / privacy / member count) from the surrounding card.
    const card = a.closest('[role="listitem"], li, div[class]') || a.parentElement;
    const sub = card ? (card.innerText || '').replace(name, '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
    seen.add(url);
    out.push({ name: name.slice(0, 120), url, subtitle: sub });
  }
  return out;
})()
`.trim();

// Region maps (REGION_BY_CURRENCY / REGION_BY_LANG / NAME_REGION), inferRegionFromName,
// normUrl, and parseSeedQueue now live in ../services/fb-regions.ts — shared with the
// fb_groups directory tool so the live extractor and the structured store stay in lockstep.

// Approximate member count from a localized joins-card subtitle ("Public group · 12K members").
function parseMembers(s?: string | null): number | null {
  if (!s) return null;
  const m = String(s).match(/([\d.,]+)\s*([kKmM])?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  const suf = (m[2] || '').toLowerCase();
  return Math.round(suf === 'k' ? n * 1e3 : suf === 'm' ? n * 1e6 : n);
}

export const browserExtractFbGroupsSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
  region: z.string().optional().describe('Optional case-insensitive filter: only return groups in this region bucket (UK, US, EU, Brazil, LatAm, Turkey, Australia, Canada, Unknown).'),
  seedQueueId: z.string().optional().describe('Optional memory id of a curated seed queue (url | lang | currency) used to reconcile region/currency.'),
};

export const browserExtractFbGroupsDescription =
  'Extract ALL JOINED Facebook groups from the current page (navigate to facebook.com/groups/joins/?ordering=viewer_added first) as a region-sorted index. ' +
  'Auto-scrolls the full virtualized joins list and dedupes by url in ONE call (defaults: scrolls:10, maxItems:1000 — override for very large/small lists). ' +
  'When seedQueueId is supplied, each group {name, url, subtitle, member_count, region, lang, currency, source} is reconciled against that memory first; other groups are classified from name+slug ' +
  '(language tokens: pt/tr/de/fr/es/pl/it/nl, and country aliases) into region + posting-currency, source:"name-heuristic"; the still-ambiguous ones land in region "Unknown" and under "unmatched". Spanish groups split into LatAm (USD) vs Spain (EUR). ' +
  'Returns { counts, byRegion: { UK:[...], US:[...], EU:[...], Brazil:[...], LatAm:[...], ... }, unmatched:[...] }. Pass region to filter to one bucket. ' +
  'Feed the whole JSON to fb_groups import {fromExtract} to populate/refresh the structured directory.';

export async function handleBrowserExtractFbGroups(args: PagedArgs & { sessionId?: string; tabId?: string; region?: string; seedQueueId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  // Full-scroll the virtualized joins list, accumulating + deduping by url. Defaults harvest the
  // whole list in one call; the caller can override scrolls/maxItems.
  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, FB_GROUPS_EXTRACTOR_SCRIPT, {
    scrolls: args.scrolls ?? 10,
    minItems: args.minItems,
    maxItems: args.maxItems ?? 1000,
    dedupeKeys: ['url'],
    scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  const groups = res.items as Array<{ name: string; url: string; subtitle: string }>;
  if (groups.length === 0) {
    return text('No joined groups found. Make sure you navigated to facebook.com/groups/joins/?ordering=viewer_added and the list rendered — browser_scroll down then retry.');
  }

  // Optionally reconcile with a curated seed-queue memory (url | lang | currency).
  let seedMap = new Map<string, { lang: string; currency: string }>();
  if (args.seedQueueId) {
    try {
      const mem = await getMemory(args.seedQueueId);
      if (mem?.payload?.content) seedMap = parseSeedQueue(mem.payload.content);
    } catch { /* seed queue is optional; fall back to name heuristics */ }
  }

  const tagged = groups.map(g => {
    const name = cleanName(g.name) || g.name;
    const member_count = parseMembers(g.subtitle);
    const seed = seedMap.get(g.url);
    if (seed) {
      // Curated seed currency/lang is authoritative; regionForSeed now resolves USD+es -> LatAm.
      return { ...g, name, member_count, region: regionForSeed(seed.lang, seed.currency), lang: seed.lang || null, currency: seed.currency || null, source: 'seed-queue' };
    }
    const r = resolveClassification({ name, url: g.url });
    return { ...g, name, member_count, region: r.region, lang: r.lang, currency: r.currency, source: 'name-heuristic' };
  });

  const filter = (args.region || '').trim().toLowerCase();
  const visible = filter ? tagged.filter(g => g.region.toLowerCase() === filter) : tagged;

  const byRegion: Record<string, typeof tagged> = {};
  for (const g of visible.slice().sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name))) {
    (byRegion[g.region] ||= []).push(g);
  }
  const unmatched = tagged.filter(g => g.source === 'name-heuristic').map(g => ({ name: g.name, url: g.url, region: g.region }));

  const payload = {
    counts: {
      total: tagged.length,
      shown: visible.length,
      inSeedQueue: tagged.filter(g => g.source === 'seed-queue').length,
      unmatched: unmatched.length,
      byRegion: Object.fromEntries(Object.entries(byRegion).map(([r, gs]) => [r, gs.length])),
    },
    byRegion,
    unmatched,
  };
  return text(JSON.stringify(payload));
}

// ── browser_extract_tiktok_videos ──

const TIKTOK_FEED_EXTRACTOR_SCRIPT = `
(() => {
  // Build a map of handle -> video metadata from global state (gives videoUrl, caption, music)
  const globalItems = window['__$UNIVERSAL_DATA$__']?.['__DEFAULT_SCOPE__']?.['webapp.updated-items'] || {};
  const stateMap = {};
  for (const key of Object.keys(globalItems)) {
    const item = globalItems[key];
    const h = item?.author?.uniqueId;
    if (h) stateMap[h] = { videoUrl: 'https://www.tiktok.com/@' + h + '/video/' + item.id, caption: item.desc || null, music: item.music?.title || null };
  }
  // Merge DOM counts (live) with state metadata
  return Array.from(document.querySelectorAll('article')).filter(el =>
    el.querySelector('[data-e2e="like-count"]')
  ).map(el => {
    const handle = el.querySelector('a[href^="/@"]')?.getAttribute('href')?.replace('/@','')?.split('?')[0] || null;
    const state = handle ? (stateMap[handle] || {}) : {};
    const likes = el.querySelector('[data-e2e="like-count"]')?.innerText?.trim() || null;
    const comments = el.querySelector('[data-e2e="comment-count"]')?.innerText?.trim() || null;
    const saves = el.querySelector('[data-e2e="undefined-count"]')?.innerText?.trim() || null;
    const shares = el.querySelector('[data-e2e="share-count"]')?.innerText?.trim() || null;
    const caption = state.caption || el.querySelector('[data-e2e="video-desc"]')?.innerText?.trim() || null;
    return { handle, videoUrl: state.videoUrl || null, caption, likes, comments, saves, shares, music: state.music || null };
  }).filter(v => v.handle);
})()
`.trim();

export const browserExtractTiktokVideosSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractTiktokVideosDescription =
  'Extract visible TikTok videos from the For You or Following feed as structured JSON ' +
  '(handle, videoUrl, caption, likes, comments, saves, shares, music). ' +
  'Navigate to tiktok.com/ or tiktok.com/following first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. ' +
  'Much faster than browser_snapshot for data harvesting from TikTok feeds.';

export async function handleBrowserExtractTiktokVideos(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, TIKTOK_FEED_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['videoUrl', 'handle'], scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No TikTok videos found. Make sure you are on tiktok.com/ or tiktok.com/following, then retry with scrolls:2.');
  }

  return text(formatExtraction('video', res));
}

// ── browser_extract_tiktok_search ──

const TIKTOK_SEARCH_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[data-e2e="search_top-item"]')).map(el => {
  const videoLink = el.querySelector('a[href*="/video/"]');
  const userLink = el.querySelector('[data-e2e="search-card-user-link"]');
  const caption = el.querySelector('[data-e2e="search-card-video-caption"]');
  const uniqueId = el.querySelector('[data-e2e="search-card-user-unique-id"]');
  const views = el.querySelector('[data-e2e="video-views"]');
  return {
    videoUrl: videoLink ? videoLink.href : null,
    handle: uniqueId ? uniqueId.innerText.trim() : null,
    profileUrl: userLink ? userLink.href : null,
    caption: caption ? caption.innerText.trim() : null,
    views: views ? views.innerText.trim() : null,
  };
}).filter(v => v.videoUrl)
`.trim();

export const browserExtractTiktokSearchSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractTiktokSearchDescription =
  'Extract visible TikTok search result videos as structured JSON ' +
  '(videoUrl, handle, profileUrl, caption, views). ' +
  'Navigate to tiktok.com/search?q=<query> first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. ' +
  'Much faster than browser_snapshot for harvesting TikTok search results.';

export async function handleBrowserExtractTiktokSearch(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, TIKTOK_SEARCH_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['videoUrl'], scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No search results found. Make sure you are on tiktok.com/search?q=... then retry.');
  }

  return text(formatExtraction('result', res));
}

// ── browser_extract_tiktok_studio ──

const TIKTOK_STUDIO_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[data-tt="components_PostInfoCell_a"]')).map(link => {
  const row = link.closest('[data-tt="components_RowLayout_FlexRow"]') ||
              link.closest('[data-tt="components_ItemRow_FlexRow"]') ||
              link.parentElement?.closest('[class*="FlexRow"]');
  const dateEl = row?.querySelector('[data-tt="components_PublishStageLabel_TUXText"]');
  const privacyBtn = row?.querySelector('[data-tt="components_PrivacyCell_TUXButton"]');
  const statEls = row ? Array.from(row.querySelectorAll('[data-tt="components_ItemRow_TUXText"]')) : [];
  const stats = statEls.map(el => el.innerText.trim()).filter(Boolean);
  return {
    title: link.innerText.trim(),
    url: link.href,
    date: dateEl ? dateEl.innerText.trim() : null,
    privacy: privacyBtn ? privacyBtn.innerText.trim() : null,
    stats,
  };
}).filter(p => p.title)
`.trim();

export const browserExtractTiktokStudioSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractTiktokStudioDescription =
  'Extract visible posts from TikTok Studio content list as structured JSON ' +
  '(title, url, date, privacy, stats[]). ' +
  'Navigate to tiktok.com/tiktokstudio/content first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. ' +
  'Use this to audit, manage, or bulk-read your published TikTok content.';

export async function handleBrowserExtractTiktokStudio(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, TIKTOK_STUDIO_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['url', 'title'],
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No Studio posts found. Make sure you are on tiktok.com/tiktokstudio/content then retry.');
  }

  return text(formatExtraction('post', res));
}

// ── browser_extract_tiktok_profile ──

const TIKTOK_PROFILE_EXTRACTOR_SCRIPT = `
(() => {
  const name = document.querySelector('[data-e2e="user-title"]')?.innerText?.trim() || null;
  const handle = document.querySelector('[data-e2e="user-subtitle"]')?.innerText?.trim() || null;
  const bio = document.querySelector('[data-e2e="user-bio"]')?.innerText?.trim() || null;
  const followers = document.querySelector('[data-e2e="followers-count"]')?.innerText?.trim() || null;
  const following = document.querySelector('[data-e2e="following-count"]')?.innerText?.trim() || null;
  const likes = document.querySelector('[data-e2e="likes-count"]')?.innerText?.trim() || null;
  const videoItems = Array.from(document.querySelectorAll('[data-e2e="user-post-item"]')).map(el => {
    const link = el.querySelector('a[href*="/video/"]');
    const views = el.querySelector('[data-e2e="video-views"]');
    return {
      videoUrl: link ? link.href : null,
      views: views ? views.innerText.trim() : null,
    };
  }).filter(v => v.videoUrl);
  return { name, handle, bio, followers, following, likes, videos: videoItems };
})()
`.trim();

export const browserExtractTiktokProfileSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractTiktokProfileDescription =
  'Extract profile info and video grid from a TikTok profile page as structured JSON ' +
  '(name, handle, bio, followers, following, likes, videos[{videoUrl, views}]). ' +
  'Navigate to tiktok.com/@username first. Scroll down to load more videos in the grid. ' +
  'Use this to audit a creator profile or collect video URLs for further processing.';

export async function handleBrowserExtractTiktokProfile(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, TIKTOK_PROFILE_EXTRACTOR_SCRIPT, resolved.tabId);
  if (result.error) return text(`Extract failed: ${result.error}`);

  const profile = result.result as Record<string, unknown>;
  if (!profile || (!profile.name && !profile.handle)) {
    return text('No profile found. Make sure you are on tiktok.com/@username then retry.');
  }

  return text(`Profile:\n\n${JSON.stringify(profile)}`);
}

// ── browser_extract_wa_chats ──

const WA_CHATS_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('[aria-label="Lista de conversas"] [role="row"]')).map(row => {
  const nameSpan = row.querySelector('span[title][dir="auto"]');
  const allSpans = Array.from(row.querySelectorAll('span')).filter(s => !s.children.length && s.innerText?.trim());
  const timeSpan = allSpans.find(s => /^\\d|Ontem|Hoje|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday/.test(s.innerText.trim()));
  const msgSpans = Array.from(row.querySelectorAll('span[dir="auto"]')).filter(s => !s.getAttribute('title') && s.innerText?.trim());
  const unreadEl = row.querySelector('[aria-label*="mensagem não lida"]');
  const mutedEl = row.querySelector('[aria-label="Conversa silenciada"]');
  const pinnedEl = row.querySelector('[aria-label="Conversa fixada"]');
  const lastMsg = msgSpans.map(s => s.innerText.trim()).filter(t => t && t !== nameSpan?.innerText?.trim()).join(' ').substring(0, 80) || null;
  return {
    name: nameSpan?.getAttribute('title') || nameSpan?.innerText?.trim() || null,
    lastMsg,
    time: timeSpan?.innerText?.trim() || null,
    unreadCount: unreadEl?.innerText?.trim() || null,
    muted: !!mutedEl,
    pinned: !!pinnedEl,
  };
}).filter(c => c.name)
`.trim();

export const browserExtractWaChatsSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractWaChatsDescription =
  'Extract visible WhatsApp chats from the sidebar as structured JSON ' +
  '(name, lastMsg, time, unreadCount, muted, pinned). ' +
  'Must be on web.whatsapp.com with the chat list visible. Pass scrolls/minItems to auto-scroll the sidebar and dedupe in ONE call. ' +
  'Use browser_click on span[title="Chat Name"] to open a specific chat.';

export async function handleBrowserExtractWaChats(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, WA_CHATS_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['name'],
    scrollTarget: `document.querySelector('#pane-side')`,
    scrollDistance: 600,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No chats found. Make sure you are on web.whatsapp.com with the chat list visible.');
  }

  return text(formatExtraction('chat', res));
}

// ── browser_extract_wa_messages ──

const WA_MESSAGES_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('div.copyable-text[data-pre-plain-text]')).map(el => {
  const meta = el.getAttribute('data-pre-plain-text') || '';
  const timeMatch = meta.match(/\\[([^,]+),\\s*([^\\]]+)\\]/);
  const senderMatch = meta.match(/\\]\\s*([^:]+):/);
  const isOut = !!el.closest('.message-out');
  const dataId = el.closest('[data-id]')?.getAttribute('data-id') || null;
  const textContent = el.innerText?.trim() || null;
  return {
    sender: senderMatch ? senderMatch[1].trim() : (isOut ? 'Me' : null),
    time: timeMatch ? timeMatch[1].trim() : null,
    date: timeMatch ? timeMatch[2].trim() : null,
    direction: isOut ? 'out' : 'in',
    text: textContent,
    dataId,
  };
}).filter(m => m.text)
`.trim();

export const browserExtractWaMessagesSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractWaMessagesDescription =
  'Extract visible messages from the open WhatsApp chat as structured JSON ' +
  '(sender, time, date, direction, text, dataId). ' +
  'Open a chat first by clicking span[title="Chat Name"]. Pass scrolls/minItems to auto-scroll UP through history and dedupe in ONE call. ' +
  'direction is "in" for received and "out" for sent messages.';

export async function handleBrowserExtractWaMessages(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, WA_MESSAGES_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['dataId'],
    scrollTarget: SCROLLABLE_ANCESTOR('div.copyable-text[data-pre-plain-text]'),
    scrollDirection: -1, // history loads upward
    scrollDistance: 800,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No messages found. Open a chat first, then retry.');
  }

  return text(formatExtraction('message', res));
}

// ── browser_extract_ig_feed ──

const IG_FEED_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('article')).map(el => {
  const userLink = Array.from(el.querySelectorAll('a[href^="/"]')).find(a => a.getAttribute('href')?.match(/^\\/[^/]+\\/$/) && !a.getAttribute('href').includes('/p/') && !a.getAttribute('href').includes('/reel/') && !a.getAttribute('href').includes('/explore/'));
  const username = userLink?.textContent?.trim() || null;
  const profileUrl = userLink ? 'https://www.instagram.com' + userLink.getAttribute('href') : null;
  const postLink = el.querySelector('a[href*="/p/"], a[href*="/reel/"]');
  const postUrl = postLink ? 'https://www.instagram.com' + postLink.getAttribute('href') : null;
  const captionEl = el.querySelector('span._ap3a._aaco._aacu._aacx._aad7._aade');
  const caption = captionEl?.innerText?.trim() || null;
  const countSpans = Array.from(el.querySelectorAll('section span')).filter(s => s.children.length === 0 && /^[\\d.,]+\\s*(mil|M|K|B)?$/.test(s.textContent?.trim() || ''));
  const likes = countSpans[0]?.textContent?.trim() || null;
  const comments = countSpans[1]?.textContent?.trim() || null;
  const timeEl = el.querySelector('time');
  const time = timeEl?.textContent?.trim() || null;
  const datetime = timeEl?.getAttribute('datetime') || null;
  const isSponsored = !!Array.from(el.querySelectorAll('span')).find(s => s.textContent?.trim() === 'Patrocinado' || s.textContent?.trim() === 'Sponsored');
  const hasFollow = !!Array.from(el.querySelectorAll('*')).find(e => (e.textContent?.trim() === 'Seguir' || e.textContent?.trim() === 'Follow') && e.children.length === 0);
  return { username, profileUrl, postUrl, caption, likes, comments, time, datetime, isSponsored, hasFollow };
}).filter(p => p.username || p.caption)
`;

export const browserExtractIgFeedSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractIgFeedDescription =
  'Extract visible Instagram feed posts as structured JSON ' +
  '(username, profileUrl, postUrl, caption, likes, comments, time, datetime, isSponsored, hasFollow). ' +
  'Navigate to instagram.com/ first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call.';

export async function handleBrowserExtractIgFeed(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, IG_FEED_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['postUrl'], scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No feed posts found. Navigate to instagram.com/ and retry with scrolls:2.');
  }

  return text(formatExtraction('post', res));
}

// ── browser_extract_ig_profile ──

const IG_PROFILE_EXTRACTOR_SCRIPT = `
(() => {
  const header = document.querySelector('header');
  if (!header) return null;
  const username = header.querySelector('h2')?.textContent?.trim() || header.querySelector('h1')?.textContent?.trim() || null;
  const nameSpan = header.querySelector('span[dir="auto"]');
  const displayName = nameSpan?.textContent?.trim() || null;
  const statTexts = Array.from(header.querySelectorAll('span')).filter(s => {
    const t = s.textContent?.trim() || '';
    return t.includes('post') || t.includes('seguidore') || t.includes('seguind') || t.includes('follower') || t.includes('following');
  });
  const posts = statTexts.find(s => /post/i.test(s.textContent))?.textContent?.trim() || null;
  const followers = statTexts.find(s => /seguidore|follower/i.test(s.textContent))?.textContent?.trim() || null;
  const following = statTexts.find(s => /seguind|following/i.test(s.textContent))?.textContent?.trim() || null;
  const followerExact = header.querySelector('span[title]')?.getAttribute('title') || null;
  const bioSpans = Array.from(header.querySelectorAll('span[dir="auto"]')).filter(s => {
    const t = s.textContent?.trim();
    return t && t !== username && t !== displayName && t.length > 2 && !/(post|seguidore|seguind|follower|following)/i.test(t);
  });
  const bio = bioSpans.map(s => s.textContent?.trim()).join('\\n') || null;
  const extLink = header.querySelector('a[href*="l.instagram.com"]');
  const website = extLink?.textContent?.trim() || null;
  const isVerified = !!header.querySelector('svg[aria-label="Verificado"], svg[aria-label="Verified"]');
  const gridPosts = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')).slice(0, 12).map(a => ({
    url: 'https://www.instagram.com' + a.getAttribute('href'),
    alt: a.querySelector('img')?.getAttribute('alt')?.substring(0, 100) || null,
    isReel: a.getAttribute('href').includes('/reel/'),
  }));
  const highlights = Array.from(document.querySelectorAll('a[href*="/stories/highlights/"]')).map(a => ({
    name: a.textContent?.trim() || null,
    url: 'https://www.instagram.com' + a.getAttribute('href'),
  }));
  return { username, displayName, bio, posts, followers, followerExact, following, isVerified, website, gridPosts, highlights };
})()
`;

export const browserExtractIgProfileSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractIgProfileDescription =
  'Extract Instagram profile data as structured JSON ' +
  '(username, displayName, bio, posts, followers, followerExact, following, isVerified, website, gridPosts, highlights). ' +
  'Navigate to instagram.com/username/ first. Returns bio, stats, post grid (up to 12), and story highlights.';

export async function handleBrowserExtractIgProfile(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, IG_PROFILE_EXTRACTOR_SCRIPT, resolved.tabId);
  if (result.error) return text(`Extract failed: ${result.error}`);

  const profile = result.result as Record<string, unknown>;
  if (!profile || !profile.username) {
    return text('No profile data found. Navigate to instagram.com/username/ first, then retry.');
  }

  return text(`Profile:\n\n${JSON.stringify(profile)}`);
}

// ── browser_extract_ig_post ──

const IG_POST_EXTRACTOR_SCRIPT = `
(() => {
  const main = document.querySelector('main');
  if (!main) return null;
  const authorLink = Array.from(main.querySelectorAll('a[role="link"]')).find(a => a.getAttribute('href')?.match(/^\\/[^/]+\\/$/));
  const author = authorLink?.textContent?.trim() || null;
  let caption = null;
  if (authorLink) {
    const container = authorLink.parentElement?.parentElement;
    if (container) {
      const spans = Array.from(container.querySelectorAll('span[dir="auto"]'));
      caption = spans.map(s => s.textContent?.trim()).filter(t => t && t !== author).join(' ')?.substring(0, 500) || null;
    }
  }
  const countSpans = Array.from(main.querySelectorAll('section span')).filter(s => s.children.length === 0 && /^[\\d.,]+\\s*(mil|M|K|B)?$/.test(s.textContent?.trim() || ''));
  const likes = countSpans.length >= 2 ? countSpans[countSpans.length - 2]?.textContent?.trim() : (countSpans[0]?.textContent?.trim() || null);
  const commentCount = countSpans.length >= 2 ? countSpans[countSpans.length - 1]?.textContent?.trim() : null;
  const timeEls = Array.from(main.querySelectorAll('time'));
  const postTime = timeEls.find(t => t.textContent?.trim()?.startsWith('há') || t.textContent?.trim()?.startsWith('ago') || /^\\d/.test(t.textContent?.trim() || ''));
  const time = postTime?.textContent?.trim() || timeEls[0]?.textContent?.trim() || null;
  const datetime = postTime?.getAttribute('datetime') || timeEls[0]?.getAttribute('datetime') || null;
  const commentLinks = Array.from(main.querySelectorAll('a[href*="/c/"]'));
  const comments = [];
  const seen = new Set();
  for (const link of commentLinks) {
    const commentUrl = link.getAttribute('href');
    if (seen.has(commentUrl)) continue;
    seen.add(commentUrl);
    const row = link.parentElement?.parentElement?.parentElement;
    if (!row) continue;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const texts = [];
    let node;
    while (node = walker.nextNode()) {
      const t = node.textContent?.trim();
      if (t) texts.push(t);
    }
    const cTime = row.querySelector('time');
    comments.push({
      username: texts[0] || null,
      text: texts.slice(2).join(' ')?.substring(0, 200) || texts[1] || null,
      time: cTime?.textContent?.trim() || null,
      datetime: cTime?.getAttribute('datetime') || null,
    });
  }
  return { author, caption, likes, commentCount, time, datetime, comments };
})()
`;

export const browserExtractIgPostSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractIgPostDescription =
  'Extract a single Instagram post with comments as structured JSON ' +
  '(author, caption, likes, commentCount, time, datetime, comments[{username, text, time, datetime}]). ' +
  'Navigate to instagram.com/p/POST_ID/ or instagram.com/reel/REEL_ID/ first. ' +
  'Scroll the comment area to load more comments before extracting.';

export async function handleBrowserExtractIgPost(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, IG_POST_EXTRACTOR_SCRIPT, resolved.tabId);
  if (result.error) return text(`Extract failed: ${result.error}`);

  const post = result.result as Record<string, unknown>;
  if (!post || !post.author) {
    return text('No post data found. Navigate to instagram.com/p/POST_ID/ first, then retry.');
  }

  return text(`Post:\n\n${JSON.stringify(post)}`);
}

// ── browser_extract_ig_reels ──

const IG_REELS_EXTRACTOR_SCRIPT = `
(() => {
  const main = document.querySelector('main');
  if (!main) return [];
  const likeSvgs = Array.from(main.querySelectorAll('svg[aria-label="Curtir"], svg[aria-label="Like"]'));
  const reels = [];
  const seen = new Set();
  for (const svg of likeSvgs) {
    let container = svg.closest('[role="button"]')?.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!container) break;
      const hasComment = container.querySelector('svg[aria-label="Comentar"], svg[aria-label="Comment"]');
      const hasShare = container.querySelector('svg[aria-label="Compartilhar"], svg[aria-label="Share"]');
      if (hasComment && hasShare) break;
      container = container.parentElement;
    }
    if (!container || seen.has(container)) continue;
    seen.add(container);
    const userLink = container.querySelector('a[href^="/"]');
    const spans = Array.from(container.querySelectorAll('span')).filter(s => s.children.length === 0);
    const counts = spans.filter(s => /^[\\d.,]+\\s*(mil|M|K|B)?$/.test(s.textContent?.trim() || '')).map(s => s.textContent?.trim());
    const audioLink = container.querySelector('a[href*="/audio/"], a[href*="/music/"]');
    const captionSpans = spans.filter(s => s.getAttribute('dir') === 'auto' && (s.textContent?.trim().length || 0) > 10);
    const hasFollow = !!Array.from(container.querySelectorAll('*')).find(e => (e.textContent?.trim() === 'Seguir' || e.textContent?.trim() === 'Follow') && e.children.length === 0);
    reels.push({
      username: userLink?.textContent?.trim() || null,
      profileUrl: userLink ? 'https://www.instagram.com' + userLink.getAttribute('href') : null,
      caption: captionSpans[0]?.textContent?.trim()?.substring(0, 200) || null,
      likes: counts[0] || null,
      comments: counts[1] || null,
      audioName: audioLink?.textContent?.trim()?.substring(0, 80) || null,
      audioUrl: audioLink ? 'https://www.instagram.com' + audioLink.getAttribute('href') : null,
      hasFollow,
    });
  }
  return reels;
})()
`;

export const browserExtractIgReelsSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractIgReelsDescription =
  'Extract visible Instagram Reels with engagement data as structured JSON ' +
  '(username, profileUrl, caption, likes, comments, audioName, audioUrl, hasFollow). ' +
  'Navigate to instagram.com/reels/ first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call.';

export async function handleBrowserExtractIgReels(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, IG_REELS_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['profileUrl', 'caption'],
    scrollDistance: 900, // reels advance roughly one viewport per scroll
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No reels found. Navigate to instagram.com/reels/ and retry with scrolls:2.');
  }

  return text(formatExtraction('reel', res));
}

// ── browser_extract_ig_search ──

const IG_SEARCH_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')).map(a => ({
  url: 'https://www.instagram.com' + a.getAttribute('href'),
  alt: a.querySelector('img')?.getAttribute('alt')?.substring(0, 120) || null,
  isReel: a.getAttribute('href').includes('/reel/'),
})).filter(p => p.url)
`;

export const browserExtractIgSearchSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractIgSearchDescription =
  'Extract posts from the Instagram Explore page as structured JSON (url, alt, isReel). ' +
  'Navigate to instagram.com/explore/ first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. ' +
  'For hashtag search, navigate to instagram.com/explore/tags/HASHTAG/.';

export async function handleBrowserExtractIgSearch(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, IG_SEARCH_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['url'], scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No explore posts found. Navigate to instagram.com/explore/ and retry with scrolls:2.');
  }

  return text(formatExtraction('post', res));
}

// ── LinkedIn Extraction Tools ──

// ── browser_extract_li_feed ──

const LI_FEED_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('.feed-shared-update-v2[data-urn*="urn:li:activity"]')).map(post => {
  const actorLink = post.querySelector('.update-components-actor__meta-link') || post.querySelector('.update-components-actor__name a');
  const actorUrl = actorLink?.href?.split('?')[0] || null;
  const nameSpan = actorLink?.querySelector('.update-components-actor__title span[aria-hidden="true"]') || actorLink?.querySelector('span[aria-hidden="true"]');
  const actorName = nameSpan?.textContent?.trim() || null;
  const descSpan = post.querySelector('.update-components-actor__description span[aria-hidden="true"]');
  const headline = descSpan?.textContent?.trim() || null;
  const subDesc = post.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]')?.textContent?.trim() || null;
  const timeMatch = subDesc?.match(/^(\\d+\\s*\\w+)/) || null;
  const time = timeMatch ? timeMatch[1] : (subDesc || null);
  const isPromoted = /Promovido|Promoted/i.test(subDesc || '');
  const textEl = post.querySelector('.feed-shared-update-v2__description, .update-components-text');
  const text = textEl?.innerText?.trim() || null;
  const reactionsBtn = post.querySelector('.social-details-social-counts__reactions-count');
  const reactions = reactionsBtn?.textContent?.trim() || null;
  const commentsEl = post.querySelector('.social-details-social-counts__comments');
  const commentsCount = commentsEl?.textContent?.trim()?.match(/\\d[\\d.,]*/)?.[0] || null;
  const hasImage = !!post.querySelector('.update-components-image img');
  const hasVideo = !!post.querySelector('video, .update-components-linkedin-video');
  const hasArticle = !!post.querySelector('.update-components-article');
  const hasDocument = !!post.querySelector('.update-components-linkedin-document');
  const mediaType = hasVideo ? 'video' : hasDocument ? 'document' : hasArticle ? 'article' : hasImage ? 'image' : 'text';
  const articleTitle = post.querySelector('.update-components-article__title')?.textContent?.trim() || null;
  const articleLink = post.querySelector('.update-components-article a')?.href?.split('?')[0] || null;
  const reshareActor = post.querySelector('.update-components-mini-update-v2');
  const isRepost = !!reshareActor;
  const postUrn = post.getAttribute('data-urn');
  const postUrl = postUrn ? 'https://www.linkedin.com/feed/update/' + postUrn + '/' : null;
  return { author: actorName, authorUrl: actorUrl, headline, time, text, reactions, commentsCount, mediaType, articleTitle, articleLink, isPromoted, isRepost, postUrl };
}).filter(p => p.author || p.text)
`.trim();

export const browserExtractLiFeedSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiFeedDescription =
  'Extract visible LinkedIn feed posts as structured JSON ' +
  '(author, authorUrl, headline, time, text, reactions, commentsCount, mediaType, articleTitle, articleLink, isPromoted, isRepost, postUrl). ' +
  'Navigate to linkedin.com/feed/ first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. ' +
  'Much faster than browser_snapshot for data harvesting from the LinkedIn feed.';

export async function handleBrowserExtractLiFeed(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, LI_FEED_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['postUrl'], scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No LinkedIn feed posts found. Navigate to linkedin.com/feed/ and retry with scrolls:2.');
  }

  return text(formatExtraction('post', res));
}

// ── browser_extract_li_profile ──

const LI_PROFILE_EXTRACTOR_SCRIPT = `
(() => {
  const name = document.querySelector('.text-heading-xlarge, h1')?.textContent?.trim() || null;
  const headline = document.querySelector('.text-body-medium.break-words')?.textContent?.trim() || null;
  const location = document.querySelector('.text-body-small.inline.t-black--light.break-words')?.textContent?.trim() || null;
  const profilePic = document.querySelector('.pv-top-card-profile-picture__image, img.profile-photo-edit__preview')?.src || null;
  const connectionsEl = Array.from(document.querySelectorAll('span')).find(s => /conexõ|connection/i.test(s.textContent || ''));
  const connections = connectionsEl?.textContent?.trim() || null;
  const aboutSection = document.querySelector('.pv-about-section .inline-show-more-text, section .pv-shared-text-with-see-more span[aria-hidden="true"]');
  const about = aboutSection?.textContent?.trim() || null;
  const sections = Array.from(document.querySelectorAll('section.artdeco-card')).map(s => {
    const heading = (s.querySelector('.pvs-header__title span[aria-hidden="true"]') || s.querySelector('h2 span[aria-hidden="true"]') || s.querySelector('h2'))?.textContent?.trim()?.replace(/\\s+/g, ' ');
    if (!heading) return null;
    const items = Array.from(s.querySelectorAll('li.artdeco-list__item, li.pvs-list__paged-list-item')).map(li => {
      const title = li.querySelector('.t-bold span[aria-hidden="true"], .mr1.t-bold span')?.textContent?.trim();
      const subtitle = li.querySelector('.t-normal span[aria-hidden="true"], .t-14.t-normal span')?.textContent?.trim();
      const meta = li.querySelector('.pvs-entity__caption-wrapper span[aria-hidden="true"]')?.textContent?.trim();
      return { title: title || null, subtitle: subtitle || null, meta: meta || null };
    }).filter(i => i.title);
    return { heading, items };
  }).filter(Boolean);
  const activityPosts = Array.from(document.querySelectorAll('.pv-recent-activity-section li, section .feed-shared-update-v2')).slice(0, 5).map(p => ({
    text: p.querySelector('.feed-shared-update-v2__description, .update-components-text')?.innerText?.trim()?.substring(0, 200) || p.innerText?.trim()?.substring(0, 200),
  }));
  return { name, headline, location, profilePic, connections, about, sections, recentActivity: activityPosts };
})()
`.trim();

export const browserExtractLiProfileSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiProfileDescription =
  'Extract LinkedIn profile data as structured JSON ' +
  '(name, headline, location, profilePic, connections, about, sections[{heading, items[{title, subtitle, meta}]}], recentActivity). ' +
  'Navigate to linkedin.com/in/USERNAME/ first. Sections include Experience, Education, Skills, etc. ' +
  'Use linkedin.com/in/me/ for the logged-in user\'s own profile.';

export async function handleBrowserExtractLiProfile(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, LI_PROFILE_EXTRACTOR_SCRIPT, resolved.tabId);
  if (result.error) return text(`Extract failed: ${result.error}`);

  const profile = result.result as Record<string, unknown>;
  if (!profile || !profile.name) {
    return text('No profile data found. Navigate to linkedin.com/in/USERNAME/ first, then retry.');
  }

  return text(`Profile:\n\n${JSON.stringify(profile)}`);
}

// ── browser_extract_li_post ──

const LI_POST_EXTRACTOR_SCRIPT = `
(() => {
  const post = document.querySelector('.feed-shared-update-v2[data-urn]');
  if (!post) return null;
  const actorLink = post.querySelector('.update-components-actor__meta-link') || post.querySelector('.update-components-actor__name a');
  const nameSpan = actorLink?.querySelector('.update-components-actor__title span[aria-hidden="true"]') || actorLink?.querySelector('span[aria-hidden="true"]');
  const author = nameSpan?.textContent?.trim() || null;
  const authorUrl = actorLink?.href?.split('?')[0] || null;
  const headline = post.querySelector('.update-components-actor__description span[aria-hidden="true"]')?.textContent?.trim() || null;
  const subDesc = post.querySelector('.update-components-actor__sub-description span[aria-hidden="true"]')?.textContent?.trim() || null;
  const text = post.querySelector('.feed-shared-update-v2__description, .update-components-text')?.innerText?.trim() || null;
  const reactions = post.querySelector('.social-details-social-counts__reactions-count')?.textContent?.trim() || null;
  const commentsCountEl = post.querySelector('.social-details-social-counts__comments');
  const commentsCount = commentsCountEl?.textContent?.trim()?.match(/\\d[\\d.,]*/)?.[0] || null;
  const postUrn = post.getAttribute('data-urn');
  const comments = Array.from(document.querySelectorAll('.comments-comment-item, article.comments-comment-entity')).map(c => {
    const cAuthorLink = c.querySelector('a[href*="/in/"]');
    const cName = c.querySelector('.comments-post-meta__name-text span[aria-hidden="true"]')?.textContent?.trim() ||
                  cAuthorLink?.textContent?.trim()?.replace(/\\s+/g, ' ') || null;
    const cUrl = cAuthorLink?.href?.split('?')[0] || null;
    const cText = c.querySelector('.comments-comment-item__main-content, .comments-comment-item-content-body, .feed-shared-inline-show-more-text')?.innerText?.trim() || null;
    const cTime = c.querySelector('time')?.textContent?.trim() || c.querySelector('.comments-comment-item__timestamp')?.textContent?.trim() || null;
    const cLikes = c.querySelector('.comments-comment-social-bar__reactions-count, .social-details-social-counts__reactions-count')?.textContent?.trim() || null;
    return { author: cName, authorUrl: cUrl, text: cText, time: cTime, likes: cLikes };
  }).filter(c => c.text);
  return { author, authorUrl, headline, time: subDesc, text, reactions, commentsCount, postUrn, comments };
})()
`.trim();

export const browserExtractLiPostSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiPostDescription =
  'Extract a single LinkedIn post with comments as structured JSON ' +
  '(author, authorUrl, headline, time, text, reactions, commentsCount, postUrn, comments[{author, authorUrl, text, time, likes}]). ' +
  'Navigate to linkedin.com/feed/update/urn:li:activity:ID/ first. ' +
  'Click "Comentar" button to expand comment section, then scroll to load more comments before extracting.';

export async function handleBrowserExtractLiPost(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, LI_POST_EXTRACTOR_SCRIPT, resolved.tabId);
  if (result.error) return text(`Extract failed: ${result.error}`);

  const post = result.result as Record<string, unknown>;
  if (!post || !post.author) {
    return text('No post data found. Navigate to linkedin.com/feed/update/urn:li:activity:ID/ first, then retry.');
  }

  return text(`Post:\n\n${JSON.stringify(post)}`);
}

// ── browser_extract_li_notifications ──

const LI_NOTIFICATIONS_EXTRACTOR_SCRIPT = `
Array.from(document.querySelectorAll('article.nt-card')).map(card => {
  const isUnread = card.classList.contains('nt-card--unread');
  const link = card.querySelector('a[href*="linkedin.com"]');
  const url = link?.href?.split('&or')[0] || link?.href || null;
  const allText = card.innerText?.trim()?.replace(/\\s+/g, ' ') || null;
  const cleanText = allText?.replace(/^(Notificação não lida\\.\\s*|O status está off-line\\s*)/, '')?.replace(/\\s*há\\s*\\d+.*$/, '')?.trim() || allText;
  const timeEl = Array.from(card.querySelectorAll('span, p')).find(s => /^\\d+\\s*(min|h|d|sem|s|m|dia|hour|day|week|month|mo)/i.test(s.textContent?.trim() || ''));
  const time = timeEl?.textContent?.trim() || null;
  const img = card.querySelector('img')?.src || null;
  return { text: cleanText?.substring(0, 300), time, isUnread, url, image: img };
}).filter(n => n.text && !n.text.includes('funciona melhor no novo aplicativo'))
`.trim();

export const browserExtractLiNotificationsSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiNotificationsDescription =
  'Extract LinkedIn notifications as structured JSON (text, time, isUnread, url, image). ' +
  'Navigate to linkedin.com/notifications/ first. Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. ' +
  'Useful for monitoring engagement, connection requests, and mentions.';

export async function handleBrowserExtractLiNotifications(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, LI_NOTIFICATIONS_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['url', 'text'],
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No notifications found. Navigate to linkedin.com/notifications/ first, then retry.');
  }

  return text(formatExtraction('notification', res));
}

// ── browser_extract_li_messages ──

const LI_MESSAGES_EXTRACTOR_SCRIPT = `
(() => {
  const results = { conversations: [], activeThread: [] };
  results.conversations = Array.from(document.querySelectorAll('.msg-conversation-listitem')).map(c => {
    const name = c.querySelector('.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names')?.textContent?.trim() || null;
    const snippet = c.querySelector('.msg-conversation-listitem__message-snippet, .msg-conversation-card__message-snippet')?.textContent?.trim()?.substring(0, 150) || null;
    const time = c.querySelector('.msg-conversation-listitem__time-stamp, .msg-conversation-card__time-stamp, time')?.textContent?.trim() || null;
    const isUnread = c.classList.contains('msg-conversation-listitem--unread');
    const link = c.querySelector('a')?.href || null;
    return { name, lastMessage: snippet, time, isUnread, url: link };
  }).filter(c => c.name);
  results.activeThread = Array.from(document.querySelectorAll('.msg-s-message-list__event, .msg-s-event-listitem')).map(m => {
    const sender = m.querySelector('.msg-s-message-group__name, .msg-s-event-listitem__link')?.textContent?.trim() || null;
    const text = m.querySelector('.msg-s-event-listitem__body, .msg-s-event-listitem__message-bubble')?.textContent?.trim()?.substring(0, 500) || null;
    const time = m.querySelector('.msg-s-message-group__timestamp, time')?.textContent?.trim() || null;
    const isIncoming = !m.classList.contains('msg-s-message-list__event--outgoing');
    return { sender, text, time, direction: isIncoming ? 'in' : 'out' };
  }).filter(m => m.text);
  return results;
})()
`.trim();

export const browserExtractLiMessagesSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiMessagesDescription =
  'Extract LinkedIn messaging data as structured JSON with two arrays: ' +
  'conversations[{name, lastMessage, time, isUnread, url}] (sidebar list) and ' +
  'activeThread[{sender, text, time, direction}] (open conversation messages). ' +
  'Navigate to linkedin.com/messaging/ first. Click a conversation to load its messages. ' +
  'To send a message: browser_fill on .msg-form__contenteditable then browser_click on .msg-form__send-button.';

export async function handleBrowserExtractLiMessages(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, LI_MESSAGES_EXTRACTOR_SCRIPT, resolved.tabId);
  if (result.error) return text(`Extract failed: ${result.error}`);

  const data = result.result as Record<string, unknown>;
  const convos = data?.conversations as Array<Record<string, unknown>> || [];
  const msgs = data?.activeThread as Array<Record<string, unknown>> || [];
  if (convos.length === 0 && msgs.length === 0) {
    return text('No messages found. Navigate to linkedin.com/messaging/ first, then retry.');
  }

  return text(`${convos.length} conversation(s), ${msgs.length} message(s) in active thread:\n\n${JSON.stringify(data)}`);
}

// ── browser_extract_li_search_people ──

const LI_SEARCH_PEOPLE_EXTRACTOR_SCRIPT = `
(() => {
  const main = document.querySelector('main') || document.body;
  const profileLinks = Array.from(main.querySelectorAll('a[href*="/in/"]')).filter(a => {
    const href = a.getAttribute('href') || '';
    return href.match(/\\/in\\/[^/]+\\/?$/) && !href.includes('/search/') && a.textContent?.trim()?.length > 2;
  });
  const seen = new Set();
  return profileLinks.map(a => {
    const href = a.href?.split('?')[0];
    if (seen.has(href)) return null;
    seen.add(href);
    const card = a.parentElement;
    if (!card) return null;
    const pEls = Array.from(card.querySelectorAll('p'));
    const nameText = a.textContent?.trim()?.replace(/\\s+/g, ' ')?.replace(/\\s*•.*/, '') || null;
    const headline = pEls[1]?.textContent?.trim() || null;
    const location = pEls[2]?.textContent?.trim() || null;
    const currentRole = pEls.find(p => /^(Atual|Current)/i.test(p.textContent?.trim() || ''))?.textContent?.trim() || null;
    const followers = pEls.find(p => /seguidores|followers/i.test(p.textContent?.trim() || ''))?.textContent?.trim() || null;
    const mutual = pEls.find(p => /em comum|mutual/i.test(p.textContent?.trim() || ''))?.textContent?.trim() || null;
    const connectBtn = card.querySelector('button');
    const btnText = connectBtn?.textContent?.trim();
    const img = card.querySelector('img')?.src || null;
    return {
      name: nameText?.substring(0, 80),
      profileUrl: href,
      headline: headline?.substring(0, 200) || null,
      location: location?.substring(0, 80) || null,
      currentRole: currentRole?.substring(0, 150) || null,
      followers: followers?.substring(0, 40) || null,
      mutual: mutual?.substring(0, 80) || null,
      actionButton: (btnText && btnText.length < 30) ? btnText : null,
      image: img,
    };
  }).filter(Boolean);
})()
`.trim();

export const browserExtractLiSearchPeopleSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiSearchPeopleDescription =
  'Extract LinkedIn people search results as structured JSON ' +
  '(name, profileUrl, headline, location, mutual, actionButton, image). ' +
  'Navigate to linkedin.com/search/results/people/?keywords=QUERY first. ' +
  'Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call. Also works on linkedin.com/search/results/all/.';

export async function handleBrowserExtractLiSearchPeople(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, LI_SEARCH_PEOPLE_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['profileUrl'],
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No search results found. Navigate to linkedin.com/search/results/people/?keywords=QUERY first, then retry.');
  }

  return text(formatExtraction('result', res));
}

// ── browser_extract_li_network ──

const LI_NETWORK_EXTRACTOR_SCRIPT = `
(() => {
  const results = { invitations: [], suggestions: [] };
  const invCards = document.querySelectorAll('.invitation-card, [data-view-name="invitation-card"]');
  results.invitations = Array.from(invCards).map(inv => {
    const name = inv.querySelector('.invitation-card__name, span[aria-hidden="true"]')?.textContent?.trim() || null;
    const subtitle = inv.querySelector('.invitation-card__subtitle, .invitation-card__occupation')?.textContent?.trim() || null;
    const acceptBtn = inv.querySelector('button[aria-label*="Aceitar"], button[aria-label*="Accept"]');
    const ignoreBtn = inv.querySelector('button[aria-label*="Ignorar"], button[aria-label*="Ignore"]');
    const profileLink = inv.querySelector('a[href*="/in/"]')?.href?.split('?')[0] || null;
    return { name, subtitle, profileUrl: profileLink, acceptLabel: acceptBtn?.getAttribute('aria-label') || null, ignoreLabel: ignoreBtn?.getAttribute('aria-label') || null };
  }).filter(i => i.name);
  const followBtns = Array.from(document.querySelectorAll('main button')).filter(b => {
    const t = b.textContent?.trim();
    return t === 'Seguir' || t === '+ Seguir' || t === 'Follow' || t === '+ Follow' || t === 'Conectar' || t === 'Connect';
  });
  const seen = new Set();
  results.suggestions = followBtns.map(btn => {
    let card = btn.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!card) break;
      if (card.querySelector('img') && card.querySelector('a[href*="/in/"]')) break;
      card = card.parentElement;
    }
    if (!card) return null;
    const profileLink = card.querySelector('a[href*="/in/"]');
    const url = profileLink?.href?.split('?')[0];
    if (!url || seen.has(url)) return null;
    seen.add(url);
    const allText = card.innerText?.trim()?.split('\\n').filter(t => t.trim().length > 1) || [];
    const name = allText[0]?.trim() || null;
    const nameClean = name?.replace(/[,\\s]*(Top Voice|Premium|Verificado|Verified).*$/i, '')?.trim();
    const subtitle = allText.find(t => {
      const clean = t.trim();
      return clean !== name && clean !== nameClean && !clean.includes('Seguir') && !clean.includes('Follow') && !clean.includes('Conectar') && !clean.includes('Connect') && !/^\\d/.test(clean) && clean.length > 5;
    })?.trim() || null;
    const followersText = allText.find(t => /seguidores|followers/i.test(t))?.trim() || null;
    const img = card.querySelector('img')?.src || null;
    return { name, subtitle, followers: followersText, profileUrl: url, action: btn.textContent?.trim(), image: img };
  }).filter(Boolean);
  return results;
})()
`.trim();

export const browserExtractLiNetworkSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiNetworkDescription =
  'Extract LinkedIn My Network data as structured JSON with two arrays: ' +
  'invitations[{name, subtitle, profileUrl, acceptLabel, ignoreLabel}] (pending connection requests) and ' +
  'suggestions[{name, subtitle, followers, profileUrl, action, image}] (people/creators to follow or connect). ' +
  'Navigate to linkedin.com/mynetwork/ first. Scroll down to load more suggestions. ' +
  'To accept an invitation: browser_click on button with the acceptLabel. ' +
  'To connect: browser_click on the respective Conectar/Connect button.';

export async function handleBrowserExtractLiNetwork(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.evaluate(resolved.sessionId, LI_NETWORK_EXTRACTOR_SCRIPT, resolved.tabId);
  if (result.error) return text(`Extract failed: ${result.error}`);

  const data = result.result as Record<string, unknown>;
  const invitations = data?.invitations as Array<Record<string, unknown>> || [];
  const suggestions = data?.suggestions as Array<Record<string, unknown>> || [];
  if (invitations.length === 0 && suggestions.length === 0) {
    return text('No network data found. Navigate to linkedin.com/mynetwork/ first, then retry.');
  }

  return text(`${invitations.length} invitation(s), ${suggestions.length} suggestion(s):\n\n${JSON.stringify(data)}`);
}

// ── browser_extract_li_jobs ──

const LI_JOBS_EXTRACTOR_SCRIPT = `
(() => {
  const jobs = [];
  const seen = new Set();

  // --- Search results page (/jobs/search/) ---
  const searchCards = document.querySelectorAll('[data-occludable-job-id]');
  searchCards.forEach(card => {
    const jobId = card.getAttribute('data-occludable-job-id');
    if (seen.has(jobId)) return;
    seen.add(jobId);

    const titleLink = card.querySelector('a[href*="/jobs/view/"]');
    const title = titleLink?.querySelector('span[aria-hidden="true"]')?.textContent?.trim()
      || titleLink?.querySelector('strong')?.textContent?.trim() || null;
    const jobUrl = titleLink?.href?.split('?')[0] || null;

    const company = card.querySelector('.artdeco-entity-lockup__subtitle')?.textContent?.trim()?.replace(/\\s+/g, ' ') || null;
    const companyLink = card.querySelector('a[href*="/company/"]');
    const companyUrl = companyLink?.href?.split('?')[0] || null;

    const location = card.querySelector('.artdeco-entity-lockup__caption')?.textContent?.trim()?.replace(/\\s+/g, ' ') || null;

    const logo = card.querySelector('img')?.src || null;
    const footerText = card.querySelector('.job-card-container__footer-wrapper')?.textContent?.trim()?.replace(/\\s+/g, ' ') || '';
    const promoted = /Promovida|Promoted/i.test(footerText);
    const easyApply = /Candidatura simplificada|Easy Apply/i.test(footerText);

    // Salary: sometimes in metadata items
    const allText = card.innerText || '';
    const salaryMatch = allText.match(/(?:R\\$|US\\$|\\$)[\\s\\d.,\\/]+(?:por\\s+hr|por\\s+m[eê]s|per\\s+hr|per\\s+month|yr|hr|k)?(?:\\s*-\\s*(?:R\\$|US\\$|\\$)?[\\s\\d.,\\/]+(?:por\\s+hr|por\\s+m[eê]s|per\\s+hr|per\\s+month|yr|hr|k)?)?/i);
    const salary = salaryMatch ? salaryMatch[0].trim() : null;

    if (title) jobs.push({ jobId, title, company, companyUrl, location, salary, jobUrl, logo, promoted, easyApply, postedDate: null });
  });

  // --- Homepage (/jobs/) — recommended/top-applicant/easy-apply cards ---
  if (jobs.length === 0) {
    const homeLinks = document.querySelectorAll('main a[href*="/jobs/collections/"], main a[href*="/jobs/view/"]');
    homeLinks.forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href.includes('/jobs/collections/') && !href.includes('/jobs/view/')) return;
      const pEls = Array.from(a.querySelectorAll('p'));
      if (pEls.length < 2) return; // skip "View all" links

      // Extract jobId from URL if present
      const idMatch = href.match(/currentJobId=(\\d+)/) || href.match(/\\/jobs\\/view\\/(\\d+)/);
      const jobId = idMatch ? idMatch[1] : null;
      if (jobId && seen.has(jobId)) return;
      if (jobId) seen.add(jobId);

      // Title: first p, strip "(Vaga verificada)" suffix and duplicated text
      const rawTitle = pEls[0]?.textContent?.trim() || '';
      const title = rawTitle
        .replace(/\\s*\\(Vaga verificada\\).*/i, '')
        .replace(/\\s*\\(Verified listing\\).*/i, '')
        .trim() || null;
      if (!title) return;

      // Parse p elements: filter out dots and noise
      const texts = pEls.map(p => p.textContent?.trim()).filter(t => t && t !== '\\u2022' && t !== '\\u00b7' && t.length > 1);
      let company = null;
      let locationVal = null;
      let salary = null;
      let postedDate = null;
      const promoted = /Promovida|Promoted/i.test(a.innerText || '');
      const easyApply = /Candidatura simplificada|Easy Apply/i.test(a.innerText || '');

      if (texts.length >= 2) company = texts[1];
      if (texts.length >= 3) locationVal = texts[2];

      // Find salary in any p
      for (const t of texts) {
        const sm = t.match(/(?:R\\$|US\\$|\\$)[\\s\\d.,\\/]+(?:por\\s+hr|por\\s+m[eê]s|per\\s+hr|per\\s+month|yr|hr|k)?(?:\\s*-\\s*(?:R\\$|US\\$|\\$)?[\\s\\d.,\\/]+(?:por\\s+hr|por\\s+m[eê]s|per\\s+hr|per\\s+month|yr|hr|k)?)?/i);
        if (sm) { salary = sm[0].trim(); break; }
      }

      // Find posted date in any p
      for (const t of texts) {
        const dm = t.match(/(?:Anunciada\\s+h[aá]|Posted)\\s+.+/i);
        if (dm) { postedDate = dm[0].trim(); break; }
      }

      // Remove noise from company/location
      if (/^(Promovida|Promoted|Candidatura|Easy Apply)$/i.test(company || '')) company = null;
      if (/^(Promovida|Promoted|Candidatura|Easy Apply)$/i.test(locationVal || '')) locationVal = null;

      const jobUrl = jobId ? 'https://www.linkedin.com/jobs/view/' + jobId + '/' : null;
      const logo = a.querySelector('img')?.src || null;

      jobs.push({ jobId, title, company, companyUrl: null, location: locationVal, salary, jobUrl, logo, promoted, easyApply, postedDate });
    });
  }

  return jobs;
})()
`.trim();

export const browserExtractLiJobsSchema = {
  ...pagedExtractorFields,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserExtractLiJobsDescription =
  'Extract LinkedIn job listings as structured JSON ' +
  '(jobId, title, company, companyUrl, location, salary, jobUrl, logo, promoted, easyApply, postedDate). ' +
  'Works on linkedin.com/jobs/ (recommendations) and linkedin.com/jobs/search/?keywords=QUERY&location=LOCATION. ' +
  'Pass scrolls/minItems to auto-scroll, extract, and dedupe in ONE call.';

export async function handleBrowserExtractLiJobs(args: PagedArgs & { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const res = await runPagedExtractor(resolved.sessionId, resolved.tabId, LI_JOBS_EXTRACTOR_SCRIPT, {
    ...args, dedupeKeys: ['jobId', 'jobUrl'], scrollIfEmpty: true,
  });
  if ('error' in res) return text(`Extract failed: ${res.error}`);
  if (res.items.length === 0) {
    return text('No job listings found. Navigate to linkedin.com/jobs/ or linkedin.com/jobs/search/?keywords=QUERY first, then retry with scrolls:2.');
  }

  return text(formatExtraction('job', res));
}
