/**
 * youtube_analytics — read-only channel/video analytics via the YouTube
 * Analytics API (OAuth; cheap, no audit needed). Delegates to /api/youtube/analytics.
 * youtube_channel — list recent uploads / read channel info from Studio (browser),
 * used by the autopilot to dedupe against what's already posted.
 */

import { z } from 'zod/v3';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';
import { STUDIO_BASE, resolve, ensureAuth, wait, pollFor, STUDIO_CHANNEL_READY_SCRIPT, safeNavigate, type Resolved } from './helpers.js';
import { channelId } from './navigate.js';

const tabId = z.string().optional().describe('Target a specific tab. Auto-resolved if omitted.');

// ── youtube_analytics (API) ───────────────────────────────────

export const youtubeAnalyticsSchema = {
  videoId: z.string().optional().describe('Limit the report to one video. Omit for channel-wide.'),
  channelId: z.string().optional().describe('Channel id (UC…). Defaults to the configured/owning channel.'),
  metrics: z.array(z.string()).optional().describe('Metrics, e.g. ["views","estimatedMinutesWatched","likes","subscribersGained"]. Sensible defaults if omitted.'),
  startDate: z.string().optional().describe('YYYY-MM-DD. Default: 28 days ago.'),
  endDate: z.string().optional().describe('YYYY-MM-DD. Default: today.'),
};

export const youtubeAnalyticsDescription =
  'Read-only YouTube Analytics (views, watch-time, likes, subscribers, etc.) via the API — needs the YouTube API configured/authorized in Settings → YouTube. Channel-wide or per-video.';

export async function handleYoutubeAnalytics(args: {
  videoId?: string;
  channelId?: string;
  metrics?: string[];
  startDate?: string;
  endDate?: string;
}) {
  const r = await ni.youtubeAnalytics(args);
  if (r.error) return text(`Analytics failed: ${r.error}`);
  return text(JSON.stringify(r.report ?? r, null, 2));
}

// ── youtube_channel (browser) ─────────────────────────────────

export const youtubeChannelSchema = {
  action: z.enum(['info', 'list'] as const).describe('info = channel id/name; list = recent uploads (id, title, visibility) for dedup.'),
  limit: z.number().optional().describe('Max videos for action=list (default 30).'),
  sessionId: z.string().optional(),
  tabId,
};

export const youtubeChannelDescription =
  'Read channel info or list recent uploads from Studio (browser). Use action=list to dedupe the autopilot against videos already on the channel.';

/** The channel's name as Studio shows it (the fixed reader 'youtube.channel_name'). */
export const CHANNEL_NAME_SCRIPT = `(() => { const el = document.querySelector('#channel-name, #entity-name, ytcp-channel-info'); return el ? (el.textContent || '').trim().slice(0,120) : null; })()`;
/** Every upload the Studio content grid shows, shadow DOM pierced, in page order, at most 200 (the fixed reader 'youtube.videos'). */
export const CHANNEL_VIDEOS_SCRIPT = `(() => {
      const byId = new Map();
      const walk = (root) => {
        if (!root) return;
        root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) walk(el.shadowRoot); });
        root.querySelectorAll('a[href*="/video/"]').forEach(a => {
          const m = (a.getAttribute('href') || '').match(/\\/video\\/([A-Za-z0-9_-]{6,})\\//);
          if (!m) return;
          const id = m[1];
          const title = (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 200);
          if (title && !byId.has(id)) byId.set(id, title);
        });
      };
      try { walk(document); } catch {}
      return Array.from(byId, ([videoId, title]) => ({ videoId, title })).slice(0, 200);
    })()`;

export async function handleYoutubeChannel(args: { action: 'info' | 'list'; limit?: number; sessionId?: string; tabId?: string }) {
  const r = await resolve(args.sessionId, args.tabId);
  if ('error' in r) return text(r.error);

  let cid = await channelId(r);
  if (!cid) {
    await safeNavigate(r, STUDIO_BASE);
    const authErr = await ensureAuth(r);
    if (authErr) return text(authErr);
    await pollFor(r, STUDIO_CHANNEL_READY_SCRIPT, 12000, 400, 'youtube.channel_ready');
    cid = await channelId(r);
  }
  if (!cid) return text('Could not resolve the active channel.');

  if (args.action === 'info') {
    const nameRes = await ni.evaluate(r.sessionId, CHANNEL_NAME_SCRIPT, r.tabId, { extractor: 'youtube.channel_name' });
    return text(JSON.stringify({ channelId: cid, name: (nameRes.result as string) || null, studioUrl: `${STUDIO_BASE}/channel/${cid}` }, null, 2));
  }

  // action === 'list' — scrape the content grid (shadow-DOM piercing).
  const nav = await safeNavigate(r, `${STUDIO_BASE}/channel/${cid}/videos/upload`);
  if (nav.error) return text(`Navigation failed: ${nav.error}`);
  const authErr = await ensureAuth(r);
  if (authErr) return text(authErr);
  await wait(1800);

  const limit = Math.min(Math.max(args.limit || 30, 1), 200);
  const res = await ni.evaluate(r.sessionId, CHANNEL_VIDEOS_SCRIPT, r.tabId, { extractor: 'youtube.videos' });
  // The script lists every upload the grid shows (at most 200, in page order); the limit is applied here.
  const videos = (Array.isArray(res.result) ? res.result as Array<{ videoId: string; title: string }> : []).slice(0, limit);
  return text(JSON.stringify({ channelId: cid, count: videos.length, videos }, null, 2));
}
