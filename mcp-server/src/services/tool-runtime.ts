/**
 * The tool selection of one MCP server runtime: which SynaBun groups it advertises, and how.
 *
 * strict: the runtime advertises exactly its groups (OpenCode, Gemini, any other stdio client). focus: it
 * advertises every group and its groups only steer the instructions (Claude Code's ToolSearch, Codex's deferred
 * catalog, which Codex snapshots at the start of a turn). Gated groups follow the caller's role and grant in both
 * modes, never a list.
 *
 * Each MCP server owns one ToolRuntime: the HTTP transport keeps several servers in one process, and a
 * module-global selection once made one client's change land on another client's server.
 */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { config } from '../config.js';
import { isHttpMode, sanitizeDesktopGrant, sanitizeRole, type CallerRole } from './identity.js';
import { ALWAYS_ON_TOOLS, SELECTABLE_GROUP_IDS, TOOL_LIST_LIMITS, TOOL_GROUPS, isGatedGroup, isSelectableGroup, sortGroups } from './tool-catalog.js';
import { parseToolList, resolveToolList, type AddedGroup, type CustomPresets } from './tool-list.js';

export type ToolMode = 'strict' | 'focus';
export type CallerCapability = 'computer';

/** The list of this runtime (comma-joined group ids) and the file its tool_groups changes go to. */
export const TOOLS_ENV = 'SYNABUN_TOOLS';
export const TOOLS_PATH_ENV = 'SYNABUN_TOOLS_PATH';
/** deferred / focus: a focus host; profiled / strict: a strict one. */
export const TOOL_CATALOG_MODE_ENV = 'SYNABUN_TOOL_CATALOG_MODE';
/** Read as aliases through the legacy conversion (an older Neural Interface, a user's own config.toml or Gemini settings); never written. */
export const LEGACY_PROFILE_ENV = 'SYNABUN_PROFILE';
export const LEGACY_RUNTIME_PROFILE_PATH_ENV = 'SYNABUN_RUNTIME_PROFILE_PATH';

/** The owner's Default tools: Settings and `synabun tools set` write it; a runtime reads it when it starts, never later. */
export const DEFAULT_TOOLS_PATH = join(config.dataHome, 'data', 'default-tools.json');
const LEGACY_DEFAULT_PROFILE_PATHS = [join(config.dataDir, 'active-profile.json'), join(config.dataHome, 'data', 'active-profile.json')];
const REGISTRY_PATH = join(config.dataHome, 'data', 'mcp-registry.json');

/** Groups only a caller with this role sees: the role decides, so no list can reveal or hide them. */
export const ROLE_GATED_GROUPS: Readonly<Record<string, CallerRole>> = Object.freeze(Object.fromEntries(
  TOOL_GROUPS.filter((group) => group.gate === 'role:assistant').map((group) => [group.id, 'assistant' as const]),
));
/** Groups a capability the caller proves unlocks: `computer` needs a desktop grant (and macOS). */
export const CAPABILITY_GATED_GROUPS: Readonly<Record<string, CallerCapability>> = Object.freeze(Object.fromEntries(
  TOOL_GROUPS.filter((group) => group.gate === 'grant:computer').map((group) => [group.id, 'computer' as const]),
));

export function isRoleGatedGroup(group: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_GATED_GROUPS, group);
}

export function isCapabilityGatedGroup(group: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_GATED_GROUPS, group);
}

/** Where a runtime's selection came from (tool_groups get shows it). */
export type ToolSelectionSource =
  | 'tools-file' | 'tools-env' | 'legacy-runtime-file' | 'claude-code' | 'legacy-profile-env'
  | 'default-tools' | 'legacy-default' | 'all' | 'http' | 'header' | 'channel' | 'explicit' | 'tool_groups';

export interface ToolSelection {
  /** Selectable groups, catalog order. */
  groups: string[];
  mode: ToolMode;
  /** The host's own mode, when a list that could not be read made this selection strict. */
  hostMode?: ToolMode;
  /** Why the list could not be read: the runtime then has its always-on and gated tools only. */
  listError: string | null;
  source: ToolSelectionSource;
  /** Groups the runtime got without naming them (browser for a browser group). */
  added: AddedGroup[];
}

const SOURCE_NAMES: Partial<Record<ToolSelectionSource, string>> = {
  'tools-file': 'SYNABUN_TOOLS_PATH',
  'tools-env': 'SYNABUN_TOOLS',
  'legacy-runtime-file': 'SYNABUN_RUNTIME_PROFILE_PATH',
  'legacy-profile-env': 'SYNABUN_PROFILE',
  'default-tools': 'default-tools.json',
  'legacy-default': 'active-profile.json',
  header: 'X-Synabun-Tools',
  channel: 'the worker channel',
};

/** The selection of a host's own list, with its host mode. */
export function selectionOf(groups: readonly string[], mode: ToolMode, source: ToolSelectionSource, added: AddedGroup[] = []): ToolSelection {
  return { groups: sortGroups(groups).filter(isSelectableGroup), mode, listError: null, source, added };
}

/** What a list that could not be read leaves: memory tools only (and the gated ones), strict until tool_groups succeeds. */
export function unreadableSelection(source: ToolSelectionSource, reason: string, hostMode: ToolMode): ToolSelection {
  const name = SOURCE_NAMES[source];
  return { groups: [], mode: 'strict', hostMode, listError: name ? `${name}: ${reason}` : reason, source, added: [] };
}

export function isClaudeCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDECODE === '1';
}

/** focus for Codex (SYNABUN_TOOL_CATALOG_MODE=deferred, or a managed Codex sidepanel), strict otherwise. */
export function readHostMode(env: NodeJS.ProcessEnv = process.env): ToolMode {
  const configured = String(env[TOOL_CATALOG_MODE_ENV] || '').trim().toLowerCase();
  if (configured === 'deferred' || configured === 'focus') return 'focus';
  if (configured === 'profiled' || configured === 'strict') return 'strict';
  // Managed Codex sidepanels have always used this runtime prefix: one spawned before its launch environment
  // named the catalog mode is a focus host all the same.
  if (/^codex-sp-/.test(String(env.SYNABUN_TERMINAL_SESSION || ''))) return 'focus';
  return 'strict';
}

const loggedProblems = new Set<string>();
function logOnce(message: string): void {
  if (loggedProblems.has(message)) return;
  loggedProblems.add(message);
  console.error(`[SynaBun] ${message}`);
}

/** The registry's presets, read only to convert a stored profile name. */
export function readCustomPresets(): CustomPresets | null {
  try {
    if (!existsSync(REGISTRY_PATH)) return null;
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
    const profiles = registry?.profiles;
    return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles as CustomPresets : null;
  } catch (err) {
    logOnce(`Could not read the MCP registry for stored profile names: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function fromList(value: unknown, source: ToolSelectionSource, hostMode: ToolMode, legacy: boolean): ToolSelection {
  const parsed = parseToolList(value, legacy ? { legacy: true, customPresets: readCustomPresets() } : {});
  if (!parsed.ok) return unreadableSelection(source, parsed.message, hostMode);
  const resolved = resolveToolList(parsed.items, { source: 'runtime' });
  if (!resolved.ok) return unreadableSelection(source, resolved.message, hostMode);
  return selectionOf(resolved.groups, hostMode, source, resolved.added);
}

/**
 * The selection of a list given in code or by a request (a header, the worker channel), resolved like a runtime's
 * own: `all` expanded, a browser group's `browser` added. One that cannot be read is memory tools only, strict.
 */
export function selectionFromList(value: unknown, mode: ToolMode, source: ToolSelectionSource, { legacy = false }: { legacy?: boolean } = {}): ToolSelection {
  return fromList(value, source, mode, legacy);
}

/** A runtime file holds `{ "tools": [...] }`; one an older Neural Interface wrote holds `{ "profile": "..." }`. */
function fromFile(path: string | undefined, source: ToolSelectionSource, hostMode: ToolMode): ToolSelection | null {
  const file = String(path || '').trim();
  if (!file) return null;
  let text: string;
  try {
    if (!existsSync(file)) return null;
    text = readFileSync(file, 'utf-8');
  } catch (err) {
    return unreadableSelection(source, `${basename(file)} could not be read (${err instanceof Error ? err.message : String(err)})`, hostMode);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return unreadableSelection(source, `${basename(file)} is not JSON`, hostMode);
  }
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : null;
  if (record && Array.isArray(record.tools)) return fromList(record.tools, source, hostMode, false);
  if (record && typeof record.profile === 'string') return fromList(record.profile, source, hostMode, true);
  return unreadableSelection(source, `${basename(file)} names no tools`, hostMode);
}

function fromEnv(value: string | undefined, source: ToolSelectionSource, hostMode: ToolMode, legacy: boolean): ToolSelection | null {
  if (value === undefined || !value.trim()) return null;
  return fromList(value, source, hostMode, legacy);
}

/**
 * The selection a runtime starts with, the first of: its runtime file (SYNABUN_TOOLS_PATH), its list
 * (SYNABUN_TOOLS), the runtime file of an older Neural Interface (SYNABUN_RUNTIME_PROFILE_PATH), Claude Code
 * (CLAUDECODE=1: focus on every group), the old SYNABUN_PROFILE, the owner's Default tools, the old
 * active-profile.json, every group. The runtime's own pins come before CLAUDECODE, so a strict runtime that
 * inherited it from a parent shell keeps its list. A list that cannot be read is not skipped: the runtime starts
 * with memory tools only and says why (fail closed, never every group).
 */
export function readInitialTools(env: NodeJS.ProcessEnv = process.env): ToolSelection {
  const hostMode = readHostMode(env);
  const steps: Array<() => ToolSelection | null> = [
    () => fromFile(env[TOOLS_PATH_ENV], 'tools-file', hostMode),
    () => fromEnv(env[TOOLS_ENV], 'tools-env', hostMode, false),
    () => fromFile(env[LEGACY_RUNTIME_PROFILE_PATH_ENV], 'legacy-runtime-file', hostMode),
    () => (isClaudeCode(env) ? selectionOf(SELECTABLE_GROUP_IDS, 'focus', 'claude-code') : null),
    () => fromEnv(env[LEGACY_PROFILE_ENV], 'legacy-profile-env', hostMode, true),
    () => fromFile(DEFAULT_TOOLS_PATH, 'default-tools', hostMode),
    () => {
      for (const path of LEGACY_DEFAULT_PROFILE_PATHS) {
        const selection = fromFile(path, 'legacy-default', hostMode);
        if (selection) return selection;
      }
      return null;
    },
  ];
  for (const step of steps) {
    const selection = step();
    if (!selection) continue;
    if (selection.listError) logOnce(`Could not read this runtime's tool list (${selection.listError}); only memory tools are loaded.`);
    return selection;
  }
  return selectionOf(SELECTABLE_GROUP_IDS, hostMode, 'all');
}

/**
 * The value an older Neural Interface's /api/mcp/runtime-profile and runtime file understand for these groups: a
 * comma list (every selectable id is one of its group names), or its always-on pseudo-group `memory` for none.
 */
export function legacyProfileValue(groups: readonly string[]): string {
  const ids = sortGroups(groups).filter(isSelectableGroup);
  return ids.length ? ids.join(',') : 'memory';
}

function writeJsonFile(path: string, value: unknown): boolean {
  const temp = `${path}.synabun-${process.pid}-${Date.now()}.tmp`;
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
    renameSync(temp, path);
    return true;
  } catch (err) {
    try { unlinkSync(temp); } catch { /* never written */ }
    console.error(`[SynaBun] Failed to save this runtime's tools at ${path}:`, err);
    return false;
  }
}

/**
 * Save this runtime's groups where a restarted child of the same runtime reads them, never the shared default.
 * Over HTTP there is no such file: process.env is the Neural Interface's own, not a caller's.
 */
export function runtimeToolsWithExternalRefs(groups: readonly string[]): string[] {
  const tools = sortGroups(groups).filter(isSelectableGroup);
  if (isHttpMode()) return tools; // HTTP identity belongs to the request; NI preserves the outer run's refs.
  const path = String(process.env[TOOLS_PATH_ENV] || process.env[LEGACY_RUNTIME_PROFILE_PATH_ENV] || '').trim();
  let previous: unknown = process.env[TOOLS_ENV] || '';
  try { if (path && existsSync(path)) previous = JSON.parse(readFileSync(path, 'utf8')).tools ?? previous; } catch { /* launch env remains the fallback */ }
  const parsed = parseToolList(previous);
  const refs = parsed.ok ? parsed.items.filter(item => item.startsWith('mcp:')) : [];
  const compact = tools.length + refs.length > TOOL_LIST_LIMITS.maxItems && SELECTABLE_GROUP_IDS.every(id => tools.includes(id));
  return [...(compact ? ['all'] : tools), ...refs];
}
export function persistRuntimeTools(groups: readonly string[]): 'tools-file' | 'legacy-runtime-file' | null {
  if (isHttpMode()) return null;
  const tools = runtimeToolsWithExternalRefs(groups);
  const toolsPath = String(process.env[TOOLS_PATH_ENV] || '').trim();
  if (toolsPath) return writeJsonFile(toolsPath, { tools, updatedAt: new Date().toISOString() }) ? 'tools-file' : null;
  const legacyPath = String(process.env[LEGACY_RUNTIME_PROFILE_PATH_ENV] || '').trim();
  if (legacyPath) return writeJsonFile(legacyPath, { profile: legacyProfileValue(groups), tools }) ? 'legacy-runtime-file' : null;
  return null;
}

export function logCodexConfigNoticeOnce(): void {
  logOnce(
    'Changing this runtime\'s tools never rewrites ~/.codex/config.toml: the canonical Codex registration loads every '
    + 'SynaBun tool (SYNABUN_TOOLS=all, deferred catalog) and a tool list only sets a Codex runtime\'s focus.',
  );
}

export interface ToolApplyResult {
  groups: string[];
  /** The groups the instructions name: the selection plus the gated groups the role and grant unlock. */
  activeGroups: string[];
  /** Groups that became active, and groups that stopped being active. */
  enabled: string[];
  disabled: string[];
  added: AddedGroup[];
  /** Tools this server advertises now. */
  totalTools: number;
  changed: boolean;
  /** Whether any tool appeared in or left the host's tool list. */
  advertisedChanged: boolean;
  mode: ToolMode;
  listError: string | null;
}

export interface ToolRuntimeOptions {
  role?: CallerRole | null;
  capabilities?: CallerCapability[] | null;
  platform?: string;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export class ToolRuntime {
  private groups: string[];
  private mode: ToolMode;
  private hostMode: ToolMode;
  private listError: string | null;
  private source: ToolSelectionSource;
  private added: AddedGroup[];
  private role: CallerRole | null;
  private capabilities: Set<CallerCapability>;
  private readonly platform: string;
  private activeGroups: Set<string>;
  private readonly toolGroups = new Map<string, RegisteredTool[]>();
  private ungroupedTools: number = ALWAYS_ON_TOOLS.length;
  private onToolsChanged: (() => void | Promise<void>) | null = null;
  private notificationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(selection: ToolSelection = readInitialTools(), options: ToolRuntimeOptions = {}) {
    // stdio children of the Codex/OpenCode assistant brains receive the role through their launch env; HTTP
    // sessions bind it later (setRole). The desktop grant the same way (setCapabilities).
    this.role = options.role !== undefined ? options.role : sanitizeRole(process.env.SYNABUN_ROLE);
    this.capabilities = new Set(options.capabilities ?? (sanitizeDesktopGrant(process.env.SYNABUN_DESKTOP_GRANT) ? ['computer'] : []));
    this.platform = options.platform || process.platform;
    this.groups = sortGroups(selection.groups).filter(isSelectableGroup);
    this.mode = selection.mode;
    this.hostMode = selection.hostMode ?? selection.mode;
    this.listError = selection.listError ?? null;
    this.source = selection.source;
    this.added = [...(selection.added || [])];
    this.activeGroups = this.resolveActive(this.groups);
  }

  getGroups(): string[] { return [...this.groups]; }
  /** The groups the instructions name: the selection plus the gated groups the role and grant unlock. */
  getActiveGroups(): Set<string> { return this.activeGroups; }
  getMode(): ToolMode { return this.mode; }
  /** The mode the host has once its list reads: focus for Codex and Claude Code, strict otherwise. */
  getHostMode(): ToolMode { return this.hostMode; }
  getListError(): string | null { return this.listError; }
  getSource(): ToolSelectionSource { return this.source; }
  getAdded(): AddedGroup[] { return [...this.added]; }
  getRole(): CallerRole | null { return this.role; }
  getCapabilities(): CallerCapability[] { return [...this.capabilities]; }

  getSelection(): ToolSelection {
    return { groups: this.getGroups(), mode: this.mode, hostMode: this.hostMode, listError: this.listError, source: this.source, added: this.getAdded() };
  }

  /** Plain setter: callers apply() afterwards so the gated groups follow (index.ts setServerRole does both). */
  setRole(role: CallerRole | null): void { this.role = role; }
  /** Plain setter, like setRole. */
  setCapabilities(capabilities: CallerCapability[]): void { this.capabilities = new Set(capabilities); }

  setToolGroup(name: string, tools: RegisteredTool[]): void {
    this.toolGroups.set(name, tools);
  }

  /** How many registered tools sit outside every group (the always-on tools, and any compatibility name). */
  setUngroupedToolCount(count: number): void {
    this.ungroupedTools = count;
  }

  setOnToolsChanged(fn: (() => void | Promise<void>) | null): void {
    this.onToolsChanged = fn;
  }

  // HTTP clients can refresh over their open notification stream without destroying an in-flight call.
  private inBandRefresh: (() => Promise<boolean>) | null = null;
  setInBandRefresh(fn: () => Promise<boolean>): void { this.inBandRefresh = fn; }
  hasInBandRefresh(): boolean { return !!this.inBandRefresh; }
  refreshBeforeReply(): Promise<boolean> { return this.inBandRefresh?.() ?? Promise.resolve(false); }

  dispose(): void {
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = null;
    this.onToolsChanged = null;
    this.inBandRefresh = null;
  }

  /**
   * Coalesce one delayed tools/list_changed. The delay matters: OpenCode used to get the notification while the
   * tool call that caused it was still in flight, and could abort or cache the old tool round trip.
   */
  scheduleToolsChangedNotification(delayMs = 10): boolean {
    if (!this.onToolsChanged) return false;
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = null;
      try {
        void Promise.resolve(this.onToolsChanged?.()).catch((err) => {
          console.error('[SynaBun] tools/list_changed notifier failed:', err);
        });
      } catch (err) {
        console.error('[SynaBun] tools/list_changed notifier failed:', err);
      }
    }, Math.max(0, delayMs));
    this.notificationTimer.unref?.();
    return true;
  }

  /** The selection with the gates applied: a gated group is active iff this runtime's role or grant unlocks it. */
  private resolveActive(groups: readonly string[]): Set<string> {
    const active = new Set(groups.filter(isSelectableGroup));
    for (const [group, role] of Object.entries(ROLE_GATED_GROUPS)) if (this.role === role) active.add(group);
    for (const [group, capability] of Object.entries(CAPABILITY_GATED_GROUPS)) {
      if (this.capabilities.has(capability) && (capability !== 'computer' || this.platform === 'darwin')) active.add(group);
    }
    return active;
  }

  /** Tools this server advertises: the ones outside every group and each group's enabled tools. */
  getAdvertisedToolCount(): number {
    let total = this.ungroupedTools;
    for (const tools of this.toolGroups.values()) total += tools.filter((tool) => tool.enabled).length;
    return total;
  }

  /**
   * Apply a new selection (or re-apply the current one after a role or grant change). Tools are flipped directly:
   * RegisteredTool.enable()/disable() would each send a notification, and the caller sends one after its answer.
   */
  apply(next: Partial<ToolSelection> = {}): ToolApplyResult {
    const groups = next.groups ? sortGroups(next.groups).filter(isSelectableGroup) : this.groups;
    const mode = next.mode ?? this.mode;
    const listError = next.listError !== undefined ? next.listError : this.listError;
    const previous = { groups: this.groups, mode: this.mode, listError: this.listError, active: this.activeGroups };
    const active = this.resolveActive(groups);

    let advertisedChanged = false;
    for (const [group, tools] of this.toolGroups) {
      // A gated group ignores the mode: a focus host gets every other group up front, never one its role or grant does not unlock.
      const advertise = isGatedGroup(group) ? active.has(group) : mode === 'focus' || active.has(group);
      for (const tool of tools) {
        if (tool.enabled === advertise) continue;
        tool.enabled = advertise;
        advertisedChanged = true;
      }
    }

    const enabled = sortGroups([...active].filter((group) => !previous.active.has(group)));
    const disabled = sortGroups([...previous.active].filter((group) => !active.has(group)));
    this.groups = groups;
    this.mode = mode;
    this.listError = listError;
    this.activeGroups = active;
    if (next.hostMode) this.hostMode = next.hostMode;
    if (next.source) this.source = next.source;
    if (next.added) this.added = [...next.added];

    const totalTools = this.getAdvertisedToolCount();
    const changed = enabled.length > 0 || disabled.length > 0 || previous.mode !== mode
      || previous.listError !== listError || !sameList(previous.groups, groups);
    if (changed) {
      console.error(`[SynaBun] Tools (${mode}): ${groups.join(',') || 'memory only'} (${totalTools} tools, +${enabled.join(',') || 'none'}, -${disabled.join(',') || 'none'})`);
    }
    return {
      groups: [...groups],
      activeGroups: sortGroups(active),
      enabled,
      disabled,
      added: [...this.added],
      totalTools,
      changed,
      advertisedChanged,
      mode,
      listError,
    };
  }
}
