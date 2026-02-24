import fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureCollection } from './services/qdrant.js';
import { getEnvPath } from './config.js';
import { rememberSchema, rememberDescription, handleRemember, buildRememberSchema } from './tools/remember.js';
import { recallSchema, recallDescription, handleRecall, buildRecallSchema } from './tools/recall.js';
import { forgetSchema, forgetDescription, handleForget } from './tools/forget.js';
import { restoreSchema, restoreDescription, handleRestore } from './tools/restore.js';
import { reflectSchema, reflectDescription, handleReflect, buildReflectSchema } from './tools/reflect.js';
import { memoriesSchema, memoriesDescription, handleMemories, buildMemoriesSchema } from './tools/memories.js';
import { categoryCreateSchema, categoryCreateDescription, handleCategoryCreate } from './tools/category-create.js';
import { categoryDeleteSchema, categoryDeleteDescription, handleCategoryDelete } from './tools/category-delete.js';
import { categoryUpdateSchema, categoryUpdateDescription, handleCategoryUpdate } from './tools/category-update.js';
import { categoryListSchema, categoryListDescription, handleCategoryList } from './tools/category-list.js';
import { syncSchema, syncDescription, handleSync } from './tools/sync.js';
import { invalidateCategoryCache, setOnExternalChange, startWatchingCategories, stopWatchingCategories, switchCategoryConnection, initCategoryCache } from './services/categories.js';

// Register all tools on a given McpServer instance.
// Returns references needed for dynamic schema refresh.
export function registerTools(server: McpServer) {
  const rememberTool = server.tool('remember', rememberDescription, rememberSchema, handleRemember);
  const recallTool = server.tool('recall', recallDescription, recallSchema, handleRecall);
  server.tool('forget', forgetDescription, forgetSchema, handleForget);
  server.tool('restore', restoreDescription, restoreSchema, handleRestore);
  const reflectTool = server.tool('reflect', reflectDescription, reflectSchema, handleReflect);
  const memoriesTool = server.tool('memories', memoriesDescription, memoriesSchema, handleMemories);
  server.tool('category_create', categoryCreateDescription, categoryCreateSchema, handleCategoryCreate);
  server.tool('category_update', categoryUpdateDescription, categoryUpdateSchema, handleCategoryUpdate);
  server.tool('category_delete', categoryDeleteDescription, categoryDeleteSchema, handleCategoryDelete);
  server.tool('category_list', categoryListDescription, categoryListSchema, handleCategoryList);
  server.tool('sync', syncDescription, syncSchema, handleSync);
  return { rememberTool, recallTool, reflectTool, memoriesTool };
}

// Create a fully configured McpServer with all tools registered.
export function createMcpServer() {
  const server = new McpServer({ name: 'claude-memory', version: '1.1.0' });
  registerTools(server);
  return server;
}

const server = new McpServer({
  name: 'claude-memory',
  version: '1.1.0',
});

const { rememberTool, recallTool, reflectTool, memoriesTool } = registerTools(server);

// Refresh all tool schemas that reference category descriptions.
// Called after any category change so Claude sees updated guidelines.
export function refreshCategorySchemas() {
  invalidateCategoryCache();
  rememberTool.update({ paramsSchema: buildRememberSchema() });
  recallTool.update({ paramsSchema: buildRecallSchema() });
  reflectTool.update({ paramsSchema: buildReflectSchema() });
  memoriesTool.update({ paramsSchema: buildMemoriesSchema() });
}

let connectionsWatcher: fs.FSWatcher | null = null;

async function main() {
  try {
    await ensureCollection();
  } catch (err) {
    console.error(
      'Warning: Could not connect to Qdrant on startup.',
      err instanceof Error ? err.message : err
    );
  }

  // Initialize per-connection category cache (may fetch from Qdrant or migrate from global file)
  await initCategoryCache();

  // Set up file watcher for external category changes
  setOnExternalChange(() => {
    console.error('Categories changed externally, refreshing schemas...');
    refreshCategorySchemas();
    // Notify Claude Code that tool schemas have changed
    server.server.notification({
      method: 'notifications/tools/list_changed',
    }).catch((err) => {
      console.error('Failed to send tools/list_changed notification:', err);
    });
  });
  startWatchingCategories();

  // Watch .env for active connection changes
  // Debounced to handle Windows fs.watch firing multiple events per write
  let envSwitchTimeout: NodeJS.Timeout | null = null;
  let lastQdrantActive = process.env.QDRANT_ACTIVE || '';
  try {
    const envPath = getEnvPath();
    connectionsWatcher = fs.watch(envPath, (eventType) => {
      if (eventType === 'change') {
        if (envSwitchTimeout) clearTimeout(envSwitchTimeout);
        envSwitchTimeout = setTimeout(async () => {
          // Re-read .env to update process.env
          try {
            const content = fs.readFileSync(envPath, 'utf-8');
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const eq = trimmed.indexOf('=');
              if (eq === -1) continue;
              process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
            }
          } catch { /* ignore read errors */ }

          // Check if the active Qdrant connection changed
          const newActive = process.env.QDRANT_ACTIVE || '';
          if (newActive !== lastQdrantActive) {
            lastQdrantActive = newActive;
            console.error('Active Qdrant connection changed, switching...');
            await switchCategoryConnection();
            refreshCategorySchemas();
            server.server.notification({
              method: 'notifications/tools/list_changed',
            }).catch((err) => {
              console.error('Failed to send tools/list_changed notification:', err);
            });
          }
        }, 300);
      }
    });
  } catch (err) {
    console.error('Could not watch .env for connection changes:', err);
  }

  // Clean up file watchers on exit
  process.on('SIGINT', () => {
    stopWatchingCategories();
    connectionsWatcher?.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopWatchingCategories();
    connectionsWatcher?.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start stdio transport when run directly (not when imported by http.ts)
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/index.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('/preload.js');
if (isMain) {
  main().catch((err) => {
    console.error('Fatal error starting memory server:', err);
    process.exit(1);
  });
}
