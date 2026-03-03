import { z } from 'zod';
import * as ni from '../services/neural-interface.js';

// ── browser_snapshot ──

export const browserSnapshotSchema = {
  selector: z.string().optional().describe(
    'Scope snapshot to a specific element\'s subtree. Dramatically reduces output on complex pages. Twitter: [data-testid="primaryColumn"] for main feed, [data-testid="tweet"] for a single tweet card.'
  ),
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserSnapshotDescription =
  'Get an accessibility tree snapshot of the current page. Returns a structured text representation of all visible elements with their ARIA roles, names, and values. This is the primary and most token-efficient way to "see" the page — prefer this over screenshots. ' +
  'Twitter/X: scope to [data-testid="primaryColumn"] for main feed, [data-testid="tweet"] for a single tweet card. ' +
  'Facebook: scope to [role="feed"] for group/page feed, [role="article"] for a single post, [role="dialog"] for the post composer dialog.';

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

export async function handleBrowserSnapshot(args: { selector?: string; sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.snapshot(resolved.sessionId, args.selector);
  if (result.error) return { content: [{ type: 'text' as const, text: `Snapshot failed: ${result.error}` }] };

  const tree = result.snapshot as Record<string, unknown> | null;
  const formatted = tree ? formatSnapshotNode(tree) : '(empty page)';

  let text = `Page: ${result.url}\nTitle: "${result.title}"\n`;
  if (args.selector) text += `Scope: ${args.selector}\n`;
  text += '\n' + formatted;

  // Truncate if very long
  if (text.length > 30000) {
    text = text.slice(0, 30000) + '\n... (truncated — narrow scope with selector param)';
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
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserExtractTweetsDescription =
  'Extract all currently visible tweets as structured JSON (author, handle, text, time, url, replies, reposts, likes, views). Much faster than browser_snapshot for data harvesting — use this in scraping/loop flows instead of reading the ARIA tree. Navigate to x.com/search?q=%23hashtag&f=live first for latest-first hashtag results.';

export async function handleBrowserExtractTweets(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.evaluate(resolved.sessionId, TWEET_EXTRACTOR_SCRIPT);
  if (result.error) return { content: [{ type: 'text' as const, text: `Extract failed: ${result.error}` }] };

  const tweets = result.result as Array<Record<string, unknown>>;
  if (!Array.isArray(tweets) || tweets.length === 0) {
    return { content: [{ type: 'text' as const, text: `No tweets found. Try browser_scroll then retry.` }] };
  }

  const json = JSON.stringify(tweets, null, 2);
  return {
    content: [{ type: 'text' as const, text: `${tweets.length} tweet(s):\n\n${json}` }],
  };
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
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
};

export const browserExtractFbPostsDescription =
  'Extract all currently visible Facebook posts as structured JSON (author, authorUrl, text, time, postUrl, reactions). ' +
  'Works on group feeds and Pages. Scroll down first with browser_scroll to load more posts. ' +
  'Much faster than browser_snapshot for data harvesting from Facebook.';

export async function handleBrowserExtractFbPosts(args: { sessionId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId);
  if ('error' in resolved) return { content: [{ type: 'text' as const, text: resolved.error }] };

  const result = await ni.evaluate(resolved.sessionId, FB_POST_EXTRACTOR_SCRIPT);
  if (result.error) return { content: [{ type: 'text' as const, text: `Extract failed: ${result.error}` }] };

  const posts = result.result as Array<Record<string, unknown>>;
  if (!Array.isArray(posts) || posts.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No posts found. Try browser_scroll down then retry.' }] };
  }

  return {
    content: [{ type: 'text' as const, text: `${posts.length} post(s):\n\n${JSON.stringify(posts, null, 2)}` }],
  };
}
