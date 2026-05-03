/**
 * Profile state and logic — shared between index.ts (registration) and tools/profile.ts.
 * Extracted to its own module to avoid circular imports.
 */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ── Presets and constants ──

const ALL_BROWSER_GROUPS = ['browser', 'browser_twitter', 'browser_facebook', 'browser_tiktok', 'browser_whatsapp', 'browser_instagram', 'browser_linkedin'];

export const PROFILE_PRESETS: Record<string, string[]> = {
  core:       ['git', 'image'],
  standard:   ['git', 'image', 'whiteboard', 'card', 'tictactoe'],
  'codex-browser': ['git', 'image', 'browser', 'browser_twitter'],
  twitter:    ['git', 'image', 'browser', 'browser_twitter'],
  facebook:   ['git', 'image', 'browser', 'browser_facebook'],
  tiktok:     ['git', 'image', 'browser', 'browser_tiktok'],
  whatsapp:   ['git', 'image', 'browser', 'browser_whatsapp'],
  instagram:  ['git', 'image', 'browser', 'browser_instagram'],
  linkedin:   ['git', 'image', 'browser', 'browser_linkedin'],
  browser:    ['git', 'image', 'whiteboard', 'card', 'tictactoe', ...ALL_BROWSER_GROUPS, 'leonardo', 'gsc'],
  full:       ['git', 'image', 'whiteboard', 'card', 'tictactoe', ...ALL_BROWSER_GROUPS, 'leonardo', 'discord', 'gsc'],
  leonardoai: ['leonardo'],
  gsc:        ['git', 'image', 'browser', 'gsc'],
};

export const VALID_GROUPS = new Set([
  ...ALL_BROWSER_GROUPS,
  'whiteboard', 'card', 'tictactoe', 'discord', 'git', 'leonardo', 'image', 'gsc',
]);

export const PROFILE_PATH = join(config.dataDir, 'active-profile.json');

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

// ── Helpers ──

export function resolveProfileGroups(profileName: string): Set<string> {
  const raw = profileName.toLowerCase().trim();
  if (PROFILE_PRESETS[raw]) return new Set(PROFILE_PRESETS[raw]);
  const groups = new Set<string>();
  for (const g of raw.split(',')) {
    const name = g.trim();
    if (VALID_GROUPS.has(name)) groups.add(name);
  }
  return groups;
}

export function readInitialProfile(): string {
  // Claude Code has ToolSearch — always full, ignore profile file/env
  if (isClaudeCode()) return 'full';
  // Env var takes priority (session-scoped) over file (global, may be stale)
  if (process.env.SYNABUN_PROFILE) return process.env.SYNABUN_PROFILE;
  try {
    if (existsSync(PROFILE_PATH)) {
      const data = JSON.parse(readFileSync(PROFILE_PATH, 'utf-8'));
      if (data.profile && typeof data.profile === 'string') return data.profile;
    }
  } catch {}
  return 'full';
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
  const newGroups = resolveProfileGroups(profileName);
  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const [group, tools] of _toolGroups) {
    const shouldEnable = newGroups.has(group);
    for (const tool of tools) {
      if (shouldEnable && !tool.enabled) tool.enable();
      if (!shouldEnable && tool.enabled) tool.disable();
    }
    if (shouldEnable && !_activeGroups.has(group)) enabled.push(group);
    if (!shouldEnable && _activeGroups.has(group)) disabled.push(group);
  }

  const prevProfileName = _activeProfileName;
  _activeGroups = newGroups;
  _activeProfileName = profileName.toLowerCase().trim();

  // Count enabled tools (core + enabled groups)
  let totalTools = 10;
  for (const [group, tools] of _toolGroups) {
    if (_activeGroups.has(group)) totalTools += tools.length;
  }

  // Only log on an actual change — HTTP MCP creates a fresh server per request,
  // which would otherwise spam this line twice per request forever.
  if (prevProfileName !== _activeProfileName || enabled.length > 0 || disabled.length > 0) {
    console.error(`[SynaBun] Profile switched to "${_activeProfileName}" (${_activeGroups.size} groups, ${totalTools} tools, +${enabled.join(',') || 'none'}, -${disabled.join(',') || 'none'})`);
  }
  return { profile: _activeProfileName, enabled, disabled, totalTools };
}

export function persistProfile(profileName: string) {
  const payload = JSON.stringify({ profile: profileName }, null, 2) + '\n';
  const paths = new Set<string>([PROFILE_PATH]);

  if (process.env.SYNABUN_DATA_HOME) {
    paths.add(join(process.env.SYNABUN_DATA_HOME, 'mcp-data', 'active-profile.json'));
    paths.add(join(process.env.SYNABUN_DATA_HOME, 'data', 'active-profile.json'));
    paths.add(join(process.env.SYNABUN_DATA_HOME, 'mcp-server', 'data', 'active-profile.json'));
  }

  for (const profilePath of paths) {
    writeProfileFile(profilePath, payload);
  }

  syncCodexProfileEnv(profileName);
  syncOpenCodeProfileEnv(profileName);
}

function writeProfileFile(profilePath: string, payload: string) {
  try {
    const dir = dirname(profilePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(profilePath, payload, 'utf-8');
  } catch (err) {
    console.error(`[SynaBun] Failed to persist profile at ${profilePath}:`, err);
  }
}

function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlSectionRange(content: string, sectionName: string): { start: number; end: number } | null {
  const startRe = new RegExp(`^\\[${escapeRegExp(sectionName)}\\]\\s*$`, 'm');
  const startMatch = startRe.exec(content);
  if (!startMatch) return null;

  const afterHeader = startMatch.index + startMatch[0].length;
  const rest = content.slice(afterHeader);
  const nextMatch = /^\[[^\]]+\]\s*$/m.exec(rest);
  return {
    start: startMatch.index,
    end: nextMatch ? afterHeader + nextMatch.index : content.length,
  };
}

function upsertInlineTomlString(body: string, key: string, value: string): string {
  const pair = `${key} = "${value}"`;
  const keyRe = new RegExp(`${escapeRegExp(key)}\\s*=\\s*"[^"]*"`);
  if (keyRe.test(body)) return body.replace(keyRe, pair);
  const trimmed = body.trim().replace(/,$/, '');
  return trimmed ? `${trimmed}, ${pair}` : pair;
}

function syncCodexProfileEnv(profileName: string): boolean {
  try {
    const home = homeDir();
    if (!home) return false;
    const configPath = join(home, '.codex', 'config.toml');
    if (!existsSync(configPath)) return false;

    const content = readFileSync(configPath, 'utf-8');
    const range = tomlSectionRange(content, 'mcp_servers.SynaBun');
    if (!range) return false;

    const section = content.slice(range.start, range.end);
    const envRe = /^env\s*=\s*\{([^}]*)\}/m;
    const envMatch = section.match(envRe);
    let nextSection: string;

    if (envMatch) {
      let body = envMatch[1].trim();
      body = upsertInlineTomlString(body, 'SYNABUN_PROFILE', profileName);
      body = upsertInlineTomlString(body, 'SYNABUN_BROWSER_FAST', '1');
      body = upsertInlineTomlString(body, 'SYNABUN_BROWSER_COMPACT', '1');
      nextSection = section.replace(envRe, `env = { ${body} }`);
    } else {
      nextSection = `${section.trimEnd()}\nenv = { SYNABUN_PROFILE = "${profileName}", SYNABUN_BROWSER_FAST = "1", SYNABUN_BROWSER_COMPACT = "1" }\n`;
    }

    if (nextSection === section) return false;
    writeFileSync(configPath, content.slice(0, range.start) + nextSection + content.slice(range.end), 'utf-8');
    return true;
  } catch (err) {
    console.error('[SynaBun] Failed to sync Codex profile env:', err);
    return false;
  }
}

function syncOpenCodeProfileEnv(profileName: string): boolean {
  try {
    const home = homeDir();
    if (!home) return false;
    const configPath = process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, 'opencode', 'config.json')
      : join(home, '.config', 'opencode', 'config.json');
    if (!existsSync(configPath)) return false;

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (!config?.mcp?.SynaBun) return false;
    if (!config.mcp.SynaBun.environment) config.mcp.SynaBun.environment = {};
    if (config.mcp.SynaBun.environment.SYNABUN_PROFILE === profileName) return false;
    config.mcp.SynaBun.environment.SYNABUN_PROFILE = profileName;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  } catch (err) {
    console.error('[SynaBun] Failed to sync OpenCode profile env:', err);
    return false;
  }
}
