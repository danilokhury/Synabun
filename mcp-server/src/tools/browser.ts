import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isBrowserV2Enabled, runWithBrowserCancellation, withPlatformRoute } from '../services/neural-interface.js';
import { browserBatchSchema, browserBatchDescription, handleBrowserBatch } from './browser-batch.js';

import {
  browserNavigateSchema, browserNavigateDescription, handleBrowserNavigate,
  browserGoBackSchema, browserGoBackDescription, handleBrowserGoBack,
  browserGoForwardSchema, browserGoForwardDescription, handleBrowserGoForward,
  browserReloadSchema, browserReloadDescription, handleBrowserReload,
} from './browser-navigate.js';

import {
  browserClickSchema, browserClickDescription, handleBrowserClick,
  browserFillSchema, browserFillDescription, handleBrowserFill,
  browserTypeSchema, browserTypeDescription, handleBrowserType,
  browserHoverSchema, browserHoverDescription, handleBrowserHover,
  browserSelectSchema, browserSelectDescription, handleBrowserSelect,
  browserPressSchema, browserPressDescription, handleBrowserPress,
  browserScrollSchema, browserScrollDescription, handleBrowserScroll,
  browserUploadSchema, browserUploadDescription, handleBrowserUpload,
} from './browser-interact.js';

import {
  browserSnapshotSchema, browserSnapshotDescription, handleBrowserSnapshot,
  browserContentSchema, browserContentDescription, handleBrowserContent,
  browserScreenshotSchema, browserScreenshotDescription, handleBrowserScreenshot,
  browserConsoleSchema, browserConsoleDescription, handleBrowserConsole,
  browserExtractTweetsSchema, browserExtractTweetsDescription, handleBrowserExtractTweets,
  browserXComposeStateSchema, browserXComposeStateDescription, handleBrowserXComposeState,
  browserExtractFbPostsSchema, browserExtractFbPostsDescription, handleBrowserExtractFbPosts,
  browserFbComposerStateSchema, browserFbComposerStateDescription, handleBrowserFbComposerState,
  browserExtractFbGroupsSchema, browserExtractFbGroupsDescription, handleBrowserExtractFbGroups,
  browserExtractTiktokVideosSchema, browserExtractTiktokVideosDescription, handleBrowserExtractTiktokVideos,
  browserExtractTiktokSearchSchema, browserExtractTiktokSearchDescription, handleBrowserExtractTiktokSearch,
  browserExtractTiktokStudioSchema, browserExtractTiktokStudioDescription, handleBrowserExtractTiktokStudio,
  browserExtractTiktokProfileSchema, browserExtractTiktokProfileDescription, handleBrowserExtractTiktokProfile,
  browserExtractWaChatsSchema, browserExtractWaChatsDescription, handleBrowserExtractWaChats,
  browserExtractWaMessagesSchema, browserExtractWaMessagesDescription, handleBrowserExtractWaMessages,
  browserExtractIgFeedSchema, browserExtractIgFeedDescription, handleBrowserExtractIgFeed,
  browserExtractIgProfileSchema, browserExtractIgProfileDescription, handleBrowserExtractIgProfile,
  browserExtractIgPostSchema, browserExtractIgPostDescription, handleBrowserExtractIgPost,
  browserExtractIgReelsSchema, browserExtractIgReelsDescription, handleBrowserExtractIgReels,
  browserExtractIgSearchSchema, browserExtractIgSearchDescription, handleBrowserExtractIgSearch,
  browserExtractLiFeedSchema, browserExtractLiFeedDescription, handleBrowserExtractLiFeed,
  browserExtractLiProfileSchema, browserExtractLiProfileDescription, handleBrowserExtractLiProfile,
  browserExtractLiPostSchema, browserExtractLiPostDescription, handleBrowserExtractLiPost,
  browserExtractLiNotificationsSchema, browserExtractLiNotificationsDescription, handleBrowserExtractLiNotifications,
  browserExtractLiMessagesSchema, browserExtractLiMessagesDescription, handleBrowserExtractLiMessages,
  browserExtractLiSearchPeopleSchema, browserExtractLiSearchPeopleDescription, handleBrowserExtractLiSearchPeople,
  browserExtractLiNetworkSchema, browserExtractLiNetworkDescription, handleBrowserExtractLiNetwork,
  browserExtractLiJobsSchema, browserExtractLiJobsDescription, handleBrowserExtractLiJobs,
} from './browser-observe.js';

import {
  browserEvaluateSchema, browserEvaluateDescription, handleBrowserEvaluate,
  browserWaitSchema, browserWaitDescription, handleBrowserWait,
  browserSessionSchema, browserSessionDescription, handleBrowserSession,
} from './browser-advanced.js';

import {
  browserCheatsheetSchema, browserCheatsheetDescription, handleBrowserCheatsheet,
} from './browser-cheatsheet.js';

import {
  fbGroupsSchema, fbGroupsDescription, handleFbGroups,
} from './fb-groups.js';

// BlueSky (AT Protocol) tools live in their own file — they call the XRPC API
// directly from the logged-in page rather than scraping the DOM. Re-exported
// here so index.ts imports every browser-group registrar from one module.
export { registerBlueskyTools } from './bluesky.js';

/** Carry MCP cancellation through all browser handler and transport awaits. */
export function withBrowserCancellation<TArgs, TResult>(handler: (args: TArgs, extra?: { signal?: AbortSignal }) => TResult) {
  return (args: TArgs, extra?: { signal?: AbortSignal }): TResult =>
    runWithBrowserCancellation(extra?.signal, () => handler(args, extra));
}

/**
 * Platform tools (X, Facebook, TikTok, …) only run in the default browser: an
 * explicit session the server says does not serve it is dropped for the default one.
 */
export function platformBrowserTool<TArgs, TResult>(handler: (args: TArgs, extra?: { signal?: AbortSignal }) => TResult) {
  return withBrowserCancellation((args: TArgs, extra?: { signal?: AbortSignal }): TResult =>
    withPlatformRoute(() => handler(args, extra)));
}

/**
 * Register the core browser tools (navigation, interaction, observation, advanced; browser_batch with browser V2).
 */
export function registerBrowserCoreTools(server: McpServer) {
  return [
    ...(isBrowserV2Enabled() ? [server.tool('browser_batch', browserBatchDescription, browserBatchSchema, withBrowserCancellation(handleBrowserBatch))] : []),
    // Navigation
    server.tool('browser_navigate', browserNavigateDescription, browserNavigateSchema, withBrowserCancellation(handleBrowserNavigate)),
    server.tool('browser_go_back', browserGoBackDescription, browserGoBackSchema, withBrowserCancellation(handleBrowserGoBack)),
    server.tool('browser_go_forward', browserGoForwardDescription, browserGoForwardSchema, withBrowserCancellation(handleBrowserGoForward)),
    server.tool('browser_reload', browserReloadDescription, browserReloadSchema, withBrowserCancellation(handleBrowserReload)),
    // Interaction
    server.tool('browser_click', browserClickDescription, browserClickSchema, withBrowserCancellation(handleBrowserClick)),
    server.tool('browser_fill', browserFillDescription, browserFillSchema, withBrowserCancellation(handleBrowserFill)),
    server.tool('browser_type', browserTypeDescription, browserTypeSchema, withBrowserCancellation(handleBrowserType)),
    server.tool('browser_hover', browserHoverDescription, browserHoverSchema, withBrowserCancellation(handleBrowserHover)),
    server.tool('browser_select', browserSelectDescription, browserSelectSchema, withBrowserCancellation(handleBrowserSelect)),
    server.tool('browser_press', browserPressDescription, browserPressSchema, withBrowserCancellation(handleBrowserPress)),
    server.tool('browser_scroll', browserScrollDescription, browserScrollSchema, withBrowserCancellation(handleBrowserScroll)),
    server.tool('browser_upload', browserUploadDescription, browserUploadSchema, withBrowserCancellation(handleBrowserUpload)),
    // Observation
    server.tool('browser_snapshot', browserSnapshotDescription, browserSnapshotSchema, withBrowserCancellation(handleBrowserSnapshot)),
    server.tool('browser_content', browserContentDescription, browserContentSchema, withBrowserCancellation(handleBrowserContent)),
    server.tool('browser_screenshot', browserScreenshotDescription, browserScreenshotSchema, withBrowserCancellation(handleBrowserScreenshot)),
    server.tool('browser_console', browserConsoleDescription, browserConsoleSchema, withBrowserCancellation(handleBrowserConsole)),
    // Advanced
    server.tool('browser_evaluate', browserEvaluateDescription, browserEvaluateSchema, withBrowserCancellation(handleBrowserEvaluate)),
    server.tool('browser_wait', browserWaitDescription, browserWaitSchema, withBrowserCancellation(handleBrowserWait)),
    server.tool('browser_session', browserSessionDescription, browserSessionSchema, withBrowserCancellation(handleBrowserSession)),
    // Cheatsheet (lazy selector lookup — replaces inline per-platform hints in tool descriptions)
    server.tool('browser_cheatsheet', browserCheatsheetDescription, browserCheatsheetSchema, withBrowserCancellation(handleBrowserCheatsheet)),
  ];
}

/** Register Twitter/X tools (2: feed extractor + compose-state probe). */
export function registerBrowserTwitterTools(server: McpServer) {
  return [
    server.tool('browser_extract_tweets', browserExtractTweetsDescription, browserExtractTweetsSchema, platformBrowserTool(handleBrowserExtractTweets)),
    server.tool('browser_x_compose_state', browserXComposeStateDescription, browserXComposeStateSchema, platformBrowserTool(handleBrowserXComposeState)),
  ];
}

/** Register Facebook tools (3 extractors + the fb_groups directory/checklist tool). */
export function registerBrowserFacebookTools(server: McpServer) {
  return [
    server.tool('browser_extract_fb_posts', browserExtractFbPostsDescription, browserExtractFbPostsSchema, platformBrowserTool(handleBrowserExtractFbPosts)),
    server.tool('browser_fb_composer_state', browserFbComposerStateDescription, browserFbComposerStateSchema, platformBrowserTool(handleBrowserFbComposerState)),
    server.tool('browser_extract_fb_groups', browserExtractFbGroupsDescription, browserExtractFbGroupsSchema, platformBrowserTool(handleBrowserExtractFbGroups)),
    server.tool('fb_groups', fbGroupsDescription, fbGroupsSchema, platformBrowserTool(handleFbGroups)),
  ];
}

/** Register TikTok extractors (4 tools). */
export function registerBrowserTiktokTools(server: McpServer) {
  return [
    server.tool('browser_extract_tiktok_videos', browserExtractTiktokVideosDescription, browserExtractTiktokVideosSchema, platformBrowserTool(handleBrowserExtractTiktokVideos)),
    server.tool('browser_extract_tiktok_search', browserExtractTiktokSearchDescription, browserExtractTiktokSearchSchema, platformBrowserTool(handleBrowserExtractTiktokSearch)),
    server.tool('browser_extract_tiktok_studio', browserExtractTiktokStudioDescription, browserExtractTiktokStudioSchema, platformBrowserTool(handleBrowserExtractTiktokStudio)),
    server.tool('browser_extract_tiktok_profile', browserExtractTiktokProfileDescription, browserExtractTiktokProfileSchema, platformBrowserTool(handleBrowserExtractTiktokProfile)),
  ];
}

/** Register WhatsApp extractors (2 tools). */
export function registerBrowserWhatsappTools(server: McpServer) {
  return [
    server.tool('browser_extract_wa_chats', browserExtractWaChatsDescription, browserExtractWaChatsSchema, platformBrowserTool(handleBrowserExtractWaChats)),
    server.tool('browser_extract_wa_messages', browserExtractWaMessagesDescription, browserExtractWaMessagesSchema, platformBrowserTool(handleBrowserExtractWaMessages)),
  ];
}

/** Register Instagram extractors (5 tools). */
export function registerBrowserInstagramTools(server: McpServer) {
  return [
    server.tool('browser_extract_ig_feed', browserExtractIgFeedDescription, browserExtractIgFeedSchema, platformBrowserTool(handleBrowserExtractIgFeed)),
    server.tool('browser_extract_ig_profile', browserExtractIgProfileDescription, browserExtractIgProfileSchema, platformBrowserTool(handleBrowserExtractIgProfile)),
    server.tool('browser_extract_ig_post', browserExtractIgPostDescription, browserExtractIgPostSchema, platformBrowserTool(handleBrowserExtractIgPost)),
    server.tool('browser_extract_ig_reels', browserExtractIgReelsDescription, browserExtractIgReelsSchema, platformBrowserTool(handleBrowserExtractIgReels)),
    server.tool('browser_extract_ig_search', browserExtractIgSearchDescription, browserExtractIgSearchSchema, platformBrowserTool(handleBrowserExtractIgSearch)),
  ];
}

/** Register LinkedIn extractors (8 tools). */
export function registerBrowserLinkedinTools(server: McpServer) {
  return [
    server.tool('browser_extract_li_feed', browserExtractLiFeedDescription, browserExtractLiFeedSchema, platformBrowserTool(handleBrowserExtractLiFeed)),
    server.tool('browser_extract_li_profile', browserExtractLiProfileDescription, browserExtractLiProfileSchema, platformBrowserTool(handleBrowserExtractLiProfile)),
    server.tool('browser_extract_li_post', browserExtractLiPostDescription, browserExtractLiPostSchema, platformBrowserTool(handleBrowserExtractLiPost)),
    server.tool('browser_extract_li_notifications', browserExtractLiNotificationsDescription, browserExtractLiNotificationsSchema, platformBrowserTool(handleBrowserExtractLiNotifications)),
    server.tool('browser_extract_li_messages', browserExtractLiMessagesDescription, browserExtractLiMessagesSchema, platformBrowserTool(handleBrowserExtractLiMessages)),
    server.tool('browser_extract_li_search_people', browserExtractLiSearchPeopleDescription, browserExtractLiSearchPeopleSchema, platformBrowserTool(handleBrowserExtractLiSearchPeople)),
    server.tool('browser_extract_li_network', browserExtractLiNetworkDescription, browserExtractLiNetworkSchema, platformBrowserTool(handleBrowserExtractLiNetwork)),
    server.tool('browser_extract_li_jobs', browserExtractLiJobsDescription, browserExtractLiJobsSchema, platformBrowserTool(handleBrowserExtractLiJobs)),
  ];
}
