#!/usr/bin/env node

/**
 * HTTP transport for SynaBun MCP server.
 * Stateless — creates a fresh McpServer per request (same tools, no session state).
 * Mount on any Express app or run standalone.
 */

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ensureCollection } from './services/qdrant.js';
import { initCategoryCache } from './services/categories.js';
import { createMcpServer } from './index.js';

let initialized = false;

async function ensureInit() {
  if (initialized) return;
  try { await ensureCollection(); } catch {}
  await initCategoryCache();
  initialized = true;
}

/**
 * Create Express routes for the MCP HTTP endpoint.
 * Auth is handled externally (URL-embedded key in server.js).
 * Can be mounted on an existing Express app: app.use('/mcp', createMcpRoutes());
 */
export function createMcpRoutes() {
  const router = express.Router();
  router.use(express.json());

  router.post('/', async (req, res) => {
    await ensureInit();
    const server = createMcpServer();
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('MCP HTTP error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // Stateless — no GET (SSE) or DELETE (session close) needed
  router.get('/', (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }));
  });

  router.delete('/', (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }));
  });

  return router;
}

// If run directly, start a standalone HTTP server
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/http.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('/http.ts');

if (isMain) {
  const PORT = parseInt(process.env.MCP_HTTP_PORT || '3345', 10);
  const app = express();
  app.use('/mcp', createMcpRoutes());

  app.get('/', (_req, res) => {
    res.json({ name: 'SynaBun MCP (HTTP)', status: 'ok', endpoint: '/mcp' });
  });

  app.listen(PORT, () => {
    console.log(`SynaBun MCP HTTP server listening on port ${PORT}`);
    console.log(`Endpoint: http://localhost:${PORT}/mcp`);
  });
}
