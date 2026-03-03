import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDatabase, closeDatabase } from './services/sqlite.js';
import { warmupEmbeddings } from './services/local-embeddings.js';
import { rememberSchema, rememberDescription, handleRemember, buildRememberSchema } from './tools/remember.js';
import { recallSchema, recallDescription, handleRecall, buildRecallSchema } from './tools/recall.js';
import { forgetSchema, forgetDescription, handleForget } from './tools/forget.js';
import { restoreSchema, restoreDescription, handleRestore } from './tools/restore.js';
import { reflectSchema, reflectDescription, handleReflect, buildReflectSchema } from './tools/reflect.js';
import { memoriesSchema, memoriesDescription, handleMemories, buildMemoriesSchema } from './tools/memories.js';
import { categorySchema, categoryDescription, handleCategory } from './tools/category.js';
import { syncSchema, syncDescription, handleSync } from './tools/sync.js';
import { loopSchema, loopDescription, handleLoop } from './tools/loop.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerWhiteboardTools } from './tools/whiteboard.js';
import { registerCardTools } from './tools/card.js';
import { invalidateCategoryCache, setOnExternalChange, startWatchingCategories, stopWatchingCategories, initCategoryCache } from './services/categories.js';

function buildServerInstructions(): string {
  return `SynaBun — persistent vector memory system for Claude Code sessions.

Tool groups:
- Memory: remember, recall, reflect, forget, restore, memories
- Categories: category (action: create/update/delete/list)
- Browser: browser_navigate, browser_click, browser_type, browser_fill, browser_snapshot, browser_screenshot, browser_content, browser_evaluate, browser_hover, browser_select, browser_press, browser_wait, browser_go_back, browser_go_forward, browser_session
- Whiteboard: whiteboard_read, whiteboard_add, whiteboard_update, whiteboard_remove, whiteboard_screenshot
- Cards: card_list, card_open, card_close, card_update, card_screenshot
- Sync: sync
- Loop: loop (action: start/stop/status)

Use "category" with action "list" to see valid category names before using remember/recall/reflect.`;
}

// Register all tools on a given McpServer instance.
// Returns references needed for dynamic schema refresh.
export function registerTools(server: McpServer) {
  const rememberTool = server.tool('remember', rememberDescription, rememberSchema, handleRemember);
  const recallTool = server.tool('recall', recallDescription, recallSchema, handleRecall);
  server.tool('forget', forgetDescription, forgetSchema, handleForget);
  server.tool('restore', restoreDescription, restoreSchema, handleRestore);
  const reflectTool = server.tool('reflect', reflectDescription, reflectSchema, handleReflect);
  const memoriesTool = server.tool('memories', memoriesDescription, memoriesSchema, handleMemories);
  server.tool('category', categoryDescription, categorySchema, handleCategory);
  server.tool('sync', syncDescription, syncSchema, handleSync);
  server.tool('loop', loopDescription, loopSchema, handleLoop);
  registerBrowserTools(server);
  registerWhiteboardTools(server);
  registerCardTools(server);
  return { rememberTool, recallTool, reflectTool, memoriesTool };
}

// Create a fully configured McpServer with all tools registered.
export function createMcpServer() {
  const server = new McpServer(
    { name: 'claude-memory', version: '1.1.0' },
    { instructions: buildServerInstructions() }
  );
  registerTools(server);
  return server;
}

const server = new McpServer(
  { name: 'claude-memory', version: '1.1.0' },
  { instructions: buildServerInstructions() }
);

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

async function main() {
  try {
    await ensureDatabase();
  } catch (err) {
    console.error(
      'Warning: Could not initialize SQLite database on startup.',
      err instanceof Error ? err.message : err
    );
  }

  // Warmup embedding model in background (non-blocking)
  warmupEmbeddings().catch((err) => {
    console.error('Embedding model warmup failed:', err instanceof Error ? err.message : err);
  });

  // Initialize category cache (loads from SQLite or starts empty)
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

  // No .env watcher needed — SQLite uses a single local database file

  // Clean up on exit
  process.on('SIGINT', () => {
    stopWatchingCategories();
    closeDatabase();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopWatchingCategories();
    closeDatabase();
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
