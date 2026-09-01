/**
 * Profile state and logic — shared between index.ts (registration) and tools/profile.ts.
 * Extracted to its own module to avoid circular imports.
 */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ── Presets and constants ──

const ALL_BROWSER_GROUPS = ['browser', 'browser_twitter', 'browser_facebook', 'browser_tiktok', 'browser_whatsapp', 'browser_instagram', 'browser_linkedin', 'browser_bluesky'];

export const PROFILE_PRESETS: Record<string, string[]> = {
  core:       ['git', 'image', 'styleguide'],
  standard:   ['git', 'image', 'whiteboard', 'card', 'tictactoe', 'styleguide'],
  'codex-browser': ['git', 'image', 'browser', 'browser_twitter', 'styleguide'],
  twitter:    ['git', 'image', 'browser', 'browser_twitter'],
  facebook:   ['git', 'image', 'browser', 'browser_facebook'],
  tiktok:     ['git', 'image', 'browser', 'browser_tiktok'],
  whatsapp:   ['git', 'image', 'browser', 'browser_whatsapp'],
  instagram:  ['git', 'image', 'browser', 'browser_instagram'],
  linkedin:   ['git', 'image', 'browser', 'browser_linkedin'],
  bluesky:    ['git', 'image', 'browser', 'browser_bluesky'],
  browser:    ['git', 'image', 'whiteboard', 'card', 'tictactoe', ...ALL_BROWSER_GROUPS, 'leonardo', 'gsc', 'youtube', 'styleguide', 'morelogin'],
  full:       ['git', 'image', 'whiteboard', 'card', 'tictactoe', ...ALL_BROWSER_GROUPS, 'leonardo', 'discord', 'gsc', 'youtube', 'styleguide', 'morelogin'],
  leonardoai: ['leonardo'],
  gsc:        ['git', 'image', 'browser', 'gsc'],
  youtube:    ['git', 'image', 'browser', 'youtube'],
};

export const VALID_GROUPS = new Set([
  ...ALL_BROWSER_GROUPS,
  'whiteboard', 'card', 'tictactoe', 'discord', 'git', 'leonardo', 'image', 'gsc', 'youtube', 'styleguide', 'morelogin',
]);

export const PROFILE_PATH = join(config.dataDir, 'active-profile.json');
const PROFILE_REGISTRY_PATH = join(config.dataHome, 'data', 'mcp-registry.json');
const RUNTIME_PROFILE_PATH_ENV = 'SYNABUN_RUNTIME_PROFILE_PATH';
export const TOOL_CATALOG_MODE_ENV = 'SYNABUN_TOOL_CATALOG_MODE';

export type ToolCatalogMode = 'profiled' | 'deferred';

/**
 * Codex snapshots its deferred MCP catalog at the start of each model turn.
 * A tools/list_changed notification updates Codex's MCP inventory, but tools
 * added after the turn starts cannot enter that turn's deferred catalog. For
 * Codex runtimes we therefore advertise every SynaBun tool up front and use
 * profiles as a focus selection instead of an availability boundary.
 */
export function readToolCatalogMode(): ToolCatalogMode {
  const configured = String(process.env[TOOL_CATALOG_MODE_ENV] || '').trim().toLowerCase();
  if (configured === 'deferred') return 'deferred';
  if (configured === 'profiled') return 'profiled';
  // Managed Codex sidepanels have always used this stable runtime prefix. The
  // fallback makes upgraded sidepanels reliable even before their next spawn
  // picks up the explicit catalog-mode environment override.
  if (/^codex-sp-/.test(String(process.env.SYNABUN_TERMINAL_SESSION || ''))) return 'deferred';
  return 'profiled';
}

/**
 * Return the profile definitions visible to the current runtime.
 *
 * Neural Interface lets users add or edit profile presets in
 * data/mcp-registry.json. Reading that registry here keeps the always-on
 * `profile` tool and startup profile resolution aligned with the sidepanel
 * selector instead of silently treating a custom preset name as an empty
 * profile. Built-ins remain the fallback for headless/standalone MCP use.
 */
export function getProfilePresets(): Record<string, string[]> {
  const presets: Record<string, string[]> = Object.fromEntries(
    Object.entries(PROFILE_PRESETS).map(([name, groups]) => [name, [...groups]])
  );
  try {
    if (!existsSync(PROFILE_REGISTRY_PATH)) return presets;
    const registry = JSON.parse(readFileSync(PROFILE_REGISTRY_PATH, 'utf-8'));
    for (const [name, profile] of Object.entries(registry?.profiles || {})) {
      const registryGroups = Array.isArray((profile as { groups?: unknown[] })?.groups)
        ? (profile as { groups: unknown[] }).groups
            .filter((group): group is string => typeof group === 'string' && VALID_GROUPS.has(group))
        : [];
      const normalizedName = String(name).toLowerCase().trim();
      // Built-ins are forward-migrated additively. Older persisted registries
      // predate groups such as styleguide/morelogin; letting them replace the
      // current defaults would silently remove tools from new MCP processes.
      presets[normalizedName] = PROFILE_PRESETS[normalizedName]
        ? [...new Set([...PROFILE_PRESETS[normalizedName], ...registryGroups])]
        : registryGroups;
    }
  } catch (err) {
    console.error('[SynaBun] Failed to read MCP profile registry:', err);
  }
  return presets;
}

// ── Claude Code detection ──
// Claude Code sets CLAUDECODE=1 in the environment. It has ToolSearch for
// deferred tool loading, so it never needs profile restrictions — always full.
export function isClaudeCode(): boolean {
  return process.env.CLAUDECODE === '1';
}

// ── Helpers ──

export function resolveProfileGroups(profileName: string): Set<string> {
  const raw = profileName.toLowerCase().trim();
  const presets = getProfilePresets();
  if (Object.prototype.hasOwnProperty.call(presets, raw)) return new Set(presets[raw]);
  const groups = new Set<string>();
  for (const g of raw.split(',')) {
    const name = g.trim();
    if (VALID_GROUPS.has(name)) groups.add(name);
  }
  return groups;
}

export function isValidProfileSelection(profileName: string): boolean {
  const raw = String(profileName || '').toLowerCase().trim();
  if (!raw) return false;
  if (Object.prototype.hasOwnProperty.call(getProfilePresets(), raw)) return true;
  const groups = raw.split(',').map((group) => group.trim()).filter(Boolean);
  return groups.length > 0 && groups.every((group) => VALID_GROUPS.has(group));
}

let _loggedCodexConfigNotice = false;

export function readInitialProfile(): string {
  // 1. SYNABUN_RUNTIME_PROFILE_PATH — an isolated, runtime-owned selection.
  //    OpenCode gives every sidepanel/loop/schedule a unique path so an MCP
  //    child restart keeps that runtime's latest agent-selected profile even
  //    though the process-wide/default profile is never changed.
  // 2. SYNABUN_PROFILE env var (set by Codex/OpenCode MCP env block, or by
  //    .env via preload.ts) — the runtime's launch-time profile.
  // 3. active-profile.json — persisted future-runtime default, owned by SynaBun.
  // 4. default 'full'.
  const runtimeProfile = readProfileFile(process.env[RUNTIME_PROFILE_PATH_ENV]);
  if (runtimeProfile) return runtimeProfile;
  // Claude Code has ToolSearch and normally runs full. Check this only after
  // an explicit runtime-owned file so an inherited CLAUDECODE=1 from the
  // parent shell cannot erase a managed OpenCode runtime pin.
  if (isClaudeCode()) return 'full';
  if (process.env.SYNABUN_PROFILE) {
    if (isValidProfileSelection(process.env.SYNABUN_PROFILE)) {
      return process.env.SYNABUN_PROFILE.toLowerCase().trim();
    }
    // An explicit but invalid runtime pin must fail closed locally. Falling
    // through to the shared future-runtime default would make a typo in one
    // isolated window silently depend on another window's selection.
    console.error(`[SynaBun] Ignoring invalid SYNABUN_PROFILE=${JSON.stringify(process.env.SYNABUN_PROFILE)}; using full.`);
    return 'full';
  }
  const defaultProfile = readProfileFile(PROFILE_PATH);
  if (defaultProfile) return defaultProfile;
  return 'full';
}

function readProfileFile(profilePath: string | undefined): string | null {
  if (!profilePath) return null;
  try {
    if (!existsSync(profilePath)) return null;
    const data = JSON.parse(readFileSync(profilePath, 'utf-8'));
    if (typeof data?.profile === 'string' && isValidProfileSelection(data.profile)) {
      return data.profile.toLowerCase().trim();
    }
  } catch {}
  return null;
}

export function logCodexConfigNoticeOnce(): void {
  if (_loggedCodexConfigNotice) return;
  _loggedCodexConfigNotice = true;
  console.error(
    '[SynaBun] Runtime profile switches never rewrite ~/.codex/config.toml. ' +
    'The canonical Codex registration uses the complete deferred SynaBun catalog; managed profile choices ' +
    'are runtime-local focus selections. Other hosts use active-profile.json as their future-runtime default.'
  );
}

// ── Per-server runtime state ──

export interface ProfileApplyResult {
  profile: string;
  enabled: string[];
  disabled: string[];
  totalTools: number;
  changed: boolean;
  catalogMode: ToolCatalogMode;
}

/**
 * Profile state belongs to one MCP server/transport, never to this module.
 *
 * The HTTP transport keeps several stateful McpServer instances in one Node
 * process. Module-global active groups/tool refs made one client's profile.set
 * mutate whichever server happened to register last. Stdio still gets one
 * ProfileRuntime per process, while HTTP gets one per client session.
 */
export class ProfileRuntime {
  private activeGroups: Set<string>;
  private activeProfileName: string;
  private readonly catalogMode: ToolCatalogMode;
  private readonly toolGroups = new Map<string, RegisteredTool[]>();
  private onProfileChanged: (() => void | Promise<void>) | null = null;
  private notificationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initialProfile: string, options: { catalogMode?: ToolCatalogMode } = {}) {
    const normalized = String(initialProfile || 'full').toLowerCase().trim() || 'full';
    if (!isValidProfileSelection(normalized)) {
      throw new Error(`Unknown MCP profile or tool group selection: ${initialProfile}`);
    }
    this.activeProfileName = normalized;
    this.activeGroups = resolveProfileGroups(normalized);
    this.catalogMode = options.catalogMode || readToolCatalogMode();
  }

  getActiveProfile(): { profile: string; activeGroups: string[] } {
    return { profile: this.activeProfileName, activeGroups: Array.from(this.activeGroups) };
  }

  getActiveProfileName(): string {
    return this.activeProfileName;
  }

  getActiveGroups(): Set<string> {
    return this.activeGroups;
  }

  getCatalogMode(): ToolCatalogMode {
    return this.catalogMode;
  }

  setToolGroup(name: string, tools: RegisteredTool[]): void {
    this.toolGroups.set(name, tools);
  }

  setOnProfileChanged(fn: (() => void | Promise<void>) | null): void {
    this.onProfileChanged = fn;
  }

  dispose(): void {
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = null;
    this.onProfileChanged = null;
  }

  /**
   * Coalesce one delayed list-changed notification. Delaying is essential:
   * OpenCode used to receive the notification while profile.set itself was
   * still in flight and could abort/cache the old tool roundtrip.
   */
  scheduleProfileChangedNotification(delayMs = 10): boolean {
    if (!this.onProfileChanged) return false;
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = null;
      try {
        void Promise.resolve(this.onProfileChanged?.()).catch((err) => {
          console.error('[SynaBun] profile-change notifier failed:', err);
        });
      } catch (err) {
        console.error('[SynaBun] profile-change notifier failed:', err);
      }
    }, Math.max(0, delayMs));
    this.notificationTimer.unref?.();
    return true;
  }

  applyProfile(profileName: string): ProfileApplyResult {
    if (!isValidProfileSelection(profileName)) {
      throw new Error(`Unknown MCP profile or tool group selection: ${profileName}`);
    }
    const normalized = profileName.toLowerCase().trim();
    const newGroups = resolveProfileGroups(normalized);
    const enabled: string[] = [];
    const disabled: string[] = [];

    for (const [group, tools] of this.toolGroups) {
      const profileEnablesGroup = newGroups.has(group);
      const shouldAdvertise = this.catalogMode === 'deferred' || profileEnablesGroup;
      for (const tool of tools) {
        // Direct mutation bypasses RegisteredTool.enable()/disable(), each of
        // which emits its own notification. The caller schedules one refresh
        // only after the profile tool result is ready to return.
        if (shouldAdvertise && !tool.enabled) tool.enabled = true;
        if (!shouldAdvertise && tool.enabled) tool.enabled = false;
      }
      if (profileEnablesGroup && !this.activeGroups.has(group)) enabled.push(group);
      if (!profileEnablesGroup && this.activeGroups.has(group)) disabled.push(group);
    }

    const previousProfile = this.activeProfileName;
    this.activeGroups = newGroups;
    this.activeProfileName = normalized;

    let totalTools = 11;
    for (const [group, tools] of this.toolGroups) {
      if (this.catalogMode === 'deferred' || this.activeGroups.has(group)) totalTools += tools.length;
    }

    const changed = previousProfile !== normalized || enabled.length > 0 || disabled.length > 0;
    if (changed) {
      console.error(`[SynaBun] Profile switched to "${normalized}" (${this.activeGroups.size} groups, ${totalTools} tools, +${enabled.join(',') || 'none'}, -${disabled.join(',') || 'none'})`);
    }
    return { profile: normalized, enabled, disabled, totalTools, changed, catalogMode: this.catalogMode };
  }
}

export function persistProfile(profileName: string) {
  const payload = JSON.stringify({ profile: profileName }, null, 2) + '\n';
  const paths = new Set<string>([PROFILE_PATH]);

  if (process.env.SYNABUN_DATA_HOME) {
    paths.add(join(process.env.SYNABUN_DATA_HOME, 'mcp-data', 'active-profile.json'));
    paths.add(join(process.env.SYNABUN_DATA_HOME, 'data', 'active-profile.json'));
  }

  for (const profilePath of paths) {
    writeProfileFile(profilePath, payload);
  }
}

/**
 * Persist only the current host-created runtime selection, when one exists.
 * This path is unique to an OpenCode sidepanel/loop/schedule and is removed
 * with that runtime. It must never fall back to PROFILE_PATH.
 */
export function persistRuntimeProfile(profileName: string): boolean {
  const profilePath = process.env[RUNTIME_PROFILE_PATH_ENV];
  if (!profilePath || !isValidProfileSelection(profileName)) return false;
  return writeProfileFile(profilePath, JSON.stringify({ profile: profileName.toLowerCase().trim() }, null, 2) + '\n');
}

function writeProfileFile(profilePath: string, payload: string): boolean {
  try {
    const dir = dirname(profilePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(profilePath, payload, 'utf-8');
    return true;
  } catch (err) {
    console.error(`[SynaBun] Failed to persist profile at ${profilePath}:`, err);
    return false;
  }
}
