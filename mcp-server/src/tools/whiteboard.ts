import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  whiteboardReadSchema, whiteboardReadDescription, handleWhiteboardRead,
  whiteboardAddSchema, whiteboardAddDescription, handleWhiteboardAdd,
  whiteboardUpdateSchema, whiteboardUpdateDescription, handleWhiteboardUpdate,
  whiteboardRemoveSchema, whiteboardRemoveDescription, handleWhiteboardRemove,
  whiteboardScreenshotSchema, whiteboardScreenshotDescription, handleWhiteboardScreenshot,
} from './whiteboard-tools.js';

/**
 * Register all 5 whiteboard MCP tools on the given server instance.
 * These tools let Claude read, create, modify, remove, and screenshot
 * the whiteboard in the Neural Interface Focus mode.
 */
export function registerWhiteboardTools(server: McpServer) {
  server.tool('whiteboard_read', whiteboardReadDescription, whiteboardReadSchema, handleWhiteboardRead);
  server.tool('whiteboard_add', whiteboardAddDescription, whiteboardAddSchema, handleWhiteboardAdd);
  server.tool('whiteboard_update', whiteboardUpdateDescription, whiteboardUpdateSchema, handleWhiteboardUpdate);
  server.tool('whiteboard_remove', whiteboardRemoveDescription, whiteboardRemoveSchema, handleWhiteboardRemove);
  server.tool('whiteboard_screenshot', whiteboardScreenshotDescription, whiteboardScreenshotSchema, handleWhiteboardScreenshot);
}
