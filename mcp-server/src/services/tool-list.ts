/**
 * Tool lists: what a run names out of the catalog (docs/design/mcp-tool-lists/PLAN.md §3.2-3.4).
 *
 * A list is an array of group ids, `all` and `mcp:` items. parseToolList reads one, or converts a name an older
 * SynaBun stored (a preset, a comma list); resolveToolList applies the defaults and the groups a run gets by itself.
 * Both refuse what the catalog does not have, with suggestions. Pure: the Neural Interface (dispatch, launches) and
 * the MCP child (its runtime file, its environment, a header) call the same code.
 */
import {
  ALWAYS_ON_TOOLS,
  DEFAULT_TOOLS,
  HOST_EFFECT,
  LEGACY_PRESETS,
  LEGACY_PRESET_PLATFORMS,
  RETIRED_GROUPS,
  RETIRED_PRESETS,
  SELECTABLE_GROUP_IDS,
  TOOL_GROUPS,
  TOOL_LIST_LIMITS,
  countTools,
  groupOfTool,
  isAlwaysOnId,
  isBrowserGroup,
  isGatedGroup,
  isSelectableGroup,
  sortGroups,
  toolGroup,
  type ToolListEffect,
} from './tool-catalog.js';

export type ToolListProblemReason = 'unknown' | 'gated' | 'too-long' | 'too-many' | 'not-a-string' | 'unknown-server' | 'non-selectable' | 'absent-for-provider' | 'blocked' | 'unavailable';

export interface ToolListProblem {
  item: string;
  reason: ToolListProblemReason;
  /** Ids to name instead (group ids, `all`, `mcp:*`); empty when nothing fits. */
  suggestions: string[];
  /** One sentence for the person or agent that wrote the item. */
  hint: string | null;
}

export type ToolListErrorCode = 'TOOLS_INVALID' | 'TOOLS_TOO_MANY';

export interface ToolListFailure {
  ok: false;
  code: ToolListErrorCode;
  problems: ToolListProblem[];
  message: string;
}

export interface ParsedToolList {
  ok: true;
  /** Normalized items, each once, in the order given. */
  items: string[];
  /** The stored preset name this was converted from, or null. */
  preset: string | null;
  /** The platform that preset implied (`twitter`, `facebook`), or null. */
  platform: string | null;
}

export type ToolListParse = ParsedToolList | ToolListFailure;

/** Registry presets by name (`profiles.<name>.groups` of data/mcp-registry.json): read only to convert a stored name. */
export type CustomPresets = Readonly<Record<string, { groups?: unknown } | readonly unknown[] | null | undefined>>;

export type ToolListSource = 'dispatch' | 'launch' | 'runtime';
export type AddedReason = 'browser-group' | 'uses-browser' | 'design';
export interface AddedGroup { id: string; why: AddedReason }

export interface ResolveToolListContext {
  /** dispatch: the Assistant's run; launch: a stored automation; runtime: an MCP child reading its own list. */
  source: ToolListSource;
  usesBrowser?: boolean | null;
  taskClass?: string | null;
  /** claude-code, codex, opencode, gemini: decides the effect. */
  provider?: string | null;
  /** launch: the record's own list, already converted (§3.10). */
  stored?: readonly string[] | null;
  /** The owner's Default tools (launch and runtime, when nothing else names a list). */
  defaultTools?: readonly string[] | null;
  browserV2?: boolean;
}

export interface ToolListResolution {
  ok: true;
  /** The items asked for, normalized; null when the run named nothing (a default applied). */
  requested: string[] | null;
  /** The list in its stored form: `all` or groups in catalog order, then the `mcp:` items. */
  items: string[];
  /** Every selectable group the run gets, in catalog order: `all` expanded, added groups included. */
  groups: string[];
  /** External refs; availability is checked at the provider launch boundary. */
  servers: string[];
  /** Groups the run gets without naming them, and why. */
  added: AddedGroup[];
  /** Always-on ids and tool names that were named: accepted and dropped. */
  dropped: string[];
  effect: ToolListEffect;
  /** Tools the run loads (strict) or focuses on (focus), before its role and grants. */
  count: number;
}

export type ToolListResult = ToolListResolution | ToolListFailure;

const MCP_PREFIX = /^mcp:/i;

/** Trimmed; group ids and literals lower-cased; an `mcp:` server name keeps its case. */
export function normalizeToolItem(item: string): string {
  const trimmed = item.trim();
  if (MCP_PREFIX.test(trimmed)) return `mcp:${trimmed.slice(4).trim()}`;
  return trimmed.toLowerCase();
}

function splitList(value: string): string[] {
  return value.split(',').map(normalizeToolItem).filter(Boolean);
}

function unique(items: Iterable<string>): string[] {
  return [...new Set(items)];
}

function clip(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : clip(String(value));
}

function failure(code: ToolListErrorCode, problems: ToolListProblem[]): ToolListFailure {
  return { ok: false, code, problems, message: describeToolListProblems(code, problems) };
}

/** One sentence per problem, for an API error, a tool answer or the MCP child's log. */
export function describeToolListProblems(code: ToolListErrorCode, problems: readonly ToolListProblem[]): string {
  const parts = problems.map((problem) => (problem.hint ? `${problem.item} (${problem.hint})` : problem.item));
  if (code === 'TOOLS_TOO_MANY') {
    return `A tool list holds at most ${TOOL_LIST_LIMITS.maxItems} items of at most ${TOOL_LIST_LIMITS.maxGroupItemLength} characters (${TOOL_LIST_LIMITS.maxServerItemLength} for an mcp: item): ${parts.join('; ')}`;
  }
  return `${problems.some(problem => problem.item.startsWith('mcp:')) ? 'Invalid tool selection' : 'Not SynaBun tool groups'}: ${parts.join('; ')}`;
}

/** A registry preset's groups that a list may name, or null when the registry has no preset of that name. */
function customPresetGroups(customPresets: CustomPresets | null | undefined, name: string): string[] | null {
  if (!customPresets) return null;
  for (const [key, preset] of Object.entries(customPresets)) {
    if (String(key).trim().toLowerCase() !== name) continue;
    const groups = Array.isArray(preset) ? preset : (preset && typeof preset === 'object' ? (preset as { groups?: unknown }).groups : null);
    if (!Array.isArray(groups)) return [];
    return sortGroups(groups.filter((group): group is string => typeof group === 'string').map((group) => group.trim().toLowerCase()).filter(isSelectableGroup));
  }
  return null;
}

/**
 * A profile name an older SynaBun stored (SYNABUN_PROFILE, a runtime file's `profile`, a record's `mcpProfile`,
 * active-profile.json): a preset becomes its groups (with the registry's own groups of that name), `full` and a
 * retired preset become `all`, anything else is read as a comma list. In a comma list the retired groups and the
 * gated ones are left out (the role and the grant decide those); what is left is checked like any list.
 */
function convertLegacyProfile(value: string, customPresets: CustomPresets | null | undefined): ParsedToolList {
  const name = value.trim().toLowerCase();
  const platform = LEGACY_PRESET_PLATFORMS[name] ?? null;
  if (name === 'full' || RETIRED_PRESETS.includes(name)) return { ok: true, items: ['all'], preset: name, platform: null };
  const custom = customPresetGroups(customPresets, name);
  if (Object.prototype.hasOwnProperty.call(LEGACY_PRESETS, name)) {
    return { ok: true, items: sortGroups([...LEGACY_PRESETS[name], ...(custom || [])]), preset: name, platform };
  }
  if (custom) return { ok: true, items: custom, preset: name, platform: null };
  const tokens = splitList(value);
  const kept = tokens.filter((token) => !RETIRED_GROUPS.includes(token) && !isGatedGroup(token));
  // A list that named only retired groups launched as every group before; it still does.
  if (tokens.length && !kept.length && tokens.every((token) => RETIRED_GROUPS.includes(token))) {
    return { ok: true, items: ['all'], preset: null, platform: null };
  }
  return { ok: true, items: unique(kept), preset: null, platform: null };
}

/**
 * Read a list. An array (or a comma-joined string) is read as written: preset names are refused later, with
 * suggestions. With `legacy`, a string is a stored profile value and is converted (presets, comma lists).
 * A blank string is an empty list; a caller that means "no list" checks for blank first.
 */
export function parseToolList(
  value: unknown,
  { legacy = false, customPresets = null }: { legacy?: boolean; customPresets?: CustomPresets | null } = {},
): ToolListParse {
  if (Array.isArray(value)) {
    const problems: ToolListProblem[] = [];
    const items: string[] = [];
    for (const raw of value) {
      if (typeof raw !== 'string') {
        problems.push({ item: describeValue(raw), reason: 'not-a-string', suggestions: [], hint: 'every item of a tool list is a string' });
        continue;
      }
      const item = normalizeToolItem(raw);
      if (item) items.push(item);
    }
    if (problems.length) return failure('TOOLS_INVALID', problems);
    return { ok: true, items: unique(items), preset: null, platform: null };
  }
  if (typeof value !== 'string') {
    return failure('TOOLS_INVALID', [{ item: describeValue(value), reason: 'not-a-string', suggestions: [], hint: 'a tool list is an array of group ids' }]);
  }
  if (legacy) return convertLegacyProfile(value, customPresets);
  return { ok: true, items: unique(splitList(value)), preset: null, platform: null };
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

/**
 * Group ids an unknown item probably meant, best first (at most `limit`): an id, a label or a word of a label that
 * equals it (`whatsapp`, `x`), one that contains it or that it contains (`googlesearch` → gsc, `discord_bot`),
 * then one within two edits (`whatsap`). Selectable groups only.
 */
export function suggestToolIds(item: string, limit = 3): string[] {
  const key = String(item ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!key) return [];
  const scored: Array<{ id: string; score: number; order: number }> = [];
  TOOL_GROUPS.forEach((group, order) => {
    if (group.gate) return;
    const id = group.id.replace(/_/g, '');
    const short = group.id.replace(/^browser_/, '').replace(/_/g, '');
    const label = group.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    const words = group.label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    if (key === id || key === short || key === label || words.includes(key)) score = 3;
    else if (key.length >= 3 && (label.includes(key) || id.includes(key) || (short.length >= 3 && key.includes(short)))) score = 2;
    else if (key.length >= 3 && Math.min(levenshtein(key, short), levenshtein(key, id), levenshtein(key, label)) <= 2) score = 1;
    if (score) scored.push({ id: group.id, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map((entry) => entry.id);
}

/** What a retired preset name stands for now: the groups that set it apart from the default. */
function presetProblem(item: string): ToolListProblem | null {
  if (!Object.prototype.hasOwnProperty.call(LEGACY_PRESETS, item)) return null;
  if (item === 'full' || RETIRED_PRESETS.includes(item)) {
    return { item, reason: 'unknown', suggestions: ['all'], hint: `${item} was a preset; name all` };
  }
  const groups = LEGACY_PRESETS[item];
  const browserComesWith = groups.some((id) => id !== 'browser' && isBrowserGroup(id));
  const distinct = sortGroups(groups.filter((id) => !DEFAULT_TOOLS.includes(id) && !(id === 'browser' && browserComesWith)));
  if (!distinct.length) {
    return { item, reason: 'unknown', suggestions: [...DEFAULT_TOOLS], hint: `${item} was a preset: it is the default (${DEFAULT_TOOLS.join(', ')}), so leave tools out` };
  }
  return { item, reason: 'unknown', suggestions: distinct, hint: `${item} was a preset; name ${distinct.join(', ')}` };
}

function gatedProblem(item: string, group: string): ToolListProblem {
  if (toolGroup(group)?.gate === 'grant:computer') {
    return { item, reason: 'gated', suggestions: [], hint: `${group} is never named in a list: pass uses_computer: true for a desktop grant` };
  }
  return { item, reason: 'gated', suggestions: [], hint: `${group} is the Assistant's own, never a worker's: its role decides` };
}

function unknownProblem(item: string): ToolListProblem {
  const preset = presetProblem(item);
  if (preset) return preset;
  const owner = groupOfTool(item);
  if (owner && isSelectableGroup(owner)) {
    return { item, reason: 'unknown', suggestions: [owner], hint: `${item} is a tool of the ${owner} group; name ${owner}` };
  }
  const suggestions = suggestToolIds(item);
  return { item, reason: 'unknown', suggestions, hint: suggestions.length ? `did you mean ${suggestions.join(' or ')}?` : null };
}

interface CheckedItems {
  ok: true;
  groups: string[];
  servers: string[];
  dropped: string[];
  items: string[];
}

/** Every item checked against the catalog and the limits. */
function checkItems(items: readonly string[]): CheckedItems | ToolListFailure {
  const problems: ToolListProblem[] = [];
  if (items.length > TOOL_LIST_LIMITS.maxItems) {
    problems.push({ item: `${items.length} items`, reason: 'too-many', suggestions: [], hint: `at most ${TOOL_LIST_LIMITS.maxItems}` });
  }
  const serializedBytes = new TextEncoder().encode(items.join(',')).length;
  if (serializedBytes > TOOL_LIST_LIMITS.maxSerializedBytes) problems.push({ item: `${serializedBytes} bytes`, reason: 'too-long', suggestions: [], hint: `at most ${TOOL_LIST_LIMITS.maxSerializedBytes} serialized bytes` });
  const groups = new Set<string>();
  const servers: string[] = [];
  const dropped: string[] = [];
  let all = false;
  for (const item of items) {
    const server = item.startsWith('mcp:');
    const limit = server ? TOOL_LIST_LIMITS.maxServerItemLength : TOOL_LIST_LIMITS.maxGroupItemLength;
    if (item.length > limit) {
      problems.push({ item: clip(item), reason: 'too-long', suggestions: [], hint: `at most ${limit} characters` });
      continue;
    }
    if (item === 'all') { all = true; continue; }
    if (isAlwaysOnId(item) || (ALWAYS_ON_TOOLS as readonly string[]).includes(item)) { dropped.push(item); continue; }
    if (isSelectableGroup(item)) { groups.add(item); continue; }
    if (isGatedGroup(item)) { problems.push(gatedProblem(item, item)); continue; }
    if (item === 'mcp:*') { servers.push(item); continue; }
    if (server) {
      if (/^mcp:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(item) && item !== 'mcp:SynaBun') servers.push(item);
      else problems.push({ item, reason: 'non-selectable', suggestions: [], hint: item === 'mcp:SynaBun'
        ? 'SynaBun is managed through tool groups, not an external server reference'
        : 'this name cannot be selected individually: use 1-64 letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit; mcp:* selects configured, permitted servers' });
      continue;
    }
    const owner = groupOfTool(item);
    if (owner && isGatedGroup(owner)) { problems.push(gatedProblem(item, owner)); continue; }
    problems.push(unknownProblem(item));
  }
  if (problems.length) {
    const tooMany = problems.some((problem) => problem.reason === 'too-many' || problem.reason === 'too-long');
    return failure(tooMany ? 'TOOLS_TOO_MANY' : 'TOOLS_INVALID', problems);
  }
  const sorted = sortGroups(groups);
  return {
    ok: true,
    groups: all ? [...SELECTABLE_GROUP_IDS] : sorted,
    servers: unique(servers).sort(),
    dropped,
    items: all ? ['all', ...unique(servers).sort()] : [...sorted, ...unique(servers).sort()],
  };
}

function defaultItems(context: ResolveToolListContext): readonly string[] {
  if (context.source === 'dispatch') return DEFAULT_TOOLS;
  if (context.source === 'launch' && context.stored) return context.stored;
  return context.defaultTools ?? ['all'];
}

/** strict for a provider that loads its list exactly, focus for one that reaches every SynaBun tool anyway. */
export function toolListEffect(provider: string | null | undefined): ToolListEffect {
  return (provider && HOST_EFFECT[provider]) || 'strict';
}

/**
 * The groups a run gets (§3.3). No list means the default of its source: core for a dispatch, the record's own
 * list or the owner's Default tools for a launch, the owner's Default tools for a runtime (else `all`). `all` is
 * every selectable group, always-on ids are dropped, unknown and gated ids are refused. A browser group, or
 * usesBrowser, adds `browser`; a design run adds browser (unless usesBrowser is false), styleguide and image.
 */
export function resolveToolList(requested: readonly string[] | string | null | undefined, context: ResolveToolListContext): ToolListResult {
  let asked: string[] | null = null;
  if (requested !== undefined && requested !== null) {
    const parsed = parseToolList(requested);
    if (!parsed.ok) return parsed;
    asked = parsed.items;
  }
  let base = asked;
  if (!base) {
    const fallback = parseToolList([...defaultItems(context)]);
    if (!fallback.ok) return fallback;
    base = fallback.items;
  }
  const checked = checkItems(base);
  if (!checked.ok) return checked;

  const groups = new Set(checked.groups);
  const added: AddedGroup[] = [];
  const add = (id: string, why: AddedReason) => {
    if (groups.has(id)) return;
    groups.add(id);
    added.push({ id, why });
  };
  if ([...groups].some((id) => id !== 'browser' && isBrowserGroup(id))) add('browser', 'browser-group');
  if (context.usesBrowser === true) add('browser', 'uses-browser');
  const design = context.taskClass === 'design';
  if (design && context.usesBrowser !== false) add('browser', 'design');
  if (design) {
    add('styleguide', 'design');
    add('image', 'design');
  }
  const resolved = sortGroups(groups);
  return {
    ok: true,
    requested: asked,
    items: checked.items,
    groups: resolved,
    servers: checked.servers,
    added,
    dropped: checked.dropped,
    effect: toolListEffect(context.provider),
    count: countTools(resolved, { browserV2: context.browserV2 }),
  };
}

/** A list joined for an environment variable or a header (SYNABUN_TOOLS, X-Synabun-Tools): at most 2048 bytes. */
export function serializeToolList(items: readonly string[]): string {
  const value = unique(items.map(normalizeToolItem).filter(Boolean)).join(',');
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > TOOL_LIST_LIMITS.maxSerializedBytes) {
    throw new RangeError(`A tool list joined for an environment variable or a header is at most ${TOOL_LIST_LIMITS.maxSerializedBytes} bytes; this one is ${bytes}.`);
  }
  return value;
}
