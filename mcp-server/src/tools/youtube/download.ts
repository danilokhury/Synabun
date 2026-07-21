/**
 * youtube_download — fetch a trailer to disk. Prefers a direct Steam mp4 URL
 * (a plain HTTPS download of the publisher's own promo asset); falls back to
 * yt-dlp for YouTube-only trailers. Delegates to /api/youtube/download.
 */

import { z } from 'zod';
import * as ni from '../../services/neural-interface.js';
import { text } from '../response.js';

export const youtubeDownloadSchema = {
  steamMp4Url: z.string().optional().describe('Direct Steam mp4 URL (from youtube_source steamMovies[].mp4). Preferred — no yt-dlp/ffmpeg required.'),
  ytId: z.string().optional().describe('YouTube video id to download via yt-dlp (fallback for YouTube-only trailers).'),
  url: z.string().optional().describe('Explicit video URL to download via yt-dlp.'),
  appid: z.number().optional().describe('Steam appid — used only to name the output file.'),
  filename: z.string().optional().describe('Base output filename (without extension). Defaults derived from ytId/appid.'),
  quality: z.string().optional().describe('yt-dlp -f format string. Default: best video+audio ≤1080p, merged to mp4.'),
  useCookies: z.boolean().optional().describe('Cookie fallback for the yt-dlp path. The server downloads cookieless first and only retries with browser cookies if YouTube demands auth (age/region/members-gated). Defaults on; pass false to hard-disable.'),
};

export const youtubeDownloadDescription =
  'Download a trailer file. Prefers steamMp4Url (direct publisher asset, lowest copyright risk); otherwise yt-dlp on ytId/url. ' +
  'Returns { filePath, bytes, source }. Pass filePath to youtube_upload. ' +
  '[requires yt-dlp + ffmpeg on the host for the YouTube fallback path].';

export async function handleYoutubeDownload(args: {
  steamMp4Url?: string;
  ytId?: string;
  url?: string;
  appid?: number;
  filename?: string;
  quality?: string;
  useCookies?: boolean;
}) {
  if (!args.steamMp4Url && !args.ytId && !args.url) {
    return text('Provide steamMp4Url (preferred), ytId, or url.');
  }
  const r = await ni.youtubeDownload(args);
  if (r.error) return text(`Download failed: ${r.error}`);
  return text(JSON.stringify({ filePath: r.filePath, bytes: r.bytes, source: r.source }, null, 2));
}
