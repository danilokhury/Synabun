import { startMemoryMaintenance, stopMemoryMaintenance } from './services/memory-maintenance.js';
import { attachMemoryClient } from './services/memory-client.js';
import { buildServerInstructionsText } from './services/server-instructions.js';
import { isBrowserV2Enabled } from './services/neural-interface.js';
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
import { registerImageTools } from './tools/image.js';
import { registerGscTools } from './tools/gsc.js';
import { registerYoutubeTools } from './tools/youtube.js';
import { registerStyleGuideTools } from './tools/style-guide.js';
import { registerMoreLoginTools } from './tools/morelogin.js';
import { registerAgentTools } from './tools/agents.js';
import { registerSkillTools } from './tools/skill.js';
import { registerWhatsAppSendFileTool } from './tools/whatsapp-send-file.js';
import { registerComputerTools } from './tools/computer.js';
import { toolGroupsSchema, toolGroupsDescription, handleToolGroups } from './tools/tool-groups.js';
import { choiceSchema, choiceDescription, handleChoice } from './tools/choice.js';
import { SELECTABLE_GROUP_IDS, TOOL_GROUPS } from './services/tool-catalog.js';
import {
  ToolRuntime, readInitialTools, isClaudeCode, logCodexConfigNoticeOnce, selectionFromList, selectionOf,
  type CallerCapability, type ToolMode, type ToolSelection,
} from './services/tool-runtime.js';
import { invalidateCategoryCache, setOnExternalChange, startWatchingCategories, stopWatchingCategories, initCategoryCache } from './services/categories.js';
import { healCodexConfig } from './services/codex-config-heal.js';
import type { CallerRole } from './services/identity.js';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getEnvPath, config } from './config.js';
import { SERVER_VERSION } from './version.js';
import { readFileSync, writeFileSync, watch, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Tool groups ──────────────────────────────────────────────────────
// Every group is registered at start and switched on or off by the server's
// ToolRuntime (services/tool-runtime.ts): its list decides on a strict host,
// only its focus on a focus host, its role and grant for the gated groups.
// The default-tools file is read once, at start; it is never a cross-process
// runtime signal. tool_groups changes only its own server.

function buildServerInstructions(runtime: ToolRuntime): string {
  const activeGroups = runtime.getActiveGroups();
  const instructions = buildServerInstructionsText({
    activeGroups,
    mode: runtime.getMode(),
    browserV2: isBrowserV2Enabled(),
    // Dispatched task runs (assistant workers) get their memory obligation
    // from the instructions; the launcher sets SYNABUN_RUN_MODE=task.
    runMode: process.env.SYNABUN_RUN_MODE,
    listError: runtime.getListError(),
  });
  const groups = runtime.getGroups().join(',') || 'memory only';
  const sig = `${runtime.getMode()}|${groups}|${activeGroups.size}|${instructions.length}`;
  if (sig !== _lastInstructionsSig) {
    _lastInstructionsSig = sig;
    console.error(`[SynaBun] Tools (${runtime.getMode()}): ${groups} (${activeGroups.size} groups, instructions: ${instructions.length} chars)`);
  }
  return instructions;
}

let _lastInstructionsSig: string | null = null;

/** One registrar per catalog group (services/tool-catalog.ts): registering is iterating the catalog. */
const GROUP_REGISTRARS: Readonly<Record<string, (server: McpServer) => RegisteredTool[]>> = Object.freeze({
  browser: registerBrowserCoreTools,
  browser_twitter: registerBrowserTwitterTools,
  browser_facebook: registerBrowserFacebookTools,
  browser_tiktok: registerBrowserTiktokTools,
  browser_whatsapp: registerBrowserWhatsappTools,
  browser_instagram: registerBrowserInstagramTools,
  browser_linkedin: registerBrowserLinkedinTools,
  browser_bluesky: registerBlueskyTools,
  gsc: registerGscTools,
  youtube: registerYoutubeTools,
  discord: registerDiscordTools,
  whiteboard: registerWhiteboardTools,
  card: registerCardTools,
  git: registerGitTools,
  image: registerImageTools,
  styleguide: registerStyleGuideTools,
  morelogin: registerMoreLoginTools,
  tictactoe: registerTicTacToeTools,
  // Role-gated: only an assistant brain sees it; whatsapp_send_file rides here (and only a WhatsApp brain may use it).
  agents: (server) => [...registerAgentTools(server), registerWhatsAppSendFileTool(server)],
  // Role-gated like agents: the Assistant drafts skills and submits them for review; the owner installs.
  skills: registerSkillTools,
  // Capability-gated: a caller holding a desktop grant, macOS only.
  computer: registerComputerTools,
});

/** The group ids this server has a registrar for (tests/tool-catalog.test.ts compares them with the catalog). */
export function registeredGroupIds(): string[] {
  return Object.keys(GROUP_REGISTRARS);
}

// Register ALL tools on a given McpServer instance.
// All groups are always registered; the runtime enables or disables them.
export function registerTools(server: McpServer, runtime: ToolRuntime = new ToolRuntime(readInitialTools())) {
  attachMemoryClient(server);
  // Core memory tools — always registered and always enabled
  // Use build*Schema() instead of module-level constants so HTTP transport
  // sessions always read current display-settings.json when constructed.
  const rememberTool = server.tool('remember', rememberDescription, buildRememberSchema(), handleRemember);
  const recallTool = server.tool('recall', recallDescription, buildRecallSchema(), handleRecall);
  const forgetTool = server.tool('forget', forgetDescription, forgetSchema, handleForget);
  const restoreTool = server.tool('restore', restoreDescription, restoreSchema, handleRestore);
  const reflectTool = server.tool('reflect', reflectDescription, buildReflectSchema(), handleReflect);
  const memoriesTool = server.tool('memories', memoriesDescription, buildMemoriesSchema(), handleMemories);
  const ungrouped = [
    rememberTool, recallTool, forgetTool, restoreTool, reflectTool, memoriesTool,
    server.tool('category', categoryDescription, categorySchema, handleCategory),
    server.tool('sync', syncDescription, syncSchema, handleSync),
    server.tool('loop', loopDescription, loopSchema, handleLoop),
    server.tool('tool_groups', toolGroupsDescription, toolGroupsSchema, (args) => handleToolGroups(runtime, args)),
    server.tool('choice', choiceDescription, choiceSchema, (args) => handleChoice(server, args)),
  ];
  runtime.setUngroupedToolCount(ungrouped.length);

  for (const group of TOOL_GROUPS) {
    const register = GROUP_REGISTRARS[group.id];
    if (!register) throw new Error(`SynaBun tool group "${group.id}" has no registrar in index.ts`);
    runtime.setToolGroup(group.id, register(server));
  }

  // Apply the initial selection (disables what it leaves out). The notifier is
  // registered AFTER this call so the initial sweep doesn't emit a spurious
  // tools/list_changed before the client has even subscribed.
  runtime.apply();

  // From now on, a tool_groups change emits one delayed, coalesced list_changed
  // instead of one event per tool flipped. Some MCP clients abort the
  // initiating tool round trip if the notification arrives before its answer.
  runtime.setOnToolsChanged(() => {
    server.server.notification({
      method: 'notifications/tools/list_changed',
    }).catch((err) => {
      console.error('[SynaBun] tool_groups tools/list_changed notify failed:', err);
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

// Load usage counts on startup
loadUsageCounts();

export interface CreateMcpServerOptions {
  /** The server's tools. Without it the server reads its runtime's own list (readInitialTools). */
  selection?: ToolSelection;
  /** Or a list of group ids, resolved like a runtime's own (strict unless `mode` says focus). */
  tools?: readonly string[] | string;
  /** The mode for `tools`, or for the list the runtime reads by itself. */
  mode?: ToolMode;
  role?: CallerRole | null;
  capabilities?: CallerCapability[] | null;
  platform?: string;
}

function initialSelection(options: CreateMcpServerOptions): ToolSelection {
  if (options.selection) return options.selection;
  if (options.tools !== undefined) return selectionFromList(options.tools, options.mode ?? 'strict', 'explicit');
  const selection = readInitialTools();
  return options.mode && !selection.listError ? { ...selection, mode: options.mode } : selection;
}

// Create a fully configured McpServer with all tools registered.
// Used by the HTTP transport (one stateful server per client session): it
// passes focus on every group and binds each session's own selection at
// initialize (setServerSelection). Stdio clients (Codex, OpenCode, Gemini)
// read their list from their launch (readInitialTools) through the singleton
// at the bottom of this file.
export function createMcpServer(options: CreateMcpServerOptions = {}) {
  const runtime = new ToolRuntime(initialSelection(options), { role: options.role, capabilities: options.capabilities, platform: options.platform });
  const server = new McpServer(
    { name: 'claude-memory', version: SERVER_VERSION },
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

export function getServerToolRuntime(target: McpServer): ToolRuntime | null {
  return serverToolRefs.get(target)?.runtime || null;
}

/**
 * The initialize instructions are refreshed in place: the SDK reads
 * Server._instructions when it answers the initialize request, and the HTTP
 * transport binds a session from onsessioninitialized, which runs before that
 * request is dispatched.
 */
function refreshInstructions(target: McpServer, runtime: ToolRuntime): void {
  (target.server as unknown as { _instructions?: string })._instructions = buildServerInstructions(runtime);
}

/**
 * Bind a caller role to a live server built by createMcpServer. Role-gated
 * groups (agents) are advertised only while the role matches, so the runtime
 * re-applies its selection and the instructions follow.
 */
export function setServerRole(target: McpServer, role: CallerRole | null): boolean {
  const runtime = getServerToolRuntime(target);
  if (!runtime) return false;
  if (runtime.getRole() === role) return true;
  runtime.setRole(role);
  runtime.apply();
  refreshInstructions(target, runtime);
  return true;
}

/**
 * Bind proven capabilities (a desktop grant → `computer`) to a live server;
 * same mechanics as setServerRole, called from the HTTP initialize hook.
 */
export function setServerCapabilities(target: McpServer, caps: { computer?: boolean }): boolean {
  const runtime = getServerToolRuntime(target);
  if (!runtime) return false;
  const next: CallerCapability[] = caps.computer ? ['computer'] : [];
  const current = runtime.getCapabilities();
  if (current.length === next.length && current.every((cap) => next.includes(cap))) return true;
  runtime.setCapabilities(next);
  runtime.apply();
  refreshInstructions(target, runtime);
  return true;
}

/**
 * Bind a session's tool selection to a live server: the X-Synabun-Tools focus
 * of the main HTTP mount, or the strict list the worker channel resolves for
 * its run. Same mechanics as setServerRole. Focus never changes what a server
 * advertises, so a header can neither widen nor narrow it; the gates stay with
 * the role and the grant.
 */
export function setServerSelection(target: McpServer, selection: ToolSelection): boolean {
  const runtime = getServerToolRuntime(target);
  if (!runtime) return false;
  runtime.apply({ ...selection, hostMode: selection.hostMode ?? selection.mode });
  refreshInstructions(target, runtime);
  return true;
}

/** The selection an HTTP session starts from before its own is bound: focus on every group. */
export function httpDefaultSelection(): ToolSelection {
  return selectionOf(SELECTABLE_GROUP_IDS, 'focus', 'http');
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
const mainToolRuntime = new ToolRuntime(readInitialTools());

const server = new McpServer(
  { name: 'claude-memory', version: SERVER_VERSION },
  { instructions: buildServerInstructions(mainToolRuntime) }
);

const { rememberTool, recallTool, reflectTool, memoriesTool } = registerTools(server, mainToolRuntime);

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
    const codexConfigPath = join(process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.codex'), 'config.toml');
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
    startMemoryMaintenance();
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

  // Clean up on exit. Every path funnels through shutdown(): the signals, the
  // client closing our stdin (a Claude Code / Codex / OpenCode session ending)
  // and the MCP transport closing. The event loop never drains on its own
  // after stdin ends — the category, .env and display-settings watchers keep
  // it alive — so without an explicit exit every ended session left a server
  // and its embedding worker running forever, still polling the job queue.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { flushUsageCounts(); } catch { /* best effort */ }
    try { if (envWatcher) envWatcher.close(); } catch { /* ok */ }
    try { if (settingsWatcher) settingsWatcher.close(); } catch { /* ok */ }
    try { stopWatchingCategories(); } catch { /* ok */ }
    try { stopMemoryMaintenance(); } catch { /* ok */ }
    try { closeDatabase(); } catch { /* ok */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.stdin.once('end', shutdown);
  process.stdin.once('close', shutdown);
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
  // connect() owns transport.onclose and forwards it here; chain after it so
  // a closed transport also ends the process.
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    try { previousOnClose?.(); } catch { /* ok */ }
    shutdown();
  };
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
