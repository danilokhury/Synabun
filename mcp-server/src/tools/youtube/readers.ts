/**
 * The read-only scripts of the YouTube Studio tools that the extension backend serves with fixed readers
 * (../browser-readers.ts). The Playwright backend runs the strings; the extension runs the functions generated from them.
 */
import { PAGE_URL_SCRIPT, STUDIO_CHANNEL_READY_SCRIPT } from './helpers.js';
import { CHANNEL_ID_SCRIPT } from './navigate.js';
import { CHANNEL_NAME_SCRIPT, CHANNEL_VIDEOS_SCRIPT } from './analytics.js';

export const YOUTUBE_READER_SOURCES: Readonly<Record<string, { script: string }>> = Object.freeze({
  'page.url': { script: PAGE_URL_SCRIPT },
  'youtube.channel_id': { script: CHANNEL_ID_SCRIPT },
  'youtube.channel_ready': { script: STUDIO_CHANNEL_READY_SCRIPT },
  'youtube.channel_name': { script: CHANNEL_NAME_SCRIPT },
  'youtube.videos': { script: CHANNEL_VIDEOS_SCRIPT },
});
