#!/usr/bin/env node
/**
 * HTTP transport for SynaBun MCP server.
 * Stateless — creates a fresh McpServer per request (same tools, no session state).
 * Mount on any Express app or run standalone.
 */
/**
 * Create Express routes for the MCP HTTP endpoint.
 * Auth is handled externally (URL-embedded key in server.js).
 * Can be mounted on an existing Express app: app.use('/mcp', createMcpRoutes());
 */
export declare function createMcpRoutes(): import("express-serve-static-core").Router;
//# sourceMappingURL=http.d.ts.map