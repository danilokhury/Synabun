/**
 * youtube_source — discover candidate game trailers via YouTube search, IGDB
 * (metadata + Steam appid + YouTube trailer ids), and Steam (direct mp4 URLs).
 * Delegates to the Neural Interface /api/sources/discover endpoint, which holds
 * the credentials.
 *
 * Dedup is built in: candidates already on the `youtube-videos` memory ledger
 * (written by youtube_upload) are dropped before they reach the model, and the
 * returned payload is trimmed to the fields the pipeline actually needs — so
 * each autopilot iteration spends a fraction of the tokens the old
 * recall-then-eyeball flow did, and can never re-pick a posted trailer.
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { getPostedTrailerKeys } from '../../services/sqlite.js';
import { candidateDedupKeys } from './dedup.js';
import { text } from '../response.js';

export const youtubeSourceSchema = {
  source: z.enum(['auto', 'igdb', 'steam', 'youtube'] as const).optional().describe(
    "Discovery backend. 'youtube' = YouTube Data API date-ordered recent trailer search; 'auto' (default) = IGDB games enriched with Steam mp4 URLs; 'igdb' = metadata + trailer pointers only; 'steam' = resolve explicit appids.",
  ),
  query: z.string().optional().describe('Game title or trailer search query. For source=youtube, omit to search official game trailers by publish date.'),
  appids: z.array(z.number()).optional().describe('Steam appids to resolve (required for source=steam).'),
  limit: z.number().optional().describe('Max candidates (1-50, default 10).'),
  lookbackDays: z.number().optional().describe('For source=youtube: published-after window. For IGDB/auto: release-date lookback window (default from config / 60).'),
  excludePosted: z.boolean().optional().describe('Drop trailers already on the youtube-videos memory ledger (exact igdb/appid/ytid/name match). Default true — leave it on so the autopilot never re-posts. Set false only to inspect the raw pool.'),
};

export const youtubeSourceDescription =
  'Discover FRESH candidate game trailers (already-posted ones are removed automatically via the youtube-videos memory ledger — no manual dedup/recall needed). ' +
  'Searches YouTube for recently published trailers, queries IGDB for games (+ Steam appid and official YouTube trailer ids), and resolves Steam direct mp4 URLs. ' +
  'Returns trimmed candidates: { game, source, igdbId, appid, releaseDate, trailerPublishedAt, trailerTitle, genres, ytTrailerIds, steamMp4Url, summary }. ' +
  'Feed one to youtube_download (prefer steamMp4Url; fall back to a ytTrailerIds value), then pass its game/igdbId/appid/sourceTrailerId back into youtube_upload so it records the ledger.';

/** Keep only the fields the download/metadata/upload steps use — drop cover, webm, thumbnails, channelTitle, and the full steamMovies[] blob (big token savers). */
function trimCandidate(c: Record<string, unknown>) {
  const movies = Array.isArray(c.steamMovies) ? (c.steamMovies as Array<Record<string, unknown>>) : [];
  const steamMp4Url = (movies.find((m) => typeof m?.mp4 === 'string')?.mp4 as string) || null;
  const summary = typeof c.summary === 'string' ? c.summary.slice(0, 240) : undefined;
  return {
    game: c.game ?? null,
    source: c.source ?? undefined,
    igdbId: c.igdbId ?? null,
    appid: c.appid ?? null,
    releaseDate: c.releaseDate ?? null,
    trailerPublishedAt: c.trailerPublishedAt ?? undefined,
    trailerTitle: c.trailerTitle ?? undefined,
    genres: Array.isArray(c.genres) && c.genres.length ? c.genres : undefined,
    ytTrailerIds: Array.isArray(c.ytTrailerIds) ? c.ytTrailerIds : [],
    steamMp4Url,
    watchUrl: c.url ?? undefined,
    summary,
  };
}

export async function handleYoutubeSource(args: {
  source?: 'auto' | 'igdb' | 'steam' | 'youtube';
  query?: string;
  appids?: number[];
  limit?: number;
  lookbackDays?: number;
  excludePosted?: boolean;
}) {
  const r = await ni.youtubeDiscover({
    source: args.source,
    query: args.query,
    appids: args.appids,
    limit: args.limit,
    filters: args.lookbackDays !== undefined ? { lookbackDays: args.lookbackDays } : undefined,
  });
  if (r.error) return text(`Discovery failed: ${r.error}`);

  let candidates = ((r.candidates as Array<Record<string, unknown>>) || []);
  const discovered = candidates.length;

  // Dedup: drop anything already on the ledger (default on).
  let filtered = 0;
  if (args.excludePosted !== false && candidates.length) {
    const posted = getPostedTrailerKeys();
    if (posted.size) {
      candidates = candidates.filter((c) => {
        const dup = candidateDedupKeys(c).some((k) => posted.has(k));
        if (dup) filtered++;
        return !dup;
      });
    }
  }

  if (candidates.length === 0) {
    if (filtered > 0) {
      return text(`No fresh candidates — all ${discovered} discovered trailers are already on the youtube-videos ledger. Broaden the query/lookback, try source:auto, or (to inspect) call again with excludePosted:false.`);
    }
    const diag = r.diagnostic as string | undefined;
    return text(diag ? `No candidates found. ${diag}` : 'No candidates found. Check IGDB credentials in Settings → YouTube, or broaden the query/lookback.');
  }

  const trimmed = candidates.map(trimCandidate);
  return text(JSON.stringify({ count: trimmed.length, filteredAlreadyPosted: filtered, candidates: trimmed }, null, 2));
}
