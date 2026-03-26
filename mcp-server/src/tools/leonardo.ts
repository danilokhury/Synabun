/**
 * Leonardo.ai MCP tool registration barrel.
 * 100% browser-based — no API key required.
 * Registers 4 Leonardo browser tools on the given server instance.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  browserNavigateSchema, browserNavigateDescription, handleBrowserNavigate,
  browserGenerateSchema, browserGenerateDescription, handleBrowserGenerate,
  browserLibrarySchema, browserLibraryDescription, handleBrowserLibrary,
  browserDownloadSchema, browserDownloadDescription, handleBrowserDownload,
} from './leonardo-browser-tools.js';

/**
 * Register all Leonardo.ai MCP tools on the given server instance.
 * These are browser-based tools that automate the Leonardo.ai web UI.
 * Use the /leonardo skill for the full guided creation experience.
 */
export function registerLeonardoTools(server: McpServer) {
  server.tool('leonardo_browser_navigate', browserNavigateDescription, browserNavigateSchema, handleBrowserNavigate);
  server.tool('leonardo_browser_generate', browserGenerateDescription, browserGenerateSchema, handleBrowserGenerate);
  server.tool('leonardo_browser_library', browserLibraryDescription, browserLibrarySchema, handleBrowserLibrary);
  server.tool('leonardo_browser_download', browserDownloadDescription, browserDownloadSchema, handleBrowserDownload);
}
