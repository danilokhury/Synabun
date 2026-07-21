/**
 * YouTube trailer-automation MCP tool registration barrel.
 *
 * Hybrid: browser automation drives YouTube Studio (upload/publish/metadata/
 * thumbnail/schedule/playlists/end-screens) using the signed-in Google session
 * — avoiding the Data API's unaudited-project private-lock and ~6/day quota —
 * while sourcing (IGDB+Steam), downloading (Steam mp4 / yt-dlp), and read-only
 * analytics delegate to the Neural Interface (/api/sources + /api/youtube).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { youtubeSourceSchema, youtubeSourceDescription, handleYoutubeSource } from './youtube/source.js';
import { youtubeDownloadSchema, youtubeDownloadDescription, handleYoutubeDownload } from './youtube/download.js';
import { youtubeNavigateSchema, youtubeNavigateDescription, handleYoutubeNavigate } from './youtube/navigate.js';
import { youtubeUploadSchema, youtubeUploadDescription, handleYoutubeUpload } from './youtube/upload.js';
import { youtubeMetadataSchema, youtubeMetadataDescription, handleYoutubeMetadata } from './youtube/metadata.js';
import {
  youtubeThumbnailSchema, youtubeThumbnailDescription, handleYoutubeThumbnail,
  youtubeEndscreenSchema, youtubeEndscreenDescription, handleYoutubeEndscreen,
} from './youtube/media.js';
import { youtubeScheduleSchema, youtubeScheduleDescription, handleYoutubeSchedule } from './youtube/schedule.js';
import { youtubePlaylistSchema, youtubePlaylistDescription, handleYoutubePlaylist } from './youtube/playlist.js';
import {
  youtubeAnalyticsSchema, youtubeAnalyticsDescription, handleYoutubeAnalytics,
  youtubeChannelSchema, youtubeChannelDescription, handleYoutubeChannel,
} from './youtube/analytics.js';

export function registerYoutubeTools(server: McpServer) {
  return [
    // Sourcing + download (delegate to Neural Interface)
    server.tool('youtube_source', youtubeSourceDescription, youtubeSourceSchema, handleYoutubeSource),
    server.tool('youtube_download', youtubeDownloadDescription, youtubeDownloadSchema, handleYoutubeDownload),
    // Studio navigation
    server.tool('youtube_navigate', youtubeNavigateDescription, youtubeNavigateSchema, handleYoutubeNavigate),
    // Publishing (browser)
    server.tool('youtube_upload', youtubeUploadDescription, youtubeUploadSchema, handleYoutubeUpload),
    server.tool('youtube_metadata', youtubeMetadataDescription, youtubeMetadataSchema, handleYoutubeMetadata),
    server.tool('youtube_thumbnail', youtubeThumbnailDescription, youtubeThumbnailSchema, handleYoutubeThumbnail),
    server.tool('youtube_schedule', youtubeScheduleDescription, youtubeScheduleSchema, handleYoutubeSchedule),
    server.tool('youtube_playlist', youtubePlaylistDescription, youtubePlaylistSchema, handleYoutubePlaylist),
    server.tool('youtube_endscreen', youtubeEndscreenDescription, youtubeEndscreenSchema, handleYoutubeEndscreen),
    // Analytics + channel
    server.tool('youtube_analytics', youtubeAnalyticsDescription, youtubeAnalyticsSchema, handleYoutubeAnalytics),
    server.tool('youtube_channel', youtubeChannelDescription, youtubeChannelSchema, handleYoutubeChannel),
  ];
}
