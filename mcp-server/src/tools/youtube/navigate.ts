/**
 * youtube_navigate — open a YouTube Studio section. Studio is channel-scoped
 * (/channel/<UC…>/…); we resolve the active channel id from the URL after
 * landing on the Studio root, then build section URLs (locale-independent).
 * Tools: youtube_navigate
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { STUDIO_BASE, resolve, ensureAuth, wait, pollFor, safeNavigate, type Resolved } from './helpers.js';

const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');

const SECTIONS = ['dashboard', 'content', 'analytics', 'playlists', 'comments', 'subtitles', 'copyright', 'earn', 'customization'] as const;
type Section = typeof SECTIONS[number];

const SECTION_PATH: Record<Section, string> = {
  dashboard: '',
  content: '/videos/upload',
  analytics: '/analytics/tab-overview/period-default',
  playlists: '/playlists',
  comments: '/comments/inbox',
  subtitles: '/translations',
  copyright: '/copyright',
  earn: '/monetization',
  customization: '/editing/channel',
};

/** Read the active Studio channel id (UC…) from the URL, if present. */
export async function channelId(r: Resolved): Promise<string | null> {
  const res = await ni.evaluate(
    r.sessionId,
    `(() => { const m = location.href.match(/\\/channel\\/(UC[\\w-]+)/); return m ? m[1] : null; })()`,
    r.tabId,
  );
  if (res.error) return null;
  return (res.result as string | null) || null;
}

/** Cache the resolved channel id per session — Studio's active channel doesn't
 *  change within a session, so re-polling the root on every navigate is waste. */
const channelIdCache = new Map<string, string>();

export const youtubeNavigateSchema = {
  section: z.enum(SECTIONS).describe('Studio section to open.'),
  sessionId: z.string().optional().describe('Browser session ID. Auto-resolved or auto-created.'),
  tabId,
};

export const youtubeNavigateDescription =
  'Open a YouTube Studio section (dashboard, content, analytics, playlists, comments, subtitles, copyright, earn, customization). ' +
  'Auto-creates a browser session on studio.youtube.com using the signed-in Google account. Call before other youtube_* browser tools.';

export async function handleYoutubeNavigate(args: { section: Section; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  // Land on the Studio root first so the channel id resolves (Studio redirects
  // studio.youtube.com → /channel/<id>). Use the cached id when we already have it.
  let cid = channelIdCache.get(r.sessionId) || await channelId(r);
  if (!cid) {
    const nav = await safeNavigate(r, STUDIO_BASE);
    if (nav.error) return text(`Navigation failed: ${nav.error}`);
    const authErr = await ensureAuth(r);
    if (authErr) return text(authErr);
    await pollFor(r, `(() => /\\/channel\\/UC/.test(location.href) ? true : null)()`, 15000, 400);
    cid = await channelId(r);
  }
  if (!cid) return text('Could not resolve the active channel. Make sure you are signed into a Google account that owns a YouTube channel.');
  channelIdCache.set(r.sessionId, cid);

  const url = `${STUDIO_BASE}/channel/${cid}${SECTION_PATH[args.section]}`;
  const nav = await safeNavigate(r, url);
  if (nav.error) return text(`Navigation failed: ${nav.error}`);
  const authErr = await ensureAuth(r);
  if (authErr) return text(authErr);
  await wait(1000);

  return text(`Opened Studio ${args.section} for channel ${cid} (${url}).`);
}
