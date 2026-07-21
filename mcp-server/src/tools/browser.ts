import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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

/**
 * Register 18 core browser tools (navigation, interaction, observation, advanced).
 */
export function registerBrowserCoreTools(server: McpServer) {
  return [
    // Navigation
    server.tool('browser_navigate', browserNavigateDescription, browserNavigateSchema, handleBrowserNavigate),
    server.tool('browser_go_back', browserGoBackDescription, browserGoBackSchema, handleBrowserGoBack),
    server.tool('browser_go_forward', browserGoForwardDescription, browserGoForwardSchema, handleBrowserGoForward),
    server.tool('browser_reload', browserReloadDescription, browserReloadSchema, handleBrowserReload),
    // Interaction
    server.tool('browser_click', browserClickDescription, browserClickSchema, handleBrowserClick),
    server.tool('browser_fill', browserFillDescription, browserFillSchema, handleBrowserFill),
    server.tool('browser_type', browserTypeDescription, browserTypeSchema, handleBrowserType),
    server.tool('browser_hover', browserHoverDescription, browserHoverSchema, handleBrowserHover),
    server.tool('browser_select', browserSelectDescription, browserSelectSchema, handleBrowserSelect),
    server.tool('browser_press', browserPressDescription, browserPressSchema, handleBrowserPress),
    server.tool('browser_scroll', browserScrollDescription, browserScrollSchema, handleBrowserScroll),
    server.tool('browser_upload', browserUploadDescription, browserUploadSchema, handleBrowserUpload),
    // Observation
    server.tool('browser_snapshot', browserSnapshotDescription, browserSnapshotSchema, handleBrowserSnapshot),
    server.tool('browser_content', browserContentDescription, browserContentSchema, handleBrowserContent),
    server.tool('browser_screenshot', browserScreenshotDescription, browserScreenshotSchema, handleBrowserScreenshot),
    // Advanced
    server.tool('browser_evaluate', browserEvaluateDescription, browserEvaluateSchema, handleBrowserEvaluate),
    server.tool('browser_wait', browserWaitDescription, browserWaitSchema, handleBrowserWait),
    server.tool('browser_session', browserSessionDescription, browserSessionSchema, handleBrowserSession),
    // Cheatsheet (lazy selector lookup — replaces inline per-platform hints in tool descriptions)
    server.tool('browser_cheatsheet', browserCheatsheetDescription, browserCheatsheetSchema, handleBrowserCheatsheet),
  ];
}

/** Register Twitter/X tools (2: feed extractor + compose-state probe). */
export function registerBrowserTwitterTools(server: McpServer) {
  return [
    server.tool('browser_extract_tweets', browserExtractTweetsDescription, browserExtractTweetsSchema, handleBrowserExtractTweets),
    server.tool('browser_x_compose_state', browserXComposeStateDescription, browserXComposeStateSchema, handleBrowserXComposeState),
  ];
}

/** Register Facebook tools (3 extractors + the fb_groups directory/checklist tool). */
export function registerBrowserFacebookTools(server: McpServer) {
  return [
    server.tool('browser_extract_fb_posts', browserExtractFbPostsDescription, browserExtractFbPostsSchema, handleBrowserExtractFbPosts),
    server.tool('browser_fb_composer_state', browserFbComposerStateDescription, browserFbComposerStateSchema, handleBrowserFbComposerState),
    server.tool('browser_extract_fb_groups', browserExtractFbGroupsDescription, browserExtractFbGroupsSchema, handleBrowserExtractFbGroups),
    server.tool('fb_groups', fbGroupsDescription, fbGroupsSchema, handleFbGroups),
  ];
}

/** Register TikTok extractors (4 tools). */
export function registerBrowserTiktokTools(server: McpServer) {
  return [
    server.tool('browser_extract_tiktok_videos', browserExtractTiktokVideosDescription, browserExtractTiktokVideosSchema, handleBrowserExtractTiktokVideos),
    server.tool('browser_extract_tiktok_search', browserExtractTiktokSearchDescription, browserExtractTiktokSearchSchema, handleBrowserExtractTiktokSearch),
    server.tool('browser_extract_tiktok_studio', browserExtractTiktokStudioDescription, browserExtractTiktokStudioSchema, handleBrowserExtractTiktokStudio),
    server.tool('browser_extract_tiktok_profile', browserExtractTiktokProfileDescription, browserExtractTiktokProfileSchema, handleBrowserExtractTiktokProfile),
  ];
}

/** Register WhatsApp extractors (2 tools). */
export function registerBrowserWhatsappTools(server: McpServer) {
  return [
    server.tool('browser_extract_wa_chats', browserExtractWaChatsDescription, browserExtractWaChatsSchema, handleBrowserExtractWaChats),
    server.tool('browser_extract_wa_messages', browserExtractWaMessagesDescription, browserExtractWaMessagesSchema, handleBrowserExtractWaMessages),
  ];
}

/** Register Instagram extractors (5 tools). */
export function registerBrowserInstagramTools(server: McpServer) {
  return [
    server.tool('browser_extract_ig_feed', browserExtractIgFeedDescription, browserExtractIgFeedSchema, handleBrowserExtractIgFeed),
    server.tool('browser_extract_ig_profile', browserExtractIgProfileDescription, browserExtractIgProfileSchema, handleBrowserExtractIgProfile),
    server.tool('browser_extract_ig_post', browserExtractIgPostDescription, browserExtractIgPostSchema, handleBrowserExtractIgPost),
    server.tool('browser_extract_ig_reels', browserExtractIgReelsDescription, browserExtractIgReelsSchema, handleBrowserExtractIgReels),
    server.tool('browser_extract_ig_search', browserExtractIgSearchDescription, browserExtractIgSearchSchema, handleBrowserExtractIgSearch),
  ];
}

/** Register LinkedIn extractors (8 tools). */
export function registerBrowserLinkedinTools(server: McpServer) {
  return [
    server.tool('browser_extract_li_feed', browserExtractLiFeedDescription, browserExtractLiFeedSchema, handleBrowserExtractLiFeed),
    server.tool('browser_extract_li_profile', browserExtractLiProfileDescription, browserExtractLiProfileSchema, handleBrowserExtractLiProfile),
    server.tool('browser_extract_li_post', browserExtractLiPostDescription, browserExtractLiPostSchema, handleBrowserExtractLiPost),
    server.tool('browser_extract_li_notifications', browserExtractLiNotificationsDescription, browserExtractLiNotificationsSchema, handleBrowserExtractLiNotifications),
    server.tool('browser_extract_li_messages', browserExtractLiMessagesDescription, browserExtractLiMessagesSchema, handleBrowserExtractLiMessages),
    server.tool('browser_extract_li_search_people', browserExtractLiSearchPeopleDescription, browserExtractLiSearchPeopleSchema, handleBrowserExtractLiSearchPeople),
    server.tool('browser_extract_li_network', browserExtractLiNetworkDescription, browserExtractLiNetworkSchema, handleBrowserExtractLiNetwork),
    server.tool('browser_extract_li_jobs', browserExtractLiJobsDescription, browserExtractLiJobsSchema, handleBrowserExtractLiJobs),
  ];
}
