import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDatabase, closeDatabase, reopenDatabase } from './services/sqlite.js';
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
import { registerTicTacToeTools } from './tools/tictactoe.js';
import { registerDiscordTools } from './tools/discord.js';
import { registerGitTools } from './tools/git.js';
import { registerLeonardoTools } from './tools/leonardo.js';
import { registerImageTools } from './tools/image.js';
import { invalidateCategoryCache, setOnExternalChange, startWatchingCategories, stopWatchingCategories, initCategoryCache } from './services/categories.js';
import { getEnvPath } from './config.js';
import { readFileSync, watch, existsSync } from 'fs';
function buildServerInstructions() {
    return `SynaBun — persistent vector memory system for Claude Code sessions.

Tool groups:
- Memory: remember, recall, reflect, forget, restore, memories
- Categories: category (action: create/update/delete/list)
- Browser: browser_navigate, browser_click, browser_type, browser_fill, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_go_back, browser_go_forward, browser_reload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session, browser_extract_tweets, browser_extract_fb_posts, browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile, browser_extract_wa_chats, browser_extract_wa_messages, browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search, browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network, browser_extract_li_jobs
- Whiteboard: whiteboard_read, whiteboard_add, whiteboard_update, whiteboard_remove, whiteboard_screenshot
- Cards: card_list, card_open, card_close, card_update, card_screenshot
- TicTacToe: tictactoe (action: start/move/state/end)
- Sync: sync
- Loop: loop (action: start/stop/status)
- Git: git (action: status/diff/commit/log/branches)
- Discord: discord_guild, discord_channel, discord_role, discord_message, discord_member, discord_onboarding, discord_webhook, discord_thread
- Images: image_staged (action: list/clear/remove)
- Leonardo (browser-based): leonardo_browser_navigate, leonardo_browser_generate, leonardo_browser_library, leonardo_browser_download, leonardo_browser_reference

Use "category" with action "list" to see valid category names before using remember/recall/reflect.

Discord tools require DISCORD_BOT_TOKEN in .env. Set DISCORD_GUILD_ID for default guild. Each tool uses an "action" parameter to select the operation.

Leonardo tools are 100% browser-based — no API key needed. Use leonardo_browser_navigate to go to the right page, then use generic browser tools (browser_click, browser_fill, browser_snapshot) to configure settings (model, style, dimensions, motion controls), and leonardo_browser_generate to fill the prompt and click Generate. Use the /leonardo skill for the full guided creation experience.`;
}
// Register all tools on a given McpServer instance.
// Returns references needed for dynamic schema refresh.
export function registerTools(server) {
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
    registerTicTacToeTools(server);
    registerDiscordTools(server);
    registerGitTools(server);
    registerLeonardoTools(server);
    registerImageTools(server);
    return { rememberTool, recallTool, reflectTool, memoriesTool };
}
// Create a fully configured McpServer with all tools registered.
export function createMcpServer() {
    const server = new McpServer({ name: 'claude-memory', version: '1.1.0' }, { instructions: buildServerInstructions() });
    registerTools(server);
    return server;
}
const server = new McpServer({ name: 'claude-memory', version: '1.1.0' }, { instructions: buildServerInstructions() });
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
    }
    catch (err) {
        console.error('Warning: Could not initialize SQLite database on startup.', err instanceof Error ? err.message : err);
    }
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
    // Watch .env for SQLITE_DB_PATH changes (e.g. from onboarding or settings)
    const envPath = getEnvPath();
    let envWatcher = null;
    if (existsSync(envPath)) {
        startEnvWatcher();
    }
    else {
        // .env doesn't exist yet — poll until it appears, then start watching
        const envPollInterval = setInterval(() => {
            if (existsSync(envPath)) {
                clearInterval(envPollInterval);
                startEnvWatcher();
            }
        }, 5000);
        envPollInterval.unref();
    }
    function startEnvWatcher() {
        try {
            let debounce = null;
            envWatcher = watch(envPath, () => {
                if (debounce)
                    clearTimeout(debounce);
                debounce = setTimeout(() => {
                    try {
                        const content = readFileSync(envPath, 'utf-8');
                        const vars = {};
                        for (const line of content.split('\n')) {
                            const trimmed = line.trim();
                            if (!trimmed || trimmed.startsWith('#'))
                                continue;
                            const eq = trimmed.indexOf('=');
                            if (eq === -1)
                                continue;
                            vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
                        }
                        const newDbPath = vars['SQLITE_DB_PATH'];
                        const currentDbPath = process.env.SQLITE_DB_PATH || '';
                        if (newDbPath && newDbPath !== currentDbPath) {
                            console.error(`SQLITE_DB_PATH changed: ${currentDbPath || '(default)'} → ${newDbPath}`);
                            process.env.SQLITE_DB_PATH = newDbPath;
                            reopenDatabase().catch((err) => {
                                console.error('Failed to reopen database at new path:', err);
                            });
                        }
                    }
                    catch (err) {
                        console.error('.env reload error:', err);
                    }
                }, 500);
            });
        }
        catch (err) {
            console.error('Failed to watch .env:', err);
        }
    }
    // Clean up on exit
    process.on('SIGINT', () => {
        if (envWatcher)
            envWatcher.close();
        stopWatchingCategories();
        closeDatabase();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        if (envWatcher)
            envWatcher.close();
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
//# sourceMappingURL=index.js.map