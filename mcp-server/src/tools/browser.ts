import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  browserNavigateSchema, browserNavigateDescription, handleBrowserNavigate,
  browserGoBackSchema, browserGoBackDescription, handleBrowserGoBack,
  browserGoForwardSchema, browserGoForwardDescription, handleBrowserGoForward,
} from './browser-navigate.js';

import {
  browserClickSchema, browserClickDescription, handleBrowserClick,
  browserFillSchema, browserFillDescription, handleBrowserFill,
  browserTypeSchema, browserTypeDescription, handleBrowserType,
  browserHoverSchema, browserHoverDescription, handleBrowserHover,
  browserSelectSchema, browserSelectDescription, handleBrowserSelect,
  browserPressSchema, browserPressDescription, handleBrowserPress,
} from './browser-interact.js';

import {
  browserSnapshotSchema, browserSnapshotDescription, handleBrowserSnapshot,
  browserContentSchema, browserContentDescription, handleBrowserContent,
  browserScreenshotSchema, browserScreenshotDescription, handleBrowserScreenshot,
} from './browser-observe.js';

import {
  browserEvaluateSchema, browserEvaluateDescription, handleBrowserEvaluate,
  browserWaitSchema, browserWaitDescription, handleBrowserWait,
  browserSessionSchema, browserSessionDescription, handleBrowserSession,
} from './browser-advanced.js';

/**
 * Register all 15 browser MCP tools on the given server instance.
 * Browser tools are static (no dynamic schema refresh needed).
 */
export function registerBrowserTools(server: McpServer) {
  // Navigation
  server.tool('browser_navigate', browserNavigateDescription, browserNavigateSchema, handleBrowserNavigate);
  server.tool('browser_go_back', browserGoBackDescription, browserGoBackSchema, handleBrowserGoBack);
  server.tool('browser_go_forward', browserGoForwardDescription, browserGoForwardSchema, handleBrowserGoForward);

  // Interaction
  server.tool('browser_click', browserClickDescription, browserClickSchema, handleBrowserClick);
  server.tool('browser_fill', browserFillDescription, browserFillSchema, handleBrowserFill);
  server.tool('browser_type', browserTypeDescription, browserTypeSchema, handleBrowserType);
  server.tool('browser_hover', browserHoverDescription, browserHoverSchema, handleBrowserHover);
  server.tool('browser_select', browserSelectDescription, browserSelectSchema, handleBrowserSelect);
  server.tool('browser_press', browserPressDescription, browserPressSchema, handleBrowserPress);

  // Observation
  server.tool('browser_snapshot', browserSnapshotDescription, browserSnapshotSchema, handleBrowserSnapshot);
  server.tool('browser_content', browserContentDescription, browserContentSchema, handleBrowserContent);
  server.tool('browser_screenshot', browserScreenshotDescription, browserScreenshotSchema, handleBrowserScreenshot);

  // Advanced
  server.tool('browser_evaluate', browserEvaluateDescription, browserEvaluateSchema, handleBrowserEvaluate);
  server.tool('browser_wait', browserWaitDescription, browserWaitSchema, handleBrowserWait);
  server.tool('browser_session', browserSessionDescription, browserSessionSchema, handleBrowserSession);
}
