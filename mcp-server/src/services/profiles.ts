/**
 * Profile state and logic — shared between index.ts (registration) and tools/profile.ts.
 * Extracted to its own module to avoid circular imports.
 */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Presets and constants ──

const ALL_BROWSER_GROUPS = ['browser', 'browser_twitter', 'browser_facebook', 'browser_tiktok', 'browser_whatsapp', 'browser_instagram', 'browser_linkedin'];

export const PROFILE_PRESETS: Record<string, string[]> = {
  core:       ['git', 'image'],
  standard:   ['git', 'image', 'whiteboard', 'card', 'tictactoe'],
  twitter:    ['git', 'image', 'browser', 'browser_twitter'],
  facebook:   ['git', 'image', 'browser', 'browser_facebook'],
  tiktok:     ['git', 'image', 'browser', 'browser_tiktok'],
  whatsapp:   ['git', 'image', 'browser', 'browser_whatsapp'],
  instagram:  ['git', 'image', 'browser', 'browser_instagram'],
  linkedin:   ['git', 'image', 'browser', 'browser_linkedin'],
  browser:    ['git', 'image', 'whiteboard', 'card', 'tictactoe', ...ALL_BROWSER_GROUPS, 'leonardo'],
  full:       ['git', 'image', 'whiteboard', 'card', 'tictactoe', ...ALL_BROWSER_GROUPS, 'leonardo', 'discord'],
  leonardoai: ['leonardo'],
};

export const VALID_GROUPS = new Set([
  ...ALL_BROWSER_GROUPS,
  'whiteboard', 'card', 'tictactoe', 'discord', 'git', 'leonardo', 'image',
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

  _activeGroups = newGroups;
  _activeProfileName = profileName.toLowerCase().trim();

  // Count enabled tools (core + enabled groups)
  let totalTools = 10; // core memory tools + profile tool
  for (const [, tools] of _toolGroups) {
    if (_activeGroups.has([..._toolGroups].find(([, t]) => t === tools)?.[0] ?? '')) totalTools += tools.length;
  }
  // Simpler recount
  totalTools = 10;
  for (const [group, tools] of _toolGroups) {
    if (_activeGroups.has(group)) totalTools += tools.length;
  }

  console.error(`[SynaBun] Profile switched to "${_activeProfileName}" (${_activeGroups.size} groups, ${totalTools} tools, +${enabled.join(',') || 'none'}, -${disabled.join(',') || 'none'})`);
  return { profile: _activeProfileName, enabled, disabled, totalTools };
}

export function persistProfile(profileName: string) {
  try {
    const dir = join(PROFILE_PATH, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(PROFILE_PATH, JSON.stringify({ profile: profileName }, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[SynaBun] Failed to persist profile:', err);
  }
}
