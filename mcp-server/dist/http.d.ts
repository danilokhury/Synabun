#!/usr/bin/env node
/**
 * HTTP transport for SynaBun MCP server.
 * Stateless — creates a fresh McpServer per request (same tools, no session state).
 * Mount on any Express app or run standalone.
 */
import { type Router } from 'express';
/**
 * Initialize DB, categories, and warm up the embedding model.
 * Safe to call multiple times — only runs once.
 * Exported so the Neural Interface can eagerly init at startup.
 */
export declare function ensureInit(): Promise<void>;
/**
 * Create Express routes for the MCP HTTP endpoint.
 * Auth is handled externally (URL-embedded key in server.js).
 * Can be mounted on an existing Express app: app.use('/mcp', createMcpRoutes());
 */
export declare function createMcpRoutes(): Router;
//# sourceMappingURL=http.d.ts.map