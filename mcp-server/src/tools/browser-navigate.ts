import { z } from 'zod/v3';
import * as ni from '../services/neural-interface.js';
import { text } from './response.js';
import { formatInlineSnapshot, formatAiSnapshotBody } from './browser-observe.js';

const tabIdField = z.string().optional().describe('Target a specific tab within the session. Auto-resolved from environment if omitted.');

const returnSnapshotField = z.object({
  mode: z.enum(['full', 'interactive', 'landmarks']).optional(),
  selector: z.string().optional(),
  viewport: z.boolean().optional(),
  maxChars: z.number().int().positive().optional(),
  format: z.enum(['text', 'json']).optional(),
}).optional().describe('Legacy inline snapshot (tree modes). Prefer the "snapshot" param, which returns ref-based AI snapshots.');

function formatBrowserLocation(result: Record<string, unknown>, action: string): string {
  if (ni.isBrowserCompactMode()) {
    const title = typeof result.title === 'string' && result.title ? ` "${result.title}"` : '';
    return `${action}${title}`;
  }
  return `${action} ${result.url} — "${result.title}"`;
}

const NAVIGATE_SNAPSHOT_MAX_CHARS = 12000;

const SLOW_LOAD_FALLBACK_NOTICE = 'the document committed but is still loading; wait a moment, then read it with browser_snapshot. Do not navigate to it again.';

/** A navigate the server answered `slowLoad: true`: the URL and the server's notice, nothing else. */
export function formatSlowLoad(result: Record<string, unknown>, requestedUrl: string): string {
  const url = typeof result.url === 'string' && result.url ? result.url : requestedUrl;
  const notice = typeof result.notice === 'string' && result.notice.trim() ? result.notice.trim() : SLOW_LOAD_FALLBACK_NOTICE;
  return `Slow page: ${url}\nnote: ${notice}`;
}

// One-line per-platform steering appended to navigate responses: points the model at
// the cheap extraction path instead of full snapshots on feed-heavy sites.
const PLATFORM_HINTS: Array<{ re: RegExp; hint: string }> = [
  { re: /(^|\.)x\.com$|(^|\.)twitter\.com$/, hint: 'x.com — harvest feeds with browser_extract_tweets (supports scrolls/minItems); browser_x_compose_state before posting/replying/quoting (quote-card + submit-button state, deterministic); browser_cheatsheet("twitter") for selectors. Avoid full snapshots on feeds.' },
  { re: /(^|\.)facebook\.com$/, hint: 'facebook.com — browser_extract_fb_posts / browser_extract_fb_groups for feed data, browser_fb_composer_state before posting; browser_cheatsheet("facebook"). Avoid full snapshots on feeds.' },
  { re: /(^|\.)instagram\.com$/, hint: 'instagram.com — browser_extract_ig_feed/profile/post/reels/search for data; browser_cheatsheet("instagram"). Avoid full snapshots on feeds.' },
  { re: /(^|\.)linkedin\.com$/, hint: 'linkedin.com — browser_extract_li_feed/profile/jobs/etc. for data; browser_cheatsheet("linkedin"). Avoid full snapshots on feeds.' },
  { re: /(^|\.)tiktok\.com$/, hint: 'tiktok.com — browser_extract_tiktok_videos/search/profile/studio for data; browser_cheatsheet("tiktok").' },
  { re: /^web\.whatsapp\.com$/, hint: 'web.whatsapp.com — browser_extract_wa_chats / browser_extract_wa_messages for data; browser_cheatsheet("whatsapp").' },
  { re: /(^|\.)bsky\.app$/, hint: 'bsky.app — use the native bluesky_* tools (bluesky_timeline/profile/thread/search_posts to read, bluesky_post to publish, bluesky_action to like/repost/follow, bluesky_dm for DMs). They call the AT Protocol XRPC API via this logged-in tab — no snapshots/scraping needed.' },
  { re: /(^|\.)youtube\.com$/, hint: 'youtube.com — use browser_snapshot depth:12 for structure or browser_content format:"markdown" for descriptions/transcripts; deep pages snapshot large.' },
];

function platformHint(url: unknown): string {
  if (typeof url !== 'string' || ni.isBrowserCompactMode()) return '';
  try {
    const host = new URL(url).hostname;
    const match = PLATFORM_HINTS.find(p => p.re.test(host));
    return match ? `\nhint: ${match.hint}` : '';
  } catch { return ''; }
}

// ── browser_navigate ──

export const browserNavigateSchema = {
  url: z.string().describe('The URL to navigate to.'),
  snapshot: z.enum(['full', 'diff', 'none']).optional().describe('Inline AI snapshot of the new page. Default "none": a terse answer as soon as the page loads. "full" waits for the document to parse and returns [ref=eN] refs; otherwise call browser_snapshot when you need the page structure.'),
  returnSnapshot: returnSnapshotField,
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session or creates a new one.'),
  tabId: tabIdField,
};

export const browserNavigateDescription =
  'Navigate the browser to a URL (auto-creates a session if needed). Returns as soon as the page commits (url, title, loadState "commit" or "domcontentloaded"); no snapshot by default. Call browser_snapshot for the page structure and [ref=eN] refs, or pass snapshot:"full" to get them inline (that waits for the document to parse).';

export async function handleBrowserNavigate(args: {
  url: string;
  snapshot?: 'full' | 'diff' | 'none';
  returnSnapshot?: { mode?: 'full' | 'interactive' | 'landmarks'; selector?: string; viewport?: boolean; maxChars?: number; format?: 'text' | 'json' };
  sessionId?: string;
  tabId?: string;
}) {
  // Every URL, localhost included, opens in the default browser (MoreLogin when
  // it is the default): an explicit session that is not it is dropped.
  const resolved = await ni.resolveSession(args.sessionId, { url: args.url }, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const rs = args.returnSnapshot ? {
    mode: args.returnSnapshot.mode,
    selector: args.returnSnapshot.selector,
    viewport: args.returnSnapshot.viewport,
  } : undefined;
  // No snapshot unless asked (2026-11-08 benchmark: the default full snapshot cost seconds per navigate).
  const snapshot = args.snapshot === 'full' || args.snapshot === 'diff' ? args.snapshot : undefined;
  const result = await ni.navigate(resolved.sessionId, args.url, resolved.tabId, rs, snapshot, undefined);
  if (result.error) return text(`Navigation failed: ${result.error}`);
  // The document committed but did not finish loading in the server's budget (x.com's cold first
  // load): there is no title, snapshot or page context yet, so none is printed as "(empty page)".
  if (result.slowLoad === true) return text(formatSlowLoad(result, args.url));

  let msg = formatBrowserLocation(result, 'Navigated');
  if (result.loadState === 'commit') msg += ' (still parsing)';
  if (typeof result.notice === 'string') msg += `\nnote: ${result.notice}`;
  msg += platformHint(result.url);
  if (snapshot) {
    msg += `\n\n--- Snapshot ---\n${formatAiSnapshotBody(result, NAVIGATE_SNAPSHOT_MAX_CHARS)}`;
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

// ── browser_go_back ──

export const browserGoBackSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserGoBackDescription = 'Go back to the previous page in browser history.';

export async function handleBrowserGoBack(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.goBack(resolved.sessionId, resolved.tabId);
  if (result.error) return text(`Go back failed: ${result.error}`);

  return text(formatBrowserLocation(result, 'Went back to'));
}

// ── browser_go_forward ──

export const browserGoForwardSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserGoForwardDescription = 'Go forward to the next page in browser history.';

export async function handleBrowserGoForward(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.goForward(resolved.sessionId, resolved.tabId);
  if (result.error) return text(`Go forward failed: ${result.error}`);

  return text(formatBrowserLocation(result, 'Went forward to'));
}

// ── browser_reload ──

export const browserReloadSchema = {
  sessionId: z.string().optional().describe('Browser session ID. If omitted, auto-selects the only open session.'),
  tabId: tabIdField,
};

export const browserReloadDescription = 'Reload the current page. Useful after making changes or when content is stale.';

export async function handleBrowserReload(args: { sessionId?: string; tabId?: string }) {
  const resolved = await ni.resolveSession(args.sessionId, undefined, args.tabId);
  if ('error' in resolved) return text(resolved.error);

  const result = await ni.reload(resolved.sessionId, resolved.tabId);
  if (result.error) return text(`Reload failed: ${result.error}`);

  return text(formatBrowserLocation(result, 'Reloaded'));
}
