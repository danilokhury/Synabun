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
} from './browser-observe.js';

import {
  browserEvaluateSchema, browserEvaluateDescription, handleBrowserEvaluate,
  browserWaitSchema, browserWaitDescription, handleBrowserWait,
  browserSessionSchema, browserSessionDescription, handleBrowserSession,
} from './browser-advanced.js';

/**
 * Register all 20 browser MCP tools on the given server instance.
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

  // Advanced
  server.tool('browser_evaluate', browserEvaluateDescription, browserEvaluateSchema, handleBrowserEvaluate);
  server.tool('browser_wait', browserWaitDescription, browserWaitSchema, handleBrowserWait);
  server.tool('browser_session', browserSessionDescription, browserSessionSchema, handleBrowserSession);
}
