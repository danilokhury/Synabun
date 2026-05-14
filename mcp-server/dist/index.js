import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDatabase, closeDatabase, reopenDatabase } from './services/sqlite.js';
import { rememberDescription, handleRemember, buildRememberSchema } from './tools/remember.js';
import { recallDescription, handleRecall, buildRecallSchema } from './tools/recall.js';
import { forgetSchema, forgetDescription, handleForget } from './tools/forget.js';
import { restoreSchema, restoreDescription, handleRestore } from './tools/restore.js';
import { reflectDescription, handleReflect, buildReflectSchema } from './tools/reflect.js';
import { memoriesDescription, handleMemories, buildMemoriesSchema } from './tools/memories.js';
import { categorySchema, categoryDescription, handleCategory } from './tools/category.js';
import { syncSchema, syncDescription, handleSync } from './tools/sync.js';
import { loopSchema, loopDescription, handleLoop } from './tools/loop.js';
import { registerBrowserCoreTools, registerBrowserTwitterTools, registerBrowserFacebookTools, registerBrowserTiktokTools, registerBrowserWhatsappTools, registerBrowserInstagramTools, registerBrowserLinkedinTools, } from './tools/browser.js';
import { registerWhiteboardTools } from './tools/whiteboard.js';
import { registerCardTools } from './tools/card.js';
import { registerTicTacToeTools } from './tools/tictactoe.js';
import { registerDiscordTools } from './tools/discord.js';
import { registerGitTools } from './tools/git.js';
import { registerLeonardoTools } from './tools/leonardo.js';
import { registerImageTools } from './tools/image.js';
import { registerGscTools } from './tools/gsc.js';
import { profileSchema, profileDescription, handleProfile } from './tools/profile.js';
import { PROFILE_PRESETS, VALID_GROUPS, PROFILE_PATH, resolveProfileGroups, readInitialProfile, getActiveProfile, getActiveProfileName, getActiveGroups, setActiveState, setToolGroup, applyProfile, persistProfile, isClaudeCode, setOnProfileChanged, } from './services/profiles.js';
import { invalidateCategoryCache, setOnExternalChange, startWatchingCategories, stopWatchingCategories, initCategoryCache } from './services/categories.js';
import { getEnvPath, config } from './config.js';
import { readFileSync, writeFileSync, watch, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
// Re-export profile API for external consumers (http.ts, etc.)
export { PROFILE_PRESETS, VALID_GROUPS, resolveProfileGroups, getActiveProfile, applyProfile, persistProfile };
// ── Tool Profile System ──────────────────────────────────────────────
// Dynamic profile switching — all tools registered at startup, toggled via enable/disable.
// Profile can be changed at runtime via the `profile` MCP tool or by writing to active-profile.json.
const TOOL_GROUP_INSTRUCTIONS = {
    browser: '- Browser (core): browser_navigate, browser_click, browser_type, browser_fill, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_go_back, browser_go_forward, browser_reload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session',
    browser_twitter: '- Twitter/X: browser_extract_tweets',
    browser_facebook: '- Facebook: browser_extract_fb_posts',
    browser_tiktok: '- TikTok: browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile',
    browser_whatsapp: '- WhatsApp: browser_extract_wa_chats, browser_extract_wa_messages',
    browser_instagram: '- Instagram: browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search',
    browser_linkedin: '- LinkedIn: browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network, browser_extract_li_jobs',
    whiteboard: '- Whiteboard: whiteboard_read, whiteboard_add, whiteboard_update, whiteboard_remove, whiteboard_screenshot',
    card: '- Cards: card_list, card_open, card_close, card_update, card_screenshot',
    tictactoe: '- TicTacToe: tictactoe (action: start/move/state/end)',
    discord: '- Discord: discord_guild, discord_channel, discord_role, discord_message, discord_member, discord_onboarding, discord_webhook, discord_thread',
    git: '- Git: git (action: status/diff/commit/log/branches)',
    image: '- Images: image_staged (action: list/clear/remove)',
    leonardo: '- Leonardo (browser-based): leonardo_browser_navigate, leonardo_browser_generate, leonardo_browser_library, leonardo_browser_download, leonardo_browser_reference',
    gsc: '- Google Search Console (browser-based): gsc_navigate, gsc_property, gsc_inspect_url, gsc_inspect_test_live, gsc_inspect_request_indexing, gsc_inspect_view_crawled, gsc_performance_query, gsc_performance_export, gsc_performance_chart_screenshot, gsc_pages_report, gsc_pages_validate_fix, gsc_videos_report, gsc_sitemap, gsc_removals, gsc_removals_cancel, gsc_cwv_report, gsc_https_report, gsc_security_issues, gsc_manual_actions, gsc_enhancements, gsc_links_report, gsc_links_export, gsc_settings, gsc_crawl_stats, gsc_users, gsc_associations, gsc_disavow, gsc_shopping, gsc_extract_table, gsc_screenshot',
};
function buildServerInstructions() {
    const activeGroups = getActiveGroups();
    const groupLines = [];
    for (const [group, line] of Object.entries(TOOL_GROUP_INSTRUCTIONS)) {
        if (activeGroups.has(group))
            groupLines.push(line);
    }
    let instructions = `SynaBun — persistent vector memory system.

IMPORTANT: Tool names below are base names. Your host prefixes them (e.g. "SynaBun_remember" in OpenCode, "mcp__SynaBun__remember" in Claude Code). Always use the EXACT tool names from your available tools list. Never invent tool names or use colon-separated names.

Tool groups:
- Memory: remember, recall, reflect, forget, restore, memories
- Categories: category (action: create/update/delete/list)
- Profile: profile (action: get/set) — switch tool profiles at runtime
${groupLines.join('\n')}
- Sync: sync
- Loop: loop (action: start/stop/status)

Use "category" with action "list" to see valid category names before using remember/recall/reflect.`;
    if (activeGroups.has('discord')) {
        instructions += `\n\nDiscord tools require DISCORD_BOT_TOKEN in .env. Set DISCORD_GUILD_ID for default guild. Each tool uses an "action" parameter to select the operation.`;
    }
    if (activeGroups.has('leonardo')) {
        instructions += `\n\nLeonardo tools are 100% browser-based — no API key needed. Use leonardo_browser_navigate to go to the right page, then use generic browser tools (browser_click, browser_fill, browser_snapshot) to configure settings (model, style, dimensions, motion controls), and leonardo_browser_generate to fill the prompt and click Generate. Use the /leonardo skill for the full guided creation experience.`;
    }
    // Dedupe this log — buildServerInstructions runs on every HTTP MCP request
    // (fresh server per request), which would otherwise spam this line forever.
    const profileName = getActiveProfileName();
    const sig = `${profileName}|${activeGroups.size}|${instructions.length}`;
    if (sig !== _lastInstructionsSig) {
        _lastInstructionsSig = sig;
        console.error(`[SynaBun] Profile: ${profileName} (${activeGroups.size} groups, instructions: ${instructions.length} chars)`);
    }
    return instructions;
}
let _lastInstructionsSig = null;
// Register ALL tools on a given McpServer instance.
// All groups are always registered; applyProfile() enables/disables them.
export function registerTools(server) {
    // Core memory tools — always registered and always enabled
    // Use build*Schema() instead of module-level constants so HTTP transport
    // (fresh server per request) always reads current display-settings.json.
    const rememberTool = server.tool('remember', rememberDescription, buildRememberSchema(), handleRemember);
    const recallTool = server.tool('recall', recallDescription, buildRecallSchema(), handleRecall);
    server.tool('forget', forgetDescription, forgetSchema, handleForget);
    server.tool('restore', restoreDescription, restoreSchema, handleRestore);
    const reflectTool = server.tool('reflect', reflectDescription, buildReflectSchema(), handleReflect);
    const memoriesTool = server.tool('memories', memoriesDescription, buildMemoriesSchema(), handleMemories);
    server.tool('category', categoryDescription, categorySchema, handleCategory);
    server.tool('sync', syncDescription, syncSchema, handleSync);
    server.tool('loop', loopDescription, loopSchema, handleLoop);
    server.tool('profile', profileDescription, profileSchema, handleProfile);
    // Register ALL optional tool groups unconditionally, store refs for enable/disable
    setToolGroup('browser', registerBrowserCoreTools(server));
    setToolGroup('browser_twitter', registerBrowserTwitterTools(server));
    setToolGroup('browser_facebook', registerBrowserFacebookTools(server));
    setToolGroup('browser_tiktok', registerBrowserTiktokTools(server));
    setToolGroup('browser_whatsapp', registerBrowserWhatsappTools(server));
    setToolGroup('browser_instagram', registerBrowserInstagramTools(server));
    setToolGroup('browser_linkedin', registerBrowserLinkedinTools(server));
    setToolGroup('whiteboard', registerWhiteboardTools(server));
    setToolGroup('card', registerCardTools(server));
    setToolGroup('tictactoe', registerTicTacToeTools(server));
    setToolGroup('discord', registerDiscordTools(server));
    setToolGroup('git', registerGitTools(server));
    setToolGroup('leonardo', registerLeonardoTools(server));
    setToolGroup('image', registerImageTools(server));
    setToolGroup('gsc', registerGscTools(server));
    // Apply initial profile (disables groups not in the active profile).
    // The notifier is registered AFTER this call so the initial sweep doesn't
    // emit a spurious tools/list_changed before the client has even subscribed.
    applyProfile(getActiveProfileName());
    // From now on, any applyProfile() (file-watcher path or `profile` MCP tool)
    // emits a single coalesced notifications/tools/list_changed instead of one
    // event per tool flipped — required because some MCP clients (OpenCode SDK)
    // abort the in-flight tool roundtrip on a notification storm.
    setOnProfileChanged(() => {
        server.server.notification({
            method: 'notifications/tools/list_changed',
        }).catch((err) => {
            console.error('[SynaBun] profile tools/list_changed notify failed:', err);
        });
    });
    return { rememberTool, recallTool, reflectTool, memoriesTool };
}
// ── Tool Usage Tracking ──────────────────────────────────────────────
// Lightweight file-based counter — tracks which tools are actually called.
// Writes to <dataDir>/tool-usage.json with debounced persistence.
const USAGE_PATH = join(config.dataDir, 'tool-usage.json');
let _usageCounts = {};
let _usageDirty = false;
let _usageFlushTimer = null;
function loadUsageCounts() {
    try {
        if (existsSync(USAGE_PATH)) {
            _usageCounts = JSON.parse(readFileSync(USAGE_PATH, 'utf-8'));
        }
    }
    catch {
        _usageCounts = {};
    }
}
function flushUsageCounts() {
    if (!_usageDirty)
        return;
    try {
        const dir = join(USAGE_PATH, '..');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        writeFileSync(USAGE_PATH, JSON.stringify(_usageCounts, null, 2) + '\n', 'utf-8');
        _usageDirty = false;
    }
    catch (err) {
        console.error('[SynaBun] Failed to flush tool usage:', err);
    }
}
export function trackToolUsage(toolName) {
    _usageCounts[toolName] = (_usageCounts[toolName] || 0) + 1;
    _usageDirty = true;
    if (_usageFlushTimer)
        clearTimeout(_usageFlushTimer);
    _usageFlushTimer = setTimeout(flushUsageCounts, 10_000);
}
export function getToolUsageSummary() {
    const profile = getActiveProfileName();
    const totalCalls = Object.values(_usageCounts).reduce((a, b) => a + b, 0);
    const usedTools = Object.keys(_usageCounts).length;
    const activeGroups = getActiveGroups();
    const registeredGroups = Array.from(activeGroups);
    // Determine which groups have actually been used
    const groupToolPrefixes = {
        browser: ['browser_navigate', 'browser_go_', 'browser_reload', 'browser_click', 'browser_fill', 'browser_type', 'browser_hover', 'browser_select', 'browser_press', 'browser_scroll', 'browser_upload', 'browser_snapshot', 'browser_content', 'browser_screenshot', 'browser_evaluate', 'browser_wait', 'browser_session'],
        browser_twitter: ['browser_extract_tweets'],
        browser_facebook: ['browser_extract_fb_'],
        browser_tiktok: ['browser_extract_tiktok_'],
        browser_whatsapp: ['browser_extract_wa_'],
        browser_instagram: ['browser_extract_ig_'],
        browser_linkedin: ['browser_extract_li_'],
        whiteboard: ['whiteboard_'],
        card: ['card_'],
        tictactoe: ['tictactoe'],
        discord: ['discord_'],
        git: ['git'],
        leonardo: ['leonardo_'],
        image: ['image_staged'],
        gsc: ['gsc_'],
    };
    const usedGroups = new Set();
    for (const tool of Object.keys(_usageCounts)) {
        for (const [group, prefixes] of Object.entries(groupToolPrefixes)) {
            if (prefixes.some(p => tool.startsWith(p)))
                usedGroups.add(group);
        }
    }
    let recommendation = '';
    if (profile === 'full' && totalCalls > 20) {
        const unusedGroups = registeredGroups.filter(g => !usedGroups.has(g));
        if (unusedGroups.length > 0) {
            const neededGroups = registeredGroups.filter(g => usedGroups.has(g));
            if (neededGroups.length <= 2) {
                recommendation = `You're using ${usedTools} tools — consider switching to "core" profile (saves ~${74 - 11} tool schemas).`;
            }
            else {
                recommendation = `Unused groups: ${unusedGroups.join(', ')}. Consider a custom profile: "${neededGroups.join(',')}".`;
            }
        }
    }
    return { counts: { ..._usageCounts }, profile, activeGroups: registeredGroups, recommendation };
}
// Load usage counts on startup
loadUsageCounts();
// Create a fully configured McpServer with all tools registered.
// Used by HTTP transport (stateless, fresh server per request).
// `forceProfile` overrides the file/env profile — HTTP transport passes 'full'
// because HTTP clients (Claude Code) have ToolSearch / deferred loading and
// don't need eager profile restriction. Stdio clients (Codex, OpenCode) keep
// using readInitialProfile() via the singleton at the bottom of this file.
export function createMcpServer(forceProfile) {
    const initialProfile = forceProfile ?? readInitialProfile();
    setActiveState(initialProfile, resolveProfileGroups(initialProfile));
    const server = new McpServer({ name: 'claude-memory', version: '1.1.0' }, { instructions: buildServerInstructions() });
    registerTools(server);
    return server;
}
// ── Main stdio server instance ──
const _initialProfile = readInitialProfile();
setActiveState(_initialProfile, resolveProfileGroups(_initialProfile));
const server = new McpServer({ name: 'claude-memory', version: '1.1.0' }, { instructions: buildServerInstructions() });
const { rememberTool, recallTool, reflectTool, memoriesTool } = registerTools(server);
// ── Wire tool usage tracking into low-level server ──
// Intercept tool call notifications to count usage per tool name.
const _origToolCallHandler = server.server._requestHandlers?.get('tools/call');
if (_origToolCallHandler) {
    server.server._requestHandlers.set('tools/call', (request, extra) => {
        const toolName = request?.params?.name;
        if (toolName)
            trackToolUsage(toolName);
        return _origToolCallHandler(request, extra);
    });
}
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
    // Watch active-profile.json for UI-driven profile changes.
    // Skip for Claude Code — it has ToolSearch, always runs full profile.
    let profileWatcher = null;
    if (!isClaudeCode()) {
        startProfileWatcher();
    }
    else {
        console.error('[SynaBun] Claude Code detected — skipping profile file watcher (always full)');
    }
    function startProfileWatcher() {
        // Create file if it doesn't exist so we can watch it
        if (!existsSync(PROFILE_PATH)) {
            persistProfile(getActiveProfileName());
        }
        try {
            let debounce = null;
            profileWatcher = watch(PROFILE_PATH, () => {
                if (debounce)
                    clearTimeout(debounce);
                debounce = setTimeout(() => {
                    try {
                        const data = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8'));
                        const newProfile = data.profile;
                        if (newProfile && typeof newProfile === 'string' && newProfile !== getActiveProfileName()) {
                            console.error(`[SynaBun] Profile file changed: ${getActiveProfileName()} → ${newProfile}`);
                            applyProfile(newProfile);
                        }
                    }
                    catch (err) {
                        console.error('[SynaBun] Profile file read error:', err);
                    }
                }, 300);
            });
        }
        catch (err) {
            console.error('[SynaBun] Failed to watch profile file:', err);
        }
    }
    // Watch display-settings.json for recall settings changes from Neural Interface
    let settingsWatcher = null;
    const displaySettingsPath = join(config.dataDir, 'display-settings.json');
    if (existsSync(displaySettingsPath)) {
        startSettingsWatcher();
    }
    function startSettingsWatcher() {
        try {
            let debounce = null;
            settingsWatcher = watch(displaySettingsPath, () => {
                if (debounce)
                    clearTimeout(debounce);
                debounce = setTimeout(() => {
                    console.error('[SynaBun] display-settings.json changed, refreshing recall schema...');
                    refreshCategorySchemas();
                    server.server.notification({
                        method: 'notifications/tools/list_changed',
                    }).catch((err) => {
                        console.error('Failed to send tools/list_changed notification:', err);
                    });
                }, 300);
            });
        }
        catch (err) {
            console.error('[SynaBun] Failed to watch display-settings.json:', err);
        }
    }
    // Clean up on exit
    process.on('SIGINT', () => {
        flushUsageCounts();
        if (envWatcher)
            envWatcher.close();
        if (profileWatcher)
            profileWatcher.close();
        if (settingsWatcher)
            settingsWatcher.close();
        stopWatchingCategories();
        closeDatabase();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        flushUsageCounts();
        if (envWatcher)
            envWatcher.close();
        if (profileWatcher)
            profileWatcher.close();
        if (settingsWatcher)
            settingsWatcher.close();
        stopWatchingCategories();
        closeDatabase();
        process.exit(0);
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
// Only start stdio transport when run directly (not when imported by http.ts)
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('/index.js')
    || process.argv[1]?.replace(/\\/g, '/').endsWith('/preload.js')
    || process.argv[1]?.replace(/\\/g, '/').endsWith('/run.mjs');
if (isMain) {
    main().catch((err) => {
        console.error('Fatal error starting memory server:', err);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map