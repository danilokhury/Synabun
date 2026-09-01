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
import {
  registerBrowserCoreTools, registerBrowserTwitterTools, registerBrowserFacebookTools,
  registerBrowserTiktokTools, registerBrowserWhatsappTools, registerBrowserInstagramTools,
  registerBrowserLinkedinTools, registerBlueskyTools,
} from './tools/browser.js';
import { registerWhiteboardTools } from './tools/whiteboard.js';
import { registerCardTools } from './tools/card.js';
import { registerTicTacToeTools } from './tools/tictactoe.js';
import { registerDiscordTools } from './tools/discord.js';
import { registerGitTools } from './tools/git.js';
import { registerLeonardoTools } from './tools/leonardo.js';
import { registerImageTools } from './tools/image.js';
import { registerGscTools } from './tools/gsc.js';
import { registerYoutubeTools } from './tools/youtube.js';
import { registerStyleGuideTools } from './tools/style-guide.js';
import { registerMoreLoginTools } from './tools/morelogin.js';
import { profileSchema, profileDescription, handleProfile } from './tools/profile.js';
import { choiceSchema, choiceDescription, handleChoice } from './tools/choice.js';
import {
  PROFILE_PRESETS, VALID_GROUPS, ProfileRuntime,
  resolveProfileGroups, readInitialProfile, persistProfile, isClaudeCode,
  logCodexConfigNoticeOnce,
} from './services/profiles.js';
import { invalidateCategoryCache, setOnExternalChange, startWatchingCategories, stopWatchingCategories, initCategoryCache } from './services/categories.js';
import { healCodexConfig } from './services/codex-config-heal.js';
import { getEnvPath, config } from './config.js';
import { readFileSync, writeFileSync, watch, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Re-export profile API for external consumers (http.ts, etc.)
export { PROFILE_PRESETS, VALID_GROUPS, ProfileRuntime, resolveProfileGroups, persistProfile };

// ── Tool Profile System ──────────────────────────────────────────────
// Dynamic profile switching — all tools registered at startup, toggled via enable/disable.
// Each MCP server runtime owns its live profile. active-profile.json is read
// only at startup as the default for future processes; it is never a
// cross-process runtime signal. The `profile` MCP tool changes only its server.

const TOOL_GROUP_INSTRUCTIONS: Record<string, string> = {
  browser: '- Browser (core): browser_navigate, browser_click, browser_type, browser_fill, browser_hover, browser_select, browser_press, browser_scroll, browser_upload, browser_go_back, browser_go_forward, browser_reload, browser_snapshot, browser_content, browser_screenshot, browser_evaluate, browser_wait, browser_session',
  browser_twitter: '- Twitter/X: browser_extract_tweets, browser_x_compose_state (read-only compose probe — quote-card/submit-button/modal state before posting; loop tabs also get a server-side gate that blocks a quote misfiring into a bare reply)',
  browser_facebook: '- Facebook: browser_extract_fb_posts, browser_fb_composer_state, browser_extract_fb_groups, fb_groups (structured group directory + per-group posting checklist: worklist/mark/import/exclude/list/stats)',
  browser_tiktok: '- TikTok: browser_extract_tiktok_videos, browser_extract_tiktok_search, browser_extract_tiktok_studio, browser_extract_tiktok_profile',
  browser_whatsapp: '- WhatsApp: browser_extract_wa_chats, browser_extract_wa_messages',
  browser_instagram: '- Instagram: browser_extract_ig_feed, browser_extract_ig_profile, browser_extract_ig_post, browser_extract_ig_reels, browser_extract_ig_search',
  browser_linkedin: '- LinkedIn: browser_extract_li_feed, browser_extract_li_profile, browser_extract_li_post, browser_extract_li_notifications, browser_extract_li_messages, browser_extract_li_search_people, browser_extract_li_network, browser_extract_li_jobs',
  browser_bluesky: '- BlueSky (AT Protocol, full control — needs a browser context logged in to bsky.app; blank assigned tabs initialize safely at bsky.app): bluesky_session, bluesky_timeline, bluesky_author_feed, bluesky_thread, bluesky_profile, bluesky_search_posts, bluesky_search_actors, bluesky_notifications, bluesky_graph, bluesky_likes, bluesky_feed, bluesky_post (text/reply/quote/images), bluesky_action (like/repost/follow/mute/block/delete + undos), bluesky_resolve, bluesky_dm. Calls the XRPC API directly via the page session — reliable + token-efficient, no DOM scraping.',
  whiteboard: '- Whiteboard: whiteboard_read, whiteboard_add, whiteboard_update, whiteboard_remove, whiteboard_screenshot',
  card: '- Cards: card_list, card_open, card_close, card_update, card_screenshot',
  tictactoe: '- TicTacToe: tictactoe (action: start/move/state/end)',
  discord: '- Discord: discord_guild, discord_channel, discord_role, discord_message, discord_member, discord_onboarding, discord_webhook, discord_thread',
  git: '- Git: git (action: status/diff/commit/log/branches)',
  morelogin: '- MoreLogin (anti-detect browser): morelogin (action: status/list/create/start/stop/use_default). Set a profile as the default AI browser with use_default — afterwards all browser_* tools drive that MoreLogin profile. Needs the MoreLogin desktop app running.',
  image: '- Images: image_staged (action: list/clear/remove)',
  leonardo: '- Leonardo (browser-based): leonardo_browser_navigate, leonardo_browser_generate, leonardo_browser_library, leonardo_browser_download, leonardo_browser_reference',
  gsc: '- Google Search Console (browser-based): gsc_navigate, gsc_property, gsc_inspect_url, gsc_inspect_test_live, gsc_inspect_request_indexing, gsc_inspect_view_crawled, gsc_performance_query, gsc_performance_export, gsc_performance_chart_screenshot, gsc_pages_report, gsc_pages_validate_fix, gsc_videos_report, gsc_sitemap, gsc_removals, gsc_removals_cancel, gsc_cwv_report, gsc_https_report, gsc_security_issues, gsc_manual_actions, gsc_enhancements, gsc_links_report, gsc_links_export, gsc_settings, gsc_crawl_stats, gsc_users, gsc_associations, gsc_disavow, gsc_shopping, gsc_extract_table, gsc_screenshot',
  styleguide: '- Style Guide: style_guide (action: get/list) — per-project visual identity (colors, typography, shape/spacing, logo). ALWAYS call this before generating UI, design copy, marketing assets, or any creative work tied to a project.',
};

function buildServerInstructions(runtime: ProfileRuntime): string {
  const activeGroups = runtime.getActiveGroups();
  const groupLines: string[] = [];
  for (const [group, line] of Object.entries(TOOL_GROUP_INSTRUCTIONS)) {
    if (activeGroups.has(group)) groupLines.push(line);
  }

  let instructions = `SynaBun — persistent vector memory system.

IMPORTANT: Tool names below are base names. Your host prefixes them (e.g. "SynaBun_remember" in OpenCode, "mcp__SynaBun__remember" in Claude Code). Always use the EXACT tool names from your available tools list. Never invent tool names or use colon-separated names.

Tool groups:
- Memory: remember, recall, reflect, forget, restore, memories
- Categories: category (action: create/update/delete/list)
- Profile: profile (action: get/set) — always-available capability router; switches only this runtime
- Interaction: choice — blocking multiple-choice elicitation for Codex Default mode
${groupLines.join('\n')}
- Sync: sync
- Loop: loop (action: start/stop/status)

Use "category" with action "list" to see valid category names before using remember/recall/reflect.

Tool profile routing (all tool-capable hosts/models): if a task needs a SynaBun tool that is not currently listed, call "profile" with action "get", then action "set" with the narrowest suitable preset. Continue the task after the host refreshes its tool list; do not tell the user the capability is unavailable before trying. The switch is local to this sidepanel, loop, schedule, or CLI runtime and does not change other running sessions or the future-session default. Restore a temporary profile when appropriate.`;

  if (runtime.getCatalogMode() === 'deferred') {
    instructions += `\n\nCodex deferred-catalog mode: every SynaBun tool is already discoverable from the start of the turn. Profiles select the capability focus only; profile.set does not reload MCP servers or hide tools.`;
  }

  if (activeGroups.has('discord')) {
    instructions += `\n\nDiscord tools require DISCORD_BOT_TOKEN in .env. Set DISCORD_GUILD_ID for default guild. Each tool uses an "action" parameter to select the operation.`;
  }
  if (activeGroups.has('leonardo')) {
    instructions += `\n\nLeonardo tools are 100% browser-based — no API key needed. Use leonardo_browser_navigate to go to the right page, then use generic browser tools (browser_click, browser_fill, browser_snapshot) to configure settings (model, style, dimensions, motion controls), and leonardo_browser_generate to fill the prompt and click Generate. Use the /leonardo skill for the full guided creation experience.`;
  }

  // Dedupe this log — prewarming and new HTTP client sessions construct more
  // than one server in this process and would otherwise repeat the same line.
  const profileName = runtime.getActiveProfileName();
  const sig = `${profileName}|${activeGroups.size}|${instructions.length}`;
  if (sig !== _lastInstructionsSig) {
    _lastInstructionsSig = sig;
    console.error(`[SynaBun] Profile: ${profileName} (${activeGroups.size} groups, instructions: ${instructions.length} chars)`);
  }

  return instructions;
}

let _lastInstructionsSig: string | null = null;

// Register ALL tools on a given McpServer instance.
// All groups are always registered; applyProfile() enables/disables them.
export function registerTools(server: McpServer, runtime: ProfileRuntime = new ProfileRuntime(readInitialProfile())) {
  // Core memory tools — always registered and always enabled
  // Use build*Schema() instead of module-level constants so HTTP transport
  // sessions always read current display-settings.json when constructed.
  const rememberTool = server.tool('remember', rememberDescription, buildRememberSchema(), handleRemember);
  const recallTool = server.tool('recall', recallDescription, buildRecallSchema(), handleRecall);
  server.tool('forget', forgetDescription, forgetSchema, handleForget);
  server.tool('restore', restoreDescription, restoreSchema, handleRestore);
  const reflectTool = server.tool('reflect', reflectDescription, buildReflectSchema(), handleReflect);
  const memoriesTool = server.tool('memories', memoriesDescription, buildMemoriesSchema(), handleMemories);
  server.tool('category', categoryDescription, categorySchema, handleCategory);
  server.tool('sync', syncDescription, syncSchema, handleSync);
  server.tool('loop', loopDescription, loopSchema, handleLoop);
  server.tool('profile', profileDescription, profileSchema, (args) => handleProfile(runtime, args));
  server.tool('choice', choiceDescription, choiceSchema, (args) => handleChoice(server, args));

  // Register ALL optional tool groups unconditionally, store refs for enable/disable
  runtime.setToolGroup('browser',           registerBrowserCoreTools(server));
  runtime.setToolGroup('browser_twitter',   registerBrowserTwitterTools(server));
  runtime.setToolGroup('browser_facebook',  registerBrowserFacebookTools(server));
  runtime.setToolGroup('browser_tiktok',    registerBrowserTiktokTools(server));
  runtime.setToolGroup('browser_whatsapp',  registerBrowserWhatsappTools(server));
  runtime.setToolGroup('browser_instagram', registerBrowserInstagramTools(server));
  runtime.setToolGroup('browser_linkedin',  registerBrowserLinkedinTools(server));
  runtime.setToolGroup('browser_bluesky',   registerBlueskyTools(server));
  runtime.setToolGroup('whiteboard', registerWhiteboardTools(server));
  runtime.setToolGroup('card',       registerCardTools(server));
  runtime.setToolGroup('tictactoe',  registerTicTacToeTools(server));
  runtime.setToolGroup('discord',    registerDiscordTools(server));
  runtime.setToolGroup('git',        registerGitTools(server));
  runtime.setToolGroup('leonardo',   registerLeonardoTools(server));
  runtime.setToolGroup('image',      registerImageTools(server));
  runtime.setToolGroup('gsc',        registerGscTools(server));
  runtime.setToolGroup('youtube',    registerYoutubeTools(server));
  runtime.setToolGroup('styleguide', registerStyleGuideTools(server));
  runtime.setToolGroup('morelogin',  registerMoreLoginTools(server));

  // Apply initial profile (disables groups not in the active profile).
  // The notifier is registered AFTER this call so the initial sweep doesn't
  // emit a spurious tools/list_changed before the client has even subscribed.
  runtime.applyProfile(runtime.getActiveProfileName());

  // From now on, profile.set emits one delayed, coalesced list_changed instead
  // of one event per tool flipped. Some MCP clients abort the initiating tool
  // roundtrip if profile notifications arrive before its response.
  runtime.setOnProfileChanged(() => {
    server.server.notification({
      method: 'notifications/tools/list_changed',
    }).catch((err) => {
      console.error('[SynaBun] profile tools/list_changed notify failed:', err);
    });
  });
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    runtime.dispose();
    previousOnClose?.();
  };

  return { rememberTool, recallTool, reflectTool, memoriesTool, runtime };
}

// ── Tool Usage Tracking ──────────────────────────────────────────────
// Lightweight file-based counter — tracks which tools are actually called.
// Writes to <dataDir>/tool-usage.json with debounced persistence.

const USAGE_PATH = join(config.dataDir, 'tool-usage.json');
let _usageCounts: Record<string, number> = {};
let _usageDirty = false;
let _usageFlushTimer: ReturnType<typeof setTimeout> | null = null;

function loadUsageCounts() {
  try {
    if (existsSync(USAGE_PATH)) {
      _usageCounts = JSON.parse(readFileSync(USAGE_PATH, 'utf-8'));
    }
  } catch { _usageCounts = {}; }
}

function flushUsageCounts() {
  if (!_usageDirty) return;
  try {
    const dir = join(USAGE_PATH, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(USAGE_PATH, JSON.stringify(_usageCounts, null, 2) + '\n', 'utf-8');
    _usageDirty = false;
  } catch (err) {
    console.error('[SynaBun] Failed to flush tool usage:', err);
  }
}

export function trackToolUsage(toolName: string) {
  _usageCounts[toolName] = (_usageCounts[toolName] || 0) + 1;
  _usageDirty = true;
  if (_usageFlushTimer) clearTimeout(_usageFlushTimer);
  _usageFlushTimer = setTimeout(flushUsageCounts, 10_000);
}

let mainProfileRuntime: ProfileRuntime;

// Backward-compatible singleton accessors for consumers of the package entry
// point. New multi-server code should retain the ProfileRuntime returned by
// createMcpServer instead of using these stdio-runtime wrappers.
export function getActiveProfile(): { profile: string; activeGroups: string[] } {
  return mainProfileRuntime.getActiveProfile();
}

export function applyProfile(profileName: string) {
  return mainProfileRuntime.applyProfile(profileName);
}

export function getToolUsageSummary(runtime: ProfileRuntime = mainProfileRuntime): { counts: Record<string, number>; profile: string; activeGroups: string[]; recommendation: string } {
  const profile = runtime.getActiveProfileName();
  const totalCalls = Object.values(_usageCounts).reduce((a, b) => a + b, 0);
  const usedTools = Object.keys(_usageCounts).length;
  const activeGroups = runtime.getActiveGroups();
  const registeredGroups = Array.from(activeGroups);

  // Determine which groups have actually been used
  const groupToolPrefixes: Record<string, string[]> = {
    browser: ['browser_navigate', 'browser_go_', 'browser_reload', 'browser_click', 'browser_fill', 'browser_type', 'browser_hover', 'browser_select', 'browser_press', 'browser_scroll', 'browser_upload', 'browser_snapshot', 'browser_content', 'browser_screenshot', 'browser_evaluate', 'browser_wait', 'browser_session'],
    browser_twitter: ['browser_extract_tweets', 'browser_x_compose_state'],
    browser_facebook: ['browser_extract_fb_', 'browser_fb_', 'fb_groups'],
    browser_tiktok: ['browser_extract_tiktok_'],
    browser_whatsapp: ['browser_extract_wa_'],
    browser_instagram: ['browser_extract_ig_'],
    browser_linkedin: ['browser_extract_li_'],
    browser_bluesky: ['bluesky_'],
    whiteboard: ['whiteboard_'],
    card: ['card_'],
    tictactoe: ['tictactoe'],
    discord: ['discord_'],
    git: ['git'],
    leonardo: ['leonardo_'],
    image: ['image_staged'],
    gsc: ['gsc_'],
    styleguide: ['style_guide'],
  };
  const usedGroups = new Set<string>();
  for (const tool of Object.keys(_usageCounts)) {
    for (const [group, prefixes] of Object.entries(groupToolPrefixes)) {
      if (prefixes.some(p => tool.startsWith(p))) usedGroups.add(group);
    }
  }

  let recommendation = '';
  if (profile === 'full' && totalCalls > 20) {
    const unusedGroups = registeredGroups.filter(g => !usedGroups.has(g));
    if (unusedGroups.length > 0) {
      const neededGroups = registeredGroups.filter(g => usedGroups.has(g));
      if (neededGroups.length <= 2) {
        recommendation = `You're using ${usedTools} tools — consider switching to "core" profile (saves ~${74 - 11} tool schemas).`;
      } else {
        recommendation = `Unused groups: ${unusedGroups.join(', ')}. Consider a custom profile: "${neededGroups.join(',')}".`;
      }
    }
  }

  return { counts: { ..._usageCounts }, profile, activeGroups: registeredGroups, recommendation };
}

// Load usage counts on startup
loadUsageCounts();

// Create a fully configured McpServer with all tools registered.
// Used by the HTTP transport (one stateful server per client session).
// `forceProfile` overrides the file/env profile — HTTP transport passes 'full'
// because HTTP clients (Claude Code) have ToolSearch / deferred loading and
// don't need eager profile restriction. Stdio clients (Codex, OpenCode) keep
// using readInitialProfile() via the singleton at the bottom of this file.
export function createMcpServer(forceProfile?: string, options: { catalogMode?: 'profiled' | 'deferred' } = {}) {
  const initialProfile = forceProfile ?? readInitialProfile();
  const runtime = new ProfileRuntime(initialProfile, options);
  const server = new McpServer(
    { name: 'claude-memory', version: '1.1.0' },
    { instructions: buildServerInstructions(runtime) }
  );
  const refs = registerTools(server, runtime);
  serverToolRefs.set(server, refs);
  return server;
}

// Tool refs per server instance, so long-lived HTTP session servers can have
// their category-dependent schemas refreshed in place (stateful transport keeps
// one server per client session instead of one per request).
const serverToolRefs = new WeakMap<McpServer, ReturnType<typeof registerTools>>();

export function getServerProfileRuntime(target: McpServer): ProfileRuntime | null {
  return serverToolRefs.get(target)?.runtime || null;
}

// Refresh the category-dependent tool schemas of a specific server instance.
// tool.update() pushes notifications/tools/list_changed to its connected client.
export function refreshServerSchemas(target: McpServer): void {
  const refs = serverToolRefs.get(target);
  if (!refs) return;
  refs.rememberTool.update({ paramsSchema: buildRememberSchema() });
  refs.recallTool.update({ paramsSchema: buildRecallSchema() });
  refs.reflectTool.update({ paramsSchema: buildReflectSchema() });
  refs.memoriesTool.update({ paramsSchema: buildMemoriesSchema() });
}

// ── Main stdio server instance ──
const _initialProfile = readInitialProfile();
mainProfileRuntime = new ProfileRuntime(_initialProfile);

const server = new McpServer(
  { name: 'claude-memory', version: '1.1.0' },
  { instructions: buildServerInstructions(mainProfileRuntime) }
);

const { rememberTool, recallTool, reflectTool, memoriesTool } = registerTools(server, mainProfileRuntime);

// ── Wire tool usage tracking into low-level server ──
// Intercept tool call notifications to count usage per tool name.
const _origToolCallHandler = (server.server as any)._requestHandlers?.get('tools/call');
if (_origToolCallHandler) {
  (server.server as any)._requestHandlers.set('tools/call', (request: any, extra: any) => {
    const toolName = request?.params?.name;
    if (toolName) trackToolUsage(toolName);
    return _origToolCallHandler(request, extra);
  });
}

// Listeners notified when category schemas change (e.g. the HTTP transport
// drops its pre-warmed server so the next request gets fresh schemas).
const schemaRefreshListeners: Array<() => void> = [];
export function onSchemaRefresh(fn: () => void): void {
  schemaRefreshListeners.push(fn);
}

// Refresh all tool schemas that reference category descriptions.
// Called after any category change so Claude sees updated guidelines.
export function refreshCategorySchemas() {
  invalidateCategoryCache();
  rememberTool.update({ paramsSchema: buildRememberSchema() });
  recallTool.update({ paramsSchema: buildRecallSchema() });
  reflectTool.update({ paramsSchema: buildReflectSchema() });
  memoriesTool.update({ paramsSchema: buildMemoriesSchema() });
  for (const fn of schemaRefreshListeners) {
    try { fn(); } catch { /* listener errors must not break refresh */ }
  }
}

async function main() {
  // Self-heal ~/.codex/config.toml from the legacy duplicate-env bug before
  // anything else. If the file doesn't exist or is already clean, this is a
  // fast no-op. Atomic write — original is preserved on any failure.
  if (!isClaudeCode()) {
    const codexConfigPath = join(process.env.USERPROFILE || process.env.HOME || '', '.codex', 'config.toml');
    try {
      const result = healCodexConfig(codexConfigPath);
      if (result.healed) {
        console.error(`[SynaBun] Healed Codex config.toml (${result.reason})`);
      }
    } catch (err) {
      console.error('[SynaBun] codex config heal threw (file left untouched):', err);
    }
    logCodexConfigNoticeOnce();
  }

  try {
    await ensureDatabase();
  } catch (err) {
    console.error(
      'Warning: Could not initialize SQLite database on startup.',
      err instanceof Error ? err.message : err
    );
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
  let envWatcher: ReturnType<typeof watch> | null = null;
  if (existsSync(envPath)) {
    startEnvWatcher();
  } else {
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
      let debounce: ReturnType<typeof setTimeout> | null = null;
      envWatcher = watch(envPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          try {
            const content = readFileSync(envPath, 'utf-8');
            const vars: Record<string, string> = {};
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const eq = trimmed.indexOf('=');
              if (eq === -1) continue;
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
          } catch (err) {
            console.error('.env reload error:', err);
          }
        }, 500);
      });
    } catch (err) {
      console.error('Failed to watch .env:', err);
    }
  }

  // Watch display-settings.json for recall settings changes from Neural Interface
  let settingsWatcher: ReturnType<typeof watch> | null = null;
  const displaySettingsPath = join(config.dataDir, 'display-settings.json');
  if (existsSync(displaySettingsPath)) {
    startSettingsWatcher();
  }

  function startSettingsWatcher() {
    try {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      settingsWatcher = watch(displaySettingsPath, () => {
        if (debounce) clearTimeout(debounce);
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
    } catch (err) {
      console.error('[SynaBun] Failed to watch display-settings.json:', err);
    }
  }

  // Clean up on exit
  process.on('SIGINT', () => {
    flushUsageCounts();
    if (envWatcher) envWatcher.close();
    if (settingsWatcher) settingsWatcher.close();
    stopWatchingCategories();
    closeDatabase();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    flushUsageCounts();
    if (envWatcher) envWatcher.close();
    if (settingsWatcher) settingsWatcher.close();
    stopWatchingCategories();
    closeDatabase();
    process.exit(0);
  });
  // Fix for the onnxruntime-node macOS at-exit abort (`libc++abi: ... mutex lock
  // failed`). Local embeddings load ORT, which always leaves ~4 ThreadPoolTempl
  // worker threads alive; on normal exit `__cxa_finalize` destroys the
  // threadpool's static mutex under those live threads → std::terminate. Each
  // short-lived loop-agent claude CLI run spawns this stdio server, so the abort
  // floods DiagnosticReports. `exit` is the single choke point for every exit
  // path (signals above + natural stdin-EOF exit), so we SIGKILL ourselves:
  // uncatchable, runs no C++ destructors, loses nothing (flush/close already ran
  // on the signal paths). No stdout is written, so MCP stdio stays clean.
  process.on('exit', () => {
    try { process.kill(process.pid, 'SIGKILL'); } catch { /* already gone */ }
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
