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

// ── State ──

let _activeGroups: Set<string> = new Set();
let _activeProfileName: string = 'full';
const _toolGroups: Map<string, RegisteredTool[]> = new Map();

// Single-fire notifier hook. The MCP SDK's RegisteredTool.enable()/disable()
// each emit a `notifications/tools/list_changed` event. A profile swap that
// flips ~30-50 tools therefore fires a storm that some MCP clients (notably
// the OpenCode SDK) react to by aborting the in-flight tool roundtrip — the
// agent appears to "stall" after one profile.set call. applyProfile bypasses
// enable()/disable() with direct `tool.enabled = ...` mutation and emits a
// single notification at the end via this callback.
let _onProfileChanged: (() => void) | null = null;
export function setOnProfileChanged(fn: (() => void) | null): void {
  _onProfileChanged = fn;
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
    '[SynaBun] SynaBun no longer writes to ~/.codex/config.toml. ' +
    'To change profile permanently, edit active-profile.json. ' +
    'To override per-session, set SYNABUN_PROFILE in your MCP env block.'
  );
}

// ── State accessors ──

export function getActiveProfile(): { profile: string; activeGroups: string[] } {
  return { profile: _activeProfileName, activeGroups: Array.from(_activeGroups) };
}

export function getActiveProfileName(): string {
  return _activeProfileName;
}

export function getActiveGroups(): Set<string> {
  return _activeGroups;
}

export function getToolGroups(): Map<string, RegisteredTool[]> {
  return _toolGroups;
}

export function setActiveState(profileName: string, groups: Set<string>) {
  _activeProfileName = profileName;
  _activeGroups = groups;
}

export function setToolGroup(name: string, tools: RegisteredTool[]) {
  _toolGroups.set(name, tools);
}

// ── Profile switching ──

export function applyProfile(profileName: string): { profile: string; enabled: string[]; disabled: string[]; totalTools: number } {
  if (!isValidProfileSelection(profileName)) {
    throw new Error(`Unknown MCP profile or tool group selection: ${profileName}`);
  }
  const newGroups = resolveProfileGroups(profileName);
  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const [group, tools] of _toolGroups) {
    const shouldEnable = newGroups.has(group);
    for (const tool of tools) {
      // Direct mutation bypasses RegisteredTool.enable()/disable() which each
      // emit a `notifications/tools/list_changed`. We fire one notification at
      // the end via the _onProfileChanged callback instead — see top of file.
      if (shouldEnable && !tool.enabled) tool.enabled = true;
      if (!shouldEnable && tool.enabled) tool.enabled = false;
    }
    if (shouldEnable && !_activeGroups.has(group)) enabled.push(group);
    if (!shouldEnable && _activeGroups.has(group)) disabled.push(group);
  }

  const prevProfileName = _activeProfileName;
  _activeGroups = newGroups;
  _activeProfileName = profileName.toLowerCase().trim();

  // Count enabled tools (core + enabled groups)
  let totalTools = 11;
  for (const [group, tools] of _toolGroups) {
    if (_activeGroups.has(group)) totalTools += tools.length;
  }

  // Only log + notify on an actual change. HTTP MCP creates a fresh server
  // per request, which would otherwise spam this line twice per request.
  const changed = prevProfileName !== _activeProfileName || enabled.length > 0 || disabled.length > 0;
  if (changed) {
    console.error(`[SynaBun] Profile switched to "${_activeProfileName}" (${_activeGroups.size} groups, ${totalTools} tools, +${enabled.join(',') || 'none'}, -${disabled.join(',') || 'none'})`);
    if (_onProfileChanged) {
      try { _onProfileChanged(); }
      catch (err) { console.error('[SynaBun] profile-change notifier failed:', err); }
    }
  }
  return { profile: _activeProfileName, enabled, disabled, totalTools };
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
