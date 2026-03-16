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
  browserExtractFbPostsSchema, browserExtractFbPostsDescription, handleBrowserExtractFbPosts,
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
} from './browser-observe.js';

import {
  browserEvaluateSchema, browserEvaluateDescription, handleBrowserEvaluate,
  browserWaitSchema, browserWaitDescription, handleBrowserWait,
  browserSessionSchema, browserSessionDescription, handleBrowserSession,
} from './browser-advanced.js';

/**
 * Register all 38 browser MCP tools on the given server instance.
 * Browser tools are static (no dynamic schema refresh needed).
 */
export function registerBrowserTools(server: McpServer) {
  // Navigation
  server.tool('browser_navigate', browserNavigateDescription, browserNavigateSchema, handleBrowserNavigate);
  server.tool('browser_go_back', browserGoBackDescription, browserGoBackSchema, handleBrowserGoBack);
  server.tool('browser_go_forward', browserGoForwardDescription, browserGoForwardSchema, handleBrowserGoForward);
  server.tool('browser_reload', browserReloadDescription, browserReloadSchema, handleBrowserReload);

  // Interaction
  server.tool('browser_click', browserClickDescription, browserClickSchema, handleBrowserClick);
  server.tool('browser_fill', browserFillDescription, browserFillSchema, handleBrowserFill);
  server.tool('browser_type', browserTypeDescription, browserTypeSchema, handleBrowserType);
  server.tool('browser_hover', browserHoverDescription, browserHoverSchema, handleBrowserHover);
  server.tool('browser_select', browserSelectDescription, browserSelectSchema, handleBrowserSelect);
  server.tool('browser_press', browserPressDescription, browserPressSchema, handleBrowserPress);
  server.tool('browser_scroll', browserScrollDescription, browserScrollSchema, handleBrowserScroll);
  server.tool('browser_upload', browserUploadDescription, browserUploadSchema, handleBrowserUpload);

  // Observation
  server.tool('browser_snapshot', browserSnapshotDescription, browserSnapshotSchema, handleBrowserSnapshot);
  server.tool('browser_content', browserContentDescription, browserContentSchema, handleBrowserContent);
  server.tool('browser_screenshot', browserScreenshotDescription, browserScreenshotSchema, handleBrowserScreenshot);
  server.tool('browser_extract_tweets', browserExtractTweetsDescription, browserExtractTweetsSchema, handleBrowserExtractTweets);
  server.tool('browser_extract_fb_posts', browserExtractFbPostsDescription, browserExtractFbPostsSchema, handleBrowserExtractFbPosts);
  server.tool('browser_extract_tiktok_videos', browserExtractTiktokVideosDescription, browserExtractTiktokVideosSchema, handleBrowserExtractTiktokVideos);
  server.tool('browser_extract_tiktok_search', browserExtractTiktokSearchDescription, browserExtractTiktokSearchSchema, handleBrowserExtractTiktokSearch);
  server.tool('browser_extract_tiktok_studio', browserExtractTiktokStudioDescription, browserExtractTiktokStudioSchema, handleBrowserExtractTiktokStudio);
  server.tool('browser_extract_tiktok_profile', browserExtractTiktokProfileDescription, browserExtractTiktokProfileSchema, handleBrowserExtractTiktokProfile);
  server.tool('browser_extract_wa_chats', browserExtractWaChatsDescription, browserExtractWaChatsSchema, handleBrowserExtractWaChats);
  server.tool('browser_extract_wa_messages', browserExtractWaMessagesDescription, browserExtractWaMessagesSchema, handleBrowserExtractWaMessages);
  server.tool('browser_extract_ig_feed', browserExtractIgFeedDescription, browserExtractIgFeedSchema, handleBrowserExtractIgFeed);
  server.tool('browser_extract_ig_profile', browserExtractIgProfileDescription, browserExtractIgProfileSchema, handleBrowserExtractIgProfile);
  server.tool('browser_extract_ig_post', browserExtractIgPostDescription, browserExtractIgPostSchema, handleBrowserExtractIgPost);
  server.tool('browser_extract_ig_reels', browserExtractIgReelsDescription, browserExtractIgReelsSchema, handleBrowserExtractIgReels);
  server.tool('browser_extract_ig_search', browserExtractIgSearchDescription, browserExtractIgSearchSchema, handleBrowserExtractIgSearch);

  // LinkedIn
  server.tool('browser_extract_li_feed', browserExtractLiFeedDescription, browserExtractLiFeedSchema, handleBrowserExtractLiFeed);
  server.tool('browser_extract_li_profile', browserExtractLiProfileDescription, browserExtractLiProfileSchema, handleBrowserExtractLiProfile);
  server.tool('browser_extract_li_post', browserExtractLiPostDescription, browserExtractLiPostSchema, handleBrowserExtractLiPost);
  server.tool('browser_extract_li_notifications', browserExtractLiNotificationsDescription, browserExtractLiNotificationsSchema, handleBrowserExtractLiNotifications);
  server.tool('browser_extract_li_messages', browserExtractLiMessagesDescription, browserExtractLiMessagesSchema, handleBrowserExtractLiMessages);
  server.tool('browser_extract_li_search_people', browserExtractLiSearchPeopleDescription, browserExtractLiSearchPeopleSchema, handleBrowserExtractLiSearchPeople);
  server.tool('browser_extract_li_network', browserExtractLiNetworkDescription, browserExtractLiNetworkSchema, handleBrowserExtractLiNetwork);

  // Advanced
  server.tool('browser_evaluate', browserEvaluateDescription, browserEvaluateSchema, handleBrowserEvaluate);
  server.tool('browser_wait', browserWaitDescription, browserWaitSchema, handleBrowserWait);
  server.tool('browser_session', browserSessionDescription, browserSessionSchema, handleBrowserSession);
}
