/**
 * Canonical SynaBun configuration management for Codex.
 *
 * Codex accepts `mcp_servers.<id>.env` as a TOML map. Its CLI currently emits
 * that map as a child table (`[mcp_servers.SynaBun.env]`). Older SynaBun
 * writers also emitted an inline `env = { ... }` value in the parent table.
 * Having both forms defines the same TOML key twice, so Codex rejects the
 * configuration and starts with defaults.
 *
 * This module edits the SynaBun MCP tables and the known ignored feature keys
 * emitted by its old Settings writer. All unrelated configuration is left
 * byte-for-byte intact. Repairs keep a backup; file writes are atomic,
 * preserve the original mode, and are idempotent.
 *
 * The managed keys: SYNABUN_TOOLS = "all" (every SynaBun tool; a Codex
 * runtime's own list is only its focus) and SYNABUN_TOOL_CATALOG_MODE =
 * "deferred". SYNABUN_PROFILE, the key a tool list replaced, is never written.
 * Its old managed value "full" is left where it is: a Neural Interface from
 * before tool lists (until it restarts, or another install sharing this file)
 * repairs any config without it, and the MCP child reads SYNABUN_TOOLS first,
 * so the line is inert and the two never undo each other's repair. Any other
 * SYNABUN_PROFILE value is removed.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';

const BASE_SECTION = 'mcp_servers.SynaBun';
const ENV_SECTION = `${BASE_SECTION}.env`;
const TOOL_SECTION_PREFIX = `${BASE_SECTION}.tools.`;
const SECTION_HEADER_RE = /^\[([^\]]+)\]\s*$/m;
const INLINE_ENV_LINE_RE = /^env\s*=\s*\{([^}]*)\}\s*\r?\n?/m;
const MANAGED_TOOLS_KEY = 'SYNABUN_TOOLS';
const CODEX_TOOLS = 'all';
const LEGACY_PROFILE_KEY = 'SYNABUN_PROFILE';
/** The value a Neural Interface from before tool lists writes and repairs: left alone (see the header). */
const LEGACY_CODEX_PROFILE = 'full';
const TOOL_CATALOG_MODE_KEY = 'SYNABUN_TOOL_CATALOG_MODE';
const CODEX_TOOL_CATALOG_MODE = 'deferred';

export type CodexConfigIssue =
  | 'duplicate_env'
  | 'legacy_inline_env'
  | 'managed_tools_override'
  | 'legacy_profile_key'
  | 'missing_deferred_catalog'
  | 'missing_transport'
  | 'orphan_env'
  | 'orphan_tools';

export interface CodexConfigInspection {
  exists: boolean;
  connected: boolean;
  valid: boolean;
  repairable: boolean;
  issues: CodexConfigIssue[];
}

export interface CodexMcpDefinition {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type HealReason =
  | 'removed_ignored_settings'
  | 'removed_duplicate_inline_env'
  | 'normalized_inline_env'
  | 'migrated_profile_key'
  | 'set_all_tools'
  | 'removed_legacy_profile_key'
  | 'enabled_deferred_catalog'
  | 'removed_orphan_sections';

export type HealResult =
  | { healed: false; reason: 'not_found' }
  | { healed: false; reason: 'no_synabun_section' }
  | { healed: false; reason: 'no_duplicate'; inspection: CodexConfigInspection }
  | { healed: false; reason: 'read_error'; error: string }
  | { healed: false; reason: 'write_error'; error: string }
  | { healed: true; reason: HealReason; inspection: CodexConfigInspection };

interface SectionRange {
  start: number;
  headerEnd: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionHeaderRe(section: string): RegExp {
  return new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, 'm');
}

function findSectionRange(content: string, section: string): SectionRange | null {
  const match = sectionHeaderRe(section).exec(content);
  if (!match) return null;
  const start = match.index;
  const headerEnd = start + match[0].length;
  const tail = content.slice(headerEnd);
  const next = SECTION_HEADER_RE.exec(tail);
  return { start, headerEnd, end: next ? headerEnd + next.index : content.length };
}

function hasSection(content: string, section: string): boolean {
  return sectionHeaderRe(section).test(content);
}

function listSections(content: string, prefix: string): string[] {
  const result: string[] = [];
  const re = /^\[([^\]]+)\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match[1].startsWith(prefix)) result.push(match[1]);
  }
  return result;
}

function stripSection(content: string, section: string): string {
  const range = findSectionRange(content, section);
  if (!range) return content;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const before = content.slice(0, range.start).replace(/[ \t]*\r?\n+$/, '');
  const after = content.slice(range.end).replace(/^\r?\n+/, '');
  if (!before) return after;
  if (!after) return `${before}${newline}`;
  return `${before}${newline}${newline}${after}`;
}

function stripSections(content: string, sections: string[]): string {
  let next = content;
  for (const section of sections) next = stripSection(next, section);
  return next;
}

function sectionBody(content: string, section: string): string {
  const range = findSectionRange(content, section);
  if (!range) return '';
  return content.slice(range.headerEnd, range.end);
}

function replaceSectionBody(content: string, section: string, body: string): string {
  const range = findSectionRange(content, section);
  if (!range) return content;
  const normalized = body.startsWith('\n') || body.startsWith('\r\n') ? body : `\n${body}`;
  return content.slice(0, range.headerEnd) + normalized + content.slice(range.end);
}

function parseTomlString(raw: string): string | null {
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  try {
    const value = JSON.parse(raw);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function parseInlineEnv(body: string): Record<string, string> {
  const env: Record<string, string> = {};
  const pairRe = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')/g;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(body)) !== null) {
    const value = parseTomlString(match[2]);
    if (value !== null) env[match[1]] = value;
  }
  return env;
}

function parseEnvTable(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const body = sectionBody(content, ENV_SECTION);
  const pairRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(body)) !== null) {
    const value = parseTomlString(match[2]);
    if (value !== null) env[match[1]] = value;
  }
  return env;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function upsertTomlKey(body: string, key: string, serializedValue: string): string {
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, 'm');
  if (keyRe.test(body)) return body.replace(keyRe, `${key} = ${serializedValue}`);
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  // The new key goes first; the rest of the body keeps its own lines, the blank one before the next table included.
  const rest = body.replace(/^\r?\n/, '');
  return `${newline}${key} = ${serializedValue}${newline}${rest}`;
}

function removeTomlKey(body: string, key: string): string {
  const keyRe = new RegExp(`^${escapeRegExp(key)}\\s*=.*(?:\\r?\\n|$)`, 'gm');
  return body.replace(keyRe, '');
}

function renderEnvSection(env: Record<string, string>, newline: string): string {
  const lines = Object.entries(env).map(([key, value]) => `${key} = ${quote(value)}`);
  return `[${ENV_SECTION}]${newline}${lines.join(newline)}${newline}`;
}

function upsertEnvSection(content: string, env: Record<string, string>, { remove = [] }: { remove?: readonly string[] } = {}): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const sanitized = { ...env };
  for (const key of remove) delete sanitized[key];
  sanitized[MANAGED_TOOLS_KEY] = CODEX_TOOLS;
  sanitized[TOOL_CATALOG_MODE_KEY] = CODEX_TOOL_CATALOG_MODE;

  if (!hasSection(content, ENV_SECTION)) {
    const block = renderEnvSection(sanitized, newline);
    return `${content.trimEnd()}${content.trim() ? `${newline}${newline}` : ''}${block}`;
  }

  let body = sectionBody(content, ENV_SECTION);
  for (const key of remove) body = removeTomlKey(body, key);
  for (const [key, value] of Object.entries(sanitized)) {
    body = upsertTomlKey(body, key, quote(value));
  }
  return replaceSectionBody(content, ENV_SECTION, body);
}

function hasKey(env: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

function baseInlineEnv(content: string): Record<string, string> {
  const body = sectionBody(content, BASE_SECTION);
  const match = INLINE_ENV_LINE_RE.exec(body);
  return match ? parseInlineEnv(match[1]) : {};
}

function stripInlineEnv(content: string): string {
  const body = sectionBody(content, BASE_SECTION);
  if (!INLINE_ENV_LINE_RE.test(body)) return content;
  return replaceSectionBody(content, BASE_SECTION, body.replace(INLINE_ENV_LINE_RE, ''));
}

function hasTransport(content: string): boolean {
  const body = sectionBody(content, BASE_SECTION);
  return /^\s*(command|url)\s*=/m.test(body);
}

export function inspectCodexConfigContent(content: string): CodexConfigInspection {
  const hasBase = hasSection(content, BASE_SECTION);
  const hasEnv = hasSection(content, ENV_SECTION);
  const hasTools = listSections(content, TOOL_SECTION_PREFIX).length > 0;
  const inlineEnv = hasBase && INLINE_ENV_LINE_RE.test(sectionBody(content, BASE_SECTION));
  const tableEnv = parseEnvTable(content);
  const inlineValues = baseInlineEnv(content);
  const issues: CodexConfigIssue[] = [];

  if (inlineEnv && hasEnv) issues.push('duplicate_env');
  else if (inlineEnv) issues.push('legacy_inline_env');
  if (hasBase && hasTransport(content)) {
    const tools = tableEnv[MANAGED_TOOLS_KEY] || inlineValues[MANAGED_TOOLS_KEY];
    const hasProfile = hasKey(tableEnv, LEGACY_PROFILE_KEY) || hasKey(inlineValues, LEGACY_PROFILE_KEY);
    const profile = tableEnv[LEGACY_PROFILE_KEY] ?? inlineValues[LEGACY_PROFILE_KEY];
    // A config from before tool lists names only SYNABUN_PROFILE: migrating it is one issue, not two.
    if (tools !== CODEX_TOOLS) issues.push(!tools && hasProfile ? 'legacy_profile_key' : 'managed_tools_override');
    if (hasProfile && profile !== LEGACY_CODEX_PROFILE && !issues.includes('legacy_profile_key')) issues.push('legacy_profile_key');
    if ((tableEnv[TOOL_CATALOG_MODE_KEY] || inlineValues[TOOL_CATALOG_MODE_KEY]) !== CODEX_TOOL_CATALOG_MODE) {
      issues.push('missing_deferred_catalog');
    }
  }
  if (hasBase && !hasTransport(content)) issues.push('missing_transport');
  if (!hasBase && hasEnv) issues.push('orphan_env');
  if (!hasBase && hasTools) issues.push('orphan_tools');

  const blocking = issues.some((issue) => (
    issue === 'duplicate_env'
    || issue === 'missing_transport'
    || issue === 'orphan_env'
    || issue === 'orphan_tools'
  ));
  return {
    exists: content.length > 0,
    connected: hasBase,
    valid: hasBase && !blocking,
    repairable: issues.length > 0 && !issues.includes('missing_transport'),
    issues,
  };
}

export function repairCodexConfigContent(content: string): { content: string; reason: HealReason | null } {
  const inspection = inspectCodexConfigContent(content);
  let next = content;

  if (!inspection.connected) {
    const orphans = [
      ...(hasSection(next, ENV_SECTION) ? [ENV_SECTION] : []),
      ...listSections(next, TOOL_SECTION_PREFIX),
    ];
    if (!orphans.length) return { content, reason: null };
    return { content: stripSections(next, orphans), reason: 'removed_orphan_sections' };
  }

  const inlineEnv = baseInlineEnv(next);
  const tableEnv = parseEnvTable(next);
  const hadInline = INLINE_ENV_LINE_RE.test(sectionBody(next, BASE_SECTION));
  const hadTable = hasSection(next, ENV_SECTION);
  const configuredTools = tableEnv[MANAGED_TOOLS_KEY] || inlineEnv[MANAGED_TOOLS_KEY];
  const hadAllTools = configuredTools === CODEX_TOOLS;
  const hasProfile = hasKey(tableEnv, LEGACY_PROFILE_KEY) || hasKey(inlineEnv, LEGACY_PROFILE_KEY);
  // "full" stays: an older Neural Interface writes it back into a config without it (through an account's link to
  // this file, its write replaces the link), and next to SYNABUN_TOOLS it decides nothing.
  const keepProfile = (tableEnv[LEGACY_PROFILE_KEY] ?? inlineEnv[LEGACY_PROFILE_KEY]) === LEGACY_CODEX_PROFILE;
  const hadDeferredCatalog = (tableEnv[TOOL_CATALOG_MODE_KEY] || inlineEnv[TOOL_CATALOG_MODE_KEY]) === CODEX_TOOL_CATALOG_MODE;
  const mergedEnv = { ...inlineEnv, ...tableEnv };
  const remove = hasProfile && !keepProfile ? [LEGACY_PROFILE_KEY] : [];

  if (hadInline) next = stripInlineEnv(next);
  next = upsertEnvSection(next, mergedEnv, { remove });

  if (next === content) return { content, reason: null };
  if (hadInline && hadTable) return { content: next, reason: 'removed_duplicate_inline_env' };
  if (hadInline) return { content: next, reason: 'normalized_inline_env' };
  if (!configuredTools && hasProfile) return { content: next, reason: 'migrated_profile_key' };
  if (!hadAllTools) return { content: next, reason: 'set_all_tools' };
  if (remove.length) return { content: next, reason: 'removed_legacy_profile_key' };
  if (!hadDeferredCatalog) return { content: next, reason: 'enabled_deferred_catalog' };
  return { content: next, reason: null };
}

/**
 * Register SynaBun with this definition. SYNABUN_PROFILE is never written from a definition; one already there is
 * kept only as "full", like the heal keeps it.
 */
export function upsertCodexMcpContent(content: string, definition: CodexMcpDefinition): string {
  let next = repairCodexConfigContent(content).content;
  const newline = next.includes('\r\n') ? '\r\n' : '\n';

  if (!hasSection(next, BASE_SECTION)) {
    const block = `[${BASE_SECTION}]${newline}command = ${quote(definition.command)}${newline}args = [${definition.args.map(quote).join(', ')}]${newline}`;
    next = `${next.trimEnd()}${next.trim() ? `${newline}${newline}` : ''}${block}`;
  } else {
    let body = sectionBody(next, BASE_SECTION);
    body = removeTomlKey(body, 'env');
    body = upsertTomlKey(body, 'command', quote(definition.command));
    body = upsertTomlKey(body, 'args', `[${definition.args.map(quote).join(', ')}]`);
    next = replaceSectionBody(next, BASE_SECTION, body);
  }

  const existingEnv = parseEnvTable(next);
  const env: Record<string, string> = { ...existingEnv, ...definition.env };
  delete env[LEGACY_PROFILE_KEY];
  const remove = hasKey(existingEnv, LEGACY_PROFILE_KEY) && existingEnv[LEGACY_PROFILE_KEY] !== LEGACY_CODEX_PROFILE ? [LEGACY_PROFILE_KEY] : [];
  next = upsertEnvSection(next, env, { remove });
  return next.endsWith(newline) ? next : `${next}${newline}`;
}

export function removeCodexMcpContent(content: string): string {
  return stripSections(content, [
    BASE_SECTION,
    ENV_SECTION,
    ...listSections(content, TOOL_SECTION_PREFIX),
  ]);
}

/**
 * The file a path writes to. A Codex account's CODEX_HOME links config.toml to the canonical one: a write goes to
 * the file the link names, so the link (and the sharing it gives every account) stays.
 */
function writeTarget(configPath: string): string {
  try {
    if (lstatSync(configPath).isSymbolicLink()) return realpathSync(configPath);
  } catch { /* a new file, or a link to nothing: written in place */ }
  return configPath;
}

function atomicWrite(configPath: string, content: string): void {
  const target = writeTarget(configPath);
  const mode = existsSync(target) ? statSync(target).mode : null;
  const tmpPath = `${target}.synabun-${process.pid}.tmp`;
  writeFileSync(tmpPath, content, 'utf-8');
  if (mode !== null) chmodSync(tmpPath, mode);
  try {
    renameSync(tmpPath, target);
  } catch (renameErr) {
    try { copyFileSync(tmpPath, target); } catch { /* preserve original when possible */ }
    if (existsSync(target) && readFileSync(target, 'utf-8') === content) {
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
      return;
    }
    throw renameErr;
  }
}

export function inspectCodexConfig(configPath: string): CodexConfigInspection {
  if (!configPath || !existsSync(configPath)) {
    return { exists: false, connected: false, valid: false, repairable: false, issues: [] };
  }
  return inspectCodexConfigContent(readFileSync(configPath, 'utf-8'));
}

export function healCodexConfig(configPath: string): HealResult {
  if (!configPath || !existsSync(configPath)) return { healed: false, reason: 'not_found' };

  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return { healed: false, reason: 'read_error', error: err instanceof Error ? err.message : String(err) };
  }

  const before = inspectCodexConfigContent(content);
  const cleaned = removeIgnoredCodexSettings(content);
  if (cleaned === content && !before.connected && !before.issues.length) {
    return { healed: false, reason: 'no_synabun_section' };
  }
  const repaired = repairCodexConfigContent(cleaned);
  if (cleaned !== content) repaired.reason = 'removed_ignored_settings';
  if (!repaired.reason || repaired.content === content) {
    return { healed: false, reason: 'no_duplicate', inspection: before };
  }

  try {
    // Keep the exact original, including unrelated tables and its permissions, next to the file it came from.
    const backup = `${writeTarget(configPath)}.synabun-backup-${Date.now()}-${process.pid}`;
    copyFileSync(configPath, backup);
    atomicWrite(configPath, repaired.content);
  } catch (err) {
    return { healed: false, reason: 'write_error', error: err instanceof Error ? err.message : String(err) };
  }
  return {
    healed: true,
    reason: repaired.reason,
    inspection: inspectCodexConfigContent(repaired.content),
  };
}

/** Narrow repair for keys emitted by the old Settings writer. These literal
 * dotted keys are ignored by Codex; personality's feature flag is removed.
 * Do not sweep arbitrary user flags or normalize unrelated TOML. */
export function removeIgnoredCodexSettings(content: string): string {
  let section = '';
  let multiline: string | null = null;
  return content.split(/(?<=\n)/).filter(line => {
    // Avoid treating text inside TOML multiline strings as configuration.
    const delimiters = line.match(/"""|'''/g) || [];
    if (multiline) {
      if (delimiters.filter(d => d === multiline).length % 2) multiline = null;
      return true;
    }
    for (const delimiter of delimiters) if (delimiters.filter(d => d === delimiter).length % 2) multiline = delimiter;
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line.trim());
    if (header) section = header[1].replace(/["']/g, '').trim();
    else if (/^\s*\[/.test(line)) section = '__other_table__';
    if (!section && /^\s*["']features\.(?:personality|fast_mode|apps|unified_exec)["']\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(line.trim())) return false;
    if ((!section && /^\s*features\.personality\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(line.trim()))
      || (section === 'features' && /^\s*(?:personality|"personality"|'personality')\s*=\s*(?:true|false)\s*(?:#.*)?$/.test(line.trim()))) return false;
    return true;
  }).join('');
}

export function upsertCodexMcpConfig(configPath: string, definition: CodexMcpDefinition): CodexConfigInspection {
  let content = '';
  if (existsSync(configPath)) content = readFileSync(configPath, 'utf-8');
  const next = upsertCodexMcpContent(content, definition);
  if (next !== content) atomicWrite(configPath, next);
  return inspectCodexConfigContent(next);
}

export function removeCodexMcpConfig(configPath: string): CodexConfigInspection {
  if (!existsSync(configPath)) {
    return { exists: false, connected: false, valid: false, repairable: false, issues: [] };
  }
  const content = readFileSync(configPath, 'utf-8');
  const next = removeCodexMcpContent(content);
  if (next !== content) atomicWrite(configPath, next);
  return inspectCodexConfigContent(next);
}
